import { describe, expect, it } from 'vitest';
import { SnapEngine } from './snapping';
import type { WasmScene } from './wasm_scene';

const bg = { r: 1, g: 1, b: 1, a: 1 };

/** Minimal scene stub: two top-level nodes plus one or more artboards. */
function makeScene(
    nodes: Record<number, [number, number, number, number]>,
    parents: Record<number, number> = {},
    artboards: {
        id: number;
        name: string;
        x: number;
        y: number;
        w: number;
        h: number;
        background: typeof bg;
    }[] = [{ id: 1, name: 'Artboard 1', x: 0, y: 0, w: 1000, h: 1000, background: bg }],
): WasmScene {
    return {
        engine: {
            get_document_width: () => 1000,
            get_document_height: () => 1000,
        },
        getArtboards: () => artboards,
        getRootNodes: () =>
            Uint32Array.from(
                Object.keys(nodes)
                    .map(Number)
                    .filter((id) => !(id in parents)),
            ),
        getNodeParent: (id: number) => parents[id] ?? -1,
        getNodeVisible: () => true,
        getNodeBounds: (id: number) => Float32Array.from(nodes[id]),
    } as unknown as WasmScene;
}

/** Scene stub with a real parent→children tree, plus per-node flags. */
function makeTree(
    nodes: Record<number, [number, number, number, number]>,
    parents: Record<number, number> = {},
    flags: {
        locked?: number[];
        hidden?: number[];
        masks?: number[];
        boolGroups?: number[];
        /** Real (measured) bounds where they differ from the engine's estimate —
         *  i.e. text, whose engine box is a per-character guess. */
        measured?: Record<number, [number, number, number, number]>;
    } = {},
): WasmScene {
    const ids = Object.keys(nodes).map(Number);
    const locked = new Set(flags.locked ?? []);
    const hidden = new Set(flags.hidden ?? []);
    const masks = new Set(flags.masks ?? []);
    const boolGroups = new Set(flags.boolGroups ?? []);
    return {
        engine: { get_document_width: () => 1000, get_document_height: () => 1000 },
        // One artboard, parked far off-screen so its edges never collide with
        // the node coordinates under test.
        getArtboards: () => [
            { id: 99, name: 'far', x: -5000, y: -5000, w: 100, h: 100, background: bg },
        ],
        getRootNodes: () => Uint32Array.from(ids.filter((id) => !(id in parents))),
        getNodeParent: (id: number) => parents[id] ?? -1,
        getNodeChildren: (id: number) =>
            Uint32Array.from(ids.filter((c) => parents[c] === id).sort((a, b) => a - b)),
        getNodeVisible: (id: number) => !hidden.has(id),
        getNodeLocked: (id: number) => locked.has(id),
        getNodeIsMask: (id: number) => masks.has(id),
        isBooleanGroup: (id: number) => boolGroups.has(id),
        getNodeBounds: (id: number) => Float32Array.from(nodes[id]),
        getMeasuredNodeBounds: (id: number) => flags.measured?.[id] ?? nodes[id],
        getResolvedSubpaths: () => [],
        getTransform: () => Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1]),
    } as unknown as WasmScene;
}

describe('SnapEngine', () => {
    it('snaps a box edge to another node edge within threshold', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        // Box whose left edge is at 203 — should snap to 200 (right edge of node 1)
        const r = engine.snapBounds({ x: 203, y: 500, w: 50, h: 50 }, 8);
        expect(r.dx).toBeCloseTo(-3);
        expect(r.guides).toContainEqual({ axis: 'x', pos: 200 });
    });

    it('prefers the closest candidate among min/mid/max', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        // Box center at 151 → distance 1 to mid target 150; left edge at 101 → distance 1 to 100.
        // Left edge 103 (dist 3 to 100) vs center 128 — no; make it unambiguous:
        const r = engine.snapBounds({ x: 149, y: 500, w: 100, h: 50 }, 8);
        // Left edge 149 → 1 away from mid target 150; center 199 → 1 away from 200.
        // Both dist 1; the first found wins — either is a valid snap of magnitude 1.
        expect(Math.abs(r.dx)).toBeCloseTo(1);
    });

    it('does not snap outside the threshold', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        const r = engine.snapBounds({ x: 300, y: 300, w: 33, h: 33 }, 5);
        expect(r.dx).toBe(0);
        expect(r.dy).toBe(0);
        expect(r.guides).toHaveLength(0);
    });

    it('snaps to artboard edges and center', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({}), []);

        const p = engine.snapPoint(497, 998, 8);
        expect(p.x).toBe(500);
        expect(p.y).toBe(1000);
        expect(p.guides).toHaveLength(2);
    });

    it('skipArtboards keeps pen free of plate-corner magnets', () => {
        const engine = new SnapEngine();
        const scene = makeScene({});
        engine.begin(scene, [], undefined, { skipArtboards: true });
        // Center of 1000×1000 plate — uncapped 8/0.05 would be 160 and still
        // free, but near-corner with huge thr used to snap to plate corners.
        const mid = engine.snapPoint(500, 500, 200);
        expect(mid.x).toBe(500);
        expect(mid.y).toBe(500);
        expect(mid.guides).toHaveLength(0);
    });

    it('caps snapPoint threshold so low zoom cannot cover a whole plate', () => {
        const engine = new SnapEngine();
        engine.begin(makeScene({}), []);
        // 441-class plate half-size ≈220; uncapped thr would corner-snap.
        const p = engine.snapPoint(220, 220, 200);
        expect(p.x).toBe(220);
        expect(p.y).toBe(220);
        expect(p.guides).toHaveLength(0);
    });

    it('excludes the dragged nodes and their root ancestors from targets', () => {
        const engine = new SnapEngine();
        // Node 2 is a child of root 1; dragging 2 must exclude root 1 entirely.
        const scene = makeScene({ 1: [100, 100, 200, 200], 3: [400, 400, 500, 500] }, { 2: 1 });
        engine.begin(scene, [2]);

        const r = engine.snapBounds({ x: 203, y: 103, w: 10, h: 10 }, 8);
        expect(r.dx).toBe(0); // node 1's edges are not targets
        // Node 3 still is: box center 402 snaps to node 3's left edge at 400
        // (dist 2 beats the left-edge candidate 397 → 400 at dist 3)
        const r2 = engine.snapBounds({ x: 397, y: 700, w: 10, h: 10 }, 8);
        expect(r2.dx).toBeCloseTo(-2);
        expect(r2.guides).toContainEqual({ axis: 'x', pos: 400 });
    });

    it('snapAxis returns null when inactive or out of range', () => {
        const engine = new SnapEngine();
        expect(engine.snapAxis('x', 100, 8)).toBeNull();
        engine.begin(makeScene({}), []);
        expect(engine.snapAxis('x', 700, 8)).toBeNull();
        expect(engine.snapAxis('x', 503, 8)?.value).toBe(500);
        engine.end();
        expect(engine.snapAxis('x', 503, 8)).toBeNull();
    });

    it('ignores locked artwork', () => {
        const engine = new SnapEngine();
        engine.begin(makeTree({ 1: [100, 100, 200, 200] }, {}, { locked: [1] }), []);
        expect(engine.snapAxis('x', 202, 8)).toBeNull();

        // ...including a locked group's children.
        const grouped = new SnapEngine();
        grouped.begin(
            makeTree(
                { 1: [100, 100, 200, 200], 2: [100, 100, 200, 200] },
                { 2: 1 },
                { locked: [1] },
            ),
            [],
        );
        expect(grouped.snapAxis('x', 202, 8)).toBeNull();
    });

    it('snaps to a Boolean Group outline, not to its operands', () => {
        const engine = new SnapEngine();
        // Group 1 (intersect): operands span 0..300, and the group's own bounds
        // are the painted intersection 100..200 (what the engine reports for a
        // Boolean Group). The operand edges must not leak in as targets.
        const scene = makeTree(
            { 1: [100, 100, 200, 200], 2: [0, 0, 200, 200], 3: [100, 100, 300, 300] },
            { 2: 1, 3: 1 },
            { boolGroups: [1] },
        );
        engine.begin(scene, []);

        expect(engine.snapAxis('x', 102, 8)?.value).toBe(100); // visible left edge
        expect(engine.snapAxis('x', 198, 8)?.value).toBe(200); // visible right edge
        expect(engine.snapAxis('x', 298, 8)).toBeNull(); // operand edge — invisible
        expect(engine.snapAxis('x', 2, 8)).toBeNull();
    });

    it('clips masked siblings to the mask', () => {
        const engine = new SnapEngine();
        // In group 1, node 2 masks node 3 (painted above it). Node 3 runs to 500,
        // but only the part inside the mask (…200) is on screen.
        const scene = makeTree(
            { 1: [0, 0, 500, 500], 2: [0, 0, 200, 200], 3: [50, 50, 500, 500] },
            { 2: 1, 3: 1 },
            { masks: [2] },
        );
        engine.begin(scene, []);

        expect(engine.snapAxis('x', 198, 8)?.value).toBe(200); // mask edge
        expect(engine.snapAxis('x', 498, 8)).toBeNull(); // masked-away edge
        expect(engine.snapAxis('x', 52, 8)?.value).toBe(50); // still visible
    });

    it('snaps to a text node’s glyphs, not the engine’s estimate of them', () => {
        const engine = new SnapEngine();
        // The engine boxes this text out to 400 (longest line × 0.6em); it
        // actually types to 373. Snapping to 400 puts a guide — and the shape
        // you are dragging — on an edge with nothing drawn at it.
        const scene = makeTree(
            { 1: [100, 0, 400, 50] },
            {},
            { measured: { 1: [100, 0, 373, 50] } },
        );
        engine.begin(scene, []);

        expect(engine.snapAxis('x', 374, 8)?.value).toBe(373); // where the glyphs end
        expect(engine.snapAxis('x', 400, 4)).toBeNull(); // the estimate is not a target
    });

    it('includes the edges of every artboard as snap targets', () => {
        const engine = new SnapEngine();
        // Two artboards: [0..1000] and a second at x=1200 spanning 1200..2000.
        engine.begin(
            makeScene({}, {}, [
                { id: 1, name: 'A', x: 0, y: 0, w: 1000, h: 1000, background: bg },
                { id: 2, name: 'B', x: 1200, y: 0, w: 800, h: 600, background: bg },
            ]),
            [],
        );

        // Snap to the second artboard's left edge (1200) and right edge (2000).
        expect(engine.snapAxis('x', 1203, 8)?.value).toBe(1200);
        expect(engine.snapAxis('x', 1998, 8)?.value).toBe(2000);
        // ...and its vertical center (600/2 = 300).
        expect(engine.snapAxis('y', 302, 8)?.value).toBe(300);
    });

    it('move snap prefers object edges over an always-on 1wu lattice', () => {
        const engine = new SnapEngine();
        engine.gridSize = 1; // Kit host always sets document lattice
        engine.begin(makeScene({ 1: [100, 100, 200, 200] }), []);

        // Left edge at 203 — cell snap would keep 203; object edge is 200.
        const r = engine.snapBounds({ x: 203, y: 500, w: 50, h: 50 }, 8);
        expect(r.dx).toBeCloseTo(-3);
        expect(r.guides).toContainEqual({ axis: 'x', pos: 200 });

        // Resize axis: geometry wins; lattice must not round it away.
        expect(engine.snapAxis('x', 203, 8)?.value).toBe(200);
    });
});
