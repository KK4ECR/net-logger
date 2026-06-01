const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fetch = require('node-fetch');
const { db, queries, getFullCheckins } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const SQLiteStore = require('connect-sqlite3')(session);
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: path.join(__dirname, 'data') }),
  secret: process.env.SESSION_SECRET || 'netlogger-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.session.role)) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// QRZ PROXY - avoids CORS by making the request server-side
app.post('/api/qrz/session', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const url = `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&agent=NetLogger1.0`;
    const r = await fetch(url);
    const txt = await r.text();
    const keyMatch = txt.match(/<Key>([^<]+)<\/Key>/);
    const errMatch = txt.match(/<Error>([^<]+)<\/Error>/);
    if (keyMatch) {
      res.json({ key: keyMatch[1] });
    } else {
      res.status(401).json({ error: errMatch ? errMatch[1] : 'Login failed' });
    }
  } catch (e) {
    res.status(500).json({ error: 'QRZ connection failed: ' + e.message });
  }
});

app.get('/api/qrz/lookup/:callsign', requireAuth, async (req, res) => {
  const { callsign } = req.params;
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: 'QRZ session key required' });
  try {
    const url = `https://xmldata.qrz.com/xml/current/?s=${encodeURIComponent(key)}&callsign=${encodeURIComponent(callsign)}`;
    const r = await fetch(url);
    const txt = await r.text();
    const get = tag => { const m = txt.match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')); return m ? m[1] : ''; };
    const fname = get('fname');
    const lname = get('lname');
    const cls = get('class');
    const lat = parseFloat(get('lat'));
    const lon = parseFloat(get('lon'));
    const addr1 = get('addr1');
    const addr2 = get('addr2');
    const state = get('state');
    const zip = get('zip');
    const errMatch = txt.match(/<Error>([^<]+)<\/Error>/);
    if (!fname && !lname) {
      return res.status(404).json({ error: errMatch ? errMatch[1] : 'Callsign not found' });
    }
    res.json({
      name: [fname, lname].filter(Boolean).join(' '),
      licClass: cls,
      lat: isNaN(lat) ? null : lat,
      lon: isNaN(lon) ? null : lon,
      addr: addr1,
      city: addr2,
      state,
      zip
    });
  } catch (e) {
    res.status(500).json({ error: 'QRZ lookup failed: ' + e.message });
  }
});

// AUTH
app.get('/api/users/list', (req, res) => {
  const users = queries.getAllUsers.all();
  res.json(users.map(u => ({ id: u.id, callsign: u.callsign, role: u.role })));
});

app.post('/api/auth/login', (req, res) => {
  const { callsign, password } = req.body;
  if (!callsign || !password) return res.status(400).json({ error: 'Callsign and password required' });
  const user = queries.getUserByCallsign.get(callsign);
  if (!user) return res.status(401).json({ error: 'Invalid callsign or password' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Invalid callsign or password' });
  queries.updateLastLogin.run(user.id);
  req.session.userId = user.id;
  req.session.callsign = user.callsign;
  req.session.role = user.role;
  res.json({ callsign: user.callsign, role: user.role });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, callsign: req.session.callsign, role: req.session.role });
});

// USER MANAGEMENT
app.get('/api/users', requireRole('netcontrol'), (req, res) => {
  res.json(queries.getAllUsers.all());
});

app.post('/api/users', requireRole('netcontrol'), (req, res) => {
  const { callsign, password, role } = req.body;
  if (!callsign || !password || !role) return res.status(400).json({ error: 'Callsign, password, and role required' });
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = queries.createUser.run(callsign.toUpperCase(), hash, role);
    res.json({ id: result.lastInsertRowid, callsign: callsign.toUpperCase(), role });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Callsign already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id/password', requireRole('netcontrol'), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  const hash = bcrypt.hashSync(password, 10);
  queries.updateUserPassword.run(hash, req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/role', requireRole('netcontrol'), (req, res) => {
  const { role } = req.body;
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  queries.updateUserRole.run(role, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireRole('netcontrol'), (req, res) => {
  if (parseInt(req.params.id) === req.session.userId) return res.status(400).json({ error: 'Cannot delete your own account' });
  queries.deleteUser.run(req.params.id);
  res.json({ ok: true });
});

// NET SESSIONS
app.get('/api/session/current', requireAuth, (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.json({ active: false });
  const checkins = getFullCheckins(session.id);
  res.json({ active: true, session, checkins });
});

app.post('/api/session/open', requireRole('netcontrol'), (req, res) => {
  const existing = queries.getOpenSession.get();
  if (existing) return res.status(409).json({ error: 'A net session is already open' });
  const { net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign } = req.body;
  if (!net_name) return res.status(400).json({ error: 'Net name required' });
  const result = queries.createSession.run(net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, req.session.userId);
  const session = queries.getSessionById.get(result.lastInsertRowid);
  res.json({ session, checkins: [] });
});

app.post('/api/session/close', requireRole('netcontrol'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  queries.closeSession.run(req.session.userId, session.id);
  res.json({ ok: true });
});

app.get('/api/session/history', requireAuth, (req, res) => {
  res.json(queries.getRecentSessions.all());
});

app.get('/api/session/:id/checkins', requireAuth, (req, res) => {
  res.json(getFullCheckins(req.params.id));
});

// CHECKINS
app.post('/api/checkin', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open net session' });
  const { callsign, name, license_class, time_in, has_comments, comment_count, comment_notes, has_traffic, lat, lon, usng, address, traffic } = req.body;
  if (!callsign) return res.status(400).json({ error: 'Callsign required' });
  const { next_seq } = queries.getNextSeq.get(session.id);
  const result = queries.insertCheckin.run(
    session.id, next_seq, callsign.toUpperCase(), name || '', license_class || '',
    time_in || '', has_comments ? 1 : 0, comment_count || 0, comment_notes || '',
    has_traffic ? 1 : 0, lat || null, lon || null, usng || null, address || '',
    req.session.userId
  );
  if (has_traffic && Array.isArray(traffic)) {
    traffic.forEach(t => {
      queries.insertTraffic.run(result.lastInsertRowid, t.precedence, t.type, t.to, t.passed ? 1 : 0);
    });
  }
  const checkin = queries.getCheckinById.get(result.lastInsertRowid);
  checkin.traffic = queries.getTrafficByCheckin.all(result.lastInsertRowid);
  checkin.logged_by_callsign = req.session.callsign;
  res.json(checkin);
});

app.delete('/api/checkin/:id', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  queries.deleteCheckin.run(req.params.id, session.id);
  queries.resequenceCheckins.run(session.id);
  res.json({ ok: true });
});

app.put('/api/traffic/:id/passed', requireRole('netcontrol', 'backup'), (req, res) => {
  const { passed } = req.body;
  queries.updateTrafficPassed.run(passed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Net Logger running on port ${PORT}`);
});
