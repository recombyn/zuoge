/**
 * blend.ts — Illustrator-style Blend.
 *
 * Generates `steps` in-between shapes between two selected objects: the outer
 * contour is morphed and the fill color interpolated across the steps, and
 * everything (the two originals + the in-betweens) is grouped.
 *
 * Deliberately minimal — the whole feature reduces to a single "steps" field.
 * This is a static blend: it emits real, editable path nodes once (not a live
 * re-computing object). Both contours are sampled to a common point count in
 * world space so correspondence is stable regardless of each shape's transform.
 */
import type { CanvasKit } from 'canvaskit-wasm';
import { nodeToWorldPath } from './boolean_ops';
import type { Color, PathPoint, Subpath } from './types';
import type { WasmScene } from './wasm_scene';

const SAMPLES = 64;
const IDENTITY = {
    x: 0,
    y: 0,
    rotation_deg: 0,
    skew_x_deg: 0,
    skew_y_deg: 0,
    scale_x: 1,
    scale_y: 1,
};

interface Contour {
    pts: [number, number][];
    closed: boolean;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** World-space outer contour of a node (works for any shape — rect/ellipse/path/
 *  group), sampled to `n` points by arc length via CanvasKit's ContourMeasure. */
function worldContour(ck: CanvasKit, scene: WasmScene, id: number, n: number): Contour | null {
    const path = nodeToWorldPath(ck, scene, id);
    if (!path) return null;
    const iter = new ck.ContourMeasureIter(path, false, 1);
    const measure = iter.next();
    if (!measure) {
        iter.delete();
        path.delete();
        return null;
    }
    const len = measure.length();
    const closed = measure.isClosed();
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
        const denom = closed ? n : n - 1; // closed: don't duplicate the start point
        const posTan = measure.getPosTan((k / denom) * len);
        pts.push([posTan[0], posTan[1]]);
    }
    measure.delete();
    iter.delete();
    path.delete();
    return { pts, closed };
}

/** The node's first solid fill color, or null (gradients/patterns aren't lerped). */
function solidFill(scene: WasmScene, id: number): Color | null {
    const f = scene.getNodeStyle(id)?.fills?.[0] as
        | (Color & { gradient_type?: unknown; image_id?: unknown })
        | undefined;
    if (!f || typeof f.r !== 'number') return null;
    if ('gradient_type' in f || 'image_id' in f) return null;
    return f;
}

/**
 * Create `steps` in-between shapes between nodes A and B, grouped with them.
 * Returns the blend group id, or null if either shape has no usable contour.
 */
/** Compute the in-between blend outlines in WORLD space, without mutating the
 *  scene. Pure — also backs the live preview. Null if either shape can't sample. */
export function computeBlendSubpaths(
    ck: CanvasKit,
    scene: WasmScene,
    idA: number,
    idB: number,
    steps: number,
): Subpath[] | null {
    if (steps < 1 || !Number.isFinite(steps)) return null;
    const cA = worldContour(ck, scene, idA, SAMPLES);
    const cB = worldContour(ck, scene, idB, SAMPLES);
    if (!cA || !cB) return null;
    const closed = cA.closed && cB.closed;

    const out: Subpath[] = [];
    for (let i = 1; i <= steps; i++) {
        const t = i / (steps + 1);
        const points: PathPoint[] = [];
        for (let k = 0; k < SAMPLES; k++) {
            const x = lerp(cA.pts[k][0], cB.pts[k][0], t);
            const y = lerp(cA.pts[k][1], cB.pts[k][1], t);
            points.push({ x, y, cp1: [x, y], cp2: [x, y] });
        }
        out.push({ points, closed });
    }
    return out;
}

export function blendNodes(
    ck: CanvasKit,
    scene: WasmScene,
    idA: number,
    idB: number,
    steps: number,
): number | null {
    const subs = computeBlendSubpaths(ck, scene, idA, idB, steps);
    if (!subs) return null;
    const fillA = solidFill(scene, idA);
    const fillB = solidFill(scene, idB);

    let groupId = -1;
    scene.transaction(() => {
        const newIds: number[] = [];
        subs.forEach((sp, idx) => {
            const t = (idx + 1) / (steps + 1);
            // Duplicate A (keeps style), swap in world geometry + identity transform.
            const id = scene.duplicateNode(idA);
            scene.replaceGeometryWithPath(id, [sp]);
            scene.setNodeTransformComponents(id, IDENTITY);
            if (fillA && fillB) {
                const style = scene.getNodeStyle(id);
                const fill = {
                    r: lerp(fillA.r, fillB.r, t),
                    g: lerp(fillA.g, fillB.g, t),
                    b: lerp(fillA.b, fillB.b, t),
                    a: lerp(fillA.a ?? 1, fillB.a ?? 1, t),
                };
                scene.setNodeStyleNoHistory(id, JSON.stringify({ ...style, fills: [fill] }));
            }
            newIds.push(id);
        });
        groupId = scene.groupNodes([idA, ...newIds, idB]);
    });
    return groupId >= 0 ? groupId : null;
}
