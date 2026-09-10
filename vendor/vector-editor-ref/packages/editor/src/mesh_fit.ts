/**
 * Shape-fitted mesh creation (Illustrator-parity boundary).
 *
 * Converting a fill to a mesh fits the outer mesh ring to the node's outline:
 * the four mesh corners land ON the path (at the outline points nearest the
 * bounding-box corners), each boundary edge is a cubic fitted to its stretch
 * of outline (endpoint tangents, ⅓-arc-length handles), and interior vertices
 * are placed by Coons transfinite interpolation. Colors are seeded from the
 * fill being replaced (gradients are sampled per-vertex).
 *
 * The renderer paints `node path ∩ mesh raster` (plus a small boundary-color
 * outset), so a fit that can't follow every wiggle of a spiky path stays
 * visually correct — the clip guarantees the fill never spills, the outset
 * guarantees no transparent slivers.
 */

import { sampleGradientColor } from './gradient_edit';
import type { Cubic, Vec2 } from './mesh_geom';
import { evalCoons, evalCubic, makeRectMesh, pointToUV, splitCubic } from './mesh_geom';
import type { Color, MeshGradient, NodeGeometry, Paint } from './types';
import { isGradient, isMeshGradient, isPattern } from './types';

// ─── Outline extraction ──────────────────────────────────────────────────

/** Circle-quadrant bezier constant. */
const KAPPA = 0.5522847498;

/** The node's outline as a closed loop of cubics in node-local coords, or
 *  null when the geometry has no usable closed outline. For Paths, uses the
 *  largest closed subpath (by bbox area). */
export function outlineCubics(geo: NodeGeometry): Cubic[] | null {
    if (geo.Rect) {
        const { width: w, height: h } = geo.Rect;
        if (!(w > 0 && h > 0)) return null;
        const line = (a: Vec2, b: Vec2): Cubic => [
            a,
            [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3],
            [a[0] + ((b[0] - a[0]) * 2) / 3, a[1] + ((b[1] - a[1]) * 2) / 3],
            b,
        ];
        return [
            line([0, 0], [w, 0]),
            line([w, 0], [w, h]),
            line([w, h], [0, h]),
            line([0, h], [0, 0]),
        ];
    }
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        if (!(rx > 0 && ry > 0)) return null;
        const kx = rx * KAPPA;
        const ky = ry * KAPPA;
        // Clockwise from the top point.
        return [
            [
                [0, -ry],
                [kx, -ry],
                [rx, -ky],
                [rx, 0],
            ],
            [
                [rx, 0],
                [rx, ky],
                [kx, ry],
                [0, ry],
            ],
            [
                [0, ry],
                [-kx, ry],
                [-rx, ky],
                [-rx, 0],
            ],
            [
                [-rx, 0],
                [-rx, -ky],
                [-kx, -ry],
                [0, -ry],
            ],
        ];
    }
    if (geo.Path) {
        let best: Cubic[] | null = null;
        let bestArea = 0;
        for (const sp of geo.Path.subpaths ?? []) {
            if (!sp.closed || sp.points.length < 3) continue;
            const cubics: Cubic[] = [];
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let i = 0; i < sp.points.length; i++) {
                const a = sp.points[i];
                const b = sp.points[(i + 1) % sp.points.length];
                cubics.push([
                    [a.x, a.y],
                    [a.cp2[0], a.cp2[1]],
                    [b.cp1[0], b.cp1[1]],
                    [b.x, b.y],
                ]);
                minX = Math.min(minX, a.x);
                minY = Math.min(minY, a.y);
                maxX = Math.max(maxX, a.x);
                maxY = Math.max(maxY, a.y);
            }
            const area = (maxX - minX) * (maxY - minY);
            if (area > bestArea) {
                bestArea = area;
                best = cubics;
            }
        }
        return best;
    }
    return null; // Text / Image: no mesh
}

// ─── Outline sampling ────────────────────────────────────────────────────

interface OutlineSamples {
    /** The outline's own cubic segments — the ground truth boundary edges
     *  subdivide from. */
    cubics: Cubic[];
    pts: Vec2[];
    /** Cumulative arc length up to each sample; [0] = 0. */
    cum: number[];
    /** Unit tangent (forward direction) at each sample. */
    tan: Vec2[];
    total: number;
}

const SAMPLES_PER_CUBIC = 64;

function sampleOutline(cubics: Cubic[]): OutlineSamples {
    const pts: Vec2[] = [];
    for (const c of cubics) {
        for (let i = 0; i < SAMPLES_PER_CUBIC; i++) {
            pts.push(evalCubic(c, i / SAMPLES_PER_CUBIC));
        }
    }
    const n = pts.length;
    const cum: number[] = [0];
    for (let i = 1; i < n; i++) {
        cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const total = cum[n - 1] + Math.hypot(pts[0][0] - pts[n - 1][0], pts[0][1] - pts[n - 1][1]);
    const tan: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const p = pts[(i + n - 1) % n];
        const q = pts[(i + 1) % n];
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const l = Math.hypot(dx, dy) || 1;
        tan.push([dx / l, dy / l]);
    }
    return { cubics, pts, cum, tan, total };
}

/** Which outline cubic an arc-length position falls in, and the bezier
 *  parameter within it (arc-length-interpolated between flat samples). */
function cubicAt(s: OutlineSamples, len: number): { idx: number; t: number } {
    const n = s.pts.length;
    const l = ((len % s.total) + s.total) % s.total;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s.cum[mid] <= l) lo = mid;
        else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % n;
    const segLen = (j === 0 ? s.total : s.cum[j]) - s.cum[i];
    const f = segLen > 1e-9 ? (l - s.cum[i]) / segLen : 0;
    const idx = Math.floor(i / SAMPLES_PER_CUBIC);
    const t = Math.min(1, ((i % SAMPLES_PER_CUBIC) + f) / SAMPLES_PER_CUBIC);
    return { idx, t };
}

/** Arc-length positions of the outline's anchor points (segment starts). */
function anchorLengths(s: OutlineSamples): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.cubics.length; i++) out.push(s.cum[i * SAMPLES_PER_CUBIC]);
    return out;
}

/** Point/tangent at an absolute arc length along the (closed) outline. */
function atLength(s: OutlineSamples, len: number): { p: Vec2; t: Vec2 } {
    const n = s.pts.length;
    const l = ((len % s.total) + s.total) % s.total;
    // Binary search the cum array.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s.cum[mid] <= l) lo = mid;
        else hi = mid - 1;
    }
    const i = lo;
    const j = (i + 1) % n;
    const segLen = (j === 0 ? s.total : s.cum[j]) - s.cum[i];
    const f = segLen > 1e-9 ? (l - s.cum[i]) / segLen : 0;
    const p: Vec2 = [
        s.pts[i][0] + (s.pts[j][0] - s.pts[i][0]) * f,
        s.pts[i][1] + (s.pts[j][1] - s.pts[i][1]) * f,
    ];
    const t: Vec2 = [
        s.tan[i][0] + (s.tan[j][0] - s.tan[i][0]) * f,
        s.tan[i][1] + (s.tan[j][1] - s.tan[i][1]) * f,
    ];
    const tl = Math.hypot(t[0], t[1]) || 1;
    return { p, t: [t[0] / tl, t[1] / tl] };
}

// ─── Boundary fitting ────────────────────────────────────────────────────

/**
 * The outline stretch [startLen, startLen+span] as ONE cubic.
 *
 * EXACT whenever the stretch lies within a single outline segment: the edge
 * is then the segment's de Casteljau sub-curve — the very same curve as the
 * shape, not an approximation. Mesh creation cuts the grid at the outline's
 * anchor points precisely so that every boundary edge qualifies.
 *
 * Stretches that still cross an anchor (grid lines deleted by the user, an
 * anchor added mid-edge later) fall back to a least-squares fit — the best a
 * single cubic can do across two different curves.
 */
function fitEdgeForward(s: OutlineSamples, startLen: number, span: number, flip: boolean): Cubic {
    if (span > 1e-9) {
        const a0 = cubicAt(s, startLen);
        const b0 = cubicAt(s, startLen + span);
        // Same segment (allowing the end to sit exactly on the segment's end,
        // where cubicAt of the wrap reports the NEXT segment at t=0).
        const sameSeg =
            (a0.idx === b0.idx && b0.t > a0.t + 1e-6) ||
            (b0.t < 1e-6 && (a0.idx + 1) % s.cubics.length === b0.idx);
        if (sameSeg) {
            const t0 = a0.t;
            const t1 = b0.t < 1e-6 && a0.idx !== b0.idx ? 1 : b0.t;
            const [, right] = splitCubic(s.cubics[a0.idx], t0);
            const local = t0 < 1 - 1e-9 ? (t1 - t0) / (1 - t0) : 1;
            const [sub] = splitCubic(right, Math.max(0, Math.min(1, local)));
            return flip ? ([sub[3], sub[2], sub[1], sub[0]] as Cubic) : sub;
        }
    }
    // Fallback endpoints: evaluated on the TRUE outline cubic (atLength
    // interpolates between flat samples and can sit a sagitta off-curve —
    // boundary vertices must always lie exactly on the shape).
    const ca = cubicAt(s, startLen);
    const cb = cubicAt(s, startLen + span);
    const a = { p: evalCubic(s.cubics[ca.idx], ca.t) };
    const b = { p: evalCubic(s.cubics[cb.idx], cb.t) };
    const inset = span * 0.02;
    const aIn = atLength(s, startLen + inset).p;
    const bIn = atLength(s, startLen + span - inset).p;
    const norm = (dx: number, dy: number): Vec2 => {
        const l = Math.hypot(dx, dy) || 1;
        return [dx / l, dy / l];
    };
    const t1 = norm(aIn[0] - a.p[0], aIn[1] - a.p[1]); // out of P0, into the stretch
    const t2 = norm(bIn[0] - b.p[0], bIn[1] - b.p[1]); // out of P3, back into the stretch

    // Least squares for the handle lengths α1, α2 with P1 = P0 + α1·t1 and
    // P2 = P3 + α2·t2: minimize Σ|Q(u_i) − d_i|² over outline samples d_i at
    // arc-length parameters u_i. Normal equations are a 2×2 system.
    const K = 14;
    let c11 = 0;
    let c12 = 0;
    let c22 = 0;
    let x1 = 0;
    let x2 = 0;
    for (let i = 1; i < K; i++) {
        const u = i / K;
        const d = atLength(s, startLen + span * u).p;
        const mu = 1 - u;
        const b0 = mu * mu * mu;
        const b1 = 3 * mu * mu * u;
        const b2 = 3 * mu * u * u;
        const b3 = u * u * u;
        const a1x = b1 * t1[0];
        const a1y = b1 * t1[1];
        const a2x = b2 * t2[0];
        const a2y = b2 * t2[1];
        const rx = d[0] - ((b0 + b1) * a.p[0] + (b2 + b3) * b.p[0]);
        const ry = d[1] - ((b0 + b1) * a.p[1] + (b2 + b3) * b.p[1]);
        c11 += a1x * a1x + a1y * a1y;
        c12 += a1x * a2x + a1y * a2y;
        c22 += a2x * a2x + a2y * a2y;
        x1 += a1x * rx + a1y * ry;
        x2 += a2x * rx + a2y * ry;
    }
    const det = c11 * c22 - c12 * c12;
    let alpha1 = span / 3;
    let alpha2 = span / 3;
    if (Math.abs(det) > 1e-9) {
        const s1 = (x1 * c22 - x2 * c12) / det;
        const s2 = (c11 * x2 - c12 * x1) / det;
        // Degenerate solutions (non-positive or wild lengths) fall back to ⅓.
        if (s1 > 1e-6 && s2 > 1e-6 && s1 < span && s2 < span) {
            alpha1 = s1;
            alpha2 = s2;
        }
    }
    const c: Cubic = [
        a.p,
        [a.p[0] + t1[0] * alpha1, a.p[1] + t1[1] * alpha1],
        [b.p[0] + t2[0] * alpha2, b.p[1] + t2[1] * alpha2],
        b.p,
    ];
    return flip ? ([c[3], c[2], c[1], c[0]] as Cubic) : c;
}

/** One side of the fitted mesh: an outline stretch (forward walk from
 *  `start` by `span`) plus whether that walk opposes the mesh direction
 *  (+u for top/bottom, +v for left/right). */
interface Side {
    start: number;
    span: number;
    reverse: boolean;
}

/** Cubic fitted to the sub-stretch [f0, f1] (mesh-direction fractions). */
function sideEdge(s: OutlineSamples, side: Side, f0: number, f1: number): Cubic {
    const from = side.start + side.span * (side.reverse ? 1 - f1 : f0);
    return fitEdgeForward(s, from, side.span * (f1 - f0), side.reverse);
}

/** Roles of the four mesh corners on the outline. */
interface CornerPick {
    /** Arc lengths of TL, TR, BR, BL corner points along the outline. */
    len: { tl: number; tr: number; br: number; bl: number };
    /** True when walking the outline forward goes TL → TR (top first). */
    forward: boolean;
}

function pickCorners(s: OutlineSamples): CornerPick | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of s.pts) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
    }
    const nearest = (cx: number, cy: number): number => {
        let best = 0;
        let bestD = Infinity;
        for (let i = 0; i < s.pts.length; i++) {
            const d = (s.pts[i][0] - cx) ** 2 + (s.pts[i][1] - cy) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    };
    const iTL = nearest(minX, minY);
    const iTR = nearest(maxX, minY);
    const iBR = nearest(maxX, maxY);
    const iBL = nearest(minX, maxY);
    const idx = [iTL, iTR, iBR, iBL];
    if (new Set(idx).size !== 4) return null;
    // Walking forward from TL we must meet the other corners in either
    // TR→BR→BL order (forward/clockwise-ish) or BL→BR→TR (reversed).
    const rel = (i: number) => (i - iTL + s.pts.length) % s.pts.length;
    const rTR = rel(iTR);
    const rBR = rel(iBR);
    const rBL = rel(iBL);
    const forward = rTR < rBR && rBR < rBL;
    const reversed = rBL < rBR && rBR < rTR;
    if (!forward && !reversed) return null; // corners interleave weirdly
    return {
        len: { tl: s.cum[iTL], tr: s.cum[iTR], br: s.cum[iBR], bl: s.cum[iBL] },
        forward,
    };
}

/**
 * Build a shape-fitted mesh: boundary on the outline, interior by Coons
 * placement. `uFractions`/`vFractions` are the interior grid-line positions
 * in (0,1) (ascending). Colors are all-black — seed them afterwards.
 * Returns null when the geometry can't be fitted (no closed outline,
 * degenerate corners) — callers fall back to a rectangular grid.
 */
export function fitMeshToOutline(
    geo: NodeGeometry,
    uFractions: number[],
    vFractions: number[],
): MeshGradient | null {
    const cubics = outlineCubics(geo);
    if (!cubics) return null;
    const s = sampleOutline(cubics);
    if (s.total < 1e-6) return null;
    const pick = pickCorners(s);
    if (!pick) return null;

    const { len, forward } = pick;
    const stretch = (a: number, b: number) => (((b - a) % s.total) + s.total) % s.total;
    // The four sides as forward outline stretches. Walking forward from TL
    // meets TR first (forward=true, clockwise-ish for y-down) or BL first;
    // sides whose outline direction opposes the mesh's +u/+v get `reverse`.
    let top: Side;
    let right: Side;
    let bottom: Side;
    let left: Side;
    if (forward) {
        top = { start: len.tl, span: stretch(len.tl, len.tr), reverse: false };
        right = { start: len.tr, span: stretch(len.tr, len.br), reverse: false };
        bottom = { start: len.br, span: stretch(len.br, len.bl), reverse: true };
        left = { start: len.bl, span: stretch(len.bl, len.tl), reverse: true };
    } else {
        left = { start: len.tl, span: stretch(len.tl, len.bl), reverse: false };
        bottom = { start: len.bl, span: stretch(len.bl, len.br), reverse: false };
        right = { start: len.br, span: stretch(len.br, len.tr), reverse: true };
        top = { start: len.tr, span: stretch(len.tr, len.tl), reverse: true };
    }
    if (Math.min(top.span, right.span, bottom.span, left.span) < s.total * 0.02) return null;

    // Cut the grid at the outline's own anchor points: every boundary edge
    // then lies within a single outline segment and is its EXACT sub-curve
    // (see fitEdgeForward) — the mesh boundary IS the shape, not a fit.
    // Anchors on the top/bottom sides become column lines, left/right ones
    // become rows; the requested fractions (the user's click) are merged in.
    const sideAnchorFractions = (side: Side): number[] => {
        const out: number[] = [];
        for (const al of anchorLengths(s)) {
            const fwd = (((al - side.start) % s.total) + s.total) % s.total;
            if (fwd <= 1e-9 || fwd >= side.span - 1e-9) continue; // corner itself
            const g = fwd / side.span;
            out.push(side.reverse ? 1 - g : g);
        }
        return out;
    };
    const mergeFractions = (requested: number[], anchors: number[]): number[] => {
        const MIN_GAP = 0.02;
        const all = [
            ...anchors.map((f) => ({ f, anchor: true })),
            ...requested.map((f) => ({ f, anchor: false })),
        ].sort((a, b) => a.f - b.f);
        const kept: { f: number; anchor: boolean }[] = [];
        for (const e of all) {
            if (e.f < MIN_GAP || e.f > 1 - MIN_GAP) continue;
            const prev = kept[kept.length - 1];
            if (prev && e.f - prev.f < MIN_GAP) {
                // Too close: keep the anchor cut (exactness) over the click.
                if (e.anchor && !prev.anchor) prev.f = e.f;
                continue;
            }
            kept.push({ ...e });
        }
        return kept.map((e) => e.f);
    };
    const us = [
        0,
        ...mergeFractions(uFractions, [
            ...sideAnchorFractions(top),
            ...sideAnchorFractions(bottom),
        ]),
        1,
    ];
    const vs = [
        0,
        ...mergeFractions(vFractions, [
            ...sideAnchorFractions(left),
            ...sideAnchorFractions(right),
        ]),
        1,
    ];
    const rows = vs.length - 1;
    const cols = us.length - 1;

    // Whole-side cubics for Coons interior placement.
    const coons = {
        top: sideEdge(s, top, 0, 1),
        bottom: sideEdge(s, bottom, 0, 1),
        left: sideEdge(s, left, 0, 1),
        right: sideEdge(s, right, 0, 1),
    };

    // Boundary edge curves (exact outline sub-curves between cuts). Vertex
    // positions come from THESE endpoints, so anchors sit exactly on the
    // outline and adjacent edges share endpoints bit-for-bit.
    const topEdges: Cubic[] = [];
    const bottomEdges: Cubic[] = [];
    for (let c = 0; c < cols; c++) {
        topEdges.push(sideEdge(s, top, us[c], us[c + 1]));
        bottomEdges.push(sideEdge(s, bottom, us[c], us[c + 1]));
    }
    const leftEdges: Cubic[] = [];
    const rightEdges: Cubic[] = [];
    for (let r = 0; r < rows; r++) {
        leftEdges.push(sideEdge(s, left, vs[r], vs[r + 1]));
        rightEdges.push(sideEdge(s, right, vs[r], vs[r + 1]));
    }

    const black: Color = { r: 0, g: 0, b: 0, a: 1 };
    const mesh: MeshGradient = { rows, cols, vertices: [] };
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            let p: Vec2;
            if (r === 0) p = c < cols ? topEdges[c][0] : topEdges[cols - 1][3];
            else if (r === rows) p = c < cols ? bottomEdges[c][0] : bottomEdges[cols - 1][3];
            else if (c === 0) p = leftEdges[r][0];
            else if (c === cols) p = rightEdges[r][0];
            else p = evalCoons(coons, us[c], vs[r]);
            mesh.vertices.push({ x: p[0], y: p[1], color: { ...black } });
        }
    }

    // Boundary handles: each edge's inner control points, stored on the
    // edge's two vertices (interior handles stay auto).
    const setH = (r: number, c: number, dirKey: 'e' | 'w' | 's' | 'n', p: Vec2) => {
        const v = mesh.vertices[r * (cols + 1) + c];
        if (!v.handles) v.handles = {};
        v.handles[dirKey] = [p[0], p[1]];
    };
    for (let c = 0; c < cols; c++) {
        setH(0, c, 'e', topEdges[c][1]);
        setH(0, c + 1, 'w', topEdges[c][2]);
        setH(rows, c, 'e', bottomEdges[c][1]);
        setH(rows, c + 1, 'w', bottomEdges[c][2]);
    }
    for (let r = 0; r < rows; r++) {
        setH(r, 0, 's', leftEdges[r][1]);
        setH(r + 1, 0, 'n', leftEdges[r][2]);
        setH(r, cols, 's', rightEdges[r][1]);
        setH(r + 1, cols, 'n', rightEdges[r][2]);
    }
    return mesh;
}

// ─── Boundary re-snap (mesh follows shape edits) ─────────────────────────

/**
 * Glue an existing mesh's OUTER RING back onto the node's (edited) outline:
 * each boundary vertex snaps to its nearest outline point and each boundary
 * edge re-fits its along-line handles to the outline stretch between its
 * endpoints. Interior vertices, inward handles, and all colors stay as the
 * user left them (the engine's bbox affine has already carried gross scaling).
 *
 * Returns the snapped mesh, or null when the geometry has no closed outline
 * or the projection degenerates (callers keep the affine-adapted mesh).
 */
export function snapMeshBoundaryToOutline(
    mesh: MeshGradient,
    geo: NodeGeometry,
): MeshGradient | null {
    const cubics = outlineCubics(geo);
    if (!cubics) return null;
    const s = sampleOutline(cubics);
    if (s.total < 1e-6) return null;

    const rows = mesh.rows;
    const cols = mesh.cols;
    const stride = cols + 1;
    const next: MeshGradient = {
        rows,
        cols,
        vertices: mesh.vertices.map((v) => ({
            x: v.x,
            y: v.y,
            color: { ...v.color },
            ...(v.handles ? { handles: { ...v.handles } } : {}),
        })),
    };

    // Project every boundary vertex to its nearest outline sample.
    const arcOf = new Map<number, number>();
    const isBoundary = (r: number, c: number) => r === 0 || r === rows || c === 0 || c === cols;
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            if (!isBoundary(r, c)) continue;
            const vi = r * stride + c;
            const v = next.vertices[vi];
            let best = 0;
            let bestD = Infinity;
            for (let i = 0; i < s.pts.length; i++) {
                const d = (s.pts[i][0] - v.x) ** 2 + (s.pts[i][1] - v.y) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = i;
                }
            }
            arcOf.set(vi, s.cum[best]);
            v.x = s.pts[best][0];
            v.y = s.pts[best][1];
        }
    }

    // Re-fit each boundary edge's along-line handles to the outline stretch
    // between its (snapped) endpoints, walking whichever way is shorter.
    const setH = (vi: number, dir: 'e' | 'w' | 's' | 'n', p: Vec2) => {
        const v = next.vertices[vi];
        if (!v.handles) v.handles = {};
        v.handles[dir] = [p[0], p[1]];
    };
    const refit = (aVi: number, bVi: number, aDir: 'e' | 's', bDir: 'w' | 'n') => {
        const la = arcOf.get(aVi);
        const lb = arcOf.get(bVi);
        if (la === undefined || lb === undefined) return;
        const fwd = (((lb - la) % s.total) + s.total) % s.total;
        const bwd = s.total - fwd;
        const span = Math.min(fwd, bwd);
        // Coincident endpoints or a stretch that would wrap around most of
        // the outline → the projection is unreliable; keep existing handles.
        if (span < s.total * 1e-4 || span > s.total * 0.45) return;
        const cubic =
            fwd <= bwd ? fitEdgeForward(s, la, fwd, false) : fitEdgeForward(s, lb, bwd, true);
        setH(aVi, aDir, cubic[1]);
        setH(bVi, bDir, cubic[2]);
    };
    for (let c = 0; c < cols; c++) {
        refit(c, c + 1, 'e', 'w'); // top row
        refit(rows * stride + c, rows * stride + c + 1, 'e', 'w'); // bottom row
    }
    for (let r = 0; r < rows; r++) {
        refit(r * stride, (r + 1) * stride, 's', 'n'); // left column
        refit(r * stride + cols, (r + 1) * stride + cols, 's', 'n'); // right column
    }
    return next;
}

// ─── Color seeding ───────────────────────────────────────────────────────

/** Sample the paint being replaced at a node-local point. */
export function samplePaintAt(paint: Paint | null | undefined, x: number, y: number): Color {
    if (!paint) return { r: 0.8, g: 0.8, b: 0.8, a: 1 };
    if (isMeshGradient(paint)) {
        // Replacing a mesh with a mesh: keep it simple, mean is predictable.
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (const v of paint.vertices) {
            r += v.color.r;
            g += v.color.g;
            b += v.color.b;
            a += v.color.a;
        }
        const n = Math.max(1, paint.vertices.length);
        return { r: r / n, g: g / n, b: b / n, a: a / n };
    }
    if (isPattern(paint)) return { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    if (isGradient(paint)) {
        let t: number;
        if (paint.gradient_type === 'Linear') {
            const dx = paint.end_x - paint.start_x;
            const dy = paint.end_y - paint.start_y;
            const len2 = dx * dx + dy * dy;
            t = len2 < 1e-9 ? 0 : ((x - paint.start_x) * dx + (y - paint.start_y) * dy) / len2;
        } else {
            const r = Math.hypot(paint.end_x - paint.start_x, paint.end_y - paint.start_y);
            t = r < 1e-9 ? 0 : Math.hypot(x - paint.start_x, y - paint.start_y) / r;
        }
        return sampleGradientColor(paint, Math.max(0, Math.min(1, t)));
    }
    return { ...paint };
}

/** Seed every vertex color by sampling `prevFill` at the vertex position. */
export function seedMeshColors(mesh: MeshGradient, prevFill: Paint | null | undefined) {
    for (const v of mesh.vertices) {
        v.color = samplePaintAt(prevFill, v.x, v.y);
    }
}

// ─── Creation entry point ────────────────────────────────────────────────

/** Clamp interior-line fractions away from the boundary so a click near the
 *  edge can't create a degenerate sliver row/column. */
const FRACTION_MIN = 0.04;

export interface CreateMeshOptions {
    /** Node-local click point the interior lines should pass through;
     *  omitted (panel path) = centered lines. */
    clickLocal?: { x: number; y: number };
}

/**
 * Create the initial 2×2-patch mesh for a node: shape-fitted boundary when
 * the outline allows it, rectangular-grid fallback otherwise; interior lines
 * through the click (or centered); colors seeded from the fill it replaces.
 * Returns null only when the geometry has no extent at all.
 */
export function createMeshForNode(
    geo: NodeGeometry,
    prevFill: Paint | null | undefined,
    opts: CreateMeshOptions = {},
): MeshGradient | null {
    // Interior line fractions from the click, via the coarse fitted surface.
    let fu = 0.5;
    let fv = 0.5;
    let coarse: MeshGradient | null = null;
    if (opts.clickLocal) {
        coarse = fitMeshToOutline(geo, [], []);
        if (coarse) {
            const hit = pointToUV(coarse, [opts.clickLocal.x, opts.clickLocal.y]);
            if (hit) {
                fu = hit.u;
                fv = hit.v;
            }
        }
    }
    fu = Math.max(FRACTION_MIN, Math.min(1 - FRACTION_MIN, fu));
    fv = Math.max(FRACTION_MIN, Math.min(1 - FRACTION_MIN, fv));

    let mesh = fitMeshToOutline(geo, [fu], [fv]);
    if (!mesh) {
        // Fallback: rectangular grid over the geometry bbox.
        const b = geometryBBox(geo);
        if (!b) return null;
        if (opts.clickLocal) {
            fu = Math.max(
                FRACTION_MIN,
                Math.min(1 - FRACTION_MIN, (opts.clickLocal.x - b.x) / b.w),
            );
            fv = Math.max(
                FRACTION_MIN,
                Math.min(1 - FRACTION_MIN, (opts.clickLocal.y - b.y) / b.h),
            );
        }
        mesh = makeRectMesh(b.x, b.y, b.w, b.h, [fv], [fu], { r: 0, g: 0, b: 0, a: 1 });
    }
    seedMeshColors(mesh, prevFill);
    return mesh;
}

/** Node-local bounding box of the geometry (fallback grid extent). */
export function geometryBBox(
    geo: NodeGeometry,
): { x: number; y: number; w: number; h: number } | null {
    if (geo.Rect) {
        const { width: w, height: h } = geo.Rect;
        return w > 0 && h > 0 ? { x: 0, y: 0, w, h } : null;
    }
    if (geo.Ellipse) {
        const { radius_x: rx, radius_y: ry } = geo.Ellipse;
        return rx > 0 && ry > 0 ? { x: -rx, y: -ry, w: 2 * rx, h: 2 * ry } : null;
    }
    if (geo.Path) {
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const sp of geo.Path.subpaths ?? []) {
            for (const p of sp.points) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
        }
        return minX < maxX && minY < maxY
            ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
            : null;
    }
    return null;
}
