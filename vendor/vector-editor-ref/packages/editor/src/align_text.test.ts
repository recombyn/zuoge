/**
 * Aligning TEXT against other artwork.
 *
 * Reported: "I clicked align horizontal centres for a group and a text node,
 * and the text is on the left instead of centred." It was — every time. The
 * engine has no font metrics, so it boxes text as `longest line × 0.6em`, and
 * align read that box: the glyphs ended up off-centre by half of whatever the
 * estimate got wrong. The numbers below are the real ones (Inter 48, measured
 * in the running editor): "REBASE.pro" types at 273.19, the estimate says 288,
 * so centring left the wordmark 7.4pt to the left of the logo it sat under.
 * Glyphs further from 0.6em are worse — ten W's are out by 98pt, a third of
 * the run.
 *
 * These tests stub the measurement the way the renderer supplies it (there is
 * no font provider under vitest) and assert on where the GLYPHS land, not on
 * where the engine thinks they are.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine, History } from '../engine/pkg/engine';
import { alignSelection, distributeSelection } from './align';
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

/** Inter 48, measured with CanvasKit in the running editor. */
const TYPESET_WIDTH = 273.1875;
const TEXT = 'REBASE.pro';
const FONT_SIZE = 48;

function makeScene(): WasmScene {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    scene.history = new History(50);
    scene.wasm = wasmModule;
    return scene;
}

/**
 * The renderer's contribution, and only it: the local box of a text node's
 * glyphs, anchored by its alignment exactly as `Renderer.getTextLocalBounds`
 * returns it.
 */
function attachTextMeasurement(scene: WasmScene, width = TYPESET_WIDTH) {
    scene.renderer = {
        getTextLocalBounds(id: number) {
            const geo = scene.getNodeGeometry(id)?.Text;
            if (!geo) return null;
            const align = geo.text_align ?? 0;
            const x = align === 1 ? -width / 2 : align === 2 ? -width : 0;
            return { x, y: -geo.font_size, w: width, h: geo.font_size };
        },
        // Nothing here renders; the rest of the surface exists because
        // WasmScene and InputManager talk to it.
        zoom: 1,
        pan: { x: 0, y: 0 },
        dpr: 1,
        invalidateRenderCaches() {},
        invalidateGroupSpriteFor() {},
        invalidateAllGroupSprites() {},
        requestRender() {},
        clearImageCache() {},
        notifyViewChange() {},
        onViewChange() {},
        beginDragLayerCache: () => false,
        setDragMovingRoots() {},
        endDragLayerCache() {},
        hoverEdgeId: -1,
        hoverFaceId: -1,
        selectedArtboardId: null,
        artboardHandleHitTest: () => null,
        artboardLabelHitTest: () => null,
    } as unknown as Renderer;
}

/** Where the glyphs actually sit in world space, as [minX, maxX]. */
function glyphSpan(scene: WasmScene, id: number): [number, number] {
    const local = scene.renderer!.getTextLocalBounds(id)!;
    const t = scene.getTransform(id); // row-major world 3×3
    const at = (x: number) => t[0] * x + t[1] * local.y + t[2];
    return [at(local.x), at(local.x + local.w)];
}

function glyphCenter(scene: WasmScene, id: number): number {
    const [lo, hi] = glyphSpan(scene, id);
    return (lo + hi) / 2;
}

function centerX(scene: WasmScene, id: number): number {
    const b = scene.getNodeBounds(id);
    return (b[0] + b[2]) / 2;
}

/** A logo (a group of two rects) with a wordmark under it, as in the report. */
function logoAndWordmark(textAlign = 0) {
    const scene = makeScene();
    const e = scene.engine!;
    const a = e.add_rect(100, 100, 300, 200);
    const b = e.add_rect(150, 320, 200, 60);
    const g = e.group_nodes(JSON.stringify([a, b]));
    const t = e.add_text(100, 500, TEXT, FONT_SIZE);
    if (textAlign !== 0) scene.engine!.set_text_properties(t, '', textAlign, 1.2);
    attachTextMeasurement(scene);
    return { scene, e, g, t };
}

describe('align: a group and a text node', () => {
    it('centres the GLYPHS on the group, not the engine’s 0.6em estimate', () => {
        const { scene, g, t } = logoAndWordmark();
        alignSelection(scene, [g, t], 'hcenter');
        expect(glyphCenter(scene, t)).toBeCloseTo(centerX(scene, g), 3);
    });

    it('centres right-aligned text too (its box hangs off the origin)', () => {
        const { scene, g, t } = logoAndWordmark(2);
        alignSelection(scene, [g, t], 'hcenter');
        expect(glyphCenter(scene, t)).toBeCloseTo(centerX(scene, g), 3);
    });

    it('centres centre-aligned text too', () => {
        const { scene, g, t } = logoAndWordmark(1);
        alignSelection(scene, [g, t], 'hcenter');
        expect(glyphCenter(scene, t)).toBeCloseTo(centerX(scene, g), 3);
    });

    it('puts the first glyph on the group’s left edge, not 15pt inside it', () => {
        const { scene, g, t } = logoAndWordmark();
        alignSelection(scene, [g, t], 'left');
        const b = scene.getNodeBounds(g);
        expect(glyphSpan(scene, t)[0]).toBeCloseTo(b[0], 3);
    });

    it('puts the last glyph on the group’s right edge', () => {
        const { scene, g, t } = logoAndWordmark();
        alignSelection(scene, [g, t], 'right');
        const b = scene.getNodeBounds(g);
        expect(glyphSpan(scene, t)[1]).toBeCloseTo(b[2], 3);
    });

    it('centres text whose glyphs are far WIDER than the estimate', () => {
        // Ten W's: 483.5 typeset against a 288 estimate. Read the wrong box and
        // the wordmark lands 98pt out — a third of its own length.
        const scene = makeScene();
        const e = scene.engine!;
        const r = e.add_rect(0, 0, 600, 200);
        const t = e.add_text(0, 400, 'WWWWWWWWWW', FONT_SIZE);
        attachTextMeasurement(scene, 483.5);
        alignSelection(scene, [r, t], 'hcenter');
        expect(glyphCenter(scene, t)).toBeCloseTo(centerX(scene, r), 3);
    });

    it('measures text inside a scaled group in world units', () => {
        // A group's own scale multiplies the typeset width; align works in
        // world space, so the correction has to be scaled with it.
        const scene = makeScene();
        const e = scene.engine!;
        const plate = e.add_rect(0, 0, 800, 200);
        const t = e.add_text(0, 400, TEXT, FONT_SIZE);
        const g = e.group_nodes(JSON.stringify([t]));
        scene.setNodeTransformComponents(g, {
            x: 0,
            y: 0,
            scale_x: 2,
            scale_y: 2,
            rotation_deg: 0,
            skew_x_deg: 0,
            skew_y_deg: 0,
        });
        attachTextMeasurement(scene);
        alignSelection(scene, [plate, g], 'hcenter');
        expect(glyphCenter(scene, t)).toBeCloseTo(centerX(scene, plate), 3);
    });

    it('aligns a GROUP that contains text by the text it draws', () => {
        // The group's engine bounds are the union of the same estimates, so a
        // wordmark grouped with its own underline inherits the error.
        const scene = makeScene();
        const e = scene.engine!;
        const plate = e.add_rect(0, 0, 800, 200);
        const t = e.add_text(0, 400, TEXT, FONT_SIZE);
        const rule = e.add_rect(0, 410, 100, 4);
        const g = e.group_nodes(JSON.stringify([t, rule]));
        attachTextMeasurement(scene);
        alignSelection(scene, [plate, g], 'hcenter');
        const [glyphLo, glyphHi] = glyphSpan(scene, t);
        const ruleBox = scene.getNodeBounds(rule);
        const lo = Math.min(glyphLo, ruleBox[0]); // what the group actually draws
        const hi = Math.max(glyphHi, ruleBox[2]);
        expect((lo + hi) / 2).toBeCloseTo(centerX(scene, plate), 3);
    });

    it('leaves shapes without text exactly where the engine says', () => {
        // The correction must not perturb the geometry the engine already
        // measures exactly.
        const scene = makeScene();
        const e = scene.engine!;
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(500, 300, 40, 40);
        attachTextMeasurement(scene);
        alignSelection(scene, [a, b], 'hcenter');
        expect(Array.from(scene.getNodeBounds(a))).toEqual([220, 0, 320, 100]);
        expect(Array.from(scene.getNodeBounds(b))).toEqual([250, 300, 290, 340]);
    });

    it('falls back to the engine box when nothing can measure yet', () => {
        // No renderer (or no font provider): the estimate is all there is, and
        // aligning by it must still work rather than throw or no-op.
        const { scene, g, t } = logoAndWordmark();
        scene.renderer = null;
        alignSelection(scene, [g, t], 'hcenter');
        expect(centerX(scene, t)).toBeCloseTo(centerX(scene, g), 3);
    });
});

describe('the box drawn around the selection', () => {
    /**
     * The complaint that came after the align fix: the artwork was centred but
     * the frame around it was not. A single selection's frame has always come
     * from the measured local bounds, but the MULTI-selection union came from
     * the engine's estimate — so selecting a centred wordmark with the logo it
     * sits under drew a frame hanging 15pt off the text's right-hand side, and
     * the box said the elements were not centred when they were.
     */
    function makeInput(scene: WasmScene) {
        return new InputManager(
            document.createElement('canvas'),
            scene,
            {
                activeTool: 'selection',
                syncWithSelection() {},
                updateLayerList() {},
                revealSelection() {},
                revealSelectionIfChanged() {},
                hideContextMenu() {},
                refreshArtboardPanel() {},
                applyToolCursor() {},
                collapseSubtreeByDefault() {},
                gradientEdit: { isActive: () => false, hitTest: () => null },
            } as unknown as UIEngine,
            scene.renderer as Renderer,
        );
    }

    it('ends where the glyphs end, so a centred selection gets a centred frame', () => {
        const { scene, g, t } = logoAndWordmark();
        alignSelection(scene, [g, t], 'hcenter');
        scene.engine!.select_node(g, false);
        scene.engine!.select_node(t, true);

        const frame = makeInput(scene).getSelectionBounds()!;
        const group = scene.getNodeBounds(g);
        const [glyphLo, glyphHi] = glyphSpan(scene, t);

        // The frame is the union of what is actually drawn…
        expect(frame.x).toBeCloseTo(Math.min(group[0], glyphLo), 3);
        expect(frame.x + frame.w).toBeCloseTo(Math.max(group[2], glyphHi), 3);
        // …and therefore shares its centre with both of them.
        expect(frame.x + frame.w / 2).toBeCloseTo((group[0] + group[2]) / 2, 3);
    });

    it('does not stretch to the engine’s estimate of the text', () => {
        const { scene, g, t } = logoAndWordmark();
        alignSelection(scene, [g, t], 'hcenter');
        scene.engine!.select_node(g, false);
        scene.engine!.select_node(t, true);

        const frame = makeInput(scene).getSelectionBounds()!;
        const estimate = scene.getNodeBounds(t)[2]; // 0.6em × 10 characters
        expect(estimate).toBeGreaterThan(glyphSpan(scene, t)[1]); // the estimate does overshoot
        expect(frame.x + frame.w).toBeLessThan(estimate); // the frame does not follow it
    });
});

describe('distribute: gaps measured on glyphs', () => {
    it('leaves equal gaps between the shapes as drawn', () => {
        const scene = makeScene();
        const e = scene.engine!;
        const left = e.add_rect(0, 0, 100, 50);
        const t = e.add_text(200, 40, TEXT, FONT_SIZE);
        const right = e.add_rect(900, 0, 100, 50);
        attachTextMeasurement(scene);
        distributeSelection(scene, [left, t, right], 'h');

        const [tLo, tHi] = glyphSpan(scene, t);
        const gapBefore = tLo - 100;
        const gapAfter = 900 - tHi;
        expect(gapBefore).toBeCloseTo(gapAfter, 3);
    });
});
