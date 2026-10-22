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
  const DOUBLE_QUOTE = /[\u0022\u201C\u201D\u201E\u201F\u00AB\u00BB]/g;

  function foldQuotes(text) {
    return text.replace(DOUBLE_QUOTE, '"');
  }

  function charDiff(oldText, newText) {
    const oldStr = oldText == null ? "" : String(oldText);
    const newStr = newText == null ? "" : String(newText);
    if (typeof DiffMatchPatch !== "function") {
      throw new Error("diff-match-patch is not loaded");
    }
    const oldFold = foldQuotes(oldStr);
    const newFold = foldQuotes(newStr);
    if (oldFold === newFold) return oldStr ? [{ type: "equal", text: oldStr }] : [];
    const dmp = new DiffMatchPatch();
    dmp.Diff_Timeout = 0;
    const diffs = dmp.diff_main(oldFold, newFold);
    dmp.diff_cleanupSemantic(diffs);
    const parts = [];
    let oldPos = 0;
    let newPos = 0;
    for (let i = 0; i < diffs.length; i++) {
      const len = diffs[i][1].length;
      if (!len) continue;
      const op = diffs[i][0];
      const text = op === 1
        ? newStr.slice(newPos, newPos + len)
        : oldStr.slice(oldPos, oldPos + len);
      const type = op === 0 ? "equal" : op === -1 ? "removed" : "added";
      if (op !== 1) oldPos += len;
      if (op !== -1) newPos += len;
      const prev = parts[parts.length - 1];
      if (prev && prev.type === type) prev.text += text;
      else parts.push({ type: type, text: text });
    }
    return parts;
  }

  return { charDiff: charDiff };
});
