/**
 * Copy/paste, cut/paste and duplicate must hand back the objects stacked the
 * way they were.
 *
 * The selection is stored in the order rows were *clicked*, and the Objects
 * panel lists front-to-back — so shift-selecting a range there yields the ids
 * topmost-first. Every one of these commands re-creates its nodes one at a
 * time, appending each on top of the stack, which turns that click order into
 * the copies' z-order: paste a panel-selected range and it came back inverted.
 *
 * Same headless harness as input_keymap.test.ts: the real wasm Engine behind
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
        calculatePathBounds: () => ({ minX: 0, minY: 0, maxX: 0, maxY: 0 }),
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}

function makeUI(): UIEngine {
    return {
        activeTool: 'selection',
        toolLocked: false,
        setActiveTool() {},
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
    } as unknown as UIEngine;
}

function key(k: string, mods: { meta?: boolean; shift?: boolean } = {}): KeyboardEvent {
    return {
        key: k,
        code: `Key${k.toUpperCase()}`,
        metaKey: mods.meta ?? false,
        ctrlKey: false,
        shiftKey: mods.shift ?? false,
        altKey: false,
        target: document.createElement('canvas'),
        preventDefault() {},
        stopPropagation() {},
    } as unknown as KeyboardEvent;
}

/** Three stacked rects (bottom → top) with the selection made the way the
 *  Objects panel makes it: front-to-back, i.e. the reverse of paint order. */
function setup() {
    const scene = makeScene();
    const input = new InputManager(
        document.createElement('canvas'),
        scene,
        makeUI(),
        makeRenderer(),
    );
    const bottom = scene.engine!.add_rect(0, 0, 10, 10);
    const middle = scene.engine!.add_rect(20, 0, 10, 10);
    const top = scene.engine!.add_rect(40, 0, 10, 10);
    for (const id of [top, middle, bottom]) scene.engine!.select_node(id, true);
    return { scene, input, originals: [bottom, middle, top] };
}

/** The root ids created after the originals, in paint order. */
function newRoots(scene: WasmScene, originals: number[]): number[] {
    return Array.from(scene.engine!.get_root_nodes()).filter((id) => !originals.includes(id));
}

describe('a pasted set keeps the originals’ stacking order', () => {
    it('⌘C ⌘V pastes back-to-front, not in the order the rows were clicked', () => {
        const { scene, input, originals } = setup();

        input.onKeyDown(key('c', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        const copies = newRoots(scene, originals);
        expect(copies.length).toBe(3);
        // Copy i sits directly above copy i-1, mirroring bottom/middle/top.
        const xs = copies.map((id) => scene.getNode(id)!.transform.x);
        expect(xs).toEqual([20, 40, 60]);
    });

    it('⌘X ⌘V puts the cut objects back in their original order', () => {
        const { scene, input, originals } = setup();

        input.onKeyDown(key('x', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        const pasted = newRoots(scene, originals);
        expect(pasted.length).toBe(3);
        expect(pasted.map((id) => scene.getNode(id)!.transform.x)).toEqual([20, 40, 60]);
    });

    it('⌘D duplicates back-to-front too', () => {
        const { scene, input, originals } = setup();

        input.duplicateSelection();

        const copies = newRoots(scene, originals);
        expect(copies.length).toBe(3);
        expect(copies.map((id) => scene.getNode(id)!.transform.x)).toEqual([20, 40, 60]);
    });
});

describe('a copy stays where its original lives', () => {
    /** A group holding two rects, the first one selected — inside the group. */
    function inGroup() {
        const scene = makeScene();
        const input = new InputManager(
            document.createElement('canvas'),
            scene,
            makeUI(),
            makeRenderer(),
        );
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 10, 10);
        const b = e.add_rect(20, 0, 10, 10);
        const group = e.group_nodes(JSON.stringify([a, b]));
        e.clear_selection();
        e.select_node(a, false);
        return { scene, e, input, a, b, group };
    }

    it('⌘D on a member keeps the copy in the group, directly above it', () => {
        const { scene, e, input, a, group } = inGroup();

        input.duplicateSelection();

        const copy = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(copy)).toBe(group);
        const kids = Array.from(scene.getNodeChildren(group));
        expect(kids.indexOf(copy)).toBe(kids.indexOf(a) + 1);
    });

    it('⌘C ⌘V pastes into the group you are inside', () => {
        const { scene, e, input, group } = inGroup();

        input.onKeyDown(key('c', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        const pasted = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(pasted)).toBe(group);
    });

    it('⌘X ⌘V puts a cut member back into the group', () => {
        const { scene, e, input, a, b, group } = inGroup();
        e.clear_selection();
        e.select_node(b, false); // cut b, keep a selected as the context after

        input.onKeyDown(key('x', { meta: true }));
        e.select_node(a, false);
        input.onKeyDown(key('v', { meta: true }));

        const pasted = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(pasted)).toBe(group);
    });

    it('a top-level shape still duplicates to the root', () => {
        const scene = makeScene();
        const input = new InputManager(
            document.createElement('canvas'),
            scene,
            makeUI(),
            makeRenderer(),
        );
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 10, 10);
        e.select_node(a, false);

        input.duplicateSelection();

        expect(scene.getNodeParent(Array.from(e.get_selection())[0])).toBe(-1);
    });
});

describe('WasmScene.sortByPaintOrder', () => {
    it('orders a mixed selection by the document, nested nodes included', () => {
        const scene = makeScene();
        const a = scene.engine!.add_rect(0, 0, 10, 10);
        const b = scene.engine!.add_rect(20, 0, 10, 10);
        const c = scene.engine!.add_rect(40, 0, 10, 10);
        // Group b and c so the walk has to descend to find them.
        const group = scene.engine!.group_nodes(JSON.stringify([b, c]));

        expect(scene.sortByPaintOrder([c, a, b])).toEqual([a, b, c]);
        expect(scene.sortByPaintOrder([group, a])).toEqual([a, group]);
    });

    it('keeps ids the tree no longer holds rather than dropping them', () => {
        const scene = makeScene();
        const a = scene.engine!.add_rect(0, 0, 10, 10);
        const ghost = 9999;

        expect(scene.sortByPaintOrder([ghost, a])).toEqual([a, ghost]);
    });
});
