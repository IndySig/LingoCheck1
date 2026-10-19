const test = require("node:test");
const assert = require("node:assert/strict");
const { listMatches, applyBatch, undoBatch, undoRevisions, nextRepeatIndex, summarizeRepeats, pendingRepeatIndexes, nextUntreatedIndex, reviewPosition } = require("../propagate");

function doc(overrides = {}) {
  return {
    sources: ["The cat sat.", "The cat sat.", "The  cat   sat.", "the cat sat.", "The dog sat."],
    targets: ["De kat zat.", "De kat zat.", "De kat zat.", "De kat zat.", "De hond zat."],
    status: ["", "", "", "", ""],
    meta: [],
    ...overrides
  };
}

test("exact source match ignores extra whitespace and keeps case", function () {
  const matches = listMatches({ ...doc(), newTarget: "De kat zit." }, 0);
  assert.deepEqual(matches.map((match) => match.index), [1, 2]);
  assert.equal(matches.some((match) => match.index === 0), false);
  assert.equal(matches.some((match) => match.index === 3), false);
});

test("automatic mode overwrites checked segments and keeps their status", function () {
  const base = doc({ status: ["", "checked", "", "", ""] });
  const applied = applyBatch(base, {
    sourceIndex: 0,
    newTarget: "De kat zit.",
    mode: "auto",
    now: 10
  });
  assert.deepEqual(applied.changes.map((change) => change.index), [1, 2]);
  assert.equal(applied.targets[1], "De kat zit.");
  assert.equal(applied.targets[2], "De kat zit.");
  assert.equal(applied.status[1], "checked");
  assert.equal(applied.status[2], "");
  assert.equal(applied.changes[0].previousTarget, "De kat zat.");
  assert.equal(applied.changes[0].previousStatus, "checked");
  assert.equal(applied.meta[1].propagatedFrom, "s0");
  assert.equal(applied.meta[0].propagatedFrom, null);
});

test("each scope updates only that group", function () {
  const base = doc({
    targets: ["De kat zat.", "De kat bleef.", "De kat zat.", "De kat zat.", "De hond zat."],
    status: ["", "checked", "", "checked", ""]
  });
  const checked = applyBatch(base, { sourceIndex: 0, newTarget: "De kat zit.", scope: "checked", now: 1 });
  assert.deepEqual(checked.changes.map((change) => change.index), [1]);
  assert.equal(checked.targets[2], "De kat zat.");
  const unchecked = applyBatch(base, { sourceIndex: 0, newTarget: "De kat zit.", scope: "unchecked", now: 1 });
  assert.deepEqual(unchecked.changes.map((change) => change.index), [2]);
  assert.equal(unchecked.targets[1], "De kat bleef.");
  const all = applyBatch(base, { sourceIndex: 0, newTarget: "De kat zit.", scope: "all", now: 1 });
  assert.deepEqual(all.changes.map((change) => change.index), [1, 2]);
});

test("a target that is already identical is not counted or overwritten", function () {
  const base = doc({
    targets: ["De kat zit.", "De kat zit.", "De kat zat.", "De kat zat.", "De hond zat."],
    status: ["", "checked", "", "", ""]
  });
  const summary = summarizeRepeats(base, 0, "De kat zit.");
  assert.deepEqual(summary.indexes, [2]);
  assert.equal(summary.checked, 0);
  assert.equal(summary.unchecked, 1);
  const applied = applyBatch(base, { sourceIndex: 0, newTarget: "De kat zit.", mode: "auto", now: 3 });
  assert.deepEqual(applied.changes.map((change) => change.index), [2]);
});

test("undo restores the old target and the old status", function () {
  const base = doc({ status: ["", "checked", "", "", ""] });
  const applied = applyBatch(base, {
    sourceIndex: 0,
    newTarget: "De kat zit.",
    mode: "auto",
    now: 25
  });
  const laterStatus = applied.status.slice();
  laterStatus[1] = "";
  laterStatus[2] = "checked";
  const undone = undoBatch(applied.targets, applied.meta, laterStatus, { changes: applied.changes });
  assert.equal(undone.targets[1], "De kat zat.");
  assert.equal(undone.targets[2], "De kat zat.");
  assert.equal(undone.status[1], "checked");
  assert.equal(undone.status[2], "");
  assert.equal(undone.meta[1].propagatedFrom, null);
  assert.equal(undone.meta[2].propagatedFrom, null);
});

test("jump to next follows document order and wraps", function () {
  const order = [2, 5, 8, 11, 14];
  assert.equal(nextRepeatIndex(order, 2), 5);
  assert.equal(nextRepeatIndex(order, 8), 11);
  assert.equal(nextRepeatIndex(order, 14), 2);
});

test("a second pass does not propagate again once the targets match", function () {
  const base = doc({ status: ["", "checked", "", "", ""] });
  const first = applyBatch(base, { sourceIndex: 0, newTarget: "De kat zit.", mode: "auto", now: 4 });
  const second = applyBatch({
    sources: base.sources,
    targets: first.targets,
    status: first.status,
    meta: first.meta
  }, { sourceIndex: 0, newTarget: "De kat zit.", mode: "auto", now: 5 });
  assert.equal(second.changes.length, 0);
  assert.equal(first.changes.some((change) => change.index === 0), false);
});

test("no identical source means no matches", function () {
  const matches = listMatches({
    sources: ["One.", "Two."],
    targets: ["Een.", "Twee."],
    status: ["", ""],
    meta: [],
    newTarget: "Eén."
  }, 0);
  assert.deepEqual(matches, []);
});

test("the review bar moves to the next untreated repeat and skips handled ones", function () {
  const order = [2, 5, 8, 11, 14];
  const targets = [];
  targets[2] = "nieuw";
  targets[5] = "oud";
  targets[8] = "nieuw";
  targets[11] = "oud";
  targets[14] = "oud";
  const pending = pendingRepeatIndexes(order, 2, targets, "nieuw", []);
  assert.deepEqual(pending, [5, 11, 14]);
  const first = nextUntreatedIndex(order, 2, pending);
  assert.equal(first, 5);
  assert.equal(reviewPosition(order, first), 2);
  assert.equal(order.length, 5);

  const afterSkip = pendingRepeatIndexes(order, 2, targets, "nieuw", [5]);
  const second = nextUntreatedIndex(order, 5, afterSkip);
  assert.equal(second, 11);
  assert.equal(reviewPosition(order, second), 4);

  const afterApply = pendingRepeatIndexes(order, 2, targets, "nieuw", [5, 11]);
  const third = nextUntreatedIndex(order, 11, afterApply);
  assert.equal(third, 14);
  const done = pendingRepeatIndexes(order, 2, targets, "nieuw", [5, 11, 14]);
  assert.equal(nextUntreatedIndex(order, 14, done), -1);
});

test("apply and don't-apply each advance to the following untreated repeat", function () {
  const order = [0, 1, 2, 3];
  const base = {
    sources: ["Same.", "Same.", "Same.", "Same."],
    targets: ["nieuw", "oud", "oud", "oud"],
    status: ["checked", "", "checked", ""],
    meta: []
  };
  const applied = applyBatch(base, { sourceIndex: 0, newTarget: "nieuw", scope: "all", onlyIndexes: [1], now: 1 });
  assert.deepEqual(applied.changes.map((change) => change.index), [1]);
  assert.equal(applied.targets[2], "oud");
  assert.equal(applied.targets[1].includes("<"), false);
  const afterApply = nextUntreatedIndex(order, 1, pendingRepeatIndexes(order, 0, applied.targets, "nieuw", [1]));
  assert.equal(afterApply, 2);
  const afterSkip = nextUntreatedIndex(order, 2, pendingRepeatIndexes(order, 0, applied.targets, "nieuw", [1, 2]));
  assert.equal(afterSkip, 3);
});

test("undo of a review round restores only the applied segments", function () {
  const base = {
    sources: ["Same.", "Same.", "Same.", "Same."],
    targets: ["nieuw", "eerste", "tweede", "derde"],
    status: ["", "checked", "", ""],
    meta: []
  };
  const first = applyBatch(base, { sourceIndex: 0, newTarget: "nieuw", onlyIndexes: [1], now: 1 });
  const second = applyBatch({
    sources: base.sources,
    targets: first.targets,
    status: first.status,
    meta: first.meta
  }, { sourceIndex: 0, newTarget: "nieuw", onlyIndexes: [3], now: 2 });
  assert.equal(second.targets[1], "nieuw");
  assert.equal(second.targets[2], "tweede");
  assert.equal(second.targets[3], "nieuw");
  const undone = undoRevisions(second.targets, second.meta, second.status, [
    { changes: first.changes },
    { changes: second.changes }
  ]);
  assert.equal(undone.targets[1], "eerste");
  assert.equal(undone.targets[2], "tweede");
  assert.equal(undone.targets[3], "derde");
  assert.equal(undone.status[1], "checked");
  assert.equal(undone.targets[1].includes("<"), false);
});
