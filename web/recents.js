// recents.js — remembers the last few opened documents (bytes + a thumbnail) in
// IndexedDB so both "Sign & scan" and "PDF editor" can reopen them instantly.
// Shared store, so a doc opened in either mode shows up in both.
const DB_NAME = "cal2recents", STORE = "docs", MAX = 10;

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(db, mode) { return db.transaction(STORE, mode).objectStore(STORE); }

export async function listRecents() {
  try {
    const db = await openDB();
    return await new Promise((res) => {
      const out = []; const cur = tx(db, "readonly").openCursor();
      cur.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out.sort((a, b) => b.ts - a.ts)); };
      cur.onerror = () => res(out);
    });
  } catch (_) { return []; }
}
export async function getRecent(id) {
  try { const db = await openDB(); return await new Promise((res) => { const r = tx(db, "readonly").get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); }); }
  catch (_) { return null; }
}
async function delRecent(id) {
  try { const db = await openDB(); await new Promise((res) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).delete(id); t.oncomplete = res; t.onerror = res; }); } catch (_) {}
}
export { delRecent };
// Keep the work done on a recent document (edits, page order, filled fields) with it, so reopening
// it brings everything back. Also moves it to the top of the list.
export async function saveRecentWork(id, work, thumb) {
  try {
    const db = await openDB();
    const rec = await new Promise((res) => { const r = tx(db, "readonly").get(id); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (!rec) return false;
    rec.work = work; rec.ts = Date.now(); if (thumb) rec.thumb = thumb;
    await new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); });
    return true;
  } catch (_) { return false; }
}
// A small clickable thumbnail card for a recent doc. onDelete fires on the × badge.
export function makeRecentCard(rec, onOpen, onDelete) {
  const card = document.createElement("div");
  card.className = "rec-card"; card.title = rec.name || "document";
  const safe = (rec.name || "doc").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  card.innerHTML = (rec.thumb ? `<img src="${rec.thumb}" alt="">` : `<div style="height:46px"></div>`) +
    `<div class="rn">${safe}</div>${rec.work ? '<div class="red" title="Your edits are saved with it">Edited</div>' : ""}<div class="rx" title="Remove">×</div>`;
  card.onclick = (e) => { if (e.target.classList.contains("rx")) { e.stopPropagation(); onDelete && onDelete(); return; } onOpen && onOpen(); };
  return card;
}
// Save a doc. `bytes` is a Uint8Array/ArrayBuffer; `thumb` a small dataURL. Dedupes
// by name+size so reopening the same file doesn't pile up, then prunes to MAX newest.
export async function saveRecent({ name, type, bytes, thumb }) {
  try {
    const db = await openDB();
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const size = u8.byteLength;
    const existing = await listRecents();
    // the same file opened again replaces its plain entry; an entry that holds your edits is kept
    for (const r of existing) if (r.name === name && r.size === size && !r.work) await delRecent(r.id);
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    const rec = { id, name: name || "document", type: type || "pdf", size, bytes: u8.slice().buffer, thumb: thumb || "", ts: Date.now() };
    await new Promise((res, rej) => { const t = db.transaction(STORE, "readwrite"); t.objectStore(STORE).put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); });
    const keep = (await listRecents()).slice(0, MAX).map((r) => r.id);
    for (const r of await listRecents()) if (!keep.includes(r.id)) await delRecent(r.id);
    return id;
  } catch (_) { return null; }
}

// ---- document memory: what was done to a document, kept apart from the 10 recent files, so a document that
// looks like one edited before (even another file) can be given the same edits. 40 newest are kept.
const MEM_DB = "cal2memory", MEM = "docs", MEM_MAX = 40;
function openMem() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(MEM_DB, 1);
    r.onupgradeneeded = () => { const db = r.result; if (!db.objectStoreNames.contains(MEM)) db.createObjectStore(MEM, { keyPath: "id" }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
export async function listMemory() {
  try {
    const db = await openMem();
    return await new Promise((res) => { const out = [], cur = db.transaction(MEM, "readonly").objectStore(MEM).openCursor(); cur.onsuccess = (e) => { const c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out.sort((a, b) => b.ts - a.ts)); }; cur.onerror = () => res(out); });
  } catch (_) { return []; }
}
export async function saveMemory(rec) {
  try {
    const db = await openMem();
    await new Promise((res, rej) => { const t = db.transaction(MEM, "readwrite"); t.objectStore(MEM).put(rec); t.oncomplete = res; t.onerror = () => rej(t.error); });
    const all = await listMemory();
    for (const r of all.slice(MEM_MAX)) await new Promise((res) => { const t = db.transaction(MEM, "readwrite"); t.objectStore(MEM).delete(r.id); t.oncomplete = res; t.onerror = res; });
    return true;
  } catch (_) { return false; }
}
export async function forgetMemory(id) {
  try { const db = await openMem(); await new Promise((res) => { const t = db.transaction(MEM, "readwrite"); t.objectStore(MEM).delete(id); t.oncomplete = res; t.onerror = res; }); } catch (_) {}
}
