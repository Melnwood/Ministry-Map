import type { Context, Config } from "@netlify/functions";

// ── Airtable proxy for Ministry Map ──────────────────────────────
// Env vars (set in Netlify UI → Site configuration → Environment variables):
//   AIRTABLE_TOKEN — a personal access token with data.records:read/write on the base
//   AIRTABLE_BASE  — the base id (defaults to the "Ministry Map" base)

const BASE = () => Netlify.env.get("AIRTABLE_BASE") || "apphewwdjgUpUMtME";
const TOKEN = () => Netlify.env.get("AIRTABLE_TOKEN") || "";
const AT = "https://api.airtable.com/v0";

const ZFROM = [0, 25, 50, 75, 95];
const ZNAMES = ["Come & See", "Repent & Believe", "Follow Me", "Fish for People", "Sending You"];
const zoneOf = (v: number) => { let z = 0; ZFROM.forEach((f, i) => { if (v >= f) z = i; }); return ZNAMES[z]; };

async function at(path: string, init?: RequestInit) {
  const r = await fetch(`${AT}/${BASE()}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`Airtable ${r.status}: ${await r.text()}`);
  return r.json();
}

async function allRecords(table: string): Promise<any[]> {
  let records: any[] = [], offset: string | undefined;
  do {
    const page: any = await at(`${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`);
    records = records.concat(page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

async function createRecords(table: string, records: any[]) {
  const out: any[] = [];
  for (let i = 0; i < records.length; i += 10) {
    const page: any = await at(encodeURIComponent(table), {
      method: "POST",
      // typecast lets select fields (e.g. Groups.Language) accept any of the
      // 16 JV-country language names without pre-creating every option
      body: JSON.stringify({ records: records.slice(i, i + 10), typecast: true }),
    });
    out.push(...page.records);
  }
  return out;
}

const linkedTo = (rec: any, field: string, id: string) =>
  Array.isArray(rec.fields[field]) && rec.fields[field].includes(id);

async function findGroup(code: string) {
  const res: any = await at(`Groups?filterByFormula=${encodeURIComponent(`{Group Code}='${code.replace(/'/g, "\\'")}'`)}`);
  return res.records[0] || null;
}

function newCode() {
  const words = ["RIVER", "CEDAR", "STONE", "LIGHT", "OLIVE", "TABOR", "SINAI", "KAREK", "SHILO", "HOREB"];
  const w = words[Math.floor(Math.random() * words.length)];
  return `${w}-${Math.floor(1000 + Math.random() * 9000)}`;
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api/, "") || "/";
  try {
    if (route === "/health") return json({ ok: true, configured: !!TOKEN() });
    if (!TOKEN()) return json({ error: "AIRTABLE_TOKEN not configured" }, 503);

    // ── GET /api/state?code=X ─ full group state ──
    if (route === "/state" && req.method === "GET") {
      const code = url.searchParams.get("code") || "";
      const g = await findGroup(code);
      if (!g) return json({ error: "group not found" }, 404);
      const gid = g.id;

      const [students, checkins, positions, events, programs, team] = await Promise.all([
        allRecords("Students"), allRecords("Check-ins"), allRecords("Positions"),
        allRecords("Events"), allRecords("Programs"), allRecords("Team"),
      ]);
      const myStudents = students.filter(r => linkedTo(r, "Group", gid));
      const nameById: Record<string, string> = {};
      myStudents.forEach(r => { nameById[r.id] = r.fields["Name"]; });
      const myCheckins = checkins.filter(r => linkedTo(r, "Group", gid))
        .sort((a, b) => (a.fields["Check-in Date"] || "").localeCompare(b.fields["Check-in Date"] || ""));

      const snapshots = myCheckins.map(ci => {
        const studentsMap: Record<string, number> = {};
        positions.filter(p => linkedTo(p, "Check-in", ci.id)).forEach(p => {
          const sid = (p.fields["Student"] || [])[0];
          if (sid && nameById[sid] != null) studentsMap[nameById[sid]] = p.fields["Position"] ?? 10;
        });
        const d = ci.fields["Check-in Date"];
        return {
          date: d,
          label: new Date(d + "T12:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" }),
          students: studentsMap,
        };
      }).filter(s => Object.keys(s.students).length);

      const notes = myCheckins.filter(ci => ci.fields["Heart Note"])
        .map(ci => ({ date: ci.fields["Check-in Date"], text: ci.fields["Heart Note"] }));

      const zoneIdx = (z: string) => Math.max(0, ZNAMES.indexOf(z));
      return json({
        group: { name: g.fields["Group Name"] || "", leaders: g.fields["Leaders"] || "" },
        snapshots, notes,
        events: events.filter(r => linkedTo(r, "Group", gid))
          .map(r => ({ name: r.fields["Event Name"], date: r.fields["Date"], zone: r.fields["Serves Zone"] || "" }))
          .filter(e => e.name && e.date),
        programs: programs.filter(r => linkedTo(r, "Group", gid))
          .map(r => ({ name: r.fields["Program Name"], cad: r.fields["Cadence"] || "", zone: zoneIdx(r.fields["Serves Zone"] || "") })),
        team: team.filter(r => linkedTo(r, "Group", gid))
          .map(r => ({ name: r.fields["Name"], role: r.fields["Role"] || "", photo: (r.fields["Photo"] || [])[0]?.url || "" })),
      });
    }

    // ── POST /api/bootstrap ─ create group + first check-in ──
    if (route === "/bootstrap" && req.method === "POST") {
      const body: any = await req.json();
      let code = newCode();
      while (await findGroup(code)) code = newCode();
      const today = new Date().toISOString().slice(0, 10);
      const gFields: any = {
        "Group Name": body.group?.name || "My youth group",
        "Leaders": body.group?.leaders || "",
        "Group Code": code, "Created": today,
      };
      if (body.language) gFields["Language"] = body.language;
      const [g] = await createRecords("Groups", [{ fields: gFields }]);
      const names = Object.keys(body.students || {});
      const created = await createRecords("Students",
        names.map(n => ({ fields: { "Name": n, "Active": true, "First Seen": today, "Group": [g.id] } })));
      const idByName: Record<string, string> = {};
      created.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      const [ci] = await createRecords("Check-ins", [{ fields: {
        "Check-in Date": today, "Heart Note": body.note || "", "Group": [g.id],
      }}]);
      await createRecords("Positions", names.map(n => ({ fields: {
        "Key": `${today} · ${n}`, "Position": body.students[n],
        "Zone": zoneOf(body.students[n]), "Student": [idByName[n]], "Check-in": [ci.id],
      }})));
      return json({ code });
    }

    // ── POST /api/checkin ─ save a new check-in ──
    if (route === "/checkin" && req.method === "POST") {
      const body: any = await req.json();
      const g = await findGroup(body.code || "");
      if (!g) return json({ error: "group not found" }, 404);
      const today = new Date().toISOString().slice(0, 10);
      const students = await allRecords("Students");
      const mine = students.filter(r => linkedTo(r, "Group", g.id));
      const idByName: Record<string, string> = {};
      mine.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      const names = Object.keys(body.students || {});
      const missing = names.filter(n => !idByName[n]);
      if (missing.length) {
        const created = await createRecords("Students",
          missing.map(n => ({ fields: { "Name": n, "Active": true, "First Seen": today, "Group": [g.id] } })));
        created.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      }
      const [ci] = await createRecords("Check-ins", [{ fields: {
        "Check-in Date": today, "Heart Note": body.note || "", "Group": [g.id],
      }}]);
      await createRecords("Positions", names.map(n => ({ fields: {
        "Key": `${today} · ${n}`, "Position": body.students[n],
        "Zone": zoneOf(body.students[n]), "Student": [idByName[n]], "Check-in": [ci.id],
      }})));
      return json({ ok: true, date: today });
    }

    // ── GET /api/aggregate ─ anonymous movement-wide aggregates ──
    // Names and group identities never leave this function: only counts,
    // zone distributions, and median durations are returned.
    if (route === "/aggregate" && req.method === "GET") {
      const [groups, students, checkins, positions] = await Promise.all([
        allRecords("Groups"), allRecords("Students"), allRecords("Check-ins"), allRecords("Positions"),
      ]);
      const groupById: Record<string, any> = {};
      groups.forEach(g => { groupById[g.id] = g; });
      const ciDate: Record<string, string> = {};
      checkins.forEach(c => { ciDate[c.id] = c.fields["Check-in Date"] || ""; });

      // per-student position timeline (by internal id only)
      const timelines: Record<string, { date: string; v: number }[]> = {};
      positions.forEach(p => {
        const sid = (p.fields["Student"] || [])[0];
        const cid = (p.fields["Check-in"] || [])[0];
        if (!sid || !cid || !ciDate[cid]) return;
        (timelines[sid] = timelines[sid] || []).push({ date: ciDate[cid], v: p.fields["Position"] ?? 0 });
      });
      Object.values(timelines).forEach(t => t.sort((a, b) => a.date.localeCompare(b.date)));

      // latest zone distribution per country
      const zoneIdxOf = (v: number) => { let z = 0; ZFROM.forEach((f, i) => { if (v >= f) z = i; }); return z; };
      const countryOf = (sid: string) => {
        const s = students.find(st => st.id === sid);
        const gid = (s?.fields["Group"] || [])[0];
        return groupById[gid]?.fields["Country"] || "Other";
      };
      const byCountry: Record<string, { groups: Set<string>; zones: number[] }> = {};
      groups.forEach(g => {
        const c = g.fields["Country"] || "Other";
        (byCountry[c] = byCountry[c] || { groups: new Set(), zones: [0, 0, 0, 0, 0] }).groups.add(g.id);
      });
      let studentsTotal = 0;
      for (const sid in timelines) {
        const latest = timelines[sid][timelines[sid].length - 1];
        const c = countryOf(sid);
        (byCountry[c] = byCountry[c] || { groups: new Set(), zones: [0, 0, 0, 0, 0] }).zones[zoneIdxOf(latest.v)]++;
        studentsTotal++;
      }

      // milestone transitions: first date below boundary → first date at/above it
      const months = (a: string, b: string) =>
        Math.round((new Date(b).getTime() - new Date(a).getTime()) / (30.44 * 24 * 3600 * 1000));
      const median = (arr: number[]) => {
        if (!arr.length) return null;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)];
      };
      const transitions = ZFROM.slice(1).map((boundary, i) => {
        const durations: number[] = [];
        Object.values(timelines).forEach(t => {
          const before = t.find(p => p.v < boundary);
          const after = t.find(p => p.v >= boundary && (!before || p.date > before.date));
          if (before && after && after.date > before.date) durations.push(months(before.date, after.date));
        });
        return { from: ZNAMES[i], to: ZNAMES[i + 1], medianMonths: median(durations), n: durations.length };
      });

      // movement in the last ~6 months across all groups (zone-level, anonymous)
      const cutoff = new Date(Date.now() - 183 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const movement = { forward: 0, back: 0, joined: 0, left: 0 };
      Object.values(timelines).forEach(t => {
        const recent = t.filter(p => p.date >= cutoff);
        const prior = t.filter(p => p.date < cutoff);
        if (!prior.length && recent.length) { movement.joined++; return; }
        if (prior.length && !recent.length) { movement.left++; return; }
        if (prior.length && recent.length) {
          const za = zoneIdxOf(prior[prior.length - 1].v), zb = zoneIdxOf(recent[recent.length - 1].v);
          if (zb > za) movement.forward++; else if (zb < za) movement.back++;
        }
      });

      return json({
        groups: groups.length,
        countries: Object.keys(byCountry).filter(c => byCountry[c].groups.size > 0).length,
        students: studentsTotal,
        byCountry: Object.entries(byCountry)
          .filter(([, v]) => v.groups.size > 0)
          .map(([country, v]) => ({ country, groups: v.groups.size, zones: v.zones }))
          .sort((a, b) => b.groups - a.groups),
        transitions, movement,
      });
    }

    // ── POST /api/event ──
    if (route === "/event" && req.method === "POST") {
      const body: any = await req.json();
      const g = await findGroup(body.code || "");
      if (!g) return json({ error: "group not found" }, 404);
      await createRecords("Events", [{ fields: { "Event Name": body.name, "Date": body.date, "Group": [g.id] } }]);
      return json({ ok: true });
    }

    return json({ error: "not found" }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
};

export const config: Config = { path: "/api/*" };
