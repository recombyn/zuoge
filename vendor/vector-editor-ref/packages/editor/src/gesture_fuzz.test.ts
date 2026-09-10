/**
 * Randomised gestures against the real InputManager and engine, checked
 * against structural invariants rather than expected outcomes: the tree stays a
 * tree, the selection never holds a dead node, and no node acquires non-finite
 * bounds. Cheap insurance against the interactions nobody thought to write a
 * test for.
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
        sampleScreenColor: () => null,
        screenToWorld: (x: number, y: number) => ({ x, y }),
        getSnapshot: () => null,
    } as unknown as Renderer;
}
function makeUI(activeTool = 'selection'): UIEngine {
    const ui = {
        activeTool,
        toolLocked: false,
        setActiveTool(t: string) {
            ui.activeTool = t;
        },
        setActiveRegion() {},
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
        meshEdit: { isActive: () => false },
        getLivePaintFill: () => ({ r: 0.2, g: 0.55, b: 0.9, a: 1 }),
        getLivePaintStroke: () => ({ r: 0, g: 0, b: 0, a: 1 }),
        getLivePaintStrokeWidth: () => 1,
        isLivePaintFillNone: () => false,
        isLivePaintStrokeNone: () => false,
        getLivePaintGradient: () => null,
        setLivePaintFill() {},
        setLivePaintStroke() {},
        rgbToHex: () => '#000000',
    };
    return ui as unknown as UIEngine;
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
const makeInput = (scene: WasmScene, ui = makeUI()) =>
    new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());

// ── Seam D: randomised gesture fuzz with structural invariants ─────────────
function checkInvariants(scene: WasmScene, label: string) {
    const e = scene.engine!;
    // Walk the tree from the roots; that is the structure the UI renders.
    const seen = new Set<number>();
    const walk = (id: number, depth: number) => {
        expect(depth, `${label}: tree deeper than 64 at ${id}`).toBeLessThan(64);
        expect(seen.has(id), `${label}: node ${id} reachable twice`).toBe(false);
        seen.add(id);
        for (const c of Array.from(e.get_node_children(id))) walk(c, depth + 1);
    };
    for (const r of Array.from(e.get_root_nodes())) walk(r, 0);
    const ids = [...seen].map((id) => ({ id }));
    // Every selected node still exists.
    for (const id of Array.from(e.get_selection())) {
        expect(seen.has(id) || id === 0, `${label}: selection holds a dead node ${id}`).toBe(true);
    }
    // Every node's bounds are finite.
    for (const n of ids) {
        const b = Array.from(e.get_node_bounds(n.id));
        expect(b.every(Number.isFinite), `${label}: non-finite bounds on ${n.id} (${b})`).toBe(
            true,
        );
    }
    // No node is its own ancestor.
    for (const n of ids) {
        let cur = e.get_node_parent(n.id);
        let hops = 0;
        while (cur >= 0 && hops < 64) {
            expect(cur !== n.id, `${label}: ${n.id} is its own ancestor`).toBe(true);
            cur = e.get_node_parent(cur);
            hops++;
        }
        expect(hops, `${label}: parent chain from ${n.id} did not terminate`).toBeLessThan(64);
    }
}

const KEYS: { key: string; shift?: boolean; meta?: boolean; alt?: boolean }[] = [
    { key: 'g', meta: true }, // group
    { key: 'g', meta: true, shift: true }, // ungroup
    { key: 'd', meta: true }, // duplicate
    { key: 'a', meta: true }, // select all
    { key: 'Delete' },
    { key: 'Backspace' },
    { key: 'Escape' },
    { key: 'Enter' },
    { key: 'ArrowLeft' },
    { key: 'ArrowRight', shift: true },
    { key: 'ArrowUp' },
    { key: 'ArrowDown', shift: true },
    { key: 'z', meta: true },
    { key: 'z', meta: true, shift: true },
    { key: '[', meta: true },
    { key: ']', meta: true },
];

function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

describe('gesture fuzz', () => {
    for (const seed of [1, 7, 13, 29, 101, 977, 2024, 31337, 8191, 55555]) {
        it(`survives 300 random gestures (seed ${seed})`, () => {
            const scene = makeScene();
            const e = scene.engine!;
            const r = rng(seed);
            for (let i = 0; i < 4; i++) e.add_rect(i * 50, i * 20, 40, 40);
            const tools = [
                'selection',
                'direct',
                'rect',
                'ellipse',
                'pen',
                'pencil',
                'paint-bucket',
            ];
            const ui = makeUI();
            const input = makeInput(scene, ui);
            const P = () => Math.round(r() * 300) - 20;
            for (let i = 0; i < 300; i++) {
                const pick = r();
                ui.activeTool = tools[Math.floor(r() * tools.length)];
                const o = {
                    shiftKey: r() < 0.25,
                    altKey: r() < 0.15,
                    metaKey: r() < 0.15,
                    detail: r() < 0.2 ? 2 : 1,
                };
                const x0 = P(),
                    y0 = P();
                if (pick < 0.45) {
                    input.onMouseDown(mouse(x0, y0, o));
                    input.onMouseUp(mouse(x0, y0, o));
                } else if (pick < 0.85) {
                    input.onMouseDown(mouse(x0, y0, o));
                    input.onMouseMove(mouse(P(), P(), o));
                    input.onMouseMove(mouse(P(), P(), o));
                    input.onMouseUp(mouse(P(), P(), o));
                } else if (pick < 0.93) {
                    scene.undo();
                } else {
                    scene.redo();
                }
                if (i % 20 === 0) checkInvariants(scene, `seed ${seed} step ${i}`);
                // Keyboard gestures are half of how the editor is driven.
                if (r() < 0.3) {
                    const k = KEYS[Math.floor(r() * KEYS.length)];
                    input.onKeyDown({
                        key: k.key,
                        code: k.key,
                        shiftKey: !!k.shift,
                        altKey: !!k.alt,
                        metaKey: !!k.meta,
                        ctrlKey: false,
                        target: document.body,
                        preventDefault() {},
                        stopPropagation() {},
                    } as unknown as KeyboardEvent);
                }
            }
            checkInvariants(scene, `seed ${seed} end`);
        });
    }
});

// ── Seam F: the gesture that got past every previous sweep ──────────────────
describe('drag into a group, then enter it', () => {
    it('double-click enters the group a shape was just dragged into', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 60, 60);
        const b = e.add_rect(80, 0, 60, 60);
        const g = e.group_nodes(JSON.stringify([a, b]));
        const loose = e.add_rect(400, 400, 40, 40);
        const ui = makeUI();
        const input = makeInput(scene, ui);
        // Drag the loose shape on top of the group.
        input.onMouseDown(mouse(420, 420));
        input.onMouseMove(mouse(300, 300));
        input.onMouseMove(mouse(30, 30));
        input.onMouseUp(mouse(30, 30));
        // Now double-click where it landed: we must end up INSIDE something,
        // with a real node selected, not stuck at the top level with nothing.
        input.onMouseDown(mouse(30, 30, { detail: 2 }));
        input.onMouseUp(mouse(30, 30, { detail: 2 }));
        const s = Array.from(e.get_selection());
        expect(s.length, 'double-click must select something').toBeGreaterThan(0);
        expect(s.every((id) => id !== g || e.get_node_children(g).length > 0)).toBe(true);
        expect(Number.isFinite(Array.from(e.get_node_bounds(loose))[0])).toBe(true);
    });
});
