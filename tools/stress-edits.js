// Editing stress test: several documents in a row, each made from a seed (standard PDF fonts in regular, bold,
// italic and mono, sizes 8-24 pt, 1-3 pages, some landscape). In each one it edits existing lines with Edit Text,
// types new text boxes and switches them through fonts, undoes and redoes, then downloads and checks the result:
// every edit and new box has ink in the right place on the saved page, the replaced words are gone from the page's
// text, and the edited line kept the PDF's font family, weight, baseline and size. It times every step and watches
// memory and errors. runPrints() then downloads one edited document in every look, quality and format.
// To run: copy to web/_t/stress-edits.js, open the app, then
//   (await import("/_t/stress-edits.js")).run({ docs: 4 }).then((r) => console.log(r.summary))
//   (await import("/_t/stress-edits.js")).runPrints().then((r) => console.table(r.rows))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const frame = () => new Promise((r) => { const t = setTimeout(r, 60); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); });   // also when the tab is in the background
async function until(fn, ms = 8000, step = 30) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
async function lib(name, url) { if (window[name]) return window[name]; const s = document.createElement("script"); s.src = url; document.head.append(s); await new Promise((r, j) => { s.onload = r; s.onerror = j; }); return window[name]; }
const pdfLib = () => lib("PDFLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
const pdfjs = async () => { const p = await lib("pdfjsLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"); if (!p.GlobalWorkerOptions.workerSrc) p.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; return p; };

// the standard fonts, what the editor should draw them with, and whether they are bold / italic
const STD = [["Helvetica", /Arimo|Helvetica|Arial/i, 0, 0], ["HelveticaBold", /Arimo|Helvetica|Arial/i, 1, 0], ["HelveticaOblique", /Arimo|Helvetica|Arial/i, 0, 1],
  ["TimesRoman", /Tinos|Times/i, 0, 0], ["TimesRomanBold", /Tinos|Times/i, 1, 0], ["TimesRomanItalic", /Tinos|Times/i, 0, 1], ["Courier", /Cousine|Courier/i, 0, 0], ["CourierBold", /Cousine|Courier/i, 1, 0]];
const WORDS = "loan approval borrower property amount closing escrow appraisal income employment verified condition rate term payment insurance title deposit statement account balance".split(" ");
const NEW_TEXT = ["José Ramírez – $1,287,950.00", "Approved 12/31/2026 at 6.125%", "Ñandú Café & Co. (No. 47)", "UPDATED", "Total due: $3,402.17 per month for 360 months", "Ref #A-77/B", "Smith-Jones, LLC", "ÉCOLE · naïve façade · 100%"];
const BOX_FONTS = ["Roboto", "Lora", "Caveat", "Dancing Script", "Courier Prime", "Great Vibes", "Homemade Apple", "Merriweather", "Open Sans", "Playfair Display"];

async function makeDoc(r, n) {
  const L = await pdfLib(), d = await L.PDFDocument.create(), lines = [];
  const pages = 1 + Math.floor(r() * 3);
  for (let p = 0; p < pages; p++) {
    const land = r() < 0.25, W = land ? 792 : 612, H = land ? 612 : 792, page = d.addPage([W, H]);
    let y = H - 70;
    while (y > 90) {
      const [fname] = STD[Math.floor(r() * STD.length)], size = Math.round(8 + r() * 16), font = await d.embedFont(L.StandardFonts[fname]);
      const words = []; const nw = 2 + Math.floor(r() * 7); for (let k = 0; k < nw; k++) words.push(WORDS[Math.floor(r() * WORDS.length)]);
      if (r() < 0.4) words.push("$" + (1000 + Math.floor(r() * 900000)).toLocaleString("en-US") + ".00");
      const text = (n + 1) + "-" + (p + 1) + " " + words.join(" ");
      if (font.widthOfTextAtSize(text, size) > W - 140) { y -= 4; continue; }
      page.drawText(text, { x: 72, y, size, font }); lines.push({ page: p, text, font: fname, size });
      y -= size * (1.6 + r() * 1.4);
    }
  }
  return { bytes: await d.save(), lines, pages };
}

const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
function typeInto(td, text) { td.focus(); const s = getSelection(), rg = document.createRange(); rg.selectNodeContents(td); s.removeAllRanges(); s.addRange(rg); document.execCommand("insertText", false, text); }
async function commit() { const pg = $("#ed_pages .pg .pgov"); if (!pg) return; const r = pg.getBoundingClientRect(); ptr(pg, "pointerdown", r.right - 6, r.bottom - 6); ptr(pg, "pointerup", r.right - 6, r.bottom - 6); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame(); }
function frac(el) { const pg = el && el.closest(".pg"); if (!pg) return null; const a = el.getBoundingClientRect(), b = pg.getBoundingClientRect(); return { page: +pg.dataset.page, x0: (a.left - b.left) / b.width, y0: (a.top - b.top) / b.height, x1: (a.right - b.left) / b.width, y1: (a.bottom - b.top) / b.height }; }

async function capture(click) { window.__cal2Capture = []; const t = performance.now(); click(); const c = await until(() => window.__cal2Capture.length && window.__cal2Capture, 120000, 25); return { file: c && c[0], ms: Math.round(performance.now() - t) }; }
async function download(format = "pdf", look = "clean", quality = "exact", engine = "fast") {
  const set = (id, v) => { const s = $(id); if (s && s.value !== v) { s.value = v; s.dispatchEvent(new Event("change", { bubbles: true })); } };
  set("#dl_format", format); set("#dl_look", look); set("#dl_quality", quality); set("#dl_engine", engine);
  await sleep(30);
  return capture(() => $("#dl_go").click());
}
// ink (non-white share) of a box on a rendered page, in page fractions
async function renderPage(bytes, i = 0, scale = 1.5) {
  const P = await pdfjs(), d = await P.getDocument({ data: bytes.slice() }).promise, pg = await d.getPage(i + 1), vp = pg.getViewport({ scale });
  const c = document.createElement("canvas"); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const g = c.getContext("2d", { willReadFrequently: true }); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  await pg.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
  const tc = await pg.getTextContent();
  return { c, g, n: d.numPages, text: tc.items.map((t) => t.str).join(" ") };
}
function ink(R, f) {
  const x = Math.max(0, Math.floor(f.x0 * R.c.width)), y = Math.max(0, Math.floor(f.y0 * R.c.height)), w = Math.max(1, Math.ceil((f.x1 - f.x0) * R.c.width)), h = Math.max(1, Math.ceil((f.y1 - f.y0) * R.c.height));
  const px = R.g.getImageData(x, y, Math.min(w, R.c.width - x), Math.min(h, R.c.height - y)).data; let dark = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 600) dark++;
  return dark / (px.length / 4);
}

export async function run({ docs = 4, seed = Math.floor(Math.random() * 1e9), edits = 4, adds = 4 } = {}) {
  const out = [], times = { open: [], editOpen: [], type: [], addBox: [], font: [], undo: [], save: [] }, errors = [];
  const ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 240) }); return !!cond; };
  const onErr = (e) => errors.push(String(e.message || e.reason || e).slice(0, 160));
  window.addEventListener("error", onErr); window.addEventListener("unhandledrejection", onErr);
  const heap = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0), heap0 = heap();
  const r = rng(seed);
  try {
    for (let n = 0; n < docs; n++) {
      const tag = `doc ${n + 1} (seed ${seed})`, D = await makeDoc(r, n);
      let t = performance.now();
      await window.__cal2OpenDocBytes(D.bytes, `edits-${n + 1}.pdf`, "pdf");
      location.hash = "#/edit/edittext" + (n ? "?" + n : "");
      const blocks = await until(() => { const b = $$("#ed_pages .pg[data-page='0'] .tblock"); return b.length >= Math.min(3, D.lines.filter((l) => !l.page).length) && b; }, 15000);
      times.open.push(performance.now() - t);
      if (!ok(`${tag}: opens with its lines ready to edit`, blocks, blocks ? blocks.length + " lines" : "none")) continue;
      await sleep(250);   // the text tools' bar settles
      const marks = [], gone = [];
      // 1. Edit Text on existing lines
      const done = new Set();
      for (let e = 0; e < edits; e++) {
        // a line's marker goes away once the line is edited, so whatever markers are left are unedited lines
        const left = $$("#ed_pages .pg[data-page='0'] .tblock").filter((b) => !done.has(b.style.top));
        if (!left.length) break;
        const blk = left[Math.floor(r() * left.length)]; done.add(blk.style.top);
        const br = blk.getBoundingClientRect(), f0 = frac(blk);
        t = performance.now(); ptr(blk, "pointerdown", br.left + br.width / 2, br.top + br.height / 2); ptr(blk, "pointerup", br.left + br.width / 2, br.top + br.height / 2);
        let td = await until(() => $("#ed_pages .ditem.tbox.sel .tbtext") || $("#ed_pages .ditem.tbox .tbtext[contenteditable=true]"), 5000);
        times.editOpen.push(performance.now() - t);
        if (!ok(`${tag}: line opens for editing`, td)) continue;
        const before = td.textContent || "", key = before.replace(/\s+/g, " ").trim().slice(0, 14);
        const whole = before.replace(/\s+/g, "");
        const line = D.lines.find((l) => !l.page && whole && l.text.replace(/\s+/g, "") === whole) || D.lines.find((l) => !l.page && key && l.text.replace(/\s+/g, " ").startsWith(key));
        ok(`${tag}: the opened line holds the PDF's words`, line, before.slice(0, 50));
        const iid = td.closest(".ditem").dataset.id, cur = () => $(`#ed_pages .ditem[data-id="${iid}"]`);
        // clicking into a line must not change how it looks: same width as the PDF's own line, and the font stays the
        // same after any background font matching has finished
        const textW = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect().width; };
        const w1 = textW(td), ff0 = td.style.fontFamily, fw0 = getComputedStyle(td).fontWeight;
        ok(`${tag}: clicking a line keeps its look (width matches the PDF's line)`, Math.abs(w1 / br.width - 1) < 0.04, `PDF ${br.width.toFixed(1)}px, editor ${w1.toFixed(1)}px, ${ff0.split(",")[0]}`);
        await sleep(900);
        const tdl = (cur() && cur().querySelector(".tbtext")) || td;
        ok(`${tag}: the font stays the same while the line is open`, tdl.style.fontFamily === ff0 && getComputedStyle(tdl).fontWeight === fw0, `${ff0} ${fw0} -> ${tdl.style.fontFamily} ${getComputedStyle(tdl).fontWeight}`);
        cur().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        td = await until(() => { const e = cur() && cur().querySelector(".tbtext"); return e && e.isContentEditable && e; }, 2000) || cur().querySelector(".tbtext");
        const nt = NEW_TEXT[Math.floor(r() * NEW_TEXT.length)];
        t = performance.now(); typeInto(td, nt); await frame(); times.type.push(performance.now() - t);
        const item = cur() || td.closest(".ditem"); td = item.querySelector(".tbtext") || td;
        const cs = getComputedStyle(td), fr = frac(item) || f0;
        if (line) {
          const [, re, bold, ital] = STD.find((s) => s[0] === line.font);
          ok(`${tag}: edited line keeps the font family (${line.font})`, re.test(td.style.fontFamily || cs.fontFamily), td.style.fontFamily);
          ok(`${tag}: edited line keeps the weight (${line.font})`, (+cs.fontWeight >= 600) === !!bold, cs.fontWeight);
          ok(`${tag}: edited line keeps the slant (${line.font})`, (cs.fontStyle !== "normal") === !!ital, cs.fontStyle);
        }
        const lh = parseFloat(td.style.lineHeight), fs = parseFloat(td.style.fontSize);
        ok(`${tag}: line height comes from the font`, lh > fs * 0.9 && lh < fs * 1.6, `${fs.toFixed(1)}px / ${lh.toFixed(1)}px`);
        const dTop = Math.abs((fr.y0 + fr.y1) / 2 - (f0.y0 + f0.y1) / 2) * $(".pg").getBoundingClientRect().height;
        ok(`${tag}: edited line stays on its line`, dTop < fs * 0.45, `moved ${dTop.toFixed(1)}px at ${fs.toFixed(1)}px`);
        await commit();
        marks.push({ what: "edit", text: nt, f: frac(cur()) || fr }); gone.push(before.trim());
      }
      // 2. New text boxes in different fonts
      window.__cal2SetDocTool("text"); await sleep(80);
      for (let k = 0; k < adds; k++) {
        const ov = $("#ed_pages .pg[data-page='0'] .pgov"); if (!ov) break;
        const o = ov.getBoundingClientRect(), x = o.left + o.width * (0.12 + r() * 0.3), y = o.top + o.height * (0.62 + k * 0.08);
        t = performance.now(); ptr(ov, "pointerdown", x, y); ptr(ov, "pointerup", x, y); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        const td = await until(() => { const e = document.activeElement; return e && e.classList && e.classList.contains("tbtext") && e.isContentEditable && e; }, 4000);
        times.addBox.push(performance.now() - t);
        if (!ok(`${tag}: new text box opens for typing`, td)) { window.__cal2SetDocTool("text"); continue; }
        const nt = NEW_TEXT[Math.floor(r() * NEW_TEXT.length)]; typeInto(td, nt); await frame();
        ok(`${tag}: typed text shows in the box`, td.textContent === nt, td.textContent);
        const item = td.closest(".ditem"), fam = BOX_FONTS[Math.floor(r() * BOX_FONTS.length)];
        // the font picker in the properties bar
        t = performance.now();
        const fb = await until(() => $(".fbtn"), 2000);
        if (fb) {
          fb.click(); const q = await until(() => $(".fpop input[type=search]"), 2000);
          if (q) { q.value = fam; q.dispatchEvent(new Event("input", { bubbles: true })); const b = await until(() => [...$$(".fpop .fl button")].find((x) => x.textContent.trim() === fam), 3000); if (b) b.click(); }
        }
        const ld = await until(async () => { const e = $(`#ed_pages .ditem[data-id="${item.dataset.id}"] .tbtext`) || item.querySelector(".tbtext"); return e && e.style.fontFamily.includes(fam) && (await document.fonts.load(`20px "${fam}"`, nt)).length && e; }, 8000);
        times.font.push(performance.now() - t);
        ok(`${tag}: new box switches to ${fam} and the font loads`, ld, ld ? ld.style.fontFamily : (item.querySelector(".tbtext") || {}).style?.fontFamily);
        await commit(); window.__cal2SetDocTool("text"); await sleep(40);
        const el = $(`#ed_pages .ditem[data-id="${item.dataset.id}"]`) || item;
        if (el.isConnected && frac(el)) marks.push({ what: "box " + fam, text: nt, f: frac(el) });
      }
      window.__cal2SetDocTool("select");
      // 3. Undo everything added, redo it back
      const count = () => $$("#ed_pages .ditem").length, c0 = count();
      t = performance.now();
      for (let k = 0; k < 4; k++) { $("#ed_undo").click(); await frame(); }
      const c1 = count();
      for (let k = 0; k < 4; k++) { $("#ed_redo").click(); await frame(); }
      times.undo.push(performance.now() - t);
      ok(`${tag}: undo then redo restores every edit`, count() === c0, `${c0} -> ${c1} -> ${count()}`);
      await commit(); await sleep(100);
      // 4. Download and check the saved page
      const dl = await download("pdf", "clean", "exact");
      times.save.push(dl.ms);
      if (!ok(`${tag}: clean PDF downloads`, dl.file, dl.ms + " ms")) continue;
      const bytes = new Uint8Array(await dl.file.blob.arrayBuffer()), R = await renderPage(bytes, 0);
      ok(`${tag}: saved PDF has every page`, R.n === D.pages, `${R.n} of ${D.pages}`);
      for (const m of marks) ok(`${tag}: ${m.what} is on the saved page in the right place`, ink(R, m.f) > 0.015, `ink ${(ink(R, m.f) * 100).toFixed(1)}% for "${m.text}"`);
      for (const g of gone) if (g.length > 6) ok(`${tag}: replaced words are gone from the saved text`, !R.text.includes(g), g.slice(0, 40));
      const flat = (t) => t.replace(/\s+/g, ""), saved = flat(R.text), goneF = gone.map((g) => flat(g));
      for (const l of D.lines.filter((l) => !l.page && !goneF.includes(flat(l.text))))
        ok(`${tag}: lines you did not edit are still real text`, saved.includes(flat(l.text)), l.text.slice(0, 40));
      // the same document as a Word file
      const wd = await download("docx");
      if (ok(`${tag}: Word download`, wd.file && wd.file.blob.size > 2000, wd.file ? `${Math.round(wd.file.blob.size / 1024)} KB in ${wd.ms} ms` : "nothing")) {
        try {
          const Z = window.JSZip || (await lib("JSZip", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"));
          const xml = await (await Z.loadAsync(wd.file.blob)).file("word/document.xml").async("string"), wt = flat(xml.replace(/<[^>]+>/g, ""));
          const edited = marks.filter((m) => m.what === "edit").map((m) => flat(m.text.replace(/&/g, "&amp;")));
          ok(`${tag}: Word file has the edited words`, edited.every((e) => wt.includes(e) || wt.includes(e.replace(/&amp;/g, "&"))), edited.filter((e) => !wt.includes(e)).join(" | ").slice(0, 120));
          ok(`${tag}: Word file does not have the replaced words`, goneF.every((g) => !g || !wt.includes(g)), goneF.filter((g) => g && wt.includes(g)).join(" | "));
        } catch (e) { ok(`${tag}: Word file opens`, false, e.message); }
      }
      await download("pdf");
      ok(`${tag}: memory stays reasonable`, heap() - heap0 < 400, `${heap()} MB (start ${heap0} MB)`);
      window.__lastEditedDoc = bytes;
    }
  } finally { window.removeEventListener("error", onErr); window.removeEventListener("unhandledrejection", onErr); window.__cal2Capture = undefined; }
  ok("no script errors during the run", !errors.length, errors.slice(0, 3).join(" | "));
  const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0), mx = (a) => (a.length ? Math.round(Math.max(...a)) : 0);
  const speed = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, `avg ${avg(v)} ms, max ${mx(v)} ms (${v.length})`]));
  const fails = out.filter((o) => !o.pass);
  return { seed, results: out, fails, speed, summary: `${out.length - fails.length}/${out.length} pass, seed ${seed}` };
}

// Real documents (put them in web/_t/, never committed): every line on page 1 is opened for editing to check that
// clicking into it does not change how it looks (same width, same font once font matching has finished); then a few
// lines are changed and the download is checked (old words gone, every other line still real text).
export async function runReal(files = ["sample-letter.pdf"], { change = 3, lines = 14 } = {}) {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 200) }); return !!cond; };
  const textW = (el) => { const rg = document.createRange(); rg.selectNodeContents(el); return rg.getBoundingClientRect().width; };
  for (const [n, f] of files.entries()) {
    const bytes = new Uint8Array(await (await fetch("/_t/" + f)).arrayBuffer());
    const P = await pdfjs(), src = await P.getDocument({ data: bytes.slice() }).promise, before = await (await src.getPage(1)).getTextContent();
    await window.__cal2OpenDocBytes(bytes, f, "pdf");
    location.hash = "#/edit/edittext?r" + n;
    const blocks = await until(() => { const b = $$("#ed_pages .pg[data-page='0'] .tblock"); return b.length && b; }, 15000);
    if (!ok(`${f}: lines ready to edit`, blocks, blocks ? blocks.length : 0)) continue;
    await sleep(400);
    const tops = [...new Set($$("#ed_pages .pg[data-page='0'] .tblock").map((b) => b.style.top))].slice(0, lines);
    let changed = 0; const gone = [];
    for (const top of tops) {
      const blk = $$("#ed_pages .pg[data-page='0'] .tblock").find((b) => b.style.top === top); if (!blk) continue;
      const br = blk.getBoundingClientRect();
      ptr(blk, "pointerdown", br.left + br.width / 2, br.top + br.height / 2); ptr(blk, "pointerup", br.left + br.width / 2, br.top + br.height / 2);
      let td = await until(() => $("#ed_pages .ditem.tbox.sel .tbtext"), 4000);
      if (!ok(`${f}: line opens`, td)) continue;
      const txt = td.textContent, ff0 = td.style.fontFamily, fw0 = getComputedStyle(td).fontWeight, w1 = textW(td), id = td.closest(".ditem").dataset.id;
      ok(`${f}: "${txt.slice(0, 28)}" keeps its width when clicked`, Math.abs(w1 / br.width - 1) < 0.05, `PDF ${br.width.toFixed(1)}px, editor ${w1.toFixed(1)}px, ${ff0.split(",")[0]} ${fw0}`);
      await sleep(1200);
      const td2 = $(`#ed_pages .ditem[data-id="${id}"] .tbtext`) || td;
      ok(`${f}: "${txt.slice(0, 28)}" keeps its font while open`, td2.style.fontFamily === ff0 && getComputedStyle(td2).fontWeight === fw0, `${ff0.split(",")[0]} ${fw0} -> ${td2.style.fontFamily.split(",")[0]} ${getComputedStyle(td2).fontWeight}`);
      if (changed < change && txt.trim().length > 8) {
        const it = $(`#ed_pages .ditem[data-id="${id}"]`); it.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        const ed = await until(() => { const e = $(`#ed_pages .ditem[data-id="${id}"] .tbtext`); return e && e.isContentEditable && e; }, 2000);
        if (ed) { typeInto(ed, txt.replace(/\d/g, (d) => String((+d + 3) % 10)).replace(/[a-z]{4,}/i, "Edited")); await frame(); changed++; gone.push(txt.trim()); }
      }
      await commit();
    }
    // a line that was only clicked, not changed, must not have its words taken out
    const dl = await download("pdf", "clean", "exact");
    if (!ok(`${f}: downloads`, dl.file, dl.ms + " ms")) continue;
    const R = await renderPage(new Uint8Array(await dl.file.blob.arrayBuffer()), 0);
    const flat = (t) => t.replace(/\s+/g, ""), saved = flat(R.text), goneF = gone.map(flat);
    for (const g of gone) ok(`${f}: changed line's old words are gone`, !saved.includes(flat(g)), g.slice(0, 40));
    const keep = before.items.map((t) => t.str).filter((s) => s.trim().length > 6 && !goneF.some((g) => g.includes(flat(s))));
    const missing = keep.filter((s) => !saved.includes(flat(s)));
    ok(`${f}: every other line is still real text`, missing.length === 0, `${keep.length - missing.length}/${keep.length}` + (missing.length ? " missing: " + missing.slice(0, 3).join(" | ") : ""));
  }
  window.__cal2Capture = undefined;
  const fails = out.filter((o) => !o.pass);
  return { results: out, fails, summary: `${out.length - fails.length}/${out.length} pass` };
}

// every look x quality as a PDF, plus the other formats, on the document left open by run()
export async function runPrints({ looks = ["clean", "light", "scanned", "photocopy", "bwscan", "gray", "photo", "counter"], qualities = ["exact", "balanced", "small"], realistic = true } = {}) {
  const rows = [], pages = $$("#ed_pages .pg").length || 1;
  const check = async (label, dl, expectPdf, textKept) => {
    const row = { type: label, ms: dl.ms, kb: dl.file ? Math.round(dl.file.blob.size / 1024) : 0, ok: !!dl.file, note: "" };
    if (dl.file && expectPdf) {
      try {
        const R = await renderPage(new Uint8Array(await dl.file.blob.arrayBuffer()), 0, 1);
        const all = ink(R, { x0: 0, y0: 0, x1: 1, y1: 1 });
        row.ok = R.n === pages && all > 0.003 && all < 0.6; row.note = `${R.n} pages, ink ${(all * 100).toFixed(1)}%` + (textKept ? (R.text.trim() ? ", text kept" : ", NO TEXT") : "");
        if (textKept && !R.text.trim()) row.ok = false;
      } catch (e) { row.ok = false; row.note = String(e.message || e).slice(0, 80); }
    }
    rows.push(row);
  };
  for (const look of looks) for (const q of qualities) await check(`PDF ${look} / ${q}`, await download("pdf", look, q), true, look === "clean");
  if (realistic) await check("PDF scanned / exact / realistic engine", await download("pdf", "scanned", "exact", "realistic"), true, false);
  for (const f of ["fill", "png", "jpg", "zip", "txt", "docx"]) await check(f === "fill" ? "PDF, keep it editable" : f.toUpperCase(), await download(f, "clean", "exact", "fast"), f === "fill", f === "fill");
  await download("pdf", "clean", "exact", "fast");   // leave the panel on the defaults
  window.__cal2Capture = undefined;
  return { rows, fails: rows.filter((r) => !r.ok) };
}
