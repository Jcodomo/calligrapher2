# Neural backend (private build)

This branch (`neural-backend`) adds an optional **neural handwriting engine** to
Calligrapher 2: an in-browser port of the Graves text-conditioned
handwriting-synthesis RNN (3× LSTM-400, K=10 attention, M=20 mixture-density
output), matching `sjvasquez/handwriting-synthesis` / calligrapher.ai.

## UI
- **Simple** — the classic original app: Random + Hand 1–9 (each a fixed sampling
  seed), Speed, Legibility (→ sampling bias), Thickness, Ink, Seed, Export.
- **Advanced** — the neural engine plus every Calligrapher 2 feature: named-style
  presets, realism toggles, paper/texture/guides, signature tracing, document
  signing, scan & finish, animation, export.

Neural output is emitted as the same SVG shape the procedural engine uses, so ink,
paper, texture, animation and export apply on top unchanged.

## Model files (not in git)
The engine loads `web/model/weights.bin` (~15 MB) + `web/model/weights.json`.
These are **gitignored** — the weights come from a model trained on the IAM
On-Line Handwriting Database (academic / non-commercial), so they must not be
committed to a public repo or shipped on the public deploy. Get them from the
private backup, or regenerate with `extract_weights.py` from the upstream
`checkpoints/model-17900`.

## Licensing / deployment
The public `main` branch and the live site (jcodomo.github.io/calligrapher2) stay
the **original procedural** engine. This neural branch is a **private** build:
GirkovArpa's upstream is unlicensed, and the model is IAM-trained, so do not make
this branch or its weights public or commercial without clearing those terms.

## Run locally
    node server.js   # http://localhost:8787
Put the model files in `web/model/` first.

## Known follow-up
Sampling runs ~3 s/line on the main thread (brief UI freeze). Moving it to a Web
Worker would make it non-blocking.
