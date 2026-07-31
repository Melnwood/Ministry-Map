# Ministry Map

A self-assessment tool for youth leaders: map every student along the five challenges of Jesus
(Come & See → Repent & Believe → Follow Me → Fish for People → I Am Sending You), check in each
season, watch movement over time, and get coaching questions drawn from the group's own data.

## Languages

The app ships in the language of every Josiah Venture country, plus English — 16 in all:
Albanian, Bulgarian, Croatian, Czech, English, Estonian, German, Hungarian, Latvian,
Montenegrin, Polish, Romanian (also serving Moldova), Serbian, Slovak, Slovenian, and
Ukrainian. The language is auto-detected from the browser on first visit, can be switched
from the selector on the welcome screen, and is remembered per device. Zone names, milestone
prompts, the five challenge quotes, tabs, and the whole onboarding flow are translated;
dates format per locale. (Dynamic coach/insight text stays English in this prototype — in
the full version the AI coach responds natively in the leader's language.)

## Stack

- **Frontend**: single-file `index.html` (no build step)
- **Backend**: one Netlify serverless function (`netlify/functions/api.mts`) proxying Airtable
- **Database**: Airtable base "Ministry Map" (`apphewwdjgUpUMtME`) — tables: Groups, Students,
  Check-ins, Positions, Events, Team, Programs

## Setup

1. Deploy this folder to Netlify (site: `ministry-map`).
2. In Airtable, create a **personal access token** at https://airtable.com/create/tokens with scopes
   `data.records:read` + `data.records:write`, granted access to the *Ministry Map* base.
3. In Netlify → Site configuration → Environment variables, add:
   - `AIRTABLE_TOKEN` = the token
   - `AIRTABLE_BASE` = `apphewwdjgUpUMtME` (optional; this is the default)
4. Redeploy. Visit the site: onboarding creates a group and returns a **group code**
   (e.g. `RIVER-4821`) — the leader's key back into their map from any device
   (`?code=RIVER-4821` also works as a direct link).

Without the token configured, the app still runs fully in local (in-memory) mode.

## API (all under `/api/*`)

- `GET /api/health` — `{ ok, configured }`
- `GET /api/state?code=X` — full group state (snapshots, notes, events, programs, team)
- `POST /api/bootstrap` — `{ group, students: {name: position}, note }` → `{ code }`
- `POST /api/checkin` — `{ code, students, note }`
- `POST /api/event` — `{ code, name, date }`
