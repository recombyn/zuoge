import type { WasmScene } from './wasm_scene';

/** A visual alignment guide produced by a snap, drawn by the Renderer.
 *  `axis: 'x'` is a vertical line at world x = pos; `axis: 'y'` is horizontal. */
export interface SnapGuide {
    axis: 'x' | 'y';
    pos: number;
}

export interface SnapDelta {
    dx: number;
    dy: number;
    guides: SnapGuide[];
}

/** A world-space clip region (from a mask) limiting where geometry is visible. */
interface ClipRect {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

/** Intersection of two clips; `null` on either side means "unclipped". The
 *  result may be empty (x1 <= x0 or y1 <= y0) — callers check with `clipEmpty`. */
function intersectClip(a: ClipRect | null, b: ClipRect | null): ClipRect | null {
    if (!a) return b;
    if (!b) return a;
    return {
        x0: Math.max(a.x0, b.x0),
        y0: Math.max(a.y0, b.y0),
        x1: Math.min(a.x1, b.x1),
        y1: Math.min(a.y1, b.y1),
    };
}

function clipEmpty(c: ClipRect | null): boolean {
    return !!c && (c.x1 <= c.x0 || c.y1 <= c.y0);
}

/**
 * Snapping engine for interactive drags (move / resize / draw).
 *
 * Targets are collected once at drag start (`begin`) from the artboard
 * (edges + center) and every top-level node's world bounds (edges + centers),
 * excluding the nodes being manipulated. Queries are then cheap per-frame.
 *
 * Holding Cmd/Ctrl during a drag bypasses snapping (checked by callers).
 */
export class SnapEngine {
    private xTargets: number[] = [];
    private yTargets: number[] = [];
    /** True 2D anchor points (path vertices) in world space. Snapped as whole
     *  points — both axes together — so a line endpoint lands exactly on
     *  another path's vertex instead of on a phantom edge×edge intersection. */
    private points: { x: number; y: number }[] = [];
    active: boolean = false;
    /** Grid spacing (world units) for snap-to-grid; 0 disables it. Persists
     *  across `begin()`/`end()` so a toggle set once stays in effect. */
    gridSize: number = 0;

    /**
     * Collect snap targets, excluding `excludeIds` and any root that contains
     * them. `excludeArtboardId` omits one artboard's edges (so a frame being
     * dragged/resized doesn't snap to itself).
     * `opts.skipArtboards` drops plate/document edges — pen free placement must
     * not collapse onto artboard corners via independent X/Y snaps.
     */
    /** Cached target set for idle-hover previews (see beginHover). */
    private hoverCache: { x: number[]; y: number[]; points: { x: number; y: number }[] } | null =
        null;
    private hoverCacheNoArtboards: {
        x: number[];
        y: number[];
        points: { x: number; y: number }[];
    } | null = null;
    private hoverCacheCounter = -1;
    private hoverCacheEngine: unknown = null;

    /**
     * Cap for `8/zoom` scene thresholds. Uncapped low zoom makes every click
     * inside a plate snap to an edge on each axis → only the four corners.
     * Matches product {@code SMART_SNAP_MAX_SCENE}.
     */
    static readonly SNAP_POINT_MAX_SCENE = 40;

    /**
     * `begin()` for idle-hover snap previews (pen/shape tools, no drag).
     *
     * Hover previews exclude nothing, so the target set only changes when the
     * scene does — but the naive path rebuilds it on EVERY mousemove, and the
     * rebuild serializes every path's geometry out of WASM as JSON
     * (getResolvedSubpaths per leaf). On a heavy document that alone blows the
     * frame budget while merely moving the cursor. Reuse the collected targets
     * until a mutation (changeCounter) or a document swap (engine identity)
     * invalidates them. `end()` only reassigns the working arrays, so the
     * cached ones survive.
     */
    beginHover(scene: WasmScene, opts?: { skipArtboards?: boolean }) {
        const skipArtboards = Boolean(opts?.skipArtboards);
        const cache = skipArtboards ? this.hoverCacheNoArtboards : this.hoverCache;
        if (
            cache &&
            this.hoverCacheCounter === scene.changeCounter &&
            this.hoverCacheEngine === scene.engine
        ) {
            this.xTargets = cache.x;
            this.yTargets = cache.y;
            this.points = cache.points;
            this.active = true;
            return;
        }
        this.begin(scene, [], undefined, { skipArtboards });
        const next = { x: this.xTargets, y: this.yTargets, points: this.points };
        if (skipArtboards) this.hoverCacheNoArtboards = next;
        else this.hoverCache = next;
        this.hoverCacheCounter = scene.changeCounter;
        this.hoverCacheEngine = scene.engine;
    }

    begin(
        scene: WasmScene,
        excludeIds: Iterable<number>,
        excludeArtboardId?: number,
        opts?: { skipArtboards?: boolean },
    ) {
        this.xTargets = [];
        this.yTargets = [];
        this.points = [];

        // Roots that are (or contain) a manipulated node don't participate.
        const excludedRoots = new Set<number>();
        for (const id of excludeIds) {
            let current = id;
            let root = id;
            while (current >= 0) {
                root = current;
                current = scene.getNodeParent(current);
            }
            excludedRoots.add(root);
        }

        // Artboard edges and centers — every artboard on the canvas (except one
        // being dragged, so it can't snap to its own edges).
        const skipArtboards = Boolean(opts?.skipArtboards);
        const artboards = skipArtboards ? [] : scene.getArtboards();
        if (!skipArtboards && artboards.length > 0) {
            for (const a of artboards) {
                if (a.id === excludeArtboardId) continue;
                this.xTargets.push(a.x, a.x + a.w / 2, a.x + a.w);
                this.yTargets.push(a.y, a.y + a.h / 2, a.y + a.h);
            }
        } else if (!skipArtboards) {
            const docW = scene.engine?.get_document_width() ?? 1000;
            const docH = scene.engine?.get_document_height() ?? 1000;
            this.xTargets.push(0, docW / 2, docW);
            this.yTargets.push(0, docH / 2, docH);
        }

        // Collect edges/centers/anchors from every LEAF shape, recursing into
        // groups so nested shapes (e.g. an expanded Live Paint group) each snap
        // as themselves — not just to their parent group's overall box.
        //
        // Only geometry the user can actually SEE may become a target. Snapping
        // to something invisible reads as the snap jumping to a random place:
        // hidden and locked subtrees are skipped, a Boolean Group contributes
        // its resolved outline instead of its (unpainted) operands, and masked
        // siblings are clipped to the mask before their edges are taken.
        const canAnchors =
            typeof scene.getResolvedSubpaths === 'function' &&
            typeof scene.getTransform === 'function';

        /** Push a rect's edges + centers, cropped to `clip` (the visible part). */
        const pushRect = (b: ArrayLike<number>, clip: ClipRect | null) => {
            let x0 = b[0];
            let y0 = b[1];
            let x1 = b[2];
            let y1 = b[3];
            if (clip) {
                x0 = Math.max(x0, clip.x0);
                y0 = Math.max(y0, clip.y0);
                x1 = Math.min(x1, clip.x1);
                y1 = Math.min(y1, clip.y1);
                if (x1 < x0 || y1 < y0) return; // entirely masked away
            }
            if (x1 <= x0 && y1 <= y0) return; // empty bounds
            this.xTargets.push(x0, (x0 + x1) / 2, x1);
            this.yTargets.push(y0, (y0 + y1) / 2, y1);
        };

        /** Push world-space subpath vertices as exact 2D anchors. */
        const pushAnchors = (
            subs: { points: { x: number; y: number }[] }[],
            t: ArrayLike<number>,
            clip: ClipRect | null,
        ) => {
            for (const sp of subs) {
                for (const p of sp.points) {
                    const x = t[0] * p.x + t[1] * p.y + t[2];
                    const y = t[3] * p.x + t[4] * p.y + t[5];
                    if (clip && (x < clip.x0 || x > clip.x1 || y < clip.y0 || y > clip.y1))
                        continue;
                    this.points.push({ x, y });
                }
            }
        };

        const collect = (id: number, clip: ClipRect | null) => {
            if (!scene.getNodeVisible(id)) return; // skips a hidden group's whole subtree
            if (scene.getNodeLocked?.(id)) return; // locked artwork is inert, snapping included
            if (clipEmpty(clip)) return; // masked away entirely

            // A Boolean Group paints ONE outline (its cached boolean result) and
            // never its operands, so the operand edges are phantoms — often on the
            // far side of the visible shape, which is exactly what makes a snap
            // look like it jumped to the opposite edge. Its own bounds already
            // hug the painted outline (compute_spatial_node special-cases it), so
            // it snaps as the leaf it looks like.
            if (scene.isBooleanGroup?.(id)) {
                pushRect(scene.getNodeBounds(id), clip);
                return;
            }

            const children = scene.getNodeChildren ? scene.getNodeChildren(id) : [];
            if (children.length > 0) {
                // Within a group, a visible mask clips every LATER sibling (the
                // ones painted above it) up to the next mask.
                let maskClip: ClipRect | null = null;
                for (const c of children) {
                    if (scene.getNodeIsMask?.(c) && scene.getNodeVisible(c)) {
                        const mb = scene.getNodeBounds(c);
                        maskClip = { x0: mb[0], y0: mb[1], x1: mb[2], y1: mb[3] };
                        collect(c, clip); // the mask shape bounds the visible result
                        continue;
                    }
                    collect(c, intersectClip(clip, maskClip));
                }
                return; // a group contributes only through its children
            }

            // Measured, so a guide off a text node's edge lands on the glyphs.
            // Collected once per drag (see begin/beginHover), so the walk this
            // costs for a group holding text is paid at grab time, not per
            // frame.
            pushRect(scene.getMeasuredNodeBounds?.(id) ?? scene.getNodeBounds(id), clip);

            // Path vertices as exact 2D snap points (endpoint chaining).
            if (canAnchors) {
                const subs = scene.getResolvedSubpaths(id);
                if (subs.length > 0) {
                    // row-major world [a,b,tx, c,d,ty, …]
                    pushAnchors(subs, scene.getTransform(id), clip);
                }
            }
        };
        for (const rootId of scene.getRootNodes()) {
            if (excludedRoots.has(rootId)) continue;
            collect(rootId, null);
        }

        // Ruler guides — a vertical guide snaps x, a horizontal guide snaps y.
        const guides = scene.getGuides?.();
        if (guides) {
            for (const gx of guides.x) this.xTargets.push(gx);
            for (const gy of guides.y) this.yTargets.push(gy);
        }

        this.active = true;
    }

    end() {
        this.active = false;
        this.xTargets = [];
        this.yTargets = [];
        this.points = [];
    }

    /** Nearest 2D anchor point to (x,y) within `threshold` (Euclidean), or null. */
    private nearestPoint(x: number, y: number, threshold: number): { x: number; y: number } | null {
        let best: { x: number; y: number } | null = null;
        let bestDist = threshold;
        for (const p of this.points) {
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bestDist) {
                bestDist = d;
                best = p;
            }
        }
        return best;
    }

    /** Nearest target to `value` within `threshold`, or null. */
    private nearest(targets: number[], value: number, threshold: number): number | null {
        let best: number | null = null;
        let bestDist = threshold;
        for (const t of targets) {
            const d = Math.abs(t - value);
            if (d < bestDist) {
                bestDist = d;
                best = t;
            }
        }
        // Snap-to-grid: hard lattice when enabled. Object/guide targets still
        // win when strictly closer (checked above with `<`), then the final
        // quantize in snapPoint/snapAxis locks placement onto the grid so
        // create/pen/artboard cannot sit between cells.
        if (this.gridSize > 0) {
            const g = Math.round(value / this.gridSize) * this.gridSize;
            const d = Math.abs(g - value);
            if (best === null || d < bestDist) {
                bestDist = d;
                best = g;
            }
        }
        return best;
    }

    /**
     * Snap a moving box: each axis independently tries its min, mid and max
     * against the targets and keeps the closest match. Returns the correction
     * to add to the box position, plus guides for the renderer.
     *
     * Object / artboard edges win here — `gridSize` is for create/pen (`snapPoint`)
     * only. A always-on 1wu lattice used to steal every move (nearest cell ≤0.5wu
     * beats almost every edge) and the hard origin lock then wiped real guides.
     */
    snapBounds(b: { x: number; y: number; w: number; h: number }, threshold: number): SnapDelta {
        const result: SnapDelta = { dx: 0, dy: 0, guides: [] };
        if (!this.active) return result;

        const xCandidates = [b.x, b.x + b.w / 2, b.x + b.w];
        const yCandidates = [b.y, b.y + b.h / 2, b.y + b.h];

        // Pause lattice so `nearest` only scores geometry/artboard targets.
        const savedGrid = this.gridSize;
        this.gridSize = 0;
        let bestDx: number | null = null;
        let bestXGuide = 0;
        let bestDy: number | null = null;
        let bestYGuide = 0;
        try {
            for (const c of xCandidates) {
                const t = this.nearest(this.xTargets, c, threshold);
                if (t !== null && (bestDx === null || Math.abs(t - c) < Math.abs(bestDx))) {
                    bestDx = t - c;
                    bestXGuide = t;
                }
            }
            for (const c of yCandidates) {
                const t = this.nearest(this.yTargets, c, threshold);
                if (t !== null && (bestDy === null || Math.abs(t - c) < Math.abs(bestDy))) {
                    bestDy = t - c;
                    bestYGuide = t;
                }
            }
        } finally {
            this.gridSize = savedGrid;
        }

        if (bestDx !== null) {
            result.dx = bestDx;
            result.guides.push({ axis: 'x', pos: bestXGuide });
        }
        if (bestDy !== null) {
            result.dy = bestDy;
            result.guides.push({ axis: 'y', pos: bestYGuide });
        }
        return result;
    }

    /** Snap a single point (shape-creation corner, dragged resize edge). */
    snapPoint(
        x: number,
        y: number,
        threshold: number,
    ): { x: number; y: number; guides: SnapGuide[] } {
        const guides: SnapGuide[] = [];
        const g = this.gridSize;
        // Cap uncapped `8/zoom` so low zoom cannot magnet the whole plate.
        const thr = Math.min(
            Math.max(0, threshold),
            SnapEngine.SNAP_POINT_MAX_SCENE,
        );
        if (!this.active) {
            if (g > 0) {
                return {
                    x: Math.round(x / g) * g,
                    y: Math.round(y / g) * g,
                    guides,
                };
            }
            return { x, y, guides };
        }

        // A true anchor wins over independent edge snapping so endpoints chain.
        const anchor = this.nearestPoint(x, y, thr);
        if (anchor) {
            x = anchor.x;
            y = anchor.y;
            guides.push({ axis: 'x', pos: anchor.x }, { axis: 'y', pos: anchor.y });
        } else {
            // Geometry first — lattice must not steal a nearby edge/center.
            const savedGrid = this.gridSize;
            this.gridSize = 0;
            let tx: number | null = null;
            let ty: number | null = null;
            try {
                tx = this.nearest(this.xTargets, x, thr);
                ty = this.nearest(this.yTargets, y, thr);
            } finally {
                this.gridSize = savedGrid;
            }
            if (tx !== null) {
                x = tx;
                guides.push({ axis: 'x', pos: tx });
            }
            if (ty !== null) {
                y = ty;
                guides.push({ axis: 'y', pos: ty });
            }
        }
        // Pen / shape / artboard create: fall back to grid cells when nothing else hit.
        if (g > 0 && guides.length === 0) {
            x = Math.round(x / g) * g;
            y = Math.round(y / g) * g;
        }
        return { x, y, guides };
    }

    /** Snap a single axis value. Returns the snapped value and guide, or null if no snap. */
    snapAxis(
        axis: 'x' | 'y',
        value: number,
        threshold: number,
    ): { value: number; guide: SnapGuide } | null {
        const g = this.gridSize;
        if (!this.active && !(g > 0)) return null;
        // Prefer geometry over lattice (same reason as snapBounds).
        let t: number | null = null;
        if (this.active) {
            const savedGrid = this.gridSize;
            this.gridSize = 0;
            try {
                t = this.nearest(axis === 'x' ? this.xTargets : this.yTargets, value, threshold);
            } finally {
                this.gridSize = savedGrid;
            }
        }
        if (t !== null) {
            return { value: t, guide: { axis, pos: t } };
        }
        if (g > 0) {
            const v = Math.round(value / g) * g;
            return { value: v, guide: { axis, pos: v } };
        }
        return null;
    }
}
