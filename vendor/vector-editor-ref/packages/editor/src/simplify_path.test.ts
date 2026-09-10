/**
 * Simplify — fewer anchors, same shape.
 *
 * The tolerance is a promise: nothing may move further than that. Two things
 * used to break it. The Catmull-Rom refit smoothed every vertex it kept, and
 * the tangent through a right angle is as long as the diagonal between its
 * neighbours — so corners bowed outward by far more than the tolerance allowed
 * (an L-shape at tolerance 1 landed 9 units outside itself). And RDP pinned the
 * first and last samples of a closed contour, which are two neighbours either
 * side of wherever the contour happened to start, leaving a spurious anchor a
 * fraction of a segment from a real one.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { evalCubic } from './path_ops';
import { computeSimplifiedSubpaths } from './simplify_path';
import type { PathPoint, Subpath } from './types';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };

beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
}, 60_000);

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    return scene;
}

/** A closed polygon node from corner coordinates (straight edges, no handles). */
function polygon(scene: WasmScene, coords: [number, number][]): number {
    const points: PathPoint[] = coords.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y] }));
    return scene.engine!.add_path(JSON.stringify([{ points, closed: true }] satisfies Subpath[]));
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
        for (let i = 0; i < segs; i++)
            for (let s = 0; s <= 16; s++) {
                const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 16);
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
    }
    return { minX, minY, maxX, maxY };
}

describe('Simplify keeps the shape inside its tolerance', () => {
    it('leaves a rectangle exactly where it was', () => {
        const scene = makeScene();
        const id = polygon(scene, [
            [0, 0],
            [100, 0],
            [100, 100],
            [0, 100],
        ]);
        const before = bbox(scene.getNodeGeometry(id)!.Path!.subpaths);
        const after = bbox(computeSimplifiedSubpaths(scene, id, 1)!);
        expect(after).toEqual(before);
    });

    it('holds an L-shape to its corners rather than bowing past them', () => {
        const scene = makeScene();
        const id = polygon(scene, [
            [0, 0],
            [40, 0],
            [40, 60],
            [100, 60],
            [100, 100],
            [0, 100],
        ]);
        const before = bbox(scene.getNodeGeometry(id)!.Path!.subpaths);
        const out = computeSimplifiedSubpaths(scene, id, 1)!;
        const after = bbox(out);
        for (const k of ['minX', 'minY', 'maxX', 'maxY'] as const) {
            expect(Math.abs(after[k] - before[k])).toBeLessThanOrEqual(1);
        }
        // Six corners in, six corners out — no smoothing, no seam anchor.
        expect(out[0].points).toHaveLength(6);
    });

    it('does not invent an anchor at the seam of a closed contour', () => {
        const scene = makeScene();
        // A ten-point star: every vertex is a feature, none should be added.
        const coords: [number, number][] = [];
        for (let i = 0; i < 10; i++) {
            const a = (Math.PI * 2 * i) / 10 - Math.PI / 2;
            const r = i % 2 === 0 ? 100 : 45;
            coords.push([Math.cos(a) * r, Math.sin(a) * r]);
        }
        const id = polygon(scene, coords);
        expect(computeSimplifiedSubpaths(scene, id, 1)![0].points).toHaveLength(10);
    });

    it('still smooths a curve — a circle keeps no corners', () => {
        const scene = makeScene();
        const id = scene.engine!.add_ellipse(0, 0, 50, 50);
        scene.convertToPath(id);
        const out = computeSimplifiedSubpaths(scene, id, 0.5)!;
        const pts = out[0].points;
        // Every anchor keeps real handles (a retracted one would be a corner).
        for (const p of pts) {
            expect(Math.hypot(p.cp2[0] - p.x, p.cp2[1] - p.y)).toBeGreaterThan(0.5);
        }
        // And the result is still a circle of radius 50.
        let worst = 0;
        for (let i = 0; i < pts.length; i++)
            for (let s = 0; s <= 8; s++) {
                const [x, y] = evalCubic(pts[i], pts[(i + 1) % pts.length], s / 8);
                worst = Math.max(worst, Math.abs(Math.hypot(x, y) - 50));
            }
        expect(worst).toBeLessThan(0.5);
    });

    it('drops the anchors that carry no shape', () => {
        const scene = makeScene();
        // A square whose edges are littered with collinear points.
        const coords: [number, number][] = [];
        for (let i = 0; i < 10; i++) coords.push([i * 10, 0]);
        for (let i = 0; i < 10; i++) coords.push([100, i * 10]);
        for (let i = 0; i < 10; i++) coords.push([100 - i * 10, 100]);
        for (let i = 0; i < 10; i++) coords.push([0, 100 - i * 10]);
        const id = polygon(scene, coords);
        const out = computeSimplifiedSubpaths(scene, id, 1)!;
        expect(out[0].points.length).toBeLessThanOrEqual(5);
        expect(bbox(out)).toEqual(bbox(scene.getNodeGeometry(id)!.Path!.subpaths));
    });

    it('simplifies an open path without pinning it shut', () => {
        const scene = makeScene();
        const points: PathPoint[] = [];
        for (let i = 0; i <= 20; i++) {
            const x = i * 5;
            const y = Math.sin(i / 3) * 20;
            points.push({ x, y, cp1: [x, y], cp2: [x, y] });
        }
        const id = scene.engine!.add_path(JSON.stringify([{ points, closed: false }]));
        const out = computeSimplifiedSubpaths(scene, id, 1)!;
        expect(out[0].closed).toBe(false);
        expect(out[0].points.length).toBeLessThan(21);
        // Endpoints are never moved by RDP.
        const src = scene.getNodeGeometry(id)!.Path!.subpaths[0].points;
        expect(out[0].points[0].x).toBeCloseTo(src[0].x, 6);
        expect(out[0].points[out[0].points.length - 1].x).toBeCloseTo(src[src.length - 1].x, 6);
    });
});
