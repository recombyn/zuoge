#!/usr/bin/env node
/**
 * KIT-ONLY: skip writing under rcb/render/vector (old SoA geom paint removed).
 * Wasm geom crate is unused by Kit ink; keep script as no-op success for predev.
 */
console.log('[build-wasm] skipped — Kit owns ink; rcb-wasm-geom not linked into paint path');
process.exit(0);
