/**
 * Pure geometry for Coons-patch mesh gradients (no CanvasKit / DOM deps).
 *
 * One implementation shared by four consumers: the renderer (tessellation →
 * drawVertices), the mesh edit controller (hit-testing, pointToUV), the
 * overlay (grid-line cubics, ghost iso-lines), and SVG export (rasterization).
 *
 * Mesh layout: `rows`×`cols` patches, `(rows+1)*(cols+1)` vertices row-major
 * (stride `cols+1`) in node-local coordinates. Grid lines are cubic béziers:
 * the segment between two adjacent vertices takes its inner control points
 * from the vertices' direction handles (e/w along rows, s/n along columns);
 * a missing handle means "auto" = 1/3 of the way toward the neighbor.
 *
 * Watertightness: adjacent patches share their boundary cubics, boundary
 * samples are special-cased to evaluate the shared cubic directly (bitwise
 * identical on both sides), and subdivision counts are chosen per grid
 * row/column (not per patch) — so tessellation cannot open cracks or
 * T-junctions between patches.
 */

import type { Color, MeshGradient, MeshVertex } from './types';

export type Vec2 = [number, number];
/** A cubic bézier as 4 control points. */
export type Cubic = [Vec2, Vec2, Vec2, Vec2];

// ─── Vertex / handle access ──────────────────────────────────────────────

export function vertexIndex(mesh: MeshGradient, row: number, col: number): number {
    return row * (mesh.cols + 1) + col;
}

export function vertexAt(mesh: MeshGradient, row: number, col: number): MeshVertex {
    return mesh.vertices[vertexIndex(mesh, row, col)];
}

export type HandleDir = 'e' | 'w' | 's' | 'n';

/** Handle position for a vertex toward `dir`, materializing the 1/3-toward-
 *  neighbor default. Outward boundary directions return the anchor itself. */
export function effectiveHandle(mesh: MeshGradient, vi: number, dir: HandleDir): Vec2 {
    const v = mesh.vertices[vi];
    const stored = v.handles?.[dir];
    if (stored) return [stored[0], stored[1]];
    const stride = mesh.cols + 1;
    const row = Math.floor(vi / stride);
    const col = vi % stride;
    let ni = -1;
    if (dir === 'e' && col < mesh.cols) ni = vi + 1;
    else if (dir === 'w' && col > 0) ni = vi - 1;
    else if (dir === 's' && row < mesh.rows) ni = vi + stride;
    else if (dir === 'n' && row > 0) ni = vi - stride;
    if (ni < 0) return [v.x, v.y];
    const nv = mesh.vertices[ni];
    return [v.x + (nv.x - v.x) / 3, v.y + (nv.y - v.y) / 3];
}

/** The horizontal grid-line cubic from vertex (row, col) to (row, col+1). */
export function hEdgeCubic(mesh: MeshGradient, row: number, col: number): Cubic {
    const a = vertexIndex(mesh, row, col);
    const b = vertexIndex(mesh, row, col + 1);
    const va = mesh.vertices[a];
    const vb = mesh.vertices[b];
    return [
        [va.x, va.y],
        effectiveHandle(mesh, a, 'e'),
        effectiveHandle(mesh, b, 'w'),
        [vb.x, vb.y],
    ];
}

/** The vertical grid-line cubic from vertex (row, col) to (row+1, col). */
export function vEdgeCubic(mesh: MeshGradient, row: number, col: number): Cubic {
    const a = vertexIndex(mesh, row, col);
    const b = vertexIndex(mesh, row + 1, col);
    const va = mesh.vertices[a];
    const vb = mesh.vertices[b];
    return [
        [va.x, va.y],
        effectiveHandle(mesh, a, 's'),
        effectiveHandle(mesh, b, 'n'),
        [vb.x, vb.y],
    ];
}

// ─── Cubic bézier math ───────────────────────────────────────────────────

export function evalCubic(c: Cubic, t: number): Vec2 {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const d = 3 * mt * t * t;
    const e = t * t * t;
    return [
        a * c[0][0] + b * c[1][0] + d * c[2][0] + e * c[3][0],
        a * c[0][1] + b * c[1][1] + d * c[2][1] + e * c[3][1],
    ];
}

/** De Casteljau split of a cubic at t → [left, right] halves. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
    const lerp = (p: Vec2, q: Vec2): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const ab = lerp(c[0], c[1]);
    const bc = lerp(c[1], c[2]);
    const cd = lerp(c[2], c[3]);
    const abbc = lerp(ab, bc);
    const bccd = lerp(bc, cd);
    const mid = lerp(abbc, bccd);
    return [
        [c[0], ab, abbc, mid],
        [mid, bccd, cd, c[3]],
    ];
}

/** Crude polyline arc length of a cubic (enough for subdivision heuristics). */
export function cubicLength(c: Cubic, samples = 8): number {
    let len = 0;
    let prev = c[0];
    for (let i = 1; i <= samples; i++) {
        const p = evalCubic(c, i / samples);
        len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
    }
    return len;
}

// ─── Coons patch evaluation ──────────────────────────────────────────────

/** The 4 boundary cubics of patch (pr, pc): top, bottom, left, right.
 *  top/bottom run in +u (col → col+1), left/right run in +v (row → row+1). */
export function patchBoundaryCubics(
    mesh: MeshGradient,
    pr: number,
    pc: number,
): { top: Cubic; bottom: Cubic; left: Cubic; right: Cubic } {
    return {
        top: hEdgeCubic(mesh, pr, pc),
        bottom: hEdgeCubic(mesh, pr + 1, pc),
        left: vEdgeCubic(mesh, pr, pc),
        right: vEdgeCubic(mesh, pr, pc + 1),
    };
}

/**
 * Evaluate the Coons surface of one patch at (u, v) ∈ [0,1]².
 * Boundary parameters are special-cased to evaluate the boundary cubic
 * directly so shared patch edges produce bitwise-identical samples.
 */
export function evalCoons(
    b: { top: Cubic; bottom: Cubic; left: Cubic; right: Cubic },
    u: number,
    v: number,
): Vec2 {
    if (v === 0) return evalCubic(b.top, u);
    if (v === 1) return evalCubic(b.bottom, u);
    if (u === 0) return evalCubic(b.left, v);
    if (u === 1) return evalCubic(b.right, v);
    const top = evalCubic(b.top, u);
    const bottom = evalCubic(b.bottom, u);
    const left = evalCubic(b.left, v);
    const right = evalCubic(b.right, v);
    const p00 = b.top[0];
    const p10 = b.top[3];
    const p01 = b.bottom[0];
    const p11 = b.bottom[3];
    const x =
        (1 - v) * top[0] +
        v * bottom[0] +
        (1 - u) * left[0] +
        u * right[0] -
        ((1 - u) * (1 - v) * p00[0] + u * (1 - v) * p10[0] + (1 - u) * v * p01[0] + u * v * p11[0]);
    const y =
        (1 - v) * top[1] +
        v * bottom[1] +
        (1 - u) * left[1] +
        u * right[1] -
        ((1 - u) * (1 - v) * p00[1] + u * (1 - v) * p10[1] + (1 - u) * v * p01[1] + u * v * p11[1]);
    return [x, y];
}

/** Bilinear interpolation of the 4 patch corner colors at (u, v). */
export function bilinearColor(
    c00: Color,
    c10: Color,
    c01: Color,
    c11: Color,
    u: number,
    v: number,
): Color {
    const mix = (a: number, b: number, c: number, d: number) =>
        (1 - u) * (1 - v) * a + u * (1 - v) * b + (1 - u) * v * c + u * v * d;
    return {
        r: mix(c00.r, c10.r, c01.r, c11.r),
        g: mix(c00.g, c10.g, c01.g, c11.g),
        b: mix(c00.b, c10.b, c01.b, c11.b),
        a: mix(c00.a, c10.a, c01.a, c11.a),
    };
}

/** Mean of all vertex colors — the mesh's single representative color. */
export function meanColor(mesh: MeshGradient): Color {
    const n = Math.max(1, mesh.vertices.length);
    const acc = { r: 0, g: 0, b: 0, a: 0 };
    for (const v of mesh.vertices) {
        acc.r += v.color.r;
        acc.g += v.color.g;
        acc.b += v.color.b;
        acc.a += v.color.a;
    }
    return { r: acc.r / n, g: acc.g / n, b: acc.b / n, a: acc.a / n };
}

// ─── Tessellation ────────────────────────────────────────────────────────

/** Pack a 0–1 RGBA color into CanvasKit's ColorInt (unpremul ARGB u32). */
function packColor(c: Color, alphaScale: number): number {
    const cl = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255)));
    // >>> 0 keeps it an unsigned u32 for the Uint32Array.
    return ((cl(c.a * alphaScale) << 24) | (cl(c.r) << 16) | (cl(c.g) << 8) | cl(c.b)) >>> 0;
}

/** How far a cubic can stray from a polyline through evenly spaced samples,
 *  scaled: the classic second-difference bound. `error ≈ d2 / (8·n²)`, so
 *  `n = sqrt(d2 / (8·tolerance))` segments hit a given tolerance. */
function cubicFlatnessMetric(c: Cubic): number {
    const ax = c[0][0] - 2 * c[1][0] + c[2][0];
    const ay = c[0][1] - 2 * c[1][1] + c[2][1];
    const bx = c[1][0] - 2 * c[2][0] + c[3][0];
    const by = c[1][1] - 2 * c[2][1] + c[3][1];
    return 3 * Math.sqrt(Math.max(ax * ax + ay * ay, bx * bx + by * by));
}

/** Segments needed to keep a Coons patch's colour ramp smooth: Gouraud
 *  triangles approximate the bilinear corner blend with an error that falls
 *  as 1/n², so a small fixed count is plenty (measured: n=6 is pixel-identical
 *  to n=48 on real meshes). */
const COLOR_SUBDIV = 6;

/**
 * Per-grid-column / per-grid-row subdivision counts at a given world scale
 * (device px per local unit). Chosen from the WORST (curviest) edge in that
 * column/row so both sides of every shared edge subdivide identically.
 *
 * Counts are curvature-driven, not length-driven: a long straight edge needs
 * 2 segments, a tight curve needs many. (The old length/8 rule tessellated a
 * plain 6×5 mesh into 46k triangles — ~17ms per rebuild — for output
 * indistinguishable from 2.7k.) The total is still capped so indices fit
 * Uint16Array.
 */
export function subdivisionCounts(
    mesh: MeshGradient,
    worldScale: number,
): { u: number[]; v: number[] } {
    // Sub-pixel geometry tolerance; the raster is resampled by the shader, so
    // a little slack here is invisible.
    const TOL = 0.25;
    const patches = Math.max(1, mesh.rows * mesh.cols);
    const cap = Math.max(2, Math.min(24, Math.floor(Math.sqrt(44000 / patches)) - 1));
    const countFor = (worstMetric: number) => {
        const n = Math.ceil(Math.sqrt((worstMetric * worldScale) / (8 * TOL)));
        return Math.max(2, Math.min(cap, Math.max(n, Math.min(COLOR_SUBDIV, cap))));
    };
    const u: number[] = [];
    for (let pc = 0; pc < mesh.cols; pc++) {
        let worst = 0;
        for (let row = 0; row <= mesh.rows; row++) {
            worst = Math.max(worst, cubicFlatnessMetric(hEdgeCubic(mesh, row, pc)));
        }
        u.push(countFor(worst));
    }
    const v: number[] = [];
    for (let pr = 0; pr < mesh.rows; pr++) {
        let worst = 0;
        for (let col = 0; col <= mesh.cols; col++) {
            worst = Math.max(worst, cubicFlatnessMetric(vEdgeCubic(mesh, pr, col)));
        }
        v.push(countFor(worst));
    }
    return { u, v };
}

export interface MeshTessellation {
    /** Flat x,y pairs. */
    positions: Float32Array;
    /** CanvasKit ColorInt (ARGB u32) per vertex. */
    colors: Uint32Array;
    /** Triangle list. */
    indices: Uint16Array;
}

/**
 * Tessellate the whole mesh into a triangle list with per-vertex colors.
 * `alphaScale` multiplies vertex alpha (node opacity is folded into the wire
 * colors already; this is for extra callers like export previews — pass 1).
 *
 * `outset` (node-local units) extrudes a strip along the outer boundary,
 * extending each boundary sample's color outward along its normal. The fill
 * is painted as `node path ∩ this raster`, so wherever the shape-fitted
 * boundary undershoots the true path (a hairline sliver, or whole lobes on a
 * many-point blob a 4-sided fit can't follow) the flood shows the nearest
 * boundary color instead of a transparent hole. The strip is emitted FIRST so
 * the real patches paint over any fold-overs at concave notches.
 */
export function tessellate(
    mesh: MeshGradient,
    subdivU: number[],
    subdivV: number[],
    alphaScale = 1,
    outset = 0,
): MeshTessellation {
    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    if (outset > 0) {
        appendBoundaryStrip(mesh, alphaScale, outset, positions, colors, indices);
    }
    for (let pr = 0; pr < mesh.rows; pr++) {
        for (let pc = 0; pc < mesh.cols; pc++) {
            const b = patchBoundaryCubics(mesh, pr, pc);
            const c00 = vertexAt(mesh, pr, pc).color;
            const c10 = vertexAt(mesh, pr, pc + 1).color;
            const c01 = vertexAt(mesh, pr + 1, pc).color;
            const c11 = vertexAt(mesh, pr + 1, pc + 1).color;
            const nu = subdivU[pc];
            const nv = subdivV[pr];
            const base = positions.length / 2;
            for (let j = 0; j <= nv; j++) {
                const v = j / nv;
                for (let i = 0; i <= nu; i++) {
                    const u = i / nu;
                    const p = evalCoons(b, u, v);
                    positions.push(p[0], p[1]);
                    colors.push(packColor(bilinearColor(c00, c10, c01, c11, u, v), alphaScale));
                }
            }
            for (let j = 0; j < nv; j++) {
                for (let i = 0; i < nu; i++) {
                    const r0 = base + j * (nu + 1) + i;
                    const r1 = r0 + (nu + 1);
                    indices.push(r0, r0 + 1, r1, r0 + 1, r1 + 1, r1);
                }
            }
        }
    }
    return {
        positions: new Float32Array(positions),
        colors: new Uint32Array(colors),
        indices: new Uint16Array(indices),
    };
}

/** Extrude the mesh's outer boundary outward by `outset`, carrying the edge
 *  colors, and append the strip triangles to the tessellation arrays. */
function appendBoundaryStrip(
    mesh: MeshGradient,
    alphaScale: number,
    outset: number,
    positions: number[],
    colors: number[],
    indices: number[],
) {
    // Walk the boundary as one closed polyline of samples with colors:
    // top row (+u), right column (+v), bottom row (-u), left column (-v).
    // The strip uses its own modest sample density: its inner edge chords the
    // boundary, and any sliver between chord and curve is covered either by
    // the patches (concave side) or by the outset band itself (convex side).
    const STRIP_SAMPLES_PER_EDGE = 8;
    const pts: Vec2[] = [];
    const cols: number[] = [];
    const emitEdge = (cubic: Cubic, c0: Color, c1: Color, reverse: boolean) => {
        // Skip the final sample of each edge — the next edge starts with it.
        for (let i = 0; i < STRIP_SAMPLES_PER_EDGE; i++) {
            const t = reverse ? 1 - i / STRIP_SAMPLES_PER_EDGE : i / STRIP_SAMPLES_PER_EDGE;
            pts.push(evalCubic(cubic, t));
            const f = reverse ? 1 - t : t;
            cols.push(
                packColor(
                    {
                        r: c0.r + (c1.r - c0.r) * f,
                        g: c0.g + (c1.g - c0.g) * f,
                        b: c0.b + (c1.b - c0.b) * f,
                        a: c0.a + (c1.a - c0.a) * f,
                    },
                    alphaScale,
                ),
            );
        }
    };
    for (let pc = 0; pc < mesh.cols; pc++) {
        const a = vertexAt(mesh, 0, pc).color;
        const b = vertexAt(mesh, 0, pc + 1).color;
        emitEdge(hEdgeCubic(mesh, 0, pc), a, b, false);
    }
    for (let pr = 0; pr < mesh.rows; pr++) {
        const a = vertexAt(mesh, pr, mesh.cols).color;
        const b = vertexAt(mesh, pr + 1, mesh.cols).color;
        emitEdge(vEdgeCubic(mesh, pr, mesh.cols), a, b, false);
    }
    for (let pc = mesh.cols - 1; pc >= 0; pc--) {
        const a = vertexAt(mesh, mesh.rows, pc).color;
        const b = vertexAt(mesh, mesh.rows, pc + 1).color;
        emitEdge(hEdgeCubic(mesh, mesh.rows, pc), a, b, true);
    }
    for (let pr = mesh.rows - 1; pr >= 0; pr--) {
        const a = vertexAt(mesh, pr, 0).color;
        const b = vertexAt(mesh, pr + 1, 0).color;
        emitEdge(vEdgeCubic(mesh, pr, 0), a, b, true);
    }
    const n = pts.length;
    if (n < 3) return;
    // Signed area decides which normal side is "outward".
    let area = 0;
    for (let i = 0; i < n; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % n];
        area += p[0] * q[1] - q[0] * p[1];
    }
    const sign = area >= 0 ? 1 : -1;

    // Stroke-style offsetting: one rectangle per SEGMENT (segment normals
    // never fold into bowties the way averaged per-sample normals do on
    // curvy boundaries — folds leave uncovered wedges) plus a round join
    // fan at every sample to close the convex gaps between rectangles.
    const segNormal = (i: number): Vec2 => {
        const p = pts[i];
        const q = pts[(i + 1) % n];
        const nx = sign * (q[1] - p[1]);
        const ny = sign * -(q[0] - p[0]);
        const l = Math.hypot(nx, ny) || 1;
        return [nx / l, ny / l];
    };
    const push = (x: number, y: number, color: number): number => {
        positions.push(x, y);
        colors.push(color);
        return positions.length / 2 - 1;
    };
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [nx, ny] = segNormal(i);
        // Segment rectangle.
        const a = push(pts[i][0], pts[i][1], cols[i]);
        const a2 = push(pts[i][0] + nx * outset, pts[i][1] + ny * outset, cols[i]);
        const b = push(pts[j][0], pts[j][1], cols[j]);
        const b2 = push(pts[j][0] + nx * outset, pts[j][1] + ny * outset, cols[j]);
        indices.push(a, a2, b, a2, b2, b);
        // Round join fan at sample j between this segment's normal and the
        // next one's, sweeping the shorter way (concave joins just overlap).
        const [mx, my] = segNormal(j);
        const a0 = Math.atan2(ny, nx);
        const a1 = Math.atan2(my, mx);
        let sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const steps = Math.min(10, Math.ceil(Math.abs(sweep) / 0.45));
        if (steps > 0) {
            const center = push(pts[j][0], pts[j][1], cols[j]);
            let prevRim = push(
                pts[j][0] + Math.cos(a0) * outset,
                pts[j][1] + Math.sin(a0) * outset,
                cols[j],
            );
            for (let s = 1; s <= steps; s++) {
                const ang = a0 + (sweep * s) / steps;
                const rim = push(
                    pts[j][0] + Math.cos(ang) * outset,
                    pts[j][1] + Math.sin(ang) * outset,
                    cols[j],
                );
                indices.push(center, prevRim, rim);
                prevRim = rim;
            }
        }
    }
}

// ─── Point → (u, v) lookup ───────────────────────────────────────────────

export interface MeshUV {
    row: number;
    col: number;
    u: number;
    v: number;
}

/**
 * Locate a node-local point on the mesh surface. Coarse 8×8 sampling per
 * patch finds the containing cell, then two rounds of local 5×5 refinement
 * narrow (u, v) to ~1/200 of a patch — plenty for insertion/hover UX.
 * Returns null when the point lies on no patch.
 */
export function pointToUV(mesh: MeshGradient, p: Vec2): MeshUV | null {
    for (let pr = 0; pr < mesh.rows; pr++) {
        for (let pc = 0; pc < mesh.cols; pc++) {
            const b = patchBoundaryCubics(mesh, pr, pc);
            const hit = locateInPatch(b, p);
            if (hit) return { row: pr, col: pc, u: hit[0], v: hit[1] };
        }
    }
    return null;
}

function locateInPatch(
    b: { top: Cubic; bottom: Cubic; left: Cubic; right: Cubic },
    p: Vec2,
): Vec2 | null {
    const N = 8;
    const grid: Vec2[][] = [];
    for (let j = 0; j <= N; j++) {
        const rowPts: Vec2[] = [];
        for (let i = 0; i <= N; i++) rowPts.push(evalCoons(b, i / N, j / N));
        grid.push(rowPts);
    }
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const q = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
            if (pointInQuad(p, q)) {
                // Refine within the cell: two rounds of 5×5 nearest-sample.
                let u0 = i / N;
                let v0 = j / N;
                let span = 1 / N;
                for (let round = 0; round < 2; round++) {
                    let best = Infinity;
                    let bu = u0;
                    let bv = v0;
                    for (let jj = 0; jj <= 4; jj++) {
                        for (let ii = 0; ii <= 4; ii++) {
                            const uu = u0 + (span * ii) / 4;
                            const vv = v0 + (span * jj) / 4;
                            const s = evalCoons(b, Math.min(1, uu), Math.min(1, vv));
                            const d = (s[0] - p[0]) ** 2 + (s[1] - p[1]) ** 2;
                            if (d < best) {
                                best = d;
                                bu = uu;
                                bv = vv;
                            }
                        }
                    }
                    u0 = Math.max(0, bu - span / 8);
                    v0 = Math.max(0, bv - span / 8);
                    span = span / 4;
                }
                return [Math.min(1, u0 + span / 2), Math.min(1, v0 + span / 2)];
            }
        }
    }
    return null;
}

function pointInQuad(p: Vec2, q: Vec2[]): boolean {
    return pointInTri(p, q[0], q[1], q[2]) || pointInTri(p, q[0], q[2], q[3]);
}

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
    const s1 = cross(a, b, p);
    const s2 = cross(b, c, p);
    const s3 = cross(c, a, p);
    const hasNeg = s1 < 0 || s2 < 0 || s3 < 0;
    const hasPos = s1 > 0 || s2 > 0 || s3 > 0;
    return !(hasNeg && hasPos);
}

function cross(o: Vec2, a: Vec2, b: Vec2): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

// ─── Iso-lines (exact grid lines a split would create) ───────────────────

/**
 * The exact horizontal iso-curve of patch row `pr` at local parameter
 * `v` ∈ (0,1), one cubic per patch column. A Coons surface is cubic in u for
 * fixed v, so this is exact — it is both the ghost preview a hover shows and
 * the row line `splitRow` inserts (they cannot disagree).
 */
export function rowIsoCubics(mesh: MeshGradient, pr: number, v: number): Cubic[] {
    const out: Cubic[] = [];
    for (let pc = 0; pc < mesh.cols; pc++) {
        const b = patchBoundaryCubics(mesh, pr, pc);
        out.push(isoCubic(b.top, b.bottom, b.left, b.right, v));
    }
    return out;
}

/** Vertical iso-curve of patch column `pc` at `u` ∈ (0,1), cubic per row. */
export function colIsoCubics(mesh: MeshGradient, pc: number, u: number): Cubic[] {
    const out: Cubic[] = [];
    for (let pr = 0; pr < mesh.rows; pr++) {
        const b = patchBoundaryCubics(mesh, pr, pc);
        // Same construction with axes swapped: fix u, cubic in v.
        out.push(isoCubic(b.left, b.right, b.top, b.bottom, u));
    }
    return out;
}

/**
 * Iso-curve of a Coons patch at fixed cross parameter `t`, as a cubic along
 * the main axis. `a`/`b` are the two main-axis boundary cubics (at t=0 and
 * t=1), `across0`/`across1` the cross-axis boundaries at main = 0 / 1.
 *
 * S(s, t) = (1-t)·a(s) + t·b(s) + (1-s)·L + s·R  with
 *   L = across0(t) − lerp(a(0), b(0), t),  R = across1(t) − lerp(a(1), b(1), t)
 * — the correction is linear in s, so the result stays a cubic in s.
 */
function isoCubic(a: Cubic, b: Cubic, across0: Cubic, across1: Cubic, t: number): Cubic {
    const lerp = (p: Vec2, q: Vec2): Vec2 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const l0 = evalCubic(across0, t);
    const r0 = evalCubic(across1, t);
    const L: Vec2 = [l0[0] - lerp(a[0], b[0])[0], l0[1] - lerp(a[0], b[0])[1]];
    const R: Vec2 = [r0[0] - lerp(a[3], b[3])[0], r0[1] - lerp(a[3], b[3])[1]];
    const cp: Vec2[] = [];
    for (let i = 0; i < 4; i++) {
        const base = lerp(a[i], b[i]);
        const s = i / 3; // Bernstein control points of a linear function.
        cp.push([base[0] + L[0] + (R[0] - L[0]) * s, base[1] + L[1] + (R[1] - L[1]) * s]);
    }
    return [cp[0], cp[1], cp[2], cp[3]] as Cubic;
}

// ─── Structural edits (split / delete grid lines) ────────────────────────

function cloneVertex(v: MeshVertex): MeshVertex {
    return {
        x: v.x,
        y: v.y,
        color: { ...v.color },
        ...(v.handles ? { handles: { ...v.handles } } : {}),
    };
}

export function cloneMesh(mesh: MeshGradient): MeshGradient {
    return { rows: mesh.rows, cols: mesh.cols, vertices: mesh.vertices.map(cloneVertex) };
}

function setHandle(v: MeshVertex, dir: HandleDir, p: Vec2) {
    if (!v.handles) v.handles = {};
    v.handles[dir] = [p[0], p[1]];
}

/**
 * Insert a horizontal grid line through patch row `pr` at local `v` ∈ (0,1).
 * Vertical edges are de Casteljau-split (their halves reproduce the originals
 * exactly); the new row line is the exact surface iso-curve; new vertex
 * colors are the bilinear colors at the line (so rendered colors are exactly
 * unchanged). Returns a new mesh.
 */
export function splitRow(mesh: MeshGradient, pr: number, v: number): MeshGradient {
    const out = cloneMesh(mesh);
    const stride = mesh.cols + 1;
    const iso = rowIsoCubics(mesh, pr, v);
    const newRow: MeshVertex[] = [];
    for (let col = 0; col <= mesh.cols; col++) {
        const topIdx = vertexIndex(mesh, pr, col);
        const botIdx = vertexIndex(mesh, pr + 1, col);
        const [upper, lower] = splitCubic(vEdgeCubic(mesh, pr, col), v);
        const top = out.vertices[topIdx];
        const bot = out.vertices[botIdx];
        const color = bilinearColor(
            mesh.vertices[topIdx].color,
            mesh.vertices[topIdx].color,
            mesh.vertices[botIdx].color,
            mesh.vertices[botIdx].color,
            0,
            v,
        );
        const nv: MeshVertex = { x: upper[3][0], y: upper[3][1], color };
        // Split control points become the column-line handles around the cut.
        setHandle(top, 's', upper[1]);
        setHandle(nv, 'n', upper[2]);
        setHandle(nv, 's', lower[1]);
        setHandle(bot, 'n', lower[2]);
        // Along-line handles from the exact iso-curve cubics.
        if (col > 0) setHandle(nv, 'w', iso[col - 1][2]);
        if (col < mesh.cols) setHandle(nv, 'e', iso[col][1]);
        newRow.push(nv);
    }
    out.vertices.splice((pr + 1) * stride, 0, ...newRow);
    out.rows += 1;
    return out;
}

/** Insert a vertical grid line through patch column `pc` at `u` ∈ (0,1). */
export function splitCol(mesh: MeshGradient, pc: number, u: number): MeshGradient {
    const out = cloneMesh(mesh);
    const iso = colIsoCubics(mesh, pc, u);
    const newCol: MeshVertex[] = [];
    for (let row = 0; row <= mesh.rows; row++) {
        const leftIdx = vertexIndex(mesh, row, pc);
        const rightIdx = vertexIndex(mesh, row, pc + 1);
        const [first, second] = splitCubic(hEdgeCubic(mesh, row, pc), u);
        const left = out.vertices[leftIdx];
        const right = out.vertices[rightIdx];
        const color = bilinearColor(
            mesh.vertices[leftIdx].color,
            mesh.vertices[rightIdx].color,
            mesh.vertices[leftIdx].color,
            mesh.vertices[rightIdx].color,
            u,
            0,
        );
        const nv: MeshVertex = { x: first[3][0], y: first[3][1], color };
        setHandle(left, 'e', first[1]);
        setHandle(nv, 'w', first[2]);
        setHandle(nv, 'e', second[1]);
        setHandle(right, 'w', second[2]);
        if (row > 0) setHandle(nv, 'n', iso[row - 1][2]);
        if (row < mesh.rows) setHandle(nv, 's', iso[row][1]);
        newCol.push(nv);
    }
    // Insert one vertex per row at column pc+1 (walk bottom-up so earlier
    // splices don't shift the insertion offsets).
    for (let row = mesh.rows; row >= 0; row--) {
        out.vertices.splice(row * (mesh.cols + 1) + pc + 1, 0, newCol[row]);
    }
    out.cols += 1;
    return out;
}

/** Merge two cubics that meet at a removed knot into one (exact when the pair
 *  came from a split; a sensible fit otherwise). */
function mergeCubics(a: Cubic, b: Cubic, t: number): Cubic {
    const safe = Math.min(0.95, Math.max(0.05, t));
    const p1: Vec2 = [a[0][0] + (a[1][0] - a[0][0]) / safe, a[0][1] + (a[1][1] - a[0][1]) / safe];
    const p2: Vec2 = [
        b[3][0] + (b[2][0] - b[3][0]) / (1 - safe),
        b[3][1] + (b[2][1] - b[3][1]) / (1 - safe),
    ];
    return [a[0], p1, p2, b[3]];
}

/** Parameter of the removed line inside the merged span, estimated from
 *  relative arc lengths (used to invert the original split). */
function mergeT(a: Cubic, b: Cubic): number {
    const la = cubicLength(a);
    const lb = cubicLength(b);
    return la + lb < 1e-9 ? 0.5 : la / (la + lb);
}

/** Remove interior horizontal grid line `rowLine` (1..rows-1). */
export function deleteRow(mesh: MeshGradient, rowLine: number): MeshGradient {
    if (rowLine <= 0 || rowLine >= mesh.rows) return mesh;
    const out = cloneMesh(mesh);
    const stride = mesh.cols + 1;
    for (let col = 0; col <= mesh.cols; col++) {
        const above = vEdgeCubic(mesh, rowLine - 1, col);
        const below = vEdgeCubic(mesh, rowLine, col);
        const merged = mergeCubics(above, below, mergeT(above, below));
        setHandle(out.vertices[vertexIndex(mesh, rowLine - 1, col)], 's', merged[1]);
        setHandle(out.vertices[vertexIndex(mesh, rowLine + 1, col)], 'n', merged[2]);
    }
    out.vertices.splice(rowLine * stride, stride);
    out.rows -= 1;
    return out;
}

/** Remove interior vertical grid line `colLine` (1..cols-1). */
export function deleteCol(mesh: MeshGradient, colLine: number): MeshGradient {
    if (colLine <= 0 || colLine >= mesh.cols) return mesh;
    const out = cloneMesh(mesh);
    for (let row = 0; row <= mesh.rows; row++) {
        const before = hEdgeCubic(mesh, row, colLine - 1);
        const after = hEdgeCubic(mesh, row, colLine);
        const merged = mergeCubics(before, after, mergeT(before, after));
        setHandle(out.vertices[vertexIndex(mesh, row, colLine - 1)], 'e', merged[1]);
        setHandle(out.vertices[vertexIndex(mesh, row, colLine + 1)], 'w', merged[2]);
    }
    // Remove one vertex per row (walk bottom-up to keep offsets valid).
    for (let row = mesh.rows; row >= 0; row--) {
        out.vertices.splice(row * (mesh.cols + 1) + colLine, 1);
    }
    out.cols -= 1;
    return out;
}

/** Conservative node-local bounds of the mesh surface: the control-point
 *  hull (anchors + effective handles). A bezier never escapes its control
 *  hull, and the Coons interior never escapes the boundary hull union. */
export function meshBounds(mesh: MeshGradient): { x: number; y: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const take = (p: Vec2) => {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
    };
    for (let vi = 0; vi < mesh.vertices.length; vi++) {
        const v = mesh.vertices[vi];
        take([v.x, v.y]);
        take(effectiveHandle(mesh, vi, 'e'));
        take(effectiveHandle(mesh, vi, 'w'));
        take(effectiveHandle(mesh, vi, 's'));
        take(effectiveHandle(mesh, vi, 'n'));
    }
    if (minX > maxX) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Cheap content hash of a mesh (FNV-1a over the float bits + colors) — the
 *  renderer's raster-cache key. Collisions are vanishingly unlikely and only
 *  cost a stale frame. */
export function meshContentHash(mesh: MeshGradient): number {
    let h = 0x811c9dc5;
    const mix = (n: number) => {
        _hashView.setFloat32(0, n, true);
        let x = _hashView.getUint32(0, true);
        for (let i = 0; i < 4; i++) {
            h ^= x & 0xff;
            h = Math.imul(h, 0x01000193);
            x >>>= 8;
        }
    };
    mix(mesh.rows);
    mix(mesh.cols);
    for (let vi = 0; vi < mesh.vertices.length; vi++) {
        const v = mesh.vertices[vi];
        mix(v.x);
        mix(v.y);
        mix(v.color.r);
        mix(v.color.g);
        mix(v.color.b);
        mix(v.color.a);
        for (const d of ['e', 'w', 's', 'n'] as const) {
            const p = v.handles?.[d];
            if (p) {
                mix(p[0]);
                mix(p[1]);
            } else {
                mix(1e30); // distinguishes "auto" from any stored value
            }
        }
    }
    return h >>> 0;
}

const _hashView = new DataView(new ArrayBuffer(4));

// ─── Construction helpers ────────────────────────────────────────────────

/** A plain axis-aligned rectangular mesh over [x, y, w, h] with uniform
 *  color — the fallback/base builder (mesh_fit.ts builds the shape-fitted
 *  variant on top of this shape of data). Interior lines at the given
 *  fractions (ascending, in (0,1)); handles all auto. */
export function makeRectMesh(
    x: number,
    y: number,
    w: number,
    h: number,
    rowFractions: number[],
    colFractions: number[],
    color: Color,
): MeshGradient {
    const vs = [0, ...rowFractions, 1];
    const us = [0, ...colFractions, 1];
    const vertices: MeshVertex[] = [];
    for (const fv of vs) {
        for (const fu of us) {
            vertices.push({ x: x + w * fu, y: y + h * fv, color: { ...color } });
        }
    }
    return { rows: vs.length - 1, cols: us.length - 1, vertices };
}
