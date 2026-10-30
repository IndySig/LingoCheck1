// Shared file rebuild used by the client download and the revisor preview.
function base64ToUint8Array(b64){
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return bytes;
}

function escapeXml(s){
  return String(s||"")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll("\"","&quot;")
    .replaceAll("'","&apos;");
}

async function makeDocxBlobFromText(text){
  if(!window.JSZip) throw new Error("DOCX support not loaded");
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);

  zip.folder("_rels").file(".rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);

  const lines = String(text||"").split(/\n{2,}/g).map(s=>s.trim()).filter(Boolean);
  const paras = (lines.length?lines:[String(text||"").trim()]).map(p=>{
    const run = escapeXml(p).split(/\n/g).map(x=>x.trim()).filter(Boolean).join(" ");
    return `<w:p><w:r><w:t xml:space="preserve">${run}</w:t></w:r></w:p>`;
  }).join("");

  zip.folder("word").file("document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paras}
    <w:sectPr/>
  </w:body>
</w:document>`);

  zip.folder("word").folder("_rels").file("document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);

  const now = new Date().toISOString();
  zip.folder("docProps").file("core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
 xmlns:dc="http://purl.org/dc/elements/1.1/"
 xmlns:dcterms="http://purl.org/dc/terms/"
 xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Translation</dc:title>
  <dc:creator>LingoCheck</dc:creator>
  <cp:lastModifiedBy>LingoCheck</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`);

  zip.folder("docProps").file("app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
 xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>LingoCheck</Application>
</Properties>`);

  const buf = await zip.generateAsync({ type: "uint8array" });
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function decodeXmlText(s){
  return String(s||"")
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&apos;/g,"'");
}

function collectDocxParagraphTexts(xmlStr){
  const texts = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while((m = re.exec(xmlStr))){
    const parts = [...m[0].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(x=>decodeXmlText(x[1]));
    const text = parts.join("").replace(/\s+/g," ").trim();
    if(text) texts.push(text);
  }
  return texts;
}

function alignTranslatedParagraphs(translated, originalTexts){
  var TS = window.LcTextSegments;
  var originals = TS
    ? TS.normalizeDocumentSegments(originalTexts || [])
    : (originalTexts||[]).map(function(s){ return String(s||"").trim(); }).filter(Boolean);
  if(!originals.length) return [String(translated||"").trim()];
  var n = originals.length;
  var text = String(translated||"").trim();
  if(!text) return Array.from({length:n}, function(){ return ""; });

  var parts = text.split(/\n{2,}/).map(function(s){ return s.trim(); }).filter(Boolean);
  if(parts.length === n) return parts;

  if(parts.length > n){
    var out = [];
    var j = 0;
    for(var i=0;i<n;i++){
      if(i === n - 1){
        out.push(parts.slice(j).join("\n\n"));
        break;
      }
      var remaining = parts.length - j;
      var slotsLeft = n - i;
      var weights = originals.slice(i).map(function(s){ return Math.max(1, String(s).replace(/\s+/g,"").length); });
      var weightLeft = weights.reduce(function(a,b){ return a+b; }, 0) || 1;
      var take = Math.max(1, Math.round(remaining * (weights[0] / weightLeft)));
      take = Math.min(take, remaining - (slotsLeft - 1));
      out.push(parts.slice(j, j + take).join("\n\n"));
      j += take;
    }
    return out;
  }

  var weights = originals.map(function(s){ return Math.max(1, String(s).replace(/\s+/g,"").length); });
  return splitTextByWeights(text.replace(/\n+/g, " "), weights);
}

function replaceDocxParagraphTexts(xmlStr, newTexts){
  let slot = 0;
  return xmlStr.replace(/<w:p\b[\s\S]*?<\/w:p>/g, block=>{
    const found = [...block.matchAll(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g)];
    if(!found.length) return block;
    const original = found.map(x=>decodeXmlText(x[2])).join("").replace(/\s+/g," ").trim();
    if(!original) return block;
    const next = newTexts[slot] || "";
    slot += 1;
    let used = false;
    return block.replace(/<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g, (full, attrs)=>{
      if(!used){
        used = true;
        const a = /xml:space\s*=/.test(attrs) ? attrs : `${attrs} xml:space="preserve"`;
        return `<w:t${a}>${escapeXml(next)}</w:t>`;
      }
      return `<w:t${attrs}></w:t>`;
    });
  });
}

async function makeStyledDocxBlobFromTemplate(templateDocxB64, translatedText, originalSegments){
  if(!window.JSZip) throw new Error("DOCX support not loaded");
  var bytes = base64ToUint8Array(templateDocxB64);
  var zip = await JSZip.loadAsync(bytes);
  var docFile = zip.file("word/document.xml");
  if(!docFile) throw new Error("DOCX template missing document.xml");
  var xmlStr = await docFile.async("string");
  var originals = (originalSegments && originalSegments.length)
    ? originalSegments
    : collectDocxParagraphTexts(xmlStr);
  var slots = alignTranslatedParagraphs(translatedText, originals);
  zip.file("word/document.xml", replaceDocxParagraphTexts(xmlStr, slots));
  var out = await zip.generateAsync({ type:"uint8array", compression:"DEFLATE", compressionOptions:{ level:6 } });
  return new Blob([out], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

function winAnsiSafe(s){
  // Helvetica / WinAnsi can't draw many Unicode bullets and symbols used in manuals.
  return String(s||"")
    .replace(/[\u2022\u2023\u2043\u2219\u25AA\u25AB\u25CF\u25E6\u25A0\u25A1\u25CB\u25E7▪•●◦▪︎]/g, "-")
    .replace(/[\u2013\u2014\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/\u00A0/g, " ")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

function wrapPdfLine(font, str, fontSize, maxWidth){
  const words = winAnsiSafe(String(str||"")).split(/\s+/).filter(Boolean);
  if(!words.length) return [""];
  const lines = [];
  let cur = "";
  for(const w of words){
    const test = cur ? (cur + " " + w) : w;
    const width = font.widthOfTextAtSize(test, fontSize);
    if(width <= maxWidth){
      cur = test;
    }else{
      if(cur) lines.push(cur);
      cur = w;
    }
  }
  if(cur) lines.push(cur);
  return lines;
}

function splitTextByWeights(text, weights){
  const words = String(text||"").split(/\s+/).filter(Boolean);
  if(!weights.length) return [words.join(" ")];
  const total = weights.reduce((a,b)=>a+b,0) || 1;
  const result = [];
  let idx = 0;
  for(let i=0;i<weights.length;i++){
    const take = i === weights.length-1
      ? words.length - idx
      : Math.max(0, Math.round(words.length * (weights[i] / total)));
    result.push(words.slice(idx, idx + take).join(" "));
    idx += take;
  }
  if(idx < words.length && result.length){
    result[result.length-1] = [result[result.length-1], words.slice(idx).join(" ")].filter(Boolean).join(" ");
  }
  return result;
}

function drawPdfSlotText(page, font, text, slot){
  var safe = winAnsiSafe(String(text||"").trim());
  var fontSize = slot.fontSize || 11;
  var pad = 4;
  var blockX = Math.max(0, slot.x - pad);
  var maxW = Math.max(30, (slot.x2 - slot.x) || 200);
  var topY = slot.topY || slot.y2 || slot.y;
  var minH = fontSize * 1.5;
  if(!safe){
    page.drawRectangle({ x:blockX, y:topY - minH - pad, width:maxW + pad*2, height:minH + pad*2, color:PDFLib.rgb(1,1,1) });
    return;
  }
  var wrapped = wrapPdfLine(font, safe, fontSize, maxW);
  var lineH = fontSize * 1.25;
  var textH = wrapped.length * lineH;
  var rectH = Math.max(minH, textH) + pad * 2;
  page.drawRectangle({ x:blockX, y:topY - textH - pad, width:maxW + pad*2, height:rectH, color:PDFLib.rgb(1,1,1) });
  var y = topY;
  for(var i=0;i<wrapped.length;i++){
    if(!wrapped[i]) continue;
    var sz = fontSize;
    while(sz > 5 && font.widthOfTextAtSize(wrapped[i], sz) > maxW) sz -= 0.25;
    page.drawText(wrapped[i], { x:slot.x, y:y, size:sz, font:font, color:PDFLib.rgb(0,0,0) });
    y -= lineH;
  }
}

async function makeStyledPdfBlobFromTemplate(templatePdfB64, translatedText, originalSegments){
  if(!window.pdfjsLib || !window.PDFLib) throw new Error("PDF support not loaded");
  if(!window.LcDocExtract || !LcDocExtract.extractPdfReplaceLayout) throw new Error("Document parser not loaded");
  var bytes = base64ToUint8Array(templatePdfB64);
  var layout = await LcDocExtract.extractPdfReplaceLayout(bytes);
  if(!layout.pages.some(function(p){ return p.slots && p.slots.length; })){
    return { blob: await makePdfBlobFromText(translatedText), mode: "clean", reason: "no layout" };
  }

  var assessment = LcDocExtract.assessPdfLayoutPreserve
    ? LcDocExtract.assessPdfLayoutPreserve(layout)
    : { viable: false, reason: "complex layout" };
  if(!assessment.viable){
    return { blob: await makePdfBlobFromText(translatedText), mode: "clean", reason: assessment.reason || "complex layout" };
  }

  var slotTexts = (layout.slotTexts && layout.slotTexts.length)
    ? layout.slotTexts
    : layout.pages.flatMap(function(p){ return (p.slots || []).map(function(s){ return s.text; }); });
  var originals = (originalSegments && originalSegments.length)
    ? originalSegments
    : (layout.segments && layout.segments.length ? layout.segments : slotTexts);
  var transParts = alignTranslatedParagraphs(translatedText, originals);
  var pdfDoc = await PDFLib.PDFDocument.load(bytes);
  var font = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
  var pages = pdfDoc.getPages();
  var allSlots = layout.pages.flatMap(function(p){ return p.slots || []; });

  if(originals.length !== slotTexts.length && LcDocExtract.assignPdfSlotsToSegments){
    var groups = LcDocExtract.assignPdfSlotsToSegments(allSlots, originals);
    var pageStarts = [];
    var offset = 0;
    layout.pages.forEach(function(pageLayout){
      pageStarts.push(offset);
      offset += (pageLayout.slots || []).length;
    });
    groups.forEach(function(group, segIndex){
      if(!group.length) return;
      var slotPos = allSlots.indexOf(group[0]);
      var pageIndex = 0;
      for(var pi = pageStarts.length - 1; pi >= 0; pi--){
        if(slotPos >= pageStarts[pi]){ pageIndex = pi; break; }
      }
      var page = pages[pageIndex];
      if(!page) return;
      var bounds = LcDocExtract.mergePdfSlotBounds(group);
      if(bounds) drawPdfSlotText(page, font, transParts[segIndex] || "", bounds);
    });
  }else{
    var slotIdx = 0;
    layout.pages.forEach(function(pageLayout, pageIndex){
      var page = pages[pageIndex];
      if(!page || !pageLayout.slots) return;
      pageLayout.slots.forEach(function(slot){
        drawPdfSlotText(page, font, transParts[slotIdx] || "", slot);
        slotIdx += 1;
      });
    });
  }

  var out = await pdfDoc.save();
  return { blob: new Blob([out], { type: "application/pdf" }), mode: "layout" };
}

async function makePdfBlobFromText(text){
  if(!window.PDFLib) throw new Error("PDF export not loaded");
  const { PDFDocument, StandardFonts } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontSize = 11;
  const margin = 50;
  const lineHeight = 14;

  function wrapLine(str, maxWidth){
    const words = String(str||"").split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for(const w of words){
      const test = cur ? (cur + " " + w) : w;
      let width;
      try{
        width = font.widthOfTextAtSize(test, fontSize);
      }catch{
        width = test.length * fontSize * 0.5;
      }
      if(width <= maxWidth){
        cur = test;
      }else{
        if(cur) lines.push(cur);
        cur = w;
      }
    }
    if(cur) lines.push(cur);
    return lines;
  }

  const paragraphs = winAnsiSafe(String(text||"")).split(/\n{2,}/g);
  let page = pdfDoc.addPage();
  let { width, height } = page.getSize();
  let y = height - margin;
  const maxWidth = width - margin*2;

  for(const para of paragraphs){
    const raw = para.replace(/\s+/g," ").trim();
    const lines = raw ? wrapLine(raw, maxWidth) : [""];
    for(const line of lines){
      if(y < margin){
        page = pdfDoc.addPage();
        ({ width, height } = page.getSize());
        y = height - margin;
      }
      const safeLine = winAnsiSafe(line);
      if(safeLine){
        page.drawText(safeLine, { x: margin, y, size: fontSize, font, color: PDFLib.rgb(0,0,0) });
      }
      y -= lineHeight;
    }
    y -= lineHeight; // paragraph gap
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: "application/pdf" });
}

// ══════════════════════════════════════════════════════
