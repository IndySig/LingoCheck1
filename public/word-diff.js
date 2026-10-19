/**
 * Word-level preview for a propagated target. Visual only: the stored
 * sentence stays plain text.
 */
(function (root, factory) {
  const api = typeof module === "object" && module.exports
    ? factory(require("diff"))
    : factory(root.Diff);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LcWordDiff = api;
})(typeof window !== "undefined" ? window : global, function (Diff) {
  function wordDiffParts(oldText, newText) {
    const parts = Diff.diffWords(String(oldText == null ? "" : oldText), String(newText == null ? "" : newText));
    return parts.map(function (part) {
      return {
        type: part.added ? "added" : part.removed ? "removed" : "equal",
        text: part.value
      };
    }).filter(function (part) { return part.text; });
  }

  function highlightAfterFocus(highlights, index, fromJump) {
    const current = highlights || {};
    if (fromJump || !Object.prototype.hasOwnProperty.call(current, index)) return current;
    const next = Object.assign({}, current);
    delete next[index];
    return next;
  }

  return { wordDiffParts: wordDiffParts, highlightAfterFocus: highlightAfterFocus };
});
