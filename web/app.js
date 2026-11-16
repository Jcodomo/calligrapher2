// Calligrapher 2.0 front-end. Rust/WASM engine + document signing + scan finish.
// WASM C ABI: alloc / dealloc / generate / result_ptr + linear `memory`.

import { initPdfEditor } from "./pdfedit.js?v=6";
import { saveRecent, listRecents, getRecent, delRecent, makeRecentCard } from "./recents.js?v=1";

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
let doc = null;            // the current page: { img:Image, w, h, url, fields } (see docPages)
let pdfDocCache = null;    // loaded pdfjs document
let docPdfBytes = null;    // original PDF bytes, kept for the fillable-PDF export (pdf-lib)
// Document editor objects: signatures, text, dates, ticks, fields, images, shapes,
// whiteout and sticky notes — each with a page and page-normalised position/size.
let docItems = [];          // {id,type,page,nx,ny,nw,ar,opacity,signer,color,...}
let selId = null;
// Drawings (pen / highlighter / line / arrow / underline / strikethrough). Coords are
// normalised to the page (0..1); `size` is normalised to page width.
let docDraws = [];          // {id,kind,page,color,size,opacity,pts?|x0,y0,x1,y1}
let drawSeq = 1;
let signers = [{ id: "s1", name: "Signer 1", color: "#1b1b1f" }];
let activeSigner = "s1";
let itemSeq = 1;
let fieldValues = {};       // the PDF's own form fields: name -> value

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
    if (workMode === "pdf") return;
    if (workMode === "doc" && doc) return renderDoc();
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

// ---- document editor (multi-page, Smallpdf-style toolbar) ------------------
// Every page of the document is shown in one scrolling column. Each placed object
// ("item": signature, text, date, tick, form field, image, shape, whiteout, sticky
// note) and each drawing (pen, highlighter, line, arrow, underline, strikethrough)
// remembers its page. Coordinates are normalised to the page (0..1) so they survive
// zoom and export at any resolution.
function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function signerColor(id) { const s = signers.find((x) => x.id === id); return s ? s.color : "#1b1b1f"; }
function itemColor(it) { return it.color || signerColor(it.signer); }
function TRASH() { return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>'; }
const SVGNS = "http://www.w3.org/2000/svg";

let workMode = "write";            // write | doc | pdf
let docPages = [];                 // [{ img, w, h, url, fields, num }]
let curPage = 0;                   // page shown in the counter / used for new objects
let edZoom = 1;
let edTool = "select";             // the active toolbar tool
let selDraw = null;                // selected drawing id
let shapeFill = "none";
let docName = "document";
let pagesSig = "";                 // rebuild the page skeleton only when this changes
let loadToken = 0;
const REF_W = 800;                 // thickness slider units are px on an 800-px-wide page
const DRAW_TOOLS = new Set(["pen", "highlight", "line", "arrow", "underline", "strike"]);
const CLICK_TOOLS = new Set(["text", "sig", "date", "check", "note", "field:text", "field:date", "field:check", "field:sig"]);
const BOX_TOOLS = new Set(["shape:rect", "shape:ellipse", "whiteout"]);
const STICKY_TOOLS = new Set(["check"]);           // stay active after placing (tick many boxes)
const PALETTE = ["#1b1b1f", "#e23b3b", "#0055ff", "#1f9d55", "#f0a500", "#7c5cff", "#ffd400", "#ffffff"];
const toolColors = { pen: "#1b1b1f", highlight: "#ffd400", line: "#e23b3b", arrow: "#e23b3b", underline: "#0055ff", strike: "#e23b3b", "shape:rect": "#e23b3b", "shape:ellipse": "#e23b3b", note: "#ffd54f", whiteout: "#ffffff", text: "" };
const toolSizes = { pen: 3, highlight: 4, line: 3, arrow: 3, underline: 2, strike: 2, "shape:rect": 3, "shape:ellipse": 3 };
const TOOL_HINTS = {
  text: "Click on the page where the text should go.", sig: "Click on the page to place your signature (type it in the box on the right).",
  date: "Click on the page to add the date.", check: "Click each box to tick it. Choose Tick or Cross below once placed.",
  note: "Click on the page to stick a note.", "field:text": "Click to add a fillable text field.", "field:date": "Click to add a date field.",
  "field:check": "Click to add a checkbox field.", "field:sig": "Click to add a signature field.",
  "shape:rect": "Drag on the page to draw a rectangle.", "shape:ellipse": "Drag on the page to draw an ellipse.",
  whiteout: "Drag over anything you want to cover in white.", pen: "Draw freehand on the page.",
  highlight: "Drag across the text to highlight it.", underline: "Drag along the text to underline it.",
  strike: "Drag through the text to strike it out.", line: "Drag to draw a line.", arrow: "Drag to draw an arrow.",
};

function selectedItem() { return docItems.find((i) => i.id === selId); }
function selectedDraw() { return docDraws.find((d) => d.id === selDraw); }
function pageAspect(pi) { const p = docPages[pi] || doc; return p ? p.w / p.h : 0.77; }
function isFreeAspect(it) { return it.type === "shape" || it.type === "white" || (it.isField && it.fieldKind !== "check"); }
function isTextEditable(it) { return it.type === "text" && !it.isMark && !(it.isField && it.fieldKind === "check"); }

// ---- creating objects ------------------------------------------------------
// The visible middle of a page (where objects land when not placed by a click).
function defaultSpot(pi) {
  const pg = document.querySelector(`#ed_pages .pg[data-page="${pi}"]`), st = $("stage");
  if (!pg || !st) return [0.5, 0.25];
  const r = pg.getBoundingClientRect(), s = st.getBoundingClientRect();
  const top = Math.max(r.top, s.top), bot = Math.min(r.bottom, s.bottom);
  const y = bot > top ? ((top + bot) / 2 - r.top) / r.height : 0.25;
  return [0.5, Math.max(0.08, Math.min(0.92, y))];
}
function centerOn(it, x, y) {
  const hN = it.nw * it.ar * pageAspect(it.page || 0);
  it.nx = Math.max(0, Math.min(1 - it.nw, x - it.nw / 2));
  it.ny = Math.max(0, Math.min(Math.max(0, 1 - hN), y - hN / 2));
}
function pushItem(it, x, y) {
  it.id = "it" + itemSeq++;
  if (it.page == null) it.page = curPage;
  if (it.opacity == null) it.opacity = 1;
  if (!it.signer) it.signer = activeSigner;
  if (x == null) [x, y] = defaultSpot(it.page);
  centerOn(it, x, y);
  docItems.push(it); selId = it.id; selDraw = null;
  return it;
}

function currentSignature() {
  if (sigSVG && toggles.usesig) return { svg: sigSVG, w: sigBox.w, h: sigBox.h };   // traced image (currentColor)
  const svg = makeHandwriting(Math.round((doc ? doc.w : 800) * 0.5));                // generated handwriting
  return { svg: cleanSigSVG(svg), w: hwW, h: hwH };
}
// Async: sample a fresh signature SVG for text/params (awaits the worker).
async function generateSig(text, p) {
  const bias = neuralBias();
  const key = text + "|" + bias.toFixed(3) + "|" + p.seed;
  // Geometry depends only on text+bias+seed; thickness/slant/nib/spacing/size are
  // styled cheaply from the cached strokes, so those edits redraw instantly.
  let lines = neuralCache.get(key);
  if (!lines) {
    const lineTexts = (mode === "signature") ? [text] : String(text).split("\n");
    lines = await sampleLines(lineTexts, bias, p.seed);
    neuralCache.set(key, lines);
  }
  let svg = buildNeuralSVG(lines, p);
  if (mode === "signature") svg = addFlourish(svg);
  svg = svg.replace("<svg ", `<svg style="color:${ink}" `);
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 1, h = +(svg.match(/height="(\d+)"/) || [])[1] || 1;
  return { svg: cleanSigSVG(svg), w, h };
}
function addSigItem(x, y) {
  if (!doc) return null;
  const traced = !!(sigSVG && toggles.usesig);
  if (!traced && !textForEngine()) { toast("Type your name in the box on the right first."); return null; }
  const g = currentSignature();
  const it = pushItem({ type: "sig", nw: 0.3, ar: (g.h / g.w) || 0.3, svg: g.svg, dynamic: !traced, text: textForEngine(), seed: +$("seed").value }, x, y);
  render();
  if (it.dynamic) regenItem(it, undefined, true);
  return it;
}
function addTextItem(x, y) {
  if (!doc) return null;
  const it = pushItem({ type: "text", nw: 0.26, ar: 0.16, text: "Type here", font: 5, color: toolColors.text || undefined }, x, y);
  render(); focusInlineEdit(it.id);
  return it;
}
// Focus a freshly placed text item for immediate inline typing (after render rebuilds the DOM).
function focusInlineEdit(id) {
  const it = docItems.find((i) => i.id === id); if (!it || it.type !== "text") return;
  requestAnimationFrame(() => {
    const el = document.querySelector(`#ed_pages .ditem[data-id="${id}"]`); if (el) startInlineEdit(it, el);
  });
}
// DocuSign-style timestamp: "MM/DD/YYYY | H:MM AM/PM TZ".
const TZ_LIST = ["PST", "PDT", "MST", "MDT", "CST", "CDT", "EST", "EDT", "AKST", "AKDT", "HST", "GMT", "UTC", "BST", "CET", "CEST", "EET", "IST", "JST", "KST", "AEST", "AEDT", "NZST"];
function pad2(n) { return String(n).padStart(2, "0"); }
function localTzAbbr() {
  try { const m = new Date().toLocaleTimeString("en-US", { timeZoneName: "short" }).match(/[A-Z]{2,5}$/); return (m && m[0]) || "UTC"; }
  catch { return "UTC"; }
}
function fmtDocuSign(dateStr, timeStr, tz) {
  const [y, m, d] = (dateStr || "").split("-").map(Number);
  let [hh, mm] = (timeStr || "0:0").split(":").map(Number);
  if (!y || !m || !d) return "";
  const ap = hh >= 12 ? "PM" : "AM";
  let h12 = hh % 12; if (h12 === 0) h12 = 12;
  return `${pad2(m)}/${pad2(d)}/${y} | ${h12}:${pad2(mm || 0)} ${ap} ${tz}`;
}
function nowParts() {
  const now = new Date();
  return { date: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`, time: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, tz: localTzAbbr() };
}
function addDateItem(x, y) {
  if (!doc) return null;
  const { date, time, tz } = nowParts();
  const it = pushItem({ type: "text", isDate: true, date, time, tz, nw: 0.36, ar: 0.11, text: fmtDocuSign(date, time, tz), font: 0 }, x, y);
  render(); return it;
}
// Checkbox mark: a placeable ✓ or X stamp for ticking boxes on a form.
function markGlyph(m) { return m === "x" ? "X" : "✓"; }
function addCheckItem(x, y) {
  if (!doc) return null;
  const it = pushItem({ type: "text", isMark: true, mark: "check", nw: 0.045, ar: 1, text: "✓", font: 5 }, x, y);
  render(); return it;
}
function setMark(m) { const it = selectedItem(); if (!it || !it.isMark) return; it.mark = m; it.text = markGlyph(m); render(); }
// Form-builder fields are `isField` items with a `fieldKind`; a fillable export turns
// them into real AcroForm fields, flattened exports draw them as boxes.
function addFieldItem(kind, x, y) {
  if (!doc) return null;
  let it;
  if (kind === "date") {
    const { date, time, tz } = nowParts();
    it = pushItem({ type: "text", isField: true, fieldKind: "date", isDate: true, label: "Date", date, time, tz, text: fmtDocuSign(date, time, tz), nw: 0.36, ar: 0.12, font: 0 }, x, y);
  } else if (kind === "check") {
    it = pushItem({ type: "text", isField: true, fieldKind: "check", label: "", checked: false, text: "", nw: 0.04, ar: 1, font: 5 }, x, y);
  } else if (kind === "sig") {
    it = pushItem({ type: "text", isField: true, fieldKind: "sig", label: "Signature", text: "", nw: 0.3, ar: 0.16, font: 0 }, x, y);
  } else {
    it = pushItem({ type: "text", isField: true, fieldKind: "text", label: "Text", text: "", nw: 0.28, ar: 0.14, font: 5 }, x, y);
  }
  render();
  if (kind === "text" || kind === "sig") focusInlineEdit(it.id);
  return it;
}
function addNoteItem(x, y) {
  if (!doc) return null;
  const s = signers.find((q) => q.id === activeSigner);
  const it = pushItem({ type: "note", nw: 0.034, ar: 1, text: "", color: toolColors.note, author: s ? s.name : "", created: new Date().toISOString() }, x, y);
  render();
  requestAnimationFrame(() => { const ta = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"] .notepop textarea`); if (ta) ta.focus(); });
  return it;
}
// Images are downscaled (max 1600 px) so documents and undo history stay light.
function pickImageForDoc() {
  const inp = document.createElement("input"); inp.type = "file"; inp.accept = "image/*";
  inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) insertImageFile(f); };
  inp.click();
}
function insertImageFile(f) {
  if (!doc) return;
  const url = URL.createObjectURL(f), im = new Image();
  im.onload = () => {
    const k = Math.min(1, 1600 / Math.max(im.naturalWidth, im.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    const png = /png|gif|webp|svg/i.test(f.type);
    const src = c.toDataURL(png ? "image/png" : "image/jpeg", 0.9);
    URL.revokeObjectURL(url);
    pushItem({ type: "img", src, nw: 0.32, ar: c.height / c.width });
    render(); toast("Image added — drag it into place, resize from a corner.");
  };
  im.onerror = () => toast("That picture could not be read.");
  im.src = url;
}
function deleteItem(id) { docItems = docItems.filter((i) => i.id !== id); if (selId === id) selId = null; render(); }
function deleteSelection() {
  if (selId) { deleteItem(selId); return true; }
  if (selDraw) { docDraws = docDraws.filter((d) => d.id !== selDraw); selDraw = null; render(); return true; }
  return false;
}
function duplicateSelection() {
  const it = selectedItem();
  if (it) { const c = { ...it, id: "it" + itemSeq++, nx: Math.min(0.95, it.nx + 0.02), ny: Math.min(0.95, it.ny + 0.02) }; docItems.push(c); selId = c.id; render(); return; }
  const d = selectedDraw();
  if (d) {
    const c = JSON.parse(JSON.stringify(d)); c.id = "dr" + drawSeq++;
    shiftDraw(c, 0.02, 0.02); docDraws.push(c); selDraw = c.id; render();
  }
}
// Re-roll / refresh a placed dynamic signature using the current realism controls.
async function regenItem(it, newSeed, quiet) {
  if (!it || it.type !== "sig" || !it.dynamic) return;
  if (newSeed != null) it.seed = newSeed;
  const p = params(Math.round((doc ? doc.w : 800) * 0.5));
  p.seed = it.seed;
  try { const g = await generateSig(it.text, p); it.svg = g.svg; it.ar = g.h / g.w; render(); if (!quiet) toast("Updated signature."); }
  catch (e) { errEl.textContent = "Could not re-roll: " + (e.message || e); }
}

// ---- pages: view, zoom, thumbnails, current page ---------------------------
function pageDispW() {
  const st = $("stage"); const avail = Math.max(260, (st ? st.clientWidth : 900) - 80);
  return Math.round(Math.min(avail, 860) * edZoom);
}
let pageObserver = null;
const pageRatios = new Map();
function observePages() {
  if (pageObserver) pageObserver.disconnect();
  pageRatios.clear();
  if (!("IntersectionObserver" in window)) return;
  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) pageRatios.set(+e.target.dataset.page, e.intersectionRatio);
    let best = curPage, bestR = -1;
    for (const [i, r] of pageRatios) if (r > bestR + 0.001) { best = i; bestR = r; }
    if (bestR > 0 && best !== curPage) setCurPage(best, false);
  }, { root: $("stage"), threshold: [0, 0.15, 0.35, 0.5, 0.65, 0.85, 1] });
  document.querySelectorAll("#ed_pages .pg").forEach((pg) => pageObserver.observe(pg));
}
function setCurPage(i, scroll) {
  if (!docPages.length) return;
  curPage = Math.max(0, Math.min(docPages.length - 1, i));
  doc = docPages[curPage] || doc;
  document.querySelectorAll("#ed_thumbs .thumb").forEach((t) => t.classList.toggle("cur", +t.dataset.page === curPage));
  const ctr = $("ed_pagectr"); if (ctr) ctr.textContent = (curPage + 1) + " / " + docPages.length;
  if (scroll) { const pg = document.querySelector(`#ed_pages .pg[data-page="${curPage}"]`); if (pg) pg.scrollIntoView({ block: "start", behavior: "smooth" }); }
  const th = document.querySelector(`#ed_thumbs .thumb[data-page="${curPage}"]`);
  if (th && th.scrollIntoViewIfNeeded) th.scrollIntoViewIfNeeded(false);
}
function renderThumbs() {
  const host = $("ed_thumbs"); if (!host) return;
  host.innerHTML = docPages.map((p, i) => `<button class="thumb${i === curPage ? " cur" : ""}" data-page="${i}" title="Page ${i + 1}"><img src="${p.url}" alt="" style="aspect-ratio:${p.w}/${p.h}">${i + 1}</button>`).join("");
  host.querySelectorAll(".thumb").forEach((b) => b.onclick = () => setCurPage(+b.dataset.page, true));
}
// A late-rendered page swaps its picture in place (no rebuild, so editing isn't interrupted).
function updatePageImage(i) {
  const p = docPages[i]; if (!p) return;
  const im = document.querySelector(`#ed_pages .pg[data-page="${i}"] > img`); if (im) im.src = p.url;
  const th = document.querySelector(`#ed_thumbs .thumb[data-page="${i}"] img`); if (th) th.src = p.url;
}
function setZoom(z) {
  const st = $("stage"); const frac = st && st.scrollHeight ? st.scrollTop / st.scrollHeight : 0;
  edZoom = Math.max(0.4, Math.min(3, Math.round(z * 100) / 100));
  render();
  if (st) requestAnimationFrame(() => { st.scrollTop = frac * st.scrollHeight; });
}
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
function zoomStep(dir) {
  const i = ZOOMS.findIndex((z) => z >= edZoom - 0.001);
  const cur = i < 0 ? ZOOMS.length - 1 : i;
  setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, cur + dir))]);
}

function renderDoc() {
  const host = $("ed_pages"); if (!host) return;
  const W = pageDispW();
  const sig = docPages.length + "|" + W + "|" + docPages.map((p) => p.w + "x" + p.h).join(",");
  if (sig !== pagesSig) {
    pagesSig = sig; host.innerHTML = "";
    docPages.forEach((p, i) => {
      const H = Math.round(W * p.h / p.w);
      const pg = document.createElement("div"); pg.className = "pg"; pg.dataset.page = i;
      pg.style.width = W + "px"; pg.style.height = H + "px";
      pg.innerHTML = `<img src="${p.url}" alt="Page ${i + 1}" draggable="false"><div class="pgov" style="width:${W}px;height:${H}px"></div>`;
      host.appendChild(pg);
    });
    renderThumbs(); observePages();
  }
  const sp = scanParams(), filt = previewFilter(), tf = scanTransform();
  host.querySelectorAll(".pg").forEach((pg) => {
    const i = +pg.dataset.page, p = docPages[i]; if (!p) return;
    const dispW = W, dispH = Math.round(W * p.h / p.w);
    pg.style.filter = filt; pg.style.transform = tf;
    pg.style.outline = (sp.on && sp.border) ? "6px solid rgba(22,19,14,0.9)" : ""; pg.style.outlineOffset = "-3px";
    const ov = pg.querySelector(".pgov"); ov.innerHTML = "";
    ov.onpointerdown = (e) => onPagePointerDown(e, ov, i, dispW, dispH);
    renderDraws(ov, dispW, dispH, i, true);           // highlighter: under the objects
    renderFields(ov, dispW, dispH, p.fields || []);
    docItems.forEach((it) => { if ((it.page || 0) === i) ov.appendChild(itemEl(it, dispW, dispH)); });
    renderDraws(ov, dispW, dispH, i, false);          // ink, lines, arrows, marks: on top
  });
  document.body.classList.toggle("placing", edTool !== "select");
  syncItemUI(); updateEdChrome();
  // Each discrete change is its own undo step; slider drags settle into one on release.
  if (holdSnap) scheduleSnapshot(); else snapshotNow();
}

function onPagePointerDown(e, ov, pi, dispW, dispH) {
  if (e.button && e.button !== 0) return;
  if (pi !== curPage) setCurPage(pi, false);
  if (DRAW_TOOLS.has(edTool)) { startDraw(e, ov, dispW, dispH, pi); return; }
  if (BOX_TOOLS.has(edTool)) { startBoxCreate(e, ov, dispW, dispH, pi); return; }
  if (CLICK_TOOLS.has(edTool)) {
    e.preventDefault();
    const r = ov.getBoundingClientRect();
    placeAt(edTool, pi, (e.clientX - r.left) / dispW, (e.clientY - r.top) / dispH);
    return;
  }
  const t = e.target;
  if (t === ov || (t.tagName && t.tagName.toLowerCase() === "svg")) { if (selId || selDraw) { selId = null; selDraw = null; render(); } }
}
function placeAt(tool, pi, x, y) {
  curPage = pi; doc = docPages[pi] || doc;
  // Leave placing mode first so the new object is immediately clickable/editable.
  if (!STICKY_TOOLS.has(tool)) { edTool = "select"; document.body.classList.remove("placing"); }
  if (tool === "text") addTextItem(x, y);
  else if (tool === "sig") addSigItem(x, y);
  else if (tool === "date") addDateItem(x, y);
  else if (tool === "check") addCheckItem(x, y);
  else if (tool === "note") addNoteItem(x, y);
  else if (tool.startsWith("field:")) addFieldItem(tool.split(":")[1], x, y);
}
// Drag out a rectangle / ellipse / whiteout box (a click makes a default-size one).
function startBoxCreate(e, ov, dispW, dispH, pi) {
  e.preventDefault();
  try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  const r = ov.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, tool = edTool;
  const ghost = document.createElement("div");
  ghost.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;width:0;height:0;border:1.5px dashed #0055ff;background:rgba(0,85,255,.06);pointer-events:none;${tool === "shape:ellipse" ? "border-radius:50%" : ""}`;
  ov.appendChild(ghost);
  let bx = sx, by = sy, bw = 0, bh = 0;
  const mv = (ev) => {
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    bx = Math.min(sx, x); by = Math.min(sy, y); bw = Math.abs(x - sx); bh = Math.abs(y - sy);
    ghost.style.left = bx + "px"; ghost.style.top = by + "px"; ghost.style.width = bw + "px"; ghost.style.height = bh + "px";
  };
  const up = () => {
    ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up); ghost.remove();
    if (bw < 6 || bh < 6) { bw = dispW * 0.22; bh = tool === "whiteout" ? dispW * 0.05 : dispW * 0.13; bx = sx - bw / 2; by = sy - bh / 2; }
    const it = { id: "it" + itemSeq++, page: pi, nx: bx / dispW, ny: by / dispH, nw: bw / dispW, ar: bh / bw, opacity: 1, signer: activeSigner };
    if (tool === "whiteout") { it.type = "white"; it.color = toolColors.whiteout || "#ffffff"; }
    else { it.type = "shape"; it.shape = tool.split(":")[1]; it.color = toolColors[tool]; it.sw = toolSizes[tool] / REF_W; it.fill = shapeFill === "solid" ? toolColors[tool] : "none"; }
    docItems.push(it); selId = it.id; selDraw = null;
    setEdTool("select");
  };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}

// ---- one placed object -> DOM ---------------------------------------------
function shapeSVG(it, w, h) {
  const sw = Math.max(1, (it.sw || 3 / REF_W) * (w / it.nw)), fill = it.fill && it.fill !== "none" ? it.fill : "none", c = itemColor(it);
  const inner = it.shape === "ellipse"
    ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(1, w / 2 - sw / 2)}" ry="${Math.max(1, h / 2 - sw / 2)}" fill="${fill}" stroke="${c}" stroke-width="${sw}"/>`
    : `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(1, w - sw)}" height="${Math.max(1, h - sw)}" fill="${fill}" stroke="${c}" stroke-width="${sw}"/>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible;pointer-events:none">${inner}</svg>`;
}
const NOTE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h10M5 10.5h10M5 14h6"/></svg>';
function itemEl(it, dispW, dispH) {
  const w = it.nw * dispW, h = it.nw * dispW * it.ar;
  const el = document.createElement("div");
  el.className = "ditem" + (it.id === selId ? " sel" : "");
  el.dataset.id = it.id;
  el.style.cssText = `left:${it.nx * dispW}px;top:${it.ny * dispH}px;width:${w}px;height:${h}px;opacity:${it.opacity ?? 1};color:${itemColor(it)}`;
  if (it.type === "sig") el.innerHTML = it.svg.replace("<svg ", '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block;pointer-events:none" ');
  else if (it.type === "img") el.innerHTML = `<img src="${it.src}" alt="" draggable="false" style="width:100%;height:100%;display:block;pointer-events:none">`;
  else if (it.type === "shape") el.innerHTML = shapeSVG(it, w, h);
  else if (it.type === "white") el.style.background = it.color || "#fff";
  else if (it.type === "note") {
    el.innerHTML = `<div class="dnote" style="--nc:${it.color || "#ffd54f"}">${NOTE_ICON}</div>`;
    if (it.id === selId) {
      const pop = document.createElement("div"); pop.className = "notepop";
      const when = it.created ? new Date(it.created).toLocaleString() : "";
      pop.innerHTML = `<div class="nmeta">${escapeHTML(it.author || "Note")}${when ? " · " + escapeHTML(when) : ""}</div><textarea placeholder="Write a comment…"></textarea>`;
      const ta = pop.querySelector("textarea"); ta.value = it.text || "";
      ta.oninput = () => { it.text = ta.value; };
      ta.onblur = () => scheduleSnapshot();
      pop.onpointerdown = (e) => e.stopPropagation();
      el.appendChild(pop);
    }
  } else {
    const fam = DOC_FONTS[it.font || 0].css;
    if (it.isField && it.fieldKind === "check") {
      el.innerHTML = `<div class="dfieldbox" style="display:flex;align-items:center;justify-content:center">` +
        (it.checked ? `<span style="font-weight:700;font-size:${h * 0.8}px;line-height:1">✓</span>` : "") + `</div>`;
    } else if (it.isField) {
      el.innerHTML = `<div class="dfieldbox"><span class="dfcap">${escapeHTML(it.label || "")}</span>` +
        `<div class="dtext" style="font-size:${h * 0.5}px;font-family:${fam}">${escapeHTML(it.text || "")}</div></div>`;
    } else {
      const extra = it.isMark ? "justify-content:center;font-weight:700;" : "";
      el.innerHTML = `<div class="dtext" style="${extra}font-size:${h * 0.7}px;font-family:${fam}">${escapeHTML(it.text)}</div>`;
    }
  }
  el.onpointerdown = (e) => {
    if (edTool !== "select") return;                 // placing tools act on the page underneath
    if (e.target.classList.contains("dhandle") || e.target.closest(".dtrash") || e.target.closest(".notepop") || e.target.isContentEditable) return;
    e.preventDefault(); e.stopPropagation();
    const wasSel = selId === it.id;
    selId = it.id; selDraw = null;
    document.querySelectorAll("#ed_pages .ditem.sel").forEach((x) => { if (x !== el) x.classList.remove("sel"); });
    el.classList.add("sel"); syncItemUI(); updateEdChrome();
    startMove(it, el, e, dispW, dispH, wasSel);
  };
  if (isTextEditable(it)) el.ondblclick = () => { selId = it.id; startInlineEdit(it, el); };
  if (it.isField && it.fieldKind === "check") el.ondblclick = () => { it.checked = !it.checked; render(); };
  if (it.id === selId) {
    ["nw", "ne", "sw", "se"].forEach((corner) => {
      const hd = document.createElement("div"); hd.className = "dhandle " + corner;
      hd.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); startResize(it, el, corner, e, dispW, dispH); };
      el.appendChild(hd);
    });
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
  td.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); td.blur(); } if (ev.key === "Escape") td.blur(); };
}

function startMove(it, el, e, dispW, dispH, wasSel) {
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const sx = e.clientX, sy = e.clientY, ox = it.nx, oy = it.ny;
  let moved = false;
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    it.nx = Math.max(-0.1, Math.min(0.98, ox + (ev.clientX - sx) / dispW));
    it.ny = Math.max(-0.1, Math.min(0.98, oy + (ev.clientY - sy) / dispH));
    el.style.left = it.nx * dispW + "px"; el.style.top = it.ny * dispH + "px";
  };
  const up = () => {
    el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
    if (!moved && wasSel) {
      // Clicking an already-selected object edits it (text) or toggles it (checkbox field).
      if (isTextEditable(it)) { startInlineEdit(it, el); return; }
      if (it.isField && it.fieldKind === "check") { it.checked = !it.checked; render(); return; }
    }
    render();
  };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}
function startResize(it, el, corner, e, dispW, dispH) {
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const sx = e.clientX, sy = e.clientY;
  const ow = it.nw * dispW, oh = it.nw * dispW * it.ar, ox = it.nx * dispW, oy = it.ny * dispH;
  const west = corner.includes("w"), north = corner.includes("n"), free = isFreeAspect(it);
  const mv = (ev) => {
    let dx = ev.clientX - sx, dy = ev.clientY - sy; if (west) dx = -dx; if (north) dy = -dy;
    let w, h;
    if (free) { w = Math.max(8, ow + dx); h = Math.max(6, oh + dy); }
    else { const s = Math.max((ow + dx) / ow, (oh + dy) / oh, 10 / ow); w = ow * s; h = w * it.ar; }
    it.nw = w / dispW; if (free) it.ar = h / w;
    const nx = west ? ox + (ow - w) : ox, ny = north ? oy + (oh - h) : oy;
    it.nx = nx / dispW; it.ny = ny / dispH;
    el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = nx + "px"; el.style.top = ny + "px";
    if (it.type === "text" && !it.isField) { const td = el.querySelector(".dtext"); if (td) td.style.fontSize = h * 0.7 + "px"; }
    if (it.type === "shape") el.innerHTML = shapeSVG(it, w, h);
  };
  const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); render(); };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}

// ---- the PDF's own fillable form fields --------------------------------------
function renderFields(ov, dispW, dispH, fields) {
  (fields || []).forEach((f) => {
    const x = f.nx * dispW, y = f.ny * dispH, w = f.nw * dispW, h = f.nh * dispH;
    if (f.type === "check") {
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "dfield";
      cb.checked = !!fieldValues[f.name]; cb.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(14, h)}px;height:${Math.max(14, h)}px`;
      cb.onchange = () => { fieldValues[f.name] = cb.checked; scheduleSnapshot(); };
      ov.appendChild(cb);
    } else {
      const inp = document.createElement("input"); inp.type = "text"; inp.className = "dfield";
      inp.value = fieldValues[f.name] || ""; inp.placeholder = f.name || "";
      inp.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${Math.min(h * 0.7, 16)}px`;
      inp.oninput = () => { fieldValues[f.name] = inp.value; };
      inp.onchange = () => scheduleSnapshot();
      ov.appendChild(inp);
    }
  });
}

// ---- drawings: pen / highlighter / line / arrow / underline / strikethrough ---
const LINE_KINDS = new Set(["line", "arrow", "underline", "strike"]);
function arrowHead(x0, y0, x1, y1, sw) {
  const ang = Math.atan2(y1 - y0, x1 - x0), L = Math.max(8, sw * 3.2), a = 0.5;
  const ax = x1 - L * Math.cos(ang - a), ay = y1 - L * Math.sin(ang - a);
  const bx = x1 - L * Math.cos(ang + a), by = y1 - L * Math.sin(ang + a);
  return `M${ax.toFixed(1)},${ay.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}`;
}
function drawGeom(d, W, H) {
  if (d.pts) {
    const p = d.pts.map((q) => [(q[0] * W).toFixed(1), (q[1] * H).toFixed(1)]);
    return { path: "M" + p[0][0] + "," + p[0][1] + p.slice(1).map((q) => "L" + q[0] + "," + q[1]).join("") };
  }
  return { x0: d.x0 * W, y0: d.y0 * H, x1: d.x1 * W, y1: d.y1 * H };
}
// One drawing -> SVG markup, sized to a W×H target (preview or export width).
function drawMarkup(d, W, H) {
  const sw = Math.max(0.5, d.size * W), col = d.color, op = d.opacity ?? 1;
  if (d.kind === "pen" || d.kind === "highlight") {
    if (!d.pts || !d.pts.length) return "";
    const g = drawGeom(d, W, H);
    const hl = d.kind === "highlight" ? ` stroke-opacity="${(0.4 * op).toFixed(3)}" style="mix-blend-mode:multiply"` : ` stroke-opacity="${op}"`;
    return `<path d="${g.path}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${hl}/>`;
  }
  const { x0, y0, x1, y1 } = drawGeom(d, W, H);
  const line = `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-opacity="${op}"/>`;
  if (d.kind === "rect") { // older documents
    const x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-opacity="${op}"/>`;
  }
  if (d.kind === "arrow") return line + `<path d="${arrowHead(x0, y0, x1, y1, sw)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${op}"/>`;
  return line;
}
// A wide invisible stroke that makes thin drawings easy to click.
function hitMarkup(d, W, H) {
  const sw = Math.max(14, d.size * W + 10);
  if (d.pts) return `<path class="drawhit" d="${drawGeom(d, W, H).path}" fill="none" stroke="transparent" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const { x0, y0, x1, y1 } = drawGeom(d, W, H);
  if (d.kind === "rect") { const x = Math.min(x0, x1), y = Math.min(y0, y1); return `<rect class="drawhit" x="${x}" y="${y}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" fill="none" stroke="transparent" stroke-width="${sw}"/>`; }
  return `<line class="drawhit" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="transparent" stroke-width="${sw}" stroke-linecap="round"/>`;
}
function drawBounds(d) {
  if (d.pts) { let a = 1e9, b = 1e9, c = -1e9, e = -1e9; for (const q of d.pts) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); e = Math.max(e, q[1]); } return [a, b, c, e]; }
  return [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)];
}
function shiftDraw(d, dx, dy) {
  if (d.pts) d.pts = d.pts.map((q) => [q[0] + dx, q[1] + dy]);
  else { d.x0 += dx; d.x1 += dx; d.y0 += dy; d.y1 += dy; }
}
function renderDraws(ov, dispW, dispH, pi, under) {
  const list = docDraws.filter((d) => (d.page || 0) === pi && ((d.kind === "highlight") === under));
  const svg = document.createElementNS(SVGNS, "svg");
  svg.classList.add(under ? "drawunder" : "drawlayer");
  svg.setAttribute("width", dispW); svg.setAttribute("height", dispH);
  svg.setAttribute("viewBox", `0 0 ${dispW} ${dispH}`);
  svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible";
  svg.innerHTML = list.map((d) => {
    let sel = "";
    if (d.id === selDraw) { const [a, b, c, e] = drawBounds(d), pad = Math.max(6, d.size * dispW); sel = `<rect class="drawsel" x="${a * dispW - pad}" y="${b * dispH - pad}" width="${(c - a) * dispW + pad * 2}" height="${(e - b) * dispH + pad * 2}"/>`; }
    return `<g data-did="${d.id}">${drawMarkup(d, dispW, dispH)}${hitMarkup(d, dispW, dispH)}${sel}</g>`;
  }).join("");
  ov.appendChild(svg);
  svg.querySelectorAll(".drawhit").forEach((hit) => {
    hit.style.pointerEvents = "stroke";
    hit.addEventListener("pointerdown", (e) => {
      if (edTool !== "select") return;
      e.preventDefault(); e.stopPropagation();
      const id = hit.parentNode.dataset.did;
      selDraw = id; selId = null;
      startMoveDraw(e, ov, id, dispW, dispH);
    });
  });
  return svg;
}
function startMoveDraw(e, ov, id, dispW, dispH) {
  const d = docDraws.find((x) => x.id === id); if (!d) return;
  try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  const sx = e.clientX, sy = e.clientY, orig = JSON.parse(JSON.stringify(d));
  const g = ov.querySelector(`[data-did="${id}"]`);
  let moved = false;
  const mv = (ev) => {
    const dx = (ev.clientX - sx) / dispW, dy = (ev.clientY - sy) / dispH;
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    Object.assign(d, JSON.parse(JSON.stringify(orig))); shiftDraw(d, dx, dy);
    if (g) g.innerHTML = drawMarkup(d, dispW, dispH);
  };
  const up = () => { ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up); render(); };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}
function startDraw(e, ov, dispW, dispH, pi) {
  e.preventDefault();
  try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  const r = ov.getBoundingClientRect();
  const pt = (ev) => [(ev.clientX - r.left) / dispW, (ev.clientY - r.top) / dispH];
  const kind = edTool, sz = toolSizes[kind] || 3;
  const d = { id: "dr" + drawSeq++, kind, page: pi, color: toolColors[kind] || "#1b1b1f", size: (kind === "highlight" ? sz * 5 : sz) / REF_W, opacity: 1 };
  const layer = ov.querySelector(kind === "highlight" ? "svg.drawunder" : "svg.drawlayer") || renderDraws(ov, dispW, dispH, pi, kind === "highlight");
  const g = document.createElementNS(SVGNS, "g"); layer.appendChild(g);
  const s = pt(e);
  if (kind === "pen" || kind === "highlight") d.pts = [s]; else { d.x0 = s[0]; d.y0 = s[1]; d.x1 = s[0]; d.y1 = s[1]; }
  const redraw = () => { g.innerHTML = drawMarkup(d, dispW, dispH); };
  redraw();
  const mv = (ev) => {
    const p = pt(ev);
    if (kind === "pen" || kind === "highlight") d.pts.push(p);
    else { d.x1 = p[0]; d.y1 = (kind === "underline" || kind === "strike") ? d.y0 : p[1]; }
    redraw();
  };
  const up = () => {
    ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up);
    const trivial = (kind === "pen" || kind === "highlight") ? (d.pts.length < 2) : (Math.hypot((d.x1 - d.x0) * dispW, (d.y1 - d.y0) * dispH) < 4);
    if (!trivial) docDraws.push(d);
    render();
  };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}
// Paint one page's drawings of the requested kinds onto an export canvas.
function drawAnnToCanvas(ctx, W, H, kinds, pi) {
  for (const d of docDraws) {
    if (!kinds.includes(d.kind) || (d.page || 0) !== (pi || 0)) continue;
    ctx.save();
    ctx.strokeStyle = d.color; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(0.5, d.size * W);
    ctx.globalAlpha = (d.opacity ?? 1) * (d.kind === "highlight" ? 0.4 : 1);
    if (d.kind === "highlight") ctx.globalCompositeOperation = "multiply";
    if (d.pts) {
      if (d.pts.length) { ctx.beginPath(); ctx.moveTo(d.pts[0][0] * W, d.pts[0][1] * H); for (let i = 1; i < d.pts.length; i++) ctx.lineTo(d.pts[i][0] * W, d.pts[i][1] * H); ctx.stroke(); }
    } else {
      const x0 = d.x0 * W, y0 = d.y0 * H, x1 = d.x1 * W, y1 = d.y1 * H;
      if (d.kind === "rect") ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      else { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
      if (d.kind === "arrow") {
        const ang = Math.atan2(y1 - y0, x1 - x0), Ln = Math.max(8, ctx.lineWidth * 3.2), a = 0.5;
        ctx.beginPath(); ctx.moveTo(x1 - Ln * Math.cos(ang - a), y1 - Ln * Math.sin(ang - a)); ctx.lineTo(x1, y1); ctx.lineTo(x1 - Ln * Math.cos(ang + a), y1 - Ln * Math.sin(ang + a)); ctx.stroke();
      }
    }
    ctx.restore();
  }
}
function roundRectPath(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

// ---- undo / redo (snapshots of the editable document state) -----------------
// Items are copied shallowly, so big signature / image strings are shared, not cloned.
let undoStack = [], redoStack = [], lastSnap = null, lastSnapSig = "", restoring = false, snapTimer = 0, holdSnap = false;
// Wrap continuous controls (sliders, colour wells) so a drag becomes one undo step.
function holdDuring(el, fn) {
  el.addEventListener("input", () => { holdSnap = true; fn(); });
  el.addEventListener("change", () => { holdSnap = false; snapshotNow(); });
}
function snapSig() {
  return JSON.stringify(docItems, (k, v) => (k === "svg" || k === "src") ? (v ? v.length + ":" + v.slice(-32) : v) : v) +
    "|" + JSON.stringify(docDraws) + "|" + JSON.stringify(fieldValues);
}
function takeSnap() { return { items: docItems.map((it) => ({ ...it })), draws: JSON.parse(JSON.stringify(docDraws)), fields: { ...fieldValues } }; }
function scheduleSnapshot() { if (restoring || !doc) return; clearTimeout(snapTimer); snapTimer = setTimeout(snapshotNow, 220); }
function snapshotNow() {
  clearTimeout(snapTimer);
  if (!doc || restoring) return;
  const s = snapSig(); if (s === lastSnapSig) return;
  if (lastSnap) { undoStack.push(lastSnap); if (undoStack.length > 60) undoStack.shift(); redoStack = []; }
  lastSnap = takeSnap(); lastSnapSig = s; updateUndoButtons();
}
function resetHistory() { undoStack = []; redoStack = []; lastSnap = takeSnap(); lastSnapSig = snapSig(); updateUndoButtons(); }
function restoreSnap(s) {
  restoring = true;
  docItems = s.items.map((it) => ({ ...it })); docDraws = JSON.parse(JSON.stringify(s.draws)); fieldValues = { ...s.fields };
  selId = null; selDraw = null;
  render(); lastSnapSig = snapSig(); restoring = false; updateUndoButtons();
}
function undo() { snapshotNow(); if (!undoStack.length) return; redoStack.push(lastSnap); lastSnap = undoStack.pop(); restoreSnap(lastSnap); }
function redo() { snapshotNow(); if (!redoStack.length) return; undoStack.push(lastSnap); lastSnap = redoStack.pop(); restoreSnap(lastSnap); }
function updateUndoButtons() {
  if ($("ed_undo")) $("ed_undo").disabled = !undoStack.length;
  if ($("ed_redo")) $("ed_redo").disabled = !redoStack.length;
}

// ---- toolbar + contextual options bar --------------------------------------
function closeDropdowns() { document.querySelectorAll(".dd.open").forEach((d) => d.classList.remove("open")); }
function setEdTool(t) {
  closeDropdowns();
  if (t === "edittext") { openEditTextFromDoc(); return; }
  if (t === "image") { setEdTool("select"); pickImageForDoc(); return; }
  edTool = t || "select";
  if (edTool !== "select") { selId = null; selDraw = null; }
  if (workMode === "doc") render();
}
function ctxShow(id, on) { const el = $(id); if (el) el.classList.toggle("on", !!on); }
function currentColor() {
  const it = selectedItem(), d = selectedDraw();
  if (it) return itemColor(it);
  if (d) return d.color;
  return toolColors[edTool] || "";
}
function updateEdChrome() {
  document.querySelectorAll("#ed_tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === edTool));
  document.querySelectorAll("#ed_tools [data-ddbtn]").forEach((b) => {
    const dd = b.closest(".dd"); b.classList.toggle("on", !![...dd.querySelectorAll(".ddm [data-tool]")].find((x) => x.dataset.tool === edTool));
  });
  if ($("ed_zval")) $("ed_zval").textContent = Math.round(edZoom * 100) + "%";
  if ($("ed_pagectr") && docPages.length) $("ed_pagectr").textContent = (curPage + 1) + " / " + docPages.length;
  updateUndoButtons();
  const it = selectedItem(), d = selectedDraw(), t = edTool;
  const hint = !it && !d && TOOL_HINTS[t];
  const hintEl = $("ctx_hint"); if (hintEl) hintEl.textContent = hint || (!it && !d ? "Pick a tool above, or click an object on the page to change it." : "");
  ctxShow("ctx_hint", !it && !d);
  const colorable = d || (it && ["text", "shape", "white", "note", "sig"].includes(it.type) && !(it.isField && it.fieldKind === "check")) ||
    (!it && !d && (DRAW_TOOLS.has(t) || BOX_TOOLS.has(t) || t === "note" || t === "text"));
  ctxShow("ctx_color", colorable);
  const cur = (currentColor() || "").toLowerCase();
  document.querySelectorAll("#ctx_dots .cdot").forEach((c) => c.classList.toggle("sel", c.dataset.c.toLowerCase() === cur));
  if (cur && /^#[0-9a-f]{6}$/i.test(cur) && $("draw_color")) $("draw_color").value = cur;
  const sizeable = d || (it && it.type === "shape") || (!it && !d && (DRAW_TOOLS.has(t) || t.startsWith("shape:")));
  ctxShow("ctx_size", sizeable);
  if (sizeable && $("draw_size")) {
    let v = toolSizes[t] || 3;
    if (d) v = Math.round(d.size * REF_W / (d.kind === "highlight" ? 5 : 1));
    else if (it && it.type === "shape") v = Math.round((it.sw || 3 / REF_W) * REF_W);
    $("draw_size").value = v;
  }
  const fillable = (it && it.type === "shape") || (!it && !d && t.startsWith("shape:"));
  ctxShow("ctx_fill", fillable);
  if (fillable) { const f = it ? (it.fill && it.fill !== "none" ? "solid" : "none") : shapeFill; document.querySelectorAll("#fill_seg button").forEach((b) => b.classList.toggle("sel", b.dataset.fill === f)); }
  ctxShow("item_font_row", it && it.type === "text" && !it.isMark && !(it.isField && it.fieldKind === "check"));
  ctxShow("item_date_row", it && it.isDate);
  ctxShow("item_mark_row", it && it.isMark);
  ctxShow("ctx_sig", it && it.type === "sig" && it.dynamic);
  ctxShow("ctx_opacity", it || d);
  ctxShow("ctx_actions", it || d);
  if (d && $("item_opacity")) { $("item_opacity").value = Math.round((d.opacity ?? 1) * 100); $("item_opacity_v").textContent = $("item_opacity").value + "%"; }
}
// Keep the option fields in step with the selected object.
function syncItemUI() {
  const it = selectedItem();
  if (it && it.isMark && $("mark_seg")) $("mark_seg").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.mark === it.mark));
  if (it && it.isDate) {
    if ($("item_date")) $("item_date").value = it.date || "";
    if ($("item_time")) $("item_time").value = it.time || "";
    if ($("item_tz")) $("item_tz").value = it.tz || "UTC";
  }
  if (it && it.type === "text" && $("item_font")) $("item_font").value = String(it.font || 0);
  if (it && $("item_opacity")) { $("item_opacity").value = Math.round((it.opacity ?? 1) * 100); $("item_opacity_v").textContent = $("item_opacity").value + "%"; }
  // Selecting a placed (generated) signature loads its words into the text box so
  // you can edit them live. Skip while the box is focused (don't fight typing).
  const ta = $("text");
  if (it && it.type === "sig" && it.dynamic && typeof it.text === "string" && ta && document.activeElement !== ta && ta.value !== it.text) ta.value = it.text;
}
function applyColor(c) {
  const it = selectedItem(), d = selectedDraw();
  if (it) { it.color = c; if (it.type === "shape" && it.fill && it.fill !== "none") it.fill = c; }
  else if (d) d.color = c;
  else toolColors[edTool] = c;
  render();
}
function applySize(v) {
  const it = selectedItem(), d = selectedDraw();
  if (d) d.size = (d.kind === "highlight" ? v * 5 : v) / REF_W;
  else if (it && it.type === "shape") it.sw = v / REF_W;
  else toolSizes[edTool] = v;
  render();
}
function applyFill(f) {
  shapeFill = f;
  const it = selectedItem();
  if (it && it.type === "shape") it.fill = f === "solid" ? itemColor(it) : "none";
  render();
}

// Hand the open PDF to the PDF tools' Edit Text mode (it edits the PDF's own words).
async function openEditTextFromDoc() {
  if (!docPdfBytes) { toast("Edit text works on PDFs — open a PDF first."); return; }
  if ((docItems.length || docDraws.length) && !confirm("Edit text changes the original PDF and won't keep the objects you've added here. Download your copy first if you need it. Continue?")) return;
  if (!window.__cal2OpenPdfEditorBytes) return;
  await window.__cal2OpenPdfEditorBytes(docPdfBytes.slice(), docName);
  location.hash = "#/pdf/edittext";
}

function animateSVG(svg) {
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 800, h = +(svg.match(/height="(\d+)"/) || [])[1] || 300;
  const speed = +$("speed").value; if (speed <= 0) return svg;
  // Ease-in-out spline makes the wipe accelerate in and settle out.
  const dur = ((6.5 - speed / 100 * 5.3) * 0.5).toFixed(2);
  const defs = `<defs><clipPath id="wo"><rect x="0" y="0" width="0" height="${h}">` +
    `<animate attributeName="width" from="0" to="${w}" dur="${dur}s" fill="freeze" ` +
    `calcMode="spline" keyTimes="0;1" keySplines="0.33 0 0.2 1"/></rect></clipPath></defs>`;
  return svg.replace("><g>", `>${defs}<g clip-path="url(#wo)">`);
}

// ---- opening documents ------------------------------------------------------
function isPdfFile(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""); }
async function openDocFile(f) {
  const ab = await f.arrayBuffer();
  const u8 = new Uint8Array(ab);
  const kind = isPdfFile(f) ? "pdf" : "image";
  await openDocBytes(u8.slice(), f.name, kind);
  rememberCurrentDoc(f.name, kind === "pdf" ? "application/pdf" : (f.type || "image/png"), u8).catch(() => {});
}
async function openDocBytes(u8, name, kind) {
  errEl.textContent = "";
  toast("Opening " + (name || "document") + "…");
  docName = name || "document";
  loadToken++;
  docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {}; docPages = []; pagesSig = ""; curPage = 0; edZoom = 1;
  if (kind === "pdf") await loadPDF(u8);
  else await loadImage(URL.createObjectURL(new Blob([u8])));
  setWorkMode("doc");
  edTool = "select";
  resetHistory(); render();
  toast("Opened " + docName + (docPages.length > 1 ? ` — ${docPages.length} pages` : "") + ".");
}
function closeDoc() {
  loadToken++;
  doc = null; pdfDocCache = null; docPdfBytes = null; docPages = []; pagesSig = ""; curPage = 0;
  docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {}; edTool = "select";
  if ($("ed_pages")) $("ed_pages").innerHTML = "";
  if ($("ed_thumbs")) $("ed_thumbs").innerHTML = "";
  resetHistory();
}
function baseName() { return (docName || "document").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "document"; }

// ---- recent documents (shared store with the PDF tools) ---------------------
async function rememberCurrentDoc(name, type, u8) {
  let thumb = "";
  try {
    const p = docPages[0];
    if (p && p.img) {
      const tw = 120, th = Math.max(1, Math.round(tw * p.h / p.w));
      const c = document.createElement("canvas"); c.width = tw; c.height = th;
      c.getContext("2d").drawImage(p.img, 0, 0, tw, th);
      thumb = c.toDataURL("image/jpeg", 0.6);
    }
  } catch (_) {}
  await saveRecent({ name, type: type === "application/pdf" ? "pdf" : "image", bytes: u8, thumb });
  renderSignRecents();
  if (window.__cal2RefreshHomeRecents) window.__cal2RefreshHomeRecents();
}
async function renderSignRecents() {
  const host = $("recent_sign"); if (!host) return;
  const list = await listRecents();
  host.innerHTML = list.length ? '<div class="rlabel">Recent</div>' : "";
  for (const r of list) host.appendChild(makeRecentCard(r, () => reopenRecent(r), async () => { await delRecent(r.id); renderSignRecents(); }));
}
async function reopenRecent(rec) {
  const full = await getRecent(rec.id); if (!full) return;
  try {
    await openDocBytes(new Uint8Array(full.bytes), full.name, full.type === "pdf" ? "pdf" : "image");
    if (!location.hash.startsWith("#/edit")) location.hash = "#/edit";
  } catch (e) { errEl.textContent = "Could not reopen: " + (e.message || e); }
}
async function loadImage(url) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  docPages = [{ img, w: img.naturalWidth, h: img.naturalHeight, url, fields: [], num: 1 }];
  doc = docPages[0]; docPdfBytes = null; pdfDocCache = null;
}
async function loadPDF(buf) {
  const pdfjsLib = window.pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  docPdfBytes = u8.slice();                                    // untouched copy for the fillable export
  pdfDocCache = await pdfjsLib.getDocument({ data: u8.slice() }).promise; // pdf.js detaches its buffer
  const n = pdfDocCache.numPages, token = loadToken;
  docPages = new Array(n);
  docPages[0] = await renderPdfPageObj(1);
  // The other pages get their real size straight away and a blank picture until rendered.
  for (let i = 2; i <= n; i++) {
    const pg = await pdfDocCache.getPage(i), vp = pg.getViewport({ scale: 2 });
    docPages[i - 1] = { img: null, w: Math.round(vp.width), h: Math.round(vp.height), url: BLANK_PAGE, fields: [], num: i };
  }
  doc = docPages[0];
  (async () => {
    for (let i = 2; i <= n; i++) {
      if (token !== loadToken) return;
      try { const p = await renderPdfPageObj(i); if (token !== loadToken) return; docPages[i - 1] = p; updatePageImage(i - 1); if (p.fields.length) render(); } catch (_) {}
    }
  })();
}
const BLANK_PAGE = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>');
async function ensurePageImage(pi) {
  const p = docPages[pi];
  if (p && p.img) return p;
  if (pdfDocCache) { docPages[pi] = await renderPdfPageObj(pi + 1); updatePageImage(pi); return docPages[pi]; }
  return p;
}
async function renderPdfPageObj(n) {
  const page = await pdfDocCache.getPage(Math.max(1, Math.min(pdfDocCache.numPages, n)));
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  const blob = await new Promise((res) => c.toBlob(res, "image/png"));
  const url = blob ? URL.createObjectURL(blob) : c.toDataURL("image/png");
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
  // the PDF's own fillable form fields on this page
  const fields = [];
  try {
    const ann = await page.getAnnotations();
    for (const a of ann) {
      if (a.subtype !== "Widget" || !a.rect) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x1 = Math.min(r[0], r[2]), y1 = Math.min(r[1], r[3]), x2 = Math.max(r[0], r[2]), y2 = Math.max(r[1], r[3]);
      const name = a.fieldName || a.id;
      const box = { name, nx: x1 / vp.width, ny: y1 / vp.height, nw: (x2 - x1) / vp.width, nh: (y2 - y1) / vp.height };
      if (a.fieldType === "Tx") { fields.push({ ...box, type: "text" }); if (a.fieldValue && fieldValues[name] == null) fieldValues[name] = a.fieldValue; }
      else if (a.fieldType === "Btn" && !a.pushButton && a.checkBox !== false) { fields.push({ ...box, type: "check" }); if (a.fieldValue != null && fieldValues[name] == null) fieldValues[name] = a.fieldValue !== "Off"; }
    }
  } catch (_) {}
  return { img, w: img.naturalWidth, h: img.naturalHeight, url, fields, num: n };
}

// ---- option fields shared with the bar above the page -----------------------
if ($("mark_seg")) $("mark_seg").querySelectorAll("button").forEach((b) => b.onclick = () => setMark(b.dataset.mark));
(function buildFontSelect() {
  const sel = $("item_font"); if (!sel) return;
  DOC_FONTS.forEach((f, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = f.name; sel.appendChild(o); });
  sel.onchange = () => { const it = selectedItem(); if (it && it.type === "text") { it.font = +sel.value; render(); } };
})();
(function buildTzSelect() {
  const sel = $("item_tz"); if (!sel) return;
  const local = localTzAbbr();
  const list = TZ_LIST.includes(local) ? TZ_LIST : [local, ...TZ_LIST];
  list.forEach((z) => { const o = document.createElement("option"); o.value = z; o.textContent = z; sel.appendChild(o); });
  const apply = () => {
    const it = selectedItem(); if (!it || !it.isDate) return;
    it.date = $("item_date").value || it.date;
    it.time = $("item_time").value || it.time;
    it.tz = $("item_tz").value || it.tz;
    it.text = fmtDocuSign(it.date, it.time, it.tz);
    render();
  };
  ["item_date", "item_time", "item_tz"].forEach((id) => { const el = $(id); if (el) el.addEventListener("input", apply); });
})();
$("item_opacity").oninput = () => {
  holdSnap = true;
  const it = selectedItem(), d = selectedDraw();
  $("item_opacity_v").textContent = $("item_opacity").value + "%";
  if (it) { it.opacity = +$("item_opacity").value / 100; render(); }
  else if (d) { d.opacity = +$("item_opacity").value / 100; render(); }
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

// Draw one placed object onto an export canvas (shared by every export).
const imgCache = new Map();
function loadImg(src) {
  if (imgCache.has(src)) return imgCache.get(src);
  const p = new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  imgCache.set(src, p); return p;
}
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || "").split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const t = line ? line + " " + word : word;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = word; } else line = t;
    }
    out.push(line);
  }
  return out;
}
async function drawDocItemToCtx(ctx, it, W, H, res) {
  const x = it.nx * W, y = it.ny * H, w = it.nw * W, h = it.nw * W * it.ar;
  ctx.save(); ctx.globalAlpha = it.opacity ?? 1;
  if (it.type === "sig") {
    const img = await svgToImage(it.svg.replace("<svg ", `<svg style="color:${itemColor(it)}" `));
    ctx.drawImage(img, x, y, w, h);
  } else if (it.type === "img") {
    try { ctx.drawImage(await loadImg(it.src), x, y, w, h); } catch (_) {}
  } else if (it.type === "white") {
    ctx.fillStyle = it.color || "#fff"; ctx.fillRect(x, y, w, h);
  } else if (it.type === "shape") {
    const sw = Math.max(1, (it.sw || 3 / REF_W) * W);
    ctx.lineWidth = sw; ctx.strokeStyle = itemColor(it);
    ctx.beginPath();
    if (it.shape === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2 - sw / 2), Math.max(1, h / 2 - sw / 2), 0, 0, Math.PI * 2);
    else ctx.rect(x + sw / 2, y + sw / 2, Math.max(1, w - sw), Math.max(1, h - sw));
    if (it.fill && it.fill !== "none") { ctx.fillStyle = it.fill; ctx.fill(); }
    ctx.stroke();
  } else if (it.type === "note") {
    // A flattened sticky note: the note icon plus its comment printed beside it.
    ctx.fillStyle = it.color || "#ffd54f"; roundRectPath(ctx, x, y, w, h, Math.min(w, h) * 0.18); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = Math.max(1, w * 0.07); ctx.lineCap = "round";
    [[0.25, 0.75, 0.35], [0.25, 0.75, 0.52], [0.25, 0.55, 0.69]].forEach(([a, b, c]) => { ctx.beginPath(); ctx.moveTo(x + w * a, y + h * c); ctx.lineTo(x + w * b, y + h * c); ctx.stroke(); });
    if (it.text && it.text.trim()) {
      const fs = Math.max(10, 13 * res), pad = 6 * res, boxW = Math.min(W * 0.32, 260 * res);
      ctx.font = `${fs}px system-ui, sans-serif`;
      const lines = wrapLines(ctx, it.text, boxW - pad * 2).slice(0, 14);
      const boxH = pad * 2 + lines.length * fs * 1.3;
      let bx = x + w + 6 * res; if (bx + boxW > W) bx = Math.max(0, x - boxW - 6 * res);
      const by = Math.min(y, H - boxH);
      ctx.fillStyle = "#fffbe6"; ctx.strokeStyle = "#e8d27a"; ctx.lineWidth = Math.max(1, res);
      roundRectPath(ctx, bx, by, boxW, boxH, 4 * res); ctx.fill(); ctx.stroke();
      ctx.fillStyle = "#3a3320"; ctx.textBaseline = "top";
      lines.forEach((ln, i) => ctx.fillText(ln, bx + pad, by + pad + i * fs * 1.3));
    }
  } else if (it.isField) {
    ctx.strokeStyle = "rgba(90,90,110,0.6)"; ctx.lineWidth = Math.max(1, W * 0.0012);
    roundRectPath(ctx, x, y, w, h, Math.min(8 * res, h * 0.2)); ctx.stroke();
    if (it.fieldKind === "check") {
      if (it.checked) { ctx.fillStyle = itemColor(it); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `700 ${h * 0.82}px system-ui, sans-serif`; ctx.fillText("✓", x + w / 2, y + h / 2); ctx.textAlign = "left"; }
    } else {
      if (it.label) { ctx.fillStyle = "rgba(80,80,100,0.9)"; ctx.textBaseline = "top"; ctx.font = `${Math.min(h * 0.24, 12 * res)}px system-ui, sans-serif`; ctx.fillText(it.label, x + 5 * res, y + 3 * res); }
      if (it.text) { ctx.fillStyle = itemColor(it); ctx.textBaseline = "alphabetic"; ctx.font = `${h * 0.42}px ${DOC_FONTS[it.font || 0].css}`; ctx.fillText(it.text, x + 6 * res, y + h * 0.82); }
    }
  } else {
    ctx.fillStyle = itemColor(it); ctx.font = `${it.isMark ? "700 " : ""}${h * 0.7}px ${DOC_FONTS[it.font || 0].css}`; ctx.textBaseline = "middle";
    if (it.isMark) { ctx.textAlign = "center"; ctx.fillText(it.text, x + w / 2, y + h / 2); ctx.textAlign = "left"; }
    else ctx.fillText(it.text, x, y + h / 2);
  }
  ctx.restore();
}
// Compose one page: the page picture, its form values, objects and drawings.
// annotationsOnly leaves out the page picture, interactive fields and notes (for the
// fillable export, which keeps the original PDF page underneath).
async function composePage(pi, res, annotationsOnly) {
  const p = await ensurePageImage(pi);
  const W = Math.round(p.w * res), H = Math.round(p.h * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!annotationsOnly) {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (p.img) ctx.drawImage(p.img, 0, 0, W, H);
  }
  drawAnnToCanvas(ctx, W, H, ["highlight"], pi);
  if (!annotationsOnly) for (const f of (p.fields || [])) {
    const v = fieldValues[f.name]; if (v == null || v === "" || v === false) continue;
    const x = f.nx * W, y = f.ny * H, w = f.nw * W, h = f.nh * H;
    ctx.fillStyle = "#15233a";
    if (f.type === "check") { ctx.font = `${h * 0.9}px system-ui, sans-serif`; ctx.textBaseline = "top"; ctx.fillText("X", x + w * 0.12, y); }
    else { ctx.font = `${Math.min(h * 0.72, 18 * res)}px system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.fillText(String(v), x + 3, y + h / 2); }
  }
  for (const it of docItems) {
    if ((it.page || 0) !== pi) continue;
    if (annotationsOnly && (it.isField || it.type === "note")) continue;
    await drawDocItemToCtx(ctx, it, W, H, res);
  }
  drawAnnToCanvas(ctx, W, H, ["pen", "line", "arrow", "underline", "strike", "rect"], pi);
  return c;
}
function pageHasContent(pi) { return docItems.some((it) => (it.page || 0) === pi) || docDraws.some((d) => (d.page || 0) === pi); }

async function composeCanvas() {   // the handwriting sheet (write mode)
  const res = +$("resolution").value;
  try { await document.fonts.ready; } catch (_) {}
  if (workMode === "doc" && doc) return finishCanvas(await composePage(curPage, res / 2));
  const W = Math.round(hwW * res), H = Math.round(hwH * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!toggles.transparent) { ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H); }
  const hwImg = await svgToImage(rawSVG);
  ctx.drawImage(hwImg, 0, 0, W, H);
  return finishCanvas(c);
}

function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
let toastTimer = 0;
function toast(m) {
  const t = $("toast"); if (!t) return;
  t.textContent = m; t.classList.add("on");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2600);
}
function flash(m) { toast(m); }
async function exportPNG() {
  try {
    const c = await composeCanvas();
    const name = workMode === "doc" && doc ? `${baseName()}-page${curPage + 1}.png` : "calligraphy.png";
    c.toBlob((b) => { download(name, b); toast("Saved PNG."); }, "image/png");
  } catch (e) { errEl.textContent = "PNG export failed: " + (e.message || e); }
}
// Flattened PDF: in the editor, every page with everything baked in; in write mode the sheet.
async function exportPDF() {
  try {
    const { jsPDF } = window.jspdf;
    if (workMode === "doc" && doc) {
      snapshotNow();
      try { await document.fonts.ready; } catch (_) {}
      // Page pictures are rendered at 2× the PDF's points; `res` 2 keeps them 1:1.
      const res = Math.max(1, +$("resolution").value) / 2 + 0.5;
      let pdf = null;
      for (let i = 0; i < docPages.length; i++) {
        toast(`Building PDF… page ${i + 1} of ${docPages.length}`);
        const c = finishCanvas(await composePage(i, res));
        const pw = c.width / (2 * res), ph = c.height / (2 * res), o = pw > ph ? "l" : "p";
        if (!pdf) pdf = new jsPDF({ orientation: o, unit: "pt", format: [pw, ph], compress: true });
        else pdf.addPage([pw, ph], o);
        pdf.addImage(c.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, pw, ph);
      }
      pdf.save(baseName() + "-edited.pdf"); toast("Saved " + baseName() + "-edited.pdf.");
      return;
    }
    const c = await composeCanvas();
    const landscape = c.width > c.height;
    const pdf = new jsPDF({ orientation: landscape ? "l" : "p", unit: "pt", format: [c.width / 2, c.height / 2] });
    pdf.addImage(c.toDataURL("image/png"), "PNG", 0, 0, c.width / 2, c.height / 2);
    pdf.save("calligraphy.pdf"); toast("Saved PDF.");
  } catch (e) { errEl.textContent = "PDF export failed: " + (e.message || e); }
}
function exportSVG() { download("calligraphy.svg", new Blob([mode === "signature" || +$("speed").value ? animateSVG(rawSVG) : rawSVG], { type: "image/svg+xml" })); toast("Saved SVG."); }

// Fillable PDF: the original pages (vector text kept when a PDF was opened) with
// signatures, writing, drawings and shapes baked in as a transparent overlay, the
// form-builder fields as real AcroForm widgets, and sticky notes as PDF comments.
async function exportFillablePDF() {
  if (!doc) { errEl.textContent = "Open a document first."; return; }
  const L = window.PDFLib;
  if (!L) { errEl.textContent = "PDF engine not loaded yet — try again in a moment."; return; }
  try {
    snapshotNow();
    toast("Building fillable PDF…");
    try { await document.fonts.ready; } catch (_) {}
    let pdf;
    if (docPdfBytes) pdf = await L.PDFDocument.load(docPdfBytes, { ignoreEncryption: true });
    else {
      pdf = await L.PDFDocument.create();
      const p = docPages[0];
      const page = pdf.addPage([p.w, p.h]);
      const bg = document.createElement("canvas"); bg.width = p.w; bg.height = p.h;
      bg.getContext("2d").drawImage(p.img, 0, 0, p.w, p.h);
      page.drawImage(await pdf.embedPng(bg.toDataURL("image/png")), { x: 0, y: 0, width: p.w, height: p.h });
    }
    const pages = pdf.getPages(), form = pdf.getForm();
    let nf = 0, nn = 0; const used = {};
    for (let i = 0; i < docPages.length; i++) {
      const page = pages[i]; if (!page || !pageHasContent(i)) continue;
      const { width: pw, height: ph } = page.getSize();
      const baked = docItems.some((it) => (it.page || 0) === i && !it.isField && it.type !== "note") || docDraws.some((d) => (d.page || 0) === i);
      if (baked) {
        const ann = await composePage(i, 1, true);
        page.drawImage(await pdf.embedPng(ann.toDataURL("image/png")), { x: 0, y: 0, width: pw, height: ph });
      }
      for (const it of docItems) {
        if ((it.page || 0) !== i) continue;
        const wf = it.nw * pw, hf = it.nw * pw * it.ar * (pageAspect(i) * ph / pw), x = it.nx * pw;
        if (it.type === "note") {
          try {
            const s = Math.max(14, Math.min(wf, 24)), y = ph - it.ny * ph - s;
            const hex = (it.color || "#ffd54f").replace("#", ""), rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
            const annot = pdf.context.obj({
              Type: "Annot", Subtype: "Text", Rect: [x, y, x + s, y + s], Name: "Comment", F: 4, Open: false,
              Contents: L.PDFHexString.fromText(it.text || ""), T: L.PDFHexString.fromText(it.author || "Note"), C: rgb,
            });
            const ref = pdf.context.register(annot);
            const annots = page.node.lookupMaybe(L.PDFName.of("Annots"), L.PDFArray);
            if (annots) annots.push(ref); else page.node.set(L.PDFName.of("Annots"), pdf.context.obj([ref]));
            nn++;
          } catch (_) {}
          continue;
        }
        if (!it.isField) continue;
        let name = ((it.label || it.fieldKind || "field") + "_" + it.id).replace(/[^\w.-]/g, "_");
        while (used[name]) name += "_"; used[name] = 1;
        try {
          if (it.fieldKind === "check") {
            const s = Math.min(wf, hf) || 14, y = ph - it.ny * ph - s;
            const cb = form.createCheckBox(name); cb.addToPage(page, { x, y, width: s, height: s });
            if (it.checked) cb.check();
          } else {
            const y = ph - it.ny * ph - hf;
            const tf = form.createTextField(name);
            if (it.text) tf.setText(String(it.text));
            tf.addToPage(page, { x, y, width: wf, height: hf });
          }
          nf++;
        } catch (_) {}
      }
    }
    // Carry over anything typed into the PDF's own existing form fields.
    for (const p of docPages) for (const f of (p.fields || [])) {
      const v = fieldValues[f.name]; if (v == null || v === "") continue;
      try { if (f.type === "check") { if (v) form.getCheckBox(f.name).check(); } else form.getTextField(f.name).setText(String(v)); } catch (_) {}
    }
    const bytes = await pdf.save();
    download(baseName() + "-fillable.pdf", new Blob([bytes], { type: "application/pdf" }));
    const bits = [nf ? `${nf} fillable field${nf > 1 ? "s" : ""}` : "", nn ? `${nn} comment${nn > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
    toast("Saved " + baseName() + "-fillable.pdf" + (bits ? " — " + bits : " (add fields from Fields ▾ to make it fillable)") + ".");
  } catch (e) { errEl.textContent = "Fillable PDF failed: " + (e.message || e); }
}

// ---- share links ---------------------------------------------------------

function st() {
  return { t: $("text").value, md: mode, sty: $("style").value, sp: +$("speed").value, lg: +$("legibility").value, th: +$("thickness").value,
    fp: +$("font_px").value, sl: +$("slant").value, ct: +$("contrast").value, spc: +$("spacing").value, ln: +$("line_spacing").value,
    al: align, sd: +$("seed").value, i: ink, p: paper, tx: texIdx, ti: +$("tex_intensity").value, ps: $("paper_style").value,
    tg: toggles, bl: +$("blur").value, shp: +$("sharpen").value, rs: +$("resolution").value, bm: +$("blemish").value };
}
// Share links live in the route as "#/write?s=<state>" (the hash also carries the page
// route, so state is no longer written into the address on every redraw).
function syncHash() {}
function shareStateFromURL() {
  const h = location.hash || "";
  const m = h.match(/[?&]s=([^&]+)/);
  if (m) return m[1];
  if (h.length > 1 && !h.startsWith("#/")) return h.slice(1);   // links made before routes existed
  return null;
}
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
function loadHash() {
  const s = shareStateFromURL(); if (!s) return false;
  try { applyState(JSON.parse(decodeURIComponent(atob(decodeURIComponent(s))))); return true; } catch { return false; }
}
async function copyLink() {
  const enc = encodeURIComponent(btoa(encodeURIComponent(JSON.stringify(st()))));
  const url = location.origin + location.pathname + "#/write?s=" + enc;
  try { await navigator.clipboard.writeText(url); toast("Shareable link copied."); }
  catch { history.replaceState(null, "", "#/write?s=" + enc); toast("Copy the link from the address bar."); }
}

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

// ---- boot ----------------------------------------------------------------

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderD = debounce(() => render(false), 90);
let tier = "simple";
function applyTier(t) {
  tier = t;
  document.querySelectorAll("#tier button").forEach((b) => b.classList.toggle("sel", b.dataset.tier === t));
  document.querySelectorAll('[data-tier="adv"]').forEach((el) => { el.style.display = t === "advanced" ? "" : "none"; });
}
// Workspace: "write" (handwriting sheet), "doc" (document editor) or "pdf" (PDF tools).
function setWorkMode(m) {
  if (m === "doc" && !doc) m = "write";
  workMode = m;
  document.body.dataset.work = m;
  document.body.classList.toggle("pdfmode", m === "pdf");
  if (m !== "doc") document.body.classList.remove("placing");
  if (m === "pdf") { if (window.__cal2RefreshPeRecents) window.__cal2RefreshPeRecents(); }
  else renderSignRecents();
  requestAnimationFrame(() => render(false));
}
const setAppMode = (which) => setWorkMode(which === "pdf" ? "pdf" : (doc ? "doc" : "write"));
function typingInField(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

(async function () {
  buildSwatches();
  try { await loadWasm(); } catch (e) { /* procedural engine optional; neural is primary */ }
  $("tier").querySelectorAll("button").forEach((b) => { b.onclick = () => applyTier(b.dataset.tier); });
  applyTier("simple");
  const shared = loadHash(); buildSwatches();
  if (!shared && $("hand").value !== "r") $("seed").value = $("hand").value;
  ["speed", "legibility", "thickness", "font_px", "slant", "contrast", "spacing", "line_spacing", "tex_intensity",
   "blur", "sharpen", "resolution", "blemish", "scan_rotate", "scan_rotvar", "scan_bright", "scan_contrast", "scan_noise", "scan_yellow"]
    .forEach((id) => { const el = $(id); if (el) el.addEventListener("input", renderD); });
  if ($("cspace")) $("cspace").addEventListener("change", renderD);
  // Live edit: while a placed signature is selected, any handwriting control re-draws
  // it (debounced; the stroke cache keeps it instant unless legibility/seed/text change).
  const HW_KEYS = ["legibility", "thickness", "slant", "contrast", "spacing", "line_spacing", "font_px"];
  const regenSelDeb = debounce(() => { const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); }, 130);
  HW_KEYS.forEach((id) => { const el = $(id); if (el) el.addEventListener("input", regenSelDeb); });
  // Typing in the text box live-updates a selected signature; with a document open and
  // none selected, the first keystroke places a signature on the current page.
  $("text").addEventListener("input", debounce(() => {
    const it = selectedItem();
    if (it && it.type === "sig" && it.dynamic) { it.text = textForEngine(); regenItem(it, undefined, true); return; }
    if (workMode === "doc" && doc && textForEngine()) {
      const s = [...docItems].reverse().find((d) => d.type === "sig" && d.dynamic && (d.page || 0) === curPage);
      if (s) { selId = s.id; s.text = textForEngine(); regenItem(s, undefined, true); }
      else addSigItem();
      return;
    }
    render(true);
  }, 160));
  $("seed").addEventListener("input", () => { renderD(); regenSelDeb(); });
  $("style").addEventListener("change", () => { applyStyle($("style").value); const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); });
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

  // ---- document: open / close ----
  $("upload_btn").onclick = () => $("file").click();
  $("file").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { await openDocFile(f); if (!location.hash.startsWith("#/edit")) location.hash = "#/edit"; }
    catch (err) { errEl.textContent = "Could not open that file: " + (err.message || err); }
  };
  const close = () => { closeDoc(); location.hash = "#/"; };
  $("clear_doc").onclick = close;
  if ($("ed_close")) $("ed_close").onclick = close;

  // ---- editor toolbar ----
  document.querySelectorAll("#ed_tools [data-tool]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); setEdTool(b.dataset.tool); }));
  document.querySelectorAll("#edbar [data-ddbtn]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = b.closest(".dd"), open = !dd.classList.contains("open");
    closeDropdowns(); if (open) dd.classList.add("open");
  }));
  document.addEventListener("click", (e) => { if (!e.target.closest(".dd")) closeDropdowns(); });
  document.querySelectorAll("#edbar [data-dl]").forEach((b) => b.addEventListener("click", () => {
    closeDropdowns();
    const k = b.dataset.dl;
    if (k === "pdf") exportPDF(); else if (k === "fill") exportFillablePDF(); else exportPNG();
  }));
  $("ed_undo").onclick = undo; $("ed_redo").onclick = redo;
  $("ed_zin").onclick = () => zoomStep(1); $("ed_zout").onclick = () => zoomStep(-1); $("ed_zval").onclick = () => setZoom(1);
  // colour dots, thickness, fill, new hand, duplicate, delete
  const dots = $("ctx_dots");
  if (dots) {
    dots.innerHTML = PALETTE.map((c) => `<span class="cdot" data-c="${c}" style="background:${c}" title="${c}"></span>`).join("");
    dots.querySelectorAll(".cdot").forEach((d) => d.onclick = () => applyColor(d.dataset.c));
  }
  holdDuring($("draw_color"), () => applyColor($("draw_color").value));
  holdDuring($("draw_size"), () => applySize(+$("draw_size").value));
  $("item_opacity").addEventListener("change", () => { holdSnap = false; snapshotNow(); });
  document.querySelectorAll("#fill_seg button").forEach((b) => b.onclick = () => applyFill(b.dataset.fill));
  $("ctx_newhand").onclick = newHand;
  $("ctx_dup").onclick = duplicateSelection;
  $("ctx_del").onclick = deleteSelection;
  // keyboard: undo/redo, delete, nudge, escape, zoom
  document.addEventListener("keydown", (e) => {
    if (workMode !== "doc" || !doc || document.body.dataset.route !== "work") return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z") && !typingInField(e)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === "y" || e.key === "Y") && !typingInField(e)) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom(1); return; }
    if (typingInField(e)) return;
    if (e.key === "Delete" || e.key === "Backspace") { if (deleteSelection()) e.preventDefault(); return; }
    if (e.key === "Escape") { closeDropdowns(); if (edTool !== "select") setEdTool("select"); else if (selId || selDraw) { selId = null; selDraw = null; render(); } return; }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelection(); return; }
    const it = selectedItem();
    if (it && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / pageDispW();
      const asp = pageAspect(it.page || 0);
      if (e.key === "ArrowLeft") it.nx -= step; if (e.key === "ArrowRight") it.nx += step;
      if (e.key === "ArrowUp") it.ny -= step * asp; if (e.key === "ArrowDown") it.ny += step * asp;
      render();
    }
  });
  // Ctrl/⌘ + wheel zooms the pages.
  const stageEl = $("stage"), panelEl = $("panel");
  stageEl.addEventListener("wheel", (e) => {
    if (workMode === "doc" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); return; }
    if (workMode !== "write") return;
    // On the handwriting sheet, forward the wheel to the controls once the preview can't scroll.
    const room = stageEl.scrollHeight - stageEl.clientHeight > 4;
    const can = room && ((e.deltaY > 0 && stageEl.scrollTop + stageEl.clientHeight < stageEl.scrollHeight - 1) || (e.deltaY < 0 && stageEl.scrollTop > 1));
    if (can) return;
    if (panelEl && panelEl.scrollHeight - panelEl.clientHeight > 4) { panelEl.scrollTop += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  $("png").addEventListener("click", exportPNG);
  $("pdf").addEventListener("click", exportPDF);
  $("pdf_fill").addEventListener("click", exportFillablePDF);
  $("svg").addEventListener("click", exportSVG);
  $("share").addEventListener("click", copyLink);
  $("sig_save").addEventListener("click", saveCurrentSig);
  renderSavedSigs();
  buildSigners();
  renderSignRecents();
  let lastW = 0;
  window.addEventListener("resize", () => { const w = $("stage").clientWidth; if (w !== lastW) { lastW = w; renderD(); } });

  // ---- hooks used by the page shell (shell.js) and the PDF tools (pdfedit.js) ----
  window.__cal2SetWork = setWorkMode;
  window.__cal2HasDoc = () => !!doc;
  window.__cal2OpenDocFile = (f) => openDocFile(f);
  window.__cal2OpenDocBytes = (u8, name, kind) => openDocBytes(u8, name, kind);
  window.__cal2CloseDoc = closeDoc;
  window.__cal2SetDocTool = (t) => { if (doc) setEdTool(t); };
  window.__cal2Toast = toast;
  window.__cal2ApplyTier = applyTier;
  window.__cal2Rerender = () => render(false);
  window.__cal2PickSignatureImage = () => { applyTier("advanced"); $("sig_file").click(); };
  window.__cal2InsertImageFile = insertImageFile;
  // The PDF tools hand a PDF to the editor (Annotate / Sign / Fill & sign tiles).
  window.__cal2OpenInSign = async (buf, name) => {
    if (!buf) { location.hash = doc ? "#/edit" : "#/tool/edit"; return; }
    try { await openDocBytes(new Uint8Array(buf), name || "document.pdf", "pdf"); location.hash = "#/edit"; }
    catch (e) { errEl.textContent = "Could not open that PDF: " + (e.message || e); }
  };
  try { initPdfEditor(); } catch (e) { /* pdf-lib optional */ }
  window.__cal2AppReady = true;
  window.dispatchEvent(new Event("cal2:ready"));
  render(false);
})();
