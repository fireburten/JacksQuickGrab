#!/usr/bin/env bash
# Compiles the Vision OCR helpers into universal (arm64 + x86_64) binaries in bin/.
# Shipping precompiled binaries avoids needing Xcode CLT at runtime and keeps the
# app App Store / sandbox compliant (no runtime `swift` interpretation).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-ocr: not macOS, skipping OCR binary build."
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT/scripts"
OUT_DIR="$ROOT/bin"
MIN_MACOS="12"
ARCHS=(arm64 x86_64)
NAMES=(ocr ocr-table)

mkdir -p "$OUT_DIR"

TMP_DIR=""
cleanup() {
  if [[ -n "$TMP_DIR" ]]; then rm -r "$TMP_DIR"; fi
}
trap cleanup EXIT

ensure_tmp() {
  if [[ -z "$TMP_DIR" ]]; then
    TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/build-ocr.XXXXXX")"
    # Avoids swiftc failing when the default module cache location isn't writable.
    export CLANG_MODULE_CACHE_PATH="$TMP_DIR/module-cache"
    mkdir -p "$CLANG_MODULE_CACHE_PATH"
  fi
}

for name in "${NAMES[@]}"; do
  src="$SRC_DIR/$name.swift"
  out="$OUT_DIR/$name"

  if [[ ! -f "$src" ]]; then
    echo "build-ocr: missing source $src" >&2
    exit 1
  fi

  if [[ -x "$out" && "$out" -nt "$src" ]]; then
    echo "build-ocr: bin/$name is up to date."
    continue
  fi

  ensure_tmp
  slices=()
  for arch in "${ARCHS[@]}"; do
    slice="$TMP_DIR/$name-$arch"
    echo "build-ocr: compiling $name for $arch..."
    xcrun swiftc -O \
      -target "$arch-apple-macos$MIN_MACOS" \
      -module-cache-path "$CLANG_MODULE_CACHE_PATH" \
      -o "$slice" "$src"
    slices+=("$slice")
  done

  lipo -create "${slices[@]}" -output "$out.tmp"
  chmod +x "$out.tmp"
  mv -f "$out.tmp" "$out"
  echo "build-ocr: built bin/$name ($(lipo -archs "$out"))."
done
