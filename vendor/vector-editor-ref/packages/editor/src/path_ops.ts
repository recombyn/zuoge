/**
 * path_ops.ts — Pure-logic module for path operations.
 *
 * This module contains only geometric / topological helpers that operate on
 * PathPoint[] and Subpath[] data structures.  It has NO DOM references,
 * NO tool-state side-effects, and NO WASM imports.
 *
 * Every public function that mutates path data deep-clones its inputs first
 * and returns a brand-new array, so callers never observe in-place mutation.
 */

import type { PathPoint, Subpath } from './types';

// ─── Result types ────────────────────────────────────────────────────

/** Result returned by {@link findNearestSegment}. */
export interface SegmentHitResult {
    /** Index of the subpath that was hit. */
    subpathIndex: number;
    /** Index of the segment within the subpath (i.e. the index of its start point). */
    segmentIndex: number;
    /** Bézier parameter t ∈ [0, 1] of the closest point on the segment. */
    t: number;
    /** World-space X of the closest point. */
    worldX: number;
    /** World-space Y of the closest point. */
    worldY: number;
    /** Euclidean distance in world space from (worldX, worldY) to the query point. */
    distance: number;
}

// ─── Internal helpers ────────────────────────────────────────────────

/** Linearly interpolate between two 2-D points. */
function lerp2(ax: number, ay: number, bx: number, by: number, t: number): [number, number] {
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
}

/** Deep-clone an array of Subpath via JSON round-trip. */
function cloneSubpaths(subpaths: Subpath[]): Subpath[] {
    return JSON.parse(JSON.stringify(subpaths)) as Subpath[];
}

// ─── evalCubic ───────────────────────────────────────────────────────

/**
 * Evaluate a cubic Bézier curve at parameter **t**.
 *
 * The curve is defined by:
 *   P0 = (p0.x, p0.y)
 *   C1 = p0.cp2  (outgoing control point of the first anchor)
 *   C2 = p1.cp1  (incoming control point of the second anchor)
 *   P3 = (p1.x, p1.y)
 *
 * Uses the standard polynomial form:
 *   B(t) = (1-t)³·P0 + 3·(1-t)²·t·C1 + 3·(1-t)·t²·C2 + t³·P3
 *
 * @param p0 Start anchor of the segment.
 * @param p1 End anchor of the segment.
 * @param t  Parameter in [0, 1].
 * @returns  [x, y] coordinates on the curve.
 */
export function evalCubic(p0: PathPoint, p1: PathPoint, t: number): [number, number] {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    const t2 = t * t;
    const t3 = t2 * t;

    const x = mt3 * p0.x + 3 * mt2 * t * p0.cp2[0] + 3 * mt * t2 * p1.cp1[0] + t3 * p1.x;

    const y = mt3 * p0.y + 3 * mt2 * t * p0.cp2[1] + 3 * mt * t2 * p1.cp1[1] + t3 * p1.y;

    return [x, y];
}

// ─── deCasteljau ─────────────────────────────────────────────────────

/**
 * Split a cubic Bézier segment at parameter **t** using the de Casteljau algorithm.
 *
 * Given a segment from **p0** to **p1** with control points:
 *   P0 = (p0.x, p0.y), C1 = p0.cp2, C2 = p1.cp1, P3 = (p1.x, p1.y)
 *
 * The algorithm produces two sub-curves that together exactly reproduce
 * the original curve:
 *   Left  half: P0 → B0 → C0 → D
 *   Right half: D → C1new → B2 → P3
 *
 * Returned objects are deep copies — inputs are never mutated.
 *
 * @param p0 Start anchor (with outgoing handle cp2).
 * @param p1 End anchor (with incoming handle cp1).
 * @param t  Split parameter in [0, 1].
 */
export function deCasteljau(
    p0: PathPoint,
    p1: PathPoint,
    t: number,
): {
    left: { start: PathPoint; end: PathPoint };
    right: { start: PathPoint; end: PathPoint };
    point: PathPoint;
} {
    // Original control polygon
    const P0x = p0.x,
        P0y = p0.y;
    const C1x = p0.cp2[0],
        C1y = p0.cp2[1];
    const C2x = p1.cp1[0],
        C2y = p1.cp1[1];
    const P3x = p1.x,
        P3y = p1.y;

    // First level
    const [B0x, B0y] = lerp2(P0x, P0y, C1x, C1y, t);
    const [B1x, B1y] = lerp2(C1x, C1y, C2x, C2y, t);
    const [B2x, B2y] = lerp2(C2x, C2y, P3x, P3y, t);

    // Second level
    const [C0x, C0y] = lerp2(B0x, B0y, B1x, B1y, t);
    const [C1newX, C1newY] = lerp2(B1x, B1y, B2x, B2y, t);

    // Third level — point on curve
    const [Dx, Dy] = lerp2(C0x, C0y, C1newX, C1newY, t);

    // Build the new PathPoint at the split location
    const point: PathPoint = {
        x: Dx,
        y: Dy,
        cp1: [C0x, C0y],
        cp2: [C1newX, C1newY],
    };

    // Left sub-curve: start is a copy of p0 with cp2 updated to B0
    const leftStart: PathPoint = {
        x: p0.x,
        y: p0.y,
        cp1: [p0.cp1[0], p0.cp1[1]],
        cp2: [B0x, B0y],
    };

    // Left sub-curve end is the split point (deep copy)
    const leftEnd: PathPoint = { ...point, cp1: [...point.cp1], cp2: [...point.cp2] };

    // Right sub-curve start is the split point (deep copy)
    const rightStart: PathPoint = { ...point, cp1: [...point.cp1], cp2: [...point.cp2] };

    // Right sub-curve: end is a copy of p1 with cp1 updated to B2
    const rightEnd: PathPoint = {
        x: p1.x,
        y: p1.y,
        cp1: [B2x, B2y],
        cp2: [p1.cp2[0], p1.cp2[1]],
    };

    return {
        left: { start: leftStart, end: leftEnd },
        right: { start: rightStart, end: rightEnd },
        point,
    };
}

// ─── addAnchorPoint ──────────────────────────────────────────────────

/**
 * Insert a new anchor point on a segment by splitting it at parameter **t**.
 *
 * The segment is identified by `subpathIdx` and `segmentIdx` (the index of the
 * segment's start point).  The function deep-clones the entire subpath array,
 * performs the split, and returns the new array — the original is never mutated.
 *
 * @param subpaths    Source subpaths.
 * @param subpathIdx  Index of the target subpath.
 * @param segmentIdx  Index of the segment's start point within that subpath.
 * @param t           Bézier parameter where the new point is inserted.
 * @returns           New subpaths array with the added point.
 */
export function addAnchorPoint(
    subpaths: Subpath[],
    subpathIdx: number,
    segmentIdx: number,
    t: number,
): Subpath[] {
    const result = cloneSubpaths(subpaths);
    const sp = result[subpathIdx];
    const pts = sp.points;
    const nextIdx = sp.closed ? (segmentIdx + 1) % pts.length : segmentIdx + 1;

    const p0 = pts[segmentIdx];
    const p1 = pts[nextIdx];
    const { left, right, point } = deCasteljau(p0, p1, t);

    // Update existing points' handles
    pts[segmentIdx].cp2 = [left.start.cp2[0], left.start.cp2[1]];
    pts[nextIdx].cp1 = [right.end.cp1[0], right.end.cp1[1]];

    // Insert the new point after segmentIdx
    pts.splice(segmentIdx + 1, 0, point);

    return result;
}

// ─── deleteAnchorPoint ───────────────────────────────────────────────

/**
 * Remove an anchor point from a subpath.
 *
 * If the subpath would be left with fewer than 2 points, the entire subpath is
 * removed.  Neighboring handles are kept as-is — no automatic re-fitting is
 * performed.
 *
 * @param subpaths    Source subpaths.
 * @param subpathIdx  Index of the target subpath.
 * @param pointIdx    Index of the point to remove within that subpath.
 * @returns           New subpaths array.
 */
export function deleteAnchorPoint(
    subpaths: Subpath[],
    subpathIdx: number,
    pointIdx: number,
): Subpath[] {
    const result = cloneSubpaths(subpaths);
    const sp = result[subpathIdx];

    sp.points.splice(pointIdx, 1);

    // If too few points remain, remove the entire subpath
    if (sp.points.length < 2) {
        result.splice(subpathIdx, 1);
    }

    return result;
}

// ─── splitPathAtSegment ──────────────────────────────────────────────

/**
 * "Scissors" on a segment — cut the path at an arbitrary point on a segment.
 *
 * Behaviour depends on whether the subpath is closed or open:
 *
 * **Closed subpath**: The segment is subdivided at **t**, then the path is
 * opened at the new point.  Points are reordered so that the new split point
 * appears as both the first and last point.  `closed` is set to `false`.
 *
 * **Open subpath**: The segment is subdivided and the subpath is split into
 * two separate open subpaths.  The new point is duplicated as the last point
 * of the first subpath and the first point of the second.
 *
 * @param subpaths    Source subpaths.
 * @param subpathIdx  Target subpath index.
 * @param segmentIdx  Segment start-point index.
 * @param t           Bézier parameter for the cut.
 * @returns           New subpaths array.
 */
export function splitPathAtSegment(
    subpaths: Subpath[],
    subpathIdx: number,
    segmentIdx: number,
    t: number,
): Subpath[] {
    // First, add the anchor at the split location
    const withAnchor = addAnchorPoint(subpaths, subpathIdx, segmentIdx, t);
    const sp = withAnchor[subpathIdx];

    // The newly inserted point is at segmentIdx + 1
    const splitPointIdx = segmentIdx + 1;

    if (sp.closed) {
        // ── Closed → open at the split point ──────────────────────────
        // Reorder so the split point is first; duplicate it at the end.
        const before = sp.points.slice(0, splitPointIdx); // points before split point
        const fromSplit = sp.points.slice(splitPointIdx); // split point and after

        // Duplicate the split point for the tail
        const tailPoint: PathPoint = JSON.parse(JSON.stringify(fromSplit[0]));

        sp.points = [...fromSplit, ...before, tailPoint];
        sp.closed = false;

        return withAnchor;
    } else {
        // ── Open → split into two subpaths ────────────────────────────
        const firstPoints = sp.points.slice(0, splitPointIdx + 1);
        const splitPointCopy: PathPoint = JSON.parse(JSON.stringify(sp.points[splitPointIdx]));
        const secondPoints = [splitPointCopy, ...sp.points.slice(splitPointIdx + 1)];

        const first: Subpath = { points: firstPoints, closed: false };
        const second: Subpath = { points: secondPoints, closed: false };

        // Replace the original subpath with the two halves
        const result = [...withAnchor];
        result.splice(subpathIdx, 1, first, second);

        return result;
    }
}

// ─── splitPathAtPoint ────────────────────────────────────────────────

/**
 * "Scissors" on an existing anchor point.
 *
 * **Closed subpath**: Opens the path at the given point.  The point is
 * duplicated as the first and last point of the now-open subpath.  The
 * incoming handle (cp1) of the first copy and the outgoing handle (cp2) of
 * the last copy are reset to the point's own position (i.e. retracted).
 *
 * **Open subpath, middle point**: Split into two open subpaths at the point.
 * The point is duplicated as last of subpath A and first of subpath B.
 *
 * **Open subpath, first or last point**: No-op — there is nothing to split.
 *
 * @param subpaths    Source subpaths.
 * @param subpathIdx  Target subpath index.
 * @param pointIdx    Index of the anchor to split at.
 * @returns           New subpaths array.
 */
export function splitPathAtPoint(
    subpaths: Subpath[],
    subpathIdx: number,
    pointIdx: number,
): Subpath[] {
    const result = cloneSubpaths(subpaths);
    const sp = result[subpathIdx];

    if (sp.closed) {
        // ── Closed → open at the anchor ───────────────────────────────
        const before = sp.points.slice(0, pointIdx);
        const fromPt = sp.points.slice(pointIdx);

        // Duplicate: first copy = start of path, last copy = end of path
        const firstCopy: PathPoint = JSON.parse(JSON.stringify(fromPt[0]));
        const lastCopy: PathPoint = JSON.parse(JSON.stringify(fromPt[0]));

        // Retract handles on the split endpoints
        firstCopy.cp1 = [firstCopy.x, firstCopy.y];
        lastCopy.cp2 = [lastCopy.x, lastCopy.y];

        sp.points = [firstCopy, ...fromPt.slice(1), ...before, lastCopy];
        sp.closed = false;

        return result;
    }

    // ── Open path ─────────────────────────────────────────────────────
    const isFirst = pointIdx === 0;
    const isLast = pointIdx === sp.points.length - 1;

    if (isFirst || isLast) {
        // No-op for endpoints of open paths
        return result;
    }

    // Split into two subpaths at pointIdx
    const firstPoints = sp.points.slice(0, pointIdx + 1);
    const splitCopy: PathPoint = JSON.parse(JSON.stringify(sp.points[pointIdx]));
    const secondPoints = [splitCopy, ...sp.points.slice(pointIdx + 1)];

    const first: Subpath = { points: firstPoints, closed: false };
    const second: Subpath = { points: secondPoints, closed: false };

    result.splice(subpathIdx, 1, first, second);
    return result;
}

// ─── joinSubpaths ────────────────────────────────────────────────────

/**
 * Reverse a subpath in-place: reverse the points array and swap cp1 ↔ cp2
 * on every point so the curve geometry is preserved.
 */
function reverseSubpath(sp: Subpath): void {
    sp.points.reverse();
    for (const pt of sp.points) {
        const tmp: [number, number] = [pt.cp1[0], pt.cp1[1]];
        pt.cp1 = [pt.cp2[0], pt.cp2[1]];
        pt.cp2 = tmp;
    }
}

/**
 * Join two open subpaths by connecting a pair of their endpoints.
 *
 * The connection is a straight-line segment — existing handles on the
 * connected endpoints are preserved.  The four endpoint combinations
 * (end→start, start→end, etc.) are handled by reversing subpaths as needed
 * so the join always appends B onto the tail of A.
 *
 * The second subpath is removed from the array after merging.
 *
 * @param subpaths Source subpaths.
 * @param aIdx     Index of the first subpath.
 * @param aEnd     Which end of A to connect ('start' or 'end').
 * @param bIdx     Index of the second subpath.
 * @param bEnd     Which end of B to connect ('start' or 'end').
 * @returns        New subpaths array with the joined subpath.
 */
/**
 * Reverse the direction of every subpath: reverse the point order and swap each
 * point's incoming/outgoing handles (cp1 ↔ cp2), which exactly reverses each
 * cubic segment. Preserves closed state and per-vertex corner radii.
 */
export function reverseSubpaths(subpaths: Subpath[]): Subpath[] {
    return subpaths.map((sp) => ({
        closed: sp.closed,
        points: [...sp.points].reverse().map((p) => {
            const rev: PathPoint = {
                x: p.x,
                y: p.y,
                cp1: [p.cp2[0], p.cp2[1]],
                cp2: [p.cp1[0], p.cp1[1]],
            };
            if (p.corner_radius !== undefined) rev.corner_radius = p.corner_radius;
            return rev;
        }),
    }));
}

/**
 * Add an anchor point at the midpoint of every segment (Illustrator's "Add
 * Anchor Points"). The curve is unchanged — each segment is split at t=0.5 via
 * de Casteljau, so the new anchors sit exactly on the path and neighbouring
 * handles are re-fitted. The complement of Simplify.
 */
export function addAnchorPointsToSubpaths(subpaths: Subpath[]): Subpath[] {
    return subpaths.map((sp) => {
        const pts = sp.points;
        const n = pts.length;
        if (n < 2) return sp;
        const segCount = sp.closed ? n : n - 1;
        const splits = [];
        for (let i = 0; i < segCount; i++) {
            splits.push(deCasteljau(pts[i], pts[(i + 1) % n], 0.5));
        }
        // Segment index that ENDS at anchor i (or -1 for an open path's start).
        const segEndingAt = (i: number) => (sp.closed ? (i - 1 + segCount) % segCount : i - 1);

        const out: PathPoint[] = [];
        for (let i = 0; i < n; i++) {
            const outgoing = i < segCount ? splits[i] : undefined; // segment starting at i
            const incomingIdx = segEndingAt(i);
            const incoming = incomingIdx >= 0 ? splits[incomingIdx] : undefined;
            const anchor: PathPoint = {
                x: pts[i].x,
                y: pts[i].y,
                cp1: incoming ? [...incoming.right.end.cp1] : [...pts[i].cp1],
                cp2: outgoing ? [...outgoing.left.start.cp2] : [...pts[i].cp2],
            };
            if (pts[i].corner_radius !== undefined) anchor.corner_radius = pts[i].corner_radius;
            out.push(anchor);
            if (outgoing) {
                out.push({
                    x: outgoing.point.x,
                    y: outgoing.point.y,
                    cp1: [...outgoing.point.cp1],
                    cp2: [...outgoing.point.cp2],
                });
            }
        }
        return { closed: sp.closed, points: out };
    });
}

export function joinSubpaths(
    subpaths: Subpath[],
    aIdx: number,
    aEnd: 'start' | 'end',
    bIdx: number,
    bEnd: 'start' | 'end',
): Subpath[] {
    const result = cloneSubpaths(subpaths);
    const a = result[aIdx];
    const b = result[bIdx];

    // Reverse so that we always join A's tail to B's head
    if (aEnd === 'start') reverseSubpath(a);
    if (bEnd === 'end') reverseSubpath(b);

    // Concatenate: A.points ++ B.points
    a.points = [...a.points, ...b.points];

    // Remove the second subpath
    result.splice(bIdx, 1);

    return result;
}

// ─── mergeSelectedAnchors ────────────────────────────────────────────

/** Reference to an anchor point by subpath and point index. */
export interface AnchorRef {
    subpathIdx: number;
    pointIdx: number;
}

/** Build the merged (welded) anchor for a run of points: averaged position,
 *  incoming handle from the first point, outgoing handle from the last. */
function weldPoints(run: PathPoint[]): PathPoint {
    const first = run[0];
    const last = run[run.length - 1];
    const merged: PathPoint = {
        x: run.reduce((s, p) => s + p.x, 0) / run.length,
        y: run.reduce((s, p) => s + p.y, 0) / run.length,
        cp1: [first.cp1[0], first.cp1[1]],
        cp2: [last.cp2[0], last.cp2[1]],
    };
    const cr = Math.max(...run.map((p) => p.corner_radius ?? 0));
    if (cr > 0) merged.corner_radius = cr;
    return merged;
}

/** Which end of an open subpath `idx` is, or `null` if it's interior / the subpath is closed. */
function endOf(sp: Subpath, idx: number): 'start' | 'end' | null {
    if (sp.closed) return null;
    if (idx === 0) return 'start';
    if (idx === sp.points.length - 1) return 'end';
    return null;
}

/** Collapse maximal runs of consecutive selected anchors in one subpath into a
 *  single welded anchor each (wraparound-aware for closed subpaths).
 *  Mutates `sp` in place. Returns true if anything changed. */
function collapseSelectedRuns(sp: Subpath, selectedIdx: Set<number>): boolean {
    const n = sp.points.length;
    // Refuse to collapse the entire subpath into a single point.
    if (selectedIdx.size < 2 || selectedIdx.size >= n) return false;

    // For closed subpaths, start the walk on an unselected point so a run that
    // wraps around index 0 is seen as contiguous.
    let start = 0;
    if (sp.closed) {
        while (selectedIdx.has(start)) start++;
    }

    const newPoints: PathPoint[] = [];
    let run: PathPoint[] = [];
    let changed = false;
    const flushRun = () => {
        if (run.length === 0) return;
        if (run.length === 1) {
            newPoints.push(run[0]);
        } else {
            newPoints.push(weldPoints(run));
            changed = true;
        }
        run = [];
    };

    for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        // In an open subpath the last→first jump is not a real segment, so a
        // "run" spanning it must not weld: break the run at the wrap point.
        if (!sp.closed && i === 0 && k > 0) flushRun();
        if (selectedIdx.has(i)) {
            run.push(sp.points[i]);
        } else {
            flushRun();
            newPoints.push(sp.points[i]);
        }
    }
    flushRun();

    if (changed) sp.points = newPoints;
    return changed;
}

/**
 * Merge (weld) selected anchor points into single anchors.
 *
 * Handled cases, in priority order:
 * 1. **Two endpoints of two different open subpaths** → the subpaths are
 *    joined into one, with the two endpoints welded into a single anchor at
 *    their midpoint.
 * 2. **The two endpoints of the same open subpath** → the subpath is closed
 *    and the endpoints are welded into one anchor.
 * 3. **Runs of consecutive selected anchors** (any count, per subpath) → each
 *    run collapses into one anchor at the run's average position. Wraparound
 *    runs on closed subpaths are supported.
 *
 * The welded anchor keeps the incoming handle (cp1) of the run's first point
 * and the outgoing handle (cp2) of its last, so adjoining curves are preserved.
 *
 * @returns A new subpaths array, or `null` if nothing could be merged.
 */
export function mergeSelectedAnchors(subpaths: Subpath[], selected: AnchorRef[]): Subpath[] | null {
    if (selected.length < 2) return null;
    const result = cloneSubpaths(subpaths);

    if (selected.length === 2) {
        const [s0, s1] = selected;

        if (s0.subpathIdx !== s1.subpathIdx) {
            // ── Case 1: endpoints of two different open subpaths ─────────
            const a = result[s0.subpathIdx];
            const b = result[s1.subpathIdx];
            if (!a || !b) return null;
            const aEnd = endOf(a, s0.pointIdx);
            const bEnd = endOf(b, s1.pointIdx);
            if (!aEnd || !bEnd) return null;

            // Orient so we weld A's tail onto B's head
            if (aEnd === 'start') reverseSubpath(a);
            if (bEnd === 'end') reverseSubpath(b);

            const tail = a.points[a.points.length - 1];
            const head = b.points[0];
            const welded = weldPoints([tail, head]);
            a.points = [...a.points.slice(0, -1), welded, ...b.points.slice(1)];
            result.splice(s1.subpathIdx, 1);
            return result;
        }

        // Same subpath: if the two anchors are the endpoints of an open
        // subpath, close it and weld them (Case 2).
        const sp = result[s0.subpathIdx];
        if (!sp) return null;
        const lo = Math.min(s0.pointIdx, s1.pointIdx);
        const hi = Math.max(s0.pointIdx, s1.pointIdx);
        if (!sp.closed && sp.points.length > 2 && lo === 0 && hi === sp.points.length - 1) {
            const head = sp.points[0];
            const tail = sp.points[sp.points.length - 1];
            // Incoming handle from the tail side, outgoing from the head side
            const welded = weldPoints([tail, head]);
            sp.points = [welded, ...sp.points.slice(1, -1)];
            sp.closed = true;
            return result;
        }
        // Otherwise fall through to run-collapse (handles adjacent pairs).
    }

    // ── Case 3: collapse consecutive selected runs per subpath ───────────
    const bySubpath = new Map<number, Set<number>>();
    for (const s of selected) {
        if (!bySubpath.has(s.subpathIdx)) bySubpath.set(s.subpathIdx, new Set());
        bySubpath.get(s.subpathIdx)!.add(s.pointIdx);
    }

    let changed = false;
    for (const [si, idxSet] of bySubpath) {
        const sp = result[si];
        if (!sp) continue;
        if (collapseSelectedRuns(sp, idxSet)) changed = true;
    }

    return changed ? result : null;
}

// ─── findNearestSegment ──────────────────────────────────────────────

/**
 * Hit-test all path segments against a world-space point.
 *
 * The `transform` is a row-major affine matrix stored as a Float32Array:
 *   [a, b, tx, c, d, ty, …]
 *
 * Local → world mapping:
 *   wx = t[0]·lx + t[1]·ly + t[2]
 *   wy = t[3]·lx + t[4]·ly + t[5]
 *
 * The algorithm first coarsely samples each segment (N = 20 steps), picks the
 * closest sample, and then refines it with 4 iterations of bisection.
 *
 * @param subpaths   Path data.
 * @param transform  Row-major affine [a, b, tx, c, d, ty, …].
 * @param worldX     Query point X in world space.
 * @param worldY     Query point Y in world space.
 * @param threshold  Maximum world-space distance for a hit.
 * @returns          The closest segment hit, or `null` if nothing is within threshold.
 */
export function findNearestSegment(
    subpaths: Subpath[],
    transform: Float32Array,
    worldX: number,
    worldY: number,
    threshold: number,
): SegmentHitResult | null {
    const SAMPLES = 20;
    const REFINE_ITERS = 4;

    let bestDist = Infinity;
    let bestResult: SegmentHitResult | null = null;

    for (let si = 0; si < subpaths.length; si++) {
        const sp = subpaths[si];
        const segCount = sp.closed ? sp.points.length : sp.points.length - 1;

        for (let seg = 0; seg < segCount; seg++) {
            const p0 = sp.points[seg];
            const p1 = sp.points[(seg + 1) % sp.points.length];

            // ── Coarse sampling ───────────────────────────────────────
            let closestT = 0;
            let closestDist = Infinity;

            for (let i = 0; i <= SAMPLES; i++) {
                const t = i / SAMPLES;
                const [lx, ly] = evalCubic(p0, p1, t);
                const wx = transform[0] * lx + transform[1] * ly + transform[2];
                const wy = transform[3] * lx + transform[4] * ly + transform[5];
                const dx = wx - worldX;
                const dy = wy - worldY;
                const d = Math.sqrt(dx * dx + dy * dy);

                if (d < closestDist) {
                    closestDist = d;
                    closestT = t;
                }
            }

            // ── Bisection refinement ──────────────────────────────────
            let lo = Math.max(0, closestT - 1 / SAMPLES);
            let hi = Math.min(1, closestT + 1 / SAMPLES);

            for (let iter = 0; iter < REFINE_ITERS; iter++) {
                const tA = (2 * lo + hi) / 3;
                const tB = (lo + 2 * hi) / 3;

                const [lxA, lyA] = evalCubic(p0, p1, tA);
                const wxA = transform[0] * lxA + transform[1] * lyA + transform[2];
                const wyA = transform[3] * lxA + transform[4] * lyA + transform[5];
                const dA = Math.hypot(wxA - worldX, wyA - worldY);

                const [lxB, lyB] = evalCubic(p0, p1, tB);
                const wxB = transform[0] * lxB + transform[1] * lyB + transform[2];
                const wyB = transform[3] * lxB + transform[4] * lyB + transform[5];
                const dB = Math.hypot(wxB - worldX, wyB - worldY);

                if (dA < dB) {
                    hi = tB;
                } else {
                    lo = tA;
                }
            }

            const bestT = (lo + hi) / 2;
            const [blx, bly] = evalCubic(p0, p1, bestT);
            const bwx = transform[0] * blx + transform[1] * bly + transform[2];
            const bwy = transform[3] * blx + transform[4] * bly + transform[5];
            const bDist = Math.hypot(bwx - worldX, bwy - worldY);

            if (bDist < bestDist) {
                bestDist = bDist;
                bestResult = {
                    subpathIndex: si,
                    segmentIndex: seg,
                    t: bestT,
                    worldX: bwx,
                    worldY: bwy,
                    distance: bDist,
                };
            }
        }
    }

    if (bestResult !== null && bestResult.distance < threshold) {
        return bestResult;
    }
    return null;
}
