/**
 * Mode-specific key routing: the same key must mean exactly one thing in a
 * given mode, and the pen's buffer must never outlive the pen.
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

/** Renderer stub that records zoom requests so we can assert they didn't happen. */
function makeRenderer() {
    const zoomCalls: number[] = [];
    const renderer = {
        zoom: 1,
        pan: { x: 0, y: 0 },
        dpr: 1,
        setZoomCentered(z: number) {
            zoomCalls.push(z);
            (this as { zoom: number }).zoom = z;
        },
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
    };
    return { renderer: renderer as unknown as Renderer, zoomCalls };
}

function makeUI(): UIEngine {
    return {
        activeTool: 'selection',
        setActiveTool(t: string) {
            (this as { activeTool: string }).activeTool = t;
        },
        setZoom() {},
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
        // The bucket asks whether it is loaded with None on every hover, so a
        // stub that lacks these throws inside the hover path.
        isLivePaintFillNone: () => false,
        isLivePaintStrokeNone: () => false,
        getLivePaintStrokeWidth: () => 2,
        // Recorded rather than performed — the interesting logic is on the input
        // side (which digits mean what), not in the panel write-through.
        opacityCalls: [] as number[],
        setSelectionOpacity(v: number) {
            (this as { opacityCalls: number[] }).opacityCalls.push(v);
        },
        chromeToggles: 0,
        toggleChrome() {
            (this as { chromeToggles: number }).chromeToggles++;
            return true;
        },
        renameCalls: 0,
        renameSelectedLayer() {
            (this as { renameCalls: number }).renameCalls++;
            return true;
        },
    } as unknown as UIEngine;
}

/** `code` defaults to the physical key that produces `k` on a US layout, which
 *  is what the ⌥-chords match on — macOS turns ⌥a into "å" in `key`. */
function key(
    k: string,
    mods: { meta?: boolean; shift?: boolean; alt?: boolean; code?: string } = {},
): KeyboardEvent {
    const code =
        mods.code ??
        (/^[a-zA-Z]$/.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k);
    return {
        key: k,
        code,
        metaKey: mods.meta ?? false,
        ctrlKey: false,
        shiftKey: mods.shift ?? false,
        altKey: mods.alt ?? false,
        target: document.createElement('canvas'),
        preventDefault() {},
        stopPropagation() {},
    } as unknown as KeyboardEvent;
}

const TRIANGLE = JSON.stringify([
    {
        points: [
            { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
            { x: 100, y: 0, cp1: [100, 0], cp2: [100, 0] },
            { x: 100, y: 100, cp1: [100, 100], cp2: [100, 100] },
        ],
        closed: false,
    },
]);

describe('one key, one meaning per mode', () => {
    function setup() {
        const scene = makeScene();
        const { renderer, zoomCalls } = makeRenderer();
        const ui = makeUI();
        const input = new InputManager(document.createElement('canvas'), scene, ui, renderer);
        return { scene, input, ui, renderer, zoomCalls };
    }

    it('“+” zooms when no path is being edited', () => {
        const { input, zoomCalls } = setup();
        const before = input.addPointMode;

        input.onKeyDown(key('+'));

        expect(zoomCalls.length).toBe(1);
        expect(input.addPointMode).toBe(before);
    });

    it('“+” toggles Add Point while editing a path, and does NOT also zoom', () => {
        // It used to do both: the zoom handler didn't return, so one press
        // fired two unrelated commands.
        const { scene, input, zoomCalls } = setup();
        const id = scene.addPath(TRIANGLE);
        input.editingNodeId = id;
        const before = input.addPointMode;

        input.onKeyDown(key('+'));

        expect(input.addPointMode).toBe(!before);
        expect(zoomCalls).toEqual([]);
    });

    it('“-” still zooms out while editing a path', () => {
        const { scene, input, zoomCalls } = setup();
        input.editingNodeId = scene.addPath(TRIANGLE);

        input.onKeyDown(key('-'));

        expect(zoomCalls.length).toBe(1);
    });
});

describe('the pen buffer never outlives the pen', () => {
    function penWithAnchors(n: number) {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const ui = makeUI();
        const input = new InputManager(document.createElement('canvas'), scene, ui, renderer);
        for (let i = 1; i <= n; i++) input.handlePenDown({ x: i * 50, y: i * 50 });
        return { scene, input, ui };
    }

    it('committing turns the anchors into a path and empties the buffer', () => {
        const { scene, input } = penWithAnchors(3);

        input.finalizePenPath();

        expect(input.currentPathPoints.length).toBe(0);
        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('committing twice does not produce two paths', () => {
        // finalizePenPath flips the tool back to Selection, and setActiveTool
        // commits an in-progress path — without the reentrancy guard the two
        // call each other.
        const { scene, input } = penWithAnchors(3);

        input.finalizePenPath();
        input.finalizePenPath();

        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });

    it('a lone anchor is dropped rather than committed as a degenerate path', () => {
        const { scene, input } = penWithAnchors(1);

        input.finalizePenPath();

        expect(input.currentPathPoints.length).toBe(0);
        expect(scene.engine!.get_root_nodes().length).toBe(0);
    });
});

describe('a stale node id is reported, not thrown', () => {
    it('getNodeStyle and getNodeGeometry return null for a node that is gone', () => {
        const scene = makeScene();
        const id = scene.engine!.add_rect(0, 0, 10, 10);
        expect(scene.getNodeStyle(id)).not.toBeNull();
        expect(scene.getNodeGeometry(id)).not.toBeNull();

        scene.engine!.remove_node(id);

        // Previously: SyntaxError: Unexpected end of JSON input, several frames
        // from the real cause.
        expect(scene.getNodeStyle(id)).toBeNull();
        expect(scene.getNodeGeometry(id)).toBeNull();
    });

    it('reports the same for an id that never existed', () => {
        const scene = makeScene();
        expect(scene.getNodeStyle(9999)).toBeNull();
        expect(scene.getNodeGeometry(9999)).toBeNull();
    });
});

describe('paste puts the copy where you asked for it', () => {
    /** A rect at (40,60), copied and ready to paste. */
    function copiedRect() {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const input = new InputManager(document.createElement('canvas'), scene, makeUI(), renderer);
        const id = scene.engine!.add_rect(40, 60, 10, 10);
        scene.selectNode(id, false);
        input.onKeyDown(key('c', { meta: true }));
        return { scene, input, id };
    }

    /** Top-left of the one node that isn't the original. */
    function pastedOrigin(scene: WasmScene, originalId: number) {
        const pasted = scene.engine!.get_root_nodes().filter((n) => n !== originalId);
        expect(pasted.length).toBe(1);
        const b = scene.getNodeBounds(pasted[0]);
        return { x: b[0], y: b[1] };
    }

    it('⌘V offsets the copy so it is visible beside the original', () => {
        const { scene, input, id } = copiedRect();

        input.onKeyDown(key('v', { meta: true }));

        expect(pastedOrigin(scene, id)).toEqual({ x: 60, y: 80 });
    });

    it('⇧⌘V pastes in place — exactly on top of what was copied', () => {
        const { scene, input, id } = copiedRect();

        // macOS reports the shifted letter, so the handler must accept 'V' too.
        input.onKeyDown(key('V', { meta: true, shift: true }));

        expect(pastedOrigin(scene, id)).toEqual({ x: 40, y: 60 });
    });

    it('⇧⌘V does not also flip the selection', () => {
        // ⇧V alone is Flip Vertical; with ⌘ held it must be paste and nothing else.
        const { scene, input, id } = copiedRect();

        input.onKeyDown(key('V', { meta: true, shift: true }));

        const b = scene.getNodeBounds(id);
        expect({ x: b[0], y: b[1] }).toEqual({ x: 40, y: 60 });
    });

    it('pasting after the original is deleted adds nothing', () => {
        // The clipboard is a list of live ids. `duplicate_node` answers a missing
        // one with a fresh EMPTY node, so paste used to leave an invisible row
        // in the layer list.
        const { scene, input, id } = copiedRect();
        scene.engine!.remove_node(id);

        input.onKeyDown(key('v', { meta: true }));

        expect(Array.from(scene.engine!.get_root_nodes())).toEqual([]);
    });
});

describe('cut keeps what it removes', () => {
    function setup() {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const ui = makeUI();
        const input = new InputManager(document.createElement('canvas'), scene, ui, renderer);
        return { scene, input, ui };
    }

    it('⌘X takes it out of the document, ⇧⌘V puts it back where it was', () => {
        const { scene, input } = setup();
        const id = scene.engine!.add_rect(40, 60, 10, 10);
        scene.selectNode(id, false);

        input.onKeyDown(key('x', { meta: true }));
        expect(Array.from(scene.engine!.get_root_nodes())).toEqual([]);

        input.onKeyDown(key('V', { meta: true, shift: true }));
        const roots = Array.from(scene.engine!.get_root_nodes());
        expect(roots.length).toBe(1);
        const b = scene.getNodeBounds(roots[0]);
        expect({ x: b[0], y: b[1] }).toEqual({ x: 40, y: 60 });
    });

    it('the clipboard is not consumed — a second paste gives a second copy', () => {
        const { scene, input } = setup();
        scene.selectNode(scene.engine!.add_rect(0, 0, 10, 10), false);

        input.onKeyDown(key('x', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        expect(scene.engine!.get_root_nodes().length).toBe(2);
    });

    it('a plain ⌘C after a cut goes back to copying', () => {
        const { scene, input } = setup();
        scene.selectNode(scene.engine!.add_rect(0, 0, 10, 10), false);
        input.onKeyDown(key('x', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        const pasted = Array.from(scene.engine!.get_root_nodes());
        scene.selectNode(pasted[0], false);
        input.onKeyDown(key('c', { meta: true }));
        input.onKeyDown(key('v', { meta: true }));

        expect(scene.engine!.get_root_nodes().length).toBe(2);
    });
});

describe('the keys that had no keys', () => {
    function setup(n = 1) {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const ui = makeUI();
        const input = new InputManager(document.createElement('canvas'), scene, ui, renderer);
        const ids: number[] = [];
        for (let i = 0; i < n; i++) {
            const id = scene.engine!.add_rect(i * 100, i * 50, 40, 40);
            ids.push(id);
            scene.selectNode(id, i > 0);
        }
        return { scene, input, ui: ui as unknown as Record<string, unknown>, ids };
    }

    it('a digit sets opacity, and two digits in a row read as one number', () => {
        const { input, ui } = setup();

        input.onKeyDown(key('4'));
        input.onKeyDown(key('5'));

        // 4 → 40%, then "45" replaces it rather than reading as a second key.
        expect(ui.opacityCalls).toEqual([0.4, 0.45]);
    });

    it('0 alone is 100%, not 0%', () => {
        const { input, ui } = setup();
        input.onKeyDown(key('0'));
        expect(ui.opacityCalls).toEqual([1]);
    });

    it('⇧⌘L locks, and pressing it again unlocks', () => {
        const { scene, input, ids } = setup();

        input.onKeyDown(key('L', { meta: true, shift: true }));
        expect(scene.getNodeLocked(ids[0])).toBe(true);

        input.onKeyDown(key('L', { meta: true, shift: true }));
        expect(scene.getNodeLocked(ids[0])).toBe(false);
    });

    it('⇧⌘H hides, and pressing it again shows', () => {
        const { scene, input, ids } = setup();

        input.onKeyDown(key('H', { meta: true, shift: true }));
        expect(scene.getNodeVisible(ids[0])).toBe(false);

        input.onKeyDown(key('H', { meta: true, shift: true }));
        expect(scene.getNodeVisible(ids[0])).toBe(true);
    });

    it('⇧⌘A deselects', () => {
        const { scene, input } = setup(2);
        expect(scene.engine!.get_selection().length).toBe(2);

        input.onKeyDown(key('A', { meta: true, shift: true }));

        expect(scene.engine!.get_selection().length).toBe(0);
    });

    it('⌥A aligns left, matching on the physical key rather than "å"', () => {
        const { scene, input, ids } = setup(2);

        // macOS reports ⌥a as "å"; the handler must still see KeyA.
        input.onKeyDown(key('å', { alt: true, code: 'KeyA' }));

        const a = scene.getNodeBounds(ids[0]);
        const b = scene.getNodeBounds(ids[1]);
        expect(b[0]).toBeCloseTo(a[0]);
    });

    it('⌥← stays a nudge when the selection is not text', () => {
        const { scene, input, ids } = setup();
        const before = scene.getNodeBounds(ids[0])[0];

        input.onKeyDown(key('ArrowLeft', { alt: true }));

        expect(scene.getNodeBounds(ids[0])[0]).toBeCloseTo(before - 1);
    });

    it('⌘\\ and Tab both hide the panels', () => {
        const { input, ui } = setup();

        input.onKeyDown(key('\\', { meta: true, code: 'Backslash' }));
        input.onKeyDown(key('Tab'));

        expect(ui.chromeToggles).toBe(2);
    });

    it('F2 renames the selected layer', () => {
        const { input, ui } = setup();
        input.onKeyDown(key('F2'));
        expect(ui.renameCalls).toBe(1);
    });
});

describe('the Live Paint bucket shows what ⌥ is about to do', () => {
    /** A Live Paint group with one fillable region, bucket armed. */
    function painting() {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const ui = makeUI();
        const canvas = document.createElement('canvas');
        const input = new InputManager(canvas, scene, ui, renderer);
        const a = scene.engine!.add_rect(0, 0, 200, 200);
        const b = scene.engine!.add_ellipse(200, 200, 80, 80);
        const group = scene.groupNodes([a, b]);
        scene.setNodeLivePaint(group, true);
        scene.setLivePaintGroup(group);
        ui.activeTool = 'paint-bucket';
        input.currentPos = { x: 60, y: 60 }; // inside the rect's region
        return { scene, input, ui, renderer, canvas };
    }

    const isEyedropper = (canvas: HTMLCanvasElement) => canvas.style.cursor.startsWith('url(');

    it('⌥ turns the cursor into an eyedropper', () => {
        const { input, canvas } = painting();

        input.updatePaintBucketHover(false, false);
        expect(isEyedropper(canvas)).toBe(false);

        input.updatePaintBucketHover(true, false);
        expect(isEyedropper(canvas)).toBe(true);
    });

    it('⌥ clears the fill highlight — it is not about to fill anything', () => {
        // The blue region tint promises a fill. Leaving it up under ⌥ was the
        // whole reason the eyedropper was invisible: the hover still described
        // the old meaning of ⌥ (edge mode).
        const { input, renderer } = painting();

        input.updatePaintBucketHover(false, false);
        expect(renderer.hoverFaceId).toBeGreaterThanOrEqual(0);

        input.updatePaintBucketHover(true, false);
        expect(renderer.hoverFaceId).toBe(-1);
        expect(renderer.hoverEdgeId).toBe(-1);
    });

    it('⇧ — not ⌥ — is what previews an edge now', () => {
        const { input, renderer } = painting();

        input.updatePaintBucketHover(false, true);
        expect(renderer.hoverFaceId).toBe(-1); // shift means edge, not fill

        input.updatePaintBucketHover(true, false);
        expect(renderer.hoverEdgeId).toBe(-1); // alt means neither
    });

    it('pressing ⌥ with the mouse still updates the cursor immediately', () => {
        // The user holds ⌥ without moving. A hover that only refreshes on
        // mousemove leaves the cursor lying about what a click will do.
        const { input, canvas } = painting();
        input.updatePaintBucketHover(false, false);

        input.onKeyDown(key('Alt', { alt: true }));
        expect(isEyedropper(canvas)).toBe(true);

        input.onKeyUp(key('Alt'));
        expect(isEyedropper(canvas)).toBe(false);
    });

    /** The erase cursor is the only one carrying the strike-through red. */
    const isErase = (canvas: HTMLCanvasElement) => canvas.style.cursor.includes('e5484d');

    it('⌘ shows that the click will erase, not paint', () => {
        const { input, canvas } = painting();

        input.updatePaintBucketHover(false, false);
        expect(isErase(canvas)).toBe(false);

        input.updatePaintBucketHover(false, false, true);
        expect(isErase(canvas)).toBe(true);
    });

    it('⌘ keeps the region highlighted — you still need to see WHICH one empties', () => {
        // Unlike ⌥ (which targets nothing), the eraser acts on the region under
        // the cursor, so dropping the highlight would hide the target.
        const { input, renderer } = painting();

        input.updatePaintBucketHover(false, false, true);
        expect(renderer.hoverFaceId).toBeGreaterThanOrEqual(0);
    });

    it('pressing ⌘ with the mouse still updates the cursor immediately', () => {
        const { input, canvas } = painting();
        input.updatePaintBucketHover(false, false);

        input.onKeyDown(key('Meta', { meta: true }));
        expect(isErase(canvas)).toBe(true);

        input.onKeyUp(key('Meta'));
        expect(isErase(canvas)).toBe(false);
    });

    it('a bucket loaded with None reads as erasing without any modifier', () => {
        // None is a property, ⌘ a one-off; both remove, so both must look like
        // it. Otherwise the swatch says one thing and the cursor another.
        const { input, ui, canvas } = painting();
        (ui as { isLivePaintFillNone: () => boolean }).isLivePaintFillNone = () => true;

        input.updatePaintBucketHover(false, false);
        expect(isErase(canvas)).toBe(true);
    });
});

describe('the Selection tool shows which node a modifier will take', () => {
    /** Two shapes inside a group, Selection tool armed, cursor over one shape. */
    function selecting() {
        const scene = makeScene();
        const { renderer } = makeRenderer();
        const ui = makeUI();
        const canvas = document.createElement('canvas');
        const input = new InputManager(canvas, scene, ui, renderer);
        const a = scene.engine!.add_rect(0, 0, 200, 200);
        const b = scene.engine!.add_rect(400, 0, 100, 100);
        const group = scene.groupNodes([a, b]);
        ui.activeTool = 'selection';
        input.currentPos = { x: 60, y: 60 }; // inside shape `a`
        return { scene, input, canvas, a, group };
    }

    it('⌘ highlights the shape a ⌘-click would actually select, not the group', () => {
        // The hover used to hit-test WITHOUT the deep flag while the click used
        // it, so the highlight named the group and the click took the child.
        const { input, a, group } = selecting();

        input.updateSelectionHover(false, false);
        expect(input.hoverNodeId).toBe(group);

        input.updateSelectionHover(false, true);
        expect(input.hoverNodeId).toBe(a);
    });

    it('each modifier gets its own cursor, because each does something different', () => {
        const { input, canvas } = selecting();

        input.updateSelectionHover(false, false);
        expect(canvas.style.cursor).toBe('move');

        input.updateSelectionHover(true, false); // ⌥ duplicates
        expect(canvas.style.cursor).toBe('copy');

        input.updateSelectionHover(false, true); // ⌘ reaches inside
        expect(canvas.style.cursor).toBe('pointer');
    });

    it('over empty space no modifier promises anything', () => {
        const { input, canvas } = selecting();
        input.currentPos = { x: 9000, y: 9000 };

        input.updateSelectionHover(true, true);
        expect(canvas.style.cursor).toBe('default');
        expect(input.hoverNodeId).toBe(null);
    });
});
