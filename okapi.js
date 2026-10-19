/**
 * Okapi Tikal wrapper for DOCX ↔ XLIFF round-trips with SRX segmentation.
 * Requires Java 11+ and Okapi apps (see scripts/setup-okapi.ps1).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const TOOLS_DIR = path.join(__dirname, '.tools');
const OKAPI_VERSION = '1.48.0';

const LANG_TO_OKAPI = Object.freeze({
  Dutch: 'nl',
  Spanish: 'es',
  German: 'de',
  English: 'en'
});

function languageToOkapiCode(language) {
  return LANG_TO_OKAPI[language] || 'en';
}

function resolveJavaHome() {
  const env = process.env.JAVA_HOME;
  if (env && fs.existsSync(path.join(env, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'))) {
    return env;
  }
  const localCandidates = [
    path.join(TOOLS_DIR, 'jre'),
    path.join(TOOLS_DIR, 'jdk'),
    path.join(TOOLS_DIR, 'java')
  ];
  for (const root of localCandidates) {
    if (!fs.existsSync(root)) continue;
    const direct = path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(direct)) return root;
    try {
      const kids = fs.readdirSync(root);
      for (const kid of kids) {
        const nested = path.join(root, kid);
        const java = path.join(nested, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
        if (fs.existsSync(java)) return nested;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function resolveOkapiHome() {
  const env = process.env.OKAPI_HOME;
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    path.join(TOOLS_DIR, 'okapi'),
    path.join(TOOLS_DIR, `okapi-apps_win32-x86_64_${OKAPI_VERSION}`),
    path.join(TOOLS_DIR, `okapi-apps_gtk2-linux-x86_64_${OKAPI_VERSION}`),
    'C:\\Program Files\\Okapi',
    '/opt/okapi',
    '/usr/local/okapi'
  ];
  for (const root of candidates) {
    if (!fs.existsSync(root)) continue;
    const bat = path.join(root, 'tikal.bat');
    const sh = path.join(root, 'tikal.sh');
    if (fs.existsSync(bat) || fs.existsSync(sh)) return root;
    try {
      for (const kid of fs.readdirSync(root)) {
        const nested = path.join(root, kid);
        if (fs.existsSync(path.join(nested, 'tikal.bat')) || fs.existsSync(path.join(nested, 'tikal.sh'))) {
          return nested;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function resolveJavaBin(javaHome) {
  if (javaHome) {
    const full = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (fs.existsSync(full)) return full;
  }
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function resolveTikalLibDir(okapiHome) {
  if (!okapiHome) return null;
  const lib = path.join(okapiHome, 'lib');
  if (!fs.existsSync(lib)) return null;
  // Prefer the tikal application jar; classpath still needs lib/*
  const hasTikalJar = fs.readdirSync(lib).some((n) => /okapi-application-tikal/i.test(n));
  const hasBat = fs.existsSync(path.join(okapiHome, 'tikal.bat')) || fs.existsSync(path.join(okapiHome, 'tikal.sh'));
  if (!hasTikalJar && !hasBat) return null;
  return lib;
}

function getStatus() {
  const javaHome = resolveJavaHome();
  const okapiHome = resolveOkapiHome();
  const libDir = resolveTikalLibDir(okapiHome);
  const javaBin = resolveJavaBin(javaHome);
  let javaOk = false;
  const probe = spawnSync(javaBin, ['-version'], {
    encoding: 'utf8',
    windowsHide: true
  });
  javaOk = !probe.error && (probe.status === 0 || /version/i.test(String(probe.stderr || '') + String(probe.stdout || '')));
  const ready = !!(javaOk && libDir);
  return {
    ready,
    javaHome: javaHome || null,
    okapiHome: okapiHome || null,
    javaBin,
    libDir,
    tikal: okapiHome ? path.join(okapiHome, process.platform === 'win32' ? 'tikal.bat' : 'tikal.sh') : null,
    version: OKAPI_VERSION,
    message: ready
      ? 'Okapi Tikal ready'
      : !javaOk
        ? 'Java 11+ not found. Run: npm run setup:okapi'
        : 'Okapi apps not found. Run: npm run setup:okapi'
  };
}

function runTikal(args, cwd) {
  const status = getStatus();
  if (!status.ready) {
    const err = new Error(status.message);
    err.code = 'OKAPI_UNAVAILABLE';
    throw err;
  }
  const env = { ...process.env };
  if (status.javaHome) env.JAVA_HOME = status.javaHome;

  // Invoke Tikal the same way tikal.bat does — avoids fragile cmd.exe PATH issues.
  const cp = path.join(status.libDir, '*');
  const javaArgs = ['-cp', cp, 'net.sf.okapi.applications.tikal.Main', ...args];
  const result = spawnSync(status.javaBin, javaArgs, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });

  const out = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.error) {
    const err = new Error(`Could not start Okapi Tikal: ${result.error.message}`);
    err.code = 'OKAPI_SPAWN';
    throw err;
  }
  if (result.status !== 0) {
    const err = new Error(out.slice(-800) || `Okapi Tikal failed (exit ${result.status})`);
    err.code = 'OKAPI_FAILED';
    err.detail = out;
    throw err;
  }
  return out;
}

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeUnlinkDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function encodeXmlText(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Word stores a drawing's file name as its own trans-unit. That is not body text. */
function isImageAssetText(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 180) return false;
  const withoutExt = t.replace(/\.(png|jpe?g|gif|bmp|tif|tiff|emf|wmf|svg|webp)$/i, '');
  if (/[.!?]/.test(withoutExt)) return false;
  return /^(?:picture\s+\d+[_ ].+|[\w .()\-]+\.(?:png|jpe?g|gif|bmp|tif|tiff|emf|wmf|svg|webp))$/i.test(t);
}

function stripImageAssets(text) {
  const kept = String(text || '')
    .split(/\n/)
    .filter((line) => !isImageAssetText(line));
  return kept
    .join('\n')
    .replace(
      /(^|\s)Picture\s+\d+_[^\s]+\.(?:png|jpe?g|gif|bmp|tif|tiff|emf|wmf|svg|webp)(?=\s|$)/gi,
      '$1'
    )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function splitBySourceAnchors(fullText, sources) {
  const raw = String(fullText || '').replace(/\s+/g, ' ').trim();
  const normSources = sources.map((source) => String(source || '').replace(/\s+/g, ' ').trim());
  if (!raw || normSources.length < 2) return null;
  const found = [];
  let cursor = 0;
  const lower = raw.toLowerCase();
  for (let i = 0; i < normSources.length; i++) {
    const src = normSources[i];
    if (src.length < 8) continue;
    const at = lower.indexOf(src.toLowerCase(), cursor);
    if (at < 0) continue;
    found.push({ index: i, at });
    cursor = at + src.length;
  }
  if (found.length < 2) return null;
  const out = normSources.map(() => '');
  found.forEach((hit, n) => {
    const start = n === 0 ? 0 : hit.at;
    const end = n + 1 < found.length ? found[n + 1].at : raw.length;
    out[hit.index] = raw.slice(start, end).replace(/\s+/g, ' ').trim();
  });
  return out;
}

/** Strip XLIFF inline codes, keep human text. */
function xliffInnerToPlain(inner) {
  let t = String(inner || '');
  t = t.replace(/<mrk\b[^>]*>/gi, '').replace(/<\/mrk>/gi, '');
  t = t.replace(/<(?:g|x|bx|ex|bpt|ept|ph|it|pc|sc|ec)\b[^>]*\/>/gi, '');
  t = t.replace(/<(?:g|x|bx|ex|bpt|ept|ph|it|pc|sc|ec)\b[^>]*>[\s\S]*?<\/(?:g|x|bx|ex|bpt|ept|ph|it|pc|sc|ec)>/gi, '');
  t = t.replace(/<[^>]+>/g, '');
  return decodeXmlEntities(t).replace(/\s+/g, ' ').trim();
}

function extractMrkSegments(block) {
  const out = [];
  const re = /<mrk\b([^>]*)>([\s\S]*?)<\/mrk>/gi;
  let m;
  while ((m = re.exec(block))) {
    const attrs = m[1] || '';
    if (!/\bmtype\s*=\s*["']seg["']/i.test(attrs)) continue;
    const mid = (attrs.match(/\bmid\s*=\s*["']([^"']*)["']/i) || [])[1] || String(out.length);
    const inner = m[2] || '';
    const text = xliffInnerToPlain(inner);
    if (text) out.push({ mid, text, inner });
  }
  return out;
}

function tokenizeInline(inner) {
  const parts = [];
  const source = String(inner || '');
  const re = /<[^>]+>/g;
  let last = 0;
  let match;
  while ((match = re.exec(source))) {
    if (match.index > last) parts.push({ type: 'text', value: source.slice(last, match.index) });
    parts.push({ type: 'tag', value: match[0] });
    last = re.lastIndex;
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) });
  return parts;
}

function splitCharsByWeights(text, weights) {
  const chars = Array.from(String(text || ''));
  if (!weights.length) return [];
  const total = weights.reduce((sum, n) => sum + n, 0) || 1;
  const out = [];
  let cursor = 0;
  let consumed = 0;
  for (let i = 0; i < weights.length; i++) {
    consumed += weights[i];
    const end = i === weights.length - 1
      ? chars.length
      : Math.max(cursor, Math.min(chars.length, Math.round(chars.length * (consumed / total))));
    out.push(chars.slice(cursor, end).join(''));
    cursor = end;
  }
  return out;
}

function splitWordsToCount(text, count) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const slots = Math.max(1, count | 0);
  if (slots === 1) return [words.join(' ')];
  const out = [];
  let idx = 0;
  for (let i = 0; i < slots; i++) {
    const slotsLeft = slots - i;
    const wordsLeft = words.length - idx;
    const take = i === slots - 1
      ? wordsLeft
      : Math.max(0, Math.min(wordsLeft - Math.max(0, slotsLeft - 1), Math.round(wordsLeft / slotsLeft) || 0));
    out.push(words.slice(idx, idx + take).join(' '));
    idx += take;
  }
  return out;
}

/** Keep bold, breaks and other inline codes, and put the new wording in the same runs. */
function fillInline(sourceInner, translated) {
  const sourcePlain = xliffInnerToPlain(sourceInner);
  const next = String(translated || '').replace(/\s+/g, ' ').trim();
  if (!next) return '';
  if (sourcePlain === next) return String(sourceInner || '');
  const parts = tokenizeInline(sourceInner);
  const textSlots = [];
  parts.forEach((part, index) => {
    if (part.type === 'text' && part.value.replace(/\s+/g, '').length) textSlots.push(index);
  });
  if (!textSlots.length) return encodeXmlText(next);
  const weights = textSlots.map((index) => Math.max(1, parts[index].value.replace(/\s+/g, '').length));
  const chunks = textSlots.length === 1 ? [next] : splitCharsByWeights(next, weights);
  textSlots.forEach((index, n) => {
    const original = parts[index].value;
    const lead = /^\s/.test(original) ? (original.match(/^\s*/) || [''])[0] : '';
    const trail = /\s$/.test(original) && n < textSlots.length - 1 ? (original.match(/\s*$/) || [''])[0] : '';
    parts[index] = { type: 'text', value: `${lead}${chunks[n] || ''}${trail}` };
  });
  return parts.map((part) => (part.type === 'tag' ? part.value : encodeXmlText(part.value))).join('');
}

function wordSet(value) {
  return new Set(String(value || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((word) => word.length > 2));
}

function textSimilarity(a, b) {
  const left = wordSet(a);
  const right = wordSet(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / Math.max(left.size, right.size);
}

function splitBySourceWeights(text, sources) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!sources.length) return [];
  if (sources.length === 1) return [words.join(' ')];
  const weights = sources.map((source) => Math.max(1, String(source || '').replace(/\s+/g, '').length));
  const total = weights.reduce((sum, n) => sum + n, 0) || 1;
  const out = [];
  let cursor = 0;
  let consumed = 0;
  for (let i = 0; i < weights.length; i++) {
    consumed += weights[i];
    const end = i === weights.length - 1
      ? words.length
      : Math.max(cursor, Math.min(words.length, Math.round(words.length * (consumed / total))));
    out.push(words.slice(cursor, end).join(' '));
    cursor = end;
  }
  return out;
}

function revisedChunks(fullText) {
  const raw = String(fullText || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const chunks = [];
  for (const line of lines.length ? lines : [raw]) {
    const sentences = line.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    if (sentences.length > 1) chunks.push(...sentences);
    else chunks.push(line);
  }
  return chunks;
}

function alignChunksToSources(sources, chunks) {
  const out = sources.map(() => []);
  let j = 0;
  for (let i = 0; i < sources.length && j < chunks.length; i++) {
    let bestAt = i;
    let bestSim = textSimilarity(sources[i], chunks[j]);
    const lookUntil = Math.min(sources.length - 1, i + 3);
    for (let k = i + 1; k <= lookUntil; k++) {
      const sim = textSimilarity(sources[k], chunks[j]);
      if (sim > bestSim + 0.12) {
        bestSim = sim;
        bestAt = k;
      }
    }
    if (bestAt > i && bestSim >= 0.4) continue;
    out[i].push(chunks[j]);
    j += 1;
    while (j < chunks.length && i < sources.length - 1) {
      const here = textSimilarity(sources[i], chunks[j]);
      const next = textSimilarity(sources[i + 1], chunks[j]);
      if (next >= here && next >= 0.35) break;
      if (here < 0.2 && next < 0.2) break;
      out[i].push(chunks[j]);
      j += 1;
    }
  }
  if (j < chunks.length) out[out.length - 1].push(...chunks.slice(j));
  return out.map((parts) => parts.join(' ').replace(/\s+/g, ' ').trim());
}

function alignRevisedToSourceSentences(sourceSentences, fullText) {
  const sources = sourceSentences.map((sentence) => String(sentence || '').trim());
  const raw = stripImageAssets(fullText);
  if (!sources.length) return [];
  if (!raw) return sources.map(() => '');
  const doubles = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const singles = raw.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  if (doubles.length === sources.length) return doubles;
  if (singles.length === sources.length) return singles;
  const anchored = splitBySourceAnchors(raw, sources);
  if (anchored) return anchored;
  const chunks = revisedChunks(raw);
  if (chunks.length === sources.length) return chunks;
  if (chunks.length < 2) return splitBySourceWeights(raw, sources);
  return alignChunksToSources(sources, chunks);
}

function sentencesMatchFullText(sentences, fullText, paraMap) {
  if (!Array.isArray(sentences) || !sentences.length || !String(fullText || '').trim()) return false;
  const maxPi = Array.isArray(paraMap) && paraMap.length
    ? Math.max(...paraMap.map((n) => Number(n) || 0))
    : 0;
  const buckets = Array.from({ length: maxPi + 1 }, () => []);
  sentences.forEach((sentence, i) => {
    const part = String(sentence || '').trim();
    if (!part) return;
    const pi = Array.isArray(paraMap) && paraMap[i] != null ? (Number(paraMap[i]) || 0) : 0;
    buckets[pi].push(part);
  });
  const rebuilt = buckets.map((bucket) => bucket.join(' ')).filter(Boolean).join('\n\n');
  const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  return norm(rebuilt) === norm(fullText);
}

function resolveMergeTranslations(xliffXml, opts = {}) {
  const parsed = parseXliff(xliffXml);
  const expected = parsed.sentences.length;
  const given = Array.isArray(opts.translations)
    ? opts.translations.map((item) => String(item == null ? '' : item))
    : [];
  const fullText = opts.fullText == null ? '' : String(opts.fullText);
  if (given.length === expected && expected > 0) return given;
  if (fullText.trim() && parsed.sentences.length) return alignRevisedToSourceSentences(parsed.sentences, fullText);
  if (given.length === expected && expected > 0) return given;
  return null;
}

/**
 * Parse Okapi XLIFF into display segments (trans-units) and SRX sentences.
 */
function parseXliff(xliffXml) {
  const xml = String(xliffXml || '');
  const units = [];
  const tuRe = /<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi;
  let m;
  while ((m = tuRe.exec(xml))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    if (/\btranslate\s*=\s*["']no["']/i.test(attrs)) continue;
    const id = (attrs.match(/\bid\s*=\s*["']([^"']*)["']/i) || [])[1] || String(units.length + 1);

    const segSourceMatch = body.match(/<seg-source\b[^>]*>([\s\S]*?)<\/seg-source>/i);
    const sourceMatch = body.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    const sourceInner = segSourceMatch ? segSourceMatch[1] : (sourceMatch ? sourceMatch[1] : '');
    const mrks = extractMrkSegments(sourceInner);
    const fullText = xliffInnerToPlain(sourceInner);
    if (!fullText && !mrks.length) continue;

    const sentences = mrks.length
      ? mrks.map((s) => s.text)
      : [fullText];
    if (sentences.length && sentences.every((sentence) => isImageAssetText(sentence))) continue;

    units.push({
      id,
      text: fullText || sentences.join(' '),
      sentences,
      mrks: mrks.length ? mrks : sentences.map((text, i) => ({ mid: String(i), text }))
    });
  }

  const segments = units.map((u) => u.text);
  const sentences = [];
  const sentenceParaMap = [];
  units.forEach((u, pi) => {
    u.sentences.forEach((s) => {
      sentences.push(s);
      sentenceParaMap.push(pi);
    });
  });

  return {
    units,
    segments,
    sentences,
    sentenceParaMap,
    text: segments.join('\n\n')
  };
}

function findSkeletonFiles(workDir, baseName) {
  const files = fs.readdirSync(workDir);
  const skeletons = [];
  for (const name of files) {
    if (!/\.skl$/i.test(name) && !/\.skl\.zip$/i.test(name)) continue;
    const buf = fs.readFileSync(path.join(workDir, name));
    skeletons.push({ name, b64: buf.toString('base64') });
  }
  // Also pick up sibling skeleton named after the xlf
  const xlfSkl = `${baseName}.xlf.skl`;
  if (fs.existsSync(path.join(workDir, xlfSkl)) && !skeletons.some((s) => s.name === xlfSkl)) {
    skeletons.push({
      name: xlfSkl,
      b64: fs.readFileSync(path.join(workDir, xlfSkl)).toString('base64')
    });
  }
  return skeletons;
}

function applyTranslationsToXliff(xliffXml, translations) {
  const list = Array.isArray(translations) ? translations.map((t) => String(t || '')) : [];
  let cursor = 0;
  return String(xliffXml || '').replace(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/gi, (full, attrs, body) => {
    if (/\btranslate\s*=\s*["']no["']/i.test(attrs || '')) return full;

    const segSourceMatch = body.match(/<seg-source\b[^>]*>([\s\S]*?)<\/seg-source>/i);
    const sourceMatch = body.match(/<source\b[^>]*>([\s\S]*?)<\/source>/i);
    const sourceInner = segSourceMatch ? segSourceMatch[1] : (sourceMatch ? sourceMatch[1] : '');
    const mrks = extractMrkSegments(sourceInner);
    const fullText = xliffInnerToPlain(sourceInner);
    if (!fullText && !mrks.length) return full;
    const unitSentences = mrks.length ? mrks.map((mk) => mk.text) : [fullText];
    if (unitSentences.every((sentence) => isImageAssetText(sentence))) return full;

    const count = mrks.length || 1;
    const parts = [];
    for (let i = 0; i < count; i++) {
      parts.push(list[cursor + i] != null ? list[cursor + i] : '');
    }
    cursor += count;

    let targetXml;
    if (mrks.length) {
      targetXml = mrks
        .map((mk, i) => `<mrk mid="${encodeXmlText(mk.mid)}" mtype="seg">${encodeXmlText(parts[i])}</mrk>`)
        .join(' ');
    } else {
      targetXml = encodeXmlText(parts[0] || '');
    }

    if (/<target\b[^>]*>[\s\S]*?<\/target>/i.test(body)) {
      body = body.replace(/<target\b[^>]*>[\s\S]*?<\/target>/i, `<target xml:space="preserve">${targetXml}</target>`);
    } else if (/<target\b[^>]*\/>/i.test(body)) {
      body = body.replace(/<target\b[^>]*\/>/i, `<target xml:space="preserve">${targetXml}</target>`);
    } else if (sourceMatch) {
      body = body.replace(sourceMatch[0], `${sourceMatch[0]}\n      <target xml:space="preserve">${targetXml}</target>`);
    } else {
      body += `\n      <target xml:space="preserve">${targetXml}</target>`;
    }
    return `<trans-unit${attrs}>${body}</trans-unit>`;
  });
}

/**
 * Extract DOCX → XLIFF (+ skeleton) with SRX segmentation.
 * @param {Buffer} docxBuffer
 * @param {{ sourceLang?: string, targetLang?: string, fileName?: string }} opts
 */
function extractDocx(docxBuffer, opts = {}) {
  const sourceLang = languageToOkapiCode(opts.sourceLang || 'English');
  const targetLang = languageToOkapiCode(opts.targetLang || 'Dutch');
  const safeName = String(opts.fileName || 'document.docx')
    .replace(/[^\w.\-()+ ]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 120) || 'document.docx';
  const baseName = safeName.toLowerCase().endsWith('.docx') ? safeName : `${safeName}.docx`;

  const workDir = makeTempDir('lc-okapi-x');
  try {
    const inputPath = path.join(workDir, baseName);
    fs.writeFileSync(inputPath, docxBuffer);

    // Run inside workDir so relative paths match what Tikal expects on merge.
    runTikal(['-x', '-seg', '-sl', sourceLang, '-tl', targetLang, baseName], workDir);

    const xlfPath = path.join(workDir, `${baseName}.xlf`);
    if (!fs.existsSync(xlfPath)) {
      const found = fs.readdirSync(workDir).find((n) => /\.xlf$/i.test(n));
      if (!found) throw Object.assign(new Error('Okapi did not produce an XLIFF file'), { code: 'OKAPI_NO_XLF' });
      fs.copyFileSync(path.join(workDir, found), xlfPath);
    }

    const xliffXml = fs.readFileSync(xlfPath, 'utf8');
    const parsed = parseXliff(xliffXml);
    if (!parsed.sentences.length) {
      throw Object.assign(new Error('Okapi extracted no translatable segments'), { code: 'OKAPI_EMPTY' });
    }

    const skeletons = findSkeletonFiles(workDir, baseName);
    return {
      fileName: baseName,
      sourceLang,
      targetLang,
      text: parsed.text,
      segments: parsed.segments,
      sentences: parsed.sentences,
      sentenceParaMap: parsed.sentenceParaMap,
      xliffB64: Buffer.from(xliffXml, 'utf8').toString('base64'),
      skeletons,
      unitCount: parsed.units.length,
      sentenceCount: parsed.sentences.length
    };
  } finally {
    safeUnlinkDir(workDir);
  }
}

/**
 * Merge translated XLIFF back into DOCX.
 * @param {Buffer} originalDocx
 * @param {string} xliffXml
 * @param {{ skeletons?: Array<{name:string,b64:string}>, sourceLang?: string, targetLang?: string, fileName?: string, translations?: string[] }} opts
 */
function mergeDocx(originalDocx, xliffXml, opts = {}) {
  const sourceLang = opts.sourceLang || 'en';
  const targetLang = opts.targetLang || 'nl';
  const baseName = String(opts.fileName || 'document.docx').replace(/[^\w.\-()+ ]+/g, '_').slice(0, 120) || 'document.docx';
  const workDir = makeTempDir('lc-okapi-m');
  try {
    const inputPath = path.join(workDir, baseName);
    fs.writeFileSync(inputPath, originalDocx);

    let xml = String(xliffXml || '');
    const translations = resolveMergeTranslations(xml, opts);
    if (translations && translations.length) {
      xml = applyTranslationsToXliff(xml, translations);
    }
    const xlfPath = path.join(workDir, `${baseName}.xlf`);
    fs.writeFileSync(xlfPath, xml, 'utf8');

    for (const sk of opts.skeletons || []) {
      if (!sk || !sk.name || !sk.b64) continue;
      const safe = path.basename(String(sk.name));
      fs.writeFileSync(path.join(workDir, safe), Buffer.from(sk.b64, 'base64'));
    }

    const xlfName = `${baseName}.xlf`;
    runTikal(['-m', '-sl', sourceLang, '-tl', targetLang, xlfName], workDir);

    const outName = baseName.replace(/(\.[^.]+)$/, '.out$1');
    let outPath = path.join(workDir, outName);
    if (!fs.existsSync(outPath)) {
      const files = fs.readdirSync(workDir);
      const found = files.find((n) => /\.out\.docx$/i.test(n))
        || files.find((n) => /\.docx$/i.test(n) && n.toLowerCase() !== baseName.toLowerCase());
      if (!found) {
        throw Object.assign(
          new Error(`Okapi merge did not produce a DOCX (files: ${files.join(', ') || 'none'})`),
          { code: 'OKAPI_NO_OUT' }
        );
      }
      outPath = path.join(workDir, found);
    }
    return fs.readFileSync(outPath);
  } finally {
    safeUnlinkDir(workDir);
  }
}

module.exports = {
  OKAPI_VERSION,
  getStatus,
  languageToOkapiCode,
  parseXliff,
  applyTranslationsToXliff,
  resolveMergeTranslations,
  fillInline,
  extractDocx,
  mergeDocx
};
