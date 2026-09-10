import { describe, expect, it } from 'vitest';
import {
    bilinearColor,
    cloneMesh,
    colIsoCubics,
    deleteCol,
    deleteRow,
    effectiveHandle,
    evalCoons,
    evalCubic,
    makeRectMesh,
    meanColor,
    patchBoundaryCubics,
    pointToUV,
    rowIsoCubics,
    splitCol,
    splitCubic,
    splitRow,
    subdivisionCounts,
    tessellate,
    vertexIndex,
} from './mesh_geom';
import type { Color, MeshGradient } from './types';

const RED: Color = { r: 1, g: 0, b: 0, a: 1 };

/** A 2×2-patch mesh over [0,100]² with distinct corner colors and one bent
 *  interior vertex, exercising stored + auto handles. */
function sampleMesh(): MeshGradient {
    const mesh = makeRectMesh(0, 0, 100, 100, [0.5], [0.5], RED);
    for (let i = 0; i < mesh.vertices.length; i++) {
        mesh.vertices[i].color = { r: i / 8, g: 1 - i / 8, b: 0.5, a: 1 };
    }
    // Bend the center vertex and give it one stored handle.
    const center = mesh.vertices[vertexIndex(mesh, 1, 1)];
    center.x = 55;
    center.y = 45;
    center.handles = { e: [70, 40] };
    return mesh;
}

describe('mesh_geom basics', () => {
    it('effectiveHandle materializes 1/3 defaults and respects stored handles', () => {
        const mesh = sampleMesh();
        // Vertex 0 (0,0) toward e: neighbor at (50,0) → 1/3 of the way.
        expect(effectiveHandle(mesh, 0, 'e')).toEqual([50 / 3, 0]);
        // Outward direction on a boundary vertex → the anchor itself.
        expect(effectiveHandle(mesh, 0, 'w')).toEqual([0, 0]);
        // Stored handle wins.
        expect(effectiveHandle(mesh, vertexIndex(mesh, 1, 1), 'e')).toEqual([70, 40]);
    });

    it('evalCoons reproduces boundary cubics exactly at the edges', () => {
        const mesh = sampleMesh();
        const b = patchBoundaryCubics(mesh, 0, 0);
        for (const t of [0, 0.25, 0.5, 0.75, 1]) {
            expect(evalCoons(b, t, 0)).toEqual(evalCubic(b.top, t));
            expect(evalCoons(b, t, 1)).toEqual(evalCubic(b.bottom, t));
            expect(evalCoons(b, 0, t)).toEqual(evalCubic(b.left, t));
            expect(evalCoons(b, 1, t)).toEqual(evalCubic(b.right, t));
        }
    });

    it('meanColor averages vertex colors', () => {
        const mesh = makeRectMesh(0, 0, 10, 10, [], [], { r: 0.5, g: 0.25, b: 1, a: 0.5 });
        expect(meanColor(mesh)).toEqual({ r: 0.5, g: 0.25, b: 1, a: 0.5 });
    });
});

describe('tessellation', () => {
    it('shared patch edges are watertight (bitwise-identical samples)', () => {
        const mesh = sampleMesh();
        const { u, v } = subdivisionCounts(mesh, 1);
        const tess = tessellate(mesh, u, v);
        // Patch (0,0) right edge and patch (0,1) left edge must coincide.
        const nu0 = u[0];
        const nv0 = v[0];
        const patch00 = 0;
        const patch01 = (nu0 + 1) * (nv0 + 1);
        for (let j = 0; j <= nv0; j++) {
            const a = patch00 + j * (nu0 + 1) + nu0; // u = 1 on patch (0,0)
            const bIdx = patch01 + j * (u[1] + 1); // u = 0 on patch (0,1)
            expect(tess.positions[a * 2]).toBe(tess.positions[bIdx * 2]);
            expect(tess.positions[a * 2 + 1]).toBe(tess.positions[bIdx * 2 + 1]);
            expect(tess.colors[a]).toBe(tess.colors[bIdx]);
        }
    });

    it('caps total vertices so indices fit Uint16Array', () => {
        const big = makeRectMesh(
            0,
            0,
            1000,
            1000,
            Array.from({ length: 31 }, (_, i) => (i + 1) / 32),
            Array.from({ length: 31 }, (_, i) => (i + 1) / 32),
            RED,
        );
        const { u, v } = subdivisionCounts(big, 100); // extreme zoom
        const tess = tessellate(big, u, v);
        expect(tess.positions.length / 2).toBeLessThanOrEqual(65536);
        for (const idx of tess.indices) expect(idx).toBeLessThan(tess.positions.length / 2);
    });
});

describe('pointToUV', () => {
    it('locates points and round-trips through evalCoons', () => {
        const mesh = sampleMesh();
        for (const p of [
            [10, 10],
            [70, 30],
            [52, 48],
            [90, 90],
        ] as [number, number][]) {
            const hit = pointToUV(mesh, p);
            expect(hit).not.toBeNull();
            if (!hit) continue;
            const b = patchBoundaryCubics(mesh, hit.row, hit.col);
            const q = evalCoons(b, hit.u, hit.v);
            // Refinement targets ~1/200 patch precision; patches are ~50 units.
            expect(Math.hypot(q[0] - p[0], q[1] - p[1])).toBeLessThan(1.5);
        }
    });

    it('returns null outside the mesh', () => {
        const mesh = sampleMesh();
        expect(pointToUV(mesh, [200, 200])).toBeNull();
        expect(pointToUV(mesh, [-10, 50])).toBeNull();
    });
});

describe('split / delete grid lines', () => {
    /** Max positional deviation of a dense sample grid between two meshes. */
    function surfaceDelta(a: MeshGradient, b: MeshGradient): number {
        let max = 0;
        const N = 24;
        for (let j = 0; j <= N; j++) {
            for (let i = 0; i <= N; i++) {
                // Sample both surfaces at the same global (u, v) fractions.
                const pa = sampleGlobal(a, i / N, j / N);
                const pb = sampleGlobal(b, i / N, j / N);
                max = Math.max(max, Math.hypot(pa[0] - pb[0], pa[1] - pb[1]));
            }
        }
        return max;
    }

    /** Evaluate a mesh at global fractions assuming uniform parameter spacing
     *  per patch (valid for comparing a mesh against its split version only
     *  when the split parameter matches the sampled fractions — so tests use
     *  v = 0.5 splits and N divisible by 4). */
    function sampleGlobal(mesh: MeshGradient, gu: number, gv: number): [number, number] {
        const pc = Math.min(mesh.cols - 1, Math.floor(gu * mesh.cols));
        const pr = Math.min(mesh.rows - 1, Math.floor(gv * mesh.rows));
        const b = patchBoundaryCubics(mesh, pr, pc);
        return evalCoons(b, gu * mesh.cols - pc, gv * mesh.rows - pr);
    }

    it('splitRow keeps the rendered surface (near-)identical', () => {
        const mesh = makeRectMesh(0, 0, 100, 100, [], [], RED);
        // Bend the top edge so the test isn't trivially affine.
        mesh.vertices[0].handles = { e: [20, -15] };
        const split = splitRow(mesh, 0, 0.5);
        expect(split.rows).toBe(2);
        expect(split.vertices.length).toBe(6);
        expect(surfaceDelta(mesh, split)).toBeLessThan(0.75);
    });

    it('splitCol at v=0.5 then deleteCol restores the original exactly-ish', () => {
        const mesh = sampleMesh();
        const split = splitCol(mesh, 0, 0.5);
        expect(split.cols).toBe(3);
        const back = deleteCol(split, 1);
        expect(back.cols).toBe(2);
        expect(surfaceDelta(mesh, back)).toBeLessThan(0.75);
    });

    it('split preserves colors exactly at the new line', () => {
        const mesh = sampleMesh();
        const split = splitRow(mesh, 0, 0.25);
        // New vertex on column 0 line: lerp of the two column endpoint colors.
        const top = mesh.vertices[vertexIndex(mesh, 0, 0)].color;
        const bottom = mesh.vertices[vertexIndex(mesh, 1, 0)].color;
        const expected = bilinearColor(top, top, bottom, bottom, 0, 0.25);
        const got = split.vertices[vertexIndex(split, 1, 0)].color;
        expect(got.r).toBeCloseTo(expected.r, 6);
        expect(got.g).toBeCloseTo(expected.g, 6);
    });

    it('boundary lines cannot be deleted', () => {
        const mesh = sampleMesh();
        expect(deleteRow(mesh, 0)).toBe(mesh);
        expect(deleteRow(mesh, 2)).toBe(mesh);
        expect(deleteCol(mesh, 0)).toBe(mesh);
    });

    it('iso-cubics agree with the vertices a split creates', () => {
        const mesh = sampleMesh();
        const iso = rowIsoCubics(mesh, 0, 0.3);
        const split = splitRow(mesh, 0, 0.3);
        for (let col = 0; col <= mesh.cols; col++) {
            const v = split.vertices[vertexIndex(split, 1, col)];
            const isoPt = col < mesh.cols ? iso[col][0] : iso[col - 1][3];
            expect(Math.hypot(isoPt[0] - v.x, isoPt[1] - v.y)).toBeLessThan(1e-4);
        }
        // Column iso sanity: endpoints land on the top/bottom edges.
        const cIso = colIsoCubics(mesh, 0, 0.4);
        const topEdge = patchBoundaryCubics(mesh, 0, 0).top;
        const start = evalCubic(topEdge, 0.4);
        expect(Math.hypot(cIso[0][0][0] - start[0], cIso[0][0][1] - start[1])).toBeLessThan(1e-4);
    });

    it('cloneMesh deep-copies vertices and handles', () => {
        const mesh = sampleMesh();
        const copy = cloneMesh(mesh);
        copy.vertices[0].x = 999;
        copy.vertices[4].handles!.e = [0, 0];
        expect(mesh.vertices[0].x).toBe(0);
        expect(mesh.vertices[4].handles!.e).toEqual([70, 40]);
    });

    it('splitCubic halves reproduce the original curve', () => {
        const c: [[number, number], [number, number], [number, number], [number, number]] = [
            [0, 0],
            [10, -20],
            [40, 30],
            [60, 0],
        ];
        const [l, r] = splitCubic(c, 0.3);
        for (const t of [0.1, 0.2, 0.29]) {
            const orig = evalCubic(c, t);
            const seg = evalCubic(l, t / 0.3);
            expect(Math.hypot(orig[0] - seg[0], orig[1] - seg[1])).toBeLessThan(1e-9);
        }
        for (const t of [0.31, 0.6, 0.95]) {
            const orig = evalCubic(c, t);
            const seg = evalCubic(r, (t - 0.3) / 0.7);
            expect(Math.hypot(orig[0] - seg[0], orig[1] - seg[1])).toBeLessThan(1e-9);
        }
    });
});
