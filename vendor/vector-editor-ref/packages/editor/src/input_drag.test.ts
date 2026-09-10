/**
 * Characterization tests for InputManager pointer-drag gestures, driven against
 * the REAL wasm Engine through WasmScene (headless, same pattern as
 * live_paint.test.ts / gesture_history.test.ts).
 *
 * These pin down the observable behaviour of the mousedown → mousemove →
 * mouseup pipeline (move, axis-constrained move, alt clone-drag, marquee
 * select) so the ongoing decomposition of the ~800-line onMouseMove /
 * onMouseMoveDrag can be refactored without silently changing behaviour.
 *
 * The DOM/GL collaborators (Renderer, UIEngine) are minimal fakes: with
 * zoom=1 / pan=0 and jsdom's zero-origin getBoundingClientRect, client
 * coordinates map 1:1 to world coordinates, which keeps the assertions simple.
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
    scene.wasm = wasmModule; // enables zero-copy transform reads (getTransform, etc.)
    return scene;
}

/** Renderer stub: identity view transform + no-op frame/notify hooks. */
function makeRenderer(zoom = 1): Renderer {
    return {
        zoom,
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
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}

/** UIEngine stub: just the members the selection/drag path reads or calls. */
function makeUI(activeTool = 'selection'): UIEngine {
    return {
        activeTool,
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        gradientEdit: { isActive: () => false, hitTest: () => null },
    } as unknown as UIEngine;
}

interface MouseOpts {
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    button?: number;
}
function mouse(clientX: number, clientY: number, opts: MouseOpts = {}): MouseEvent {
    return {
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
        ...opts,
    } as unknown as MouseEvent;
}

function makeInput(scene: WasmScene, ui: UIEngine = makeUI(), renderer: Renderer = makeRenderer()) {
    const canvas = document.createElement('canvas');
    const input = new InputManager(canvas, scene, ui, renderer);
    return { input, ui, renderer, canvas };
}

/** Axis-aligned bounds [minX, minY, maxX, maxY] of a node. */
function bounds(scene: WasmScene, id: number): number[] {
    return Array.from(scene.getNodeBounds(id));
}

/** Perform a full press → drag → release from (x0,y0) to (x1,y1). */
function drag(
    input: InputManager,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    opts: MouseOpts = {},
) {
    input.onMouseDown(mouse(x0, y0, opts));
    input.onMouseMove(mouse(x1, y1, opts));
    input.onMouseUp(mouse(x1, y1, opts));
}

describe('InputManager — selection move drag', () => {
    it('dragging a selected rect translates it by the world-space delta', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        drag(input, 50, 50, 80, 70); // +30, +20

        const b = bounds(scene, r);
        expect(b[0]).toBeCloseTo(30, 3);
        expect(b[1]).toBeCloseTo(20, 3);
        expect(b[2]).toBeCloseTo(130, 3);
        expect(b[3]).toBeCloseTo(120, 3);
    });

    it('shift constrains the move to the dominant axis', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        // Larger horizontal component → y should be locked to 0.
        drag(input, 50, 50, 120, 60, { shiftKey: true });

        const b = bounds(scene, r);
        expect(b[0]).toBeCloseTo(70, 3);
        expect(b[1]).toBeCloseTo(0, 3);
    });

    it('alt clone-drag leaves the original in place and adds a moved copy', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        drag(input, 50, 50, 90, 50, { altKey: true }); // +40 x

        // Original untouched at (0..100); the clone sits at +40 and is selected.
        const original = bounds(scene, r);
        expect(original[0]).toBeCloseTo(0, 3);
        const sel = Array.from(e.get_selection());
        expect(sel.length).toBe(1);
        expect(sel[0]).not.toBe(r); // the clone is now selected
        // Clone position = the drag delta, and nothing else. It used to be the
        // delta PLUS duplicate_node's built-in +20 paste offset, which put the
        // copy 20 units past the cursor — pinned here as a quirk until the state
        // sweep showed what it costs under Shift: the axis constraint locks one
        // axis, and the copy then sat 20 units off it, visibly ignoring the
        // modifier the user was holding.
        const clone = bounds(scene, sel[0]);
        expect(clone[0]).toBeCloseTo(40, 3);
    });

    it('a sub-threshold press-release does not move or snapshot history', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        drag(input, 50, 50, 50, 50); // no movement

        const b = bounds(scene, r);
        expect(b[0]).toBeCloseTo(0, 3);
        expect(b[1]).toBeCloseTo(0, 3);
    });

    it('a press that moves several world units but stays under the screen threshold does not move (zoom-independent)', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        // Zoomed way out: 1 screen px == 10 world units. Client (5,5)→(5.2,5) is
        // a 2-world-unit drag but only 0.2 screen px — a click, not a move. The
        // old per-frame 0.5-world threshold would have treated this as a drag.
        const { input } = makeInput(scene, makeUI(), makeRenderer(0.1));

        drag(input, 5, 5, 5.2, 5);

        const b = bounds(scene, r);
        expect(b[0]).toBeCloseTo(0, 3);
        expect(b[1]).toBeCloseTo(0, 3);
    });
});

describe('InputManager — resize handles', () => {
    it('dragging the SE corner handle grows the rect', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        // SE handle sits at the rect's bottom-right corner (100,100).
        drag(input, 100, 100, 150, 150);

        const b = bounds(scene, r);
        expect(b[0]).toBeCloseTo(0, 3);
        expect(b[1]).toBeCloseTo(0, 3);
        expect(b[2]).toBeCloseTo(150, 3);
        expect(b[3]).toBeCloseTo(150, 3);
    });

    it('dragging the E edge handle grows width only', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        // E edge midpoint handle sits at (100, 50).
        drag(input, 100, 50, 140, 50);

        const b = bounds(scene, r);
        expect(b[2]).toBeCloseTo(140, 3); // width extended
        expect(b[3]).toBeCloseTo(100, 3); // height unchanged
    });
});

describe('InputManager — rotate handle', () => {
    it('dragging the rotate zone outside a corner rotates the node about its center', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        e.select_node(r, false);
        const { input } = makeInput(scene);

        // Rotate zone is just outside the SE corner (100,100); pivot = center (50,50).
        // Start at 45° from the pivot, drag to 90° → a 45° rotation.
        drag(input, 110, 110, 50, 130);

        const rot = scene.getNodeTransformComponents(r).rotation_deg;
        expect(Math.abs(rot)).toBeCloseTo(45, 1);
    });
});

describe('InputManager — marquee selection', () => {
    it('a marquee that encloses a shape selects it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(20, 20, 60, 60); // occupies (20,20)-(80,80)
        const { input } = makeInput(scene);
        e.clear_selection();

        // Drag an empty-space marquee fully around the rect.
        drag(input, 5, 5, 200, 200);

        const sel = Array.from(e.get_selection());
        expect(sel).toContain(r);
    });

    it('a marquee that misses a shape leaves it unselected', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(300, 300, 60, 60);
        const { input } = makeInput(scene);
        e.clear_selection();

        drag(input, 5, 5, 100, 100); // nowhere near the rect

        const sel = Array.from(e.get_selection());
        expect(sel).not.toContain(r);
    });
});

describe('shift-click selection', () => {
    /** A click that does not move: down and up at the same point. */
    function click(input: InputManager, x: number, y: number, opts: MouseOpts = {}) {
        input.onMouseDown(mouse(x, y, opts));
        input.onMouseUp(mouse(x, y, opts));
    }

    it('shift-clicking a selected shape takes it out of the selection', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 50, 50);
        const b = e.add_rect(100, 0, 50, 50);
        const { input } = makeInput(scene);

        click(input, 25, 25);
        click(input, 125, 25, { shiftKey: true });
        expect(Array.from(e.get_selection()).sort()).toEqual([a, b].sort());

        // The reported bug: this did nothing at all.
        click(input, 125, 25, { shiftKey: true });
        expect(Array.from(e.get_selection())).toEqual([a]);
    });

    it('shift-dragging a selected shape still moves the whole selection', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 50, 50);
        const b = e.add_rect(100, 0, 50, 50);
        const { input } = makeInput(scene);

        click(input, 25, 25);
        click(input, 125, 25, { shiftKey: true });

        // Grab one member and drag: both must move, and both must stay selected
        // — removing the shape under the cursor as the drag starts is exactly
        // what deferring the toggle to mouse-up avoids.
        const before = bounds(scene, a);
        input.onMouseDown(mouse(125, 25, { shiftKey: true }));
        input.onMouseMove(mouse(165, 25, { shiftKey: true }));
        input.onMouseUp(mouse(165, 25, { shiftKey: true }));

        expect(Array.from(e.get_selection()).sort()).toEqual([a, b].sort());
        expect(bounds(scene, a)[0]).toBeGreaterThan(before[0]);
    });

    it('shift-clicking an unselected shape still adds it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 50, 50);
        const b = e.add_rect(100, 0, 50, 50);
        const { input } = makeInput(scene);

        click(input, 25, 25);
        click(input, 125, 25, { shiftKey: true });
        expect(Array.from(e.get_selection()).sort()).toEqual([a, b].sort());
    });
});
