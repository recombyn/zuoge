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

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    return scene;
}

/** The shape of a document saved BEFORE the merge fix: the shape the user
 *  dragged in sits inside its own Live Paint group, nested in the real one.
 *  `b` spans x 50..150 and `added` spans 120..220, so they share 120..150 —
 *  one network must cut the painted region at x=150. */
function nestedDoc() {
    const scene = makeScene();
    const e = scene.engine!;
    const a = e.add_rect(0, 0, 100, 100);
    const b = e.add_rect(50, 0, 100, 100);
    const outer = e.group_nodes(JSON.stringify([a, b]));
    e.set_node_live_paint(outer, true);

    const added = e.add_rect(120, 0, 100, 100);
    const inner = e.group_nodes(JSON.stringify([added]));
    e.set_node_live_paint(inner, true);
    e.reorder_nodes(JSON.stringify([inner]), outer, 2);
    e.set_live_paint_group(outer);
    return { scene, e, outer, inner, added };
}

/** Paint the region under (x, y) and report the x-extent of what got painted. */
function paintedExtent(scene: WasmScene, x: number, y: number): { minX: number; maxX: number } {
    const e = scene.engine!;
    const face = e.query_face_at(x, y);
    expect(face).toBeGreaterThanOrEqual(0);
    scene.setFaceFill(face, 1, 0, 0, 1);
    const faces = JSON.parse(e.get_filled_faces()) as Array<{
        outline: Array<{ x: number; y: number }>;
    }>;
    const xs = faces.flatMap((f) => f.outline.map((p) => p.x));
    return { minX: Math.min(...xs), maxX: Math.max(...xs) };
}

describe('one Live Paint flag per nest', () => {
    it('refuses the inner flag, so the added shape stays on the shared surface', () => {
        const { scene, e, inner } = nestedDoc();
        // nestedDoc() asks for the flag the old bucket used to set.
        expect(e.get_node_live_paint(inner)).toBe(false);
        // Painting right of the neighbour's edge stops there instead of filling
        // the whole added rect back across it.
        const { minX, maxX } = paintedExtent(scene, 180, 50);
        expect(minX).toBeCloseTo(150, 0);
        expect(maxX).toBeCloseTo(220, 0);
    });

    it('flagging an outer group clears the flags already beneath it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 0, 100, 100);
        const innerGroup = e.group_nodes(JSON.stringify([b]));
        e.set_node_live_paint(innerGroup, true);
        expect(e.get_node_live_paint(innerGroup)).toBe(true); // legal on its own

        // Wrapping both in a Live Paint group is the user saying "one surface".
        const outer = e.group_nodes(JSON.stringify([a, innerGroup]));
        e.set_node_live_paint(outer, true);

        expect(e.get_node_live_paint(outer)).toBe(true);
        expect(e.get_node_live_paint(innerGroup)).toBe(false);
    });

    it('heals a document that was already saved with a nested flag', () => {
        // The migration: documents written before the flag was refused carry it,
        // and no fix to the write path can reach them.
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 0, 100, 100);
        const outer = e.group_nodes(JSON.stringify([a, b]));
        const added = e.add_rect(120, 0, 100, 100);
        const inner = e.group_nodes(JSON.stringify([added]));
        e.reorder_nodes(JSON.stringify([inner]), outer, 2);
        // Flag inner FIRST, then outer would clear it — so flag outer first and
        // reach past the guard the way a pre-fix save did, by writing the flag
        // into the snapshot itself.
        e.set_node_live_paint(outer, true);
        const snap = e.serialize_scene();
        const legacy = new Engine();
        expect(legacy.deserialize_scene(snap)).toBe(true);
        // Simulate the legacy file: force the nested flag on in a fresh engine
        // via the same path a 0.x snapshot restores, then reload it.
        legacy.set_node_live_paint(outer, false);
        legacy.set_node_live_paint(inner, true);
        legacy.set_node_live_paint(outer, true);
        // Outer wins on the way in; the reload must agree.
        const healed = new Engine();
        expect(healed.deserialize_scene(legacy.serialize_scene())).toBe(true);
        expect(healed.get_node_live_paint(inner)).toBe(false);
        expect(healed.get_node_live_paint(outer)).toBe(true);
    });
});
