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

test("one source pack can be prepared for another target language", function () {
  const original = Buffer.from("PK same source");
  const id = packs.savePack({
    original,
    xliffXml: '<file source-language="en" target-language="nl"></file>',
    skeletons: [],
    fileName: "manual.docx",
    sourceLang: "en",
    targetLang: "nl",
    sentenceCount: 4
  });
  const same = packs.clonePackForTarget(id, "nl");
  assert.equal(same, id);
  const spanish = packs.clonePackForTarget(id, "es");
  assert.notEqual(spanish, id);
  const loaded = packs.loadPack(spanish);
  assert.equal(loaded.original.toString(), "PK same source");
  assert.equal(loaded.targetLang, "es");
  assert.match(loaded.xliffXml, /source-language="en"/);
  assert.match(loaded.xliffXml, /target-language="es"/);
  assert.doesNotMatch(loaded.xliffXml, /target-language="nl"/);
});

test("a dutch source can be checked as an english translation", function () {
  const job = security.buildClientJob({
    clientId: "client1",
    sourceLanguage: "Dutch",
    language: "English",
    qaOnly: true,
    clientEmail: "reader@example.com",
    originalText: "Neem een schort mee.",
    customerTranslation: "Bring an apron.",
    aiTranslation: "Bring an apron."
  }, {});
  assert.equal(job.sourceLanguage, "Dutch");
  assert.equal(job.language, "English");
  assert.equal(security.publicJob(job).sourceLanguage, "Dutch");
  assert.throws(() => security.buildClientJob({
    clientId: "client1",
    sourceLanguage: "Dutch",
    language: "Dutch",
    clientEmail: "reader@example.com",
    originalText: "Neem een schort mee.",
    aiTranslation: "Neem een schort mee."
  }, {}), /different/);
});

test("jobs from one source file share a bundle id", function () {
  const bundleId = "b_" + "ab".repeat(8);
  const job = security.buildClientJob({
    clientId: "client1",
    language: "Spanish",
    bundleId,
    clientEmail: "reader@example.com",
    originalText: "The garden is open.",
    aiTranslation: "El jardin esta abierto."
  }, {});
  assert.equal(job.bundleId, bundleId);
  assert.equal(security.publicJob(job).bundleId, bundleId);
  const stray = security.buildClientJob({
    clientId: "client1",
    language: "German",
    bundleId: "../not-a-bundle",
    clientEmail: "reader@example.com",
    originalText: "The garden is open.",
    aiTranslation: "Der Garten ist offen."
  }, {});
  assert.equal(stray.bundleId, null);
  assert.equal(security.publicJob(stray).bundleId, undefined);
});
