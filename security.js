const crypto = require('crypto');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ALLOWED_LANGUAGES = Object.freeze(['Dutch', 'Spanish', 'German']);
const MAX_TEXT_CHARS = 4000;
const MAX_CLIENT_ID_LEN = 64;
const MAX_FILENAME_LEN = 180;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DOCX_UNCOMPRESSED = 12 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_MIN_AGE_MS = 0;

const DANGEROUS_ZIP_NAME = /(?:^|[\\/])(?:vbaProject\.bin|vbaData\.xml|vbaProject\.bin\.rels)$/i;
const DANGEROUS_ZIP_EXT = /\.(?:exe|dll|com|scr|bat|cmd|ps1|vbs|js|jse|jar|hta|msi|pif|cpl|wsf|lnk)$/i;
const OLE_OR_MACRO_PATH = /(?:word\/embeddings\/|word\/activeX\/|word\/macros\/|xl\/vba|ppt\/vba)/i;

const rateBuckets = new Map();
const usedChallenges = new Map();

function loadTurnstileConfig(readAuthFile) {
  const file = typeof readAuthFile === 'function' ? readAuthFile() : {};
  const siteKey = String(process.env.TURNSTILE_SITE_KEY || file.TURNSTILE_SITE_KEY || '').trim();
  const secretKey = String(process.env.TURNSTILE_SECRET_KEY || file.TURNSTILE_SECRET_KEY || '').trim();
  if (!siteKey || !secretKey) return { enabled: false, siteKey: '', secretKey: '' };
  return { enabled: true, siteKey, secretKey };
}

function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return String(req.socket?.remoteAddress || 'unknown').slice(0, 64);
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdnjs.cloudflare.com https://challenges.cloudflare.com",
      "connect-src 'self' https://challenges.cloudflare.com",
      "frame-src https://challenges.cloudflare.com",
      "worker-src blob: https://cdnjs.cloudflare.com"
    ].join('; ')
  );
}

function pruneMap(map, now) {
  if (map.size < 4000) return;
  for (const [key, rec] of map) {
    if (rec.exp && rec.exp < now) map.delete(key);
    else if (rec.resetAt && rec.resetAt < now) map.delete(key);
  }
}

function rateLimit(req, key, { limit, windowMs }) {
  const now = Date.now();
  pruneMap(rateBuckets, now);
  const bucketKey = `${key}:${clientIp(req)}`;
  const rec = rateBuckets.get(bucketKey);
  if (!rec || rec.resetAt <= now) {
    rateBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }
  rec.count += 1;
  if (rec.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((rec.resetAt - now) / 1000));
    return { ok: false, retryAfter };
  }
  return { ok: true, remaining: Math.max(0, limit - rec.count) };
}

function signChallenge(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyChallengeToken(secret, token, req) {
  if (!secret || typeof token !== 'string' || token.length < 20 || token.length > 800) {
    return { ok: false, error: 'Verification expired. Refresh and try again.' };
  }
  const [body, sig] = token.split('.');
  if (!body || !sig) return { ok: false, error: 'Verification expired. Refresh and try again.' };
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  if (expected.length !== sig.length) return { ok: false, error: 'Verification expired. Refresh and try again.' };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return { ok: false, error: 'Verification expired. Refresh and try again.' };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Verification expired. Refresh and try again.' };
  }
  const now = Date.now();
  if (!payload?.n || payload.exp < now) return { ok: false, error: 'Verification expired. Refresh and try again.' };
  if (now - payload.iat < CHALLENGE_MIN_AGE_MS) {
    return { ok: false, error: 'Please wait a moment and try again.' };
  }
  if (payload.ip && payload.ip !== clientIp(req)) {
    return { ok: false, error: 'Verification expired. Refresh and try again.' };
  }
  pruneMap(usedChallenges, now);
  if (usedChallenges.has(payload.n)) {
    return { ok: false, error: 'Verification expired. Refresh and try again.' };
  }
  usedChallenges.set(payload.n, { exp: payload.exp });
  return { ok: true };
}

function issueChallenge(secret, req) {
  const now = Date.now();
  return signChallenge(secret, {
    n: crypto.randomBytes(16).toString('hex'),
    ip: clientIp(req),
    iat: now,
    exp: now + CHALLENGE_TTL_MS
  });
}

function looksLikeBotHoneypot(body) {
  const bait = body?.lc_hp_fax ?? body?.fax;
  return typeof bait === 'string' && bait.trim() !== '';
}

async function verifyTurnstile(secretKey, token, ip) {
  if (!secretKey) return { ok: true, skipped: true };
  if (!token || typeof token !== 'string' || token.length > 4096) {
    return { ok: false, error: 'Confirm you are human and try again.' };
  }
  const params = new URLSearchParams();
  params.set('secret', secretKey);
  params.set('response', token);
  if (ip && ip !== 'unknown') params.set('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!data.success) return { ok: false, error: 'Confirm you are human and try again.' };
  return { ok: true };
}

function sanitizeText(value, max = MAX_TEXT_CHARS) {
  let text = String(value || '');
  if (text.length > max) text = text.slice(0, max);
  text = text.replace(/\0/g, '').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return text.trim();
}

function sanitizeFilename(name) {
  const base = String(name || 'document')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\.\./g, '_')
    .slice(0, MAX_FILENAME_LEN)
    .trim();
  return base || 'document';
}

function sanitizeClientId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return null;
  if (id.length > MAX_CLIENT_ID_LEN) return null;
  return id;
}

function sanitizeLanguage(value) {
  const language = String(value || '').trim();
  return ALLOWED_LANGUAGES.includes(language) ? language : null;
}

function sanitizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 120) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(email)) return null;
  return email;
}

function maskEmail(value) {
  const email = String(value || '');
  const at = email.indexOf('@');
  if (at < 1) return '';
  const user = email.slice(0, at);
  const domain = email.slice(at);
  return `${user.slice(0, 1)}${'*'.repeat(Math.max(1, user.length - 1))}${domain}`;
}

function deliveryTokenOk(job, token) {
  const expected = String(job?.deliveryToken || '');
  const got = String(token || '');
  if (!expected || got.length !== expected.length || got.length < 16) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(got, 'utf8'));
  } catch {
    return false;
  }
}

function canAccessJob(job, { clientId, token } = {}) {
  if (!job) return false;
  if (token && deliveryTokenOk(job, token)) return true;
  if (clientId && job.clientId === clientId) return true;
  return false;
}

function publicJob(job) {
  if (!job) return null;
  const sourceFile = job.sourceFile && typeof job.sourceFile === 'object'
    ? {
        name: sanitizeFilename(job.sourceFile.name),
        ext: String(job.sourceFile.ext || '').toLowerCase().slice(0, 8)
      }
    : null;
  return {
    id: job.id,
    clientId: job.clientId,
    originalText: job.originalText,
    language: job.language,
    aiTranslation: job.aiTranslation,
    qaOnly: !!job.qaOnly,
    status: job.status,
    revisedTranslation: job.revisedTranslation || null,
    createdAt: job.createdAt,
    sourceFile,
    clientEmailMasked: job.clientEmail ? maskEmail(job.clientEmail) : null
  };
}

function revisorJob(job) {
  const base = publicJob(job);
  if (!base) return null;
  return {
    ...base,
    sourceWordCount: typeof job.sourceWordCount === 'number' ? job.sourceWordCount : undefined,
    claimedByRevisorId: job.claimedByRevisorId || null,
    claimedAt: job.claimedAt || null,
    completedByRevisorId: job.completedByRevisorId || null,
    completedAt: job.completedAt || null
  };
}

function decodeBase64Limited(b64, maxBytes) {
  if (typeof b64 !== 'string' || !b64) return null;
  if (b64.length > Math.ceil(maxBytes * 1.4) + 64) {
    throw new Error('File too large');
  }
  const clean = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+=*$/.test(clean)) throw new Error('Invalid file data');
  const buf = Buffer.from(clean, 'base64');
  if (buf.length > maxBytes) throw new Error('File too large');
  return buf;
}

function findEocdOffset(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.length - i >= 4 && buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function inspectZip(buf) {
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('Not a valid Word document');
  }
  const eocd = findEocdOffset(buf);
  if (eocd < 0) throw new Error('Not a valid Word document');
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES || cdOffset + cdSize > buf.length) {
    throw new Error('Document structure is not allowed');
  }
  let offset = cdOffset;
  let uncompressed = 0;
  let hasContentTypes = false;
  let hasDocument = false;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Document structure is not allowed');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    if (flags & 0x1) throw new Error('Encrypted documents are not allowed');
    if (name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
      throw new Error('Document structure is not allowed');
    }
    if (DANGEROUS_ZIP_NAME.test(name) || DANGEROUS_ZIP_EXT.test(name) || OLE_OR_MACRO_PATH.test(name)) {
      throw new Error('Document contains macros or executable content');
    }
    if (name === '[Content_Types].xml') hasContentTypes = true;
    if (name === 'word/document.xml') hasDocument = true;
    uncompressed += uncompSize;
    if (uncompressed > MAX_DOCX_UNCOMPRESSED) throw new Error('File too large');
    if (method === 0 && uncompSize > 0) {
      const localOff = buf.readUInt32LE(offset + 42);
      if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
        const localNameLen = buf.readUInt16LE(localOff + 26);
        const localExtra = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + localNameLen + localExtra;
        const sample = buf.slice(dataStart, Math.min(buf.length, dataStart + 4));
        if (sample.length >= 2 && sample[0] === 0x4d && sample[1] === 0x5a) {
          throw new Error('Document contains macros or executable content');
        }
      }
    }
    if (method === 8 && compSize > 0 && uncompSize > 0) {
      const localOff = buf.readUInt32LE(offset + 42);
      if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
        const localNameLen = buf.readUInt16LE(localOff + 26);
        const localExtra = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + localNameLen + localExtra;
        const compressed = buf.slice(dataStart, Math.min(buf.length, dataStart + Math.min(compSize, 4096)));
        try {
          const inflated = zlib.inflateRawSync(compressed, { maxOutputLength: 64 });
          if (inflated.length >= 2 && inflated[0] === 0x4d && inflated[1] === 0x5a) {
            throw new Error('Document contains macros or executable content');
          }
        } catch (err) {
          if (err.message === 'Document contains macros or executable content') throw err;
        }
      }
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  if (!hasContentTypes || !hasDocument) throw new Error('Not a valid Word document');
}

function scanBufferWithAntivirus(buf) {
  const exe = process.env.DEFENDER_MPCMDRUN || 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
  if (process.platform !== 'win32' || !fs.existsSync(exe)) return { ok: true, skipped: true };
  const tmp = path.join(os.tmpdir(), 'lc-scan-' + crypto.randomBytes(8).toString('hex') + '.bin');
  try {
    fs.writeFileSync(tmp, buf);
    const result = spawnSync(exe, ['-Scan', '-ScanType', '3', '-DisableRemediation', '-File', tmp], {
      timeout: 20000,
      windowsHide: true
    });
    if (result.status === 2) return { ok: false, error: 'File failed malware scan' };
    return { ok: true };
  } catch {
    return { ok: true, skipped: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function inspectPdf(buf) {
  if (!buf || buf.length < 5) throw new Error('Not a valid PDF');
  const head = buf.slice(0, 5).toString('latin1');
  if (head !== '%PDF-') throw new Error('Not a valid PDF');
}

function scanSourceFileBase64(ext, b64) {
  const buf = decodeBase64Limited(b64, MAX_FILE_BYTES);
  if (!buf) throw new Error('Invalid file data');
  if (ext === 'docx') inspectZip(buf);
  else if (ext === 'pdf') inspectPdf(buf);
  else throw new Error('Unsupported file type');
  const av = scanBufferWithAntivirus(buf);
  if (!av.ok) throw new Error(av.error || 'File failed malware scan');
  return buf.toString('base64');
}

function sourceFileForDownload(job) {
  if (!job?.sourceFile || typeof job.sourceFile !== 'object') return null;
  const fileB64 = typeof job.sourceFile.fileB64 === 'string'
    ? job.sourceFile.fileB64
    : (typeof job.sourceFile.docxB64 === 'string' ? job.sourceFile.docxB64 : null);
  if (!fileB64) return null;
  return {
    name: sanitizeFilename(job.sourceFile.name),
    ext: String(job.sourceFile.ext || '').toLowerCase().slice(0, 8),
    fileB64
  };
}

async function assertHuman(req, body, { secret, turnstile }) {
  if (looksLikeBotHoneypot(body)) {
    return { ok: false, status: 400, error: 'Invalid request' };
  }
  const challenge = verifyChallengeToken(secret, body?.challengeToken, req);
  if (!challenge.ok) return { ok: false, status: 403, error: challenge.error };
  if (turnstile?.enabled) {
    const ts = await verifyTurnstile(turnstile.secretKey, body?.turnstileToken, clientIp(req));
    if (!ts.ok) return { ok: false, status: 403, error: ts.error };
  }
  return { ok: true };
}

function buildClientJob(body) {
  const clientId = sanitizeClientId(body.clientId);
  if (!clientId) throw new Error('Invalid client session');
  const language = sanitizeLanguage(body.language);
  if (!language) throw new Error('Unsupported language');
  const clientEmail = sanitizeEmail(body.clientEmail);
  if (!clientEmail) throw new Error('A delivery email is required');
  const qaOnly = body.qaOnly === true;
  const originalText = sanitizeText(body.originalText);
  const aiTranslation = sanitizeText(body.aiTranslation || (qaOnly ? body.originalText : ''));
  if (qaOnly) {
    if (!aiTranslation) throw new Error('Translation is required');
  } else {
    if (!originalText) throw new Error('Text is required');
    if (!aiTranslation) throw new Error('Translation is required');
  }

  let sourceFile = null;
  const incoming = body.sourceFile;
  if (incoming && typeof incoming === 'object') {
    const ext = String(incoming.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
    if (!['txt', 'md', 'pdf', 'docx'].includes(ext)) throw new Error('Unsupported file type');
    sourceFile = { name: sanitizeFilename(incoming.name || `translation.${ext}`), ext, fileB64: null };
    if (ext === 'docx' || ext === 'pdf') {
      const incomingB64 = incoming.fileB64 || incoming.docxB64;
      if (!incomingB64) throw new Error('Original file is required');
      sourceFile.fileB64 = scanSourceFileBase64(ext, incomingB64);
    }
  }

  return {
    id: 'j_' + crypto.randomBytes(12).toString('hex'),
    clientId,
    clientEmail,
    deliveryToken: crypto.randomBytes(24).toString('hex'),
    deliveryEmailedAt: null,
    originalText,
    language,
    aiTranslation,
    qaOnly,
    status: 'awaiting_review',
    revisedTranslation: null,
    createdAt: Date.now(),
    sourceWordCount: (qaOnly ? aiTranslation : originalText).trim().split(/\s+/).filter(Boolean).length,
    claimedByRevisorId: null,
    claimedAt: null,
    completedByRevisorId: null,
    completedAt: null,
    sourceFile
  };
}

module.exports = {
  ALLOWED_LANGUAGES,
  MAX_TEXT_CHARS,
  applySecurityHeaders,
  assertHuman,
  buildClientJob,
  clientIp,
  issueChallenge,
  loadTurnstileConfig,
  publicJob,
  revisorJob,
  sourceFileForDownload,
  rateLimit,
  canAccessJob,
  sanitizeClientId,
  sanitizeEmail,
  sanitizeLanguage,
  sanitizeText,
  maskEmail
};
