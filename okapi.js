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
    const text = xliffInnerToPlain(m[2]);
    if (text) out.push({ mid, text });
  }
  return out;
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
    if (Array.isArray(opts.translations) && opts.translations.length) {
      xml = applyTranslationsToXliff(xml, opts.translations);
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
  extractDocx,
  mergeDocx
};
