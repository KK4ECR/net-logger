const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fetch = require('node-fetch');
const { db, queries, getFullCheckins } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const APP_URL = process.env.APP_URL || 'https://your-app.railway.app';

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

// ─── EMAIL ───────────────────────────────────────────────────────────────────
const ROLES_DISPLAY = { netcontrol: 'Net Control', backup: 'Backup Net Control', observer: 'Observer' };

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) { console.log('RESEND_API_KEY not set, skipping email to', to); return; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'Clay ARES Net Logger <noreply@resend.dev>', to: [to], subject, html })
    });
    const data = await r.json();
    if (!r.ok) console.error('Resend error:', data);
    else console.log('Email sent to', to, '- id:', data.id);
  } catch(e) { console.error('Email send failed:', e.message); }
}

function emailNewRequestToAdmin(request) {
  const adminEmails = queries.getAdminEmails.all().map(r => r.email);
  const targets = adminEmails.length > 0 ? adminEmails : (ADMIN_EMAIL ? [ADMIN_EMAIL] : []);
  const roleDisplay = ROLES_DISPLAY[request.requested_role] || request.requested_role;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
        <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">New Account Request</p>
      </div>
      <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
        <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">A new account request has been submitted and is waiting for your approval.</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041;width:140px">Callsign</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de"><strong>${request.callsign}</strong></td></tr>
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Full Name</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">${request.full_name}</td></tr>
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Email</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">${request.email}</td></tr>
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Requested Role</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">${roleDisplay}</td></tr>
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Requested At</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">${new Date(request.requested_at || Date.now()).toLocaleString()}</td></tr>
        </table>
        <p style="color:#6b6b68;font-size:14px;margin:0 0 16px">To approve or deny this request, sign in to the Net Logger and go to <strong>Admin &rarr; Pending Requests</strong>.</p>
        <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Open Net Logger</a>
      </div>
    </div>`;
  targets.forEach(email => sendEmail(email, `Net Logger: Account request from ${request.callsign}`, html));
}

function emailApprovalToUser(user, role) {
  const roleDisplay = ROLES_DISPLAY[role] || role;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
        <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">Account Approved</p>
      </div>
      <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
        <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">Hello ${user.full_name},</p>
        <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">Your account request for the Clay County ARES Net Logger has been <strong style="color:#085041">approved</strong>. Welcome aboard!</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041;width:140px">Callsign</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de"><strong>${user.callsign}</strong></td></tr>
          <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Access Level</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de"><strong>${roleDisplay}</strong></td></tr>
        </table>
        <p style="color:#1a1a18;font-size:14px;margin:0 0 8px">You can now sign in using the callsign and password you registered with.</p>
        <p style="color:#6b6b68;font-size:13px;margin:0 0 20px">If you have any questions about using the system, contact your net control operator.</p>
        <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Sign In to Net Logger</a>
      </div>
      <p style="color:#9b9b98;font-size:12px;margin:12px 0 0;text-align:center">Clay County ARES &bull; <a href="https://clayares.org" style="color:#9b9b98">clayares.org</a></p>
    </div>`;
  sendEmail(user.email, 'Clay ARES Net Logger — Your account has been approved', html);
}

function emailDenialToUser(request) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
        <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">Account Request Update</p>
      </div>
      <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
        <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">Hello ${request.full_name},</p>
        <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">Thank you for your interest in the Clay County ARES Net Logger. After reviewing your request, we are unable to approve an account at this time.</p>
        <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">The Net Logger is a system reserved exclusively for members of Clay County ARES. Access is limited to licensed amateur radio operators who are active members of our organization.</p>
        <p style="color:#1a1a18;font-size:15px;margin:0 0 20px">If you are interested in joining Clay County ARES, we would love to have you. Please visit our website to learn more about membership and how to get involved:</p>
        <a href="https://clayares.org" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Visit clayares.org</a>
        <p style="color:#6b6b68;font-size:13px;margin:20px 0 0">Once you become a member, please reach out to your net control operator who will be happy to set up your account. We look forward to hearing you on the air.</p>
        <p style="color:#1a1a18;font-size:14px;margin:16px 0 0">73,<br><strong>Clay County ARES</strong></p>
      </div>
      <p style="color:#9b9b98;font-size:12px;margin:12px 0 0;text-align:center">Clay County ARES &bull; <a href="https://clayares.org" style="color:#9b9b98">clayares.org</a></p>
    </div>`;
  sendEmail(request.email, 'Clay ARES Net Logger — Regarding your account request', html);
}

// ─── QRZ PROXY ───────────────────────────────────────────────────────────────
app.post('/api/qrz/session', requireAuth, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const url = `https://xmldata.qrz.com/xml/current/?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&agent=NetLogger1.0`;
    const r = await fetch(url);
    const txt = await r.text();
    const keyMatch = txt.match(/<Key>([^<]+)<\/Key>/);
    const errMatch = txt.match(/<Error>([^<]+)<\/Error>/);
    if (keyMatch) res.json({ key: keyMatch[1] });
    else res.status(401).json({ error: errMatch ? errMatch[1] : 'Login failed' });
  } catch(e) { res.status(500).json({ error: 'QRZ connection failed: ' + e.message }); }
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
    const lname = get('name');
    const cls = get('class');
    const lat = parseFloat(get('lat'));
    const lon = parseFloat(get('lon'));
    if (!fname && !lname) {
      const errMatch = txt.match(/<Error>([^<]+)<\/Error>/);
      return res.status(404).json({ error: errMatch ? errMatch[1] : 'Callsign not found' });
    }
    res.json({
      name: [fname, lname].filter(Boolean).join(' '),
      licClass: cls,
      lat: isNaN(lat) ? null : lat,
      lon: isNaN(lon) ? null : lon,
      addr: get('addr1'), city: get('addr2'), state: get('state'), zip: get('zip')
    });
  } catch(e) { res.status(500).json({ error: 'QRZ lookup failed: ' + e.message }); }
});

// ─── WHAT3WORDS PROXY ─────────────────────────────────────────────────────────
app.get('/api/w3w/:lat/:lon', requireAuth, async (req, res) => {
  const { lat, lon } = req.params;
  const apiKey = process.env.W3W_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'W3W_API_KEY not configured' });
  try {
    const url = `https://api.what3words.com/v3/convert-to-3wa?coordinates=${lat},${lon}&language=en&format=json&key=${apiKey}`;
    const r = await fetch(url);
    const data = await r.json();
    if (data.words) res.json({ words: data.words, url: `https://what3words.com/${data.words}` });
    else res.status(404).json({ error: data.error ? data.error.message : 'No result' });
  } catch(e) { res.status(500).json({ error: 'W3W lookup failed: ' + e.message }); }
});

// ─── PUBLIC: ACCOUNT REQUEST ──────────────────────────────────────────────────
app.get('/api/users/list', (req, res) => {
  const users = queries.getAllUsers.all();
  res.json(users.map(u => ({ id: u.id, callsign: u.callsign, role: u.role })));
});

app.post('/api/request-account', async (req, res) => {
  const { callsign, full_name, email, requested_role, password } = req.body;
  if (!callsign || !full_name || !email || !requested_role || !password)
    return res.status(400).json({ error: 'All fields are required' });
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(requested_role))
    return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = queries.getUserByCallsign.get(callsign);
  if (existing) return res.status(409).json({ error: 'An account with that callsign already exists' });
  const pendingExisting = queries.getRequestByCallsign.get(callsign);
  if (pendingExisting) return res.status(409).json({ error: 'A pending request for that callsign already exists' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = queries.createRequest.run(callsign.toUpperCase(), full_name, email, requested_role, hash);
    const request = queries.getRequestById.get(result.lastInsertRowid);
    emailNewRequestToAdmin({ ...request, requested_at: new Date().toISOString() });
    res.json({ ok: true, message: 'Your request has been submitted. You will receive an email when it is reviewed.' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
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

app.post('/api/auth/logout', (req, res) => { req.session.destroy(); res.json({ ok: true }); });

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json({ authenticated: false });
  res.json({ authenticated: true, callsign: req.session.callsign, role: req.session.role });
});

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────
app.get('/api/users', requireRole('netcontrol'), (req, res) => {
  res.json(queries.getAllUsers.all());
});

app.post('/api/users', requireRole('netcontrol'), (req, res) => {
  const { callsign, password, role, email, full_name } = req.body;
  if (!callsign || !password || !role) return res.status(400).json({ error: 'Callsign, password, and role required' });
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = queries.createUser.run(callsign.toUpperCase(), hash, role, email || null, full_name || null);
    res.json({ id: result.lastInsertRowid, callsign: callsign.toUpperCase(), role });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Callsign already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/users/:id/password', requireRole('netcontrol'), (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  queries.updateUserPassword.run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/role', requireRole('netcontrol'), (req, res) => {
  const { role } = req.body;
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  queries.updateUserRole.run(role, req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/email', requireRole('netcontrol'), (req, res) => {
  const { email } = req.body;
  queries.updateUserEmail.run(email || null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireRole('netcontrol'), (req, res) => {
  if (parseInt(req.params.id) === req.session.userId)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  queries.deleteUser.run(req.params.id);
  res.json({ ok: true });
});

// ─── PENDING REQUESTS ─────────────────────────────────────────────────────────
app.get('/api/admin/requests', requireRole('netcontrol'), (req, res) => {
  res.json(queries.getPendingRequests.all());
});

app.post('/api/admin/requests/:id/approve', requireRole('netcontrol'), (req, res) => {
  const request = queries.getRequestById.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  const { role } = req.body;
  const finalRole = role || request.requested_role;
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(finalRole)) return res.status(400).json({ error: 'Invalid role' });
  try {
    queries.createUser.run(request.callsign, request.password_hash, finalRole, request.email, request.full_name);
    queries.updateRequestStatus.run('approved', request.id);
    emailApprovalToUser({ callsign: request.callsign, full_name: request.full_name, email: request.email }, finalRole);
    res.json({ ok: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Callsign already exists as a user' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/requests/:id/deny', requireRole('netcontrol'), (req, res) => {
  const request = queries.getRequestById.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  queries.updateRequestStatus.run('denied', request.id);
  emailDenialToUser(request);
  res.json({ ok: true });
});

// ─── NET SESSIONS ─────────────────────────────────────────────────────────────
app.get('/api/session/current', requireAuth, (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.json({ active: false });
  res.json({ active: true, session, checkins: getFullCheckins(session.id) });
});

app.post('/api/session/open', requireRole('netcontrol'), (req, res) => {
  const existing = queries.getOpenSession.get();
  if (existing) return res.status(409).json({ error: 'A net session is already open' });
  const { net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign } = req.body;
  if (!net_name) return res.status(400).json({ error: 'Net name required' });
  const result = queries.createSession.run(net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, req.session.userId);
  res.json({ session: queries.getSessionById.get(result.lastInsertRowid), checkins: [] });
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

// ─── CHECKINS ─────────────────────────────────────────────────────────────────
app.post('/api/checkin', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open net session' });
  const { callsign, name, license_class, time_in, has_comments, comment_count, comment_notes,
          has_traffic, lat, lon, usng, w3w, address, traffic } = req.body;
  if (!callsign) return res.status(400).json({ error: 'Callsign required' });
  const { next_seq } = queries.getNextSeq.get(session.id);
  const result = queries.insertCheckin.run(
    session.id, next_seq, callsign.toUpperCase(), name || '', license_class || '',
    time_in || '', has_comments ? 1 : 0, comment_count || 0, comment_notes || '',
    has_traffic ? 1 : 0, lat || null, lon || null, usng || null, w3w || null, address || '',
    req.session.userId
  );
  if (has_traffic && Array.isArray(traffic))
    traffic.forEach(t => queries.insertTraffic.run(result.lastInsertRowid, t.precedence, t.type, t.to, t.passed ? 1 : 0));
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
  queries.updateTrafficPassed.run(req.body.passed ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Net Logger running on port ${PORT}`));
