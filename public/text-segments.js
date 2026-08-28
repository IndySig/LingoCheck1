/**
 * Document segmentation for LingoCheck — logical text units with wrap repair.
 * Exposes window.LcTextSegments
 */
(function (global) {
  function collapseSpaces(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function repairLineWrapArtifacts(text) {
    let t = String(text || "");
    t = t.replace(/(\d)\s+(?=\d)/g, "$1");
    t = t.replace(/([A-Za-z\u00C0-\u024F])-\s+([a-z\u00C0-\u024F])/g, "$1$2");
    return collapseSpaces(t);
  }

  function isListItemLine(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    return /^(\d+[\.\)]\s+|[a-zA-Z][\.\)]\s+|[-*•●◦▪]\s+|\(\d+\)\s+)/.test(t);
  }

  function isSectionHeading(s) {
    const t = String(s || "").trim();
    return /^\d+(?:\.\d+)+\s+\S/.test(t) || /^#{1,6}\s+/.test(t);
  }

  function isLabeledField(s) {
    const t = String(s || "").trim();
    return /^[A-Za-z][A-Za-z0-9 /&()\-]{0,48}:\s*\S/.test(t);
  }

  function endsSentence(t) {
    return /[.!?]["')\]]*$/.test(String(t || "").trim());
  }

  function isFragmentLine(line) {
    const t = String(line || "").trim();
    if (!t) return false;
    if (isListItemLine(t) || isSectionHeading(t) || isLabeledField(t)) return false;
    if (endsSentence(t) && t.split(/\s+/).length >= 6) return false;
    if (t.split(/\s+/).length <= 12 && t.length < 140 && !endsSentence(t)) return true;
    return false;
  }

  function shouldJoinLines(prev, next) {
    const a = String(prev || "").trim();
    const b = String(next || "").trim();
    if (!a || !b) return false;
    if (isListItemLine(b) || isSectionHeading(b) || isLabeledField(b)) return false;
    if (isListItemLine(a) || isSectionHeading(a)) return false;
    if (endsSentence(a) && /^[A-Z\u00C0-\u024F\u0400-\u04FF]/.test(b)) return false;
    if (/\d$/.test(a) && /^\d/.test(b)) return true;
    if (/[a-z,\u00C0-\u024F]$/.test(a) && /^[a-z0-9\u00C0-\u024F]/.test(b)) return true;
    if (!endsSentence(a) && !/[.!?;:]$/.test(a)) return true;
    if (isFragmentLine(a) && isFragmentLine(b)) return true;
    return false;
  }

  function mergeWrappedLines(lines) {
    const src = lines.map((l) => repairLineWrapArtifacts(l)).filter(Boolean);
    if (src.length <= 1) return src;
    const out = [];
    let cur = src[0];
    for (let i = 1; i < src.length; i++) {
      if (shouldJoinLines(cur, src[i])) cur = collapseSpaces(cur + " " + src[i]);
      else {
        out.push(cur);
        cur = src[i];
      }
    }
    out.push(cur);
    return out;
  }

  function mergeFragmentSegmentList(segments) {
    const out = [];
    let buf = [];
    function flush() {
      if (!buf.length) return;
      out.push(repairLineWrapArtifacts(buf.join(" ")));
      buf = [];
    }
    for (const seg of segments) {
      const t = String(seg || "").trim();
      if (!t) continue;
      if (isListItemLine(t) || isSectionHeading(t) || isLabeledField(t)) {
        flush();
        out.push(t);
        continue;
      }
      if (isFragmentLine(t)) {
        buf.push(t);
        continue;
      }
      flush();
      out.push(t);
    }
    flush();
    return out;
  }

  function mergeLinesIntoSegments(text) {
    const lines = String(text || "")
      .replace(/\r\n/g, "\n")
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return mergeFragmentSegmentList(mergeWrappedLines(lines));
  }

  function normalizeDocumentSegments(input) {
    if (Array.isArray(input)) {
      const flat = [];
      for (const item of input) {
        const t = String(item || "").trim();
        if (!t) continue;
        if (/\n/.test(t) && !/\n{2,}/.test(t)) flat.push(...mergeLinesIntoSegments(t));
        else if (/\n{2,}/.test(t)) flat.push(...normalizeDocumentSegments(t.split(/\n{2,}/)));
        else flat.push(repairLineWrapArtifacts(t));
      }
      return mergeFragmentSegmentList(flat);
    }
    const raw = String(input || "").trim();
    if (!raw) return [];
    const paras = raw.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (paras.length > 1) return mergeFragmentSegmentList(paras.flatMap((p) => normalizeDocumentSegments([p])));
    if (raw.includes("\n")) return mergeLinesIntoSegments(raw);
    return [repairLineWrapArtifacts(raw)];
  }

  function isFragmentBlock(b) {
    return isFragmentLine(collapseSpaces(b && b.text));
  }

  function mergeFragmentBlocks(blocks) {
    const out = [];
    let buf = [];
    function flush() {
      if (!buf.length) return;
      out.push({
        type: "paragraph",
        text: buf.map((b) => collapseSpaces(b.text)).join(" "),
        x: Math.min(...buf.map((b) => b.x || 0)),
        x2: Math.max(...buf.map((b) => b.x2 || 0)),
        y: Math.min(...buf.map((b) => b.y || 0)),
        y2: Math.max(...buf.map((b) => b.y2 || 0)),
        topY: Math.max(...buf.map((b) => b.topY || b.y2 || 0)),
        fontSize: Math.max(...buf.map((b) => b.fontSize || 11)),
      });
      buf = [];
    }
    for (const b of blocks) {
      const t = collapseSpaces(b.text);
      if (!t) continue;
      if (b.type === "list-item" || b.type === "table-row") {
        flush();
        out.push(b);
        continue;
      }
      if (isFragmentBlock(b)) {
        buf.push(b);
        continue;
      }
      flush();
      out.push(b);
    }
    flush();
    return out;
  }

  function isAbbreviationBeforePeriod(text, punctIndex) {
    const left = text.slice(0, punctIndex);
    const m = left.match(/([A-Za-z]{1,12})\.$/);
    if (!m) return false;
    const w = m[1].toLowerCase();
    const abbrevs = new Set([
      "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "inc", "ltd", "corp", "co", "eg", "ie", "etc", "vs",
      "approx", "dept", "est", "vol", "no", "art", "sec", "fig", "ref", "p", "pp", "ed", "eds", "rev",
      "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
      "mon", "tue", "wed", "thu", "fri", "sat", "sun", "st", "ave", "blvd", "de", "van", "der", "po", "box",
    ]);
    if (abbrevs.has(w)) return true;
    if (m[1].length === 1 && /[A-Za-z]/.test(m[1])) return true;
    return false;
  }

  function shouldSkipPeriodSplit(text, punctIndex) {
    const charBefore = punctIndex > 0 ? text[punctIndex - 1] : "";
    if (/\d/.test(charBefore)) {
      const after = text.slice(punctIndex);
      if (/^\.\d/.test(after)) return true;
      if (/^\.\s+[A-Za-z\u00C0-\u024F]/.test(after)) return true;
    }
    if (isAbbreviationBeforePeriod(text, punctIndex)) return true;
    return false;
  }

  function splitSegmentIntoSentences(segment) {
    const t = repairLineWrapArtifacts(segment);
    if (!t) return [];

    const boundarySignals =
      (t.match(/[.!?](?:\s|$)/g) || []).length +
      (t.match(/;\s+/g) || []).length +
      (t.match(/:\s+[A-Z\u00C0-\u024F]/g) || []).length +
      (t.match(/\s[—–]\s/g) || []).length +
      (t.match(/\s+\d+[\.\)]\s+/g) || []).length;
    if (
      t.length < 260 &&
      boundarySignals <= 1 &&
      !/\.\s+[A-Z\u00C0-\u024F]/.test(t) &&
      !/;\s+[A-Z\u00C0-\u024F]/.test(t)
    ) {
      return [t];
    }

    const boundaries = [];
    function addBoundary(pos, priority) {
      if (pos <= 0 || pos >= t.length) return;
      boundaries.push({ pos, priority });
    }

    let m;
    const endRe = /([.!?]+(?:["')\]]*))(\s+)/g;
    while ((m = endRe.exec(t)) !== null) {
      if (shouldSkipPeriodSplit(t, m.index)) continue;
      const after = t.slice(m.index + m[0].length);
      if (!after) continue;
      if (/^[a-z\u00E0-\u00FF]/.test(after) && !/^[a-z]\)/.test(after)) continue;
      addBoundary(m.index + m[1].length, 1);
    }

    const semiRe = /;(\s+)/g;
    while ((m = semiRe.exec(t)) !== null) {
      const left = t.slice(0, m.index).trim();
      const after = t.slice(m.index + m[0].length);
      if (left.length < 20) continue;
      if (/^[A-Z\u00C0-\u024F\u0400-\u04FF0-9"(]/.test(after)) addBoundary(m.index, 2);
    }

    const colonRe = /:(\s+)/g;
    while ((m = colonRe.exec(t)) !== null) {
      const left = t.slice(0, m.index).trim();
      const after = t.slice(m.index + m[0].length);
      if (/\d:\d/.test(t.slice(Math.max(0, m.index - 2), m.index + 3))) continue;
      if (left.length < 8 || left.length > 140) continue;
      if (!/^[A-Z\u00C0-\u024F\u0400-\u04FF"']/.test(after)) continue;
      addBoundary(m.index, 3);
    }

    const dashRe = /\s+([—–])(\s+)/g;
    while ((m = dashRe.exec(t)) !== null) {
      const left = t.slice(0, m.index).trim();
      const right = t.slice(m.index + m[0].length).trim();
      if (left.length >= 18 && right.length >= 8) addBoundary(m.index, 4);
    }

    const embeddedListRe = /\s+(\d+[\.\)]\s+)/g;
    while ((m = embeddedListRe.exec(t)) !== null) {
      if (t.slice(0, m.index).trim().length >= 8) addBoundary(m.index, 2);
    }

    const letteredRe = /\s+(\([a-zA-Z]\)\s+)/g;
    while ((m = letteredRe.exec(t)) !== null) {
      if (t.slice(0, m.index).trim().length >= 8) addBoundary(m.index, 2);
    }

    if (!boundaries.length) return [t];

    boundaries.sort((a, b) => a.pos - b.pos || a.priority - b.priority);
    const picked = [];
    let lastPos = -1;
    for (const b of boundaries) {
      if (b.pos <= lastPos + 2) continue;
      picked.push(b.pos);
      lastPos = b.pos;
    }

    const out = [];
    let start = 0;
    for (const pos of picked) {
      const chunk = t.slice(start, pos).trim();
      if (chunk) out.push(chunk);
      start = pos;
      while (start < t.length && /[\s;:]/.test(t[start])) start += 1;
    }
    const tail = t.slice(start).trim();
    if (tail) out.push(tail);
    return out.length ? out : [t];
  }

  function segmentsToDisplayText(segments) {
    return normalizeDocumentSegments(segments).join("\n\n");
  }

  function buildSentenceUnits(segments) {
    let normalized = normalizeDocumentSegments(segments);
    if (normalized.length > 2) {
      const avgLen = normalized.reduce((sum, t) => sum + t.length, 0) / normalized.length;
      if (avgLen < 24) {
        normalized = normalizeDocumentSegments(normalized.join(" "));
      }
    }
    const sentences = [];
    const paraMap = [];
    normalized.forEach((seg, pi) => {
      splitSegmentIntoSentences(seg).forEach((s) => {
        sentences.push(s);
        paraMap.push(pi);
      });
    });
    return { sentences, paraMap, paragraphCount: normalized.length };
  }

  function alignSentenceTranslations(segments, translationText, storedTranslationSentences) {
    const normalized = normalizeDocumentSegments(segments);
    const sourceSentences = [];
    const paraMap = [];
    normalized.forEach((seg, pi) => {
      splitSegmentIntoSentences(seg).forEach((s) => {
        sourceSentences.push(s);
        paraMap.push(pi);
      });
    });

    if (
      Array.isArray(storedTranslationSentences) &&
      storedTranslationSentences.length === sourceSentences.length
    ) {
      return {
        sentences: sourceSentences,
        transSentences: storedTranslationSentences.map((s) => String(s || "")),
        paraMap,
        paragraphCount: normalized.length,
      };
    }

    const transSegments = [];
    const transText = String(translationText || "").trim();
    const transParts = normalizeDocumentSegments(transText);
    if (transParts.length === normalized.length) {
      transSegments.push(...transParts);
    } else {
      const weights = normalized.map((s) => Math.max(1, String(s).replace(/\s+/g, "").length));
      const total = weights.reduce((a, b) => a + b, 0) || 1;
      const words = transText.replace(/\n+/g, " ").split(/\s+/).filter(Boolean);
      let idx = 0;
      for (let i = 0; i < normalized.length; i++) {
        const take =
          i === normalized.length - 1
            ? words.length - idx
            : Math.max(0, Math.round(words.length * (weights[i] / total)));
        transSegments.push(words.slice(idx, idx + take).join(" "));
        idx += take;
      }
    }

    const transSentences = [];
    normalized.forEach((seg, pi) => {
      const origSents = splitSegmentIntoSentences(seg);
      const transSeg = transSegments[pi] || "";
      let aligned = splitSegmentIntoSentences(transSeg);
      if (aligned.length !== origSents.length) {
        const segWeights = origSents.map((s) => Math.max(1, String(s).replace(/\s+/g, "").length));
        const segWords = transSeg.replace(/\n+/g, " ").split(/\s+/).filter(Boolean);
        const segTotal = segWeights.reduce((a, b) => a + b, 0) || 1;
        aligned = [];
        let wIdx = 0;
        for (let i = 0; i < origSents.length; i++) {
          const take =
            i === origSents.length - 1
              ? segWords.length - wIdx
              : Math.max(0, Math.round(segWords.length * (segWeights[i] / segTotal)));
          aligned.push(segWords.slice(wIdx, wIdx + take).join(" "));
          wIdx += take;
        }
      }
      transSentences.push(...aligned);
    });

    while (transSentences.length < sourceSentences.length) transSentences.push("");
    if (transSentences.length > sourceSentences.length) transSentences.length = sourceSentences.length;

    return {
      sentences: sourceSentences,
      transSentences,
      paraMap,
      paragraphCount: normalized.length,
    };
  }

  function rebuildTextFromSentences(sentences, paraMap) {
    const maxPi = paraMap.length ? Math.max(...paraMap) : 0;
    const buckets = Array.from({ length: maxPi + 1 }, () => []);
    (sentences || []).forEach((s, i) => {
      const part = String(s || "").trim();
      if (!part) return;
      buckets[paraMap[i] ?? 0].push(part);
    });
    return segmentsToDisplayText(buckets.map((b) => b.join(" ")).filter(Boolean));
  }

  const SENTENCE_DELIM = "\u241E";

  global.LcTextSegments = {
    repairLineWrapArtifacts,
    normalizeDocumentSegments,
    mergeWrappedLines,
    mergeLinesIntoSegments,
    mergeFragmentBlocks,
    mergeFragmentSegmentList,
    splitSegmentIntoSentences,
    segmentsToDisplayText,
    buildSentenceUnits,
    alignSentenceTranslations,
    rebuildTextFromSentences,
    SENTENCE_DELIM,
    shouldJoinLines,
    isListItemLine,
    isSectionHeading,
    isLabeledField,
    isFragmentLine,
  };
})(window);
