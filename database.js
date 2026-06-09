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
`);

// ─── TACTICAL POSITIONS ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tactical_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    created_by_callsign TEXT
  );
`);

// Migrations - run silently, ignore if column already exists
try { db.exec('ALTER TABLE checkins ADD COLUMN announcements_given INTEGER DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE checkins ADD COLUMN tactical_call TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE traffic ADD COLUMN msg_number TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE traffic ADD COLUMN from_callsign TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE traffic ADD COLUMN description TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE traffic ADD COLUMN time_sent TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE traffic ADD COLUMN time_received TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE net_sessions ADD COLUMN incident_name TEXT'); } catch(e) {}
try { db.exec('ALTER TABLE net_sessions ADD COLUMN activation_type TEXT'); } catch(e) {}

['email', 'full_name'].forEach(col => {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`); } catch(e) {}
});
try { db.exec("ALTER TABLE checkins ADD COLUMN w3w TEXT"); } catch(e) {}

function bootstrapAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE role = ?').get('netcontrol');
  if (!existing) {
    const hash = bcrypt.hashSync('changeme', 10);
    db.prepare(`INSERT OR IGNORE INTO users (callsign, password_hash, role) VALUES (?, ?, ?)`).run('ADMIN', hash, 'netcontrol');
    console.log('Bootstrap: created default admin account. Callsign: ADMIN, Password: changeme');
    console.log('IMPORTANT: Change this password immediately after first login.');
  }
}

bootstrapAdmin();

const queries = {
  // Users
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

  // Pending requests
  createRequest: db.prepare('INSERT INTO pending_requests (callsign, full_name, email, requested_role, password_hash) VALUES (?, ?, ?, ?, ?)'),
  getPendingRequests: db.prepare("SELECT * FROM pending_requests WHERE status = 'pending' ORDER BY requested_at ASC"),
  getRequestById: db.prepare('SELECT * FROM pending_requests WHERE id = ?'),
  updateRequestStatus: db.prepare('UPDATE pending_requests SET status = ? WHERE id = ?'),
  getRequestByCallsign: db.prepare("SELECT * FROM pending_requests WHERE callsign = ? COLLATE NOCASE AND status = 'pending'"),

  // Sessions
  getOpenSession: db.prepare(`SELECT * FROM net_sessions WHERE status = 'open' ORDER BY opened_at DESC LIMIT 1`),
  getSessionById: db.prepare('SELECT * FROM net_sessions WHERE id = ?'),
  createSession: db.prepare(`INSERT INTO net_sessions (net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, opened_at, opened_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?, 'open')`),
  closeSession: db.prepare(`UPDATE net_sessions SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ? WHERE id = ?`),
  getRecentSessions: db.prepare('SELECT * FROM net_sessions ORDER BY opened_at DESC LIMIT 20'),

  // Checkins
  getCheckins: db.prepare('SELECT * FROM checkins WHERE session_id = ? ORDER BY seq ASC'),
  getCheckinById: db.prepare('SELECT * FROM checkins WHERE id = ?'),
  getNextSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM checkins WHERE session_id = ?'),
  insertCheckin: db.prepare(`INSERT INTO checkins (session_id, seq, callsign, name, license_class, time_in, has_comments, comment_count, comment_notes, has_traffic, lat, lon, usng, w3w, address, tactical_call, logged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  deleteCheckin: db.prepare('DELETE FROM checkins WHERE id = ? AND session_id = ?'),
  resequenceCheckins: db.prepare('UPDATE checkins SET seq = (SELECT COUNT(*) FROM checkins c2 WHERE c2.session_id = checkins.session_id AND c2.id <= checkins.id) WHERE session_id = ?'),

  // Traffic
  getTrafficByCheckin: db.prepare('SELECT * FROM traffic WHERE checkin_id = ? ORDER BY id'),
  insertTraffic: db.prepare('INSERT INTO traffic (checkin_id, precedence, type, deliver_to, passed, msg_number, from_callsign, description, time_sent, time_received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateTrafficPassed: db.prepare('UPDATE traffic SET passed = ? WHERE id = ?'),
  deleteTrafficByCheckin: db.prepare('DELETE FROM traffic WHERE checkin_id = ?'),

  // Tactical positions
  getPositions: db.prepare('SELECT * FROM tactical_positions ORDER BY sort_order, name'),
  insertPosition: db.prepare('INSERT INTO tactical_positions (name, description, sort_order) VALUES (?, ?, ?)'),
  deletePosition: db.prepare('DELETE FROM tactical_positions WHERE id = ?'),

  // Issues
  getIssuesBySession: db.prepare("SELECT * FROM issues WHERE session_id = ? ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC"),
  insertIssue: db.prepare("INSERT INTO issues (session_id, description, priority, created_by, created_by_callsign) VALUES (?, ?, ?, ?, ?)"),
  resolveIssue: db.prepare("UPDATE issues SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?"),
  deleteIssue: db.prepare("DELETE FROM issues WHERE id = ?"),
  getOpenIssueCount: db.prepare("SELECT COUNT(*) as cnt FROM issues WHERE session_id = ? AND status = 'open'"),
};

function getFullCheckins(sessionId) {
  const checkins = queries.getCheckins.all(sessionId);
  return checkins.map(ci => ({
    ...ci,
    traffic: queries.getTrafficByCheckin.all(ci.id)
  }));
}

module.exports = { db, queries, getFullCheckins };
