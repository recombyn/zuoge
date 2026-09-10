/**
 * Interaction sweep for the pen and the text tool: the gestures that CREATE
 * artwork, driven through the real InputManager against the real engine.
 *
 * Companion to `interaction_sweep.test.ts`, which covers selection. The two
 * halves fail differently — a broken selection gesture is annoying, a broken
 * creation gesture loses work someone just did.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// The inline text overlay mounts into #canvas-container; without it the text
// tool has nowhere to put its <textarea> and silently does nothing.
//
// It also measures glyphs through a 2D canvas context to auto-size the box, and
// jsdom has none — `getContext('2d')` returns null and the overlay throws on the
// first keystroke. A width proportional to the string is enough: nothing here
// asserts on measured pixels, only on what gets committed.
beforeEach(() => {
    document.body.innerHTML = '<div id="canvas-container"></div>';
    const fakeCtx = {
        font: '',
        measureText: (t: string) => ({ width: t.length * 8 }),
    } as unknown as CanvasRenderingContext2D;
    HTMLCanvasElement.prototype.getContext = (() =>
        fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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
        // Measured text metrics need real fonts; null makes the text overlay
        // fall back to the node's own em box, which is what these tests assume.
        getTextLocalBounds: () => null,
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}
function makeUI(activeTool: string): UIEngine {
    return {
        activeTool,
        setActiveTool(t: string) {
            (this as { activeTool: string }).activeTool = t;
        },
        // The style a newly drawn shape inherits. The pen reads this to decide
        // stroke/fill on commit, so without it every pen test dies before the
        // path exists.
        // The style a newly drawn shape inherits. Copied from UIEngine's own
        // default (`buildCurrentStyleJson`) rather than invented: a paint shape
        // the engine cannot parse is rejected silently, the node keeps its
        // default style, and the test then measures the default instead of what
        // the pen asked for.
        getCurrentStyle: () =>
            JSON.stringify({
                fills: [{ r: 0.8, g: 0.8, b: 0.8, a: 1.0 }],
                strokes: [
                    {
                        paint: { r: 0, g: 0, b: 0, a: 1.0 },
                        width: 1,
                        cap: 0,
                        join: 0,
                        dash_array: [],
                        dash_offset: 0,
                        miter_limit: 4,
                        alignment: 'Center',
                    },
                ],
                opacity: 1,
                blend_mode: 0,
                corner_radius: 0,
            }),
        syncWithSelection() {},
        updateLayerList() {},
        revealSelection() {},
        revealSelectionIfChanged() {},
        hideContextMenu() {},
        refreshArtboardPanel() {},
        applyToolCursor() {},
        collapseSubtreeByDefault() {},
        contextBar: { refresh() {} },
        gradientEdit: { isActive: () => false, hitTest: () => null },
    } as unknown as UIEngine;
}
interface Opts {
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
    detail?: number;
}
const mouse = (clientX: number, clientY: number, o: Opts = {}) =>
    ({
        clientX,
        clientY,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as MouseEvent;
const keyEv = (key: string, o: Record<string, unknown> = {}) =>
    ({
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        shiftKey: false,
        metaKey: false,
        altKey: false,
        ctrlKey: false,
        target: document.body,
        preventDefault() {},
        stopPropagation() {},
        ...o,
    }) as unknown as KeyboardEvent;

function makeInput(scene: WasmScene, tool: string, zoom = 1) {
    const ui = makeUI(tool);
    const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer(zoom));
    return { input, ui };
}
const click = (input: InputManager, x: number, y: number, o: Opts = {}) => {
    input.onMouseDown(mouse(x, y, o));
    input.onMouseUp(mouse(x, y, o));
};
const paths = (scene: WasmScene) =>
    JSON.parse(scene.engine!.get_scene_json()).root_nodes.filter(
        (id: number) => scene.getNode(id)?.node_type === 'Path',
    );
// Non-null: every caller has already asserted the path exists, and letting the
// optional chain leak into the assertions makes them read as maybe-checks.
const subpathOf = (scene: WasmScene, id: number) =>
    scene.getNode(id)!.geometry!.Path!.subpaths[0] as {
        closed: boolean;
        points: Array<{ x: number; y: number; cp1: number[]; cp2: number[] }>;
    };

describe('sweep: pen — placing and finishing', () => {
    it('three clicks then Enter commits an open path with three anchors', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 100, 0);
        click(input, 100, 80);
        input.onKeyDown(keyEv('Enter'));

        const ids = paths(scene);
        expect(ids.length).toBe(1);
        const sp = subpathOf(scene, ids[0]);
        expect(sp.points.length).toBe(3);
        expect(sp.closed).toBe(false);
    });

    it('clicking back on the first anchor closes the path', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 100, 0);
        click(input, 100, 80);
        click(input, 0, 0); // onto the first anchor
        input.onKeyDown(keyEv('Enter'));

        const ids = paths(scene);
        expect(ids.length).toBe(1);
        expect(subpathOf(scene, ids[0]).closed).toBe(true);
    });

    it('Escape keeps the anchors already placed rather than discarding them', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 40);
        input.onKeyDown(keyEv('Escape'));
        expect(paths(scene).length).toBe(1);
    });

    it('a single click places nothing committable', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 20, 20);
        input.onKeyDown(keyEv('Enter'));
        // One anchor is not a path. Committing it would leave an invisible,
        // unselectable dot in the document.
        expect(paths(scene).length).toBe(0);
    });

    it('dragging on an anchor pulls a real bezier handle', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        // Press, move well past the dead zone, release: a handle drag.
        input.onMouseDown(mouse(100, 0));
        input.onMouseMove(mouse(140, 30));
        input.onMouseUp(mouse(140, 30));
        click(input, 200, 0);
        input.onKeyDown(keyEv('Enter'));

        const sp = subpathOf(scene, paths(scene)[0]);
        const bent = sp.points.some(
            (p: { x: number; y: number; cp1: number[]; cp2: number[] }) =>
                Math.hypot(p.cp2[0] - p.x, p.cp2[1] - p.y) > 1 ||
                Math.hypot(p.cp1[0] - p.x, p.cp1[1] - p.y) > 1,
        );
        expect(bent).toBe(true);
    });

    it('an open path commits stroke-only, a closed one keeps a fill', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 80, 0);
        input.onKeyDown(keyEv('Enter'));
        const open = scene.getNode(paths(scene)[0]);
        expect(open?.style.fills?.length ?? 0).toBe(0);
        expect((open?.style.strokes?.length ?? 0) > 0).toBe(true);
    });
});

describe('sweep: pen — undoing while still drawing', () => {
    it('cmd-Z removes the last anchor and cmd-shift-Z puts it back', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        click(input, 120, 0);
        input.onKeyDown(keyEv('z', { metaKey: true }));
        input.onKeyDown(keyEv('Enter'));
        expect(subpathOf(scene, paths(scene)[0]).points.length).toBe(2);
    });

    it('undo after committing removes the whole path', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        input.onKeyDown(keyEv('Enter'));
        expect(paths(scene).length).toBe(1);
        scene.undo();
        expect(paths(scene).length).toBe(0);
    });
});

describe('sweep: text', () => {
    const overlay = () =>
        document.querySelector('.text-input-overlay') as HTMLTextAreaElement | null;
    const texts = (scene: WasmScene) =>
        JSON.parse(scene.engine!.get_scene_json()).root_nodes.filter(
            (id: number) => scene.getNode(id)?.node_type === 'Text',
        );

    it('clicking with the text tool opens an editor at the click point', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        expect(overlay()).not.toBeNull();
    });

    it('typing then Enter commits a text node with that content', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'Hello';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const ids = texts(scene);
        expect(ids.length).toBe(1);
        expect(scene.getNode(ids[0])?.geometry?.Text?.content).toBe('Hello');
    });

    it('committing nothing leaves no empty text node behind', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = '';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(texts(scene).length).toBe(0);
    });

    it('Escape abandons the new text instead of committing it', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'discard me';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(texts(scene).length).toBe(0);
    });

    it('double-clicking existing text reopens it for editing, prefilled', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Original', 32);
        const { input } = makeInput(scene, 'selection');
        e.select_node(t, false);
        input.onDoubleClick(mouse(60, 30));
        const el = overlay();
        expect(el).not.toBeNull();
        expect(el!.value).toBe('Original');
    });

    it('undo removes a committed text node', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'Undo me';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(texts(scene).length).toBe(1);
        scene.undo();
        expect(texts(scene).length).toBe(0);
    });
});

describe('sweep: pen — the awkward cases', () => {
    it('finishing hands the tool back to selection', () => {
        const scene = makeScene();
        const { input, ui } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 50, 0);
        input.onKeyDown(keyEv('Enter'));
        expect(ui.activeTool).toBe('selection');
    });

    it('clicking a free endpoint of an existing open path extends it', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        input.onKeyDown(keyEv('Enter'));
        expect(paths(scene).length).toBe(1);

        // Start again ON the free end: this should continue that path rather
        // than leave two paths meeting at a point.
        const { input: pen2 } = makeInput(scene, 'pen');
        click(pen2, 60, 0);
        click(pen2, 120, 0);
        pen2.onKeyDown(keyEv('Enter'));
        expect(paths(scene).length).toBe(1);
        expect(subpathOf(scene, paths(scene)[0]).points.length).toBe(3);
    });

    it('cmd-click near the first anchor places a point instead of closing', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        click(input, 60, 60);
        click(input, 2, 2, { metaKey: true }); // within the close radius
        input.onKeyDown(keyEv('Enter'));
        const sp = subpathOf(scene, paths(scene)[0]);
        expect(sp.closed).toBe(false);
        expect(sp.points.length).toBe(4);
    });

    it('the close radius is screen-space, so zooming out does not close early', () => {
        // At 10% zoom, 10 screen px is 100 world units. A second anchor 60 units
        // from the first is well inside that — but it is a NEW anchor, not a
        // close, and treating it as one would make the pen unusable when zoomed
        // out. (Closing needs >1 existing point, which is what protects this.)
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen', 0.1);
        click(input, 0, 0);
        click(input, 60, 0);
        click(input, 60, 60);
        input.onKeyDown(keyEv('Enter'));
        const sp = subpathOf(scene, paths(scene)[0]);
        expect(sp.points.length).toBe(3);
        expect(sp.closed).toBe(false);
    });
});

describe('sweep: text — editing what is already there', () => {
    const overlay = () =>
        document.querySelector('.text-input-overlay') as HTMLTextAreaElement | null;
    const texts = (scene: WasmScene) =>
        JSON.parse(scene.engine!.get_scene_json()).root_nodes.filter(
            (id: number) => scene.getNode(id)?.node_type === 'Text',
        );
    const content = (scene: WasmScene, id: number) => scene.getNode(id)?.geometry?.Text?.content;

    it('editing existing text replaces its content instead of adding a node', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Before', 32);
        const { input } = makeInput(scene, 'selection');
        e.select_node(t, false);
        input.onDoubleClick(mouse(60, 30));
        const el = overlay()!;
        el.value = 'After';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(texts(scene).length).toBe(1);
        expect(content(scene, t)).toBe('After');
    });

    it('Escape while editing existing text keeps the original content', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Keep me', 32);
        const { input } = makeInput(scene, 'selection');
        e.select_node(t, false);
        input.onDoubleClick(mouse(60, 30));
        const el = overlay()!;
        el.value = 'thrown away';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(content(scene, t)).toBe('Keep me');
    });

    it('shift-Enter makes a new line rather than committing', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'line one';
        el.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
        );
        expect(overlay()).not.toBeNull(); // still editing
        el.value = 'line one\nline two';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        const ids = texts(scene);
        expect(ids.length).toBe(1);
        expect(content(scene, ids[0])).toContain('\n');
    });

    it('emptying existing text does not leave an invisible node behind', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Delete my words', 32);
        const { input } = makeInput(scene, 'selection');
        e.select_node(t, false);
        input.onDoubleClick(mouse(60, 30));
        const el = overlay()!;
        el.value = '';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(texts(scene).length).toBe(0);
    });

    it('undo after an edit restores the previous words', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Original', 32);
        const { input } = makeInput(scene, 'selection');
        e.select_node(t, false);
        input.onDoubleClick(mouse(60, 30));
        const el = overlay()!;
        el.value = 'Changed';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(content(scene, t)).toBe('Changed');
        scene.undo();
        expect(content(scene, t)).toBe('Original');
    });
});

describe('sweep: work in progress must not vanish', () => {
    const overlay = () =>
        document.querySelector('.text-input-overlay') as HTMLTextAreaElement | null;
    const texts = (scene: WasmScene) =>
        JSON.parse(scene.engine!.get_scene_json()).root_nodes.filter(
            (id: number) => scene.getNode(id)?.node_type === 'Text',
        );

    it('a live pen path is committed, not dropped, when the tool changes', () => {
        // This is the contract UIEngine.setActiveTool relies on: leaving the pen
        // with anchors placed calls finalizePenPath() rather than clearing the
        // buffer. Anchors already placed are real geometry.
        const scene = makeScene();
        const { input } = makeInput(scene, 'pen');
        click(input, 0, 0);
        click(input, 60, 0);
        click(input, 60, 60);
        input.finalizePenPath();
        expect(paths(scene).length).toBe(1);
        expect(subpathOf(scene, paths(scene)[0]).points.length).toBe(3);
    });

    it('clicking away from a new text box commits what was typed', () => {
        const scene = makeScene();
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'committed by blur';
        el.dispatchEvent(new Event('blur'));
        const ids = texts(scene);
        expect(ids.length).toBe(1);
        expect(scene.getNode(ids[0])?.geometry?.Text?.content).toBe('committed by blur');
    });

    it('the text tool on top of existing text edits it instead of stacking a copy', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const t = e.add_text(40, 40, 'Existing', 32);
        const { input } = makeInput(scene, 'text');
        // Click right on the glyphs.
        input.onMouseDown(mouse(60, 30));
        const el = overlay();
        expect(el).not.toBeNull();
        el!.value = 'Edited';
        el!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(texts(scene).length).toBe(1);
        expect(scene.getNode(t)?.geometry?.Text?.content).toBe('Edited');
    });

    it('cancelling a new text box leaves the undo history alone', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(200, 200, 50, 50);
        const { input } = makeInput(scene, 'text');
        input.onMouseDown(mouse(50, 60));
        const el = overlay()!;
        el.value = 'abandoned';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        // An abandoned edit is not an edit: undo must not now delete the rect
        // that was already there.
        scene.undo();
        expect(e.get_node_type(r)).not.toBeUndefined();
    });
});

describe('sweep: drawing into a Live Paint group', () => {
    it('a path drawn while a Live Paint group is active joins it', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 120, 120);
        const b = e.add_rect(80, 0, 120, 120);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        // INSIDE the group, which means a member is selected — the same state
        // double-clicking into it produces. Selecting the group from outside is
        // not being inside it, and a stroke drawn then belongs at the root.
        e.select_node(a, false);

        const { input } = makeInput(scene, 'pen');
        // Edge to edge, PAST both shapes. A line whose end stops inside a shape
        // is a slit, not a division — the region simply wraps around it — so a
        // fixture drawn 10 units in would prove nothing about joining.
        click(input, -20, 60);
        click(input, 220, 60);
        input.onKeyDown(keyEv('Enter'));

        const members = scene.getNode(g)?.children ?? [];
        expect(members.length).toBe(3);
        // And the line divides the surface, so the region it cut is paintable.
        expect(scene.engine!.query_face_at(40, 30)).toBeGreaterThanOrEqual(0);
        expect(scene.engine!.query_face_at(40, 90)).not.toBe(scene.engine!.query_face_at(40, 30));
    });
});
