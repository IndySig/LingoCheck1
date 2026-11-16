#!/usr/bin/env node
/**
 * LingoCheck end-to-end smoke: client + revisor happy path.
 * Pure Node ≥18 — geen extra dependencies.
 *
 * Env:
 *   BASE_URL      default http://127.0.0.1:5001
 *   SMOKE_START=1 start server.js zelf (child process)
 *   SMOKE_KEEP=1  laat smoke-jobs/revisors staan (default: laat staan; geen delete-API)
 */
'use strict';

const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const BASE_URL = String(process.env.BASE_URL || 'http://127.0.0.1:5001').replace(/\/$/, '');
const SMOKE_START = process.env.SMOKE_START === '1';
const SMOKE_KEEP = process.env.SMOKE_KEEP === '1' || process.env.SMOKE_KEEP === undefined;

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const results = [];
let stepNo = 0;
let serverChild = null;
let failedRole = null;

const cookieJar = new Map();

function log(msg) {
  console.log(msg);
}

function record(status, description, detail) {
  stepNo += 1;
  const num = String(stepNo).padStart(2, '0');
  const label = `${num}. ${description}`;
  results.push({ status, description, detail: detail || '', role: currentRole });
  if (status === 'PASS') {
    log(`${GREEN}✓ PASS${RESET}  ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
  } else if (status === 'SKIP' || status === 'WARN') {
    log(`${YELLOW}⚠ ${status}${RESET}  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    log(`${RED}✗ FAIL${RESET}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!failedRole) failedRole = currentRole;
  }
}

let currentRole = 'basis';

function setRole(role) {
  currentRole = role;
}

function assert(ok, description, detail) {
  if (ok) record('PASS', description, detail);
  else record('FAIL', description, detail);
  return !!ok;
}

function warn(description, detail) {
  record('WARN', description, detail);
}

function skip(description, detail) {
  record('SKIP', description, detail);
}

function parseSetCookie(raw) {
  const out = [];
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  for (const line of list) {
    const parts = String(line).split(';');
    const [nv, ...attrs] = parts;
    const eq = nv.indexOf('=');
    if (eq === -1) continue;
    const name = nv.slice(0, eq).trim();
    const value = nv.slice(eq + 1).trim();
    let maxAge = null;
    for (const a of attrs) {
      const t = a.trim();
      const m = /^Max-Age=(\d+)$/i.exec(t);
      if (m) maxAge = Number(m[1]);
    }
    out.push({ name, value, maxAge });
  }
  return out;
}

function storeCookies(res) {
  let raw = [];
  if (typeof res.headers.getSetCookie === 'function') {
    raw = res.headers.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) raw = [single];
  }
  for (const c of parseSetCookie(raw)) {
    if (c.maxAge === 0 || c.value === '') cookieJar.delete(c.name);
    else cookieJar.set(c.name, c.value);
  }
}

function cookieHeader() {
  if (!cookieJar.size) return '';
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function clearCookies() {
  cookieJar.clear();
}

async function request(method, pathname, { json, headers, expectJson } = {}) {
  const url = new URL(pathname.startsWith('http') ? pathname : BASE_URL + pathname);
  const hdrs = Object.assign({ Accept: 'application/json, text/html, */*' }, headers || {});
  const cookie = cookieHeader();
  if (cookie) hdrs.Cookie = cookie;
  let body;
  if (json !== undefined) {
    body = JSON.stringify(json);
    hdrs['Content-Type'] = 'application/json';
    hdrs['Content-Length'] = Buffer.byteLength(body);
  }

  const lib = url.protocol === 'https:' ? https : http;
  const res = await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: hdrs,
        timeout: 30000
      },
      (incoming) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(c));
        incoming.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          resolve({
            status: incoming.statusCode || 0,
            headers: incoming.headers,
            text,
            buf,
            getSetCookie() {
              const sc = incoming.headers['set-cookie'];
              return Array.isArray(sc) ? sc : sc ? [sc] : [];
            },
            headersObj: {
              get(name) {
                const v = incoming.headers[String(name).toLowerCase()];
                return Array.isArray(v) ? v[0] : v || null;
              },
              getSetCookie() {
                const sc = incoming.headers['set-cookie'];
                return Array.isArray(sc) ? sc : sc ? [sc] : [];
              }
            }
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
    });
    if (body) req.write(body);
    req.end();
  });

  // Adapt for storeCookies
  const adapted = {
    headers: res.headersObj,
    status: res.status,
    text: res.text,
    json: null
  };
  storeCookies(adapted);

  if (expectJson !== false) {
    const ct = String(res.headers['content-type'] || '');
    if (ct.includes('application/json') || (res.text && /^[\s]*[{[]/.test(res.text))) {
      try {
        adapted.json = JSON.parse(res.text);
      } catch {
        adapted.json = null;
      }
    }
  }
  return adapted;
}

async function getChallengeToken() {
  const res = await request('GET', '/api/challenge');
  const token = res.json && res.json.token;
  if (res.status !== 200 || !token) {
    throw new Error(`challenge mislukt (${res.status}): ${res.text.slice(0, 120)}`);
  }
  return token;
}

function randId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request('GET', '/api/public-config', { expectJson: true });
      if (res.status === 200) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message || String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server niet bereikbaar op ${BASE_URL} (${lastErr})`);
}

async function maybeStartServer() {
  if (!SMOKE_START) return;
  const port = new URL(BASE_URL).port || '5001';
  serverChild = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { PORT: String(port) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverChild.stdout.on('data', () => {});
  serverChild.stderr.on('data', () => {});
  serverChild.on('exit', (code) => {
    if (code && code !== 0) {
      // parent will notice via failed requests
    }
  });
}

function stopServer() {
  if (!serverChild || serverChild.killed) return;
  try {
    serverChild.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

async function runBasis() {
  setRole('basis');
  log(`\n${DIM}── A. Basis / pages ──${RESET}`);

  for (const p of ['/', '/login', '/privacy', '/about']) {
    const res = await request('GET', p, { expectJson: false });
    const ct = String(res.headers.get('content-type') || '');
    assert(
      res.status === 200 && ct.includes('text/html'),
      `Pagina ${p} laadt (HTML 200)`,
      `status=${res.status} type=${ct || '?'}`
    );
  }

  {
    const res = await request('GET', '/revisor', { expectJson: false });
    // Zonder sessie redirect naar /login — dat is correct gedrag.
    assert(
      res.status === 302 || res.status === 200,
      'Pagina /revisor (redirect zonder login of HTML met sessie)',
      `status=${res.status}`
    );
  }

  {
    const res = await request('GET', '/api/public-config');
    assert(
      res.status === 200 && res.json && Array.isArray(res.json.languages),
      'GET /api/public-config',
      res.status === 200 ? `talen=${(res.json.languages || []).length}` : res.text.slice(0, 80)
    );
  }

  {
    const res = await request('GET', '/api/challenge');
    assert(
      res.status === 200 && res.json && typeof res.json.token === 'string' && res.json.token.length > 20,
      'GET /api/challenge → challengeToken',
      res.status === 200 ? 'token ok' : res.text.slice(0, 80)
    );
  }
}

async function runClientAndRevisor() {
  const clientId = randId('smoke_');
  const clientEmail = 'smoke-client@example.com';
  const originalText = 'Hello smoke test. Please review this short English paragraph.';
  const aiTranslation = 'Hallo smoke-test. Beoordeel deze korte Engelse alinea.';
  const ts = Date.now();
  const revisorEmail = `smoke-revisor-${ts}@example.com`;
  const password = 'SmokeTest!2345';
  const phone = '+31612345678';

  let jobId = null;
  let qaJobId = null;

  setRole('client');
  log(`\n${DIM}── B. Client-flow ──${RESET}`);

  // B1 challenge
  let challengeToken;
  try {
    challengeToken = await getChallengeToken();
    assert(true, 'Challenge ophalen voor job-aanmaak');
  } catch (e) {
    assert(false, 'Challenge ophalen voor job-aanmaak', e.message);
    return;
  }

  // B2 create job
  {
    const res = await request('POST', '/api/jobs', {
      json: {
        clientId,
        clientEmail,
        privacyAccepted: true,
        challengeToken,
        sourceLanguage: 'English',
        language: 'Dutch',
        originalText,
        aiTranslation,
        lc_hp_fax: ''
      }
    });
    jobId = res.json && res.json.id;
    assert(
      res.status === 200 && jobId,
      'Job aanmaken (POST /api/jobs)',
      jobId ? `id=${jobId}` : `status=${res.status} ${JSON.stringify(res.json || res.text).slice(0, 120)}`
    );
  }

  // Optional qaOnly job
  try {
    const tok = await getChallengeToken();
    const res = await request('POST', '/api/jobs', {
      json: {
        clientId,
        clientEmail,
        privacyAccepted: true,
        challengeToken: tok,
        sourceLanguage: 'English',
        language: 'Dutch',
        originalText,
        customerTranslation: aiTranslation,
        aiTranslation: '[QA] ' + aiTranslation,
        qaOnly: true,
        lc_hp_fax: ''
      }
    });
    qaJobId = res.json && res.json.id;
    assert(
      res.status === 200 && qaJobId && res.json.qaOnly === true,
      'QA-only job aanmaken (optioneel)',
      qaJobId ? `id=${qaJobId}` : `status=${res.status}`
    );
  } catch (e) {
    assert(false, 'QA-only job aanmaken (optioneel)', e.message);
  }

  // B3 list
  {
    const res = await request('GET', `/api/jobs?clientId=${encodeURIComponent(clientId)}`);
    const list = Array.isArray(res.json) ? res.json : [];
    assert(
      res.status === 200 && list.some((j) => j.id === jobId),
      'Jobs ophalen voor clientId',
      `count=${list.length}`
    );
  }

  // B4 get one
  {
    const res = await request('GET', `/api/jobs/${jobId}?clientId=${encodeURIComponent(clientId)}`);
    assert(
      res.status === 200 && res.json && res.json.id === jobId,
      'Enkele job ophalen',
      res.status === 200 ? `status=${res.json.status}` : res.text.slice(0, 80)
    );
  }

  // Extra: other clientId → 404
  {
    const other = randId('smoke_');
    const res = await request('GET', `/api/jobs/${jobId}?clientId=${encodeURIComponent(other)}`);
    assert(res.status === 404, 'Andere clientId → 404', `status=${res.status}`);
  }

  // Soft: qa-check
  try {
    const tok = await getChallengeToken();
    const res = await request('POST', '/api/qa-check', {
      json: {
        challengeToken: tok,
        text: aiTranslation,
        sourceText: originalText,
        language: 'Dutch',
        sourceLanguage: 'English',
        lc_hp_fax: ''
      }
    });
    if (res.status === 200 && res.json && res.json.checkedTranslation) {
      assert(true, 'Soft: POST /api/qa-check (demo zonder API-key mag)', 'ok');
    } else {
      warn('Soft: POST /api/qa-check', `status=${res.status} ${JSON.stringify(res.json || {}).slice(0, 100)}`);
    }
  } catch (e) {
    warn('Soft: POST /api/qa-check', e.message);
  }

  // Soft: translate
  try {
    const tok = await getChallengeToken();
    const res = await request('POST', '/api/translate', {
      json: {
        challengeToken: tok,
        text: 'Smoke translate please.',
        language: 'Dutch',
        sourceLanguage: 'English',
        lc_hp_fax: ''
      }
    });
    if (res.status === 200 && res.json && res.json.translation) {
      const demo = String(res.json.translation).startsWith('[DEMO');
      assert(true, 'Soft: POST /api/translate', demo ? 'demo-mode (geen Anthropic key)' : 'live translation');
    } else if (res.status === 502 || /unavailable|api key|anthropic/i.test(JSON.stringify(res.json || res.text))) {
      warn('Soft: POST /api/translate — Anthropic key ontbreekt of service down', `status=${res.status}`);
    } else {
      warn('Soft: POST /api/translate', `status=${res.status}`);
    }
  } catch (e) {
    warn('Soft: POST /api/translate', e.message);
  }

  // ── C. Revisor ──
  setRole('revisor');
  log(`\n${DIM}── C. Revisor-flow ──${RESET}`);

  // Extra: unauthorized without cookie
  clearCookies();
  {
    const res = await request('GET', '/api/revisor/jobs?scope=all');
    assert(res.status === 401, 'Ongeautoriseerde revisor-call → 401', `status=${res.status}`);
  }

  // C1 signup
  let otpCode = null;
  {
    const res = await request('POST', '/api/auth/signup', {
      json: {
        email: revisorEmail,
        displayName: 'Smoke Revisor',
        password,
        phone,
        languages: ['Dutch']
      }
    });
    const ok = res.status === 200 && res.json && res.json.requires2fa;
    otpCode = res.json && res.json.code;
    assert(
      ok,
      'Signup revisor',
      ok
        ? `email=${revisorEmail}${otpCode ? ' (code in response)' : res.json.delivered ? ' (mail verstuurd)' : ''}`
        : `status=${res.status} ${JSON.stringify(res.json || res.text).slice(0, 140)}`
    );
    if (!ok) return;
  }

  // C2 get 2FA code
  if (!otpCode) {
    const res = await request('POST', '/api/auth/2fa/resend', { json: {} });
    otpCode = res.json && res.json.code;
    assert(
      res.status === 200 && otpCode,
      '2FA code ophalen via resend',
      otpCode ? 'code ontvangen' : `status=${res.status} delivered=${res.json && res.json.delivered}`
    );
    if (!otpCode) return;
  } else {
    assert(true, '2FA code uit signup-response', 'code aanwezig (mail niet verstuurd)');
  }

  // C3 verify 2FA
  {
    const res = await request('POST', '/api/auth/2fa/verify', { json: { code: otpCode } });
    assert(
      res.status === 200 && res.json && res.json.ok,
      '2FA verifiëren + sessie-cookie',
      res.status === 200 ? 'ok' : JSON.stringify(res.json || res.text).slice(0, 120)
    );
    if (res.status !== 200) return;
  }

  // C4 me
  {
    const res = await request('GET', '/api/auth/me');
    assert(
      res.status === 200 && res.json && res.json.authenticated === true,
      'GET /api/auth/me → authenticated',
      res.json && res.json.email ? `email=${res.json.email}` : ''
    );
  }

  // /revisor page with session
  {
    const res = await request('GET', '/revisor', { expectJson: false });
    const ct = String(res.headers.get('content-type') || '');
    assert(
      res.status === 200 && ct.includes('text/html'),
      'Pagina /revisor met sessie (HTML 200)',
      `status=${res.status}`
    );
  }

  // C5 jobs visible
  {
    const res = await request('GET', '/api/revisor/jobs?scope=all');
    const list = Array.isArray(res.json) ? res.json : [];
    const found = list.some((j) => j.id === jobId);
    assert(found, 'Client-job zichtbaar voor revisor (scope=all)', found ? `id=${jobId}` : `count=${list.length}`);
    if (!found) return;
  }

  // C6 claim
  {
    const res = await request('POST', `/api/revisor/jobs/${jobId}/claim`, { json: {} });
    assert(
      res.status === 200 && res.json && res.json.claimedByRevisorId,
      'Job claimen',
      res.status === 200 ? `status=${res.json.status}` : JSON.stringify(res.json || {}).slice(0, 100)
    );
    if (res.status !== 200) return;
  }

  // C7 question
  {
    const res = await request('POST', `/api/revisor/jobs/${jobId}/question`, {
      json: { question: 'Smoke: klopt de aanspreekvorm?' }
    });
    assert(
      res.status === 200 && res.json && res.json.clientQuestion,
      'Vraag stellen aan client',
      res.status === 200 ? 'vraag gezet' : JSON.stringify(res.json || {}).slice(0, 100)
    );
  }

  // B5 client reply
  setRole('client');
  {
    let tok;
    try {
      tok = await getChallengeToken();
    } catch (e) {
      assert(false, 'Client reply: challenge', e.message);
      return;
    }
    const res = await request('POST', `/api/jobs/${jobId}/reply`, {
      json: {
        clientId,
        challengeToken: tok,
        reply: 'Ja, u-vorm is goed. Smoke antwoord.',
        lc_hp_fax: ''
      }
    });
    assert(
      res.status === 200 && res.json && res.json.clientReply,
      'Client beantwoordt revisor-vraag',
      res.status === 200 ? 'reply gezet' : JSON.stringify(res.json || {}).slice(0, 120)
    );
  }

  // C9 complete
  setRole('revisor');
  {
    const revised = aiTranslation + ' (gereviseerd smoke)';
    const res = await request('PATCH', `/api/revisor/jobs/${jobId}`, {
      json: {
        revisedTranslation: revised,
        status: 'complete'
      }
    });
    assert(
      res.status === 200 && res.json && res.json.status === 'complete',
      'Revisor completeert job',
      res.status === 200 ? 'complete' : JSON.stringify(res.json || {}).slice(0, 140)
    );
    if (res.status !== 200) return;
  }

  // B6 revision request
  setRole('client');
  {
    let tok;
    try {
      tok = await getChallengeToken();
    } catch (e) {
      assert(false, 'Correctieronde: challenge', e.message);
      return;
    }
    const res = await request('POST', `/api/jobs/${jobId}/revision`, {
      json: {
        clientId,
        challengeToken: tok,
        note: 'Smoke correctie: graag iets formeler.',
        lc_hp_fax: ''
      }
    });
    assert(
      res.status === 200 && res.json && res.json.revisionRound === 1,
      'Client vraagt correctieronde',
      res.status === 200 ? `status=${res.json.status}` : JSON.stringify(res.json || {}).slice(0, 120)
    );
    if (res.status !== 200) return;
  }

  // C11 reclaim + complete again
  setRole('revisor');
  {
    const claim = await request('POST', `/api/revisor/jobs/${jobId}/claim`, { json: {} });
    assert(
      claim.status === 200,
      'Revisor claimt revision-job opnieuw',
      claim.status === 200 ? 'claimed' : JSON.stringify(claim.json || {}).slice(0, 100)
    );
    if (claim.status !== 200) return;

    const revised2 = aiTranslation + ' (correctieronde smoke)';
    const done = await request('PATCH', `/api/revisor/jobs/${jobId}`, {
      json: {
        revisedTranslation: revised2,
        status: 'complete'
      }
    });
    assert(
      done.status === 200 && done.json && done.json.status === 'complete',
      'Revisor completeert na correctieronde',
      done.status === 200 ? 'complete' : JSON.stringify(done.json || {}).slice(0, 140)
    );
  }

  // C12 finance
  {
    const res = await request('GET', '/api/revisor/me/finance');
    assert(
      res.status === 200 && res.json && Array.isArray(res.json.items),
      'GET /api/revisor/me/finance',
      res.status === 200 ? `items=${res.json.items.length}` : ''
    );
  }

  // C13 account update
  {
    const res = await request('POST', '/api/revisor/account', {
      json: {
        displayName: 'Smoke Revisor Updated',
        phone: '+31687654321',
        languages: ['Dutch']
      }
    });
    assert(
      res.status === 200 && res.json && res.json.ok,
      'POST /api/revisor/account (kleine update)',
      res.status === 200 ? res.json.revisor && res.json.revisor.displayName : JSON.stringify(res.json || {}).slice(0, 100)
    );
  }

  // C14 logout
  {
    const out = await request('POST', '/api/auth/logout', { json: {} });
    assert(out.status === 200 && out.json && out.json.ok, 'POST /api/auth/logout');
    const me = await request('GET', '/api/auth/me');
    assert(
      me.status === 200 && me.json && me.json.authenticated === false,
      'Na logout: /api/auth/me unauthenticated'
    );
  }

  // C15 soft forgot-password
  {
    const res = await request('POST', '/api/auth/forgot-password', {
      json: { email: revisorEmail }
    });
    if (res.status === 200 && res.json && res.json.ok === true) {
      assert(true, 'Soft: POST /api/auth/forgot-password', '{ok:true}');
    } else {
      warn('Soft: POST /api/auth/forgot-password', `status=${res.status}`);
    }
  }

  if (!SMOKE_KEEP) {
    skip('Opruimen smoke-data', 'geen delete-API — jobs/revisors met smoke_ prefix blijven staan');
  } else {
    skip('Testdata laten staan (SMOKE_KEEP)', `clientId=${clientId}, revisor=${revisorEmail}`);
  }
}

function summarize() {
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP' || r.status === 'WARN').length;
  log('\n══════════════════════════════════════');
  log(`Totaal: ${passed} geslaagd, ${failed} mislukt, ${skipped} skip/warn`);
  if (failed) {
    log(`${RED}Mislukt in rol: ${failedRole || '?'}${RESET}`);
    for (const r of results.filter((x) => x.status === 'FAIL')) {
      log(`  - ${r.description}${r.detail ? `: ${r.detail}` : ''}`);
    }
  } else {
    log(`${GREEN}Alles OK — client én revisor happy path groen.${RESET}`);
  }
  log('══════════════════════════════════════\n');
  return failed === 0 ? 0 : 1;
}

async function main() {
  log(`LingoCheck smoke-flows`);
  log(`BASE_URL=${BASE_URL}`);
  if (SMOKE_START) log('SMOKE_START=1 → server wordt gestart');

  try {
    await maybeStartServer();
    await waitForServer(SMOKE_START ? 15000 : 3000);
  } catch (e) {
    log(`\n${RED}✗ Kan niet verbinden met ${BASE_URL}${RESET}`);
    log(`${DIM}${e.message}${RESET}`);
    log('Start eerst de server: npm start  (of start-lingocheck.ps1 op poort 5001)');
    log('Of: SMOKE_START=1 npm run smoke');
    process.exit(2);
  }

  try {
    await runBasis();
    await runClientAndRevisor();
  } catch (e) {
    assert(false, 'Onverwachte fout', e.message || String(e));
  } finally {
    stopServer();
  }

  process.exit(summarize());
}

main();
