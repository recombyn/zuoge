/**
 * offset_path.ts — Illustrator "Object › Path › Offset Path".
 *
 * Creates a NEW path parallel to a selected path at `distance` world units
 * (positive = outset/grow, negative = inset/shrink). Non-destructive: the
 * offset is a new node above the original, carrying its style and transform.
 *
 * Implementation reuses the CanvasKit path-op machinery. Stroking the outline
 * yields a band of width 2·|d| centred on the path; unioning that band with the
 * filled shape grows it, subtracting shrinks it — CanvasKit resolves the joins
 * and any self-intersections. For an OPEN path the band itself is the closed
 * offset outline (matching Illustrator's behaviour).
 */
import type { CanvasKit, Path } from 'canvaskit-wasm';
import { appendSubpathsToPath, pathToSubpaths } from './boolean_ops';
import type { Subpath } from './types';
import type { WasmScene } from './wasm_scene';

/** Compute the offset outline for a path node, in the node's LOCAL space (the same
 *  space as its stored geometry). Pure — no scene mutation — so it also backs the
 *  live preview. Returns null if the path can't be offset. */
export function computeOffsetSubpaths(
    ck: CanvasKit,
    scene: WasmScene,
    nodeId: number,
    distance: number,
): { subpaths: Subpath[]; fillRule: number } | null {
    if (!distance || !Number.isFinite(distance)) return null;
    const geom = scene.getNodeGeometry(nodeId);
    const raw = geom?.Path?.subpaths;
    if (!raw || raw.length === 0) return null;
    // Offset the outline that is on screen, not the polygon its per-vertex
    // corner radii were rounding off — otherwise a rounded rectangle offsets
    // as a sharp one and the copy no longer matches the original.
    const resolved = scene.getResolvedSubpaths(nodeId);
    const subpaths = resolved.length === raw.length ? resolved : raw;

    const base = new ck.Path();
    appendSubpathsToPath(base, subpaths);

    // Stroke a copy of the outline into a band of width 2·|d|. stroke() mutates
    // the path in place and returns it (null on failure).
    const band = base.copy();
    if (
        !band.stroke({
            width: Math.abs(distance) * 2,
            join: ck.StrokeJoin.Round,
            cap: ck.StrokeCap.Round,
        })
    ) {
        base.delete();
        band.delete();
        return null;
    }

    const anyClosed = subpaths.some((s) => s.closed);
    let result: Path | null;
    if (!anyClosed) {
        // Open path: the band is already the closed offset outline.
        base.delete();
        result = band; // ownership transfers to `result`
    } else {
        const op = distance > 0 ? ck.PathOp.Union : ck.PathOp.Difference;
        result = ck.Path.MakeFromOp(base, band, op);
        base.delete();
        band.delete();
        if (!result) return null;
    }

    const offsetSubpaths = pathToSubpaths(ck, result);
    const fillRule = result.getFillType() === ck.FillType.EvenOdd ? 1 : 0;
    result.delete();
    if (offsetSubpaths.length === 0) return null;
    return { subpaths: offsetSubpaths, fillRule };
}

/** Offset the given path node by `distance`, creating a new parallel path directly
 *  BELOW the original (so the original stays on top). Returns the new node id, or
 *  null. One undo step. */
export function offsetPath(
    ck: CanvasKit,
    scene: WasmScene,
    nodeId: number,
    distance: number,
): number | null {
    const res = computeOffsetSubpaths(ck, scene, nodeId, distance);
    if (!res) return null;

    let newId = -1;
    scene.transaction(() => {
        // duplicate keeps the style + transform, but it also nudges the clone by
        // +20,+20 and drops it at the top of the stack — undo the nudge so the
        // offset is concentric, then tuck it directly below the original.
        newId = scene.duplicateNode(nodeId);
        scene.engine!.move_node(newId, -20, -20);
        scene.replaceGeometryWithPath(newId, res.subpaths);
        const style = scene.getNodeStyle(newId);
        scene.setNodeStyleNoHistory(newId, JSON.stringify({ ...style, fill_rule: res.fillRule }));

        // File it back beside the original — same parent, same space. Landing
        // it there by preserving the world position it had as a root would bake
        // in the root's reading of a local transform that belongs to a group.
        scene.fileCopyBesideOriginal(newId, nodeId);
        // ...then tuck it directly BELOW the original (an offset reads as an
        // outline around it, not a shape on top of it).
        const parent = scene.getNodeParent(nodeId); // -1 == root
        const siblings = parent < 0 ? scene.getRootNodes() : scene.getNodeChildren(parent);
        const idx = Array.from(siblings)
            .filter((c) => c !== newId)
            .indexOf(nodeId);
        if (idx >= 0 && parent < 0) scene.reorderNode(newId, null, idx);
        else if (idx >= 0) scene.engine!.reorder_nodes(JSON.stringify([newId]), parent, idx);
    });
    return newId >= 0 ? newId : null;
}
