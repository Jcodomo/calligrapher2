// Font recognition on scan-like lines (sample data only), run in the app page as an async function body: system fonts
// drawn, blurred and speckled, matched with window.__cal2IdentifyFont; family and slant counted per font.
// Font recognition on scan-like lines: system fonts drawn, blurred and speckled, then matched.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80 && !window.__cal2IdentifyFont; i++) await sleep(250);
const CASES = [["Times New Roman", "Tinos", "normal"], ["Arial", "Arimo", "normal"], ["Calibri", "Carlito", "normal"], ["Courier New", "Cousine", "normal"], ["Cambria", "Caladea", "normal"],
  ["Times New Roman", "Tinos", "italic"], ["Arial", "Arimo", "italic"], ["Georgia", null, "normal"], ["Verdana", null, "normal"]];
const LINES = ["Beneficiary Bank ABA Number", "011000015", "FIRST SAMPLE BANK", "Wire Amount", "$125,000.00", "100 MAIN STREET", "Effective Date 01/15/2026", "Special Instructions"];
let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const res = [], tally = {};
for (const [sys, want, style] of CASES) for (const text of LINES) for (const px of [22, 34]) {
  const font = `${style} 400 ${px}px "${sys}"`;
  const c = document.createElement("canvas"), g = c.getContext("2d"); g.font = font;
  c.width = Math.ceil(g.measureText(text).width + px * 2); c.height = Math.ceil(px * 2.2);
  g.fillStyle = "#fbfaf6"; g.fillRect(0, 0, c.width, c.height); g.filter = "blur(0.7px)"; g.font = font; g.fillStyle = "#1a1a1a"; g.fillText(text, px, px * 1.45); g.filter = "none";
  const d = g.getImageData(0, 0, c.width, c.height); for (let k = 0; k < d.data.length; k += 4) { const n = (rnd() - 0.5) * 18; d.data[k] += n; d.data[k + 1] += n; d.data[k + 2] += n; } g.putImageData(d, 0, 0);
  const list = await window.__cal2IdentifyFont(c, text), b = list[0];
  const okFam = want ? b && b.family === want : true, okStyle = b && b.style === style;
  const key = `${sys} ${style}`; tally[key] = tally[key] || { n: 0, fam: 0, style: 0, got: {} };
  tally[key].n++; if (okFam) tally[key].fam++; if (okStyle) tally[key].style++; const gk = b ? b.family + (b.style === "italic" ? " It" : "") : "-"; tally[key].got[gk] = (tally[key].got[gk] || 0) + 1;
  res.push(okFam && okStyle);
}
return { pass: res.filter(Boolean).length, total: res.length, tally: Object.fromEntries(Object.entries(tally).map(([k, v]) => [k, `${v.fam}/${v.n} family, ${v.style}/${v.n} slant; got ${Object.entries(v.got).map(([a, b]) => a + " x" + b).join(", ")}`])) };
