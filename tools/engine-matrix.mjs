// Engine matrix for web/calligrapher2.wasm, run in Node with no browser: thousands of generate() calls over every kind of
// text (letters, digits, punctuation, accents, other scripts, emoji, long text, blank lines, empty) and every control from
// its minimum to its maximum and beyond, plus the scanned-look pixel pipeline and the 1-bit packer. Checks: never traps,
// well-formed SVG, no NaN / inf in any path, ink for every visible character, same seed = same strokes, a new seed =
// new strokes, memory does not grow without bound, and the packer matches a reference worked out here.
// Run: node tools/engine-matrix.mjs [count]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { instance } = await WebAssembly.instantiate(readFileSync(path.join(root, 'web/calligrapher2.wasm')), {});
const W = instance.exports;
const enc = new TextEncoder(), dec = new TextDecoder();
const N = +(process.argv[2] || 3000);
let seed = 2023;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + (hi - lo) * rnd();
const fails = {}; let n = 0, pass = 0;
const ok = (name, cond, detail) => { n++; if (cond) { pass++; return true; } (fails[name] = fails[name] || []).push(String(detail).slice(0, 220)); return false; };

function gen(text, p) {
  const bytes = enc.encode(text), ptr = W.alloc(bytes.length || 1);
  new Uint8Array(W.memory.buffer, ptr, bytes.length).set(bytes);
  const len = W.generate(ptr, bytes.length, p.width, p.height, p.font_px, p.slant_deg, p.variation, p.weight, p.contrast, p.spacing, p.line_spacing, p.align, p.tilt, p.vary, p.inkflow, p.natural, p.caps_cursive, p.lo, p.hi);
  const svg = dec.decode(new Uint8Array(W.memory.buffer, W.result_ptr(), len));
  W.dealloc(ptr, bytes.length || 1);
  return svg;
}
const TEXTS = ['The quick brown fox jumps over the lazy dog', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', '!?.,;:\'"()-&$%@#/*+=<>[]{}_~^`|\\',
  'Jane Q. Sample', 'Dear Mr. Smith,\nThank you for your letter.\n\nBest regards,\nJ', 'café naïve résumé jalapeño', 'Ångström Œuvre ß', 'Привет мир', '你好世界', 'مرحبا', '🙂 thanks 👍',
  'a', ' ', '\n\n\n', '\t tab \t', 'x'.repeat(600), 'word '.repeat(300), '12/31/2026', '$1,234.56', 'Signature', 'mixed CASE Words and 123 numbers'];
const CTRL = () => ({
  width: pick([800, 1200, 320, 2400, between(100, 3000), 1]), height: pick([300, 600, between(50, 2000), 1]), font_px: pick([60, 36, 120, between(8, 220), 1, 500]),
  slant_deg: pick([0, 8, -10, 25, between(-30, 30)]), variation: pick([0, 0.5, 1, between(0, 1.2)]), weight: pick([3.5, 1, 8, between(0.3, 12)]), contrast: pick([0, 0.6, 1, between(0, 1.3)]),
  spacing: pick([0.04, 0, -0.1, 0.3, between(-0.2, 0.5)]), line_spacing: pick([1, 0.7, 1.6, between(0.5, 2.5)]), align: pick([0, 1, 2]), tilt: pick([0, 1, between(0, 1)]),
  vary: pick([0, 1]), inkflow: pick([0, 1]), natural: pick([0, 1]), caps_cursive: pick([0, 1]), lo: Math.floor(rnd() * 4294967295) >>> 0, hi: pick([0, Math.floor(rnd() * 4294967295) >>> 0]),
});
const visible = (t) => /[A-Za-z0-9]/.test(t);
const mem0 = W.memory.buffer.byteLength;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const text = pick(TEXTS), p = CTRL();
  let svg;
  try { svg = gen(text, p); } catch (e) { ok('generate never traps', false, `${JSON.stringify(text).slice(0, 30)} ${JSON.stringify(p)}: ${e.message}`); continue; }
  ok('generate never traps', true);
  ok('output is one <svg> element', /^<svg[\s>]/.test(svg) && /<\/svg>\s*$/.test(svg), svg.slice(0, 60) + ' ... ' + svg.slice(-30));
  ok('no NaN or inf in the drawing', !/NaN|inf/i.test(svg.replace(/<(text|title)[^>]*>[^<]*<\/\1>/g, '')), `${JSON.stringify(text).slice(0, 30)} ${JSON.stringify(p)}: ${(svg.match(/.{20}(NaN|inf).{10}/i) || [''])[0]}`);
  const paths = (svg.match(/<path /g) || []).length;
  if (visible(text) && p.font_px >= 4 && p.width >= 200) ok('ink for visible text', paths > 0, `${JSON.stringify(text).slice(0, 30)} font ${p.font_px} width ${p.width}`);
  const nums = (svg.match(/-?\d+(\.\d+)?(e[-+]?\d+)?/g) || []).map(Number);
  ok('every coordinate is finite and sane', nums.every((v) => Number.isFinite(v) && Math.abs(v) < 1e7), `${JSON.stringify(text).slice(0, 20)} max ${nums.reduce((a, v) => Math.max(a, Math.abs(v)), 0)}`);
  if (i % 4 === 0) {
    ok('same seed, same strokes', gen(text, p) === svg, JSON.stringify(text).slice(0, 30));
    if (visible(text) && p.variation > 0.05 && p.font_px >= 8) { const q = { ...p, lo: (p.lo + 1) >>> 0 }; ok('a new seed gives new strokes', gen(text, q) !== svg, `${JSON.stringify(text).slice(0, 30)} variation ${p.variation}`); }
  }
}
/* wasm memory only grows to the largest render so far; a leak shows as growth while the same render repeats */
{ const q = { width: 1200, height: 600, font_px: 60, slant_deg: 8, variation: 0.5, weight: 3.5, contrast: 0.6, spacing: 0.04, line_spacing: 1, align: 0, tilt: 0, vary: 1, inkflow: 1, natural: 1, caps_cursive: 0, lo: 7, hi: 0 };
  for (let i = 0; i < 50; i++) gen(TEXTS[6], q);
  const m1 = W.memory.buffer.byteLength;
  for (let i = 0; i < 3000; i++) { q.lo = i; gen(TEXTS[6], q); }
  ok('no memory leak over 3,000 repeated renders', W.memory.buffer.byteLength === m1, `${m1} -> ${W.memory.buffer.byteLength} (high-water ${mem0} -> ${m1})`); }

// scanned look: random images and settings, in place, never traps, deterministic per seed; neutral settings change nothing
for (let i = 0; i < Math.round(N / 6); i++) {
  const w = 1 + Math.floor(rnd() * 64), h = 1 + Math.floor(rnd() * 64), len = w * h * 4;
  const src = new Uint8Array(len); for (let k = 0; k < len; k++) src[k] = Math.floor(rnd() * 256);
  const neutral = rnd() < 0.2;
  const o = neutral ? [0, 0, 0, 1, 1, 0, 0, 0, 0] : [pick([0, 0.5, 1.5, 4]), pick([0, 0.4, 1]), pick([0, 1, 2, 3]), pick([1, 0.8, 1.2]), pick([1, 1.3, 0.7]), pick([0, 0.3]), pick([0, 0.2]), pick([0, 4, 12]), pick([0, 0.002, 0.02])];
  const sl = Math.floor(rnd() * 1e9) >>> 0;
  const run = () => { const ptr = W.alloc(len); new Uint8Array(W.memory.buffer, ptr, len).set(src); W.scan_pixels(ptr, w, h, ...o, sl, 0); const out = new Uint8Array(W.memory.buffer, ptr, len).slice(); W.dealloc(ptr, len); return out; };
  let a; try { a = run(); } catch (e) { ok('scan look never traps', false, `${w}x${h} ${o}: ${e.message}`); continue; }
  ok('scan look never traps', true);
  const b = run();
  ok('scan look: same seed, same pixels', a.every((v, k) => v === b[k]), `${w}x${h} ${o}`);
  if (neutral) ok('scan look: neutral settings leave the pixels', a.every((v, k) => v === src[k]), `${w}x${h}`);
  if (o[2] === 1 && !neutral) { let gray = true; for (let k = 0; k < len; k += 4) if (src[k + 3] > 0 && (Math.abs(a[k] - a[k + 1]) > 1 || Math.abs(a[k + 1] - a[k + 2]) > 1)) { gray = o[5] > 0 || o[6] > 0; break; } ok('scan look: grayscale has no colour (before sepia / tint)', gray, `${w}x${h} ${o}`); }
}
// 1-bit packer against the reference
for (let i = 0; i < Math.round(N / 6); i++) {
  const w = 1 + Math.floor(rnd() * 70), h = 1 + Math.floor(rnd() * 30), len = w * h * 4, th = Math.floor(rnd() * 256);
  const px = new Uint8Array(len); for (let k = 0; k < len; k++) px[k] = Math.floor(rnd() * 256);
  const ptr = W.alloc(len); new Uint8Array(W.memory.buffer, ptr, len).set(px);
  const out = W.pack_bilevel(ptr, w, h, th); const got = new Uint8Array(W.memory.buffer, W.result_ptr(), out).slice(); W.dealloc(ptr, len);
  const stride = Math.ceil(w / 8), want = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const k = (y * w + x) * 4, a = px[k + 3]; let l = (54 * px[k] + 183 * px[k + 1] + 19 * px[k + 2]) >> 8; l = Math.floor((l * a + 255 * (255 - a)) / 255); if (l >= th) want[y * stride + (x >> 3)] |= 0x80 >> (x & 7); }
  ok('1-bit packing matches the reference', got.length === want.length && got.every((v, k) => v === want[k]), `${w}x${h} threshold ${th}`);
}
const names = Object.keys(fails);
for (const k of names) { console.log(`FAIL ${k} (${fails[k].length}x)`); fails[k].slice(0, 5).forEach((d) => console.log('     ' + d)); }
console.log(`\nengine matrix: ${n} checks, ${pass} pass, ${n - pass} fail; ${Math.round((Date.now() - t0) / 100) / 10}s`);
process.exit(names.length ? 1 : 0);
