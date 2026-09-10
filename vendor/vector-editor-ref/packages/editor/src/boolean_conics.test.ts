/**
 * Conics coming back out of Skia.
 *
 * Skia represents circular arcs — round joins and caps, ovals, the corners of a
 * rounded rect — as rational quadratics, and every path this editor reads back
 * from CanvasKit can contain them: boolean ops, Crop, the pathfinders, Offset
 * Path, Create Outlines, Flatten. The engine stores cubics, so each conic has
 * to be converted, and the conversion is the only place the roundness can be
 * lost.
 *
 * Treating a conic as a plain quadratic (which is what this used to do) is off
 * by 6% of the radius — a 20px corner grows a 1.2px bulge every time it passes
 * through an op. These tests hold the error to the ~0.03% of a proper
 * single-cubic arc approximation.
 */
/// <reference types="node" />

import { resolve } from 'node:path';
import type { CanvasKit } from 'canvaskit-wasm';
import CanvasKitInit from 'canvaskit-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { conicHandleRatio, pathToSubpaths } from './boolean_ops';
import { evalCubic } from './path_ops';
import type { Subpath } from './types';

let ck: CanvasKit;

beforeAll(async () => {
    ck = await CanvasKitInit({
        locateFile: (f: string) =>
            resolve('node_modules/.pnpm/canvaskit-wasm@0.39.1/node_modules/canvaskit-wasm/bin', f),
    });
}, 60_000);

/** Worst |distance − r| over every segment whose two ends both sit r from `centre`. */
function worstArcError(subpaths: Subpath[], centre: [number, number], r: number) {
    let worst = 0;
    let arcs = 0;
    for (const sp of subpaths) {
        const pts = sp.points;
        const segs = sp.closed ? pts.length : pts.length - 1;
        for (let i = 0; i < segs; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            const onArc = (p: { x: number; y: number }) =>
                Math.abs(Math.hypot(p.x - centre[0], p.y - centre[1]) - r) < 0.01;
            if (!onArc(a) || !onArc(b)) continue;
            arcs++;
            for (let s = 0; s <= 20; s++) {
                const [x, y] = evalCubic(a, b, s / 20);
                worst = Math.max(worst, Math.abs(Math.hypot(x - centre[0], y - centre[1]) - r));
            }
        }
    }
    return { worst, arcs };
}

describe('conic → cubic', () => {
    it('keeps a rounded rect’s corner radius through a boolean op', () => {
        const rrect = new ck.Path();
        rrect.addRRect(ck.RRectXY(ck.LTRBRect(0, 0, 100, 100), 20, 20));
        const cover = new ck.Path();
        cover.addRect(ck.LTRBRect(-50, -50, 200, 200));
        const result = ck.Path.MakeFromOp(rrect, cover, ck.PathOp.Intersect);
        expect(result).not.toBeNull();
        const subpaths = pathToSubpaths(ck, result!);
        rrect.delete();
        cover.delete();
        result!.delete();

        // All four corners survive as arcs, each true to its radius.
        for (const centre of [
            [20, 20],
            [80, 20],
            [20, 80],
            [80, 80],
        ] as [number, number][]) {
            const { worst, arcs } = worstArcError(subpaths, centre, 20);
            expect(arcs).toBe(1);
            expect(worst).toBeLessThan(0.01);
        }
    });

    it('keeps a circle circular through a boolean op', () => {
        const oval = new ck.Path();
        oval.addOval(ck.LTRBRect(-40, -40, 40, 40));
        const cover = new ck.Path();
        cover.addRect(ck.LTRBRect(-100, -100, 100, 100));
        const result = ck.Path.MakeFromOp(oval, cover, ck.PathOp.Intersect);
        const subpaths = pathToSubpaths(ck, result!);
        oval.delete();
        cover.delete();
        result!.delete();

        const { worst, arcs } = worstArcError(subpaths, [0, 0], 40);
        expect(arcs).toBe(4); // four quarter-arcs
        expect(worst).toBeLessThan(0.02);
    });

    it('reduces to the exact quad→cubic elevation at weight 1', () => {
        // A conic of weight 1 *is* a quadratic, and 2/3 is the exact elevation.
        expect(conicHandleRatio(1)).toBeCloseTo(2 / 3, 12);
        expect(conicHandleRatio(0.999999)).toBeCloseTo(2 / 3, 6);
    });

    it('gives the circle constant for the 90° arcs Skia actually emits', () => {
        // w = cos(45°) is a quarter circle, whose control point sits at r from
        // each end — so the handle ratio is κ itself.
        expect(conicHandleRatio(Math.SQRT1_2)).toBeCloseTo(0.5522847498, 8);
    });

    it('falls back rather than dividing by zero on weights that aren’t arcs', () => {
        for (const w of [0, -1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(Number.isFinite(conicHandleRatio(w))).toBe(true);
        }
    });
});
