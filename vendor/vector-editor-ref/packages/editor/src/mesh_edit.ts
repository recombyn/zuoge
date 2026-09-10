/**
 * Mesh-gradient editing controller — shared state and logic for the Mesh tool
 * (U): converting fills to meshes, adding/removing grid lines, dragging
 * vertices and their bezier handles, and assigning vertex colors from the
 * Fill panel.
 *
 * Owned by UIEngine (`ui.meshEdit`), mirroring GradientEditController: the
 * InputManager routes canvas mouse events here and the Renderer reads the
 * state (selection, hover) to draw the overlay. Mesh coordinates live in
 * NODE-LOCAL space; hit-testing converts through the node's world transform,
 * so handles follow the shape under move/rotate/skew/non-uniform scale.
 *
 * Undo discipline (same contract as gradient_edit): drags bracket exactly one
 * history state via beginGesture/endGesture with all intermediate writes
 * through setNodeStyleNoHistory; discrete edits (add/delete line, recolor,
 * nudge, convert) wrap one transaction each.
 */

import { createMeshForNode } from './mesh_fit';
import type { Cubic, HandleDir, MeshUV } from './mesh_geom';
import {
    cloneMesh,
    colIsoCubics,
    deleteCol,
    deleteRow,
    effectiveHandle,
    evalCubic,
    hEdgeCubic,
    pointToUV,
    rowIsoCubics,
    splitCol,
    splitRow,
    vEdgeCubic,
    vertexIndex,
} from './mesh_geom';
import type { Color, MeshGradient } from './types';
import { isMeshGradient } from './types';
import type { WasmScene } from './wasm_scene';

/** Grid caps: at most 32 interior lines per axis (33×33 patches). */
export const MAX_MESH_LINES = 32;

/** What a canvas hit-test resolved to (on the ACTIVE mesh). */
export type MeshHit =
    /** A grid vertex. */
    | { type: 'vertex'; vi: number }
    /** A direction handle of a SELECTED vertex. */
    | { type: 'handle'; vi: number; dir: HandleDir }
    /** A grid line: row line `lineIndex` (vertex-row) segment `segIndex`
     *  (patch column) at local parameter `t` — or the col-line mirror. */
    | { type: 'line'; axis: 'row' | 'col'; lineIndex: number; segIndex: number; t: number }
    /** The mesh interior (between lines). */
    | { type: 'mesh'; uv: MeshUV };

export class MeshEditController {
    private scene: WasmScene;

    /** Node whose mesh fill is being edited (null = inactive). */
    nodeId: number | null = null;
    /** Index into the node's fills array. */
    fillIndex = 0;
    /** Selected vertex indices (row-major, into mesh.vertices). */
    selectedVertices = new Set<number>();
    /** Current hover feedback for the overlay (set by InputManager). */
    hover: MeshHit | null = null;
    /** True while Alt is held over the canvas (hover shows delete affordance). */
    hoverAlt = false;

    /** The line(s) the most recent add created, keyed to the vertex at their
     *  intersection: deleting THAT point removes exactly those lines, so
     *  "add a point, delete it" is a perfect inverse even when the add was a
     *  single perpendicular line on an existing grid line. Validated against
     *  the current grid shape; anything structural invalidates it. */
    private lastAdd: {
        nodeId: number;
        fillIndex: number;
        rows: number;
        cols: number;
        vi: number;
        lines: { axis: 'row' | 'col'; index: number }[];
    } | null = null;

    /** Active canvas drag. */
    private drag: {
        kind: 'vertex' | 'handle';
        vi: number;
        dir?: HandleDir;
        orig: MeshGradient;
        origSelection: Set<number>;
        startLocal: { x: number; y: number };
        /** Shift-press on an already-selected vertex: if the press ends
         *  without movement it TOGGLES the vertex out of the selection. */
        pendingShiftToggle: boolean;
    } | null = null;

    constructor(scene: WasmScene) {
        this.scene = scene;
    }

    // ─── Activation / lifecycle ──────────────────────────────────────────

    isActive(): boolean {
        return this.nodeId !== null && this.mesh() !== null;
    }

    activate(nodeId: number, fillIndex: number) {
        if (this.nodeId !== nodeId || this.fillIndex !== fillIndex) {
            this.selectedVertices.clear();
        }
        this.nodeId = nodeId;
        this.fillIndex = fillIndex;
        this.scene.renderer?.requestRender();
    }

    clear() {
        this.nodeId = null;
        this.fillIndex = 0;
        this.selectedVertices.clear();
        this.hover = null;
        this.drag = null;
    }

    /** Reconcile with the current selection: keep the active target while it
     *  is still a mesh fill on the (single) selected node; otherwise target
     *  the node's first mesh fill, or deactivate. */
    syncSelection() {
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
            if (fill && isMeshGradient(fill)) {
                // Drop selection entries that no longer exist (line deleted).
                for (const vi of this.selectedVertices) {
                    if (vi >= fill.vertices.length) this.selectedVertices.delete(vi);
                }
                return;
            }
        }
        const mi = fills.findIndex((f) => isMeshGradient(f));
        if (mi >= 0) {
            this.nodeId = id;
            this.fillIndex = mi;
            this.selectedVertices.clear();
        } else {
            this.clear();
        }
    }

    /** Fresh read of the edited mesh (or null when state went stale). */
    mesh(): MeshGradient | null {
        if (this.nodeId === null) return null;
        const node = this.scene.getNode(this.nodeId);
        const fill = node?.style.fills?.[this.fillIndex];
        return fill && isMeshGradient(fill) ? fill : null;
    }

    // ─── Coordinate transforms (node-local ↔ world) ─────────────────────

    private transform(): Float32Array {
        return this.scene.getTransform(this.nodeId!);
    }

    localToWorld(x: number, y: number): { x: number; y: number } {
        const t = this.transform();
        return { x: t[0] * x + t[1] * y + t[2], y: t[3] * x + t[4] * y + t[5] };
    }

    /** World → local for an arbitrary node (used before a mesh exists on it). */
    worldToLocalForNode(nodeId: number, wx: number, wy: number): { x: number; y: number } {
        const t = this.scene.getTransform(nodeId);
        return MeshEditController.invert(t, wx, wy);
    }

    worldToLocal(wx: number, wy: number): { x: number; y: number } {
        return MeshEditController.invert(this.transform(), wx, wy);
    }

    private static invert(t: Float32Array, wx: number, wy: number): { x: number; y: number } {
        const a = t[0];
        const b = t[1];
        const c = t[2];
        const d = t[3];
        const e = t[4];
        const f = t[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return { x: wx, y: wy };
        return {
            x: (e * (wx - c) - b * (wy - f)) / det,
            y: (a * (wy - f) - d * (wx - c)) / det,
        };
    }

    // ─── Canvas hit-testing ──────────────────────────────────────────────

    /** Hit-test the active mesh at a world position.
     *  Priority: handles (selected vertices only) → vertices → grid lines →
     *  mesh interior. Radii shrink with zoom so targets stay screen-constant. */
    hitTest(world: { x: number; y: number }, zoom: number): MeshHit | null {
        const mesh = this.mesh();
        if (!mesh) return null;
        const local = this.worldToLocal(world.x, world.y);
        // Tolerances in local units — approximate the node scale via the
        // world distance of one local unit.
        const one = this.localToWorld(local.x + 1, local.y);
        const origin = this.localToWorld(local.x, local.y);
        const unit = Math.hypot(one.x - origin.x, one.y - origin.y) || 1;
        const tol = (px: number) => px / zoom / unit;

        // Handles of selected vertices win.
        let bestHandle: { vi: number; dir: HandleDir; d: number } | null = null;
        for (const vi of this.selectedVertices) {
            if (vi >= mesh.vertices.length) continue;
            for (const dir of ['e', 'w', 's', 'n'] as const) {
                if (!this.handleVisible(mesh, vi, dir)) continue;
                const h = effectiveHandle(mesh, vi, dir);
                const d = Math.hypot(local.x - h[0], local.y - h[1]);
                if (d < tol(7) && (!bestHandle || d < bestHandle.d)) {
                    bestHandle = { vi, dir, d };
                }
            }
        }
        if (bestHandle) return { type: 'handle', vi: bestHandle.vi, dir: bestHandle.dir };

        // Vertices.
        let bestVertex: { vi: number; d: number } | null = null;
        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const v = mesh.vertices[vi];
            const d = Math.hypot(local.x - v.x, local.y - v.y);
            if (d < tol(9) && (!bestVertex || d < bestVertex.d)) bestVertex = { vi, d };
        }
        if (bestVertex) return { type: 'vertex', vi: bestVertex.vi };

        // Grid lines (sampled).
        const lineHit = this.hitTestLines(mesh, local, tol(5));
        if (lineHit) return lineHit;

        // Mesh interior.
        const uv = pointToUV(mesh, [local.x, local.y]);
        if (uv) return { type: 'mesh', uv };
        return null;
    }

    /** A handle is shown/hit only toward an existing neighbor. */
    private handleVisible(mesh: MeshGradient, vi: number, dir: HandleDir): boolean {
        const stride = mesh.cols + 1;
        const row = Math.floor(vi / stride);
        const col = vi % stride;
        if (dir === 'e') return col < mesh.cols;
        if (dir === 'w') return col > 0;
        if (dir === 's') return row < mesh.rows;
        return row > 0;
    }

    private hitTestLines(
        mesh: MeshGradient,
        local: { x: number; y: number },
        tolerance: number,
    ): MeshHit | null {
        const SAMPLES = 16;
        let best: {
            axis: 'row' | 'col';
            lineIndex: number;
            segIndex: number;
            t: number;
            d: number;
        } | null = null;
        const consider = (
            axis: 'row' | 'col',
            lineIndex: number,
            segIndex: number,
            cubic: Cubic,
        ) => {
            for (let i = 0; i <= SAMPLES; i++) {
                const t = i / SAMPLES;
                const p = evalCubic(cubic, t);
                const d = Math.hypot(local.x - p[0], local.y - p[1]);
                if (d < tolerance && (!best || d < best.d)) {
                    best = { axis, lineIndex, segIndex, t, d };
                }
            }
        };
        for (let r = 0; r <= mesh.rows; r++) {
            for (let pc = 0; pc < mesh.cols; pc++) {
                consider('row', r, pc, hEdgeCubic(mesh, r, pc));
            }
        }
        for (let c = 0; c <= mesh.cols; c++) {
            for (let pr = 0; pr < mesh.rows; pr++) {
                consider('col', c, pr, vEdgeCubic(mesh, pr, c));
            }
        }
        if (!best) return null;
        const { axis, lineIndex, segIndex, t } = best;
        return { type: 'line', axis, lineIndex, segIndex, t };
    }

    // ─── Vertex selection ────────────────────────────────────────────────

    selectVertex(vi: number, additive: boolean) {
        if (additive) {
            if (this.selectedVertices.has(vi)) this.selectedVertices.delete(vi);
            else this.selectedVertices.add(vi);
        } else {
            this.selectedVertices.clear();
            this.selectedVertices.add(vi);
        }
        this.scene.renderer?.requestRender();
    }

    /** Marquee selection: select all vertices inside a world-space rect. */
    selectVerticesInWorldRect(
        a: { x: number; y: number },
        b: { x: number; y: number },
        additive: boolean,
    ) {
        const mesh = this.mesh();
        if (!mesh) return;
        if (!additive) this.selectedVertices.clear();
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const v = mesh.vertices[vi];
            const w = this.localToWorld(v.x, v.y);
            if (w.x >= minX && w.x <= maxX && w.y >= minY && w.y <= maxY) {
                this.selectedVertices.add(vi);
            }
        }
        this.scene.renderer?.requestRender();
    }

    /** Whether a vertex is on the outer boundary ring. */
    isBoundaryVertex(mesh: MeshGradient, vi: number): boolean {
        const stride = mesh.cols + 1;
        const row = Math.floor(vi / stride);
        const col = vi % stride;
        return row === 0 || row === mesh.rows || col === 0 || col === mesh.cols;
    }

    // ─── Canvas drags ────────────────────────────────────────────────────

    isDragging(): boolean {
        return this.drag !== null;
    }

    beginVertexDrag(vi: number, world: { x: number; y: number }, additive: boolean) {
        const mesh = this.mesh();
        if (!mesh) return;
        const wasSelected = this.selectedVertices.has(vi);
        if (!wasSelected) this.selectVertex(vi, additive);
        this.scene.beginGesture();
        this.drag = {
            kind: 'vertex',
            vi,
            orig: cloneMesh(mesh),
            origSelection: new Set(this.selectedVertices),
            startLocal: this.worldToLocal(world.x, world.y),
            pendingShiftToggle: additive && wasSelected,
        };
    }

    beginHandleDrag(vi: number, dir: HandleDir, world: { x: number; y: number }) {
        const mesh = this.mesh();
        if (!mesh) return;
        this.scene.beginGesture();
        this.drag = {
            kind: 'handle',
            vi,
            dir,
            orig: cloneMesh(mesh),
            origSelection: new Set(this.selectedVertices),
            startLocal: this.worldToLocal(world.x, world.y),
            pendingShiftToggle: false,
        };
    }

    moveDrag(world: { x: number; y: number }, shiftKey: boolean, altKey: boolean) {
        if (!this.drag) return;
        const local = this.worldToLocal(world.x, world.y);
        const { kind, vi, dir, orig, origSelection, startLocal } = this.drag;

        if (kind === 'vertex') {
            let dx = local.x - startLocal.x;
            let dy = local.y - startLocal.y;
            if (shiftKey) {
                // Constrain to the dominant node-local axis.
                if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
                else dx = 0;
            }
            const moved = origSelection.has(vi) ? origSelection : new Set([vi]);
            this.writeLive(() => {
                const next = cloneMesh(orig);
                for (const mvi of moved) {
                    if (mvi >= next.vertices.length) continue;
                    const v = next.vertices[mvi];
                    v.x += dx;
                    v.y += dy;
                    // Stored handles travel rigidly with the anchor.
                    if (v.handles) {
                        for (const d of ['e', 'w', 's', 'n'] as const) {
                            const h = v.handles[d];
                            if (h) v.handles[d] = [h[0] + dx, h[1] + dy];
                        }
                    }
                }
                return next;
            });
        } else if (kind === 'handle' && dir) {
            this.writeLive(() => {
                const next = cloneMesh(orig);
                const v = next.vertices[vi];
                if (!v) return next;
                if (!v.handles) v.handles = {};
                v.handles[dir] = [local.x, local.y];
                if (!altKey) {
                    // Keep the opposite handle collinear, preserving its own
                    // length (pen-tool smoothness). Alt breaks the pair.
                    const opposite: Record<HandleDir, HandleDir> = {
                        e: 'w',
                        w: 'e',
                        s: 'n',
                        n: 's',
                    };
                    const opp = opposite[dir];
                    if (this.handleVisible(next, vi, opp)) {
                        const oppCur = effectiveHandle(next, vi, opp);
                        const oppLen = Math.hypot(oppCur[0] - v.x, oppCur[1] - v.y);
                        const dxh = local.x - v.x;
                        const dyh = local.y - v.y;
                        const len = Math.hypot(dxh, dyh);
                        if (len > 1e-6 && oppLen > 1e-6) {
                            v.handles[opp] = [
                                v.x - (dxh / len) * oppLen,
                                v.y - (dyh / len) * oppLen,
                            ];
                        }
                    }
                }
                return next;
            });
        }
    }

    /** Commit a drag. `didMove` false = the press never travelled: resolve a
     *  pending Shift-toggle (deselect the pressed vertex) instead of a move. */
    endDrag(didMove = true) {
        if (!this.drag) return;
        const { vi, pendingShiftToggle } = this.drag;
        this.drag = null;
        this.scene.endGesture();
        if (!didMove && pendingShiftToggle) {
            this.selectedVertices.delete(vi);
            this.scene.renderer?.requestRender();
        }
    }

    /** Abort an in-flight drag and restore the pre-drag state. */
    cancelDrag() {
        if (!this.drag) return;
        this.drag = null;
        this.scene.endGesture();
        this.scene.undo();
    }

    // ─── Discrete edits (one undo step each) ─────────────────────────────

    /** Convert `fillIndex` of a node to a shape-fitted mesh (one undo step).
     *  Returns the index of the vertex nearest the click, or -1 on failure. */
    convertFillToMesh(
        nodeId: number,
        fillIndex: number,
        clickLocal?: { x: number; y: number },
    ): number {
        const node = this.scene.getNode(nodeId);
        if (!node) return -1;
        const fills = node.style.fills ?? [];
        const prev = fills[fillIndex] ?? fills[0] ?? null;
        const mesh = createMeshForNode(node.geometry, prev, { clickLocal });
        if (!mesh) return -1;
        this.scene.transaction(() => {
            const newFills = fills.length > 0 ? [...fills] : [mesh as never];
            if (fills.length > 0) newFills[fillIndex] = mesh as never;
            this.scene.setNodeStyleNoHistory(
                nodeId,
                JSON.stringify({ ...node.style, fills: newFills }),
            );
        });
        this.activate(nodeId, fills.length > 0 ? fillIndex : 0);
        // Select the vertex nearest the click (or the center vertex).
        let nearest = -1;
        if (clickLocal) {
            let bestD = Infinity;
            for (let vi = 0; vi < mesh.vertices.length; vi++) {
                const v = mesh.vertices[vi];
                const d = Math.hypot(v.x - clickLocal.x, v.y - clickLocal.y);
                if (d < bestD) {
                    bestD = d;
                    nearest = vi;
                }
            }
        } else {
            nearest = vertexIndex(mesh, 1, 1);
        }
        this.selectedVertices.clear();
        if (nearest >= 0) this.selectedVertices.add(nearest);
        return nearest;
    }

    /** Add grid line(s) at a hit: interior click adds a row AND a column
     *  through the point; a line click adds only the perpendicular line.
     *  One undo step. Returns true if the mesh changed. */
    addLinesAt(hit: MeshHit): boolean {
        const mesh = this.mesh();
        if (!mesh) return false;
        let next: MeshGradient | null = null;
        let selectLocal: { x: number; y: number } | null = null;
        const addedLines: { axis: 'row' | 'col'; index: number }[] = [];
        if (hit.type === 'mesh') {
            const { row, col, u, v } = hit.uv;
            const canCol = mesh.cols < MAX_MESH_LINES + 1;
            const canRow = mesh.rows < MAX_MESH_LINES + 1;
            if (!canCol && !canRow) return false;
            next = mesh;
            if (canCol) {
                next = splitCol(next, col, u);
                addedLines.push({ axis: 'col', index: col + 1 });
            }
            if (canRow) {
                next = splitRow(next, row, v);
                addedLines.push({ axis: 'row', index: row + 1 });
            }
            // The new intersection vertex: row/col line indices after split.
            const nvRow = canRow ? row + 1 : 0;
            const nvCol = canCol ? col + 1 : 0;
            const nv = next.vertices[vertexIndex(next, nvRow, nvCol)];
            selectLocal = { x: nv.x, y: nv.y };
        } else if (hit.type === 'line') {
            if (hit.axis === 'row') {
                if (mesh.cols >= MAX_MESH_LINES + 1) return false;
                next = splitCol(mesh, hit.segIndex, hit.t);
                addedLines.push({ axis: 'col', index: hit.segIndex + 1 });
                const nv = next.vertices[vertexIndex(next, hit.lineIndex, hit.segIndex + 1)];
                selectLocal = { x: nv.x, y: nv.y };
            } else {
                if (mesh.rows >= MAX_MESH_LINES + 1) return false;
                next = splitRow(mesh, hit.segIndex, hit.t);
                addedLines.push({ axis: 'row', index: hit.segIndex + 1 });
                const nv = next.vertices[vertexIndex(next, hit.segIndex + 1, hit.lineIndex)];
                selectLocal = { x: nv.x, y: nv.y };
            }
        }
        if (!next || next === mesh) return false;
        const committed = next;
        this.scene.transaction(() => {
            this.writeLive(() => committed);
        });
        // Select the vertex nearest where the user clicked/inserted.
        let nearest = -1;
        if (selectLocal) {
            let bestD = Infinity;
            for (let vi = 0; vi < committed.vertices.length; vi++) {
                const v = committed.vertices[vi];
                const d = Math.hypot(v.x - selectLocal.x, v.y - selectLocal.y);
                if (d < bestD) {
                    bestD = d;
                    nearest = vi;
                }
            }
            this.selectedVertices.clear();
            if (nearest >= 0) this.selectedVertices.add(nearest);
        }
        // Remember what this add created so deleting its point undoes it 1:1.
        this.lastAdd =
            nearest >= 0 && this.nodeId !== null
                ? {
                      nodeId: this.nodeId,
                      fillIndex: this.fillIndex,
                      rows: committed.rows,
                      cols: committed.cols,
                      vi: nearest,
                      lines: addedLines,
                  }
                : null;
        return true;
    }

    /** The grid line(s) a delete at vertex `vi` removes. Deleting a point
     *  never nukes both of its crossing lines: it removes exactly what the
     *  most recent add created when `vi` is that add's point (add → delete =
     *  perfect inverse), otherwise the ONE line that looks most like it was
     *  inserted later — the one whose along-line handles are stored on more
     *  of its points (line splits store handles on every crossing; original
     *  fitted lines keep automatic ones). The Alt-hover highlight previews
     *  the exact line before you commit. */
    linesForVertexDeletion(
        mesh: MeshGradient,
        vi: number,
    ): { axis: 'row' | 'col'; index: number }[] {
        const la = this.lastAdd;
        if (
            la &&
            la.nodeId === this.nodeId &&
            la.fillIndex === this.fillIndex &&
            la.rows === mesh.rows &&
            la.cols === mesh.cols &&
            la.vi === vi
        ) {
            return la.lines;
        }
        const stride = mesh.cols + 1;
        const row = Math.floor(vi / stride);
        const col = vi % stride;
        const rowDeletable = row > 0 && row < mesh.rows;
        const colDeletable = col > 0 && col < mesh.cols;
        if (!rowDeletable && !colDeletable) return [];
        if (!colDeletable) return [{ axis: 'row', index: row }];
        if (!rowDeletable) return [{ axis: 'col', index: col }];
        // Fraction of the line's points carrying stored ALONG-LINE handles
        // (e/w run along row lines, s/n along column lines).
        let rowStored = 0;
        for (let c = 0; c <= mesh.cols; c++) {
            const h = mesh.vertices[row * stride + c].handles;
            if (h?.e || h?.w) rowStored++;
        }
        let colStored = 0;
        for (let r = 0; r <= mesh.rows; r++) {
            const h = mesh.vertices[r * stride + col].handles;
            if (h?.s || h?.n) colStored++;
        }
        const rowScore = rowStored / (mesh.cols + 1);
        const colScore = colStored / (mesh.rows + 1);
        // Tie → the column, so the choice is at least deterministic.
        return rowScore > colScore ? [{ axis: 'row', index: row }] : [{ axis: 'col', index: col }];
    }

    /** Alt-click: delete the clicked line, or a vertex's deletion lines
     *  (see linesForVertexDeletion). Boundary lines are immune. One undo step. */
    deleteAtHit(hit: MeshHit): boolean {
        const mesh = this.mesh();
        if (!mesh) return false;
        let next = mesh;
        if (hit.type === 'line') {
            next =
                hit.axis === 'row'
                    ? deleteRow(mesh, hit.lineIndex)
                    : deleteCol(mesh, hit.lineIndex);
        } else if (hit.type === 'vertex') {
            next = this.deleteLines(mesh, this.linesForVertexDeletion(mesh, hit.vi));
        }
        if (next === mesh) return false;
        const committed = next;
        this.scene.transaction(() => {
            this.writeLive(() => committed);
        });
        this.selectedVertices.clear();
        this.lastAdd = null;
        return true;
    }

    /** Delete key: remove each selected interior vertex's deletion lines
     *  (deduplicated; see linesForVertexDeletion). Boundary vertices are
     *  skipped. One undo step. Returns true if anything was deleted. */
    deleteLinesThroughSelection(): boolean {
        const mesh = this.mesh();
        if (!mesh) return false;
        const lines: { axis: 'row' | 'col'; index: number }[] = [];
        const seen = new Set<string>();
        for (const vi of this.selectedVertices) {
            if (vi >= mesh.vertices.length) continue;
            for (const l of this.linesForVertexDeletion(mesh, vi)) {
                const key = `${l.axis}:${l.index}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    lines.push(l);
                }
            }
        }
        const next = this.deleteLines(mesh, lines);
        if (next === mesh) return false;
        const committed = next;
        this.scene.transaction(() => {
            this.writeLive(() => committed);
        });
        this.selectedVertices.clear();
        this.lastAdd = null;
        return true;
    }

    /** Apply a set of line deletions (descending per axis so indices stay
     *  valid). Returns the input mesh unchanged when nothing was deletable. */
    private deleteLines(
        mesh: MeshGradient,
        lines: { axis: 'row' | 'col'; index: number }[],
    ): MeshGradient {
        const rows = lines
            .filter((l) => l.axis === 'row')
            .map((l) => l.index)
            .sort((a, b) => b - a);
        const cols = lines
            .filter((l) => l.axis === 'col')
            .map((l) => l.index)
            .sort((a, b) => b - a);
        let next = mesh;
        for (const r of rows) next = deleteRow(next, r);
        for (const c of cols) next = deleteCol(next, c);
        return next;
    }

    /** Set the color of all selected vertices without history (panel picker
     *  live path — bracket with beginGesture/endGesture, or use
     *  setSelectedColor for a one-shot). */
    setSelectedColorLive(color: Color) {
        this.writeLive((mesh) => {
            const next = cloneMesh(mesh);
            for (const vi of this.selectedVertices) {
                if (vi < next.vertices.length) next.vertices[vi].color = { ...color };
            }
            return next;
        });
    }

    /** Set the color of all selected vertices as one undo step. */
    setSelectedColor(color: Color) {
        if (this.selectedVertices.size === 0) return;
        this.scene.transaction(() => {
            this.setSelectedColorLive(color);
        });
    }

    /** Arrow-key nudge of the selected vertices (node-local units).
     *  One undo step per press. */
    nudge(dx: number, dy: number): boolean {
        const mesh = this.mesh();
        if (!mesh || this.selectedVertices.size === 0) return false;
        this.scene.transaction(() => {
            this.writeLive((m) => {
                const next = cloneMesh(m);
                for (const vi of this.selectedVertices) {
                    if (vi >= next.vertices.length) continue;
                    const v = next.vertices[vi];
                    v.x += dx;
                    v.y += dy;
                    if (v.handles) {
                        for (const d of ['e', 'w', 's', 'n'] as const) {
                            const h = v.handles[d];
                            if (h) v.handles[d] = [h[0] + dx, h[1] + dy];
                        }
                    }
                }
                return next;
            });
        });
        return true;
    }

    /** Reset the stored handles of the selected vertices to automatic
     *  (smooth ⅓ defaults). One undo step. */
    resetHandles(): boolean {
        const mesh = this.mesh();
        if (!mesh || this.selectedVertices.size === 0) return false;
        this.scene.transaction(() => {
            this.writeLive((m) => {
                const next = cloneMesh(m);
                for (const vi of this.selectedVertices) {
                    if (vi < next.vertices.length) next.vertices[vi].handles = undefined;
                }
                return next;
            });
        });
        return true;
    }

    // ─── Ghost previews (overlay data) ───────────────────────────────────

    /** The exact dashed iso-lines a click at the current hover would insert:
     *  one or two cubic chains in node-local coords. */
    ghostLines(): Cubic[][] {
        const mesh = this.mesh();
        if (!mesh || !this.hover || this.hoverAlt) return [];
        if (this.hover.type === 'mesh') {
            const { row, col, u, v } = this.hover.uv;
            const out: Cubic[][] = [];
            if (mesh.rows < MAX_MESH_LINES + 1) out.push(rowIsoCubics(mesh, row, v));
            if (mesh.cols < MAX_MESH_LINES + 1) out.push(colIsoCubics(mesh, col, u));
            return out;
        }
        if (this.hover.type === 'line') {
            if (this.hover.axis === 'row' && mesh.cols < MAX_MESH_LINES + 1) {
                return [colIsoCubics(mesh, this.hover.segIndex, this.hover.t)];
            }
            if (this.hover.axis === 'col' && mesh.rows < MAX_MESH_LINES + 1) {
                return [rowIsoCubics(mesh, this.hover.segIndex, this.hover.t)];
            }
        }
        return [];
    }

    // ─── Style write-through ─────────────────────────────────────────────

    /** Replace the edited mesh on a fresh style read and write it back
     *  without pushing history (callers bracket with gesture/transaction). */
    private writeLive(produce: (mesh: MeshGradient) => MeshGradient) {
        if (this.nodeId === null) return;
        const node = this.scene.getNode(this.nodeId);
        if (!node) return;
        const style = node.style;
        const fills = [...(style.fills ?? [])];
        const fill = fills[this.fillIndex];
        if (!fill || !isMeshGradient(fill)) return;
        fills[this.fillIndex] = produce(fill);
        this.scene.setNodeStyleNoHistory(this.nodeId, JSON.stringify({ ...style, fills }));
    }
}
