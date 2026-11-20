// A small pool of scan-worker.js workers: the scanned look of several pages is rendered in
// parallel, off the main thread (the page never freezes while a PDF is being built).
// The fast engine gets up to 4 workers; the realistic (ImageMagick) engine gets one, since each
// copy holds the whole ~15 MB engine in memory.

const WASM_URL = new URL("./calligrapher2.wasm", import.meta.url).href;
const WORKER_URL = new URL("./scan-worker.js?v=4", import.meta.url);

export function scanWorkersSupported() {
  return typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function"
    && typeof OffscreenCanvas.prototype.convertToBlob === "function";
}

// half the cores, at most 4; at most 2 on low-memory devices (each page in flight is ~35 MB of pixels at 300 dpi)
const fastSize = () => Math.max(1, Math.min(navigator.deviceMemory && navigator.deviceMemory <= 4 ? 2 : 4, (navigator.hardwareConcurrency || 2) >> 1));
const pools = { fast: [], realistic: [] };
const waiting = new Map();
let seq = 0;

function spawn(kind) {
  const w = new Worker(WORKER_URL, { type: "module", name: "scan-" + kind });
  const slot = { w, busy: 0, dead: false };
  w.onmessage = (e) => {
    const job = waiting.get(e.data.id); if (!job) return;
    waiting.delete(e.data.id); slot.busy--;
    if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data);
  };
  w.onerror = (ev) => {
    slot.dead = true;
    for (const [id, job] of waiting) if (job.slot === slot) { waiting.delete(id); job.reject(new Error(ev.message || "scan worker failed")); }
  };
  return slot;
}
function pick(kind) {
  const list = pools[kind] = pools[kind].filter((s) => !s.dead);
  const max = kind === "realistic" ? 1 : fastSize();
  const free = list.find((s) => s.busy === 0);
  if (free) return free;
  if (list.length < max) { const s = spawn(kind); list.push(s); return s; }
  return list.reduce((a, b) => (a.busy <= b.busy ? a : b));
}
// How many pages to keep in flight at once for this engine.
export const scanConcurrency = (engine) => (engine === "realistic" ? 1 : fastSize());

// Render one page. `canvas` is the composed page; `p` the scan params (see app.js workerScanParams);
// `out` = { type, quality, trimW, trimH }. Resolves to { kind: "image", buf, w, h } or
// { kind: "bilevel", bits, w, h }.
export async function scanOffThread(canvas, p, out) {
  const bmp = await createImageBitmap(canvas);
  const slot = pick(p.engine === "realistic" ? "realistic" : "fast");
  slot.busy++;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, slot });
    slot.w.postMessage({ id, bmp, p, out: { ...out, wasmUrl: WASM_URL } }, [bmp]);
  });
}

// 1-bit black & white rows (1 = white, rows padded to whole bytes, as scan-worker.js returns them)
// as a PNG file: grayscale, bit depth 1. Typically 5-20x smaller than a JPEG of the same page.
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(parts) { let c = 0xffffffff; for (const b of parts) for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const head = new Uint8Array(8), tail = new Uint8Array(4), tb = new TextEncoder().encode(type);
  new DataView(head.buffer).setUint32(0, data.length); head.set(tb, 4);
  new DataView(tail.buffer).setUint32(0, crc32([tb, data]));
  return [head, data, tail];
}
export async function bilevelPng(bits, w, h) {
  const stride = (w + 7) >> 3, raw = new Uint8Array((stride + 1) * h);   // each row: filter byte 0 + packed bits
  for (let y = 0; y < h; y++) raw.set(bits.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const z = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h); ihdr[8] = 1; ihdr[9] = 0;   // bit depth 1, grayscale; compression/filter/interlace 0
  return new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...chunk("IHDR", ihdr), ...chunk("IDAT", z), ...chunk("IEND", new Uint8Array(0))], { type: "image/png" });
}

// OCR page cleanup (remove background / clean / deskew) in the realistic worker, which holds ImageMagick.
// Resolves to { bmp: ImageBitmap, angle, magickOk }.
export async function ocrPrepOffThread(canvas, o) {
  const bmp = await createImageBitmap(canvas);
  const slot = pick("realistic");
  slot.busy++;
  return new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject, slot });
    slot.w.postMessage({ id, op: "ocrprep", bmp, o }, [bmp]);
  });
}

// Start fetching the realistic engine in the background (e.g. when it is picked in the menu).
export function warmRealistic() {
  try { const s = pick("realistic"); s.w.postMessage({ id: -1, warm: true }); } catch (_) {}
}
