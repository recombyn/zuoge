#!/usr/bin/env node
/**
 * Ensure vendor/vector-editor-ref exists (MIT reference engine + CanvasKit sources).
 * Run from repo root: node scripts/ensure-vector-editor-ref.mjs
 *
 * Sources are vendored in-tree only — this script never downloads remote tarballs.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'vendor', 'vector-editor-ref');
const marker = path.join(dest, 'packages', 'editor', 'engine', 'pkg', 'engine_bg.wasm');

if (existsSync(marker)) {
  console.log('[vector-editor-ref] ok');
  process.exit(0);
}

console.error(
  '[vector-editor-ref] missing: place the MIT reference engine at vendor/vector-editor-ref\n' +
    `  expected marker: ${path.relative(root, marker)}`
);
process.exit(1);
