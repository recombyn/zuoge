/**
 * The editor's states, the modifier keys, and the transitions between them.
 *
 * Selection and creation are covered elsewhere (`interaction_sweep`,
 * `pen_text_sweep`). This file is about the MODES a person can be in — at the
 * root, inside a group, editing a path, holding a tool — and about the two keys
 * that move between them, Escape and Enter. Mode bugs are the expensive kind:
 * the click you make next means something different from what you intended, and
 * nothing on screen necessarily says so.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
beforeEach(() => {
    document.body.innerHTML = '<div id="canvas-container"></div>';
    // The text overlay measures glyphs through a 2D context to auto-size; jsdom
    // has none, and without this it throws on the first keystroke.
    const fakeCtx = {
        font: '',
        measureText: (t: string) => ({ width: t.length * 8 }),
    } as unknown as CanvasRenderingContext2D;
    HTMLCanvasElement.prototype.getContext = (() =>
        fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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
        // Read when a committed path's local bounds are needed.
        calculatePathBounds: () => ({ x: 0, y: 0, width: 1, height: 1 }),
    } as unknown as Renderer;
}
/** A UI stub that behaves like UIEngine where the transitions depend on it. */
function makeUI(activeTool = 'selection') {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(t: string, lock = false) {
            ui.activeTool = t;
            ui.toolLocked = lock;
            // Mirrors UIEngine.setActiveTool: leaving the pen commits, leaving
            // node-editing exits. Tests of "what mode am I in" are worthless if
            // the stub silently skips the part that changes modes.
            const im = ui.__im as InputManager | undefined;
            if (!im) return;
            im.commitActiveTextEdit();
            if (im.currentPathPoints.length > 0) im.finalizePenPath();
            if (im.editingNodeId !== null) im.exitEditMode();
            ui.activeTool = t;
            ui.toolLocked = lock;
        },
        __im: undefined as InputManager | undefined,
        getCurrentStyle: () =>
            JSON.stringify({
                fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1 }],
                strokes: [
                    {
                        paint: { r: 0, g: 0, b: 0, a: 1 },
                        width: 1,
                        cap: 0,
                        join: 0,
                        dash_array: [],
                        dash_offset: 0,
                        miter_limit: 4,
                        alignment: 'Center',
                    },
                ],
                opacity: 1,
                blend_mode: 0,
                corner_radius: 0,
            }),
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        contextBar: { refresh() {} },
        setActiveRegion() {},
        gradientEdit: { isActive: () => false, hitTest: () => null, stopFocused: false },
        meshEdit: { selectedVertices: new Set(), cancelDrag() {} },
    };
    return ui;
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
const keyEv = (key: string, o: Record<string, unknown> = {}) =>
    ({
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        ctrlKey: false,
        target: document.body,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as KeyboardEvent;

function makeInput(scene: WasmScene, tool = 'selection') {
    const ui = makeUI(tool);
    const input = new InputManager(
        document.createElement('canvas'),
        scene,
        ui as unknown as UIEngine,
        makeRenderer(),
    );
    ui.__im = input;
    return { input, ui };
}
const click = (i: InputManager, x: number, y: number, o: Record<string, unknown> = {}) => {
    i.onMouseDown(mouse(x, y, o));
    i.onMouseUp(mouse(x, y, o));
};
const sel = (s: WasmScene) => Array.from(s.engine!.get_selection());

/** A group of two rects, plus a loose rect outside it. */
function nested(scene: WasmScene) {
    const e = scene.engine!;
    const a = e.add_rect(0, 0, 60, 60);
    const b = e.add_rect(80, 0, 60, 60);
    const g = e.group_nodes(JSON.stringify([a, b]));
    const loose = e.add_rect(0, 200, 60, 60);
    return { a, b, g, loose };
}

describe('states: getting into a group and back out', () => {
    it('a click selects the group; a double-click goes one level in', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([g]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
    });

    it('once inside, a plain click selects siblings, not the group again', () => {
        const scene = makeScene();
        const { a, b } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        click(input, 110, 30);
        expect(sel(scene)).toEqual([b]);
    });

    it('Escape steps out to the group, and again to nothing', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([g]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([]);
    });

    it('Enter is the way in: it drills into a selected group', () => {
        const scene = makeScene();
        const { g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([g]);
        input.onKeyDown(keyEv('Enter'));
        expect(sel(scene)).not.toEqual([g]);
        expect(sel(scene).length).toBe(1);
    });

    it('clicking a shape OUTSIDE the group leaves the group', () => {
        const scene = makeScene();
        const { loose } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        click(input, 30, 230);
        expect(sel(scene)).toEqual([loose]);
    });
});

describe('states: node editing', () => {
    it('double-clicking a lone shape enters node editing; Escape leaves it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).toBe(r);
        input.onKeyDown(keyEv('Escape'));
        expect(input.editingNodeId).toBeNull();
    });

    it('switching tools leaves node editing rather than leaving it armed', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input, ui } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).not.toBeNull();
        ui.setActiveTool('rect');
        expect(input.editingNodeId).toBeNull();
    });

    it('Enter also leaves node editing, and hands back the selection tool', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input, ui } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        input.onKeyDown(keyEv('Enter'));
        expect(input.editingNodeId).toBeNull();
        expect(ui.activeTool).toBe('selection');
    });
});

describe('states: an armed tool is its own mode', () => {
    it('Escape disarms a creation tool back to selection', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'rect');
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
    });

    it('Escape with a live pen path commits it before disarming', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        input.onKeyDown(keyEv('Escape'));
        const roots = JSON.parse(scene.engine!.get_scene_json()).root_nodes;
        expect(roots.length).toBe(1);
        // The path is committed; the tool goes back on the NEXT Escape, so the
        // first one is never ambiguous between "finish this" and "put it away".
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
    });
});

describe('modifiers: what each one means with the selection tool', () => {
    it('shift adds to and removes from the selection', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 60, 60);
        const b = e.add_rect(80, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        click(input, 110, 30, { shiftKey: true });
        expect(sel(scene).sort()).toEqual([a, b].sort());
        click(input, 110, 30, { shiftKey: true });
        expect(sel(scene)).toEqual([a]);
    });

    it('cmd reaches inside a group without entering it', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
        // Deep-select picks the leaf, but does NOT put you inside the group:
        // Escape goes straight back to the group, as from any selected member.
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([g]);
    });

    it('alt-drag clones instead of moving', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        input.onMouseDown(mouse(30, 30, { altKey: true }));
        input.onMouseMove(mouse(120, 30, { altKey: true }));
        input.onMouseUp(mouse(120, 30, { altKey: true }));
        expect(JSON.parse(e.get_scene_json()).root_nodes.length).toBe(before + 1);
        expect(Array.from(scene.getNodeBounds(r))[0]).toBeCloseTo(0, 3);
    });

    it('shift-drag constrains a move to one axis', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = Array.from(scene.getNodeBounds(r));
        input.onMouseDown(mouse(30, 30, { shiftKey: true }));
        input.onMouseMove(mouse(130, 44, { shiftKey: true })); // mostly horizontal
        input.onMouseUp(mouse(130, 44, { shiftKey: true }));
        const after = Array.from(scene.getNodeBounds(r));
        expect(after[0]).toBeGreaterThan(before[0]);
        expect(after[1]).toBeCloseTo(before[1], 3); // y unchanged
    });
});

describe('transitions: one mode at a time', () => {
    it('arming a tool while inside a group does not silently leave it', () => {
        const scene = makeScene();
        const { a } = nested(scene);
        const { input, ui } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        ui.setActiveTool('rect');
        // Still inside: a shape drawn now belongs to the group you are in.
        expect(sel(scene)).toEqual([a]);
    });

    it('entering text editing closes a live pen path rather than running both', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        ui.setActiveTool('text');
        expect(input.currentPathPoints.length).toBe(0);
        expect(JSON.parse(scene.engine!.get_scene_json()).root_nodes.length).toBe(1);
    });

    it('deleting the shape you are editing leaves node editing behind', () => {
        const scene = makeScene();
        const e = scene.engine!;
        e.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        expect(input.editingNodeId).not.toBeNull();
        input.deleteSelection();
        // Editing a node that no longer exists is a state nothing can get out
        // of: the panel shows its properties, clicks route to its points.
        expect(input.editingNodeId).toBeNull();
    });
});

/** group( group(a, b), c ) — two levels deep, plus a loose rect at the root. */
function twoLevels(scene: WasmScene) {
    const e = scene.engine!;
    const a = e.add_rect(0, 0, 60, 60);
    const b = e.add_rect(80, 0, 60, 60);
    const inner = e.group_nodes(JSON.stringify([a, b]));
    const c = e.add_rect(0, 100, 60, 60);
    const outer = e.group_nodes(JSON.stringify([inner, c]));
    return { a, b, c, inner, outer };
}

describe('states: nested groups climb one level at a time', () => {
    it('double-click drills one level per click, not straight to the leaf', () => {
        const scene = makeScene();
        const { a, inner, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        expect(sel(scene)).toEqual([outer]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([inner]);
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
    });

    it('Escape climbs back out the same way', () => {
        const scene = makeScene();
        const { a, inner, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.onDoubleClick(mouse(30, 30));
        expect(sel(scene)).toEqual([a]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([inner]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([outer]);
        input.onKeyDown(keyEv('Escape'));
        expect(sel(scene)).toEqual([]);
    });

    it('clicking outside the group you are in drops you back to the top level', () => {
        const scene = makeScene();
        const { c, outer } = twoLevels(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.onDoubleClick(mouse(30, 30));
        // `c` lives in the OUTER group, not the inner one being edited. Clicking
        // it leaves the context rather than reaching sideways into a level you
        // are not in — the same rule as Illustrator's isolation mode — so what
        // gets selected is the top-level object that contains it.
        click(input, 30, 130);
        expect(sel(scene)).toEqual([outer]);
        expect(c).toBeGreaterThan(0);
    });
});

describe('modifiers: combinations', () => {
    it('shift+cmd adds a deep-selected leaf to the selection', () => {
        const scene = makeScene();
        const { a, loose } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 230); // the loose rect
        expect(sel(scene)).toEqual([loose]);
        click(input, 30, 30, { metaKey: true, shiftKey: true });
        expect(sel(scene).sort()).toEqual([a, loose].sort());
    });

    it('an alt-dragged copy lands where the pointer left it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onMouseDown(mouse(30, 30, { altKey: true }));
        input.onMouseMove(mouse(130, 80, { altKey: true }));
        input.onMouseUp(mouse(130, 80, { altKey: true }));
        const roots = JSON.parse(e.get_scene_json()).root_nodes;
        const copy = roots.find((id: number) => id !== r)!;
        const b = Array.from(scene.getNodeBounds(copy));
        // Dragged +100,+50 from a rect at the origin.
        expect(b[0]).toBeCloseTo(100, 3);
        expect(b[1]).toBeCloseTo(50, 3);
    });

    it('alt+shift drag clones along one axis', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        const before = JSON.parse(e.get_scene_json()).root_nodes.length;
        input.onMouseDown(mouse(30, 30, { altKey: true, shiftKey: true }));
        input.onMouseMove(mouse(130, 40, { altKey: true, shiftKey: true }));
        input.onMouseUp(mouse(130, 40, { altKey: true, shiftKey: true }));
        const roots = JSON.parse(e.get_scene_json()).root_nodes;
        expect(roots.length).toBe(before + 1);
        expect(Array.from(scene.getNodeBounds(r))[0]).toBeCloseTo(0, 3);
        const copy = roots.find((id: number) => id !== r)!;
        // Constrained: the clone shares the original's y.
        expect(Array.from(scene.getNodeBounds(copy))[1]).toBeCloseTo(0, 3);
    });

    it('cmd-clicking an already deep-selected leaf keeps it selected', () => {
        const scene = makeScene();
        const { a } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
        click(input, 30, 30, { metaKey: true });
        expect(sel(scene)).toEqual([a]);
    });
});

describe('states: the bucket is a mode of its own', () => {
    function painted(scene: WasmScene) {
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 120, 120);
        const b = e.add_rect(80, 0, 120, 120);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        return { a, b, g };
    }

    it('arming the bucket with a selection makes a Live Paint group of it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 120, 120);
        const b = e.add_rect(80, 0, 120, 120);
        const { input, ui } = makeInput(scene);
        e.select_node(a, false);
        e.select_node(b, true);
        ui.setActiveTool('paint-bucket');
        input.enterPaintBucketMode();
        expect(e.get_live_paint_group()).toBeGreaterThan(0);
    });

    it('Escape from the bucket goes back to selection, keeping the group', () => {
        const scene = makeScene();
        const { g } = painted(scene);
        const { input, ui } = makeInput(scene, 'paint-bucket');
        input.onKeyDown(keyEv('Escape'));
        expect(ui.activeTool).toBe('selection');
        expect(scene.engine!.get_node_live_paint(g)).toBe(true);
    });

    it('double-clicking a Live Paint group with the bucket held stays painting', () => {
        const scene = makeScene();
        const { g } = painted(scene);
        const { input, ui } = makeInput(scene, 'paint-bucket');
        input.onDoubleClick(mouse(40, 40));
        // The bucket drills between painted groups; it must not drop into
        // node-editing, which would leave the click meaning something else.
        expect(input.editingNodeId).toBeNull();
        expect(ui.activeTool).toBe('paint-bucket');
        expect(g).toBeGreaterThan(0);
    });
});

/**
 * ⌘Z is a way back to a PLACE, not just to older geometry.
 *
 * Deleting an anchor, leaving node editing and pressing ⌘Z used to restore the
 * anchor into a shape you were no longer inside — the change was invisible and
 * untouchable, and the mode you had been working in was gone. Figma and
 * Illustrator both hand you back the context an edit was made in, because that
 * is the only place the restored edit means anything. Redo is the exact
 * inverse: it returns you to where you were standing when you pressed undo.
 */
describe('transitions: undo restores the mode, not just the document', () => {
    const anchorCount = (s: WasmScene, id: number) =>
        (s.getNodeGeometry(id)?.Path?.subpaths ?? []).reduce(
            (n: number, sp: { points: unknown[] }) => n + sp.points.length,
            0,
        );
    const undo = (i: InputManager) => i.onKeyDown(keyEv('z', { metaKey: true }));
    const redo = (i: InputManager) => i.onKeyDown(keyEv('z', { metaKey: true, shiftKey: true }));
    /** A rect opened for node editing, with its top-left anchor picked. */
    function editingRect(tool = 'selection') {
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 100, 100);
        const { input, ui } = makeInput(scene, tool);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50)); // enters node editing (rect → path)
        click(input, 0, 0); // pick the top-left anchor
        return { scene, input, ui, r };
    }

    it('brings the deleted anchor back AND puts you back in node editing', () => {
        const { scene, input, r } = editingRect();
        expect(input.selectedPoints.size).toBe(1);
        input.onKeyDown(keyEv('Backspace'));
        expect(anchorCount(scene, r)).toBe(3);
        input.onKeyDown(keyEv('Escape')); // leave node editing
        expect(input.editingNodeId).toBeNull();

        undo(input);
        expect(anchorCount(scene, r)).toBe(4);
        expect(input.editingNodeId, 'undo left the restored anchor out of reach').toBe(r);
        // ...and the anchor it brought back is the one that is selected, so the
        // next thing you type acts on it.
        expect(Array.from(input.selectedPoints)).toEqual(['0:0']);
    });

    it('re-entering node editing hands back the Direct Selection tool', () => {
        const { input, ui, r } = editingRect();
        input.onKeyDown(keyEv('Backspace'));
        ui.setActiveTool('rect'); // wander off to a creation tool
        undo(input);
        expect(input.editingNodeId).toBe(r);
        expect(ui.activeTool, 'node editing with a creation tool armed').toBe('direct');
    });

    it('redo puts you back where undo found you', () => {
        const { scene, input, r } = editingRect();
        input.onKeyDown(keyEv('Backspace'));
        input.onKeyDown(keyEv('Escape'));
        undo(input);
        expect(input.editingNodeId).toBe(r);

        redo(input);
        // Undo was pressed from outside node editing, so redo returns there —
        // ⌘Z ⇧⌘Z is a round trip, not a drift.
        expect(anchorCount(scene, r)).toBe(3);
        expect(input.editingNodeId).toBeNull();
    });

    it('undoing past the point node editing began leaves it', () => {
        const { scene, input, r } = editingRect();
        input.onKeyDown(keyEv('Backspace'));
        undo(input); // the anchor
        undo(input); // the rect → path conversion that entering performed
        expect(scene.getNode(r)?.node_type).toBe('Rect');
        // A Rect has no anchors to edit, so staying "in" node editing on it
        // would be a mode pointing at nothing.
        expect(input.editingNodeId).toBeNull();
    });

    it('undo with nothing left to undo does not throw you out of the mode', () => {
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        scene.history = new History(50); // nothing left to undo
        for (let i = 0; i < 3; i++) undo(input);
        // A ⌘Z that undoes nothing must not change anything else either. It
        // used to tear down node editing on the way in, so pressing it out of
        // habit at the start of a session dropped you out of the mode.
        expect(input.editingNodeId).toBe(r);
    });

    it('deleting every anchor removes the shape; undo brings back both it and the mode', () => {
        const { scene, input, r } = editingRect();
        input.selectedPoints = new Set(['0:0', '0:1', '0:2', '0:3']);
        input.onKeyDown(keyEv('Backspace'));
        expect(scene.getNode(r)).toBeNull();
        expect(input.editingNodeId).toBeNull();

        undo(input);
        expect(scene.getNode(r)?.node_type).toBe('Path');
        expect(input.editingNodeId, 'the shape came back, the mode did not').toBe(r);
    });

    it('steps back into the group the edit was made inside', () => {
        const scene = makeScene();
        const { a, g } = nested(scene);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30)); // drill into the group
        input.onKeyDown(keyEv('ArrowRight')); // nudge the child
        input.onKeyDown(keyEv('Escape')); // step back out to the group
        expect(sel(scene)).toEqual([g]);

        undo(input);
        expect(sel(scene)).toEqual([a]);
        // Standing inside the group again, so the next click picks its members
        // rather than re-selecting the whole group.
        click(input, 110, 30);
        expect(sel(scene)).not.toEqual([g]);
    });
});

/**
 * One gesture is one ⌘Z, and a gesture that changed nothing is none at all.
 * Anchor editing used to push a state on mouse-DOWN and another on mouse-UP,
 * so a drag took two presses (the first of them silent) and merely CLICKING an
 * anchor to select it left two dead steps behind.
 */
describe('states: an undo step means something changed', () => {
    const undo = (i: InputManager) => i.onKeyDown(keyEv('z', { metaKey: true }));
    const anchorX = (s: WasmScene, id: number) =>
        s.getNodeGeometry(id)?.Path?.subpaths?.[0]?.points?.[0]?.x;

    it('clicking an anchor to select it costs no undo step', () => {
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        click(input, 0, 0);
        click(input, 100, 0);
        click(input, 0, 0);
        // The only step on the stack is the rect → path conversion, so ONE ⌘Z
        // gets all the way back — no silent presses in between.
        undo(input);
        expect(scene.getNode(r)?.node_type).toBe('Rect');
    });

    it('dragging an anchor is a single ⌘Z', () => {
        const scene = makeScene();
        const r = scene.engine!.add_rect(0, 0, 100, 100);
        const { input } = makeInput(scene);
        click(input, 50, 50);
        input.onDoubleClick(mouse(50, 50));
        input.onMouseDown(mouse(0, 0));
        input.onMouseMove(mouse(20, 20));
        input.onMouseUp(mouse(20, 20));
        expect(anchorX(scene, r)).toBeCloseTo(20);

        undo(input);
        expect(anchorX(scene, r), 'the first ⌘Z after a drag did nothing').toBeCloseTo(0);
    });
});

describe('transitions: nothing is left pointing at a corpse', () => {
    it('undo does not leave the selection holding a deleted id', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 60, 60);
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.deleteSelection();
        scene.undo();
        // Whatever the selection is after undo, every id in it must exist.
        for (const id of sel(scene)) expect(e.get_node_type(id)).not.toBeUndefined();
        expect(r).toBeGreaterThan(0);
    });

    it('deleting the last member of a group you are inside does not strand you', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 60, 60);
        const g = e.group_nodes(JSON.stringify([a]));
        const { input } = makeInput(scene);
        click(input, 30, 30);
        input.onDoubleClick(mouse(30, 30));
        input.deleteSelection();
        for (const id of sel(scene)) expect(e.get_node_type(id)).not.toBeUndefined();
        expect(g).toBeGreaterThan(0);
    });
});

describe('states: re-arming a tool means "start fresh with it"', () => {
    /** The keyboard route, exactly as a person uses it. */
    const pressTool = (i: InputManager, key: string) => i.onKeyDown(keyEv(key));
    const roots = (s: WasmScene) => JSON.parse(s.engine!.get_scene_json()).root_nodes;

    it('P with a path in progress commits it and starts a new one', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        click(input, 60, 60);

        pressTool(input, 'p');
        // Committed, and nothing is attached to the cursor any more.
        expect(roots(scene).length).toBe(1);
        expect(input.currentPathPoints.length).toBe(0);

        // The next clicks are a SECOND shape, not a continuation of the first.
        click(input, 200, 0);
        click(input, 260, 0);
        input.onKeyDown(keyEv('Enter'));
        expect(roots(scene).length).toBe(2);
    });

    it('P mid-path leaves the same state as P from a standing start', () => {
        // The rule stated as an equality, since that is what "consistent" means
        // here: the tool does not remember what it was doing.
        const fresh = makeScene();
        const { input: a } = makeInput(fresh, 'selection');
        a.onKeyDown(keyEv('p'));
        const standing = { pts: a.currentPathPoints.length, editing: a.editingNodeId };

        const busy = makeScene();
        const { input: b } = makeInput(busy, 'pen');
        click(b, 0, 0);
        click(b, 60, 0);
        b.onKeyDown(keyEv('p'));

        expect({ pts: b.currentPathPoints.length, editing: b.editingNodeId }).toEqual(standing);
    });

    it('the same holds for the toolbar, not just the key', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        ui.setActiveTool('pen');
        expect(input.currentPathPoints.length).toBe(0);
        expect(roots(scene).length).toBe(1);
    });

    it('T while editing text commits and opens a fresh box', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = document.querySelector('.text-input-overlay') as HTMLTextAreaElement;
        el.value = 'first';
        ui.setActiveTool('text');
        const texts = roots(scene).filter((id: number) => scene.getNode(id)?.node_type === 'Text');
        expect(texts.length).toBe(1);
        expect(scene.getNode(texts[0])?.geometry?.Text?.content).toBe('first');
    });
});

describe('states: the re-arm rule holds for every tool, not just the pen', () => {
    // Stated once as a property. A rule that holds for the tool someone
    // complained about and nowhere else is not consistency, it is a patch.
    const TOOLS = ['pen', 'rect', 'ellipse', 'line', 'text', 'pencil'];

    it('re-arming any tool leaves it armed and holds nothing in progress', () => {
        for (const tool of TOOLS) {
            const scene = makeScene();
            const { input, ui } = makeInput(scene, tool);
            // Put the pen into a half-drawn state where that is possible; for
            // the others there is nothing to leave behind, and the assertion is
            // that re-arming is still a no-op rather than a surprise.
            if (tool === 'pen') {
                click(input, 0, 0);
                click(input, 60, 0);
            }
            ui.setActiveTool(tool);
            expect(ui.activeTool, `${tool} should stay armed`).toBe(tool);
            expect(input.currentPathPoints.length, `${tool} left a path in progress`).toBe(0);
            expect(input.editingNodeId, `${tool} left node editing open`).toBeNull();
            expect(
                document.querySelector('.text-input-overlay'),
                `${tool} left a text box open`,
            ).toBeNull();
        }
    });

    it('switching between two creation tools never leaves the first one running', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        ui.setActiveTool('rect');
        expect(ui.activeTool).toBe('rect');
        expect(input.currentPathPoints.length).toBe(0);
        expect(JSON.parse(scene.engine!.get_scene_json()).root_nodes.length).toBe(1);
    });
});
