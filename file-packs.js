/**
 * Keeps an uploaded DOCX and its Okapi package on disk.
 * The browser then sends a short id instead of the file on every download.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function rootDir() {
  return process.env.LINGOCHECK_PACK_DIR || path.join(__dirname, 'data', 'okapi-packs');
}

function packIdOk(id) {
  return typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
}

function packDir(id) {
  if (!packIdOk(id)) return null;
  const root = path.resolve(rootDir());
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return dir;
}

function savePack({ original, xliffXml, skeletons, fileName, sourceLang, targetLang, sentenceCount }) {
  if (!Buffer.isBuffer(original) || !original.length) throw new Error('Original file is required');
  const id = crypto.randomBytes(16).toString('hex');
  const dir = path.join(rootDir(), id);
  const skelDir = path.join(dir, 'skel');
  fs.mkdirSync(skelDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'original.docx'), original);
  fs.writeFileSync(path.join(dir, 'document.xlf'), String(xliffXml || ''), 'utf8');
  const names = [];
  for (const sk of skeletons || []) {
    const name = path.basename(String(sk && sk.name || ''));
    if (!name || !/\.skl(?:\.zip)?$/i.test(name)) continue;
    const buf = Buffer.isBuffer(sk.buf) ? sk.buf : Buffer.from(String(sk.b64 || ''), 'base64');
    if (!buf.length) continue;
    fs.writeFileSync(path.join(skelDir, name), buf);
    names.push(name);
  }
  const meta = {
    fileName: String(fileName || 'document.docx').slice(0, 180),
    sourceLang: String(sourceLang || 'en').slice(0, 12),
    targetLang: String(targetLang || 'nl').slice(0, 12),
    sentenceCount: Math.max(0, Number(sentenceCount) || 0),
    skeletons: names
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  return id;
}

function hasPack(id) {
  const dir = packDir(id);
  return !!(dir && fs.existsSync(path.join(dir, 'meta.json')) && fs.existsSync(path.join(dir, 'original.docx')));
}

function loadPack(id) {
  const dir = packDir(id);
  if (!dir || !hasPack(id)) return null;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const skeletons = [];
  for (const name of meta.skeletons || []) {
    const safe = path.basename(String(name || ''));
    if (!safe || !/\.skl(?:\.zip)?$/i.test(safe)) continue;
    const file = path.join(dir, 'skel', safe);
    if (!fs.existsSync(file)) continue;
    skeletons.push({ name: safe, b64: fs.readFileSync(file).toString('base64') });
  }
  return {
    fileName: meta.fileName || 'document.docx',
    sourceLang: meta.sourceLang || 'en',
    targetLang: meta.targetLang || 'nl',
    sentenceCount: meta.sentenceCount || 0,
    original: fs.readFileSync(path.join(dir, 'original.docx')),
    xliffXml: fs.readFileSync(path.join(dir, 'document.xlf'), 'utf8'),
    skeletons
  };
}

module.exports = {
  hasPack,
  loadPack,
  packIdOk,
  savePack
};
