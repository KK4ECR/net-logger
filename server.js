const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
const fetch = require('node-fetch');
const crypto = require('crypto');
const { db, queries, schedQueries, resetQueries, settingsQueries, getFullCheckins, setUserPositions } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const activeUsers = new Map(); // userId -> { callsign, role, lastSeen }
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const APP_URL = process.env.APP_URL || 'https://your-app.railway.app';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER || '';

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

// App-admin access (user management, account requests) - granted to the netcontrol
// role OR anyone flagged is_admin. This is separate from net-day operational
// permissions (open/close net, checkins, etc.), which stay gated on role alone.
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  if (req.session.role !== 'netcontrol' && !req.session.isAdmin) return res.status(403).json({ error: 'Insufficient permissions' });
  next();
}

// Net-duty positions a member can be approved for - used to restrict schedule
// signups and to show quick-assign badges at check-in.
const SCHED_POSITIONS = ['Net Control', 'Backup Net Control', 'Traffic Rep', 'Net Logger'];

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

// Same as sendEmail but supports a PDF (or other file) attachment, base64-encoded
async function sendEmailWithAttachment(to, subject, html, attachment) {
  if (!RESEND_API_KEY) { console.log('RESEND_API_KEY not set, skipping email with attachment to', to); return { ok: false, error: 'Email not configured' }; }
  try {
    const body = { from: 'Clay ARES Net Logger <noreply@resend.dev>', to: [to], subject, html };
    if (attachment) {
      body.attachments = [{ filename: attachment.filename, content: attachment.base64 }];
    }
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) { console.error('Resend error:', data); return { ok: false, error: data.message || 'Send failed' }; }
    console.log('Email with attachment sent to', to, '- id:', data.id);
    return { ok: true };
  } catch(e) {
    console.error('Email with attachment send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ─── SMS (TWILIO) ──────────────────────────────────────────────────────────────
// Optional, same pattern as email: no-ops with a log line if not configured, so
// the feature works the moment TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/
// TWILIO_FROM_NUMBER are set on Railway, without any code changes.
async function sendSMS(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.log('Twilio not configured, skipping SMS to', to);
    return;
  }
  try {
    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const params = new URLSearchParams({ To: to, From: TWILIO_FROM_NUMBER, Body: body });
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) console.error('Twilio SMS error for', to, ':', data.message || r.status);
    else console.log('SMS sent to', to, '- sid:', data.sid);
  } catch(e) { console.error('SMS send failed:', e.message); }
}

// Fan out to every member who has both a phone number on file and SMS alerts enabled.
function sendSmsToOptedInMembers(body) {
  const recipients = queries.getSmsRecipients.all();
  recipients.forEach(r => sendSMS(r.phone, body));
}

const URGENT_ACTIVATION_TYPES = ['Storm Activation', 'Emergency Activation'];

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

// ─── NWS WEATHER ALERTS ────────────────────────────────────────────────────────
// Not tied to any particular net session - shown on every Status Board regardless
// of which net is being viewed, since weather doesn't respect net boundaries.
const CLAY_COUNTY_FL_POINT = '29.9925,-81.6773'; // Green Cove Springs, FL (county seat)
app.get('/api/weather-alerts', requireAuth, async (req, res) => {
  try {
    const r = await fetch(`https://api.weather.gov/alerts/active?point=${CLAY_COUNTY_FL_POINT}`, {
      headers: { 'User-Agent': 'ClayARESNetLogger (https://github.com/KK4ECR/net-logger)', 'Accept': 'application/geo+json' }
    });
    if (!r.ok) return res.status(502).json({ error: 'NWS API returned ' + r.status, alerts: [] });
    const data = await r.json();
    const alerts = (data.features || []).map(f => ({
      id: f.id,
      event: f.properties.event,
      severity: f.properties.severity,
      urgency: f.properties.urgency,
      headline: f.properties.headline,
      description: f.properties.description,
      areaDesc: f.properties.areaDesc,
      effective: f.properties.effective,
      expires: f.properties.expires,
      senderName: f.properties.senderName
    }));
    res.json({ alerts });
  } catch(e) {
    console.error('weather-alerts error:', e.message);
    res.status(500).json({ error: 'Could not fetch weather alerts', alerts: [] });
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
  req.session.isAdmin = !!user.is_admin;
  const positions = queries.getPositionsByUser.all(user.id).map(p => p.position);
  res.json({ callsign: user.callsign, role: user.role, isAdmin: !!user.is_admin, positions });
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
  const positions = queries.getPositionsByUser.all(req.session.userId).map(p => p.position);
  res.json({ authenticated: true, callsign: req.session.callsign, role: req.session.role, isAdmin: !!req.session.isAdmin, positions });
});

// ─── USER MANAGEMENT ──────────────────────────────────────────────────────────
app.get('/api/users', requireAdmin, (req, res) => {
  const users = queries.getAllUsers.all();
  const byUser = {};
  queries.getAllUserPositions.all().forEach(p => { (byUser[p.user_id] = byUser[p.user_id] || []).push(p.position); });
  res.json(users.map(u => ({ ...u, positions: byUser[u.id] || [] })));
});

// Positions approved for each user, keyed by callsign - used by the check-in
// screen to show quick-assign badges for the operator being checked in.
app.get('/api/users/positions', requireRole('netcontrol', 'backup'), (req, res) => {
  const users = queries.getAllUsers.all();
  const byUser = {};
  queries.getAllUserPositions.all().forEach(p => { (byUser[p.user_id] = byUser[p.user_id] || []).push(p.position); });
  const map = {};
  users.forEach(u => { if (byUser[u.id] && byUser[u.id].length) map[u.callsign.toUpperCase()] = byUser[u.id]; });
  res.json(map);
});

app.put('/api/users/:id/positions', requireAdmin, (req, res) => {
  const { positions } = req.body;
  if (!Array.isArray(positions)) return res.status(400).json({ error: 'positions must be an array' });
  const invalid = positions.filter(p => !SCHED_POSITIONS.includes(p));
  if (invalid.length) return res.status(400).json({ error: 'Invalid position: ' + invalid.join(', ') });
  setUserPositions(req.params.id, positions);
  res.json({ ok: true });
});

app.post('/api/users', requireAdmin, (req, res) => {
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

app.put('/api/users/:id/password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  queries.updateUserPassword.run(bcrypt.hashSync(password, 10), req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/role', requireAdmin, (req, res) => {
  const { role } = req.body;
  const validRoles = ['netcontrol', 'backup', 'observer'];
  if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
  queries.updateUserRole.run(role, req.params.id);
  res.json({ ok: true });
});

// Admin flag is separate from role - marks recipients of system-level notifications,
// and (see requireAdmin) also grants access to this Users/admin panel itself.
app.put('/api/users/:id/admin-flag', requireAdmin, (req, res) => {
  const { is_admin } = req.body;
  queries.updateUserAdminFlag.run(is_admin ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/phone', requireAdmin, (req, res) => {
  const { phone } = req.body;
  queries.updateUserPhone.run(phone || null, req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/sms-alerts', requireAdmin, (req, res) => {
  const { sms_alerts } = req.body;
  queries.updateUserSmsAlerts.run(sms_alerts ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

app.put('/api/users/:id/email', requireAdmin, (req, res) => {
  const { email } = req.body;
  queries.updateUserEmail.run(email || null, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  if (parseInt(req.params.id) === req.session.userId)
    return res.status(400).json({ error: 'Cannot delete your own account' });
  queries.deleteUser.run(req.params.id);
  res.json({ ok: true });
});

// ─── PENDING REQUESTS ─────────────────────────────────────────────────────────
app.get('/api/admin/requests', requireAdmin, (req, res) => {
  res.json(queries.getPendingRequests.all());
});

app.post('/api/admin/requests/:id/approve', requireAdmin, (req, res) => {
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

app.post('/api/admin/requests/:id/deny', requireAdmin, (req, res) => {
  const request = queries.getRequestById.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
  queries.updateRequestStatus.run('denied', request.id);
  emailDenialToUser(request);
  res.json({ ok: true });
});

// ─── DATABASE BACKUP ───────────────────────────────────────────────────────────
// One-click full database snapshot for disaster recovery, independent of
// Railway's own volume. Uses SQLite's backup API so any data still sitting in
// the WAL file gets safely checkpointed into one consistent file before download.
app.get('/api/admin/backup', requireAdmin, async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tmpPath = path.join(os.tmpdir(), `netlogger-backup-${Date.now()}.db`);
  try {
    await db.backup(tmpPath);
    res.download(tmpPath, `clay-ares-netlogger-backup-${stamp}.db`, (err) => {
      fs.unlink(tmpPath, () => {});
      if (err) console.error('Backup download error:', err.message);
    });
  } catch (e) {
    fs.unlink(tmpPath, () => {});
    console.error('Backup error:', e.message);
    res.status(500).json({ error: 'Could not create backup: ' + e.message });
  }
});

// ─── NET SESSIONS ─────────────────────────────────────────────────────────────
// Multiple nets can be open at once (e.g. a Command net and a Tactical net during
// an activation). Endpoints that don't already operate on a specific record id
// resolve which session to use via this helper: an explicit id if one is given,
// otherwise "the" open session only if there's exactly one - this keeps every
// existing single-net client call working unchanged.
function findOpenSession(id) {
  if (id) {
    const s = queries.getSessionById.get(id);
    return (s && s.status === 'open') ? s : null;
  }
  const open = queries.getOpenSessions.all();
  return open.length === 1 ? open[0] : null;
}

app.get('/api/sessions/open', requireAuth, (req, res) => {
  res.json(queries.getOpenSessions.all());
});

app.get('/api/session/current', requireAuth, (req, res) => {
  const session = findOpenSession(req.query.session);
  if (!session) return res.json({ active: false });
  res.json({ active: true, session, checkins: getFullCheckins(session.id) });
});

app.post('/api/session/open', requireRole('netcontrol'), (req, res) => {
  const { net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, incident_name, activation_type } = req.body;
  if (!net_name) return res.status(400).json({ error: 'Net name required' });
  const result = queries.createSession.run(net_name, frequency, mode, net_date, start_time, nc_callsign, bnc_callsign, req.session.userId);
  const sid = result.lastInsertRowid;
  if (incident_name) db.prepare('UPDATE net_sessions SET incident_name = ? WHERE id = ?').run(incident_name, sid);
  if (activation_type) db.prepare('UPDATE net_sessions SET activation_type = ? WHERE id = ?').run(activation_type, sid);
  res.json({ session: queries.getSessionById.get(sid), checkins: [] });
  if (URGENT_ACTIVATION_TYPES.includes(activation_type)) {
    sendSmsToOptedInMembers(
      `Clay ARES: ${activation_type} - "${net_name}" is now open. NC: ${nc_callsign || 'TBD'}. Details: ${APP_URL}`
    );
  }
});

app.post('/api/session/:id/close', requireRole('netcontrol'), (req, res) => {
  const session = queries.getSessionById.get(req.params.id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
  queries.closeSession.run(req.session.userId, session.id);
  res.json({ ok: true });
});

// Update an open net's info (Net Control handoff, frequency/mode changes, etc.)
// without closing and reopening it - closing would fragment the log into two
// separate operational periods and a fresh ICS 309.
app.put('/api/session/:id', requireRole('netcontrol'), (req, res) => {
  const session = queries.getSessionById.get(req.params.id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
  const { nc_callsign, bnc_callsign, frequency, mode } = req.body;
  db.prepare('UPDATE net_sessions SET nc_callsign = ?, bnc_callsign = ?, frequency = ?, mode = ? WHERE id = ?')
    .run(nc_callsign || null, bnc_callsign || null, frequency || null, mode || null, session.id);
  const oldNc = (session.nc_callsign || '').trim().toUpperCase();
  const newNc = (nc_callsign || '').trim().toUpperCase();
  if (newNc && newNc !== oldNc) {
    queries.insertIssue.run(
      session.id,
      `Net Control handoff: ${oldNc || 'unassigned'} → ${newNc}`,
      'normal',
      req.session.userId
    );
  }
  res.json(queries.getSessionById.get(session.id));
});

// Generates a PDF of the closed net's report (standard or ICS 309) and emails it to all
// admin-flagged accounts. Net Control responsibility - confirmed and triggered from the UI.
app.post('/api/session/:id/email-report', requireRole('netcontrol'), async (req, res) => {
  const { format } = req.body; // 'standard' or 'ics309'
  if (!['standard', 'ics309'].includes(format)) return res.status(400).json({ error: 'Invalid format' });
  const session = queries.getSessionById.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const user = queries.getUserById.get(req.session.userId);
  try {
    const result = await emailNetReportToAdmins(session, format, user);
    if (!result.ok) return res.status(500).json({ error: result.error || 'Could not send report' });
    res.json({ ok: true });
  } catch(e) {
    console.error('email-report error:', e.message);
    res.status(500).json({ error: 'Could not generate or send the report: ' + e.message });
  }
});

app.get('/api/session/history', requireAuth, (req, res) => {
  res.json(queries.getRecentSessions.all());
});

app.get('/api/session/:id/checkins', requireAuth, (req, res) => {
  res.json(getFullCheckins(req.params.id));
});

// ─── CHECKINS ─────────────────────────────────────────────────────────────────
app.post('/api/checkin', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = findOpenSession(req.body.session_id);
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
  if (has_traffic && Array.isArray(traffic)) {
    const emergencyMsg = traffic.find(t => t.precedence === 'Emergency');
    if (emergencyMsg) {
      sendSmsToOptedInMembers(
        `Clay ARES: EMERGENCY traffic from ${callsign.toUpperCase()}${emergencyMsg.description ? ' - ' + emergencyMsg.description : ''}. Details: ${APP_URL}`
      );
    }
  }
});

app.delete('/api/checkin/:id', requireRole('netcontrol', 'backup'), (req, res) => {
  const ci = queries.getCheckinById.get(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Check-in not found' });
  const session = queries.getSessionById.get(ci.session_id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
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
  const ci = queries.getCheckinById.get(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Check-in not found' });
  const session = queries.getSessionById.get(ci.session_id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
  const { precedence, type, deliver_to, passed, msg_number, from_callsign, description, time_sent, time_received } = req.body;
  const result = queries.insertTraffic.run(
    ci.id, precedence || 'Routine', type || 'Formal', deliver_to || '', passed ? 1 : 0,
    msg_number || null, from_callsign || null, description || null,
    time_sent || null, time_received || null
  );
  db.prepare('UPDATE checkins SET has_traffic = 1 WHERE id = ?').run(ci.id);
  res.json(db.prepare('SELECT * FROM traffic WHERE id = ?').get(result.lastInsertRowid));
  if (precedence === 'Emergency') {
    sendSmsToOptedInMembers(
      `Clay ARES: EMERGENCY traffic from ${ci.callsign}${description ? ' - ' + description : ''}. Details: ${APP_URL}`
    );
  }
});

// Check out / relieve a station
app.post('/api/checkin/:id/checkout', requireRole('netcontrol', 'backup'), (req, res) => {
  const ci = queries.getCheckinById.get(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Check-in not found' });
  const session = queries.getSessionById.get(ci.session_id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
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
  const session = findOpenSession(req.query.session);
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

// ─── CHAT ──────────────────────────────────────────────────────────────────────
// Chat is scoped to the currently open net session - it opens and closes with the net.
app.get('/api/chat', requireAuth, (req, res) => {
  const session = findOpenSession(req.query.session);
  if (!session) return res.json({ active: false, messages: [], positions: [] });
  const since = parseInt(req.query.since) || 0;
  const messages = since
    ? queries.getChatMessagesSince.all(session.id, since)
    : queries.getChatMessages.all(session.id);
  // Currently assigned tactical positions for this net - lets the composer
  // target a message at a specific position instead of broadcasting to everyone.
  const positions = db.prepare(
    "SELECT DISTINCT tactical_call FROM checkins WHERE session_id = ? AND tactical_call IS NOT NULL AND tactical_call != '' ORDER BY tactical_call"
  ).all(session.id).map(r => r.tactical_call);
  res.json({ active: true, session_id: session.id, messages, positions });
});

app.post('/api/chat', requireAuth, (req, res) => {
  const session = findOpenSession(req.body.session_id);
  if (!session) return res.status(409).json({ error: 'No open net session' });
  const message = (req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (message.length > 500) return res.status(400).json({ error: 'Message too long (500 characters max)' });
  const targetPosition = (req.body.target_position || '').trim() || null;
  const result = queries.insertChatMessage.run(session.id, req.session.userId, req.session.callsign, message, targetPosition);
  res.json(queries.getChatMessageById.get(result.lastInsertRowid));
});

// Mark announcement as given
app.post('/api/checkin/:id/announcement-given', requireRole('netcontrol', 'backup'), (req, res) => {
  const ci = queries.getCheckinById.get(req.params.id);
  if (!ci) return res.status(404).json({ error: 'Check-in not found' });
  const session = queries.getSessionById.get(ci.session_id);
  if (!session || session.status !== 'open') return res.status(404).json({ error: 'No open session' });
  try {
    db.prepare('UPDATE checkins SET announcements_given = COALESCE(announcements_given, 0) + 1 WHERE id = ? AND session_id = ?').run(req.params.id, session.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── TACTICAL POSITIONS ───────────────────────────────────────────────────────
app.get('/api/positions', requireAuth, (req, res) => {
  try {
    res.json(queries.getPositions.all());
  } catch(e) {
    console.error('GET positions error:', e.message);
    res.status(500).json({ error: 'Could not load positions: ' + e.message });
  }
});

app.post('/api/positions', requireRole('netcontrol'), (req, res) => {
  try {
    const { name, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const result = queries.insertPosition.run(name.trim(), description || null, sort_order || 0);
    res.json({ id: result.lastInsertRowid, name: name.trim(), description: description || null, sort_order: sort_order || 0 });
  } catch(e) {
    console.error('POST position error:', e.message);
    res.status(500).json({ error: 'Could not add position: ' + e.message });
  }
});

app.delete('/api/positions/:id', requireRole('netcontrol'), (req, res) => {
  try {
    queries.deletePosition.run(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    console.error('DELETE position error:', e.message);
    res.status(500).json({ error: 'Could not delete position: ' + e.message });
  }
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
  try {
    res.json(queries.getPresetPositions.all(req.params.id));
  } catch(e) {
    console.error('GET preset positions error:', e.message);
    res.status(500).json({ error: 'Could not load positions: ' + e.message });
  }
});

app.post('/api/presets/:id/positions', requireRole('netcontrol'), (req, res) => {
  try {
    const { name, description, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const presetId = parseInt(req.params.id);
    if (isNaN(presetId)) return res.status(400).json({ error: 'Invalid preset id' });
    // Direct lookup by primary key - avoids any array-scan equality edge cases
    const presetRow = db.prepare('SELECT id FROM presets WHERE id = ?').get(presetId);
    if (!presetRow) return res.status(404).json({ error: 'That preset no longer exists. The list has been refreshed - please try again.' });
    const result = queries.insertPresetPosition.run(presetId, name.trim(), description || null, sort_order || 0);
    res.json({ id: result.lastInsertRowid, preset_id: presetId, name: name.trim(), description: description || null });
  } catch(e) {
    console.error('POST preset position error:', e.message);
    if (e.message && e.message.includes('FOREIGN KEY constraint failed')) {
      return res.status(404).json({ error: 'That preset no longer exists. The list has been refreshed - please try again.' });
    }
    res.status(500).json({ error: 'Could not add position: ' + e.message });
  }
});

app.delete('/api/presets/:id/positions/:posId', requireRole('netcontrol'), (req, res) => {
  try {
    queries.deletePresetPosition.run(req.params.posId);
    res.json({ ok: true });
  } catch(e) {
    console.error('DELETE preset position error:', e.message);
    res.status(500).json({ error: 'Could not delete position: ' + e.message });
  }
});

// ─── ISSUES ───────────────────────────────────────────────────────────────────
app.get('/api/session/:id/issues', requireAuth, (req, res) => {
  res.json(queries.getIssuesBySession.all(req.params.id));
});

app.post('/api/issues', requireRole('netcontrol', 'backup'), (req, res) => {
  const session = findOpenSession(req.body.session_id);
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
// Supports optional filters (date range, activation type, participating callsign).
// With no filters, behaves exactly as before - the 20 most recent sessions.
app.get('/api/session/history-full', requireAuth, (req, res) => {
  const { from, to, type, callsign } = req.query;
  const hasFilters = !!(from || to || type || callsign);
  let sql = 'SELECT DISTINCT ns.* FROM net_sessions ns';
  const conditions = [];
  const params = [];
  if (callsign) {
    sql += ' JOIN checkins ci ON ci.session_id = ns.id';
    conditions.push('ci.callsign LIKE ? COLLATE NOCASE');
    params.push('%' + callsign.trim() + '%');
  }
  if (from) { conditions.push('date(ns.opened_at) >= ?'); params.push(from); }
  if (to) { conditions.push('date(ns.opened_at) <= ?'); params.push(to); }
  if (type === 'regular') { conditions.push("(ns.activation_type IS NULL OR ns.activation_type = '')"); }
  else if (type) { conditions.push('ns.activation_type = ?'); params.push(type); }
  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ' ORDER BY ns.opened_at DESC LIMIT ?';
  params.push(hasFilters ? 200 : 20);

  const sessions = db.prepare(sql).all(...params);
  const result = sessions.map(s => {
    const openCount = queries.getOpenIssueCount.get(s.id);
    return { ...s, open_issues: openCount ? openCount.cnt : 0 };
  });
  res.json(result);
});

// ─── MONTHLY ACTIVITY REPORT ───────────────────────────────────────────────────
// A summary of net/activation activity for a given month - useful as a starting
// point for ARES public service or Section activity reporting. Not an official
// ARRL form (those vary by Section), just an aggregated, exportable summary of
// data already captured by the logger.
function buildMonthlyReport(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const sessions = db.prepare(`SELECT * FROM net_sessions WHERE date(opened_at) BETWEEN ? AND ? ORDER BY opened_at`).all(start, end);

  const allOperators = new Set();
  const byType = {};
  const rows = sessions.map(s => {
    const checkins = db.prepare('SELECT callsign FROM checkins WHERE session_id = ?').all(s.id);
    checkins.forEach(c => allOperators.add(c.callsign.toUpperCase()));
    const type = s.activation_type || 'Regular Net';
    byType[type] = (byType[type] || 0) + 1;
    const durationMin = s.closed_at
      ? Math.round((new Date(s.closed_at.replace(' ', 'T') + 'Z') - new Date(s.opened_at.replace(' ', 'T') + 'Z')) / 60000)
      : null;
    return {
      id: s.id,
      net_date: s.net_date || (s.opened_at || '').split(' ')[0],
      net_name: s.net_name,
      activation_type: type,
      incident_name: s.incident_name || '',
      nc_callsign: s.nc_callsign || '',
      status: s.status,
      duration_minutes: durationMin,
      checkin_count: checkins.length
    };
  });

  return {
    year, month, start, end,
    totals: {
      net_count: rows.length,
      total_minutes: rows.reduce((sum, r) => sum + (r.duration_minutes || 0), 0),
      total_checkins: rows.reduce((sum, r) => sum + r.checkin_count, 0),
      unique_operators: allOperators.size,
      by_type: byType
    },
    sessions: rows
  };
}

app.get('/api/reports/monthly', requireRole('netcontrol', 'backup'), (req, res) => {
  const year = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year and month (1-12) required' });
  res.json(buildMonthlyReport(year, month));
});

app.get('/api/reports/monthly.csv', requireRole('netcontrol', 'backup'), (req, res) => {
  const year = parseInt(req.query.year);
  const month = parseInt(req.query.month);
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: 'year and month (1-12) required' });
  const report = buildMonthlyReport(year, month);
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = [];
  lines.push(['Clay County ARES Monthly Activity Report'].map(esc).join(','));
  lines.push([`${report.year}-${String(report.month).padStart(2, '0')}`].map(esc).join(','));
  lines.push([]);
  lines.push(['Nets/Activations', 'Total Net Minutes', 'Total Check-ins', 'Unique Operators'].map(esc).join(','));
  lines.push([report.totals.net_count, report.totals.total_minutes, report.totals.total_checkins, report.totals.unique_operators].map(esc).join(','));
  lines.push([]);
  lines.push(['By Activation Type'].map(esc).join(','));
  Object.entries(report.totals.by_type).forEach(([type, count]) => lines.push([type, count].map(esc).join(',')));
  lines.push([]);
  lines.push(['Date', 'Net Name', 'Activation Type', 'Incident', 'Net Control', 'Status', 'Duration (min)', 'Check-ins'].map(esc).join(','));
  report.sessions.forEach(r => {
    lines.push([r.net_date, r.net_name, r.activation_type, r.incident_name, r.nc_callsign, r.status, r.duration_minutes == null ? '' : r.duration_minutes, r.checkin_count].map(esc).join(','));
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="clay-ares-monthly-report-${report.year}-${String(report.month).padStart(2, '0')}.csv"`);
  res.send(lines.join('\n'));
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

async function sendSignupConfirmation(user, dateStr, position) {
  const dateDisplay = new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  // Confirmation to the person who signed up
  if (user.email) {
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#1D9E75;padding:20px 24px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
          <p style="color:#e1f5ee;margin:4px 0 0;font-size:14px">Signup Confirmed</p>
        </div>
        <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
          <p style="color:#1a1a18;font-size:15px;margin:0 0 12px">Hi ${user.full_name || user.callsign},</p>
          <p style="color:#1a1a18;font-size:15px;margin:0 0 16px">You're confirmed for the following net position:</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px">
            <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041;width:120px">Position</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de"><strong>${position}</strong></td></tr>
            <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Date</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">${dateDisplay}</td></tr>
            <tr><td style="padding:8px 12px;background:#E1F5EE;font-weight:bold;color:#085041">Time</td><td style="padding:8px 12px;background:#fff;border:1px solid #e2e2de">7:30 PM</td></tr>
          </table>
          <p style="color:#6b6b68;font-size:13px;margin:0 0 16px">You'll get a reminder email 24 hours and 1 hour before the net. You can cancel your signup any time from the Schedule tab in the Net Logger.</p>
          <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">View Schedule</a>
        </div>
      </div>`;
    await sendEmail(user.email, 'Confirmed: ' + position + ' for ' + dateDisplay, html);
  }

  // Heads-up to all system admins
  const adminEmails = queries.getSystemAdminEmails.all().map(r => r.email).filter(e => e && e !== user.email);
  if (adminEmails.length) {
    const adminHtml = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <div style="background:#085041;padding:20px 24px;border-radius:8px 8px 0 0">
          <h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1>
          <p style="color:#a8ddc9;margin:4px 0 0;font-size:14px">New Schedule Signup</p>
        </div>
        <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
          <p style="color:#1a1a18;font-size:15px;margin:0 0 12px"><strong>${user.callsign}</strong>${user.full_name ? ' (' + user.full_name + ')' : ''} just signed up as <strong>${position}</strong> for <strong>${dateDisplay}</strong>.</p>
          <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;margin-top:8px">View Schedule</a>
        </div>
      </div>`;
    adminEmails.forEach(email => sendEmail(email, 'Schedule signup: ' + user.callsign + ' - ' + position + ' on ' + dateDisplay, adminHtml));
  }
}

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
app.post('/api/schedule/:date/signup', requireAuth, async (req, res) => {
  const { position } = req.body;
  if (!SCHED_POSITIONS.includes(position)) return res.status(400).json({ error: 'Invalid position' });
  if (req.session.role !== 'netcontrol') {
    const approved = queries.getPositionsByUser.all(req.session.userId).map(p => p.position);
    if (!approved.includes(position)) return res.status(403).json({ error: 'You are not approved for the ' + position + ' position' });
  }
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
    const user = queries.getUserById.get(req.session.userId);
    if (user) sendSignupConfirmation(user, req.params.date, position).catch(e => console.error('Signup confirmation email error:', e.message));
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

// ─── LONG-OPEN-NET REMINDER (checked every 15 minutes) ────────────────────────
// Nudges Net Control (and admin-flagged accounts) if a net has been open long
// enough that it may have simply been forgotten, rather than left open on
// purpose for an ongoing activation. Regular nets get a short leash since
// they normally run under an hour; anything with an activation type gets more
// slack since those can legitimately run for many hours. Repeats every few
// hours if the net is still open, rather than firing once and going quiet.
const REGULAR_NET_HOURS_THRESHOLD = 2;
const ACTIVATION_HOURS_THRESHOLD = 8;
const LONG_OPEN_REMINDER_REPEAT_HOURS = 3;

async function checkLongOpenNets() {
  try {
    const openSessions = queries.getOpenSessions.all();
    const now = Date.now();
    for (const s of openSessions) {
      if (!s.opened_at) continue;
      const openedMs = new Date(s.opened_at.replace(' ', 'T') + 'Z').getTime();
      const hoursOpen = (now - openedMs) / (1000 * 60 * 60);
      const isActivation = !!(s.activation_type && s.activation_type.trim());
      const threshold = isActivation ? ACTIVATION_HOURS_THRESHOLD : REGULAR_NET_HOURS_THRESHOLD;
      if (hoursOpen < threshold) continue;

      const lastReminderMs = s.last_long_open_reminder_at
        ? new Date(s.last_long_open_reminder_at.replace(' ', 'T') + 'Z').getTime()
        : null;
      const hoursSinceReminder = lastReminderMs ? (now - lastReminderMs) / (1000 * 60 * 60) : Infinity;
      if (hoursSinceReminder < LONG_OPEN_REMINDER_REPEAT_HOURS) continue;

      const recipients = new Set();
      const nc = s.nc_callsign ? queries.getUserByCallsign.get(s.nc_callsign) : null;
      if (nc && nc.email) recipients.add(nc.email);
      queries.getSystemAdminEmails.all().forEach(r => recipients.add(r.email));
      if (!recipients.size) { queries.markLongOpenReminderSent.run(s.id); continue; }

      const openedDisplay = new Date(openedMs).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <div style="background:#BA7517;padding:20px 24px;border-radius:8px 8px 0 0"><h1 style="color:#fff;margin:0;font-size:20px">Clay ARES Net Logger</h1><p style="color:#fbe8c8;margin:4px 0 0;font-size:14px">Long-Open Net Reminder</p></div>
          <div style="background:#f8f8f6;padding:24px;border:1px solid #e2e2de;border-top:none;border-radius:0 0 8px 8px">
            <p style="font-size:15px;color:#1a1a18">"<strong>${s.net_name}</strong>" has been open for over ${Math.floor(hoursOpen)} hour${Math.floor(hoursOpen) === 1 ? '' : 's'} (opened ${openedDisplay}).</p>
            <p style="font-size:15px;color:#1a1a18">If this net has wrapped up, please close it in the Net Logger so the log and ICS 309 reflect the correct operational period. If it's an ongoing activation, no action is needed - you'll get this reminder again in a few hours if it's still open.</p>
            <a href="${APP_URL}" style="display:inline-block;background:#1D9E75;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px">Open Net Logger</a>
          </div>
        </div>`;
      for (const email of recipients) {
        await sendEmail(email, `Clay ARES Net Logger: "${s.net_name}" has been open a while`, html);
      }
      queries.markLongOpenReminderSent.run(s.id);
    }
  } catch(e) {
    console.error('Long-open-net reminder check error:', e.message);
  }
}
setInterval(checkLongOpenNets, 15 * 60 * 1000);
checkLongOpenNets();

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

// ─── REPORT HTML GENERATION (no Puppeteer/Chromium - plain HTML, emailed directly) ────
function parseUTCServer(dtStr) {
  if (!dtStr) return null;
  return new Date(dtStr.includes('T') || dtStr.endsWith('Z') ? dtStr : dtStr.replace(' ', 'T') + 'Z');
}

// Builds the same layout as the browser-side "Export PDF" button, from server-side data.
// Returned HTML is used directly as both the email body and the attached .html file.
function buildStandardReportHTML(session, checkins) {
  const dur = session.opened_at && session.closed_at
    ? Math.round((parseUTCServer(session.closed_at) - parseUTCServer(session.opened_at)) / 60000) + ' min' : '';
  const openedStr = session.opened_at ? parseUTCServer(session.opened_at).toLocaleString() : 'N/A';
  const closedStr = session.closed_at ? parseUTCServer(session.closed_at).toLocaleString() : 'N/A';

  const rows = checkins.map((ci, i) => {
    const notes = [];
    if (ci.has_comments) notes.push(ci.comment_count + ' comment(s)' + (ci.comment_notes ? ': ' + ci.comment_notes : ''));
    (ci.traffic || []).forEach(t => notes.push('[' + t.precedence + '] ' + t.type + ' \u2192 ' + t.deliver_to + (t.passed ? ' (passed)' : '')));
    return `<tr style="border-bottom:0.5px solid #eee;${i % 2 === 1 ? 'background:#f9f9f9' : ''}">
      <td style="padding:5px 7px;color:#999;white-space:nowrap">${ci.seq}</td>
      <td style="padding:5px 7px;font-weight:700;font-family:monospace;white-space:nowrap">${ci.callsign}</td>
      <td style="padding:5px 7px">${ci.name || ''}</td>
      <td style="padding:5px 7px;white-space:nowrap">${ci.license_class || ''}</td>
      <td style="padding:5px 7px;font-family:monospace;white-space:nowrap">${ci.time_in || ''}</td>
      <td style="padding:5px 7px;font-family:monospace;color:#185FA5;white-space:nowrap;font-size:10px">${ci.usng || '&mdash;'}</td>
      <td style="padding:5px 7px;color:#E11F26;font-weight:600;white-space:nowrap;font-size:10px">${ci.w3w ? '///' + ci.w3w : '&mdash;'}</td>
      <td style="padding:5px 7px;color:#666;white-space:nowrap">${ci.logged_by_callsign || ''}</td>
      <td style="padding:5px 7px;color:#555;font-size:10px">${notes.join(' &middot; ')}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${(session.net_name || 'Net Log').replace(/</g,'&lt;')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 12px; color: #1a1a18; background: #fff; padding: 24px 28px; }
  .header { border-bottom: 2.5px solid #1D9E75; padding-bottom: 10px; margin-bottom: 16px; }
  .net-title { font-size: 22px; font-weight: 700; color: #085041; margin-bottom: 4px; }
  .net-meta { font-size: 12px; color: #555; margin-bottom: 2px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { text-align: left; padding: 6px 7px; font-size: 10px; font-weight: 700; color: #555; border-bottom: 1.5px solid #ccc; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; background: #f4f4f0; }
  td { vertical-align: top; }
  .footer-row { margin-top: 14px; font-size: 10px; color: #666; border-top: 0.5px solid #ddd; padding-top: 8px; }
  .sig-row { margin-top: 36px; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 40px; }
  .sig-line { border-top: 0.5px solid #ccc; padding-top: 6px; font-size: 10px; color: #666; }
</style>
</head>
<body>
<div class="header">
  <div class="net-title">${(session.net_name || 'Net Log').replace(/</g,'&lt;')}</div>
  <div class="net-meta">Net Control: <strong>${session.nc_callsign || 'N/A'}</strong>${session.bnc_callsign ? ' &nbsp;&middot;&nbsp; Backup NC: <strong>' + session.bnc_callsign + '</strong>' : ''} &nbsp;&middot;&nbsp; ${session.frequency || ''} MHz ${session.mode || ''} &nbsp;&middot;&nbsp; ${session.net_date || ''}</div>
  <div class="net-meta">Opened: ${openedStr} &nbsp;&middot;&nbsp; Closed: ${closedStr}${dur ? ' &nbsp;&middot;&nbsp; Duration: ' + dur : ''}</div>
</div>
<table>
  <thead><tr>
    <th>#</th><th>Callsign</th><th>Name</th><th>Class</th><th>Time</th>
    <th>USNG (1m)</th><th>what3words</th><th>Logged by</th><th>Notes / Traffic</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
<div class="footer-row">
  Total check-ins: ${checkins.length} &nbsp;&middot;&nbsp;
  With USNG: ${checkins.filter(c => c.usng).length} &nbsp;&middot;&nbsp;
  With traffic: ${checkins.filter(c => c.has_traffic).length} &nbsp;&middot;&nbsp;
  With comments: ${checkins.filter(c => c.has_comments).length}
</div>
<div class="sig-row">
  <div class="sig-line">Net Control: ${session.nc_callsign || '_____________________'}</div>
  <div class="sig-line">Backup NC: ${session.bnc_callsign || '_____________________'}</div>
  <div class="sig-line">Date: ${session.net_date || '_____________________'}</div>
</div>
</body></html>`;
}

// Builds the same ICS 309 layout as /ics309/:id (public/ics309.html), directly from
// server-side data - no browser navigation, no auth tokens, no Chromium needed.
function buildICS309HTML(session, checkins, issues) {
  const getPrecClass = p => p === 'Emergency' ? 'prec-E' : p === 'Priority' ? 'prec-P' : p === 'Welfare' ? 'prec-W' : 'prec-R';

  const entries = [];
  checkins.forEach(ci => {
    entries.push({
      time: ci.time_in || '', from: ci.callsign, to: session.nc_callsign || 'NCS',
      tactical: ci.tactical_call || '', msgNum: '', prec: '',
      subject: 'CHECK-IN' + (ci.name ? ' \u00b7 ' + ci.name : '') + (ci.has_comments ? ' [' + ci.comment_count + ' announcement(s)' + (ci.comment_notes ? ': ' + ci.comment_notes : '') + ']' : ''),
      passed: '', type: 'checkin'
    });
    (ci.traffic || []).forEach(t => {
      entries.push({
        time: t.time_sent || ci.time_in || '', from: t.from_callsign || ci.callsign, to: t.deliver_to || '',
        tactical: ci.tactical_call || '', msgNum: t.msg_number || '', prec: t.precedence || '',
        subject: t.description || (t.type + ' traffic'), passed: t.passed ? '\u2713' : '', type: 'traffic'
      });
    });
  });
  entries.sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const totalCheckins = checkins.length;
  const totalTraffic = entries.filter(e => e.type === 'traffic').length;
  const pendingTraffic = entries.filter(e => e.type === 'traffic' && !e.passed).length;
  const openIssuesCount = issues.filter(i => i.status === 'open').length;

  const tbody = entries.map(e => `
    <tr style="${e.type === 'checkin' ? 'background:#f0f8f0' : ''}">
      <td style="border:1px solid #bbb;padding:4px 6px;font-family:monospace;white-space:nowrap">${e.time}</td>
      <td style="border:1px solid #bbb;padding:4px 6px;font-family:monospace;font-weight:700;white-space:nowrap">${e.from}</td>
      <td style="border:1px solid #bbb;padding:4px 6px;font-family:monospace;font-weight:700;white-space:nowrap">${e.to}</td>
      <td style="border:1px solid #bbb;padding:4px 6px;font-size:10px">${e.tactical}</td>
      <td style="border:1px solid #bbb;padding:4px 6px;font-family:monospace;font-size:10px">${e.msgNum}</td>
      <td style="border:1px solid #bbb;padding:4px 6px"><span style="font-weight:700;color:${e.prec==='Emergency'?'#cc0000':e.prec==='Priority'?'#0044cc':e.prec==='Welfare'?'#996600':'#006600'}">${e.prec}</span></td>
      <td style="border:1px solid #bbb;padding:4px 6px;min-width:200px">${e.subject}</td>
      <td style="border:1px solid #bbb;padding:4px 6px;text-align:center;color:green;font-weight:700">${e.passed}</td>
    </tr>`).join('');

  const openedStr = session.opened_at ? parseUTCServer(session.opened_at).toLocaleString() : '';
  const closedStr = session.closed_at ? parseUTCServer(session.closed_at).toLocaleString() : 'ONGOING';

  const issueRows = issues.length ? `
    <div style="margin-top:20px">
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;border:2px solid #000;border-bottom:none;padding:5px 8px;background:#ffe8e8">Issues Log (${openIssuesCount} open / ${issues.length} total)</div>
      <table style="width:100%;border-collapse:collapse;border:2px solid #000">
        <thead><tr style="background:#d8d8d8">
          <th style="border:1px solid #555;padding:5px 6px;width:140px;text-align:left">Time</th>
          <th style="border:1px solid #555;padding:5px 6px;width:70px;text-align:left">Priority</th>
          <th style="border:1px solid #555;padding:5px 6px;width:70px;text-align:left">Status</th>
          <th style="border:1px solid #555;padding:5px 6px;text-align:left">Description</th>
        </tr></thead>
        <tbody>${issues.map(i => `<tr style="${i.status === 'resolved' ? 'color:#888' : ''}">
          <td style="border:1px solid #bbb;padding:4px 6px">${i.created_at || ''}</td>
          <td style="border:1px solid #bbb;padding:4px 6px;text-transform:uppercase;font-weight:700;color:${i.priority==='critical'?'#cc0000':i.priority==='high'?'#cc6600':'#000'}">${i.priority}</td>
          <td style="border:1px solid #bbb;padding:4px 6px">${i.status}</td>
          <td style="border:1px solid #bbb;padding:4px 6px">${i.description}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>ICS 309 - ${(session.net_name || 'Net').replace(/</g,'&lt;')}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11px; color: #000; background: #fff; padding: 16px; }
  .form-title-row { display: flex; align-items: center; justify-content: space-between; border: 2px solid #000; border-bottom: none; padding: 6px 10px; background: #f0f0f0; }
  .form-title { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; }
  .header-grid { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; border: 2px solid #000; border-bottom: none; }
  .header-cell { border-right: 1px solid #000; padding: 4px 6px; }
  .header-cell:last-child { border-right: none; }
  .field-label { font-size: 9px; font-weight: 700; text-transform: uppercase; color: #555; letter-spacing: 0.05em; display: block; margin-bottom: 2px; }
  .field-value { font-size: 12px; font-weight: 600; min-height: 16px; }
  table { width: 100%; border-collapse: collapse; border: 2px solid #000; }
  th { background: #d8d8d8; }
  .footer-grid { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; border: 2px solid #000; border-top: none; }
  .footer-cell { border-right: 1px solid #000; padding: 5px 6px; }
  .footer-cell:last-child { border-right: none; }
  .sig-block { margin-top: 24px; display: grid; grid-template-columns: repeat(4, 1fr); gap: 30px; }
  .sig-line { border-top: 1px solid #000; padding-top: 4px; font-size: 10px; color: #444; }
</style>
</head>
<body>
<div class="form-title-row">
  <div class="form-title">ICS 309 &mdash; Communications Log</div>
  <div style="font-size:11px;color:#555">ICS 309</div>
</div>
<div class="header-grid">
  <div class="header-cell"><span class="field-label">1. Incident Name</span><div class="field-value">${session.incident_name || session.net_name || ''}</div></div>
  <div class="header-cell"><span class="field-label">2. Operational Period &mdash; Date From</span><div class="field-value">${openedStr}</div></div>
  <div class="header-cell"><span class="field-label">Date / Time To</span><div class="field-value">${closedStr}</div></div>
  <div class="header-cell"><span class="field-label">Activation Type</span><div class="field-value">${session.activation_type || 'Net'}</div></div>
</div>
<div class="header-grid">
  <div class="header-cell"><span class="field-label">3. Radio Operator Name / Net Control</span><div class="field-value">${session.nc_callsign || ''}</div></div>
  <div class="header-cell"><span class="field-label">Backup Net Control</span><div class="field-value">${session.bnc_callsign || ''}</div></div>
  <div class="header-cell"><span class="field-label">4. Frequency / Mode</span><div class="field-value">${(session.frequency || '') + ' ' + (session.mode || '')}</div></div>
  <div class="header-cell"><span class="field-label">5. Total Check-ins</span><div class="field-value">${totalCheckins}</div></div>
</div>
<table>
  <thead><tr>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:55px">Time</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:80px">From</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:80px">To</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:90px">Tactical Call</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:55px">Msg #</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:70px">Precedence</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left">Subject / Message</th>
    <th style="border:1px solid #555;padding:5px 6px;text-align:left;width:45px">&#10003;</th>
  </tr></thead>
  <tbody>${tbody}</tbody>
</table>
<div class="footer-grid">
  <div class="footer-cell"><span class="field-label">Total Check-ins</span><div class="field-value">${totalCheckins}</div></div>
  <div class="footer-cell"><span class="field-label">Total Messages</span><div class="field-value">${totalTraffic}</div></div>
  <div class="footer-cell"><span class="field-label">Pending Traffic</span><div class="field-value" style="color:${pendingTraffic > 0 ? '#cc0000' : 'inherit'}">${pendingTraffic}</div></div>
  <div class="footer-cell"><span class="field-label">Open Issues</span><div class="field-value" style="color:${openIssuesCount > 0 ? '#cc6600' : 'inherit'}">${openIssuesCount}</div></div>
</div>
${issueRows}
<div class="sig-block">
  <div class="sig-line">Net Control Signature / Callsign: ${session.nc_callsign || '_____________'}</div>
  <div class="sig-line">Backup Net Control: ${session.bnc_callsign || '_____________'}</div>
  <div class="sig-line">Date: ${session.net_date || '_____________'}</div>
  <div class="sig-line">Prepared by: _____________________</div>
</div>
</body></html>`;
}

// Sends the closed-net report (standard or ICS 309) to all is_admin-flagged accounts.
// The report is shown directly in the email body, with the same HTML also attached as
// a standalone .html file admins can save or open in a browser.
async function emailNetReportToAdmins(session, format, requestingUser) {
  const adminEmails = queries.getSystemAdminEmails.all().map(r => r.email).filter(Boolean);
  if (!adminEmails.length) return { ok: false, error: 'No admin accounts have an email on file.' };

  let reportHTML, filenameBase, formatLabel;
  if (format === 'ics309') {
    const checkins = getFullCheckins(session.id);
    const issues = queries.getIssuesBySession.all(session.id);
    reportHTML = buildICS309HTML(session, checkins, issues);
    filenameBase = 'ICS309-' + (session.net_name || 'net').replace(/\s+/g, '-') + '-' + (session.net_date || '');
    formatLabel = 'ICS 309 Communications Log';
  } else {
    const checkins = getFullCheckins(session.id);
    reportHTML = buildStandardReportHTML(session, checkins);
    filenameBase = (session.net_name || 'net-log').replace(/\s+/g, '-') + '-' + (session.net_date || '');
    formatLabel = 'Net Log Report';
  }

  const filename = filenameBase + '.html';
  const base64 = Buffer.from(reportHTML, 'utf8').toString('base64');

  // Wrap the report HTML in an outer shell so it displays cleanly inside the email body
  // (most email clients strip/ignore <head>/<style> on inline content, so the report's
  // own inline styles still apply, but we also add a short intro above it).
  const emailHTML = `
    <div style="font-family:Arial,sans-serif;max-width:760px;margin:0 auto">
      <div style="background:#085041;padding:18px 22px;border-radius:8px 8px 0 0">
        <h1 style="color:#fff;margin:0;font-size:18px">Clay ARES Net Logger</h1>
        <p style="color:#a8ddc9;margin:4px 0 0;font-size:13px">${formatLabel} &mdash; closed by ${requestingUser.callsign}</p>
      </div>
      <div style="padding:16px 0 8px;background:#fff">
        ${reportHTML.replace(/<!DOCTYPE[^>]*>/i, '').replace(/<\/?html[^>]*>/gi, '').replace(/<head>[\s\S]*?<\/head>/i, '').replace(/<\/?body[^>]*>/gi, '')}
      </div>
      <p style="color:#6b6b68;font-size:12px;margin:12px 0 0">The same report is attached as an HTML file for saving or printing.</p>
    </div>`;

  let lastResult = { ok: true };
  for (const email of adminEmails) {
    lastResult = await sendEmailWithAttachment(email, formatLabel + ' - ' + (session.net_name || 'Net') + ' - ' + (session.net_date || ''), emailHTML, { filename, base64 });
  }
  return lastResult;
}

app.listen(PORT, () => console.log(`Net Logger running on port ${PORT}`));
