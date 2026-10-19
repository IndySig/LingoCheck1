const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lc-packs-"));
process.env.LINGOCHECK_PACK_DIR = dir;
const packs = require("../file-packs");
const security = require("../security");

test("a saved pack reloads the original file without the browser sending it again", function () {
  const original = Buffer.from("PK fake docx");
  const id = packs.savePack({
    original,
    xliffXml: "<xliff>bron</xliff>",
    skeletons: [{ name: "document.docx.xlf.skl", b64: Buffer.from("skel").toString("base64") }],
    fileName: "manual.docx",
    sourceLang: "en",
    targetLang: "nl",
    sentenceCount: 2
  });
  assert.equal(packs.packIdOk(id), true);
  const loaded = packs.loadPack(id);
  assert.equal(loaded.original.toString(), "PK fake docx");
  assert.equal(loaded.xliffXml, "<xliff>bron</xliff>");
  assert.equal(Buffer.from(loaded.skeletons[0].b64, "base64").toString(), "skel");
  assert.equal(packs.loadPack("../" + id), null);
  assert.equal(packs.hasPack("nope"), false);
});

test("a docx job can keep a pack id instead of the file bytes", function () {
  const packId = "ab".repeat(16);
  const job = security.buildClientJob({
    clientId: "client1",
    language: "Dutch",
    clientEmail: "reader@example.com",
    originalText: "The garden is open.",
    aiTranslation: "De tuin is open.",
    sourceFile: { name: "garden.docx", ext: "docx", packId }
  }, {});
  assert.equal(job.sourceFile.packId, packId);
  assert.equal(job.sourceFile.fileB64, undefined);
  const pub = security.publicJob(job);
  assert.equal(pub.sourceFile.hasOkapi, true);
  assert.equal(pub.sourceFile.packId, packId);
  assert.equal(pub.sourceFile.fileB64, undefined);
});
