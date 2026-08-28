/**
 * Layout-aware document text extraction for LingoCheck.
 * Exposes window.LcDocExtract { extractPdfText, extractDocxText, extractPlainText, truncateExtractedText }
 */
(function (global) {
  const MAX_EXTRACT_CHARS = 25000;

  function collapseSpaces(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function truncateExtractedText(text, max) {
    const limit = max || MAX_EXTRACT_CHARS;
    const t = String(text || "");
    return t.length > limit ? t.slice(0, limit) : t;
  }

  function isListItemLine(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    return /^(\d+[\.\)]\s+|[a-zA-Z][\.\)]\s+|[-*•●◦▪]\s+|\(\d+\)\s+)/.test(t);
  }

  function isHeadingCandidate(line, nextLine, prevWasBlank) {
    const t = String(line || "").trim();
    if (!t || t.length > 140) return false;
    if (isListItemLine(t)) return false;
    const words = t.split(/\s+/).length;
    if (/^#{1,6}\s+/.test(t)) return true;
    if (words <= 14 && !/[.!?;:]$/.test(t) && (prevWasBlank || !nextLine || !String(nextLine).trim())) return true;
    if (words <= 10 && !/[.!?]$/.test(t) && String(nextLine || "").trim().length > t.length * 1.4) return true;
    return false;
  }

  function assembleBlocks(blocks) {
    const chunks = [];
    let listRun = [];
    let tableRun = [];

    function flushList() {
      if (listRun.length) {
        chunks.push(listRun.join("\n"));
        listRun = [];
      }
    }
    function flushTable() {
      if (tableRun.length) {
        chunks.push(tableRun.join("\n"));
        tableRun = [];
      }
    }

    for (const b of blocks) {
      const t = collapseSpaces(b.text);
      if (!t) continue;
      if (b.type === "list-item") {
        flushTable();
        listRun.push(t);
      } else if (b.type === "table-row") {
        flushList();
        tableRun.push(t);
      } else {
        flushList();
        flushTable();
        chunks.push(t);
      }
    }
    flushList();
    flushTable();
    return chunks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  async function toArrayBuffer(fileOrBuf) {
    if (fileOrBuf instanceof ArrayBuffer) return fileOrBuf;
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(fileOrBuf);
    });
  }

  function hasPdfImages(uint8) {
    try {
      const head = new TextDecoder("latin1").decode(uint8.slice(0, Math.min(uint8.length, 350000)));
      return head.includes("/Subtype /Image") || head.includes("/Image");
    } catch {
      return false;
    }
  }

  function pdfItemToGlyph(item) {
    const tr = item.transform || [1, 0, 0, 1, 0, 0];
    const x = tr[4];
    const y = tr[5];
    const fontSize = Math.max(5, Math.min(72, Math.hypot(tr[0], tr[1]) || 11));
    const str = String(item.str || "");
    const width = item.width || fontSize * Math.max(1, str.length) * 0.45;
    return { str, x, y, width, fontSize, hasEOL: !!item.hasEOL };
  }

  function groupGlyphsIntoLines(glyphs) {
    if (!glyphs.length) return [];
    const sorted = glyphs.slice().sort((a, b) => b.y - a.y || a.x - b.x);
    const lines = [];
    for (const g of sorted) {
      let placed = false;
      for (const line of lines) {
        const yTol = Math.max(2, line.fontSize * 0.45);
        if (Math.abs(line.y - g.y) > yTol) continue;
        const last = line.glyphs[line.glyphs.length - 1];
        const xGap = g.x - (last.x + last.width);
        const xTol = Math.max(line.fontSize * 1.8, 24);
        if (xGap > xTol) continue;
        line.glyphs.push(g);
        const n = line.glyphs.length;
        line.y = (line.y * (n - 1) + g.y) / n;
        line.fontSize = Math.max(line.fontSize, g.fontSize);
        placed = true;
        break;
      }
      if (!placed) lines.push({ y: g.y, fontSize: g.fontSize, glyphs: [g] });
    }
    return lines
      .map((line) => {
        const gs = line.glyphs.sort((a, b) => a.x - b.x);
        return {
          y: line.y,
          fontSize: line.fontSize,
          glyphs: gs,
          x: gs[0].x,
          x2: gs.reduce((m, g) => Math.max(m, g.x + g.width), gs[0].x),
        };
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);
  }

  function lineGlyphsToText(glyphs, gapThreshold) {
    if (!glyphs.length) return "";
    let out = "";
    let prevEnd = null;
    for (const g of glyphs) {
      const s = g.str;
      if (!s) continue;
      if (prevEnd !== null) {
        const gap = g.x - prevEnd;
        if (gap > gapThreshold) out += "\t";
        else if (!out.endsWith(" ") && !s.startsWith(" ")) out += " ";
      }
      out += s;
      prevEnd = g.x + g.width;
    }
    return collapseSpaces(out);
  }

  function medianFontSize(lines) {
    if (!lines.length) return 11;
    const sizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)] || 11;
  }

  function filterPdfLines(lines, pageWidth, pageHeight, medianSize) {
    const footnoteZone = pageHeight * 0.12;
    return lines.filter((line) => {
      const text = lineGlyphsToText(line.glyphs, line.fontSize * 0.55);
      if (!text) return false;
      const lineW = line.x2 - line.x;
      if (line.y < footnoteZone && line.fontSize < medianSize * 0.9) return false;
      if (line.x < pageWidth * 0.02 && lineW < pageWidth * 0.22) return false;
      if (line.x > pageWidth * 0.76 && lineW < pageWidth * 0.22) return false;
      if (line.fontSize < medianSize * 0.75 && text.length < 70) return false;
      return true;
    });
  }

  function linesToBlocks(lines, medianSize) {
    const blocks = [];
    let paraLines = [];
    let prevY = null;

    function flushPara() {
      if (!paraLines.length) return;
      const gapTh = paraLines[0].fontSize * 0.55;
      const texts = paraLines.map((l) => lineGlyphsToText(l.glyphs, gapTh));
      const tableLike = texts.filter((t) => t.includes("\t")).length >= Math.max(2, Math.ceil(texts.length * 0.5));
      if (tableLike) {
        for (const t of texts) blocks.push({ type: "table-row", text: t.replace(/\t/g, " | ") });
      } else {
        const isHeading = paraLines.length === 1 && paraLines[0].fontSize >= medianSize * 1.12;
        const joined = texts.join(" ");
        if (isHeading) blocks.push({ type: "heading", text: joined });
        else blocks.push({ type: "paragraph", text: joined });
      }
      paraLines = [];
    }

    for (const line of lines) {
      const gapTh = line.fontSize * 0.55;
      const text = lineGlyphsToText(line.glyphs, gapTh);
      if (!text) continue;
      const lineH = line.fontSize * 1.35;
      if (prevY !== null && prevY - line.y > lineH * 1.8) flushPara();
      if (isListItemLine(text)) {
        flushPara();
        blocks.push({ type: "list-item", text });
        prevY = line.y;
        continue;
      }
      paraLines.push(line);
      prevY = line.y;
    }
    flushPara();
    return blocks;
  }

  async function extractPdfPage(page) {
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const glyphs = [];
    for (const item of content.items) {
      if (!item.str || !String(item.str).trim()) continue;
      glyphs.push(pdfItemToGlyph(item));
    }
    const lines = groupGlyphsIntoLines(glyphs);
    const med = medianFontSize(lines);
    const kept = filterPdfLines(lines, viewport.width, viewport.height, med);
    return linesToBlocks(kept, med);
  }

  async function extractPdfText(fileOrBuf) {
    if (!global.pdfjsLib) throw new Error("PDF support not loaded");
    const buf = await toArrayBuffer(fileOrBuf);
    const uint8 = new Uint8Array(buf);
    const images = hasPdfImages(uint8);
    const doc = await global.pdfjsLib.getDocument({ data: uint8.slice(), isEvalSupported: false, disableFontFace: true }).promise;
    const allBlocks = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const blocks = await extractPdfPage(page);
      allBlocks.push(...blocks);
    }
    const text = assembleBlocks(allBlocks);
    const tooLittle = text.replace(/\s+/g, "").length < 30;
    return { text, hasImages: images, isScannedLike: tooLittle };
  }

  function xmlLocalName(el) {
    return String(el.localName || el.tagName || "").split(":").pop();
  }

  function xmlAttr(el, name) {
    if (!el) return "";
    return el.getAttribute("w:" + name) || el.getAttribute(name) || "";
  }

  function extractDocxNodeText(node) {
    const parts = [];
    function walk(n) {
      if (!n) return;
      if (n.nodeType === 3) {
        const t = n.textContent || "";
        if (t) parts.push(t);
        return;
      }
      if (n.nodeType !== 1) return;
      const tag = xmlLocalName(n);
      if (tag === "t") parts.push(n.textContent || "");
      else if (tag === "tab") parts.push("\t");
      else if (tag === "br" || tag === "cr") parts.push("\n");
      else if (tag === "noBreakHyphen") parts.push("-");
      else if (tag === "softHyphen") parts.push("");
      else for (const c of n.childNodes) walk(c);
    }
    walk(node);
    return parts.join("").replace(/\n+/g, "\n").trim();
  }

  function docxParagraphKind(p) {
    let pPr = null;
    for (const c of p.childNodes) {
      if (xmlLocalName(c) === "pPr") {
        pPr = c;
        break;
      }
    }
    if (!pPr) return "paragraph";
    let styleVal = "";
    let outlineLvl = null;
    for (const c of pPr.childNodes) {
      const tag = xmlLocalName(c);
      if (tag === "pStyle") styleVal = xmlAttr(c, "val");
      if (tag === "outlineLvl") outlineLvl = xmlAttr(c, "val");
    }
    if (/^heading/i.test(styleVal) || /^title$/i.test(styleVal) || outlineLvl !== "") return "heading";
    const text = collapseSpaces(extractDocxNodeText(p));
    if (isListItemLine(text)) return "list-item";
    return "paragraph";
  }

  function extractDocxTable(tbl) {
    const rows = [];
    for (const child of tbl.childNodes) {
      if (xmlLocalName(child) !== "tr") continue;
      const cells = [];
      for (const tc of child.childNodes) {
        if (xmlLocalName(tc) !== "tc") continue;
        const cellText = collapseSpaces(extractDocxNodeText(tc));
        cells.push(cellText);
      }
      if (cells.some(Boolean)) rows.push(cells.join(" | "));
    }
    return rows;
  }

  function walkDocxContainer(node, blocks) {
    if (!node || node.nodeType !== 1) return;
    const tag = xmlLocalName(node);
    if (tag === "p") {
      const text = collapseSpaces(extractDocxNodeText(node));
      if (!text) return;
      const kind = docxParagraphKind(node);
      blocks.push({ type: kind, text });
      return;
    }
    if (tag === "tbl") {
      for (const row of extractDocxTable(node)) blocks.push({ type: "table-row", text: row });
      return;
    }
    if (tag === "sdt") {
      for (const c of node.childNodes) {
        if (xmlLocalName(c) === "sdtContent") walkDocxContainer(c, blocks);
      }
      return;
    }
    for (const c of node.childNodes) walkDocxContainer(c, blocks);
  }

  async function extractDocxText(fileOrBuf) {
    if (!global.JSZip) throw new Error("DOCX support not loaded");
    const buf = await toArrayBuffer(fileOrBuf);
    const zip = await global.JSZip.loadAsync(buf);
    const files = Object.keys(zip.files);
    if (files.some((n) => /vbaProject\.bin|vbaData\.xml|word\/macros\//i.test(n))) {
      return { text: "", hasImages: true, hasDrawing: true, blocked: true };
    }
    const hasMedia = files.some((n) => n.startsWith("word/media/"));
    const docFile = zip.file("word/document.xml");
    if (!docFile) return { text: "", hasImages: hasMedia, hasDrawing: false };
    const xmlStr = await docFile.async("string");
    const xml = new DOMParser().parseFromString(xmlStr, "application/xml");
    const nodes = Array.from(xml.getElementsByTagName("*"));
    const hasDrawing = nodes.some((n) => n.localName === "drawing" || n.localName === "pict");
    const body = xml.getElementsByTagNameNS("*", "body")[0];
    const blocks = [];
    if (body) {
      for (const child of body.childNodes) {
        if (child.nodeType === 1) walkDocxContainer(child, blocks);
      }
    } else {
      for (const p of xml.getElementsByTagNameNS("*", "p")) {
        const text = collapseSpaces(extractDocxNodeText(p));
        if (text) blocks.push({ type: docxParagraphKind(p), text });
      }
    }
    const text = assembleBlocks(blocks);
    return { text, hasImages: hasMedia, hasDrawing, blocked: false };
  }

  function extractPlainText(raw) {
    const normalized = String(raw || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = normalized.split("\n");
    const blocks = [];
    let paraBuf = [];
    let prevBlank = true;

    function flushPara() {
      if (!paraBuf.length) return;
      blocks.push({ type: "paragraph", text: paraBuf.join(" ") });
      paraBuf = [];
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const nextTrimmed = (lines[i + 1] || "").trim();
      if (!trimmed) {
        flushPara();
        prevBlank = true;
        continue;
      }
      const indent = (line.match(/^(\s+)/) || ["", ""])[1].length;
      const prevIndent = i > 0 ? ((lines[i - 1].match(/^(\s+)/) || ["", ""])[1].length) : 0;
      if (isListItemLine(trimmed)) {
        flushPara();
        blocks.push({ type: "list-item", text: trimmed });
        prevBlank = false;
        continue;
      }
      if (isHeadingCandidate(trimmed, nextTrimmed, prevBlank)) {
        flushPara();
        blocks.push({ type: "heading", text: trimmed.replace(/^#{1,6}\s+/, "") });
        prevBlank = false;
        continue;
      }
      if (paraBuf.length && (indent !== prevIndent || (prevBlank && indent > 0))) {
        flushPara();
      }
      if (trimmed.includes("\t") || /\s{2,}\S/.test(line)) {
        flushPara();
        const cells = trimmed.split(/\t+|\s{2,}/).map(collapseSpaces).filter(Boolean);
        if (cells.length > 1) {
          blocks.push({ type: "table-row", text: cells.join(" | ") });
          prevBlank = false;
          continue;
        }
      }
      paraBuf.push(trimmed);
      prevBlank = false;
    }
    flushPara();
    return assembleBlocks(blocks);
  }

  global.LcDocExtract = {
    extractPdfText,
    extractDocxText,
    extractPlainText,
    truncateExtractedText,
    MAX_EXTRACT_CHARS,
  };
})(window);
