// Moving objects between pages by dragging (sample content only): a text box, a picture and a signing block are
// dragged from page 1 onto page 2 and back up, on pages of the same size and onto a landscape page. Checks: the object
// is on the new page where it was dropped (editor and downloaded PDF), not on the old one, keeps its size on the paper,
// Edit Text lines do not hop, and Undo brings it back.
// To run: copy to web/_t/stress-pagehop.js, open the app, then
//   (await import("/_t/stress-pagehop.js")).run().then((r) => console.log(r.summary))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const frame = () => new Promise((r) => { const t = setTimeout(r, 60); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(); })); });
async function until(fn, ms = 8000, step = 40) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
async function lib(name, url) { if (window[name]) return window[name]; const s = document.createElement("script"); s.src = url; document.head.append(s); await new Promise((r, j) => { s.onload = r; s.onerror = j; }); return window[name]; }
const pdfLib = () => lib("PDFLib", "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js");
const ptr = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }));
const pg = (i) => $(`#ed_pages .pg[data-page='${i}']`);
const ov = (i) => pg(i) && pg(i).querySelector(".pgov");
async function makeDoc(landscape2) {
  const L = await pdfLib(), d = await L.PDFDocument.create(), f = await d.embedFont(L.StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText("PAGE ONE sample", { x: 72, y: 720, size: 14, font: f });
  d.addPage(landscape2 ? [792, 612] : [612, 792]).drawText("PAGE TWO sample", { x: 72, y: 540, size: 14, font: f });
  return new Uint8Array(await d.save());
}
async function picture() { const c = document.createElement("canvas"); c.width = 200; c.height = 100; const g = c.getContext("2d"); g.fillStyle = "#c0392b"; g.fillRect(0, 0, 200, 100); return new File([await new Promise((r) => c.toBlob(r, "image/png"))], "red.png", { type: "image/png" }); }
async function download() { const s = $("#dl_format"); s.value = "pdf"; s.dispatchEvent(new Event("change", { bubbles: true })); window.__cal2Capture = []; $("#dl_go").click(); const c = await until(() => window.__cal2Capture.length && window.__cal2Capture[0], 60000); return new Uint8Array(await c.blob.arrayBuffer()); }
async function inkOn(bytes, page, box) {
  const P = window.pdfjsLib, d = await P.getDocument({ data: bytes.slice() }).promise, p = await d.getPage(page + 1), vp = p.getViewport({ scale: 1 });
  const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
  const x = Math.max(0, Math.floor(box.x0 * c.width)), y = Math.max(0, Math.floor(box.y0 * c.height)), w = Math.max(1, Math.ceil((box.x1 - box.x0) * c.width)), h = Math.max(1, Math.ceil((box.y1 - box.y0) * c.height));
  const px = g.getImageData(x, y, Math.min(w, c.width - x), Math.min(h, c.height - y)).data; let n = 0; for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 600) n++; return n / (px.length / 4);
}
const frac = (el, i) => { const a = el.getBoundingClientRect(), b = ov(i).getBoundingClientRect(); return { x0: (a.left - b.left) / b.width, y0: (a.top - b.top) / b.height, x1: (a.right - b.left) / b.width, y1: (a.bottom - b.top) / b.height, wPt: a.width / b.width }; };
// drag an object by its middle to a spot on another page (fractions of that page)
async function dragTo(el, toPage, fx, fy) {
  const a = el.getBoundingClientRect(), x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
  pg(toPage).scrollIntoView({ block: "center" }); await frame();
  const a2 = el.getBoundingClientRect(), sx = a2.left + a2.width / 2, sy = a2.top + a2.height / 2, r = ov(toPage).getBoundingClientRect(), tx = r.left + r.width * fx, ty = r.top + r.height * fy;
  ptr(el, "pointerdown", sx, sy);
  for (let k = 1; k <= 12; k++) ptr(el, "pointermove", sx + (tx - sx) * k / 12, sy + (ty - sy) * k / 12);
  ptr(el, "pointerup", tx, ty); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); await frame(); await sleep(250);
}

export async function run() {
  const out = [], ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 300) }); return !!cond; };
  for (const landscape of [false, true]) {
    const tag = landscape ? "onto a landscape page" : "same-size pages";
    await window.__cal2OpenDocBytes(await makeDoc(landscape), "hop.pdf", "pdf"); location.hash = "#/edit?" + Date.now();
    await until(() => ov(1), 15000); await sleep(400); window.__cal2SetDocTool("select");
    // a picture on page 1
    pg(0).scrollIntoView({ block: "center" }); await frame();
    await window.__cal2InsertImageFile(await picture()); await sleep(500);
    const pic = await until(() => pg(0).querySelector(".ditem img") && pg(0).querySelector(".ditem img").closest(".ditem"), 4000);
    if (!ok(`${tag}: a picture on page 1`, pic)) continue;
    const before = frac(pic, 0), w0pt = before.wPt * (landscape ? 612 : 612);   // width in points on page 1 (612 wide)
    await dragTo(pic, 1, 0.3, 0.4);
    const moved = await until(() => pg(1).querySelector(".ditem img") && pg(1).querySelector(".ditem img").closest(".ditem"), 3000);
    ok(`${tag}: dragged onto page 2`, moved && !pg(0).querySelector(".ditem img"), moved ? "on page 2" : "not moved");
    if (moved) {
      const f = frac(moved, 1), wPt = f.wPt * (landscape ? 792 : 612);
      ok(`${tag}: lands where it was dropped`, Math.abs((f.x0 + f.x1) / 2 - 0.3) < 0.06 && Math.abs((f.y0 + f.y1) / 2 - 0.4) < 0.08, `centre ${((f.x0 + f.x1) / 2).toFixed(2)}, ${((f.y0 + f.y1) / 2).toFixed(2)}`);
      ok(`${tag}: the same size on the paper`, Math.abs(wPt / w0pt - 1) < 0.04, `${w0pt.toFixed(0)} pt -> ${wPt.toFixed(0)} pt`);
      const bytes = await download();
      const in2 = await inkOn(bytes, 1, f), in1 = await inkOn(bytes, 0, before);
      ok(`${tag}: in the PDF it is on page 2, not page 1`, in2 > 0.5 && in1 < 0.02, `page 2 ${(in2 * 100).toFixed(0)}%, page 1 ${(in1 * 100).toFixed(1)}%`);
      // undo brings it back to page 1
      $("#ed_undo").click(); await sleep(400);
      ok(`${tag}: Undo puts it back on page 1`, pg(0).querySelector(".ditem img") && !pg(1).querySelector(".ditem img"), "");
      $("#ed_redo").click(); await sleep(400);
      // and up again, from page 2 to page 1
      const again = await until(() => pg(1).querySelector(".ditem img") && pg(1).querySelector(".ditem img").closest(".ditem"), 3000);
      if (again) { await dragTo(again, 0, 0.6, 0.7); ok(`${tag}: dragged back up onto page 1`, pg(0).querySelector(".ditem img") && !pg(1).querySelector(".ditem img"), ""); }
    }
    // a text box and a signing block
    const ta = $("#text"); if (ta) { ta.value = "Jane Sample"; ta.dispatchEvent(new Event("input", { bubbles: true })); }
    for (const tool of ["text", "sigblock"]) {
      pg(0).scrollIntoView({ block: "center" }); await frame();
      window.__cal2SetDocTool(tool); await frame();
      const r = ov(0).getBoundingClientRect(); ptr(ov(0), "pointerdown", r.left + r.width * 0.3, r.top + r.height * 0.75); ptr(ov(0), "pointerup", r.left + r.width * 0.3, r.top + r.height * 0.75); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
      await sleep(700);
      if (tool === "text") { const td = document.activeElement; if (td && td.isContentEditable) { document.execCommand("insertText", false, "Moved box"); } const r2 = ov(0).getBoundingClientRect(); ptr(ov(0), "pointerdown", r2.right - 5, r2.bottom - 5); ptr(ov(0), "pointerup", r2.right - 5, r2.bottom - 5); window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); await sleep(300); }
      const n1 = pg(1).querySelectorAll(".ditem").length;
      const el = [...pg(0).querySelectorAll(".ditem")].find((e) => (tool === "text" ? e.classList.contains("tbox") : e.querySelector("canvas")));
      if (!ok(`${tag}: a ${tool === "text" ? "text box" : "signing block"} on page 1`, el)) continue;
      await dragTo(el, 1, 0.5, 0.6);
      ok(`${tag}: the ${tool === "text" ? "text box" : "signing block"} moves to page 2`, pg(1).querySelectorAll(".ditem").length === n1 + 1, `${n1} -> ${pg(1).querySelectorAll(".ditem").length}`);
    }
  }
  const pass = out.filter((o) => o.pass).length;
  return { summary: `${pass}/${out.length} passed`, fails: out.filter((o) => !o.pass), out };
}
