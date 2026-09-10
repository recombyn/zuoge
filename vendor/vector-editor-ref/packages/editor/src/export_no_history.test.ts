/**
 * Exporting a selection must leave the document alone.
 *
 * The PNG "export selection" path hides everything outside the selection,
 * rasterises, and puts it back. It used to do that through the undo-disciplined
 * visibility setter — one history push per node in the WHOLE document — so a
 * single export overran the 50-state undo stack: the user's real work fell off
 * the bottom of it, and ⌘Z afterwards walked back into the export's own
 * half-hidden intermediate states, with untouched artwork invisible and no way
 * to bring it back.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };
beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

/** A document with `count` shapes, the last one "selected" for export. */
function makeDoc(count = 12) {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    const ids: number[] = [];
    for (let i = 0; i < count; i++) ids.push(scene.engine.add_rect(i * 20, 0, 10, 10));
    return { scene, ids };
}

describe('export leaves no trace', () => {
    it('pushes nothing onto the undo stack', () => {
        const { scene, ids } = makeDoc();
        const before = scene.history!.undo_len();
        scene.withOnlyVisible([ids[0]], () => null);
        expect(scene.history!.undo_len(), 'history entries added by an export').toBe(before);
    });

    it('hides everything outside the selection while rendering', () => {
        const { scene, ids } = makeDoc(5);
        const seen = scene.withOnlyVisible([ids[2]], () =>
            ids.map((id) => scene.getNodeVisible(id)),
        );
        expect(seen).toEqual([false, false, true, false, false]);
    });

    it('restores every visibility flag it found, including the hidden ones', () => {
        const { scene, ids } = makeDoc(5);
        scene.setNodeVisible(ids[4], false); // the user hid this one themselves
        scene.withOnlyVisible([ids[0]], () => null);
        expect(ids.map((id) => scene.getNodeVisible(id))).toEqual([true, true, true, true, false]);
    });

    it('restores them even when the render throws', () => {
        const { scene, ids } = makeDoc(4);
        expect(() =>
            scene.withOnlyVisible([ids[0]], () => {
                throw new Error('surface unavailable');
            }),
        ).toThrow('surface unavailable');
        expect(ids.map((id) => scene.getNodeVisible(id))).toEqual([true, true, true, true]);
    });

    it('leaves ⌘Z undoing the last real edit, not the export', () => {
        // 40 real edits, then an export of a 60-node document: through the
        // history-recording setter that was 120 pushes into a 50-deep stack,
        // which is every one of the edits gone.
        const { scene, ids } = makeDoc(60);
        for (let i = 0; i < 40; i++) scene.transaction(() => scene.moveNode(ids[0], 1, 0));
        const movedTo = scene.getNodeBounds(ids[0])![0];

        scene.withOnlyVisible([ids[0]], () => null);

        scene.undo();
        expect(scene.getNodeBounds(ids[0])![0], 'one ⌘Z should undo one move').toBe(movedTo - 1);
        expect(
            [...ids].filter((id) => !scene.getNodeVisible(id)),
            'undoing after an export must not hide anything',
        ).toEqual([]);
    });
});
