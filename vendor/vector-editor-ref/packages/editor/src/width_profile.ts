/**
 * width_profile.ts — Illustrator-style stroke width profiles.
 *
 * Applies a variable-width profile along an open path's centerline and outlines
 * it into a filled shape (a one-shot expand, like "Outline Stroke" but tapered).
 * Produces calligraphic / brush-like forms from a plain stroked path. Reuses
 * CanvasKit's ContourMeasure to sample position + tangent by arc length, offsets
 * each side by half the (profile-scaled) width, and emits a closed ribbon.
 *
 * Edits in place, one undo step. Works in the node's local space so its
 * transform is preserved.
 */
import type { CanvasKit } from 'canvaskit-wasm';
import { appendSubpathsToPath } from './boolean_ops';
import type { Color, PathPoint } from './types';
import type { WasmScene } from './wasm_scene';

export type WidthProfile = 'uniform' | 'taper-end' | 'taper-both' | 'bulge';

/** Width multiplier in [0,1] as a function of arc-length fraction t ∈ [0,1]. */
const PROFILES: Record<WidthProfile, (t: number) => number> = {
    uniform: () => 1,
    'taper-end': (t) => 1 - t, // thick start → point at the end
    'taper-both': (t) => Math.sin(Math.PI * t), // point at both ends, thick middle (leaf)
    bulge: (t) => 0.35 + 0.65 * Math.sin(Math.PI * t), // thick middle, thin (not zero) ends
};

const SAMPLES = 96;

function solid(paint: unknown): Color | null {
    const p = paint as (Color & { gradient_type?: unknown; image_id?: unknown }) | null | undefined;
    if (!p || typeof p.r !== 'number') return null;
    if ('gradient_type' in p || 'image_id' in p) return null;
    return p;
}

/**
 * Apply `profile` to the given path node, replacing its geometry with a filled
 * variable-width outline. Returns true on success. Only meaningful for a path
 * with an open subpath (that's what a width profile shapes).
 */
export function applyWidthProfile(
    ck: CanvasKit,
    scene: WasmScene,
    nodeId: number,
    profile: WidthProfile,
): boolean {
    const geom = scene.getNodeGeometry(nodeId);
    const subpaths = geom?.Path?.subpaths;
    if (!subpaths || subpaths.length === 0) return false;
    const open = subpaths.find((s) => !s.closed && s.points.length >= 2);
    if (!open) return false;

    const style = scene.getNodeStyle(nodeId);
    const stroke = style?.strokes?.[0];
    const baseWidth = stroke?.width && stroke.width > 0 ? stroke.width : 16;
    const color =
        solid(stroke?.paint) ?? solid(style?.fills?.[0]) ?? ({ r: 0, g: 0, b: 0, a: 1 } as Color);

    // Sample the open subpath's centerline (local space) by arc length.
    const path = new ck.Path();
    appendSubpathsToPath(path, [open]);
    const iter = new ck.ContourMeasureIter(path, false, 1);
    const measure = iter.next();
    if (!measure) {
        iter.delete();
        path.delete();
        return false;
    }
    const len = measure.length();
    const fn = PROFILES[profile];

    const left: [number, number][] = [];
    const right: [number, number][] = [];
    for (let k = 0; k <= SAMPLES; k++) {
        const t = k / SAMPLES;
        const [px, py, tx, ty] = measure.getPosTan(t * len); // tangent is unit length
        const w = (baseWidth * Math.max(0, fn(t))) / 2;
        const nx = -ty;
        const ny = tx; // unit normal
        left.push([px + nx * w, py + ny * w]);
        right.push([px - nx * w, py - ny * w]);
    }
    measure.delete();
    iter.delete();
    path.delete();

    // Closed ribbon: down the left side, back up the right side.
    const ring = left.concat(right.reverse());
    const points: PathPoint[] = ring.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y] }));

    scene.transaction(() => {
        scene.replaceGeometryWithPath(nodeId, [{ points, closed: true }]);
        scene.setNodeStyleNoHistory(
            nodeId,
            JSON.stringify({ ...style, fills: [{ ...color }], strokes: [] }),
        );
    });
    return true;
}
