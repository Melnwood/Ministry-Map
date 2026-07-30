import type { Context, Config } from "@netlify/functions";

// ── Airtable proxy for Ministry Map ──────────────────────────────
// Env vars (set in Netlify UI → Site configuration → Environment variables):
//   AIRTABLE_TOKEN — a personal access token with data.records:read/write on the base
//   AIRTABLE_BASE  — the base id (defaults to the "Ministry Map" base)
//   SESSION_SECRET — signs session & invite tokens (falls back to AIRTABLE_TOKEN)

const BASE = () => Netlify.env.get("AIRTABLE_BASE") || "apphewwdjgUpUMtME";
const TOKEN = () => Netlify.env.get("AIRTABLE_TOKEN") || "";
const SECRET = () => Netlify.env.get("SESSION_SECRET") || TOKEN();
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
      body: JSON.stringify({ records: records.slice(i, i + 10) }),
    });
    out.push(...page.records);
  }
  return out;
}

const linkedTo = (rec: any, field: string, id: string) =>
  Array.isArray(rec.fields[field]) && rec.fields[field].includes(id);

const today = () => new Date().toISOString().slice(0, 10);

// ── crypto: PBKDF2 password hashes + HMAC-signed tokens ──────────
const enc = new TextEncoder();
const PBKDF2_ITER = 100_000;

function b64u(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ""; bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64uDecode(s: string) {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
}
function timingSafeEq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
}
async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64u(salt)}$${b64u(bits)}`;
}
async function verifyPassword(password: string, stored: string) {
  const [scheme, iter, salt, hash] = (stored || "").split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const bits = await pbkdf2(password, b64uDecode(salt), +iter);
  return timingSafeEq(b64u(bits), hash);
}

async function hmacKey() {
  return crypto.subtle.importKey("raw", enc.encode("mm-tokens:" + SECRET()),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function signToken(payload: any) {
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  return `${body}.${sig}`;
}
async function readToken(token: string) {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expect = b64u(await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body)));
  if (!timingSafeEq(sig, expect)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64uDecode(body)));
    if (!payload.exp || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}
const sessionFor = (leaderId: string) =>
  signToken({ typ: "session", lid: leaderId, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 });

// ── Leaders table helpers ────────────────────────────────────────
async function findLeaderByEmail(email: string) {
  const f = `LOWER({Email})='${email.toLowerCase().replace(/'/g, "\\'")}'`;
  const res: any = await at(`Leaders?filterByFormula=${encodeURIComponent(f)}`);
  return res.records[0] || null;
}
async function requireLeader(req: Request) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  const p = m ? await readToken(m[1]) : null;
  if (!p || p.typ !== "session") return null;
  try { return await at(`Leaders/${encodeURIComponent(p.lid)}`); } catch { return null; }
}
const publicLeader = (l: any) => ({
  id: l.id, email: l.fields["Email"] || "", name: l.fields["Name"] || "",
  role: l.fields["Role"] || "Leader", language: l.fields["Language"] || "",
});
const groupIdsOf = (l: any): string[] => l.fields["Groups"] || [];
async function groupsOf(l: any) {
  const gs = await Promise.all(groupIdsOf(l).map(id =>
    at(`Groups/${encodeURIComponent(id)}`).catch(() => null)));
  return gs.filter(Boolean).map((g: any) => ({ id: g.id, name: g.fields["Group Name"] || "" }));
}
async function addLeaderToGroup(leader: any, gid: string) {
  const ids = groupIdsOf(leader);
  if (ids.includes(gid)) return leader;
  return at(`Leaders/${encodeURIComponent(leader.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ fields: { Groups: [...ids, gid] } }),
  });
}

// legacy: groups created before accounts existed are claimed by their old code
async function findGroupByCode(code: string) {
  const f = `{Group Code}='${code.replace(/'/g, "\\'")}'`;
  const res: any = await at(`Groups?filterByFormula=${encodeURIComponent(f)}`);
  return res.records[0] || null;
}

const json = (data: any, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api/, "") || "/";
  try {
    if (route === "/health") return json({ ok: true, configured: !!TOKEN() });
    if (!TOKEN()) return json({ error: "AIRTABLE_TOKEN not configured" }, 503);

    // ── POST /api/auth/signup ─ { name, email, password, language?, invite?, groupCode? } ──
    if (route === "/auth/signup" && req.method === "POST") {
      const body: any = await req.json();
      const email = (body.email || "").trim().toLowerCase();
      const password = body.password || "";
      const name = (body.name || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Enter a valid email address." }, 400);
      if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
      if (!name) return json({ error: "Enter your name." }, 400);
      if (await findLeaderByEmail(email))
        return json({ error: "An account with this email already exists — sign in instead." }, 409);

      const groupIds: string[] = [];
      if (body.invite) {
        const inv = await readToken(body.invite);
        if (!inv || inv.typ !== "invite") return json({ error: "This invite link has expired — ask your leader for a new one." }, 400);
        groupIds.push(inv.gid);
      }
      if (body.groupCode) {
        const g = await findGroupByCode(String(body.groupCode).trim());
        if (!g) return json({ error: "No group found for that code." }, 404);
        if (!groupIds.includes(g.id)) groupIds.push(g.id);
      }

      const fields: any = {
        "Email": email, "Name": name,
        "Password Hash": await hashPassword(password),
        "Role": "Leader", "Created": today(),
      };
      if (body.language) fields["Language"] = body.language;
      if (groupIds.length) fields["Groups"] = groupIds;
      const [leader] = await createRecords("Leaders", [{ fields }]);
      return json({ token: await sessionFor(leader.id), leader: publicLeader(leader), groups: await groupsOf(leader) });
    }

    // ── POST /api/auth/signin ─ { email, password } ──
    if (route === "/auth/signin" && req.method === "POST") {
      const body: any = await req.json();
      const leader = await findLeaderByEmail((body.email || "").trim());
      const ok = leader && await verifyPassword(body.password || "", leader.fields["Password Hash"] || "");
      if (!ok) return json({ error: "Wrong email or password." }, 401);
      return json({ token: await sessionFor(leader.id), leader: publicLeader(leader), groups: await groupsOf(leader) });
    }

    // ── GET /api/auth/me ─ current leader + their groups ──
    if (route === "/auth/me" && req.method === "GET") {
      const leader = await requireLeader(req);
      if (!leader) return json({ error: "Not signed in." }, 401);
      return json({ leader: publicLeader(leader), groups: await groupsOf(leader) });
    }

    // ── GET /api/invite?token=X ─ peek at an invite (no auth) ──
    if (route === "/invite" && req.method === "GET") {
      const inv = await readToken(url.searchParams.get("token") || "");
      if (!inv || inv.typ !== "invite") return json({ error: "This invite link has expired — ask your leader for a new one." }, 400);
      return json({ group: inv.gname || "", by: inv.by || "" });
    }

    // ── POST /api/invite ─ { group } → signed co-leader invite token (14 days) ──
    if (route === "/invite" && req.method === "POST") {
      const leader = await requireLeader(req);
      if (!leader) return json({ error: "Not signed in." }, 401);
      const body: any = await req.json();
      const gid = body.group || "";
      if (!groupIdsOf(leader).includes(gid)) return json({ error: "That group isn't yours to invite to." }, 403);
      const g: any = await at(`Groups/${encodeURIComponent(gid)}`);
      const token = await signToken({
        typ: "invite", gid,
        gname: g.fields["Group Name"] || "", by: leader.fields["Name"] || leader.fields["Email"] || "",
        exp: Math.floor(Date.now() / 1000) + 14 * 24 * 3600,
      });
      return json({ token });
    }

    // ── POST /api/invite/accept ─ { token } — signed-in leader joins the group ──
    if (route === "/invite/accept" && req.method === "POST") {
      const leader = await requireLeader(req);
      if (!leader) return json({ error: "Not signed in." }, 401);
      const body: any = await req.json();
      const inv = await readToken(body.token || "");
      if (!inv || inv.typ !== "invite") return json({ error: "This invite link has expired — ask your leader for a new one." }, 400);
      const updated = await addLeaderToGroup(leader, inv.gid);
      return json({ ok: true, group: { id: inv.gid, name: inv.gname || "" }, groups: await groupsOf(updated) });
    }

    // everything below requires a signed-in leader
    const leader = await requireLeader(req);
    if (!leader && route !== "/aggregate") return json({ error: "Not signed in." }, 401);

    // ── GET /api/state?group=X ─ full group state ──
    if (route === "/state" && req.method === "GET") {
      const gid = url.searchParams.get("group") || groupIdsOf(leader)[0] || "";
      if (!groupIdsOf(leader).includes(gid)) return json({ error: "group not found" }, 404);
      let g: any;
      try { g = await at(`Groups/${encodeURIComponent(gid)}`); }
      catch { return json({ error: "group not found" }, 404); }

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
        group: { id: gid, name: g.fields["Group Name"] || "", leaders: g.fields["Leaders"] || "" },
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

    // ── POST /api/bootstrap ─ create group + first check-in for the signed-in leader ──
    if (route === "/bootstrap" && req.method === "POST") {
      const body: any = await req.json();
      const gFields: any = {
        "Group Name": body.group?.name || "My youth group",
        "Leaders": body.group?.leaders || "",
        "Created": today(),
      };
      if (body.language) gFields["Language"] = body.language;
      const [g] = await createRecords("Groups", [{ fields: gFields }]);
      const updated = await addLeaderToGroup(leader, g.id);
      const names = Object.keys(body.students || {});
      const created = await createRecords("Students",
        names.map(n => ({ fields: { "Name": n, "Active": true, "First Seen": today(), "Group": [g.id] } })));
      const idByName: Record<string, string> = {};
      created.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      const [ci] = await createRecords("Check-ins", [{ fields: {
        "Check-in Date": today(), "Heart Note": body.note || "", "Group": [g.id],
      }}]);
      await createRecords("Positions", names.map(n => ({ fields: {
        "Key": `${today()} · ${n}`, "Position": body.students[n],
        "Zone": zoneOf(body.students[n]), "Student": [idByName[n]], "Check-in": [ci.id],
      }})));
      return json({ group: { id: g.id, name: gFields["Group Name"] }, groups: await groupsOf(updated) });
    }

    // ── POST /api/checkin ─ { group, students, note } ──
    if (route === "/checkin" && req.method === "POST") {
      const body: any = await req.json();
      const gid = body.group || "";
      if (!groupIdsOf(leader).includes(gid)) return json({ error: "group not found" }, 404);
      const students = await allRecords("Students");
      const mine = students.filter(r => linkedTo(r, "Group", gid));
      const idByName: Record<string, string> = {};
      mine.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      const names = Object.keys(body.students || {});
      const missing = names.filter(n => !idByName[n]);
      if (missing.length) {
        const created = await createRecords("Students",
          missing.map(n => ({ fields: { "Name": n, "Active": true, "First Seen": today(), "Group": [gid] } })));
        created.forEach(r => { idByName[r.fields["Name"]] = r.id; });
      }
      const [ci] = await createRecords("Check-ins", [{ fields: {
        "Check-in Date": today(), "Heart Note": body.note || "", "Group": [gid],
      }}]);
      await createRecords("Positions", names.map(n => ({ fields: {
        "Key": `${today()} · ${n}`, "Position": body.students[n],
        "Zone": zoneOf(body.students[n]), "Student": [idByName[n]], "Check-in": [ci.id],
      }})));
      return json({ ok: true, date: today() });
    }

    // ── POST /api/event ─ { group, name, date } ──
    if (route === "/event" && req.method === "POST") {
      const body: any = await req.json();
      const gid = body.group || "";
      if (!groupIdsOf(leader).includes(gid)) return json({ error: "group not found" }, 404);
      await createRecords("Events", [{ fields: { "Event Name": body.name, "Date": body.date, "Group": [gid] } }]);
      return json({ ok: true });
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

    return json({ error: "not found" }, 404);
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
};

export const config: Config = { path: "/api/*" };
