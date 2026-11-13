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

- Live preview with multi-line text and word-wrap to the canvas width.
- Controls: size, slant, variation, weight, nib contrast, letter spacing, line
  height, seed, and **left / centre / right alignment**.
- Style presets: Casual, Formal, Scrawl, Marker.
- "New hand" reseeds for a fresh variation of the same text.
- Ink & paper **swatches plus custom colour pickers**; blank / ruled / grid
  paper guides; dark/light-aware UI.
- **Write-on animation** (left-to-right reveal, baked into the exported SVG).
- Export **SVG** (vector) and **PNG** (2×, optional transparent background), or
  copy SVG markup.
- **Shareable links** — the full composition is encoded in the URL, so a link
  reproduces the exact piece.

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
