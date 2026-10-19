/**
 * Character diff for a customer correction.
 * oldText is the customer's wording. newText is the LingoCheck wording.
 * Uses diff-match-patch with semantic cleanup so edits inside a word stay grouped.
 */
(function (root, factory) {
  const DiffMatchPatch =
    typeof module === "object" && module.exports
      ? require("diff-match-patch")
      : root.diff_match_patch;
  const api = factory(DiffMatchPatch);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LcCharDiff = api;
})(typeof self !== "undefined" ? self : this, function (DiffMatchPatch) {
  function charDiff(oldText, newText) {
    const oldStr = oldText == null ? "" : String(oldText);
    const newStr = newText == null ? "" : String(newText);
    if (typeof DiffMatchPatch !== "function") {
      throw new Error("diff-match-patch is not loaded");
    }
    if (oldStr === newStr) return oldStr ? [{ type: "equal", text: oldStr }] : [];
    const dmp = new DiffMatchPatch();
    dmp.Diff_Timeout = 0;
    const diffs = dmp.diff_main(oldStr, newStr);
    dmp.diff_cleanupSemantic(diffs);
    const parts = [];
    for (let i = 0; i < diffs.length; i++) {
      const text = diffs[i][1];
      if (!text) continue;
      const op = diffs[i][0];
      const type = op === 0 ? "equal" : op === -1 ? "removed" : "added";
      const prev = parts[parts.length - 1];
      if (prev && prev.type === type) prev.text += text;
      else parts.push({ type: type, text: text });
    }
    return parts;
  }

  return { charDiff: charDiff };
});
