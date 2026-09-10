/**
 * Crop: clip N shapes to the frontmost one, each keeping its own appearance.
 *
 * The distinction worth protecting is Crop vs Boolean › Intersect. Intersect
 * answers "what area do these share" — ONE shape with ONE style. Crop answers
 * "cut all of these by that one" and has to come back with N objects that still
 * look like themselves.
 *
 * Needs real CanvasKit (the path ops are Skia's), unlike the engine-only suites.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CanvasKit } from 'canvaskit-wasm';
import CanvasKitInit from 'canvaskit-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { applyCrop } from './boolean_ops';
import { isSolid } from './types';
import { WasmScene } from './wasm_scene';

let ck: CanvasKit;
let wasmModule: { memory: WebAssembly.Memory };

beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
    // pnpm keeps the real package under .pnpm; the top-level path is a symlink
    // that CanvasKit's own loader does not resolve.
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

/** Paint a node with a solid fill so we can tell the results apart. */
function paint(scene: WasmScene, id: number, r: number, g: number, b: number) {
    const style = scene.getNodeStyle(id);
    scene.engine!.set_node_style(id, JSON.stringify({ ...style, fills: [{ r, g, b, a: 1 }] }));
}

/** The node's first fill as a solid colour, or null if it has none. `Paint` is
 *  a union (solid | gradient | pattern), so it needs narrowing. */
function firstFill(scene: WasmScene, id: number) {
    const paint = scene.getNodeStyle(id)?.fills?.[0];
    return paint && isSolid(paint) ? paint : null;
}

describe('Crop — cut every shape by the front one', () => {
    /**
     * Three 100×100 rects in a row at y=0, and a 300×40 bar across them at y=30
     * as the frontmost shape. Every rect overlaps the bar in a 100×40 band.
     */
    function threeUnderABar() {
        const scene = makeScene();
        const a = scene.engine!.add_rect(0, 0, 100, 100);
        const b = scene.engine!.add_rect(120, 0, 100, 100);
        const c = scene.engine!.add_rect(240, 0, 100, 100);
        paint(scene, a, 1, 0, 0);
        paint(scene, b, 0, 1, 0);
        paint(scene, c, 0, 0, 1);
        const cutter = scene.engine!.add_rect(0, 30, 340, 40); // added last = frontmost
        return { scene, a, b, c, cutter };
    }

    it('returns one shape per input, not one merged shape', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();

        const made = applyCrop(ck, scene, [a, b, c, cutter]);

        expect(made).not.toBeNull();
        expect(made!.length).toBe(3);
        expect(Array.from(scene.engine!.get_root_nodes()).sort()).toEqual([...made!].sort());
    });

    it('each result keeps its OWN fill — the whole point over Intersect', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();

        const made = applyCrop(ck, scene, [a, b, c, cutter])!;

        const fills = made.map((id) => firstFill(scene, id));
        expect(fills.map((f) => [f?.r, f?.g, f?.b])).toEqual([
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
        ]);
    });

    it('clips each one to the cutter', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();

        const made = applyCrop(ck, scene, [a, b, c, cutter])!;

        // Each 100×100 rect becomes the 100×40 band where it met the bar.
        for (const id of made) {
            const [minX, minY, maxX, maxY] = scene.getNodeBounds(id);
            expect(maxX - minX).toBeCloseTo(100, 1);
            expect(maxY - minY).toBeCloseTo(40, 1);
            expect(minY).toBeCloseTo(30, 1);
        }
    });

    it('consumes the cutter', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();

        applyCrop(ck, scene, [a, b, c, cutter]);

        expect(scene.getNodeType(cutter)).toBeUndefined();
    });

    it('keeps the back-to-front order of what it cropped', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();

        const made = applyCrop(ck, scene, [a, b, c, cutter])!;

        // a was backmost and must stay backmost: roots are ordered bottom-first.
        const roots = Array.from(scene.engine!.get_root_nodes());
        expect(roots).toEqual(made);
        expect(firstFill(scene, roots[0])?.r).toBe(1); // the red one, still at the back
    });

    it('drops a shape that misses the cutter entirely, keeping the rest', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();
        const miss = scene.engine!.add_rect(0, 500, 50, 50); // nowhere near the bar
        paint(scene, miss, 1, 1, 0);
        // Re-add the cutter on top so it stays frontmost.
        const front = scene.engine!.add_rect(0, 30, 340, 40);
        scene.engine!.remove_node(cutter);

        const made = applyCrop(ck, scene, [a, b, c, miss, front])!;

        expect(made.length).toBe(3);
        expect(
            made.some((id) => firstFill(scene, id)?.g === 1 && firstFill(scene, id)?.r === 1),
        ).toBe(false);
    });

    it('declines rather than emptying the canvas when nothing overlaps', () => {
        // An op whose entire result is "your selection is gone" is a mistake far
        // more often than an intention.
        const scene = makeScene();
        const a = scene.engine!.add_rect(0, 0, 50, 50);
        const b = scene.engine!.add_rect(0, 80, 50, 50);
        const cutter = scene.engine!.add_rect(500, 500, 50, 50); // touches neither

        const made = applyCrop(ck, scene, [a, b, cutter]);

        expect(made).toBeNull();
        expect(Array.from(scene.engine!.get_root_nodes())).toEqual([a, b, cutter]);
    });

    it('needs at least two shapes', () => {
        const scene = makeScene();
        const only = scene.engine!.add_rect(0, 0, 10, 10);
        expect(applyCrop(ck, scene, [only])).toBeNull();
    });

    it('is one undo step', () => {
        const { scene, a, b, c, cutter } = threeUnderABar();
        const before = scene.serializeScene();

        applyCrop(ck, scene, [a, b, c, cutter]);
        scene.undo();

        expect(scene.serializeScene()).toEqual(before);
    });
});
