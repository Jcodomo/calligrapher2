// Test for the signing block (sample names only): placing it, the signature and printed name, the signing code (the
// start of the document's SHA-256 fingerprint, with the full one in the PDF's properties), every date on the page
// showing the same signing time, and matching the script font of a typed signature already on the page.
// To run: copy to web/_t/stress-signing.js, open the app, then
//   (await import("/_t/stress-signing.js")).run().then((r) => console.log(r.summary))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const frame = () => new Promise((r) => { const t = setTimeout(r, 60); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); });
async function until(fn, ms = 8000, step = 40) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
async function lib(name, url) { if (window[name]) return window[name]; const s = document.createElement("script"); s.src = url; document.head.append(s); await new Promise((r, j) => { s.onload = r; s.onerror = j; }); return window[name]; }
const pdfLib = () => lib("PDFLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
const ov0 = () => $("#ed_pages .pg[data-page='0'] .pgov");
const at = (fx, fy) => { const r = ov0().getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; };
async function click(fx, fy) { const ov = ov0(), [x, y] = at(fx, fy); ptr(ov, "pointerdown", x, y); ptr(ov, "pointerup", x, y); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame(); }
async function drag(a, b) { const ov = ov0(), [x0, y0] = at(...a), [x1, y1] = at(...b); ptr(ov, "pointerdown", x0, y0); for (let s = 1; s <= 6; s++) ptr(ov, "pointermove", x0 + (x1 - x0) * s / 6, y0 + (y1 - y0) * s / 6); ptr(ov, "pointerup", x1, y1); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame(); }
async function download(format = "pdf") {
  const s = $("#dl_format"); s.value = format; s.dispatchEvent(new Event("change", { bubbles: true })); const l = $("#dl_look"); if (l) { l.value = "clean"; l.dispatchEvent(new Event("change", { bubbles: true })); }
  window.__cal2Capture = []; $("#dl_go").click(); const c = await until(() => window.__cal2Capture.length && window.__cal2Capture[0], 60000); return c;
}
const FONTS = ["Dancing Script", "Great Vibes", "Homemade Apple", "Allura", "Sacramento", "Caveat", "Mr Dafoe"];
const NAME = "Jane Sample";
// a letter page with a signature line, and one typed signature per font (drawn as a picture, as signing services do)
async function makeDoc() {
  const L = await pdfLib(), d = await L.PDFDocument.create(), f = await d.embedFont(L.StandardFonts.Helvetica), p = d.addPage([612, 792]);
  p.drawText("SAMPLE AGREEMENT", { x: 72, y: 720, size: 16, font: f });
  p.drawText("I agree to the terms above.", { x: 72, y: 690, size: 11, font: f });
  p.drawLine({ start: { x: 72, y: 150 }, end: { x: 300, y: 150 }, thickness: 1 }); p.drawText("Signature", { x: 72, y: 136, size: 9, font: f });
  const spots = [];
  for (let k = 0; k < FONTS.length; k++) {
    await document.fonts.load(`64px "${FONTS[k]}"`, NAME);
    const c = document.createElement("canvas"); c.width = 900; c.height = 180; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, 900, 180);
    g.fillStyle = "#111"; g.font = `86px "${FONTS[k]}"`; g.textBaseline = "alphabetic"; g.fillText(NAME, 20, 125);
    const png = await new Promise((r) => c.toBlob((b) => b.arrayBuffer().then((a) => r(new Uint8Array(a))), "image/png"));
    const x = 72 + (k % 2) * 260, y = 600 - Math.floor(k / 2) * 95;
    p.drawImage(await d.embedPng(png), { x, y, width: 225, height: 45 });
    spots.push({ font: FONTS[k], box: { x0: x / 612, y0: 1 - (y + 45) / 792, x1: (x + 225) / 612, y1: 1 - y / 792 } });
  }
  return { bytes: new Uint8Array(await d.save()), spots };
}

export async function run() {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 300) }); return !!cond; };
  for (const f of FONTS) { const e = document.createElement("link"); e.rel = "stylesheet"; e.href = `https://fonts.googleapis.com/css2?family=${f.replace(/ /g, "+")}&display=swap`; document.head.append(e); }
  const D = await makeDoc();
  await window.__cal2OpenDocBytes(D.bytes, "agreement.pdf", "pdf"); location.hash = "#/edit?" + Date.now();
  await until(() => ov0(), 15000); await sleep(400);
  const ta = $("#text"); if (ta) { ta.value = NAME; ta.dispatchEvent(new Event("input", { bubbles: true })); }
  // 1. a signing block on the signature line
  window.__cal2SetDocTool("sigblock"); await frame(); await click(0.3, 0.76); await sleep(700);
  const blockEl = await until(() => $$("#ed_pages .ditem").find((e) => e.querySelector("canvas")), 4000);
  ok("signing block: placed on the page", blockEl, $$("#ed_pages .ditem").length + " objects");
  const nameIn = await until(() => [...document.querySelectorAll("input")].find((i) => i.placeholder === "Signer's name"), 3000);
  ok("signing block: takes the side panel's name", nameIn && nameIn.value === NAME, nameIn && nameIn.value);
  // 2. two dates; changing one changes both
  window.__cal2SetDocTool("date"); await frame(); await click(0.75, 0.76); await sleep(150);
  window.__cal2SetDocTool("date"); await frame(); await click(0.75, 0.2); await sleep(150);
  const tI = await until(() => $(".timebox"), 3000), zI = tI && tI.parentElement.querySelector("select");
  if (ok("dates: a date's time can be typed", tI)) {
    tI.value = "8:33 am"; tI.dispatchEvent(new Event("change", { bubbles: true })); await frame();
    if (zI) { zI.value = "PST"; zI.dispatchEvent(new Event("change", { bubbles: true })); }
    await sleep(200);
  }
  // 3. match each typed signature's font
  const results = [];
  for (const s of D.spots) {
    const blk = $$("#ed_pages .ditem").find((e) => e.querySelector("canvas")); blk.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: blk.getBoundingClientRect().left + 5, clientY: blk.getBoundingClientRect().top + 5, pointerId: 1, buttons: 1 })); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await sleep(120);
    const mb = await until(() => [...document.querySelectorAll("button")].find((b) => /Match a signature/.test(b.textContent)), 3000);
    if (!mb) { results.push([s.font, "no button"]); continue; }
    mb.click(); await frame();
    await drag([s.box.x0 - 0.005, s.box.y0 - 0.004], [s.box.x1 + 0.005, s.box.y1 + 0.004]);
    const sel = await until(() => { const o = [...document.querySelectorAll("select")].find((x) => [...x.options].some((op) => op.value === "hand")); return o && o.value !== "" && !/Matching/.test(document.body.innerText.slice(-300)) && o; }, 20000);
    await sleep(2500);
    const sel2 = [...document.querySelectorAll("select")].find((x) => [...x.options].some((op) => op.value === "hand"));
    results.push([s.font, sel2 ? sel2.value : "?"]);
  }
  const right = results.filter(([a, b]) => a === b).length;
  ok("matching: a typed signature's script font is found", right >= results.length - 1, `${right}/${results.length}: ` + results.map(([a, b]) => `${a} -> ${b}`).join("; "));
  // 4. download: block drawn, dates the same, fingerprint in the properties
  const c = await download("pdf");
  if (ok("download: a PDF", c && c.blob.size > 1000, c && c.blob.size)) {
    const bytes = new Uint8Array(await c.blob.arrayBuffer()), P = window.pdfjsLib, doc = await P.getDocument({ data: bytes.slice() }).promise, pg = await doc.getPage(1), md = await doc.getMetadata();
    const info = JSON.stringify(md.info), m = info.match(/Signing code ([0-9A-F]{16}) = first 16 characters of SHA-256 ([0-9A-F]{64})/);
    const want = [...new Uint8Array(await crypto.subtle.digest("SHA-256", D.bytes))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
    ok("download: the signing code is the original document's SHA-256", m && m[2] === want && m[1] === want.slice(0, 16), m ? m[1] + " / " + (m[2] === want) : info.slice(0, 200));
    const tc = (await pg.getTextContent()).items.map((t) => t.str).join(" ");
    const dates = tc.match(/\d{2}\/\d{2}\/\d{4} \| \d{1,2}:\d{2} [AP]M [A-Z]{2,5}/g) || [];
    ok("download: both dates show the same signing time", dates.length === 2 && dates[0] === dates[1] && /8:33 AM PST/.test(dates[0]), dates.join(" / ") || tc.slice(-120));
    const vp = pg.getViewport({ scale: 2 }), cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height; const g = cv.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, cv.width, cv.height); await pg.render({ canvasContext: g, viewport: vp }).promise;
    const r = ($$("#ed_pages .ditem").find((e) => e.querySelector("canvas")) || blockEl).getBoundingClientRect(), pr = ov0().getBoundingClientRect(), bx = (r.left - pr.left) / pr.width * cv.width, by = (r.top - pr.top) / pr.height * cv.height, bw = r.width / pr.width * cv.width, bh = r.height / pr.height * cv.height;
    const px = g.getImageData(bx, by, bw, bh).data; let ink = 0, acc = 0; for (let i = 0; i < px.length; i += 4) { if (px[i] + px[i + 1] + px[i + 2] < 450) ink++; if (px[i + 2] > 180 && px[i] < 140 && px[i + 1] < 110) acc++; }
    ok("download: the block (signature, name, frame) is on the page", ink / (px.length / 4) > 0.02 && acc > 50, `ink ${(100 * ink / (px.length / 4)).toFixed(1)}%, frame pixels ${acc}`);
  }
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed`, fails: out.filter((o) => !o.pass), out };
}
