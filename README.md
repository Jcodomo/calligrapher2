# Calligrapher 2.0

An original, web-deployable calligraphy / handwriting generator. The engine is
written in **Rust**, compiled to **WebAssembly**, and driven by a dependency-free
HTML/JS front-end. Type text, get handwritten strokes, export SVG or PNG.

Nothing in this project is derived from any third-party binary, font, or trained
model. The letterforms are hand-authored parametric pen strokes, and the
variation, cursive joining, and nib weighting are implemented from scratch.

## How it works

1. **Glyphs** — each character is an original set of control polylines in em
   units (`src/lib.rs`, `glyph()`), with entry/exit points for cursive joins.
2. **Smoothing** — Catmull-Rom turns sparse control points into dense curves.
3. **Variation** — seeded SplitMix64 + value noise add per-run jitter, baseline
   wobble, slant and size drift, so no two renders are identical.
4. **Nib weight** — pen "speed" (vertex spacing) modulates stroke width, giving
   a calligraphic thick/thin contrast.
5. **Output** — strokes become variable-width filled SVG paths
   (`fill="currentColor"`, so ink colour is pure CSS).

The WASM/JS boundary is a tiny C ABI: `alloc`, `dealloc`, `generate`,
`result_ptr`, plus the module's linear `memory`. No wasm-bindgen.

## Features

- **Modes:** Writing (multi-line, word-wrapped) and Signature (single line with
  a flourish swash).
- **Original-style controls:** Style (Random / Casual / Formal / Neat / Scrawl /
  Marker / Signature), Speed, Legibility, Thickness.
- **Realism toggles:** Vary each letter, Natural movement, Inkflow (pen
  pressure), Tilt each letter.
- **Import a signature image:** upload or paste a photo/scan of a signature; it
  is traced to a clean, recolorable, scalable vector (marching-squares + RDP),
  usable on documents and exportable. "Match style" estimates the sample's
  slant and weight for typing. (For signatures you are authorized to use.)
- **Sign / write on a document:** upload a **PDF** (rendered with pdf.js) or an
  image, drag the writing to position it, pick the page, and export.
- **Scan & finish:** scanned look (rotation-free vignette + page blemishes),
  blemish amount, blur, sharpness (unsharp mask), and export resolution (1–4×).
- **Page look:** ink & paper swatches + custom colour pickers; procedural paper
  textures (fiber / grain / cold-press / canvas / crumple) with intensity;
  blank / ruled / grid guides.
- **Write-on animation** with adjustable speed, baked into exported SVG.
- **Export** PNG, **PDF** (jsPDF), and SVG; **shareable links** encode the whole
  composition in the URL.
- Advanced: size, slant, nib contrast, spacing, line height, alignment, seed,
  transparent PNG background.

## Build

Prerequisites: `rustup` with the wasm target.

```bash
rustup target add wasm32-unknown-unknown
./build.sh
```

## Run locally

```bash
node server.js
# open http://localhost:8787
```

`server.js` is a zero-dependency static server that sets `application/wasm`
correctly (required for streaming instantiation).

## Deploy

It's fully static. Upload the **`web/`** folder (`index.html`, `app.js`,
`calligrapher2.wasm`) to any static host — GitHub Pages, Netlify, Cloudflare
Pages, S3, etc. No server code runs in production.

## Layout

```
calligrapher2/
├── src/lib.rs        # the Rust engine (glyphs, layout, rendering, WASM ABI)
├── web/
│   ├── index.html    # UI
│   ├── app.js        # WASM loader + controls + export
│   └── calligrapher2.wasm   # built engine (from build.sh)
├── server.js         # local dev server
├── build.sh          # build + stage
└── Cargo.toml
```

## Roadmap ideas

- Refine the lowercase letterforms and add proper capital designs.
- Richer cursive ligatures (true single-stroke words).
- More "hands" as seed+parameter presets; per-letter alternates.
- Paper textures and pressure-curve presets (fountain pen, brush, pencil).
- Optional neural backend (Graves handwriting model) behind the same UI.

## License

MIT. Your project, yours to deploy and modify.
