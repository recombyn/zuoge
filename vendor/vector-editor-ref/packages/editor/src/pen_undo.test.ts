/**
 * Cmd+Z while the pen is mid-path takes back the anchor you just placed, rather
 * than reaching past the unfinished path into document history. The live path
 * isn't in the scene yet, so document undo has nothing to say about it — and
 * undoing your *previous* edit because you mis-clicked an anchor is the kind of
 * surprise that costs real work.
 *
 * Same headless harness as input_drag.test.ts: the real wasm Engine behind
 * WasmScene, with minimal Renderer/UIEngine stubs.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { InputManager } from './input';
import type { Renderer } from './renderer';
import type { PathPoint, Subpath } from './types';
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

function makeUI(): UIEngine {
    return {
        activeTool: 'pen',
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
        gradientEdit: { isActive: () => false, hitTest: () => null },
    } as unknown as UIEngine;
}

function makeInput(scene: WasmScene) {
    const canvas = document.createElement('canvas');
    return new InputManager(canvas, scene, makeUI(), makeRenderer());
}

/** A Cmd+Z / Cmd+Shift+Z keystroke aimed at the canvas. */
function undoKey(shift = false): KeyboardEvent {
    return {
        key: 'z',
        metaKey: true,
        ctrlKey: false,
        shiftKey: shift,
        altKey: false,
        target: document.createElement('canvas'),
        preventDefault() {},
        stopPropagation() {},
    } as unknown as KeyboardEvent;
}

/** An unmodified keystroke aimed at the canvas. */
function plainKey(key: string): KeyboardEvent {
    return {
        key,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target: document.createElement('canvas'),
        preventDefault() {},
        stopPropagation() {},
    } as unknown as KeyboardEvent;
}

/** Place `n` anchors along a diagonal, 50px apart. */
function placeAnchors(input: InputManager, n: number) {
    for (let i = 1; i <= n; i++) input.handlePenDown({ x: i * 50, y: i * 50 });
}

describe('pen tool — undo takes back the last anchor', () => {
    it('removes only the newest anchor, leaving the rest of the path live', () => {
        const input = makeInput(makeScene());
        placeAnchors(input, 3);

        input.onKeyDown(undoKey());

        expect(input.currentPathPoints.length).toBe(2);
        expect(input.currentPathPoints[1].x).toBeCloseTo(100, 3);
    });

    it('peels the path back to empty without touching document history', () => {
        const scene = makeScene();
        scene.engine!.add_rect(0, 0, 10, 10);
        scene.pushHistorySnapshot();
        scene.engine!.add_rect(50, 50, 10, 10); // the edit document-undo would revert

        const input = makeInput(scene);
        placeAnchors(input, 2);
        input.onKeyDown(undoKey());
        input.onKeyDown(undoKey());

        expect(input.currentPathPoints.length).toBe(0);
        // Both rects are still there: pen undo consumed both keystrokes and
        // never fell through to scene.undo().
        expect(scene.engine!.get_root_nodes().length).toBe(2);
    });

    it('falls through to document undo once the pen buffer is empty', () => {
        const scene = makeScene();
        scene.engine!.add_rect(0, 0, 10, 10);
        scene.pushHistorySnapshot();
        scene.engine!.add_rect(50, 50, 10, 10);

        const input = makeInput(scene);
        placeAnchors(input, 1);
        input.onKeyDown(undoKey()); // consumed by the pen
        input.onKeyDown(undoKey()); // reaches the document

        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('reopens a closed path before it starts removing anchors', () => {
        const input = makeInput(makeScene());
        placeAnchors(input, 3);
        input.handlePenDown({ x: 50, y: 50 }); // click the first anchor → close

        expect(input.penPathClosed).toBe(true);
        input.onKeyDown(undoKey());

        expect(input.penPathClosed).toBe(false);
        expect(input.currentPathPoints.length).toBe(3);
    });

    it('redo puts the anchor back, and a new anchor discards the redo branch', () => {
        const input = makeInput(makeScene());
        placeAnchors(input, 3);

        input.onKeyDown(undoKey());
        input.onKeyDown(undoKey(true));
        expect(input.currentPathPoints.length).toBe(3);
        expect(input.currentPathPoints[2].x).toBeCloseTo(150, 3);

        input.onKeyDown(undoKey());
        input.handlePenDown({ x: 400, y: 400 });
        input.onKeyDown(undoKey(true)); // nothing left to redo
        expect(input.currentPathPoints.length).toBe(3);
        expect(input.currentPathPoints[2].x).toBeCloseTo(400, 3);
    });
});

describe('pen tool — the in-progress path owns the keyboard', () => {
    /** A committed rect, still selected, then a pen path started on top. */
    function rectThenPen() {
        const scene = makeScene();
        const rect = scene.engine!.add_rect(0, 0, 100, 100);
        scene.engine!.select_node(rect, false);
        const input = makeInput(scene);
        placeAnchors(input, 3);
        return { scene, input, rect };
    }

    it('Delete takes back an anchor instead of deleting the selected shape', () => {
        const { scene, input } = rectThenPen();

        input.onKeyDown(plainKey('Delete'));

        expect(input.currentPathPoints.length).toBe(2);
        // The rect you drew before reaching for the pen is untouched.
        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('Backspace behaves the same as Delete', () => {
        const { scene, input } = rectThenPen();
        input.onKeyDown(plainKey('Backspace'));
        expect(input.currentPathPoints.length).toBe(2);
        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('arrows do not nudge the shape that was selected before the pen', () => {
        const { scene, input, rect } = rectThenPen();
        const before = Array.from(scene.getNodeBounds(rect));

        input.onKeyDown(plainKey('ArrowRight'));
        input.onKeyDown(plainKey('ArrowDown'));

        expect(Array.from(scene.getNodeBounds(rect))).toEqual(before);
        expect(input.currentPathPoints.length).toBe(3);
    });

    it('deleting past the first anchor stops, rather than falling through to the shape', () => {
        // Peeling a 3-anchor path back takes 3 presses; the 4th used to find an
        // empty buffer and delete the selected shape instead. With the pen up,
        // Delete never means "delete the selection".
        const { scene, input } = rectThenPen();
        for (let i = 0; i < 6; i++) input.onKeyDown(plainKey('Delete'));
        expect(input.currentPathPoints.length).toBe(0);
        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });
});

describe('pen tool — undo on a path adopted for continuation', () => {
    /** An open 2-point path, then a pen click on its free endpoint to adopt it. */
    function adoptedPath() {
        const scene = makeScene();
        const mk = (x: number, y: number): PathPoint => ({ x, y, cp1: [x, y], cp2: [x, y] });
        const subpaths: Subpath[] = [{ points: [mk(0, 0), mk(100, 0)], closed: false }];
        const id = scene.addPath(JSON.stringify(subpaths));
        const input = makeInput(scene);
        input.handlePenDown({ x: 100, y: 0 }); // lands on the free endpoint
        return { scene, input, id };
    }

    it('adopts the source path without adding an anchor', () => {
        const { input, id } = adoptedPath();
        expect(input.penSourceNodeId).toBe(id);
        expect(input.currentPathPoints.length).toBe(2);
    });

    it('undo peels back the extension, then abandons instead of eating the source path', () => {
        const { scene, input, id } = adoptedPath();
        input.handlePenDown({ x: 200, y: 0 });
        input.handlePenDown({ x: 300, y: 0 });

        input.onKeyDown(undoKey());
        input.onKeyDown(undoKey());
        expect(input.currentPathPoints.length).toBe(2);
        expect(input.penSourceNodeId).toBe(id);

        // One more: we're back at the source path's own anchors, so the session
        // ends and the node is left exactly as it was.
        input.onKeyDown(undoKey());
        expect(input.penSourceNodeId).toBe(null);
        expect(input.currentPathPoints.length).toBe(0);

        const geo = scene.getNodeGeometry(id);
        expect(geo?.Path?.subpaths[0].points.length).toBe(2);
    });
});
