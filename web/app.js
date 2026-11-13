// Calligrapher 2.0 front-end. Rust/WASM engine + document signing + scan finish.
// WASM C ABI: alloc / dealloc / generate / result_ptr + linear `memory`.

const WASM_URL = "./calligrapher2.wasm";
let wasm = null;
const enc = new TextEncoder();
const dec = new TextDecoder();
const $ = (id) => document.getElementById(id);
const sheet = $("sheet");
const errEl = $("err");

async function loadWasm() {
  const res = await fetch(WASM_URL);
  const out = WebAssembly.instantiateStreaming
    ? await WebAssembly.instantiateStreaming(res, {})
    : await WebAssembly.instantiate(await res.arrayBuffer(), {});
  wasm = out.instance.exports;
}
function splitSeed(seed) {
  const s = BigInt(Math.abs(Math.floor(seed)) || 0) & 0xffffffffffffffffn;
  return [Number(s & 0xffffffffn) >>> 0, Number((s >> 32n) & 0xffffffffn) >>> 0];
}
function engineSVG(text, p) {
  const bytes = enc.encode(text);
  const inPtr = wasm.alloc(bytes.length || 1);
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
  const [lo, hi] = splitSeed(p.seed);
  const len = wasm.generate(
    inPtr, bytes.length, p.width, p.height, p.font_px, p.slant_deg, p.variation,
    p.weight, p.contrast, p.spacing, p.line_spacing, p.align, p.tilt, p.vary,
    p.inkflow, p.natural, p.caps_cursive, lo, hi
  );
  const svg = dec.decode(new Uint8Array(wasm.memory.buffer, wasm.result_ptr(), len));
  wasm.dealloc(inPtr, bytes.length || 1);
  return svg;
}

const INKS = ["#1b1b1f", "#1d3a8a", "#0b7285", "#6d1a36", "#2b2320", "#111"];
const PAPERS = ["#fbfaf6", "#fff8e7", "#eef3f8", "#f3eee4", "#ffffff", "#12151c"];
const TEXTURES = [
  { name: "None", f: 0, o: 1, t: "fractalNoise" },
  { name: "Fiber", f: 0.9, o: 2, t: "fractalNoise" },
  { name: "Grain", f: 0.5, o: 3, t: "fractalNoise" },
  { name: "Cold press", f: 0.16, o: 2, t: "fractalNoise" },
  { name: "Canvas", f: 0.08, o: 1, t: "turbulence" },
  { name: "Crumple", f: 0.035, o: 4, t: "fractalNoise" },
];
const STYLES = {
  Casual:    { slant: 9,  contrast: 55, spacing: 4, line: 108, legibility: 60, thickness: 36, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 } },
  Formal:    { slant: 18, contrast: 78, spacing: 2, line: 120, legibility: 78, thickness: 30, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 } },
  Neat:      { slant: 6,  contrast: 48, spacing: 3, line: 110, legibility: 92, thickness: 32, t: { vary: 0, natural: 0, inkflow: 1, tilt: 0 } },
  Scrawl:    { slant: 4,  contrast: 45, spacing: 6, line: 104, legibility: 25, thickness: 42, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 } },
  Marker:    { slant: 6,  contrast: 10, spacing: 8, line: 116, legibility: 55, thickness: 70, t: { vary: 1, natural: 1, inkflow: 0, tilt: 0 } },
  Signature: { slant: 24, contrast: 72, spacing: 1, line: 120, legibility: 18, thickness: 40, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 } },
};

let ink = INKS[0], paper = PAPERS[0], texIdx = 1, align = 0, mode = "writing";
const toggles = { vary: true, natural: true, inkflow: true, tilt: false, cursivecaps: false, transparent: false, scanned: false };

// document background + placement
let doc = null;            // { img:Image, w, h, type }
let pdfDocCache = null;    // loaded pdfjs document
let place = { x: 40, y: 40, scale: 1 }; // overlay top-left (display px) + user scale

// ---- swatches / toggles --------------------------------------------------

function markSel(host, el) { [...host.querySelectorAll(".sw")].forEach(x => x.classList.remove("sel")); if (el) el.classList.add("sel"); }
function buildSwatches() {
  const mk = (host, list, cur, set) => {
    host.innerHTML = "";
    list.forEach((c) => {
      const b = document.createElement("div");
      b.className = "sw" + (cur() === c ? " sel" : "");
      b.style.background = c;
      b.onclick = () => { set(c); markSel(host, b); render(); };
      host.appendChild(b);
    });
    const picker = document.createElement("input");
    picker.type = "color"; picker.value = cur();
    picker.oninput = () => { set(picker.value); markSel(host, null); render(); };
    host.appendChild(picker);
  };
  mk($("ink"), INKS, () => ink, (c) => ink = c);
  mk($("paper"), PAPERS, () => paper, (c) => paper = c);
  buildTextures();
}
function buildTextures() {
  const host = $("textures"); host.innerHTML = "";
  TEXTURES.forEach((tx, i) => {
    const b = document.createElement("div");
    b.className = "sw sq" + (i === texIdx ? " sel" : "");
    b.title = tx.name; b.style.backgroundColor = "#efede7";
    if (tx.f > 0) b.style.backgroundImage = textureURL(i, 55);
    b.onclick = () => { texIdx = i; markSel(host, b); render(); };
    host.appendChild(b);
  });
}
function textureURL(i, intensity) {
  const tx = TEXTURES[i];
  if (!tx || tx.f === 0) return "";
  const a = Math.max(0, Math.min(0.75, intensity / 100));
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='170' height='170'>` +
    `<filter id='n'><feTurbulence type='${tx.t}' baseFrequency='${tx.f}' numOctaves='${tx.o}' stitchTiles='stitch'/>` +
    `<feColorMatrix type='matrix' values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${a.toFixed(3)} 0'/></filter>` +
    `<rect width='100%' height='100%' filter='url(#n)'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
document.querySelectorAll(".sw-toggle").forEach((el) => {
  el.onclick = () => {
    const k = el.dataset.k; toggles[k] = !toggles[k]; el.classList.toggle("on", toggles[k]);
    if (k === "tilt" && toggles.tilt) { toggles.natural = false; syncToggles(); }
    render();
  };
});
function syncToggles() { document.querySelectorAll(".sw-toggle").forEach((el) => el.classList.toggle("on", !!toggles[el.dataset.k])); }

$("align").querySelectorAll("button").forEach((b) => { b.onclick = () => { align = parseFloat(b.dataset.a); $("align").querySelectorAll("button").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); render(); }; });
$("mode").querySelectorAll("button").forEach((b) => {
  b.onclick = () => { mode = b.dataset.m; $("mode").querySelectorAll("button").forEach(x => x.classList.remove("sel")); b.classList.add("sel"); if (mode === "signature") applyStyle("Signature"); else render(false); };
});

function applyStyle(name) {
  let key = name;
  if (name === "random") { const k = Object.keys(STYLES); key = k[Math.floor(Math.random() * k.length)]; $("seed").value = Math.floor(Math.random() * 1e9); }
  const s = STYLES[key]; if (!s) return;
  $("slant").value = s.slant; $("contrast").value = s.contrast; $("spacing").value = s.spacing;
  $("line_spacing").value = s.line; $("legibility").value = s.legibility; $("thickness").value = s.thickness;
  Object.assign(toggles, { vary: !!s.t.vary, natural: !!s.t.natural, inkflow: !!s.t.inkflow, tilt: !!s.t.tilt });
  syncToggles(); render(false);
}

// ---- params --------------------------------------------------------------

const LABELS = {
  speed: v => v + "%", legibility: v => v + "%", thickness: v => (v / 10).toFixed(1),
  font_px: v => v, slant: v => v + "°", contrast: v => v + "%", spacing: v => (v / 100).toFixed(2),
  line_spacing: v => (v / 100).toFixed(2), tex_intensity: v => v + "%", blemish: v => v + "%",
  blur: v => v / 10 + "px", sharpen: v => v + "%", resolution: v => v + "×", place_scale: v => v + "%",
};
function refreshLabels() { for (const id in LABELS) { const el = $(id + "_v"); if (el && $(id)) el.textContent = LABELS[id](+$(id).value); } }

function textForEngine() {
  const raw = $("text").value;
  return mode === "signature" ? raw.replace(/\s*\n\s*/g, " ").trim() : raw;
}
function params(forWidth) {
  const leg = +$("legibility").value / 100;
  return {
    width: forWidth, height: 0,
    font_px: +$("font_px").value, slant_deg: +$("slant").value,
    variation: (1 - leg) * 0.95, weight: +$("thickness").value / 10,
    contrast: +$("contrast").value / 100, spacing: +$("spacing").value / 100,
    line_spacing: +$("line_spacing").value / 100, align,
    tilt: toggles.tilt ? 0.6 : 0, vary: toggles.vary ? 0.8 : 0,
    inkflow: toggles.inkflow ? 0.85 : 0, natural: toggles.tilt ? 0 : (toggles.natural ? 0.7 : 0),
    caps_cursive: (mode === "signature" || toggles.cursivecaps) ? 1 : 0,
    seed: +$("seed").value,
  };
}

// Append flourish swashes under a signature: a looping underline + lead-in curl.
function addFlourish(svg) {
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 800;
  const h = +(svg.match(/height="(\d+)"/) || [])[1] || 200;
  const base = h * 0.70, sw = Math.max(1.6, +$("thickness").value / 16);
  const under =
    `M ${w * 0.14} ${base} C ${w * 0.04} ${base + h * 0.15}, ${w * 0.5} ${base + h * 0.16}, ${w * 0.80} ${base - h * 0.02} ` +
    `S ${w * 1.03} ${base - h * 0.12}, ${w * 0.90} ${base + h * 0.06} ` +
    `S ${w * 0.72} ${base + h * 0.02}, ${w * 0.82} ${base - h * 0.05}`;
  const lead = `M ${w * 0.02} ${base - h * 0.04} q ${w * 0.05} ${-h * 0.13}, ${w * 0.11} ${-h * 0.02}`;
  const paths =
    `<path d="${under}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<path d="${lead}" fill="none" stroke="currentColor" stroke-width="${(sw * 0.85).toFixed(2)}" stroke-linecap="round"/>`;
  return svg.replace("</g></svg>", paths + "</g></svg>");
}

function previewFilter() {
  const blur = +$("blur").value / 10, sh = +$("sharpen").value / 100;
  const parts = [];
  if (blur > 0) parts.push(`blur(${blur}px)`);
  if (sh > 0) parts.push(`contrast(${(1 + sh * 0.6).toFixed(2)}) saturate(${(1 + sh * 0.1).toFixed(2)})`);
  if (toggles.scanned) parts.push("contrast(1.05) brightness(0.99)");
  return parts.join(" ");
}

// ---- render --------------------------------------------------------------

let rawSVG = "", hwW = 800, hwH = 300;
function makeHandwriting(forWidth) {
  let svg = engineSVG(textForEngine(), params(forWidth));
  if (mode === "signature") svg = addFlourish(svg);
  svg = svg.replace("<svg ", `<svg style="color:${ink}" `);
  hwW = +(svg.match(/width="(\d+)"/) || [800])[1];
  hwH = +(svg.match(/height="(\d+)"/) || [300])[1];
  return svg;
}

function paperCSS() {
  const guide = $("paper_style").value, imgs = [], sizes = [];
  if (guide === "ruled") { imgs.push("linear-gradient(to bottom,transparent 0,transparent calc(100% - 1px),#9ab7d422 100%)"); sizes.push("100% 2.3em"); }
  if (guide === "grid") { imgs.push("linear-gradient(to bottom,transparent 0,transparent calc(100% - 1px),#9ab7d422 100%)", "linear-gradient(to right,transparent 0,transparent calc(100% - 1px),#9ab7d418 100%)"); sizes.push("100% 2.3em", "2.3em 100%"); }
  const tex = textureURL(texIdx, +$("tex_intensity").value);
  if (tex) { imgs.push(tex); sizes.push("170px 170px"); }
  return { bg: paper, img: imgs.join(","), size: sizes.join(",") };
}

function render(animate = false) {
  if (!wasm) return;
  refreshLabels();
  try {
    if (doc) return renderDoc();
    sheet.className = "sheet";
    const stage = sheet.parentElement.getBoundingClientRect();
    const width = Math.max(480, Math.min(1600, stage.width - 48));
    rawSVG = makeHandwriting(width);
    sheet.innerHTML = animate ? animateSVG(rawSVG) : rawSVG;
    const pc = paperCSS();
    sheet.style.background = pc.bg; sheet.style.backgroundImage = pc.img; sheet.style.backgroundSize = pc.size;
    sheet.style.filter = previewFilter();
    sheet.style.width = ""; sheet.style.height = "";
    errEl.textContent = ""; syncHash();
  } catch (e) { errEl.textContent = "Render error: " + (e.message || e); }
}

// Document mode: page image + draggable handwriting overlay.
function renderDoc() {
  sheet.className = "sheet doc";
  const stage = sheet.parentElement.getBoundingClientRect();
  const dispW = Math.min(doc.w, stage.width - 48);
  const dispH = dispW * doc.h / doc.w;
  rawSVG = makeHandwriting(Math.round(doc.w * 0.6));
  sheet.innerHTML =
    `<img id="docbg" src="${doc.url}" style="width:${dispW}px;height:${dispH}px"/>` +
    `<div id="overlay"></div><div class="hint">Drag the writing to position it</div>`;
  const ov = $("overlay");
  const s = (place.scale) * (dispW / hwW) * 0.5;
  ov.style.transform = `translate(${place.x}px,${place.y}px) scale(${s})`;
  ov.innerHTML = rawSVG;
  ov.style.filter = previewFilter();
  sheet.style.filter = toggles.scanned ? "contrast(1.05)" : "";
  sheet.style.width = dispW + "px"; sheet.style.height = dispH + "px";
  sheet.style.background = "transparent"; sheet.style.backgroundImage = "";
  enableDrag(ov, dispW, dispH);
  errEl.textContent = ""; syncHash();
}
function enableDrag(ov, dispW, dispH) {
  let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
  ov.onpointerdown = (e) => { dragging = true; ov.classList.add("drag"); ov.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = place.x; oy = place.y; };
  ov.onpointermove = (e) => {
    if (!dragging) return;
    place.x = Math.max(-40, Math.min(dispW, ox + (e.clientX - sx)));
    place.y = Math.max(-40, Math.min(dispH, oy + (e.clientY - sy)));
    const s = place.scale * (dispW / hwW) * 0.5;
    ov.style.transform = `translate(${place.x}px,${place.y}px) scale(${s})`;
  };
  ov.onpointerup = () => { dragging = false; ov.classList.remove("drag"); syncHash(); };
}

function animateSVG(svg) {
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 800, h = +(svg.match(/height="(\d+)"/) || [])[1] || 300;
  const speed = +$("speed").value; if (speed <= 0) return svg;
  const dur = (6.5 - speed / 100 * 5.3).toFixed(2);
  const defs = `<defs><clipPath id="wo"><rect x="0" y="0" width="0" height="${h}"><animate attributeName="width" from="0" to="${w}" dur="${dur}s" fill="freeze"/></rect></clipPath></defs>`;
  return svg.replace("><g>", `>${defs}<g clip-path="url(#wo)">`);
}

// ---- document upload -----------------------------------------------------

$("upload_btn").onclick = () => $("file").click();
$("file").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  errEl.textContent = "Loading document…";
  try {
    if (f.type === "application/pdf") { await loadPDF(await f.arrayBuffer()); }
    else { await loadImage(URL.createObjectURL(f)); }
    $("doc_controls").style.display = ""; place = { x: 40, y: 40, scale: 1 };
    errEl.textContent = ""; render();
  } catch (err) { errEl.textContent = "Could not open that file: " + (err.message || err); }
};
async function loadImage(url) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  doc = { img, w: img.naturalWidth, h: img.naturalHeight, url, type: "image" };
  $("pdf_pages").textContent = "";
}
async function loadPDF(buf) {
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  pdfDocCache = await pdfjsLib.getDocument({ data: buf }).promise;
  $("pdf_page").max = pdfDocCache.numPages; $("pdf_pages").textContent = "of " + pdfDocCache.numPages;
  await renderPdfPage(+$("pdf_page").value || 1);
}
async function renderPdfPage(n) {
  const page = await pdfDocCache.getPage(Math.max(1, Math.min(pdfDocCache.numPages, n)));
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  const url = c.toDataURL("image/png");
  const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = url; });
  doc = { img, w: img.naturalWidth, h: img.naturalHeight, url, type: "pdf" };
}
$("pdf_page").onchange = async () => { if (pdfDocCache) { await renderPdfPage(+$("pdf_page").value); render(); } };
$("place_scale").oninput = () => { place.scale = +$("place_scale").value / 100; render(); };
$("clear_doc").onclick = () => { doc = null; pdfDocCache = null; $("doc_controls").style.display = "none"; $("pdf_pages").textContent = ""; render(); };

// ---- export pipeline -----------------------------------------------------

function svgToImage(svg) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => { res(img); };
    img.onerror = rej; img.src = url;
  });
}
// Apply blur/sharpen/scanned/blemish to a finished canvas.
function finishCanvas(c) {
  const ctx = c.getContext("2d");
  const blur = +$("blur").value / 10, sh = +$("sharpen").value / 100, blem = +$("blemish").value / 100;
  if (blur > 0) { const t = document.createElement("canvas"); t.width = c.width; t.height = c.height; const tx = t.getContext("2d"); tx.drawImage(c, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.filter = `blur(${blur * (c.width / 800)}px)`; ctx.drawImage(t, 0, 0); ctx.filter = "none"; }
  if (sh > 0) unsharp(ctx, c.width, c.height, sh);
  if (toggles.scanned) scanEffects(ctx, c.width, c.height, blem);
  return c;
}
function unsharp(ctx, w, h, amt) {
  const src = ctx.getImageData(0, 0, w, h), out = ctx.createImageData(w, h);
  const d = src.data, o = out.data, k = amt * 0.8;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = (y * w + x) * 4;
    for (let c = 0; c < 3; c++) {
      const lap = 4 * d[i + c] - d[i - 4 + c] - d[i + 4 + c] - d[i - w * 4 + c] - d[i + w * 4 + c];
      o[i + c] = Math.max(0, Math.min(255, d[i + c] + k * lap));
    }
    o[i + 3] = d[i + 3];
  }
  ctx.putImageData(out, 0, 0);
}
function scanEffects(ctx, w, h, blem) {
  // vignette
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(1, `rgba(20,16,10,${0.12 + blem * 0.12})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  // speckle blemishes
  const n = Math.floor(blem * (w * h) / 6000);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = Math.random() * 1.6 + 0.3;
    ctx.fillStyle = Math.random() < 0.5 ? `rgba(40,30,20,${Math.random() * 0.25})` : `rgba(255,255,255,${Math.random() * 0.2})`;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }
}

async function composeCanvas() {
  const res = +$("resolution").value;
  if (doc) {
    const W = Math.round(doc.w * res), H = Math.round(doc.h * res);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(doc.img, 0, 0, W, H);
    const stage = sheet.parentElement.getBoundingClientRect();
    const dispW = Math.min(doc.w, stage.width - 48);
    const toExport = (doc.w / dispW) * res;           // display px -> export px
    const s = place.scale * (dispW / hwW) * 0.5 * toExport;
    const hwImg = await svgToImage(rawSVG);
    ctx.drawImage(hwImg, place.x * toExport, place.y * toExport, hwW * s, hwH * s);
    return finishCanvas(c);
  }
  // no document: handwriting on paper
  const res2 = res, W = Math.round(hwW * res2), H = Math.round(hwH * res2);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!toggles.transparent) { ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H); }
  const hwImg = await svgToImage(rawSVG);
  ctx.drawImage(hwImg, 0, 0, W, H);
  return finishCanvas(c);
}

function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }
async function exportPNG() { try { (await composeCanvas()).toBlob((b) => { download("calligraphy.png", b); flash("Saved PNG."); }, "image/png"); } catch (e) { errEl.textContent = "PNG export failed: " + (e.message || e); } }
async function exportPDF() {
  try {
    const c = await composeCanvas();
    const { jsPDF } = window.jspdf;
    const landscape = c.width > c.height;
    const pdf = new jsPDF({ orientation: landscape ? "l" : "p", unit: "pt", format: [c.width / 2, c.height / 2] });
    pdf.addImage(c.toDataURL("image/png"), "PNG", 0, 0, c.width / 2, c.height / 2);
    pdf.save("calligraphy.pdf"); flash("Saved PDF.");
  } catch (e) { errEl.textContent = "PDF export failed: " + (e.message || e); }
}
function exportSVG() { download("calligraphy.svg", new Blob([mode === "signature" || +$("speed").value ? animateSVG(rawSVG) : rawSVG], { type: "image/svg+xml" })); flash("Saved SVG."); }

// ---- share links ---------------------------------------------------------

function st() {
  return { t: $("text").value, md: mode, sty: $("style").value, sp: +$("speed").value, lg: +$("legibility").value, th: +$("thickness").value,
    fp: +$("font_px").value, sl: +$("slant").value, ct: +$("contrast").value, spc: +$("spacing").value, ln: +$("line_spacing").value,
    al: align, sd: +$("seed").value, i: ink, p: paper, tx: texIdx, ti: +$("tex_intensity").value, ps: $("paper_style").value,
    tg: toggles, bl: +$("blur").value, shp: +$("sharpen").value, rs: +$("resolution").value, bm: +$("blemish").value };
}
function syncHash() { try { history.replaceState(null, "", "#" + btoa(encodeURIComponent(JSON.stringify(st())))); } catch {} }
function applyState(s) {
  if (!s) return; const set = (id, v) => { if (v != null && $(id)) $(id).value = v; };
  $("text").value = s.t ?? $("text").value;
  set("style", s.sty); set("speed", s.sp); set("legibility", s.lg); set("thickness", s.th); set("font_px", s.fp);
  set("slant", s.sl); set("contrast", s.ct); set("spacing", s.spc); set("line_spacing", s.ln); set("seed", s.sd);
  set("paper_style", s.ps); set("tex_intensity", s.ti); set("blur", s.bl); set("sharpen", s.shp); set("resolution", s.rs); set("blemish", s.bm);
  if (s.i) ink = s.i; if (s.p) paper = s.p; if (s.tx != null) texIdx = s.tx; if (s.md) mode = s.md;
  if (s.al != null) { align = s.al; $("align").querySelectorAll("button").forEach(x => x.classList.toggle("sel", parseFloat(x.dataset.a) === align)); }
  if (s.tg) { Object.assign(toggles, s.tg); syncToggles(); }
  $("mode").querySelectorAll("button").forEach(x => x.classList.toggle("sel", x.dataset.m === mode));
}
function loadHash() { if (!location.hash.length) return; try { applyState(JSON.parse(decodeURIComponent(atob(location.hash.slice(1))))); } catch {} }
async function copyLink() { syncHash(); try { await navigator.clipboard.writeText(location.href); flash("Shareable link copied."); } catch { errEl.textContent = "Copy the URL from the address bar."; } }
function flash(m) { errEl.textContent = m; errEl.className = "err ok"; setTimeout(() => { errEl.textContent = ""; errEl.className = "err"; }, 1800); }

// ---- boot ----------------------------------------------------------------

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderD = debounce(() => render(false), 90);
(async function () {
  buildSwatches();
  try { await loadWasm(); } catch (e) { errEl.textContent = "Could not load the WASM engine (" + e.message + ")."; return; }
  loadHash(); buildSwatches();
  ["speed", "legibility", "thickness", "font_px", "slant", "contrast", "spacing", "line_spacing", "tex_intensity", "blur", "sharpen", "resolution", "blemish"].forEach((id) => $(id).addEventListener("input", renderD));
  $("text").addEventListener("input", debounce(() => render(true), 160));
  $("seed").addEventListener("input", renderD);
  $("style").addEventListener("change", () => applyStyle($("style").value));
  $("paper_style").addEventListener("change", () => render());
  $("reroll").addEventListener("click", () => { $("seed").value = Math.floor(Math.random() * 1e9); render(true); });
  $("png").addEventListener("click", exportPNG);
  $("pdf").addEventListener("click", exportPDF);
  $("svg").addEventListener("click", exportSVG);
  $("share").addEventListener("click", copyLink);
  window.addEventListener("resize", renderD);
  render(false);
})();
