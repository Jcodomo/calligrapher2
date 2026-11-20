// scan-worker.js: renders the scanned look of one page off the main thread.
//
// Two engines, picked per export:
//  • "fast": the built-in Rust/WASM engine (calligrapher2.wasm, ~100 KB): sharpen, colour,
//    paper tint, Gaussian grain + specks; blur runs on the GPU via the canvas filter.
//  • "realistic": ImageMagick compiled to WebAssembly (Apache-2.0, ~15 MB, fetched once on
//    first use and then cached by the browser): ImageMagick's own Gaussian blur, sharpen,
//    noise and level-based paper tint.
// Both share the same canvas steps: vignette + blemishes + border, then the tilt, then encoding
// (JPEG / PNG, or packed 1-bit rows for true black & white).
//
// Message in:  { id, bmp: ImageBitmap (transferred), p: params, out: { type, quality, trimW, trimH, wasmUrl } }
// Message out: { id, kind: "image", buf, w, h } | { id, kind: "bilevel", bits, w, h } | { id, error }

const MAGICK_VER = "0.0.45";
const MAGICK_JS = `https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@${MAGICK_VER}/dist/index.js`;
const MAGICK_WASM = `https://cdn.jsdelivr.net/npm/@imagemagick/magick-wasm@${MAGICK_VER}/dist/x86/magick.wasm`;
const PAPER = [252, 242, 199];   // warm paper colour the realistic tint levels toward

let wasm = null, mem = { ptr: 0, size: 0 };
async function loadWasm(url) {
  if (wasm) return wasm;
  const res = await fetch(url);
  let out;
  try { out = await WebAssembly.instantiateStreaming(res.clone(), {}); }
  catch (_) { out = await WebAssembly.instantiate(await res.arrayBuffer(), {}); }
  wasm = out.instance.exports;
  return wasm;
}
// one reusable buffer inside the WASM memory (pages are processed one at a time per worker)
function wasmBuf(X, size) {
  if (mem.size < size) {
    if (mem.ptr) X.dealloc(mem.ptr, mem.size);
    mem = { ptr: X.alloc(size), size };
  }
  return mem.ptr;
}

let magick = null;
async function loadMagick() {
  if (!magick) magick = (async () => {
    const M = await import(MAGICK_JS);
    await M.initializeImageMagick(new URL(MAGICK_WASM));
    return M;
  })().catch((e) => { magick = null; throw e; });
  return magick;
}

let filterOK = null;   // canvas filters on OffscreenCanvas (Chrome, Edge, Firefox; not Safari)
function canvasFilters() {
  if (filterOK === null) {
    try { const g = new OffscreenCanvas(1, 1).getContext("2d"); g.filter = "blur(1px)"; filterOK = g.filter === "blur(1px)"; }
    catch (_) { filterOK = false; }
  }
  return filterOK;
}

const CSPACE = { color: 0, gray: 1, bw: 2, bilevel: 2 };

function fastPass(X, img, p, blurDone) {
  const n = img.data.length, ptr = wasmBuf(X, n);
  new Uint8Array(X.memory.buffer, ptr, n).set(img.data);
  const seed = (Math.random() * 0xffffffff) >>> 0;
  X.scan_pixels(ptr, img.width, img.height,
    blurDone ? 0 : p.blur, p.sharp, CSPACE[p.cspace] ?? 0, p.bright, p.contrast,
    p.yellow * 0.7,                                      // sepia, as in the canvas pipeline
    p.yellow * 0.5,                                      // warm paper multiply
    p.noise * 0.12,                                      // Gaussian grain (levels): subtle, as random grain costs JPEG size
    Math.min(p.noise / 240, 0.45) * 0.08,                // salt & pepper specks (same density as before)
    seed, (Math.random() * 0xffffffff) >>> 0);
  img.data.set(new Uint8Array(X.memory.buffer, ptr, n));
  return img;
}

async function realisticPass(img, p, blurDone) {
  const M = await loadMagick();
  const { ImageMagick, MagickReadSettings, MagickFormat, Percentage, NoiseType, MagickColor, ColorSpace, Channels } = M;
  const W = img.width, H = img.height;
  let out = null;
  ImageMagick.read(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length),
    new MagickReadSettings({ format: MagickFormat.Rgba, width: W, height: H }), (im) => {
      if (!blurDone && p.blur > 0.3) im.blur(0, p.blur);
      if (p.sharp > 0) im.sharpen(0, 0.6 + p.sharp);
      if (p.cspace !== "color") im.colorSpace = ColorSpace.Gray;
      if (p.cspace === "bw" || p.cspace === "bilevel") im.brightnessContrast(new Percentage(5), new Percentage(55));
      im.brightnessContrast(new Percentage((p.bright - 1) * 100), new Percentage((p.contrast - 1) * 100));
      if (p.cspace !== "color") im.colorSpace = ColorSpace.sRGB;
      if (p.yellow > 0) {
        // lift black and pull white toward warm paper (how aged / scanned paper reads)
        const k = Math.min(0.5, p.yellow * 1.5);
        im.inverseLevelColors(new MagickColor(...PAPER.map((c) => Math.round(c * k))),
          new MagickColor(...PAPER.map((c) => Math.round(255 * (1 - k) + c * k))));
      }
      if (p.noise > 0) im.addNoise(NoiseType.Gaussian, p.noise / 60, Channels.RGB);
      im.write(MagickFormat.Rgba, (data) => { out = new Uint8ClampedArray(data); });
    });
  if (!out || out.length !== W * H * 4) throw new Error("ImageMagick returned an unexpected picture");
  return new ImageData(out, W, H);
}

// Vignette + blemish specks (the same look as the canvas pipeline in app.js)
function blemish(g, w, h, blem) {
  const grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  grad.addColorStop(0, "rgba(0,0,0,0)"); grad.addColorStop(1, `rgba(20,16,10,${0.12 + blem * 0.12})`);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  const n = Math.floor(blem * (w * h) / 6000);
  for (let i = 0; i < n; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = Math.random() * 1.6 + 0.3;
    g.fillStyle = Math.random() < 0.5 ? `rgba(40,30,20,${Math.random() * 0.25})` : `rgba(255,255,255,${Math.random() * 0.2})`;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
}

// Tilt in one draw. With trimW/trimH the result is cut back to the page's own size (PDF pages);
// without, the frame grows to fit the tilted page (pictures), like rotateCanvas in app.js.
function tilt(src, angDeg, trimW, trimH) {
  const ang = angDeg * Math.PI / 180, w = src.width, h = src.height;
  if (Math.abs(ang) <= 0.0005 && (!trimW || (trimW === w && trimH === h))) return src;
  const cos = Math.abs(Math.cos(ang)), sin = Math.abs(Math.sin(ang));
  const ow = trimW || Math.ceil(w * cos + h * sin), oh = trimH || Math.ceil(w * sin + h * cos);
  const o = new OffscreenCanvas(ow, oh), g = o.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, ow, oh);
  g.translate(ow / 2, oh / 2); g.rotate(ang); g.drawImage(src, -w / 2, -h / 2);
  return o;
}

// ---- OCR page cleanup -------------------------------------------------------------------
// Done before text recognition (and kept in the output page), like OCRmyPDF's --remove-background,
// --clean and --deskew:
//  • remove background (ImageMagick): divide the page by a blurred estimate of the paper, so grey or
//    yellow paper and uneven lighting become flat white (flat-fielding);
//  • clean (own code): remove isolated specks and clear dark scanner borders;
//  • deskew (ImageMagick): measure and undo the skew; the page keeps its size.
// Returns the cleaned page as an ImageBitmap plus the angle that was corrected.
async function ocrPrep(bmp, o) {
  const W = bmp.width, H = bmp.height;
  const c = new OffscreenCanvas(W, H), g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.drawImage(bmp, 0, 0); bmp.close();
  let angle = 0, magickOk = true;
  if (o.background || o.deskew) {
    try {
      const M = await loadMagick();
      const { ImageMagick, MagickReadSettings, MagickFormat, Percentage, MagickColor, MagickGeometry, CompositeOperator } = M;
      const img = g.getImageData(0, 0, W, H);
      let out = null, ow = W, oh = H;
      ImageMagick.read(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length),
        new MagickReadSettings({ format: MagickFormat.Rgba, width: W, height: H }), (im) => {
          if (o.background) {
            // the paper: shrink, blur, grow back (a big blur, cheaply), then page / paper
            im.clone((bg) => {
              const small = new MagickGeometry(Math.max(8, Math.round(W / 8)), Math.max(8, Math.round(H / 8))); small.ignoreAspectRatio = true;
              bg.resize(small); bg.blur(0, 6);
              const full = new MagickGeometry(W, H); full.ignoreAspectRatio = true; bg.resize(full);
              // page ÷ paper. (ImageMagick's naming: "Divide_Src" divides the destination — the page — by the
              // source — the blurred paper — as in the usual `-compose Divide_Src -composite` flat-field recipe.)
              im.composite(bg, CompositeOperator.DivideSrc);
            });
            im.level(new Percentage(8), new Percentage(96));   // restore ink contrast after flattening
          }
          if (o.deskew) {
            im.backgroundColor = new MagickColor(255, 255, 255);
            angle = im.deskew(new Percentage(40));
          }
          ow = im.width; oh = im.height;
          im.write(MagickFormat.Rgba, (data) => { out = new Uint8ClampedArray(data); });
        });
      if (out) {
        // deskew grows the frame: centre the result back into the page's own size
        const t = new OffscreenCanvas(ow, oh); t.getContext("2d").putImageData(new ImageData(out, ow, oh), 0, 0);
        g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.drawImage(t, Math.round((W - ow) / 2), Math.round((H - oh) / 2));
      }
    } catch (err) { magickOk = false; }
  }
  if (o.clean) cleanPage(g, W, H);
  return { bmp: c.transferToImageBitmap(), angle, magickOk };
}

// Remove small isolated dark specks (connected dark areas below a size) and dark scanner borders.
function cleanPage(g, W, H) {
  const img = g.getImageData(0, 0, W, H), d = img.data, n = W * H;
  const dark = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) dark[i] = (54 * d[p] + 183 * d[p + 1] + 19 * d[p + 2]) >> 8 < 140 ? 1 : 0;
  // dark borders: from each edge, clear rows / columns that are mostly dark (up to 6% of the page)
  const whiten = (i) => { const p = i * 4; d[p] = d[p + 1] = d[p + 2] = 255; dark[i] = 0; };
  const rowDark = (y) => { let s = 0; for (let x = 0; x < W; x++) s += dark[y * W + x]; return s > W * 0.5; };
  const colDark = (x) => { let s = 0; for (let y = 0; y < H; y++) s += dark[y * W + x]; return s > H * 0.5; };
  for (let y = 0; y < H * 0.06 && rowDark(y); y++) for (let x = 0; x < W; x++) whiten(y * W + x);
  for (let y = H - 1; y > H * 0.94 && rowDark(y); y--) for (let x = 0; x < W; x++) whiten(y * W + x);
  for (let x = 0; x < W * 0.06 && colDark(x); x++) for (let y = 0; y < H; y++) whiten(y * W + x);
  for (let x = W - 1; x > W * 0.94 && colDark(x); x--) for (let y = 0; y < H; y++) whiten(y * W + x);
  // specks: dark 8-connected areas smaller than ~0.015% of the page (about 3x3 px at 300 dpi per 1000 px of width)
  const maxArea = Math.max(4, Math.round(Math.max(W, H) / 400) ** 2);
  // each pixel taken off the stack can add up to 8 neighbours, and at most maxArea are taken before "big"
  const seen = new Uint8Array(n), stack = new Int32Array(8 * maxArea + 16), comp = new Int32Array(maxArea + 1);
  // a removed speck is filled with the paper colour around it (not pure white, which shows on grey paper)
  const paperAround = (x0, y0, x1, y1) => {
    let r = 0, gg = 0, b = 0, k = 0;
    const cx = (x0 + x1) >> 1, cy = (y0 + y1) >> 1;
    for (const [x, y] of [[x0 - 2, cy], [x1 + 2, cy], [cx, y0 - 2], [cx, y1 + 2]]) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x; if (dark[i]) continue;
      const p = i * 4; r += d[p]; gg += d[p + 1]; b += d[p + 2]; k++;
    }
    return k ? [r / k, gg / k, b / k] : [255, 255, 255];
  };
  for (let s = 0; s < n; s++) {
    if (!dark[s] || seen[s]) continue;
    let sp = 0, cn = 0, big = false; stack[sp++] = s; seen[s] = 1;
    let bx0 = W, by0 = H, bx1 = 0, by1 = 0;
    while (sp) {
      const i = stack[--sp];
      if (cn <= maxArea) comp[cn] = i;
      cn++;
      { const x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
      if (cn > maxArea) { big = true; }
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (dark[j] && !seen[j]) { seen[j] = 1; if (!big) stack[sp++] = j; else markRest(j); }
      }
      if (big && sp === 0) break;
    }
    if (!big) {
      const [r, gg, b] = paperAround(bx0, by0, bx1, by1);
      for (let k = 0; k < cn; k++) { const p = comp[k] * 4; d[p] = r; d[p + 1] = gg; d[p + 2] = b; dark[comp[k]] = 0; }
    }
  }
  // a big area: mark the rest of it as seen without keeping it (iterative, bounded memory)
  function markRest(j0) {
    const st = [j0];
    while (st.length) {
      const i = st.pop(), x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx; if (dark[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
  }
  g.putImageData(img, 0, 0);
}

self.onmessage = async (e) => {
  if (e.data && e.data.warm) { loadMagick().catch(() => {}); return; }   // pre-fetch the realistic engine
  if (e.data && e.data.op === "ocrprep") {
    const { id, bmp, o } = e.data;
    try { const r = await ocrPrep(bmp, o); self.postMessage({ id, kind: "ocrprep", ...r }, [r.bmp]); }
    catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
    return;
  }
  const { id, bmp, p, out } = e.data;
  try {
    const W = bmp.width, H = bmp.height;
    const c = new OffscreenCanvas(W, H), g = c.getContext("2d", { willReadFrequently: true });
    // 1) blur on the GPU while drawing the page in (if this browser supports canvas filters)
    const gpuBlur = p.blur > 0.3 && canvasFilters();
    if (gpuBlur) g.filter = `blur(${p.blur}px)`;
    g.drawImage(bmp, 0, 0); g.filter = "none"; bmp.close();
    // 2) pixel work in the chosen engine
    let img = g.getImageData(0, 0, W, H);
    if (p.engine === "realistic") img = await realisticPass(img, p, gpuBlur);
    else img = fastPass(await loadWasm(out.wasmUrl), img, p, gpuBlur);
    g.putImageData(img, 0, 0);
    // 3) vignette, blemishes, border
    if (p.on) blemish(g, W, H, p.blem || 0);
    if (p.on && p.border) { const bw = Math.max(4, W * 0.006); g.strokeStyle = "rgba(22,19,14,0.9)"; g.lineWidth = bw; g.strokeRect(bw / 2, bw / 2, W - bw, H - bw); }
    // 4) tilt (and trim back to the page size for PDFs)
    const fin = tilt(c, p.angle || 0, out.trimW, out.trimH);
    // 5) encode
    if (p.cspace === "bilevel") {
      const X = await loadWasm(out.wasmUrl), fw = fin.width, fh = fin.height;
      const d = fin.getContext("2d").getImageData(0, 0, fw, fh).data, ptr = wasmBuf(X, d.length);
      new Uint8Array(X.memory.buffer, ptr, d.length).set(d);
      const len = X.pack_bilevel(ptr, fw, fh, 128);
      const bits = new Uint8Array(X.memory.buffer, X.result_ptr(), len).slice();
      self.postMessage({ id, kind: "bilevel", bits, w: fw, h: fh }, [bits.buffer]);
      return;
    }
    const blob = await fin.convertToBlob({ type: out.type || "image/jpeg", quality: out.quality });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, kind: "image", buf, w: fin.width, h: fin.height }, [buf]);
  } catch (err) {
    try { bmp && bmp.close && bmp.close(); } catch (_) {}
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
