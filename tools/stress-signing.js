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

// Signature import: typed signatures cropped tight (ink touching the edges), with the signing line through them and
// a box around some. The traced signature must cover the letters and nothing else (no filled triangles or holes),
// the ruled lines must be gone, and the typed signature's font must be read.
export async function runImport() {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 300) }); return !!cond; };
  for (const f of FONTS) { const e = document.createElement("link"); e.rel = "stylesheet"; e.href = `https://fonts.googleapis.com/css2?family=${f.replace(/ /g, "+")}&display=swap`; document.head.append(e); }
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  let read = 0;
  for (let k = 0; k < FONTS.length; k++) {
    const f = FONTS[k], boxed = k % 2 === 1;
    await document.fonts.load(`80px "${f}"`, NAME);
    // the letters alone (the truth), then the picture people import: grey paper, a signing line, maybe a box
    const W = 760, H = 170, truth = document.createElement("canvas"); truth.width = W; truth.height = H; const tg = truth.getContext("2d");
    tg.fillStyle = "#fff"; tg.fillRect(0, 0, W, H); tg.fillStyle = "#000"; tg.font = `92px "${f}"`; tg.fillText(NAME, 30, 128);
    const pic = document.createElement("canvas"); pic.width = W; pic.height = H; const pg = pic.getContext("2d");
    pg.fillStyle = "#dfdfdf"; pg.fillRect(0, 0, W, H); pg.drawImage(truth, 0, 0); pg.globalCompositeOperation = "multiply"; pg.drawImage(truth, 0, 0); pg.globalCompositeOperation = "source-over";
    pg.fillStyle = "#222"; pg.fillRect(0, 122, W, 3);
    if (boxed) { pg.strokeStyle = "#5b3df5"; pg.lineWidth = 3; pg.strokeRect(2, 2, W - 4, H - 4); }
    // crop tight: cut through the tops and bottoms of the tallest letters
    const ink = (() => { const d = tg.getImageData(0, 0, W, H).data; let y0 = H, y1 = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4] < 128) { if (y < y0) y0 = y; if (y > y1) y1 = y; } return { y0, y1 }; })();
    const cy0 = boxed ? 0 : ink.y0 + 3, cy1 = boxed ? H : ink.y1 - 3, crop = document.createElement("canvas"); crop.width = W; crop.height = cy1 - cy0; crop.getContext("2d").drawImage(pic, 0, cy0, W, cy1 - cy0, 0, 0, W, cy1 - cy0);
    const t = window.__cal2TraceSig(crop, { real: 0, lines: window.__LINES !== false });
    if (!ok(`import ${f}${boxed ? " (in a box)" : ""}: traced`, !t.err, t.err)) continue;
    // draw the traced signature back over the crop's area and compare with the letters alone
    const img = await load("data:image/svg+xml;charset=utf-8," + encodeURIComponent(t.svg.replace("<svg ", '<svg style="color:#000" ')));
    const tm = t.mask, mw = t.mw, mh = t.mh;
    let bx0 = mw, by0 = mh, bx1 = 0, by1 = 0; for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (tm[y * mw + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    const R = document.createElement("canvas"); R.width = mw; R.height = mh; const rg = R.getContext("2d"); rg.fillStyle = "#fff"; rg.fillRect(0, 0, mw, mh); rg.drawImage(img, bx0 - 1, by0 - 1, t.w, t.h);
    const T = document.createElement("canvas"); T.width = mw; T.height = mh; T.getContext("2d").drawImage(truth, 0, cy0, W, cy1 - cy0, 0, 0, mw, mh);
    const a = rg.getImageData(0, 0, mw, mh).data, b = T.getContext("2d").getImageData(0, 0, mw, mh).data;
    let both = 0, extra = 0, truthN = 0; for (let i = 0; i < a.length; i += 4) { const A = a[i] < 128, B = b[i] < 128; if (B) truthN++; if (A && B) both++; if (A && !B) extra++; }
    ok(`import ${f}${boxed ? " (in a box)" : ""}: covers the letters`, both / truthN > (f === "Sacramento" ? 0.65 : 0.8), `${(100 * both / truthN).toFixed(1)}% of the letters` + (f === "Sacramento" ? " (hairline strokes lying exactly on the signing line go with it)" : ""));
    ok(`import ${f}${boxed ? " (in a box)" : ""}: nothing extra (no filled shapes, line and box gone)`, extra / truthN < 0.25, `extra ink ${(100 * extra / truthN).toFixed(1)}% of the letters' ink`);
    const list = await window.__cal2ReadTyped(crop, NAME);
    if (list && list[0].family === f) read++;
    ok(`import ${f}: read as typed in its font`, list && list[0].family === f && (list[0].pct >= 60 || (list[0].pct >= 45 && list[1] && list[0].pct - list[1].pct >= 5)), list ? list.slice(0, 3).map((m) => m.family + " " + m.pct + "%").join(", ") : "none");
  }
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed; fonts read ${read}/${FONTS.length}`, fails: out.filter((o) => !o.pass), out };
}

// The signature viewer: zoom, the picture itself with its background removed (own colours or re-inked), upscaling,
// a new variation, and Save & use placing it on the open document.
export async function runViewer() {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 300) }); return !!cond; };
  const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap"; document.head.append(l);
  await sleep(800); await document.fonts.load('80px "Great Vibes"', NAME).catch(() => {});
  // a blue pen signature on cream paper with a grey signing line, as a phone photo might show it
  const c = document.createElement("canvas"); c.width = 700; c.height = 200; const g = c.getContext("2d");
  g.fillStyle = "#f3ecd9"; g.fillRect(0, 0, 700, 200); g.fillStyle = "#1d3fb8"; g.font = '96px "Great Vibes"'; g.fillText(NAME, 40, 140);
  g.fillStyle = "#777"; g.fillRect(0, 150, 700, 2);
  const file = new File([await new Promise((r) => c.toBlob(r, "image/png"))], "photo.png", { type: "image/png" });
  const D = await makeDoc(); await window.__cal2OpenDocBytes(D.bytes, "viewer.pdf", "pdf"); location.hash = "#/edit?" + Date.now(); await until(() => ov0(), 15000); await sleep(400);
  const orig = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () { if (this.type !== "file") return orig.call(this); HTMLInputElement.prototype.click = orig; const dt = new DataTransfer(); dt.items.add(file); this.files = dt.files; this.dispatchEvent(new Event("change", { bubbles: true })); };
  window.__cal2PickSignatureImage();
  const svgOut = async (pred, ms = 15000) => until(() => { const s = $("#sx_out svg"); return s && pred(s) && s; }, ms);
  const pixels = async (svg) => { const img = await new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = svg.querySelector(":scope > image").getAttribute("href"); }); const k = document.createElement("canvas"); k.width = img.width; k.height = img.height; const kg = k.getContext("2d"); kg.drawImage(img, 0, 0); return kg.getImageData(0, 0, k.width, k.height).data; };
  ok("viewer: opens with the traced signature", await svgOut((s) => s.querySelector("path")), ($("#sx_out") || {}).textContent);
  $("#sx_zin").click(); await sleep(100); ok("viewer: zooms in", /%/.test($("#sx_zoomv").textContent), $("#sx_zoomv").textContent);
  $("#sx_fit").click(); await sleep(100); ok("viewer: back to fit", $("#sx_zoomv").textContent === "Fit", $("#sx_zoomv").textContent);
  const sel = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("change", { bubbles: true })); };
  sel("#sx_mode", "photo");
  const ph = await svgOut((s) => s.querySelector(":scope > image"));
  if (ok("viewer: picture mode gives the picture", ph)) {
    const px = await pixels(ph), n = px.length / 4;
    let clear = 0, solid = 0, blueish = 0; for (let i = 0; i < px.length; i += 4) { if (px[i + 3] < 10) clear++; else if (px[i + 3] > 200) { solid++; if (px[i + 2] > px[i] + 40) blueish++; } }
    ok("viewer: the paper is see-through", clear / n > 0.6, `${(100 * clear / n).toFixed(0)}% clear, ${(100 * solid / n).toFixed(1)}% solid ink`);
    ok("viewer: re-inked in the chosen ink (black)", solid > 200 && blueish / solid < 0.1, `${blueish}/${solid} blue`);
    const keep = $("#sx_keep"); keep.checked = true; keep.dispatchEvent(new Event("change", { bubbles: true }));
    const ph2 = await svgOut((s) => s.querySelector(":scope > image") && s.querySelector(":scope > image").getAttribute("href") !== ph.querySelector(":scope > image").getAttribute("href"));
    if (ph2) { const p2 = await pixels(ph2); let s2 = 0, b2 = 0; for (let i = 0; i < p2.length; i += 4) if (p2[i + 3] > 200) { s2++; if (p2[i + 2] > p2[i] + 40) b2++; } ok("viewer: keeps the picture's own (blue) ink when asked", s2 > 200 && b2 / s2 > 0.6, `${b2}/${s2} blue`); }
    else ok("viewer: keeps the picture's own ink when asked", false, "no new picture");
  }
  const w0 = +(((($("#sx_info") || {}).textContent || "").match(/(\d+) ×/) || [])[1] || 0);
  sel("#sx_up", "2");
  const up = await until(() => { const m = (($("#sx_info") || {}).textContent || "").match(/(\d+) × \d+ px · upscaled 2×/); return m && +m[1]; }, 20000);
  ok("viewer: 2× upscale makes it bigger", up && up > w0 * 1.6, `${w0} -> ${up}`);
  sel("#sx_up", "1"); sel("#sx_mode", "trace");
  const t1 = await svgOut((s) => !!s.querySelector("path")); const d1 = t1 && t1.querySelector("path").getAttribute("d");
  $("#sx_var").click();
  const t2 = await svgOut((s) => s.querySelector("path") && s.querySelector("path").getAttribute("d") !== d1);
  ok("viewer: a new variation is a little different", t2, t2 ? "differs" : "same");
  const before = $$("#ed_pages .ditem").length; $("#sx_place").click(); await sleep(900);
  ok("viewer: Save & use puts it on the page", $$("#ed_pages .ditem").length === before + 1 && !$("#sigx").open, `${before} -> ${$$("#ed_pages .ditem").length}`);
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed`, fails: out.filter((o) => !o.pass), out };
}
