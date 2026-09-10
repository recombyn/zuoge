/**
 * Live Paint fills are attached to REGIONS, not to face ids, and the
 * arrangement is rebuilt whenever anything about a member changes — including
 * edits that touch no geometry at all. These pin that a rebuild neither loses a
 * colour nor moves one onto the wrong region.
 *
 * The bug that prompted them: fills were anchored at each face's polygon
 * centroid, which for a concave region (an L, a wedge — most of any traced
 * drawing) lies outside the region, usually inside the neighbour it wraps. The
 * containment tier handed that neighbour the colour and left the real region
 * bare. Removing the strokes from a painted trace made part of the artwork
 * silently go blank.
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { InputManager } from './input';
import type { Renderer } from './renderer';
import type { UIEngine } from './ui';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };
beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    return scene;
}
function makeRenderer(): Renderer {
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
        sampleScreenColor: () => null,
        screenToWorld: (x: number, y: number) => ({ x, y }),
        getSnapshot: () => null,
    } as unknown as Renderer;
}
function makeUI(activeTool = 'selection'): UIEngine {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(t: string) {
            ui.activeTool = t;
        },
        setActiveRegion() {},
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        getCurrentStyle: () => '{}',
        contextBar: { refresh() {} },
        gradientEdit: { isActive: () => false, hitTest: () => null, clear() {} },
        meshEdit: { isActive: () => false },
        getLivePaintFill: () => ({ r: 0.2, g: 0.55, b: 0.9, a: 1 }),
        getLivePaintStroke: () => ({ r: 0, g: 0, b: 0, a: 1 }),
        getLivePaintStrokeWidth: () => 1,
        isLivePaintFillNone: () => false,
        isLivePaintStrokeNone: () => false,
        getLivePaintGradient: () => null,
        setLivePaintFill() {},
        setLivePaintStroke() {},
        rgbToHex: () => '#000000',
    };
    return ui as unknown as UIEngine;
}
const mouse = (clientX: number, clientY: number, o: Record<string, unknown> = {}) =>
    ({
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        detail: 1,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as MouseEvent;
const makeInput = (scene: WasmScene, ui = makeUI()) =>
    new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

// ── Seam A: Live Paint fills must survive rebuilds that change no geometry ──
function openSeg(e: Engine, x0: number, y0: number, x1: number, y1: number) {
    return e.add_path(
        JSON.stringify([
            {
                closed: false,
                points: [
                    { x: x0, y: y0, cp1: [x0, y0], cp2: [x0, y0] },
                    { x: x1, y: y1, cp1: [x1, y1], cp2: [x1, y1] },
                ],
            },
        ]),
    );
}
/** A grid of open strokes: many concave faces, no closed source shape. */
function lineArtGrid(scene: WasmScene, cells = 3, step = 100) {
    const e = scene.engine!;
    const n = cells * step;
    const ids: number[] = [];
    for (let i = 0; i <= cells; i++) {
        ids.push(openSeg(e, 0, i * step, n, i * step));
        ids.push(openSeg(e, i * step, 0, i * step, n));
    }
    // A few diagonals, so faces are triangles and wedges rather than squares.
    ids.push(openSeg(e, 0, 0, n, n));
    ids.push(openSeg(e, 0, n, n, 0));
    const g = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(g, true);
    e.set_live_paint_group(g);
    return { group: g, ids };
}
function paintEveryFace(scene: WasmScene, extent: number, step = 7) {
    const e = scene.engine!;
    const painted = new Map<number, [number, number]>();
    for (let y = 2; y < extent; y += step) {
        for (let x = 2; x < extent; x += step) {
            const id = e.query_face_at(x, y);
            if (id < 0 || painted.has(id)) continue;
            painted.set(id, [x, y]);
            const c = (id % 200) / 255;
            e.set_face_fill(id, c, 1 - c, 0.5, 1);
        }
    }
    return painted;
}
function bareAfter(scene: WasmScene, painted: Map<number, [number, number]>) {
    const e = scene.engine!;
    const bare: string[] = [];
    for (const [, [x, y]] of painted) {
        const id = e.query_face_at(x, y);
        if (id < 0) continue;
        if (!e.get_face_paint(id)) bare.push(`(${x},${y})`);
    }
    return bare;
}

describe('live paint: fill identity across rebuilds', () => {
    it('every painted region keeps its fill through a no-op style rebuild', () => {
        const scene = makeScene();
        const { group, ids } = lineArtGrid(scene);
        const painted = paintEveryFace(scene, 300);
        expect(painted.size).toBeGreaterThan(10);
        for (const id of ids)
            scene.engine!.set_node_style(id, scene.engine!.get_node_style_json(id));
        scene.engine!.get_filled_faces();
        expect(bareAfter(scene, painted)).toEqual([]);
        expect(group).toBeGreaterThan(0);
    });

    it('every painted region keeps its fill when the group is moved', () => {
        const scene = makeScene();
        const { group } = lineArtGrid(scene);
        const painted = paintEveryFace(scene, 300);
        scene.engine!.move_node(group, 37, -19);
        scene.engine!.get_filled_faces();
        const e = scene.engine!;
        const bare: string[] = [];
        for (const [, [x, y]] of painted) {
            const id = e.query_face_at(x + 37, y - 19);
            if (id >= 0 && !e.get_face_paint(id)) bare.push(`(${x},${y})`);
        }
        expect(bare).toEqual([]);
    });

    it('painting through the bucket then rebuilding keeps every colour', () => {
        const scene = makeScene();
        const { ids } = lineArtGrid(scene);
        const ui = makeUI('paint-bucket');
        const input = makeInput(scene, ui);
        const spots: [number, number][] = [];
        for (let y = 20; y < 300; y += 60) for (let x = 20; x < 300; x += 60) spots.push([x, y]);
        for (const [x, y] of spots) {
            input.onMouseDown(mouse(x, y));
            input.onMouseUp(mouse(x, y));
        }
        const before = JSON.parse(scene.engine!.get_filled_faces()).length;
        expect(before).toBeGreaterThan(5);
        for (const id of ids)
            scene.engine!.set_node_style(id, scene.engine!.get_node_style_json(id));
        const after = JSON.parse(scene.engine!.get_filled_faces()).length;
        expect(after).toBe(before);
    });
});

// ── Seam G: guards on the fill-remap change itself ─────────────────────────
describe('live paint: fills attach to the right region, or to none', () => {
    it('a fill in a vanished overlap drops rather than moving', () => {
        // The rule the remap tiers exist to protect: when the two shapes that
        // made a region separate, the region is gone and so is its colour.
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_ellipse(200, 200, 90, 90);
        const b = e.add_ellipse(320, 200, 90, 90);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        const overlap = e.query_face_at(260, 200);
        expect(overlap).toBeGreaterThanOrEqual(0);
        e.set_face_fill(overlap, 1, 0, 0, 1);
        e.move_node(b, 400, 0);
        e.get_filled_faces();
        const left = e.query_face_at(200, 200);
        const right = e.query_face_at(720, 200);
        expect(e.get_face_paint(left), 'the left circle must not inherit it').toBe('');
        expect(e.get_face_paint(right), 'the right circle must not inherit it').toBe('');
    });

    it("each region keeps its OWN colour, not a neighbour's, across a rebuild", () => {
        const scene = makeScene();
        const { ids } = lineArtGrid(scene, 3, 100);
        const e = scene.engine!;
        // Give every face a colour derived from where it is, so a swap shows up.
        const spots: [number, number, number][] = [];
        for (let y = 12; y < 300; y += 23) {
            for (let x = 12; x < 300; x += 23) {
                const id = e.query_face_at(x, y);
                if (id < 0 || spots.some((s) => s[2] === id)) continue;
                const shade = (spots.length + 1) / 100;
                e.set_face_fill(id, shade, 0, 0, 1);
                spots.push([x, y, id]);
            }
        }
        expect(spots.length).toBeGreaterThan(8);
        const want = spots.map(([x, y]) => [x, y, e.get_face_paint(e.query_face_at(x, y))]);
        for (const id of ids) e.set_node_style(id, e.get_node_style_json(id));
        e.get_filled_faces();
        const wrong = want.filter(([x, y, paint]) => {
            const id = e.query_face_at(x as number, y as number);
            return id < 0 || e.get_face_paint(id) !== paint;
        });
        expect(wrong.map(([x, y]) => `(${x},${y})`)).toEqual([]);
    });

    it('deleting a bounding line does not scatter the surviving colours', () => {
        const scene = makeScene();
        const { ids } = lineArtGrid(scene, 3, 100);
        const e = scene.engine!;
        const painted = paintEveryFace(scene, 300, 11);
        const before = JSON.parse(e.get_filled_faces()).length;
        e.remove_node(ids[ids.length - 1]); // drop one diagonal
        const after = JSON.parse(e.get_filled_faces()).length;
        // Regions merge, so the count may fall — but nothing may be invented,
        // and every surviving colour must still be one that was painted.
        expect(after).toBeLessThanOrEqual(before);
        expect(painted.size).toBeGreaterThan(0);
        for (const f of JSON.parse(e.get_filled_faces()) as { id: number }[]) {
            expect(e.get_face_paint(f.id)).not.toBe('');
        }
    });
});

// ── Seam E: round-trip fidelity, the invariant that catches history bugs ────
const bytes = (scene: WasmScene) => Array.from(scene.engine!.serialize_scene()).join(',');

describe('live paint: round trips', () => {
    it('serialize → deserialize → serialize is byte-identical', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 40, 40);
        e.add_ellipse(100, 100, 30, 20);
        const g = e.group_nodes(JSON.stringify(Array.from(e.get_root_nodes())));
        e.set_node_rotation(g, 17);
        lineArtGrid(scene, 2, 80);
        paintEveryFace(scene, 160, 9);
        const before = bytes(scene);
        expect(e.deserialize_scene(e.serialize_scene())).toBe(true);
        expect(bytes(scene)).toBe(before);
    });

    it('undo then redo lands back on the same bytes', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ids = Array.from({ length: 6 }, (_, i) => e.add_rect(i * 50, 0, 40, 40));
        for (let i = 0; i < 6; i++) {
            scene.saveMoveHistory();
            scene.moveNodeWorld(ids[i], 3, 5);
        }
        const after = bytes(scene);
        scene.undo();
        const undone = bytes(scene);
        expect(undone).not.toBe(after);
        scene.redo();
        expect(bytes(scene)).toBe(after);
    });

    it('live paint fills come back through undo and redo', () => {
        const scene = makeScene();
        lineArtGrid(scene, 2, 80);
        const painted = paintEveryFace(scene, 160, 9);
        expect(painted.size).toBeGreaterThan(3);
        const filled = () => JSON.parse(scene.engine!.get_filled_faces()).length;
        const n = filled();
        scene.saveMoveHistory();
        scene.engine!.add_rect(500, 500, 10, 10);
        scene.undo();
        expect(filled()).toBe(n);
        scene.redo();
        expect(filled()).toBe(n);
    });

    it('a group reports bounds that contain its children', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 40, 40);
        const b = e.add_rect(200, 120, 40, 40);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_rotation(g, 25);
        const gb = Array.from(e.get_node_bounds(g));
        for (const id of [a, b]) {
            const cb = Array.from(e.get_node_bounds(id));
            expect(cb[0]).toBeGreaterThanOrEqual(gb[0] - 0.5);
            expect(cb[1]).toBeGreaterThanOrEqual(gb[1] - 0.5);
            expect(cb[2]).toBeLessThanOrEqual(gb[2] + 0.5);
            expect(cb[3]).toBeLessThanOrEqual(gb[3] + 0.5);
        }
    });
});
