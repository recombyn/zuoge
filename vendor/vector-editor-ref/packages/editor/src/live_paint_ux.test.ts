/**
 * Two rules about containers, and Live Paint obeying both of them.
 *
 * **The tool decides.** The bucket paints; the selection tools select and edit.
 * Live Paint used to break this by spending double-click — the one gesture that
 * means "go deeper" everywhere else in the editor — on arming the bucket, which
 * left the shapes inside a painted group with no gesture at all. The Objects
 * panel was the only way in, and only if you thought to look there.
 *
 * **A shape is drawn into the container you are inside** (Illustrator's
 * isolation-mode rule), where "inside" is the parent of the selection — the same
 * notion of context the click resolver already uses. This is not a Live Paint
 * feature: it holds for a plain group too, and is refused for a Boolean Group,
 * where an extra operand would redraw the artwork rather than join it.
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
    };
    return ui as unknown as UIEngine;
}

function mouse(clientX: number, clientY: number, detail = 1): MouseEvent {
    return {
        clientX,
        clientY,
        detail,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        button: 0,
        preventDefault() {},
        stopPropagation() {},
    } as unknown as MouseEvent;
}

/** Two overlapping rects in a Live Paint group, one region painted. */
function painted(activeTool = 'selection') {
    const scene = makeScene();
    const e = scene.engine!;
    const ui = makeUI(activeTool);
    const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
    const a = e.add_rect(0, 0, 100, 100);
    const b = e.add_rect(50, 50, 100, 100);
    const group = e.group_nodes(JSON.stringify([a, b]));
    e.set_node_live_paint(group, true);
    e.set_live_paint_group(group);
    scene.setFaceFill(e.query_face_at(75, 75), 0, 1, 0, 1);
    return { scene, e, ui, input, a, b, group };
}

describe('a Live Paint group is still a group', () => {
    it('double-click with a selection tool reaches the shape, not the bucket', () => {
        const { e, ui, input, a, group } = painted();
        e.select_node(group, false); // what the first press leaves selected

        input.onDoubleClick(mouse(25, 25, 2)); // inside `a` only

        expect(Array.from(e.get_selection())).toEqual([a]);
        expect(ui.activeTool).not.toBe('paint-bucket');
    });

    it('the shape it reaches can then be moved, and the paint follows', () => {
        const { scene, e, group, a } = painted();
        e.select_node(group, false);
        // `a` spans 0..100; a point only it covers, which the move will vacate.
        expect(e.query_face_at(80, 25)).toBeGreaterThanOrEqual(0);

        // Move the member the way a drag does: 0..100 becomes -40..60.
        scene.moveNodes([a], -40, 0);

        // The network rebuilt around the new geometry rather than going stale.
        expect(e.query_face_at(80, 25)).toBe(-1); // nothing there any more
        expect(e.query_face_at(25, 25)).toBeGreaterThanOrEqual(0); // still inside `a`
        expect(e.query_face_at(75, 75)).toBeGreaterThanOrEqual(0); // the overlap moved with it
    });

    it('the bucket keeps the gesture, so it can move scope between groups', () => {
        const { e, ui, input } = painted('paint-bucket');
        const c = e.add_rect(400, 400, 100, 100);
        const second = e.group_nodes(JSON.stringify([c]));
        e.set_node_live_paint(second, true);

        input.onDoubleClick(mouse(450, 450, 2));

        expect(ui.activeTool).toBe('paint-bucket');
        expect(e.get_live_paint_group()).toBe(second);
    });

    it('a shape drawn while inside the group joins it, on top', () => {
        const { scene, e, ui, input, a, group } = painted();
        ui.setActiveTool('rect');
        e.clear_selection();
        e.select_node(a, false); // where drilling in leaves you

        // Drag out a rect straddling `a`'s right edge.
        input.onMouseDown(mouse(80, 20));
        input.onMouseMove(mouse(180, 60));
        input.onMouseUp(mouse(180, 60));

        const drawn = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(drawn)).toBe(group);
        // Top-most member, and painting stops at the neighbour it crosses.
        const kids = Array.from(scene.getNodeChildren(group));
        expect(kids[kids.length - 1]).toBe(drawn);
        expect(e.query_face_at(150, 40)).toBeGreaterThanOrEqual(0);
        expect(e.query_face_at(150, 40)).not.toBe(e.query_face_at(90, 40));
    });

    it('one undo takes the drawn shape back out of the group', () => {
        const { scene, e, ui, input, a, group } = painted();
        ui.setActiveTool('rect');
        e.clear_selection();
        e.select_node(a, false);
        const before = Array.from(scene.getNodeChildren(group)).length;

        input.onMouseDown(mouse(80, 20));
        input.onMouseMove(mouse(180, 60));
        input.onMouseUp(mouse(180, 60));
        expect(Array.from(scene.getNodeChildren(group)).length).toBe(before + 1);

        scene.undo();

        expect(Array.from(scene.getNodeChildren(group)).length).toBe(before);
    });

    it('a shape drawn with the group itself selected stays outside it', () => {
        // Selecting the whole object means you are working WITH it, and as likely
        // drawing beside it — Illustrator only adds while you are inside.
        const { scene, e, ui, input, group } = painted();
        ui.setActiveTool('rect');
        e.clear_selection();
        e.select_node(group, false);

        input.onMouseDown(mouse(300, 300));
        input.onMouseMove(mouse(360, 360));
        input.onMouseUp(mouse(360, 360));

        const drawn = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(drawn)).toBe(-1);
    });

    it('a shape drawn with nothing selected stays outside it', () => {
        const { scene, e, ui, input } = painted();
        ui.setActiveTool('rect');
        e.clear_selection();

        input.onMouseDown(mouse(300, 300));
        input.onMouseMove(mouse(360, 360));
        input.onMouseUp(mouse(360, 360));

        const drawn = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(drawn)).toBe(-1);
    });

    it('putting the bucket down leaves you inside, so drawing keeps adding', () => {
        const { ui, input, group } = painted('paint-bucket');

        input.exitLivePaintGroup(); // the Done button

        expect(ui.activeTool).toBe('selection');
        // Still inside: the next shape drawn joins the group rather than landing
        // at the root one step after the painting it belongs to.
        expect(input.drawContainerTarget()).toBe(group);
    });

    it('the same rule holds for a plain group — one behaviour, not a special case', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ui = makeUI('rect');
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
        const a = e.add_rect(0, 0, 100, 100);
        const plain = e.group_nodes(JSON.stringify([a]));
        e.clear_selection();
        e.select_node(a, false); // inside the plain group

        input.onMouseDown(mouse(200, 200));
        input.onMouseMove(mouse(260, 260));
        input.onMouseUp(mouse(260, 260));

        const drawn = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(drawn)).toBe(plain);
    });

    it('a Boolean Group is left alone — an extra operand redraws the artwork', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const ui = makeUI('rect');
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        const bool = e.group_nodes(JSON.stringify([a, b]));
        e.set_boolean_op(bool, 0); // union
        e.clear_selection();
        e.select_node(a, false); // inside the boolean group

        input.onMouseDown(mouse(300, 300));
        input.onMouseMove(mouse(360, 360));
        input.onMouseUp(mouse(360, 360));

        const drawn = Array.from(e.get_selection())[0];
        expect(scene.getNodeParent(drawn)).toBe(-1);
    });

    it('Release hands back a plain group: shapes kept, surface gone', () => {
        // The counterpart to Expand, and the pair a Boolean Group already offers.
        const { scene, e, input, group, a, b } = painted();

        input.releaseLivePaintGroup(group);

        expect(scene.getNodeLivePaint(group)).toBe(false);
        expect(e.get_live_paint_group()).toBe(-1);
        expect(Array.from(scene.getNodeChildren(group))).toEqual([a, b]);
        expect(e.query_face_at(75, 75)).toBe(-1); // nothing paintable any more
        expect(JSON.parse(e.get_live_paint_faces()).length).toBe(0);
    });

    it('ungrouping a painted group takes the paint with it', () => {
        // The engine used to leave the dead group in its cache, as the paint
        // scope, and its faces on the canvas — paint belonging to nothing.
        const { scene, e, group, a } = painted();

        scene.ungroupNode(group);

        expect(scene.getNodeType(group)).toBe(undefined);
        expect(e.get_live_paint_group()).toBe(-1);
        expect(JSON.parse(e.get_live_paint_render_data()).groups).toEqual([]);
        expect(JSON.parse(e.get_live_paint_faces()).length).toBe(0);
        expect(scene.getNodeType(a)).not.toBe(undefined); // the shapes survive
    });

    it('names the shape that is over the group but not in it', () => {
        // The reported confusion: lines plainly cross the region, the fill
        // ignores them, and nothing says why. A shape outside the group puts no
        // segments in the surface, so its edges divide nothing.
        const { scene, e, input, group } = painted();
        const stray = e.add_rect(20, 20, 60, 60); // sits over the group, outside it

        expect(input.livePaintIntruderAt({ x: 40, y: 40 }, group)).toBe(stray);
        // A point over a real member is not an accusation.
        expect(input.livePaintIntruderAt({ x: 140, y: 140 }, group)).toBe(null);

        input.livePaintIntruder = stray;
        input.adoptLivePaintIntruder();

        expect(scene.getNodeParent(stray)).toBe(group);
        expect(input.livePaintIntruder).toBe(null);
        // Now in the group, it divides what it crosses.
        expect(e.query_face_at(40, 40)).not.toBe(e.query_face_at(90, 40));
    });

    it('arming the bucket on the selected group starts painting it', () => {
        const { e, ui, input, group } = painted();
        e.clear_selection();
        e.select_node(group, false);

        input.enterPaintBucketMode(); // what pressing B does

        expect(ui.activeTool).toBe('paint-bucket');
        expect(e.get_live_paint_group()).toBe(group);
    });
});

/**
 * What a Live Paint group paints is exactly what it catches.
 *
 * A member of one paints no fill of its own — the faces do — so an unpainted
 * region shows whatever sits behind the group. Picking never knew that: it
 * asked the member for its silhouette, and every click over an uncoloured
 * region was swallowed by a shape that had drawn nothing there. From the
 * outside it looked like the selection box lying about the artwork's size.
 */
describe('a Live Paint group catches clicks only where it paints', () => {
    /** A background rect, with an unpainted Live Paint group of two outlined
     *  squares over it. */
    function overBackground() {
        const scene = makeScene();
        const e = scene.engine!;
        const ui = makeUI('selection');
        const input = new InputManager(document.createElement('canvas'), scene, ui, makeRenderer());
        const bg = e.add_rect(0, 0, 400, 400);
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        for (const id of [a, b]) {
            e.set_node_style(
                id,
                JSON.stringify({
                    fills: [],
                    strokes: [
                        {
                            paint: { r: 0, g: 0, b: 0, a: 1 },
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
                    fill_rule: 0,
                    corner_radius: 0,
                    effects: [],
                }),
            );
        }
        const group = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(group, true);
        e.set_live_paint_group(group);
        return { scene, e, ui, input, bg, a, b, group };
    }

    function click(input: InputManager, x: number, y: number) {
        input.onMouseDown(mouse(x, y));
        input.onMouseUp(mouse(x, y));
    }

    it('a click on an unpainted region reaches the shape behind it', () => {
        const { e, input, bg } = overBackground();
        click(input, 25, 25);
        expect(Array.from(e.get_selection())).toEqual([bg]);
    });

    it('a click on a painted region selects the group', () => {
        const { scene, e, input, group } = overBackground();
        scene.setFaceFill(e.query_face_at(25, 25), 1, 0, 0, 1);
        click(input, 25, 25);
        expect(Array.from(e.get_selection())).toEqual([group]);
    });

    it('a click on a member outline selects the group, painted or not', () => {
        const { e, input, group } = overBackground();
        click(input, 0, 50); // A's left edge — a stroke that IS drawn
        expect(Array.from(e.get_selection())).toEqual([group]);
    });
});
