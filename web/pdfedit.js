// pdfedit.js — "PDF editor" mode for Calligrapher 2. A Stirling-PDF-style tool
// grid, implemented entirely in the browser (pdf.js + pdf-lib, with JSZip and
// tesseract.js lazy-loaded on demand). Nothing is uploaded.
//
// Tools that genuinely need a server (Office conversions, Translate, generic
// convert, password-encryption) are shown with a clear explanation instead of a
// broken button — Stirling runs those on a backend (LibreOffice / Tesseract), which
// a static site can't do. Everything else runs locally.

const $ = (id) => document.getElementById(id);

let sources = [];          // { id, name, bytes:Uint8Array }
let pages = [];            // { srcId, srcIndex, rot, red:[{x,y,w,h}] }  rot ∈ {0,90,180,270}
const selected = new Set();// indices into `pages`
const jsDocs = new Map();  // srcId -> pdf.js document
const thumbCache = new Map();
let srcSeq = 1, dragFrom = -1, redactMode = false, activeTool = null;

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
  if (!bad) setTimeout(() => { if (e.textContent === msg) e.textContent = ""; }, 2600);
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
async function addFiles(fileList) {
  let added = 0;
  for (const f of fileList) {
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) continue;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const id = "src" + srcSeq++;
      sources.push({ id, name: f.name, bytes });
      const d = await jsDoc(sources[sources.length - 1]);
      for (let i = 0; i < d.numPages; i++) pages.push({ srcId: id, srcIndex: i, rot: 0, red: [] });
      added += d.numPages;
    } catch (e) { note("Could not open " + f.name + ": " + (e.message || e), true); }
  }
  if (added) { $("pe_toolswrap").style.display = ""; buildGrid(); renderGrid(); }
}
function pickFiles(accept, multiple, cb) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = accept; inp.multiple = !!multiple;
  inp.onchange = () => { if (inp.files && inp.files.length) cb(inp.files); };
  inp.click();
}

// ---- thumbnail grid (the page workspace) -----------------------------------
async function thumb(entry, scale = 0.36) {
  const key = entry.srcId + "|" + entry.srcIndex + "|" + entry.rot;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const c = await rasterize(entry, scale);
  const url = c.toDataURL("image/jpeg", 0.72);
  thumbCache.set(key, url); return url;
}
function renderGrid() {
  const stage = $("pdfedit_stage"); if (!stage) return;
  if (!pages.length) {
    stage.innerHTML = '<div style="margin:auto;color:var(--muted);font-size:14px">No PDF open yet — click “Open PDF(s)”.</div>';
    return;
  }
  stage.innerHTML = "";
  pages.forEach((entry, idx) => {
    const d = document.createElement("div");
    d.className = "pe-thumb" + (selected.has(idx) ? " sel" : "");
    d.draggable = !redactMode; d.dataset.idx = String(idx);
    d.innerHTML =
      '<div class="pe-ph">…</div>' +
      '<span class="pe-num">' + (idx + 1) + '</span>' +
      '<input type="checkbox" class="pe-chk"' + (selected.has(idx) ? " checked" : "") + '>' +
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
  else if (a === "del") { pages.splice(idx, 1); selected.clear(); }
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
    const pg = out.addPage([c.width, c.height]);
    pg.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
  }
  return out;
}
function dataURLtoU8(u) { const b = atob(u.split(",")[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
async function save(out, name) { const bytes = await out.save(); dl(name, new Blob([bytes], { type: "application/pdf" })); }

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
  { id: "edittext", name: "Edit Text", icon: "T", color: "#3aa0ff", kind: "action", run: () => openInSign() },
  { id: "split", name: "Split", icon: "✂", color: "#7c5cff", kind: "panel" },
  { id: "pdfword", name: "PDF ↔ Word", icon: "W", color: "#2b6cff", kind: "server" },
  { id: "img", name: "PDF ↔ Image", icon: "🖼", color: "#f0a500", kind: "panel" },
  { id: "translate", name: "Translate", icon: "文", color: "#2b6cff", kind: "server" },
  { id: "ocr", name: "PDF OCR", icon: "OCR", color: "#e8554e", kind: "panel" },
  { id: "sign", name: "Sign", icon: "✒", color: "#c86bff", kind: "action", run: () => openInSign() },
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
  if (window.__cal2OpenInSign) window.__cal2OpenInSign(buf);
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
  $("pe_toolhead").textContent = "Tools";
  $("pe_toolgrid").style.display = "";
  $("pe_toolpanel").innerHTML = "";
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

function openTool(t) {
  activeTool = t.id;
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
  else if (t.id === "unlock") openUnlock();
  else if (t.id === "redact") openRedact();
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
    const out = await rasterizeToPdf(pages, scale, q);
    await save(out, "compressed.pdf"); note("Saved compressed.pdf.");
  });
}
function openImg() {
  panelShell("PDF ↔ Image", `
    <div style="font-weight:600;font-size:12.5px;margin-bottom:4px">PDF → images</div>
    <div class="row"><label>Format</label><select id="pe_ifmt"><option value="png">PNG</option><option value="jpeg">JPEG</option></select></div>
    <div class="row"><label>Scale</label><input id="pe_iscale" type="range" min="1" max="4" step="1" value="2"><span class="val" id="pe_iscale_v">2×</span></div>
    <button class="btn" id="pe_img_go">Export pages → .zip</button>
    <div style="font-weight:600;font-size:12.5px;margin:14px 0 4px">Images → PDF</div>
    <button class="btn" id="pe_img2pdf">Pick images → PDF</button>`);
  $("pe_iscale").oninput = () => $("pe_iscale_v").textContent = $("pe_iscale").value + "×";
  $("pe_img_go").onclick = () => withBusy("Rendering…", async () => {
    const fmt = $("pe_ifmt").value, sc = +$("pe_iscale").value;
    const zip = new (await ensureJsZip())();
    for (let i = 0; i < pages.length; i++) {
      const c = await rasterize(pages[i], sc);
      const u8 = dataURLtoU8(c.toDataURL(fmt === "png" ? "image/png" : "image/jpeg", 0.9));
      zip.file(`page-${i + 1}.${fmt === "png" ? "png" : "jpg"}`, u8);
    }
    dl("pages.zip", await zip.generateAsync({ type: "blob" })); note("Saved pages.zip (" + pages.length + " images).");
  });
  $("pe_img2pdf").onclick = () => pickFiles("image/*", true, (files) => withBusy("Building…", async () => {
    const L = PDFLib(); const out = await L.PDFDocument.create();
    for (const f of files) {
      const u8 = new Uint8Array(await f.arrayBuffer());
      const img = /\.png$/i.test(f.name) || f.type === "image/png" ? await out.embedPng(u8) : await out.embedJpg(u8);
      const pg = out.addPage([img.width, img.height]); pg.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    await save(out, "images.pdf"); note("Saved images.pdf (" + files.length + " pages).");
  }));
}
function openOcr() {
  panelShell("PDF OCR", `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">Adds a searchable text layer under each page (runs in your browser — the first run downloads the language model, ~5–15&nbsp;MB, and large PDFs take a while).</div>
    <div class="row"><label>Language</label><select id="pe_oclang"><option value="eng">English</option><option value="spa">Spanish</option><option value="fra">French</option><option value="deu">German</option><option value="ita">Italian</option><option value="por">Portuguese</option></select></div>
    <button class="btn" id="pe_ocr_go">OCR → searchable PDF</button>
    <div id="pe_ocr_prog" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`);
  $("pe_ocr_go").onclick = () => withBusy("Starting OCR…", async () => {
    const T = await ensureTesseract();
    const lang = $("pe_oclang").value, prog = $("pe_ocr_prog");
    const L = PDFLib(); const out = await L.PDFDocument.create();
    const font = await out.embedFont(L.StandardFonts.Helvetica);
    const worker = await T.createWorker(lang, 1, { logger: (m) => { if (m.status === "recognizing text") prog.textContent = "Reading… " + Math.round(m.progress * 100) + "%"; } });
    for (let i = 0; i < pages.length; i++) {
      prog.textContent = `Page ${i + 1} / ${pages.length}…`;
      const c = await rasterize(pages[i], 2);
      const u8 = dataURLtoU8(c.toDataURL("image/jpeg", 0.85));
      const img = await out.embedJpg(u8);
      const pg = out.addPage([c.width, c.height]);
      pg.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
      const { data } = await worker.recognize(c);
      (data.words || []).forEach((w) => {
        if (!w.text.trim()) return;
        const bb = w.bbox, h = bb.y1 - bb.y0;
        try { pg.drawText(w.text, { x: bb.x0, y: c.height - bb.y1, size: Math.max(4, h * 0.8), font, opacity: 0 }); } catch (_) {}
      });
    }
    await worker.terminate();
    await save(out, "ocr.pdf"); prog.textContent = ""; note("Saved ocr.pdf (searchable).");
  });
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

// ---- boot ------------------------------------------------------------------
export function initPdfEditor() {
  const pj = pdfjs();
  if (pj && pj.GlobalWorkerOptions && !pj.GlobalWorkerOptions.workerSrc)
    pj.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const open = () => pickFiles("application/pdf", true, addFiles);
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
}
