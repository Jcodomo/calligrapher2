// OCR slam for Ghost Calligrapher's scanned-page reading (window.__cal2PageTools.recognize, the editor's "edit text on a scan"
// path, which also feeds the searchable-PDF OCR its cleaned page). Pages with known text - letters, invoices with amounts, a dark
// screenshot - are drawn as printed, scanned, photographed, unevenly lit and dark-mode images; each is read twice: by the app's
// reader (contrast clean-up + figure fixes) and by plain Tesseract with the same model, and words and figures are scored.
// To run: copy this file to web/_t/stress-ocr.js (web/_t is not committed), open the app and run
//   (await import("/_t/stress-ocr.js")).run({ n: 4 }).then(console.log)
let seed = 4242; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FONTS = ["Arial", "Times New Roman", "Courier New", "Verdana", "Georgia"];
const money = () => "$" + (Math.round(rnd() * 9e6) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
function doc(kind) {
  if (kind === "invoice") {
    const rows = Array.from({ length: 8 }, (_, i) => `${pick(["Consulting services", "Materials and supplies", "Freight and delivery", "Annual maintenance", "Software license", "Site inspection"])} ${i + 1}   ${money()}`);
    return ["INVOICE 2026-" + Math.floor(1000 + rnd() * 9000), "Bill to: Riverside Dental Group, 410 Market Street", "Date: 11/" + (10 + Math.floor(rnd() * 18)) + "/2026   Terms: Net 30", ""].concat(rows, ["", "Subtotal   " + money(), "Tax   " + money(), "Total due   " + money()]);
  }
  return ["Dear Ms. Alvarez,", "", "Thank you for your payment of " + money() + " received on October 14, 2026.", "Your remaining balance is " + money() + " and the next installment", "of " + money() + " is due on December 1, 2026. Please keep this letter", "for your records. If you have questions, call our office between", "nine and five on weekdays.", "", "Sincerely,", "Account Services"];
}
const LOOK = {
  print: () => ({ font: pick(FONTS), size: 26 + Math.floor(rnd() * 5), tilt: 0, blur: 0, specks: 0, paper: "#ffffff", ink: "#1a1a1a", jpeg: 0 }),
  scan: () => ({ font: pick(FONTS), size: 23 + Math.floor(rnd() * 5), tilt: (rnd() - 0.5) * 1.6, blur: 0.4, specks: 250, paper: "#ecebe6", ink: "#1a1a1a", jpeg: 0.7 }),
  photo: () => ({ font: pick(FONTS), size: 22 + Math.floor(rnd() * 4), tilt: (rnd() - 0.5) * 3, blur: 0.9, specks: 600, paper: "#d9d6cf", ink: "#2a2a2a", jpeg: 0.5 }),
  shadow: () => ({ font: pick(FONTS), size: 23 + Math.floor(rnd() * 4), tilt: (rnd() - 0.5) * 2, blur: 0.6, specks: 300, paper: "#cfcac0", ink: "#333", jpeg: 0.6, shade: true }),
  dark: () => ({ font: pick(["Arial", "Verdana"]), size: 22 + Math.floor(rnd() * 4), tilt: 0, blur: 0, specks: 0, paper: "#0f1b2d", ink: "#c9d6e8", jpeg: 0.8 }),
};
async function page(lines, look) {
  const lh = Math.round(look.size * 1.6), c = document.createElement("canvas"); c.width = 1700; c.height = 160 + lines.length * lh; const g = c.getContext("2d");
  g.fillStyle = look.paper; g.fillRect(0, 0, c.width, c.height);
  if (look.shade) { const gr = g.createLinearGradient(0, 0, c.width, c.height); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,0.45)"); g.fillStyle = gr; g.fillRect(0, 0, c.width, c.height); }
  g.save(); g.translate(c.width / 2, c.height / 2); g.rotate(look.tilt * Math.PI / 180); g.translate(-c.width / 2, -c.height / 2);
  if (look.blur) g.filter = `blur(${look.blur}px)`;
  g.fillStyle = look.ink; g.font = `${look.size}px "${look.font}"`; lines.forEach((l, i) => g.fillText(l, 70, 100 + i * lh)); g.restore();
  for (let k = 0; k < look.specks; k++) { g.fillStyle = `rgba(0,0,0,${0.2 + rnd() * 0.5})`; g.fillRect(rnd() * c.width, rnd() * c.height, 1 + rnd() * 2, 1 + rnd() * 2); }
  if (!look.jpeg) return c;
  const img = new Image(); img.src = c.toDataURL("image/jpeg", look.jpeg); await img.decode();
  const d = document.createElement("canvas"); d.width = c.width; d.height = c.height; d.getContext("2d").drawImage(img, 0, 0); return d;
}
const toks = (s) => String(s).toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9$.,/-]/g, "")).filter(Boolean);
const figs = (s) => String(s).match(/\$\d{1,3}(?:,\d{3})*\.\d{2}/g) || [];
function score(want, got) {
  const W = toks(want), G = new Map(); toks(got).forEach((w) => G.set(w, (G.get(w) || 0) + 1));
  let hit = 0; for (const w of W) { const k = G.get(w) || 0; if (k) { hit++; G.set(w, k - 1); } }
  const F = figs(want), FG = figs(got); let fh = 0; const left = FG.slice(); for (const f of F) { const i = left.indexOf(f); if (i >= 0) { fh++; left.splice(i, 1); } }
  return { words: W.length, wordsOk: hit, figures: F.length, figuresOk: fh, figuresWrong: left.length };
}
function linesOf(data) { const out = []; for (const bl of data.blocks || []) for (const par of bl.paragraphs || []) for (const ln of par.lines || []) out.push((ln.words || []).map((w) => w.text).join(" ")); return out.join("\n"); }
export async function run({ n = 4, looks = Object.keys(LOOK) } = {}) {
  const T = window.__cal2PageTools; if (!T || !T.recognize) throw new Error("Open the app first (the PDF tools must be loaded).");
  await T.recognize(document.createElement("canvas")).catch(() => {});   // loads tesseract.js
  const plain = await window.Tesseract.createWorker("eng", 1, { langPath: "https://tessdata.projectnaptha.com/4.0.0_fast", cacheMethod: "write" });
  const res = { app: {}, plain: {} };
  const add = (who, lk, s) => { const r = res[who][lk] || (res[who][lk] = { pages: 0, words: 0, wordsOk: 0, figures: 0, figuresOk: 0, figuresWrong: 0 }); r.pages++; for (const k in s) r[k] += s[k]; };
  for (const lk of looks) for (let i = 0; i < n; i++) {
    const lines = doc(i % 2 ? "letter" : "invoice"), want = lines.join("\n"), c = await page(lines, LOOK[lk]());
    const a = await T.recognize(c); add("app", lk, score(want, T.fixNumbers ? T.fixNumbers(linesOf(a)) : linesOf(a)));
    const b = await plain.recognize(c, {}, { text: true, blocks: true }); add("plain", lk, score(want, linesOf(b.data)));
  }
  await plain.terminate();
  const pct = (r) => ({ words: (100 * r.wordsOk / r.words).toFixed(1) + "%", figures: `${r.figuresOk}/${r.figures}`, figuresWrong: r.figuresWrong });
  return Object.fromEntries(looks.map((lk) => [lk, { app: pct(res.app[lk]), plain: pct(res.plain[lk]) }]));
}
