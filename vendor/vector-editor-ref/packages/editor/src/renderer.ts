import type {
    Canvas,
    CanvasKit,
    Paint,
    Path,
    PictureRecorder,
    Shader,
    SkPicture,
    Surface,
} from 'canvaskit-wasm';

/** A Live Paint outline point: anchor + incoming/outgoing bézier handles. */
type OutlinePt = { x: number; y: number; cp1: number[]; cp2: number[] };

import { adaptiveTileSources, maxTileScale, rasterizeAdaptiveTile } from './adaptive_tiles';
import { appendSubpathsToPath, invertAffine, nodeToWorldPath } from './boolean_ops';
import { cornerRadiusHandles } from './corner_handles';
import { dashIntervals } from './dash';
import { neighborGaps } from './equal_spacing';
import {
    buildFontProvider,
    getFontData,
    isFontLoaded,
    loadGoogleFontData,
    onFontLoaded,
} from './fonts';
import type { Cubic } from './mesh_geom';
import {
    effectiveHandle,
    hEdgeCubic,
    meanColor,
    meshBounds,
    meshContentHash,
    subdivisionCounts,
    tessellate,
    vEdgeCubic,
} from './mesh_geom';
import type { MeshGradient, MeshVertex } from './types';

/**
 * Map a numeric weight + italic flag to CanvasKit's font-style enums.
 *
 * Shared by drawing and measuring: if the two ever disagreed about which face
 * a node uses, measured widths would describe a different rendering than the
 * one on screen — the sort of drift that only shows up as layout that looks
 * subtly wrong. CanvasKit falls back gracefully when the family lacks the
 * requested variant.
 */
function ckFontStyle(ck: CanvasKit, fontWeight: number, italic: boolean) {
    const weight =
        fontWeight >= 700
            ? ck.FontWeight.Bold
            : fontWeight >= 600
              ? ck.FontWeight.SemiBold
              : fontWeight >= 500
                ? ck.FontWeight.Medium
                : fontWeight <= 300
                  ? ck.FontWeight.Light
                  : ck.FontWeight.Normal;
    return { weight, slant: italic ? ck.FontSlant.Italic : ck.FontSlant.Upright };
}

/** Helper for efficient zero-copy parsing of the WASM binary render buffer. */
class BinaryReader {
    view: DataView;
    offset: number = 0;
    private decoder = new TextDecoder();

    constructor(view: DataView) {
        this.view = view;
    }

    u8() {
        const v = this.view.getUint8(this.offset);
        this.offset += 1;
        return v;
    }
    u16() {
        const v = this.view.getUint16(this.offset, true);
        this.offset += 2;
        return v;
    }
    u32() {
        const v = this.view.getUint32(this.offset, true);
        this.offset += 4;
        return v;
    }
    f32() {
        const v = this.view.getFloat32(this.offset, true);
        this.offset += 4;
        return v;
    }

    f32Array(n: number): Float32Array {
        // The protocol keeps every field 4-byte aligned relative to the buffer
        // start, so a zero-copy view works whenever the WASM allocation itself
        // is 4-byte aligned (true in practice, but not guaranteed for Vec<u8>).
        const byteOffset = this.view.byteOffset + this.offset;
        this.offset += n * 4;
        if (byteOffset % 4 === 0) {
            return new Float32Array(this.view.buffer, byteOffset, n);
        }
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            arr[i] = this.view.getFloat32(byteOffset + i * 4, true);
        }
        return arr;
    }

    string(): string {
        const len = this.u32();
        const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
        this.offset += len;
        // Align to 4 bytes
        this.offset = (this.offset + 3) & ~3;
        return this.decoder.decode(bytes);
    }
}

import type { InputManager } from './input';
import type { Artboard } from './types';
import type { WasmScene } from './wasm_scene';

/** Resize-handle direction for an artboard. */
export type ArtboardHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

// Render protocol (see engine/src/lib.rs "Render Protocol"). These MUST match
// the RENDER_PROTOCOL_MAGIC / RENDER_PROTOCOL_VERSION constants the engine emits.
// Bump EXPECTED_RENDER_PROTOCOL_VERSION here in lockstep with any change to the
// render-buffer layout on either side; a mismatch means engine/pkg is stale
// (rebuild wasm) or renderer.ts is out of date.
const RENDER_PROTOCOL_MAGIC = 0x31434556; // ASCII "VEC1", little-endian
const EXPECTED_RENDER_PROTOCOL_VERSION = 1; // must match the engine's RENDER_PROTOCOL_VERSION

/** One decoded effect record from the render buffer. */
interface EffectRecord {
    kind: number; // 0 = blur, 1 = drop shadow, 2 = color matrix
    radius: number;
    radiusY: number; // kind 0: y-axis blur sigma (anisotropic); = radius when isotropic
    dx: number;
    dy: number;
    r: number;
    g: number;
    b: number;
    a: number;
    matrix?: number[]; // 20 floats, for kind 2
    linearRGB?: boolean; // for kind 2: apply matrix in linearRGB space
}

export class Renderer {
    /** Memo for {@link getTextLocalBounds} — laying a paragraph out per selected
     *  text node per frame is not free, and the answer only moves when the text
     *  or its styling does. */
    private _textWidthMemo = new Map<string, { width: number; height: number; baseline: number }>();
    /**
     * Fixed layout width for wrap-mode text (Figma-style auto-height box).
     * When set, Paragraph lays out at this width and the selection frame hugs
     * the box; E/W mid-handles write here instead of scaling font_size.
     * Cleared / absent ⇒ hug content (auto-width).
     */
    private _textLayoutWidths = new Map<number, number>();

    /** Fixed wrap width for a text node, or `undefined` when auto-width. */
    getTextLayoutWidth(id: number): number | undefined {
        const w = this._textLayoutWidths.get(id);
        return w != null && w > 0 ? w : undefined;
    }

    /** Set / clear wrap layout width (pass `null` or ≤0 to return to auto-width). */
    setTextLayoutWidth(id: number, width: number | null | undefined): void {
        if (width == null || !(width > 0)) {
            this._textLayoutWidths.delete(id);
        } else {
            this._textLayoutWidths.set(id, width);
        }
        this._textWidthMemo.clear();
        this.invalidateScenePicture();
    }

    /** Drop wrap width when a Kit node is removed. */
    clearTextLayoutWidth(id: number): void {
        if (this._textLayoutWidths.delete(id)) {
            this._textWidthMemo.clear();
            this.invalidateScenePicture();
        }
    }

    /**
     * Local-space bounding box of a text node's rendered glyphs, used for the
     * selection frame.
     *
     * The width is measured the way the glyphs are actually drawn — same font
     * provider, family, weight, slant and letter spacing the renderer hands the
     * Paragraph API. Measuring with a default typeface and no letter spacing
     * (which is what this used to do) draws the frame around a string nobody is
     * looking at: set a display face or any letter spacing and the text visibly
     * runs out past its own selection box.
     *
     * Vertical extent matches drawParagraph: origin is the first-line baseline,
     * top is `-getAlphabeticBaseline()`, height is `getHeight()` (ascent +
     * descent + line gaps). Using `-font_size…0` left CJK / descenders outside
     * the control box.
     */
    getTextLocalBounds(id: number): { x: number; y: number; w: number; h: number } | null {
        const node = this.scene.getNode(id);
        if (!node?.geometry.Text) return null;
        const geo = node.geometry.Text;
        const fontSize = geo.font_size;
        const lineHeight = geo.line_height || 1.2;
        const lines = (geo.content || '').split('\n');
        const layoutWidth = this.getTextLayoutWidth(id);

        // JSON, not a delimiter join: the content can contain anything,
        // including whatever separator seemed safe.
        const key = JSON.stringify([
            geo.content,
            fontSize,
            geo.font_family ?? '',
            lineHeight,
            geo.font_weight ?? 400,
            geo.italic ?? false,
            geo.letter_spacing ?? 0,
            layoutWidth ?? 0,
        ]);
        let measured = this._textWidthMemo.get(key);
        if (!measured) {
            // measureText returns null until a font provider exists; fall back
            // to the em estimate rather than reporting a zero-width frame.
            const m = this.measureText(geo, layoutWidth);
            if (m && m.width > 0) {
                measured = m;
                // Bounded: a document can hold a lot of text, and this only
                // needs to cover what is on screen right now.
                if (this._textWidthMemo.size > 512) this._textWidthMemo.clear();
                this._textWidthMemo.set(key, measured);
            }
        }
        // No font provider yet: fall back to the engine's em estimate — of the
        // LONGEST LINE, which is what the engine measures. Estimating the whole
        // content as one run made a paragraph's frame as wide as all its lines
        // laid end to end.
        let width = measured?.width ?? 0;
        let height = measured?.height ?? 0;
        let baseline = measured?.baseline ?? 0;
        if (width <= 0) {
            const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
            width = longest * fontSize * 0.6;
        }
        if (height <= 0) {
            height = fontSize + (lines.length - 1) * fontSize * lineHeight;
        }
        if (baseline <= 0) {
            // Approximate ascent when Paragraph metrics aren't available yet.
            baseline = fontSize * 0.8;
        }
        // Fixed wrap box: frame width is the layout width (Paragraph aligns
        // inside it). Auto-width: hug the measured run and shift for align.
        if (layoutWidth != null) {
            width = layoutWidth;
            return { x: 0, y: -baseline, w: width, h: height };
        }
        const offsetX = geo.text_align === 1 ? -width / 2 : geo.text_align === 2 ? -width : 0;
        return { x: offsetX, y: -baseline, w: width, h: height };
    }

    ck: CanvasKit;
    canvas: HTMLCanvasElement;
    scene: WasmScene;
    surface: Surface | null;
    // CanvasKit WebGL context handles — typed as `number` (opaque GL context IDs)
    private glContext: number = 0;
    private grContext: unknown = null;
    isRunning: boolean;
    zoom: number;
    pan: { x: number; y: number };
    inputManager: InputManager | null = null;
    /** Ruler/guide controller — asked to redraw its strips after each frame. */
    guidesController: { syncRulers(): void } | null = null;
    /** Face ID currently being hovered by the paint bucket tool (or -1). */
    hoverFaceId: number = -1;
    hoverEdgeId: number = -1;
    /** True only for the read-back frame of `sampleScreenColor`, which must not
     *  include the paint bucket's own hover tint. */
    private _sampling = false;
    /** UI-level selected artboard (drawn highlighted with resize handles). */
    selectedArtboardId: number | null = null;
    /**
     * Soft plate focus (occupied artboard / bound child selected) — blue stroke
     * only, no handles. Same geometry as idle stroke so it cannot drift from the
     * plate (product SVG soft edge used to misalign vs Kit).
     */
    softArtboardId: number | null = null;
    /**
     * Product hook: when true, selection paints the outline only (no resize /
     * rotate / corner-radius handle squares). Used for empty generator plates.
     */
    selectionOutlineOnly: (() => boolean) | null = null;
    /**
     * Product hook: world-space artboard clip for a Kit node (RCB clipContent).
     * Return null to draw unclipped. Applied in world space before the node
     * local transform.
     */
    getNodeArtboardClip:
        | ((nodeId: number) => { x: number; y: number; w: number; h: number } | null)
        | null = null;
    /**
     * Product hook: draw after scene ink, before selection chrome (e.g. empty
     * generator Lucide glyphs).
     */
    drawProductSceneOverlay:
        | ((canvas: Canvas, dpr: number) => void)
        | null = null;

    // ─── Cached Resources (avoid per-frame allocation) ───
    private paint: Paint | null = null;

    // ─── Dirty-frame gating ───
    /** When false, the rAF loop skips rendering. Set to true by requestRender(). */
    private _needsRender = true;
    /** One-shot guard so a render-protocol desync logs once, not every frame. */
    private _protocolDesyncWarned = false;
    /** Node id of the text being edited inline (skipped while its overlay is up). */
    editingTextId: number | null = null;
    private get _editingTextId(): number | null {
        return this.editingTextId;
    }
    /** Dedicated SrcIn paint for compositing masked-content layers. */
    private _maskPaint: Paint | null = null;
    /** Stack of open mask spans matching CMD_BEGIN_MASK / CMD_END_MASK nesting.
     *  `mode` is the mask_type (0 = alpha, 1 = luminance, 2 = geometric clip).
     *  For mode 2, `pendingClip` is true until the mask shape's DRAW_NODE has
     *  been captured as a canvas clip; `converted` marks a mode-2 span that
     *  fell back to the alpha saveLayer protocol (mask node wasn't a plain
     *  shape). For modes 0/1, `pendingLayer` is true until the mask/luma
     *  layers have been opened — opening is deferred to the mask shape's
     *  DRAW_NODE record so the layers can be BOUNDED to the mask's geometry
     *  (`bounds`, local to the surrounding group space) instead of allocating
     *  full-viewport textures per masked span. */
    private _maskStack: {
        mode: number;
        pendingClip: boolean;
        pendingLayer: boolean;
        converted: boolean;
        bounds: ReturnType<CanvasKit['LTRBRect']> | null;
    }[] = [];
    /** Dedicated paint with luminance→alpha color filter for luminance masks. */
    private _lumaPaint: Paint | null = null;
    /** True while rendering into an offscreen surface for PNG export. */
    private _exporting = false;
    /** World-space bounds to export (defaults to the primary artboard). */
    private _exportBounds: { x: number; y: number; w: number; h: number } | null = null;
    /** Solid background to fill behind exported content (null = transparent). */
    private _exportBackground: { r: number; g: number; b: number; a: number } | null = null;
    /**
     * True while rendering the supersampled export pass. Fill/stroke anti-aliasing
     * is disabled so adjacent shapes tile perfectly at the supersampled
     * resolution; the final high-quality downscale reintroduces clean edge
     * anti-aliasing (SSAA). This is what removes the hairline "seam" between two
     * abutting fills that a single-sample, per-shape-AA raster leaves behind.
     */
    private _exportNoAA = false;

    // ─── Path object cache (avoid rebuilding CanvasKit paths every frame) ───
    private _pathCache: Map<
        number,
        { path: ReturnType<CanvasKit['Path']['prototype']['copy']>; fillRule: number }
    > = new Map();

    // Geometric-clip paths (mask_type 2), already node-transformed, keyed by
    // node id — building one costs a path copy + transform in wasm, which
    // shows up at 60fps × several clip spans. Invalidated with _pathCache.
    private _clipPathCache: Map<number, { path: Path; key: string }> = new Map();

    /** Typefaces built from loaded font data, for text-on-path RSXform layout. */
    private _typefaceCache = new Map<
        string,
        ReturnType<CanvasKit['Typeface']['MakeFreeTypeFaceFromData']> | null
    >();

    // ─── Drag-layer cache ───
    // Re-recording every node's draw commands is CPU-bound (~12µs/node), so
    // dragging in a large scene can't hit 60fps by caching shaders alone.
    // While a selection of ROOT nodes is dragged, the static rest of the scene
    // is snapshotted once into two GPU textures — content below and content
    // above the moving nodes in z — and each drag frame only blits those and
    // re-records the moving subtree. Built by beginDragLayerCache(), dropped
    // on drag end or any full cache invalidation.
    private _dragLayer: {
        below: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null;
        above: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null;
        zoom: number;
        panX: number;
        panY: number;
        dpr: number;
        width: number;
        height: number;
    } | null = null;
    /** Observes the canvas's CSS box so the drawing buffer resyncs on any
     *  layout change, not just window resizes. */
    private _resizeObserver: ResizeObserver | null = null;
    /** Ids (moving roots + full subtrees) re-recorded live during a cached drag. */
    private _dragSubtree: Set<number> | null = null;
    private _dragMovingRoots: number[] = [];
    /** Set while rendering the below/above snapshot passes. */
    private _dragSnapshotPass: 'below' | 'above' | null = null;

    // ─── Group sprite cache ───
    // Command recording is CPU-bound (~12µs/node), so scenes with many heavy
    // groups can't be re-recorded every frame at 60fps. Each big ROOT group is
    // baked once into a GPU texture ("sprite") at the current device scale;
    // frames then draw one image per group instead of its whole subtree.
    // Sprites follow their group's transform (delta vs bake time), re-bake
    // when the zoom settles at a meaningfully different scale, and drop on
    // any content mutation (full invalidation) or a targeted edit inside the
    // group. When the needed on-screen resolution exceeds a sprite's texture
    // cap (deep zoom), the group falls back to direct rendering — few groups
    // are visible then, so direct is cheap.
    private _groupSprites: Map<
        number,
        {
            img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>;
            surface: Surface;
            /** Padded world bounds at bake time. */
            x: number;
            y: number;
            w: number;
            h: number;
            bakeTransform: Float32Array;
            /** Device px per world unit the sprite was baked at. */
            scale: number;
        }
    > = new Map();
    /** Descendant id → cached root id, for stream exclusion + targeted drops. */
    private _spriteSubtreeIndex: Map<number, number> = new Map();
    /** Roots checked and found too small to be worth caching. */
    private _spriteIneligible: Set<number> = new Set();
    /** Roots queued for (re-)bake on the next settle tick. */
    private _spriteWanted: Set<number> = new Set();
    private _spriteBakeTimer: number | null = null;
    /** Root being baked right now (its opacity is applied at draw time, not baked in). */
    private _spriteBakeRootId: number | null = null;
    /** Subtree filter for the sprite-bake render pass. */
    private _bakeSubset: Set<number> | null = null;
    /**
     * Smallest subtree worth baking into a sprite.
     *
     * The cost this trades against is command re-recording at ~12us/node, and
     * what matters is the TOTAL nodes re-recorded per frame, not the size of any
     * one group - 100 groups of 13 nodes cost the same as 13 groups of 100. The
     * previous floor of 30 was set thinking about single heavy groups, and it
     * silently excluded the most common shape of imported artwork: a mascot,
     * icon or logo is typically 10-30 paths. Dragging 100 such groups (1300
     * nodes) re-recorded all of them every frame - measured 43.9ms/frame, 23fps,
     * with zero sprites baked. At a floor of 8 all 100 bake and the same drag
     * runs at 16.7ms/frame.
     *
     * 8 nodes is ~96us of recording versus a few us to blit a bitmap, so the
     * bitmap wins comfortably from here up. Below it the texture isn't worth its
     * bake and memory. Sprite count stays bounded regardless: only on-screen
     * roots bake, and they bake on a debounced, budgeted tick.
     */
    private static readonly SPRITE_MIN_SUBTREE = 8;
    // Per-sprite texture budget. 4096² ≈ 64 MB RGBA, but only groups on screen
    // bake, and at the deep zoom where a group needs this many pixels only one
    // or two are visible — so peak memory stays bounded while a zoomed-in group
    // can bake sharp enough to avoid an upscaled (pixelated) sprite.
    private static readonly SPRITE_MAX_DIM = 4096;
    private static readonly SPRITE_MAX_PIXELS = 16_000_000;
    // A sprite is drawn (rather than falling back to direct vector rendering)
    // only while the on-screen scale is within this factor of the baked scale.
    // Kept tight so an upscaled sprite never shows visible softening/pixelation:
    // past it, the group renders as sharp vectors (few groups are visible when
    // zoomed in, so direct is cheap), and a re-bake at the new scale is queued.
    private static readonly SPRITE_USABLE_UPSCALE = 1.15;

    // ─── Gradient shader cache ───
    private _gradientCache: Map<string, ReturnType<CanvasKit['Shader']['MakeLinearGradient']>> =
        new Map();
    // Decoded images keyed by engine image id. Images are immutable and
    // content-addressed, so an id maps to stable bytes for the life of a
    // document — the cache survives edits/undo and is only cleared on a full
    // document replacement (clearImageCache), where ids may be reused.
    private _imageCache: Map<number, ReturnType<CanvasKit['MakeImageFromEncoded']> | null> =
        new Map();
    private _imagePaint: Paint | null = null;
    // Zoom-adaptive filter-tile overrides: engine image id → CanvasKit image
    // re-baked at `scale` px per SVG unit. When present, drawing uses this
    // instead of the fixed-scale PNG registered at import, so browser-baked
    // filter tiles stay crisp at any zoom. See src/adaptive_tiles.ts.
    private _adaptiveTiles: Map<
        number,
        { img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>; scale: number }
    > = new Map();
    // Pending re-bakes (image id → wanted scale), flushed by a debounced
    // worker once the zoom settles so wheel-zooming doesn't spam rasterizes.
    private _tileBakeQueue: Map<number, number> = new Map();
    private _tileBakeTimer: number | null = null;
    private _tileBakeBusy = false;
    // Repeating image shaders for pattern fills, keyed by pattern signature.
    private _patternShaderCache: Map<
        string,
        ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null
    > = new Map();
    // Effect (blur/shadow) ImageFilters, cached by effect signature — built once
    // and reused across frames (cleared on invalidateRenderCaches).
    private _effectFilterCache: Map<
        string,
        ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null
    > = new Map();
    private _effectPaint: Paint | null = null;

    // CanvasKit blend-mode lookup, indexed by our style enum (0 = Normal).
    // Built lazily once `this.ck` is available; shared by group + node passes.
    private _ckBlendModes: any[] | null = null;
    private ckBlendModes(): any[] {
        if (!this._ckBlendModes) {
            this._ckBlendModes = [
                this.ck.BlendMode.SrcOver, // 0: Normal
                this.ck.BlendMode.Multiply, // 1
                this.ck.BlendMode.Screen, // 2
                this.ck.BlendMode.Overlay, // 3
                this.ck.BlendMode.Darken, // 4
                this.ck.BlendMode.Lighten, // 5
                this.ck.BlendMode.ColorDodge, // 6
                this.ck.BlendMode.ColorBurn, // 7
                this.ck.BlendMode.HardLight, // 8
                this.ck.BlendMode.SoftLight, // 9
                this.ck.BlendMode.Difference, // 10
                this.ck.BlendMode.Exclusion, // 11
                this.ck.BlendMode.Hue, // 12
                this.ck.BlendMode.Saturation, // 13
                this.ck.BlendMode.Color, // 14
                this.ck.BlendMode.Luminosity, // 15
            ];
        }
        return this._ckBlendModes;
    }

    // Memoized cap/join lookup tables (indexed by the protocol's enum values) —
    // previously rebuilt for every node's stroke pass, every frame.
    private _ckCaps: unknown[] | null = null;
    private getCkCaps() {
        if (!this._ckCaps) {
            this._ckCaps = [
                this.ck.StrokeCap.Butt,
                this.ck.StrokeCap.Round,
                this.ck.StrokeCap.Square,
            ];
        }
        return this._ckCaps as Array<(typeof this.ck.StrokeCap)['Butt']>;
    }
    private _ckJoins: unknown[] | null = null;
    private getCkJoins() {
        if (!this._ckJoins) {
            this._ckJoins = [
                this.ck.StrokeJoin.Miter,
                this.ck.StrokeJoin.Round,
                this.ck.StrokeJoin.Bevel,
            ];
        }
        return this._ckJoins as Array<(typeof this.ck.StrokeJoin)['Miter']>;
    }

    // ─── Filled faces cache ───

    // ─── Cached overlay paints (created once, reused every frame) ───
    private _overlayPaints: {
        selOutline: Paint;
        selHandleFill: Paint;
        selHandleStroke: Paint;
        hoverOutline: Paint;
        gridPaint: Paint;
        artboardFill: Paint;
        artboardStroke: Paint;
    } | null = null;

    // ─── Retained scene picture ───
    // The whole decoded content pass (engine command stream → Skia draws) of
    // one frame, captured as an SkPicture in that frame's DEVICE space. Frames
    // where the scene content is unchanged — pan, zoom, idle repaints for
    // overlay/selection changes, i.e. the overwhelmingly common case — replay
    // it with one native drawPicture instead of re-walking the engine tree,
    // copying the render buffer out of WASM and re-issuing every draw from JS
    // (all O(visible nodes), ~19 ms at 15k shapes; playback is ~1-2 ms).
    //
    // Recorded in device space (view transform baked in) so everything inside
    // the decode loop that inspects the canvas CTM — the adaptive-tile
    // re-bake heuristic reads getTotalMatrix() for its device scale — sees
    // exactly what it sees today. Replay cancels the baked-in view transform
    // with the recording frame's inverse and applies the current one.
    private _scenePic: {
        pic: SkPicture;
        zoom: number;
        panX: number;
        panY: number;
        dpr: number;
        /** scene.changeCounter at record time — any mutation invalidates. */
        changeCounter: number;
        /** _scenePicGen at record time — async resource swaps invalidate. */
        gen: number;
        /** World-space cull rect the recording covered (viewport + margin). */
        cullMinX: number;
        cullMinY: number;
        cullMaxX: number;
        cullMaxY: number;
        /** Max zoom-in factor before replay would visibly upscale baked
         *  bitmaps (sprites/tiles/images); pure-vector content stays sharp
         *  at any zoom so it gets a wider band. */
        maxUp: number;
        /** Whether any baked bitmap made it into the recording — replaying a
         *  vector-only picture re-rasterizes sharp at any scale, a bitmap one
         *  does not. Sets how far the gesture band may be widened. */
        hasBitmaps: boolean;
    } | null = null;
    /** Bumped whenever something OUTSIDE the engine buffer changes rendered
     *  pixels: renderer cache wipes, adaptive-tile swaps, sprite bakes. */
    private _scenePicGen = 0;
    private _scenePicSettleTimer: number | null = null;
    /** Extra viewport fraction recorded on each side so small pans replay
     *  from the picture instead of re-recording at the first scroll. */
    private static readonly SCENE_PIC_MARGIN = 0.5;
    /** Zoom-out floor: below half the recorded zoom, re-record (keeps the
     *  recorded cull region from dominating and AA geometry reasonable). */
    private static readonly SCENE_PIC_MIN_DOWN = 0.5;
    /** Zoom band used only on frames that are rasterizing the gesture: those
     *  frames are already being served through a texture and re-record as soon
     *  as the zoom settles, so riding a stale picture beats a mid-gesture
     *  decode. Ordinary frames keep the tight band above. A recording holding
     *  baked bitmaps gets the smaller boost — those really do upscale. */
    private static readonly SCENE_PIC_GESTURE_UP = 4.0;
    private static readonly SCENE_PIC_GESTURE_UP_BITMAP = 2.0;

    /** A valid, empty render stream (header only, zero commands). Fed to the
     *  decode loop on picture-replay frames so the shared code path runs
     *  untouched while drawing nothing. */
    private static _emptyRenderBuf: DataView | null = null;
    private static emptyRenderBuffer(): DataView {
        if (!Renderer._emptyRenderBuf) {
            const dv = new DataView(new ArrayBuffer(12));
            dv.setUint32(0, RENDER_PROTOCOL_MAGIC, true);
            dv.setUint32(4, EXPECTED_RENDER_PROTOCOL_VERSION, true);
            dv.setUint32(8, 0, true); // commandCount
            Renderer._emptyRenderBuf = dv;
        }
        return Renderer._emptyRenderBuf;
    }

    /** Drop the retained scene picture; the next frame re-records it. */
    invalidateScenePicture() {
        this._scenePicGen++;
        if (this._scenePic) {
            this._scenePic.pic.delete();
            this._scenePic = null;
        }
        this.dropViewSnapshot(); // derived from the picture
    }

    // ─── Gesture surface snapshot ───
    // Even replaying the retained picture costs ~1µs per recorded op, so a
    // very large document still can't paint a pan/zoom frame inside the
    // 144fps budget. While the VIEW itself is being gestured (wheel/trackpad
    // zoom or pan, space-drag pan) the content is frozen by definition, so it
    // is rasterized once into a GPU texture covering the viewport plus a
    // margin, and each gesture frame blits that one texture. The grid,
    // artboards and every editor overlay keep rendering live on top, so only
    // the artwork is a bitmap — selection handles, guides and labels stay
    // crisp. When the gesture settles the texture is dropped and the frame
    // re-renders at full fidelity.
    //
    // Capture draws the retained picture (not the engine stream) into the
    // offscreen surface, so it costs one replay rather than a full decode.
    private _viewSnapshot: {
        img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>;
        /** Kept alive alongside the image (same ownership rule as sprites). */
        surface: Surface;
        /** World rect the texture covers. */
        x: number;
        y: number;
        w: number;
        h: number;
        /** Device px per world unit in the texture. */
        scale: number;
        /** View zoom at capture time. The re-capture trigger keys off this, not
         *  off `scale`: a capture deliberately taken below device resolution is
         *  still perfectly usable until the user zooms IN past it. */
        zoom: number;
        dpr: number;
        changeCounter: number;
        gen: number;
    } | null = null;
    /** performance.now() deadline: the view counts as "being gestured" until
     *  this passes. Re-armed by every wheel tick / pan-drag frame. */
    private _viewGestureUntil = 0;
    private _viewGestureTimer: number | null = null;
    /** Rolling estimate of what the content pass costs in JS (ms). Only frames
     *  that actually record or replay update it — blit frames would drag it to
     *  zero and disengage the very optimization keeping them cheap. */
    private _contentCostMs = 0;
    /** Below this content cost the snapshot is never engaged: replaying the
     *  picture is already inside the frame budget, and staying on it keeps
     *  gestures pixel-exact instead of merely smooth. */
    private static readonly VIEW_SNAP_MIN_COST_MS = 4;
    /** Texture budget for the capture (px). ~10M ≈ 40MB, transient. */
    private static readonly VIEW_SNAP_PIXEL_BUDGET = 10_000_000;
    private static readonly VIEW_SNAP_MAX_DIM = 8192;
    /** How much bigger than the viewport the capture may be (linear). More
     *  margin buys pan/zoom-out headroom before a re-capture; the ceiling stays
     *  under the picture's own recorded expansion so the region isn't clamped
     *  away. Below MIN, resolution is traded instead — a viewport that fills
     *  the budget on its own (a 5K display) must still keep some headroom, or
     *  the very first pan would invalidate the capture. */
    private static readonly VIEW_SNAP_MIN_EXPAND = 1.3;
    private static readonly VIEW_SNAP_MAX_EXPAND = 1.6;
    /** Expansion ceiling while the view is zooming OUT. The viewport grows in
     *  world units on every tick, so margin — not resolution — is what keeps a
     *  capture alive; 2.0 matches the picture's own recorded expansion
     *  (SCENE_PIC_MARGIN 0.5 per side), past which the region is clamped away
     *  anyway. */
    private static readonly VIEW_SNAP_MAX_EXPAND_OUT = 2.0;
    /** How far the gesture may zoom IN past the captured resolution before the
     *  upscale reads as soft and it's worth re-capturing. */
    private static readonly VIEW_SNAP_MAX_UP = 1.35;
    private static readonly VIEW_GESTURE_SETTLE_MS = 140;
    /** this.zoom as of the previous frame, so a capture can tell which way the
     *  gesture is heading: zooming out (or pure panning) is the case where a
     *  wider captured region actually buys anything. */
    private _lastRenderZoom = 0;

    /** Tell the renderer the VIEW (not the content) is being gestured, so it
     *  may serve frames from a cached raster. Call from wheel/pan handlers. */
    noteViewGesture() {
        this._viewGestureUntil = performance.now() + Renderer.VIEW_GESTURE_SETTLE_MS;
        if (this._viewGestureTimer === null) {
            this._viewGestureTimer = window.setTimeout(
                () => this.checkViewGestureSettled(),
                Renderer.VIEW_GESTURE_SETTLE_MS + 10,
            );
        }
    }

    /** Drop the raster once the gesture stops, and repaint crisp. */
    private checkViewGestureSettled() {
        this._viewGestureTimer = null;
        const remaining = this._viewGestureUntil - performance.now();
        if (remaining > 0) {
            this._viewGestureTimer = window.setTimeout(
                () => this.checkViewGestureSettled(),
                remaining + 10,
            );
            return;
        }
        if (this._viewSnapshot) {
            this.dropViewSnapshot();
            this._needsRender = true;
        }
    }

    private dropViewSnapshot() {
        if (!this._viewSnapshot) return;
        this._viewSnapshot.img.delete();
        this._viewSnapshot.surface.delete();
        this._viewSnapshot = null;
    }

    /** Can this frame be served from the captured raster? */
    private viewSnapshotUsable(dpr: number): boolean {
        const vs = this._viewSnapshot;
        if (!vs) return false;
        if (
            vs.changeCounter !== this.scene.changeCounter ||
            vs.gen !== this._scenePicGen ||
            vs.dpr !== dpr
        ) {
            return false;
        }
        // Zooming in past what was captured would visibly soften.
        if (this.zoom > vs.zoom * Renderer.VIEW_SNAP_MAX_UP) return false;
        // The viewport must lie inside what was captured, or panning would
        // expose edges the texture has no pixels for.
        const vx = -this.pan.x / this.zoom;
        const vy = -this.pan.y / this.zoom;
        const vw = this.canvas.width / dpr / this.zoom;
        const vh = this.canvas.height / dpr / this.zoom;
        return vx >= vs.x && vy >= vs.y && vx + vw <= vs.x + vs.w && vy + vh <= vs.y + vs.h;
    }

    /** Rasterize the retained picture into an offscreen texture covering the
     *  viewport plus as much margin as the pixel budget allows at native
     *  resolution. Returns false (harmlessly) if anything isn't ready. */
    private captureViewSnapshot(dpr: number, zoomingIn: boolean): boolean {
        const sp = this._scenePic;
        if (!sp || !this.grContext || this._exporting || this._dragLayer) return false;
        if (this.canvas.width === 0 || this.canvas.height === 0) return false;

        // Spend whatever budget remains after the viewport on margin, so the
        // capture stays 1:1 sharp and still tolerates panning / zooming out.
        const devPx = Math.max(1, this.canvas.width * this.canvas.height);
        const budget = Renderer.VIEW_SNAP_PIXEL_BUDGET;
        // A capture dies of softness when the gesture zooms IN and of missing
        // margin when it zooms OUT. Only zooming out can be bought off cheaply:
        // spare budget goes into a wider region, which costs no sharpness. (The
        // symmetric trick — supersampling on the way in — was measured and
        // rejected: minifying the blit aliases hairlines and text badly enough
        // to see, for ~20% fewer captures.)
        const maxExpand = zoomingIn
            ? Renderer.VIEW_SNAP_MAX_EXPAND
            : Renderer.VIEW_SNAP_MAX_EXPAND_OUT;
        let k = Math.sqrt(budget / devPx);
        let resolutionScale = 1;
        if (k < Renderer.VIEW_SNAP_MIN_EXPAND) {
            // The viewport alone nearly fills the budget (a very large display).
            // Keep the headroom and give up sharpness instead — a briefly soft
            // gesture beats one that re-captures on every pointer move.
            k = Renderer.VIEW_SNAP_MIN_EXPAND;
            resolutionScale = Math.sqrt(budget / (devPx * k * k));
        }
        k = Math.min(k, maxExpand);
        const viewW = this.canvas.width / dpr / this.zoom;
        const viewH = this.canvas.height / dpr / this.zoom;
        const margin = (k - 1) / 2;
        const vx = -this.pan.x / this.zoom;
        const vy = -this.pan.y / this.zoom;

        // Desired region, clamped to what the picture actually recorded — only
        // content inside its cull rect exists in it, so capturing beyond that
        // would bake in empty margins.
        let x0 = Math.max(vx - viewW * margin, sp.cullMinX);
        let y0 = Math.max(vy - viewH * margin, sp.cullMinY);
        const x1 = Math.min(vx + viewW * (1 + margin), sp.cullMaxX);
        const y1 = Math.min(vy + viewH * (1 + margin), sp.cullMaxY);

        let scale = this.zoom * dpr * resolutionScale;
        // Start the capture on an exact DEVICE pixel boundary, rounding INWARD
        // so the snap can never push the region back outside the recorded area.
        // Sharing the screen's texel grid keeps an unzoomed blit a straight
        // copy instead of a resample of every pixel.
        x0 = (Math.ceil((x0 * this.zoom + this.pan.x) * dpr) / dpr - this.pan.x) / this.zoom;
        y0 = (Math.ceil((y0 * this.zoom + this.pan.y) * dpr) / dpr - this.pan.y) / this.zoom;

        let pxW = Math.floor((x1 - x0) * scale);
        let pxH = Math.floor((y1 - y0) * scale);
        const maxDim = Renderer.VIEW_SNAP_MAX_DIM;
        if (pxW > maxDim || pxH > maxDim) {
            const s = Math.min(maxDim / pxW, maxDim / pxH);
            scale *= s;
            pxW = Math.max(1, Math.floor(pxW * s));
            pxH = Math.max(1, Math.floor(pxH * s));
        }
        if (pxW < 1 || pxH < 1) return false;
        // Derive the covered world rect FROM the integer texture size, so the
        // destination rect and the texel grid describe the same region — using
        // the pre-rounding size would stretch the blit by up to a pixel.
        const x = x0;
        const y = y0;
        const w = pxW / scale;
        const h = pxH / scale;

        // Useless unless it covers the whole viewport: a blit that falls short
        // would leave un-painted edges.
        if (x > vx || y > vy || x + w < vx + viewW || y + h < vy + viewH) return false;

        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        const surface = ckAny.MakeRenderTarget(this.grContext, pxW, pxH) as Surface | null;
        if (!surface) return false;

        const c = surface.getCanvas();
        c.clear(this.ck.TRANSPARENT);
        c.save();
        c.scale(scale, scale);
        c.translate(-x, -y); // canvas is now in world space
        this.drawScenePicture(c, sp);
        c.restore();
        surface.flush();

        const img = surface.makeImageSnapshot() as NonNullable<
            ReturnType<CanvasKit['MakeImageFromEncoded']>
        > | null;
        if (!img) {
            surface.delete();
            return false;
        }
        this.dropViewSnapshot();
        this._viewSnapshot = {
            img,
            surface,
            x,
            y,
            w,
            h,
            scale,
            zoom: this.zoom,
            dpr,
            changeCounter: this.scene.changeCounter,
            gen: this._scenePicGen,
        };
        return true;
    }

    /** Blit the captured raster over the world rect it covers. Call with the
     *  canvas in world space; cubic resampling keeps any residual scale smooth
     *  rather than blocky. */
    private drawViewSnapshot(canvas: Canvas) {
        const vs = this._viewSnapshot!;
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        ip.setColor(this.ck.Color4f(1, 1, 1, 1));
        ip.setAlphaf(1);
        canvas.drawImageRectCubic(
            vs.img,
            this.ck.XYWHRect(0, 0, vs.img.width(), vs.img.height()),
            this.ck.XYWHRect(vs.x, vs.y, vs.w, vs.h),
            1 / 3,
            1 / 3,
            ip,
        );
    }

    /** Draw the retained picture under the current view transform. Call with
     *  the canvas in WORLD space (view transform applied): concatenating the
     *  recording frame's inverse view matrix turns the CTM into
     *  V_cur·V_rec⁻¹, which cancels the V_rec baked into the picture's ops. */
    private drawScenePicture(canvas: Canvas, sp: NonNullable<Renderer['_scenePic']>) {
        const s = 1 / (sp.dpr * sp.zoom);
        canvas.save();
        canvas.concat([s, 0, -sp.panX / sp.zoom, 0, s, -sp.panY / sp.zoom, 0, 0, 1]);
        canvas.drawPicture(sp.pic);
        canvas.restore();
    }

    /** While zoom changes ride the retained picture, the zoom-dependent work
     *  inside the decode loop (tile re-bake wants, sprite usability, the
     *  clip-vs-layer choice) never runs. Re-record once the zoom settles so
     *  those heuristics catch up — same debounce idea as the tile bakes. */
    private scheduleScenePicSettle() {
        if (this._scenePicSettleTimer !== null) {
            window.clearTimeout(this._scenePicSettleTimer);
        }
        const zoomAt = this.zoom;
        this._scenePicSettleTimer = window.setTimeout(() => {
            this._scenePicSettleTimer = null;
            if (this.zoom !== zoomAt) {
                this.scheduleScenePicSettle();
                return;
            }
            this.invalidateScenePicture();
            this._needsRender = true;
        }, 180);
    }

    constructor(ck: CanvasKit, canvas: HTMLCanvasElement, scene: WasmScene) {
        this.ck = ck;
        this.canvas = canvas;
        this.scene = scene;
        this.surface = null;
        this.isRunning = false;

        this.zoom = 1.0;
        this.pan = { x: 0, y: 0 };

        this.initGL();

        // Re-render when a Google Font finishes loading so text appears correctly
        onFontLoaded(() => {
            // The cached provider doesn't know the new face — rebuild lazily.
            this._fontProvider?.delete();
            this._fontProvider = null;
            // Any width measured before this point was measured against a
            // fallback face, so the selection frames drawn from it are stale.
            this._textWidthMemo.clear();
            this.scene.invalidateCache();
            this._needsRender = true;
        });
    }

    /** Cached TypefaceFontProvider over every loaded face. Rebuilding it per
     *  text node per frame re-registered every font each time (O(text nodes ×
     *  faces) WASM churn); the set of loaded faces only changes via
     *  onFontLoaded, which drops this cache. */
    private _fontProvider: ReturnType<CanvasKit['TypefaceFontProvider']['Make']> | null = null;
    private getFontProvider(): ReturnType<CanvasKit['TypefaceFontProvider']['Make']> | null {
        if (!this._fontProvider) this._fontProvider = buildFontProvider(this.ck);
        return this._fontProvider;
    }

    /** Signal that the scene or view changed and a new frame is needed. */
    requestRender() {
        this._needsRender = true;
    }

    /** Subscribers notified whenever zoom/pan change (view transform changed).
     *  Used by the inline text-edit overlay to stay glued over the glyphs. */
    private viewChangeCbs: Array<() => void> = [];
    /** Register a callback fired on every zoom/pan change. */
    onViewChange(cb: () => void) {
        this.viewChangeCbs.push(cb);
    }
    /** Notify view-change subscribers. Call after mutating zoom/pan directly. */
    notifyViewChange() {
        for (const cb of this.viewChangeCbs) cb();
    }

    /** Invalidate all cached rendering resources. Call when the scene mutates. */
    invalidateRenderCaches() {
        this.invalidateScenePicture();
        // Clear path cache
        for (const entry of this._pathCache.values()) {
            entry.path.delete();
        }
        this._pathCache.clear();

        for (const entry of this._clipPathCache.values()) entry.path.delete();
        this._clipPathCache.clear();

        // Any full invalidation means non-transform content may have changed —
        // the drag-layer snapshots and group sprites can no longer be trusted.
        this.endDragLayerCache();
        this.invalidateAllGroupSprites();

        // Clear gradient cache
        for (const shader of this._gradientCache.values()) {
            if (shader) shader.delete();
        }
        this._gradientCache.clear();

        // Clear effect filter cache
        for (const f of this._effectFilterCache.values()) {
            if (f) f.delete();
        }
        this._effectFilterCache.clear();

        // Clear pattern shaders (cheap to rebuild from the cached tile image).
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();

        this._needsRender = true;
    }

    /** Build (or fetch a cached) ImageFilter chain for a node's effects.
     *  Effects stack: each filter takes the previous as input. */
    private getEffectFilter(
        effects: EffectRecord[],
    ): ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null {
        const key = effects
            .map(
                (e) =>
                    `${e.kind}:${e.radius},${e.radiusY},${e.dx},${e.dy},${e.r},${e.g},${e.b},${e.a},${e.matrix?.join(',') ?? ''},${e.linearRGB ? 'L' : 'S'}`,
            )
            .join('|');
        const cached = this._effectFilterCache.get(key);
        if (cached !== undefined) return cached;
        let filter: ReturnType<CanvasKit['ImageFilter']['MakeBlur']> | null = null;
        for (const e of effects) {
            if (e.kind === 0) {
                const sx = Math.max(0, e.radius);
                const sy = Math.max(0, e.radiusY);
                filter = this.ck.ImageFilter.MakeBlur(sx, sy, this.ck.TileMode.Decal, filter);
            } else if (e.kind === 1) {
                const s = Math.max(0, e.radius);
                const color = this.ck.Color4f(e.r, e.g, e.b, e.a);
                filter = this.ck.ImageFilter.MakeDropShadow(e.dx, e.dy, s, s, color, filter);
            } else if (e.kind === 2 && e.matrix && e.matrix.length === 20) {
                const cf = this.ck.ColorFilter.MakeMatrix(e.matrix);
                if (e.linearRGB) {
                    // SVG default: apply matrix in linearRGB space.
                    // Compose: sRGB→linear → matrix → linear→sRGB
                    const toLinear = this.ck.ColorFilter.MakeSRGBToLinearGamma();
                    const toSRGB = this.ck.ColorFilter.MakeLinearToSRGBGamma();
                    const linearMatrix = this.ck.ColorFilter.MakeCompose(
                        toSRGB,
                        this.ck.ColorFilter.MakeCompose(cf, toLinear),
                    );
                    filter = this.ck.ImageFilter.MakeColorFilter(linearMatrix, filter);
                } else {
                    filter = this.ck.ImageFilter.MakeColorFilter(cf, filter);
                }
            }
        }
        this._effectFilterCache.set(key, filter);
        return filter;
    }

    /** Drop all decoded images. Call when a different document is loaded (image
     *  ids may be reused for different bytes). Not called on ordinary edits. */
    clearImageCache() {
        this.invalidateScenePicture();
        for (const img of this._imageCache.values()) {
            if (img) img.delete();
        }
        this._imageCache.clear();
        for (const sh of this._patternShaderCache.values()) if (sh) sh.delete();
        this._patternShaderCache.clear();
        // Adaptive filter tiles and group sprites belong to the outgoing
        // document too.
        for (const t of this._adaptiveTiles.values()) t.img.delete();
        this._adaptiveTiles.clear();
        this._tileBakeQueue.clear();
        adaptiveTileSources.clear();
        this.invalidateAllGroupSprites();
        this._needsRender = true;
    }

    /** Decode (and cache) an engine image id into a CanvasKit Image, or null. */
    private getImage(imageId: number): ReturnType<CanvasKit['MakeImageFromEncoded']> | null {
        let img = this._imageCache.get(imageId);
        if (img === undefined) {
            const bytes = this.scene.engine?.get_image_bytes(imageId);
            img = bytes && bytes.length > 0 ? this.ck.MakeImageFromEncoded(bytes) : null;
            this._imageCache.set(imageId, img ?? null);
        }
        return img;
    }

    /** Repeating image shader for a pattern fill: tiles the image over
     *  `width`×`height` local units, then applies the pattern transform
     *  ([a,b,c,d,e,f]) as the shader's local matrix. Cached by signature. */
    private getPatternShader(
        imageId: number,
        width: number,
        height: number,
        transform: number[],
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null {
        const key = `${imageId}|${width}|${height}|${transform.join(',')}`;
        const cached = this._patternShaderCache.get(key);
        if (cached !== undefined) return cached;
        const img = this.getImage(imageId);
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']> | null = null;
        if (img && img.width() > 0 && img.height() > 0 && width > 0 && height > 0) {
            const sx = width / img.width(),
                sy = height / img.height();
            const [a, b, c, d, e, f] = transform;
            // localMatrix = patternTransform · scale(image px → tile units), row-major 3x3.
            const m = [a * sx, c * sy, e, b * sx, d * sy, f, 0, 0, 1];
            shader = img.makeShaderOptions(
                this.ck.TileMode.Repeat,
                this.ck.TileMode.Repeat,
                this.ck.FilterMode.Linear,
                this.ck.MipmapMode.None,
                m,
            );
        }
        this._patternShaderCache.set(key, shader);
        return shader;
    }

    /** Draw a raster image node at (0,0,w,h) in the current (local) space. */
    private drawImageNode(
        canvas: Canvas,
        imageId: number,
        w: number,
        h: number,
        alpha: number,
        pixelated = false,
    ) {
        let img = this.getImage(imageId);

        // Zoom-adaptive filter tiles: draw the re-baked bitmap when one
        // exists, and queue a re-bake when the on-screen scale has drifted
        // meaningfully from the baked scale (sharper when zooming in, cheaper
        // when zooming far back out). Only visible nodes reach this point, so
        // offscreen tiles never re-bake. Skipped during export: the export
        // render is synchronous, so an async bake could never land in it.
        const tileSrc = adaptiveTileSources.get(imageId);
        if (tileSrc) {
            const baked = this._adaptiveTiles.get(imageId);
            if (baked) img = baked.img;
            // Tile re-bakes are queued from live frames AND sprite bakes (a
            // sprite is the only place a cached group's tiles are drawn), but
            // not from PNG exports.
            if (!this._exporting || this._spriteBakeRootId !== null) {
                const m = canvas.getTotalMatrix(); // row-major 3×3
                const devScale = Math.max(Math.hypot(m[0], m[3]), Math.hypot(m[1], m[4]));
                const cur = baked ? baked.scale : tileSrc.baseScale;
                const want = Math.min(Math.max(devScale, tileSrc.baseScale), maxTileScale(tileSrc));
                if (want > cur * 1.4 || want < cur / 2.5) {
                    this._tileBakeQueue.set(imageId, want);
                    this.scheduleTileBakes();
                }
            }
        }

        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        const dst = this.ck.XYWHRect(0, 0, w, h);
        if (img) {
            ip.setColor(this.ck.Color4f(1, 1, 1, 1));
            ip.setAlphaf(alpha);
            const src = this.ck.XYWHRect(0, 0, img.width(), img.height());
            if (pixelated) {
                // `image-rendering: optimizeSpeed | pixelated | crisp-edges`:
                // nearest-neighbour, so magnified pixel art keeps hard edges.
                // Smoothing it would be both wrong per spec and the opposite of
                // what the author asked for.
                canvas.drawImageRectOptions(
                    img,
                    src,
                    dst,
                    this.ck.FilterMode.Nearest,
                    this.ck.MipmapMode.None,
                    ip,
                );
            } else {
                // Mitchell cubic so a zoomed raster / filter tile up-scales
                // smoothly instead of showing blocky pixels.
                canvas.drawImageRectCubic(img, src, dst, 1 / 3, 1 / 3, ip);
            }
        } else {
            // Decode failed / missing bytes — draw a magenta placeholder.
            ip.setColor(this.ck.Color4f(1, 0, 1, 0.6 * alpha));
            canvas.drawRect(dst, ip);
        }
    }

    /** Debounce tile re-bakes until the zoom has settled (~160 ms without a
     *  zoom change), so continuous wheel-zooming doesn't rasterize every step. */
    private scheduleTileBakes() {
        if (this._tileBakeTimer !== null || this._tileBakeBusy) return;
        const zoomAt = this.zoom;
        this._tileBakeTimer = window.setTimeout(() => {
            this._tileBakeTimer = null;
            if (this.zoom !== zoomAt) {
                this.scheduleTileBakes(); // still zooming — wait another beat
                return;
            }
            void this.processTileBakes();
        }, 160);
    }

    /** Drain the bake queue: rasterize each tile's SVG source at the wanted
     *  scale (browser SVG renderer, off the frame loop) and swap the result in
     *  as the tile's drawing image. A wanted scale at/below the import bake
     *  drops the override instead, freeing the high-res bitmap. */
    private async processTileBakes() {
        if (this._tileBakeBusy) return;
        this._tileBakeBusy = true;
        let anyChanged = false;
        try {
            while (this._tileBakeQueue.size > 0) {
                const next = this._tileBakeQueue.entries().next().value;
                if (!next) break;
                const [imageId, scale] = next;
                this._tileBakeQueue.delete(imageId);
                const src = adaptiveTileSources.get(imageId);
                if (!src) continue;
                const prev = this._adaptiveTiles.get(imageId);
                if (scale <= src.baseScale * 1.01) {
                    if (prev) {
                        prev.img.delete();
                        this._adaptiveTiles.delete(imageId);
                        this._needsRender = true;
                        anyChanged = true;
                    }
                    continue;
                }
                const bitmap = await rasterizeAdaptiveTile(src, scale);
                if (!bitmap) continue;
                const ckImg = this.ck.MakeImageFromCanvasImageSource(bitmap);
                if (!ckImg) continue;
                if (prev) prev.img.delete();
                this._adaptiveTiles.set(imageId, { img: ckImg, scale });
                this._needsRender = true;
                anyChanged = true;
            }
        } finally {
            this._tileBakeBusy = false;
            // Tiles drawn inside cached groups changed — those sprites are
            // stale; drop them all (they re-queue on the next frame at the
            // same settled zoom, so both caches converge together).
            if (anyChanged && this._groupSprites.size > 0) {
                this.invalidateAllGroupSprites();
                this._needsRender = true;
            }
            // The retained scene picture references the old tile images.
            if (anyChanged) this.invalidateScenePicture();
        }
    }

    /** Open the saveLayer sandwich for an alpha (mode 0) or luminance (mode 1)
     *  mask span, bounded to `bounds` when the mask shape's extent is known
     *  (null → unbounded, the pre-existing behavior). Layer counts must match
     *  what CMD_BEGIN_MASKED_CONTENT / CMD_END_MASK restore. */
    private openMaskLayers(
        canvas: Canvas,
        span: {
            mode: number;
            pendingLayer: boolean;
            bounds: ReturnType<CanvasKit['LTRBRect']> | null;
        },
        bounds: ReturnType<CanvasKit['LTRBRect']> | null,
    ) {
        span.pendingLayer = false;
        span.bounds = bounds;
        if (span.mode === 1) {
            // Luminance mask: 3-layer protocol.
            // Layer 0 (outer): collects the final masked result.
            canvas.saveLayer(undefined, bounds ?? undefined);
            // Layer 1 (luma): mask shapes are drawn here. On restore,
            // the luminance→alpha color filter converts RGB to alpha.
            if (!this._lumaPaint) {
                this._lumaPaint = new this.ck.Paint();
                // SVG luminance mask: A' = luminance(RGB) × A.
                //
                // This was a hand-written 4×5 matrix mapping RGB→A, which was
                // wrong: `MakeMatrix` operates on UNPREMULTIPLIED colour, so
                // the source alpha never entered the result. A mask painted
                // white at stop-opacity="0" — which is how the suite (and any
                // fade-out gradient) builds a mask — came out FULLY OPAQUE
                // instead of fully transparent, so the masked content showed
                // through at full strength. A colour matrix is linear and so
                // cannot multiply two channels; MakeLuma is Skia's own
                // luminance-to-alpha, defined per the SVG spec and evaluated on
                // premultiplied colour, which is exactly this product.
                this._lumaPaint.setColorFilter(this.ck.ColorFilter.MakeLuma());
            }
            canvas.saveLayer(this._lumaPaint, bounds ?? undefined);
        } else {
            // Alpha mask: 2-layer protocol (original).
            // Isolated layer accumulating the mask shape's coverage.
            canvas.saveLayer(undefined, bounds ?? undefined);
        }
    }

    /** Collect `roots` plus all their descendants into a set. */
    private collectSubtree(roots: number[]): Set<number> {
        const out = new Set<number>();
        const stack = [...roots];
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (out.has(id)) continue;
            out.add(id);
            const kids = this.scene.getNodeChildren(id);
            if (kids) for (const k of kids) stack.push(k);
        }
        return out;
    }

    /** True if `rootId` or any descendant is a Live Paint group. Such subtrees
     *  must never be sprite-cached: the group's faces/edges render live
     *  in-stream (they mutate as the user paints) and the paint-bucket cursor
     *  hit-tests the *live* face geometry via query_face_at. A baked snapshot
     *  freezes and can misalign them, so the fill/highlight would land on a
     *  different region than what's shown — only visible once zoomed out far
     *  enough for sprites to engage. Mirrors the engine's `is_lp` guard in
     *  write_node_recursive, which refuses to sprite-skip a Live Paint group. */
    private subtreeHasLivePaint(rootId: number): boolean {
        const stack = [rootId];
        const seen = new Set<number>();
        while (stack.length > 0) {
            const id = stack.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            if (this.scene.getNodeLivePaint(id)) return true;
            const kids = this.scene.getNodeChildren(id);
            if (kids) for (const k of kids) stack.push(k);
        }
        return false;
    }

    /**
     * Start a drag-layer cache for a move of `movingIds`. Only supported when
     * every moving node is a ROOT node (top-level z-split is well-defined and
     * no ancestor group opacity/mask/blend can leak); returns false otherwise
     * and the caller just keeps the normal full-render path. Costs two extra
     * full renders up front (the below/above snapshots), then every drag frame
     * re-records only the moving subtree.
     */
    beginDragLayerCache(movingIds: number[]): boolean {
        this.endDragLayerCache();
        if (!this.surface || this._exporting || movingIds.length === 0) return false;
        const roots: number[] = Array.from(this.scene.getRootNodes());
        const rootSet = new Set(roots);
        if (!movingIds.every((id) => rootSet.has(id))) return false;

        const moving = new Set(movingIds);
        let minMovingIdx = Infinity;
        roots.forEach((r, i) => {
            if (moving.has(r) && i < minMovingIdx) minMovingIdx = i;
        });
        // Static roots under the lowest mover go in the below layer, the rest
        // above. (A static root sandwiched between two movers can't be split
        // exactly — it lands above, correct relative to the lowest mover.)
        const belowRoots = roots.filter((r, i) => !moving.has(r) && i < minMovingIdx);
        const aboveRoots = roots.filter((r, i) => !moving.has(r) && i >= minMovingIdx);

        const dpr = window.devicePixelRatio || 1;
        const snapshot = (
            pass: 'below' | 'above',
            ids: number[],
        ): NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>> | null => {
            this._dragSnapshotPass = pass;
            this._dragSubtree = this.collectSubtree(ids);
            try {
                this.render();
                return this.surface!.makeImageSnapshot() as NonNullable<
                    ReturnType<CanvasKit['MakeImageFromEncoded']>
                >;
            } finally {
                this._dragSnapshotPass = null;
            }
        };
        const below = snapshot('below', belowRoots);
        const above = snapshot('above', aboveRoots);

        this._dragLayer = {
            below,
            above,
            zoom: this.zoom,
            panX: this.pan.x,
            panY: this.pan.y,
            dpr,
            width: this.canvas.width,
            height: this.canvas.height,
        };
        this.setDragMovingRoots(movingIds);
        this._needsRender = true;
        return true;
    }

    /** Update which roots are re-recorded live during a cached drag (the set
     *  grows during an Alt clone-drag: originals stay put but aren't in the
     *  snapshots, and the clones move). No-op when unchanged. */
    setDragMovingRoots(movingIds: number[]) {
        if (!this._dragLayer) return;
        if (
            movingIds.length === this._dragMovingRoots.length &&
            movingIds.every((id, i) => id === this._dragMovingRoots[i])
        ) {
            return;
        }
        this._dragMovingRoots = [...movingIds];
        this._dragSubtree = this.collectSubtree(movingIds);
    }

    /** Drop the drag-layer cache (drag ended, or the static content changed). */
    endDragLayerCache() {
        if (this._dragLayer) {
            this._dragLayer.below?.delete();
            this._dragLayer.above?.delete();
            this._dragLayer = null;
            this._needsRender = true;
        }
        this._dragSubtree = null;
        this._dragMovingRoots = [];
    }

    /** Blit a drag-layer snapshot in WORLD space: the destination rect is the
     *  world region the snapshot covered, so it lands correctly even if the
     *  view panned (and merely scales if it zoomed) since the cache was built. */
    private drawDragLayerImage(
        canvas: Canvas,
        img: NonNullable<ReturnType<CanvasKit['MakeImageFromEncoded']>>,
    ) {
        const dl = this._dragLayer!;
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        ip.setColor(this.ck.Color4f(1, 1, 1, 1));
        ip.setAlphaf(1);
        const worldX = -dl.panX / dl.zoom;
        const worldY = -dl.panY / dl.zoom;
        const worldW = dl.width / dl.dpr / dl.zoom;
        const worldH = dl.height / dl.dpr / dl.zoom;
        canvas.drawImageRect(
            img,
            this.ck.XYWHRect(0, 0, dl.width, dl.height),
            this.ck.XYWHRect(worldX, worldY, worldW, worldH),
            ip,
        );
    }

    // ─── Group sprite cache methods ───

    /** Drop the sprite covering `id` — call for any edit to a node INSIDE a
     *  cached group. A change to the cached root's own transform doesn't need
     *  this: sprites follow their group's transform at draw time. */
    invalidateGroupSpriteFor(id: number) {
        const root = this._spriteSubtreeIndex.get(id);
        if (root !== undefined) this.dropGroupSprite(root);
    }

    private dropGroupSprite(root: number) {
        const s = this._groupSprites.get(root);
        if (!s) return;
        s.img.delete();
        s.surface.delete();
        this._groupSprites.delete(root);
        for (const [k, v] of this._spriteSubtreeIndex) {
            if (v === root) this._spriteSubtreeIndex.delete(k);
        }
        this._needsRender = true;
    }

    invalidateAllGroupSprites() {
        for (const s of this._groupSprites.values()) {
            s.img.delete();
            s.surface.delete();
        }
        this._groupSprites.clear();
        this._spriteSubtreeIndex.clear();
        this._spriteIneligible.clear();
        this._spriteWanted.clear();
    }

    /** Highest useful bake scale for a sprite of the given world size. */
    private spriteMaxScale(w: number, h: number): number {
        return Math.min(
            Renderer.SPRITE_MAX_DIM / Math.max(w, h),
            Math.sqrt(Renderer.SPRITE_MAX_PIXELS / (w * h)),
        );
    }

    /** Bake `rootId`'s subtree into a GPU texture at the current device scale
     *  (capped by the texture budget). Renders through the normal pipeline
     *  with an export-style state swap onto an offscreen GL surface. */
    private bakeGroupSprite(rootId: number): boolean {
        if (!this.surface || !this.scene.engine || this._exporting) return false;
        const b = this.scene.getNodeBounds(rootId);
        const bw = b[2] - b[0];
        const bh = b[3] - b[1];
        if (!(bw > 0) || !(bh > 0)) return false;
        // Pad for filter/stroke spill past the engine's geometry bounds.
        const pad = Math.max(10, 0.05 * Math.max(bw, bh));
        const x = b[0] - pad;
        const y = b[1] - pad;
        const w = bw + 2 * pad;
        const h = bh + 2 * pad;
        const dpr = window.devicePixelRatio || 1;
        const scale = Math.min(Math.max(0.05, this.zoom * dpr), this.spriteMaxScale(w, h));
        const pxW = Math.max(1, Math.ceil(w * scale));
        const pxH = Math.max(1, Math.ceil(h * scale));
        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        const surface = ckAny.MakeRenderTarget(this.grContext, pxW, pxH) as Surface | null;
        if (!surface) return false;

        const subtree = this.collectSubtree([rootId]);
        const savedSurface = this.surface;
        const savedZoom = this.zoom;
        const savedPan = this.pan;
        this.surface = surface;
        this.zoom = scale;
        this.pan = { x: -x * scale, y: -y * scale };
        this._exporting = true; // transparent clear, no chrome, dpr 1
        this._exportBounds = { x, y, w, h };
        this._bakeSubset = subtree;
        this._spriteBakeRootId = rootId;
        try {
            this.render();
        } finally {
            this.surface = savedSurface;
            this.zoom = savedZoom;
            this.pan = savedPan;
            this._exporting = false;
            this._exportBounds = null;
            this._bakeSubset = null;
            this._spriteBakeRootId = null;
        }
        const img = surface.makeImageSnapshot() as NonNullable<
            ReturnType<CanvasKit['MakeImageFromEncoded']>
        > | null;
        if (!img) {
            surface.delete();
            return false;
        }
        this._groupSprites.set(rootId, {
            img,
            surface,
            x,
            y,
            w,
            h,
            bakeTransform: this.scene.getTransform(rootId),
            scale,
        });
        for (const id of subtree) {
            if (id !== rootId) this._spriteSubtreeIndex.set(id, rootId);
        }
        this._needsRender = true;
        return true;
    }

    /** Draw a cached group as one image, transformed by the group's movement
     *  since bake time. Queues a re-bake when the on-screen scale has drifted. */
    private drawGroupSprite(
        canvas: Canvas,
        rootId: number,
        sprite: NonNullable<ReturnType<Renderer['_groupSprites']['get']>>,
        devScale: number,
    ) {
        const cur = this.scene.getTransform(rootId);
        const bk = sprite.bakeTransform;
        let delta: number[] | null = null;
        const moved =
            cur[0] !== bk[0] ||
            cur[1] !== bk[1] ||
            cur[2] !== bk[2] ||
            cur[3] !== bk[3] ||
            cur[4] !== bk[4] ||
            cur[5] !== bk[5];
        if (moved) {
            const inv = invertAffine(bk);
            if (inv) {
                // delta = cur · inv, row-major affine
                delta = [
                    cur[0] * inv[0] + cur[1] * inv[3],
                    cur[0] * inv[1] + cur[1] * inv[4],
                    cur[0] * inv[2] + cur[1] * inv[5] + cur[2],
                    cur[3] * inv[0] + cur[4] * inv[3],
                    cur[3] * inv[1] + cur[4] * inv[4],
                    cur[3] * inv[2] + cur[4] * inv[5] + cur[5],
                    0,
                    0,
                    1,
                ];
            }
        }
        if (delta) {
            canvas.save();
            canvas.concat(delta);
        }
        if (!this._imagePaint) this._imagePaint = new this.ck.Paint();
        const ip = this._imagePaint;
        ip.setShader(null);
        ip.setStyle(this.ck.PaintStyle.Fill);
        ip.setColor(this.ck.Color4f(1, 1, 1, 1));
        ip.setAlphaf(1);
        // Mitchell cubic resample so any residual up/down-scale of the sprite is
        // smooth, never blocky (nearest-neighbour reads as "pixelated").
        canvas.drawImageRectCubic(
            sprite.img,
            this.ck.XYWHRect(0, 0, sprite.img.width(), sprite.img.height()),
            this.ck.XYWHRect(sprite.x, sprite.y, sprite.w, sprite.h),
            1 / 3,
            1 / 3,
            ip,
        );
        if (delta) canvas.restore();

        // Queue a re-bake when the settled zoom wants a meaningfully different
        // resolution than the sprite has — but never chase past the cap. Upscale
        // threshold matches the usable factor so a zoomed-in sprite re-sharpens
        // before it would drift out of the usable range; downscale is looser
        // (a too-large sprite only wastes memory, it never looks wrong).
        const target = Math.min(Math.max(0.05, devScale), this.spriteMaxScale(sprite.w, sprite.h));
        const ratio = target / sprite.scale;
        if (ratio > 1.05 || ratio < 1 / 2.5) {
            this._spriteWanted.add(rootId);
            this.scheduleSpriteBakes();
        }
    }

    /** Debounce sprite bakes until the view settles, then spread them over
     *  timer ticks so a batch never blocks a frame for long. */
    private scheduleSpriteBakes() {
        if (this._spriteBakeTimer !== null) return;
        const zoomAt = this.zoom;
        this._spriteBakeTimer = window.setTimeout(() => {
            this._spriteBakeTimer = null;
            if (this.zoom !== zoomAt) {
                this.scheduleSpriteBakes();
                return;
            }
            this.processSpriteBakes();
        }, 160);
    }

    private processSpriteBakes() {
        // Don't bake mid-gesture (resize/rotate drags mutate every frame —
        // sprites would be dropped again immediately).
        if (this.inputManager?.isMouseDown) {
            this.scheduleSpriteBakes();
            return;
        }
        // A zero-sized surface (hidden/minimized window) can't judge
        // visibility — try again later rather than draining the queue.
        if (this.canvas.width === 0 || this.canvas.height === 0) {
            this.scheduleSpriteBakes();
            return;
        }
        // Only bake what's on screen: offscreen roots get re-queued when they
        // scroll into view, and baking all of them at once at a deep zoom
        // would blow the GPU memory budget for nothing.
        const dpr = window.devicePixelRatio || 1;
        const vMinX = -this.pan.x / this.zoom;
        const vMinY = -this.pan.y / this.zoom;
        const vMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
        const vMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;
        const BUDGET = 4;
        let done = 0;
        for (const rootId of [...this._spriteWanted]) {
            if (done >= BUDGET) break;
            this._spriteWanted.delete(rootId);
            if (this._spriteIneligible.has(rootId)) continue;
            if (this.scene.getNodeType(rootId) !== 3) {
                // Not a group (or gone) — never cache.
                this._spriteIneligible.add(rootId);
                continue;
            }
            // A Live Paint group (or any root containing one) renders its faces
            // live and is hit-tested against live geometry — baking it desyncs
            // the paint-bucket fill/highlight from what's shown at low zoom.
            if (this.subtreeHasLivePaint(rootId)) {
                this._spriteIneligible.add(rootId);
                this.dropGroupSprite(rootId); // drop any sprite baked before this guard
                continue;
            }
            const b = this.scene.getNodeBounds(rootId);
            if (b[2] < vMinX || b[0] > vMaxX || b[3] < vMinY || b[1] > vMaxY) continue;
            if (!this._groupSprites.has(rootId)) {
                const size = this.collectSubtree([rootId]).size;
                if (size < Renderer.SPRITE_MIN_SUBTREE) {
                    this._spriteIneligible.add(rootId);
                    continue;
                }
            } else {
                this.dropGroupSprite(rootId);
            }
            if (this.bakeGroupSprite(rootId)) {
                done++;
            } else {
                // Bake failed (degenerate bounds / render-target allocation) —
                // don't retry-loop; eligibility resets with the next full
                // invalidation.
                this._spriteIneligible.add(rootId);
            }
        }
        if (this._spriteWanted.size > 0) {
            this._spriteBakeTimer = window.setTimeout(() => {
                this._spriteBakeTimer = null;
                this.processSpriteBakes();
            }, 30);
        }
        // Fresh sprites change nothing visually, but re-recording the retained
        // picture now lets it (and every future re-record) draw one bitmap per
        // cached group instead of the groups' full subtrees.
        if (done > 0) this.invalidateScenePicture();
    }

    /** Ensure the reusable overlay Paint objects exist. */
    private ensureOverlayPaints() {
        if (this._overlayPaints) return this._overlayPaints;
        const ck = this.ck;
        const selOutline = new ck.Paint();
        selOutline.setColor(ck.Color(0, 162, 255, 1.0));
        selOutline.setStyle(ck.PaintStyle.Stroke);
        // Hairlines without AA drop vertical segments at some DPR/zoom combos.
        selOutline.setAntiAlias(true);

        const selHandleFill = new ck.Paint();
        selHandleFill.setColor(ck.Color(255, 255, 255, 1.0));
        selHandleFill.setStyle(ck.PaintStyle.Fill);
        selHandleFill.setAntiAlias(true);

        const selHandleStroke = new ck.Paint();
        selHandleStroke.setColor(ck.Color(0, 162, 255, 1.0));
        selHandleStroke.setStyle(ck.PaintStyle.Stroke);
        selHandleStroke.setAntiAlias(true);

        const hoverOutline = new ck.Paint();
        hoverOutline.setColor(ck.Color(0, 162, 255, 0.55));
        hoverOutline.setStyle(ck.PaintStyle.Stroke);
        hoverOutline.setAntiAlias(true);

        const gridPaint = new ck.Paint();
        // Default for light stage; host may retint. Low alpha — only drawn ≥1000%.
        gridPaint.setColor(ck.Color(15, 23, 42, 0.14));
        gridPaint.setStyle(ck.PaintStyle.Stroke);
        gridPaint.setAntiAlias(true);

        const artboardFill = new ck.Paint();
        artboardFill.setColor(ck.Color(255, 255, 255, 1.0));
        artboardFill.setStyle(ck.PaintStyle.Fill);

        const artboardStroke = new ck.Paint();
        artboardStroke.setColor(ck.Color(80, 80, 80, 1.0));
        artboardStroke.setStyle(ck.PaintStyle.Stroke);
        // Match node selection / content strokes — AA-off strokeRect drops edges.
        artboardStroke.setAntiAlias(true);

        this._overlayPaints = {
            selOutline,
            selHandleFill,
            selHandleStroke,
            hoverOutline,
            gridPaint,
            artboardFill,
            artboardStroke,
        };
        return this._overlayPaints;
    }

    private initGL() {
        // CanvasKit's GetWebGLContext/MakeGrContext aren't in public typings
        const ckAny = this.ck as unknown as Record<string, CallableFunction>;
        this.glContext = ckAny.GetWebGLContext(this.canvas) as number;
        this.grContext = ckAny.MakeGrContext(this.glContext);
        this.onResize();
        window.addEventListener('resize', () => this.onResize());
        // A window 'resize' fires only when the WINDOW changes size — not when
        // just the canvas's CSS box does (a side panel opening/closing, the
        // properties panel appearing on selection, any layout reflow). Without
        // catching those, the drawing-buffer size goes stale: the scene is
        // bitmap-scaled to fit the new box while pointer→world mapping still
        // uses the live client rect, so hover/paint lands on the wrong spot —
        // worst far from the canvas origin (a right-hand artboard looks most
        // off). A ResizeObserver on the canvas catches every box change.
        if (typeof ResizeObserver !== 'undefined') {
            this._resizeObserver = new ResizeObserver(() => this.onResize());
            this._resizeObserver.observe(this.canvas);
        }
    }

    destroy() {
        this.isRunning = false;
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        if (this._tileBakeTimer !== null) {
            window.clearTimeout(this._tileBakeTimer);
            this._tileBakeTimer = null;
        }
        if (this._scenePicSettleTimer !== null) {
            window.clearTimeout(this._scenePicSettleTimer);
            this._scenePicSettleTimer = null;
        }
        if (this._viewGestureTimer !== null) {
            window.clearTimeout(this._viewGestureTimer);
            this._viewGestureTimer = null;
        }
        this.invalidateScenePicture(); // also drops the gesture raster
        this._fontProvider?.delete();
        this._fontProvider = null;
        for (const t of this._adaptiveTiles.values()) t.img.delete();
        this._adaptiveTiles.clear();
        this._tileBakeQueue.clear();
        if (this.paint) {
            this.paint.delete();
            this.paint = null;
        }
        if (this.surface) {
            this.surface.delete();
            this.surface = null;
        }
        // Clean up cached CanvasKit objects
        this.invalidateRenderCaches();
        if (this._overlayPaints) {
            this._overlayPaints.selOutline.delete();
            this._overlayPaints.selHandleFill.delete();
            this._overlayPaints.selHandleStroke.delete();
            this._overlayPaints.hoverOutline.delete();
            this._overlayPaints.gridPaint.delete();
            this._overlayPaints.artboardFill.delete();
            this._overlayPaints.artboardStroke.delete();
            this._overlayPaints = null;
        }
    }

    onResize() {
        try {
            const dpr = window.devicePixelRatio;
            const w = Math.round(this.canvas.clientWidth * dpr);
            const h = Math.round(this.canvas.clientHeight * dpr);
            // Nothing to size to yet (hidden/detached/zero-box). A later resize
            // — or the ResizeObserver — re-fires once the canvas has a real box.
            if (w === 0 || h === 0) return;
            // No actual size change: the ResizeObserver emits an initial
            // callback and can fire on unrelated reflows, so skip the costly
            // surface recreate + reallocation when the buffer already matches.
            if (this.surface && this.canvas.width === w && this.canvas.height === h) {
                return;
            }
            // Snapshots are sized to the old surface — rebuildable, so drop.
            this.endDragLayerCache();
            // The gesture raster was sized/positioned for the old viewport, and
            // its GPU surface belongs to the context being rebuilt.
            this.dropViewSnapshot();
            this.canvas.width = w;
            this.canvas.height = h;

            if (this.surface) {
                this.surface.delete();
            }

            const ckExt = this.ck as unknown as Record<string, CallableFunction>;
            const ckRaw = this.ck as unknown as Record<string, Record<string, unknown>>;
            this.surface = ckExt.MakeOnScreenGLSurface(
                this.grContext,
                this.canvas.width,
                this.canvas.height,
                ckRaw.ColorSpace ? ckRaw.ColorSpace.SRGB : null,
            ) as Surface | null;

            // Fallback for different CanvasKit versions
            if (!this.surface && ckExt.MakeRenderTarget) {
                this.surface = ckExt.MakeRenderTarget(
                    this.glContext,
                    this.canvas.width,
                    this.canvas.height,
                ) as Surface | null;
            }
            if (!this.surface) {
                this.surface = this.ck.MakeWebGLCanvasSurface(this.canvas);
            }

            this.render();
        } catch (e) {
            console.error('Failed to resize surface:', e);
        }
    }

    zoomToFit(docW: number, docH: number, originX = 0, originY = 0) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0) return;

        const margin = 48; // css px on each side
        const scale = Math.min((viewW - margin * 2) / docW, (viewH - margin * 2) / docH);
        this.zoom = Math.max(0.02, Math.min(4, scale));
        // Center the content bounds (which may start at a non-zero origin when
        // there are multiple artboards) in the viewport.
        this.pan.x = (viewW - docW * this.zoom) / 2 - originX * this.zoom;
        this.pan.y = (viewH - docH * this.zoom) / 2 - originY * this.zoom;
        this.notifyViewChange();
    }

    /** Fit the given world-space bounds in the viewport (zoom to selection). */
    zoomToBounds(b: { x: number; y: number; w: number; h: number }) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        if (viewW <= 0 || viewH <= 0 || b.w <= 0 || b.h <= 0) return;

        const margin = 64; // css px on each side
        const scale = Math.min((viewW - margin * 2) / b.w, (viewH - margin * 2) / b.h);
        this.zoom = Math.max(0.02, Math.min(64, scale));
        this.pan.x = (viewW - b.w * this.zoom) / 2 - b.x * this.zoom;
        this.pan.y = (viewH - b.h * this.zoom) / 2 - b.y * this.zoom;
        this.notifyViewChange();
    }

    /** Set zoom keeping the viewport center fixed. */
    setZoomCentered(newZoom: number) {
        const viewW = this.canvas.clientWidth;
        const viewH = this.canvas.clientHeight;
        const cx = viewW / 2,
            cy = viewH / 2;
        const worldX = (cx - this.pan.x) / this.zoom;
        const worldY = (cy - this.pan.y) / this.zoom;
        this.zoom = Math.max(0.01, Math.min(100, newZoom));
        this.pan.x = cx - worldX * this.zoom;
        this.pan.y = cy - worldY * this.zoom;
        this.notifyViewChange();
    }

    loop() {
        if (!this.isRunning) return;
        if (this._needsRender) {
            this._needsRender = false;
            // Self-heal a stale drawing buffer before painting: if a resize
            // event was missed (some environments drop window-resize /
            // ResizeObserver delivery), the buffer no longer matches the
            // canvas box and everything renders bitmap-scaled and misaligned.
            const dpr = window.devicePixelRatio || 1;
            const bw = Math.round(this.canvas.clientWidth * dpr);
            const bh = Math.round(this.canvas.clientHeight * dpr);
            if (bw > 0 && bh > 0 && (this.canvas.width !== bw || this.canvas.height !== bh)) {
                this.onResize(); // renders internally
                requestAnimationFrame(() => this.loop());
                return;
            }
            // One bad frame must never kill the app: an uncaught throw here
            // would end the rAF chain silently — rendering, resize redraws
            // and the grid all stop until a full reload.
            try {
                this.render();
            } catch (err) {
                console.error('render frame failed:', err);
            }
        }
        requestAnimationFrame(() => this.loop());
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.loop();
    }

    fitToArtboard(docW?: number, docH?: number) {
        // Fit the union of all artboards (name kept for API stability). Explicit
        // dims still override (used by callers that know the page size).
        if (docW !== undefined && docH !== undefined) {
            this.zoomToFit(docW, docH);
        } else {
            const b = this.getArtboardsBounds();
            this.zoomToFit(b.w, b.h, b.x, b.y);
        }
        this.render();
    }

    /**
     * Read the colour actually on screen at a world point — a true eyedropper.
     * It samples the rendered frame, so it sees what the user sees: a Live Paint
     * face, a gradient stop, a pixel of an image, the result of a mask. Reading a
     * node's declared fill can't answer any of those.
     *
     * Returns straight (un-premultiplied) 0..1 RGBA, or null off-canvas.
     */
    sampleScreenColor(
        worldX: number,
        worldY: number,
    ): { r: number; g: number; b: number; a: number } | null {
        if (!this.surface || !this.ck) return null;
        // Scale from the canvas ITSELF, not devicePixelRatio. World → CSS pixels
        // is `world * zoom + pan` (the inverse of InputManager.getPos), and CSS →
        // backing store is whatever ratio the canvas actually has. Those two are
        // usually both `dpr`, but they come apart under browser page zoom, on a
        // window dragged between displays, and for the frame after a resize — and
        // when they do, this reads a pixel somewhere else entirely and returns a
        // confidently wrong colour.
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width > 0 ? this.canvas.width / rect.width : window.devicePixelRatio || 1;
        const sy = rect.height > 0 ? this.canvas.height / rect.height : sx;
        const px = Math.round((worldX * this.zoom + this.pan.x) * sx);
        const py = Math.round((worldY * this.zoom + this.pan.y) * sy);
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) return null;
        // Read back the frame as it stands, minus the hover feedback of the tool
        // doing the sampling. A pending render would change what is under the
        // cursor, so draw first rather than sampling a stale buffer.
        let bytes: Uint8Array | null = null;
        this._sampling = true;
        try {
            this.render();
            const snap = this.surface.makeImageSnapshot([px, py, px + 1, py + 1]);
            if (!snap) return null;
            try {
                bytes = snap.readPixels(0, 0, {
                    width: 1,
                    height: 1,
                    colorType: this.ck.ColorType.RGBA_8888,
                    alphaType: this.ck.AlphaType.Unpremul,
                    colorSpace: this.ck.ColorSpace.SRGB,
                }) as Uint8Array | null;
            } finally {
                snap.delete();
            }
        } finally {
            this._sampling = false;
            this.requestRender(); // put the hover highlight back
        }
        if (!bytes || bytes.length < 4) return null;
        return { r: bytes[0] / 255, g: bytes[1] / 255, b: bytes[2] / 255, a: bytes[3] / 255 };
    }

    render() {
        if (!this.surface || !this.scene.engine) return;
        // `canvas` is the CONTENT target: on a picture-record frame it is
        // swapped to a PictureRecorder canvas for the duration of the command
        // stream decode, then back. Everything before/after (grid, artboards,
        // overlays) always draws to the screen canvas.
        let canvas = this.surface.getCanvas();
        const screenCanvas = canvas;
        // In export mode we render into an offscreen surface at 1:1 (the export
        // scale is folded into this.zoom) with a transparent background and no
        // editor chrome (grid, artboard, selection, guides).
        const exporting = this._exporting;
        const dpr = exporting ? 1 : window.devicePixelRatio || 1;
        // Drag-layer state: `snapshotPass` while baking the below/above
        // snapshots (chrome-less, like exporting), `dragActive` while blitting
        // them and re-recording only the moving subtree.
        const snapshotPass = this._dragSnapshotPass;
        const dragActive = !exporting && snapshotPass === null && this._dragLayer !== null;

        if (exporting || snapshotPass === 'above') {
            canvas.clear(this.ck.TRANSPARENT);
        } else {
            canvas.clear(this.ck.Color(43, 43, 43, 1.0));
            // During a cached drag the grid is already in the below snapshot.
            if (!dragActive) this.drawGrid(canvas, dpr);
        }

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        if (exporting && this._exportBackground && this._exportBounds) {
            const bg = this._exportBackground;
            const eb = this._exportBounds;
            const p = new this.ck.Paint();
            p.setColor(
                this.ck.Color(
                    Math.round(bg.r * 255),
                    Math.round(bg.g * 255),
                    Math.round(bg.b * 255),
                    bg.a,
                ),
            );
            p.setStyle(this.ck.PaintStyle.Fill);
            canvas.drawRect(this.ck.LTRBRect(eb.x, eb.y, eb.x + eb.w, eb.y + eb.h), p);
            p.delete();
        }
        // Artboards live in the below snapshot during a cached drag, and must
        // stay out of the above snapshot.
        if (!exporting && snapshotPass !== 'above' && !dragActive) this.drawArtboards(canvas);
        if (dragActive && this._dragLayer?.below) {
            this.drawDragLayerImage(canvas, this._dragLayer.below);
        }

        // Compute viewport in document space for culling. Export culls to the
        // export bounds (a specific artboard, or the whole canvas) so content
        // renders regardless of screen size or artboard origin.
        let viewportMinX: number, viewportMinY: number, viewportMaxX: number, viewportMaxY: number;
        if (exporting) {
            const b = this._exportBounds ?? {
                x: 0,
                y: 0,
                w: this.scene.engine.get_document_width(),
                h: this.scene.engine.get_document_height(),
            };
            viewportMinX = b.x;
            viewportMinY = b.y;
            viewportMaxX = b.x + b.w;
            viewportMaxY = b.y + b.h;
        } else {
            viewportMinX = -this.pan.x / this.zoom;
            viewportMinY = -this.pan.y / this.zoom;
            viewportMaxX = (this.canvas.width / dpr - this.pan.x) / this.zoom;
            viewportMaxY = (this.canvas.height / dpr - this.pan.y) / this.zoom;
        }

        // Compute the dim target once per frame. getEditingDimTarget self-heals a
        // stale id (edited node removed by undo/delete), so dimming can never stick.
        // No dimming in export output.
        const dimTarget = exporting ? null : (this.inputManager?.getEditingDimTarget() ?? null);

        // ─── Retained scene picture: replay when the content is unchanged ───
        // Eligible = an ordinary on-screen frame whose content stream depends
        // only on the scene (no export/snapshot/bake/drag subset, no per-node
        // visibility mode a picture can't express).
        const picEligible =
            !exporting &&
            snapshotPass === null &&
            !dragActive &&
            this._bakeSubset == null &&
            dimTarget === null &&
            this.editingTextId === null &&
            (this.inputManager?.penSourceNodeId ?? null) == null;
        const contentT0 = performance.now();

        // ─── Gesture raster: one blit instead of the whole content pass ───
        // Engaged only while the view is actively being gestured AND the
        // content pass has measured slow enough to be worth trading fidelity
        // for; otherwise the picture path below serves the frame exactly.
        const viewGesturing =
            picEligible &&
            performance.now() < this._viewGestureUntil &&
            this._contentCostMs >= Renderer.VIEW_SNAP_MIN_COST_MS;
        let viewBlitted = false;
        if (viewGesturing && this.viewSnapshotUsable(dpr)) {
            this.drawViewSnapshot(canvas);
            viewBlitted = true;
        }
        // No usable raster but the gesture is running: this frame has to build
        // one. It then blits that fresh texture instead of ALSO painting the
        // picture to the screen — the two produce the same image, and one
        // replay of a large picture is the single most expensive thing in the
        // gesture. Decided up front so the content pass below can skip its
        // on-screen draw.
        const capturingThisFrame = viewGesturing && !viewBlitted;
        const zoomingIn = this.zoom > this._lastRenderZoom;
        if (!exporting && snapshotPass === null) this._lastRenderZoom = this.zoom;

        let scenePicReplayed = false;
        if (!viewBlitted && picEligible && this._scenePic) {
            const sp = this._scenePic;
            // Re-recording the picture means a full decode — the one thing that
            // still hitches mid-gesture. While the gesture is being served as a
            // raster the frame already goes through an 8-bit texture and a
            // settle re-record follows within 180 ms, so the band is widened
            // rather than paying that decode in the middle of the motion.
            const bandUp = capturingThisFrame
                ? Math.max(
                      sp.maxUp,
                      sp.hasBitmaps
                          ? Renderer.SCENE_PIC_GESTURE_UP_BITMAP
                          : Renderer.SCENE_PIC_GESTURE_UP,
                  )
                : sp.maxUp;
            // Zoom-out is NOT widened: the cull-rect test below expires at the
            // same 2× the floor does, so a wider floor buys nothing (measured).
            if (
                sp.changeCounter === this.scene.changeCounter &&
                sp.gen === this._scenePicGen &&
                sp.dpr === dpr &&
                this.zoom <= sp.zoom * bandUp &&
                this.zoom >= sp.zoom * Renderer.SCENE_PIC_MIN_DOWN &&
                viewportMinX >= sp.cullMinX &&
                viewportMinY >= sp.cullMinY &&
                viewportMaxX <= sp.cullMaxX &&
                viewportMaxY <= sp.cullMaxY
            ) {
                // On a capture frame the blit below stands in for this draw.
                if (!capturingThisFrame) this.drawScenePicture(canvas, sp);
                scenePicReplayed = true;
                // Zoom moved while riding the picture: re-record once it
                // settles so the zoom-dependent heuristics inside the decode
                // loop (tile re-bakes, sprite usability, clip strategy) run
                // against the final zoom.
                if (this.zoom !== sp.zoom) this.scheduleScenePicSettle();
            } else {
                this.invalidateScenePicture();
            }
        }

        // Re-evaluate any Boolean Group whose operands changed since last frame,
        // so the cached outline the stream draws is current. Replay/blit frames
        // skip it: groups only go dirty on mutations, and a mutation
        // (changeCounter) invalidates both caches.
        if (!scenePicReplayed && !viewBlitted) this.scene.recomputeDirtyBooleanGroups(this.ck);

        // Group sprites are bypassed in export output (full-res vectors) and
        // in per-node visibility modes a baked image can't express (edit
        // dimming, pen-source hiding, inline text editing).
        const spriteMode =
            !exporting &&
            dimTarget === null &&
            this.editingTextId === null &&
            (this.inputManager?.penSourceNodeId ?? null) == null;
        // Groups drawn as a cached sprite THIS pass: a usable sprite (sharp
        // enough for the current zoom — past its texture cap it renders
        // direct), restricted to the active stream subset so a drag/snapshot
        // pass never paints a group that belongs to a different layer. The
        // engine is told to emit these groups' brackets but skip descending
        // into their subtrees (see getRenderData → update_render_buffer).
        let spriteDrawRoots: Set<number> | null = null;
        if (spriteMode && this._groupSprites.size > 0) {
            const passSubset = dragActive || snapshotPass !== null ? this._dragSubtree : null;
            spriteDrawRoots = new Set();
            for (const [rootId, s] of this._groupSprites) {
                // Sprite too low-res for this zoom → render direct (sharp).
                if (this.zoom * dpr > s.scale * Renderer.SPRITE_USABLE_UPSCALE) continue;
                if (passSubset && !passSubset.has(rootId)) continue;
                spriteDrawRoots.add(rootId);
            }
        }

        // Draw Scene Objects via binary command stream (Phase 3: No JSON Tax).
        // Hand the engine the groups it should bracket-but-not-descend (their
        // sprite is drawn here instead), so it skips walking those subtrees.
        const spriteRootsArr =
            spriteDrawRoots && spriteDrawRoots.size > 0
                ? Uint32Array.from(spriteDrawRoots)
                : undefined;

        // The bake/drag/snapshot passes need a JS-side id subset, so they query
        // the visible ids, filter, and pass the list. Ordinary frames skip all
        // that: the engine culls to the viewport internally (one tree walk, no
        // id array marshalled across the boundary).
        const needsSubset =
            this._bakeSubset != null ||
            ((dragActive || snapshotPass !== null) && this._dragSubtree != null);
        let view: DataView;
        // World cull rect handed to the engine. A picture-record frame expands
        // it by SCENE_PIC_MARGIN per side so nearby offscreen content lands in
        // the recording and small pans replay instead of re-recording.
        let cullMinX = viewportMinX;
        let cullMinY = viewportMinY;
        let cullMaxX = viewportMaxX;
        let cullMaxY = viewportMaxY;
        if (scenePicReplayed || viewBlitted) {
            // Content already came from the retained picture (or its raster) —
            // feed the decode loop a valid empty stream so the shared path
            // below stays intact.
            view = Renderer.emptyRenderBuffer();
        } else if (needsSubset) {
            let visibleIds = this.scene.getVisibleNodes(
                viewportMinX,
                viewportMinY,
                viewportMaxX,
                viewportMaxY,
            );
            const sub = this._bakeSubset ?? this._dragSubtree!;
            const tmp = new Uint32Array(visibleIds.length);
            let n = 0;
            for (let i = 0; i < visibleIds.length; i++) {
                if (sub.has(visibleIds[i])) tmp[n++] = visibleIds[i];
            }
            visibleIds = tmp.subarray(0, n);
            view = this.scene.getRenderData(visibleIds, spriteRootsArr);
        } else {
            if (picEligible) {
                const mx = (viewportMaxX - viewportMinX) * Renderer.SCENE_PIC_MARGIN;
                const my = (viewportMaxY - viewportMinY) * Renderer.SCENE_PIC_MARGIN;
                cullMinX -= mx;
                cullMinY -= my;
                cullMaxX += mx;
                cullMaxY += my;
            }
            view = this.scene.getRenderDataCulled(
                cullMinX,
                cullMinY,
                cullMaxX,
                cullMaxY,
                spriteRootsArr,
            );
        }
        const reader = new BinaryReader(view);

        // Validate the protocol header before trusting any offsets. A magic or
        // version mismatch means the engine wasm is stale/incompatible — fail
        // loudly rather than parsing garbage.
        const magic = reader.u32();
        if (magic !== RENDER_PROTOCOL_MAGIC) {
            throw new Error(
                `Render buffer magic 0x${magic.toString(16)} != 0x${RENDER_PROTOCOL_MAGIC.toString(16)}. ` +
                    `engine/pkg is stale or corrupt — rebuild the wasm engine.`,
            );
        }
        const protocolVersion = reader.u32();
        if (protocolVersion !== EXPECTED_RENDER_PROTOCOL_VERSION) {
            throw new Error(
                `Render protocol version ${protocolVersion} != expected ${EXPECTED_RENDER_PROTOCOL_VERSION}. ` +
                    `Rebuild the wasm engine after engine/src changes, or update renderer.ts to match.`,
            );
        }

        const commandCount = reader.u32();

        // ─── Record this frame's content stream into the retained picture ───
        // The recorder canvas carries the same view transform as the screen
        // canvas, so the decode loop — including everything that reads the
        // canvas CTM, like the adaptive-tile re-bake heuristic — behaves
        // identically while drawing into the recording.
        let scenePicRecorder: PictureRecorder | null = null;
        if (picEligible && !scenePicReplayed && !viewBlitted) {
            scenePicRecorder = new this.ck.PictureRecorder();
            const rc = scenePicRecorder.beginRecording(
                this.ck.LTRBRect(
                    (cullMinX * this.zoom + this.pan.x) * dpr,
                    (cullMinY * this.zoom + this.pan.y) * dpr,
                    (cullMaxX * this.zoom + this.pan.x) * dpr,
                    (cullMaxY * this.zoom + this.pan.y) * dpr,
                ),
            );
            rc.save();
            rc.scale(dpr, dpr);
            rc.translate(this.pan.x, this.pan.y);
            rc.scale(this.zoom, this.zoom);
            canvas = rc;
        }

        // Mask spans never straddle frames; reset so a mid-frame desync can't
        // leak stale span state into the next frame.
        this._maskStack.length = 0;
        if (!this.paint) this.paint = new this.ck.Paint();
        const p = this.paint;
        // Anti-aliasing is disabled only for the supersampled export pass, where
        // the downscale supplies the AA (SSAA) and abutting fills must tile
        // exactly to avoid seams. On-screen and 1× export keep analytic AA.
        const contentAA = !this._exportNoAA;
        p.setAntiAlias(contentAA);

        // Geometric-clip masks (mask_type 2) render as real canvas clips only
        // when zoomed in enough that the alpha-mask saveLayer sandwich is the
        // dominant cost. Measured on Tux.svg (13 clip spans): at ≥24 device px
        // per unit clips cut frame time up to ~2× (no more full-viewport
        // layers), while at low zoom Skia's AA path-clip masks are *slower*
        // than the layers — so each frame picks the cheaper strategy.
        const clipMaskDevScale = this.zoom * dpr;
        const useGeometricClips = clipMaskDevScale >= 24;

        // Group nesting depth — 0 means the next START_GROUP is a root group
        // (the sprite-cache unit).
        let groupDepth = 0;
        // Stack of enclosing group nodeIds, so an in-stream Live Paint
        // face/edge command (CMD_LP_FACES/EDGES, emitted right after its
        // group's START_GROUP) can be attributed to its group. During a
        // drag/snapshot pass only the moving subtree is re-recorded; the engine
        // still emits every group's bracket + LP faces unconditionally (only
        // LEAF draws honor the visible-id subset), so without this the moving
        // group's fills bake into the static snapshot at their rest position
        // and stay behind as a ghost when the group moves.
        const groupIdStack: number[] = [];
        // Non-null only on a subset pass (sprite bake, or drag/snapshot): LP
        // faces/edges whose enclosing group is outside the re-recorded subset
        // must be skipped, or they leak into that pass's output (a sprite/
        // snapshot bitmap) at their rest position. Mirrors the `needsSubset`
        // active-subset selection below.
        const lpPassSubset =
            this._bakeSubset ?? (dragActive || snapshotPass !== null ? this._dragSubtree : null);

        for (let i = 0; i < commandCount; i++) {
            const recordLen = reader.u32();
            const recordStart = reader.offset;
            const cmdType = reader.u32();
            const nodeId = reader.u32();

            if (cmdType === 1) {
                // CMD_START_GROUP
                const isRootLevel = groupDepth === 0;
                groupDepth++;
                groupIdStack.push(nodeId);
                // A group arriving as a geometric clip's mask node can't be
                // captured as a single clip path — convert the span back to
                // the alpha saveLayer protocol before the group renders. A
                // group as an alpha/luma mask node likewise opens its pending
                // layers unbounded (its extent isn't known without recursing).
                const groupSpan = this._maskStack[this._maskStack.length - 1];
                if (groupSpan && groupSpan.mode === 2 && groupSpan.pendingClip) {
                    groupSpan.pendingClip = false;
                    groupSpan.converted = true;
                    canvas.saveLayer();
                } else if (groupSpan?.pendingLayer) {
                    this.openMaskLayers(canvas, groupSpan, null);
                }
                const opacity = reader.f32();
                const groupFlags = reader.u32();
                const groupBlend = (groupFlags >>> 16) & 0xff;
                // A non-Normal blend mode requires an isolation layer so the
                // group composites as a single unit against the backdrop (like
                // opacity does), otherwise the group's blend would never apply.
                if (nodeId === this._spriteBakeRootId) {
                    // Sprite bake: the root's own opacity/blend are applied at
                    // draw time (the stream carries them every frame) — baking
                    // them in would double-apply.
                    canvas.save();
                } else if (opacity < 1.0 || groupBlend > 0) {
                    p.setAlphaf(opacity);
                    const bm = this.ckBlendModes();
                    if (groupBlend > 0 && groupBlend < bm.length) p.setBlendMode(bm[groupBlend]);
                    canvas.saveLayer(p);
                    p.setAlphaf(1.0);
                    p.setBlendMode(this.ck.BlendMode.SrcOver);
                } else {
                    canvas.save();
                }

                // Group sprite: a cached root group in spriteDrawRoots draws as
                // one baked image (the engine emitted only its bracket, having
                // skipped the subtree). Root groups NOT drawn as a sprite this
                // pass are queued: an eligibility check + first bake when
                // uncached, or a re-bake toward the texture cap when the current
                // sprite is too low-res for the zoom.
                if (isRootLevel && spriteMode) {
                    const drawSprite = spriteDrawRoots?.has(nodeId) ?? false;
                    const sprite = this._groupSprites.get(nodeId);
                    if (drawSprite && sprite) {
                        const abClip = this.getNodeArtboardClip?.(nodeId);
                        if (abClip && abClip.w > 0 && abClip.h > 0) {
                            canvas.save();
                            canvas.clipRect(
                                this.ck.LTRBRect(
                                    abClip.x,
                                    abClip.y,
                                    abClip.x + abClip.w,
                                    abClip.y + abClip.h,
                                ),
                                this.ck.ClipOp.Intersect,
                                contentAA,
                            );
                            this.drawGroupSprite(canvas, nodeId, sprite, clipMaskDevScale);
                            canvas.restore();
                        } else {
                            this.drawGroupSprite(canvas, nodeId, sprite, clipMaskDevScale);
                        }
                    } else if (sprite) {
                        // Rendered direct because the sprite is too low-res for
                        // this zoom: queue a re-bake at the achievable scale so it
                        // becomes usable again once the view settles. Threshold
                        // just above the usable factor so a settled zoom always
                        // converges back to the (fast) sprite path.
                        const target = Math.min(
                            clipMaskDevScale,
                            this.spriteMaxScale(sprite.w, sprite.h),
                        );
                        if (target / sprite.scale > 1.05) this._spriteWanted.add(nodeId);
                    } else if (!this._spriteIneligible.has(nodeId)) {
                        this._spriteWanted.add(nodeId);
                    }
                }
            } else if (cmdType === 3) {
                // CMD_END_GROUP
                groupDepth--;
                groupIdStack.pop();
                canvas.restore();
            } else if (cmdType === 4) {
                // CMD_BEGIN_MASK
                // Read mask_type: 0 = alpha, 1 = luminance, 2 = geometric clip.
                // Clip-eligible masks fall back to the alpha protocol at low
                // zoom, where layers are cheaper than AA path clips.
                let maskType = reader.u32();
                if (maskType === 2 && !useGeometricClips) maskType = 0;
                this._maskStack.push({
                    mode: maskType,
                    pendingClip: maskType === 2,
                    // Alpha/luma layers are opened lazily at the mask shape's
                    // DRAW_NODE record, where its geometry bounds are known —
                    // see openMaskLayers().
                    pendingLayer: maskType !== 2,
                    converted: false,
                    bounds: null,
                });
                if (maskType === 2) {
                    // Geometric clip fast path: the mask shape becomes a plain
                    // canvas clip — no saveLayer sandwich, so no full-viewport
                    // offscreen layers (which dominate frame cost at high
                    // zoom). The next DRAW_NODE record is captured as the clip
                    // path instead of being drawn; if the mask node turns out
                    // not to be a plain shape, the span converts itself back
                    // to the alpha protocol (see `converted`).
                    canvas.save();
                }
            } else if (cmdType === 5) {
                // CMD_BEGIN_MASKED_CONTENT
                const span = this._maskStack[this._maskStack.length - 1];
                const maskType = span ? span.mode : 0;
                if (maskType === 2 && span && !span.converted) {
                    // Clip mode: content draws directly under the clip — no
                    // layers. If the clip shape never arrived (culled while
                    // offscreen), clip to nothing so the content is hidden,
                    // matching what an empty alpha mask produces.
                    if (span.pendingClip) {
                        span.pendingClip = false;
                        canvas.clipRect(
                            this.ck.LTRBRect(0, 0, 0, 0),
                            this.ck.ClipOp.Intersect,
                            false,
                        );
                    }
                } else {
                    // Mask node never arrived (culled offscreen): open the
                    // layers now so the restore counts stay balanced — the
                    // empty mask hides the content, as before.
                    if (span?.pendingLayer) this.openMaskLayers(canvas, span, null);
                    if (maskType === 1) {
                        // Restore the luma layer: mask shapes are composited through
                        // the luminance→alpha filter into the outer layer.
                        canvas.restore();
                    }
                    // Content layer: on restore it composites into the mask/outer
                    // layer with SrcIn, so content survives only where the mask has
                    // coverage (alpha for alpha-masks, luminance-derived alpha for
                    // luminance masks). Content outside the mask's bounds is
                    // discarded by SrcIn anyway, so the mask bounds bound this
                    // layer too.
                    if (!this._maskPaint) this._maskPaint = new this.ck.Paint();
                    this._maskPaint.setBlendMode(this.ck.BlendMode.SrcIn);
                    canvas.saveLayer(this._maskPaint, span?.bounds ?? undefined);
                }
            } else if (cmdType === 6) {
                // CMD_END_MASK
                const span = this._maskStack.pop();
                if (span && span.mode === 2 && !span.converted) {
                    canvas.restore(); // pops the clip scope save
                } else {
                    canvas.restore(); // content → mask/outer layer (SrcIn)
                    canvas.restore(); // masked result → canvas
                    // A converted clip span opened an extra clip-scope save
                    // before falling back to the alpha protocol.
                    if (span && span.mode === 2 && span.converted) canvas.restore();
                }
            } else if (cmdType === 7) {
                // CMD_LP_FACES (Live Paint face fills). On a drag/snapshot pass,
                // skip drawing (but still read, to stay frame-aligned) when the
                // enclosing group isn't in the re-recorded subset — otherwise
                // the moving group's fills bake into the static snapshot and
                // ghost behind the moved shapes.
                const lpSkip =
                    lpPassSubset !== null &&
                    !lpPassSubset.has(groupIdStack[groupIdStack.length - 1]);
                const faceCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Fill);
                p.setShader(null);
                p.setAntiAlias(contentAA);
                for (let fi = 0; fi < faceCount; fi++) {
                    // v13: a full paint block, so a region can hold a gradient —
                    // either painted with the bucket, or inherited from a
                    // gradient-filled member showing through.
                    const paint = this.readPaint(reader);
                    const path = this.readFaceRingsPath(reader);
                    if (!lpSkip) {
                        if (paint.type === 2 || paint.type === 3) {
                            // Face outlines are WORLD space and carry no
                            // transform, so the gradient's coords are too.
                            p.setAlphaf(1);
                            p.setShader(
                                this.getOrCreateGradientShader(
                                    paint.type,
                                    paint.stops,
                                    paint.start,
                                    paint.end,
                                    1,
                                    paint.spread,
                                    paint.focal,
                                    paint.transform,
                                ),
                            );
                            canvas.drawPath(path, p);
                            p.setShader(null);
                        } else if (paint.type === 1) {
                            p.setColor(this.ck.Color4f(paint.r, paint.g, paint.b, paint.a));
                            canvas.drawPath(path, p);
                        }
                        // type 0 (and anything the engine declines to emit for a
                        // face) draws nothing, same as an unpainted region.
                    }
                    path.delete();
                }
            } else if (cmdType === 8) {
                // CMD_LP_EDGES (Live Paint painted edges). Same drag/snapshot
                // subset gate as CMD_LP_FACES above.
                const lpSkip =
                    lpPassSubset !== null &&
                    !lpPassSubset.has(groupIdStack[groupIdStack.length - 1]);
                const edgeCount = reader.u32();
                p.setStyle(this.ck.PaintStyle.Stroke);
                p.setShader(null);
                p.setAntiAlias(contentAA);
                p.setStrokeCap(this.ck.StrokeCap.Round);
                p.setStrokeJoin(this.ck.StrokeJoin.Round);
                for (let ei = 0; ei < edgeCount; ei++) {
                    const r = reader.f32(),
                        gg = reader.f32(),
                        bb = reader.f32(),
                        aa = reader.f32();
                    const width = reader.f32();
                    const path = this.readOutlinePath(reader, false);
                    if (!lpSkip) {
                        p.setColor(this.ck.Color4f(r, gg, bb, aa));
                        p.setStrokeWidth(width > 0 ? width : 2);
                        canvas.drawPath(path, p);
                    }
                    path.delete();
                }
                p.setStrokeCap(this.ck.StrokeCap.Butt);
                p.setStrokeJoin(this.ck.StrokeJoin.Miter);
            } else if (cmdType === 2) {
                // CMD_DRAW_NODE
                const nodeType = reader.u32();
                const matrix = reader.f32Array(9);

                // Dim non-edited nodes in path edit mode. While the pen tool is
                // extending an existing open path (endpoint continuation), hide the
                // source node entirely — the blue pen preview stands in for it, so
                // it isn't doubled.
                const nodeAlpha =
                    this.inputManager?.penSourceNodeId === nodeId
                        ? 0
                        : dimTarget !== null && nodeId !== dimTarget
                          ? 0.3
                          : 1.0;

                // ─── Read Fills ─────────────────
                const fillCount = reader.u32();
                const fills: any[] = [];
                for (let i = 0; i < fillCount; i++) fills.push(this.readPaint(reader));

                // ─── Read Strokes ───────────────
                const strokeCount = reader.u32();
                const strokes: any[] = [];
                for (let i = 0; i < strokeCount; i++) {
                    const strokeType = reader.u32();
                    let paint: any = { type: 0 };
                    if (strokeType === 1) {
                        // Solid
                        paint = {
                            type: 1,
                            r: reader.f32(),
                            g: reader.f32(),
                            b: reader.f32(),
                            a: reader.f32(),
                        };
                    } else if (strokeType === 2 || strokeType === 3) {
                        // Gradient
                        const stopCount = reader.u32();
                        const stops = [];
                        for (let s = 0; s < stopCount; s++) {
                            stops.push({
                                offset: reader.f32(),
                                r: reader.f32(),
                                g: reader.f32(),
                                b: reader.f32(),
                                a: reader.f32(),
                            });
                        }
                        paint = {
                            type: strokeType,
                            stops,
                            start: [reader.f32(), reader.f32()],
                            end: [reader.f32(), reader.f32()],
                            spread: reader.u32(),
                            focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                            // v11: optional gradient→local affine (elliptical radial).
                            transform: reader.u32()
                                ? [
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                      reader.f32(),
                                  ]
                                : null,
                        };
                    } else if (strokeType === 4) {
                        // Pattern
                        paint = {
                            type: 4,
                            imageId: reader.u32(),
                            width: reader.f32(),
                            height: reader.f32(),
                            transform: [
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                                reader.f32(),
                            ],
                        };
                    } else if (strokeType === 5) {
                        // Mesh gradient — must consume the full record even
                        // though mesh strokes aren't supported: degrade to the
                        // mean vertex color (the UI never creates these).
                        const mesh = this.readMeshPaint(reader);
                        const mean = meanColor(mesh);
                        paint = { type: 1, r: mean.r, g: mean.g, b: mean.b, a: mean.a };
                    }
                    const width = reader.f32();
                    const cap = reader.u32();
                    const join = reader.u32();
                    const dashCount = reader.u32();
                    const dashArray: number[] = [];
                    for (let d = 0; d < dashCount; d++) dashArray.push(reader.f32());
                    strokes.push({
                        paint,
                        width,
                        cap,
                        join,
                        dashArray,
                        dashPhase: reader.f32(),
                        miterLimit: reader.f32(),
                        alignment: reader.u32(),
                    });
                }

                const cornerRadius = reader.f32();
                const styleFlags = reader.u32();
                const blendMode = (styleFlags >>> 16) & 0xff;
                const fillRule = (styleFlags >>> 24) & 0xff;

                // Effects block: count + self-describing records (payload size
                // fixed per kind). Read before geometry so offsets stay aligned.
                const effectCount = reader.u32();
                const effects: EffectRecord[] = [];
                for (let e = 0; e < effectCount; e++) {
                    const kind = reader.u32();
                    if (kind === 0) {
                        // Blur: radius_x, radius_y (v11 — anisotropic)
                        const radius = reader.f32();
                        const radiusY = reader.f32();
                        effects.push({
                            kind,
                            radius,
                            radiusY,
                            dx: 0,
                            dy: 0,
                            r: 0,
                            g: 0,
                            b: 0,
                            a: 0,
                        });
                    } else if (kind === 1) {
                        // DropShadow: dx,dy,blur,r,g,b,a
                        const dx = reader.f32(),
                            dy = reader.f32(),
                            radius = reader.f32();
                        effects.push({
                            kind,
                            radius,
                            radiusY: radius,
                            dx,
                            dy,
                            r: reader.f32(),
                            g: reader.f32(),
                            b: reader.f32(),
                            a: reader.f32(),
                        });
                    } else if (kind === 2) {
                        // ColorMatrix: 20 floats + 1 u32 (linearRGB flag)
                        const matrix: number[] = [];
                        for (let i = 0; i < 20; i++) matrix.push(reader.f32());
                        const linearRGB = reader.u32() !== 0;
                        effects.push({
                            kind,
                            radius: 0,
                            radiusY: 0,
                            dx: 0,
                            dy: 0,
                            r: 0,
                            g: 0,
                            b: 0,
                            a: 0,
                            matrix,
                            linearRGB,
                        });
                    }
                }

                // Clip-capture: this DRAW_NODE is the mask shape of a geometric
                // clip span (mask_type 2) — apply its geometry as a canvas clip
                // instead of drawing it. The record is length-framed, so the
                // remainder (its geometry was consumed to build the path) can
                // be skipped exactly.
                const clipSpan = this._maskStack[this._maskStack.length - 1];
                if (clipSpan && clipSpan.mode === 2 && clipSpan.pendingClip) {
                    clipSpan.pendingClip = false;
                    let clipped = false;
                    if (nodeType === 0 || nodeType === 1 || nodeType === 2) {
                        // Reuse the node-transformed clip path across frames;
                        // rebuilding costs a wasm path copy + transform per
                        // span per frame.
                        const key = `${fillRule}|${matrix.join(',')}`;
                        let entry = this._clipPathCache.get(nodeId);
                        if (!entry || entry.key !== key) {
                            const p = this.getBinaryGeometryPath(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (p) {
                                p.setFillType(
                                    fillRule === 1
                                        ? this.ck.FillType.EvenOdd
                                        : this.ck.FillType.Winding,
                                );
                                p.transform(matrix);
                                if (entry) entry.path.delete();
                                entry = { path: p, key };
                                this._clipPathCache.set(nodeId, entry);
                            }
                        }
                        if (entry) {
                            // AA matches the content AA (off only in the
                            // supersampled export pass, where the downscale
                            // supplies it).
                            canvas.clipPath(entry.path, this.ck.ClipOp.Intersect, contentAA);
                            clipped = true;
                        }
                    }
                    if (!clipped) {
                        // Unclippable geometry (text/image) — hide the span,
                        // matching what an empty alpha mask would produce.
                        canvas.clipRect(
                            this.ck.LTRBRect(0, 0, 0, 0),
                            this.ck.ClipOp.Intersect,
                            false,
                        );
                    }
                    reader.offset = recordStart + recordLen;
                    continue;
                }

                // Deferred mask layers: this DRAW_NODE is the mask shape of an
                // alpha/luma span — open the span's layers bounded to this
                // shape's extent (geometry + stroke + filter spill, mapped by
                // its matrix) before it draws its coverage into them.
                if (clipSpan?.pendingLayer) {
                    let maskBounds: ReturnType<CanvasKit['LTRBRect']> | null = null;
                    // A ColorMatrix effect can tint fully-transparent pixels,
                    // giving the mask coverage beyond its geometry — keep the
                    // layer unbounded in that case.
                    if (effects.every((e) => e.kind === 0 || e.kind === 1)) {
                        const gb = this.peekGeometryBounds(nodeType, reader, cornerRadius, nodeId);
                        if (gb) {
                            let pad = 2 / clipMaskDevScale; // AA fringe
                            for (const st of strokes)
                                if (st.paint.type !== 0) pad = Math.max(pad, st.width);
                            for (const e of effects) {
                                if (e.kind === 0) {
                                    pad += 3 * Math.max(e.radius, e.radiusY);
                                } else {
                                    pad += 3 * e.radius + Math.max(Math.abs(e.dx), Math.abs(e.dy));
                                }
                            }
                            const l = gb[0] - pad;
                            const t = gb[1] - pad;
                            const rt = gb[2] + pad;
                            const bt = gb[3] + pad;
                            let minX = Infinity;
                            let minY = Infinity;
                            let maxX = -Infinity;
                            let maxY = -Infinity;
                            for (const [x, y] of [
                                [l, t],
                                [rt, t],
                                [l, bt],
                                [rt, bt],
                            ]) {
                                const mx = matrix[0] * x + matrix[1] * y + matrix[2];
                                const my = matrix[3] * x + matrix[4] * y + matrix[5];
                                if (mx < minX) minX = mx;
                                if (mx > maxX) maxX = mx;
                                if (my < minY) minY = my;
                                if (my > maxY) maxY = my;
                            }
                            maskBounds = this.ck.LTRBRect(minX, minY, maxX, maxY);
                        }
                    }
                    this.openMaskLayers(canvas, clipSpan, maskBounds);
                }

                canvas.save();
                // RCB clipContent: intersect world artboard before local xform
                // so overflow ink cannot paint onto the pasteboard.
                const abClip = this.getNodeArtboardClip?.(nodeId);
                if (abClip) {
                    if (abClip.w > 0 && abClip.h > 0) {
                        canvas.clipRect(
                            this.ck.LTRBRect(
                                abClip.x,
                                abClip.y,
                                abClip.x + abClip.w,
                                abClip.y + abClip.h,
                            ),
                            this.ck.ClipOp.Intersect,
                            contentAA,
                        );
                    } else {
                        // Zero clip = focus-hidden plate. Empty intersect culls
                        // all draws (do not skip the hook — fallthrough used to
                        // paint other workbench paths unclipped).
                        canvas.clipRect(
                            this.ck.LTRBRect(0, 0, 0, 0),
                            this.ck.ClipOp.Intersect,
                            false,
                        );
                    }
                }
                canvas.concat(matrix);

                // Wrap the node's drawing in a filtered layer so blur/shadow
                // apply to the composited result (fills + strokes + image).
                let effectLayerOpen = false;
                if (effects.length > 0) {
                    const filter = this.getEffectFilter(effects);
                    if (filter) {
                        if (!this._effectPaint) this._effectPaint = new this.ck.Paint();
                        this._effectPaint.setImageFilter(filter);
                        // Bound the filtered layer to the node's geometry plus
                        // the filter spill (3σ covers a gaussian's visible
                        // extent) and stroke width. An unbounded saveLayer
                        // allocates a full-viewport texture per filtered node
                        // — that, times every blurred node, dominates frame
                        // time at high zoom. ColorMatrix effects can tint
                        // fully-transparent pixels, so only pure blur/shadow
                        // stacks are bounded.
                        let layerBounds: ReturnType<CanvasKit['LTRBRect']> | undefined;
                        if (effects.every((e) => e.kind === 0 || e.kind === 1)) {
                            const gb = this.peekGeometryBounds(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (gb) {
                                let pad = 0;
                                for (const st of strokes)
                                    if (st.paint.type !== 0) pad = Math.max(pad, st.width);
                                let spill = 0;
                                for (const e of effects) {
                                    if (e.kind === 0) {
                                        spill = Math.max(spill, 3 * Math.max(e.radius, e.radiusY));
                                    } else {
                                        spill = Math.max(
                                            spill,
                                            3 * e.radius + Math.max(Math.abs(e.dx), Math.abs(e.dy)),
                                        );
                                    }
                                }
                                pad += spill;
                                layerBounds = this.ck.LTRBRect(
                                    gb[0] - pad,
                                    gb[1] - pad,
                                    gb[2] + pad,
                                    gb[3] + pad,
                                );
                            }
                        }
                        canvas.saveLayer(this._effectPaint, layerBounds);
                        effectLayerOpen = true;
                    }
                }

                const startGeoOffset = reader.offset;
                const geoSize = reader.view.getUint32(startGeoOffset, true);

                // Apply blend mode (shared across fill + stroke passes)
                const ckBlendModes = this.ckBlendModes();
                if (blendMode > 0 && blendMode < ckBlendModes.length) {
                    p.setBlendMode(ckBlendModes[blendMode]);
                }

                // Image nodes (type 5) carry no fills/strokes — draw the raster
                // and skip the fill/stroke passes.
                if (nodeType === 5) {
                    reader.offset = startGeoOffset + 4; // skip the geometry size u32
                    const iw = reader.f32();
                    const ih = reader.f32();
                    const imageId = reader.u32();
                    const pixelated = reader.u32() !== 0;
                    this.drawImageNode(canvas, imageId, iw, ih, nodeAlpha, pixelated);
                    reader.offset = startGeoOffset + 4 + geoSize;
                }
                // Fill Pass(es)
                else if (fills.length === 0 && strokes.length === 0) {
                    reader.offset += 4 + geoSize; // Skip geometry if totally invisible
                } else {
                    for (const fill of fills) {
                        if (fill.type === 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader
                        if (fill.type === 1) {
                            p.setColor(this.ck.Color4f(fill.r, fill.g, fill.b, fill.a * nodeAlpha));
                            p.setShader(null);
                        } else if (fill.type === 2 || fill.type === 3) {
                            const fillShader = this.getOrCreateGradientShader(
                                fill.type,
                                fill.stops,
                                fill.start,
                                fill.end,
                                nodeAlpha,
                                fill.spread,
                                fill.focal,
                                fill.transform,
                            );
                            // A shader is still modulated by the paint's alpha,
                            // and a prior solid/semi-transparent fill may have
                            // left it < 1 (e.g. an opacity-folded shadow drawn
                            // just before). nodeAlpha is already baked into the
                            // shader's stop colors, so force the paint opaque or
                            // the gradient renders washed out.
                            p.setAlphaf(1);
                            p.setShader(fillShader);
                        } else if (fill.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha)); // alpha via color
                            p.setShader(
                                this.getPatternShader(
                                    fill.imageId,
                                    fill.width,
                                    fill.height,
                                    fill.transform,
                                ),
                            );
                        } else if (fill.type === 5) {
                            // Mesh gradient: a cached raster of the tessellated
                            // mesh, applied as an image shader through the
                            // ordinary fill draw (same flow as patterns). The
                            // geometry bounds size the raster so the boundary
                            // flood covers the whole path (peek restores the
                            // reader offset).
                            const gb = this.peekGeometryBounds(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            const meshShader = this.getMeshFillShader(
                                canvas,
                                fill.mesh,
                                nodeAlpha,
                                gb,
                            );
                            if (meshShader) {
                                // Alpha lives in the raster; force the paint
                                // opaque like the gradient branch above.
                                p.setAlphaf(1);
                                p.setShader(meshShader);
                            } else {
                                // Degenerate mesh: mean vertex color.
                                const mean = meanColor(fill.mesh);
                                p.setColor(
                                    this.ck.Color4f(mean.r, mean.g, mean.b, mean.a * nodeAlpha),
                                );
                                p.setShader(null);
                            }
                        }
                        p.setStyle(this.ck.PaintStyle.Fill);
                        this.drawBinaryGeometry(
                            canvas,
                            nodeType,
                            reader,
                            p,
                            cornerRadius,
                            fillRule,
                            nodeId,
                        );
                        p.setShader(null);
                    }
                    if (fills.length === 0) {
                        // Skip geometry once if there were no fills, so strokes can rewind
                        reader.offset += 4 + geoSize;
                    }

                    // Stroke Pass(es)
                    const ckCaps = this.getCkCaps();
                    const ckJoins = this.getCkJoins();

                    for (const st of strokes) {
                        if (st.paint.type === 0 || st.width <= 0) continue;
                        reader.offset = startGeoOffset; // Rewind geometry reader

                        if (st.paint.type === 1) {
                            p.setColor(
                                this.ck.Color4f(
                                    st.paint.r,
                                    st.paint.g,
                                    st.paint.b,
                                    st.paint.a * nodeAlpha,
                                ),
                            );
                            p.setShader(null);
                        } else if (st.paint.type === 2 || st.paint.type === 3) {
                            const strokeShader = this.getOrCreateGradientShader(
                                st.paint.type,
                                st.paint.stops,
                                st.paint.start,
                                st.paint.end,
                                nodeAlpha,
                                st.paint.spread,
                                st.paint.focal,
                                st.paint.transform,
                            );
                            // Reset any leftover paint alpha (see fill gradient).
                            p.setAlphaf(1);
                            p.setShader(strokeShader);
                        } else if (st.paint.type === 4) {
                            p.setColor(this.ck.Color4f(1, 1, 1, nodeAlpha));
                            p.setShader(
                                this.getPatternShader(
                                    st.paint.imageId,
                                    st.paint.width,
                                    st.paint.height,
                                    st.paint.transform,
                                ),
                            );
                        }

                        p.setStyle(this.ck.PaintStyle.Stroke);

                        // 0: Center, 1: Inner, 2: Outer
                        if (st.alignment === 0) {
                            p.setStrokeWidth(st.width);
                        } else {
                            // Multiply by 2 because clip will hide half of it
                            p.setStrokeWidth(st.width * 2);
                        }

                        p.setStrokeCap(ckCaps[st.cap] ?? this.ck.StrokeCap.Butt);
                        p.setStrokeJoin(ckJoins[st.join] ?? this.ck.StrokeJoin.Miter);
                        p.setStrokeMiter(st.miterLimit);

                        let dashEffect = null;
                        const intervals = dashIntervals(st.dashArray);
                        if (intervals) {
                            dashEffect = this.ck.PathEffect.MakeDash(intervals, st.dashPhase);
                            p.setPathEffect(dashEffect);
                        }

                        if (st.alignment === 1 || st.alignment === 2) {
                            // Need to parse geometry path to clip
                            const tempPath = this.getBinaryGeometryPath(
                                nodeType,
                                reader,
                                cornerRadius,
                                nodeId,
                            );
                            if (tempPath) {
                                canvas.save();
                                if (st.alignment === 1) {
                                    // Inner
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Intersect, true);
                                } else if (st.alignment === 2) {
                                    // Outer
                                    canvas.clipPath(tempPath, this.ck.ClipOp.Difference, true);
                                }
                                canvas.drawPath(tempPath, p);
                                canvas.restore();
                                tempPath.delete();
                            }
                        } else {
                            // Standard draw
                            this.drawBinaryGeometry(
                                canvas,
                                nodeType,
                                reader,
                                p,
                                cornerRadius,
                                undefined,
                                nodeId,
                            );
                        }

                        if (dashEffect) {
                            p.setPathEffect(null);
                            dashEffect.delete();
                        }
                        p.setShader(null);
                    }

                    // Arrowhead / line-ending markers (on top of the stroke, in
                    // the node's local space — so they export with the artwork).
                    this.drawNodeMarkers(canvas, nodeId, strokes);

                    if (strokes.length === 0 && fills.length > 0) {
                        // Keep reader at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    } else if (strokes.length > 0) {
                        // After last stroke, reader is already at the end of geometry
                        reader.offset = startGeoOffset + 4 + geoSize;
                    }
                }

                // Reset blend mode after all passes
                if (blendMode > 0) {
                    p.setBlendMode(this.ck.BlendMode.SrcOver);
                }

                if (effectLayerOpen) canvas.restore(); // composite the filtered layer
                canvas.restore();
            }

            // Framing check: every record declared its own byte length. If the
            // reader didn't consume exactly that, writer/reader layouts have
            // skewed (usually a stale engine/pkg). Report once, then resync to
            // the declared record boundary so the rest of the frame still draws.
            const consumed = reader.offset - recordStart;
            if (consumed !== recordLen) {
                if (!this._protocolDesyncWarned) {
                    console.error(
                        `Render protocol desync at command ${i} (cmdType=${cmdType}, node=${nodeId}): ` +
                            `consumed ${consumed} bytes but record declared ${recordLen}. ` +
                            `Writer/reader layout skew — engine/pkg is likely stale.`,
                    );
                    this._protocolDesyncWarned = true;
                }
                reader.offset = recordStart + recordLen;
            }
        }

        // ─── Finish the retained-picture recording and paint it ───
        if (scenePicRecorder) {
            canvas.restore(); // matches the recorder canvas's save() above
            const pic = scenePicRecorder.finishRecordingAsPicture();
            scenePicRecorder.delete();
            canvas = screenCanvas;
            // Baked bitmaps in the recording (group sprites, adaptive filter
            // tiles, raster images) go visibly soft when the replay upscales
            // them, so their presence tightens the zoom-in band. Pure vector
            // content replays sharp at any zoom (ops re-rasterize under the
            // playback CTM); its band is bounded only to keep the heuristics
            // from drifting too far.
            const hasBitmaps =
                (spriteDrawRoots !== null && spriteDrawRoots.size > 0) ||
                this._adaptiveTiles.size > 0 ||
                adaptiveTileSources.size > 0 ||
                this._imageCache.size > 0;
            this._scenePic?.pic.delete();
            this._scenePic = {
                pic,
                zoom: this.zoom,
                panX: this.pan.x,
                panY: this.pan.y,
                dpr,
                changeCounter: this.scene.changeCounter,
                gen: this._scenePicGen,
                cullMinX,
                cullMinY,
                cullMaxX,
                cullMaxY,
                maxUp: hasBitmaps ? 1.12 : 2.0,
                hasBitmaps,
            };
            // This frame's content itself comes from the recording (V_rec
            // equals the current view, so the corrective concat is identity) —
            // unless it is about to be captured, in which case the blit below
            // paints it instead of replaying the picture a second time.
            if (!capturingThisFrame) this.drawScenePicture(canvas, this._scenePic);
        }

        // What the content pass actually cost in JS this frame. Blit frames are
        // excluded: they measure the blit, not the work it replaced, so
        // including them would decay the estimate and disengage the raster.
        // Capture frames are excluded for the same reason — they deliberately
        // skip the on-screen replay, so what they measure is not what a plain
        // frame would cost, and letting them drive the estimate down would
        // disengage the raster mid-gesture and re-engage it a frame later.
        if (!viewBlitted && !capturingThisFrame && !exporting && snapshotPass === null) {
            const cost = performance.now() - contentT0;
            this._contentCostMs =
                this._contentCostMs === 0 ? cost : this._contentCostMs * 0.7 + cost * 0.3;
        }

        // A gesture is under way and this frame had to pay the content pass —
        // rasterize it now so the rest of the gesture is a blit, and paint THIS
        // frame from that same texture. If the capture can't be made (no
        // picture, no GL, region unusable) the picture is drawn directly, which
        // is exactly what a non-gesture frame would have done.
        if (capturingThisFrame) {
            const captured = this._scenePic ? this.captureViewSnapshot(dpr, zoomingIn) : false;
            if (captured) {
                this.drawViewSnapshot(canvas);
            } else if (this._scenePic) {
                this.drawScenePicture(canvas, this._scenePic);
            }
        }

        // Live Paint faces/edges are no longer drawn here — they're emitted
        // in-stream at the group's z (CMD_LP_FACES/EDGES) so members' strokes
        // sit on top, like Illustrator.

        // Kick off any sprite bakes queued during this frame (debounced until
        // the view settles; skipped inside export/bake passes). Also self-heal
        // a stranded tile queue: a schedule request during a busy drain is
        // dropped, so re-arm it from the frame loop.
        if (!exporting && snapshotPass === null) {
            if (this._spriteWanted.size > 0) this.scheduleSpriteBakes();
            if (this._tileBakeQueue.size > 0) this.scheduleTileBakes();
        }

        // Static content above the moving nodes, blitted over them so z-order
        // holds during a cached drag (still under the editor overlays below).
        if (dragActive && this._dragLayer?.above) {
            this.drawDragLayerImage(canvas, this._dragLayer.above);
        }

        // Editor overlays — never part of exported output or drag snapshots.
        if (!exporting && snapshotPass === null) {
            // Draw live preview shape (while user is dragging to create)
            this.drawPreview(canvas);
            // Draw the parametric-action preview (ghost of Offset/Simplify/Blend)
            this.drawShapePreview(canvas);
            // Draw pen tool in-progress path
            this.drawPenPreview(canvas);
            // Draw paint bucket hover preview
            this.drawPaintBucketHover(canvas);
            // Draw marquee selection rectangle
            this.drawMarquee(canvas);
            // Draw persistent ruler guides (under the transient snap guides)
            this.drawGuides(canvas, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
            // Draw snapping alignment guides
            this.drawSnapGuides(canvas, viewportMinX, viewportMinY, viewportMaxX, viewportMaxY);
        }

        canvas.restore();

        if (!exporting && snapshotPass === null) {
            // Product decorations (empty-gen icons, …) under selection chrome.
            try {
                this.drawProductSceneOverlay?.(canvas, dpr);
            } catch {
                /* product hook must not kill the frame */
            }
            // Draw hover outline (shape under cursor, selection tool)
            this.drawHoverOutline(canvas, dpr);
            // Draw selection overlay
            this.renderSelectionOverlay(canvas, dpr);
            // Smart measurements — drawn AFTER the selection overlay so the gap
            // numbers/lines sit above the resize handles instead of under them.
            this.drawMeasurements(canvas, dpr);
            // Draw gradient editing handles (axis + stops on the shape)
            this.drawGradientOverlay(canvas, dpr);
            // Draw mesh-gradient editing overlay (grid + vertices + handles)
            this.drawMeshOverlay(canvas, dpr);
            // Draw direct selection edit handles
            this.drawDirectEditHandles(canvas, dpr);
            // Draw scissors / add-point hover dot
            this.drawScissorsPreview(canvas, dpr);
        }

        this.surface.flush();

        // Keep the ruler strips in step with the current pan/zoom.
        if (!exporting && snapshotPass === null) this.guidesController?.syncRulers();
    }

    /**
     * Allocate an offscreen CPU raster surface whose pixel buffer we own.
     *
     * CanvasKit 0.39.1's `MakeSurface(w, h)` mallocs a pixel buffer that
     * `Surface.delete()` does NOT free — every call leaks the full w*h*4 bytes.
     * Repeated exports (a batch export, or just a long editing session) march
     * the WASM heap to its ceiling and CanvasKit hard-aborts (`Aborted()`),
     * taking the whole app down. Backing the surface with our own `Malloc`
     * buffer lets us `Free` it deterministically, so exporting is leak-free.
     *
     * Returns the surface plus a `release()` that frees BOTH the surface and its
     * buffer; always call it (in a `finally`). Returns null if allocation fails.
     */
    private makeRasterSurface(
        w: number,
        h: number,
    ): { surface: Surface; release: () => void } | null {
        const bytesPerRow = w * 4;
        const buffer = this.ck.Malloc(Uint8Array, h * bytesPerRow);
        const surface = this.ck.MakeRasterDirectSurface(
            {
                width: w,
                height: h,
                colorType: this.ck.ColorType.RGBA_8888,
                alphaType: this.ck.AlphaType.Premul,
                colorSpace: this.ck.ColorSpace.SRGB,
            },
            buffer,
            bytesPerRow,
        );
        if (!surface) {
            this.ck.Free(buffer);
            return null;
        }
        return {
            surface,
            release: () => {
                surface.delete();
                this.ck.Free(buffer);
            },
        };
    }

    /**
     * Measure a text node's laid-out size, using the same paragraph
     * configuration the renderer draws it with.
     *
     * The engine's own text bounds are an approximation — `content.len() *
     * font_size * 0.6` — which is a byte count in Rust, so accented text
     * over-counts, and it ignores the actual glyph advances entirely. That is
     * fine for hit-testing but not for layout: anything positioning text by its
     * reported width (right-aligning, centring, packing columns) lands wrong.
     *
     * Returns null when no font provider exists yet, in which case the caller
     * should keep the engine's estimate rather than invent a number.
     */
    measureText(
        geo: {
            content: string;
            font_size: number;
            font_family?: string;
            line_height?: number;
            font_weight?: number;
            italic?: boolean;
            letter_spacing?: number;
        },
        layoutWidth?: number,
    ): { width: number; height: number; baseline: number } | null {
        const fontProvider = this.getFontProvider();
        if (!fontProvider) return null;
        const { weight, slant } = ckFontStyle(this.ck, geo.font_weight ?? 400, geo.italic ?? false);
        let para: ReturnType<
            ReturnType<CanvasKit['ParagraphBuilder']['MakeFromFontProvider']>['build']
        > | null = null;
        let builder: ReturnType<CanvasKit['ParagraphBuilder']['MakeFromFontProvider']> | null =
            null;
        try {
            const paraStyle = new this.ck.ParagraphStyle({
                textStyle: {
                    color: this.ck.BLACK,
                    fontSize: geo.font_size,
                    fontFamilies: geo.font_family
                        ? [geo.font_family, 'sans-serif']
                        : ['sans-serif'],
                    heightMultiplier: geo.line_height ?? 1.2,
                    fontStyle: { weight, slant },
                    letterSpacing: geo.letter_spacing ?? 0,
                },
            });
            builder = this.ck.ParagraphBuilder.MakeFromFontProvider(paraStyle, fontProvider);
            builder.addText(geo.content);
            para = builder.build();
            // Fixed wrap width ⇒ soft-break; otherwise unconstrained so lines
            // break only where the text says to (getLongestLine = true width).
            const maxW = layoutWidth != null && layoutWidth > 0 ? layoutWidth : 1e5;
            para.layout(maxW);
            const longest = para.getLongestLine();
            return {
                width: layoutWidth != null && layoutWidth > 0 ? layoutWidth : longest,
                height: para.getHeight(),
                baseline: para.getAlphabeticBaseline(),
            };
        } catch {
            return null;
        } finally {
            para?.delete();
            builder?.delete();
        }
    }

    /**
     * Render the whole document to a PNG at `scale`× (1 world unit → `scale`
     * pixels). Renders into an offscreen raster surface with a transparent
     * background and no editor chrome, reusing the normal draw path via the
     * `_exporting` flag. Returns a PNG Blob (or null if the surface can't be
     * created).
     *
     * The content is rendered SUPERSAMPLED with fill anti-aliasing disabled,
     * then downscaled with a high-quality cubic filter (SSAA). This is what a
     * plain 1-sample raster can't do: two shapes sharing a border tile exactly
     * at the supersampled resolution (no per-shape AA coverage deficit), so the
     * downscale produces a clean, fully-opaque edge with no hairline seam —
     * matching what the GPU-anti-aliased on-screen canvas shows.
     */
    exportPNG(
        scale = 2,
        bounds?: { x: number; y: number; w: number; h: number },
        background?: { r: number; g: number; b: number; a: number },
        outSize?: { w: number; h: number },
    ): Blob | null {
        if (!this.scene.engine || !this.surface) return null;
        const b = bounds ?? {
            x: 0,
            y: 0,
            w: this.scene.engine.get_document_width(),
            h: this.scene.engine.get_document_height(),
        };

        const MAX_DIM = 8192;
        const MAX_PIXELS = 40_000_000;

        // Target output pixels. An explicit outSize wins over the scale factor
        // and may carry a different aspect ratio than the source (ratio unlocked).
        const W = Math.max(1, Math.min(MAX_DIM, Math.round(outSize ? outSize.w : b.w * scale)));
        const H = Math.max(1, Math.min(MAX_DIM, Math.round(outSize ? outSize.h : b.h * scale)));

        // Per-axis output scale (px per source unit). Equal on the scale path;
        // may differ for a custom size with the ratio unlocked.
        const sx = W / b.w;
        const sy = H / b.h;
        // Render uniformly at the finer axis so neither is under-sampled, then
        // resample to exactly W×H in one cubic step (stretches when non-uniform).
        const renderScale = Math.max(sx, sy);
        const renderW = Math.max(1, Math.round(b.w * renderScale));
        const renderH = Math.max(1, Math.round(b.h * renderScale));

        // Pick the largest supersample factor that stays within sane surface
        // limits (memory + max dimension). Falls back to 1× (no supersampling,
        // analytic AA) for very large exports. Powers of two only: the
        // downscale below reduces by exact halvings, which is what makes the
        // supersampling actually average (see there).
        let ss = 4;
        while (
            ss > 1 &&
            (renderW * ss > MAX_DIM ||
                renderH * ss > MAX_DIM ||
                renderW * ss * (renderH * ss) > MAX_PIXELS)
        ) {
            ss /= 2;
        }

        const bigW = renderW * ss;
        const bigH = renderH * ss;
        const bigRaster = this.makeRasterSurface(bigW, bigH);
        if (!bigRaster) return null;
        const bigSurface = bigRaster.surface;

        // Swap in export state and reuse render(), then restore. The pan offsets
        // the export origin so an off-origin artboard is cropped correctly.
        const savedSurface = this.surface;
        const savedZoom = this.zoom;
        const savedPan = { x: this.pan.x, y: this.pan.y };
        this.surface = bigSurface;
        this.zoom = renderScale * ss;
        this.pan = { x: -b.x * renderScale * ss, y: -b.y * renderScale * ss };
        this._exporting = true;
        this._exportBounds = b;
        this._exportBackground = background ?? null;
        this._exportNoAA = ss > 1; // AA off only when the downscale will restore it

        let blob: Blob | null = null;
        try {
            this.render();

            // Resample the supersampled render down to the exact target.
            //
            // This must be an AVERAGING filter or the supersampling buys
            // nothing. A single cubic minification does not average: Skia's
            // cubic resampler point-samples through a fixed ~2-source-pixel
            // kernel, so reducing 4× skips most source pixels entirely and the
            // aliased (AA-off) edges survive verbatim — every exported PNG came
            // out hard-edged, and the SVG conformance frames mismatched on
            // essentially every fixture.
            //
            // Halving with a bilinear filter IS an exact box average: each
            // destination sample lands on the corner shared by four source
            // texels, which bilinear weights equally at 0.25. Repeat until the
            // render size is reached (ss is a power of two), then a single
            // cubic step covers a non-uniform custom size, if any.
            const bigImg = bigSurface.makeImageSnapshot();
            let bytes: Uint8Array | null;
            if (bigW !== W || bigH !== H) {
                let curImg = bigImg;
                let curRaster: { surface: Surface; release: () => void } | null = null;
                let curW = bigW;
                let curH = bigH;
                while (curW >= renderW * 2 && curH >= renderH * 2) {
                    const halfW = Math.max(1, Math.round(curW / 2));
                    const halfH = Math.max(1, Math.round(curH / 2));
                    const step = this.makeRasterSurface(halfW, halfH);
                    if (!step) break; // out of memory: fall through with what we have
                    const scanvas = step.surface.getCanvas();
                    scanvas.clear(this.ck.TRANSPARENT);
                    const spaint = new this.ck.Paint();
                    scanvas.drawImageRectOptions(
                        curImg,
                        this.ck.LTRBRect(0, 0, curW, curH),
                        this.ck.LTRBRect(0, 0, halfW, halfH),
                        this.ck.FilterMode.Linear,
                        this.ck.MipmapMode.None,
                        spaint,
                    );
                    spaint.delete();
                    const stepImg = step.surface.makeImageSnapshot();
                    if (curImg !== bigImg) curImg.delete();
                    curRaster?.release();
                    curImg = stepImg;
                    curRaster = step;
                    curW = halfW;
                    curH = halfH;
                }

                if (curW === W && curH === H) {
                    // The halvings landed exactly on the target. Do NOT run a
                    // cubic pass "for good measure": Mitchell is a blurring
                    // kernel, so resampling 1:1 softens every edge it touches.
                    bytes = curImg.encodeToBytes();
                    if (curImg !== bigImg) curImg.delete();
                    curRaster?.release();
                    bigImg.delete();
                    return bytes
                        ? new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
                        : null;
                }

                const dstRaster = this.makeRasterSurface(W, H);
                if (!dstRaster) {
                    if (curImg !== bigImg) curImg.delete();
                    curRaster?.release();
                    bigImg.delete();
                    return null;
                }
                const dstSurface = dstRaster.surface;
                const dcanvas = dstSurface.getCanvas();
                dcanvas.clear(this.ck.TRANSPARENT);
                const dpaint = new this.ck.Paint();
                dcanvas.drawImageRectCubic(
                    curImg,
                    this.ck.LTRBRect(0, 0, curW, curH),
                    this.ck.LTRBRect(0, 0, W, H),
                    1 / 3,
                    1 / 3,
                    dpaint,
                );
                if (curImg !== bigImg) curImg.delete();
                curRaster?.release();
                const outImg = dstSurface.makeImageSnapshot();
                bytes = outImg.encodeToBytes(); // defaults to PNG
                outImg.delete();
                dpaint.delete();
                dstRaster.release();
            } else {
                bytes = bigImg.encodeToBytes();
            }
            bigImg.delete();
            // Cast: CanvasKit's Uint8Array<ArrayBufferLike> isn't inferred as a
            // BlobPart under newer TS libs, but it is a valid one at runtime.
            if (bytes) blob = new Blob([bytes as unknown as BlobPart], { type: 'image/png' });
        } finally {
            this._exporting = false;
            this._exportBounds = null;
            this._exportBackground = null;
            this._exportNoAA = false;
            this.surface = savedSurface;
            this.zoom = savedZoom;
            this.pan = savedPan;
            bigRaster.release();
            this.requestRender(); // repaint the on-screen surface
        }
        return blob;
    }

    /** Build a cache key for a gradient and return a cached or newly created shader. */
    /**
     * Read one paint block — the encoding shared by node fills, node strokes,
     * and (since protocol v13) Live Paint faces.
     *
     * Extracted so the face reader cannot drift from the node reader: this must
     * consume EXACTLY what the engine's `write_paint` wrote for every type, and
     * a reader that handles only the types it cares about desyncs the rest of
     * the frame rather than just missing a colour.
     */
    private readPaint(reader: BinaryReader): any {
        const type = reader.u32();
        if (type === 1) {
            return { type: 1, r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32() };
        }
        if (type === 2 || type === 3) {
            const stopCount = reader.u32();
            const stops = [];
            for (let s = 0; s < stopCount; s++) {
                stops.push({
                    offset: reader.f32(),
                    r: reader.f32(),
                    g: reader.f32(),
                    b: reader.f32(),
                    a: reader.f32(),
                });
            }
            return {
                type,
                stops,
                start: [reader.f32(), reader.f32()],
                end: [reader.f32(), reader.f32()],
                spread: reader.u32(),
                focal: [reader.f32(), reader.f32(), reader.f32()], // fx, fy, fr
                // v11: optional gradient→local affine (elliptical radial).
                transform: reader.u32()
                    ? [
                          reader.f32(),
                          reader.f32(),
                          reader.f32(),
                          reader.f32(),
                          reader.f32(),
                          reader.f32(),
                      ]
                    : null,
            };
        }
        if (type === 4) {
            return {
                type: 4,
                imageId: reader.u32(),
                width: reader.f32(),
                height: reader.f32(),
                transform: [
                    reader.f32(),
                    reader.f32(),
                    reader.f32(),
                    reader.f32(),
                    reader.f32(),
                    reader.f32(),
                ],
            };
        }
        if (type === 5) return { type: 5, mesh: this.readMeshPaint(reader) }; // v12
        return { type: 0 };
    }

    private getOrCreateGradientShader(
        gradType: number,
        stops: { offset: number; r: number; g: number; b: number; a: number }[],
        start: [number, number],
        end: [number, number],
        nodeAlpha: number = 1.0,
        /** spreadMethod: 0 = pad, 1 = repeat, 2 = reflect. */
        spread: number = 0,
        /** Radial focal point [fx, fy, fr]; defaults to the center circle. */
        focal: [number, number, number] = [start[0], start[1], 0],
        /** Gradient→local affine [a,b,c,d,e,f] for rotated/elliptical radials;
         *  null = none (start/end/focal are already in node-local space). */
        transform: number[] | null = null,
    ): ReturnType<CanvasKit['Shader']['MakeLinearGradient']> {
        // Stops are stored in insertion order (the editor appends new stops and
        // mutates offsets in place without re-sorting). Skia's gradient builders
        // require monotonically non-decreasing offsets, so sort a copy here —
        // matching the sorted preview in the fill panel.
        stops = [...stops].sort((a, b) => a.offset - b.offset);

        // Build a compact cache key from gradient parameters
        let key = `${gradType}|${start[0]},${start[1]}|${end[0]},${end[1]}|${nodeAlpha}|${spread}|${focal.join(',')}|${transform?.join(',') ?? ''}`;
        for (const s of stops) {
            key += `|${s.offset},${s.r},${s.g},${s.b},${s.a}`;
        }
        const cached = this._gradientCache.get(key);
        if (cached) return cached;

        // spreadMethod → Skia TileMode: pad→Clamp, repeat→Repeat, reflect→Mirror.
        const tileMode =
            spread === 1
                ? this.ck.TileMode.Repeat
                : spread === 2
                  ? this.ck.TileMode.Mirror
                  : this.ck.TileMode.Clamp;
        const colors = stops.map((s) => this.ck.Color4f(s.r, s.g, s.b, s.a * nodeAlpha));
        const offsets = stops.map((s) => s.offset);
        // For a rotated / non-uniform (elliptical) radial, the gradient is
        // defined in raw gradient space and mapped to node-local space by this
        // affine, passed as Skia's local matrix (row-major 3×3). The SVG affine
        // [a,b,c,d,e,f] (x'=a·x+c·y+e) becomes [a,c,e, b,d,f, 0,0,1].
        const localMatrix = transform
            ? [
                  transform[0],
                  transform[2],
                  transform[4],
                  transform[1],
                  transform[3],
                  transform[5],
                  0,
                  0,
                  1,
              ]
            : null;
        let shader: ReturnType<CanvasKit['Shader']['MakeLinearGradient']>;
        if (gradType === 2) {
            // Linear
            shader = this.ck.Shader.MakeLinearGradient(
                start,
                end,
                colors,
                offsets,
                tileMode,
                localMatrix ?? undefined,
            );
        } else {
            // Radial — focal point is the start circle (fx, fy, fr), the
            // center circle is (start, radius). Concentric when focal = center.
            const radius = Math.hypot(end[0] - start[0], end[1] - start[1]);
            shader = this.ck.Shader.MakeTwoPointConicalGradient(
                [focal[0], focal[1]],
                focal[2],
                start,
                radius,
                colors,
                offsets,
                tileMode,
                localMatrix ?? undefined,
            );
        }
        this._gradientCache.set(key, shader);
        return shader;
    }

    /** Peek the local-space bounds of the record's geometry without drawing,
     *  leaving the reader where it started. Cached paths answer without any
     *  allocation. Returns [l,t,r,b], or null for unbounded/unknown geometry. */
    private peekGeometryBounds(
        type: number,
        reader: BinaryReader,
        cornerRadius: number,
        nodeId: number,
    ): [number, number, number, number] | null {
        const start = reader.offset;
        try {
            if (type === 1) {
                reader.u32(); // size
                const w = reader.f32();
                const h = reader.f32();
                return [0, 0, w, h];
            }
            if (type === 2) {
                reader.u32(); // size
                const rx = reader.f32();
                const ry = reader.f32();
                return [-rx, -ry, rx, ry];
            }
            if (type === 0) {
                const cached = this._pathCache.get(nodeId);
                if (cached && nodeId > 0) {
                    const b = cached.path.getBounds();
                    return [b[0], b[1], b[2], b[3]];
                }
                const p = this.getBinaryGeometryPath(type, reader, cornerRadius, nodeId);
                if (!p) return null;
                const b = p.getBounds();
                p.delete();
                return [b[0], b[1], b[2], b[3]];
            }
            return null;
        } finally {
            reader.offset = start;
        }
    }

    /** Decode a wire mesh-gradient paint (type tag 5, protocol v12). The
     *  engine materializes all handles, so every vertex arrives with concrete
     *  e/w/s/n control points. */
    private readMeshPaint(reader: BinaryReader): MeshGradient {
        const rows = reader.u32();
        const cols = reader.u32();
        const count = (rows + 1) * (cols + 1);
        const vertices: MeshVertex[] = [];
        for (let i = 0; i < count; i++) {
            const x = reader.f32();
            const y = reader.f32();
            const color = { r: reader.f32(), g: reader.f32(), b: reader.f32(), a: reader.f32() };
            const handles = {
                e: [reader.f32(), reader.f32()] as [number, number],
                w: [reader.f32(), reader.f32()] as [number, number],
                s: [reader.f32(), reader.f32()] as [number, number],
                n: [reader.f32(), reader.f32()] as [number, number],
            };
            vertices.push({ x, y, color, handles });
        }
        return { rows, cols, vertices };
    }

    /** Paint used for drawVertices mesh rasterization: AA off (interior edges
     *  must be watertight; the path clip supplies outline AA), no shader. */
    private _meshPaint: Paint | null = null;

    /** LRU cache of rasterized mesh fills, keyed by mesh content hash +
     *  raster size + alpha. Entries own their ck Image and its shader
     *  (both deleted on evict). */
    private _meshRasterCache = new Map<
        string,
        {
            img: ReturnType<CanvasKit['MakeImage']>;
            shader: Shader | null;
            x: number;
            y: number;
            w: number;
            h: number;
            bytes: number;
        }
    >();

    /**
     * While true, mesh rasters are built at reduced resolution. Set for the
     * duration of a mesh edit gesture (vertex/handle drag): every frame
     * mutates the mesh, so every frame is a cache miss and must re-rasterize
     * on the CPU — the cost is linear in raster pixels, and full resolution
     * costs ~34ms/frame (≈30fps) on a mid-size mesh. Quarter-area drafts run
     * ~4x faster; the drag-end render restores full quality.
     */
    meshDraftMode = false;

    /**
     * Shader that paints a mesh-gradient fill in node-local coordinates —
     * plugged into the ordinary fill pass exactly like pattern shaders.
     *
     * The mesh is tessellated (curvature-adaptive Coons subdivision) and
     * rendered with drawVertices on an offscreen CPU raster at device
     * resolution; the raster becomes a Decal-tiled image shader whose local
     * matrix maps it onto the mesh's node-local bounds. The indirection is
     * deliberate: on the onscreen WebGL surface this CanvasKit build silently
     * discards both drawVertices and image blits issued under a
     * non-rectangular clipPath (verified empirically), so the mesh must reach
     * the screen through drawPath + shader — the one fill path proven to work
     * everywhere. The raster + shader are cached by content, so static frames
     * cost nothing.
     */
    private getMeshFillShader(
        canvas: Canvas,
        mesh: MeshGradient,
        alphaScale: number,
        pathBounds: [number, number, number, number] | null = null,
    ): Shader | null {
        // Device px per node-local unit, from the live canvas matrix (covers
        // zoom, dpr, node transform, and export supersampling in one go).
        const m = canvas.getTotalMatrix();
        let scale = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
        // Quantize to power-of-two buckets: a continuous zoom then KEEPS
        // hitting the same cache entry (the shader rescales it, error ≤ √2×)
        // instead of re-rasterizing megabytes on every frame — which stalled
        // whole frames and starved the rest of the UI during zooms.
        scale = 2 ** Math.round(Math.log2(scale));
        // Mid-gesture: half-scale raster (a quarter of the pixels, ~4x faster
        // to build). Slightly soft while dragging; the drag-end frame rebuilds
        // at full scale.
        if (this.meshDraftMode) scale /= 2;
        const b = meshBounds(mesh);
        if (b.w <= 0 || b.h <= 0) return null;
        // The raster must cover the whole FILL PATH, not just the mesh hull:
        // a shape-fitted boundary can undershoot a many-point outline by
        // whole lobes, and anything past the raster samples Decal-transparent.
        let x0 = b.x;
        let y0 = b.y;
        let x1 = b.x + b.w;
        let y1 = b.y + b.h;
        if (pathBounds) {
            x0 = Math.min(x0, pathBounds[0]);
            y0 = Math.min(y0, pathBounds[1]);
            x1 = Math.max(x1, pathBounds[2]);
            y1 = Math.max(y1, pathBounds[3]);
        }
        // 1 device px so linear sampling never reads the raster edge.
        const pad = 1 / scale;
        const bx = x0 - pad;
        const by = y0 - pad;
        const bw = x1 - x0 + 2 * pad;
        const bh = y1 - y0 + 2 * pad;
        // Cap the raster to a sane device budget; beyond it the mesh renders
        // slightly soft (upscaled), which at 2048px is imperceptible.
        const maxDim = Math.max(bw, bh) * scale;
        if (maxDim > 2048) scale *= 2048 / maxDim;
        const pw = Math.max(1, Math.ceil(bw * scale));
        const ph = Math.max(1, Math.ceil(bh * scale));
        const key = `${meshContentHash(mesh)}:${pw}x${ph}:${bx.toFixed(1)},${by.toFixed(1)}:${alphaScale.toFixed(3)}`;

        let entry = this._meshRasterCache.get(key);
        if (entry) {
            // Refresh LRU recency.
            this._meshRasterCache.delete(key);
            this._meshRasterCache.set(key, entry);
        } else {
            const rs = this.makeRasterSurface(pw, ph);
            if (!rs) return null;
            let img: ReturnType<CanvasKit['MakeImage']> = null;
            try {
                const oc = rs.surface.getCanvas();
                oc.clear(this.ck.TRANSPARENT);
                oc.scale(pw / bw, ph / bh);
                oc.translate(-bx, -by);
                const { u, v } = subdivisionCounts(mesh, scale);
                // Flood the boundary colors across the whole raster (strip is
                // drawn UNDER the patches): wherever the fitted boundary
                // undershoots the path, the fill shows the nearest boundary
                // color instead of a transparent hole. The path clip caps it.
                const tess = tessellate(mesh, u, v, alphaScale, Math.hypot(bw, bh));
                const verts = this.ck.MakeVertices(
                    this.ck.VertexMode.Triangles,
                    tess.positions,
                    null,
                    tess.colors,
                    Array.from(tess.indices),
                    false,
                );
                if (!this._meshPaint) {
                    this._meshPaint = new this.ck.Paint();
                    // Opaque white + Modulate ≡ "use the vertex colors
                    // verbatim" on every backend (kDst is GPU-discarded).
                    this._meshPaint.setColor(this.ck.Color4f(1, 1, 1, 1));
                }
                oc.drawVertices(verts, this.ck.BlendMode.Modulate, this._meshPaint);
                verts.delete();
                rs.surface.flush();
                // Deep-copy the pixels into a self-owned image: the snapshot
                // of a raster-direct surface references the surface's buffer,
                // which release() frees — the cached image must outlive it.
                const snap = rs.surface.makeImageSnapshot();
                if (snap) {
                    const px = snap.readPixels(0, 0, {
                        width: pw,
                        height: ph,
                        colorType: this.ck.ColorType.RGBA_8888,
                        alphaType: this.ck.AlphaType.Premul,
                        colorSpace: this.ck.ColorSpace.SRGB,
                    }) as Uint8Array | null;
                    snap.delete();
                    if (px) {
                        img = this.ck.MakeImage(
                            {
                                width: pw,
                                height: ph,
                                colorType: this.ck.ColorType.RGBA_8888,
                                alphaType: this.ck.AlphaType.Premul,
                                colorSpace: this.ck.ColorSpace.SRGB,
                            },
                            px,
                            pw * 4,
                        );
                    }
                }
            } finally {
                rs.release();
            }
            if (!img) return null;
            // Image px (0..pw, 0..ph) → node-local (bx..bx+bw, by..by+bh).
            const shader = img.makeShaderOptions(
                this.ck.TileMode.Decal,
                this.ck.TileMode.Decal,
                this.ck.FilterMode.Linear,
                this.ck.MipmapMode.None,
                [bw / pw, 0, bx, 0, bh / ph, by, 0, 0, 1],
            );
            entry = { img, shader, x: bx, y: by, w: bw, h: bh, bytes: pw * ph * 4 };
            this._meshRasterCache.set(key, entry);
            // Evict by total bytes (the WASM heap pays for every cached
            // raster — unbounded growth ends in a CanvasKit Aborted()) and
            // keep a generous entry cap as a backstop.
            let total = 0;
            for (const e of this._meshRasterCache.values()) total += e.bytes;
            while (
                this._meshRasterCache.size > 1 &&
                (total > 48 * 1024 * 1024 || this._meshRasterCache.size > 12)
            ) {
                const oldest = this._meshRasterCache.keys().next().value as string;
                const evicted = this._meshRasterCache.get(oldest);
                if (!evicted) break;
                total -= evicted.bytes;
                evicted.shader?.delete();
                evicted.img?.delete();
                this._meshRasterCache.delete(oldest);
            }
        }
        return entry.shader;
    }

    /**
     * Rasterize a mesh fill for SVG export: PNG data URI + its node-local
     * placement. SVG 1.1 has no mesh gradients, so the exporter embeds this
     * as a non-repeating <pattern> the shape's own outline clips.
     */
    rasterizeMeshForExport(
        mesh: MeshGradient,
        pxPerUnit = 2,
        pathBounds: { x: number; y: number; w: number; h: number } | null = null,
    ): { href: string; x: number; y: number; w: number; h: number } | null {
        const b = meshBounds(mesh);
        if (b.w <= 0 || b.h <= 0) return null;
        // Cover the whole fill path, not just the mesh hull (see
        // getMeshFillShader) — the flood below fills the difference.
        let x0 = b.x;
        let y0 = b.y;
        let x1 = b.x + b.w;
        let y1 = b.y + b.h;
        if (pathBounds) {
            x0 = Math.min(x0, pathBounds.x);
            y0 = Math.min(y0, pathBounds.y);
            x1 = Math.max(x1, pathBounds.x + pathBounds.w);
            y1 = Math.max(y1, pathBounds.y + pathBounds.h);
        }
        const pad = 1 / pxPerUnit;
        const bx = x0 - pad;
        const by = y0 - pad;
        const bw = x1 - x0 + 2 * pad;
        const bh = y1 - y0 + 2 * pad;
        let scale = pxPerUnit;
        const maxDim = Math.max(bw, bh) * scale;
        if (maxDim > 4096) scale *= 4096 / maxDim;
        const pw = Math.max(1, Math.ceil(bw * scale));
        const ph = Math.max(1, Math.ceil(bh * scale));
        const rs = this.makeRasterSurface(pw, ph);
        if (!rs) return null;
        try {
            const oc = rs.surface.getCanvas();
            oc.clear(this.ck.TRANSPARENT);
            oc.scale(pw / bw, ph / bh);
            oc.translate(-bx, -by);
            const { u, v } = subdivisionCounts(mesh, scale);
            const tess = tessellate(mesh, u, v, 1, Math.hypot(bw, bh));
            const verts = this.ck.MakeVertices(
                this.ck.VertexMode.Triangles,
                tess.positions,
                null,
                tess.colors,
                Array.from(tess.indices),
                false,
            );
            const p = new this.ck.Paint();
            p.setColor(this.ck.Color4f(1, 1, 1, 1));
            oc.drawVertices(verts, this.ck.BlendMode.Modulate, p);
            verts.delete();
            p.delete();
            rs.surface.flush();
            const snap = rs.surface.makeImageSnapshot();
            if (!snap) return null;
            const bytes = snap.encodeToBytes();
            snap.delete();
            if (!bytes) return null;
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return { href: `data:image/png;base64,${btoa(bin)}`, x: bx, y: by, w: bw, h: bh };
        } finally {
            rs.release();
        }
    }

    private getBinaryGeometryPath(
        type: number,
        reader: BinaryReader,
        cornerRadius: number = 0,
        nodeId: number = 0,
    ) {
        const path = new this.ck.Path();
        reader.u32(); // skip size

        if (type === 1) {
            // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                const r = Math.min(cornerRadius, w / 2, h / 2);
                path.addRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r));
            } else {
                path.addRect(this.ck.LTRBRect(0, 0, w, h));
            }
        } else if (type === 2) {
            // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            path.addOval(this.ck.LTRBRect(-rx, -ry, rx, ry));
        } else if (type === 0) {
            // Path
            const numSubpaths = reader.u32();

            // Check cache
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4;
                }
                path.delete();
                return cached.path.copy();
            }

            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0,
                    firstY = 0,
                    firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32();
                    const y = reader.f32();
                    const cp1x = reader.f32();
                    const cp1y = reader.f32();
                    const cp2x = reader.f32();
                    const cp2y = reader.f32();

                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x;
                        firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
        } else if (type === 4) {
            // Text
            reader.f32(); // fontSize
            reader.u32(); // textAlign
            reader.f32(); // lineHeight
            reader.u32(); // fontWeight
            reader.u32(); // italic
            reader.f32(); // letterSpacing
            reader.string(); // fontFamily
            reader.string(); // content
            path.delete();
            return null;
        }
        return path;
    }

    private drawBinaryGeometry(
        canvas: Canvas,
        type: number,
        reader: BinaryReader,
        paint: Paint,
        cornerRadius: number = 0,
        fillRule: number = 0,
        nodeId: number = 0,
    ) {
        reader.u32(); // skip size

        if (type === 1) {
            // Rect
            const w = reader.f32();
            const h = reader.f32();
            if (cornerRadius > 0) {
                // Clamp the radius so opposite corners never overlap
                const r = Math.min(cornerRadius, w / 2, h / 2);
                canvas.drawRRect(this.ck.RRectXY(this.ck.LTRBRect(0, 0, w, h), r, r), paint);
            } else {
                canvas.drawRect(this.ck.LTRBRect(0, 0, w, h), paint);
            }
        } else if (type === 2) {
            // Ellipse
            const rx = reader.f32();
            const ry = reader.f32();
            canvas.drawOval(this.ck.LTRBRect(-rx, -ry, rx, ry), paint);
        } else if (type === 0) {
            // Path
            const numSubpaths = reader.u32();

            // Check path cache first
            const cached = this._pathCache.get(nodeId);
            if (cached && nodeId > 0) {
                // Skip past the binary path data (we already have the cached CK path)
                for (let s = 0; s < numSubpaths; s++) {
                    reader.u32(); // closed
                    const numPoints = reader.u32();
                    reader.offset += numPoints * 6 * 4; // 6 floats per point × 4 bytes
                }
                // Apply fill rule if it changed
                if (fillRule !== cached.fillRule) {
                    cached.path.setFillType(
                        fillRule === 1 ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding,
                    );
                    cached.fillRule = fillRule;
                }
                canvas.drawPath(cached.path, paint);
                return;
            }

            const path = new this.ck.Path();
            for (let s = 0; s < numSubpaths; s++) {
                const closed = reader.u32() === 1;
                const numPoints = reader.u32();
                let prevCP2: [number, number] | null = null;
                let firstX = 0,
                    firstY = 0,
                    firstCP1: [number, number] = [0, 0];

                for (let p = 0; p < numPoints; p++) {
                    const x = reader.f32();
                    const y = reader.f32();
                    const cp1x = reader.f32();
                    const cp1y = reader.f32();
                    const cp2x = reader.f32();
                    const cp2y = reader.f32();

                    if (p === 0) {
                        path.moveTo(x, y);
                        firstX = x;
                        firstY = y;
                        firstCP1 = [cp1x, cp1y];
                    } else if (prevCP2) {
                        path.cubicTo(prevCP2[0], prevCP2[1], cp1x, cp1y, x, y);
                    }
                    prevCP2 = [cp2x, cp2y];
                }
                if (closed && numPoints >= 2 && prevCP2) {
                    path.cubicTo(prevCP2[0], prevCP2[1], firstCP1[0], firstCP1[1], firstX, firstY);
                    path.close();
                } else if (closed) {
                    path.close();
                }
            }
            // Apply fill rule (EvenOdd vs NonZero/Winding)
            if (fillRule === 1) {
                path.setFillType(this.ck.FillType.EvenOdd);
            }
            canvas.drawPath(path, paint);

            // Cache the path for future frames (copy so it survives reuse)
            if (nodeId > 0) {
                this._pathCache.set(nodeId, { path: path.copy(), fillRule });
            }
            path.delete();
        } else if (type === 4) {
            // Text
            const fontSize = reader.f32();
            const textAlign = reader.u32(); // 0=Left, 1=Center, 2=Right
            const lineHeight = reader.f32(); // multiplier
            const fontWeight = reader.u32(); // 100–900
            const italic = reader.u32() !== 0;
            const letterSpacing = reader.f32();
            const fontFamily = reader.string();
            const content = reader.string();

            // While a text node is being edited inline, the HTML overlay stands
            // in for it — skip drawing the underlying node so it isn't doubled.
            if (this._editingTextId === nodeId) return;

            // Text on a path: flow the glyphs along the linked path (the text
            // node's transform is identity, so we draw in world space directly).
            const onPathId = this.scene.getTextPath(nodeId);
            if (onPathId != null && this.scene.getNode(onPathId)) {
                this.drawTextOnPath(canvas, nodeId, content, fontSize, fontFamily, onPathId, paint);
                return;
            }

            // Map text_align to CanvasKit TextAlign enum
            const ckTextAlign =
                textAlign === 1
                    ? this.ck.TextAlign.Center
                    : textAlign === 2
                      ? this.ck.TextAlign.Right
                      : this.ck.TextAlign.Left;

            // Map font weight/style to CanvasKit enums (falls back gracefully
            // when the loaded font lacks the requested variant).
            const { weight: ckWeight, slant: ckSlant } = ckFontStyle(this.ck, fontWeight, italic);

            // Extract current fill color from paint for the paragraph text style
            const paintColor = paint.getColor();

            // Try Paragraph API for rich text rendering
            const fontProvider = this.getFontProvider();
            const fontFamilies = fontFamily ? [fontFamily, 'sans-serif'] : ['sans-serif'];

            try {
                const paraStyle = new this.ck.ParagraphStyle({
                    textStyle: {
                        color: this.ck.Color4f(
                            paintColor[0],
                            paintColor[1],
                            paintColor[2],
                            paintColor[3],
                        ),
                        fontSize: fontSize,
                        fontFamilies: fontFamilies,
                        heightMultiplier: lineHeight,
                        fontStyle: { weight: ckWeight, slant: ckSlant },
                        letterSpacing: letterSpacing,
                    },
                    textAlign: ckTextAlign,
                });

                if (!fontProvider) {
                    // No fonts are loaded, and CanvasKit 0.39 exposes no default
                    // FontMgr, so the Paragraph API can't be used here. Defer to
                    // the TextBlob fallback below.
                    throw new Error('no font provider available');
                }
                // The paraStyle already lists a 'sans-serif' fallback, so the
                // provider handles missing/empty font families gracefully.
                const builder = this.ck.ParagraphBuilder.MakeFromFontProvider(
                    paraStyle,
                    fontProvider,
                );

                builder.addText(content);
                const para = builder.build();
                // Wrap-mode nodes layout at their fixed box width; auto-width
                // uses a generous max so soft wraps never fire (hard `\n` only).
                const fixedW = this.getTextLayoutWidth(nodeId);
                const layoutWidth =
                    fixedW != null && fixedW > 0
                        ? fixedW
                        : content.includes('\n')
                          ? content.length * fontSize * 0.6
                          : 1e5;
                para.layout(layoutWidth);

                // A text node's origin IS its baseline (SVG `y`, and what the
                // engine's hit-test assumes: local y spans -font_size…0).
                // drawParagraph positions the paragraph's TOP, and the first
                // line's baseline sits `getAlphabeticBaseline()` below that —
                // which is the font's ascent (plus half-leading), NOT the font
                // size. Offsetting by -fontSize therefore floated every string
                // off its baseline by (ascent - size); on Noto Sans at 64px
                // that was 4 units, and it put the rendered glyphs out of step
                // with both the hit-test box and the inline edit overlay.
                canvas.drawParagraph(para, 0, -para.getAlphabeticBaseline());

                para.delete();
                builder.delete();
            } catch {
                // Fallback: use simple TextBlob if Paragraph API fails
                const font = new this.ck.Font(null, fontSize);
                const blob = this.ck.TextBlob.MakeFromText(content, font);
                if (blob) {
                    canvas.drawTextBlob(blob, 0, 0, paint);
                    blob.delete();
                }
                font.delete();
            }

            // Trigger lazy font loading if font isn't cached yet
            if (fontFamily && !isFontLoaded(fontFamily)) {
                loadGoogleFontData(fontFamily); // fire-and-forget; repaint via callback
            }
            // fontProvider is the shared cached instance — do NOT delete it here.
        }
    }

    /** Light outline around the node under the cursor (Figma-style hover). */
    private drawHoverOutline(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im || im.isMouseDown || im.hoverNodeId === null) return;
        const id = im.hoverNodeId;
        // Skip if already selected — the selection overlay covers it
        if (this.scene.getSelection().includes(id)) return;

        // Measured: hovering a text node must outline the glyphs, not the
        // engine's per-character estimate of them.
        const b = this.scene.getMeasuredNodeBounds(id);
        if (b[2] <= b[0] || b[3] <= b[1]) return;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.hoverOutline.setStrokeWidth(1.5 / this.zoom);
        canvas.drawRect(this.ck.LTRBRect(b[0], b[1], b[2], b[3]), op.hoverOutline);
        canvas.restore();
    }

    private renderSelectionOverlay(canvas: Canvas, dpr: number) {
        // Selection chrome (silhouette + handles). Hide only while mid-create /
        // path-edit / move — not merely because a create tool is still active.
        // Gating on tool==='selection' hid ellipse ovals after draw when the
        // product toolbar lagged one-shot revert (or when the tool stayed locked).
        const imGate = this.inputManager;
        if (imGate) {
            if (imGate.editingNodeId != null) return;
            if (imGate.previewRect || imGate.previewLine || imGate.pencilPoints) return;
            // Locked pen/pencil session: strokes stay unselected, but also hide
            // any leftover selection chrome until the user exits draw mode.
            if (
                imGate.ui?.toolLocked &&
                (imGate.ui.activeTool === 'pencil' || imGate.ui.activeTool === 'pen')
            ) {
                return;
            }
        }
        const selection = this.scene.getSelection();
        if (selection.length === 0) return;

        // Hide transform box + handles while moving (Kit/Figma): guides stay,
        // chrome would only clutter the drag. Resize/rotate keep the live frame.
        const im = this.inputManager;
        if (im && im.dragMode === 'move' && im.didMove) return;

        const live = this.inputManager?.liveResizeBounds ?? this.inputManager?.liveFrame;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        op.selOutline.setStrokeWidth(1.0 / this.zoom);
        // Keep analytic AA — same as node content strokes. AA-off strokeRect
        // (used briefly for artboard chrome) drops top/left after zoom.
        op.selOutline.setAntiAlias(true);

        let totalMinX = Infinity,
            totalMinY = Infinity,
            totalMaxX = -Infinity,
            totalMaxY = -Infinity;

        // Draw individual outlines. During live resize/rotate the live frame
        // below is the single source of truth — stacking a per-node silhouette
        // on top of it (nearly-identical hairlines, no AA) drops L/R edges.
        for (const id of selection) {
            const nodeTypeNum = this.scene.getNodeType(id);
            if (nodeTypeNum === undefined) continue;

            // Measured, so the frame drawn round a multi-selection ends where
            // the glyphs do. The per-node text outline below has always used
            // the measured box; this union used the engine's 0.6em estimate,
            // which is how a perfectly centred wordmark still got a frame
            // hanging off its right-hand side.
            const bounds = this.scene.getMeasuredNodeBounds(id);
            totalMinX = Math.min(totalMinX, bounds[0]);
            totalMinY = Math.min(totalMinY, bounds[1]);
            totalMaxX = Math.max(totalMaxX, bounds[2]);
            totalMaxY = Math.max(totalMaxY, bounds[3]);

            if (live) continue;

            // Skip individual outlines for multi-selection to avoid clutter/lag
            if (selection.length > 5) continue;

            if (nodeTypeNum === 3) {
                // Group: draw the outline oriented under the group's own
                // transform (its local-bounds rect), so it rotates/skews with
                // the group like every other node type — matching the handles,
                // which come from the oriented selection frame. Falling back to
                // the axis-aligned world bounds would make the box "adapt"
                // instead of rotate.
                const lb = this.inputManager?.getNodeLocalBounds(id);
                if (lb) {
                    const transform = this.scene.getTransform(id);
                    canvas.save();
                    canvas.concat(transform);
                    canvas.drawRect(
                        this.ck.LTRBRect(lb.x, lb.y, lb.x + lb.w, lb.y + lb.h),
                        op.selOutline,
                    );
                    canvas.restore();
                } else {
                    const [gMinX, gMinY, gMaxX, gMaxY] = bounds;
                    canvas.drawRect(this.ck.LTRBRect(gMinX, gMinY, gMaxX, gMaxY), op.selOutline);
                }
            } else {
                const transform = this.scene.getTransform(id);
                canvas.save();
                canvas.concat(transform);

                const geo = this.scene.getNodeGeometry(id);
                if (!geo) {
                    canvas.restore();
                    continue; // node went away between selection and paint
                }
                if (geo.Rect) {
                    canvas.drawRect(
                        this.ck.LTRBRect(0, 0, geo.Rect.width, geo.Rect.height),
                        op.selOutline,
                    );
                } else if (geo.Ellipse) {
                    canvas.drawOval(
                        this.ck.LTRBRect(
                            -geo.Ellipse.radius_x,
                            -geo.Ellipse.radius_y,
                            geo.Ellipse.radius_x,
                            geo.Ellipse.radius_y,
                        ),
                        op.selOutline,
                    );
                } else if (geo.Path) {
                    // Silhouette outline (not AABB) so circles-as-path, stars,
                    // polygons match ink — same #00A2FF hairline as Ellipse ovals.
                    const resolved = this.scene.getResolvedSubpaths(id);
                    if (resolved.length) {
                        const outline = new this.ck.Path();
                        appendSubpathsToPath(outline, resolved);
                        canvas.drawPath(outline, op.selOutline);
                        outline.delete();
                    } else {
                        const pathBounds = this.calculatePathBounds({
                            subpaths: geo.Path.subpaths || [],
                        });
                        canvas.drawRect(
                            this.ck.LTRBRect(
                                pathBounds.minX,
                                pathBounds.minY,
                                pathBounds.maxX,
                                pathBounds.maxY,
                            ),
                            op.selOutline,
                        );
                    }
                } else if (geo.Text) {
                    // Measured the same way the resize handles are, so the
                    // outline sits on the glyphs. A character count times 0.6em
                    // — which is what this drew — is neither the text nor the
                    // handles, so a display face or any letter spacing left the
                    // box and its own handles in two different places.
                    const tb = this.getTextLocalBounds(id);
                    if (tb) {
                        canvas.drawRect(
                            this.ck.LTRBRect(tb.x, tb.y, tb.x + tb.w, tb.y + tb.h),
                            op.selOutline,
                        );
                    }
                }
                canvas.restore();
            }
        }

        // Selection frame: oriented box for a single node (rotates/skews with
        // the shape), axis-aligned union for multi-selection. During drags the
        // input manager returns the live frame for zero-lag feedback.
        let frame = this.inputManager?.getSelectionFrame() ?? null;
        if (!frame && totalMaxX > totalMinX && totalMaxY > totalMinY) {
            frame = {
                w: totalMaxX - totalMinX,
                h: totalMaxY - totalMinY,
                m: { a: 1, b: 0, c: 0, d: 1, e: totalMinX, f: totalMinY },
            };
        }

        // Draw frame box and handles (skip in node-editing mode — anchors replace resize handles)
        const isNodeEditing = this.inputManager?.editingNodeId != null;
        if (frame && frame.w > 0 && frame.h > 0 && !isNodeEditing) {
            const m = frame.m;
            const pt = (fx: number, fy: number) => ({
                x: m.a * fx + m.c * fy + m.e,
                y: m.b * fx + m.d * fy + m.f,
            });
            const corners = [pt(0, 0), pt(frame.w, 0), pt(frame.w, frame.h), pt(0, frame.h)];

            // Idle single Rect/Text/Group already paint an AABB silhouette above;
            // stacking this frame on top drops L/R hairlines (CanvasKit AA).
            // Ellipse / Path (polygon, star, …) / Image only get a shape
            // silhouette — they still need this oriented control box so vertical
            // edges stay visible between the handles.
            let drawFrameBox = selection.length > 1 || Boolean(live);
            if (!drawFrameBox && selection.length === 1) {
                const sid = selection[0];
                const nt = this.scene.getNodeType(sid);
                const geo = this.scene.getNodeGeometry(sid);
                const aabbSilhouette =
                    nt === 3 || Boolean(geo?.Rect) || Boolean(geo?.Text);
                drawFrameBox = !aabbSilhouette;
            }
            if (drawFrameBox) {
                const box = new this.ck.Path();
                box.moveTo(corners[0].x, corners[0].y);
                for (let i = 1; i < 4; i++) box.lineTo(corners[i].x, corners[i].y);
                box.close();
                canvas.drawPath(box, op.selOutline);
                box.delete();
            }

            const outlineOnly = Boolean(this.selectionOutlineOnly?.());
            if (!outlineOnly) {
                // Always 8 handles (4 corners + N/E/S/W). Screen-constant size,
                // no AA — mid-edge dots must stay as visible as corners.
                const hSize = Math.max(1 / this.zoom, 4 / this.zoom);
                const midW = frame.w / 2,
                    midH = frame.h / 2;
                const handlePositions = [
                    pt(0, 0),
                    pt(midW, 0),
                    pt(frame.w, 0),
                    pt(0, midH),
                    pt(frame.w, midH),
                    pt(0, frame.h),
                    pt(midW, frame.h),
                    pt(frame.w, frame.h),
                ];
                // Handle squares tilt with the frame
                const angleDeg = Math.atan2(m.b, m.a) * (180 / Math.PI);

                op.selHandleStroke.setStrokeWidth(1.0 / this.zoom);
                op.selHandleStroke.setAntiAlias(false);
                op.selHandleFill.setAntiAlias(false);
                op.selOutline.setAntiAlias(false);

                const z = Math.max(0.05, this.zoom);
                const snapX = (v: number) => (Math.round(v * z + this.pan.x) - this.pan.x) / z;
                const snapY = (v: number) => (Math.round(v * z + this.pan.y) - this.pan.y) / z;

                for (const { x: hx0, y: hy0 } of handlePositions) {
                    const hx = snapX(hx0);
                    const hy = snapY(hy0);
                    canvas.save();
                    canvas.rotate(angleDeg, hx, hy);
                    canvas.drawRect(
                        this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                        op.selHandleFill,
                    );
                    canvas.drawRect(
                        this.ck.LTRBRect(hx - hSize, hy - hSize, hx + hSize, hy + hSize),
                        op.selHandleStroke,
                    );
                    canvas.restore();
                }
                // Restore shared overlay paint defaults for later chrome.
                op.selHandleStroke.setAntiAlias(true);
                op.selHandleFill.setAntiAlias(true);
                op.selOutline.setAntiAlias(true);
            }
        }

        // Draw corner radius handles for single selection (Rect only — skip in node-editing mode)
        if (
            selection.length === 1 &&
            !live &&
            !isNodeEditing &&
            !this.selectionOutlineOnly?.()
        ) {
            const id = selection[0];
            const node = this.scene.getNode(id);
            // Only real rectangles get corner-radius handles. Groups (and other
            // container nodes) report a placeholder Rect{0,0}; guarding on
            // positive dimensions stops that empty rect from drawing a phantom
            // handle stack at the frame's top-left corner.
            if (
                node?.geometry.Rect &&
                node.geometry.Rect.width > 0 &&
                node.geometry.Rect.height > 0
            ) {
                const rect = node.geometry.Rect;
                // Same rule the press uses, so a dot is drawn exactly where one
                // can be grabbed — and a shape too small for the control shows
                // none rather than four dots that fight its drag.
                const handles = cornerRadiusHandles(
                    rect.width,
                    rect.height,
                    node.style.corner_radius || 0,
                    this.zoom,
                );
                if (handles) {
                    canvas.save();
                    canvas.concat(this.scene.getTransform(id));
                    const hSize = 3.5 / this.zoom;
                    const drag = this.inputManager?.cornerRadiusDragging;
                    let activeIdx = -1;
                    if (drag && drag.nodeId === id) {
                        // Same corner pick as the drag maths: nearest to press.
                        const t = this.scene.getTransform(id);
                        const a = t[0],
                            b = t[1],
                            tx = t[2],
                            c = t[3],
                            d = t[4],
                            ty = t[5];
                        const det = a * d - b * c;
                        if (Math.abs(det) > 1e-6) {
                            const invDet = 1 / det;
                            const ia = d * invDet,
                                ib = -b * invDet,
                                ic = -c * invDet,
                                id_ = a * invDet;
                            const itx = (b * ty - d * tx) * invDet,
                                ity = (c * tx - a * ty) * invDet;
                            const slx = ia * drag.startPos.x + ib * drag.startPos.y + itx;
                            const sly = ic * drag.startPos.x + id_ * drag.startPos.y + ity;
                            let best = Infinity;
                            handles.positions.forEach(([hx, hy], i) => {
                                const dd = Math.hypot(slx - hx, sly - hy);
                                if (dd < best) {
                                    best = dd;
                                    activeIdx = i;
                                }
                            });
                        }
                    }
                    handles.positions.forEach(([hx, hy], i) => {
                        if (i === activeIdx) {
                            // Soft halo while dragging (reference: concentric ring).
                            const halo = new this.ck.Paint();
                            halo.setColor(this.ck.Color(0, 162, 255, 0.35));
                            halo.setStyle(this.ck.PaintStyle.Stroke);
                            halo.setStrokeWidth(2 / this.zoom);
                            halo.setAntiAlias(true);
                            canvas.drawCircle(hx, hy, hSize + 2 / this.zoom, halo);
                            halo.delete();
                        }
                        canvas.drawCircle(hx, hy, hSize, op.selHandleFill);
                        canvas.drawCircle(hx, hy, hSize, op.selHandleStroke);
                    });
                    canvas.restore();
                }
            }
        }

        canvas.restore();
    }

    /**
     * On-canvas gradient editing overlay (Figma-style): the gradient axis with
     * a start ring, an end square, and color-filled stop dots along the line.
     * Radial gradients additionally show the radius circle in node space.
     * State lives in ui.gradientEdit; only drawn for the selection tool.
     */
    private drawGradientOverlay(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        const ge = im?.ui.gradientEdit;
        if (!ge?.isActive() || im?.editingNodeId !== null) return;
        if (ge.faceId !== null) {
            // A Live Paint region's handles belong to the bucket, and a face is
            // not selectable, so the selection check below cannot apply.
            if (im.ui.activeTool !== 'paint-bucket') return;
        } else {
            if (im.ui.activeTool !== 'selection') return;
            const selection = this.scene.getSelection();
            if (selection.length !== 1 || selection[0] !== ge.nodeId) return;
        }
        const grad = ge.gradient();
        if (!grad) return;

        const { p0, p1 } = ge.endpoints(grad);
        const z = this.zoom;
        const ck = this.ck;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(z, z);

        const halo = new ck.Paint();
        halo.setColor(ck.Color(0, 0, 0, 0.35));
        halo.setStyle(ck.PaintStyle.Stroke);
        halo.setAntiAlias(true);

        const white = new ck.Paint();
        white.setColor(ck.Color(255, 255, 255, 1));
        white.setStyle(ck.PaintStyle.Stroke);
        white.setAntiAlias(true);

        const fill = new ck.Paint();
        fill.setStyle(ck.PaintStyle.Fill);
        fill.setAntiAlias(true);

        const accent = new ck.Paint();
        accent.setColor(ck.Color(0, 162, 255, 1));
        accent.setStyle(ck.PaintStyle.Stroke);
        accent.setAntiAlias(true);

        // Radius circle for radial gradients — drawn in GRADIENT space, under
        // the same matrix that maps the gradient into the world. That makes it
        // follow the node's rotation/scale, land on the handles for a gradient
        // carrying its own transform, and come out as the ellipse an elliptical
        // radial actually paints rather than a circle beside it. Reading the
        // node transform directly also had nothing to offer a Live Paint face,
        // which has no node at all.
        if (grad.gradient_type === 'Radial') {
            const t = ge.gradientToWorld();
            const r = Math.hypot(grad.end_x - grad.start_x, grad.end_y - grad.start_y);
            if (r > 1e-6) {
                canvas.save();
                canvas.concat(t);
                // Approximate screen-constant stroke width in node space
                const sx = Math.hypot(t[0], t[3]) || 1;
                halo.setStrokeWidth(2.5 / (z * sx));
                white.setStrokeWidth(1 / (z * sx));
                canvas.drawCircle(grad.start_x, grad.start_y, r, halo);
                canvas.drawCircle(grad.start_x, grad.start_y, r, white);
                canvas.restore();
            }
        }

        // Axis line
        halo.setStrokeWidth(3 / z);
        white.setStrokeWidth(1.5 / z);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, halo);
        canvas.drawLine(p0.x, p0.y, p1.x, p1.y, white);

        // Stop dots: white backing disc + stop color + dark outline
        halo.setStrokeWidth(1 / z);
        for (let i = 0; i < grad.stops.length; i++) {
            const s = grad.stops[i];
            const x = p0.x + (p1.x - p0.x) * s.offset;
            const y = p0.y + (p1.y - p0.y) * s.offset;
            const selected = i === ge.stopIndex;
            const r = (selected ? 5.5 : 4.5) / z;
            fill.setColor(ck.Color4f(1, 1, 1, 1));
            canvas.drawCircle(x, y, r, fill);
            fill.setColor(ck.Color4f(s.color.r, s.color.g, s.color.b, s.color.a ?? 1));
            canvas.drawCircle(x, y, r, fill);
            canvas.drawCircle(x, y, r, halo);
            if (selected) {
                accent.setStrokeWidth(1.5 / z);
                canvas.drawCircle(x, y, r + 1.5 / z, accent);
            }
        }

        // Start handle: larger ring (radial: the center)
        white.setStrokeWidth(2 / z);
        halo.setStrokeWidth(3.5 / z);
        canvas.drawCircle(p0.x, p0.y, 8 / z, halo);
        canvas.drawCircle(p0.x, p0.y, 8 / z, white);

        // End handle: square, rotated to the axis (radial: the radius handle)
        const angleDeg = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
        const hs = 6 / z;
        canvas.save();
        canvas.rotate(angleDeg, p1.x, p1.y);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), halo);
        canvas.drawRect(ck.LTRBRect(p1.x - hs, p1.y - hs, p1.x + hs, p1.y + hs), white);
        canvas.restore();

        halo.delete();
        white.delete();
        fill.delete();
        accent.delete();

        canvas.restore();
    }

    /**
     * Mesh-gradient editing overlay: the grid's actual bezier lines, color-
     * filled diamond vertices (accent ring when selected), bezier handles for
     * the selected vertices, hover highlights, and dashed ghost previews of
     * the exact lines a click would insert. Visible only while the Mesh tool
     * is active on the edited node — the Selection tool shows the plain bbox.
     *
     * Everything is transformed to WORLD space point-by-point (affine maps
     * cubics to cubics exactly), so handle/vertex sizes stay screen-constant
     * even under rotation and non-uniform scale.
     */
    private drawMeshOverlay(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (im?.ui.activeTool !== 'mesh') return;
        const me = im.ui.meshEdit;
        if (!me?.isActive()) return;
        const selection = this.scene.getSelection();
        if (selection.length !== 1 || selection[0] !== me.nodeId) return;
        const mesh = me.mesh();
        if (!mesh) return;

        const z = this.zoom;
        const ck = this.ck;
        const w = (p: [number, number]) => me.localToWorld(p[0], p[1]);

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(z, z);

        const halo = new ck.Paint();
        halo.setColor(ck.Color(0, 0, 0, 0.35));
        halo.setStyle(ck.PaintStyle.Stroke);
        halo.setAntiAlias(true);

        const white = new ck.Paint();
        white.setColor(ck.Color(255, 255, 255, 0.9));
        white.setStyle(ck.PaintStyle.Stroke);
        white.setAntiAlias(true);

        const fill = new ck.Paint();
        fill.setStyle(ck.PaintStyle.Fill);
        fill.setAntiAlias(true);

        const accent = new ck.Paint();
        accent.setColor(ck.Color(0, 162, 255, 1));
        accent.setStyle(ck.PaintStyle.Stroke);
        accent.setAntiAlias(true);

        const danger = new ck.Paint();
        danger.setColor(ck.Color(235, 64, 52, 1));
        danger.setStyle(ck.PaintStyle.Stroke);
        danger.setAntiAlias(true);

        const worldCubicPath = (cubics: Cubic[], path: Path) => {
            for (const c of cubics) {
                const p0 = w(c[0]);
                const p1 = w(c[1]);
                const p2 = w(c[2]);
                const p3 = w(c[3]);
                path.moveTo(p0.x, p0.y);
                path.cubicTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
            }
        };

        // ── Grid lines ──
        const grid = new ck.Path();
        const rowLine = (r: number): Cubic[] => {
            const out: Cubic[] = [];
            for (let pc = 0; pc < mesh.cols; pc++) out.push(hEdgeCubic(mesh, r, pc));
            return out;
        };
        const colLine = (c: number): Cubic[] => {
            const out: Cubic[] = [];
            for (let pr = 0; pr < mesh.rows; pr++) out.push(vEdgeCubic(mesh, pr, c));
            return out;
        };
        for (let r = 0; r <= mesh.rows; r++) worldCubicPath(rowLine(r), grid);
        for (let c = 0; c <= mesh.cols; c++) worldCubicPath(colLine(c), grid);
        halo.setStrokeWidth(2.5 / z);
        white.setStrokeWidth(1.1 / z);
        canvas.drawPath(grid, halo);
        canvas.drawPath(grid, white);
        grid.delete();

        // ── Hover highlights ──
        const hover = me.hover;
        const stride = mesh.cols + 1;
        if (hover?.type === 'line') {
            // Highlight the whole hovered grid line: accent = "insert the
            // perpendicular here"; red (Alt) = "delete this line" (only when
            // it is deletable, i.e. interior).
            const cubics =
                hover.axis === 'row' ? rowLine(hover.lineIndex) : colLine(hover.lineIndex);
            const interior =
                hover.axis === 'row'
                    ? hover.lineIndex > 0 && hover.lineIndex < mesh.rows
                    : hover.lineIndex > 0 && hover.lineIndex < mesh.cols;
            const p = me.hoverAlt ? (interior ? danger : halo) : accent;
            p.setStrokeWidth(2 / z);
            const hp = new ck.Path();
            worldCubicPath(cubics, hp);
            canvas.drawPath(hp, p);
            hp.delete();
        } else if (hover?.type === 'vertex' && me.hoverAlt) {
            // Alt over a vertex: exactly the lines a delete would remove glow
            // red (the last-added lines for a freshly added point, both grid
            // lines otherwise).
            const lines = me.linesForVertexDeletion(mesh, hover.vi);
            if (lines.length > 0) {
                danger.setStrokeWidth(2 / z);
                const hp = new ck.Path();
                for (const l of lines) {
                    worldCubicPath(l.axis === 'row' ? rowLine(l.index) : colLine(l.index), hp);
                }
                canvas.drawPath(hp, danger);
                hp.delete();
            }
        }

        // ── Ghost previews of insertable lines (dashed accent) ──
        const ghosts = me.ghostLines();
        if (ghosts.length > 0) {
            const dash = ck.PathEffect.MakeDash([5 / z, 4 / z], 0);
            accent.setPathEffect(dash);
            accent.setStrokeWidth(1.4 / z);
            const gp = new ck.Path();
            for (const chain of ghosts) worldCubicPath(chain, gp);
            canvas.drawPath(gp, accent);
            gp.delete();
            accent.setPathEffect(null);
            dash.delete();
        }

        // ── Handles of selected vertices (before diamonds so lines sit under) ──
        halo.setStrokeWidth(2 / z);
        white.setStrokeWidth(1 / z);
        for (const vi of me.selectedVertices) {
            if (vi >= mesh.vertices.length) continue;
            const v = mesh.vertices[vi];
            const row = Math.floor(vi / stride);
            const col = vi % stride;
            const vp = me.localToWorld(v.x, v.y);
            for (const dir of ['e', 'w', 's', 'n'] as const) {
                const exists =
                    (dir === 'e' && col < mesh.cols) ||
                    (dir === 'w' && col > 0) ||
                    (dir === 's' && row < mesh.rows) ||
                    (dir === 'n' && row > 0);
                if (!exists) continue;
                const h = effectiveHandle(mesh, vi, dir);
                const hp = w(h);
                canvas.drawLine(vp.x, vp.y, hp.x, hp.y, halo);
                canvas.drawLine(vp.x, vp.y, hp.x, hp.y, white);
                const hovered = hover?.type === 'handle' && hover.vi === vi && hover.dir === dir;
                const r = (hovered ? 4.5 : 3.5) / z;
                fill.setColor(ck.Color4f(1, 1, 1, 1));
                canvas.drawCircle(hp.x, hp.y, r, fill);
                accent.setStrokeWidth(1.2 / z);
                canvas.drawCircle(hp.x, hp.y, r, accent);
            }
        }

        // ── Vertices: color-filled diamonds ──
        halo.setStrokeWidth(1 / z);
        for (let vi = 0; vi < mesh.vertices.length; vi++) {
            const v = mesh.vertices[vi];
            const p = me.localToWorld(v.x, v.y);
            const selected = me.selectedVertices.has(vi);
            const hovered = hover?.type === 'vertex' && hover.vi === vi;
            const s = ((selected ? 5.5 : 4.5) + (hovered ? 1 : 0)) / z;
            canvas.save();
            canvas.rotate(45, p.x, p.y);
            const rect = ck.LTRBRect(p.x - s, p.y - s, p.x + s, p.y + s);
            fill.setColor(ck.Color4f(1, 1, 1, 1));
            canvas.drawRect(rect, fill);
            fill.setColor(ck.Color4f(v.color.r, v.color.g, v.color.b, v.color.a));
            canvas.drawRect(rect, fill);
            canvas.drawRect(rect, halo);
            if (selected || hovered) {
                accent.setStrokeWidth(1.5 / z);
                const ring = 1.5 / z;
                canvas.drawRect(
                    ck.LTRBRect(p.x - s - ring, p.y - s - ring, p.x + s + ring, p.y + s + ring),
                    accent,
                );
            }
            canvas.restore();
        }

        halo.delete();
        white.delete();
        fill.delete();
        accent.delete();
        danger.delete();
        canvas.restore();
    }

    calculatePathBounds(path: {
        subpaths: Array<{
            points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>;
            closed: boolean;
        }>;
    }) {
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        let hasPoints = false;
        for (const sp of path.subpaths) {
            const pts = sp.points;
            const n = pts.length;
            if (n === 0) continue;
            // Include the first anchor
            hasPoints = true;
            minX = Math.min(minX, pts[0].x);
            minY = Math.min(minY, pts[0].y);
            maxX = Math.max(maxX, pts[0].x);
            maxY = Math.max(maxY, pts[0].y);
            // Flatten each cubic segment and include sampled points
            for (let i = 1; i < n; i++) {
                const a = pts[i - 1];
                const b = pts[i];
                this.flattenCubicBounds(
                    a.x,
                    a.y,
                    a.cp2[0],
                    a.cp2[1],
                    b.cp1[0],
                    b.cp1[1],
                    b.x,
                    b.y,
                    (x, y) => {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    },
                );
            }
            if (sp.closed && n >= 2) {
                const a = pts[n - 1];
                const b = pts[0];
                this.flattenCubicBounds(
                    a.x,
                    a.y,
                    a.cp2[0],
                    a.cp2[1],
                    b.cp1[0],
                    b.cp1[1],
                    b.x,
                    b.y,
                    (x, y) => {
                        minX = Math.min(minX, x);
                        minY = Math.min(minY, y);
                        maxX = Math.max(maxX, x);
                        maxY = Math.max(maxY, y);
                    },
                );
            }
        }
        return hasPoints ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }

    /** Subdivide a cubic Bézier and call cb for sampled points along the curve. */
    private flattenCubicBounds(
        x0: number,
        y0: number,
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        x3: number,
        y3: number,
        cb: (x: number, y: number) => void,
    ) {
        // Adaptive subdivision: split until segments are flat enough
        const stack: [number, number, number, number, number, number, number, number][] = [
            [x0, y0, x1, y1, x2, y2, x3, y3],
        ];
        const tolerance = 0.5;
        while (stack.length > 0) {
            const [ax, ay, bx, by, cx, cy, dx, dy] = stack.pop()!;
            // Flatness test: max distance of control points from the line a→d
            const ux = 3 * bx - 2 * ax - dx;
            const uy = 3 * by - 2 * ay - dy;
            const vx = 3 * cx - ax - 2 * dx;
            const vy = 3 * cy - ay - 2 * dy;
            const maxDist = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
            if (maxDist <= 16 * tolerance * tolerance) {
                cb(dx, dy);
            } else {
                // De Casteljau split at t=0.5
                const abx = (ax + bx) / 2,
                    aby = (ay + by) / 2;
                const bcx = (bx + cx) / 2,
                    bcy = (by + cy) / 2;
                const cdx = (cx + dx) / 2,
                    cdy = (cy + dy) / 2;
                const abcx = (abx + bcx) / 2,
                    abcy = (aby + bcy) / 2;
                const bcdx = (bcx + cdx) / 2,
                    bcdy = (bcy + cdy) / 2;
                const mx = (abcx + bcdx) / 2,
                    my = (abcy + bcdy) / 2;
                // Push second half first so first half is processed next
                stack.push([mx, my, bcdx, bcdy, cdx, cdy, dx, dy]);
                stack.push([ax, ay, abx, aby, abcx, abcy, mx, my]);
            }
        }
    }

    /**
     * Pixel grid (1 world-unit lattice), Figma-style.
     * Hidden below 1000% zoom — at lower zoom a coarse lattice just noise.
     */
    private drawGrid(canvas: Canvas, dpr: number) {
        if (this.zoom < 10) return;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const op = this.ensureOverlayPaints();
        // ~1 CSS px hairline; AA keeps verticals from dropping out.
        op.gridPaint.setAntiAlias(true);
        op.gridPaint.setStrokeWidth(1 / this.zoom);

        const pitch = 1;
        const w = this.canvas.width / dpr;
        const h = this.canvas.height / dpr;
        const startX = Math.floor(-this.pan.x / this.zoom / pitch) * pitch;
        const startY = Math.floor(-this.pan.y / this.zoom / pitch) * pitch;
        const endX = startX + w / this.zoom + pitch * 2;
        const endY = startY + h / this.zoom + pitch * 2;

        for (let x = startX; x <= endX; x += pitch) {
            canvas.drawLine(x, startY, x, endY, op.gridPaint);
        }
        for (let y = startY; y <= endY; y += pitch) {
            canvas.drawLine(startX, y, endX, y, op.gridPaint);
        }

        canvas.restore();
    }

    /** Screen-constant size (world units) for artboard resize handles. */
    private artboardHandleWorld(): number {
        return 4 / this.zoom;
    }

    drawArtboards(canvas: Canvas) {
        const op = this.ensureOverlayPaints();
        const artboards = this.scene.getArtboards();

        for (const ab of artboards) {
            // Background fill (per-artboard color).
            op.artboardFill.setColor(
                this.ck.Color(
                    Math.round(ab.background.r * 255),
                    Math.round(ab.background.g * 255),
                    Math.round(ab.background.b * 255),
                    ab.background.a,
                ),
            );
            canvas.drawRect(
                this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h),
                op.artboardFill,
            );

            // Border — full select: accent + handles; soft focus: accent stroke
            // only (generator-parent style); else gray idle.
            const selected = ab.id === this.selectedArtboardId;
            const soft = !selected && ab.id === this.softArtboardId;
            const border = selected || soft ? op.selOutline : op.artboardStroke;
            const z = Math.max(0.05, this.zoom);
            border.setStrokeWidth(1 / z);
            border.setAntiAlias(true);
            canvas.drawRect(
                this.ck.LTRBRect(ab.x, ab.y, ab.x + ab.w, ab.y + ab.h),
                border,
            );

            // Name label above the top-left corner, at screen-constant size.
            this.drawArtboardLabel(canvas, ab, selected || soft);

            // Resize handles when selected — hide during move (same as node
            // transform box: chrome returns after mouse-up).
            const im = this.inputManager;
            const artboardMoving = Boolean(im?.isArtboardMoving?.());
            if (selected && !artboardMoving) this.drawArtboardHandles(canvas, ab);
        }
    }

    /** A real typeface for `family` (from loaded font bytes), or null to fall
     *  back to CanvasKit's default face. Cached. */
    private getTypeface(family: string) {
        if (this._typefaceCache.has(family)) return this._typefaceCache.get(family) ?? null;
        let tf: ReturnType<CanvasKit['Typeface']['MakeFreeTypeFaceFromData']> | null = null;
        const data = getFontData(family);
        if (data) {
            try {
                tf = this.ck.Typeface.MakeFreeTypeFaceFromData(data);
            } catch {
                tf = null;
            }
        }
        this._typefaceCache.set(family, tf);
        return tf;
    }

    /**
     * Render `content` with its baseline flowing along the world outline of the
     * `pathId` node. Glyphs are placed by arc length via ContourMeasure and
     * rotated to the path tangent with per-glyph RSXforms. The text node's own
     * transform (which keeps its bounds over the path for culling) is undone
     * first so the glyphs land in world space along the path.
     */
    private drawTextOnPath(
        canvas: Canvas,
        textId: number,
        content: string,
        fontSize: number,
        fontFamily: string,
        pathId: number,
        paint: Paint,
    ) {
        const worldPath = nodeToWorldPath(this.ck, this.scene, pathId);
        if (!worldPath) return;

        // The text node has a transform (kept so its bounds overlap the path and
        // it isn't culled). Undo it so we can place glyphs in world space along
        // the path's world outline.
        const inv = invertAffine(this.scene.getTransform(textId));
        canvas.save();
        if (inv) canvas.concat(inv);
        const iter = new this.ck.ContourMeasureIter(worldPath, false, 1);
        const measure = iter.next();
        if (!measure) {
            canvas.restore();
            iter.delete();
            worldPath.delete();
            return;
        }
        const len = measure.length();

        const font = new this.ck.Font(this.getTypeface(fontFamily), fontSize);
        const text = content.replace(/\n/g, ' ');
        const glyphIDs = font.getGlyphIDs(text);
        const widths = font.getGlyphWidths(glyphIDs);

        const glyphs: number[] = [];
        const xforms: number[] = [];
        let d = 0;
        for (let i = 0; i < glyphIDs.length; i++) {
            const gw = widths[i];
            const center = d + gw / 2;
            d += gw;
            if (center > len) break; // ran off the end of the path
            const pt = measure.getPosTan(center); // [px, py, tanx, tany] (unit tangent)
            const scos = pt[2];
            const ssin = pt[3];
            // Place the glyph so its horizontal midpoint sits on the path point,
            // rotated to the tangent (baseline on the curve).
            glyphs.push(glyphIDs[i]);
            xforms.push(scos, ssin, pt[0] - scos * (gw / 2), pt[1] - ssin * (gw / 2));
        }

        if (glyphs.length > 0) {
            const blob = this.ck.TextBlob.MakeFromRSXformGlyphs(glyphs, xforms, font);
            if (blob) {
                canvas.drawTextBlob(blob, 0, 0, paint);
                blob.delete();
            }
        }
        canvas.restore();
        font.delete();
        measure.delete();
        // This runs once per frame for as long as a text-on-path node is on
        // screen, so an undeleted iterator here is an unbounded leak, not a
        // one-off one.
        iter.delete();
        worldPath.delete();
    }

    /** Draw arrowhead / line-ending markers at an open subpath's ends, in the
     *  node's local space (so they export with the artwork), using the stroke
     *  color and width. Cheap when the node has no markers (map lookup + return). */
    private drawNodeMarkers(
        canvas: Canvas,
        nodeId: number,
        strokes: {
            paint?: { type: number; r: number; g: number; b: number; a: number };
            width: number;
        }[],
    ) {
        const markers = this.scene.getNodeMarkers(nodeId);
        if (!markers || (!markers.start && !markers.end)) return;
        const st =
            strokes.find((s) => s.paint?.type === 1 && s.width > 0) ??
            strokes.find((s) => s.width > 0);
        if (!st) return;
        const sp = this.scene
            .getResolvedSubpaths(nodeId)
            .find((s) => !s.closed && s.points.length >= 2);
        if (!sp) return;
        const pts = sp.points;
        const w = st.width;

        const paint = new this.ck.Paint();
        paint.setStyle(this.ck.PaintStyle.Fill);
        paint.setAntiAlias(true);
        paint.setColor(
            st.paint && st.paint.type === 1
                ? this.ck.Color4f(st.paint.r, st.paint.g, st.paint.b, st.paint.a)
                : this.ck.Color4f(0, 0, 0, 1),
        );

        const norm = (x: number, y: number): [number, number] => {
            const len = Math.hypot(x, y) || 1;
            return [x / len, y / len];
        };
        if (markers.start && markers.start !== 'none') {
            const a = pts[0];
            const cx = a.cp2[0] !== a.x || a.cp2[1] !== a.y ? a.cp2 : [pts[1].x, pts[1].y];
            const [dx, dy] = norm(a.x - cx[0], a.y - cx[1]);
            this.drawMarker(canvas, paint, markers.start, a.x, a.y, dx, dy, w);
        }
        if (markers.end && markers.end !== 'none') {
            const a = pts[pts.length - 1];
            const prev = pts[pts.length - 2];
            const cx = a.cp1[0] !== a.x || a.cp1[1] !== a.y ? a.cp1 : [prev.x, prev.y];
            const [dx, dy] = norm(a.x - cx[0], a.y - cx[1]);
            this.drawMarker(canvas, paint, markers.end, a.x, a.y, dx, dy, w);
        }
        paint.delete();
    }

    /** One marker at (x,y) with outward unit direction (dx,dy), sized to stroke w. */
    private drawMarker(
        canvas: Canvas,
        paint: Paint,
        kind: 'none' | 'arrow' | 'circle' | 'square',
        x: number,
        y: number,
        dx: number,
        dy: number,
        w: number,
    ) {
        if (kind === 'circle') {
            canvas.drawCircle(x, y, w * 1.9, paint);
            return;
        }
        if (kind === 'square') {
            const h = w * 1.7;
            canvas.drawRect(this.ck.LTRBRect(x - h, y - h, x + h, y + h), paint);
            return;
        }
        // Arrow: a triangle with its tip at the end pointing outward.
        const size = w * 3.4;
        const half = w * 2.1;
        const px = -dy;
        const py = dx;
        const tri = new this.ck.Path();
        tri.moveTo(x + dx * w * 0.8, y + dy * w * 0.8); // tip just past the endpoint
        tri.lineTo(x - dx * size + px * half, y - dy * size + py * half);
        tri.lineTo(x - dx * size - px * half, y - dy * size - py * half);
        tri.close();
        canvas.drawPath(tri, paint);
        tri.delete();
    }

    private drawArtboardLabel(canvas: Canvas, ab: Artboard, selected: boolean) {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        const paint = new this.ck.Paint();
        paint.setColor(
            selected ? this.ck.Color(0, 162, 255, 1.0) : this.ck.Color(150, 150, 150, 1.0),
        );
        paint.setAntiAlias(true);
        const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
        if (blob) {
            canvas.drawTextBlob(blob, ab.x, ab.y - 5 / this.zoom, paint);
            blob.delete();
        }
        font.delete();
        paint.delete();
    }

    private drawArtboardHandles(canvas: Canvas, ab: Artboard) {
        const op = this.ensureOverlayPaints();
        const s = this.artboardHandleWorld();
        op.selHandleStroke.setStrokeWidth(1 / this.zoom);
        for (const [hx, hy] of this.artboardHandlePositions(ab)) {
            const r = this.ck.LTRBRect(hx - s, hy - s, hx + s, hy + s);
            canvas.drawRect(r, op.selHandleFill);
            canvas.drawRect(r, op.selHandleStroke);
        }
    }

    /** The 8 resize-handle centers (world space): NW,N,NE,E,SE,S,SW,W. */
    private artboardHandlePositions(ab: Artboard): [number, number][] {
        const { x, y, w, h } = ab;
        const cx = x + w / 2,
            cy = y + h / 2;
        return [
            [x, y],
            [cx, y],
            [x + w, y],
            [x + w, cy],
            [x + w, y + h],
            [cx, y + h],
            [x, y + h],
            [x, cy],
        ];
    }

    private static HANDLE_DIRS: ArtboardHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    /** Hit-test the resize handles of the selected artboard. */
    artboardHandleHitTest(wx: number, wy: number): { id: number; handle: ArtboardHandle } | null {
        if (this.selectedArtboardId === null) return null;
        const ab = this.scene.getArtboards().find((a) => a.id === this.selectedArtboardId);
        if (!ab) return null;
        const s = this.artboardHandleWorld() * 1.8; // a bit more forgiving than the visual
        const pos = this.artboardHandlePositions(ab);
        for (let i = 0; i < pos.length; i++) {
            if (Math.abs(wx - pos[i][0]) <= s && Math.abs(wy - pos[i][1]) <= s) {
                return { id: ab.id, handle: Renderer.HANDLE_DIRS[i] };
            }
        }
        return null;
    }

    /** Hit-test artboard name labels; returns the artboard id or null. */
    artboardLabelHitTest(wx: number, wy: number): number | null {
        const px = 11;
        const size = px / this.zoom;
        const font = new this.ck.Font(null, size);
        let hit: number | null = null;
        for (const ab of this.scene.getArtboards()) {
            const blob = this.ck.TextBlob.MakeFromText(ab.name, font);
            // Approximate label width; MakeFromText has no measure, so estimate.
            const wApprox = ab.name.length * size * 0.6;
            if (blob) blob.delete();
            const labelTop = ab.y - 5 / this.zoom - size;
            const labelBottom = ab.y - 5 / this.zoom + size * 0.25;
            if (wx >= ab.x && wx <= ab.x + wApprox && wy >= labelTop && wy <= labelBottom) {
                hit = ab.id; // last (topmost) wins
            }
        }
        font.delete();
        return hit;
    }

    /** Hit-test artboard plate bodies (topmost wins). Empty-plate click select. */
    artboardBodyHitTest(wx: number, wy: number): number | null {
        let hit: number | null = null;
        for (const ab of this.scene.getArtboards()) {
            if (wx >= ab.x && wx <= ab.x + ab.w && wy >= ab.y && wy <= ab.y + ab.h) {
                hit = ab.id;
            }
        }
        return hit;
    }

    /** Union AABB of all artboards, or a default page if none. */
    getArtboardsBounds(): { x: number; y: number; w: number; h: number } {
        const arts = this.scene.getArtboards();
        if (arts.length === 0) return { x: 0, y: 0, w: 1000, h: 1000 };
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const a of arts) {
            minX = Math.min(minX, a.x);
            minY = Math.min(minY, a.y);
            maxX = Math.max(maxX, a.x + a.w);
            maxY = Math.max(maxY, a.y + a.h);
        }
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }

    private drawDirectEditHandles(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im?.editingPoints || im.editingNodeId === null || !im.editingTransform) return;

        const points = im.editingPoints;
        const t = im.editingTransform;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const dotSize = 4 / this.zoom;
        const handleSize = 3.5 / this.zoom;
        const lineWidth = 1 / this.zoom;

        const linePaint = new this.ck.Paint();
        linePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        linePaint.setStyle(this.ck.PaintStyle.Stroke);
        linePaint.setStrokeWidth(lineWidth);
        linePaint.setAntiAlias(false);

        const anchorFill = new this.ck.Paint();
        anchorFill.setColor(this.ck.Color(255, 255, 255, 1.0));
        anchorFill.setStyle(this.ck.PaintStyle.Fill);
        anchorFill.setAntiAlias(false);

        const anchorStroke = new this.ck.Paint();
        anchorStroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        anchorStroke.setStyle(this.ck.PaintStyle.Stroke);
        anchorStroke.setStrokeWidth(lineWidth * 1.5);
        anchorStroke.setAntiAlias(false);

        const selectedFill = new this.ck.Paint();
        selectedFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        selectedFill.setStyle(this.ck.PaintStyle.Fill);

        const handleFill = new this.ck.Paint();
        handleFill.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleFill.setStyle(this.ck.PaintStyle.Fill);

        // Draw hover segment highlight
        if (im.hoverSegment) {
            const h = im.hoverSegment;
            const sp = points[h.subpathIndex];
            const p1 = sp.points[h.segmentIndex];
            const p2 = sp.points[(h.segmentIndex + 1) % sp.points.length];

            // Only draw if not closed or not at the end
            if (sp.closed || h.segmentIndex < sp.points.length - 1) {
                const highlightPaint = new this.ck.Paint();
                highlightPaint.setColor(this.ck.Color(0, 162, 255, 0.4));
                highlightPaint.setStyle(this.ck.PaintStyle.Stroke);
                highlightPaint.setStrokeWidth(lineWidth * 3);

                const path = new this.ck.Path();
                const a1 = {
                    x: t[0] * p1.x + t[1] * p1.y + t[2],
                    y: t[3] * p1.x + t[4] * p1.y + t[5],
                };
                const c1 = {
                    x: t[0] * p1.cp2[0] + t[1] * p1.cp2[1] + t[2],
                    y: t[3] * p1.cp2[0] + t[4] * p1.cp2[1] + t[5],
                };
                const c2 = {
                    x: t[0] * p2.cp1[0] + t[1] * p2.cp1[1] + t[2],
                    y: t[3] * p2.cp1[0] + t[4] * p2.cp1[1] + t[5],
                };
                const a2 = {
                    x: t[0] * p2.x + t[1] * p2.y + t[2],
                    y: t[3] * p2.x + t[4] * p2.y + t[5],
                };

                path.moveTo(a1.x, a1.y);
                path.cubicTo(c1.x, c1.y, c2.x, c2.y, a2.x, a2.y);
                canvas.drawPath(path, highlightPaint);

                path.delete();
                highlightPaint.delete();
            }
        }

        for (let si = 0; si < points.length; si++) {
            const sp = points[si];
            // Mid-edge add-point affordances (N/E/S/W on a rect path, etc.).
            const n = sp.points.length;
            const segCount = sp.closed ? n : Math.max(0, n - 1);
            const z = Math.max(0.05, this.zoom);
            // ~3 CSS px half; AA on so mid squares stay visible like corner anchors.
            const mid = 3 / z;
            for (let i = 0; i < segCount; i++) {
                const p1 = sp.points[i];
                const p2 = sp.points[(i + 1) % n];
                const mx =
                    (t[0] * (p1.x + p2.x) + t[1] * (p1.y + p2.y)) * 0.5 + t[2];
                const my =
                    (t[3] * (p1.x + p2.x) + t[4] * (p1.y + p2.y)) * 0.5 + t[5];
                anchorFill.setAntiAlias(true);
                anchorStroke.setAntiAlias(true);
                canvas.drawRect(
                    this.ck.LTRBRect(mx - mid, my - mid, mx + mid, my + mid),
                    anchorFill,
                );
                canvas.drawRect(
                    this.ck.LTRBRect(mx - mid, my - mid, mx + mid, my + mid),
                    anchorStroke,
                );
            }
            for (let i = 0; i < sp.points.length; i++) {
                const p = sp.points[i];
                const ax = t[0] * p.x + t[1] * p.y + t[2];
                const ay = t[3] * p.x + t[4] * p.y + t[5];
                const c1x = t[0] * p.cp1[0] + t[1] * p.cp1[1] + t[2];
                const c1y = t[3] * p.cp1[0] + t[4] * p.cp1[1] + t[5];
                const c2x = t[0] * p.cp2[0] + t[1] * p.cp2[1] + t[2];
                const c2y = t[3] * p.cp2[0] + t[4] * p.cp2[1] + t[5];

                const isSmooth = Math.abs(c1x - ax) > 0.5 || Math.abs(c1y - ay) > 0.5;
                if (isSmooth) {
                    canvas.drawLine(ax, ay, c1x, c1y, linePaint);
                    canvas.drawLine(ax, ay, c2x, c2y, linePaint);
                    canvas.drawCircle(c1x, c1y, handleSize, handleFill);
                    canvas.drawCircle(c2x, c2y, handleSize, handleFill);
                }

                const isSelected = im.selectedPoints.has(`${si}:${i}`);
                canvas.drawCircle(ax, ay, dotSize, isSelected ? selectedFill : anchorFill);
                canvas.drawCircle(ax, ay, dotSize, anchorStroke);
            }
        }

        linePaint.delete();
        anchorFill.delete();
        anchorStroke.delete();
        selectedFill.delete();
        handleFill.delete();
        canvas.restore();
    }

    /** Draw a preview dot for the scissors / add-point hover. */
    private drawScissorsPreview(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im?.scissorsHoverPoint) return;

        const { x, y } = im.scissorsHoverPoint;

        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);

        const radius = 5 / this.zoom;
        const lineWidth = 1.5 / this.zoom;

        const fill = new this.ck.Paint();
        fill.setColor(this.ck.Color(0, 162, 255, 1.0));
        fill.setStyle(this.ck.PaintStyle.Fill);

        const stroke = new this.ck.Paint();
        stroke.setColor(this.ck.Color(255, 255, 255, 1.0));
        stroke.setStyle(this.ck.PaintStyle.Stroke);
        stroke.setStrokeWidth(lineWidth);

        canvas.drawCircle(x, y, radius, fill);
        canvas.drawCircle(x, y, radius, stroke);

        fill.delete();
        stroke.delete();
        canvas.restore();
    }

    private drawPreview(canvas: Canvas) {
        this.drawStrokePreview(canvas);

        const preview = this.inputManager?.previewRect;
        if (!preview || preview.w < 1 || preview.h < 1) return;

        const { x, y, w, h, tool } = preview;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);
        // Artboards preview as a plain rectangle (like the rect tool).
        const rectLike = tool === 'rect' || tool === 'artboard';
        const isCustomShape = !rectLike && tool !== 'ellipse';
        const shapePath = isCustomShape ? this.makePreviewPath(tool, x, y, w, h) : null;

        // Match the committed style (getCurrentStyle) — no blue ghost tint.
        const style = this.createPreviewPaints(tool === 'artboard');

        if (style.fill) {
            if (rectLike) canvas.drawRect(rect, style.fill);
            else if (tool === 'ellipse') canvas.drawOval(rect, style.fill);
            else canvas.drawPath(shapePath!, style.fill);
        }

        if (style.stroke) {
            if (rectLike) canvas.drawRect(rect, style.stroke);
            else if (tool === 'ellipse') canvas.drawOval(rect, style.stroke);
            else canvas.drawPath(shapePath!, style.stroke);
        }

        shapePath?.delete();
        style.fill?.delete();
        style.stroke?.delete();
    }

    /**
     * Paints for drag-to-create preview — same appearance as the shape that
     * will be committed (UIEngine current style). Artboards use a white plate.
     */
    private createPreviewPaints(artboard: boolean): { fill: Paint | null; stroke: Paint | null } {
        const ck = this.ck;
        if (artboard) {
            const fill = new ck.Paint();
            fill.setStyle(ck.PaintStyle.Fill);
            fill.setColor(ck.Color(255, 255, 255, 1));
            fill.setAntiAlias(true);
            const stroke = new ck.Paint();
            stroke.setStyle(ck.PaintStyle.Stroke);
            stroke.setColor(ck.Color(80, 80, 80, 1));
            stroke.setStrokeWidth(1 / Math.max(0.001, this.zoom));
            stroke.setAntiAlias(true);
            return { fill, stroke };
        }

        let fillR = 0.8,
            fillG = 0.8,
            fillB = 0.8,
            fillA = 1;
        let strokeR = 0,
            strokeG = 0,
            strokeB = 0,
            strokeA = 1;
        let strokeW = 1;
        let hasFill = true;
        let hasStroke = true;
        try {
            const raw = this.inputManager?.ui?.getCurrentStyle?.() ?? '';
            const s = raw ? JSON.parse(raw) : null;
            const f0 = s?.fills?.[0];
            if (f0 && typeof f0.r === 'number') {
                fillR = f0.r;
                fillG = f0.g;
                fillB = f0.b;
                fillA = f0.a ?? 1;
                hasFill = fillA > 0.001;
            } else if (Array.isArray(s?.fills) && s.fills.length === 0) {
                hasFill = false;
            }
            const st0 = s?.strokes?.[0];
            if (st0?.paint && typeof st0.paint.r === 'number') {
                strokeR = st0.paint.r;
                strokeG = st0.paint.g;
                strokeB = st0.paint.b;
                strokeA = st0.paint.a ?? 1;
                strokeW = Number(st0.width) > 0 ? Number(st0.width) : 1;
                hasStroke = strokeA > 0.001 && strokeW > 0;
            } else if (Array.isArray(s?.strokes) && s.strokes.length === 0) {
                hasStroke = false;
            }
        } catch {
            /* keep defaults */
        }

        let fill: Paint | null = null;
        if (hasFill) {
            fill = new ck.Paint();
            fill.setStyle(ck.PaintStyle.Fill);
            fill.setColor(ck.Color4f(fillR, fillG, fillB, fillA));
            fill.setAntiAlias(true);
        }
        let stroke: Paint | null = null;
        if (hasStroke) {
            stroke = new ck.Paint();
            stroke.setStyle(ck.PaintStyle.Stroke);
            stroke.setColor(ck.Color4f(strokeR, strokeG, strokeB, strokeA));
            stroke.setStrokeWidth(strokeW);
            stroke.setAntiAlias(true);
        }
        return { fill, stroke };
    }

    /** Live preview stroke for the line and pencil tools (point-based, not a box). */
    /** Ghost of a parametric action's result (Offset/Simplify/Blend), drawn in
     *  world space while its value dialog is open for live feedback. */
    private drawShapePreview(canvas: Canvas) {
        const preview = this.inputManager?.shapePreview;
        if (!preview || preview.subpaths.length === 0) return;

        const path = new this.ck.Path();
        appendSubpathsToPath(path, preview.subpaths);
        path.setFillType(
            preview.fillRule === 1 ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding,
        );

        const fill = new this.ck.Paint();
        fill.setStyle(this.ck.PaintStyle.Fill);
        fill.setColor(this.ck.Color(0, 162, 255, 0.12));
        fill.setAntiAlias(true);
        canvas.drawPath(path, fill);

        const stroke = new this.ck.Paint();
        stroke.setStyle(this.ck.PaintStyle.Stroke);
        stroke.setColor(this.ck.Color(0, 162, 255, 1.0));
        stroke.setStrokeWidth(1.5 / this.zoom);
        stroke.setAntiAlias(true);
        canvas.drawPath(path, stroke);

        path.delete();
        fill.delete();
        stroke.delete();
    }

    private drawStrokePreview(canvas: Canvas) {
        const line = this.inputManager?.previewLine;
        const pencil = this.inputManager?.pencilPoints;
        if (!line && (!pencil || pencil.length < 2)) return;

        const path = new this.ck.Path();
        if (line) {
            path.moveTo(line.x1, line.y1);
            path.lineTo(line.x2, line.y2);
        } else if (pencil) {
            path.moveTo(pencil[0].x, pencil[0].y);
            for (let i = 1; i < pencil.length; i++) path.lineTo(pencil[i].x, pencil[i].y);
        }

        // Open strokes commit stroke-only (drawnPathStyle) — preview matches that.
        const paints = this.createPreviewPaints(false);
        paints.fill?.delete();
        const paint = paints.stroke ?? new this.ck.Paint();
        if (!paints.stroke) {
            paint.setColor(this.ck.Color(0, 0, 0, 1));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1);
            paint.setAntiAlias(true);
        }
        canvas.drawPath(path, paint);

        path.delete();
        paint.delete();
    }

    private makePreviewPath(tool: string, x: number, y: number, w: number, h: number) {
        const cx = x + w / 2;
        const cy = y + h / 2;
        // Match InputManager commit: addPolygon/addStar use Math.max(w, h) / 2.
        // min() made non-square drags preview smaller than the committed shape.
        const r = Math.max(w, h) / 2;
        const path = new this.ck.Path();

        if (tool === 'polygon') {
            const sides = 6;
            for (let i = 0; i < sides; i++) {
                const angle = (i * 2 * Math.PI) / sides - Math.PI / 2;
                const px = cx + r * Math.cos(angle);
                const py = cy + r * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        } else {
            const points = 5;
            const outerR = r;
            const innerR = r * 0.4;
            for (let i = 0; i < points * 2; i++) {
                const angle = (i * Math.PI) / points - Math.PI / 2;
                const cr = i % 2 === 0 ? outerR : innerR;
                const px = cx + cr * Math.cos(angle);
                const py = cy + cr * Math.sin(angle);
                if (i === 0) path.moveTo(px, py);
                else path.lineTo(px, py);
            }
            path.close();
        }
        return path;
    }

    /**
     * Smart measurements (Figma-style): with exactly one object selected and the
     * cursor hovering a different object, draw the clear-space gaps between the
     * two bounding boxes as pink lines with distance labels.
     */
    private drawMeasurements(canvas: Canvas, dpr: number) {
        const im = this.inputManager;
        if (!im) return;
        if (im.ui.activeTool !== 'selection' || im.editingNodeId != null) return;
        // Runs after the device-space overlay pass so the gap numbers/lines sit
        // ABOVE the resize handles — re-apply the camera transform to draw in world
        // space, then pop it.
        canvas.save();
        canvas.scale(dpr, dpr);
        canvas.translate(this.pan.x, this.pan.y);
        canvas.scale(this.zoom, this.zoom);
        this.drawMeasurementsInner(canvas, im);
        canvas.restore();
    }

    private drawMeasurementsInner(canvas: Canvas, im: InputManager): void {
        const paint = new this.ck.Paint();
        // Product align/spacing chrome — #FF6B35 (same as RCB SMART_GUIDE_COLOR).
        paint.setColor(this.ck.Color(255, 107, 53, 0.95));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        paint.setAntiAlias(true);
        const cap = 4 / this.zoom; // half-length of the end ticks

        // While dragging: show the live gap to the neighbours on each side (Figma
        // shows spacing throughout a drag, not only when it's equal). The equal-
        // spacing snap makes matching gaps line up on the same number.
        if (im.isMouseDown && im.dragMode === 'move') {
            const selIds = Array.from(this.scene.engine!.get_selection());
            let x0 = Infinity;
            let y0 = Infinity;
            let x1 = -Infinity;
            let y1 = -Infinity;
            for (const id of selIds) {
                const b = this.scene.getNodeBounds(id);
                if (!b || b.length < 4) continue;
                x0 = Math.min(x0, b[0]);
                y0 = Math.min(y0, b[1]);
                x1 = Math.max(x1, b[2]);
                y1 = Math.max(y1, b[3]);
            }
            if (Number.isFinite(x0)) {
                // On an axis that snapped to equal spacing, draw the MATCHED pair —
                // both the existing reference gap and the new one, so you see the
                // spacing you locked onto. On other axes, the live neighbour gap.
                const matches = im.equalSpacing ?? [];
                const matched = new Set(matches.map((m) => (m.axis === 'x' ? 'h' : 'v')));
                for (const m of matches) {
                    const draw = m.axis === 'x' ? 'h' : 'v';
                    for (const seg of m.segs) {
                        this.drawGap(canvas, paint, seg.a, seg.b, seg.pos, draw, cap);
                    }
                }
                for (const g of neighborGaps(this.scene, selIds, [x0, y0, x1, y1])) {
                    if (!matched.has(g.axis)) {
                        this.drawGap(canvas, paint, g.a, g.b, g.pos, g.axis, cap);
                    }
                }
            }
            paint.delete();
            return;
        }

        // Idle: measure the gap to the hovered object — but only while Alt is held
        // (Figma's deliberate measure gesture, not an always-on readout).
        const sel = this.scene.engine!.get_selection();
        if (
            !im.hoverAlt ||
            im.hoverNodeId == null ||
            sel.length !== 1 ||
            im.hoverNodeId === sel[0]
        ) {
            paint.delete();
            return;
        }
        const S = this.scene.getNodeBounds(sel[0]);
        const H = this.scene.getNodeBounds(im.hoverNodeId);
        if (!S || S.length < 4 || !H || H.length < 4) {
            paint.delete();
            return;
        }
        const [sx0, sy0, sx1, sy1] = S;
        const [hx0, hy0, hx1, hy1] = H;

        // Outline the object being measured to, so the numbers have an obvious
        // referent ("the gap between the selection and this one").
        const outline = new this.ck.Paint();
        outline.setColor(this.ck.Color(255, 107, 53, 0.9));
        outline.setStyle(this.ck.PaintStyle.Stroke);
        outline.setStrokeWidth(1.5 / this.zoom);
        outline.setAntiAlias(true);
        canvas.drawRect(this.ck.LTRBRect(hx0, hy0, hx1, hy1), outline);
        outline.delete();

        const selCx = (sx0 + sx1) / 2;
        const selCy = (sy0 + sy1) / 2;
        if (sx1 < hx0) this.drawGap(canvas, paint, sx1, hx0, selCy, 'h', cap);
        else if (hx1 < sx0) this.drawGap(canvas, paint, hx1, sx0, selCy, 'h', cap);
        if (sy1 < hy0) this.drawGap(canvas, paint, sy1, hy0, selCx, 'v', cap);
        else if (hy1 < sy0) this.drawGap(canvas, paint, hy1, sy0, selCx, 'v', cap);

        paint.delete();
    }

    /** One gap measurement: a line between `a`→`b` on `axis` at fixed `pos`,
     *  arrowheads, and a distance label centered on the segment (reference chrome). */
    private drawGap(
        canvas: Canvas,
        paint: Paint,
        a: number,
        b: number,
        pos: number,
        axis: 'h' | 'v',
        cap: number,
    ) {
        const dist = Math.abs(b - a);
        if (dist < 0.5) return;
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const tip = Math.max(cap, 4 / this.zoom);
        if (axis === 'h') {
            canvas.drawLine(lo, pos, hi, pos, paint);
            // Facing-edge rails (reference: solid verticals on the two box sides).
            const rail = Math.max(cap * 2.5, 10 / this.zoom);
            canvas.drawLine(lo, pos - rail, lo, pos + rail, paint);
            canvas.drawLine(hi, pos - rail, hi, pos + rail, paint);
            // Arrowheads pointing into the gap ends.
            canvas.drawLine(lo, pos, lo + tip, pos - tip, paint);
            canvas.drawLine(lo, pos, lo + tip, pos + tip, paint);
            canvas.drawLine(hi, pos, hi - tip, pos - tip, paint);
            canvas.drawLine(hi, pos, hi - tip, pos + tip, paint);
            this.drawMeasureLabel(canvas, (lo + hi) / 2, pos, `${Math.round(dist)}`);
        } else {
            canvas.drawLine(pos, lo, pos, hi, paint);
            const rail = Math.max(cap * 2.5, 10 / this.zoom);
            canvas.drawLine(pos - rail, lo, pos + rail, lo, paint);
            canvas.drawLine(pos - rail, hi, pos + rail, hi, paint);
            canvas.drawLine(pos, lo, pos - tip, lo + tip, paint);
            canvas.drawLine(pos, lo, pos + tip, lo + tip, paint);
            canvas.drawLine(pos, hi, pos - tip, hi - tip, paint);
            canvas.drawLine(pos, hi, pos + tip, hi - tip, paint);
            this.drawMeasureLabel(canvas, pos, (lo + hi) / 2, `${Math.round(dist)}`);
        }
    }

    /** Orange pill with white text at world (cx, cy), sized in screen pixels. */
    private drawMeasureLabel(canvas: Canvas, cx: number, cy: number, text: string) {
        const size = 11 / this.zoom;
        const font = new this.ck.Font(null, size);
        let w = 0;
        try {
            const widths = font.getGlyphWidths(font.getGlyphIDs(text));
            for (let i = 0; i < widths.length; i++) w += widths[i];
        } catch {
            w = text.length * size * 0.6;
        }
        const padX = 5 / this.zoom;
        const padY = 3 / this.zoom;
        const halfW = w / 2 + padX;
        const halfH = size * 0.62 + padY;

        const bg = new this.ck.Paint();
        // Product smart-guide orange (#FF6B35) — matches alignGuides SMART_GUIDE_COLOR.
        bg.setColor(this.ck.Color(255, 107, 53, 1.0));
        bg.setStyle(this.ck.PaintStyle.Fill);
        bg.setAntiAlias(true);
        const r = 4 / this.zoom;
        canvas.drawRRect(
            this.ck.RRectXY(this.ck.LTRBRect(cx - halfW, cy - halfH, cx + halfW, cy + halfH), r, r),
            bg,
        );

        const tp = new this.ck.Paint();
        tp.setColor(this.ck.Color(255, 255, 255, 1.0));
        tp.setAntiAlias(true);
        const blob = this.ck.TextBlob.MakeFromText(text, font);
        if (blob) {
            canvas.drawTextBlob(blob, cx - w / 2, cy + size * 0.35, tp);
            blob.delete();
        }
        bg.delete();
        tp.delete();
        font.delete();
    }

    /** Magenta alignment guides for active snaps, spanning the viewport. */
    /** Persistent ruler guides (cyan). The one under the cursor / being dragged
     *  is highlighted so it reads as grab-able. */
    private drawGuides(canvas: Canvas, minX: number, minY: number, maxX: number, maxY: number) {
        const guides = this.scene.getGuides();
        if (guides.x.length === 0 && guides.y.length === 0) return;
        const hi = this.inputManager?.highlightedGuide ?? null;
        const sel = this.inputManager?.selectedGuide ?? null;
        const guidesCtl = this.inputManager?.guides ?? null;

        const base = new this.ck.Paint();
        base.setColor(this.ck.Color(0, 200, 255, 0.7));
        base.setStyle(this.ck.PaintStyle.Stroke);
        base.setStrokeWidth(1 / this.zoom);
        base.setAntiAlias(true);

        const strong = new this.ck.Paint();
        strong.setColor(this.ck.Color(0, 200, 255, 1.0));
        strong.setStyle(this.ck.PaintStyle.Stroke);
        strong.setStrokeWidth(1.5 / this.zoom);
        strong.setAntiAlias(true);

        // Locked guides read as muted grey so they're visibly "fixed".
        const locked = new this.ck.Paint();
        locked.setColor(this.ck.Color(150, 150, 150, 0.9));
        locked.setStyle(this.ck.PaintStyle.Stroke);
        locked.setStrokeWidth(1 / this.zoom);
        locked.setAntiAlias(true);

        const paintFor = (axis: 'x' | 'y', i: number) => {
            const isSel = sel?.axis === axis && sel.index === i;
            const isHi = hi?.axis === axis && hi.index === i;
            if (guidesCtl?.isLocked({ axis, index: i })) return locked;
            return isSel || isHi ? strong : base;
        };
        guides.x.forEach((gx, i) => {
            canvas.drawLine(gx, minY, gx, maxY, paintFor('x', i));
        });
        guides.y.forEach((gy, i) => {
            canvas.drawLine(minX, gy, maxX, gy, paintFor('y', i));
        });
        base.delete();
        strong.delete();
        locked.delete();
    }

    /**
     * Active edge/center snap chrome (product reference):
     * orange span between *aligned pairs* of boxes, × marks at corners/edge mids —
     * never full-viewport rays, never a lone edge glued to one element's top/left.
     */
    private drawSnapGuides(canvas: Canvas, _minX: number, _minY: number, _maxX: number, _maxY: number) {
        const guides = this.inputManager?.activeSnapGuides;
        if (!guides || guides.length === 0) return;

        const paint = new this.ck.Paint();
        // #FF6B35 — same as RCB SMART_GUIDE_COLOR / spacing badges.
        paint.setColor(this.ck.Color(255, 107, 53, 0.95));
        paint.setStyle(this.ck.PaintStyle.Stroke);
        paint.setStrokeWidth(1 / this.zoom);
        paint.setAntiAlias(true);
        paint.setStrokeCap(this.ck.StrokeCap.Round);

        const eps = Math.max(0.5, 1 / this.zoom);
        const markArm = Math.max(3.5 / this.zoom, paint.getStrokeWidth() * 1.4);

        type Box = { x0: number; y0: number; x1: number; y1: number };
        const boxes: Box[] = [];
        const selSet = new Set<number>();
        try {
            for (const id of this.scene.engine!.get_selection()) selSet.add(id);
        } catch {
            /* ignore */
        }

        // Live selection union (moving box). Always first when present.
        let sx0 = Infinity,
            sy0 = Infinity,
            sx1 = -Infinity,
            sy1 = -Infinity;
        for (const id of selSet) {
            const b = this.scene.getMeasuredNodeBounds(id);
            if (!b || b.length < 4 || b[2] <= b[0] || b[3] <= b[1]) continue;
            sx0 = Math.min(sx0, b[0]);
            sy0 = Math.min(sy0, b[1]);
            sx1 = Math.max(sx1, b[2]);
            sy1 = Math.max(sy1, b[3]);
        }
        const hasSel = Number.isFinite(sx0);
        const selBox = hasSel ? { x0: sx0, y0: sy0, x1: sx1, y1: sy1 } : null;
        if (selBox) boxes.push(selBox);

        // Peer nodes + artboards (snap targets).
        try {
            const data = this.scene.getSceneData();
            for (const id of data.root_nodes || []) {
                const kitId = Number(id);
                if (!Number.isFinite(kitId) || selSet.has(kitId)) continue;
                const b = this.scene.getMeasuredNodeBounds(kitId);
                if (!b || b.length < 4 || b[2] <= b[0] || b[3] <= b[1]) continue;
                boxes.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3] });
            }
        } catch {
            /* ignore */
        }
        for (const ab of this.scene.getArtboards()) {
            boxes.push({ x0: ab.x, y0: ab.y, x1: ab.x + ab.w, y1: ab.y + ab.h });
        }

        const matchesAxis = (box: Box, axis: 'x' | 'y', pos: number): 'min' | 'mid' | 'max' | null => {
            if (axis === 'x') {
                const mid = (box.x0 + box.x1) / 2;
                if (Math.abs(box.x0 - pos) <= eps) return 'min';
                if (Math.abs(box.x1 - pos) <= eps) return 'max';
                if (Math.abs(mid - pos) <= eps) return 'mid';
                return null;
            }
            const mid = (box.y0 + box.y1) / 2;
            if (Math.abs(box.y0 - pos) <= eps) return 'min';
            if (Math.abs(box.y1 - pos) <= eps) return 'max';
            if (Math.abs(mid - pos) <= eps) return 'mid';
            return null;
        };

        const drawX = (x: number, y: number) => {
            canvas.drawLine(x - markArm, y - markArm, x + markArm, y + markArm, paint);
            canvas.drawLine(x - markArm, y + markArm, x + markArm, y - markArm, paint);
        };

        const drawMarks = (
            axis: 'x' | 'y',
            pos: number,
            items: Array<{ box: Box; role: 'min' | 'mid' | 'max' }>,
        ) => {
            for (const { box, role } of items) {
                if (axis === 'x') {
                    const midY = (box.y0 + box.y1) / 2;
                    if (role === 'mid') drawX(pos, midY);
                    else {
                        drawX(pos, box.y0);
                        drawX(pos, midY);
                        drawX(pos, box.y1);
                    }
                } else {
                    const midX = (box.x0 + box.x1) / 2;
                    if (role === 'mid') drawX(midX, pos);
                    else {
                        drawX(box.x0, pos);
                        drawX(midX, pos);
                        drawX(box.x1, pos);
                    }
                }
            }
        };

        const cursor =
            this.inputManager?.penHoverPos ?? this.inputManager?.currentPos ?? null;

        for (const g of guides) {
            const hit: Array<{ box: Box; role: 'min' | 'mid' | 'max' }> = [];
            for (const box of boxes) {
                const role = matchesAxis(box, g.axis, g.pos);
                if (role) hit.push({ box, role });
            }

            const peers = selBox ? hit.filter(({ box }) => box !== selBox) : hit;
            const includesSel = selBox ? hit.some(({ box }) => box === selBox) : false;
            // Need a real alignment pair: selection↔peer, or ≥2 peers.
            // A single box match used to paint that box's full edge — looked like
            // sticky top/left guides on the element. Empty hit used to paint the
            // whole viewport — product forbids that.
            const canSpan = (includesSel && peers.length >= 1) || peers.length >= 2;
            if (!canSpan) {
                if (cursor) {
                    if (g.axis === 'x') drawX(g.pos, cursor.y);
                    else drawX(cursor.x, g.pos);
                }
                continue;
            }

            const spanHit =
                includesSel && peers.length >= 1
                    ? hit
                    : peers;

            if (g.axis === 'x') {
                let from = Infinity;
                let to = -Infinity;
                for (const { box } of spanHit) {
                    from = Math.min(from, box.y0);
                    to = Math.max(to, box.y1);
                }
                if (Number.isFinite(from) && to > from) {
                    canvas.drawLine(g.pos, from, g.pos, to, paint);
                }
                drawMarks('x', g.pos, spanHit);
            } else {
                let from = Infinity;
                let to = -Infinity;
                for (const { box } of spanHit) {
                    from = Math.min(from, box.x0);
                    to = Math.max(to, box.x1);
                }
                if (Number.isFinite(from) && to > from) {
                    canvas.drawLine(from, g.pos, to, g.pos, paint);
                }
                drawMarks('y', g.pos, spanHit);
            }
        }

        paint.delete();
    }

    private drawMarquee(canvas: Canvas) {
        const marquee = this.inputManager?.marqueeRect;
        if (!marquee || marquee.w < 1 || marquee.h < 1) return;

        const { x, y, w, h } = marquee;
        const rect = this.ck.LTRBRect(x, y, x + w, y + h);

        const fillPaint = new this.ck.Paint();
        fillPaint.setColor(this.ck.Color(0, 120, 255, 0.08));
        fillPaint.setStyle(this.ck.PaintStyle.Fill);
        canvas.drawRect(rect, fillPaint);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 120, 255, 0.7));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(1 / this.zoom);
        canvas.drawRect(rect, strokePaint);

        fillPaint.delete();
        strokePaint.delete();
    }

    private drawPenPreview(canvas: Canvas) {
        if (this.inputManager?.ui?.activeTool !== 'pen' && !this.inputManager?.currentPathPoints?.length) {
            return;
        }

        const z = Math.max(0.05, this.zoom);
        // Screen-constant 1 CSS px, no AA — avoids “half pixel” fringe on hairlines.
        const hair = 1 / z;
        // Snap through pan so lines land on whole CSS pixels (pan is often fractional).
        const snapX = (v: number) => (Math.round(v * z + this.pan.x) - this.pan.x) / z;
        const snapY = (v: number) => (Math.round(v * z + this.pan.y) - this.pan.y) / z;

        // Continuation indicator: when the idle pen hovers a free endpoint of an
        // existing open path, ring it so the user knows a click would extend it.
        const adopt = this.inputManager?.penHoverAdopt;
        if (adopt) {
            const ap = new this.ck.Paint();
            ap.setColor(this.ck.Color(0, 162, 255, 1.0));
            ap.setStyle(this.ck.PaintStyle.Stroke);
            ap.setStrokeWidth(hair);
            ap.setAntiAlias(false);
            canvas.drawCircle(snapX(adopt.x), snapY(adopt.y), 6 / z, ap);
            ap.delete();
        }

        const points = this.inputManager?.currentPathPoints ?? [];
        const hover = this.inputManager?.penHoverPos;
        const closed = Boolean(this.inputManager?.penPathClosed);

        const strokePaint = new this.ck.Paint();
        strokePaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        strokePaint.setStyle(this.ck.PaintStyle.Stroke);
        strokePaint.setStrokeWidth(hair);
        strokePaint.setAntiAlias(false);
        strokePaint.setStrokeCap(this.ck.StrokeCap.Square);
        strokePaint.setStrokeJoin(this.ck.StrokeJoin.Miter);

        if (points.length >= 2) {
            const path = new this.ck.Path();
            path.moveTo(snapX(points[0].x), snapY(points[0].y));
            for (let i = 1; i < points.length; i++) {
                const prev = points[i - 1];
                const p = points[i];
                const straight =
                    Math.hypot(prev.cp2x - prev.x, prev.cp2y - prev.y) < 0.5 &&
                    Math.hypot(p.cp1x - p.x, p.cp1y - p.y) < 0.5;
                if (straight) {
                    path.lineTo(snapX(p.x), snapY(p.y));
                } else {
                    path.cubicTo(
                        snapX(prev.cp2x),
                        snapY(prev.cp2y),
                        snapX(p.cp1x),
                        snapY(p.cp1y),
                        snapX(p.x),
                        snapY(p.y),
                    );
                }
            }
            if (closed) {
                const last = points[points.length - 1];
                const first = points[0];
                const straight =
                    Math.hypot(last.cp2x - last.x, last.cp2y - last.y) < 0.5 &&
                    Math.hypot(first.cp1x - first.x, first.cp1y - first.y) < 0.5;
                if (straight) {
                    path.lineTo(snapX(first.x), snapY(first.y));
                } else {
                    path.cubicTo(
                        snapX(last.cp2x),
                        snapY(last.cp2y),
                        snapX(first.cp1x),
                        snapY(first.cp1y),
                        snapX(first.x),
                        snapY(first.y),
                    );
                }
            }
            canvas.drawPath(path, strokePaint);
            path.delete();
        }

        // Rubber-band + drop marker (fig.3): dashed preview to cursor, blue "+".
        if (hover && !closed) {
            if (points.length >= 1) {
                const last = points[points.length - 1];
                const rubberPaint = new this.ck.Paint();
                rubberPaint.setColor(this.ck.Color(90, 90, 90, 0.85));
                rubberPaint.setStyle(this.ck.PaintStyle.Stroke);
                rubberPaint.setStrokeWidth(hair);
                rubberPaint.setAntiAlias(false);
                rubberPaint.setStrokeCap(this.ck.StrokeCap.Square);
                const dash = this.ck.PathEffect.MakeDash([4 / z, 3 / z], 0);
                if (dash) rubberPaint.setPathEffect(dash);

                const closing = Boolean(this.inputManager?.penHoverClosing && points.length > 1);
                const tip = closing
                    ? { x: points[0].x, y: points[0].y }
                    : { x: hover.x, y: hover.y };
                const curved =
                    Math.hypot(last.cp2x - last.x, last.cp2y - last.y) > 0.5 || closing;
                if (curved) {
                    const rubber = new this.ck.Path();
                    rubber.moveTo(snapX(last.x), snapY(last.y));
                    if (closing) {
                        const first = points[0];
                        rubber.cubicTo(
                            snapX(last.cp2x),
                            snapY(last.cp2y),
                            snapX(first.cp1x),
                            snapY(first.cp1y),
                            snapX(first.x),
                            snapY(first.y),
                        );
                    } else {
                        rubber.cubicTo(
                            snapX(last.cp2x),
                            snapY(last.cp2y),
                            snapX(tip.x),
                            snapY(tip.y),
                            snapX(tip.x),
                            snapY(tip.y),
                        );
                    }
                    canvas.drawPath(rubber, rubberPaint);
                    rubber.delete();
                } else {
                    canvas.drawLine(
                        snapX(last.x),
                        snapY(last.y),
                        snapX(tip.x),
                        snapY(tip.y),
                        rubberPaint,
                    );
                }
                if (dash) {
                    rubberPaint.setPathEffect(null);
                    dash.delete();
                }
                rubberPaint.delete();
            }

            // Pre-drop "+" marker at the snapped hover (also before the first point).
            if (!this.inputManager?.penHoverClosing) {
                const mx = snapX(hover.x);
                const my = snapY(hover.y);
                const arm = 5 / z;
                const mark = new this.ck.Paint();
                mark.setColor(this.ck.Color(0, 162, 255, 1.0));
                mark.setStyle(this.ck.PaintStyle.Stroke);
                mark.setStrokeWidth(hair);
                mark.setAntiAlias(false);
                mark.setStrokeCap(this.ck.StrokeCap.Square);
                canvas.drawLine(mx - arm, my, mx + arm, my, mark);
                canvas.drawLine(mx, my - arm, mx, my + arm, mark);
                mark.delete();
            }
        }

        // Close indicator: a ring around the first anchor when a click would close.
        if (this.inputManager?.penHoverClosing && points.length > 1) {
            const first = points[0];
            const ringPaint = new this.ck.Paint();
            ringPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            ringPaint.setStyle(this.ck.PaintStyle.Stroke);
            ringPaint.setStrokeWidth(hair);
            ringPaint.setAntiAlias(false);
            canvas.drawCircle(snapX(first.x), snapY(first.y), 6 / z, ringPaint);
            ringPaint.delete();
        }

        if (!points.length) {
            strokePaint.delete();
            return;
        }

        const dotPaint = new this.ck.Paint();
        const handleLinePaint = new this.ck.Paint();
        handleLinePaint.setColor(this.ck.Color(150, 150, 150, 0.8));
        handleLinePaint.setStyle(this.ck.PaintStyle.Stroke);
        handleLinePaint.setStrokeWidth(hair);
        handleLinePaint.setAntiAlias(false);

        const handleDotPaint = new this.ck.Paint();
        handleDotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
        handleDotPaint.setStyle(this.ck.PaintStyle.Fill);
        handleDotPaint.setAntiAlias(false);

        // Mid-edge affordances on committed segments (N/E/S/W on a rect path).
        // AA on — AA-off strokeRect often collapses mid squares to a single line.
        const midHalf = Math.max(hair, 3 / z);
        const segCount = closed ? points.length : Math.max(0, points.length - 1);
        for (let i = 0; i < segCount; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % points.length];
            const mx = (p1.x + p2.x) * 0.5;
            const my = (p1.y + p2.y) * 0.5;
            dotPaint.setColor(this.ck.Color(255, 255, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Fill);
            dotPaint.setAntiAlias(true);
            canvas.drawRect(
                this.ck.LTRBRect(mx - midHalf, my - midHalf, mx + midHalf, my + midHalf),
                dotPaint,
            );
            dotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Stroke);
            dotPaint.setStrokeWidth(hair);
            canvas.drawRect(
                this.ck.LTRBRect(mx - midHalf, my - midHalf, mx + midHalf, my + midHalf),
                dotPaint,
            );
        }

        const dotSize = 4 / z;
        const handleSize = 3 / z;

        for (const p of points) {
            const hasCurve = Math.abs(p.cp1x - p.x) > 0.5 || Math.abs(p.cp1y - p.y) > 0.5;
            if (hasCurve) {
                canvas.drawLine(
                    snapX(p.x),
                    snapY(p.y),
                    snapX(p.cp1x),
                    snapY(p.cp1y),
                    handleLinePaint,
                );
                canvas.drawLine(
                    snapX(p.x),
                    snapY(p.y),
                    snapX(p.cp2x),
                    snapY(p.cp2y),
                    handleLinePaint,
                );
                canvas.drawCircle(snapX(p.cp1x), snapY(p.cp1y), handleSize, handleDotPaint);
                canvas.drawCircle(snapX(p.cp2x), snapY(p.cp2y), handleSize, handleDotPaint);
            }

            const ax = snapX(p.x);
            const ay = snapY(p.y);
            // Integer screen-px box so stroke sits on whole pixels.
            const half = Math.max(hair, Math.round(dotSize * z) / z);
            dotPaint.setColor(this.ck.Color(255, 255, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Fill);
            dotPaint.setAntiAlias(false);
            canvas.drawRect(
                this.ck.LTRBRect(ax - half, ay - half, ax + half, ay + half),
                dotPaint,
            );
            dotPaint.setColor(this.ck.Color(0, 162, 255, 1.0));
            dotPaint.setStyle(this.ck.PaintStyle.Stroke);
            dotPaint.setStrokeWidth(hair);
            canvas.drawRect(
                this.ck.LTRBRect(ax - half, ay - half, ax + half, ay + half),
                dotPaint,
            );
        }

        handleLinePaint.delete();
        handleDotPaint.delete();
        strokePaint.delete();
        dotPaint.delete();
    }

    /** Read a bézier outline from the render buffer (`[count][x,y,cp1x,cp1y,
     *  cp2x,cp2y]×N`) and build a CanvasKit path. Matches `write_outline_points`. */
    /** Read a face as its silhouette plus any islands, as ONE path.
     *
     *  v14 of the stream writes a ring count before the contours. The islands
     *  are holes: a region that encloses another used to be a plain closed path
     *  and painted straight over it, so the inner area could not be painted at
     *  all — it was there, and clicking picked it, but the region around it was
     *  drawn on top. Even-odd is used rather than trusting the rings to be wound
     *  oppositely, since the arrangement decides winding, not this reader. */
    private readFaceRingsPath(reader: BinaryReader): Path {
        const ringCount = reader.u32();
        const path = new this.ck.Path();
        for (let r = 0; r < ringCount; r++) {
            const ring = this.readOutlinePath(reader, true);
            path.addPath(ring);
            ring.delete();
        }
        path.setFillType(this.ck.FillType.EvenOdd);
        return path;
    }

    private readOutlinePath(reader: BinaryReader, closed: boolean): Path {
        const n = reader.u32();
        const pts: OutlinePt[] = [];
        for (let i = 0; i < n; i++) {
            pts.push({
                x: reader.f32(),
                y: reader.f32(),
                cp1: [reader.f32(), reader.f32()],
                cp2: [reader.f32(), reader.f32()],
            });
        }
        return this.pathFromOutline(pts, closed);
    }

    /** Reconstruct a CanvasKit path from an anchor+handles outline (the same
     *  cubic reconstruction the binary geometry reader uses). */
    private pathFromOutline(outline: OutlinePt[], closed: boolean): Path {
        const path = new this.ck.Path();
        if (!outline.length) return path;
        path.moveTo(outline[0].x, outline[0].y);
        for (let i = 0; i < outline.length - 1; i++) {
            const a = outline[i],
                b = outline[i + 1];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
        }
        if (closed && outline.length >= 2) {
            const a = outline[outline.length - 1],
                b = outline[0];
            path.cubicTo(a.cp2[0], a.cp2[1], b.cp1[0], b.cp1[1], b.x, b.y);
            path.close();
        }
        return path;
    }

    private drawPaintBucketHover(canvas: Canvas) {
        // Only while the Live Paint tool is armed — avoids a stale highlight
        // lingering after the user switches tools.
        if (this.inputManager?.ui?.activeTool !== 'paint-bucket') return;
        // The eyedropper reads the frame under the cursor, and this highlight is
        // painted over exactly that spot — sampling it would pick the hover blue.
        if (this._sampling) return;
        // Edge hover takes precedence — the cursor is over a line, not a region.
        if (this.hoverEdgeId >= 0 && this.scene.engine) {
            this.drawEdgeHover(canvas);
            return;
        }
        if (this.hoverFaceId < 0 || !this.scene.engine) return;
        try {
            const outline = JSON.parse(
                this.scene.engine.get_face_boundary(this.hoverFaceId),
            ) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, true);

            const paint = new this.ck.Paint();
            paint.setColor(this.ck.Color(66, 133, 244, 0.3));
            paint.setStyle(this.ck.PaintStyle.Fill);
            paint.setAntiAlias(true);
            canvas.drawPath(path, paint);

            paint.setColor(this.ck.Color(66, 133, 244, 0.8));
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeWidth(1.5 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }

    private drawEdgeHover(canvas: Canvas) {
        try {
            const outline = JSON.parse(
                this.scene.engine!.get_edge_polyline(this.hoverEdgeId),
            ) as OutlinePt[];
            if (!outline || outline.length < 2) return;
            const path = this.pathFromOutline(outline, false);

            const paint = new this.ck.Paint();
            paint.setStyle(this.ck.PaintStyle.Stroke);
            paint.setStrokeCap(this.ck.StrokeCap.Round);
            paint.setStrokeJoin(this.ck.StrokeJoin.Round);
            paint.setAntiAlias(true);
            paint.setColor(this.ck.Color(66, 133, 244, 0.9));
            paint.setStrokeWidth(4 / this.zoom);
            canvas.drawPath(path, paint);

            path.delete();
            paint.delete();
        } catch {}
    }
}
