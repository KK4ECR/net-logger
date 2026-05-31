# Net Logger

Amateur Radio Net Control logging system with QRZ lookup, USNG coordinates, multi-user support, and CSV/PDF export.

## Features

- QRZ XML lookup: auto-fills name and license class on callsign entry
- USNG coordinates at 1m precision calculated from QRZ lat/lon
- Multi-user login with roles: Net Control, Backup NC, Observer
- Live check-in list shared across all connected users (polls every 5 seconds)
- Open/close net sessions with timestamps
- Message traffic logging with ARRL precedence levels
- CSV and PDF export with full header and USNG coordinates
- Persistent user accounts managed from the admin panel

---

## Deploy to Railway via GitHub

### Step 1: Create the GitHub repo

1. Go to https://github.com/new
2. Name it `net-logger` (or anything you like)
3. Set it to Private
4. Do NOT initialize with a README (you already have files)
5. Click "Create repository"

### Step 2: Push the code

Open a terminal in this folder and run:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/net-logger.git
git push -u origin main
```

Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username.

### Step 3: Connect to Railway

1. Go to https://railway.app and sign in
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Find and select your `net-logger` repo
5. Railway detects the config automatically and starts the build

### Step 4: Set environment variables in Railway

In your Railway project, go to Variables and add:

```
SESSION_SECRET=pick-a-long-random-string-here
DB_PATH=/app/data/netlogger.db
PORT=3000
```

For SESSION_SECRET, use something long and random like:
`a8f3k2p9x7m1q4w6e5r0t8y2u6i3o1s9d4f7g2h5j8`

### Step 5: Add a volume for the database

The SQLite database needs persistent storage so it survives redeploys.

1. In your Railway project, click "Add Service" then "Volume"
2. Set the mount path to `/app/data`
3. Redeploy the service

Without this step the database resets on every deploy.

### Step 6: Get your URL

Railway gives you a public URL like `net-logger-production.up.railway.app`.
Find it under "Settings" > "Networking" > "Public Networking".

---

## First login

The app creates a default admin account on first start:

- Callsign: `ADMIN`
- Password: `changeme`

**Change this immediately** after logging in. Go to Admin > Users, click "Reset pw" next to ADMIN, and set a real password.

Then add your standing accounts:

1. Go to Admin > Users
2. Add each operator with their callsign, a password, and a role
3. Hand out the passwords to your operators

Roles:
- Net Control: full access including opening/closing the net and managing users
- Backup NC: can add and remove check-ins, export, view log
- Observer: read-only view of the log

---

## Updating the app

Any time you push to the `main` branch on GitHub, Railway automatically redeploys.

```bash
git add .
git commit -m "describe your change"
git push
```

Railway handles the rest. Zero downtime in most cases.

---

## Running locally for testing

```bash
npm install
node server.js
```

Then open http://localhost:3000 in your browser.

---

## Tech stack

- Node.js + Express (server)
- SQLite via better-sqlite3 (database)
- bcryptjs (password hashing)
- express-session (login sessions)
- Vanilla HTML/CSS/JS (frontend, no framework)
- Railway (hosting)
