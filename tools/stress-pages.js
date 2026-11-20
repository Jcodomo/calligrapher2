// Stress tests for Merge / Split / Extract, Edit text and exports (55 checks). Drives the real UI in a
// browser and collects downloads through window.__cal2Capture. To run: put alpha.pdf (2 pages), bravo.pdf
// (3 pages), big.pdf (60 pages; each page starting "<NAME> test document - page N of M") and a letter with
// unnamed embedded fonts as sample-letter.pdf in web/_t/, copy this file there as stress.js, open the app
// and run: (await import("/_t/stress.js")).run().then(console.table). web/_t is not committed.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const out = [];
const ok = (name, cond, info = "") => { out.push({ name, pass: !!cond, info: String(info).slice(0, 300) }); };
async function file(name) { const b = await fetch("/_t/" + name).then((r) => r.blob()); return new File([b], name, { type: "application/pdf" }); }
async function until(fn, ms = 8000, step = 40) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
async function pdfTexts(bytes) {
  const d = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise, res = [];
  for (let i = 1; i <= d.numPages; i++) { const pg = await d.getPage(i); const tc = await pg.getTextContent(); res.push({ text: tc.items.map((x) => x.str).join(" ").slice(0, 60), rot: pg.rotate, w: Math.round(pg.view[2]), h: Math.round(pg.view[3]) }); }
  return res;
}
const firstWord = (t) => (t.match(/(ALPHA|BRAVO|BIG)[^-]*- page (\d+)/) || []).slice(1).join(" ");
async function captured(n = 1, ms = 20000) { return until(() => window.__cal2Capture.length >= n && window.__cal2Capture, ms); }
async function blobBytes(b) { return new Uint8Array(await b.arrayBuffer()); }
async function openFresh(files, tool) {
  await window.__cal2OpenDocFile(files[0]);
  if (files.length > 1) await window.__cal2AddFilesToDoc(files.slice(1));
  location.hash = "#/edit/" + tool;
  await until(() => document.body.dataset.pw && $("#pw .pw-grid"));
  await sleep(150);
}
const pwBtn = (a) => $(`#pw [data-a="${a}"]`);
async function goAndCapture(n = 1) {
  window.__cal2Capture = [];
  pwBtn("go").click();
  const c = await captured(n);
  return c ? c.slice() : [];
}
function dragDrop(src, dst) {
  const dt = new DataTransfer();
  src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
  dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
}
async function thumbsLoaded(ms = 15000) {
  return until(() => { const ims = $$("#pw .pw-card img"); return ims.length && ims.every((i) => (i.src.startsWith("blob:") || i.src.startsWith("data:image/jpeg"))); }, ms);
}

export async function run(only) {
  out.length = 0;
  window.__cal2Capture = [];
  const A = await file("alpha.pdf"), B = await file("bravo.pdf");
  const want = (k) => !only || only.includes(k);

  if (want("merge")) {
    // 1. Merge two files: Files view shows 2 cards with page counts
    await openFresh([A, B], "merge");
    const cards = $$("#pw .pw-file");
    ok("merge: 2 file cards", cards.length === 2, cards.length);
    ok("merge: page counts", cards.map((c) => c.querySelector(".pw-sub").textContent).join("|") === "2 pages|3 pages", cards.map((c) => c.querySelector(".pw-sub").textContent).join("|"));
    ok("merge: stacked look on multi-page files", cards.every((c) => c.querySelector(".pw-card.stack")));
    const t0 = performance.now(); const tl = await thumbsLoaded();
    ok("merge: thumbnails load", tl, Math.round(performance.now() - t0) + " ms");
    // 2. Download as is: 5 pages in order A1 A2 B1 B2 B3
    let c = await goAndCapture(); let tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    ok("merge: output pages in order", tx.map((t) => firstWord(t.text)).join(",") === "ALPHA 1,ALPHA 2,BRAVO 1,BRAVO 2,BRAVO 3", tx.map((t) => firstWord(t.text)).join(","));
    // 3. Drag bravo before alpha
    dragDrop($$("#pw .pw-file")[1], $$("#pw .pw-file")[0]); await sleep(200);
    ok("merge: drag reorders files", $$("#pw .pw-file .pw-tag")[0].textContent === "bravo.pdf", $$("#pw .pw-file .pw-tag").map((t) => t.textContent).join(","));
    c = await goAndCapture(); tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    ok("merge: reordered output", tx.map((t) => firstWord(t.text)).join(",") === "BRAVO 1,BRAVO 2,BRAVO 3,ALPHA 1,ALPHA 2", tx.map((t) => firstWord(t.text)).join(","));
    // 4. Undo brings the order back
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true })); await sleep(300);
    ok("merge: Ctrl+Z undoes the reorder", ($$("#pw .pw-file .pw-tag")[0] || {}).textContent === "alpha.pdf", ($$("#pw .pw-file .pw-tag")[0] || {}).textContent);
    // 5. Pages view: tick page 1, rotate right, delete page 5
    $('#pw [data-v="pages"]').click(); await sleep(150);
    ok("merge: pages view lists 5 pages", $$("#pw .pw-page").length === 5, $$("#pw .pw-page").length);
    ok("merge: delete disabled with nothing ticked", pwBtn("del").disabled);
    $$("#pw .pw-page")[0].click(); await sleep(80);
    pwBtn("rotr").click(); await sleep(200);
    ok("merge: rotate keeps the tick", $$("#pw .pw-page")[0].querySelector(".pw-chk.on"));
    $$("#pw .pw-page")[0].click(); await sleep(60); $$("#pw .pw-page")[4].click(); await sleep(60);
    pwBtn("del").click(); await sleep(250);
    ok("merge: delete removes the ticked page", $$("#pw .pw-page").length === 4, $$("#pw .pw-page").length);
    c = await goAndCapture(); tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    const land = (t) => (t.rot % 180 ? t.h > t.w : t.w > t.h);
    ok("merge: rotation + delete in output", tx.length === 4 && land(tx[0]) && tx.slice(1).every((t) => !land(t)) && firstWord(tx[3].text) === "BRAVO 2" && firstWord(tx[0].text) === "ALPHA 1", JSON.stringify(tx.map((t) => [firstWord(t.text), t.w, t.h, t.rot])));
    // 6. Select all + delete is refused (a document needs a page)
    $("#pw .pw-all").click(); await sleep(80);
    ok("merge: select all ticks every page", $$("#pw .pw-page .pw-chk.on").length === 4);
    pwBtn("del").click(); await sleep(200);
    ok("merge: can't delete every page", $$("#pw .pw-page").length === 4);
    $("#pw .pw-all").click(); await sleep(60);
    // 7. Rotate all four times: back to upright
    for (let k = 0; k < 4; k++) { pwBtn("rotl").click(); await sleep(60); }
    c = await goAndCapture(); tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    ok("merge: 4x rotate left = original turn", tx.length === 4 && land(tx[0]) && !land(tx[1]), JSON.stringify(tx.map((t) => [t.w, t.h, t.rot])));
  }

  if (want("split")) {
    await openFresh([A, B], "split");
    ok("split: 4 scissors for 5 pages", $$("#pw .pw-cut").length === 4, $$("#pw .pw-cut").length);
    ok("split: go disabled before a cut", pwBtn("go").disabled);
    $$("#pw .pw-cut")[1].click(); await sleep(150);
    ok("split: cut makes 2 shaded groups", $$("#pw .pw-group.cut").length === 2 && $$("#pw .pw-cutline.on").length === 1, $$("#pw .pw-group.cut").length);
    ok("split: button says 2 files", /2 files/.test(pwBtn("go").textContent), pwBtn("go").textContent);
    let c = await goAndCapture();
    let names = [], counts = [];
    if (c[0]) {
      const zip = await window.JSZip.loadAsync(c[0].blob);
      names = Object.keys(zip.files).sort();
      for (const n of names) { const tx = await pdfTexts(await zip.files[n].async("uint8array")); counts.push(tx.map((t) => firstWord(t.text)).join("+")); }
    }
    ok("split: zip with 2 PDFs", names.length === 2 && /part1-pages1-2/.test(names[0]) && /part2-pages3-5/.test(names[1]), names.join(","));
    ok("split: parts hold the right pages", counts.join(" | ") === "ALPHA 1+ALPHA 2 | BRAVO 1+BRAVO 2+BRAVO 3", counts.join(" | "));
    // clicking the cut again joins
    $("#pw .pw-cutline.on .pw-cut").click(); await sleep(120);
    ok("split: clicking a cut again joins", !$$("#pw .pw-group.cut").length && pwBtn("go").disabled);
    // cut every page
    pwBtn("cutall").click(); await sleep(150);
    ok("split: cut every page = 5 groups", $$("#pw .pw-group.cut").length === 5);
    c = await goAndCapture();
    if (c[0]) { const zip = await window.JSZip.loadAsync(c[0].blob); ok("split: every page = 5 files", Object.keys(zip.files).length === 5, Object.keys(zip.files).join(",")); } else ok("split: every page = 5 files", false, "no download");
    // rapid toggling (50 clicks) ends in a consistent state
    pwBtn("clearcuts").click(); await sleep(100);
    for (let k = 0; k < 50; k++) { const cuts = $$("#pw .pw-cut"); cuts[k % cuts.length].click(); }
    await sleep(200);
    const groups = $$("#pw .pw-group").length, lines = $$("#pw .pw-cutline.on").length;
    ok("split: 50 rapid clicks stay consistent", groups === lines + 1 && $$("#pw .pw-page").length === 5, `groups ${groups}, cuts ${lines}`);
    pwBtn("clearcuts") && pwBtn("clearcuts").click(); await sleep(80);
    // a cut survives reordering the pages it sits after; deleting that page drops it
    $$("#pw .pw-cut")[0].click(); await sleep(100);
    ok("split: cut after page 1", $$("#pw .pw-group")[0].querySelectorAll(".pw-page").length === 1);
    // Extract: tick pages 2 and 4
    $('#pw [data-s="extract"]').click(); await sleep(120);
    ok("extract: go disabled with nothing ticked", pwBtn("go").disabled);
    $$("#pw .pw-page")[1].click(); await sleep(50); $$("#pw .pw-page")[3].click(); await sleep(80);
    ok("extract: button counts ticks", /Extract 2 pages/.test(pwBtn("go").textContent), pwBtn("go").textContent);
    c = await goAndCapture();
    const tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    ok("extract: one PDF with pages 2 and 4", c[0] && /-extract\.pdf$/.test(c[0].name) && tx.map((t) => firstWord(t.text)).join(",") === "ALPHA 2,BRAVO 2", (c[0] && c[0].name) + " " + tx.map((t) => firstWord(t.text)).join(","));
  }

  if (want("mixed")) {
    // a picture + a PDF with a turned page and a landscape page
    const L = window.PDFLib;
    const d = await L.PDFDocument.create();
    const p1 = d.addPage([792, 612]); p1.drawText("LANDSCAPE page", { x: 60, y: 500, size: 30 });
    const p2 = d.addPage([612, 792]); p2.drawText("TURNED page", { x: 60, y: 700, size: 30 }); p2.setRotation(L.degrees(90));
    const odd = new File([await d.save()], "odd.pdf", { type: "application/pdf" });
    const cv = document.createElement("canvas"); cv.width = 800; cv.height = 600; const g = cv.getContext("2d"); g.fillStyle = "#3a6"; g.fillRect(0, 0, 800, 600); g.fillStyle = "#fff"; g.font = "60px Arial"; g.fillText("PICTURE", 200, 320);
    const png = new File([await new Promise((r) => cv.toBlob(r, "image/png"))], "pic.png", { type: "image/png" });
    await openFresh([odd, png, A], "merge");
    ok("mixed: 3 file cards", $$("#pw .pw-file").length === 3, $$("#pw .pw-file").length);
    await thumbsLoaded();
    const ims = $$("#pw .pw-file img");
    const asp = await Promise.all(ims.map((im) => new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth / i.naturalHeight); i.src = im.src; })));
    ok("mixed: landscape thumbnail is wide", asp[0] > 1.2, asp.map((a) => a.toFixed(2)).join(","));
    $('#pw [data-v="pages"]').click(); await sleep(150); await thumbsLoaded();
    const ims2 = $$("#pw .pw-page img");
    const asp2 = await Promise.all(ims2.map((im) => new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth / i.naturalHeight); i.src = im.src; })));
    ok("mixed: turned page thumbnail is wide (shown turned)", asp2[1] > 1.2, asp2.map((a) => a.toFixed(2)).join(","));
    const c = await goAndCapture(); const tx = c[0] ? await pdfTexts(await blobBytes(c[0].blob)) : [];
    ok("mixed: 5 pages out (2 + picture + 2)", tx.length === 5, tx.length);
    ok("mixed: turned page keeps its turn", tx[1] && (tx[1].rot % 180 ? tx[1].h > tx[1].w : tx[1].w > tx[1].h), JSON.stringify(tx.map((t) => [t.w, t.h, t.rot])));
    ok("mixed: picture page is landscape", tx[2] && tx[2].w > tx[2].h, JSON.stringify(tx[2]));
  }

  if (want("bad")) {
    await openFresh([A], "merge");
    const before = $$("#pw .pw-file").length;
    const junk = new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55, 10, 1, 2, 3, 4])], "broken.pdf", { type: "application/pdf" });
    await window.__cal2AddFilesToDoc([junk]); await sleep(300);
    ok("bad file: refused without breaking the workspace", $$("#pw .pw-file").length === before && $("#pw .pw-grid"), $$("#pw .pw-file").length);
    // rapid view switching while thumbnails load
    for (let k = 0; k < 20; k++) { $(`#pw [data-v="${k % 2 ? "files" : "pages"}"]`).click(); }
    await sleep(300);
    ok("rapid view switching: workspace intact", $("#pw .pw-grid") && $$("#pw .pw-item").length >= 1);
    // leaving and coming back
    pwBtn("back").click(); await sleep(200);
    ok("back: returns to all pages", !document.body.dataset.pw && getComputedStyle($("#org_grid")).display !== "none", document.body.dataset.pw);
  }

  if (want("big")) {
    const big = await file("big.pdf");
    const t0 = performance.now();
    await openFresh([big], "split");
    const tOpen = performance.now() - t0;
    ok("big: 60 pages, 59 scissors", $$("#pw .pw-page").length === 60 && $$("#pw .pw-cut").length === 59, $$("#pw .pw-page").length);
    const t1 = performance.now();
    const firstRow = await until(() => { const ims = $$("#pw .pw-card img").slice(0, 8); return ims.every((i) => (i.src.startsWith("blob:") || i.src.startsWith("data:image/jpeg"))); }, 15000);
    ok("big: first screen of thumbnails", firstRow, `open ${Math.round(tOpen)} ms, first thumbnails ${Math.round(performance.now() - t1)} ms`);
    // one click stays fast on 60 pages
    const t2 = performance.now(); $$("#pw .pw-cut")[29].click(); const tClick = performance.now() - t2;
    ok("big: a cut redraws quickly", tClick < 120, Math.round(tClick) + " ms");
    pwBtn("cutall").click(); await sleep(100);
    const t3 = performance.now(); const c = await goAndCapture(); const tSplit = performance.now() - t3;
    let n = 0; if (c[0]) n = Object.keys((await window.JSZip.loadAsync(c[0].blob)).files).length;
    ok("big: split into 60 files", n === 60, `${n} files in ${Math.round(tSplit)} ms`);
  }

  if (want("edits")) {
    // a white-out box drawn in the editor goes into split parts, and its layer has no black under clear edges
    await window.__cal2OpenDocFile(A); await sleep(400);
    let ov = null;
    for (let k = 0; k < 5 && !ov; k++) { location.hash = "#/edit/whiteout" + (k ? "?" + k : ""); ov = await until(() => document.body.classList.contains("placing") && $('#ed_pages .pg[data-page="0"] .pgov'), 3000); }
    ok("edits: editor open on whiteout", ov);
    if (ov) {
      const r = ov.getBoundingClientRect(), x0 = r.left + r.width * 0.55, y0 = r.top + r.height * 0.86, x1 = r.left + r.width * 0.83, y1 = r.top + r.height * 0.93;
      const ev = (t, x, y) => new PointerEvent(t, { clientX: x, clientY: y, bubbles: true, pointerId: 1, button: 0, buttons: t === "pointerup" ? 0 : 1, isPrimary: true });
      ov.dispatchEvent(ev("pointerdown", x0, y0));
      for (let k = 1; k <= 6; k++) { const t = k / 6, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; ov.dispatchEvent(ev("pointermove", x, y)); window.dispatchEvent(ev("pointermove", x, y)); }
      ov.dispatchEvent(ev("pointerup", x1, y1)); window.dispatchEvent(ev("pointerup", x1, y1));
      await sleep(200);
      ok("edits: white-out made", $$("#ed_pages .ditem").length >= 1, $$("#ed_pages .ditem").length);
      location.hash = "#/edit/split"; await until(() => document.body.dataset.pw === "split" && $("#pw .pw-cut"));
      $$("#pw .pw-cut")[0].click(); await sleep(100);
      const c = await goAndCapture();
      let found = 0, blackEdge = -1, imgs = 0;
      if (c[0]) {
        const zip = await window.JSZip.loadAsync(c[0].blob), n = Object.keys(zip.files).sort()[0];
        const bytes = await zip.files[n].async("uint8array"), L = window.PDFLib, d = await L.PDFDocument.load(bytes);
        const N = (x) => L.PDFName.of(x);
        const inflate = async (u8) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
        for (const [, obj] of d.context.enumerateIndirectObjects()) {
          if (!(obj instanceof L.PDFRawStream) || obj.dict.get(N("Subtype")) !== N("Image")) continue;
          const sm = obj.dict.get(N("SMask")); if (!sm) continue;
          imgs++;
          const mask = d.context.lookup(sm), w = obj.dict.get(N("Width")).asNumber(), h = obj.dict.get(N("Height")).asNumber();
          const rgb = await inflate(obj.contents), a = await inflate(mask.contents);
          if (rgb.length < w * h * 3 || a.length < w * h) continue;   // pdf-lib stores the decoded pixels: 3 bytes each, 1 for the mask
          found = 1; blackEdge = 0;
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x; if (a[i]) continue;
            const near = (x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w]);
            if (near && rgb[i * 3] + rgb[i * 3 + 1] + rgb[i * 3 + 2] < 60) blackEdge++;
          }
        }
      }
      ok("edits: part 1 carries the edit layer", found, `${imgs} layered pictures`);
      ok("print boxes: no black under clear edges of the layer", found && blackEdge === 0, blackEdge);
    }
  }

  if (want("edittext")) {
    // Edit text on a PDF whose fonts have no names ("CIDFont+F1", bold Calibri subset without a "4")
    const S = await file("sample-letter.pdf");
    await window.__cal2OpenDocFile(S); await sleep(400);
    let blk = null;
    for (let k = 0; k < 5 && !blk; k++) {
      location.hash = "#/edit/edittext" + (k ? "?" + k : "");
      blk = await until(() => $$("#ed_pages .tblock").find((t) => { const r = t.getBoundingClientRect(), pg = t.closest(".pg").getBoundingClientRect(); return Math.abs(r.width / pg.width - 0.14) < 0.03 && r.top - pg.top > pg.height * 0.22 && r.top - pg.top < pg.height * 0.27; }), 3000);
    }
    ok("edittext: found the bold date line", blk);
    if (blk) {
      const r = blk.getBoundingClientRect();
      blk.dispatchEvent(new PointerEvent("pointerdown", { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, pointerId: 1, button: 0, buttons: 1 }));
      const td = await until(() => $("#ed_pages .ditem.tbox .tbtext"), 4000);
      ok("edittext: line opens for editing", td);
      if (td) {
        ok("edittext: drawn with the PDF's own font (all-weights copy)", /_w\b|_w"|_w,/.test(td.style.fontFamily), td.style.fontFamily);
        ok("edittext: line height set from the font, not 'normal'", /px$/.test(td.style.lineHeight), td.style.lineHeight);
        ok("edittext: baseline moved onto the original (PDF says 0.75, font file 0.95)", /translateY\(-/.test(td.style.transform), td.style.transform);
        const cur = () => $("#ed_pages .ditem.tbox .tbtext");   // the line is redrawn when the match arrives
        const m = await until(() => cur() && /Carlito/.test(cur().style.fontFamily) && cur(), 45000);
        ok("edittext: missing characters matched to Carlito Bold", m && m.style.fontWeight === "700", m ? m.style.fontFamily + " / " + m.style.fontWeight : "no match in 45 s");
        await sleep(300);
        ok("edittext: spacing refitted after the match", cur() && Math.abs(parseFloat(cur().style.letterSpacing) || 0) < 0.003, cur() && cur().style.letterSpacing);
        // the box spans the original line: text width = cover width minus the two 0.08em pads
        const t2 = cur(), cv = $("#ed_pages .tcover"), rg = document.createRange(); rg.selectNodeContents(t2);
        const tr = rg.getBoundingClientRect(), cr = cv && cv.getBoundingClientRect(), fs = parseFloat(t2.style.fontSize);
        const l = cr ? tr.left - cr.left : -1, rr = cr ? cr.right - tr.right : -1;
        ok("edittext: edited line keeps the original width", cr && Math.abs(l - rr) < fs * 0.05, `left pad ${l.toFixed(1)}, right pad ${rr.toFixed(1)}`);
      }
    }
  }
  return out;
}
