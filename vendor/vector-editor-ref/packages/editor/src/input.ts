import { type AlignMode, alignSelection } from './align';
import { blendNodes } from './blend';
import { type BoolOp, nodeToWorldPath, pathToSubpaths, transformSubpaths } from './boolean_ops';
import { cornerRadiusHandles, grabsCornerHandle } from './corner_handles';
import type { DocumentManager } from './document_manager';
import { computeEqualSpacing } from './equal_spacing';
import { adoptEmbeddedFonts, FileIO } from './file_io';
import type { FileService } from './file_service';
import { DEFAULT_TEXT_FONT, ensureFontCSS, loadGoogleFontData } from './fonts';
import type { GuideHit, GuidesController } from './guides';
import { TOOL_BINDINGS } from './keybindings';
import { parseLoadResult } from './load_status';
import type { MeshEditController } from './mesh_edit';
import { offsetPath } from './offset_path';
import { outlineStroke } from './outline_stroke';
import {
    addAnchorPoint,
    findNearestSegment,
    joinSubpaths,
    mergeSelectedAnchors,
    reverseSubpaths,
    type SegmentHitResult,
    splitPathAtPoint,
    splitPathAtSegment,
} from './path_ops';
import type { ArtboardHandle, Renderer } from './renderer';
import { pathPointCount, simplifyPath } from './simplify_path';
import { SnapEngine, type SnapGuide } from './snapping';
import { textNodeToSubpaths } from './text_outlines';
import type { Artboard, Gradient, PathPoint, PenPathPoint, Subpath } from './types';
import { isMeshGradient } from './types';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';
import { applyWidthProfile, type WidthProfile } from './width_profile';

/**
 * Minimum pointer travel, in *screen* pixels, before a press turns into a drag
 * (a move of the selection, or a marquee). Measured from the mouse-down point so
 * it's cumulative, not per-frame, and independent of zoom. Below this a press is
 * treated as a pure click (select / deselect) — this is what stops a click from
 * accidentally nudging an object or spawning a marquee, especially when zoomed
 * out where a fraction of a world unit is a fraction of a screen pixel.
 */
const DRAG_START_THRESHOLD_PX = 4;

/**
 * The mode the user is standing in, stored alongside every undo state so ⌘Z
 * can put them back in it. See InputManager.captureModeContext.
 */
export interface ModeContext {
    /** Active tool at the time — restored only where a mode implies it. */
    tool: string;
    /** Open for node editing, with the anchors that were picked inside it. */
    editing: {
        nodeId: number;
        /** "subpathIndex:pointIndex" keys, as in `selectedPoints`. */
        points: string[];
        anchorSubpath: number;
        anchorIndex: number;
        addPoint: boolean;
    } | null;
    /** The group drilled into, if any. */
    enteredGroup: number | null;
    /** The mesh fill open for editing, with its selected vertices. */
    mesh: { nodeId: number; fillIndex: number; vertices: number[] } | null;
}

/** 2D affine matrix in DOMMatrix convention: x' = a·x + c·y + e, y' = b·x + d·y + f. */
interface Mat {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

/** Cache of measured CSS first-line baseline offsets (em), keyed by font style. */
const _cssBaselineCache = new Map<string, number>();
/**
 * Measure where CSS puts a font's first-line baseline, as a fraction of the font
 * size below the line box's top. Used to align the inline text overlay's glyphs
 * with the rendered ones. Cached per font signature (a hidden-DOM measure).
 */
function measureCssBaselineEm(
    fontFamily: string,
    fontWeight: string,
    fontStyle: string,
    lineHeight: number,
): number {
    const key = `${fontFamily}|${fontWeight}|${fontStyle}|${lineHeight}`;
    const cached = _cssBaselineCache.get(key);
    if (cached !== undefined) return cached;
    const size = 100; // measure at a large size for precision
    const probe = document.createElement('div');
    probe.style.cssText =
        `position:absolute;visibility:hidden;left:-9999px;top:-9999px;white-space:pre;` +
        `font-family:${fontFamily};font-weight:${fontWeight};font-style:${fontStyle};` +
        `font-size:${size}px;line-height:${lineHeight};`;
    probe.textContent = 'Hg';
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
    probe.appendChild(marker);
    document.body.appendChild(probe);
    const em = (marker.getBoundingClientRect().top - probe.getBoundingClientRect().top) / size;
    document.body.removeChild(probe);
    _cssBaselineCache.set(key, em);
    return em;
}

/** Oriented selection frame: the rect (0,0)–(w,h) in frame space, mapped to
 *  world by `m`. For a single node this is its local bounds under its world
 *  transform (so it rotates/skews with the shape); for multi-selection it is
 *  the axis-aligned union (m = pure translation). */
export interface SelectionFrame {
    w: number;
    h: number;
    m: Mat;
}

/** Resolved scissors cut target: either an existing anchor or a point on a
 *  segment, on a specific path node. Produced by {@link InputManager.findScissorTarget}. */
interface ScissorTarget {
    nodeId: number;
    subpaths: Subpath[];
    /** Set when the closest target is an existing anchor point. */
    anchor?: { subpathIndex: number; pointIndex: number };
    /** Set when the closest target is a point along a segment. */
    segment?: SegmentHitResult;
    /** World-space location of the cut (for the hover preview dot). */
    worldX: number;
    worldY: number;
    /** World-space distance from the cursor to the cut location. */
    distance: number;
}

/** Tools that snap their origin point, so they also get a pre-drag snap
 *  preview (guides shown while hovering, before the drag starts).
 *  Pen is excluded: it still snaps via {@link updatePenHover}, but must not
 *  paint sticky edge / fullscreen snap chrome while placing anchors. */
const HOVER_SNAP_TOOLS = new Set(['line', 'rect', 'ellipse', 'polygon', 'star', 'artboard']);

export class InputManager {
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    ui: UIEngine;
    renderer: Renderer;
    /** Assigned by main.ts after construction; routes ⌘S/⌘⇧S. */
    fileService: FileService | null = null;
    /** Assigned by main.ts; owns open/new/close/cycle across tabs. */
    documentManager: DocumentManager | null = null;
    /** Assigned by main.ts; opens the export dialog (⇧⌘E). */
    openExportDialog: (() => void) | null = null;
    isMouseDown: boolean;
    startPos: { x: number; y: number };
    currentPos: { x: number; y: number };
    /** True after at least one canvas pointer sample — gates paste-at-pointer. */
    private pointerSceneReady = false;

    /** Maps plain-letter shortcuts to tool ids. Double-tapping the same letter
     *  within {@link TOOL_LOCK_WINDOW_MS} locks the tool (keyboard equivalent of
     *  double-clicking the toolbar button). */
    /** Built from the shared binding table so the Shortcuts dialog documents the
     *  keys this actually listens for, rather than a copy that can drift. */
    static readonly TOOL_SHORTCUTS: Record<string, string> = Object.fromEntries(
        TOOL_BINDINGS.map((t) => [t.key, t.tool]),
    );
    private static readonly TOOL_LOCK_WINDOW_MS = 400;
    /** Last tool-shortcut press, for double-tap-to-lock detection. */
    private lastToolKey: { tool: string; at: number } | null = null;

    /** The currently-open inline text overlay (edit or create), or null. */
    private activeTextOverlay: { commit: () => void } | null = null;
    /** Recomputes the active overlay's screen position/size; called on view change. */
    private repositionOverlay: (() => void) | null = null;

    dragMode: 'move' | 'marquee' | 'none' = 'none';
    /** Active artboard move/resize drag (UI-level; engine nodes untouched). */
    private artboardDrag: {
        id: number;
        mode: 'move' | 'resize';
        handle: ArtboardHandle | null;
        start: { x: number; y: number; w: number; h: number };
        startWorld: { x: number; y: number };
        /** Top-level nodes contained in the artwork at drag start — they travel
         *  with the frame on a move (empty for resize). */
        contained: number[];
        /** Cumulative delta already applied to `contained` this drag. */
        movedDx: number;
        movedDy: number;
    } | null = null;
    /** Whether any actual movement happened during a drag. */
    didMove: boolean = false;
    /**
     * A shape shift-clicked while it was already selected, waiting to see
     * whether this turns into a drag.
     *
     * Shift-click has to mean two things at once: "add this to the selection"
     * and, on something already in it, "take it out again". Doing the removal on
     * mouse-DOWN would break the other half — shift-dragging a multi-selection by
     * grabbing one of its members, which is how anyone moves a group of shapes —
     * because the shape under the cursor would leave the selection just as the
     * drag began. So the removal waits for mouse-up, and only happens if nothing
     * moved.
     */
    pendingShiftDeselect: number | null = null;
    /** Live preview rect in world coords, read by Renderer each frame. */
    previewRect: { x: number; y: number; w: number; h: number; tool: string } | null = null;
    /** Live line-tool preview (start → end) in world coords, read by Renderer. */
    previewLine: { x1: number; y1: number; x2: number; y2: number } | null = null;
    /** Freehand pencil-tool samples in world coords, read by Renderer each frame. */
    pencilPoints: { x: number; y: number }[] | null = null;
    /** Live ghost of a parametric action's result (Offset / Simplify / Blend), in
     *  WORLD coords, drawn while that action's value dialog is open. Null otherwise. */
    shapePreview: { subpaths: import('./types').Subpath[]; fillRule: number } | null = null;
    /** Accumulated pen-tool anchor points for the current path being drawn. */
    currentPathPoints: PenPathPoint[] = [];
    isDraggingHandle: boolean = false;
    /** Marquee selection rect in world coords, read by Renderer each frame. */
    marqueeRect: { x: number; y: number; w: number; h: number } | null = null;
    /** The group being worked in when a marquee started — captured because the
     *  marquee clears the selection that establishes it. */
    private marqueeGroupContext: number | null = null;
    clipboardIds: number[] = [];
    /** Figma-style artwork clipboard: a frame descriptor plus its contained
     *  top-level node ids, captured on copy. When set, it takes precedence over
     *  `clipboardIds` on paste (and is cleared when plain nodes are copied). */
    private artboardClipboard: { ab: Artboard; nodeIds: number[] } | null = null;

    // --- Modifier key state (updated every mousemove) ---
    shiftKey: boolean = false;
    altKey: boolean = false;
    metaKey: boolean = false;
    ctrlKey: boolean = false;

    /** Last mousemove event, so a modifier keypress mid-drag can reapply the
     *  transform at the current cursor without waiting for the next mouse move. */
    private lastMouseEvent: MouseEvent | null = null;

    // --- Move drag state (snapshot-restore, like resize) ---
    /** Snapshot of scene state taken at drag start so we can restore & reapply each frame. */
    moveSnapshot: Uint8Array | null = null;
    /** Original selection IDs captured at drag start. */
    moveOriginalIds: number[] = [];
    /** Union bounds of the selection at move-drag start, used for snapping. */
    moveStartBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** True while an Alt clone-drag has live clones in the scene, so the next
     *  frame must full-restore (deserialize) to remove them rather than take
     *  the fast per-target transform reset. */
    private moveClonesActive = false;

    /**
     * Per-target pristine LOCAL transforms captured at the start of a
     * transform-only gesture (move / rotate / group-resize). Resetting just
     * these nodes each frame is far cheaper than deserializing the whole scene
     * (~5 ms for a 20-group doc) when only the gesture targets move. Null when
     * no fast-reset gesture is active. See captureGesturePristine.
     */
    private gesturePristine: Map<number, number[]> | null = null;

    // --- Snapping ---
    /** Snap engine; targets are collected at drag start. Hold Cmd/Ctrl to bypass. */
    snap = new SnapEngine();
    /** Guides from the latest snapped frame, drawn by the Renderer. */
    activeSnapGuides: SnapGuide[] = [];
    /** Ruler/guide controller (set in main.ts once constructed). */
    guides: GuidesController | null = null;
    /** Alt/Option held during the current hover — gates the measure-to-hovered
     *  readout (Figma only measures on Alt-hover, not always). */
    hoverAlt = false;
    /** Active equal-spacing matches for the current move drag — the renderer draws
     *  their matched gaps (including the EXISTING reference gap being matched) so
     *  you see the spacing you're snapping to. Null when there's no match. */
    equalSpacing: import('./equal_spacing').EqualMatch[] | null = null;
    /** Guide highlighted by hover or an in-progress drag (drawn emphasized). */
    highlightedGuide: GuideHit | null = null;
    /** Guide clicked/selected (drives the guide action bar: Lock, Delete). */
    selectedGuide: GuideHit | null = null;
    /** The ruler guide currently being dragged on the canvas, if any. */
    private draggingGuide: GuideHit | null = null;

    // --- Viewport navigation ---
    /** True while the space bar is held (hand tool). */
    isSpacePan: boolean = false;
    /** Active pan drag: screen position and pan at drag start. */
    panDrag: { screenX: number; screenY: number; panX: number; panY: number } | null = null;
    /** Node under the cursor (selection tool, not dragging) — outlined by the Renderer. */
    hoverNodeId: number | null = null;

    /** The group the user has DRILLED INTO — set only by a gesture that means
     *  "go inside": a double-click on a group, or Enter on one. While it is set,
     *  clicks inside it pick its children instead of promoting to the whole
     *  group, which is what makes editing within a group feel like a place you
     *  are standing in.
     *
     *  It used to be inferred instead — "selection[0] has a group parent, so we
     *  must be inside that group" — and that quietly made every OTHER way of
     *  selecting a child a one-way door. Drag a shape into a group in the
     *  Objects panel and it stays selected, now with a group parent: the editor
     *  believed you were inside the group you had never entered, so a
     *  double-click no longer entered it — it went straight to node-editing the
     *  shape, and nothing short of Escape or an empty-canvas click got you back
     *  out. Entering is a gesture; it is not something to guess from a parent
     *  pointer. */
    private enteredGroup: number | null = null;

    // --- Direct selection state ---
    /** Node being edited in direct selection mode. */
    editingNodeId: number | null = null;
    /** Local copy of subpaths for editing. */
    editingPoints: Subpath[] | null = null;
    /** Index of point being dragged. */
    draggingPointIndex: number = -1;
    /** Index of subpath being dragged. */
    draggingSubpathIndex: number = -1;
    /** Which part is being dragged: 'anchor', 'cp1', 'cp2', or null. */
    draggingHandleType: 'anchor' | 'cp1' | 'cp2' | null = null;
    /**
     * True while Alt-dragging an anchor to pull out (or reset) its bezier
     * handles — the "convert anchor point" gesture. Forces symmetric handle
     * mirroring even though Alt is held (which normally breaks the tangent),
     * and turns a zero-distance click into a handle-collapse (smooth→corner).
     */
    convertingAnchor: boolean = false;
    /** Transform of the node being edited (for world<->local conversion). */
    editingTransform: Float32Array | null = null;
    /** Set of selected points in the format "subpathIndex:pointIndex" */
    selectedPoints: Set<string> = new Set();
    /** The selected anchor index in path editing (for delete point). */
    selectedAnchorSubpath: number = -1;
    selectedAnchorIndex: number = -1;
    /** The segment currently under the cursor in edit mode. */
    hoverSegment: { subpathIndex: number; segmentIndex: number } | null = null;
    /** Scene bytes captured when an anchor/handle press begins, held until the
     *  gesture proves it moved something. See beginPointDrag. */
    private pointDragPre: Uint8Array | null = null;
    /** True once the in-flight point drag has actually changed geometry. */
    private pointDragChanged = false;

    // --- Path operation state ---
    /** True when Add Point mode is active (next click on segment adds a point). */
    addPointMode: boolean = false;
    /**
     * Path-edit 「曲线」/ Convert Point mode — anchor press behaves like Alt
     * convert (drag pulls handles; click toggles smooth↔corner).
     */
    convertPointMode: boolean = false;
    /** World-space point on nearest segment for scissors/add-point hover preview. */
    scissorsHoverPoint: { x: number; y: number } | null = null;

    // --- Resize handle state ---
    resizeHandleType: string | null = null; // 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', or null
    resizeStartBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Deduped selection ids captured at resize start (ancestors only, no double-scaling). */
    resizeTargetIds: number[] = [];
    /** Snapshot of the scene state before resize started, so we can restore and reapply cleanly. */
    resizeSnapshot: Uint8Array | null = null;
    /** Current calculated bounds during a resize drag, read by Renderer for smooth sticky handles. */
    liveResizeBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Non-null while resizing a rotated/skewed frame — switches to the oriented pipeline. */
    resizeFrame: SelectionFrame | null = null;
    /** Local bounds of the single oriented-resize target, captured at drag start. */
    private resizeLocalBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Live oriented frame during an oriented resize drag, read by the Renderer. */
    liveFrame: SelectionFrame | null = null;

    // --- Corner radius handle state ---
    cornerRadiusDragging: {
        nodeId: number;
        startRadius: number;
        startPos: { x: number; y: number };
    } | null = null;

    // --- Gradient handle state ---
    /** True while dragging an on-canvas gradient handle (ui.gradientEdit owns the details). */
    gradientDragActive: boolean = false;
    /** True while a mesh vertex/handle drag is in flight (Mesh tool). */
    meshDragActive: boolean = false;
    /** Mesh-tool vertex marquee: press origin (world) + Shift-additive flag. */
    private meshMarqueeStart: { x: number; y: number } | null = null;
    private meshMarqueeAdditive = false;

    // --- Rotate handle state ---
    /** Which corner the rotation drag grabbed ('nw'|'ne'|'se'|'sw'), or null when not rotating. */
    rotateHandleType: string | null = null;
    /** Deduped selection ids captured at rotate start (ancestors only, no double-rotation). */
    rotateTargetIds: number[] = [];
    /** Snapshot of the scene before rotation started, restored & reapplied each frame. */
    rotateSnapshot: Uint8Array | null = null;
    /** World-space pivot the selection rotates about (selection-bounds center). */
    rotatePivot: { x: number; y: number } | null = null;
    /** Angle (radians) from pivot to the cursor at drag start, the zero reference. */
    rotateStartAngle: number = 0;
    /** Start rotation of a single selected node (deg), used for 15° absolute snapping. */
    rotateSingleStartDeg: number | null = null;
    /** Cached angle-oriented cursor data URIs (rotate + resize arrows), keyed by kind:angle. */
    private cursorCache: Record<string, string> = {};

    // --- Arrow key nudge grouping state ---
    /** Timer that fires after 500ms of no nudging, to finalise the grouped nudge undo step. */
    private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
    /** True while a nudge sequence is in progress (history was already saved at the start). */
    private nudgeInProgress: boolean = false;

    constructor(canvas: HTMLCanvasElement, scene: WasmScene, ui: UIEngine, renderer: Renderer) {
        this.canvas = canvas;
        this.scene = scene;
        this.ui = ui;
        this.renderer = renderer;

        this.isMouseDown = false;
        this.startPos = { x: 0, y: 0 };
        this.currentPos = { x: 0, y: 0 };

        // Keep an open inline text overlay glued over the glyphs when the view
        // transform changes (zoom/pan while editing).
        this.renderer.onViewChange(() => this.repositionOverlay?.());

        // Undo restores the document; these hooks make it restore the MODE the
        // edit was made in as well. See captureModeContext.
        this.scene.historyContext = {
            capture: () => this.captureModeContext(),
            restore: (ctx) => this.restoreModeContext(ctx as ModeContext | null),
        };

        this.init();
    }

    init() {
        // Helper: wrap handler to request a render frame after every interaction
        const withRender =
            <E extends Event>(handler: (e: E) => void) =>
            (e: E) => {
                handler.call(this, e);
                this.renderer.requestRender();
            };

        this.canvas.addEventListener(
            'mousedown',
            withRender((e: MouseEvent) => this.onMouseDown(e)),
        );
        this.canvas.addEventListener(
            'dblclick',
            withRender((e: MouseEvent) => this.onDoubleClick(e)),
        );
        this.canvas.addEventListener('contextmenu', (e) => this.onContextMenu(e));
        // Clear any hover snap-preview guides when the pointer leaves the canvas.
        this.canvas.addEventListener(
            'mouseleave',
            withRender(() => {
                if (!this.isMouseDown && this.activeSnapGuides.length) this.activeSnapGuides = [];
            }),
        );
        // Do NOT wrap mousemove in withRender. Window-level moves fire continuously
        // (including over product chrome / idle jitter) and a blanket requestRender
        // keeps CanvasKit painting every display frame — empty-scene idle collapses
        // to ~2fps when each paint also pays invalidateRenderCaches from the bridge.
        // Hover/drag paths below call requestRender only when visuals change.
        window.addEventListener('mousemove', (e: MouseEvent) => this.onMouseMove(e));
        window.addEventListener(
            'mouseup',
            withRender((e: MouseEvent) => this.onMouseUp(e)),
        );
        window.addEventListener(
            'keydown',
            withRender((e: KeyboardEvent) => this.onKeyDown(e)),
        );
        window.addEventListener(
            'keyup',
            withRender((e: KeyboardEvent) => this.onKeyUp(e)),
        );
        window.addEventListener(
            'wheel',
            withRender((e: WheelEvent) => this.onWheel(e)),
            { passive: false, capture: true },
        );

        // Import .svg / native binary files by dropping them onto the canvas area
        const dropTarget = document.getElementById('canvas-container') ?? this.canvas;
        dropTarget.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        dropTarget.addEventListener('drop', (e) => {
            this.onFileDrop(e).catch(console.error);
        });

        // Safari pinch-to-zoom prevention (page zoom would fight canvas zoom)
        window.addEventListener('gesturestart', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gesturechange', (e) => e.preventDefault(), { capture: true });
        window.addEventListener('gestureend', (e) => e.preventDefault(), { capture: true });

        // The canvas client rect is read on every mousemove/wheel (pointer →
        // world mapping). getBoundingClientRect forces layout when anything
        // dirtied it, so cache the rect and drop the cache whenever the box
        // could have changed: any canvas resize (panels opening/closing — the
        // same events the renderer's ResizeObserver reacts to), window resize,
        // or scrolling anywhere in the page. Every mousedown also re-reads it,
        // so a gesture can never start against a stale rect.
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => {
                this._canvasRect = null;
            }).observe(this.canvas);
        }
        window.addEventListener('resize', () => {
            this._canvasRect = null;
        });
        window.addEventListener(
            'scroll',
            () => {
                this._canvasRect = null;
            },
            { capture: true, passive: true },
        );
    }

    /** Import dropped files: .svg content is centered at the drop point and
     *  selected; a native binary doc replaces the document (undoable — a
     *  history snapshot is taken first). */
    async onFileDrop(e: DragEvent) {
        e.preventDefault();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0 || !this.scene.engine) return;
        const dropWorld = this.getPos(e);

        for (const file of files) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.svg')) {
                const text = await file.text();
                // parseSVG rasterizes patterns (async) then runs the import as ONE
                // undo step; the afterImport callback runs inside that transaction.
                await this.ui.parseSVG(text, (newRoots) => {
                    // Center the imported nodes at the drop point and select them
                    if (newRoots.length === 0) return;
                    let minX = Infinity,
                        minY = Infinity,
                        maxX = -Infinity,
                        maxY = -Infinity;
                    for (const id of newRoots) {
                        const b = this.scene.getNodeBounds(id);
                        minX = Math.min(minX, b[0]);
                        minY = Math.min(minY, b[1]);
                        maxX = Math.max(maxX, b[2]);
                        maxY = Math.max(maxY, b[3]);
                    }
                    if (minX < maxX && minY < maxY) {
                        const dx = dropWorld.x - (minX + maxX) / 2;
                        const dy = dropWorld.y - (minY + maxY) / 2;
                        for (const id of newRoots) this.scene.engine!.move_node(id, dx, dy);
                    }
                    this.scene.engine!.clear_selection();
                    for (const id of newRoots) this.scene.selectNode(id, true);
                });
            } else if (name.endsWith('.rcbvec')) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                this.scene.saveMoveHistory(); // snapshot current doc so the drop is undoable
                const result = parseLoadResult(this.scene.engine.load_document(bytes));
                FileIO.announce(result, file.name);
                if (result.ok) {
                    void adoptEmbeddedFonts(this.scene.engine);
                    this.scene.renderer?.clearImageCache(); // ids may map to new bytes
                }
            } else if (file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/.test(name)) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                // Natural pixel size (fallback to a square if decode fails).
                const bmp = await createImageBitmap(file).catch(() => null);
                let w = bmp?.width ?? 200;
                let h = bmp?.height ?? 200;
                bmp?.close?.();
                // Cap to 50% of the document so huge photos don't fill the canvas.
                const docW = this.scene.engine.get_document_width();
                const docH = this.scene.engine.get_document_height();
                const scale = Math.min(1, (docW * 0.5) / w, (docH * 0.5) / h);
                w *= scale;
                h *= scale;
                const id = this.scene.placeImage(
                    bytes,
                    file.type || 'image/png',
                    dropWorld.x,
                    dropWorld.y,
                    w,
                    h,
                );
                this.scene.engine.clear_selection();
                this.scene.selectNode(id, false);
            }
        }

        this.scene.invalidateCache();
        this.scene.autosave?.trigger();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    onContextMenu(e: MouseEvent) {
        e.preventDefault();
        const pos = this.getPos(e);
        const hitId = this.scene.hitTestGrouped(pos.x, pos.y);
        if (hitId !== undefined) {
            // Select the element if not already selected
            const currentSel = this.scene.engine!.get_selection();
            if (!currentSel.includes(hitId)) {
                this.scene.selectNode(hitId, false);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }
            this.ui.showContextMenu(e.clientX, e.clientY, (action: string) => {
                this.handleContextMenuAction(action);
            });
        } else {
            this.ui.hideContextMenu();
        }
    }

    handleContextMenuAction(action: string) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;

        switch (action) {
            // Same restacking rules as the ] and [ keys — order of travel and
            // the selection moving as a block.
            case 'bring-to-front':
                this.scene.transaction(() => this.restack('forward', true));
                break;
            case 'bring-forward':
                this.scene.transaction(() => this.restack('forward', false));
                break;
            case 'send-backward':
                this.scene.transaction(() => this.restack('backward', false));
                break;
            case 'send-to-back':
                this.scene.transaction(() => this.restack('backward', true));
                break;
            case 'duplicate':
                this.duplicateSelection();
                break;
            case 'delete':
                this.deleteSelection();
                break;
            case 'group':
                this.groupSelection();
                break;
            case 'ungroup':
                this.ungroupSelection();
                break;
            case 'make-live-paint':
                this.makeLivePaintGroup();
                break;
            case 'expand-live-paint':
                this.expandLivePaintGroup(selection[0]);
                break;
            case 'flatten':
                void this.flattenSelection();
                break;
            case 'toggle-mask':
                this.toggleMaskSelection();
                break;
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.hideContextMenu();
    }

    onDoubleClick(e: MouseEvent) {
        // The pen owns the double-click: it finishes the path being drawn, and
        // never drills into whatever artwork happens to sit under the cursor.
        if (this.ui.activeTool === 'pen' || this.currentPathPoints.length > 0) {
            this.finishPenPathOnDoubleClick();
            return;
        }
        // The click that closed a path also delivers this dblclick, by which
        // time the pen has already committed and handed the tool back to
        // Selection. Swallow it, or finishing a shape on top of another one
        // would drop straight into node-editing that shape.
        if (this.penSuppressDoubleClick) {
            this.penSuppressDoubleClick = false;
            return;
        }
        // Drilling into artwork — groups, node editing, text, Live Paint — is
        // what the SELECTION tools do with a double-click. A creation tool is
        // armed to draw: its double-click makes nothing (both presses are
        // zero-size drags), and it must not open whatever it happened to land
        // on for editing instead. Same surprise the pen used to spring, reached
        // through the rectangle, pencil, scissors, mesh… tools.
        if (!InputManager.DRILL_IN_TOOLS.has(this.ui.activeTool)) return;

        const pos = this.getPos(e);
        const hitId = this.scene.hitTest(pos.x, pos.y); // raw hit (deepest leaf)
        if (hitId === undefined) {
            this.enteredGroup = null;
            // Double-click on empty canvas: leave node-editing mode
            if (this.editingNodeId !== null) {
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            }
            return;
        }

        // A Live Paint group drills in like any other group. It used to enter
        // paint mode instead, and that single line was why the shapes inside one
        // could not be touched: double-click is the ONE gesture that means "go
        // deeper", every other container honours it, and Live Paint spent it on
        // arming a tool. There was then no gesture left for the geometry — the
        // Objects panel was the only way in, and only if you thought to look.
        //
        // What decides whether a click paints or selects is the TOOL, which is
        // the rule everywhere else in the editor and the one Illustrator uses:
        // the bucket paints, the selection tools select. So the bucket keeps this
        // gesture while it is the active tool — double-clicking another painted
        // group is how you move the paint scope without putting the bucket down —
        // and hands it back to drilling in for every other tool.
        const lpGroup = this.findLivePaintAncestor(hitId);
        if (this.ui.activeTool === 'paint-bucket') {
            if (lpGroup !== null) this.enterLivePaintGroup(lpGroup);
            return;
        }

        // Check if the currently selected node is a group
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 1) {
            // A Boolean Group hit-tests as itself (its operands aren't drawn, so
            // they aren't pickable), which means the drill-down below has no leaf
            // to walk up from. Enter it the same way the Edit button does, so a
            // second double-click still reaches the operands.
            if (selection[0] === hitId && this.scene.isBooleanGroup(hitId)) {
                this.enterSelectedNode(hitId);
                return;
            }
            const selectedNode = this.scene.getNode(selection[0]);
            if (selectedNode && selectedNode.node_type === 'Group') {
                // Double-click on a group → drill down ONE level:
                // Find the direct child of this group that is (or contains) the hit leaf
                const targetChild = this.findDirectChildContaining(selection[0], hitId);
                if (targetChild !== undefined) {
                    this.enteredGroup = selection[0];
                    this.scene.selectNode(targetChild, false);
                    this.ui.syncWithSelection();
                    // Going into a group is navigation, so the Objects panel
                    // follows you in: it expands the ancestors you just walked
                    // through and scrolls to the child you landed on. Without
                    // it the panel still shows the collapsed group you were
                    // looking at, and nothing on screen says where you are.
                    this.ui.revealSelection();
                    return;
                }
            }
        }

        const node = this.scene.getNode(hitId);
        if (!node) return;

        // Double-click on text: edit its content inline
        if (node.geometry.Text) {
            this.scene.selectNode(hitId, false);
            this.ui.syncWithSelection();
            this.editTextNode(hitId);
            return;
        }

        // Double-click on any leaf shape enters node-editing (direct
        // selection) mode. enterPathEditMode converts Rect/Ellipse to an
        // editable Path; corner radii carry over per-vertex, so this is
        // non-destructive.
        this.ui.setActiveTool('direct');
        this.scene.selectNode(hitId, false);
        this.ui.syncWithSelection();
        this.ui.revealSelection();
        this.enterPathEditMode(hitId);
    }

    /**
     * Walk from `leafId` up the parent chain toward `groupId`, returning the
     * direct child of `groupId` that is an ancestor of (or is) `leafId`.
     * This enables progressive drill-down through nested groups.
     */
    private findDirectChildContaining(groupId: number, leafId: number): number | undefined {
        let current = leafId;
        while (current !== -1) {
            const parentId = this.scene.getNodeParent(current);
            if (parentId === groupId) {
                return current; // `current` is a direct child of the selected group
            }
            if (parentId === -1) break; // reached root without finding groupId
            current = parentId;
        }
        return undefined;
    }

    /** Enter path edit mode on a node. Converts Rect/Ellipse to Path first if needed. */
    enterPathEditMode(nodeId: number) {
        // Convert non-path geometry to path
        const geometry = this.scene.getNodeGeometry(nodeId);
        if (!geometry) return;

        if (!geometry.Path) {
            // Convert rect/ellipse/etc. to editable path
            this.scene.convertToPath(nodeId);
        }

        // Re-read geometry after potential conversion
        const updatedGeometry = this.scene.getNodeGeometry(nodeId);
        if (updatedGeometry?.Path) {
            this.editingNodeId = nodeId;
            this.editingPoints = JSON.parse(JSON.stringify(updatedGeometry.Path.subpaths));
            this.editingTransform = this.scene.getTransform(nodeId);
            this.addPointMode = false;
            this.convertPointMode = false;
            this.ui.updateLayerList();
            this.ui.contextBar?.refresh();
        }
    }

    /** Exit path/text editing mode and clear dimming on all exit paths. Idempotent:
     *  safe to call when not editing. The single sanctioned way to leave edit mode —
     *  clears all per-edit state and refreshes the panel so the scene un-dims. */
    exitEditMode() {
        if (this.editingNodeId === null) return;
        // A press that is still open (Escape, or a tool switch, mid-drag) still
        // owns an undo step for whatever it moved.
        this.commitPointDrag();
        this.editingNodeId = null;
        this.editingPoints = null;
        this.editingTransform = null;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.addPointMode = false;
        this.convertPointMode = false;
        // syncWithSelection refreshes the property panel + context/breadcrumb bars
        // and requests a render, which recomputes dimming (now un-dimmed).
        this.ui.syncWithSelection();
    }

    /** Dim target for the renderer. Self-heals if the edited node no longer exists
     *  (e.g. removed by undo or delete outside the normal exit paths). */
    getEditingDimTarget(): number | null {
        if (this.editingNodeId === null) return null;
        if (this.scene.getNodeType(this.editingNodeId) === undefined) {
            this.exitEditMode();
            return null;
        }
        return this.editingNodeId;
    }

    /** Re-read the edited path's geometry and transform from the document.
     *  `editingPoints` is a working COPY, so anything that changes the path
     *  underneath us — undo, redo, a panel edit, an agent command — leaves it
     *  describing anchors that are no longer there. Drops selected points that
     *  the fresh geometry no longer has. Returns false (and exits) when the
     *  node stopped being an editable path. */
    refreshEditingGeometry(): boolean {
        if (this.editingNodeId === null) return false;
        const subpaths = this.scene.getNodeGeometry(this.editingNodeId)?.Path?.subpaths;
        if (!subpaths) {
            this.exitEditMode();
            return false;
        }
        this.editingPoints = JSON.parse(JSON.stringify(subpaths));
        this.editingTransform = this.scene.getTransform(this.editingNodeId);
        for (const key of Array.from(this.selectedPoints)) {
            if (!this.anchorExists(key)) this.selectedPoints.delete(key);
        }
        if (!this.anchorExists(`${this.selectedAnchorSubpath}:${this.selectedAnchorIndex}`)) {
            this.selectedAnchorSubpath = -1;
            this.selectedAnchorIndex = -1;
        }
        return true;
    }

    /** True when "subpathIndex:pointIndex" names an anchor the edited path
     *  actually has right now. */
    private anchorExists(key: string): boolean {
        const [si, pi] = key.split(':').map(Number);
        return this.editingPoints?.[si]?.points?.[pi] !== undefined;
    }

    // ─── One anchor gesture, one undo step ──────────────────────────────
    //
    // Pressing on an anchor used to push an undo state immediately, and the
    // mouse-up committed the result through updatePathPoints — which pushed
    // again. So dragging a point cost TWO ⌘Z presses (the first restoring the
    // state you were already looking at, i.e. doing nothing visible), and
    // merely CLICKING an anchor to select it left two dead undo steps behind:
    // press ⌘Z after picking a point and the editor ignored you twice.
    //
    // Instead the press only remembers the document as it stands, and the step
    // is pushed on release, once, and only if the geometry actually moved.

    /** Remember the pre-gesture document for an anchor/handle press. */
    private beginPointDrag() {
        this.pointDragPre = this.scene.serializeScene();
        this.pointDragChanged = false;
    }

    /** Close the gesture: push its single undo step and commit the geometry if
     *  anything moved, otherwise leave history untouched. Idempotent, so both
     *  mouse-up and an interrupted edit can call it. */
    private commitPointDrag() {
        const pre = this.pointDragPre;
        const changed = this.pointDragChanged;
        this.pointDragPre = null;
        this.pointDragChanged = false;
        if (!changed || this.editingNodeId === null || !this.editingPoints) return;
        if (pre) this.scene.pushHistoryState(pre);
        this.scene.updatePathPointsNoHistory(
            this.editingNodeId,
            JSON.stringify(this.editingPoints),
        );
    }

    // ─── The mode undo puts you back into ───────────────────────────────
    //
    // The document snapshot behind ⌘Z carries geometry and selection. It does
    // NOT carry where the user was STANDING when they made the edit: the shape
    // open for node editing and the anchors picked inside it, the group they
    // had drilled into, the mesh fill they were pulling. Undo used to simply
    // drop all of it — worse, it force-exited node editing on the way in, so
    // deleting an anchor, leaving node editing and pressing ⌘Z restored the
    // anchor somewhere you could no longer see or touch. (It exited even when
    // there was nothing left to undo.)
    //
    // Figma and Illustrator both take you back to the context an edit was made
    // in, and it is the only behaviour that can work: a restored anchor is only
    // meaningful inside the mode that can edit anchors. So every history state
    // is pushed with the mode it was captured in, and undo/redo restore the
    // two together. Redo is the exact inverse — it returns you to the mode you
    // were in when you pressed undo — so ⌘Z ⇧⌘Z is a round trip, not a drift.
    //
    // Entering or leaving a mode is NOT itself an undo step (same as both of
    // those editors): Escape out of node editing and the next ⌘Z undoes your
    // last EDIT — while putting you back in front of it.

    /** Snapshot of the mode the user is in, stored alongside a history state. */
    captureModeContext(): ModeContext {
        const mesh = this.ui.meshEdit;
        return {
            tool: this.ui.activeTool,
            editing:
                this.editingNodeId === null
                    ? null
                    : {
                          nodeId: this.editingNodeId,
                          points: Array.from(this.selectedPoints),
                          anchorSubpath: this.selectedAnchorSubpath,
                          anchorIndex: this.selectedAnchorIndex,
                          addPoint: this.addPointMode,
                      },
            enteredGroup: this.enteredGroup,
            mesh:
                mesh?.nodeId == null
                    ? null
                    : {
                          nodeId: mesh.nodeId,
                          fillIndex: mesh.fillIndex,
                          vertices: Array.from(mesh.selectedVertices ?? []),
                      },
        };
    }

    /** Put the user back where `ctx` says they were. Every part of it is
     *  re-validated against the document that was just restored: a mode
     *  pointing at a node that is gone is not a mode worth entering. */
    restoreModeContext(ctx: ModeContext | null) {
        if (!ctx) {
            // A state pushed with no mode recorded (an older session, or the
            // agent driving the scene headlessly). "No mode" is the honest
            // reading, and matches what undo did before it carried context.
            this.exitEditMode();
            return;
        }

        // Group isolation — the place you are standing, if it still exists.
        this.enteredGroup =
            ctx.enteredGroup !== null && this.scene.getNodeType(ctx.enteredGroup) !== undefined
                ? ctx.enteredGroup
                : null;

        this.restoreNodeEditing(ctx);
        this.restoreMeshEditing(ctx);
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    private restoreNodeEditing(ctx: ModeContext) {
        const want = ctx.editing;
        // Only a real Path is editable, and entering one that isn't would
        // CONVERT it (a document mutation, mid-undo). Anything else: leave.
        const editable =
            want !== null && this.scene.getNodeGeometry(want.nodeId)?.Path !== undefined;
        if (!editable) {
            this.exitEditMode();
            return;
        }

        if (this.editingNodeId !== want!.nodeId) {
            this.exitEditMode();
            // The tool goes first: setActiveTool exits node editing, so
            // entering before it would immediately undo itself. Node editing
            // implies a tool that can work on anchors — keep the one the edit
            // was made with when it qualifies, otherwise hand over Direct
            // Selection rather than leaving a creation tool armed over it.
            const tool = InputManager.NODE_EDIT_TOOLS.has(ctx.tool) ? ctx.tool : 'direct';
            if (this.ui.activeTool !== tool) this.ui.setActiveTool(tool);
            this.enterPathEditMode(want!.nodeId);
            if (this.editingNodeId === null) return;
        } else if (!this.refreshEditingGeometry()) {
            return;
        }

        this.selectedPoints = new Set(want!.points.filter((key) => this.anchorExists(key)));
        const anchor = `${want!.anchorSubpath}:${want!.anchorIndex}`;
        const hasAnchor = this.anchorExists(anchor);
        this.selectedAnchorSubpath = hasAnchor ? want!.anchorSubpath : -1;
        this.selectedAnchorIndex = hasAnchor ? want!.anchorIndex : -1;
        this.addPointMode = want!.addPoint;
    }

    /** Tools that can be held while a path is open for node editing. Anything
     *  else (a creation tool, the bucket) means the mode was left behind. */
    static readonly NODE_EDIT_TOOLS = new Set(['direct', 'selection', 'pen', 'scissors']);

    private restoreMeshEditing(ctx: ModeContext) {
        const mesh = this.ui.meshEdit;
        const want = ctx.mesh;
        // Never *clears* a live mesh edit: MeshEditController reconciles itself
        // against the restored selection, and this only re-opens a target that
        // is still a mesh fill.
        if (!want || typeof mesh?.activate !== 'function') return;
        const fill = this.scene.getNode(want.nodeId)?.style.fills?.[want.fillIndex];
        if (!fill || !isMeshGradient(fill)) return;
        if (this.ui.activeTool !== 'mesh') this.ui.setActiveTool('mesh');
        mesh.activate(want.nodeId, want.fillIndex);
        mesh.selectedVertices.clear();
        for (const vi of want.vertices) {
            if (vi < fill.vertices.length) mesh.selectedVertices.add(vi);
        }
    }

    onKeyDown(e: KeyboardEvent) {
        // Typing in a field belongs to the field: plain letters are text, not
        // tool shortcuts, and Delete edits the value rather than the selection.
        //
        // ⌘/Ctrl chords are the exception. They are application commands, not
        // text — and swallowing them meant that tweaking a stroke width and
        // reflexively hitting ⌘Z did *nothing at all*, because focus was still
        // in the field. The edit stayed, the user pressed again, still nothing;
        // it only worked after clicking away. ⌘S, ⌘D and ⌘G were dead there too.
        //
        // The four chords a text field genuinely owns — select-all, copy, paste,
        // cut — stay native.
        const tag = (e.target as HTMLElement)?.tagName;
        const inField =
            tag === 'INPUT' ||
            tag === 'SELECT' ||
            tag === 'TEXTAREA' ||
            (e.target as HTMLElement)?.isContentEditable === true;
        if (inField) {
            // Escape hands the keyboard back to the canvas. Without it, focus
            // sat in the field indefinitely and every tool shortcut went
            // nowhere, with nothing on screen explaining why. The value is left
            // committed rather than reverted — blur already commits it, and
            // undo is the way back.
            if (e.key === 'Escape') {
                (e.target as HTMLElement)?.blur?.();
                return;
            }
            const chord = e.metaKey || e.ctrlKey;
            if (!chord || InputManager.FIELD_OWNED_CHORDS.has(e.key.toLowerCase())) return;
            // Fall through: the panel repopulates from the model afterwards, and
            // the focus-preserving rebuild keeps the caret in place.
        }

        // ⌘/Ctrl toggles snapping: clear the hover snap-preview the instant it's
        // held, without needing a mouse move.
        if (e.key === 'Meta' || e.key === 'Control') {
            this.metaKey = e.metaKey;
            this.ctrlKey = e.ctrlKey;
            this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);
            this.updatePenHover();
        }

        // Alt/Shift pressed mid-drag must reapply the transform immediately.
        this.reapplyDragForModifiers(e);

        // ⌥ turns the bucket into an eyedropper, and you hold it with the mouse
        // STILL — so the cursor has to change on the keypress, not on the next
        // mouse move. Same for ⇧ (edge mode) and ⌘ (erase).
        if (
            (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control') &&
            !this.isMouseDown &&
            this.ui.activeTool === 'paint-bucket'
        ) {
            this.updatePaintBucketHover(e.altKey, e.shiftKey, e.metaKey || e.ctrlKey);
            this.renderer.requestRender();
        }
        // Same contract for the Selection tool: ⌥ (duplicate) and ⌘ (select
        // inside the group) change what the press will do AND which node it
        // takes, so both the cursor and the highlight have to move on the
        // keypress rather than on the next mouse move.
        if (
            (e.key === 'Alt' || e.key === 'Meta' || e.key === 'Control') &&
            !this.isMouseDown &&
            this.ui.activeTool === 'selection' &&
            this.editingNodeId === null
        ) {
            this.updateSelectionHover(e.altKey, e.metaKey || e.ctrlKey);
        }

        // Space: hold for hand tool (pan-drag)
        if (e.key === ' ') {
            e.preventDefault(); // stop page scroll
            if (!this.isSpacePan && !this.isMouseDown) {
                this.isSpacePan = true;
                this.canvas.style.cursor = 'grab';
            }
            return;
        }

        // ─── ⌘/⌥ action chords ──────────────────────────────────────────────
        // Grouped here so every modifier collision is visible at once. macOS
        // turns ⌥+letter into a glyph (⌥a is "å"), so anything with ⌥ matches on
        // e.code, never e.key.
        if (e.metaKey || e.ctrlKey) {
            const code = e.code;
            // ⇧⌘A: Deselect. Must come before the ⌘A below.
            if (e.shiftKey && !e.altKey && code === 'KeyA') {
                e.preventDefault();
                this.deselectAll();
                return;
            }
            if (e.shiftKey && !e.altKey && code === 'KeyL') {
                e.preventDefault();
                this.toggleSelectionFlag('locked');
                return;
            }
            if (e.shiftKey && !e.altKey && code === 'KeyH') {
                e.preventDefault();
                this.toggleSelectionFlag('hidden');
                return;
            }
            // ⌥⌘C / ⌥⌘V: copy and paste appearance.
            if (e.altKey && !e.shiftKey && code === 'KeyC') {
                e.preventDefault();
                this.copyAppearance();
                return;
            }
            if (e.altKey && !e.shiftKey && code === 'KeyV') {
                e.preventDefault();
                this.pasteAppearance();
                return;
            }
            // Booleans, Figma's chords. Exclude is the odd one out: Figma puts it
            // on ⌥⌘X, which is already Make Live Paint here (Illustrator's), and
            // a shipped headline feature outranks a fourth boolean.
            if (
                e.altKey &&
                !e.shiftKey &&
                (code === 'KeyU' || code === 'KeyS' || code === 'KeyI')
            ) {
                e.preventDefault();
                this.booleanSelection(
                    code === 'KeyU' ? 'union' : code === 'KeyS' ? 'subtract' : 'intersect',
                );
                return;
            }
            if (e.altKey && e.shiftKey && code === 'KeyX') {
                e.preventDefault();
                this.booleanSelection('exclude');
                return;
            }
            // ⌘B / ⌘I: bold and italic, on selected text.
            if (!e.altKey && !e.shiftKey && (code === 'KeyB' || code === 'KeyI')) {
                if (this.selectedTextNodes().length > 0) {
                    e.preventDefault();
                    this.toggleTextStyle(code === 'KeyB' ? 'bold' : 'italic');
                    return;
                }
            }
            // ⇧⌘. / ⇧⌘, — the > and < keys — step the font size.
            if (e.shiftKey && (code === 'Period' || code === 'Comma')) {
                if (this.selectedTextNodes().length > 0) {
                    e.preventDefault();
                    this.adjustTextSize(code === 'Period' ? 1 : -1);
                    return;
                }
            }
            // ⌘\: full-bleed canvas.
            if (code === 'Backslash') {
                e.preventDefault();
                this.ui.toggleChrome();
                return;
            }
        }

        // Cmd+A: select all top-level nodes (skips locked/hidden)
        if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
            e.preventDefault();
            this.scene.engine!.clear_selection();
            for (const id of this.scene.getRootNodes()) {
                if (this.scene.getNodeLocked(id) || !this.scene.getNodeVisible(id)) continue;
                this.scene.selectNode(id, true);
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            return;
        }

        // NOTE: rulers are ⇧R, NOT Illustrator's ⌘R — in a browser that chord is
        // Reload, and swallowing it makes the app feel broken. Figma binds ⇧R for
        // the same reason. See the ⇧R handler below.

        // Tool shortcuts — plain letters only; ⇧letter is reserved for actions (flip etc.)
        if (!e.metaKey && !e.ctrlKey) {
            // ⌥ + letter aligns, as in Figma. On e.code: ⌥a is "å" in e.key.
            if (e.altKey && !e.shiftKey) {
                const ALIGN: Record<string, AlignMode> = {
                    KeyA: 'left',
                    KeyD: 'right',
                    KeyW: 'top',
                    KeyS: 'bottom',
                    KeyH: 'hcenter',
                    KeyV: 'vcenter',
                };
                const mode = ALIGN[e.code];
                if (mode) {
                    e.preventDefault();
                    this.alignSelectionTo(mode);
                    return;
                }
                // ⌥← / ⌥→ is tracking on text, and only on text — everywhere
                // else it stays the plain 1px nudge below.
                if (
                    (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
                    this.selectedTextNodes().length > 0
                ) {
                    e.preventDefault();
                    this.adjustTextTracking(e.key === 'ArrowRight' ? 1 : -1);
                    return;
                }
            }

            // Tab: full-bleed canvas, the other half of ⌘\. Guarded to the
            // canvas — inside a panel, Tab has to stay Tab.
            if (e.key === 'Tab' && !inField) {
                e.preventDefault();
                this.ui.toggleChrome();
                return;
            }

            // F2: rename the selected layer without going to find its row.
            if (e.key === 'F2') {
                e.preventDefault();
                this.ui.renameSelectedLayer();
                return;
            }

            // Digits set the selection's opacity (Figma). Nothing else claims a
            // bare digit, and ⇧-digits are the view shortcuts below.
            if (!e.shiftKey && !e.altKey && e.key.length === 1 && e.key >= '0' && e.key <= '9') {
                e.preventDefault();
                this.typeOpacityDigit(e.key);
                return;
            }

            if (!e.shiftKey) {
                const tool = InputManager.TOOL_SHORTCUTS[e.key.toLowerCase()];
                if (tool) {
                    // Double-tapping the same letter locks the tool (keyboard
                    // equivalent of double-clicking the toolbar button).
                    const now = performance.now();
                    const prev = this.lastToolKey;
                    const lock =
                        prev?.tool === tool && now - prev.at <= InputManager.TOOL_LOCK_WINDOW_MS;
                    this.ui.setActiveTool(tool, lock);
                    // Reset after a lock so a third tap starts fresh (unlocked).
                    this.lastToolKey = lock ? null : { tool, at: now };
                }
            }

            // Shift+H / Shift+V: flip selection in place
            if (e.shiftKey && (e.key === 'H' || e.key === 'h')) this.flipSelection('h');
            if (e.shiftKey && (e.key === 'V' || e.key === 'v')) this.flipSelection('v');

            // Shift+R: toggle rulers. ⌘R stays the browser's reload.
            if (e.shiftKey && (e.key === 'R' || e.key === 'r')) this.guides?.toggleRulers();

            // View shortcuts (Figma-style)
            if (e.key === '!' || (e.shiftKey && e.key === '1')) {
                // Shift+1: fit artboard in view
                this.renderer.fitToArtboard();
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === ')' || (e.shiftKey && e.key === '0')) {
                // Shift+0: zoom to 100%
                this.renderer.setZoomCentered(1.0);
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === '@' || (e.shiftKey && e.key === '2')) {
                // Shift+2: zoom to selection
                const b = this.getSelectionBounds();
                if (b) {
                    this.renderer.zoomToBounds(b);
                    this.ui.setZoom(this.renderer.zoom);
                }
            }
            // `+` is claimed by Add Point while a path is being edited (see the
            // toggle further down, which returns). Without this guard the one
            // press did both: the canvas zoomed in AND Add Point flipped on,
            // two unrelated commands from one key. Zoom out, the wheel and the
            // view shortcuts are all still available in edit mode.
            if ((e.key === '+' || e.key === '=') && this.editingNodeId === null) {
                this.renderer.setZoomCentered(this.renderer.zoom * 1.25);
                this.ui.setZoom(this.renderer.zoom);
            }
            if (e.key === '-' || e.key === '_') {
                this.renderer.setZoomCentered(this.renderer.zoom / 1.25);
                this.ui.setZoom(this.renderer.zoom);
            }
        }

        // Delete — in path editing mode, delete the selected anchor point(s);
        // with a gradient stop focused, delete the stop instead of the node.
        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (this.penOwnsKeyboard()) {
                // With the pen up, Delete takes back the anchor you just placed —
                // the same thing ⌘Z does, and what Illustrator does. It used to
                // fall through to deleteSelection() and destroy whatever was
                // selected *before* you picked up the pen: you were drawing, and
                // an unrelated shape vanished.
                //
                // Keyed on the tool, not merely on having anchors: peeling a
                // 3-point path back with Delete meant the fourth press found an
                // empty buffer and deleted the shape instead. Delete does
                // nothing here once the path is empty, which is the safe answer
                // — the destructive reading is never what someone drawing meant.
                this.undoLastPenPoint();
            } else if (this.selectedGuide) {
                this.deleteSelectedGuide();
            } else if (this.editingNodeId !== null && this.selectedPoints.size > 0) {
                this.deleteSelectedPoints();
            } else if (this.ui.gradientEdit.isActive() && this.ui.gradientEdit.stopFocused) {
                if (this.ui.gradientEdit.deleteStop(this.ui.gradientEdit.stopIndex)) {
                    this.ui.syncWithSelection();
                }
            } else if (
                this.ui.activeTool === 'mesh' &&
                this.ui.meshEdit.isActive() &&
                this.ui.meshEdit.selectedVertices.size > 0
            ) {
                // Delete the grid lines through the selected interior
                // vertices. Boundary-only selections no-op — never fall
                // through to node deletion while mesh points are selected.
                if (this.ui.meshEdit.deleteLinesThroughSelection()) {
                    this.ui.syncWithSelection();
                }
            } else if (this.renderer.selectedArtboardId !== null) {
                // An artwork is selected → delete it.
                this.deleteSelectedArtboard();
            } else {
                this.deleteSelection();
            }
        }

        // Cmd+J / Ctrl+J: in node editing with 2+ points selected, merge them;
        // otherwise join the two selected path nodes.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            if (this.editingNodeId !== null && this.selectedPoints.size >= 2) {
                this.mergeSelectedPoints();
            } else {
                this.joinSelectedPaths();
            }
        }

        // Add point toggle: + key in path edit mode
        if (e.key === '+' || e.key === '=') {
            if (this.editingNodeId !== null && !e.metaKey && !e.ctrlKey) {
                this.addPointMode = !this.addPointMode;
                this.ui.contextBar?.refresh();
                return;
            }
        }

        // Undo: Cmd+Z / Ctrl+Z. While the pen is mid-path, undo peels back the
        // anchor you just placed rather than reaching into document history.
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
            e.preventDefault();
            if (this.undoLastPenPoint()) return;
            // Node editing is NOT torn down here: scene.undo() restores the
            // mode the undone edit was made in (see restoreModeContext), which
            // is how the anchor it brings back is somewhere you can see.
            this.scene.undo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Redo: Cmd+Shift+Z / Ctrl+Shift+Z
        if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) {
            e.preventDefault();
            if (this.redoLastPenPoint()) return;
            this.scene.redo();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }

        // Save: Cmd+S / Ctrl+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && !e.shiftKey) {
            e.preventDefault();
            this.fileService?.saveActive().catch(console.error);
        }

        // Save As: Cmd+Shift+S / Ctrl+Shift+S
        if ((e.metaKey || e.ctrlKey) && e.key === 's' && e.shiftKey) {
            e.preventDefault();
            this.fileService?.saveActiveAs().catch(console.error);
        }

        // Create Outlines: Cmd+Shift+O / Ctrl+Shift+O (selected text nodes → paths)
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            const textIds = Array.from(this.scene.engine!.get_selection()).filter(
                (id) => this.scene.getNode(id)?.node_type === 'Text',
            );
            for (const id of textIds) void this.createOutlines(id);
        }

        // Open (in a new tab): Cmd+O / Ctrl+O
        if ((e.metaKey || e.ctrlKey) && e.key === 'o' && !e.shiftKey) {
            e.preventDefault();
            if (this.documentManager) this.documentManager.openFromPicker().catch(console.error);
            else this.fileService?.openIntoActive().catch(console.error);
        }

        // New document: Cmd+Alt+N / Ctrl+Alt+N (Cmd+N is browser-reserved)
        if (
            (e.metaKey || e.ctrlKey) &&
            e.altKey &&
            (e.key === 'n' || e.key === 'ñ' || e.code === 'KeyN')
        ) {
            e.preventDefault();
            this.documentManager?.create();
        }

        // Close tab: Cmd+Alt+W / Ctrl+Alt+W (Cmd+W is browser-reserved)
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyW') {
            e.preventDefault();
            const active = this.documentManager?.active();
            if (active) this.documentManager!.close(active.id);
        }

        // Cycle tabs: Cmd+Alt+←/→
        if (
            (e.metaKey || e.ctrlKey) &&
            e.altKey &&
            (e.code === 'ArrowRight' || e.code === 'ArrowLeft')
        ) {
            e.preventDefault();
            this.documentManager?.cycle(e.code === 'ArrowRight' ? 1 : -1);
        }

        // Export: Cmd+Shift+E / Ctrl+Shift+E — opens the export dialog.
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && e.shiftKey) {
            e.preventDefault();
            if (this.openExportDialog) this.openExportDialog();
            else this.ui.exportSVG();
        }

        // Escape: cancel in-flight drag → unfocus gradient stop → exit path edit → exit group → deselect
        if (e.key === 'Escape') {
            if (this.isMouseDown && this.gradientDragActive) {
                this.gradientDragActive = false;
                this.isMouseDown = false; // swallow the drag; onMouseUp early-returns
                this.ui.gradientEdit.cancelDrag();
                this.ui.syncWithSelection();
                return;
            }
            if (this.isMouseDown && this.meshDragActive) {
                this.meshDragActive = false;
                this.renderer.meshDraftMode = false;
                this.isMouseDown = false; // swallow the drag; onMouseUp early-returns
                this.ui.meshEdit.cancelDrag();
                this.ui.syncWithSelection();
                this.renderer.requestRender();
                return;
            }
            if (
                this.isMouseDown &&
                (this.moveSnapshot ||
                    this.resizeSnapshot ||
                    this.rotateSnapshot ||
                    this.previewRect ||
                    this.previewLine ||
                    this.pencilPoints ||
                    this.marqueeRect)
            ) {
                this.cancelActiveDrag();
                return;
            }
            if (this.ui.gradientEdit.stopFocused) {
                this.ui.gradientEdit.stopFocused = false;
                return;
            }
            // Mesh tool: first Escape clears the vertex selection; the next
            // falls through to the generic "back to Selection tool" below.
            if (this.ui.activeTool === 'mesh' && this.ui.meshEdit.selectedVertices.size > 0) {
                this.ui.meshEdit.selectedVertices.clear();
                this.ui.contextBar?.refresh();
                this.renderer.requestRender();
                return;
            }
            if (this.editingNodeId !== null) {
                // Exit direct editing mode
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            } else if (this.currentPathPoints.length > 0) {
                // Commit the in-progress pen path, matching Figma/Illustrator: Escape
                // finalizes what you've drawn rather than throwing it away. Points
                // you've placed are real geometry, so a stray Escape must not be a
                // data-loss footgun. finalizePenPath only creates a path when there
                // are ≥2 points; a lone anchor (a degenerate path) is just cleared.
                // The Context Bar's Cancel button remains the explicit discard action.
                this.finalizePenPath();
            } else if (this.ui.activeTool !== 'selection') {
                // Disarm armed creation/drawing tool back to Selection
                this.ui.setActiveTool('selection');
            } else {
                // Check if we're inside a group — if so, select the parent group instead of clearing
                const selection = this.scene.engine!.get_selection();
                if (selection.length > 0) {
                    const parentId = this.scene.getNodeParent(selection[0]);
                    const parentNode = parentId >= 0 ? this.scene.getNode(parentId) : null;

                    if (parentNode && parentNode.node_type === 'Group') {
                        // Snapshot the current state BEFORE exiting the group
                        // so that Ctrl+Z can revert back into the group context
                        // with the element in its pre-move position.
                        this.scene.pushHistorySnapshot();
                        // Exit group context: select the parent group, and step
                        // the drilled-into context out with it.
                        this.enteredGroup = this.groupParentOf(parentId);
                        this.scene.selectNode(parentId, false);
                    } else {
                        // At root level: clear selection
                        this.scene.engine!.clear_selection();
                    }
                } else {
                    this.scene.engine!.clear_selection();
                }
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
                this.ui.contextBar?.refresh();
            }
        }

        // Enter: finalize pen path → finish path editing → enter group / edit selected object
        if (e.key === 'Enter') {
            // Inline text overlay owns Enter (newline / Ctrl+Enter commit).
            if (this.activeTextOverlay) return;
            if (this.currentPathPoints.length > 0) {
                this.finalizePenPath();
            } else if (this.editingNodeId !== null) {
                e.preventDefault();
                this.exitEditMode();
                this.ui.setActiveTool('selection');
            } else {
                const selection = this.scene.engine!.get_selection();
                if (selection.length === 1) {
                    e.preventDefault();
                    this.enterSelectedNode(selection[0]);
                }
            }
        }

        // Z-ordering: ]/[ = step forward/backward, Cmd+]/Cmd+[ = front/back.
        // One press is one undo step, however many nodes moved.
        if (e.key === ']') {
            this.scene.transaction(() => this.restack('forward', e.metaKey || e.ctrlKey));
        }
        if (e.key === '[') {
            this.scene.transaction(() => this.restack('backward', e.metaKey || e.ctrlKey));
        }

        // Cmd+D / Ctrl+D: duplicate selected nodes
        if ((e.metaKey || e.ctrlKey) && e.key === 'd') {
            e.preventDefault();
            this.duplicateSelection();
        }

        // Cmd+E / Ctrl+E: flatten selection
        if ((e.metaKey || e.ctrlKey) && e.key === 'e' && !e.shiftKey) {
            e.preventDefault();
            void this.flattenSelection();
        }

        // Arrow key nudging — consecutive presses within 500ms are grouped
        // into a single undo step so Ctrl+Z reverts the whole sequence at once.
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            // With the pen up, arrows nudged whatever was selected before the
            // pen was picked up — an unrelated shape drifting off while you
            // draw, with no visible selection to explain it. The path isn't
            // selectable geometry yet, so there is nothing here for an arrow to
            // move; do nothing rather than move the wrong thing.
            if (this.penOwnsKeyboard()) return;
            // Path editing with vertices selected: nudge the vertices, not the
            // whole node. Delete already targets the selected points here, and
            // the mesh tool below already nudges its selected vertices — only
            // the arrows disagreed, quietly sliding the entire shape while the
            // points you had selected sat still.
            if (this.editingNodeId !== null && this.selectedPoints.size > 0) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                if (this.nudgeSelectedPoints(dx, dy)) this.ui.syncWithSelection();
                return;
            }
            // Mesh tool with selected vertices: nudge the mesh points
            // (node-local units, one undo step per press), not the node.
            if (this.ui.activeTool === 'mesh' && this.ui.meshEdit.selectedVertices.size > 0) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
                const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
                if (this.ui.meshEdit.nudge(dx, dy)) this.ui.syncWithSelection();
                return;
            }
            // Locked artwork is inert. It can still be SELECTED from the
            // Objects panel — that is how you unlock it — and every other
            // gesture already refuses to touch it there, but the arrow keys
            // moved it: the one way to shove a locked shape around by accident.
            const selection = Array.from(this.scene.engine!.get_selection()).filter(
                (id) => !this.scene.isLockedInTree(id),
            );
            if (selection.length > 0) {
                e.preventDefault();
                const step = e.shiftKey ? 10 : 1;
                let dx = 0,
                    dy = 0;
                if (e.key === 'ArrowLeft') dx = -step;
                if (e.key === 'ArrowRight') dx = step;
                if (e.key === 'ArrowUp') dy = -step;
                if (e.key === 'ArrowDown') dy = step;

                // Save history only at the START of a nudge sequence
                if (!this.nudgeInProgress) {
                    this.scene.saveMoveHistory();
                    this.nudgeInProgress = true;
                }

                // Reset the debounce timer on every keypress
                if (this.nudgeTimer !== null) {
                    clearTimeout(this.nudgeTimer);
                }
                this.nudgeTimer = setTimeout(() => {
                    this.nudgeInProgress = false;
                    this.nudgeTimer = null;
                }, 500);

                // A nudge is a step across the CANVAS — one world unit, the
                // direction the arrow points — for a shape at the root and for
                // one inside a group scaled to 200% alike. Sent as a local
                // delta it was multiplied by whatever scale the group carried,
                // and turned diagonal under a rotated one.
                //
                // moveNodesWorld performs the (transform-only) invalidation, and
                // batches so a large selection stays linear rather than
                // re-unioning each shared group ancestor once per node.
                this.scene.moveNodesWorld(selection, dx, dy);
                this.ui.syncWithSelection();
            }
        }

        // Cmd+C: Copy — a selected artwork copies as a frame + its contents,
        // otherwise the selected nodes.
        if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
            const abId = this.renderer.selectedArtboardId;
            const ab =
                abId !== null ? this.scene.getArtboards().find((a) => a.id === abId) : undefined;
            if (ab) {
                this.artboardClipboard = {
                    ab: { ...ab, background: { ...ab.background } },
                    nodeIds: this.artboardContainedRoots(ab),
                };
                this.clipboardIds = [];
            } else {
                // Back-to-front, not click order — paste re-creates them one at
                // a time on top of the stack, so the copy order IS the copies'
                // z-order (see WasmScene.sortByPaintOrder).
                this.clipboardIds = this.scene.sortByPaintOrder(this.scene.engine!.get_selection());
                this.artboardClipboard = null;
            }
            this.cutPending = false;
        }

        // Cmd+X: Cut. The copy-clipboard is a list of live ids, so a cut that
        // deleted the originals would leave paste with nothing to duplicate —
        // the engine lifts the subtrees out of the document instead and keeps
        // them (Engine::cut_nodes).
        // Artwork selection is not in get_selection() — snapshot like Cmd+C,
        // then delete the frame + contents (host hotkeys prefer RCB for this).
        if ((e.metaKey || e.ctrlKey) && e.key === 'x' && !e.altKey) {
            const abId = this.renderer.selectedArtboardId;
            const ab =
                abId !== null ? this.scene.getArtboards().find((a) => a.id === abId) : undefined;
            if (ab) {
                e.preventDefault();
                this.artboardClipboard = {
                    ab: { ...ab, background: { ...ab.background } },
                    nodeIds: this.artboardContainedRoots(ab),
                };
                this.clipboardIds = [];
                this.cutPending = false;
                this.deleteSelectedArtboard();
                this.exitEditMode();
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            } else {
                const sel = this.scene.sortByPaintOrder(this.scene.engine!.get_selection());
                if (sel.length > 0) {
                    e.preventDefault();
                    this.scene.cutNodes(sel);
                    this.cutPending = true;
                    this.clipboardIds = [];
                    this.artboardClipboard = null;
                    this.exitEditMode();
                    this.ui.updateLayerList();
                    this.ui.syncWithSelection();
                }
            }
        }

        // Cmd+V: Paste with union top-left at the pointer (last canvas pos).
        // Shift+Cmd+V: Paste in Place — exactly on top of what was copied, which
        // is how you move something between documents without losing its
        // position on the artwork.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
            const inPlace = e.shiftKey;
            if (this.cutPending && this.scene.hasClipboard()) {
                e.preventDefault();
                this.pasteCut(inPlace);
            } else if (this.artboardClipboard) {
                e.preventDefault();
                this.pasteArtboard(inPlace);
            } else if (this.clipboardIds.length > 0) {
                e.preventDefault();
                this.pasteNodes(inPlace);
            }
        }

        // Cmd+G: Group
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && !e.shiftKey) {
            e.preventDefault();
            this.groupSelection();
        }

        // Cmd+Shift+G: Ungroup
        if ((e.metaKey || e.ctrlKey) && e.key === 'g' && e.shiftKey) {
            e.preventDefault();
            this.ungroupSelection();
        }

        // Cmd+Alt+X: Make Live Paint (Illustrator's Object › Live Paint › Make).
        // Uses e.code because Alt+X emits a special glyph on macOS.
        if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyX') {
            if (this.scene.engine!.get_selection().length > 0) {
                e.preventDefault();
                this.makeLivePaintGroup();
            }
        }
    }

    /** Commit (close) the active inline text overlay, if one is open. Safe to
     *  call unconditionally — a no-op when nothing is being edited. Used to
     *  tear the overlay down on tool switch, document load, etc. */
    commitActiveTextEdit() {
        this.activeTextOverlay?.commit();
    }

    /**
     * Spawn an inline `<textarea>` overlay for editing text on the canvas,
     * shared by double-click edit and text-tool creation. The box is kept glued
     * over the glyphs: `reposition()` recomputes screen position, font size and
     * letter-spacing from the *current* view transform, and is re-run on every
     * view change (see the onViewChange subscription in the constructor) and on
     * every keystroke (auto-size). Only one overlay is open at a time.
     */
    private spawnTextOverlay(opts: {
        /** World-space top-left of the text box (maps to the overlay's left/top). */
        world: { x: number; y: number };
        fontSize: number; // world units
        fontFamily: string; // CSS font-family stack
        fontWeight?: string; // CSS
        fontStyle?: string; // 'normal' | 'italic'
        letterSpacing?: number; // world units
        lineHeight: number;
        color: string;
        value: string;
        placeholder?: string;
        /** Fixed wrap width in world units (auto-height). Omit ⇒ grow sideways. */
        layoutWidth?: number;
        /** CSS text-decoration (underline / overline / line-through). */
        textDecoration?: string;
        /** CSS text-align for the overlay (left / center / right). */
        textAlign?: string;
        /**
         * How many ems the overlay top sits above the text baseline (node
         * origin). From `-getTextLocalBounds().y / fontSize`. Defaults to 1.
         */
        boxTopEm?: number;
        /** Turn of the text on the canvas, in degrees, about `world`. */
        rotationDeg?: number;
        /** Content (trailing newlines stripped) on Ctrl/Cmd+Enter or blur. */
        onCommit: (content: string) => void;
        onCancel?: () => void;
        /** Always runs when the overlay closes (commit or cancel). */
        onTeardown?: () => void;
    }) {
        const container = document.getElementById('canvas-container');
        if (!container) return;
        // Only one overlay at a time — commit any previous one first.
        this.commitActiveTextEdit();

        const fam = opts.fontFamily;
        const fontWeight = opts.fontWeight ?? '400';
        const fontStyleCss = opts.fontStyle ?? 'normal';
        const lsWorld = opts.letterSpacing ?? 0;
        const wrapWorld = opts.layoutWidth != null && opts.layoutWidth > 0 ? opts.layoutWidth : 0;

        const input = document.createElement('textarea');
        input.className = 'text-input-overlay';
        input.value = opts.value;
        if (opts.placeholder) input.placeholder = opts.placeholder;
        input.spellcheck = false;
        input.rows = 1; // so scrollHeight reflects content, not the 2-row default
        Object.assign(input.style, {
            fontFamily: fam,
            fontWeight,
            fontStyle: fontStyleCss,
            lineHeight: String(opts.lineHeight),
            color: opts.color,
            textDecoration: opts.textDecoration || 'none',
            textAlign: opts.textAlign || 'left',
            padding: '0',
            border: 'none',
            margin: '0',
            background: 'transparent',
            resize: 'none',
            overflow: 'hidden',
            // Fixed box → soft-wrap; auto-width → grow with the longest line.
            // When layoutWidth is a *max* column, start as hug (pre) and switch
            // to wrap once content reaches the cap (see reposition).
            whiteSpace: 'pre',
            wordBreak: 'normal',
            minWidth: '0',
            minHeight: '0',
            outline: '1px solid var(--accent)',
        } as Partial<CSSStyleDeclaration>);

        // Baseline correction: Skia Paragraph puts the first baseline at
        // `getAlphabeticBaseline()` below the box top; CSS ascent differs.
        // `boxTopEm` is how far (in em) the overlay top sits above the node
        // origin / baseline — from getTextLocalBounds.y.
        const cssBaselineEm = measureCssBaselineEm(fam, fontWeight, fontStyleCss, opts.lineHeight);
        const boxTopEm = opts.boxTopEm != null && opts.boxTopEm > 0 ? opts.boxTopEm : 1;
        const baselineCorrectionEm = Math.max(0, boxTopEm - cssBaselineEm);

        const measureCtx = document.createElement('canvas').getContext('2d')!;
        // Recompute screen position, font size, letter-spacing and box size from
        // the current view transform. Runs on open, on every view change, and on
        // every keystroke, so the box stays glued over the glyphs at any zoom/pan.
        const reposition = () => {
            const zoom = this.renderer.zoom;
            input.style.left = `${opts.world.x * zoom + this.renderer.pan.x}px`;
            input.style.top = `${opts.world.y * zoom + this.renderer.pan.y}px`;
            input.style.fontSize = `${opts.fontSize * zoom}px`;
            if (opts.rotationDeg) {
                input.style.transformOrigin = '0 0';
                input.style.transform = `rotate(${opts.rotationDeg}deg)`;
            }
            input.style.letterSpacing = `${lsWorld * zoom}px`;
            input.style.paddingTop = `${baselineCorrectionEm * opts.fontSize * zoom}px`;
            // Auto-size to the widest line; when a wrap column is set it is a
            // *maximum* (empty "Type text…" must not open as a full-width slab).
            measureCtx.font = `${fontStyleCss} ${fontWeight} ${opts.fontSize * zoom}px ${fam}`;
            const text = input.value || input.placeholder || '';
            let contentPx = 0;
            for (const line of text.split('\n')) {
                contentPx = Math.max(contentPx, measureCtx.measureText(line).width);
            }
            const hugPx = Math.max(1, Math.ceil(contentPx) + 2);
            if (wrapWorld > 0) {
                const maxPx = Math.ceil(wrapWorld * zoom);
                const atMax = hugPx >= maxPx - 0.5;
                input.style.whiteSpace = atMax || text.includes('\n') ? 'pre-wrap' : 'pre';
                input.style.wordBreak = atMax || text.includes('\n') ? 'break-word' : 'normal';
                input.style.width = `${Math.min(maxPx, hugPx)}px`;
            } else {
                input.style.width = `${hugPx}px`;
            }
            input.style.height = 'auto';
            input.style.height = `${input.scrollHeight}px`;
        };
        input.addEventListener('input', reposition);

        let done = false;
        const teardown = () => {
            this.activeTextOverlay = null;
            this.repositionOverlay = null;
            input.remove();
            opts.onTeardown?.();
        };
        const commit = () => {
            if (done) return;
            done = true;
            const content = input.value.replace(/\n+$/, '');
            teardown();
            opts.onCommit(content);
        };
        const cancel = () => {
            if (done) return;
            done = true;
            teardown();
            opts.onCancel?.();
        };

        input.addEventListener('keydown', (ev: KeyboardEvent) => {
            // Enter inserts a newline (textarea default). Ctrl/Cmd+Enter commits
            // (matches product TextInlineEditor). Shift+Enter also keeps editing.
            if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.shiftKey) {
                ev.preventDefault();
                commit();
            } else if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
            }
            ev.stopPropagation();
        });
        input.addEventListener('blur', commit);

        this.activeTextOverlay = { commit };
        this.repositionOverlay = reposition;

        container.appendChild(input);
        reposition();
        input.focus();
        input.select();
    }

    /** Open an inline editor over an existing text node (double-click). */
    editTextNode(id: number) {
        const geo = this.scene.getNodeGeometry(id);
        if (!geo?.Text) return;

        const t = this.scene.getTransform(id); // row-major: t[2]/t[5] = translation
        const fontSize = geo.Text.font_size;
        const originalContent = geo.Text.content;
        const fam = geo.Text.font_family ? `${geo.Text.font_family}, sans-serif` : 'sans-serif';
        // Match the node's fill colour so the overlay looks like the real text.
        const node = this.scene.getNode(id);
        const f = node?.style?.fills?.[0] as
            | { r: number; g: number; b: number; a?: number }
            | undefined;
        const color =
            f && 'r' in f
                ? `rgba(${Math.round(f.r * 255)},${Math.round(f.g * 255)},${Math.round(f.b * 255)},${f.a ?? 1})`
                : '#000';
        if (geo.Text.font_family) ensureFontCSS(geo.Text.font_family);

        // The overlay stands in for the glyphs on the canvas, so it has to be
        // the size and turn of the glyphs on the canvas — not of the node's own
        // font_size, which is measured in its parent's space. Editing a text
        // inside a group scaled to 200% used to shrink it to half size for as
        // long as the cursor was in it, and a rotated one straightened out.
        const [a, b, tx, c, d, ty] = [t[0], t[1], t[2], t[3], t[4], t[5]];
        const scaleY = Math.hypot(b, d) || 1; // how tall one em is on the canvas
        const scaleX = Math.hypot(a, c) || 1;
        const rotationDeg = (Math.atan2(c, a) * 180) / Math.PI;
        // Local box origin, which also carries the alignment shift (centred and
        // right-aligned runs are drawn left of the node's origin).
        const local = this.renderer.getTextLocalBounds(id) ?? { x: 0, y: -fontSize };
        const layoutW = this.renderer.getTextLayoutWidth(id);
        const decoFlags = this.renderer.getTextDecoration(id);
        const decoCss = [
            decoFlags & 1 ? 'underline' : '',
            decoFlags & 2 ? 'overline' : '',
            decoFlags & 4 ? 'line-through' : '',
        ]
            .filter(Boolean)
            .join(' ');
        this.spawnTextOverlay({
            // Overlay top = measured glyph box top; padding pins the CSS
            // first-line baseline onto the node origin (Skia baseline).
            world: { x: a * local.x + b * local.y + tx, y: c * local.x + d * local.y + ty },
            fontSize: fontSize * scaleY,
            rotationDeg,
            fontFamily: fam,
            fontWeight: String(geo.Text.font_weight || 400),
            fontStyle: geo.Text.italic ? 'italic' : 'normal',
            letterSpacing: (geo.Text.letter_spacing || 0) * scaleX,
            lineHeight: geo.Text.line_height || 1.2,
            color,
            textDecoration: decoCss || 'none',
            textAlign: (['left', 'center', 'right'] as const)[geo.Text.text_align] || 'left',
            value: originalContent,
            layoutWidth: layoutW != null ? layoutW * scaleX : undefined,
            boxTopEm: fontSize > 0 ? Math.max(0.1, -local.y / fontSize) : 1,
            onCommit: (content) => {
                if (!content) {
                    // Emptied → delete the node (Figma behaviour), single undo step.
                    this.renderer.clearTextLayoutWidth(id);
                    this.renderer.clearTextDecoration(id);
                    this.scene.removeNode(id);
                    this.ui.updateLayerList();
                    this.ui.syncWithSelection();
                } else if (content !== originalContent) {
                    this.scene.setTextContent(id, content, fontSize);
                    this.ui.syncWithSelection();
                }
            },
            onTeardown: () => {
                this.renderer.editingTextId = null;
                this.renderer.requestRender();
            },
        });

        // Hide the underlying node while its overlay stands in (no more
        // doubling) — AFTER spawning, because spawning first commits whatever
        // overlay was already open, and that teardown clears this very flag.
        this.renderer.editingTextId = id;
        this.renderer.requestRender();
    }

    /** Abort the current drag (Esc): restore the pre-drag scene state and
     *  drop all previews. The subsequent mouseup is a no-op because
     *  isMouseDown is already cleared. */
    cancelActiveDrag() {
        if (this.moveSnapshot) {
            this.scene.engine!.deserialize_scene(this.moveSnapshot);
            this.moveSnapshot = null;
            this.moveOriginalIds = [];
            this.moveStartBounds = null;
            this.gesturePristine = null;
            this.moveClonesActive = false;
        }
        if (this.resizeSnapshot) {
            this.scene.engine!.deserialize_scene(this.resizeSnapshot);
        }
        if (this.rotateSnapshot) {
            this.scene.engine!.deserialize_scene(this.rotateSnapshot);
        }
        this.resizeHandleType = null;
        this.resizeStartBounds = null;
        this.resizeTargetIds = [];
        this.resizeSnapshot = null;
        this.liveResizeBounds = null;
        this.rotateHandleType = null;
        this.rotateSnapshot = null;
        this.rotateTargetIds = [];
        this.rotatePivot = null;
        this.rotateSingleStartDeg = null;
        this.previewRect = null;
        this.previewLine = null;
        this.pencilPoints = null;
        this.marqueeRect = null;
        this.meshMarqueeStart = null;
        this.renderer.meshDraftMode = false;
        this.dragMode = 'none';
        this.isMouseDown = false;
        this.didMove = false;
        this.gesturePristine = null;
        this.moveClonesActive = false;
        this.snap.end();
        this.activeSnapGuides = [];
        this.canvas.style.cursor = 'default';
        this.scene.invalidateCache();
        this.ui.syncWithSelection();
    }

    onKeyUp(e: KeyboardEvent) {
        if (e.key === ' ') {
            this.isSpacePan = false;
            if (!this.panDrag) {
                this.canvas.style.cursor = 'default';
            }
        }
        // Releasing ⌘/Ctrl re-enables snapping: bring the hover preview back
        // immediately, without waiting for a mouse move.
        if (e.key === 'Meta' || e.key === 'Control') {
            this.metaKey = e.metaKey;
            this.ctrlKey = e.ctrlKey;
            this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);
            this.updatePenHover();
        }
        // Releasing ⌥/⇧/⌘ puts the bucket back, cursor and highlight both.
        if (
            (e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta' || e.key === 'Control') &&
            !this.isMouseDown &&
            this.ui.activeTool === 'paint-bucket'
        ) {
            this.updatePaintBucketHover(e.altKey, e.shiftKey, e.metaKey || e.ctrlKey);
            this.renderer.requestRender();
        }
        // Same contract for the Selection tool: ⌥ (duplicate) and ⌘ (select
        // inside the group) change what the press will do AND which node it
        // takes, so both the cursor and the highlight have to move on the
        // keypress rather than on the next mouse move.
        if (
            (e.key === 'Alt' || e.key === 'Meta' || e.key === 'Control') &&
            !this.isMouseDown &&
            this.ui.activeTool === 'selection' &&
            this.editingNodeId === null
        ) {
            this.updateSelectionHover(e.altKey, e.metaKey || e.ctrlKey);
        }
        this.reapplyDragForModifiers(e);
    }

    /** Alt/Shift/Cmd/Ctrl change the outcome of an in-progress resize, rotate,
     *  or move (resize-from-center, aspect lock, clone, axis constraint, snap
     *  bypass). Those paths only re-evaluate on mouse movement, so a modifier
     *  pressed or released while the cursor is still would otherwise not take
     *  effect until the next move. Replay the last mousemove with the updated
     *  modifier state so the transform updates the instant the key changes. */
    private reapplyDragForModifiers(e: KeyboardEvent) {
        if (!this.isMouseDown || !this.lastMouseEvent) return;
        if (e.key !== 'Alt' && e.key !== 'Shift' && e.key !== 'Meta' && e.key !== 'Control') return;
        const dragActive =
            this.resizeSnapshot ||
            this.rotateSnapshot ||
            this.moveSnapshot ||
            this.gradientDragActive ||
            this.meshDragActive ||
            this.draggingHandleType;
        if (!dragActive) return;
        const src = this.lastMouseEvent;
        const synthetic = {
            clientX: src.clientX,
            clientY: src.clientY,
            shiftKey: e.shiftKey,
            altKey: e.altKey,
            metaKey: e.metaKey,
            ctrlKey: e.ctrlKey,
        } as MouseEvent;
        this.onMouseMove(synthetic);
    }

    /** Cached canvas client rect (see the invalidation listeners in setup). */
    private _canvasRect: DOMRect | null = null;
    private canvasRect(): DOMRect {
        if (!this._canvasRect) this._canvasRect = this.canvas.getBoundingClientRect();
        return this._canvasRect;
    }

    getPos(e: MouseEvent) {
        const rect = this.canvasRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        return {
            x: (screenX - this.renderer.pan.x) / this.renderer.zoom,
            y: (screenY - this.renderer.pan.y) / this.renderer.zoom,
        };
    }

    /** Recompute the pre-drag snap-preview guides for the current hover position.
     *  Called from mousemove AND from ⌘/Ctrl key changes, so the guides appear or
     *  clear the instant the modifier is pressed/released — not only on movement. */
    updateHoverSnapPreview(bypassed: boolean) {
        if (this.isMouseDown) return;
        const want =
            HOVER_SNAP_TOOLS.has(this.ui.activeTool) && this.editingNodeId === null && !bypassed;
        const prev = this.activeSnapGuides;
        if (want) {
            this.snap.beginHover(this.scene);
            const s = this.snap.snapPoint(
                this.currentPos.x,
                this.currentPos.y,
                8 / this.renderer.zoom,
            );
            this.snap.end();
            this.activeSnapGuides = s.guides;
        } else if (this.activeSnapGuides.length) {
            this.activeSnapGuides = [];
        }
        if (this.activeSnapGuides !== prev) {
            const a = prev;
            const b = this.activeSnapGuides;
            const changed =
                a.length !== b.length ||
                a.some((g, i) => g !== b[i] && JSON.stringify(g) !== JSON.stringify(b[i]));
            if (changed) this.renderer.requestRender();
        }
    }

    /** Recompute the pen rubber-band hover position and close-affordance from
     *  the last mouse position. Called on mouse move AND on ⌘/Ctrl press/release
     *  (via the key handlers) so the close ring and snapping toggle instantly
     *  with the modifier — no mouse move required. */
    updatePenHover() {
        if (this.isMouseDown || this.ui.activeTool !== 'pen') {
            if (this.penHoverPos !== null || this.penHoverAdopt !== null) {
                this.penHoverPos = null;
                this.penHoverClosing = false;
                this.penHoverAdopt = null;
                this.renderer.requestRender();
            }
            return;
        }
        // Cmd/Ctrl bypasses snapping and, with it, closing on the first anchor.
        const bypass = this.metaKey || this.ctrlKey;
        let hp = this.currentPos;
        if (!bypass) {
            this.snap.beginHover(this.scene, { skipArtboards: true });
            const s = this.snap.snapPoint(hp.x, hp.y, 8 / this.renderer.zoom);
            this.snap.end();
            hp = { x: s.x, y: s.y };
        }
        const prevPos = this.penHoverPos;
        const prevClosing = this.penHoverClosing;
        const prevAdopt = this.penHoverAdopt;
        this.penHoverPos = hp;
        this.penHoverClosing = false;
        this.penHoverAdopt = null;
        if (!bypass && this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const d = Math.hypot(hp.x - first.x, hp.y - first.y);
            this.penHoverClosing = d < InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom;
        } else if (!bypass && this.currentPathPoints.length === 0) {
            // Idle pen: highlight an existing open endpoint a click would continue.
            const hit = this.findAdoptableEndpoint(hp);
            if (hit) {
                const sp = this.scene.getNodeGeometry(hit.nodeId)?.Path?.subpaths[hit.subpathIndex];
                if (sp) {
                    const p = hit.end === 'start' ? sp.points[0] : sp.points[sp.points.length - 1];
                    const t = this.scene.getTransform(hit.nodeId);
                    const [wx, wy] = this.penLocalToWorld(t, p.x, p.y);
                    this.penHoverAdopt = { x: wx, y: wy };
                }
            }
        }
        // Prefer host SVG (product pen tip); fall back to TOOL_CURSORS / crosshair.
        this.canvas.style.cursor = this.ui.cursorForTool('pen');
        const posChanged =
            !prevPos ||
            Math.abs(prevPos.x - hp.x) > 1e-4 ||
            Math.abs(prevPos.y - hp.y) > 1e-4;
        const adoptChanged =
            (prevAdopt == null) !== (this.penHoverAdopt == null) ||
            (prevAdopt != null &&
                this.penHoverAdopt != null &&
                (Math.abs(prevAdopt.x - this.penHoverAdopt.x) > 1e-4 ||
                    Math.abs(prevAdopt.y - this.penHoverAdopt.y) > 1e-4));
        if (posChanged || adoptChanged || prevClosing !== this.penHoverClosing) {
            this.renderer.requestRender();
        }
    }

    /** Cached #canvas-container element (looked up per wheel tick before). */
    private _wheelContainer: HTMLElement | null = null;
    onWheel(e: WheelEvent) {
        // Only handle wheel events when the target is the canvas or its container
        if (!this._wheelContainer) {
            this._wheelContainer = document.getElementById('canvas-container');
        }
        const container = this._wheelContainer;
        if (!container?.contains(e.target as Node)) return;

        e.preventDefault();

        if (e.ctrlKey || e.metaKey) {
            const rect = this.canvasRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            const factor = 0.99 ** e.deltaY;
            const oldZoom = this.renderer.zoom;
            const newZoom = Math.max(0.01, Math.min(100, oldZoom * factor));
            const worldX = (mouseX - this.renderer.pan.x) / oldZoom;
            const worldY = (mouseY - this.renderer.pan.y) / oldZoom;
            this.renderer.zoom = newZoom;
            this.renderer.pan.x = mouseX - worldX * newZoom;
            this.renderer.pan.y = mouseY - worldY * newZoom;
            this.ui.setZoom(newZoom);
        } else {
            this.renderer.pan.x -= e.deltaX;
            this.renderer.pan.y -= e.deltaY;
        }
        // Wheel/trackpad zoom and pan arrive in bursts and only move the view,
        // so the renderer may serve these frames from a cached raster and
        // re-render sharp once they stop.
        this.renderer.noteViewGesture();
        this.renderer.notifyViewChange();
    }

    // ─── Artboard interaction (UI-level; engine node selection untouched) ────

    /** Select an artboard: clear node selection, highlight it, refresh panel. */
    selectArtboard(id: number) {
        if (this.editingNodeId !== null) this.exitEditMode();
        this.scene.engine!.clear_selection();
        this.renderer.selectedArtboardId = id;
        this.ui.syncWithSelection();
        this.ui.refreshArtboardPanel();
        // In-place highlight (no rebuild) so double-click-to-rename survives.
        this.ui.updateLayerSelection();
        this.renderer.requestRender();
    }

    deselectArtboard() {
        this.renderer.selectedArtboardId = null;
        this.ui.refreshArtboardPanel();
        this.ui.updateLayerSelection();
        this.renderer.requestRender();
    }

    /** Delete the currently-selected artwork (frame) together with everything
     *  inside it — a single undo restores the frame and all its contents. */
    deleteSelectedArtboard() {
        const id = this.renderer.selectedArtboardId;
        if (id === null) return;
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        const contained = ab ? this.artboardContainedRoots(ab) : [];
        // If a contained node is being path-edited, leave edit mode first.
        if (this.editingNodeId !== null && contained.includes(this.editingNodeId)) {
            this.exitEditMode();
        }
        this.scene.transaction(() => {
            for (const nid of contained) this.scene.engine!.remove_node(nid);
            this.scene.engine!.remove_artboard(id);
        });
        this.renderer.selectedArtboardId = null;
        this.ui.refreshArtboardPanel();
        this.ui.updateLayerList();
        this.renderer.requestRender();
    }

    // ─── Artwork ↔ contents membership (geometric, Figma-style) ──────────────
    // Artboards are a scene-level list, not nodes, so there is no parent/child
    // link to the shapes drawn inside them. Membership is resolved on demand:
    // a top-level node belongs to a frame when its bounding-box center lies
    // within the frame's rect. This set is captured at the moment of an action
    // (move / delete / copy) and then stays fixed for that action.

    /** World-space AABB of a node including all descendants, or null when it has
     *  no spatial geometry.
     *
     *  Groups ARE in the engine's spatial index — the old comment here claimed
     *  otherwise and hand-unioned the children, which quietly disagreed with the
     *  engine for a Boolean Group (whose box is its painted outline, not the
     *  union of the operands it consumed). One source of truth instead. */
    private nodeWorldBounds(
        id: number,
    ): { minX: number; minY: number; maxX: number; maxY: number } | null {
        const b = this.scene.getNodeBounds(id); // [minX, minY, maxX, maxY]
        // The engine returns all-zeros for a node with no spatial entry.
        if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0) return null;
        return { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] };
    }

    /** Top-level nodes whose center lies within the artwork's rect — the set
     *  that moves/deletes/copies with the frame. */
    private artboardContainedRoots(ab: Artboard): number[] {
        const out: number[] = [];
        for (const id of this.scene.getRootNodes()) {
            const b = this.nodeWorldBounds(id);
            if (!b) continue;
            const cx = (b.minX + b.maxX) / 2;
            const cy = (b.minY + b.maxY) / 2;
            if (cx >= ab.x && cx <= ab.x + ab.w && cy >= ab.y && cy <= ab.y + ab.h) {
                out.push(id);
            }
        }
        return out;
    }

    /** Create a copy of an artwork — the frame plus the given contained nodes —
     *  offset by (ox, oy). MUST run inside a scene.transaction(). Returns the new
     *  frame's id. */
    private cloneArtboard(ab: Artboard, nodeIds: number[], ox: number, oy: number): number {
        const eng = this.scene.engine!;
        const newId = eng.add_artboard(ab.x + ox, ab.y + oy, ab.w, ab.h);
        eng.set_artboard_name(newId, `${ab.name} copy`);
        const bg = ab.background;
        eng.set_artboard_background(newId, bg.r, bg.g, bg.b, bg.a);
        for (const nid of nodeIds) {
            const clone = eng.duplicate_node(nid); // has a built-in +20,+20 offset
            eng.move_node(clone, ox - 20, oy - 20); // re-align to exactly (ox, oy)
        }
        return newId;
    }

    /** True while the last clipboard operation was a Cut, so ⌘V should pull from
     *  the engine's clipboard rather than duplicating the copied ids. */
    private cutPending = false;

    /**
     * ⌘V (not in-place): translate pasted roots so the union top-left sits on
     * {@link currentPos} (last canvas pointer). Matches product paste-at-click.
     * No-op until the pointer has been sampled on the canvas (avoids 0,0).
     */
    private movePasteToPointer(ids: number[]) {
        if (!ids.length || !this.pointerSceneReady) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const id of ids) {
            const b = this.scene.getNodeBounds(id);
            if (!b || b.length < 4) continue;
            minX = Math.min(minX, Number(b[0]));
            minY = Math.min(minY, Number(b[1]));
            maxX = Math.max(maxX, Number(b[2]));
            maxY = Math.max(maxY, Number(b[3]));
        }
        if (!(Number.isFinite(minX) && minX < maxX && minY < maxY)) return;
        const dx = this.currentPos.x - minX;
        const dy = this.currentPos.y - minY;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return;
        this.scene.moveNodesWorld(ids, dx, dy);
    }

    /** Paste what was cut. The clipboard isn't consumed, so ⌘X ⌘V ⌘V gives two
     *  copies, the same as a copy would. */
    private pasteCut(inPlace: boolean) {
        // In-place: land on the cut origin. Pointer paste: spawn at 0 then snap.
        // No pointer yet: classic +20 nudge so the copy stays visible.
        const off = inPlace || this.pointerSceneReady ? 0 : 20;
        // Read the context before the paste changes the selection.
        const container = this.drawContainerTarget();
        this.scene.transaction(() => {
            const ids = this.scene.pasteClipboard(off, off);
            if (ids.length === 0) return;
            this.pasteIntoContainer(ids, container);
            if (!inPlace) this.movePasteToPointer(ids);
            this.scene.engine!.clear_selection();
            for (const id of ids) {
                this.ui.collapseSubtreeByDefault(id);
                this.scene.selectNode(id, true);
            }
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** File pasted nodes into the container the document is currently inside —
     *  the same rule a drawn shape follows, so pasting a member back into the
     *  Live Paint group you are working in needs no second step. `null` (nothing
     *  selected, or a selection spanning containers) leaves them at the root,
     *  which is where paste has always put them. */
    private pasteIntoContainer(ids: number[], container: number | null) {
        if (container === null || ids.length === 0) return;
        if (this.scene.getNodeType(container) === undefined) return;
        const index = Array.from(this.scene.getNodeChildren(container)).filter(
            (c) => !ids.includes(c),
        ).length;
        this.scene.reorderNodes(ids, container, index);
    }

    /** Paste the copied nodes. `inPlace` (⇧⌘V) lands them exactly over what was
     *  copied; otherwise union top-left follows the pointer. */
    private pasteNodes(inPlace: boolean) {
        const eng = this.scene.engine!;
        // The clipboard holds live node ids, so anything deleted since the copy
        // is no longer there to duplicate. `duplicate_node` answers a missing id
        // with a freshly allocated EMPTY node rather than nothing, which paste
        // then adds to the document — an invisible row in the layer list. Drop
        // the dead ids instead.
        const live = this.clipboardIds.filter((id) => this.scene.getNodeType(id) !== undefined);
        this.clipboardIds = live;
        if (live.length === 0) return;
        // Read the context before the paste changes the selection.
        const container = this.drawContainerTarget();
        this.scene.transaction(() => {
            eng.clear_selection();
            const pasted: number[] = [];
            for (const id of live) {
                const newId = this.scene.duplicateNode(id);
                // duplicate_node builds in a +20,+20 offset; take it back off for
                // in-place. Pointer paste leaves it — movePasteToPointer snaps by bounds.
                if (inPlace) eng.move_node(newId, -20, -20);
                // Every clone is born at the ROOT wearing the local transform it
                // had inside its parent, so a copy of a shape in a group scaled
                // to 200% starts out half the size of what was copied — and the
                // world-preserving reparent below then keeps it that way. File
                // it beside its original first: from there it matches what was
                // copied, and moving it into the paste target preserves that.
                this.keepCopyBesideOriginal(newId, id);
                // Pasted groups start collapsed to keep the panel tidy.
                this.ui.collapseSubtreeByDefault(newId);
                pasted.push(newId);
            }
            this.pasteIntoContainer(pasted, container);
            if (!inPlace) this.movePasteToPointer(pasted);
            for (const id of pasted) this.scene.selectNode(id, true);
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Paste the copied artwork (frame + contents) — at the pointer, or
     *  squarely on top of it for ⇧⌘V. */
    private pasteArtboard(inPlace: boolean) {
        const clip = this.artboardClipboard;
        if (!clip) return;
        let newId = -1;
        let ox = 0;
        let oy = 0;
        if (!inPlace) {
            if (this.pointerSceneReady) {
                ox = this.currentPos.x - clip.ab.x;
                oy = this.currentPos.y - clip.ab.y;
            } else {
                ox = clip.ab.w + 40;
                oy = 0;
            }
        }
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            newId = this.cloneArtboard(clip.ab, clip.nodeIds, ox, oy);
        });
        this.selectArtboard(newId);
        this.ui.updateLayerList();
    }

    /** Duplicate the selected artwork in place (Cmd+D / context-menu Duplicate). */
    private duplicateSelectedArtboard() {
        const id = this.renderer.selectedArtboardId;
        if (id === null) return;
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        if (!ab) return;
        const nodeIds = this.artboardContainedRoots(ab);
        let newId = -1;
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            newId = this.cloneArtboard(ab, nodeIds, ab.w + 40, 0);
        });
        this.selectArtboard(newId);
        this.ui.updateLayerList();
    }

    private beginArtboardDrag(id: number, mode: 'move' | 'resize', handle: ArtboardHandle | null) {
        const ab = this.scene.getArtboards().find((a) => a.id === id);
        if (!ab) return;
        // On a move, the shapes inside the frame travel with it; capture them now.
        const contained = mode === 'move' ? this.artboardContainedRoots(ab) : [];
        this.artboardDrag = {
            id,
            mode,
            handle,
            start: { x: ab.x, y: ab.y, w: ab.w, h: ab.h },
            startWorld: { ...this.startPos },
            contained,
            movedDx: 0,
            movedDy: 0,
        };
        // Snap to other shapes/artboards. Exclude this frame's own edges and its
        // contained shapes (they move with the frame, so snapping to their start
        // positions would fight the drag).
        this.snap.begin(this.scene, contained, id);
        this.scene.beginGesture(); // coalesce the whole drag into one undo step
    }

    /** True while an artboard is mid move-drag past the press threshold. */
    isArtboardMoving(): boolean {
        return Boolean(this.artboardDrag?.mode === 'move' && this.didMove);
    }

    /** True while an artboard resize handle drag is in flight. */
    isArtboardResizing(): boolean {
        return Boolean(this.artboardDrag?.mode === 'resize' && this.didMove);
    }

    private updateArtboardDrag() {
        const d = this.artboardDrag;
        if (!d) return;
        const dx = this.currentPos.x - d.startWorld.x;
        const dy = this.currentPos.y - d.startWorld.y;
        let { x, y, w, h } = d.start;
        const MIN = 1;
        const thr = 8 / this.renderer.zoom;
        const snapOff = this.metaKey || this.ctrlKey; // Cmd/Ctrl bypasses snapping
        this.activeSnapGuides = [];

        if (d.mode === 'move') {
            x += dx;
            y += dy;
            if (!snapOff) {
                const s = this.snap.snapBounds({ x, y, w, h }, thr);
                x += s.dx;
                y += s.dy;
                this.activeSnapGuides = s.guides;
            }
        } else {
            const hnd = d.handle!;
            if (hnd.includes('e')) w = Math.max(MIN, d.start.w + dx);
            if (hnd.includes('s')) h = Math.max(MIN, d.start.h + dy);
            if (hnd.includes('w')) {
                w = Math.max(MIN, d.start.w - dx);
                x = d.start.x + (d.start.w - w);
            }
            if (hnd.includes('n')) {
                h = Math.max(MIN, d.start.h - dy);
                y = d.start.y + (d.start.h - h);
            }
            // Snap the moving edge(s) to targets.
            if (!snapOff) {
                if (hnd.includes('e')) {
                    const s = this.snap.snapAxis('x', x + w, thr);
                    if (s) {
                        w = Math.max(MIN, s.value - x);
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('w')) {
                    const s = this.snap.snapAxis('x', x, thr);
                    if (s) {
                        const right = x + w;
                        x = Math.min(s.value, right - MIN);
                        w = right - x;
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('s')) {
                    const s = this.snap.snapAxis('y', y + h, thr);
                    if (s) {
                        h = Math.max(MIN, s.value - y);
                        this.activeSnapGuides.push(s.guide);
                    }
                }
                if (hnd.includes('n')) {
                    const s = this.snap.snapAxis('y', y, thr);
                    if (s) {
                        const bottom = y + h;
                        y = Math.min(s.value, bottom - MIN);
                        h = bottom - y;
                        this.activeSnapGuides.push(s.guide);
                    }
                }
            }
        }
        this.scene.setArtboardBounds(d.id, x, y, w, h);
        // Drag the contained shapes by the same cumulative delta (move only).
        if (d.mode === 'move' && d.contained.length > 0) {
            const totalDx = x - d.start.x;
            const totalDy = y - d.start.y;
            const stepDx = totalDx - d.movedDx;
            const stepDy = totalDy - d.movedDy;
            if (stepDx !== 0 || stepDy !== 0) {
                // Batched: this runs every frame of a frame-drag, and the
                // contained set is often large. Full invalidation is kept (the
                // artboard's own bounds changed too, not just translations).
                this.scene.engine!.move_nodes(
                    JSON.stringify(
                        Array.from(d.contained).map((nid) => ({ id: nid, dx: stepDx, dy: stepDy })),
                    ),
                );
                this.scene.invalidateCache();
                d.movedDx = totalDx;
                d.movedDy = totalDy;
            }
        }
        this.ui.refreshArtboardPanel();
    }

    private endArtboardDrag() {
        if (!this.artboardDrag) return;
        this.artboardDrag = null;
        this.snap.end();
        this.activeSnapGuides = [];
        this.scene.endGesture();
        this.ui.refreshArtboardPanel();
    }

    onMouseDown(e: MouseEvent) {
        // Ignore right-click — handled by onContextMenu
        if (e.button === 2) return;
        if (this.penSuppressDoubleClick) {
            // Tail of the click pair whose first click closed a pen path: the
            // pen is done and Selection is back, so this press would re-target
            // the selection at whatever lies under the cursor. Swallow it and
            // keep the flag for the dblclick still to come. A press that starts
            // a fresh sequence (detail 1) means no dblclick is coming after all.
            if (e.detail >= 2) return;
            this.penSuppressDoubleClick = false;
        }
        this.ui.hideContextMenu();
        // Before anything can change the selection: whether this press starts a
        // shape inside a Live Paint group is a fact about where we already were.
        this.latchDrawContainerTarget();
        this.isMouseDown = true;
        this.didMove = false;
        this._canvasRect = null; // gestures never start against a stale rect
        this.startPos = this.getPos(e);
        this.currentPos = { ...this.startPos };
        this.pointerSceneReady = true;
        this.hoverNodeId = null;
        // Any fresh press deselects the current guide; the guide-grab block below
        // re-selects one if the press landed on it.
        this.selectedGuide = null;
        // Hide the pen rubber-band while a press is in progress.
        this.penHoverPos = null;
        this.penHoverClosing = false;
        this.penHoverAdopt = null;

        // Space held (or middle mouse): pan the viewport instead of using the tool
        if (this.isSpacePan || e.button === 1) {
            e.preventDefault();
            this.panDrag = {
                screenX: e.clientX,
                screenY: e.clientY,
                panX: this.renderer.pan.x,
                panY: this.renderer.pan.y,
            };
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        // Grab a ruler guide under the cursor (selection/direct tools, not while
        // editing a path). Guides sit above the artwork, so this takes priority.
        if (
            this.guides &&
            this.editingNodeId === null &&
            (this.ui.activeTool === 'selection' || this.ui.activeTool === 'direct')
        ) {
            const hit = this.guides.hitGuide(
                this.startPos.x,
                this.startPos.y,
                5 / this.renderer.zoom,
            );
            // ...but a handle drawn on top of the guide wins the click, so a guide
            // parked on a shape's edge can't make that handle unreachable.
            if (hit && !this.hasCanvasControlAt(this.startPos)) {
                // Select the guide (drives the guide action bar) and clear any node
                // selection so the two don't fight.
                this.selectedGuide = hit;
                this.scene.engine!.clear_selection();
                // A locked guide can be selected (to unlock/delete) but not dragged.
                if (!this.guides.isLocked(hit)) {
                    this.draggingGuide = hit;
                    this.highlightedGuide = hit;
                    this.scene.pushHistorySnapshot();
                    this.canvas.style.cursor = hit.axis === 'x' ? 'col-resize' : 'row-resize';
                }
                this.ui.syncWithSelection();
                this.renderer.requestRender();
                return;
            }
        }

        if (this.ui.activeTool === 'selection') {
            // Artboard chrome (resize handles + name labels). UI-level only —
            // engine node selection is untouched. Only when not path-editing.
            if (this.editingNodeId === null) {
                const abResize =
                    this.renderer.selectedArtboardId !== null
                        ? this.renderer.artboardHandleHitTest(this.startPos.x, this.startPos.y)
                        : null;
                if (abResize) {
                    this.beginArtboardDrag(abResize.id, 'resize', abResize.handle);
                    return;
                }
                const abLabel = this.renderer.artboardLabelHitTest(
                    this.startPos.x,
                    this.startPos.y,
                );
                if (abLabel !== null) {
                    this.selectArtboard(abLabel);
                    this.beginArtboardDrag(abLabel, 'move', null);
                    return;
                }
                // Do not deselect yet — empty plate body select runs after node miss.
            }

            // Gradient handles take priority over resize/rotate while a
            // gradient fill is being edited (skip in node-editing mode)
            if (this.editingNodeId === null && this.ui.gradientEdit.isActive()) {
                const gHit = this.ui.gradientEdit.hitTest(this.startPos, this.renderer.zoom);
                if (gHit) {
                    if (gHit.type === 'insert') {
                        this.ui.gradientEdit.beginInsertDrag(gHit.t, this.startPos);
                    } else {
                        this.ui.gradientEdit.beginDrag(gHit, this.startPos);
                    }
                    this.gradientDragActive = true;
                    this.ui.syncWithSelection({ interactive: true });
                    return;
                }
            }

            // Check resize handles first (skip in node-editing mode)
            const outlineOnly = Boolean(this.renderer.selectionOutlineOnly?.());
            const frame = this.editingNodeId === null ? this.getSelectionFrame() : null;
            const handle =
                frame && !outlineOnly ? this.checkResizeHandle(this.startPos, frame) : null;
            if (handle && frame) {
                this.resizeHandleType = handle.type;
                this.resizeTargetIds = Array.from(
                    this.scene.dedupSelection(this.scene.engine!.get_selection()),
                );
                // Snapshot scene state so we can restore-then-resize each frame
                this.resizeSnapshot = this.scene.engine!.serialize_scene();
                // Pristine transforms for the fast per-frame reset used when
                // every target is a group (a group resize only scales the
                // group's transform, so no full deserialize is needed).
                this.captureGesturePristine(this.resizeTargetIds);
                // A single text node always uses the oriented pipeline: its
                // resize scales the font size from the JS-measured text bounds
                // (the engine has no font metrics, so the legacy world-space
                // path would use bad bounds).
                const singleText =
                    this.resizeTargetIds.length === 1 &&
                    this.scene.getNodeType(this.resizeTargetIds[0]) === 4;
                if (this.frameIsAxisAligned(frame) && !singleText) {
                    // Legacy world-space pipeline (with snapping)
                    this.resizeStartBounds = this.getSelectionBounds();
                    this.snap.begin(this.scene, this.resizeTargetIds);
                } else {
                    // Oriented pipeline: drag in the frame's own axes (single node)
                    this.resizeFrame = frame;
                    this.resizeLocalBounds = this.getNodeLocalBounds(this.resizeTargetIds[0]);
                }
                this.scene.saveMoveHistory();
                return;
            }

            // Check corner radius handles (skip in node-editing mode)
            const crHandle =
                this.editingNodeId === null && !outlineOnly
                    ? this.checkCornerRadiusHandle(this.startPos)
                    : null;
            if (crHandle) {
                const node = this.scene.getNode(crHandle.nodeId);
                if (node) {
                    this.cornerRadiusDragging = {
                        nodeId: crHandle.nodeId,
                        startRadius: node.style.corner_radius || 0,
                        startPos: { ...this.startPos },
                    };
                    this.scene.saveMoveHistory();
                    return;
                }
            }

            // Check rotate zone (just outside a corner handle; skip in node-editing mode)
            const rotateHandle =
                frame && !outlineOnly ? this.checkRotateHandle(this.startPos, frame) : null;
            if (rotateHandle && frame) {
                this.rotateHandleType = rotateHandle.type;
                this.rotatePivot = this.framePoint(frame, frame.w / 2, frame.h / 2);
                this.rotateStartAngle = Math.atan2(
                    this.startPos.y - this.rotatePivot.y,
                    this.startPos.x - this.rotatePivot.x,
                );
                this.rotateTargetIds = Array.from(
                    this.scene.dedupSelection(this.scene.engine!.get_selection()),
                );
                this.rotateSingleStartDeg =
                    this.rotateTargetIds.length === 1
                        ? this.scene.getNodeTransformComponents(this.rotateTargetIds[0])
                              .rotation_deg
                        : null;
                this.rotateSnapshot = this.scene.engine!.serialize_scene();
                // Pristine transforms for the fast per-frame reset (rotation is
                // transform-only, so no full deserialize is needed each frame).
                this.captureGesturePristine(this.rotateTargetIds);
                this.scene.saveMoveHistory();
                this.canvas.style.cursor = this.rotateCursorForCorner(rotateHandle.type, frame);
                return;
            }

            const isDeepSelect = e.metaKey || e.ctrlKey;
            const hitId = this.getTargetIdForHit(this.startPos, isDeepSelect);
            if (hitId !== undefined) {
                // Clicked on an object — select it and prepare to drag-move
                if (this.renderer.selectedArtboardId !== null) this.deselectArtboard();
                if (!e.shiftKey) {
                    // If the object isn't already selected, replace selection
                    const currentSel = this.scene.engine!.get_selection();
                    if (!currentSel.includes(hitId)) {
                        this.scene.selectNode(hitId, false);
                    }
                } else if (this.scene.engine!.get_selection().includes(hitId)) {
                    // Already selected: this is a removal unless it becomes a
                    // drag. Decided on mouse-up (see `pendingShiftDeselect`).
                    this.pendingShiftDeselect = hitId;
                } else {
                    this.scene.selectNode(hitId, true);
                }
                this.dragMode = 'move';
            } else {
                // Empty plate body (no node under cursor) → select artboard + blue border.
                const abBody =
                    this.editingNodeId === null
                        ? this.renderer.artboardBodyHitTest(this.startPos.x, this.startPos.y)
                        : null;
                if (abBody !== null) {
                    this.selectArtboard(abBody);
                    this.beginArtboardDrag(abBody, 'move', null);
                    this.ui.syncWithSelection();
                    this.ui.updateLayerList();
                    return;
                }
                // Clicked on empty pasteboard — start marquee selection.
                if (this.renderer.selectedArtboardId !== null) this.deselectArtboard();
                this.marqueeGroupContext = this.currentGroupContext();
                if (!e.shiftKey) {
                    this.scene.engine!.clear_selection();
                }
                this.dragMode = 'marquee';
                this.marqueeRect = { x: this.startPos.x, y: this.startPos.y, w: 0, h: 0 };
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        } else if (this.ui.activeTool === 'direct') {
            this.handleDirectDown(this.startPos, e.shiftKey, e.altKey);
        } else if (this.ui.activeTool === 'pen') {
            // Snap new anchors to geometry unless Cmd/Ctrl bypasses snapping.
            // The same modifier also suppresses closing on the first anchor, so
            // you can place a point right on top of the start without closing.
            // Skip artboard edges: independent X/Y plate snaps collapse free
            // clicks onto the four corners (worse at low zoom).
            const bypassSnap = e.metaKey || e.ctrlKey;
            if (!bypassSnap) {
                this.snap.begin(this.scene, [], undefined, { skipArtboards: true });
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
                this.snap.end();
            }
            this.handlePenDown(this.startPos, bypassSnap);
        } else if (this.ui.activeTool === 'text') {
            // Landing on existing text EDITS it. Every type tool works this way
            // — click the words, get a caret in them — and without the check
            // this branch created a second text node directly on top of the
            // first: two stacked paragraphs, the older one hidden behind the
            // newer, and no indication that the thing you meant to retype is
            // still there underneath.
            const overText = this.scene.hitTest(this.startPos.x, this.startPos.y);
            if (overText !== undefined && this.scene.getNode(overText)?.geometry?.Text) {
                e.preventDefault();
                this.scene.selectNode(overText, false);
                this.ui.syncWithSelection();
                this.editTextNode(overText);
                return;
            }

            // Create an inline text overlay at the click point, using the same
            // glued/auto-sizing overlay as double-click editing.
            // Suppress the default mousedown focus change: the canvas is
            // focusable (tabindex="-1"), so without this the browser refocuses
            // it right after this handler, blurring — and thus committing and
            // removing — the textarea we're about to focus below.
            e.preventDefault();
            const worldX = this.startPos.x;
            const worldY = this.startPos.y; // overlay box top = click point
            const fontSize = 32;
            // Default wrap column (≈ RCB defaultTextWrapWidthForFontSize): typing
            // soft-wraps instead of growing endlessly sideways.
            const wrapW = Math.max(fontSize * 8, Math.round(fontSize * (400 / 18)));
            // Load the default text font so the overlay preview (CSS) and the
            // committed node (CanvasKit) render the same typeface. Fire-and-forget:
            // the renderer repaints via onFontLoaded once the TTF arrives.
            ensureFontCSS(DEFAULT_TEXT_FONT);
            loadGoogleFontData(DEFAULT_TEXT_FONT);
            this.spawnTextOverlay({
                world: { x: worldX, y: worldY },
                fontSize,
                fontFamily: `${DEFAULT_TEXT_FONT}, sans-serif`,
                lineHeight: 1.2,
                color: '#000',
                value: '',
                placeholder: 'Type text…',
                layoutWidth: wrapW,
                onCommit: (content) => {
                    if (!content.trim()) return; // empty → don't create a node
                    this.scene.saveMoveHistory();
                    // The paragraph renders with its top at (origin.y - fontSize);
                    // offset the origin so the glyphs land where the box was.
                    const id = this.scene.addText(worldX, worldY + fontSize, content, fontSize);
                    // Assign the same family the overlay previewed so the on-canvas
                    // render matches (no extra undo entry — addText already saved one).
                    this.scene.setTextPropertiesNoHistory(id, DEFAULT_TEXT_FONT, 0, 1.2);
                    // wrapW is a max column — only lock layout when text actually wraps.
                    const measure = document.createElement('canvas').getContext('2d');
                    let linePx = 0;
                    if (measure) {
                        measure.font = `400 ${fontSize}px ${DEFAULT_TEXT_FONT}, sans-serif`;
                        for (const line of content.split('\n')) {
                            linePx = Math.max(linePx, measure.measureText(line).width);
                        }
                    }
                    const needsWrap = content.includes('\n') || linePx > wrapW + 0.5;
                    if (needsWrap) {
                        this.renderer.setTextLayoutWidth(id, wrapW);
                    }
                    // Text defaults to a solid black fill and no stroke. The active
                    // fill (often a light shape color) or the engine default (white)
                    // would be invisible against a white artboard; black is the
                    // expected, readable default for text.
                    const style = JSON.parse(this.ui.getCurrentStyle());
                    style.fills = [{ r: 0, g: 0, b: 0, a: 1 }];
                    style.strokes = [];
                    this.scene.setNodeStyleNoHistory(id, JSON.stringify(style));
                    this.scene.engine!.clear_selection();
                    this.scene.selectNode(id, false);
                    this.ui.updateLayerList();
                    this.ui.syncWithSelection();
                    // One-shot: back to Selection like the shape tools, unless
                    // the text tool was locked (double-click) for multiple adds.
                    this.maybeRevertTool();
                },
            });
        } else if (
            this.ui.activeTool === 'rect' ||
            this.ui.activeTool === 'ellipse' ||
            this.ui.activeTool === 'polygon' ||
            this.ui.activeTool === 'star' ||
            this.ui.activeTool === 'artboard'
        ) {
            // Snap the anchor corner unless Cmd/Ctrl bypasses snapping
            this.snap.begin(this.scene, []);
            if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
            }
            this.previewRect = {
                x: this.startPos.x,
                y: this.startPos.y,
                w: 0,
                h: 0,
                tool: this.ui.activeTool,
            };
        } else if (this.ui.activeTool === 'line') {
            // Snap the anchor endpoint unless Cmd/Ctrl bypasses snapping.
            this.snap.begin(this.scene, []);
            if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(
                    this.startPos.x,
                    this.startPos.y,
                    8 / this.renderer.zoom,
                );
                this.startPos = { x: s.x, y: s.y };
            }
            this.previewLine = {
                x1: this.startPos.x,
                y1: this.startPos.y,
                x2: this.startPos.x,
                y2: this.startPos.y,
            };
        } else if (this.ui.activeTool === 'pencil') {
            this.pencilPoints = [{ x: this.startPos.x, y: this.startPos.y }];
        } else if (this.ui.activeTool === 'paint-bucket') {
            // A gradient handle under the cursor is what the press is for —
            // otherwise the click would repaint the region out from under the
            // handles the user was reaching for. ⌘ is excluded too: the handles
            // sit on top of the region they belong to, so an eraser that let
            // them win could not reach the very region it is aimed at.
            const eraseChord = e.metaKey || e.ctrlKey;
            if (!e.altKey && !eraseChord && this.ui.gradientEdit.isActive()) {
                const gHit = this.ui.gradientEdit.hitTest(this.startPos, this.renderer.zoom);
                if (gHit) {
                    if (gHit.type === 'insert') {
                        this.ui.gradientEdit.beginInsertDrag(gHit.t, this.startPos);
                    } else {
                        this.ui.gradientEdit.beginDrag(gHit, this.startPos);
                    }
                    // beginDrag/endDrag bracket the gesture themselves, same
                    // as the node path — don't open a second one.
                    this.gradientDragActive = true;
                    return;
                }
            }
            // ⌥ is the eyedropper, as in Illustrator — it samples rather than
            // paints, so it never reaches handlePaintBucketClick.
            if (e.altKey) {
                this.sampleLivePaintColor(this.startPos, e.shiftKey ? 'stroke' : 'fill');
            } else {
                // ⌘/Ctrl is the one-off eraser: un-paint what's under the
                // cursor without disturbing the colour the bucket is loaded with.
                this.handlePaintBucketClick(this.startPos, e.shiftKey, eraseChord);
            }
        } else if (this.ui.activeTool === 'scissors') {
            this.handleScissorsDown(this.startPos);
        } else if (this.ui.activeTool === 'eyedropper') {
            this.handleEyedropper(this.startPos);
        } else if (this.ui.activeTool === 'mesh') {
            this.handleMeshDown(this.startPos, e);
        }
    }

    /** Mesh tool mousedown. Priority: active-mesh handles/vertices/lines →
     *  convert/activate the clicked node → vertex marquee / deselect. */
    private handleMeshDown(pos: { x: number; y: number }, e: MouseEvent) {
        const me = this.ui.meshEdit;
        if (me.isActive()) {
            const hit = me.hitTest(pos, this.renderer.zoom);
            if (hit) {
                if (e.altKey) {
                    // Alt-click: delete the clicked line, or both lines
                    // through an interior vertex. Boundary targets no-op.
                    if ((hit.type === 'line' || hit.type === 'vertex') && me.deleteAtHit(hit)) {
                        this.ui.syncWithSelection();
                    }
                    return;
                }
                if (hit.type === 'vertex') {
                    // Plain click selects; drag (if it follows) moves. Shift
                    // toggles membership without starting a move of others.
                    this.meshDragActive = true;
                    this.renderer.meshDraftMode = true;
                    me.beginVertexDrag(hit.vi, pos, e.shiftKey);
                    this.ui.syncWithSelection({ interactive: true });
                    this.ui.contextBar?.refresh();
                    return;
                }
                if (hit.type === 'handle') {
                    this.meshDragActive = true;
                    this.renderer.meshDraftMode = true;
                    me.beginHandleDrag(hit.vi, hit.dir, pos);
                    return;
                }
                // Grid line → add the perpendicular line; interior → add both.
                if (me.addLinesAt(hit)) this.ui.syncWithSelection();
                return;
            }
        }
        // Not on the active mesh: a node click converts (or activates) it.
        const nodeId = this.scene.hitTest(pos.x, pos.y);
        if (nodeId !== undefined) {
            const node = this.scene.getNode(nodeId);
            const kind = node?.node_type;
            if (kind === 'Text' || kind === 'Image' || kind === 'Group') return; // unsupported
            const fills = node?.style.fills ?? [];
            this.scene.selectNode(nodeId, false);
            const meshIdx = fills.findIndex((f) => isMeshGradient(f));
            if (meshIdx >= 0) {
                me.activate(nodeId, meshIdx);
                // Resolve the same press against the freshly activated mesh so
                // the first click can already grab a vertex/handle — requiring
                // a second click reads as "clicking does nothing".
                const hit = me.hitTest(pos, this.renderer.zoom);
                if (hit?.type === 'vertex' && !e.altKey) {
                    this.meshDragActive = true;
                    this.renderer.meshDraftMode = true;
                    me.beginVertexDrag(hit.vi, pos, e.shiftKey);
                }
                this.ui.updateLayerList();
                this.ui.syncWithSelection({ interactive: this.meshDragActive });
                return;
            }
            if (fills.length === 0) {
                // Stroke-only shape: select it but don't invent a fill (T7).
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
                return;
            }
            const local = me.worldToLocalForNode(nodeId, pos.x, pos.y);
            me.convertFillToMesh(nodeId, 0, local);
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
            return;
        }
        // Empty canvas: a drag becomes a vertex marquee (when a mesh is
        // active); a plain click is resolved on mouseup (clear vertex
        // selection first, then deselect the node).
        if (me.isActive()) {
            this.meshMarqueeStart = { ...pos };
            this.meshMarqueeAdditive = e.shiftKey;
            return;
        }
        this.scene.engine!.clear_selection();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Mesh tool hover: update controller hover state (drives the overlay's
     *  highlights and ghost insertion lines) and the cursor per target:
     *  vertex = move, line/interior = copy (insert), Alt = delete affordance,
     *  convertible shape = crosshair, unsupported = not-allowed. */
    private updateMeshHover(e: MouseEvent) {
        const me = this.ui.meshEdit;
        const pos = this.currentPos;
        let cursor = 'crosshair';
        let hit: ReturnType<MeshEditController['hitTest']> = null;
        let hoverNode: number | null = null;
        if (me.isActive()) hit = me.hitTest(pos, this.renderer.zoom);
        if (hit) {
            if (hit.type === 'vertex') {
                const mesh = me.mesh();
                cursor =
                    e.altKey && mesh && !me.isBoundaryVertex(mesh, hit.vi)
                        ? 'default' // delete affordance (line highlight turns red)
                        : 'move';
            } else if (hit.type === 'handle') {
                cursor = 'move';
            } else {
                cursor = e.altKey ? (hit.type === 'line' ? 'default' : 'crosshair') : 'copy';
            }
        } else {
            const nodeId = this.scene.hitTest(pos.x, pos.y);
            if (nodeId !== undefined) {
                const node = this.scene.getNode(nodeId);
                const kind = node?.node_type;
                const fills = node?.style.fills ?? [];
                if (kind === 'Text' || kind === 'Image' || kind === 'Group' || fills.length === 0) {
                    cursor = 'not-allowed';
                } else {
                    hoverNode = nodeId; // outline highlight: "click converts me"
                    cursor = 'crosshair';
                }
            }
        }
        const changed =
            JSON.stringify(hit) !== JSON.stringify(me.hover) ||
            me.hoverAlt !== e.altKey ||
            this.hoverNodeId !== hoverNode;
        me.hover = hit;
        me.hoverAlt = e.altKey;
        this.hoverNodeId = hoverNode;
        this.canvas.style.cursor = cursor;
        if (changed) this.renderer.requestRender();
    }

    /** Eyedropper: sample the appearance (fills, strokes, opacity, blend mode,
     *  effects) of the node under the cursor and apply it to the current
     *  selection. With nothing selected, the sampled appearance becomes the
     *  default style for the next-created shape. One-shot back to Selection. */
    private handleEyedropper(pos: { x: number; y: number }) {
        const srcId = this.scene.hitTest(pos.x, pos.y);
        if (srcId === undefined) {
            this.maybeRevertTool();
            return;
        }
        const srcStyle = this.scene.getNodeStyle(srcId);
        const srcEffects = this.scene.getNodeEffects(srcId); // JSON array string
        // The appearance keys the eyedropper transfers — geometry-specific style
        // (corner_radius, fill_rule) stays with the target.
        const appearance = {
            fills: srcStyle?.fills ?? [],
            strokes: srcStyle?.strokes ?? [],
            opacity: srcStyle?.opacity ?? 1,
            blend_mode: srcStyle?.blend_mode ?? 0,
        };

        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) {
            // No target: adopt the sampled appearance as the default style.
            const cur = JSON.parse(this.ui.getCurrentStyle());
            this.ui.setCurrentStyle(JSON.stringify({ ...cur, ...appearance }));
            this.maybeRevertTool();
            return;
        }

        // Apply to every selected node under a single undo step.
        this.scene.pushHistorySnapshot();
        for (const id of selection) {
            const target = this.scene.getNodeStyle(id);
            const merged = { ...target, ...appearance };
            this.scene.setNodeStyleNoHistory(id, JSON.stringify(merged));
            this.scene.setNodeEffectsNoHistory(id, srcEffects);
        }
        this.scene.invalidateCache();
        this.renderer.requestRender();
        this.ui.syncWithSelection();
        this.maybeRevertTool();
    }

    /**
     * @param wantEdge  ⇧-click: target the edge rather than the region.
     * @param erase     Paint nothing — remove what is there. Reached two ways:
     *                  the bucket's colour is set to None (a property, so every
     *                  click erases until it is changed back), or ⌘-click (a
     *                  one-off, leaving the colour alone). Both matter: the
     *                  first is discoverable in the bar, the second is what you
     *                  want when you spot one wrong region mid-paint.
     */
    handlePaintBucketClick(pos: { x: number; y: number }, wantEdge = false, erase = false) {
        if (!this.scene.engine) return;
        const edgeTol = 6 / this.renderer.zoom;
        const eraseEdge = erase || this.ui.isLivePaintStrokeNone();
        const paintEdge = () => {
            const id = this.scene.queryEdgeAt(pos.x, pos.y, edgeTol);
            if (id < 0) return false;
            if (eraseEdge) {
                this.scene.clearEdgePaint(id);
                return true;
            }
            const c = this.ui.getLivePaintStroke();
            this.scene.setEdgePaint(id, c.r, c.g, c.b, c.a, this.ui.getLivePaintStrokeWidth());
            return true;
        };
        // Filling a region is the primary action. Only paint an edge when the
        // user explicitly Shift-clicks — otherwise a click a few px from a boundary
        // would paint a near-invisible line instead of filling the region.
        // (⇧, not ⌥: ⌥ is the eyedropper here, as in Illustrator.)
        if (wantEdge && paintEdge()) return;

        const faceId = this.scene.engine.query_face_at(pos.x, pos.y);
        if (faceId >= 0) {
            if (erase || this.ui.isLivePaintFillNone()) {
                this.scene.clearFaceFill(faceId);
                // Nothing left to edit here — the panel must not keep offering.
                this.ui.setActiveRegion(null);
                // Handles left over from a gradient that no longer exists would
                // be aimable at nothing.
                this.ui.gradientEdit.clear();
                this.ui.syncWithSelection();
                this.renderer.requestRender();
                return;
            }
            // The region you just painted becomes what the panel edits.
            this.ui.setActiveRegion(pos);
            const grad = this.ui.getLivePaintGradient();
            if (grad && this.paintFaceWithGradient(faceId, grad)) {
                // Handles land on the region you just painted, so the gradient
                // can be aimed without hunting for a separate mode. Anchored to
                // the click point, not the face id — ids are regenerated by the
                // rebuild that painting just triggered.
                this.ui.gradientEdit.activateFace(pos);
                // The panel now edits this region's stops — the thing the
                // handles are sitting on — so it has to redraw for them.
                this.ui.syncWithSelection();
                return;
            }
            const c = this.ui.getLivePaintFill();
            this.scene.setFaceFill(faceId, c.r, c.g, c.b, c.a);
            // Painting a region whose apparent divisions come from a shape that
            // is not in the group is the single most confusing thing this tool
            // does: the fill floods past lines that are plainly there. Name it.
            const grp = this.scene.getLivePaintGroup();
            this.livePaintIntruder =
                this.livePaintIntruderOverFace(faceId, grp) ?? this.livePaintIntruderAt(pos, grp);
            this.ui.syncWithSelection();
            this.ui.contextBar?.refresh();
            return;
        }
        // Clicked outside every region (e.g. on the outline itself) → the nearest
        // edge is the sensible target so clicking a lone outline still paints.
        paintEdge();
    }

    /**
     * A shape sitting over the active Live Paint group that is not in it.
     *
     * This is the answer to "there are clearly lines there, why is this one
     * region". A shape outside the group contributes no segments to the network,
     * so its edges divide nothing no matter how plainly they cross what you are
     * looking at — and until now the tool gave no hint of that. The bar names it
     * and offers to add it.
     *
     * Set on a paint click, cleared as soon as one lands somewhere the question
     * does not arise, so it never lingers as a stale accusation.
     */
    livePaintIntruder: number | null = null;

    /**
     * The shape under `pos` that is NOT part of `group`, if any.
     *
     * Deliberately the DEEPEST hit rather than the top-level one: a stray shape
     * is usually a sibling of the group, but it can also sit inside some other
     * group entirely, and what matters is only whether the Live Paint group
     * counts it as a member. Text and images are ignored — they contribute no
     * segments to any surface, so their presence explains nothing.
     */
    livePaintIntruderAt(pos: { x: number; y: number }, group: number): number | null {
        const under = this.scene.hitTest(pos.x, pos.y);
        if (under !== undefined && this.isLivePaintIntruder(under, group)) return under;
        return null;
    }

    /**
     * A shape overlapping `faceId`'s region that is not in `group`.
     *
     * Searching the whole region rather than the point under the cursor is the
     * difference between the hint firing and not: you click in the middle of an
     * area to fill it, not on the line that appears to bound it. The spatial
     * index is queried over the face's own bounds, so this costs a box query
     * against the shapes actually near the region, not a scan of the document.
     */
    livePaintIntruderOverFace(faceId: number, group: number): number | null {
        const b = Array.from(this.scene.engine!.face_bounds(faceId));
        if (b.length !== 4) return null;
        for (const id of this.scene.getVisibleNodes(b[0], b[1], b[2], b[3])) {
            if (this.isLivePaintIntruder(id, group)) return id;
        }
        return null;
    }

    /** A vector shape that is not part of `group`. Text and images are ignored:
     *  they contribute no segments to any surface, so their presence explains
     *  nothing about why a region did not divide. */
    private isLivePaintIntruder(id: number, group: number): boolean {
        if (this.findLivePaintAncestor(id) === group) return false;
        const kind = this.scene.getNode(id)?.node_type;
        return kind === 'Path' || kind === 'Rect' || kind === 'Ellipse';
    }

    /** Add the shape the bar is pointing at into the group being painted. */
    adoptLivePaintIntruder() {
        const id = this.livePaintIntruder;
        const group = this.scene.getLivePaintGroup();
        this.livePaintIntruder = null;
        if (id === null || group < 0) return;
        if (this.scene.getNodeType(id) === undefined) return;
        this.scene.transaction(() => {
            const index = Array.from(this.scene.getNodeChildren(group)).length;
            this.scene.reorderNodes([id], group, index);
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /**
     * Live Paint eyedropper — ⌥-click (⇧⌥-click for the edge colour), the way
     * Illustrator's Live Paint Bucket works. Adopts the colour under the cursor
     * as what the bucket paints with, without leaving paint mode.
     *
     * It reads the rendered pixel, so the thing you point at is the thing you
     * get: a region you already painted, a stop halfway along a gradient, a
     * colour inside a placed image. A node's declared fill answers none of those.
     */
    sampleLivePaintColor(pos: { x: number; y: number }, target: 'fill' | 'stroke') {
        const c = this.renderer.sampleScreenColor(pos.x, pos.y);
        if (!c) return;
        const hex = this.ui.rgbToHex(c);
        if (target === 'stroke') this.ui.setLivePaintStroke(hex);
        else this.ui.setLivePaintFill(hex);
        // The bar carries the only visible record of the paint colour — an
        // action with no feedback is a keypress the user can't trust.
        this.ui.contextBar?.refresh();
    }

    // ─── Keyboard actions for things that previously had none ──────────────
    // Everything below is reachable from the bar or a panel too; these are the
    // chords, kept next to each other so the collisions are visible in one place.

    /** Deselect everything (⇧⌘A). Esc does this eventually, but only after it
     *  has finished a path edit and disarmed the tool — this is the direct one. */
    deselectAll() {
        this.scene.engine!.clear_selection();
        this.renderer.selectedArtboardId = null;
        this.selectedPoints.clear();
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Lock/unlock (⇧⌘L) or show/hide (⇧⌘H) the selection. Mixed selections
     *  resolve one way — if anything is still unlocked, lock everything — so a
     *  second press is always the exact undo of the first. */
    toggleSelectionFlag(flag: 'locked' | 'hidden') {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length === 0) return;
        if (flag === 'locked') {
            const next = sel.some((id) => !this.scene.getNodeLocked(id));
            this.scene.transaction(() => {
                for (const id of sel) this.scene.setNodeLocked(id, next);
            });
        } else {
            const next = sel.some((id) => this.scene.getNodeVisible(id));
            this.scene.transaction(() => {
                for (const id of sel) this.scene.setNodeVisible(id, !next);
            });
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Appearance clipboard for ⌥⌘C / ⌥⌘V — the same set of keys the eyedropper
     *  transfers, so the two can't disagree about what "appearance" means. */
    private appearanceClipboard: {
        fills: unknown[];
        strokes: unknown[];
        opacity: number;
        blend_mode: number;
        effects: string;
    } | null = null;

    /** ⌥⌘C: remember the selection's appearance. */
    copyAppearance() {
        const sel = this.scene.engine!.get_selection();
        if (sel.length === 0) return;
        const style = this.scene.getNodeStyle(sel[0]);
        this.appearanceClipboard = {
            fills: style?.fills ?? [],
            strokes: style?.strokes ?? [],
            opacity: style?.opacity ?? 1,
            blend_mode: style?.blend_mode ?? 0,
            effects: this.scene.getNodeEffects(sel[0]),
        };
    }

    /** ⌥⌘V: apply the remembered appearance to the selection. Geometry-specific
     *  style (corner radius, fill rule) stays with the target. */
    pasteAppearance() {
        const clip = this.appearanceClipboard;
        const sel = Array.from(this.scene.engine!.get_selection());
        if (!clip || sel.length === 0) return;
        const { effects, ...appearance } = clip;
        this.scene.pushHistorySnapshot();
        for (const id of sel) {
            const target = this.scene.getNodeStyle(id);
            this.scene.setNodeStyleNoHistory(id, JSON.stringify({ ...target, ...appearance }));
            this.scene.setNodeEffectsNoHistory(id, effects);
        }
        this.scene.invalidateCache();
        this.renderer.requestRender();
        this.ui.syncWithSelection();
    }

    /** Align the selection (⌥A/D/W/S/H/V, as in Figma). */
    alignSelectionTo(mode: AlignMode) {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length < 2) return;
        alignSelection(this.scene, sel, mode);
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Combine the selection into a non-destructive Boolean Group — the same
     *  thing the Boolean dropdown makes, so the operands stay editable. */
    booleanSelection(op: BoolOp) {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length < 2) return;
        const gid = this.scene.makeBooleanGroup(this.ui.ck, sel, op);
        if (gid < 0) return;
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** The selected Text nodes, or an empty list — the text chords are no-ops
     *  on anything else rather than silently doing something to a shape. */
    private selectedTextNodes(): number[] {
        return Array.from(this.scene.engine!.get_selection()).filter(
            (id) => this.scene.getNode(id)?.node_type === 'Text',
        );
    }

    /** ⇧⌘. / ⇧⌘, — step the font size. Multiplicative, so a step feels the same
     *  at 8pt and at 96pt. */
    adjustTextSize(direction: 1 | -1) {
        const ids = this.selectedTextNodes();
        if (ids.length === 0) return;
        this.scene.transaction(() => {
            for (const id of ids) {
                const t = this.scene.getNode(id)?.geometry?.Text;
                if (!t) continue;
                const size = t.font_size || 16;
                const next = Math.max(1, Math.round(direction > 0 ? size * 1.1 + 1 : size / 1.1));
                this.scene.setTextContent(id, t.content, next);
            }
        });
        this.ui.syncWithSelection();
    }

    /** ⌥← / ⌥→ — tracking (letter-spacing), in world units per press. */
    adjustTextTracking(delta: number) {
        const ids = this.selectedTextNodes();
        if (ids.length === 0) return;
        this.scene.transaction(() => {
            for (const id of ids) {
                const t = this.scene.getNode(id)?.geometry?.Text;
                if (!t) continue;
                this.scene.setTextStyle(
                    id,
                    t.font_weight ?? 400,
                    t.italic ?? false,
                    (t.letter_spacing ?? 0) + delta,
                );
            }
        });
        this.ui.syncWithSelection();
    }

    /** ⌘B / ⌘I — bold and italic. Bold toggles 400↔700 off the FIRST selected
     *  node, so a mixed selection lands on one shared answer rather than each
     *  node flipping to its own opposite. */
    toggleTextStyle(which: 'bold' | 'italic') {
        const ids = this.selectedTextNodes();
        if (ids.length === 0) return;
        const first = this.scene.getNode(ids[0])?.geometry?.Text;
        const bold = (first?.font_weight ?? 400) >= 700;
        const italic = first?.italic ?? false;
        this.scene.transaction(() => {
            for (const id of ids) {
                const t = this.scene.getNode(id)?.geometry?.Text;
                if (!t) continue;
                this.scene.setTextStyle(
                    id,
                    which === 'bold' ? (bold ? 400 : 700) : (t.font_weight ?? 400),
                    which === 'italic' ? !italic : (t.italic ?? false),
                    t.letter_spacing ?? 0,
                );
            }
        });
        this.ui.syncWithSelection();
    }

    /** Digits set opacity, Figma-style: 1–9 is 10–90%, 0 is 100%. Two digits
     *  typed in quick succession read as one number, so "45" is 45% and not
     *  "40% then 50%". */
    private opacityDigits: { text: string; at: number } | null = null;
    static readonly OPACITY_DIGIT_WINDOW_MS = 600;

    typeOpacityDigit(digit: string) {
        if (this.scene.engine!.get_selection().length === 0) return;
        const now = performance.now();
        const prev = this.opacityDigits;
        const chained =
            prev !== null &&
            prev.text.length === 1 &&
            now - prev.at <= InputManager.OPACITY_DIGIT_WINDOW_MS;
        const text = chained ? prev.text + digit : digit;
        this.opacityDigits = { text, at: now };
        // "0" alone is 100%; "05" chains to 5%.
        const pct = text.length === 1 ? (digit === '0' ? 100 : Number(digit) * 10) : Number(text);
        this.ui.setSelectionOpacity(pct / 100);
    }

    /**
     * An eyedropper drawn as a cursor. There is no CSS keyword for one, and the
     * whole point of ⌥ here is that you can SEE it has become a picker before
     * you commit to a click — a modifier with no visible effect is a modifier
     * nobody finds. Hotspot at the tip (bottom-left), like Illustrator's.
     */
    private static readonly EYEDROPPER_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            // White casing under a dark stroke, so it reads on any artwork.
            '<g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M17.5 3.5a2.8 2.8 0 0 1 4 4l-1.6 1.6-4-4z"/>' +
            '<path d="M15 6.5 4.6 16.9 3.2 21.3l4.4-1.4L18 9.5z"/></g>' +
            '<g fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M17.5 3.5a2.8 2.8 0 0 1 4 4l-1.6 1.6-4-4z"/>' +
            '<path d="M15 6.5 4.6 16.9 3.2 21.3l4.4-1.4L18 9.5z"/></g></svg>',
    )}") 2 22, crosshair`;

    /**
     * The bucket with its drip crossed out — what ⌘ turns a click into. Same
     * reasoning as the eyedropper: the modifier has to be visible before you
     * commit, and CSS has no keyword that reads as "remove this paint".
     */
    private static readonly ERASE_CURSOR = `url("data:image/svg+xml;utf8,${encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
            // White casing first, so it reads on dark artwork too.
            '<g fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M11 3.5 4.5 10a1.8 1.8 0 0 0 0 2.5l5 5a1.8 1.8 0 0 0 2.5 0L18.5 11z"/>' +
            '<path d="M5 20.5h14"/></g>' +
            '<g fill="none" stroke="#111" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M11 3.5 4.5 10a1.8 1.8 0 0 0 0 2.5l5 5a1.8 1.8 0 0 0 2.5 0L18.5 11z"/>' +
            '<path d="M5 20.5h14"/></g>' +
            // The strike-through says "remove", in the same red the None swatch uses.
            '<path d="M3 21 21 3" stroke="#fff" stroke-width="4" stroke-linecap="round"/>' +
            '<path d="M3 21 21 3" stroke="#e5484d" stroke-width="2.2" stroke-linecap="round"/></svg>',
    )}") 4 4, crosshair`;

    /**
     * Hover feedback for the Selection tool: which node a click would take, and
     * what it would do to it.
     *
     * `deep` (⌘) is passed to the HIT TEST, not just the cursor. It was missing
     * from the hover entirely, so ⌘-hover highlighted the group while ⌘-click
     * selected the shape inside it — the highlight promised the wrong target,
     * the same way the bucket's ⌥-hover used to highlight an edge it was no
     * longer going to paint.
     */
    updateSelectionHover(alt: boolean, deep: boolean) {
        const hitId = this.getTargetIdForHit(this.currentPos, deep);
        if (this.hoverNodeId !== (hitId ?? null)) {
            this.hoverNodeId = hitId ?? null;
            this.renderer.requestRender();
        }
        if (hitId === undefined) {
            this.canvas.style.cursor = 'default';
            return;
        }
        // ⌥ duplicates, ⌘ reaches inside the group, plain drag moves. Three
        // different outcomes from the same press, so three different cursors.
        this.canvas.style.cursor = alt ? 'copy' : deep ? 'pointer' : 'move';
    }

    /**
     * Hover feedback for the Live Paint bucket, and the one place that decides
     * what a click is about to do. Split out of `onMouseMove` because a modifier
     * has to change the cursor the moment it is PRESSED — the user holds it with
     * the mouse still, and a hover that only updates on movement looks broken.
     *
     * Mirrors the click exactly: ⌥ samples, ⌘ erases, ⇧ paints the edge,
     * otherwise fill. Every branch that changes what the click does also changes
     * what you see, which is the whole contract of this method.
     */
    updatePaintBucketHover(alt: boolean, shift: boolean, erase = false) {
        const prevEdge = this.renderer.hoverEdgeId;
        const prevFace = this.renderer.hoverFaceId;
        // A gradient handle under the cursor takes the frame: show it as
        // grabbable and drop the region tint, because the click will move the
        // handle rather than repaint anything. ⌘ is excluded for the same reason
        // the click path excludes it — the handles sit on top of the region the
        // eraser is aimed at.
        if (!alt && !erase && this.ui.gradientEdit.isActive()) {
            const gHit = this.ui.gradientEdit.hitTest(this.currentPos, this.renderer.zoom);
            if (gHit) {
                this.renderer.hoverEdgeId = -1;
                this.renderer.hoverFaceId = -1;
                this.canvas.style.cursor = gHit.type === 'insert' ? 'copy' : 'grab';
                if (prevEdge !== -1 || prevFace !== -1) this.renderer.requestRender();
                return;
            }
        }
        if (alt) {
            // About to sample, not paint — drop both highlights. Leaving the
            // blue region tint up would promise a fill that isn't coming.
            this.renderer.hoverEdgeId = -1;
            this.renderer.hoverFaceId = -1;
            this.canvas.style.cursor = InputManager.EYEDROPPER_CURSOR;
            if (prevEdge !== -1 || prevFace !== -1) this.renderer.requestRender();
            return;
        }
        const edgeTol = 6 / this.renderer.zoom;
        const faceId = this.scene.engine!.query_face_at(this.currentPos.x, this.currentPos.y);
        // ⌘ (or a bucket loaded with None) removes rather than paints. Same
        // targeting as a normal click, so the highlight still shows WHICH region
        // or line is about to change — only the cursor says it will be emptied.
        const removing =
            erase || (shift ? this.ui.isLivePaintStrokeNone() : this.ui.isLivePaintFillNone());
        if (shift || faceId < 0) {
            // Edge mode (⇧), or outside any region → preview the edge.
            const edgeId = this.scene.queryEdgeAt(this.currentPos.x, this.currentPos.y, edgeTol);
            this.renderer.hoverEdgeId = edgeId;
            this.renderer.hoverFaceId = shift ? -1 : faceId;
            this.canvas.style.cursor =
                edgeId >= 0
                    ? removing
                        ? InputManager.ERASE_CURSOR
                        : this.ui.cursorForTool('paint-bucket')
                    : 'default';
        } else {
            this.renderer.hoverEdgeId = -1;
            this.renderer.hoverFaceId = faceId;
            this.canvas.style.cursor = removing
                ? InputManager.ERASE_CURSOR
                : this.ui.cursorForTool('paint-bucket');
        }
        if (
            this.renderer.hoverEdgeId !== prevEdge ||
            this.renderer.hoverFaceId !== prevFace
        ) {
            this.renderer.requestRender();
        }
    }

    /**
     * Paint one region with a gradient, fitted to that region.
     *
     * The bucket's gradient is stored in UNIT space (0..1 across the region) and
     * mapped onto each face's bounding box as it is painted. That is what makes
     * one gradient usable as a *tool*: click five differently-sized regions and
     * each gets the gradient across its own extent, instead of one gradient
     * anchored to whichever region happened to be painted first.
     *
     * Returns false if the face has no measurable box, so the caller can fall
     * back to a solid rather than paint nothing.
     */
    private paintFaceWithGradient(faceId: number, grad: Gradient): boolean {
        const outline = this.scene.getFaceOutline(faceId);
        if (!outline || outline.length < 3) return false;
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        // Control points too: a region bounded by outward curves reaches past
        // its anchors, and a box drawn from anchors alone would crop the
        // gradient short of the edge.
        for (const p of outline) {
            for (const [x, y] of [[p.x, p.y], p.cp1, p.cp2] as [number, number][]) {
                if (x < minX) minX = x;
                if (y < minY) minY = y;
                if (x > maxX) maxX = x;
                if (y > maxY) maxY = y;
            }
        }
        const w = maxX - minX;
        const h = maxY - minY;
        if (!(w > 0) || !(h > 0)) return false;
        // Unit → world. Face outlines carry no transform, so this is final.
        const placed: Gradient = {
            ...structuredClone(grad),
            start_x: minX + grad.start_x * w,
            start_y: minY + grad.start_y * h,
            end_x: minX + grad.end_x * w,
            end_y: minY + grad.end_y * h,
        };
        return this.scene.setFacePaint(faceId, placed);
    }

    /** Current default stroke width from the active style (fallback 2). */
    handleDirectDown(pos: { x: number; y: number }, isShift: boolean, isAlt = false) {
        // First: if we're already editing a node, check if clicking on one of its points/handles
        if (this.editingNodeId !== null && this.editingPoints) {
            const hitInfo = this.findNearestHandle(pos);
            if (hitInfo) {
                const pointKey = `${hitInfo.subpathIndex}:${hitInfo.index}`;

                // Alt / convertPointMode on an anchor is the "convert anchor point"
                // gesture: drag pulls out symmetric handles (corner→smooth); a
                // zero-distance click collapses them (smooth→corner) or, for a
                // corner, auto-smooths from neighbors (Figma Convert Point).
                // Alt on a *handle* falls through to the normal path below where
                // it breaks the tangent during the drag.
                if ((isAlt || this.convertPointMode) && hitInfo.type === 'anchor') {
                    this.selectedPoints.clear();
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                    this.draggingSubpathIndex = hitInfo.subpathIndex;
                    this.draggingPointIndex = hitInfo.index;
                    // Pull the outgoing handle; the incoming one mirrors it.
                    this.draggingHandleType = 'cp2';
                    this.convertingAnchor = true;
                    this.beginPointDrag();
                    this.ui.contextBar?.refresh();
                    return;
                }

                if (hitInfo.type === 'anchor') {
                    if (isShift) {
                        if (this.selectedPoints.has(pointKey)) {
                            this.selectedPoints.delete(pointKey);
                        } else {
                            this.selectedPoints.add(pointKey);
                            this.selectedAnchorSubpath = hitInfo.subpathIndex;
                            this.selectedAnchorIndex = hitInfo.index;
                        }
                    } else {
                        if (!this.selectedPoints.has(pointKey)) {
                            this.selectedPoints.clear();
                            this.selectedPoints.add(pointKey);
                        }
                        this.selectedAnchorSubpath = hitInfo.subpathIndex;
                        this.selectedAnchorIndex = hitInfo.index;
                    }
                } else {
                    // Control point clicked: usually deselects others unless it's the current point's handles
                    if (!isShift) this.selectedPoints.clear();
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                }

                this.draggingSubpathIndex = hitInfo.subpathIndex;
                this.draggingPointIndex = hitInfo.index;
                this.draggingHandleType = hitInfo.type;
                this.beginPointDrag();
                this.ui.contextBar?.refresh();
                return;
            }

            // Mid-edge squares (N/E/S/W on a rect) — always clickable to insert
            // (Figma-style). Add-point mode also accepts anywhere on a segment.
            if (this.addPointMode) {
                if (this.handleAddPointClick(pos)) return;
            } else if (this.handleMidEdgeAddClick(pos)) {
                return;
            }

            // Clicked empty space in edit mode — start marquee for points.
            if (!isShift) {
                this.selectedPoints.clear();
                this.selectedAnchorSubpath = -1;
                this.selectedAnchorIndex = -1;
                this.ui.contextBar?.refresh();
            }

            // Stay committed to the shape we're editing: a single click that
            // happens to land on (or overlap) another object no longer jumps
            // the selection to it — that stray-switch was the annoying part.
            // To edit a different object, double-click it (onDoubleClick enters
            // node-editing directly) or press Esc first. Here we only ever
            // deselect points and start a point-marquee.
            this.dragMode = 'marquee'; // Reuse marquee mode, will handle in onMouseMove
            this.marqueeRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
            return;
        }

        // Not in edit mode yet: hit test to find a node
        const hitId = this.scene.hitTest(pos.x, pos.y);
        if (hitId !== undefined) {
            this.scene.selectNode(hitId, isShift);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();

            // Enter edit mode — converts to path if needed
            this.enterPathEditMode(hitId);

            // Check if click is on a point we just loaded
            if (this.editingPoints) {
                const hitInfo = this.findNearestHandle(pos);
                if (hitInfo) {
                    this.draggingSubpathIndex = hitInfo.subpathIndex;
                    this.draggingPointIndex = hitInfo.index;
                    this.draggingHandleType = hitInfo.type;
                    const pointKey = `${hitInfo.subpathIndex}:${hitInfo.index}`;
                    this.selectedPoints.add(pointKey);
                    this.selectedAnchorSubpath = hitInfo.subpathIndex;
                    this.selectedAnchorIndex = hitInfo.index;
                    this.beginPointDrag();
                    this.ui.contextBar?.refresh();
                }
            }
        } else {
            // Clicked empty space outside any node — deselect everything and exit edit mode
            if (!isShift) {
                this.exitEditMode();
                this.scene.engine!.clear_selection();
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
            }
        }
    }

    findNearestHandle(pos: {
        x: number;
        y: number;
    }): { subpathIndex: number; index: number; type: 'anchor' | 'cp1' | 'cp2' } | null {
        if (!this.editingPoints || !this.editingTransform) return null;
        const threshold = 8 / this.renderer.zoom;
        const t = this.editingTransform;

        for (let si = 0; si < this.editingPoints.length; si++) {
            const sp = this.editingPoints[si];
            for (let i = 0; i < sp.points.length; i++) {
                const p = sp.points[i];
                // Transform local point to world
                const wx = t[0] * p.x + t[1] * p.y + t[2];
                const wy = t[3] * p.x + t[4] * p.y + t[5];
                if (Math.hypot(pos.x - wx, pos.y - wy) < threshold) {
                    return { subpathIndex: si, index: i, type: 'anchor' };
                }
                // Check cp1
                const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
                const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
                if (Math.hypot(pos.x - c1x, pos.y - c1y) < threshold) {
                    return { subpathIndex: si, index: i, type: 'cp1' };
                }
                // Check cp2
                const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
                const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];
                if (Math.hypot(pos.x - c2x, pos.y - c2y) < threshold) {
                    return { subpathIndex: si, index: i, type: 'cp2' };
                }
            }
        }
        return null;
    }

    /** Convert world coords to node-local coords using the inverted transform. */
    worldToLocal(wx: number, wy: number): { x: number; y: number } {
        const t = this.editingTransform!;
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

    /**
     * Convert a world-space delta vector into a node's parent local space.
     * move_node applies dx/dy directly to the node's local transform, so we
     * need to compensate for the parent group's cumulative transform (scale,
     * rotation, skew). Without this, dragging a deeply nested element makes
     * it lag behind the cursor because the world-space delta is larger/smaller
     * than the local-space delta.
     *
     * For a delta *vector* (not a point) we only invert the linear part (2×2
     * upper-left of the 3×3 matrix), ignoring translation.
     */
    /** A world-space size in the node's own geometry space. Groups are excluded
     *  by their caller — the engine sizes those in world units. */
    private worldSizeToLocal(id: number, w: number, h: number): { w: number; h: number } {
        return this.scene.worldSizeToLocal(id, w, h);
    }

    worldDeltaToLocal(nodeId: number, wdx: number, wdy: number): { dx: number; dy: number } {
        return this.scene.worldDeltaToLocal(nodeId, wdx, wdy);
    }

    /** Flip every selected node in place (⇧H / ⇧V and the context bar flip buttons). */
    flipSelection(axis: 'h' | 'v') {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        // One gesture, one undo step. Unwrapped, each flipNode* pushed its own
        // history state, so flipping a large selection could push more states
        // than the 50 the stack holds — taking the user's real work off the
        // bottom of it and leaving ⌘Z to walk back through a half-flipped
        // drawing one shape at a time.
        this.scene.transaction(() => {
            for (const id of selection) {
                if (axis === 'h') this.scene.flipNodeH(id);
                else this.scene.flipNodeV(id);
            }
        });
        this.scene.invalidateCache();
        this.ui.syncWithSelection();
    }

    /** Enter (⏎): drill into a group, or open the type-appropriate edit mode. */
    enterSelectedNode(id: number) {
        const node = this.scene.getNode(id);
        if (!node) return;
        switch (node.node_type) {
            case 'Group': {
                const children = Array.from(this.scene.getNodeChildren(id));
                if (children.length > 0) {
                    this.enteredGroup = id;
                    this.scene.selectNode(children[0], false);
                    this.ui.syncWithSelection();
                    // Same as the double-click above: this is the shared "go
                    // inside" verb, reached by Enter, the context bar's Edit
                    // button and the breadcrumb, and they should all leave the
                    // panel showing where you now are.
                    this.ui.revealSelection();
                }
                break;
            }
            case 'Text':
                this.editTextNode(id);
                break;
            case 'Rect':
            case 'Ellipse':
            case 'Path':
                this.ui.setActiveTool('direct');
                this.enterPathEditMode(id);
                break;
        }
    }

    duplicateSelection() {
        // A selected artwork duplicates as a frame + its contents.
        if (this.renderer.selectedArtboardId !== null) {
            this.duplicateSelectedArtboard();
            return;
        }
        // Duplicate back-to-front so the copies keep the originals' stacking.
        const selection = this.scene.sortByPaintOrder(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        this.scene.transaction(() => {
            this.scene.engine!.clear_selection();
            for (const id of selection) {
                const newId = this.scene.duplicateNode(id);
                this.keepCopyBesideOriginal(newId, id);
                // Duplicated groups start collapsed so a large copy doesn't
                // flood the Objects panel with expanded descendants.
                this.ui.collapseSubtreeByDefault(newId);
                this.scene.selectNode(newId, true);
            }
        });
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Put a copy where its original lives — see WasmScene.fileCopyBesideOriginal.
     *  MUST run inside the caller's transaction (⌘D) or gesture (a clone-drag). */
    private keepCopyBesideOriginal(copyId: number, originalId: number) {
        this.scene.fileCopyBesideOriginal(copyId, originalId);
    }

    /**
     * Step the selection through the z-order, or send it all the way.
     *
     * Order matters twice over. Nodes are moved one at a time, so a selection
     * stepped FORWARD has to be walked front-to-back or each move undoes the
     * last one — pressing ] with two neighbours selected shuffled them past
     * each other and left the stack exactly as it was, which read as the key
     * doing nothing at all. And a member whose neighbour in the direction of
     * travel is also selected does not move: the selection travels as a block,
     * keeping its own stacking, rather than collapsing into a pile.
     */
    private restack(direction: 'forward' | 'backward', allTheWay: boolean) {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        const chosen = new Set(selection);
        const backToFront = this.scene.sortByPaintOrder(selection);
        const forward = direction === 'forward';
        // Stepping: walk toward the direction of travel. Going all the way:
        // walk the other way, so the last one moved is the one that ends up
        // outermost and the selection keeps its own stacking.
        const stepOrder = forward ? [...backToFront].reverse() : backToFront;
        const jumpOrder = forward ? backToFront : [...backToFront].reverse();
        // One gesture, one undo step: each reorder wrapper pushes its own
        // history state, so restacking a large selection used to push one per
        // shape and could overflow the 50-deep stack on its own.
        this.scene.transaction(() => {
            for (const id of allTheWay ? jumpOrder : stepOrder) {
                if (allTheWay) {
                    if (forward) this.scene.bringToFront(id);
                    else this.scene.sendToBack(id);
                    continue;
                }
                const parent = this.scene.getNodeParent(id);
                const sibs = Array.from(
                    parent === -1 ? this.scene.getRootNodes() : this.scene.getNodeChildren(parent),
                );
                const idx = sibs.indexOf(id);
                const neighbour = forward ? sibs[idx + 1] : sibs[idx - 1];
                if (neighbour !== undefined && chosen.has(neighbour)) continue;
                if (forward) this.scene.bringForward(id);
                else this.scene.sendBackward(id);
            }
        });
        this.ui.updateLayerList();
    }

    deleteSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return;
        // If the deleted node was the editing node, exit edit mode first
        if (this.editingNodeId !== null && selection.includes(this.editingNodeId)) {
            this.exitEditMode();
        }
        this.scene.engine!.clear_selection();
        this.scene.removeNodes(selection);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    // ─── Path Operations ─────────────────────────────────────────────

    /**
     * Find the closest scissors cut target across every visible path node near
     * `pos`, or `null` if nothing is within the catch radius.
     *
     * Unlike a fill/stroke hit test, this snaps to the path *outline* directly:
     * candidate nodes are gathered from the spatial index by a threshold-sized
     * box around the cursor, then each is measured with the full catch radius.
     * An existing anchor wins over a segment point at (near-)equal distance so
     * clicking on a vertex splits there. Both the hover preview and the click
     * handler use this, so the previewed dot always matches where the cut lands.
     */
    findScissorTarget(pos: { x: number; y: number }): ScissorTarget | null {
        if (!this.scene.engine) return null;
        const threshold = 10 / this.renderer.zoom;

        const ids = this.scene.getVisibleNodes(
            pos.x - threshold,
            pos.y - threshold,
            pos.x + threshold,
            pos.y + threshold,
        );

        let best: ScissorTarget | null = null;

        for (const id of ids) {
            // Locked artwork is inert — the scissors must not cut it either.
            if (this.scene.isLockedInTree(id)) continue;
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) continue;
            const subpaths = geo.Path.subpaths;
            const transform = this.scene.getTransform(id);

            // Prefer snapping to an existing anchor within the catch radius.
            for (let si = 0; si < subpaths.length; si++) {
                const sp = subpaths[si];
                for (let pi = 0; pi < sp.points.length; pi++) {
                    const p = sp.points[pi];
                    const wx = transform[0] * p.x + transform[1] * p.y + transform[2];
                    const wy = transform[3] * p.x + transform[4] * p.y + transform[5];
                    const d = Math.hypot(pos.x - wx, pos.y - wy);
                    if (d < threshold && (!best || d < best.distance)) {
                        best = {
                            nodeId: id,
                            subpaths,
                            anchor: { subpathIndex: si, pointIndex: pi },
                            worldX: wx,
                            worldY: wy,
                            distance: d,
                        };
                    }
                }
            }

            // Otherwise fall back to the nearest point along a segment. Uses a
            // strict `<` so an equidistant anchor (checked above) keeps priority.
            const segHit = findNearestSegment(subpaths, transform, pos.x, pos.y, threshold);
            if (segHit && (!best || segHit.distance < best.distance)) {
                best = {
                    nodeId: id,
                    subpaths,
                    segment: segHit,
                    worldX: segHit.worldX,
                    worldY: segHit.worldY,
                    distance: segHit.distance,
                };
            }
        }

        return best;
    }

    /** Apply a resolved scissors cut, pushing an undo snapshot and refreshing UI. */
    private applyScissorCut(target: ScissorTarget) {
        // No snapshot here: the cut is computed on a COPY and lands through
        // updatePathPoints, which pushes the pre-cut state itself. Doing both
        // pushed the same state twice, so the first ⌘Z after a cut did nothing
        // visible and the second one undid it.
        const newSubpaths = target.anchor
            ? splitPathAtPoint(
                  target.subpaths,
                  target.anchor.subpathIndex,
                  target.anchor.pointIndex,
              )
            : splitPathAtSegment(
                  target.subpaths,
                  target.segment!.subpathIndex,
                  target.segment!.segmentIndex,
                  target.segment!.t,
              );
        this.scene.updatePathPoints(target.nodeId, JSON.stringify(newSubpaths));
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Handle scissors tool click — cut path at segment or anchor. */
    handleScissorsDown(pos: { x: number; y: number }) {
        if (!this.scene.engine) return;

        // Primary path: cut the nearest outline of any visible path node.
        const target = this.findScissorTarget(pos);
        if (target) {
            this.applyScissorCut(target);
            return;
        }

        // Fallback: a primitive (rect/ellipse/…) under the cursor has no editable
        // subpaths yet — convert it to a path, then cut its nearest segment.
        const hitId = this.scene.hitTest(pos.x, pos.y);
        if (hitId === undefined) return;
        if (!this.scene.getNodeGeometry(hitId)?.Path) {
            this.scene.convertToPath(hitId);
        }
        const geo = this.scene.getNodeGeometry(hitId);
        if (!geo?.Path) return;

        const subpaths = geo.Path.subpaths;
        const transform = this.scene.getTransform(hitId);
        const threshold = 10 / this.renderer.zoom;
        const segHit = findNearestSegment(subpaths, transform, pos.x, pos.y, threshold);
        if (segHit) {
            this.applyScissorCut({
                nodeId: hitId,
                subpaths,
                segment: segHit,
                worldX: segHit.worldX,
                worldY: segHit.worldY,
                distance: segHit.distance,
            });
        }
    }

    /** Handle click in path-edit mode when Add Point mode is active. */
    handleAddPointClick(pos: { x: number; y: number }): boolean {
        if (!this.editingNodeId || !this.editingPoints || !this.editingTransform) return false;

        const threshold = 10 / this.renderer.zoom;
        const segHit = findNearestSegment(
            this.editingPoints,
            this.editingTransform,
            pos.x,
            pos.y,
            threshold,
        );
        if (!segHit) return false;

        const newSubpaths = addAnchorPoint(
            this.editingPoints,
            segHit.subpathIndex,
            segHit.segmentIndex,
            segHit.t,
        );

        // Update engine and local editing state. updatePathPoints pushes the
        // pre-edit state itself — a second snapshot here would only add a
        // silent ⌘Z step.
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(newSubpaths));
        this.editingPoints = newSubpaths;
        this.addPointMode = false;
        this.ui.contextBar?.refresh();
        return true;
    }

    /**
     * Mid-edge add-point squares drawn in path-edit (N/E/S/W on a rect path).
     * Hit the same linear midpoints the renderer paints — insert at t=0.5.
     */
    findNearestMidEdge(pos: {
        x: number;
        y: number;
    }): { subpathIndex: number; segmentIndex: number } | null {
        if (!this.editingPoints || !this.editingTransform) return null;
        const threshold = 8 / this.renderer.zoom;
        const t = this.editingTransform;
        let best: { subpathIndex: number; segmentIndex: number } | null = null;
        let bestDist = threshold;
        for (let si = 0; si < this.editingPoints.length; si++) {
            const sp = this.editingPoints[si];
            const n = sp.points.length;
            const segCount = sp.closed ? n : Math.max(0, n - 1);
            for (let i = 0; i < segCount; i++) {
                const p1 = sp.points[i];
                const p2 = sp.points[(i + 1) % n];
                const mx =
                    (t[0] * (p1.x + p2.x) + t[1] * (p1.y + p2.y)) * 0.5 + t[2];
                const my =
                    (t[3] * (p1.x + p2.x) + t[4] * (p1.y + p2.y)) * 0.5 + t[5];
                const d = Math.hypot(pos.x - mx, pos.y - my);
                if (d < bestDist) {
                    bestDist = d;
                    best = { subpathIndex: si, segmentIndex: i };
                }
            }
        }
        return best;
    }

    /** Insert an anchor at a mid-edge affordance (path-edit, no add-point mode). */
    handleMidEdgeAddClick(pos: { x: number; y: number }): boolean {
        if (!this.editingNodeId || !this.editingPoints) return false;
        const hit = this.findNearestMidEdge(pos);
        if (!hit) return false;
        const newSubpaths = addAnchorPoint(
            this.editingPoints,
            hit.subpathIndex,
            hit.segmentIndex,
            0.5,
        );
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(newSubpaths));
        this.editingPoints = newSubpaths;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /** Delete the currently selected anchor points in path editing mode. */
    /**
     * Move every selected vertex by a WORLD-space delta, handles included.
     *
     * The delta is mapped through the inverse of the node's linear transform —
     * translation is irrelevant to a direction — so a 1px arrow press moves the
     * point 1px on screen no matter how the node is scaled, rotated or skewed.
     * One history step per call, matching the mesh tool's per-press undo.
     */
    private nudgeSelectedPoints(dx: number, dy: number): boolean {
        if (this.editingNodeId === null || !this.editingPoints) return false;
        if (this.selectedPoints.size === 0) return false;

        const t = this.scene.getTransform(this.editingNodeId);
        const det = t[0] * t[4] - t[1] * t[3];
        if (Math.abs(det) < 1e-10) return false; // degenerate — nothing sensible to do

        const ldx = (t[4] * dx - t[1] * dy) / det;
        const ldy = (t[0] * dy - t[3] * dx) / det;

        let moved = false;
        for (const key of this.selectedPoints) {
            const [si, pi] = key.split(':').map(Number);
            const pt = this.editingPoints[si]?.points[pi];
            if (!pt) continue;
            pt.x += ldx;
            pt.y += ldy;
            pt.cp1[0] += ldx;
            pt.cp1[1] += ldy;
            pt.cp2[0] += ldx;
            pt.cp2[1] += ldy;
            moved = true;
        }
        if (!moved) return false;

        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(this.editingPoints));
        this.renderer.requestRender();
        return true;
    }

    deleteSelectedPoints() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size === 0) return;

        const currentSubpaths = JSON.parse(JSON.stringify(this.editingPoints));

        // Group points by subpath to delete efficiently
        const grouped = new Map<number, number[]>();
        for (const key of this.selectedPoints) {
            const [si, pi] = key.split(':').map(Number);
            if (!grouped.has(si)) grouped.set(si, []);
            grouped.get(si)!.push(pi);
        }

        // Sort subpaths in descending order to avoid index shifts if subpaths are removed
        const sortedSubpathIndices = Array.from(grouped.keys()).sort((a, b) => b - a);

        for (const si of sortedSubpathIndices) {
            const pointIndices = grouped.get(si)!.sort((a, b) => b - a);
            const sp = currentSubpaths[si];
            for (const pi of pointIndices) {
                sp.points.splice(pi, 1);
            }
            // If too few points remain, remove the entire subpath
            if (sp.points.length < 2) {
                currentSubpaths.splice(si, 1);
            }
        }

        if (currentSubpaths.length === 0) {
            // Deleted all points — remove the node
            this.scene.removeNodes([this.editingNodeId]);
            this.editingNodeId = null;
            this.editingPoints = null;
            this.selectedPoints.clear();
        } else {
            // One press, one undo step: updatePathPoints snapshots the path as
            // it stands (the deletion was computed on a copy).
            this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(currentSubpaths));
            this.editingPoints = currentSubpaths;
            this.selectedPoints.clear();
            this.selectedAnchorSubpath = -1;
            this.selectedAnchorIndex = -1;
            this.draggingHandleType = null;
            this.ui.contextBar?.refresh();
        }

        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Merge (weld) the selected anchor points in path editing mode. */
    mergeSelectedPoints() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size < 2) return;

        const selected = Array.from(this.selectedPoints).map((key) => {
            const [subpathIdx, pointIdx] = key.split(':').map(Number);
            return { subpathIdx, pointIdx };
        });

        const merged = mergeSelectedAnchors(this.editingPoints, selected);
        if (!merged) return; // nothing mergeable (non-adjacent interior points)

        // updatePathPoints pushes the undo snapshot itself
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(merged));
        this.editingPoints = merged;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.draggingHandleType = null;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
    }

    /**
     * Average the selected anchors onto a common line (Illustrator's Object ›
     * Path › Average). `h` = align to the average Y (horizontal line), `v` = the
     * average X (vertical line), `both` = collapse to the centroid. Handles move
     * with their anchor so curvature is preserved. One undo step.
     */
    averageSelectedPoints(axis: 'h' | 'v' | 'both') {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size < 2) return;
        const sel = Array.from(this.selectedPoints).map((key) => {
            const [subpathIdx, pointIdx] = key.split(':').map(Number);
            return { subpathIdx, pointIdx };
        });

        let sumX = 0;
        let sumY = 0;
        for (const { subpathIdx, pointIdx } of sel) {
            const p = this.editingPoints[subpathIdx].points[pointIdx];
            sumX += p.x;
            sumY += p.y;
        }
        const avgX = sumX / sel.length;
        const avgY = sumY / sel.length;

        const next: Subpath[] = JSON.parse(JSON.stringify(this.editingPoints));
        for (const { subpathIdx, pointIdx } of sel) {
            const p = next[subpathIdx].points[pointIdx];
            const dx = axis !== 'h' ? avgX - p.x : 0;
            const dy = axis !== 'v' ? avgY - p.y : 0;
            p.x += dx;
            p.y += dy;
            p.cp1[0] += dx;
            p.cp1[1] += dy;
            p.cp2[0] += dx;
            p.cp2[1] += dy;
        }
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(next));
        this.editingPoints = next;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** True if any selected anchor still carries a Bézier handle (a control
     *  point not coincident with its anchor). Drives whether "Make Corner" is
     *  offered/enabled. */
    selectedPointsHaveHandles(): boolean {
        if (this.editingNodeId === null || !this.editingPoints) return false;
        for (const key of this.selectedPoints) {
            const [si, pi] = key.split(':').map(Number);
            const p = this.editingPoints[si]?.points[pi];
            if (!p) continue;
            if (p.cp1[0] !== p.x || p.cp1[1] !== p.y || p.cp2[0] !== p.x || p.cp2[1] !== p.y) {
                return true;
            }
        }
        return false;
    }

    /** Retract the Bézier handles of every selected anchor, turning each into a
     *  plain corner point (its adjoining segments straighten). This is the
     *  multi-select, discoverable version of the ⌥-click-to-collapse gesture. */
    makeSelectedPointsCorner() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size === 0) return;

        const next: Subpath[] = JSON.parse(JSON.stringify(this.editingPoints));
        let changed = false;
        for (const key of this.selectedPoints) {
            const [si, pi] = key.split(':').map(Number);
            const p = next[si]?.points[pi];
            if (!p) continue;
            if (p.cp1[0] !== p.x || p.cp1[1] !== p.y || p.cp2[0] !== p.x || p.cp2[1] !== p.y) {
                p.cp1[0] = p.x;
                p.cp1[1] = p.y;
                p.cp2[0] = p.x;
                p.cp2[1] = p.y;
                changed = true;
            }
        }
        if (!changed) return; // already corners — no history churn

        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(next));
        this.editingPoints = next;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /**
     * Figma-style Convert Point click on a corner: place smooth handles along
     * the neighbor tangent (⅓ of adjacent segment lengths). Mutates `sp` in place.
     */
    private autoSmoothAnchorInPlace(
        sp: Subpath,
        index: number,
        closed: boolean
    ) {
        const pts = sp.points;
        const n = pts.length;
        if (n < 2 || index < 0 || index >= n) return;
        const p = pts[index];
        const prevI = index - 1;
        const nextI = index + 1;
        const hasPrev = prevI >= 0 || closed;
        const hasNext = nextI < n || closed;
        if (!hasPrev && !hasNext) return;

        const prev = hasPrev ? pts[(index - 1 + n) % n] : null;
        const next = hasNext ? pts[(index + 1) % n] : null;

        let tx = 0;
        let ty = 0;
        if (prev && next) {
            tx = next.x - prev.x;
            ty = next.y - prev.y;
        } else if (next) {
            tx = next.x - p.x;
            ty = next.y - p.y;
        } else if (prev) {
            tx = p.x - prev.x;
            ty = p.y - prev.y;
        }
        const tLen = Math.hypot(tx, ty);
        if (tLen < 1e-6) return;
        const ux = tx / tLen;
        const uy = ty / tLen;
        const dIn = prev ? Math.hypot(p.x - prev.x, p.y - prev.y) / 3 : 0;
        const dOut = next ? Math.hypot(next.x - p.x, next.y - p.y) / 3 : 0;
        if (prev) {
            p.cp1[0] = p.x - ux * dIn;
            p.cp1[1] = p.y - uy * dIn;
        } else {
            p.cp1[0] = p.x;
            p.cp1[1] = p.y;
        }
        if (next) {
            p.cp2[0] = p.x + ux * dOut;
            p.cp2[1] = p.y + uy * dOut;
        } else {
            p.cp2[0] = p.x;
            p.cp2[1] = p.y;
        }
    }

    /** Scissors without aiming: split the edited path at the single selected
     *  anchor. Same operation as a scissors-tool click on that anchor. */
    cutAtSelectedPoint() {
        if (this.editingNodeId === null || !this.editingPoints) return;
        if (this.selectedPoints.size !== 1) return;

        const [si, pi] = Array.from(this.selectedPoints)[0].split(':').map(Number);

        const newSubpaths = splitPathAtPoint(this.editingPoints, si, pi);
        this.scene.updatePathPoints(this.editingNodeId, JSON.stringify(newSubpaths));
        this.editingPoints = newSubpaths;
        this.selectedPoints.clear();
        this.selectedAnchorSubpath = -1;
        this.selectedAnchorIndex = -1;
        this.draggingHandleType = null;
        this.ui.contextBar?.refresh();
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
    }

    /** Join two selected path nodes by connecting their nearest endpoints. */
    /** Last-used Offset Path distance, remembered across invocations. */
    lastOffsetAmount = 10;

    /** Offset the single selected Path by `distance` world units (positive =
     *  outset, negative = inset), creating a new parallel path above it. */
    offsetSelectedPath(distance = this.lastOffsetAmount) {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 1) return;
        const id = selection[0];
        if (!this.scene.getNodeGeometry(id)?.Path) return;
        this.lastOffsetAmount = distance;
        const newId = offsetPath(this.ui.ck, this.scene, id, distance);
        if (newId == null) return;
        this.scene.engine!.clear_selection();
        this.scene.selectNode(newId, false);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Last-used Blend step count, remembered across invocations. */
    lastBlendSteps = 4;

    /** Blend the two selected shapes: generate `steps` in-between shapes
     *  (geometry + color) grouped with the originals. */
    blendSelection(steps = this.lastBlendSteps) {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 2) return;
        this.lastBlendSteps = steps;
        const groupId = blendNodes(this.ui.ck, this.scene, selection[0], selection[1], steps);
        if (groupId == null) return;
        this.scene.engine!.clear_selection();
        this.scene.selectNode(groupId, false);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Apply a stroke width profile to the single selected open Path, outlining
     *  it into a filled variable-width (calligraphic) shape. */
    applyWidthProfileToSelection(profile: WidthProfile) {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 1) return;
        if (!applyWidthProfile(this.ui.ck, this.scene, selection[0], profile)) return;
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Add an anchor at the midpoint of every segment of the selected Path (the
     *  complement of Simplify). Curve unchanged. One undo step. */
    /** Make Compound Path: combine the selected shapes into one path whose
     *  subpaths use the even-odd rule, so overlaps read as holes (donuts, letters
     *  with counters). Non-destructive — the subpaths stay individually editable,
     *  unlike a boolean. Returns to a single path node. One undo step. */
    makeCompoundPath() {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length < 2) return;
        const all: Subpath[] = [];
        for (const id of sel) {
            const wp = nodeToWorldPath(this.ui.ck, this.scene, id);
            if (!wp) return; // unsupported node (e.g. text) — abort cleanly
            all.push(...pathToSubpaths(this.ui.ck, wp));
            wp.delete();
        }
        if (all.length < 2) return;
        // Even-odd fill so overlapping subpaths cut holes. Keep the bottom node's
        // appearance (the world subpaths are identity-placed by add_path).
        const style = { ...this.scene.getNodeStyle(sel[0]), fill_rule: 1 };
        const newId = this.scene.replaceNodesWithPath(
            sel,
            JSON.stringify(all),
            JSON.stringify(style),
        );
        if (newId == null) return;
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Release Compound Path: split the selected multi-subpath path back into one
     *  path node per subpath (each nonzero fill). One undo step. */
    releaseCompoundPath() {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length !== 1) return;
        const id = sel[0];
        const subs = this.scene.getNodeGeometry(id)?.Path?.subpaths;
        if (!subs || subs.length < 2) return;
        const world = transformSubpaths(subs, this.scene.getTransform(id));
        const style = JSON.stringify({ ...this.scene.getNodeStyle(id), fill_rule: 0 });
        const newIds: number[] = [];
        this.scene.transaction(() => {
            for (const sp of world) {
                const nid = this.scene.engine!.add_path(JSON.stringify([sp]));
                this.scene.engine!.set_node_style(nid, style);
                newIds.push(nid);
            }
            this.scene.engine!.remove_node(id);
        });
        this.scene.invalidateCache();
        this.scene.engine!.clear_selection();
        for (const nid of newIds) this.scene.selectNode(nid, true);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Reverse the single selected Path's direction in place (flips winding, and
     *  flips which way any text-on-path flows). One undo step. */
    reverseSelectedPath() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 1) return;
        const subs = this.scene.getNodeGeometry(selection[0])?.Path?.subpaths;
        if (!subs || subs.length === 0) return;
        this.scene.transaction(() => {
            this.scene.replaceGeometryWithPath(selection[0], reverseSubpaths(subs));
        });
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    // ─── Guide actions (drive the guide action bar) ──────────────────────────
    /** True when the selected guide is locked (can't be moved). */
    selectedGuideLocked(): boolean {
        return !!(this.selectedGuide && this.guides?.isLocked(this.selectedGuide));
    }
    /** Lock/unlock the selected guide (a locked guide can't be dragged). */
    toggleSelectedGuideLock() {
        if (!this.selectedGuide || !this.guides) return;
        this.guides.setLocked(this.selectedGuide, !this.guides.isLocked(this.selectedGuide));
        this.ui.syncWithSelection();
    }
    /** Delete the selected guide. */
    deleteSelectedGuide() {
        if (!this.selectedGuide || !this.guides) return;
        this.guides.deleteGuide(this.selectedGuide);
        this.selectedGuide = null;
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    /** Last-used Simplify tolerance (world units), remembered across invocations. */
    lastSimplifyTolerance = 2;

    /** Point count of the single selected path (for the Simplify UI), or 0. */
    selectedPathPointCount(): number {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 1) return 0;
        return pathPointCount(this.scene, selection[0]);
    }

    /** Simplify the single selected Path in place at `tolerance` world units. */
    simplifySelectedPath(tolerance = this.lastSimplifyTolerance) {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 1) return;
        if (!this.scene.getNodeGeometry(selection[0])?.Path) return;
        this.lastSimplifyTolerance = tolerance;
        if (simplifyPath(this.scene, selection[0], tolerance) == null) return;
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
    }

    joinSelectedPaths() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length !== 2) return;

        const [idA, idB] = selection;

        // Ensure both are paths
        for (const id of [idA, idB]) {
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) {
                this.scene.convertToPath(id);
            }
        }

        const geoA = this.scene.getNodeGeometry(idA);
        const geoB = this.scene.getNodeGeometry(idB);
        if (!geoA?.Path || !geoB?.Path) return;

        // Find open subpaths
        const spA = geoA.Path.subpaths;
        const spB = geoB.Path.subpaths;

        const openA = spA.findIndex((sp) => !sp.closed);
        const openB = spB.findIndex((sp) => !sp.closed);
        if (openA < 0 || openB < 0) return; // no open subpaths to join

        // Merge B's geometry into A by combining subpaths, then join the open ones
        const tA = this.scene.getTransform(idA);
        const tB = this.scene.getTransform(idB);

        // Transform B's points into A's local space
        // Invert A's transform
        const a = tA[0],
            b = tA[1],
            c = tA[2];
        const d = tA[3],
            e = tA[4],
            f = tA[5];
        const det = a * e - b * d;
        if (Math.abs(det) < 1e-10) return;

        const bSubpaths: Subpath[] = JSON.parse(JSON.stringify(spB));
        for (const sp of bSubpaths) {
            for (const pt of sp.points) {
                // Transform point from B's local to world, then to A's local
                const wx = tB[0] * pt.x + tB[1] * pt.y + tB[2];
                const wy = tB[3] * pt.x + tB[4] * pt.y + tB[5];
                pt.x = (e * (wx - c) - b * (wy - f)) / det;
                pt.y = (a * (wy - f) - d * (wx - c)) / det;

                // Same for handles
                const c1w: [number, number] = [
                    tB[0] * pt.cp1[0] + tB[1] * pt.cp1[1] + tB[2],
                    tB[3] * pt.cp1[0] + tB[4] * pt.cp1[1] + tB[5],
                ];
                pt.cp1 = [
                    (e * (c1w[0] - c) - b * (c1w[1] - f)) / det,
                    (a * (c1w[1] - f) - d * (c1w[0] - c)) / det,
                ];

                const c2w: [number, number] = [
                    tB[0] * pt.cp2[0] + tB[1] * pt.cp2[1] + tB[2],
                    tB[3] * pt.cp2[0] + tB[4] * pt.cp2[1] + tB[5],
                ];
                pt.cp2 = [
                    (e * (c2w[0] - c) - b * (c2w[1] - f)) / det,
                    (a * (c2w[1] - f) - d * (c2w[0] - c)) / det,
                ];
            }
        }

        // Combine all subpaths into one array, then join the two open ones
        const combined = [...(JSON.parse(JSON.stringify(spA)) as Subpath[]), ...bSubpaths];
        const combinedOpenA = combined.findIndex((sp) => !sp.closed);
        const aSubpathCount = spA.length;
        const combinedOpenB = combined.findIndex((sp, i) => i >= aSubpathCount && !sp.closed);

        if (combinedOpenA < 0 || combinedOpenB < 0) return;

        const joined = joinSubpaths(combined, combinedOpenA, 'end', combinedOpenB, 'start');

        // Replace: update A's geometry, remove B
        this.scene.saveMoveHistory();
        this.scene.engine!.update_path_points(idA, JSON.stringify(joined));
        this.scene.engine!.remove_node(idB);
        this.scene.engine!.clear_selection();
        this.scene.engine!.select_node(idA, false);
        this.scene.invalidateCache();
        this.scene.autosave?.trigger();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    groupSelection() {
        const selection = this.scene.engine!.get_selection();
        if (selection.length < 1) return;
        const groupId = this.scene.groupNodes(selection);
        this.scene.engine!.clear_selection();
        this.scene.selectNode(groupId, false);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /** Called when the Live Paint (paint-bucket) tool is activated. If shapes are
     *  selected, turn them into a Live Paint group (or enter an existing one) so
     *  the user can paint immediately — clicking the tool IS "Make Live Paint". */
    enterPaintBucketMode() {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length === 0) return; // no selection → paint any region freely
        // A single existing Live Paint group → just enter it.
        if (sel.length === 1 && this.scene.getNodeLivePaint(sel[0])) {
            this.enterLivePaintGroup(sel[0]);
            return;
        }
        // Only vector shapes/groups can form a Live Paint group; drop text/images.
        const paintable = sel.filter((id) => {
            const t = this.scene.getNode(id)?.node_type;
            return t === 'Path' || t === 'Rect' || t === 'Ellipse' || t === 'Group';
        });
        if (paintable.length === 0) return;
        if (paintable.length !== sel.length) {
            this.scene.engine!.clear_selection();
            for (const id of paintable) this.scene.engine!.select_node(id, true);
        }
        this.makeLivePaintGroup();
    }

    /** Turn the current selection into a Live Paint group — a special object
     *  (Illustrator's Object › Live Paint › Make). The selected shapes are
     *  grouped (an existing group is reused), flagged as Live Paint, renamed,
     *  and set as the active paint target. One undo step.
     *
     *  A selection that already belongs to a Live Paint group is a MERGE, not a
     *  Make (Illustrator's Object › Live Paint › Merge): the shapes join that
     *  group instead of being wrapped in a second one. Nesting is what made a
     *  shape you had just dragged into a group unpaintable — the inner flag wins
     *  (`live_paint_group_of` stops at the nearest one), so the shape formed its
     *  own one-member network and stopped dividing regions with its neighbours. */
    makeLivePaintGroup() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        const target = this.livePaintMergeTarget(selection);
        if (target !== null) {
            this.mergeIntoLivePaintGroup(selection, target);
            return;
        }
        let groupId = 0;
        this.scene.transaction(() => {
            if (selection.length === 1 && this.scene.getNode(selection[0])?.node_type === 'Group') {
                groupId = selection[0];
            } else {
                groupId = this.scene.groupNodes(selection);
            }
            this.scene.setNodeLivePaint(groupId, true);
            this.scene.setNodeName(groupId, 'Live Paint');
            this.scene.setLivePaintGroup(groupId);
        });
        // Enter paint mode on the new group, deselected so the selection frame
        // doesn't cover the regions you're about to paint.
        this.scene.engine!.clear_selection();
        this.ui.setActiveTool('paint-bucket');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** The Live Paint group a "Make Live Paint" on `selection` should merge
     *  into, or null when nothing selected belongs to one and a new group is
     *  what the user is asking for. The bottom-most member's group wins, so a
     *  selection spanning a group and a stray shape targets the group. */
    private livePaintMergeTarget(selection: number[]): number | null {
        for (const id of this.scene.sortByPaintOrder(selection)) {
            const g = this.findLivePaintAncestor(id);
            if (g !== null) return g;
        }
        return null;
    }

    /** Merge `selection` into an existing Live Paint group and start painting
     *  it. Members already inside it (and the group itself) are left where they
     *  are; outsiders are reparented as its top-most children, keeping their
     *  position on the canvas. A shape that is its own Live Paint group is
     *  skipped — folding one group's network into another's is a different
     *  operation, and silently dissolving it would lose its painted faces. */
    private mergeIntoLivePaintGroup(selection: number[], groupId: number) {
        const incoming = this.scene
            .sortByPaintOrder(this.scene.dedupSelection(selection))
            .filter((id) => id !== groupId && this.findLivePaintAncestor(id) === null);
        if (incoming.length > 0) {
            this.scene.transaction(() => {
                const index = this.scene.getNodeChildren(groupId).length;
                this.scene.reorderNodes(incoming, groupId, index);
            });
        }
        this.enterLivePaintGroup(groupId);
    }

    /** Nearest ancestor (or self) that is a Live Paint group, or null. */
    private findLivePaintAncestor(id: number): number | null {
        let cur: number = id;
        while (cur >= 0) {
            if (this.scene.getNodeLivePaint(cur)) return cur;
            cur = this.scene.engine!.get_node_parent(cur);
        }
        return null;
    }

    /** Tools whose output is vector geometry. Text is excluded: it contributes no
     *  segments to a Live Paint surface, so filing it inside one would move a row
     *  in the Objects panel and change nothing about the painting. */
    private static readonly DRAW_JOINING_TOOLS = new Set([
        'line',
        'rect',
        'ellipse',
        'polygon',
        'star',
        'pen',
        'pencil',
    ]);

    /**
     * The container a shape drawn *now* should be filed into — Illustrator's rule
     * that an object drawn while you are inside a group becomes part of it, so
     * "keep drawing the same picture" needs no second step. On a Live Paint group
     * that is the difference between a shape that paints with its neighbours and
     * one that merely sits on top of them.
     *
     * "Inside" is the parent of the selection, which is the same notion of current
     * context `resolveHit` already uses to decide what a click targets — so a
     * drawn shape lands where a click would have resolved, rather than inventing
     * a second idea of where you are. Three cases fall out of that and are all
     * intended:
     *
     * - the group ITSELF selected means you are handling it as one object (its
     *   parent is the root), and you are as likely to be drawing beside it. This
     *   is where Illustrator draws the line too — isolation mode, not selection.
     * - a selection spanning two parents has no single answer, so it gets none.
     * - a deeply nested member files the shape into ITS group, not the outermost
     *   one, which is the more precise reading of where you are — and inside a
     *   Live Paint group that subgroup is part of the surface anyway.
     *
     * A Boolean Group is excluded: its children are operands consumed into one
     * outline, so an extra one silently redraws the artwork rather than adding to
     * it. That is a different intent and it should stay an explicit act.
     */
    drawContainerTarget(): number | null {
        const sel = Array.from(this.scene.engine!.get_selection());
        if (sel.length === 0) return null;
        const parent = this.scene.getNodeParent(sel[0]);
        if (parent === -1) return null; // at the root: not inside anything
        for (const id of sel) {
            if (this.scene.getNodeParent(id) !== parent) return null;
        }
        if (this.scene.isBooleanGroup(parent)) return null;
        return parent;
    }

    /** Latched when a drawing gesture starts, consumed when it commits. A pen
     *  path spans many clicks and its own first click changes the selection, so
     *  the context has to be captured once at the start rather than read back at
     *  the end. */
    private drawJoinTarget: number | null = null;

    /** Capture the container a drawing gesture begins inside. Called on the press
     *  that starts one; a pen path in progress keeps the target it already
     *  latched. */
    private latchDrawContainerTarget() {
        if (!InputManager.DRAW_JOINING_TOOLS.has(this.ui.activeTool)) return;
        if (this.currentPathPoints.length > 0) return; // mid-path: keep the latch
        this.drawJoinTarget = this.drawContainerTarget();
    }

    /** File a freshly drawn shape into the container the gesture started inside,
     *  as its top-most member, keeping its position on the canvas. MUST run
     *  inside the same transaction as the creation, or drawing one shape would
     *  cost two undos. */
    private joinLatchedContainer(newId: number) {
        const target = this.drawJoinTarget;
        this.drawJoinTarget = null;
        if (target === null) return;
        // The container can be gone by now (undo, delete): reorder_nodes would
        // refuse a stale id and leave the shape at the root, but check so the
        // intent reads rather than relying on that.
        if (this.scene.getNodeType(target) === undefined) return;
        const index = this.scene.getNodeChildren(target).length;
        this.scene.reorderNodes([newId], target, index);
    }

    /** Enter an existing Live Paint group: scope painting to it and arm the
     *  bucket. Used by double-click and the Edit action. */
    enterLivePaintGroup(groupId: number) {
        if (!this.scene.getNodeLivePaint(groupId)) return;
        this.scene.setLivePaintGroup(groupId);
        // A different group's regions are not this group's.
        this.ui.setActiveRegion(null);
        this.scene.engine!.clear_selection();
        this.ui.setActiveTool('paint-bucket');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Stop editing the active Live Paint group (back to the Selection tool).
     *  The group stays the active Live Paint object — its faces keep rendering
     *  in-stream — so we do NOT clear the scope here (only Release/Expand do). */
    exitLivePaintGroup() {
        // The panel stops being about a region the moment you stop painting.
        this.ui.setActiveRegion(null);
        const group = this.scene.getLivePaintGroup();
        this.ui.setActiveTool('selection');
        // Putting the bucket down leaves you INSIDE the group, holding its
        // first member — Illustrator's isolation mode outlasts the bucket the
        // same way. It matters for more than tidiness: the group you are inside
        // is read off the selection, so clearing it here meant the next shape
        // you drew landed at the root and had to be merged in by hand, one step
        // after finishing the painting that shape belongs to.
        const members = group >= 0 ? Array.from(this.scene.getNodeChildren(group)) : [];
        if (members.length > 0) this.scene.selectNode(members[0], false);
        else this.scene.engine!.clear_selection();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Expand a Live Paint group (Illustrator's Object › Live Paint › Expand):
     *  a destructive Divide. Every COLORED face becomes one flat, non-overlapping
     *  filled path (its painted color, else the source fill showing through), and
     *  every painted edge becomes a stroked path. The originals are REMOVED;
     *  uncolored faces are discarded. Output nests "Fills" + "Strokes" groups. */
    expandLivePaintGroup(groupId: number) {
        const e = this.scene.engine!;
        // Ensure faces are computed for THIS group's geometry.
        this.scene.setLivePaintGroup(groupId);
        type Pt = { x: number; y: number; cp1: number[]; cp2: number[] };
        // Every colored face with its EFFECTIVE fill (painted, or absorbed source).
        const faces = JSON.parse(e.get_live_paint_faces()) as Array<{
            outline: Pt[];
            /** Islands inside the region. Baked as extra subpaths with an
             *  even-odd rule, or the expanded shape becomes a solid slab over
             *  whatever it enclosed. */
            holes?: Pt[][];
            fill: { r: number; g: number; b: number; a: number };
            /** The region's real paint — a gradient survives Expand through this;
             *  `fill` is only the flat fallback. */
            paint?: unknown;
        }>;
        // Every edge with an EFFECTIVE stroke — painted, or the source shape's
        // own. The originals are deleted below, so an edge the user drew but
        // never bucket-painted has to be baked too or the lines vanish.
        const edges = JSON.parse(e.get_live_paint_expand_edges()) as Array<{
            polyline?: number[][];
            outline?: Pt[];
            color: { r: number; g: number; b: number; a: number };
            width: number;
            cap?: number;
            join?: number;
        }>;
        if (faces.length === 0 && edges.length === 0) {
            this.releaseLivePaintGroup(groupId);
            return;
        }
        const outPts = (o?: Pt[]) =>
            (o || []).map((p) => ({ x: p.x, y: p.y, cp1: p.cp1, cp2: p.cp2, corner_radius: 0 }));
        const polyPts = (poly: number[][]) =>
            poly.map(([x, y]) => ({ x, y, cp1: [x, y], cp2: [x, y], corner_radius: 0 }));
        let expanded = 0;
        this.scene.transaction(() => {
            const fillIds: number[] = [];
            for (const f of faces) {
                const pts = outPts(f.outline);
                if (pts.length < 3) continue;
                const rings = [{ closed: true, points: pts }];
                for (const hole of f.holes ?? []) {
                    const hp = outPts(hole);
                    if (hp.length >= 3) rings.push({ closed: true, points: hp });
                }
                const id = e.add_path(JSON.stringify(rings));
                e.set_node_style(
                    id,
                    JSON.stringify({
                        fills: [f.paint ?? f.fill],
                        strokes: [],
                        opacity: 1,
                        blend_mode: 0,
                        // Even-odd whenever this region has islands: the rings
                        // come from the arrangement, which does not promise them
                        // wound opposite to the silhouette, and nonzero would
                        // fill the holes in.
                        fill_rule: rings.length > 1 ? 1 : 0,
                        corner_radius: 0,
                        effects: [],
                    }),
                );
                e.set_node_name(id, 'Fill');
                fillIds.push(id);
            }
            const strokeIds: number[] = [];
            for (const eg of edges) {
                const pts =
                    eg.outline && eg.outline.length >= 2
                        ? outPts(eg.outline)
                        : eg.polyline
                          ? polyPts(eg.polyline)
                          : [];
                if (pts.length < 2) continue;
                const id = e.add_path(JSON.stringify([{ closed: false, points: pts }]));
                e.set_node_style(
                    id,
                    JSON.stringify({
                        fills: [],
                        strokes: [
                            {
                                paint: eg.color,
                                width: eg.width > 0 ? eg.width : 2,
                                cap: eg.cap ?? 1,
                                join: eg.join ?? 1,
                                dash_array: [],
                                dash_offset: 0,
                                miter_limit: 4,
                                alignment: 'Center',
                            },
                        ],
                        opacity: 1,
                        blend_mode: 0,
                        fill_rule: 0,
                        corner_radius: 0,
                        effects: [],
                    }),
                );
                e.set_node_name(id, 'Edge');
                strokeIds.push(id);
            }
            // Destructive: drop THIS group's marks and its original shapes.
            // Scoped on purpose — the document-wide clear took every other Live
            // Paint group's colours with it, so expanding a copy blanked the
            // original it was copied from.
            e.set_live_paint_group(0);
            e.clear_live_paint_marks_in_group(groupId);
            e.remove_node(groupId);
            // Nest Fills (bottom) + Strokes (top) inside an "Expanded" group.
            const parts: number[] = [];
            if (fillIds.length) {
                const g = e.group_nodes(JSON.stringify(fillIds));
                e.set_node_name(g, 'Fills');
                parts.push(g);
            }
            if (strokeIds.length) {
                const g = e.group_nodes(JSON.stringify(strokeIds));
                e.set_node_name(g, 'Strokes');
                parts.push(g);
            }
            if (parts.length === 0) return;
            expanded = parts.length > 1 ? e.group_nodes(JSON.stringify(parts)) : parts[0];
            e.set_node_name(expanded, 'Expanded');
        });
        this.scene.invalidateCache();
        e.clear_selection();
        if (expanded) this.scene.selectNode(expanded, false);
        this.ui.setActiveTool('selection');
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /**
     * Turn a Live Paint group back into a plain group: the shapes stay exactly as
     * they are, the surface and its colours go. Illustrator's Object › Live Paint
     * › Release, and the same shape of choice a Boolean Group offers — Expand
     * bakes the result, Release throws it away — which is why the two objects now
     * present the same pair of buttons.
     *
     * The paint is discarded rather than baked, so it is destructive; undo brings
     * it back, and Expand is there for anyone who wanted to keep the colours.
     */
    releaseLivePaintGroup(groupId?: number) {
        const id = groupId ?? this.scene.getLivePaintGroup();
        this.scene.transaction(() => {
            if (id >= 0) this.scene.setNodeLivePaint(id, false);
            this.scene.setLivePaintGroup(0);
        });
        // The properties panel has to be told too, not just the bar and the
        // Objects list: its Fill section swaps the swatch for a note explaining
        // that region colours come from the bucket, and without this the note
        // stayed up on what was now a plain group, advertising a tool that no
        // longer applies to it.
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    ungroupSelection() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        // What the selection should be afterwards, gathered BEFORE the groups
        // stop existing.
        //
        // The engine does not touch the selection when it dissolves a group, so
        // the selection was left holding an id that no longer named anything:
        // nothing appeared selected, and the shapes just released could not be
        // moved, restyled or re-grouped without hunting for them again. Every
        // editor leaves the released members selected, which is also the only
        // answer that lets you undo the decision by pressing group again.
        const released: number[] = [];
        this.scene.transaction(() => {
            for (const id of selection) {
                const node = this.scene.getNode(id);
                if (node?.node_type === 'Group' && node.children?.length) {
                    released.push(...node.children);
                    this.scene.ungroupNode(id);
                } else {
                    // Not a group (or an empty one): the engine leaves it alone,
                    // so it stays selected rather than silently dropping out.
                    released.push(id);
                }
            }
        });
        const engine = this.scene.engine!;
        engine.clear_selection();
        for (const id of released) engine.select_node(id, true);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /**
     * Toggle "use as mask" on the selection (Figma-style alpha mask).
     * Masks are group-scoped — the parent group bounds what gets masked — and
     * the user never builds that group by hand:
     *  - Any selected node already a mask → release it.
     *  - Multiple nodes → auto-group them; the bottom-most becomes the mask.
     *  - Single node already inside a group → mark it (scoped to that group).
     *  - Single node at root → auto-group it with the sibling directly above
     *    it (the thing it should mask) and mark it. Nothing else in the
     *    document is touched.
     */
    toggleMaskSelection() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;
        const anyMask = selection.some((id) => this.scene.getNodeIsMask(id));

        if (anyMask) {
            this.scene.transaction(() => {
                for (const id of selection) this.scene.setNodeIsMask(id, false);
            });
        } else if (selection.length > 1) {
            this.scene.transaction(() => {
                const groupId = this.scene.groupNodes(selection);
                try {
                    this.scene.engine!.set_node_name(groupId, 'Mask group');
                } catch {
                    /* noop */
                }
                const kids = Array.from(this.scene.getNodeChildren(groupId));
                if (kids.length > 0) this.scene.setNodeIsMask(kids[0], true);
                this.scene.engine!.clear_selection();
                this.scene.selectNode(groupId, false);
            });
        } else {
            const id = selection[0];
            const parent = this.scene.getNodeParent(id);
            if (parent !== -1) {
                // Already bounded by a group — just flag it.
                this.scene.setNodeIsMask(id, true);
            } else {
                // Root node: wrap it (plus the sibling directly above, if any)
                // in a fresh mask group so the mask has a bounded scope.
                this.scene.transaction(() => {
                    const roots = Array.from(this.scene.getRootNodes());
                    const idx = roots.indexOf(id);
                    const above = idx >= 0 && idx + 1 < roots.length ? roots[idx + 1] : null;
                    const members = above !== null ? [id, above] : [id];
                    const groupId = this.scene.groupNodes(members);
                    try {
                        this.scene.engine!.set_node_name(groupId, 'Mask group');
                    } catch {
                        /* noop */
                    }
                    this.scene.setNodeIsMask(id, true);
                    this.scene.engine!.clear_selection();
                    this.scene.selectNode(id, false);
                });
            }
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
    }

    /**
     * Flatten selection: collapse each node into the simplest possible filled
     * path(s).  This is the "Expand" operation from Illustrator:
     *
     *  1. Text → path outlines  (Create Outlines)
     *  2. Rect / Ellipse → path  (Convert to Path)
     *  3. Non-identity transform → baked into geometry  (Flatten Transform)
     *  4. Stroke handling:
     *     • fill + stroke → split into two sibling paths in a group
     *       (fill path keeps fill, outline path gets fill=stroke color)
     *     • stroke only   → outline stroke in-place (fill=stroke, stroke=none)
     *     • fill only     → nothing extra
     *
     * Everything is wrapped in a single undo step.
     */
    async flattenSelection() {
        const selection = Array.from(this.scene.engine!.get_selection());
        if (selection.length === 0) return;

        // Exit path editing if active — flattening changes geometry
        if (this.editingNodeId !== null) {
            this.exitEditMode();
        }

        // Outlining text needs an async font parse (opentype.js). The transaction
        // below is synchronous, so pre-compute outlines for every text node first.
        const textOutlines = new Map<number, Subpath[] | null>();
        for (const id of selection) {
            if (this.scene.getNode(id)?.node_type !== 'Text') continue;
            const geo = this.scene.getNodeGeometry(id)?.Text;
            textOutlines.set(id, geo ? await textNodeToSubpaths(geo, this.renderer.ck) : null);
        }

        this.scene.transaction(() => {
            // Track which nodes end up selected after flatten
            const newSelection: number[] = [];

            for (const id of selection) {
                const node = this.scene.getNode(id);
                if (!node) {
                    newSelection.push(id);
                    continue;
                }

                // ── Step 1: Text → Path (create outlines) ──────────────
                if (node.node_type === 'Text') {
                    const subpaths = textOutlines.get(id) ?? null;
                    if (subpaths && subpaths.length > 0) {
                        this.scene.replaceGeometryWithPath(id, subpaths);
                    } else {
                        // Can't outline this text — skip
                        newSelection.push(id);
                        continue;
                    }
                }

                // ── Step 2: Rect / Ellipse → Path ──────────────────────
                if (node.node_type === 'Rect' || node.node_type === 'Ellipse') {
                    this.scene.convertToPath(id);
                }

                // ── Step 3: Bake transform into geometry ───────────────
                this.scene.flattenTransform(id);

                // ── Step 4: Handle strokes ─────────────────────────────
                const style = this.scene.getNodeStyle(id);
                if (!style) {
                    newSelection.push(id);
                    continue;
                }
                const hasStroke =
                    style.strokes &&
                    style.strokes.length > 0 &&
                    style.strokes.some((s) => s.width > 0);
                const hasFill = style.fills && style.fills.length > 0;

                if (hasStroke && hasFill) {
                    // Fill + Stroke → split into two paths in a group
                    // 1. Duplicate the node for the stroke outline
                    const strokeNodeId = this.scene.duplicateNode(id);
                    // duplicate_node offsets +20,+20 — undo it so the outline sits exactly on top
                    this.scene.moveNode(strokeNodeId, -20, -20);
                    // ...and it leaves the clone at the root, where the local
                    // transform it kept means something else entirely if the
                    // original sits in a group that has been scaled or turned.
                    this.scene.fileCopyBesideOriginal(strokeNodeId, id);

                    // 2. Original keeps fill, loses stroke
                    const fillStyle = { ...style, strokes: [] };
                    this.scene.setNodeStyleNoHistory(id, JSON.stringify(fillStyle));

                    // 3. Duplicate becomes the stroke outline (fill = stroke color, stroke = none)
                    outlineStroke(this.ui.ck, this.scene, strokeNodeId);

                    // 4. Group them (fill behind, stroke outline on top)
                    const groupId = this.scene.groupNodes([id, strokeNodeId]);
                    newSelection.push(groupId);
                } else if (hasStroke && !hasFill) {
                    // Stroke only → outline in place
                    outlineStroke(this.ui.ck, this.scene, id);
                    newSelection.push(id);
                } else {
                    // Fill only or no paint → nothing more to do
                    newSelection.push(id);
                }
            }

            // Restore selection to the resulting nodes
            this.scene.engine!.clear_selection();
            for (const id of newSelection) {
                this.scene.selectNode(id, true);
            }
        });

        this.scene.invalidateCache();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.ui.contextBar?.refresh();
    }

    /** Whether the current pen path was closed by clicking near the first point. */
    penPathClosed: boolean = false;
    /** While closing the path: a handle drag targets the first anchor, and the
     *  path is finalized on mouse-up (so the closing point behaves like any
     *  other — click to close with a corner, or drag to pull a bezier handle). */
    penClosingDrag: boolean = false;
    /** Latches true once a pen mouse-down turns into a real handle drag (cursor
     *  moved past PEN_HANDLE_DEAD_ZONE screen-px). Until then a press stays a
     *  crisp corner, so a shaky click doesn't pull a stray handle. */
    penHandleDragging: boolean = false;
    /** Snapped cursor position while hovering with the pen (for the rubber-band
     *  preview segment); null when not hovering. */
    penHoverPos: { x: number; y: number } | null = null;
    /** True when the hover cursor is close enough to the first anchor that a
     *  click would close the path (drives the close-indicator ring). */
    penHoverClosing: boolean = false;
    /** Set when a pen *click* finished the path (closing it on the first anchor).
     *  The browser still delivers the `dblclick` for that click pair afterwards,
     *  and the pen has already handed the tool back to Selection by then — so
     *  the stray dblclick is swallowed rather than entering edit mode on the
     *  shape underneath. Cleared by that dblclick, or by the next fresh press. */
    private penSuppressDoubleClick = false;
    /** World position of an existing open-path endpoint the idle pen is hovering
     *  (a click there would continue that path); null when none. Drives the
     *  continuation-indicator ring. */
    penHoverAdopt: { x: number; y: number } | null = null;

    // ─── Endpoint continuation (extend an existing open path) ───────────
    /** When the pen path was started by clicking a free endpoint of an existing
     *  open path, the id of that source node. New anchors extend it in place;
     *  null means the pen is drawing a brand-new path. */
    penSourceNodeId: number | null = null;
    /** The source node's local→world transform, captured at adoption time, used
     *  to convert the world-space pen points back to local on finalize. */
    penSourceTransform: Float32Array | null = null;
    /** Deep copy of the source node's full (local-space) subpaths at adoption
     *  time. The extended subpath is written back into this array on finalize so
     *  the node's other subpaths are preserved. */
    penSourceSubpaths: Subpath[] | null = null;
    /** Index (within penSourceSubpaths) of the open subpath being extended. */
    penSourceSubpathIndex: number = -1;
    /** Number of anchors the adopted path already had at adoption time. Undo may
     *  peel back the anchors *this* pen session added, but never the source
     *  path's own points — dropping below the base abandons the session and
     *  leaves the original node untouched. */
    private penAdoptedBaseCount: number = 0;
    /** Anchors removed by Cmd+Z while the path is still live, newest last, so
     *  Cmd+Shift+Z can put them back. Cleared as soon as a new anchor is placed. */
    private penUndonePoints: PenPathPoint[] = [];

    /** ⌘/Ctrl chords that belong to a focused text field, not to the app:
     *  select-all, copy, paste, cut. Everything else falls through to the
     *  editor's own shortcuts even while a panel field has focus. */
    static readonly FIELD_OWNED_CHORDS = new Set(['a', 'c', 'v', 'x']);

    /** Tools whose double-click opens the artwork under the cursor: the two
     *  selection tools, plus the bucket — which only ever gets as far as the
     *  Live Paint branch, to re-scope from one painted group to another. */
    static readonly DRILL_IN_TOOLS = new Set(['selection', 'direct', 'paint-bucket']);

    /** Screen-space radius (px) for hitting the first anchor to close the path. */
    static readonly PEN_CLOSE_RADIUS = 10;
    /** Screen-space distance (px) the cursor must travel before a pen press is
     *  treated as a handle drag rather than a plain click. */
    static readonly PEN_HANDLE_DEAD_ZONE = 4;

    handlePenDown(pos: { x: number; y: number }, bypassSnap = false) {
        this.penHandleDragging = false;

        // Endpoint continuation: on the very first click of a new path, if the
        // cursor lands on a free endpoint of an existing open path, adopt that
        // path and extend it in place rather than starting a fresh one
        // (Figma-style forgiveness). Cmd/Ctrl bypasses this to force a new path.
        if (!bypassSnap && this.currentPathPoints.length === 0 && this.tryAdoptEndpoint(pos)) {
            return;
        }

        // If we have existing points, check if clicking near the first point to
        // close the path. Threshold is in screen pixels (zoom-independent), so
        // the close target feels the same at any zoom level. Cmd/Ctrl bypasses
        // this the same way it bypasses snapping — place a point without closing.
        if (!bypassSnap && this.currentPathPoints.length > 1) {
            const first = this.currentPathPoints[0];
            const dist = Math.hypot(pos.x - first.x, pos.y - first.y);
            if (dist < InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom) {
                // Close the path, but keep it live so the user can drag out a
                // bezier handle on the closing anchor. Finalized on mouse-up.
                this.penPathClosed = true;
                this.penClosingDrag = true;
                this.isDraggingHandle = true;
                this.ui.contextBar?.refresh();
                return;
            }
        }

        // Mid-edge squares on committed segments (N/E/S/W once a rect is closed):
        // click inserts an anchor there instead of appending a free point.
        if (!bypassSnap && this.tryInsertPenMidEdge(pos)) {
            return;
        }

        // A fresh anchor invalidates the undone-anchor stack (same rule as any
        // undo history: new work discards the redo branch).
        this.penUndonePoints.length = 0;

        // Add a new anchor point (control points default to the anchor position)
        this.currentPathPoints.push({
            x: pos.x,
            y: pos.y,
            cp1x: pos.x,
            cp1y: pos.y,
            cp2x: pos.x,
            cp2y: pos.y,
        });
        this.isDraggingHandle = true;
        this.ui.contextBar?.refresh();
    }

    /** Insert at a mid-edge affordance on the live pen path (same centers as draw). */
    private tryInsertPenMidEdge(pos: { x: number; y: number }): boolean {
        const pts = this.currentPathPoints;
        if (pts.length < 2) return false;
        const threshold = 8 / this.renderer.zoom;
        const closed = this.penPathClosed;
        const segCount = closed ? pts.length : Math.max(0, pts.length - 1);
        let bestI = -1;
        let bestDist = threshold;
        let bestX = 0;
        let bestY = 0;
        for (let i = 0; i < segCount; i++) {
            const p1 = pts[i];
            const p2 = pts[(i + 1) % pts.length];
            const mx = (p1.x + p2.x) * 0.5;
            const my = (p1.y + p2.y) * 0.5;
            const d = Math.hypot(pos.x - mx, pos.y - my);
            if (d < bestDist) {
                bestDist = d;
                bestI = i;
                bestX = mx;
                bestY = my;
            }
        }
        if (bestI < 0) return false;
        this.penUndonePoints.length = 0;
        this.currentPathPoints.splice(bestI + 1, 0, {
            x: bestX,
            y: bestY,
            cp1x: bestX,
            cp1y: bestY,
            cp2x: bestX,
            cp2y: bestY,
        });
        this.isDraggingHandle = true;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /**
     * Double-click with the pen: end the open path here, the way Figma and
     * Sketch do (⏎ and Esc still work, as in Illustrator).
     *
     * Both clicks of the pair went through handlePenDown, so the second one
     * placed a duplicate anchor on top of the first — pop it, otherwise every
     * double-click finish leaves a coincident point behind. Only a plain,
     * coincident corner is dropped: if the press pulled a bezier handle it is
     * real geometry the user asked for.
     */
    private finishPenPathOnDoubleClick() {
        this.penSuppressDoubleClick = false;
        const pts = this.currentPathPoints;
        if (pts.length >= 2 && !this.penPathClosed) {
            const last = pts[pts.length - 1];
            const prev = pts[pts.length - 2];
            const isCorner =
                last.cp1x === last.x &&
                last.cp1y === last.y &&
                last.cp2x === last.x &&
                last.cp2y === last.y;
            const coincident =
                Math.hypot(last.x - prev.x, last.y - prev.y) <
                InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom;
            if (isCorner && coincident) pts.pop();
        }
        this.finalizePenPath();
    }

    /**
     * Whether the pen — not the document — should receive a keystroke.
     *
     * True whenever the pen tool is up, or a path is still buffered (belt and
     * braces: switching tools now commits, so a stranded path shouldn't outlive
     * the tool). Keys that mutate the document consult this so that drawing
     * never reaches behind the path and edits the selection you left behind.
     */
    private penOwnsKeyboard(): boolean {
        return this.ui.activeTool === 'pen' || this.currentPathPoints.length > 0;
    }

    /** True while finalizePenPath runs. Committing flips the tool back to
     *  Selection, and `setActiveTool` now commits an in-progress path — without
     *  this the two would call each other forever. */
    private penFinalizing = false;

    finalizePenPath() {
        if (this.penFinalizing) return;
        this.penFinalizing = true;
        try {
            this.finalizePenPathInner();
        } finally {
            this.penFinalizing = false;
        }
    }

    private finalizePenPathInner() {
        if (this.penSourceNodeId !== null) {
            // Endpoint continuation: write the extended subpath back into the
            // source node, in its own local space, preserving its other subpaths.
            this.finalizeAdoptedPenPath();
        } else if (this.currentPathPoints.length >= 2) {
            const rustPoints = this.currentPathPoints.map((p) => this.penPointToLocal(p, null, 0));
            const subpaths = [{ points: rustPoints, closed: this.penPathClosed }];
            this.scene.transaction(() => {
                const newId = this.scene.addPath(JSON.stringify(subpaths));

                // Apply the current UI style and select the new path. An open pen
                // path is stroke-only, like a line or a pencil stroke.
                this.scene.setNodeStyleNoHistory(newId, this.drawnPathStyle(this.penPathClosed));
                this.joinLatchedContainer(newId);
                this.scene.engine!.clear_selection();
                // Locked pen session: no transform box until 退出编辑 + user select.
                if (!this.ui.toolLocked) {
                    this.scene.selectNode(newId, false);
                }
            });
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            // One-shot: a completed path returns to Selection like the shape
            // tools, unless the pen was locked (double-click) for multiple paths.
            this.maybeRevertTool();
        }
        this.resetPenState();
    }

    /** Write the extended pen buffer back into the adopted source node. The pen
     *  points live in world space; convert them to the node's local space via
     *  the captured transform and replace the open subpath being extended. */
    private finalizeAdoptedPenPath() {
        const t = this.penSourceTransform;
        const subs = this.penSourceSubpaths;
        if (!t || !subs || this.currentPathPoints.length < 2) return;
        const det = t[0] * t[4] - t[1] * t[3];
        if (Math.abs(det) < 1e-10) return; // degenerate transform — leave node as-is

        const localPoints = this.currentPathPoints.map((p) => this.penPointToLocal(p, t, det));
        const out: Subpath[] = JSON.parse(JSON.stringify(subs));
        out[this.penSourceSubpathIndex] = { points: localPoints, closed: this.penPathClosed };

        this.scene.updatePathPoints(this.penSourceNodeId!, JSON.stringify(out));
        this.scene.engine!.clear_selection();
        if (!this.ui.toolLocked) {
            this.scene.selectNode(this.penSourceNodeId!, false);
        }
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
        this.maybeRevertTool();
    }

    /** Convert a world-space pen point to a PathPoint. When t/det are given, map
     *  through the node's inverse transform (local space); otherwise pass the
     *  world coordinates straight through (new path at identity). */
    private penPointToLocal(p: PenPathPoint, t: Float32Array | null, det: number): PathPoint {
        const map = (x: number, y: number): [number, number] =>
            t ? this.penWorldToLocal(t, det, x, y) : [x, y];
        const [ax, ay] = map(p.x, p.y);
        const pt: PathPoint = {
            x: ax,
            y: ay,
            cp1: map(p.cp1x, p.cp1y),
            cp2: map(p.cp2x, p.cp2y),
        };
        if (p.corner_radius) pt.corner_radius = p.corner_radius;
        return pt;
    }

    /** Convert a world point to the source node's local space. `det` is the
     *  precomputed 2×2 determinant (t0·t4 − t1·t3). */
    private penWorldToLocal(
        t: Float32Array,
        det: number,
        wx: number,
        wy: number,
    ): [number, number] {
        const dx = wx - t[2],
            dy = wy - t[5];
        return [(t[4] * dx - t[1] * dy) / det, (t[0] * dy - t[3] * dx) / det];
    }

    /** Convert a local point to world space using a node's local→world transform. */
    private penLocalToWorld(t: Float32Array, lx: number, ly: number): [number, number] {
        return [t[0] * lx + t[1] * ly + t[2], t[3] * lx + t[4] * ly + t[5]];
    }

    /** Clear all in-progress pen state after finalizing. */
    private resetPenState() {
        this.currentPathPoints = [];
        this.penPathClosed = false;
        this.penClosingDrag = false;
        this.penSourceNodeId = null;
        this.penSourceTransform = null;
        this.penSourceSubpaths = null;
        this.penSourceSubpathIndex = -1;
        this.penAdoptedBaseCount = 0;
        this.penUndonePoints.length = 0;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
    }

    /** Cmd+Z while a pen path is still being drawn: take back the last anchor
     *  instead of undoing the document. The in-progress path isn't in the scene
     *  yet, so the global history has nothing to say about it — undoing the
     *  previous document edit while the user is mid-path is never what they
     *  meant. Returns true when the keystroke was consumed here.
     *
     *  Order of removal mirrors how the path was built: a closed path reopens
     *  first (the close is the last thing that happened), then anchors pop off
     *  the end. For an adopted path we stop at the source path's own anchors —
     *  going past them abandons the session, leaving that node as it was. */
    undoLastPenPoint(): boolean {
        if (this.currentPathPoints.length === 0) return false;

        if (this.penPathClosed) {
            this.penPathClosed = false;
            this.penClosingDrag = false;
            this.ui.contextBar?.refresh();
            this.renderer.requestRender();
            return true;
        }

        // Anchors that belong to the adopted path, not to this pen session.
        const base = this.penSourceNodeId !== null ? this.penAdoptedBaseCount : 0;
        if (this.currentPathPoints.length <= base) {
            this.abandonPenPath();
            return true;
        }

        this.penUndonePoints.push(this.currentPathPoints.pop()!);
        this.isDraggingHandle = false;
        this.penHandleDragging = false;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /** Cmd+Shift+Z counterpart to undoLastPenPoint — put back the last anchor
     *  taken away, handles and all. */
    redoLastPenPoint(): boolean {
        const p = this.penUndonePoints.pop();
        if (!p) return false;
        this.currentPathPoints.push(p);
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /** Discard the in-progress pen path without committing. When a path was
     *  adopted for continuation the (hidden) source node reappears unchanged,
     *  since it was never mutated. */
    abandonPenPath() {
        this.resetPenState();
    }

    /** If `pos` lands on a free endpoint of an existing open path, load that
     *  subpath into the pen buffer (oriented so the clicked end is last) and
     *  remember the source node for write-back on finalize. Returns true if a
     *  path was adopted. */
    private tryAdoptEndpoint(pos: { x: number; y: number }): boolean {
        const hit = this.findAdoptableEndpoint(pos);
        if (!hit) return false;

        const geo = this.scene.getNodeGeometry(hit.nodeId);
        if (!geo?.Path) return false;
        const subpaths = JSON.parse(JSON.stringify(geo.Path.subpaths)) as Subpath[];
        const sp = subpaths[hit.subpathIndex];
        if (!sp || sp.closed || sp.points.length < 1) return false;

        const t = this.scene.getTransform(hit.nodeId);
        let pts: PenPathPoint[] = sp.points.map((p) => {
            const a = this.penLocalToWorld(t, p.x, p.y);
            const c1 = this.penLocalToWorld(t, p.cp1[0], p.cp1[1]);
            const c2 = this.penLocalToWorld(t, p.cp2[0], p.cp2[1]);
            const pp: PenPathPoint = {
                x: a[0],
                y: a[1],
                cp1x: c1[0],
                cp1y: c1[1],
                cp2x: c2[0],
                cp2y: c2[1],
            };
            if (p.corner_radius) pp.corner_radius = p.corner_radius;
            return pp;
        });

        // Orient so the clicked endpoint is LAST (the extension grows from it).
        // Clicking the start reverses point order and swaps each point's
        // incoming/outgoing handles.
        if (hit.end === 'start') {
            pts = pts.reverse().map((p) => ({
                x: p.x,
                y: p.y,
                cp1x: p.cp2x,
                cp1y: p.cp2y,
                cp2x: p.cp1x,
                cp2y: p.cp1y,
                corner_radius: p.corner_radius,
            }));
        }

        this.currentPathPoints = pts;
        this.penAdoptedBaseCount = pts.length;
        this.penUndonePoints.length = 0;
        this.penSourceNodeId = hit.nodeId;
        this.penSourceTransform = t;
        this.penSourceSubpaths = subpaths;
        this.penSourceSubpathIndex = hit.subpathIndex;
        this.penPathClosed = false;
        this.penClosingDrag = false;
        this.ui.contextBar?.refresh();
        this.renderer.requestRender();
        return true;
    }

    /** Find the nearest free endpoint of an open path near `pos`, within the pen
     *  close radius. Scans only nodes whose bounds fall near the cursor. */
    private findAdoptableEndpoint(pos: {
        x: number;
        y: number;
    }): { nodeId: number; subpathIndex: number; end: 'start' | 'end' } | null {
        const r = InputManager.PEN_CLOSE_RADIUS / this.renderer.zoom;
        const pad = r * 1.5;
        const candidates = this.scene.getVisibleNodes(
            pos.x - pad,
            pos.y - pad,
            pos.x + pad,
            pos.y + pad,
        );
        let best: { nodeId: number; subpathIndex: number; end: 'start' | 'end' } | null = null;
        let bestDist = r;
        for (const id of candidates) {
            if (this.scene.isLockedInTree(id) || !this.scene.isVisibleInTree(id)) continue;
            const geo = this.scene.getNodeGeometry(id);
            if (!geo?.Path) continue;
            const t = this.scene.getTransform(id);
            const subs = geo.Path.subpaths;
            for (let si = 0; si < subs.length; si++) {
                const sp = subs[si];
                if (sp.closed || sp.points.length < 1) continue;
                const ends: Array<'start' | 'end'> =
                    sp.points.length === 1 ? ['start'] : ['start', 'end'];
                for (const end of ends) {
                    const p = end === 'start' ? sp.points[0] : sp.points[sp.points.length - 1];
                    const w = this.penLocalToWorld(t, p.x, p.y);
                    const d = Math.hypot(pos.x - w[0], pos.y - w[1]);
                    if (d < bestDist) {
                        bestDist = d;
                        best = { nodeId: id, subpathIndex: si, end };
                    }
                }
            }
        }
        return best;
    }

    // --- Modifier helpers ---
    private constrainToAxis(
        start: { x: number; y: number },
        current: { x: number; y: number },
    ): { x: number; y: number } {
        const adx = Math.abs(current.x - start.x);
        const ady = Math.abs(current.y - start.y);
        return adx > ady ? { x: current.x, y: start.y } : { x: start.x, y: current.y };
    }

    private snapAngle45(dx: number, dy: number): { dx: number; dy: number } {
        const len = Math.hypot(dx, dy);
        if (len < 0.01) return { dx, dy };
        const angle = Math.atan2(dy, dx);
        const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
        return { dx: len * Math.cos(snapped), dy: len * Math.sin(snapped) };
    }

    onMouseMove(e: MouseEvent) {
        this.lastMouseEvent = e;
        this.currentPos = this.getPos(e);
        this.pointerSceneReady = true;
        this.shiftKey = e.shiftKey;
        this.altKey = e.altKey;
        this.metaKey = e.metaKey;
        this.ctrlKey = e.ctrlKey;

        // Ruler-guide drag in progress: track the cursor on the guide's axis.
        if (this.draggingGuide && this.isMouseDown) {
            this.didMove = true;
            const { axis, index } = this.draggingGuide;
            let pos = axis === 'x' ? this.currentPos.x : this.currentPos.y;
            if (this.guides?.gridSnap && this.guides.gridSize > 0) {
                pos = Math.round(pos / this.guides.gridSize) * this.guides.gridSize;
            }
            this.scene.setGuide(axis, index, pos);
            this.canvas.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
            this.renderer.requestRender();
            return;
        }

        // Artboard move/resize drag in progress.
        if (this.artboardDrag && this.isMouseDown) {
            this.didMove = true;
            this.updateArtboardDrag();
            return;
        }

        // Viewport pan drag (space or middle mouse held)
        if (this.panDrag && this.isMouseDown) {
            this.renderer.pan.x = this.panDrag.panX + (e.clientX - this.panDrag.screenX);
            this.renderer.pan.y = this.panDrag.panY + (e.clientY - this.panDrag.screenY);
            this.renderer.noteViewGesture();
            this.renderer.notifyViewChange();
            return;
        }
        if (this.isSpacePan) return; // hand tool active — no hover/tool behavior

        // Hover cursor for resize handles (when not dragging, skip in node-editing mode)
        // Hover feedback for ruler guides — a grab-able guide highlights and
        // shows a resize cursor. Only when not editing a path.
        if (!this.isMouseDown && this.guides && this.editingNodeId === null) {
            const gh = this.guides.hitGuide(
                this.currentPos.x,
                this.currentPos.y,
                5 / this.renderer.zoom,
            );
            if (gh && !this.hasCanvasControlAt(this.currentPos)) {
                if (
                    !this.highlightedGuide ||
                    this.highlightedGuide.axis !== gh.axis ||
                    this.highlightedGuide.index !== gh.index
                ) {
                    this.highlightedGuide = gh;
                    this.renderer.requestRender();
                }
                this.canvas.style.cursor = gh.axis === 'x' ? 'col-resize' : 'row-resize';
                return;
            }
            if (this.highlightedGuide) {
                this.highlightedGuide = null;
                this.renderer.requestRender();
            }
        }

        if (!this.isMouseDown && this.ui.activeTool === 'selection') {
            const outlineOnly = Boolean(this.renderer.selectionOutlineOnly?.());
            const gHit =
                this.editingNodeId === null && this.ui.gradientEdit.isActive()
                    ? this.ui.gradientEdit.hitTest(this.currentPos, this.renderer.zoom)
                    : null;
            const frame = this.editingNodeId === null && !gHit ? this.getSelectionFrame() : null;
            const handle =
                frame && !outlineOnly ? this.checkResizeHandle(this.currentPos, frame) : null;
            const rotHandle =
                !handle && frame && !outlineOnly
                    ? this.checkRotateHandle(this.currentPos, frame)
                    : null;
            if (gHit) {
                this.hoverNodeId = null;
                // 'copy' hints that clicking the axis inserts a new stop
                this.canvas.style.cursor = gHit.type === 'insert' ? 'copy' : 'default';
            } else if (handle && frame) {
                this.hoverNodeId = null;
                this.canvas.style.cursor = this.resizeCursorFor(handle.type, frame);
            } else if (rotHandle && frame) {
                this.hoverNodeId = null;
                this.canvas.style.cursor = this.rotateCursorForCorner(rotHandle.type, frame);
            } else if (
                this.editingNodeId === null &&
                !outlineOnly &&
                this.checkCornerRadiusHandle(this.currentPos)
            ) {
                this.hoverNodeId = null;
                // Diagonal pointer — corner radius handles sit on the diagonal
                this.canvas.style.cursor = 'pointer';
            } else {
                // Alt-hover shows the measure-to-hovered readout (Figma-style).
                this.hoverAlt = e.altKey;
                this.updateSelectionHover(e.altKey, e.metaKey || e.ctrlKey);
            }
        }

        // The Eyedropper TOOL gets the same eyedropper cursor as the bucket's
        // ⌥ shortcut. It had a plain crosshair, which was backwards: the ad-hoc
        // modifier looked more like a sampler than the tool named after one.
        if (!this.isMouseDown && this.ui.activeTool === 'eyedropper') {
            this.canvas.style.cursor = InputManager.EYEDROPPER_CURSOR;
        }

        // Pencil: keep host SVG tip (product overrides) while hovering idle.
        if (!this.isMouseDown && this.ui.activeTool === 'pencil') {
            this.canvas.style.cursor = this.ui.cursorForTool('pencil');
        }

        // Mesh tool hover: feed the overlay's hover state (highlights + ghost
        // insertion lines) and pick the cursor for what a click would do.
        if (!this.isMouseDown && this.ui.activeTool === 'mesh') {
            this.updateMeshHover(e);
        }

        // Paint bucket hover preview.
        if (!this.isMouseDown && this.ui.activeTool === 'paint-bucket') {
            this.updatePaintBucketHover(e.altKey, e.shiftKey, e.metaKey || e.ctrlKey);
        }

        // Scissors / Add-Point / Segment hover preview
        if (
            !this.isMouseDown &&
            (this.ui.activeTool === 'scissors' ||
                (this.ui.activeTool === 'direct' && this.editingNodeId))
        ) {
            const prevCut = this.scissorsHoverPoint;
            const prevSeg = this.hoverSegment;
            this.scissorsHoverPoint = null;
            this.hoverSegment = null;

            // For scissors: snap the preview dot to the nearest path outline.
            if (this.ui.activeTool === 'scissors') {
                const target = this.findScissorTarget(this.currentPos);
                if (target) this.scissorsHoverPoint = { x: target.worldX, y: target.worldY };
            }
            // For direct tool: hit test the editing path's segments for highlighting or add-point
            else if (this.editingNodeId && this.editingPoints && this.editingTransform) {
                const seg = findNearestSegment(
                    this.editingPoints,
                    this.editingTransform,
                    this.currentPos.x,
                    this.currentPos.y,
                    10 / this.renderer.zoom,
                );
                if (seg) {
                    this.hoverSegment = {
                        subpathIndex: seg.subpathIndex,
                        segmentIndex: seg.segmentIndex,
                    };
                    if (this.addPointMode) {
                        this.scissorsHoverPoint = { x: seg.worldX, y: seg.worldY };
                    }
                }
                // Cursor affordance: Alt / convert tool over an anchor pulls/collapses handles.
                const hnd = this.findNearestHandle(this.currentPos);
                if (hnd?.type === 'anchor' && (e.altKey || this.convertPointMode)) {
                    this.canvas.style.cursor = 'crosshair';
                } else if (hnd) {
                    this.canvas.style.cursor = 'move';
                } else if (this.findNearestMidEdge(this.currentPos)) {
                    this.canvas.style.cursor = 'copy';
                } else {
                    this.canvas.style.cursor = this.convertPointMode ? 'crosshair' : 'default';
                }
            }
            const cutChanged =
                (prevCut == null) !== (this.scissorsHoverPoint == null) ||
                (prevCut != null &&
                    this.scissorsHoverPoint != null &&
                    (Math.abs(prevCut.x - this.scissorsHoverPoint.x) > 1e-3 ||
                        Math.abs(prevCut.y - this.scissorsHoverPoint.y) > 1e-3));
            const segChanged =
                (prevSeg == null) !== (this.hoverSegment == null) ||
                (prevSeg != null &&
                    this.hoverSegment != null &&
                    (prevSeg.subpathIndex !== this.hoverSegment.subpathIndex ||
                        prevSeg.segmentIndex !== this.hoverSegment.segmentIndex));
            if (cutChanged || segChanged) this.renderer.requestRender();
        } else if (this.scissorsHoverPoint || this.hoverSegment) {
            this.scissorsHoverPoint = null;
            this.hoverSegment = null;
            this.renderer.requestRender();
        }

        // Pen tool hover: rubber-band preview segment + close-indicator ring.
        this.updatePenHover();

        // Pre-drag snap preview: for tools that snap their origin, show the snap
        // guides while hovering so the start point is defined by snapping too.
        if (!this.isMouseDown) this.updateHoverSnapPreview(e.metaKey || e.ctrlKey);

        if (!this.isMouseDown) return;
        this.onMouseMoveDrag(e);
        // Drag paths invalidate / requestRender themselves; keep a safety wake
        // so create-preview / marquee never stall without withRender on mousemove.
        this.renderer.requestRender();
    }

    /** Pointer-drag handling — runs only while the mouse button is held. */
    private onMouseMoveDrag(e: MouseEvent) {
        // On-canvas gradient handle drag (endpoints / stops / freshly inserted stop)
        if (this.gradientDragActive) {
            this.ui.gradientEdit.moveDrag(this.currentPos, e.shiftKey);
            return;
        }

        // Mesh vertex/handle drag (Mesh tool)
        if (this.meshDragActive) {
            const screenDist =
                Math.hypot(
                    this.currentPos.x - this.startPos.x,
                    this.currentPos.y - this.startPos.y,
                ) * this.renderer.zoom;
            if (screenDist > DRAG_START_THRESHOLD_PX) this.didMove = true;
            if (this.didMove) this.ui.meshEdit.moveDrag(this.currentPos, e.shiftKey, e.altKey);
            return;
        }
        // Mesh vertex marquee (drag from empty canvas with a mesh active)
        if (this.meshMarqueeStart && this.ui.activeTool === 'mesh') {
            this.didMove = true;
            this.marqueeRect = {
                x: Math.min(this.meshMarqueeStart.x, this.currentPos.x),
                y: Math.min(this.meshMarqueeStart.y, this.currentPos.y),
                w: Math.abs(this.currentPos.x - this.meshMarqueeStart.x),
                h: Math.abs(this.currentPos.y - this.meshMarqueeStart.y),
            };
            this.renderer.requestRender();
            return;
        }

        if (this.ui.activeTool === 'selection') {
            // Corner radius drag
            if (this.cornerRadiusDragging) {
                const { nodeId, startRadius, startPos } = this.cornerRadiusDragging;
                const node = this.scene.getNode(nodeId);
                if (node?.geometry.Rect) {
                    const rect = node.geometry.Rect;
                    const transform = this.scene.getTransform(nodeId);

                    const a = transform[0],
                        b = transform[1],
                        tx = transform[2];
                    const c = transform[3],
                        d = transform[4],
                        ty = transform[5];
                    const det = a * d - b * c;
                    const invDet = 1 / det;
                    const ia = d * invDet,
                        ib = -b * invDet,
                        ic = -c * invDet,
                        id_ = a * invDet;
                    const itx = (b * ty - d * tx) * invDet,
                        ity = (c * tx - a * ty) * invDet;

                    const slx = ia * startPos.x + ib * startPos.y + itx;
                    const sly = ic * startPos.x + id_ * startPos.y + ity;
                    const clx = ia * this.currentPos.x + ib * this.currentPos.y + itx;
                    const cly = ic * this.currentPos.x + id_ * this.currentPos.y + ity;

                    const corners = [
                        [0, 0, 1, 1],
                        [rect.width, 0, -1, 1],
                        [rect.width, rect.height, -1, -1],
                        [0, rect.height, 1, -1],
                    ];

                    let bestDist = Infinity;
                    let bestCorner = corners[0];
                    for (const cor of corners) {
                        const d = Math.hypot(slx - cor[0], sly - cor[1]);
                        if (d < bestDist) {
                            bestDist = d;
                            bestCorner = cor;
                        }
                    }

                    const dx_local = clx - slx;
                    const dy_local = cly - sly;
                    const dragProj =
                        (dx_local * bestCorner[2] + dy_local * bestCorner[3]) / Math.SQRT2;

                    let newRadius = startRadius + dragProj * Math.SQRT2;
                    newRadius = Math.round(
                        Math.max(0, Math.min(newRadius, rect.width / 2, rect.height / 2)),
                    );

                    const style = { ...node.style, corner_radius: newRadius };
                    this.scene.setNodeStyleNoHistory(nodeId, JSON.stringify(style));
                    this.ui.syncWithSelection({ gesture: true });
                    return;
                }
            }

            // Rotate handle drag (returns early from mouseDown, like resize)
            if (
                this.rotateHandleType &&
                this.rotatePivot &&
                this.rotateSnapshot &&
                this.rotateTargetIds.length > 0
            ) {
                const p = this.rotatePivot;
                const cur = Math.atan2(this.currentPos.y - p.y, this.currentPos.x - p.x);
                let deltaDeg = (cur - this.rotateStartAngle) * (180 / Math.PI);

                // Shift snaps to 15° increments — absolute angle for a single
                // node (so a shape at 0° lands on clean multiples), delta for
                // multi-selection.
                if (e.shiftKey) {
                    if (this.rotateSingleStartDeg !== null) {
                        const snapped =
                            Math.round((this.rotateSingleStartDeg + deltaDeg) / 15) * 15;
                        deltaDeg = snapped - this.rotateSingleStartDeg;
                    } else {
                        deltaDeg = Math.round(deltaDeg / 15) * 15;
                    }
                }

                this.applyRotationDrag(deltaDeg * (Math.PI / 180));
                // Keep the glyph oriented to the grab point as it orbits the pivot
                this.canvas.style.cursor = this.rotateCursorForAngle(cur * (180 / Math.PI));
                return;
            }

            // Oriented resize drag (rotated/skewed frame): all math happens in
            // frame space, so the drag follows the shape's own axes.
            if (
                this.resizeHandleType &&
                this.resizeFrame &&
                this.resizeSnapshot &&
                this.resizeLocalBounds &&
                this.resizeTargetIds.length > 0
            ) {
                const F0 = this.resizeFrame;
                const inv = this.matInv(F0.m);
                const sp = this.matApply(inv, this.startPos);
                const cp = this.matApply(inv, this.currentPos);
                const fdx = cp.x - sp.x,
                    fdy = cp.y - sp.y;
                const t = this.resizeHandleType;
                let newW = F0.w,
                    newH = F0.h,
                    moveX = 0,
                    moveY = 0;

                if (t.includes('e')) newW = F0.w + fdx;
                if (t.includes('w')) {
                    newW = F0.w - fdx;
                    moveX = fdx;
                }
                if (t.includes('s')) newH = F0.h + fdy;
                if (t.includes('n')) {
                    newH = F0.h - fdy;
                    moveY = fdy;
                }

                // Shift: maintain aspect ratio (corners only, like legacy)
                if (e.shiftKey && t.length === 2) {
                    const aspect = F0.w / F0.h;
                    if (Math.abs(fdx) / F0.w > Math.abs(fdy) / F0.h) {
                        newH = newW / aspect;
                    } else {
                        newW = newH * aspect;
                    }
                    if (t.includes('w')) moveX = F0.w - newW;
                    if (t.includes('n')) moveY = F0.h - newH;
                }

                // Alt: resize from center
                if (e.altKey) {
                    const deltaW = newW - F0.w;
                    const deltaH = newH - F0.h;
                    newW = F0.w + deltaW * 2;
                    newH = F0.h + deltaH * 2;
                    moveX = -deltaW;
                    moveY = -deltaH;
                }

                newW = Math.max(newW, 1);
                newH = Math.max(newH, 1);

                this.liveFrame = {
                    w: newW,
                    h: newH,
                    m: this.matMul(F0.m, { a: 1, b: 0, c: 0, d: 1, e: moveX, f: moveY }),
                };

                const id = this.resizeTargetIds[0];
                const nodeType = this.scene.getNodeType(id);
                // Restore pristine state, then apply the resize in local space.
                // A group resize only scales the group's transform, so resetting
                // just that node is enough; other node types change geometry, so
                // they need the full deserialize.
                if (nodeType === 3) {
                    this.resetGesturePristine();
                } else {
                    this.scene.engine!.deserialize_scene(this.resizeSnapshot);
                }
                const kx = newW / F0.w,
                    ky = newH / F0.h;
                const lb = this.resizeLocalBounds;
                if (nodeType === 3) {
                    // Group: scale the local transform about the local-bounds
                    // anchor so the whole subtree scales along the frame axes.
                    //   L' = L0 · T(lb+move) · S(kx,ky) · T(-lb)
                    const l = this.scene.getNodeLocalTransform(id);
                    const L0: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };
                    const Lp = this.matMul(
                        L0,
                        this.matMul(
                            { a: 1, b: 0, c: 0, d: 1, e: lb.x + moveX, f: lb.y + moveY },
                            this.matMul(
                                { a: kx, b: 0, c: 0, d: ky, e: 0, f: 0 },
                                { a: 1, b: 0, c: 0, d: 1, e: -lb.x, f: -lb.y },
                            ),
                        ),
                    );
                    this.scene.engine!.set_node_transform_matrix(
                        id,
                        JSON.stringify([Lp.a, Lp.b, 0, Lp.c, Lp.d, 0, Lp.e, Lp.f, 1]),
                    );
                } else if (nodeType === 4) {
                    // Text: E/W mid-handles change wrap WIDTH (auto-height box,
                    // like RCB textResizeMode:'wrap'). N/S and corners still
                    // scale font size with the box.
                    const tg = this.scene.getNodeGeometry(id)?.Text;
                    if (tg) {
                        if (t === 'e' || t === 'w') {
                            const newLayoutW = Math.max(8, newW);
                            this.renderer.setTextLayoutWidth(id, newLayoutW);
                            // Font size stays from the restored snapshot.
                            this.anchorNodeToFrameTopLeft(id);
                            // Grow the live frame with wrapped height so handles
                            // track the glyphs mid-drag (width-only drag keeps
                            // F0.h otherwise).
                            const lb2 = this.getNodeLocalBounds(id);
                            if (lb2 && this.liveFrame) {
                                this.liveFrame = {
                                    ...this.liveFrame,
                                    w: lb2.w,
                                    h: Math.max(1, lb2.h),
                                };
                            }
                        } else {
                            const k =
                                t === 'n' || t === 's'
                                    ? ky
                                    : Math.sqrt(Math.abs(kx * ky));
                            const newSize = Math.max(1, Math.min(2000, tg.font_size * k));
                            this.scene.engine!.set_text_content(id, tg.content, newSize);
                            const prevW = this.renderer.getTextLayoutWidth(id);
                            if (prevW != null) {
                                this.renderer.setTextLayoutWidth(id, Math.max(8, prevW * kx));
                            }
                            this.anchorNodeToFrameTopLeft(id);
                        }
                    }
                } else {
                    // Geometry resize (local units), then move so the frame's
                    // top-left corner lands where the live frame says.
                    this.scene.engine!.resize_node(id, lb.w * kx, lb.h * ky);
                    this.anchorNodeToFrameTopLeft(id);
                }

                // A group resize only scales the group's transform (subtree
                // geometry is unchanged), so it's transform-only — keep the
                // group's sprite and let it follow the scale delta. Text and
                // geometry resizes mutate local geometry, so they need the full
                // invalidation to rebuild the affected path cache.
                if (nodeType === 3) {
                    this.scene.invalidateCacheTransformOnly(this.resizeTargetIds);
                } else {
                    this.scene.invalidateCache();
                }
                this.ui.syncWithSelection({ gesture: true });
                return;
            }

            // Resize handle drag (checked before dragMode since resize returns early from mouseDown)
            if (
                this.resizeHandleType &&
                this.resizeStartBounds &&
                this.resizeTargetIds.length > 0 &&
                this.resizeSnapshot
            ) {
                const bounds = this.resizeStartBounds;
                const rdx = this.currentPos.x - this.startPos.x;
                const rdy = this.currentPos.y - this.startPos.y;
                let newW = bounds.w,
                    newH = bounds.h;
                let moveX = 0,
                    moveY = 0;

                if (this.resizeHandleType.includes('e')) newW = bounds.w + rdx;
                if (this.resizeHandleType.includes('w')) {
                    newW = bounds.w - rdx;
                    moveX = rdx;
                }
                if (this.resizeHandleType.includes('s')) newH = bounds.h + rdy;
                if (this.resizeHandleType.includes('n')) {
                    newH = bounds.h - rdy;
                    moveY = rdy;
                }

                // Shift: maintain aspect ratio
                if (e.shiftKey) {
                    const aspect = bounds.w / bounds.h;
                    const isCorner = this.resizeHandleType.length === 2;
                    if (isCorner) {
                        // Use the larger delta to drive both
                        if (Math.abs(rdx) / bounds.w > Math.abs(rdy) / bounds.h) {
                            newH = newW / aspect;
                        } else {
                            newW = newH * aspect;
                        }
                        // Recalculate origin shifts for w/n
                        if (this.resizeHandleType.includes('w')) moveX = bounds.w - newW;
                        if (this.resizeHandleType.includes('n')) moveY = bounds.h - newH;
                    }
                }

                // Alt: resize from center
                if (e.altKey) {
                    const deltaW = newW - bounds.w;
                    const deltaH = newH - bounds.h;
                    newW = bounds.w + deltaW * 2;
                    newH = bounds.h + deltaH * 2;
                    moveX = -deltaW;
                    moveY = -deltaH;
                }

                // Snap the dragged edge(s) to nearby geometry. Skipped with Alt
                // (resize-from-centre moves both edges, so there's no single one
                // to snap) and bypassed with Cmd/Ctrl (Figma/Illustrator-style
                // temporary disable).
                this.activeSnapGuides = [];
                const aspectLocked = e.shiftKey && this.resizeHandleType.length === 2;
                if (!e.altKey && !e.metaKey && !e.ctrlKey) {
                    const threshold = 8 / this.renderer.zoom;
                    if (aspectLocked) {
                        // Shift keeps the ratio, so only ONE axis is free. Snap the
                        // axis that is driving the scale — the same one the aspect
                        // maths above follows — and let the other side derive from
                        // it. Snapping both would fight the constraint, which is why
                        // this used to bail out entirely and leave a Shift-resize
                        // with no snapping at all. (A Shift-drag on an EDGE handle
                        // constrains nothing, so it snaps normally, below.)
                        const aspect = bounds.w / bounds.h;
                        const right = this.resizeHandleType.includes('e');
                        const bottom = this.resizeHandleType.includes('s');
                        if (Math.abs(rdx) / bounds.w > Math.abs(rdy) / bounds.h) {
                            const edge = right ? bounds.x + newW : bounds.x + moveX;
                            const s = this.snap.snapAxis('x', edge, threshold);
                            if (s) {
                                newW = right ? s.value - bounds.x : bounds.x + bounds.w - s.value;
                                newH = newW / aspect;
                                this.activeSnapGuides.push(s.guide);
                            }
                        } else {
                            const edge = bottom ? bounds.y + newH : bounds.y + moveY;
                            const s = this.snap.snapAxis('y', edge, threshold);
                            if (s) {
                                newH = bottom ? s.value - bounds.y : bounds.y + bounds.h - s.value;
                                newW = newH * aspect;
                                this.activeSnapGuides.push(s.guide);
                            }
                        }
                        // A w/n handle pins the opposite edge, so the origin has to
                        // follow whatever the constraint just made of the size.
                        if (!right) moveX = bounds.w - newW;
                        if (!bottom) moveY = bounds.h - newH;
                    } else {
                        if (this.resizeHandleType.includes('e')) {
                            const s = this.snap.snapAxis('x', bounds.x + newW, threshold);
                            if (s) {
                                newW = s.value - bounds.x;
                                this.activeSnapGuides.push(s.guide);
                            }
                        }
                        if (this.resizeHandleType.includes('w')) {
                            const s = this.snap.snapAxis('x', bounds.x + moveX, threshold);
                            if (s) {
                                const d = s.value - (bounds.x + moveX);
                                moveX += d;
                                newW -= d;
                                this.activeSnapGuides.push(s.guide);
                            }
                        }
                        if (this.resizeHandleType.includes('s')) {
                            const s = this.snap.snapAxis('y', bounds.y + newH, threshold);
                            if (s) {
                                newH = s.value - bounds.y;
                                this.activeSnapGuides.push(s.guide);
                            }
                        }
                        if (this.resizeHandleType.includes('n')) {
                            const s = this.snap.snapAxis('y', bounds.y + moveY, threshold);
                            if (s) {
                                const d = s.value - (bounds.y + moveY);
                                moveY += d;
                                newH -= d;
                                this.activeSnapGuides.push(s.guide);
                            }
                        }
                    }
                }

                newW = Math.max(newW, 1);
                newH = Math.max(newH, 1);

                // Update live bounds for the renderer to show smooth handles
                this.liveResizeBounds = {
                    x: bounds.x + moveX,
                    y: bounds.y + moveY,
                    w: newW,
                    h: newH,
                };

                // Restore original state, then apply the resize cleanly.
                // Each target node is mapped from the start bounds into the live
                // bounds: resize to its scaled size, then move so its bounds land
                // at the scaled position. The post-resize move corrects for
                // geometry that resizes about a point other than its top-left
                // corner (e.g. ellipses resize about their center).
                // All-group selections resize transform-only, so a per-target
                // reset stands in for the full deserialize.
                if (this.resizeTargetIds.every((tid) => this.scene.getNodeType(tid) === 3)) {
                    this.resetGesturePristine();
                } else {
                    this.scene.engine!.deserialize_scene(this.resizeSnapshot);
                }
                const scaleX = newW / Math.max(bounds.w, 1e-6);
                const scaleY = newH / Math.max(bounds.h, 1e-6);
                const live = this.liveResizeBounds;

                for (const id of this.resizeTargetIds) {
                    const b = this.scene.getNodeBounds(id);
                    const targetX = live.x + (b[0] - bounds.x) * scaleX;
                    const targetY = live.y + (b[1] - bounds.y) * scaleY;
                    // Text is auto-width: resize_node is a no-op for it, so scale
                    // the font size (geometric mean of the axes) instead. Read from
                    // the just-restored snapshot state, so it never compounds.
                    const tg =
                        this.scene.getNodeType(id) === 4
                            ? this.scene.getNodeGeometry(id)?.Text
                            : null;
                    if (tg) {
                        const newSize = Math.max(
                            1,
                            Math.min(2000, tg.font_size * Math.sqrt(Math.abs(scaleX * scaleY))),
                        );
                        this.scene.engine!.set_text_content(id, tg.content, newSize);
                    } else {
                        // `resize_node` writes a leaf's LOCAL geometry, while
                        // these bounds are world — the same number only while
                        // the node's chain is unscaled. Inside a group scaled to
                        // 200%, or on a shape set to 200% in the panel, the
                        // world size handed over was applied as a local one and
                        // the shape jumped to twice the size of the drag,
                        // running away from the pointer that was sizing it.
                        // (Groups are the exception: `resize_node` sizes those
                        // in world units, by scaling their transform.)
                        const worldW = (b[2] - b[0]) * scaleX;
                        const worldH = (b[3] - b[1]) * scaleY;
                        const size =
                            this.scene.getNodeType(id) === 3
                                ? { w: worldW, h: worldH }
                                : this.worldSizeToLocal(id, worldW, worldH);
                        this.scene.engine!.resize_node(id, size.w, size.h);
                    }
                    const nb = this.scene.getNodeBounds(id);
                    const dx = targetX - nb[0];
                    const dy = targetY - nb[1];
                    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
                        const local = this.worldDeltaToLocal(id, dx, dy);
                        this.scene.engine!.move_node(id, local.dx, local.dy);
                    }
                }

                // Resizing a group only scales its transform (transform-only),
                // so cached group sprites survive and follow the scale delta.
                // A leaf resize changes local geometry and needs the full cache
                // rebuild; a mixed selection falls back to full to stay safe.
                const allGroups = this.resizeTargetIds.every(
                    (id) => this.scene.getNodeType(id) === 3,
                );
                if (allGroups) {
                    this.scene.invalidateCacheTransformOnly(this.resizeTargetIds);
                } else {
                    this.scene.invalidateCache();
                }
                // Pass interactive to skip expensive context bar / breadcrumb / layer list rebuilds during drag
                this.ui.syncWithSelection({ gesture: true });
                return;
            }
        }

        if (this.ui.activeTool === 'selection' && this.dragMode === 'move') {
            // Only commit to a move once the pointer has travelled past the drag
            // threshold *from the press point*, measured in screen pixels. A
            // per-frame world-space delta (the old check) made a click far too
            // easy to turn into an accidental nudge — a fraction of a world unit
            // is sub-pixel when zoomed out, so the tiniest tremor moved objects.
            const screenTravel = Math.hypot(
                (this.currentPos.x - this.startPos.x) * this.renderer.zoom,
                (this.currentPos.y - this.startPos.y) * this.renderer.zoom,
            );
            if (!this.didMove && screenTravel > DRAG_START_THRESHOLD_PX) {
                this.scene.saveMoveHistory();
                this.didMove = true;
                // Snapshot the pre-drag scene (same approach as resize).
                // We restore this every frame so modifier changes (Alt, Shift) apply cleanly.
                this.moveSnapshot = this.scene.engine!.serialize_scene();
                // Same rule as the arrow keys: a locked node in the selection
                // (only the panel can put one there) comes along for no drag.
                this.moveOriginalIds = [...this.scene.engine!.get_selection()].filter(
                    (id) => !this.scene.isLockedInTree(id),
                );
                this.moveStartBounds = this.getSelectionBounds();
                // Pristine transforms for the fast per-frame reset (non-Alt moves).
                this.captureGesturePristine(this.moveOriginalIds);
                this.moveClonesActive = false;
                this.snap.begin(this.scene, this.moveOriginalIds);
                // Cache the static scene into GPU layers so each drag frame
                // only re-records the moving nodes (falls back silently when
                // the selection isn't all root-level).
                this.renderer.beginDragLayerCache(this.moveOriginalIds);
            }

            if (this.didMove && this.moveSnapshot) {
                // Restore pristine pre-drag state. An Alt clone-drag spawns
                // fresh duplicate nodes each frame, so it needs the full
                // deserialize to remove the previous frame's clones; the frame
                // right after releasing Alt also full-restores once to clean
                // them up. A plain move only shifts the selected roots, so
                // resetting just their transforms is far cheaper than
                // deserializing the whole scene.
                if (e.altKey || this.moveClonesActive) {
                    this.scene.engine!.deserialize_scene(this.moveSnapshot);
                    this.moveClonesActive = e.altKey;
                } else {
                    this.resetGesturePristine();
                }

                // Compute total displacement from drag start
                let totalDx = this.currentPos.x - this.startPos.x;
                let totalDy = this.currentPos.y - this.startPos.y;

                // Shift: constrain to axis
                if (e.shiftKey) {
                    const constrained = this.constrainToAxis(this.startPos, this.currentPos);
                    totalDx = constrained.x - this.startPos.x;
                    totalDy = constrained.y - this.startPos.y;
                }

                // Snap the moving selection box (edges + centers) to nearby
                // geometry. Cmd/Ctrl bypasses snapping; with Shift only the
                // free axis snaps so the constraint is never broken.
                this.activeSnapGuides = [];
                this.equalSpacing = null;
                if (!e.metaKey && !e.ctrlKey && this.moveStartBounds) {
                    const sb = this.moveStartBounds;
                    const snapped = this.snap.snapBounds(
                        { x: sb.x + totalDx, y: sb.y + totalDy, w: sb.w, h: sb.h },
                        8 / this.renderer.zoom,
                    );
                    const xLocked = e.shiftKey && totalDx === 0;
                    const yLocked = e.shiftKey && totalDy === 0;
                    if (!xLocked) totalDx += snapped.dx;
                    if (!yLocked) totalDy += snapped.dy;
                    this.activeSnapGuides = snapped.guides.filter(
                        (g) => (g.axis === 'x' && !xLocked) || (g.axis === 'y' && !yLocked),
                    );

                    // Figma-style equal spacing. It takes over an axis from
                    // edge/grid alignment when the equal position is within reach —
                    // otherwise alignment or grid snapping there would block it
                    // entirely. A touch grabbier than edge alignment, since an exact
                    // equal position is harder to hit by hand than a shared edge.
                    //
                    // But only when it is the nearer of the two. Equal spacing is
                    // measured from the ALREADY-snapped position, so the pointer's
                    // distance to it is `snapped.d? + es.delta`, while the distance
                    // to the edge alignment is `snapped.d?`. Overriding an edge
                    // alignment the user is a hair away from — for an equal position
                    // three times further off — is what makes a snap feel like it
                    // jumps somewhere else entirely.
                    const thr = 12 / this.renderer.zoom;
                    const es = computeEqualSpacing(this.scene, this.moveOriginalIds, [
                        sb.x + totalDx,
                        sb.y + totalDy,
                        sb.x + totalDx + sb.w,
                        sb.y + totalDy + sb.h,
                    ]);
                    const beatsAlignment = (delta: number, edgeDelta: number, axis: 'x' | 'y') =>
                        Math.abs(delta) < thr &&
                        (!snapped.guides.some((g) => g.axis === axis) ||
                            Math.abs(edgeDelta + delta) < Math.abs(edgeDelta));
                    const matches: import('./equal_spacing').EqualMatch[] = [];
                    if (!xLocked && es.x && beatsAlignment(es.x.delta, snapped.dx, 'x')) {
                        totalDx += es.x.delta;
                        this.activeSnapGuides = this.activeSnapGuides.filter((g) => g.axis !== 'x');
                        matches.push(es.x);
                    }
                    if (!yLocked && es.y && beatsAlignment(es.y.delta, snapped.dy, 'y')) {
                        totalDy += es.y.delta;
                        this.activeSnapGuides = this.activeSnapGuides.filter((g) => g.axis !== 'y');
                        matches.push(es.y);
                    }
                    if (matches.length) this.equalSpacing = matches;
                }

                let moveTargets: number[];
                if (e.altKey) {
                    // Alt: clone-drag — duplicate originals, move the clones
                    this.scene.engine!.clear_selection();
                    moveTargets = [];
                    for (const id of this.moveOriginalIds) {
                        const newId = this.scene.engine!.duplicate_node(id);
                        // `duplicate_node` builds in the +20,+20 offset that
                        // makes a menu Duplicate visible on top of its original.
                        // A clone-drag does not want it: the copy is positioned
                        // by the pointer, so the offset put it 20 units
                        // down-right of the cursor — and under Shift, 20 units
                        // off the axis the constraint had just locked. The paste
                        // path takes it back off for the same reason.
                        this.scene.engine!.move_node(newId, -20, -20);
                        // ...and it hands every clone to the ROOT, which for a
                        // shape inside a group means ⌥-dragging a copy of it
                        // quietly lifted the copy out of the group: out of its
                        // z-order, out of its mask, out of a Live Paint group's
                        // region network — and, under a rotated or scaled group,
                        // landing somewhere else entirely, since the local
                        // transform it kept was measured against a parent it no
                        // longer had. ⌘D already files its copies beside their
                        // originals; a clone-drag is the same duplicate with the
                        // pointer choosing where it lands.
                        this.keepCopyBesideOriginal(newId, id);
                        this.scene.engine!.select_node(newId, true);
                        moveTargets.push(newId);
                    }
                    this.canvas.style.cursor = 'copy';
                } else {
                    // Normal move — shift the originals
                    this.scene.engine!.clear_selection();
                    for (const id of this.moveOriginalIds) {
                        this.scene.engine!.select_node(id, true);
                    }
                    moveTargets = this.moveOriginalIds;
                    this.canvas.style.cursor = 'move';
                }

                // Batched: moving each node separately re-unions every shared
                // group ancestor's AABB once per node, which is quadratic in the
                // size of the selection (a 4000-node drag frame cost 436ms).
                this.scene.engine!.move_nodes(
                    JSON.stringify(
                        moveTargets.map((id) => {
                            const local = this.worldDeltaToLocal(id, totalDx, totalDy);
                            return { id, dx: local.dx, dy: local.dy };
                        }),
                    ),
                );
                // The moving set feeds the drag-layer cache: during an Alt
                // clone-drag the unmoved originals must render live too (they
                // were excluded from the static snapshots).
                this.renderer.setDragMovingRoots(
                    e.altKey ? [...this.moveOriginalIds, ...moveTargets] : moveTargets,
                );
                // Translation-only frame: geometry and paints are unchanged, so
                // renderer caches (paths/shaders) and the drag layers stay valid.
                // Passing the moved ids drops the sprite of any cached group a
                // moved node sits INSIDE (moved cached roots keep theirs).
                this.scene.invalidateCacheTransformOnly(moveTargets);
                // Update property panel position values without rebuilding chrome DOM
                this.ui.syncWithSelection({ gesture: true });
            }
        }

        // Update marquee selection rect
        if (this.marqueeRect) {
            const x = Math.min(this.startPos.x, this.currentPos.x);
            const y = Math.min(this.startPos.y, this.currentPos.y);
            const w = Math.abs(this.currentPos.x - this.startPos.x);
            const h = Math.abs(this.currentPos.y - this.startPos.y);
            this.marqueeRect.x = x;
            this.marqueeRect.y = y;
            this.marqueeRect.w = w;
            this.marqueeRect.h = h;

            // If in path edit mode, marquee selects points
            if (
                this.ui.activeTool === 'direct' &&
                this.editingNodeId !== null &&
                this.editingPoints &&
                this.editingTransform
            ) {
                const t = this.editingTransform;
                const rect = this.marqueeRect;

                if (!e.shiftKey) this.selectedPoints.clear();

                for (let si = 0; si < this.editingPoints.length; si++) {
                    const sp = this.editingPoints[si];
                    for (let i = 0; i < sp.points.length; i++) {
                        const p = sp.points[i];
                        const wx = t[0] * p.x + t[1] * p.y + t[2];
                        const wy = t[3] * p.x + t[4] * p.y + t[5];
                        if (
                            wx >= rect.x &&
                            wx <= rect.x + rect.w &&
                            wy >= rect.y &&
                            wy <= rect.y + rect.h
                        ) {
                            this.selectedPoints.add(`${si}:${i}`);
                        }
                    }
                }
                // Keep the context bar's selected-point count live during the marquee
                this.ui.contextBar?.refresh();
            }
        }

        // Update live preview for shape creation
        if (this.previewRect) {
            // Snap the moving corner. Cmd/Ctrl bypasses.
            let cur = this.currentPos;
            this.activeSnapGuides = [];
            // Which axis leads the drag. Under Shift the square's side is taken
            // from it, so it's also the only axis that can snap.
            const xDrives = Math.abs(cur.x - this.startPos.x) >= Math.abs(cur.y - this.startPos.y);
            if (!e.metaKey && !e.ctrlKey) {
                const thr = 8 / this.renderer.zoom;
                if (e.shiftKey) {
                    // A square's two sides are one number, so snapping both axes
                    // would fight the constraint — snap the leading one and let
                    // the other follow. Skipping snapping altogether (the old
                    // behaviour) meant you couldn't draw a square onto a guide.
                    const s = xDrives
                        ? this.snap.snapAxis('x', cur.x, thr)
                        : this.snap.snapAxis('y', cur.y, thr);
                    if (s) {
                        cur = xDrives ? { x: s.value, y: cur.y } : { x: cur.x, y: s.value };
                        this.activeSnapGuides = [s.guide];
                    }
                } else {
                    // Alt (from-centre) snaps too: the cursor corner is still a
                    // real corner of the result, the opposite one just mirrors it.
                    const s = this.snap.snapPoint(cur.x, cur.y, thr);
                    cur = { x: s.x, y: s.y };
                    this.activeSnapGuides = s.guides;
                }
            }

            let w = Math.abs(cur.x - this.startPos.x);
            let h = Math.abs(cur.y - this.startPos.y);

            // Shift: constrain to square/circle. The side comes from the leading
            // axis rather than max(w,h) — same value when nothing snapped, but it
            // keeps the snapped edge exact when a snap shortened that axis.
            if (e.shiftKey) {
                const side = xDrives ? w : h;
                w = side;
                h = side;
            }

            let x: number, y: number;
            if (e.altKey) {
                // Alt: draw from center — startPos is the center
                x = this.startPos.x - w;
                y = this.startPos.y - h;
                w *= 2;
                h *= 2;
            } else {
                // Anchor at startPos, extend toward the drag direction.
                // When Shift is held the constrained size may exceed the
                // cursor offset on one axis, so we can't use Math.min with
                // currentPos — that would place the origin at the cursor
                // instead of at startPos on the shorter axis.
                x = cur.x >= this.startPos.x ? this.startPos.x : this.startPos.x - w;
                y = cur.y >= this.startPos.y ? this.startPos.y : this.startPos.y - h;
            }

            this.previewRect.x = x;
            this.previewRect.y = y;
            this.previewRect.w = w;
            this.previewRect.h = h;
        }

        // Line tool: track the moving endpoint (snap, or Shift → 45° steps).
        if (this.previewLine) {
            let cur = this.currentPos;
            this.activeSnapGuides = [];
            if (e.shiftKey) {
                const c = this.snapAngle45(cur.x - this.startPos.x, cur.y - this.startPos.y);
                cur = { x: this.startPos.x + c.dx, y: this.startPos.y + c.dy };
            } else if (!e.metaKey && !e.ctrlKey) {
                const s = this.snap.snapPoint(cur.x, cur.y, 8 / this.renderer.zoom);
                cur = { x: s.x, y: s.y };
                this.activeSnapGuides = s.guides;
            }
            this.previewLine.x2 = cur.x;
            this.previewLine.y2 = cur.y;
        }

        // Pencil tool: sample the freehand stroke, thinning near-duplicate points.
        if (this.pencilPoints) {
            const last = this.pencilPoints[this.pencilPoints.length - 1];
            const minGap = 2 / this.renderer.zoom;
            if (Math.hypot(this.currentPos.x - last.x, this.currentPos.y - last.y) >= minGap) {
                this.pencilPoints.push({ x: this.currentPos.x, y: this.currentPos.y });
            }
        }

        // Pen tool: adjust control handles while dragging after placing an anchor
        if (
            this.ui.activeTool === 'pen' &&
            this.isDraggingHandle &&
            this.currentPathPoints.length > 0
        ) {
            // Dead-zone: ignore sub-threshold jitter so a click stays a crisp
            // corner. Once past it, latch into drag mode for the rest of the press.
            if (!this.penHandleDragging) {
                const moved =
                    Math.hypot(
                        this.currentPos.x - this.startPos.x,
                        this.currentPos.y - this.startPos.y,
                    ) * this.renderer.zoom;
                if (moved < InputManager.PEN_HANDLE_DEAD_ZONE) return;
                this.penHandleDragging = true;
            }
            // When closing the path, the drag shapes the handle of the first
            // anchor (the point we're joining back to); otherwise the last one.
            const anchor = this.penClosingDrag
                ? this.currentPathPoints[0]
                : this.currentPathPoints[this.currentPathPoints.length - 1];
            let hdx = this.currentPos.x - anchor.x;
            let hdy = this.currentPos.y - anchor.y;

            // Shift: snap handle to 45° angles
            if (e.shiftKey) {
                const snapped = this.snapAngle45(hdx, hdy);
                hdx = snapped.dx;
                hdy = snapped.dy;
            }

            anchor.cp2x = anchor.x + hdx;
            anchor.cp2y = anchor.y + hdy;
            // Alt: break tangent — only move outgoing handle, don't mirror
            if (!e.altKey) {
                anchor.cp1x = anchor.x - hdx;
                anchor.cp1y = anchor.y - hdy;
            }
        }

        // Direct selection: drag point or handle
        if (
            this.ui.activeTool === 'direct' &&
            this.draggingHandleType &&
            this.editingPoints &&
            this.editingTransform
        ) {
            const sp = this.editingPoints[this.draggingSubpathIndex];
            if (!sp) return;
            const p = sp.points[this.draggingPointIndex];
            if (!p) return;

            // Compute world-space drag position
            let worldPos = this.currentPos;
            this.activeSnapGuides = [];

            if (this.draggingHandleType === 'anchor') {
                // Snapping for anchors (bypass with Cmd/Ctrl)
                if (!e.metaKey && !e.ctrlKey) {
                    const s = this.snap.snapPoint(worldPos.x, worldPos.y, 8 / this.renderer.zoom);
                    worldPos = { x: s.x, y: s.y };
                    this.activeSnapGuides = s.guides;
                }

                // Axis constraint (Shift)
                if (e.shiftKey) {
                    worldPos = this.constrainToAxis(this.startPos, worldPos);
                }
            }

            const local = this.worldToLocal(worldPos.x, worldPos.y);

            if (this.draggingHandleType === 'anchor') {
                const ldx = local.x - p.x;
                const ldy = local.y - p.y;

                // Move all selected points
                for (const key of this.selectedPoints) {
                    const [si, pi] = key.split(':').map(Number);
                    const pt = this.editingPoints[si].points[pi];
                    pt.x += ldx;
                    pt.y += ldy;
                    pt.cp1[0] += ldx;
                    pt.cp1[1] += ldy;
                    pt.cp2[0] += ldx;
                    pt.cp2[1] += ldy;
                }
            } else if (this.draggingHandleType === 'cp1') {
                p.cp1[0] = local.x;
                p.cp1[1] = local.y;
                // Alt: break tangent — move only this handle. While pulling a
                // new handle out of an anchor (convertingAnchor), keep it
                // symmetric even though Alt is held.
                if (!e.altKey || this.convertingAnchor) {
                    p.cp2[0] = 2 * p.x - local.x;
                    p.cp2[1] = 2 * p.y - local.y;
                }
            } else if (this.draggingHandleType === 'cp2') {
                p.cp2[0] = local.x;
                p.cp2[1] = local.y;
                // Alt: break tangent — move only this handle. While pulling a
                // new handle out of an anchor (convertingAnchor), keep it
                // symmetric even though Alt is held.
                if (!e.altKey || this.convertingAnchor) {
                    p.cp1[0] = 2 * p.x - local.x;
                    p.cp1[1] = 2 * p.y - local.y;
                }
            }
            // Live update the engine so it renders immediately. The undo step
            // is pushed once, on mouse-up, and only because of this flag.
            this.pointDragChanged = true;
            this.scene.engine!.update_path_points(
                this.editingNodeId!,
                JSON.stringify(this.editingPoints),
            );
            // Keep any mesh fill glued to the outline while it is dragged.
            this.scene.snapMeshFillsToGeometry(this.editingNodeId!);
            this.scene.invalidateCache();
            this.ui.syncWithSelection({ gesture: true });
        }
    }

    onMouseUp(e: MouseEvent) {
        this.handleMouseUp(e);
        // AFTER the gesture, never during it: a marquee rewrites the selection
        // on every mousemove, and a panel chasing that would be unreadable.
        // Here rather than at the tail of `handleMouseUp`, which returns early
        // down a dozen paths. Costs nothing when the selection did not change,
        // and nothing but a scroll when the row is already in the tree — see
        // `revealSelectionIfChanged`.
        this.ui.revealSelectionIfChanged();
    }

    private handleMouseUp(e: MouseEvent) {
        if (!this.isMouseDown) return;
        // A shift-click on something already selected takes it out again — but
        // only if the gesture stayed a click. A drag was the user moving the
        // selection by one of its members, and that must leave it intact.
        if (this.pendingShiftDeselect !== null) {
            const target = this.pendingShiftDeselect;
            this.pendingShiftDeselect = null;
            if (!this.didMove) {
                this.scene.engine!.deselect_node(target);
                this.ui.syncWithSelection();
                this.ui.updateLayerList();
                this.renderer.requestRender();
            }
        }
        this.isMouseDown = false;
        this.dragMode = 'none';
        this.isDraggingHandle = false;
        this.penHandleDragging = false;
        this.snap.end();
        this.activeSnapGuides = [];
        this.equalSpacing = null;

        // Finish a ruler-guide drag: dropping it back over a ruler (or off the
        // canvas) deletes it; otherwise persist the new position.
        if (this.draggingGuide) {
            const { axis, index } = this.draggingGuide;
            this.draggingGuide = null;
            this.highlightedGuide = null;
            if (this.guides?.isOverRuler(e.clientX, e.clientY)) {
                this.scene.removeGuide(axis, index);
            } else {
                this.scene.autosave?.trigger();
            }
            this.canvas.style.cursor = 'default';
            this.renderer.requestRender();
            return;
        }

        // Finish a path that was just closed on the first anchor. Deferred to
        // mouse-up so the click could pull a bezier handle off the closing point.
        if (this.penClosingDrag) {
            // Closing on the second click of a double-click hands the tool back
            // to Selection before the dblclick lands; flag it so that event
            // doesn't enter node-editing on whatever sits under the cursor.
            this.penSuppressDoubleClick = true;
            this.finalizePenPath();
            return;
        }

        // End artboard move/resize drag
        if (this.artboardDrag) {
            this.endArtboardDrag();
            return;
        }

        // End viewport pan drag
        if (this.panDrag) {
            this.panDrag = null;
            this.canvas.style.cursor = this.isSpacePan ? 'grab' : 'default';
            return;
        }

        // Commit gradient handle drag
        if (this.gradientDragActive) {
            this.gradientDragActive = false;
            this.ui.gradientEdit.endDrag();
            this.ui.syncWithSelection();
            return;
        }

        // Commit mesh vertex/handle drag (a travel-less press resolves a
        // pending Shift-toggle instead)
        if (this.meshDragActive) {
            this.meshDragActive = false;
            // Back to full-resolution mesh rasters, and repaint at quality.
            this.renderer.meshDraftMode = false;
            this.ui.meshEdit.endDrag(this.didMove);
            this.ui.syncWithSelection();
            this.renderer.requestRender();
            return;
        }
        // Resolve a mesh-tool press on empty canvas: marquee-select vertices,
        // or (plain click) clear the vertex selection first, then deselect.
        if (this.meshMarqueeStart && this.ui.activeTool === 'mesh') {
            const me = this.ui.meshEdit;
            if (this.didMove && this.marqueeRect) {
                me.selectVerticesInWorldRect(
                    { x: this.marqueeRect.x, y: this.marqueeRect.y },
                    {
                        x: this.marqueeRect.x + this.marqueeRect.w,
                        y: this.marqueeRect.y + this.marqueeRect.h,
                    },
                    this.meshMarqueeAdditive,
                );
            } else if (me.selectedVertices.size > 0) {
                me.selectedVertices.clear();
            } else {
                this.scene.engine!.clear_selection();
                this.ui.updateLayerList();
                this.ui.syncWithSelection();
            }
            this.meshMarqueeStart = null;
            this.marqueeRect = null;
            this.ui.contextBar?.refresh();
            this.renderer.requestRender();
            return;
        }

        // Clean up move-drag snapshot
        if (this.moveSnapshot) {
            // An Alt clone-drag leaves fresh clones as the current selection;
            // collapse them so a cloned group doesn't flood the Objects panel.
            if (this.moveClonesActive) {
                for (const id of this.scene.engine!.get_selection()) {
                    this.ui.collapseSubtreeByDefault(id);
                }
            }
            this.moveSnapshot = null;
            this.moveOriginalIds = [];
            this.moveStartBounds = null;
            this.gesturePristine = null;
            this.moveClonesActive = false;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.updateLayerList();
            this.ui.syncWithSelection();
        }
        // Clean up corner radius dragging
        if (this.cornerRadiusDragging) {
            this.cornerRadiusDragging = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.syncWithSelection();
            return;
        }

        // Restore the cursor to match the active tool (a locked creation tool
        // keeps its crosshair; Selection gets the default arrow). A revert to
        // Selection later in this handler re-applies it via setActiveTool.
        this.ui.applyToolCursor();

        if (this.rotateHandleType) {
            this.rotateHandleType = null;
            this.rotateSnapshot = null;
            this.rotateTargetIds = [];
            this.rotatePivot = null;
            this.rotateSingleStartDeg = null;
            this.gesturePristine = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            this.ui.syncWithSelection();
            return;
        }

        if (this.resizeHandleType) {
            this.resizeHandleType = null;
            this.resizeStartBounds = null;
            this.resizeTargetIds = [];
            this.resizeSnapshot = null;
            this.liveResizeBounds = null;
            this.resizeFrame = null;
            this.resizeLocalBounds = null;
            this.liveFrame = null;
            this.gesturePristine = null;
            this.scene.invalidateCache();
            this.scene.autosave?.trigger();
            // Final sync to update layer list
            this.ui.syncWithSelection();
            return;
        }

        const endPos = this.getPos(e);
        const dist = Math.hypot(endPos.x - this.startPos.x, endPos.y - this.startPos.y);
        // Same distance in screen pixels — the marquee-vs-click decision has to
        // feel the same at every zoom level, so it keys off screen travel.
        const screenDist = dist * this.renderer.zoom;

        // Commit direct selection edit
        if (this.ui.activeTool === 'direct' && this.draggingHandleType && this.editingPoints) {
            // Alt-click / convert-tool click on an anchor without dragging:
            // smooth → corner (collapse); corner → smooth (auto handles from
            // neighbors). A real drag already pulled handles via convertingAnchor.
            if (this.convertingAnchor && dist <= 3) {
                const sp = this.editingPoints[this.draggingSubpathIndex];
                const p = sp?.points[this.draggingPointIndex];
                const hadHandles =
                    p &&
                    (p.cp1[0] !== p.x || p.cp1[1] !== p.y || p.cp2[0] !== p.x || p.cp2[1] !== p.y);
                if (p && hadHandles) {
                    p.cp1[0] = p.x;
                    p.cp1[1] = p.y;
                    p.cp2[0] = p.x;
                    p.cp2[1] = p.y;
                    this.pointDragChanged = true;
                } else if (p && sp) {
                    this.autoSmoothAnchorInPlace(
                        sp,
                        this.draggingPointIndex,
                        Boolean(sp.closed)
                    );
                    this.pointDragChanged = true;
                }
            }
            this.commitPointDrag();
            this.draggingPointIndex = -1;
            this.draggingHandleType = null;
            this.convertingAnchor = false;
        }

        // Commit marquee selection
        if (this.marqueeRect && screenDist > DRAG_START_THRESHOLD_PX) {
            const { x, y, w, h } = this.marqueeRect;
            const nodesInRect = this.scene.getVisibleNodes(x, y, x + w, y + h);
            const isShift = e.shiftKey;
            if (!isShift) {
                this.scene.engine!.clear_selection();
            }
            // Filter out locked nodes — they shouldn't be selectable via marquee.
            // Tested against the whole ancestor chain, because the next step
            // promotes a leaf to its topmost group: reading the leaf's own flag
            // let a marquee select a locked group through an unlocked child.
            const groupPromoted = new Set<number>();
            // Inside a group you have entered, a marquee gathers ITS members —
            // the same depth a click there picks. Promoting to the whole group
            // meant the one gesture for "these three, not that one" could not be
            // used on a group's contents at all: you could only ever re-select
            // the group you were already standing in.
            const context = this.marqueeGroupContext;
            let stayedInContext = false;
            for (const id of nodesInRect) {
                if (this.scene.isLockedInTree(id) || !this.scene.isVisibleInTree(id)) continue;
                if (context !== null) {
                    const child = this.findDirectChildContaining(context, id);
                    if (child !== undefined) {
                        groupPromoted.add(child);
                        stayedInContext = true;
                        continue;
                    }
                    // The group being worked in, or one wrapping it, is under
                    // the marquee by definition — selecting it would hand back
                    // the container instead of the members just gathered.
                    if (id === context || this.findDirectChildContaining(id, context) !== undefined)
                        continue;
                }
                // Walk up to find topmost group ancestor
                let promoted = id;
                let current = id;
                while (true) {
                    const parentId = this.scene.getNodeParent(current);
                    if (parentId < 0) break; // no parent (root)
                    const parentNode = this.scene.getNode(parentId);
                    if (parentNode && parentNode.node_type === 'Group') {
                        promoted = parentId;
                    }
                    current = parentId;
                }
                groupPromoted.add(promoted);
            }
            // Keep standing inside the group if that is where the marquee landed.
            if (stayedInContext) this.enteredGroup = context;
            for (const id of groupPromoted) {
                this.scene.selectNode(id, true);
            }
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
        }

        // Commit line / pencil strokes (their own point-based previews).
        if (this.previewLine) {
            this.finalizeLine();
        }
        if (this.pencilPoints) {
            this.finalizePencil();
        }

        // Commit shape creation (use previewRect which already has Shift/Alt constraints applied).
        // Any positive size commits — never floor by world units (old `> 5` discarded
        // a few CSS-px drags at high zoom, e.g. 10000%). Pure 0×0 clicks stay no-ops.
        if (this.previewRect && (this.previewRect.w > 0 || this.previewRect.h > 0)) {
            const { x, y, w, h, tool } = this.previewRect;

            if (tool === 'artboard') {
                // Create a new artboard (frame) and select it, then revert to the
                // selection tool like Figma.
                const id = this.scene.addArtboard(x, y, w, h);
                this.scene.engine!.clear_selection();
                this.renderer.selectedArtboardId = id;
                this.ui.syncWithSelection();
                this.ui.refreshArtboardPanel();
                this.ui.updateLayerList();
                this.maybeRevertTool();
            } else {
                // One transaction: the shape, its style, and the Live Paint group
                // it may join are a single undo step.
                let created: number | undefined;
                this.scene.transaction(() => {
                    let newId: number | undefined;
                    if (tool === 'rect') {
                        newId = this.scene.addRect(x, y, w, h);
                    } else if (tool === 'ellipse') {
                        newId = this.scene.addEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
                    } else if (tool === 'polygon') {
                        newId = this.scene.addPolygon(x + w / 2, y + h / 2, Math.max(w, h) / 2, 6);
                    } else if (tool === 'star') {
                        const r = Math.max(w, h) / 2;
                        newId = this.scene.addStar(x + w / 2, y + h / 2, r, r * 0.4, 5);
                    }
                    if (newId === undefined) return;

                    // Apply the current UI style and select the new shape
                    this.scene.setNodeStyleNoHistory(newId, this.ui.getCurrentStyle());
                    this.joinLatchedContainer(newId);
                    this.scene.engine!.clear_selection();
                    this.scene.selectNode(newId, false);
                    created = newId;
                });
                if (created !== undefined) {
                    this.ui.syncWithSelection();
                    this.maybeRevertTool();
                }
                this.ui.updateLayerList();
            }
        }

        this.dragMode = 'none';
        this.previewRect = null;
        this.previewLine = null;
        this.pencilPoints = null;
        this.marqueeRect = null;
    }

    /** Turn the line-tool preview into a 2-point open path, styled and selected. */
    finalizeLine() {
        const L = this.previewLine;
        this.previewLine = null;
        if (!L) return;
        // Ignore pure clicks (no drag). Screen-space only — a world floor like
        // `< 2` erased short strokes at high zoom.
        if (Math.hypot(L.x2 - L.x1, L.y2 - L.y1) * this.renderer.zoom < 1) return;
        const mk = (x: number, y: number) => ({ x, y, cp1: [x, y], cp2: [x, y] });
        const subpaths = [{ points: [mk(L.x1, L.y1), mk(L.x2, L.y2)], closed: false }];
        this.commitDrawnPath(JSON.stringify(subpaths));
    }

    /** Turn the sampled pencil stroke into an open path, styled and selected. */
    finalizePencil() {
        const pts = this.pencilPoints;
        this.pencilPoints = null;
        if (!pts || pts.length < 2) return;
        const mk = (p: { x: number; y: number }) => ({
            x: p.x,
            y: p.y,
            cp1: [p.x, p.y],
            cp2: [p.x, p.y],
        });
        const subpaths = [{ points: pts.map(mk), closed: false }];
        this.commitDrawnPath(JSON.stringify(subpaths));
    }

    /** Add a freshly drawn path (line/pencil), apply the active style, select it
     *  unless the tool is locked for a multi-stroke session (pen/pencil until
     *  退出编辑) — then leave selection empty so the transform box does not
     *  appear mid-draw.
     */
    private commitDrawnPath(subpathsJson: string) {
        // One transaction so the shape and the group it joins are one undo step.
        this.scene.transaction(() => {
            const newId = this.scene.addPath(subpathsJson);
            this.scene.setNodeStyleNoHistory(newId, this.drawnPathStyle(false));
            this.joinLatchedContainer(newId);
            this.scene.engine!.clear_selection();
            // Locked pen/pencil: keep drawing without a control box on every stroke.
            if (!this.ui.toolLocked) {
                this.scene.selectNode(newId, false);
            }
        });
        this.ui.syncWithSelection();
        this.ui.updateLayerList();
        this.maybeRevertTool();
    }

    /** The active style as a freshly drawn path should wear it. An open path is
     *  stroke-only: a fill shades the region between its endpoints, which is
     *  never what a line, a freehand stroke, or an unfinished pen path meant to
     *  say. A closed path is a shape, so it keeps the active fill. */
    private drawnPathStyle(closed: boolean): string {
        const style = this.ui.getCurrentStyle();
        if (closed) return style;
        try {
            const s = JSON.parse(style);
            s.fills = [];
            return JSON.stringify(s);
        } catch {
            return style; // unparseable — better the raw style than none
        }
    }

    /** After creating a shape, one-shot back to the Selection tool (Figma-style)
     *  unless the tool is locked via double-click. */
    private maybeRevertTool() {
        if (this.ui.toolLocked) return;
        this.ui.setActiveTool('selection');
    }

    /** Capture pristine LOCAL transforms of `ids` for a transform-only gesture,
     *  enabling per-frame fast reset in place of a full-scene deserialize. */
    private captureGesturePristine(ids: number[]) {
        const m = new Map<number, number[]>();
        for (const id of ids) m.set(id, Array.from(this.scene.getNodeLocalTransform(id)));
        this.gesturePristine = m;
    }

    /** Reset the captured gesture targets to their pristine local transforms.
     *  Cheap stand-in for deserialize_scene when only these nodes moved. */
    private resetGesturePristine() {
        if (!this.gesturePristine) return;
        for (const [id, t] of this.gesturePristine) {
            this.scene.engine!.set_node_transform_matrix(id, JSON.stringify(t));
        }
    }

    /**
     * Union of the selected nodes' world bounds, or null if nothing is selected.
     *
     * Measured, not estimated. A single selection's frame comes from
     * `getNodeLocalBounds` and hugs the glyphs; the multi-selection frame used
     * the engine's 0.6em-per-character box, so selecting a centred wordmark with
     * the logo above it drew a frame hanging 15pt off the text's right edge and
     * lied about where the artwork ended. The resize and move gestures start
     * from these same numbers, so the frame you grab and the maths behind it
     * have to be the same box.
     */
    getSelectionBounds(): { x: number; y: number; w: number; h: number } | null {
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 0) return null;

        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const id of selection) {
            const b = this.scene.getMeasuredNodeBounds(id);
            minX = Math.min(minX, b[0]);
            minY = Math.min(minY, b[1]);
            maxX = Math.max(maxX, b[2]);
            maxY = Math.max(maxY, b[3]);
        }
        if (minX === Infinity) return null;
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    /**
     * True when a precise on-canvas control sits under `pos`: a resize, rotate,
     * corner-radius or artboard handle, or a gradient stop.
     *
     * Ruler guides are grabbed before any of these, because they're drawn above
     * the artwork. But a handle is not artwork — it's a control drawn on top of
     * everything, it only exists at that one point, and it only exists while
     * something is selected. A guide, by contrast, can be grabbed anywhere along
     * its full length. So when the two overlap the handle has to win: otherwise a
     * guide parked on a shape's edge makes that edge's handle unreachable, with
     * no way to tell from the cursor why the drag keeps moving the guide.
     */
    hasCanvasControlAt(pos: { x: number; y: number }): boolean {
        if (this.editingNodeId !== null || this.ui.activeTool !== 'selection') return false;
        if (
            this.renderer.selectedArtboardId !== null &&
            this.renderer.artboardHandleHitTest(pos.x, pos.y)
        ) {
            return true;
        }
        if (
            this.ui.gradientEdit.isActive() &&
            this.ui.gradientEdit.hitTest(pos, this.renderer.zoom)
        )
            return true;
        if (this.renderer.selectionOutlineOnly?.()) return false;
        const frame = this.getSelectionFrame();
        if (frame && (this.checkResizeHandle(pos, frame) || this.checkRotateHandle(pos, frame)))
            return true;
        return !!this.checkCornerRadiusHandle(pos);
    }

    checkResizeHandle(
        pos: { x: number; y: number },
        frame?: SelectionFrame | null,
    ): { type: string } | null {
        const F = frame ?? this.getSelectionFrame();
        if (!F) return null;

        // Nearest handle within reach wins, so tiny shapes stay usable.
        let best: { type: string } | null = null;
        let bestDist = 8 / this.renderer.zoom;
        for (const h of this.frameHandles(F)) {
            const d = Math.hypot(pos.x - h.x, pos.y - h.y);
            if (d < bestDist) {
                bestDist = d;
                best = { type: h.type };
            }
        }
        return best;
    }

    // ─── Selection frame (oriented bounding box) ────────────────────────

    /** Map a frame-space point to world space. */
    private framePoint(F: SelectionFrame, fx: number, fy: number): { x: number; y: number } {
        return { x: F.m.a * fx + F.m.c * fy + F.m.e, y: F.m.b * fx + F.m.d * fy + F.m.f };
    }

    /** Apply an affine matrix to a point. */
    private matApply(M: Mat, p: { x: number; y: number }): { x: number; y: number } {
        return { x: M.a * p.x + M.c * p.y + M.e, y: M.b * p.x + M.d * p.y + M.f };
    }

    /** True when the frame's axes are world-axis-aligned with no flip — the
     *  case the legacy AABB resize pipeline (with snapping) handles. */
    private frameIsAxisAligned(F: SelectionFrame): boolean {
        return Math.abs(F.m.b) < 1e-6 && Math.abs(F.m.c) < 1e-6 && F.m.a > 0 && F.m.d > 0;
    }

    /**
     * The selection frame the handles live on. Single node → its local bounds
     * under its world transform, so the frame rotates/skews with the shape.
     * Multi-selection (or unknown local bounds) → axis-aligned union bounds.
     * During a drag the live frame is returned so handles track with zero lag.
     */
    getSelectionFrame(): SelectionFrame | null {
        if (this.liveFrame) return this.liveFrame;
        if (this.liveResizeBounds) {
            const b = this.liveResizeBounds;
            return { w: b.w, h: b.h, m: { a: 1, b: 0, c: 0, d: 1, e: b.x, f: b.y } };
        }
        const selection = this.scene.engine!.get_selection();
        if (selection.length === 1) {
            const id = selection[0];
            const lb = this.getNodeLocalBounds(id);
            if (lb && lb.w > 1e-6 && lb.h > 1e-6) {
                const t = this.scene.getTransform(id); // row-major world [a,b,tx, c,d,ty, …]
                const W: Mat = { a: t[0], b: t[3], c: t[1], d: t[4], e: t[2], f: t[5] };
                return {
                    w: lb.w,
                    h: lb.h,
                    m: this.matMul(W, { a: 1, b: 0, c: 0, d: 1, e: lb.x, f: lb.y }),
                };
            }
        }
        const b = this.getSelectionBounds();
        return b ? { w: b.w, h: b.h, m: { a: 1, b: 0, c: 0, d: 1, e: b.x, f: b.y } } : null;
    }

    /** After a geometry/font resize, translate the node so its local-bounds
     *  top-left lands on the live frame's top-left — keeping the drag anchor
     *  (the handle opposite the one being dragged) fixed. */
    private anchorNodeToFrameTopLeft(id: number) {
        if (!this.liveFrame) return;
        const lb2 = this.getNodeLocalBounds(id);
        if (!lb2) return;
        const wt = this.scene.getTransform(id);
        const W: Mat = { a: wt[0], b: wt[3], c: wt[1], d: wt[4], e: wt[2], f: wt[5] };
        const actual = this.matApply(W, { x: lb2.x, y: lb2.y });
        const target = this.framePoint(this.liveFrame, 0, 0);
        const ddx = target.x - actual.x,
            ddy = target.y - actual.y;
        if (Math.abs(ddx) > 1e-4 || Math.abs(ddy) > 1e-4) {
            const local = this.worldDeltaToLocal(id, ddx, ddy);
            this.scene.engine!.move_node(id, local.dx, local.dy);
        }
    }

    /**
     * A node's bounds in its own local (pre-transform) space, mirroring what
     * the renderer draws for the selection outline. Groups union their
     * children's local bounds through the children's local transforms.
     */
    getNodeLocalBounds(
        id: number,
        depth = 0,
    ): { x: number; y: number; w: number; h: number } | null {
        if (depth > 16) return null;
        if (this.scene.getNodeType(id) === 3) {
            // Boolean Group: the operands are consumed by the op and never
            // painted, so the frame follows the resolved outline. Without this
            // the selection box (and the resize handles on it) would span the
            // operand union — visibly wider than the shape it is framing.
            const bb = this.scene.getBooleanLocalBounds(id);
            if (bb) return bb;
            // Group
            const kids = this.scene.getNodeChildren(id);
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            for (const kid of kids) {
                const lb = this.getNodeLocalBounds(kid, depth + 1);
                if (!lb) continue;
                const l = this.scene.getNodeLocalTransform(kid); // column-major
                const M: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };
                for (const [cx, cy] of [
                    [lb.x, lb.y],
                    [lb.x + lb.w, lb.y],
                    [lb.x + lb.w, lb.y + lb.h],
                    [lb.x, lb.y + lb.h],
                ]) {
                    const p = this.matApply(M, { x: cx, y: cy });
                    minX = Math.min(minX, p.x);
                    minY = Math.min(minY, p.y);
                    maxX = Math.max(maxX, p.x);
                    maxY = Math.max(maxY, p.y);
                }
            }
            return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        const geo = this.scene.getNodeGeometry(id);
        if (!geo) return null;
        if (geo.Rect) return { x: 0, y: 0, w: geo.Rect.width, h: geo.Rect.height };
        if (geo.Image) return { x: 0, y: 0, w: geo.Image.width, h: geo.Image.height };
        if (geo.Ellipse) {
            const { radius_x: rx, radius_y: ry } = geo.Ellipse;
            return { x: -rx, y: -ry, w: 2 * rx, h: 2 * ry };
        }
        if (geo.Path) {
            const b = this.renderer.calculatePathBounds({
                subpaths: this.scene.getResolvedSubpaths(id),
            });
            return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY };
        }
        if (geo.Text) {
            const b = this.renderer.getTextLocalBounds(id);
            if (b) return b;
            // Fallback without fonts: ASCII ≈0.6em, CJK ≈1em (matches engine).
            let em = 0;
            for (const line of geo.Text.content.split('\n')) {
                let lineEm = 0;
                for (const ch of line) {
                    const cp = ch.codePointAt(0) ?? 0;
                    lineEm +=
                        cp <= 0x7f
                            ? 0.6
                            : (cp >= 0x2e80 && cp <= 0x9fff) ||
                                (cp >= 0xac00 && cp <= 0xd7af) ||
                                (cp >= 0xff01 && cp <= 0xff60)
                              ? 1
                              : 0.85;
                }
                em = Math.max(em, lineEm);
            }
            const approxW = Math.max(em, 1) * geo.Text.font_size;
            return { x: 0, y: -geo.Text.font_size, w: approxW, h: geo.Text.font_size };
        }
        return null;
    }

    /** The 8 resize handle positions of a frame, in world space. */
    private frameHandles(F: SelectionFrame): Array<{ type: string; x: number; y: number }> {
        const mw = F.w / 2,
            mh = F.h / 2;
        const spots: Array<[string, number, number]> = [
            ['nw', 0, 0],
            ['n', mw, 0],
            ['ne', F.w, 0],
            ['w', 0, mh],
            ['e', F.w, mh],
            ['sw', 0, F.h],
            ['s', mw, F.h],
            ['se', F.w, F.h],
        ];
        return spots.map(([type, fx, fy]) => ({ type, ...this.framePoint(F, fx, fy) }));
    }

    /**
     * Detect the rotate zone: the ring just *outside* a corner of the selection
     * frame. Returns the nearest corner within reach, or null. Only fires when
     * the cursor is outside the frame (so it never conflicts with move/resize),
     * giving the familiar "nudge past the resize handle → rotate" affordance.
     */
    checkRotateHandle(
        pos: { x: number; y: number },
        frame?: SelectionFrame | null,
    ): { type: string } | null {
        const F = frame ?? this.getSelectionFrame();
        if (!F) return null;

        // Must be outside the frame — inside is move/resize territory.
        const p = this.matApply(this.matInv(F.m), pos);
        if (p.x >= 0 && p.x <= F.w && p.y >= 0 && p.y <= F.h) return null;

        const outer = 24 / this.renderer.zoom;
        const corners: Array<[string, number, number]> = [
            ['nw', 0, 0],
            ['ne', F.w, 0],
            ['se', F.w, F.h],
            ['sw', 0, F.h],
        ];

        let best: { type: string } | null = null;
        let bestDist = outer;
        for (const [type, fx, fy] of corners) {
            const c = this.framePoint(F, fx, fy);
            const d = Math.hypot(pos.x - c.x, pos.y - c.y);
            if (d < bestDist) {
                bestDist = d;
                best = { type };
            }
        }
        return best;
    }

    /**
     * Rotate every target about {@link rotatePivot} by `deltaRad` (world space),
     * starting from the pre-drag snapshot. Uses full matrix composition so it is
     * correct for any node, nesting, and pivot:
     *   L' = parentWorld⁻¹ · R(θ, pivot) · parentWorld · L₀
     */
    private applyRotationDrag(deltaRad: number) {
        if (!this.rotateSnapshot || !this.rotatePivot) return;
        // Reset only the rotated targets to pristine (rotation never adds or
        // removes nodes), rather than deserializing the whole scene each frame.
        this.resetGesturePristine();

        const cos = Math.cos(deltaRad),
            sin = Math.sin(deltaRad);
        const px = this.rotatePivot.x,
            py = this.rotatePivot.y;
        // World rotation about the pivot, DOMMatrix form {a,b,c,d,e,f}:
        //   x' = a·x + c·y + e,  y' = b·x + d·y + f
        const R: Mat = {
            a: cos,
            b: sin,
            c: -sin,
            d: cos,
            e: px - px * cos + py * sin,
            f: py - px * sin - py * cos,
        };

        for (const id of this.rotateTargetIds) {
            const parentId = this.scene.engine!.get_node_parent(id);
            let PW: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
            if (parentId >= 0) {
                // getTransform is row-major global [a,b,tx, c,d,ty, …]
                const t = this.scene.getTransform(parentId);
                PW = { a: t[0], b: t[3], c: t[1], d: t[4], e: t[2], f: t[5] };
            }
            // getNodeLocalTransform is column-major [a,b,0, c,d,0, e,f,1]
            const l = this.scene.getNodeLocalTransform(id);
            const L0: Mat = { a: l[0], b: l[1], c: l[3], d: l[4], e: l[6], f: l[7] };

            const Lp = this.matMul(this.matInv(PW), this.matMul(R, this.matMul(PW, L0)));
            const col = [Lp.a, Lp.b, 0, Lp.c, Lp.d, 0, Lp.e, Lp.f, 1];
            this.scene.engine!.set_node_transform_matrix(id, JSON.stringify(col));
        }

        // Rotation is transform-only for every node type (local geometry is
        // untouched; the new matrix is applied at draw time), so renderer
        // path/shader caches and group sprites stay valid — a rotated cached
        // group follows the delta transform instead of being re-recorded.
        this.scene.invalidateCacheTransformOnly(this.rotateTargetIds);
        this.ui.syncWithSelection({ gesture: true });
    }

    /** Compose two affine matrices: result applies B first, then A. */
    private matMul(A: Mat, B: Mat): Mat {
        return {
            a: A.a * B.a + A.c * B.b,
            b: A.b * B.a + A.d * B.b,
            c: A.a * B.c + A.c * B.d,
            d: A.b * B.c + A.d * B.d,
            e: A.a * B.e + A.c * B.f + A.e,
            f: A.b * B.e + A.d * B.f + A.f,
        };
    }

    /** Invert an affine matrix (falls back to identity-ish on a singular matrix). */
    private matInv(A: Mat): Mat {
        const det = A.a * A.d - A.b * A.c;
        const inv = Math.abs(det) < 1e-12 ? 0 : 1 / det;
        return {
            a: A.d * inv,
            b: -A.b * inv,
            c: -A.c * inv,
            d: A.a * inv,
            e: (A.c * A.f - A.d * A.e) * inv,
            f: (A.b * A.e - A.a * A.f) * inv,
        };
    }

    /** Rotate cursor for a corner of the frame. Product `rotate_corner.svg` is
     *  the NW glyph; offsets match RCB SelectionChrome (nw=0, ne=90, se=180,
     *  sw=270) plus the frame's world rotation. */
    private rotateCursorForCorner(type: string, F: SelectionFrame): string {
        const iconDeg =
            type === 'ne' ? 90 : type === 'se' ? 180 : type === 'sw' ? 270 : 0;
        const frameDeg = (Math.atan2(F.m.b, F.m.a) * 180) / Math.PI;
        return this.rotateCursorForIconAngle(iconDeg + frameDeg);
    }

    /**
     * Build (and cache) the rotate cursor. `deg` is the CSS rotation applied to
     * the NW-base `rotate_corner.svg` glyph (not a corner bearing).
     * During an in-flight rotate drag, pass `bearingDeg + 135` so the open
     * corner of the L keeps facing the selection center.
     */
    private rotateCursorForIconAngle(deg: number): string {
        const r = ((Math.round(deg / 15) * 15) % 360 + 360) % 360;
        const key = `rot:${r}`;
        if (this.cursorCache[key]) return this.cursorCache[key];
        // apps/web/src/assets/svg/editor/rotate_corner.svg — NW glyph.
        const d =
            'M22.4789 9.45728L25.9935 12.9942L22.4789 16.5283V14.1032C18.126 14.1502 14.6071 17.6737 14.5675 22.0283H17.05L13.513 25.543L9.97889 22.0283H12.5674C12.6071 16.5691 17.0214 12.1503 22.4789 12.1031V9.45728Z';
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
            `<g transform="rotate(${r} 16 16)">` +
            `<path d="${d}" fill="#fff" transform="translate(0.75 0.75)"/>` +
            `<path d="${d}" fill="#111"/>` +
            `</g></svg>`;
        const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`;
        this.cursorCache[key] = uri;
        return uri;
    }

    /** @deprecated Use {@link rotateCursorForIconAngle}; kept name for call sites
     *  that pass a center→pointer bearing (adds the NW-base +135° offset). */
    private rotateCursorForAngle(bearingDeg: number): string {
        return this.rotateCursorForIconAngle(bearingDeg + 135);
    }

    /** Resize cursor for a handle: native CSS cursors on axis-aligned frames,
     *  an angle-oriented double arrow on rotated/skewed frames. */
    private resizeCursorFor(type: string, F: SelectionFrame): string {
        if (this.frameIsAxisAligned(F)) {
            const cursorMap: Record<string, string> = {
                nw: 'nwse-resize',
                se: 'nwse-resize',
                ne: 'nesw-resize',
                sw: 'nesw-resize',
                n: 'ns-resize',
                s: 'ns-resize',
                e: 'ew-resize',
                w: 'ew-resize',
            };
            return cursorMap[type] || 'default';
        }
        // Resize direction in frame space → world space via the linear part.
        const dx = type.includes('e') ? 1 : type.includes('w') ? -1 : 0;
        const dy = type.includes('s') ? 1 : type.includes('n') ? -1 : 0;
        const wx = F.m.a * dx + F.m.c * dy;
        const wy = F.m.b * dx + F.m.d * dy;
        const deg = Math.atan2(wy, wx) * (180 / Math.PI);
        // Double arrow is symmetric — fold to [0,180) before caching.
        const r = (((Math.round(deg / 10) * 10) % 180) + 180) % 180;
        const key = `arrow:${r}`;
        if (this.cursorCache[key]) return this.cursorCache[key];
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
            `<g transform="rotate(${r} 11 11)">` +
            `<path d="M5 11 H17" stroke="#fff" stroke-width="4.2" stroke-linecap="round"/>` +
            `<polygon points="1.5,11 6.8,7.2 6.8,14.8" fill="#fff"/>` +
            `<polygon points="20.5,11 15.2,7.2 15.2,14.8" fill="#fff"/>` +
            `<path d="M6 11 H16" stroke="#111" stroke-width="1.6"/>` +
            `<polygon points="2.8,11 7,8.2 7,13.8" fill="#111"/>` +
            `<polygon points="19.2,11 15,8.2 15,13.8" fill="#111"/>` +
            `</g></svg>`;
        const uri = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 11 11, auto`;
        this.cursorCache[key] = uri;
        return uri;
    }

    checkCornerRadiusHandle(pos: { x: number; y: number }): { nodeId: number } | null {
        const selection = this.scene.getSelection();
        if (selection.length !== 1) return null;

        const id = selection[0];
        const node = this.scene.getNode(id);
        // Groups report a placeholder Rect{0,0}; require positive dimensions so
        // only real rectangles expose draggable corner-radius handles.
        if (!node?.geometry.Rect || node.geometry.Rect.width <= 0 || node.geometry.Rect.height <= 0)
            return null;

        const rect = node.geometry.Rect;
        const radius = node.style.corner_radius || 0;
        const transform = this.scene.getTransform(id);

        // Convert world position to local space
        // Skia row-major: [a, b, tx, c, d, ty, 0, 0, 1]
        const a = transform[0],
            b = transform[1],
            tx = transform[2];
        const c = transform[3],
            d = transform[4],
            ty = transform[5];

        const det = a * d - b * c;
        if (Math.abs(det) < 1e-6) return null;
        const invDet = 1 / det;
        const ia = d * invDet;
        const ib = -b * invDet;
        const ic = -c * invDet;
        const id_ = a * invDet;
        const itx = (b * ty - d * tx) * invDet;
        const ity = (c * tx - a * ty) * invDet;

        const lx = ia * pos.x + ib * pos.y + itx;
        const ly = ic * pos.x + id_ * pos.y + ity;

        const handles = cornerRadiusHandles(rect.width, rect.height, radius, this.renderer.zoom);
        if (!handles) return null;
        return grabsCornerHandle(handles, lx, ly) ? { nodeId: id } : null;
    }

    /**
     * Find the node a click at `pos` should select.
     *
     * Context-aware: inside a group you have entered, you select that group's
     * children; otherwise you select the topmost group the hit belongs to.
     */
    private getTargetIdForHit(
        pos: { x: number; y: number },
        deepSelect: boolean = false,
    ): number | undefined {
        const rawHitId = this.scene.hitTest(pos.x, pos.y);
        // Treat null the same as undefined (wasm Option None).
        if (rawHitId == null) return undefined;

        if (deepSelect) {
            return rawHitId;
        }

        // Inside a group you have entered, a click picks that group's children.
        // Outside of one, it picks whole top-level groups.
        const context = this.currentGroupContext();
        if (context === null) return this.scene.hitTestGrouped(pos.x, pos.y);

        // Pick the child of the entered group that contains the hit.
        const child = this.findDirectChildContaining(context, rawHitId);
        if (child !== undefined) return child;

        // Clicking outside the group you are in leaves it, the same way it does
        // in Illustrator and Figma — otherwise the context would outlive any
        // gesture that could plausibly end it.
        this.enteredGroup = null;
        return this.scene.hitTestGrouped(pos.x, pos.y);
    }

    /**
     * The group clicks currently resolve inside, or null for the top level.
     *
     * Being inside one is a two-part fact: the user entered it, AND the
     * selection still lives there. Selecting something elsewhere (the Objects
     * panel, Select All, an undo that took the group away) ends it, so a stale
     * `enteredGroup` can never keep promoting clicks to the wrong depth.
     */
    private currentGroupContext(): number | null {
        const group = this.enteredGroup;
        if (group === null) return null;
        if (this.scene.getNode(group)?.node_type !== 'Group') {
            this.enteredGroup = null;
            return null;
        }
        const selection = this.scene.engine!.get_selection();
        if (
            selection.length === 0 ||
            this.findDirectChildContaining(group, selection[0]) === undefined
        ) {
            this.enteredGroup = null;
            return null;
        }
        return group;
    }

    /** The node's parent if it is a Group, else null — the context left behind
     *  when you step out of a group one level. */
    private groupParentOf(id: number): number | null {
        const parent = this.scene.getNodeParent(id);
        if (parent === -1) return null;
        return this.scene.getNode(parent)?.node_type === 'Group' ? parent : null;
    }

    /** Convert a text node to a path node (destructive). Parses the font with
     *  opentype.js off the cached TTF, so it's async (font may need fetching). */
    async createOutlines(id: number) {
        const geo = this.scene.getNodeGeometry(id)?.Text;
        if (!geo) return;
        const subpaths = await textNodeToSubpaths(geo, this.renderer.ck);
        if (subpaths && subpaths.length > 0) {
            this.scene.replaceGeometryWithPath(id, subpaths);
            this.ui.syncWithSelection();
            this.ui.updateLayerList();
            this.renderer.requestRender();
        }
    }
}
