// Encodes page pictures (JPEG / PNG) off the main thread.
// The page arrives as a transferred ImageBitmap (no copy) and goes back as a transferred
// ArrayBuffer of file bytes, ready for pdf-lib's embedJpg / embedPng.
// Why a worker: on the main thread, toDataURL blocks the UI while it encodes, and toBlob /
// convertToBlob wait for an idle slot that can add ~1 s per page. Here it's ~50 ms, unblocked.
self.onmessage = async (e) => {
  const { id, bmp, type, quality } = e.data;
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext("2d").drawImage(bmp, 0, 0);
    bmp.close();
    const blob = await c.convertToBlob({ type, quality });
    const buf = await blob.arrayBuffer();
    self.postMessage({ id, buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
