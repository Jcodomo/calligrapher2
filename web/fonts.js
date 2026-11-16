// fonts.js — a large font library, downloaded on demand from Google Fonts, plus a
// matcher that maps the font names found in PDFs to the closest available family.
// Metric-compatible stand-ins keep text the same width as the original:
// Arimo = Arial/Helvetica, Tinos = Times New Roman, Cousine = Courier New,
// Carlito = Calibri, Caladea = Cambria, Gelasio = Georgia.

// axes: "full" = regular/bold + italics, "rb" = regular + bold, "r" = one weight,
// "rbi" = regular, bold, italic (no bold italic).
const AX = {
  full: "ital,wght@0,400;0,700;1,400;1,700",
  rb: "wght@400;700",
  r: "",
  rbi: "ital,wght@0,400;0,700;1,400",
};
// [family, category, axes, extra fallback]
const LIB = [
  // metric-compatible office stand-ins
  ["Arimo", "Sans", "full", "Arial, Helvetica"], ["Carlito", "Sans", "full", "Calibri"], ["Tinos", "Serif", "full", "'Times New Roman', Times"],
  ["Caladea", "Serif", "full", "Cambria"], ["Gelasio", "Serif", "full", "Georgia"], ["Cousine", "Mono", "full", "'Courier New', Courier"],
  // sans
  ["Open Sans", "Sans", "full"], ["Roboto", "Sans", "full"], ["Lato", "Sans", "full"], ["Montserrat", "Sans", "full"], ["Source Sans 3", "Sans", "full"],
  ["Noto Sans", "Sans", "full"], ["Inter", "Sans", "rb"], ["Poppins", "Sans", "full"], ["Raleway", "Sans", "full"], ["Nunito", "Sans", "full"],
  ["Work Sans", "Sans", "full"], ["Fira Sans", "Sans", "full"], ["PT Sans", "Sans", "full"], ["Ubuntu", "Sans", "full"], ["IBM Plex Sans", "Sans", "full"],
  ["Roboto Condensed", "Sans", "full"], ["Mulish", "Sans", "full"], ["Rubik", "Sans", "full"], ["Karla", "Sans", "full"], ["Libre Franklin", "Sans", "full"],
  ["Hind", "Sans", "rb"], ["Barlow", "Sans", "full"], ["Jost", "Sans", "full"], ["Questrial", "Sans", "r"], ["Josefin Sans", "Sans", "full"],
  ["Cabin", "Sans", "full"], ["Archivo", "Sans", "full"], ["DM Sans", "Sans", "full"], ["Manrope", "Sans", "rb"], ["Quicksand", "Sans", "rb"],
  ["Titillium Web", "Sans", "full"], ["Exo 2", "Sans", "full"], ["Assistant", "Sans", "rb"], ["Heebo", "Sans", "rb"], ["Oswald", "Sans", "rb"],
  ["Varela Round", "Sans", "r"], ["Arial", "Sans", "sys", "Arimo, Helvetica"], ["Verdana", "Sans", "sys", "'Noto Sans'"], ["Segoe UI", "Sans", "sys", "'Open Sans'"],
  // serif
  ["EB Garamond", "Serif", "full"], ["Merriweather", "Serif", "full"], ["Playfair Display", "Serif", "full"], ["Libre Baskerville", "Serif", "rbi"],
  ["Lora", "Serif", "full"], ["PT Serif", "Serif", "full"], ["Noto Serif", "Serif", "full"], ["Source Serif 4", "Serif", "full"], ["Crimson Text", "Serif", "full"],
  ["Crimson Pro", "Serif", "full"], ["Cormorant Garamond", "Serif", "full"], ["Spectral", "Serif", "full"], ["Domine", "Serif", "rb"], ["Bitter", "Serif", "full"],
  ["Roboto Slab", "Serif", "rb"], ["Zilla Slab", "Serif", "full"], ["IBM Plex Serif", "Serif", "full"], ["Old Standard TT", "Serif", "rbi"], ["Cardo", "Serif", "rbi"],
  ["Libre Caslon Text", "Serif", "rbi"], ["Times New Roman", "Serif", "sys", "Tinos, Times"], ["Georgia", "Serif", "sys", "Gelasio"],
  // monospace
  ["Roboto Mono", "Mono", "full"], ["Source Code Pro", "Mono", "full"], ["IBM Plex Mono", "Mono", "full"], ["Courier Prime", "Mono", "full"],
  ["Inconsolata", "Mono", "rb"], ["JetBrains Mono", "Mono", "full"], ["Courier New", "Mono", "sys", "Cousine, Courier"],
  // display
  ["Bebas Neue", "Display", "r"], ["Abril Fatface", "Display", "r"], ["Lobster", "Display", "r"], ["Pacifico", "Display", "r"], ["Alfa Slab One", "Display", "r"],
  // handwriting & script
  ["Dancing Script", "Handwriting", "rb"], ["Great Vibes", "Handwriting", "r"], ["Caveat", "Handwriting", "rb"], ["Homemade Apple", "Handwriting", "r"],
  ["Satisfy", "Handwriting", "r"], ["Sacramento", "Handwriting", "r"], ["Allura", "Handwriting", "r"], ["Kaushan Script", "Handwriting", "r"],
  ["Shadows Into Light", "Handwriting", "r"], ["Indie Flower", "Handwriting", "r"], ["Patrick Hand", "Handwriting", "r"], ["Kalam", "Handwriting", "rb"],
  ["Gloria Hallelujah", "Handwriting", "r"], ["Permanent Marker", "Handwriting", "r"], ["Nothing You Could Do", "Handwriting", "r"], ["Reenie Beanie", "Handwriting", "r"],
  ["Mr Dafoe", "Handwriting", "r"], ["Herr Von Muellerhoff", "Handwriting", "r"], ["Alex Brush", "Handwriting", "r"], ["Parisienne", "Handwriting", "r"],
  ["Yellowtail", "Handwriting", "r"], ["La Belle Aurore", "Handwriting", "r"], ["Cedarville Cursive", "Handwriting", "r"], ["Rock Salt", "Handwriting", "r"],
  ["Covered By Your Grace", "Handwriting", "r"],
];
const GENERIC = { Sans: "sans-serif", Serif: "serif", Mono: "monospace", Display: "sans-serif", Handwriting: "cursive" };
export const FONT_LIB = LIB.map(([name, cat, axes, extra]) => ({
  name, cat, axes, google: axes !== "sys",
  css: `"${name}"${extra ? ", " + extra : ""}, ${GENERIC[cat]}`,
}));
export const FONT_CATS = ["Your PDFs", "Sans", "Serif", "Mono", "Display", "Handwriting"];
const byName = new Map(FONT_LIB.map((f) => [f.name.toLowerCase(), f]));
export const fontEntry = (name) => byName.get(String(name || "").toLowerCase()) || null;

// ---- fonts saved from the user's PDFs ---------------------------------------------
// An embedded PDF font keeps only the glyphs that PDF used, stored under private
// code points, so each saved font carries its character map (text -> glyph) and a
// look-alike library font for any character it does not have.
// entry: { id, name, family (FontFace name or null), map, inv, fallbackCss, glyphs }
export function addUserFont(u) {
  removeUserFont(u.name);
  const e = { name: u.name, cat: "Your PDFs", axes: "sys", google: false, user: true, id: u.id, family: u.family, map: u.map || {}, inv: u.inv || {}, glyphs: u.glyphs || 0, fallbackCss: u.fallbackCss, as: u.as || null,
    css: (u.family ? `"${u.family}", ` : "") + u.fallbackCss };
  FONT_LIB.unshift(e); byName.set(e.name.toLowerCase(), e);
  return e;
}
export function removeUserFont(name) {
  const k = String(name || "").toLowerCase(), e = byName.get(k);
  if (!e || !e.user) return;
  byName.delete(k); const i = FONT_LIB.indexOf(e); if (i >= 0) FONT_LIB.splice(i, 1);
}

// ---- loading ------------------------------------------------------------------
const loading = new Map();
function addSheet(href) {
  return new Promise((res) => {
    const l = document.createElement("link");
    l.rel = "stylesheet"; l.href = href;
    l.onload = () => res(true); l.onerror = () => { l.remove(); res(false); };
    document.head.appendChild(l);
  });
}
// Download a family (its CSS once; the font files are fetched as text uses them).
export function ensureFont(name) {
  const f = fontEntry(name);
  if (!f || !f.google) return Promise.resolve(false);
  if (loading.has(f.name)) return loading.get(f.name);
  const fam = f.name.replace(/ /g, "+");
  const spec = AX[f.axes];
  const p = (async () => {
    let ok = await addSheet(`https://fonts.googleapis.com/css2?family=${fam}${spec ? ":" + spec : ""}&display=swap`);
    if (!ok && spec) ok = await addSheet(`https://fonts.googleapis.com/css2?family=${fam}&display=swap`);
    if (ok) { try { await Promise.all([document.fonts.load(`16px "${f.name}"`), document.fonts.load(`bold 16px "${f.name}"`)]); } catch (_) {} }
    return ok;
  })();
  loading.set(f.name, p);
  return p;
}
// Make sure every family named in a CSS font-family list is downloaded and ready.
export async function ensureFontsIn(cssList) {
  const names = String(cssList || "").split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  await Promise.all(names.map((n) => ensureFont(n)));
}

// ---- matching the fonts found in PDFs ------------------------------------------
// PDF font names look like "ABCDEF+Calibri-Bold", "TimesNewRomanPS-ItalicMT", "Helvetica".
const MAP = [
  [/helvetica ?neue|neue ?haas|^inter/i, "Inter"],
  [/arial|helvetica|liberation ?sans|arimo|nimbus ?sans|swiss/i, "Arimo"],
  [/times|liberation ?serif|tinos|nimbus ?rom|roman ?(std|pro)?$/i, "Tinos"],
  [/courier|liberation ?mono|cousine|nimbus ?mono/i, "Cousine"],
  [/calibri|carlito/i, "Carlito"], [/cambria|caladea/i, "Caladea"], [/georgia|gelasio/i, "Gelasio"],
  [/eb ?garamond|garamond/i, "EB Garamond"], [/segoe/i, "Open Sans"], [/verdana|dejavu ?sans(?! ?mono)|tahoma|lucida ?(sans|grande)/i, "Noto Sans"],
  [/trebuchet/i, "Fira Sans"], [/century ?gothic|avant ?garde|questrial/i, "Questrial"], [/futura|jost/i, "Jost"], [/gill ?sans/i, "Lato"],
  [/myriad|source ?sans/i, "Source Sans 3"], [/frutiger|univers|hind/i, "Hind"], [/palatino|book ?antiqua|palladio|pagella/i, "Crimson Text"],
  [/baskerville/i, "Libre Baskerville"], [/caslon/i, "Libre Caslon Text"], [/bodoni|didot|playfair/i, "Playfair Display"],
  [/franklin/i, "Libre Franklin"], [/minion|crimson/i, "Crimson Pro"], [/bookman|bitter/i, "Bitter"], [/century ?schoolbook|new ?century|old ?standard/i, "Old Standard TT"],
  [/consolas|menlo|monaco|dejavu ?sans ?mono|roboto ?mono/i, "Roboto Mono"], [/lucida ?console/i, "Cousine"], [/source ?serif/i, "Source Serif 4"],
  [/source ?code/i, "Source Code Pro"], [/franklin ?gothic/i, "Libre Franklin"], [/rockwell|zilla/i, "Zilla Slab"],
  [/brush ?script|edwardian|vivaldi|kunstler/i, "Great Vibes"], [/segoe ?script|lucida ?handwriting/i, "Dancing Script"], [/comic/i, "Patrick Hand"],
];
// Returns { family, css, weight, style } for a raw PDF font name.
export function matchPdfFont(rawName, { serif = false, mono = false } = {}) {
  const raw = String(rawName || "").replace(/^[A-Z]{6}\+/, "");
  const bold = /bold|black|heavy|semibold|demi|,b\b/i.test(raw), italic = /italic|oblique|,i\b|-it\b/i.test(raw);
  const base = raw.replace(/[-,](bold|italic|oblique|regular|roman|medium|light|semibold|black|heavy|bd|it|bi|mt|ps)+.*$/i, "").replace(/(PSMT|MT|PS|Std|Pro)$/i, "");
  const spaced = base.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  let family = null;
  const direct = fontEntry(spaced) || fontEntry(base);
  if (direct && direct.google) family = direct.name;
  if (!family) for (const [re, fam] of MAP) if (re.test(raw)) { family = fam; break; }
  if (!family) family = mono ? "Cousine" : serif ? "Tinos" : "Arimo";
  const f = fontEntry(family);
  const generic = mono ? "monospace" : serif || (f && f.cat === "Serif") ? "serif" : "sans-serif";
  const own = spaced && spaced.toLowerCase() !== family.toLowerCase() ? `"${spaced}", ` : "";
  return { family, css: `${own}"${family}", ${generic}`, weight: bold ? 700 : 400, style: italic ? "italic" : "normal" };
}
