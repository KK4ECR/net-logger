const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'netlogger.db');

const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'observer',
    email TEXT,
    full_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login DATETIME
  );

  CREATE TABLE IF NOT EXISTS pending_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    callsign TEXT NOT NULL COLLATE NOCASE,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL,
    requested_role TEXT NOT NULL DEFAULT 'observer',
    password_hash TEXT NOT NULL,
    requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending'
  );

  CREATE TABLE IF NOT EXISTS net_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    net_name TEXT NOT NULL,
    frequency TEXT,
    mode TEXT,
    net_date TEXT,
    start_time TEXT,
    nc_callsign TEXT,
    bnc_callsign TEXT,
    opened_at DATETIME,
    closed_at DATETIME,
    opened_by INTEGER REFERENCES users(id),
    closed_by INTEGER REFERENCES users(id),
    status TEXT DEFAULT 'open'
  );

  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES net_sessions(id),
    seq INTEGER NOT NULL,
    callsign TEXT NOT NULL COLLATE NOCASE,
    name TEXT,
    license_class TEXT,
    time_in TEXT,
    has_comments INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    comment_notes TEXT,
    announcements_given INTEGER DEFAULT 0,
    has_traffic INTEGER DEFAULT 0,
    lat REAL,
    lon REAL,
    usng TEXT,
    w3w TEXT,
    address TEXT,
    logged_by INTEGER REFERENCES users(id),
    logged_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS traffic (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
    precedence TEXT,
    type TEXT,
    deliver_to TEXT,
    passed INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES net_sessions(id),
    description TEXT NOT NULL,
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'open',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    created_by INTEGER REFERENCES users(id),
    resolved_by INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS tactical_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    event_type TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS preset_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    preset_id INTEGER NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS preambles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
  );
`);

// Migrations
['email', 'full_name'].forEach(col => {
  try { db.exec(`ALTER TABLE checkins ADD COLUMN ${col} TEXT`); } catch(e) {}
});
try { db.exec('ALTER TABLE checkins ADD COLUMN w3w TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE checkins ADD COLUMN announcements_given INTEGER DEFAULT 0'); } catch(e) {}

// Checkins column migrations
try { db.exec('ALTER TABLE checkins ADD COLUMN tactical_call TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE checkins ADD COLUMN time_out TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE checkins ADD COLUMN location TEXT'); } catch(e) {}

// Net sessions column migrations
try { db.exec('ALTER TABLE net_sessions ADD COLUMN incident_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE net_sessions ADD COLUMN activation_type TEXT'); } catch(e) {}

// Issues table column migrations - required for databases created before these columns were added
try { db.exec('ALTER TABLE issues ADD COLUMN created_by INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE issues ADD COLUMN resolved_by INTEGER'); } catch(e) {}
try { db.exec('ALTER TABLE issues ADD COLUMN resolved_at DATETIME'); } catch(e) {}
try { db.exec('ALTER TABLE issues ADD COLUMN priority TEXT DEFAULT \'normal\''); } catch(e) {}

function bootstrapAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('netcontrol');
  if (!existing) {
    const hash = bcrypt.hashSync('changeme', 10);
    db.prepare(`INSERT OR IGNORE INTO users (callsign, password_hash, role) VALUES (?, ?, ?)`).run('ADMIN', hash, 'netcontrol');
    console.log('Bootstrap: created default admin account. Callsign: ADMIN, Password: changeme');
  }
}

bootstrapAdmin();

// Bootstrap default preambles
const preambleDefaults = [
  {
    type: 'regular',
    title: 'Clay County ARES Regular Weekly Net',
    content: `# Clay County ARES Regular Weekly Net

**Net Control:** [NET CONTROL CALLSIGN]
**Frequency:** 146.820 MHz, PL 100.0 Hz
**Mode:** FM

---

## Opening

QST QST QST. This is [CALLSIGN] and I will be Net Control for the Clay County ARES Regular Weekly Net.

This net meets every [DAY] evening at [TIME] local time on [FREQUENCY] MHz.

This net is open to all licensed amateur radio operators. All stations please stand by.

---

## Purpose

The purpose of this net is to:

- Maintain communication readiness among Clay County ARES members
- Pass any formal or informal traffic
- Provide announcements of interest to the amateur radio community
- Practice net procedures in preparation for emergency operations

---

## Check-In Procedure

Stations wishing to check in, please call [CALLSIGN] with your callsign, name, location, and indicate if you have any announcements or traffic.

*[PAUSE FOR CHECK-INS]*

---

## Net Business

*[CONDUCT NET BUSINESS — ANNOUNCEMENTS, TRAFFIC, ITEMS OF INTEREST]*

---

## Closing

This is [CALLSIGN], Net Control for the Clay County ARES Regular Weekly Net. We had [NUMBER] check-ins this evening.

This net is now closed. Thank you for participating. 73.`
  },
  {
    type: 'emergency',
    title: 'Clay County ARES Emergency Net',
    content: `# Clay County ARES Emergency Net

**⚠ EMERGENCY ACTIVATION**

**Net Control:** [NET CONTROL CALLSIGN]
**Frequency:** [PRIMARY FREQUENCY] MHz
**Alternate:** [ALTERNATE FREQUENCY] MHz
**Mode:** FM

---

## Emergency Net Opening

QST QST QST. This is [CALLSIGN] activating the Clay County ARES Emergency Net.

**This is an EMERGENCY net.** All routine traffic and casual conversation will cease immediately.

This net is operating under the direction of [EMERGENCY COORDINATOR / AGENCY].

Only stations with emergency or priority traffic should check in at this time.

---

## Situation

*[BRIEF SITUATION DESCRIPTION]*

---

## Check-In Procedure

All stations with emergency or priority traffic, check in now with your callsign, location, and the nature of your traffic.

Relay stations stand by on [FREQUENCY].

*[PAUSE FOR CHECK-INS]*

---

## Operating Procedures

- All transmissions must be brief and essential
- Use standard ICS/ARRL message formats for formal traffic
- Report locations using USNG coordinates when possible
- Backup frequency is [ALTERNATE FREQUENCY] MHz

---

## Closing

*[ONLY CLOSE WHEN AUTHORIZED BY EMERGENCY COORDINATOR]*

This is [CALLSIGN]. The Clay County ARES Emergency Net is now [SUSPENDED / CLOSED].

[INCLUDE DEBRIEF INFORMATION IF APPLICABLE]`
  },
  {
    type: 'skywarn',
    title: 'Clay County Skywarn Net',
    content: `# Clay County Skywarn Net

**Net Control:** [NET CONTROL CALLSIGN]
**Frequency:** 146.820 MHz, PL 100.0 Hz
**NWS Jacksonville:** [NWS LIAISON CALLSIGN]

---

## Skywarn Net Opening

QST QST QST. This is [CALLSIGN] activating the Clay County Skywarn Net in support of the National Weather Service Jacksonville.

A [SEVERE THUNDERSTORM / TORNADO / TROPICAL] watch or warning is in effect for Clay County until [TIME].

Skywarn spotters are requested to check in and report significant weather observations.

---

## What to Report

Please report the following when observed:

- **Tornado or funnel cloud** — location, direction of movement, estimated distance
- **Wind damage** — downed trees, power lines, structural damage
- **Large hail** — size in inches (quarter = 1 inch, golf ball = 1.75 inches)
- **Heavy rainfall** — estimated rate, any flooding observed
- **Flash flooding** — road closures, water over roadways, depth if known

---

## Check-In Procedure

Skywarn spotters and licensed amateurs in Clay County, check in now with your callsign, name, and location.

*[PAUSE FOR CHECK-INS]*

---

## Reporting Format

When reporting weather, state:

1. Your callsign
2. Your location (city, nearest intersection, or USNG coordinate)
3. What you are observing
4. Time of observation

---

## Closing

This is [CALLSIGN]. The Clay County Skywarn Net is now closed. Thank you to all spotters. Your reports have been forwarded to NWS Jacksonville.

Please monitor [FREQUENCY] for any reactivation. 73.`
  },
  {
    type: 'event',
    title: 'Clay County ARES Event Net',
    content: `# Clay County ARES Event Net

**Event:** [EVENT NAME]
**Net Control:** [NET CONTROL CALLSIGN]
**Date:** [DATE]
**Frequency:** [FREQUENCY] MHz
**Mode:** FM

---

## Event Net Opening

QST QST QST. This is [CALLSIGN] and I will be Net Control for the [EVENT NAME] communications net.

This net is providing amateur radio communications support for [EVENT ORGANIZER / AGENCY] at [LOCATION].

---

## Net Participants

The following stations are assigned to this operation:

- **[CALLSIGN]** — [ASSIGNMENT / LOCATION]
- **[CALLSIGN]** — [ASSIGNMENT / LOCATION]
- **[CALLSIGN]** — [ASSIGNMENT / LOCATION]

---

## Operating Procedures

- All transmissions should be brief and use standard phonetics
- Use plain language — this is not an emergency net
- Report status updates every [INTERVAL] minutes or as needed
- Emergency traffic takes priority at all times
- Backup frequency is [ALTERNATE FREQUENCY] MHz

---

## Check-In Procedure

All assigned stations, please check in with your callsign, assignment, and readiness status.

*[PAUSE FOR CHECK-INS]*

---

## Closing

This is [CALLSIGN]. The [EVENT NAME] communications net is now closed.

Total operating time: [DURATION]. Thank you to all operators. 73.`
  }
];

const upsertPreamble = db.prepare(`INSERT INTO preambles (type, title, content, updated_by)
  VALUES (?, ?, ?, 'SYSTEM')
  ON CONFLICT(type) DO NOTHING`);

preambleDefaults.forEach(p => upsertPreamble.run(p.type, p.title, p.content));

const queries = {
  getAllUsers: db.prepare('SELECT id, callsign, role, email, full_name, last_login FROM users ORDER BY callsign'),
  getUserByCallsign: db.prepare('SELECT * FROM users WHERE callsign = ? COLLATE NOCASE'),
  getUserById: db.prepare('SELECT id, callsign, role, email, full_name FROM users WHERE id = ?'),
  createUser: db.prepare('INSERT INTO users (callsign, password_hash, role, email, full_name) VALUES (?, ?, ?, ?, ?)'),
  updateUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  updateUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  updateUserEmail: db.prepare('UPDATE users SET email = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  updateLastLogin: db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?'),
  getAdminEmails: db.prepare("SELECT email FROM users WHERE role = 'netcontrol' AND email IS NOT NULL AND email != ''"),

  createRequest: db.prepare('INSERT INTO pending_requests (callsign, full_name, email, requested_role, password_hash) VALUES (?, ?, ?, ?, ?)'),
  getPendingRequests: db.prepare("SELECT * FROM pending_requests WHERE status = 'pending' ORDER BY requested_at ASC"),
  getRequestById: db.prepare('SELECT * FROM pending_requests WHERE id = ?'),
  updateRequestStatus: db.prepare('UPDATE pending_requests SET status = ? WHERE id = ?'),
  getRequestByCallsign: db.prepare("SELECT * FROM pending_requests WHERE callsign = ? COLLATE NOCASE AND status = 'pending'"),

  getOpenSession: db.prepare(`SELECT * FROM net_sessions WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1`),
  getSessionById: db.prepare('SELECT * FROM net_sessions WHERE id = ?'),
  createSession: db.prepare(`INSERT INTO net_sessions (net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, opened_at, opened_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'open')`),
  closeSession: db.prepare(`UPDATE net_sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ? WHERE id = ?`),
  getRecentSessions: db.prepare('SELECT * FROM net_sessions ORDER BY opened_at DESC LIMIT 20'),

  getCheckins: db.prepare('SELECT * FROM checkins WHERE session_id = ? ORDER BY seq ASC'),
  getCheckinById: db.prepare('SELECT * FROM checkins WHERE id = ?'),
  getNextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM checkins WHERE session_id = ?'),
  insertCheckin: db.prepare(`INSERT INTO checkins (session_id, seq, callsign, name, license_class, time_in, has_comments, comment_count, comment_notes, has_traffic, lat, lon, usng, w3w, address, tactical_call, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  deleteCheckin: db.prepare('DELETE FROM checkins WHERE id = ? AND session_id = ?'),
  resequenceCheckins: db.prepare('UPDATE checkins SET seq = (SELECT COUNT(*) FROM checkins c2 WHERE c2.session_id = checkins.session_id AND c2.id <= checkins.id) WHERE session_id = ?'),

  getTrafficByCheckin: db.prepare('SELECT * FROM traffic WHERE checkin_id = ? ORDER BY id'),
  insertTraffic: db.prepare('INSERT INTO traffic (checkin_id, precedence, type, deliver_to, passed) VALUES (?, ?, ?, ?, ?)'),
  updateTrafficPassed: db.prepare('UPDATE traffic SET passed = ? WHERE id = ?'),

  getIssuesBySession: db.prepare('SELECT * FROM issues WHERE session_id = ? ORDER BY created_at DESC'),
  insertIssue: db.prepare('INSERT INTO issues (session_id, description, priority, created_by) VALUES (?, ?, ?, ?)'),
  resolveIssue: db.prepare('UPDATE issues SET status = ?, resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ?'),
  deleteIssue: db.prepare('DELETE FROM issues WHERE id = ?'),
  countOpenIssues: db.prepare("SELECT COUNT(*) as cnt FROM issues WHERE session_id = ? AND status = 'open'"),

  checkoutCheckin: db.prepare('UPDATE checkins SET time_out = ? WHERE id = ?'),
  getOpenIssueCount: db.prepare("SELECT COUNT(*) as cnt FROM issues WHERE session_id = ? AND status = 'open'"),

  getPositions: db.prepare('SELECT * FROM tactical_positions ORDER BY name'),
  insertPosition: db.prepare('INSERT INTO tactical_positions (name, description) VALUES (?, ?)'),
  deletePosition: db.prepare('DELETE FROM tactical_positions WHERE id = ?'),

  getPresets: db.prepare('SELECT * FROM presets ORDER BY name'),
  getPresetsByType: db.prepare('SELECT * FROM presets WHERE event_type = ? ORDER BY name'),
  insertPreset: db.prepare('INSERT INTO presets (name, event_type, description) VALUES (?, ?, ?)'),
  deletePreset: db.prepare('DELETE FROM presets WHERE id = ?'),

  getPresetPositions: db.prepare('SELECT * FROM preset_positions WHERE preset_id = ? ORDER BY sort_order, name'),
  insertPresetPosition: db.prepare('INSERT INTO preset_positions (preset_id, name, description, sort_order) VALUES (?, ?, ?, ?)'),
  deletePresetPosition: db.prepare('DELETE FROM preset_positions WHERE id = ?'),

  getAllPreambles: db.prepare('SELECT * FROM preambles ORDER BY id'),
  getPreambleByType: db.prepare('SELECT * FROM preambles WHERE type = ?'),
  updatePreamble: db.prepare('UPDATE preambles SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE type = ?'),
};

function getFullCheckins(sessionId) {
  const checkins = queries.getCheckins.all(sessionId);
  return checkins.map(ci => ({
    ...ci,
    traffic: queries.getTrafficByCheckin.all(ci.id)
  }));
}

module.exports = { db, queries, getFullCheckins };
