const test = require("node:test");
const assert = require("node:assert/strict");
const { wordDiffParts, highlightAfterFocus } = require("../public/word-diff.js");

test("word diff marks removed and added words", function () {
  const parts = wordDiffParts("Druk in de startknop.", "Druk op de startknop.");
  assert.ok(parts.some((part) => part.type === "removed" && part.text.includes("in")));
  assert.ok(parts.some((part) => part.type === "added" && part.text.includes("op")));
  assert.equal(parts.some((part) => /<[^>]+>/.test(part.text)), false);
});

test("opening a segment clears its highlight and a jump does not", function () {
  const highlights = { 3: { oldText: "oud", newText: "nieuw" }, 8: { oldText: "a", newText: "b" } };
  const opened = highlightAfterFocus(highlights, 3, false);
  assert.equal(opened[3], undefined);
  assert.deepEqual(opened[8], highlights[8]);
  const jumped = highlightAfterFocus(highlights, 3, true);
  assert.deepEqual(jumped[3], highlights[3]);
});
