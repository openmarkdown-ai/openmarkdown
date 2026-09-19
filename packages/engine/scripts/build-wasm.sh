#!/usr/bin/env bash
# Builds crates/vault-wasm for wasm32 and generates the wasm-bindgen glue into
# packages/engine/src/wasm-gen/, which the web app and the clipper import.
# Run before `vite build`; Vite never touches Rust.
set -euo pipefail
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:$PATH"

: "${CARGO_TARGET_DIR:=${TMPDIR:-/tmp}/openmarkdown-target}"
export CARGO_TARGET_DIR
export CARGO_INCREMENTAL=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
WORKSPACE_DIR="$(dirname "$(dirname "$PKG_DIR")")"
OUT_DIR="$PKG_DIR/src/wasm-gen"

cargo build -p vault-wasm --target wasm32-unknown-unknown --release \
  --manifest-path "$WORKSPACE_DIR/Cargo.toml"

# The CLI and the crate must be the same version or glue generation fails on a
# schema mismatch — hence the `=0.2.126` pin in the workspace manifest.
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: wasm-bindgen not on PATH — cargo install wasm-bindgen-cli --version 0.2.126 --locked" >&2
  exit 1
fi
wasm-bindgen --target web --out-dir "$OUT_DIR" --out-name vault_wasm \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/vault_wasm.wasm"

# wasm-opt is a size optimisation, never a correctness requirement.
if command -v wasm-opt >/dev/null 2>&1; then
  WASM="$OUT_DIR/vault_wasm_bg.wasm"
  if wasm-opt -Oz --enable-bulk-memory --enable-nontrapping-float-to-int \
      --enable-sign-ext --enable-mutable-globals --enable-reference-types \
      -o "$WASM.opt" "$WASM" 2>/dev/null && [ -s "$WASM.opt" ]; then
    mv "$WASM.opt" "$WASM"
    echo "wasm-opt: optimised"
  else
    rm -f "$WASM.opt"
    echo "wasm-opt: refused this module — keeping the unoptimised build"
  fi
fi

ls -lh "$OUT_DIR"/vault_wasm_bg.wasm | awk '{print "wasm size:", $5}'
gzip -9 -c "$OUT_DIR"/vault_wasm_bg.wasm | wc -c | awk '{printf "wasm gzip: %.0f KB\n", $1/1024}'
