const test = require("node:test");
const assert = require("node:assert/strict");
const security = require("../security");

function job(status) {
  return {
    id: "j_test",
    clientId: "client",
    status,
    language: "Dutch",
    originalText: "The garden is open.",
    aiTranslation: "De tuin is open.",
    qaOnly: true,
    qaFindings: {
      summary: "One wording change.",
      issues: [{ severity: "low", detail: "open was kept." }]
    },
    sentenceStatus: ["checked", "nope", "checked"]
  };
}

test("the customer receives the AI summary only after review is complete", function () {
  assert.equal(security.publicJob(job("in_progress")).qaFindings, null);
  assert.equal(security.publicJob(job("complete")).qaFindings.summary, "One wording change.");
});

test("the reviewer can see the summary while the job is still open", function () {
  assert.equal(security.revisorJob(job("in_progress")).qaFindings.summary, "One wording change.");
});

test("a completed send is rejected while any segment is unchecked", function () {
  assert.equal(security.uncheckedSendError(["checked", ""], 2), "1 segment still needs to be checked before sending to the client.");
  assert.equal(security.uncheckedSendError(["", ""], 2), "2 segments still need to be checked before sending to the client.");
  assert.equal(security.uncheckedSendError(["checked", "checked"], 2), "");
  assert.equal(security.uncheckedSendError(null, 3), "");
});

test("sentence status only keeps checked or blank", function () {
  assert.deepEqual(security.sanitizeSentenceStatus(["checked", "done", 1, "checked"]), ["checked", "", "", "checked"]);
  assert.deepEqual(security.revisorJob(job("in_progress")).sentenceStatus, ["checked", "", "checked"]);
});
