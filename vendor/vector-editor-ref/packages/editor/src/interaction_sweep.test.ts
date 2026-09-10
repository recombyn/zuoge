/**
 * Interaction sweep: the gestures a person performs constantly, asserted
 * against the real engine through the real InputManager.
 *
 * Written after shipping a build where shift-clicking an already-selected shape
 * did nothing — a gesture every editor has, reported by the user rather than
 * caught here, because the tests covered the features being built and not the
 * interactions around them. This file is the other axis.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { alignSelection } from './align';
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
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}
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
interface Opts {
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    button?: number;
}
const mouse = (clientX: number, clientY: number, o: Opts = {}) =>
    ({
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as MouseEvent;

function makeInput(scene: WasmScene) {
    const input = new InputManager(
        document.createElement('canvas'),
        scene,
        makeUI(),
        makeRenderer(),
    );
    return input;
}
const click = (input: InputManager, x: number, y: number, o: Opts = {}) => {
    input.onMouseDown(mouse(x, y, o));
    input.onMouseUp(mouse(x, y, o));
};
const drag = (
    input: InputManager,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    o: Opts = {},
) => {
    input.onMouseDown(mouse(x0, y0, o));
    input.onMouseMove(mouse(x1, y1, o));
    input.onMouseUp(mouse(x1, y1, o));
};
const sel = (scene: WasmScene) => Array.from(scene.engine!.get_selection()).sort((a, b) => a - b);

/** Three rects, left to right, 60 apart. */
function threeRects(scene: WasmScene) {
    const e = scene.engine!;
    return [e.add_rect(0, 0, 40, 40), e.add_rect(60, 0, 40, 40), e.add_rect(120, 0, 40, 40)];
}

describe('sweep: selection', () => {
    it('clicking a shape selects only it', () => {
        const scene = makeScene();
        const [a, b] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        expect(sel(scene)).toEqual([a]);
        click(input, 80, 20);
        expect(sel(scene)).toEqual([b]);
    });

    it('clicking empty space clears the selection', () => {
        const scene = makeScene();
        threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        click(input, 400, 400);
        expect(sel(scene)).toEqual([]);
    });

    it('shift-clicking empty space keeps the selection', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        click(input, 400, 400, { shiftKey: true });
        expect(sel(scene)).toEqual([a]);
    });

    it('shift-clicking builds a selection and removes from it', () => {
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        click(input, 80, 20, { shiftKey: true });
        click(input, 140, 20, { shiftKey: true });
        expect(sel(scene)).toEqual([a, b, c]);
        click(input, 80, 20, { shiftKey: true });
        expect(sel(scene)).toEqual([a, c]);
    });

    it('shift-clicking the LAST selected shape empties the selection', () => {
        const scene = makeScene();
        threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        click(input, 20, 20, { shiftKey: true });
        expect(sel(scene)).toEqual([]);
    });

    it('a marquee selects what it covers, and shift-marquee adds', () => {
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        const input = makeInput(scene);
        drag(input, -20, -20, 110, 60);
        expect(sel(scene)).toEqual([a, b]);
        drag(input, 115, -20, 200, 60, { shiftKey: true });
        expect(sel(scene)).toEqual([a, b, c]);
    });

    it('a marquee that touches nothing clears the selection', () => {
        const scene = makeScene();
        threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        drag(input, 300, 300, 380, 380);
        expect(sel(scene)).toEqual([]);
    });
});

describe('sweep: locked and hidden', () => {
    it('a locked shape is not selectable by clicking it', () => {
        const scene = makeScene();
        const [a, b] = threeRects(scene);
        scene.engine!.set_node_locked(a, true);
        const input = makeInput(scene);
        click(input, 20, 20);
        expect(sel(scene)).not.toContain(a);
        click(input, 80, 20);
        expect(sel(scene)).toEqual([b]);
    });

    it('a hidden shape is not selectable by clicking where it was', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        scene.engine!.set_node_visible(a, false);
        const input = makeInput(scene);
        click(input, 20, 20);
        expect(sel(scene)).not.toContain(a);
    });

    it('a marquee skips locked and hidden shapes', () => {
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        scene.engine!.set_node_locked(a, true);
        scene.engine!.set_node_visible(b, false);
        const input = makeInput(scene);
        drag(input, -20, -20, 200, 60);
        expect(sel(scene)).toEqual([c]);
    });
});

describe('sweep: groups', () => {
    it('clicking a grouped shape selects the GROUP, not the member', () => {
        const scene = makeScene();
        const [a, b] = threeRects(scene);
        const g = scene.engine!.group_nodes(JSON.stringify([a, b]));
        const input = makeInput(scene);
        click(input, 20, 20);
        expect(sel(scene)).toEqual([g]);
    });

    it('cmd-clicking reaches the member inside the group', () => {
        const scene = makeScene();
        const [a, b] = threeRects(scene);
        scene.engine!.group_nodes(JSON.stringify([a, b]));
        const input = makeInput(scene);
        click(input, 20, 20, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
    });

    it('group then ungroup restores the members as the selection', () => {
        const scene = makeScene();
        const [a, b] = threeRects(scene);
        const input = makeInput(scene);
        drag(input, -20, -20, 110, 60);
        input.groupSelection?.();
        expect(sel(scene).length).toBe(1);
        input.ungroupSelection?.();
        expect(sel(scene)).toEqual([a, b]);
    });
});

describe('sweep: destructive gestures and undo', () => {
    it('delete removes the selection and undo brings it back', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        input.deleteSelection?.();
        expect(sel(scene)).toEqual([]);
        expect(scene.engine!.get_node_type(a)).toBeUndefined();
        scene.undo();
        expect(scene.engine!.get_node_type(a)).not.toBeUndefined();
    });

    it('a move can be undone back to the original position', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        const before = Array.from(scene.getNodeBounds(a));
        drag(input, 20, 20, 90, 20);
        const moved = Array.from(scene.getNodeBounds(a));
        expect(moved[0]).toBeGreaterThan(before[0]);
        scene.undo();
        expect(Array.from(scene.getNodeBounds(a))[0]).toBeCloseTo(before[0], 3);
    });

    it('alt-dragging clones instead of moving', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        const countBefore = JSON.parse(scene.engine!.get_scene_json()).root_nodes.length;
        drag(input, 20, 20, 90, 20, { altKey: true });
        const countAfter = JSON.parse(scene.engine!.get_scene_json()).root_nodes.length;
        expect(countAfter).toBe(countBefore + 1);
        expect(Array.from(scene.getNodeBounds(a))[0]).toBeCloseTo(0, 3);
    });
});

describe('sweep: the corner-radius zone does not eat the shape', () => {
    // The bug behind "impossible to deselect a single shape". The four grab
    // zones tiled the interior of anything small, and the radius check runs
    // before selection, so every gesture on a small rect became a radius drag.
    it('a small rect can be clicked, dragged and shift-deselected', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 40, 40);
        const input = makeInput(scene);

        click(input, 20, 20);
        expect(sel(scene)).toEqual([r]);

        const before = Array.from(scene.getNodeBounds(r));
        drag(input, 20, 20, 90, 20);
        expect(Array.from(scene.getNodeBounds(r))[0]).toBeGreaterThan(before[0]);
        expect(scene.getNode(r)?.style.corner_radius ?? 0).toBe(0);
    });

    it('a rect too small for a corner control exposes none', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 18, 18);
        const input = makeInput(scene);
        click(input, 9, 9);
        expect((input as any).checkCornerRadiusHandle({ x: 9, y: 9 })).toBeNull();
    });

    it('a big rect still has grabbable corner controls', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const big = e.add_rect(0, 0, 400, 300);
        const input = makeInput(scene);
        click(input, 200, 150);
        const i = input as any;
        // On the handle (14 in from each edge): a radius drag.
        expect(i.checkCornerRadiusHandle({ x: 14, y: 14 })).not.toBeNull();
        // In the middle: not.
        expect(i.checkCornerRadiusHandle({ x: 200, y: 150 })).toBeNull();
        expect(big).toBeGreaterThan(0);
    });
});

describe('sweep: z-order and nudging', () => {
    it('bring to front and send to back reorder the paint list', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b, c] = threeRects(scene);
        const order = () => JSON.parse(e.get_scene_json()).root_nodes;
        expect(order()).toEqual([a, b, c]);
        e.select_node(a, false);
        e.bring_to_front(a);
        expect(order()[order().length - 1]).toBe(a);
        e.send_to_back(a);
        expect(order()[0]).toBe(a);
        expect(c).toBeGreaterThan(0);
    });

    it('arrow keys nudge by one unit, and by ten with shift', () => {
        const scene = makeScene();
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        const x = () => Array.from(scene.getNodeBounds(a))[0];
        const start = x();
        const key = (k: string, shift = false) =>
            input.onKeyDown({
                key: k,
                code: k,
                shiftKey: shift,
                altKey: false,
                metaKey: false,
                ctrlKey: false,
                target: document.body,
                preventDefault() {},
                stopPropagation() {},
            } as unknown as KeyboardEvent);
        key('ArrowRight');
        expect(x()).toBeCloseTo(start + 1, 3);
        key('ArrowRight', true);
        expect(x()).toBeCloseTo(start + 11, 3);
        key('ArrowLeft');
        expect(x()).toBeCloseTo(start + 10, 3);
    });
});

describe('sweep: copy, paste, duplicate', () => {
    const key = (
        input: InputManager,
        k: string,
        mods: Partial<Record<'shiftKey' | 'metaKey' | 'altKey', boolean>> = {},
    ) =>
        input.onKeyDown({
            key: k,
            code: `Key${k.toUpperCase()}`,
            shiftKey: false,
            metaKey: false,
            altKey: false,
            ctrlKey: false,
            ...mods,
            target: document.body,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent);

    it('cmd-C then cmd-V adds a copy and leaves the original alone', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        const wasAt = Array.from(scene.getNodeBounds(a));
        key(input, 'c', { metaKey: true });
        key(input, 'v', { metaKey: true });
        expect(JSON.parse(e.get_scene_json()).root_nodes.length).toBe(before + 1);
        expect(Array.from(scene.getNodeBounds(a))).toEqual(wasAt);
        // The pasted copy is what you now hold, or the next drag moves the wrong thing.
        expect(sel(scene)).not.toEqual([a]);
        expect(sel(scene).length).toBe(1);
    });

    it('cmd-X then cmd-V moves a shape rather than losing it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        key(input, 'x', { metaKey: true });
        expect(JSON.parse(e.get_scene_json()).root_nodes.length).toBe(before - 1);
        key(input, 'v', { metaKey: true });
        expect(JSON.parse(e.get_scene_json()).root_nodes.length).toBe(before);
    });

    it('duplicate leaves the original where it was', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a] = threeRects(scene);
        const before = Array.from(scene.getNodeBounds(a));
        const copy = e.duplicate_node(a);
        expect(copy).not.toBe(a);
        expect(Array.from(scene.getNodeBounds(a))).toEqual(before);
    });
});

describe('sweep: keyboard and modes', () => {
    const key = (input: InputManager, k: string, mods: Record<string, boolean> = {}) =>
        input.onKeyDown({
            key: k,
            code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
            shiftKey: false,
            metaKey: false,
            altKey: false,
            ctrlKey: false,
            ...mods,
            target: document.body,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent);

    it('] steps a multi-selection forward instead of shuffling it in place', () => {
        // Nodes move one at a time, so walking the selection back-to-front made
        // each move undo the one before it: two neighbours stepped past each
        // other and the stack came out exactly as it started.
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        const e = scene.engine!;
        e.select_node(a, false);
        e.select_node(b, true);
        const input = makeInput(scene);
        key(input, ']');
        expect(Array.from(scene.getRootNodes())).toEqual([c, a, b]);
    });

    it('...and the selection keeps its own stacking', () => {
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        const e = scene.engine!;
        e.select_node(b, false);
        e.select_node(c, true); // already the top two
        const input = makeInput(scene);
        key(input, ']');
        expect(Array.from(scene.getRootNodes())).toEqual([a, b, c]);
        key(input, '[');
        expect(Array.from(scene.getRootNodes())).toEqual([b, c, a]);
    });

    it('cmd-A selects everything and Escape clears it', () => {
        const scene = makeScene();
        const [a, b, c] = threeRects(scene);
        const input = makeInput(scene);
        key(input, 'a', { metaKey: true });
        expect(sel(scene)).toEqual([a, b, c]);
        key(input, 'Escape');
        expect(sel(scene)).toEqual([]);
    });

    it('delete then undo then redo lands back on the deleted state', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a] = threeRects(scene);
        const input = makeInput(scene);
        click(input, 20, 20);
        key(input, 'Backspace');
        expect(e.get_node_type(a)).toBeUndefined();
        scene.undo();
        expect(e.get_node_type(a)).not.toBeUndefined();
        scene.redo();
        expect(e.get_node_type(a)).toBeUndefined();
    });

    it('a locked shape cannot be dragged even when it is the only thing there', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 80, 80);
        e.set_node_locked(r, true);
        const input = makeInput(scene);
        const before = Array.from(scene.getNodeBounds(r));
        drag(input, 40, 40, 140, 40);
        expect(Array.from(scene.getNodeBounds(r))).toEqual(before);
    });

    it('...nor nudged, when the Objects panel is what selected it', () => {
        // The panel can select a locked node — that is how you unlock it — and
        // every gesture refused to touch it there except the arrow keys.
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 80, 80);
        e.set_node_locked(r, true);
        e.select_node(r, false);
        const input = makeInput(scene);
        const before = Array.from(scene.getNodeBounds(r));
        input.onKeyDown({
            key: 'ArrowRight',
            code: 'ArrowRight',
            shiftKey: false,
            metaKey: false,
            altKey: false,
            ctrlKey: false,
            target: document.body,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent);
        expect(Array.from(scene.getNodeBounds(r))).toEqual(before);
    });
});

describe('sweep: working inside a group that has been scaled or turned', () => {
    const key = (input: InputManager, k: string, mods: Record<string, boolean> = {}) =>
        input.onKeyDown({
            key: k,
            code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
            shiftKey: false,
            metaKey: false,
            altKey: false,
            ctrlKey: false,
            ...mods,
            target: document.body,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent);

    /** Two rects in a group scaled to 200%, so world units are twice local ones. */
    function scaledGroup() {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 40, 40);
        const b = e.add_rect(60, 20, 40, 40);
        const g = e.group_nodes(JSON.stringify([a, b]));
        scene.setNodeTransformComponents(g, {
            x: 0,
            y: 0,
            scale_x: 2,
            scale_y: 2,
            rotation_deg: 0,
            skew_x_deg: 0,
            skew_y_deg: 0,
        });
        return { scene, e, a, b, g };
    }

    it('an arrow key steps one unit across the canvas, not one times the scale', () => {
        const { scene, e, a } = scaledGroup();
        const input = makeInput(scene);
        e.select_node(a, false);
        key(input, 'ArrowRight');
        expect(Array.from(scene.getNodeBounds(a))).toEqual([1, 0, 81, 80]);
    });

    it('an arrow key steps along the canvas axes inside a rotated group', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b]));
        scene.rotateNode(g, Math.PI / 6);
        const before = Array.from(scene.getNodeBounds(a));
        const input = makeInput(scene);
        e.select_node(a, false);
        key(input, 'ArrowRight');
        const after = Array.from(scene.getNodeBounds(a));
        expect(after[0] - before[0]).toBeCloseTo(1, 5);
        expect(after[1] - before[1]).toBeCloseTo(0, 5); // not diagonal
    });

    it('a resize handle follows the pointer inside a scaled group', () => {
        // resize_node writes LOCAL geometry; the drag measures WORLD bounds. The
        // world size was handed over unconverted, so the shape grew by the
        // group's scale on top of the drag and ran away from the cursor.
        const { scene, e, a } = scaledGroup();
        const input = makeInput(scene);
        e.select_node(a, false);
        expect(Array.from(scene.getNodeBounds(a))).toEqual([0, 0, 80, 80]);
        input.onMouseDown(mouse(80, 80)); // the bottom-right handle
        input.onMouseMove(mouse(120, 120));
        input.onMouseMove(mouse(160, 160));
        input.onMouseUp(mouse(160, 160));
        expect(Array.from(scene.getNodeBounds(a))).toEqual([0, 0, 160, 160]);
    });

    it('a copy pasted inside a scaled group is the size of what was copied', () => {
        // Clones are born at the root wearing the local transform they had
        // inside their parent, so a copy of a child of a 200% group started out
        // half the size — and the world-preserving reparent kept it that way.
        const { scene, e, a, g } = scaledGroup();
        const input = makeInput(scene);
        e.select_node(a, false);
        const width = (id: number) => {
            const b = Array.from(scene.getNodeBounds(id));
            return b[2] - b[0];
        };
        key(input, 'c', { metaKey: true });
        key(input, 'v', { metaKey: true });
        const copy = sel(scene).find((id) => id !== a && id !== g);
        expect(copy).toBeDefined();
        expect(scene.getNodeParent(copy!)).toBe(g);
        expect(width(copy!)).toBe(width(a));
    });

    it('a cut child pasted back into a scaled group keeps its size', () => {
        const { scene, e, a, b, g } = scaledGroup();
        const input = makeInput(scene);
        const width = (id: number) => {
            const bb = Array.from(scene.getNodeBounds(id));
            return bb[2] - bb[0];
        };
        const before = width(a);
        e.select_node(a, false);
        key(input, 'x', { metaKey: true });
        e.select_node(b, false); // the context is still inside the group
        key(input, 'v', { metaKey: true });
        const pasted = sel(scene)[0];
        expect(scene.getNodeParent(pasted)).toBe(g);
        expect(width(pasted)).toBeCloseTo(before, 5);
    });

    it('align and distribute are exact inside a scaled group', () => {
        const { scene, a, b } = scaledGroup();
        alignSelection(scene, [a, b], 'top');
        expect(Array.from(scene.getNodeBounds(a))[1]).toBe(0);
        expect(Array.from(scene.getNodeBounds(b))[1]).toBe(0);
    });
});

describe('sweep: the controls drawn on top of a shape', () => {
    it('a rect is dragged by its middle, not rounded by it', () => {
        // The corner-radius grab zones used to be three times the size of the
        // dots that advertise them and met in the middle: on a 40×40 rect every
        // press but the exact centre rounded the corners instead of moving it.
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 40, 40);
        const input = makeInput(scene);
        click(input, 20, 20);
        drag(input, 20, 32, 20, 132); // inside the shape, clear of the handles
        expect(Array.from(scene.getNodeBounds(r))).toEqual([0, 100, 40, 140]);
        expect(scene.getNode(r)?.style.corner_radius ?? 0).toBe(0);
    });

    it('...but a press on a corner handle still rounds it', () => {
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 40, 40);
        const input = makeInput(scene);
        click(input, 20, 20);
        drag(input, 14, 14, 20, 20); // the handle itself, 14 in from the corner
        expect(scene.getNode(r)?.style.corner_radius ?? 0).toBeGreaterThan(0);
    });
});

describe('sweep: entering a group and painting', () => {
    it('double-clicking a group selects the member under the cursor', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b] = threeRects(scene);
        e.group_nodes(JSON.stringify([a, b]));
        const input = makeInput(scene);
        click(input, 20, 20);
        input.onDoubleClick(mouse(20, 20));
        expect(sel(scene)).toEqual([a]);
    });

    it('a shape dragged into a group can still be double-clicked into', () => {
        // The Objects panel drops a shape into a group and leaves it selected.
        // That selection alone used to read as "you are inside this group", so
        // the group could never be entered again by double-clicking: the click
        // resolved to the child, and the double-click node-edited it.
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b, c] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.select_node(c, false);
        scene.reorderNodes([c], g, 0);

        const input = makeInput(scene);
        click(input, 130, 20); // the newcomer, still selected from the drag
        expect(sel(scene)).toEqual([g]); // a click picks the whole group
        input.onDoubleClick(mouse(130, 20));
        expect(sel(scene)).toEqual([c]); // and the double-click goes inside
    });

    it('a marquee inside a group gathers its members, not the group', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b, c] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b, c]));
        const input = makeInput(scene);
        click(input, 20, 20);
        input.onDoubleClick(mouse(20, 20)); // stand inside the group
        drag(input, -20, -20, 110, 60); // over a and b, not c
        expect(sel(scene)).toEqual([a, b]);
        expect(sel(scene)).not.toContain(g);
    });

    it('a click outside the group you entered leaves it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b, c] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b]));
        const input = makeInput(scene);
        click(input, 20, 20);
        input.onDoubleClick(mouse(20, 20));
        expect(sel(scene)).toEqual([a]); // inside the group
        click(input, 130, 20); // the loose rect outside it
        expect(sel(scene)).toEqual([c]);
        click(input, 70, 20); // back to the group: whole group again
        expect(sel(scene)).toEqual([g]);
    });

    it('an alt-dragged copy stays in the group its original is in', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b]));
        const input = makeInput(scene);
        click(input, 20, 20);
        input.onDoubleClick(mouse(20, 20)); // inside the group
        drag(input, 20, 20, 20, 220, { altKey: true });
        const copy = sel(scene)[0];
        expect(copy).not.toBe(a);
        expect(scene.getNodeParent(copy)).toBe(g);
        expect(Array.from(scene.getRootNodes())).not.toContain(copy);
    });

    it('a copy made inside a rotated group is still rotated', () => {
        // duplicate_node hands every clone to the root, so the clone's local
        // transform was being read against the root and then FROZEN there by a
        // world-preserving reparent: the copy came out unrotated, beside a
        // rotated original.
        const scene = makeScene();
        const e = scene.engine!;
        const [a, b] = threeRects(scene);
        const g = e.group_nodes(JSON.stringify([a, b]));
        scene.rotateNode(g, Math.PI / 6);
        const wide = (id: number) => {
            const [x0, , x1] = Array.from(scene.getNodeBounds(id));
            return Math.round((x1 - x0) * 100) / 100;
        };
        const rotatedWidth = wide(a); // a 40×40 square turned 30° spans 54.64
        e.select_node(a, false);
        const input = makeInput(scene);
        input.duplicateSelection();
        const copy = sel(scene)[0];
        expect(scene.getNodeParent(copy)).toBe(g);
        expect(wide(copy)).toBe(rotatedWidth);
    });

    it('the bucket paints the region under the click, not the shape', () => {
        const scene = makeScene();
        const e = scene.engine!;
        // Two overlapping rects in a Live Paint group: three regions.
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(60, 0, 100, 100);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);

        const overlap = e.query_face_at(80, 50);
        const leftOnly = e.query_face_at(20, 50);
        expect(overlap).toBeGreaterThanOrEqual(0);
        expect(leftOnly).toBeGreaterThanOrEqual(0);
        expect(overlap).not.toBe(leftOnly);

        // Painting the overlap must not touch its neighbour.
        e.set_face_paint(overlap, JSON.stringify({ r: 1, g: 0, b: 0, a: 1 }));
        expect(e.get_face_paint(leftOnly)).not.toContain('"r":1');
    });
});
