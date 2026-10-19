const test = require("node:test");
const assert = require("node:assert/strict");
const { charDiff } = require("../public/char-diff.js");

function oldTextOf(parts) {
  return parts
    .filter((p) => p.type === "equal" || p.type === "removed")
    .map((p) => p.text)
    .join("");
}

function newTextOf(parts) {
  return parts
    .filter((p) => p.type === "equal" || p.type === "added")
    .map((p) => p.text)
    .join("");
}

test("addition only", function () {
  const oldText = "boodschappenlijst.";
  const newText = "een boodschappenlijst.";
  const parts = charDiff(oldText, newText);
  assert.deepEqual(parts, [
    { type: "added", text: "een " },
    { type: "equal", text: "boodschappenlijst." },
  ]);
  assert.equal(oldTextOf(parts), oldText);
  assert.equal(newTextOf(parts), newText);
  assert.equal(parts.some((p) => p.type === "removed"), false);
});

test("deletion only", function () {
  const oldText = "een boodschappenlijst.";
  const newText = "boodschappenlijst.";
  const parts = charDiff(oldText, newText);
  assert.deepEqual(parts, [
    { type: "removed", text: "een " },
    { type: "equal", text: "boodschappenlijst." },
  ]);
  assert.equal(oldTextOf(parts), oldText);
  assert.equal(newTextOf(parts), newText);
  assert.equal(parts.some((p) => p.type === "added"), false);
});

test("change inside one word", function () {
  const parts = charDiff("boodschappenlijst", "boodschappenlijstje");
  assert.deepEqual(parts, [
    { type: "equal", text: "boodschappenlijst" },
    { type: "added", text: "je" },
  ]);
});

test("removed prefix and an edit inside the remaining word", function () {
  const oldText = "briefje met een boodschappenlijst.";
  const newText = "boodschappenlijstje.";
  const parts = charDiff(oldText, newText);
  assert.deepEqual(parts, [
    { type: "removed", text: "briefje met een " },
    { type: "equal", text: "boodschappenlijst" },
    { type: "added", text: "je" },
    { type: "equal", text: "." },
  ]);
  assert.equal(oldTextOf(parts), oldText);
  assert.equal(newTextOf(parts), newText);
});

test("several changes in one sentence", function () {
  const oldText = "De hond zat op de mat.";
  const newText = "De kat zit op de mat.";
  const parts = charDiff(oldText, newText);
  assert.deepEqual(parts, [
    { type: "equal", text: "De " },
    { type: "removed", text: "hond" },
    { type: "added", text: "kat" },
    { type: "equal", text: " z" },
    { type: "removed", text: "a" },
    { type: "added", text: "i" },
    { type: "equal", text: "t op de mat." },
  ]);
  assert.equal(oldTextOf(parts), oldText);
  assert.equal(newTextOf(parts), newText);
});

test("punctuation at the end", function () {
  const parts = charDiff("boodschappenlijst.", "boodschappenlijst!");
  assert.deepEqual(parts, [
    { type: "equal", text: "boodschappenlijst" },
    { type: "removed", text: "." },
    { type: "added", text: "!" },
  ]);
});
