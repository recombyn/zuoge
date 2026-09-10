/**
 * Gradient handles on a Live Paint region.
 *
 * The controller was built for node fills; a face differs in only three ways
 * (where the gradient is read, what transform relates it to the world, where it
 * is written), so these tests pin that the shared machinery — hit-testing,
 * dragging, endpoints — behaves for a face too.
 *
 * The one that matters most is the anchor: face ids are regenerated on every
 * network rebuild, and painting a region triggers one, so a stored id is stale
 * before the handles are first drawn.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { GradientEditController } from './gradient_edit';
import type { Gradient } from './types';
import { WasmScene } from './wasm_scene';

let wasmModule: { memory: WebAssembly.Memory };

beforeAll(async () => {
    wasmModule = await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

const GRADIENT: Gradient = {
    gradient_type: 'Linear',
    stops: [
        { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
        { offset: 1, color: { r: 0, g: 1, b: 0, a: 1 } },
    ],
    start_x: 100,
    start_y: 200,
    end_x: 400,
    end_y: 200,
};

/** A Live Paint group over one rect, its single region painted with GRADIENT. */
function paintedRegion() {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;

    const rect = scene.engine.add_rect(100, 100, 300, 200);
    const group = scene.groupNodes([rect]);
    scene.setNodeLivePaint(group, true);
    scene.setLivePaintGroup(group);

    const faceId = scene.queryFaceAt(250, 200);
    expect(faceId).toBeGreaterThanOrEqual(0);
    scene.setFacePaint(faceId, GRADIENT);

    const ge = new GradientEditController(scene);
    return { scene, ge, inside: { x: 250, y: 200 } };
}

describe('gradient handles on a Live Paint region', () => {
    it('activates on the region under a point', () => {
        const { ge, inside } = paintedRegion();

        ge.activateFace(inside);

        expect(ge.isActive()).toBe(true);
        expect(ge.nodeId).toBeNull();
        expect(ge.endpoints(ge.gradient()!)).toEqual({
            p0: { x: 100, y: 200 },
            p1: { x: 400, y: 200 },
        });
    });

    it('declines a region with no gradient', () => {
        const { scene, ge } = paintedRegion();
        const faceId = scene.queryFaceAt(250, 200);
        scene.setFaceFill(faceId, 1, 0, 0, 1); // solid

        ge.activateFace({ x: 250, y: 200 });

        expect(ge.isActive()).toBe(false);
        expect(ge.faceAnchor).toBeNull();
    });

    it('a face outline is already world space, so handles need no transform', () => {
        const { ge, inside } = paintedRegion();
        ge.activateFace(inside);

        // Endpoints round-trip unchanged: local IS world for a region.
        expect(ge.localToWorld(400, 200)).toEqual({ x: 400, y: 200 });
        expect(ge.worldToLocal(400, 200)).toEqual({ x: 400, y: 200 });
    });

    it('hit-tests the end handle and moves it', () => {
        const { scene, ge, inside } = paintedRegion();
        ge.activateFace(inside);

        const hit = ge.hitTest({ x: 400, y: 200 }, 1);
        expect(hit).toEqual({ type: 'end' });

        ge.beginDrag(hit!, { x: 400, y: 200 });
        ge.moveDrag({ x: 250, y: 290 }, false);
        ge.endDrag();

        expect(ge.endpoints(ge.gradient()!).p1).toEqual({ x: 250, y: 290 });
        // ...and it reached the engine, not just the controller's copy.
        const paint = scene.getFacePaint(scene.queryFaceAt(250, 200)) as Gradient;
        expect([paint.end_x, paint.end_y]).toEqual([250, 290]);
    });

    it('survives the face ids being renumbered', () => {
        // THE trap: a rebuild regenerates every face id, and painting causes
        // one. Anchoring to a point rather than an id is what makes the handles
        // outlive the rebuild they themselves trigger.
        const { scene, ge, inside } = paintedRegion();
        ge.activateFace(inside);
        const idBefore = ge.faceId;

        // Force a rebuild by adding another shape to the group.
        const extra = scene.engine!.add_rect(500, 500, 40, 40);
        scene.engine!.set_parent(extra, scene.getRootNodes()[0]);
        scene.invalidateCache();
        scene.queryFaceAt(0, 0); // drives ensure_network_clean

        expect(ge.isActive()).toBe(true);
        expect(ge.endpoints(ge.gradient()!).p1).toEqual({ x: 400, y: 200 });
        expect(idBefore).not.toBeNull();
    });

    it('deactivates when the region stops existing', () => {
        const { scene, ge, inside } = paintedRegion();
        ge.activateFace(inside);
        expect(ge.isActive()).toBe(true);

        scene.removeNodes(scene.getRootNodes());

        expect(ge.faceId).toBeNull();
        expect(ge.isActive()).toBe(false);
    });

    it('the selection reconcile leaves a region target alone', () => {
        // Painting deliberately clears the selection, so reconciling a face
        // against it used to wipe the handles the instant anything synced.
        const { scene, ge, inside } = paintedRegion();
        ge.activateFace(inside);
        scene.engine!.clear_selection();

        ge.syncSelection();

        expect(ge.isActive()).toBe(true);
    });
});
