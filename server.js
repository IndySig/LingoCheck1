const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');
const tls = require('tls');

const security = require('./security');

const PUBLIC_DIR = path.join(__dirname, 'public');
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const REVISORS_FILE = path.join(__dirname, 'revisors.json');
const COOKIE_NAME = 'lc_session';
const TWOFA_COOKIE = 'lc_2fa';
const AUTH_FILE = path.join(__dirname, 'auth.local.json');
const PASSWORD_MIN_LENGTH = 12;

const PAYOUT_PER_WORD_CENTS = 2.5;
const MAX_JSON_BODY = 1024 * 1024;
const MAX_JOB_BODY = 6 * 1024 * 1024;
const MAX_TRANSLATE_BODY = 32 * 1024;

function loadAuthConfig() {
  // Used for SESSION_SECRET (required) and an optional legacy admin login.
  const envUser = process.env.REVISOR_USER;
  const envPass = process.env.REVISOR_PASSWORD;
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret) {
    return {
      legacyUser: envUser || null,
      legacyPass: envPass || null,
      secret: envSecret
    };
  }

  if (fs.existsSync(AUTH_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
      const secret = raw?.SESSION_SECRET || raw?.secret;
      const legacyUser = raw?.REVISOR_USER || raw?.user || null;
      const legacyPass = raw?.REVISOR_PASSWORD || raw?.pass || null;
      if (secret) return { legacyUser, legacyPass, secret };
    } catch {
      // ignore
    }
  }

  return null;
}

function ensureAuthConfig() {
  const existing = loadAuthConfig();
  if (existing?.secret) return existing;

  // Demo-friendly default: create a local SESSION_SECRET if none exists,
  // so signup/login works out of the box.
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(AUTH_FILE, JSON.stringify({ SESSION_SECRET: secret }, null, 2), 'utf8');
  } catch {
    // If we can't write, we still return a secret for this process.
  }
  return { legacyUser: null, legacyPass: null, secret };
}

// ── Revisor accounts ──────────────────────────────────────────────────────
function loadRevisors() {
  if (!fs.existsSync(REVISORS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(REVISORS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveRevisors(revisors) {
  fs.writeFileSync(REVISORS_FILE, JSON.stringify(revisors, null, 2), 'utf8');
}

function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

function passwordChecks(password) {
  const p = String(password || '');
  return {
    length: p.length >= PASSWORD_MIN_LENGTH,
    upper: /[A-Z]/.test(p),
    lower: /[a-z]/.test(p),
    number: /[0-9]/.test(p),
    special: /[^A-Za-z0-9]/.test(p)
  };
}

function isStrongPassword(password) {
  const c = passwordChecks(password);
  return c.length && c.upper && c.lower && c.number && c.special;
}

function passwordPolicyError(password) {
  const c = passwordChecks(password);
  const missing = [];
  if (!c.length) missing.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (!c.upper) missing.push('an uppercase letter');
  if (!c.lower) missing.push('a lowercase letter');
  if (!c.number) missing.push('a number');
  if (!c.special) missing.push('a special character');
  if (!missing.length) return null;
  return 'Password must include ' + missing.join(', ');
}

function updateRevisor(id, patch) {
  const revisors = loadRevisors();
  const i = revisors.findIndex(r => r.id === id);
  if (i === -1) return null;
  revisors[i] = { ...revisors[i], ...patch };
  saveRevisors(revisors);
  return revisors[i];
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(String(code || '')).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at < 1) return value;
  const user = value.slice(0, at);
  const domain = value.slice(at);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}${domain}`;
}

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) return {};
  try {
    const raw = fs.readFileSync(AUTH_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}

function loadAnthropicApiKey() {
  const file = readAuthFile();
  return String(process.env.ANTHROPIC_API_KEY || file.ANTHROPIC_API_KEY || '').trim();
}

function loadSmtpConfig() {
  const file = readAuthFile();
  const host = String(process.env.SMTP_HOST || file.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || file.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || file.SMTP_PASSWORD || file.SMTP_PASS || '').replace(/\s+/g, '');
  const port = Number(process.env.SMTP_PORT || file.SMTP_PORT || 587);
  const from = String(process.env.SMTP_FROM || file.SMTP_FROM || user).trim();
  if (!host || !user || !pass) {
    const missing = [!host && 'SMTP_HOST', !user && 'SMTP_USER', !pass && 'SMTP_PASS'].filter(Boolean);
    return { missing };
  }
  return {
    host,
    port,
    secure: String(process.env.SMTP_SECURE || file.SMTP_SECURE || '') === 'true' || port === 465,
    user,
    pass,
    from: from || user
  };
}

function extractEmailAddress(value) {
  const raw = String(value || '');
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim();
}

function smtpExpect(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SMTP timeout'));
    }, 20000);
    function onData(chunk) {
      buf += chunk;
      const lines = buf.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return;
      const last = lines[lines.length - 1];
      if (/^\d{3}[\s-]/.test(last) && /^\d{3} /.test(last)) {
        cleanup();
        resolve(buf);
      }
    }
    function onErr(err) {
      cleanup();
      reject(err);
    }
    function cleanup() {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onErr);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function smtpCmd(socket, line) {
  if (line != null) socket.write(line + '\r\n');
  return smtpExpect(socket);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function publicBaseUrl(req) {
  const file = readAuthFile();
  const configured = String(process.env.PUBLIC_BASE_URL || file.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;
  const host = String(req.headers.host || 'localhost:5001').split(',')[0].trim();
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = process.env.TRUST_PROXY === '1' && xfProto === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}

async function sendDeliveryEmail(req, job) {
  const to = String(job?.clientEmail || '').trim();
  if (!to) return { sent: false, reason: 'no-email' };
  const token = String(job.deliveryToken || '');
  const link = `${publicBaseUrl(req)}/?job=${encodeURIComponent(job.id)}&t=${encodeURIComponent(token)}`;
  const translation = String(job.revisedTranslation || '').trim();
  const lang = job.language || 'your language';
  const subject = `Your ${lang} translation is ready`;
  const text = [
    'Your LingoCheck translation is ready.',
    '',
    'Open this link to view it and download the formatted file:',
    link,
    '',
    '--- Translation ---',
    translation,
    '',
    'If you did not request this, you can ignore this email.'
  ].join('\n');
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1430">
    <p style="font-size:14px;color:#6b6480;margin:0 0 12px">LingoCheck</p>
    <h1 style="font-size:22px;font-weight:600;margin:0 0 16px">Your ${escapeHtml(lang)} translation is ready</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px">A certified translator has finished your assignment. Open the link below to view it and download the formatted file.</p>
    <p style="margin:0 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d4fd8;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:600">Open your translation</a></p>
    <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;background:#f7f5fb;border:1px solid rgba(92,70,168,0.14);border-radius:12px;padding:16px">${escapeHtml(translation)}</div>
    <p style="font-size:12px;color:#6b6480;margin:20px 0 0">If you did not request this, you can ignore this email.</p>
  </div>`;

  const smtp = loadSmtpConfig();
  if (!smtp.host) {
    console.log(`[LingoCheck] Delivery email for ${to} (SMTP not configured). Link: ${link}`);
    return { sent: false };
  }
  try {
    await sendSmtpMail({ ...smtp, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    console.error('[LingoCheck] Failed to send delivery email:', err.message);
    console.log(`[LingoCheck] Delivery link for ${to}: ${link}`);
    return { sent: false };
  }
}

function wrapTls(socket, host) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: host }, () => resolve(secure));
    secure.setEncoding('utf8');
    secure.once('error', reject);
  });
}

async function sendSmtpMail({ host, port, secure, user, pass, from, to, subject, text, html }) {
  const net = require('net');
  let socket = await new Promise((resolve, reject) => {
    const opts = { host, port };
    const sock = secure
      ? tls.connect({ ...opts, servername: host }, () => resolve(sock))
      : net.connect(opts, () => resolve(sock));
    sock.setEncoding('utf8');
    sock.setTimeout(20000);
    sock.once('error', reject);
    sock.once('timeout', () => reject(new Error('SMTP connection timeout')));
  });

  const greet = await smtpCmd(socket, null);
  if (!greet.startsWith('220')) throw new Error('SMTP greeting failed');
  await smtpCmd(socket, 'EHLO lingocheck.local');

  if (!secure && (port === 587 || port === 25)) {
    const start = await smtpCmd(socket, 'STARTTLS');
    if (!start.startsWith('220')) throw new Error('STARTTLS failed');
    socket = await wrapTls(socket, host);
    await smtpCmd(socket, 'EHLO lingocheck.local');
  }

  const auth = await smtpCmd(socket, 'AUTH LOGIN');
  if (!auth.startsWith('334')) throw new Error('SMTP AUTH LOGIN not supported');
  const userResp = await smtpCmd(socket, Buffer.from(user).toString('base64'));
  if (!userResp.startsWith('334')) throw new Error('SMTP username rejected');
  const passResp = await smtpCmd(socket, Buffer.from(pass).toString('base64'));
  if (!passResp.startsWith('235')) throw new Error('SMTP login failed');

  const fromAddr = extractEmailAddress(from);
  const mailFrom = await smtpCmd(socket, `MAIL FROM:<${fromAddr}>`);
  if (!mailFrom.startsWith('250')) throw new Error('MAIL FROM rejected');
  const rcpt = await smtpCmd(socket, `RCPT TO:<${to}>`);
  if (!rcpt.startsWith('250')) throw new Error('RCPT TO rejected');
  const data = await smtpCmd(socket, 'DATA');
  if (!data.startsWith('354')) throw new Error('DATA not accepted');

  const boundary = 'lc' + crypto.randomBytes(8).toString('hex');
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const body = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    '',
    html,
    `--${boundary}--`,
    '.'
  ].join('\r\n');
  const sent = await smtpCmd(socket, body);
  if (!sent.startsWith('250')) throw new Error('Message not accepted');
  await smtpCmd(socket, 'QUIT').catch(() => {});
  socket.end();
}

async function sendLoginCodeEmail(to, code) {
  const smtp = loadSmtpConfig();
  if (!smtp.host) {
    console.log(`[LingoCheck] 2FA code for ${to}: ${code} (email not configured: missing ${smtp.missing.join(', ')})`);
    return { sent: false };
  }
  try {
    await sendSmtpMail({
      ...smtp,
      to,
      subject: `${code} is your LingoCheck sign-in code`,
      text: `Your LingoCheck verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1c1430">
        <p style="font-size:14px;color:#6b6480;margin:0 0 12px">LingoCheck</p>
        <h1 style="font-size:22px;font-weight:600;margin:0 0 16px">Your sign-in code</h1>
        <p style="font-size:15px;line-height:1.6;margin:0 0 20px">Use this code to finish signing in. It expires in 10 minutes.</p>
        <div style="font-size:32px;letter-spacing:0.28em;font-weight:700;background:#f7f5fb;border:1px solid rgba(92,70,168,0.14);border-radius:12px;padding:16px;text-align:center">${code}</div>
        <p style="font-size:12px;color:#6b6480;margin:20px 0 0">If you didn't try to sign in, you can ignore this email.</p>
      </div>`
    });
    return { sent: true };
  } catch (err) {
    console.error('[LingoCheck] Failed to send 2FA email:', err.message);
    console.log(`[LingoCheck] 2FA code for ${to}: ${code}`);
    return { sent: false };
  }
}

function issueEmailOtp(revisorId) {
  const code = generateOtp();
  const updated = updateRevisor(revisorId, {
    otpHash: hashOtp(code),
    otpExpiresAt: Date.now() + 10 * 60 * 1000
  });
  if (!updated) return null;
  const email = updated.email || updated.username || '';
  return { email, emailMasked: maskEmail(email), code };
}

function verifyEmailOtp(revisor, code) {
  const token = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return false;
  if (!revisor?.otpHash || !revisor.otpExpiresAt) return false;
  if (Date.now() > revisor.otpExpiresAt) return false;
  const a = Buffer.from(hashOtp(token));
  const b = Buffer.from(revisor.otpHash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function startEmailTwoFactor(res, revisor) {
  const otp = issueEmailOtp(revisor.id);
  if (!otp || !issuePending2fa(res, revisor)) return null;
  const mail = await sendLoginCodeEmail(otp.email, otp.code);
  const payload = {
    ok: true,
    requires2fa: true,
    emailMasked: otp.emailMasked,
    delivered: mail.sent
  };
  if (!mail.sent) payload.code = otp.code;
  return payload;
}

const twoFaAttempts = new Map();

function twoFaAllowed(revisorId) {
  const rec = twoFaAttempts.get(revisorId);
  if (rec?.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.max(1, Math.ceil((rec.lockedUntil - Date.now()) / 60000));
    return { ok: false, error: `Too many attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  return { ok: true };
}

function recordTwoFaFailure(revisorId) {
  const rec = twoFaAttempts.get(revisorId) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= 8) rec.lockedUntil = Date.now() + 15 * 60 * 1000;
  twoFaAttempts.set(revisorId, rec);
}

function recordTwoFaSuccess(revisorId) {
  twoFaAttempts.delete(revisorId);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function revisorLoginKey(r) {
  return String(r?.email || r?.username || '').toLowerCase();
}

function createRevisor({ email, displayName, password }) {
  const revisors = loadRevisors();
  const normalized = normalizeEmail(email);
  const exists = revisors.find(r => revisorLoginKey(r) === normalized);
  if (exists) throw new Error('Email already in use');
  const salt = crypto.randomBytes(12).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const revisor = {
    id: 'r_' + crypto.randomBytes(6).toString('hex'),
    email: normalized,
    username: normalized,
    displayName: displayName || normalized.split('@')[0],
    salt,
    passwordHash,
    createdAt: Date.now()
  };
  revisors.push(revisor);
  saveRevisors(revisors);
  return revisor;
}

function findRevisorByLogin(email, password) {
  const revisors = loadRevisors();
  const key = normalizeEmail(email);
  const r = revisors.find(x => revisorLoginKey(x) === key);
  if (!r) return null;
  const computed = hashPassword(password || '', r.salt);
  // Constant-time compare
  const a = Buffer.from(computed);
  const b = Buffer.from(r.passwordHash);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  return r;
}

function findRevisorById(id) {
  return loadRevisors().find(r => r.id === id) || null;
}

function publicRevisor(r) {
  if (!r) return null;
  return {
    id: r.id,
    email: r.email || r.username,
    username: r.email || r.username,
    displayName: r.displayName
  };
}

// ── Sessions ──────────────────────────────────────────────────────────────
function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function base64UrlDecodeToString(input) {
  const padLen = (4 - (input.length % 4)) % 4;
  const padded = input.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookie(res, name, value, { maxAgeSeconds } = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (typeof maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev.slice() : [prev]) : [];
  list.push(parts.join('; '));
  res.setHeader('Set-Cookie', list);
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAgeSeconds: 0 });
}

function sendRedirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function createSessionToken(payloadObj) {
  const auth = loadAuthConfig();
  const secret = auth?.secret;
  if (!secret) return null;
  const payload = JSON.stringify(payloadObj);
  const payloadB64 = base64UrlEncode(payload);
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64');
  const sigB64 = sig.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  return `${payloadB64}.${sigB64}`;
}

function verifySessionToken(token) {
  const auth = loadAuthConfig();
  const secret = auth?.secret;
  if (!secret || !token || typeof token !== 'string') return null;
  const [payloadB64, sigB64] = token.split('.');
  if (!payloadB64 || !sigB64) return null;
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  if (expected.length !== sigB64.length) return null;
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigB64));
  if (!ok) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch {
    return null;
  }
  if (!payload?.expMs || Date.now() > payload.expMs) return null;
  if (payload.userType !== 'revisor' && payload.userType !== 'revisor-2fa') return null;
  return payload;
}

function issueRevisorSession(res, revisor) {
  const token = createSessionToken({
    userType: 'revisor',
    revisorId: revisor.id,
    email: revisor.email || revisor.username,
    username: revisor.email || revisor.username,
    displayName: revisor.displayName,
    expMs: Date.now() + 1000 * 60 * 60 * 12
  });
  if (!token) return false;
  setCookie(res, COOKIE_NAME, token, { maxAgeSeconds: 60 * 60 * 12 });
  clearCookie(res, TWOFA_COOKIE);
  return true;
}

function issuePending2fa(res, revisor) {
  const token = createSessionToken({
    userType: 'revisor-2fa',
    revisorId: revisor.id,
    expMs: Date.now() + 1000 * 60 * 10
  });
  if (!token) return false;
  clearCookie(res, COOKIE_NAME);
  setCookie(res, TWOFA_COOKIE, token, { maxAgeSeconds: 10 * 60 });
  return true;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const payload = verifySessionToken(cookies[COOKIE_NAME]);
  if (!payload || payload.userType !== 'revisor') return null;
  return payload;
}

function getPending2fa(req) {
  const cookies = parseCookies(req);
  const payload = verifySessionToken(cookies[TWOFA_COOKIE]);
  if (!payload || payload.userType !== 'revisor-2fa') return null;
  return payload;
}

function requireRevisor(req) {
  const session = getSession(req);
  if (!session) return null;
  if (session.revisorId && session.revisorId !== 'legacy-admin') {
    const r = findRevisorById(session.revisorId);
    if (!r) return null;
  }
  return session;
}

// ── Jobs ──────────────────────────────────────────────────────────────────
function loadJobs() {
  if (!fs.existsSync(JOBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs), 'utf8');
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {})
  };
  res.writeHead(status, headers);
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function safeJoinPublic(filePath) {
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, '');
  const full = path.join(PUBLIC_DIR, normalized);
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    default: return 'application/octet-stream';
  }
}

function readBodyJson(req, maxBytes = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function enforceJsonContentType(req, res) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type && type !== 'application/json') {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}

function enforceRateLimit(req, res, key, opts) {
  const result = security.rateLimit(req, key, opts);
  if (result.ok) return true;
  sendJson(res, 429, { error: 'Too many requests. Please wait and try again.' }, {
    'Retry-After': String(result.retryAfter)
  });
  return false;
}

async function requireHuman(req, res, body) {
  const auth = loadAuthConfig();
  const turnstile = security.loadTurnstileConfig(readAuthFile);
  const check = await security.assertHuman(req, body, { secret: auth?.secret, turnstile });
  if (check.ok) return true;
  sendJson(res, check.status || 403, { error: check.error || 'Verification failed' });
  return false;
}

async function handleTranslate(req, res) {
  if (!enforceJsonContentType(req, res)) return;
  if (!enforceRateLimit(req, res, 'translate', { limit: 8, windowMs: 60 * 1000 })) return;
  const body = await readBodyJson(req, MAX_TRANSLATE_BODY);
  if (!(await requireHuman(req, res, body))) return;

  const text = security.sanitizeText(body.text);
  const language = security.sanitizeLanguage(body.language);
  if (!text || !language) return sendJson(res, 400, { error: 'Missing text or language' });
  const apiKey = loadAnthropicApiKey();
  if (!apiKey) {
    const demoTranslation =
      language === 'Dutch' ? `[DEMO] ${text}` : `[DEMO ${language}] ${text}`;
    return sendJson(res, 200, { translation: demoTranslation });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: `You are a professional translation engine. Translate the user's English text to ${language}. Return ONLY the translated text — no explanations, no quotes, no preamble.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('[LingoCheck] Translation API error:', response.status, data?.error?.type || '', data?.error?.message || '');
      return sendJson(res, 502, { error: 'Translation service unavailable' });
    }

    const translation = security.sanitizeText(data.content?.[0]?.text || '', 8000);
    return sendJson(res, 200, { translation });
  } catch (e) {
    console.error('[LingoCheck] Translation failed:', e?.message || e);
    return sendJson(res, 502, { error: 'Translation service unavailable' });
  }
}

async function handleJobsCreate(req, res) {
  if (!enforceJsonContentType(req, res)) return;
  if (!enforceRateLimit(req, res, 'jobs-create', { limit: 5, windowMs: 60 * 1000 })) return;
  const body = await readBodyJson(req, MAX_JOB_BODY);
  if (!(await requireHuman(req, res, body))) return;
  let job;
  try {
    job = security.buildClientJob(body);
  } catch (err) {
    return sendJson(res, 400, { error: err.message || 'Invalid job' });
  }
  const jobs = loadJobs();
  const openForClient = jobs.filter(j => j.clientId === job.clientId && j.status !== 'complete').length;
  if (openForClient >= 20) return sendJson(res, 429, { error: 'Too many open translations for this session' });
  jobs.push(job);
  saveJobs(jobs);
  return sendJson(res, 200, security.publicJob(job));
}

async function handleRevisorClaim(req, res, id, session) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return sendJson(res, 404, { error: 'Job not found' });
  const job = jobs[idx];
  if (job.claimedByRevisorId && job.claimedByRevisorId !== session.revisorId) {
    return sendJson(res, 409, { error: 'Job already claimed by another revisor' });
  }
  jobs[idx] = {
    ...job,
    claimedByRevisorId: session.revisorId,
    claimedAt: job.claimedAt || Date.now()
  };
  saveJobs(jobs);
  return sendJson(res, 200, security.revisorJob(jobs[idx]));
}

async function handleRevisorPatch(req, res, id, session) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return sendJson(res, 404, { error: 'Job not found' });
  const job = jobs[idx];
  if (!job.claimedByRevisorId) return sendJson(res, 403, { error: 'Claim this job first' });
  if (job.claimedByRevisorId !== session.revisorId) {
    return sendJson(res, 403, { error: 'This job is claimed by another revisor' });
  }
  const body = await readBodyJson(req);
  const revised = typeof body.revisedTranslation === 'string'
    ? security.sanitizeText(body.revisedTranslation, 8000)
    : job.revisedTranslation;
  const merged = { ...job, revisedTranslation: revised };
  const completing = body.status === 'complete' && job.status !== 'complete';
  if (completing) {
    if (!revised) return sendJson(res, 400, { error: 'Translation is required' });
    merged.status = 'complete';
    merged.completedByRevisorId = session.revisorId;
    merged.completedAt = Date.now();
  }
  jobs[idx] = merged;
  saveJobs(jobs);
  if (completing) {
    const mail = await sendDeliveryEmail(req, merged);
    if (mail.sent) {
      jobs[idx] = { ...merged, deliveryEmailedAt: Date.now() };
      saveJobs(jobs);
    }
  }
  return sendJson(res, 200, security.revisorJob(jobs[idx]));
}

function serveStatic(req, res, pathname, { defaultFile } = {}) {
  const rel = pathname === '/' ? (defaultFile || '/index.html') : pathname;
  const full = safeJoinPublic(rel);
  if (!full) return sendText(res, 404, 'Not found');
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return sendText(res, 404, 'Not found');

  const buf = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(full),
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache'
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    security.applySecurityHeaders(res);
    const method = (req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(method)) {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.length > 256) return sendJson(res, 414, { error: 'URI too long' });

    // Pages
    if (method === 'GET' && pathname === '/') return serveStatic(req, res, '/', { defaultFile: '/index.html' });
    if (method === 'GET' && pathname === '/login') return serveStatic(req, res, '/login.html');
    if (method === 'GET' && pathname === '/revisor') {
      if (!requireRevisor(req)) return sendRedirect(res, '/login');
      return serveStatic(req, res, '/revisor.html');
    }

    // Public bot-detection helpers
    if (method === 'GET' && pathname === '/api/public-config') {
      if (!enforceRateLimit(req, res, 'public-config', { limit: 60, windowMs: 60 * 1000 })) return;
      const turnstile = security.loadTurnstileConfig(readAuthFile);
      return sendJson(res, 200, { turnstileSiteKey: turnstile.enabled ? turnstile.siteKey : null });
    }
    if (method === 'GET' && pathname === '/api/challenge') {
      if (!enforceRateLimit(req, res, 'challenge', { limit: 30, windowMs: 60 * 1000 })) return;
      const auth = loadAuthConfig();
      if (!auth?.secret) return sendJson(res, 500, { error: 'Server auth is not configured' });
      return sendJson(res, 200, { token: security.issueChallenge(auth.secret, req) });
    }

    // Auth
    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = requireRevisor(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        revisorId: session.revisorId,
        email: session.email || session.username,
        username: session.email || session.username,
        displayName: session.displayName
      });
    }
    if (method === 'POST' && pathname === '/api/auth/signup') {
      if (!enforceJsonContentType(req, res)) return;
      if (!enforceRateLimit(req, res, 'signup', { limit: 5, windowMs: 15 * 60 * 1000 })) return;
      const body = await readBodyJson(req, 16 * 1024);
      const { displayName, password } = body;
      const auth = loadAuthConfig();
      if (!auth) return sendJson(res, 500, { error: 'Server auth is not configured (SESSION_SECRET missing)' });
      const email = normalizeEmail(body.email || body.username);
      const dn = String(displayName || '').trim();
      const pw = String(password || '');
      if (!email) return sendJson(res, 400, { error: 'Email address is required' });
      if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address' });
      const pwErr = passwordPolicyError(pw);
      if (pwErr) return sendJson(res, 400, { error: pwErr, checks: passwordChecks(pw) });
      try {
        const r = createRevisor({ email, displayName: dn, password: pw });
        const challenge = await startEmailTwoFactor(res, r);
        if (!challenge) return sendJson(res, 500, { error: 'Could not start verification' });
        return sendJson(res, 200, challenge);
      } catch (e) {
        return sendJson(res, 409, { error: e.message || 'Could not create account' });
      }
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      if (!enforceJsonContentType(req, res)) return;
      if (!enforceRateLimit(req, res, 'login', { limit: 10, windowMs: 15 * 60 * 1000 })) return;
      const body = await readBodyJson(req, 16 * 1024);
      const { password } = body;
      const auth = loadAuthConfig();
      if (!auth) return sendJson(res, 500, { error: 'Server auth is not configured' });
      const email = normalizeEmail(body.email || body.username);
      if (!email) return sendJson(res, 400, { error: 'Email address is required' });
      if (!isValidEmail(email)) return sendJson(res, 400, { error: 'Enter a valid email address' });

      const r = findRevisorByLogin(email, password);
      if (r) {
        const challenge = await startEmailTwoFactor(res, r);
        if (!challenge) return sendJson(res, 500, { error: 'Could not start verification' });
        return sendJson(res, 200, challenge);
      }

      if (auth.legacyUser && auth.legacyPass &&
          normalizeEmail(auth.legacyUser) === email && (password || '') === auth.legacyPass) {
        const fakeAdmin = { id: 'legacy-admin', email, username: email, displayName: 'Admin' };
        if (!issueRevisorSession(res, fakeAdmin)) return sendJson(res, 500, { error: 'Could not create session' });
        return sendJson(res, 200, { ok: true, revisor: fakeAdmin });
      }

      return sendJson(res, 401, { error: 'Invalid credentials' });
    }
    if (method === 'POST' && pathname === '/api/auth/2fa/resend') {
      const pending = getPending2fa(req);
      if (!pending) return sendJson(res, 401, { error: 'Verification expired. Sign in again.' });
      const r = findRevisorById(pending.revisorId);
      if (!r) return sendJson(res, 401, { error: 'Unauthorized' });
      const otp = issueEmailOtp(r.id);
      if (!otp) return sendJson(res, 500, { error: 'Could not send a new code' });
      const mail = await sendLoginCodeEmail(otp.email, otp.code);
      const payload = { ok: true, emailMasked: otp.emailMasked, delivered: mail.sent };
      if (!mail.sent) payload.code = otp.code;
      return sendJson(res, 200, payload);
    }
    if (method === 'POST' && pathname === '/api/auth/2fa/verify') {
      const pending = getPending2fa(req);
      if (!pending) return sendJson(res, 401, { error: 'Verification expired. Sign in again.' });
      const r = findRevisorById(pending.revisorId);
      if (!r) return sendJson(res, 401, { error: 'Unauthorized' });
      const allowed = twoFaAllowed(r.id);
      if (!allowed.ok) return sendJson(res, 429, { error: allowed.error });
      const body = await readBodyJson(req);
      if (!verifyEmailOtp(r, body.code)) {
        recordTwoFaFailure(r.id);
        return sendJson(res, 401, { error: 'Invalid or expired code' });
      }
      recordTwoFaSuccess(r.id);
      const updated = updateRevisor(r.id, { otpHash: null, otpExpiresAt: null });
      if (!issueRevisorSession(res, updated || r)) return sendJson(res, 500, { error: 'Could not create session' });
      return sendJson(res, 200, { ok: true, revisor: publicRevisor(updated || r) });
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      clearCookie(res, COOKIE_NAME);
      clearCookie(res, TWOFA_COOKIE);
      return sendJson(res, 200, { ok: true });
    }

    // Public client APIs
    if (method === 'GET' && pathname === '/api/jobs') {
      if (!enforceRateLimit(req, res, 'jobs-list', { limit: 40, windowMs: 60 * 1000 })) return;
      const clientId = security.sanitizeClientId(url.searchParams.get('clientId'));
      if (!clientId) return sendJson(res, 400, { error: 'clientId is required' });
      const mine = loadJobs().filter(j => j.clientId === clientId).map(security.publicJob);
      return sendJson(res, 200, mine);
    }
    if (method === 'GET' && pathname.startsWith('/api/jobs/')) {
      if (!enforceRateLimit(req, res, 'jobs-get', { limit: 40, windowMs: 60 * 1000 })) return;
      const rest = pathname.slice('/api/jobs/'.length);
      const sourceMatch = rest.match(/^([A-Za-z0-9_-]{6,64})\/source$/);
      const id = sourceMatch ? sourceMatch[1] : rest;
      if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return sendJson(res, 400, { error: 'Invalid job' });
      const clientId = security.sanitizeClientId(url.searchParams.get('clientId'));
      const token = String(url.searchParams.get('token') || url.searchParams.get('t') || '');
      if (!clientId && !token) return sendJson(res, 400, { error: 'clientId is required' });
      const job = loadJobs().find(j => j.id === id);
      if (!job || !security.canAccessJob(job, { clientId, token })) {
        return sendJson(res, 404, { error: 'Job not found' });
      }
      if (sourceMatch) {
        const source = security.sourceFileForDownload(job);
        if (!source) return sendJson(res, 404, { error: 'No original file' });
        return sendJson(res, 200, source);
      }
      return sendJson(res, 200, security.publicJob(job));
    }
    if (method === 'POST' && pathname === '/api/jobs') return await handleJobsCreate(req, res);
    if (method === 'POST' && pathname === '/api/translate') return await handleTranslate(req, res);

    // Revisor (protected) APIs
    if (pathname.startsWith('/api/revisor/')) {
      const session = requireRevisor(req);
      if (!session) return sendJson(res, 401, { error: 'Unauthorized' });

      // GET /api/revisor/jobs?scope=mine|all
      if (method === 'GET' && pathname === '/api/revisor/jobs') {
        const scope = url.searchParams.get('scope') || 'mine';
        const all = loadJobs();
        if (scope === 'all') return sendJson(res, 200, all.map(security.revisorJob));
        const mine = all.filter(j => j.claimedByRevisorId === session.revisorId || j.completedByRevisorId === session.revisorId);
        return sendJson(res, 200, mine.map(security.revisorJob));
      }

      // GET /api/revisor/me/finance
      if (method === 'GET' && pathname === '/api/revisor/me/finance') {
        const all = loadJobs();
        const mine = all.filter(j => j.completedByRevisorId === session.revisorId && j.status === 'complete');
        const items = mine.map(j => ({
          id: j.id,
          language: j.language,
          completedAt: j.completedAt || j.createdAt,
          sourceWordCount: typeof j.sourceWordCount === 'number' ? j.sourceWordCount : countWords(j.originalText),
          earningsCents: Math.round((typeof j.sourceWordCount === 'number' ? j.sourceWordCount : countWords(j.originalText)) * PAYOUT_PER_WORD_CENTS)
        }));
        return sendJson(res, 200, {
          ratePerWordCents: PAYOUT_PER_WORD_CENTS,
          currency: 'EUR',
          items
        });
      }

      // POST /api/revisor/jobs/:id/claim
      const claimMatch = pathname.match(/^\/api\/revisor\/jobs\/([^\/]+)\/claim$/);
      if (method === 'POST' && claimMatch) {
        return await handleRevisorClaim(req, res, claimMatch[1], session);
      }

      // PATCH /api/revisor/jobs/:id
      if (method === 'PATCH' && pathname.startsWith('/api/revisor/jobs/')) {
        const id = pathname.slice('/api/revisor/jobs/'.length);
        return await handleRevisorPatch(req, res, id, session);
      }

      return sendJson(res, 404, { error: 'Not found' });
    }

    return serveStatic(req, res, pathname);
  } catch (e) {
    const msg = e?.message || 'Internal error';
    if (msg === 'Payload too large') return sendJson(res, 413, { error: msg });
    if (msg === 'Invalid JSON') return sendJson(res, 400, { error: msg });
    console.error('[LingoCheck]', msg);
    return sendJson(res, 500, { error: 'Internal error' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  ensureAuthConfig();
  const smtp = loadSmtpConfig();
  console.log(`LingoCheck running on port ${PORT}`);
  if (smtp.host) console.log(`[LingoCheck] Email sending ready via ${smtp.host} as ${smtp.user}`);
  else console.log(`[LingoCheck] Email sending not configured (missing ${smtp.missing.join(', ')} in auth.local.json)`);
  const turnstile = security.loadTurnstileConfig(readAuthFile);
  if (turnstile.enabled) console.log('[LingoCheck] Cloudflare Turnstile bot check enabled');
  else console.log('[LingoCheck] Cloudflare Turnstile not configured — using challenge token + honeypot. Add TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY to auth.local.json for production.');
  if (loadAnthropicApiKey()) console.log('[LingoCheck] Translation API ready');
  else console.log('[LingoCheck] Translation API not configured — demo mode. Add ANTHROPIC_API_KEY to auth.local.json.');
});
