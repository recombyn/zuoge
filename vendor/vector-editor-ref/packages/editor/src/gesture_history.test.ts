/**
 * Undo/gesture coalescing contracts for WasmScene.
 *
 * These are the ONE class of transform bug the Rust invariant tests can't
 * see: history is a JS-side concern (WasmScene.transaction / beginGesture /
 * endGesture / saveHistory + the History object), not engine geometry. Both
 * regressions fixed in this area lived here — the property edit that
 * double-pushed history, and label scrubbing that pushed a snapshot on every
 * pointermove frame. So we pin the coalescing contract directly.
 *
 * The tests drive the REAL WasmScene against the REAL wasm Engine + History
 * (loaded headless), only stubbing the renderer/autosave/CanvasKit that the
 * history path never touches. State equality is checked by byte-comparing
 * `serialize_scene()` — the same snapshots undo actually stores — so "exactly
 * one undo step" is provable: if a gesture pushed 0 steps, one undo would
 * overshoot the pre-gesture state; if it pushed 2, one undo would land on an
 * intermediate state instead. Only exactly-one lands byte-equal on it.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

/** A WasmScene wired to the real engine but with no renderer/autosave/persistence
 *  — exactly the surface the history code uses, nothing else. */
function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    // renderer + autosave stay null; both are null-guarded in the history path.
    return scene;
}

function snapshot(scene: WasmScene): number[] {
    return Array.from(scene.engine!.serialize_scene());
}

function expectSameState(a: number[], b: number[], msg: string) {
    expect(a.length, `${msg} (length)`).toBe(b.length);
    expect(a, msg).toEqual(b);
}

/** Read a node's rotation (degrees) straight from the engine. */
function rotationOf(scene: WasmScene, id: number): number {
    return JSON.parse(scene.engine!.get_node_transform_components(id)).rotation_deg;
}

describe('single mutation = one undo step', () => {
    it('undo restores the exact prior serialized state', () => {
        const scene = makeScene();
        const id = scene.addRect(10, 10, 100, 80); // pushes history of the empty scene
        const before = snapshot(scene);

        scene.setNodeRotation(id, 30);
        expect(rotationOf(scene, id)).toBeCloseTo(30);

        scene.undo();
        expectSameState(snapshot(scene), before, 'one undo should restore pre-rotation state');
        expect(rotationOf(scene, id)).toBeCloseTo(0);
    });
});

describe('gesture bracket coalesces N mutations into one undo step', () => {
    it('a 25-frame scrub (mixed direct + wrapper mutations) is a single step', () => {
        const scene = makeScene();
        const id = scene.addRect(0, 0, 120, 90);
        scene.setNodeRotation(id, 5); // some starting state
        const pre = snapshot(scene);

        // Emulate exactly what a label scrub does: one beginGesture, many live
        // edits with NO per-frame history, one endGesture.
        scene.beginGesture();
        for (let f = 1; f <= 25; f++) {
            scene.engine!.set_node_rotation(id, 5 + f); // direct engine call (like updateTransform(false))
            scene.moveNode(id, 1, 0); // wrapper that never pushes
            if (f % 5 === 0) scene.resizeNode(id, 120 + f, 90); // wrapper that WOULD push outside a gesture
        }
        scene.endGesture();
        const post = snapshot(scene);
        expect(post).not.toEqual(pre); // the gesture did change something

        // Exactly one step: one undo lands byte-equal on the pre-gesture state.
        scene.undo();
        expectSameState(snapshot(scene), pre, 'one undo should revert the whole scrub');

        // ...and it is reversible: redo reproduces the post-gesture state exactly.
        scene.redo();
        expectSameState(snapshot(scene), post, 'redo should reproduce the post-gesture state');
    });

    it('a stray endGesture must not wedge suppression (later edits still snapshot)', () => {
        const scene = makeScene();
        const id = scene.addRect(0, 0, 50, 50);
        scene.setNodeRotation(id, 10);
        const pre = snapshot(scene); // rotation = 10

        scene.endGesture(); // stray: no beginGesture preceded it

        // If the stray call had left suppression on, this edit would not push a
        // snapshot and the undo below would overshoot.
        scene.setNodeRotation(id, 40);
        scene.undo();
        expectSameState(
            snapshot(scene),
            pre,
            'edit after a stray endGesture must be independently undoable',
        );
        expect(rotationOf(scene, id)).toBeCloseTo(10);
    });
});

describe('transaction() coalesces wrapper calls that each self-push', () => {
    it('three history-pushing wrappers inside one transaction = one undo step', () => {
        const scene = makeScene();
        const id = scene.addRect(0, 0, 100, 100);
        const pre = snapshot(scene);

        scene.transaction(() => {
            scene.resizeNode(id, 200, 150); // each of these calls saveHistory()
            scene.setNodePosition(id, 40, 40); // internally — all must be suppressed
            scene.flipNodeH(id);
        });
        const post = snapshot(scene);
        expect(post).not.toEqual(pre);

        scene.undo();
        expectSameState(snapshot(scene), pre, 'one undo should revert all three wrapper mutations');
        scene.redo();
        expectSameState(snapshot(scene), post, 'redo should restore all three');
    });

    it('nested transaction/gesture joins the outer step (still one)', () => {
        const scene = makeScene();
        const id = scene.addRect(0, 0, 100, 100);
        const pre = snapshot(scene);

        scene.transaction(() => {
            scene.setNodeRotation(id, 15);
            scene.beginGesture(); // no-op: already inside a transaction
            scene.moveNode(id, 20, 0);
            scene.endGesture(); // must not close the outer transaction early
            scene.setNodeScale(id, 1.5, 1.5);
        });

        scene.undo();
        expectSameState(snapshot(scene), pre, 'nested brackets must collapse into one undo step');
    });
});

describe('undo/redo stack integrity across several discrete edits', () => {
    it('walks back and forward through independent steps in order', () => {
        const scene = makeScene();
        const id = scene.addRect(0, 0, 100, 100);
        const s0 = snapshot(scene);
        scene.setNodeRotation(id, 10);
        const s1 = snapshot(scene);
        scene.setNodeRotation(id, 20);
        const s2 = snapshot(scene);
        scene.setNodeRotation(id, 30);
        const s3 = snapshot(scene);

        scene.undo();
        expectSameState(snapshot(scene), s2, 'undo 1 → s2');
        scene.undo();
        expectSameState(snapshot(scene), s1, 'undo 2 → s1');
        scene.redo();
        expectSameState(snapshot(scene), s2, 'redo → s2');
        scene.undo();
        scene.undo();
        expectSameState(snapshot(scene), s0, 'two undos → s0');
        // A fresh edit here must discard the redo branch (can't redo to s3 anymore).
        scene.setNodeRotation(id, 99);
        scene.redo();
        expect(rotationOf(scene, id)).toBeCloseTo(99);
        expect(snapshot(scene)).not.toEqual(s3);
    });
});
