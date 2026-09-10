/**
 * Snapshot round-trip — everything the document holds must survive a save.
 *
 * `serialize_scene`/`deserialize_scene` is the pair every undo step and every
 * saved file goes through. The failure mode it has is silent: a feature gains a
 * field, the protobuf writer isn't taught about it, and the value simply isn't
 * there after a reload. Nothing throws, nothing logs — the artwork is just
 * quietly different, and by the time anyone notices, the file on disk is the
 * one missing the data.
 *
 * So rather than assert field by field, this builds documents that exercise the
 * features and compares the whole scene before and after. Anything the format
 * forgets shows up as a diff.
 *
 * One field is deliberately absent from the comparison: a Boolean Group's
 * `bool_cache`. It is derived, not authored — the loader flags every boolean
 * group dirty and JS recomputes the outline — so it is knowingly not
 * serialized. Everything else in the scene is authored, and must come back.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine } from '../engine/pkg/engine';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
}, 60_000);

/** Serialize, load into a *fresh* engine, and hand back both scenes. */
function roundTrip(engine: Engine): { before: unknown; after: unknown } {
    const before = JSON.parse(engine.get_scene_json());
    const bytes = engine.serialize_scene();
    const fresh = new Engine();
    expect(fresh.deserialize_scene(bytes)).toBe(true);
    return { before, after: JSON.parse(fresh.get_scene_json()) };
}

function expectSurvives(engine: Engine) {
    const { before, after } = roundTrip(engine);
    expect(after).toEqual(before);
}

const STYLE = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
        fills: [{ r: 0.2, g: 0.4, b: 0.9, a: 1 }],
        strokes: [
            {
                paint: { r: 0, g: 0, b: 0, a: 1 },
                width: 3,
                cap: 1,
                join: 2,
                dash_array: [10, 5, 2, 5],
                dash_offset: 3,
                miter_limit: 8,
                alignment: 'Inner',
            },
        ],
        opacity: 0.75,
        blend_mode: 3,
        fill_rule: 1,
        corner_radius: 12,
        effects: [],
        ...over,
    });

describe('a saved document comes back the same', () => {
    it('keeps plain shapes, their styles and their transforms', () => {
        const e = new Engine();
        const r = e.add_rect(10, 20, 100, 60);
        const el = e.add_ellipse(200, 100, 40, 25);
        e.set_node_style(r, STYLE());
        e.set_node_rotation(el, 37);
        e.set_node_skew(r, 5, -3);
        e.set_node_scale(el, 1.5, 0.5);
        e.set_node_name(r, 'The Rectangle');
        e.set_node_locked(el, true);
        e.set_node_visible(r, false);
        expectSurvives(e);
    });

    it('keeps every paint kind', () => {
        const e = new Engine();
        const a = e.add_rect(0, 0, 100, 100);
        e.set_node_style(
            a,
            STYLE({
                fills: [
                    {
                        gradient_type: 'Radial',
                        stops: [
                            { offset: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
                            { offset: 0.5, color: { r: 0, g: 1, b: 0, a: 0.5 } },
                            { offset: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
                        ],
                        start_x: 10,
                        start_y: 20,
                        end_x: 90,
                        end_y: 80,
                        spread: 2,
                        focal: { x: 30, y: 40, r: 5 },
                        transform: [1, 0.2, -0.1, 1, 3, 4],
                    },
                ],
            }),
        );
        const b = e.add_rect(120, 0, 100, 100);
        e.set_node_style(
            b,
            STYLE({
                fills: [
                    {
                        rows: 1,
                        cols: 1,
                        vertices: [0, 1, 2, 3].map((i) => ({
                            x: (i % 2) * 100,
                            y: Math.floor(i / 2) * 100,
                            color: { r: i / 3, g: 0.5, b: 1 - i / 3, a: 1 },
                            handles: { e: [1, 2], w: [3, 4], s: [5, 6], n: [7, 8] },
                        })),
                    },
                ],
            }),
        );
        expectSurvives(e);
    });

    it('keeps effects', () => {
        const e = new Engine();
        const r = e.add_rect(0, 0, 100, 100);
        e.set_node_effects(
            r,
            JSON.stringify([
                { Blur: { radius: 8 } },
                { DropShadow: { dx: 4, dy: 6, blur: 3, color: { r: 0, g: 0, b: 0, a: 0.4 } } },
                {
                    ColorMatrix: {
                        matrix: Array.from({ length: 20 }, (_, i) => i / 20),
                        linear_rgb: true,
                    },
                },
            ]),
        );
        expectSurvives(e);
    });

    it('keeps groups, masks and boolean groups', () => {
        const e = new Engine();
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_ellipse(60, 60, 40, 40);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_is_mask(a, true);
        e.set_node_mask_type(a, 1);
        e.set_boolean_op(g, 2);
        expectSurvives(e);
    });

    it('keeps a Live Paint group with painted faces and edges', () => {
        const e = new Engine();
        const a = e.add_rect(0, 0, 100, 100);
        const b = e.add_rect(50, 50, 100, 100);
        const g = e.group_nodes(JSON.stringify([a, b]));
        e.set_node_live_paint(g, true);
        e.set_live_paint_group(g);
        e.set_gap_tolerance(4);
        e.set_node_gap_bridge_distance(g, 7);
        expectSurvives(e);
    });

    it('keeps text, its styling and its per-vertex corner radii', () => {
        const e = new Engine();
        const t = e.add_text(10, 40, 'Hello world', 28);
        e.set_text_properties(t, 'Georgia', 2, 1.4);
        e.set_text_style(t, 600, true, 2.5);
        const p = e.add_path(
            JSON.stringify([
                {
                    closed: true,
                    points: [
                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0], corner_radius: 9 },
                        { x: 80, y: 0, cp1: [80, 0], cp2: [80, 0], corner_radius: 4 },
                        { x: 80, y: 80, cp1: [80, 80], cp2: [80, 80], corner_radius: 0 },
                    ],
                },
            ]),
        );
        e.set_node_style(p, STYLE());
        expectSurvives(e);
    });

    it('keeps document furniture — artboards, guides, swatches, meta', () => {
        const e = new Engine();
        e.add_rect(0, 0, 50, 50);
        const abA = e.add_artboard(0, 0, 800, 600);
        e.set_artboard_name(abA, 'Board A');
        e.set_artboard_background(abA, 0.9, 0.9, 1, 1);
        e.add_artboard(900, 0, 400, 400);
        e.add_guide('x', 120);
        e.add_guide('y', 250);
        e.set_guide_locks_json(JSON.stringify({ x: [120], y: [] }));
        e.set_swatches_json(
            JSON.stringify([{ name: 'Brand', global: true, color: { r: 1, g: 0, b: 0.5, a: 1 } }]),
        );
        e.set_document_size(1234, 5678);
        e.set_document_meta('11111111-2222-3333-4444-555555555555', 1000, 2000, '1.2.3', 'Sweep');
        expectSurvives(e);
    });

    it('keeps markers and text-on-path bindings', () => {
        const e = new Engine();
        const p = e.add_path(
            JSON.stringify([
                {
                    closed: false,
                    points: [
                        { x: 0, y: 0, cp1: [0, 0], cp2: [0, 0] },
                        { x: 100, y: 50, cp1: [100, 50], cp2: [100, 50] },
                    ],
                },
            ]),
        );
        const t = e.add_text(0, 0, 'along', 16);
        e.set_markers_json(JSON.stringify({ [p]: { start: 'arrow', end: 'circle' } }));
        e.set_text_paths_json(JSON.stringify({ [t]: p }));
        expectSurvives(e);
    });

    it('survives a randomly built document', () => {
        // A deterministic shuffle of the feature surface, so a field that only
        // goes missing in combination still shows up.
        let state = 20260808;
        const rnd = () => {
            state = (state * 1664525 + 1013904223) >>> 0;
            return state / 2 ** 32;
        };

        const e = new Engine();
        const ids: number[] = [];
        for (let i = 0; i < 40; i++) {
            const kind = Math.floor(rnd() * 5);
            const x = rnd() * 400;
            const y = rnd() * 400;
            let id: number;
            if (kind === 0) id = e.add_rect(x, y, 10 + rnd() * 90, 10 + rnd() * 90);
            else if (kind === 1) id = e.add_ellipse(x, y, 5 + rnd() * 50, 5 + rnd() * 50);
            else if (kind === 2) id = e.add_star(x, y, 40, 18, 5);
            else if (kind === 3) id = e.add_polygon(x, y, 40, 6);
            else id = e.add_text(x, y, `label ${i}`, 12 + rnd() * 20);
            e.set_node_style(id, STYLE({ opacity: rnd(), blend_mode: Math.floor(rnd() * 16) }));
            e.set_node_rotation(id, rnd() * 360);
            e.set_node_name(id, `node-${i}`);
            if (rnd() < 0.2) e.set_node_locked(id, true);
            if (rnd() < 0.2) e.set_node_visible(id, false);
            ids.push(id);
        }
        // Group some of them, a few levels deep.
        for (let g = 0; g < 6; g++) {
            const a = ids[Math.floor(rnd() * ids.length)];
            const b = ids[Math.floor(rnd() * ids.length)];
            if (a === b) continue;
            const gid = e.group_nodes(JSON.stringify([a, b]));
            if (gid >= 0) ids.push(gid);
        }
        expectSurvives(e);
    });
});
