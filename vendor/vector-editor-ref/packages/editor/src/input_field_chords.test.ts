/**
 * Typing in a panel field belongs to the field — but ⌘/Ctrl chords are
 * application commands, not text. They used to be swallowed wholesale, so
 * tweaking a stroke width and reflexively pressing ⌘Z did nothing at all until
 * you clicked away. The four chords a text field genuinely owns (select-all,
 * copy, paste, cut) must still reach the field.
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
    } as unknown as Renderer;
}

function makeUI(): UIEngine {
    return {
        activeTool: 'selection',
        setActiveTool(t: string) {
            (this as { activeTool: string }).activeTool = t;
        },
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

function makeInput(scene: WasmScene, ui: UIEngine = makeUI()) {
    const canvas = document.createElement('canvas');
    return { input: new InputManager(canvas, scene, ui, makeRenderer()), ui };
}

/** A keystroke whose target is a focused panel field. */
function fieldKey(key: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent {
    const target = document.createElement('input');
    target.type = 'number';
    return {
        key,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        target,
        preventDefault() {},
        stopPropagation() {},
        ...opts,
    } as unknown as KeyboardEvent;
}

describe('shortcuts while a panel field has focus', () => {
    it('⌘Z reaches document undo instead of dying in the field', () => {
        const scene = makeScene();
        scene.engine!.add_rect(0, 0, 10, 10);
        scene.pushHistorySnapshot();
        scene.engine!.add_rect(50, 50, 10, 10);
        expect(scene.engine!.get_root_nodes().length).toBe(2);

        const { input } = makeInput(scene);
        input.onKeyDown(fieldKey('z', { metaKey: true }));

        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('⌘A stays the field’s own select-all', () => {
        const scene = makeScene();
        scene.engine!.add_rect(0, 0, 10, 10);
        scene.engine!.add_rect(50, 50, 10, 10);
        scene.engine!.clear_selection();

        const { input } = makeInput(scene);
        input.onKeyDown(fieldKey('a', { metaKey: true }));

        // Canvas select-all would have grabbed both nodes.
        expect(Array.from(scene.engine!.get_selection()).length).toBe(0);
    });

    it('plain letters stay text and never switch tools', () => {
        const { input, ui } = makeInput(makeScene());
        input.onKeyDown(fieldKey('r'));
        input.onKeyDown(fieldKey('p'));
        expect(ui.activeTool).toBe('selection');
    });

    it('Escape hands the keyboard back to the canvas', () => {
        const { input } = makeInput(makeScene());
        const field = document.createElement('input');
        field.type = 'number';
        document.body.appendChild(field);
        field.focus();
        expect(document.activeElement).toBe(field);

        input.onKeyDown({
            key: 'Escape',
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            target: field,
            preventDefault() {},
            stopPropagation() {},
        } as unknown as KeyboardEvent);

        expect(document.activeElement).not.toBe(field);
    });

    it('Delete edits the value, it does not delete the selection', () => {
        const scene = makeScene();
        const id = scene.engine!.add_rect(0, 0, 10, 10);
        scene.engine!.select_node(id, false);

        const { input } = makeInput(scene);
        input.onKeyDown(fieldKey('Delete'));
        input.onKeyDown(fieldKey('Backspace'));

        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });
});
