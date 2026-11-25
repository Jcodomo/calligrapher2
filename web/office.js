// office.js - PDF to Excel (.xlsx) and PDF to PowerPoint (.pptx), in the browser.
//
// Both start from the same reading of a page: its words with their place, size, font and colour (pdf.js text for
// PDFs with text, OCR word boxes for scans), joined into "segments" - runs of words close enough to belong together.
//
// Excel: segments on the same baseline make a row. Runs of rows that have several segments are tables: their
// columns are found from the vertical white channels between the segments (an x that almost no row covers), so a
// row that leaves a column empty still lines up, and continuation lines (a wrapped description) go in their column.
// Each table starts in column A. Amounts become numbers (commas, $, minus, (brackets), %, trailing minus), dates
// become dates, and account numbers, ZIP codes and other figures with leading zeros stay text. Bold stays bold.
// One sheet per page, or every page on one sheet. The .xlsx is written by hand (SpreadsheetML), no library.
//
// PowerPoint: one slide per page, the page's look kept exactly - the page drawn without its text is the slide's
// picture - and every segment of text is a real, editable text box at its place, in its font, size, weight, slant and
// colour. Scanned pages: the words are read (OCR, or a PDF's own hidden OCR layer), wiped off the picture with the
// paper colour around them and put back as text boxes, so a scan becomes editable too. Uses PptxGenJS.

const XNS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
let measureCtx = null;
const measure = (s, fam) => { measureCtx = measureCtx || document.createElement("canvas").getContext("2d"); measureCtx.font = `100px ${fam || "sans-serif"}`; return measureCtx.measureText(s).width; };

// ---- fonts -------------------------------------------------------------------------------------------------------
const FONT_MAP = [[/^(arial|helvetica)/i, "Arial"], [/^(times|timesnewroman|tinos)/i, "Times New Roman"], [/^(courier|cousine)/i, "Courier New"],
  [/^(calibri|carlito)/i, "Calibri"], [/^(cambria|caladea)/i, "Cambria"], [/^(georgia|gelasio)/i, "Georgia"], [/^verdana/i, "Verdana"], [/^tahoma/i, "Tahoma"],
  [/^(segoe ?ui)/i, "Segoe UI"], [/^garamond/i, "Garamond"], [/^(bookantiqua|book antiqua)/i, "Book Antiqua"], [/^(centurygothic)/i, "Century Gothic"],
  [/^(trebuchet)/i, "Trebuchet MS"], [/^(liberationsans|arimo)/i, "Arial"], [/^(liberationserif)/i, "Times New Roman"], [/^(liberationmono)/i, "Courier New"], [/^symbol/i, "Symbol"]];
export function fontFace(info) {
  let raw = String((info && (info.name || info.loadedName)) || "").replace(/^[A-Z]{6}\+/, "");
  const style = /bold|black|heavy|semibold|demi/i.test(raw), slant = /italic|oblique/i.test(raw);
  raw = raw.split(/[,-]/)[0].replace(/(PSMT|MT|PS|Std|Pro|LT)$/g, "");
  let fam = null;
  for (const [re, f] of FONT_MAP) if (re.test(raw)) { fam = f; break; }
  if (!fam) fam = raw ? raw.replace(/([a-z])([A-Z])/g, "$1 $2").trim() : "";
  if (!fam || /^g_d\d|^f\d+$/i.test(fam)) fam = info && info.isSerifFont ? "Times New Roman" : info && info.isMonospace ? "Courier New" : "Arial";
  return { face: fam, bold: !!(info && (info.bold || info.black)) || style, italic: !!(info && info.italic) || slant };
}

// ---- reading a page ------------------------------------------------------------------------------------------------
// pieces: { str, x0, x1, base, fs, font:{face,bold,italic}, rot } in points, page as shown (y down)
export async function pdfPieces(page, vp, opts = {}) {
  const P = window.pdfjsLib, tc = await page.getTextContent(), styles = tc.styles || {};
  if (opts.fonts) { try { await page.getOperatorList(); } catch (_) {} }   // loads the fonts' real names
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim() || !it.transform) continue;
    const m = P.Util.transform(vp.transform, it.transform), fs = Math.hypot(m[2], m[3]), dirLen = Math.hypot(m[0], m[1]) || 1;
    if (!(fs > 0.5)) continue;
    const rot = Math.atan2(m[1], m[0]) * 180 / Math.PI;
    let info = null; try { info = page.commonObjs.has(it.fontName) ? page.commonObjs.get(it.fontName) : null; } catch (_) {}
    const st = styles[it.fontName] || {}, font = fontFace(info || { name: st.fontFamily, isSerifFont: /serif/i.test(st.fontFamily || "") && !/sans/i.test(st.fontFamily || ""), isMonospace: /mono/i.test(st.fontFamily || "") });
    const w = (it.width || 0) * (vp.scale || 1), x0 = m[4], base = m[5];
    if (Math.abs(rot) > 2) { out.push({ str: it.str.trim(), x0, x1: x0 + w, base, fs, font, rot, item: it }); continue; }
    // one item can hold several columns ("Total      1,250.00"): split it at runs of 2+ spaces, by measured widths
    const parts = it.str.split(/( {2,}|\t+)/);
    if (parts.length === 1) { const lead = it.str.match(/^\s*/)[0], trail = it.str.match(/\s*$/)[0], tot = measure(it.str) || 1;
      out.push({ str: it.str.trim(), x0: x0 + w * measure(lead) / tot, x1: x0 + w * (1 - measure(trail) / tot), base, fs, font, rot: 0 }); continue; }
    const tot = measure(it.str) || 1; let at = 0;
    for (const p of parts) {
      const pw = measure(p);
      if (p.trim()) { const lead = p.match(/^\s*/)[0], s = p.trim(); const a = at + measure(lead); out.push({ str: s, x0: x0 + w * a / tot, x1: x0 + w * (a + measure(s)) / tot, base, fs, font, rot: 0 }); }
      at += pw;
    }
  }
  return out;
}
// The page's vertical ruled lines (table borders, cell dividers), as { x, y0, y1 } in points as shown: read from the
// drawing operators with their transforms (lines, and thin rectangles, which is how Excel and Word draw borders).
export async function pdfRules(page, vp) {
  const P = window.pdfjsLib, O = P.OPS, ol = await page.getOperatorList(), out = [];
  let ctm = vp.transform.slice(); const stack = [];
  const T = (x, y) => P.Util.applyTransform([x, y], ctm);
  const vert = (a, b) => { if (Math.abs(a[0] - b[0]) < 1.2 && Math.abs(a[1] - b[1]) > 4 && out.length < 6000) out.push({ x: (a[0] + b[0]) / 2, y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) }); };
  for (let k = 0; k < ol.fnArray.length; k++) {
    const fn = ol.fnArray[k], a = ol.argsArray[k];
    if (fn === O.save) stack.push(ctm.slice());
    else if (fn === O.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === O.transform) ctm = P.Util.transform(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm.slice()); if (a && a[0]) ctm = P.Util.transform(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (fn === O.constructPath) {
      const ops = a[0], args = a[1]; let j = 0, cur = null;
      for (const op of ops) {
        if (op === O.rectangle) {
          const [x, y, w, h] = args.slice(j, j + 4); j += 4;
          const p = [T(x, y), T(x + w, y), T(x, y + h), T(x + w, y + h)], xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
          const W = Math.max(...xs) - Math.min(...xs), H = Math.max(...ys) - Math.min(...ys);
          if (W < 2.5 && H > 4) vert([(Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys)], [(Math.min(...xs) + Math.max(...xs)) / 2, Math.max(...ys)]);
          else if (W > 4 && H > 4) { vert([Math.min(...xs), Math.min(...ys)], [Math.min(...xs), Math.max(...ys)]); vert([Math.max(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]); }   // a box: its sides
          cur = null;
        } else if (op === O.moveTo) { cur = T(args[j], args[j + 1]); j += 2; }
        else if (op === O.lineTo) { const n = T(args[j], args[j + 1]); j += 2; if (cur) vert(cur, n); cur = n; }
        else if (op === O.curveTo) { j += 6; cur = null; } else if (op === O.curveTo2 || op === O.curveTo3) { j += 4; cur = null; }
        else if (op === O.closePath) { /* nothing to read */ }
      }
    }
  }
  return out;
}
// OCR words (Tesseract's shape: blocks > paragraphs > lines > words with bbox) to pieces, in points
export function ocrPieces(data, scale, fix) {
  const out = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) {
    const lh = (l.bbox.y1 - l.bbox.y0) / scale;
    for (const w of l.words || []) {
      let s = (w.text || "").trim(); if (!s || (w.confidence != null && w.confidence < 25 && s.length < 3)) continue;
      if (fix && /\d/.test(s) && /^[\d$(),.%\-OolISB]+$/.test(s)) s = fix(s);
      const h = (w.bbox.y1 - w.bbox.y0) / scale;
      out.push({ str: s, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale, base: l.baseline ? (l.baseline.y0 + l.baseline.y1) / 2 / scale : w.bbox.y1 / scale - h * 0.18, fs: Math.max(h, lh * 0.75) / 0.85, top: w.bbox.y0 / scale, bot: w.bbox.y1 / scale, font: { face: "Arial", bold: false, italic: false }, rot: 0, ocr: true });
    }
  }
  return out;
}
// lines of segments: pieces on the same baseline, left to right, joined when the gap is a word space
export function toLines(pieces, joinGap = 0.55) {
  const flat = pieces.filter((p) => !p.rot || Math.abs(p.rot) <= 2).sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  for (const p of flat) {
    let L = null;
    for (let k = lines.length - 1; k >= 0 && k >= lines.length - 4; k--) if (Math.abs(lines[k].base - p.base) < Math.min(lines[k].fs, p.fs) * 0.42) { L = lines[k]; break; }
    if (L) { L.pieces.push(p); L.fs = Math.max(L.fs, p.fs); } else lines.push({ base: p.base, fs: p.fs, pieces: [p] });
  }
  for (const L of lines) {
    L.pieces.sort((a, b) => a.x0 - b.x0);
    L.segs = [];
    for (const p of L.pieces) {
      const S = L.segs[L.segs.length - 1], fs = Math.min(p.fs, S ? S.fs : p.fs), mono = /courier|mono/i.test((p.font && p.font.face) || "");
      if (S && p.x0 - S.x1 < fs * (mono ? Math.max(joinGap, 0.75) : p.ocr ? Math.max(joinGap, 0.6) : joinGap)) {   // OCR reads words, not cells: their gaps are word spaces   // a monospaced space is 0.6 em, two of them a column gap
        const gap = p.x0 - S.x1, glue = (p.ocr || gap > fs * 0.12) && !/\s$/.test(S.str) ? " " : "";   // OCR boxes are whole words
        S.str += glue + p.str; S.runs.push({ ...p, str: glue + p.str }); S.x1 = Math.max(S.x1, p.x1); S.fs = Math.max(S.fs, p.fs);
      } else L.segs.push({ str: p.str, x0: p.x0, x1: p.x1, fs: p.fs, base: p.base, runs: [{ ...p }] });
    }
  }
  return lines.filter((L) => L.segs.length);
}

// ---- Excel ---------------------------------------------------------------------------------------------------------
// what a cell's text is: a number (with its format), a date, or text
export function cellValue(raw) {
  const s = String(raw).trim().replace(/−/g, "-");
  if (!s) return null;
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) { let [, mo, d, y] = m.map(Number); if (y < 100) y += y < 70 ? 2000 : 1900; if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { const t = Date.UTC(y, mo - 1, d); const dt = new Date(t); if (dt.getUTCDate() === d) return { n: (t - Date.UTC(1899, 11, 30)) / 864e5, fmt: "mm/dd/yyyy" }; } }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) { const [, y, mo, d] = m.map(Number); if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return { n: (Date.UTC(y, mo - 1, d) - Date.UTC(1899, 11, 30)) / 864e5, fmt: "yyyy-mm-dd" }; }
  // amounts: -$1,234.56  ($1,234.56)  1,234.56-  $ 1,234  12.5%  -0.75  1.234,56 is left as text (not US style)
  m = s.match(/^(\()?\s*([-+])?\s*(\$|USD\s?|€|£)?\s*([-+])?\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)\s*(%)?\s*(\))?\s*(-|CR|DR)?$/i);
  if (!m) return { s };
  const [, po, sg1, cur, sg2, num, pct, pc, tail] = m;
  if (!!po !== !!pc) return { s };
  const digits = num.replace(/[,.]/g, ""), hasComma = num.includes(","), dec = (num.split(".")[1] || "").length;
  if (!hasComma && !dec && !cur && !pct && (/^0\d/.test(num) || digits.length >= 9)) return { s };   // 02134, account / ID numbers
  if (digits.length > 15) return { s };
  let n = parseFloat(num.replace(/,/g, ""));
  const neg = !!po || sg1 === "-" || sg2 === "-" || tail === "-" || /^DR$/i.test(tail || "");
  if (neg) n = -n;
  if (pct) return { n: n / 100, fmt: dec ? "0." + "0".repeat(dec) + "%" : "0%" };
  const base = (hasComma || cur || dec ? "#,##0" : "0") + (dec ? "." + "0".repeat(dec) : "");   // amounts with cents: the accounting look, thousands separated
  const sym = cur ? (/€/.test(cur) ? '"€"' : /£/.test(cur) ? '"£"' : '"$"') : "";
  const pos = sym + base;
  const fmt = po ? `${pos}_);(${pos})` : (base === "0" && !sym ? null : pos);
  return { n, fmt };
}
// one page's rows: [{ cells: [{ c, s|n, fmt, bold }], gapBefore }]
export function pageTable(lines, rules = []) {
  const rows = [];
  const isTab = (L) => L.segs.length >= 2;
  const fsMed = median(lines.map((l) => l.fs)) || 10;
  let i = 0, prevBase = null;
  while (i < lines.length) {
    const L = lines[i];
    if (!isTab(L)) { rows.push({ line: L, cols: null, gap: prevBase != null && L.base - prevBase > Math.max(L.fs, fsMed) * 2.1 }); prevBase = L.base; i++; continue; }
    // a block: tabular lines, with indented continuation lines that sit close under them
    const block = [L]; let j = i + 1;
    while (j < lines.length) {
      const N = lines[j], last = block[block.length - 1], dy = N.base - last.base;
      if (dy > Math.max(N.fs, last.fs) * 2.6) break;
      if (isTab(N)) { block.push(N); j++; continue; }
      const left = Math.min(...block.filter(isTab).map((b) => b.segs[0].x0));
      // a row with only one cell filled (a date and nothing else), at the table's row spacing, with the table going on after it
      const pitch = block.length > 1 ? median(block.slice(1).map((b, q) => b.base - block[q].base)) : dy;
      if (j + 1 < lines.length && isTab(lines[j + 1]) && dy < pitch * 1.35 && lines[j + 1].base - N.base < pitch * 1.35 && Math.abs(N.fs - last.fs) < 1) { block.push(N); j++; continue; }
      if (N.segs[0].x0 > left + fsMed * 1.5 && j + 1 < lines.length && isTab(lines[j + 1]) && lines[j + 1].base - N.base < Math.max(N.fs, fsMed) * 2.6) { block.push(N); j++; continue; }
      if (N.segs[0].x0 > left + fsMed * 1.5 && dy < Math.max(N.fs, last.fs) * 1.6) { block.push(N); j++; continue; }
      break;
    }
    // columns: white channels that (almost) no tabular line covers. Measured on the pieces the PDF draws (a program
    // like Excel draws every cell on its own, often only half a space apart), so tight columns still come apart;
    // the gaps between words of a phrase differ from row to row and never make a channel.
    const tab = block.filter(isTab), all = tab.flatMap((b) => b.pieces);
    const x0 = Math.floor(Math.min(...all.map((p) => p.x0))), x1 = Math.ceil(Math.max(...all.map((p) => p.x1)));
    const cov = new Uint16Array(Math.max(1, x1 - x0 + 1));
    for (const p of all) for (let x = Math.max(0, Math.ceil(p.x0) - x0); x <= Math.min(cov.length - 1, Math.floor(p.x1) - x0); x++) cov[x]++;
    const mono = all.filter((p) => /courier|mono/i.test((p.font && p.font.face) || "")).length > all.length / 2;
    const allow = tab.length >= 10 ? Math.floor(tab.length * 0.08) : 0, minGap = fsMed * (mono ? 0.75 : 0.3), cuts = [], chans = [];
    for (let x = 0; x < cov.length;) { if (cov[x] > allow) { x++; continue; } let e = x; while (e < cov.length && cov[e] <= allow) e++; if (e - x >= minGap && x > 0 && e < cov.length) { cuts.push(x0 + (x + e) / 2); chans.push([x0 + x, x0 + e]); } x = e; }
    // ruled lines: a vertical line beside most of the table's rows, that no text crosses, divides two columns (cells
    // with borders often sit closer than any white channel)
    if (rules.length) {
      const xs = [...new Set(rules.filter((r) => r.x > x0 + 1 && r.x < x1 - 1).map((r) => Math.round(r.x * 2) / 2))].sort((a, b) => a - b), seen = [];
      for (const rx of xs) {
        if (seen.length && rx - seen[seen.length - 1] < 1) continue;
        const near = rules.filter((r) => Math.abs(r.x - rx) < 0.8);
        const beside = tab.filter((b) => near.some((r) => r.y0 <= b.base - b.fs * 0.5 && r.y1 >= b.base - b.fs * 0.2)).length;
        const crossed = tab.filter((b) => b.pieces.some((p) => p.x0 < rx - 0.6 && p.x1 > rx + 0.6)).length;
        if (beside < tab.length * 0.5 || crossed > tab.length * 0.1) continue;
        seen.push(rx);
        const k = chans.findIndex(([a, b]) => rx >= a - 1.5 && rx <= b + 1.5);   // the white channel the line runs in
        if (k >= 0) cuts[k] = rx; else cuts.push(rx);
      }
      cuts.sort((a, b) => a - b);
      for (let k = cuts.length - 1; k > 0; k--) if (cuts[k] - cuts[k - 1] < 1) cuts.splice(k, 1);
    }
    for (const b of block) { rows.push({ line: b, cuts, tab: isTab(b), gap: prevBase != null && b === block[0] && b.base - prevBase > Math.max(b.fs, fsMed) * 2.1 }); prevBase = b.base; }
    i = j;
  }
  // rows -> cells: in a table every piece goes to the column its middle is in (a continuation line: where it
  // starts); pieces that share a column share the cell
  const col = (cuts, x) => { let k = 0; while (k < cuts.length && x > cuts[k]) k++; return k; };
  return rows.map((r) => {
    const cells = new Map();
    const add = (c, str, x0, x1, fs, bold) => {
      if (cells.has(c)) { const e = cells.get(c); e.text += (x0 - e.x1 > fs * 0.12 && !/\s$/.test(e.text) ? " " : "") + str; e.x1 = x1; e.bold = e.bold && bold; }
      else cells.set(c, { c, text: str, x1, bold });
    };
    if (r.cuts && r.tab) for (const p of r.line.pieces) add(col(r.cuts, (p.x0 + p.x1) / 2), p.str, p.x0, p.x1, p.fs, !!(p.font && p.font.bold));
    else r.line.segs.forEach((s) => add(r.cuts ? col(r.cuts, s.x0) : 0, s.str, s.x0, s.x1, s.fs, s.runs.every((x) => x.font && x.font.bold)));
    return { gap: r.gap, cells: [...cells.values()].sort((a, b) => a.c - b.c).map(({ c, text, bold }) => ({ c, text, bold })) };
  });
}
const colName = (c) => { let s = ""; c++; while (c) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; };

/**
 * @param pages   [{ name, rows }] rows from pageTable (one sheet per entry)
 * @returns Blob (.xlsx)
 */
export async function writeXlsx(JSZip, sheets, meta = {}) {
  const zip = new JSZip(), strings = [], sIndex = new Map();
  const str = (s) => { if (!sIndex.has(s)) { sIndex.set(s, strings.length); strings.push(s); } return sIndex.get(s); };
  const fmts = new Map(), xfs = [{ fmt: 0, bold: false }], xfIndex = new Map([["0|0", 0]]);
  const builtin = { "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10 };
  const xf = (fmt, bold) => {
    let id = 0;
    if (fmt) { id = builtin[fmt]; if (id == null) { if (!fmts.has(fmt)) fmts.set(fmt, 164 + fmts.size); id = fmts.get(fmt); } }
    const k = id + "|" + (bold ? 1 : 0);
    if (!xfIndex.has(k)) { xfIndex.set(k, xfs.length); xfs.push({ fmt: id, bold }); }
    return xfIndex.get(k);
  };
  const sheetXml = [];
  for (const sh of sheets) {
    const widths = [];
    let r = 0; const rowsXml = [];
    for (const row of sh.rows) {
      if (row.gap && r) r++;
      r++;
      if (!row.cells.length) continue;
      const cx = row.cells.map((cell) => {
        const v = cellValue(cell.text), ref = colName(cell.c) + r;
        const len = String(cell.text).length; widths[cell.c] = Math.max(widths[cell.c] || 0, len);
        if (v && v.n != null && isFinite(v.n)) { const s = xf(v.fmt, cell.bold); return `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${+v.n.toFixed(10)}</v></c>`; }
        const s = xf(null, cell.bold);
        return `<c r="${ref}" t="s"${s ? ` s="${s}"` : ""}><v>${str(cell.text)}</v></c>`;
      });
      rowsXml.push(`<row r="${r}">${cx.join("")}</row>`);
    }
    const cols = widths.map((w, c) => (w ? `<col min="${c + 1}" max="${c + 1}" width="${Math.min(70, Math.max(8, Math.round(w * 1.1 + 2)))}" customWidth="1"/>` : "")).join("");
    sheetXml.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${XNS}><sheetViews><sheetView workbookViewId="0"${sheetXml.length ? "" : ' tabSelected="1"'}/></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rowsXml.join("")}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`);
  }
  const names = []; sheets.forEach((s, k) => { let n = String(s.name || "Sheet " + (k + 1)).replace(/[\\/?*[\]:]/g, " ").slice(0, 31).trim() || "Sheet " + (k + 1); while (names.includes(n)) n = n.slice(0, 28) + " " + k; names.push(n); });
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title || "")}</dc:title><dc:creator>Ghost Calligrapher</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Ghost Calligrapher</Application></Properties>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook ${XNS}><bookViews><workbookView/></bookViews><sheets>${names.map((n, k) => `<sheet name="${esc(n)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}</sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  sheetXml.forEach((x, k) => zip.file(`xl/worksheets/sheet${k + 1}.xml`, x));
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst ${XNS} count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`);
  const numFmts = [...fmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("");
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet ${XNS}>${numFmts ? `<numFmts count="${fmts.size}">${numFmts}</numFmts>` : ""}<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.map((x) => `<xf numFmtId="${x.fmt}" fontId="${x.bold ? 1 : 0}" fillId="0" borderId="0" xfId="0"${x.fmt ? ' applyNumberFormat="1"' : ""}${x.bold ? ' applyFont="1"' : ""}/>`).join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", compression: "DEFLATE" });
}

// ---- PowerPoint ---------------------------------------------------------------------------------------------------
// the page drawn without its upright text (turned text stays in the picture); text drawn as shapes stays too
export async function renderNoText(page, vp) {
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  const upright = () => { const t = g.getTransform(); return Math.abs(t.b) < Math.abs(t.a) * 0.035 && Math.abs(t.c) < Math.abs(t.d) * 0.035; };
  const ft = g.fillText.bind(g), st = g.strokeText.bind(g);
  g.fillText = (...a) => { if (!upright()) ft(...a); };
  g.strokeText = (...a) => { if (!upright()) st(...a); };
  await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
  return c;
}
export async function renderFull(page, vp) {
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
  return c;
}
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
// the colour of the text in a box: the pixels that the text changed (full vs no-text pictures), averaged
export function inkColour(full, bare, box, k) {
  const x = Math.max(0, Math.floor(box.x0 * k)), y = Math.max(0, Math.floor(box.y0 * k)), w = Math.min(full.width - x, Math.ceil((box.x1 - box.x0) * k)), h = Math.min(full.height - y, Math.ceil((box.y1 - box.y0) * k));
  if (w < 1 || h < 1) return { hex: "000000", ink: 0 };
  const A = full.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, h).data, B = bare ? bare.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, h).data : null;
  const hits = [];
  for (let i = 0; i < A.length; i += 4) {
    const d = B ? Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) : 765 - A[i] - A[i + 1] - A[i + 2];
    if (d >= 120) hits.push([d, i]);
  }
  if (!hits.length) return { hex: "000000", ink: 0 };
  // the letters' solid middles (the pixels that changed most), not their soft edges
  hits.sort((p, q) => q[0] - p[0]);
  const core = hits.slice(0, Math.max(1, Math.ceil(hits.length * 0.3)));
  let r = 0, gg = 0, b = 0; for (const [, i] of core) { r += A[i]; gg += A[i + 1]; b += A[i + 2]; }
  return { hex: hex2(r / core.length) + hex2(gg / core.length) + hex2(b / core.length), ink: hits.length / (A.length / 4) };
}
// wipe boxes (in points) off a picture with the paper colour around each one (scans)
export function wipe(canvas, boxes, k) {
  const g = canvas.getContext("2d", { willReadFrequently: true });
  for (const bx of boxes) {
    const pad = Math.max(2, (bx.y1 - bx.y0) * k * 0.12), x = Math.max(0, Math.floor(bx.x0 * k - pad)), y = Math.max(0, Math.floor(bx.y0 * k - pad));
    const w = Math.min(canvas.width - x, Math.ceil((bx.x1 - bx.x0) * k + pad * 2)), h = Math.min(canvas.height - y, Math.ceil((bx.y1 - bx.y0) * k + pad * 2));
    if (w < 2 || h < 2) continue;
    // the paper colour: the lightest half of the pixels on the box's edge
    const d = g.getImageData(x, y, w, h).data, edge = [];
    const push = (i) => edge.push([d[i], d[i + 1], d[i + 2]]);
    for (let xx = 0; xx < w; xx++) { push(xx * 4); push(((h - 1) * w + xx) * 4); }
    for (let yy = 0; yy < h; yy++) { push(yy * w * 4); push((yy * w + w - 1) * 4); }
    edge.sort((p, q) => (q[0] + q[1] + q[2]) - (p[0] + p[1] + p[2]));
    const top = edge.slice(0, Math.max(1, Math.floor(edge.length / 2)));
    const avg = [0, 1, 2].map((c) => top.reduce((s, p) => s + p[c], 0) / top.length);
    g.fillStyle = `rgb(${avg.map(Math.round).join(",")})`; g.fillRect(x, y, w, h);
  }
}
