import type { CanvasKit } from 'canvaskit-wasm';
import init, { Engine, History } from '../engine/pkg/engine';
import { logAppEvent } from './analytics';
import type { BoolOp } from './boolean_ops';
import {
    BOOL_OP_BY_INDEX,
    BOOL_OP_INDEX,
    computeBooleanSubpaths,
    invertAffine,
    transformSubpaths,
} from './boolean_ops';
import type { Document } from './document';
import { snapMeshBoundaryToOutline } from './mesh_fit';
import type { AutosaveManager } from './persistence';
import type { Renderer } from './renderer';
import type { Artboard, SceneData, Subpath, Transform2D } from './types';
import { isMeshGradient } from './types';

/** Shared empty typed array for the common "no sprite roots" render path. */
const EMPTY_U32 = new Uint32Array(0);

/**
 * How the scene asks the UI layer "what mode is the user in?" so every history
 * entry can carry it, and hands it back on undo/redo. Opaque on purpose: the
 * scene stores and returns the value without reading it, so the shape of a mode
 * stays the InputManager's business. See WasmScene.undo().
 */
export interface HistoryContextHooks {
    /** The mode the user is in right now, captured with a pushed state. */
    capture(): unknown;
    /** Put the user back in `ctx` (null = no recorded mode: leave any mode). */
    restore(ctx: unknown): void;
}

export class WasmScene {
    engine: Engine | null = null;
    history: History | null = null;
    /** WASM module instance — needed for `memory.buffer` access. */
    wasm: { memory: WebAssembly.Memory } | null = null;
    autosave: AutosaveManager | null = null;
    ck: CanvasKit;

    /** Text-on-path links: text node id → the path node it flows along. Persisted
     *  via the engine (text_paths_json); this in-memory mirror is the fast read. */
    textPathLinks = new Map<number, number>();
    /** False when `textPathLinks` may be stale vs the engine (after a deserialize);
     *  the next getTextPath() reloads it. */
    private _textPathsLoaded = false;

    /** Arrowhead / line-ending markers per node id. Persisted via the engine
     *  (markers_json); this in-memory mirror is the fast read. */
    markerLinks = new Map<number, import('./types').NodeMarkers>();
    private _markersLoaded = false;

    /** Locked ruler guides as `axis:pos` keys. Persisted via the engine
     *  (guide_locks_json); this in-memory Set is the fast read. */
    guideLocks = new Set<string>();
    private _guideLocksLoaded = false;

    /** Cached scene data, invalidated on mutation. */
    private _cachedSceneData: SceneData | null = null;
    private _sceneDataDirty: boolean = true;

    /** Back-reference to the renderer for cache invalidation. */
    renderer: Renderer | null = null;

    /**
     * Mutation counter — bumped by every mutation via invalidateCache().
     * The active Document compares this against its savedCounter for dirty
     * state. Selection-only changes do NOT flow through invalidateCache(), so
     * they correctly leave this untouched.
     */
    changeCounter = 0;
    /** Notified on every mutation; pointed at the active document's markMutated. */
    onMutate: (() => void) | null = null;

    constructor(ck: CanvasKit) {
        this.ck = ck;
    }

    /** Max undo depth, retained so newDocument() can rebuild the history. */
    private maxHistorySize: number = 50;

    async init(maxHistorySize: number = 50) {
        this.maxHistorySize = maxHistorySize;
        this.wasm = await init();
        // A default engine so the scene is usable before the DocumentManager
        // attaches the first document. Session restore (per-document engines +
        // autosave) is owned by the DocumentManager, not here.
        this.engine = new Engine();
        this.history = new History(maxHistorySize);
        this.autosave = null;
        this.invalidateCache(false);
    }

    /**
     * Reset to a blank document: fresh engine, cleared history, and (optionally)
     * a set document size. Used by "New Document" and by the SVG conformance
     * harness to isolate each test. Autosave is managed per-document elsewhere.
     */
    newDocument(width?: number, height?: number) {
        this.engine = new Engine();
        this.history = new History(this.maxHistorySize);
        if (width !== undefined && height !== undefined) {
            this.engine.set_document_size(width, height);
        }
        this.autosave = null;
        // The fresh engine restarts image-id numbering, so previously-decoded
        // images/pattern shaders in the renderer would be returned for the new
        // document's colliding ids. Drop them (same reason as the native-doc drop path).
        this.renderer?.clearImageCache();
        this.invalidateCache(false);
    }

    /**
     * Point the scene at a document's live engine/history/autosave. This is a
     * pointer swap, not a content change, so it does NOT bump the mutation
     * counter (invalidateCache(false)). The caller must have instantiated the
     * document's engine first.
     */
    attachDocument(doc: Document) {
        this.engine = doc.engine;
        this.history = doc.history;
        this.autosave = doc.autosave;
        // Different document → different engine with its own image-id space;
        // drop cached image/pattern shaders keyed by the previous doc's ids.
        this.renderer?.clearImageCache();
        this.invalidateCache(false);
    }

    // ─── Artboards ──────────────────────────────────────────────────────────
    // Undo-disciplined wrappers (saveHistory before the mutation) + a cached
    // getter parsing get_artboards_json, invalidated in invalidateCache().

    private _cachedArtboards: Artboard[] | null = null;

    getArtboards(): Artboard[] {
        if (this._cachedArtboards) return this._cachedArtboards;
        if (!this.engine) return [];
        try {
            this._cachedArtboards = JSON.parse(this.engine.get_artboards_json()) as Artboard[];
        } catch {
            this._cachedArtboards = [];
        }
        return this._cachedArtboards;
    }

    addArtboard(x: number, y: number, w: number, h: number): number {
        this.saveHistory();
        const id = this.engine!.add_artboard(x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    // ─── Ruler guides ────────────────────────────────────────────────────────
    // History for guides is coordinated by the caller (InputManager) via
    // pushHistorySnapshot() at gesture start — guide state rides along in the
    // serialized scene snapshot, so these wrappers stay history-free.

    /** All guides as `{ x: [world x…], y: [world y…] }`. */
    getGuides(): { x: number[]; y: number[] } {
        if (!this.engine) return { x: [], y: [] };
        try {
            return JSON.parse(this.engine.get_guides_json());
        } catch {
            return { x: [], y: [] };
        }
    }

    /** Add a guide on `axis` ('x' = vertical, 'y' = horizontal). Returns its index. */
    addGuide(axis: 'x' | 'y', pos: number): number {
        const idx = this.engine!.add_guide(axis, pos);
        this.autosave?.trigger();
        return idx;
    }

    /** Move an existing guide (live drag; no autosave churn per frame). */
    setGuide(axis: 'x' | 'y', index: number, pos: number): void {
        this.engine!.set_guide(axis, index, pos);
    }

    removeGuide(axis: 'x' | 'y', index: number): void {
        this.engine!.remove_guide(axis, index);
        this.autosave?.trigger();
    }

    // ─── Color swatches ──────────────────────────────────────────────────────

    /** The document's color swatches (empty array if none). */
    getSwatches(): import('./types').Color[] {
        if (!this.engine) return [];
        try {
            return JSON.parse(this.engine.get_swatches_json() || '[]');
        } catch {
            return [];
        }
    }

    /** Replace the document's swatch list (persists via autosave; no undo step —
     *  the caller pushes history around any accompanying recolor). */
    setSwatches(list: import('./types').Color[]): void {
        this.engine!.set_swatches_json(JSON.stringify(list));
        this.autosave?.trigger();
    }

    // ─── Text on a path ────────────────────────────────────────────────────────

    /** The path node a text flows along, or null. Lazily re-reads the persisted
     *  links from the engine after a deserialize. */
    getTextPath(textId: number): number | null {
        if (!this._textPathsLoaded) {
            this.reloadTextPaths();
            this._textPathsLoaded = true;
        }
        return this.textPathLinks.get(textId) ?? null;
    }

    /** Link a text node to a path so its glyphs flow along it. */
    setTextPath(textId: number, pathId: number): void {
        this.saveHistory();
        this.textPathLinks.set(textId, pathId);
        // Park the text node's transform at the path's center. The glyphs are
        // drawn from the path's world outline (the renderer undoes this transform),
        // so its only job is to give the text node bounds that overlap the path —
        // otherwise the node would be viewport-culled and never reach the renderer.
        const b = this.getNodeBounds(pathId);
        if (b && b.length >= 4) {
            this.setNodeTransformComponents(textId, {
                x: (b[0] + b[2]) / 2,
                y: (b[1] + b[3]) / 2,
                rotation_deg: 0,
                skew_x_deg: 0,
                skew_y_deg: 0,
                scale_x: 1,
                scale_y: 1,
            });
        }
        this.persistTextPaths();
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Remove a text-on-path link (text returns to normal layout). */
    clearTextPath(textId: number): void {
        if (!this.textPathLinks.has(textId)) return;
        this.saveHistory();
        this.textPathLinks.delete(textId);
        this.persistTextPaths();
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Serialize the link map into the engine so it persists with the document
     *  (rides the protobuf snapshot, like swatches). */
    private persistTextPaths(): void {
        if (!this.engine) return;
        const obj: Record<string, number> = {};
        for (const [t, p] of this.textPathLinks) obj[t] = p;
        this.engine.set_text_paths_json(JSON.stringify(obj));
    }

    /** Reload the link map from the engine (after a document open, or when undo/
     *  redo restores a scene snapshot that carried different links). */
    reloadTextPaths(): void {
        this.textPathLinks.clear();
        if (!this.engine) return;
        try {
            const obj = JSON.parse(this.engine.get_text_paths_json() || '{}') as Record<
                string,
                number
            >;
            for (const k of Object.keys(obj)) this.textPathLinks.set(Number(k), obj[k]);
        } catch {
            /* keep empty */
        }
    }

    // ─── Arrowhead / line-ending markers ─────────────────────────────────────

    /** Markers on a node's path ends, or null. Lazily re-reads after deserialize. */
    getNodeMarkers(nodeId: number): import('./types').NodeMarkers | null {
        if (!this._markersLoaded) {
            this.reloadMarkers();
            this._markersLoaded = true;
        }
        return this.markerLinks.get(nodeId) ?? null;
    }

    /** Set one end's marker kind (creates/updates the node's marker entry). */
    setNodeMarker(nodeId: number, end: 'start' | 'end', kind: import('./types').MarkerKind): void {
        this.saveHistory();
        const cur = { ...(this.getNodeMarkers(nodeId) ?? {}) };
        if (kind === 'none') delete cur[end];
        else cur[end] = kind;
        if (cur.start || cur.end) this.markerLinks.set(nodeId, cur);
        else this.markerLinks.delete(nodeId);
        this.persistMarkers();
        this.invalidateCache();
        this.autosave?.trigger();
    }

    private persistMarkers(): void {
        if (!this.engine) return;
        const obj: Record<string, import('./types').NodeMarkers> = {};
        for (const [id, m] of this.markerLinks) obj[id] = m;
        this.engine.set_markers_json(JSON.stringify(obj));
    }

    reloadMarkers(): void {
        this.markerLinks.clear();
        if (!this.engine) return;
        try {
            const obj = JSON.parse(this.engine.get_markers_json() || '{}') as Record<
                string,
                import('./types').NodeMarkers
            >;
            for (const k of Object.keys(obj)) this.markerLinks.set(Number(k), obj[k]);
        } catch {
            /* keep empty */
        }
    }

    // ─── Guide locks (persisted via engine guide_locks_json) ─────────────────
    private guideLockKey(axis: 'x' | 'y', pos: number): string {
        return `${axis}:${pos}`;
    }

    private ensureGuideLocks(): void {
        if (this._guideLocksLoaded) return;
        this.reloadGuideLocks();
        this._guideLocksLoaded = true;
    }

    isGuideLocked(axis: 'x' | 'y', pos: number): boolean {
        this.ensureGuideLocks();
        return this.guideLocks.has(this.guideLockKey(axis, pos));
    }

    setGuideLocked(axis: 'x' | 'y', pos: number, locked: boolean): void {
        this.ensureGuideLocks();
        const key = this.guideLockKey(axis, pos);
        if (locked) this.guideLocks.add(key);
        else this.guideLocks.delete(key);
        this.persistGuideLocks();
        this.invalidateCache();
        this.autosave?.trigger();
    }

    private persistGuideLocks(): void {
        if (!this.engine) return;
        const x: number[] = [];
        const y: number[] = [];
        for (const k of this.guideLocks) {
            const [axis, pos] = k.split(':');
            (axis === 'x' ? x : y).push(Number(pos));
        }
        this.engine.set_guide_locks_json(JSON.stringify({ x, y }));
    }

    reloadGuideLocks(): void {
        this.guideLocks.clear();
        if (!this.engine) return;
        try {
            const obj = JSON.parse(this.engine.get_guide_locks_json() || '{}') as {
                x?: number[];
                y?: number[];
            };
            for (const p of obj.x ?? []) this.guideLocks.add(this.guideLockKey('x', p));
            for (const p of obj.y ?? []) this.guideLocks.add(this.guideLockKey('y', p));
        } catch {
            /* keep empty */
        }
    }

    removeArtboard(id: number): boolean {
        this.saveHistory();
        const ok = this.engine!.remove_artboard(id);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    /** Resize/move an artboard. Wrap drag gestures in beginGesture/endGesture. */
    setArtboardBounds(id: number, x: number, y: number, w: number, h: number): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_bounds(id, x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    setArtboardName(id: number, name: string): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_name(id, name);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    setArtboardBackground(id: number, r: number, g: number, b: number, a: number): boolean {
        this.saveHistory();
        const ok = this.engine!.set_artboard_background(id, r, g, b, a);
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    getRenderData(visibleIds: Uint32Array, spriteRoots?: Uint32Array): DataView {
        if (!this.engine || !this.wasm) throw new Error('WasmScene not initialized');

        // Tell engine to update the binary render buffer. `spriteRoots` lists
        // groups the renderer will draw as a cached GPU sprite this frame; the
        // engine emits their bracket but skips descending into the subtree.
        this.engine.update_render_buffer(visibleIds, spriteRoots ?? EMPTY_U32);

        const ptr = this.engine.get_render_buffer();
        const size = this.engine.get_render_buffer_size();

        // Copy the buffer OUT of WASM linear memory into a JS-owned ArrayBuffer.
        // The renderer decodes images mid-iteration (get_image_bytes), which
        // allocates in WASM memory and can grow it — that would detach a view
        // held over `wasm.memory.buffer` and crash the reader ("detached
        // ArrayBuffer"). A view into our own copy can never be detached. The
        // render buffer is geometry-only (image/font bytes stay in the engine,
        // referenced by id), so it stays small and this copy is cheap.
        return new DataView(this.wasm.memory.buffer.slice(ptr, ptr + size));
    }

    /** Like getRenderData, but the engine runs the R-tree viewport cull
     *  internally — no visible-id array is marshalled across the boundary and
     *  the tree is walked once instead of twice. Used for ordinary frames that
     *  don't need a JS-side id subset (drag/snapshot/bake passes still use
     *  getVisibleNodes + getRenderData). `spriteRoots` lists sprite-drawn
     *  groups whose subtrees the engine skips. */
    getRenderDataCulled(
        minX: number,
        minY: number,
        maxX: number,
        maxY: number,
        spriteRoots?: Uint32Array,
    ): DataView {
        if (!this.engine || !this.wasm) throw new Error('WasmScene not initialized');
        this.engine.update_render_buffer_culled(minX, minY, maxX, maxY, spriteRoots ?? EMPTY_U32);
        const ptr = this.engine.get_render_buffer();
        const size = this.engine.get_render_buffer_size();
        return new DataView(this.wasm.memory.buffer.slice(ptr, ptr + size));
    }

    /**
     * @param isMutation when true (default) this invalidation reflects a scene
     *   content change, so the dirty counter advances and the active document is
     *   notified. Structural swaps (attach/newDocument/init) pass false.
     */
    invalidateCache(isMutation = true) {
        this._sceneDataDirty = true;
        this._cachedSceneData = null;
        this._cachedArtboards = null;
        // The text-on-path link cache may be stale after any deserialize (undo/
        // redo/load); re-read it lazily on the next getTextPath().
        this._textPathsLoaded = false;
        this._markersLoaded = false;
        this._guideLocksLoaded = false;
        if (isMutation) {
            this.changeCounter++;
            this.onMutate?.();
        }
        // Invalidate renderer caches (paths, gradients, filled faces) and request a new frame
        if (this.renderer) {
            this.renderer.invalidateRenderCaches();
        }
    }

    /**
     * Invalidation for transform-only mutations (translate during drag): the
     * scene changed, but no node's LOCAL geometry or paint did — and every
     * renderer cache (CanvasKit paths, gradient shaders, effect filters,
     * pattern shaders) is keyed in local space. Wiping them per pointermove
     * forces a full rebuild of every path/shader in the scene on the next
     * frame, which is what makes dragging large scenes stutter. A node inside
     * a Boolean Group still re-evaluates correctly: the engine marks the group
     * dirty and recomputeDirtyBooleanGroups() performs the full invalidation
     * itself when the outline actually changes.
     */
    /**
     * @param changedIds when given, nodes whose transform changed. A moved
     *   node INSIDE a sprite-cached group invalidates that group's sprite; a
     *   moved cached root doesn't need to (sprites follow their group's
     *   transform at draw time).
     */
    invalidateCacheTransformOnly(changedIds?: ArrayLike<number>) {
        this._sceneDataDirty = true;
        this._cachedSceneData = null;
        this._cachedArtboards = null;
        this.changeCounter++;
        this.onMutate?.();
        if (changedIds && this.renderer) {
            for (let i = 0; i < changedIds.length; i++) {
                this.renderer.invalidateGroupSpriteFor(changedIds[i]);
            }
        }
        this.renderer?.requestRender();
    }

    addRect(x: number, y: number, w: number, h: number): number {
        this.saveHistory();
        const id = this.engine!.add_rect(x, y, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('object_created', { type: 'rect' });
        return id;
    }

    addEllipse(cx: number, cy: number, rx: number, ry: number): number {
        this.saveHistory();
        const id = this.engine!.add_ellipse(cx, cy, rx, ry);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('object_created', { type: 'ellipse' });
        return id;
    }

    addPath(pointsJson: string): number {
        this.saveHistory();
        const id = this.engine!.add_path(pointsJson);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('object_created', { type: 'path' });
        return id;
    }

    addPolygon(cx: number, cy: number, radius: number, sides: number): number {
        this.saveHistory();
        const id = this.engine!.add_polygon(cx, cy, radius, sides);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('object_created', { type: 'polygon' });
        return id;
    }

    addStar(cx: number, cy: number, outerR: number, innerR: number, points: number): number {
        this.saveHistory();
        const id = this.engine!.add_star(cx, cy, outerR, innerR, points);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('object_created', { type: 'star' });
        return id;
    }

    updatePathPoints(id: number, pointsJson: string) {
        this.saveHistory();
        this.updatePathPointsNoHistory(id, pointsJson);
    }

    /** Write path geometry WITHOUT pushing an undo step — for callers that
     *  already own the step, i.e. a gesture that pushed its pre-drag state
     *  once (see InputManager.commitPointDrag). Pushing here as well is what
     *  made one anchor drag cost two ⌘Z presses, the first of them silent. */
    updatePathPointsNoHistory(id: number, pointsJson: string) {
        this.engine!.update_path_points(id, pointsJson);
        // The engine stretched any mesh fills through the geometry's bbox
        // affine; re-snap their outer ring exactly onto the edited outline.
        // Runs inside the same history step.
        this.snapMeshFillsToGeometry(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Re-snap the boundary of a node's mesh fills to its current outline
     *  (no history push — callers own the history step). */
    snapMeshFillsToGeometry(id: number) {
        const node = this.getNode(id);
        if (!node) return;
        const fills = node.style.fills ?? [];
        let changed = false;
        const next = fills.map((f) => {
            if (!f || !isMeshGradient(f)) return f;
            const snapped = snapMeshBoundaryToOutline(f, node.geometry);
            if (snapped) {
                changed = true;
                return snapped;
            }
            return f;
        });
        if (changed) {
            this.engine!.set_node_style(id, JSON.stringify({ ...node.style, fills: next }));
        }
    }

    setNodeStyle(id: number, styleJson: string) {
        this.saveHistory();
        this.engine!.set_node_style(id, styleJson);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('property_changed', { property: 'style' });
    }

    /** Apply a style change without pushing history. Used for live preview during
     *  drag-editing (e.g. color picker) and for applying the current style to
     *  newly created shapes (where the creation already pushed history). */
    setNodeStyleNoHistory(id: number, styleJson: string) {
        this.engine!.set_node_style(id, styleJson);
        this.invalidateCache();
    }

    /** Set typography properties without pushing an undo entry (used when
     *  finalizing a just-created text node, whose creation already saved one). */
    setTextPropertiesNoHistory(
        id: number,
        fontFamily: string,
        textAlign: number,
        lineHeight: number,
    ) {
        this.engine!.set_text_properties(id, fontFamily, textAlign, lineHeight);
        this.invalidateCache();
    }

    setNodeVisible(id: number, visible: boolean) {
        this.saveHistory();
        this.engine!.set_node_visible(id, visible);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Show/hide a node WITHOUT touching history or the dirty flag. Only for
     *  work that is not an edit — see `withOnlyVisible`. */
    setNodeVisibleNoHistory(id: number, visible: boolean) {
        this.engine!.set_node_visible(id, visible);
        this.invalidateCache();
    }

    /**
     * Run `fn` with everything outside `roots` (and their descendants) hidden,
     * then put every visibility flag back exactly as it was.
     *
     * Exporting a selection as PNG works by hiding the rest of the document and
     * rasterising, and it used to do that through the undo-disciplined
     * `setNodeVisible` — one history push AND one autosave per node in the
     * WHOLE document. A single export on a modest drawing pushed more states
     * than the 50 the stack holds, so the user's real work fell off the bottom
     * of it and every ⌘Z afterwards walked back into the export's own
     * intermediate states, where artwork they had never touched was invisible.
     * It read exactly like what it was: things disappearing at export, with no
     * way to bring them back.
     *
     * So: no history, no dirty flag, and the restore runs in a `finally` — a
     * render that throws must not leave half the document hidden either.
     */
    withOnlyVisible<T>(roots: number[], fn: () => T): T {
        const previous = new Map<number, boolean>();
        const record = (id: number) => {
            previous.set(id, this.getNodeVisible(id));
            for (const childId of Array.from(this.getNodeChildren(id))) record(childId);
        };
        for (const rootId of Array.from(this.getRootNodes())) record(rootId);

        const keep = new Set<number>();
        const mark = (id: number) => {
            keep.add(id);
            for (const childId of Array.from(this.getNodeChildren(id))) mark(childId);
        };
        for (const id of roots) mark(id);

        try {
            for (const id of previous.keys()) {
                if (!keep.has(id)) this.setNodeVisibleNoHistory(id, false);
            }
            return fn();
        } finally {
            for (const [id, visible] of previous) this.setNodeVisibleNoHistory(id, visible);
        }
    }

    setNodeLocked(id: number, locked: boolean) {
        this.saveHistory();
        this.engine!.set_node_locked(id, locked);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Toggle whether a node masks the siblings painted above it in its group. */
    setNodeIsMask(id: number, isMask: boolean) {
        this.saveHistory();
        this.engine!.set_node_is_mask(id, isMask);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getNodeIsMask(id: number): boolean {
        return this.engine!.get_node_is_mask(id);
    }

    /** Update a text node's weight/italic/letter-spacing. One undo step. */
    setTextStyle(id: number, fontWeight: number, italic: boolean, letterSpacing: number) {
        this.saveHistory();
        this.engine!.set_text_style(id, fontWeight, italic, letterSpacing);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a node's effects (JSON array of serde-tagged Effect). One undo step. */
    setNodeEffects(id: number, effectsJson: string) {
        this.saveHistory();
        this.engine!.set_node_effects(id, effectsJson);
        this.invalidateCache();
        this.autosave?.trigger();
        logAppEvent('property_changed', { property: 'effects' });
    }

    /** Replace a node's effects without pushing history (batched edits, e.g.
     *  the eyedropper applying to a multi-node selection under one undo step). */
    setNodeEffectsNoHistory(id: number, effectsJson: string) {
        this.engine!.set_node_effects(id, effectsJson);
        this.invalidateCache();
    }

    getNodeEffects(id: number): string {
        return this.engine!.get_node_effects(id);
    }

    /** Register encoded image bytes and place an image node centered at (cx,cy)
     *  with the given display size. One undo step. Returns the new node id. */
    placeImage(
        bytes: Uint8Array,
        mime: string,
        cx: number,
        cy: number,
        w: number,
        h: number,
    ): number {
        let id = 0;
        this.transaction(() => {
            const imageId = this.engine!.register_image(bytes, mime);
            id = this.engine!.add_image(cx - w / 2, cy - h / 2, w, h, imageId);
        });
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    moveNode(id: number, dx: number, dy: number) {
        this.engine!.move_node(id, dx, dy);
        // Translation never changes local geometry/paints — keep renderer caches.
        this.invalidateCacheTransformOnly([id]);
        // No autosave on every move frame — too expensive. Saved on mouseUp via saveHistoryAndPersist().
    }

    /**
     * Move many nodes by one shared delta in a single engine call.
     *
     * Prefer this over a `moveNode` loop for anything touching a whole
     * selection: `move_node` re-unions every group ancestor's AABB on each
     * call, so N siblings under one group cost N × O(N). See
     * `Engine::move_nodes`. Cache discipline matches `moveNode` — translation
     * never changes local geometry, so renderer caches survive.
     */
    moveNodes(ids: ArrayLike<number>, dx: number, dy: number) {
        const list = Array.from(ids);
        if (list.length === 0) return;
        this.engine!.move_nodes(JSON.stringify(list.map((id) => ({ id, dx, dy }))));
        this.invalidateCacheTransformOnly(list);
    }

    /**
     * A world-space delta expressed in `id`'s own local space.
     *
     * `move_node` and friends translate a node by its LOCAL transform, which is
     * the same vector only while nothing above it is rotated or scaled. Every
     * caller that measured a delta off world bounds — align, distribute, an
     * arrow-key nudge — was handing a world vector to a local mover, so inside
     * a group scaled to 200% a 1px nudge moved 2px and "align top" overshot the
     * edge it was aligning to by the same factor.
     */
    worldDeltaToLocal(id: number, wdx: number, wdy: number): { dx: number; dy: number } {
        const parentId = this.engine!.get_node_parent(id);
        if (parentId < 0) return { dx: wdx, dy: wdy }; // at the root: same space
        // Row-major global: [scaleX, skewX, transX, skewY, scaleY, transY, …]
        const t = this.getTransform(parentId);
        const a = t[0],
            b = t[1],
            c = t[3],
            d = t[4];
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-10) return { dx: wdx, dy: wdy };
        return { dx: (d * wdx - b * wdy) / det, dy: (-c * wdx + a * wdy) / det };
    }

    /**
     * A world-space SIZE expressed in the node's own geometry space.
     *
     * Geometry (a rect's width, an ellipse's radii) is written in local units,
     * while everything a person reads off the canvas — the rulers, the
     * selection frame, the pointer — is world. The two are the same number only
     * while nothing above the node is scaled. Groups are the exception and must
     * not use this: the engine sizes those in world units, by scaling their
     * transform.
     */
    worldSizeToLocal(id: number, w: number, h: number): { w: number; h: number } {
        const t = this.getTransform(id); // world matrix, row-major
        const sx = Math.hypot(t[0], t[3]) || 1;
        const sy = Math.hypot(t[1], t[4]) || 1;
        return { w: w / sx, h: h / sy };
    }

    /** The world-space size of a local one — the inverse of `worldSizeToLocal`. */
    localSizeToWorld(id: number, w: number, h: number): { w: number; h: number } {
        const t = this.getTransform(id);
        const sx = Math.hypot(t[0], t[3]) || 1;
        const sy = Math.hypot(t[1], t[4]) || 1;
        return { w: w * sx, h: h * sy };
    }

    /** A world POINT in the node's parent space — where to put a node's local
     *  translation so its origin lands on that point. */
    worldPointToParentLocal(id: number, x: number, y: number): { x: number; y: number } {
        const parentId = this.engine!.get_node_parent(id);
        if (parentId < 0) return { x, y };
        const t = this.getTransform(parentId); // row-major global
        const a = t[0],
            b = t[1],
            tx = t[2],
            c = t[3],
            d = t[4],
            ty = t[5];
        const det = a * d - b * c;
        if (Math.abs(det) < 1e-10) return { x, y };
        const px = x - tx;
        const py = y - ty;
        return { x: (d * px - b * py) / det, y: (-c * px + a * py) / det };
    }

    /** Move a node by a WORLD-space delta, whatever its parent's transform. */
    moveNodeWorld(id: number, wdx: number, wdy: number) {
        const { dx, dy } = this.worldDeltaToLocal(id, wdx, wdy);
        this.moveNode(id, dx, dy);
    }

    /** Move many nodes by one shared WORLD-space delta, in a single engine
     *  call. Each node's delta is converted in its own parent's space. */
    moveNodesWorld(ids: ArrayLike<number>, wdx: number, wdy: number) {
        const list = Array.from(ids);
        if (list.length === 0) return;
        this.engine!.move_nodes(
            JSON.stringify(
                list.map((id) => {
                    const { dx, dy } = this.worldDeltaToLocal(id, wdx, wdy);
                    return { id, dx, dy };
                }),
            ),
        );
        this.invalidateCacheTransformOnly(list);
    }

    /** Call after a drag operation is complete to save state for undo. */
    saveMoveHistory() {
        this.saveHistory();
        this.autosave?.trigger();
    }

    /**
     * Public entry point for callers (e.g. InputManager) that need to push an
     * explicit undo snapshot — for example before a batch of grouped nudges or
     * when exiting a group context.  Unlike the private saveHistory(), this
     * also triggers autosave so disk state stays current.
     */
    pushHistorySnapshot() {
        this.saveHistory();
        this.autosave?.trigger();
    }

    selectNode(id: number, multi: boolean) {
        this.engine!.select_node(id, multi);
    }

    hitTest(x: number, y: number): number | undefined {
        const result = this.engine!.hit_test(x, y);
        // wasm-bindgen may surface Option<u32>::None as `null` (not only
        // `undefined`). Callers use `!== undefined` / `=== undefined`, so
        // normalize — otherwise empty clicks look like a hit on id 0 and
        // marquee selection never starts (dragMode stays `move`).
        return result == null ? undefined : result;
    }

    hitTestGrouped(x: number, y: number): number | undefined {
        const result = this.engine!.hit_test_grouped(x, y);
        return result == null ? undefined : result;
    }

    getNodeType(id: number): number | undefined {
        return this.engine!.get_node_type(id);
    }

    getNodeParent(id: number): number {
        return this.engine!.get_node_parent(id);
    }

    /** Drop ids whose ancestor is also in the list (prevents double-moves
     *  when a group and its children are both selected). */
    dedupSelection(ids: number[] | Uint32Array): Uint32Array {
        return this.engine!.dedup_selection(JSON.stringify(Array.from(ids)));
    }

    getSelection(): Uint32Array {
        return this.engine!.get_selection();
    }

    /** Reorder ids back-to-front, the way the document paints them.
     *
     *  The selection is stored in the order rows were *clicked*, and the Objects
     *  panel lists front-to-back — so shift-selecting a range there hands us the
     *  ids topmost-first. Anything that re-creates nodes one at a time (copy /
     *  paste, cut / paste, duplicate) appends each new node on top of the stack,
     *  which turns that click order into the copies' z-order and leaves the
     *  pasted set stacked opposite to the originals. Feed those loops this
     *  order instead. Ids the tree doesn't know about keep their relative order
     *  at the end rather than being dropped. */
    sortByPaintOrder(ids: number[] | Uint32Array): number[] {
        const wanted = new Set<number>(Array.from(ids));
        if (wanted.size === 0 || !this.engine) return Array.from(ids);
        const out: number[] = [];
        const walk = (id: number) => {
            if (wanted.delete(id)) out.push(id);
            for (const child of this.getNodeChildren(id)) walk(child);
        };
        for (const root of this.getRootNodes()) walk(root);
        for (const id of Array.from(ids)) if (wanted.delete(id)) out.push(id);
        return out;
    }

    getRootNodes(): Uint32Array {
        return this.engine!.get_root_nodes();
    }

    // ─── The mode each history state was captured in ────────────────────
    //
    // The engine snapshot carries the document and the selection, and nothing
    // about WHERE THE USER WAS STANDING: which shape was open for node editing
    // and with which anchors selected, which group they had drilled into. Undo
    // used to drop all of that on the floor — delete an anchor, leave node
    // editing, press ⌘Z, and the anchor came back somewhere you were no longer
    // looking. Figma and Illustrator both put you back in the context the edit
    // was made in, because that is the only place the restored change is
    // visible and editable.
    //
    // So each pushed state gets a parallel entry describing that context,
    // captured at push time — i.e. the mode the user was in when they made the
    // edit. The stacks are kept per `History` object (documents own theirs, and
    // tab switches swap the pointer) and re-trimmed against the engine's own
    // lengths after every operation, so an entry aged out of a full undo stack
    // takes its context with it.

    /** Installed by the UI layer (InputManager). */
    historyContext: HistoryContextHooks | null = null;
    private ctxStacks = new WeakMap<History, { undo: unknown[]; redo: unknown[] }>();

    private ctxFor(history: History): { undo: unknown[]; redo: unknown[] } {
        let stacks = this.ctxStacks.get(history);
        if (!stacks) {
            stacks = { undo: [], redo: [] };
            this.ctxStacks.set(history, stacks);
        }
        return stacks;
    }

    /** Re-align the mirror with the engine's stacks (which drop the oldest
     *  state at capacity). Trims from the FRONT of the undo stack, matching
     *  where History drops. */
    private trimContexts(history: History, stacks: { undo: unknown[]; redo: unknown[] }) {
        while (stacks.undo.length > history.undo_len()) stacks.undo.shift();
        while (stacks.redo.length > history.redo_len()) stacks.redo.shift();
        // Entries pushed before the hooks existed leave the mirror short; pad
        // at the front so index N still means state N.
        while (stacks.undo.length < history.undo_len()) stacks.undo.unshift(null);
        while (stacks.redo.length < history.redo_len()) stacks.redo.unshift(null);
    }

    /** Record the current editing context alongside a state just pushed onto
     *  the undo stack. Call immediately after every `history.push_state`. */
    private pushContext() {
        const history = this.history;
        if (!history) return;
        const stacks = this.ctxFor(history);
        stacks.undo.push(this.historyContext?.capture() ?? null);
        stacks.redo.length = 0; // push_state clears redo
        this.trimContexts(history, stacks);
    }

    undo() {
        const currentState = this.engine!.serialize_scene();
        const currentContext = this.historyContext?.capture() ?? null;
        const stacks = this.ctxFor(this.history!);
        const prevState = this.history!.undo(currentState);
        if (prevState) {
            const prevContext = stacks.undo.pop() ?? null;
            stacks.redo.push(currentContext);
            this.trimContexts(this.history!, stacks);
            this.engine!.deserialize_scene(prevState);
            this.invalidateCache();
            // After the document is back, not before: restoring a mode reads
            // the geometry it is about to open for editing.
            this.historyContext?.restore(prevContext);
            this.autosave?.trigger();
            logAppEvent('history_action', { action: 'undo' });
        }
    }

    redo() {
        const currentState = this.engine!.serialize_scene();
        const currentContext = this.historyContext?.capture() ?? null;
        const stacks = this.ctxFor(this.history!);
        const nextState = this.history!.redo(currentState);
        if (nextState) {
            const nextContext = stacks.redo.pop() ?? null;
            stacks.undo.push(currentContext);
            this.trimContexts(this.history!, stacks);
            this.engine!.deserialize_scene(nextState);
            this.invalidateCache();
            this.historyContext?.restore(nextContext);
            this.autosave?.trigger();
            logAppEvent('history_action', { action: 'redo' });
        }
    }

    /** True while inside a transaction() or gesture — intermediate history
     *  pushes are suppressed. */
    private _inTransaction = false;
    /** True only when an active gesture is the owner of the current
     *  suppression (i.e. beginGesture actually acquired it). Guards endGesture
     *  from closing a transaction it didn't open, or firing with no begin. */
    private _gestureOwnsSuppression = false;

    /**
     * Group several mutations into ONE undo step. A single history snapshot
     * is taken up front; saveHistory calls made by wrapper methods inside
     * `fn` become no-ops. Nested transactions join the outermost one.
     */
    transaction<T>(fn: () => T): T {
        if (this._inTransaction) return fn();
        this.saveHistory();
        this._inTransaction = true;
        try {
            return fn();
        } finally {
            this._inTransaction = false;
            this.invalidateCache();
            this.autosave?.trigger();
        }
    }

    /** True while a transaction() or beginGesture()/endGesture() bracket is
     *  open — callers use this to avoid opening a redundant nested gesture. */
    get inGesture(): boolean {
        return this._inTransaction;
    }

    /** Serialize the current scene — for explicit change detection / checkpoints. */
    serializeScene(): Uint8Array {
        return this.engine!.serialize_scene();
    }

    /** Push an explicit serialized state as an undo checkpoint (e.g. the
     *  PRE-edit state captured before a discrete mutation). No-op while a
     *  gesture/transaction owns history. */
    pushHistoryState(state: Uint8Array) {
        if (this._inTransaction) return;
        this.history!.push_state(state);
        this.pushContext();
        this.autosave?.trigger();
    }

    private saveHistory() {
        if (this._inTransaction) return;
        const state = this.engine!.serialize_scene();
        this.history!.push_state(state);
        this.pushContext();
    }

    /**
     * Bracketed variant of transaction() for multi-event gestures (label
     * scrubbing, slider drags): one undo snapshot at beginGesture(), then all
     * intermediate saveHistory pushes are suppressed until endGesture().
     * No-op when already inside a transaction/gesture.
     */
    beginGesture() {
        // If suppression is already active (e.g. inside a transaction), this
        // gesture piggybacks on it and must NOT claim ownership — the outer
        // owner is responsible for closing it.
        if (this._inTransaction) return;
        this.saveHistory();
        this._inTransaction = true;
        this._gestureOwnsSuppression = true;
    }

    endGesture() {
        // Only release suppression this gesture actually acquired. A stray
        // endGesture, or one nested inside a transaction, is a no-op.
        if (!this._gestureOwnsSuppression) return;
        this._gestureOwnsSuppression = false;
        this._inTransaction = false;
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /**
     * Returns the global transform for a node as a COPIED Float32Array in Skia row-major format.
     * Safe to store — won't be overwritten by subsequent calls.
     */
    getTransform(id: number): Float32Array {
        const ptr = this.engine!.get_node_transform_ptr(id);
        // IMPORTANT: Copy the data. The WASM pointer points to a single reused buffer
        // that gets overwritten on the next get_node_transform_ptr call.
        const view = new Float32Array(this.wasm!.memory.buffer, ptr, 9);
        return new Float32Array(view);
    }

    getVisibleNodes(minX: number, minY: number, maxX: number, maxY: number): Uint32Array {
        return this.engine!.get_visible_nodes(minX, minY, maxX, maxY);
    }

    isNodeDirty(id: number): boolean {
        return this.engine!.is_node_dirty(id);
    }

    clearNodeDirty(id: number) {
        this.engine!.clear_node_dirty(id);
    }

    /**
     * Returns parsed scene data. Cached per frame — only re-parsed if the scene
     * was mutated since the last call.
     */
    getSceneData(): SceneData {
        if (this._sceneDataDirty || !this._cachedSceneData) {
            this._cachedSceneData = JSON.parse(this.engine!.get_scene_json()) as SceneData;
            this._sceneDataDirty = false;
        }
        return this._cachedSceneData;
    }

    // ─── Per-Node Getters (avoid full-scene JSON serialization) ─────────

    /**
     * Get a single node's style. Only serializes ~200 bytes instead of the whole
     * scene. Null when the node is gone — the engine answers a missing id with
     * an empty string, which `JSON.parse` used to turn into a bare
     * `SyntaxError: Unexpected end of JSON input` several frames from the real
     * cause. An id can go stale for ordinary reasons (undo past a shape's
     * creation, a collaborator's delete), so absence is a normal answer, not an
     * exception. `getNode` already reports it this way.
     */
    getNodeStyle(id: number): import('./types').NodeStyle | null {
        const json = this.engine!.get_node_style_json(id);
        if (!json) return null;
        return JSON.parse(json);
    }

    /** Get a single node's geometry. Null when the node is gone — see getNodeStyle. */
    getNodeGeometry(id: number): import('./types').NodeGeometry | null {
        const json = this.engine!.get_node_geometry_json(id);
        if (!json) return null;
        return JSON.parse(json);
    }

    /**
     * Get a Path node's outline with per-vertex corner radii resolved into
     * explicit arcs. Returns [] for non-path geometry. Used where the rounded
     * outline is needed rather than the editable sharp geometry (SVG export,
     * boolean ops).
     */
    getResolvedSubpaths(id: number): import('./types').Subpath[] {
        return JSON.parse(this.engine!.resolve_subpaths_json(id));
    }

    /** Get a single node's full data as a SceneNode. */
    getNode(id: number): import('./types').SceneNode | null {
        const json = this.engine!.get_node_json(id);
        if (!json) return null;
        return JSON.parse(json);
    }

    /** Get a node's display name. */
    getNodeName(id: number): string {
        return this.engine!.get_node_name(id);
    }

    /** Rename a node (undo-disciplined). */
    setNodeName(id: number, name: string) {
        this.saveHistory();
        this.engine!.set_node_name(id, name);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Get a node's visible flag. */
    getNodeVisible(id: number): boolean {
        return this.engine!.get_node_visible(id);
    }

    /** Get a node's locked flag. */
    getNodeLocked(id: number): boolean {
        return this.engine!.get_node_locked(id);
    }

    /**
     * True when this node OR an ancestor is locked — the question every
     * "can the user grab this?" test actually wants. The raw flag only protects
     * the node it's set on, so a locked GROUP left its children grabbable, and
     * selection promotes a grabbed child back to the locked group.
     */
    isLockedInTree(id: number): boolean {
        return this.engine?.is_locked_in_tree(id) ?? false;
    }

    /** True when this node and all its ancestors are visible (what's on screen),
     *  as opposed to `getNodeVisible`'s own-flag-only answer. */
    isVisibleInTree(id: number): boolean {
        return this.engine?.is_visible_in_tree(id) ?? true;
    }

    /** Get a node's children IDs. */
    getNodeChildren(id: number): Uint32Array {
        return this.engine!.get_node_children(id);
    }

    /** Get a node's local transform as a column-major array. */
    getNodeLocalTransform(id: number): Float32Array {
        return this.engine!.get_node_local_transform(id);
    }

    // ─── End Per-Node Getters ───────────────────────────────────────────

    resizeNode(id: number, w: number, h: number) {
        this.saveHistory();
        this.engine!.resize_node(id, w, h);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    setNodePosition(id: number, x: number, y: number) {
        this.saveHistory();
        this.engine!.set_node_position(id, x, y);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set the full local transform of a node via a [f32; 9] matrix (column-major). */
    setNodeTransform(id: number, transform: number[]) {
        this.saveHistory();
        this.engine!.set_node_transform_matrix(id, JSON.stringify(transform));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set rotation in degrees. */
    setNodeRotation(id: number, deg: number) {
        this.saveHistory();
        this.engine!.set_node_rotation(id, deg);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set skew in degrees. */
    setNodeSkew(id: number, xDeg: number, yDeg: number) {
        this.saveHistory();
        this.engine!.set_node_skew(id, xDeg, yDeg);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Set scale factors. */
    setNodeScale(id: number, sx: number, sy: number) {
        this.saveHistory();
        this.engine!.set_node_scale(id, sx, sy);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Get decomposed transform components (position, rotation, skew, scale). */
    getNodeTransformComponents(id: number): Transform2D {
        return JSON.parse(this.engine!.get_node_transform_components(id));
    }

    /** Set all transform components at once. */
    setNodeTransformComponents(id: number, components: Transform2D) {
        this.saveHistory();
        this.engine!.set_node_transform_components(id, JSON.stringify(components));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    rotateNode(id: number, angleRad: number) {
        this.saveHistory();
        // Convert radians to degrees for the new set_node_rotation API
        const components = this.getNodeTransformComponents(id);
        this.engine!.set_node_rotation(id, components.rotation_deg + angleRad * (180 / Math.PI));
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flipNodeH(id: number) {
        this.saveHistory();
        this.engine!.flip_node_horizontal(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flipNodeV(id: number) {
        this.saveHistory();
        this.engine!.flip_node_vertical(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    flattenTransform(id: number) {
        this.saveHistory();
        this.engine!.flatten_transform(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    duplicateNode(id: number): number {
        this.saveHistory();
        const newId = this.engine!.duplicate_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
        return newId;
    }

    /**
     * Put a copy where its original lives: same parent, directly above it.
     *
     * `duplicate_node` hands every clone to the ROOT wearing the local
     * transform it had inside its parent — which reads as a different size and
     * place the moment anything above the original is scaled or turned. Every
     * copy a person makes (⌘D, ⌘V, an ⌥-drag, an offset path, an outlined
     * stroke) has to be filed back beside the thing it was copied from, and
     * carry that local transform across rather than preserving the world
     * position it briefly had at the root.
     *
     * Reparents through the engine directly: the caller owns the undo step
     * (a transaction) and the cache invalidation.
     */
    fileCopyBesideOriginal(copyId: number, originalId: number) {
        const parent = this.getNodeParent(originalId);
        if (parent === -1) return; // the original is at the root; so is the copy
        const sibs = Array.from(this.getNodeChildren(parent)).filter((c) => c !== copyId);
        const at = sibs.indexOf(originalId);
        const local = this.engine!.get_node_transform_components(copyId);
        this.engine!.reorder_nodes(
            JSON.stringify([copyId]),
            parent,
            at === -1 ? sibs.length : at + 1,
        );
        this.engine!.set_node_transform_components(copyId, local);
    }

    /** Cut: lift the nodes out of the document into the engine's clipboard,
     *  where paste can still reach them. See `Engine::cut_nodes`. */
    cutNodes(ids: number[] | Uint32Array): number {
        this.saveHistory();
        const n = this.engine!.cut_nodes(JSON.stringify(Array.from(ids)));
        this.invalidateCache();
        this.autosave?.trigger();
        return n;
    }

    /** Paste the cut nodes back at the top level, offset by (dx, dy). Does not
     *  consume the clipboard — pasting twice gives two copies. */
    pasteClipboard(dx: number, dy: number): number[] {
        this.saveHistory();
        const ids = Array.from(this.engine!.paste_clipboard(dx, dy));
        this.invalidateCache();
        this.autosave?.trigger();
        return ids;
    }

    hasClipboard(): boolean {
        return this.engine?.has_clipboard() ?? false;
    }

    removeNode(id: number) {
        this.saveHistory();
        this.engine!.remove_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Remove multiple nodes in a single history snapshot. */
    removeNodes(ids: number[] | Uint32Array) {
        this.saveHistory();
        for (const id of ids) {
            this.engine!.remove_node(id);
        }
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a set of nodes with a single path node (used by boolean ops).
     *  All mutations land in ONE history snapshot so a single undo restores
     *  the originals. Returns the new node's id. */
    replaceNodesWithPath(
        ids: number[] | Uint32Array,
        subpathsJson: string,
        styleJson: string | null,
    ): number {
        this.saveHistory();
        this.engine!.clear_selection();
        for (const id of ids) {
            this.engine!.remove_node(id);
        }
        const newId = this.engine!.add_path(subpathsJson);
        if (styleJson) {
            this.engine!.set_node_style(newId, styleJson);
        }
        this.engine!.select_node(newId, false);
        this.invalidateCache();
        this.autosave?.trigger();
        return newId;
    }

    /** Group the given node ids. Accepts any array-like (including the
     *  Uint32Array that get_selection() returns — JSON.stringify on a typed
     *  array would produce an object, not an array, so normalize here). */
    groupNodes(ids: number[] | Uint32Array): number {
        const idsJson = JSON.stringify(Array.from(ids));
        this.saveHistory();
        const groupId = this.engine!.group_nodes(idsJson);
        this.invalidateCache();
        this.autosave?.trigger();
        return groupId;
    }

    ungroupNode(id: number) {
        this.saveHistory();
        this.engine!.ungroup_node(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    addText(x: number, y: number, content: string, fontSize: number): number {
        this.saveHistory();
        const id = this.engine!.add_text(x, y, content, fontSize);
        this.invalidateCache();
        this.autosave?.trigger();
        return id;
    }

    /** Update a text node's content and font size. */
    setTextContent(id: number, content: string, fontSize: number) {
        this.saveHistory();
        this.engine!.set_text_content(id, content, fontSize);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Update a text node's typography properties. */
    setTextProperties(id: number, fontFamily: string, textAlign: number, lineHeight: number) {
        this.saveHistory();
        this.engine!.set_text_properties(id, fontFamily, textAlign, lineHeight);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Replace a node's geometry with a new path (for Create Outlines). */
    replaceGeometryWithPath(id: number, subpaths: any[]) {
        this.saveHistory();
        const json = JSON.stringify(subpaths);
        this.engine!.replace_geometry_with_path(id, json);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getNodeBounds(id: number): Float32Array {
        return this.engine!.get_node_bounds(id);
    }

    /**
     * A node's world bounds as `[minX, minY, maxX, maxY]`, with TEXT MEASURED
     * rather than estimated.
     *
     * The engine has no font metrics, so it boxes a text node as its longest
     * line × 0.6em (see `text_local_bbox`). That is fine for hit-testing and
     * wrong for layout: aligning a wordmark to a logo by that box leaves the
     * glyphs off-centre by half the error — 7pt for "REBASE.pro" in Inter 48,
     * and ±30% of the run for glyphs that are nothing like 0.6em wide. Anything
     * that POSITIONS text by its box should read this instead.
     *
     * Falls back to the engine's own box whenever nothing better exists: no
     * renderer, no font provider yet, or a subtree with no text in it — where
     * the engine's AABB is authoritative and already accounts for strokes and
     * effects.
     */
    getMeasuredNodeBounds(id: number): [number, number, number, number] {
        const measured = this.measuredTextBounds(id, 0);
        if (measured) return measured;
        const b = this.getNodeBounds(id);
        return [b[0], b[1], b[2], b[3]];
    }

    /** World bounds of a subtree that contains measurable text, or null when it
     *  holds none — the caller then keeps the engine's box for it untouched. */
    private measuredTextBounds(id: number, depth: number): [number, number, number, number] | null {
        if (depth > 32) return null; // cycle guard, as elsewhere in the walkers

        if (this.getNodeType(id) === 4) {
            // The same box the selection frame draws — measured with the font,
            // weight, slant and letter spacing the glyphs are actually drawn
            // with, and anchored the way the alignment shifts the run.
            const local = this.renderer?.getTextLocalBounds?.(id);
            if (!local) return null;
            const t = this.getTransform(id); // row-major world 3×3
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            for (const [lx, ly] of [
                [local.x, local.y],
                [local.x + local.w, local.y],
                [local.x + local.w, local.y + local.h],
                [local.x, local.y + local.h],
            ]) {
                const x = t[0] * lx + t[1] * ly + t[2];
                const y = t[3] * lx + t[4] * ly + t[5];
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
            }
            return [minX, minY, maxX, maxY];
        }

        // A Boolean Group paints ONE resolved outline and never its operands:
        // its engine bounds ARE that outline, so unioning children would report
        // geometry nobody can see.
        if (this.isBooleanGroup(id)) return null;

        const kids = this.getNodeChildren(id);
        if (kids.length === 0) return null;
        let box: [number, number, number, number] | null = null;
        let corrected = false;
        for (const kid of kids) {
            const m = this.measuredTextBounds(kid, depth + 1);
            if (m) corrected = true;
            const cb: ArrayLike<number> = m ?? this.getNodeBounds(kid);
            if (cb.length < 4 || (cb[2] <= cb[0] && cb[3] <= cb[1])) continue;
            box = box
                ? [
                      Math.min(box[0], cb[0]),
                      Math.min(box[1], cb[1]),
                      Math.max(box[2], cb[2]),
                      Math.max(box[3], cb[3]),
                  ]
                : [cb[0], cb[1], cb[2], cb[3]];
        }
        return corrected ? box : null;
    }

    /** Fill a vector-network face (paint bucket). Undoable like any other mutation. */
    setFaceFill(faceId: number, r: number, g: number, b: number, a: number) {
        this.saveHistory();
        this.engine!.set_face_fill(faceId, r, g, b, a);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Paint a face with any paint — the gradient path. `paint` is the same
     *  shape a node's `style.fills[0]` takes, in WORLD coordinates: a face is a
     *  world-space outline with no transform of its own. */
    setFacePaint(faceId: number, paint: unknown): boolean {
        this.saveHistory();
        const ok = this.engine!.set_face_paint(faceId, JSON.stringify(paint));
        this.invalidateCache();
        this.autosave?.trigger();
        return ok;
    }

    /** Un-paint a Live Paint region, leaving it transparent again. Undoable —
     *  it is a mutation like any other fill. */
    clearFaceFill(faceId: number) {
        this.saveHistory();
        this.engine!.clear_face_fill(faceId);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Un-paint a Live Paint edge, so only the member shapes' own strokes show. */
    clearEdgePaint(edgeId: number) {
        this.saveHistory();
        this.engine!.clear_edge_paint(edgeId);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** The Live Paint region at a world point, or -1 when there is none. */
    queryFaceAt(x: number, y: number): number {
        return this.engine?.query_face_at(x, y) ?? -1;
    }

    /** A face's paint, or null when it has none. */
    getFacePaint(faceId: number): import('./types').Paint | null {
        try {
            const json = this.engine!.get_face_paint(faceId);
            return json ? JSON.parse(json) : null;
        } catch {
            return null;
        }
    }

    /** Write a face's paint WITHOUT a history entry — for live handle drags,
     *  which the caller brackets with a gesture so the whole drag is one undo. */
    setFacePaintNoHistory(faceId: number, paint: unknown): boolean {
        const ok = this.engine!.set_face_paint(faceId, JSON.stringify(paint));
        this.invalidateCache();
        return ok;
    }

    /** A face's world-space outline as bézier points ({x, y, cp1, cp2}), or
     *  null. Anchors alone under-state a bulging curve's extent, so callers
     *  measuring a box should include the control points. */
    getFaceOutline(
        faceId: number,
    ): { x: number; y: number; cp1: number[]; cp2: number[] }[] | null {
        try {
            const json = this.engine!.get_face_boundary(faceId);
            if (!json) return null;
            const pts = JSON.parse(json);
            return Array.isArray(pts) && pts.length > 0 ? pts : null;
        } catch {
            return null;
        }
    }

    /** Set the Live Paint gap-closing distance (world units, 0 = off). Undoable:
     *  it changes which regions exist, so it can gain/lose fills. */
    setGapBridgeDistance(distance: number) {
        this.saveHistory();
        this.engine!.set_gap_bridge_distance(distance);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    getGapBridgeDistance(): number {
        return this.engine?.get_gap_bridge_distance() ?? 0;
    }

    /** Set one Live Paint group's own gap-closing distance, or pass a negative
     *  value to clear it so the group inherits the document default. Undoable
     *  for the same reason the document-wide one is: it changes which regions
     *  exist, so fills can appear or disappear. */
    setNodeGapBridgeDistance(id: number, distance: number) {
        this.saveHistory();
        this.engine!.set_node_gap_bridge_distance(id, distance);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** A group's own gap distance, or -1 when it inherits the document default. */
    getNodeGapBridgeDistance(id: number): number {
        return this.engine?.get_node_gap_bridge_distance(id) ?? -1;
    }

    /** The gap distance actually in force for a group — its own, or the
     *  inherited default. This is what the bucket obeys. */
    getEffectiveGapBridgeDistance(id: number): number {
        return this.engine?.get_effective_gap_bridge_distance(id) ?? 0;
    }

    /** Nearest paintable Live Paint edge to a point, or -1. */
    queryEdgeAt(x: number, y: number, tolerance: number): number {
        return this.engine?.query_edge_at(x, y, tolerance) ?? -1;
    }

    /** Scope Live Paint to a group node (0 clears). Undoable. */
    setLivePaintGroup(nodeId: number) {
        this.saveHistory();
        this.engine!.set_live_paint_group(nodeId);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** Active Live Paint group node id, or -1. */
    getLivePaintGroup(): number {
        return this.engine?.get_live_paint_group() ?? -1;
    }

    /** Flag (or unflag) a Group as a Live Paint group. Undoable. */
    setNodeLivePaint(id: number, value: boolean) {
        this.saveHistory();
        this.engine!.set_node_live_paint(id, value);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /** True if the node is a Live Paint group. */
    getNodeLivePaint(id: number): boolean {
        return this.engine?.get_node_live_paint(id) ?? false;
    }

    // ─── Non-destructive Boolean Groups (Figma-style) ───────────────────────

    /** The boolean op index (0=union..3=exclude) on a group, or -1 if it isn't
     *  a Boolean Group. */
    getBooleanOp(id: number): number {
        return this.engine?.get_boolean_op(id) ?? -1;
    }

    /** True if the node is a non-destructive Boolean Group. */
    isBooleanGroup(id: number): boolean {
        return this.getBooleanOp(id) >= 0;
    }

    /**
     * A Boolean Group's resolved outline bounds in its own LOCAL space, or null
     * when the node isn't a Boolean Group (or its outline hasn't been recomputed
     * yet — `bool_cache` isn't serialized, so it's empty until the pass after a
     * load). World bounds come from `getNodeBounds` as for any other node.
     */
    getBooleanLocalBounds(id: number): { x: number; y: number; w: number; h: number } | null {
        const b = this.engine?.get_boolean_local_bounds(id);
        if (!b || b.length < 4) return null;
        return { x: b[0], y: b[1], w: b[2] - b[0], h: b[3] - b[1] };
    }

    /**
     * Group the given nodes (2+) into a non-destructive Boolean Group and cache
     * its resolved outline. The group carries the bottom operand's style. Returns
     * the new group id, or -1 if the nodes can't be combined at all. Undoable.
     *
     * An *empty* result is not a failure: Intersect on shapes with no common
     * region legitimately yields nothing. We still build the group — the op is
     * non-destructive, so the operands stay alive inside it and the user can
     * switch to Union, drag a child until the shapes do overlap, Release, or
     * undo. Refusing to create it made the menu item look broken instead
     * ("I click Intersect and nothing happens"), with nothing on screen to
     * explain why. recomputeBooleanGroup already caches an empty outline for a
     * live group whose op stops producing geometry; this makes creation agree.
     *
     * `null` (as opposed to empty) means an operand isn't path-convertible at
     * all — e.g. text — and there is nothing to group, so that still returns -1.
     */
    makeBooleanGroup(ck: CanvasKit, ids: number[], op: BoolOp): number {
        if (ids.length < 2) return -1;
        // Compute the outline BEFORE grouping — operand world geometry is
        // unchanged by grouping, and we need the bottom node's style.
        const res = computeBooleanSubpaths(ck, this, ids, op);
        if (!res) return -1; // not evaluable at all (e.g. a text operand)
        const styleData = this.getNodeStyle(ids[0]);

        this.saveHistory();
        const groupId = this.engine!.group_nodes(JSON.stringify(ids));
        this.engine!.set_boolean_op(groupId, BOOL_OP_INDEX[op]);
        if (styleData) {
            this.engine!.set_node_style(
                groupId,
                JSON.stringify({ ...styleData, fill_rule: res.fillRule }),
            );
        }
        this.pushBoolCache(groupId, res.subpaths);
        // Select the new group so its Boolean-Group controls surface immediately.
        this.engine!.clear_selection();
        this.engine!.select_node(groupId, false);
        this.invalidateCache();
        this.autosave?.trigger();
        return groupId;
    }

    /** Change the op on an existing Boolean Group and recompute. Undoable. */
    setBooleanOp(ck: CanvasKit, groupId: number, op: BoolOp): boolean {
        if (!this.isBooleanGroup(groupId)) return false;
        this.saveHistory();
        this.engine!.set_boolean_op(groupId, BOOL_OP_INDEX[op]);
        this.recomputeBooleanGroup(ck, groupId);
        this.invalidateCache();
        this.autosave?.trigger();
        return true;
    }

    /** Turn a Boolean Group back into an ordinary group (children reappear as
     *  independent shapes). Undoable. */
    releaseBoolean(groupId: number): boolean {
        if (!this.isBooleanGroup(groupId)) return false;
        this.saveHistory();
        this.engine!.set_boolean_op(groupId, -1);
        this.invalidateCache();
        this.autosave?.trigger();
        return true;
    }

    /**
     * Bake a Boolean Group into a single editable Path node, dropping the operand
     * children. Returns the new path id, or -1 on failure. Undoable.
     */
    flattenBoolean(ck: CanvasKit, groupId: number): number {
        const opIdx = this.getBooleanOp(groupId);
        if (opIdx < 0) return -1;
        const childIds = Array.from(this.getNodeChildren(groupId));
        const res = computeBooleanSubpaths(ck, this, childIds, BOOL_OP_BY_INDEX[opIdx]);
        // Baking drops the operands, so an empty outline would leave an empty
        // path and nothing else — decline, same as the destructive ops.
        if (!res || res.subpaths.length === 0) return -1;
        const styleData = this.getNodeStyle(groupId);
        const styleJson = styleData
            ? JSON.stringify({ ...styleData, fill_rule: res.fillRule })
            : null;
        // replaceNodesWithPath removes the group (and its children recursively)
        // and adds one path at root carrying the world-space outline.
        return this.replaceNodesWithPath([groupId], JSON.stringify(res.subpaths), styleJson);
    }

    /**
     * Drain the engine's set of stale Boolean Groups and recompute each outline.
     * Called by the renderer every frame (before it reads the render buffer) so a
     * child edit re-evaluates the boolean live. Cheap no-op when nothing is dirty.
     */
    recomputeDirtyBooleanGroups(ck: CanvasKit): void {
        if (!this.engine) return;
        let ids: number[];
        try {
            ids = JSON.parse(this.engine.take_dirty_boolean_groups());
        } catch {
            return;
        }
        if (!ids.length) return;
        for (const id of ids) this.recomputeBooleanGroup(ck, id);
        // Derived-cache refresh, not a user edit: clear render caches so the new
        // outline is drawn, but don't advance history/dirty state.
        this.invalidateCache(false);
    }

    /** Recompute one Boolean Group's cached outline from its current children. */
    private recomputeBooleanGroup(ck: CanvasKit, groupId: number): void {
        const opIdx = this.engine!.get_boolean_op(groupId);
        if (opIdx < 0) return;
        const childIds = Array.from(this.getNodeChildren(groupId));
        if (childIds.length < 2) {
            this.engine!.set_bool_cache(groupId, '[]');
            return;
        }
        const res = computeBooleanSubpaths(ck, this, childIds, BOOL_OP_BY_INDEX[opIdx]);
        this.pushBoolCache(groupId, res ? res.subpaths : []);
    }

    /** Store a world-space outline into a group's cache, converted to the group's
     *  local frame so it moves with the group's transform for free. */
    private pushBoolCache(groupId: number, worldSubpaths: Subpath[]): void {
        const t = this.getTransform(groupId);
        const inv = invertAffine(t);
        const local = inv ? transformSubpaths(worldSubpaths, inv) : worldSubpaths;
        this.engine!.set_bool_cache(groupId, JSON.stringify(local));
    }

    /** Paint a Live Paint edge with a stroke color/width. Undoable. */
    setEdgePaint(edgeId: number, r: number, g: number, b: number, a: number, width: number) {
        this.saveHistory();
        this.engine!.set_edge_paint(edgeId, r, g, b, a, width);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    convertToPath(id: number): boolean {
        this.saveHistory();
        const converted = this.engine!.convert_to_path(id);
        if (converted) {
            this.invalidateCache();
            this.autosave?.trigger();
        }
        return converted;
    }

    bringToFront(id: number) {
        this.saveHistory();
        this.engine!.bring_to_front(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    sendToBack(id: number) {
        this.saveHistory();
        this.engine!.send_to_back(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    bringForward(id: number) {
        this.saveHistory();
        this.engine!.bring_forward(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    sendBackward(id: number) {
        this.saveHistory();
        this.engine!.send_backward(id);
        this.invalidateCache();
        this.autosave?.trigger();
    }

    /**
     * Move `nodeId` to become a child of `newParent` (or a root when null),
     * inserted at `index` in the parent's bottom-up child order. Preserves the
     * node's visual position. Returns false if the move was rejected (e.g. a
     * cycle or a non-group parent). One undo snapshot per call.
     */
    reorderNode(nodeId: number, newParent: number | null, index: number): boolean {
        return this.reorderNodes([nodeId], newParent, index) === 1;
    }

    /**
     * Move several nodes (given in bottom-up z-order) so they become contiguous
     * siblings under `newParent` (or roots when null), starting at `index`.
     * Preserves their relative order and visual positions. Returns the number of
     * nodes actually moved. One undo snapshot per call, taken only if at least
     * one node moved so an invalid drop leaves no dead undo step.
     */
    reorderNodes(nodeIds: number[], newParent: number | null, index: number): number {
        const snapshot = this._inTransaction ? null : this.engine!.serialize_scene();
        const moved = this.engine!.reorder_nodes(
            JSON.stringify(nodeIds),
            newParent ?? undefined,
            index,
        );
        if (moved > 0) {
            if (snapshot !== null) {
                this.history!.push_state(snapshot);
                this.pushContext();
            }
            this.invalidateCache();
            this.autosave?.trigger();
        }
        return moved;
    }
}
