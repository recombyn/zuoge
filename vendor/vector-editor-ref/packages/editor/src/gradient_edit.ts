/**
 * Gradient editing controller — shared state and logic for editing a gradient
 * fill both from the Fill panel (ramp UI) and directly on the canvas
 * (start/end handles + stop dots along the gradient axis).
 *
 * Owned by UIEngine (`ui.gradientEdit`). The InputManager routes canvas mouse
 * events here, and the Renderer reads the state to draw the overlay.
 *
 * Gradient coordinates (start_x/start_y/end_x/end_y) are usually NODE-LOCAL;
 * all hit-testing converts through the node's world transform, so handles
 * follow the shape under move/rotate/skew. A rotated or elliptical radial is
 * the exception — it keeps raw gradient-space coordinates and a `transform`
 * mapping them into the node — so the conversion composes that in as well
 * (see `gradientToWorld()`).
 *
 * A Live Paint FACE is the second kind of target. Only three things differ —
 * where the gradient is read from, what transform relates it to the world, and
 * where it is written back — so the handles, dragging, stop insert/delete and
 * angle snapping are shared verbatim rather than reimplemented. A face carries
 * no transform of its own (its outline is already world space), so the
 * local↔world conversion is the identity for one.
 */

import type { Color, Gradient, GradientStop } from './types';
import { isGradient } from './types';
import type { WasmScene } from './wasm_scene';

/** What a canvas hit-test resolved to. */
export type GradientHit =
    | { type: 'start' }
    | { type: 'end' }
    | { type: 'stop'; stopIndex: number }
    /** Click on the axis line between handles → insert a stop at offset `t`. */
    | { type: 'insert'; t: number };

/** Linear interpolation of the gradient's color at offset `t` (0..1). */
export function sampleGradientColor(grad: Gradient, t: number): Color {
    const sorted = [...grad.stops].sort((a, b) => a.offset - b.offset);
    if (sorted.length === 0) return { r: 0.5, g: 0.5, b: 0.5, a: 1 };
    if (t <= sorted[0].offset) return { ...sorted[0].color };
    const last = sorted[sorted.length - 1];
    if (t >= last.offset) return { ...last.color };
    for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i],
            b = sorted[i + 1];
        if (t >= a.offset && t <= b.offset) {
            const span = b.offset - a.offset;
            const k = span < 1e-6 ? 0 : (t - a.offset) / span;
            return {
                r: a.color.r + (b.color.r - a.color.r) * k,
                g: a.color.g + (b.color.g - a.color.g) * k,
                b: a.color.b + (b.color.b - a.color.b) * k,
                a: (a.color.a ?? 1) + ((b.color.a ?? 1) - (a.color.a ?? 1)) * k,
            };
        }
    }
    return { ...last.color };
}

export class GradientEditController {
    private scene: WasmScene;

    /** Node whose gradient fill is being edited (null = inactive, or a face). */
    nodeId: number | null = null;
    /**
     * A point inside the Live Paint region being edited, when the target is a
     * region rather than a node. Exactly one of `nodeId` / `faceAnchor` is set.
     *
     * An ANCHOR, not a face id, because face ids are regenerated on every
     * network rebuild — painting a region rebuilds it, so a stored id is stale
     * by the time the handles are first drawn. The region is re-resolved from
     * this point on every access instead.
     */
    faceAnchor: { x: number; y: number } | null = null;

    /** The region currently under `faceAnchor`, or null if it no longer exists
     *  (its bounding shapes were moved or deleted). */
    get faceId(): number | null {
        if (!this.faceAnchor) return null;
        const id = this.scene.queryFaceAt(this.faceAnchor.x, this.faceAnchor.y);
        return id >= 0 ? id : null;
    }
    /** Index into the node's fills array. */
    fillIndex = 0;
    /** Selected stop (index into the stops array, not sorted order). */
    stopIndex = 0;
    /** True when the user explicitly clicked a stop — Delete/Backspace then
     *  removes the stop instead of the node. */
    stopFocused = false;

    /** Active canvas drag: the grabbed handle plus a snapshot of the gradient
     *  and the pointer's local position at drag start. */
    private drag: {
        hit: GradientHit;
        orig: Gradient;
        startLocal: { x: number; y: number };
    } | null = null;

    constructor(scene: WasmScene) {
        this.scene = scene;
    }

    // ─── Activation / lifecycle ──────────────────────────────────────────

    isActive(): boolean {
        return (this.nodeId !== null || this.faceId !== null) && this.gradient() !== null;
    }

    activate(nodeId: number, fillIndex: number, stopIndex = 0) {
        if (this.nodeId !== nodeId || this.fillIndex !== fillIndex) this.stopFocused = false;
        this.nodeId = nodeId;
        this.faceAnchor = null;
        this.fillIndex = fillIndex;
        this.stopIndex = stopIndex;
        this.scene.renderer?.requestRender();
    }

    /** Edit the gradient of the Live Paint region containing `world`. No-op
     *  unless that region exists and has a gradient. */
    activateFace(world: { x: number; y: number }) {
        this.nodeId = null;
        this.faceAnchor = { x: world.x, y: world.y };
        this.fillIndex = 0;
        this.stopIndex = 0;
        this.stopFocused = false;
        if (!this.gradient()) {
            this.faceAnchor = null;
            return;
        }
        this.scene.renderer?.requestRender();
    }

    clear() {
        this.nodeId = null;
        this.faceAnchor = null;
        this.fillIndex = 0;
        this.stopIndex = 0;
        this.stopFocused = false;
        this.drag = null;
    }

    /**
     * Reconcile with the current selection: keep the active target while it is
     * still a gradient fill on the (single) selected node; otherwise auto-
     * target the node's first gradient fill, or deactivate.
     */
    syncSelection() {
        // A face target has nothing to do with the selection — a Live Paint
        // region is not a node and painting deliberately leaves the selection
        // empty. Reconciling one against the selection cleared the handles the
        // moment anything called syncWithSelection, which is to say instantly.
        if (this.faceAnchor) {
            if (!this.gradient()) this.clear();
            return;
        }
        const sel = this.scene.getSelection();
        if (sel.length !== 1) {
            this.clear();
            return;
        }
        const id = sel[0];
        const node = this.scene.getNode(id);
        const fills = node?.style.fills ?? [];

        if (this.nodeId === id) {
            const fill = fills[this.fillIndex];
            if (fill && isGradient(fill)) {
                this.stopIndex = Math.min(this.stopIndex, fill.stops.length - 1);
                if (this.stopIndex < 0) this.stopIndex = 0;
                return;
            }
        }
        const gi = fills.findIndex((f) => isGradient(f));
        if (gi >= 0) {
            this.stopFocused = false;
            this.nodeId = id;
            this.fillIndex = gi;
            this.stopIndex = 0;
        } else {
            this.clear();
        }
    }

    /** Fresh read of the edited gradient (or null when state went stale). */
    gradient(): Gradient | null {
        if (this.faceAnchor) {
            const id = this.faceId;
            if (id === null) return null;
            const paint = this.scene.getFacePaint(id);
            return paint && isGradient(paint) ? paint : null;
        }
        if (this.nodeId === null) return null;
        const node = this.scene.getNode(this.nodeId);
        const fill = node?.style.fills?.[this.fillIndex];
        return fill && isGradient(fill) ? fill : null;
    }

    // ─── Coordinate transforms (node-local ↔ world) ─────────────────────

    /**
     * Gradient space → world, in Skia row-major layout (see
     * WasmScene.getTransform).
     *
     * Usually a gradient's coordinates already ARE node-local, so this is just
     * the node's world transform. A rotated or elliptical radial is the
     * exception: it stores raw gradient-space coordinates plus the affine that
     * maps them into the node — the same matrix the renderer hands Skia as the
     * shader's local matrix. Leaving it out draws the handles for a gradient
     * nobody can see; a `gradientTransform="scale(2,1)"` off an SVG import puts
     * them a hundred units from the paint they belong to, and dragging one
     * writes that error back into the document.
     */
    gradientToWorld(): Float32Array {
        // A face outline is already world space — nothing to convert through.
        const world = this.faceAnchor
            ? new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])
            : this.scene.getTransform(this.nodeId!);

        const g = this.gradient()?.transform;
        if (!g || g.length < 6) return world;
        // SVG affine [a,b,c,d,e,f] (x' = a·x + c·y + e) as a row-major 3×3.
        const [a, b, c, d, e, f] = g;
        // world ∘ gradientToLocal — gradient space first, then out to the world.
        return new Float32Array([
            world[0] * a + world[1] * b,
            world[0] * c + world[1] * d,
            world[0] * e + world[1] * f + world[2],
            world[3] * a + world[4] * b,
            world[3] * c + world[4] * d,
            world[3] * e + world[4] * f + world[5],
            0,
            0,
            1,
        ]);
    }

    localToWorld(x: number, y: number): { x: number; y: number } {
        const t = this.gradientToWorld();
        return { x: t[0] * x + t[1] * y + t[2], y: t[3] * x + t[4] * y + t[5] };
    }

    worldToLocal(wx: number, wy: number): { x: number; y: number } {
        const t = this.gradientToWorld();
        const a = t[0],
            b = t[1],
            c = t[2];
        const d = t[3],
            e = t[4],
            f = t[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return { x: wx, y: wy };
        return {
            x: (e * (wx - c) - b * (wy - f)) / det,
            y: (a * (wy - f) - d * (wx - c)) / det,
        };
    }

    /** Gradient endpoints in world space. */
    endpoints(grad: Gradient): { p0: { x: number; y: number }; p1: { x: number; y: number } } {
        return {
            p0: this.localToWorld(grad.start_x, grad.start_y),
            p1: this.localToWorld(grad.end_x, grad.end_y),
        };
    }

    // ─── Canvas hit-testing ──────────────────────────────────────────────

    /**
     * Hit-test the on-canvas gradient handles at a world position.
     * Priority: endpoints → stops → axis line (insert).
     */
    hitTest(world: { x: number; y: number }, zoom: number): GradientHit | null {
        const grad = this.gradient();
        if (!grad) return null;
        const { p0, p1 } = this.endpoints(grad);

        if (Math.hypot(world.x - p0.x, world.y - p0.y) < 9 / zoom) return { type: 'start' };
        if (Math.hypot(world.x - p1.x, world.y - p1.y) < 9 / zoom) return { type: 'end' };

        // Stops sit on the axis at their offset
        let best: { i: number; d: number } | null = null;
        for (let i = 0; i < grad.stops.length; i++) {
            const t = grad.stops[i].offset;
            const sx = p0.x + (p1.x - p0.x) * t;
            const sy = p0.y + (p1.y - p0.y) * t;
            const d = Math.hypot(world.x - sx, world.y - sy);
            if (d < 7 / zoom && (!best || d < best.d)) best = { i, d };
        }
        if (best) return { type: 'stop', stopIndex: best.i };

        // Axis line → insert a stop at the projected offset
        const dx = p1.x - p0.x,
            dy = p1.y - p0.y;
        const len2 = dx * dx + dy * dy;
        if (len2 > 1e-9) {
            const t = ((world.x - p0.x) * dx + (world.y - p0.y) * dy) / len2;
            if (t > 0.02 && t < 0.98) {
                const px = p0.x + dx * t,
                    py = p0.y + dy * t;
                if (Math.hypot(world.x - px, world.y - py) < 5 / zoom) {
                    return { type: 'insert', t };
                }
            }
        }
        return null;
    }

    // ─── Canvas drags ────────────────────────────────────────────────────

    /** True while a canvas handle drag is in flight. */
    isDragging(): boolean {
        return this.drag !== null;
    }

    beginDrag(hit: GradientHit, world: { x: number; y: number }) {
        const grad = this.gradient();
        if (!grad) return;
        if (hit.type === 'stop') {
            this.stopIndex = hit.stopIndex;
            this.stopFocused = true;
        }
        this.scene.beginGesture();
        this.drag = {
            hit,
            orig: cloneGradient(grad),
            startLocal: this.worldToLocal(world.x, world.y),
        };
    }

    /** Insert a stop at offset `t` and start dragging it — one undo step for
     *  the whole add+drag gesture. */
    beginInsertDrag(t: number, world: { x: number; y: number }) {
        const grad = this.gradient();
        if (!grad) return;
        this.scene.beginGesture();
        const orig = cloneGradient(grad);
        const newIndex = orig.stops.length;
        orig.stops.push({ offset: t, color: sampleGradientColor(orig, t) });
        this.writeLive((g) => {
            g.stops = orig.stops.map(cloneStop);
        });
        this.stopIndex = newIndex;
        this.stopFocused = true;
        this.drag = {
            hit: { type: 'stop', stopIndex: newIndex },
            orig,
            startLocal: this.worldToLocal(world.x, world.y),
        };
    }

    moveDrag(world: { x: number; y: number }, shiftKey: boolean) {
        // A face target has no nodeId — the guard is "is anything targeted",
        // not "is a node targeted".
        if (!this.drag || (this.nodeId === null && !this.faceAnchor)) return;
        const { hit, orig, startLocal } = this.drag;
        const local = this.worldToLocal(world.x, world.y);

        if (hit.type === 'start') {
            if (orig.gradient_type === 'Radial') {
                // Center handle: translate the whole gradient, radius unchanged
                const dx = local.x - startLocal.x,
                    dy = local.y - startLocal.y;
                this.writeLive((g) => {
                    g.start_x = orig.start_x + dx;
                    g.start_y = orig.start_y + dy;
                    g.end_x = orig.end_x + dx;
                    g.end_y = orig.end_y + dy;
                });
            } else {
                const p = shiftKey
                    ? this.snapToAngle(world, this.localToWorld(orig.end_x, orig.end_y))
                    : local;
                const snapped = shiftKey ? this.worldToLocal(p.x, p.y) : p;
                this.writeLive((g) => {
                    g.start_x = snapped.x;
                    g.start_y = snapped.y;
                });
            }
        } else if (hit.type === 'end') {
            const p = shiftKey
                ? this.snapToAngle(world, this.localToWorld(orig.start_x, orig.start_y))
                : local;
            const snapped = shiftKey ? this.worldToLocal(p.x, p.y) : p;
            this.writeLive((g) => {
                g.end_x = snapped.x;
                g.end_y = snapped.y;
            });
        } else if (hit.type === 'stop') {
            // Project the cursor onto the (original) axis for the new offset
            const dx = orig.end_x - orig.start_x,
                dy = orig.end_y - orig.start_y;
            const len2 = dx * dx + dy * dy;
            if (len2 < 1e-9) return;
            let t = ((local.x - orig.start_x) * dx + (local.y - orig.start_y) * dy) / len2;
            t = Math.max(0, Math.min(1, t));
            if (shiftKey) t = Math.round(t * 10) / 10; // 10% increments
            const i = hit.stopIndex;
            this.writeLive((g) => {
                if (g.stops[i]) g.stops[i].offset = t;
            });
        }
    }

    endDrag() {
        if (!this.drag) return;
        this.drag = null;
        this.scene.endGesture();
    }

    /** Abort an in-flight drag and restore the pre-drag state. */
    cancelDrag() {
        if (!this.drag) return;
        this.drag = null;
        this.scene.endGesture();
        this.scene.undo();
    }

    /** Snap `world` to 45° increments around `anchor` (world space), keeping distance. */
    private snapToAngle(
        world: { x: number; y: number },
        anchor: { x: number; y: number },
    ): { x: number; y: number } {
        const dx = world.x - anchor.x,
            dy = world.y - anchor.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) return world;
        const step = Math.PI / 4;
        const a = Math.round(Math.atan2(dy, dx) / step) * step;
        return { x: anchor.x + Math.cos(a) * len, y: anchor.y + Math.sin(a) * len };
    }

    /** Replace the stop list without pushing history — used by the panel's
     *  ramp drag (bracketed by scene.beginGesture/endGesture). */
    setStopsLive(stops: GradientStop[]) {
        this.writeLive((g) => {
            g.stops = stops.map(cloneStop);
        });
    }

    // ─── Discrete stop edits (used by Delete key) ────────────────────────

    /** Delete a stop (keeps a 2-stop minimum). Returns true if deleted. */
    deleteStop(i: number): boolean {
        const grad = this.gradient();
        if (!grad || grad.stops.length <= 2 || i < 0 || i >= grad.stops.length) return false;
        this.scene.transaction(() => {
            this.writeLive((g) => {
                g.stops.splice(i, 1);
            });
        });
        this.stopIndex = Math.max(0, Math.min(this.stopIndex, grad.stops.length - 2));
        this.stopFocused = false;
        return true;
    }

    // ─── Style write-through ─────────────────────────────────────────────

    /** Mutate the edited gradient on a fresh style read and write it back
     *  without pushing history (callers bracket with gesture/transaction). */
    private writeLive(mutate: (g: Gradient) => void) {
        if (this.faceAnchor) {
            const id = this.faceId;
            const current = this.gradient();
            if (id === null || !current) return;
            const next = cloneGradient(current);
            mutate(next);
            this.scene.setFacePaintNoHistory(id, next);
            return;
        }
        if (this.nodeId === null) return;
        const node = this.scene.getNode(this.nodeId);
        if (!node) return;
        const style = node.style;
        const fills = (style.fills ?? []).map((f) => (isGradient(f) ? cloneGradient(f) : { ...f }));
        const fill = fills[this.fillIndex];
        if (!fill || !isGradient(fill)) return;
        mutate(fill);
        this.scene.setNodeStyleNoHistory(this.nodeId, JSON.stringify({ ...style, fills }));
    }
}

function cloneStop(s: GradientStop): GradientStop {
    return { offset: s.offset, color: { ...s.color } };
}

function cloneGradient(g: Gradient): Gradient {
    return { ...g, stops: g.stops.map(cloneStop) };
}
