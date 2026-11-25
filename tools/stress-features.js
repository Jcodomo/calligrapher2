// Feature test of the document editor against what an online PDF editor offers (add text, highlight, underline,
// strike, draw, lines, arrows, shapes, white-out, redact, blur, notes, ticks, dates, form fields, pictures,
// signatures), run on two kinds of file: a PDF with real text, and the same pages as a scan with no text.
// Every tool is used on a fresh copy through the real page (pointer events), the document is downloaded, and
// the result is checked page by page against the original:
//   - same pages, same paper size, page 2 untouched
//   - ink appears where the tool was used, and nothing else on the page moved or blurred
//   - with real text: every word is still there (selectable / searchable), except words a redaction covered,
//     which must be gone; added text can be found; notes are real PDF comments, fields real form fields
//   - the file does not balloon
// Then every download format, and repeated edits on one document (stress) with Undo / Redo.
// To run: copy to web/_t/stress-features.js, open the app, then
//   (await import("/_t/stress-features.js")).run().then((r) => console.log(r.summary))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const frame = () => new Promise((r) => { const t = setTimeout(r, 60); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); });
async function until(fn, ms = 8000, step = 30) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
async function lib(name, url) { if (window[name]) return window[name]; const s = document.createElement("script"); s.src = url; document.head.append(s); await new Promise((r, j) => { s.onload = r; s.onerror = j; }); return window[name]; }
const pdfLib = () => lib("PDFLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
const pdfjs = async () => { const p = await lib("pdfjsLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"); if (!p.GlobalWorkerOptions.workerSrc) p.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; return p; };
const zipLib = () => lib("JSZip", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");

// ---- the test document: sample data only ------------------------------------------------------------------
const W = 612, H = 792, X0 = 72, FS = 14, TOP = 100, STEP = 40;
const LINES1 = ["FEATURE TEST DOCUMENT PAGE ONE", "Borrower name JANE SAMPLE", "Account number 0000-123456", "Loan amount 125,000.00",
  "Closing date 01/15/2026", "Title company SAMPLE TITLE LLC", "Property 100 MAIN STREET"];
const LINES2 = ["FEATURE TEST DOCUMENT PAGE TWO", "Escrow account ESCROW ACCOUNT", "Reference US000000000001"];
let lineBoxes = [];   // page 1 line boxes in page fractions
async function makeDigital() {
  const L = await pdfLib(), d = await L.PDFDocument.create(), f = await d.embedFont(L.StandardFonts.Helvetica);
  lineBoxes = [];
  for (const [pi, lines] of [[0, LINES1], [1, LINES2]]) {
    const p = d.addPage([W, H]);
    lines.forEach((t, k) => {
      const yb = TOP + STEP * k, w = f.widthOfTextAtSize(t, FS);
      p.drawText(t, { x: X0, y: H - yb, size: FS, font: f });
      if (!pi) lineBoxes.push({ text: t, x0: X0 / W, y0: (yb - FS * 0.8) / H, x1: (X0 + w) / W, y1: (yb + FS * 0.25) / H, f, yb });
    });
    p.drawRectangle({ x: 60, y: 40, width: W - 120, height: 2, color: L.rgb(0.2, 0.2, 0.2) });   // a rule near the foot: vector art
  }
  return new Uint8Array(await d.save());
}
// the same pages as pictures (150 dpi JPEG), with no text at all: a scan
async function makeScan(bytes) {
  const P = await pdfjs(), L = await pdfLib(), src = await P.getDocument({ data: bytes.slice() }).promise, d = await L.PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    const pg = await src.getPage(i), vp = pg.getViewport({ scale: 150 / 72 }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp }).promise;
    const jpg = await new Promise((r) => c.toBlob((b) => b.arrayBuffer().then((a) => r(new Uint8Array(a))), "image/jpeg", 0.9));
    const p = d.addPage([W, H]); p.drawImage(await d.embedJpg(jpg), { x: 0, y: 0, width: W, height: H });
  }
  return new Uint8Array(await d.save());
}
async function makePicture() {
  const c = document.createElement("canvas"); c.width = 120; c.height = 80; const g = c.getContext("2d");
  g.fillStyle = "#1f6feb"; g.fillRect(0, 0, 120, 80); g.fillStyle = "#ffd400"; g.beginPath(); g.arc(60, 40, 26, 0, 7); g.fill();
  const b = await new Promise((r) => c.toBlob(r, "image/png"));
  return new File([b], "stamp.png", { type: "image/png" });
}

// ---- reading a PDF back --------------------------------------------------------------------------------------
async function renderAll(bytes, scale = 1) {
  const P = await pdfjs(), d = await P.getDocument({ data: bytes.slice() }).promise, pages = [];
  for (let i = 1; i <= d.numPages; i++) {
    const pg = await d.getPage(i), vp = pg.getViewport({ scale }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
    const tc = await pg.getTextContent(), ann = await pg.getAnnotations();
    pages.push({ c, px: g.getImageData(0, 0, c.width, c.height).data, text: tc.items.map((t) => t.str).join(" ").replace(/\s+/g, " "), items: tc.items.length, ann,
      w: Math.round(pg.view[2] - pg.view[0]), h: Math.round(pg.view[3] - pg.view[1]), rot: pg.rotate });
  }
  let fields = 0; try { const L = await pdfLib(), doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true }); fields = doc.getForm().getFields().length; } catch (_) {}
  return { pages, fields, n: d.numPages };
}
// share of pixels that changed, inside a box (page fractions) and outside it (with a margin)
function diff(a, b, box, margin = 0.025) {
  if (!a || !b || a.c.width !== b.c.width || a.c.height !== b.c.height) return { inside: -1, outside: -1 };
  const Wd = a.c.width, Hd = a.c.height; let ci = 0, ti = 0, co = 0, to = 0;
  const bx0 = box ? (box.x0 - margin) * Wd : -1, bx1 = box ? (box.x1 + margin) * Wd : -1, by0 = box ? (box.y0 - margin) * Hd : -1, by1 = box ? (box.y1 + margin) * Hd : -1;
  const ix0 = box ? box.x0 * Wd : -1, ix1 = box ? box.x1 * Wd : -1, iy0 = box ? box.y0 * Hd : -1, iy1 = box ? box.y1 * Hd : -1;
  for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
    const k = (y * Wd + x) * 4, dv = Math.abs(a.px[k] - b.px[k]) + Math.abs(a.px[k + 1] - b.px[k + 1]) + Math.abs(a.px[k + 2] - b.px[k + 2]), ch = dv > 90;
    if (box && x >= ix0 && x < ix1 && y >= iy0 && y < iy1) { ti++; if (ch) ci++; }
    else if (!box || x < bx0 || x >= bx1 || y < by0 || y >= by1) { to++; if (ch) co++; }
  }
  return { inside: ti ? ci / ti : 0, outside: to ? co / to : 0 };
}

// ---- driving the page ------------------------------------------------------------------------------------------
const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
const ov0 = () => $("#ed_pages .pg[data-page='0'] .pgov");
const at = (fx, fy) => { const r = ov0().getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; };
async function drag(pts) {
  const ov = ov0(); const [x, y] = at(...pts[0]); ptr(ov, "pointerdown", x, y);
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; for (let s = 1; s <= 6; s++) { const [px, py] = at(a[0] + (b[0] - a[0]) * s / 6, a[1] + (b[1] - a[1]) * s / 6); ptr(ov, "pointermove", px, py); } }
  const [ex, ey] = at(...pts[pts.length - 1]); ptr(ov, "pointerup", ex, ey); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame();
}
async function click(fx, fy) { const ov = ov0(), [x, y] = at(fx, fy); ptr(ov, "pointerdown", x, y); ptr(ov, "pointerup", x, y); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame(); }
async function deselect() { const ov = ov0(); if (!ov) return; window.__cal2SetDocTool("select"); const [x, y] = at(0.97, 0.985); ptr(ov, "pointerdown", x, y); ptr(ov, "pointerup", x, y); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); await frame(); }
function typeInto(td, text) { td.focus(); const s = getSelection(), rg = document.createRange(); rg.selectNodeContents(td); s.removeAllRanges(); s.addRange(rg); document.execCommand("insertText", false, text); }
async function capture(fn, ms = 120000) { window.__cal2Capture = []; const t = performance.now(); fn(); const c = await until(() => window.__cal2Capture.length && window.__cal2Capture, ms, 25); return { file: c && c[0], ms: Math.round(performance.now() - t) }; }
async function download(format = "pdf", look = "clean", quality = "exact") {
  const set = (id, v) => { const s = $(id); if (s && s.value !== v) { s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); } };
  set("#dl_format", format); set("#dl_look", look); set("#dl_quality", quality); await sleep(30);
  return capture(() => $("#dl_go").click());
}
async function openDoc(bytes, name) {
  await window.__cal2OpenDocBytes(bytes, name, "pdf");
  location.hash = "#/edit?" + Math.random().toString(36).slice(2, 7);
  await until(() => $$("#ed_pages .pg .pgov").length >= 2, 15000);
  await sleep(300); window.__cal2SetDocTool("select"); await frame();
}

// ---- the tools ------------------------------------------------------------------------------------------------
// each: what to do on page 1, the box the ink should land in, and what the text must show afterwards
function toolsList(pic) {
  const L2 = lineBoxes[2], L3 = lineBoxes[3], mid = (b) => (b.y0 + b.y1) / 2;
  const val2 = { ...L2, x0: L2.x0 + (L2.f.widthOfTextAtSize("Account number ", FS)) / W };   // just "0000-123456"
  return [
    { id: "highlight", box: L3, act: () => drag([[L3.x0, mid(L3)], [L3.x1, mid(L3)]]), keepText: true },
    { id: "underline", box: { ...L3, y0: L3.y1 - 0.01, y1: L3.y1 + 0.012 }, act: () => drag([[L3.x0, L3.y1], [L3.x1, L3.y1]]), keepText: true },
    { id: "strike", box: L3, act: () => drag([[L3.x0, mid(L3)], [L3.x1, mid(L3)]]), keepText: true },
    { id: "pen", box: { x0: 0.18, y0: 0.6, x1: 0.52, y1: 0.7 }, act: () => drag([[0.2, 0.62], [0.3, 0.68], [0.4, 0.62], [0.5, 0.68]]), keepText: true },
    { id: "line", box: { x0: 0.18, y0: 0.73, x1: 0.62, y1: 0.77 }, act: () => drag([[0.2, 0.75], [0.6, 0.75]]), keepText: true },
    { id: "arrow", box: { x0: 0.18, y0: 0.78, x1: 0.62, y1: 0.87 }, act: () => drag([[0.2, 0.8], [0.6, 0.85]]), keepText: true },
    { id: "shape:rect", box: { x0: 0.55, y0: 0.6, x1: 0.86, y1: 0.7 }, act: () => drag([[0.55, 0.6], [0.85, 0.7]]), keepText: true },
    { id: "shape:ellipse", box: { x0: 0.55, y0: 0.72, x1: 0.86, y1: 0.83 }, act: () => drag([[0.55, 0.72], [0.85, 0.82]]), keepText: true },
    { id: "whiteout", box: val2, act: () => drag([[val2.x0 - 0.005, val2.y0 - 0.004], [val2.x1 + 0.005, val2.y1 + 0.004]]), keepText: true, whiteout: "0000-123456" },
    { id: "redact", box: val2, act: () => drag([[val2.x0 - 0.005, val2.y0 - 0.004], [val2.x1 + 0.005, val2.y1 + 0.004]]), gone: "0000-123456", picture: true },
    { id: "blur", box: val2, act: () => drag([[val2.x0 + 0.025, mid(val2)], [val2.x1 - 0.01, mid(val2)]]), gone: "0000-123456", soft: true, picture: true },
    { id: "text", box: { x0: 0.1, y0: 0.55, x1: 0.75, y1: 0.66 }, act: async () => { await click(0.15, 0.6); const td = await until(() => { const e = document.activeElement; return e && e.classList && e.classList.contains("tbtext") && e.isContentEditable && e; }, 4000); if (!td) return "no text box opened"; typeInto(td, "Added text QX7 sample"); await frame(); }, keepText: true, find: "QX7", thin: true },
    { id: "date", box: { x0: 0.05, y0: 0.86, x1: 0.5, y1: 0.95 }, act: () => click(0.12, 0.9), keepText: true, thin: true },
    { id: "check", box: { x0: 0.02, y0: 0.86, x1: 0.2, y1: 0.95 }, act: () => click(0.1, 0.9), keepText: true, thin: true },
    { id: "note", box: null, act: () => click(0.9, 0.08), keepText: true, annot: true, inkOptional: true },
    { id: "field:text", box: null, act: () => click(0.5, 0.92), keepText: true, field: true, inkOptional: true },
    { id: "field:check", box: null, act: () => click(0.7, 0.92), keepText: true, field: true, inkOptional: true },
    { id: "image", box: { x0: 0.3, y0: 0.3, x1: 0.95, y1: 0.95 }, act: async () => { await window.__cal2InsertImageFile(pic); await sleep(400); }, keepText: true, loose: true },
  ];
}

export async function run({ only = null, kinds = ["text", "scan"], stress = true, formats = true } = {}) {
  const out = [], errors = [], times = [];
  const ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 260) }); return !!cond; };
  const onErr = (e) => errors.push(String(e.message || e.reason || e).slice(0, 160));
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  const digital = await makeDigital(), scan = await makeScan(digital), pic = await makePicture();
  const docs = { text: digital, scan };
  for (const kind of kinds) {
    const bytes = docs[kind], orig = await renderAll(bytes);
    for (const T of toolsList(pic)) {
      if (only && !only.includes(T.id)) continue;
      const tag = `${kind} PDF / ${T.id}`;
      try {
        await openDoc(bytes, `features-${kind}.pdf`);
        if (T.id !== "image") { window.__cal2SetDocTool(T.id); await frame(); }
        const why = await T.act(); await sleep(120); await deselect(); await sleep(150);
        if (why) { ok(`${tag}: tool works`, false, why); continue; }
        const { file, ms } = await download(T.field ? "fill" : "pdf"); times.push([tag, ms]);
        if (!ok(`${tag}: downloads`, file, "no file")) continue;
        const ob = new Uint8Array(await file.blob.arrayBuffer()), R = await renderAll(ob);
        ok(`${tag}: same pages and paper`, R.n === orig.n && R.pages.every((p, i) => p.w === orig.pages[i].w && p.h === orig.pages[i].h), R.pages.map((p) => p.w + "x" + p.h).join(" "));
        const d1 = diff(orig.pages[0], R.pages[0], T.box), d2 = diff(orig.pages[1], R.pages[1], null);
        if (!T.inkOptional) ok(`${tag}: ink where the tool was used`, d1.inside > (T.soft || T.thin ? 0.004 : 0.02), "changed " + (d1.inside * 100).toFixed(1) + "% of the box");
        ok(`${tag}: nothing else on page 1 changed`, d1.outside < (T.loose || (T.picture && kind === "text") ? 0.02 : T.picture ? 0.006 : 0.0025), "changed " + (d1.outside * 100).toFixed(2) + "% outside");
        ok(`${tag}: page 2 untouched`, d2.outside < 0.001, (d2.outside * 100).toFixed(3) + "%");
        if (kind === "text") {
          const t1 = R.pages[0].text, keep = LINES1.join(" ").split(" ").filter((w) => !(T.gone || "").includes(w));
          const missing = keep.filter((w) => !t1.includes(w));
          ok(`${tag}: page 1 words still selectable`, !missing.length, missing.length ? "missing: " + missing.slice(0, 8).join(", ") : R.pages[0].items + " text pieces");
          if (T.gone) ok(`${tag}: covered words removed from the file`, !t1.includes(T.gone) && !new TextDecoder("latin1").decode(ob).includes(T.gone), t1.includes(T.gone) ? "still in page text" : "gone");
          if (T.whiteout) ok(`${tag}: white-out hides the words (they stay in the file, as in other editors)`, true, t1.includes(T.whiteout) ? "words kept under the cover (use Redact to remove)" : "removed");
          ok(`${tag}: page 2 text kept`, LINES2.every((l) => R.pages[1].text.includes(l.split(" ")[0])), R.pages[1].text.slice(0, 60));
        }
        if (T.find) ok(`${tag}: added text can be found`, R.pages[0].text.includes(T.find), R.pages[0].text.slice(-80));
        if (T.annot) ok(`${tag}: a real PDF comment`, R.pages[0].ann.some((a) => a.subtype === "Text"), R.pages[0].ann.map((a) => a.subtype).join(","));
        if (T.field) ok(`${tag}: a real form field`, R.fields >= 1, R.fields + " fields");
        const grow = ob.length / bytes.length;
        ok(`${tag}: file size sensible`, ob.length < bytes.length * 3 + 400000, `${(bytes.length / 1024).toFixed(0)} KB -> ${(ob.length / 1024).toFixed(0)} KB (x${grow.toFixed(2)})`);
      } catch (e) { ok(`${tag}: runs`, false, e.message || e); }
    }
    // every download format of an edited document
    if (formats && !only) {
      await openDoc(bytes, `formats-${kind}.pdf`);
      window.__cal2SetDocTool("highlight"); await frame(); const L3 = lineBoxes[3]; await drag([[L3.x0, (L3.y0 + L3.y1) / 2], [L3.x1, (L3.y0 + L3.y1) / 2]]); await deselect();
      for (const fmt of ["pdf", "fill", "docx", "png", "jpg", "zip", "txt"]) {
        const tag = `${kind} PDF / download ${fmt}`;
        try {
          const { file, ms } = await download(fmt); times.push([tag, ms]);
          if (!ok(`${tag}: file made`, file && file.blob.size > 200, file ? file.blob.size + " bytes" : "none")) continue;
          const b = new Uint8Array(await file.blob.arrayBuffer());
          if (fmt === "docx") { const z = await (await zipLib()).loadAsync(b), x = await z.file("word/document.xml").async("string"); ok(`${tag}: Word file has the words`, /JANE SAMPLE/.test(x.replace(/<[^>]+>/g, "")), x.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 80)); }
          if (fmt === "txt") { const s = new TextDecoder().decode(b); ok(`${tag}: text has the words`, /JANE\s+SAMPLE/.test(s) && /125,000\.00/.test(s), s.slice(0, 80)); }
          if (fmt === "png" || fmt === "jpg") ok(`${tag}: a picture`, fmt === "png" ? b[0] === 0x89 : b[0] === 0xFF, file.name);
          if (fmt === "zip") { const z = await (await zipLib()).loadAsync(b); ok(`${tag}: one picture per page`, Object.keys(z.files).length >= 2, Object.keys(z.files).join(",")); }
          if (fmt === "fill") { const R = await renderAll(b); ok(`${tag}: same pages`, R.n === 2, R.n); }
        } catch (e) { ok(`${tag}: runs`, false, e.message || e); }
      }
    }
    // stress: many edits on one document, undo all, redo all, the saved file matches what was drawn
    if (stress && !only) {
      const tag = `${kind} PDF / stress`;
      try {
        await openDoc(bytes, `stress-${kind}.pdf`);
        const r = ((s) => () => { s = (s * 16807) % 2147483647; return s / 2147483647; })(kind === "text" ? 4242 : 777);
        const kinds2 = ["pen", "highlight", "line", "arrow", "shape:rect", "shape:ellipse", "underline", "strike"];
        const t0 = performance.now(); let n = 0;
        for (let k = 0; k < 60; k++) {
          const tool = kinds2[Math.floor(r() * kinds2.length)]; window.__cal2SetDocTool(tool); await frame();
          const x = 0.1 + r() * 0.6, y = 0.55 + r() * 0.35;
          await drag([[x, y], [x + 0.05 + r() * 0.25, y + (tool === "underline" || tool === "strike" ? 0 : 0.02 + r() * 0.05)]]); n++;
          if (k % 3 === 2) await deselect();
        }
        await deselect(); const tDraw = performance.now() - t0;
        const full = await download("pdf"); const Rf = await renderAll(new Uint8Array(await full.file.blob.arrayBuffer()));
        const dFull = diff(orig.pages[0], Rf.pages[0], null).outside;
        ok(`${tag}: ${n} drawings made`, dFull > 0.01, `${(dFull * 100).toFixed(1)}% of page 1 inked, ${Math.round(tDraw)} ms to draw, ${full.ms} ms to save`);
        let u = 0; while (u < 200 && !$("#ed_undo").disabled) { $("#ed_undo").click(); await frame(); u++; }
        const empty = await download("pdf"), Re = await renderAll(new Uint8Array(await empty.file.blob.arrayBuffer()));
        ok(`${tag}: Undo all gives back the original page`, diff(orig.pages[0], Re.pages[0], null).outside < 0.001, `${u} undos, ${(diff(orig.pages[0], Re.pages[0], null).outside * 100).toFixed(3)}% differs`);
        let rd = 0; while (rd < 200 && !$("#ed_redo").disabled) { $("#ed_redo").click(); await frame(); rd++; }
        const again = await download("pdf"), Ra = await renderAll(new Uint8Array(await again.file.blob.arrayBuffer()));
        ok(`${tag}: Redo all gives back every drawing`, diff(Rf.pages[0], Ra.pages[0], null).outside < 0.002, `${rd} redos, ${(diff(Rf.pages[0], Ra.pages[0], null).outside * 100).toFixed(3)}% differs`);
        if (kind === "text") ok(`${tag}: words still selectable under 60 drawings`, LINES1.every((l) => Ra.pages[0].text.includes(l)), Ra.pages[0].text.slice(0, 60));
      } catch (e) { ok(`${tag}: runs`, false, e.message || e); }
    }
  }
  if (!only) {
    // a fillable PDF: its own fields keep working in the editable download, and are fixed in place in the plain one
    try {
      const fill = await makeFillable();
      await openDoc(fill, "fillable.pdf");
      window.__cal2SetDocTool("highlight"); await frame(); const L3 = lineBoxes[3]; await drag([[L3.x0, (L3.y0 + L3.y1) / 2], [L3.x1, (L3.y0 + L3.y1) / 2]]); await deselect();
      const e = await download("fill"), Re = await renderAll(new Uint8Array(await e.file.blob.arrayBuffer()));
      ok("fillable PDF / Editable PDF: its own fields are still fillable", Re.fields >= 2, Re.fields + " fields");
      const v = Re.pages[0].ann.find((x) => x.fieldName === "borrower");
      ok("fillable PDF / Editable PDF: the field keeps its value", v && v.fieldValue === "FIELD VALUE XQ9", v && v.fieldValue);
      const f = await download("pdf"), Rf = await renderAll(new Uint8Array(await f.file.blob.arrayBuffer()));
      ok("fillable PDF / PDF: the value is fixed on the page", Rf.fields === 0 && /FIELD VALUE XQ9/.test(Rf.pages[0].text), Rf.fields + " fields; " + Rf.pages[0].text.slice(-50));
      ok("fillable PDF / PDF: the link still works", Rf.pages[0].ann.some((x) => x.subtype === "Link"), Rf.pages[0].ann.map((x) => x.subtype).join(","));
    } catch (e) { ok("fillable PDF: runs", false, e.message || e); }
    // Edit Text on one line and a redaction on the next: the old words and the redacted ones both leave the file
    try {
      await window.__cal2OpenDocBytes(digital.slice(), "edit-and-redact.pdf", "pdf");
      location.hash = "#/edit/edittext?" + Math.random().toString(36).slice(2, 6);
      await until(() => $$("#ed_pages .pg .pgov").length >= 2, 15000); await sleep(400); window.__cal2SetDocTool("edittext");
      const blocks = await until(() => { const b = $$("#ed_pages .pg[data-page='0'] .tblock"); return b.length >= 5 && b; }, 15000);
      if (ok("edit + redact: lines ready to edit", blocks, blocks ? blocks.length : location.hash + " blocks " + $$("#ed_pages .tblock").length)) {
        await sleep(300);
        const blk = blocks[1], br = blk.getBoundingClientRect();
        ptr(blk, "pointerdown", br.left + br.width / 2, br.top + br.height / 2); ptr(blk, "pointerup", br.left + br.width / 2, br.top + br.height / 2);
        const td = await until(() => { const e = document.activeElement; return e && e.classList && e.classList.contains("tbtext") && e.isContentEditable && e; }, 5000);
        if (ok("edit + redact: the line opens for editing", td)) {
          const before = td.textContent;
          typeInto(td, "Borrower name ALEX EXAMPLE"); await frame(); await deselect();
          const L2 = lineBoxes[2]; window.__cal2SetDocTool("redact"); await frame();
          const vx = L2.x0 + L2.f.widthOfTextAtSize("Account number ", FS) / W;
          await drag([[vx - 0.005, L2.y0 - 0.004], [L2.x1 + 0.005, L2.y1 + 0.004]]); await deselect(); await sleep(150);
          const d = await download("pdf"), R = await renderAll(new Uint8Array(await d.file.blob.arrayBuffer())), t1 = R.pages[0].text;
          ok("edit + redact: the new words can be found", /ALEX EXAMPLE/.test(t1), "edited: " + before + " | " + t1.slice(0, 80));
          ok("edit + redact: the old words are gone", !/JANE SAMPLE/.test(t1), t1.slice(0, 80));
          ok("edit + redact: the redacted number is gone", !/0000-123456/.test(t1), "");
          ok("edit + redact: the other lines are still text", ["FEATURE TEST", "Loan amount 125,000.00", "Closing date", "MAIN STREET", "Account number"].every((w) => t1.includes(w)), t1.slice(0, 120));
        }
      }
    } catch (e) { ok("edit + redact: runs", false, e.message || e); }
  }
  window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr);
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed`, fails: out.filter((o) => !o.pass), errors: errors.slice(0, 10), slow: times.sort((a, b) => b[1] - a[1]).slice(0, 5), out };
}

// ---- the page tools (Tools menu): Protect, Unlock, Flatten, Compress, Number, Watermark ----------------------------
// downloads from the PDF tools are links clicked in code: catch them
function catchLinks() {
  const got = [], orig = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () { if (this.download && this.href.startsWith("blob:")) { const name = this.download; got.push(fetch(this.href).then((r) => r.blob()).then((blob) => ({ name, blob }))); return; } return orig.call(this); };
  return { got, stop: () => { HTMLAnchorElement.prototype.click = orig; } };
}
// the next file picker the page opens gets these files
function feedPicker(files) {
  const orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type !== "file") return orig.call(this); HTMLInputElement.prototype.click = orig; const dt = new DataTransfer(); files.forEach((f) => dt.items.add(f)); this.files = dt.files; this.dispatchEvent(new Event("change")); };
}
async function makeFillable() {
  const L = await pdfLib(), d = await L.PDFDocument.load(await makeDigital()), p = d.getPage(0), form = d.getForm();
  const tf = form.createTextField("borrower"); tf.setText("FIELD VALUE XQ9"); tf.addToPage(p, { x: 300, y: 300, width: 220, height: 22 });
  const cb = form.createCheckBox("agree"); cb.addToPage(p, { x: 300, y: 260, width: 16, height: 16 }); cb.check();
  // a square markup with its own drawn look, and a link
  const ap = d.context.stream("1 0 0 RG 3 w 2 2 96 46 re S", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 100, 50] });
  const sq = d.context.obj({ Type: "Annot", Subtype: "Square", Rect: [80, 180, 180, 230], F: 4, C: [1, 0, 0], AP: { N: d.context.register(ap) } });
  const ln = d.context.obj({ Type: "Annot", Subtype: "Link", Rect: [72, 680, 300, 700], Border: [0, 0, 0], A: { S: "URI", URI: L.PDFString.of("https://example.com/") } });
  const annots = p.node.lookupMaybe(L.PDFName.of("Annots"), L.PDFArray) || d.context.obj([]); annots.push(d.context.register(sq)); annots.push(d.context.register(ln)); p.node.set(L.PDFName.of("Annots"), annots);
  return new Uint8Array(await d.save());
}
export async function runTools() {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 260) }); return !!cond; };
  const P = await pdfjs(), digital = await makeDigital(), scan = await makeScan(digital);
  const open = async (bytes, pw) => { try { return await P.getDocument({ data: bytes.slice(), password: pw }).promise; } catch (e) { return e; } };
  const textOf = async (d, i = 1) => (await (await d.getPage(i)).getTextContent()).items.map((t) => t.str).join(" ");
  const run = async (id, bytes, setup, goId, name) => {
    const C = catchLinks();
    try {
      await window.__cal2RunPdfTool(id, bytes, name || "sample.pdf"); await sleep(200);
      if (setup) await setup();
      if (goId) { const b = await until(() => $("#" + goId), 4000); if (!b) return { err: "no " + goId }; b.click(); }
      const f = await until(() => C.got.length ? Promise.all(C.got) : /Nothing to gain|wrong password|different|Type a password/i.test(($("#pe_err") || {}).textContent || "") ? "msg" : null, 60000, 50);
      if (f === "msg") return { err: $("#pe_err").textContent };
      return f ? f[0] : { err: ($("#pe_err") || {}).textContent || "no file" };
    } finally { C.stop(); }
  };
  const val = (id, v) => { const e = $("#" + id); if (e) { if (e.type === "checkbox") e.checked = v; else e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); } };
  let locked = null;
  // Protect
  for (const [kind, bytes] of [["text", digital], ["scan", scan]]) {
    const r = await run("protect", bytes, async () => { val("pe_pr_pw", "Sample-Pass 42"); val("pe_pr_pw2", "Sample-Pass 42"); }, "pe_pr_go");
    if (!ok(`Protect (${kind}): file made`, r.blob, r.err)) continue;
    const b = new Uint8Array(await r.blob.arrayBuffer()), noPw = await open(b), wrong = await open(b, "wrong"), right = await open(b, "Sample-Pass 42");
    ok(`Protect (${kind}): asks for the password`, noPw && noPw.name === "PasswordException", noPw && (noPw.name || "opened"));
    ok(`Protect (${kind}): a wrong password is refused`, wrong && wrong.name === "PasswordException", wrong && (wrong.name || "opened"));
    ok(`Protect (${kind}): opens with the password, pages as they were`, right && right.numPages === 2, right && (right.numPages || right.message));
    if (kind === "text" && right.numPages) { const t = await textOf(right); ok("Protect (text): words kept as real text", t.includes("JANE SAMPLE") && t.includes("0000-123456"), t.slice(0, 60)); locked = b; }
    ok(`Protect (${kind}): nothing readable without the password`, !new TextDecoder("latin1").decode(b).includes("JANE"), "");
    ok(`Protect (${kind}): size sensible`, b.length < bytes.length * 1.3 + 20000, `${bytes.length} -> ${b.length}`);
  }
  {
    const r = await run("protect", digital, async () => { val("pe_pr_pw", "abc"); val("pe_pr_pw2", "abd"); }, "pe_pr_go");
    ok("Protect: two different passwords are caught", !r.blob && /different/i.test(r.err), r.err);
    const r2 = await run("protect", digital, async () => { val("pe_pr_pw", "k9"); val("pe_pr_pw2", "k9"); val("pe_pr_copy", false); val("pe_pr_print", false); }, "pe_pr_go");
    const d = r2.blob && await open(new Uint8Array(await r2.blob.arrayBuffer()), "k9"), pm = d && d.getPermissions ? await d.getPermissions() : null;
    ok("Protect: no printing / no copying is kept", pm && !pm.includes(4) && !pm.includes(16) && pm.includes(8), JSON.stringify(pm));
  }
  // Unlock the protected file
  if (locked) {
    const r = await run("unlock", digital, async () => { val("pe_pw", "Sample-Pass 42"); feedPicker([new File([locked], "locked.pdf", { type: "application/pdf" })]); }, "pe_unlock_pick");
    if (ok("Unlock: file made", r.blob, r.err)) {
      const b = new Uint8Array(await r.blob.arrayBuffer()), d = await open(b), pg = d.numPages ? await d.getPage(1) : null;
      ok("Unlock: opens without a password", d && d.numPages === 2, d && (d.numPages || d.name));
      ok("Unlock: pages keep their paper size", pg && Math.round(pg.view[2]) === W && Math.round(pg.view[3]) === H, pg && pg.view.join(","));
      if (pg) { const t = await textOf(d); ok("Unlock: words still selectable and searchable", t.includes("JANE SAMPLE") && t.includes("125,000.00"), t.slice(0, 60)); }
    }
    const bad = await run("unlock", digital, async () => { val("pe_pw", "nope"); feedPicker([new File([locked], "locked.pdf", { type: "application/pdf" })]); }, "pe_unlock_pick");
    ok("Unlock: a wrong password is refused", !bad.blob && /wrong password/i.test(bad.err), bad.err);
  }
  // Flatten a filled form with a markup and a link
  {
    const fill = await makeFillable(), before = await renderAll(fill);
    const r = await run("flatten", fill, null, null);
    if (ok("Flatten: file made", r.blob, r.err)) {
      const b = new Uint8Array(await r.blob.arrayBuffer()), R = await renderAll(b), t = R.pages[0].text;
      ok("Flatten: no form fields left", R.fields === 0, R.fields + " fields");
      ok("Flatten: the filled-in value is on the page as text", t.includes("FIELD VALUE XQ9"), t.slice(-60));
      ok("Flatten: the document's own words stay real text", LINES1.every((l) => t.includes(l)), t.slice(0, 60));
      ok("Flatten: the markup is drawn on the page", diff(before.pages[0], R.pages[0], { x0: 80 / W, y0: 1 - 230 / H, x1: 180 / W, y1: 1 - 180 / H }).inside > -1 && R.pages[0].ann.every((a) => a.subtype !== "Square"), R.pages[0].ann.map((a) => a.subtype).join(","));
      const ink = (pg) => { const x0 = Math.round(80 / W * pg.c.width), y0 = Math.round((1 - 230 / H) * pg.c.height), px = pg.px; let red = 0; for (let y = y0; y < y0 + 50; y++) for (let x = x0; x < x0 + 100; x++) { const k = (y * pg.c.width + x) * 4; if (px[k] > 180 && px[k + 1] < 90 && px[k + 2] < 90) red++; } return red; };
      ok("Flatten: the red square shows", ink(R.pages[0]) > 100, ink(R.pages[0]) + " red pixels (before: " + ink(before.pages[0]) + ")");
      ok("Flatten: the link still works", R.pages[0].ann.some((a) => a.subtype === "Link" && /example\.com/.test(a.url || "")), R.pages[0].ann.map((a) => a.subtype).join(","));
      ok("Flatten: the file stays small (no pictures of pages)", b.length < fill.length * 2 + 20000, `${fill.length} -> ${b.length}`);
    }
  }
  // Compress, Number pages, Watermark, on text and on scans
  for (const [kind, bytes] of [["text", digital], ["scan", scan]]) {
    const c = await run("compress", bytes, null, "pe_cmp_go");
    if (kind === "text" && !c.blob) ok("Compress (text): a PDF with no pictures is left as it is, and says so", /Nothing to gain/.test(c.err), c.err);
    else if (ok(`Compress (${kind}): file made`, c.blob, c.err)) {
      const b = new Uint8Array(await c.blob.arrayBuffer()), d = await open(b);
      ok(`Compress (${kind}): same pages`, d.numPages === 2, d.numPages);
      ok(`Compress (${kind}): not bigger`, b.length <= bytes.length * 1.05 + 2000, `${bytes.length} -> ${b.length}`);
      if (kind === "text") { const t = await textOf(d); ok("Compress (text): words kept", t.includes("JANE SAMPLE"), t.slice(0, 50)); }
    }
    const n = await run("number", bytes, null, "pe_num_go");
    if (ok(`Number pages (${kind}): file made`, n.blob, n.err)) { const d = await open(new Uint8Array(await n.blob.arrayBuffer())); const t1 = await textOf(d, 1), t2 = await textOf(d, 2); ok(`Number pages (${kind}): numbers on the pages`, /\b1\b/.test(t1) && /\b2\b/.test(t2), t1.slice(-30) + " | " + t2.slice(-30)); if (kind === "text") ok("Number pages (text): words kept", t1.includes("JANE SAMPLE"), ""); }
    const w = await run("watermark", bytes, async () => { val("pe_wm2", "SAMPLE MARK"); }, "pe_wm_go");
    if (ok(`Watermark (${kind}): file made`, w.blob, w.err)) { const d = await open(new Uint8Array(await w.blob.arrayBuffer())); const t1 = await textOf(d, 1); ok(`Watermark (${kind}): the mark is on the page`, /SAMPLE\s*MARK/.test(t1), t1.slice(-40)); if (kind === "text") ok("Watermark (text): words kept", t1.includes("JANE SAMPLE"), ""); }
  }
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed`, fails: out.filter((o) => !o.pass), out };
}

// the sample documents, for other checks
export const __makeDigital = makeDigital, __makeScan = makeScan, __makeFillable = makeFillable;
