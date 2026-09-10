/**
 * Dev-only stress harness — answers "how many shapes can this thing hold?".
 *
 * Exposed as `window.__editor.stress()` in dev builds only. It measures two
 * things that scale independently:
 *
 *   1. Insertion throughput — time to bulk-create shapes via the engine's
 *      batched `add_rects` (one `bulk_load` of the R-tree, O(n log n)).
 *   2. Steady-state render cost — real requestAnimationFrame frame pacing while
 *      forcing a *cold* full re-render every frame (path caches invalidated), so
 *      the number reflects a worst case like dragging the whole scene, not a
 *      warm redraw. FPS is bounded by the display refresh rate; watch for it
 *      dropping below that, and read `msPerFrame` for headroom.
 *
 * The benchmark runs on a throwaway engine and restores the open document when
 * it finishes, so it never touches your real work. Results are printed with
 * console.table and returned.
 *
 * Usage from the browser console:
 *   await window.__editor.stress()                     // default sweep
 *   await window.__editor.stress({ steps: [1e3, 1e5] }) // custom counts
 */

import { Engine } from '../engine/pkg/engine';
import type { Renderer } from './renderer';
import type { WasmScene } from './wasm_scene';

export interface StressOptions {
    /** Cumulative shape counts to measure at. Default: 1k → 200k. */
    steps?: number[];
    /** Milliseconds of real rAF sampling per step. Default: 600. */
    sampleMs?: number;
}

export interface StressRow {
    shapes: number;
    /** Shapes intersecting the measured viewport (all of them, by construction). */
    visible: number;
    /** Wall time to insert this step's new shapes (ms). */
    addMs: number;
    /** Per-shape insertion cost at this scene size (µs). */
    usPerShape: number;
    /** Real frames/sec with a cold full re-render each frame (display-capped). */
    realFps: number;
    /** Wall time of one cold full re-render (ms). */
    msPerFrame: number;
    /** Approx WASM linear memory in use (MB). */
    wasmMB: number;
}

interface StressDeps {
    scene: WasmScene;
    renderer: Renderer;
    wasm: { memory: WebAssembly.Memory } | null;
}

const DEFAULT_STEPS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000];

/** Count real rAF frames over `durMs`, forcing a cold re-render each frame. */
function sampleRealFps(renderer: Renderer, durMs: number): Promise<{ fps: number; ms: number }> {
    return new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const step = () => {
            const now = performance.now();
            if (now - t0 >= durMs) {
                const secs = (now - t0) / 1000;
                resolve({
                    fps: +(frames / secs).toFixed(1),
                    ms: +((now - t0) / frames).toFixed(2),
                });
                return;
            }
            // Drop path/geometry caches so this is a full cold render, not a warm
            // redraw — the honest worst case.
            renderer.invalidateRenderCaches();
            renderer.render();
            frames++;
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
}

export async function runStress(deps: StressDeps, opts: StressOptions = {}): Promise<StressRow[]> {
    const { scene, renderer } = deps;
    const steps = (opts.steps ?? DEFAULT_STEPS).slice().sort((a, b) => a - b);
    const sampleMs = opts.sampleMs ?? 600;

    // World rectangle currently on screen, so every generated shape is visible
    // (no viewport culling skews the render numbers).
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const zoom = renderer.zoom;
    const sx = -renderer.pan.x / zoom;
    const sy = -renderer.pan.y / zoom;
    const vw = canvas.width / zoom;
    const vh = canvas.height / zoom;

    const wasmMB = () =>
        deps.wasm ? +(deps.wasm.memory.buffer.byteLength / 1_048_576).toFixed(1) : 0;

    // Isolate the benchmark on a throwaway engine; restore the real one after.
    const original = scene.engine;
    const bench = new Engine();
    scene.engine = bench;
    scene.invalidateCache(false);

    const rows: StressRow[] = [];
    try {
        let total = 0;
        for (const target of steps) {
            const add = target - total;
            total = target;

            // Tile the new shapes across the viewport in a rough grid.
            const cols = Math.ceil(Math.sqrt(target));
            const cw = vw / cols;
            const ch = vh / cols;
            const rects: number[][] = new Array(add);
            for (let i = 0; i < add; i++) {
                const idx = target - add + i;
                const c = idx % cols;
                const r = (idx / cols) | 0;
                rects[i] = [sx + c * cw, sy + r * ch, cw * 0.7, ch * 0.7];
            }

            const t0 = performance.now();
            bench.add_rects(JSON.stringify(rects));
            const addMs = performance.now() - t0;
            scene.invalidateCache();

            const visible = bench.get_visible_nodes(sx, sy, sx + vw, sy + vh).length;
            // Yield so the freshly-added scene settles before we sample frames.
            await new Promise((r) => setTimeout(r, 30));
            const fps = await sampleRealFps(
                renderer,
                target >= 50_000 ? Math.min(sampleMs, 400) : sampleMs,
            );

            rows.push({
                shapes: target,
                visible,
                addMs: +addMs.toFixed(0),
                usPerShape: +((addMs * 1000) / add).toFixed(1),
                realFps: fps.fps,
                msPerFrame: fps.ms,
                wasmMB: wasmMB(),
            });
            await new Promise((r) => setTimeout(r, 0));
        }
    } finally {
        // Restore the user's real document no matter what.
        scene.engine = original;
        scene.invalidateCache(false);
        renderer.invalidateRenderCaches();
        renderer.render();
    }

    // eslint-disable-next-line no-console
    console.table(rows);
    return rows;
}
