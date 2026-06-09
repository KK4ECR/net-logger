# Clay County ARES Net Logger — User Manual

A web-based net control logging system for emergency activations and regular nets. Supports multi-operator use, tactical call assignments, ICS 309 export, and a real-time status board.

---

## Table of Contents

1. [Feature Overview](#feature-overview)
2. [Getting Started — First Login](#getting-started--first-login)
3. [Opening a Net or Activation](#opening-a-net-or-activation)
4. [Logging Check-ins](#logging-check-ins)
5. [Tactical Call Assignments](#tactical-call-assignments)
6. [Logging Message Traffic](#logging-message-traffic)
7. [Issues Tracking](#issues-tracking)
8. [Status Board (Dashboard)](#status-board-dashboard)
9. [ICS 309 Export](#ics-309-export)
10. [Session History & Past Activations](#session-history--past-activations)
11. [User Roles & Access](#user-roles--access)
12. [Managing Users (Admin)](#managing-users-admin)
13. [QRZ XML Setup](#qrz-xml-setup)
14. [Deploy to Railway](#deploy-to-railway)
15. [Running Locally](#running-locally)

---

## Feature Overview

| Feature | Description |
|---|---|
| Multi-user login | Callsign-based login with role-based access |
| Net sessions | Open/close activations with incident name and type |
| Check-in logging | Log stations with QRZ auto-fill, time, and location |
| Tactical call assignment | Assign stations to tactical positions (EOC-1, Shelter-Alpha, etc.) |
| Message traffic | Log messages with precedence, number, from/to, description, timestamps |
| Issues tracker | Log open/outstanding issues with priority; resolve when complete |
| Live status board | Separate dashboard screen showing assignments, traffic, and issues |
| ICS 309 export | Printable ICS 309 form (print-to-PDF) and CSV download |
| Session history | View and export any past activation |
| QRZ lookup | Auto-fills name, license class, and USNG coordinates from QRZ XML |
| Map view | Pins all stations with USNG coordinates on an OpenStreetMap map |

---

## Getting Started — First Login

The app creates a default admin account on first start:

- **Callsign:** `ADMIN`
- **Password:** `changeme`

**Change this immediately.** Go to **Admin → Users**, click **Reset pw** next to ADMIN, and set a real password.

Then create accounts for your operators:

1. Go to **Admin → Users**
2. Click **Add user manually** or let operators submit a request from the login screen
3. Set callsign, full name, email, password, and role
4. Operators log in with their callsign and password

---

## Opening a Net or Activation

Go to **Setup** and fill in the net information before opening.

### Net Information Fields

| Field | Required | Notes |
|---|---|---|
| Net name | Yes | e.g. "Clay County ARES Simplex Net" |
| Incident / Activation name | No | Appears on ICS 309 header — e.g. "Hurricane Irma Activation 2024" |
| Activation type | No | Storm, Emergency, Exercise, Planned Event, Welfare Net, Regular Net |
| Net Control callsign | No | NCS operator's callsign |
| Backup Net Control | No | BNC callsign |
| Frequency (MHz) | No | e.g. 146.820 |
| Mode | No | FM, SSB, DMR, D-STAR, etc. |
| Net date | No | Defaults to today |
| Start time | No | Defaults to current time |

Click **Open Net** to start the session. Only **Net Control** role can open or close a net.

> **For activations:** Always fill in the Incident Name and Activation Type — these appear on the ICS 309 form and are required for proper incident documentation.

---

## Logging Check-ins

Go to **Check-ins** once the net is open.

### Check-in Fields

**Callsign** — Type the station's callsign. If QRZ is connected, the name and license class auto-fill after a short delay. Press Enter or click **Log check-in** to save.

**Name** — Auto-filled by QRZ or entered manually.

**License class** — Auto-filled by QRZ.

**Time in** — Defaults to the current time. Edit if logging a delayed check-in.

**Tactical call / position** — Assign the station to a tactical position (see [Tactical Calls](#tactical-call-assignments)). Type a new position or pick from the dropdown list.

**Location / site** — The station's physical location (e.g. "Clay County EOC", "Red Cross Shelter — Oakleaf").

**Comments / announcements** — Check the box if the station has announcements. Enter the count and a brief description. The status board tracks which announcements still need to be given.

**Message traffic** — Check the box if the station has traffic to pass. See [Logging Message Traffic](#logging-message-traffic).

Click **Log check-in** to save. The station appears at the top of the live list immediately. All other connected operators see it within 5 seconds.

### Removing a Check-in

Click the trash icon on any row in the live list. Net Control and Backup NC can remove check-ins; Observers cannot.

---

## Tactical Call Assignments

Tactical calls identify a station by its *function* rather than its callsign — for example, EOC-1, Shelter-Alpha, or Command Post — which is standard practice during activations.

### Assigning a Tactical Call at Check-in

When logging a check-in, type the tactical call in the **Tactical call / position** field. Previously used calls appear in the dropdown as you type.

### Managing Pre-defined Positions

As Net Control, you can maintain a standing list of tactical positions so operators can pick from a consistent dropdown:

1. Go to **Admin → Positions** (if configured)
2. Add positions with a name and optional description
3. These appear in the tactical call dropdown for all operators

### Where Tactical Calls Appear

- **Live check-in list** — shown as a green pill next to the callsign
- **Log table** — dedicated Tactical column
- **Status Board** — the Tactical Assignments section shows every assigned position in real time
- **ICS 309 form** — Tactical Call column in the communications log

---

## Logging Message Traffic

When checking in a station with message traffic, check **Has message traffic** and click **Add message** for each piece of traffic.

### Traffic Fields

| Field | Notes |
|---|---|
| Precedence | Emergency / Priority / Welfare / Routine |
| Msg # | Message number (e.g. 001, ARL-123) |
| Type | Formal / Informal / Health & Welfare |
| Description / Subject | Brief plain-text description of the message |
| From callsign | Origin station if different from the checking-in station |
| Deliver to | Destination callsign or agency |
| Time sent | When the message was sent (HH:MM) |
| Time received | When the message was received (HH:MM) |
| Passed | Check when the message has been passed |

### Marking Traffic as Passed

From the **Status Board**, click **Passed** on any pending traffic item. This updates in real time for all connected operators.

### Traffic Precedence Colors

| Precedence | Color | Meaning |
|---|---|---|
| Emergency | Red | Life-safety, pass immediately |
| Priority | Blue | Urgent, pass before Welfare/Routine |
| Welfare | Amber | Health and welfare inquiries |
| Routine | Green | Non-urgent traffic |

---

## Issues Tracking

Use the **Issues** page to log open problems, outstanding action items, or anything that needs follow-up during the activation.

### Logging an Issue

1. Click **Issues** in the sidebar
2. Select a priority: Normal, High, Critical, or Low
3. Type a description
4. Click **Log Issue** (or press Enter)

### Priorities

| Priority | Use for |
|---|---|
| Critical | Safety issue, immediate action required |
| High | Significant problem, address soon |
| Normal | Standard action item |
| Low | Note for later, low urgency |

### Resolving an Issue

Click **Resolve** on any open issue. It moves to the resolved list with a timestamp. Net Control can delete issues entirely.

### Issues Badge

The sidebar shows an amber badge on the Issues nav item with the count of open issues. The Status Board also shows open issues in real time.

---

## Status Board (Dashboard)

The Status Board is a separate full-screen view designed to run on a second monitor or a projector at the EOC. It updates automatically every 5 seconds.

### Opening the Status Board

From the Check-ins page, click the **Open Status Board** button. The board opens in a new window.

The Status Board does not require a separate login — it uses the same session. If the session expires, it redirects to the login page.

### Status Board Sections

**Stat Cards (top row)**
- Total Check-ins — number of stations that have checked in
- Announcements — total / remaining to give
- Traffic — total messages / remaining to pass
- Emergency/Priority — high-precedence pending count + open issues count

**Traffic Precedence Grid**
- Four cards showing pending vs. total for each precedence level

**Tactical Assignments**
- A card for every station that has been assigned a tactical call
- Shows: tactical position name, operator callsign, operator name, time of check-in

**Currently Logged In**
- Chips showing which NCS operators are actively connected

**Pending Announcements**
- List of stations with announcements remaining to be given
- Click **Given** to mark one announcement as delivered

**Pending Traffic**
- All undelivered traffic sorted by precedence (Emergency first)
- Shows message number, destination, type, and description
- Click **Passed** to mark traffic as delivered

**Open Issues**
- All open issues with priority and who logged them

---

## ICS 309 Export

ICS 309 is the standard ARRL/FEMA communications log form. The app generates it automatically from the session log.

### Viewing / Printing the ICS 309

1. Go to **Export** in the sidebar
2. Click **View / Print ICS 309**
3. A new tab opens with the formatted form
4. Click **Print / Save PDF** to print or save as PDF (use landscape orientation)

The ICS 309 form includes:
- Incident name, operational period (open → close timestamps), activation type
- Net Control and Backup Net Control callsigns
- Frequency and mode
- Full communications log: each check-in and each traffic message as a separate row
  - Time, From, To, Tactical Call, Msg #, Precedence, Subject, Passed status
- Issues log (if any issues were logged)
- Signature block

### Downloading as CSV

Click **Download ICS 309 CSV** to get a structured CSV version suitable for filing or importing into incident management software.

The CSV includes the same information as the printed form plus all raw fields.

### 24-Hour Period Organization

Each ICS 309 covers one operational period. When an activation spans multiple days, close the net at the end of each 24-hour period (23:59) and open a new session for the next period. Each session generates its own ICS 309.

---

## Session History & Past Activations

All past sessions are stored in the database and can be recalled at any time.

### Viewing Session History

1. Go to **Export** in the sidebar
2. Scroll to **Session history**
3. The table lists all activations with date, net name, incident name, activation type, net control, and open issue count

### Exporting Past Sessions

From the session history table, each row has:
- **ICS 309** — opens the printable ICS 309 form for that session
- **CSV** — downloads the ICS 309 CSV for that session

You can access any past activation's log this way, even months later.

---

## User Roles & Access

| Action | Net Control | Backup NC | Observer |
|---|---|---|---|
| View log and status board | ✓ | ✓ | ✓ |
| Add check-ins | ✓ | ✓ | — |
| Remove check-ins | ✓ | ✓ | — |
| Log and resolve issues | ✓ | ✓ | — |
| Mark traffic passed | ✓ | ✓ | — |
| Export CSV / PDF / ICS 309 | ✓ | ✓ | ✓ |
| Open / close net | ✓ | — | — |
| Manage users | ✓ | — | — |
| Approve account requests | ✓ | — | — |
| Delete issues | ✓ | — | — |

---

## Managing Users (Admin)

Only Net Control role can access the Admin panel.

### Adding a User Manually

1. Go to **Admin → Users**
2. Fill in callsign, full name, email, password, and role
3. Click **Add**

### Account Requests

Operators can request an account from the login screen without needing admin involvement. When a request is submitted:
- An email is sent to all Net Control accounts (if email is configured)
- A badge appears on the Admin nav item
- Go to **Admin** to approve or deny the request
- On approval, the operator receives an email confirmation

### Resetting a Password

In the user table, click **Reset pw** next to any user and enter the new password.

### Changing a Role

Click **Role** next to a user to cycle through available roles.

---

## QRZ XML Setup

QRZ XML lookup auto-fills the operator's name, license class, and USNG coordinates when you type a callsign. It requires a QRZ XML subscription (separate from a free QRZ account).

### Connecting to QRZ

1. Go to **Setup**
2. Enter your QRZ username and password
3. Click **Connect**
4. A green checkmark confirms the connection

The session key is stored in memory for the duration of your browser session. Re-enter credentials after logging out and back in.

If QRZ is not connected or the callsign isn't found, you can still enter the name manually — the check-in is not blocked.

---

## Deploy to Railway

### Step 1: Create the GitHub repo

1. Go to https://github.com/new
2. Name it `net-logger`
3. Set to Private
4. Do **not** initialize with a README
5. Click **Create repository**

### Step 2: Push the code

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/net-logger.git
git push -u origin main
```

### Step 3: Connect to Railway

1. Go to https://railway.app and sign in
2. Click **New Project → Deploy from GitHub repo**
3. Select your `net-logger` repo
4. Railway detects the config and starts the build

### Step 4: Set environment variables

In Railway → Variables, add:

```
SESSION_SECRET=pick-a-long-random-string
DB_PATH=/app/data/netlogger.db
PORT=3000
```

Optional — for email notifications on account requests:
```
RESEND_API_KEY=your-resend-api-key
ADMIN_EMAIL=your-email@example.com
APP_URL=https://your-app.railway.app
```

### Step 5: Add a volume for the database

1. In Railway, click **Add Service → Volume**
2. Set mount path to `/app/data`
3. Redeploy

Without this, the database resets on every deploy.

### Step 6: Get your URL

Railway provides a URL under **Settings → Networking → Public Networking**.

### Updating

Push any change to `main` and Railway redeploys automatically:

```bash
git add .
git commit -m "describe change"
git push
```

---

## Running Locally

```bash
cd net-logger
npm install
node server.js
```

Open http://localhost:3000 in your browser.

> **Note:** `better-sqlite3` requires Node.js 18–22 for easy local setup. Node.js 25+ requires Visual Studio Build Tools on Windows to compile the native module. The app runs normally on Railway regardless of local Node version.

---

## Tech Stack

- Node.js + Express — server
- SQLite via better-sqlite3 — database
- bcryptjs — password hashing
- express-session + connect-sqlite3 — login sessions
- Vanilla HTML/CSS/JS — frontend (no framework)
- Leaflet — map view
- Railway — hosting
