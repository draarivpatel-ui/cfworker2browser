#!/bin/sh
# Downloads sql.js (SQLite as WebAssembly, for the D1 binding) into this folder and checks each file against a pinned sha256.
# The files are not in git. Only needed if your Worker uses D1.
set -eu
cd "$(dirname "$0")"
V=1.12.0
get() { # name url sha256
  if [ -f "$1" ] && echo "$3  $1" | shasum -a 256 -c - >/dev/null 2>&1; then echo "ok    $1"; return; fi
  curl -fsSL --retry 3 -o "$1.part" "$2"
  echo "$3  $1.part" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $1" >&2; rm -f "$1.part"; exit 1; }
  mv "$1.part" "$1"; echo "fetched $1"
}
get sql-wasm.js   "https://cdn.jsdelivr.net/npm/sql.js@$V/dist/sql-wasm.js"   43a1f4a4e43a3869ae290c55e67ffe166652bdc5aba5561e0e04eed7bf9651ee
get sql-wasm.wasm "https://cdn.jsdelivr.net/npm/sql.js@$V/dist/sql-wasm.wasm" 083460b3e9d428ebbbbaa03918ba55da33d810e0fb3470d4b5d8677b462b2c2b
