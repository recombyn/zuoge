/**
 * outline_stroke.ts — Convert a path's stroke into a filled outline shape.
 *
 * Leverages CanvasKit's Path.stroke() to compute the offset outline, then
 * replaces the node's geometry with the outlined path and swaps the style:
 * fill = old stroke color, stroke = none.
 *
 * The job is to produce the shape the user was already looking at. That means
 * honouring everything the renderer honours — corner radii, dash pattern and
 * stroke alignment — because a Flatten that quietly squares off a rounded
 * corner or re-centres an inside stroke has changed the drawing, not expanded
 * it.
 */

import type { CanvasKit, Path } from 'canvaskit-wasm';
import { appendSubpathsToPath, pathToSubpaths } from './boolean_ops';
import { dashIntervals } from './dash';
import {
    type NodeGeometry,
    type NodeStyle,
    type Stroke,
    StrokeAlignment,
    type Subpath,
} from './types';
import type { WasmScene } from './wasm_scene';

/** Bezier circle constant: 4·(√2−1)/3 */
const KAPPA = 0.5522847498;

/**
 * Convert a path node's stroke into a filled outline shape.
 *
 * The outline is computed using CanvasKit's `Path.stroke()`, which handles all
 * the complex offset geometry (miter joins, round caps, etc.).  The resulting
 * outline replaces the node's geometry and the style is updated so that
 * fill = old stroke color and stroke = none.
 *
 * @param ck     CanvasKit instance.
 * @param scene  The WASM scene wrapper.
 * @param nodeId ID of the path node to outline.
 */
export function outlineStroke(ck: CanvasKit, scene: WasmScene, nodeId: number): void {
    const geometry = scene.getNodeGeometry(nodeId);
    const style = scene.getNodeStyle(nodeId);
    if (!geometry || !style || style.strokes.length === 0 || style.strokes[0].width <= 0) return;
    const stroke = style.strokes[0];

    // Work in local space — the node keeps its own transform.
    const base = buildBasePath(ck, scene, nodeId, geometry, style);
    if (!base) return;

    const subpaths = strokeToSubpaths(ck, base, stroke);
    base.delete();
    if (!subpaths || subpaths.length === 0) return;

    // Update the node: geometry = outlined path, fill = old stroke, stroke = none
    scene.updatePathPoints(nodeId, JSON.stringify(subpaths));

    const newStyle = {
        ...style,
        fills: stroke.paint ? [stroke.paint] : [],
        strokes: [],
    };
    scene.setNodeStyleNoHistory(nodeId, JSON.stringify(newStyle));
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * The node's fill outline in local space — the shape the stroke runs along.
 *
 * For paths this is the **resolved** outline, so per-vertex corner radii are
 * part of the geometry being stroked. Reading the raw subpaths instead would
 * outline the polygon the radii were rounding off, which is how a rounded
 * rectangle used to come back from Flatten with four sharp corners.
 */
function buildBasePath(
    ck: CanvasKit,
    scene: WasmScene,
    nodeId: number,
    geometry: NodeGeometry,
    style: NodeStyle,
): Path | null {
    const path = new ck.Path();

    if (geometry.Path) {
        const resolved = scene.getResolvedSubpaths(nodeId);
        appendSubpathsToPath(path, resolved.length ? resolved : geometry.Path.subpaths);
    } else if (geometry.Rect) {
        const { width, height } = geometry.Rect;
        const r = style.corner_radius || 0;
        if (r > 0) {
            path.addRRect(ck.RRectXY(ck.LTRBRect(0, 0, width, height), r, r));
        } else {
            path.addRect(ck.LTRBRect(0, 0, width, height));
        }
    } else if (geometry.Ellipse) {
        // Cubics rather than addOval: the four cardinal anchors match what
        // Convert to Path produces, so outlining an ellipse and outlining the
        // same ellipse after converting it give the same anchors.
        const { radius_x: rx, radius_y: ry } = geometry.Ellipse;
        const kx = rx * KAPPA,
            ky = ry * KAPPA;
        path.moveTo(0, -ry);
        path.cubicTo(kx, -ry, rx, -ky, rx, 0);
        path.cubicTo(rx, ky, kx, ry, 0, ry);
        path.cubicTo(-kx, ry, -rx, ky, -rx, 0);
        path.cubicTo(-rx, -ky, -kx, -ry, 0, -ry);
        path.close();
    } else {
        path.delete();
        return null; // text, image or unsupported geometry
    }

    if (path.isEmpty()) {
        path.delete();
        return null;
    }
    return path;
}

/** Outline one stroke of `base`, applying its dash pattern and alignment. */
function strokeToSubpaths(ck: CanvasKit, base: Path, stroke: Stroke): Subpath[] | null {
    // Map stroke cap: 0 = Butt, 1 = Round, 2 = Square
    const capMap = [ck.StrokeCap.Butt, ck.StrokeCap.Round, ck.StrokeCap.Square];
    // Map stroke join: 0 = Miter, 1 = Round, 2 = Bevel
    const joinMap = [ck.StrokeJoin.Miter, ck.StrokeJoin.Round, ck.StrokeJoin.Bevel];

    // Dashes first — the outline of a dashed stroke is the outline of its
    // dashes, so the gaps have to be cut before the width is applied.
    const dashed = dashPath(ck, base, stroke);

    const inner = stroke.alignment === StrokeAlignment.Inner;
    const outer = stroke.alignment === StrokeAlignment.Outer;
    // Inner/Outer draw a double-width stroke and throw away the half that falls
    // on the wrong side of the fill — exactly what the renderer does, so the
    // outline lands where the stroke was drawn instead of straddling the edge.
    const width = inner || outer ? stroke.width * 2 : stroke.width;

    // stroke() rewrites its receiver in place, so work on a copy: `base` is
    // still needed as the clip for Inner/Outer.
    const outlined = (dashed ?? base).copy();
    dashed?.delete();
    const ok = outlined.stroke({
        width,
        miter_limit: stroke.miter_limit || 4,
        cap: capMap[stroke.cap] ?? ck.StrokeCap.Butt,
        join: joinMap[stroke.join] ?? ck.StrokeJoin.Miter,
    });
    if (!ok) {
        outlined.delete();
        return null;
    }

    let result = outlined;
    if (inner || outer) {
        const clipped = ck.Path.MakeFromOp(
            outlined,
            base,
            inner ? ck.PathOp.Intersect : ck.PathOp.Difference,
        );
        outlined.delete();
        if (!clipped) return null;
        result = clipped;
    }

    const subpaths = pathToSubpaths(ck, result);
    result.delete();
    return subpaths;
}

/**
 * The "on" runs of a dashed stroke, as a new path — or null when the stroke
 * isn't dashed.
 *
 * CanvasKit's `Path.stroke()` takes no path effect, so the dashing has to
 * happen up front. Walking the contours with ContourMeasure and keeping the
 * lit intervals is what `SkDashPathEffect` does internally, and it follows
 * curves exactly rather than approximating along the control polygon.
 */
function dashPath(ck: CanvasKit, path: Path, stroke: Stroke): Path | null {
    // The same rule the renderer draws by — shared so an outline can't disagree
    // with the dashes it is supposed to be replacing.
    const pattern = dashIntervals(stroke.dash_array);
    if (!pattern) return null;
    const period = pattern.reduce((a, b) => a + b, 0);

    // dash_offset shifts the pattern backwards along the contour; normalise it
    // into one period so a large offset doesn't cost a long spin-up.
    const phase = (((stroke.dash_offset ?? 0) % period) + period) % period;

    const out = new ck.Path();
    const iter = new ck.ContourMeasureIter(path, false, 1);
    for (let measure = iter.next(); measure; measure = iter.next()) {
        const total = measure.length();
        let distance = -phase;
        let i = 0;
        let on = true;
        // Every full pass through the pattern advances by `period` > 0, so this
        // terminates; the bound is only a guard against a pathological path.
        const maxSteps = Math.ceil((total + period) / period) * pattern.length + 4;
        for (let step = 0; distance < total && step < maxSteps; step++) {
            const end = distance + pattern[i % pattern.length];
            if (on) {
                const s = Math.max(0, distance);
                const e = Math.min(total, end);
                if (e > s) {
                    const piece = measure.getSegment(s, e, true);
                    out.addPath(piece);
                    piece.delete();
                }
            }
            distance = end;
            on = !on;
            i++;
        }
        measure.delete();
    }
    iter.delete();
    // May be empty if every lit run fell outside the contour; the caller then
    // finds nothing to outline and leaves the node alone.
    return out;
}
