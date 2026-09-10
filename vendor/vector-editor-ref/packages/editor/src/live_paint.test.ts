/**
 * Live Paint integration tests, driven against the REAL wasm Engine through
 * WasmScene (loaded headless, same pattern as gesture_history.test.ts).
 *
 * Two layers are covered:
 *   A. The WasmScene Live Paint surface (face fills, group scoping, the
 *      live_paint special-object flag, edge painting) + save/load round-trips.
 *   B. getEditorContext classification — the logic behind the two UI bugs that
 *      were reported: the bar must switch to Live Paint when the tool is armed
 *      (even with a selection), and a Live Paint group must read as its own
 *      object, not a plain group.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { getEditorContext } from './context';
import { InputManager } from './input';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    return scene;
}

/** Minimal fakes for the non-scene collaborators getEditorContext reads. */
function fakeUI(activeTool: string): UIEngine {
    return { activeTool } as unknown as UIEngine;
}
function fakeInput(): InputManager {
    return {
        editingNodeId: null,
        currentPathPoints: [],
        editingPoints: null,
        selectedPoints: new Set<string>(),
    } as unknown as InputManager;
}

/** Wrap `ids` in a Live Paint–flagged group and make it active. Shapes only
 * form a paint surface inside a flagged group, so tests call this before
 * painting/querying. */
function makeLP(e: Engine, ids: number[]): number {
    const g = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(g, true);
    e.set_live_paint_group(g);
    return g;
}

// ─── A. WasmScene Live Paint surface ───────────────────────────────────────

describe('Live Paint — engine surface via WasmScene', () => {
    it('two overlapping rects make three distinct fillable regions', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const aOnly = e.query_face_at(25, 25);
        const overlap = e.query_face_at(75, 75);
        const bOnly = e.query_face_at(125, 125);
        expect(aOnly).toBeGreaterThanOrEqual(0);
        expect(overlap).toBeGreaterThanOrEqual(0);
        expect(bOnly).toBeGreaterThanOrEqual(0);
        expect(new Set([aOnly, overlap, bOnly]).size).toBe(3);
    });

    it('setFaceFill stores a region fill that get_filled_faces returns', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const overlap = e.query_face_at(75, 75);
        scene.setFaceFill(overlap, 0, 1, 0, 1);
        expect(e.get_filled_faces()).toContain('"g":1.0');
    });

    it('a region fill follows its shape across a large move (containment signature)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const aOnly = e.query_face_at(25, 25);
        scene.setFaceFill(aOnly, 1, 0, 0, 1);
        e.move_node(a, 400, 400); // separate the rects entirely
        expect(e.get_filled_faces()).toContain('"r":1.0');
    });

    it('the live_paint flag scopes painting; a second group is independent', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        const outside = e.add_rect(500, 500, 100, 100); // outside the group
        const group = makeLP(e, [a, b]);
        expect(scene.getLivePaintGroup()).toBe(group);
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // in group
        expect(e.query_face_at(550, 550)).toBe(-1); // outside → not paintable

        // A second flagged group is its OWN network — both coexist.
        makeLP(e, [outside]);
        expect(e.query_face_at(550, 550)).toBeGreaterThanOrEqual(0); // now paintable
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // first group still works
    });

    it('a face carries an exact-bézier outline (true curves, not a polygon)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const c = e.add_ellipse(200, 200, 100, 100); // circle r=100
        makeLP(e, [c]);
        const f = e.query_face_at(200, 200);
        scene.setFaceFill(f, 1, 0, 0, 1);
        const faces = JSON.parse(e.get_filled_faces());
        const outline = faces[0].outline as Array<{
            x: number;
            y: number;
            cp1: number[];
            cp2: number[];
        }>;
        expect(Array.isArray(outline)).toBe(true);
        expect(outline.length).toBeGreaterThanOrEqual(3);
        // Real handles ⇒ curved (a polygon would have handles coincident with anchors).
        const curved = outline.some((p) => Math.hypot(p.cp1[0] - p.x, p.cp1[1] - p.y) > 1);
        expect(curved).toBe(true);
    });

    it('the live_paint flag is groups-only and survives save/load', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        const g = e.group_nodes(JSON.stringify([r]));

        scene.setNodeLivePaint(r, true);
        expect(scene.getNodeLivePaint(r)).toBe(false); // non-group ignores the flag
        scene.setNodeLivePaint(g, true);
        expect(scene.getNodeLivePaint(g)).toBe(true);
        scene.setLivePaintGroup(g);

        // Round-trip through the snapshot format undo/save use.
        const snap = e.serialize_scene();
        const e2 = new Engine();
        expect(e2.deserialize_scene(snap)).toBe(true);
        expect(e2.get_node_live_paint(g)).toBe(true);
        expect(e2.get_live_paint_group()).toBe(g);
    });

    it('a painted edge round-trips through save/load', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 200, 200);
        makeLP(e, [r]);
        const edge = scene.queryEdgeAt(100, 0, 8); // on the top edge
        expect(edge).toBeGreaterThanOrEqual(0);
        scene.setEdgePaint(edge, 1, 0, 0, 1, 4);
        expect(e.get_painted_edges()).toContain('"r":1.0');

        const snap = e.serialize_scene();
        const e2 = new Engine();
        expect(e2.deserialize_scene(snap)).toBe(true);
        expect(e2.get_painted_edges()).toContain('"r":1.0');
    });
});

// ─── C. Un-painting, and the per-group gap tolerance ───────────────────────

describe('Live Paint — clearing paint', () => {
    it('clearFaceFill removes a region fill and is undoable', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const overlap = e.query_face_at(75, 75);
        scene.setFaceFill(overlap, 0, 1, 0, 1);
        expect(e.get_filled_faces()).toContain('"g":1.0');

        scene.clearFaceFill(overlap);
        expect(e.get_filled_faces()).not.toContain('"g":1.0');

        // Un-painting is a mutation like any other — one undo brings it back.
        scene.undo();
        expect(e.get_filled_faces()).toContain('"g":1.0');
    });

    it('a cleared region stays cleared across a rebuild', () => {
        // The fill is re-attached by signature on every rebuild, so a clear that
        // only blanked the live face would be undone by the next graph pass.
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        makeLP(e, [a, b]);
        const overlap = e.query_face_at(75, 75);
        scene.setFaceFill(overlap, 0, 1, 0, 1);
        scene.clearFaceFill(e.query_face_at(75, 75));

        e.move_node(a, 5, 5); // forces a rebuild + fill re-map
        expect(e.get_filled_faces()).not.toContain('"g":1.0');
    });

    it('clearEdgePaint removes an edge stroke, and it does not come back', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 200, 200);
        makeLP(e, [r]);
        const edge = scene.queryEdgeAt(100, 0, 8);
        scene.setEdgePaint(edge, 1, 0, 0, 1, 4);
        expect(e.get_painted_edges()).toContain('"r":1.0');

        scene.clearEdgePaint(scene.queryEdgeAt(100, 0, 8));
        expect(e.get_painted_edges()).not.toContain('"r":1.0');
        // Painted edges are re-resolved from the persisted list each rebuild;
        // a clear that missed the stored entry would resurrect the stroke.
        e.move_node(r, 30, 30);
        expect(e.get_painted_edges()).not.toContain('"r":1.0');
    });
});

describe('Live Paint — gap tolerance', () => {
    /** An open square from (100,100) to (300,300) with a `gap`-wide opening in
     *  its left side — not a closed region until gap closing bridges it. */
    function openSquare(e: Engine, gap: number): number {
        return e.add_path(
            JSON.stringify([
                {
                    closed: false,
                    points: [
                        { x: 100, y: 100, cp1: [100, 100], cp2: [100, 100] },
                        { x: 300, y: 100, cp1: [300, 100], cp2: [300, 100] },
                        { x: 300, y: 300, cp1: [300, 300], cp2: [300, 300] },
                        { x: 100, y: 300, cp1: [100, 300], cp2: [100, 300] },
                        {
                            x: 100,
                            y: 100 + gap,
                            cp1: [100, 100 + gap],
                            cp2: [100, 100 + gap],
                        },
                    ],
                },
            ]),
        );
    }

    it('the tolerance is a property of the group, not the document', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const wide = makeLP(e, [openSquare(e, 40)]);
        const narrowPath = openSquare(e, 40);
        e.move_node(narrowPath, 500, 0);
        const narrow = makeLP(e, [narrowPath]);

        // Neither closes at the document default of 0.
        expect(e.query_face_at(200, 200)).toBe(-1);
        expect(e.query_face_at(700, 200)).toBe(-1);

        scene.setNodeGapBridgeDistance(wide, 60);
        expect(e.query_face_at(200, 200)).toBeGreaterThanOrEqual(0);
        expect(e.query_face_at(700, 200)).toBe(-1);
        expect(scene.getNodeGapBridgeDistance(narrow)).toBe(-1); // still inheriting
    });

    it('a group with no setting of its own follows the document default', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const g = makeLP(e, [openSquare(e, 10)]);
        expect(scene.getNodeGapBridgeDistance(g)).toBe(-1);
        expect(scene.getEffectiveGapBridgeDistance(g)).toBe(0);

        scene.setGapBridgeDistance(20);
        expect(scene.getEffectiveGapBridgeDistance(g)).toBe(20);
        expect(e.query_face_at(200, 200)).toBeGreaterThanOrEqual(0);

        // Its own setting wins over the default, in both directions.
        scene.setNodeGapBridgeDistance(g, 0);
        expect(e.query_face_at(200, 200)).toBe(-1);
    });

    it('the per-group tolerance survives save/load', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const g = makeLP(e, [openSquare(e, 40)]);
        scene.setNodeGapBridgeDistance(g, 60);

        const bytes = e.serialize_proto();
        const e2 = new Engine();
        expect(e2.deserialize_proto(bytes)).toBe(true);
        expect(e2.get_node_gap_bridge_distance(g)).toBe(60);
        expect(e2.query_face_at(200, 200)).toBeGreaterThanOrEqual(0);
    });
});

// ─── A2. Face boundaries must land on the real intersections ────────────────

/** A closed quad from four corners, straight segments (cp == anchor). */
function addQuad(e: Engine, pts: [number, number][]): number {
    return e.add_path(
        JSON.stringify([
            { closed: true, points: pts.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y] })) },
        ]),
    );
}

function cornersOf(scene: WasmScene, faceId: number): [number, number][] {
    return (scene.getFaceOutline(faceId) ?? []).map((p) => [p.x, p.y]);
}

/** Boundary walks start anywhere, so compare as a set rather than a sequence. */
function hasCorner(corners: [number, number][], x: number, y: number, tol = 0.5): boolean {
    return corners.some(([cx, cy]) => Math.abs(cx - x) <= tol && Math.abs(cy - y) <= tol);
}

describe('Live Paint — a face boundary sits on the true intersections', () => {
    it('axis-aligned: a square split by a rectangle is exact', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = addQuad(e, [
            [0, 0],
            [200, 0],
            [200, 200],
            [0, 200],
        ]);
        const b = addQuad(e, [
            [0, 0],
            [200, 0],
            [200, 100],
            [0, 100],
        ]);
        makeLP(e, [a, b]);
        const corners = cornersOf(scene, e.query_face_at(100, 50));
        expect(corners.length).toBe(4);
        for (const [x, y] of [
            [0, 0],
            [200, 0],
            [200, 100],
            [0, 100],
        ]) {
            expect(hasCorner(corners, x, y)).toBe(true);
        }
    });

    /** P(u,v) on an isometric face: u along (s,-200), v along (s,200). */
    const S = 200 * Math.sqrt(3);
    const iso =
        (ox = 0, oy = 0) =>
        (u: number, v: number): [number, number] => [ox + u * S + v * S, oy - 200 * u + 200 * v];

    it('isometric: the same split, rotated, is exact', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const at = iso();
        const a = addQuad(e, [at(0, 0), at(1, 0), at(1, 1), at(0, 1)]);
        const b = addQuad(e, [at(0, 0), at(1, 0), at(1, 0.5), at(0, 0.5)]);
        makeLP(e, [a, b]);
        const probe = at(0.5, 0.25);
        const corners = cornersOf(scene, e.query_face_at(probe[0], probe[1]));
        expect(corners.length).toBe(4);
        for (const [x, y] of [at(0, 0), at(1, 0), at(1, 0.5), at(0, 0.5)]) {
            expect(hasCorner(corners, x, y)).toBe(true);
        }
    });

    /**
     * The arrangement a faceted isometric drawing actually produces: a face
     * tiled by several bands, then one more quad laid across all of them to cut
     * a row. Every shape is closed with straight edges, and any *pair* of them
     * resolved exactly long before this case did.
     *
     * Together they used to come out inflated — each interior edge landing 11 to
     * 16 units outside the crossing that defined it, so neighbouring regions
     * overlapped across their shared edges and a painted isometric cube rendered
     * as wandering bands with white gaps between them. The cause was the T-shaped
     * junction: an edge ending *on* another was split at the loose end rather
     * than at the point on the line it met, which dragged the crossed edge with
     * it. Splitting at the projection is what makes this exact.
     */
    it('isometric: a face tiled by bands, then cut by a row quad', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const at = iso();
        const edges = [0, 0.2, 0.38, 0.56, 0.76, 1];
        const ids: number[] = [];
        for (let i = 0; i < edges.length - 1; i++) {
            ids.push(
                addQuad(e, [
                    at(edges[i], 0),
                    at(edges[i + 1], 0),
                    at(edges[i + 1], 1),
                    at(edges[i], 1),
                ]),
            );
        }
        ids.push(addQuad(e, [at(0, 0), at(1, 0), at(1, 0.58), at(0, 0.58)]));
        makeLP(e, ids);

        const probe = at(0.47, 0.29);
        const corners = cornersOf(scene, e.query_face_at(probe[0], probe[1]));
        const want: [number, number][] = [at(0.38, 0), at(0.56, 0), at(0.56, 0.58), at(0.38, 0.58)];
        expect(corners.length).toBe(4);
        for (const [x, y] of want) expect(hasCorner(corners, x, y)).toBe(true);
    });
});

// ─── B. getEditorContext classification (the reported UI bugs) ──────────────

describe('Live Paint — editor context classification', () => {
    it('the paint-bucket tool wins over a selection (bar switches to Live Paint)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r1 = e.add_rect(0, 0, 100, 100);
        const r2 = e.add_rect(120, 0, 100, 100);
        e.select_node(r1, false);
        e.select_node(r2, true); // 2 shapes selected

        // Selection tool → the selection wins.
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'multi-select',
        );
        // Paint-bucket tool → Live Paint wins even with the selection.
        expect(getEditorContext(fakeUI('paint-bucket'), fakeInput(), scene).context).toBe(
            'live-paint',
        );
    });

    it('a selected Live Paint group reads as its own object, not a plain group', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r1 = e.add_rect(0, 0, 100, 100);
        const r2 = e.add_rect(50, 50, 100, 100);
        const group = e.group_nodes(JSON.stringify([r1, r2]));

        e.clear_selection();
        e.select_node(group, false);
        // Plain group first.
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'group-selected',
        );
        // Flag it → it becomes a Live Paint object.
        scene.setNodeLivePaint(group, true);
        expect(getEditorContext(fakeUI('selection'), fakeInput(), scene).context).toBe(
            'live-paint-object',
        );
    });
});

// ─── C. Adding shapes to a group that already exists ────────────────────────

/** UIEngine stub with the surface the Live Paint entry points touch. */
function stubUI(): UIEngine {
    const ui = {
        activeTool: 'selection',
        setActiveTool(t: string) {
            ui.activeTool = t;
        },
        setActiveRegion() {},
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        collapseSubtreeByDefault() {},
        getCurrentStyle: () => '{}',
        contextBar: { refresh() {} },
        gradientEdit: { isActive: () => false, hitTest: () => null, clear() {} },
    };
    return ui as unknown as UIEngine;
}

function stubRenderer(): Renderer {
    return {
        zoom: 1,
        pan: { x: 0, y: 0 },
        dpr: 1,
        requestRender() {},
        notifyViewChange() {},
        onViewChange() {},
        clearImageCache() {},
        beginDragLayerCache: () => false,
        setDragMovingRoots() {},
        endDragLayerCache() {},
        invalidateGroupSpriteFor() {},
        invalidateAllGroupSprites() {},
        calculatePathBounds: () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }),
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}

function makeInput(scene: WasmScene, ui: UIEngine): InputManager {
    return new InputManager(document.createElement('canvas'), scene, ui, stubRenderer());
}

describe('Live Paint — a shape added to an existing group joins its network', () => {
    /** Two rects that overlap, wrapped in a Live Paint group, plus a third rect
     *  straddling the second one's right edge — the shape about to be added. */
    function setup() {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 0, 100, 100);
        const group = makeLP(e, [a, b]);
        const outsider = e.add_rect(120, 0, 100, 100);
        return { scene, e, group, outsider };
    }

    it('dragged in through the Objects panel, it divides regions with the rest', () => {
        const { e, scene, group, outsider } = setup();
        expect(e.query_face_at(180, 50)).toBe(-1); // outside → nothing to paint

        scene.reorderNodes([outsider], group, scene.getNodeChildren(group).length);

        // Its own area is paintable, and it cuts the group's rect in two where
        // they overlap rather than sitting on top as one undivided shape.
        expect(e.query_face_at(180, 50)).toBeGreaterThanOrEqual(0);
        expect(e.query_face_at(130, 50)).not.toBe(e.query_face_at(180, 50));
    });

    it('dragged back out, it stops cutting the group it left', () => {
        const { e, scene, group } = setup();
        const b = Array.from(scene.getNodeChildren(group))[1];
        expect(e.query_face_at(25, 50)).not.toBe(e.query_face_at(75, 50)); // b splits a

        scene.reorderNodes([b], null, 0);

        // The network is rebuilt without b: `a` is one region again, and b's own
        // area is no longer paintable. A stale network left the seam behind.
        expect(e.query_face_at(25, 50)).toBe(e.query_face_at(75, 50));
        expect(e.query_face_at(130, 50)).toBe(-1);
    });

    it('arming the bucket on a member enters its group instead of nesting a new one', () => {
        const { e, scene, group, outsider } = setup();
        scene.reorderNodes([outsider], group, scene.getNodeChildren(group).length);
        e.clear_selection();
        e.select_node(outsider, false); // still selected after the drag

        const ui = stubUI();
        makeInput(scene, ui).enterPaintBucketMode();

        // No second Live Paint group: the inner flag would win, and the shape
        // would form its own one-member network — the reported bug.
        expect(scene.getNodeParent(outsider)).toBe(group);
        expect(scene.getNodeLivePaint(outsider)).toBe(false);
        expect(scene.getLivePaintGroup()).toBe(group);
        expect(ui.activeTool).toBe('paint-bucket');
        expect(e.query_face_at(180, 50)).toBeGreaterThanOrEqual(0);
    });

    it('the group plus a stray shape merges the stray in, rather than wrapping both', () => {
        const { e, scene, group, outsider } = setup();
        e.clear_selection();
        e.select_node(group, true);
        e.select_node(outsider, true);

        makeInput(scene, stubUI()).makeLivePaintGroup();

        expect(scene.getNodeParent(outsider)).toBe(group);
        expect(scene.getNodeParent(group)).toBe(-1); // not wrapped in a new group
        expect(scene.getLivePaintGroup()).toBe(group);
        expect(e.query_face_at(180, 50)).toBeGreaterThanOrEqual(0);
    });

    it('a merged shape keeps its position on the canvas', () => {
        const { e, scene, group, outsider } = setup();
        const before = scene.getNodeBounds(outsider);
        e.clear_selection();
        e.select_node(outsider, true);
        e.select_node(group, true);

        makeInput(scene, stubUI()).makeLivePaintGroup();

        expect(Array.from(scene.getNodeBounds(outsider))).toEqual(Array.from(before));
    });

    it('shapes with no Live Paint group anywhere still make a new one', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 0, 100, 100);
        e.select_node(a, true);
        e.select_node(b, true);

        makeInput(scene, stubUI()).makeLivePaintGroup();

        const group = scene.getNodeParent(a);
        expect(group).toBeGreaterThan(0);
        expect(scene.getNodeLivePaint(group)).toBe(true);
        expect(e.query_face_at(75, 50)).toBeGreaterThanOrEqual(0);
    });
});
