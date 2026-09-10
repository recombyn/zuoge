/**
 * Rulers + ruler guides + snap-to-grid.
 *
 * Two thin canvas strips (top + left) draw tick marks in sync with the editor's
 * pan/zoom. Dragging out from a ruler drops a guide (a full-canvas line at a
 * fixed world x or y); guides are stored in the engine scene so they persist
 * with the document and ride the undo stack. The corner box toggles snap-to-grid.
 *
 * Guides are drawn on the WebGL canvas by the Renderer (`drawGuides`). This
 * module owns only the ruler chrome and the pointer interactions that create,
 * move, and delete guides.
 */
import type { InputManager } from './input';
import type { Renderer } from './renderer';
import type { WasmScene } from './wasm_scene';

const RULER_SIZE = 20; // px thickness of each ruler strip

export interface GuideHit {
    axis: 'x' | 'y';
    index: number;
}

/** Pick a "nice" step (1/2/5 × 10ⁿ) so labels land ~`targetPx` apart. */
function niceStep(worldPerPixel: number, targetPx: number): number {
    const raw = worldPerPixel * targetPx;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / pow;
    const mult = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10;
    return mult * pow;
}

export class GuidesController {
    private top: HTMLCanvasElement;
    private left: HTMLCanvasElement;
    private corner: HTMLButtonElement;
    private topCtx: CanvasRenderingContext2D;
    private leftCtx: CanvasRenderingContext2D;

    /** Snap-to-grid state. `gridSize` is world units between grid lines. */
    gridSnap = false;
    gridSize = 50;
    visible = true;

    /** In-flight guide being dragged out of a ruler. */
    private creating: { axis: 'x' | 'y'; index: number } | null = null;

    constructor(
        private container: HTMLElement,
        private scene: WasmScene,
        private renderer: Renderer,
        private input: InputManager,
    ) {
        this.top = container.querySelector('#ruler-top') as HTMLCanvasElement;
        this.left = container.querySelector('#ruler-left') as HTMLCanvasElement;
        this.corner = container.querySelector('#ruler-corner') as HTMLButtonElement;
        this.topCtx = this.top.getContext('2d')!;
        this.leftCtx = this.left.getContext('2d')!;

        this.top.addEventListener('pointerdown', (e) => this.startCreate(e, 'y'));
        this.left.addEventListener('pointerdown', (e) => this.startCreate(e, 'x'));
        this.corner.addEventListener('click', () => this.toggleGridSnap());

        window.addEventListener('resize', () => this.syncRulers());
        this.syncCornerUi();
        this.syncRulers();
    }

    /** Show/hide the ruler strips (guides on the canvas are unaffected). */
    setVisible(v: boolean) {
        this.visible = v;
        this.container.classList.toggle('rulers-hidden', !v);
        if (v) this.syncRulers();
    }

    toggleRulers() {
        this.setVisible(!this.visible);
    }

    toggleGridSnap() {
        this.gridSnap = !this.gridSnap;
        this.input.snap.gridSize = this.gridSnap ? this.gridSize : 0;
        this.syncCornerUi();
    }

    private syncCornerUi() {
        this.corner.classList.toggle('active', this.gridSnap);
        this.corner.title = this.gridSnap
            ? `Snap to grid: on (${this.gridSize})`
            : 'Snap to grid: off';
    }

    // ─── World ↔ screen (canvas-relative) ────────────────────────────────────

    private clientToWorld(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.renderer.canvas.getBoundingClientRect();
        return {
            x: (clientX - rect.left - this.renderer.pan.x) / this.renderer.zoom,
            y: (clientY - rect.top - this.renderer.pan.y) / this.renderer.zoom,
        };
    }

    // ─── Ruler rendering ─────────────────────────────────────────────────────

    syncRulers() {
        if (!this.visible) return;
        const rect = this.container.getBoundingClientRect();
        this.drawRuler(this.top, this.topCtx, 'x', rect.width, RULER_SIZE);
        this.drawRuler(this.left, this.leftCtx, 'y', RULER_SIZE, rect.height);
    }

    private drawRuler(
        cv: HTMLCanvasElement,
        ctx: CanvasRenderingContext2D,
        axis: 'x' | 'y',
        cssW: number,
        cssH: number,
    ) {
        const dpr = window.devicePixelRatio || 1;
        if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
            cv.width = Math.round(cssW * dpr);
            cv.height = Math.round(cssH * dpr);
            cv.style.width = `${cssW}px`;
            cv.style.height = `${cssH}px`;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.fillStyle = '#2b2b2b';
        ctx.fillRect(0, 0, cssW, cssH);
        ctx.strokeStyle = '#4a4a4a';
        ctx.fillStyle = '#888';
        ctx.font = '9px system-ui, sans-serif';
        ctx.lineWidth = 1;

        const { zoom } = this.renderer;
        const pan = axis === 'x' ? this.renderer.pan.x : this.renderer.pan.y;
        const lengthPx = axis === 'x' ? cssW : cssH;
        const step = niceStep(1 / zoom, 70);

        // Visible world range along this axis.
        const wStart = (0 - pan) / zoom;
        const wEnd = (lengthPx - pan) / zoom;
        const first = Math.ceil(wStart / step) * step;

        ctx.beginPath();
        for (let w = first; w <= wEnd; w += step) {
            const p = w * zoom + pan;
            if (axis === 'x') {
                ctx.moveTo(p + 0.5, RULER_SIZE);
                ctx.lineTo(p + 0.5, RULER_SIZE * 0.4);
            } else {
                ctx.moveTo(RULER_SIZE, p + 0.5);
                ctx.lineTo(RULER_SIZE * 0.4, p + 0.5);
            }
        }
        ctx.stroke();

        // Labels (rounded world value at each major tick).
        for (let w = first; w <= wEnd; w += step) {
            const p = w * zoom + pan;
            const label = String(Math.round(w));
            if (axis === 'x') {
                ctx.fillText(label, p + 2, 8);
            } else {
                ctx.save();
                ctx.translate(9, p - 2);
                ctx.rotate(-Math.PI / 2);
                ctx.fillText(label, 0, 0);
                ctx.restore();
            }
        }
    }

    // ─── Guide interaction ───────────────────────────────────────────────────

    /** Ruler drag-out: create a guide and start dragging it. */
    private startCreate(e: PointerEvent, axis: 'x' | 'y') {
        e.preventDefault();
        const world = this.clientToWorld(e.clientX, e.clientY);
        const pos = axis === 'x' ? world.x : world.y;
        this.scene.pushHistorySnapshot();
        const index = this.scene.addGuide(axis, this.applyGridSnap(axis, pos));
        this.creating = { axis, index };
        this.input.highlightedGuide = { axis, index };
        this.beginPointerCapture();
        this.renderer.requestRender();
    }

    private applyGridSnap(_axis: 'x' | 'y', pos: number): number {
        if (!this.gridSnap || this.gridSize <= 0) return pos;
        return Math.round(pos / this.gridSize) * this.gridSize;
    }

    private beginPointerCapture() {
        const onMove = (e: PointerEvent) => this.dragMove(e);
        const onUp = (e: PointerEvent) => {
            this.dragEnd(e);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
    }

    private dragMove(e: PointerEvent) {
        if (!this.creating) return;
        const { axis, index } = this.creating;
        const world = this.clientToWorld(e.clientX, e.clientY);
        const pos = this.applyGridSnap(axis, axis === 'x' ? world.x : world.y);
        this.scene.setGuide(axis, index, pos);
        this.renderer.requestRender();
    }

    private dragEnd(e: PointerEvent) {
        if (!this.creating) return;
        const { axis, index } = this.creating;
        this.creating = null;
        this.input.highlightedGuide = null;
        // Released back over a ruler → discard the guide (drag-off delete).
        if (this.isOverRuler(e.clientX, e.clientY)) {
            this.scene.removeGuide(axis, index);
        } else {
            this.scene.autosave?.trigger();
        }
        this.renderer.requestRender();
    }

    /** True when the client point is over either ruler strip (the delete zone). */
    isOverRuler(clientX: number, clientY: number): boolean {
        const rect = this.container.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        if (x < 0 || y < 0 || x > rect.width || y > rect.height) return true; // off-canvas
        return x <= RULER_SIZE || y <= RULER_SIZE;
    }

    /**
     * Hit-test guides near a world point. `tolWorld` is the catch radius in
     * world units. Vertical guides (axis 'x') are matched on x, horizontal on y.
     */
    hitGuide(worldX: number, worldY: number, tolWorld: number): GuideHit | null {
        const g = this.scene.getGuides();
        let best: GuideHit | null = null;
        let bestDist = tolWorld;
        g.x.forEach((gx, i) => {
            const d = Math.abs(gx - worldX);
            if (d < bestDist) {
                bestDist = d;
                best = { axis: 'x', index: i };
            }
        });
        g.y.forEach((gy, i) => {
            const d = Math.abs(gy - worldY);
            if (d < bestDist) {
                bestDist = d;
                best = { axis: 'y', index: i };
            }
        });
        return best;
    }

    // ─── Lock + delete ───────────────────────────────────────────────────────
    // Locks live in the scene (persisted via guide_locks_json) and are keyed by
    // axis+position, not index — index shifts when other guides are removed, and a
    // locked guide can't move so its position is stable.
    private guidePos(hit: GuideHit): number {
        const g = this.scene.getGuides();
        return hit.axis === 'x' ? g.x[hit.index] : g.y[hit.index];
    }

    isLocked(hit: GuideHit): boolean {
        return this.scene.isGuideLocked(hit.axis, this.guidePos(hit));
    }

    setLocked(hit: GuideHit, locked: boolean): void {
        this.scene.setGuideLocked(hit.axis, this.guidePos(hit), locked);
        this.renderer.requestRender();
    }

    /** Remove a guide (and drop any lock it held). One undo step. */
    deleteGuide(hit: GuideHit): void {
        this.scene.setGuideLocked(hit.axis, this.guidePos(hit), false);
        this.scene.pushHistorySnapshot();
        this.scene.removeGuide(hit.axis, hit.index);
        this.renderer.requestRender();
    }
}
