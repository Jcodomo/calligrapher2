// watermark.js — find and remove watermarks inside a PDF, keeping everything else
// vector (text stays sharp and selectable). Looks for:
//  • watermark annotations (and, optionally, stamp annotations),
//  • content marked as a watermark (/Artifact <</Subtype /Watermark>> — how Acrobat
//    and Word add them) and optional-content layers named like a watermark,
//  • rotated or see-through text, and see-through / rotated images or forms,
//    that repeat on most pages (DRAFT, CONFIDENTIAL, SAMPLE, logos…).
// Only remove watermarks from documents you own or have the rights to change.

const L = () => window.PDFLib;
const WM_NAME = /water|draft|confidential|sample|copy|proof|preview|specimen|do ?not|internal/i;

// ---- bytes <-> latin1 ----------------------------------------------------------
function toStr(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return s; }
function toBytes(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; }

// ---- content-stream tokenizer -----------------------------------------------------
const WS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const DELIM = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
function tokenize(s) {
  const t = [], n = s.length; let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WS(c)) { i++; continue; }
    const st = i;
    if (c === 37) { while (i < n && s[i] !== "\n" && s[i] !== "\r") i++; continue; }
    if (c === 40) { let d = 1; i++; while (i < n && d) { const ch = s[i]; if (ch === "\\") { i += 2; continue; } if (ch === "(") d++; else if (ch === ")") d--; i++; } t.push({ k: "str", s: st, e: i }); continue; }
    if (c === 60) { if (s[i + 1] === "<") { t.push({ k: "<<", s: i, e: i + 2 }); i += 2; continue; } const j = s.indexOf(">", i); i = j < 0 ? n : j + 1; t.push({ k: "hex", s: st, e: i }); continue; }
    if (c === 62) { if (s[i + 1] === ">") { t.push({ k: ">>", s: i, e: i + 2 }); i += 2; continue; } i++; continue; }
    if (c === 91 || c === 93) { t.push({ k: c === 91 ? "[" : "]", s: i, e: i + 1 }); i++; continue; }
    if (c === 123 || c === 125) { i++; continue; }
    if (c === 47) { i++; while (i < n && !WS(s.charCodeAt(i)) && !DELIM(s.charCodeAt(i))) i++; t.push({ k: "name", v: s.slice(st + 1, i), s: st, e: i }); continue; }
    while (i < n && !WS(s.charCodeAt(i)) && !DELIM(s.charCodeAt(i))) i++;
    const w = s.slice(st, i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) t.push({ k: "num", v: parseFloat(w), s: st, e: i });
    else {
      t.push({ k: "op", v: w, s: st, e: i });
      if (w === "ID") { const re = /\sEI(?=\s|$)/g; re.lastIndex = i + 1; const m = re.exec(s); const end = m ? m.index : n; t.push({ k: "bin", s: i + 1, e: end }); i = end; }
    }
  }
  return t;
}
// Group tokens into operations: { op, args:[tokens], s, e }.
function operations(s) {
  const ops = []; let args = [], st = null;
  for (const tk of tokenize(s)) {
    if (tk.k === "op") { ops.push({ op: tk.v, args, s: st == null ? tk.s : st, e: tk.e }); args = []; st = null; }
    else { if (st == null) st = tk.s; args.push(tk); }
  }
  return ops;
}
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const rotated = (m) => Math.abs(m[1]) > 0.02 * Math.hypot(m[0], m[1]) || Math.abs(m[2]) > 0.02 * Math.hypot(m[2], m[3]);

// ---- reading a page's content -----------------------------------------------------
function pageContent(page) {
  const P = L(), c = page.node.Contents();
  if (!c) return "";
  const streams = c instanceof P.PDFArray ? c.asArray().map((r) => page.doc.context.lookup(r)) : [c];
  return streams.map((st) => { try { return toStr(P.decodePDFRawStream(st).decode()); } catch (_) { try { return toStr(st.getContents()); } catch (__) { return ""; } } }).join("\n");
}
function dictOf(res, cat) { const P = L(); try { return res ? res.lookupMaybe(P.PDFName.of(cat), P.PDFDict) : null; } catch (_) { return null; } }
function alphaOf(page, gsName) {
  const P = L(); const d = dictOf(page.node.Resources(), "ExtGState"); if (!d) return 1;
  try { const g = d.lookupMaybe(P.PDFName.of(gsName), P.PDFDict); if (!g) return 1;
    const ca = g.lookupMaybe(P.PDFName.of("ca"), P.PDFNumber), CA = g.lookupMaybe(P.PDFName.of("CA"), P.PDFNumber);
    return Math.min(ca ? ca.asNumber() : 1, CA ? CA.asNumber() : 1); } catch (_) { return 1; }
}
function xobjInfo(page, name) {
  const P = L(); const d = dictOf(page.node.Resources(), "XObject"); if (!d) return { ref: name, sub: "" };
  const ref = d.get(P.PDFName.of(name)); let sub = "";
  try { const o = page.doc.context.lookup(ref); const st = o && o.dict && o.dict.get(P.PDFName.of("Subtype")); sub = st ? String(st).replace("/", "") : ""; } catch (_) {}
  return { ref: ref ? String(ref) : name, sub };
}
function wmProperty(page, propName, wmOcgRefs) {
  const P = L(); const d = dictOf(page.node.Resources(), "Properties"); if (!d) return false;
  try {
    const ref = d.get(P.PDFName.of(propName)); if (ref && wmOcgRefs.has(String(ref))) return true;
    const o = d.lookupMaybe(P.PDFName.of(propName), P.PDFDict); if (!o) return false;
    const txt = o.toString(); return /\/Watermark/.test(txt) || WM_NAME.test((txt.match(/\/Name\s*\(([^)]*)\)/) || [])[1] || "");
  } catch (_) { return false; }
}
// Scan one page: ranges that could be removed, grouped by what they are.
function scanPage(page, wmOcgRefs) {
  const s = pageContent(page), ops = operations(s);
  const found = [];          // { key, kind, s, e, label }
  const gs = [{ ctm: [1, 0, 0, 1, 0, 0], alpha: 1 }];
  const mc = [];             // marked-content stack { s, wm }
  let bt = null;
  for (const o of ops) {
    const top = gs[gs.length - 1];
    switch (o.op) {
      case "q": gs.push({ ...top }); break;
      case "Q": if (gs.length > 1) gs.pop(); break;
      case "cm": if (o.args.length >= 6) top.ctm = mul(o.args.slice(-6).map((a) => a.v), top.ctm); break;
      case "gs": { const n = o.args.find((a) => a.k === "name"); if (n) top.alpha = Math.min(top.alpha, alphaOf(page, n.v)); break; }
      case "BDC": case "BMC": {
        const tag = (o.args[0] && o.args[0].v) || "", parent = mc.length && mc[mc.length - 1].wm;
        const raw = s.slice(o.s, o.e);
        let wm = parent;
        if (!wm && tag === "Artifact" && /\/Watermark/.test(raw)) wm = true;
        if (!wm && o.op === "BDC") { const pn = o.args.find((a, i) => i > 0 && a.k === "name"); if (pn && (tag === "OC" || tag === "Artifact") && wmProperty(page, pn.v, wmOcgRefs)) wm = true; }
        mc.push({ s: o.s, wm, own: wm && !parent });
        break;
      }
      case "EMC": { const m = mc.pop(); if (m && m.own) found.push({ key: "artifact", kind: "artifact", s: m.s, e: o.e }); break; }
      case "BT": bt = { s: o.s, rot: rotated(top.ctm), alpha: top.alpha, sig: "", size: 0 }; break;
      case "Tm": if (bt && o.args.length >= 6 && rotated(o.args.slice(-6).map((a) => a.v))) bt.rot = true; break;
      case "Tf": if (bt) { const n = o.args.find((a) => a.k === "num"); if (n) bt.size = Math.abs(n.v); } break;
      case "Tj": case "TJ": case "'": case '"': if (bt) bt.sig += o.args.filter((a) => a.k === "str" || a.k === "hex").map((a) => s.slice(a.s, a.e)).join(""); break;
      case "ET":
        if (bt && bt.sig && (bt.rot || bt.alpha < 0.95)) found.push({ key: "T:" + bt.sig, kind: "text", s: bt.s, e: o.e, rot: bt.rot, alpha: bt.alpha, sig: bt.sig });
        bt = null; break;
      case "Do": {
        if (mc.length && mc[mc.length - 1].wm) break;          // already inside a watermark region
        const n = o.args.find((a) => a.k === "name"); if (!n) break;
        if (top.alpha < 0.95 || rotated(top.ctm)) { const x = xobjInfo(page, n.v); found.push({ key: "X:" + x.ref, kind: x.sub === "Image" ? "image" : "form", s: o.s, e: o.e, rot: rotated(top.ctm), alpha: top.alpha }); }
        break;
      }
    }
  }
  return { s, found };
}
// Turn raw string operands into readable text when the font is a simple one.
function readable(sig) {
  let out = "";
  const re = /\(((?:\\.|[^\\)])*)\)|<([0-9A-Fa-f\s]*)>/g; let m;
  while ((m = re.exec(sig))) {
    if (m[1] != null) out += m[1].replace(/\\(.)/g, "$1");
    else { const h = m[2].replace(/\s/g, ""); if (h.length % 2 === 0) for (let i = 0; i < h.length; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); out += c >= 32 && c < 127 ? String.fromCharCode(c) : ""; } }
  }
  out = out.replace(/\s+/g, " ").trim();
  return /^[\x20-\x7e]{2,60}$/.test(out) ? out : "";
}
function wmLayers(pdf) {
  const P = L(), refs = new Set(), names = [];
  try {
    const oc = pdf.catalog.lookupMaybe(P.PDFName.of("OCProperties"), P.PDFDict);
    const ocgs = oc && oc.lookupMaybe(P.PDFName.of("OCGs"), P.PDFArray);
    if (ocgs) for (const r of ocgs.asArray()) { const d = pdf.context.lookup(r); const nm = d && d.get(P.PDFName.of("Name")); const txt = nm ? (nm.decodeText ? nm.decodeText() : String(nm)) : ""; if (WM_NAME.test(txt)) { refs.add(String(r)); names.push(txt); } }
  } catch (_) {}
  return { refs, names };
}
function annotsOf(page) { const P = L(); try { return page.node.lookupMaybe(P.PDFName.of("Annots"), P.PDFArray); } catch (_) { return null; } }
function annotSub(pdf, ref) { const P = L(); try { const d = pdf.context.lookup(ref); const st = d && d.get(P.PDFName.of("Subtype")); return st ? String(st).replace("/", "") : ""; } catch (_) { return ""; } }

// ---- public: scan --------------------------------------------------------------------
// Returns candidates: [{ id, label, detail, pages:[indexes], checked }]
export async function scanPdfWatermarks(bytes, { rotatedLabels = [] } = {}) {
  const P = L();
  const pdf = await P.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const pages = pdf.getPages(), N = pages.length, layers = wmLayers(pdf);
  const groups = new Map();
  const add = (key, pi, info) => { if (!groups.has(key)) groups.set(key, { key, pages: new Set(), ...info }); groups.get(key).pages.add(pi); };
  pages.forEach((pg, pi) => {
    const { found } = scanPage(pg, layers.refs);
    for (const f of found) add(f.key, pi, { kind: f.kind, rot: f.rot, alpha: f.alpha, sig: f.sig });
    const an = annotsOf(pg);
    if (an) for (const r of an.asArray()) { const sub = annotSub(pdf, r); if (sub === "Watermark") add("A:Watermark", pi, { kind: "annot" }); if (sub === "Stamp") add("A:Stamp", pi, { kind: "stamp" }); }
  });
  const need = N <= 2 ? 1 : Math.max(2, Math.ceil(N * 0.5));
  const out = [];
  for (const g of groups.values()) {
    const pagesArr = [...g.pages].sort((a, b) => a - b), on = `on ${pagesArr.length} page${pagesArr.length > 1 ? "s" : ""}`;
    if (g.kind === "artifact") out.push({ id: g.key, label: "Marked watermark", detail: "added by Acrobat, Word or a PDF tool — " + on, pages: pagesArr, checked: true });
    else if (g.kind === "annot") out.push({ id: g.key, label: "Watermark annotation", detail: on, pages: pagesArr, checked: true });
    else if (g.kind === "stamp") out.push({ id: g.key, label: "Stamp annotation", detail: "e.g. APPROVED / DRAFT stamps — " + on, pages: pagesArr, checked: false });
    else if (g.pages.size >= need) {
      const how = [g.rot ? "rotated" : "", g.alpha < 0.95 ? "see-through" : ""].filter(Boolean).join(", ");
      if (g.kind === "text") {
        const txt = readable(g.sig || "") || (g.rot && rotatedLabels.length ? rotatedLabels[0] : "");
        out.push({ id: g.key, label: txt ? `“${txt}”` : "Watermark text", detail: `${how} text ${on}`, pages: pagesArr, checked: true });
      } else out.push({ id: g.key, label: g.kind === "image" ? "Watermark picture" : "Watermark graphic", detail: `${how} ${g.kind === "image" ? "image" : "graphic"} ${on}`, pages: pagesArr, checked: true });
    }
  }
  if (layers.names.length) out.push({ id: "L:layers", label: "Watermark layer", detail: layers.names.join(", "), pages: [], checked: true });
  return out;
}

// ---- public: remove ------------------------------------------------------------------
export async function removePdfWatermarks(bytes, ids) {
  const P = L();
  const want = new Set(ids);
  const pdf = await P.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const layers = wmLayers(pdf);
  const useLayers = want.has("L:layers") ? layers.refs : new Set();
  let removed = 0;
  for (const pg of pdf.getPages()) {
    const { s, found } = scanPage(pg, useLayers);
    const cut = found.filter((f) => want.has(f.key) || (f.kind === "artifact" && (want.has("artifact") || want.has("L:layers")))).map((f) => [f.s, f.e]).sort((a, b) => a[0] - b[0]);
    if (cut.length) {
      let out = "", at = 0;
      for (const [a, b] of cut) { if (a < at) { at = Math.max(at, b); continue; } out += s.slice(at, a); at = b; }
      out += s.slice(at);
      const stream = pdf.context.flateStream(toBytes(out));
      pg.node.set(P.PDFName.of("Contents"), pdf.context.register(stream));
      removed += cut.length;
    }
    const an = annotsOf(pg);
    if (an && (want.has("A:Watermark") || want.has("A:Stamp"))) {
      const keep = an.asArray().filter((r) => { const sub = annotSub(pdf, r); return !((sub === "Watermark" && want.has("A:Watermark")) || (sub === "Stamp" && want.has("A:Stamp"))); });
      if (keep.length !== an.size()) { removed += an.size() - keep.length; pg.node.set(P.PDFName.of("Annots"), pdf.context.obj(keep)); }
    }
  }
  return { bytes: await pdf.save(), removed };
}

// ---- pictures: erase by colour, and fill in painted areas ----------------------------
// Pixels that are a blend of the background and the watermark colour (i.e. the mark
// itself, not dark text drawn over it) are set back to the background.
export function eraseColor(img, bg, wm, tol) {
  const d = img.data, v = [wm[0] - bg[0], wm[1] - bg[1], wm[2] - bg[2]], vv = v[0] * v[0] + v[1] * v[1] + v[2] * v[2] || 1;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const p0 = d[i] - bg[0], p1 = d[i + 1] - bg[1], p2 = d[i + 2] - bg[2];
    const t = Math.max(0, Math.min(1.15, (p0 * v[0] + p1 * v[1] + p2 * v[2]) / vv));
    if (t < 0.06) continue;
    const e0 = p0 - t * v[0], e1 = p1 - t * v[1], e2 = p2 - t * v[2];
    if (Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2) <= tol) { d[i] = bg[0]; d[i + 1] = bg[1]; d[i + 2] = bg[2]; n++; }
  }
  return n;
}
// Fill masked pixels from their surroundings, ring by ring (onion-peel inpainting).
export function inpaint(img, mask, grow = 2) {
  const w = img.width, h = img.height, d = img.data;
  let m = mask;
  for (let g = 0; g < grow; g++) {             // grow the mask to catch soft edges
    const n2 = m.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (!m[i] && (m[i - 1] || m[i + 1] || m[i - w] || m[i + w])) n2[i] = 1; }
    m = n2;
  }
  const N = w * h, known = new Uint8Array(N), queued = new Uint8Array(N);
  for (let i = 0; i < N; i++) known[i] = m[i] ? 0 : 1;
  const nb = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1], wt = [1, 1, 1, 1, 0.7, 0.7, 0.7, 0.7];
  const inside = (i, j) => j >= 0 && j < N && Math.abs((j % w) - (i % w)) <= 1;
  // the first ring: masked pixels touching a known one
  let front = [];
  for (let i = 0; i < N; i++) if (!known[i]) for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (inside(i, j) && known[j]) { front.push(i); queued[i] = 1; break; } }
  while (front.length) {
    const fill = [];
    for (const i of front) {
      let r = 0, g2 = 0, b = 0, s = 0;
      for (let k = 0; k < 8; k++) { const j = i + nb[k]; if (!inside(i, j) || !known[j]) continue; r += d[j * 4] * wt[k]; g2 += d[j * 4 + 1] * wt[k]; b += d[j * 4 + 2] * wt[k]; s += wt[k]; }
      if (s) fill.push([i, r / s, g2 / s, b / s]);
    }
    if (!fill.length) break;
    for (const [i, r, g2, b] of fill) { d[i * 4] = r; d[i * 4 + 1] = g2; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; known[i] = 1; }
    const next = [];
    for (const [i] of fill) for (let k = 0; k < 4; k++) { const j = i + nb[k]; if (inside(i, j) && !known[j] && !queued[j]) { queued[j] = 1; next.push(j); } }
    front = next;
  }
}
// The page's background colour (the most common light colour).
export function pageBackground(img) {
  const d = img.data, buckets = new Map();     // bucket -> [count, r, g, b] (exact averages)
  for (let i = 0; i < d.length; i += 4 * 7) {
    const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
    const b = buckets.get(k) || [0, 0, 0, 0]; b[0]++; b[1] += d[i]; b[2] += d[i + 1]; b[3] += d[i + 2]; buckets.set(k, b);
  }
  let best = null; for (const b of buckets.values()) if (!best || b[0] > best[0]) best = b;
  return best ? [Math.round(best[1] / best[0]), Math.round(best[2] / best[0]), Math.round(best[3] / best[0])] : [255, 255, 255];
}
