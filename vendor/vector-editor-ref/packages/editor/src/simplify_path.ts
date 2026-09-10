/**
 * simplify_path.ts — Illustrator "Object › Path › Simplify".
 *
 * Reduces the number of anchor points on a path while preserving its shape,
 * governed by a tolerance (world units). Each subpath is flattened to a dense
 * polyline, reduced with Ramer–Douglas–Peucker, then refit to smooth cubic
 * béziers (Catmull-Rom tangents) — except where the dense polyline turns
 * sharply, which is a corner and is kept as one. Pairs naturally with the
 * Pencil tool, which produces dense paths. Edits in place, one undo step.
 *
 * The tolerance is a promise about the whole operation, not just the reduction
 * step: no part of the outline may end up further than that from where it
 * started. A refit that smooths a right angle breaks that promise by far more
 * than the tolerance allows, which is why corners are detected and pinned.
 */
import { evalCubic } from './path_ops';
import type { PathPoint, Subpath } from './types';
import type { WasmScene } from './wasm_scene';

type Pt = [number, number];

/** Flatten a subpath's cubic segments into a dense polyline. */
function flatten(sp: Subpath, perSeg = 16): Pt[] {
    const pts = sp.points;
    if (pts.length < 2) return pts.map((p) => [p.x, p.y] as Pt);
    const out: Pt[] = [];
    const segEnd = sp.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segEnd; i++) {
        const p0 = pts[i];
        const p1 = pts[(i + 1) % pts.length];
        for (let s = 0; s < perSeg; s++) out.push(evalCubic(p0, p1, s / perSeg));
    }
    if (!sp.closed) out.push([pts[pts.length - 1].x, pts[pts.length - 1].y]);
    return out;
}

/** Perpendicular distance from p to the line through a→b. */
function perpDist(p: Pt, a: Pt, b: Pt): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Ramer–Douglas–Peucker over an open chain; returns the indices it keeps. */
function rdpOpen(pts: Pt[], eps: number): number[] {
    const n = pts.length;
    if (n < 3) return pts.map((_, i) => i);
    const keep = new Array(n).fill(false);
    keep[0] = keep[n - 1] = true;
    const stack: [number, number][] = [[0, n - 1]];
    while (stack.length) {
        const [s, e] = stack.pop()!;
        let maxD = 0;
        let idx = -1;
        for (let i = s + 1; i < e; i++) {
            const d = perpDist(pts[i], pts[s], pts[e]);
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > eps && idx > 0) {
            keep[idx] = true;
            stack.push([s, idx], [idx, e]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
    return out;
}

/**
 * Ramer–Douglas–Peucker over a closed loop; returns the indices it keeps.
 *
 * The open algorithm pins the first and last samples, which on a loop are two
 * neighbours either side of wherever the contour happened to start — so a
 * rectangle came back with a spurious extra anchor a fraction of a segment
 * from one of its corners. Cutting the loop at its two furthest-apart points
 * pins real features instead of an accident of ordering.
 */
function rdpClosed(pts: Pt[], eps: number): number[] {
    const n = pts.length;
    if (n < 3) return pts.map((_, i) => i);
    let far = 0;
    let farD = -1;
    for (let i = 1; i < n; i++) {
        const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
        if (d > farD) {
            farD = d;
            far = i;
        }
    }
    if (far === 0) return [0];
    // Two chains, 0→far and far→0, each simplified as an open polyline. Both
    // ends are shared, so each chain drops its last index.
    const head = rdpOpen(pts.slice(0, far + 1), eps);
    const tail = rdpOpen([...pts.slice(far), pts[0]], eps).map((i) => (far + i) % n);
    return [...head.slice(0, -1), ...tail.slice(0, -1)];
}

/** A turn this sharp in the dense polyline is a corner, not a curve. */
const CORNER_TURN_DEG = 35;

/**
 * How far the dense polyline turns at sample `i`, in degrees.
 *
 * Measured on the *dense* samples, not on the anchors RDP kept: at 16 samples
 * per segment a smooth curve turns a few degrees per step whatever its
 * curvature, so anything sharp is a real corner in the source path rather than
 * an artefact of how aggressively it was reduced.
 */
function turnAt(pts: Pt[], i: number, closed: boolean): number {
    const n = pts.length;
    const at = (j: number) =>
        closed ? pts[((j % n) + n) % n] : pts[Math.max(0, Math.min(n - 1, j))];
    // Step outwards past coincident samples so a repeated point doesn't read as
    // a direction of zero length.
    let bx = 0;
    let by = 0;
    for (let k = 1; k <= 3; k++) {
        const p = at(i - k);
        bx = pts[i][0] - p[0];
        by = pts[i][1] - p[1];
        if (Math.hypot(bx, by) > 1e-9) break;
    }
    let fx = 0;
    let fy = 0;
    for (let k = 1; k <= 3; k++) {
        const p = at(i + k);
        fx = p[0] - pts[i][0];
        fy = p[1] - pts[i][1];
        if (Math.hypot(fx, fy) > 1e-9) break;
    }
    const lb = Math.hypot(bx, by);
    const lf = Math.hypot(fx, fy);
    if (lb < 1e-9 || lf < 1e-9) return 0;
    const cos = Math.max(-1, Math.min(1, (bx * fx + by * fy) / (lb * lf)));
    return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Refit a polyline to smooth cubic béziers using Catmull-Rom tangents.
 *
 * `corners` marks the vertices that must stay sharp. Without it the tangent
 * through a right angle is as long as the diagonal between its neighbours, so
 * the fit bows straight out past the corner: an L-shape simplified at a
 * tolerance of 1 used to end up 9 units outside where it started.
 */
function refit(poly: Pt[], corners: boolean[], closed: boolean): PathPoint[] {
    // Drop a duplicated closing point if present.
    const P = poly.slice();
    const C = corners.slice();
    if (closed && P.length > 1) {
        const a = P[0];
        const b = P[P.length - 1];
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) {
            P.pop();
            C.pop();
        }
    }
    const n = P.length;
    const at = (i: number): Pt => {
        if (closed) return P[((i % n) + n) % n];
        return P[Math.max(0, Math.min(n - 1, i))];
    };
    const out: PathPoint[] = [];
    for (let i = 0; i < n; i++) {
        const cur = P[i];
        if (C[i]) {
            // A corner: retract both handles so the two edges meet at a point.
            out.push({ x: cur[0], y: cur[1], cp1: [cur[0], cur[1]], cp2: [cur[0], cur[1]] });
            continue;
        }
        const prev = at(i - 1);
        const next = at(i + 1);
        // Catmull-Rom tangent direction through the point.
        let tx = (next[0] - prev[0]) / 6;
        let ty = (next[1] - prev[1]) / 6;
        // Clamp handle length to a fraction of the nearer neighbor gap so tight
        // turns between unevenly-spaced points don't overshoot into cusps/loops.
        const dPrev = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
        const dNext = Math.hypot(cur[0] - next[0], cur[1] - next[1]);
        const hlen = Math.hypot(tx, ty);
        const maxLen = 0.4 * Math.min(dPrev || Infinity, dNext || Infinity);
        if (hlen > maxLen && hlen > 1e-9) {
            const scale = maxLen / hlen;
            tx *= scale;
            ty *= scale;
        }
        out.push({
            x: cur[0],
            y: cur[1],
            cp1: [cur[0] - tx, cur[1] - ty],
            cp2: [cur[0] + tx, cur[1] + ty],
        });
    }
    return out;
}

/** Total anchor count across a path's subpaths. */
export function pathPointCount(scene: WasmScene, nodeId: number): number {
    const subs = scene.getNodeGeometry(nodeId)?.Path?.subpaths;
    return subs ? subs.reduce((n, s) => n + s.points.length, 0) : 0;
}

/**
 * Simplify the given path node in place. `tolerance` is the max deviation in
 * world units (larger = fewer points). Returns the new total point count, or
 * null if the node isn't a path.
 */
/** Compute the simplified geometry (node LOCAL space) without mutating the scene.
 *  Pure — also backs the live preview. Null if there's nothing to simplify. */
export function computeSimplifiedSubpaths(
    scene: WasmScene,
    nodeId: number,
    tolerance: number,
): Subpath[] | null {
    const raw = scene.getNodeGeometry(nodeId)?.Path?.subpaths;
    if (!raw || raw.length === 0) return null;
    // Simplify the outline that is on screen: the refit has no way to express a
    // parametric corner radius, so starting from the raw anchors would square
    // off every rounded vertex on the way through.
    const resolved = scene.getResolvedSubpaths(nodeId);
    const subpaths = resolved.length === raw.length ? resolved : raw;
    const eps = Math.max(0.01, tolerance);
    return subpaths.map((sp) => {
        if (sp.points.length < 3) return sp; // nothing worth simplifying
        const dense = flatten(sp);
        const kept = sp.closed ? rdpClosed(dense, eps) : rdpOpen(dense, eps);
        if (kept.length < 2) return sp;
        const corners = kept.map((i) => turnAt(dense, i, sp.closed) > CORNER_TURN_DEG);
        return {
            points: refit(
                kept.map((i) => dense[i]),
                corners,
                sp.closed,
            ),
            closed: sp.closed,
        };
    });
}

export function simplifyPath(scene: WasmScene, nodeId: number, tolerance: number): number | null {
    const simplified = computeSimplifiedSubpaths(scene, nodeId, tolerance);
    if (!simplified) return null;

    scene.transaction(() => {
        scene.replaceGeometryWithPath(nodeId, simplified);
    });
    let count = 0;
    for (const sp of simplified) count += sp.points.length;
    return count;
}
