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
import { conicHandleRatio, pathToSubpaths, appendSubpathsToPath } from './boolean_ops';
import { evalCubic } from './path_ops';
import type { PathPoint, Subpath } from './types';

let ck: CanvasKit;

beforeAll(async () => {
    ck = await CanvasKitInit({
        locateFile: (f: string) =>
            resolve(
                process.cwd().includes('vector-editor-ref')
                    ? '../../node_modules/canvaskit-wasm/bin'
                    : 'node_modules/canvaskit-wasm/bin',
                f,
            ),
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

describe('polygon ∪ oval PathOps cleanup', () => {
    function regularHexPoints(cx: number, cy: number, r: number): PathPoint[] {
        const pts: PathPoint[] = [];
        for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i - Math.PI / 6;
            const x = cx + r * Math.cos(a);
            const y = cy + r * Math.sin(a);
            pts.push({ x, y, cp1: [x, y], cp2: [x, y] });
        }
        return pts;
    }

    function cleanupBoolean(result: NonNullable<ReturnType<CanvasKit['Path']['MakeFromOp']>>) {
        result.simplify();
        const wound = result.makeAsWinding();
        if (wound) {
            result.delete();
            return wound;
        }
        return result;
    }

    it('emits line verbs for collapsed cubic handles on a polygon', () => {
        const path = new ck.Path();
        appendSubpathsToPath(path, [
            {
                closed: true,
                points: regularHexPoints(0, 0, 50),
            },
        ]);
        const cmds = Array.from(path.toCmds());
        path.delete();
        const LINE = (ck as unknown as { LINE_VERB: number }).LINE_VERB ?? 1;
        const CUBIC = (ck as unknown as { CUBIC_VERB: number }).CUBIC_VERB ?? 4;
        expect(cmds.includes(LINE)).toBe(true);
        expect(cmds.includes(CUBIC)).toBe(false);
    });

    it('hexagon ∪ oval contains overlap and hex core after cleanup', () => {
        const hex = new ck.Path();
        appendSubpathsToPath(hex, [{ closed: true, points: regularHexPoints(0, 0, 100) }]);
        hex.setFillType(ck.FillType.Winding);
        const oval = new ck.Path();
        oval.addOval(ck.LTRBRect(40, -90, 220, 90));
        oval.setFillType(ck.FillType.Winding);
        let result = ck.Path.MakeFromOp(hex, oval, ck.PathOp.Union)!;
        result = cleanupBoolean(result);
        hex.delete();
        oval.delete();

        // Hex core (left of circle) and overlap region must both be inside.
        expect(result.contains(0, 0)).toBe(true);
        expect(result.contains(80, 0)).toBe(true);
        // Far outside stays outside.
        expect(result.contains(-200, 0)).toBe(false);

        // No vertex deep inside near the centroid (the sharp-V failure mode).
        const subpaths = pathToSubpaths(ck, result);
        let minR = Infinity;
        for (const sp of subpaths) {
            for (const p of sp.points) {
                minR = Math.min(minR, Math.hypot(p.x, p.y));
            }
        }
        expect(minR).toBeGreaterThan(40);

        result.delete();
    });
});
