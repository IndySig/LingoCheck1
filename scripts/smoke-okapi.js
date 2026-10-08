const fs = require('fs');
const path = require('path');
const okapi = require('../okapi');

const docxPath = process.env.DOCX || path.join(process.env.TEMP || '/tmp', 'lc-okapi-test', 'sample.docx');
const status = okapi.getStatus();
console.log('status', status);
if (!status.ready) process.exit(2);

const buf = fs.readFileSync(docxPath);
const extracted = okapi.extractDocx(buf, {
  sourceLang: 'English',
  targetLang: 'Dutch',
  fileName: 'sample.docx'
});
console.log('segments', extracted.segments);
console.log('sentences', extracted.sentences);
console.log('sentenceCount', extracted.sentenceCount);
console.log('skeletons', (extracted.skeletons || []).map((s) => s.name));

const translations = extracted.sentences.map((s, i) => `NL-${i + 1} ${s}`);
const out = okapi.mergeDocx(buf, Buffer.from(extracted.xliffB64, 'base64').toString('utf8'), {
  skeletons: extracted.skeletons,
  sourceLang: extracted.sourceLang,
  targetLang: extracted.targetLang,
  fileName: extracted.fileName,
  translations
});
const outPath = path.join(process.env.TEMP || '/tmp', 'lc-okapi-out.docx');
fs.writeFileSync(outPath, out);
console.log('merged bytes', out.length, '->', outPath);
console.log('OK');
