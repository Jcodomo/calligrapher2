// Hard test for PDF to Excel and PDF to PowerPoint (sample data only). Documents with known content are made with
// pdf-lib, converted through the real PDF tools panel, and the .xlsx / .pptx files are read back and compared:
//   Excel - every cell of every table: its column, its value (numbers as numbers, dates as dates, codes with leading
//           zeros as text), its number format ($, %, brackets, decimals) and bold; a bank statement over two pages
//           with wrapped descriptions, an invoice, the same statement as a scan (OCR), and random tables in many
//           shapes (seeded, replayable).
//   PowerPoint - slide count and size, every line of text in a text box at its place (within 2 pt), in its size,
//           font, weight, slant and colour; the slide picture keeps the drawings and loses the text; turned text
//           stays in the picture; a page with only text has no picture; scans become text boxes on a wiped picture.
// To run: copy to web/_t/stress-office.js, open the app, then
//   (await import("/_t/stress-office.js")).run({ tables: 30 }).then((r) => console.log(r.summary))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
async function until(fn, ms = 8000, step = 40) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
async function lib(name, url) { if (window[name]) return window[name]; const s = document.createElement("script"); s.src = url; document.head.append(s); await new Promise((r, j) => { s.onload = r; s.onerror = j; }); return window[name]; }
const pdfLib = () => lib("PDFLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
const pdfjs = async () => { const p = await lib("pdfjsLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"); if (!p.GlobalWorkerOptions.workerSrc) p.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; return p; };
const zipLib = () => lib("JSZip", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 864e5;

// ---- documents with known tables ----------------------------------------------------------------------------------
// a table: columns { title, align, kind }, rows of cells { text, v (expected value), fmt (regex the format must match) }
// drawn at (x, y) with font size fs; returns the expected rows (header + data) in sheet order
function drawTable(page, fonts, T, x, y, fs, L) {
  const { reg, bold } = fonts, gap = fs * T.gapEm, widths = T.cols.map((c, k) => Math.max(bold.widthOfTextAtSize(c.title, fs), ...T.rows.map((r) => (r[k] ? reg.widthOfTextAtSize(r[k].text, fs) : 0))));
  const xs = []; let at = x; widths.forEach((w) => { xs.push(at); at += w + gap; });
  const put = (s, k, yy, f) => { const w = f.widthOfTextAtSize(s, fs), xx = T.cols[k].align === "right" ? xs[k] + widths[k] - w : xs[k]; page.drawText(s, { x: xx, y: yy, size: fs, font: f, color: L.rgb(0, 0, 0) }); };
  const out = [];
  T.cols.forEach((c, k) => put(c.title, k, y, bold));
  out.push(T.cols.map((c, k) => ({ c: k, v: c.title, bold: true })));
  T.rows.forEach((r, j) => {
    const yy = y - (j + 1) * fs * T.lead;
    r.forEach((cell, k) => { if (cell) put(cell.text, k, yy, cell.bold ? bold : reg); });
    out.push(r.map((cell, k) => (cell ? { c: k, v: cell.v, fmt: cell.fmt, bold: !!cell.bold } : null)).filter(Boolean));
  });
  return { rows: out, bottom: y - T.rows.length * fs * T.lead, width: at - gap - x };
}
const KINDS = {
  int: (r) => { const n = Math.floor(r() * 900) + 1; return { text: String(n), v: n }; },
  money: (r) => { const n = Math.round(r() * 1e7) / 100; return { text: n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), v: n, fmt: /#,##0\.00/ }; },
  usd: (r) => { const n = Math.round(r() * 1e6) / 100; return { text: "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), v: n, fmt: /\$.*0\.00/ }; },
  paren: (r) => { const n = Math.round(r() * 1e6) / 100; const t = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return r() < 0.5 ? { text: "(" + t + ")", v: -n, fmt: /\(/ } : { text: t, v: n, fmt: /0\.00/ }; },
  minus: (r) => { const n = Math.round(r() * 1e5) / 100; return { text: "-" + n.toFixed(2), v: -n }; },
  pct: (r) => { const n = Math.round(r() * 10000) / 1000; return { text: n.toFixed(3) + "%", v: n / 100, fmt: /%/ }; },
  date: (r) => { const y = 2020 + Math.floor(r() * 7), m = 1 + Math.floor(r() * 12), d = 1 + Math.floor(r() * 28); return { text: `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${y}`, v: serial(y, m, d), fmt: /m.*d.*y/ }; },
  code: (r) => { const s = "0" + String(Math.floor(r() * 1e6)).padStart(6, "0"); return { text: s, v: s }; },
  acct: (r) => { const s = String(Math.floor(1e9 + r() * 8e9)); return { text: s, v: s }; },
  word: (r) => { const W = ["Deposit", "Payroll", "Transfer", "Check", "Fee", "Interest", "Mortgage", "Utility", "Insurance", "Refund", "Escrow", "Tax"]; const s = W[Math.floor(r() * W.length)] + (r() < 0.5 ? " " + W[Math.floor(r() * W.length)].toLowerCase() : ""); return { text: s, v: s }; },
};
function randomTable(r) {
  const kinds = Object.keys(KINDS), n = 3 + Math.floor(r() * 5), cols = [];
  for (let k = 0; k < n; k++) { const kind = k === 1 ? "word" : kinds[Math.floor(r() * kinds.length)]; cols.push({ kind, title: ["Date", "Description", "Amount", "Rate", "Code", "Balance", "Qty", "Ref"][k] + (k > 7 ? k : ""), align: /word|code|acct|date/.test(kind) ? "left" : "right" }); }
  const rows = [], m = 4 + Math.floor(r() * 18);
  for (let j = 0; j < m; j++) rows.push(cols.map((c, k) => (k > 0 && r() < 0.12 ? null : KINDS[c.kind](r))));
  return { cols, rows, gapEm: 1.2 + r() * 2.5, lead: 1.3 + r() * 0.5 };
}
async function makeTablesDoc(seed, nTables) {
  const L = await pdfLib(), d = await L.PDFDocument.create(), r = rng(seed);
  const fonts = { reg: await d.embedFont(L.StandardFonts.Helvetica), bold: await d.embedFont(L.StandardFonts.HelveticaBold) };
  const pages = [];
  let page = null, y = 0, exp = null;
  for (let t = 0; t < nTables; t++) {
    const T = randomTable(r), fs = 7 + Math.floor(r() * 5), need = (T.rows.length + 2) * fs * T.lead + 30;
    if (!page || y - need < 40) { page = d.addPage(r() < 0.25 ? [792, 612] : [612, 792]); y = page.getHeight() - 60; exp = []; pages.push(exp); }
    const title = "Table " + (t + 1) + " sample figures";
    page.drawText(title, { x: 50, y, size: fs + 2, font: fonts.bold }); exp.push([{ c: 0, v: title, bold: true }]); y -= (fs + 2) * 2.2;
    const res = drawTable(page, fonts, T, 50, y, fs, L);
    if (res.width > page.getWidth() - 60) { /* too wide: still drawn, cut off at the edge - leave it out of the check */ exp.skip = true; }
    exp.push(...res.rows); y = res.bottom - fs * 3.2;
  }
  return { bytes: new Uint8Array(await d.save()), pages };
}
async function makeStatement() {
  const L = await pdfLib(), d = await L.PDFDocument.create(), reg = await d.embedFont(L.StandardFonts.Helvetica), bold = await d.embedFont(L.StandardFonts.HelveticaBold);
  const exp = [[], []];
  let p = d.addPage([612, 792]);
  p.drawText("FIRST SAMPLE BANK", { x: 50, y: 740, size: 16, font: bold }); exp[0].push([{ c: 0, v: "FIRST SAMPLE BANK", bold: true }]);
  p.drawText("Account holder JANE SAMPLE", { x: 50, y: 712, size: 10, font: reg }); exp[0].push([{ c: 0, v: "Account holder JANE SAMPLE" }]);
  p.drawText("Account number", { x: 50, y: 698, size: 10, font: reg }); p.drawText("0000-123456", { x: 160, y: 698, size: 10, font: reg }); exp[0].push([{ c: 0, v: "Account number" }, { c: 1, v: "0000-123456" }]);
  p.drawText("ZIP", { x: 50, y: 684, size: 10, font: reg }); p.drawText("02134", { x: 160, y: 684, size: 10, font: reg }); exp[0].push([{ c: 0, v: "ZIP" }, { c: 1, v: "02134" }]);
  const X = [50, 120, 330, 420, 510], R = [false, false, true, true, true], W = [60, 200, 80, 80, 80];
  const head = ["Date", "Description", "Withdrawals", "Deposits", "Balance"];
  const cell = (pg, s, k, y, f) => { const w = f.widthOfTextAtSize(s, 9); pg.drawText(s, { x: R[k] ? X[k] + W[k] - w : X[k], y, size: 9, font: f }); };
  let y = 650, bal = 2500, pi = 0;
  const header = (pg) => { head.forEach((h, k) => cell(pg, h, k, y, bold)); exp[pi].push(head.map((h, k) => ({ c: k, v: h, bold: true }))); y -= 15; };
  header(p);
  const r = rng(99);
  for (let j = 0; j < 46; j++) {
    if (y < 70) { pi = 1; p = d.addPage([612, 792]); y = 740; header(p); }
    const day = 1 + Math.floor(j * 0.66), dt = `01/${String(day).padStart(2, "0")}/2026`, out = r() < 0.6, amt = Math.round(r() * 90000) / 100;
    bal = Math.round((bal + (out ? -amt : amt)) * 100) / 100;
    const fmt = (n) => Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const desc = ["Card purchase SAMPLE STORE", "Payroll deposit SAMPLE CO", "Online transfer to savings", "Check 1042", "Utility payment SAMPLE POWER"][j % 5];
    const row = [{ c: 0, v: serial(2026, 1, day), fmt: /m.*d.*y/ }, { c: 1, v: desc }];
    cell(p, dt, 0, y, reg); cell(p, desc, 1, y, reg);
    if (out) { cell(p, fmt(amt), 2, y, reg); row.push({ c: 2, v: amt, fmt: /#,##0\.00/ }); } else { cell(p, fmt(amt), 3, y, reg); row.push({ c: 3, v: amt, fmt: /#,##0\.00/ }); }
    const bt = bal < 0 ? "(" + fmt(bal) + ")" : fmt(bal); cell(p, bt, 4, y, reg); row.push({ c: 4, v: bal, fmt: bal < 0 ? /\(/ : /0\.00/ });
    exp[pi].push(row); y -= 13;
    if (j % 7 === 3) { p.drawText("ref SAMPLE-" + (1000 + j), { x: 120, y, size: 9, font: reg }); exp[pi].push([{ c: 1, v: "ref SAMPLE-" + (1000 + j) }]); y -= 13; }   // a wrapped description
  }
  y -= 8; cell(p, "Ending balance", 1, y, bold); const eb = bal < 0 ? "(" + Math.abs(bal).toLocaleString("en-US", { minimumFractionDigits: 2 }) + ")" : bal.toLocaleString("en-US", { minimumFractionDigits: 2 }); cell(p, eb, 4, y, bold);
  exp[pi].push([{ c: 1, v: "Ending balance", bold: true }, { c: 4, v: bal, bold: true }]);
  return { bytes: new Uint8Array(await d.save()), pages: exp };
}
async function makeInvoice() {
  const L = await pdfLib(), d = await L.PDFDocument.create(), reg = await d.embedFont(L.StandardFonts.TimesRoman), bold = await d.embedFont(L.StandardFonts.TimesRomanBold);
  const p = d.addPage([612, 792]), exp = [];
  p.drawText("INVOICE 2026-0042", { x: 60, y: 730, size: 18, font: bold }); exp.push([{ c: 0, v: "INVOICE 2026-0042", bold: true }]);
  const rows = [["Qty", "Item", "Unit price", "Amount"], ["2", "Appraisal report", "$450.00", "$900.00"], ["1", "Title search", "$1,250.00", "$1,250.00"], ["12", "Courier delivery", "$15.50", "$186.00"], ["", "Subtotal", "", "$2,336.00"], ["", "Tax", "8.875%", "$207.32"], ["", "Total due", "", "$2,543.32"]];
  const X = [30, 110, 380, 470], R = [true, false, true, true];
  rows.forEach((row, j) => {
    const y = 680 - j * 18, f = j === 0 || j === 6 ? bold : reg, e = [];
    row.forEach((s, k) => { if (!s) return; const w = f.widthOfTextAtSize(s, 11); p.drawText(s, { x: R[k] ? X[k] + 60 - w : X[k], y, size: 11, font: f });
      const num = /^\$/.test(s) ? { v: +s.replace(/[$,]/g, ""), fmt: /\$/ } : /%$/.test(s) ? { v: +s.replace("%", "") / 100, fmt: /%/ } : /^\d+$/.test(s) ? { v: +s } : { v: s };
      e.push({ c: k, ...num, bold: f === bold }); });
    exp.push(e);
  });
  return { bytes: new Uint8Array(await d.save()), pages: [exp] };
}
// the same pages stored turned (landscape on its side, /Rotate 90), as scanners and printers often save them
async function turnPages(bytes) {
  const L = await pdfLib(), src = await L.PDFDocument.load(bytes), d = await L.PDFDocument.create();
  for (const sp of src.getPages()) {
    const { width: w, height: h } = sp.getSize(), emb = await d.embedPage(sp), p = d.addPage([h, w]);
    p.drawPage(emb, { x: h, y: 0, rotate: L.degrees(90) }); p.setRotation(L.degrees(90));
  }
  return new Uint8Array(await d.save());
}
async function toScan(bytes, dpi = 200) {
  const P = await pdfjs(), L = await pdfLib(), src = await P.getDocument({ data: bytes.slice() }).promise, d = await L.PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    const pg = await src.getPage(i), vp = pg.getViewport({ scale: dpi / 72 }), c = document.createElement("canvas"); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); await pg.render({ canvasContext: g, viewport: vp }).promise;
    const jpg = await new Promise((r) => c.toBlob((b) => b.arrayBuffer().then((a) => r(new Uint8Array(a))), "image/jpeg", 0.9));
    const v1 = pg.getViewport({ scale: 1 }), p = d.addPage([v1.width, v1.height]); p.drawImage(await d.embedJpg(jpg), { x: 0, y: 0, width: v1.width, height: v1.height });
  }
  return new Uint8Array(await d.save());
}
// a page for the slides: fonts, sizes, colours, a filled box behind text, a logo, a rule, turned text
async function makeSlidePage() {
  const L = await pdfLib(), d = await L.PDFDocument.create(), lines = [];
  const F = { arial: await d.embedFont(L.StandardFonts.Helvetica), arialB: await d.embedFont(L.StandardFonts.HelveticaBold), times: await d.embedFont(L.StandardFonts.TimesRoman), timesI: await d.embedFont(L.StandardFonts.TimesRomanItalic), courier: await d.embedFont(L.StandardFonts.Courier) };
  const p = d.addPage([792, 612]);
  p.drawRectangle({ x: 40, y: 470, width: 712, height: 100, color: L.rgb(0.07, 0.2, 0.45) });
  p.drawRectangle({ x: 600, y: 60, width: 150, height: 120, color: L.rgb(0.95, 0.75, 0.1) });   // a "logo"
  p.drawEllipse({ x: 675, y: 120, xScale: 40, yScale: 40, color: L.rgb(0.8, 0.1, 0.1) });
  p.drawLine({ start: { x: 40, y: 440 }, end: { x: 752, y: 440 }, thickness: 2, color: L.rgb(0.3, 0.3, 0.3) });
  const put = (t, x, y, size, font, rgb, face, bold, italic) => { p.drawText(t, { x, y, size, font, color: L.rgb(...rgb) }); lines.push({ t, x, base: 612 - y, size, face, bold, italic, hex: rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase() }); };
  put("Quarterly Sample Review", 60, 520, 32, F.arialB, [1, 1, 1], "Arial", true, false);
  put("Prepared for SAMPLE TITLE COMPANY LLC", 60, 485, 14, F.arial, [0.85, 0.9, 1], "Arial", false, false);
  put("Closings rose in every region this quarter.", 60, 400, 18, F.times, [0, 0, 0], "Times New Roman", false, false);
  put("Average time to close fell to 31 days.", 60, 370, 18, F.timesI, [0.1, 0.4, 0.15], "Times New Roman", false, true);
  put("Ref US000000000001", 60, 330, 12, F.courier, [0.45, 0.45, 0.45], "Courier New", false, false);
  put("Red flag count 0", 60, 300, 16, F.arialB, [0.85, 0.1, 0.1], "Arial", true, false);
  p.drawText("TURNED NOTE", { x: 30, y: 100, size: 12, font: F.arial, rotate: L.degrees(90) });
  const p2 = d.addPage([792, 612]);   // only text: no picture needed
  p2.drawText("Only words on this slide", { x: 60, y: 500, size: 24, font: F.arial });
  return { bytes: new Uint8Array(await d.save()), lines };
}

// ---- reading the results back ---------------------------------------------------------------------------------------
async function readXlsx(blob) {
  const z = await (await zipLib()).loadAsync(blob), X = (s) => new DOMParser().parseFromString(s, "application/xml");
  const ss = z.file("xl/sharedStrings.xml") ? [...X(await z.file("xl/sharedStrings.xml").async("string")).getElementsByTagName("si")].map((si) => si.textContent) : [];
  const st = X(await z.file("xl/styles.xml").async("string")), fmts = {}; [...st.getElementsByTagName("numFmt")].forEach((n) => (fmts[n.getAttribute("numFmtId")] = n.getAttribute("formatCode")));
  const BUILT = { 0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00", 9: "0%", 10: "0.00%", 14: "m/d/yyyy" };
  const fonts = [...st.getElementsByTagName("fonts")[0].getElementsByTagName("font")].map((f) => f.getElementsByTagName("b").length > 0);
  const xfs = [...st.getElementsByTagName("cellXfs")[0].getElementsByTagName("xf")].map((x) => ({ fmt: fmts[x.getAttribute("numFmtId")] || BUILT[x.getAttribute("numFmtId")] || "General", bold: fonts[+x.getAttribute("fontId")] }));
  const wb = X(await z.file("xl/workbook.xml").async("string")), sheets = [];
  const names = [...wb.getElementsByTagName("sheet")].map((s) => s.getAttribute("name"));
  for (let k = 1; z.file(`xl/worksheets/sheet${k}.xml`); k++) {
    const doc = X(await z.file(`xl/worksheets/sheet${k}.xml`).async("string")), rows = [];
    for (const row of doc.getElementsByTagName("row")) {
      const cells = [...row.getElementsByTagName("c")].map((c) => { const ref = c.getAttribute("r"), col = ref.replace(/\d+/g, "").split("").reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1, v = (c.getElementsByTagName("v")[0] || {}).textContent, s = xfs[+(c.getAttribute("s") || 0)];
        return { c: col, v: c.getAttribute("t") === "s" ? ss[+v] : +v, isNum: c.getAttribute("t") !== "s", fmt: s.fmt, bold: s.bold }; });
      rows.push(cells);
    }
    sheets.push({ name: names[k - 1], rows });
  }
  return sheets;
}
// compare expected rows with a sheet's rows (in order, empty rows skipped); per cell: column, value, type, format, bold
function compareRows(exp, got, tag, ok, stats) {
  let gi = 0; const G = got.filter((r) => r.length);
  for (const er of exp) {
    const gr = G[gi++] || [];
    for (const ec of er) {
      stats.cells++;
      const gc = gr.find((c) => c.c === ec.c);
      const num = typeof ec.v === "number";
      const right = gc && (num ? gc.isNum && Math.abs(gc.v - ec.v) < 1e-6 : !gc.isNum && String(gc.v) === String(ec.v));
      const fmtOk = !ec.fmt || (gc && ec.fmt.test(gc.fmt));
      const boldOk = ec.bold == null || !gc || !!gc.bold === !!ec.bold;
      if (right && fmtOk && boldOk) stats.right++;
      else if (stats.bad.length < 25) stats.bad.push(`${tag} row ${gi}: want ${JSON.stringify(ec.v)}${num ? "(n)" : ""} in col ${ec.c}${ec.fmt ? " fmt " + ec.fmt : ""}${ec.bold ? " bold" : ""}; got ${gc ? JSON.stringify(gc.v) + (gc.isNum ? "(n)" : "") + " fmt " + gc.fmt + (gc.bold ? " bold" : "") : "nothing"} | row: ${gr.map((c) => c.c + ":" + c.v).join(" ; ").slice(0, 140)}`);
    }
    if (gr.length > er.length) { stats.extra += gr.length - er.length; if (stats.bad.length < 25) stats.bad.push(`${tag} row ${gi}: extra cells ${gr.map((c) => c.c + ":" + c.v).join(" ; ").slice(0, 140)}`); }
  }
  stats.rowsExtra += Math.max(0, G.length - exp.length);
}
const EMU = 12700;
async function readPptx(blob) {
  const z = await (await zipLib()).loadAsync(blob), X = (s) => new DOMParser().parseFromString(s, "application/xml");
  const pres = X(await z.file("ppt/presentation.xml").async("string")), sz = pres.getElementsByTagName("p:sldSz")[0];
  const slides = [];
  for (let k = 1; z.file(`ppt/slides/slide${k}.xml`); k++) {
    const doc = X(await z.file(`ppt/slides/slide${k}.xml`).async("string")), boxes = [], pics = [];
    const rels = X(await z.file(`ppt/slides/_rels/slide${k}.xml.rels`).async("string")), relMap = {}; [...rels.getElementsByTagName("Relationship")].forEach((r) => (relMap[r.getAttribute("Id")] = r.getAttribute("Target")));
    for (const sp of doc.getElementsByTagName("p:sp")) {
      const off = sp.getElementsByTagName("a:off")[0], ext = sp.getElementsByTagName("a:ext")[0], runs = [...sp.getElementsByTagName("a:r")];
      if (!runs.length) continue;
      const r0 = runs[0].getElementsByTagName("a:rPr")[0], fill = r0 && r0.getElementsByTagName("a:srgbClr")[0], latin = r0 && r0.getElementsByTagName("a:latin")[0];
      boxes.push({ text: runs.map((r) => r.getElementsByTagName("a:t")[0].textContent).join(""), x: +off.getAttribute("x") / EMU, y: +off.getAttribute("y") / EMU, w: +ext.getAttribute("cx") / EMU,
        size: r0 ? +r0.getAttribute("sz") / 100 : 0, bold: r0 && r0.getAttribute("b") === "1", italic: r0 && r0.getAttribute("i") === "1", hex: fill ? fill.getAttribute("val").toUpperCase() : "", face: latin ? latin.getAttribute("typeface") : "" });
    }
    for (const pic of doc.getElementsByTagName("p:pic")) { const b = pic.getElementsByTagName("a:blip")[0], id = b.getAttribute("r:embed"); pics.push({ target: relMap[id] }); }
    slides.push({ boxes, pics });
  }
  return { z, w: +sz.getAttribute("cx") / EMU, h: +sz.getAttribute("cy") / EMU, slides };
}

// ---- running the panels -----------------------------------------------------------------------------------------------
function catchLinks() {
  const got = [], orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download && this.href.startsWith("blob:")) { const name = this.download; got.push(fetch(this.href).then((r) => r.blob()).then((blob) => ({ name, blob }))); return; } return orig.call(this); };
  return { got, stop: () => { HTMLAnchorElement.prototype.click = orig; } };
}
async function convert(tool, bytes, setup) {
  const C = catchLinks();
  try {
    await window.__cal2RunPdfTool(tool, bytes, "sample.pdf"); await sleep(150);
    if (setup) setup();
    const b = await until(() => $("#pe_of_go"), 4000); if (!b) return { err: "no button" };
    const t = performance.now(); b.click();
    const f = await until(() => (C.got.length ? Promise.all(C.got) : /Failed|could not/i.test(($("#pe_err") || {}).textContent || "") ? "err" : null), 240000, 50);
    if (f === "err" || !f) return { err: ($("#pe_err") || {}).textContent || "timeout" };
    return { ...f[0], ms: Math.round(performance.now() - t) };
  } finally { C.stop(); }
}
const set = (id, v) => { const e = $("#" + id); if (e) { e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); } };

export async function run({ tables = 24, seed = Math.floor(Math.random() * 1e9), scan = true, slides = true, keep = false, long = false } = {}) {
  const out = [], files = {}, ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 400) }); return !!cond; };
  const xl = async (tag, bytes, exp, opts = {}) => {
    const r = await convert("pdfexcel", bytes, () => { if (opts.layout) set("pe_of_layout", opts.layout); });
    if (!ok(`${tag}: workbook made`, r.blob, r.err)) return null;
    if (keep) files[tag] = r.blob;
    if (opts.noBold) exp = exp.map((pe) => Object.assign(pe.map((row) => row.map((c) => ({ ...c, bold: undefined }))), { skip: pe.skip }));
    const sheets = await readXlsx(r.blob), stats = { cells: 0, right: 0, extra: 0, rowsExtra: 0, bad: [] };
    if (opts.layout === "one") compareRows(exp.flat(), sheets[0].rows, tag, ok, stats);
    else { ok(`${tag}: one sheet per page`, sheets.length === exp.length, sheets.map((s) => s.name).join(",")); exp.forEach((pe, i) => { if (!pe.skip) compareRows(pe, (sheets[i] || { rows: [] }).rows, tag + " p" + (i + 1), ok, stats); }); }
    return { stats, ms: r.ms, size: r.blob.size };
  };
  const tally = [];
  // 1. bank statement, invoice
  const st = await makeStatement(), inv = await makeInvoice();
  for (const [tag, D, opts, min] of [["statement", st, {}, 1], ["statement (one sheet)", st, { layout: "one" }, 1], ["invoice", inv, {}, 1]]) {
    const R = await xl(tag, D.bytes, D.pages, opts); if (!R) continue;
    tally.push([tag, R.stats]);
    ok(`${tag}: every cell right (value, type, format, bold, column)`, R.stats.right / R.stats.cells >= min && !R.stats.extra, `${R.stats.right}/${R.stats.cells} cells right, ${R.stats.extra} extra; ${R.stats.bad.slice(0, 4).join(" || ")}`);
  }
  {
    const R = await xl("statement on turned pages", await turnPages(st.bytes), st.pages);
    if (R) { tally.push(["turned", R.stats]); ok("statement on turned pages: every cell right", R.stats.right === R.stats.cells && !R.stats.extra, `${R.stats.right}/${R.stats.cells}; ${R.stats.bad.slice(0, 3).join(" || ")}`); }
  }
  // 2. random tables (several seeds' worth in one document set)
  {
    const D = await makeTablesDoc(seed, tables), R = await xl(`random tables (seed ${seed})`, D.bytes, D.pages);
    if (R) { tally.push(["random", R.stats]); ok(`random tables (seed ${seed}): cells right`, R.stats.right / R.stats.cells >= 0.995 && R.stats.extra === 0, `${R.stats.right}/${R.stats.cells} (${(100 * R.stats.right / R.stats.cells).toFixed(2)}%), ${R.stats.extra} extra, ${D.pages.length} pages, ${R.ms} ms; ${R.stats.bad.slice(0, 5).join(" || ")}`); }
  }
  // 3. the statement as a scan, read with OCR: numbers, dates and text from pictures
  if (scan) {
    const sb = await toScan(st.bytes, 200), R = await xl("statement scan (OCR)", sb, st.pages, { noBold: true });   // a scan has no fonts: bold is not read
    if (R) { tally.push(["scan", R.stats]); ok("statement scan (OCR): cells right", R.stats.right / R.stats.cells >= 0.97, `${R.stats.right}/${R.stats.cells} (${(100 * R.stats.right / R.stats.cells).toFixed(1)}%), ${R.stats.extra} extra, ${R.ms} ms; ${R.stats.bad.slice(0, 5).join(" || ")}`); }
  }
  // 4. PowerPoint
  if (slides) {
    const S = await makeSlidePage(), r = await convert("pdfppt", S.bytes);
    if (ok("slides: deck made", r.blob, r.err)) {
      if (keep) files.slides = r.blob;
      const D = await readPptx(r.blob), s1 = D.slides[0];
      ok("slides: one slide per page, the page's size", D.slides.length === 2 && Math.abs(D.w - 792) < 1 && Math.abs(D.h - 612) < 1, `${D.slides.length} slides ${D.w}x${D.h} pt`);
      for (const L of S.lines) {
        const b = s1.boxes.find((x) => x.text === L.t);
        if (!ok(`slides: "${L.t}" is a text box`, b, s1.boxes.map((x) => x.text).join(" | "))) continue;
        ok(`slides: "${L.t}" at its place`, Math.abs(b.x - L.x) < 2 && Math.abs(b.y + L.size * 0.9 - L.base) < 2.5, `x ${b.x.toFixed(1)} vs ${L.x}, top ${b.y.toFixed(1)} vs ${(L.base - L.size * 0.9).toFixed(1)}`);
        ok(`slides: "${L.t}" size, font, weight, slant`, Math.abs(b.size - L.size) <= 0.5 && b.face === L.face && !!b.bold === L.bold && !!b.italic === L.italic, `${b.size}pt ${b.face} b${b.bold} i${b.italic} (want ${L.size} ${L.face} b${L.bold} i${L.italic})`);
        const close = (a, c) => [0, 2, 4].every((k) => Math.abs(parseInt(a.slice(k, k + 2), 16) - parseInt(c.slice(k, k + 2), 16)) <= 24);
        ok(`slides: "${L.t}" colour`, b.hex && close(b.hex, L.hex), b.hex + " vs " + L.hex);
      }
      ok("slides: turned text stays in the picture, not a box", !s1.boxes.some((x) => /TURNED/.test(x.text)), "");
      ok("slides: slide 1 has the page's picture", s1.pics.length === 1, s1.pics.length);
      ok("slides: a slide with only text has no picture", D.slides[1].pics.length === 0 && D.slides[1].boxes.some((b) => b.text === "Only words on this slide"), D.slides[1].pics.length + " pictures");
      // the picture: drawings kept, text gone
      if (s1.pics[0]) {
        const img = await createImageBitmap(await D.z.file("ppt/" + s1.pics[0].target.replace("../", "")).async("blob")), c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0);
        const k = img.width / 792, at = (x, y) => g.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
        const navy = at(300, 70), gold = at(620, 470), red = at(675, 492);
        ok("slides: picture keeps the filled box, logo and shapes", navy[2] > 90 && navy[0] < 40 && gold[0] > 200 && gold[2] < 80 && red[0] > 170 && red[1] < 60, `navy ${[...navy].slice(0, 3)} gold ${[...gold].slice(0, 3)} red ${[...red].slice(0, 3)}`);
        const inkIn = (x0, y0, x1, y1) => { const d = g.getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.round((x1 - x0) * k), Math.round((y1 - y0) * k)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) n++; return n / (d.length / 4); };
        const t1 = inkIn(60, 195, 420, 216), t2 = inkIn(60, 268, 300, 284);
        ok("slides: picture has no text left under the text boxes", t1 < 0.002 && t2 < 0.002, `ink ${(t1 * 100).toFixed(2)}% / ${(t2 * 100).toFixed(2)}%`);
        const turned = inkIn(18, 380, 34, 520);
        ok("slides: the turned text is in the picture", turned > 0.01, (turned * 100).toFixed(2) + "%");
      }
    }
    // a scan to slides: text boxes from OCR on a wiped picture
    const sc = await toScan(S.bytes, 200), r2 = await convert("pdfppt", sc);
    if (ok("slides from a scan: deck made", r2.blob, r2.err)) {
      if (keep) files.scanSlides = r2.blob;
      const D = await readPptx(r2.blob), txt = D.slides[0].boxes.map((b) => b.text).join(" ");
      const words = S.lines.flatMap((l) => l.t.split(" ")), found = words.filter((w) => txt.includes(w));
      ok("slides from a scan: words read into text boxes", found.length / words.length >= 0.9, `${found.length}/${words.length}: ${txt.slice(0, 160)}`);
      ok("slides from a scan: the page picture is there", D.slides[0].pics.length === 1, D.slides[0].pics.length);
    }
  }
  // 5. a long document: about 60 pages of tables to Excel, 30 pages to slides, timed
  if (long) {
    const D = await makeTablesDoc(seed + 1, 200), t = performance.now(), R = await xl("long document (" + D.pages.length + " pages)", D.bytes, D.pages);
    if (R) { tally.push(["long", R.stats]); ok(`long document: ${D.pages.length} pages to Excel, cells right`, R.stats.right / R.stats.cells >= 0.995, `${R.stats.right}/${R.stats.cells} in ${Math.round(performance.now() - t)} ms, ${Math.round(R.size / 1024)} KB`); }
    const L = await pdfLib(), doc = await L.PDFDocument.load(D.bytes), keepN = Math.min(30, doc.getPageCount()); while (doc.getPageCount() > keepN) doc.removePage(doc.getPageCount() - 1);
    const t2 = performance.now(), r = await convert("pdfppt", new Uint8Array(await doc.save()));
    if (ok(`long document: ${keepN} pages to slides`, r.blob, r.err)) { const P = await readPptx(r.blob); ok(`long document: ${keepN} slides, all with their text`, P.slides.length === keepN && P.slides.every((x) => x.boxes.length > 10), `${P.slides.length} slides in ${Math.round(performance.now() - t2)} ms, ${Math.round(r.blob.size / 1024)} KB`); }
  }
  const pass = out.filter((o) => o.pass).length;
  const cellSum = tally.reduce((a, [, s]) => ({ cells: a.cells + s.cells, right: a.right + s.right }), { cells: 0, right: 0 });
  return { summary: `${pass}/${out.length} checks passed; Excel cells ${cellSum.right}/${cellSum.cells} right; seed ${seed}`, fails: out.filter((o) => !o.pass), out, files };
}
export { makeStatement, makeInvoice, makeTablesDoc, makeSlidePage, toScan, turnPages, readXlsx, readPptx };

// PDFs printed by real Excel (made by a script with sample data: web/_t/xl/<name>.pdf and the values it wrote,
// <name>.json): converted back, every cell compared with what Excel had. Header rows Excel repeats on each printed
// page are skipped.
export async function runExcelMade(names = ["ledger-borders", "ledger-plain", "ledger-grid", "ledger-small"]) {
  const out = [], files = {};
  for (const n of names) {
    const pdf = new Uint8Array(await (await fetch(`/_t/xl/${n}.pdf`)).arrayBuffer()), truth = JSON.parse((await (await fetch(`/_t/xl/${n}.json`)).text()).replace(/^﻿/, "")).map((r) => (Array.isArray(r) ? r : r.value));   // PowerShell 5 writes inner arrays as { value, Count }
    const r = await convert("pdfexcel", pdf, () => set("pe_of_layout", "one"));
    if (!r.blob) { out.push({ name: n, pass: false, info: r.err }); continue; }
    files[n] = r.blob;
    const sheet = (await readXlsx(r.blob))[0], head = truth[0].map((c) => c.v).join("|");
    const rows = sheet.rows.filter((rw) => rw.length).filter((rw, i) => i === 0 || rw.map((c) => c.v).join("|") !== head);
    const exp = truth.map((row, i) => row.map((c, k) => ({ c: k, v: c.t === "n" ? +c.v : String(c.v), bold: i === 0 ? true : undefined,
      fmt: c.f === "date" ? /m.*d.*y/ : c.f === "usd" ? /\$/ : c.f === "pct" ? /%/ : c.f === "paren" ? (+c.v < 0 ? /\(/ : /#,##0\.00/) : undefined })));
    const stats = { cells: 0, right: 0, extra: 0, rowsExtra: 0, bad: [] };
    compareRows(exp, rows.map((rw) => rw), n, null, stats);
    out.push({ name: n, pass: stats.right === stats.cells && !stats.extra && !stats.rowsExtra, info: `${stats.right}/${stats.cells} cells right, ${stats.extra} extra cells, ${stats.rowsExtra} extra rows, ${r.ms} ms; ${stats.bad.slice(0, 4).join(" || ")}` });
  }
  return { summary: `${out.filter((o) => o.pass).length}/${out.length} Excel-made PDFs exact`, out, files };
}

// the editor's Download menu: Excel and PowerPoint from the open document (with an edit on it), and the Tools menu entries
export async function runEditor() {
  const out = [], ok = (name, cond, info = "") => out.push({ name, pass: !!cond, info: String(info).slice(0, 300) });
  const st = await makeStatement();
  await window.__cal2OpenDocBytes(st.bytes, "statement.pdf", "pdf"); location.hash = "#/edit"; await until(() => document.querySelectorAll("#ed_pages .pg .pgov").length >= 2, 15000); await sleep(400);
  for (const f of ["xlsx", "pptx"]) {
    const sel = $("#dl_format"); sel.value = f; sel.dispatchEvent(new Event("change", { bubbles: true })); await sleep(50);
    window.__cal2Capture = []; $("#dl_go").click();
    const c = await until(() => window.__cal2Capture.length && window.__cal2Capture[0], 120000);
    if (!ok(`editor Download ${f}: file made`, c && c.blob.size > 1000, c ? c.name + " " + c.blob.size : "none")) continue;
    if (f === "xlsx") { const sh = await readXlsx(c.blob); const cells = sh.flatMap((s) => s.rows.flat()); ok("editor Download xlsx: tables read", sh.length === 2 && cells.some((x) => x.v === "0000-123456") && cells.filter((x) => x.isNum).length > 100, `${sh.length} sheets, ${cells.filter((x) => x.isNum).length} numbers`); }
    else { const P = await readPptx(c.blob); ok("editor Download pptx: one slide per page with text", P.slides.length === 2 && P.slides[0].boxes.some((b) => b.text === "FIRST SAMPLE BANK"), P.slides.length + " slides"); }
  }
  for (const t of ["pdf2excel", "pdf2ppt"]) { location.hash = "#/tool/" + t; await sleep(800); ok(`Tools menu: ${t} page opens`, /PDF to (Excel|PowerPoint)/.test(document.body.innerText), (document.querySelector("h1") || {}).textContent); }
  return { summary: `${out.filter((o) => o.pass).length}/${out.length} passed`, out };
}
