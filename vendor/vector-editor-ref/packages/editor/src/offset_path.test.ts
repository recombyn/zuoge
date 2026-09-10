/**
 * Offset Path — a parallel copy of what is on screen.
 *
 * The trap is per-vertex corner radii. They live beside the anchors rather than
 * in them, so reading a node's raw subpaths gives the polygon the radii were
 * rounding off: a rounded rectangle offset that way came back with the corners
 * of a sharp one, and the "parallel" copy was not parallel to anything the user
 * could see.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CanvasKit } from 'canvaskit-wasm';
import CanvasKitInit from 'canvaskit-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { computeOffsetSubpaths } from './offset_path';
import { evalCubic } from './path_ops';
import type { Subpath } from './types';
import { WasmScene } from './wasm_scene';

let ck: CanvasKit;
let wasmModule: { memory: WebAssembly.Memory };

beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
    ck = await CanvasKitInit({
        locateFile: (f: string) =>
            resolve('node_modules/.pnpm/canvaskit-wasm@0.39.1/node_modules/canvaskit-wasm/bin', f),
    });
}, 60_000);

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    return scene;
}

/** Closest approach of the outline to a point. */
function nearestTo(subpaths: Subpath[], px: number, py: number): number {
    let best = Infinity;
    for (const sp of subpaths) {
        const pts = sp.points;
        const segs = sp.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segs; i++)
            for (let s = 0; s <= 16; s++) {
                const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 16);
                best = Math.min(best, Math.hypot(x - px, y - py));
            }
    }
    return best;
}

/** A 100×100 rect with per-vertex corner radii, converted to a path. */
function roundedRect(scene: WasmScene, radius: number): number {
    const id = scene.engine!.add_rect(0, 0, 100, 100);
    const style = scene.getNodeStyle(id)!;
    scene.engine!.set_node_style(id, JSON.stringify({ ...style, corner_radius: radius }));
    scene.convertToPath(id);
    return id;
}

describe('Offset Path follows the rounded outline', () => {
    it('offsets a rounded rectangle as rounded, not as a sharp one', () => {
        const scene = makeScene();
        const id = roundedRect(scene, 20);
        const res = computeOffsetSubpaths(ck, scene, id, 10);
        expect(res).not.toBeNull();

        // Growing an r=20 corner by 10 gives r=30 about the same centre (20,20),
        // so the outline passes 42.43 − 30 = 12.43 from (−10,−10). Offsetting
        // the sharp polygon instead would put an r=10 arc about (0,0) there,
        // only 4.14 away.
        expect(nearestTo(res!.subpaths, -10, -10)).toBeCloseTo(12.43, 1);
    });

    it('still grows the shape by the distance asked for', () => {
        const scene = makeScene();
        const id = roundedRect(scene, 20);
        const res = computeOffsetSubpaths(ck, scene, id, 10)!;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const sp of res.subpaths)
            for (const p of sp.points) {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
            }
        expect(minX).toBeCloseTo(-10, 1);
        expect(maxX).toBeCloseTo(110, 1);
    });

    it('insets on a negative distance', () => {
        const scene = makeScene();
        const id = roundedRect(scene, 20);
        const res = computeOffsetSubpaths(ck, scene, id, -10)!;
        let minX = Infinity;
        let maxX = -Infinity;
        for (const sp of res.subpaths)
            for (const p of sp.points) {
                minX = Math.min(minX, p.x);
                maxX = Math.max(maxX, p.x);
            }
        expect(minX).toBeCloseTo(10, 1);
        expect(maxX).toBeCloseTo(90, 1);
    });

    it('leaves a plain polygon alone', () => {
        const scene = makeScene();
        // No radii: resolved and raw agree, so this is the unchanged path.
        const id = roundedRect(scene, 0);
        const res = computeOffsetSubpaths(ck, scene, id, 10)!;
        expect(nearestTo(res.subpaths, -10, -10)).toBeCloseTo(4.14, 1);
    });

    it('declines a zero or non-finite distance', () => {
        const scene = makeScene();
        const id = roundedRect(scene, 20);
        expect(computeOffsetSubpaths(ck, scene, id, 0)).toBeNull();
        expect(computeOffsetSubpaths(ck, scene, id, Number.NaN)).toBeNull();
    });
});
