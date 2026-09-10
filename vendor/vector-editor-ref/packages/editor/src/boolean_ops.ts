/**
 * Boolean path operations (union / subtract / intersect / exclude) built on
 * CanvasKit's Path.MakeFromOp. Input nodes are converted to world-space
 * CanvasKit paths, combined, and the result is parsed back into engine
 * subpaths via Path.toCmds().
 */
import type { CanvasKit, Path } from 'canvaskit-wasm';
import { logAppEvent } from './analytics';
import type { PathPoint, Subpath } from './types';
import type { WasmScene } from './wasm_scene';

export type BoolOp = 'union' | 'subtract' | 'intersect' | 'exclude';

/** Stable op ↔ engine index mapping (matches `node.boolean_op`: 0..3). */
export const BOOL_OP_BY_INDEX: readonly BoolOp[] = ['union', 'subtract', 'intersect', 'exclude'];
export const BOOL_OP_INDEX: Record<BoolOp, number> = {
    union: 0,
    subtract: 1,
    intersect: 2,
    exclude: 3,
};

/** Bezier circle constant: 4·(√2−1)/3 */
const KAPPA = 0.5522847498;

/**
 * Combine the given nodes (2+) with a boolean op and return the resulting
 * outline as engine subpaths in **world space**, plus the fill rule the result
 * expects. This is the shared core of both the destructive op and the
 * non-destructive Boolean Group's cached-outline recompute.
 *
 * Returns null only when the op **cannot be evaluated** — fewer than two
 * operands, a node with no path representation (text), or a CanvasKit failure.
 * An op that evaluates to nothing (Intersect on shapes with no common region)
 * is a *successful* empty result: `subpaths` is `[]`. Callers must tell the two
 * apart — a non-destructive group is still worth creating around an empty
 * result, but destroying the operands to produce nothing is not.
 */
export function computeBooleanSubpaths(
    ck: CanvasKit,
    scene: WasmScene,
    ids: number[],
    op: BoolOp,
): { subpaths: Subpath[]; fillRule: number } | null {
    if (ids.length < 2) return null;

    const paths: Path[] = [];
    for (const id of ids) {
        const p = nodeToWorldPath(ck, scene, id);
        if (p) paths.push(p);
        else {
            // Unsupported node in the selection (e.g. text) — abort cleanly
            for (const q of paths) q.delete();
            return null;
        }
    }

    const opMap = {
        union: ck.PathOp.Union,
        subtract: ck.PathOp.Difference,
        intersect: ck.PathOp.Intersect,
        exclude: ck.PathOp.XOR,
    } as const;

    let result = paths[0];
    for (let i = 1; i < paths.length; i++) {
        const combined = ck.Path.MakeFromOp(result, paths[i], opMap[op]);
        result.delete();
        paths[i].delete();
        if (!combined) {
            // Bailing here still owns every operand we haven't folded in yet.
            for (let j = i + 1; j < paths.length; j++) paths[j].delete();
            return null;
        }
        result = combined;
    }

    const subpaths = pathToSubpaths(ck, result);
    // MakeFromOp emits contours under this fill type (in practice EvenOdd,
    // with holes wound the same way) — the node style must match or holes
    // render and hit-test as filled.
    const fillRule = result.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
    result.delete();
    // subpaths may be empty (e.g. intersect of disjoint shapes). That's a real
    // answer, not a failure — see the note on this function.
    return { subpaths, fillRule };
}

/**
 * Apply a boolean operation destructively: the originals are replaced by a
 * single path node carrying the first node's style. Returns the new node id,
 * or null if the operation failed. (Non-destructive groups use
 * `computeBooleanSubpaths` directly — see WasmScene.makeBooleanGroup.)
 */
export function applyBooleanOp(
    ck: CanvasKit,
    scene: WasmScene,
    ids: number[],
    op: BoolOp,
): number | null {
    const res = computeBooleanSubpaths(ck, scene, ids, op);
    // An empty result would replace the operands with nothing — for a
    // *destructive* op that's indistinguishable from deleting the selection, so
    // decline. (The non-destructive Boolean Group keeps its operands and so is
    // happy to hold an empty outline; see WasmScene.makeBooleanGroup.)
    if (!res || res.subpaths.length === 0) return null;

    // Carry over the style of the first (bottom-most in selection order) node
    const styleData = scene.getNodeStyle(ids[0]);
    const styleJson = styleData ? JSON.stringify({ ...styleData, fill_rule: res.fillRule }) : null;

    const resultId = scene.replaceNodesWithPath(ids, JSON.stringify(res.subpaths), styleJson);
    if (resultId !== null) {
        logAppEvent('boolean_operation', { op: op, count: ids.length, type: 'destructive' });
    }
    return resultId;
}

/** Destructive Pathfinder ops that depend on stacking order (front vs back). */
export type PathfinderOp = 'minus-back' | 'crop';

/**
 * Pathfinder ops, resolved by z-order (front = topmost in root order):
 *  - **minus-back**: the front shape with everything behind it removed
 *    (front − union(rest)). Keeps the front's style.
 *  - **crop**: the parts of the lower shapes that fall inside the front shape,
 *    with the front discarded (union(rest) ∩ front). Keeps the bottom's style.
 * Replaces the selection with a single path. Returns the new id, or null.
 */
export function applyPathfinder(
    ck: CanvasKit,
    scene: WasmScene,
    ids: number[],
    op: PathfinderOp,
): number | null {
    if (ids.length < 2) return null;

    // Order by z: front (topmost, drawn last) first.
    const order = Array.from(scene.getRootNodes());
    const rank = (id: number) => order.indexOf(id);
    const sorted = [...ids].sort((a, b) => rank(b) - rank(a));
    const front = sorted[0];
    const rest = sorted.slice(1);

    const frontPath = nodeToWorldPath(ck, scene, front);
    if (!frontPath) return null;

    // Union of everything behind the front shape.
    let restUnion: Path | null = null;
    for (const id of rest) {
        const p = nodeToWorldPath(ck, scene, id);
        if (!p) {
            frontPath.delete();
            restUnion?.delete();
            return null;
        }
        if (!restUnion) {
            restUnion = p;
        } else {
            const u = ck.Path.MakeFromOp(restUnion, p, ck.PathOp.Union);
            restUnion.delete();
            p.delete();
            if (!u) {
                frontPath.delete();
                return null;
            }
            restUnion = u;
        }
    }
    if (!restUnion) {
        frontPath.delete();
        return null;
    }

    const result =
        op === 'minus-back'
            ? ck.Path.MakeFromOp(frontPath, restUnion, ck.PathOp.Difference)
            : ck.Path.MakeFromOp(restUnion, frontPath, ck.PathOp.Intersect);
    frontPath.delete();
    restUnion.delete();
    if (!result) return null;

    const subpaths = pathToSubpaths(ck, result);
    const fillRule = result.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
    result.delete();
    if (subpaths.length === 0) return null;

    // minus-back keeps the front's appearance; crop keeps the bottom shape's.
    const styleSource = op === 'minus-back' ? front : sorted[sorted.length - 1];
    const style = scene.getNodeStyle(styleSource);
    const styleJson = JSON.stringify({ ...style, fill_rule: fillRule });
    const resultId = scene.replaceNodesWithPath(ids, JSON.stringify(subpaths), styleJson);
    if (resultId !== null) {
        logAppEvent('boolean_operation', { op: op, count: ids.length, type: 'pathfinder' });
    }
    return resultId;
}

/**
 * Crop (Illustrator's Pathfinder Crop): clip every selected shape to the
 * frontmost one, **each result keeping its own appearance**.
 *
 * This is the one thing Boolean › Intersect cannot do. Intersect answers "what
 * area do all of these share" — one shape, one style. Crop answers "cut all of
 * these by that one": N shapes in, up to N out, each still its own object with
 * its own fill and stroke. Shapes that fall entirely outside the cutter come
 * back as nothing and are dropped.
 *
 * The front shape is the cookie cutter and is consumed, as in Illustrator.
 * Duplicate it first (⌘D) to keep a copy.
 *
 * Returns the new ids, front-most last. Returns `null` — leaving the document
 * untouched — when nothing overlapped the cutter: an op whose whole result is
 * "your selection is gone" is a mistake far more often than an intention.
 */
export function applyCrop(ck: CanvasKit, scene: WasmScene, ids: number[]): number[] | null {
    if (ids.length < 2) return null;

    // Order by z: front (topmost, drawn last) first — same rule as the other
    // pathfinders, so "the front one" means the same thing everywhere.
    const order = Array.from(scene.getRootNodes());
    const rank = (id: number) => order.indexOf(id);
    const sorted = [...ids].sort((a, b) => rank(b) - rank(a));
    const front = sorted[0];
    // Back-to-front, so re-adding them in order preserves their relative z.
    const rest = sorted.slice(1).reverse();

    const frontPath = nodeToWorldPath(ck, scene, front);
    if (!frontPath) return null;

    // Compute every piece BEFORE touching the document. A failure half-way
    // through would otherwise leave half the selection cropped and half not,
    // with no single thing to undo.
    const pieces: { subpaths: string; styleJson: string }[] = [];
    for (const id of rest) {
        const shape = nodeToWorldPath(ck, scene, id);
        if (!shape) continue;
        const clipped = ck.Path.MakeFromOp(shape, frontPath, ck.PathOp.Intersect);
        shape.delete();
        if (!clipped) continue;
        const subpaths = pathToSubpaths(ck, clipped);
        const fillRule = clipped.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
        clipped.delete();
        if (subpaths.length === 0) continue; // wholly outside the cutter
        const style = scene.getNodeStyle(id);
        pieces.push({
            subpaths: JSON.stringify(subpaths),
            styleJson: JSON.stringify({ ...style, fill_rule: fillRule }),
        });
    }
    frontPath.delete();
    if (pieces.length === 0) return null; // nothing overlapped — decline, don't empty the canvas

    const out: number[] = [];
    scene.transaction(() => {
        const eng = scene.engine!;
        eng.clear_selection();
        for (const id of ids) eng.remove_node(id); // the originals AND the cutter
        for (const piece of pieces) {
            const newId = eng.add_path(piece.subpaths);
            eng.set_node_style(newId, piece.styleJson);
            eng.select_node(newId, true);
            out.push(newId);
        }
    });
    logAppEvent('boolean_operation', { op: 'crop', count: ids.length, type: 'pathfinder' });
    return out;
}

/** Build a world-space CanvasKit path for a node (recursing into groups). */
export function nodeToWorldPath(ck: CanvasKit, scene: WasmScene, id: number): Path | null {
    const node = scene.getNode(id);
    if (!node) return null;

    // A nested Boolean Group contributes its *resolved* outline (already the
    // boolean of its own operands), not the union of its children — otherwise an
    // inner subtract/intersect would be flattened to a union here.
    const anyNode = node as unknown as { boolean_op?: number | null; bool_cache?: Subpath[] };
    if (anyNode.boolean_op && anyNode.bool_cache?.length) {
        const path = new ck.Path();
        appendSubpathsToPath(path, anyNode.bool_cache);
        const t = scene.getTransform(id);
        path.transform(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
        return path;
    }

    if (node.node_type === 'Group') {
        const acc = new ck.Path();
        const children = Array.from(scene.getNodeChildren(id));
        for (const childId of children) {
            const childPath = nodeToWorldPath(ck, scene, childId);
            if (childPath) {
                acc.addPath(childPath);
                childPath.delete();
            }
        }
        return acc;
    }

    const geometry = scene.getNodeGeometry(id);
    const style = scene.getNodeStyle(id);
    if (!geometry) return null; // node gone (undo, or a collaborator's delete)
    const path = new ck.Path();
    if (geometry.Rect) {
        const { width, height } = geometry.Rect;
        const r = style?.corner_radius || 0;
        if (r > 0) {
            path.addRRect(ck.RRectXY(ck.LTRBRect(0, 0, width, height), r, r));
        } else {
            path.addRect(ck.LTRBRect(0, 0, width, height));
        }
    } else if (geometry.Ellipse) {
        // Build with cubics (not addOval) so boolean results contain no conics
        const { radius_x: rx, radius_y: ry } = geometry.Ellipse;
        const kx = rx * KAPPA,
            ky = ry * KAPPA;
        path.moveTo(0, -ry);
        path.cubicTo(kx, -ry, rx, -ky, rx, 0);
        path.cubicTo(rx, ky, kx, ry, 0, ry);
        path.cubicTo(-kx, ry, -rx, ky, -rx, 0);
        path.cubicTo(-rx, -ky, -kx, -ry, 0, -ry);
        path.close();
    } else if (geometry.Path) {
        // Use the resolved outline so per-vertex corner radii are honoured in
        // the boolean result (matches what is rendered).
        const resolved = scene.getResolvedSubpaths(id);
        const subpaths = resolved.length ? resolved : geometry.Path.subpaths;
        appendSubpathsToPath(path, subpaths);
    } else {
        // Text and other geometries aren't supported in boolean ops
        path.delete();
        return null;
    }

    // Transform into world space (row-major 3x3 from the engine)
    const t = scene.getTransform(id);
    path.transform(t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7], t[8]);
    return path;
}

/** Append engine subpaths (cubic beziers via cp1/cp2) onto a CanvasKit path. */
export function appendSubpathsToPath(path: Path, subpaths: Subpath[]) {
    for (const sp of subpaths) {
        const pts = sp.points;
        if (pts.length < 2) continue;
        path.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) {
            const prev = pts[i - 1];
            const p = pts[i];
            path.cubicTo(prev.cp2[0], prev.cp2[1], p.cp1[0], p.cp1[1], p.x, p.y);
        }
        if (sp.closed) {
            const last = pts[pts.length - 1];
            const first = pts[0];
            path.cubicTo(last.cp2[0], last.cp2[1], first.cp1[0], first.cp1[1], first.x, first.y);
            path.close();
        }
    }
}

/**
 * Invert a row-major affine matrix (the 9-element form returned by
 * `WasmScene.getTransform`; the bottom row is assumed [0,0,1]). Returns the
 * inverse in the same row-major layout, or null if singular.
 */
export function invertAffine(t: ArrayLike<number>): number[] | null {
    const a = t[0],
        b = t[1],
        c = t[2];
    const d = t[3],
        e = t[4],
        f = t[5];
    const det = a * e - b * d;
    if (Math.abs(det) < 1e-12) return null;
    const ia = e / det,
        ib = -b / det;
    const id = -d / det,
        ie = a / det;
    const ic = (b * f - e * c) / det;
    const iff = (d * c - a * f) / det;
    return [ia, ib, ic, id, ie, iff, 0, 0, 1];
}

/** Apply a row-major affine matrix to a point [x,y]. */
function applyAffine(t: ArrayLike<number>, x: number, y: number): [number, number] {
    return [t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]];
}

/**
 * Transform every anchor and control point of `subpaths` by a row-major affine
 * matrix, returning fresh subpaths. Used to move a world-space boolean result
 * into a group's local frame (via `invertAffine(groupTransform)`).
 */
export function transformSubpaths(subpaths: Subpath[], t: ArrayLike<number>): Subpath[] {
    return subpaths.map((sp) => ({
        closed: sp.closed,
        points: sp.points.map((p) => {
            const [x, y] = applyAffine(t, p.x, p.y);
            const [c1x, c1y] = applyAffine(t, p.cp1[0], p.cp1[1]);
            const [c2x, c2y] = applyAffine(t, p.cp2[0], p.cp2[1]);
            return {
                ...p,
                x,
                y,
                cp1: [c1x, c1y] as [number, number],
                cp2: [c2x, c2y] as [number, number],
            };
        }),
    }));
}

/**
 * How far along its control polygon a cubic's handles sit when approximating a
 * conic of weight **w** — the one number that turns Skia's rational arcs back
 * into the cubics this engine stores.
 *
 * A conic of weight w is an affine image of a circular arc sweeping
 * θ = 2·acos(w), whose control point sits where the two endpoint tangents meet,
 * at r·tan(θ/2) from each end. The classic single-cubic arc approximation puts
 * each handle at (4/3)·r·tan(θ/4), so a handle lands this fraction of the way
 * from its endpoint toward the control point:
 *
 *     k = (4/3)·tan(θ/4) / tan(θ/2)
 *
 * At w = 1 the conic *is* a quadratic and k → 2/3, exactly the quad→cubic
 * degree elevation — so one formula covers both verbs. On the 90° arcs Skia
 * emits for round joins, caps, ovals and rounded rects this is accurate to
 * 0.03% of the radius; treating the conic as a plain quadratic (k = 2/3, which
 * is what this used to do) is off by 6%, enough to visibly fatten every
 * rounded corner that survives a boolean op, Crop, Offset Path or Flatten.
 */
export function conicHandleRatio(w: number): number {
    // w ≥ 1 is a parabola or hyperbola, not an arc; w ≤ 0 would be a ≥180° sweep
    // that Skia never emits. Both fall back to the quadratic elevation.
    if (!Number.isFinite(w) || w >= 1 - 1e-6 || w <= 0) return 2 / 3;
    const theta = 2 * Math.acos(w);
    return ((4 / 3) * Math.tan(theta / 4)) / Math.tan(theta / 2);
}

/** Parse a CanvasKit path back into engine subpaths via toCmds(). */
export function pathToSubpaths(ck: CanvasKit, path: Path): Subpath[] {
    const cmds = path.toCmds();

    const ckAny = ck as unknown as Record<string, number>;
    const MOVE = ckAny.MOVE_VERB ?? 0;
    const LINE = ckAny.LINE_VERB ?? 1;
    const QUAD = ckAny.QUAD_VERB ?? 2;
    const CONIC = ckAny.CONIC_VERB ?? 3;
    const CUBIC = ckAny.CUBIC_VERB ?? 4;
    const CLOSE = ckAny.CLOSE_VERB ?? 5;
    const ARG_COUNT: Record<number, number> = {
        [MOVE]: 2,
        [LINE]: 2,
        [QUAD]: 4,
        [CONIC]: 5,
        [CUBIC]: 6,
        [CLOSE]: 0,
    };

    const subpaths: Subpath[] = [];
    let current: PathPoint[] = [];
    let closed = false;

    const flush = () => {
        if (current.length >= 2) {
            subpaths.push({ points: current, closed });
        }
        current = [];
        closed = false;
    };
    const pt = (x: number, y: number): PathPoint => ({ x, y, cp1: [x, y], cp2: [x, y] });

    let i = 0;
    const n = cmds.length;
    while (i < n) {
        const verb = cmds[i++];
        const argc = ARG_COUNT[verb];
        if (argc === undefined) break; // unknown verb — stop parsing defensively
        const args: number[] = [];
        for (let a = 0; a < argc; a++) args.push(cmds[i++]);

        if (verb === MOVE) {
            flush();
            current.push(pt(args[0], args[1]));
        } else if (verb === LINE) {
            current.push(pt(args[0], args[1]));
        } else if (verb === CUBIC) {
            const prev = current[current.length - 1];
            if (prev) prev.cp2 = [args[0], args[1]];
            const p = pt(args[4], args[5]);
            p.cp1 = [args[2], args[3]];
            current.push(p);
        } else if (verb === QUAD || verb === CONIC) {
            // Elevate quad — or approximate conic — to cubic. Both share the
            // control polygon P0→Q→E; only how far along it the handles sit
            // differs, and that is what the weight decides.
            const prev = current[current.length - 1];
            const p0x = prev ? prev.x : args[0];
            const p0y = prev ? prev.y : args[1];
            const qx = args[0],
                qy = args[1];
            const ex = args[2],
                ey = args[3];
            const k = verb === CONIC ? conicHandleRatio(args[4]) : 2 / 3;
            const c1x = p0x + k * (qx - p0x);
            const c1y = p0y + k * (qy - p0y);
            const c2x = ex + k * (qx - ex);
            const c2y = ey + k * (qy - ey);
            if (prev) prev.cp2 = [c1x, c1y];
            const p = pt(ex, ey);
            p.cp1 = [c2x, c2y];
            current.push(p);
        } else if (verb === CLOSE) {
            // Drop an explicit closing point that duplicates the start
            if (current.length >= 2) {
                const first = current[0];
                const last = current[current.length - 1];
                if (Math.abs(first.x - last.x) < 1e-3 && Math.abs(first.y - last.y) < 1e-3) {
                    first.cp1 = last.cp1;
                    current.pop();
                }
            }
            closed = true;
            flush();
        }
    }
    flush();
    return subpaths;
}
