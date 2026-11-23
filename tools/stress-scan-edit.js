// Stress test for Edit text on scanned forms (sample data only). Run in the app page as an async function body after
// setting window.__FONT / __WANT / __ITAL, and optionally __FONT2 / __WANT2 for labels and values in two fonts.
// A form is drawn, blurred and speckled, opened, read with OCR and every box clicked: rows must split into label and
// value, a click must leave the page untouched, and each box's matched font is counted against the font drawn.
// Edit text on a scanned form set in one font (window.__FONT): every label and value box clicked in turn.
// Checks: rows split into label + value, a click leaves the page untouched, typing covers only that box, and the
// matched font is the right one (family and slant) - per box, with the page's own fonts learned in the background.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FONT = window.__FONT || "Times New Roman", WANT = window.__WANT, ITAL = !!window.__ITAL;
for (let i = 0; i < 80 && !window.__cal2OpenDocFile; i++) await sleep(250);
const ROWS = [["Wire ID", "US000000000001"], ["Wire Type", "Domestic"], ["Customer Name", "JANE SAMPLE"], ["Phone Number", "(555) 010-0199"], ["Wire Amount", "$125,000.00"],
  ["Effective Date", "01/15/2026"], ["Beneficiary Name", "SAMPLE TITLE COMPANY LLC"], ["Beneficiary Bank ABA Number", "011000015"], ["Beneficiary Bank Name", "FIRST SAMPLE BANK"],
  ["Beneficiary Bank Account Number", "0000-123456"], ["Special Instructions", "ESCROW ACCOUNT"]];
const c = document.createElement("canvas"); c.width = 1700; c.height = 2200; const g = c.getContext("2d");
g.fillStyle = "#fdfcf8"; g.fillRect(0, 0, c.width, c.height); g.filter = "blur(0.6px)"; g.fillStyle = "#151515"; g.font = `${ITAL ? "italic " : ""}30px "${FONT}"`;
const F1 = g.font, F2 = window.__FONT2 ? `30px "${window.__FONT2}"` : F1;
ROWS.forEach(([a, b], i) => { const y = 160 + i * 110; g.font = F1; g.fillText(a, 300, y); g.font = F2; g.fillText(b, 1000, y); });
g.filter = "none";
const id = g.getImageData(0, 0, c.width, c.height); let sd = 3; for (let k = 0; k < id.data.length; k += 4) { sd = (sd * 1103515245 + 12345) % 2147483648; const nz = (sd / 2147483648 - 0.5) * 16; id.data[k] += nz; id.data[k + 1] += nz; id.data[k + 2] += nz; } g.putImageData(id, 0, 0);
const blob = await new Promise((r) => c.toBlob(r, "image/png"));
await window.__cal2OpenDocFile(new File([blob], "scan-" + FONT + ".png", { type: "image/png" }));
location.hash = "#/edit"; await sleep(2500);
window.__cal2SetDocTool("edittext");
let blocks = [];
for (let i = 0; i < 240; i++) { await sleep(500); blocks = [...document.querySelectorAll("#ed_pages .tblock")]; if (blocks.length >= ROWS.length) break; }
const out = { font: FONT + (ITAL ? " italic" : ""), blocks: blocks.length };
const rects = blocks.map((b) => b.getBoundingClientRect());
const rows = []; rects.forEach((r, k) => { const cy = r.top + r.height / 2; const row = rows.find((x) => Math.abs(x.cy - cy) < r.height * 0.6); if (row) row.k.push(k); else rows.push({ cy, k: [k] }); });
out.split = rows.filter((x) => x.k.length === 2).length + "/" + ROWS.length;
const t0 = performance.now(); let prof = null;
if (window.__cal2PageFonts && !window.__NOPRIOR) { const pp = window.__cal2PageFonts(0); if (pp) prof = await pp; }
out.pageFonts = prof ? prof.top.map((t) => `${t.family}${t.style === "italic" ? " It" : ""} ${Math.round(t.share * 100)}%`).join(", ") : null;
out.profileMs = Math.round(performance.now() - t0);
let right = 0, slantRight = 0, n = 0, pristine = 0, got = {};
const centres = rects.map((r) => [r.left + r.width / 2, r.top + r.height / 2]);
for (const [x, y] of centres) {
  const el = document.elementsFromPoint(x, y).find((e) => e.classList && e.classList.contains("tblock")); if (!el) continue;
  const before = new Set([...document.querySelectorAll("#ed_pages .ditem.tbox")].map((e) => e.dataset.id));
  el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1, isPrimary: true, pointerType: "mouse" }));
  let item = null; for (let i = 0; i < 160 && !item; i++) { await sleep(150); item = [...document.querySelectorAll("#ed_pages .ditem.tbox")].find((e) => !before.has(e.dataset.id)); }
  if (!item) continue;
  await sleep(250); n++;
  if (item.classList.contains("pristine") && !document.querySelector(`#ed_pages .tcover[data-for="${item.dataset.id}"]`)) pristine++;
  const td = item.querySelector(".tbtext"), fam = (td.style.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(), it = td.style.fontStyle === "italic";
  got[fam + (it ? " It" : "")] = (got[fam + (it ? " It" : "")] || 0) + 1;
  const want = window.__WANT2 && x > innerWidth * 0.5 ? window.__WANT2 : WANT; if (!want || fam === want) right++; if (it === ITAL) slantRight++;
  td.blur(); await sleep(150); if (document.body.dataset.tool !== "edittext") { window.__cal2SetDocTool("edittext"); await sleep(400); }
}
out.boxes = n; out.untouchedOnClick = pristine + "/" + n; out.family = right + "/" + n; out.slant = slantRight + "/" + n;
out.got = Object.entries(got).map(([k, v]) => k + " x" + v).join(", ");
return out;
