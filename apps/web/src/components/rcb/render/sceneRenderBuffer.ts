/**
 * SceneRenderBuffer — SoA paint/pick sidecar (ADR 0027 Phase 3+).
 *
 * SceneDocument remains the authoring/collab source of truth. This buffer holds
 * contiguous typed arrays for lightweight geometry so Canvas can paint and
 * spatial pick without one SVG host per node.
 */
import {
  isFrameLocalCoordSpace,
  nodeLeftTop,
} from '@/components/rcb/scene/paint/sceneToSvg';
import { isNodeOverlayHidden } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  clampCornerRadii,
  getLiveCornerRadiusPreviewRadii,
  mergeLiveCornerRadiiIntoAttrs,
  pathPaintDFromAttrs,
  radiiFromAttrs,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  resolveStroke,
  resolveStrokeAlignForPaint,
  resolveStrokeLinecap,
  resolveStrokeLinejoin,
  resolveStrokeMiterlimit,
  strokeCanvasAligned,
  boolEffectAttr,
} from '@/components/rcb/scene/document/sceneEffects';
import { strokeDashForStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import {
  effectiveEllipseInnerRatioFromAttrs,
  ellipseArcPercentFromAttrs,
  ellipseInnerRatioFromAttrs,
  getLiveShapeParamsPreview,
  getLiveShapeParamsPreviewNodeId,
  HEAVY_PATH_D_CHARS,
  getCachedPath2D,
  invalidateNodePath2D,
  mergeLiveShapeParamsIntoAttrs,
  rememberNodePath2D,
  shapeVertexPoints,
  starInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
import { invalidateShapeMesh } from '@/components/rcb/render/vector/meshCache';
import { invalidateTextOutlineMesh } from '@/components/rcb/render/vector/textOutlineMesh';
import { pencilSilhouettePathD } from '@/components/rcb/render/vector/contour';
import {
  isRectLikeStrokeSidesShape,
  rectStrokeSideRuns,
  traceStrokeSideRun,
} from '@/components/rcb/render/vector/strokeSides';
import { parseNodeTextStyle } from '@/components/rcb/scene/document/sceneText';
import { getSoaTextInkPainter } from '@/components/rcb/render/soaTextInkPainter';
import { parseLayerOpacity } from '@/components/rcb/selection/chrome/BlendModeControl';
import { getShapeBaseline } from '@/components/rcb/core/geometry/baseline';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { getShapeHost } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  pathDLooksClosed,
  sampleSoaPathPolyline,
  SOA_PATH_CLOSED_MAX_PTS,
  SOA_PATH_MAX_PTS,
} from '@/components/rcb/render/soaPathSamples';
import {
  getNodeTransformPreview,
  hasNodeTransformPreviews,
  listNodeTransformPreviewIds,
} from '@/components/rcb/core/transformPreview';
import { hasLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import { SoaQuadtree, type SoaQuadItem } from '@/components/rcb/core/soaQuadtree';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import {
  frameClipRevealsOverflow,
  selectionPaintRaises,
} from '@/components/rcb/selection/selectionPaintRaise';
import { buildNodeStackZMap, maxDocumentStackZ } from '@/components/rcb/scene/document/sceneDocument';
import {
  isNodeAabbFullyOccludedByHigherArtboard,
} from '@/components/rcb/scene/document/sceneHitBridge';

export const SOA_FLAG_VISIBLE = 1 << 0;
export const SOA_FLAG_LOCKED = 1 << 1;
export const SOA_FLAG_DIRTY = 1 << 2;
/** Eligible for Canvas-only paint (no SVG host unless promoted). */
export const SOA_FLAG_CANVAS_IDLE = 1 << 3;
/** Geometry is SoA-basic (solid fill/roundRect/ellipse/line/path/poly + center stroke). */
export const SOA_FLAG_BASIC_GEOM = 1 << 4;
/** Tombstone slot awaiting reuse via freeSlots (skipped by paint/hit). */
export const SOA_FLAG_FREE = 1 << 5;
/**
 * Legacy atlas-stamp flag — shape ink no longer sets this (vector dual-backend).
 * Retained for buffer layout / prune of stale atlas keys only.
 */
export const SOA_FLAG_ATLAS_STAMP = 1 << 6;

export const SOA_KIND_RECT = 0;
export const SOA_KIND_ELLIPSE = 1;
export const SOA_KIND_LINE = 2;
export const SOA_KIND_PATH = 3;
export const SOA_KIND_IMAGE = 4;
export const SOA_KIND_POLY = 5;
/** Static text — WebGL MSDF glyphs (never media atlas stamp). */
export const SOA_KIND_TEXT = 6;
export const SOA_KIND_OTHER = 15;
/** Fallback line/path width when attrs omit border-width (matches prior Canvas/WebGL default). */
export const SOA_DEFAULT_STROKE_WIDTH = 2;

const GROW = 1024;
const POS_STRIDE = 4; // x, y, w, h
const RAD_STRIDE = 4; // tl, tr, br, bl

/** Last document seen by SoA paint — used when resolveSoaPaintBox omits `doc`. */
let soaPaintDocument: SceneDocument | null = null;

/** Keep SoA paint/hit frame-local aware during plate drag (live artboard geom). */
export function setSoaPaintDocument(doc: SceneDocument | null | undefined): void {
  soaPaintDocument = doc ?? null;
}

/** Last document passed to SoA paint (WebGL clip / frame-local resolve). */
export function getSoaPaintDocument(): SceneDocument | null {
  return soaPaintDocument;
}

/** Normalize shapeType / key into a lowercase token (no nested ternary). */
function shapeTypeToken(node: SceneNodeInput): string {
  const key = String(node.key || '');
  let fallback = key;
  if (key === 'shape') fallback = 'rect';
  const raw = node.attrs?.shapeType || fallback || '';
  return String(raw).toLowerCase();
}

/** Lightweight SoA slot eligibility — vectors + static image/video/audio/text. */
export function isSoaCanvasEligible(node: SceneNodeInput | null | undefined): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  // Lottie/group stay DOM. Static image/video/audio → textured mesh; text is MSDF.
  if (key === 'lottie' || key === 'group') return false;
  if (key === 'text' || key === 'image' || key === 'video' || key === 'audio') return true;
  const t = shapeTypeToken(node);
  if (t === 'rect' || t === 'roundrect' || t === '' || key === 'shape') return true;
  if (t === 'circle' || t === 'ellipse' || t === 'oval') return true;
  if (t === 'line' || t === 'arrow') return true;
  if (t === 'pen' || t === 'pencil' || t === 'path' || key === 'path') return true;
  // Poly/star stay eligible for buffer/spatial, but never BASIC_GEOM (rich idle / SVG).
  if (t === 'triangle' || t === 'polygon' || t === 'star') return true;
  return false;
}

function isTransparentCssColor(c: string): boolean {
  const s = String(c || '')
    .trim()
    .toLowerCase();
  return !s || s === 'none' || s === 'transparent' || s === 'rgba(0,0,0,0)';
}

function pathAttrsHaveSolidFill(attrs: Record<string, unknown>): boolean {
  if (!boolEffectAttr(attrs['fill-enabled'], true)) return false;
  if (!boolEffectAttr(attrs['fill-visible'], true)) return false;
  const fill = attrs['fill-color'];
  return !isTransparentCssColor(String(fill || ''));
}

function isStrokeInkShapeType(t: string, key: string, customPath: string): boolean {
  return (
    t === 'line' ||
    t === 'arrow' ||
    t === 'pen' ||
    t === 'pencil' ||
    t === 'path' ||
    key === 'path' ||
    Boolean(customPath)
  );
}

/**
 * True when a node can be Canvas-baked into a WebGL atlas cell (closed fills,
 * rich fills, light paths). Independent of BASIC_GEOM — Vitest keeps closed
 * shapes BASIC for Canvas2D idle while product WebGL still bakes them.
 */
export function isSoaAtlasBakeEligible(node: SceneNodeInput | null | undefined): boolean {
  if (!node || !isSoaCanvasEligible(node)) return false;
  const key = String(node.key || '');
  if (key === 'text' || key === 'image' || key === 'video' || key === 'audio') return false;
  const attrs = node.attrs || {};
  const t = shapeTypeToken(node);
  if (attrs.flipX === true || attrs.flipX === 'true') return false;
  if (attrs.flipY === true || attrs.flipY === 'true') return false;

  const fillType = String(attrs['fill-type'] || 'solid').toLowerCase();
  const richFill =
    fillType === 'linear' ||
    fillType === 'radial' ||
    fillType === 'angular' ||
    fillType === 'image' ||
    fillType === 'diffuse';
  const solidish = !fillType || fillType === 'solid';
  if (!richFill && !solidish) return false;

  const customPath = String(attrs.path || '').trim();
  const pathLike =
    t === 'pen' || t === 'pencil' || t === 'path' || key === 'path' || Boolean(customPath);

  if (
    t === 'triangle' ||
    t === 'polygon' ||
    t === 'star' ||
    t === 'rect' ||
    t === 'roundrect' ||
    t === '' ||
    key === 'shape' ||
    t === 'circle' ||
    t === 'ellipse' ||
    t === 'oval'
  ) {
    return true;
  }

  // Open line/arrow: Canvas bake → atlas (same AA path as pencil).
  if (t === 'line' || t === 'arrow') return true;

  if (pathLike) {
    if (!customPath || customPath.length >= HEAVY_PATH_D_CHARS) return false;
    return true;
  }
  return false;
}

/**
 * True when SoA BASIC_GEOM can draw the node on the product WebGL / Canvas2D
 * vector path (fill+stroke meshes or Path2D — never shape atlas bake).
 */
export function isSoaBasicGeomSufficient(node: SceneNodeInput | null | undefined): boolean {
  if (!node || !isSoaCanvasEligible(node)) return false;
  const attrs = node.attrs || {};
  if (attrs.flipX === true || attrs.flipX === 'true') return false;
  if (attrs.flipY === true || attrs.flipY === 'true') return false;

  const fillType = String(attrs['fill-type'] || 'solid').toLowerCase();
  if (fillType && fillType !== 'solid' && fillType !== '') return false;

  const key = String(node.key || '');
  const t = shapeTypeToken(node);
  const customPath = String(attrs.path || '').trim();
  const strokeInk = isStrokeInkShapeType(t, key, customPath);

  // Rotated fills stay off basic SoA; stroke ink keeps angle for pick after demote.
  if (!strokeInk && Math.abs(Number(attrs.angle) || 0) > 0.5) return false;

  // Line / arrow / pencil: vector stroke mesh (not atlas).
  if (t === 'line' || t === 'arrow' || t === 'pencil') return true;

  // Closed shapes: vector fill+stroke on both WebGL and Canvas2D.
  // Donut / partial-arc ellipses use the same mesh path as solid disks
  // (getOrBuildShapeMesh + holes). Keeping them off BASIC used to drop
  // CANVAS_IDLE in applySoaHostInkFlags → empty selection box after IR commit.
  const closedFill =
    t === 'triangle' ||
    t === 'polygon' ||
    t === 'star' ||
    t === 'rect' ||
    t === 'roundrect' ||
    t === '' ||
    t === 'circle' ||
    t === 'ellipse' ||
    t === 'oval';
  if (closedFill) {
    return true;
  }

  if (t === 'pen' || t === 'path' || key === 'path' || customPath) {
    const d = customPath;
    if (!d || d.length >= HEAVY_PATH_D_CHARS) return false;
    return true;
  }
  return false;
}

export type SceneRenderBuffer = {
  capacity: number;
  count: number;
  /** [x,y,w,h] * capacity */
  positions: Float32Array;
  /** [tl,tr,br,bl] * capacity — scene units; 0 = sharp */
  radii: Float32Array;
  colors: Uint32Array;
  flags: Uint32Array;
  /** Low 8 bits unused; kind in bits 8–11 via helpers. */
  kinds: Uint8Array;
  /** Per-slot stroke width in scene units (line/path/outline). 0 = unused. */
  strokeWidths: Float32Array;
  /** Outline stroke ARGB for rect/ellipse/poly (0 = no outline). Line/path ink uses `colors`. */
  strokeColors: Uint32Array;
  ids: string[];
  indexById: Map<string, number>;
  /** Generation bumped on any structural sync. */
  revision: number;
  /** Per-slot start point index into pathXY (−1 = no samples). */
  pathStart: Int32Array;
  /** Per-slot vertex count. */
  pathLen: Uint16Array;
  /** 1 = closed (may fill). */
  pathClosed: Uint8Array;
  /** Shared world-space samples [x,y,x,y,…]. */
  pathXY: Float32Array;
  /** Number of floats currently used in pathXY. */
  pathXYCount: number;
  /**
   * World-AABB quadtree for visible SoA slots (cull / hit broad-phase).
   * Derived cache only — never writes back to SceneDocument.
   */
  quadtree: SoaQuadtree;
  /**
   * Recycled slot indices (tombstones). Prefer {@link allocateSoaSlot}; dense
   * single deletes still use swap-pop and leave this empty.
   */
  freeSlots: number[];
};

/** Test-only override; `null` = use env / Vitest defaults. */
let soaCanvasShapesOverride: boolean | null = null;

/** Force SoA canvas shapes on/off in unit tests and benches (`null` clears). */
export function setSoaCanvasShapesEnabledForTests(value: boolean | null) {
  soaCanvasShapesOverride = value;
}

/** SoA canvas shapes — product always on. Vitest off unless test override. */
export function isSoaCanvasShapesEnabled(): boolean {
  if (soaCanvasShapesOverride != null) return soaCanvasShapesOverride;
  try {
    if (import.meta.env.MODE === 'test' || import.meta.env.VITEST) return false;
    return true;
  } catch {
    return true;
  }
}

/** Test override for {@link isSoaWebglEnvEnabled} (`null` = env default). */
let soaWebglEnvOverride: boolean | null = null;

/** Vitest: force product WebGL eligibility (closed shapes → atlas, not BASIC). */
export function setSoaWebglEnvEnabledForTests(enabled: boolean | null) {
  soaWebglEnvOverride = enabled;
}

/** WebGL ink — product always on. Vitest off so Canvas2D paint helpers stay testable. */
export function isSoaWebglEnvEnabled(): boolean {
  if (soaWebglEnvOverride != null) return soaWebglEnvOverride;
  try {
    if (import.meta.env.MODE === 'test' || import.meta.env.VITEST) return false;
    return true;
  } catch {
    return true;
  }
}

/** Line/path stroke width stored in the SoA buffer (scene units). */
export function soaStrokeWidth(buf: SceneRenderBuffer, index: number): number {
  const w = buf.strokeWidths[index];
  if (Number.isFinite(w) && w > 0) return w;
  return SOA_DEFAULT_STROKE_WIDTH;
}

function strokeDashFromAttrs(
  attrs: Record<string, unknown> | null | undefined
): string | undefined {
  if (!attrs) return undefined;
  return (
    strokeDashForStyle(attrs.strokeStyle) ||
    String(attrs.strokeDasharray || attrs.dasharray || '').trim() ||
    undefined
  );
}

/**
 * Paint T/R/B/L partial rect edges (local space). Returns true when caller
 * must skip the closed-path stroke (including "all sides off").
 */
function strokeCanvasPartialRectSides(
  ctx: CanvasRenderingContext2D,
  opts: {
    width: number;
    height: number;
    attrs: Record<string, unknown> | null | undefined;
    radii: { tl: number; tr: number; br: number; bl: number };
    stroke: string;
    strokeWidth: number;
    dasharray?: string;
  }
): boolean {
  const runs = rectStrokeSideRuns(opts.width, opts.height, opts.attrs, opts.radii);
  if (runs == null) return false;
  for (const run of runs) {
    if (run.length < 2) continue;
    strokeCanvasAligned(ctx, {
      align: 'center',
      stroke: opts.stroke,
      strokeWidth: opts.strokeWidth,
      dasharray: opts.dasharray,
      trace: () => traceStrokeSideRun(ctx, run),
    });
  }
  return true;
}

function slotStrokeWidth(node: SceneNodeInput, kind: number): number {
  if (kind === SOA_KIND_LINE || kind === SOA_KIND_PATH) {
    const { strokeWidth } = resolveStroke(node, '#333333');
    if (Number.isFinite(strokeWidth) && strokeWidth > 0) return strokeWidth;
    return SOA_DEFAULT_STROKE_WIDTH;
  }
  if (kind === SOA_KIND_RECT || kind === SOA_KIND_ELLIPSE || kind === SOA_KIND_POLY) {
    const { stroke, strokeWidth } = resolveStroke(node);
    if (!(strokeWidth > 0) || isTransparentCssColor(String(stroke || ''))) return 0;
    return strokeWidth;
  }
  return 0;
}

function slotOutlineStrokeColor(node: SceneNodeInput, kind: number): number {
  // PATH: stroke lives here so closed unfilled pens stay stroke-only (colors=0).
  if (kind === SOA_KIND_PATH) {
    const { stroke, strokeWidth } = resolveStroke(node, '#333333');
    if (!(strokeWidth > 0) || isTransparentCssColor(String(stroke || ''))) return 0;
    return packCssColor(stroke, 0xff333333);
  }
  if (kind !== SOA_KIND_RECT && kind !== SOA_KIND_ELLIPSE && kind !== SOA_KIND_POLY) return 0;
  const { stroke, strokeWidth } = resolveStroke(node);
  if (!(strokeWidth > 0) || isTransparentCssColor(String(stroke || ''))) return 0;
  return packCssColor(stroke, 0xff333333);
}

export function createSceneRenderBuffer(initialCapacity = GROW): SceneRenderBuffer {
  const capacity = Math.max(GROW, initialCapacity);
  return {
    capacity,
    count: 0,
    positions: new Float32Array(capacity * POS_STRIDE),
    radii: new Float32Array(capacity * RAD_STRIDE),
    colors: new Uint32Array(capacity),
    flags: new Uint32Array(capacity),
    kinds: new Uint8Array(capacity),
    strokeWidths: new Float32Array(capacity),
    strokeColors: new Uint32Array(capacity),
    ids: new Array(capacity),
    indexById: new Map(),
    revision: 0,
    pathStart: new Int32Array(capacity).fill(-1),
    pathLen: new Uint16Array(capacity),
    pathClosed: new Uint8Array(capacity),
    pathXY: new Float32Array(0),
    pathXYCount: 0,
    quadtree: new SoaQuadtree(),
    freeSlots: [],
  };
}

/**
 * Sync one slot into the buffer quadtree — only CANVAS_IDLE visible ink.
 * Promote removes the id; demote re-inserts (SoA-only spatial sidecar).
 */
function syncQuadSlot(buf: SceneRenderBuffer, index: number): void {
  const id = buf.ids[index];
  if (!id) return;
  const flags = buf.flags[index];
  if (
    (flags & SOA_FLAG_FREE) !== 0 ||
    (flags & SOA_FLAG_VISIBLE) === 0 ||
    (flags & SOA_FLAG_CANVAS_IDLE) === 0
  ) {
    buf.quadtree.remove(id);
    return;
  }
  const o = index * POS_STRIDE;
  const box = aabbFromBox(
    buf.positions[o],
    buf.positions[o + 1],
    buf.positions[o + 2],
    buf.positions[o + 3]
  );
  // Restamp + dirty — avoid per-slot upsert rebuilds during paste / idle paint.
  buf.quadtree.restamp({ id, ...box });
}

function soaSlotQuadItem(
  buf: SceneRenderBuffer,
  index: number
): { id: string; minX: number; minY: number; maxX: number; maxY: number } | null {
  if (index < 0 || index >= buf.count) return null;
  if (buf.flags[index] & SOA_FLAG_FREE) return null;
  const id = buf.ids[index];
  if (!id) return null;
  const o = index * POS_STRIDE;
  return { id, ...aabbFromBox(buf.positions[o], buf.positions[o + 1], buf.positions[o + 2], buf.positions[o + 3]) };
}

/** Upsert many world AABBs into the buffer quadtree in one pass (bulk demote / full sync). */
export function bulkUpsertSoaQuadtree(
  buf: SceneRenderBuffer,
  ids?: readonly string[]
): number {
  // Single-id demote: cheap in-place upsert. Multi-id: restamp + dirty; compact only past threshold.
  if (ids && ids.length === 1) {
    const i = buf.indexById.get(String(ids[0] || ''));
    if (i == null) return 0;
    syncQuadSlot(buf, i);
    return 1;
  }

  if (ids && ids.length > 1) {
    const items: Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }> = [];
    for (const raw of ids) {
      const i = buf.indexById.get(String(raw || ''));
      if (i == null) continue;
      const item = soaSlotQuadItem(buf, i);
      if (!item) continue;
      items.push(item);
    }
    buf.quadtree.bulkUpsert(items);
    return items.length;
  }

  const items: Array<{ id: string; minX: number; minY: number; maxX: number; maxY: number }> = [];
  for (let i = 0; i < buf.count; i += 1) {
    const item = soaSlotQuadItem(buf, i);
    if (!item) continue;
    items.push(item);
  }
  buf.quadtree.replaceAll(items);
  return items.length;
}

/** Allocate a slot index — reuse freeSlots first, else append (O(1)). */
export function allocateSoaSlot(buf: SceneRenderBuffer): number {
  while (buf.freeSlots.length > 0) {
    const i = buf.freeSlots.pop()!;
    if (i < 0 || i >= buf.count) continue;
    if (!(buf.flags[i] & SOA_FLAG_FREE) && buf.ids[i]) continue;
    buf.flags[i] = SOA_FLAG_FREE;
    return i;
  }
  ensureCapacity(buf, buf.count + 1);
  const index = buf.count;
  buf.count += 1;
  buf.flags[index] = SOA_FLAG_FREE;
  buf.ids[index] = undefined as unknown as string;
  buf.pathStart[index] = -1;
  buf.pathLen[index] = 0;
  buf.pathClosed[index] = 0;
  return index;
}

function ensureCapacity(buf: SceneRenderBuffer, need: number) {
  if (need <= buf.capacity) return;
  let next = buf.capacity;
  while (next < need) next += GROW;
  reallocSlotArrays(buf, next);
}

/** Drop excess slot capacity after a full rebuild (grow-only otherwise). */
function shrinkCapacityIfLoose(buf: SceneRenderBuffer) {
  const want = Math.max(GROW, Math.ceil(Math.max(buf.count, 1) / GROW) * GROW);
  if (buf.capacity <= want) return;
  // Keep up to 2× live need (or +1 GROW). Anything larger is peak residue.
  const keep = Math.max(want * 2, want + GROW);
  if (buf.capacity <= keep) return;
  reallocSlotArrays(buf, want);
}

function copyTypedPrefix<T extends { length: number; subarray: (b: number, e: number) => T }>(
  dst: { set: (src: T) => void },
  src: T,
  n: number
) {
  if (n <= 0) return;
  dst.set(src.subarray(0, Math.min(src.length, n)));
}

function reallocSlotArrays(buf: SceneRenderBuffer, next: number) {
  const positions = new Float32Array(next * POS_STRIDE);
  copyTypedPrefix(positions, buf.positions, next * POS_STRIDE);
  const radii = new Float32Array(next * RAD_STRIDE);
  copyTypedPrefix(radii, buf.radii, next * RAD_STRIDE);
  const colors = new Uint32Array(next);
  copyTypedPrefix(colors, buf.colors, next);
  const flags = new Uint32Array(next);
  copyTypedPrefix(flags, buf.flags, next);
  const kinds = new Uint8Array(next);
  copyTypedPrefix(kinds, buf.kinds, next);
  const strokeWidths = new Float32Array(next);
  copyTypedPrefix(strokeWidths, buf.strokeWidths, next);
  const strokeColors = new Uint32Array(next);
  copyTypedPrefix(strokeColors, buf.strokeColors, next);
  const ids = new Array(next);
  const copyIds = Math.min(buf.count, next);
  for (let i = 0; i < copyIds; i += 1) ids[i] = buf.ids[i];
  const pathStart = new Int32Array(next).fill(-1);
  copyTypedPrefix(pathStart, buf.pathStart, next);
  const pathLen = new Uint16Array(next);
  copyTypedPrefix(pathLen, buf.pathLen, next);
  const pathClosed = new Uint8Array(next);
  copyTypedPrefix(pathClosed, buf.pathClosed, next);
  buf.capacity = next;
  buf.positions = positions;
  buf.radii = radii;
  buf.colors = colors;
  buf.flags = flags;
  buf.kinds = kinds;
  buf.strokeWidths = strokeWidths;
  buf.strokeColors = strokeColors;
  buf.ids = ids;
  buf.pathStart = pathStart;
  buf.pathLen = pathLen;
  buf.pathClosed = pathClosed;
}

function ensurePathXYCapacity(buf: SceneRenderBuffer, floatNeed: number) {
  if (floatNeed <= buf.pathXY.length) return;
  let next = Math.max(256, buf.pathXY.length || 256);
  while (next < floatNeed) next *= 2;
  const xy = new Float32Array(next);
  if (buf.pathXYCount > 0) xy.set(buf.pathXY.subarray(0, buf.pathXYCount));
  buf.pathXY = xy;
}

/** Compact pathXY after densify when the backing store is far above use. */
function shrinkPathXYIfLoose(buf: SceneRenderBuffer) {
  const used = Math.max(0, buf.pathXYCount);
  let want = 256;
  while (want < used) want *= 2;
  if (buf.pathXY.length <= want * 2) return;
  const xy = new Float32Array(want);
  if (used > 0) xy.set(buf.pathXY.subarray(0, used));
  buf.pathXY = xy;
}

/** Pack #RRGGBB or #RRGGBBAA (approx) into opaque ARGB uint32. */
export function packCssColor(raw: unknown, fallback = 0xff808080): number {
  const s = String(raw || '').trim();
  if (isTransparentCssColor(s)) return 0;
  if (!s) return fallback;
  const hex = s.startsWith('#') ? s.slice(1) : '';
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const rgb = parseInt(hex, 16) >>> 0;
    return (0xff000000 | rgb) >>> 0;
  }
  if (/^[0-9a-fA-F]{8}$/.test(hex)) {
    // RRGGBBAA → ARGB
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = parseInt(hex.slice(6, 8), 16);
    return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return (0xff000000 | (r << 16) | (g << 8) | b) >>> 0;
  }
  return fallback;
}

export function unpackCssColor(argb: number): string {
  const a = (argb >>> 24) & 0xff;
  const r = (argb >>> 16) & 0xff;
  const g = (argb >>> 8) & 0xff;
  const b = argb & 0xff;
  if (a >= 255) {
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  }
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

function shapeKindOf(node: SceneNodeInput): number {
  const key = String(node.key || '');
  if (key === 'text') return SOA_KIND_TEXT;
  if (key === 'image' || key === 'video' || key === 'audio') return SOA_KIND_IMAGE;
  const t = shapeTypeToken(node);
  // Boolean / outline silhouettes keep a stored `path` — never solid RECT ink/hit.
  const customPath = String(node.attrs?.path || '').trim();
  if (customPath && t !== 'line' && t !== 'arrow') return SOA_KIND_PATH;
  if (t === 'circle' || t === 'ellipse' || t === 'oval') return SOA_KIND_ELLIPSE;
  if (t === 'line' || t === 'arrow') return SOA_KIND_LINE;
  if (t === 'pen' || t === 'pencil' || t === 'path' || key === 'path') return SOA_KIND_PATH;
  if (t === 'triangle' || t === 'polygon' || t === 'star') return SOA_KIND_POLY;
  if (t === 'rect' || t === 'roundrect' || t === '' || key === 'shape') return SOA_KIND_RECT;
  return SOA_KIND_OTHER;
}

function fillColorOf(node: SceneNodeInput): number {
  const attrs = node.attrs || {};
  if (shapeKindOf(node) === SOA_KIND_TEXT) {
    const style = parseNodeTextStyle(attrs);
    return packCssColor(style.fill ?? attrs.fill ?? attrs['fill-color'], 0xff333333);
  }
  return packCssColor(attrs['fill-color'], 0xffc0c0c0);
}

/**
 * Slot fill color. For PATH: only closed + solid fill (0 = stroke-only —
 * paint must not fill with the stroke color when fill is transparent).
 */
function slotColorOf(node: SceneNodeInput): number {
  const kind = shapeKindOf(node);
  const attrs = node.attrs || {};
  if (kind === SOA_KIND_LINE) {
    const { stroke } = resolveStroke(node, '#333333');
    return packCssColor(stroke, 0xff333333);
  }
  if (kind === SOA_KIND_PATH) {
    const d = String(attrs.path || '');
    const closed = pathDLooksClosed(d, attrs.closed);
    if (closed && pathAttrsHaveSolidFill(attrs)) {
      return packCssColor(attrs['fill-color'], 0xffc0c0c0);
    }
    return 0;
  }
  return fillColorOf(node);
}

function writeSlot(
  buf: SceneRenderBuffer,
  index: number,
  id: string,
  node: SceneNodeInput,
  document: SceneDocument | null | undefined,
  opts?: { skipQuad?: boolean }
) {
  const { left, top } = nodeLeftTop(document, node);
  const o = index * POS_STRIDE;
  buf.positions[o] = Number(left) || 0;
  buf.positions[o + 1] = Number(top) || 0;
  buf.positions[o + 2] = Math.max(0.01, Number(node.width) || 1);
  buf.positions[o + 3] = Math.max(0.01, Number(node.height) || 1);
  const w = buf.positions[o + 2];
  const h = buf.positions[o + 3];
  const kind = shapeKindOf(node) & 0xff;
  const ro = index * RAD_STRIDE;
  if (kind === SOA_KIND_RECT) {
    const r = clampCornerRadii(radiiFromAttrs(node.attrs || {}), w, h);
    buf.radii[ro] = r.tl;
    buf.radii[ro + 1] = r.tr;
    buf.radii[ro + 2] = r.br;
    buf.radii[ro + 3] = r.bl;
  } else {
    buf.radii[ro] = 0;
    buf.radii[ro + 1] = 0;
    buf.radii[ro + 2] = 0;
    buf.radii[ro + 3] = 0;
  }
  buf.colors[index] = slotColorOf(node);
  buf.kinds[index] = kind;
  buf.strokeWidths[index] = slotStrokeWidth(node, kind);
  buf.strokeColors[index] = slotOutlineStrokeColor(node, kind) >>> 0;
  let flags = SOA_FLAG_DIRTY;
  if (!isNodeOverlayHidden(document, node)) flags |= SOA_FLAG_VISIBLE;
  if (node.attrs?.locked) flags |= SOA_FLAG_LOCKED;
  // BASIC_GEOM → SoA vector ink (WebGL mesh / Canvas2D Path2D). Media keeps
  // CANVAS_IDLE without BASIC (GPU texture). Text is outline mesh (still no BASIC).
  if (isSoaBasicGeomSufficient(node)) {
    flags |= SOA_FLAG_BASIC_GEOM | SOA_FLAG_CANVAS_IDLE;
  } else if (kind === SOA_KIND_IMAGE || kind === SOA_KIND_TEXT) {
    flags |= SOA_FLAG_CANVAS_IDLE;
  } else if (isSoaAtlasBakeEligible(node)) {
    // Gradient / donut / etc.: Canvas2D Path2D idle — never ATLAS_STAMP.
    flags |= SOA_FLAG_CANVAS_IDLE;
  }
  buf.flags[index] = flags >>> 0;
  buf.ids[index] = id;
  buf.indexById.set(id, index);
  buf.pathStart[index] = -1;
  buf.pathLen[index] = 0;
  // Closed before path samples rebuild — WebGL fill stamp must not see a false open.
  if (kind === SOA_KIND_PATH) {
    const d = String(node.attrs?.path || '');
    buf.pathClosed[index] = pathDLooksClosed(d, node.attrs?.closed) ? 1 : 0;
  } else {
    buf.pathClosed[index] = 0;
  }
  // Geometry wrote — drop vector caches so next paint rebuilds fill/stroke meshes.
  invalidateShapeMesh(id);
  invalidateNodePath2D(id);
  if (kind === SOA_KIND_TEXT) invalidateTextOutlineMesh(id);
  if (!opts?.skipQuad) syncQuadSlot(buf, index);
}

/**
 * Rebuild world-space path / poly polylines after slot sync.
 * Call after full or incremental document sync.
 * Pass `onlyIds` to resample a subset (keeps other path/poly samples) —
 * full rebuild when omitted (import / membership change).
 */
export function rebuildSoaPathSamples(
  buf: SceneRenderBuffer,
  document: SceneDocument | null | undefined,
  opts?: { onlyIds?: readonly string[] }
) {
  const only =
    opts?.onlyIds && opts.onlyIds.length > 0
      ? new Set(opts.onlyIds.map(String).filter(Boolean))
      : null;

  // Paste of rect/ellipse only: skip path densify + pathXY rewrite entirely.
  if (only) {
    let touchPathLike = false;
    for (const id of only) {
      const i = buf.indexById.get(id);
      if (i == null) continue;
      const kind = buf.kinds[i];
      if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY || kind === SOA_KIND_LINE) {
        touchPathLike = true;
        break;
      }
    }
    if (!touchPathLike) return;
  }

  type Pending = {
    index: number;
    pts: Array<{ x: number; y: number }>;
    closed: boolean;
  };
  const pending: Pending[] = [];
  let floatNeed = 0;

  // Preserve untouched path/poly/line samples when doing a partial rebuild.
  if (only) {
    for (let i = 0; i < buf.count; i += 1) {
      const kind = buf.kinds[i];
      if (kind !== SOA_KIND_PATH && kind !== SOA_KIND_POLY && kind !== SOA_KIND_LINE) continue;
      const id = buf.ids[i];
      if (!id || only.has(id)) continue;
      const start = buf.pathStart[i];
      const len = buf.pathLen[i];
      if (start < 0 || len < 2) continue;
      const pts: Array<{ x: number; y: number }> = [];
      const base = start * 2;
      for (let p = 0; p < len; p += 1) {
        pts.push({ x: buf.pathXY[base + p * 2], y: buf.pathXY[base + p * 2 + 1] });
      }
      pending.push({ index: i, pts, closed: buf.pathClosed[i] !== 0 });
      floatNeed += pts.length * 2;
    }
  }

  for (let i = 0; i < buf.count; i += 1) {
    buf.pathStart[i] = -1;
    buf.pathLen[i] = 0;
    buf.pathClosed[i] = 0;
  }
  buf.pathXYCount = 0;
  if (!document?.deltaSetLike) {
    if (pending.length) {
      ensurePathXYCapacity(buf, floatNeed);
      let cursor = 0;
      for (const item of pending) {
        const pointStart = cursor >> 1;
        for (const p of item.pts) {
          buf.pathXY[cursor] = p.x;
          buf.pathXY[cursor + 1] = p.y;
          cursor += 2;
        }
        buf.pathStart[item.index] = pointStart;
        buf.pathLen[item.index] = item.pts.length;
        buf.pathClosed[item.index] = item.closed ? 1 : 0;
      }
      buf.pathXYCount = cursor;
    }
    shrinkPathXYIfLoose(buf);
    for (const item of pending) {
      buf.flags[item.index] = (buf.flags[item.index] | SOA_FLAG_DIRTY) >>> 0;
    }
    return;
  }

  for (let i = 0; i < buf.count; i += 1) {
    const kind = buf.kinds[i];
    const id = buf.ids[i];
    if (!id) continue;
    if (kind !== SOA_KIND_PATH && kind !== SOA_KIND_POLY && kind !== SOA_KIND_LINE) continue;
    if (only && !only.has(id)) continue;
    const node = document.deltaSetLike[id];
    if (!node) continue;
    if (kind === SOA_KIND_LINE) {
      const left = buf.positions[i * POS_STRIDE];
      const top = buf.positions[i * POS_STRIDE + 1];
      const w = Math.max(0.01, buf.positions[i * POS_STRIDE + 2]);
      const h = Math.max(0.01, buf.positions[i * POS_STRIDE + 3]);
      const live = soaLiveAngleDeg(id);
      const angle = live || Number(node.attrs?.angle) || 0;
      const pts = sampleLineOrArrowWorldPolyline(node, left, top, w, h, angle);
      if (!pts || pts.length < 2) continue;
      pending.push({ index: i, pts, closed: false });
      floatNeed += pts.length * 2;
      continue;
    }
    if (kind === SOA_KIND_PATH) {
      const rawD = String(node.attrs?.path || '');
      const shapeType = String(node.attrs?.shapeType || '').toLowerCase();
      const d = pathPaintDFromAttrs(node.attrs as Record<string, unknown>, {
        shapeType,
      });
      const closed = pathDLooksClosed(rawD, node.attrs?.closed);
      const pts = sampleSoaPathPolyline(
        d || rawD,
        closed ? SOA_PATH_CLOSED_MAX_PTS : SOA_PATH_MAX_PTS
      );
      if (pts.length < 2) continue;
      const ox = buf.positions[i * POS_STRIDE];
      const oy = buf.positions[i * POS_STRIDE + 1];
      pending.push({
        index: i,
        pts: pts.map((p) => ({ x: ox + p.x, y: oy + p.y })),
        closed,
      });
      floatNeed += pts.length * 2;
      continue;
    }
    const t = String(node.attrs?.shapeType || '').toLowerCase();
    const w = Math.max(0.01, buf.positions[i * POS_STRIDE + 2]);
    const h = Math.max(0.01, buf.positions[i * POS_STRIDE + 3]);
    const baseline = getShapeBaseline(
      {
        key: 'shape',
        width: w,
        height: h,
        attrs: {
          ...mergeLiveShapeParamsIntoAttrs(id, (node.attrs || {}) as Record<string, unknown>),
          shapeType: t,
        },
      } as SceneNodeInput,
      { width: w, height: h }
    );
    const d = String(baseline?.d || '').trim();
    if (!d) continue;
    const pts = sampleSoaPathPolyline(d, SOA_PATH_MAX_PTS);
    if (pts.length < 2) continue;
    const ox = buf.positions[i * POS_STRIDE];
    const oy = buf.positions[i * POS_STRIDE + 1];
    pending.push({
      index: i,
      pts: pts.map((p) => ({ x: ox + p.x, y: oy + p.y })),
      closed: baseline?.closed !== false,
    });
    floatNeed += pts.length * 2;
  }
  ensurePathXYCapacity(buf, floatNeed);
  let cursor = 0;
  for (const item of pending) {
    const pointStart = cursor >> 1;
    for (const p of item.pts) {
      buf.pathXY[cursor] = p.x;
      buf.pathXY[cursor + 1] = p.y;
      cursor += 2;
    }
    buf.pathStart[item.index] = pointStart;
    buf.pathLen[item.index] = item.pts.length;
    buf.pathClosed[item.index] = item.closed ? 1 : 0;
  }
  buf.pathXYCount = cursor;
  shrinkPathXYIfLoose(buf);
  // Path geometry changed — WebGL atlas must not keep a stale AABB stamp.
  for (const item of pending) {
    buf.flags[item.index] = (buf.flags[item.index] | SOA_FLAG_DIRTY) >>> 0;
  }
}

/**
 * Full rebuild from document ROOT children (skip ROOT itself).
 * Prefer {@link syncSceneRenderBufferIncremental} after small patches.
 */
export function syncSceneRenderBufferFromDocument(
  buf: SceneRenderBuffer,
  document: SceneDocument | null | undefined
): SceneRenderBuffer {
  buf.indexById.clear();
  buf.quadtree.clear();
  buf.freeSlots.length = 0;
  buf.count = 0;
  if (!document?.deltaSetLike) {
    shrinkCapacityIfLoose(buf);
    shrinkPathXYIfLoose(buf);
    buf.revision += 1;
    return buf;
  }
  const rootKids = document.deltaSetLike.ROOT?.children;
  const ids = Array.isArray(rootKids)
    ? rootKids.map(String).filter((id) => id && id !== 'ROOT')
    : Object.keys(document.deltaSetLike).filter((id) => id !== 'ROOT');
  ensureCapacity(buf, ids.length);
  let n = 0;
  for (const id of ids) {
    const node = document.deltaSetLike[id];
    if (!node) continue;
    writeSlot(buf, n, id, node, document, { skipQuad: true });
    n += 1;
  }
  buf.count = n;
  buf.revision += 1;
  rebuildSoaPathSamples(buf, document);
  bulkUpsertSoaQuadtree(buf);
  shrinkCapacityIfLoose(buf);
  return buf;
}

/**
 * Reconcile SOA_FLAG_VISIBLE with overlay hide gates (workbench focus, precomp, …).
 * Document did not change — only module focus flags did — so incremental sync skips this.
 */
export function refreshSoaOverlayVisibilityFromDocument(
  buf: SceneRenderBuffer,
  document: SceneDocument | null | undefined
): number {
  if (!document?.deltaSetLike) return 0;
  let changed = 0;
  for (let i = 0; i < buf.count; i += 1) {
    const id = buf.ids[i];
    if (!id) continue;
    const node = document.deltaSetLike[id];
    if (!node) continue;
    const wantVisible = !isNodeOverlayHidden(document, node);
    const hasVisible = (buf.flags[i] & SOA_FLAG_VISIBLE) !== 0;
    if (wantVisible === hasVisible) continue;
    let flags = buf.flags[i];
    if (wantVisible) flags = (flags | SOA_FLAG_VISIBLE) >>> 0;
    else flags = (flags & ~SOA_FLAG_VISIBLE) >>> 0;
    buf.flags[i] = (flags | SOA_FLAG_DIRTY) >>> 0;
    syncQuadSlot(buf, i);
    changed += 1;
  }
  if (changed > 0) buf.revision += 1;
  return changed;
}

/** Patch existing slots or append; remove ids not listed when `removeMissing` is set. */
export function syncSceneRenderBufferIncremental(
  buf: SceneRenderBuffer,
  document: SceneDocument | null | undefined,
  patchedIds: readonly string[],
  opts?: { removeMissing?: boolean; allIds?: readonly string[] }
): SceneRenderBuffer {
  if (!document?.deltaSetLike) return syncSceneRenderBufferFromDocument(buf, document);
  const pathPolyTouched: string[] = [];
  for (const raw of patchedIds) {
    const id = String(raw || '');
    if (!id || id === 'ROOT') continue;
    const node = document.deltaSetLike[id];
    const existing = buf.indexById.get(id);
    if (!node) {
      if (existing != null) {
        const kind = buf.kinds[existing];
        if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY) pathPolyTouched.push(id);
        removeSlot(buf, existing);
      }
      continue;
    }
    if (existing != null) {
      writeSlot(buf, existing, id, node, document);
    } else {
      const slot = allocateSoaSlot(buf);
      writeSlot(buf, slot, id, node, document);
    }
    const idx = buf.indexById.get(id);
    if (idx != null) {
      const kind = buf.kinds[idx];
      if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY) pathPolyTouched.push(id);
    }
  }
  if (opts?.removeMissing && opts.allIds) {
    const keep = new Set(opts.allIds.map(String));
    for (let i = buf.count - 1; i >= 0; i -= 1) {
      const id = buf.ids[i];
      if (id && !keep.has(id)) {
        const kind = buf.kinds[i];
        if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY) pathPolyTouched.push(id);
        removeSlot(buf, i);
      }
    }
  }
  buf.revision += 1;
  if (pathPolyTouched.length) {
    rebuildSoaPathSamples(buf, document, { onlyIds: pathPolyTouched });
  }
  return buf;
}

/**
 * Tombstone a slot into freeSlots (O(1), leaves a hole). Prefer for bulk deletes
 * followed by {@link compactSoaFreeSlots}. Single deletes use swap-pop via
 * {@link removeSlot}.
 */
function freeSlotTombstone(buf: SceneRenderBuffer, index: number): void {
  if (index < 0 || index >= buf.count) return;
  if (buf.flags[index] & SOA_FLAG_FREE) return;
  const id = buf.ids[index];
  if (id) {
    buf.indexById.delete(id);
    buf.quadtree.remove(id);
  }
  buf.ids[index] = undefined as unknown as string;
  buf.flags[index] = SOA_FLAG_FREE;
  buf.pathStart[index] = -1;
  buf.pathLen[index] = 0;
  buf.pathClosed[index] = 0;
  buf.freeSlots.push(index);
}

/** Copy one dense SoA slot (positions/radii/colors/…) from `from` → `to`. */
function copySoaSlot(buf: SceneRenderBuffer, from: number, to: number): void {
  if (from === to) return;
  const o = to * POS_STRIDE;
  const fo = from * POS_STRIDE;
  buf.positions[o] = buf.positions[fo];
  buf.positions[o + 1] = buf.positions[fo + 1];
  buf.positions[o + 2] = buf.positions[fo + 2];
  buf.positions[o + 3] = buf.positions[fo + 3];
  const ro = to * RAD_STRIDE;
  const fro = from * RAD_STRIDE;
  buf.radii[ro] = buf.radii[fro];
  buf.radii[ro + 1] = buf.radii[fro + 1];
  buf.radii[ro + 2] = buf.radii[fro + 2];
  buf.radii[ro + 3] = buf.radii[fro + 3];
  buf.colors[to] = buf.colors[from];
  buf.flags[to] = buf.flags[from];
  buf.kinds[to] = buf.kinds[from];
  buf.strokeWidths[to] = buf.strokeWidths[from];
  buf.strokeColors[to] = buf.strokeColors[from];
  buf.ids[to] = buf.ids[from];
  buf.pathStart[to] = buf.pathStart[from];
  buf.pathLen[to] = buf.pathLen[from];
  buf.pathClosed[to] = buf.pathClosed[from];
}

function aabbFromBox(x: number, y: number, w: number, h: number) {
  return {
    minX: Math.min(x, x + w),
    minY: Math.min(y, y + h),
    maxX: Math.max(x, x + w),
    maxY: Math.max(y, y + h),
  };
}

function aabbIntersectsView(
  box: { minX: number; minY: number; maxX: number; maxY: number },
  view: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  return !(
    box.maxX < view.minX ||
    box.maxY < view.minY ||
    box.minX > view.maxX ||
    box.minY > view.maxY
  );
}

function clearSoaDirtyFlag(buf: SceneRenderBuffer, index: number): void {
  buf.flags[index] = (buf.flags[index] & ~SOA_FLAG_DIRTY) >>> 0;
}

/** Pack live slots to the front and clear freeSlots (restores dense TypedArrays). */
export function compactSoaFreeSlots(buf: SceneRenderBuffer): number {
  if (!buf.freeSlots.length) return 0;
  let write = 0;
  const freed = buf.freeSlots.length;
  for (let read = 0; read < buf.count; read += 1) {
    if (buf.flags[read] & SOA_FLAG_FREE) continue;
    copySoaSlot(buf, read, write);
    const id = buf.ids[write];
    if (id) buf.indexById.set(id, write);
    write += 1;
  }
  buf.count = write;
  buf.freeSlots.length = 0;
  buf.revision += 1;
  return freed;
}

/**
 * Remove many ids. Uses free-slot tombstones + one compact when K is large;
 * otherwise swap-pop each (keeps the array dense without a second pass).
 */
export function bulkRemoveSoaByIds(buf: SceneRenderBuffer, ids: readonly string[]): number {
  const uniq = new Set(ids.map(String).filter(Boolean));
  if (!uniq.size) return 0;
  const indices: number[] = [];
  for (const id of uniq) {
    const i = buf.indexById.get(id);
    if (i != null) indices.push(i);
  }
  if (!indices.length) return 0;
  if (indices.length >= 8) {
    for (const i of indices) freeSlotTombstone(buf, i);
    compactSoaFreeSlots(buf);
    return indices.length;
  }
  indices.sort((a, b) => b - a);
  for (const i of indices) removeSlot(buf, i);
  return indices.length;
}

function removeSlot(buf: SceneRenderBuffer, index: number) {
  const last = buf.count - 1;
  const id = buf.ids[index];
  if (id) {
    buf.indexById.delete(id);
    buf.quadtree.remove(id);
  }
  if (index !== last && last >= 0) {
    copySoaSlot(buf, last, index);
    const movedId = buf.ids[index];
    if (movedId) buf.indexById.set(movedId, index);
  }
  // Tail slot becomes recyclable capacity (dense count shrink — no hole).
  buf.ids[last] = undefined as unknown as string;
  if (last >= 0) buf.flags[last] = 0;
  buf.count = Math.max(0, last);
}

/**
 * SoA slot box for paint/hit — gesture TransformPreview overrides document
 * positions (same contract as effectivePaintBox for SVG hosts).
 * Frame-local children re-read `nodeLeftTop` so a plate drag (live frame geom)
 * moves ink without rewriting every child x/y.
 */
export function resolveSoaPaintBox(
  buf: SceneRenderBuffer,
  index: number,
  doc?: SceneDocument | null
): { x: number; y: number; w: number; h: number; dx: number; dy: number } {
  const o = index * POS_STRIDE;
  let x = buf.positions[o];
  let y = buf.positions[o + 1];
  let w = buf.positions[o + 2];
  let h = buf.positions[o + 3];
  const baseX = x;
  const baseY = y;
  const id = buf.ids[index];
  const paintDoc = doc ?? soaPaintDocument;
  if (id && paintDoc && isFrameLocalCoordSpace(paintDoc)) {
    const node = paintDoc.deltaSetLike?.[id];
    if (node && String(node.attrs?.frameId || '').trim()) {
      const { left, top } = nodeLeftTop(paintDoc, node);
      x = left;
      y = top;
    }
  }
  if (id) {
    const preview = getNodeTransformPreview(id);
    if (preview) {
      if (Number.isFinite(preview.left)) x = preview.left;
      if (Number.isFinite(preview.top)) y = preview.top;
      if (Number.isFinite(preview.width)) w = Math.max(0.01, preview.width);
      if (Number.isFinite(preview.height)) h = Math.max(0.01, preview.height);
    }
  }
  return { x, y, w, h, dx: x - baseX, dy: y - baseY };
}

/** Document slot pose → live TransformPreview box (translate + uniform-per-axis scale). */
export type SoaPathLiveMap = {
  baseX: number;
  baseY: number;
  baseW: number;
  baseH: number;
  liveX: number;
  liveY: number;
  liveW: number;
  liveH: number;
};

export function soaPathLiveMapFromSlot(
  buf: SceneRenderBuffer,
  index: number,
  live: { x: number; y: number; w: number; h: number }
): SoaPathLiveMap {
  const o = index * POS_STRIDE;
  return {
    baseX: buf.positions[o],
    baseY: buf.positions[o + 1],
    baseW: Math.max(0.01, buf.positions[o + 2]),
    baseH: Math.max(0.01, buf.positions[o + 3]),
    liveX: live.x,
    liveY: live.y,
    liveW: Math.max(0.01, live.w),
    liveH: Math.max(0.01, live.h),
  };
}

/** Map a world path sample from document slot pose into the live preview box. */
export function mapSoaPathSampleToLive(
  sampleX: number,
  sampleY: number,
  map: SoaPathLiveMap
): { x: number; y: number } {
  const sx = map.baseW > 1e-6 ? map.liveW / map.baseW : 1;
  const sy = map.baseH > 1e-6 ? map.liveH / map.baseH : 1;
  return {
    x: map.liveX + (sampleX - map.baseX) * sx,
    y: map.liveY + (sampleY - map.baseY) * sy,
  };
}

/**
 * Map a scene point into the slot's local box (origin top-left), undoing the
 * same center-rotate TransformPreview paint uses.
 */
export function soaPointToLocalBox(
  px: number,
  py: number,
  left: number,
  top: number,
  w: number,
  h: number,
  angleDeg: number
): { lx: number; ly: number } {
  const cx = left + w / 2;
  const cy = top + h / 2;
  let dx = px - cx;
  let dy = py - cy;
  if (Math.abs(angleDeg) > 0.5) {
    const rad = (-angleDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const rx = dx * c - dy * s;
    const ry = dx * s + dy * c;
    dx = rx;
    dy = ry;
  }
  return { lx: dx + w / 2, ly: dy + h / 2 };
}

function soaLiveAngleDeg(nodeId: string | undefined): number {
  if (!nodeId) return 0;
  const a = getNodeTransformPreview(nodeId)?.angle;
  if (!Number.isFinite(a) || Math.abs(Number(a)) <= 0.5) return 0;
  return Number(a);
}

/** Local-space rounded rect hit (matches {@link fillSoaRoundedRect}). */
export function hitSoaRoundedRectLocal(
  lx: number,
  ly: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
): boolean {
  if (lx < 0 || ly < 0 || lx >= w || ly >= h) return false;
  if (tl > 0 && lx < tl && ly < tl) {
    const dx = lx - tl;
    const dy = ly - tl;
    return dx * dx + dy * dy <= tl * tl;
  }
  if (tr > 0 && lx > w - tr && ly < tr) {
    const dx = lx - (w - tr);
    const dy = ly - tr;
    return dx * dx + dy * dy <= tr * tr;
  }
  if (br > 0 && lx > w - br && ly > h - br) {
    const dx = lx - (w - br);
    const dy = ly - (h - br);
    return dx * dx + dy * dy <= br * br;
  }
  if (bl > 0 && lx < bl && ly > h - bl) {
    const dx = lx - bl;
    const dy = ly - (h - bl);
    return dx * dx + dy * dy <= bl * bl;
  }
  return true;
}

/** Even-odd ray cast for a densified SoA polyline (closed fill). */
export function hitSoaPolylineFill(
  xy: Float32Array,
  startPoint: number,
  pointCount: number,
  odx: number,
  ody: number,
  px: number,
  py: number,
  liveMap?: SoaPathLiveMap | null
): boolean {
  if (pointCount < 3) return false;
  const base = startPoint * 2;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let p = 0; p < pointCount; p += 1) {
    const fo = base + p * 2;
    let x: number;
    let y: number;
    if (liveMap) {
      const mapped = mapSoaPathSampleToLive(xy[fo], xy[fo + 1], liveMap);
      x = mapped.x;
      y = mapped.y;
    } else {
      x = xy[fo] + odx;
      y = xy[fo + 1] + ody;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const xi = xs[i];
    const yi = ys[i];
    const xj = xs[j];
    const yj = ys[j];
    const cross = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

function distPointToSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-8) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Point hit against a single SoA slot (scene units). */
export function hitTestSoaSlot(
  buf: SceneRenderBuffer,
  index: number,
  x: number,
  y: number,
  opts?: { requireCanvasIdle?: boolean }
): boolean {
  if (index < 0 || index >= buf.count) return false;
  const flags = buf.flags[index];
  if (flags & SOA_FLAG_FREE) return false;
  if (!(flags & SOA_FLAG_VISIBLE)) return false;
  // Selection paint-raise clears CANVAS_IDLE while the stroke stays a DOM host.
  // Still pick against SoA polylines so click-select survives promote/demote.
  const requireIdle = opts?.requireCanvasIdle !== false;
  if (requireIdle && !(flags & SOA_FLAG_CANVAS_IDLE)) return false;
  if (flags & SOA_FLAG_LOCKED) return false;
  const id = buf.ids[index];
  if (id && getNodeTransformPreview(id)?.hidden) return false;
  const { x: left, y: top, w, h, dx: odx, dy: ody } = resolveSoaPaintBox(buf, index);
  const kind = buf.kinds[index];
  const angle = soaLiveAngleDeg(id);
  const pathLive = soaPathLiveMapFromSlot(buf, index, { x: left, y: top, w, h });
  const mapPath = (sx: number, sy: number) => mapSoaPathSampleToLive(sx, sy, pathLive);

  if (kind === SOA_KIND_LINE) {
    // Screen-friendly pick band — thin strokes are hard to click at high zoom.
    const pickR = Math.max(4, soaStrokeWidth(buf, index) * 0.5 + 2);
    const start = buf.pathStart[index];
    const len = buf.pathLen[index];
    if (start >= 0 && len >= 2) {
      const base = start * 2;
      let last = -1;
      for (let p = 0; p < len; p += 1) {
        const fo = base + p * 2;
        const cur = mapPath(buf.pathXY[fo], buf.pathXY[fo + 1]);
        if (!Number.isFinite(cur.x) || !Number.isFinite(cur.y)) {
          last = -1;
          continue;
        }
        if (last >= 0) {
          const prev = mapPath(buf.pathXY[last], buf.pathXY[last + 1]);
          if (distPointToSeg(x, y, prev.x, prev.y, cur.x, cur.y) <= pickR) return true;
        }
        last = fo;
      }
      return false;
    }
    // Shaft is mid-box left→right (rotated by live/doc angle), not the AABB diagonal.
    const angleDeg =
      angle ||
      Number(soaPaintDocument?.deltaSetLike?.[id || '']?.attrs?.angle) ||
      0;
    const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
    const cx = left + w / 2;
    const cy = top + h / 2;
    const hx = (w / 2) * Math.cos(rad);
    const hy = (w / 2) * Math.sin(rad);
    return distPointToSeg(x, y, cx - hx, cy - hy, cx + hx, cy + hy) <= pickR;
  }

  if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY) {
    const start = buf.pathStart[index];
    const len = buf.pathLen[index];
    if (start < 0 || len < 2) {
      // No polyline yet — miss here so Path2D / segment fallthrough can run.
      // AABB would steal empty clicks inside an L / star bounding box.
      return false;
    }
    const thresh = Math.max(4, soaStrokeWidth(buf, index) * 0.5 + 2);
    const base = start * 2;
    let last = -1;
    for (let p = 0; p < len; p += 1) {
      const fo = base + p * 2;
      const cur = mapPath(buf.pathXY[fo], buf.pathXY[fo + 1]);
      if (!Number.isFinite(cur.x) || !Number.isFinite(cur.y)) {
        last = -1;
        continue;
      }
      if (last >= 0) {
        const prev = mapPath(buf.pathXY[last], buf.pathXY[last + 1]);
        if (distPointToSeg(x, y, prev.x, prev.y, cur.x, cur.y) <= thresh) return true;
      }
      last = fo;
    }
    if (buf.pathClosed[index]) {
      // Close the ring for stroke hit.
      if (len >= 2) {
        const fo0 = base;
        const foN = base + (len - 1) * 2;
        const a = mapPath(buf.pathXY[foN], buf.pathXY[foN + 1]);
        const b = mapPath(buf.pathXY[fo0], buf.pathXY[fo0 + 1]);
        if (distPointToSeg(x, y, a.x, a.y, b.x, b.y) <= thresh) return true;
      }
      // Closed path interior — including pencil silhouettes (colors often 0
      // because ink uses stroke attrs, not fill-color).
      return hitSoaPolylineFill(buf.pathXY, start, len, odx, ody, x, y, pathLive);
    }
    return false;
  }

  const { lx, ly } = soaPointToLocalBox(x, y, left, top, w, h, angle);
  if (kind === SOA_KIND_ELLIPSE) {
    const rx = w / 2;
    const ry = h / 2;
    if (rx <= 0 || ry <= 0) return false;
    const nx = (lx - rx) / rx;
    const ny = (ly - ry) / ry;
    return nx * nx + ny * ny <= 1;
  }

  // RECT (sharp or rounded)
  const ro = index * RAD_STRIDE;
  const tl = buf.radii[ro] || 0;
  const tr = buf.radii[ro + 1] || 0;
  const br = buf.radii[ro + 2] || 0;
  const bl = buf.radii[ro + 3] || 0;
  if (tl > 0.5 || tr > 0.5 || br > 0.5 || bl > 0.5) {
    return hitSoaRoundedRectLocal(lx, ly, w, h, tl, tr, br, bl);
  }
  return lx >= 0 && lx < w && ly >= 0 && ly < h;
}

/**
 * Hit test SoA slots in paint order (topmost first via `order`).
 * Only canvas-ink slots are considered — DOM hosts stay off this path.
 */
export function hitTestSoaBufferOrdered(
  buf: SceneRenderBuffer,
  x: number,
  y: number,
  order: readonly string[]
): string | null {
  for (const id of order) {
    const i = buf.indexById.get(id);
    if (i == null) continue;
    if (!(buf.flags[i] & SOA_FLAG_CANVAS_IDLE)) continue;
    if (hitTestSoaSlot(buf, i, x, y)) return buf.ids[i] || id;
  }
  return null;
}

const SOA_QT_BROADPHASE_MIN = 48;
/** Rotate slack while TransformPreview is live (translation uses liveAabb rescue). */
const SOA_QT_PREVIEW_PAD = 64;

function soaLiveQuadItem(buf: SceneRenderBuffer, id: string): SoaQuadItem | null {
  const i = buf.indexById.get(id);
  if (i == null) return null;
  const { x, y, w, h } = resolveSoaPaintBox(buf, i);
  return { id, ...aabbFromBox(x, y, w, h) };
}

function useSoaQuadtreeBroadphase(buf: SceneRenderBuffer): boolean {
  return buf.quadtree.size > 0 && buf.count >= SOA_QT_BROADPHASE_MIN;
}

/**
 * Lazy QT for TransformPreview + live artboard plate queries.
 * Mid-gesture: mark dirty + liveAabb only — never rebuild the tree on the paint
 * path (that froze large multi-drags). Restamp once when previews / live plate clear.
 *
 * Plate moves do not put children on TransformPreview (frameLocal + nodeLeftTop),
 * so live artboard must use the same liveAabb rescue or QT culls with stale AABBs
 * and bound SoA ink vanishes.
 */
function prepareSoaQuadtreeForQuery(buf: SceneRenderBuffer): {
  liveAabb?: (id: string) => SoaQuadItem | null;
  pad: number;
} {
  const transformLive = hasNodeTransformPreviews();
  const plateLive = hasLiveArtboardFrameGeometry();
  if (!transformLive && !plateLive) {
    if (buf.quadtree.dirtySize > 0) {
      bulkUpsertSoaQuadtree(buf);
    }
    return { pad: 0 };
  }
  if (transformLive) {
    buf.quadtree.markDirtyMany(listNodeTransformPreviewIds());
  }
  if (plateLive) {
    buf.quadtree.markDirtyMany(buf.quadtree.ids());
  }
  return {
    pad: SOA_QT_PREVIEW_PAD,
    liveAabb: (id) => soaLiveQuadItem(buf, id),
  };
}

function forEachSoaQuadHitInRect(
  buf: SceneRenderBuffer,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  visit: (index: number) => void
): void {
  const qtOpts = prepareSoaQuadtreeForQuery(buf);
  const pad = qtOpts.pad;
  for (const hit of buf.quadtree.search(
    minX - pad,
    minY - pad,
    maxX + pad,
    maxY + pad,
    qtOpts
  )) {
    const i = buf.indexById.get(hit.id);
    if (i != null) visit(i);
  }
}

/** Point hit against visible slots (quadtree candidates + fine slot test). */
export function hitTestSoaBuffer(
  buf: SceneRenderBuffer,
  x: number,
  y: number,
  pad = 0
): string | null {
  if (buf.count <= 0) return null;
  if (!useSoaQuadtreeBroadphase(buf)) {
    for (let i = buf.count - 1; i >= 0; i -= 1) {
      if (hitTestSoaSlot(buf, i, x, y)) return buf.ids[i] || null;
    }
    return null;
  }
  const qtOpts = prepareSoaQuadtreeForQuery(buf);
  const hits = buf.quadtree.searchPoint(x, y, pad + qtOpts.pad, qtOpts);
  if (!hits.length) return null;
  let bestIndex = -1;
  let bestId: string | null = null;
  for (const hit of hits) {
    const i = buf.indexById.get(hit.id);
    if (i == null) continue;
    if (!hitTestSoaSlot(buf, i, x, y)) continue;
    if (i > bestIndex) {
      bestIndex = i;
      bestId = buf.ids[i] || hit.id;
    }
  }
  return bestId;
}

/** Visit visible slots whose AABB intersects the view rect (scene units). */
export function forEachVisibleInRect(
  buf: SceneRenderBuffer,
  view: { minX: number; minY: number; maxX: number; maxY: number },
  visit: (index: number, id: string) => void
) {
  function visitIfVisible(i: number): void {
    if (!(buf.flags[i] & SOA_FLAG_VISIBLE)) return;
    const id = buf.ids[i];
    if (!id) return;
    const { x, y, w, h } = resolveSoaPaintBox(buf, i);
    if (!aabbIntersectsView(aabbFromBox(x, y, w, h), view)) return;
    visit(i, id);
  }

  if (!useSoaQuadtreeBroadphase(buf)) {
    for (let i = 0; i < buf.count; i += 1) visitIfVisible(i);
    return;
  }
  forEachSoaQuadHitInRect(buf, view.minX, view.minY, view.maxX, view.maxY, visitIfVisible);
}

function resolveSoaSlotCornerRadii(
  buf: SceneRenderBuffer,
  index: number,
  nodeId: string,
  node: SceneNodeInput | null | undefined,
  w: number,
  h: number
): { tl: number; tr: number; br: number; bl: number } {
  const live = nodeId ? getLiveCornerRadiusPreviewRadii(nodeId) : null;
  if (live) {
    return clampCornerRadii(live, w, h);
  }
  if (index >= 0) {
    const ro = index * RAD_STRIDE;
    return {
      tl: buf.radii[ro] || 0,
      tr: buf.radii[ro + 1] || 0,
      br: buf.radii[ro + 2] || 0,
      bl: buf.radii[ro + 3] || 0,
    };
  }
  return clampCornerRadii(radiiFromAttrs(node?.attrs), w, h);
}

/** Live corner / sides / inner-ratio / arc — paint must not use stale SoA samples. */
function hasSoaLiveGeoPreview(nodeId: string | undefined): boolean {
  if (!nodeId) return false;
  if (getLiveCornerRadiusPreviewRadii(nodeId)) return true;
  if (getLiveShapeParamsPreview(nodeId)) return true;
  return false;
}

function soaAttrsWithLiveGeoPreview(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  return mergeLiveCornerRadiiIntoAttrs(
    nodeId,
    mergeLiveShapeParamsIntoAttrs(nodeId, attrs)
  );
}

/**
 * Mid-drag poly/star/donut ink: bake path samples + solid ellipse ignore live
 * attrs, so rebuild baseline Path2D (or sampled polyline) from merged preview.
 * Returns true when this slot was painted.
 */
function paintSoaIdleSlotLiveGeo(
  ctx: CanvasRenderingContext2D,
  buf: SceneRenderBuffer,
  i: number,
  box: { x: number; y: number; w: number; h: number },
  doc: SceneDocument | null,
  id: string,
  kind: number
): boolean {
  if (kind !== SOA_KIND_POLY && kind !== SOA_KIND_ELLIPSE) return false;
  if (!hasSoaLiveGeoPreview(id)) return false;
  const node = doc?.deltaSetLike?.[id] as SceneNodeInput | undefined;
  if (!node) return false;

  const { x, y, w, h } = box;
  const mergedAttrs = soaAttrsWithLiveGeoPreview(
    id,
    (node.attrs || {}) as Record<string, unknown>
  );
  const rawType = String(mergedAttrs.shapeType || node.attrs?.shapeType || '').toLowerCase();
  let shapeType = rawType;
  if (kind === SOA_KIND_ELLIPSE) {
    shapeType = 'circle';
  } else if (shapeType !== 'triangle' && shapeType !== 'star' && shapeType !== 'polygon') {
    shapeType = 'polygon';
  }

  const baseline = getShapeBaseline(
    {
      key: 'shape',
      width: w,
      height: h,
      attrs: { ...mergedAttrs, shapeType },
    } as SceneNodeInput,
    { width: w, height: h }
  );
  const d = String(baseline?.d || '').trim();
  if (!d) return false;

  const fillArgb = buf.colors[i] >>> 0;
  const outlineArgb = buf.strokeColors[i] >>> 0;
  const outlineW = buf.strokeWidths[i];
  const outlineStroke = outlineArgb ? unpackCssColor(outlineArgb) : '';
  const doFill = fillArgb !== 0;
  const doOutline = Boolean(outlineArgb && outlineW > 0 && outlineStroke);
  const strokeAlign = resolveStrokeAlignForPaint(node);
  const strokeDash = strokeDashFromAttrs(mergedAttrs);
  const useEvenodd =
    kind === SOA_KIND_ELLIPSE && effectiveEllipseInnerRatioFromAttrs(id, node.attrs) > 1e-4;
  const rot = livePreviewAngleDeg(id);

  const paintLocalPath = (path: Path2D) => {
    const noopTrace = () => {
      /* Path2D stroke/fill */
    };
    const shapeType = String(mergedAttrs.shapeType || '').toLowerCase();
    ctx.lineCap =
      shapeType === 'pencil' ? 'round' : resolveStrokeLinecap(mergedAttrs);
    ctx.lineJoin =
      shapeType === 'pencil' ? 'round' : resolveStrokeLinejoin(mergedAttrs);
    ctx.miterLimit = resolveStrokeMiterlimit(mergedAttrs);
    if (doOutline && strokeAlign === 'outside') {
      strokeCanvasAligned(ctx, {
        align: strokeAlign,
        stroke: outlineStroke,
            strokeWidth: outlineW,
        dasharray: strokeDash,
        trace: noopTrace,
        path,
        fillRule: useEvenodd ? 'evenodd' : undefined,
      });
    }
    if (doFill) {
      ctx.fillStyle = unpackCssColor(fillArgb);
      if (useEvenodd) ctx.fill(path, 'evenodd');
      else ctx.fill(path);
    }
    if (doOutline && strokeAlign !== 'outside') {
      strokeCanvasAligned(ctx, {
        align: strokeAlign,
        stroke: outlineStroke,
            strokeWidth: outlineW,
        dasharray: strokeDash,
        trace: noopTrace,
        path,
        fillRule: useEvenodd ? 'evenodd' : undefined,
      });
    }
  };

  const paintLocalSamples = (pts: Array<{ x: number; y: number }>) => {
    const shapeType = String(mergedAttrs.shapeType || '').toLowerCase();
    ctx.lineCap =
      shapeType === 'pencil' ? 'round' : resolveStrokeLinecap(mergedAttrs);
    ctx.lineJoin =
      shapeType === 'pencil' ? 'round' : resolveStrokeLinejoin(mergedAttrs);
    ctx.miterLimit = resolveStrokeMiterlimit(mergedAttrs);
    const trace = () => {
      ctx.beginPath();
      let pending = false;
      for (const p of pts) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
          pending = false;
          continue;
        }
        if (!pending) {
          ctx.moveTo(p.x, p.y);
          pending = true;
        } else {
          ctx.lineTo(p.x, p.y);
        }
      }
      if (pending && baseline?.closed !== false) ctx.closePath();
    };
    if (doOutline && strokeAlign === 'outside') {
      strokeCanvasAligned(ctx, {
        align: strokeAlign,
        stroke: outlineStroke,
            strokeWidth: outlineW,
        dasharray: strokeDash,
        trace,
      });
    }
    if (doFill) {
      ctx.fillStyle = unpackCssColor(fillArgb);
      trace();
      if (useEvenodd) ctx.fill('evenodd');
      else ctx.fill();
    }
    if (doOutline && strokeAlign !== 'outside') {
      strokeCanvasAligned(ctx, {
        align: strokeAlign,
        stroke: outlineStroke,
            strokeWidth: outlineW,
        dasharray: strokeDash,
        trace,
      });
    }
  };

  ctx.save();
  ctx.translate(x, y);
  if (rot) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
  }
  if (typeof Path2D !== 'undefined') {
    try {
      const path = rememberNodePath2D(id, d) || getCachedPath2D(d);
      if (path) {
        paintLocalPath(path);
        ctx.restore();
        buf.flags[i] = (buf.flags[i] & ~SOA_FLAG_DIRTY) >>> 0;
        return true;
      }
    } catch {
      /* fall through to samples */
    }
  }
  const pts = sampleSoaPathPolyline(d, SOA_PATH_MAX_PTS);
  if (pts.length < 2) {
    ctx.restore();
    return false;
  }
  paintLocalSamples(pts);
  ctx.restore();
  buf.flags[i] = (buf.flags[i] & ~SOA_FLAG_DIRTY) >>> 0;
  return true;
}

function clipSoaIdleSlotToFrame(
  ctx: CanvasRenderingContext2D,
  doc: SceneDocument,
  id: string,
  node: SceneNodeInput,
  box: { x: number; y: number; w: number; h: number }
): boolean {
  // Selected / editing ink must match unclipped selection chrome.
  if (frameClipRevealsOverflow(id)) return false;
  const frame = findClippingFrameForNode(doc, {
    ...(node as Record<string, unknown>),
    id,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
  });
  if (!frame) return false;
  const ox = Number(doc.x) || 0;
  const oy = Number(doc.y) || 0;
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    Number(frame.x) - ox,
    Number(frame.y) - oy,
    Math.max(1, Number(frame.width) || 1),
    Math.max(1, Number(frame.height) || 1)
  );
  ctx.clip();
  return true;
}

function pathStrokeArgb(opts: {
  outlineArgb: number;
  fillArgb: number;
  doFill: boolean;
  isPoly: boolean;
}): number {
  if (opts.outlineArgb) return opts.outlineArgb;
  if (opts.doFill || opts.isPoly) return 0;
  return opts.fillArgb;
}

function livePreviewAngleDeg(id: string | undefined): number {
  if (!id) return 0;
  const liveAngle = getNodeTransformPreview(id)?.angle;
  if (!Number.isFinite(liveAngle)) return 0;
  if (Math.abs(Number(liveAngle)) <= 0.5) return 0;
  return Number(liveAngle);
}

/** Local baseline points → world, rotated about the paint AABB center. */
function mapLocalBaselineToWorld(
  pts: Array<{ x: number; y: number }>,
  left: number,
  top: number,
  w: number,
  h: number,
  angleDeg: number
): Array<{ x: number; y: number }> {
  const cx = left + w / 2;
  const cy = top + h / 2;
  const rad = (Number(angleDeg) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const out: Array<{ x: number; y: number }> = [];
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      out.push({ x: Number.NaN, y: Number.NaN });
      continue;
    }
    const lx = p.x - w / 2;
    const ly = p.y - h / 2;
    out.push({
      x: cx + lx * cos - ly * sin,
      y: cy + lx * sin + ly * cos,
    });
  }
  return out;
}

/** World polyline for line/arrow from live box + angle (TransformPreview-safe). */
export function sampleLineOrArrowWorldPolyline(
  node: SceneNodeInput,
  left: number,
  top: number,
  w: number,
  h: number,
  angleDeg: number
): Array<{ x: number; y: number }> | null {
  const t = String(node.attrs?.shapeType || '').toLowerCase();
  const shapeType = t === 'arrow' ? 'arrow' : 'line';
  const baseline = getShapeBaseline(
    {
      key: 'shape',
      width: w,
      height: h,
      attrs: { ...(node.attrs || {}), shapeType },
    } as SceneNodeInput,
    { width: w, height: h }
  );
  const d = String(baseline?.d || '').trim();
  if (!d) return null;
  const local = sampleSoaPathPolyline(d, SOA_PATH_MAX_PTS);
  if (local.length < 2) return null;
  return mapLocalBaselineToWorld(local, left, top, w, h, angleDeg);
}

/**
 * World polyline for any closed/open baseline (rect/roundrect/ellipse/poly…).
 * Used to emit crisp WebGL stroke segments without SVG hosts or soft atlas AA.
 */
export function sampleShapeBaselineWorldPolyline(
  node: SceneNodeInput,
  left: number,
  top: number,
  w: number,
  h: number,
  angleDeg: number
): Array<{ x: number; y: number }> | null {
  const baseline = getShapeBaseline(node, { width: w, height: h });
  const d = String(baseline?.d || '').trim();
  if (!d) return null;
  const local = sampleSoaPathPolyline(d, SOA_PATH_MAX_PTS);
  if (local.length < 2) return null;
  return mapLocalBaselineToWorld(local, left, top, w, h, angleDeg);
}

function nodeAttrsForId(
  doc: SceneDocument | null,
  id: string | undefined
): Record<string, unknown> | null {
  if (!doc || !id) return null;
  const attrs = doc.deltaSetLike?.[id]?.attrs;
  if (!attrs) return null;
  return attrs as Record<string, unknown>;
}

function soaPathOrPolyLineWidth(
  buf: SceneRenderBuffer,
  i: number,
  isPoly: boolean,
  outlineArgb: number,
  outlineW: number
): number {
  if (isPoly && outlineArgb && outlineW > 0) return outlineW;
  if (isPoly) return 0;
  return soaStrokeWidth(buf, i);
}

function resolvePathStrokeStyle(strokeArgb: number, fillArgb: number): string {
  if (strokeArgb) return unpackCssColor(strokeArgb);
  return unpackCssColor(fillArgb || 0xff333333);
}

/** Trace one sampled contour in world space (poly / path ink). */
function traceSoaSampledContour(
  ctx: CanvasRenderingContext2D,
  buf: SceneRenderBuffer,
  index: number,
  liveMap: SoaPathLiveMap,
  closed: boolean
): boolean {
  const start = buf.pathStart[index];
  const len = buf.pathLen[index];
  if (start < 0 || len < 2) return false;
  const base = start * 2;
  let pending = false;
  ctx.beginPath();
  for (let p = 0; p < len; p += 1) {
    const fo = base + p * 2;
    const { x: px, y: py } = mapSoaPathSampleToLive(buf.pathXY[fo], buf.pathXY[fo + 1], liveMap);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      pending = false;
      continue;
    }
    if (!pending) {
      ctx.moveTo(px, py);
      pending = true;
    } else {
      ctx.lineTo(px, py);
    }
  }
  if (closed && pending) ctx.closePath();
  return pending;
}

/** Paint one SoA idle slot (document z-order callers walk ids). */
export function paintSoaIdleSlot(
  ctx: CanvasRenderingContext2D,
  buf: SceneRenderBuffer,
  i: number,
  view: { left: number; top: number; right: number; bottom: number },
  doc: SceneDocument | null
): void {
  const flags = buf.flags[i];
  const id = buf.ids[i];
  const { x, y, w, h } = resolveSoaPaintBox(buf, i, doc);
  if (x + w < view.left || y + h < view.top || x > view.right || y > view.bottom) return;
  const kind = buf.kinds[i];
  const pathLive = soaPathLiveMapFromSlot(buf, i, { x, y, w, h });
  let clipped = false;
  if (doc && id) {
    const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
    if (node) {
      if (
        isNodeAabbFullyOccludedByHigherArtboard(doc, { ...node, id }, {
          left: x,
          top: y,
          width: w,
          height: h,
        })
      ) {
        buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        return;
      }
      clipped = clipSoaIdleSlotToFrame(ctx, doc, id, node, { x, y, w, h });
    }
  }
  try {
    if (
      id &&
      paintSoaIdleSlotLiveGeo(ctx, buf, i, { x, y, w, h }, doc, id, kind)
    ) {
      return;
    }
    if (kind === SOA_KIND_LINE) {
      const start = buf.pathStart[i];
      const len = buf.pathLen[i];
      ctx.strokeStyle = unpackCssColor(buf.colors[i]);
      ctx.lineWidth = soaStrokeWidth(buf, i);
      const lineAttrs = nodeAttrsForId(doc, id);
      // Match SVG / WebGL: butt + miter so arrow V tips stay sharp (round caps dull the point).
      ctx.lineCap = resolveStrokeLinecap(lineAttrs);
      ctx.lineJoin = resolveStrokeLinejoin(lineAttrs);
      ctx.miterLimit = resolveStrokeMiterlimit(lineAttrs);
      const lineDash = strokeDashFromAttrs(lineAttrs);
      const dashNums = String(lineDash || '')
        .trim()
        .split(/[\s,]+/)
        .map(Number)
        .filter((n) => Number.isFinite(n) && n >= 0);
      ctx.setLineDash(dashNums.length ? dashNums : []);
      try {
        if (start >= 0 && len >= 2) {
          // Baseline samples (line shaft / arrow shaft+V), including NaN breaks.
          const base = start * 2;
          let pending = false;
          ctx.beginPath();
          for (let p = 0; p < len; p += 1) {
            const fo = base + p * 2;
            const { x: px, y: py } = mapSoaPathSampleToLive(
              buf.pathXY[fo],
              buf.pathXY[fo + 1],
              pathLive
            );
            if (!Number.isFinite(px) || !Number.isFinite(py)) {
              pending = false;
              continue;
            }
            if (!pending) {
              ctx.moveTo(px, py);
              pending = true;
            } else {
              ctx.lineTo(px, py);
            }
          }
          ctx.stroke();
        } else {
          // Shaft is mid-box left→right at live/doc angle — not the AABB diagonal.
          const angleDeg =
            Number(getNodeTransformPreview(id)?.angle) ||
            Number(doc?.deltaSetLike?.[id]?.attrs?.angle) ||
            0;
          const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
          const cx = x + w / 2;
          const cy = y + h / 2;
          const hx = (w / 2) * Math.cos(rad);
          const hy = (w / 2) * Math.sin(rad);
          ctx.beginPath();
          ctx.moveTo(cx - hx, cy - hy);
          ctx.lineTo(cx + hx, cy + hy);
          ctx.stroke();
        }
      } finally {
        ctx.setLineDash([]);
      }
      buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      return;
    }
    if (kind === SOA_KIND_PATH || kind === SOA_KIND_POLY) {
      const start = buf.pathStart[i];
      const len = buf.pathLen[i];
      if (start < 0 || len < 2) return;
      const fillArgb = buf.colors[i] >>> 0;
      const closed = buf.pathClosed[i] !== 0;
      const outlineArgb = buf.strokeColors[i] >>> 0;
      const outlineW = buf.strokeWidths[i];
      const isPoly = kind === SOA_KIND_POLY;
      const nodeAttrs = nodeAttrsForId(doc, id);
      const pathShapeTypeEarly = String(nodeAttrs?.shapeType || '').toLowerCase();
      // Pencil idle: fill perfect-freehand silhouette (taper/caps), not centerline stroke.
      if (!isPoly && pathShapeTypeEarly === 'pencil' && id && doc) {
        const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
        if (node && typeof Path2D !== 'undefined') {
          const sw = Math.max(
            0.5,
            Number(node.attrs?.['border-width'] ?? node.attrs?.strokeWidth) ||
              outlineW ||
              1
          );
          const outlineD = pencilSilhouettePathD({ ...node, id }, sw);
          if (outlineD) {
            const path = rememberNodePath2D(id, outlineD) || getCachedPath2D(outlineD);
            if (path) {
              const ink = outlineArgb
                ? unpackCssColor(outlineArgb)
                : '#333333';
              const rot = livePreviewAngleDeg(id);
              ctx.save();
              ctx.fillStyle = ink;
              if (rot) {
                ctx.translate(x + w / 2, y + h / 2);
                ctx.rotate((rot * Math.PI) / 180);
                ctx.translate(-w / 2, -h / 2);
              } else {
                ctx.translate(x, y);
              }
              ctx.fill(path);
              ctx.restore();
              buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
              return;
            }
          }
        }
      }
      const solidFill =
        fillArgb !== 0 && (!nodeAttrs || pathAttrsHaveSolidFill(nodeAttrs));
      // PATH: colors = fill (0 if transparent); strokeColors = stroke.
      // Never fill closed pens with the stroke color (looked black until select→SVG).
      const doFill = closed && solidFill;
      const strokeArgb = pathStrokeArgb({
        outlineArgb,
        fillArgb,
        doFill,
        isPoly,
      });
      const polyNode =
        isPoly && id && doc ? (doc.deltaSetLike?.[id] as SceneNodeInput | undefined) : undefined;
      const polyOutline =
        isPoly && outlineArgb && outlineW > 0
          ? unpackCssColor(outlineArgb)
          : '';
      const polyDoOutline = Boolean(polyOutline);
      if (isPoly && polyDoOutline) {
        const strokeAlign = polyNode ? resolveStrokeAlignForPaint(polyNode) : 'center';
        const polyJoinAttrs = nodeAttrs || polyNode?.attrs || null;
        const shapeType = String(polyJoinAttrs?.shapeType || '').toLowerCase();
        // Pencil defaults round; stars/polys stay miter so tips stay sharp.
        ctx.lineCap =
          shapeType === 'pencil'
            ? 'round'
            : resolveStrokeLinecap(polyJoinAttrs);
        ctx.lineJoin =
          shapeType === 'pencil'
            ? 'round'
            : resolveStrokeLinejoin(polyJoinAttrs);
        ctx.miterLimit = resolveStrokeMiterlimit(polyJoinAttrs);
        const tracePoly = () => {
          traceSoaSampledContour(ctx, buf, i, pathLive, closed);
        };
        if (strokeAlign === 'outside') {
          strokeCanvasAligned(ctx, {
            align: strokeAlign,
            stroke: polyOutline,
            strokeWidth: outlineW,
            dasharray: strokeDashFromAttrs(polyJoinAttrs),
            trace: tracePoly,
          });
        }
        if (doFill) {
          ctx.fillStyle = unpackCssColor(fillArgb);
          tracePoly();
          ctx.fill();
        }
        if (strokeAlign !== 'outside') {
          strokeCanvasAligned(ctx, {
            align: strokeAlign,
            stroke: polyOutline,
            strokeWidth: outlineW,
            dasharray: strokeDashFromAttrs(polyJoinAttrs),
            trace: tracePoly,
          });
        }
        buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        return;
      }
      if (doFill) ctx.fillStyle = unpackCssColor(fillArgb);
      ctx.strokeStyle = resolvePathStrokeStyle(strokeArgb, fillArgb);
      ctx.lineWidth = soaPathOrPolyLineWidth(buf, i, isPoly, outlineArgb, outlineW);
      const pathShapeType = String(nodeAttrs?.shapeType || '').toLowerCase();
      // Never force round on stars/polygons — that blunts every tip into 圆角.
      ctx.lineCap =
        pathShapeType === 'pencil' ? 'round' : resolveStrokeLinecap(nodeAttrs);
      ctx.lineJoin =
        pathShapeType === 'pencil' ? 'round' : resolveStrokeLinejoin(nodeAttrs);
      ctx.miterLimit = resolveStrokeMiterlimit(nodeAttrs);
      const base = start * 2;
      let pending = false;
      const finishContour = () => {
        if (!pending) return;
        if (closed) ctx.closePath();
        if (doFill) ctx.fill();
        if (!isPoly || (outlineArgb && outlineW > 0)) {
          if (ctx.lineWidth > 0 && strokeArgb) ctx.stroke();
        }
        pending = false;
      };
      ctx.beginPath();
      for (let p = 0; p < len; p += 1) {
        const fo = base + p * 2;
        const { x: px, y: py } = mapSoaPathSampleToLive(
          buf.pathXY[fo],
          buf.pathXY[fo + 1],
          pathLive
        );
        if (!Number.isFinite(px) || !Number.isFinite(py)) {
          finishContour();
          ctx.beginPath();
          continue;
        }
        if (!pending) {
          ctx.moveTo(px, py);
          pending = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      finishContour();
      buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      return;
    }
    if (kind === SOA_KIND_TEXT) {
      const node = id && doc ? (doc.deltaSetLike?.[id] as SceneNodeInput | undefined) : undefined;
      if (node && getSoaTextInkPainter()) {
        const paintText = getSoaTextInkPainter()!;
        const rot = livePreviewAngleDeg(id);
        const opacity = Math.min(1, Math.max(0, parseLayerOpacity(node.attrs?.opacity, 1)));
        ctx.save();
        if (rot) {
          ctx.translate(x + w / 2, y + h / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.translate(-w / 2, -h / 2);
        } else {
          ctx.translate(x, y);
        }
        paintText(ctx, {
          node: { ...node, id: id || node.id },
          width: w,
          height: h,
          opacity: Math.max(0.05, opacity),
        });
        ctx.restore();
      }
      buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
      return;
    }
    if (kind !== SOA_KIND_RECT && kind !== SOA_KIND_ELLIPSE) return;
    ctx.fillStyle = unpackCssColor(buf.colors[i]);
    const outlineArgb = buf.strokeColors[i] >>> 0;
    const outlineW = buf.strokeWidths[i];
    const rot = livePreviewAngleDeg(id);
    const nodeForRadii = id && doc ? (doc.deltaSetLike?.[id] as SceneNodeInput | undefined) : undefined;
    const cornerR = resolveSoaSlotCornerRadii(buf, i, id || '', nodeForRadii, w, h);
    const strokeAlign = nodeForRadii
      ? resolveStrokeAlignForPaint(nodeForRadii)
      : 'center';
    const outlineStroke = outlineArgb ? unpackCssColor(outlineArgb) : '';
    const doOutline = Boolean(outlineArgb && outlineW > 0 && outlineStroke);
    const rectStrokeAttrs = nodeForRadii?.attrs || null;
    ctx.lineCap = resolveStrokeLinecap(rectStrokeAttrs);
    ctx.lineJoin = resolveStrokeLinejoin(rectStrokeAttrs);
    ctx.miterLimit = resolveStrokeMiterlimit(rectStrokeAttrs);

    // Prefer shared Path2D cache (same kernel as hit-test / Canvas idle).
    if (nodeForRadii && id && typeof Path2D !== 'undefined') {
      const shapeType =
        kind === SOA_KIND_ELLIPSE
          ? 'circle'
          : String(nodeForRadii.attrs?.shapeType || 'rect').toLowerCase();
      const mergedAttrs = soaAttrsWithLiveGeoPreview(
        id,
        (nodeForRadii.attrs || {}) as Record<string, unknown>
      );
      const baseline = getShapeBaseline(
        {
          key: 'shape',
          width: w,
          height: h,
          attrs: { ...mergedAttrs, shapeType },
        } as SceneNodeInput,
        { width: w, height: h }
      );
      const d = String(baseline?.d || '').trim();
      const path = d ? rememberNodePath2D(id, d) || getCachedPath2D(d) : null;
      if (path) {
        const fillArgb = buf.colors[i] >>> 0;
        const doFill = fillArgb !== 0;
        const useEvenodd =
          kind === SOA_KIND_ELLIPSE &&
          effectiveEllipseInnerRatioFromAttrs(id, nodeForRadii.attrs) > 1e-4;
        const paintPath = () => {
          const dasharray = strokeDashFromAttrs(rectStrokeAttrs);
          const wantSides =
            kind === SOA_KIND_RECT &&
            doOutline &&
            isRectLikeStrokeSidesShape(shapeType, nodeForRadii?.key);
          const sideRuns = wantSides
            ? rectStrokeSideRuns(w, h, rectStrokeAttrs, cornerR)
            : null;
          const sideHandled = sideRuns != null;
          if (doOutline && !sideHandled && strokeAlign === 'outside') {
            strokeCanvasAligned(ctx, {
              align: strokeAlign,
              stroke: outlineStroke,
              strokeWidth: outlineW,
              dasharray,
              trace: () => undefined,
              path,
              fillRule: useEvenodd ? 'evenodd' : undefined,
            });
          }
          if (doFill) {
            ctx.fillStyle = unpackCssColor(fillArgb);
            if (useEvenodd) ctx.fill(path, 'evenodd');
            else ctx.fill(path);
          }
          if (sideHandled) {
            strokeCanvasPartialRectSides(ctx, {
              width: w,
              height: h,
              attrs: rectStrokeAttrs,
              radii: cornerR,
              stroke: outlineStroke,
              strokeWidth: outlineW,
              dasharray,
            });
          } else if (doOutline && strokeAlign !== 'outside') {
            strokeCanvasAligned(ctx, {
              align: strokeAlign,
              stroke: outlineStroke,
              strokeWidth: outlineW,
              dasharray,
              trace: () => undefined,
              path,
              fillRule: useEvenodd ? 'evenodd' : undefined,
            });
          }
        };
        ctx.save();
        ctx.translate(x, y);
        if (rot) {
          ctx.translate(w / 2, h / 2);
          ctx.rotate((rot * Math.PI) / 180);
          ctx.translate(-w / 2, -h / 2);
        }
        paintPath();
        ctx.restore();
        buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
        return;
      }
    }

    const traceLocal = () => {
      if (kind === SOA_KIND_ELLIPSE) {
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        return;
      }
      const { tl, tr, br, bl } = cornerR;
      if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
        pathSoaRoundedRect(ctx, 0, 0, w, h, tl, tr, br, bl);
      } else {
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
      }
    };

    const fillLocal = () => {
      if (kind === SOA_KIND_ELLIPSE) {
        ctx.beginPath();
        ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      const { tl, tr, br, bl } = cornerR;
      if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
        fillSoaRoundedRect(ctx, 0, 0, w, h, tl, tr, br, bl);
      } else {
        ctx.fillRect(0, 0, w, h);
      }
    };

    const paintAlignedLocal = () => {
      const dasharray = strokeDashFromAttrs(rectStrokeAttrs);
      const shapeType = String(rectStrokeAttrs?.shapeType || 'rect').toLowerCase();
      const sideRuns =
        kind === SOA_KIND_RECT &&
        doOutline &&
        isRectLikeStrokeSidesShape(shapeType, nodeForRadii?.key)
          ? rectStrokeSideRuns(w, h, rectStrokeAttrs, cornerR)
          : null;
      const sideHandled = sideRuns != null;
      if (doOutline && !sideHandled && strokeAlign === 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceLocal,
        });
      }
      fillLocal();
      if (sideHandled) {
        strokeCanvasPartialRectSides(ctx, {
          width: w,
          height: h,
          attrs: rectStrokeAttrs,
          radii: cornerR,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
        });
      } else if (doOutline && strokeAlign !== 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceLocal,
        });
      }
    };

    if (rot) {
      ctx.save();
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate((rot * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);
      paintAlignedLocal();
      ctx.restore();
    } else if (kind === SOA_KIND_ELLIPSE) {
      const dasharray = strokeDashFromAttrs(rectStrokeAttrs);
      const traceWorld = () => {
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      };
      if (doOutline && strokeAlign === 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceWorld,
        });
      }
      traceWorld();
      ctx.fill();
      if (doOutline && strokeAlign !== 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceWorld,
        });
      }
    } else {
      const dasharray = strokeDashFromAttrs(rectStrokeAttrs);
      const shapeType = String(rectStrokeAttrs?.shapeType || 'rect').toLowerCase();
      const sideRuns =
        doOutline && isRectLikeStrokeSidesShape(shapeType, nodeForRadii?.key)
          ? rectStrokeSideRuns(w, h, rectStrokeAttrs, cornerR)
          : null;
      const { tl, tr, br, bl } = cornerR;
      const traceWorld = () => {
        if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
          pathSoaRoundedRect(ctx, x, y, w, h, tl, tr, br, bl);
        } else {
          ctx.beginPath();
          ctx.rect(x, y, w, h);
        }
      };
      if (doOutline && sideRuns == null && strokeAlign === 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceWorld,
        });
      }
      if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
        fillSoaRoundedRect(ctx, x, y, w, h, tl, tr, br, bl);
      } else {
        ctx.fillRect(x, y, w, h);
      }
      if (sideRuns != null) {
        ctx.save();
        ctx.translate(x, y);
        strokeCanvasPartialRectSides(ctx, {
          width: w,
          height: h,
          attrs: rectStrokeAttrs,
          radii: cornerR,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
        });
        ctx.restore();
      } else if (doOutline && strokeAlign !== 'outside') {
        strokeCanvasAligned(ctx, {
          align: strokeAlign,
          stroke: outlineStroke,
          strokeWidth: outlineW,
          dasharray,
          trace: traceWorld,
        });
      }
    }
    buf.flags[i] = (flags & ~SOA_FLAG_DIRTY) >>> 0;
  } finally {
    if (clipped) ctx.restore();
  }
}

/** Paint visible SoA idle slots that intersect the view (scene units). */
export function paintSoaBufferBasic(
  ctx: CanvasRenderingContext2D,
  buf: SceneRenderBuffer,
  view: {
    left?: number;
    top?: number;
    x?: number;
    y?: number;
    width: number;
    height: number;
  },
  opts?: {
    dirtyOnly?: boolean;
    /** When set, skip slots whose document node is not SoA-basic (rounded, stroke, …). */
    skipIndex?: (index: number) => boolean;
    /**
     * Clip each slot to its owning clipContent frame (live artboard aware).
     * Used while frame plates move so ink does not spill past the plate.
     */
    document?: SceneDocument | null;
  }
) {
  const dirtyOnly = opts?.dirtyOnly === true;
  const skipIndex = opts?.skipIndex;
  const doc = opts?.document ?? null;
  if (doc) setSoaPaintDocument(doc);
  // Frame clip is part of paint identity — not a gesture-only hint. Gating on
  // TransformPreview left idle SoA ink unclipped on 动画工作台 / artboards.
  const vl = view.left ?? view.x ?? 0;
  const vt = view.top ?? view.y ?? 0;
  const vr = vl + view.width;
  const vb = vt + view.height;
  // Buffer slot index follows ROOT.children, not stackOrder/frameOrder. Paint
  // back→front by document z so a later-created (or reordered) shape's fill
  // covers lower siblings' strokes — otherwise gray borders "ghost" on top.
  const paintOrder: number[] = [];
  function shouldSkipPaintSlot(i: number, flags: number, id: string | undefined): boolean {
    if (flags & SOA_FLAG_FREE) return true;
    if (!(flags & SOA_FLAG_VISIBLE)) return true;
    if (!(flags & SOA_FLAG_CANVAS_IDLE)) return true;
    if (!(flags & SOA_FLAG_BASIC_GEOM)) return true;
    if (dirtyOnly && !(flags & SOA_FLAG_DIRTY)) return true;
    if (skipIndex?.(i)) return true;
    if (!id) return false;
    if (doc && !doc.deltaSetLike?.[id]) {
      clearSoaDirtyFlag(buf, i);
      return true;
    }
    if (doc) {
      const paintNode = doc.deltaSetLike[id] as SceneNodeInput | undefined;
      if (paintNode && isNodeOverlayHidden(doc, paintNode)) {
        clearSoaDirtyFlag(buf, i);
        return true;
      }
    }
    // Host owns fill/stroke. Live corner-radius is applied on the host SVG —
    // do not also paint SoA (WebGL used stale sharp radii → white AABB corners).
    // Poly/star side live-geo still needs SoA rebuild under the host.
    const liveShapeParams = getLiveShapeParamsPreviewNodeId() === id;
    if (getShapeHost(id)?.el && !liveShapeParams) {
      clearSoaDirtyFlag(buf, i);
      return true;
    }
    if (getNodeTransformPreview(id)?.hidden) {
      clearSoaDirtyFlag(buf, i);
      return true;
    }
    return false;
  }
  function considerPaintIndex(i: number): void {
    if (shouldSkipPaintSlot(i, buf.flags[i], buf.ids[i])) return;
    paintOrder.push(i);
  }
  if (useSoaQuadtreeBroadphase(buf)) {
    forEachSoaQuadHitInRect(buf, vl, vt, vr, vb, considerPaintIndex);
  } else {
    for (let i = 0; i < buf.count; i += 1) considerPaintIndex(i);
  }
  if (doc && paintOrder.length > 1) {
    const zMap = buildNodeStackZMap(
      doc,
      paintOrder.map((i) => buf.ids[i] || '')
    );
    const raisedZ = maxDocumentStackZ(doc) + 1;
    paintOrder.sort((a, b) => {
      const idA = buf.ids[a] || '';
      const idB = buf.ids[b] || '';
      const za = selectionPaintRaises(idA) ? raisedZ : zMap.get(idA) || 0;
      const zb = selectionPaintRaises(idB) ? raisedZ : zMap.get(idB) || 0;
      return za - zb || (zMap.get(idA) || 0) - (zMap.get(idB) || 0) || a - b;
    });
  }
  for (const i of paintOrder) {
    paintSoaIdleSlot(ctx, buf, i, { left: vl, top: vt, right: vr, bottom: vb }, doc);
  }
}

/** World-space rounded rect path (tl/tr/br/bl) — shared by fill and outline stroke. */
export function pathSoaRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number,
  opts?: { append?: boolean }
) {
  if (!opts?.append) ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  if (tr > 0) ctx.arcTo(x + w, y, x + w, y + tr, tr);
  else ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - br);
  if (br > 0) ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  else ctx.lineTo(x + w, y + h);
  ctx.lineTo(x + bl, y + h);
  if (bl > 0) ctx.arcTo(x, y + h, x, y + h - bl, bl);
  else ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + tl);
  if (tl > 0) ctx.arcTo(x, y, x + tl, y, tl);
  else ctx.lineTo(x, y);
  ctx.closePath();
}

/** World-space rounded rect fill (tl/tr/br/bl). */
export function fillSoaRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  tl: number,
  tr: number,
  br: number,
  bl: number
) {
  pathSoaRoundedRect(ctx, x, y, w, h, tl, tr, br, bl);
  ctx.fill();
}

/** Mark all canvas-idle slots dirty (e.g. after full buffer sync). */
export function markAllSoaDirty(buf: SceneRenderBuffer) {
  for (let i = 0; i < buf.count; i += 1) {
    if (buf.flags[i] & SOA_FLAG_CANVAS_IDLE) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_DIRTY) >>> 0;
    }
  }
}

/** Mark one slot dirty by index (no-op if out of range). */
export function markSoaDirty(buf: SceneRenderBuffer, index: number) {
  if (index < 0 || index >= buf.count) return;
  const prev = buf.flags[index];
  buf.flags[index] = (prev | SOA_FLAG_DIRTY) >>> 0;
  // Artboard FO tiles key off `buf.revision`. Without a bump, live corner-radius
  // / attr dirty keeps blitting stale tiles (sharp AABB ghost under rounded ink).
  if ((prev & SOA_FLAG_DIRTY) === 0) buf.revision += 1;
}

/** Mark one slot dirty by node id. */
export function markSoaDirtyById(buf: SceneRenderBuffer, id: string) {
  const i = buf.indexById.get(id);
  if (i == null) return;
  markSoaDirty(buf, i);
}

/** Mark canvas-idle slots dirty for nodes bound to moved frame plates. */
export function markSoaDirtyForFrameIds(
  buf: SceneRenderBuffer,
  doc: SceneDocument,
  frameIds: Set<string>
): void {
  if (!frameIds.size || buf.count <= 0) return;
  for (let i = 0; i < buf.count; i += 1) {
    if (!(buf.flags[i]! & SOA_FLAG_CANVAS_IDLE)) continue;
    const id = buf.ids[i];
    if (!id) continue;
    const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
    const frameId = String(node?.attrs?.frameId || '').trim();
    if (frameId && frameIds.has(frameId)) {
      markSoaDirty(buf, i);
    }
  }
}

/**
 * Update geometry for an existing slot (or no-op if missing).
 * Does not change kind/eligibility — use document sync for structural changes.
 */
export function upsertSoaGeom(
  buf: SceneRenderBuffer,
  id: string,
  geom: { x: number; y: number; w: number; h: number; color?: number }
): number {
  let index = buf.indexById.get(id);
  if (index == null) {
    index = allocateSoaSlot(buf);
    buf.ids[index] = id;
    buf.indexById.set(id, index);
    buf.kinds[index] = SOA_KIND_RECT;
    buf.strokeWidths[index] = 0;
    buf.strokeColors[index] = 0;
    buf.flags[index] = (SOA_FLAG_VISIBLE | SOA_FLAG_CANVAS_IDLE | SOA_FLAG_BASIC_GEOM | SOA_FLAG_DIRTY) >>> 0;
    buf.pathStart[index] = -1;
    buf.pathLen[index] = 0;
    buf.pathClosed[index] = 0;
    const ro = index * RAD_STRIDE;
    buf.radii[ro] = 0;
    buf.radii[ro + 1] = 0;
    buf.radii[ro + 2] = 0;
    buf.radii[ro + 3] = 0;
  }
  const o = index * POS_STRIDE;
  buf.positions[o] = geom.x;
  buf.positions[o + 1] = geom.y;
  buf.positions[o + 2] = Math.max(0.01, geom.w);
  buf.positions[o + 3] = Math.max(0.01, geom.h);
  if (geom.color != null) buf.colors[index] = geom.color >>> 0;
  buf.flags[index] = (buf.flags[index] | SOA_FLAG_DIRTY) >>> 0;
  invalidateShapeMesh(id);
  invalidateNodePath2D(id);
  if (buf.kinds[index] === SOA_KIND_TEXT) invalidateTextOutlineMesh(id);
  syncQuadSlot(buf, index);
  return index;
}

/**
 * Mark DOM hosts (editors / SoftGlow) off SoA canvas ink; BASIC_GEOM stays on canvas.
 * Pass `onlyIds` to evaluate a batch without scanning the full buffer.
 */
export function applySoaHostInkFlags(
  buf: SceneRenderBuffer,
  hostIds: ReadonlySet<string> | readonly string[],
  opts?: { onlyIds?: readonly string[] }
): number {
  const hosts = Array.isArray(hostIds)
    ? new Set(hostIds.filter(Boolean))
    : new Set(hostIds);

  function flipIndex(i: number): boolean {
    const id = buf.ids[i];
    if (!id) return false;
    if (buf.flags[i] & SOA_FLAG_FREE) return false;
    const kind = buf.kinds[i];
    const shapeEligible =
      kind === SOA_KIND_RECT ||
      kind === SOA_KIND_ELLIPSE ||
      kind === SOA_KIND_LINE ||
      kind === SOA_KIND_PATH ||
      kind === SOA_KIND_POLY ||
      kind === SOA_KIND_IMAGE ||
      kind === SOA_KIND_TEXT;
    if (!shapeEligible) return false;
    let flags = buf.flags[i];
    const wantInk =
      !hosts.has(id) &&
      ((flags & SOA_FLAG_BASIC_GEOM) !== 0 ||
        (flags & SOA_FLAG_ATLAS_STAMP) !== 0 ||
        kind === SOA_KIND_IMAGE ||
        kind === SOA_KIND_TEXT ||
        // Donut/arc ellipses and other vector slots may lack BASIC briefly;
        // never strip CANVAS_IDLE just because they are not BASIC_GEOM.
        kind === SOA_KIND_RECT ||
        kind === SOA_KIND_ELLIPSE ||
        kind === SOA_KIND_PATH ||
        kind === SOA_KIND_POLY ||
        kind === SOA_KIND_LINE);
    const isInk = (flags & SOA_FLAG_CANVAS_IDLE) !== 0;
    if (wantInk === isInk) return false;
    if (wantInk) flags = (flags | SOA_FLAG_CANVAS_IDLE) >>> 0;
    else flags = (flags & ~SOA_FLAG_CANVAS_IDLE) >>> 0;
    flags = (flags | SOA_FLAG_DIRTY) >>> 0;
    buf.flags[i] = flags;
    syncQuadSlot(buf, i);
    return true;
  }

  let flipped = 0;
  const only = opts?.onlyIds;
  if (only && only.length > 0) {
    for (const raw of only) {
      const id = String(raw || '');
      if (!id) continue;
      const i = buf.indexById.get(id);
      if (i == null) continue;
      if (flipIndex(i)) flipped += 1;
    }
    return flipped;
  }
  for (let i = 0; i < buf.count; i += 1) {
    if (flipIndex(i)) flipped += 1;
  }
  return flipped;
}

/**
 * Bulk write slots from document ids (import / AI flush demote path).
 * One revision bump + one path rebuild + one quadtree pass.
 */
export function bulkInsertSoaFromDocument(
  buf: SceneRenderBuffer,
  document: SceneDocument,
  ids: readonly string[]
): number {
  if (!document?.deltaSetLike) return 0;
  let wrote = 0;
  const written: string[] = [];
  for (const raw of ids) {
    const id = String(raw || '');
    if (!id || id === 'ROOT') continue;
    const node = document.deltaSetLike[id];
    if (!node) continue;
    let index = buf.indexById.get(id);
    if (index == null) {
      index = allocateSoaSlot(buf);
    }
    writeSlot(buf, index, id, node, document, { skipQuad: true });
    written.push(id);
    wrote += 1;
  }
  if (wrote > 0) {
    buf.revision += 1;
    rebuildSoaPathSamples(buf, document, { onlyIds: written });
    bulkUpsertSoaQuadtree(buf, written);
  }
  return wrote;
}

/** Module singleton used by the live stage. */
let sharedBuffer: SceneRenderBuffer | null = null;

export function getSharedSceneRenderBuffer(): SceneRenderBuffer {
  if (!sharedBuffer) sharedBuffer = createSceneRenderBuffer();
  return sharedBuffer;
}

export function resetSharedSceneRenderBuffer() {
  sharedBuffer = createSceneRenderBuffer();
  return sharedBuffer;
}
