// Ghost Calligrapher - open (almost) any file.
// A dropped file is read in the browser; what can be read becomes a PDF or a picture, then the user picks:
// open it in the editor, or save it as a PDF, a picture or a Word document. Anything that can't be read gets
// a plain explanation. Nothing is uploaded.
import { pdfjsReady, pdfLibReady } from "./libs.js?v=2";

const $ = (id) => document.getElementById(id);
const ext = (f) => ((f.name || "").match(/\.([a-z0-9]+)$/i) || [, ""])[1].toLowerCase();
const base = (f) => (f.name || "file").replace(/\.[^.]+$/, "") || "file";
const loadScript = (src, test) => test() ? Promise.resolve() : new Promise((res, rej) => {
  const s = document.createElement("script"); s.src = src; s.onload = res; s.onerror = () => rej(new Error("Could not load a helper library (are you offline?)")); document.head.appendChild(s);
});
const jszip = () => loadScript("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js", () => window.JSZip).then(() => window.JSZip);
const utif = () => loadScript("https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js", () => window.UTIF).then(() => window.UTIF);

// the browser opens these itself (the editor takes them as they are)
const NATIVE_IMG = /^(png|jpe?g|gif|webp)$/;
export const isNative = (f) => f.type === "application/pdf" || ext(f) === "pdf" || (NATIVE_IMG.test(ext(f)) || /^image\/(png|jpeg|gif|webp)$/.test(f.type));

// What a file is, by extension first, then type, then a look at its first bytes.
const KINDS = {
  text: /^(txt|text|md|markdown|csv|tsv|log|ini|cfg|conf|yaml|yml|toml|js|mjs|ts|py|java|c|h|cpp|cs|go|rs|rb|php|sh|bat|ps1|sql|css|scss|tex|srt|vtt)$/,
  json: /^(json|geojson|ipynb)$/, xml: /^(xml|kml|gpx|rss|atom|plist)$/, html: /^(html?|xhtml|mht|mhtml)$/,
  docx: /^(docx|docm|dotx)$/, xlsx: /^(xlsx|xlsm)$/, pptx: /^(pptx|ppsx)$/, odt: /^(odt|ods|odp)$/, rtf: /^rtf$/,
  eml: /^(eml)$/, svg: /^svg$/, tiff: /^tiff?$/, image: /^(bmp|ico|avif|cur|jfif|pjpeg|pjp|apng)$/, heic: /^(heic|heif)$/, zip: /^zip$/,
};
const WHY = {
  doc: "Old Word files (.doc) use a closed format the browser can't read. Open it in Word or Google Docs and save it as .docx or PDF, then drop that here.",
  xls: "Old Excel files (.xls) can't be read here. Save the sheet as .xlsx, .csv or PDF and drop that.",
  ppt: "Old PowerPoint files (.ppt) can't be read here. Save it as .pptx or PDF and drop that.",
  heic: "This browser can't decode HEIC photos. On an iPhone choose Settings → Camera → Formats → Most Compatible, or share the photo as JPG, then drop that.",
  pages: "Apple Pages / Numbers / Keynote files can't be read here. Export it to PDF from the app (File → Export To → PDF).",
  psd: "Photoshop files can't be read here. Save a PNG or JPG copy and drop that.",
  media: "This is a sound or video file - there is no page to show. Ghost Calligrapher works with documents and pictures.",
  exe: "This is a program, not a document, so it can't be opened here.",
  rar: "RAR / 7z archives can't be opened in the browser. Unpack it and drop the files inside (ZIP archives do work).",
  enc: "This file looks encrypted or is in an unknown binary format, so there is nothing readable in it.",
};
function kindOf(f) {
  const e = ext(f);
  for (const [k, re] of Object.entries(KINDS)) if (re.test(e)) return k;
  if (e === "doc" || e === "dot") return "x:doc"; if (e === "xls") return "x:xls"; if (e === "ppt" || e === "pps") return "x:ppt";
  if (/^(pages|numbers|key)$/.test(e)) return "x:pages"; if (e === "psd") return "x:psd";
  if (/^(mp3|wav|m4a|aac|ogg|flac|mp4|mov|avi|mkv|webm|wmv)$/.test(e) || /^(audio|video)\//.test(f.type)) return "x:media";
  if (/^(exe|dll|msi|dmg|app|apk|bin|iso)$/.test(e)) return "x:exe"; if (/^(rar|7z|tar|gz|bz2|xz)$/.test(e)) return "x:rar";
  if (/^text\//.test(f.type)) return "text"; if (/^image\//.test(f.type)) return "image";
  return "sniff";
}
async function sniff(f) {   // unknown extension: look at the bytes
  const u8 = new Uint8Array(await f.slice(0, 4096).arrayBuffer());
  const sig = (s) => s.split(" ").every((h, i) => parseInt(h, 16) === u8[i]);
  if (sig("25 50 44 46")) return "pdf"; if (sig("89 50 4E 47") || sig("FF D8 FF") || sig("47 49 46 38") || sig("52 49 46 46")) return "image";
  if (sig("49 49 2A 00") || sig("4D 4D 00 2A")) return "tiff"; if (sig("42 4D")) return "image";
  if (sig("50 4B 03 04")) { // a zip: maybe an Office file without its extension
    try { const z = await (await jszip()).loadAsync(f); if (z.file("word/document.xml")) return "docx"; if (z.file("xl/workbook.xml")) return "xlsx"; if (z.file("ppt/presentation.xml")) return "pptx"; } catch (_) {}
    return "zip";
  }
  if (sig("D0 CF 11 E0")) return "x:doc";
  const txt = new TextDecoder("utf-8", { fatal: false }).decode(u8); let bad = 0;
  for (const ch of txt) { const c = ch.charCodeAt(0); if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++; }
  if (u8.length && bad / txt.length < 0.02) return /^\s*</.test(txt) ? (/<html|<!doctype html/i.test(txt) ? "html" : "xml") : (/^\s*[[{]/.test(txt) ? "json" : "text");
  return "x:enc";
}

// ---- reading: every readable file becomes { pdf: Uint8Array } or { img: Blob } ----
const WIN_ANSI = new Set([..."€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ"]);
const ansi = (s) => [...s].map((ch) => ch.charCodeAt(0) < 256 || WIN_ANSI.has(ch) ? ch : ({ "−": "-", " ": " ", "→": "->", "←": "<-", "✓": "v", "•": "•" })[ch] || "?").join("").replace(/[\x00-\x08\x0b-\x1f]/g, "");
// Blocks: { t: text, h: heading level 0-3, mono, gap } laid out on Letter pages.
async function blocksToPdf(blocks, title) {
  const L = await pdfLibReady(), out = await L.PDFDocument.create();
  out.setTitle(title || "Document"); out.setProducer("Ghost Calligrapher");
  const F = { r: await out.embedFont(L.StandardFonts.Helvetica), b: await out.embedFont(L.StandardFonts.HelveticaBold), m: await out.embedFont(L.StandardFonts.Courier) };
  const pw = 612, ph = 792, mg = 54, maxW = pw - mg * 2; let pg = out.addPage([pw, ph]), y = ph - mg;
  const line = (s, font, size, ind = 0) => {
    const lh = size * 1.4; if (y - lh < mg) { pg = out.addPage([pw, ph]); y = ph - mg; }
    y -= size; try { pg.drawText(s, { x: mg + ind, y, size, font, color: L.rgb(0.1, 0.1, 0.12) }); } catch (_) {} y -= lh - size;
  };
  for (const b of blocks) {
    const size = b.h === 1 ? 18 : b.h === 2 ? 14.5 : b.h === 3 ? 12.5 : b.mono ? 9.5 : 11, font = b.mono ? F.m : b.h ? F.b : F.r, ind = b.ind || 0;
    if (b.h) y -= size * 0.5;
    const text = ansi(String(b.t || "")).replace(/\t/g, "    ");
    if (!text.trim()) { y -= size * 0.9; continue; }
    for (const para of text.split("\n")) {
      if (!para) { y -= size * 1.1; continue; }
      if (b.mono && font.widthOfTextAtSize(para, size) <= maxW - ind) { line(para, font, size, ind); continue; }
      let cur = "";
      for (const w of para.split(/(\s+)/)) {
        const test = cur + w;
        if (font.widthOfTextAtSize(test, size) > maxW - ind && cur.trim()) { line(cur.trimEnd(), font, size, ind); cur = w.trimStart(); }
        else cur = test;
        while (font.widthOfTextAtSize(cur, size) > maxW - ind && cur.length > 1) { // one very long word
          let n = cur.length; while (n > 1 && font.widthOfTextAtSize(cur.slice(0, n), size) > maxW - ind) n--; line(cur.slice(0, n), font, size, ind); cur = cur.slice(n);
        }
      }
      if (cur.trim()) line(cur.trimEnd(), font, size, ind);
    }
    if (b.gap !== false) y -= size * 0.45;
  }
  return out.save();
}
const xmlText = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
function htmlBlocks(html) {
  const d = new DOMParser().parseFromString(html, "text/html"); d.querySelectorAll("script,style,noscript,template,head").forEach((n) => n.remove());
  const out = [], walk = (n) => {
    for (const c of n.children) {
      const t = c.tagName.toLowerCase();
      if (/^h[1-6]$/.test(t)) out.push({ t: c.textContent.trim(), h: Math.min(3, +t[1]) });
      else if (t === "p" || t === "blockquote" || t === "figcaption" || t === "dt" || t === "dd") out.push({ t: c.textContent.replace(/\s+/g, " ").trim() });
      else if (t === "li") out.push({ t: "• " + c.textContent.replace(/\s+/g, " ").trim(), ind: 12, gap: false });
      else if (t === "pre") out.push({ t: c.textContent, mono: true });
      else if (t === "tr") out.push({ t: [...c.children].map((td) => td.textContent.replace(/\s+/g, " ").trim()).join("  |  "), gap: false });
      else if (t === "br" || t === "hr") out.push({ t: "" });
      else if (c.children.length) walk(c);
      else if (c.textContent.trim()) out.push({ t: c.textContent.replace(/\s+/g, " ").trim() });
    }
  };
  walk(d.body || d.documentElement);
  if (!out.length && d.body) out.push({ t: d.body.textContent.replace(/\s+\n/g, "\n").trim() });
  return { blocks: out, title: (d.title || "").trim() };
}
function rtfText(rtf) {
  let s = rtf.replace(/\{\\\*[^{}]*\}/g, "").replace(/\{\\(fonttbl|colortbl|stylesheet|info)[\s\S]*?\}\}?/g, "");
  s = s.replace(/\\par[d]?\b ?/g, "\n").replace(/\\line\b ?/g, "\n").replace(/\\tab\b ?/g, "\t").replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_, n) => String.fromCharCode((+n + 65536) % 65536)).replace(/\\[a-z]+-?\d* ?/gi, "").replace(/\\([{}\\])/g, "$1").replace(/[{}]/g, "");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}
function emlBlocks(raw) {
  const [head, ...rest] = raw.replace(/\r\n/g, "\n").split("\n\n"); let body = rest.join("\n\n");
  const hdr = (k) => ((head.replace(/\n[ \t]+/g, " ").match(new RegExp("^" + k + ":\\s*(.*)$", "im")) || [])[1] || "").trim();
  const bmatch = head.match(/boundary="?([^";\n]+)"?/i);
  if (bmatch) {   // multipart: prefer text/plain, else text/html
    const parts = body.split("--" + bmatch[1]).map((p) => { const i = p.indexOf("\n\n"); return { h: p.slice(0, i), b: p.slice(i + 2) }; });
    const pick = parts.find((p) => /text\/plain/i.test(p.h)) || parts.find((p) => /text\/html/i.test(p.h));
    if (pick) { body = pick.b; if (/quoted-printable/i.test(pick.h)) body = qp(body); else if (/base64/i.test(pick.h)) body = b64text(body); if (/text\/html/i.test(pick.h)) body = htmlBlocks(body).blocks.map((b) => b.t).join("\n"); }
  } else if (/quoted-printable/i.test(head)) body = qp(body); else if (/content-transfer-encoding:\s*base64/i.test(head)) body = b64text(body);
  return [{ t: hdr("Subject") || "(no subject)", h: 1 }, { t: ["From: " + hdr("From"), "To: " + hdr("To"), hdr("Cc") && "Cc: " + hdr("Cc"), "Date: " + hdr("Date")].filter(Boolean).join("\n"), gap: true }, { t: body.trim() }];
}
const qp = (s) => s.replace(/=\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
const b64text = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, "")), (c) => c.charCodeAt(0))); } catch (_) { return s; } };
async function officeBlocks(f, kind) {
  const z = await (await jszip()).loadAsync(f), out = [];
  if (kind === "docx") {
    const xml = await z.file("word/document.xml").async("string");
    for (const p of xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []) {
      const style = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1] || "", t = (p.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>|<w:br\/>/g) || []).map((r) => r === "<w:tab/>" ? "\t" : r === "<w:br/>" ? "\n" : xmlText(r)).join("");
      const h = /^(Title|Heading1)$/i.test(style) ? 1 : /Heading2/i.test(style) ? 2 : /Heading[3-9]/i.test(style) ? 3 : 0;
      out.push(/<w:numPr>/.test(p) ? { t: "• " + t, ind: 12, gap: false } : { t, h });
    }
  } else if (kind === "xlsx") {
    const ss = z.file("xl/sharedStrings.xml") ? (await z.file("xl/sharedStrings.xml").async("string")).match(/<si>[\s\S]*?<\/si>/g) || [] : [];
    const strs = ss.map((s) => xmlText((s.match(/<t[^>]*>[\s\S]*?<\/t>/g) || []).join("")));
    const wb = await z.file("xl/workbook.xml").async("string"), names = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => xmlText(m[1]));
    const sheets = Object.keys(z.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
    for (const [i, sn] of sheets.entries()) {
      out.push({ t: names[i] || "Sheet " + (i + 1), h: 2 });
      const xml = await z.file(sn).async("string"), rows = [];
      for (const r of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
        const cells = [];
        for (const c of r.match(/<c [^>]*?(\/>|>[\s\S]*?<\/c>)/g) || []) {
          const ref = (c.match(/r="([A-Z]+)\d+"/) || [])[1] || "", col = [...ref].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
          const v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1], isS = /t="s"/.test(c), inl = c.match(/<is>[\s\S]*?<\/is>/);
          cells[Math.max(0, col)] = inl ? xmlText(inl[0]) : v == null ? "" : isS ? strs[+v] || "" : xmlText(v);
        }
        rows.push([...cells].map((x) => x ?? ""));
      }
      const w = []; rows.forEach((r) => r.forEach((c, j) => { w[j] = Math.min(28, Math.max(w[j] || 0, String(c).length)); }));
      out.push({ t: rows.map((r) => r.map((c, j) => String(c).slice(0, 28).padEnd(w[j] || 0)).join("  ").trimEnd()).join("\n") || "(empty sheet)", mono: true });
    }
  } else if (kind === "pptx") {
    const slides = Object.keys(z.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
    for (const [i, sn] of slides.entries()) {
      const xml = await z.file(sn).async("string"), paras = (xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((p) => xmlText((p.match(/<a:t>[\s\S]*?<\/a:t>/g) || []).join(""))).filter((t) => t.trim());
      out.push({ t: "Slide " + (i + 1) + (paras[0] ? " - " + paras[0] : ""), h: 2 }); paras.slice(1).forEach((t) => out.push({ t: "• " + t, ind: 12, gap: false })); out.push({ t: "" });
    }
  } else if (kind === "odt") {
    const xml = await z.file("content.xml").async("string");
    for (const m of xml.matchAll(/<text:(h|p)[^>]*?(?:text:outline-level="(\d)")?[^>]*>([\s\S]*?)<\/text:\1>/g)) out.push({ t: xmlText(m[3].replace(/<text:tab\/>/g, "\t").replace(/<text:line-break\/>/g, "\n")), h: m[1] === "h" ? Math.min(3, +(m[2] || 1)) : 0 });
  }
  return out;
}
async function imageFromAny(f, kind) {   // -> PNG blob
  const toPng = (src, w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.drawImage(src, 0, 0, w, h); return new Promise((r) => c.toBlob(r, "image/png")); };
  if (kind === "svg") {
    const txt = await f.text(), url = URL.createObjectURL(new Blob([txt], { type: "image/svg+xml" }));
    try {
      const im = new Image(); im.src = url; await im.decode();
      let w = im.naturalWidth || 800, h = im.naturalHeight || 600; const k = Math.max(1, 1600 / Math.max(w, h)); return toPng(im, Math.round(w * k), Math.round(h * k));
    } finally { URL.revokeObjectURL(url); }
  }
  if (kind === "tiff") {
    const U = await utif(), buf = await f.arrayBuffer(), ifds = U.decode(buf); if (!ifds.length) throw new Error("no pictures inside this TIFF");
    const pages = [];
    for (const ifd of ifds.slice(0, 50)) {
      U.decodeImage(buf, ifd); const rgba = U.toRGBA8(ifd), c = document.createElement("canvas"); c.width = ifd.width; c.height = ifd.height;
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), ifd.width, ifd.height), 0, 0);
      pages.push(await new Promise((r) => c.toBlob(r, "image/png")));
    }
    return pages.length === 1 ? pages[0] : pages;
  }
  const bm = await createImageBitmap(f); try { return await toPng(bm, bm.width, bm.height); } finally { bm.close && bm.close(); }
}
async function imagesToPdf(blobs) {
  const L = await pdfLibReady(), out = await L.PDFDocument.create();
  for (const b of blobs) { const im = await out.embedPng(new Uint8Array(await b.arrayBuffer())); const k = 72 / 96; const pg = out.addPage([im.width * k, im.height * k]); pg.drawImage(im, { x: 0, y: 0, width: im.width * k, height: im.height * k }); }
  return out.save();
}
const KIND_NAME = { text: "Text", json: "JSON data", xml: "XML data", html: "Web page", docx: "Word document", xlsx: "Excel workbook", pptx: "PowerPoint deck", odt: "OpenDocument file", rtf: "Rich text", eml: "Email", svg: "SVG drawing", tiff: "TIFF picture", image: "Picture", heic: "HEIC photo", zip: "ZIP archive", pdf: "PDF" };

// Read one file. Returns { name, kind, label, pdf?, imgs?, native?, error? }
export async function readAny(f) {
  let kind = kindOf(f); if (kind === "sniff") kind = await sniff(f);
  const r = { file: f, name: f.name || "file", base: base(f), kind, label: KIND_NAME[kind] || "File" };
  if (kind.startsWith("x:")) { r.error = WHY[kind.slice(2)]; return r; }
  try {
    if (kind === "pdf" || (kind === "image" && isNative(f))) { r.native = true; return r; }
    if (kind === "heic") { try { r.imgs = [await imageFromAny(f, "image")]; } catch (_) { r.error = WHY.heic; } return r; }
    if (kind === "image" || kind === "svg" || kind === "tiff") { const im = await imageFromAny(f, kind); r.imgs = Array.isArray(im) ? im : [im]; return r; }
    if (kind === "zip") { r.error = null; return r; }
    let blocks, title = r.base;
    if (kind === "text") blocks = [{ t: await f.text(), mono: /^(csv|tsv|log|js|mjs|ts|py|java|c|h|cpp|cs|go|rs|rb|php|sh|bat|ps1|sql|css|scss|yaml|yml|toml|ini|cfg|conf)$/.test(ext(f)) }];
    else if (kind === "json") { const t = await f.text(); let pretty = t; try { pretty = JSON.stringify(JSON.parse(t), null, 2); } catch (_) {} blocks = [{ t: pretty, mono: true }]; }
    else if (kind === "xml") blocks = [{ t: (await f.text()).replace(/>\s*</g, ">\n<"), mono: true }];
    else if (kind === "html") { const h = htmlBlocks(await f.text()); blocks = h.blocks; title = h.title || title; }
    else if (kind === "rtf") blocks = [{ t: rtfText(await f.text()) }];
    else if (kind === "eml") blocks = emlBlocks(await f.text());
    else blocks = await officeBlocks(f, kind);
    if (!blocks.some((b) => String(b.t || "").trim())) { r.error = "The file opened, but there is no text in it to show."; return r; }
    r.pdf = await blocksToPdf(blocks, title);
    if (kind === "docx" || kind === "xlsx" || kind === "pptx" || kind === "odt" || kind === "html" || kind === "rtf") r.note = "Text and layout of headings and lists are kept; pictures, colours and exact page layout are not.";
  } catch (e) { r.error = "Could not read it: " + (e.message || e); }
  return r;
}
// a zip: every entry becomes its own file
async function unzip(f) {
  const z = await (await jszip()).loadAsync(f), files = [];
  for (const [n, e] of Object.entries(z.files)) {
    if (e.dir || /(^|\/)(__MACOSX|\.)/.test(n)) continue;
    const b = await e.async("blob"); files.push(new File([b], n.split("/").pop(), { type: "" }));
    if (files.length >= 60) break;
  }
  return files;
}
// everything as File objects the editor can open (PDF or picture)
async function asOpenable(r) {
  if (r.native) return [r.file];
  if (r.pdf) return [new File([r.pdf], r.base + ".pdf", { type: "application/pdf" })];
  return (r.imgs || []).map((b, i) => new File([b], r.base + (r.imgs.length > 1 ? "-" + (i + 1) : "") + ".png", { type: "image/png" }));
}
async function asPdf(r) {
  if (r.pdf) return r.pdf;
  if (r.native && (r.kind === "pdf")) return new Uint8Array(await r.file.arrayBuffer());
  const imgs = r.native ? [await imageFromAny(r.file, "image")] : r.imgs; return imagesToPdf(imgs);
}
async function asPictures(r) {   // -> [{ name, blob }]
  if (r.imgs && !r.pdf) return r.imgs.map((b, i) => ({ name: r.base + (r.imgs.length > 1 ? "-" + (i + 1) : "") + ".png", blob: b }));
  if (r.native && r.kind !== "pdf") return [{ name: r.base + ".png", blob: await imageFromAny(r.file, "image") }];
  const pj = await pdfjsReady(), d = await pj.getDocument({ data: (await asPdf(r)).slice() }).promise, out = [];
  for (let i = 1; i <= Math.min(d.numPages, 100); i++) {
    const p = await d.getPage(i), vp = p.getViewport({ scale: 2 }), c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); await p.render({ canvasContext: g, viewport: vp }).promise;
    out.push({ name: r.base + (d.numPages > 1 ? "-page-" + i : "") + ".png", blob: await new Promise((res) => c.toBlob(res, "image/png")) });
  }
  d.destroy(); return out;
}
function saveBlob(blob, name) {
  const a = document.createElement("a"), u = URL.createObjectURL(blob); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000);
}

// ---- the dialog ----
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function dialog() {
  let d = $("cvdlg"); if (d) return d;
  d = document.createElement("dialog"); d.className = "dpad cvdlg"; d.id = "cvdlg";
  d.innerHTML = `<div class="dp-head"><b>Open these files</b><span class="spacer"></span><button class="iconbtn" data-cv="x" title="Close">✕</button></div>
    <div class="dp-body"><div class="cv-list" id="cv_list"></div><div class="cv-msg" id="cv_msg"></div></div>
    <div class="dp-foot cv-foot"><button class="btn" data-cv="pdf">Save as PDF</button><button class="btn" data-cv="png">Save as picture</button><button class="btn" data-cv="docx">Save as Word</button><button class="btn primary" data-cv="open">Open in editor</button></div>`;
  document.body.appendChild(d); return d;
}
// files: any mix. opts.open(files) opens openable files in the editor.
export async function importAny(files, opts = {}) {
  files = [...files];
  const d = dialog(), list = d.querySelector("#cv_list"), msg = d.querySelector("#cv_msg");
  msg.textContent = ""; list.innerHTML = `<div class="cv-row"><span class="cv-k">…</span>Reading ${files.length} file${files.length > 1 ? "s" : ""}…</div>`;
  if (!d.open) d.showModal();
  const results = [];
  for (const f of files) {
    if (kindOf(f) === "zip" || (kindOf(f) === "sniff" && (await sniff(f)) === "zip")) {
      try { const inner = await unzip(f); results.push({ name: f.name, kind: "zip", label: `ZIP archive - ${inner.length} file${inner.length === 1 ? "" : "s"} inside`, info: true }); for (const g of inner) results.push(await readAny(g)); }
      catch (e) { results.push({ name: f.name, kind: "zip", label: "ZIP archive", error: "Could not unpack it: " + (e.message || e) }); }
    } else results.push(await readAny(f));
  }
  const ok = results.filter((r) => !r.error && !r.info);
  list.innerHTML = results.map((r) => `<div class="cv-row${r.error ? " bad" : ""}${r.info ? " info" : ""}"><span class="cv-k">${r.error ? "✕" : r.info ? "▤" : "✓"}</span><div><b>${esc(r.name)}</b> <small>${esc(r.label)}</small>${r.error ? `<div class="cv-why">${esc(r.error)}</div>` : r.note ? `<div class="cv-note">${esc(r.note)}</div>` : ""}</div></div>`).join("");
  d.querySelectorAll(".cv-foot .btn").forEach((b) => { b.disabled = !ok.length; });
  d.querySelector('[data-cv="docx"]').hidden = !window.__cal2DocxFromBytes;
  msg.textContent = ok.length ? (ok.length > 1 ? `Open in editor puts all ${ok.length} into one document; the Save buttons save each one.` : "") : "None of these can be opened here - the reasons are above.";
  return new Promise((resolve) => {
    const busy = async (label, fn) => { d.querySelectorAll(".cv-foot .btn").forEach((b) => b.disabled = true); msg.textContent = label; try { await fn(); } catch (e) { msg.textContent = "Something went wrong: " + (e.message || e); d.querySelectorAll(".cv-foot .btn").forEach((b) => b.disabled = false); return false; } return true; };
    d.onclick = async (e) => {
      const a = e.target.closest("[data-cv]")?.dataset.cv; if (!a) { if (e.target === d) { d.close(); resolve(null); } return; }
      if (a === "x") { d.close(); resolve(null); return; }
      if (a === "open") {
        if (await busy("Opening…", async () => { const fs = []; for (const r of ok) fs.push(...await asOpenable(r)); d.close(); if (opts.open) await opts.open(fs); resolve("open"); })) return;
      } else if (a === "pdf") {
        await busy("Making PDF…", async () => { for (const r of ok) saveBlob(new Blob([await asPdf(r)], { type: "application/pdf" }), r.base + ".pdf"); msg.textContent = "Saved - check your downloads."; d.querySelectorAll(".cv-foot .btn").forEach((b) => b.disabled = false); });
      } else if (a === "png") {
        await busy("Making pictures…", async () => {
          for (const r of ok) { const pics = await asPictures(r); if (pics.length > 1) { const Z = await jszip(), z = new Z(); pics.forEach((p) => z.file(p.name, p.blob)); saveBlob(await z.generateAsync({ type: "blob" }), r.base + "-pictures.zip"); } else if (pics[0]) saveBlob(pics[0].blob, pics[0].name); }
          msg.textContent = "Saved - check your downloads (several pages come as a .zip)."; d.querySelectorAll(".cv-foot .btn").forEach((b) => b.disabled = false);
        });
      } else if (a === "docx") {
        await busy("Making Word document…", async () => { for (const r of ok) saveBlob(await window.__cal2DocxFromBytes(await asPdf(r), r.base, (m) => { msg.textContent = m; }), r.base + ".docx"); msg.textContent = "Saved - check your downloads."; d.querySelectorAll(".cv-foot .btn").forEach((b) => b.disabled = false); });
      }
    };
    d.onclose = () => resolve(null);
  });
}
window.__cal2ImportAny = importAny;
window.__cal2IsNativeFile = isNative;
