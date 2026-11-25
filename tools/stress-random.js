// Randomized stress test for Merge / Split / Extract. Every round makes new documents from a seed (random page
// counts, paper sizes, landscape pages, pages already turned, pictures of random sizes), does a random series
// of actions in the real UI (reorder files, drag pages, rotate, delete, drop new files at random places, Select
// all), keeps a model of what the document should be, and checks every downloaded page against it: which
// page it is (its text, or a picture's unique size) and its shape. Then random Split cuts and a random Extract.
// The seed is printed with every result, so a failure can be replayed exactly: run({ seeds: [1234] }).
//
// To run: copy to web/_t/stress-random.js, open the app, then
//   (await import("/_t/stress-random.js")).run({ rounds: 5 }).then((r) => console.log(r.summary))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
async function until(fn, ms = 10000, step = 40) { const t = performance.now(); while (performance.now() - t < ms) { try { const v = await fn(); if (v) return v; } catch (_) {} await sleep(step); } return null; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
async function pdfLib() {
  if (!window.PDFLib) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return window.PDFLib;
}
async function zipLib() {
  if (!window.JSZip) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return window.JSZip;
}
const SIZES = [[612, 792], [595, 842], [612, 1008], [792, 612], [842, 595], [420, 595]];

// ---- documents -------------------------------------------------------------------------------------------
async function makePdf(R, id) {
  const L = await pdfLib(), d = await L.PDFDocument.create(), f = await d.embedFont(L.StandardFonts.Helvetica);
  const n = 1 + Math.floor(R() * 8), pages = [];
  for (let k = 1; k <= n; k++) {
    let [w, h] = SIZES[Math.floor(R() * SIZES.length)];
    if (R() < 0.15) { w = 300 + Math.floor(R() * 600); h = 300 + Math.floor(R() * 600); }
    const pg = d.addPage([w, h]);
    pg.drawText(`D${id}P${k}`, { x: 30, y: h - 60, size: 28, font: f });
    pg.drawRectangle({ x: 30, y: 30, width: w - 60, height: 8, color: L.rgb(R(), R(), R()) });
    const base = R() < 0.2 ? [90, 180, 270][Math.floor(R() * 3)] : 0;
    if (base) pg.setRotation(L.degrees(base));
    pages.push({ tag: `D${id}P${k}`, w, h, base });
  }
  return { file: new File([await d.save()], `doc${id}.pdf`, { type: "application/pdf" }), pages };
}
async function makePic(R, id, used) {
  let w, h;
  do { w = 2 * (150 + Math.floor(R() * 500)); h = 2 * (150 + Math.floor(R() * 500)); } while (used.has(w / 2 + "x" + h / 2));
  used.add(w / 2 + "x" + h / 2);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); g.fillStyle = `hsl(${Math.floor(R() * 360)},55%,55%)`; g.fillRect(0, 0, w, h);
  g.fillStyle = "#fff"; g.font = "bold 40px Arial"; g.fillText("PIC" + id, 30, 70);
  const jpg = R() < 0.5;
  const blob = await new Promise((r) => c.toBlob(r, jpg ? "image/jpeg" : "image/png", 0.9));
  // a picture page is the picture's size at 144 dpi (half its pixels, in points)
  return { file: new File([blob], `pic${id}.${jpg ? "jpg" : "png"}`, { type: jpg ? "image/jpeg" : "image/png" }), pages: [{ tag: `IMG${w / 2}x${h / 2}`, w: w / 2, h: h / 2, base: 0, pic: true }] };
}

// ---- reading results -------------------------------------------------------------------------------------
async function readPdf(bytes) {
  const d = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise, res = [];
  for (let i = 1; i <= d.numPages; i++) {
    const pg = await d.getPage(i), tc = await pg.getTextContent();
    const m = tc.items.map((x) => x.str).join(" ").match(/D\d+P\d+/);
    const vw = pg.view[2] - pg.view[0], vh = pg.view[3] - pg.view[1], sw = pg.rotate % 180 !== 0;
    const dw = Math.round(sw ? vh : vw), dh = Math.round(sw ? vw : vh);
    res.push({ tag: m ? m[0] : `IMG${dw}x${dh}`, dw, dh });
  }
  d.destroy();
  return res;
}
const shown = (p) => ((p.base + p.rot) % 180 ? [p.h, p.w] : [p.w, p.h]);
function compare(expect, got) {
  const errs = [];
  if (expect.length !== got.length) errs.push(`pages: expected ${expect.length}, got ${got.length}`);
  expect.forEach((p, i) => {
    const g = got[i]; if (!g) return;
    const [ew, eh] = shown(p);
    const idOk = p.pic ? Math.abs(g.dw - ew) <= 1 && Math.abs(g.dh - eh) <= 1 && /^IMG/.test(g.tag) : g.tag === p.tag;
    if (!idOk) errs.push(`page ${i + 1}: expected ${p.tag}${p.pic ? ` (${ew}x${eh})` : ""}, got ${g.tag} (${g.dw}x${g.dh})`);
    else if (Math.abs(g.dw - ew) > 1 || Math.abs(g.dh - eh) > 1) errs.push(`page ${i + 1} (${p.tag}): shape ${g.dw}x${g.dh}, expected ${ew}x${eh} (turn ${p.base}+${p.rot})`);
  });
  return errs;
}

// ---- driving the UI --------------------------------------------------------------------------------------
const pwBtn = (a) => $(`#pw [data-a="${a}"]`);
function drag(src, dst, files) {
  const dt = new DataTransfer(); (files || []).forEach((f) => dt.items.add(f));
  if (!files) src.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
  dst.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  dst.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  if (!files) src.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
}
async function view(v) { const b = $(`#pw [data-v="${v}"]`); if (b && !b.classList.contains("on")) { b.click(); await sleep(60); } }
async function capture(n = 1, ms = 30000) { window.__cal2Capture = []; pwBtn("go").click(); const c = await until(() => window.__cal2Capture.length >= n && window.__cal2Capture, ms); return c ? c.slice() : []; }
const runsOf = (model) => { const r = []; model.forEach((p, i) => { const l = r[r.length - 1]; if (l && l.src === p.src) l.idx.push(i); else r.push({ src: p.src, idx: [i] }); }); return r; };
// the UI's page order, read from the Pages view (file name tag of each card)
const uiTags = () => $$("#pw .pw-page .pw-tag").map((t) => t.textContent);

async function round(seed, log) {
  const R = rng(seed), errs = [], steps = [];
  const used = new Set();
  let nid = 0;
  const srcs = [];
  const nd = 2 + Math.floor(R() * 4);
  for (let k = 0; k < nd; k++) srcs.push(R() < 0.2 ? await makePic(R, ++nid, used) : await makePdf(R, ++nid));
  // model: one entry per page, in document order
  let model = [];
  srcs.forEach((s, si) => s.pages.forEach((p) => model.push({ ...p, rot: 0, src: "s" + si, name: s.file.name })));
  let srcSeq = srcs.length;
  await window.__cal2OpenDocFile(srcs[0].file);
  if (srcs.length > 1) await window.__cal2AddFilesToDoc(srcs.slice(1).map((s) => s.file));
  // opening a document leaves Merge / Split: wait for that, then open Merge on the new document
  await until(() => document.body.dataset.pw !== "merge" && document.body.dataset.pw !== "split", 3000);
  for (let k = 0; k < 6 && !(document.body.dataset.pw === "merge" && $$("#pw .pw-file").length); k++) { location.hash = "#/edit/merge?" + seed + "-" + k; await until(() => document.body.dataset.pw === "merge" && $("#pw .pw-grid"), 3000); }
  await view("pages");
  await until(() => $$("#pw .pw-page").length === model.length, 8000);
  if (document.body.dataset.pw !== "merge") return { seed, errs: ["merge workspace did not open"], steps };
  await sleep(150);
  const check = async (what) => {
    await view("pages");
    // a file dropped in the Files view may still be loading: give the pages up to 8 s to arrive (a drop that was
    // lost still fails)
    await until(() => $$("#pw .pw-page").length === model.length, 8000);
    const ui = uiTags(), want = model.map((p) => p.name);
    if (ui.join("|") !== want.join("|")) errs.push(`after ${what}: screen shows ${ui.length} pages [${ui.join(",")}], expected ${want.length} [${want.join(",")}]`);
  };
  await check("opening");
  const nops = 6 + Math.floor(R() * 9);
  for (let o = 0; o < nops; o++) {
    const kind = ["moveFile", "movePage", "rotate", "rotate", "delete", "addFile", "selectAllRotate"][Math.floor(R() * 7)];
    if (kind === "moveFile") {
      await view("files");
      const runs = runsOf(model); if (runs.length < 2) continue;
      const from = Math.floor(R() * runs.length); let to = Math.floor(R() * (runs.length + 1));
      const cards = $$("#pw .pw-file");
      if (to === from || to === from + 1) continue;
      if (to === runs.length) drag(cards[from], $("#pw .pw-addtile")); else drag(cards[from], cards[to]);
      const order = [];
      runs.forEach((r, k) => { if (k === to) order.push(...runs[from].idx); if (k !== from) order.push(...r.idx); });
      if (to >= runs.length) order.push(...runs[from].idx);
      model = order.map((i) => model[i]);
      steps.push(`move file ${from + 1} before ${to + 1}`);
    } else if (kind === "movePage") {
      await view("pages");
      if (model.length < 2) continue;
      const from = Math.floor(R() * model.length), to = Math.floor(R() * model.length); if (from === to) continue;
      const cards = $$("#pw .pw-page"); drag(cards[from], cards[to]);
      const [m] = model.splice(from, 1); model.splice(to, 0, m);
      steps.push(`move page ${from + 1} to ${to + 1}`);
    } else if (kind === "rotate" || kind === "delete") {
      await view("pages");
      const pick = model.map((_, i) => i).filter(() => R() < 0.35);
      if (!pick.length) pick.push(Math.floor(R() * model.length));
      if (kind === "delete" && pick.length >= model.length) pick.pop();
      if (!pick.length) continue;
      for (const i of pick) { $$("#pw .pw-page")[i].click(); await sleep(15); }
      if (kind === "rotate") {
        const dir = R() < 0.5 ? -1 : 1; pwBtn(dir < 0 ? "rotl" : "rotr").click(); await sleep(80);
        pick.forEach((i) => { model[i].rot = (model[i].rot + (dir > 0 ? 90 : 270)) % 360; });
        // untick again
        for (const i of pick) { $$("#pw .pw-page")[i].click(); await sleep(15); }
        steps.push(`rotate ${dir > 0 ? "right" : "left"} pages ${pick.map((i) => i + 1).join(",")}`);
      } else {
        pwBtn("del").click(); await sleep(120);
        const kill = new Set(pick); model = model.filter((_, i) => !kill.has(i));
        steps.push(`delete pages ${pick.map((i) => i + 1).join(",")}`);
      }
    } else if (kind === "selectAllRotate") {
      await view("pages");
      $("#pw .pw-all").click(); await sleep(40);
      const dir = R() < 0.5 ? -1 : 1; pwBtn(dir < 0 ? "rotl" : "rotr").click(); await sleep(100);
      model.forEach((p) => { p.rot = (p.rot + (dir > 0 ? 90 : 270)) % 360; });
      $("#pw .pw-all").click(); await sleep(40);
      steps.push(`select all, rotate ${dir > 0 ? "right" : "left"}`);
    } else if (kind === "addFile") {
      const s = R() < 0.25 ? await makePic(R, ++nid, used) : await makePdf(R, ++nid);
      const inFiles = R() < 0.5;
      await view(inFiles ? "files" : "pages");
      const targets = inFiles ? $$("#pw .pw-file") : $$("#pw .pw-page");
      const ti = Math.floor(R() * (targets.length + 1));
      let at;
      if (ti === targets.length) { drag(null, $("#pw .pw-addtile"), [s.file]); at = model.length; }
      else { drag(null, targets[ti], [s.file]); at = inFiles ? runsOf(model)[ti].idx[0] : ti; }
      const sid = "s" + (srcSeq++), before = model.length, add = s.pages.map((p) => ({ ...p, rot: 0, src: sid, name: s.file.name }));
      model.splice(at, 0, ...add);
      await until(() => $$("#pw .pw-page, #pw .pw-file").length && (inFiles ? true : $$("#pw .pw-page").length === before + add.length), 8000);
      await sleep(250);
      steps.push(`drop ${s.file.name} (${add.length} page${add.length > 1 ? "s" : ""}) at ${at + 1} in ${inFiles ? "Files" : "Pages"}`);
    }
    await check(steps[steps.length - 1] || kind);
    if (errs.length) break;
  }
  // the merged download
  if (!errs.length) {
    const c = await capture();
    if (!c[0]) errs.push("merge: nothing was downloaded");
    else compare(model, await readPdf(new Uint8Array(await c[0].blob.arrayBuffer()))).forEach((e) => errs.push("merged PDF " + e));
  }
  // split at random places
  if (!errs.length) {
    location.hash = "#/edit/split?" + seed;
    await until(() => document.body.dataset.pw === "split" && $("#pw .pw-grid"), 5000);
    pwBtn("clearcuts") && pwBtn("clearcuts").click(); await sleep(60);
    if (model.length > 1) {
      const cutsAfter = model.map((_, i) => i).slice(0, -1).filter(() => R() < 0.4);
      if (!cutsAfter.length) cutsAfter.push(Math.floor(R() * (model.length - 1)));
      for (const i of cutsAfter) { const b = $$("#pw .pw-cut").find((x) => x.dataset.after === docKeyAt(i)); if (b) { b.click(); await sleep(30); } }
      const parts = []; let cur = [];
      model.forEach((p, i) => { cur.push(p); if (cutsAfter.includes(i)) { parts.push(cur); cur = []; } }); if (cur.length) parts.push(cur);
      const shownParts = $$("#pw .pw-group").length;
      if (shownParts !== parts.length) errs.push(`split: screen shows ${shownParts} parts, expected ${parts.length}`);
      const c = await capture();
      if (!c[0]) errs.push("split: nothing was downloaded");
      else {
        const Z = await zipLib(), zip = await Z.loadAsync(c[0].blob), names = Object.keys(zip.files).sort((a, b) => +a.match(/part(\d+)/)[1] - +b.match(/part(\d+)/)[1]);
        if (names.length !== parts.length) errs.push(`split: ${names.length} files, expected ${parts.length}`);
        for (let k = 0; k < Math.min(names.length, parts.length); k++) compare(parts[k], await readPdf(await zip.files[names[k]].async("uint8array"))).forEach((e) => errs.push(`split part ${k + 1} ${e}`));
      }
      steps.push(`split after pages ${cutsAfter.map((i) => i + 1).join(",")} (${parts.length} files)`);
    }
  }
  // extract a random set
  if (!errs.length) {
    $('#pw [data-s="extract"]').click(); await sleep(80);
    const pick = model.map((_, i) => i).filter(() => R() < 0.4); if (!pick.length) pick.push(0);
    for (const i of pick) { $$("#pw .pw-page")[i].click(); await sleep(15); }
    const c = await capture();
    if (!c[0]) errs.push("extract: nothing was downloaded");
    else compare(pick.map((i) => model[i]), await readPdf(new Uint8Array(await c[0].blob.arrayBuffer()))).forEach((e) => errs.push("extract " + e));
    steps.push(`extract pages ${pick.map((i) => i + 1).join(",")}`);
  }
  log && log(seed, errs, steps);
  return { seed, errs, steps, pages: model.length, files: nid };
}
// the page key the scissors after page i belong to: read from the Split view's i-th card
function docKeyAt(i) { const cards = $$("#pw .pw-page"); const c = cards[i]; if (!c) return ""; const im = c.querySelector("img[data-pk]"); return im ? im.dataset.pk : ""; }

export async function run({ rounds = 4, seeds } = {}) {
  const list = seeds || Array.from({ length: rounds }, () => (Math.random() * 2 ** 31) >>> 0);
  const results = [];
  window.__cal2Capture = [];
  for (const s of list) {
    try { results.push(await round(s)); }
    catch (e) { results.push({ seed: s, errs: ["crashed: " + (e.stack || e)], steps: [] }); }
  }
  const failed = results.filter((r) => r.errs.length);
  results.summary = `${results.length - failed.length}/${results.length} random rounds passed` + (failed.length ? "\n" + failed.map((r) => `seed ${r.seed}: ${r.errs.slice(0, 3).join(" | ")}\n  steps: ${r.steps.join("; ")}`).join("\n") : "");
  return results;
}
