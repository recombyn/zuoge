import { describe, expect, it } from 'vitest';
import { evalCubic, splitPathAtPoint, splitPathAtSegment } from './path_ops';
import type { PathPoint, Subpath } from './types';

/** Corner-style anchor (retracted handles) at (x, y). */
function pt(x: number, y: number, extra: Partial<PathPoint> = {}): PathPoint {
    return { x, y, cp1: [x, y], cp2: [x, y], ...extra };
}

function open(...points: PathPoint[]): Subpath {
    return { points, closed: false };
}

function closed(...points: PathPoint[]): Subpath {
    return { points, closed: true };
}

/** Total number of anchor points across all subpaths. */
function totalPoints(sps: Subpath[]): number {
    return sps.reduce((n, sp) => n + sp.points.length, 0);
}

describe('splitPathAtSegment', () => {
    it('splits an open subpath into two open subpaths', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(20, 0))];
        // Cut segment 0 (0,0)->(10,0) at its midpoint.
        const result = splitPathAtSegment(sp, 0, 0, 0.5);
        expect(result.length).toBe(2);
        expect(result[0].closed).toBe(false);
        expect(result[1].closed).toBe(false);
        // First half ends at the cut, second half begins there.
        expect(result[0].points.map((p) => p.x)).toEqual([0, 5]);
        expect(result[1].points.map((p) => p.x)).toEqual([5, 10, 20]);
    });

    it('opens a closed subpath at the cut point without dropping geometry', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10))];
        // Cut segment 1 ((10,0)->(10,10)) at its midpoint -> new point (10,5).
        const result = splitPathAtSegment(sp, 0, 1, 0.5);
        expect(result.length).toBe(1);
        const s = result[0];
        expect(s.closed).toBe(false);
        // 4 originals + 1 inserted, duplicated at both open ends = 6 points.
        expect(s.points.length).toBe(6);
        // The path now starts and ends at the cut location.
        expect(s.points[0].x).toBe(10);
        expect(s.points[0].y).toBe(5);
        expect(s.points[s.points.length - 1].x).toBe(10);
        expect(s.points[s.points.length - 1].y).toBe(5);
    });

    it('handles cutting the wraparound (closing) segment of a closed subpath', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10))];
        // Segment 3 is the closing edge (0,10)->(0,0); cut at midpoint -> (0,5).
        const result = splitPathAtSegment(sp, 0, 3, 0.5);
        expect(result.length).toBe(1);
        const s = result[0];
        expect(s.closed).toBe(false);
        expect(s.points.length).toBe(6);
        expect(s.points[0].x).toBe(0);
        expect(s.points[0].y).toBe(5);
        expect(s.points[s.points.length - 1].y).toBe(5);
    });

    it('preserves the curve shape when splitting a cubic segment', () => {
        // A single curved segment with real handles.
        const a = pt(0, 0, { cp2: [0, 10] });
        const b = pt(20, 0, { cp1: [20, 10] });
        const sp = [open(a, b)];
        // Point on the original curve at t=0.5.
        const [mx, my] = evalCubic(a, b, 0.5);

        const result = splitPathAtSegment(sp, 0, 0, 0.5);
        // The shared cut point is the tail of the first half / head of the second.
        const cutA = result[0].points[result[0].points.length - 1];
        const cutB = result[1].points[0];
        expect(cutA.x).toBeCloseTo(mx, 6);
        expect(cutA.y).toBeCloseTo(my, 6);
        expect(cutB.x).toBeCloseTo(mx, 6);
        expect(cutB.y).toBeCloseTo(my, 6);
    });

    it('does not mutate its input', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10))];
        const snapshot = JSON.stringify(sp);
        splitPathAtSegment(sp, 0, 0, 0.5);
        expect(JSON.stringify(sp)).toBe(snapshot);
    });
});

describe('splitPathAtPoint', () => {
    it('opens a closed subpath at an anchor, duplicating it at both ends', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10), pt(0, 10))];
        const result = splitPathAtPoint(sp, 0, 1);
        expect(result.length).toBe(1);
        const s = result[0];
        expect(s.closed).toBe(false);
        // 4 originals, the split anchor duplicated -> 5 points.
        expect(s.points.length).toBe(5);
        // Opens at anchor 1 = (10,0); that point bookends the open path.
        expect(s.points[0].x).toBe(10);
        expect(s.points[0].y).toBe(0);
        expect(s.points[s.points.length - 1].x).toBe(10);
        expect(s.points[s.points.length - 1].y).toBe(0);
    });

    it('splits an open subpath at an interior anchor into two subpaths', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0))];
        const result = splitPathAtPoint(sp, 0, 1);
        expect(result.length).toBe(2);
        expect(result[0].points.map((p) => p.x)).toEqual([0, 10]);
        expect(result[1].points.map((p) => p.x)).toEqual([10, 20, 30]);
        // No geometry lost: 4 originals + 1 duplicated split anchor.
        expect(totalPoints(result)).toBe(5);
    });

    it('is a no-op at the endpoints of an open subpath', () => {
        const sp = [open(pt(0, 0), pt(10, 0), pt(20, 0))];
        expect(splitPathAtPoint(sp, 0, 0)).toEqual(sp);
        expect(splitPathAtPoint(sp, 0, 2)).toEqual(sp);
    });

    it('does not mutate its input', () => {
        const sp = [closed(pt(0, 0), pt(10, 0), pt(10, 10))];
        const snapshot = JSON.stringify(sp);
        splitPathAtPoint(sp, 0, 0);
        expect(JSON.stringify(sp)).toBe(snapshot);
    });
});
