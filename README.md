# Clay County ARES Net Logger — User Guide

A web-based net control logging system for ARES nets and emergency activations: multi-operator check-ins, tactical assignments, message traffic, issues tracking, a live status board, and ICS 309 export.

## Contents

1. [Quick Start](#quick-start)
2. [Roles and Permissions](#roles-and-permissions)
3. [Check-Ins](#check-ins)
4. [Tactical Positions](#tactical-positions)
5. [Message Traffic](#message-traffic)
6. [Issues](#issues)
7. [Status Board](#status-board)
8. [ICS 309 Export and Session History](#ics-309-export-and-session-history)
9. [Net Schedule](#net-schedule)
10. [Managing Users (Admin)](#managing-users-admin)
11. [QRZ Setup (Admin)](#qrz-setup-admin)
12. [Hosting and Deployment (Admin)](#hosting-and-deployment-admin)

---

## Quick Start

**First login ever:** callsign `ADMIN`, password `changeme`. Change it immediately under [Managing Users](#managing-users-admin).

**Running a net**, as Net Control or Backup NC:

1. **Setup** — enter the net name (required). Optionally add incident/activation name, activation type, NC/BNC callsigns, frequency, and mode — these appear on the ICS 309. Click **Open Net**.
2. **Check-ins** — type each station's callsign and press Enter (or click **Log check-in**). Add a tactical call, location, comments, or traffic as needed.
3. During the net — log **message traffic** and **issues** as they come up. Open the **Status Board** on a second screen for a live overview.
4. **Close Net** when finished.
5. **Export** — print or download the ICS 309 for your records.

That covers most regular use — details on each step are below.

---

## Roles and Permissions

| | Net Control | Backup NC | Observer |
|---|:---:|:---:|:---:|
| View log, status board, exports | ✓ | ✓ | ✓ |
| Add / remove check-ins, traffic, issues | ✓ | ✓ | — |
| Open / close net | ✓ | — | — |
| Manage users & account requests\* | ✓ | — | — |

\* Also available to anyone with the **Admin** flag checked, regardless of role — see [Managing Users](#managing-users-admin).

Every member can additionally hold one or more **approved positions**: *Net Control, Backup Net Control, Traffic Rep, Net Logger*. These are set by an admin and control which slots a member may sign up for on the [Net Schedule](#net-schedule), and appear as quick-assign badges when that member checks in.

---

## Check-Ins

Go to **Check-ins** once the net is open.

| Field | Notes |
|---|---|
| Callsign | If QRZ is connected, name/license class auto-fill after a short pause. |
| Tactical call / position | Type one, pick from the dropdown, or click a badge (see below). |
| Location / site | Free text, e.g. "Clay County EOC". |
| Time in | Defaults to now — edit for delayed check-ins. |
| Comments / announcements | Check the box, enter a count and note. |
| Message traffic | Check the box, then see [Message Traffic](#message-traffic). |

**Approved position badges:** if the callsign matches a registered member with approved positions, badges appear under the callsign field. Click one to instantly set it as that station's tactical call.

Click the trash icon on any row to remove a check-in (Net Control / Backup NC only).

---

## Tactical Positions

Tactical calls (e.g. `EOC-1`, `Shelter-Alpha`) identify a station by function rather than callsign. Assign one at check-in, or maintain a standing list at **Admin → Positions** so it appears in the dropdown for everyone. Tactical assignments appear on the live check-in list, the log table, the Status Board, and the ICS 309 form.

---

## Message Traffic

Check **Has message traffic** at check-in and click **Add message** for each item: precedence, message #, type, description, from/deliver-to, and times sent/received. Mark a message **Passed** from the check-in row or the Status Board.

| Precedence | Color | Meaning |
|---|---|---|
| Emergency | Red | Life-safety — pass immediately |
| Priority | Blue | Urgent — before Welfare/Routine |
| Welfare | Amber | Health & welfare inquiries |
| Routine | Green | Non-urgent |

---

## Issues

The **Issues** page logs open problems or outstanding action items with a priority: Low, Normal, High, or Critical. Click **Resolve** when done; Net Control can delete an issue outright. An amber sidebar badge and the Status Board both track the open count.

---

## Status Board

A full-screen, auto-refreshing (every 5s) dashboard meant for a second monitor or projector — open it from **Check-ins → Open Status Board**. It shows check-in totals, pending announcements/traffic/issues, tactical assignments, and who's currently logged in. Click **Given** or **Passed** to clear items directly from the board.

---

## ICS 309 Export and Session History

From the **Export** page:

- **View / Print ICS 309** — the standard ARRL/FEMA comms log form (print in landscape). Includes header info, the full communications log, issues, and a signature block.
- **Download CSV** — the same data in a structured file for filing or import.
- **Session history** — every past activation, each exportable the same way. For multi-day activations, close the net at 23:59 and reopen for the next day so each operational period gets its own ICS 309.

---

## Net Schedule

The **Schedule** page lists upcoming nets (weekly, auto-skipped on US federal holidays) with four positions: **Net Control, Backup Net Control, Traffic Rep, Net Logger**. You can only sign up for a position you're approved for — see [Roles and Permissions](#roles-and-permissions). Net Control can fill or override any slot. Cancel your own signup any time; if email is configured, you'll get reminders 24 hours and 1 hour before the net.

---

## Managing Users (Admin)

**Admin → Users** is available to the Net Control role, and to anyone with the **Admin** flag checked (see below).

- **Add a user** — callsign, name, email, password, and role.
- **Role** — cycles Net Control / Backup NC / Observer. Controls net-day permissions (open/close net, edit check-ins).
- **Positions** — check which of the four schedule positions this member is approved for.
- **Admin flag** — a separate switch from role. It grants access to this Users page and to account-request approvals, and marks the member as a recipient of schedule/account-request emails. It does **not** grant any net-day (open/close net, edit check-ins) permissions — those come from Role.
- **Reset pw** / **Delete** — as needed.
- **Pending requests** — operators can request an account from the login screen; a badge shows the pending count. Approve (choose a role) or deny from here.

---

## QRZ Setup (Admin)

On the **Setup** page, enter your QRZ XML username and password (a separate subscription from a free QRZ account) and click **Connect**. Once connected, name, license class, and coordinates auto-fill at check-in. The session key lives only in your browser for that session — reconnect after logging back in. QRZ is optional; you can always enter details manually.

---

## Hosting and Deployment (Admin)

**Tech stack:** Node.js + Express, SQLite (`better-sqlite3`), vanilla HTML/CSS/JS, Leaflet for the map view, hosted on Railway.

**Deploy to Railway:**

1. Push this repo to GitHub.
2. Railway → **New Project → Deploy from GitHub repo**.
3. Set environment variables: `SESSION_SECRET` (any long random string), `DB_PATH=/app/data/netlogger.db`, `PORT=3000`. Optional, for email: `RESEND_API_KEY`, `ADMIN_EMAIL`, `APP_URL`.
4. Add a **Volume** mounted at `/app/data` so the database survives redeploys.
5. Every push to `main` auto-redeploys.

**Run locally:**

```bash
npm install
node server.js
```

Then open http://localhost:3000. `better-sqlite3` needs Node.js 18–22 to build easily on Windows — Node 25+ requires Visual Studio Build Tools. Railway builds independently of your local Node version.
