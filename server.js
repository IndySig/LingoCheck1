const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const JOBS_FILE = path.join(__dirname, 'jobs.json');
const REVISORS_FILE = path.join(__dirname, 'revisors.json');
const COOKIE_NAME = 'lc_session';
const AUTH_FILE = path.join(__dirname, 'auth.local.json');

const PAYOUT_PER_WORD_CENTS = 2.5;

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

function createRevisor({ username, displayName, password }) {
  const revisors = loadRevisors();
  const exists = revisors.find(r => r.username.toLowerCase() === username.toLowerCase());
  if (exists) throw new Error('Username already taken');
  const salt = crypto.randomBytes(12).toString('hex');
  const passwordHash = hashPassword(password, salt);
  const revisor = {
    id: 'r_' + crypto.randomBytes(6).toString('hex'),
    username,
    displayName: displayName || username,
    salt,
    passwordHash,
    createdAt: Date.now()
  };
  revisors.push(revisor);
  saveRevisors(revisors);
  return revisor;
}

function findRevisorByLogin(username, password) {
  const revisors = loadRevisors();
  const r = revisors.find(x => x.username.toLowerCase() === (username || '').toLowerCase());
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
  return { id: r.id, username: r.username, displayName: r.displayName };
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
  res.setHeader('Set-Cookie', parts.join('; '));
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
  if (payload.userType !== 'revisor') return null;
  return payload;
}

function issueRevisorSession(res, revisor) {
  const token = createSessionToken({
    userType: 'revisor',
    revisorId: revisor.id,
    username: revisor.username,
    displayName: revisor.displayName,
    expMs: Date.now() + 1000 * 60 * 60 * 12
  });
  if (!token) return false;
  setCookie(res, COOKIE_NAME, token, { maxAgeSeconds: 60 * 60 * 12 });
  return true;
}

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  return verifySessionToken(token);
}

function requireRevisor(req) {
  const session = getSession(req);
  if (!session) return null;
  // For real revisors, ensure they still exist.
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

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
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

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleTranslate(req, res) {
  const { text, language } = await readBodyJson(req);
  if (!text || !language) return sendJson(res, 400, { error: 'Missing text or language' });
  if (!process.env.ANTHROPIC_API_KEY) {
    const trimmed = String(text).trim();
    const demoTranslation =
      String(language).toLowerCase() === 'dutch'
        ? `[DEMO] ${trimmed}`
        : `[DEMO ${language}] ${trimmed}`;
    return sendJson(res, 200, { translation: demoTranslation });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: `You are a professional translation engine. Translate the user's English text to ${language}. Return ONLY the translated text — no explanations, no quotes, no preamble.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data?.error?.message || `API error (${response.status})`;
      return sendJson(res, 500, { error: msg });
    }

    const translation = data.content?.[0]?.text || '';
    return sendJson(res, 200, { translation });
  } catch (e) {
    return sendJson(res, 500, { error: e?.message || 'Unknown error' });
  }
}

async function handleJobsCreate(req, res) {
  const jobs = loadJobs();
  const body = await readBodyJson(req);
  const job = {
    ...body,
    createdAt: Date.now(),
    sourceWordCount: countWords(body.originalText || ''),
    claimedByRevisorId: null,
    claimedAt: null,
    completedByRevisorId: null,
    completedAt: null
  };
  jobs.push(job);
  saveJobs(jobs);
  return sendJson(res, 200, job);
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
  return sendJson(res, 200, jobs[idx]);
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
  const merged = { ...job, ...body };
  if (body.status === 'complete') {
    merged.completedByRevisorId = session.revisorId;
    merged.completedAt = Date.now();
  }
  jobs[idx] = merged;
  saveJobs(jobs);
  return sendJson(res, 200, jobs[idx]);
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
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // Pages
    if (method === 'GET' && pathname === '/') return serveStatic(req, res, '/', { defaultFile: '/index.html' });
    if (method === 'GET' && pathname === '/login') return serveStatic(req, res, '/login.html');
    if (method === 'GET' && pathname === '/revisor') {
      if (!requireRevisor(req)) return sendRedirect(res, '/login');
      return serveStatic(req, res, '/revisor.html');
    }

    // Auth
    if (method === 'GET' && pathname === '/api/auth/me') {
      const session = requireRevisor(req);
      if (!session) return sendJson(res, 200, { authenticated: false });
      return sendJson(res, 200, {
        authenticated: true,
        revisorId: session.revisorId,
        username: session.username,
        displayName: session.displayName
      });
    }
    if (method === 'POST' && pathname === '/api/auth/signup') {
      const { username, displayName, password } = await readBodyJson(req);
      const auth = loadAuthConfig();
      if (!auth) return sendJson(res, 500, { error: 'Server auth is not configured (SESSION_SECRET missing)' });
      const u = String(username || '').trim();
      const dn = String(displayName || '').trim();
      const pw = String(password || '');
      if (!u || u.length < 3) return sendJson(res, 400, { error: 'Username must be at least 3 characters' });
      if (!/^[a-zA-Z0-9_.\-]+$/.test(u)) return sendJson(res, 400, { error: 'Username may contain only letters, numbers, _ . -' });
      if (!pw || pw.length < 6) return sendJson(res, 400, { error: 'Password must be at least 6 characters' });
      try {
        const r = createRevisor({ username: u, displayName: dn || u, password: pw });
        if (!issueRevisorSession(res, r)) return sendJson(res, 500, { error: 'Could not create session' });
        return sendJson(res, 200, { ok: true, revisor: publicRevisor(r) });
      } catch (e) {
        return sendJson(res, 409, { error: e.message || 'Could not create account' });
      }
    }
    if (method === 'POST' && pathname === '/api/auth/login') {
      const { username, password } = await readBodyJson(req);
      const auth = loadAuthConfig();
      if (!auth) return sendJson(res, 500, { error: 'Server auth is not configured' });

      // 1) Try revisors.json accounts
      const r = findRevisorByLogin(username, password);
      if (r) {
        if (!issueRevisorSession(res, r)) return sendJson(res, 500, { error: 'Could not create session' });
        return sendJson(res, 200, { ok: true, revisor: publicRevisor(r) });
      }

      // 2) Backward-compat: accept the legacy admin if configured
      if (auth.legacyUser && auth.legacyPass &&
          (username || '') === auth.legacyUser && (password || '') === auth.legacyPass) {
        const fakeAdmin = { id: 'legacy-admin', username: auth.legacyUser, displayName: 'Admin' };
        if (!issueRevisorSession(res, fakeAdmin)) return sendJson(res, 500, { error: 'Could not create session' });
        return sendJson(res, 200, { ok: true, revisor: fakeAdmin });
      }

      return sendJson(res, 401, { error: 'Invalid credentials' });
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      clearCookie(res, COOKIE_NAME);
      return sendJson(res, 200, { ok: true });
    }

    // Public client APIs
    if (method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, loadJobs());
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
        if (scope === 'all') return sendJson(res, 200, all);
        const mine = all.filter(j => j.claimedByRevisorId === session.revisorId || j.completedByRevisorId === session.revisorId);
        return sendJson(res, 200, mine);
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
    return sendJson(res, 500, { error: e?.message || 'Internal error' });
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  ensureAuthConfig();
  console.log(`LingoCheck running on port ${PORT}`);
});
