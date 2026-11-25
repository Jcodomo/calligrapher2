// Takes the original words of edited lines out of a PDF page, so text you changed with Edit Text is really gone from
// the saved file (not only covered): it can no longer be selected, copied or found by search.
//
// How: the page's content stream is read operator by operator, keeping the text and graphics state (cm, q/Q, BT,
// Tm/Td/TD/T*, Tf, Tc, Tw, Tz, TL). pdf.js's operator list of the same page gives each text-showing operator its
// glyphs - their widths and the characters they stand for - so every operator's start and end on the page are known
// exactly. An operator is removed only when it lies inside an edited line's box AND its characters are part of that
// line's original text. It is replaced by an empty TJ that moves the pen by the same amount, so any text that follows
// on the same line stays exactly where it was. If the two readings of the page do not line up, nothing is changed.

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const mul = (a, b) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const ID = [1, 0, 0, 1, 0, 0];
const SHOW = new Set(["Tj", "TJ", "'", '"']);

// content stream -> operators with their operands and byte range
function parse(s) {
  const ops = []; let i = 0, n = s.length, args = [], argStart = -1;
  const skipWs = () => { while (i < n) { const c = s.charCodeAt(i); if (WS.has(c)) i++; else if (c === 37) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; } else break; } };
  const value = () => {   // one operand
    const c = s.charCodeAt(i);
    if (c === 40) { let depth = 0; do { const d = s.charCodeAt(i); if (d === 92) i++; else if (d === 40) depth++; else if (d === 41) depth--; i++; } while (i < n && depth > 0); return { t: "str" }; }
    if (c === 60 && s.charCodeAt(i + 1) === 60) { i += 2; let depth = 1; while (i < n && depth) { if (s.startsWith("<<", i)) { depth++; i += 2; } else if (s.startsWith(">>", i)) { depth--; i += 2; } else if (s.charCodeAt(i) === 40) value(); else i++; } return { t: "dict" }; }
    if (c === 60) { while (i < n && s.charCodeAt(i) !== 62) i++; i++; return { t: "hex" }; }
    if (c === 91) { i++; const items = []; for (;;) { skipWs(); if (i >= n) break; if (s.charCodeAt(i) === 93) { i++; break; } items.push(value()); } return { t: "arr", items }; }
    if (c === 47) { const a = ++i; while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++; return { t: "name", v: s.slice(a, i) }; }
    const a = i; while (i < n && !WS.has(s.charCodeAt(i)) && !DELIM.has(s.charCodeAt(i))) i++;
    if (i === a) { i++; return { t: "junk" }; }
    const w = s.slice(a, i), num = +w;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w) && isFinite(num)) return { t: "num", v: num };
    if (w === "true" || w === "false" || w === "null") return { t: "kw", v: w };
    return { t: "op", v: w };
  };
  for (;;) {
    skipWs(); if (i >= n) break;
    const at = i, v = value();
    if (v.t !== "op") { if (argStart < 0) argStart = at; args.push(v); continue; }
    if (v.v === "BI") {   // inline image: its data is binary, skip to EI
      const m = /\sID[\s]/g; m.lastIndex = i; const idm = m.exec(s); if (!idm) break;
      const e = /\sEI(?=[\s]|$)/g; e.lastIndex = idm.index + idm[0].length; const em = e.exec(s); if (!em) break;
      i = em.index + em[0].length; args = []; argStart = -1; continue;
    }
    ops.push({ op: v.v, args, start: argStart < 0 ? at : argStart, end: i });
    args = []; argStart = -1;
  }
  return ops;
}

// pdf.js text operators, in content order, with their glyphs (skipping the insides of form XObjects)
function pdfjsShows(opList, OPS) {
  const out = []; let depth = 0, font = null; const stack = [];
  for (let k = 0; k < opList.fnArray.length; k++) {
    const fn = opList.fnArray[k];
    if (fn === OPS.paintFormXObjectBegin) depth++;
    else if (fn === OPS.paintFormXObjectEnd) depth--;
    else if (fn === OPS.save) stack.push(font);
    else if (fn === OPS.restore) { if (stack.length) font = stack.pop(); }
    else if (fn === OPS.setFont) font = opList.argsArray[k][0];   // pdf.js's own name for the font
    else if (!depth && (fn === OPS.showText || fn === OPS.showSpacedText)) out.push({ glyphs: opList.argsArray[k][0], font });
  }
  return out;
}

/**
 * @param L       pdf-lib
 * @param pdf     the PDFDocument being saved
 * @param page    its PDFPage (still the original content)
 * @param srcPage the same page from pdf.js (PDFPageProxy)
 * @param boxes   [{ x0, y0, x1, y1, text }] edited lines in PDF user space, with their original text
 * @returns number of text operators removed (-1 = left unchanged)
 */
export async function stripEditedText(L, pdf, page, srcPage, boxes) {
  if (!boxes.length) return 0;
  const P = window.pdfjsLib;
  // 1. the page's content, as one string of bytes
  const node = page.node, cref = node.get(L.PDFName.of("Contents"));
  const co = cref && pdf.context.lookup(cref);
  const parts = co instanceof L.PDFArray ? co.asArray().map((r) => pdf.context.lookup(r)) : co ? [co] : [];
  if (!parts.length) return 0;
  let s = "";
  for (const st of parts) {
    let u8;
    if (st instanceof L.PDFRawStream) u8 = L.decodePDFRawStream(st).decode();
    else if (st && typeof st.getContents === "function") u8 = st.getContents();
    else return -1;
    for (let k = 0; k < u8.length; k += 8192) s += String.fromCharCode.apply(null, u8.subarray(k, k + 8192));
    s += "\n";
  }
  const ops = parse(s);
  // 2. pdf.js's reading of the same operators
  const ol = await srcPage.getOperatorList({ annotationMode: P.AnnotationMode ? P.AnnotationMode.DISABLE : 0 });
  const shows = pdfjsShows(ol, P.OPS);
  const ours = ops.filter((o) => SHOW.has(o.op));
  if (ours.length !== shows.length) return -1;   // the two readings disagree: change nothing
  const fontMatrix = (name) => { try { const f = srcPage.commonObjs.get(name); return (f && f.fontMatrix) || null; } catch (_) { return null; } };
  const norm = (t) => t.replace(/\s+/g, "");
  const wanted = boxes.map((b) => ({ ...b, t: norm(b.text || "") }));
  // 3. walk the content keeping the state, decide per text operator
  let ctm = ID.slice(), tm = ID.slice(), tlm = ID.slice();
  let st = { fs: 0, font: null, tc: 0, tw: 0, th: 1, tl: 0 };
  const stack = [];
  const edits = [], dbg = [];   // { start, end, text }; what did not match (for the warning)
  let si = 0;
  const num = (a, k) => (a[k] && a[k].t === "num" ? a[k].v : 0);
  for (const o of ops) {
    const a = o.args;
    switch (o.op) {
      case "q": stack.push({ ctm: ctm.slice(), st: { ...st } }); break;
      case "Q": { const g = stack.pop(); if (g) { ctm = g.ctm; st = g.st; } break; }
      case "cm": if (a.length >= 6) ctm = mul([0, 1, 2, 3, 4, 5].map((k) => num(a, k)), ctm); break;
      case "BT": tm = ID.slice(); tlm = ID.slice(); break;
      case "Tf": st.font = a[0] && a[0].v; st.fs = num(a, 1); break;
      case "Tc": st.tc = num(a, 0); break;
      case "Tw": st.tw = num(a, 0); break;
      case "Tz": st.th = num(a, 0) / 100; break;
      case "TL": st.tl = num(a, 0); break;
      case "Td": tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm.slice(); break;
      case "TD": st.tl = -num(a, 1); tlm = mul([1, 0, 0, 1, num(a, 0), num(a, 1)], tlm); tm = tlm.slice(); break;
      case "Tm": tlm = [0, 1, 2, 3, 4, 5].map((k) => num(a, k)); tm = tlm.slice(); break;
      case "T*": tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm.slice(); break;
      default: break;
    }
    if (!SHOW.has(o.op)) continue;
    if (o.op === "'" || o.op === '"') {
      if (o.op === '"') { st.tw = num(a, 0); st.tc = num(a, 1); }
      tlm = mul([1, 0, 0, 1, 0, -st.tl], tlm); tm = tlm.slice();
    }
    const sh = shows[si++] || { glyphs: [] }, glyphs = sh.glyphs || [];
    // the operator's advance along the line, in text space (before horizontal scaling), and its characters
    const fm = fontMatrix(sh.font), fm0 = fm ? fm[0] : 0.001;
    let x = 0, text = "";
    for (const g of glyphs) {
      if (typeof g === "number") { x += -g * st.fs * 0.001; continue; }
      if (!g) continue;
      x += (g.width || 0) * st.fs * fm0 + st.tc + (g.isSpace ? st.tw : 0);
      text += g.unicode || "";
    }
    const trm = mul(tm, ctm), p0 = apply(trm, 0, 0), p1 = apply(trm, x * st.th, 0);
    const mx = (p0[0] + p1[0]) / 2, my = (p0[1] + p1[1]) / 2, nt = norm(text);
    const hit = nt && wanted.find((b) => mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1 && b.t.includes(nt));
    if (!hit && nt && dbg.length < 12) dbg.push([nt.slice(0, 30), +mx.toFixed(1), +my.toFixed(1)]);
    if (hit && st.fs) {
      const m = -x * 1000 / st.fs, keep = `[${+m.toFixed(3)}] TJ`;
      const rep = o.op === "'" ? `T* ${keep}` : o.op === '"' ? `${num(a, 0)} Tw ${num(a, 1)} Tc T* ${keep}` : keep;
      edits.push({ start: o.start, end: o.end, text: rep });
    }
    tm = mul([1, 0, 0, 1, x * st.th, 0], tm);
  }
  if (!edits.length) { console.warn("Edit Text: none of the page's text matched the edited lines", JSON.stringify({ boxes: wanted.map((b) => [b.t.slice(0, 40), +b.x0.toFixed(1), +b.y0.toFixed(1), +b.x1.toFixed(1), +b.y1.toFixed(1)]), seen: dbg.slice(0, 6) })); return 0; }
  // 4. write the page's content back as one stream
  let outS = "", at = 0;
  for (const e of edits) { outS += s.slice(at, e.start) + e.text; at = e.end; }
  outS += s.slice(at);
  const bytes = new Uint8Array(outS.length);
  for (let k = 0; k < outS.length; k++) bytes[k] = outS.charCodeAt(k) & 255;
  const stream = pdf.context.flateStream(bytes);
  node.set(L.PDFName.of("Contents"), pdf.context.register(stream));
  return edits.length;
}

// Puts a page's words back as invisible real text on a page that had to become a picture (a redaction, a blur,
// Unlock), so the saved page can still be searched, selected and copied. Each run of characters goes at its place,
// squeezed to its original width; characters whose middle lies in one of `boxes` (page fractions, as shown) stay out.
// srcPage: the original page in pdf.js, vp: its viewport as shown (any rotation), pw x ph: the new page in points.
export async function putWordsBack(L, pdf, page, srcPage, vp, pw, ph, boxes = [], cache = {}) {
  const tc = await srcPage.getTextContent();
  const font = cache.f || (cache.f = await pdf.embedFont(L.StandardFonts.Helvetica)), okc = cache.cs || (cache.cs = new Set(font.getCharacterSet()));
  const fontRef = page.node.newFontDictionary(font.name, font.ref);
  const norm = (x, y) => { const v = vp.convertToViewportPoint(x, y); return [v[0] / vp.width, v[1] / vp.height]; };
  const inside = (q) => boxes.some((b) => q[0] >= b.x0 && q[0] <= b.x1 && q[1] >= b.y0 && q[1] <= b.y1);
  let n = 0;
  for (const t of tc.items) {
    const s = t.str || ""; if (!s.trim() || !t.transform) continue;
    const tr = t.transform, fs = Math.hypot(tr[2], tr[3]) || Math.hypot(tr[0], tr[1]); if (!(fs > 0.5)) continue;
    const dl = Math.hypot(tr[0], tr[1]) || 1, dx = tr[0] / dl, dy = tr[1] / dl, ux = -dy, uy = dx;
    const chars = [...s].map((ch) => (okc.has(ch.codePointAt(0)) ? ch : "?"));
    const cum = [0]; for (const ch of chars) cum.push(cum[cum.length - 1] + (font.widthOfTextAtSize(ch, 10) || 5));
    const k = (t.width > 0 ? t.width : font.widthOfTextAtSize(chars.join(""), fs)) / (cum[cum.length - 1] || 1);
    const pt = (u, h) => [tr[4] + dx * u + ux * h, tr[5] + dy * u + uy * h];
    const keep = chars.map((ch, c) => !inside(norm(...pt((cum[c] + cum[c + 1]) / 2 * k, fs * 0.35))));
    for (let a = 0; a < chars.length;) {
      if (!keep[a] || /\s/.test(chars[a])) { a++; continue; }
      let b = a; while (b < chars.length && keep[b]) b++;
      let e = b; while (e > a && /\s/.test(chars[e - 1])) e--;
      const run = chars.slice(a, e).join("");
      const s0 = norm(...pt(cum[a] * k, 0)), s1 = norm(...pt(cum[e] * k, 0));
      const X0 = s0[0] * pw, Y0 = ph - s0[1] * ph, X1 = s1[0] * pw, Y1 = ph - s1[1] * ph, len = Math.hypot(X1 - X0, Y1 - Y0);
      const fsOut = fs * pw / vp.width, have = font.widthOfTextAtSize(run, fsOut) || len, cs = (X1 - X0) / (len || 1), sn = (Y1 - Y0) / (len || 1);
      page.pushOperators(L.beginText(), L.setFontAndSize(fontRef, fsOut), L.setTextRenderingMode(L.TextRenderingMode.Invisible),
        L.setCharacterSqueeze(Math.max(20, Math.min(400, (len / have) * 100))), L.setTextMatrix(cs, sn, -sn, cs, X0, Y0), L.showText(font.encodeText(run)), L.endText());
      n++; a = b;
    }
  }
  return n;
}
