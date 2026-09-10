#!/bin/sh
# Run the same gate CI runs: Rust engine, typecheck, JS tests, lint, build.
# Standalone script because the rustup toolchain is not on PATH by default.
set -e
cd "$(dirname "$0")"

export PATH="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH"

echo "── engine tests (cargo) ──────────────────────────────"
cargo test --manifest-path packages/editor/engine/Cargo.toml

echo "── typecheck (tsc, per package) ──────────────────────"
# One tsconfig per workspace package; there is no root program to check.
for pkg in editor app mcp; do
    echo "  packages/$pkg"
    ./node_modules/.bin/tsc --noEmit -p "packages/$pkg"
done

echo "── JS tests (vitest) ─────────────────────────────────"
./node_modules/.bin/vitest run

echo "── lint and format (biome) ───────────────────────────"
./node_modules/.bin/biome check

echo "── production build (vite) ───────────────────────────"
./node_modules/.bin/vite build packages/app

echo "── all green ─────────────────────────────────────────"
