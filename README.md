# Ministry Map

A self-assessment tool for youth leaders: map every student along the five challenges of Jesus
(Come & See → Repent & Believe → Follow Me → Fish for People → I Am Sending You), check in each
season, watch movement over time, and get coaching questions drawn from the group's own data.

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
   - `SESSION_SECRET` = any long random string — signs session & invite tokens
     (optional; falls back to `AIRTABLE_TOKEN`, but changing either signs everyone out)
4. Redeploy. Visit the site: onboarding maps the group, then asks the leader to
   **create an account** (email + password); the map is saved to that account and
   reachable from any device by signing in.

Without the token configured, the app still runs fully in local (in-memory) mode.

## Accounts (Leaders table)

- Leaders sign up with email + password. Passwords are stored in the **Leaders** table as
  salted PBKDF2 hashes (100k iterations, SHA-256) — never in plain text.
- Sessions are stateless HMAC-signed tokens (30 days), kept in the browser's localStorage.
- **Co-leader invites**: from the home page, "Invite a co-leader" produces a signed link
  (`?invite=…`, valid 14 days). The co-leader opens it, creates an account (or signs in),
  and the group is added to their account too. A leader can belong to several groups.
- **Migrating from group codes**: leaders who used the old code system enter their old
  code once on the signup form and their existing group moves onto the new account.

## API (all under `/api/*`)

Authenticated routes take an `Authorization: Bearer <token>` header.

- `GET /api/health` — `{ ok, configured }`
- `POST /api/auth/signup` — `{ name, email, password, language?, invite?, groupCode? }` → `{ token, leader, groups }`
- `POST /api/auth/signin` — `{ email, password }` → `{ token, leader, groups }`
- `GET /api/auth/me` — `{ leader, groups }`
- `POST /api/invite` — `{ group }` → `{ token }` (signed co-leader invite, 14 days)
- `GET /api/invite?token=X` — `{ group, by }` (peek before accepting; no auth)
- `POST /api/invite/accept` — `{ token }` → joins the group
- `GET /api/state?group=X` — full group state (snapshots, notes, events, programs, team)
- `POST /api/bootstrap` — `{ group, students: {name: position}, note }` → `{ group, groups }`
- `POST /api/checkin` — `{ group, students, note }`
- `POST /api/event` — `{ group, name, date }`
- `GET /api/aggregate` — anonymous movement-wide aggregates (public)
