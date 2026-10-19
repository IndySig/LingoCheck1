const crypto = require('crypto');

const RESET_TTL_MS = 30 * 60 * 1000;
const TOKEN_RE = /^[a-f0-9]{64}$/;

function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function createResetToken(now = Date.now()) {
  const token = crypto.randomBytes(32).toString('hex');
  return {
    token,
    hash: hashResetToken(token),
    expiresAt: now + RESET_TTL_MS
  };
}

function findResetRecord(records, token, now = Date.now()) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  const hash = hashResetToken(token);
  let found = null;
  for (const rec of records || []) {
    const stored = rec && rec.resetTokenHash;
    if (typeof stored !== 'string' || stored.length !== hash.length) continue;
    const same = crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored));
    const fresh = typeof rec.resetExpiresAt === 'number' && rec.resetExpiresAt > now;
    if (same && fresh) found = rec;
  }
  return found;
}

module.exports = {
  RESET_TTL_MS,
  hashResetToken,
  createResetToken,
  findResetRecord
};
