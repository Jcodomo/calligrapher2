#!/usr/bin/env bash
# Build the Calligrapher 2.0 WASM engine and stage it into web/.
# Requires: rustup + the wasm32-unknown-unknown target (no wasm-pack needed).
set -euo pipefail
cd "$(dirname "$0")"

CARGO="${CARGO:-cargo}"
command -v "$CARGO" >/dev/null || CARGO="$HOME/.cargo/bin/cargo"

echo "building wasm (release)…"
"$CARGO" build --release --target wasm32-unknown-unknown

cp target/wasm32-unknown-unknown/release/calligrapher2.wasm web/calligrapher2.wasm
echo "staged web/calligrapher2.wasm ($(wc -c < web/calligrapher2.wasm) bytes)"
echo
echo "run locally:   node server.js   then open http://localhost:8787"
echo "deploy:        upload the web/ folder to any static host"
