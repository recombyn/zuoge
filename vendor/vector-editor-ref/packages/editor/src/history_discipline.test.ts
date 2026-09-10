/**
 * One gesture must cost exactly one undo step.
 *
 * The undo stack holds 50 states and silently drops the oldest. A gesture that
 * pushes one state per selected node therefore does not merely make undo
 * tedious — on a large selection it takes the user's real work off the bottom
 * of the stack, and every ⌘Z afterwards walks back through the gesture's own
 * intermediate states instead. Flipping and restacking a selection both did
 * this; so did the properties panel's eye, lock and opacity controls.
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

import { alignSelection, distributeSelection } from './align';

const bytes = (scene: WasmScene) => Array.from(scene.engine!.serialize_scene()).join(',');

function openSeg(e: Engine, x0: number, y0: number, x1: number, y1: number) {
    return e.add_path(
        JSON.stringify([
            {
                closed: false,
                points: [
                    { x: x0, y: y0, cp1: [x0, y0], cp2: [x0, y0] },
                    { x: x1, y: y1, cp1: [x1, y1], cp2: [x1, y1] },
                ],
            },
        ]),
    );
}
/** A grid of open strokes: many faces, no closed source shape. */
function lineArtGrid(scene: WasmScene, cells = 3, step = 100) {
    const e = scene.engine!;
    const n = cells * step;
    const ids: number[] = [];
    for (let i = 0; i <= cells; i++) {
        ids.push(openSeg(e, 0, i * step, n, i * step));
        ids.push(openSeg(e, i * step, 0, i * step, n));
    }
    ids.push(openSeg(e, 0, 0, n, n));
    ids.push(openSeg(e, 0, n, n, 0));
    const g = e.group_nodes(JSON.stringify(ids));
    e.set_node_live_paint(g, true);
    e.set_live_paint_group(g);
    return { group: g, ids };
}

// ── Seam C: history discipline — one gesture must be one undo step ──────────
const undoDepth = (scene: WasmScene) => scene.history!.undo_len();

describe('history: multi-node edits', () => {
    it('align of many nodes is one undo step', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ids = Array.from({ length: 12 }, (_, i) => e.add_rect(i * 30, i * 7, 20, 20));
        const before = undoDepth(scene);
        alignSelection(scene, ids, 'left');
        expect(undoDepth(scene) - before).toBe(1);
    });

    it('distribute of many nodes is one undo step', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ids = Array.from({ length: 12 }, (_, i) => e.add_rect(i * 40, 0, 20, 20));
        const before = undoDepth(scene);
        distributeSelection(scene, ids, 'h');
        expect(undoDepth(scene) - before).toBe(1);
    });

    it('painting many regions leaves one undo step per click, not per face', () => {
        const scene = makeScene();
        lineArtGrid(scene);
        const ui = makeUI('paint-bucket');
        const input = makeInput(scene, ui);
        const before = undoDepth(scene);
        let clicks = 0;
        for (let y = 20; y < 300; y += 100) {
            for (let x = 20; x < 300; x += 100) {
                input.onMouseDown(mouse(x, y));
                input.onMouseUp(mouse(x, y));
                clicks++;
            }
        }
        expect(undoDepth(scene) - before).toBeLessThanOrEqual(clicks);
    });

    it('a 50-deep history is not flushed by one ordinary gesture', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ids = Array.from({ length: 30 }, (_, i) => e.add_rect(i * 30, 0, 20, 20));
        // Fill the undo stack with real user steps.
        for (let i = 0; i < 40; i++) {
            scene.saveMoveHistory();
            scene.moveNodeWorld(ids[i % ids.length], 1, 0);
        }
        const depth = undoDepth(scene);
        expect(depth).toBeGreaterThan(20);
        alignSelection(scene, ids, 'top');
        // The align must cost one step, not thirty.
        expect(undoDepth(scene)).toBeLessThanOrEqual(Math.min(50, depth + 1));
    });
});

// ── Seam H: one gesture on a big selection must be one undo step ───────────
// A 50-deep history that a single gesture can overflow is how a user loses
// work they never touched: every undo afterwards walks back into the gesture's
// own intermediate states. Measured here rather than assumed.
function selectAll(scene: WasmScene, ids: number[]) {
    const e = scene.engine!;
    e.clear_selection();
    for (const id of ids) e.select_node(id, true);
}
function gestureCost(
    build: (scene: WasmScene, input: InputManager, ids: number[]) => void,
    n = 12,
    everyOther = false,
) {
    const scene = makeScene();
    const e = scene.engine!;
    const ids = Array.from({ length: n }, (_, i) => e.add_rect(i * 40, 0, 30, 30));
    const input = makeInput(scene);
    // Alternating shapes matter for the restack paths: a run whose neighbours
    // are all selected short-circuits, which hid the per-node history push.
    selectAll(scene, everyOther ? ids.filter((_, i) => i % 2 === 0) : ids);
    const before = scene.history!.undo_len();
    build(scene, input, ids);
    return scene.history!.undo_len() - before;
}

describe('history: one gesture, one undo step', () => {
    const cases: [string, (s: WasmScene, i: InputManager, ids: number[]) => void][] = [
        ['hide the selection', (_s, i) => i.toggleSelectionFlag('hidden')],
        ['lock the selection', (_s, i) => i.toggleSelectionFlag('locked')],
        ['flip the selection', (_s, i) => i.flipSelection('h')],
        // `restack` is private; the keyboard path is what a user actually hits.
        [
            'bring the selection forward',
            (_s, i) =>
                (i as unknown as { restack(d: string, a: boolean): void }).restack(
                    'forward',
                    false,
                ),
        ],
        [
            'send the selection to back',
            (_s, i) =>
                (i as unknown as { restack(d: string, a: boolean): void }).restack(
                    'backward',
                    true,
                ),
        ],
        ['toggle mask on the selection', (_s, i) => i.toggleMaskSelection()],
        ['duplicate the selection', (_s, i) => i.duplicateSelection()],
        ['delete the selection', (_s, i) => i.deleteSelection()],
        ['group the selection', (_s, i) => i.groupSelection()],
        ['apply a width profile', (_s, i) => i.applyWidthProfileToSelection('uniform' as never)],
        ['bold the selection', (_s, i) => i.toggleTextStyle('bold')],
    ];
    for (const [label, run] of cases) {
        it(`${label} costs one undo step`, () => {
            const cost = Math.max(
                gestureCost((s, i, ids) => run(s, i, ids)),
                gestureCost((s, i, ids) => run(s, i, ids), 12, true),
            );
            expect(
                cost,
                `${label} pushed ${cost} history states for 12 shapes`,
            ).toBeLessThanOrEqual(1);
        });
    }

    it('ungrouping several groups costs one undo step', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const groups: number[] = [];
        for (let g = 0; g < 6; g++) {
            const kids = [e.add_rect(g * 100, 0, 30, 30), e.add_rect(g * 100 + 40, 0, 30, 30)];
            groups.push(e.group_nodes(JSON.stringify(kids)));
        }
        const input = makeInput(scene);
        selectAll(scene, groups);
        const before = scene.history!.undo_len();
        input.ungroupSelection();
        expect(scene.history!.undo_len() - before).toBeLessThanOrEqual(1);
    });

    it('hiding a big selection does not flush a full history', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ids = Array.from({ length: 40 }, (_, i) => e.add_rect(i * 40, 0, 30, 30));
        const input = makeInput(scene);
        // 45 real user steps, so the 50-deep stack is nearly full.
        for (let i = 0; i < 45; i++) {
            scene.saveMoveHistory();
            scene.moveNodeWorld(ids[i % ids.length], 1, 0);
        }
        selectAll(scene, ids);
        // After the selection, so the comparison is about the gesture alone.
        const marker = bytes(scene);
        input.toggleSelectionFlag('hidden');
        // One undo must return to the state the gesture started from.
        scene.undo();
        expect(bytes(scene)).toBe(marker);
    });
});
