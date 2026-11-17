// shell.js — the site around the Ghost Calligrapher app: a home page with every tool,
// one landing page per tool (drop a file to start), the Tools menu, recent files
// and hash routing (#/, #/tool/<id>, #/edit, #/pdf/<tool>, #/write, #/recent).
// It drives the app only through the small window.__cal2* hooks app.js and
// pdfedit.js expose, so the editing code stays in one place.
import { listRecents, getRecent, delRecent, makeRecentCard } from "./recents.js?v=1";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toast = (m) => (window.__cal2Toast ? window.__cal2Toast(m) : null);
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name || "");
const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name || "");
const isText = (f) => /^text\//.test(f.type) || /\.(txt|md|csv|log)$/i.test(f.name || "");

// ---- icons -------------------------------------------------------------------
const P = {
  edit: '<path d="M5 19h4L19 9l-4-4L5 15z"/><path d="M13 7l4 4"/>',
  pen: '<path d="M5 19l1.5-5L15 5.5l3.5 3.5L10 17.5z"/><path d="M13 7.5l3.5 3.5"/>',
  marker: '<path d="M7.5 15.5l2-6 7-7 4 4-7 7z"/><path d="M4 20h10" stroke-width="3" opacity=".6"/>',
  text: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M5 18l5-5 3 3 2-2 4 4"/>',
  whiteout: '<rect x="4" y="7" width="16" height="10" rx="1.5"/><path d="M8 12h8" stroke-dasharray="2 2.2"/>',
  note: '<path d="M5 5h14v9l-5 5H5z"/><path d="M14 19v-5h5"/>',
  edittext: '<path d="M4 6h10M9 6v12"/><path d="M13 19l1-3.5 5.5-5.5 2.5 2.5-5.5 5.5z"/>',
  sign: '<path d="M3 15c3-7 5-7 5-3s2 4 4 0 3-4 4 0 3 2 5 1"/><path d="M3 20h18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  field: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 12h6"/>',
  date: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  merge: '<rect x="3" y="3" width="8" height="10" rx="1"/><rect x="13" y="3" width="8" height="10" rx="1"/><path d="M12 15v6M9 18l3 3 3-3"/>',
  split: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M2 12h20" stroke-dasharray="2.2 2"/>',
  rotate: '<path d="M19.5 12A7.5 7.5 0 1117.3 6.7"/><path d="M19.5 4v5h-5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  pages: '<rect x="8" y="3" width="12" height="15" rx="1.5"/><path d="M4 7v13h12"/>',
  organize: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  number: '<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M10 14.5l1.8-1.3V18M9.5 18h4.5"/>',
  crop: '<path d="M7 2v15h15M2 7h15v15"/>',
  redact: '<rect x="4" y="5" width="16" height="4.5" fill="currentColor"/><path d="M4 14h16M4 18h10"/>',
  stamp: '<path d="M9 3h6v6l3.5 3.5V15h-13v-2.5L9 9z"/><path d="M5 20h14"/>',
  compress: '<path d="M8 3v5l4 4 4-4V3M8 21v-5l4-4 4 4v5"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/>',
  flatten: '<path d="M4 8l8-4 8 4-8 4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>',
  scan: '<path d="M4 8V5h4M16 5h4v3M20 16v3h-4M8 19H4v-3M4 12h16"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  check2: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const glyph = (t) => `<text x="12" y="15.6" text-anchor="middle" font-size="${t.length > 3 ? 6.5 : 8}" font-weight="700" font-family="Arial,sans-serif" fill="currentColor" stroke="none">${t}</text>`;
const icon = (k, cls = "i") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[k] || glyph(k)}</svg>`;
const tile = (color, k) => `<span class="ico" style="background:${color}">${icon(k)}</span>`;

// ---- every tool --------------------------------------------------------------
// mode "doc" = document editor (tool = toolbar tool to start with)
// mode "pdf" = PDF tools (tool = pdfedit tool id; panel tools open on arrival)
// mode "write" = handwriting studio (no file needed)

// ---- your document builder (mtgcalc) and recently built files ------------------------
const BUILDER_URL = "https://jcodomo.github.io/mtgcalc/";
const EXT = ' target="_blank" rel="noopener"';
// The builder downloads the PDFs it makes, so "recent files" from it live in a folder
// (usually Downloads). Pick that folder once; it is remembered (Chrome/Edge) and each
// scan lists the PDFs and pictures changed in the last 30 days, newest first.
const CAN_SCAN = "showDirectoryPicker" in window;
function dirDB() { return new Promise((res, rej) => { const r = indexedDB.open("cal2folder", 1); r.onupgradeneeded = () => r.result.createObjectStore("h"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function savedDir() { try { const db = await dirDB(); return await new Promise((res) => { const q = db.transaction("h").objectStore("h").get("dir"); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); } catch (_) { return null; } }
async function keepDir(h) { try { const db = await dirDB(); db.transaction("h", "readwrite").objectStore("h").put(h, "dir"); } catch (_) {} }
async function scanFolder(pickNew) {
  let d = pickNew ? null : await savedDir();
  if (d) { try { if ((await d.queryPermission({ mode: "read" })) !== "granted" && (await d.requestPermission({ mode: "read" })) !== "granted") d = null; } catch (_) { d = null; } }
  if (!d) { d = await window.showDirectoryPicker({ id: "cal2scan", startIn: "downloads", mode: "read" }); keepDir(d); }
  const cutoff = Date.now() - 30 * 864e5, files = [];
  for await (const [name, h] of d.entries()) {
    if (h.kind !== "file" || !/\.(pdf|png|jpe?g|webp)$/i.test(name)) continue;
    try { const f = await h.getFile(); if (f.lastModified >= cutoff) files.push(f); } catch (_) {}
  }
  files.sort((a, b) => b.lastModified - a.lastModified);
  return { folder: d.name, files: files.slice(0, 40) };
}
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
function renderScanned(host, res) {
  host.innerHTML = res.files.length ? "" : `<div class="note">No PDFs or pictures from the last 30 days in “${esc(res.folder)}”.</div>`;
  for (const f of res.files) {
    const row = document.createElement("div"); row.className = "scanrow";
    row.innerHTML = `<span class="sr-ic">${/\.pdf$/i.test(f.name) ? "PDF" : "IMG"}</span><span class="sr-n"><b title="${esc(f.name)}">${esc(f.name)}</b><small>${new Date(f.lastModified).toLocaleString()} · ${fmtSize(f.size)}</small></span><button class="btn primary" data-a="edit">Edit</button><button class="btn" data-a="sign">Sign</button>`;
    row.querySelector('[data-a="edit"]').onclick = () => intakeTool("edit", [f]);
    row.querySelector('[data-a="sign"]').onclick = () => intakeTool("sign", [f]);
    host.appendChild(row);
  }
}
async function runScan(host, status, pickNew) {
  if (!CAN_SCAN) { pick(DOC_IN, true, intakeAny); return; }
  try { status.textContent = "Scanning…"; const res = await scanFolder(pickNew); status.textContent = `${res.files.length} recent file${res.files.length === 1 ? "" : "s"} in “${res.folder}”`; renderScanned(host, res); }
  catch (err) { status.textContent = err && err.name === "AbortError" ? "" : "Couldn't read that folder."; }
}
function builderPanelHTML() {
  return `<div class="builder-box">
    <div class="bb-head"><div><h2 class="sec-h" style="margin:0">Recently built files</h2>
      <p class="sec-sub" style="margin:4px 0 0">Make documents in your builder, then pick them up here to edit or sign. ${CAN_SCAN ? "Choose your Downloads folder once — it's remembered." : "Your browser can't scan folders, so choose the files instead."}</p></div>
      <div class="bb-act"><a class="btn-ghost" href="${BUILDER_URL}"${EXT}>Open document builder ↗</a><button class="btn-blue" data-scan>${CAN_SCAN ? "Scan for recent files" : "Choose files"}</button></div></div>
    <div class="bb-status"><span data-scanstatus></span>${CAN_SCAN ? ' <button class="linkbtn" data-scan-new type="button">Use a different folder</button>' : ""}</div>
    <div class="scanlist" data-scanlist></div></div>`;
}
function wireBuilderPanel(root) {
  const b = root.querySelector("[data-scan]"); if (!b) return;
  const host = root.querySelector("[data-scanlist]"), st = root.querySelector("[data-scanstatus]");
  b.onclick = () => runScan(host, st, false);
  const nb = root.querySelector("[data-scan-new]"); if (nb) nb.onclick = () => runScan(host, st, true);
  // already allowed this session? list straight away
  if (CAN_SCAN) savedDir().then(async (d) => { try { if (d && (await d.queryPermission({ mode: "read" })) === "granted") runScan(host, st, false); } catch (_) {} });
}
const C = { edit: "#0fb5b8", sign: "#e0569b", form: "#1f9d55", org: "#7961f2", opt: "#f23030", conv: "#f0a500", prot: "#e8554e", write: "#0055ff" };
const PDF_IN = "application/pdf,.pdf", DOC_IN = "application/pdf,.pdf,image/*";
const TOOLS = {
  edit:      { name: "Edit PDF", desc: "Add text, images, shapes, drawings and notes to any PDF.", c: C.edit, i: "edit", mode: "doc", tool: "select", accept: DOC_IN },
  annotate:  { name: "PDF Annotator", desc: "Highlight, underline, strike through and comment.", c: C.edit, i: "marker", mode: "doc", tool: "highlight", accept: DOC_IN },
  edittext:  { name: "Edit PDF Text", desc: "Click a line of the PDF's own text and change it.", c: "#3a8dff", i: "edittext", mode: "pdf", tool: "edittext", accept: PDF_IN },
  addtext:   { name: "Add Text to PDF", desc: "Type anywhere on the page, in the font you like.", c: C.edit, i: "text", mode: "doc", tool: "text", accept: DOC_IN },
  addimage:  { name: "Add Image to PDF", desc: "Insert a logo, stamp or photo into your document.", c: C.edit, i: "image", mode: "doc", tool: "select", then: "image", accept: DOC_IN },
  draw:      { name: "Draw on PDF", desc: "Sketch freehand with a pen in any colour.", c: C.edit, i: "pen", mode: "doc", tool: "pen", accept: DOC_IN },
  highlight: { name: "Highlight PDF", desc: "Make the important parts stand out.", c: C.edit, i: "marker", mode: "doc", tool: "highlight", accept: DOC_IN },
  whiteout:  { name: "Whiteout PDF", desc: "Cover anything on a page with a clean white box.", c: C.edit, i: "whiteout", mode: "doc", tool: "whiteout", accept: DOC_IN },
  pdffonts:  { name: "Save PDF Fonts", desc: "Find the fonts a PDF uses and keep them for your own text.", c: C.edit, i: "edittext", mode: "doc", tool: "fonts", accept: PDF_IN },
  builder:   { name: "Mortgage Document Builder ↗", desc: "Open your mtgcalc document builder; bring the PDFs it makes back here to sign.", c: C.form, i: "edit", ext: "https://jcodomo.github.io/mtgcalc/" },
  unwatermark: { name: "Remove Watermark", desc: "Take watermarks off PDFs and pictures you own.", c: C.prot, i: "whiteout", mode: "doc", tool: "wm", accept: DOC_IN },
  notes:     { name: "Comment on PDF", desc: "Stick notes on the page; they save as PDF comments.", c: C.edit, i: "note", mode: "doc", tool: "note", accept: DOC_IN },
  sign:      { name: "Sign PDF", desc: "Place a real-looking handwritten signature on any page.", c: C.sign, i: "sign", mode: "doc", tool: "sig", accept: DOC_IN },
  fillsign:  { name: "Fill & Sign", desc: "Type into a form, tick boxes, add the date and sign.", c: C.sign, i: "check", mode: "doc", tool: "text", accept: DOC_IN },
  adddate:   { name: "Add Date to PDF", desc: "Stamp a date and time, in any time zone.", c: C.sign, i: "date", mode: "doc", tool: "date", accept: DOC_IN },
  forms:     { name: "Form Builder", desc: "Add fillable fields and save a PDF anyone can fill in.", c: C.form, i: "field", mode: "doc", tool: "field:text", accept: DOC_IN },
  fillform:  { name: "Fill PDF Form", desc: "Fill in the form fields a PDF already has.", c: C.form, i: "field", mode: "pdf", tool: "fillform", accept: PDF_IN },
  merge:     { name: "Merge PDF", desc: "Combine several PDFs into one, in the order you want.", c: C.org, i: "merge", mode: "pdf", tool: "", multiple: true, accept: PDF_IN, arrive: "Drag the pages into order (or add more PDFs), then Download." },
  split:     { name: "Split PDF", desc: "Cut a PDF into separate files by page ranges.", c: C.org, i: "split", mode: "pdf", tool: "split", accept: PDF_IN },
  rotate:    { name: "Rotate PDF", desc: "Turn pages the right way up.", c: C.org, i: "rotate", mode: "pdf", tool: "", accept: PDF_IN, arrive: "Use ⟲ ⟳ on a page, or tick pages and pick Rotate in Tools. Then Download PDF." },
  delete:    { name: "Delete PDF Pages", desc: "Remove the pages you don't need.", c: C.org, i: "trash", mode: "pdf", tool: "", accept: PDF_IN, arrive: "Press 🗑 on a page (or tick pages and pick Delete Pages). Then Download PDF." },
  extract:   { name: "Extract PDF Pages", desc: "Save just the pages you choose as a new PDF.", c: C.org, i: "pages", mode: "pdf", tool: "extract", accept: PDF_IN },
  organize:  { name: "Organize PDF", desc: "Reorder, rotate, duplicate and remove pages.", c: C.org, i: "organize", mode: "pdf", tool: "", multiple: true, accept: PDF_IN, arrive: "Drag to reorder; use the buttons under each page. Then Download PDF." },
  compress:  { name: "Compress PDF", desc: "Make a PDF smaller to email or upload.", c: C.opt, i: "compress", mode: "pdf", tool: "compress", accept: PDF_IN },
  number:    { name: "Number Pages", desc: "Add page numbers where you want them.", c: C.edit, i: "number", mode: "pdf", tool: "number", accept: PDF_IN },
  crop:      { name: "Crop PDF", desc: "Trim the margins off every page.", c: C.edit, i: "crop", mode: "pdf", tool: "crop", accept: PDF_IN },
  watermark: { name: "Watermark PDF", desc: "Stamp DRAFT, CONFIDENTIAL or your own words.", c: C.edit, i: "stamp", mode: "pdf", tool: "watermark", accept: PDF_IN },
  pdf2img:   { name: "PDF to JPG / PNG", desc: "Save every page of a PDF as a picture.", c: C.conv, i: "image", mode: "pdf", tool: "img", accept: PDF_IN },
  fillweb:   { name: "Fill & Sign Link", desc: "Turn a form into a web page others can fill in and sign online.", c: C.write, i: "sign", mode: "doc", tool: "fillweb", accept: DOC_IN },
  pdf2word:  { name: "PDF to Word", desc: "Turn a PDF into an editable Word document (.docx); scans are read with OCR.", c: C.conv, i: "DOC", mode: "pdf", tool: "pdfword", accept: PDF_IN },
  enhance:   { name: "Clean Up & Upscale", desc: "Make blurry scans, photos and small pictures into a sharp, high-resolution PDF with AI.", c: C.conv, i: "image", mode: "pdf", tool: "enhance", multiple: true, images: true, accept: "application/pdf,.pdf,image/*" },
  img2pdf:   { name: "JPG / PNG to PDF", desc: "Drop pictures in, put them in order, optionally upscale them, and make one PDF.", c: C.conv, i: "image", mode: "pdf", tool: "imgpdf", multiple: true, images: true, accept: "image/*,application/pdf" },
  dupes:     { name: "Remove Duplicate Pages", desc: "Find pages that appear twice (re-scans, repeated pictures) and remove them.", c: C.org, i: "merge", mode: "pdf", tool: "dupes", multiple: true, images: true, accept: "application/pdf,.pdf,image/*" },
  pagesort:  { name: "Sort Pages by Number", desc: "Read each page's printed page number (OCR for scans) and put the pages in order.", c: C.org, i: "OCR", mode: "pdf", tool: "pagesort", multiple: true, images: true, accept: "application/pdf,.pdf,image/*" },
  txt2pdf:   { name: "Text to PDF", desc: "Turn a .txt, .md or .csv file into a tidy PDF.", c: C.conv, i: "TXT", mode: "convert", accept: ".txt,.md,.csv,.log,text/plain" },
  ocr:       { name: "PDF OCR", desc: "Make a scanned PDF searchable, right in your browser.", c: C.opt, i: "OCR", mode: "pdf", tool: "ocr", accept: PDF_IN },
  unlock:    { name: "Unlock PDF", desc: "Remove a password you know from a PDF.", c: C.prot, i: "lock", mode: "pdf", tool: "unlock", nofile: true },
  redact:    { name: "Redact PDF", desc: "Black out sensitive content so it's gone for good.", c: "#3d3d3d", i: "redact", mode: "pdf", tool: "redact", accept: PDF_IN },
  flatten:   { name: "Flatten PDF", desc: "Bake forms and annotations into the page.", c: C.prot, i: "flatten", mode: "pdf", tool: "", accept: PDF_IN, arrive: "Pick Flatten in Tools to download a flattened copy." },
  write:     { name: "Handwriting Generator", desc: "Turn typed text into handwriting that never repeats.", c: C.write, i: "pen", mode: "write", nofile: true },
  signature: { name: "Signature Maker", desc: "Create a handwritten signature to download or place.", c: C.write, i: "sign", mode: "write", nofile: true, setup: "signature" },
  drawsig:   { name: "Draw a Signature", desc: "Sign with your mouse, finger or a stylus and keep it for later.", c: C.write, i: "sign", mode: "write", nofile: true, setup: "drawsig" },
  drawhand:  { name: "Teach Your Handwriting", desc: "Write a sentence once; new text is written in your own style.", c: C.write, i: "pen", mode: "write", nofile: true, setup: "drawhand" },
  sigimport: { name: "Import a Signature", desc: "Pull your signature out of a photo, screenshot or PDF and fine-tune it.", c: C.write, i: "image", mode: "write", nofile: true, setup: "sigimport" },
  scanlook:  { name: "Make PDF Look Scanned", desc: "Give a document a realistic scanned-paper look.", c: C.write, i: "scan", mode: "doc", tool: "select", setup: "scan", accept: DOC_IN },
};
const MENU = [
  ["Edit", ["edit", "annotate", "edittext", "addtext", "addimage", "draw", "highlight", "whiteout", "notes", "unwatermark", "pdffonts"]],
  ["Fill & Sign", ["sign", "fillsign", "adddate", "forms", "fillform", "fillweb"]],
  ["Organize", ["merge", "split", "rotate", "delete", "extract", "organize", "dupes", "pagesort"]],
  ["Optimize", ["compress", "number", "crop", "watermark"]],
  ["Convert", ["pdf2img", "img2pdf", "pdf2word", "enhance", "txt2pdf", "ocr"]],
  ["Protect", ["unlock", "redact", "flatten"]],
  ["Handwriting", ["write", "signature", "drawsig", "drawhand", "sigimport", "scanlook"]],
  ["Mortgage", ["builder"]],
];
const POPULAR = ["edit", "sign", "merge", "compress", "pdf2img", "write"];
const toolHref = (id) => (TOOLS[id] && TOOLS[id].ext) || "#/tool/" + id;
const extAttr = (id) => (TOOLS[id] && TOOLS[id].ext ? ' target="_blank" rel="noopener"' : "");

function menuHTML() {
  return MENU.map(([h, ids]) => `<div class="msec"><h4>${h}</h4>${ids.map((id) => `<a href="${toolHref(id)}"${extAttr(id)}>${tile(TOOLS[id].c, TOOLS[id].i)}<span>${TOOLS[id].name}</span></a>`).join("")}</div>`).join("");
}
function card(id) {
  const t = TOOLS[id];
  return `<a class="card" href="${toolHref(id)}"${extAttr(id)}>${tile(t.c, t.i)}<div><b>${esc(t.name)}</b><span>${esc(t.desc)}</span></div>${icon("chev", "i chev")}</a>`;
}
const FILES_ART = `<svg class="files-art" width="96" height="72" viewBox="0 0 96 72" fill="none" aria-hidden="true"><rect x="22" y="6" width="44" height="56" rx="4" fill="#fff" opacity=".35"/><rect x="30" y="12" width="44" height="56" rx="4" fill="#fff"/><path d="M38 26h28M38 34h28M38 42h18" stroke="#c9d6f5" stroke-width="3" stroke-linecap="round"/><path d="M38 54c5-9 8-9 8-4s3 6 6 0 5-6 6 0" stroke="#0055ff" stroke-width="2.4" stroke-linecap="round"/></svg>`;
function dropZone(color, label, small) {
  return `<div class="drop${small ? " small" : ""}" style="--dc:${color}" data-drop><div class="drop-in">${FILES_ART}<button class="choose" type="button" data-pick>${icon("plus")}${label}</button><span class="hint">or drop files here</span></div></div>`;
}

// ---- home ---------------------------------------------------------------------
const HERO_ART = `<svg viewBox="0 0 520 380" width="100%" style="max-width:520px;display:block;margin:auto" aria-hidden="true">
  <defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0b2a6b" flood-opacity=".14"/></filter></defs>
  <rect x="70" y="40" width="380" height="300" rx="10" fill="#fff" filter="url(#sh)"/>
  <rect x="70" y="40" width="380" height="40" rx="10" fill="#f6f8fc"/><rect x="70" y="70" width="380" height="10" fill="#f6f8fc"/>
  <g fill="none" stroke="#9aa6bd" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M196 54l9 5-4 1-2 4z"/><path d="M226 54h12M232 54v13"/><path d="M256 64c3-6 5-6 5-2s2 4 4 0 3-4 4 0"/><path d="M288 66l1.5-5 8-8 3 3-8 8z"/><rect x="316" y="53" width="13" height="12" rx="1.5"/></g>
  <rect x="104" y="104" width="250" height="12" rx="6" fill="#e9edf5"/><rect x="104" y="130" width="300" height="10" rx="5" fill="#eef1f6"/>
  <rect x="104" y="150" width="276" height="10" rx="5" fill="#eef1f6"/><rect x="100" y="166" width="196" height="16" rx="3" fill="#ffd400" opacity=".45"/>
  <rect x="104" y="170" width="190" height="10" rx="5" fill="#e3e8f1"/><rect x="104" y="196" width="300" height="10" rx="5" fill="#eef1f6"/>
  <rect x="104" y="216" width="232" height="10" rx="5" fill="#eef1f6"/>
  <rect x="104" y="252" width="150" height="56" rx="5" fill="none" stroke="#0055ff" stroke-width="1.5" stroke-dasharray="5 4"/>
  <path d="M116 292c9-22 15-22 15-10s7 14 13 1 11-13 12 0 8 7 16 4 12-10 22-6" fill="none" stroke="#1d3a8a" stroke-width="3" stroke-linecap="round"/>
  <rect x="300" y="256" width="110" height="30" rx="4" fill="#fff" stroke="#c9d6f5"/><text x="312" y="276" font-family="Arial" font-size="13" fill="#555">11/16/2026</text>
  <circle cx="380" cy="118" r="16" fill="none" stroke="#e23b3b" stroke-width="2.5"/>
  <rect x="440" y="150" width="44" height="44" rx="10" fill="#e0569b"/><path d="M450 177c4-8 6-8 6-3s3 5 5 0 4-5 5 0 3 2 6 1" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
  <rect x="30" y="210" width="44" height="44" rx="10" fill="#0fb5b8"/><path d="M42 242h5l11-11-5-5-11 11z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>
  <rect x="404" y="300" width="40" height="40" rx="9" fill="#7961f2"/><g fill="none" stroke="#fff" stroke-width="2"><rect x="413" y="309" width="9" height="9" rx="1.5"/><rect x="426" y="309" width="9" height="9" rx="1.5"/><rect x="413" y="322" width="9" height="9" rx="1.5"/><rect x="426" y="322" width="9" height="9" rx="1.5"/></g>
</svg>`;
function renderHome() {
  $("view_home").innerHTML = `
  <div class="wrap">
    <div class="hero">
      <div>
        <h1>Ghost Calligrapher</h1>
        <p>Edit, sign, annotate, organize and convert PDFs — and write with a real-looking pen. Everything runs in your browser; your files never leave your device.</p>
        <div class="hero-cta"><button class="btn-blue" data-pick-home>${icon("plus")} Choose a file</button><a class="btn-ghost" href="#all">See all tools</a><a class="btn-ghost" href="${BUILDER_URL}"${EXT}>Document builder ↗</a></div>
      </div>
      <div>${HERO_ART}</div>
    </div>
    ${dropZone("var(--accent-strong)", "CHOOSE FILES")}
    <h2 class="sec-h">Most popular tools</h2>
    <p class="sec-sub">${Object.keys(TOOLS).length} tools to edit, sign, convert and organize — free, with no account.</p>
    <div class="pop">${POPULAR.map(card).join("")}</div>
    <div id="home_recent_wrap" hidden>
      <h2 class="sec-h">Recent files</h2><p class="sec-sub">Pick up where you left off. Stored only in this browser.</p>
      <div class="recents-big" id="home_recent"></div>
    </div>
    ${builderPanelHTML()}
    <h2 class="sec-h" id="all">All tools</h2>
    <p class="sec-sub">Pick a tool, then drop your file on its page.</p>
    <div class="allgrid">${menuHTML()}</div>
    <div class="foot"><span>Ghost Calligrapher · everything happens on your device — nothing is uploaded.</span><span><a href="#/write">Handwriting</a> · <a href="#/tool/edit">Edit PDF</a> · <a href="#/tool/organize">PDF tools</a> · <a href="#/recent">Recent files</a></span></div>
  </div>`;
  wireDrop($("view_home"), (files) => intakeAny(files));
  $("view_home").querySelector("[data-pick-home]").onclick = () => pick(DOC_IN, true, intakeAny);
  wireBuilderPanel($("view_home"));
  refreshHomeRecents();
}
async function refreshHomeRecents() {
  const host = $("home_recent"), wrap = $("home_recent_wrap"); if (!host) return;
  const list = await listRecents();
  wrap.hidden = !list.length; host.innerHTML = "";
  for (const r of list) host.appendChild(makeRecentCard(r, () => openRecent(r.id, "doc"), async () => { await delRecent(r.id); refreshHomeRecents(); }));
}
window.__cal2RefreshHomeRecents = refreshHomeRecents;

// ---- tool landing --------------------------------------------------------------
const CHECKS = ["Works right in your browser", "Your files are never uploaded", "Free, no account or sign-up"];
const STEPS = {
  doc: ["Choose your PDF or picture, or drop it on the box above.", "Use the toolbar over the page — then click or drag on the page.", "Press Download to save a PDF (flattened, or editable with fillable fields) or a PNG."],
  pdf: ["Choose your PDF, or drop it on the box above.", "Set the options on the right; arrange pages in the middle.", "Download the result straight to your device."],
  convert: ["Choose your file(s), or drop them on the box above.", "We convert it in your browser — nothing is sent anywhere.", "The new PDF downloads straight away."],
};
function renderTool(id) {
  const t = TOOLS[id];
  const cat = (MENU.find(([, ids]) => ids.includes(id)) || ["Tools"])[0];
  const related = (MENU.find(([, ids]) => ids.includes(id)) || [null, []])[1].filter((x) => x !== id).slice(0, 3);
  const body = t.nofile
    ? `<div class="drop" style="--dc:${t.c}"><div class="drop-in">${FILES_ART}<button class="choose" type="button" data-start>${icon("chev")}${id === "unlock" ? "OPEN UNLOCK" : "START"}</button><span class="hint">${id === "unlock" ? "You'll pick the locked PDF and type its password next." : "No file needed."}</span></div></div>`
    : dropZone(t.c, t.multiple ? "CHOOSE FILES" : "CHOOSE FILE");
  $("view_tool").innerHTML = `
  <div class="wrap">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="#/">Home</a><span>›</span><span>${cat}</span><span>›</span><span>${esc(t.name)}</span></nav>
    <div class="tool-head">
      <h1>${esc(t.name)}</h1>
      ${body}
      <div class="tool-intro"><p>${esc(t.desc)} ${t.mode === "doc" ? "The editor shows every page; pick a tool above the page and click or drag where you want it." : ""}</p>
        <ul class="checks">${CHECKS.map((c) => `<li>${icon("check2")}<span>${c}</span></li>`).join("")}</ul></div>
    </div>
    ${t.nofile ? "" : `<div class="steps">${(STEPS[t.mode] || STEPS.pdf).map((s, i) => `<div><b>${i + 1}</b><p>${esc(s)}</p></div>`).join("")}</div>`}
    ${related.length ? `<div class="related"><h2>More ${cat.toLowerCase()} tools</h2><div class="pop">${related.map(card).join("")}</div></div>` : ""}
    <div class="foot"><span>Ghost Calligrapher · everything happens on your device — nothing is uploaded.</span><span><a href="#/">All tools</a></span></div>
  </div>`;
  const view = $("view_tool");
  if (t.nofile) view.querySelector("[data-start]").onclick = () => startNoFile(id);
  else wireDrop(view, (files) => intakeTool(id, files), t.accept, t.multiple);
}

// ---- recent files page -----------------------------------------------------------
async function renderRecent() {
  const list = await listRecents();
  $("view_tool").innerHTML = `
  <div class="wrap">
    <nav class="crumbs"><a href="#/">Home</a><span>›</span><span>Recent files</span></nav>
    <div class="tool-head"><h1>Recent files</h1>
      <p style="text-align:center;color:var(--muted);margin-top:-8px">The last ${list.length || "few"} files you opened, kept only in this browser.</p>
      <div id="recent_list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:16px;margin-top:22px"></div>
      ${list.length ? "" : `<div style="margin-top:20px">${dropZone("var(--accent-strong)", "CHOOSE FILE", true)}</div>`}
    </div>
    ${builderPanelHTML()}
  </div>`;
  const host = $("recent_list");
  for (const r of list) {
    const el = document.createElement("div");
    el.style.cssText = "border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#fff";
    el.innerHTML = `${r.thumb ? `<img src="${r.thumb}" alt="" style="display:block;width:100%;height:150px;object-fit:cover;object-position:top;border-bottom:1px solid var(--line)">` : `<div style="height:150px;background:var(--panel2)"></div>`}
      <div style="padding:8px 10px"><div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.name)}">${esc(r.name)}</div>
      <div style="color:var(--muted);font-size:12px">${new Date(r.ts).toLocaleString()}</div>
      <div style="display:flex;gap:6px;margin-top:8px"><button class="btn primary" data-a="edit" style="padding:5px">Edit</button>${r.type === "pdf" ? '<button class="btn" data-a="pdf" style="padding:5px">PDF tools</button>' : ""}<button class="btn" data-a="del" title="Remove" style="width:34px;padding:5px">✕</button></div></div>`;
    el.querySelector('[data-a="edit"]').onclick = () => openRecent(r.id, "doc");
    const pb = el.querySelector('[data-a="pdf"]'); if (pb) pb.onclick = () => openRecent(r.id, "pdf");
    el.querySelector('[data-a="del"]').onclick = async () => { await delRecent(r.id); renderRecent(); refreshHomeRecents(); };
    host.appendChild(el);
  }
  if (!list.length) wireDrop($("view_tool"), intakeAny);
  wireBuilderPanel($("view_tool"));
}
async function openRecent(id, where) {
  const rec = await getRecent(id); if (!rec) { toast("That file is no longer stored."); if (where === "sign" || where === "link") go("#/recent"); return; }
  await appReady();
  const u8 = new Uint8Array(rec.bytes);
  if (where === "pdf" && rec.type === "pdf") {
    await window.__cal2OpenPdfEditorBytes(u8, rec.name);
    go("#/pdf");
  } else {
    await window.__cal2OpenDocBytes(u8, rec.name, rec.type === "pdf" ? "pdf" : "image");
    go(where === "sign" ? "#/edit/sign" : "#/edit");
  }
}

// ---- files in --------------------------------------------------------------------
function pick(accept, multiple, cb) {
  const inp = document.createElement("input");
  inp.type = "file"; if (accept) inp.accept = accept; inp.multiple = !!multiple;
  inp.onchange = () => { if (inp.files && inp.files.length) cb([...inp.files]); };
  inp.click();
}
function wireDrop(root, onFiles, accept = DOC_IN, multiple = true) {
  root.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => pick(accept, multiple, onFiles));
  const zones = [...root.querySelectorAll("[data-drop]")];
  zones.forEach((z) => {
    z.ondragover = (e) => { e.preventDefault(); z.classList.add("over"); };
    z.ondragleave = () => z.classList.remove("over");
    z.ondrop = (e) => { e.preventDefault(); z.classList.remove("over"); const f = [...(e.dataTransfer.files || [])]; if (f.length) onFiles(f); };
    z.querySelector(".drop-in").addEventListener("click", (e) => { if (e.target === e.currentTarget) pick(accept, multiple, onFiles); });
  });
}
async function appReady() {
  if (window.__cal2AppReady) return;
  await new Promise((res) => window.addEventListener("cal2:ready", res, { once: true }));
}
// Tools that work on the open document (everything except the pure converters / unlock).
const ON_DOC = (id) => TOOLS[id] && !["img2pdf", "dupes", "pagesort"].includes(id) && id !== "txt2pdf" && id !== "unlock" && !(TOOLS[id].mode === "write" && !TOOLS[id].setup && id !== "write");
async function intakeAny(files) {
  files = [...files];
  const pdfs = files.filter(isPdf), imgs = files.filter(isImage);
  if (pdfs.length > 1) return intakeTool("organize", pdfs);
  if (pdfs.length === 1) return intakeTool("edit", pdfs);
  if (imgs.length > 1) return intakeTool("img2pdf", imgs);
  if (imgs.length === 1) return intakeTool("edit", imgs);
  if (files.some(isText)) return intakeTool("txt2pdf", files.filter(isText));
  toast("Choose a PDF or a picture.");
}
async function intakeTool(id, files) {
  const t = TOOLS[id]; files = [...files];
  await appReady();
  try {
    if (ON_DOC(id) && id !== "write" && id !== "signature" && id !== "sigimport") {
      const docs = files.filter((x) => isPdf(x) || isImage(x));
      if (!docs.length) { toast("Choose a PDF or a picture."); return; }
      await window.__cal2OpenDocFile(docs[0]);
      if (docs.length > 1) await window.__cal2AddFilesToDoc(docs.slice(1));
      go("#/edit/" + id);
    } else if (id === "txt2pdf") {
      const f = files.find(isText) || files[0]; toast("Building your PDF…"); await window.__cal2TxtToPdf(f); toast("PDF saved — check your downloads.");
    } else {
      const pdfs = files.filter((x) => isPdf(x) || (t.images && isImage(x))); if (!pdfs.length) { toast(t.images ? "Choose PDFs or pictures." : "Choose a PDF."); return; }
      window.__cal2ResetPdf();
      await window.__cal2AddPdfFiles(t.multiple ? pdfs : pdfs.slice(0, 1));
      go("#/pdf" + (t.tool ? "/" + t.tool : ""));
      if (t.arrive) setTimeout(() => toast(t.arrive), 350);
    }
  } catch (e) { toast("Could not open that file: " + (e.message || e)); }
}
async function startNoFile(id) {
  const t = TOOLS[id];
  await appReady();
  if (t.setup === "drawhand" || (t.setup === "drawsig" && !window.__cal2HasDoc())) { go(window.__cal2HasDoc() ? "#/edit" : "#/write"); setTimeout(() => applySetup(t.setup), 150); return; }
  if (window.__cal2HasDoc() && ON_DOC(id)) { go("#/edit/" + id); return; }
  if (t.mode === "pdf") { window.__cal2ResetPdf(); go("#/pdf/" + t.tool); return; }
  go("#/write");
  setTimeout(() => applySetup(t.setup), 120);
}
function applySetup(setup) {
  if (setup === "drawsig" || setup === "drawhand") { if (window.__cal2OpenDrawPad) window.__cal2OpenDrawPad(setup === "drawhand" ? "hand" : "sig"); return; }
  if (setup === "signature") { const b = document.querySelector('#mode [data-m="signature"]'); if (b) b.click(); toast("Type your name in the box — the signature updates as you type."); }
  if (setup === "sigimport") { if (window.__cal2PickSignatureImage) window.__cal2PickSignatureImage(); }
  if (setup === "scan") {
    if (window.__cal2ApplyTier) window.__cal2ApplyTier("advanced");
    const tg = document.querySelector('.sw-toggle[data-k="scanned"]'); if (tg && !tg.classList.contains("on")) tg.click();
    const g = tg && tg.closest(".group"); if (g) g.scrollIntoView({ block: "start", behavior: "smooth" });
    toast("Scanned look is on — tune it on the right, then Download.");
  }
}

// ---- routing -----------------------------------------------------------------------
function go(h) { if (location.hash === h) route(); else location.hash = h; }
function setNavCur(h) {
  document.querySelectorAll("#mainnav a").forEach((a) => a.classList.toggle("cur", a.getAttribute("href") === h));
}
async function route() {
  let h = location.hash || "#/";
  // Old share links ("#<state>") open the handwriting studio with that state.
  if (h.length > 1 && !h.startsWith("#/")) { history.replaceState(null, "", "#/write?s=" + encodeURIComponent(h.slice(1))); h = location.hash; }
  closeMega();
  const [path] = h.slice(1).split("?");
  const parts = path.split("/").filter(Boolean);
  setNavCur(h);
  if (!parts.length) { document.body.dataset.route = "home"; renderHome(); document.title = "Ghost Calligrapher — PDF tools & real handwriting"; window.scrollTo(0, 0); return; }
  const [a, b] = parts;
  if (a === "tool" && TOOLS[b]) {
    const t = TOOLS[b];
    await appReady();
    // With a document open, a tool works on it — the document stays in view.
    if (TOOLS[b].setup === "drawhand" || TOOLS[b].setup === "drawsig") { startNoFile(b); return; }
    if (window.__cal2HasDoc() && ON_DOC(b)) { go("#/edit/" + b); return; }
    if (t.mode === "write" && !t.setup) { go("#/write"); return; }   // no document open: the handwriting studio
    document.body.dataset.route = "tool"; renderTool(b); document.title = t.name + " — Ghost Calligrapher"; window.scrollTo(0, 0); return;
  }
  // links from the document builder (mtgcalc): #/open/<id> and #/sign/<id> open a recent file
  if ((a === "open" || a === "sign") && b) { await openRecent(decodeURIComponent(b), a === "sign" ? "sign" : "link"); return; }
  if (a === "recent") { document.body.dataset.route = "tool"; await renderRecent(); document.title = "Recent files — Ghost Calligrapher"; window.scrollTo(0, 0); return; }
  await appReady();
  if (a === "edit") {
    if (!window.__cal2HasDoc()) { go(b && TOOLS[b] ? "#/tool/" + b : "#/tool/edit"); return; }
    document.body.dataset.route = "work"; window.__cal2SetWork("doc"); document.title = (b && TOOLS[b] ? TOOLS[b].name + " — " : "Editor — ") + "Ghost Calligrapher";
    if (b && TOOLS[b]) { setTimeout(() => { window.__cal2ApplyTool(b); if (TOOLS[b].arrive) toast(TOOLS[b].arrive.replace(/“Download PDF” on the right|Download PDF/g, "Download")); }, 40); history.replaceState(null, "", "#/edit"); }
    return;
  }
  if (a === "pdf") {
    document.body.dataset.route = "work"; window.__cal2SetWork("pdf"); document.title = "PDF tools — Ghost Calligrapher";
    if (b) setTimeout(() => window.__cal2OpenTool && window.__cal2OpenTool(b), 30);
    else if (window.__cal2PdfBack) window.__cal2PdfBack();
    return;
  }
  if (a === "write") { document.body.dataset.route = "work"; window.__cal2SetWork("write"); document.title = "Handwriting — Ghost Calligrapher"; return; }
  go("#/");
}

// ---- top bar -------------------------------------------------------------------------
function closeMega() { $("mega").classList.remove("open"); $("tools_btn").setAttribute("aria-expanded", "false"); }
function toggleMega() { const open = !$("mega").classList.contains("open"); $("mega").classList.toggle("open", open); $("tools_btn").setAttribute("aria-expanded", String(open)); }
$("mega_in").innerHTML = menuHTML();
$("tools_btn").onclick = (e) => { e.stopPropagation(); toggleMega(); };
$("burger").onclick = (e) => { e.stopPropagation(); toggleMega(); };
$("mega").addEventListener("click", (e) => { if (e.target.closest("a")) closeMega(); });
document.addEventListener("click", (e) => { if (!e.target.closest("#mega") && !e.target.closest("#tools_btn") && !e.target.closest("#burger")) closeMega(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMega(); });
$("top_choose").onclick = () => pick(DOC_IN, true, intakeAny);
// light (soft grey) / dark theme, remembered in this browser
const MOON = '<svg class="i" viewBox="0 0 20 20"><path d="M16.5 12.2A6.8 6.8 0 017.8 3.5a6.8 6.8 0 108.7 8.7z"/></svg>';
const SUN = '<svg class="i" viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.5"/><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4"/></svg>';
function syncThemeBtn() { const dark = document.documentElement.dataset.theme === "dark"; $("theme_btn").innerHTML = dark ? SUN : MOON; $("theme_btn").title = dark ? "Switch to the light theme" : "Switch to the dark theme"; }
$("theme_btn").onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; try { localStorage.setItem("cal2_theme", t); } catch (_) {} syncThemeBtn(); };
syncThemeBtn();
// Recent files, one click from anywhere
async function renderRecentDD() {
  const dd = $("recent_dd"), list = await listRecents();
  dd.innerHTML = '<h4>Recent files</h4>' + (list.length ? "" : '<div class="note" style="padding:4px 6px 8px">Files you open show up here.</div>');
  for (const r of list) {
    const b = document.createElement("button"); b.className = "rrow";
    b.innerHTML = (r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="noimg"></span>') + `<span><b>${esc(r.name)}</b><small>${new Date(r.ts).toLocaleString()}</small></span>`;
    b.onclick = () => { closeRecentDD(); openRecent(r.id, "doc"); };
    dd.appendChild(b);
  }
  const all = document.createElement("a"); all.className = "all"; all.href = "#/recent"; all.textContent = "See all recent files · scan for files you built"; all.onclick = closeRecentDD; dd.appendChild(all);
  const bl = document.createElement("a"); bl.className = "all"; bl.href = BUILDER_URL; bl.target = "_blank"; bl.rel = "noopener"; bl.textContent = "Open document builder ↗"; bl.onclick = closeRecentDD; dd.appendChild(bl);
}
function closeRecentDD() { $("recent_dd").classList.remove("open"); $("top_recent").setAttribute("aria-expanded", "false"); }
$("top_recent").onclick = async (e) => { e.stopPropagation(); const dd = $("recent_dd"); if (dd.classList.contains("open")) { closeRecentDD(); return; } await renderRecentDD(); dd.classList.add("open"); $("top_recent").setAttribute("aria-expanded", "true"); };
document.addEventListener("click", (e) => { if (!e.target.closest("#recent_dd") && !e.target.closest("#top_recent")) closeRecentDD(); });
// Files dropped onto the PDF tools' page area join the open set; onto the editor, a
// picture is inserted on the page and a PDF opens in place of the current one.
const stage = $("stage");
stage.addEventListener("dragover", (e) => { if (document.body.dataset.route === "work") e.preventDefault(); });
stage.addEventListener("drop", async (e) => {
  if (document.body.dataset.route !== "work") return;
  e.preventDefault();
  const files = [...(e.dataTransfer.files || [])]; if (!files.length) return;
  const mode = document.body.dataset.work;
  if (mode === "pdf") { const add = files.filter((x) => isPdf(x) || isImage(x)); if (add.length) window.__cal2AddPdfFiles(add); return; }
  if (mode === "doc") {
    // a picture dropped on a page goes on that page; PDFs are added to the document
    if (files.length === 1 && isImage(files[0]) && e.target.closest && e.target.closest(".pg") && window.__cal2InsertImageFile) { window.__cal2InsertImageFile(files[0]); return; }
    const add = files.filter((x) => isPdf(x) || isImage(x)); if (add.length) window.__cal2AddFilesToDoc(add);
    return;
  }
  const f = files.find((x) => isPdf(x) || isImage(x)); if (f) { await window.__cal2OpenDocFile(f); go("#/edit"); }
});
window.addEventListener("hashchange", route);
route();
