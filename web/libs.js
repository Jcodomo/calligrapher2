// On-demand loading of the big PDF libraries (pdf.js to read/render, pdf-lib to write).
// They used to be <script> tags on every visit (about 1.2 MB of JS parsed before anything
// else could run, and pdf.js blocked the first paint). Now each loads once, the first time
// it's needed, and both are warmed up in the background once the page is idle, so a
// click on "Open PDF" or "Download" rarely has to wait.

export const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
export const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
export const PDFLIB_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js";

const loading = new Map();
function loadScript(src, what) {
  if (!loading.has(src)) {
    loading.set(src, new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => { loading.delete(src); s.remove(); rej(new Error(`Could not load the ${what} - check the internet connection and try again.`)); };
      document.head.appendChild(s);
    }));
  }
  return loading.get(src);
}

// pdf.js, ready to use (worker configured)
export async function pdfjsReady() {
  if (!window.pdfjsLib) await loadScript(PDFJS_URL, "PDF reader");
  const pj = window.pdfjsLib;
  if (!pj.GlobalWorkerOptions.workerSrc) pj.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return pj;
}

// pdf-lib, ready to use
export async function pdfLibReady() {
  if (!window.PDFLib) await loadScript(PDFLIB_URL, "PDF maker");
  return window.PDFLib;
}

// Load both in the background after the first paint, without competing with startup.
export function warmPdfLibs() {
  const go = () => { pdfjsReady().catch(() => {}); pdfLibReady().catch(() => {}); };
  if ("requestIdleCallback" in window) requestIdleCallback(go, { timeout: 4000 });
  else setTimeout(go, 1500);
}

// A canvas as image file bytes (for pdf-lib's embedJpg / embedPng). Replaces
// dataURLtoU8(c.toDataURL(...)). The encode runs in a worker (encode-worker.js): measured on a
// 300-dpi page, ~50 ms with the UI free, versus toDataURL blocking the UI and main-thread
// toBlob/convertToBlob waiting ~1 s for an idle slot. It also skips the base64 round trip
// (+33% memory). Browsers without OffscreenCanvas in workers use the old synchronous path.
let encWorker = null, encSeq = 0;
const encWait = new Map();
function encoder() {
  if (encWorker !== null) return encWorker;
  try {
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap !== "function" || typeof Worker === "undefined") throw 0;
    encWorker = new Worker(new URL("./encode-worker.js?v=1", import.meta.url));
    encWorker.onmessage = (e) => {
      const w = encWait.get(e.data.id); if (!w) return;
      encWait.delete(e.data.id);
      if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(new Uint8Array(e.data.buf));
    };
    encWorker.onerror = () => { for (const w of encWait.values()) w.reject(new Error("encoder stopped")); encWait.clear(); encWorker = false; };
  } catch (_) { encWorker = false; }
  return encWorker;
}
function dataUrlBytes(c, type, quality) {
  const u = c.toDataURL(type, quality), b = atob(u.split(",")[1]), a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}
export async function canvasBytes(c, type = "image/png", quality) {
  const w = encoder();
  if (w) {
    try {
      const bmp = await createImageBitmap(c);
      return await new Promise((resolve, reject) => {
        const id = ++encSeq; encWait.set(id, { resolve, reject });
        w.postMessage({ id, bmp, type, quality }, [bmp]);
      });
    } catch (_) { /* fall back to the synchronous encoder below */ }
  }
  return dataUrlBytes(c, type, quality);
}

// Start loading as soon as the user shows intent (hover / focus / touch on a control),
// the way Smallpdf preloads its editor: by the time the click lands, the library is usually there.
export function prefetchOn(el, ...loaders) {
  if (!el) return;
  const go = () => { for (const l of loaders) l().catch(() => {}); };
  for (const ev of ["pointerenter", "focusin", "touchstart"]) el.addEventListener(ev, go, { once: true, passive: true });
}
