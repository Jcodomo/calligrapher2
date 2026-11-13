// Calligrapher 2.0 front-end: loads the Rust/WASM engine and drives the UI.
// WASM C ABI: alloc / dealloc / generate / result_ptr + linear `memory`.

const WASM_URL = "./calligrapher2.wasm";
let wasm = null;
const enc = new TextEncoder();
const dec = new TextDecoder();

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

// Call the engine; returns the raw SVG string.
function generateSVG(text, p) {
  const bytes = enc.encode(text);
  const inPtr = wasm.alloc(bytes.length || 1);
  new Uint8Array(wasm.memory.buffer, inPtr, bytes.length).set(bytes);
  const [lo, hi] = splitSeed(p.seed);
  const len = wasm.generate(
    inPtr, bytes.length,
    p.width, p.height, p.font_px, p.slant_deg, p.variation,
    p.weight, p.contrast, p.spacing, p.line_spacing, p.align, lo, hi
  );
  const outPtr = wasm.result_ptr();
  const svg = dec.decode(new Uint8Array(wasm.memory.buffer, outPtr, len));
  wasm.dealloc(inPtr, bytes.length || 1);
  return svg;
}

// ---- state / UI ----------------------------------------------------------

const $ = (id) => document.getElementById(id);
const sheet = $("sheet");
const errEl = $("err");

const INKS = ["#1b1b1f", "#1d4ed8", "#0b7285", "#9a1750", "#3b2f2f", "#111"];
const PAPERS = ["#fbfaf6", "#fff8e7", "#eef3f8", "#f3eee4", "#ffffff", "#12151c"];
const PRESETS = {
  Casual: { font_px: 64, slant: 9, variation: 55, weight: 36, contrast: 60, spacing: 4, line_spacing: 105 },
  Formal: { font_px: 70, slant: 18, variation: 22, weight: 30, contrast: 78, spacing: 2, line_spacing: 120 },
  Scrawl: { font_px: 58, slant: 4, variation: 90, weight: 42, contrast: 45, spacing: 6, line_spacing: 100 },
  Marker: { font_px: 72, slant: 6, variation: 40, weight: 70, contrast: 10, spacing: 8, line_spacing: 115 },
};

let ink = INKS[0];
let paper = PAPERS[0];
let align = 0;

function buildSwatches() {
  const mk = (host, list, cur, set) => {
    host.innerHTML = "";
    list.forEach((c) => {
      const b = document.createElement("div");
      b.className = "sw" + (cur() === c ? " sel" : "");
      b.style.background = c;
      b.onclick = () => { set(c); [...host.querySelectorAll(".sw")].forEach(x => x.classList.remove("sel")); b.classList.add("sel"); render(); };
      host.appendChild(b);
    });
    const picker = document.createElement("input");
    picker.type = "color"; picker.value = cur();
    picker.oninput = () => { set(picker.value); [...host.querySelectorAll(".sw")].forEach(x => x.classList.remove("sel")); render(); };
    host.appendChild(picker);
  };
  mk($("ink"), INKS, () => ink, (c) => ink = c);
  mk($("paper"), PAPERS, () => paper, (c) => paper = c);
}

function buildPresets() {
  const host = $("presets");
  host.innerHTML = "";
  Object.keys(PRESETS).forEach((name) => {
    const b = document.createElement("button");
    b.textContent = name;
    b.onclick = () => applyPreset(PRESETS[name]);
    host.appendChild(b);
  });
}
function applyPreset(pr) {
  for (const k of Object.keys(pr)) $(k).value = pr[k];
  render();
}

$("align").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    align = parseFloat(b.dataset.a);
    $("align").querySelectorAll("button").forEach(x => x.classList.remove("sel"));
    b.classList.add("sel");
    render();
  };
});

const SLIDERS = ["font_px", "slant", "variation", "weight", "contrast", "spacing", "line_spacing"];
function refreshLabels() {
  $("font_px_v").textContent = $("font_px").value;
  $("slant_v").textContent = $("slant").value + "°";
  $("variation_v").textContent = $("variation").value + "%";
  $("weight_v").textContent = ($("weight").value / 10).toFixed(1);
  $("contrast_v").textContent = $("contrast").value + "%";
  $("spacing_v").textContent = ($("spacing").value / 100).toFixed(2);
  $("line_spacing_v").textContent = ($("line_spacing").value / 100).toFixed(2);
}

function params() {
  const stage = sheet.parentElement.getBoundingClientRect();
  const width = Math.max(480, Math.min(1600, stage.width - 48));
  return {
    width, height: 0,
    font_px: +$("font_px").value,
    slant_deg: +$("slant").value,
    variation: +$("variation").value / 100,
    weight: $("weight").value / 10,
    contrast: +$("contrast").value / 100,
    spacing: $("spacing").value / 100,
    line_spacing: +$("line_spacing").value / 100,
    align,
    seed: +$("seed").value,
  };
}

// Inject a left-to-right "write-on" reveal using a clipPath + SMIL animate.
function animateSVG(svg) {
  const w = +(svg.match(/width="(\d+)"/) || [])[1] || 800;
  const h = +(svg.match(/height="(\d+)"/) || [])[1] || 300;
  const dur = Math.max(1.2, Math.min(6, w / 320)).toFixed(2);
  const defs = `<defs><clipPath id="wo"><rect x="0" y="0" width="0" height="${h}">` +
    `<animate attributeName="width" from="0" to="${w}" dur="${dur}s" fill="freeze"/></rect></clipPath></defs>`;
  return svg.replace("><g>", `>${defs}<g clip-path="url(#wo)">`);
}

let lastSVG = "";
function render() {
  if (!wasm) return;
  refreshLabels();
  try {
    let svg = generateSVG($("text").value, params());
    svg = svg.replace("<svg ", `<svg style="color:${ink};background:${$("paper_style").value === "blank" ? paper : paper}" `);
    if ($("animate").checked) svg = animateSVG(svg);
    lastSVG = svg;
    sheet.innerHTML = svg;
    sheet.style.background = paper;
    errEl.textContent = "";
    syncHash();
  } catch (e) {
    errEl.textContent = "Render error: " + (e && e.message ? e.message : e);
  }
}

// ---- share links (state <-> URL hash) ------------------------------------

function currentState() {
  return {
    t: $("text").value,
    f: +$("font_px").value, s: +$("slant").value, v: +$("variation").value,
    w: +$("weight").value, c: +$("contrast").value, sp: +$("spacing").value,
    l: +$("line_spacing").value, a: align, sd: +$("seed").value,
    i: ink, p: paper, ps: $("paper_style").value,
    an: $("animate").checked ? 1 : 0, tr: $("transparent").checked ? 1 : 0,
  };
}
function syncHash() {
  try { history.replaceState(null, "", "#" + btoa(encodeURIComponent(JSON.stringify(currentState())))); } catch {}
}
function applyState(s) {
  if (!s) return;
  $("text").value = s.t ?? $("text").value;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set("font_px", s.f); set("slant", s.s); set("variation", s.v); set("weight", s.w);
  set("contrast", s.c); set("spacing", s.sp); set("line_spacing", s.l); set("seed", s.sd);
  if (s.i) ink = s.i; if (s.p) paper = s.p;
  if (s.ps) $("paper_style").value = s.ps;
  $("animate").checked = !!s.an; $("transparent").checked = !!s.tr;
  if (s.a != null) {
    align = s.a;
    $("align").querySelectorAll("button").forEach(x =>
      x.classList.toggle("sel", parseFloat(x.dataset.a) === align));
  }
  sheet.className = "sheet" + (s.ps && s.ps !== "blank" ? " " + s.ps : "");
}
function loadHash() {
  if (!location.hash.length) return false;
  try { applyState(JSON.parse(decodeURIComponent(atob(location.hash.slice(1))))); return true; }
  catch { return false; }
}

// ---- exports -------------------------------------------------------------

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function exportSVG() { download("calligraphy.svg", new Blob([lastSVG], { type: "image/svg+xml" })); flash("Saved SVG."); }
function exportPNG() {
  const url = URL.createObjectURL(new Blob([lastSVG], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const scale = 2, c = document.createElement("canvas");
    c.width = img.width * scale; c.height = img.height * scale;
    const ctx = c.getContext("2d");
    if (!$("transparent").checked) { ctx.fillStyle = paper; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob((b) => { download("calligraphy.png", b); flash("Saved PNG."); }, "image/png");
  };
  img.onerror = () => errEl.textContent = "PNG export failed to rasterise the SVG.";
  img.src = url;
}
async function copySVG() {
  try { await navigator.clipboard.writeText(lastSVG); flash("Copied SVG markup."); }
  catch { errEl.textContent = "Clipboard blocked; use Download SVG."; }
}
async function copyLink() {
  syncHash();
  try { await navigator.clipboard.writeText(location.href); flash("Shareable link copied."); }
  catch { errEl.textContent = "Clipboard blocked; copy the URL from the address bar."; }
}
function flash(msg) { errEl.textContent = msg; errEl.className = "err ok"; setTimeout(() => { errEl.textContent = ""; errEl.className = "err"; }, 1800); }

// ---- boot ----------------------------------------------------------------

function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }
const renderD = debounce(render, 90);

(async function () {
  buildSwatches();
  buildPresets();
  try { await loadWasm(); }
  catch (e) {
    errEl.textContent = "Could not load the WASM engine (" + e.message +
      ").\nServe this folder over http:// (not file://).";
    return;
  }
  loadHash();
  buildSwatches(); // reflect any ink/paper from hash
  SLIDERS.forEach((id) => $(id).addEventListener("input", renderD));
  $("text").addEventListener("input", renderD);
  $("seed").addEventListener("input", renderD);
  $("paper_style").addEventListener("change", () => { sheet.className = "sheet" + ($("paper_style").value !== "blank" ? " " + $("paper_style").value : ""); render(); });
  $("animate").addEventListener("change", render);
  $("transparent").addEventListener("change", syncHash);
  $("reroll").addEventListener("click", () => { $("seed").value = Math.floor(Math.random() * 1e9); render(); });
  $("svg").addEventListener("click", exportSVG);
  $("png").addEventListener("click", exportPNG);
  $("copysvg").addEventListener("click", copySVG);
  $("share").addEventListener("click", copyLink);
  window.addEventListener("resize", renderD);
  sheet.className = "sheet" + ($("paper_style").value !== "blank" ? " " + $("paper_style").value : "");
  render();
})();
