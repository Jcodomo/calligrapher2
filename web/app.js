// Calligrapher 2.0 front-end. Rust/WASM engine + document signing + scan finish.
// WASM C ABI: alloc / dealloc / generate / result_ptr + linear `memory`.

import { initPdfEditor } from "./pdfedit.js?v=8";
import { saveRecent, listRecents, getRecent, delRecent, makeRecentCard } from "./recents.js?v=1";
import { primeFromStrokes, supportedChar } from "./neural.js?v=2";
import { FONT_LIB, FONT_CATS, fontEntry, ensureFont, ensureFontsIn, matchPdfFont, addUserFont, removeUserFont } from "./fonts.js?v=2";
import { scanPdfWatermarks, removePdfWatermarks, eraseColor, inpaint, pageBackground } from "./watermark.js?v=1";

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
  neuralWorker = new Worker("./neural-worker.js?v=2", { type: "module" });
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
// A saved sample of your own handwriting: when set, every new line is written in its style.
let activePrime = null;            // { id, name, text, offsets }
const primeKey = () => (activePrime ? "|P" + activePrime.id : "");
function sampleLines(lines, bias, seed) {
  return new Promise((resolve, reject) => {
    const id = ++neuralReqId;
    neuralWaiters.set(id, { resolve, reject });
    getWorker().postMessage({ id, lines, bias, seed, baseUrl: "./model/", prime: activePrime ? { text: activePrime.text, offsets: activePrime.offsets } : null });
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
  const key = text + "|" + bias.toFixed(3) + "|" + seed + primeKey();
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
let formNoticeTok = -1;
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
// (saved styles live under cal2_styles; see "saved signatures and handwriting styles")

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

// ---- document editor ---------------------------------------------------------
// One open document, shown in the middle of the screen whatever tool you use.
// The document can be built from several PDFs/pictures (Add PDF): each page knows
// its source, its page number there and any extra rotation. Every placed object
// ("item") and drawing remembers its page; positions are normalised to the page
// (0..1) so they survive zoom, rotation and export at any resolution.
function escapeHTML(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function signerColor(id) { const s = signers.find((x) => x.id === id); return s ? s.color : "#1b1b1f"; }
function itemColor(it) { return it.color || signerColor(it.signer); }
function TRASH() { return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/></svg>'; }
const SVGNS = "http://www.w3.org/2000/svg";

let workMode = "write";            // write | doc | pdf
let edMode = "edit";               // edit | sign | organize | convert
let viewSingle = false;            // one page at a time, or every page
let docSources = [];               // [{ bytes, name, kind:"pdf"|"image", pdf, img, url }]
let docPages = [];                 // [{ src, idx, rot, img, w, h, url, fields, key }]
let curPage = 0, edZoom = 1, edTool = "select", selDraw = null, docName = "document";
let pagesSig = "", loadToken = 0, pageKeySeq = 1, editingId = null, activePanelTool = null;
const orgSel = new Set();
const REF_W = 800;                 // thickness units are px on an 800-px-wide page
const DRAW_TOOLS = new Set(["pen", "highlight", "line", "arrow", "underline", "strike"]);
const CLICK_TOOLS = new Set(["text", "sig", "handwrite", "date", "check", "note", "field:text", "field:date", "field:check", "field:sig"]);
const BOX_TOOLS = new Set(["shape:rect", "shape:ellipse", "whiteout", "redact"]);
const STICKY_TOOLS = new Set(["check"]);
const PALETTE = ["#000000", "#1b1b1f", "#5f6368", "#ffffff", "#e23b3b", "#f0a500", "#ffd400", "#1f9d55", "#0b7285", "#398dff", "#11295b", "#7c5cff"];
// Text fonts come from the font library (fonts.js); older font keys map onto it.
const LEGACY_FONT = { arial: "Arimo", helvetica: "Arimo", times: "Tinos", georgia: "Gelasio", calibri: "Carlito", segoe: "Segoe UI", verdana: "Verdana", courier: "Cousine", source: "Source Sans 3", docusign: "Dancing Script", vibes: "Great Vibes", caveat: "Caveat", apple: "Homemade Apple" };
const fontByKey = (k) => fontEntry(LEGACY_FONT[k] || k) || fontEntry("Arimo");
// Defaults for new objects, remembered as you change them in the property bar.
const TD = {
  text: { ff: "Arimo", pt: 12, color: "#000000", bg: "none", bold: false, italic: false, align: "left" },
  shape: { fill: "none", stroke: "#e23b3b", width: 3 },
  pen: { color: "#1b1b1f", width: 3 }, line: { color: "#e23b3b", width: 3 }, arrow: { color: "#e23b3b", width: 3 },
  highlight: { color: "#ffd400", width: 4 }, underline: { color: "#398dff", width: 2 }, strike: { color: "#e23b3b", width: 2 },
  note: { color: "#ffd54f" }, whiteout: { color: "#ffffff" },
};
const drawDefaults = (k) => TD[k] || TD.pen;
const TOOL_HINTS = {
  select: "Click an object to change it. Drag to move it, use the corner dots to resize.",
  edittext: "Click any text in the PDF to change it — it keeps the PDF's own font. Select it and press Delete to remove it.",
  text: "Click on the page where the text box should go.", sig: "Click on the page to place your signature. Type it in the side panel.",
  handwrite: "Click on the page to write the side panel's text in handwriting.", date: "Click on the page to add the date.",
  check: "Click each box to tick it.", note: "Click on the page to stick a note.",
  "field:text": "Click to add a fillable text field.", "field:date": "Click to add a date field.", "field:check": "Click to add a checkbox field.", "field:sig": "Click to add a signature field.",
  "shape:rect": "Drag on the page to draw a rectangle.", "shape:ellipse": "Drag on the page to draw an ellipse.",
  whiteout: "Drag over anything you want to cover in white.", redact: "Drag over anything that must be removed for good.",
  pen: "Draw freehand on the page.", highlight: "Drag across text to highlight it.", underline: "Drag along text to underline it.",
  strike: "Drag through text to strike it out.",
  "wm-pick": "Click the watermark on the page to pick its colour.", "wm-brush": "Paint over the watermark, then press Fill in painted areas on the right.", line: "Drag to draw a line.", arrow: "Drag to draw an arrow.",
};

function selectedItem() { return docItems.find((i) => i.id === selId); }
function selectedDraw() { return docDraws.find((d) => d.id === selDraw); }
function pageAspect(pi) { const p = docPages[pi] || doc; return p ? p.w / p.h : 0.77; }
function pagePts(pi) { const p = docPages[pi] || doc; return p ? p.w / 2 : 612; }      // page width in points
function isFreeAspect(it) { return it.tbox || it.type === "shape" || it.type === "white" || it.type === "redact" || (it.isField && it.fieldKind !== "check"); }
function isTextEditable(it) { return it.type === "text" && !it.tbox && !it.isMark && !(it.isField && it.fieldKind === "check"); }

// ---- pages: sources, rendering ------------------------------------------------
const BLANK_PAGE = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#fff"/></svg>');
const nextKey = () => "p" + pageKeySeq++;
const loadImgEl = (url) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
async function canvasUrl(c) { const b = await new Promise((r) => c.toBlob(r, "image/png")); return b ? URL.createObjectURL(b) : c.toDataURL("image/png"); }
async function renderPageObj(p) {
  const src = docSources[p.src];
  if (src.kind === "image") {
    const im = src.img;
    if (!p.rot) return { img: im, w: im.naturalWidth, h: im.naturalHeight, url: src.url, fields: [] };
    const sw = im.naturalWidth, sh = im.naturalHeight, swap = p.rot % 180 !== 0;
    const c = document.createElement("canvas"); c.width = swap ? sh : sw; c.height = swap ? sw : sh;
    const x = c.getContext("2d"); x.translate(c.width / 2, c.height / 2); x.rotate(p.rot * Math.PI / 180); x.drawImage(im, -sw / 2, -sh / 2);
    const url = await canvasUrl(c);
    return { img: await loadImgEl(url), w: c.width, h: c.height, url, fields: [] };
  }
  const page = await src.pdf.getPage(p.idx + 1);
  const vp = page.getViewport({ scale: 2, rotation: ((page.rotate || 0) + p.rot) % 360 });
  const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp, annotationMode: window.pdfjsLib.AnnotationMode ? window.pdfjsLib.AnnotationMode.ENABLE_FORMS : 1 }).promise;
  const url = await canvasUrl(c);
  const img = await loadImgEl(url);
  const fields = [];
  try {
    for (const a of await page.getAnnotations()) {
      if (a.subtype !== "Widget" || !a.rect) continue;
      const r = vp.convertToViewportRectangle(a.rect);
      const x1 = Math.min(r[0], r[2]), y1 = Math.min(r[1], r[3]), x2 = Math.max(r[0], r[2]), y2 = Math.max(r[1], r[3]);
      const name = a.fieldName || a.id;
      const box = { name, nx: x1 / vp.width, ny: y1 / vp.height, nw: (x2 - x1) / vp.width, nh: (y2 - y1) / vp.height };
      if (a.fieldType === "Tx") { fields.push({ ...box, type: "text" }); if (a.fieldValue && fieldValues[name] == null) fieldValues[name] = a.fieldValue; }
      else if (a.fieldType === "Btn" && a.radioButton) { fields.push({ ...box, type: "radio", value: a.buttonValue }); if (a.fieldValue && a.fieldValue !== "Off" && fieldValues[name] == null) fieldValues[name] = a.fieldValue; }
      else if (a.fieldType === "Btn" && !a.pushButton) { fields.push({ ...box, type: "check" }); if (a.fieldValue != null && fieldValues[name] == null) fieldValues[name] = a.fieldValue !== "Off"; }
      else if (a.fieldType === "Ch") { fields.push({ ...box, type: "choice", options: (a.options || []).map((o) => [o.exportValue ?? o.displayValue, o.displayValue ?? o.exportValue]) }); const fv = Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue; if (fv && fieldValues[name] == null) fieldValues[name] = fv; }
    }
  } catch (_) {}
  return { img, w: img.naturalWidth, h: img.naturalHeight, url, fields };
}
async function ensurePageImage(pi) {
  const p = docPages[pi]; if (!p || p.img) return p;
  if (!p._loading) p._loading = renderPageObj(p).then((r) => {
    Object.assign(p, r); p._loading = null;
    if (r.fields && r.fields.length && formNoticeTok !== loadToken) { formNoticeTok = loadToken; setTimeout(() => toast("This PDF has fillable fields — click a box to type, Tab moves to the next one."), 400); }
    return p;
  });
  await p._loading;
  updatePageImage(pi);
  return p;
}
function renderPagesInBackground(token) {
  (async () => {
    for (let i = 0; i < docPages.length; i++) {
      if (token !== loadToken) return;
      if (!docPages[i].img) { try { await ensurePageImage(i); if (docPages[i] && docPages[i].fields.length) render(); } catch (_) {} }
    }
  })();
}
// A late-rendered page swaps its picture in place (no rebuild, so editing isn't interrupted).
function updatePageImage(i) {
  const p = docPages[i]; if (!p) return;
  document.querySelectorAll(`#ed_pages .pg[data-page="${i}"] > img, #ed_thumbs .thumb[data-page="${i}"] img, #org_grid .og[data-i="${i}"] img`).forEach((im) => { im.src = p.url; });
}
// Add a PDF or picture as pages of the open document (at the end by default).
async function addSource(u8, name, kind, at) {
  const src = { bytes: u8.slice(), name: name || "document", kind };
  if (kind === "pdf") {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    src.pdf = await window.pdfjsLib.getDocument({ data: u8.slice(), fontExtraProperties: true }).promise;
  } else { src.url = URL.createObjectURL(new Blob([u8])); src.img = await loadImgEl(src.url); }
  const si = docSources.push(src) - 1, pages = [];
  if (kind === "pdf") {
    for (let i = 0; i < src.pdf.numPages; i++) {
      const pg = await src.pdf.getPage(i + 1), vp = pg.getViewport({ scale: 2 });
      pages.push({ src: si, idx: i, rot: 0, img: null, w: Math.round(vp.width), h: Math.round(vp.height), url: BLANK_PAGE, fields: [], key: nextKey() });
    }
  } else pages.push({ src: si, idx: 0, rot: 0, img: src.img, w: src.img.naturalWidth, h: src.img.naturalHeight, url: src.url, fields: [], key: nextKey() });
  if (at == null || at > docPages.length) at = docPages.length;
  docItems.forEach((it) => { if ((it.page || 0) >= at) it.page += pages.length; });
  docDraws.forEach((d) => { if ((d.page || 0) >= at) d.page += pages.length; });
  docPages.splice(at, 0, ...pages);
  return { at, n: pages.length };
}
function isPdfFile(f) { return f.type === "application/pdf" || /\.pdf$/i.test(f.name || ""); }
function isImgFile(f) { return /^image\//.test(f.type) || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name || ""); }
// Add files (PDFs or pictures) to the open document.
async function addFilesToDoc(files, at) {
  if (!doc) { if (files[0]) await openDocFile(files[0]); return; }
  let total = 0;
  for (const f of files) {
    if (!isPdfFile(f) && !isImgFile(f)) continue;
    try {
      const u8 = new Uint8Array(await f.arrayBuffer());
      const r = await addSource(u8, f.name, isPdfFile(f) ? "pdf" : "image", at == null ? null : at + total);
      total += r.n;
      saveRecent({ name: f.name, type: isPdfFile(f) ? "pdf" : "image", bytes: u8, thumb: "" }).then(refreshRecentLists).catch(() => {});
    } catch (e) { toast("Could not add " + f.name + ": " + (e.message || e)); }
  }
  if (!total) return;
  pagesSig = ""; render(); renderPagesInBackground(loadToken);
  toast(`Added ${total} page${total > 1 ? "s" : ""}.`);
}
async function addRecentToDoc(id) {
  const rec = await getRecent(id); if (!rec) return;
  const u8 = new Uint8Array(rec.bytes);
  const r = await addSource(u8, rec.name, rec.type === "pdf" ? "pdf" : "image");
  pagesSig = ""; render(); renderPagesInBackground(loadToken);
  toast(`Added ${r.n} page${r.n > 1 ? "s" : ""} from ${rec.name}.`);
}
function pickFilesForDoc() {
  const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true; inp.accept = "application/pdf,.pdf,image/*";
  inp.onchange = () => { if (inp.files && inp.files.length) addFilesToDoc([...inp.files]); };
  inp.click();
}

// ---- organize: reorder / delete / duplicate / rotate pages -------------------------
// order = old page indices in their new order (an index may appear twice = duplicate).
function applyPageOrder(order) {
  if (!order.length) { toast("A document needs at least one page."); return false; }
  const old = docPages, first = new Map(), seen = new Set();
  order.forEach((o, ni) => { if (!first.has(o)) first.set(o, ni); });
  docPages = order.map((o) => { const p = old[o]; if (seen.has(o)) return { ...p, key: nextKey(), _loading: null }; seen.add(o); return p; });
  docItems = docItems.filter((it) => first.has(it.page || 0)); docItems.forEach((it) => { it.page = first.get(it.page || 0); });
  docDraws = docDraws.filter((d) => first.has(d.page || 0)); docDraws.forEach((d) => { d.page = first.get(d.page || 0); });
  curPage = Math.min(curPage, docPages.length - 1); doc = docPages[curPage];
  selId = null; selDraw = null; pagesSig = ""; orgSel.clear();
  return true;
}
function movePage(from, to) {
  if (from === to) return;
  const order = docPages.map((_, i) => i); const [m] = order.splice(from, 1); order.splice(to, 0, m);
  applyPageOrder(order); render();
}
function deletePages(idx) {
  const kill = new Set(idx); if (!kill.size) { toast("Tick the pages to delete first."); return; }
  if (applyPageOrder(docPages.map((_, i) => i).filter((i) => !kill.has(i)))) { render(); toast(`Deleted ${kill.size} page${kill.size > 1 ? "s" : ""}. Ctrl+Z undoes.`); }
}
function duplicatePages(idx) {
  const dup = new Set(idx.length ? idx : [curPage]), order = [];
  docPages.forEach((_, i) => { order.push(i); if (dup.has(i)) order.push(i); });
  applyPageOrder(order); render();
}
// Rotate a page; its objects move with it (they stay upright).
function rotatePage(i, dir) {
  const p = docPages[i]; if (!p) return;
  const W = p.w, H = p.h, cw = dir > 0;
  docPages[i] = { ...p, rot: (p.rot + (cw ? 90 : 270)) % 360, img: null, url: BLANK_PAGE, w: H, h: W, fields: [], _loading: null };
  const rp = (x, y) => cw ? [1 - y, x] : [y, 1 - x];
  for (const it of docItems) {
    if ((it.page || 0) !== i) continue;
    let wpx = it.nw * W, hpx = it.nw * W * it.ar;
    const [cx, cy] = rp(it.nx + wpx / W / 2, it.ny + hpx / H / 2);
    if (isFreeAspect(it) && !it.tbox) [wpx, hpx] = [hpx, wpx];
    it.nw = wpx / H; it.ar = hpx / wpx;
    it.nx = cx - it.nw / 2; it.ny = cy - hpx / W / 2;
    // a cover box swaps its width and height (normalised: new nw = old nh, new nh = old nw)
    if (it.cover) { const c = it.cover, [ccx, ccy] = rp(c.nx + c.nw / 2, c.ny + c.nh / 2); it.cover = { nx: ccx - c.nh / 2, ny: ccy - c.nw / 2, nw: c.nh, nh: c.nw }; }
  }
  for (const d of docDraws) {
    if ((d.page || 0) !== i) continue;
    if (d.pts) d.pts = d.pts.map((q) => rp(q[0], q[1]));
    else { [d.x0, d.y0] = rp(d.x0, d.y0); [d.x1, d.y1] = rp(d.x1, d.y1); }
    d.size = d.size * W / H;
  }
  pagesSig = "";
}
function rotatePages(idx, dir) {
  const list = idx.length ? idx : [curPage];
  list.forEach((i) => rotatePage(i, dir));
  render(); renderPagesInBackground(loadToken);
}
async function addBlankPage() {
  const ref = docPages[curPage] || docPages[0];
  const c = document.createElement("canvas"); c.width = ref ? ref.w : 1224; c.height = ref ? ref.h : 1584;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height);
  const u8 = dataURLtoU8(c.toDataURL("image/png"));
  const at = (orgSel.size ? Math.max(...orgSel) : curPage) + 1;
  await addSource(u8, "Blank page", "image", at);
  pagesSig = ""; render(); toast("Added a blank page.");
}
function dataURLtoU8(u) { const b = atob(u.split(",")[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
function renderOrganize() {
  const g = $("org_grid"); if (!g) return;
  g.innerHTML = "";
  docPages.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "og" + (orgSel.has(i) ? " sel" : ""); d.draggable = true; d.dataset.i = i;
    d.innerHTML = `<input type="checkbox" ${orgSel.has(i) ? "checked" : ""} title="Select page"><img src="${p.url}" alt="Page ${i + 1}" style="aspect-ratio:${p.w}/${p.h}" draggable="false"><div class="ogn">${i + 1}</div>` +
      `<div class="ogb"><button data-a="l" title="Rotate left">⟲</button><button data-a="r" title="Rotate right">⟳</button><button data-a="d" title="Duplicate">⧉</button><button data-a="x" title="Delete">🗑</button></div>`;
    d.querySelector("input").onclick = (e) => { e.stopPropagation(); if (e.target.checked) orgSel.add(i); else orgSel.delete(i); d.classList.toggle("sel", e.target.checked); };
    d.onclick = (e) => { if (e.target.closest("button,input")) return; if (!(e.ctrlKey || e.metaKey || e.shiftKey)) orgSel.clear(); if (orgSel.has(i)) orgSel.delete(i); else orgSel.add(i); renderOrganize(); };
    d.ondblclick = () => { curPage = i; doc = docPages[i]; setEdMode("edit"); setCurPage(i, true); };
    d.querySelectorAll(".ogb button").forEach((b) => b.onclick = (e) => {
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === "l") rotatePages([i], -1); else if (a === "r") rotatePages([i], 1); else if (a === "d") duplicatePages([i]); else deletePages([i]);
    });
    d.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/x-page", String(i)); e.dataTransfer.effectAllowed = "move"; });
    d.addEventListener("dragover", (e) => { e.preventDefault(); d.classList.add("drop"); });
    d.addEventListener("dragleave", () => d.classList.remove("drop"));
    d.addEventListener("drop", (e) => {
      e.preventDefault(); e.stopPropagation(); d.classList.remove("drop");
      const from = e.dataTransfer.getData("text/x-page");
      if (from !== "") movePage(+from, i);
      else if (e.dataTransfer.files && e.dataTransfer.files.length) addFilesToDoc([...e.dataTransfer.files], i + 1);
    });
    g.appendChild(d);
  });
  const add = document.createElement("div");
  add.className = "og add"; add.innerHTML = '<svg class="i" viewBox="0 0 20 20" style="width:34px;height:34px"><path d="M10 4v12M4 10h12"/></svg>Add PDF<small style="font-weight:400;color:var(--muted)">or drop files here</small>';
  add.onclick = pickFilesForDoc;
  add.addEventListener("dragover", (e) => { e.preventDefault(); add.classList.add("over"); });
  add.addEventListener("dragleave", () => add.classList.remove("over"));
  add.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); add.classList.remove("over"); if (e.dataTransfer.files.length) addFilesToDoc([...e.dataTransfer.files]); });
  g.appendChild(add);
}

// ---- the PDF's own text: find it, edit it in its own font, remove it -----------------
const textBlocks = new Map();      // page key:rot -> Promise<blocks>
const pdfFonts = new Map();        // source:fontName -> { loadedName, map, inv, fallback }
// The closest available font for a PDF font (downloaded on demand), used for any
// characters the PDF's own embedded font does not contain — or when it has none.
function fontFallback(fo) {
  const m = matchPdfFont(fo && fo.name, { serif: !!(fo && fo.isSerifFont), mono: !!(fo && fo.isMonospace) });
  ensureFont(m.family);
  const f = fontEntry(m.family);
  return { css: m.css, family: m.family, weight: m.weight, style: m.style, serif: !!f && f.cat === "Serif", mono: !!f && f.cat === "Mono" };
}
function registerPdfFont(si, fontName, page) {
  const key = si + ":" + fontName;
  if (pdfFonts.has(key)) return key;
  let fo = null;
  try { if (page.commonObjs.has(fontName)) fo = page.commonObjs.get(fontName); } catch (_) {}
  const info = { loadedName: null, map: {}, inv: {}, fallback: fontFallback(fo) };
  if (fo && fo.loadedName && !fo.missingFile && [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fo.loadedName)) {
    const tfc = fo.toFontChar || [], tu = fo.toUnicode || {};
    const add = (code, uni) => { const fc = tfc[code]; if (uni && fc != null && [...uni].length === 1) { const ch = String.fromCodePoint(fc); info.map[uni] = ch; info.inv[ch] = uni; } };
    if (tu._map) { for (const code in tu._map) add(+code, tu._map[code]); }
    else if (tu.firstChar != null) { for (let c = tu.firstChar; c <= tu.lastChar; c++) add(c, String.fromCharCode(c)); }
    if (Object.keys(info.map).length) info.loadedName = fo.loadedName;
  }
  pdfFonts.set(key, info);
  return key;
}
const pfontInfo = (it) => (it && it.pfont ? pdfFonts.get(it.pfont) : null);
function toFontStr(info, s) { if (!info || !info.loadedName) return s; let o = ""; for (const ch of String(s)) o += info.map[ch] || ch; return o; }
function fromFontStr(info, s) { if (!info || !info.loadedName) return s; let o = ""; for (const ch of String(s)) o += info.inv[ch] || ch; return o; }
function getTextBlocks(pi) {
  const p = docPages[pi]; const src = p && docSources[p.src];
  if (!src || src.kind !== "pdf") return Promise.resolve([]);
  const ck = p.key + ":" + p.rot;
  if (!textBlocks.has(ck)) textBlocks.set(ck, (async () => {
    await ensurePageImage(pi);                       // rendering loads the PDF's fonts into the page
    const page = await src.pdf.getPage(p.idx + 1);
    const vp = page.getViewport({ scale: 1, rotation: ((page.rotate || 0) + p.rot) % 360 });
    const tc = await page.getTextContent();
    const U = window.pdfjsLib.Util, runs = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const tx = U.transform(vp.transform, it.transform);
      const fs = Math.hypot(tx[2], tx[3]); if (fs < 1) continue;
      if (Math.abs(Math.atan2(tx[1], tx[0])) > 0.02) continue;      // horizontal text only
      const st = tc.styles[it.fontName] || {};
      const asc = st.ascent && st.ascent > 0.3 ? st.ascent : 0.86, desc = st.descent && st.descent < 0 ? st.descent : -0.22;
      runs.push({ str: it.str, fontName: it.fontName, x: tx[4], base: tx[5], fs, w: it.width * vp.scale, asc, desc });
    }
    const lines = [];
    for (const r of runs) {
      const L = lines[lines.length - 1];
      if (L && L.fontName === r.fontName && Math.abs(L.base - r.base) < r.fs * 0.25 && Math.abs(L.fs - r.fs) < 0.6 &&
          r.x >= L.x + L.w - r.fs * 0.3 && r.x - (L.x + L.w) < r.fs * 1.1) {
        const gap = r.x - (L.x + L.w);
        if (gap > r.fs * 0.12 && !/\s$/.test(L.str) && !/^\s/.test(r.str)) L.str += " ";
        L.str += r.str; L.w = r.x + r.w - L.x;
      } else lines.push({ ...r });
    }
    return lines.map((L) => {
      const pfont = registerPdfFont(p.src, L.fontName, page);
      return { str: L.str.replace(/\s+$/, ""), pfont, asc: L.asc, nx: L.x / vp.width, ny: (L.base - L.fs * L.asc) / vp.height, nw: Math.max(L.w, L.fs * 0.6) / vp.width, nh: L.fs * (L.asc - L.desc) / vp.height, fsN: L.fs / vp.width };
    });
  })().catch(() => []));
  return textBlocks.get(ck);
}
// Background / ink colours of a text block, read from the rendered page.
function sampleBlockColors(p, b) {
  try {
    const x = Math.max(0, Math.floor(b.nx * p.w) - 2), y = Math.max(0, Math.floor(b.ny * p.h) - 2);
    const w = Math.max(3, Math.min(p.w - x, Math.ceil(b.nw * p.w) + 4)), h = Math.max(3, Math.min(p.h - y, Math.ceil(b.nh * p.h) + 4));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const ctx = c.getContext("2d"); ctx.drawImage(p.img, x, y, w, h, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const at = (i, j) => { const k = (j * w + i) * 4; return [d[k], d[k + 1], d[k + 2]]; };
    const edge = [];
    for (let i = 0; i < w; i++) { edge.push(at(i, 0), at(i, h - 1)); }
    for (let j = 0; j < h; j++) { edge.push(at(0, j), at(w - 1, j)); }
    edge.sort((a, b2) => (a[0] + a[1] + a[2]) - (b2[0] + b2[1] + b2[2]));
    const bg = edge[Math.floor(edge.length * 0.6)];
    let fg = [0, 0, 0], best = -1;
    for (let k = 0; k < d.length; k += 4) { const dd = Math.abs(d[k] - bg[0]) + Math.abs(d[k + 1] - bg[1]) + Math.abs(d[k + 2] - bg[2]); if (dd > best) { best = dd; fg = [d[k], d[k + 1], d[k + 2]]; } }
    const hex = (c3) => "#" + c3.map((v) => v.toString(16).padStart(2, "0")).join("");
    return [hex(bg), hex(fg)];
  } catch (_) { return ["#ffffff", "#000000"]; }
}
function renderTextBlocks(ov, pi, dispW, dispH) {
  const p = docPages[pi];
  getTextBlocks(pi).then((blocks) => {
    if (!ov.isConnected || edTool !== "edittext") return;
    blocks.forEach((b, bi) => {
      const bid = p.key + ":" + p.rot + ":" + bi;
      if (docItems.some((it) => it.blockId === bid)) return;
      const t = document.createElement("div"); t.className = "tblock"; t.title = "Click to edit this text";
      t.style.cssText = `left:${b.nx * dispW - 2}px;top:${b.ny * dispH - 2}px;width:${b.nw * dispW + 4}px;height:${b.nh * dispH + 4}px`;
      t.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); createTextEdit(pi, b, bid, e.clientX, e.clientY); };
      ov.appendChild(t);
    });
    if (!blocks.length && docSources[p.src] && docSources[p.src].kind === "pdf" && pi === curPage) toast("No editable text on this page — it may be a scan. Use Add text, or run OCR in Convert & Optimize.");
  });
}
function createTextEdit(pi, b, bid, cx, cy) {
  const p = docPages[pi];
  const [bg, fg] = sampleBlockColors(p, b);
  const info = pdfFonts.get(b.pfont);
  const padX = b.fsN * 0.08, padY = b.nh * 0.1;
  const it = {
    id: "it" + itemSeq++, type: "text", tbox: true, tedit: true, page: pi, blockId: bid, pfont: b.pfont,
    ff: info ? info.fallback.family : "Arimo",
    fs: b.fsN, asc: b.asc, color: fg, bg: "none", coverBg: bg, opacity: 1, signer: activeSigner, align: "left",
    cover: { nx: b.nx - padX, ny: b.ny - padY, nw: b.nw + padX * 2, nh: b.nh + padY * 2 },
    nx: b.nx, ny: b.ny, nw: b.nw + padX, ar: (b.nh / (b.nw + padX)) / pageAspect(pi), text: b.str, orig: b.str,
  };
  docItems.push(it); selId = it.id; selDraw = null;
  render();
  requestAnimationFrame(() => { const el = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"]`); if (el) startTboxEdit(it, el, cx, cy); });
}

// ---- creating objects -------------------------------------------------------
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
function pushItem(it, x, y, topLeft) {
  it.id = "it" + itemSeq++;
  if (it.page == null) it.page = curPage;
  if (it.opacity == null) it.opacity = 1;
  if (!it.signer) it.signer = activeSigner;
  if (x == null) [x, y] = defaultSpot(it.page);
  if (topLeft) { it.nx = Math.max(0, Math.min(1 - it.nw, x)); it.ny = Math.max(0, y); } else centerOn(it, x, y);
  docItems.push(it); selId = it.id; selDraw = null;
  return it;
}
// Signatures and handwriting come from the neural engine; each keeps its own mode.
function currentSignature(wm) {
  if (sigSVG && toggles.usesig) return { svg: sigSVG, w: sigBox.w, h: sigBox.h };
  const svg = makeHandwriting(Math.round((doc ? doc.w : 800) * 0.5));
  return { svg: cleanSigSVG(svg), w: hwW, h: hwH };
}
async function generateSig(text, p, m) {
  m = m || mode;
  const bias = neuralBias();
  const key = text + "|" + bias.toFixed(3) + "|" + p.seed + primeKey();
  let lines = neuralCache.get(key);
  if (!lines) {
    const lineTexts = (m === "signature") ? [text] : String(text).split("\n");
    lines = await sampleLines(lineTexts, bias, p.seed);
    neuralCache.set(key, lines);
  }
  let svg = buildNeuralSVG(lines, p);
  if (m === "signature") svg = addFlourish(svg);
  svg = svg.replace("<svg ", `<svg style="color:${ink}" `);
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 1, h = +(svg.match(/height="(\d+)"/) || [])[1] || 1;
  return { svg: cleanSigSVG(svg), w, h };
}
function sigText(wm) {
  const raw = $("text").value;
  return wm === "signature" ? raw.replace(/\s*\n\s*/g, " ").trim() : raw;
}
function addSigItem(x, y, wm) {
  if (!doc) return null;
  wm = wm || (mode === "signature" ? "signature" : "writing");
  const traced = !!(sigSVG && toggles.usesig);
  const text = sigText(wm);
  if (!traced && !text.trim()) { toast("Type it in the side panel first."); openSide(true); return null; }
  const g = currentSignature(wm);
  const it = pushItem({ type: "sig", wmode: wm, nw: wm === "signature" ? 0.3 : 0.5, ar: (g.h / g.w) || 0.3, svg: g.svg, dynamic: !traced, text, seed: +$("seed").value, autosave: wm === "signature" }, x, y);
  render();
  if (it.dynamic) regenItem(it, undefined, true); else if (wm === "signature") autoSaveSig(it);
  return it;
}
function addTextItem(x, y) {
  if (!doc) return null;
  const t = TD.text, pts = pagePts(curPage);
  // one line tall (1.2em line + 0.4em padding), measured like the width in page-width units
  const it = pushItem({ type: "text", tbox: true, ff: t.ff, fs: t.pt / pts, color: t.color, bg: t.bg, bold: t.bold, italic: t.italic, align: t.align, nw: 0.3, ar: ((t.pt * 1.6) / pts) / 0.3, text: "" }, x, y, true);
  render();
  requestAnimationFrame(() => { const el = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"]`); if (el) startTboxEdit(it, el); });
  return it;
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
function markGlyph(m) { return m === "x" ? "X" : "✓"; }
function addCheckItem(x, y) {
  if (!doc) return null;
  const it = pushItem({ type: "text", isMark: true, mark: "check", nw: 0.045, ar: 1, text: "✓", font: 5 }, x, y);
  render(); return it;
}
// Form-builder fields: real AcroForm fields in the editable download, boxes when flattened.
function addFieldItem(kind, x, y) {
  if (!doc) return null;
  let it;
  if (kind === "date") { const { date, time, tz } = nowParts(); it = pushItem({ type: "text", isField: true, fieldKind: "date", isDate: true, label: "Date", date, time, tz, text: fmtDocuSign(date, time, tz), nw: 0.36, ar: 0.12, font: 0 }, x, y); }
  else if (kind === "check") it = pushItem({ type: "text", isField: true, fieldKind: "check", label: "", checked: false, text: "", nw: 0.04, ar: 1, font: 5 }, x, y);
  else if (kind === "sig") it = pushItem({ type: "text", isField: true, fieldKind: "sig", label: "Signature", text: "", nw: 0.3, ar: 0.16, font: 0 }, x, y);
  else it = pushItem({ type: "text", isField: true, fieldKind: "text", label: "Text", text: "", nw: 0.28, ar: 0.14, font: 5 }, x, y);
  render();
  if (kind === "text" || kind === "sig") focusInlineEdit(it.id);
  return it;
}
function focusInlineEdit(id) {
  const it = docItems.find((i) => i.id === id); if (!it || it.type !== "text") return;
  requestAnimationFrame(() => { const el = document.querySelector(`#ed_pages .ditem[data-id="${id}"]`); if (el) startInlineEdit(it, el); });
}
async function detectFormFields(all) {
  if (!doc) return;
  const list = all ? docPages.map((_, i) => i) : [curPage];
  let made = 0;
  for (const pi of list) {
    const p = await ensurePageImage(pi); if (!p || !p.img) continue;
    const W = 1200, H = Math.round(W * p.h / p.w);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true }); cx.fillStyle = "#fff"; cx.fillRect(0, 0, W, H); cx.drawImage(p.img, 0, 0, W, H);
    const px = cx.getImageData(0, 0, W, H).data, dark = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) dark[i] = (px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11) < 140 ? 1 : 0;
    const D = (x, y) => (x < 0 || y < 0 || x >= W || y >= H) ? 0 : dark[y * W + x];
    const inkIn = (x0, y0, x1, y1) => { let n = 0, t = 0; for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { t++; n += dark[y * W + x]; } return t ? n / t : 1; };
    // existing boxes on this page (ours and the PDF's own) are left alone
    const taken = [...docItems.filter((it) => (it.page || 0) === pi && (it.isField || it.tbox)).map((it) => ({ x: it.nx * W, y: it.ny * H, w: it.nw * W, h: it.nw * W * it.ar })),
      ...(p.fields || []).map((f) => ({ x: f.nx * W, y: f.ny * H, w: f.nw * W, h: f.nh * H }))];
    const free = (x, y, w, h) => !taken.some((t) => x < t.x + t.w && x + w > t.x && y < t.y + t.h && y + h > t.y);
    const add = (o) => { taken.push(o.box); docItems.push({ ...o.it, id: "it" + itemSeq++, page: pi, opacity: 1, signer: activeSigner }); made++; };
    const lines = [], boxes = [];
    for (let y = 2; y < H - 2; y++) {
      let x = 0;
      while (x < W) {
        if (!dark[y * W + x]) { x++; continue; }
        let x1 = x; while (x1 < W && (dark[y * W + x1] || dark[y * W + x1 + 1])) x1++;
        const len = x1 - x;
        if (len >= W * 0.06) {
          // a thin rule: little ink 3 rows above and below along most of it
          if (inkIn(x, y - 4, x1, y - 3) < 0.35 && inkIn(x, y + 4, x1, y + 5) < 0.35) lines.push({ x0: x, x1, y });
        } else if (len >= 9 && len <= 30) boxes.push({ x0: x, x1, y });
        x = x1 + 1;
      }
    }
    // merge thick rules (several rows) into one
    lines.sort((a, b) => a.y - b.y || a.x0 - b.x0);
    const rules = [];
    for (const l of lines) { const r = rules.find((q) => Math.abs(q.x0 - l.x0) < 6 && Math.abs(q.x1 - l.x1) < 6 && l.y - q.y2 <= 2); if (r) r.y2 = l.y; else rules.push({ ...l, y2: l.y }); }
    for (const r of rules) {
      if (r.y2 - r.y > 4) continue;
      const fh = Math.round(Math.min(34, Math.max(18, (r.x1 - r.x0) * 0.12)));
      const top = r.y - fh, x0 = r.x0 + 2, w = r.x1 - r.x0 - 4;
      if (top < 0 || inkIn(x0, top + 2, x0 + w, r.y - 2) > 0.02 || !free(x0, top, w, fh)) continue;   // already filled in, or text sits on it
      add({ box: { x: x0, y: top, w, h: fh }, it: { type: "text", isField: true, fieldKind: "text", label: "Text", text: "", nx: x0 / W, ny: top / H, nw: w / W, ar: fh / w, font: 5 } });
    }
    // little empty squares: top edge, bottom edge the same width, both sides inked, inside blank
    const seen = new Set();
    for (const b of boxes) {
      const L = b.x1 - b.x0, key = Math.round(b.x0 / 4) + ":" + Math.round(b.y / 4);
      if (seen.has(key)) continue;
      const yb = b.y + L - 1;
      let ok = false;
      for (let d = -2; d <= 2 && !ok; d++) if (inkIn(b.x0 + 1, yb + d, b.x1 - 1, yb + d + 1) > 0.8) ok = true;
      if (!ok || inkIn(b.x0, b.y, b.x0 + 2, yb) < 0.7 || inkIn(b.x1 - 2, b.y, b.x1, yb) < 0.7) continue;
      if (inkIn(b.x0 + 3, b.y + 3, b.x1 - 3, yb - 3) > 0.08 || !free(b.x0, b.y, L, L)) continue;
      for (let dy = -1; dy <= L; dy++) seen.add(Math.round(b.x0 / 4) + ":" + Math.round((b.y + dy) / 4));
      add({ box: { x: b.x0, y: b.y, w: L, h: L }, it: { type: "text", isField: true, fieldKind: "check", label: "", checked: false, text: "", nx: b.x0 / W, ny: b.y / H, nw: L / W, ar: 1, font: 5 } });
    }
  }
  selId = null; render();
  toast(made ? `Added ${made} form field${made > 1 ? "s" : ""} — fill them in, or Save → editable PDF to keep them fillable.` : "No blank lines or empty boxes found to turn into fields.");
}
function addNoteItem(x, y) {
  if (!doc) return null;
  const s = signers.find((q) => q.id === activeSigner);
  const it = pushItem({ type: "note", nw: 0.034, ar: 1, text: "", color: TD.note.color, author: s ? s.name : "", created: new Date().toISOString() }, x, y);
  render();
  requestAnimationFrame(() => { const ta = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"] .notepop textarea`); if (ta) ta.focus(); });
  return it;
}
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
    const src = c.toDataURL(/png|gif|webp|svg/i.test(f.type) ? "image/png" : "image/jpeg", 0.9);
    URL.revokeObjectURL(url);
    pushItem({ type: "img", src, nw: 0.32, ar: c.height / c.width });
    render(); toast("Image added — drag it into place, resize from a corner.");
  };
  im.onerror = () => toast("That picture could not be read.");
  im.src = url;
}
function deleteItem(id) { docItems = docItems.filter((i) => i.id !== id); if (selId === id) selId = null; render(); }
// Deleting edited PDF text leaves its cover, which removes the original words.
function deleteSelection() {
  const it = selectedItem();
  if (it && it.tedit) {
    const c = it.cover;
    docItems = docItems.map((x) => x.id === it.id ? { id: it.id, type: "white", page: it.page, blockId: it.blockId, nx: c.nx, ny: c.ny, nw: c.nw, ar: (c.nh / c.nw) / pageAspect(it.page), color: it.coverBg || "#fff", opacity: 1, signer: it.signer } : x);
    selId = null; render(); toast("Text removed."); return true;
  }
  if (selId) { deleteItem(selId); return true; }
  if (selDraw) { docDraws = docDraws.filter((d) => d.id !== selDraw); selDraw = null; render(); return true; }
  return false;
}
function duplicateSelection() {
  const it = selectedItem();
  if (it) { const c = { ...it, id: "it" + itemSeq++, nx: Math.min(0.95, it.nx + 0.02), ny: Math.min(0.95, it.ny + 0.02) }; delete c.blockId; delete c.cover; c.tedit = false; docItems.push(c); selId = c.id; render(); return; }
  const d = selectedDraw();
  if (d) { const c = JSON.parse(JSON.stringify(d)); c.id = "dr" + drawSeq++; shiftDraw(c, 0.02, 0.02); docDraws.push(c); selDraw = c.id; render(); }
}
async function regenItem(it, newSeed, quiet) {
  if (!it || it.type !== "sig" || !it.dynamic) return;
  if (newSeed != null) it.seed = newSeed;
  const p = params(Math.round((doc ? doc.w : 800) * 0.5));
  p.seed = it.seed;
  try {
    const g = await generateSig(it.text, p, it.wmode);
    it.svg = g.svg; it.ar = g.h / g.w; render();
    if (it.autosave) { it.autosave = false; autoSaveSig(it); }
    if (!quiet) toast("Updated signature.");
  } catch (e) { errEl.textContent = "Could not re-roll: " + (e.message || e); }
}

// ---- view: zoom, single/all pages, thumbnails, current page ----------------
function pageDispW(pi) {
  const st = $("stage"); const availW = Math.max(260, (st ? st.clientWidth : 900) - 80);
  let w = Math.min(availW, 900);
  if (viewSingle && st) { const p = docPages[pi] || doc; if (p) w = Math.min(w, Math.max(240, (st.clientHeight - 60) * p.w / p.h)); }
  return Math.round(w * edZoom);
}
let pageObserver = null;
const pageRatios = new Map();
function observePages() {
  if (pageObserver) pageObserver.disconnect();
  pageRatios.clear();
  if (viewSingle || !("IntersectionObserver" in window)) return;
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
  const prev = curPage;
  curPage = Math.max(0, Math.min(docPages.length - 1, i));
  doc = docPages[curPage] || doc;
  document.querySelectorAll("#ed_thumbs .thumb").forEach((t) => t.classList.toggle("cur", +t.dataset.page === curPage));
  const ctr = $("ed_pagectr"); if (ctr) ctr.textContent = (curPage + 1) + " / " + docPages.length;
  if (viewSingle) { if (prev !== curPage || scroll) { render(); $("stage").scrollTop = 0; } }
  else if (scroll) { const pg = document.querySelector(`#ed_pages .pg[data-page="${curPage}"]`); if (pg) pg.scrollIntoView({ block: "start", behavior: "smooth" }); }
  const th = document.querySelector(`#ed_thumbs .thumb[data-page="${curPage}"]`);
  if (th && th.scrollIntoViewIfNeeded) th.scrollIntoViewIfNeeded(false);
  if ($("pg_prev")) { $("pg_prev").disabled = curPage <= 0; $("pg_next").disabled = curPage >= docPages.length - 1; }
}
function renderThumbs() {
  const host = $("ed_thumbs"); if (!host) return;
  host.innerHTML = docPages.map((p, i) => `<button class="thumb${i === curPage ? " cur" : ""}" data-page="${i}" title="Page ${i + 1}"><img src="${p.url}" alt="" style="aspect-ratio:${p.w}/${p.h}">${i + 1}</button>`).join("");
  host.querySelectorAll(".thumb").forEach((b) => b.onclick = () => setCurPage(+b.dataset.page, true));
}
function setView(single) {
  viewSingle = !!single;
  document.body.classList.toggle("view-single", viewSingle);
  $("ed_view_single").classList.toggle("on", viewSingle); $("ed_view_all").classList.toggle("on", !viewSingle);
  pagesSig = ""; render();
  if (!viewSingle) requestAnimationFrame(() => setCurPage(curPage, true));
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
  if (edMode === "organize") { renderOrganize(); renderThumbs(); updateEdChrome(); renderProps(); if (holdSnap) scheduleSnapshot(); else snapshotNow(); return; }
  const host = $("ed_pages"); if (!host) return;
  const list = viewSingle ? [curPage] : docPages.map((_, i) => i);
  const widths = list.map((i) => pageDispW(i));
  const sig = (viewSingle ? "1:" + curPage : "all") + "|" + widths.join(",") + "|" + list.map((i) => docPages[i].key + "/" + docPages[i].w + "x" + docPages[i].h).join(",");
  if (sig !== pagesSig) {
    pagesSig = sig; host.innerHTML = "";
    list.forEach((i, k) => {
      const p = docPages[i], W = widths[k], H = Math.round(W * p.h / p.w);
      const pg = document.createElement("div"); pg.className = "pg"; pg.dataset.page = i;
      pg.style.width = W + "px"; pg.style.height = H + "px";
      pg.innerHTML = `<img src="${p.url}" alt="Page ${i + 1}" draggable="false"><div class="pgov" style="width:${W}px;height:${H}px"></div>`;
      host.appendChild(pg);
    });
    renderThumbs(); observePages();
    if (viewSingle) ensurePageImage(curPage);
  }
  const sp = scanParams(), filt = previewFilter(), tf = scanTransform();
  host.querySelectorAll(".pg").forEach((pg) => {
    const i = +pg.dataset.page, p = docPages[i]; if (!p) return;
    const dispW = parseFloat(pg.style.width), dispH = parseFloat(pg.style.height);
    pg.style.filter = filt; pg.style.transform = tf;
    pg.style.outline = (sp.on && sp.border) ? "6px solid rgba(22,19,14,0.9)" : ""; pg.style.outlineOffset = "-3px";
    const ov = pg.querySelector(".pgov"); ov.innerHTML = "";
    ov.onpointerdown = (e) => onPagePointerDown(e, ov, i, dispW, dispH);
    renderDraws(ov, dispW, dispH, i, true);
    renderFields(ov, dispW, dispH, p.fields || []);
    // covers for edited PDF text sit under everything else
    docItems.forEach((it) => { if ((it.page || 0) === i && it.tedit && it.cover) { const c = it.cover, d = document.createElement("div"); d.className = "tcover"; d.style.cssText = `left:${c.nx * dispW}px;top:${c.ny * dispH}px;width:${c.nw * dispW}px;height:${c.nh * dispH}px;background:${it.coverBg || "#fff"}`; ov.appendChild(d); } });
    if (edTool === "edittext") renderTextBlocks(ov, i, dispW, dispH);
    docItems.forEach((it) => { if ((it.page || 0) === i) ov.appendChild(itemEl(it, dispW, dispH)); });
    renderDraws(ov, dispW, dispH, i, false);
    renderWmMask(ov, i, dispW, dispH);
  });
  document.body.classList.toggle("placing", edTool !== "select" && edTool !== "edittext");
  document.body.dataset.tool = edTool;
  syncItemUI(); updateEdChrome(); renderProps();
  requestAnimationFrame(fitTextBoxes);
  if (holdSnap) scheduleSnapshot(); else snapshotNow();
}
// Grow text boxes to fit their text (height for wrapped boxes, width for edited PDF text).
// "Fit": edited PDF text grows/shrinks to the original line's width; a text box to its frame.
function fitTextToBox(it) {
  const el = [...document.querySelectorAll(`#ed_pages .ditem[data-id="${it.id}"]`)].find((e) => e.clientWidth > 0); if (!el) return;
  const td = el.querySelector(".tbtext"); if (!td || !(it.text || "").trim()) return;
  const ovW = el.parentNode.clientWidth || 1;
  if (it.tedit) {
    const target = (it.cover ? it.cover.nw : it.nw) * ovW, cur = td.scrollWidth || 1;
    it.fs = Math.max(0.002, it.fs * target / cur); it.nw = target / ovW;
    return;
  }
  const boxW = el.clientWidth, boxH = el.clientHeight;
  // lines stay as typed (no new wrapping): the longest one fills the width, all of them fit the height
  const ws = td.style.whiteSpace; td.style.whiteSpace = "pre"; td.style.width = "max-content";
  let lo = 0.002, hi = 0.2;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2; td.style.fontSize = mid * ovW + "px";
    if (td.scrollHeight <= boxH + 1 && td.offsetWidth <= boxW + 1) lo = mid; else hi = mid;
  }
  td.style.whiteSpace = ws; td.style.width = "";
  it.fs = lo;
}
function fitTextBoxes() {
  document.querySelectorAll("#ed_pages .ditem.tbox").forEach((el) => {
    const it = docItems.find((x) => x.id === el.dataset.id); if (!it || it.id === editingId) return;
    const td = el.querySelector(".tbtext"); if (!td) return;
    const ovW = el.parentNode.clientWidth || 1;
    if (it.tedit && td.scrollWidth > el.clientWidth + 1) { el.style.width = td.scrollWidth + "px"; it.nw = td.scrollWidth / ovW; it.ar = el.clientHeight / td.scrollWidth; }
    if (td.scrollHeight > el.clientHeight + 1) { el.style.height = td.scrollHeight + "px"; it.ar = td.scrollHeight / el.clientWidth; }
  });
}
function onPagePointerDown(e, ov, pi, dispW, dispH) {
  if (e.button && e.button !== 0) return;
  closePops();
  if (pi !== curPage) setCurPage(pi, false);
  if (edTool === "wm-pick") { pickWmColor(e, ov, pi, dispW, dispH); return; }
  if (edTool === "wm-brush") { startWmBrush(e, ov, pi, dispW, dispH); return; }
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
  if (!STICKY_TOOLS.has(tool)) { edTool = "select"; document.body.classList.remove("placing"); }
  if (tool === "text") addTextItem(x, y);
  else if (tool === "sig") addSigItem(x, y, "signature");
  else if (tool === "handwrite") addSigItem(x, y, "writing");
  else if (tool === "date") addDateItem(x, y);
  else if (tool === "check") addCheckItem(x, y);
  else if (tool === "note") addNoteItem(x, y);
  else if (tool.startsWith("field:")) addFieldItem(tool.split(":")[1], x, y);
}
// Drag out a rectangle / ellipse / whiteout / redaction box (a click makes a default one).
function startBoxCreate(e, ov, dispW, dispH, pi) {
  e.preventDefault();
  try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  const r = ov.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top, tool = edTool;
  const ghost = document.createElement("div");
  ghost.style.cssText = `position:absolute;left:${sx}px;top:${sy}px;width:0;height:0;border:1.5px dashed var(--sel);background:${tool === "redact" ? "rgba(0,0,0,.55)" : "rgba(55,143,217,.08)"};pointer-events:none;${tool === "shape:ellipse" ? "border-radius:50%" : ""}`;
  ov.appendChild(ghost);
  let bx = sx, by = sy, bw = 0, bh = 0;
  const mv = (ev) => {
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    bx = Math.min(sx, x); by = Math.min(sy, y); bw = Math.abs(x - sx); bh = Math.abs(y - sy);
    ghost.style.left = bx + "px"; ghost.style.top = by + "px"; ghost.style.width = bw + "px"; ghost.style.height = bh + "px";
  };
  const up = () => {
    ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up); ghost.remove();
    if (bw < 6 || bh < 6) { bw = dispW * 0.22; bh = tool === "whiteout" || tool === "redact" ? dispW * 0.04 : dispW * 0.13; bx = sx - bw / 2; by = sy - bh / 2; }
    const it = { id: "it" + itemSeq++, page: pi, nx: bx / dispW, ny: by / dispH, nw: bw / dispW, ar: bh / bw, opacity: 1, signer: activeSigner };
    if (tool === "whiteout") { it.type = "white"; it.color = TD.whiteout.color; }
    else if (tool === "redact") { it.type = "redact"; it.color = "#000000"; }
    else { it.type = "shape"; it.shape = tool.split(":")[1]; it.color = TD.shape.stroke; it.sw = TD.shape.width / REF_W; it.fill = TD.shape.fill; }
    docItems.push(it); selId = it.id; selDraw = null;
    setEdTool("select");
  };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}

// ---- one placed object -> DOM ---------------------------------------------
function tboxFont(it) {
  const info = pfontInfo(it);
  if (info) {
    const fb = info.fallback;
    if (info.loadedName && !it.ffOverride) return { css: `"${info.loadedName}", ${fb.css}`, weight: it.bold ? 700 : 400, style: it.italic ? "italic" : "normal", synth: !it.bold && !it.italic };
    if (!it.ffOverride) return { css: fb.css, weight: it.bold != null ? (it.bold ? 700 : 400) : fb.weight, style: it.italic != null ? (it.italic ? "italic" : "normal") : fb.style };
  }
  const fe = fontByKey(it.ff); if (fe.google) ensureFont(fe.name);
  if (fe.user) return { css: fe.css, weight: it.bold != null ? (it.bold ? 700 : 400) : fe.weight, style: it.italic != null ? (it.italic ? "italic" : "normal") : fe.fstyle, synth: !!fe.family };
  return { css: fe.css, weight: it.bold ? 700 : 400, style: it.italic ? "italic" : "normal" };
}
const tboxDisplay = (it) => { const g = glyphInfo(it); return g ? toFontStr(g, it.text || "") : (it.text || ""); };
function shapeSVG(it, w, h) {
  const sw = it.color === "none" ? 0 : Math.max(1, (it.sw || 3 / REF_W) * (w / it.nw)), fill = it.fill && it.fill !== "none" ? it.fill : "none", c = it.color === "none" ? "none" : itemColor(it);
  const inner = it.shape === "ellipse"
    ? `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(1, w / 2 - sw / 2)}" ry="${Math.max(1, h / 2 - sw / 2)}" fill="${fill}" stroke="${c}" stroke-width="${sw}"/>`
    : `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(1, w - sw)}" height="${Math.max(1, h - sw)}" fill="${fill}" stroke="${c}" stroke-width="${sw}"/>`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible;pointer-events:none">${inner}</svg>`;
}
const NOTE_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h10M5 10.5h10M5 14h6"/></svg>';
function itemEl(it, dispW, dispH) {
  const w = it.nw * dispW, h = it.nw * dispW * it.ar;
  const el = document.createElement("div");
  el.className = "ditem" + (it.id === selId ? " sel" : "") + (it.tbox ? " tbox" : "");
  el.dataset.id = it.id;
  el.style.cssText = `left:${it.nx * dispW}px;top:${it.ny * dispH}px;width:${w}px;height:${h}px;opacity:${it.opacity ?? 1};color:${itemColor(it)}`;
  if (it.tbox) {
    const f = tboxFont(it), fsPx = it.fs * dispW, pad = it.tedit ? 0 : Math.round(fsPx * 0.2);
    el.innerHTML = `<div class="tbtext" style="font-family:${f.css.replace(/"/g, "&quot;")};font-size:${fsPx}px;font-weight:${f.weight};font-style:${f.style};${f.synth ? "font-synthesis:none;" : ""}line-height:${it.lh || (it.tedit ? "normal" : 1.2)};letter-spacing:${it.ls || 0}em;color:${itemColor(it)};background:${it.bg && it.bg !== "none" ? it.bg : "transparent"};text-align:${it.align || "left"};padding:${pad}px;white-space:${it.tedit ? "pre" : "pre-wrap"}">${escapeHTML(tboxDisplay(it))}</div>`;
  } else if (it.type === "sig") el.innerHTML = it.svg.replace("<svg ", '<svg preserveAspectRatio="none" style="width:100%;height:100%;display:block;pointer-events:none" ');
  else if (it.type === "img") el.innerHTML = `<img src="${it.src}" alt="" draggable="false" style="width:100%;height:100%;display:block;pointer-events:none">`;
  else if (it.type === "shape") el.innerHTML = shapeSVG(it, w, h);
  else if (it.type === "white") el.style.background = it.color || "#fff";
  else if (it.type === "redact") el.style.background = "#000";
  else if (it.type === "note") {
    el.innerHTML = `<div class="dnote" style="--nc:${it.color || "#ffd54f"}">${NOTE_ICON}</div>`;
    if (it.id === selId) {
      const pop = document.createElement("div"); pop.className = "notepop";
      const when = it.created ? new Date(it.created).toLocaleString() : "";
      pop.innerHTML = `<div class="nmeta">${escapeHTML(it.author || "Note")}${when ? " · " + escapeHTML(when) : ""}</div><textarea placeholder="Write a comment…"></textarea>`;
      const ta = pop.querySelector("textarea"); ta.value = it.text || "";
      ta.oninput = () => { it.text = ta.value; };
      ta.onblur = () => scheduleSnapshot();
      ta.onkeydown = (ev) => ev.stopPropagation();
      pop.onpointerdown = (e) => e.stopPropagation();
      el.appendChild(pop);
    }
  } else {
    const fam = DOC_FONTS[it.font || 0].css;
    if (it.isField && it.fieldKind === "check") {
      el.innerHTML = `<div class="dfieldbox" style="display:flex;align-items:center;justify-content:center">` + (it.checked ? `<span style="font-weight:700;font-size:${h * 0.8}px;line-height:1">✓</span>` : "") + `</div>`;
    } else if (it.isField) {
      el.innerHTML = `<div class="dfieldbox"><span class="dfcap">${escapeHTML(it.label || "")}</span><div class="dtext" style="font-size:${h * 0.5}px;font-family:${fam}">${escapeHTML(it.text || "")}</div></div>`;
    } else {
      const extra = it.isMark ? "justify-content:center;font-weight:700;" : "";
      el.innerHTML = `<div class="dtext" style="${extra}font-size:${h * 0.7}px;font-family:${fam}">${escapeHTML(it.text)}</div>`;
    }
  }
  el.onpointerdown = (e) => {
    if (edTool !== "select" && edTool !== "edittext") return;
    if (e.target.closest(".dhandle,.dtrash,.notepop,.dgrip") || e.target.isContentEditable) return;
    e.preventDefault(); e.stopPropagation();
    closePops();
    const wasSel = selId === it.id;
    selId = it.id; selDraw = null;
    document.querySelectorAll("#ed_pages .ditem.sel").forEach((x) => { if (x !== el) x.classList.remove("sel"); });
    el.classList.add("sel"); syncItemUI(); updateEdChrome(); renderProps();
    startMove(it, el, e, dispW, dispH, wasSel);
  };
  if (isTextEditable(it)) el.ondblclick = () => { selId = it.id; startInlineEdit(it, el); };
  if (it.isField && it.fieldKind === "check") el.ondblclick = () => { it.checked = !it.checked; render(); };
  if (it.id === selId) {
    const corners = isFreeAspect(it) ? ["nw", "n", "ne", "e", "se", "s", "sw", "w"] : ["nw", "ne", "sw", "se"];
    corners.forEach((corner) => {
      const hd = document.createElement("div"); hd.className = "dhandle " + corner;
      hd.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); startResize(it, el, corner, e, dispW, dispH); };
      el.appendChild(hd);
    });
    if (it.tbox) {
      const g = document.createElement("div"); g.className = "dgrip"; g.title = "Drag to move"; g.textContent = "⠿";
      g.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); if (document.activeElement && document.activeElement.isContentEditable) document.activeElement.blur(); startMove(docItems.find((x) => x.id === it.id) || it, el, e, dispW, dispH, false, true); };
      el.appendChild(g);
    }
    const tr = document.createElement("div"); tr.className = "dtrash"; tr.title = it.tedit ? "Remove this text" : "Delete"; tr.innerHTML = TRASH();
    tr.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); deleteSelection(); };
    el.appendChild(tr);
  }
  return el;
}

// Live editing of a text box (and of edited PDF text, shown in the PDF's own font).
function caretOffset(td) { const s = getSelection(); if (!s.rangeCount) return null; const r = s.getRangeAt(0).cloneRange(); const pre = document.createRange(); pre.selectNodeContents(td); pre.setEnd(r.endContainer, r.endOffset); return pre.toString().length; }
function setCaret(td, off) {
  const s = getSelection(), r = document.createRange();
  let node = td.firstChild; if (!node) { td.appendChild(document.createTextNode("")); node = td.firstChild; }
  r.setStart(node, Math.min(off, node.textContent.length)); r.collapse(true); s.removeAllRanges(); s.addRange(r);
}
function startTboxEdit(it, el, cx, cy) {
  const td = el.querySelector(".tbtext"); if (!td) return;
  editingId = it.id;
  td.contentEditable = "true"; td.style.pointerEvents = "auto";
  td.focus();
  const sel = getSelection(); sel.removeAllRanges();
  let r = null;
  if (cx != null && document.caretRangeFromPoint) { try { r = document.caretRangeFromPoint(cx, cy); } catch (_) {} }
  if (!r || !td.contains(r.startContainer)) { r = document.createRange(); r.selectNodeContents(td); if (cx != null || it.text) r.collapse(false); }
  sel.addRange(r);
  const info = glyphInfo(it), mapped = !!info;
  td.oninput = () => {
    if (mapped) {
      const logical = fromFontStr(info, td.textContent), disp = toFontStr(info, logical);
      if (disp !== td.textContent) { const off = caretOffset(td); td.textContent = disp; setCaret(td, off == null ? disp.length : off); }
      it.text = logical;
    } else it.text = td.innerText.replace(/\n$/, "");
    const ovW = el.parentNode ? el.parentNode.clientWidth : 1;
    if (it.tedit && td.scrollWidth > el.clientWidth + 1) { el.style.width = td.scrollWidth + "px"; it.nw = td.scrollWidth / ovW; }
    if (td.scrollHeight > el.clientHeight + 1) { el.style.height = td.scrollHeight + "px"; }
    it.ar = el.clientHeight / el.clientWidth;
  };
  td.onpaste = (ev) => { ev.preventDefault(); const t = (ev.clipboardData || window.clipboardData).getData("text"); document.execCommand("insertText", false, it.tedit ? t.replace(/\s*\n\s*/g, " ") : t); };
  td.onblur = () => { td.removeAttribute("contenteditable"); editingId = null; render(); };
  td.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Escape") td.blur(); if (ev.key === "Enter" && it.tedit) { ev.preventDefault(); td.blur(); } };
}
function startInlineEdit(it, el) {
  const td = el.querySelector(".dtext"); if (!td) return;
  td.setAttribute("contenteditable", "true"); td.style.pointerEvents = "auto"; td.focus();
  const sel = getSelection(); sel.removeAllRanges();
  const r = document.createRange(); r.selectNodeContents(td); sel.addRange(r);
  td.oninput = () => { it.text = td.textContent; };
  td.onblur = () => { it.text = td.textContent; td.removeAttribute("contenteditable"); render(); };
  td.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); td.blur(); } if (ev.key === "Escape") td.blur(); };
}
function startMove(it, el, e, dispW, dispH, wasSel, fromGrip) {
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
  const up = (ev) => {
    el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
    if (!moved && !fromGrip) {
      if (it.tbox) {            // one click edits a text box right away, caret where you clicked
        const cx = ev.clientX, cy = ev.clientY;
        if (wasSel) { startTboxEdit(it, el, cx, cy); return; }
        render();
        requestAnimationFrame(() => { const ne = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"]`); if (ne) startTboxEdit(it, ne, cx, cy); });
        return;
      }
      if (wasSel && isTextEditable(it)) { startInlineEdit(it, el); return; }
      if (wasSel && it.isField && it.fieldKind === "check") { it.checked = !it.checked; render(); return; }
    }
    render();
  };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}
function startResize(it, el, corner, e, dispW, dispH) {
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const sx = e.clientX, sy = e.clientY;
  const ow = it.nw * dispW, oh = it.nw * dispW * it.ar, ox = it.nx * dispW, oy = it.ny * dispH;
  const west = corner.includes("w"), north = corner.includes("n"), horiz = corner.includes("e") || west, vert = north || corner.includes("s"), free = isFreeAspect(it);
  const mv = (ev) => {
    let dx = ev.clientX - sx, dy = ev.clientY - sy; if (west) dx = -dx; if (north) dy = -dy;
    let w = ow, h = oh;
    if (free) { if (horiz) w = Math.max(14, ow + dx); if (vert) h = Math.max(8, oh + dy); }
    else { const s = Math.max((ow + dx) / ow, (oh + dy) / oh, 10 / ow); w = ow * s; h = w * it.ar; }
    if (it.tbox) { const td = el.querySelector(".tbtext"); el.style.width = w + "px"; if (td && td.scrollHeight > h) h = td.scrollHeight; }
    it.nw = w / dispW; if (free) it.ar = h / w;
    const nx = west ? ox + (ow - w) : ox, ny = north ? oy + (oh - h) : oy;
    it.nx = nx / dispW; it.ny = ny / dispH;
    el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = nx + "px"; el.style.top = ny + "px";
    if (it.type === "text" && !it.isField && !it.tbox) { const td = el.querySelector(".dtext"); if (td) td.style.fontSize = h * 0.7 + "px"; }
    if (it.type === "shape") el.querySelector("svg").outerHTML = shapeSVG(it, w, h);
  };
  const up = () => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); render(); };
  el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up);
}

// ---- the PDF's own fillable form fields ----------------------------------------
function renderFields(ov, dispW, dispH, fields) {
  (fields || []).forEach((f) => {
    const x = f.nx * dispW, y = f.ny * dispH, w = f.nw * dispW, h = f.nh * dispH;
    if (f.type === "radio") {
      const rb = document.createElement("input"); rb.type = "radio"; rb.className = "dfield"; rb.name = "rf_" + f.name;
      rb.checked = fieldValues[f.name] === f.value; rb.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(14, h)}px;height:${Math.max(14, h)}px;margin:0`;
      rb.onchange = () => { if (rb.checked) { fieldValues[f.name] = f.value; scheduleSnapshot(); } };
      ov.appendChild(rb);
    } else if (f.type === "choice") {
      const sl = document.createElement("select"); sl.className = "dfield";
      sl.appendChild(new Option("", ""));
      (f.options || []).forEach(([v, l]) => sl.appendChild(new Option(l, v)));
      sl.value = fieldValues[f.name] || "";
      sl.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${Math.min(h * 0.7, 16)}px`;
      sl.onchange = () => { fieldValues[f.name] = sl.value; scheduleSnapshot(); };
      sl.onkeydown = (ev) => ev.stopPropagation();
      ov.appendChild(sl);
    } else if (f.type === "check") {
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
      inp.onkeydown = (ev) => ev.stopPropagation();
      ov.appendChild(inp);
    }
  });
}

// ---- drawings ------------------------------------------------------------------
function arrowHead(x0, y0, x1, y1, sw) {
  const ang = Math.atan2(y1 - y0, x1 - x0), L = Math.max(8, sw * 3.2), a = 0.5;
  const ax = x1 - L * Math.cos(ang - a), ay = y1 - L * Math.sin(ang - a);
  const bx = x1 - L * Math.cos(ang + a), by = y1 - L * Math.sin(ang + a);
  return `M${ax.toFixed(1)},${ay.toFixed(1)} L${x1.toFixed(1)},${y1.toFixed(1)} L${bx.toFixed(1)},${by.toFixed(1)}`;
}
function drawGeom(d, W, H) {
  if (d.pts) { const p = d.pts.map((q) => [(q[0] * W).toFixed(1), (q[1] * H).toFixed(1)]); return { path: "M" + p[0][0] + "," + p[0][1] + p.slice(1).map((q) => "L" + q[0] + "," + q[1]).join("") }; }
  return { x0: d.x0 * W, y0: d.y0 * H, x1: d.x1 * W, y1: d.y1 * H };
}
function drawMarkup(d, W, H) {
  const sw = Math.max(0.5, d.size * W), col = d.color, op = d.opacity ?? 1;
  if (d.pts) {
    if (!d.pts.length) return "";
    const hl = d.kind === "highlight" ? ` stroke-opacity="${(0.4 * op).toFixed(3)}" style="mix-blend-mode:multiply"` : ` stroke-opacity="${op}"`;
    return `<path d="${drawGeom(d, W, H).path}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${hl}/>`;
  }
  const { x0, y0, x1, y1 } = drawGeom(d, W, H);
  const line = `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-opacity="${op}"/>`;
  if (d.kind === "arrow") return line + `<path d="${arrowHead(x0, y0, x1, y1, sw)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" stroke-opacity="${op}"/>`;
  return line;
}
function hitMarkup(d, W, H) {
  const sw = Math.max(14, d.size * W + 10);
  if (d.pts) return `<path class="drawhit" d="${drawGeom(d, W, H).path}" fill="none" stroke="transparent" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const { x0, y0, x1, y1 } = drawGeom(d, W, H);
  return `<line class="drawhit" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="transparent" stroke-width="${sw}" stroke-linecap="round"/>`;
}
function drawBounds(d) {
  if (d.pts) { let a = 1e9, b = 1e9, c = -1e9, e = -1e9; for (const q of d.pts) { a = Math.min(a, q[0]); b = Math.min(b, q[1]); c = Math.max(c, q[0]); e = Math.max(e, q[1]); } return [a, b, c, e]; }
  return [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)];
}
function shiftDraw(d, dx, dy) { if (d.pts) d.pts = d.pts.map((q) => [q[0] + dx, q[1] + dy]); else { d.x0 += dx; d.x1 += dx; d.y0 += dy; d.y1 += dy; } }
function renderDraws(ov, dispW, dispH, pi, under) {
  const list = docDraws.filter((d) => (d.page || 0) === pi && ((d.kind === "highlight") === under));
  const svg = document.createElementNS(SVGNS, "svg");
  svg.classList.add(under ? "drawunder" : "drawlayer");
  svg.setAttribute("width", dispW); svg.setAttribute("height", dispH); svg.setAttribute("viewBox", `0 0 ${dispW} ${dispH}`);
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
      e.preventDefault(); e.stopPropagation(); closePops();
      selDraw = hit.parentNode.dataset.did; selId = null;
      startMoveDraw(e, ov, selDraw, dispW, dispH);
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
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    Object.assign(d, JSON.parse(JSON.stringify(orig))); shiftDraw(d, (ev.clientX - sx) / dispW, (ev.clientY - sy) / dispH);
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
  const kind = edTool, dd = drawDefaults(kind);
  const d = { id: "dr" + drawSeq++, kind, page: pi, color: dd.color, size: (kind === "highlight" ? dd.width * 5 : dd.width) / REF_W, opacity: 1 };
  const layer = ov.querySelector(kind === "highlight" ? "svg.drawunder" : "svg.drawlayer") || renderDraws(ov, dispW, dispH, pi, kind === "highlight");
  const g = document.createElementNS(SVGNS, "g"); layer.appendChild(g);
  const s = pt(e);
  if (kind === "pen" || kind === "highlight") d.pts = [s]; else { d.x0 = s[0]; d.y0 = s[1]; d.x1 = s[0]; d.y1 = s[1]; }
  const redraw = () => { g.innerHTML = drawMarkup(d, dispW, dispH); };
  redraw();
  const mv = (ev) => { const p = pt(ev); if (kind === "pen" || kind === "highlight") d.pts.push(p); else { d.x1 = p[0]; d.y1 = (kind === "underline" || kind === "strike") ? d.y0 : p[1]; } redraw(); };
  const up = () => {
    ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up);
    const trivial = d.pts ? d.pts.length < 2 : Math.hypot((d.x1 - d.x0) * dispW, (d.y1 - d.y0) * dispH) < 4;
    if (!trivial) docDraws.push(d);
    render();
  };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}
function drawAnnToCanvas(ctx, W, H, kinds, pi) {
  for (const d of docDraws) {
    if (!kinds.includes(d.kind) || (d.page || 0) !== (pi || 0)) continue;
    ctx.save();
    ctx.strokeStyle = d.color; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(0.5, d.size * W);
    ctx.globalAlpha = (d.opacity ?? 1) * (d.kind === "highlight" ? 0.4 : 1);
    if (d.kind === "highlight") ctx.globalCompositeOperation = "multiply";
    if (d.pts) { if (d.pts.length) { ctx.beginPath(); ctx.moveTo(d.pts[0][0] * W, d.pts[0][1] * H); for (let i = 1; i < d.pts.length; i++) ctx.lineTo(d.pts[i][0] * W, d.pts[i][1] * H); ctx.stroke(); } }
    else {
      const x0 = d.x0 * W, y0 = d.y0 * H, x1 = d.x1 * W, y1 = d.y1 * H;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      if (d.kind === "arrow") { const ang = Math.atan2(y1 - y0, x1 - x0), Ln = Math.max(8, ctx.lineWidth * 3.2), a = 0.5; ctx.beginPath(); ctx.moveTo(x1 - Ln * Math.cos(ang - a), y1 - Ln * Math.sin(ang - a)); ctx.lineTo(x1, y1); ctx.lineTo(x1 - Ln * Math.cos(ang + a), y1 - Ln * Math.sin(ang + a)); ctx.stroke(); }
    }
    ctx.restore();
  }
}
function roundRectPath(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }

// ---- undo / redo: objects, drawings, form values AND the page list -----------------
let undoStack = [], redoStack = [], lastSnap = null, lastSnapSig = "", restoring = false, snapTimer = 0, holdSnap = false;
function holdDuring(el, fn) { el.addEventListener("input", () => { holdSnap = true; fn(); }); el.addEventListener("change", () => { holdSnap = false; snapshotNow(); }); }
function snapSig() {
  return JSON.stringify(docItems, (k, v) => (k === "svg" || k === "src") ? (v ? v.length + ":" + v.slice(-32) : v) : v) + "|" + JSON.stringify(docDraws) + "|" + JSON.stringify(fieldValues) +
    "|" + docPages.map((p) => p.key + "@" + p.rot).join(",") + "|" + docSources.length;
}
function takeSnap() { return { items: docItems.map((it) => ({ ...it })), draws: JSON.parse(JSON.stringify(docDraws)), fields: { ...fieldValues }, pages: docPages.slice(), sources: docSources.slice() }; }
function scheduleSnapshot() { if (restoring || !doc) return; clearTimeout(snapTimer); snapTimer = setTimeout(snapshotNow, 220); }
function snapshotNow() {
  clearTimeout(snapTimer);
  if (!doc || restoring) return;
  const s = snapSig(); if (s === lastSnapSig) return;
  if (lastSnap) { undoStack.push(lastSnap); if (undoStack.length > 80) undoStack.shift(); redoStack = []; }
  lastSnap = takeSnap(); lastSnapSig = s; updateUndoButtons();
}
function resetHistory() { undoStack = []; redoStack = []; lastSnap = doc ? takeSnap() : null; lastSnapSig = doc ? snapSig() : ""; updateUndoButtons(); }
function restoreSnap(s) {
  restoring = true;
  docItems = s.items.map((it) => ({ ...it })); docDraws = JSON.parse(JSON.stringify(s.draws)); fieldValues = { ...s.fields };
  docPages = s.pages.slice(); docSources = s.sources.slice();
  curPage = Math.min(curPage, docPages.length - 1); doc = docPages[curPage];
  selId = null; selDraw = null; pagesSig = ""; orgSel.clear();
  render(); lastSnapSig = snapSig(); restoring = false; updateUndoButtons();
  renderPagesInBackground(loadToken);
}
function undo() { snapshotNow(); if (!undoStack.length) return; redoStack.push(lastSnap); lastSnap = undoStack.pop(); restoreSnap(lastSnap); }
function redo() { snapshotNow(); if (!redoStack.length) return; undoStack.push(lastSnap); lastSnap = redoStack.pop(); restoreSnap(lastSnap); }
function updateUndoButtons() { if ($("ed_undo")) $("ed_undo").disabled = !undoStack.length; if ($("ed_redo")) $("ed_redo").disabled = !redoStack.length; }

// ---- modes, tools, side panel ---------------------------------------------------
function closeDropdowns() { document.querySelectorAll(".dd.open").forEach((d) => d.classList.remove("open")); }
function openSide(on) { document.body.classList.toggle("side-open", !!on); $("ed_side_btn") && $("ed_side_btn").classList.toggle("on", !!on); }
function setEdMode(m) {
  edMode = m; document.body.dataset.edmode = m;
  document.querySelectorAll("#ed_tabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.edmode === m));
  closePanelTool(); closePops(); document.body.classList.remove("wmpanel");
  edTool = "select"; selId = null; selDraw = null;
  if (m === "sign") openSide(true); else if (m === "organize" || m === "edit") openSide(false);
  pagesSig = ""; render();
}
function setEdTool(t) {
  closeDropdowns(); closePops();
  if (!t) t = "select";
  if (t.startsWith("panel:")) { openPanelTool(t.slice(6)); return; }
  if (t === "image") { setEdTool("select"); pickImageForDoc(); return; }
  if (t === "wm") { openWmPanel(); return; }
  if (t === "drawsig") { openDrawPad("sig"); return; }
  if (t === "fonts") { setEdTool("select"); openFontScan(); return; }
  if (t === "detect" || t === "detectall") { setEdTool("select"); detectFormFields(t === "detectall"); return; }
  edTool = t;
  if (edTool !== "select") { selId = null; selDraw = null; }
  if (t === "sig" || t === "handwrite") openSide(true);
  // the dropdown button shows the tool chosen from it
  document.querySelectorAll("#ed_tools .dd").forEach((dd) => {
    const b = [...dd.querySelectorAll(".ddm [data-tool]")].find((x) => x.dataset.tool === t);
    const lab = dd.querySelector("[data-ddlabel]"); if (b && lab) lab.textContent = b.textContent.replace(/^[^\wA-Za-z]+/, "").trim();
  });
  if (workMode === "doc") render();
  if (t === "edittext") toast("Click any text on the page to edit it.");
}
// Tools from the Tools menu / nav applied to the open document.
const TOOL_MAP = {
  edit: ["edit", "select"], annotate: ["edit", "highlight"], highlight: ["edit", "highlight"], draw: ["edit", "pen"], addtext: ["edit", "text"],
  addimage: ["edit", "image"], whiteout: ["edit", "whiteout"], notes: ["edit", "note"], edittext: ["edit", "edittext"], redact: ["edit", "redact"],
  watermark: ["edit", "panel:watermark"], crop: ["edit", "panel:crop"], scanlook: ["edit", "select", "scan"],
  sign: ["sign", "sig"], fillsign: ["sign", "text"], adddate: ["sign", "date"], forms: ["sign", "field:text"], fillform: ["sign", "select"],
  write: ["sign", "handwrite"], handwrite: ["sign", "handwrite"], signature: ["sign", "sig", "signature"], sigimport: ["sign", "sig", "sigimport"],
  merge: ["organize"], organize: ["organize"], rotate: ["organize"], delete: ["organize"], split: ["organize", "panel:split"], extract: ["organize", "panel:extract"], number: ["organize", "panel:number"],
  unwatermark: ["edit", "wm"], drawsig: ["sign", "drawsig"], pdffonts: ["edit", "fonts"],
  compress: ["convert", "panel:compress"], pdf2img: ["convert", "panel:img"], ocr: ["convert", "panel:ocr"], flatten: ["convert", "panel:flatten"],
};
function applyTool(id) {
  const m = TOOL_MAP[id]; if (!m || !doc) return false;
  if (edMode !== m[0]) setEdMode(m[0]);
  if (m[1]) setEdTool(m[1]);
  if (m[2] === "scan") { applyTier("advanced"); const tg = document.querySelector('.sw-toggle[data-k="scanned"]'); if (tg && !tg.classList.contains("on")) tg.click(); openSide(true); const g = $("scan_group"); if (g) g.scrollIntoView({ block: "start" }); }
  if (m[2] === "sigimport") { applyTier("advanced"); $("sig_file").click(); }
  if (m[2] === "signature") { const b = document.querySelector('#mode [data-m="signature"]'); if (b && mode !== "signature") b.click(); }
  return true;
}
// PDF tools (watermark, crop, compress, split…) open on the right, on the document as you see it.
async function openPanelTool(id) {
  if (!window.__cal2RunPdfTool || !doc) return;
  toast("Preparing your document…");
  try {
    const bytes = await buildDocumentBytes();
    document.body.classList.add("toolpanel"); openSide(true);
    activePanelTool = id;
    await window.__cal2RunPdfTool(id, bytes, docName, [...orgSel]);
    $("panel").scrollTop = 0;
  } catch (e) { toast("That tool could not start: " + (e.message || e)); }
}
function closePanelTool() { activePanelTool = null; document.body.classList.remove("toolpanel"); }
// Results of document-changing tools replace the open document (Undo brings the old one back).
const APPLY_RESULT = /^(watermarked|numbered|cropped|compressed|flattened|ocr|redacted)\.pdf$/;
async function applyPdfResult(bytes, name) {
  if (workMode !== "doc" || !document.body.classList.contains("toolpanel") || !APPLY_RESULT.test(name)) return false;
  snapshotNow();
  const keepPage = curPage;
  docSources = []; docPages = []; docItems = []; docDraws = []; fieldValues = {}; selId = null; selDraw = null; pagesSig = "";
  await addSource(new Uint8Array(bytes), docName, "pdf");
  curPage = Math.min(keepPage, docPages.length - 1);
  await ensurePageImage(curPage); doc = docPages[curPage];
  closePanelTool(); render(); renderPagesInBackground(loadToken);
  toast("Done — the open document was updated. Ctrl+Z undoes it.");
  return true;
}

// ---- property bar (like the reference: font, size, colours, opacity, bold, align…) ----
let propsSig = "", popEl = null;
function closePops() { if (popEl) { popEl.remove(); popEl = null; } }
function pcell(...kids) { const d = document.createElement("div"); d.className = "pcell"; kids.forEach((k) => d.append(k)); return d; }
function mk(tag, props, html) { const e = document.createElement(tag); Object.assign(e, props || {}); if (html != null) e.innerHTML = html; return e; }
function colorBtn(value, allowNone, onPick, title) {
  const b = mk("button", { className: "cbtn" + (value === "none" ? " none" : ""), title: title || "Colour", type: "button" });
  if (value !== "none") b.style.background = value || "#000";
  b.onclick = (e) => {
    e.stopPropagation();
    if (popEl && popEl._for === b) { closePops(); return; }
    closePops();
    const pop = mk("div", { className: "cpop" }); pop._for = b;
    pop.appendChild(mk("div", { className: "lbl" }, title || "Colour"));
    if (allowNone) { const n = mk("button", { className: "cbtn none", title: "None", type: "button" }); n.onclick = () => { closePops(); onPick("none"); }; pop.appendChild(n); }
    PALETTE.forEach((c) => { const s = mk("button", { className: "cbtn", title: c, type: "button" }); s.style.background = c; s.onclick = () => { closePops(); onPick(c); }; pop.appendChild(s); });
    const cust = mk("input", { type: "color", value: /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000", title: "Custom colour" });
    cust.oninput = () => onPick(cust.value); pop.appendChild(cust);
    pop.onpointerdown = (ev) => ev.stopPropagation();
    document.body.appendChild(pop);
    const r = b.getBoundingClientRect(); pop.style.left = Math.max(8, Math.min(innerWidth - 200, r.left - 8)) + "px"; pop.style.top = (r.bottom + 6 + scrollY) + "px";
    popEl = pop;
  };
  return b;
}
// Font picker: every font in the library, searchable, each shown in its own face.
function fontPicker(value, hasPdf, onPick) {
  const b = mk("button", { className: "fbtn", type: "button", title: "Font" });
  const ent = fontEntry(value), label = value === "__pdf" ? "Original PDF font" : value;
  if (ent && ent.google) ensureFont(ent.name);
  b.innerHTML = `<span style="font-family:${ent ? ent.css.replace(/"/g, "'") : "inherit"}">${escapeHTML(label)}</span><svg class="i" viewBox="0 0 10 10" style="width:12px;height:12px"><path d="M2 4l3 3 3-3"/></svg>`;
  b.onclick = (e) => {
    e.stopPropagation();
    if (popEl && popEl._for === b) { closePops(); return; }
    closePops();
    const pop = mk("div", { className: "fpop" }); pop._for = b;
    const q = mk("input", { type: "search", placeholder: "Search " + FONT_LIB.length + " fonts…" });
    const list = mk("div", { className: "fl" });
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { ensureFont(en.target.dataset.f); io.unobserve(en.target); } }), { root: list });
    const build = () => {
      list.innerHTML = ""; const term = q.value.trim().toLowerCase();
      if (hasPdf && !term) { const ob = mk("button", { className: value === "__pdf" ? "on" : "" }); ob.textContent = "Original PDF font"; ob.onclick = () => { closePops(); onPick("__pdf"); }; list.appendChild(ob); }
      for (const cat of FONT_CATS) {
        const fonts = FONT_LIB.filter((f) => f.cat === cat && (!term || f.name.toLowerCase().includes(term)));
        if (!fonts.length) continue;
        list.appendChild(mk("h5", {}, cat));
        for (const f of fonts) {
          const fb = mk("button", { className: f.name === value ? "on" : "", title: f.name });
          const ui = userFontInfo(f); fb.textContent = ui ? toFontStr(ui, f.name) : f.name; fb.style.fontFamily = f.css; fb.dataset.f = f.name;
          fb.onclick = () => { closePops(); if (f.user) ufTouch(f.id); onPick(f.name); };
          list.appendChild(fb); if (f.google) io.observe(fb);
        }
      }
    };
    q.oninput = build; q.onkeydown = (ev) => ev.stopPropagation();
    if (docSources.some((s) => s && s.kind === "pdf")) { const sb = mk("button", { className: "fscanbtn", type: "button" }, "Find & save this PDF's fonts…"); sb.onclick = () => { closePops(); openFontScan(); }; pop.appendChild(sb); }
    pop.prepend(q, list); pop.onpointerdown = (ev) => ev.stopPropagation();
    document.body.appendChild(pop);
    const r = b.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(innerWidth - 300, r.left)) + "px"; pop.style.top = (r.bottom + 6 + scrollY) + "px";
    popEl = pop; build(); q.focus();
  };
  return b;
}

function numBox(value, min, max, step, onChange, title) {
  const n = mk("input", { type: "number", value: String(value), min, max, step: step || 1, title: title || "" });
  n.onchange = () => { const v = Math.max(min, Math.min(max, +n.value || min)); n.value = v; onChange(v); };
  n.oninput = () => { const v = +n.value; if (n.value !== "" && v >= min && v <= max) onChange(v); };
  n.onkeydown = (e) => e.stopPropagation();
  return n;
}
function selBox(options, value, onChange, title) {
  const s = mk("select", { title: title || "" });
  options.forEach(([v, l]) => { const o = mk("option", { value: v, textContent: l }); s.appendChild(o); });
  s.value = value; s.onchange = () => onChange(s.value);
  return s;
}
function pbtn(html, on, onClick, title) { const b = mk("button", { className: "pbtn" + (on ? " on" : ""), type: "button", title: title || "" }, html); b.onclick = onClick; return b; }
const ICON_DUP = '<svg class="i" viewBox="0 0 20 20"><rect x="6" y="6" width="10" height="11" rx="1.2"/><path d="M4 13V4.2A1.2 1.2 0 015.2 3H13"/></svg>';
const ICON_OPA = '<svg class="i" viewBox="0 0 20 20"><circle cx="8" cy="8" r="5" fill="currentColor" opacity=".9"/><circle cx="12" cy="12" r="5"/></svg>';
const ICON_LW = '<svg class="i" viewBox="0 0 20 20"><path d="M3 5h14" stroke-width="1"/><path d="M3 9h14" stroke-width="2"/><path d="M3 14h14" stroke-width="3.4"/></svg>';
const ALIGN_ICONS = { left: '<svg class="i" viewBox="0 0 20 20"><path d="M3 5h14M3 9h9M3 13h14M3 17h9"/></svg>', center: '<svg class="i" viewBox="0 0 20 20"><path d="M3 5h14M5.5 9h9M3 13h14M5.5 17h9"/></svg>', right: '<svg class="i" viewBox="0 0 20 20"><path d="M3 5h14M8 9h9M3 13h14M8 17h9"/></svg>' };
function opacityCell(get, set) { return pcell(mk("span", { title: "Opacity" }, ICON_OPA), numBox(Math.round(get() * 100), 5, 100, 5, (v) => { set(v / 100); render(); }, "Opacity %")); }
function renderProps() {
  const host = $("props"); if (!host) return;
  const it = selectedItem(), d = selectedDraw(), t = edTool;
  const sig = [edMode, t, it && it.id, it && it.type, it && (it.tbox ? "tb" : ""), d && d.id, it && it.pfont, it && it.ffOverride].join("|");
  if (sig === propsSig && host.contains(document.activeElement)) return;     // don't fight typing in the bar
  propsSig = sig;
  host.innerHTML = "";
  const add = (c) => host.appendChild(c);
  const dupDel = () => pcell(pbtn(ICON_DUP, false, duplicateSelection, "Duplicate"));
  if (edMode === "organize") { add(mk("div", { className: "phint" }, "Drag pages to reorder · click to select (Ctrl/Shift for several) · double-click to open a page · drop files to add them")); return; }
  if (edMode === "convert" && !it && !d) { add(mk("div", { className: "phint" }, "Pick a tool above. It works on the document as you see it; results that change the document update it here (Ctrl+Z undoes).")); return; }
  if (it && it.tbox) {
    const info = pfontInfo(it);
    add(pcell(fontPicker(info && !it.ffOverride ? "__pdf" : fontByKey(it.ff).name, !!info, (v) => { if (v === "__pdf") it.ffOverride = false; else { it.ff = v; if (info) it.ffOverride = true; if (!it.tedit) TD.text.ff = v; ensureFont(v); } render(); })));
    const pts = pagePts(it.page || 0);
    const setPt = (v) => { v = Math.max(4, Math.min(200, Math.round(v * 10) / 10)); it.fs = v / pts; if (!it.tedit) TD.text.pt = v; propsSig = ""; render(); };
    add(pcell(pbtn("A−", false, () => setPt(it.fs * pts - 1), "Smaller text"), numBox(Math.round(it.fs * pts * 10) / 10, 4, 200, 0.5, setPt, "Font size (pt)"), pbtn("A+", false, () => setPt(it.fs * pts + 1), "Bigger text"),
      pbtn("⤢ Fit", false, () => { fitTextToBox(it); propsSig = ""; render(); }, it.tedit ? "Size the text to fill the original line's width" : "Size the text so it fills the box")));
    add(pcell(mk("span", { title: "Line spacing" }, "↕"), selBox([["", "Auto"], ["1", "1.0"], ["1.15", "1.15"], ["1.2", "1.2"], ["1.5", "1.5"], ["2", "2.0"]], String(it.lh || ""), (v) => { it.lh = v ? +v : undefined; render(); }, "Line spacing"),
      mk("span", { title: "Letter spacing" }, "↔"), numBox(Math.round((it.ls || 0) * 100), -20, 60, 1, (v) => { it.ls = v / 100; render(); }, "Letter spacing (% of size)")));
    add(pcell(colorBtn(it.color || "#000000", false, (c) => { it.color = c; if (!it.tedit) TD.text.color = c; render(); }, "Text colour"), colorBtn(it.bg || "none", true, (c) => { it.bg = c; render(); }, "Background")));
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; }));
    add(pcell(pbtn("<b>B</b>", !!it.bold, () => { it.bold = !it.bold; if (!it.tedit) TD.text.bold = it.bold; render(); }, "Bold"), pbtn("<i style='font-family:serif;font-size:18px'>I</i>", !!it.italic, () => { it.italic = !it.italic; render(); }, "Italic"),
      pbtn(ALIGN_ICONS[it.align || "left"], false, () => { it.align = { left: "center", center: "right", right: "left" }[it.align || "left"]; render(); }, "Alignment")));
    add(dupDel());
    return;
  }
  if (it && it.type === "shape") {
    add(pcell(colorBtn(it.fill || "none", true, (c) => { it.fill = c; TD.shape.fill = c; render(); }, "Fill colour"), colorBtn(it.color || "none", true, (c) => { it.color = c; if (c !== "none") TD.shape.stroke = c; render(); }, "Border colour")));
    add(pcell(mk("span", { title: "Border width" }, ICON_LW), numBox(Math.round((it.sw || 3 / REF_W) * REF_W), 0, 40, 1, (v) => { it.sw = v / REF_W; TD.shape.width = v; render(); }, "Border width")));
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; }));
    add(pcell(selBox([["rect", "Rectangle"], ["ellipse", "Ellipse"]], it.shape, (v) => { it.shape = v; render(); }, "Shape")));
    add(dupDel()); return;
  }
  if (it && it.type === "white") { add(pcell(colorBtn(it.color || "#ffffff", false, (c) => { it.color = c; TD.whiteout.color = c; render(); }, "Cover colour"))); add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; })); add(dupDel()); return; }
  if (it && it.type === "redact") { add(mk("div", { className: "phint" }, "Redaction — whatever is under the black box is removed from the downloaded PDF.")); add(dupDel()); return; }
  if (it && it.type === "sig") {
    add(pcell(colorBtn(itemColor(it), false, (c) => { it.color = c; render(); }, "Ink colour")));
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; }));
    if (it.dynamic) add(pcell(pbtn("↻ New hand", false, newHand, "Re-roll this handwriting"), pbtn("Edit words ›", false, () => { openSide(true); $("text").focus(); }, "Change the words in the side panel")));
    add(dupDel()); return;
  }
  if (it && it.isDate) {
    const dI = mk("input", { type: "date", value: it.date || "" }), tI = mk("input", { type: "time", value: it.time || "" });
    const zones = TZ_LIST.includes(localTzAbbr()) ? TZ_LIST : [localTzAbbr(), ...TZ_LIST];
    const zS = selBox(zones.map((z) => [z, z]), it.tz || "UTC", () => apply(), "Time zone");
    const apply = () => { it.date = dI.value || it.date; it.time = tI.value || it.time; it.tz = zS.value || it.tz; it.text = fmtDocuSign(it.date, it.time, it.tz); render(); };
    dI.oninput = apply; tI.oninput = apply; dI.onkeydown = tI.onkeydown = (e) => e.stopPropagation();
    add(pcell(dI, tI, zS));
    add(pcell(selBox(DOC_FONTS.map((f, i) => [String(i), f.name]), String(it.font || 0), (v) => { it.font = +v; render(); }, "Font")));
    add(pcell(colorBtn(itemColor(it), false, (c) => { it.color = c; render(); }, "Colour")));
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; })); add(dupDel()); return;
  }
  if (it && it.isMark) {
    add(pcell(pbtn("✓ Tick", it.mark === "check", () => setMark("check")), pbtn("✗ Cross", it.mark === "x", () => setMark("x"))));
    add(pcell(colorBtn(itemColor(it), false, (c) => { it.color = c; render(); }, "Colour")));
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; })); add(dupDel()); return;
  }
  if (it && it.isField) {
    if (it.fieldKind === "check") add(pcell(pbtn(it.checked ? "☑ Ticked" : "☐ Not ticked", !!it.checked, () => { it.checked = !it.checked; render(); })));
    else { const lab = mk("input", { type: "text", value: it.label || "", placeholder: "Label", title: "Field label" }); lab.oninput = () => { it.label = lab.value; }; lab.onchange = () => render(); lab.onkeydown = (e) => e.stopPropagation(); add(pcell(mk("label", {}, "Label"), lab)); }
    add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; })); add(dupDel()); return;
  }
  if (it && it.type === "note") { add(pcell(colorBtn(it.color || "#ffd54f", false, (c) => { it.color = c; TD.note.color = c; render(); }, "Note colour"))); add(dupDel()); return; }
  if (it && it.type === "img") { add(opacityCell(() => it.opacity ?? 1, (v) => { it.opacity = v; })); add(dupDel()); return; }
  if (d) {
    add(pcell(colorBtn(d.color, false, (c) => { d.color = c; drawDefaults(d.kind).color = c; render(); }, "Colour")));
    add(pcell(mk("span", { title: "Width" }, ICON_LW), numBox(Math.round(d.size * REF_W / (d.kind === "highlight" ? 5 : 1)), 1, 40, 1, (v) => { d.size = (d.kind === "highlight" ? v * 5 : v) / REF_W; render(); }, "Width")));
    add(opacityCell(() => d.opacity ?? 1, (v) => { d.opacity = v; })); add(dupDel()); return;
  }
  // nothing selected: options for the active tool
  if (DRAW_TOOLS.has(t)) {
    const dd = drawDefaults(t);
    add(pcell(colorBtn(dd.color, false, (c) => { dd.color = c; propsSig = ""; renderProps(); }, "Colour")));
    add(pcell(mk("span", { title: "Width" }, ICON_LW), numBox(dd.width, 1, 40, 1, (v) => { dd.width = v; }, "Width")));
  } else if (t === "shape:rect" || t === "shape:ellipse") {
    add(pcell(colorBtn(TD.shape.fill, true, (c) => { TD.shape.fill = c; propsSig = ""; renderProps(); }, "Fill colour"), colorBtn(TD.shape.stroke, true, (c) => { TD.shape.stroke = c; propsSig = ""; renderProps(); }, "Border colour")));
    add(pcell(mk("span", { title: "Border width" }, ICON_LW), numBox(TD.shape.width, 0, 40, 1, (v) => { TD.shape.width = v; }, "Border width")));
  } else if (t === "text") {
    add(pcell(fontPicker(fontByKey(TD.text.ff).name, false, (v) => { TD.text.ff = v; ensureFont(v); propsSig = ""; renderProps(); })));
    add(pcell(numBox(TD.text.pt, 4, 200, 1, (v) => { TD.text.pt = v; }, "Font size (pt)")));
    add(pcell(colorBtn(TD.text.color, false, (c) => { TD.text.color = c; propsSig = ""; renderProps(); }, "Text colour")));
  } else if (t === "whiteout") add(pcell(colorBtn(TD.whiteout.color, false, (c) => { TD.whiteout.color = c; propsSig = ""; renderProps(); }, "Cover colour")));
  add(mk("div", { className: "phint" }, TOOL_HINTS[t] || TOOL_HINTS.select));
}
function updateEdChrome() {
  document.querySelectorAll("#ed_tools [data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === edTool));
  document.querySelectorAll("#ed_tools [data-ddbtn]").forEach((b) => { const dd = b.closest(".dd"); b.classList.toggle("on", !![...dd.querySelectorAll(".ddm [data-tool]")].find((x) => x.dataset.tool === edTool)); });
  if ($("ed_zval")) $("ed_zval").textContent = Math.round(edZoom * 100) + "%";
  if ($("ed_pagectr") && docPages.length) $("ed_pagectr").textContent = (curPage + 1) + " / " + docPages.length;
  if ($("pg_prev")) { $("pg_prev").disabled = curPage <= 0; $("pg_next").disabled = curPage >= docPages.length - 1; }
  updateUndoButtons();
}
function syncItemUI() {
  const it = selectedItem(), ta = $("text");
  if (it && it.type === "sig" && it.dynamic && typeof it.text === "string" && ta && document.activeElement !== ta && ta.value !== it.text) ta.value = it.text;
}
function setMark(m) { const it = selectedItem(); if (!it || !it.isMark) return; it.mark = m; it.text = markGlyph(m); render(); }

function animateSVG(svg) {
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 800, h = +(svg.match(/height="(\d+)"/) || [])[1] || 300;
  const speed = +$("speed").value; if (speed <= 0) return svg;
  const dur = ((6.5 - speed / 100 * 5.3) * 0.5).toFixed(2);
  const defs = `<defs><clipPath id="wo"><rect x="0" y="0" width="0" height="${h}">` +
    `<animate attributeName="width" from="0" to="${w}" dur="${dur}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.33 0 0.2 1"/></rect></clipPath></defs>`;
  return svg.replace("><g>", `>${defs}<g clip-path="url(#wo)">`);
}

// ---- opening and closing documents ------------------------------------------------
async function openDocFile(f) {
  const u8 = new Uint8Array(await f.arrayBuffer());
  const kind = isPdfFile(f) ? "pdf" : "image";
  await openDocBytes(u8.slice(), f.name, kind);
  rememberCurrentDoc(f.name, kind === "pdf" ? "application/pdf" : (f.type || "image/png"), u8).catch(() => {});
}
async function openDocBytes(u8, name, kind) {
  errEl.textContent = "";
  toast("Opening " + (name || "document") + "…");
  const token = ++loadToken;
  docName = name || "document";
  docSources = []; docPages = []; docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {};
  pagesSig = ""; curPage = 0; edZoom = 1; orgSel.clear(); textBlocks.clear(); closePanelTool();
  await addSource(u8, name, kind);
  await ensurePageImage(0);
  doc = docPages[0];
  setWorkMode("doc");
  // a new document starts in Edit & Annotate with the side panel closed
  edMode = "edit"; document.body.dataset.edmode = "edit";
  document.querySelectorAll("#ed_tabs .tab").forEach((t) => t.classList.toggle("on", t.dataset.edmode === "edit"));
  openSide(false);
  edTool = "select";
  resetHistory(); render();
  renderPagesInBackground(token);
  toast("Opened " + docName + (docPages.length > 1 ? ` — ${docPages.length} pages` : "") + ".");
}
function closeDoc() {
  loadToken++;
  doc = null; docSources = []; docPages = []; pagesSig = ""; curPage = 0;
  docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {}; edTool = "select"; orgSel.clear(); textBlocks.clear();
  closePanelTool();
  ["ed_pages", "ed_thumbs", "org_grid"].forEach((id) => { if ($(id)) $(id).innerHTML = ""; });
  resetHistory();
}
function baseName() { return (docName || "document").replace(/\.[^.]+$/, "").replace(/[^\w\- ]+/g, "").trim() || "document"; }

// ---- recent files ---------------------------------------------------------------------
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
  refreshRecentLists();
}
function refreshRecentLists() { renderSignRecents(); renderRailRecents(); if (window.__cal2RefreshHomeRecents) window.__cal2RefreshHomeRecents(); }
async function renderSignRecents() {
  const host = $("recent_sign"); if (!host) return;
  const list = await listRecents();
  host.innerHTML = list.length ? '<div class="rlabel">Recent</div>' : "";
  for (const r of list) host.appendChild(makeRecentCard(r, () => reopenRecent(r), async () => { await delRecent(r.id); refreshRecentLists(); }));
}
async function renderRailRecents() {
  const host = $("rail_recent"); if (!host) return;
  const list = await listRecents();
  host.innerHTML = list.length ? "" : '<div class="note" style="margin:0">Files you open show up here.</div>';
  for (const r of list) {
    const row = document.createElement("div"); row.className = "ritem"; row.title = "Open " + r.name;
    row.innerHTML = `${r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="noimg"></span>'}<span>${escapeHTML(r.name)}</span><button class="radd" title="Add its pages to this document">+</button>`;
    row.onclick = (e) => { if (e.target.closest(".radd")) return; reopenRecent(r); };
    row.querySelector(".radd").onclick = (e) => { e.stopPropagation(); addRecentToDoc(r.id); };
    host.appendChild(row);
  }
}
async function reopenRecent(rec) {
  const full = await getRecent(rec.id); if (!full) return;
  try {
    await openDocBytes(new Uint8Array(full.bytes), full.name, full.type === "pdf" ? "pdf" : "image");
    if (!location.hash.startsWith("#/edit")) location.hash = "#/edit";
  } catch (e) { errEl.textContent = "Could not reopen: " + (e.message || e); }
}

// ---- signers ---------------------------------------------------------------------------
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
    for (const word of para.split(/(?<=\s)/)) {
      const t = line + word;
      if (ctx.measureText(t.trimEnd()).width > maxW && line) { out.push(line.trimEnd()); line = word.trimStart(); } else line = t;
    }
    out.push(line.trimEnd());
  }
  return out;
}
async function drawDocItemToCtx(ctx, it, W, H, res) {
  const x = it.nx * W, y = it.ny * H, w = it.nw * W, h = it.nw * W * it.ar;
  ctx.save(); ctx.globalAlpha = it.opacity ?? 1;
  if (it.tbox) {
    if (it.tedit && it.cover) { const c = it.cover; ctx.save(); ctx.globalAlpha = 1; ctx.fillStyle = it.coverBg || "#fff"; ctx.fillRect(c.nx * W, c.ny * H, c.nw * W, c.nh * H); ctx.restore(); }
    const f = tboxFont(it), fsPx = it.fs * W, pad = it.tedit ? 0 : fsPx * 0.2;
    if (it.bg && it.bg !== "none") { ctx.fillStyle = it.bg; ctx.fillRect(x, y, w, h); }
    await ensureFontsIn(f.css);
    ctx.font = `${f.style} ${f.weight} ${fsPx}px ${f.css}`;
    ctx.fillStyle = itemColor(it); ctx.textBaseline = "alphabetic";
    try { ctx.letterSpacing = ((it.ls || 0) * fsPx) + "px"; } catch (_) {}
    const disp = tboxDisplay(it);
    try { await document.fonts.load(ctx.font, disp.slice(0, 60) || "A"); } catch (_) {}
    if (it.tedit) ctx.fillText(disp, x, y + (it.asc || 0.86) * fsPx);
    else {
      const lh = fsPx * (it.lh || 1.2), lines = wrapLines(ctx, disp, Math.max(4, w - pad * 2));
      ctx.textAlign = it.align === "center" ? "center" : it.align === "right" ? "right" : "left";
      const lx = it.align === "center" ? x + w / 2 : it.align === "right" ? x + w - pad : x + pad;
      lines.forEach((ln, i) => ctx.fillText(ln, lx, y + pad + i * lh + (lh - fsPx) / 2 + fsPx * 0.82));
      ctx.textAlign = "left";
    }
    try { ctx.letterSpacing = "0px"; } catch (_) {}
  } else if (it.type === "sig") {
    const img = await svgToImage(it.svg.replace("<svg ", `<svg style="color:${itemColor(it)}" `));
    ctx.drawImage(img, x, y, w, h);
  } else if (it.type === "img") {
    try { ctx.drawImage(await loadImg(it.src), x, y, w, h); } catch (_) {}
  } else if (it.type === "white") { ctx.fillStyle = it.color || "#fff"; ctx.fillRect(x, y, w, h); }
  else if (it.type === "redact") { ctx.globalAlpha = 1; ctx.fillStyle = "#000"; ctx.fillRect(x, y, w, h); }
  else if (it.type === "shape") {
    const sw = it.color === "none" ? 0 : Math.max(1, (it.sw || 3 / REF_W) * W);
    ctx.beginPath();
    if (it.shape === "ellipse") ctx.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2 - sw / 2), Math.max(1, h / 2 - sw / 2), 0, 0, Math.PI * 2);
    else ctx.rect(x + sw / 2, y + sw / 2, Math.max(1, w - sw), Math.max(1, h - sw));
    if (it.fill && it.fill !== "none") { ctx.fillStyle = it.fill; ctx.fill(); }
    if (sw) { ctx.lineWidth = sw; ctx.strokeStyle = itemColor(it); ctx.stroke(); }
  } else if (it.type === "note") {
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
// Compose a page. mode: "all" (picture + everything), "overlay" (objects only, no
// picture / interactive fields / notes — laid over a vector page), "nofields"
// (picture + everything except interactive fields and notes).
async function composePage(pi, res, mode = "all") {
  const p = await ensurePageImage(pi);
  const W = Math.round(p.w * res), H = Math.round(p.h * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (mode !== "overlay") {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (p.img) ctx.drawImage(p.img, 0, 0, W, H);
    for (const f of (p.fields || [])) {
      const v = fieldValues[f.name]; if (v == null || v === "" || v === false) continue;
      const x = f.nx * W, y = f.ny * H, w = f.nw * W, h = f.nh * H;
      ctx.fillStyle = "#15233a";
      if (f.type === "radio") { if (v === f.value) { ctx.beginPath(); ctx.arc(x + w / 2, y + h / 2, Math.min(w, h) * 0.28, 0, Math.PI * 2); ctx.fill(); } }
      else if (f.type === "choice") { const o = (f.options || []).find((q) => q[0] === v); ctx.font = `${Math.min(h * 0.72, 18 * res)}px system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.fillText(String(o ? o[1] : v), x + 3, y + h / 2); }
      else if (f.type === "check") { ctx.font = `${h * 0.9}px system-ui, sans-serif`; ctx.textBaseline = "top"; ctx.fillText("X", x + w * 0.12, y); }
      else { ctx.font = `${Math.min(h * 0.72, 18 * res)}px system-ui, sans-serif`; ctx.textBaseline = "middle"; ctx.fillText(String(v), x + 3, y + h / 2); }
    }
  }
  drawAnnToCanvas(ctx, W, H, ["highlight"], pi);
  for (const it of docItems) {
    if ((it.page || 0) !== pi) continue;
    if (mode !== "all" && (it.isField || it.type === "note")) continue;
    await drawDocItemToCtx(ctx, it, W, H, res);
  }
  drawAnnToCanvas(ctx, W, H, ["pen", "line", "arrow", "underline", "strike"], pi);
  return c;
}
function pageHasContent(pi) { return docItems.some((it) => (it.page || 0) === pi) || docDraws.some((d) => (d.page || 0) === pi); }

async function composeCanvas() {
  const res = +$("resolution").value;
  try { await document.fonts.ready; } catch (_) {}
  if (workMode === "doc" && doc) return finishCanvas(await composePage(curPage, res / 2));
  const W = Math.round(hwW * res), H = Math.round(hwH * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (!toggles.transparent) { ctx.fillStyle = paper; ctx.fillRect(0, 0, W, H); }
  ctx.drawImage(await svgToImage(rawSVG), 0, 0, W, H);
  return finishCanvas(c);
}

function download(name, blob) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
let toastTimer = 0;
function toast(m) { const t = $("toast"); if (!t) return; t.textContent = m; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2800); }
function flash(m) { toast(m); }
async function exportPNG() {
  try {
    const c = await composeCanvas();
    const name = workMode === "doc" && doc ? `${baseName()}-page${curPage + 1}.png` : "calligraphy.png";
    c.toBlob((b) => { download(name, b); toast("Saved PNG."); }, "image/png");
  } catch (e) { errEl.textContent = "PNG export failed: " + (e.message || e); }
}
// Flattened PDF: every page as a picture with everything baked in.
async function exportPDF() {
  try {
    const { jsPDF } = window.jspdf;
    if (workMode === "doc" && doc) {
      snapshotNow();
      try { await document.fonts.ready; } catch (_) {}
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

// The document as an editable PDF: original pages stay vector (selectable text), your
// objects are laid over them, form-builder fields become real fields and notes real
// comments. Pages that were rotated, came from pictures, or carry redactions become a
// flat picture so nothing hidden survives.
async function buildOutputPdf() {
  const L = window.PDFLib;
  if (!L) throw new Error("PDF engine not loaded yet");
  try { await document.fonts.ready; } catch (_) {}
  const s0 = docSources[0];
  const pristine = docSources.length === 1 && s0.kind === "pdf" && docPages.length === s0.pdf.numPages && docPages.every((p, i) => p.src === 0 && p.idx === i && !p.rot);
  const libs = new Map();
  const lib = async (si) => { if (!libs.has(si)) libs.set(si, await L.PDFDocument.load(docSources[si].bytes, { ignoreEncryption: true })); return libs.get(si); };
  let pdf;
  if (pristine) pdf = await lib(0);
  else {
    pdf = await L.PDFDocument.create();
    for (const p of docPages) {
      const src = docSources[p.src];
      if (src.kind === "pdf") { const [cp] = await pdf.copyPages(await lib(p.src), [p.idx]); pdf.addPage(cp); }
      else pdf.addPage([p.w / 2, p.h / 2]);
    }
  }
  const form = pdf.getForm();
  let nf = 0, nn = 0; const used = {};
  for (let i = 0; i < docPages.length; i++) {
    const p = docPages[i];
    let page = pdf.getPage(i);
    const base = page.getRotation().angle % 360;
    const flat = docSources[p.src].kind !== "pdf" || p.rot || base || docItems.some((it) => (it.page || 0) === i && it.type === "redact");
    if (flat) {
      const c = await composePage(i, 1.25, "nofields");
      const img = await pdf.embedJpg(dataURLtoU8(c.toDataURL("image/jpeg", 0.92)));
      const pw = p.w / 2, ph = p.h / 2;
      const np = pdf.insertPage(i, [pw, ph]); np.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
      pdf.removePage(i + 1); page = np;
    } else if (docItems.some((it) => (it.page || 0) === i && !it.isField && it.type !== "note") || docDraws.some((d) => (d.page || 0) === i)) {
      const crisp = docItems.some((it) => (it.page || 0) === i && it.tbox);
      const ann = await composePage(i, crisp ? 1.5 : 1, "overlay");
      const { width: pw, height: ph } = page.getSize();
      page.drawImage(await pdf.embedPng(ann.toDataURL("image/png")), { x: 0, y: 0, width: pw, height: ph });
    }
    const { width: pw, height: ph } = page.getSize();
    for (const it of docItems) {
      if ((it.page || 0) !== i) continue;
      const wf = it.nw * pw, hf = it.nw * pw * it.ar * (pageAspect(i) * ph / pw), x = it.nx * pw;
      if (it.type === "note") {
        try {
          const s = Math.max(14, Math.min(wf, 24)), y = ph - it.ny * ph - s;
          const hex = (it.color || "#ffd54f").replace("#", ""), rgb = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16) / 255);
          const annot = pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [x, y, x + s, y + s], Name: "Comment", F: 4, Open: false,
            Contents: L.PDFHexString.fromText(it.text || ""), T: L.PDFHexString.fromText(it.author || "Note"), C: rgb });
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
        if (it.fieldKind === "check") { const s = Math.min(wf, hf) || 14, y = ph - it.ny * ph - s; const cb = form.createCheckBox(name); cb.addToPage(page, { x, y, width: s, height: s }); if (it.checked) cb.check(); }
        else { const y = ph - it.ny * ph - hf; const tf = form.createTextField(name); if (it.text) tf.setText(String(it.text)); tf.addToPage(page, { x, y, width: wf, height: hf }); }
        nf++;
      } catch (_) {}
    }
  }
  if (pristine) for (const p of docPages) for (const f of (p.fields || [])) {
    const v = fieldValues[f.name]; if (v == null || v === "") continue;
    try {
      if (f.type === "check") { if (v) form.getCheckBox(f.name).check(); }
      else if (f.type === "radio") { if (v === f.value) { const rg = form.getRadioGroup(f.name), opts = rg.getOptions(), pick = opts.includes(String(v)) ? String(v) : opts[+v]; if (pick != null) rg.select(pick); } }
      else if (f.type === "choice") { const fld = form.getField(f.name); if (fld.select) fld.select(String(v)); }
      else form.getTextField(f.name).setText(String(v));
    } catch (_) {}
  }
  return { pdf, nf, nn };
}
async function buildDocumentBytes() { const { pdf } = await buildOutputPdf(); return pdf.save(); }
async function exportFillablePDF() {
  if (!doc) { errEl.textContent = "Open a document first."; return; }
  try {
    snapshotNow(); toast("Building your PDF…");
    const { pdf, nf, nn } = await buildOutputPdf();
    const bytes = await pdf.save();
    download(baseName() + "-editable.pdf", new Blob([bytes], { type: "application/pdf" }));
    const bits = [nf ? `${nf} fillable field${nf > 1 ? "s" : ""}` : "", nn ? `${nn} comment${nn > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
    toast("Saved " + baseName() + "-editable.pdf" + (bits ? " — " + bits : "") + ".");
  } catch (e) { errEl.textContent = "PDF export failed: " + (e.message || e); toast("PDF export failed: " + (e.message || e)); }
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
$("sig_tune").onclick = () => { if (sx.src) openSigStudio(); else $("sig_file").click(); };
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
function loadSigFile(f) { if (f) openSigStudio(f); }

// The sidebar threshold re-traces the last imported signature with the same settings.
function processSignature() {
  if (!sigImg) return;
  const r = traceSig(sigImg, { ...sigFx, thresh: +$("sig_threshold").value });
  if (r.err) { sigSVG = ""; errEl.textContent = r.err; return; }
  sigSVG = r.svg; sigBox = { w: r.w, h: r.h }; sigMetrics = r.metrics; errEl.textContent = "";
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

// ---- saved signatures and handwriting styles (kept 60 days after last use) -----
// Stored in this browser only. Using a saved item renews its 60 days.
const KEEP_MS = 60 * 864e5;
const SIG_KEY = "cal2_sigs", STYLE_KEY = "cal2_styles", LAST_KEY = "cal2_last_style";
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v == null ? d : v; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function keepFresh(list) { const now = Date.now(); return list.filter((s) => now - (s.usedAt || s.savedAt || now) < KEEP_MS); }
const daysLeft = (s) => Math.max(1, Math.ceil((KEEP_MS - (Date.now() - (s.usedAt || s.savedAt || Date.now()))) / 864e5));
function loadSavedSigs() {
  const a = lsGet(SIG_KEY, []); const now = Date.now();
  a.forEach((s) => { if (!s.savedAt) s.savedAt = now; });
  const f = keepFresh(a); if (f.length !== a.length) storeSavedSigs(f);
  return f;
}
function storeSavedSigs(a) { lsSet(SIG_KEY, a.slice(0, 20)); }
function cleanSigSVG(svg) { return svg.replace(/\s*style="color:[^"]*"/, ""); }
function touchSig(id) { const l = loadSavedSigs(); const s = l.find((x) => x.id === id); if (s) { s.usedAt = Date.now(); storeSavedSigs(l); } }
function renderSavedSigs() {
  const host = $("sig_saved"); if (!host) return;
  const list = loadSavedSigs(); host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<div class="note" style="margin:0">None yet — signatures you place are saved here.</div>'; return; }
  list.forEach((s) => {
    const card = document.createElement("div");
    card.title = (s.name || "Signature") + ` — kept ${daysLeft(s)} more day${daysLeft(s) > 1 ? "s" : ""}. Click to use it.`;
    card.style.cssText = "position:relative;width:82px;height:50px;border:1px solid var(--line2);border-radius:6px;background:#fff;cursor:pointer;overflow:hidden;display:flex;align-items:center;justify-content:center";
    card.innerHTML = s.svg.replace("<svg ", '<svg style="width:92%;height:84%;color:#111" preserveAspectRatio="xMidYMid meet" ');
    card.onclick = () => {
      sigSVG = s.svg; sigBox = { w: s.w, h: s.h }; toggles.usesig = true; syncToggles();
      $("sig_controls").style.display = ""; touchSig(s.id);
      if (workMode === "doc" && doc) { if (edMode !== "sign") setEdMode("sign"); setEdTool("sig"); toast("Click the page to place this signature."); }
      else { render(); toast("Loaded " + (s.name || "signature") + "."); }
    };
    const del = document.createElement("div");
    del.textContent = "×"; del.title = "Delete";
    del.style.cssText = "position:absolute;top:-1px;right:1px;color:#c62f24;font-weight:700;cursor:pointer;background:rgba(255,255,255,.85);line-height:1.1;padding:0 4px;border-radius:0 0 0 6px";
    del.onclick = (e) => { e.stopPropagation(); storeSavedSigs(loadSavedSigs().filter((x) => x.id !== s.id)); renderSavedSigs(); };
    card.appendChild(del); host.appendChild(card);
  });
}
function addSavedSig(entry) {
  const list = loadSavedSigs();
  const dup = list.find((x) => x.svg === entry.svg || (entry.text && x.text === entry.text && x.seed === entry.seed && x.svg.length === entry.svg.length));
  if (dup) { dup.usedAt = Date.now(); storeSavedSigs(list); renderSavedSigs(); return false; }
  list.unshift({ id: Date.now() + "-" + Math.floor(Math.random() * 1e4), savedAt: Date.now(), usedAt: Date.now(), ...entry });
  storeSavedSigs(list); renderSavedSigs(); return true;
}
// Signatures you place on a document are remembered automatically.
function autoSaveSig(it) {
  if (!it || !it.svg || it.svg.includes("writing…")) return;
  const w = +(it.svg.match(/width="(\d+)"/) || [])[1] || 400, h = +(it.svg.match(/height="(\d+)"/) || [])[1] || 120;
  addSavedSig({ name: it.text || "Signature", svg: cleanSigSVG(it.svg), w, h, text: it.text || "", seed: it.seed });
}
function saveCurrentSig() {
  const it = selectedItem();
  if (it && it.type === "sig") { const w = +(it.svg.match(/width="(\d+)"/) || [])[1] || 400, h = +(it.svg.match(/height="(\d+)"/) || [])[1] || 120; addSavedSig({ name: it.text || "Signature", svg: cleanSigSVG(it.svg), w, h, text: it.text, seed: it.seed }); toast("Signature saved for 60 days."); return; }
  if (!rawSVG) { toast("Nothing to save yet — write something first."); return; }
  addSavedSig({ name: textForEngine().slice(0, 30) || "Signature", svg: cleanSigSVG(rawSVG), w: hwW, h: hwH, text: textForEngine(), seed: +$("seed").value });
  toast("Signature saved for 60 days.");
}

// ---- handwriting styles: every setting, saved by name -------------------------------
function styleState() { const s = JSON.parse(JSON.stringify(st())); delete s.t; if (s.tg) delete s.tg.usesig; return s; }
function loadSavedHands() {
  let list = lsGet(STYLE_KEY, null);
  if (!list) {   // bring over hands saved by older versions (seed only)
    list = lsGet("cal2_hands", []).map((h) => ({ id: h.id, name: h.name, state: { sd: h.seed }, savedAt: Date.now() }));
    lsSet(STYLE_KEY, list);
  }
  const f = keepFresh(list); if (f.length !== list.length) storeSavedHands(f);
  return f;
}
function storeSavedHands(a) { lsSet(STYLE_KEY, a.slice(0, 24)); }
function applySavedStyle(s) {
  const text = $("text").value;
  applyState({ ...s.state, t: text });
  buildSwatches(); syncToggles(); refreshLabels();
  activatePrime(s);
  const l = loadSavedHands(); const x = l.find((y) => y.id === s.id); if (x) { x.usedAt = Date.now(); storeSavedHands(l); }
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { it.seed = +$("seed").value; regenItem(it, undefined, true); } else render(true);
  toast("Style “" + s.name + "” applied.");
}
function renderSavedHands() {
  const host = $("saved_hands"); if (!host) return;
  const list = loadSavedHands(); host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<div class="note" style="margin:0">No saved styles yet — ★ Save style keeps every setting.</div>'; return; }
  list.forEach((s) => {
    const chip = document.createElement("span"); chip.className = "chip"; chip.title = `Kept ${daysLeft(s)} more day${daysLeft(s) > 1 ? "s" : ""} — click to apply`;
    chip.innerHTML = `<span>${s.prime ? "✍ " : ""}${escapeHTML(s.name)}</span><small>${daysLeft(s)}d</small><span class="x" title="Delete">×</span>`;
    chip.onclick = (e) => { if (e.target.classList.contains("x")) { e.stopPropagation(); storeSavedHands(loadSavedHands().filter((h) => h.id !== s.id)); renderSavedHands(); return; } applySavedStyle(s); };
    host.appendChild(chip);
  });
}
function saveHand() {
  const list = loadSavedHands();
  const name = prompt("Name this style:", "Style " + (list.length + 1)); if (!name) return;
  list.unshift({ id: Date.now() + "-" + Math.floor(Math.random() * 1e4), name, state: styleState(), savedAt: Date.now(), usedAt: Date.now() });
  storeSavedHands(list); renderSavedHands(); toast("Style saved — kept for 60 days after you last use it.");
}
// Your last settings come back next time (within 60 days), unless a share link says otherwise.
let lastStyleTimer = 0;
function rememberLastStyle() { clearTimeout(lastStyleTimer); lastStyleTimer = setTimeout(() => lsSet(LAST_KEY, { at: Date.now(), state: st(), primeId: activePrime ? activePrime.id : null }), 700); }
function restoreLastStyle() {
  const v = lsGet(LAST_KEY, null);
  if (!v || !v.state || Date.now() - v.at > KEEP_MS) return false;
  const s = JSON.parse(JSON.stringify(v.state)); if (s.tg) delete s.tg.usesig;
  applyState(s);
  if (v.primeId) { const st2 = loadSavedHands().find((h) => h.id === v.primeId && h.prime); if (st2) activatePrime(st2); }
  return true;
}

// ---- hands: new / last ---------------------------------------------------------------
// New hand: if a placed signature is selected, re-roll only that one; otherwise roll a
// new global seed (the old one goes to history for "Last hand").
function newHand() {
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { regenItem(it, Math.floor(Math.random() * 1e9)); return; }
  handHistory.push(+$("seed").value);
  $("seed").value = Math.floor(Math.random() * 1e9);
  if ($("hand")) $("hand").value = "r";
  render(true); rememberLastStyle();
}
function lastHand() {
  const prev = handHistory.pop();
  if (prev == null) { toast("No previous hand to go back to."); return; }
  $("seed").value = prev;
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { regenItem(it, prev); return; }
  render(true); rememberLastStyle();
}

// ---- draw pad: signatures and handwriting samples (mouse, finger or stylus) -------
const dp = { mode: "sig", strokes: [], cur: null, color: "#1b1b1f", size: 3, ctx: null, wired: false };
const DP_INKS = ["#1b1b1f", "#1d3a8a", "#0b2a6b", "#6d1a36"];
function openDrawPad(m) {
  const dlg = $("dpad"); if (!dlg) return;
  dpWire();
  dp.strokes = []; dp.cur = null; dpSetMode(m || "sig");
  $("dp_text").value = ""; $("dp_name").value = "";
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => { dpResize(); dpRedraw(); });
}
function dpSetMode(m) {
  dp.mode = m;
  $("dpad").classList.toggle("hand", m === "hand");
  $("dp_mode").querySelectorAll("button").forEach((b) => b.classList.toggle("sel", b.dataset.dp === m));
  $("dp_title").textContent = m === "hand" ? "Teach it your handwriting" : "Draw your signature";
  $("dp_hint").textContent = m === "hand"
    ? "Write a short sentence on the line the way you normally write (10–40 letters works best), then type exactly what you wrote. New text will be written in your style. Saved for 60 days."
    : "Sign with your mouse, finger or a stylus. It's saved for 60 days so you can use it again.";
  $("dp_ph").textContent = m === "hand" ? "Write a sentence here" : "Sign here";
  $("dp_place").textContent = m === "hand" ? "Save & write with it" : (workMode === "doc" && doc ? "Save & place" : "Save & use");
  $("dp_warn").textContent = "";
}
function dpResize() {
  const c = $("dp_canvas"), r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  c.width = Math.max(1, Math.round(r.width * dpr)); c.height = Math.max(1, Math.round(r.height * dpr));
  dp.ctx = c.getContext("2d"); dp.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
function dpPt(e) { const r = $("dp_canvas").getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pointerType === "pen" && e.pressure ? e.pressure : 0.5, t: e.timeStamp }; }
function dpRedraw() {
  const c = $("dp_canvas"), x = dp.ctx;
  const all = dp.cur ? [...dp.strokes, dp.cur] : dp.strokes;
  $("dp_ph").style.display = all.length ? "none" : "";
  if (!x) return;
  x.clearRect(0, 0, c.width, c.height);
  if (all.length) { x.fillStyle = dp.color; x.fill(new Path2D(inkPath(all, dp.size, dpFx()))); }
}
// Smooth, pressure/speed-sensitive ink: each stroke becomes a filled outline.
// fx: smoothness (averaging + corner rounding), exactness (how many of the original
// points are kept), realism (pressure/speed width changes, tapered ends, ink wobble).
const INK_NEUTRAL = { smooth: 30, exact: 100, real: 100 };
const dpFx = () => (dp.mode === "sig" ? sigFx : INK_NEUTRAL);
function inkPath(strokes, size, fx = INK_NEUTRAL) {
  const R = fx.real / 100, eps = Math.pow(1 - fx.exact / 100, 2) * 6, avg = Math.round(fx.smooth / 100 * 6), passes = Math.round(fx.smooth / 100 * 3);
  let d = "";
  strokes.forEach((s0, si) => {
    if (!s0.length) return;
    if (s0.length === 1) { const p = s0[0], r = size * 0.6; d += `M${(p.x + r).toFixed(2)},${p.y.toFixed(2)}a${r},${r} 0 1 0 ${-2 * r},0a${r},${r} 0 1 0 ${2 * r},0Z`; return; }
    let s = s0;
    if (avg) s = s0.map((p, i) => { if (i === 0 || i === s0.length - 1) return p; let x = 0, y = 0, c = 0; for (let k = -avg; k <= avg; k++) { const q = s0[Math.min(s0.length - 1, Math.max(0, i + k))]; x += q.x; y += q.y; c++; } return { ...p, x: x / c, y: y / c }; });
    if (eps > 0.05 && s.length > 2) { const kept = rdp(s.map((p, i) => [p.x, p.y, i]), eps); s = kept.map((q) => s[q[2]]); }
    for (let k = 0; k < passes; k++) {               // Chaikin smoothing, ends kept
      const o = [s[0]];
      for (let i = 0; i < s.length - 1; i++) { const a = s[i], b = s[i + 1]; o.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25, p: (a.p * 3 + b.p) / 4, t: a.t }, { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75, p: (a.p + b.p * 3) / 4, t: b.t }); }
      o.push(s[s.length - 1]); s = o;
    }
    const n = s.length, w = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(n - 1, i + 1)];
      const v = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, (b.t - a.t) || 8);
      const speed = Math.max(0.55, Math.min(1.2, 1.2 - v * 0.35));
      const edge = Math.min(1, Math.min(i, n - 1 - i) / Math.max(2, n * 0.08));
      const real = size * (0.55 + 0.9 * (s[i].p || 0.5)) * speed * (0.45 + 0.55 * edge);
      const flat = size * 0.95 * (0.8 + 0.2 * edge);
      w[i] = flat + (real - flat) * R;
    }
    for (let i = 1; i < n - 1; i++) w[i] = (w[i - 1] + w[i] * 2 + w[i + 1]) / 4;
    const amp = R * Math.min(0.7, size * 0.1), L = [], Rt = [];
    for (let i = 0; i < n; i++) {
      const a = s[Math.max(0, i - 1)], b = s[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x, dy = b.y - a.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const h = Math.max(0.35, w[i] / 2), hl = h + fxNoise(i * 0.35, si + 1) * amp, hr = h + fxNoise(i * 0.35 + 31, si + 2) * amp;
      L.push([s[i].x - dy * hl, s[i].y + dx * hl]); Rt.push([s[i].x + dy * hr, s[i].y - dx * hr]);
    }
    d += "M" + L.map((q) => q[0].toFixed(2) + "," + q[1].toFixed(2)).join("L");
    d += "L" + Rt.reverse().map((q) => q[0].toFixed(2) + "," + q[1].toFixed(2)).join("L") + "Z";
  });
  return d;
}
function dpSvg() {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const s of dp.strokes) for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = dp.size * 2 + 4, w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
  const moved = dp.strokes.map((s) => s.map((p) => ({ ...p, x: p.x - x0 + pad, y: p.y - y0 + pad })));
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="currentColor" stroke="none"><g><path d="${inkPath(moved, dp.size, dpFx())}"/></g></svg>`, w, h };
}
function dpSave(use) {
  const warn = $("dp_warn");
  if (!dp.strokes.length) { warn.textContent = dp.mode === "hand" ? "Write a sentence on the pad first." : "Sign on the pad first."; return; }
  if (dp.mode === "sig") {
    const g = dpSvg();
    addSavedSig({ name: "Drawn signature", svg: g.svg, w: g.w, h: g.h, drawn: true, color: dp.color });
    $("dpad").close();
    if (!use) { toast("Signature saved — find it under Saved signatures."); return; }
    sigSVG = g.svg; sigBox = { w: g.w, h: g.h }; toggles.usesig = true; syncToggles();
    if (workMode === "doc" && doc) {
      if (edMode !== "sign") setEdMode("sign");
      const it = addSigItem(undefined, undefined, "signature");
      if (it) { it.color = dp.color; render(); }
      toast("Signature placed — drag it into position.");
    } else { render(); toast("Signature ready. Open a document and use Sign to place it."); }
    return;
  }
  const text = $("dp_text").value.replace(/\s+/g, " ").trim();
  if (!text) { warn.textContent = "Type exactly what you wrote, so it can learn which marks are which letters."; $("dp_text").focus(); return; }
  if (dp.strokes.length < 3 || text.length < 3) { warn.textContent = "Write a little more — a short sentence works best."; return; }
  const bad = [...new Set([...text].filter((c) => !supportedChar(c)))];
  const prime = primeFromStrokes(dp.strokes, text);
  if (!prime) { warn.textContent = "Could not read that sample — try again."; return; }
  const name = $("dp_name").value.trim() || "My handwriting";
  const list = loadSavedHands();
  const entry = { id: Date.now() + "-" + Math.floor(Math.random() * 1e4), name, state: styleState(), prime, savedAt: Date.now(), usedAt: Date.now() };
  list.unshift(entry); storeSavedHands(list); renderSavedHands();
  $("dpad").close();
  if (use) { activatePrime(entry); const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); else render(true); }
  toast(`Saved “${name}” for 60 days.` + (bad.length ? ` (${bad.join(" ")} can't be learned and will be skipped.)` : "") + (use ? " New writing now uses your handwriting." : ""));
}
function dpWire() {
  if (dp.wired) return; dp.wired = true;
  const c = $("dp_canvas");
  c.addEventListener("pointerdown", (e) => { e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (_) {} dp.cur = [dpPt(e)]; $("dp_warn").textContent = ""; dpRedraw(); });
  c.addEventListener("pointermove", (e) => { if (!dp.cur) return; const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; for (const ev of (evs.length ? evs : [e])) dp.cur.push(dpPt(ev)); dpRedraw(); });
  const end = () => { if (dp.cur) { dp.strokes.push(dp.cur); dp.cur = null; dpRedraw(); } };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
  $("dp_mode").querySelectorAll("button").forEach((b) => b.onclick = () => dpSetMode(b.dataset.dp));
  $("dp_undo").onclick = () => { dp.strokes.pop(); dpRedraw(); };
  $("dp_clear").onclick = () => { dp.strokes = []; dpRedraw(); };
  $("dp_size").oninput = () => { dp.size = +$("dp_size").value; dpRedraw(); };
  fxSliders($("dp_fx"), ["smooth", "exact", "real"], () => dpRedraw());
  $("dp_fxreset").onclick = () => fxReset($("dp_fx"), dpRedraw);
  const inks = $("dp_ink"); inks.innerHTML = "";
  DP_INKS.forEach((col, i) => { const b = document.createElement("div"); b.className = "sw" + (i === 0 ? " sel" : ""); b.style.background = col; b.title = col; b.onclick = () => { dp.color = col; inks.querySelectorAll(".sw").forEach((x) => x.classList.toggle("sel", x === b)); dpRedraw(); }; inks.appendChild(b); });
  $("dp_x").onclick = $("dp_cancel").onclick = () => $("dpad").close();
  $("dp_save").onclick = () => dpSave(false);
  $("dp_place").onclick = () => dpSave(true);
  [$("dp_text"), $("dp_name")].forEach((i) => i.addEventListener("keydown", (e) => e.stopPropagation()));
  window.addEventListener("resize", () => { if ($("dpad").open) { dpResize(); dpRedraw(); } });
}
// Use (or stop using) a saved sample of your own handwriting for new writing.
function activatePrime(s) {
  activePrime = s && s.prime ? { id: s.id, name: s.name, text: s.prime.text, offsets: s.prime.offsets } : null;
  // writing in your own hand: show the writing, not a stored signature picture
  if (activePrime && toggles.usesig) { toggles.usesig = false; syncToggles(); }
  const chip = $("prime_chip");
  if (chip) { chip.classList.toggle("on", !!activePrime); $("prime_name").textContent = activePrime ? "✍ Writing in your handwriting: " + activePrime.name : ""; }
  rememberLastStyle();
}

// ---- remove watermark ---------------------------------------------------------------
let wmColor = null, wmCandidates = [];
const wmMask = new Map();          // page index -> [{ pts:[[x,y]...], r }]  (normalised to the page)
function openWmPanel() {
  if (!doc) return;
  if (edMode !== "edit") setEdMode("edit");
  closePanelTool(); document.body.classList.add("wmpanel"); openSide(true);
  $("wm_found").innerHTML = ""; $("wm_apply").hidden = true; $("wm_err").textContent = "";
  const hasPdf = docPages.some((p) => docSources[p.src] && docSources[p.src].kind === "pdf");
  $("wm_scan").disabled = !hasPdf;
  $("wm_scan").textContent = hasPdf ? "Scan this document" : "Pictures: use colour or brush below";
  $("panel").scrollTop = 0;
}
function closeWmPanel() { document.body.classList.remove("wmpanel"); if (edTool === "wm-pick" || edTool === "wm-brush") setEdTool("select"); }
async function rotatedTextLabels(src) {
  const counts = new Map();
  try {
    for (let i = 1; i <= Math.min(src.pdf.numPages, 6); i++) {
      const tc = await (await src.pdf.getPage(i)).getTextContent();
      for (const it of tc.items) { const t = it.transform, s = (it.str || "").trim(); if (s && Math.abs(t[1]) > 0.05 * Math.hypot(t[0], t[1])) counts.set(s, (counts.get(s) || 0) + 1); }
    }
  } catch (_) {}
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 3);
}
async function wmScan() {
  const host = $("wm_found"); host.innerHTML = '<div class="note">Scanning…</div>'; $("wm_apply").hidden = true;
  const res = [];
  const used = [...new Set(docPages.map((p) => p.src))].filter((si) => docSources[si] && docSources[si].kind === "pdf");
  try {
    for (const si of used) {
      const src = docSources[si];
      const found = await scanPdfWatermarks(src.bytes, { rotatedLabels: await rotatedTextLabels(src) });
      found.forEach((f) => res.push({ ...f, si }));
    }
  } catch (e) { host.innerHTML = ""; $("wm_err").textContent = "Scan failed: " + (e.message || e); return; }
  wmCandidates = res;
  host.innerHTML = res.length ? "" : '<div class="note">Nothing was found automatically. If the watermark is part of a scan or picture, use Erase by colour or the brush below.</div>';
  res.forEach((c, i) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" data-i="${i}" ${c.checked ? "checked" : ""}><span>${escapeHTML(c.label)}<small>${escapeHTML(c.detail)}</small></span>`;
    host.appendChild(l);
  });
  $("wm_apply").hidden = !res.length;
}
async function wmApply() {
  const picked = [...$("wm_found").querySelectorAll("input:checked")].map((i) => wmCandidates[+i.dataset.i]);
  if (!picked.length) { toast("Tick what to remove first."); return; }
  snapshotNow(); toast("Removing…");
  const bySrc = new Map(); picked.forEach((c) => { if (!bySrc.has(c.si)) bySrc.set(c.si, []); bySrc.get(c.si).push(c.id); });
  const sources = docSources.slice(); let total = 0;
  try {
    for (const [si, ids] of bySrc) {
      const r = await removePdfWatermarks(sources[si].bytes, ids);
      total += r.removed;
      const pdf = await window.pdfjsLib.getDocument({ data: r.bytes.slice(), fontExtraProperties: true }).promise;
      sources[si] = { ...sources[si], bytes: r.bytes, pdf };
    }
  } catch (e) { $("wm_err").textContent = "Could not remove it: " + (e.message || e); return; }
  docSources = sources;
  const changed = new Set(bySrc.keys());
  docPages = docPages.map((p) => changed.has(p.src) ? { ...p, img: null, url: BLANK_PAGE, _loading: null, fields: [], key: nextKey() } : p);
  textBlocks.clear(); for (const k of [...pdfFonts.keys()]) if (changed.has(+k.split(":")[0])) pdfFonts.delete(k);
  pagesSig = ""; await ensurePageImage(curPage); doc = docPages[curPage]; render(); renderPagesInBackground(loadToken);
  $("wm_found").innerHTML = `<div class="note" style="color:var(--ok)">Removed ${total} watermark item${total === 1 ? "" : "s"}. Ctrl+Z puts it back.</div>`; $("wm_apply").hidden = true;
  toast("Watermark removed.");
}
// Replace a page by a cleaned picture of itself (same size, objects stay where they are).
async function replacePageWithCanvas(pi, c) {
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const url = URL.createObjectURL(blob), img = await loadImgEl(url);
  const old = docPages[pi];
  const si = docSources.push({ bytes: new Uint8Array(await blob.arrayBuffer()), name: docName, kind: "image", img, url }) - 1;
  docPages = docPages.slice();
  docPages[pi] = { src: si, idx: 0, rot: 0, img, w: c.width, h: c.height, url, fields: old.fields || [], key: nextKey() };
}
async function pageCanvas(pi) {
  const p = await ensurePageImage(pi);
  const c = document.createElement("canvas"); c.width = p.w; c.height = p.h;
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(p.img, 0, 0, c.width, c.height);
  return c;
}
function pickWmColor(e, ov, pi, dispW, dispH) {
  e.preventDefault();
  const r = ov.getBoundingClientRect(), p = docPages[pi];
  pageCanvas(pi).then((c) => {
    const x = Math.round((e.clientX - r.left) / dispW * c.width), y = Math.round((e.clientY - r.top) / dispH * c.height);
    const d = c.getContext("2d").getImageData(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5).data;
    let rr = 0, gg = 0, bb = 0, n = 0; for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; n++; }
    wmColor = [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)];
    $("wm_swatch").style.background = `rgb(${wmColor.join(",")})`;
    setEdTool("select"); toast("Colour picked — press Erase this colour.");
  });
}
async function wmEraseColor() {
  if (!wmColor) { toast("Pick the watermark colour first — then click it on the page."); return; }
  const tol = +$("wm_tol").value, targets = $("wm_pages").value === "all" ? docPages.map((_, i) => i) : [curPage];
  snapshotNow(); toast("Erasing…"); let n = 0;
  for (const pi of targets) {
    const c = await pageCanvas(pi), x = c.getContext("2d"), im = x.getImageData(0, 0, c.width, c.height);
    n += eraseColor(im, pageBackground(im), wmColor, tol);
    x.putImageData(im, 0, 0); await replacePageWithCanvas(pi, c);
  }
  pagesSig = ""; doc = docPages[curPage]; render();
  toast(n ? `Erased that colour on ${targets.length} page${targets.length > 1 ? "s" : ""}. Ctrl+Z undoes.` : "Nothing matched — pick the colour again or raise the tolerance.");
}
function startWmBrush(e, ov, pi, dispW, dispH) {
  e.preventDefault(); try { ov.setPointerCapture(e.pointerId); } catch (_) {}
  const r = ov.getBoundingClientRect(), rad = (+$("wm_bsize").value / 2) / dispW;
  const st = { pts: [[(e.clientX - r.left) / dispW, (e.clientY - r.top) / dispH]], r: rad };
  if (!wmMask.has(pi)) wmMask.set(pi, []);
  wmMask.get(pi).push(st);
  const layer = ov.querySelector("svg.wmmask") || renderWmMask(ov, pi, dispW, dispH, true);
  const draw = () => { layer.innerHTML = maskMarkup(pi, dispW, dispH); };
  draw();
  const mv = (ev) => { st.pts.push([(ev.clientX - r.left) / dispW, (ev.clientY - r.top) / dispH]); draw(); };
  const up = () => { ov.removeEventListener("pointermove", mv); ov.removeEventListener("pointerup", up); };
  ov.addEventListener("pointermove", mv); ov.addEventListener("pointerup", up);
}
function maskMarkup(pi, W, H) {
  return (wmMask.get(pi) || []).map((s) => `<path d="M${s.pts.map((q) => (q[0] * W).toFixed(1) + "," + (q[1] * H).toFixed(1)).join("L")}" fill="none" stroke="#ff3355" stroke-opacity=".45" stroke-width="${(s.r * W * 2).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`).join("");
}
function renderWmMask(ov, pi, dispW, dispH, force) {
  if (!force && !(wmMask.get(pi) || []).length) return null;
  const svg = document.createElementNS(SVGNS, "svg"); svg.classList.add("wmmask");
  svg.setAttribute("width", dispW); svg.setAttribute("height", dispH); svg.setAttribute("viewBox", `0 0 ${dispW} ${dispH}`);
  svg.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;overflow:visible";
  svg.innerHTML = maskMarkup(pi, dispW, dispH); ov.appendChild(svg); return svg;
}
async function wmFillBrushed() {
  const pagesWithMask = [...wmMask.entries()].filter(([, v]) => v.length).map(([k]) => k);
  if (!pagesWithMask.length) { toast("Pick 🖌 Brush and paint over the watermark first."); return; }
  snapshotNow(); toast("Filling in…");
  for (const pi of pagesWithMask) {
    const c = await pageCanvas(pi), W = c.width, H = c.height;
    const m = document.createElement("canvas"); m.width = W; m.height = H;
    const mx = m.getContext("2d"); mx.strokeStyle = "#fff"; mx.lineCap = "round"; mx.lineJoin = "round";
    for (const s of wmMask.get(pi)) { mx.lineWidth = s.r * W * 2; mx.beginPath(); s.pts.forEach((q, i) => (i ? mx.lineTo(q[0] * W, q[1] * H) : mx.moveTo(q[0] * W, q[1] * H))); if (s.pts.length === 1) mx.lineTo(s.pts[0][0] * W + 0.1, s.pts[0][1] * H); mx.stroke(); }
    const md = mx.getImageData(0, 0, W, H).data, mask = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) mask[i] = md[i * 4 + 3] > 20 ? 1 : 0;
    const x = c.getContext("2d"), im = x.getImageData(0, 0, W, H);
    inpaint(im, mask, 2); x.putImageData(im, 0, 0);
    await replacePageWithCanvas(pi, c);
  }
  wmMask.clear(); setEdTool("select");
  pagesSig = ""; doc = docPages[curPage]; render(); toast("Filled in. Ctrl+Z undoes.");
}

// ---- fonts found in PDFs: scan a document and keep its fonts --------------------
// Embedded fonts are saved with their glyphs (only the characters that PDF used) and a
// look-alike library font for everything else; fonts a PDF only names are saved as
// that name, drawn with the closest library font. Kept 60 days after last use.
const UF_DAYS = 60;
function ufDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("cal2fonts", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("fonts")) r.result.createObjectStore("fonts", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function ufDo(mode, fn) {
  try { const db = await ufDB(); return await new Promise((res) => { const t = db.transaction("fonts", mode); const st = t.objectStore("fonts"); let out; const r = fn(st); if (r) r.onsuccess = () => { out = r.result; }; t.oncomplete = () => res(out); t.onerror = () => res(null); }); }
  catch (_) { return null; }
}
const ufAll = () => ufDo("readonly", (st) => st.getAll()).then((v) => v || []);
const ufGet = (id) => ufDo("readonly", (st) => st.get(id));
const ufPut = (rec) => ufDo("readwrite", (st) => st.put(rec));
const ufDel = (id) => ufDo("readwrite", (st) => st.delete(id));
async function ufTouch(id) { const r = await ufGet(id); if (r) { r.usedAt = Date.now(); ufPut(r); } }

function glyphMapOf(fo) {
  const map = {}; let count = 0;
  const tfc = (fo && fo.toFontChar) || [], tu = (fo && fo.toUnicode) || {};
  const add = (code, uni) => { const fc = tfc[code]; if (uni && fc != null && [...uni].length === 1 && !map[uni]) { map[uni] = String.fromCodePoint(fc); count++; } };
  if (tu._map) { for (const code in tu._map) add(+code, tu._map[code]); }
  else if (tu.firstChar != null) { for (let c = tu.firstChar; c <= tu.lastChar; c++) add(c, String.fromCharCode(c)); }
  return { map, count };
}
function prettyFontName(raw) {
  return String(raw).replace(/^[A-Z]{6}\+/, "").replace(/(PSMT|PS|MT)(?=$|[-,])/g, "").replace(/[-,_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+/g, " ").trim() || String(raw);
}
// a saved font never takes the name of a built-in one ("Georgia" -> "Georgia (PDF)")
const saveNameOf = (n) => { const e = fontEntry(n); return e && !e.user ? n + " (PDF)" : n; };
const ufId = (name) => "pf_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
async function registerSavedFont(rec) {
  let family = null;
  if (rec.data) {
    family = "cal2u_" + rec.id;
    try { const ff = new FontFace(family, rec.data, { weight: "100 900", style: rec.style === "italic" ? "italic" : "normal" }); await ff.load(); document.fonts.add(ff); }
    catch (_) { family = null; }
  }
  const inv = {}; if (family) for (const k in rec.map) inv[rec.map[k]] = k;
  ensureFontsIn(rec.fallbackCss);
  const e = addUserFont({ id: rec.id, name: rec.name, family, map: family ? rec.map : {}, inv, glyphs: family ? rec.glyphs : 0, fallbackCss: rec.fallbackCss, as: rec.as });
  e.weight = rec.weight || 400; e.fstyle = rec.style || "normal";
  return e;
}
async function loadSavedFonts() {
  const now = Date.now();
  for (const r of await ufAll()) {
    if (now - (r.usedAt || r.savedAt || 0) > UF_DAYS * 864e5) { ufDel(r.id); continue; }
    try { await registerSavedFont(r); } catch (_) {}
  }
}
// The text of a user font, written in its glyphs (characters it lacks fall back).
const userFontInfo = (fe) => (fe && fe.user && fe.family ? { loadedName: fe.family, map: fe.map, inv: fe.inv } : null);
function glyphInfo(it) {
  const info = pfontInfo(it);
  if (info && !it.ffOverride) return info.loadedName ? info : null;
  return userFontInfo(fontByKey(it.ff));
}

async function scanDocFonts(onProgress) {
  const found = new Map(), OPS = window.pdfjsLib.OPS;
  const pdfs = docSources.filter((s) => s && s.kind === "pdf" && s.pdf);
  const total = pdfs.reduce((n, s) => n + s.pdf.numPages, 0); let done = 0;
  for (const src of pdfs) {
    for (let i = 1; i <= src.pdf.numPages; i++) {
      const page = await src.pdf.getPage(i);
      const ol = await page.getOperatorList();
      const ids = new Set();
      ol.fnArray.forEach((fn, k) => { if (fn === OPS.setFont) ids.add(ol.argsArray[k][0]); });
      for (const id of ids) {
        let fo = null; try { if (page.commonObjs.has(id)) fo = page.commonObjs.get(id); } catch (_) {}
        if (!fo || fo.isType3Font || !fo.name) continue;
        const name = prettyFontName(fo.name), g = glyphMapOf(fo);
        const embedded = !!(fo.data && !fo.missingFile && g.count);
        const prev = found.get(name);
        if (prev) { prev.pages++; if (embedded && g.count > prev.glyphs) Object.assign(prev, { data: fo.data, map: g.map, glyphs: g.count, embedded, loaded: fo.loadedName }); continue; }
        found.set(name, { name, data: embedded ? fo.data : null, map: g.map, glyphs: embedded ? g.count : 0, embedded, loaded: fo.loadedName,
          match: matchPdfFont(fo.name, { serif: !!fo.isSerifFont, mono: !!fo.isMonospace }), pages: 1 });
      }
      done++; if (onProgress) onProgress(done, total);
    }
  }
  return [...found.values()].sort((a, b) => (b.embedded - a.embedded) || a.name.localeCompare(b.name));
}

let fsFound = [];
function fsRow(f, saved) {
  const row = mk("label", { className: "fs-row" });
  const cb = mk("input", { type: "checkbox" }); cb.checked = !saved; cb.dataset.n = f.name;
  const info = f.embedded && f.loaded ? { loadedName: f.loaded, map: f.map } : null;
  const sample = "The quick brown fox jumps over the lazy dog 0123456789";
  const prev = mk("div", { className: "fs-prev" }); prev.textContent = info ? toFontStr(info, sample) : sample;
  prev.style.fontFamily = (info ? `"${f.loaded}", ` : "") + f.match.css; prev.style.fontWeight = f.match.weight; prev.style.fontStyle = f.match.style;
  const meta = f.embedded ? `Embedded · ${f.glyphs} characters · missing ones use ${f.match.family}` : `Not embedded · drawn with ${f.match.family}`;
  const body = mk("div", { className: "fs-b" });
  body.innerHTML = `<div class="fs-n">${escapeHTML(f.name)}${saved ? ' <span class="fs-tag">Saved</span>' : ""}</div><div class="fs-m">${escapeHTML(meta)} · ${f.pages} page${f.pages > 1 ? "s" : ""}</div>`;
  body.appendChild(prev);
  row.append(cb, body);
  return row;
}
async function renderSavedFontList() {
  const box = $("fs_saved"); box.innerHTML = "";
  const all = (await ufAll()).sort((a, b) => a.name.localeCompare(b.name));
  $("fs_saved_h").hidden = !all.length;
  for (const r of all) {
    const fe = fontEntry(r.name), row = mk("div", { className: "fs-srow" });
    const nm = mk("span", { className: "fs-sn" });
    const ui = userFontInfo(fe); nm.textContent = ui ? toFontStr(ui, r.name) : r.name; if (fe) nm.style.fontFamily = fe.css;
    const meta = mk("span", { className: "fs-m" }, r.glyphs ? r.glyphs + " characters" : "as " + r.as);
    const del = mk("button", { className: "btn", title: "Remove this font" }, "Remove");
    del.onclick = async () => { await ufDel(r.id); removeUserFont(r.name); renderSavedFontList(); fsRenderFound(); };
    row.append(nm, meta, del); box.appendChild(row);
  }
}
async function fsRenderFound() {
  const list = $("fs_list"); list.innerHTML = "";
  const saved = new Set((await ufAll()).map((r) => r.name));
  for (const f of fsFound) list.appendChild(fsRow(f, saved.has(saveNameOf(f.name))));
  $("fs_save").disabled = !fsFound.length;
}
async function openFontScan() {
  const dlg = $("fscan"); if (!dlg.open) dlg.showModal();
  fsFound = []; $("fs_list").innerHTML = ""; renderSavedFontList();
  const hasPdf = docSources.some((s) => s && s.kind === "pdf" && s.pdf);
  if (!hasPdf) { $("fs_status").textContent = "Open a PDF to find its fonts. Fonts you already saved are below."; $("fs_save").disabled = true; return; }
  $("fs_status").textContent = "Looking for fonts…";
  try {
    fsFound = await scanDocFonts((d, t) => { $("fs_status").textContent = `Looking for fonts… page ${d} of ${t}`; });
    const emb = fsFound.filter((f) => f.embedded).length;
    $("fs_status").textContent = fsFound.length ? `Found ${fsFound.length} font${fsFound.length > 1 ? "s" : ""} (${emb} embedded). Saved fonts appear under “Your PDFs” in every font menu.` : "This PDF has no text fonts (it may be a scan).";
    await fsRenderFound();
  } catch (err) { $("fs_status").textContent = "Couldn't read the fonts: " + (err && err.message || err); }
}
async function saveScannedFonts() {
  const pick = new Set([...$("fs_list").querySelectorAll("input:checked")].map((c) => c.dataset.n));
  const now = Date.now(); let n = 0;
  for (const f of fsFound) {
    if (!pick.has(f.name)) continue;
    const nm = saveNameOf(f.name), id = ufId(nm), old = await ufGet(id);
    if (old && old.glyphs > f.glyphs) { old.usedAt = now; await ufPut(old); n++; continue; }
    const rec = { id, name: nm, data: f.embedded ? new Uint8Array(f.data) : null, map: f.embedded ? f.map : {}, glyphs: f.embedded ? f.glyphs : 0,
      fallbackCss: f.match.css, as: f.match.family, weight: f.match.weight, style: f.match.style, savedAt: now, usedAt: now };
    await ufPut(rec); await registerSavedFont(rec); n++;
  }
  toast(n ? `Saved ${n} font${n > 1 ? "s" : ""} — find them under “Your PDFs” in the font menu.` : "Tick the fonts you want to keep.");
  propsSig = ""; if (typeof renderProps === "function") renderProps();
  renderSavedFontList(); fsRenderFound();
}

// ---- signature fine-tuning: sliders for drawn and imported signatures -----------
// threshold: how dark a mark must be to count as ink (pictures/PDFs)
// smoothness: how much the strokes are rounded off; exactness: how closely the
// result follows the original ("the pull"); realism: natural pen pressure, ink
// shading and edge texture; thickness: thinner/bolder strokes (pictures/PDFs).
const SIGFX_DEF = { thresh: 150, smooth: 45, exact: 70, real: 55, weight: 50 };
const sigFx = { ...SIGFX_DEF, ...lsGet("cal2_sigfx", {}) };
const FX_INFO = {
  thresh: ["Threshold", "How dark a mark must be to count as ink. Raise it for faint pen, lower it to drop shadows and lines.", 20, 240],
  smooth: ["Smoothness", "Rounds off shaky or jagged strokes.", 0, 100],
  exact: ["Exactness", "How closely it follows the original — high keeps every detail, low gives simpler, flowing curves.", 0, 100],
  real: ["Realism", "Natural pen pressure, ink shading and slightly rough edges. 0 is a clean, even line.", 0, 100],
  weight: ["Thickness", "Makes the strokes thinner or bolder.", 0, 100],
};
function fxSliders(host, keys, onChange) {
  host.innerHTML = "";
  for (const k of keys) {
    const [name, tip, min, max] = FX_INFO[k];
    const lab = mk("label", { title: tip });
    const head = mk("span", { className: "fxh" }, `<span>${name}</span><b></b>`);
    const r = mk("input", { type: "range", min, max, value: sigFx[k] });
    r.dataset.k = k;
    const show = () => { head.querySelector("b").textContent = k === "thresh" ? r.value : r.value + "%"; };
    r.oninput = () => { sigFx[k] = +r.value; show(); lsSet("cal2_sigfx", sigFx); onChange(k); };
    show(); lab.append(head, r); host.appendChild(lab);
  }
}
function fxReset(host, onChange) { Object.assign(sigFx, SIGFX_DEF); lsSet("cal2_sigfx", sigFx); host.querySelectorAll("input[type=range]").forEach((r) => { r.value = sigFx[r.dataset.k]; r.dispatchEvent(new Event("input")); }); onChange(); }
// smooth deterministic noise (same signature -> same texture every time)
const fxNoise = (i, seed) => (Math.sin(i * 0.71 + seed * 12.9898) + Math.sin(i * 0.23 + seed * 4.1414) * 0.6 + Math.sin(i * 1.93 + seed * 7.77) * 0.25) / 1.85;

// ---- traced signature from a picture or a PDF page ---------------------------------
function traceSig(source, fx) {
  const maxD = 880;
  let w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  const sc = Math.min(1, maxD / Math.max(w, h)); w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(source, 0, 0, w, h);
  const d = cx.getImageData(0, 0, w, h).data;
  const lum = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) lum[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
  // adaptive (Bradley) threshold via an integral image — robust to shadows / uneven paper
  const integ = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += lum[y * w + x]; integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rs; } }
  const rad = Math.max(6, Math.round(Math.min(w, h) * 0.08));
  const boxMean = (I, x, y, r) => {
    const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(w - 1, x + r), y1 = Math.min(h - 1, y + r);
    return (I[(y1 + 1) * (w + 1) + (x1 + 1)] - I[y0 * (w + 1) + (x1 + 1)] - I[(y1 + 1) * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
  };
  const margin = (1 - fx.thresh / 255) * 44 + 4, cut = 120 + fx.thresh * 0.55;
  const local = new Float32Array(w * h);
  let mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; local[i] = boxMean(integ, x, y, rad); if (lum[i] < cut && local[i] - lum[i] > margin) mask[i] = 1; }
  mask = despeckle(mask, w, h);
  // thickness: grow or shrink the ink by whole pixels
  const morph = (m, grow) => {
    const o = m.slice();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!!m[i] === grow) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; if (!!m[yy * w + xx] === grow) { o[i] = grow ? 1 : 0; dy = dx = 2; } }
    }
    return o;
  };
  const k = Math.round((fx.weight - 50) / 22);
  for (let n = 0; n < Math.abs(k); n++) mask = morph(mask, k > 0);
  // smoothness: blur the ink shape and re-cut it at half — rounds jagged edges
  const sr = Math.round(fx.smooth / 100 * 3);
  if (sr) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let rs = 0; for (let x = 0; x < w; x++) { rs += mask[y * w + x]; I[(y + 1) * (w + 1) + (x + 1)] = I[y * (w + 1) + (x + 1)] + rs; } }
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = boxMean(I, x, y, sr) >= 0.5 ? 1 : 0;
    mask = o;
  }
  let area = 0, sumX = 0, sumY = 0, sumXY = 0, sumYY = 0, minx = w, miny = h, maxx = 0, maxy = 0, inkMin = 255;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) { area++; sumX += x; sumY += y; sumXY += x * y; sumYY += y * y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; if (lum[y * w + x] < inkMin) inkMin = lum[y * w + x]; }
  if (area < 24) return { err: "No clear ink found — raise the threshold, or drag a box around the signature.", mask, w, h };
  const minArea = Math.max(8, w * h * 0.00004);
  const passes = 1 + Math.round(fx.smooth / 100 * 2), eps = 0.25 + (1 - fx.exact / 100) * 2.6;
  const R = fx.real / 100, rough = R * 0.55;
  let loops = marchingSquares(mask, w, h).map((L, li) => {
    if (L.length > 1 && L[0][0] === L[L.length - 1][0] && L[0][1] === L[L.length - 1][1]) L = L.slice(0, -1);
    for (let n = 0; n < passes; n++) L = chaikin(L);
    L = simplifyLoop(L, eps);
    if (rough > 0.02) L = L.map((p, i) => [p[0] + fxNoise(i, li + 1) * rough, p[1] + fxNoise(i + 50, li + 3) * rough]);
    return L;
  }).filter((L) => L.length > 3 && polyArea(L) > minArea);
  if (!loops.length) return { err: "Could not trace clean strokes — try a different threshold or a sharper picture.", mask, w, h };
  const n = area, meanX = sumX / n, meanY = sumY / n;
  const a = (sumXY - n * meanX * meanY) / ((sumYY - n * meanY * meanY) || 1);
  const slant = Math.max(-10, Math.min(30, Math.round(-a * 42)));
  let perim = 0;
  for (const L of loops) for (let i = 1; i < L.length; i++) perim += Math.hypot(L[i][0] - L[i - 1][0], L[i][1] - L[i - 1][1]);
  const strokeW = perim > 0 ? (2 * area) / perim : 4, bh = (maxy - miny) || 1;
  const thickness = Math.max(10, Math.min(90, Math.round((strokeW / bh) * 620)));
  const vbw = maxx - minx + 2, vbh = maxy - miny + 2;
  let body = "";
  for (const L of loops) {
    let s = "M" + (L[0][0] - minx + 1).toFixed(1) + " " + (L[0][1] - miny + 1).toFixed(1);
    for (let i = 1; i < L.length; i++) s += "L" + (L[i][0] - minx + 1).toFixed(1) + " " + (L[i][1] - miny + 1).toFixed(1);
    body += '<path d="' + s + 'Z"/>';
  }
  // realism: keep the pen's own shading (darker where it pressed) plus a little paper grain
  let defs = "", maskAttr = "";
  if (R > 0.03) {
    const bw = maxx - minx + 1, bhh = maxy - miny + 1;
    const mc = document.createElement("canvas"); mc.width = bw; mc.height = bhh;
    const mx = mc.getContext("2d"), md = mx.createImageData(bw, bhh);
    for (let y = 0; y < bhh; y++) for (let x = 0; x < bw; x++) {
      const i = (y + miny) * w + (x + minx), paper = local[i];
      const shade = Math.max(0.2, Math.min(1, (paper - lum[i]) / Math.max(20, paper - inkMin)));
      const rnd = (((Math.sin(x * 12.99 + y * 78.23) * 43758.5453) % 1) + 1) % 1, grain = 1 - 0.14 * R * rnd;
      const v = Math.round(255 * Math.max(0.12, (1 - R + R * Math.pow(shade, 0.7)) * grain));
      const p = (y * bw + x) * 4; md.data[p] = md.data[p + 1] = md.data[p + 2] = v; md.data[p + 3] = 255;
    }
    mx.putImageData(md, 0, 0);
    const id = "ink" + Math.random().toString(36).slice(2, 9), href = mc.toDataURL("image/jpeg", 0.82);
    defs = `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${vbw}" height="${vbh}"><image x="1" y="1" width="${bw}" height="${bhh}" href="${href}" xlink:href="${href}" preserveAspectRatio="none"/></mask></defs>`;
    maskAttr = ` mask="url(#${id})"`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${vbw}" height="${vbh}" viewBox="0 0 ${vbw} ${vbh}" fill="currentColor" stroke="none">${defs}<g fill-rule="evenodd"${maskAttr}>${body}</g></svg>`;
  return { svg, w: vbw, h: vbh, metrics: { slant, thickness }, mask, mw: w, mh: h };
}

// ---- the import window: pick the area, fine-tune, save -----------------------------
const sx = { src: null, pdf: null, page: 1, pages: 1, crop: null, color: DP_INKS[0], result: null, view: null, drag: null, timer: 0, wired: false };
async function openSigStudio(file) {
  const dlg = $("sigx"); sxWire();
  $("sx_warn").textContent = "";
  if (!dlg.open) dlg.showModal();
  if (file) {
    sx.src = null; sx.pdf = null; sx.crop = null; sx.result = null;
    $("sx_out").innerHTML = '<span class="sx-wait">Reading…</span>';
    const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || "");
    dlg.classList.toggle("pdf", isPdf);
    try {
      if (isPdf) {
        sx.pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        sx.pages = sx.pdf.numPages; await sxPage(1);
      } else {
        const url = URL.createObjectURL(file), img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("Could not read that picture.")); img.src = url; });
        const s = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        sx.src = c;
      }
    } catch (err) { $("sx_warn").textContent = (err && err.message) || "Could not open that file."; return; }
  }
  $("sx_hint").textContent = sx.pdf ? "Drag a box around the signature on the page. Red shows the ink that will be kept." : "Drag a box around the signature to leave out anything else. Red shows the ink that will be kept.";
  requestAnimationFrame(() => { sxDraw(); sxProcess(); });
}
async function sxPage(n) {
  sx.page = Math.max(1, Math.min(sx.pages, n)); sx.crop = null;
  const page = await sx.pdf.getPage(sx.page), v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, 2200 / Math.max(v1.width, v1.height)) });
  const c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  sx.src = c; $("sx_pgn").textContent = `Page ${sx.page} of ${sx.pages}`;
}
function sxCropCanvas() {
  const s = sx.src, r = sx.crop || { x: 0, y: 0, w: s.width, h: s.height };
  const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(r.w)); c.height = Math.max(1, Math.round(r.h));
  c.getContext("2d").drawImage(s, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c;
}
function sxDraw() {
  const cv = $("sx_src"), rr = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(rr.width * dpr)); cv.height = Math.max(1, Math.round(rr.height * dpr));
  const x = cv.getContext("2d"); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, rr.width, rr.height);
  if (!sx.src) return;
  const s = Math.min(rr.width / sx.src.width, rr.height / sx.src.height), ox = (rr.width - sx.src.width * s) / 2, oy = (rr.height - sx.src.height * s) / 2;
  sx.view = { s, ox, oy };
  x.drawImage(sx.src, ox, oy, sx.src.width * s, sx.src.height * s);
  const c = sx.crop || { x: 0, y: 0, w: sx.src.width, h: sx.src.height };
  const cx0 = ox + c.x * s, cy0 = oy + c.y * s, cw = c.w * s, ch = c.h * s;
  if (sx.crop) {
    x.fillStyle = "rgba(15,18,28,.45)";
    x.fillRect(ox, oy, sx.src.width * s, cy0 - oy); x.fillRect(ox, cy0 + ch, sx.src.width * s, oy + sx.src.height * s - cy0 - ch);
    x.fillRect(ox, cy0, cx0 - ox, ch); x.fillRect(cx0 + cw, cy0, ox + sx.src.width * s - cx0 - cw, ch);
  }
  const r = sx.result;
  if (r && r.mask) {
    const o = document.createElement("canvas"); o.width = r.mw || r.w; o.height = r.mh || r.h;
    const od = o.getContext("2d").createImageData(o.width, o.height);
    for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) { od.data[i * 4] = 235; od.data[i * 4 + 1] = 40; od.data[i * 4 + 2] = 40; od.data[i * 4 + 3] = 170; }
    o.getContext("2d").putImageData(od, 0, 0);
    x.drawImage(o, cx0, cy0, cw, ch);
  }
  if (sx.crop) { x.strokeStyle = "#398dff"; x.lineWidth = 2; x.setLineDash([6, 4]); x.strokeRect(cx0, cy0, cw, ch); x.setLineDash([]); }
}
function sxProcess() {
  clearTimeout(sx.timer);
  sx.timer = setTimeout(() => {
    if (!sx.src) return;
    const r = traceSig(sxCropCanvas(), sigFx);
    sx.result = r;
    const out = $("sx_out");
    if (r.err) { out.innerHTML = `<span class="sx-wait">${escapeHTML(r.err)}</span>`; }
    else out.innerHTML = r.svg.replace(/ width="[\d.]+" height="[\d.]+"/, ' width="100%" height="100%"').replace("<svg ", `<svg style="color:${sx.color}" `);
    sxDraw();
  }, 60);
}
function sxSave(use) {
  const r = sx.result;
  if (!r || r.err) { $("sx_warn").textContent = (r && r.err) || "Choose a picture or PDF first."; return; }
  sigImg = sxCropCanvas(); sigMetrics = r.metrics;
  $("sig_threshold").value = sigFx.thresh; refreshLabels();
  sigSVG = r.svg; sigBox = { w: r.w, h: r.h };
  $("sig_controls").style.display = "";
  addSavedSig({ name: "Imported signature", svg: r.svg, w: r.w, h: r.h, color: sx.color });
  $("sigx").close();
  if (!use) { toast("Signature saved — find it under Saved signatures."); return; }
  toggles.usesig = true; syncToggles();
  if (workMode === "doc" && doc) {
    if (edMode !== "sign") setEdMode("sign");
    const it = addSigItem(undefined, undefined, "signature");
    if (it) { it.color = sx.color; render(); }
    toast("Signature placed — drag it into position.");
  } else { render(); toast("Signature ready to use."); }
}
function sxWire() {
  if (sx.wired) return; sx.wired = true;
  fxSliders($("sx_fx"), ["thresh", "smooth", "exact", "real", "weight"], sxProcess);
  const cv = $("sx_src");
  const toSrc = (e) => { const r = cv.getBoundingClientRect(), v = sx.view; return { x: Math.max(0, Math.min(sx.src.width, (e.clientX - r.left - v.ox) / v.s)), y: Math.max(0, Math.min(sx.src.height, (e.clientY - r.top - v.oy) / v.s)) }; };
  cv.addEventListener("pointerdown", (e) => { if (!sx.src || !sx.view) return; e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch (_) {} sx.drag = toSrc(e); });
  cv.addEventListener("pointermove", (e) => {
    if (!sx.drag) return; const p = toSrc(e);
    const c = { x: Math.min(p.x, sx.drag.x), y: Math.min(p.y, sx.drag.y), w: Math.abs(p.x - sx.drag.x), h: Math.abs(p.y - sx.drag.y) };
    if (c.w > 6 && c.h > 6) { sx.crop = c; sx.result = null; sxDraw(); }
  });
  const end = () => { if (sx.drag) { sx.drag = null; sxProcess(); } };
  cv.addEventListener("pointerup", end); cv.addEventListener("pointercancel", end);
  $("sx_reset").onclick = () => { sx.crop = null; sxProcess(); };
  $("sx_prev").onclick = async () => { if (sx.pdf && sx.page > 1) { await sxPage(sx.page - 1); sxProcess(); } };
  $("sx_next").onclick = async () => { if (sx.pdf && sx.page < sx.pages) { await sxPage(sx.page + 1); sxProcess(); } };
  $("sx_defaults").onclick = () => fxReset($("sx_fx"), sxProcess);
  $("sx_file").onclick = () => $("sig_file").click();
  const inks = $("sx_ink"); inks.innerHTML = "";
  DP_INKS.forEach((col, i) => { const b = document.createElement("div"); b.className = "sw" + (i === 0 ? " sel" : ""); b.style.background = col; b.title = col; b.onclick = () => { sx.color = col; inks.querySelectorAll(".sw").forEach((q) => q.classList.toggle("sel", q === b)); sxProcess(); }; inks.appendChild(b); });
  $("sx_x").onclick = $("sx_cancel").onclick = () => $("sigx").close();
  $("sx_save").onclick = () => sxSave(false);
  $("sx_place").onclick = () => sxSave(true);
  window.addEventListener("resize", () => { if ($("sigx").open) sxDraw(); });
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
// Workspace: "write" (handwriting sheet), "doc" (the open document) or "pdf" (stand-alone PDF tools).
function setWorkMode(m) {
  if (m === "doc" && !doc) m = "write";
  workMode = m;
  document.body.dataset.work = m;
  document.body.classList.toggle("pdfmode", m === "pdf");
  if (m !== "doc") { document.body.classList.remove("placing", "toolpanel"); }
  if (m === "pdf") { if (window.__cal2RefreshPeRecents) window.__cal2RefreshPeRecents(); }
  else refreshRecentLists();
  requestAnimationFrame(() => render(false));
}
const setAppMode = (which) => setWorkMode(which === "pdf" ? "pdf" : (doc ? "doc" : "write"));
function typingInField(e) { const t = e.target; return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }

(async function () {
  loadSavedFonts().then(() => { propsSig = ""; if (workMode === "doc") render(); });
  buildSwatches();
  try { await loadWasm(); } catch (e) { /* procedural engine optional; neural is primary */ }
  $("tier").querySelectorAll("button").forEach((b) => { b.onclick = () => applyTier(b.dataset.tier); });
  applyTier("simple");
  const shared = loadHash();
  const restored = !shared && restoreLastStyle();
  buildSwatches();
  if (!shared && !restored && $("hand").value !== "r") $("seed").value = $("hand").value;
  ["speed", "legibility", "thickness", "font_px", "slant", "contrast", "spacing", "line_spacing", "tex_intensity",
   "blur", "sharpen", "resolution", "blemish", "scan_rotate", "scan_rotvar", "scan_bright", "scan_contrast", "scan_noise", "scan_yellow"]
    .forEach((id) => { const el = $(id); if (el) el.addEventListener("input", () => { renderD(); rememberLastStyle(); }); });
  if ($("cspace")) $("cspace").addEventListener("change", renderD);
  document.querySelectorAll(".sw-toggle, #ink, #paper, #textures, #mode, #align").forEach((el) => el.addEventListener("click", rememberLastStyle));
  // While a placed signature is selected, the handwriting controls redraw it live.
  const HW_KEYS = ["legibility", "thickness", "slant", "contrast", "spacing", "line_spacing", "font_px"];
  const regenSelDeb = debounce(() => { const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); }, 130);
  HW_KEYS.forEach((id) => { const el = $(id); if (el) el.addEventListener("input", regenSelDeb); });
  // Typing in the text box updates the selected signature / handwriting live; with a
  // document open and none selected, it updates (or places) one on the current page.
  $("text").addEventListener("input", debounce(() => {
    rememberLastStyle();
    const it = selectedItem();
    if (it && it.type === "sig" && it.dynamic) { it.text = sigText(it.wmode); regenItem(it, undefined, true); return; }
    if (workMode === "doc" && doc && $("text").value.trim() && edMode !== "organize") {
      const s = [...docItems].reverse().find((d) => d.type === "sig" && d.dynamic && (d.page || 0) === curPage);
      if (s) { selId = s.id; s.text = sigText(s.wmode); regenItem(s, undefined, true); }
      else if (edMode === "sign" && edTool !== "sig" && edTool !== "handwrite") addSigItem(undefined, undefined, "signature");
      return;
    }
    render(true);
  }, 160));
  $("seed").addEventListener("input", () => { renderD(); regenSelDeb(); rememberLastStyle(); });
  $("style").addEventListener("change", () => { applyStyle($("style").value); rememberLastStyle(); const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); });
  $("hand").addEventListener("change", () => {
    const v = $("hand").value;
    handHistory.push(+$("seed").value);
    $("seed").value = v === "r" ? Math.floor(Math.random() * 1e9) : v;
    rememberLastStyle();
    const it = selectedItem();
    if (it && it.type === "sig" && it.dynamic) regenItem(it, +$("seed").value); else render(true);
  });
  $("paper_style").addEventListener("change", () => render());
  $("reroll").addEventListener("click", newHand);
  $("last_hand").addEventListener("click", lastHand);
  $("save_hand").addEventListener("click", saveHand);
  renderSavedHands();
  // draw pad, your handwriting, watermark removal
  $("sig_draw").onclick = () => openDrawPad("sig");
  $("hand_draw").onclick = () => openDrawPad("hand");
  $("prime_off").onclick = () => { activatePrime(null); const it = selectedItem(); if (it && it.type === "sig" && it.dynamic) regenItem(it, undefined, true); else render(true); };
  $("wm_back").onclick = closeWmPanel;
  $("fs_x").onclick = $("fs_close").onclick = () => $("fscan").close();
  $("fs_save").onclick = saveScannedFonts;
  $("fs_all").onclick = () => { const cbs = [...$("fs_list").querySelectorAll("input")]; const on = cbs.some((c) => !c.checked); cbs.forEach((c) => { c.checked = on; }); };
  $("wm_scan").onclick = wmScan; $("wm_apply").onclick = wmApply;
  $("wm_pick").onclick = () => { setEdTool("wm-pick"); toast("Click the watermark on the page."); };
  $("wm_tol").oninput = () => { $("wm_tol_v").textContent = $("wm_tol").value; };
  $("wm_color_go").onclick = wmEraseColor;
  $("wm_brush").onclick = () => setEdTool("wm-brush");
  $("wm_brush_go").onclick = wmFillBrushed;
  $("wm_brush_clear").onclick = () => { wmMask.clear(); render(); };
  if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener("loadingdone", () => { if (workMode === "doc") requestAnimationFrame(fitTextBoxes); });

  // ---- document: open / close ----
  $("upload_btn").onclick = () => $("file").click();
  $("file").onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ""; if (!f) return;
    try { await openDocFile(f); if (!location.hash.startsWith("#/edit")) location.hash = "#/edit"; }
    catch (err) { errEl.textContent = "Could not open that file: " + (err.message || err); }
  };
  const close = () => { closeDoc(); location.hash = "#/"; };
  $("clear_doc").onclick = close;
  $("ed_close").onclick = close;

  // ---- mode tabs, tools, dropdowns ----
  document.querySelectorAll("#ed_tabs .tab").forEach((t) => t.onclick = () => setEdMode(t.dataset.edmode));
  document.querySelectorAll("#ed_tools [data-tool]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); setEdTool(b.dataset.tool); }));
  document.querySelectorAll("#view_work [data-ddbtn]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const dd = b.closest(".dd"), open = !dd.classList.contains("open");
    closeDropdowns(); if (open) dd.classList.add("open");
  }));
  document.addEventListener("click", (e) => { if (!e.target.closest(".dd")) closeDropdowns(); if (!e.target.closest(".cpop,.cbtn,.fpop,.fbtn")) closePops(); });
  document.querySelectorAll("#modebar [data-dl]").forEach((b) => b.addEventListener("click", () => {
    closeDropdowns(); const k = b.dataset.dl;
    if (k === "pdf") exportPDF(); else if (k === "fill") exportFillablePDF(); else exportPNG();
  }));
  document.querySelectorAll("#ed_tools [data-org]").forEach((b) => b.onclick = () => {
    const sel = [...orgSel].sort((a, c) => a - c), a = b.dataset.org;
    if (a === "selall") { if (orgSel.size === docPages.length) orgSel.clear(); else docPages.forEach((_, i) => orgSel.add(i)); renderOrganize(); }
    else if (a === "rotl") rotatePages(sel, -1);
    else if (a === "rotr") rotatePages(sel, 1);
    else if (a === "dup") duplicatePages(sel);
    else if (a === "del") deletePages(sel);
    else if (a === "add") pickFilesForDoc();
    else if (a === "blank") addBlankPage();
  });
  $("ed_undo").onclick = undo; $("ed_redo").onclick = redo;
  $("ed_zin").onclick = () => zoomStep(1); $("ed_zout").onclick = () => zoomStep(-1); $("ed_zval").onclick = () => setZoom(1);
  $("ed_view_single").onclick = () => setView(true); $("ed_view_all").onclick = () => setView(false);
  $("pg_prev").onclick = () => setCurPage(curPage - 1, true); $("pg_next").onclick = () => setCurPage(curPage + 1, true);
  $("ed_side_btn").onclick = () => openSide(!document.body.classList.contains("side-open"));

  // ---- rail: Add PDF (click or drop) + recent files ----
  const railAdd = $("rail_add"), rail = $("ed_rail");
  railAdd.onclick = pickFilesForDoc;
  rail.addEventListener("dragover", (e) => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); railAdd.classList.add("over"); } });
  rail.addEventListener("dragleave", (e) => { if (!rail.contains(e.relatedTarget)) railAdd.classList.remove("over"); });
  rail.addEventListener("drop", (e) => { e.preventDefault(); railAdd.classList.remove("over"); const f = [...(e.dataTransfer.files || [])]; if (f.length) addFilesToDoc(f); });

  // ---- keyboard ----
  document.addEventListener("keydown", (e) => {
    if (workMode !== "doc" || !doc || document.body.dataset.route !== "work") return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z") && !typingInField(e)) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && (e.key === "y" || e.key === "Y") && !typingInField(e)) { e.preventDefault(); redo(); return; }
    if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); zoomStep(1); return; }
    if (mod && e.key === "-") { e.preventDefault(); zoomStep(-1); return; }
    if (mod && e.key === "0") { e.preventDefault(); setZoom(1); return; }
    if (typingInField(e)) return;
    if (edMode === "organize") {
      if ((e.key === "Delete" || e.key === "Backspace") && orgSel.size) { e.preventDefault(); deletePages([...orgSel]); }
      if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); docPages.forEach((_, i) => orgSel.add(i)); renderOrganize(); }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") { if (deleteSelection()) e.preventDefault(); return; }
    if (e.key === "Escape") { closeDropdowns(); closePops(); if (edTool !== "select") setEdTool("select"); else if (selId || selDraw) { selId = null; selDraw = null; render(); } return; }
    if (mod && (e.key === "d" || e.key === "D")) { e.preventDefault(); duplicateSelection(); return; }
    if (e.key === "PageDown" || (viewSingle && e.key === "ArrowRight" && !selId)) { e.preventDefault(); setCurPage(curPage + 1, true); return; }
    if (e.key === "PageUp" || (viewSingle && e.key === "ArrowLeft" && !selId)) { e.preventDefault(); setCurPage(curPage - 1, true); return; }
    const it = selectedItem();
    if (it && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const step = (e.shiftKey ? 10 : 1) / pageDispW(it.page || 0), asp = pageAspect(it.page || 0);
      if (e.key === "ArrowLeft") it.nx -= step; if (e.key === "ArrowRight") it.nx += step;
      if (e.key === "ArrowUp") it.ny -= step * asp; if (e.key === "ArrowDown") it.ny += step * asp;
      render();
    }
  });
  const stageEl = $("stage"), panelEl = $("panel");
  stageEl.addEventListener("wheel", (e) => {
    if (workMode === "doc" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); zoomStep(e.deltaY < 0 ? 1 : -1); return; }
    if (workMode !== "write") return;
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
  // a signature drawn in the document builder (mtgcalc) is ready to place
  try {
    const want = localStorage.getItem("cal2_use_sig");
    if (want) {
      localStorage.removeItem("cal2_use_sig");
      const s = loadSavedSigs().find((x) => x.id === want);
      if (s) { sigSVG = s.svg; sigBox = { w: s.w, h: s.h }; toggles.usesig = true; syncToggles(); $("sig_controls").style.display = ""; touchSig(s.id); let n = 0; const t = setInterval(() => { if (workMode === "doc" && doc) { clearInterval(t); setEdTool("sig"); toast("Your signature is ready — click the page to place it."); } else if (++n > 60) clearInterval(t); }, 250); }
    }
  } catch (_) {}
  buildSigners();
  refreshRecentLists();
  let lastW = 0;
  window.addEventListener("resize", () => { const w = $("stage").clientWidth; if (w !== lastW) { lastW = w; renderD(); } });

  // ---- hooks used by the page shell (shell.js) and the PDF tools (pdfedit.js) ----
  window.__cal2SetWork = setWorkMode;
  window.__cal2HasDoc = () => !!doc;
  window.__cal2OpenDocFile = (f) => openDocFile(f);
  window.__cal2OpenDocBytes = (u8, name, kind) => openDocBytes(u8, name, kind);
  window.__cal2AddFilesToDoc = (files) => addFilesToDoc(files);
  window.__cal2CloseDoc = closeDoc;
  window.__cal2ApplyTool = (id) => applyTool(id);
  window.__cal2SetEdMode = (m) => { if (doc) setEdMode(m); };
  window.__cal2SetDocTool = (t) => { if (doc) setEdTool(t); };
  window.__cal2Toast = toast;
  window.__cal2ApplyTier = applyTier;
  window.__cal2Rerender = () => render(false);
  window.__cal2PickSignatureImage = () => { applyTier("advanced"); $("sig_file").click(); };
  window.__cal2InsertImageFile = insertImageFile;
  window.__cal2OpenDrawPad = (m) => openDrawPad(m);
  window.__cal2PdfSaveHook = applyPdfResult;
  window.__cal2PdfPanelClosed = () => { closePanelTool(); render(); };
  window.__cal2RefreshRecents = refreshRecentLists;
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
