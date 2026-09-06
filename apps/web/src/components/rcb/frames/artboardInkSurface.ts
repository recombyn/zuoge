/**
 * Per-artboard ink surface — bound SoA idle on a FO canvas via shared WebGL
 * (same mesh path as world). Plate fill + edge stay on SVG (HtmlArtboardFrame).
 *
 * Full-plate path when plate×zoom×dpr fits MAX_EDGE. Otherwise viewport tiles
 * at full wantScale (no soft mush) composite into the single FO canvas.
 */
import { nodeOwnerFrameId } from '@/components/rcb/frames/frameNodeBinding';
import { frameClipRevealsOverflow } from '@/components/rcb/selection/selectionPaintRaise';
import { getNodeTransformPreview } from '@/components/rcb/core/transformPreview';
import { readDevicePixelRatio } from '@/components/rcb/core/dpr';
import { buildNodeStackZMap } from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import {
  artboardWebglInkAvailable,
  paintArtboardWebglInk,
  releaseArtboardWebglTarget,
} from '@/components/rcb/frames/artboardWebglInk';
import {
  artboardTileNeedsPaint,
  artboardTileSceneSize,
  artboardWantScale,
  ensureArtboardTile,
  listArtboardTilesForView,
  markArtboardTilePainted,
  plateLocalView,
  artboardTileCacheStats,
} from '@/components/rcb/frames/artboardInkTiles';
import { isSoaCameraGestureActive } from '@/components/rcb/render/soaBakeLayer';
import { noteArtboardTiles } from '@/components/rcb/render/paintIntent';
import {
  getSharedSceneRenderBuffer,
  paintSoaIdleSlot,
  SOA_FLAG_CANVAS_IDLE,
  SOA_FLAG_FREE,
  SOA_FLAG_VISIBLE,
  setSoaPaintDocument,
  type SceneRenderBuffer,
} from '@/components/rcb/render/sceneRenderBuffer';
import { getSceneCanvasIdlePaint } from '@/components/rcb/render/sceneRenderer';

/**
 * Soft cap on zoom×dpr for a single full-plate ink bitmap.
 * Above this (or MAX_EDGE), viewport tile mode is required.
 */
export const ARTBOARD_INK_MAX_SCALE = 64;
/** Longest backing edge (px) so huge plates at high zoom do not OOM. */
export const ARTBOARD_INK_MAX_EDGE = 4096;

export type ArtboardInkPaintFrame = Pick<
  ArtboardFrame,
  'id' | 'x' | 'y' | 'width' | 'height'
> & {
  backgroundColor?: string;
  backgroundOpacity?: number;
};

export type ArtboardInkViewScene = {
  left?: number;
  top?: number;
  x?: number;
  y?: number;
  width: number;
  height: number;
};

type SurfaceEntry = {
  canvas: HTMLCanvasElement;
  frameId: string;
  getFrame: () => ArtboardInkPaintFrame;
  getDocument: () => SceneDocument | null;
  /** Scene viewport for tile mode (optional — full plate when missing). */
  getViewScene?: () => ArtboardInkViewScene | null;
  selected: boolean;
  highlighted: boolean;
  zoom: number;
};

const surfaces = new Map<string, SurfaceEntry>();
let paintRaf = 0;
let debugPaintStats = {
  artboardTiles: 0,
  artboardTileMode: 0,
  artboardFullPlate: 0,
};

function clampZoom(zoom: number | undefined): number {
  return Math.max(0.05, Number(zoom) || 1);
}

/** Device pixels per scene unit for artboard FO ink (under camera scale(zoom)). */
export function artboardInkScale(zoom: number, dpr = 1): number {
  const z = clampZoom(zoom);
  const ratio = Math.max(1, Number(dpr) || 1);
  return Math.min(ARTBOARD_INK_MAX_SCALE, z * ratio);
}

/** True when zoom×dpr exceeds the full-plate cap (must use viewport tiles). */
export function artboardInkBackingInsufficient(zoom: number, dpr = 1): boolean {
  const z = clampZoom(zoom);
  const ratio = Math.max(1, Number(dpr) || 1);
  return z * ratio > ARTBOARD_INK_MAX_SCALE + 1e-6;
}

/** True when full-plate bitmap at wantScale would exceed MAX_EDGE. */
export function artboardInkNeedsTileMode(
  plateW: number,
  plateH: number,
  zoom: number,
  dpr = 1
): boolean {
  const want = artboardWantScale(zoom, dpr);
  if (want > ARTBOARD_INK_MAX_SCALE + 1e-6) return true;
  const bw = Math.max(1, plateW) * want;
  const bh = Math.max(1, plateH) * want;
  return Math.max(bw, bh) > ARTBOARD_INK_MAX_EDGE + 1e-6;
}

/**
 * Size the FO canvas so CSS scene size × camera zoom maps ~1:1 to device pixels
 * (up to {@link ARTBOARD_INK_MAX_SCALE} / {@link ARTBOARD_INK_MAX_EDGE}).
 * Returns the effective scene→backing scale for paint transforms.
 */
function resizeInkCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
  scale: number
): number {
  let bw = Math.max(1, Math.round(w * scale));
  let bh = Math.max(1, Math.round(h * scale));
  let effective = scale;
  const edge = Math.max(bw, bh);
  if (edge > ARTBOARD_INK_MAX_EDGE) {
    const t = ARTBOARD_INK_MAX_EDGE / edge;
    bw = Math.max(1, Math.round(bw * t));
    bh = Math.max(1, Math.round(bh * t));
    effective = Math.min(bw / w, bh / h);
  }
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.position = 'relative';
  return effective;
}

function collectBoundIdleIndices(
  buf: SceneRenderBuffer,
  doc: SceneDocument,
  frameId: string
): number[] {
  const hiddenNodeId = String(getSceneCanvasIdlePaint()?.hiddenNodeId || '').trim();
  const indices: number[] = [];
  for (let i = 0; i < buf.count; i += 1) {
    const flags = buf.flags[i];
    if (flags & SOA_FLAG_FREE) continue;
    if (!(flags & SOA_FLAG_VISIBLE) || !(flags & SOA_FLAG_CANVAS_IDLE)) continue;
    const id = buf.ids[i];
    if (!id) continue;
    if (hiddenNodeId && id === hiddenNodeId) continue;
    if (frameClipRevealsOverflow(id)) continue;
    const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
    if (!node || nodeOwnerFrameId(node) !== frameId) continue;
    if (getNodeTransformPreview(id)?.hidden) continue;
    indices.push(i);
  }
  if (indices.length <= 1) return indices;
  const zMap = buildNodeStackZMap(
    doc,
    indices.map((i) => buf.ids[i] || '').filter(Boolean)
  );
  indices.sort((a, b) => (zMap.get(buf.ids[a] || '') ?? 0) - (zMap.get(buf.ids[b] || '') ?? 0));
  return indices;
}

/** Canvas2D survival path when shared artboard WebGL is unavailable. */
function paintArtboardInkSurface2d(
  entry: SurfaceEntry,
  frame: ArtboardInkPaintFrame,
  effective: number
): void {
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);
  const ctx = entry.canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(effective, 0, 0, effective, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const doc = entry.getDocument();
  if (!doc) return;
  setSoaPaintDocument(doc);
  const buf = getSharedSceneRenderBuffer();
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const indices = collectBoundIdleIndices(buf, doc, String(frame.id));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.translate(-fx, -fy);
  const view = { left: fx, top: fy, right: fx + w, bottom: fy + h };
  for (const i of indices) paintSoaIdleSlot(ctx, buf, i, view, doc);
  ctx.restore();
}

function paintArtboardInkTiled(
  entry: SurfaceEntry,
  frame: ArtboardInkPaintFrame,
  doc: SceneDocument,
  wantScale: number,
  dpr: number
): boolean {
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const frameId = String(frame.id);
  const gesture = isSoaCameraGestureActive();

  // Gesture: low-res full-plate proxy (fast). Settle: sharp tiles.
  if (gesture) {
    const effective = resizeInkCanvas(entry.canvas, w, h, artboardInkScale(entry.zoom, dpr));
    debugPaintStats.artboardFullPlate += 1;
    return paintArtboardWebglInk({
      targetCanvas: entry.canvas,
      frameId,
      frame: { x: fx, y: fy, width: w, height: h },
      document: doc,
      effectiveScale: effective,
      dpr,
    });
  }

  const viewScene =
    entry.getViewScene?.() ??
    ({ left: fx, top: fy, width: w, height: h } satisfies ArtboardInkViewScene);
  const local = plateLocalView({ x: fx, y: fy, width: w, height: h }, viewScene);
  if (local.width < 1e-6 || local.height < 1e-6) {
    resizeInkCanvas(entry.canvas, w, h, artboardInkScale(entry.zoom, dpr));
    const ctx = entry.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height);
    }
    return true;
  }

  // Visible region FO backing at full wantScale (clamped by MAX_EDGE for vis only).
  let visScale = wantScale;
  const visBw = local.width * visScale;
  const visBh = local.height * visScale;
  const visEdge = Math.max(visBw, visBh);
  if (visEdge > ARTBOARD_INK_MAX_EDGE) {
    visScale *= ARTBOARD_INK_MAX_EDGE / visEdge;
  }

  const canvas = entry.canvas;
  const bw = Math.max(1, Math.round(local.width * visScale));
  const bh = Math.max(1, Math.round(local.height * visScale));
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.position = 'absolute';
  canvas.style.left = `${local.left}px`;
  canvas.style.top = `${local.top}px`;
  canvas.style.width = `${local.width}px`;
  canvas.style.height = `${local.height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);

  const tileScene = artboardTileSceneSize(wantScale);
  const tiles = listArtboardTilesForView(w, h, local, tileScene);
  const buf = getSharedSceneRenderBuffer();
  // Invalidate tiles when SoA revision or wantScale changes (not every paint).
  const revision = ((buf.revision & 0xfffff) << 10) ^ (Math.round(wantScale * 64) & 0x3ff);
  let painted = 0;

  for (const bounds of tiles) {
    const tileScale = wantScale;
    const tile = ensureArtboardTile(frameId, bounds, tileScale, revision);
    if (artboardTileNeedsPaint(tile, revision) || !artboardWebglInkAvailable()) {
      const ok = paintArtboardWebglInk({
        targetCanvas: tile.canvas,
        frameId,
        frame: { x: fx, y: fy, width: w, height: h },
        document: doc,
        effectiveScale: tileScale,
        dpr,
        plateLocalView: {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
      });
      if (ok) markArtboardTilePainted(tile, revision);
      else continue;
    }
    // Blit tile → visible FO (both in plate-local; FO origin = local view).
    const dx = (bounds.left - local.left) * visScale;
    const dy = (bounds.top - local.top) * visScale;
    const dw = bounds.width * visScale;
    const dh = bounds.height * visScale;
    ctx.drawImage(tile.canvas, 0, 0, tile.canvas.width, tile.canvas.height, dx, dy, dw, dh);
    painted += 1;
  }

  debugPaintStats.artboardTileMode += 1;
  debugPaintStats.artboardTiles += painted;
  noteArtboardTiles(painted);
  return painted > 0 || tiles.length === 0;
}

/** Register a display canvas for continuous artboard ink. */
export function registerArtboardInkSurface(
  entry: Omit<SurfaceEntry, 'selected' | 'highlighted' | 'zoom'> & {
    selected?: boolean;
    highlighted?: boolean;
    zoom?: number;
  }
): () => void {
  const id = String(entry.frameId || '').trim();
  if (!id) return () => undefined;
  const full: SurfaceEntry = {
    canvas: entry.canvas,
    frameId: id,
    getFrame: entry.getFrame,
    getDocument: entry.getDocument,
    getViewScene: entry.getViewScene,
    selected: Boolean(entry.selected),
    highlighted: Boolean(entry.highlighted),
    zoom: clampZoom(entry.zoom),
  };
  surfaces.set(id, full);
  scheduleArtboardInkPaint(id);
  return () => {
    if (surfaces.get(id) === full) {
      surfaces.delete(id);
      releaseArtboardWebglTarget(id);
    }
  };
}

/** Update plate chrome flags without remounting the foreignObject canvas. */
export function updateArtboardInkChrome(
  frameId: string,
  opts: {
    selected?: boolean;
    highlighted?: boolean;
    zoom?: number;
    getViewScene?: () => ArtboardInkViewScene | null;
  }
): void {
  const entry = surfaces.get(String(frameId || '').trim());
  if (!entry) return;
  if (opts.selected != null) entry.selected = Boolean(opts.selected);
  if (opts.highlighted != null) entry.highlighted = Boolean(opts.highlighted);
  if (opts.zoom != null) entry.zoom = clampZoom(opts.zoom);
  if (opts.getViewScene) entry.getViewScene = opts.getViewScene;
  scheduleArtboardInkPaint(frameId);
}

/**
 * Repaint one plate sync, or coalesce a full restamp on the next frame.
 * Calling with an id does not also schedule a global RAF (avoids double paint).
 */
export function scheduleArtboardInkPaint(frameId?: string): void {
  if (frameId) {
    const one = surfaces.get(String(frameId).trim());
    if (one) paintArtboardInkSurface(one);
    return;
  }
  if (paintRaf) return;
  paintRaf = requestAnimationFrame(() => {
    paintRaf = 0;
    for (const entry of surfaces.values()) paintArtboardInkSurface(entry);
  });
}

export function paintArtboardInkSurface(entry: SurfaceEntry): void {
  const frame = entry.getFrame();
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);
  const dpr = Math.max(1, readDevicePixelRatio() || 1);
  const want = artboardWantScale(entry.zoom, dpr);
  const doc = entry.getDocument();

  if (doc && artboardInkNeedsTileMode(w, h, entry.zoom, dpr) && artboardWebglInkAvailable()) {
    if (paintArtboardInkTiled(entry, frame, doc, want, dpr)) return;
  }

  const scale = artboardInkScale(entry.zoom, dpr);
  const effective = resizeInkCanvas(entry.canvas, w, h, scale);
  debugPaintStats.artboardFullPlate += 1;

  if (
    doc &&
    artboardWebglInkAvailable() &&
    paintArtboardWebglInk({
      targetCanvas: entry.canvas,
      frameId: String(frame.id),
      frame: {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: w,
        height: h,
      },
      document: doc,
      effectiveScale: effective,
      dpr,
    })
  ) {
    return;
  }

  paintArtboardInkSurface2d(entry, frame, effective);
}

/** True when a SoA slot belongs to an artboard (painted on ArtboardLayer, not world ink). */
export function soaSlotIsFrameBound(
  buf: SceneRenderBuffer,
  index: number,
  doc: SceneDocument | null | undefined
): boolean {
  if (!doc) return false;
  const id = buf.ids[index];
  if (!id) return false;
  const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
  return Boolean(nodeOwnerFrameId(node));
}

/** Debug counters for `?rcbDebug=paint`. */
export function getArtboardInkDebugStats(): typeof debugPaintStats & {
  tileCache: ReturnType<typeof artboardTileCacheStats>;
} {
  return { ...debugPaintStats, tileCache: artboardTileCacheStats() };
}

export function resetArtboardInkDebugStats(): void {
  debugPaintStats = { artboardTiles: 0, artboardTileMode: 0, artboardFullPlate: 0 };
}
