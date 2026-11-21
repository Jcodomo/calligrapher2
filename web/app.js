// Calligrapher 2.0 front-end. Rust/WASM engine + document signing + scan finish.
// WASM C ABI: alloc / dealloc / generate / result_ptr + linear `memory`.

import { initPdfEditor } from "./pdfedit.js?v=47";
import { saveRecent, saveRecentWork, listRecents, getRecent, delRecent, makeRecentCard, listMemory, saveMemory, forgetMemory } from "./recents.js?v=3";
import { primeFromStrokes, supportedChar } from "./neural.js?v=2";
import { FONT_LIB, FONT_CATS, fontEntry, ensureFont, ensureFontsIn, matchPdfFont, addUserFont, removeUserFont } from "./fonts.js?v=3";
import { scanPdfWatermarks, removePdfWatermarks, eraseColor, inpaint, pageBackground } from "./watermark.js?v=2";
import { pdfjsReady, pdfLibReady, warmPdfLibs, prefetchOn, canvasBytes } from "./libs.js?v=2";
import { scanWorkersSupported, scanOffThread, scanConcurrency, warmRealistic, bilevelPng, overlayPng } from "./scanpool.js?v=5";

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
    seed: seedVal(),
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
// ---- download options: format, look (clean by default) and quality ----------------------------
const DL_KEY = "cal2_dl_opts";
const dlOpts = Object.assign({ format: "pdf", look: "clean", quality: "exact", engine: "fast", meta: {}, more: {} },(() => { try { const v = JSON.parse(localStorage.getItem(DL_KEY) || "{}") || {}; if (!v.v2) delete v.quality; return v; } catch (_) { return {}; } })(), { v2: 1 });
const LOOKS = {
  clean:     { on: false, blur: 0, sharp: 0 },
  light:     { on: true, cspace: "color", border: false, rotate: 0.2, rotvar: 0.35, bright: 1.02, contrast: 1.05, noise: 5, yellow: 0.02, blem: 0.08, blur: 0.25, sharp: 0 },
  scanned:   { on: true, cspace: "color", border: false, rotate: 0.6, rotvar: 0.9, bright: 1.03, contrast: 1.12, noise: 12, yellow: 0.07, blem: 0.22, blur: 0.45, sharp: 0 },
  photocopy: { on: true, cspace: "bw", border: false, rotate: 0.4, rotvar: 0.8, bright: 1.04, contrast: 1.1, noise: 16, yellow: 0, blem: 0.3, blur: 0.35, sharp: 0 },
  // true 1-bit black & white, like an office scanner's "B&W document" mode: crisp and the smallest PDF
  // the pages as they are, in shades of grey (no tilt, grain or blur)
  gray:      { on: true, cspace: "gray", border: false, rotate: 0, rotvar: 0, bright: 1, contrast: 1, noise: 0, yellow: 0, blem: 0, blur: 0, sharp: 0 },
  photo:     { on: true, cspace: "color", border: false, rotate: 0, rotvar: 0.4, bright: 1.03, contrast: 1.05, noise: 6, yellow: 0.04, blem: 0, blur: 0.35, sharp: 0.1, photo: "photo", perspective: 0.35, shadow: 0.55, light: 0.5, wrinkles: 0.05 },
  counter:   { on: true, cspace: "color", border: false, rotate: 0, rotvar: 1.5, bright: 1.02, contrast: 1.06, noise: 6, yellow: 0.05, blem: 0, blur: 0.35, sharp: 0.1, photo: "counter", perspective: 0.45, shadow: 0.7, light: 0.55, wrinkles: 0.15, folds: 0 },
  bwscan:    { on: true, cspace: "bilevel", border: false, rotate: 0.3, rotvar: 0.6, bright: 1.06, contrast: 1.15, noise: 6, yellow: 0, blem: 0.1, blur: 0.3, sharp: 0.2 },
};
// scale: pixels per page unit (a page unit is half a point, so 2 = 288 dpi); overlay: the same for your edits laid on top
const QUALITY = { exact: { scale: 2.1, overlay: 2.5, q: 0.95, keepPages: true }, best: { scale: 2.1, overlay: 2.5, q: 0.95, keepPages: true },
  balanced: { scale: 1.4, overlay: 2, q: 0.85, keepPages: true }, small: { scale: 1, overlay: 1.5, q: 0.6, keepPages: false } };
let exportLook = null;          // set while a download is being built ("custom" = the side panel's scan settings)
const dlQuality = () => QUALITY[dlOpts.quality] || QUALITY.exact;
// "More options" in the download panel
const DL_MORE = { pages: "all", range: "", skipBlank: false, paper: "orig", turn: "0", num: "none", wm: "none", wmtext: "", dpi: "300", name: "" };
const dlMore = () => Object.assign({}, DL_MORE, dlOpts.more || {});
// pixels per page unit for picture downloads (a page unit is half a point: 300 dpi = 2.083)
const picScale = () => Math.max(0.5, (+dlMore().dpi || 300) / 144);
// the file name to save as: the name typed in More options, or the usual one
function outName(def, ext) {
  const n = String(dlMore().name || "").trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").replace(/\.(pdf|docx|txt|zip|png|jpe?g)$/i, "").trim();
  return (n || def) + "." + ext;
}
// "1-3, 5, 8-" -> [0,1,2,4,7,8,...] (0-based, in page order, no repeats)
function parsePageRange(txt, N) {
  const out = new Set();
  for (const part of String(txt || "").split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/), one = part.match(/^\d+$/);
    let a, b;
    if (one) a = b = +part; else if (m && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : N; } else continue;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(N, b); i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}
// a page with nothing on it: no edits, and its picture is (almost) all white
async function isBlankPage(i) {
  if (pageHasContent(i)) return false;
  try {
    await ensurePageImage(i); const p = docPages[i]; if (!p || !p.img) return false;
    const W = 120, H = Math.max(1, Math.round(W * p.h / p.w)), c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.drawImage(p.img, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data; let dark = 0;
    for (let k = 0; k < d.length; k += 4) if (d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11 < 200) dark++;
    return dark / (W * H) < 0.002;
  } catch (_) { return false; }
}
// the pages this download takes (0-based), from More options; [] = none match
async function exportPageList() {
  const mo = dlMore(), N = docPages.length;
  let idx = [...Array(N).keys()];
  if (mo.pages === "cur") idx = [Math.max(0, Math.min(curPage, N - 1))];
  else if (mo.pages === "odd") idx = idx.filter((i) => i % 2 === 0);
  else if (mo.pages === "even") idx = idx.filter((i) => i % 2 === 1);
  else if (mo.pages === "custom") idx = parsePageRange(mo.range, N);
  if (mo.skipBlank && idx.length > 1) {
    const keep = [];
    for (const i of idx) if (!(await isBlankPage(i))) keep.push(i);
    if (keep.length) idx = keep;
  }
  if (!idx.length) toast("None of the pages you chose exist — check Pages under More options.");
  if (dlCapture && idx.length) { dlCapture.total = idx.length; idx = [idx[0]]; }   // a preview builds only the first page it would save
  return idx;
}
const PAPER = { letter: [612, 792], legal: [612, 1008], a4: [595.28, 841.89], a5: [419.53, 595.28], tabloid: [792, 1224] };
// Applied to a finished PDF: keep only the chosen pages, fit them on a paper size, add page numbers and a
// watermark, and turn them. sel: the 0-based pages to keep (null = all).
async function finishPdf(pdf, L, sel, opts = {}) {
  const mo = dlMore();
  let leftovers = false;   // pdf-lib keeps removed or replaced pages' contents in the file until it is copied afresh
  if (sel && sel.length < pdf.getPageCount()) {
    leftovers = true;
    const keep = new Set(sel), pages = pdf.getPages(), drop = new Set(pages.filter((_, i) => !keep.has(i)).map((pg) => pg.ref));
    if (pdf.catalog.get(L.PDFName.of("AcroForm"))) {   // fields that live only on pages left out go too
      const form = pdf.getForm();
      for (const f of form.getFields()) { try { const ws = f.acroField.getWidgets(); if (ws.length && ws.every((w) => { const r = w.P(); return r && drop.has(r); })) form.removeField(f); } catch (_) {} }
    }
    for (let i = pages.length - 1; i >= 0; i--) if (!keep.has(i)) pdf.removePage(i);
  }
  const rotOf = (pg) => (((pg.getRotation().angle || 0) % 360) + 360) % 360;
  if (!opts.keepPaper && PAPER[mo.paper]) {
    for (let i = 0; i < pdf.getPageCount(); i++) {
      const page = pdf.getPage(i), r = rotOf(page);
      let hasInk = false; try { hasInk = !!page.node.Contents(); } catch (_) {}
      const emb = hasInk ? await pdf.embedPage(page) : null;   // (pdf-lib embeds when saving, so an empty page must be caught here)
      if (!emb) {   // an empty page (nothing drawn on it) can't be placed: it just gets the new paper size
        const { width: bw, height: bh } = page.getSize(); let [PW, PH] = PAPER[mo.paper]; if ((r % 180 ? bh : bw) > (r % 180 ? bw : bh)) [PW, PH] = [PH, PW];
        pdf.insertPage(i, [PW, PH]); pdf.removePage(i + 1); leftovers = true; continue;
      }
      const w0 = emb.width, h0 = emb.height;
      const vw = r % 180 ? h0 : w0, vh = r % 180 ? w0 : h0;
      let [PW, PH] = PAPER[mo.paper]; if (vw > vh) [PW, PH] = [PH, PW];   // a landscape page goes on landscape paper
      if (!r && Math.abs(PW - vw) < 1 && Math.abs(PH - vh) < 1) continue;
      const k = Math.min(PW / vw, PH / vh), ox = (PW - vw * k) / 2, oy = (PH - vh * k) / 2;
      const at = r === 90 ? { x: 0, y: w0, a: -90 } : r === 180 ? { x: w0, y: h0, a: 180 } : r === 270 ? { x: h0, y: 0, a: 90 } : { x: 0, y: 0, a: 0 };
      const np = pdf.insertPage(i, [PW, PH]);
      np.drawPage(emb, { x: ox + at.x * k, y: oy + at.y * k, width: w0 * k, height: h0 * k, rotate: L.degrees(at.a) });
      pdf.removePage(i + 1); leftovers = true;
    }
  }
  if (leftovers && !opts.keepPaper) {   // a flat PDF: copy the pages into a new file so what was left out really is gone
    const out = await L.PDFDocument.create();
    (await out.copyPages(pdf, pdf.getPageIndices())).forEach((pg) => out.addPage(pg));
    pdf = out;
  }
  const ansi = (t) => String(t || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x20-\x7e\xa0-\xff]/g, "").trim();
  const wm = ansi(mo.wm === "custom" ? mo.wmtext : mo.wm === "none" ? "" : mo.wm), num = mo.num && mo.num !== "none" ? mo.num : "";
  if (wm || num) {
    const font = await pdf.embedFont(L.StandardFonts.Helvetica), bold = wm ? await pdf.embedFont(L.StandardFonts.HelveticaBold) : null, N = dlCapture && dlCapture.total ? dlCapture.total : pdf.getPageCount();
    pdf.getPages().forEach((page, i) => {
      // positions are worked out as the page is seen (after any turn it already has) and mapped back
      const r = rotOf(page), mb = page.getMediaBox(), W = mb.width, H = mb.height, VW = r % 180 ? H : W, VH = r % 180 ? W : H;
      const put = (t, f, size, vx, vy, ang, color, opacity) => {
        const [x, y] = r === 90 ? [W - vy, vx] : r === 180 ? [W - vx, H - vy] : r === 270 ? [vy, H - vx] : [vx, vy];
        page.drawText(t, { x: mb.x + x, y: mb.y + y, size, font: f, color, opacity, rotate: L.degrees(r + ang) });
      };
      if (wm) {
        const a = Math.atan2(VH, VW), tw1 = bold.widthOfTextAtSize(wm, 1);
        const size = Math.min(Math.hypot(VW, VH) * 0.7 / tw1, Math.min(VW, VH) * 0.3), tw = tw1 * size, ch = size * 0.36;
        put(wm, bold, size, VW / 2 - Math.cos(a) * tw / 2 + Math.sin(a) * ch, VH / 2 - Math.sin(a) * tw / 2 - Math.cos(a) * ch, a * 180 / Math.PI, L.rgb(0.55, 0.55, 0.58), 0.2);
      }
      if (num) {
        const t = num === "bc" ? String(i + 1) : `Page ${i + 1} of ${N}`, size = Math.max(7, Math.min(11, VW * 0.0155)), tw = font.widthOfTextAtSize(t, size), m = Math.max(11, VH * 0.016);   // close to the edge, below most documents' own footers
        const vx = num === "bc" ? (VW - tw) / 2 : VW - Math.max(24, VW * 0.04) - tw, vy = num === "tr" ? VH - m - size * 0.75 : m;
        put(t, font, size, vx, vy, 0, L.rgb(0.25, 0.25, 0.28), 1);
      }
    });
  }
  const turn = +mo.turn || 0;
  if (turn) pdf.getPages().forEach((pg) => pg.setRotation(L.degrees((rotOf(pg) + turn) % 360)));
  return pdf;
}
// the document's PDF bytes cut down to the chosen pages (for Word and text downloads)
async function selectedDocumentBytes(idx) {
  const bytes = await buildDocumentBytes();
  if (!idx || idx.length === docPages.length) return bytes;
  const L = await pdfLibReady(), pdf = await L.PDFDocument.load(bytes, { ignoreEncryption: true });
  const keep = new Set(idx); for (let i = pdf.getPageCount() - 1; i >= 0; i--) if (!keep.has(i)) pdf.removePage(i);
  return pdf.save();
}
// the Scan look section of the download panel: its own full set of settings (dlOpts.scan)
const SCAN_DEFAULTS = { on: true, cspace: "color", border: false, rotate: 0, rotvar: 0.6, bright: 1.03, contrast: 1.12, noise: 12, yellow: 0.07, blem: 0.22, blur: 0.45, sharp: 0,
  straighten: false, wrinkles: 0, folds: 0, photo: "none", perspective: 0, shadow: 0, light: 0, severity: 50, seed: 1 };
const panelScan = () => Object.assign({}, SCAN_DEFAULTS, dlOpts.scan || {});
function scanParams() {
  if (exportLook === "panel") { const p = panelScan(); return { ...p, on: p.on !== false }; }
  if (exportLook && LOOKS[exportLook]) return { cspace: "color", border: false, rotate: 0, rotvar: 0, bright: 1, contrast: 1, noise: 0, yellow: 0, blem: 0, blur: 0, sharp: 0, ...LOOKS[exportLook] };
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
    else if (sp.cspace === "bilevel") parts.push("grayscale(1) contrast(6) brightness(1.05)");   // close to the 1-bit result
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
    if (workMode === "doc" && doc) { const r = renderDoc(); if (formColOn) setTimeout(renderFormCol, 0); return r; }
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
const DRAW_TOOLS = new Set(["pen", "highlight", "line", "arrow", "underline", "strike", "blur"]);
const FREEHAND = (k) => k === "pen" || k === "highlight" || k === "blur";
const UNDER = (k) => k === "highlight" || k === "blur";   // drawn under the objects on the page
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
  note: { color: "#ffd54f" }, whiteout: { color: "#ffffff" }, blur: { color: "#7a8597", width: 24, strength: 8 },
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
      // page pictures on screen first: full-size renders wait while thumbnails are being drawn
      for (let w = 0; w < 100 && !thumbsIdle(); w++) await new Promise((r) => setTimeout(r, 40));
      if (edMode === "organize" && i !== curPage) await new Promise((r) => (window.requestIdleCallback || setTimeout)(r, { timeout: 300 }));
      if (token !== loadToken) return;
      if (!docPages[i] || docPages[i].img) continue;
      if (!docPages[i].img) { try { await ensurePageImage(i); if (docPages[i] && docPages[i].fields.length) render(); } catch (_) {} }
    }
  })();
}
// A late-rendered page swaps its picture in place (no rebuild, so editing isn't interrupted).
function updatePageImage(i) {
  const p = docPages[i]; if (!p) return;
  document.querySelectorAll(`#ed_pages .pg[data-page="${i}"] > img`).forEach((im) => { im.src = p.url; });
}
// Add a PDF or picture as pages of the open document (at the end by default).
async function addSource(u8, name, kind, at) {
  const src = { bytes: u8.slice(), name: name || "document", kind };
  if (kind === "pdf") {
    src.pdf = await (await pdfjsReady()).getDocument({ data: u8.slice(), fontExtraProperties: true }).promise;
  } else { src.url = URL.createObjectURL(new Blob([u8])); src.img = await loadImgEl(src.url); }
  const si = docSources.push(src) - 1, pages = [];
  if (kind === "pdf") {
    // every page's size, asked for all at once (one at a time was a round trip to the PDF worker each)
    const vps = await Promise.all(Array.from({ length: src.pdf.numPages }, (_, i) => src.pdf.getPage(i + 1).then((pg) => pg.getViewport({ scale: 2 }))));
    vps.forEach((vp, i) => pages.push({ src: si, idx: i, rot: 0, img: null, w: Math.round(vp.width), h: Math.round(vp.height), url: BLANK_PAGE, fields: [], key: nextKey() }));
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
  const other = files.filter((f) => !isPdfFile(f) && !(window.__cal2IsNativeFile ? window.__cal2IsNativeFile(f) : isImgFile(f)));
  if (other.length && window.__cal2ImportAny) { files = files.filter((f) => !other.includes(f)); window.__cal2ImportAny(other, { open: (fs) => addFilesToDoc(fs, at) }); if (!files.length) return; }
  if (!doc) { if (files[0]) { await openDocFile(files[0]); if (files.length > 1) await addFilesToDoc(files.slice(1)); } return; }
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
  const u8 = (await canvasBytes(c, "image/png"));
  const at = (orgSel.size ? Math.max(...orgSel) : curPage) + 1;
  await addSource(u8, "Blank page", "image", at);
  pagesSig = ""; render(); toast("Added a blank page.");
}
function dataURLtoU8(u) { const b = atob(u.split(",")[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
// ---- Organize: duplicates found automatically, and sort by printed page number (OCR for scans) ----------
// Same checks as the PDF tools page (pdfedit.js), run on the editor's pages through small adapters.
const org = { marks: new Map(), scanning: "", sorting: "", scanned: false, tok: 0, sig: "" };
function pageAdapter(p) {
  return {
    key: "ed|" + p.key + "|" + p.rot, wPt: p.w / 2,
    render: async (scale) => {
      // a small picture straight from the PDF: the duplicate check needs ~32 px, not the full-size page
      if (!p.img) { try { const c = await pageCanvasAt(p, Math.max(8, Math.round(p.w / 2 * scale))); if (c) return c; } catch (_) {} }
      const i = docPages.indexOf(p); if (i >= 0) await ensurePageImage(i);
      const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(p.w / 2 * scale)); c.height = Math.max(1, Math.round(p.h / 2 * scale));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); if (p.img) g.drawImage(p.img, 0, 0, c.width, c.height);
      return c;
    },
    items: async () => { const i = docPages.indexOf(p); if (i < 0) return []; const b = await getTextBlocks(i).catch(() => []); return (b || []).map((x) => ({ str: x.str, x: x.nx, y: x.ny + x.nh })); },
  };
}
function liveOrgDups() { const set = new Set(docPages), out = new Map(); org.marks.forEach((o, p) => { if (set.has(p) && set.has(o)) out.set(p, o); }); return out; }
async function scanOrgDuplicates() {
  const T = window.__cal2PageTools; if (!T || !doc) return;
  const sig = docPages.map((p) => p.key + ":" + p.rot).join(",");
  if (sig === org.sig && (org.scanned || org.scanning)) return;
  org.sig = sig; const tok = ++org.tok;
  if (docPages.length < 2) { org.marks = new Map(); org.scanned = true; renderOrgTools(); return; }
  const list = docPages.slice(), ads = list.map(pageAdapter);
  org.scanning = "Checking for duplicates…"; renderOrgTools();
  try {
    const m = await T.duplicates(ads, 32, (i, n) => { if (tok === org.tok && n > 6) { org.scanning = `Checking for duplicates… ${i}/${n}`; renderOrgTools(); } });
    if (tok !== org.tok) return;
    org.marks = new Map(); m.forEach((o, d) => org.marks.set(list[ads.indexOf(d)], list[ads.indexOf(o)]));
  } catch (_) { if (tok !== org.tok) return; }
  org.scanning = ""; org.scanned = true;
  if (edMode === "organize") renderOrganize(); else renderOrgTools();
}
function renderOrgTools() {
  const host = $("org_tools"); if (!host) return;
  const d = liveOrgDups(), n = d.size, parts = [];
  if (docPages.length > 1) {
    if (org.scanning) parts.push(`<span class="ot-busy">${org.scanning}</span>`);
    else if (n) parts.push(`<button class="tb ot-dup" data-ot="show" title="Pages that look the same as an earlier page (marked in red) — click to tick them"><svg class="i" viewBox="0 0 20 20"><rect x="6" y="6" width="10" height="11" rx="1.2"/><path d="M4 13V4.2A1.2 1.2 0 015.2 3H13"/></svg><span class="tl">${n} duplicate${n === 1 ? "" : "s"}</span></button><button class="tb ot-del" data-ot="del" title="Remove the duplicate pages (Ctrl+Z undoes)"><svg class="i" viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M5.5 6l1 11h7l1-11"/></svg><span class="tl">Remove duplicates</span></button>`);
    else if (org.scanned) parts.push(`<span class="ot-ok">✓ No duplicates</span>`);
    parts.push(org.sorting ? `<span class="ot-busy">${org.sorting}</span>` : `<button class="tb" data-ot="sort" title="Read each page's printed page number (OCR for screenshots and scans) and put the pages in that order (Ctrl+Z undoes)"><svg class="i" viewBox="0 0 20 20"><path d="M5 4v12M2.5 13.5L5 16l2.5-2.5"/><path d="M10 5h7M10 9h5M10 13h3"/></svg><span class="tl">Sort by page number</span></button>`);
  }
  host.innerHTML = parts.join("");
  host.querySelectorAll("[data-ot]").forEach((b) => b.onclick = () => {
    const a = b.dataset.ot;
    if (a === "show") { orgSel.clear(); docPages.forEach((p, i) => { if (liveOrgDups().has(p)) orgSel.add(i); }); renderOrganize(); }
    else if (a === "del") removeOrgDuplicates();
    else if (a === "sort") sortOrgByNumber();
  });
}
function removeOrgDuplicates() {
  const d = liveOrgDups(); if (!d.size) return;
  snapshotNow();
  const keep = docPages.map((p, i) => d.has(p) ? -1 : i).filter((i) => i >= 0);
  if (applyPageOrder(keep)) { org.marks = new Map(); org.sig = docPages.map((p) => p.key + ":" + p.rot).join(","); render(); toast(`Removed ${d.size} duplicate page${d.size === 1 ? "" : "s"} — ${docPages.length} left. Ctrl+Z undoes.`); }
}
async function sortOrgByNumber() {
  const T = window.__cal2PageTools; if (!T || org.sorting) return;
  const list = docPages.slice(), found = [];
  for (let i = 0; i < list.length; i++) {
    org.sorting = `Reading page numbers… ${i + 1}/${list.length}`; renderOrgTools();
    let n = null; try { n = await T.pageNumber(pageAdapter(list[i]), true); } catch (_) {}
    found.push(n);
  }
  org.sorting = "";
  if (docPages.length !== list.length || docPages.some((p, i) => p !== list[i])) { renderOrgTools(); toast("The pages changed while reading — press Sort again."); return; }
  const k = found.filter((n) => n != null).length;
  if (!k) { renderOrgTools(); toast("No page numbers found on these pages — nothing was moved."); return; }
  if (T.numbersLookReal && !T.numbersLookReal(found)) { renderOrgTools(); toast("These pages don't seem to have page numbers (too few found, or the same number on many pages) — nothing was moved."); return; }
  // numbered pages in number order; a page without a number stays right after the page it followed
  let last = -1e9, seq = 0;
  const keyed = list.map((p, i) => found[i] != null ? (last = found[i], seq = 0, { i, k: found[i], s: 0 }) : { i, k: last, s: ++seq });
  keyed.sort((a, b) => a.k - b.k || a.s - b.s || a.i - b.i);
  snapshotNow();
  if (applyPageOrder(keyed.map((x) => x.i))) { render(); toast(`Sorted by page number — found a number on ${k} of ${found.length} pages${k < found.length ? " (pages without one stay after the page they followed)" : ""}. Ctrl+Z undoes.`); }
}
function renderOrganize() {
  const g = $("org_grid"); if (!g) return;
  g.innerHTML = "";
  docPages.forEach((p, i) => {
    const d = document.createElement("div");
    d.className = "og" + (orgSel.has(i) ? " sel" : ""); d.draggable = true; d.dataset.i = i;
    const dupOf = liveOrgDups().get(p);
    d.innerHTML = `<input type="checkbox" ${orgSel.has(i) ? "checked" : ""} title="Select page"><img data-pk="${p.key}" src="${thumbNow(p) || BLANK_PAGE}" alt="Page ${i + 1}" style="aspect-ratio:${p.w}/${p.h}" draggable="false"><div class="ogn">${i + 1}</div>` +
      (dupOf ? `<div class="ogdup">Same as page ${docPages.indexOf(dupOf) + 1}</div>` : "") +
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
  renderOrgTools(); setTimeout(scanOrgDuplicates, 50);
  add.addEventListener("dragover", (e) => { e.preventDefault(); add.classList.add("over"); });
  add.addEventListener("dragleave", () => add.classList.remove("over"));
  add.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); add.classList.remove("over"); if (e.dataTransfer.files.length) addFilesToDoc([...e.dataTransfer.files]); });
  g.appendChild(add);
  observeThumbs(g);
}

// ---- small page pictures for the page views (Merge, Split, Organize, the page list) ---------------------
// Drawn straight from the PDF at thumbnail size (not from the full-size page picture, which is 4-10x the
// pixels and was rendered and PNG-encoded one page at a time), a few at once, only for pages on screen.
let srcUid = 0;
const thumbUrls = new Map(), thumbJobs = new Map(), thumbQueue = [];
let thumbActive = 0;
const THUMB_W = 280, THUMB_CONC = 3;
const thumbKey = (p) => { const s = docSources[p.src]; if (s && !s.uid) s.uid = ++srcUid; return (s ? s.uid : "x") + ":" + p.idx + ":" + p.rot; };
const thumbNow = (p) => thumbUrls.get(thumbKey(p)) || null;
// one page drawn at a given width in pixels (white paper), turned as it is in the document
async function pageCanvasAt(p, wpx) {
  const src = docSources[p.src]; if (!src) return null;
  const c = document.createElement("canvas"), g = c.getContext("2d");
  if (src.kind === "pdf") {
    const page = await src.pdf.getPage(p.idx + 1), rotation = ((page.rotate || 0) + p.rot) % 360;
    const vp1 = page.getViewport({ scale: 1, rotation }), vp = page.getViewport({ scale: wpx / vp1.width, rotation });
    c.width = Math.max(1, Math.round(vp.width)); c.height = Math.max(1, Math.round(vp.height));
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    // "print" draws the page in one go: the screen intent draws a slice per animation frame, which crawls
    // in a background tab and lets a long page list fall behind
    await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
    return c;
  }
  const im = p.img || src.img; if (!im) return null;
  if (p.img) { c.width = wpx; c.height = Math.max(1, Math.round(wpx * p.h / p.w)); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(p.img, 0, 0, c.width, c.height); return c; }
  const sw = im.naturalWidth, sh = im.naturalHeight, swap = p.rot % 180 !== 0, k = wpx / (swap ? sh : sw);
  c.width = wpx; c.height = Math.max(1, Math.round((swap ? sw : sh) * k));
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.translate(c.width / 2, c.height / 2); g.rotate(p.rot * Math.PI / 180); g.drawImage(im, -sw * k / 2, -sh * k / 2, sw * k, sh * k);
  return c;
}
function requestThumb(p, urgent) {
  const k = thumbKey(p);
  if (thumbUrls.has(k)) return Promise.resolve(thumbUrls.get(k));
  if (thumbJobs.has(k)) return thumbJobs.get(k).promise;
  let resolve; const promise = new Promise((r) => { resolve = r; });
  const job = { k, p, resolve, promise };
  thumbJobs.set(k, job); if (urgent) thumbQueue.unshift(job); else thumbQueue.push(job);
  pumpThumbs();
  return promise;
}
function pumpThumbs() {
  while (thumbActive < THUMB_CONC && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (thumbKey(job.p) !== job.k) {   // its document was closed or replaced meanwhile
      thumbJobs.delete(job.k); job.resolve(BLANK_PAGE); continue;
    }
    thumbActive++;
    (async () => {
      let url = null;
      try {
        // a page that never finishes drawing must not hold up the others
        const c = await Promise.race([pageCanvasAt(job.p, THUMB_W), new Promise((r) => setTimeout(() => r(null), 20000))]);
        // a small JPEG written at once (toBlob waits for a background task: up to a second each in a background tab)
        if (c) { url = c.toDataURL("image/jpeg", 0.84); c.width = c.height = 0; }
      } catch (_) {}
      if (url) thumbUrls.set(job.k, url);
      thumbJobs.delete(job.k); thumbActive--; job.resolve(url || job.p.url || BLANK_PAGE);
      pumpThumbs();
    })();
  }
}
const thumbsIdle = () => !thumbActive && !thumbQueue.length;
// pictures with data-pk get their thumbnail when they come near the screen
const thumbObservers = new WeakMap(), VIEWPORT = {};   // one observer per scrolling box (dropped with it)
function observeThumbs(host, root) {
  if (!host) return;
  const key = root || VIEWPORT;
  let ob = thumbObservers.get(key);
  if (!ob) {
    ob = new IntersectionObserver((es) => es.forEach((e) => {
      if (!e.isIntersecting) return;
      const im = e.target; ob.unobserve(im);
      const p = docPages.find((x) => x.key === im.dataset.pk); if (!p) return;
      const want = thumbKey(p);
      requestThumb(p, true).then((u) => { if (im.isConnected && im.dataset.tk === want) im.src = u; });
    }), { root: root || null, rootMargin: "500px" });
    thumbObservers.set(key, ob);
  }
  let first = 0;
  host.querySelectorAll("img[data-pk]").forEach((im) => {
    const p = docPages.find((x) => x.key === im.dataset.pk); if (!p) return;
    const want = im.dataset.tk = thumbKey(p);
    const u = thumbNow(p); if (u) { im.src = u; return; }
    // the first screenful starts at once (the observer only reports after the next screen refresh)
    if (first++ < 18) requestThumb(p).then((url) => { if (im.isConnected && im.dataset.tk === want) im.src = url; });
    else ob.observe(im);
  });
}

// ---- Merge and Split: the document's files and pages as cards ------------------------------------------
// Merge: Files (one card per file, in order) or Pages. Split: scissors between pages - each click cuts
// there; Extract: tick pages to take out as one PDF. Everything works on the open document, so edits made
// in the editor go into what you download.
const pw = { on: "", view: "files", split: "split", cuts: new Set(), sel: new Set(), snip: "" };
const PW_TAGS = [["#f6d3db", "#7a2335"], ["#d2eee0", "#1d5a3f"], ["#f7e4c0", "#6b470b"], ["#dcdcf7", "#322f7a"], ["#d1e6f6", "#1a486c"], ["#f2d6ef", "#652861"]];
const PW_I = {
  back: '<svg viewBox="0 0 20 20"><path d="M4.5 10a5.5 5.5 0 105.5-5.5H6.5"/><path d="M8.5 2.3L6.2 4.5l2.3 2.2"/></svg>',
  files: '<svg viewBox="0 0 20 20"><path d="M6 2.8h6l3.2 3.2V17H6z"/><path d="M12 2.8V6h3.2M8.3 9.5h4.6M8.3 12h4.6M8.3 14.5h3"/><path d="M3.8 5.5v13h9"/></svg>',
  pages: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="6" height="6" rx=".8"/><rect x="11" y="3" width="6" height="6" rx=".8"/><rect x="3" y="11" width="6" height="6" rx=".8"/><rect x="11" y="11" width="6" height="6" rx=".8"/></svg>',
  cut: '<svg viewBox="0 0 20 20"><circle cx="5.5" cy="5.5" r="2.4"/><circle cx="5.5" cy="14.5" r="2.4"/><path d="M7.4 7l9.6 9M7.4 13l9.6-9"/></svg>',
  extract: '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="6" height="6" rx=".6" fill="currentColor"/><rect x="11" y="3" width="6" height="6" rx=".6"/><rect x="3" y="11" width="6" height="6" rx=".6"/><rect x="11" y="11" width="6" height="6" rx=".6" fill="currentColor"/></svg>',
  add: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2"/><path d="M10 6.6v6.8M6.6 10h6.8"/></svg>',
  rotl: '<svg viewBox="0 0 20 20"><path d="M4.6 10.5a5.6 5.6 0 105.6-5.6H6.4"/><path d="M8.4 2.6L6.2 4.9l2.3 2.2"/><circle cx="10.2" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>',
  rotr: '<svg viewBox="0 0 20 20"><path d="M15.4 10.5a5.6 5.6 0 11-5.6-5.6h3.8"/><path d="M11.6 2.6l2.2 2.3-2.3 2.2"/><circle cx="9.8" cy="10.5" r="1" fill="currentColor" stroke="none"/></svg>',
  del: '<svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M5.6 6l.9 11h7l.9-11M8.5 9v5.5M11.5 9v5.5"/></svg>',
  plus: '<svg viewBox="0 0 20 20"><path d="M10 5.5v9M5.5 10h9"/></svg>',
  caret: '<svg viewBox="0 0 20 20"><path d="M6 8.5l4 4 4-4" fill="currentColor"/></svg>',
};
function openPw(mode) {
  pw.on = mode === "extract" ? "split" : mode;
  if (pw.on === "split") pw.split = mode === "extract" ? "extract" : "split";
  pw.view = "files"; pw.sel.clear();
  document.body.dataset.pw = pw.on;
  closePanelTool(); openSide(false);
  render();
}
function closePw() { pw.on = ""; pw.sel.clear(); document.body.dataset.pw = ""; render(); }
// files = runs of pages that come from the same file, in document order
function pwRuns() {
  const runs = [];
  docPages.forEach((p, i) => { const r = runs[runs.length - 1]; if (r && r.src === p.src) r.idx.push(i); else runs.push({ src: p.src, idx: [i] }); });
  return runs;
}
// Split: the pages between cuts (a cut is stored as the page it comes after)
function pwGroups() {
  const out = [[]];
  docPages.forEach((p, i) => { out[out.length - 1].push(i); if (pw.cuts.has(p.key) && i < docPages.length - 1) out.push([]); });
  return out.filter((g) => g.length);
}
const pwSelIdx = () => docPages.map((p, i) => pw.sel.has(p.key) ? i : -1).filter((i) => i >= 0);
const pwName = (si) => (docSources[si] && docSources[si].name) || "document";
function pwTagHtml(si) { const [bg, fg] = PW_TAGS[si % PW_TAGS.length]; return `<div class="pw-tag" style="background:${bg};color:${fg}" title="${escapeHTML(pwName(si))}">${escapeHTML(pwName(si))}</div>`; }
function pwCard(p, i, opts = {}) {
  const st = opts.stack ? " stack" : "", chk = opts.check ? `<span class="pw-chk${opts.checked ? " on" : ""}" role="checkbox" aria-checked="${!!opts.checked}" title="Select"></span>` : "";
  const k = Math.min(144 / p.w, 190 / p.h), w = Math.round(p.w * k), h = Math.round(p.h * k);   // the page's shape even before its picture arrives
  return `<div class="pw-card${st}">${chk}<img data-pk="${p.key}" src="${thumbNow(p) || BLANK_PAGE}" alt="Page ${i + 1}" draggable="false" style="--w:${w}px;--h:${h}px"></div>`;
}
function pwAddTile(at) {
  return `<div class="pw-addtile" data-at="${at}"><span class="pw-addi">${PW_I.add}</span><span>Add <b>PDF</b>, <b>image</b>, <b>Word</b>, <b>Excel</b>, and <b>PowerPoint</b> files</span></div>`;
}
function pwPick(at) {
  const inp = document.createElement("input"); inp.type = "file"; inp.multiple = true;
  inp.accept = "application/pdf,.pdf,image/*,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.odt,.ods,.odp,.rtf,.txt,.csv,.html,.htm,.md";
  inp.onchange = () => { if (inp.files && inp.files.length) addFilesToDoc([...inp.files], at); };
  inp.click();
}
function renderPw() {
  const host = $("pw"); if (!host) return;
  const scroll = host.querySelector(".pw-body") ? host.querySelector(".pw-body").scrollTop : 0;
  const merge = pw.on === "merge", extract = !merge && pw.split === "extract", N = docPages.length;
  const live = new Set(docPages.map((p) => p.key));
  [...pw.sel].forEach((k) => { if (!live.has(k)) pw.sel.delete(k); });
  const selN = pw.sel.size, groups = merge ? null : pwGroups();
  const seg = merge
    ? `<div class="pw-seg"><button data-v="files" class="${pw.view === "files" ? "on" : ""}">${PW_I.files}Files</button><button data-v="pages" class="${pw.view === "pages" ? "on" : ""}">${PW_I.pages}Pages</button></div>`
    : `<div class="pw-seg"><button data-s="split" class="${!extract ? "on" : ""}">${PW_I.cut}Split</button><button data-s="extract" class="${extract ? "on" : ""}">${PW_I.extract}Extract</button></div>`;
  const parts = groups ? groups.length : 0;
  const go = merge ? `Download merged PDF${N ? ` (${N} page${N === 1 ? "" : "s"})` : ""}`
    : extract ? (selN ? `Extract ${selN} page${selN === 1 ? "" : "s"}` : "Tick pages to extract")
    : (parts > 1 ? `Split into ${parts} files` : "Click ✂ to cut");
  const goOff = merge ? !N : extract ? !selN : parts < 2;
  const extra = !merge && !extract ? `<div class="pw-sp"></div><button class="pw-link" data-a="cutall" title="Cut after every page: each page becomes its own file">Cut every page</button>${pw.cuts.size ? '<button class="pw-link" data-a="clearcuts">Clear cuts</button>' : ""}` : '<div class="pw-sp"></div>';
  let body = "";
  if (merge && pw.view === "files") {
    const runs = pwRuns();
    runs.forEach((r, k) => {
      const p = docPages[r.idx[0]], on = r.idx.every((i) => pw.sel.has(docPages[i].key));
      if (k) body += `<button class="pw-ins" data-at="${r.idx[0]}" title="Add files here">${PW_I.plus}</button>`;
      body += `<div class="pw-item pw-file" draggable="true" data-run="${k}">${pwCard(p, r.idx[0], { stack: r.idx.length > 1, check: true, checked: on })}${pwTagHtml(r.src)}<div class="pw-sub">${r.idx.length} page${r.idx.length === 1 ? "" : "s"}</div></div>`;
    });
    if (runs.length) body += `<button class="pw-ins" data-at="${N}" title="Add files here">${PW_I.plus}</button>`;
    body += pwAddTile(N);
  } else if (merge || extract) {
    docPages.forEach((p, i) => {
      body += `<div class="pw-item pw-page" draggable="true" data-i="${i}">${pwCard(p, i, { check: true, checked: pw.sel.has(p.key) })}${pwTagHtml(p.src)}<div class="pw-sub">${i + 1}</div></div>`;
    });
    body += pwAddTile(N);
  } else {
    groups.forEach((g, gi) => {
      body += `<div class="pw-group${groups.length > 1 ? " cut" : ""}">`;
      g.forEach((i, k) => {
        const p = docPages[i];
        body += `<div class="pw-item pw-page" draggable="true" data-i="${i}">${pwCard(p, i)}${pwTagHtml(p.src)}<div class="pw-sub">${i + 1}</div></div>`;
        if (k < g.length - 1) body += `<div class="pw-cutline"><button class="pw-cut${pw.snip === p.key ? " snip" : ""}" data-after="${p.key}" title="Cut here: pages ${i + 1} and ${i + 2} go into separate files">${PW_I.cut}</button></div>`;
      });
      body += "</div>";
      if (gi < groups.length - 1) { const last = docPages[g[g.length - 1]]; body += `<div class="pw-cutline on"><button class="pw-cut on${pw.snip === last.key ? " snip" : ""}" data-after="${last.key}" title="Join these pages again">${PW_I.cut}</button></div>`; }
    });
    body += pwAddTile(N);
  }
  host.innerHTML =
    `<div class="pw-head"><button class="pw-back" data-a="back" title="Back to all pages">${PW_I.back}</button><h2>${merge ? "Merge" : "Split"}</h2><div class="pw-sp"></div>` +
    `<button class="pw-go" data-a="go"${goOff ? " disabled" : ""}>${go}</button></div>` +
    `<div class="pw-bar">${seg}<span class="pw-div"></span>` +
    `<div class="pw-dd"><button class="pw-btn" data-a="addmenu">${PW_I.add}Add${PW_I.caret}</button><div class="pw-menu"><button data-a="addfiles">Files from this device…</button><button data-a="blank">Blank page</button></div></div><span class="pw-div"></span>` +
    `<div class="pw-grp"><button data-a="rotl" title="Rotate ${selN ? "selected" : "all"} pages left">${PW_I.rotl}</button><button data-a="rotr" title="Rotate ${selN ? "selected" : "all"} pages right">${PW_I.rotr}</button><button data-a="del" title="Delete selected"${selN ? "" : " disabled"}>${PW_I.del}</button></div>${extra}</div>` +
    (merge || extract ? `<label class="pw-all"><span class="pw-chk${N && selN === N ? " on" : ""}"></span>Select all${selN ? `<small>${selN} selected</small>` : ""}</label>` : `<div class="pw-hint">${parts > 1 ? `${parts} files: ${groups.map((g) => g.length === 1 ? `page ${g[0] + 1}` : `pages ${g[0] + 1}-${g[g.length - 1] + 1}`).join(" · ")}` : "Click a ✂ between two pages to cut the document there."}</div>`) +
    `<div class="pw-body"><div class="pw-grid${merge ? "" : " split"}">${body}</div></div>`;
  pw.snip = "";
  const bodyEl = host.querySelector(".pw-body"); bodyEl.scrollTop = scroll;
  wirePw(host);
  observeThumbs(host, bodyEl);
}
function pwToggle(keys, on) { keys.forEach((k) => { if (on) pw.sel.add(k); else pw.sel.delete(k); }); renderPw(); }
function pwMoveRun(from, to) {   // move file run `from` before run `to` (to = runs.length: to the end)
  const runs = pwRuns(); if (from === to || from + 1 === to) return;
  const order = [];
  runs.forEach((r, k) => { if (k === to) order.push(...runs[from].idx); if (k !== from) order.push(...r.idx); });
  if (to >= runs.length) order.push(...runs[from].idx);
  applyPageOrder(order); render();
}
function wirePw(host) {
  host.querySelectorAll("[data-v]").forEach((b) => b.onclick = () => { pw.view = b.dataset.v; renderPw(); });
  host.querySelectorAll("[data-s]").forEach((b) => b.onclick = () => { pw.split = b.dataset.s; pw.sel.clear(); renderPw(); });
  host.querySelectorAll("[data-a]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const a = b.dataset.a, sel = pwSelIdx(), all = docPages.map((_, i) => i);
    if (a === "back") closePw();
    else if (a === "go") pwGo();
    else if (a === "addmenu") b.parentNode.classList.toggle("open");
    else if (a === "addfiles") { b.closest(".pw-dd").classList.remove("open"); pwPick(docPages.length); }
    else if (a === "blank") { b.closest(".pw-dd").classList.remove("open"); addBlankPage(); }
    else if (a === "rotl" || a === "rotr") rotatePages(sel.length ? sel : all, a === "rotl" ? -1 : 1);
    else if (a === "del") { if (sel.length >= docPages.length) { toast("A document needs at least one page."); return; } pw.sel.clear(); deletePages(sel); }
    else if (a === "cutall") { docPages.forEach((p, i) => { if (i < docPages.length - 1) pw.cuts.add(p.key); }); renderPw(); }
    else if (a === "clearcuts") { pw.cuts.clear(); renderPw(); }
  });
  host.onclick = (e) => { if (!e.target.closest(".pw-dd")) host.querySelectorAll(".pw-dd.open").forEach((d) => d.classList.remove("open")); };
  const all = host.querySelector(".pw-all");
  if (all) all.onclick = (e) => { e.preventDefault(); const on = pw.sel.size !== docPages.length; pwToggle(docPages.map((p) => p.key), on); };
  host.querySelectorAll(".pw-cut").forEach((b) => b.onclick = () => {
    const k = b.dataset.after;
    if (pw.cuts.has(k)) pw.cuts.delete(k); else pw.cuts.add(k);
    pw.snip = k; renderPw();
  });
  host.querySelectorAll(".pw-ins").forEach((b) => b.onclick = () => pwPick(+b.dataset.at));
  host.querySelectorAll(".pw-addtile").forEach((t) => {
    t.onclick = () => pwPick(+t.dataset.at);
    t.ondragover = (e) => { e.preventDefault(); t.classList.add("over"); };
    t.ondragleave = () => t.classList.remove("over");
    t.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); t.classList.remove("over");
      if (e.dataTransfer.files && e.dataTransfer.files.length) addFilesToDoc([...e.dataTransfer.files], +t.dataset.at);
      else { const d = e.dataTransfer.getData("text/x-pw"); if (d) pwDropOn(JSON.parse(d), null); }
    };
  });
  host.querySelectorAll(".pw-item").forEach((el) => {
    const run = el.dataset.run != null ? +el.dataset.run : null, i = el.dataset.i != null ? +el.dataset.i : null;
    const keys = () => run != null ? pwRuns()[run].idx.map((x) => docPages[x].key) : [docPages[i].key];
    const chk = el.querySelector(".pw-chk");
    el.onclick = () => {   // a click anywhere on a card ticks or unticks it (Split has no ticks: the scissors do the work)
      if (!chk) return;
      const ks = keys(); pwToggle(ks, !ks.every((k) => pw.sel.has(k)));
    };
    el.ondblclick = () => { if (i != null) { closePw(); curPage = i; doc = docPages[i]; setEdMode("edit"); setCurPage(i, true); } };
    el.ondragstart = (e) => { e.dataTransfer.setData("text/x-pw", JSON.stringify(run != null ? { run } : { i })); e.dataTransfer.effectAllowed = "move"; el.classList.add("dragging"); };
    el.ondragend = () => el.classList.remove("dragging");
    el.ondragover = (e) => { e.preventDefault(); el.classList.add("drop"); };
    el.ondragleave = () => el.classList.remove("drop");
    el.ondrop = (e) => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove("drop");
      if (e.dataTransfer.files && e.dataTransfer.files.length) { addFilesToDoc([...e.dataTransfer.files], run != null ? pwRuns()[run].idx[0] : i); return; }
      const d = e.dataTransfer.getData("text/x-pw"); if (d) pwDropOn(JSON.parse(d), run != null ? { run } : { i });
    };
  });
  // dropping files anywhere in the workspace adds them at the end
  const bodyEl = host.querySelector(".pw-body");
  bodyEl.ondragover = (e) => { if ([...(e.dataTransfer.types || [])].includes("Files")) e.preventDefault(); };
  bodyEl.ondrop = (e) => { if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); addFilesToDoc([...e.dataTransfer.files]); } };
}
function pwDropOn(src, dst) {
  if (src.run != null) { const runs = pwRuns(); pwMoveRun(src.run, dst && dst.run != null ? dst.run : runs.length); return; }
  if (src.i != null) movePage(src.i, dst && dst.i != null ? dst.i : docPages.length - 1);
}
async function ensureZip() {
  if (!window.JSZip) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; sc.onload = res; sc.onerror = () => rej(new Error("Could not load the zip library")); document.head.appendChild(sc); });
  return window.JSZip;
}
let pwBusy = false;
async function pwGo() {
  if (pwBusy) return;
  if (pw.on === "merge") {   // the same PDF as the Download button gives, with the Download panel's look and quality
    snapshotNow(); pwBusy = true; exportLook = dlOpts.look;
    try { await exportPDF(); } finally { exportLook = null; pwBusy = false; }
    return;
  }
  const extract = pw.split === "extract";
  const groups = extract ? [pwSelIdx()] : pwGroups();
  if (!groups[0] || !groups[0].length || (!extract && groups.length < 2)) { toast(extract ? "Tick the pages to extract first." : "Click a ✂ between two pages to cut there first."); return; }
  pwBusy = true; const btn = document.querySelector("#pw .pw-go"); if (btn) { btn.disabled = true; btn.textContent = extract ? "Extracting…" : "Splitting…"; }
  try {
    snapshotNow();
    const L = await pdfLibReady();
    const { pdf } = await buildOutputPdf({ flat: true });   // the document with your edits, built once; each part copies its pages from it
    try { pdf.getForm().updateFieldAppearances(); pdf.getForm().flatten(); } catch (_) {}   // filled-in fields fixed in place, as in Download
    const base = baseName(), files = [];
    for (let k = 0; k < groups.length; k++) {
      const g = groups[k], out = await L.PDFDocument.create();
      (await out.copyPages(pdf, g)).forEach((pg) => out.addPage(pg));
      const span = g.length === 1 ? `page${g[0] + 1}` : extract ? `${g.length}pages` : `pages${g[0] + 1}-${g[g.length - 1] + 1}`;
      files.push([extract ? `${base}-extract.pdf` : `${base}-part${k + 1}-${span}.pdf`, await applyPdfMeta(out).save(saveOpts())]);
    }
    if (files.length === 1) download(files[0][0], new Blob([files[0][1]], { type: "application/pdf" }));
    else {
      const Z = await ensureZip(), zip = new Z();
      files.forEach(([n, b]) => zip.file(n, b));
      download(`${base}-split.zip`, await zip.generateAsync({ type: "blob" }));
    }
    toast(extract ? `Saved ${groups[0].length} page${groups[0].length === 1 ? "" : "s"} as ${files[0][0]}.` : `Saved ${files.length} PDFs in ${base}-split.zip.`);
  } catch (e) { toast((extract ? "Extract" : "Split") + " failed: " + (e.message || e)); }
  finally { pwBusy = false; renderPw(); }
}

// ---- the PDF's own text: find it, edit it in its own font, remove it -----------------
const textBlocks = new Map();      // page key:rot -> Promise<blocks>
const pdfFonts = new Map();        // source:fontName -> { loadedName, map, inv, fallback }
// The closest available font for a PDF font (downloaded on demand), used for any
// characters the PDF's own embedded font does not contain — or when it has none.
function fontFallback(fo, fontName) {
  // the font's own description says bold / italic even when its name doesn't (ForceBold, Italic flags)
  const m = matchPdfFont((fo && fo.name) || fontName, { serif: !!(fo && fo.isSerifFont), mono: !!(fo && fo.isMonospace), bold: !!(fo && (fo.bold || fo.black)), italic: !!(fo && fo.italic) });
  ensureFont(m.family);
  const f = fontEntry(m.family);
  return { css: m.css, family: m.family, weight: m.weight, style: m.style, serif: !!f && f.cat === "Serif", mono: !!f && f.cat === "Mono", known: m.known };
}
function registerPdfFont(si, fontName, page) {
  const key = si + ":" + fontName;
  if (pdfFonts.has(key)) return key;
  let fo = null;
  try { if (page.commonObjs.has(fontName)) fo = page.commonObjs.get(fontName); } catch (_) {}
  const info = { loadedName: null, map: {}, inv: {}, fallback: fontFallback(fo, fontName) };
  // an OCR text layer (invisible "GlyphLess" text over a scan) says nothing about the font: recognise it from the picture
  info.glyphless = /glyphless/i.test(((fo && fo.name) || "") + " " + fontName);
  if (fo && fo.loadedName && !fo.missingFile && [...document.fonts].some((f) => f.family.replace(/["']/g, "") === fo.loadedName)) {
    const tfc = fo.toFontChar || [], tu = fo.toUnicode || {};
    const add = (code, uni) => { const fc = tfc[code]; if (uni && fc != null && [...uni].length === 1) { const ch = String.fromCodePoint(fc); info.map[uni] = ch; info.inv[ch] = uni; } };
    if (tu._map) { for (const code in tu._map) add(+code, tu._map[code]); }
    else if (tu.firstChar != null) { for (let c = tu.firstChar; c <= tu.lastChar; c++) add(c, String.fromCharCode(c)); }
    if (Object.keys(info.map).length) info.loadedName = fo.loadedName;
    // the same font again, answering to every weight: the line can then ask for the weight of its fallback
    // font (for characters the PDF's copy lacks) without the PDF's own letters being drawn fake-bold
    if (info.loadedName && fo.data) {
      try { const ff = new FontFace(info.loadedName + "_w", fo.data, { weight: "1 1000" }); document.fonts.add(ff); ff.load().catch(() => {}); info.anyWeight = info.loadedName + "_w"; } catch (_) {}
    }
  }
  info.visual = info.glyphless || (!info.loadedName && !info.fallback.known);   // no font of its own and an unknown name
  pdfFonts.set(key, info);
  return key;
}
const pfontInfo = (it) => (it && it.pfont ? pdfFonts.get(it.pfont) : null);
// A PDF font with no usable name (e.g. "CIDFont+F1") says nothing about the font it was made from, so a
// character its embedded copy lacks (a "4" typed into "2021") would come out in a plain stand-in. Its own
// drawing of the line is compared with the candidate fonts instead, so those characters match it in
// family, weight and slant.
function matchMissingGlyphs(info, str) {
  if (!info || !info.loadedName || info.fallback.known || !String(str || "").trim()) return Promise.resolve(null);
  if (!info.fbMatch) info.fbMatch = (async () => {
    const PX = 64, disp = toFontStr(info, str), font = `${PX}px "${info.loadedName}"`;
    try { await document.fonts.load(font, disp); } catch (_) {}
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = font; try { measureCtx.letterSpacing = "0px"; } catch (_) {}
    const c = document.createElement("canvas"); c.width = Math.ceil(measureCtx.measureText(disp).width + PX); c.height = PX * 2;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000"; g.font = font; g.textBaseline = "alphabetic"; g.fillText(disp, PX / 2, PX * 1.4);
    const best = (await identifyFont(c, str))[0]; if (!best) return null;
    const fe = fontEntry(best.family);
    info.fallback = { ...info.fallback, css: fe ? fe.css : `"${best.family}", sans-serif`, family: best.family, weight: best.weight, style: best.style, known: true, matched: true };
    return best;
  })().catch(() => null);
  return info.fbMatch;
}
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
// Scanned pages (no text of their own): the page is read with OCR and each line becomes editable text
// in the closest matching font.
const ocrBlocks = new Map();       // page key:rot -> Promise<blocks>
function hiResPage(pi) {           // the page drawn sharp for reading (~288 dpi for PDF pages, the picture's own size otherwise)
  const p = docPages[pi], ck = "hr:" + p.key + ":" + p.rot;
  if (!ocrBlocks.has(ck)) ocrBlocks.set(ck, sourceCanvas(pi, docSources[p.src].kind === "pdf" ? 2 : 1));
  return ocrBlocks.get(ck);
}
function getOcrBlocks(pi) {
  const p = docPages[pi], ck = "ocr:" + p.key + ":" + p.rot;
  if (!ocrBlocks.has(ck)) ocrBlocks.set(ck, (async () => {
    const T = window.__cal2PageTools; if (!T || !T.recognize) return [];
    const c = await hiResPage(pi);
    toast("Reading the text on this scanned page… (first time: downloads the text reader)");
    const data = await T.recognize(c), out = [];
    for (const bl of data.blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) {
      const words = (ln.words || []).filter((w) => w.text && w.text.trim());   // every word: a dropped one would be covered over and lost
      if (!words.length || (ln.confidence || 0) < 20) continue;
      const x0 = Math.min(...words.map((w) => w.bbox.x0)), x1 = Math.max(...words.map((w) => w.bbox.x1)), y0 = Math.min(...words.map((w) => w.bbox.y0)), y1 = Math.max(...words.map((w) => w.bbox.y1));
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;
      const h = y1 - y0;
      out.push({ str: words.map((w) => w.text).join(" "), ocr: true, conf: Math.round(ln.confidence || 0), asc: 0.9, nx: x0 / c.width, ny: y0 / c.height, nw: (x1 - x0) / c.width, nh: h / c.height, fsN: h / 1.15 / c.width });
    }
    toast(out.length ? `Read ${out.length} line${out.length === 1 ? "" : "s"} from the scan — click one to edit it in the closest matching font.` : "No text found on this page. Use Add text to write on it.");
    return out;
  })().catch((e) => { toast("Couldn't read this page: " + (e.message || e)); return []; }));
  return ocrBlocks.get(ck);
}
function renderTextBlocks(ov, pi, dispW, dispH) {
  const p = docPages[pi];
  getTextBlocks(pi).then(async (blocks) => {
    if (!ov.isConnected || edTool !== "edittext") return;
    if (!blocks.length && pi === curPage) blocks = await getOcrBlocks(pi);   // a scan: read it
    if (!ov.isConnected || edTool !== "edittext") return;
    ov.querySelectorAll(".tblock").forEach((x) => x.remove());   // a second pass over the same page replaces the first
    blocks.forEach((b, bi) => {
      const bid = p.key + ":" + p.rot + ":" + bi;
      if (docItems.some((it) => it.blockId === bid)) return;
      const t = document.createElement("div"); t.className = "tblock" + (b.ocr ? " ocr" : ""); t.title = b.ocr ? `Click to edit this text (read from the scan, ${b.conf}% sure)` : "Click to edit this text";
      t.style.cssText = `left:${b.nx * dispW - 2}px;top:${b.ny * dispH - 2}px;width:${b.nw * dispW + 4}px;height:${b.nh * dispH + 4}px`;
      t.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); createTextEdit(pi, b, bid, e.clientX, e.clientY); };
      ov.appendChild(t);
    });

  });
}
let textEditBusy = false;
async function createTextEdit(pi, b, bid, cx, cy) {
  if (textEditBusy) return;
  const p = docPages[pi];
  const [bg, fg] = sampleBlockColors(p, b);
  const info = b.pfont ? pdfFonts.get(b.pfont) : null;
  // scans, OCR text layers and unknown fonts: recognise the font from how the line looks
  let vis = null;
  if (b.ocr || (info && info.visual)) {
    textEditBusy = true; document.body.style.cursor = "progress";
    try { toast("Matching the font…"); vis = await matchLineFont(pi, b); } catch (_) { vis = null; }
    finally { textEditBusy = false; document.body.style.cursor = ""; }
    if (vis) b = { ...b, ...vis.geom };
  }
  const padX = b.fsN * 0.08, padY = b.nh * 0.1;
  const it = {
    id: "it" + itemSeq++, type: "text", tbox: true, tedit: true, page: pi, blockId: bid, pfont: vis ? undefined : b.pfont,
    ff: vis ? vis.best.family : info ? info.fallback.family : "Arimo", ...(vis ? { bold: vis.best.weight >= 700, italic: vis.best.style === "italic", fontMatches: vis.list.slice(0, 6) } : {}),
    fs: b.fsN, asc: b.asc, color: fg, bg: "none", coverBg: bg, opacity: 1, signer: activeSigner, align: "left",
    cover: { nx: b.nx - padX, ny: b.ny - padY, nw: b.nw + padX * 2, nh: b.nh + padY * 2 },
    nx: b.nx, ny: b.ny, nw: b.nw + padX, ar: (b.nh / (b.nw + padX)) / pageAspect(pi), text: b.str, orig: b.str,
  };
  if (!it.pfont) delete it.pfont;
  if (vis) { if (b.ls) it.ls = b.ls; } else await matchLetterSpacing(it, b);
  docItems.push(it); selId = it.id; selDraw = null;
  render();
  if (vis) toast(`Closest font: ${vis.best.family}${vis.best.weight >= 700 ? " Bold" : ""}${vis.best.style === "italic" ? " Italic" : ""} (${vis.best.pct}% match) — other close matches are at the top of the font list.`);
  requestAnimationFrame(() => { const el = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"]`); if (el) startTboxEdit(it, el, cx, cy); });
  if (!vis && info && info.loadedName && !info.fallback.known) matchMissingGlyphs(info, b.str).then(async (best) => {
    if (!best) return;
    ensureFont(best.family);
    delete it.ls; await matchLetterSpacing(it, b);   // characters such as spaces are now drawn in the matched font
    if (editingId !== it.id) { render(); return; }
    // being typed in: restyle the line in place, so the caret stays where it is
    const td = document.querySelector(`#ed_pages .ditem[data-id="${it.id}"] .tbtext`); if (!td) return;
    const f = tboxFont(it), fsPx = parseFloat(td.style.fontSize) || 0, tl = teditLine(it, f, fsPx);
    Object.assign(td.style, { fontFamily: f.css, fontWeight: f.weight, fontStyle: f.style, letterSpacing: (it.ls || 0) + "em", lineHeight: tl.lh + "px", transform: Math.abs(tl.dy) > 0.05 ? `translateY(${tl.dy}px)` : "" });
  });
}
// Letter spacing that makes the line exactly as wide as the original, so the edited text sits where it was.
let measureCtx = null;
async function matchLetterSpacing(it, b) {
  try {
    // measured on the line as it was in the PDF (it may have been typed over since)
    const orig = b.str != null ? b.str : it.text || "", g = glyphInfo(it);
    const n = [...orig].length; if (n < 3 || !(b.fsN > 0)) return;
    const f = tboxFont(it), font = `${f.style} ${f.weight} 100px ${f.css}`, txt = g ? toFontStr(g, orig) : orig;
    await Promise.race([document.fonts.load(font, txt), new Promise((r) => setTimeout(r, 900))]);
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = font; try { measureCtx.letterSpacing = "0px"; } catch (_) {}
    const natural = measureCtx.measureText(txt).width / 100, actual = b.nw / b.fsN;   // both in "em"
    const ls = (actual - natural) / n;
    if (Math.abs(ls) > 0.003 && ls > -0.08 && ls < 0.25) it.ls = Math.round(ls * 1000) / 1000;
  } catch (_) {}
}

// ---- recognising a font from how text looks --------------------------------------------------------
// The line's ink is compared with the same words drawn in each candidate font (regular and bold, then
// italics of the closest families): overlap of the shapes plus how wide the line runs.
const MATCH_FAMILIES = ["Arimo", "Tinos", "Cousine", "Carlito", "Caladea", "Gelasio", "Open Sans", "Roboto", "Lato", "Montserrat", "Source Sans 3",
  "Noto Sans", "Inter", "Poppins", "Raleway", "PT Sans", "Roboto Condensed", "Libre Franklin", "Oswald", "Work Sans", "Fira Sans", "Ubuntu",
  "Nunito", "Archivo", "Merriweather", "PT Serif", "Noto Serif", "Lora", "EB Garamond", "Libre Baskerville", "Crimson Text", "Source Serif 4",
  "Playfair Display", "Old Standard TT", "Bitter", "Roboto Slab", "Roboto Mono", "Courier Prime", "Source Code Pro"];
function inkOf(data, w, h, isInk) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isInk(data, (y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const lumAt = (d, k) => d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11;
// How much ink is in each cell of a W x H grid laid over the box (0..1). Blur moves ink around but keeps how
// much of it there is, so this compares a soft scan with crisp type fairly. paper/ink: the two grey levels.
function inkMass(src, box, W, H, paper, ink) {
  const S = 3, c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
  const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = "high";
  g.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data, m = new Float32Array(W * H), r = 1 / Math.max(1, paper - ink), cw = W * S;
  for (let y = 0; y < H * S; y++) { const row = ((y / S) | 0) * W; for (let x = 0; x < cw; x++) { const v = (paper - lumAt(d, (y * cw + x) * 4)) * r; if (v > 0) m[row + ((x / S) | 0)] += (v > 1 ? 1 : v) / (S * S); } }
  return m;
}
async function identifyFont(crop, text, families = MATCH_FAMILIES) {
  text = String(text || "").trim(); if (!text) return [];
  const g0 = crop.getContext("2d", { willReadFrequently: true }), cd = g0.getImageData(0, 0, crop.width, crop.height).data, N = crop.width * crop.height;
  const hist = new Uint32Array(256); for (let i = 0; i < N; i++) hist[lumAt(cd, i * 4) | 0]++;
  let acc = 0, paper = 255, lo = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > N * 0.5) { paper = v; break; } }
  acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > N * 0.01) { lo = v; break; } }
  const thr = (paper + lo) / 2;
  // the paper's own grain is not ink: only what is darker than the paper's noise counts
  let bs = 0, bq = 0, bn = 0; for (let i = 0; i < N; i++) { const v = lumAt(cd, i * 4); if (v > thr) { bs += v; bq += v * v; bn++; } }
  const bm = bs / Math.max(1, bn), floor = bm - 2.5 * Math.sqrt(Math.max(0, bq / Math.max(1, bn) - bm * bm));
  const cb = inkOf(cd, crop.width, crop.height, (d, k) => lumAt(d, k) < thr); if (!cb || cb.h < 4) return [];
  const HN = 24, WN = Math.max(8, Math.min(500, Math.round(cb.w * HN / cb.h)));
  const feats = (m) => { let tot = 0; const rows = new Float32Array(HN); for (let y = 0; y < HN; y++) { let s2 = 0; for (let x = 0; x < WN; x++) s2 += m[y * WN + x]; rows[y] = s2; tot += s2; } for (let y = 0; y < HN; y++) rows[y] /= tot || 1; return { rows, dens: tot / (WN * HN) }; };
  const T = inkMass(crop, cb, WN, HN, Math.min(paper - 2, floor), lo), fT = feats(T);
  await Promise.race([Promise.all(families.map((f) => ensureFont(f))), new Promise((r) => setTimeout(r, 6000))]);   // first time: download them
  const PX = 48, cv = document.createElement("canvas"), g = cv.getContext("2d", { willReadFrequently: true }), out = [];
  const tryOne = async (family, weight, style) => {
    const font = `${style} ${weight} ${PX}px "${family}"`;
    // only a font that is really here (an unknown family is drawn in the browser's default font), with a real bold / italic
    let faces = []; try { faces = await document.fonts.load(font, text); } catch (_) {}
    const fw = (f) => { const w = String(f.weight).split(" ").map(Number); return w.length > 1 ? (weight >= w[0] && weight <= w[1]) : Math.abs(w[0] - weight) < 150; };
    if (!faces.some((f) => f.family.replace(/["']/g, "") === family && fw(f) && (f.style === style || (style === "normal" && f.style !== "italic")))) return;
    g.font = font; const m = g.measureText(text);
    cv.width = Math.ceil(m.width + PX); cv.height = PX * 2; g.font = font; g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = "#000"; g.textBaseline = "alphabetic";
    g.fillText(text, PX / 2, PX * 1.4);
    const d = g.getImageData(0, 0, cv.width, cv.height).data, b = inkOf(d, cv.width, cv.height, (dd, k) => lumAt(dd, k) < 128); if (!b) return;
    const C = inkMass(cv, b, WN, HN, 255, 0), fC = feats(C);
    let mn = 0, mx = 0; for (let i = 0; i < C.length; i++) { mn += Math.min(C[i], T[i]); mx += Math.max(C[i], T[i]); }
    let rowE = 0; for (let y = 0; y < HN; y++) rowE += Math.abs(fC.rows[y] - fT.rows[y]);
    const shapeE = 1 - (mx ? mn / mx : 0), widthE = Math.abs(Math.log((b.w / b.h) / (cb.w / cb.h))), weightE = Math.abs(Math.log((fC.dens + 1e-3) / (fT.dens + 1e-3)));
    const fm = g.measureText("Hg");
    out.push({ family, weight, style, score: shapeE + 1.5 * widthE + weightE + rowE,
      k: cb.h / b.h, inkW: b.w, inkLeft: b.x - PX / 2, inkTop: PX * 1.4 - b.y, asc: (fm.fontBoundingBoxAscent || PX * 0.9) / PX, desc: (fm.fontBoundingBoxDescent || PX * 0.22) / PX });
  };
  for (const f of families) { await tryOne(f, 400, "normal"); await tryOne(f, 700, "normal"); }
  out.sort((a, b) => a.score - b.score);
  for (const f of [...new Set(out.slice(0, 6).map((o) => o.family))]) { await tryOne(f, 400, "italic"); await tryOne(f, 700, "italic"); }
  out.sort((a, b) => a.score - b.score);
  // a match percentage people can read: the best possible score is 0, about 1.2 is a poor match
  out.forEach((o) => { o.pct = Math.max(1, Math.min(99, Math.round(100 * Math.exp(-0.6 * o.score)))); });
  out.cropBox = cb; out.PX = PX;
  return out;
}
// Match the font of one text line of a page; returns the best font, the list, and where the text sits.
async function matchLineFont(pi, b) {
  const page = await hiResPage(pi), W = page.width, H = page.height;
  const padX = Math.round(b.nh * H * 0.4), padY = Math.round(b.nh * H * 0.25);
  const bx = Math.max(0, Math.floor(b.nx * W) - padX), by = Math.max(0, Math.floor(b.ny * H) - padY);
  const bw = Math.min(W - bx, Math.ceil(b.nw * W) + padX * 2), bh = Math.min(H - by, Math.ceil(b.nh * H) + padY * 2);
  if (bw < 4 || bh < 4) return null;
  const crop = document.createElement("canvas"); crop.width = bw; crop.height = bh; crop.getContext("2d").drawImage(page, bx, by, bw, bh, 0, 0, bw, bh);
  const list = await identifyFont(crop, b.str); if (!list.length) return null;
  const best = list[0], cb = list.cropBox, PX = list.PX;
  // page pixels: font size, baseline, left edge of the text
  const fsPx = PX * best.k, base = by + cb.y + best.inkTop * best.k, left = bx + cb.x - best.inkLeft * best.k;
  // letter spacing that closes what's left of the width difference (the font is already the closest in shape)
  const n = [...b.str].length, ls = n > 2 ? ((cb.w / best.k) - best.inkW) / PX / n : 0;
  const seen = new Set(), uniq = list.filter((o) => { const k = o.family + o.weight + o.style; if (seen.has(k)) return false; seen.add(k); return true; });
  return {
    best, list: uniq.slice(0, 8).map((o) => ({ family: o.family, weight: o.weight, style: o.style, pct: o.pct })),
    geom: { fsN: fsPx / W, asc: best.asc, nx: left / W, ny: (base - best.asc * fsPx) / H, nw: Math.max(cb.w * 1.02, fsPx) / W, nh: (best.asc + best.desc) * fsPx / H, ls: Math.abs(ls) > 0.003 && Math.abs(ls) < 0.15 ? Math.round(ls * 1000) / 1000 : 0 },
  };
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
  const it = pushItem({ type: "sig", wmode: wm, nw: wm === "signature" ? 0.3 : 0.5, ar: (g.h / g.w) || 0.3, svg: g.svg, dynamic: !traced, text, seed: seedVal(), autosave: wm === "signature" }, x, y);
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
// the handwriting seed box takes any text: a number is used as is, anything else ("Mom's card") becomes a number
function seedVal() { const t = String($("seed").value || "").trim(), n = parseLooseNumber(t); if (n != null) return Math.round(Math.abs(n)); let h = 2166136261; for (const ch of t) h = Math.imul(h ^ ch.codePointAt(0), 16777619) >>> 0; return h % 1e9; }
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
  host.innerHTML = docPages.map((p, i) => `<button class="thumb${i === curPage ? " cur" : ""}" data-page="${i}" title="Page ${i + 1}"><img data-pk="${p.key}" src="${thumbNow(p) || BLANK_PAGE}" alt="" style="aspect-ratio:${p.w}/${p.h}">${i + 1}</button>`).join("");
  host.querySelectorAll(".thumb").forEach((b) => b.onclick = () => setCurPage(+b.dataset.page, true));
  observeThumbs(host, host.closest(".rail") || null);
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
  if (edMode === "organize") { if (pw.on) renderPw(); else renderOrganize(); renderThumbs(); updateEdChrome(); renderProps(); if (holdSnap) scheduleSnapshot(); else snapshotNow(); return; }
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
    if (info.loadedName && !it.ffOverride) {
      // as in the PDF: its own letters as they are, anything they lack in the fallback's weight
      if (it.bold == null && it.italic == null && info.anyWeight) return { css: `"${info.anyWeight}", ${fb.css}`, weight: fb.weight, style: "normal", synth: true };
      return { css: `"${info.loadedName}", ${fb.css}`, weight: it.bold ? 700 : 400, style: it.italic ? "italic" : "normal", synth: !it.bold && !it.italic };
    }
    if (!it.ffOverride) return { css: fb.css, weight: it.bold != null ? (it.bold ? 700 : 400) : fb.weight, style: it.italic != null ? (it.italic ? "italic" : "normal") : fb.style };
  }
  const fe = fontByKey(it.ff); if (fe.google) ensureFont(fe.name);
  if (fe.user) return { css: fe.css, weight: it.bold != null ? (it.bold ? 700 : 400) : fe.weight, style: it.italic != null ? (it.italic ? "italic" : "normal") : fe.fstyle, synth: !!fe.family };
  return { css: fe.css, weight: it.bold ? 700 : 400, style: it.italic ? "italic" : "normal" };
}
const tboxDisplay = (it) => { const g = glyphInfo(it); return g ? toFontStr(g, it.text || "") : (it.text || ""); };
// The ascent / descent (in em) the browser really draws a font with: its first available face. A PDF's own
// numbers for a font often differ (0.75 in the text layer, 0.95 in the font file), and lining edited text
// up by the wrong one moves it off the line.
const fontMetricCache = new Map();
function cssFontMetrics(f) {
  const key = `${f.style} ${f.weight} 100px ${f.css}`;
  const hit = fontMetricCache.get(key); if (hit) return hit;
  measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
  measureCtx.font = key;
  const t = measureCtx.measureText("Hg"), m = { a: (t.fontBoundingBoxAscent || 90) / 100, d: (t.fontBoundingBoxDescent || 22) / 100 };
  let ready = false; try { ready = document.fonts.check(key, "Hg"); } catch (_) {}
  if (ready) fontMetricCache.set(key, m);   // not loaded yet: measured again once it is
  return m;
}
// Edited PDF text: one line exactly as tall as the font, moved so its baseline lands on the original one.
function teditLine(it, f, fsPx) {
  const m = cssFontMetrics(f);
  return { lh: (m.a + m.d) * fsPx, dy: ((it.asc || 0.86) - m.a) * fsPx };
}
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
    const f = tboxFont(it), fsPx = it.fs * dispW, pad = it.tedit ? 0 : Math.round(fsPx * 0.2), tl = it.tedit ? teditLine(it, f, fsPx) : null;
    el.innerHTML = `<div class="tbtext" style="font-family:${f.css.replace(/"/g, "&quot;")};font-size:${fsPx}px;font-weight:${f.weight};font-style:${f.style};${f.synth ? "font-synthesis:none;" : ""}line-height:${tl ? tl.lh + "px" : it.lh || 1.2};${tl && Math.abs(tl.dy) > 0.05 ? `transform:translateY(${tl.dy}px);` : ""}letter-spacing:${it.ls || 0}em;color:${itemColor(it)};background:${it.bg && it.bg !== "none" ? it.bg : "transparent"};text-align:${it.align || "left"};padding:${pad}px;white-space:${it.tedit ? "pre" : "pre-wrap"}">${escapeHTML(tboxDisplay(it))}</div>`;
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
// ---- alignment guides: while an object is dragged, a faint line shows when its edges or centre line up
// with another object, a line of the page's text or the middle of the page, and it snaps there.
// Hold Alt to move freely. The lines go away when the object is let go.
const textBlocksReady = new Map();   // page key:rot -> blocks (filled as pages' text is read)
function snapTargets(it, el, dispW, dispH) {
  const xs = [dispW / 2], ys = [dispH / 2], ov = el.parentNode;
  if (ov) for (const o of ov.querySelectorAll(".ditem")) {
    if (o === el || o.dataset.id === it.id) continue;
    const l = o.offsetLeft, t = o.offsetTop, w = o.offsetWidth, h = o.offsetHeight; if (!w && !h) continue;
    xs.push(l, l + w / 2, l + w); ys.push(t, t + h / 2, t + h);
  }
  const p = docPages[it.page || 0];
  if (p) {
    const ck = p.key + ":" + p.rot, bl = textBlocksReady.get(ck);
    if (bl) for (const b of bl) { xs.push(b.nx * dispW, (b.nx + b.nw) * dispW); ys.push(b.ny * dispH, (b.ny + b.nh) * dispH); }
    else if (docSources[p.src] && docSources[p.src].kind === "pdf") getTextBlocks(it.page || 0).then((v) => { textBlocksReady.set(ck, v || []); }).catch(() => {});
  }
  return { xs, ys };
}
function snapMove(it, el, tg, dispW, dispH, guides) {
  const T = 5, w = el.offsetWidth, h = el.offsetHeight, x = it.nx * dispW, y = it.ny * dispH;
  const best = (edges, targets) => { let bd = T + 1, off = 0, at = null; for (const [e, k] of edges) for (const t of targets) { const d = Math.abs(t - e); if (d < bd) { bd = d; off = t - e; at = t; } } return at == null ? null : { off, at }; };
  const sx = best([[x, 0], [x + w / 2, 1], [x + w, 2]], tg.xs), sy = best([[y, 0], [y + h / 2, 1], [y + h, 2]], tg.ys);
  if (sx) it.nx = (x + sx.off) / dispW;
  if (sy) it.ny = (y + sy.off) / dispH;
  guides.v.style.display = sx ? "" : "none"; if (sx) guides.v.style.left = Math.round(sx.at) + "px";
  guides.h.style.display = sy ? "" : "none"; if (sy) guides.h.style.top = Math.round(sy.at) + "px";
}
function startMove(it, el, e, dispW, dispH, wasSel, fromGrip) {
  try { el.setPointerCapture(e.pointerId); } catch (_) {}
  const sx = e.clientX, sy = e.clientY, ox = it.nx, oy = it.ny;
  let moved = false, tg = null, guides = null;
  const mv = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    if (!moved && el.parentNode) {
      tg = snapTargets(it, el, dispW, dispH);
      guides = { v: mk("div", { className: "snapg v" }), h: mk("div", { className: "snapg h" }) };
      guides.v.style.display = guides.h.style.display = "none"; el.parentNode.append(guides.v, guides.h);
    }
    moved = true;
    it.nx = Math.max(-0.1, Math.min(0.98, ox + (ev.clientX - sx) / dispW));
    it.ny = Math.max(-0.1, Math.min(0.98, oy + (ev.clientY - sy) / dispH));
    if (guides) { if (ev.altKey) guides.v.style.display = guides.h.style.display = "none"; else snapMove(it, el, tg, dispW, dispH, guides); }
    el.style.left = it.nx * dispW + "px"; el.style.top = it.ny * dispH + "px";
  };
  const up = (ev) => {
    el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up);
    if (guides) { guides.v.remove(); guides.h.remove(); guides = null; }
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
    // each box knows its field, so the form column can find it, and typing here shows up there
    const tagF = (el) => { el.dataset.fname = f.name; if (f.type === "radio") el.dataset.fval = String(f.value);
      el.addEventListener("focus", () => highlightFormRow(f.name)); el.addEventListener("input", syncFormColValues); el.addEventListener("change", syncFormColValues); };
    const x = f.nx * dispW, y = f.ny * dispH, w = f.nw * dispW, h = f.nh * dispH;
    if (f.type === "radio") {
      const rb = document.createElement("input"); rb.type = "radio"; rb.className = "dfield"; rb.name = "rf_" + f.name;
      rb.checked = fieldValues[f.name] === f.value; rb.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(14, h)}px;height:${Math.max(14, h)}px;margin:0`;
      rb.onchange = () => { if (rb.checked) { fieldValues[f.name] = f.value; scheduleSnapshot(); } };
      tagF(rb); ov.appendChild(rb);
    } else if (f.type === "choice") {
      const sl = document.createElement("select"); sl.className = "dfield";
      sl.appendChild(new Option("", ""));
      (f.options || []).forEach(([v, l]) => sl.appendChild(new Option(l, v)));
      sl.value = fieldValues[f.name] || "";
      sl.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${Math.min(h * 0.7, 16)}px`;
      sl.onchange = () => { fieldValues[f.name] = sl.value; scheduleSnapshot(); };
      sl.onkeydown = (ev) => ev.stopPropagation();
      tagF(sl); ov.appendChild(sl);
    } else if (f.type === "check") {
      const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "dfield";
      cb.checked = !!fieldValues[f.name]; cb.style.cssText = `left:${x}px;top:${y}px;width:${Math.max(14, h)}px;height:${Math.max(14, h)}px`;
      cb.onchange = () => { fieldValues[f.name] = cb.checked; scheduleSnapshot(); };
      tagF(cb); ov.appendChild(cb);
    } else {
      const inp = document.createElement("input"); inp.type = "text"; inp.className = "dfield";
      inp.value = fieldValues[f.name] || ""; inp.placeholder = f.name || "";
      inp.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;font-size:${Math.min(h * 0.7, 16)}px`;
      inp.oninput = () => { fieldValues[f.name] = inp.value; };
      inp.onchange = () => scheduleSnapshot();
      inp.onkeydown = (ev) => ev.stopPropagation();
      tagF(inp); ov.appendChild(inp);
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
  if (d.kind === "blur") {   // the page picture, blurred, seen only through the brush strokes
    const p = docPages[d.page || 0]; if (!d.pts || !d.pts.length || !p || !p.url) return "";
    const id = "b" + String(d.id).replace(/\W/g, "") + Math.round(W), px = Math.max(0.6, (d.blur ?? 8 / REF_W) * W);
    return `<defs><mask id="${id}m" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><path d="${drawGeom(d, W, H).path}" fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/></mask>` +
      `<filter id="${id}f" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse"><feGaussianBlur stdDeviation="${px.toFixed(2)}" edgeMode="duplicate"/></filter></defs>` +
      `<g mask="url(#${id}m)" opacity="${op}"><image href="${p.url}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" filter="url(#${id}f)"/></g>`;
  }
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
  const list = docDraws.filter((d) => (d.page || 0) === pi && (UNDER(d.kind) === under));
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
  if (kind === "blur") d.blur = (dd.strength || 8) / REF_W;
  const layer = ov.querySelector(UNDER(kind) ? "svg.drawunder" : "svg.drawlayer") || renderDraws(ov, dispW, dispH, pi, UNDER(kind));
  const g = document.createElementNS(SVGNS, "g"); layer.appendChild(g);
  const s = pt(e);
  if (FREEHAND(kind)) d.pts = [s]; else { d.x0 = s[0]; d.y0 = s[1]; d.x1 = s[0]; d.y1 = s[1]; }
  const redraw = () => { g.innerHTML = drawMarkup(d, dispW, dispH); };
  redraw();
  const mv = (ev) => { const p = pt(ev); if (FREEHAND(kind)) d.pts.push(p); else { d.x1 = p[0]; d.y1 = (kind === "underline" || kind === "strike") ? d.y0 : p[1]; } redraw(); };
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
// blur brush strokes: the page so far, blurred, painted back through the strokes (the export flattens the page,
// so what is under a blur is gone from the file, not just hidden)
function applyBlurDraws(ctx, W, H, pi) {
  const list = docDraws.filter((d) => d.kind === "blur" && (d.page || 0) === (pi || 0) && d.pts && d.pts.length);
  if (!list.length) return;
  const src = document.createElement("canvas"); src.width = W; src.height = H; src.getContext("2d").drawImage(ctx.canvas, 0, 0);
  for (const d of list) {
    const px = Math.max(1, (d.blur ?? 8 / REF_W) * W), b = document.createElement("canvas"); b.width = W; b.height = H; const g = b.getContext("2d");
    if ("filter" in g) { g.filter = `blur(${px.toFixed(1)}px)`; g.drawImage(src, 0, 0); g.filter = "none"; }
    if (!("filter" in g) || g.getImageData(Math.floor(W / 2), Math.floor(H / 2), 1, 1).data[3] === 0) {   // no canvas filters: shrink and grow back
      const k = Math.max(2, px), sm = document.createElement("canvas"); sm.width = Math.max(1, Math.round(W / k)); sm.height = Math.max(1, Math.round(H / k));
      const sg = sm.getContext("2d"); sg.imageSmoothingQuality = "high"; sg.drawImage(src, 0, 0, sm.width, sm.height); g.clearRect(0, 0, W, H); g.imageSmoothingQuality = "high"; g.drawImage(sm, 0, 0, W, H);
    }
    g.globalCompositeOperation = "destination-in"; g.lineCap = "round"; g.lineJoin = "round"; g.lineWidth = Math.max(1, d.size * W); g.strokeStyle = "#000";
    g.beginPath(); g.moveTo(d.pts[0][0] * W, d.pts[0][1] * H); for (let i = 1; i < d.pts.length; i++) g.lineTo(d.pts[i][0] * W, d.pts[i][1] * H); if (d.pts.length === 1) g.lineTo(d.pts[0][0] * W + 0.1, d.pts[0][1] * H); g.stroke();
    ctx.save(); ctx.globalAlpha = d.opacity ?? 1; ctx.drawImage(b, 0, 0); ctx.restore();
  }
}
const pageNeedsFlatten = (i) => docItems.some((it) => (it.page || 0) === i && it.type === "redact") || docDraws.some((d) => (d.page || 0) === i && d.kind === "blur");
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
  scheduleWorkSave();
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
  pw.on = ""; document.body.dataset.pw = "";
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
  if (t.startsWith("pw:")) { openPw(t.slice(3)); return; }
  if (t === "image") { setEdTool("select"); pickImageForDoc(); return; }
  if (t === "wm") { openWmPanel(); return; }
  if (t === "drawsig") { openDrawPad("sig"); return; }
  if (t === "fonts") { setEdTool("select"); openFontScan(); return; }
  if (t === "fillweb") { setEdTool("select"); openFillWebDialog(); return; }
  if (t === "formview") { setEdTool("select"); setFormCol(true); return; }
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
  sign: ["sign", "sig"], fillsign: ["sign", "text"], adddate: ["sign", "date"], forms: ["sign", "field:text"], fillform: ["sign", "formview"],
  write: ["sign", "handwrite"], handwrite: ["sign", "handwrite"], signature: ["sign", "sig", "signature"], sigimport: ["sign", "sig", "sigimport"],
  merge: ["organize", "pw:merge"], organize: ["organize"], rotate: ["organize"], delete: ["organize"], split: ["organize", "pw:split"], extract: ["organize", "pw:extract"], number: ["organize", "panel:number"],
  unwatermark: ["edit", "wm"], drawsig: ["sign", "drawsig"], pdffonts: ["edit", "fonts"],
  compress: ["convert", "panel:compress"], pdf2img: ["convert", "panel:img"], pdf2word: ["convert", "panel:pdfword"], fillweb: ["sign", "fillweb"], enhance: ["convert", "panel:enhance"], ocr: ["convert", "panel:ocr"], flatten: ["convert", "panel:flatten"],
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
const APPLY_RESULT = /^(watermarked|numbered|cropped|compressed|flattened|ocr|redacted|enhanced)\.pdf$/;
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
function fontPicker(value, hasPdf, onPick, matches) {
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
      if (matches && matches.length && !term) {   // recognised from how the text looks, best first
        list.appendChild(mk("h5", {}, "Closest matches"));
        for (const m of matches) {
          const fb = mk("button", { className: m.family === value ? "on" : "", title: `${m.family} — ${m.pct}% match` }); const fe = fontEntry(m.family);
          fb.innerHTML = `<span style="font-family:${fe ? fe.css.replace(/"/g, "'") : "inherit"};font-weight:${m.weight};font-style:${m.style}">${escapeHTML(m.family)}${m.weight >= 700 ? " Bold" : ""}${m.style === "italic" ? " Italic" : ""}</span><small style="float:right;font-family:inherit;font-size:11px;color:var(--muted);margin-top:4px">${m.pct}%</small>`;
          fb.onclick = () => { closePops(); onPick(m.family, m); }; list.appendChild(fb);
        }
      }
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
      if (!list.children.length) list.appendChild(mk("div", { className: "fl-none" }, "No fonts match “" + q.value.trim() + "”"));
    };
    q.oninput = build; q.onkeydown = (ev) => ev.stopPropagation();
    if (docSources.some((s) => s && s.kind === "pdf")) { const sb = mk("button", { className: "fscanbtn", type: "button" }, "Find & save this PDF's fonts…"); sb.onclick = () => { closePops(); openFontScan(); }; pop.appendChild(sb); }
    pop.prepend(q, list); pop.onpointerdown = (ev) => ev.stopPropagation();
    document.body.appendChild(pop);
    // a fixed height that fits on screen (below the button, else above it), so typing a search never resizes or moves it
    const r = b.getBoundingClientRect(), ph = Math.max(180, Math.min(420, innerHeight - 16));
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = r.top - 6 - ph >= 8 ? r.top - 6 - ph : Math.max(8, innerHeight - 8 - ph);
    pop.style.height = ph + "px";
    pop.style.left = Math.max(8, Math.min(innerWidth - 298, r.left)) + "px"; pop.style.top = (top + scrollY) + "px";
    popEl = pop; build(); q.focus({ preventScroll: true });
  };
  return b;
}

// ---- free-form entry: number boxes take "12", "12.5pt", "1,200", "50%", "10+2", "3/4"; ↑/↓ step ----------
function parseLooseNumber(txt) {
  let t = String(txt == null ? "" : txt).trim().toLowerCase().replace(/[$€£¥\s]/g, "").replace(/(\d),(?=\d{3}\b)/g, "$1").replace(/(pt|px|em|in|mm|cm|%|°|x|×)$/i, "");
  if (!t) return null;
  if (/^\(.*\)$/.test(t) && !/[+*/]/.test(t)) t = "-" + t.slice(1, -1);   // (12) = -12
  t = t.replace(/,/g, ".");                                                // 12,5 = 12.5
  if (!/^[\d.+\-*/()]+$/.test(t)) return null;
  let i = 0;                                                               // a tiny calculator, no eval
  const num = () => { if (t[i] === "(") { i++; const v = sum(); if (t[i] === ")") i++; return v; } if (t[i] === "-") { i++; return -num(); } if (t[i] === "+") { i++; return num(); } const m = /^\d*\.?\d+|^\d+\./.exec(t.slice(i)); if (!m) throw 0; i += m[0].length; return parseFloat(m[0]); };
  const prod = () => { let v = num(); while (t[i] === "*" || t[i] === "/") { const op = t[i++], r = num(); v = op === "*" ? v * r : v / r; } return v; };
  const sum = () => { let v = prod(); while (t[i] === "+" || t[i] === "-") { const op = t[i++], r = prod(); v = op === "+" ? v + r : v - r; } return v; };
  try { const v = sum(); return i === t.length && isFinite(v) ? v : null; } catch (_) { return null; }
}
function numBox(value, min, max, step, onChange, title) {
  const n = mk("input", { type: "text", value: String(value), title: (title || "") + " — type a number, or use ↑ ↓", className: "numbox", autocomplete: "off", spellcheck: false });
  n.inputMode = "decimal"; let last = +value;
  const clamp = (v) => Math.max(min, Math.min(max, v));
  const commit = () => { const v = parseLooseNumber(n.value); if (v == null) { n.value = String(last); n.classList.add("bad"); setTimeout(() => n.classList.remove("bad"), 900); return; } const c = clamp(Math.round(v * 1000) / 1000); last = c; n.value = String(c); onChange(c); };
  n.onchange = commit;
  n.oninput = () => { const v = parseLooseNumber(n.value); if (v != null && v >= min && v <= max && /\d$/.test(n.value.trim())) { last = v; onChange(v); } };
  n.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { commit(); n.blur(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const cur = parseLooseNumber(n.value); const v = clamp(Math.round(((cur == null ? last : cur) + (e.key === "ArrowUp" ? 1 : -1) * (step || 1) * (e.shiftKey ? 10 : 1)) * 1000) / 1000); last = v; n.value = String(v); onChange(v); }
  };
  n.onfocus = () => n.select();
  return n;
}
// free-form dates: 9/15/2026, 9/15/26, 2026-09-15, 09152026, Sep 15 2026, 15 September 2026, today, tomorrow, +30 -> "YYYY-MM-DD"
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseLooseDate(txt, base = new Date()) {
  const t = String(txt || "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/,/g, " ").replace(/\s+/g, " ");
  if (!t) return null;
  const iso = (y, m, d) => { const dt = new Date(y, m - 1, d); return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? `${y}-${pad2(m)}-${pad2(d)}` : null; };
  const fromDate = (dt) => iso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  const yy = (y) => (y < 100 ? (y + 2000 > base.getFullYear() + 20 ? y + 1900 : y + 2000) : y);
  if (t === "today" || t === "now") return fromDate(base);
  if (t === "tomorrow") return fromDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1));
  if (t === "yesterday") return fromDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1));
  let m = t.match(/^([+-])\s*(\d+)\s*(d|days?|w|weeks?|m|months?)?$/);
  if (m) { const k = (m[1] === "-" ? -1 : 1) * +m[2], u = (m[3] || "d")[0]; return fromDate(u === "w" ? new Date(base.getFullYear(), base.getMonth(), base.getDate() + 7 * k) : u === "m" ? new Date(base.getFullYear(), base.getMonth() + k, base.getDate()) : new Date(base.getFullYear(), base.getMonth(), base.getDate() + k)); }
  if ((m = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return iso(+m[1], +m[2], +m[3]);
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) return iso(yy(+m[3]), +m[1], +m[2]);
  if ((m = t.match(/^(\d{1,2})[-/.](\d{1,2})$/))) return iso(base.getFullYear(), +m[1], +m[2]);
  if ((m = t.match(/^(\d{2})(\d{2})(\d{4})$/))) return iso(+m[3], +m[1], +m[2]);
  if ((m = t.match(/^(\d{4})(\d{2})(\d{2})$/))) return iso(+m[1], +m[2], +m[3]);
  const FULL = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const mon = (w) => { if (w.length < 3) return 0; const i = FULL.findIndex((n) => n.indexOf(w) === 0); return i >= 0 ? i + 1 : w === "sept" ? 9 : 0; };   // a real month name or its start ("junk" is not June)
  if ((m = t.match(/^([a-z]{3,})\.? (\d{1,2})(?: (\d{2}|\d{4}))?$/)) && mon(m[1])) return iso(m[3] ? yy(+m[3]) : base.getFullYear(), mon(m[1]), +m[2]);
  if ((m = t.match(/^(\d{1,2}) ([a-z]{3,})\.?(?: (\d{2}|\d{4}))?$/)) && mon(m[2])) return iso(m[3] ? yy(+m[3]) : base.getFullYear(), mon(m[2]), +m[1]);
  return null;
}
// free-form times: 3pm, 3:30 pm, 15:30, 1530, noon, now -> "HH:MM"
function parseLooseTime(txt, base = new Date()) {
  const t = String(txt || "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!t) return null;
  if (t === "now") return `${pad2(base.getHours())}:${pad2(base.getMinutes())}`;
  if (t === "noon") return "12:00"; if (t === "midnight") return "00:00";
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/); if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0), ap = m[3];
  if (ap) { if (h < 1 || h > 12) return null; if (ap[0] === "p" && h < 12) h += 12; if (ap[0] === "a" && h === 12) h = 0; }
  return h < 24 && mi < 60 ? `${pad2(h)}:${pad2(mi)}` : null;
}
const showDate = (iso) => { const [y, m, d] = String(iso || "").split("-").map(Number); return y ? `${m}/${d}/${y}` : ""; };
const showTime = (hm) => { let [h, mi] = String(hm || "").split(":").map(Number); if (isNaN(h)) return ""; const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${pad2(mi || 0)} ${ap}`; };
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
    add(pcell(fontPicker(info && !it.ffOverride ? "__pdf" : fontByKey(it.ff).name, !!info, (v, m) => {
      if (v === "__pdf") it.ffOverride = false;
      else { it.ff = v; if (info) it.ffOverride = true; if (!it.tedit) TD.text.ff = v; ensureFont(v); if (m) { it.bold = m.weight >= 700; it.italic = m.style === "italic"; } }
      propsSig = ""; render();
    }, it.fontMatches)));
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
    // typed dates and times in any common form ("9/15/26", "Sep 15", "today", "3pm"); the calendar button still works
    const dI = mk("input", { type: "text", value: showDate(it.date), title: "Date — e.g. 9/15/2026, Sep 15 2026, today, +30", className: "datebox", autocomplete: "off" });
    const tI = mk("input", { type: "text", value: showTime(it.time), title: "Time — e.g. 3:30 pm, 15:30, now", className: "timebox", autocomplete: "off" });
    const cal = mk("input", { type: "date", value: it.date || "", className: "calpick", tabIndex: -1, title: "Pick from a calendar" });
    const calB = pbtn('<svg class="i" viewBox="0 0 20 20"><rect x="3" y="4.5" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/></svg>', false, () => { try { cal.showPicker(); } catch (_) { cal.click(); } }, "Pick from a calendar");
    const zones = TZ_LIST.includes(localTzAbbr()) ? TZ_LIST : [localTzAbbr(), ...TZ_LIST];
    const zS = selBox(zones.map((z) => [z, z]), it.tz || "UTC", () => apply(), "Time zone");
    const apply = () => { it.tz = zS.value || it.tz; it.text = fmtDocuSign(it.date, it.time, it.tz); render(); };
    const typed = (inp, parse, show, key) => { const v = parse(inp.value); inp.classList.toggle("bad", v == null && inp.value.trim() !== ""); if (v != null) { it[key] = v; apply(); } return v; };
    dI.oninput = () => { if (parseLooseDate(dI.value)) typed(dI, parseLooseDate, showDate, "date"); else dI.classList.remove("bad"); };
    dI.onchange = () => { if (typed(dI, parseLooseDate, showDate, "date") != null) dI.value = showDate(it.date); else dI.value = showDate(it.date); };
    tI.oninput = () => { if (parseLooseTime(tI.value)) typed(tI, parseLooseTime, showTime, "time"); };
    tI.onchange = () => { typed(tI, parseLooseTime, showTime, "time"); tI.value = showTime(it.time); };
    cal.onchange = () => { if (cal.value) { it.date = cal.value; dI.value = showDate(it.date); apply(); } };
    dI.onkeydown = tI.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") e.target.blur(); };
    add(pcell(dI, calB, cal, tI, zS));
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
  if (d && d.kind === "blur") {
    add(pcell(mk("span", { title: "Brush width" }, ICON_LW), numBox(Math.round(d.size * REF_W), 4, 120, 1, (v) => { d.size = v / REF_W; TD.blur.width = v; render(); }, "Brush width")));
    add(pcell(mk("label", {}, "Blur"), numBox(Math.round((d.blur ?? 8 / REF_W) * REF_W), 1, 40, 1, (v) => { d.blur = v / REF_W; TD.blur.strength = v; render(); }, "Blur strength")));
    add(mk("div", { className: "phint" }, "Blur — the area is blurred in the download and the page is flattened, so the text under it can't be copied back out."));
    add(dupDel()); return;
  }
  if (d) {
    add(pcell(colorBtn(d.color, false, (c) => { d.color = c; drawDefaults(d.kind).color = c; render(); }, "Colour")));
    add(pcell(mk("span", { title: "Width" }, ICON_LW), numBox(Math.round(d.size * REF_W / (d.kind === "highlight" ? 5 : 1)), 1, 40, 1, (v) => { d.size = (d.kind === "highlight" ? v * 5 : v) / REF_W; render(); }, "Width")));
    add(opacityCell(() => d.opacity ?? 1, (v) => { d.opacity = v; })); add(dupDel()); return;
  }
  // nothing selected: options for the active tool
  if (t === "blur") {
    add(pcell(mk("span", { title: "Brush width" }, ICON_LW), numBox(TD.blur.width, 4, 120, 1, (v) => { TD.blur.width = v; }, "Brush width")));
    add(pcell(mk("label", {}, "Blur"), numBox(TD.blur.strength, 1, 40, 1, (v) => { TD.blur.strength = v; }, "Blur strength")));
    add(mk("div", { className: "phint" }, "Paint over anything you want to blur — names, numbers, faces."));
  } else if (DRAW_TOOLS.has(t)) {
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
  recognizeDoc(loadToken).catch(() => {});
}

// ---- document recognition: a document that looks like one edited before (even a different file) is offered
// the same edits. A fingerprint = the first page's layout (a small grey picture) + the words on it.
let docFp = null;   // Promise<fingerprint> for the open document
function fingerprintDoc() {
  if (docFp) return docFp;
  docFp = (async () => {
    const p = await ensurePageImage(0); if (!p || !p.img) return null;
    const GW = 24, GH = 32, c = document.createElement("canvas"); c.width = GW; c.height = GH;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, GW, GH); g.drawImage(p.img, 0, 0, GW, GH);
    const px = g.getImageData(0, 0, GW, GH).data, gray = [];
    for (let i = 0; i < px.length; i += 4) gray.push(Math.round(px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11));
    let words = [];
    try {
      const src = docSources[docPages[0].src];
      if (src && src.pdf) { const tc = await (await src.pdf.getPage(docPages[0].idx + 1)).getTextContent(); words = tc.items.map((t) => t.str).join(" ").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []; }
    } catch (_) {}
    return { gray, words: [...new Set(words)].slice(0, 400), aspect: +(p.w / p.h).toFixed(3), pages: docPages.length };
  })();
  return docFp;
}
function fpCorr(a, b) {   // layout likeness, -1..1
  const n = Math.min(a.length, b.length); if (!n) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}
function fpMatch(a, b) {
  if (!a || !b || Math.abs(a.aspect - b.aspect) > 0.04) return 0;
  const corr = fpCorr(a.gray, b.gray);
  if (a.words.length >= 15 && b.words.length >= 15) {
    const B = new Set(b.words); let both = 0; for (const w of a.words) if (B.has(w)) both++;
    const jac = both / (a.words.length + b.words.length - both);
    return jac >= 0.7 ? Math.max(jac, corr) : jac >= 0.4 && corr >= 0.5 ? (jac + corr) / 2 : 0;
  }
  return corr >= 0.9 ? corr : 0;   // pictures / scans: the layout alone
}
async function recognizeDoc(token) {
  const fp = await fingerprintDoc(); if (!fp || token !== loadToken) return;
  const mem = await listMemory(); let best = null, score = 0;
  for (const m of mem) { if (m.ignore || m.id === docRecentId) continue; const s = fpMatch(fp, m.fp); if (s > score) { score = s; best = m; } }
  if (!best || token !== loadToken || docItems.length || docDraws.length) return;
  showRecognized(best, token);
}
function showRecognized(m, token) {
  document.getElementById("recog")?.remove();
  const n = (m.items || []).length + (m.draws || []).length + Object.keys(m.fields || {}).length;
  const when = new Date(m.ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  const bar = mk("div", { id: "recog", className: "recog" });
  bar.innerHTML = `<div><b>This looks like “${escapeHTML(m.name)}”</b>, which you edited on ${when}. Apply the same ${n} edit${n === 1 ? "" : "s"}?</div>` +
    `<div class="recog-b"><button class="btn primary" data-r="apply">Apply edits</button><button class="btn" data-r="no">Not now</button><button class="linkbtn" data-r="never" title="Don't suggest this one again">Don't suggest it</button></div>`;
  bar.onclick = async (e) => {
    const a = e.target.closest("[data-r]")?.dataset.r; if (!a) return; bar.remove();
    if (a === "never") { m.ignore = true; await saveMemory(m); toast("It won't be suggested again."); }
    if (a === "apply" && token === loadToken) applyRemembered(m);
  };
  document.body.appendChild(bar);
  setTimeout(() => bar.classList.add("on"), 20);
}
function applyRemembered(m) {
  const np = docPages.length, num = (s) => +String(s || "").replace(/\D+/g, "") || 0;
  const items = (m.items || []).filter((it) => (it.page || 0) < np).map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: "it" + itemSeq++ }));
  const draws = (m.draws || []).filter((d) => (d.page || 0) < np).map((d) => ({ ...JSON.parse(JSON.stringify(d)), id: "dr" + drawSeq++ }));
  const names = new Set(docPages.flatMap((p) => (p.fields || []).map((f) => f.name)));
  let nf = 0; for (const [k, v] of Object.entries(m.fields || {})) if (!names.size || names.has(k)) { fieldValues[k] = v; nf++; }
  docItems.push(...items); docDraws.push(...draws);
  itemSeq = Math.max(itemSeq, ...docItems.map((it) => num(it.id) + 1)); drawSeq = Math.max(drawSeq, ...docDraws.map((d) => num(d.id) + 1));
  render(); snapshotNow();
  const tot = items.length + draws.length + nf; toast(`Applied ${tot} edit${tot === 1 ? "" : "s"} from ${m.name} - check them, Undo takes them all back.`);
}
// remember what was done to this document (called with the recent-file save)
async function rememberEdits(work) {
  if (!work) return;
  const fp = await fingerprintDoc().catch(() => null); if (!fp) return;
  const id = "m" + (docRecentId || docName);
  const old = (await listMemory()).find((x) => x.id === id);
  await saveMemory({ id, name: docName, ts: Date.now(), fp, items: work.items, draws: work.draws, fields: work.fields, ignore: old ? old.ignore : false });
}
async function openDocBytes(u8, name, kind) {
  errEl.textContent = "";
  toast("Opening " + (name || "document") + "…");
  const token = ++loadToken;
  docName = name || "document"; docRecentId = null; clearTimeout(workTimer); docFp = null; document.getElementById("recog")?.remove();
  docSources = []; docPages = []; docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {};
  pagesSig = ""; curPage = 0; edZoom = 1; orgSel.clear(); textBlocks.clear(); ocrBlocks.clear(); closePanelTool();
  pw.on = ""; pw.sel.clear(); pw.cuts.clear(); document.body.dataset.pw = "";   // a new document starts outside Merge / Split
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
  if (docRecentId) saveWorkNow().catch(() => {});   // closing keeps the latest edits with the recent file
  docRecentId = null;
  loadToken++;
  doc = null; docSources = []; docPages = []; pagesSig = ""; curPage = 0;
  docItems = []; docDraws = []; selId = null; selDraw = null; fieldValues = {}; edTool = "select"; orgSel.clear(); textBlocks.clear(); ocrBlocks.clear();
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
  const id = await saveRecent({ name, type: type === "application/pdf" ? "pdf" : "image", bytes: u8, thumb });
  if (id && docName === name && !docRecentId) docRecentId = id;   // edits to this document are kept with it from now on
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
    row.innerHTML = `${r.thumb ? `<img src="${r.thumb}" alt="">` : '<span class="noimg"></span>'}<span>${escapeHTML(r.name)}${r.work ? '<span class="redt">· edited</span>' : ""}</span><button class="radd" title="Add its pages to this document">+</button>`;
    row.onclick = (e) => { if (e.target.closest(".radd")) return; reopenRecent(r); };
    row.querySelector(".radd").onclick = (e) => { e.stopPropagation(); addRecentToDoc(r.id); };
    host.appendChild(row);
  }
}
async function reopenRecent(rec) {
  const full = await getRecent(rec.id); if (!full) return;
  try {
    await openRecentDoc(full);
    if (!location.hash.startsWith("#/edit")) location.hash = "#/edit";
  } catch (e) { errEl.textContent = "Could not reopen: " + (e.message || e); }
}

// ---- recent documents keep their work: edits, page order, turned pages and filled fields -------------
let docRecentId = null, workTimer = 0;
function scheduleWorkSave() { if (!docRecentId || restoring) return; clearTimeout(workTimer); workTimer = setTimeout(() => saveWorkNow().catch(() => {}), 1200); }
// plain data only: no pictures already drawn, no page objects, no "_" helpers
const plainData = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k && k[0] === "_") || (x && typeof x === "object" && (x instanceof Element || (typeof ImageBitmap !== "undefined" && x instanceof ImageBitmap))) ? undefined : x));
async function saveWorkNow() {
  clearTimeout(workTimer);
  const id = docRecentId; if (!id || !doc || !docSources.length) return;
  const work = {
    v: 1, name: docName, ts: Date.now(), cur: curPage,
    sources: docSources.map((s, i) => ({ name: s.name, kind: s.kind, bytes: i === 0 ? null : s.bytes })),   // the first file is the recent entry's own bytes
    pages: docPages.map((p) => ({ src: p.src, idx: p.idx, rot: p.rot || 0, w: p.w, h: p.h })),
    items: plainData(docItems), draws: plainData(docDraws), fields: plainData(fieldValues),
  };
  const edited = work.items.length || work.draws.length || Object.keys(work.fields).length || work.sources.length > 1 ||
    work.pages.some((p, i) => p.src !== 0 || p.idx !== i || p.rot) || work.pages.length !== (docSources[0].pdf ? docSources[0].pdf.numPages : 1);
  await saveRecentWork(id, edited ? work : null);
  if (edited && (work.items.length || work.draws.length || Object.keys(work.fields).length)) rememberEdits(work).catch(() => {});
  refreshRecentLists();
}
// Open a recent entry; when it holds saved work, put everything back the way it was left.
async function openRecentDoc(full) {
  const kind = full.type === "pdf" ? "pdf" : "image", w = full.work;
  await openDocBytes(new Uint8Array(full.bytes), (w && w.name) || full.name, kind);
  if (w && w.pages && w.pages.length) {
    try {
      for (let i = 1; i < (w.sources || []).length; i++) { const s = w.sources[i]; if (s && s.bytes) await addSource(new Uint8Array(s.bytes), s.name, s.kind); }
      const pages = w.pages.filter((p) => docSources[p.src]).map((p) => {
        const src = docSources[p.src], img = src.kind === "image" && !p.rot;
        return { src: p.src, idx: p.idx, rot: p.rot || 0, img: img ? src.img : null, w: p.w, h: p.h, url: img ? src.url : BLANK_PAGE, fields: [], key: nextKey() };
      });
      if (pages.length) {
        docPages = pages;
        docItems = (w.items || []).filter((it) => (it.page || 0) < pages.length);
        docDraws = (w.draws || []).filter((d) => (d.page || 0) < pages.length);
        fieldValues = w.fields || {};
        const num = (s) => +String(s || "").replace(/\D+/g, "") || 0;
        itemSeq = Math.max(itemSeq, ...docItems.map((it) => num(it.id) + 1)); drawSeq = Math.max(drawSeq, ...docDraws.map((d) => num(d.id) + 1));
        curPage = Math.max(0, Math.min(w.cur || 0, docPages.length - 1));
        await ensurePageImage(curPage); doc = docPages[curPage];
        pagesSig = ""; textBlocks.clear(); ocrBlocks.clear(); resetHistory(); render(); renderPagesInBackground(loadToken);
        toast(`Reopened ${docName} with your edits.`);
      }
    } catch (e) { toast("Your saved edits could not be restored: " + (e.message || e)); }
  }
  docRecentId = full.id;
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
  const blurF = sp.blur > 0 ? `blur(${sp.blur * (c.width / 800)}px)` : "";
  // colorspace + brightness + contrast (+ sepia) as one CSS filter string
  const filt = [];
  if (sp.on) {
    if (sp.cspace === "gray") filt.push("grayscale(1)");
    else if (sp.cspace === "bw" || sp.cspace === "bilevel") filt.push("grayscale(1)", "contrast(2.2)", "brightness(1.05)");
    filt.push(`brightness(${sp.bright.toFixed(3)})`, `contrast(${sp.contrast.toFixed(3)})`);
    if (sp.yellow > 0) filt.push(`sepia(${(sp.yellow * 0.7).toFixed(3)})`);
  }
  // Each filtered redraw goes through ONE scratch copy of the page (it used to allocate a new full-size
  // canvas per pass). Blur and colour are applied in a single draw unless sharpening has to sit between them.
  let scratch = null;
  const redraw = (filter) => {
    if (!filter) return;
    if (!scratch) { scratch = document.createElement("canvas"); scratch.width = c.width; scratch.height = c.height; }
    const sx = scratch.getContext("2d"); sx.clearRect(0, 0, c.width, c.height); sx.drawImage(c, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height); ctx.filter = filter; ctx.drawImage(scratch, 0, 0); ctx.filter = "none";
  };
  if (sp.sharp > 0) {
    redraw(blurF);
    unsharp(ctx, c.width, c.height, sp.sharp);
    redraw(filt.join(" "));
  } else redraw([blurF, ...filt].filter(Boolean).join(" "));
  if (scratch) scratch.width = scratch.height = 0;
  if (!sp.on) return c;

  if (sp.yellow > 0) { ctx.save(); ctx.globalCompositeOperation = "multiply"; ctx.fillStyle = `rgba(255,244,196,${(sp.yellow * 0.5).toFixed(3)})`; ctx.fillRect(0, 0, c.width, c.height); ctx.restore(); }
  if (sp.noise > 0) scanNoise(ctx, c.width, c.height, sp.noise);
  scanBlemish(ctx, c.width, c.height, sp.blem);
  if (sp.border) { ctx.save(); const bw = Math.max(4, c.width * 0.006); ctx.strokeStyle = "rgba(22,19,14,0.9)"; ctx.lineWidth = bw; ctx.strokeRect(bw / 2, bw / 2, c.width - bw, c.height - bw); ctx.restore(); }

  const ang = scanAngle(sp) * Math.PI / 180;
  if (Math.abs(ang) > 0.0005) return rotateCanvas(c, ang);
  return c;
}
// Salt-and-pepper scanner grain. The same density of random black/white pixels as before, but drawn
// from a cached tile as a pattern: no full-page getImageData/putImageData read-back (that cost
// ~150 ms per 300-dpi page and blocked the UI). "source-atop" keeps see-through areas untouched,
// like the old pixel loop did.
const NOISE_TILE = 509;   // a prime size, so the repeat doesn't line up with page features
const noiseTiles = new Map();
function noiseTile(density) {
  const key = Math.round(density * 1e4);
  if (noiseTiles.has(key)) return noiseTiles.get(key);
  const t = document.createElement("canvas"); t.width = t.height = NOISE_TILE;
  const g = t.getContext("2d"), img = g.createImageData(NOISE_TILE, NOISE_TILE), d = img.data;
  const count = Math.floor(NOISE_TILE * NOISE_TILE * density);
  for (let i = 0; i < count; i++) {
    const idx = Math.floor(Math.random() * NOISE_TILE * NOISE_TILE) * 4, v = Math.random() > 0.5 ? 255 : 0;
    d[idx] = v; d[idx + 1] = v; d[idx + 2] = v; d[idx + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  if (noiseTiles.size > 8) noiseTiles.clear();
  noiseTiles.set(key, t); return t;
}
function scanNoise(ctx, w, h, amount) {
  const density = Math.min(amount / 240, 0.45) * 0.08;
  if (density <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  const ox = Math.floor(Math.random() * NOISE_TILE), oy = Math.floor(Math.random() * NOISE_TILE);   // a different grain on every page
  ctx.translate(-ox, -oy);
  ctx.fillStyle = ctx.createPattern(noiseTile(density), "repeat");
  ctx.fillRect(ox, oy, w, h);
  ctx.restore();
}
// Rotate a canvas by `ang` radians, expanding the frame and filling white.
// ---- looks beyond the scanner: straighten, wrinkles, folds, photographed, on a countertop ------------------
const hasExtras = (sp) => !!(sp && (sp.straighten || sp.wrinkles > 0 || sp.folds > 0 || (sp.photo && sp.photo !== "none")));
function seeded(seed) { let x = (seed >>> 0) || 1; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296; }
// The page as it will be saved with the chosen look, trimmed back to the page's own size.
async function lookPage(i, res) {
  const sp = scanParams();
  let c = await composePage(i, res, "all", { sharp: true });
  if (sp.straighten) c = straightenCanvas(c);
  c = finishCanvas(c);
  const W0 = Math.round(docPages[i].w * res), H0 = Math.round(docPages[i].h * res);
  if (c.width !== W0 || c.height !== H0) { const t = document.createElement("canvas"); t.width = W0; t.height = H0; const g = t.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W0, H0); g.drawImage(c, (W0 - c.width) / 2, (H0 - c.height) / 2); c = t; }
  return extraLook(c, sp, i);
}
// Straighten a tilted page: the angle whose rows of ink line up best (sharpest row profile), -7..7 degrees.
function straightenCanvas(c) {
  const sc = Math.min(1, 700 / c.width), w = Math.max(1, Math.round(c.width * sc)), h = Math.max(1, Math.round(c.height * sc));
  const t = document.createElement("canvas"); t.width = w; t.height = h; const g = t.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(c, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, pts = [];
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const k = (y * w + x) * 4; if (d[k] * 0.3 + d[k + 1] * 0.59 + d[k + 2] * 0.11 < 140) pts.push(x - w / 2, y - h / 2); }
  if (pts.length < 200) return c;
  const step = Math.max(2, Math.floor(pts.length / 40000) * 2), score = (deg) => {
    const a = deg * Math.PI / 180, sn = Math.sin(a), cs = Math.cos(a), rows = new Float32Array(h * 2);
    for (let k = 0; k < pts.length; k += step) { const yy = Math.round(-pts[k] * sn + pts[k + 1] * cs + h); if (yy >= 0 && yy < rows.length) rows[yy]++; }
    let s2 = 0; for (let k = 0; k < rows.length; k++) s2 += rows[k] * rows[k]; return s2;
  };
  let best = 0, bs = score(0);
  for (let deg = -7; deg <= 7.001; deg += 0.5) { const v = score(deg); if (v > bs) { bs = v; best = deg; } }
  for (let deg = best - 0.5; deg <= best + 0.5; deg += 0.1) { const v = score(deg); if (v > bs) { bs = v; best = deg; } }
  if (Math.abs(best) < 0.1) return c;
  const o = document.createElement("canvas"); o.width = c.width; o.height = c.height; const ox = o.getContext("2d");
  ox.fillStyle = "#fff"; ox.fillRect(0, 0, o.width, o.height); ox.translate(o.width / 2, o.height / 2); ox.rotate(best * Math.PI / 180); ox.drawImage(c, -c.width / 2, -c.height / 2);
  return o;
}
function extraLook(c, sp, pageIndex) {
  if (!hasExtras(sp) || (!sp.wrinkles && !sp.folds && (!sp.photo || sp.photo === "none"))) return c;
  const W = c.width, H = c.height, rnd = seeded((sp.seed || 1) * 7919 + pageIndex * 104729), g = c.getContext("2d");
  // wrinkles and folds: a light map (grey = no change) laid over the page with "overlay"
  if (sp.wrinkles > 0 || sp.folds > 0) {
    const s = 0.25, lw = Math.max(8, Math.round(W * s)), lh = Math.max(8, Math.round(H * s));
    const L = document.createElement("canvas"); L.width = lw; L.height = lh; const l = L.getContext("2d");
    l.fillStyle = "rgb(128,128,128)"; l.fillRect(0, 0, lw, lh);
    const wr = Math.min(1, sp.wrinkles || 0);
    for (let k = 0; k < Math.round(4 + wr * 10); k++) {   // soft dents
      const x = rnd() * lw, y = rnd() * lh, r = (0.08 + rnd() * 0.25) * lw, light = rnd() < 0.5, gr = l.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, light ? `rgba(255,255,255,${0.35 * wr})` : `rgba(0,0,0,${0.35 * wr})`); gr.addColorStop(1, "rgba(128,128,128,0)");
      l.fillStyle = gr; l.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let k = 0; k < Math.round(wr * 26); k++) {   // creases: a highlight with a shadow beside it
      let x = rnd() * lw, y = rnd() * lh, a = rnd() * Math.PI * 2; const len = (0.1 + rnd() * 0.45) * lw, segs = 8, pts = [[x, y]];
      for (let j = 0; j < segs; j++) { a += (rnd() - 0.5) * 0.9; x += Math.cos(a) * len / segs; y += Math.sin(a) * len / segs; pts.push([x, y]); }
      const wd = Math.max(1, lw * 0.003 * (0.6 + rnd()));
      [["rgba(255,255,255,", 0], ["rgba(0,0,0,", wd * 1.4]].forEach(([col, off]) => {
        l.beginPath(); pts.forEach(([px, py], j) => (j ? l.lineTo(px + off, py + off) : l.moveTo(px + off, py + off)));
        l.strokeStyle = col + (0.55 * wr).toFixed(3) + ")"; l.lineWidth = wd; l.lineCap = "round"; l.lineJoin = "round"; l.stroke();
      });
    }
    const nf = Math.round(sp.folds || 0);   // folds: like a letter folded in three, then in half
    const lines = nf >= 1 ? [["h", 1 / 3]] : []; if (nf >= 2) lines.push(["h", 2 / 3]); if (nf >= 3) lines.push(["v", 1 / 2]);
    lines.forEach(([dir, at]) => {
      const p = dir === "h" ? at * lh : at * lw, band = (dir === "h" ? lh : lw) * 0.035, gr = dir === "h" ? l.createLinearGradient(0, p - band, 0, p + band) : l.createLinearGradient(p - band, 0, p + band, 0);
      gr.addColorStop(0, "rgba(128,128,128,0)"); gr.addColorStop(0.45, "rgba(255,255,255,0.45)"); gr.addColorStop(0.5, "rgba(0,0,0,0.6)"); gr.addColorStop(0.6, "rgba(40,40,40,0.35)"); gr.addColorStop(1, "rgba(128,128,128,0)");
      l.fillStyle = gr; if (dir === "h") l.fillRect(0, p - band, lw, band * 2); else l.fillRect(p - band, 0, band * 2, lh);
    });
    g.save(); g.globalCompositeOperation = "overlay"; g.imageSmoothingQuality = "high"; g.filter = "blur(" + (W * 0.0008).toFixed(2) + "px)"; g.drawImage(L, 0, 0, W, H); g.restore();
  }
  if (!sp.photo || sp.photo === "none") return c;
  // photographed: the page seen by a phone camera - slightly keystoned, turned, shadowed and lit, on a desk or a countertop
  const counter = sp.photo === "counter", O = document.createElement("canvas"); O.width = W; O.height = H; const o = O.getContext("2d");
  if (counter) {
    const tones = [[214, 206, 192], [176, 172, 165], [62, 60, 58], [232, 228, 222], [139, 112, 86]], t = tones[Math.floor(rnd() * tones.length)];
    o.fillStyle = `rgb(${t[0]},${t[1]},${t[2]})`; o.fillRect(0, 0, W, H);
    for (let k = 0; k < 2600; k++) { const v = rnd() < 0.5 ? 0 : 255; o.fillStyle = `rgba(${v},${v},${v},${(0.04 + rnd() * 0.12).toFixed(3)})`; const r = W * (0.001 + rnd() * 0.004); o.fillRect(rnd() * W, rnd() * H, r, r); }
    for (let k = 0; k < 7; k++) { o.beginPath(); let x = rnd() * W, y = rnd() * H; o.moveTo(x, y); for (let j = 0; j < 4; j++) o.quadraticCurveTo(x + (rnd() - 0.5) * W * 0.6, y + (rnd() - 0.5) * H * 0.4, x += (rnd() - 0.5) * W * 0.5, y += (rnd() - 0.2) * H * 0.3); o.strokeStyle = `rgba(255,255,255,${(0.05 + rnd() * 0.08).toFixed(3)})`; o.lineWidth = W * (0.001 + rnd() * 0.004); o.stroke(); }
  } else {
    const gr = o.createLinearGradient(0, 0, W, H); gr.addColorStop(0, "#5a4d42"); gr.addColorStop(1, "#2e2823"); o.fillStyle = gr; o.fillRect(0, 0, W, H);
  }
  // keystone: the far edge of the page is a little narrower
  const k = Math.min(0.2, (sp.perspective || 0) * 0.16), P = document.createElement("canvas"); P.width = W; P.height = H; const pctx = P.getContext("2d"), strips = 160;
  for (let j = 0; j < strips; j++) { const sy = j * H / strips, sh = H / strips + 1, wj = W * (1 - k * (1 - j / strips)); pctx.drawImage(c, 0, sy, W, sh, (W - wj) / 2, sy, wj, sh); }
  const scale = counter ? 0.8 : 0.93, ang = ((rnd() - 0.5) * (counter ? 7 : 2.5) + (sp.rotate || 0)) * Math.PI / 180;
  o.save(); o.translate(W / 2 + (rnd() - 0.5) * W * (counter ? 0.05 : 0.01), H / 2 + (rnd() - 0.5) * H * (counter ? 0.04 : 0.01)); o.rotate(ang); o.scale(scale, scale);
  const sh = Math.min(1, sp.shadow || 0); o.shadowColor = `rgba(0,0,0,${(0.25 + 0.45 * sh).toFixed(3)})`; o.shadowBlur = W * (0.01 + 0.03 * sh); o.shadowOffsetX = W * 0.008 * sh; o.shadowOffsetY = W * 0.014 * sh;
  o.drawImage(P, -W / 2, -H / 2); o.restore();
  // light: a brighter corner, darker edges (vignette), warm cast, a little softness
  const lt = Math.min(1, sp.light || 0), lx = rnd() < 0.5 ? W * 0.15 : W * 0.85, ly = H * (0.1 + rnd() * 0.2);
  const hi = o.createRadialGradient(lx, ly, 0, lx, ly, Math.max(W, H) * 0.9); hi.addColorStop(0, `rgba(255,250,240,${(0.18 * lt).toFixed(3)})`); hi.addColorStop(1, "rgba(255,250,240,0)");
  o.save(); o.globalCompositeOperation = "soft-light"; o.fillStyle = hi; o.fillRect(0, 0, W, H); o.restore();
  const vg = o.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75); vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, `rgba(0,0,0,${(0.12 + 0.3 * lt).toFixed(3)})`);
  o.save(); o.globalCompositeOperation = "multiply"; o.fillStyle = vg; o.fillRect(0, 0, W, H); o.fillStyle = `rgba(255,236,210,${(0.06 + 0.1 * lt).toFixed(3)})`; o.fillRect(0, 0, W, H); o.restore();
  const soft = document.createElement("canvas"); soft.width = W; soft.height = H; const sx = soft.getContext("2d"); sx.filter = `blur(${(W / 1600).toFixed(2)}px)`; sx.drawImage(O, 0, 0);
  c.width = c.height = 0; P.width = P.height = 0;
  return soft;
}
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
    // downloads show only what's filled in: the box outline and its grey label are editing aids, not part of the page
    if (it.fieldKind === "check") {
      if (it.checked) { ctx.fillStyle = itemColor(it); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `700 ${h * 0.82}px system-ui, sans-serif`; ctx.fillText("✓", x + w / 2, y + h / 2); ctx.textAlign = "left"; }
    } else {
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
// The page drawn fresh from its source at any resolution (the on-screen preview is only 144 dpi):
// PDF pages rendered by pdf.js, picture pages from the full-size picture.
async function sourceCanvas(pi, res) {
  const p = await ensurePageImage(pi), src = docSources[p.src];
  const W = Math.round(p.w * res), H = Math.round(p.h * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  if (src.kind === "pdf" && src.pdf) {
    const page = await src.pdf.getPage(p.idx + 1);
    const vp = page.getViewport({ scale: 2 * res, rotation: ((page.rotate || 0) + p.rot) % 360 });
    await page.render({ canvasContext: g, viewport: vp, annotationMode: window.pdfjsLib.AnnotationMode ? window.pdfjsLib.AnnotationMode.ENABLE_FORMS : 1 }).promise;
  } else if (p.img) { g.imageSmoothingQuality = "high"; g.drawImage(p.img, 0, 0, W, H); }
  return c;
}
async function composePage(pi, res, mode = "all", opts = {}) {
  const p = await ensurePageImage(pi);
  const W = Math.round(p.w * res), H = Math.round(p.h * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  if (mode !== "overlay") {
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    if (opts.sharp) ctx.drawImage(await sourceCanvas(pi, res), 0, 0);
    else if (p.img) ctx.drawImage(p.img, 0, 0, W, H);
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
  if (mode !== "overlay") applyBlurDraws(ctx, W, H, pi);
  drawAnnToCanvas(ctx, W, H, ["highlight"], pi);
  for (const it of docItems) {
    if ((it.page || 0) !== pi) continue;
    if (mode !== "all" && (it.isField || it.type === "note")) continue;
    await drawDocItemToCtx(ctx, it, W, H, res);
  }
  drawAnnToCanvas(ctx, W, H, ["pen", "line", "arrow", "underline", "strike"], pi);
  return c;
}
// the area of a see-through canvas that has anything drawn on it (with a small margin), or null
function inkBox(c) {
  const W = c.width, H = c.height, d = c.getContext("2d").getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) { const row = y * W * 4; for (let x = 0; x < W; x++) if (d[row + x * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; } }
  if (x1 < 0) return null;
  const m = 4; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(W - 1, x1 + m); y1 = Math.min(H - 1, y1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function pageHasContent(pi) { return docItems.some((it) => (it.page || 0) === pi) || docDraws.some((d) => (d.page || 0) === pi); }

async function composeCanvas() {
  const res = +$("resolution").value;
  try { await document.fonts.ready; } catch (_) {}
  if (workMode === "doc" && doc) {
    const r2 = Math.max(res / 2, picScale()), c = await lookPage(curPage, r2), W0 = Math.round(docPages[curPage].w * r2), H0 = Math.round(docPages[curPage].h * r2);
    if (c.width === W0 && c.height === H0) return c;
    const t = document.createElement("canvas"); t.width = W0; t.height = H0; const g = t.getContext("2d");   // trim the scanned look's tilt back to the page size
    g.fillStyle = "#fff"; g.fillRect(0, 0, W0, H0); g.drawImage(c, (W0 - c.width) / 2, (H0 - c.height) / 2); return t;
  }
  const W = Math.round(hwW * res), H = Math.round(hwH * res);
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const bg = picBg();   // white by default; "paper" keeps the paper colour; "none" is transparent
  if (bg !== "none") { ctx.fillStyle = bg === "paper" ? paper : "#ffffff"; ctx.fillRect(0, 0, W, H); }
  ctx.drawImage(await svgToImage(rawSVG), 0, 0, W, H);
  return finishCanvas(c);
}

// While the download panel builds its preview, the finished file is kept here instead of being saved, and messages stay quiet.
let dlCapture = null;
function download(name, blob) {
  if (dlCapture) { dlCapture.blob = blob; dlCapture.name = name; return; }
  if (Array.isArray(window.__cal2Capture)) { window.__cal2Capture.push({ name, blob }); return; }   // automated tests collect downloads here
  if (!blob || !blob.size) { toast("Nothing to save yet — wait for the page or writing to finish drawing, then try again."); return; }   // an empty canvas gives no picture
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
let toastTimer = 0;
function toast(m) { if (dlCapture) { dlCapture.msg = m; return; } const t = $("toast"); if (!t) return; t.textContent = m; t.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), 2800); }
function flash(m) { toast(m); }
async function exportPNG(fmt = "png") {
  try {
    const c = await composeCanvas(), jpg = fmt === "jpg";
    let out = c;
    if (jpg) {   // JPG has no transparency: put the page on white
      out = document.createElement("canvas"); out.width = c.width; out.height = c.height;
      const g = out.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, out.width, out.height); g.drawImage(c, 0, 0);
    }
    const ext = jpg ? "jpg" : "png";
    const name = workMode === "doc" && doc ? outName(`${baseName()}-page${curPage + 1}`, ext) : outName("calligraphy", ext);
    out.toBlob((b) => { download(name, b); toast("Saved " + ext.toUpperCase() + "."); }, jpg ? "image/jpeg" : "image/png", dlQuality().q);
  } catch (e) { errEl.textContent = "Picture export failed: " + (e.message || e); toast("Picture export failed: " + (e.message || e)); }
}
// ---- scanned pages off the main thread (scanpool.js -> scan-worker.js) ------------------------
// One page's look as worker params. Page 1 keeps the tilt shown in the preview; every other page gets
// its own random tilt within the range (a real stack of scans is never crooked all the same way).
function workerScanParams(sp, width, pageIndex) {
  const on = !!sp.on;
  return {
    engine: dlOpts.engine === "realistic" ? "realistic" : "fast", on,
    blur: (sp.blur || 0) * (width / 800), sharp: sp.sharp || 0,
    cspace: on ? (sp.cspace || "color") : "color", bright: on ? sp.bright : 1, contrast: on ? sp.contrast : 1,
    yellow: on ? sp.yellow || 0 : 0, noise: on ? sp.noise || 0 : 0, blem: on ? sp.blem || 0 : 0, border: on && !!sp.border,
    angle: on ? (pageIndex === 0 ? scanAngle(sp) : sp.rotate + sp.rotvar * (Math.random() * 2 - 1)) : 0,
  };
}
// Compose each page here (pdf.js renders on this thread) and hand it to the worker pool, keeping a few
// pages in flight so composing and scanning overlap. onPage(i, result) is called in page order.
async function scanPagesOffThread(res, sp, enc, onPage, label, idx = null) {
  const list = idx || [...docPages.keys()], N = list.length, conc = scanConcurrency(dlOpts.engine), inflight = new Map();
  let next = 0;
  const start = async (k) => {
    const i = list[k];
    const c = await composePage(i, res, "all", { sharp: true });
    try { return await scanOffThread(c, workerScanParams(sp, c.width, i), { ...enc, trimW: Math.round(docPages[i].w * res), trimH: Math.round(docPages[i].h * res) }); }
    finally { c.width = c.height = 0; }
  };
  for (let done = 0; done < N; done++) {
    while (next < N && inflight.size < conc) { const p = start(next); p.catch(() => {}); inflight.set(next, p); next++; }
    toast(`${label}… page ${done + 1} of ${N}`);
    const r = await inflight.get(done); inflight.delete(done);
    await onPage(list[done], r);
  }
}
// A 1-bit black & white page into a PDF page: a real 1-bit image (Flate), not a JPEG.
function drawBilevel(pdf, L, page, r) {
  const { width: pw, height: ph } = page.getSize();
  const ref = pdf.context.register(pdf.context.flateStream(r.bits, { Type: "XObject", Subtype: "Image", Width: r.w, Height: r.h, BitsPerComponent: 1, ColorSpace: "DeviceGray" }));
  const name = page.node.newXObject("ScanBW", ref);
  page.pushOperators(L.pushGraphicsState(), L.concatTransformationMatrix(pw, 0, 0, ph, 0, 0), L.drawObject(name), L.popGraphicsState());
}
// "PDF details" from the download panel: title, author, subject, keywords; optionally clear the rest.
function applyPdfMeta(pdf) {
  const m = dlOpts.meta || {};
  try {
    if (m.strip) {   // creator / producer / dates say which software made the file and when
      pdf.setCreator(""); pdf.setProducer("");
      const epoch = new Date(0); pdf.setCreationDate(epoch); pdf.setModificationDate(epoch);
    }
    if (m.title) pdf.setTitle(m.title, { showInWindowTitleBar: true }); else if (m.strip) pdf.setTitle("");
    if (m.author) pdf.setAuthor(m.author); else if (m.strip) pdf.setAuthor("");
    if (m.subject) pdf.setSubject(m.subject); else if (m.strip) pdf.setSubject("");
    if (m.keywords) pdf.setKeywords(String(m.keywords).split(",").map((s) => s.trim()).filter(Boolean)); else if (m.strip) pdf.setKeywords([]);
  } catch (_) {}
  return pdf;
}
const saveOpts = () => ({ useObjectStreams: true });   // object streams: a more compact file structure

// Flattened PDF: every page as a picture with everything baked in.
async function exportPDF() {
  try {
    const L = await pdfLibReady();   // pdf-lib builds every PDF (jsPDF is gone: one library, raw bytes, no base64)
    const pdfBlob = async (pdf) => new Blob([await applyPdfMeta(pdf).save(saveOpts())], { type: "application/pdf" });
    if (workMode === "doc" && doc) {
      snapshotNow();
      const idx = await exportPageList(); if (!idx.length) return;
      const fname = outName(baseName() + "-edited", "pdf");
      try { await document.fonts.ready; } catch (_) {}
      const sp = scanParams(), Q = dlQuality();
      if (!sp.on && !(sp.blur > 0) && !(sp.sharp > 0) && !hasExtras(sp) && Q.keepPages) {
        // Default: the original pages stay as they are (sharp text, small file, no compression marks); your
        // edits are laid on top and form fields are filled in and fixed in place. Only pages that must be
        // pictures (redactions, rotated pages, pictures) are drawn as pictures.
        toast("Building PDF…");
        const { pdf } = await buildOutputPdf({ flat: true });
        try { pdf.getForm().updateFieldAppearances(); pdf.getForm().flatten(); } catch (_) {}
        download(fname, await pdfBlob(await finishPdf(pdf, L, idx)));
        toast("Saved " + fname + ".");
        return;
      }
      // "Make it look scanned" (or blur / sharpen) is on: every page is a picture, with that look
      const res = exportLook === "custom" ? Math.max(1, +$("resolution").value) / 2 + 0.5 : Q.scale;
      // a scanned look adds grain and blur that hide JPEG artifacts: 0.85 is visually the same as 0.95 and 2-3x smaller
      const jq = sp.on ? Math.min(Q.q, 0.85) : Q.q;
      let pdf = await L.PDFDocument.create();
      // Scanned look: pages rendered in parallel in background workers (fast Rust/WASM engine, or ImageMagick).
      let viaWorkers = sp.on && scanWorkersSupported() && !hasExtras(sp);   // the photo / wrinkle looks are drawn here
      if (viaWorkers) {
        try {
          if (dlOpts.engine === "realistic") toast("Loading the realistic scan engine (about 15 MB, first time only)…");
          await scanPagesOffThread(res, sp, { type: "image/jpeg", quality: jq }, async (i, r) => {
            const page = pdf.addPage([r.w / (2 * res), r.h / (2 * res)]);
            if (r.kind === "bilevel") drawBilevel(pdf, L, page, r);
            else page.drawImage(await pdf.embedJpg(new Uint8Array(r.buf)), { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
          }, "Building PDF", idx);
        } catch (e) {
          console.warn("Scan workers failed; rendering on the main thread instead.", e);
          viaWorkers = false; pdf = await L.PDFDocument.create();
          if (dlOpts.engine === "realistic") toast("The realistic engine couldn't load — using the built-in one.");
        }
      }
      for (let k = 0; !viaWorkers && k < idx.length; k++) {
        const i = idx[k];
        toast(`Building PDF… page ${k + 1} of ${idx.length}`);
        let c = await lookPage(i, res);
        // the scanned look tilts the page, which grows the picture a little: trim back to the page's own size
        const W0 = Math.round(docPages[i].w * res), H0 = Math.round(docPages[i].h * res);
        if (c.width !== W0 || c.height !== H0) {
          const t = document.createElement("canvas"); t.width = W0; t.height = H0; const g = t.getContext("2d");
          g.fillStyle = "#fff"; g.fillRect(0, 0, W0, H0); g.drawImage(c, (W0 - c.width) / 2, (H0 - c.height) / 2); c = t;
        }
        const pw = c.width / (2 * res), ph = c.height / (2 * res);
        const img = await pdf.embedJpg(await canvasBytes(c, "image/jpeg", jq));
        pdf.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        c.width = c.height = 0;   // hand the page's pixel memory back before the next one
      }
      // "Smallest file" with the clean look: pictures of a text PDF can be bigger than the PDF itself - keep the smaller
      pdf = await finishPdf(pdf, L, null);
      if (!Q.keepPages && !sp.on && !(sp.blur > 0) && !(sp.sharp > 0)) {
        const pics = await pdfBlob(pdf), kept = await buildOutputPdf({ flat: true });
        try { kept.pdf.getForm().updateFieldAppearances(); kept.pdf.getForm().flatten(); } catch (_) {}
        const keptBytes = await applyPdfMeta(await finishPdf(kept.pdf, L, idx)).save(saveOpts());
        if (keptBytes.length <= pics.size) { download(fname, new Blob([keptBytes], { type: "application/pdf" })); toast(`Saved ${fname} — already smallest as it is (${Math.round(keptBytes.length / 1024)} KB, text kept).`); return; }
        download(fname, pics); toast(`Saved ${fname} (${Math.round(pics.size / 1024)} KB, pages as pictures).`); return;
      }
      download(fname, await pdfBlob(pdf)); toast("Saved " + fname + ".");
      return;
    }
    const c = await composeCanvas();
    let pdf = await L.PDFDocument.create(); const pw = c.width / 2, ph = c.height / 2;
    const img = await pdf.embedPng(await overlayPng(c));   // PNG keeps the ink edges and see-through background exact
    pdf.addPage([pw, ph]).drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    pdf = await finishPdf(pdf, L, null);
    download(outName("calligraphy", "pdf"), await pdfBlob(pdf)); toast("Saved PDF.");
  } catch (e) { errEl.textContent = "PDF export failed: " + (e.message || e); toast("PDF export failed: " + (e.message || e)); }
}
function exportSVG() {
  let svg = mode === "signature" || +$("speed").value ? animateSVG(rawSVG) : rawSVG;
  if (picBg() !== "none") svg = svg.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" fill="${picBg() === "paper" ? paper : "#ffffff"}"/>`);
  download("calligraphy.svg", new Blob([svg], { type: "image/svg+xml" })); toast("Saved SVG.");
}

// The document as an editable PDF: original pages stay vector (selectable text), your
// objects are laid over them, form-builder fields become real fields and notes real
// comments. Pages that were rotated, came from pictures, or carry redactions become a
// flat picture so nothing hidden survives.
// fields added in the editor have no border or background in the PDF (no lines around them once filled in)
const NO_BOX = (L) => ({ borderWidth: 0, borderColor: undefined, backgroundColor: undefined, textColor: L.rgb(0.06, 0.09, 0.17) });
async function buildOutputPdf(opts = {}) {   // opts.flat: added fields are written as plain text (no form fields, no boxes)
  const L = await pdfLibReady();
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
    const Q = dlQuality(), src = docSources[p.src], pw0 = p.w / 2, ph0 = p.h / 2;
    const redact = pageNeedsFlatten(i);   // redaction or blur: what's under it must leave the file
    const replace = (np) => { pdf.removePage(i + 1); page = np; };
    let laidOver = false;
    if (redact) {
      // a redaction must remove what's under it: the page becomes a picture, drawn fresh from the source (300 dpi)
      const c = await composePage(i, Q.scale, "nofields", { sharp: true });
      const img = await pdf.embedJpg((await canvasBytes(c, "image/jpeg", Q.q)));
      const np = pdf.insertPage(i, [pw0, ph0]); np.drawImage(img, { x: 0, y: 0, width: pw0, height: ph0 }); replace(np); laidOver = true;
    } else if (src.kind !== "pdf") {
      // a page that is a picture: your original picture file goes in untouched (only re-saved if it was turned)
      const b = src.bytes, isJpg = b && b[0] === 0xFF && b[1] === 0xD8, isPng = b && b[0] === 0x89 && b[1] === 0x50;
      let img;
      if (p.rot && !p.img) await ensurePageImage(i);   // turning a page drops its picture until it is drawn again
      if (!p.rot && isJpg) img = await pdf.embedJpg(b);
      else if (!p.rot && isPng) img = await pdf.embedPng(b);
      else { const c = document.createElement("canvas"); c.width = p.img.naturalWidth || p.w; c.height = p.img.naturalHeight || p.h; c.getContext("2d").drawImage(p.img, 0, 0, c.width, c.height); img = isJpg ? await pdf.embedJpg((await canvasBytes(c, "image/jpeg", 0.97))) : await pdf.embedPng((await canvasBytes(c, "image/png"))); }
      const np = pdf.insertPage(i, [pw0, ph0]); np.drawImage(img, { x: 0, y: 0, width: pw0, height: ph0 }); replace(np);
    } else if ((base + (p.rot || 0)) % 360) {
      // a turned PDF page stays vector: the original page is placed turned on a page of the new shape
      const r = (base + (p.rot || 0)) % 360, emb = await pdf.embedPage(page), w0 = emb.width, h0 = emb.height;
      const np = pdf.insertPage(i, [pw0, ph0]);
      const at = r === 90 ? { x: 0, y: w0, rotate: L.degrees(-90) } : r === 180 ? { x: w0, y: h0, rotate: L.degrees(180) } : { x: h0, y: 0, rotate: L.degrees(90) };
      np.drawPage(emb, { ...at, width: w0, height: h0 }); replace(np);
    } else if (base) page.setRotation(L.degrees(0));   // a page saved turned that you turned back upright
    if (!laidOver && (docItems.some((it) => (it.page || 0) === i && !it.isField && it.type !== "note") || docDraws.some((d) => (d.page || 0) === i))) {
      // your edits, drawn sharp (360 dpi) on a see-through layer, cropped to the area they cover
      const ann = await composePage(i, Q.overlay, "overlay"), box = inkBox(ann);
      if (box) {
        const crop = document.createElement("canvas"); crop.width = box.w; crop.height = box.h; crop.getContext("2d").drawImage(ann, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        const { width: PW, height: PH } = page.getSize(), kx = PW / ann.width, ky = PH / ann.height;
        page.drawImage(await pdf.embedPng(await overlayPng(crop)), { x: box.x * kx, y: PH - (box.y + box.h) * ky, width: box.w * kx, height: box.h * ky });
      }
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
      if (opts.flat) {   // the clean download: only what's filled in, no field and no box around it
        try {
          if (it.fieldKind === "check") { if (it.checked) { const s = Math.min(wf, hf) || 14, zf = await pdf.embedFont(L.StandardFonts.ZapfDingbats); page.drawText("✔", { x: x + s * 0.12, y: ph - it.ny * ph - s * 0.85, size: s * 0.9, font: zf, color: L.rgb(0.06, 0.09, 0.17) }); } }
          else if (it.text) { const hv = await pdf.embedFont(L.StandardFonts.Helvetica), t = String(it.text); let sz = Math.min(hf * 0.62, 14); while (sz > 5 && hv.widthOfTextAtSize(t, sz) > wf - 4) sz -= 0.5;
            page.drawText(t, { x: x + 3, y: ph - it.ny * ph - hf / 2 - sz * 0.35, size: sz, font: hv, color: L.rgb(0.06, 0.09, 0.17) }); }
        } catch (_) {}
        continue;
      }
      let name = ((it.label || it.fieldKind || "field") + "_" + it.id).replace(/[^\w.-]/g, "_");
      while (used[name]) name += "_"; used[name] = 1;
      try {
        if (it.fieldKind === "check") { const s = Math.min(wf, hf) || 14, y = ph - it.ny * ph - s; const cb = form.createCheckBox(name); cb.addToPage(page, { x, y, width: s, height: s, ...NO_BOX(L) }); if (it.checked) cb.check(); }
        else { const y = ph - it.ny * ph - hf; const tf = form.createTextField(name); if (it.text) tf.setText(String(it.text)); tf.addToPage(page, { x, y, width: wf, height: hf, ...NO_BOX(L) }); }
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
// every page as a picture, zipped (PNG for Exact, JPG otherwise), with the chosen look
async function exportAllImages() {
  if (!doc) return;
  if (!window.JSZip) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  snapshotNow();
  const idx = await exportPageList(); if (!idx.length) return;
  const sp = scanParams(), Q = dlQuality(), S = picScale(), zip = new window.JSZip(), keep = curPage, zname = outName(baseName() + "-pages", "zip");
  const png = dlOpts.quality === "exact" && !sp.on;   // lossless PNG for clean pages; a scanned look's grain makes PNGs huge, so JPG
  const name = (i, ext) => `${baseName()}-page${String(i + 1).padStart(2, "0")}.${ext}`;
  if (sp.on && scanWorkersSupported() && !hasExtras(sp)) {
    // scanned look: pages rendered in parallel in the worker pool; 1-bit pages saved as tiny 1-bit PNGs
    try {
      const bilevel = sp.cspace === "bilevel" && typeof CompressionStream !== "undefined";
      const spx = bilevel ? sp : { ...sp, cspace: sp.cspace === "bilevel" ? "bw" : sp.cspace };
      await scanPagesOffThread(S, spx, { type: png ? "image/png" : "image/jpeg", quality: Q.q }, async (i, r) => {
        if (r.kind === "bilevel") zip.file(name(i, "png"), await bilevelPng(r.bits, r.w, r.h));
        else zip.file(name(i, png ? "png" : "jpg"), new Uint8Array(r.buf));
      }, "Saving pictures", idx);
      curPage = keep;
      download(zname, await zip.generateAsync({ type: "blob" })); toast(`Saved ${zname} (${idx.length} picture${idx.length === 1 ? "" : "s"}).`);
      return;
    } catch (e) { console.warn("Scan workers failed; rendering on the main thread instead.", e); }
  }
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    toast(`Saving page ${k + 1} of ${idx.length}…`);
    let c = await lookPage(i, S);
    const W0 = Math.round(docPages[i].w * S), H0 = Math.round(docPages[i].h * S);
    if (c.width !== W0 || c.height !== H0 || !png) { const t = document.createElement("canvas"); t.width = W0; t.height = H0; const g = t.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, W0, H0); g.drawImage(c, (W0 - c.width) / 2, (H0 - c.height) / 2); c = t; }
    zip.file(`${baseName()}-page${String(i + 1).padStart(2, "0")}.${png ? "png" : "jpg"}`, await new Promise((r) => c.toBlob(r, png ? "image/png" : "image/jpeg", Q.q)));
  }
  curPage = keep;
  download(zname, await zip.generateAsync({ type: "blob" })); toast(`Saved ${zname} (${idx.length} picture${idx.length === 1 ? "" : "s"}).`);
}
// the document's text, page by page (the PDF's own text; OCR for scanned pages)
async function exportText() {
  if (!doc || !window.__cal2DocxFromBytes) return;
  try {
    snapshotNow(); const idx = await exportPageList(); if (!idx.length) return;
    toast("Reading the text…");
    const blob = await window.__cal2DocxFromBytes(await selectedDocumentBytes(idx), baseName(), (m) => toast(m));
    const xml = await (await window.JSZip.loadAsync(blob)).file("word/document.xml").async("string");
    const txt = xml.replace(/<w:br w:type="page"\/>/g, "\n\n\f").replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const fname = outName(baseName(), "txt");
    download(fname, new Blob([txt], { type: "text/plain;charset=utf-8" })); toast("Saved " + fname + ".");
  } catch (e) { toast("Text export failed: " + (e.message || e)); }
}
async function exportWord() {
  if (!doc || !window.__cal2DocxFromBytes) return;
  try {
    snapshotNow(); const idx = await exportPageList(); if (!idx.length) return;
    toast("Building the Word document…");
    const blob = await window.__cal2DocxFromBytes(await selectedDocumentBytes(idx), baseName(), (m) => toast(m));
    const fname = outName(baseName(), "docx");
    download(fname, blob); toast("Saved " + fname + ".");
  } catch (e) { toast("Word export failed: " + (e.message || e)); }
}
async function exportFillablePDF() {
  if (!doc) { errEl.textContent = "Open a document first."; return; }
  try {
    snapshotNow(); const idx = await exportPageList(); if (!idx.length) return;
    toast("Building your PDF…");
    const { pdf, nf, nn } = await buildOutputPdf();
    await finishPdf(pdf, await pdfLibReady(), idx, { keepPaper: true });   // re-fitting pages onto new paper would drop the fields
    const bytes = await applyPdfMeta(pdf).save({ useObjectStreams: true }), fname = outName(baseName() + "-editable", "pdf");
    download(fname, new Blob([bytes], { type: "application/pdf" }));
    const bits = [nf ? `${nf} fillable field${nf > 1 ? "s" : ""}` : "", nn ? `${nn} comment${nn > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
    toast("Saved " + fname + (bits ? " — " + bits : "") + ".");
  } catch (e) { errEl.textContent = "PDF export failed: " + (e.message || e); toast("PDF export failed: " + (e.message || e)); }
}

// ---- share links ---------------------------------------------------------

function st() {
  return { t: $("text").value, md: mode, sty: $("style").value, sp: +$("speed").value, lg: +$("legibility").value, th: +$("thickness").value,
    fp: +$("font_px").value, sl: +$("slant").value, ct: +$("contrast").value, spc: +$("spacing").value, ln: +$("line_spacing").value,
    al: align, sd: seedVal(), i: ink, p: paper, tx: texIdx, ti: +$("tex_intensity").value, ps: $("paper_style").value,
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
function storeSavedSigs(a) { lsSet(SIG_KEY, a.slice(0, 40)); }
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
    const dl = document.createElement("div");
    dl.textContent = "⤓"; dl.title = "Download this signature (PNG; Shift+click for SVG)";
    dl.style.cssText = "position:absolute;bottom:-1px;right:1px;color:#2b6cff;font-weight:700;cursor:pointer;background:rgba(255,255,255,.85);line-height:1.1;padding:0 4px;border-radius:6px 0 0 0";
    dl.onclick = (e) => { e.stopPropagation(); downloadSig(s, e.shiftKey ? "svg" : "png"); };
    card.appendChild(del); card.appendChild(dl); host.appendChild(card);
  });
}
// ---- export / import of saved signatures and handwriting styles ----------------------
// One JSON file format for both, so a backup made on one computer loads on another.
const BACKUP_APP = "ghost-calligrapher";
function sigFileName(s, ext) { return ((s.name || "signature").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-") || "signature") + "." + ext; }
// Picture background for signature and handwriting pictures: white (the default) or none (transparent).
const PICBG_KEY = "cal2_pic_bg";
function picBg() { const v = lsGet(PICBG_KEY, "white"); return v === "none" || v === "paper" ? v : "white"; }
function setPicBg(v) { lsSet(PICBG_KEY, v); toggles.transparent = v === "none"; syncPicBgUI(); }
function syncPicBgUI() { document.querySelectorAll("[data-picbg]").forEach((b) => b.classList.toggle("sel", b.dataset.picbg === picBg())); }
async function sigPng(s, bg = picBg(), width = 1200) {
  const color = s.color || "#111111", svg = s.svg.replace("<svg ", `<svg style="color:${color}" `);
  const img = await svgToImage(svg), k = Math.max(1, width / Math.max(1, s.w || img.width));
  const c = document.createElement("canvas"); c.width = Math.round((s.w || img.width) * k); c.height = Math.round((s.h || img.height) * k);
  const g = c.getContext("2d"); if (bg !== "none") { g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
async function downloadSig(s, kind) {
  const color = s.color || "#111111";
  if (kind === "svg") {
    let svg = s.svg.replace("<svg ", `<svg style="color:${color}" `).replace(/currentColor/g, color);
    if (picBg() !== "none") svg = svg.replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/>');
    download(sigFileName(s, "svg"), new Blob([svg], { type: "image/svg+xml" })); toast("Saved " + sigFileName(s, "svg") + "."); return;
  }
  download(sigFileName(s, "png"), await sigPng(s)); toast("Saved " + sigFileName(s, "png") + (picBg() === "none" ? " (no background)." : " (white background)."));
}

// ---- signatures & styles manager: pick what to export, preview what an import will add ----------
const mgr = { incoming: null };
function mgrRow(kind, x, checked) {
  const row = mk("label", { className: "mg-row" }), cb = mk("input", { type: "checkbox", checked: !!checked }); cb.dataset.id = x.id; cb.dataset.kind = kind;
  const pv = mk("span", { className: "mg-pv" });
  if (kind.endsWith("sig")) pv.innerHTML = x.svg.replace("<svg ", `<svg style="width:100%;height:100%;color:${x.color || "#111"}" preserveAspectRatio="xMidYMid meet" `);
  else pv.textContent = x.prime ? "✍" : "Aa";
  const nm = mk("span", { className: "mg-nm" }, escapeHTML(x.name || (kind === "sig" ? "Signature" : "Style")) + (x._note ? `<small>${escapeHTML(x._note)}</small>` : "") + (x.prime ? "<small>your own handwriting</small>" : ""));
  row.append(cb, pv, nm); return row;
}
function renderMgr() {
  const sigs = loadSavedSigs(), styles = loadSavedHands();
  const sl = $("mg_sigs"), hl = $("mg_styles"); sl.innerHTML = ""; hl.innerHTML = "";
  sigs.forEach((s) => sl.appendChild(mgrRow("sig", s, true))); if (!sigs.length) sl.innerHTML = '<div class="note" style="margin:0">No saved signatures.</div>';
  styles.forEach((h) => hl.appendChild(mgrRow("style", h, true))); if (!styles.length) hl.innerHTML = '<div class="note" style="margin:0">No saved styles.</div>';
  renderMgrIncoming();
}
function openMgr(tab) {
  renderMgr(); syncPicBgUI(); $("mg_err").textContent = "";
  $("sigmgr").showModal();
  if (tab === "import") $("mg_file").click();
}
function mgrChecked(kind) { return [...document.querySelectorAll(`#sigmgr .mg-list input[data-kind="${kind}"]:checked`)].map((c) => c.dataset.id); }
function exportSelected() {
  const si = new Set(mgrChecked("sig")), hi = new Set(mgrChecked("style"));
  const data = { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString(), signatures: loadSavedSigs().filter((s) => si.has(s.id)), styles: loadSavedHands().filter((h) => hi.has(h.id)) };
  if (!data.signatures.length && !data.styles.length) { $("mg_err").textContent = "Tick at least one signature or style."; return; }
  const name = "ghost-calligrapher-" + new Date().toISOString().slice(0, 10) + ".json";
  download(name, new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  toast(`Saved ${name} — ${data.signatures.length} signature${data.signatures.length === 1 ? "" : "s"}, ${data.styles.length} style${data.styles.length === 1 ? "" : "s"}.`);
}
async function exportSelectedPictures() {
  const si = new Set(mgrChecked("sig")), list = loadSavedSigs().filter((s) => si.has(s.id));
  if (!list.length) { $("mg_err").textContent = "Tick at least one signature."; return; }
  if (list.length === 1) { downloadSig(list[0], "png"); return; }
  if (!window.JSZip) await new Promise((res, rej) => { const sc = document.createElement("script"); sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); });
  const zip = new window.JSZip(), used = {};
  for (const s of list) { let n = sigFileName(s, "png"); while (used[n]) n = n.replace(/(\.png)$/, "-2$1"); used[n] = 1; zip.file(n, await sigPng(s)); }
  download("signatures.zip", await zip.generateAsync({ type: "blob" })); toast(`Saved signatures.zip (${list.length} pictures, ${picBg() === "none" ? "no background" : "white background"}).`);
}
// Reads any mix of files: Ghost Calligrapher exports (this and older versions), plain lists, SVG signatures,
// and pictures of a signature (those open in the signature tracer).
const okSigSvg = (v) => typeof v === "string" && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(v) && !/<script|<foreignObject|\son\w+\s*=|javascript:|<iframe/i.test(v);
function normSig(s) { if (!s || !okSigSvg(s.svg)) return null; const svg = s.svg.replace(/^\s*<\?xml[^>]*>\s*/, ""); const w = +s.w || +(svg.match(/width="([\d.]+)/) || [])[1] || 400, h = +s.h || +(svg.match(/height="([\d.]+)/) || [])[1] || 120; return { id: String(s.id || Date.now() + "-" + Math.random().toString(36).slice(2, 7)), name: String(s.name || "Signature").slice(0, 60), svg, w, h, text: s.text || "", seed: s.seed, drawn: !!s.drawn, color: typeof s.color === "string" ? s.color : undefined }; }
function normStyle(h) { if (!h || typeof h.state !== "object" || !h.state) return null; const prime = h.prime && typeof h.prime.text === "string" && Array.isArray(h.prime.offsets) ? { text: h.prime.text, offsets: h.prime.offsets } : undefined; return { id: String(h.id || Date.now() + "-h" + Math.random().toString(36).slice(2, 7)), name: String(h.name || "Style").slice(0, 60), state: h.state, prime }; }
async function readImportFiles(files) {
  const inc = { sigs: [], styles: [], skipped: [] }; let picture = null;
  for (const f of files) {
    try {
      if (/^image\/(png|jpe?g|webp|gif|bmp)$/i.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name) || /\.pdf$/i.test(f.name)) { picture = picture || f; continue; }
      const text = await f.text();
      if (/\.svg$/i.test(f.name) || /^\s*(<\?xml[^>]*>\s*)?<svg/i.test(text)) { const s = normSig({ svg: text, name: f.name.replace(/\.svg$/i, "") }); if (s) inc.sigs.push(s); else inc.skipped.push(f.name + " (not a usable SVG)"); continue; }
      let d = JSON.parse(text);
      if (typeof d.cal2_sigs === "string" || typeof d.cal2_styles === "string") d = { signatures: JSON.parse(d.cal2_sigs || "[]"), styles: JSON.parse(d.cal2_styles || "[]") };   // a raw browser-storage copy
      if (Array.isArray(d)) d = { signatures: d.filter((x) => x && x.svg), styles: d.filter((x) => x && x.state) };
      const s0 = inc.sigs.length + inc.styles.length;
      (d.signatures || []).forEach((x) => { const s = normSig(x); if (s) inc.sigs.push(s); });
      (d.styles || d.hands || []).forEach((x) => { const h = normStyle(x); if (h) inc.styles.push(h); });
      if (inc.sigs.length + inc.styles.length === s0) inc.skipped.push(f.name + " (no signatures or styles in it)");
    } catch (_) { inc.skipped.push(f.name + " (couldn't be read)"); }
  }
  // mark what's already here, and name clashes
  const haveS = loadSavedSigs(), haveH = loadSavedHands();
  inc.sigs.forEach((s) => { const same = haveS.find((x) => x.id === s.id || x.svg === s.svg); if (same) { s._dup = true; s._note = "already saved"; } else if (haveS.some((x) => x.name === s.name)) s._note = "a signature with this name exists — both are kept"; });
  inc.styles.forEach((h) => { const same = haveH.find((x) => x.id === h.id || JSON.stringify(x.state) === JSON.stringify(h.state)); if (same) { h._dup = true; h._note = "already saved"; } else if (haveH.some((x) => x.name === h.name)) h._note = "a style with this name exists — both are kept"; });
  return { inc, picture };
}
async function mgrImportFiles(files) {
  $("mg_err").textContent = "";
  const { inc, picture } = await readImportFiles([...files]);
  if (picture && !inc.sigs.length && !inc.styles.length) { $("sigmgr").close(); openSigStudio(picture); toast("Trace the signature from your picture, then Save."); return; }
  mgr.incoming = inc; renderMgrIncoming();
  if (picture) toast("Pictures are imported one at a time through the signature tracer — drop just the picture to trace it.");
}
function renderMgrIncoming() {
  const box = $("mg_in"), inc = mgr.incoming; box.innerHTML = "";
  if (!inc) { box.style.display = "none"; return; }
  box.style.display = "";
  const total = inc.sigs.length + inc.styles.length;
  box.appendChild(mk("div", { className: "mg-h" }, `Ready to import: ${inc.sigs.length} signature${inc.sigs.length === 1 ? "" : "s"}, ${inc.styles.length} style${inc.styles.length === 1 ? "" : "s"}`));
  const list = mk("div", { className: "mg-list" });
  inc.sigs.forEach((s) => list.appendChild(mgrRow("in-sig", s, !s._dup)));
  inc.styles.forEach((h) => list.appendChild(mgrRow("in-style", h, !h._dup)));
  if (!total) list.innerHTML = '<div class="note" style="margin:0">Nothing to import in those files.</div>';
  box.appendChild(list);
  if (inc.skipped.length) box.appendChild(mk("div", { className: "note", style: "margin:6px 0 0" }, "Skipped: " + escapeHTML(inc.skipped.join(", "))));
  const row = mk("div", { className: "mg-btns" });
  const go = mk("button", { className: "btn primary", type: "button" }, "Import ticked"); go.onclick = mgrApplyImport;
  const cancel = mk("button", { className: "btn", type: "button" }, "Cancel"); cancel.onclick = () => { mgr.incoming = null; renderMgrIncoming(); };
  row.append(cancel, go); box.appendChild(row);
}
function mgrApplyImport() {
  const inc = mgr.incoming; if (!inc) return;
  const si = new Set(mgrChecked("in-sig")), hi = new Set(mgrChecked("in-style")), now = Date.now();
  const sigs = loadSavedSigs(), styles = loadSavedHands(); let ns = 0, nh = 0;
  inc.sigs.filter((s) => si.has(s.id)).forEach((s) => { const { _dup, _note, ...x } = s; if (sigs.some((y) => y.id === x.id)) x.id = now + "-" + Math.random().toString(36).slice(2, 7); sigs.unshift({ ...x, savedAt: now, usedAt: now }); ns++; });
  inc.styles.filter((h) => hi.has(h.id)).forEach((h) => { const { _dup, _note, ...x } = h; if (styles.some((y) => y.id === x.id)) x.id = now + "-h" + Math.random().toString(36).slice(2, 7); styles.unshift({ ...x, savedAt: now, usedAt: now }); nh++; });
  storeSavedSigs(sigs); storeSavedHands(styles); renderSavedSigs(); renderSavedHands();
  mgr.incoming = null; renderMgr();
  toast(ns || nh ? `Imported ${[ns ? ns + " signature" + (ns > 1 ? "s" : "") : "", nh ? nh + " style" + (nh > 1 ? "s" : "") : ""].filter(Boolean).join(" and ")}.` : "Nothing imported.");
}
function exportBackup(kind) {
  const data = { app: BACKUP_APP, version: 1, exportedAt: new Date().toISOString() };
  if (kind !== "styles") data.signatures = loadSavedSigs();
  if (kind !== "signatures") data.styles = loadSavedHands();
  const n = (data.signatures || []).length + (data.styles || []).length;
  if (!n) { toast(kind === "styles" ? "No saved styles to export yet." : "No saved signatures to export yet."); return; }
  const name = "ghost-calligrapher-" + kind + "-" + new Date().toISOString().slice(0, 10) + ".json";
  download(name, new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  toast(`Saved ${name} — ${kind === "styles" ? data.styles.length + " style" + (data.styles.length === 1 ? "" : "s") : data.signatures.length + " signature" + (data.signatures.length === 1 ? "" : "s")}.`);
}
// Imported items are merged: same id or same drawing are skipped, and everything gets a fresh 60 days.
async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch (_) { toast("That file isn't a Ghost Calligrapher export."); return; }
  if (!data || data.app !== BACKUP_APP) { toast("That file isn't a Ghost Calligrapher export."); return; }
  const now = Date.now(), okSvg = (v) => typeof v === "string" && /^\s*<svg[\s>]/i.test(v) && !/<script|\son\w+\s*=|javascript:/i.test(v);
  let ns = 0, nh = 0;
  if (Array.isArray(data.signatures)) {
    const list = loadSavedSigs();
    for (const s of data.signatures) {
      if (!s || !okSvg(s.svg) || list.some((x) => x.id === s.id || x.svg === s.svg)) continue;
      list.unshift({ id: String(s.id || now + "-" + ns), name: String(s.name || "Signature").slice(0, 60), svg: s.svg, w: +s.w || 400, h: +s.h || 120, text: s.text || "", seed: s.seed, drawn: !!s.drawn, color: typeof s.color === "string" ? s.color : undefined, savedAt: now, usedAt: now });
      ns++;
    }
    storeSavedSigs(list); renderSavedSigs();
  }
  if (Array.isArray(data.styles)) {
    const list = loadSavedHands();
    for (const h of data.styles) {
      if (!h || typeof h.state !== "object" || list.some((x) => x.id === h.id)) continue;
      const prime = h.prime && typeof h.prime.text === "string" && Array.isArray(h.prime.offsets) ? { text: h.prime.text, offsets: h.prime.offsets } : undefined;
      list.unshift({ id: String(h.id || now + "-h" + nh), name: String(h.name || "Style").slice(0, 60), state: h.state, prime, savedAt: now, usedAt: now });
      nh++;
    }
    storeSavedHands(list); renderSavedHands();
  }
  toast(ns || nh ? `Imported ${[ns ? ns + " signature" + (ns > 1 ? "s" : "") : "", nh ? nh + " style" + (nh > 1 ? "s" : "") : ""].filter(Boolean).join(" and ")}.` : "Nothing new in that file — everything in it is already saved here.");
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
  addSavedSig({ name: textForEngine().slice(0, 30) || "Signature", svg: cleanSigSVG(rawSVG), w: hwW, h: hwH, text: textForEngine(), seed: seedVal() });
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
function storeSavedHands(a) { lsSet(STYLE_KEY, a.slice(0, 40)); }
function applySavedStyle(s) {
  const text = $("text").value;
  applyState({ ...s.state, t: text });
  buildSwatches(); syncToggles(); refreshLabels();
  activatePrime(s);
  const l = loadSavedHands(); const x = l.find((y) => y.id === s.id); if (x) { x.usedAt = Date.now(); storeSavedHands(l); }
  const it = selectedItem();
  if (it && it.type === "sig" && it.dynamic) { it.seed = seedVal(); regenItem(it, undefined, true); } else render(true);
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
  handHistory.push(seedVal());
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
const DP_KEY = "cal2_dp_opts";
const dp = Object.assign({ mode: "sig", strokes: [], redo: [], cur: null, color: "#1b1b1f", size: 3, ctx: null, wired: false, pen: "ball", slant: 0, stretch: 100, flow: 100, guide: true, pressure: true },
  (() => { try { const o = JSON.parse(localStorage.getItem(DP_KEY) || "{}"); return { color: o.color, size: o.size, pen: o.pen, slant: o.slant, stretch: o.stretch, flow: o.flow, guide: o.guide, pressure: o.pressure }; } catch (_) { return {}; } })());
for (const k of Object.keys(dp)) if (dp[k] === undefined) delete dp[k];
Object.assign(dp, Object.assign({ color: "#1b1b1f", size: 3, pen: "ball", slant: 0, stretch: 100, flow: 100, guide: true, pressure: true }, dp));
const dpStore = () => { try { localStorage.setItem(DP_KEY, JSON.stringify({ color: dp.color, size: dp.size, pen: dp.pen, slant: dp.slant, stretch: dp.stretch, flow: dp.flow, guide: dp.guide, pressure: dp.pressure })); } catch (_) {} };
// slant and width change the drawn shape (around the pad's centre), not the stroke data, so they can be changed afterwards
function dpShape(strokes) {
  if (dp.mode !== "sig" || (!dp.slant && dp.stretch === 100)) return strokes;
  const c = $("dp_canvas").getBoundingClientRect(), cx = c.width / 2, cy = c.height / 2, k = Math.tan(-dp.slant * Math.PI / 180), sx = dp.stretch / 100;
  return strokes.map((s) => s.map((p) => ({ ...p, x: cx + (p.x - cx) * sx + (p.y - cy) * k, y: p.y })));
}
const dpPen = () => dp.mode === "sig" ? { pen: dp.pen, pressure: dp.pressure } : null;
const DP_INKS = ["#1b1b1f", "#1d3a8a", "#0b2a6b", "#6d1a36"];
function openDrawPad(m) {
  const dlg = $("dpad"); if (!dlg) return;
  dpWire();
  dp.strokes = []; dp.redo = []; dp.cur = null; dpSetMode(m || "sig");
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
  if (all.length) { x.globalAlpha = dp.mode === "sig" ? dp.flow / 100 : 1; x.fillStyle = dp.color; x.fill(new Path2D(inkPath(dpShape(all), dp.size, dpFx(), dpPen()))); x.globalAlpha = 1; }
}
// Smooth, pressure/speed-sensitive ink: each stroke becomes a filled outline.
// fx: smoothness (averaging + corner rounding), exactness (how many of the original
// points are kept), realism (pressure/speed width changes, tapered ends, ink wobble).
const INK_NEUTRAL = { smooth: 30, exact: 100, real: 100 };
const dpFx = () => (dp.mode === "sig" ? sigFx : INK_NEUTRAL);
// pen: { pen: "ball" | "fine" | "fountain" | "marker" | "brush", pressure } (the signature pad's pen; null = ballpoint)
function inkPath(strokes, size, fx = INK_NEUTRAL, pen = null) {
  const kind = pen ? pen.pen : "ball", R = (pen && pen.pressure === false ? 0 : fx.real / 100) * (kind === "marker" || kind === "fine" ? 0.25 : 1), eps = Math.pow(1 - fx.exact / 100, 2) * 6, avg = Math.round(fx.smooth / 100 * 6), passes = Math.round(fx.smooth / 100 * 3);
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
      const brush = kind === "brush", speed = brush ? Math.max(0.3, Math.min(1.7, 1.7 - v * 0.8)) : Math.max(0.55, Math.min(1.2, 1.2 - v * 0.35));
      const edge = Math.min(1, Math.min(i, n - 1 - i) / Math.max(2, n * (brush ? 0.18 : 0.08)));
      const real = size * (0.55 + 0.9 * (s[i].p || 0.5)) * speed * (0.45 + 0.55 * edge);
      const flat = size * 0.95 * (0.8 + 0.2 * edge);
      w[i] = flat + (real - flat) * R;
      if (kind === "fine") w[i] *= 0.55;
      else if (kind === "marker") w[i] = size * 1.35 * (0.9 + 0.1 * edge);
      else if (kind === "fountain") { const ang = Math.atan2(b.y - a.y, b.x - a.x), nib = -Math.PI / 4; w[i] *= 0.3 + 1.3 * Math.abs(Math.sin(ang - nib)); }
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
  const shaped = dpShape(dp.strokes); x0 = 1e9; y0 = 1e9; x1 = -1e9; y1 = -1e9;
  for (const s of shaped) for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const pad = dp.size * 2 + 4, w = Math.ceil(x1 - x0 + pad * 2), h = Math.ceil(y1 - y0 + pad * 2);
  const moved = shaped.map((s) => s.map((p) => ({ ...p, x: p.x - x0 + pad, y: p.y - y0 + pad })));
  const op = dp.mode === "sig" && dp.flow < 100 ? ` fill-opacity="${(dp.flow / 100).toFixed(2)}"` : "";
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="currentColor" stroke="none"><g${op}><path d="${inkPath(moved, dp.size, dpFx(), dpPen())}"/></g></svg>`, w, h };
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
  c.addEventListener("pointerdown", (e) => { e.preventDefault(); try { c.setPointerCapture(e.pointerId); } catch (_) {} dp.cur = [dpPt(e)]; dp.redo = []; $("dp_warn").textContent = ""; dpRedraw(); });
  c.addEventListener("pointermove", (e) => { if (!dp.cur) return; const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; for (const ev of (evs.length ? evs : [e])) dp.cur.push(dpPt(ev)); dpRedraw(); });
  const end = () => { if (dp.cur) { dp.strokes.push(dp.cur); dp.cur = null; dpRedraw(); } };
  c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
  $("dp_mode").querySelectorAll("button").forEach((b) => b.onclick = () => dpSetMode(b.dataset.dp));
  $("dp_undo").onclick = () => { if (dp.strokes.length) dp.redo.push(dp.strokes.pop()); dpRedraw(); };
  $("dp_redo").onclick = () => { if (dp.redo.length) dp.strokes.push(dp.redo.pop()); dpRedraw(); };
  $("dp_clear").onclick = () => { if (dp.strokes.length) dp.redo = [...dp.strokes].reverse(); dp.strokes = []; dpRedraw(); };   // Redo brings it all back
  $("dpad").addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.target.tagName === "INPUT" && e.target.type === "text") return;
    const k = e.key.toLowerCase(); if (k === "z" && !e.shiftKey) { e.preventDefault(); $("dp_undo").click(); } else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); $("dp_redo").click(); }
  });
  $("dp_size").value = dp.size;
  $("dp_size").oninput = () => { dp.size = +$("dp_size").value; dpStore(); dpRedraw(); };
  // pen, colour, slant, width, ink flow, guide line, pressure - remembered for next time
  const opt = (id, key, fmt) => { const el = $(id); if (el.type === "checkbox") el.checked = !!dp[key]; else el.value = dp[key]; const out = $(id + "_v"); if (out && fmt) out.textContent = fmt(dp[key]);
    el.oninput = el.onchange = () => { dp[key] = el.type === "checkbox" ? el.checked : el.type === "range" ? +el.value : el.value; if (out && fmt) out.textContent = fmt(dp[key]); if (key === "guide") $("dpad").classList.toggle("noguide", !dp.guide); if (key === "color") inks.querySelectorAll(".sw").forEach((x) => x.classList.remove("sel")); dpStore(); dpRedraw(); }; };
  const inks = $("dp_ink");
  opt("dp_pen", "pen"); opt("dp_color", "color"); opt("dp_slant", "slant", (v) => v + "°"); opt("dp_stretch", "stretch", (v) => v + "%"); opt("dp_flow", "flow", (v) => v + "%"); opt("dp_guide", "guide"); opt("dp_pressure", "pressure");
  $("dpad").classList.toggle("noguide", !dp.guide);
  const dlSig = async (png) => {
    if (!dp.strokes.length) { $("dp_warn").textContent = "Sign on the pad first."; return; }
    const g = dpSvg(), svg = g.svg.replace('fill="currentColor"', `fill="${dp.color}"`), name = "signature." + (png ? "png" : "svg");
    let blob = new Blob([svg], { type: "image/svg+xml" });
    if (png) { const im = new Image(), u = URL.createObjectURL(blob); im.src = u; await im.decode(); const c2 = document.createElement("canvas"), k = 3; c2.width = g.w * k; c2.height = g.h * k; c2.getContext("2d").drawImage(im, 0, 0, c2.width, c2.height); URL.revokeObjectURL(u); blob = await new Promise((r) => c2.toBlob(r, "image/png")); }
    const a = document.createElement("a"), u2 = URL.createObjectURL(blob); a.href = u2; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u2), 4000);
  };
  $("dp_png").onclick = () => dlSig(true); $("dp_svgdl").onclick = () => dlSig(false);
  fxSliders($("dp_fx"), ["smooth", "exact", "real"], () => dpRedraw());
  $("dp_fxreset").onclick = () => fxReset($("dp_fx"), dpRedraw);
  inks.innerHTML = "";
  DP_INKS.forEach((col) => { const b = document.createElement("div"); b.className = "sw" + (col === dp.color ? " sel" : ""); b.style.background = col; b.title = col; b.onclick = () => { dp.color = col; $("dp_color").value = col; inks.querySelectorAll(".sw").forEach((x) => x.classList.toggle("sel", x === b)); dpStore(); dpRedraw(); }; inks.appendChild(b); });
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
      const pdf = await (await pdfjsReady()).getDocument({ data: r.bytes.slice(), fontExtraProperties: true }).promise;
      sources[si] = { ...sources[si], bytes: r.bytes, pdf };
    }
  } catch (e) { $("wm_err").textContent = "Could not remove it: " + (e.message || e); return; }
  docSources = sources;
  const changed = new Set(bySrc.keys());
  docPages = docPages.map((p) => changed.has(p.src) ? { ...p, img: null, url: BLANK_PAGE, _loading: null, fields: [], key: nextKey() } : p);
  textBlocks.clear(); ocrBlocks.clear(); for (const k of [...pdfFonts.keys()]) if (changed.has(+k.split(":")[0])) pdfFonts.delete(k);
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
  const found = new Map(), OPS = (await pdfjsReady()).OPS;
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
        sx.pdf = await (await pdfjsReady()).getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
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


// ---- fill-in web page: a form becomes one HTML file anyone can open, fill in, sign and turn into a PDF ----
// The page carries the form's pages as pictures plus its fields (the PDF's own fillable fields and the ones
// added with Form fields). Nothing is uploaded by the page: the person filling it in gets the completed,
// signed PDF in their browser and sends it back. Optionally published to GitHub Pages for a link.
function collectFillFields() {
  const out = [];
  docPages.forEach((p, pi) => {
    (p.fields || []).forEach((f, k) => out.push({ id: "p" + pi + "_" + k, page: pi, src: "pdf", type: f.type === "check" ? "check" : f.type === "radio" ? "radio" : f.type === "choice" ? "choice" : "text",
      name: f.name, label: "", value: f.type === "radio" ? f.value : undefined, options: f.options, pre: fieldValues[f.name] ?? "", x: f.nx, y: f.ny, w: f.nw, h: f.nh }));
    docItems.filter((it) => it.isField && (it.page || 0) === pi).forEach((it) => {
      const h = it.nw * it.ar * p.w / p.h;
      out.push({ id: it.id, page: pi, src: "item", type: it.fieldKind === "check" ? "check" : it.fieldKind === "sig" ? "sig" : it.fieldKind === "date" ? "date" : "text",
        name: it.label || it.fieldKind, label: /^(Text|Date|Signature|)$/.test(it.label || "") ? "" : it.label, pre: it.fieldKind === "check" ? !!it.checked : it.fieldKind === "date" ? "" : (it.text || ""), x: it.nx, y: it.ny, w: it.nw, h });
    });
  });
  out.sort((a, b) => a.page - b.page || (Math.abs(a.y - b.y) < 0.008 ? a.x - b.x : a.y - b.y));
  return out;
}
// A field's label is read from the page: the words to its left on the same line, or just above it
// (checkboxes and radio buttons: the words to their right). Falls back to the PDF field name.
const prettyName = (n) => String(n || "").replace(/[_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\s+\d+$/, "").trim();
async function labelFields(fields) {
  const blocksOf = {};
  for (const f of fields) {
    if (f.label) continue;
    const blocks = blocksOf[f.page] || (blocksOf[f.page] = await getTextBlocks(f.page).catch(() => []));
    const cy = f.y + f.h / 2, tick = f.type === "check" || f.type === "radio";
    let best = null, bd = 1e9;
    for (const b of blocks || []) {
      const s = (b.str || "").trim(); if (!s || s.length > 70 || /^[_.\s-]+$/.test(s)) continue;
      const by = b.ny + b.nh / 2, bx2 = b.nx + b.nw, same = Math.abs(by - cy) < Math.max(f.h, b.nh) * 0.75;
      let d = 1e9;
      if (same && tick && b.nx >= f.x + f.w - 0.004 && b.nx - (f.x + f.w) < 0.25) d = b.nx - (f.x + f.w);
      else if (same && bx2 <= f.x + 0.012 && f.x - bx2 < 0.35) d = (f.x - bx2) + (tick ? 0.05 : 0);
      else if (!tick && b.ny + b.nh <= f.y + 0.004 && f.y - (b.ny + b.nh) < 0.035 && b.nx < f.x + f.w && bx2 > f.x) d = (f.y - (b.ny + b.nh)) * 3 + 0.2;   // a label beside the box beats one above it
      if (d < bd) { bd = d; best = s; }
    }
    f.label = (best ? best.replace(/[:\s_.]+$/, "").replace(/^[\s_.]+/, "") : "") || prettyName(f.name) || (f.type === "sig" ? "Signature" : f.type === "date" ? "Date" : "Field");
  }
  return fields;
}
async function buildFillPage(opts) {
  const pages = [];
  for (let i = 0; i < docPages.length; i++) {
    const c = await composePage(i, 1, "nofields");                  // the page with your edits, without the fields
    const k = Math.min(1, 1300 / c.width), s = document.createElement("canvas");
    s.width = Math.round(c.width * k); s.height = Math.round(c.height * k);
    const g = s.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, s.width, s.height); g.drawImage(c, 0, 0, s.width, s.height);
    pages.push({ img: s.toDataURL("image/jpeg", 0.85), w: docPages[i].w / 2, h: docPages[i].h / 2 });
  }
  const fields = await labelFields(collectFillFields());
  const data = { v: 2, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: opts.title, note: opts.note, email: opts.email, file: baseName(), pages,
    fields: fields.map(({ src, ...f }) => f) };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return { id: data.id, html: FILL_PAGE_HTML.replace("__TITLE__", escapeHTML(opts.title)).replace("__DATA__", () => json) };
}

// ---- publishing to a link (GitHub Pages) -----------------------------------------------
// The page is committed to the site's repository with the GitHub API, using a token the user creates and
// enters here (kept in this browser only if they ask). The site redeploys and the page is live in ~1 minute.
const GH_KEY = "cal2_gh_publish", PUB_KEY = "cal2_published";
function ghDefaults() {
  const m = location.hostname.match(/^([\w-]+)\.github\.io$/i), seg = location.pathname.split("/").filter(Boolean)[0] || "";
  const owner = m ? m[1] : "Jcodomo", repo = m && seg ? seg : "calligrapher2";
  return { repo: owner + "/" + repo, folder: "web/f", base: "https://" + owner.toLowerCase() + ".github.io/" + repo + "/f/" };
}
function ghSettings() { return { ...ghDefaults(), ...lsGet(GH_KEY, {}) }; }
function b64utf8(str) { const u = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
async function ghPublish(id, html, title, token) {
  const st = ghSettings(), path = st.folder.replace(/^\/+|\/+$/g, "") + "/" + id + ".html";
  const r = await fetch(`https://api.github.com/repos/${st.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Fill-in page: " + title, content: b64utf8(html) }) });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(r.status === 401 ? "GitHub did not accept the token." : r.status === 404 ? "Repository or folder not found, or the token can't write to " + st.repo + "." : (e.message || "GitHub error " + r.status));
  }
  const j = await r.json(), url = st.base.replace(/\/?$/, "/") + id + ".html";
  const list = lsGet(PUB_KEY, []); list.unshift({ id, title, url, path, sha: j.content && j.content.sha, repo: st.repo, at: Date.now() }); lsSet(PUB_KEY, list.slice(0, 50));
  return url;
}
async function ghUnpublish(entry, token) {
  const r = await fetch(`https://api.github.com/repos/${entry.repo}/contents/${entry.path}`, { method: "DELETE",
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Remove fill-in page: " + entry.title, sha: entry.sha }) });
  if (!r.ok && r.status !== 404) throw new Error("GitHub error " + r.status);
  lsSet(PUB_KEY, lsGet(PUB_KEY, []).filter((x) => x.id !== entry.id));
}
function fwToken() { return $("fw_token").value.trim() || (lsGet(GH_KEY, {}).token || ""); }
function renderPublished() {
  const host = $("fw_pub_list"); if (!host) return;
  const list = lsGet(PUB_KEY, []); host.innerHTML = "";
  if (!list.length) { host.innerHTML = '<div class="note" style="margin:0">No published pages yet.</div>'; return; }
  list.forEach((e) => {
    const row = mk("div", { className: "fw-pub" });
    row.innerHTML = `<a href="${escapeHTML(e.url)}" target="_blank" rel="noopener">${escapeHTML(e.title)}</a><small>${new Date(e.at).toLocaleDateString()}</small>`;
    const cp = mk("button", { className: "linkbtn", type: "button", title: "Copy link" }, "Copy"); cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(e.url); toast("Link copied."); };
    const rm = mk("button", { className: "linkbtn", type: "button", title: "Take this page offline" }, "Remove");
    rm.onclick = async () => {
      const t = fwToken(); if (!t) { $("fw_err").textContent = "Enter your GitHub token to remove a page."; return; }
      if (!confirm("Take “" + e.title + "” offline? The link will stop working (copies people already downloaded are not affected).")) return;
      try { await ghUnpublish(e, t); renderPublished(); toast("Removed. The link stops working after the site redeploys (about a minute)."); } catch (err) { $("fw_err").textContent = err.message; }
    };
    row.append(cp, rm); host.appendChild(row);
  });
}
function openFillWebDialog() {
  if (!doc) return;
  const all = collectFillFields(), n = all.length;
  if (!n) { toast("This document has no fields yet — add them with Form fields (or Find fields on this page) first."); return; }
  $("fw_title").value = $("fw_title").value || baseName();
  $("fw_count").textContent = `${n} field${n === 1 ? "" : "s"} (${all.filter((f) => f.type === "sig").length} to sign) on ${docPages.length} page${docPages.length === 1 ? "" : "s"}.`;
  const st = ghSettings(); $("fw_repo").value = st.repo; $("fw_folder").value = st.folder; $("fw_base").value = st.base;
  $("fw_token").value = ""; $("fw_token").placeholder = st.token ? "Saved in this browser" : "github_pat_…"; $("fw_remember").checked = !!st.token;
  $("fw_link").innerHTML = ""; $("fw_err").textContent = "";
  renderPublished();
  $("fillweb").showModal();
}
function fwOpts() {
  const opts = { title: $("fw_title").value.trim() || baseName(), note: $("fw_note").value.trim(), email: $("fw_email").value.trim() };
  if (opts.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.email)) { $("fw_err").textContent = "That email address doesn't look right."; return null; }
  return opts;
}
async function makeFillWeb() {
  const opts = fwOpts(); if (!opts) return;
  $("fw_err").textContent = ""; $("fw_go").disabled = true; toast("Building the fill-in page…");
  try {
    snapshotNow();
    const { html } = await buildFillPage(opts);
    download(baseName() + "-fill-and-sign.html", new Blob([html], { type: "text/html" }));
    $("fillweb").close();
    toast("Saved " + baseName() + "-fill-and-sign.html — send it, or publish it as a link.");
  } catch (e) { $("fw_err").textContent = "Could not build the page: " + (e.message || e); }
  finally { $("fw_go").disabled = false; }
}
async function publishFillWeb() {
  const opts = fwOpts(); if (!opts) return;
  const token = fwToken();
  if (!token) { $("fw_err").textContent = "Enter a GitHub token (see “How to get a token”)."; return; }
  if (!$("fw_public_ok").checked) { $("fw_err").textContent = "Tick the box to confirm the page may be public."; return; }
  const set = { repo: $("fw_repo").value.trim(), folder: $("fw_folder").value.trim() || "web/f", base: $("fw_base").value.trim() };
  if (!/^[\w.-]+\/[\w.-]+$/.test(set.repo) || !/^https:\/\//.test(set.base)) { $("fw_err").textContent = "Check the repository (owner/name) and the site address."; return; }
  lsSet(GH_KEY, { ...set, ...($("fw_remember").checked ? { token } : {}) });
  $("fw_err").textContent = ""; $("fw_pub").disabled = true; $("fw_link").textContent = "Building and publishing…";
  try {
    snapshotNow();
    const { id, html } = await buildFillPage(opts);
    const url = await ghPublish(id, html, opts.title, token);
    renderPublished();
    $("fw_link").innerHTML = "";
    const a = mk("a", { href: url, target: "_blank", rel: "noopener" }, escapeHTML(url));
    const cp = mk("button", { className: "btn", type: "button", style: "width:auto;margin-left:8px" }, "Copy link"); cp.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(url); toast("Link copied."); };
    const status = mk("div", { className: "note", style: "margin:4px 0 0" }, "Publishing… the link goes live when the site finishes redeploying (usually about a minute).");
    $("fw_link").append(a, cp, status);
    for (let i = 0; i < 24; i++) {             // watch for it to go live (up to 4 minutes)
      await new Promise((r) => setTimeout(r, 10000));
      try { const h = await fetch(url, { method: "HEAD", cache: "no-store" }); if (h.ok) { status.textContent = "Live — send this link to the person who should fill it in."; break; } } catch (_) {}
      if (i === 23) status.textContent = "Not live yet — check the repository's Actions tab if it doesn't appear in a few minutes.";
    }
  } catch (e) { $("fw_link").textContent = ""; $("fw_err").textContent = "Could not publish: " + (e.message || e); }
  finally { $("fw_pub").disabled = false; }
}

// ---- form view in the editor: every field as a plain list on the right, kept in step with the page ----
let formColOn = false, formColSig = "", formColTimer = 0;
function setFormCol(on) {
  formColOn = !!on; document.body.classList.toggle("formcol-open", formColOn);
  $("formcol_btn") && $("formcol_btn").classList.toggle("on", formColOn);
  if (formColOn) { formColSig = ""; renderFormCol(); }
}
function fieldPageEl(f) {
  if (f.src === "item") return document.querySelector(`#ed_pages .ditem[data-id="${f.id}"]`);
  const sel = `#ed_pages .pg[data-page="${f.page}"] .dfield[data-fname="${CSS.escape(f.name)}"]` + (f.type === "radio" ? `[data-fval="${CSS.escape(String(f.value))}"]` : "");
  return document.querySelector(sel);
}
function flashField(f) {
  const el = fieldPageEl(f); if (!el) { setCurPage && setCurPage(f.page, true); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("fc-hl"); setTimeout(() => el.classList.remove("fc-hl"), 1400);
}
function fieldValue(f) {
  if (f.src === "pdf") return fieldValues[f.name];
  const it = docItems.find((x) => x.id === f.id); if (!it) return "";
  return f.type === "check" ? !!it.checked : (it.text || "");
}
function setFieldValue(f, v) {
  if (f.src === "pdf") fieldValues[f.name] = v;
  else { const it = docItems.find((x) => x.id === f.id); if (!it) return; if (f.type === "check") it.checked = !!v; else { it.text = v; if (it.isDate) it.date = v; } }
  clearTimeout(formColTimer); formColTimer = setTimeout(() => { render(); scheduleSnapshot(); }, 180);
}
async function renderFormCol() {
  const host = $("formcol_list"); if (!host || !formColOn) return;
  if (!doc) { host.innerHTML = '<div class="note">Open a form to fill it in here.</div>'; formColSig = ""; return; }
  const fields = collectFillFields(), sig = fields.map((f) => f.id + f.type).join("|") + "|" + docPages.length;
  if (sig === formColSig) { syncFormColValues(); return; }
  formColSig = sig;
  await labelFields(fields);
  host.innerHTML = "";
  if (!fields.length) { host.innerHTML = '<div class="note">No fillable fields in this document. Add them with <b>Form fields</b>, or <b>Find fields on all pages</b>.</div>'; return; }
  let lastPage = -1; const radios = new Set();
  for (const f of fields) {
    if (f.page !== lastPage) { lastPage = f.page; host.appendChild(mk("div", { className: "fc-page" }, "Page " + (f.page + 1))); }
    if (f.type === "radio") {
      if (radios.has(f.page + ":" + f.name)) continue; radios.add(f.page + ":" + f.name);
      const opts = fields.filter((g) => g.type === "radio" && g.name === f.name);
      const row = mk("div", { className: "fc-row" }); row.dataset.fid = f.id; if (f.src === "pdf") row.dataset.fname = f.name;
      row.appendChild(mk("div", { className: "fc-l" }, escapeHTML(prettyName(f.name) || f.label)));
      const box = mk("div", { className: "fc-radios" });
      opts.forEach((o) => {
        const lab = mk("label"), r = mk("input", { type: "radio", name: "fc_" + f.name }); r.dataset.fid = o.id; r.checked = fieldValue(o) === o.value;
        r.onchange = () => { if (r.checked) setFieldValue(o, o.value); }; r.onfocus = () => flashField(o);
        lab.append(r, document.createTextNode(" " + (o.label || o.value))); box.appendChild(lab);
      });
      row.appendChild(box); host.appendChild(row); continue;
    }
    const row = mk("div", { className: "fc-row" + (f.type === "check" ? " fc-check" : "") }); row.dataset.fid = f.id; if (f.src === "pdf") row.dataset.fname = f.name;
    let ctl;
    if (f.type === "check") { ctl = mk("input", { type: "checkbox" }); ctl.checked = !!fieldValue(f); ctl.onchange = () => setFieldValue(f, ctl.checked); }
    else if (f.type === "choice") { ctl = mk("select"); ctl.appendChild(new Option("", "")); (f.options || []).forEach(([v, l]) => ctl.appendChild(new Option(l, v))); ctl.value = fieldValue(f) || ""; ctl.onchange = () => setFieldValue(f, ctl.value); }
    else if (f.type === "sig") {
      ctl = mk("button", { className: "btn", type: "button" }, "✒ Sign here");
      ctl.onclick = () => { flashField(f); setEdMode("sign"); setEdTool("sig"); toast("Click inside the highlighted signature box to sign."); };
    } else { ctl = mk("input", { type: "text", placeholder: f.type === "date" ? "Date" : "" }); ctl.value = fieldValue(f) || ""; ctl.oninput = () => setFieldValue(f, ctl.value); }
    ctl.dataset.fid = f.id; ctl.onfocus = () => flashField(f);
    if (ctl.tagName === "INPUT" || ctl.tagName === "SELECT") ctl.onkeydown = (e) => e.stopPropagation();
    const lab = mk("label", { className: "fc-l" }, escapeHTML(f.label));
    if (f.type === "check") row.append(ctl, lab); else row.append(lab, ctl);
    lab.onclick = () => { if (f.type !== "check") ctl.focus(); };
    host.appendChild(row);
  }
}
// values typed on the page show up in the column (the field being typed in is left alone)
function syncFormColValues() {
  if (!formColOn) return;
  const fields = collectFillFields(), byId = new Map(fields.map((f) => [f.id, f]));
  document.querySelectorAll("#formcol_list [data-fid]").forEach((el) => {
    if (el === document.activeElement || el.classList.contains("fc-row")) return;
    const f = byId.get(el.dataset.fid); if (!f) return;
    const v = fieldValue(f);
    if (el.type === "checkbox") el.checked = !!v; else if (el.type === "radio") el.checked = v === f.value; else if (el.tagName !== "BUTTON") el.value = v || "";
  });
}
function highlightFormRow(key) {
  if (!formColOn) return;
  const k = CSS.escape(String(key)), row = document.querySelector(`#formcol_list .fc-row[data-fname="${k}"], #formcol_list .fc-row[data-fid="${k}"]`); if (!row) return;
  const r = row.closest(".fc-row") || row; r.scrollIntoView({ block: "nearest" }); r.classList.add("fc-on"); setTimeout(() => r.classList.remove("fc-on"), 1200);
}

const FILL_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#eef1f6;--card:#fff;--text:#1a2133;--muted:#5d677d;--line:#d5dbe6;--acc:#2b6cff;--req:#e5484d;--hl:rgba(255,196,0,.35)}
@media (prefers-color-scheme:dark){:root{--bg:#10131b;--card:#1a1f2b;--text:#e8ecf4;--muted:#9aa4b8;--line:#2e3647}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;flex-direction:column}
header{flex:none;background:var(--card);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:17px;margin:0;flex:1;min-width:160px}header .prog{color:var(--muted);font-size:13px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text);padding:8px 14px}
button.p{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.wrap{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,400px)}
.doc{overflow:auto;padding:16px}
.side{overflow:auto;background:var(--card);border-left:1px solid var(--line);padding:14px 16px 40px}
.side h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px}
.side .note{color:var(--muted);font-size:13px;margin:0 0 8px}
.row{padding:8px 10px;border-radius:8px;margin:0 -10px;transition:background .3s}
.row.on{background:var(--hl)}
.row label.l{display:block;font-weight:600;font-size:13.5px;margin-bottom:3px}
.row input[type=text],.row select,#who{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text)}
.row.ck{display:flex;gap:8px;align-items:flex-start}.row.ck label.l{font-weight:500;margin:0}
.row.ck input{width:18px;height:18px;margin-top:2px;flex:none}
.radios label{display:block;font-size:14px}
.sigbtn{display:flex;align-items:center;gap:10px}.sigbtn img{max-height:44px;max-width:180px;background:#fff;border-radius:4px}
.row.req.empty .sigbtn button{border-color:var(--req);color:var(--req)}
.pg{position:relative;margin:0 auto 16px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.18);width:100%}
.pg img.bg{display:block;width:100%;height:auto;user-select:none;pointer-events:none}
.f{position:absolute;border:1.5px solid rgba(43,108,255,.6);background:rgba(43,108,255,.08);border-radius:3px;color:#10182b;transition:box-shadow .3s}
.f.req.empty{border-color:var(--req);background:rgba(229,72,77,.08)}
.f.on{box-shadow:0 0 0 4px var(--hl)}
.f input[type=text],.f select{width:100%;height:100%;border:0;background:transparent;font:inherit;color:#10182b;padding:0 3px;outline:none}
.f input[type=checkbox],.f input[type=radio]{width:100%;height:100%;margin:0;accent-color:#10182b}
.f.sig{cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px;color:#2b6cff;font-weight:600}
.f.sig img{max-width:100%;max-height:100%}
.f:focus-within{box-shadow:0 0 0 3px rgba(43,108,255,.35)}
dialog{border:0;border-radius:12px;padding:16px;width:min(620px,94vw);background:var(--card);color:var(--text)}
dialog::backdrop{background:rgba(5,8,15,.55)}
.tabs{display:flex;gap:6px;margin-bottom:10px}.tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}
canvas{width:100%;height:190px;border:1px dashed var(--line);border-radius:8px;background:#fff;touch-action:none;display:block}
.btns{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}
#typed{width:100%;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
.done{border-top:1px solid var(--line);padding-top:10px;margin-top:14px;display:none}
.vt{display:none}
@media (max-width:820px){.wrap{display:block;overflow:auto}.side{border-left:0;border-bottom:1px solid var(--line)}.doc{overflow:visible}.wrap{order:0}.side{order:-1}.vt{display:inline-block}body.hidedoc .doc{display:none}}
</style></head><body>
<header><h1 id="t"></h1><span class="prog" id="prog"></span><button class="vt" id="vt">Hide document</button><button class="p" id="finish">Finish &amp; download signed PDF</button></header>
<div class="wrap">
<section class="doc" id="pages" aria-label="Document"></section>
<aside class="side" aria-label="Form">
<p class="note" id="note"></p>
<div class="row"><label class="l" for="who">Your full name</label><input id="who" autocomplete="name" placeholder="Name as you sign"></div>
<p class="note">Fill in the form here or on the document — both stay in step. Click a signature to sign, then press Finish. Everything stays in your browser until you send the PDF back.</p>
<div id="form"></div>
<div class="done" id="done"></div>
</aside></div>
<dialog id="pad"><div class="tabs"><button class="on" data-m="draw">Draw</button><button data-m="type">Type</button></div>
<input id="typed" placeholder="Type your name" style="display:none"><canvas id="cv"></canvas>
<div class="btns"><button id="clr">Clear</button><button id="cancel">Cancel</button><button class="p" id="use">Use this signature</button></div></dialog>
<script type="application/json" id="data">__DATA__</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent), V={}, KEY='ghostfill_'+D.id;
try{V=JSON.parse(localStorage.getItem(KEY)||'{}')||{}}catch(e){}
function store(){try{localStorage.setItem(KEY,JSON.stringify(V))}catch(e){}prog()}
var $=function(i){return document.getElementById(i)};
$('t').textContent=D.title;document.title=D.title;
if(D.note)$('note').textContent=D.note;else $('note').style.display='none';
$('who').value=V.__who||'';$('who').oninput=function(){V.__who=$('who').value;store()};
var today=new Date().toLocaleDateString(),byId={},onPage={},inSide={};
D.fields.forEach(function(f){byId[f.id]=f;if(V[f.id]==null){if(f.type==='date')V[f.id]=today;else if(f.type==='check')V[f.id]=!!f.pre;else if(f.type==='radio')V[f.id]=f.pre===f.value?f.value:'';else V[f.id]=f.pre||''}});
/* one value per field, shown in two places */
function set(id,v,from){var f=byId[id];if(f.type==='radio'){D.fields.forEach(function(g){if(g.type==='radio'&&g.name===f.name&&g.page===f.page)V[g.id]=g.id===id&&v?f.value:''})}else V[id]=v;
 store();D.fields.forEach(function(g){if(g.id===id||(f.type==='radio'&&g.type==='radio'&&g.name===f.name))paint(g.id,from)})}
function paint(id,skip){var f=byId[id],v=V[id];[onPage[id],inSide[id]].forEach(function(el){if(!el||el===skip)return;
 if(f.type==='check')el.checked=!!v;else if(f.type==='radio')el.checked=v===f.value;else if(f.type==='sig'){showSig(el,v)}else el.value=v||''})}
function showSig(el,v){if(el.classList.contains('f')){el.textContent=v?'':'Click to sign';if(v){var i=new Image();i.src=v;el.appendChild(i)}}else{var b=el.querySelector('span');b.innerHTML='';if(v){var i2=new Image();i2.src=v;b.appendChild(i2)}el.querySelector('button').textContent=v?'Sign again':'✒ Sign'}}
function hl(id){var f=byId[id],a=onPage[id],r=inSide[id]&&inSide[id].closest('.row');
 if(a){a.scrollIntoView({behavior:'smooth',block:'center'});a.classList.add('on');setTimeout(function(){a.classList.remove('on')},1300)}
 if(r){r.classList.add('on');setTimeout(function(){r.classList.remove('on')},1300)}}
function hlSide(id){var r=inSide[id]&&inSide[id].closest('.row');if(!r)return;r.scrollIntoView({behavior:'smooth',block:'nearest'});r.classList.add('on');setTimeout(function(){r.classList.remove('on')},1300)}
/* the document */
D.pages.forEach(function(p,pi){var d=document.createElement('div');d.className='pg';d.style.maxWidth=Math.round(p.w*1.6)+'px';
 var im=document.createElement('img');im.className='bg';im.src=p.img;im.alt='Page '+(pi+1);d.appendChild(im);
 D.fields.filter(function(f){return f.page===pi}).forEach(function(f){
  var b=document.createElement('div');b.className='f'+(f.type==='sig'?' sig req':'');b.title=f.label||'';
  b.style.left=f.x*100+'%';b.style.top=f.y*100+'%';b.style.width=f.w*100+'%';b.style.height=f.h*100+'%';
  var el;
  if(f.type==='check'){el=document.createElement('input');el.type='checkbox';el.onchange=function(){set(f.id,el.checked,el)};b.style.background='transparent'}
  else if(f.type==='radio'){el=document.createElement('input');el.type='radio';el.name='r'+pi+'_'+f.name;el.onchange=function(){if(el.checked)set(f.id,true,el)};b.style.background='transparent'}
  else if(f.type==='choice'){el=document.createElement('select');el.appendChild(new Option('',''));(f.options||[]).forEach(function(o){el.appendChild(new Option(o[1],o[0]))});el.onchange=function(){set(f.id,el.value,el)}}
  else if(f.type==='sig'){el=b;b.onclick=function(){openPad(f)}}
  else{el=document.createElement('input');el.type='text';el.oninput=function(){set(f.id,el.value,el)}}
  if(el!==b)b.appendChild(el);onPage[f.id]=el;
  (el===b?b:el).addEventListener('focus',function(){hlSide(f.id)});b.addEventListener('click',function(){hlSide(f.id)});
  d.appendChild(b)});
 $('pages').appendChild(d)});
/* the form column */
var form=$('form'),lastPage=-1,seenRadio={};
D.fields.forEach(function(f){
 if(D.pages.length>1&&f.page!==lastPage){lastPage=f.page;var h=document.createElement('h2');h.textContent='Page '+(f.page+1);form.appendChild(h)}
 var row=document.createElement('div');row.className='row';var lab=document.createElement('label');lab.className='l';lab.textContent=f.label||'Field';
 if(f.type==='radio'){var k=f.page+':'+f.name;if(seenRadio[k])return;seenRadio[k]=1;lab.textContent=(f.name||'').replace(/[_.]+/g,' ');row.appendChild(lab);var box=document.createElement('div');box.className='radios';
  D.fields.filter(function(g){return g.type==='radio'&&g.name===f.name&&g.page===f.page}).forEach(function(g){var l=document.createElement('label'),r=document.createElement('input');r.type='radio';r.name='s'+k;r.onchange=function(){if(r.checked)set(g.id,true,r)};r.onfocus=function(){hl(g.id)};l.appendChild(r);l.appendChild(document.createTextNode(' '+(g.label||g.value)));box.appendChild(l);inSide[g.id]=r});
  row.appendChild(box);form.appendChild(row);return}
 var el;
 if(f.type==='check'){row.className='row ck';el=document.createElement('input');el.type='checkbox';el.id='s_'+f.id;lab.htmlFor=el.id;el.onchange=function(){set(f.id,el.checked,el)};row.appendChild(el);row.appendChild(lab)}
 else if(f.type==='sig'){row.className='row req';row.appendChild(lab);el=document.createElement('div');el.className='sigbtn';var bt=document.createElement('button');bt.type='button';bt.textContent='✒ Sign';bt.onclick=function(){openPad(f)};el.appendChild(bt);el.appendChild(document.createElement('span'));row.appendChild(el);bt.onfocus=function(){hl(f.id)}}
 else{if(f.type==='choice'){el=document.createElement('select');el.appendChild(new Option('',''));(f.options||[]).forEach(function(o){el.appendChild(new Option(o[1],o[0]))});el.onchange=function(){set(f.id,el.value,el)}}
  else{el=document.createElement('input');el.type='text';el.oninput=function(){set(f.id,el.value,el)}}
  el.id='s_'+f.id;lab.htmlFor=el.id;row.appendChild(lab);row.appendChild(el)}
 if(f.type!=='sig')el.addEventListener('focus',function(){hl(f.id)});
 inSide[f.id]=el;form.appendChild(row)});
D.fields.forEach(function(f){paint(f.id)});
function sizeText(){document.querySelectorAll('.pg .f').forEach(function(b){b.style.fontSize=Math.max(9,Math.min(b.clientHeight*0.62,22))+'px'})}
addEventListener('resize',sizeText);addEventListener('load',sizeText);setTimeout(sizeText,50);
function prog(){var sig=D.fields.filter(function(f){return f.type==='sig'}),left=sig.filter(function(f){return !V[f.id]}).length;
 sig.forEach(function(f){onPage[f.id]&&onPage[f.id].classList.toggle('empty',!V[f.id]);var r=inSide[f.id]&&inSide[f.id].closest('.row');r&&r.classList.toggle('empty',!V[f.id])});
 $('prog').textContent=sig.length?(left?left+' signature'+(left>1?'s':'')+' left':'All signed'):''}
prog();
$('vt').onclick=function(){document.body.classList.toggle('hidedoc');$('vt').textContent=document.body.classList.contains('hidedoc')?'Show document':'Hide document'};
/* signature pad */
var cv=$('cv'),g=cv.getContext('2d'),mode='draw',strokes=[],cur=null,target=null;
function fit(){var r=cv.getBoundingClientRect(),k=devicePixelRatio||1;cv.width=r.width*k;cv.height=r.height*k;g.setTransform(k,0,0,k,0,0);draw()}
function draw(){var r=cv.getBoundingClientRect();g.clearRect(0,0,r.width,r.height);g.strokeStyle='#c9d0dc';g.lineWidth=1;g.beginPath();g.moveTo(20,r.height-40);g.lineTo(r.width-20,r.height-40);g.stroke();
 g.strokeStyle=g.fillStyle='#1b2a6b';g.lineCap=g.lineJoin='round';
 if(mode==='type'){var t=$('typed').value.trim(),h=58;g.font='italic '+h+'px "Segoe Script","Brush Script MT","Snell Roundhand",cursive';while(t&&g.measureText(t).width>r.width-40&&h>16){h-=2;g.font='italic '+h+'px "Segoe Script","Brush Script MT","Snell Roundhand",cursive'}if(t)g.fillText(t,20,r.height-48);return}
 strokes.forEach(function(s){for(var i=1;i<s.length;i++){g.lineWidth=s[i].w;g.beginPath();g.moveTo(s[i-1].x,s[i-1].y);g.lineTo(s[i].x,s[i].y);g.stroke()}})}
function pt(e){var r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top,t:e.timeStamp}}
cv.onpointerdown=function(e){if(mode!=='draw')return;cv.setPointerCapture(e.pointerId);var p=pt(e);p.w=2.6;cur=[p];strokes.push(cur);draw()};
cv.onpointermove=function(e){if(!cur)return;var p=pt(e),l=cur[cur.length-1],d=Math.hypot(p.x-l.x,p.y-l.y);if(d<1.2)return;var v=d/Math.max(1,p.t-l.t);p.w=l.w*.6+Math.max(1.1,Math.min(3.4,3.6-v*1.4))*.4;cur.push(p);draw()};
cv.onpointerup=cv.onpointercancel=function(){cur=null};
document.querySelectorAll('.tabs button').forEach(function(b){b.onclick=function(){mode=b.dataset.m;document.querySelectorAll('.tabs button').forEach(function(x){x.classList.toggle('on',x===b)});$('typed').style.display=mode==='type'?'':'none';if(mode==='type'&&!$('typed').value)$('typed').value=$('who').value;draw()}});
$('typed').oninput=draw;$('clr').onclick=function(){strokes=[];$('typed').value='';draw()};$('cancel').onclick=function(){$('pad').close()};
function openPad(f){target=f;strokes=[];hl(f.id);$('pad').showModal();requestAnimationFrame(fit)}
$('use').onclick=function(){
 if(mode==='draw'&&!strokes.length||mode==='type'&&!$('typed').value.trim()){alert('Sign in the box first.');return}
 var r=cv.getBoundingClientRect(),x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
 if(mode==='draw')strokes.forEach(function(s){s.forEach(function(p){x0=Math.min(x0,p.x);y0=Math.min(y0,p.y);x1=Math.max(x1,p.x);y1=Math.max(y1,p.y)})});else{x0=10;y0=10;x1=r.width-10;y1=r.height-30}
 var pad=8,k=devicePixelRatio||1,c=document.createElement('canvas');c.width=(x1-x0+pad*2)*k;c.height=(y1-y0+pad*2)*k;c.getContext('2d').drawImage(cv,(x0-pad)*k,(y0-pad)*k,c.width,c.height,0,0,c.width,c.height);
 var cx=c.getContext('2d'),id=cx.getImageData(0,0,c.width,c.height),q=id.data;for(var i=0;i<q.length;i+=4){if((q[i]+q[i+1]+q[i+2])/3>235)q[i+3]=0}cx.putImageData(id,0,0);
 set(target.id,c.toDataURL('image/png'));$('pad').close()};
/* finish: build the signed PDF in the browser */
function loadLib(){return window.PDFLib?Promise.resolve():new Promise(function(res,rej){var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';s.onload=res;s.onerror=function(){rej(new Error('Could not load the PDF maker - check the internet connection.'))};document.head.appendChild(s)})}
function u8(url){var b=atob(url.split(',')[1]),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
$('finish').onclick=function(){
 var who=$('who').value.trim(),miss=D.fields.filter(function(f){return f.type==='sig'&&!V[f.id]});
 if(!who){$('who').focus();alert('Please type your full name first.');return}
 if(miss.length){hl(miss[0].id);hlSide(miss[0].id);alert(miss.length+' signature'+(miss.length>1?'s are':' is')+' still missing.');return}
 $('finish').disabled=true;$('finish').textContent='Building the PDF…';
 loadLib().then(async function(){
  var L=PDFLib,pdf=await L.PDFDocument.create(),font=await pdf.embedFont(L.StandardFonts.Helvetica),when=new Date();
  for(var pi=0;pi<D.pages.length;pi++){var P=D.pages[pi],pg=pdf.addPage([P.w,P.h]);pg.drawImage(await pdf.embedJpg(u8(P.img)),{x:0,y:0,width:P.w,height:P.h});
   for(var f of D.fields.filter(function(f){return f.page===pi})){var x=f.x*P.w,w=f.w*P.w,h=f.h*P.h,y=P.h-f.y*P.h-h,v=V[f.id],ink=L.rgb(.06,.09,.17);
    if(f.type==='check'){if(v){var s=Math.min(w,h);pg.drawText('X',{x:x+s*.18,y:y+s*.15,size:s*.85,font:font,color:ink})}}
    else if(f.type==='radio'){if(v&&v===f.value)pg.drawCircle({x:x+w/2,y:y+h/2,size:Math.min(w,h)*.28,color:ink})}
    else if(f.type==='sig'){if(v){var im=await pdf.embedPng(u8(v)),k=Math.min(w/im.width,h/im.height);pg.drawImage(im,{x:x+(w-im.width*k)/2,y:y+(h-im.height*k)/2,width:im.width*k,height:im.height*k})}}
    else{var t=String(v||'');if(f.type==='choice'){var o=(f.options||[]).find(function(o){return o[0]===t});if(o)t=o[1]}
     if(t){var sz=Math.min(h*.68,12);while(sz>5&&font.widthOfTextAtSize(t,sz)>w-4)sz-=.5;pg.drawText(t,{x:x+2,y:y+(h-sz)/2+sz*.18,size:sz,font:font,color:ink})}}}}
  var last=pdf.getPage(pdf.getPageCount()-1);last.drawText('Completed and signed electronically by '+who+' on '+when.toLocaleString()+' (Ghost Calligrapher fill-in page).',{x:18,y:8,size:6.5,font:font,color:L.rgb(.35,.38,.45)});
  pdf.setTitle(D.title);pdf.setAuthor(who);
  var bytes=await pdf.save(),name=D.file+'-signed-'+who.replace(/[^\\w]+/g,'-')+'.pdf',a=document.createElement('a');a.href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));a.download=name;document.body.appendChild(a);a.click();
  var done=$('done');done.style.display='block';done.innerHTML='';var p1=document.createElement('p');p1.textContent='Saved '+name+' to your downloads.';done.appendChild(p1);
  if(D.email){var p2=document.createElement('p');p2.textContent='Send it back to '+D.email+': ';var m=document.createElement('a');m.href='mailto:'+encodeURIComponent(D.email)+'?subject='+encodeURIComponent('Signed: '+D.title)+'&body='+encodeURIComponent('Hi,\\n\\nThe signed form is attached ('+name+').\\n\\n'+who);m.textContent='open an email';p2.appendChild(m);p2.appendChild(document.createTextNode(' and attach the PDF.'));done.appendChild(p2)}
  done.scrollIntoView({behavior:'smooth'});
 }).catch(function(e){alert(e.message||e)}).then(function(){$('finish').disabled=false;$('finish').textContent='Finish & download signed PDF'})};
})();
</script></body></html>`;

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
  // PDF libraries: fetched in the background once the page is idle, or sooner if the user reaches for open/download
  warmPdfLibs();
  ["upload_btn", "pe_open", "dl_go", "dl_format"].forEach((id) => prefetchOn($(id), pdfjsReady, pdfLibReady));
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
    handHistory.push(seedVal());
    $("seed").value = v === "r" ? Math.floor(Math.random() * 1e9) : v;
    rememberLastStyle();
    const it = selectedItem();
    if (it && it.type === "sig" && it.dynamic) regenItem(it, seedVal()); else render(true);
  });
  $("paper_style").addEventListener("change", () => render());
  $("reroll").addEventListener("click", newHand);
  $("last_hand").addEventListener("click", lastHand);
  $("save_hand").addEventListener("click", saveHand);
  $("fw_go").onclick = makeFillWeb; $("fw_cancel").onclick = () => $("fillweb").close(); $("fw_pub").onclick = publishFillWeb;
  $("fw_forget").onclick = () => { const st = lsGet(GH_KEY, {}); delete st.token; lsSet(GH_KEY, st); $("fw_token").value = ""; $("fw_token").placeholder = "github_pat_…"; $("fw_remember").checked = false; toast("Token removed from this browser."); };
  $("formcol_btn").onclick = () => setFormCol(!formColOn); $("formcol_x").onclick = () => setFormCol(false);
  $("styles_export").onclick = $("sigs_export").onclick = () => openMgr();
  $("styles_import").onclick = $("sigs_import").onclick = () => openMgr("import");
  $("mg_file").onchange = () => { const f = $("mg_file").files; if (f && f.length) mgrImportFiles(f); $("mg_file").value = ""; };
  $("mg_pick").onclick = () => $("mg_file").click();
  $("mg_close").onclick = () => $("sigmgr").close();
  $("mg_export").onclick = exportSelected; $("mg_pics").onclick = exportSelectedPictures;
  document.querySelectorAll("[data-mgall]").forEach((b) => b.onclick = () => { const box = $(b.dataset.mgall), cbs = [...box.querySelectorAll("input[type=checkbox]")], on = !cbs.every((c) => c.checked); cbs.forEach((c) => c.checked = on); });
  document.querySelectorAll("[data-picbg]").forEach((b) => b.onclick = () => { setPicBg(b.dataset.picbg); render(); });
  syncPicBgUI(); toggles.transparent = picBg() === "none";
  // files dropped on the saved lists or the manager are imported (pictures of a signature are traced)
  ["sig_saved", "saved_hands", "mg_drop"].forEach((id) => { const z = $(id); if (!z) return;
    z.addEventListener("dragover", (e) => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); z.classList.add("mg-over"); } });
    z.addEventListener("dragleave", () => z.classList.remove("mg-over"));
    z.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); z.classList.remove("mg-over"); const f = [...(e.dataTransfer.files || [])]; if (!f.length) return; if (!$("sigmgr").open) openMgr(); mgrImportFiles(f); }); });
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
    if (!isPdfFile(f) && window.__cal2IsNativeFile && !window.__cal2IsNativeFile(f) && window.__cal2ImportAny) { window.__cal2ImportAny([f], { open: async (fs) => { await addFilesToDoc(fs); if (!location.hash.startsWith("#/edit")) location.hash = "#/edit"; } }); return; }
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
  // download panel: format, look, quality (remembered)
  const META = ["title", "author", "subject", "keywords"];
  const dlSync = () => {
    ["dl_format", "dl_look", "dl_quality", "dl_engine"].forEach((id) => { $(id).value = dlOpts[id.slice(3)]; });
    const f = dlOpts.format, pictureish = f === "pdf" || f === "png" || f === "jpg" || f === "zip";
    $("dl_look_row").style.display = pictureish ? "" : "none";
    $("dl_quality_row").style.display = f === "fill" || f === "docx" || f === "txt" ? "none" : "";
    // the engine only matters when pages get a scanned look in the worker pool (multi-page PDF / zip)
    $("dl_engine_row").style.display = (f === "pdf" || f === "zip") && dlOpts.look !== "clean" && scanWorkersSupported() ? "" : "none";
    $("dl_meta_row").style.display = f === "pdf" || f === "fill" ? "" : "none";
    const m = dlOpts.meta || (dlOpts.meta = {});
    META.forEach((k) => { $("dl_meta_" + k).value = m[k] || ""; });
    $("dl_meta_strip").checked = !!m.strip;
    // More options: which rows apply to this format
    const mo = dlMore(), docLike = f !== "png" && f !== "jpg", isPdf = f === "pdf" || f === "fill", inDoc = workMode === "doc" && !!doc;
    $("dl_pages").value = mo.pages; $("dl_range").value = mo.range; $("dl_skipblank").checked = !!mo.skipBlank; $("dl_paper").value = mo.paper;
    $("dl_turn").value = mo.turn; $("dl_num").value = mo.num; $("dl_wm").value = mo.wm; $("dl_wmtext").value = mo.wmtext; $("dl_dpi").value = mo.dpi; $("dl_name").value = mo.name;
    const show = (id, on) => { $(id).style.display = on ? "" : "none"; };
    show("dl_pages_row", docLike && inDoc); show("dl_range_row", docLike && inDoc && mo.pages === "custom"); show("dl_skipblank_row", docLike && inDoc && mo.pages !== "cur");
    show("dl_paper_row", f === "pdf"); show("dl_turn_row", isPdf); show("dl_num_row", isPdf); show("dl_wm_row", isPdf); show("dl_wmtext_row", isPdf && mo.wm === "custom");
    show("dl_dpi_row", f === "png" || f === "jpg" || f === "zip");
    const ext = { pdf: "pdf", fill: "pdf", docx: "docx", png: "png", jpg: "jpg", zip: "zip", txt: "txt" }[f];
    $("dl_name").placeholder = (inDoc ? baseName() + ({ pdf: "-edited", fill: "-editable", zip: "-pages", png: `-page${curPage + 1}`, jpg: `-page${curPage + 1}` }[f] || "") : "calligraphy") + "." + ext;
    const changed = Object.keys(DL_MORE).filter((k) => String(mo[k]) !== String(DL_MORE[k]) && k !== "range" && k !== "wmtext").length;
    $("dl_more_count").textContent = changed ? ` · ${changed} set` : "";
    $("dl_hint").textContent = {
      pdf: dlOpts.look === "clean" ? (dlOpts.quality === "small" ? "Smallest file: whichever is smaller — your pages as they are, or compressed pictures of them." : "Your pages stay exactly as they are (sharp, selectable text); edits and filled fields are added on top in high resolution.") : "Pages are saved as pictures with this look.",
      zip: "Every page as a picture in one .zip — PNG for Exact (clean look), JPG otherwise.",
      txt: "The document's text, page by page (scanned pages are read with OCR).",
      fill: "Real text kept; form fields and comments stay editable.",
      docx: "An editable Word document; scanned pages are read with OCR.",
      png: "The current page as a picture, sharp (300 dpi, lossless).",
      jpg: "The current page as a picture (smaller than PNG).",
    }[f];
  };
  ["dl_format", "dl_look", "dl_quality", "dl_engine"].forEach((id) => { $(id).onchange = () => { dlOpts[id.slice(3)] = $(id).value; lsSet(DL_KEY, dlOpts); dlSync(); if (id === "dl_engine" && dlOpts.engine === "realistic") warmRealistic(); }; });
  META.forEach((k) => { $("dl_meta_" + k).oninput = () => { (dlOpts.meta || (dlOpts.meta = {}))[k] = $("dl_meta_" + k).value; lsSet(DL_KEY, dlOpts); }; });
  $("dl_meta_strip").onchange = () => { (dlOpts.meta || (dlOpts.meta = {})).strip = $("dl_meta_strip").checked; lsSet(DL_KEY, dlOpts); };
  const setMore = (k, v, resync = true) => { (dlOpts.more || (dlOpts.more = {}))[k] = v; lsSet(DL_KEY, dlOpts); if (resync) dlSync(); };
  [["dl_pages", "pages"], ["dl_paper", "paper"], ["dl_turn", "turn"], ["dl_num", "num"], ["dl_wm", "wm"], ["dl_dpi", "dpi"]].forEach(([id, k]) => { $(id).onchange = () => setMore(k, $(id).value); });
  [["dl_range", "range"], ["dl_wmtext", "wmtext"], ["dl_name", "name"]].forEach(([id, k]) => { $(id).oninput = () => setMore(k, $(id).value, false); $(id).onchange = () => dlSync(); });
  $("dl_skipblank").onchange = () => setMore("skipBlank", $("dl_skipblank").checked);
  $("dl_more_reset").onclick = () => { dlOpts.more = {}; lsSet(DL_KEY, dlOpts); dlSync(); };
  $("dl_panel").addEventListener("click", (e) => e.stopPropagation());
  document.querySelector('[data-ddbtn="dl"]')?.addEventListener("click", () => dlSync());   // page-dependent hints (file name) stay current
  // ---- live preview: the first page exactly as it will be saved, rebuilt whenever a setting changes ----
  let prevTok = 0, prevTimer = 0, prevRun = null, dlBusy = false, lastPrev = null;
  const panelOpen = () => !!document.querySelector('[data-dd="dl"].open');
  const runExport = async (f) => {
    exportLook = (f === "pdf" || f === "png" || f === "jpg" || f === "zip") ? dlOpts.look : null;
    try {
      if (f === "pdf") await exportPDF();
      else if (f === "fill") await exportFillablePDF();
      else if (f === "docx") await exportWord();
      else if (f === "zip") await exportAllImages();
      else if (f === "txt") await exportText();
      else await exportPNG(f);
    } finally { exportLook = null; }
  };
  const drawPreview = async (tok) => {
    const box = $("dl_prev"), cv = $("dl_prev_c"), meta = $("dl_prev_meta"), f = dlOpts.format;
    if (f === "docx" || f === "txt") { box.classList.add("none"); meta.textContent = f === "docx" ? "Word files open in Word - no picture preview." : "A text file - no picture preview."; return; }
    box.classList.remove("none"); box.classList.add("busy"); meta.textContent = "Building the preview…";
    const cap = dlCapture = { blob: null, name: "", msg: "", total: 0 };
    try {
      await runExport(f);
      for (let i = 0; i < 60 && !cap.blob && !cap.msg; i++) await new Promise((r) => setTimeout(r, 50));   // pictures arrive a moment later
    } finally { dlCapture = null; }
    if (tok !== prevTok) return;
    box.classList.remove("busy");
    if (!cap.blob) { meta.textContent = cap.msg || "Nothing to preview yet."; cv.width = cv.height = 0; return; }
    let src = cap.blob, pageW = 0, pageH = 0, rot = 0;
    lastPrev = { blob: cap.blob, name: cap.name };
    if (/\.zip$/.test(cap.name) && window.JSZip) { const z = await window.JSZip.loadAsync(src), first = Object.keys(z.files).sort()[0]; if (first) src = await z.file(first).async("blob"); }
    const W = Math.round(box.clientWidth * (window.devicePixelRatio || 1)) || 300;
    if (src.type === "application/pdf" || /\.pdf$/.test(cap.name)) {
      const pj = await pdfjsReady(), d = await pj.getDocument({ data: new Uint8Array(await src.arrayBuffer()) }).promise, pg = await d.getPage(1);
      const v1 = pg.getViewport({ scale: 1 }); pageW = v1.width; pageH = v1.height; rot = pg.rotate || 0;
      const vp = pg.getViewport({ scale: W / v1.width }); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height);
      await pg.render({ canvasContext: g, viewport: vp }).promise; d.destroy();
    } else {
      const bm = await createImageBitmap(src); pageW = bm.width; pageH = bm.height;
      cv.width = W; cv.height = Math.round(W * bm.height / bm.width); const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); g.drawImage(bm, 0, 0, cv.width, cv.height); bm.close();
    }
    if (tok !== prevTok) return;
    const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
    const isPdf = /\.pdf$/.test(cap.name), pages = cap.total || 1, inch = (pt) => (pt / 72).toFixed(2).replace(/\.?0+$/, "");
    const size = isPdf ? `${inch(pageW)} × ${inch(pageH)} in${rot ? " · turned " + rot + "°" : ""}` : `${pageW} × ${pageH} px`;
    meta.textContent = `${isPdf || f === "zip" ? `Page 1 of ${pages} · ` : ""}${size} · this page about ${kb(cap.blob.size)}${pages > 1 && f !== "zip" ? " (file grows with each page)" : ""}`;
  };
  const schedulePreview = () => {
    clearTimeout(prevTimer);
    if (!panelOpen() || dlBusy) return;
    prevTimer = setTimeout(() => { const tok = ++prevTok; prevRun = (prevRun || Promise.resolve()).catch(() => {}).then(() => tok === prevTok ? drawPreview(tok) : null).catch((e) => { $("dl_prev_meta").textContent = "Preview failed: " + (e.message || e); }); }, 350);
  };
  window.__cal2DlPreview = schedulePreview;
  ["dl_format", "dl_look", "dl_quality", "dl_engine", "dl_pages", "dl_paper", "dl_turn", "dl_num", "dl_wm", "dl_dpi", "dl_skipblank"].forEach((id) => $(id) && $(id).addEventListener("change", schedulePreview));
  ["dl_range", "dl_wmtext"].forEach((id) => $(id) && $(id).addEventListener("input", schedulePreview));
  $("dl_more_reset").addEventListener("click", schedulePreview);
  document.querySelector('[data-ddbtn="dl"]')?.addEventListener("click", () => setTimeout(schedulePreview, 30));
  $("dl_prev_big").onclick = async (e) => {   // a bigger look, only when asked (the preview itself stays in the panel), drawn sharp at screen size
    e.stopPropagation(); if (!lastPrev) return;
    const ov = mk("div", { className: "dl-prev-big" }), cv = document.createElement("canvas"); ov.appendChild(cv);
    ov.onclick = () => ov.remove(); document.body.appendChild(ov);
    const dpr = window.devicePixelRatio || 1, H = Math.round((innerHeight - 40) * dpr);
    let src = lastPrev.blob;
    if (/\.zip$/.test(lastPrev.name) && window.JSZip) { const z = await window.JSZip.loadAsync(src), first = Object.keys(z.files).sort()[0]; if (first) src = await z.file(first).async("blob"); }
    if (src.type === "application/pdf" || /\.pdf$/.test(lastPrev.name)) {
      const pj = await pdfjsReady(), d = await pj.getDocument({ data: new Uint8Array(await src.arrayBuffer()) }).promise, pg = await d.getPage(1);
      const v1 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: H / v1.height }); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
      const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise; d.destroy();
    } else { const bm = await createImageBitmap(src); cv.width = bm.width; cv.height = bm.height; cv.getContext("2d").drawImage(bm, 0, 0); bm.close(); }
    cv.style.height = Math.min(innerHeight - 40, cv.height / dpr) + "px"; cv.style.width = "auto";
  };
  // ---- Scan look: every style and setting, shown in the live preview (look "Custom" = these settings) ----
  const STYLES = [["clean", "Clean"], ["light", "Slightly scanned"], ["scanned", "Scanned"], ["photocopy", "Photocopy"], ["bwscan", "B&W scan"], ["gray", "Grayscale"], ["photo", "Photographed"], ["counter", "On a countertop"]];
  const SLIDERS = [["rotate", "Tilt", -3, 3, 0.1, (v) => v.toFixed(1) + "°"], ["rotvar", "Tilt varies", 0, 3, 0.1, (v) => "±" + v.toFixed(1) + "°"], ["bright", "Brightness", 0.8, 1.3, 0.01, (v) => Math.round(v * 100) + "%"],
    ["contrast", "Contrast", 0.8, 1.6, 0.01, (v) => Math.round(v * 100) + "%"], ["blur", "Blur", 0, 2, 0.05, (v) => v.toFixed(2) + "px"], ["sharp", "Sharpness", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"],
    ["noise", "Noise", 0, 60, 1, (v) => Math.round(v) + "%"], ["yellow", "Yellowish", 0, 0.5, 0.01, (v) => Math.round(v * 100) + "%"], ["blem", "Blemish", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"],
    ["wrinkles", "Wrinkles", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["folds", "Folds", 0, 3, 1, (v) => ["None", "One", "Two (letter)", "Three"][Math.round(v)]],
    ["perspective", "Perspective", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["shadow", "Shadow", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"], ["light", "Lighting", 0, 1, 0.01, (v) => Math.round(v * 100) + "%"]];
  const scanSave = () => { lsSet(DL_KEY, dlOpts); dlSync(); schedulePreview(); };
  const useStyle = (key) => {   // a style fills the settings, which can then be fine-tuned
    const base = key === "clean" ? { on: false, blur: 0, sharp: 0, noise: 0, yellow: 0, blem: 0, rotate: 0, rotvar: 0, bright: 1, contrast: 1 } : LOOKS[key] || {};
    const keep = panelScan();
    dlOpts.scan = Object.assign({}, SCAN_DEFAULTS, { wrinkles: 0, folds: 0, photo: "none", perspective: 0, shadow: 0, light: 0 }, base, { style: key, straighten: keep.straighten, severity: keep.severity, seed: keep.seed });
    dlOpts.look = "panel"; scanSave();
  };
  const paintScan = () => {
    const sc = panelScan();
    $("dl_styles").innerHTML = STYLES.map(([k, n]) => `<button type="button" data-style="${k}" class="${dlOpts.look === "panel" && sc.style === k ? "on" : ""}">${n}</button>`).join("");
    $("dl_sliders").innerHTML = `<label class="sl"><span>Colours</span><select data-sc="cspace"><option value="color">Colour</option><option value="gray">Grey</option><option value="bw">Black & white</option><option value="bilevel">1-bit</option></select><b></b></label>` +
      SLIDERS.map(([k, n, mn, mx, st, fmt]) => `<label class="sl"><span>${n}</span><input type="range" min="${mn}" max="${mx}" step="${st}" data-sc="${k}" value="${sc[k] || 0}"><b>${fmt(+sc[k] || 0)}</b></label>`).join("") +
      `<label class="dlchk"><input type="checkbox" data-sc="border" ${sc.border ? "checked" : ""}> Dark scanner border</label>`;
    $("dl_scan").querySelector('[data-sc="cspace"]').value = sc.cspace || "color";
    $("dl_scan").querySelector('[data-sc="straighten"]').checked = !!sc.straighten;
    $("dl_scan").querySelector('[data-sc="severity"]').value = sc.severity;
  };
  $("dl_scan_btn").onclick = () => { const open = $("dl_scan").hidden; $("dl_scan").hidden = !open; $("dl_scan_btn").setAttribute("aria-expanded", String(open)); if (open) paintScan(); };
  $("dl_scan").addEventListener("click", (e) => { const b = e.target.closest("[data-style]"); if (b) { useStyle(b.dataset.style); paintScan(); } });
  $("dl_scan").addEventListener("input", (e) => {
    const k = e.target.dataset.sc; if (!k) return;
    const sc = panelScan(), v = e.target.type === "checkbox" ? e.target.checked : e.target.tagName === "SELECT" ? e.target.value : +e.target.value;
    sc[k] = v; if (k !== "severity" && k !== "straighten") sc.on = true;
    dlOpts.scan = sc; if (k !== "severity") dlOpts.look = "panel";
    const row = SLIDERS.find((r) => r[0] === k); if (row) e.target.parentNode.querySelector("b").textContent = row[5](+v);
    lsSet(DL_KEY, dlOpts); $("dl_look").value = dlOpts.look; schedulePreview();
  });
  $("dl_scan").addEventListener("change", (e) => { if (e.target.dataset.sc) paintScan(); });
  $("dl_random").onclick = () => {   // random settings for the current style, as strong as the severity says
    const sc = panelScan(), k = Math.max(0.05, (sc.severity ?? 50) / 100), r = () => Math.random(), photo = sc.photo && sc.photo !== "none";
    Object.assign(sc, { on: true, seed: Math.floor(r() * 1e9), rotate: (r() - 0.5) * 2 * k, rotvar: r() * 1.5 * k, bright: 1 + (r() - 0.3) * 0.12 * k, contrast: 1 + r() * 0.3 * k, blur: r() * 0.8 * k,
      noise: Math.round(r() * 30 * k), yellow: r() * 0.15 * k, blem: r() * 0.5 * k, wrinkles: r() < 0.5 ? r() * 0.7 * k : 0, folds: r() < 0.4 * k ? 1 + Math.floor(r() * 2) : 0 });
    if (photo) Object.assign(sc, { perspective: (0.2 + r() * 0.8) * k, shadow: (0.3 + r() * 0.7) * k, light: (0.3 + r() * 0.7) * k });
    dlOpts.scan = sc; dlOpts.look = "panel"; scanSave(); paintScan();
  };
  $("dl_look").addEventListener("change", () => { const v = $("dl_look").value; if (v !== "panel" && v !== "custom" && LOOKS[v]) { const keep = panelScan(); dlOpts.scan = Object.assign({}, SCAN_DEFAULTS, { wrinkles: 0, folds: 0, photo: "none", perspective: 0, shadow: 0, light: 0 }, LOOKS[v], { style: v, straighten: keep.straighten, severity: keep.severity, seed: keep.seed }); lsSet(DL_KEY, dlOpts); } if (!$("dl_scan").hidden) paintScan(); });
  $("dl_go").onclick = async () => {
    closeDropdowns(); const f = dlOpts.format;
    clearTimeout(prevTimer); prevTok++; dlBusy = true;
    try { await prevRun; } catch (_) {}   // a preview being built finishes first, so the real download is never caught by it
    dlBusy = false;
    dlBusy = true;
    try { await runExport(f); } finally { dlBusy = false; }
  };
  dlSync();
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
  // leaving the page (Back button, a link, another tool) closes the pop-up windows that belong to it
  let lastPath = location.hash.split("?")[0];
  window.addEventListener("hashchange", () => {
    const path = location.hash.split("?")[0]; if (path === lastPath) return; lastPath = path;
    document.querySelectorAll("dialog.dpad[open]").forEach((d) => { try { d.close(); } catch (_) {} });
  });
  window.__cal2SetWork = setWorkMode;
  window.__cal2HasDoc = () => !!doc;
  window.__cal2OpenDocFile = (f) => openDocFile(f);
  window.__cal2OpenDocBytes = (u8, name, kind) => openDocBytes(u8, name, kind);
  window.__cal2OpenRecentDoc = (rec) => openRecentDoc(rec);
  // every slider's number can be typed: click it, type a value (any form), Enter
  document.addEventListener("click", (e) => {
    const v = e.target.closest(".row .val"); if (!v || v.isContentEditable) return;
    const r = v.parentElement && v.parentElement.querySelector('input[type="range"]'); if (!r) return;
    const before = v.textContent;
    v.contentEditable = "true"; v.classList.add("typing"); v.focus();
    const sel = getSelection(); sel.removeAllRanges(); const rg = document.createRange(); rg.selectNodeContents(v); sel.addRange(rg);
    const done = (ok) => {
      v.removeAttribute("contenteditable"); v.classList.remove("typing"); v.onkeydown = v.onblur = null;
      const n = ok ? parseLooseNumber(v.textContent) : null;
      if (n == null) { v.textContent = before; return; }
      r.value = String(Math.max(+r.min || 0, Math.min(+r.max || 100, n)));
      r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true }));
      if (v.textContent === before || parseLooseNumber(v.textContent) === n) v.textContent = r.value;
    };
    v.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter") { ev.preventDefault(); done(true); } else if (ev.key === "Escape") done(false); };
    v.onblur = () => done(true);
  });
  window.addEventListener("pagehide", () => { if (docRecentId) saveWorkNow().catch(() => {}); });
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
