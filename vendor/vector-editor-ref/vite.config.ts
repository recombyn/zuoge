import { defineConfig } from 'vite';

// Root config used only by Vitest. Unit tests are colocated in
// packages/editor/src/*.test.ts and run from the repo root, so the engine wasm
// path `packages/editor/engine/pkg/engine_bg.wasm` resolves relative to cwd.
// The engine itself is imported via a relative path from the editor sources, so
// no module alias is needed.
export default defineConfig({
    test: {
        environment: 'jsdom',
        include: ['packages/*/src/**/*.test.ts'],
    },
});
