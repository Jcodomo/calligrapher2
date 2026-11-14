// pdfedit.js — "PDF editor" mode for Calligrapher 2. Pulls the most-used
// Stirling-PDF page operations into the browser: reorder (drag), rotate,
// duplicate, delete, merge, extract, page numbers and a text watermark.
// 100% client-side — pdf.js renders thumbnails, pdf-lib writes the edited PDF.
// Nothing is uploaded.

const $ = (id) => document.getElementById(id);

let sources = [];          // { id, name, bytes:Uint8Array }
let pages = [];            // { srcId, srcIndex, rot }   rot ∈ {0,90,180,270}
const selected = new Set();// indices into `pages`
const jsDocs = new Map();  // srcId -> pdf.js document (for thumbnails)
const thumbCache = new Map();
let srcSeq = 1, dragFrom = -1;

const pdfjs = () => window.pdfjsLib;
const PDFLib = () => window.PDFLib;

function dl(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function note(msg, bad) {
  const e = $("pe_err"); if (!e) return;
  e.textContent = msg; e.className = "err" + (bad ? "" : " ok");
  if (!bad) setTimeout(() => { if (e.textContent === msg) e.textContent = ""; }, 2200);
}

async function jsDoc(src) {
  if (jsDocs.has(src.id)) return jsDocs.get(src.id);
  const d = await pdfjs().getDocument({ data: src.bytes.slice() }).promise; // slice: keep bytes intact for export
  jsDocs.set(src.id, d); return d;
}

async function addFiles(fileList) {
  let added = 0;
  for (const f of fileList) {
    if (f.type !== "application/pdf" && !/\.pdf$/i.test(f.name)) continue;
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const id = "src" + srcSeq++;
      sources.push({ id, name: f.name, bytes });
      const d = await jsDoc(sources[sources.length - 1]);
      for (let i = 0; i < d.numPages; i++) pages.push({ srcId: id, srcIndex: i, rot: 0 });
      added += d.numPages;
    } catch (e) { note("Could not open " + f.name + ": " + (e.message || e), true); }
  }
  if (added) {
    $("pe_tools").style.display = ""; $("pe_finish").style.display = "";
    renderGrid();
  }
}

async function thumb(entry, scale = 0.36) {
  const key = entry.srcId + "|" + entry.srcIndex + "|" + entry.rot;
  if (thumbCache.has(key)) return thumbCache.get(key);
  const src = sources.find((s) => s.id === entry.srcId);
  const d = await jsDoc(src);
  const page = await d.getPage(entry.srcIndex + 1);
  const rotation = ((page.rotate || 0) + entry.rot) % 360;
  const vp = page.getViewport({ scale, rotation });
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.ceil(vp.width)); c.height = Math.max(1, Math.ceil(vp.height));
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
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
    d.draggable = true; d.dataset.idx = String(idx);
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
    d.addEventListener("dragstart", () => { dragFrom = idx; });
    d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("drop"); });
    d.addEventListener("dragleave", () => d.classList.remove("drop"));
    d.addEventListener("drop", (e) => { e.preventDefault(); d.classList.remove("drop"); reorder(dragFrom, idx); });
    stage.appendChild(d);
    thumb(entry).then((url) => {
      const ph = d.querySelector(".pe-ph");
      if (ph) { const img = new Image(); img.src = url; img.draggable = false; ph.replaceWith(img); }
    }).catch(() => {});
  });
}

function act(a, idx) {
  const p = pages[idx]; if (!p) return;
  if (a === "rl") p.rot = (p.rot + 270) % 360;
  else if (a === "rr") p.rot = (p.rot + 90) % 360;
  else if (a === "dup") { pages.splice(idx + 1, 0, { ...p }); selected.clear(); }
  else if (a === "del") { pages.splice(idx, 1); selected.clear(); }
  renderGrid();
}
function reorder(from, to) {
  if (from < 0 || from === to || from >= pages.length) return;
  const [m] = pages.splice(from, 1);
  pages.splice(to, 0, m);
  selected.clear(); dragFrom = -1; renderGrid();
}
function rotateAll(dir) { pages.forEach((p) => p.rot = (p.rot + (dir < 0 ? 270 : 90)) % 360); renderGrid(); }
function deleteSel() {
  if (!selected.size) { note("Tick some pages first.", true); return; }
  pages = pages.filter((_, i) => !selected.has(i)); selected.clear(); renderGrid();
}
function selectAll() {
  if (selected.size === pages.length) selected.clear();
  else pages.forEach((_, i) => selected.add(i));
  renderGrid();
}

// Build a new PDF (pdf-lib) from the given page entries, preserving vector content
// and applying each page's accumulated rotation.
async function buildPdf(entries) {
  const L = PDFLib();
  const out = await L.PDFDocument.create();
  const libCache = new Map();
  for (const e of entries) {
    const src = sources.find((s) => s.id === e.srcId);
    let lib = libCache.get(src.id);
    if (!lib) { lib = await L.PDFDocument.load(src.bytes); libCache.set(src.id, lib); }
    const [cp] = await out.copyPages(lib, [e.srcIndex]);
    const base = (cp.getRotation() && cp.getRotation().angle) || 0;
    cp.setRotation(L.degrees((base + e.rot) % 360));
    out.addPage(cp);
  }
  return out;
}

async function stampAndSave(out, filename) {
  const L = PDFLib();
  const wm = ($("pe_wm").value || "").trim();
  const nums = $("pe_nums").checked;
  if (nums || wm) {
    const font = await out.embedFont(L.StandardFonts.HelveticaBold);
    const pos = $("pe_numpos").value;
    out.getPages().forEach((pg, i) => {
      const { width, height } = pg.getSize();
      if (wm) {
        const sz = Math.min(width, height) * 0.14;
        const tw = font.widthOfTextAtSize(wm, sz);
        // Centre the diagonal baseline: step back along the 45° direction by half the text width.
        const dx = Math.cos(Math.PI / 4) * tw / 2, dy = Math.sin(Math.PI / 4) * tw / 2;
        pg.drawText(wm, {
          x: width / 2 - dx, y: height / 2 - dy,
          size: sz, font, color: L.rgb(0.5, 0.5, 0.5), rotate: L.degrees(45), opacity: 0.16,
        });
      }
      if (nums) {
        const t = String(i + 1), sz = 11, tw = font.widthOfTextAtSize(t, sz);
        let x = width / 2 - tw / 2, y = 20;
        if (pos === "br") x = width - tw - 26;
        else if (pos === "bl") x = 26;
        if (pos === "tc") y = height - 26;
        pg.drawText(t, { x, y, size: sz, font, color: L.rgb(0.12, 0.12, 0.12) });
      }
    });
  }
  const bytes = await out.save();
  dl(filename, new Blob([bytes], { type: "application/pdf" }));
}

async function exportPdf() {
  if (!pages.length) { note("Nothing to export.", true); return; }
  try { await stampAndSave(await buildPdf(pages), "edited.pdf"); note("Saved edited.pdf (" + pages.length + " pages)."); }
  catch (e) { note("Export failed: " + (e.message || e), true); }
}
async function extractSel() {
  const entries = pages.filter((_, i) => selected.has(i));
  if (!entries.length) { note("Tick the pages to extract first.", true); return; }
  try { await stampAndSave(await buildPdf(entries), "extracted.pdf"); note("Extracted " + entries.length + " page(s)."); }
  catch (e) { note("Extract failed: " + (e.message || e), true); }
}

export function initPdfEditor() {
  // pdf.js needs its worker configured before it can render thumbnails.
  const pj = pdfjs();
  if (pj && pj.GlobalWorkerOptions && !pj.GlobalWorkerOptions.workerSrc)
    pj.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const open = () => $("pe_file") && $("pe_file").click();
  $("pe_open") && ($("pe_open").onclick = open);
  $("pe_merge") && ($("pe_merge").onclick = open);
  $("pe_file") && ($("pe_file").onchange = async (e) => { await addFiles(e.target.files); e.target.value = ""; });
  $("pe_rot_l") && ($("pe_rot_l").onclick = () => rotateAll(-1));
  $("pe_rot_r") && ($("pe_rot_r").onclick = () => rotateAll(1));
  $("pe_selall") && ($("pe_selall").onclick = selectAll);
  $("pe_del_sel") && ($("pe_del_sel").onclick = deleteSel);
  $("pe_extract") && ($("pe_extract").onclick = extractSel);
  $("pe_export") && ($("pe_export").onclick = exportPdf);
  renderGrid();
}
