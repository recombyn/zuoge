/**
 * Outline Stroke — the geometry Flatten hands back for a stroke.
 *
 * The contract worth protecting is "what you saw is what you get". The renderer
 * rounds corners, cuts dashes and clips inside/outside strokes to the fill; an
 * outline that ignores any of those has silently redrawn the artwork rather
 * than expanded it, and there is no undo-visible sign that it happened.
 *
 * Needs real CanvasKit (the stroking is Skia's), like the boolean suites.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CanvasKit } from 'canvaskit-wasm';
import CanvasKitInit from 'canvaskit-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { outlineStroke } from './outline_stroke';
import { evalCubic } from './path_ops';
import { StrokeAlignment, type Subpath } from './types';
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

interface StrokeOpts {
    width?: number;
    alignment?: StrokeAlignment;
    dash?: number[];
    dashOffset?: number;
    cap?: number;
    join?: number;
    cornerRadius?: number;
}

/** A 100×100 rect with only a stroke, converted to a path (as Flatten does). */
function strokedRect(scene: WasmScene, o: StrokeOpts = {}): number {
    const id = scene.engine!.add_rect(0, 0, 100, 100);
    const style = scene.getNodeStyle(id)!;
    scene.engine!.set_node_style(
        id,
        JSON.stringify({
            ...style,
            corner_radius: o.cornerRadius ?? 0,
            fills: [],
            strokes: [
                {
                    paint: { r: 0, g: 0, b: 0, a: 1 },
                    width: o.width ?? 4,
                    cap: o.cap ?? 0,
                    join: o.join ?? 0,
                    dash_array: o.dash ?? [],
                    dash_offset: o.dashOffset ?? 0,
                    miter_limit: 4,
                    alignment: o.alignment ?? StrokeAlignment.Center,
                },
            ],
        }),
    );
    scene.convertToPath(id);
    return id;
}

function outlineOf(scene: WasmScene, id: number): Subpath[] {
    return scene.getNodeGeometry(id)!.Path!.subpaths;
}

/** Bounding box over sampled curve points, not just anchors. */
function bbox(subpaths: Subpath[]) {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const sp of subpaths) {
        const pts = sp.points;
        const segs = sp.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segs; i++) {
            for (let s = 0; s <= 8; s++) {
                const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 8);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
        }
    }
    return { minX, minY, maxX, maxY };
}

/** Total arc length of every contour, sampled. */
function totalLength(subpaths: Subpath[]): number {
    let len = 0;
    for (const sp of subpaths) {
        const pts = sp.points;
        const segs = sp.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segs; i++) {
            let px = pts[i].x,
                py = pts[i].y;
            for (let s = 1; s <= 24; s++) {
                const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 24);
                len += Math.hypot(x - px, y - py);
                px = x;
                py = y;
            }
        }
    }
    return len;
}

describe('Outline Stroke keeps the shape that was on screen', () => {
    it('rounds the corners a rounded rectangle actually had', () => {
        const scene = makeScene();
        // 100×100, radius 20, 4-wide centred stroke. The outer edge of that
        // stroke is a radius-22 round rect inset by -2 on every side.
        const id = strokedRect(scene, { cornerRadius: 20, width: 4 });
        outlineStroke(ck, scene, id);
        const out = outlineOf(scene, id);

        const bb = bbox(out);
        expect(bb.minX).toBeCloseTo(-2, 1);
        expect(bb.maxX).toBeCloseTo(102, 1);

        // The give-away: on a sharp outline the corner (-2,-2) is on the shape.
        // On a correctly rounded one, nothing comes within ~5 of it.
        let nearestToCorner = Infinity;
        for (const sp of out) {
            const pts = sp.points;
            const segs = sp.closed ? pts.length : pts.length - 1;
            for (let i = 0; i < segs; i++) {
                for (let s = 0; s <= 8; s++) {
                    const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 8);
                    nearestToCorner = Math.min(nearestToCorner, Math.hypot(x + 2, y + 2));
                }
            }
        }
        // Outer corner arc centre is (20,20) with radius 22, so the closest the
        // outline gets to (-2,-2) is |(20,20)-(-2,-2)| - 22 = 31.1 - 22 = 9.1.
        expect(nearestToCorner).toBeGreaterThan(5);
    });

    it('keeps an inside stroke inside the shape', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 10, alignment: StrokeAlignment.Inner });
        outlineStroke(ck, scene, id);
        const bb = bbox(outlineOf(scene, id));
        // Inner: the band is 90..100, entirely within the fill.
        expect(bb.minX).toBeCloseTo(0, 1);
        expect(bb.minY).toBeCloseTo(0, 1);
        expect(bb.maxX).toBeCloseTo(100, 1);
        expect(bb.maxY).toBeCloseTo(100, 1);
    });

    it('keeps an outside stroke outside the shape', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 10, alignment: StrokeAlignment.Outer });
        outlineStroke(ck, scene, id);
        const bb = bbox(outlineOf(scene, id));
        // Outer: the band is -10..0 / 100..110.
        expect(bb.minX).toBeCloseTo(-10, 1);
        expect(bb.maxX).toBeCloseTo(110, 1);
    });

    it('centres a centred stroke, as before', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 10, alignment: StrokeAlignment.Center });
        outlineStroke(ck, scene, id);
        const bb = bbox(outlineOf(scene, id));
        expect(bb.minX).toBeCloseTo(-5, 1);
        expect(bb.maxX).toBeCloseTo(105, 1);
    });

    it('cuts a dashed stroke into separate dashes', () => {
        const scene = makeScene();
        // 400 of perimeter, 20 on / 20 off ⇒ 10 dashes.
        const id = strokedRect(scene, { width: 4, dash: [20, 20] });
        outlineStroke(ck, scene, id);
        const out = outlineOf(scene, id);
        expect(out.length).toBe(10);

        // Each dash is a 20×4 bar: perimeter 48, so 480 in total.
        expect(totalLength(out)).toBeGreaterThan(400);
        expect(totalLength(out)).toBeLessThan(560);
    });

    it('honours an odd dash array by repeating it doubled', () => {
        const scene = makeScene();
        // "20" means 20 on, 20 off — same 10 dashes as [20, 20].
        const id = strokedRect(scene, { width: 4, dash: [20] });
        outlineStroke(ck, scene, id);
        expect(outlineOf(scene, id).length).toBe(10);
    });

    it('shifts the dashes by the dash offset', () => {
        const scene = makeScene();
        const starts = (dashOffset: number) => {
            const id = strokedRect(scene, { width: 4, dash: [20, 20], dashOffset });
            outlineStroke(ck, scene, id);
            return outlineOf(scene, id)
                .map((sp) => `${sp.points[0].x.toFixed(1)},${sp.points[0].y.toFixed(1)}`)
                .join(' ');
        };
        // Offsetting by exactly one dash swaps lit and unlit runs, so every bar
        // moves — the first one starts a dash-length further along the edge.
        expect(starts(0)).toMatch(/^0\.0,-2\.0 /);
        expect(starts(20)).toMatch(/^19\.9,-2\.0 /);
    });

    it('leaves an undashed stroke as one closed band', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 4 });
        outlineStroke(ck, scene, id);
        // Outer contour plus the inner hole.
        expect(outlineOf(scene, id).length).toBe(2);
    });

    it('ignores a degenerate dash array rather than erasing the stroke', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 4, dash: [0, 0] });
        outlineStroke(ck, scene, id);
        // Sums to zero: not a dash. Still the solid band.
        expect(outlineOf(scene, id).length).toBe(2);
    });

    it('takes the stroke colour as the fill and drops the stroke', () => {
        const scene = makeScene();
        const id = strokedRect(scene, { width: 4 });
        outlineStroke(ck, scene, id);
        const style = scene.getNodeStyle(id)!;
        expect(style.strokes).toEqual([]);
        expect(style.fills).toHaveLength(1);
    });

    it('outlines round caps as arcs, not as flattened quads', () => {
        const scene = makeScene();
        // An open line with round caps: the cap is a half-circle of radius 5.
        const id = scene.engine!.add_path(
            JSON.stringify([
                {
                    points: [
                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                        { x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] },
                    ],
                    closed: false,
                },
            ]),
        );
        const style = scene.getNodeStyle(id)!;
        scene.engine!.set_node_style(
            id,
            JSON.stringify({
                ...style,
                fills: [],
                strokes: [
                    {
                        paint: { r: 0, g: 0, b: 0, a: 1 },
                        width: 10,
                        cap: 1, // round
                        join: 1,
                        dash_array: [],
                        dash_offset: 0,
                        miter_limit: 4,
                        alignment: StrokeAlignment.Center,
                    },
                ],
            }),
        );
        outlineStroke(ck, scene, id);
        const out = outlineOf(scene, id);

        // add_path re-centres its geometry, so the line runs -50..50 in local
        // space. Anything past an end is on a cap arc and must sit 5 from it.
        let worst = 0;
        let capSamples = 0;
        for (const sp of out) {
            const pts = sp.points;
            const segs = sp.closed ? pts.length : pts.length - 1;
            for (let i = 0; i < segs; i++) {
                for (let s = 0; s <= 8; s++) {
                    const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 8);
                    const end = x < -50 ? -50 : x > 50 ? 50 : null;
                    if (end === null) continue;
                    capSamples++;
                    worst = Math.max(worst, Math.abs(Math.hypot(x - end, y) - 5));
                }
            }
        }
        expect(capSamples).toBeGreaterThan(8);
        // The old single-quadratic conic approximation was ~6% out (0.3 on r=5).
        expect(worst).toBeLessThan(0.01);
    });
});
