// Password protection for PDFs, in the browser: the standard security handler at its strongest level
// (AES-256, revision 6 - PDF 2.0, read by Acrobat X and later, Chrome, Edge, Firefox, macOS Preview and pdf.js).
// Every string and stream of the document is encrypted with a random 256-bit file key; the key is stored wrapped by
// the open password (UE) and by the owner password (OE), and the permissions are sealed with it (Perms).
// Uses only WebCrypto (SHA-256/384/512, AES-CBC). Nothing leaves the browser.

const te = new TextEncoder();
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const cat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (alg, d) => new Uint8Array(await crypto.subtle.digest(alg, d));
async function aesCbc(key, iv, data, bits) {   // AES-CBC; WebCrypto pads, so callers take the length they need
  const k = await crypto.subtle.importKey("raw", key, { name: "AES-CBC", length: bits }, false, ["encrypt"]);
  return new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, k, data));
}
// a password as the standard asks: Unicode normalised (SASLprep is close to NFKC), UTF-8, at most 127 bytes
export const pwBytes = (s) => te.encode(String(s || "").normalize("NFKC")).slice(0, 127);

// ISO 32000-2, 7.6.4.3.4 (algorithm 2.B): the hash revision 6 uses for every password check
export async function hash2B(pw, salt, udata = new Uint8Array(0)) {
  let K = await sha("SHA-256", cat(pw, salt, udata)), E, i = 0;
  while (i < 64 || E[E.length - 1] > i - 32) {
    const one = cat(pw, K, udata), K1 = new Uint8Array(one.length * 64);
    for (let r = 0; r < 64; r++) K1.set(one, r * one.length);
    E = (await aesCbc(K.slice(0, 16), K.slice(16, 32), K1, 128)).slice(0, K1.length);
    let m = 0; for (let k = 0; k < 16; k++) m += E[k];
    K = await sha(["SHA-256", "SHA-384", "SHA-512"][m % 3], E);
    i++;
  }
  return K.slice(0, 32);
}

// permission bits (ISO 32000, table 22); bits 1-2 clear, 7-8 and 13-32 set
export function permBits({ print = true, copy = true, modify = true, annotate = true, fill = true, assemble = true } = {}) {
  let p = 0xFFFFF0C0;
  if (print) p |= (1 << 2) | (1 << 11);
  if (modify) p |= 1 << 3;
  if (copy) p |= (1 << 4) | (1 << 9);
  if (annotate) p |= 1 << 5;
  if (fill) p |= 1 << 8;
  if (assemble) p |= 1 << 10;
  return p | 0;   // as a signed 32-bit number, the way /P is written
}

/**
 * Encrypt a pdf-lib document in place. Save it afterwards with { useObjectStreams: false, updateFieldAppearances: false }.
 * @param L   pdf-lib
 * @param pdf PDFDocument
 * @param o   { user: open password, owner: password for changing permissions (default: a random one), perms }
 */
export async function encryptPdf(L, pdf, o = {}) {
  const user = pwBytes(o.user), owner = o.owner ? pwBytes(o.owner) : rand(24);
  await pdf.flush();   // fonts, pictures and embedded pages become streams now, so every stream is encrypted
  const ctx = pdf.context, N = (s) => L.PDFName.of(s);
  const fileKey = rand(32);
  const uvs = rand(8), uks = rand(8), ovs = rand(8), oks = rand(8);
  const U = cat(await hash2B(user, uvs), uvs, uks);
  const UE = (await aesCbc(await hash2B(user, uks), new Uint8Array(16), fileKey, 256)).slice(0, 32);
  const O = cat(await hash2B(owner, ovs, U), ovs, oks);
  const OE = (await aesCbc(await hash2B(owner, oks, U), new Uint8Array(16), fileKey, 256)).slice(0, 32);
  const P = permBits(o.perms);
  const pb = new Uint8Array(16); new DataView(pb.buffer).setInt32(0, P, true); pb.set([255, 255, 255, 255, 84, 97, 100, 98], 4); pb.set(rand(4), 12);
  const Perms = (await aesCbc(fileKey, new Uint8Array(16), pb, 256)).slice(0, 16);

  const key = await crypto.subtle.importKey("raw", fileKey, { name: "AES-CBC", length: 256 }, false, ["encrypt"]);
  const enc = async (bytes) => { const iv = rand(16); return cat(iv, new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, bytes))); };
  const isStr = (v) => v instanceof L.PDFString || v instanceof L.PDFHexString;
  const encStr = async (v) => L.PDFHexString.of(hex(await enc(v.asBytes())));
  // strings anywhere inside an object (direct objects only; indirect ones are visited on their own)
  async function walk(v) {
    if (v instanceof L.PDFDict) { for (const [k, x] of v.entries()) { if (isStr(x)) v.set(k, await encStr(x)); else await walk(x); } }
    else if (v instanceof L.PDFArray) { for (let i = 0; i < v.size(); i++) { const x = v.get(i); if (isStr(x)) v.set(i, await encStr(x)); else await walk(x); } }
  }
  const objs = [...ctx.enumerateIndirectObjects()];
  for (const [ref, obj] of objs) {
    if (obj instanceof L.PDFStream) {
      const t = obj.dict.get(N("Type"));
      if (t === N("XRef")) continue;
      const bytes = obj.getContents();
      const nd = obj.dict.clone(ctx); nd.delete(N("Length"));
      await walk(nd);
      ctx.assign(ref, L.PDFRawStream.of(nd, await enc(bytes)));
    } else if (isStr(obj)) ctx.assign(ref, await encStr(obj));
    else await walk(obj);
  }
  const encDict = ctx.obj({ Filter: "Standard", V: 5, R: 6, Length: 256, P,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } }, StmF: "StdCF", StrF: "StdCF", EncryptMetadata: true });
  encDict.set(N("O"), L.PDFHexString.of(hex(O))); encDict.set(N("U"), L.PDFHexString.of(hex(U)));
  encDict.set(N("OE"), L.PDFHexString.of(hex(OE))); encDict.set(N("UE"), L.PDFHexString.of(hex(UE)));
  encDict.set(N("Perms"), L.PDFHexString.of(hex(Perms)));
  ctx.trailerInfo.Encrypt = ctx.register(encDict);
  const id = L.PDFHexString.of(hex(rand(16)));
  ctx.trailerInfo.ID = ctx.obj([id, id]);
  return { P };
}

// encrypt and save in one go
export async function protectedBytes(L, pdf, o) {
  await encryptPdf(L, pdf, o);
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false, addDefaultPage: false });
}
