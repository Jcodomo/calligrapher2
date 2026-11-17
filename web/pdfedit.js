// pdfedit.js — "PDF editor" mode for Calligrapher 2. A Stirling-PDF-style tool
// grid, implemented entirely in the browser (pdf.js + pdf-lib, with JSZip and
// tesseract.js lazy-loaded on demand). Nothing is uploaded.
//
// Tools that genuinely need a server (Office conversions, Translate, generic
// convert, password-encryption) are shown with a clear explanation instead of a
// broken button — Stirling runs those on a backend (LibreOffice / Tesseract), which
// a static site can't do. Everything else runs locally.

import { saveRecent, listRecents, getRecent, delRecent, makeRecentCard } from "./recents.js?v=1";

const $ = (id) => document.getElementById(id);

let sources = [];          // { id, name, bytes:Uint8Array }
let pages = [];            // { srcId, srcIndex, rot, red:[{x,y,w,h}] }  rot ∈ {0,90,180,270}
const selected = new Set();// indices into `pages`
const jsDocs = new Map();  // srcId -> pdf.js document
const thumbCache = new Map();
let srcSeq = 1, dragFrom = -1, redactMode = false, activeTool = null;
// Edit Text mode state
let etSrc = null, etPageNum = 1, etScale = 1, etBgCtx = null, etCanvasH = 0, etAddMode = false;
const etEdits = new Map(); // pageIndex -> { changes:[{idx,px,py,psize,pw,fontKey,bg,fg,text}], adds:[{pdfX,pdfYbaseline,pdfSize,fontKey,fg,text}] }

const pdfjs = () => window.pdfjsLib;
const PDFLib = () => window.PDFLib;

// ---- small utilities -------------------------------------------------------
function dl(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
function note(msg, bad) {
  const e = $("pe_err"); if (!e) return;
  e.textContent = msg; e.className = "err" + (bad ? "" : " ok");
  if (!bad) setTimeout(() => { if (e.textContent === msg) e.textContent = ""; }, 7000);
}
const scriptCache = new Map();
function loadScript(src) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load " + src));
    document.head.appendChild(s);
  });
  scriptCache.set(src, p); return p;
}
async function ensureJsZip() {
  if (!window.JSZip) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
  return window.JSZip;
}
async function ensureTesseract() {
  if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
  return window.Tesseract;
}

async function jsDoc(src) {
  if (jsDocs.has(src.id)) return jsDocs.get(src.id);
  const d = await pdfjs().getDocument({ data: src.bytes.slice() }).promise; // slice keeps bytes intact for export
  jsDocs.set(src.id, d); return d;
}
async function rasterize(entry, scale = 2) {
  const src = sources.find((s) => s.id === entry.srcId);
  const d = await jsDoc(src);
  const page = await d.getPage(entry.srcIndex + 1);
  const rotation = ((page.rotate || 0) + entry.rot) % 360;
  const vp = page.getViewport({ scale, rotation });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c;
}

// ---- open / merge ----------------------------------------------------------
async function addSourceBytes(name, bytes) {
  const id = "src" + srcSeq++;
  const src = { id, name, bytes };
  sources.push(src);
  const d = await jsDoc(src);
  for (let i = 0; i < d.numPages; i++) pages.push({ srcId: id, srcIndex: i, rot: 0, red: [] });
  return { src, numPages: d.numPages };
}
async function addFiles(fileList) {
  let added = 0;
  for (const f of fileList) {
    const pic = isImgFile(f);
    if (!pic && f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) continue;
    try {
      if (pic) { const { bytes } = await imageFileToPdf(f); const r = await addSourceBytes(f.name, new Uint8Array(bytes)); r.src.picture = true; added += r.numPages; continue; }
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await addSourceBytes(f.name, bytes);
      added += r.numPages;
      rememberSource(r.src).catch(() => {});
    } catch (e) { note("Could not open " + f.name + ": " + (e.message || e), true); }
  }
  if (added) { buildGrid(); renderGrid(); }
}
// ---- recent documents (shared store with Sign & scan) ----------------------
async function rememberSource(src) {
  let thumb = "";
  try { const c = await rasterize({ srcId: src.id, srcIndex: 0, rot: 0 }, 0.3); thumb = c.toDataURL("image/jpeg", 0.6); } catch (_) {}
  await saveRecent({ name: src.name, type: "pdf", bytes: src.bytes, thumb });
  renderPeRecents();
}
async function openRecent(id) {
  const rec = await getRecent(id); if (!rec) return;
  sources = []; pages = []; selected.clear(); jsDocs.clear(); thumbCache.clear(); srcSeq = 1;
  try {
    await addSourceBytes(rec.name, new Uint8Array(rec.bytes));
    buildGrid(); renderGrid(); note("Opened " + rec.name + ".");
  } catch (e) { note("Could not reopen " + rec.name + ": " + (e.message || e), true); }
}
async function renderPeRecents() {
  const host = $("pe_recent"); if (!host) return;
  const list = await listRecents();
  host.innerHTML = list.length ? '<div class="rlabel">Recent</div>' : "";
  for (const r of list) host.appendChild(makeRecentCard(r, () => openRecent(r.id), async () => { await delRecent(r.id); renderPeRecents(); }));
}
function pickFiles(accept, multiple, cb) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = accept; inp.multiple = !!multiple;
  inp.onchange = () => { if (inp.files && inp.files.length) cb(inp.files); };
  inp.click();
}

// ---- thumbnail grid (the page workspace) -----------------------------------
async function thumb(entry, scale = 0.6) {
  const key = entry.srcId + "|" + entry.srcIndex + "|" + entry.rot;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = await rasterize(entry, scale);
  const url = c.toDataURL("image/jpeg", 0.72);
  thumbCache.set(key, url); return url;
}
function renderGrid() {
  const stage = $("pdfedit_stage"); if (!stage) return;
  if (!pages.length) {
    stage.innerHTML = '<div style="margin:auto;color:var(--muted);font-size:14px;text-align:center">Nothing open yet — drop PDFs or pictures here (all at once or one by one),<br>or use “Add PDFs or pictures” on the right.</div>';
    return;
  }
  stage.innerHTML = "";
  stage.appendChild(viewBar());
  if (viewMode === "full") { renderFullPage(stage); return; }
  pages.forEach((entry, idx) => {
    const d = document.createElement("div");
    d.className = "pe-thumb" + (selected.has(idx) ? " sel" : "");
    d.draggable = !redactMode; d.dataset.idx = String(idx);
    d.innerHTML =
      '<div class="pe-ph">…</div>' +
      '<span class="pe-num">' + (idx + 1) + '</span>' +
      '<input type="checkbox" class="pe-chk"' + (selected.has(idx) ? " checked" : "") + '>' +
      (dupMarks.has(entry) ? '<span class="pe-dup">Same as page ' + (pages.indexOf(dupMarks.get(entry)) + 1) + '</span>' : '') +
      '<div class="pe-bar">' +
        '<button data-a="rl" title="Rotate left">⟲</button>' +
        '<button data-a="rr" title="Rotate right">⟳</button>' +
        '<button data-a="dup" title="Duplicate">⧉</button>' +
        '<button data-a="del" title="Delete">🗑</button>' +
      '</div>';
    d.querySelector(".pe-chk").onchange = (e) => {
      if (e.target.checked) selected.add(idx); else selected.delete(idx);
      d.classList.toggle("sel", e.target.checked);
    };
    d.querySelectorAll(".pe-bar button").forEach((b) =>
      b.onclick = (e) => { e.stopPropagation(); act(b.dataset.a, idx); });
    d.addEventListener("dblclick", (e) => { if (!e.target.closest(".pe-bar,.pe-chk")) setView("full", idx); });
    if (!redactMode) {
      d.addEventListener("dragstart", () => { dragFrom = idx; });
      d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("drop"); });
      d.addEventListener("dragleave", () => d.classList.remove("drop"));
      d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("drop"); reorder(dragFrom, idx); });
    }
    stage.appendChild(d);
    thumb(entry).then((url) => {
      const ph = d.querySelector(".pe-ph");
      if (!ph) return;
      const wrap = document.createElement("div"); wrap.className = "pe-imgwrap"; wrap.style.position = "relative";
      const img = new Image(); img.src = url; img.draggable = false; wrap.appendChild(img);
      ph.replaceWith(wrap);
      if (redactMode) enableRedactDraw(wrap, entry);
      drawRedactBoxes(wrap, entry);
    }).catch(() => {});
  });
}
function act(a, idx) {
  const p = pages[idx]; if (!p) return;
  if (a === "rl") p.rot = (p.rot + 270) % 360;
  else if (a === "rr") p.rot = (p.rot + 90) % 360;
  else if (a === "dup") { pages.splice(idx + 1, 0, { ...p, red: (p.red || []).slice() }); selected.clear(); }
  else if (a === "del") { pages.splice(idx, 1); selected.clear(); fullIdx = Math.min(fullIdx, pages.length - 1); }
  renderGrid();
}
function reorder(from, to) {
  if (from < 0 || from === to || from >= pages.length) return;
  const [m] = pages.splice(from, 1); pages.splice(to, 0, m);
  selected.clear(); dragFrom = -1; renderGrid();
}
function selEntries() { const s = pages.filter((_, i) => selected.has(i)); return s.length ? s : pages; }

// ---- redaction drawing -----------------------------------------------------
function enableRedactDraw(wrap, entry) {
  const img = wrap.querySelector("img");
  wrap.style.cursor = "crosshair";
  wrap.onpointerdown = (e) => {
    e.preventDefault();
    const r = img.getBoundingClientRect();
    const sx = (e.clientX - r.left) / r.width, sy = (e.clientY - r.top) / r.height;
    const box = document.createElement("div"); box.className = "pe-redactbox";
    wrap.appendChild(box);
    const mv = (ev) => {
      const x2 = (ev.clientX - r.left) / r.width, y2 = (ev.clientY - r.top) / r.height;
      const x = Math.min(sx, x2), y = Math.min(sy, y2), w = Math.abs(x2 - sx), h = Math.abs(y2 - sy);
      box.style.cssText = `position:absolute;left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%`;
      box.dataset.box = JSON.stringify({ x, y, w, h });
    };
    const up = () => {
      wrap.removeEventListener("pointermove", mv); wrap.removeEventListener("pointerup", up);
      try { const b = JSON.parse(box.dataset.box || "null"); if (b && b.w > 0.01 && b.h > 0.01) { entry.red = entry.red || []; entry.red.push(b); } } catch (_) {}
    };
    wrap.addEventListener("pointermove", mv); wrap.addEventListener("pointerup", up);
  };
}
function drawRedactBoxes(wrap, entry) {
  (entry.red || []).forEach((b) => {
    const box = document.createElement("div"); box.className = "pe-redactbox";
    box.style.cssText = `position:absolute;left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%;height:${b.h * 100}%`;
    wrap.appendChild(box);
  });
}

// ---- building / producing PDFs ---------------------------------------------
async function buildPdf(entries) {
  const L = PDFLib();
  const out = await L.PDFDocument.create();
  const libCache = new Map();
  for (const e of entries) {
    const src = sources.find((s) => s.id === e.srcId);
    let lib = libCache.get(src.id);
    if (!lib) { lib = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true }); libCache.set(src.id, lib); }
    const [cp] = await out.copyPages(lib, [e.srcIndex]);
    const base = (cp.getRotation() && cp.getRotation().angle) || 0;
    cp.setRotation(L.degrees((base + e.rot) % 360));
    out.addPage(cp);
  }
  return out;
}
// Rasterize current pages into a flat image-only PDF (used by flatten/compress/redact/unlock).
async function rasterizeToPdf(entries, scale, quality) {
  const L = PDFLib();
  const out = await L.PDFDocument.create();
  for (const e of entries) {
    const c = await rasterize(e, scale);
    if (e.red && e.red.length) {
      const x = c.getContext("2d"); x.fillStyle = "#000";
      e.red.forEach((b) => x.fillRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height));
    }
    const u8 = dataURLtoU8(c.toDataURL("image/jpeg", quality));
    const img = await out.embedJpg(u8);
    const pw = c.width / scale, ph = c.height / scale;   // keep the page's real size (points), whatever the render scale
    const pg = out.addPage([pw, ph]);
    pg.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
  return out;
}
function dataURLtoU8(u) { const b = atob(u.split(",")[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
// When a tool runs on the editor's open document, results that change it go back there.
async function save(out, name) {
  const bytes = await out.save();
  if (window.__cal2PdfSaveHook && await window.__cal2PdfSaveHook(bytes, name)) return;
  dl(name, new Blob([bytes], { type: "application/pdf" }));
}

async function stampNumbersWatermark(out, { nums, pos, wm }) {
  const L = PDFLib();
  if (!nums && !wm) return;
  const font = await out.embedFont(L.StandardFonts.HelveticaBold);
  out.getPages().forEach((pg, i) => {
    const { width, height } = pg.getSize();
    if (wm) {
      const sz = Math.min(width, height) * 0.14, tw = font.widthOfTextAtSize(wm, sz);
      const dx = Math.cos(Math.PI / 4) * tw / 2, dy = Math.sin(Math.PI / 4) * tw / 2;
      pg.drawText(wm, { x: width / 2 - dx, y: height / 2 - dy, size: sz, font, color: L.rgb(0.5, 0.5, 0.5), rotate: L.degrees(45), opacity: 0.16 });
    }
    if (nums) {
      const t = String(i + 1), sz = 11, tw = font.widthOfTextAtSize(t, sz);
      let x = width / 2 - tw / 2, y = 20;
      if (pos === "br") x = width - tw - 26; else if (pos === "bl") x = 26;
      if (pos === "tc") y = height - 26;
      pg.drawText(t, { x, y, size: sz, font, color: L.rgb(0.12, 0.12, 0.12) });
    }
  });
}

// ---- parse "1-3, 5, 8-10" into 0-based index arrays ------------------------
function parseRanges(str, max) {
  const out = [];
  String(str || "").split(",").forEach((part) => {
    part = part.trim(); if (!part) return;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let i = a; i <= b; i++) if (i >= 1 && i <= max) out.push(i - 1); }
    else { const n = +part; if (n >= 1 && n <= max) out.push(n - 1); }
  });
  return out;
}

// ---- tool registry ---------------------------------------------------------
// kind: "action" runs immediately; "panel" opens options; "server" shows a note.
const TOOLS = [
  { id: "merge", name: "Merge", icon: "⧉", color: "#7c5cff", kind: "action", run: () => pickFiles("application/pdf", true, addFiles) },
  { id: "compress", name: "Compress", icon: "🗜", color: "#e8554e", kind: "panel" },
  { id: "annotate", name: "Annotate", icon: "✎", color: "#00c2a8", kind: "action", run: () => openInSign() },
  { id: "edittext", name: "Edit Text", icon: "T", color: "#3aa0ff", kind: "action", run: () => enterEditText() },
  { id: "split", name: "Split", icon: "✂", color: "#7c5cff", kind: "panel" },
  { id: "pdfword", name: "PDF → Word", icon: "W", color: "#2b6cff", kind: "panel" },
  { id: "enhance", name: "Clean up & upscale", icon: "✦", color: "#7c5cff", kind: "panel" },
  { id: "imgpdf", name: "Pictures → PDF", icon: "🖼", color: "#f0a500", kind: "panel" },
  { id: "dupes", name: "Find duplicates", icon: "⧉", color: "#7c5cff", kind: "panel" },
  { id: "pagesort", name: "Sort by page no.", icon: "1↓", color: "#00c2a8", kind: "panel" },
  { id: "img", name: "PDF ↔ Image", icon: "🖼", color: "#f0a500", kind: "panel" },
  { id: "translate", name: "Translate", icon: "文", color: "#2b6cff", kind: "server" },
  { id: "ocr", name: "PDF OCR", icon: "OCR", color: "#e8554e", kind: "panel" },
  { id: "sign", name: "Sign", icon: "✒", color: "#c86bff", kind: "action", run: () => openInSign() },
  { id: "fillform", name: "Fill Form", icon: "▭", color: "#1f9d55", kind: "panel" },
  { id: "txt2pdf", name: "Text → PDF", icon: "≡", color: "#f0a500", kind: "action", run: () => pickFiles(".txt,.md,.csv,.log,text/plain", false, (f) => txtToPdf(f[0])) },
  { id: "convert", name: "PDF Converter", icon: "⇄", color: "#e8554e", kind: "server" },
  { id: "pdfexcel", name: "PDF ↔ Excel", icon: "X", color: "#1f9d55", kind: "server" },
  { id: "delete", name: "Delete Pages", icon: "🗑", color: "#7c5cff", kind: "action", run: () => { if (!selected.size) return note("Tick pages to delete first.", true); pages = pages.filter((_, i) => !selected.has(i)); selected.clear(); renderGrid(); note("Deleted selected pages."); } },
  { id: "unlock", name: "Unlock", icon: "🔓", color: "#e8554e", kind: "panel" },
  { id: "pdfppt", name: "PDF ↔ PowerPoint", icon: "P", color: "#e8720a", kind: "server" },
  { id: "rotate", name: "Rotate", icon: "⟳", color: "#7c5cff", kind: "action", run: () => { selEntries().forEach((e) => e.rot = (e.rot + 90) % 360); thumbCache.clear(); renderGrid(); note("Rotated " + (selected.size ? "selected" : "all") + " 90°."); } },
  { id: "crop", name: "Crop", icon: "⛶", color: "#00c2a8", kind: "panel" },
  { id: "extract", name: "Extract Pages", icon: "⿻", color: "#3aa0ff", kind: "panel" },
  { id: "protect", name: "Protect", icon: "🔒", color: "#e8554e", kind: "server" },
  { id: "number", name: "Number Pages", icon: "№", color: "#00c2a8", kind: "panel" },
  { id: "redact", name: "Redact", icon: "▮", color: "#00c2a8", kind: "panel" },
  { id: "watermark", name: "Watermark", icon: "💧", color: "#00c2a8", kind: "panel" },
  { id: "flatten", name: "Flatten", icon: "▤", color: "#e8554e", kind: "action", run: async () => { await withBusy("Flattening…", async () => { const out = await rasterizeToPdf(pages, 2, 0.92); await save(out, "flattened.pdf"); }); note("Saved flattened.pdf."); } },
];

function openInSign() {
  const buf = sources.length ? sources[0].bytes.slice() : null;
  if (window.__cal2OpenInSign) window.__cal2OpenInSign(buf, sources.length ? sources[0].name : "document.pdf");
}

function buildGrid() {
  const g = $("pe_toolgrid"); if (!g) return;
  g.innerHTML = "";
  TOOLS.forEach((t) => {
    const tile = document.createElement("button");
    tile.className = "pe-tile" + (t.kind === "server" ? " srv" : "");
    tile.innerHTML = `<span class="ic" style="background:${t.color}">${t.icon}</span><span>${t.name}</span>`;
    tile.onclick = () => openTool(t);
    g.appendChild(tile);
  });
}
function backToGrid() {
  activeTool = null; redactMode = false;
  etSrc = null; etEdits.clear(); etAddMode = false;
  $("pe_toolhead").textContent = "Tools";
  $("pe_toolgrid").style.display = "";
  $("pe_toolpanel").innerHTML = "";
  // Inside the document editor the tool panel just closes (the document stays in view).
  if (document.body.classList.contains("toolpanel")) { if (window.__cal2PdfPanelClosed) window.__cal2PdfPanelClosed(); return; }
  renderGrid();
}
function panelShell(title, html) {
  $("pe_toolhead").textContent = title;
  $("pe_toolgrid").style.display = "none";
  const p = $("pe_toolpanel");
  p.innerHTML = '<button class="pe-back">← All tools</button>' + html;
  p.querySelector(".pe-back").onclick = backToGrid;
  return p;
}
async function withBusy(msg, fn) { note(msg); try { await fn(); } catch (e) { note("Failed: " + (e.message || e), true); } }

const NO_DOC_TOOLS = new Set(["merge", "txt2pdf", "img", "unlock"]);
function openTool(t) {
  activeTool = t.id;
  if (t.kind !== "server" && !NO_DOC_TOOLS.has(t.id) && !pages.length) { note("Open a PDF first — use “Open PDF(s)”.", true); return; }
  if (t.kind === "action") { t.run(); return; }
  if (t.kind === "server") { openServerNote(t); return; }
  if (t.id === "split") openSplit();
  else if (t.id === "crop") openCrop();
  else if (t.id === "extract") openExtract();
  else if (t.id === "number") openNumber();
  else if (t.id === "watermark") openWatermark();
  else if (t.id === "compress") openCompress();
  else if (t.id === "img") openImg();
  else if (t.id === "ocr") openOcr();
  else if (t.id === "pdfword") openWord();
  else if (t.id === "enhance") openEnhance();
  else if (t.id === "imgpdf") openPicPdf();
  else if (t.id === "dupes") openDupes();
  else if (t.id === "pagesort") openPageSort();
  else if (t.id === "unlock") openUnlock();
  else if (t.id === "redact") openRedact();
  else if (t.id === "fillform") openFillForm();
}

function openServerNote(t) {
  panelShell(t.name, `<div style="font-size:12.5px;color:var(--muted);line-height:1.5">
    <b style="color:var(--text)">${t.name}</b> needs a server to run — this is a static site, so it can't convert or OCR with office/translation engines in the browser.<br><br>
    Stirling-PDF does this on a backend (LibreOffice / translation service). To enable it here, host a Stirling-PDF (or similar) instance and this tool can call its API.
  </div>`);
}

function openSplit() {
  panelShell("Split", `
    <div class="row"><label>Ranges</label><input id="pe_split_r" type="text" placeholder="1-3, 4, 5-8" style="flex:1"></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_split_each"> One file per page</label>
    <button class="btn" id="pe_split_go">Split &amp; download (.zip)</button>`);
  $("pe_split_go").onclick = () => withBusy("Splitting…", async () => {
    const zip = new (await ensureJsZip())();
    const each = $("pe_split_each").checked;
    let parts = [];
    if (each) parts = pages.map((p, i) => [i]);
    else {
      const idxs = parseRanges($("pe_split_r").value, pages.length);
      if (!idxs.length) return note("Enter ranges like 1-3, 5.", true);
      // each comma-group becomes one file
      parts = String($("pe_split_r").value).split(",").map((g) => parseRanges(g, pages.length)).filter((a) => a.length);
    }
    let n = 1;
    for (const grp of parts) { const out = await buildPdf(grp.map((i) => pages[i])); zip.file(`part-${n++}.pdf`, await out.save()); }
    dl("split.zip", await zip.generateAsync({ type: "blob" }));
    note("Saved split.zip (" + parts.length + " files).");
  });
}
function openExtract() {
  panelShell("Extract Pages", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Tick pages in the grid, or type ranges.</div>
    <div class="row"><label>Ranges</label><input id="pe_ext_r" type="text" placeholder="(selected)" style="flex:1"></div>
    <button class="btn" id="pe_ext_go">Extract → PDF</button>`);
  $("pe_ext_go").onclick = () => withBusy("Extracting…", async () => {
    let entries;
    const r = $("pe_ext_r").value.trim();
    if (r) entries = parseRanges(r, pages.length).map((i) => pages[i]);
    else entries = pages.filter((_, i) => selected.has(i));
    if (!entries.length) return note("Select pages or enter ranges.", true);
    await save(await buildPdf(entries), "extracted.pdf"); note("Extracted " + entries.length + " page(s).");
  });
}
function openCrop() {
  panelShell("Crop", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Trim a margin off every page (percent of the page).</div>
    <div class="row"><label>Top</label><input id="pe_ct" type="range" min="0" max="45" value="0"><span class="val" id="pe_ct_v">0%</span></div>
    <div class="row"><label>Right</label><input id="pe_cr" type="range" min="0" max="45" value="0"><span class="val" id="pe_cr_v">0%</span></div>
    <div class="row"><label>Bottom</label><input id="pe_cb" type="range" min="0" max="45" value="0"><span class="val" id="pe_cb_v">0%</span></div>
    <div class="row"><label>Left</label><input id="pe_cl" type="range" min="0" max="45" value="0"><span class="val" id="pe_cl_v">0%</span></div>
    <button class="btn" id="pe_crop_go">Crop → PDF</button>`);
  ["pe_ct", "pe_cr", "pe_cb", "pe_cl"].forEach((id) => $(id).oninput = () => $(id + "_v").textContent = $(id).value + "%");
  $("pe_crop_go").onclick = () => withBusy("Cropping…", async () => {
    const L = PDFLib();
    const out = await buildPdf(pages);
    const t = +$("pe_ct").value / 100, r = +$("pe_cr").value / 100, b = +$("pe_cb").value / 100, l = +$("pe_cl").value / 100;
    out.getPages().forEach((pg) => {
      const { width, height } = pg.getSize();
      const x0 = width * l, y0 = height * b, w = width * (1 - l - r), h = height * (1 - t - b);
      if (w > 1 && h > 1) { pg.setCropBox(x0, y0, w, h); pg.setMediaBox(x0, y0, w, h); }
    });
    await save(out, "cropped.pdf"); note("Saved cropped.pdf.");
  });
}
function openNumber() {
  panelShell("Number Pages", `
    <div class="row"><label>Position</label><select id="pe_np"><option value="bc">Bottom center</option><option value="br">Bottom right</option><option value="bl">Bottom left</option><option value="tc">Top center</option></select></div>
    <button class="btn" id="pe_num_go">Add numbers → PDF</button>`);
  $("pe_num_go").onclick = () => withBusy("Numbering…", async () => {
    const out = await buildPdf(pages); await stampNumbersWatermark(out, { nums: true, pos: $("pe_np").value, wm: "" });
    await save(out, "numbered.pdf"); note("Saved numbered.pdf.");
  });
}
function openWatermark() {
  panelShell("Watermark", `
    <div class="row"><label>Text</label><input id="pe_wm2" type="text" placeholder="DRAFT" style="flex:1"></div>
    <button class="btn" id="pe_wm_go">Add watermark → PDF</button>`);
  $("pe_wm_go").onclick = () => withBusy("Stamping…", async () => {
    const wm = $("pe_wm2").value.trim(); if (!wm) return note("Type the watermark text.", true);
    const out = await buildPdf(pages); await stampNumbersWatermark(out, { nums: false, wm });
    await save(out, "watermarked.pdf"); note("Saved watermarked.pdf.");
  });
}
function openCompress() {
  panelShell("Compress", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Rasterizes pages at a lower quality to shrink the file (text becomes image).</div>
    <div class="row"><label>Quality</label><input id="pe_q" type="range" min="30" max="90" value="55"><span class="val" id="pe_q_v">55%</span></div>
    <button class="btn" id="pe_cmp_go">Compress → PDF</button>`);
  $("pe_q").oninput = () => $("pe_q_v").textContent = $("pe_q").value + "%";
  $("pe_cmp_go").onclick = () => withBusy("Compressing…", async () => {
    const q = +$("pe_q").value / 100;
    const scale = 1 + q; // lower quality -> smaller render
    // two ways to shrink: re-save as is (compact structure) or pages as JPEG pictures; the smallest wins
    const before = sources.reduce((n, q2) => n + q2.bytes.length, 0);
    const lossless = await buildPdf(pages), lb = await lossless.save({ useObjectStreams: true });
    const lossy = await rasterizeToPdf(pages, scale, q), yb = await lossy.save();
    const best = Math.min(lb.length, yb.length);
    if (best >= before && sources.length === 1) { note(`This PDF is already as small as it gets (${Math.round(before / 1024)} KB) — nothing saved.`); return; }
    await save(yb.length < lb.length ? lossy : lossless, "compressed.pdf");
    note(`Saved compressed.pdf — ${Math.round(before / 1024)} KB → ${Math.round(best / 1024)} KB` + (yb.length < lb.length ? " (pages turned into pictures; text is no longer selectable)." : " (text kept)."));
  });
}
function openImg() {
  panelShell("PDF ↔ Image", `
    <div style="font-weight:600;font-size:12.5px;margin-bottom:4px">PDF → images</div>
    <div class="row"><label>Format</label><select id="pe_ifmt"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></div>
    <div class="row"><label>Resolution</label><select id="pe_idpi"><option value="72">72 DPI (screen)</option><option value="150" selected>150 DPI</option><option value="200">200 DPI</option><option value="300">300 DPI (print)</option><option value="600">600 DPI</option></select></div>
    <div style="font-size:11.5px;color:var(--muted);margin-bottom:6px">Tick pages in the grid to save only those. One page saves as a single picture; several as a .zip.</div>
    <button class="btn" id="pe_img_go">Save pages as pictures</button>
    <div style="font-weight:600;font-size:12.5px;margin:14px 0 4px">Images → PDF</div>
    <div class="row"><label>Page size</label><select id="pe_ipsize"><option value="fit">Same as each picture</option><option value="letter">Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></div>
    <div class="row"><label>Margin</label><select id="pe_ipmar"><option value="0">None</option><option value="18">Small</option><option value="36" selected>Normal</option><option value="72">Wide</option></select></div>
    <button class="btn" id="pe_img2pdf">Pick images → PDF</button>`);
  $("pe_img_go").onclick = () => withBusy("Rendering…", async () => {
    if (!pages.length) return note("Open a PDF first.", true);
    const fmt = $("pe_ifmt").value, sc = +$("pe_idpi").value / 72, ext = fmt === "png" ? "png" : "jpg", mime = fmt === "png" ? "image/png" : "image/jpeg";
    const idx = selected.size ? [...selected].sort((a, b) => a - b) : pages.map((_, i) => i);
    const base = ((sources[0] && sources[0].name) || "page").replace(/\.pdf$/i, "");
    if (idx.length === 1) { const c = await rasterize(pages[idx[0]], sc); dl(`${base}-page-${idx[0] + 1}.${ext}`, await new Promise((r) => c.toBlob(r, mime, 0.9))); note("Saved 1 picture."); return; }
    const zip = new (await ensureJsZip())();
    for (const i of idx) {
      note(`Rendering page ${i + 1}…`);
      const c = await rasterize(pages[i], sc);
      zip.file(`${base}-page-${i + 1}.${ext}`, await new Promise((r) => c.toBlob(r, mime, 0.9)));
    }
    dl(base + "-pages.zip", await zip.generateAsync({ type: "blob" })); note("Saved " + idx.length + " pictures (.zip).");
  });
  $("pe_img2pdf").onclick = () => pickFiles("image/*", true, (f) => imagesToPdf(f, { size: $("pe_ipsize").value, margin: +$("pe_ipmar").value }));
}
// Pictures → one PDF (also used when pictures are chosen on the "JPG to PDF" page).
const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89], legal: [612, 1008] };
function imagesToPdf(files, opts = {}) {
  return withBusy("Building…", async () => {
    const L = PDFLib(); const out = await L.PDFDocument.create();
    for (const f of files) {
      const u8 = new Uint8Array(await f.arrayBuffer());
      const isPng = /\.png$/i.test(f.name) || f.type === "image/png", isJpg = /\.jpe?g$/i.test(f.name) || f.type === "image/jpeg";
      let img;
      if (isPng) img = await out.embedPng(u8);
      else if (isJpg) img = await out.embedJpg(u8);
      else { // GIF / WebP / BMP → PNG through a canvas
        const url = URL.createObjectURL(f);
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
        const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
        c.getContext("2d").drawImage(im, 0, 0); URL.revokeObjectURL(url);
        img = await out.embedPng(dataURLtoU8(c.toDataURL("image/png")));
      }
      if (!opts.size || opts.size === "fit") { const pg = out.addPage([img.width, img.height]); pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height }); continue; }
      // a fixed paper size: turned to match the picture, picture centred inside the margins
      let [pw, ph] = PAGE_SIZES[opts.size] || PAGE_SIZES.letter; if (img.width > img.height) [pw, ph] = [ph, pw];
      const m = opts.margin || 0, k = Math.min((pw - 2 * m) / img.width, (ph - 2 * m) / img.height), w = img.width * k, h = img.height * k;
      out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    await save(out, "images.pdf"); note("Saved images.pdf (" + files.length + " pages).");
  });
}
function openOcr() {
  panelShell("PDF OCR", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Adds a searchable text layer under each page (runs in your browser — the first run downloads the language model, ~5–15&nbsp;MB, and large PDFs take a while).</div>
    <div class="row"><label>Language</label><select id="pe_oclang"><option value="eng">English</option><option value="spa">Spanish</option><option value="fra">French</option><option value="deu">German</option><option value="ita">Italian</option><option value="por">Portuguese</option></select></div>
    <button class="btn" id="pe_ocr_go">OCR → searchable PDF</button>
    <div id="pe_ocr_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`);
  $("pe_ocr_go").onclick = () => withBusy("Starting OCR…", async () => {
    const lang = $("pe_oclang").value, prog = $("pe_ocr_prog"), t0 = performance.now();
    const L = PDFLib(); const out = await L.PDFDocument.create();
    const font = await out.embedFont(L.StandardFonts.Helvetica);
    // pages that already carry real text are kept as they are; only scans are read
    const need = [];
    for (let i = 0; i < pages.length; i++) {
      const e = pages[i], src = sources.find((q) => q.id === e.srcId);
      let has = false;
      try { const pg = await (await jsDoc(src)).getPage(e.srcIndex + 1); const tc = await pg.getTextContent(); has = tc.items.some((it) => (it.str || "").trim().length > 1) && !e.rot; } catch (_) {}
      need.push(!has);
    }
    const todo = need.filter(Boolean).length;
    let sched = null;
    if (todo) {
      prog.textContent = "Loading the text reader…";
      sched = await ocrScheduler(lang, Math.min(todo, ocrPoolSize()));
    }
    // rasterize + read the scans in parallel (results kept in page order)
    let done = 0;
    const reads = pages.map((e, i) => need[i] ? (async () => {
      const c = await rasterize(e, 2);
      const r = await sched.addJob("recognize", c);
      done++; prog.textContent = `Reading page ${done} of ${todo}…`;
      return { c, words: (r.data && r.data.words) || [] };
    })() : null);
    for (let i = 0; i < pages.length; i++) {
      if (!need[i]) {
        const e = pages[i], src = sources.find((q) => q.id === e.srcId);
        const lib = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true });
        const [cp] = await out.copyPages(lib, [e.srcIndex]); out.addPage(cp); continue;
      }
      const { c, words } = await reads[i];
      const img = await out.embedJpg(dataURLtoU8(c.toDataURL("image/jpeg", 0.85)));
      const pg = out.addPage([c.width / 2, c.height / 2]);
      pg.drawImage(img, { x: 0, y: 0, width: c.width / 2, height: c.height / 2 });
      words.forEach((w) => {
        if (!w.text.trim()) return;
        const bb = w.bbox, h = (bb.y1 - bb.y0) / 2;
        try {
          const size = Math.max(3, h * 0.85), tw = font.widthOfTextAtSize(w.text, size), want = (bb.x1 - bb.x0) / 2;
          pg.drawText(w.text, { x: bb.x0 / 2, y: (c.height - bb.y1) / 2 + h * 0.15, size: tw > 0 ? Math.max(3, size * Math.min(2, want / tw)) : size, font, opacity: 0 });
        } catch (_) {}
      });
    }
    await save(out, "ocr.pdf"); prog.textContent = "";
    const secs = Math.round((performance.now() - t0) / 100) / 10;
    note(`Saved ocr.pdf (searchable) — ${todo} scanned page${todo === 1 ? "" : "s"} read${pages.length - todo ? ", " + (pages.length - todo) + " already had text" : ""}, ${secs}s.`);
  });
}
// A pool of OCR workers using the small, fast models; kept warm for the next run.
let ocrPool = null;
function ocrPoolSize() { return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)); }
async function ocrScheduler(lang, n) {
  const T = await ensureTesseract();
  if (ocrPool && ocrPool.lang !== lang) { try { await ocrPool.sched.terminate(); } catch (_) {} ocrPool = null; }
  if (!ocrPool) ocrPool = { lang, sched: T.createScheduler(), n: 0 };
  while (ocrPool.n < n) {
    const w = await T.createWorker(lang, 1, { langPath: "https://tessdata.projectnaptha.com/4.0.0_fast", cacheMethod: "write" });
    ocrPool.sched.addWorker(w); ocrPool.n++;
  }
  return ocrPool.sched;
}
function openUnlock() {
  panelShell("Unlock", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Open a password-protected PDF and save a copy with the password removed. You must know the password.</div>
    <div class="row"><label>Password</label><input id="pe_pw" type="password" style="flex:1"></div>
    <button class="btn" id="pe_unlock_pick">Pick locked PDF &amp; unlock</button>`);
  $("pe_unlock_pick").onclick = () => pickFiles("application/pdf", false, (files) => withBusy("Unlocking…", async () => {
    const pw = $("pe_pw").value;
    const buf = new Uint8Array(await files[0].arrayBuffer());
    let d;
    try { d = await pdfjs().getDocument({ data: buf.slice(), password: pw }).promise; }
    catch (e) { return note("Wrong password or unreadable PDF.", true); }
    const L = PDFLib(); const out = await L.PDFDocument.create();
    for (let i = 1; i <= d.numPages; i++) {
      const page = await d.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      const img = await out.embedJpg(dataURLtoU8(c.toDataURL("image/jpeg", 0.92)));
      const pg = out.addPage([c.width, c.height]); pg.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
    }
    await save(out, "unlocked.pdf"); note("Saved unlocked.pdf.");
  }));
}
function openRedact() {
  redactMode = true; renderGrid();
  panelShell("Redact", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Drag on any page to draw a black box. On apply, pages are flattened so the covered content is truly gone.</div>
    <button class="btn" id="pe_red_clear">Clear boxes</button>
    <button class="btn" id="pe_red_go" style="margin-top:8px">Apply redactions → PDF</button>`);
  $("pe_red_clear").onclick = () => { pages.forEach((p) => p.red = []); renderGrid(); };
  $("pe_red_go").onclick = () => withBusy("Redacting…", async () => {
    const any = pages.some((p) => p.red && p.red.length);
    if (!any) return note("Draw at least one box first.", true);
    const out = await rasterizeToPdf(pages, 2, 0.92);
    await save(out, "redacted.pdf"); note("Saved redacted.pdf.");
  });
}

// ---- PDF Form Filler (AcroForm fields) -------------------------------------
function openFillForm() {
  const p = panelShell("Fill Form", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Fill the PDF's interactive form fields, then save. If it has none, use <b>Sign</b> to place text/checkmarks anywhere.</div>
    <div id="pe_ff_fields" style="display:flex;flex-direction:column;gap:9px"></div>`);
  withBusy("Reading form…", async () => {
    const L = PDFLib();
    const src = sources[0];
    if (!src) return note("Open a PDF first.", true);
    const doc = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const fields = form.getFields();
    const host = $("pe_ff_fields");
    if (!fields.length) { host.innerHTML = '<div style="font-size:12.5px;color:var(--muted)">No interactive form fields in this PDF.</div>'; return; }
    // The minified pdf-lib mangles class names, so classify by instanceof (with a duck-typed fallback).
    const kind = (f) => {
      if ((L.PDFCheckBox && f instanceof L.PDFCheckBox) || (!f.getOptions && typeof f.isChecked === "function")) return "check";
      if ((L.PDFDropdown && f instanceof L.PDFDropdown) || (L.PDFOptionList && f instanceof L.PDFOptionList) ||
          (L.PDFRadioGroup && f instanceof L.PDFRadioGroup) || typeof f.getOptions === "function") return "choice";
      return "text";
    };
    fields.forEach((f, i) => {
      const name = f.getName() || ("Field " + (i + 1)), k = kind(f), fid = "pe_ff_" + i;
      const row = document.createElement("div");
      if (k === "check") {
        row.innerHTML = `<label style="display:flex;gap:8px;align-items:center;font-size:12.5px"><input type="checkbox" id="${fid}" ${f.isChecked() ? "checked" : ""}> ${name}</label>`;
      } else if (k === "choice") {
        const opts = (f.getOptions ? f.getOptions() : []) || [];
        const sel = (f.getSelected ? (f.getSelected()[0] || "") : "");
        row.innerHTML = `<label style="font-size:11.5px;color:var(--muted)">${name}</label>
          <select id="${fid}" style="width:100%"><option value=""></option>${opts.map((o) => `<option ${o === sel ? "selected" : ""}>${o}</option>`).join("")}</select>`;
      } else {
        const cur = (f.getText && f.getText()) || "";
        row.innerHTML = `<label style="font-size:11.5px;color:var(--muted)">${name}</label>
          <input type="text" id="${fid}" value="${String(cur).replace(/"/g, "&quot;")}" style="width:100%">`;
      }
      row.dataset.k = k; row.dataset.name = name;
      host.appendChild(row);
    });
    const flat = document.createElement("label");
    flat.style.cssText = "display:flex;gap:8px;align-items:center;font-size:12.5px;margin-top:4px";
    flat.innerHTML = '<input type="checkbox" id="pe_ff_flat"> Flatten (lock fields so they can\'t be edited)';
    host.appendChild(flat);
    const go = document.createElement("button");
    go.className = "btn"; go.textContent = "Fill → PDF"; go.style.marginTop = "6px";
    host.appendChild(go);
    go.onclick = () => withBusy("Filling…", async () => {
      fields.forEach((f, i) => {
        const el = $("pe_ff_" + i); if (!el) return;
        const k = kind(f);
        try {
          if (k === "check") { el.checked ? f.check() : f.uncheck(); }
          else if (k === "choice") { if (el.value) f.select(el.value); }
          else if (f.setText) { f.setText(el.value || ""); }
        } catch (_) {}
      });
      if ($("pe_ff_flat").checked) { try { form.flatten(); } catch (_) {} }
      await save(doc, "filled.pdf"); note("Saved filled.pdf.");
    });
  });
}

// ---- Text / Markdown / CSV → PDF -------------------------------------------
async function txtToPdf(file) {
  await withBusy("Building PDF…", async () => {
    const text = await file.text();
    const L = PDFLib();
    const out = await L.PDFDocument.create();
    const isCsv = /\.csv$/i.test(file.name);
    const font = await out.embedFont(isCsv ? L.StandardFonts.Courier : L.StandardFonts.Helvetica);
    const size = 11, lh = size * 1.45, margin = 54, pw = 612, ph = 792, maxW = pw - margin * 2;
    let pg = out.addPage([pw, ph]), y = ph - margin;
    const newPage = () => { pg = out.addPage([pw, ph]); y = ph - margin; };
    const drawLine = (s) => {
      if (y < margin) newPage();
      try { pg.drawText(s, { x: margin, y, size, font, color: L.rgb(0.1, 0.1, 0.12) }); } catch (_) {}
      y -= lh;
    };
    const wrap = (line) => {
      if (line === "") { y -= lh; return; }
      const words = line.split(/(\s+)/); let cur = "";
      for (const w of words) {
        const test = cur + w;
        if (font.widthOfTextAtSize(test.replace(/\t/g, "    "), size) > maxW && cur) { drawLine(cur.replace(/\t/g, "    ")); cur = w.trimStart(); }
        else cur = test;
      }
      if (cur.trim() !== "" || cur === "") drawLine(cur.replace(/\t/g, "    "));
    };
    text.replace(/\r\n/g, "\n").split("\n").forEach(wrap);
    await save(out, file.name.replace(/\.[^.]+$/, "") + ".pdf");
    note("Saved " + file.name.replace(/\.[^.]+$/, "") + ".pdf.");
  });
}

// ---- Edit Text: select & edit real PDF text (pdf.js text layer -> pdf-lib) --
function mapFontKey(fam) {
  const f = (fam || "").toLowerCase();
  if (f.includes("mono") || f.includes("courier")) return "Courier";
  if (f.includes("serif") && !f.includes("sans")) return "TimesRoman";
  return "Helvetica";
}
// Pick the lightest ("bg") or darkest ("fg") pixel in a box of the rendered page.
function sampleRGB(ctx, x, y, w, h, pick) {
  try {
    const sx = Math.max(0, Math.floor(x)), sy = Math.max(0, Math.floor(y));
    const sw = Math.max(1, Math.min(ctx.canvas.width - sx, Math.ceil(w))), sh = Math.max(1, Math.min(ctx.canvas.height - sy, Math.ceil(h)));
    const d = ctx.getImageData(sx, sy, sw, sh).data;
    let best = null, bestL = pick === "bg" ? -1 : 256;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (pick === "bg" ? lum > bestL : lum < bestL) { bestL = lum; best = [d[i], d[i + 1], d[i + 2]]; }
    }
    return best || (pick === "bg" ? [255, 255, 255] : [0, 0, 0]);
  } catch (_) { return pick === "bg" ? [255, 255, 255] : [0, 0, 0]; }
}
async function enterEditText() {
  if (!sources.length) return note("Open a PDF first.", true);
  etSrc = sources[0]; etPageNum = 1; etEdits.clear(); etAddMode = false;
  panelShell("Edit Text", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Click any line of text to select and edit it live. Tick <b>Add text</b> and click to drop a new text box. The rest of the page stays pixel-perfect; edits re-render on export.</div>
    <div class="row"><label>Page</label><button class="btn" id="et_prev" style="width:auto;padding:6px 11px">‹</button><span id="et_pg" style="min-width:60px;text-align:center"></span><button class="btn" id="et_next" style="width:auto;padding:6px 11px">›</button></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:6px 0"><input type="checkbox" id="et_add"> Add-text mode (click page to add)</label>
    <button class="btn" id="et_save">⤓ Save edited PDF</button>`);
  $("et_prev").onclick = () => { if (etPageNum > 1) { flushEtPage(); etPageNum--; renderEtPage(); } };
  $("et_next").onclick = async () => { const d = await jsDoc(etSrc); if (etPageNum < d.numPages) { flushEtPage(); etPageNum++; renderEtPage(); } };
  $("et_add").onchange = () => { etAddMode = $("et_add").checked; const layer = $("et_layer"); if (layer) layer.style.cursor = etAddMode ? "crosshair" : "default"; };
  $("et_save").onclick = () => saveEditText();
  renderEtPage();
}
async function renderEtPage() {
  const stage = $("pdfedit_stage"); if (!stage || !etSrc) return;
  const d = await jsDoc(etSrc);
  etPageNum = Math.max(1, Math.min(d.numPages, etPageNum));
  if ($("et_pg")) $("et_pg").textContent = etPageNum + " / " + d.numPages;
  const page = await d.getPage(etPageNum);
  const maxW = Math.max(360, stage.clientWidth - 48);
  const base = page.getViewport({ scale: 1 });
  etScale = Math.min(2.2, maxW / base.width);
  const vp = page.getViewport({ scale: etScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height); etCanvasH = canvas.height;
  const ctx = canvas.getContext("2d"); etBgCtx = ctx;
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  stage.innerHTML = "";
  const wrap = document.createElement("div"); wrap.id = "et_wrap";
  wrap.style.width = canvas.width + "px"; wrap.style.height = canvas.height + "px";
  wrap.appendChild(canvas);
  const layer = document.createElement("div"); layer.id = "et_layer";
  layer.style.width = canvas.width + "px"; layer.style.height = canvas.height + "px";
  layer.style.cursor = etAddMode ? "crosshair" : "default";
  wrap.appendChild(layer); stage.appendChild(wrap);
  const tc = await page.getTextContent();
  const U = pdfjs().Util;
  const existing = etEdits.get(etPageNum - 1);
  const chByIdx = new Map((existing && existing.changes || []).map((c) => [c.idx, c]));
  tc.items.forEach((it, i) => {
    if (!it.str) return;
    const tx = U.transform(vp.transform, it.transform);
    const size = Math.hypot(tx[2], tx[3]); if (size < 2) return;
    const span = document.createElement("div"); span.className = "et-span"; span.contentEditable = "true";
    span.style.left = tx[4] + "px"; span.style.top = (tx[5] - size) + "px"; span.style.fontSize = size + "px";
    const fam = (tc.styles[it.fontName] && tc.styles[it.fontName].fontFamily) || "sans-serif";
    span.style.fontFamily = fam; span.textContent = it.str;
    const pit = it.transform; // text-space -> PDF points (bottom-left origin)
    span._et = { idx: i, px: pit[4], py: pit[5], psize: Math.hypot(pit[2], pit[3]) || size / etScale, pw: it.width || 0, fontKey: mapFontKey(fam), orig: it.str };
    wireEtSpan(span); layer.appendChild(span);
    const ch = chByIdx.get(i);
    if (ch) { span.textContent = ch.text; span._et.changed = true; span._et.bg = ch.bg; span._et.fg = ch.fg; span._et.sampled = true; span.style.color = `rgb(${ch.fg.join(",")})`; span.style.background = `rgb(${ch.bg.join(",")})`; }
  });
  (existing && existing.adds || []).forEach((a) => addEtTextBox(a.pdfX * etScale, etCanvasH - a.pdfYbaseline * etScale - a.pdfSize * etScale, a.text, a.pdfSize * etScale, false));
  layer.onclick = (e) => { if (etAddMode && e.target === layer) { const r = layer.getBoundingClientRect(); addEtTextBox(e.clientX - r.left, e.clientY - r.top, "", 16 * etScale, true); } };
}
function wireEtSpan(span) {
  span.addEventListener("focus", () => {
    span.classList.add("editing");
    const g = span._et; if (!g) return;
    if (!g.sampled) {
      const left = parseFloat(span.style.left), top = parseFloat(span.style.top), size = parseFloat(span.style.fontSize);
      const w = Math.max(6, g.pw * etScale);
      g.bg = sampleRGB(etBgCtx, left, top, w, size, "bg");
      g.fg = sampleRGB(etBgCtx, left, top, w, size, "fg");
      g.sampled = true;
    }
    span.style.color = `rgb(${g.fg.join(",")})`;
    span.style.background = `rgb(${g.bg.join(",")})`;
  });
  span.addEventListener("input", () => { if (span._et) span._et.changed = true; });
  span.addEventListener("blur", () => {
    span.classList.remove("editing");
    const g = span._et; if (!g) return;
    if (g.changed || span.textContent !== g.orig) { g.changed = true; }
    else { span.style.color = "transparent"; span.style.background = "transparent"; }
  });
}
function addEtTextBox(leftPx, topPx, text, sizePx, focus) {
  const layer = $("et_layer"); if (!layer) return;
  const span = document.createElement("div"); span.className = "et-span et-add"; span.contentEditable = "true";
  span.style.left = leftPx + "px"; span.style.top = topPx + "px"; span.style.fontSize = (sizePx || 16) + "px";
  span.style.fontFamily = "Helvetica, Arial, sans-serif"; span.style.color = "#111"; span.textContent = text || "";
  span._et = { isAdd: true, fontKey: "Helvetica", fg: [17, 17, 17] };
  span.addEventListener("input", () => { span._et.text = span.textContent; });
  span.addEventListener("blur", () => { span._et.text = span.textContent; if (!span.textContent.trim()) span.remove(); });
  layer.appendChild(span);
  if (focus) setTimeout(() => span.focus(), 0);
  return span;
}
function flushEtPage() {
  const layer = $("et_layer"); if (!layer) return;
  const changes = [], adds = [];
  layer.querySelectorAll(".et-span").forEach((span) => {
    const g = span._et; if (!g) return;
    const left = parseFloat(span.style.left), top = parseFloat(span.style.top), sizePx = parseFloat(span.style.fontSize);
    if (g.isAdd) {
      if (span.textContent.trim()) adds.push({ pdfX: left / etScale, pdfYbaseline: (etCanvasH - (top + sizePx)) / etScale, pdfSize: sizePx / etScale, text: span.textContent, fontKey: g.fontKey, fg: g.fg });
    } else if (g.changed || span.textContent !== g.orig) {
      changes.push({ idx: g.idx, px: g.px, py: g.py, psize: g.psize, pw: g.pw, fontKey: g.fontKey, bg: g.bg || [255, 255, 255], fg: g.fg || [0, 0, 0], text: span.textContent });
    }
  });
  etEdits.set(etPageNum - 1, { changes, adds });
}
async function saveEditText() {
  if (!etSrc) return;
  flushEtPage();
  await withBusy("Rendering edited PDF…", async () => {
    const L = PDFLib();
    const pdf = await L.PDFDocument.load(etSrc.bytes, { ignoreEncryption: true });
    const fontCache = new Map();
    const getFont = async (key) => { if (!fontCache.has(key)) fontCache.set(key, await pdf.embedFont(L.StandardFonts[key] || L.StandardFonts.Helvetica)); return fontCache.get(key); };
    const outPages = pdf.getPages();
    let edited = 0;
    for (const [pageIdx, ed] of etEdits.entries()) {
      const pg = outPages[pageIdx]; if (!pg) continue;
      for (const ch of ed.changes) {
        const coverW = (ch.pw || ch.psize * Math.max(1, (ch.orig || ch.text || "x").length) * 0.5) + 2;
        pg.drawRectangle({ x: ch.px - 1, y: ch.py - ch.psize * 0.28, width: coverW, height: ch.psize * 1.28, color: L.rgb(ch.bg[0] / 255, ch.bg[1] / 255, ch.bg[2] / 255) });
        if (ch.text.trim()) { const font = await getFont(ch.fontKey); try { pg.drawText(ch.text, { x: ch.px, y: ch.py, size: ch.psize, font, color: L.rgb(ch.fg[0] / 255, ch.fg[1] / 255, ch.fg[2] / 255) }); } catch (_) {} }
        edited++;
      }
      for (const a of ed.adds) { const font = await getFont(a.fontKey); try { pg.drawText(a.text, { x: a.pdfX, y: a.pdfYbaseline, size: a.pdfSize, font, color: L.rgb(a.fg[0] / 255, a.fg[1] / 255, a.fg[2] / 255) }); edited++; } catch (_) {} }
    }
    if (!edited) return note("No text changes yet — click a line and edit it first.", true);
    await save(pdf, "edited-text.pdf"); note(`Saved edited-text.pdf — ${edited} change${edited > 1 ? "s" : ""}.`);
  });
}

// ---- boot ------------------------------------------------------------------

// ---- PDF → Word (.docx), built in the browser ---------------------------------------------
// Text pages keep their paragraphs, headings (bigger type), bold and italic; scanned pages are
// read with OCR, or kept as a picture of the page. "Exact look" puts each page in as a picture.
function xmlEsc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ""); }
async function pageParagraphs(page) {
  const tc = await page.getTextContent(), vp = page.getViewport({ scale: 1 });
  const styles = tc.styles || {};
  const runs = tc.items.filter((it) => it.str !== undefined).map((it) => {
    const fs = Math.hypot(it.transform[2], it.transform[3]) || 10, fn = ((styles[it.fontName] || {}).fontFamily || "") + " " + it.fontName;
    return { str: it.str, x: it.transform[4], y: vp.height - it.transform[5], w: it.width, fs, eol: it.hasEOL,
      bold: /bold|black|heavy|semibold/i.test(fn), italic: /italic|oblique/i.test(fn) };
  }).filter((r) => r.str.trim().length);   // spaces are put back from the gaps
  if (!runs.length) return null;
  // lines: same baseline (within 40% of the size), left to right
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of runs) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(L.y - r.y) < Math.max(L.fs, r.fs) * 0.4) {
      const gap = r.x - (L.x1 || L.x);
      if (gap > r.fs * 0.15 && !/\s$/.test(L.runs[L.runs.length - 1].str) && !/^\s/.test(r.str)) r.str = (gap > r.fs * 2.5 ? "\t" : " ") + r.str;
      L.runs.push(r); L.x1 = r.x + r.w; L.fs = Math.max(L.fs, r.fs);
    } else lines.push({ y: r.y, x: r.x, x1: r.x + r.w, fs: r.fs, runs: [r] });
  }
  lines.forEach((l) => l.runs.sort((a, b) => a.x - b.x));
  // paragraphs: a line joins the one above when the gap is normal and the size matches
  const sizes = lines.map((l) => l.fs).sort((a, b) => a - b), body = sizes[Math.floor(sizes.length / 2)] || 11;
  const paras = [];
  let prev = null;
  for (const l of lines) {
    const P = paras[paras.length - 1];
    const join = P && prev && l.y - prev.y < Math.max(l.fs, prev.fs) * 1.6 && Math.abs(l.fs - prev.fs) < 1 && l.fs < body * 1.25 && Math.abs(l.x - P.x) < body * 3;
    if (join) { const last = P.runs[P.runs.length - 1]; if (!/[\s-]$/.test(last.str)) P.runs.push({ ...l.runs[0], str: " " }); P.runs.push(...l.runs); }
    else paras.push({ x: l.x, fs: l.fs, head: l.fs >= body * 1.25, gapBefore: prev ? l.y - prev.y > Math.max(l.fs, prev.fs) * 2.2 : false, runs: [...l.runs] });
    prev = l;
  }
  return { paras, body, width: vp.width };
}
function docxRun(r, sizePt) {
  const pr = `<w:rPr>${r.bold ? "<w:b/>" : ""}${r.italic ? "<w:i/>" : ""}<w:sz w:val="${Math.max(12, Math.round(sizePt * 2))}"/></w:rPr>`;
  return r.str.split("\t").map((part, i) => (i ? `<w:r>${pr}<w:tab/></w:r>` : "") + (part ? `<w:r>${pr}<w:t xml:space="preserve">${xmlEsc(part)}</w:t></w:r>` : "")).join("");
}
function docxPicture(rid, n, wEmu, hEmu) {
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${wEmu}" cy="${hEmu}"/><wp:docPr id="${n}" name="Page ${n}"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="page${n}.jpg"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}
async function pdfToDocx(entries, { mode, scans }, prog) {
  const JSZip = await ensureJsZip(), zip = new JSZip();
  const body = [], rels = [], BR = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  let img = 0, ocrSched = null, pageW = 612, pageH = 792;
  for (let i = 0; i < entries.length; i++) {
    prog(`Page ${i + 1} of ${entries.length}…`);
    const e = entries[i], src = sources.find((q) => q.id === e.srcId), page = await (await jsDoc(src)).getPage(e.srcIndex + 1);
    const vp = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + e.rot) % 360 });
    if (i === 0) { pageW = vp.width; pageH = vp.height; }
    if (i) body.push(BR);
    const usable = (pageW - 108) * 12700;   // 0.75" margins, in EMU
    const putPicture = async () => {
      const c = await rasterize(e, 2), u8 = dataURLtoU8(c.toDataURL("image/jpeg", 0.88)); img++;
      zip.file(`word/media/page${img}.jpg`, u8); rels.push(`<Relationship Id="rImg${img}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/page${img}.jpg"/>`);
      const w = usable, h = Math.round(usable * c.height / c.width), maxH = (pageH - 108) * 12700, k = Math.min(1, maxH / h);
      body.push(docxPicture("rImg" + img, img, Math.round(w * k), Math.round(h * k)));
    };
    if (mode === "picture") { await putPicture(); continue; }
    const t = e.rot ? null : await pageParagraphs(page);
    if (t) {
      for (const p of t.paras) {
        const size = p.head ? Math.min(28, p.fs) : Math.min(16, Math.max(8, p.fs));
        const ind = Math.max(0, Math.round((p.x - 54) * 20));
        body.push(`<w:p><w:pPr>${p.head ? '<w:pStyle w:val="Heading"/>' : ""}<w:spacing w:before="${p.gapBefore || p.head ? 160 : 0}" w:after="${p.head ? 80 : 100}"/>${ind > 200 ? `<w:ind w:left="${Math.min(ind, 4000)}"/>` : ""}</w:pPr>${p.runs.map((r) => docxRun(r, size)).join("")}</w:p>`);
      }
      continue;
    }
    if (scans === "ocr") {
      if (!ocrSched) ocrSched = await ocrScheduler("eng", ocrPoolSize());
      const c = await rasterize(e, 2), r = await ocrSched.addJob("recognize", c);
      const paras = (r.data.paragraphs || []).map((pp) => pp.text.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
      if (paras.length) { paras.forEach((tx) => body.push(`<w:p><w:pPr><w:spacing w:after="100"/></w:pPr>${docxRun({ str: tx }, 11)}</w:p>`)); continue; }
    }
    await putPicture();
  }
  const W = Math.round(pageW * 20), H = Math.round(pageH * 20);
  zip.file("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/_rels/document.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rSty" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + rels.join("") + "</Relationships>");
  zip.file("word/styles.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/></w:rPr></w:style></w:styles>');
  zip.file("word/document.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>' +
    body.join("") + `<w:sectPr><w:pgSz w:w="${W}" w:h="${H}"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}
function openWord() {
  panelShell("PDF → Word", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Makes an editable Word document (.docx) in your browser. Paragraphs, headings, bold and italic are kept; layouts with columns or tables come out as plain paragraphs.</div>
    <div class="row"><label>Content</label><select id="pe_wmode"><option value="text">Editable text</option><option value="picture">Exact look (each page as a picture)</option></select></div>
    <div class="row"><label>Scanned pages</label><select id="pe_wscan"><option value="ocr">Read the text (OCR)</option><option value="picture">Keep as a picture</option></select></div>
    <button class="btn" id="pe_word_go">Convert → .docx</button>
    <div id="pe_word_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`);
  $("pe_word_go").onclick = () => withBusy("Converting…", async () => {
    if (!pages.length) return note("Open a PDF first.", true);
    const prog = $("pe_word_prog"), list = selected.size ? pages.filter((_, i) => selected.has(i)) : pages;
    const blob = await pdfToDocx(list, { mode: $("pe_wmode").value, scans: $("pe_wscan").value }, (m) => prog.textContent = m);
    const name = ((sources[0] && sources[0].name) || "document").replace(/\.pdf$/i, "") + ".docx";
    dl(name, blob); prog.textContent = ""; note("Saved " + name + " (" + list.length + " page" + (list.length > 1 ? "s" : "") + ").");
  });
}

// ---- Clean up & upscale: sharper, higher-resolution PDFs from scans, photos and pictures --------
// AI mode uses ESRGAN super-resolution in the browser (UpscalerJS + TensorFlow.js on the GPU), the same
// engine and models as github.com/Mariano215/ai-image-upscaler (MIT). Several 4x passes are never needed for
// documents: one pass, then a high-quality resample to the exact target, which keeps edges crisp.
const UPS_MV = "1.0.0";
const UPS_MODELS = {
  fast: { src: `https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-slim@${UPS_MV}/dist/umd/models/esrgan-slim/src/x4/index.min.js`, g: "ESRGANSlim4x", sri: "sha384-DYTGe938MJpD698SdXwJhHm5SOraccyxoYjDnkoYLw/vlIVXYKX0Iv4bmcqTAzhW" },
  balanced: { src: `https://cdn.jsdelivr.net/npm/@upscalerjs/esrgan-medium@${UPS_MV}/dist/umd/models/esrgan-medium/src/x4/index.min.js`, g: "ESRGANMedium4x", sri: "sha384-5fJ01HD6+MUDQcTDVhBsqg1yPTfOJb6urBcnZ13EqPInN+9vUsTnoaN56Wlg1x9d" },
};
const upscalers = {};
function loadScriptSri(src, integrity) {
  if (scriptCache.has(src)) return scriptCache.get(src);
  const p = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; if (integrity) { s.integrity = integrity; s.crossOrigin = "anonymous"; } s.onload = res; s.onerror = () => rej(new Error("Could not load the upscaling model")); document.head.appendChild(s); });
  scriptCache.set(src, p); return p;
}
async function getUpscaler(q) {
  if (upscalers[q]) return upscalers[q];
  if (!window.tf) await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js");
  if (!window.Upscaler) await loadScript("https://cdn.jsdelivr.net/npm/upscaler@1.0.0-beta.19/dist/browser/umd/upscaler.min.js");
  const m = UPS_MODELS[q]; await loadScriptSri(m.src, m.sri);
  if (!window.Upscaler || !window[m.g]) throw new Error("The upscaling engine is not available in this browser");
  return (upscalers[q] = new window.Upscaler({ model: window[m.g] }));
}
function canvasOf(src, w, h) { const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); const g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0, c.width, c.height); return c; }
// clean-up: levels (paper to white, ink to black), optional greyscale, light despeckle
function cleanCanvas(c, { whiten, gray, despeckle }) {
  const g = c.getContext("2d", { willReadFrequently: true }), d = g.getImageData(0, 0, c.width, c.height), p = d.data, n = p.length / 4;
  const hist = new Uint32Array(256);
  for (let k = 0; k < p.length; k += 4) hist[(p[k] * 0.299 + p[k + 1] * 0.587 + p[k + 2] * 0.114) | 0]++;
  let lo = 0, hi = 255, acc = 0;
  for (let k = 0; k < 256; k++) { acc += hist[k]; if (acc > n * 0.005) { lo = k; break; } }
  acc = 0; for (let k = 255; k >= 0; k--) { acc += hist[k]; if (acc > n * (whiten ? 0.35 : 0.005)) { hi = k; break; } }
  if (whiten) hi = Math.max(lo + 60, hi - 12);
  const span = Math.max(1, hi - lo), lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.max(0, Math.min(255, (v - lo) * 255 / span));
  for (let k = 0; k < p.length; k += 4) {
    if (gray) { const y = lut[(p[k] * 0.299 + p[k + 1] * 0.587 + p[k + 2] * 0.114) | 0]; p[k] = p[k + 1] = p[k + 2] = y; }
    else { p[k] = lut[p[k]]; p[k + 1] = lut[p[k + 1]]; p[k + 2] = lut[p[k + 2]]; }
    if (whiten && p[k] * 0.299 + p[k + 1] * 0.587 + p[k + 2] * 0.114 > 232) p[k] = p[k + 1] = p[k + 2] = 255;   // paper tint goes too
  }
  if (despeckle) {   // isolated dark dots on white become white
    const W = c.width, H = c.height, y = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) y[i] = p[i * 4] * 0.3 + p[i * 4 + 1] * 0.59 + p[i * 4 + 2] * 0.11 < 128 ? 1 : 0;
    for (let yy = 1; yy < H - 1; yy++) for (let x = 1; x < W - 1; x++) {
      const i = yy * W + x; if (!y[i]) continue;
      if (y[i - 1] + y[i + 1] + y[i - W] + y[i + W] + y[i - W - 1] + y[i - W + 1] + y[i + W - 1] + y[i + W + 1] === 0) { p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = 255; }
    }
  }
  g.putImageData(d, 0, 0); return c;
}
// unsharp mask (amount 0..2) on a canvas, in place
function sharpenCanvas(c, amount) {
  if (amount <= 0) return c;
  const W = c.width, H = c.height, g = c.getContext("2d", { willReadFrequently: true });
  const blur = document.createElement("canvas"); blur.width = W; blur.height = H;
  const bg = blur.getContext("2d"); bg.filter = `blur(${Math.max(0.6, W / 2400)}px)`; bg.drawImage(c, 0, 0);
  const a = g.getImageData(0, 0, W, H), b = bg.getImageData(0, 0, W, H).data, p = a.data;
  for (let k = 0; k < p.length; k += 4) for (let j = 0; j < 3; j++) { const v = p[k + j] + (p[k + j] - b[k + j]) * amount; p[k + j] = v < 0 ? 0 : v > 255 ? 255 : v; }
  g.putImageData(a, 0, 0); return c;
}
// one picture → enhanced canvas at about `dpi` for a page `inW` inches wide
async function enhanceOne(src, opt, onProg) {
  const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height;
  const tw = Math.round(opt.inW * opt.dpi), th = Math.round(tw * sh / sw);
  let out;
  if (opt.engine !== "classic") {
    // feed the model at no more than a quarter of the target (and ~1.2 MP), it returns 4x
    const k = Math.min(1, tw / 4 / sw, Math.sqrt(1.2e6 / (sw * sh)));
    const inC = cleanCanvas(canvasOf(src, sw * k, sh * k), { whiten: false, gray: false, despeckle: opt.despeckle });
    const up = await getUpscaler(opt.engine);
    const url = await up.upscale(inC, { patchSize: 64, padding: 4, progress: (r) => onProg && onProg(r) });
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    out = canvasOf(im, tw, th);
  } else {
    // classic: step up in halves (sharper than one big stretch)
    let cur = cleanCanvas(canvasOf(src, sw, sh), { whiten: false, gray: false, despeckle: opt.despeckle });
    while (cur.width * 2 < tw) cur = canvasOf(cur, cur.width * 2, cur.height * 2);
    out = canvasOf(cur, tw, th);
  }
  cleanCanvas(out, { whiten: opt.whiten, gray: opt.gray, despeckle: false });
  return sharpenCanvas(out, opt.sharpen);
}
let enhImages = [];   // pictures added straight to the tool (no PDF)
async function fileToImage(f) { const url = URL.createObjectURL(f); const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Could not read " + f.name)); i.src = url; }); return { im, name: f.name, url }; }
function openEnhance() {
  panelShell("Clean up & upscale", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Turns blurry scans, phone photos and small pictures into a sharper, higher-resolution PDF. AI upscaling runs on your graphics card in this browser (the model downloads once, a few MB); nothing is uploaded.</div>
    <div id="pe_enh_src" style="font-size:12px;margin-bottom:6px"></div>
    <button class="btn" id="pe_enh_add" style="margin-bottom:8px">Add pictures…</button>
    <div class="row"><label>Engine</label><select id="pe_enh_eng"><option value="balanced">AI upscale — best for photos &amp; scans</option><option value="fast">AI upscale — faster</option><option value="classic">Classic resample (no AI, quickest)</option></select></div>
    <div class="row"><label>Resolution</label><select id="pe_enh_dpi"><option value="200">200 DPI</option><option value="300" selected>300 DPI (print)</option><option value="400">400 DPI</option></select></div>
    <div class="row"><label>Sharpen</label><input id="pe_enh_sh" type="range" min="0" max="20" value="6"><span class="val" id="pe_enh_sh_v">0.6</span></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_enh_wh" checked> Clean background (paper to white, darker ink)</label>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_enh_sp" checked> Remove specks</label>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_enh_gr"> Black &amp; white (greyscale)</label>
    <div class="row"><label>Save as</label><select id="pe_enh_out"><option value="pdf">One PDF</option><option value="png">Pictures (.png, zipped if several)</option></select></div>
    <button class="btn" id="pe_enh_go">Enhance</button>
    <div id="pe_enh_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`);
  const showSrc = () => { const n = (selected.size || pages.length); $("pe_enh_src").textContent = (pages.length ? `${n} PDF page${n === 1 ? "" : "s"}` : "") + (pages.length && enhImages.length ? " + " : "") + (enhImages.length ? `${enhImages.length} picture${enhImages.length === 1 ? "" : "s"}` : "") || "Add pictures, or open a PDF first."; };
  showSrc();
  $("pe_enh_sh").oninput = () => $("pe_enh_sh_v").textContent = (+$("pe_enh_sh").value / 10).toFixed(1);
  $("pe_enh_add").onclick = () => pickFiles("image/*", true, async (files) => { await addFiles(files); showSrc(); });
  $("pe_enh_go").onclick = () => withBusy("Enhancing…", async () => {
    const list = selected.size ? pages.filter((_, i) => selected.has(i)) : pages;
    if (!list.length && !enhImages.length) return note("Add pictures or open a PDF first.", true);
    const prog = $("pe_enh_prog"), t0 = performance.now(), total = list.length + enhImages.length;
    const opt = { engine: $("pe_enh_eng").value, dpi: +$("pe_enh_dpi").value, sharpen: +$("pe_enh_sh").value / 10, whiten: $("pe_enh_wh").checked, despeckle: $("pe_enh_sp").checked, gray: $("pe_enh_gr").checked };
    if (opt.engine !== "classic") { prog.textContent = "Loading the AI model…"; await getUpscaler(opt.engine); }
    const outs = [];
    let n = 0;
    const step = (lbl) => (r) => prog.textContent = `${lbl} ${n + 1} of ${total}… ${Math.round((r || 0) * 100)}%`;
    for (const e of list) {
      const src = sources.find((q) => q.id === e.srcId), page = await (await jsDoc(src)).getPage(e.srcIndex + 1);
      const vp = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + e.rot) % 360 });
      step("Page")(0);
      const c = await rasterize(e, Math.min(3, 1600 / vp.width));   // read the page at ~1600 px wide
      outs.push({ c: await enhanceOne(c, { ...opt, inW: vp.width / 72 }, step("Page")), wPt: vp.width, hPt: vp.height, name: `page-${n + 1}` }); n++;
    }
    for (const it of enhImages) {
      step("Picture")(0);
      const sw = it.im.naturalWidth, sh = it.im.naturalHeight, inW = sw >= sh ? 11 : 8.5;   // a full page wide
      const c = await enhanceOne(it.im, { ...opt, inW: Math.min(inW, Math.max(2, sw * 4 / opt.dpi)) }, step("Picture"));
      outs.push({ c, wPt: c.width * 72 / opt.dpi, hPt: c.height * 72 / opt.dpi, name: it.name.replace(/\.[^.]+$/, "") + "-enhanced" }); n++;
    }
    prog.textContent = "Saving…";
    if ($("pe_enh_out").value === "png") {
      if (outs.length === 1) dl(outs[0].name + ".png", await new Promise((r) => outs[0].c.toBlob(r, "image/png")));
      else { const zip = new (await ensureJsZip())(); for (const o of outs) zip.file(o.name + ".png", await new Promise((r) => o.c.toBlob(r, "image/png"))); dl("enhanced.zip", await zip.generateAsync({ type: "blob" })); }
    } else {
      const L = PDFLib(), out = await L.PDFDocument.create();
      for (const o of outs) {
        const img = opt.gray ? await out.embedPng(dataURLtoU8(o.c.toDataURL("image/png"))) : await out.embedJpg(dataURLtoU8(o.c.toDataURL("image/jpeg", 0.92)));
        const pg = out.addPage([o.wPt, o.hPt]); pg.drawImage(img, { x: 0, y: 0, width: o.wPt, height: o.hPt });
      }
      await save(out, "enhanced.pdf");
    }
    prog.textContent = "";
    note(`Enhanced ${outs.length} page${outs.length === 1 ? "" : "s"} at ${opt.dpi} DPI in ${Math.round((performance.now() - t0) / 1000)}s.`);
  });
}


// ---- pictures as pages ----------------------------------------------------------------------
// A dropped or picked picture becomes a one-page PDF (turned the right way up from the camera's
// orientation tag), so it can be reordered, rotated, de-duplicated, sorted and converted like any page.
const isImgFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|heic|avif)$/i.test(f.name);
async function imageFileToPdf(f) {
  let bmp;
  try { bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); }
  catch (_) { const url = URL.createObjectURL(f); bmp = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("This picture could not be read")); i.src = url; }); }
  const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight, k = Math.min(1, 6000 / Math.max(sw, sh));
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
  const g = c.getContext("2d"), png = /png|gif|webp/i.test(f.type) || /\.(png|gif|webp)$/i.test(f.name);
  if (!png) { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const L = PDFLib(), out = await L.PDFDocument.create();
  const img = png ? await out.embedPng(dataURLtoU8(c.toDataURL("image/png"))) : await out.embedJpg(dataURLtoU8(c.toDataURL("image/jpeg", 0.93)));
  const w = c.width * 0.75, h = c.height * 0.75;            // 96 pixels per inch
  out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  return { bytes: await out.save(), px: [c.width, c.height] };
}

// ---- grid / full page view --------------------------------------------------------------
let viewMode = (() => { try { return localStorage.getItem("cal2_pe_view") || "grid"; } catch (_) { return "grid"; } })();
let fullIdx = 0, dupMarks = new Map();
function setView(m, idx) { viewMode = m; if (idx != null) fullIdx = idx; try { localStorage.setItem("cal2_pe_view", m); } catch (_) {} renderGrid(); }
function viewBar() {
  const bar = document.createElement("div"); bar.className = "pe-viewbar";
  const n = pages.length; fullIdx = Math.max(0, Math.min(fullIdx, n - 1));
  bar.innerHTML = `<div class="pe-seg"><button data-v="grid" class="${viewMode === "grid" ? "on" : ""}" title="All pages as thumbnails">▦ Pages</button><button data-v="full" class="${viewMode === "full" ? "on" : ""}" title="One page at a time, large">▭ Full page</button></div>` +
    (viewMode === "full" ? `<div class="pe-nav"><button data-n="-1" title="Previous page">‹</button><select title="Go to page">${pages.map((_, i) => `<option value="${i}"${i === fullIdx ? " selected" : ""}>Page ${i + 1}</option>`).join("")}</select><span>of ${n}</span><button data-n="1" title="Next page">›</button></div>` : `<span class="pe-count">${n} page${n === 1 ? "" : "s"}${selected.size ? " · " + selected.size + " ticked" : ""} · double-click a page to view it large</span>`);
  bar.querySelectorAll("[data-v]").forEach((b) => b.onclick = () => setView(b.dataset.v));
  bar.querySelectorAll("[data-n]").forEach((b) => b.onclick = () => { fullIdx = Math.max(0, Math.min(n - 1, fullIdx + +b.dataset.n)); renderGrid(); });
  const sel = bar.querySelector("select"); if (sel) sel.onchange = () => { fullIdx = +sel.value; renderGrid(); };
  return bar;
}
function renderFullPage(stage) {
  const idx = fullIdx, entry = pages[idx]; if (!entry) return;
  const d = document.createElement("div"); d.className = "pe-full" + (selected.has(idx) ? " sel" : "");
  d.innerHTML = '<div class="pe-ph" style="height:60vh">…</div><span class="pe-num">' + (idx + 1) + '</span><input type="checkbox" class="pe-chk"' + (selected.has(idx) ? " checked" : "") + '>' +
    (dupMarks.has(entry) ? `<span class="pe-dup">Same as page ${pages.indexOf(dupMarks.get(entry)) + 1}</span>` : "") +
    '<div class="pe-bar"><button data-a="rl" title="Rotate left">⟲</button><button data-a="rr" title="Rotate right">⟳</button><button data-a="dup" title="Duplicate">⧉</button><button data-a="del" title="Delete">🗑</button></div>';
  d.querySelector(".pe-chk").onchange = (e) => { if (e.target.checked) selected.add(idx); else selected.delete(idx); d.classList.toggle("sel", e.target.checked); };
  d.querySelectorAll(".pe-bar button").forEach((b) => b.onclick = () => { act(b.dataset.a, idx); });
  stage.appendChild(d);
  const W = Math.min(1100, Math.max(400, (stage.clientWidth || 900) - 40));
  (async () => {
    const src = sources.find((s) => s.id === entry.srcId), pg = await (await jsDoc(src)).getPage(entry.srcIndex + 1);
    const vp = pg.getViewport({ scale: 1, rotation: ((pg.rotate || 0) + entry.rot) % 360 });
    const c = await rasterize(entry, Math.min(4, W * (window.devicePixelRatio || 1) / vp.width));
    const ph = d.querySelector(".pe-ph"); if (!ph) return;
    const wrap = document.createElement("div"); wrap.className = "pe-imgwrap"; wrap.style.position = "relative";
    const img = new Image(); img.src = c.toDataURL("image/jpeg", 0.9); img.style.width = W + "px"; img.draggable = false; wrap.appendChild(img); ph.replaceWith(wrap);
    if (redactMode) enableRedactDraw(wrap, entry);
    drawRedactBoxes(wrap, entry);
  })().catch(() => {});
}
document.addEventListener("keydown", (e) => {
  if (viewMode !== "full" || !document.body.classList.contains("pdfmode") || /INPUT|SELECT|TEXTAREA/.test((e.target || {}).tagName || "")) return;
  if (e.key === "ArrowRight" || e.key === "PageDown") { fullIdx = Math.min(pages.length - 1, fullIdx + 1); renderGrid(); }
  if (e.key === "ArrowLeft" || e.key === "PageUp") { fullIdx = Math.max(0, fullIdx - 1); renderGrid(); }
});

// ---- Pictures → PDF ---------------------------------------------------------------------
function openPicPdf() {
  panelShell("Pictures → PDF", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Drop pictures on the page area (all at once or one by one), or add them here. Drag pages to change the order; rotate or remove them there. PDFs can be mixed in too.</div>
    <button class="btn" id="pe_pp_add" style="margin-bottom:10px">＋ Add pictures</button>
    <div class="row"><label>Page size</label><select id="pe_pp_size"><option value="fit">Same as each picture</option><option value="letter">Letter</option><option value="a4">A4</option><option value="legal">Legal</option></select></div>
    <div class="row"><label>Margin</label><select id="pe_pp_mar"><option value="0">None</option><option value="18">Small</option><option value="36" selected>Normal</option><option value="72">Wide</option></select></div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:6px 0"><input type="checkbox" id="pe_pp_up"> Clean up &amp; upscale each picture first (sharper, higher resolution)</label>
    <div id="pe_pp_upopts" style="display:none">
      <div class="row"><label>Engine</label><select id="pe_pp_eng"><option value="balanced">AI upscale — best</option><option value="fast">AI upscale — faster</option><option value="classic">Classic (no AI)</option></select></div>
      <div class="row"><label>Resolution</label><select id="pe_pp_dpi"><option value="200">200 DPI</option><option value="300" selected>300 DPI</option></select></div>
      <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_pp_wh" checked> Clean background (paper to white)</label>
    </div>
    <div style="font-size:11.5px;color:var(--muted);margin:6px 0">Tick pages to build from only those; otherwise every page is used, in the order shown.</div>
    <button class="btn primary" id="pe_pp_go">Build PDF</button>
    <div id="pe_pp_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`);
  $("pe_pp_add").onclick = () => pickFiles("image/*,application/pdf", true, addFiles);
  $("pe_pp_up").onchange = () => { $("pe_pp_upopts").style.display = $("pe_pp_up").checked ? "" : "none"; };
  $("pe_pp_go").onclick = () => withBusy("Building…", async () => {
    const list = selected.size ? pages.filter((_, i) => selected.has(i)) : pages.slice();
    if (!list.length) return note("Add some pictures first.", true);
    const size = $("pe_pp_size").value, margin = +$("pe_pp_mar").value, up = $("pe_pp_up").checked, prog = $("pe_pp_prog");
    const opt = { engine: $("pe_pp_eng").value, dpi: +$("pe_pp_dpi").value, sharpen: 0.6, whiten: $("pe_pp_wh").checked, despeckle: true, gray: false };
    if (up && opt.engine !== "classic") { prog.textContent = "Loading the AI model…"; await getUpscaler(opt.engine); }
    const L = PDFLib(), out = await L.PDFDocument.create();
    for (let i = 0; i < list.length; i++) {
      const e = list[i], src = sources.find((q) => q.id === e.srcId), pg = await (await jsDoc(src)).getPage(e.srcIndex + 1);
      const vp = pg.getViewport({ scale: 1, rotation: ((pg.rotate || 0) + e.rot) % 360 });
      prog.textContent = `Page ${i + 1} of ${list.length}…`;
      if (!up && size === "fit") { const lib = await L.PDFDocument.load(src.bytes, { ignoreEncryption: true }); const [cp] = await out.copyPages(lib, [e.srcIndex]); if (e.rot) cp.setRotation(L.degrees((cp.getRotation().angle + e.rot) % 360)); out.addPage(cp); continue; }
      // the picture at its own resolution (a picture page is 0.75 pt per pixel), optionally enhanced
      let c = await rasterize(e, src.picture ? Math.min(4, 1 / 0.75) : 2);
      let dpi = src.picture ? 96 : 144;
      if (up) { c = await enhanceOne(c, { ...opt, inW: vp.width / 72 }, (r) => prog.textContent = `Enhancing page ${i + 1} of ${list.length}… ${Math.round(r * 100)}%`); dpi = opt.dpi; }
      const img = await out.embedJpg(dataURLtoU8(c.toDataURL("image/jpeg", 0.92)));
      if (size === "fit") { const w = c.width * 72 / dpi, h = c.height * 72 / dpi; out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h }); continue; }
      let [pw, ph] = PAGE_SIZES[size]; if (c.width > c.height) [pw, ph] = [ph, pw];
      const k = Math.min((pw - 2 * margin) / c.width, (ph - 2 * margin) / c.height), w = c.width * k, h = c.height * k;
      out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    }
    prog.textContent = "";
    await save(out, "images.pdf"); note(`Saved images.pdf (${list.length} page${list.length === 1 ? "" : "s"}${up ? ", upscaled" : ""}).`);
  });
}

// ---- duplicate pages ----------------------------------------------------------------------
// Each page becomes a small greyscale copy (paper = 1, darkest ink = 0). A pair is compared at the same stroke
// thickness (the second page's ink cut-off is chosen so both have the same amount of ink, which cancels out a
// blurrier or darker re-scan), lined up by where their ink starts, with one pixel of slack. Two numbers come out:
// the share of ink that has nothing near it on the other page, and the most different small area - so a page
// that differs anywhere (another word, a filled-in value) is not a duplicate. Pages whose text layers differ never are.
const FP_W = 180, FP_H = 240, FP_T = 12;
async function pageFingerprint(e) {
  const key = "fp4|" + e.srcId + "|" + e.srcIndex + "|" + e.rot;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = await rasterize(e, 1), t = document.createElement("canvas"); t.width = FP_W; t.height = FP_H;
  const g = t.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, FP_W, FP_H); g.imageSmoothingQuality = "high"; g.drawImage(c, 0, 0, FP_W, FP_H);
  const d = g.getImageData(0, 0, FP_W, FP_H).data, lum = new Float32Array(FP_W * FP_H);
  let lo = 255, hi = 0;
  for (let i = 0; i < lum.length; i++) { const v = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3; lum[i] = v; lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(40, hi - lo); for (let i = 0; i < lum.length; i++) lum[i] = Math.max(0, Math.min(1, (lum[i] - (hi - span)) / span));
  const sorted = Float32Array.from(lum).sort();
  let text = "";
  try { const src = sources.find((q) => q.id === e.srcId), pg = await (await jsDoc(src)).getPage(e.srcIndex + 1); text = (await pg.getTextContent()).items.map((i) => i.str).join(" ").replace(/\s+/g, " ").trim().toLowerCase(); } catch (_) {}
  const ink = new Uint8Array(lum.length); let n = 0; for (let i = 0; i < lum.length; i++) { ink[i] = lum[i] < 0.5 ? 1 : 0; n += ink[i]; }
  const fp = { lum, sorted, ink, n, text, ar: Math.round(c.width / c.height * 20) };
  thumbCache.set(key, fp); return fp;
}
function grow(m) { const g = new Uint8Array(m.length); for (let y = 0; y < FP_H; y++) for (let x = 0; x < FP_W; x++) { if (!m[y * FP_W + x]) continue; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = y + dy, xx = x + dx; if (yy >= 0 && yy < FP_H && xx >= 0 && xx < FP_W) g[yy * FP_W + xx] = 1; } } return g; }
function firstInk(m) { let x0 = FP_W, y0 = FP_H; for (let y = 0; y < FP_H; y++) for (let x = 0; x < FP_W; x++) if (m[y * FP_W + x]) { if (x < x0) x0 = x; if (y < y0) y0 = y; } return [x0, y0]; }
function inkDistance(a, b) {
  if (!a.n && !b.n) return { overall: 0, worst: 0 };
  if (!a.n || !b.n) return { overall: 1, worst: 1 };
  // b's ink at the same amount as a's
  const cut = b.sorted[Math.min(b.sorted.length - 1, a.n - 1)], bm = new Uint8Array(b.lum.length);
  for (let i = 0; i < bm.length; i++) bm[i] = b.lum[i] <= cut ? 1 : 0;
  const ag = grow(a.ink), bg = grow(bm), [ax, ay] = firstInk(a.ink), [bx, by] = firstInk(bm), cl = (v) => Math.max(-10, Math.min(10, v));
  const at = (sx, sy, tiles) => {
    const B = (arr, x, y) => { const xx = x + sx, yy = y + sy; return xx >= 0 && xx < FP_W && yy >= 0 && yy < FP_H ? arr[yy * FP_W + xx] : 0; };
    let miss = 0, tot = 0, worst = 0; const m = tiles ? new Uint8Array(a.ink.length) : null;
    for (let y = 0; y < FP_H; y++) for (let x = 0; x < FP_W; x++) { const i = y * FP_W + x, ai = a.ink[i], bi = B(bm, x, y), mi = (ai && !B(bg, x, y)) || (bi && !ag[i]) ? 1 : 0; miss += mi; tot += ai + bi; if (m) m[i] = mi; }
    if (m) for (let ty = 0; ty < FP_H; ty += FP_T) for (let tx = 0; tx < FP_W; tx += FP_T) { let t = 0; for (let y = ty; y < ty + FP_T; y++) for (let x = tx; x < tx + FP_T; x++) t += m[y * FP_W + x]; worst = Math.max(worst, t / (FP_T * FP_T)); }
    return { overall: tot ? miss * 2 / tot : 0, worst, shift: [sx, sy] };
  };
  let best = null;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const d = at(cl(bx - ax) + dx, cl(by - ay) + dy, false); if (!best || d.overall < best.overall) best = d; }
  return at(best.shift[0], best.shift[1], true);
}
async function findDuplicates(maxDist) {
  const fps = [];
  for (let i = 0; i < pages.length; i++) fps.push(await pageFingerprint(pages[i]));
  dupMarks = new Map();
  for (let i = 0; i < pages.length; i++) {
    if (dupMarks.has(pages[i])) continue;
    for (let j = i + 1; j < pages.length; j++) {
      if (dupMarks.has(pages[j])) continue;
      const a = fps[i], b = fps[j]; if (a.ar !== b.ar || a.text !== b.text) continue;
      const d = inkDistance(a, b);
      if (d.worst <= maxDist && d.overall <= maxDist * 2) dupMarks.set(pages[j], pages[i]);
    }
  }
  selected.clear(); pages.forEach((p, i) => { if (dupMarks.has(p)) selected.add(i); });
  return dupMarks.size;
}
function openDupes() {
  panelShell("Find duplicate pages", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Finds pages that look the same (scanned twice, the same picture added twice, repeated pages). The first copy is kept; the later copies are ticked so you can check them before removing.</div>
    <div class="row"><label>Match</label><select id="pe_dup_tol"><option value="0.03">Exact copies only</option><option value="0.12" selected>Same page, scanned again</option><option value="0.15">Loose (may also catch pages that differ in one small detail)</option></select></div>
    <button class="btn" id="pe_dup_go">Find duplicates</button>
    <div id="pe_dup_res" style="font-size:12.5px;margin-top:8px"></div>`);
  $("pe_dup_go").onclick = () => withBusy("Comparing pages…", async () => {
    if (pages.length < 2) return note("Open a document or pictures with at least two pages.", true);
    const n = await findDuplicates(+$("pe_dup_tol").value); renderGrid();
    const res = $("pe_dup_res"); res.innerHTML = "";
    if (!n) { res.textContent = "No duplicates found."; return; }
    const ul = document.createElement("div");
    pages.forEach((p, i) => { if (dupMarks.has(p)) ul.appendChild(mk2("div", `Page ${i + 1} is the same as page ${pages.indexOf(dupMarks.get(p)) + 1}`)); });
    res.appendChild(mk2("div", `<b>${n} duplicate page${n === 1 ? "" : "s"}</b> — ticked and marked on the left. Untick any you want to keep.`)); res.appendChild(ul);
    const rm = document.createElement("button"); rm.className = "btn primary"; rm.style.marginTop = "8px"; rm.textContent = "Remove ticked pages";
    rm.onclick = () => { const k = selected.size; pages = pages.filter((_, i) => !selected.has(i)); selected.clear(); dupMarks.clear(); renderGrid(); res.textContent = ""; note(`Removed ${k} page${k === 1 ? "" : "s"}. Download PDF to save the result.`); };
    res.appendChild(rm);
  });
}
function mk2(tag, html) { const e = document.createElement(tag); e.innerHTML = html; return e; }

// ---- sort pages by their printed page numbers ---------------------------------------------
// Reads the number printed on each page: "Page 3", "3 of 10", or a lone number at the top or bottom.
// Pages with a text layer are read directly; scans are read with OCR (only the top and bottom strips, so it's quick).
// OCR reads a lone 1 as l, I or |, and 0 as O: fixed only in words that are otherwise just a number
const fixDigits = (t) => /^[\[\(\-–—~]*[0-9lI|Oo]{1,4}[\]\)\-–—~.]*$/.test(t) && (/\d/.test(t) || /^[\[\(\-–—~]*[lI|][\]\)\-–—~.]*$/.test(t)) ? t.replace(/[lI|]/g, "1").replace(/[Oo]/g, "0") : t;
function numberFromWords(words) {   // words: {t, x, y} with x, y as 0..1 of the page (y from the top)
  words = words.map((w) => ({ ...w, t: fixDigits(w.t) }));
  const all = words.map((w) => w.t).join(" ");
  let m = all.match(/\bpage\s*[:#]?\s*(\d{1,4})\b/i); if (m) return +m[1];
  m = all.match(/\b(\d{1,4})\s*(?:of|0f|o f|\/)\s*(\d{1,4})\b/i); if (m && +m[1] <= +m[2]) return +m[1];
  const cands = words.filter((w) => (w.y > 0.88 || w.y < 0.1) && /^[-–—(\[]?\d{1,4}[-–—)\].]?$/.test(w.t.trim()))
    .map((w) => ({ n: +w.t.replace(/\D/g, ""), score: (w.y > 0.88 ? 0 : 0.5) + Math.min(Math.abs(w.x - 0.5), Math.abs(w.x - 0.08), Math.abs(w.x - 0.92)) + 0.3 * words.filter((o) => o !== w && Math.abs(o.y - w.y) < 0.012).length }))
    .filter((c) => c.n > 0 && c.n < 1900);
  // a whole line at the top or bottom that is just a number with decoration around it ("- 3 -", "[ 3 ]", "~3~")
  const lines = [];
  words.filter((w) => w.y > 0.88 || w.y < 0.1).forEach((w) => { const l = lines.find((q) => Math.abs(q.y - w.y) < 0.012); if (l) l.ws.push(w); else lines.push({ y: w.y, ws: [w] }); });
  lines.forEach((l) => { const t = l.ws.map((w) => w.t).join(" "), digits = t.replace(/[^0-9a-z]/gi, "");
    if (/^\d{1,4}$/.test(digits) && +digits > 0 && +digits < 1900 && !/[a-z]/i.test(t)) cands.push({ n: +digits, score: (l.y > 0.88 ? 0.05 : 0.55) + Math.abs(l.ws.reduce((s, w) => s + w.x, 0) / l.ws.length - 0.5) }); });
  cands.sort((a, b) => a.score - b.score);
  return cands.length ? cands[0].n : null;
}
async function pageNumberOf(e, useOcr) {
  const src = sources.find((q) => q.id === e.srcId), pg = await (await jsDoc(src)).getPage(e.srcIndex + 1);
  const vp = pg.getViewport({ scale: 1, rotation: ((pg.rotate || 0) + e.rot) % 360 });
  const words = [];
  for (const it of (await pg.getTextContent()).items) {
    if (!it.str || !it.str.trim()) continue;
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    it.str.trim().split(/\s+/).forEach((t) => words.push({ t, x: x / vp.width, y: y / vp.height }));
  }
  let n = numberFromWords(words);
  if (n != null || !useOcr || words.length > 30) return n;
  // a scan: OCR just the top and bottom strips
  // the strips at a high resolution; read cleaned to black on white first (compression noise turns a 3 into
  // a 9 otherwise), and as they are if that finds nothing
  const c = await rasterize(e, Math.max(1, Math.min(3, 1600 / vp.width))), band = Math.round(c.height * 0.13);   // ~1600 px wide: OCR misreads letters that are too large too
  const strips = (clean) => {
    const s = document.createElement("canvas"); s.width = c.width; s.height = band * 2 + 20;
    const g = s.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, s.width, s.height);
    g.drawImage(c, 0, 0, c.width, band, 0, 0, c.width, band); g.drawImage(c, 0, c.height - band, c.width, band, 0, band + 20, c.width, band);
    if (clean) {
      const id = g.getImageData(0, 0, s.width, s.height), px = id.data; let lo = 255, hi = 0;
      for (let i = 0; i < px.length; i += 4) { const v = (px[i] + px[i + 1] + px[i + 2]) / 3; px[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
      const cut = lo + (hi - lo) * 0.55; for (let i = 0; i < px.length; i += 4) { const v = px[i] < cut ? 0 : 255; px[i] = px[i + 1] = px[i + 2] = v; }
      g.putImageData(id, 0, 0);
    }
    return s;
  };
  const sched = await ocrScheduler("eng", ocrPoolSize());
  for (const clean of [true, false]) {
    const s = strips(clean), r = await sched.addJob("recognize", s);
    const ow = (r.data.words || []).map((w) => { const cy = (w.bbox.y0 + w.bbox.y1) / 2; return { t: w.text, x: (w.bbox.x0 + w.bbox.x1) / 2 / s.width, y: cy < band + 10 ? cy / c.height : (c.height - band + (cy - band - 20)) / c.height }; });
    n = numberFromWords(ow); if (n != null) return n;
  }
  return null;
}
function openPageSort() {
  panelShell("Sort by page numbers", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Reads the page number printed on each page ("Page 3", "3 of 10", or a number at the top or bottom) and puts the pages in that order. Scanned pages are read with OCR. Check the numbers before applying — you can type over any of them.</div>
    <label style="display:flex;gap:8px;align-items:center;font-size:12.5px;margin:4px 0"><input type="checkbox" id="pe_ps_ocr" checked> Read scanned pages with OCR</label>
    <button class="btn" id="pe_ps_go">Read page numbers</button>
    <div id="pe_ps_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
    <div id="pe_ps_list" class="pe-pslist"></div>
    <button class="btn primary" id="pe_ps_apply" style="display:none;margin-top:8px">Put pages in this order</button>`);
  let found = [];
  $("pe_ps_go").onclick = () => withBusy("Reading page numbers…", async () => {
    if (!pages.length) return note("Open a document first.", true);
    const prog = $("pe_ps_prog"), useOcr = $("pe_ps_ocr").checked; found = [];
    for (let i = 0; i < pages.length; i++) { prog.textContent = `Reading page ${i + 1} of ${pages.length}…`; let n = null; try { n = await pageNumberOf(pages[i], useOcr); } catch (_) {} found.push(n); }
    prog.textContent = `Found a number on ${found.filter((n) => n != null).length} of ${pages.length} pages.`;
    const host = $("pe_ps_list"); host.innerHTML = "";
    found.forEach((n, i) => {
      const row = mk2("div", `<span>Position ${i + 1}</span>`); row.className = "pe-psrow";
      const inp = document.createElement("input"); inp.type = "number"; inp.min = "0"; inp.value = n == null ? "" : n; inp.placeholder = "none"; inp.title = "Page number found on this page";
      inp.oninput = () => { found[i] = inp.value === "" ? null : +inp.value; };
      row.appendChild(inp); host.appendChild(row);
    });
    $("pe_ps_apply").style.display = "";
  });
  $("pe_ps_apply").onclick = () => {
    // numbered pages go in number order; a page without a number stays right after the page it followed
    let lastKey = -1e9, seq = 0; const keyed = pages.map((p, i) => {
      if (found[i] != null) { lastKey = found[i]; seq = 0; return { p, k: found[i], s: 0, i }; }
      return { p, k: lastKey, s: ++seq, i };
    });
    keyed.sort((a, b) => a.k - b.k || a.s - b.s || a.i - b.i);
    pages = keyed.map((x) => x.p); selected.clear(); renderGrid();
    $("pe_ps_list").innerHTML = ""; $("pe_ps_apply").style.display = "none"; $("pe_ps_prog").textContent = "";
    note("Pages sorted by their page numbers. Download PDF to save the result.");
  };
}

export function initPdfEditor() {
  const pj = pdfjs();
  if (pj && pj.GlobalWorkerOptions && !pj.GlobalWorkerOptions.workerSrc)
    pj.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const open = () => pickFiles("application/pdf,image/*", true, addFiles);
  $("pe_open") && ($("pe_open").onclick = open);
  $("pe_selall") && ($("pe_selall").onclick = () => {
    if (selected.size === pages.length) selected.clear(); else pages.forEach((_, i) => selected.add(i));
    renderGrid();
  });
  $("pe_export") && ($("pe_export").onclick = () => withBusy("Saving…", async () => {
    if (!pages.length) return note("Open a PDF first.", true);
    await save(await buildPdf(pages), "edited.pdf"); note("Saved edited.pdf (" + pages.length + " pages).");
  }));
  buildGrid();
  renderGrid();
  renderPeRecents();
  // Load a PDF straight into the editor by bytes (used by the Sign→editor handoff).
  window.__cal2RefreshPeRecents = renderPeRecents;
  window.__cal2OpenPdfEditorBytes = async (bytes, name) => {
    resetAll();
    try { await addSourceBytes(name || "document.pdf", new Uint8Array(bytes)); buildGrid(); renderGrid(); rememberSource(sources[0]).catch(() => {}); }
    catch (e) { note("Could not open: " + (e.message || e), true); }
  };
  // Hooks for the page shell: open a tool by id, add/reset files, convert helpers.
  window.__cal2OpenTool = (id) => {
    const t = TOOLS.find((x) => x.id === id);
    if (!t) { backToGrid(); return; }
    if (t.kind === "action" && !["merge", "txt2pdf"].includes(t.id) && !pages.length) return;  // waits for a file
    openTool(t);
  };
  window.__cal2AddPdfFiles = (files) => addFiles(files);
  window.__cal2ResetPdf = () => { resetAll(); backToGrid(); };
  window.__cal2PdfPageCount = () => pages.length;
  window.__cal2TxtToPdf = (f) => txtToPdf(f);
  window.__cal2ImagesToPdf = (files, o) => imagesToPdf(files, o);
  window.__cal2EnhanceAdd = async (files) => { enhImages = []; await addFiles(files); openEnhance(); };
  window.__cal2PdfBack = () => backToGrid();
  // Run a tool on bytes handed over by the editor (the document as you see it).
  window.__cal2RunPdfTool = async (id, bytes, name, sel) => {
    resetAll();
    await addSourceBytes(name || "document.pdf", new Uint8Array(bytes));
    (sel || []).forEach((i) => { if (i < pages.length) selected.add(i); });
    buildGrid();
    const t = TOOLS.find((x) => x.id === id);
    if (t) openTool(t);
  };
}
function resetAll() { enhImages = []; sources = []; pages = []; selected.clear(); jsDocs.clear(); thumbCache.clear(); srcSeq = 1; etSrc = null; etEdits.clear(); }
