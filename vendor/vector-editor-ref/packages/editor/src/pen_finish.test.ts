/**
 * Finishing a pen path with a double-click (Figma/Sketch's gesture; ⏎ and Esc
 * still work as in Illustrator).
 *
 * The failure this pins down: the browser delivers `dblclick` *after* both
 * presses, so finishing a shape on top of existing artwork used to fall through
 * to the generic double-click handler and drop into node-editing whatever was
 * under the cursor — the drawing you just finished swapped out for someone
 * else's shape.
 *
 * Same headless harness as pen_undo.test.ts: the real wasm Engine behind
 * WasmScene, with minimal Renderer/UIEngine stubs.
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
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
        calculatePathBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }),
    } as unknown as Renderer;
}

/** The "last used" style a newly drawn shape inherits: a fill and a stroke. */
const ACTIVE_STYLE = {
    fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1 }],
    // cap/join are required by the engine's Stroke — a stroke missing them
    // fails to deserialize and the whole style is silently dropped.
    strokes: [{ paint: { r: 0, g: 0, b: 0, a: 1 }, width: 2, cap: 0, join: 0 }],
};

/** UIEngine stub that records tool changes the way the real toolbar would. */
function makeUI(activeTool = 'pen'): UIEngine {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(tool: string) {
            ui.activeTool = tool;
        },
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        getCurrentStyle: () => JSON.stringify(ACTIVE_STYLE),
        contextBar: { refresh() {} },
        gradientEdit: { isActive: () => false, hitTest: () => null },
    };
    return ui as unknown as UIEngine;
}

function makeInput(scene: WasmScene, ui: UIEngine) {
    return new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
}

/** A canvas mouse event. `detail` is the browser's click-sequence counter. */
function mouse(clientX: number, clientY: number, detail = 1): MouseEvent {
    return {
        clientX,
        clientY,
        detail,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
    } as unknown as MouseEvent;
}

/** One full press → release at a point, as the nth click of a sequence. */
function click(input: InputManager, x: number, y: number, detail = 1) {
    input.onMouseDown(mouse(x, y, detail));
    input.onMouseUp(mouse(x, y, detail));
}

/** The two presses of a double-click, then the dblclick the browser sends. */
function doubleClick(input: InputManager, x: number, y: number) {
    click(input, x, y, 1);
    click(input, x, y, 2);
    input.onDoubleClick(mouse(x, y, 2));
}

describe('pen tool — double-click finishes the path', () => {
    it('commits the path and drops the duplicate anchor the second press placed', () => {
        const scene = makeScene();
        const ui = makeUI();
        const input = makeInput(scene, ui);

        click(input, 100, 100);
        click(input, 200, 100);
        doubleClick(input, 200, 200);

        expect(input.currentPathPoints.length).toBe(0); // path is no longer live
        const roots = scene.engine!.get_root_nodes();
        expect(roots.length).toBe(1);
        const geom = scene.getNodeGeometry(roots[0]);
        // Three corners, not four: the double-click's second press doesn't
        // leave a coincident anchor behind.
        expect(geom?.Path?.subpaths[0].points.length).toBe(3);
        expect(geom?.Path?.subpaths[0].closed).toBe(false);
        expect(ui.activeTool).toBe('selection'); // one-shot tool reverts
    });

    it('leaves an open path stroke-only, and keeps the fill on a closed one', () => {
        const scene = makeScene();
        const input = makeInput(scene, makeUI());

        click(input, 100, 100);
        click(input, 200, 100);
        doubleClick(input, 200, 200);

        const open = scene.getNode(scene.engine!.get_selection()[0])!;
        // A fill on an open path shades the region between its endpoints —
        // never what a half-drawn outline meant to say.
        expect(open.style.fills?.length ?? 0).toBe(0);
        expect(open.style.strokes?.length).toBe(1);

        const scene2 = makeScene();
        const input2 = makeInput(scene2, makeUI());
        click(input2, 100, 100);
        click(input2, 200, 100);
        click(input2, 200, 200);
        click(input2, 100, 100); // back to the first anchor → closed shape

        const closed = scene2.getNode(scene2.engine!.get_selection()[0])!;
        expect(closed.style.fills?.length).toBe(1);
    });

    it('finishing on top of another shape does not enter node-editing on it', () => {
        const scene = makeScene();
        const ui = makeUI();
        const rect = scene.engine!.add_rect(150, 150, 200, 200);
        const input = makeInput(scene, ui);

        click(input, 100, 100);
        doubleClick(input, 200, 200); // second anchor lands over the rect

        expect(input.editingNodeId).toBe(null);
        expect(ui.activeTool).toBe('selection');
        expect(scene.engine!.get_selection()).not.toContain(rect);
    });

    it('swallows the stray dblclick after closing a path on the first anchor', () => {
        const scene = makeScene();
        const ui = makeUI();
        const rect = scene.engine!.add_rect(0, 0, 300, 300);
        const input = makeInput(scene, ui);

        click(input, 100, 100);
        click(input, 200, 100);
        click(input, 200, 200);
        // Double-click back on the first anchor: the first press closes and
        // commits the path, so the second press and the dblclick arrive with
        // the pen already gone.
        click(input, 100, 100, 1);
        expect(input.currentPathPoints.length).toBe(0);
        const closedPath = scene.engine!.get_selection()[0];

        click(input, 100, 100, 2);
        input.onDoubleClick(mouse(100, 100, 2));

        expect(input.editingNodeId).toBe(null);
        // The tail of the click pair neither re-selects the rect underneath nor
        // steals the selection from the path just drawn.
        expect(Array.from(scene.engine!.get_selection())).toEqual([closedPath]);
        expect(rect).not.toBe(closedPath);
    });

    it('leaves node-editing alone when a creation tool is armed', () => {
        // The pen's surprise, reached through the other drawing tools: both
        // presses of a double-click are zero-size drags that create nothing, so
        // the dblclick used to fall through and open the shape underneath.
        for (const tool of ['rect', 'ellipse', 'line', 'pencil', 'text', 'scissors', 'mesh']) {
            const scene = makeScene();
            const ui = makeUI(tool);
            const rect = scene.engine!.add_rect(0, 0, 300, 300);
            const input = makeInput(scene, ui);

            input.onDoubleClick(mouse(150, 150, 2));

            expect(input.editingNodeId, `${tool} entered node-editing`).toBe(null);
            expect(ui.activeTool, `${tool} was swapped out`).toBe(tool);
            expect(rect).toBe(1);
        }
    });

    it('a later, unrelated double-click still enters node-editing', () => {
        const scene = makeScene();
        const ui = makeUI();
        const rect = scene.engine!.add_rect(0, 0, 300, 300);
        const input = makeInput(scene, ui);

        click(input, 100, 100);
        click(input, 200, 100);
        click(input, 200, 200);
        click(input, 100, 100); // close → commit; guard is armed

        // A fresh click sequence disarms the guard, so this double-click on the
        // rect behaves normally.
        ui.setActiveTool('selection');
        doubleClick(input, 50, 50);

        expect(input.editingNodeId).toBe(rect);
    });
});
