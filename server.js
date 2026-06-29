const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { db, queries, schedQueries, resetQueries, settingsQueries, getFullCheckins } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const activeUsers = new Map(); // userId -> { callsign, role, lastSeen }
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
app.get('/api/w3w', requireAuth, async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ error: 'lat and lon required' });
  const apiKey = process.env.W3W_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'W3W_API_KEY not configured' });
  try {
    const url = 'https://api.what3words.com/v3/convert-to-3wa?coordinates=' + lat + ',' + lon + '&language=en&format=json&key=' + apiKey;
    const r = await fetch(url);
    const data = await r.json();
    if (data.words) res.json({ words: data.words, url: 'https://what3words.com/' + data.words });
    else res.status(404).json({ error: data.error ? (data.error.message || data.error.code) : 'No result' });
  } catch(e) {
    res.status(500).json({ error: 'W3W lookup failed: ' + e.message });
  }
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

// ─── PASSWORD RESET ────────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { callsign } = req.body;
  // Always respond success regardless of whether the callsign exists, so we don't leak account existence
  const genericResponse = { ok: true, message: 'If that callsign has an account with an email on file, a reset link has been sent.' };
  if (!callsign) return res.json(genericResponse);
  const user = queries.getUserByCallsign.get(callsign);
  if (!user || !user.email) return res.json(genericResponse);

  resetQueries.invalidateUserResets.run(user.id);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  resetQueries.createReset.run(user.id, token, expiresAt);

  const resetUrl = APP_URL + '/reset-password.html?token=' + token;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
        <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">Password Reset Requested</p>
      </div>
      <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
        <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">Hello ${user.full_name || user.callsign},</p>
        <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">A password reset was requested for the callsign <strong>${user.callsign}</strong>. Click the button below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Reset Password</a>
        <p style="color:#6b6b68;font-size:13px;margin:20px 0 0">If you did not request this, you can safely ignore this email — your password will not be changed.</p>
      </div>
    </div>`;
  await sendEmail(user.email, 'Clay ARES Net Logger — Reset your password', html);
  res.json(genericResponse);
});

app.get('/api/auth/reset-password/:token', (req, res) => {
  const reset = resetQueries.getResetByToken.get(req.params.token);
  if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  const user = queries.getUserById.get(reset.user_id);
  res.json({ valid: true, callsign: user ? user.callsign : null });
});

app.post('/api/auth/reset-password/:token', (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const reset = resetQueries.getResetByToken.get(req.params.token);
  if (!reset || reset.used || new Date(reset.expires_at) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  const hash = bcrypt.hashSync(password, 10);
  queries.updateUserPassword.run(hash, reset.user_id);
  resetQueries.markResetUsed.run(reset.id);
  res.json({ ok: true });
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

// Admin flag is separate from role - marks recipients of system-level notifications
app.put('/api/users/:id/admin-flag', requireRole('netcontrol'), (req, res) => {
  const { is_admin } = req.body;
  queries.updateUserAdminFlag.run(is_admin ? 1 : 0, req.params.id);
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
  const { net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, incident_name, activation_type } = req.body;
  if (!net_name) return res.status(400).json({ error: 'Net name required' });
  const result = queries.createSession.run(net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, req.session.userId);
  const sid = result.lastInsertRowid;
  if (incident_name) db.prepare('UPDATE net_sessions SET incident_name = ? WHERE id = ?').run(incident_name, sid);
  if (activation_type) db.prepare('UPDATE net_sessions SET activation_type = ? WHERE id = ?').run(activation_type, sid);
  res.json({ session: queries.getSessionById.get(sid), checkins: [] });
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
          has_traffic, lat, lon, usng, w3w, address, tactical_call, traffic } = req.body;
  if (!callsign) return res.status(400).json({ error: 'Callsign required' });
  const { next_seq } = queries.getNextSeq.get(session.id);
  const result = queries.insertCheckin.run(
    session.id, next_seq, callsign.toUpperCase(), name || '', license_class || '',
    time_in || '', has_comments ? 1 : 0, comment_count || 0, comment_notes || '',
    has_traffic ? 1 : 0, lat || null, lon || null, usng || null, w3w || null, address || '',
    tactical_call || null, req.session.userId
  );
  if (has_traffic && Array.isArray(traffic))
    traffic.forEach(t => queries.insertTraffic.run(
      result.lastInsertRowid, t.precedence, t.type, t.to, t.passed ? 1 : 0,
      t.msg_number || null, t.from_callsign || null, t.description || null,
      t.time_sent || null, t.time_received || null
    ));
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

// Add traffic to an already checked-in station
app.post('/api/checkin/:id/traffic', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  const ci = queries.getCheckinById.get(req.params.id);
  if (!ci || ci.session_id !== session.id) return res.status(404).json({ error: 'Check-in not found' });
  const { precedence, type, deliver_to, passed, msg_number, from_callsign, description, time_sent, time_received } = req.body;
  const result = queries.insertTraffic.run(
    ci.id, precedence || 'Routine', type || 'Formal', deliver_to || '', passed ? 1 : 0,
    msg_number || null, from_callsign || null, description || null,
    time_sent || null, time_received || null
  );
  db.prepare('UPDATE checkins SET has_traffic = 1 WHERE id = ?').run(ci.id);
  res.json(db.prepare('SELECT * FROM traffic WHERE id = ?').get(result.lastInsertRowid));
});

// Check out / relieve a station
app.post('/api/checkin/:id/checkout', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  const { time_out } = req.body;
  queries.checkoutCheckin.run(time_out || null, req.params.id);
  res.json({ ok: true });
});

// HEARTBEAT - called by each browser every 30s to register as active
app.post('/api/heartbeat', requireAuth, (req, res) => {
  activeUsers.set(req.session.userId, {
    callsign: req.session.callsign,
    role: req.session.role,
    lastSeen: Date.now()
  });
  res.json({ ok: true });
});

// STATUS BOARD - serves the status board page and data
app.get('/status-board.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'status-board.html'));
});

app.get('/api/status-board', requireAuth, (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.json({ active: false });
  const checkins = getFullCheckins(session.id);
  
  // Build pending announcements list
  const pendingAnnouncements = [];
  checkins.forEach(ci => {
    if (ci.has_comments && ci.comment_count > 0) {
      const givenCount = ci.announcements_given || 0;
      const remaining = ci.comment_count - givenCount;
      if (remaining > 0) {
        pendingAnnouncements.push({
          checkin_id: ci.id,
          callsign: ci.callsign,
          name: ci.name,
          count: ci.comment_count,
          given: givenCount,
          remaining,
          notes: ci.comment_notes
        });
      }
    }
  });

  // Build pending traffic list grouped by precedence
  const allTraffic = [];
  checkins.forEach(ci => {
    (ci.traffic || []).forEach(t => {
      allTraffic.push({
        id: t.id,
        checkin_id: ci.id,
        callsign: ci.callsign,
        name: ci.name,
        precedence: t.precedence,
        type: t.type,
        deliver_to: t.deliver_to,
        passed: t.passed
      });
    });
  });

  const pendingTraffic = allTraffic.filter(t => !t.passed);
  const passedTraffic = allTraffic.filter(t => t.passed);

  // Counts by precedence
  const trafficCounts = {};
  ['Emergency','Priority','Welfare','Routine'].forEach(p => {
    trafficCounts[p] = {
      total: allTraffic.filter(t => t.precedence === p).length,
      pending: pendingTraffic.filter(t => t.precedence === p).length,
      passed: passedTraffic.filter(t => t.precedence === p).length
    };
  });

  // Active users — anyone who sent a heartbeat in the last 90 seconds
  const now = Date.now();
  const onlineUsers = Array.from(activeUsers.values())
    .filter(u => now - u.lastSeen < 90000)
    .sort((a, b) => a.callsign.localeCompare(b.callsign));

  // Build tactical assignments map (tactical_call → station info)
  const tacticalAssignments = [];
  checkins.forEach(ci => {
    if (ci.tactical_call) {
      tacticalAssignments.push({
        tactical_call: ci.tactical_call,
        callsign: ci.callsign,
        name: ci.name,
        time_in: ci.time_in,
        checkin_id: ci.id
      });
    }
  });

  // Open issues
  const openIssues = queries.getIssuesBySession.all(session.id).filter(i => i.status === 'open');

  res.json({
    active: true,
    session,
    checkins_total: checkins.length,
    announcements_total: checkins.reduce((sum, ci) => sum + (ci.has_comments ? ci.comment_count : 0), 0),
    announcements_pending: pendingAnnouncements,
    traffic_counts: trafficCounts,
    pending_traffic: pendingTraffic,
    opened_at: session.opened_at,
    online_users: onlineUsers,
    tactical_assignments: tacticalAssignments,
    open_issues: openIssues
  });
});

// Mark announcement as given
app.post('/api/checkin/:id/announcement-given', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  try {
    db.prepare('UPDATE checkins SET announcements_given = COALESCE(announcements_given, 0) + 1 WHERE id = ? AND session_id = ?').run(req.params.id, session.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TACTICAL POSITIONS ───────────────────────────────────────────────────────
app.get('/api/positions', requireAuth, (req, res) => {
  res.json(queries.getPositions.all());
});

app.post('/api/positions', requireRole('netcontrol'), (req, res) => {
  const { name, description, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = queries.insertPosition.run(name.trim(), description || null, sort_order || 0);
  res.json({ id: result.lastInsertRowid, name: name.trim(), description: description || null, sort_order: sort_order || 0 });
});

app.delete('/api/positions/:id', requireRole('netcontrol'), (req, res) => {
  queries.deletePosition.run(req.params.id);
  res.json({ ok: true });
});

// ─── POSITION PRESETS ─────────────────────────────────────────────────────────
app.get('/api/presets', requireAuth, (req, res) => {
  res.json(queries.getPresets.all());
});

app.get('/api/presets/by-type/:type', requireAuth, (req, res) => {
  res.json(queries.getPresetsByType.all(req.params.type));
});

app.post('/api/presets', requireRole('netcontrol'), (req, res) => {
  const { name, event_type, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = queries.insertPreset.run(name.trim(), event_type || null, description || null);
  res.json({ id: result.lastInsertRowid, name: name.trim(), event_type: event_type || null, description: description || null });
});

app.delete('/api/presets/:id', requireRole('netcontrol'), (req, res) => {
  queries.deletePreset.run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/presets/:id/positions', requireAuth, (req, res) => {
  res.json(queries.getPresetPositions.all(req.params.id));
});

app.post('/api/presets/:id/positions', requireRole('netcontrol'), (req, res) => {
  const { name, description, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const result = queries.insertPresetPosition.run(req.params.id, name.trim(), description || null, sort_order || 0);
  res.json({ id: result.lastInsertRowid, preset_id: parseInt(req.params.id), name: name.trim(), description: description || null });
});

app.delete('/api/presets/:id/positions/:posId', requireRole('netcontrol'), (req, res) => {
  queries.deletePresetPosition.run(req.params.posId);
  res.json({ ok: true });
});

// ─── ISSUES ───────────────────────────────────────────────────────────────────
app.get('/api/session/issues', requireAuth, (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.json([]);
  res.json(queries.getIssuesBySession.all(session.id));
});

app.get('/api/session/:id/issues', requireAuth, (req, res) => {
  res.json(queries.getIssuesBySession.all(req.params.id));
});

app.post('/api/issues', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = queries.getOpenSession.get();
  if (!session) return res.status(404).json({ error: 'No open session' });
  const { description, priority } = req.body;
  if (!description) return res.status(400).json({ error: 'Description required' });
  const validPriorities = ['low', 'normal', 'high', 'critical'];
  const result = queries.insertIssue.run(
    session.id, description.trim(), validPriorities.includes(priority) ? priority : 'normal',
    req.session.userId
  );
  res.json(db.prepare('SELECT * FROM issues WHERE id = ?').get(result.lastInsertRowid));
});

app.put('/api/issues/:id/resolve', requireRole('netcontrol', 'backup'), (req, res) => {
  queries.resolveIssue.run('resolved', req.session.userId, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/issues/:id', requireRole('netcontrol'), (req, res) => {
  queries.deleteIssue.run(req.params.id);
  res.json({ ok: true });
});

// ─── SESSION OPEN WITH INCIDENT INFO ─────────────────────────────────────────
// (Override to accept incident_name, activation_type)
// Already handled by existing /api/session/open endpoint - extend via migration

// ─── ICS 309 EXPORT ───────────────────────────────────────────────────────────
app.get('/api/session/:id/ics309.csv', requireAuth, (req, res) => {
  const session = queries.getSessionById.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const checkins = getFullCheckins(req.params.id);
  const issues = queries.getIssuesBySession.all(req.params.id);

  const esc = v => '"' + String(v || '').replace(/"/g, '""') + '"';

  const lines = [];
  lines.push(['ICS 309 COMMUNICATIONS LOG'].map(esc).join(','));
  lines.push(['Incident Name', session.incident_name || session.net_name].map(esc).join(','));
  lines.push(['Activation Type', session.activation_type || 'Net'].map(esc).join(','));
  lines.push(['Operational Period Start', session.opened_at || ''].map(esc).join(','));
  lines.push(['Operational Period End', session.closed_at || 'ONGOING'].map(esc).join(','));
  lines.push(['Net Control', session.nc_callsign || ''].map(esc).join(','));
  lines.push(['Backup Net Control', session.bnc_callsign || ''].map(esc).join(','));
  lines.push(['Frequency', (session.frequency || '') + ' ' + (session.mode || '')].map(esc).join(','));
  lines.push([]);
  lines.push(['Time', 'From', 'To', 'Subject / Message', 'Tactical Call', 'Msg #', 'Precedence', 'Passed'].map(esc).join(','));

  // Build log entries sorted by time
  const entries = [];
  checkins.forEach(ci => {
    entries.push({
      time: ci.time_in || '',
      from: ci.callsign,
      to: session.nc_callsign || 'NCS',
      subject: 'CHECK-IN' + (ci.tactical_call ? ' [' + ci.tactical_call + ']' : '') + (ci.name ? ' · ' + ci.name : '') + (ci.time_out ? ' → CHECKED OUT ' + ci.time_out : ''),
      tactical: ci.tactical_call || '',
      msgNum: '',
      prec: '',
      passed: ''
    });
    (ci.traffic || []).forEach(t => {
      entries.push({
        time: t.time_sent || ci.time_in || '',
        from: t.from_callsign || ci.callsign,
        to: t.deliver_to || '',
        subject: t.description || (t.type + ' traffic'),
        tactical: ci.tactical_call || '',
        msgNum: t.msg_number || '',
        prec: t.precedence || '',
        passed: t.passed ? 'YES' : 'NO'
      });
    });
  });

  entries.forEach(e => {
    lines.push([e.time, e.from, e.to, e.subject, e.tactical, e.msgNum, e.prec, e.passed].map(esc).join(','));
  });

  if (issues.length) {
    lines.push([]);
    lines.push(['ISSUES LOG'].map(esc).join(','));
    lines.push(['Time', 'Priority', 'Status', 'Description', 'Logged By'].map(esc).join(','));
    issues.forEach(i => {
      lines.push([i.created_at, i.priority, i.status, i.description, i.created_by_callsign].map(esc).join(','));
    });
  }

  const filename = (session.incident_name || session.net_name || 'net').replace(/\s+/g, '-') + '-ICS309-' + (session.net_date || 'log') + '.csv';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// Printable ICS 309 page
app.get('/ics309/:id', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ics309.html'));
});

// Session history with issues count
app.get('/api/session/history-full', requireAuth, (req, res) => {
  const sessions = queries.getRecentSessions.all();
  const result = sessions.map(s => {
    const openCount = queries.getOpenIssueCount.get(s.id);
    return { ...s, open_issues: openCount ? openCount.cnt : 0 };
  });
  res.json(result);
});

// PREAMBLES
app.get('/preamble-viewer.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'preamble-viewer.html'));
});

app.get('/api/preambles', requireAuth, (req, res) => {
  res.json(queries.getAllPreambles.all());
});

app.get('/api/preambles/:type', requireAuth, (req, res) => {
  const p = queries.getPreambleByType.get(req.params.type);
  if (!p) return res.status(404).json({ error: 'Preamble not found' });
  res.json(p);
});

app.put('/api/preambles/:type', requireAuth, (req, res) => {
  // Only KK4ECR can edit preambles
  if (req.session.callsign !== 'KK4ECR') {
    return res.status(403).json({ error: 'Only KK4ECR can edit preambles' });
  }
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required' });
  const existing = queries.getPreambleByType.get(req.params.type);
  if (!existing) return res.status(404).json({ error: 'Preamble not found' });
  queries.updatePreamble.run(title, content, req.session.callsign, req.params.type);
  res.json({ ok: true });
});

// ─── SCHEDULING ────────────────────────────────────────────────────────────────
const SCHED_POSITIONS = ['Net Control', 'Backup Net Control', 'Traffic Rep', 'Net Logger'];

function isHolidayBlocked(dateStr) {
  // Friday before through Monday after the given Sunday date
  const d = new Date(dateStr + 'T00:00:00');
  const friBefore = new Date(d); friBefore.setDate(d.getDate() - 2);
  const monAfter = new Date(d); monAfter.setDate(d.getDate() + 1);
  const fmt = x => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  const holidays = schedQueries.getHolidaysInRange.all(fmt(friBefore), fmt(monAfter));
  return holidays.length > 0 ? holidays[0] : null;
}

function getUpcomingSundays(monthsAhead) {
  const sundays = [];
  const today = new Date();
  let d = new Date(today);
  // move to next Sunday (or today if today is Sunday)
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  const endDate = new Date(today);
  endDate.setMonth(endDate.getMonth() + monthsAhead);
  while (d <= endDate) {
    const fmt = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    sundays.push(fmt);
    d.setDate(d.getDate() + 7);
  }
  return sundays;
}

// Get the schedule for the next N months, auto-creating scheduled_net rows as needed
app.get('/api/schedule', requireAuth, (req, res) => {
  const months = Math.min(parseInt(req.query.months) || 6, 6);
  const sundays = getUpcomingSundays(months);
  const result = sundays.map(dateStr => {
    let net = schedQueries.getScheduledNetByDate.get(dateStr);
    if (!net) {
      const holiday = isHolidayBlocked(dateStr);
      const status = holiday ? 'skipped' : 'scheduled';
      schedQueries.upsertScheduledNet.run(dateStr, status);
      net = schedQueries.getScheduledNetByDate.get(dateStr);
      if (holiday) {
        schedQueries.setNetStatus.run('skipped', holiday.name, 0, dateStr);
        net = schedQueries.getScheduledNetByDate.get(dateStr);
      }
    }
    const signups = schedQueries.getSignupsByNet.all(net.id);
    const positions = {};
    SCHED_POSITIONS.forEach(pos => {
      const s = signups.find(s => s.position === pos);
      positions[pos] = s ? { signup_id: s.id, callsign: s.callsign, full_name: s.full_name, user_id: s.user_id } : null;
    });
    return { id: net.id, net_date: net.net_date, status: net.status, skip_reason: net.skip_reason, overridden_by_admin: net.overridden_by_admin, positions };
  });
  res.json(result);
});

// Admin override: force a net to run despite holiday, or force-skip a net
app.put('/api/schedule/:date/status', requireRole('netcontrol'), (req, res) => {
  const { status, skip_reason } = req.body;
  const validStatuses = ['scheduled', 'skipped'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  let net = schedQueries.getScheduledNetByDate.get(req.params.date);
  if (!net) {
    schedQueries.upsertScheduledNet.run(req.params.date, status);
  }
  schedQueries.setNetStatus.run(status, skip_reason || null, 1, req.params.date);
  res.json({ ok: true });
});

// Sign up for a position
app.post('/api/schedule/:date/signup', requireAuth, (req, res) => {
  const { position } = req.body;
  if (!SCHED_POSITIONS.includes(position)) return res.status(400).json({ error: 'Invalid position' });
  let net = schedQueries.getScheduledNetByDate.get(req.params.date);
  if (!net) {
    const holiday = isHolidayBlocked(req.params.date);
    schedQueries.upsertScheduledNet.run(req.params.date, holiday ? 'skipped' : 'scheduled');
    net = schedQueries.getScheduledNetByDate.get(req.params.date);
  }
  if (net.status === 'skipped') return res.status(409).json({ error: 'No net scheduled on this date' + (net.skip_reason ? ' (' + net.skip_reason + ')' : '') });
  const existing = schedQueries.getSignupByNetAndPosition.get(net.id, position);
  if (existing) return res.status(409).json({ error: 'That position is already filled for this date' });
  try {
    schedQueries.insertSignup.run(net.id, position, req.session.userId);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel a signup - the signed-up user themselves, or any netcontrol/admin
app.delete('/api/schedule/signup/:id', requireAuth, (req, res) => {
  const signup = schedQueries.getSignupById.get(req.params.id);
  if (!signup) return res.status(404).json({ error: 'Signup not found' });
  if (signup.user_id !== req.session.userId && req.session.role !== 'netcontrol') {
    return res.status(403).json({ error: 'You can only cancel your own signup' });
  }
  schedQueries.deleteSignup.run(req.params.id);
  res.json({ ok: true });
});

// Net Control / admin can directly remove anyone from a slot, or assign by callsign
app.post('/api/schedule/:date/assign', requireRole('netcontrol'), (req, res) => {
  const { position, callsign } = req.body;
  if (!SCHED_POSITIONS.includes(position)) return res.status(400).json({ error: 'Invalid position' });
  let net = schedQueries.getScheduledNetByDate.get(req.params.date);
  if (!net) {
    schedQueries.upsertScheduledNet.run(req.params.date, 'scheduled');
    net = schedQueries.getScheduledNetByDate.get(req.params.date);
  }
  const existing = schedQueries.getSignupByNetAndPosition.get(net.id, position);
  if (existing) schedQueries.deleteSignup.run(existing.id);
  if (!callsign) return res.json({ ok: true }); // just clearing the slot
  const user = queries.getUserByCallsign.get(callsign);
  if (!user) return res.status(404).json({ error: 'No account found for that callsign' });
  schedQueries.insertSignup.run(net.id, position, user.id);
  res.json({ ok: true });
});

app.get('/api/schedule/holidays', requireAuth, (req, res) => {
  res.json(schedQueries.getAllHolidays.all());
});

app.get('/api/schedule/my-signups', requireAuth, (req, res) => {
  res.json(schedQueries.getSignupsByUser.all(req.session.userId));
});

// Manual all-members blast for an unfilled position
app.post('/api/schedule/:date/notify-unfilled', requireRole('netcontrol'), async (req, res) => {
  const net = schedQueries.getScheduledNetByDate.get(req.params.date);
  if (!net) return res.status(404).json({ error: 'No scheduled net on that date' });
  const signups = schedQueries.getSignupsByNet.all(net.id);
  const filled = signups.map(s => s.position);
  const unfilled = SCHED_POSITIONS.filter(p => !filled.includes(p));
  if (!unfilled.length) return res.json({ ok: true, message: 'All positions filled' });
  const allUsers = queries.getAllUsers.all().filter(u => u.email);
  const dateDisplay = new Date(req.params.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:#BA7517;padding:20px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
        <p style="color:#fde8c8;margin:4px 0 0;font-size:14px">Open Net Positions</p>
      </div>
      <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
        <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">The following positions are still open for the net on <strong>${dateDisplay}</strong>:</p>
        <ul style="color:#1a1a18;font-size:15px">${unfilled.map(p => '<li>' + p + '</li>').join('')}</ul>
        <p style="color:#1a1a18;font-size:14px;margin:16px 0">Sign in to the Net Logger and visit the Schedule tab to sign up.</p>
        <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Open Net Logger</a>
      </div>
    </div>`;
  allUsers.forEach(u => sendEmail(u.email, 'Clay ARES Net Logger — Open positions for ' + dateDisplay, html));
  res.json({ ok: true, sentTo: allUsers.length, unfilled });
});

// ─── REMINDER EMAIL CRON (checked every 5 minutes) ────────────────────────────
async function checkAndSendReminders() {
  try {
    const upcoming = schedQueries.getSignupsNeedingReminder.all();
    const now = new Date();
    for (const s of upcoming) {
      const netDateTime = new Date(s.net_date + 'T19:30:00-05:00'); // 19:30 Eastern
      const hoursUntil = (netDateTime - now) / (1000 * 60 * 60);
      const dateDisplay = new Date(s.net_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      if (hoursUntil <= 24 && hoursUntil > 23 && !s.reminder_24h_sent) {
        await sendEmail(s.email, 'Reminder: You are signed up for ' + s.position + ' this Sunday', `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
            <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1><p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">24 Hour Reminder</p></div>
            <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
              <p style="font-size:15px;color:#1a1a18">Hi ${s.full_name || s.callsign},</p>
              <p style="font-size:15px;color:#1a1a18">This is a reminder that you are signed up as <strong>${s.position}</strong> for the Clay County ARES net on <strong>${dateDisplay} at 7:30 PM</strong>.</p>
            </div>
          </div>`);
        schedQueries.markReminderSent.run(1, s.reminder_1h_sent, s.id);
      } else if (hoursUntil <= 1 && hoursUntil > 0 && !s.reminder_1h_sent) {
        await sendEmail(s.email, 'Starting soon: ' + s.position + ' net in 1 hour', `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
            <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1><p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">1 Hour Reminder</p></div>
            <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
              <p style="font-size:15px;color:#1a1a18">Hi ${s.full_name || s.callsign},</p>
              <p style="font-size:15px;color:#1a1a18">The net starts in about 1 hour. You are signed up as <strong>${s.position}</strong> tonight at <strong>7:30 PM</strong>.</p>
            </div>
          </div>`);
        schedQueries.markReminderSent.run(s.reminder_24h_sent, 1, s.id);
      }
    }
  } catch(e) {
    console.error('Reminder check error:', e.message);
  }
}
setInterval(checkAndSendReminders, 5 * 60 * 1000);
checkAndSendReminders();

// ─── MONTHLY SCHEDULE AUTO-EXTEND ──────────────────────────────────────────────
// Ensures the schedule window keeps rolling forward. On the 1st of each month,
// extends the populated schedule by one additional month and emails admins.
function currentMonthKey() {
  const now = new Date();
  return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
}

async function checkMonthlyScheduleExtend() {
  try {
    const now = new Date();
    if (now.getDate() !== 1) return; // only run on the 1st

    const key = 'schedule_last_extended_month';
    const lastRun = settingsQueries.get.get(key);
    const thisMonth = currentMonthKey();
    if (lastRun && lastRun.value === thisMonth) return; // already extended this month

    // Populate one additional month beyond the current 6-month window (i.e. month 7)
    const sundays = getUpcomingSundays(7).filter(d => {
      const monthsOut = (new Date(d) - now) / (1000 * 60 * 60 * 24 * 30);
      return monthsOut > 5.5; // only the newly-extended slice
    });

    const newlyAdded = [];
    sundays.forEach(dateStr => {
      const existing = schedQueries.getScheduledNetByDate.get(dateStr);
      if (!existing) {
        const holiday = isHolidayBlocked(dateStr);
        schedQueries.upsertScheduledNet.run(dateStr, holiday ? 'skipped' : 'scheduled');
        if (holiday) schedQueries.setNetStatus.run('skipped', holiday.name, 0, dateStr);
        newlyAdded.push({ date: dateStr, skipped: !!holiday, reason: holiday ? holiday.name : null });
      }
    });

    settingsQueries.set.run(key, thisMonth);

    if (newlyAdded.length) {
      const adminEmails = queries.getSystemAdminEmails.all().map(r => r.email);
      if (adminEmails.length) {
        const rows = newlyAdded.map(n => {
          const d = new Date(n.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
          return '<li>' + d + (n.skipped ? ' — skipped (' + n.reason + ')' : '') + '</li>';
        }).join('');
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
            <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
              <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
              <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">Schedule Auto-Extended</p>
            </div>
            <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
              <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">The net schedule has automatically been extended by one month. The following new dates were added:</p>
              <ul style="color:#1a1a18;font-size:15px">${rows}</ul>
              <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;margin-top:8px">View Schedule</a>
            </div>
          </div>`;
        adminEmails.forEach(email => sendEmail(email, 'Clay ARES Net Logger — Schedule extended with ' + newlyAdded.length + ' new date(s)', html));
      }
      console.log('Monthly schedule extend: added', newlyAdded.length, 'new date(s)');
    }
  } catch(e) {
    console.error('Monthly schedule extend error:', e.message);
  }
}
// Check once an hour - cheap, and catches the 1st of the month reliably regardless of server uptime
setInterval(checkMonthlyScheduleExtend, 60 * 60 * 1000);
checkMonthlyScheduleExtend();

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Net Logger running on port ${PORT}`));
