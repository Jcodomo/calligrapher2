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

// ---- neural engine (Graves RNN, upstream pretrained weights) --------------
// Both tiers use this. The geometry (per-line strokes) is cached by text+bias+seed;
// styling (size, slant, thickness, ink, paper, animation, export) is applied cheaply
// on top and reuses the same SVG shape the procedural engine emits.
const neuralCache = new Map();
const nStatus = () => $("neural_status");

// Sampling runs in a Web Worker so the main thread never blocks.
let neuralWorker = null, neuralReqId = 0;
const neuralWaiters = new Map();
function getWorker() {
  if (neuralWorker) return neuralWorker;
  neuralWorker = new Worker("./neural-worker.js?v=1", { type: "module" });
  neuralWorker.onmessage = (e) => {
    const { id, type } = e.data;
    if (type === "status") { nStatus().textContent = e.data.msg === "loading" ? "Loading neural model (~15 MB, once)…" : ""; return; }
    const w = neuralWaiters.get(id); if (!w) return;
    neuralWaiters.delete(id);
    if (type === "result") w.resolve(e.data.lines); else w.reject(new Error(e.data.error || "sampling failed"));
  };
  neuralWorker.onerror = () => { nStatus().textContent = "Neural model unavailable (worker failed)."; };
  return neuralWorker;
}
function sampleLines(lines, bias, seed) {
  return new Promise((resolve, reject) => {
    const id = ++neuralReqId;
    neuralWaiters.set(id, { resolve, reject });
    getWorker().postMessage({ id, lines, bias, seed, baseUrl: "./model/" });
  });
}

function neuralBias() { return 0.2 + (+$("legibility").value / 100) * 1.25; } // legibility -> sampling bias

// smooth value noise for organic jitter / drift (mirrors the procedural engine)
function nhash(i) { let s = (i >>> 0) || 1; s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return (s / 4294967296) * 2 - 1; }
function vnoise(seed, x) {
  const xi = Math.floor(x), xf = x - xi;
  const a = nhash((Math.imul(xi, 374761393) ^ seed) >>> 0), b = nhash((Math.imul(xi + 1, 374761393) ^ seed) >>> 0);
  const t = xf * xf * (3 - 2 * xf);
  return a + (b - a) * t;
}

// Variable-width pen ribbon from a polyline (px) -> filled SVG path.
// Nib (contrast) thins fast strokes; Inkflow adds pressure + end taper.
function ribbonPath(pts, p, baseW) {
  const n = pts.length; if (n < 2) return "";
  const inkflow = toggles.inkflow ? 0.85 : 0, contrast = p.contrast || 0;
  const sp = new Array(n); let smax = 1e-4;
  for (let i = 0; i < n; i++) { const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)]; sp[i] = Math.hypot(b.x - a.x, b.y - a.y); if (sp[i] > smax) smax = sp[i]; }
  const w = new Array(n);
  for (let i = 0; i < n; i++) {
    const fast = Math.min(1, sp[i] / smax);
    let wi = baseW * (1 - contrast * 0.6 * fast);
    if (inkflow > 0) {
      const press = 1 + inkflow * 0.40 * vnoise(p.seed ^ 0xBEEF, i * 0.25);
      const edge = Math.min(1, Math.min(i, n - 1 - i) / Math.max(1, n * 0.14));
      wi *= press * (1 - inkflow * 0.70 * (1 - edge));
    }
    w[i] = Math.max(baseW * 0.22, wi);
  }
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1e-5; dx /= l; dy /= l;
    const hw = w[i] * 0.5;
    L.push({ x: pts[i].x - dy * hw, y: pts[i].y + dx * hw });
    R.push({ x: pts[i].x + dy * hw, y: pts[i].y - dx * hw });
  }
  let d = "M" + L[0].x.toFixed(1) + "," + L[0].y.toFixed(1);
  for (let i = 1; i < n; i++) d += "L" + L[i].x.toFixed(1) + "," + L[i].y.toFixed(1);
  for (let i = n - 1; i >= 0; i--) d += "L" + R[i].x.toFixed(1) + "," + R[i].y.toFixed(1);
  return d + "Z";
}

function buildNeuralSVG(lines, p) {
  const S = p.font_px * 0.62;
  const slant = Math.tan((p.slant_deg || 0) * Math.PI / 180);
  const lineGap = p.font_px * 1.9 * (p.line_spacing || 1.08);
  const margin = p.font_px * 0.5;
  const baseW = Math.max(1, p.weight * (p.font_px / 64) * 1.35);
  const vary = toggles.vary ? 1 : 0, natural = toggles.natural ? 1 : 0, tilt = toggles.tilt ? 1 : 0;
  let maxW = 0;
  for (const L of lines) maxW = Math.max(maxW, L.width * S);
  const W = Math.ceil(maxW + margin * 2);
  const H = Math.ceil(margin * 2 + lineGap * Math.max(0, lines.length - 1) + p.font_px * 2.4);
  let body = "";
  lines.forEach((L, li) => {
    const topY = margin + p.font_px * 0.5 + li * lineGap; // top of this line's band
    const shiftX = margin + (maxW - L.width * S) * (p.align || 0);
    L.strokes.forEach((stroke, si) => {
      if (stroke.length < 2) return;
      const ang = tilt ? 0.12 * vnoise(p.seed ^ 0x77, li * 10 + si) : 0;
      let cx = 0, cy = 0; for (const q of stroke) { cx += q.x; cy += q.y; } cx /= stroke.length; cy /= stroke.length;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const pts = [];
      for (let k = 0; k < stroke.length; k++) {
        let ex = stroke[k].x, ey = stroke[k].y; // em (y up: ascenders larger)
        if (vary) { ex += 0.012 * vary * vnoise(p.seed ^ 0x1234, (li * 50 + si) * 3 + k * 0.4); ey += 0.012 * vary * vnoise(p.seed ^ 0x5678, (li * 50 + si) * 3 + k * 0.4 + 10); }
        if (tilt) { const rx = ex - cx, ry = ey - cy; ex = cx + rx * ca - ry * sa; ey = cy + rx * sa + ry * ca; }
        const px = ex * S, py = ey * S;
        // offsetsToStrokes gives py=0 at the ascender top and py=max at the descender;
        // SVG y grows downward, so place ascenders near the band top.
        let y = topY + py;
        if (natural) y += natural * 0.10 * p.font_px * vnoise(p.seed ^ 0xA1, (shiftX + px) * 0.012 + li * 3);
        pts.push({ x: shiftX + px + py * slant, y });
      }
      body += `<path d="${ribbonPath(pts, p, baseW)}"/>`;
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `fill="currentColor" stroke="none"><g>${body}</g></svg>`;
}

const neuralInflight = new Set();
let neuralLatestKey = null;
function neuralSVG(text, p) {
  const bias = neuralBias(), seed = p.seed;
  const key = text + "|" + bias.toFixed(3) + "|" + seed;
  neuralLatestKey = key; // the most recently requested render always wins
  const cached = neuralCache.get(key);
  if (cached) return buildNeuralSVG(cached, p);
  if (!neuralInflight.has(key)) {
    neuralInflight.add(key);
    (async () => {
      try {
        nStatus().textContent = "Writing…";
        const lineTexts = (mode === "signature") ? [text] : text.split("\n");
        const lines = await sampleLines(lineTexts, bias, seed);
        neuralCache.set(key, lines);
        neuralInflight.delete(key);
        if (neuralLatestKey === key) { nStatus().textContent = ""; render(false); }
        else if (neuralInflight.size === 0) nStatus().textContent = "";
      } catch (e) { neuralInflight.delete(key); nStatus().textContent = "Neural model unavailable: " + (e.message || e); }
    })();
  }
  const W = Math.max(480, p.width || 800);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="140" viewBox="0 0 ${W} 140" fill="none" stroke="currentColor">` +
    `<g><text x="24" y="78" fill="currentColor" stroke="none" font-family="system-ui" font-size="16" opacity="0.55">✍ writing…</text></g></svg>`;
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
// Each preset sets the full control set + realism toggles + cursive-caps (cc).
const STYLES = {
  Casual:    { slant: 9,  contrast: 55, spacing: 4, line: 108, legibility: 60, thickness: 36, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 0 },
  Neat:      { slant: 6,  contrast: 48, spacing: 3, line: 110, legibility: 92, thickness: 32, t: { vary: 0, natural: 0, inkflow: 1, tilt: 0 }, cc: 0 },
  Formal:    { slant: 18, contrast: 78, spacing: 2, line: 120, legibility: 78, thickness: 30, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 1 },
  Elegant:   { slant: 24, contrast: 86, spacing: 1, line: 124, legibility: 70, thickness: 26, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 1 },
  Script:    { slant: 16, contrast: 60, spacing: 2, line: 116, legibility: 55, thickness: 34, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 1 },
  Signature: { slant: 24, contrast: 72, spacing: 1, line: 120, legibility: 18, thickness: 40, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 1 },
  Rounded:   { slant: 2,  contrast: 35, spacing: 5, line: 112, legibility: 80, thickness: 46, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 0 },
  Hurried:   { slant: 14, contrast: 40, spacing: 7, line: 102, legibility: 30, thickness: 30, t: { vary: 1, natural: 1, inkflow: 0, tilt: 0 }, cc: 0 },
  Scrawl:    { slant: 4,  contrast: 45, spacing: 6, line: 104, legibility: 25, thickness: 42, t: { vary: 1, natural: 1, inkflow: 1, tilt: 0 }, cc: 0 },
  Spiky:     { slant: 12, contrast: 60, spacing: 3, line: 106, legibility: 40, thickness: 28, t: { vary: 1, natural: 0, inkflow: 1, tilt: 1 }, cc: 0 },
  Architect: { slant: 0,  contrast: 30, spacing: 6, line: 112, legibility: 88, thickness: 30, t: { vary: 1, natural: 0, inkflow: 0, tilt: 1 }, cc: 0 },
  Marker:    { slant: 6,  contrast: 10, spacing: 8, line: 116, legibility: 55, thickness: 70, t: { vary: 1, natural: 1, inkflow: 0, tilt: 0 }, cc: 0 },
  Kid:       { slant: -4, contrast: 25, spacing: 8, line: 118, legibility: 45, thickness: 52, t: { vary: 1, natural: 1, inkflow: 0, tilt: 1 }, cc: 0 },
};

let ink = INKS[0], paper = PAPERS[0], texIdx = 1, align = 0, mode = "writing";
const toggles = { vary: true, natural: true, inkflow: true, tilt: false, cursivecaps: false, usesig: false, transparent: false, scanned: false, border: false };

// Imported-signature state (traced from an uploaded/pasted image).
let sigImg = null, sigSVG = "", sigBox = { w: 0, h: 0 }, sigMetrics = null;

// document background + placement
let doc = null;            // { img:Image, w, h, type }
let pdfDocCache = null;    // loaded pdfjs document
// Document editor: a list of movable/resizable items (signatures + text) on the page.
let docItems = [];          // {id,type,nx,ny,nw,ar,opacity,signer,svg,w,h,text}
let selId = null;
let signers = [{ id: "s1", name: "Signer 1", color: "#1b1b1f" }];
let activeSigner = "s1";
let itemSeq = 1;
let pdfFields = [];         // fillable-PDF form fields for the current page
let fieldValues = {};       // field name -> value

// Fonts for text/date items. "DocuSign" is a slanted script like DocuSign's stamp.
const DOC_FONTS = [
  { name: "DocuSign", css: "'Dancing Script', 'Segoe Script', cursive" },
  { name: "Script", css: "'Great Vibes', cursive" },
  { name: "Handwritten", css: "'Caveat', cursive" },
  { name: "Marker", css: "'Homemade Apple', cursive" },
  { name: "Serif", css: "Georgia, 'Times New Roman', serif" },
  { name: "Sans", css: "system-ui, Arial, sans-serif" },
  { name: "Mono", css: "'Courier New', ui-monospace, monospace" },
];
// New-hand history (revert to the previous seed) + saved hands (localStorage).
let handHistory = [];
const HAND_KEY = "cal2_hands";

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
const REALISM_KEYS = ["vary", "natural", "inkflow", "tilt", "cursivecaps"];
document.querySelectorAll(".sw-toggle").forEach((el) => {
  el.onclick = () => {
    const k = el.dataset.k; toggles[k] = !toggles[k]; el.classList.toggle("on", toggles[k]);
    if (k === "tilt" && toggles.tilt) { toggles.natural = false; syncToggles(); }
    render();
    // Realism live edit: refresh a placed signature so the change shows at once.
    if (REALISM_KEYS.includes(k)) { const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it); }
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
  Object.assign(toggles, { vary: !!s.t.vary, natural: !!s.t.natural, inkflow: !!s.t.inkflow, tilt: !!s.t.tilt, cursivecaps: !!s.cc });
  syncToggles(); render(false);
}

// ---- params --------------------------------------------------------------

const LABELS = {
  speed: v => v + "%", legibility: v => v + "%", thickness: v => (v / 10).toFixed(1),
  font_px: v => v, slant: v => v + "°", contrast: v => v + "%", spacing: v => (v / 100).toFixed(2),
  line_spacing: v => (v / 100).toFixed(2), tex_intensity: v => v + "%", blemish: v => v + "%",
  blur: v => v / 10 + "px", sharpen: v => v + "%", resolution: v => v + "×", place_scale: v => v + "%",
  sig_threshold: v => v,
  scan_rotate: v => (v / 10).toFixed(1) + "°", scan_rotvar: v => "±" + (v / 10).toFixed(1) + "°",
  scan_bright: v => v + "%", scan_contrast: v => v + "%", scan_noise: v => v + "%", scan_yellow: v => v + "%",
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

// Read the Scan & finish controls into one object (shared by preview + export).
function scanParams() {
  return {
    on: toggles.scanned,
    cspace: $("cspace") ? $("cspace").value : "color",
    border: !!toggles.border,
    rotate: (+($("scan_rotate") || {}).value || 0) / 10,
    rotvar: (+($("scan_rotvar") || {}).value || 0) / 10,
    bright: (+($("scan_bright") || {}).value || 100) / 100,
    contrast: (+($("scan_contrast") || {}).value || 100) / 100,
    noise: (+($("scan_noise") || {}).value || 0),
    yellow: (+($("scan_yellow") || {}).value || 0) / 100,
    blem: +$("blemish").value / 100,
    blur: +$("blur").value / 10,
    sharp: +$("sharpen").value / 100,
  };
}
// A fixed per-session skew so live rotation preview matches the exported random tilt.
let scanSkew = (Math.random() * 2 - 1);
function scanAngle(sp) { return sp.rotate + sp.rotvar * scanSkew; }
function scanTransform() { const sp = scanParams(); return sp.on ? `rotate(${scanAngle(sp).toFixed(2)}deg)` : "none"; }

function previewFilter() {
  const sp = scanParams();
  const parts = [];
  if (sp.blur > 0) parts.push(`blur(${sp.blur}px)`);
  if (sp.sharp > 0) parts.push(`contrast(${(1 + sp.sharp * 0.6).toFixed(2)}) saturate(${(1 + sp.sharp * 0.1).toFixed(2)})`);
  if (sp.on) {
    if (sp.cspace === "gray") parts.push("grayscale(1)");
    else if (sp.cspace === "bw") parts.push("grayscale(1) contrast(2.2) brightness(1.05)");
    parts.push(`brightness(${sp.bright.toFixed(3)}) contrast(${sp.contrast.toFixed(3)})`);
    if (sp.yellow > 0) parts.push(`sepia(${(sp.yellow * 0.7).toFixed(3)})`);
  }
  return parts.join(" ");
}

// ---- render --------------------------------------------------------------

let rawSVG = "", hwW = 800, hwH = 300;
function makeHandwriting(forWidth) {
  if (toggles.usesig && sigSVG) {
    hwW = sigBox.w; hwH = sigBox.h;
    return sigSVG.replace("<svg ", `<svg style="color:${ink}" `);
  }
  let svg = neuralSVG(textForEngine(), params(forWidth));
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
  refreshLabels();
  try {
    updateFab();
    if (doc) return renderDoc();
    sheet.className = "sheet";
    const stage = sheet.parentElement.getBoundingClientRect();
    const width = Math.max(480, Math.min(1600, stage.width - 48));
    rawSVG = makeHandwriting(width);
    sheet.innerHTML = animate ? animateSVG(rawSVG) : rawSVG;
    const pc = paperCSS();
    sheet.style.background = pc.bg; sheet.style.backgroundImage = pc.img; sheet.style.backgroundSize = pc.size;
    sheet.style.filter = previewFilter();
    sheet.style.transform = scanTransform();
    sheet.style.outline = "";
    sheet.style.width = ""; sheet.style.height = "";
    errEl.textContent = ""; syncHash();
  } catch (e) { errEl.textContent = "Render error: " + (e.message || e); }
}

// ---- document editor -------------------------------------------------------
function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function signerColor(id) { const s = signers.find((x) => x.id === id); return s ? s.color : "#1b1b1f"; }
function TRASH() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>'; }

function currentSignature() {
  if (sigSVG) return { svg: sigSVG, w: sigBox.w, h: sigBox.h };          // traced image (currentColor)
  const svg = makeHandwriting(Math.round((doc ? doc.w : 800) * 0.5));    // generated handwriting
  return { svg: cleanSigSVG(svg), w: hwW, h: hwH };
}
// Async: sample a fresh signature SVG for text/params (awaits the worker).
async function generateSig(text, p) {
  const bias = neuralBias();
  const lineTexts = (mode === "signature") ? [text] : String(text).split("\n");
  const lines = await sampleLines(lineTexts, bias, p.seed);
  neuralCache.set(text + "|" + bias.toFixed(3) + "|" + p.seed, lines);
  let svg = buildNeuralSVG(lines, p);
  if (mode === "signature") svg = addFlourish(svg);
  svg = svg.replace("<svg ", `<svg style="color:${ink}" `);
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 1, h = +(svg.match(/height="(\d+)"/) || [])[1] || 1;
  return { svg: cleanSigSVG(svg), w, h };
}
function addSigItem() {
  const g = currentSignature();
  if (!g.w) { errEl.textContent = "Type some text or import a signature first."; return; }
  const traced = !!(sigSVG && toggles.usesig);
  docItems.push({ id: "it" + itemSeq++, type: "sig", nx: 0.08, ny: 0.08, nw: 0.3, ar: g.h / g.w, opacity: 1, signer: activeSigner, svg: g.svg, dynamic: !traced, text: textForEngine(), seed: +$("seed").value });
  selId = docItems[docItems.length - 1].id; render();
}
function addTextItem() {
  docItems.push({ id: "it" + itemSeq++, type: "text", nx: 0.1, ny: 0.1, nw: 0.26, ar: 0.16, opacity: 1, signer: activeSigner, text: "Type here", font: 5 });
  selId = docItems[docItems.length - 1].id; render();
}
function addDateItem() {
  const str = new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  docItems.push({ id: "it" + itemSeq++, type: "text", nx: 0.1, ny: 0.1, nw: 0.3, ar: 0.12, opacity: 1, signer: activeSigner, text: str, font: 0 });
  selId = docItems[docItems.length - 1].id; render();
}
function deleteItem(id) { docItems = docItems.filter((i) => i.id !== id); if (selId === id) selId = null; render(); }
function editText(it) {
  const v = prompt("Text:", it.text); if (v != null) { it.text = v; render(); }
}
// Re-roll / refresh a placed dynamic signature using the current realism controls.
async function regenItem(it, newSeed) {
  if (!it || it.type !== "sig" || !it.dynamic) return;
  if (newSeed != null) it.seed = newSeed;
  const p = params(Math.round((doc ? doc.w : 800) * 0.5));
  p.seed = it.seed;
  try { const g = await generateSig(it.text, p); it.svg = g.svg; it.ar = g.h / g.w; render(); flash("Updated signature."); }
  catch (e) { errEl.textContent = "Could not re-roll: " + (e.message || e); }
}
function selectedItem() { return docItems.find((i) => i.id === selId); }

function renderDoc() {
  sheet.className = "sheet doc";
  const stage = sheet.parentElement.getBoundingClientRect();
  const dispW = Math.min(doc.w, stage.width - 48);
  const dispH = dispW * doc.h / doc.w;
  sheet.innerHTML = `<img id="docbg" src="${doc.url}" draggable="false" style="width:${dispW}px;height:${dispH}px"/><div id="overlay"></div>`;
  sheet.style.width = dispW + "px"; sheet.style.height = dispH + "px";
  sheet.style.background = "transparent"; sheet.style.backgroundImage = "";
  sheet.style.filter = previewFilter(); // scanned look / blur / sharpness on the whole page
  sheet.style.transform = scanTransform();
  const spB = scanParams();
  sheet.style.outline = (spB.on && spB.border) ? "6px solid rgba(22,19,14,0.9)" : "";
  sheet.style.outlineOffset = "-3px";
  const ov = $("overlay");
  ov.style.cssText = `position:absolute;left:0;top:0;width:${dispW}px;height:${dispH}px`;
  ov.onpointerdown = (e) => { if (e.target === ov) { selId = null; render(); } };
  renderFields(ov, dispW, dispH);
  docItems.forEach((it) => ov.appendChild(itemEl(it, dispW, dispH)));
  syncItemUI();
  errEl.textContent = ""; syncHash();
}

function itemEl(it, dispW, dispH) {
  const w = it.nw * dispW, h = it.nw * dispW * it.ar;
  const el = document.createElement("div");
  el.className = "ditem" + (it.id === selId ? " sel" : "");
  el.style.cssText = `left:${it.nx * dispW}px;top:${it.ny * dispH}px;width:${w}px;height:${h}px;opacity:${it.opacity};color:${signerColor(it.signer)}`;
  if (it.type === "sig") el.innerHTML = it.svg.replace("<svg ", '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block;pointer-events:none" ');
  else {
    const fam = DOC_FONTS[it.font || 0].css;
    el.innerHTML = `<div class="dtext" style="font-size:${h * 0.7}px;font-family:${fam}">${escapeHTML(it.text)}</div>`;
  }
  el.onpointerdown = (e) => {
    if (e.target.classList.contains("dhandle") || e.target.closest(".dtrash") || e.target.isContentEditable) return;
    e.preventDefault(); selId = it.id; el.classList.add("sel"); syncItemUI(); startMove(it, el, e, dispW, dispH);
  };
  if (it.id === selId) {
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const hd = document.createElement("div"); hd.className = "dhandle " + corner;
      hd.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); startResize(it, el, corner, e, dispW, dispH); };
      el.appendChild(hd);
    });
    const tr = document.createElement("div"); tr.className = "dtrash"; tr.title = "Delete"; tr.innerHTML = TRASH();
    tr.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); deleteItem(it.id); };
    el.appendChild(tr);
    if (it.type === "text") el.ondblclick = () => startInlineEdit(it, el);
  }
  return el;
}

// Live inline text editing: edits land in it.text as you type (no modal).
function startInlineEdit(it, el) {
  const td = el.querySelector(".dtext"); if (!td) return;
  td.setAttribute("contenteditable", "true");
  td.style.pointerEvents = "auto";
  td.focus();
  const sel = window.getSelection(); sel.removeAllRanges();
  const r = document.createRange(); r.selectNodeContents(td); sel.addRange(r);
  td.oninput = () => { it.text = td.textContent; };
  td.onblur = () => { it.text = td.textContent; td.removeAttribute("contenteditable"); render(); };
  td.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); td.blur(); } };
}
// Keep the Font row + Opacity in sync with the selected item.
function syncItemUI() {
  const it = selectedItem();
  const row = $("item_font_row");
  if (row) row.style.display = it && it.type === "text" ? "" : "none";
  if (it && it.type === "text" && $("item_font")) $("item_font").value = String(it.font || 0);
  if (it && $("item_opacity")) { $("item_opacity").value = Math.round((it.opacity ?? 1) * 100); $("item_opacity_v").textContent = $("item_opacity").value + "%"; }
}

function startMove(it, el, e, dispW, dispH) {
  el.setPointerCapture(e.pointerId);
  const sx = e.clientX, sy = e.clientY, ox = it.nx, oy = it.ny;
  const mv = (ev) => {
    it.nx = Math.max(-0.1, Math.min(0.98, ox + (ev.clientX - sx) / dispW));
    it.ny = Math.max(-0.1, Math.min(0.98, oy + (ev.clientY - sy) / dispH));
    el.style.left = it.nx * dispW + "px"; el.style.top = it.ny * dispH + "px";
  };
  const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); render(); };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}
function startResize(it, el, corner, e, dispW, dispH) {
  el.setPointerCapture(e.pointerId);
  const sx = e.clientX, ow = it.nw, onx = it.nx, ony = it.ny;
  const west = corner.includes("w"), north = corner.includes("n");
  const owPx = ow * dispW, ohPx = ow * dispW * it.ar;
  const GAIN = 1.8; // resize handle moves size quicker than the cursor
  const mv = (ev) => {
    let dw = GAIN * (ev.clientX - sx) / dispW; if (west) dw = -dw;
    const nw = Math.max(0.04, ow + dw);
    const nwPx = nw * dispW, nhPx = nw * dispW * it.ar;
    it.nw = nw;
    if (west) it.nx = onx + (owPx - nwPx) / dispW;
    if (north) it.ny = ony + (ohPx - nhPx) / dispH;
    el.style.width = nwPx + "px"; el.style.height = nhPx + "px";
    el.style.left = it.nx * dispW + "px"; el.style.top = it.ny * dispH + "px";
    if (it.type === "text") { const td = el.querySelector(".dtext"); if (td) td.style.fontSize = nhPx * 0.7 + "px"; }
  };
  const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); render(); };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}

// ---- fillable PDF form fields ----------------------------------------------
function renderFields(ov, dispW, dispH) {
  pdfFields.forEach((f) => {
    const x = f.nx * dispW, y = f.ny * dispH, w = f.nw * dispW, h = f.nh * dispH;
    if (f.type === "check") {
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "dfield";
      cb.checked = !!fieldValues[f.name]; cb.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(14, h)}px;height:${Math.max(14, h)}px`;
      cb.onchange = () => { fieldValues[f.name] = cb.checked; };
      ov.appendChild(cb);
    } else {
      const inp = document.createElement("input"); inp.type = "text"; inp.className = "dfield";
      inp.value = fieldValues[f.name] || ""; inp.placeholder = f.name || "";
      inp.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${Math.min(h * 0.7, 16)}px`;
      inp.oninput = () => { fieldValues[f.name] = inp.value; };
      ov.appendChild(inp);
    }
  });
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
    $("doc_controls").style.display = ""; docItems = []; selId = null;
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
  // fillable form fields on this page
  pdfFields = [];
  try {
    const ann = await page.getAnnotations();
    for (const a of ann) {
      if (a.subtype !== "Widget" || !a.rect) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x1 = Math.min(r[0], r[2]), y1 = Math.min(r[1], r[3]), x2 = Math.max(r[0], r[2]), y2 = Math.max(r[1], r[3]);
      const name = a.fieldName || a.id;
      const box = { name, nx: x1 / vp.width, ny: y1 / vp.height, nw: (x2 - x1) / vp.width, nh: (y2 - y1) / vp.height };
      if (a.fieldType === "Tx") { pdfFields.push({ ...box, type: "text" }); if (a.fieldValue && fieldValues[name] == null) fieldValues[name] = a.fieldValue; }
      else if (a.fieldType === "Btn" && !a.pushButton && a.checkBox !== false) { pdfFields.push({ ...box, type: "check" }); if (a.fieldValue != null && fieldValues[name] == null) fieldValues[name] = a.fieldValue !== "Off"; }
    }
  } catch (_) { pdfFields = []; }
}
$("pdf_page").onchange = async () => { if (pdfDocCache) { await renderPdfPage(+$("pdf_page").value); render(); } };
$("add_sig").onclick = addSigItem;
$("add_text").onclick = addTextItem;
$("add_date").onclick = addDateItem;
(function buildFontSelect() {
  const sel = $("item_font"); if (!sel) return;
  DOC_FONTS.forEach((f, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = f.name; sel.appendChild(o); });
  sel.onchange = () => { const it = selectedItem(); if (it && it.type === "text") { it.font = +sel.value; render(); } };
})();
$("item_opacity").oninput = () => {
  const it = selectedItem();
  $("item_opacity_v").textContent = $("item_opacity").value + "%";
  if (it) { it.opacity = +$("item_opacity").value / 100; render(); }
};
$("signer_sel").onchange = () => { activeSigner = $("signer_sel").value; };
$("add_signer").onclick = () => {
  const name = prompt("Signer name:", "Signer " + (signers.length + 1)); if (!name) return;
  const palette = ["#1b1b1f", "#1d3a8a", "#0b7285", "#6d1a36", "#2b2320", "#7a1f1f"];
  const id = "s" + Date.now();
  signers.push({ id, name, color: palette[signers.length % palette.length] });
  activeSigner = id; buildSigners();
};
function buildSigners() {
  const sel = $("signer_sel"); if (!sel) return;
  sel.innerHTML = "";
  signers.forEach((s) => { const o = document.createElement("option"); o.value = s.id; o.textContent = s.name; sel.appendChild(o); });
  sel.value = activeSigner;
}
$("clear_doc").onclick = () => { doc = null; pdfDocCache = null; docItems = []; selId = null; pdfFields = []; fieldValues = {}; $("doc_controls").style.display = "none"; $("pdf_pages").textContent = ""; render(); };

// ---- export pipeline -----------------------------------------------------

function svgToImage(svg) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    const img = new Image();
    img.onload = () => { res(img); };
    img.onerror = rej; img.src = url;
  });
}
// Apply blur/sharpen + the full scanned look to a finished canvas.
// May return a new (rotated) canvas, so always use the return value.
function finishCanvas(c) {
  const ctx = c.getContext("2d");
  const sp = scanParams();
  if (sp.blur > 0) { const t = document.createElement("canvas"); t.width = c.width; t.height = c.height; t.getContext("2d").drawImage(c, 0, 0); ctx.clearRect(0, 0, c.width, c.height); ctx.filter = `blur(${sp.blur * (c.width / 800)}px)`; ctx.drawImage(t, 0, 0); ctx.filter = "none"; }
  if (sp.sharp > 0) unsharp(ctx, c.width, c.height, sp.sharp);
  if (!sp.on) return c;

  // colorspace + brightness + contrast via a filtered redraw
  const filt = [];
  if (sp.cspace === "gray") filt.push("grayscale(1)");
  else if (sp.cspace === "bw") filt.push("grayscale(1)", "contrast(2.2)", "brightness(1.05)");
  filt.push(`brightness(${sp.bright.toFixed(3)})`, `contrast(${sp.contrast.toFixed(3)})`);
  if (sp.yellow > 0) filt.push(`sepia(${(sp.yellow * 0.7).toFixed(3)})`);
  const t = document.createElement("canvas"); t.width = c.width; t.height = c.height; t.getContext("2d").drawImage(c, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height); ctx.filter = filt.join(" "); ctx.drawImage(t, 0, 0); ctx.filter = "none";

  if (sp.yellow > 0) { ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = `rgba(255,244,196,${(sp.yellow * 0.5).toFixed(3)})`; ctx.fillRect(0, 0, c.width, c.height); ctx.restore(); }
  if (sp.noise > 0) scanNoise(ctx, c.width, c.height, sp.noise);
  scanBlemish(ctx, c.width, c.height, sp.blem);
  if (sp.border) { ctx.save(); const bw = Math.max(4, c.width * 0.006); ctx.strokeStyle = "rgba(22,19,14,0.9)"; ctx.lineWidth = bw; ctx.strokeRect(bw / 2, bw / 2, c.width - bw, c.height - bw); ctx.restore(); }

  const ang = scanAngle(sp) * Math.PI / 180;
  if (Math.abs(ang) > 0.0005) return rotateCanvas(c, ang);
  return c;
}
// Salt-and-pepper scanner grain.
function scanNoise(ctx, w, h, amount) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const count = Math.floor(w * h * Math.min(amount / 240, 0.45) * 0.08);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * w * h) * 4, v = Math.random() > 0.5 ? 255 : 0;
    d[idx] = v; d[idx + 1] = v; d[idx + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}
// Rotate a canvas by `ang` radians, expanding the frame and filling white.
function rotateCanvas(c, ang) {
  const w = c.width, h = c.height, cos = Math.abs(Math.cos(ang)), sin = Math.abs(Math.sin(ang));
  const nw = Math.ceil(w * cos + h * sin), nh = Math.ceil(w * sin + h * cos);
  const o = document.createElement("canvas"); o.width = nw; o.height = nh;
  const ox = o.getContext("2d");
  ox.fillStyle = "#fff"; ox.fillRect(0, 0, nw, nh);
  ox.translate(nw / 2, nh / 2); ox.rotate(ang); ox.drawImage(c, -w / 2, -h / 2);
  return o;
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
function scanBlemish(ctx, w, h, blem) {
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
  try { await document.fonts.ready; } catch (_) {}
  if (doc) {
    const W = Math.round(doc.w * res), H = Math.round(doc.h * res);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(doc.img, 0, 0, W, H);
    // filled form-field values
    for (const f of pdfFields) {
      const v = fieldValues[f.name]; if (v == null || v === "" || v === false) continue;
      const x = f.nx * W, y = f.ny * H, w = f.nw * W, h = f.nh * H;
      ctx.fillStyle = "#15233a";
      if (f.type === "check") { ctx.font = `${h * 0.9}px system-ui, sans-serif`; ctx.textBaseline = "top"; ctx.fillText("X", x + w * 0.12, y); }
      else { ctx.font = `${Math.min(h * 0.72, 18 * res)}px system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.fillText(String(v), x + 3, y + h / 2); }
    }
    // placed signatures / text
    for (const it of docItems) {
      const x = it.nx * W, y = it.ny * H, w = it.nw * W, h = it.nw * W * it.ar;
      ctx.globalAlpha = it.opacity;
      if (it.type === "sig") {
        const img = await svgToImage(it.svg.replace("<svg ", `<svg style="color:${signerColor(it.signer)}" `));
        ctx.drawImage(img, x, y, w, h);
      } else {
        ctx.fillStyle = signerColor(it.signer); ctx.font = `${h * 0.7}px ${DOC_FONTS[it.font || 0].css}`; ctx.textBaseline = "middle";
        ctx.fillText(it.text, x, y + h / 2);
      }
    }
    ctx.globalAlpha = 1;
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

// ---- signature image -> vector --------------------------------------------

$("sig_btn").onclick = () => $("sig_file").click();
$("sig_file").onchange = (e) => { const f = e.target.files[0]; if (f) loadSigFile(f); };
$("sig_threshold").addEventListener("input", () => { refreshLabels(); processSignature(); render(); });
$("sig_clear").onclick = () => { sigImg = null; sigSVG = ""; toggles.usesig = false; syncToggles(); $("sig_controls").style.display = "none"; render(); };
$("sig_match").onclick = () => {
  if (!sigMetrics) return;
  const set = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("input")); };
  set("slant", sigMetrics.slant); set("thickness", sigMetrics.thickness);
  toggles.usesig = false; syncToggles(); render(true); flash("Applied the signature's slant & weight.");
};
document.addEventListener("paste", (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) if (it.type && it.type.startsWith("image/")) { loadSigFile(it.getAsFile()); e.preventDefault(); break; }
});
function loadSigFile(f) {
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    sigImg = img; processSignature();
    if (sigSVG) { $("sig_controls").style.display = ""; toggles.usesig = true; syncToggles(); render(); }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { errEl.textContent = "Could not read that image."; };
  img.src = url;
}

function processSignature() {
  if (!sigImg) return;
  const maxD = 880;
  let w = sigImg.naturalWidth, h = sigImg.naturalHeight;
  const sc = Math.min(1, maxD / Math.max(w, h)); w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d"); cx.drawImage(sigImg, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h), alpha = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) { lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]; alpha[i] = d[p + 3]; }
  // Adaptive (Bradley) threshold via an integral image — robust to shadows / uneven paper.
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += lum[y * w + x]; integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rs; } }
  const rad = Math.max(6, Math.round(Math.min(w, h) * 0.08));
  const localMean = (x, y) => {
    const x0 = Math.max(0, x - rad), y0 = Math.max(0, y - rad), x1 = Math.min(w - 1, x + rad), y1 = Math.min(h - 1, y + rad);
    const A = integ[y0 * (w + 1) + x0], B = integ[y0 * (w + 1) + (x1 + 1)], C = integ[(y1 + 1) * (w + 1) + x0], D = integ[(y1 + 1) * (w + 1) + (x1 + 1)];
    return (D - B - C + A) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };
  const margin = (1 - (+$("sig_threshold").value) / 255) * 44 + 4;
  let mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (alpha[i] > 10 && lum[i] < 205 && localMean(x, y) - lum[i] > margin) mask[i] = 1; }
  mask = despeckle(mask, w, h);
  let area = 0, sumX = 0, sumY = 0, sumXY = 0, sumYY = 0, minx = w, miny = h, maxx = 0, maxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { area++; sumX += x; sumY += y; sumXY += x * y; sumYY += y * y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
  if (area < 24) { sigSVG = ""; errEl.textContent = "No clear ink found — adjust the threshold or use a cleaner image."; return; }
  const minArea = Math.max(8, w * h * 0.00004);
  let loops = marchingSquares(mask, w, h).map((L) => {
    if (L.length > 1 && L[0][0] === L[L.length - 1][0] && L[0][1] === L[L.length - 1][1]) L = L.slice(0, -1);
    return simplifyLoop(chaikin(chaikin(L)), 1.0);
  }).filter((L) => L.length > 3 && polyArea(L) > minArea);
  if (!loops.length) { sigSVG = ""; errEl.textContent = "Could not trace clean strokes — try a higher-contrast image."; return; }
  // slant estimate: regression x = a*y + b over ink pixels
  const n = area, meanX = sumX / n, meanY = sumY / n;
  const a = (sumXY - n * meanX * meanY) / ((sumYY - n * meanY * meanY) || 1);
  const slant = Math.max(-10, Math.min(30, Math.round(-a * 42)));
  // weight estimate: 2*area / perimeter relative to ink height
  let perim = 0;
  for (const L of loops) for (let i = 1; i < L.length; i++) perim += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]);
  const strokeW = perim > 0 ? (2 * area) / perim : 4, bh = (maxy - miny) || 1;
  const thickness = Math.max(10, Math.min(90, Math.round((strokeW / bh) * 620)));
  sigMetrics = { slant, thickness };
  const vbw = maxx - minx + 2, vbh = maxy - miny + 2;
  let body = "";
  for (const L of loops) {
    let s = "M" + (L[0][0] - minx + 1).toFixed(1) + " " + (L[0][1] - miny + 1).toFixed(1);
    for (let i = 1; i < L.length; i++) s += "L" + (L[i][0] - minx + 1).toFixed(1) + " " + (L[i][1] - miny + 1).toFixed(1);
    body += '<path d="' + s + 'Z"/>';
  }
  sigSVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${vbw}" height="${vbh}" viewBox="0 0 ${vbw} ${vbh}" fill="currentColor" stroke="none"><g fill-rule="evenodd">${body}</g></svg>`;
  sigBox = { w: vbw, h: vbh };
  errEl.textContent = "";
}

// Marching squares over a binary mask -> array of closed loops of points.
function marchingSquares(mask, w, h) {
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const segs = [];
  const push = (p, q) => segs.push([p[0], p[1], q[0], q[1]]);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const tl = val(x, y), tr = val(x + 1, y), br = val(x + 1, y + 1), bl = val(x, y + 1);
    const idx = tl | (tr << 1) | (br << 2) | (bl << 3);
    if (idx === 0 || idx === 15) continue;
    const T = [x + 0.5, y], R = [x + 1, y + 0.5], B = [x + 0.5, y + 1], L = [x, y + 0.5];
    switch (idx) {
      case 1: case 14: push(L, T); break;
      case 2: case 13: push(T, R); break;
      case 3: case 12: push(L, R); break;
      case 4: case 11: push(R, B); break;
      case 6: case 9: push(T, B); break;
      case 7: case 8: push(L, B); break;
      case 5: push(L, T); push(R, B); break;
      case 10: push(T, R); push(L, B); break;
    }
  }
  const key = (x, y) => x + "," + y;
  const ends = new Map();
  segs.forEach((s, i) => { for (const k of [key(s[0], s[1]), key(s[2], s[3])]) { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Array(segs.length).fill(false), loops = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const s0 = segs[i]; let curKey = key(s0[0], s0[1]), cur = i; const loop = [[s0[0], s0[1]]];
    let guard = 0;
    while (cur !== -1 && !used[cur] && guard++ < 1e6) {
      used[cur] = true; const s = segs[cur];
      const aK = key(s[0], s[1]), bK = key(s[2], s[3]);
      const nextKey = curKey === aK ? bK : aK;
      const parts = nextKey.split(",");
      loop.push([+parts[0], +parts[1]]);
      curKey = nextKey;
      const cand = (ends.get(nextKey) || []).filter((j) => !used[j]);
      cur = cand.length ? cand[0] : -1;
    }
    if (loop.length > 3) loops.push(loop);
  }
  return loops;
}
// Remove isolated speckle pixels and fill pinhole gaps (3x3 neighbourhood).
function despeckle(mask, w, h) {
  const out = mask.slice();
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) n += at(x + dx, y + dy);
    const i = y * w + x;
    if (mask[i] && n < 2) out[i] = 0;
    else if (!mask[i] && n >= 7) out[i] = 1;
  }
  return out;
}
// Chaikin corner-cutting on a closed ring — rounds the pixel stair-steps.
function chaikin(pts) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  return out;
}
// Absolute polygon area (shoelace) — used to drop tiny speckle contours.
function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}
// Simplify a closed loop by splitting at the point farthest from its start,
// so RDP has two distinct anchors (RDP alone collapses a closed ring).
function simplifyLoop(loop, eps) {
  if (loop.length < 6) return loop;
  let far = 0, fd = -1;
  for (let i = 1; i < loop.length; i++) {
    const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]);
    if (d > fd) { fd = d; far = i; }
  }
  const first = rdp(loop.slice(0, far + 1), eps);
  const second = rdp(loop.slice(far), eps);
  return first.slice(0, -1).concat(second);
}
// Ramer-Douglas-Peucker polyline simplification.
function rdp(pts, eps) {
  if (pts.length < 3) return pts;
  let idx = 0, dmax = 0; const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    const dd = Math.abs((pts[i][0] - a[0]) * dy - (pts[i][1] - a[1]) * dx) / len;
    if (dd > dmax) { dmax = dd; idx = i; }
  }
  if (dmax > eps) return rdp(pts.slice(0, idx + 1), eps).slice(0, -1).concat(rdp(pts.slice(idx), eps));
  return [a, b];
}

// ---- saved signatures (localStorage, max 10) ------------------------------

const SIG_KEY = "cal2_sigs";
function loadSavedSigs() { try { return JSON.parse(localStorage.getItem(SIG_KEY) || "[]"); } catch { return []; } }
function storeSavedSigs(a) { try { localStorage.setItem(SIG_KEY, JSON.stringify(a.slice(0, 10))); } catch {} }
function cleanSigSVG(svg) { return svg.replace(/\s*style="color:[^"]*"/, ""); }
function renderSavedSigs() {
  const host = $("sig_saved"); if (!host) return;
  const list = loadSavedSigs(); host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<div style="color:var(--muted);font-size:11px">None yet — Save current, or paste a signature.</div>'; return; }
  list.forEach((s) => {
    const card = document.createElement("div");
    card.title = s.name || "signature";
    card.style.cssText = "position:relative;width:78px;height:46px;border:1px solid var(--line);border-radius:8px;background:#fff;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center";
    card.innerHTML = s.svg.replace("<svg ", '<svg style="width:92%;height:84%;color:#111" preserveAspectRatio="xMidYMid meet" ');
    card.onclick = () => { sigSVG = s.svg; sigBox = { w: s.w, h: s.h }; toggles.usesig = true; syncToggles(); $("sig_controls").style.display = ""; render(); flash("Loaded " + (s.name || "signature") + "."); };
    const del = document.createElement("div");
    del.textContent = "×"; del.title = "Delete";
    del.style.cssText = "position:absolute;top:-1px;right:1px;color:#c0392b;font-weight:700;cursor:pointer;background:rgba(255,255,255,.75);line-height:1.1;padding:0 4px;border-radius:0 0 0 6px";
    del.onclick = (e) => { e.stopPropagation(); storeSavedSigs(loadSavedSigs().filter((x) => x.id !== s.id)); renderSavedSigs(); };
    card.appendChild(del); host.appendChild(card);
  });
}
function saveCurrentSig() {
  if (!rawSVG) { errEl.textContent = "Nothing to save yet."; return; }
  const list = loadSavedSigs();
  if (list.length >= 10) { errEl.textContent = "Saved signatures full (10) — delete one first."; return; }
  list.push({ id: Date.now() + "-" + Math.floor(Math.random() * 1e4), name: "Sig " + (list.length + 1), svg: cleanSigSVG(rawSVG), w: hwW, h: hwH });
  storeSavedSigs(list); renderSavedSigs(); flash("Signature saved.");
}

// ---- hands: new / last / saved --------------------------------------------

// New hand: if a placed signature is selected, re-roll only that one; otherwise
// push the current seed to history and roll a new global seed.
function newHand() {
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { regenItem(it, Math.floor(Math.random() * 1e9)); return; }
  handHistory.push(+$("seed").value);
  $("seed").value = Math.floor(Math.random() * 1e9);
  if ($("hand")) $("hand").value = "r";
  render(true);
}
function lastHand() {
  const prev = handHistory.pop();
  if (prev == null) { flash("No previous hand to revert to."); return; }
  $("seed").value = prev;
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { regenItem(it, prev); return; }
  render(true);
}
function loadSavedHands() { try { return JSON.parse(localStorage.getItem(HAND_KEY) || "[]"); } catch { return []; } }
function storeSavedHands(a) { try { localStorage.setItem(HAND_KEY, JSON.stringify(a.slice(0, 12))); } catch {} }
function renderSavedHands() {
  const host = $("saved_hands"); if (!host) return;
  const list = loadSavedHands(); host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<div style="color:var(--muted);font-size:11px">No saved hands yet — ★ Save hand to keep the current seed.</div>'; return; }
  list.forEach((s) => {
    const chip = document.createElement("span"); chip.className = "savedhand"; chip.title = "Seed " + s.seed;
    const lbl = document.createElement("span"); lbl.textContent = s.name; chip.appendChild(lbl);
    chip.onclick = () => { handHistory.push(+$("seed").value); $("seed").value = s.seed; const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, s.seed); else render(true); flash("Loaded " + s.name + "."); };
    const x = document.createElement("span"); x.className = "x"; x.textContent = "×"; x.title = "Delete";
    x.onclick = (e) => { e.stopPropagation(); storeSavedHands(loadSavedHands().filter((h) => h.id !== s.id)); renderSavedHands(); };
    chip.appendChild(x); host.appendChild(chip);
  });
}
function saveHand() {
  const list = loadSavedHands();
  if (list.length >= 12) { flash("Saved hands full (12) — delete one first."); return; }
  const name = prompt("Name this hand:", "Hand " + (list.length + 1)); if (!name) return;
  list.push({ id: Date.now() + "-" + Math.floor(Math.random() * 1e4), name, seed: +$("seed").value });
  storeSavedHands(list); renderSavedHands(); flash("Hand saved.");
}

// ---- on-canvas quick add --------------------------------------------------
function buildAddFab() {
  const stage = document.querySelector(".stage"); if (!stage || $("addfab")) return;
  const fab = document.createElement("div"); fab.id = "addfab"; fab.style.display = "none";
  fab.innerHTML =
    '<div class="fabmenu">' +
    '<button class="btn" data-add="sig">+ Signature</button>' +
    '<button class="btn" data-add="text">+ Writing</button>' +
    '<button class="btn" data-add="date">+ Date</button>' +
    '</div><button class="fabbtn" title="Add to page">+</button>';
  fab.querySelector(".fabbtn").onclick = () => fab.classList.toggle("open");
  fab.querySelectorAll("[data-add]").forEach((b) => b.onclick = () => {
    fab.classList.remove("open");
    const a = b.dataset.add; if (a === "sig") addSigItem(); else if (a === "text") addTextItem(); else addDateItem();
  });
  stage.appendChild(fab);
}
function updateFab() { const f = $("addfab"); if (f) { f.style.display = doc ? "" : "none"; if (!doc) f.classList.remove("open"); } }

// ---- boot ----------------------------------------------------------------

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderD = debounce(() => render(false), 90);
let tier = "simple";
function applyTier(t) {
  tier = t;
  document.querySelectorAll("#tier button").forEach((b) => b.classList.toggle("sel", b.dataset.tier === t));
  document.querySelectorAll('[data-tier="adv"]').forEach((el) => { el.style.display = t === "advanced" ? "" : "none"; });
}

(async function () {
  buildSwatches();
  try { await loadWasm(); } catch (e) { /* procedural engine optional; neural is primary */ }
  $("tier").querySelectorAll("button").forEach((b) => { b.onclick = () => applyTier(b.dataset.tier); });
  applyTier("simple");
  loadHash(); buildSwatches();
  if (!location.hash && $("hand").value !== "r") $("seed").value = $("hand").value;
  ["speed", "legibility", "thickness", "font_px", "slant", "contrast", "spacing", "line_spacing", "tex_intensity",
   "blur", "sharpen", "resolution", "blemish", "scan_rotate", "scan_rotvar", "scan_bright", "scan_contrast", "scan_noise", "scan_yellow"]
    .forEach((id) => { const el = $(id); if (el) el.addEventListener("input", renderD); });
  if ($("cspace")) $("cspace").addEventListener("change", renderD);
  // Handwriting controls: refresh a selected placed signature live on release.
  const HW_KEYS = ["legibility", "thickness", "slant", "contrast", "spacing", "line_spacing", "font_px"];
  HW_KEYS.forEach((id) => { const el = $(id); if (el) el.addEventListener("change", () => { const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it); }); });
  $("text").addEventListener("input", debounce(() => render(true), 160));
  $("seed").addEventListener("input", renderD);
  $("style").addEventListener("change", () => applyStyle($("style").value));
  $("hand").addEventListener("change", () => {
    const v = $("hand").value;
    handHistory.push(+$("seed").value);
    $("seed").value = v === "r" ? Math.floor(Math.random() * 1e9) : v;
    const it = selectedItem();
    if (it && it.type === "sig" && it.dynamic) regenItem(it, +$("seed").value); else render(true);
  });
  $("paper_style").addEventListener("change", () => render());
  $("reroll").addEventListener("click", newHand);
  $("last_hand").addEventListener("click", lastHand);
  $("save_hand").addEventListener("click", saveHand);
  renderSavedHands();
  // On-canvas quick-add button (signature / writing / date).
  buildAddFab();
  // Scroll the controls panel even when the pointer is over the preview.
  const panelEl = document.querySelector(".panel"), stageEl = document.querySelector(".stage");
  if (stageEl && panelEl) stageEl.addEventListener("wheel", (e) => {
    // Let the preview scroll itself only while it still can in this direction;
    // otherwise forward the wheel to the controls panel.
    const stageRoom = stageEl.scrollHeight - stageEl.clientHeight > 4;
    const stageCanScroll = stageRoom && ((e.deltaY > 0 && stageEl.scrollTop + stageEl.clientHeight < stageEl.scrollHeight - 1) || (e.deltaY < 0 && stageEl.scrollTop > 1));
    if (stageCanScroll) return;
    if (panelEl.scrollHeight - panelEl.clientHeight > 4) { panelEl.scrollTop += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  $("png").addEventListener("click", exportPNG);
  $("pdf").addEventListener("click", exportPDF);
  $("svg").addEventListener("click", exportSVG);
  $("share").addEventListener("click", copyLink);
  $("sig_save").addEventListener("click", saveCurrentSig);
  renderSavedSigs();
  buildSigners();
  window.addEventListener("resize", renderD);
  render(false);
})();
