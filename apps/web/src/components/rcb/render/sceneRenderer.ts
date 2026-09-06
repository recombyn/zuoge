/**
 * SceneRenderer — paint/hit backend (ADR 0027).
 * SoA/canvas owns vector + idle text/media ink; DOM hosts for FO media / SoftGlow / editors.
 */
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import type { RcbBox, RcbCamera, RcbVec } from '@/components/rcb/core/types';
import {
  SceneSpatialRuntime,
} from '@/components/rcb/core/spatialIndex';
import { rcbCameraCssZoom, rcbCameraScreenOffset, rcbViewportSceneBounds } from '@/components/rcb/core/math';
import { getShapeBaseline } from '@/components/rcb/core/geometry';
import { effectivePaintBox } from '@/components/rcb/core/transformPreview';
import {
  clampCornerRadii,
  hasLiveCornerRadiusPreview,
  mergeLiveCornerRadiiIntoAttrs,
  radiiFromAttrs,
} from '@/components/rcb/scene/document/sceneRadii';
import { getShapeHost } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  isAudioGeneratorNode,
  isImageProcessRunning,
  isLottieGeneratorNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { PROCESS_PLATE_STROKE } from '@/components/rcb/process/processGlow';
import { paintProcessPlateCanvas } from '@/components/rcb/process/processPlateSvg';
import { framePlateStrokeSceneWidth, strokeCanvasPlateHairline } from '@/components/rcb/frames/types';
import { parseLayerOpacity } from '@/components/rcb/selection/chrome/BlendModeControl';
import { generatorEmptyIconSize, generatorEmptyIconVisible } from '@/components/rcb/core/layout';
import {
  GENERATOR_EMPTY_ICON_COLOR,
} from '@/components/rcb/core/generatorEmptyIcons';
import { atlasBakePixelScale, SOA_ATLAS_INNER } from '@/components/rcb/render/webglInstanceAtlas';
import { readDevicePixelRatio } from '@/components/rcb/core/dpr';
import {
  hitTestUnifiedStackAtPoint,
  type SceneHitBox,
  type SceneStackHit,
} from '@/components/rcb/scene/document/sceneHitBridge';
import {
  buildNodeStackZMap,
  buildUnifiedHitZMap,
  maxDocumentStackZ,
  stackFrameKey,
} from '@/components/rcb/scene/document/sceneDocument';
import { frameSelId } from '@/components/rcb/selection/frameSelectionIds';
import { frameSceneAabb } from '@/components/rcb/core/spatialIndex';
import {
  effectiveEllipseArcPercentFromAttrs,
  effectiveEllipseInnerRatioFromAttrs,
  effectiveSidesFromAttrs,
  effectiveStarInnerRatioFromAttrs,
  ellipseArcEndAngles,
  ellipseStartDegFromAttrs,
  hasLiveShapeParamsPreview,
  HEAVY_PATH_D_CHARS,
  mergeLiveShapeParamsIntoAttrs,
  sceneHitSlop,
  shapeVertexPoints,
  getCachedPath2D,
  rememberNodePath2D,
} from '@/components/rcb/scene/document/sceneShapes';
export type { InkBackend } from '@/components/rcb/render/vector/inkBackend';
export { shapeInkForbidsAtlas } from '@/components/rcb/render/vector/inkBackend';
export { shapeGeomFingerprint } from '@/components/rcb/render/vector/geomFingerprint';
import {
  resolveFillColor,
  resolveStroke,
  resolveStrokeAlign,
  resolveStrokeAlignForPaint,
  resolveStrokeLinecap,
  resolveStrokeLinejoin,
  resolveStrokeMiterlimit,
  strokeCanvasAligned,
  resolveShadow,
  resolveInnerShadow,
  resolveObjectBlur,
  resolveBackdropBlur,
  hexWithOpacity,
  boolEffectAttr,
  TEXT_FRAME_PADDING,
  textFrameCornerRadii,
  type InnerShadowSpec,
} from '@/components/rcb/scene/document/sceneEffects';
import { resolveTextFramePlateFill } from '@/components/rcb/scene/document/nodeFactories';
import { strokeDashForStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import {
  isRectLikeStrokeSidesShape,
  rectStrokeSideRuns,
  traceStrokeSideRun,
} from '@/components/rcb/render/vector/strokeSides';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import {
  frameClipRevealsOverflow,
  hasFrameClipRevealOverflow,
  selectionPaintRaises,
} from '@/components/rcb/selection/selectionPaintRaise';
import { hasLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import {
  nodeNeedsPuppetWarp,
  readPuppetPins,
  samplePuppetPinsAtFrame,
} from '@/components/editor/nodes/ImageNode/puppet/puppetModel';
import { paintPuppetWarpedImage } from '@/components/rcb/scene/paint/puppetWarp';
import { getAnimationWorkbenchPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import {
  resolveFill,
  resolveLinearCoords,
  parseFillType,
  parseFillGradient,
  parseFillImageFit,
  parseFillImageRotate,
  parseFillImageAdjust,
  parseFillImageScale,
  parseFillImageOffset,
  fillImageTileSize,
  buildImageAdjustFilterCss,
  type FillStop,
  type FillGradient,
  type FillImageFit,
} from '@/components/rcb/scene/document/sceneFill';
import {
  bakeDiffuseMesh,
  normalizeMeshPoints,
} from '@/components/rcb/scene/document/sceneDiffuseMesh';
import {
  parseNodeText,
  parseNodeTextStyle,
  wrapPlainTextLines,
  textVerticalOriginY,
  measureTextEmBoxHeight,
} from '@/components/rcb/scene/document/sceneText';
import { shouldShowPixelGrid } from '@/components/rcb/selection/alignGuides';
import {
  parsePathPressures,
  parseSimplePathPoints,
  pencilInkPathFromPoints,
} from '@/components/rcb/tools/pencilBrushes';
import { pathPaintDFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import {
  getSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  isSoaBasicGeomSufficient,
  isSoaAtlasBakeEligible,
  isSoaWebglEnvEnabled,
  paintSoaBufferBasic,
  paintSoaIdleSlot,
  resolveSoaPaintBox,
  setSoaPaintDocument,
  SOA_FLAG_BASIC_GEOM,
  SOA_FLAG_CANVAS_IDLE,
  SOA_KIND_ELLIPSE,
  SOA_KIND_LINE,
  SOA_KIND_PATH,
  SOA_KIND_RECT,
} from '@/components/rcb/render/sceneRenderBuffer';
import { setSoaTextInkPainter } from '@/components/rcb/render/soaTextInkPainter';

export { isSoaBasicGeomSufficient, isSoaAtlasBakeEligible } from '@/components/rcb/render/sceneRenderBuffer';
import {
  getSharedSoaBakeCache,
  getSoaBakeCountThreshold,
  peekSoaGestureDirtyAccum,
  setSoaBakeClipDocument,
  shouldUseSoaBake,
  subscribeSoaBakeTileReady,
  unionSoaDirtyAabb,
} from '@/components/rcb/render/soaBakeLayer';
import { createWebglSceneRenderer, soaWebglInkShadersOk } from '@/components/rcb/render/webglSceneRenderer';
import { getVideoIdlePaintFrame } from '@/components/rcb/render/videoIdlePaintFrame';

/** Cap centerline samples when stroking a dense pencil/path as canvas ink. */
export const CANVAS_IDLE_STROKE_MAX_PTS = 64;

export type SceneNodeId = string;

export type DirtyRegion =
  | { kind: 'full' }
  | { kind: 'aabb'; box: RcbBox }
  | { kind: 'nodes'; ids: readonly SceneNodeId[] };

export type SceneRenderRequest = {
  document: SceneDocument;
  camera: RcbCamera;
  dirty: DirtyRegion;
  /** Unscaled stage size (layout CSS px). */
  stage: { width: number; height: number };
  dpr?: number;
};

export type SceneRendererBackend = 'svg' | 'canvas2d' | 'webgl';

export type SceneRenderer = {
  readonly backend: SceneRendererBackend;
  render(req: SceneRenderRequest): void;
  /**
   * World-space hit. Optional `screen` keeps SVG path DOM fallbacks available
   * for the svg backend until Path2D covers every shape.
   */
  hitTest(
    point: RcbVec,
    screen?: { clientX: number; clientY: number }
  ): SceneNodeId | null;
  dispose(): void;
};

export type SceneRendererHitDeps = {
  getDocument: () => SceneDocument | null | undefined;
  getSpatial: () => SceneSpatialRuntime;
  getZoom: () => number;
  listNodeIds: () => readonly string[];
  getNodeBox: (nodeId: string) => SceneHitBox | null;
  /**
   * Optional SVG hosts for DOM hit. Ignored unless {@link allowSvgDomHit}.
   * Prefer Path2D / AABB (ADR 0027).
   */
  getNodeEls?: () => Map<string, Element> | null | undefined;
  /** Default false — do not use live SVG DOM for precise hit. */
  allowSvgDomHit?: boolean;
};

/**
 * Ideal product hit (ADR 0027):
 *   SceneSpatialRuntime QT (nodes + `frame:id` plates, paint box = hit box)
 *   → permanent stackOrder top-first
 *   → first precise geometry / plate AABB wins
 *
 * Returns bare node id, or `__frame__:id` for artboard plates (see frameSelId).
 * Selection paint raise is ignored (paint-only).
 */
export function hitTestWithSpatialIndex(
  deps: SceneRendererHitDeps,
  point: RcbVec,
  screen?: { clientX: number; clientY: number }
): SceneNodeId | null {
  const target = hitTestSceneTargetWithSpatialIndex(deps, point, screen);
  if (!target) return null;
  return target.kind === 'frame' ? frameSelId(target.id) : target.id;
}

/** Typed ideal hit — prefer this over string encoding when wiring new callers. */
export function hitTestSceneTargetWithSpatialIndex(
  deps: SceneRendererHitDeps,
  point: RcbVec,
  screen?: { clientX: number; clientY: number }
): SceneStackHit | null {
  const collected = collectUnifiedHitCandidates(deps, point);
  if (!collected) return null;
  const { doc, hitOrder, pad, searchPad, spatial, rescuedIds, order } = collected;
  const allowSvgDomHit = deps.allowSvgDomHit === true;
  const buf =
    isSoaCanvasShapesEnabled() && hitOrder.length ? getSharedSceneRenderBuffer() : null;
  const hit = hitTestUnifiedStackAtPoint({
    document: doc,
    order: hitOrder,
    x: point.x,
    y: point.y,
    zoom: collected.zoom,
    screen,
    getNodeBox: deps.getNodeBox,
    nodeEls: allowSvgDomHit ? (deps.getNodeEls?.() ?? null) : null,
    allowSvgDomHit,
    soaBuf: buf && buf.count > 0 ? buf : null,
    pad,
  });
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    const allIds = deps.listNodeIds();
    const pointInBox = (
      box: { left: number; top: number; width: number; height: number } | null | undefined
    ) => {
      if (!box) return false;
      return (
        point.x >= box.left - searchPad &&
        point.x <= box.left + box.width + searchPad &&
        point.y >= box.top - searchPad &&
        point.y <= box.top + box.height + searchPad
      );
    };
    const idSource = order.length ? order.slice(0, 12) : allIds.slice(0, 24);
    const boxes = idSource.map((id) => {
      if (String(id).startsWith('frame:')) {
        return { id, box: null, containsPoint: false };
      }
      const box = deps.getNodeBox(id);
      return { id, box, containsPoint: pointInBox(box) };
    });
    (window as unknown as { __rcbHitTrace?: unknown }).__rcbHitTrace = {
      point,
      zoom: collected.zoom,
      pad,
      searchPad,
      doc: true,
      disposed: false,
      spatialSize: spatial?.size ?? -1,
      allIdsLen: allIds.length,
      orderLen: order.length,
      orderHead: order.slice(0, 8),
      rescuedIds,
      hitOrderHead: hitOrder.slice(0, 8),
      boxes,
      anyBoxContainsPoint: boxes.some((b) => b.containsPoint),
      hit,
    };
  }
  return hit;
}

/** Coarse QT + point-in-box rescue (nodes + frames) + permanent stackOrder sort. */
export function collectUnifiedHitCandidates(
  deps: SceneRendererHitDeps,
  point: RcbVec
): {
  doc: NonNullable<ReturnType<SceneRendererHitDeps['getDocument']>>;
  zoom: number;
  pad: number;
  searchPad: number;
  spatial: ReturnType<SceneRendererHitDeps['getSpatial']>;
  order: string[];
  rescuedIds: string[];
  hitOrder: string[];
} | null {
  const doc = deps.getDocument();
  if (!doc) return null;
  const zoom = Math.max(0.05, deps.getZoom() || 1);
  const pad = sceneHitSlop(zoom);
  const searchPad = pad + 64 / zoom;
  const spatial = deps.getSpatial();
  let order = spatial.hitCandidateIds({
    x: point.x,
    y: point.y,
    pad: searchPad,
  });

  const seen = new Set(order);
  const rescuedIds: string[] = [];
  const pointHitsBox = (box: {
    left: number;
    top: number;
    width: number;
    height: number;
  }) =>
    point.x >= box.left - searchPad &&
    point.x <= box.left + box.width + searchPad &&
    point.y >= box.top - searchPad &&
    point.y <= box.top + box.height + searchPad;

  // Partial stale rescue: QT may still return neighbors while the moved
  // node's indexed AABB lags getNodeBox / live plate geom.
  for (const id of deps.listNodeIds()) {
    if (seen.has(id)) continue;
    const box = deps.getNodeBox(id);
    if (!box || !pointHitsBox(box)) continue;
    rescuedIds.push(id);
    seen.add(id);
  }
  for (const frame of Array.isArray(doc.frames) ? doc.frames : []) {
    const fid = String(frame?.id || '').trim();
    if (!fid) continue;
    const key = stackFrameKey(fid);
    if (seen.has(key)) continue;
    const aabb = frameSceneAabb(doc, fid, searchPad);
    if (!aabb) continue;
    if (
      point.x < aabb.minX ||
      point.x > aabb.maxX ||
      point.y < aabb.minY ||
      point.y > aabb.maxY
    ) {
      continue;
    }
    rescuedIds.push(key);
    seen.add(key);
  }
  if (rescuedIds.length) {
    spatial.patchNodes(doc, rescuedIds, 32);
    order = [...order, ...rescuedIds];
  }

  const zMap = buildUnifiedHitZMap(doc, order);
  const rank = new Map(order.map((id, i) => [id, i]));
  const hitOrder = order.slice().sort((a, b) => {
    const za = zMap.get(a) || 0;
    const zb = zMap.get(b) || 0;
    return zb - za || (rank.get(b) || 0) - (rank.get(a) || 0);
  });

  return { doc, zoom, pad, searchPad, spatial, order, rescuedIds, hitOrder };
}

export function isFullDirty(dirty: DirtyRegion): boolean {
  return dirty.kind === 'full';
}

/**
 * Empty node dirty = "nothing to clear / nothing to paint".
 * Must not fall through to a full clearRect — that wiped idle ink after draw/paste
 * whenever a second bump arrived with dirty flags already cleared.
 */
export function isNoopSoaDirtyRegion(dirty: DirtyRegion): boolean {
  return dirty.kind === 'nodes' && dirty.ids.length === 0;
}

export function dirtyTouchesNode(dirty: DirtyRegion, nodeId: string): boolean {
  if (dirty.kind === 'full') return true;
  if (dirty.kind === 'nodes') return dirty.ids.includes(nodeId);
  return true;
}

/** Scene AABB → screen CSS px under the same camera used by Canvas2D paint. */
export function sceneBoxToScreenRect(
  box: { x: number; y: number; width: number; height: number },
  camera: RcbCamera,
  dpr = 1,
  padScene = 2
): { x: number; y: number; width: number; height: number } {
  const z = rcbCameraCssZoom(camera);
  const pan = rcbCameraScreenOffset(camera, dpr);
  const pad = padScene * z;
  const x = box.x * z + pan.x - pad;
  const y = box.y * z + pan.y - pad;
  return {
    x,
    y,
    width: Math.max(1, box.width * z) + pad * 2,
    height: Math.max(1, box.height * z) + pad * 2,
  };
}

/**
 * Prefer SoA dirty AABB for idle/promote / TransformPreview repaints.
 * Full clear only when callers pass `full`, or for live corner/params / plate
 * geometry (frameLocal children need a full erase — see RcbCanvas).
 *
 * Selection reveal must NOT force full here: any selected ink sets reveal, and
 * that would turn every paste/drag paint into a full wipe (freeze on multi-dupe).
 * Reveal *changes* call `requestIdleCanvasFullRepaint` in RcbShapesLayer instead.
 */
export function resolveSoaCanvasDirtyRegion(opts: {
  full: boolean;
  buf?: Parameters<typeof unionSoaDirtyAabb>[0] | null;
}): DirtyRegion {
  if (
    opts.full ||
    hasLiveArtboardFrameGeometry() ||
    hasLiveCornerRadiusPreview() ||
    hasLiveShapeParamsPreview()
  ) {
    return { kind: 'full' };
  }
  const buf = opts.buf;
  if (!buf || buf.count <= 0) return { kind: 'full' };
  const slotAabb = unionSoaDirtyAabb(buf);
  const accum = peekSoaGestureDirtyAccum();
  const aabb = mergeDirtyWorldAabb(slotAabb, accum);
  // No dirty slots (e.g. second blank-click after first paint cleared flags):
  // do NOT fall through to full — that re-wiped the whole idle canvas on every
  // duplicate select and felt like a freeze after long paste sessions.
  if (!aabb) return { kind: 'nodes', ids: [] };
  // Pad covers center-stroke outset + Canvas AA. clearRect + clip must use the
  // same box — a larger clear than clip leaves a transparent ring (漏出背景).
  const pad = 16;
  return {
    kind: 'aabb',
    box: {
      x: aabb.left - pad,
      y: aabb.top - pad,
      width: aabb.width + pad * 2,
      height: aabb.height + pad * 2,
    },
  };
}

function mergeDirtyWorldAabb(
  slot: { left: number; top: number; width: number; height: number } | null,
  accum: { left: number; top: number; width: number; height: number } | null
): { left: number; top: number; width: number; height: number } | null {
  if (!slot) return accum;
  if (!accum) return slot;
  const left = Math.min(slot.left, accum.left);
  const top = Math.min(slot.top, accum.top);
  const right = Math.max(slot.left + slot.width, accum.left + accum.width);
  const bottom = Math.max(slot.top + slot.height, accum.top + accum.height);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Live SVG hosts remain the paint path; this adapter owns the hit contract. */
export function createSvgSceneRenderer(deps: SceneRendererHitDeps): SceneRenderer {
  let disposed = false;
  return {
    backend: 'svg',
    render(_req) {
      // Full hosts stay in RcbShapesLayer until more ink migrates to Canvas.
    },
    hitTest(point, screen) {
      // Never no-op hit after dispose — bridge may briefly retain this instance
      // across React effect reorder; precise hit is pure and safe.
      if (disposed && typeof window !== 'undefined') {
        (window as unknown as { __rcbHitDisposed?: boolean }).__rcbHitDisposed = true;
      }
      return hitTestWithSpatialIndex(deps, point, screen);
    },
    dispose() {
      disposed = true;
    },
  };
}

export type CanvasSceneRendererDeps = SceneRendererHitDeps & {
  canvas: HTMLCanvasElement;
  /** Debug AABB outlines (default false — idle Canvas has its own paint path). */
  drawNodeProxies?: boolean;
  /**
   * Paint filled rect / ellipse / circle for shape nodes in the viewport.
   * Default false on the grid canvas.
   */
  drawBasicShapes?: boolean;
  /**
   * SoA / canvas vector ink (paths, shapes, media posters).
   * Shape ink canvas enables this; ids from `getSceneCanvasIdlePaint()`.
   */
  drawCanvasIdle?: boolean;
  /** Pixel / scene grid (default true). Gated by `shouldShowGrid`. */
  paintGrid?: boolean;
  gridSize?: number;
  getGridSize?: () => number;
  shouldShowGrid?: (zoom: number) => boolean;
};

function soaSlotIsBasicInk(
  buf: ReturnType<typeof getSharedSceneRenderBuffer>,
  index: number
): boolean {
  const flags = buf.flags[index];
  return (flags & SOA_FLAG_CANVAS_IDLE) !== 0 && (flags & SOA_FLAG_BASIC_GEOM) !== 0;
}

function paintBoxMissesAabb(
  paint: { left: number; top: number; width: number; height: number },
  aabb: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    paint.left + paint.width < aabb.x ||
    paint.top + paint.height < aabb.y ||
    paint.left > aabb.x + aabb.width ||
    paint.top > aabb.y + aabb.height
  );
}

function sortIdsByDocumentZ(
  doc: SceneDocument | null | undefined,
  ids: readonly string[]
): string[] {
  if (!doc || ids.length < 2) return ids.slice();
  const zMap = buildNodeStackZMap(doc, ids);
  const raisedZ = maxDocumentStackZ(doc) + 1;
  const rank = new Map(ids.map((id, i) => [id, i]));
  return ids.slice().sort((a, b) => {
    // Selection temporary raise → current canvas max + 1 (single-select only).
    const za = selectionPaintRaises(a) ? raisedZ : zMap.get(a) || 0;
    const zb = selectionPaintRaises(b) ? raisedZ : zMap.get(b) || 0;
    return za - zb || (zMap.get(a) || 0) - (zMap.get(b) || 0) || (rank.get(a) || 0) - (rank.get(b) || 0);
  });
}

function paintZOrderedCanvasInk(opts: {
  ctx: CanvasRenderingContext2D;
  deps: CanvasSceneRendererDeps;
  doc: SceneDocument;
  ids: readonly string[];
  soaBuf: ReturnType<typeof getSharedSceneRenderBuffer> | null;
  dirty: DirtyRegion;
  aabbDirty: RcbBox | null;
  view: RcbBox;
  zoom: number;
  drawIdle: boolean;
  drawBasic: boolean;
  drawProxies: boolean;
}): void {
  const {
    ctx,
    deps,
    doc,
    ids,
    soaBuf,
    dirty,
    aabbDirty,
    view,
    zoom,
    drawIdle,
    drawBasic,
    drawProxies,
  } = opts;
  const paintIds = sortIdsByDocumentZ(doc, ids);
  const viewBox = {
    left: view.x,
    top: view.y,
    right: view.x + view.width,
    bottom: view.y + view.height,
  };
  for (const id of paintIds) {
    if (!dirtyTouchesNode(dirty, id)) continue;
    if (getShapeHost(id)?.el) continue;
    const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
    if (!node) continue;
    const si = soaBuf?.indexById.get(id);
    if (soaBuf && si != null && soaSlotIsBasicInk(soaBuf, si)) {
      if (aabbDirty) {
        const { x, y, w, h } = resolveSoaPaintBox(soaBuf, si, doc);
        // Include outline stroke so neighbors overlapping the cleared AABB by
        // stroke fringe still repaint (avoids transparent seams / 漏出背景).
        const sw = Math.max(0, soaBuf.strokeWidths[si] || 0);
        const outset = sw > 0 ? sw : 0;
        if (
          paintBoxMissesAabb(
            {
              left: x - outset,
              top: y - outset,
              width: w + outset * 2,
              height: h + outset * 2,
            },
            aabbDirty
          )
        ) {
          continue;
        }
      }
      paintSoaIdleSlot(ctx, soaBuf, si, viewBox, doc);
      continue;
    }
    const box = deps.getNodeBox(id);
    if (!box) continue;
    const paint = effectivePaintBox(id, box, Number(node.attrs?.angle) || 0);
    if (
      !aabbIntersectsView(
        { left: paint.left, top: paint.top, width: paint.width, height: paint.height },
        view
      )
    ) {
      continue;
    }
    if (aabbDirty && paintBoxMissesAabb(paint, aabbDirty)) continue;
    if (drawIdle) {
      paintCanvasIdleNode(ctx, {
        left: paint.left,
        top: paint.top,
        width: paint.width,
        height: paint.height,
        angle: paint.angle,
        node,
        zoom,
        document: doc,
      });
    } else if (drawBasic) {
      paintBasicShapeFill(ctx, {
        left: paint.left,
        top: paint.top,
        width: paint.width,
        height: paint.height,
        angle: paint.angle,
        fill: resolveNodeProxyFill(node),
        shapeType: String(node.attrs?.shapeType || node.key || ''),
        opacity: Math.min(1, Math.max(0.15, parseLayerOpacity(node.attrs?.opacity, 1) || 0.15)),
      });
    }
    if (!drawProxies) continue;
    ctx.fillStyle = 'rgba(51,136,255,0.06)';
    ctx.strokeStyle = 'rgba(51,136,255,0.35)';
    ctx.lineWidth = 1 / zoom;
    ctx.fillRect(paint.left, paint.top, paint.width, paint.height);
    ctx.strokeRect(paint.left, paint.top, paint.width, paint.height);
  }
}

/**
 * Canvas2D backend — grid surface + Vitest SoA paint helpers.
 * Product idle ink uses WebGL (see createSceneRenderer).
 */
export function createCanvasSceneRenderer(deps: CanvasSceneRendererDeps): SceneRenderer {
  let disposed = false;
  const canvas = deps.canvas;
  const drawProxies = deps.drawNodeProxies === true;
  const drawBasic = deps.drawBasicShapes === true;
  const drawIdle = deps.drawCanvasIdle === true;
  const paintGrid = deps.paintGrid !== false;
  const shouldShowGrid = deps.shouldShowGrid ?? shouldShowPixelGrid;

  const resolveGridSize = () => {
    const fromGetter = deps.getGridSize?.();
    if (fromGetter != null && fromGetter > 0) return fromGetter;
    return Math.max(1, deps.gridSize || 8);
  };

  const getCtx = () => {
    try {
      return canvas.getContext('2d');
    } catch {
      return null;
    }
  };

  return {
    backend: 'canvas2d',
    render(req) {
      ensureSoaBakeTileReadyBridge();
      if (disposed) return;
      const ctx = getCtx();
      if (!ctx) return;
      const dpr = req.dpr && req.dpr > 0 ? req.dpr : 1;
      const sw = Math.max(1, req.stage.width);
      const sh = Math.max(1, req.stage.height);
      const bw = Math.max(1, Math.round(sw * dpr));
      const bh = Math.max(1, Math.round(sh * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      canvas.style.width = `${sw}px`;
      canvas.style.height = `${sh}px`;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Empty dirty: leave the retained canvas alone (see isNoopSoaDirtyRegion).
      if (isNoopSoaDirtyRegion(req.dirty)) return;

      const z = rcbCameraCssZoom(req.camera);
      const pan = rcbCameraScreenOffset(req.camera, dpr);
      const aabbDirty = req.dirty.kind === 'aabb' ? req.dirty.box : null;
      const usePartialClear = Boolean(aabbDirty) && !isFullDirty(req.dirty);

      if (usePartialClear && aabbDirty) {
        // padScene=0: aabbDirty already includes stroke/AA pad. Extra screen pad
        // here used to clear past the clip rect and leave transparent seams.
        const scr = sceneBoxToScreenRect(aabbDirty, req.camera, dpr, 0);
        ctx.clearRect(scr.x, scr.y, scr.width, scr.height);
      } else {
        ctx.clearRect(0, 0, sw, sh);
      }

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(z, z);

      const view = rcbViewportSceneBounds(req.camera, { width: sw, height: sh }, dpr);
      const gridSize = resolveGridSize();

      if (usePartialClear && aabbDirty) {
        ctx.beginPath();
        ctx.rect(aabbDirty.x, aabbDirty.y, aabbDirty.width, aabbDirty.height);
        ctx.clip();
      }

      if (paintGrid && shouldShowGrid(z)) {
        drawSceneGrid(ctx, view, gridSize, z);
      }

      if (!(drawIdle || drawBasic || drawProxies)) {
        ctx.restore();
        return;
      }

      const doc = req.document;
      const ids = deps.listNodeIds();
      const soaOn = isSoaCanvasShapesEnabled();
      const soaBuf = soaOn ? getSharedSceneRenderBuffer() : null;
      setSoaBakeClipDocument(doc);
      setSoaPaintDocument(doc);

      // Product bake is WebGL atlas-only. This Canvas2D renderer is grid + Vitest.
      paintZOrderedCanvasInk({
        ctx,
        deps,
        doc,
        ids,
        soaBuf,
        dirty: req.dirty,
        aabbDirty,
        view,
        zoom: z,
        drawIdle,
        drawBasic,
        drawProxies,
      });
      ctx.restore();
    },
    hitTest(point, screen) {
      // Same as svg adapter: do not no-op hit after dispose while a bridge may
      // still point here across React effect reorder.
      if (disposed && typeof window !== 'undefined') {
        (window as unknown as { __rcbHitDisposed?: boolean }).__rcbHitDisposed = true;
      }
      return hitTestWithSpatialIndex(deps, point, screen);
    },
    dispose() {
      disposed = true;
      const ctx = getCtx();
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    },
  };
}

function aabbIntersectsView(
  box: SceneHitBox,
  view: RcbBox
): boolean {
  return (
    box.left < view.x + view.width &&
    box.left + box.width > view.x &&
    box.top < view.y + view.height &&
    box.top + box.height > view.y
  );
}

/** Match SVG pixel-grid stroke: ~1 screen px, capped vs cell size. */
export function sceneGridLineWidth(gridSize: number, zoom: number): number {
  const g = gridSize > 0 ? gridSize : 1;
  const z = Math.max(0.05, zoom || 1);
  return Math.min(g * 0.35, 1 / z);
}

/**
 * Scene-space lattice for the Canvas grid surface (camera already applied on ctx).
 * Axes are exact multiples of `gridSize` — same lattice as `snapCoordToGrid` /
 * pen tips. Do not device-snap axes here: that shifted lines off the snap grid
 * (visible mid-cell tips / off-grid plates at high zoom).
 */
export function drawSceneGrid(
  ctx: CanvasRenderingContext2D,
  view: RcbBox,
  gridSize: number,
  zoom = 1
) {
  const g = gridSize > 0 ? gridSize : 1;
  const z = Math.max(0.05, zoom || 1);
  const x0 = Math.floor(view.x / g) * g;
  const y0 = Math.floor(view.y / g) * g;
  const x1 = view.x + view.width;
  const y1 = view.y + view.height;
  const lineW = sceneGridLineWidth(g, z);

  ctx.beginPath();
  ctx.strokeStyle = resolveGridStrokeStyle();
  ctx.lineWidth = lineW;
  ctx.lineCap = 'butt';
  for (let x = x0; x <= x1 + 1e-6; x += g) {
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
  }
  for (let y = y0; y <= y1 + 1e-6; y += g) {
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
}

function resolveGridStrokeStyle(): string {
  if (typeof document === 'undefined') return 'rgba(120,120,120,0.35)';
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--line').trim();
    if (raw) return mixLineStroke(raw, 0.5);
  } catch {
    /* ignore */
  }
  return 'rgba(120,120,120,0.35)';
}

function mixLineStroke(cssColor: string, alpha: number): string {
  const c = cssColor.trim();
  if (c.startsWith('#') && (c.length === 7 || c.length === 4)) {
    const hex =
      c.length === 4
        ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`
        : c;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if ([r, g, b].every((n) => Number.isFinite(n))) {
      return `rgba(${r},${g},${b},${alpha})`;
    }
  }
  return `color-mix(in srgb, ${c} ${Math.round(alpha * 100)}%, transparent)`;
}

export function resolveNodeProxyFill(node: SceneNodeInput): string {
  const a = node?.attrs || {};
  const solid = String(a['fill-color'] || '').trim();
  if (solid && solid !== 'none' && solid !== 'transparent') return solid;
  const fillType = parseFillType(a['fill-type']);
  if (fillType !== 'solid' && fillType !== 'image' && a['fill-gradient'] != null) {
    const g = parseFillGradient(a['fill-gradient'], fillType, solid || '#FFFFFF');
    const stop = String(g.colorStops?.[0]?.color || '').trim();
    if (stop && stop !== 'none' && stop !== 'transparent') return stop;
  }
  const stroke = String(a['border-color'] || '').trim();
  if (stroke && stroke !== 'none' && stroke !== 'transparent') return stroke;
  return '#94a3b8';
}

export type BasicShapePaintOpts = {
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
  fill: string;
  shapeType: string;
  opacity?: number;
};

/**
 * Filled rect / ellipse / circle (SoA canvas ink + CanvasSceneRenderer basic shapes).
 * Local origin when angle≠0: caller may already have translated; here we own transform.
 */
export function paintBasicShapeFill(
  ctx: CanvasRenderingContext2D,
  opts: BasicShapePaintOpts
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const left = opts.left;
  const top = opts.top;
  const angle = Number(opts.angle) || 0;
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const t = String(opts.shapeType || '').toLowerCase();
  const isEllipse = t === 'ellipse' || t === 'circle' || t === 'oval';

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = opts.fill || '#94a3b8';

  if (Math.abs(angle) > 0.5) {
    const cx = left + w / 2;
    const cy = top + h / 2;
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-w / 2, -h / 2);
    if (isEllipse) {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(0, 0, w, h);
    }
  } else if (isEllipse) {
    ctx.beginPath();
    ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(left, top, w, h);
  }
  ctx.restore();
}

function isTransparentCssColor(c: string): boolean {
  const s = String(c || '')
    .trim()
    .toLowerCase();
  return !s || s === 'none' || s === 'transparent' || s === 'rgba(0,0,0,0)';
}

/**
 * Vectors that paint on the SoA / canvas ink surface (ADR 0027).
 *
 * Product WebGL draws BASIC_GEOM (+ atlas stamps for paths / boolean). Nodes that
 * must interleave above artboard plates still promote to DOM hosts on the shared
 * stack mount (`worldNodeStacksAboveAnyFrame`).
 *
 * Vitest (WebGL off): broader rich idle for Canvas2D paint helpers.
 *
 * DOM hosts always: lottie/group, backdrop-blur, SoftGlow / editors.
 */
export function canIdlePaintOnCanvas(node: SceneNodeInput | null | undefined): boolean {
  if (!node) return false;
  if (isImageProcessRunning(node)) return false;
  const key = String(node.key || '');
  if (key === 'lottie' || key === 'group') {
    return false;
  }

  const attrs = node.attrs || {};

  if (resolveBackdropBlur(node)) {
    return false;
  }

  // Audio / Lottie generators stay DomHost (HTML decoder / player).
  // Empty image/video generator plates: atlas restamp at zoomBucket (not forever SVG).
  if (isAudioGeneratorNode(node) || isLottieGeneratorNode(node)) return false;

  // Product WebGL: basic geom + Canvas2D Path2D for rich fills; media/text idle.
  // Lottie stays DOM. Puppet-warp images stay DOM hosts.
  // StackOrder above plates still promotes to hosts (shared mount data-z).
  if (isSoaWebglEnvEnabled()) {
    if (key === 'lottie' || key === 'group') {
      return false;
    }
    if (key === 'text' || key === 'audio') return true;
    if (key === 'image' || key === 'video') {
      if (nodeNeedsPuppetWarp(node)) return false;
      // Cross-origin without CORS cannot stamp into WebGL — keep a DOM host.
      const src = mediaPaintSrc(node);
      if (src && isFillImageWebglUnsafe(src)) return false;
      return true;
    }
    if (isSoaBasicGeomSufficient(node)) return true;
    return isSoaAtlasBakeEligible(node);
  }

  if (key === 'text') return true;
  if (key === 'image' || key === 'video' || key === 'audio') return true;

  const fillType = String(attrs['fill-type'] || 'solid').toLowerCase();
  const solidOk =
    fillType === 'solid' ||
    fillType === '' ||
    fillType === 'linear' ||
    fillType === 'radial' ||
    fillType === 'angular' ||
    fillType === 'image' ||
    fillType === 'diffuse';
  if (!solidOk) return false;

  const t = String(attrs.shapeType || (key === 'shape' ? 'rect' : key) || '').toLowerCase();
  if (t === 'rect' || t === 'roundrect' || t === '') return true;
  if (t === 'circle' || t === 'ellipse' || t === 'oval') return true;
  if (t === 'line' || t === 'arrow') return true;
  if (t === 'triangle' || t === 'polygon' || t === 'star') return true;

  if (t === 'pencil' || t === 'pen' || t === 'path' || key === 'path') {
    const d = String(attrs.path || '').trim();
    if (!d || d.length >= HEAVY_PATH_D_CHARS) return false;
    return true;
  }

  return false;
}

/** True when idle paint must bake object blur / inner-shadow offscreen. */
export function nodeNeedsCanvasEffectBake(node: SceneNodeInput | null | undefined): boolean {
  if (!node) return false;
  if (resolveObjectBlur(node)) return true;
  if (resolveInnerShadow(node)) return true;
  return false;
}

const BLEND_COMPOSITE: Record<string, GlobalCompositeOperation> = {
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/** Map CSS blendMode → Canvas2D composite; null for normal / pass-through. */
export function canvasCompositeFromBlendMode(
  mode: string | null | undefined
): GlobalCompositeOperation | null {
  const m = String(mode || 'normal')
    .trim()
    .toLowerCase();
  if (!m || m === 'normal' || m === 'pass-through' || m === 'passthrough') return null;
  return BLEND_COMPOSITE[m] || null;
}

const idleTextOutlineByKey = new Map<string, string>();

function idleTextOutlineKey(node: SceneNodeInput): string {
  const id = String(node.id || '').trim();
  if (id) return `id:${id}`;
  return `anon:${parseNodeText(node.attrs || {})}`;
}

export function clearIdleTextOutlineCache(): void {
  idleTextOutlineByKey.clear();
}

export function primeIdleTextOutlineCache(node: SceneNodeInput, d: string): void {
  const pathD = String(d || '').trim();
  if (!pathD) return;
  idleTextOutlineByKey.set(idleTextOutlineKey(node), pathD);
}

function getIdleTextOutlinePath(node: SceneNodeInput): Path2D | null {
  if (typeof Path2D === 'undefined') return null;
  const d = idleTextOutlineByKey.get(idleTextOutlineKey(node));
  if (!d) return null;
  return getCachedPath2D(d);
}

function allocPaintSurface(
  w: number,
  h: number
): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const tw = Math.max(1, Math.ceil(w));
  const th = Math.max(1, Math.ceil(h));
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const off = new OffscreenCanvas(tw, th);
      const octx = off.getContext('2d') as CanvasRenderingContext2D | null;
      if (octx) return { canvas: off, ctx: octx };
    } catch {
      /* fall through to HTMLCanvasElement */
    }
  }
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  return { canvas: c, ctx };
}

function paintLocalInkWithObjectEffects(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    paintCore: (c: CanvasRenderingContext2D) => void;
  }
): void {
  const blur = resolveObjectBlur(opts.node);
  const inner = resolveInnerShadow(opts.node);
  if (!blur && !inner) {
    opts.paintCore(ctx);
    return;
  }
  const pad = Math.ceil((blur?.blur || 0) + (inner?.blur || 0) + 8);
  const surface = allocPaintSurface(opts.width + pad * 2, opts.height + pad * 2);
  if (!surface) {
    opts.paintCore(ctx);
    return;
  }
  const { canvas: off, ctx: octx } = surface;
  octx.translate(pad, pad);
  opts.paintCore(octx);

  if (inner) {
    octx.save();
    octx.globalCompositeOperation = 'source-atop';
    octx.shadowColor = inner.color;
    octx.shadowBlur = inner.blur;
    octx.shadowOffsetX = inner.offsetX;
    octx.shadowOffsetY = inner.offsetY;
    octx.fillStyle = '#000';
    octx.fillRect(-pad, -pad, off.width, off.height);
    octx.restore();
  }

  ctx.save();
  if (blur && blur.blur > 0) {
    ctx.filter = `blur(${blur.blur / 2}px)`;
  }
  ctx.drawImage(off as CanvasImageSource, -pad, -pad);
  ctx.filter = 'none';
  ctx.restore();
}

function paintLocalInkWithBlend(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    paintCore: (c: CanvasRenderingContext2D) => void;
  }
): void {
  const composite = canvasCompositeFromBlendMode(String(opts.node.attrs?.blendMode || ''));
  if (!composite) {
    paintLocalInkWithObjectEffects(ctx, opts);
    return;
  }
  const surface = allocPaintSurface(opts.width, opts.height);
  if (!surface) {
    paintLocalInkWithObjectEffects(ctx, opts);
    return;
  }
  const { canvas: off, ctx: octx } = surface;
  paintLocalInkWithObjectEffects(octx, { ...opts, paintCore: opts.paintCore });
  ctx.save();
  try {
    const sample = ctx.getImageData(0, 0, off.width, off.height);
    const under = allocPaintSurface(off.width, off.height);
    if (under) {
      under.ctx.putImageData(sample, 0, 0);
      ctx.drawImage(under.canvas as CanvasImageSource, 0, 0);
    }
  } catch {
    /* tainted / security — skip underlay sample */
  }
  ctx.globalCompositeOperation = composite;
  ctx.drawImage(off as CanvasImageSource, 0, 0);
  ctx.restore();
}

function addCanvasGradientStops(
  gradient: CanvasGradient,
  stops: FillStop[] | undefined,
  opacityPct: number
) {
  const global = Math.max(0, Math.min(100, Number(opacityPct) || 100)) / 100;
  const list =
    Array.isArray(stops) && stops.length
      ? stops
      : [
          { offset: 0, color: '#000' },
          { offset: 1, color: '#fff' },
        ];
  for (const s of list) {
    const local = Math.max(0, Math.min(100, Number(s.opacity ?? 100))) / 100;
    const offset = Math.max(0, Math.min(1, Number(s.offset) || 0));
    const color = hexWithOpacity(String(s.color || '#000'), Math.round(global * local * 100));
    try {
      gradient.addColorStop(offset, color);
    } catch {
      /* ignore invalid stop */
    }
  }
}

/**
 * Match `bakeAngularGradientDataUrl`: start = (angle - 90)° in radians, center from cx/cy %.
 * Returns null when `createConicGradient` is unavailable.
 */
export function createCanvasAngularGradient(
  ctx: CanvasRenderingContext2D,
  gradient: FillGradient,
  w: number,
  h: number,
  opacityPct = 100
): CanvasGradient | null {
  const createConic = (
    ctx as CanvasRenderingContext2D & {
      createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient;
    }
  ).createConicGradient;
  if (typeof createConic !== 'function') return null;
  const cx = (Math.max(0, Math.min(100, Number(gradient.cx) || 50)) / 100) * w;
  const cy = (Math.max(0, Math.min(100, Number(gradient.cy) || 50)) / 100) * h;
  const start = (((Number(gradient.angle) || 0) - 90) * Math.PI) / 180;
  const g = createConic.call(ctx, start, cx, cy);
  addCanvasGradientStops(g, gradient.colorStops, opacityPct);
  return g;
}

/**
 * Canvas fill style for a node box (local 0,0 → w×h).
 * Returns null when there is no fill, or when the fill is image/diffuse (use `fillCanvasShapeGeometry`).
 * Angular uses native conic when available; otherwise falls back to radial.
 */
export function resolveCanvasFillStyle(
  ctx: CanvasRenderingContext2D,
  node: SceneNodeInput,
  w: number,
  h: number,
  fallback = '#FFFFFF'
): string | CanvasGradient | null {
  const attrs = node.attrs || {};
  const fillType = parseFillType(attrs['fill-type']);
  const opacityPct = Number(attrs['fill-opacity'] ?? 100);

  if (fillType === 'image' || fillType === 'diffuse') return null;

  // resolveFill bakes angular → pattern for SVG; handle conic natively here.
  if (fillType === 'angular') {
    const solid = String(attrs['fill-color'] || fallback);
    const gradient = parseFillGradient(attrs['fill-gradient'], 'angular', solid);
    gradient.type = 'angular';
    const conic = createCanvasAngularGradient(ctx, gradient, w, h, opacityPct);
    if (conic) return conic;
    // No conic API: approximate with radial so idle Canvas still paints something.
    const cx = ((Number(gradient.cx) || 50) / 100) * w;
    const cy = ((Number(gradient.cy) || 50) / 100) * h;
    const halfDiag = Math.sqrt(w * w + h * h) / 2;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(1, halfDiag));
    addCanvasGradientStops(g, gradient.colorStops, opacityPct);
    return g;
  }

  const paint = resolveFill(node, fallback);
  if (paint.kind === 'none') return null;
  if (paint.kind === 'solid') return paint.color;
  if (paint.kind === 'linear') {
    const c = resolveLinearCoords(paint.gradient);
    const g = ctx.createLinearGradient(c.x1 * w, c.y1 * h, c.x2 * w, c.y2 * h);
    addCanvasGradientStops(g, paint.gradient.colorStops, paint.opacityPct);
    return g;
  }
  if (paint.kind === 'radial') {
    const cx = ((Number(paint.gradient.cx) || 50) / 100) * w;
    const cy = ((Number(paint.gradient.cy) || 50) / 100) * h;
    const halfDiag = Math.sqrt(w * w + h * h) / 2;
    const r = Math.max(1, halfDiag * ((Number(paint.gradient.r) || 50) / 100));
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    addCanvasGradientStops(g, paint.gradient.colorStops, paint.opacityPct);
    return g;
  }
  return null;
}

/** Cap diffuse bake resolution (matches `bakeDiffuseMeshDataUrl`). */
const DIFFUSE_BAKE_MAX_SIDE = 384;
const FILL_IMAGE_CACHE_MAX = 64;
const DIFFUSE_BAKE_CACHE_MAX = 24;

const fillImageCache = new Map<string, CanvasImageSource>();
/** Srcs that painted a non-readable canvas (CORS) — never stamp into WebGL atlas. */
const fillImageWebglUnsafe = new Set<string>();
const diffuseBakeCache = new Map<string, HTMLCanvasElement>();

/** True when canvas pixels can be read (safe to upload to WebGL). */
export function canvasPixelsReadable(
  canvas: HTMLCanvasElement | OffscreenCanvas | null | undefined
): boolean {
  if (!canvas) return false;
  try {
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return false;
    ctx.getImageData(0, 0, 1, 1);
    return true;
  } catch {
    return false;
  }
}

/** Remote http(s) need CORS for WebGL atlas; blob/data are same-document. */
function fillImageShouldUseCors(url: string): boolean {
  const u = String(url || '').trim();
  if (!u) return false;
  if (u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('file:')) return false;
  return /^https?:\/\//i.test(u) || u.startsWith('//');
}

export function isFillImageWebglUnsafe(src: string): boolean {
  return fillImageWebglUnsafe.has(String(src || '').trim());
}

export function markFillImageWebglUnsafe(src: string): void {
  const url = String(src || '').trim();
  if (url) fillImageWebglUnsafe.add(url);
}
export function imageSourceSize(img: CanvasImageSource): { iw: number; ih: number } {
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return { iw: img.naturalWidth || img.width || 1, ih: img.naturalHeight || img.height || 1 };
  }
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    return { iw: img.width || 1, ih: img.height || 1 };
  }
  const anyImg = img as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
  return {
    iw: anyImg.naturalWidth || anyImg.width || 1,
    ih: anyImg.naturalHeight || anyImg.height || 1,
  };
}

/** Sync image ready for fill paint. Starts decode when missing; on load bumps idle ink. */
export function getFillImageReady(src: string): CanvasImageSource | null {
  const url = String(src || '').trim();
  if (!url) return null;
  const cached = fillImageCache.get(url);
  if (cached) {
    if (typeof HTMLImageElement !== 'undefined' && cached instanceof HTMLImageElement) {
      // Legacy cache entries loaded without CORS would taint the WebGL atlas.
      if (fillImageShouldUseCors(url) && cached.crossOrigin !== 'anonymous') {
        fillImageCache.delete(url);
      } else if (cached.complete && (cached.naturalWidth || cached.width)) {
        return cached;
      } else {
        return null;
      }
    } else {
      return cached;
    }
  }
  if (typeof Image === 'undefined') return null;
  if (fillImageCache.size >= FILL_IMAGE_CACHE_MAX) {
    const oldest = fillImageCache.keys().next().value;
    if (oldest != null) fillImageCache.delete(oldest);
  }
  const img = new Image();
  img.decoding = 'async';
  // Required so bake → atlas → texImage2D is not tainted by cross-origin bitmaps.
  if (fillImageShouldUseCors(url)) {
    img.crossOrigin = 'anonymous';
  }
  img.src = url;
  fillImageCache.set(url, img);
  if (img.complete && (img.naturalWidth || img.width)) return img;
  if (!(img as HTMLImageElement & { __fillNotify?: boolean }).__fillNotify) {
    (img as HTMLImageElement & { __fillNotify?: boolean }).__fillNotify = true;
    img.addEventListener(
      'load',
      () => {
        bumpSceneCanvasIdlePaint();
      },
      { once: true }
    );
    img.addEventListener(
      'error',
      () => {
        // CORS failure with crossOrigin=anonymous — do not keep stamping/bumping.
        markFillImageWebglUnsafe(url);
        fillImageCache.delete(url);
      },
      { once: true }
    );
  }
  return null;
}

/** Test helper: seed a decoded fill image / canvas (skips network / decode). */
export function setFillImageCacheEntry(src: string, img: CanvasImageSource): void {
  const url = String(src || '').trim();
  if (!url) return;
  fillImageCache.set(url, img);
}

/** Test / dispose helper. */
export function clearFillImageCache(): void {
  fillImageCache.clear();
  fillImageWebglUnsafe.clear();
  diffuseBakeCache.clear();
}

function getDiffuseBakeCanvas(
  node: SceneNodeInput,
  w: number,
  h: number
): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const attrs = node.attrs || {};
  const solid = String(attrs['fill-color'] || '#CCCCCC');
  const opacityPct = Number(attrs['fill-opacity'] ?? 100);
  const gradient = parseFillGradient(attrs['fill-gradient'], 'diffuse', solid);
  gradient.type = 'diffuse';
  const meshSizeRaw = Number(gradient.meshSize) || 4;
  const meshSize = Math.min(8, Math.max(3, Math.round(meshSizeRaw))) as 3 | 4 | 5 | 6 | 7 | 8;
  const points = normalizeMeshPoints(gradient.meshPoints, meshSize, solid);
  const scale = Math.min(1, DIFFUSE_BAKE_MAX_SIDE / Math.max(w, h, 1));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const key = `${cw}x${ch}:${opacityPct}:${meshSize}:${points.map((p) => `${p.x},${p.y},${p.color}`).join(';')}`;
  const hit = diffuseBakeCache.get(key);
  if (hit) return hit;
  let baked: HTMLCanvasElement;
  try {
    baked = bakeDiffuseMesh(cw, ch, points, opacityPct);
  } catch {
    return null;
  }
  if (diffuseBakeCache.size >= DIFFUSE_BAKE_CACHE_MAX) {
    const oldest = diffuseBakeCache.keys().next().value;
    if (oldest != null) diffuseBakeCache.delete(oldest);
  }
  diffuseBakeCache.set(key, baked);
  return baked;
}

/** Draw source into box with SVG-aligned fit (fit=contain, fill/crop=cover, tile=repeat cell). */
export function drawFillImageInBox(
  ctx: CanvasRenderingContext2D,
  img: CanvasImageSource,
  boxW: number,
  boxH: number,
  fit: FillImageFit,
  rotate: number,
  opts?: {
    scalePct?: number;
    offsetXPct?: number;
    offsetYPct?: number;
  }
): void {
  const { iw, ih } = imageSourceSize(img);
  if (iw < 1 || ih < 1) return;
  const scaleMul = Math.max(0.01, Number(opts?.scalePct ?? 100) / 100);
  const offsetXPct = Number(opts?.offsetXPct ?? 0);
  const offsetYPct = Number(opts?.offsetYPct ?? 0);

  if (fit === 'tile') {
    const tile = fillImageTileSize(iw, ih, opts?.scalePct ?? 100);
    const scale = Math.max(tile.w / iw, tile.h / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const ox = (tile.w - dw) / 2 + (offsetXPct / 100) * tile.w;
    const oy = (tile.h - dh) / 2 + (offsetYPct / 100) * tile.h;
    for (let y = 0; y < boxH; y += tile.h) {
      for (let x = 0; x < boxW; x += tile.w) {
        ctx.drawImage(img, x + ox, y + oy, dw, dh);
      }
    }
    return;
  }

  ctx.save();
  ctx.translate(boxW / 2, boxH / 2);
  if (rotate) ctx.rotate((rotate * Math.PI) / 180);
  const destW = boxW;
  const destH = boxH;
  // SVG: fit → meet (contain); fill/crop → slice (cover).
  const baseScale =
    fit === 'fit' ? Math.min(destW / iw, destH / ih) : Math.max(destW / iw, destH / ih);
  const scale = baseScale * scaleMul;
  const dw = iw * scale;
  const dh = ih * scale;
  const ox = (offsetXPct / 100) * destW;
  const oy = (offsetYPct / 100) * destH;
  ctx.drawImage(img, -dw / 2 + ox, -dh / 2 + oy, dw, dh);
  ctx.restore();
}

function createImageOrDiffusePattern(
  ctx: CanvasRenderingContext2D,
  node: SceneNodeInput,
  w: number,
  h: number
): CanvasPattern | null {
  const attrs = node.attrs || {};
  const fillType = parseFillType(attrs['fill-type']);
  if (!boolEffectAttr(attrs['fill-enabled'], true)) return null;
  if (!boolEffectAttr(attrs['fill-visible'], true)) return null;

  let source: CanvasImageSource | null = null;
  let fit: FillImageFit = 'fill';
  let rotate = 0;
  let filterCss = 'none';
  let opacityPct = Number(attrs['fill-opacity'] ?? 100);
  let imageScale = 100;
  let imageOffsetX = 0;
  let imageOffsetY = 0;

  if (fillType === 'image') {
    const src = String(attrs['fill-image-src'] || '').trim();
    if (!src) return null;
    source = getFillImageReady(src);
    if (!source) return null;
    fit = parseFillImageFit(attrs['fill-image-fit']);
    rotate = parseFillImageRotate(attrs['fill-image-rotate']);
    filterCss = buildImageAdjustFilterCss(parseFillImageAdjust(attrs['fill-image-adjust']));
    imageScale = parseFillImageScale(attrs['fill-image-scale']);
    imageOffsetX = parseFillImageOffset(attrs['fill-image-offset-x']);
    imageOffsetY = parseFillImageOffset(attrs['fill-image-offset-y']);
  } else if (fillType === 'diffuse') {
    source = getDiffuseBakeCanvas(node, w, h);
    if (!source) return null;
    fit = 'fill';
    rotate = 0;
    // Opacity already baked into mesh pixels.
    opacityPct = 100;
  } else {
    return null;
  }

  if (typeof document === 'undefined') return null;
  const { iw, ih } = imageSourceSize(source);
  const tile = fit === 'tile' ? fillImageTileSize(iw, ih, imageScale) : null;
  const pw = tile?.w ?? Math.max(1, Math.round(w));
  const ph = tile?.h ?? Math.max(1, Math.round(h));
  const canvas = document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const tctx = canvas.getContext('2d');
  if (!tctx) return null;
  if (filterCss && filterCss !== 'none') {
    try {
      tctx.filter = filterCss;
    } catch {
      /* ignore */
    }
  }
  const alpha = Math.max(0, Math.min(100, opacityPct)) / 100;
  tctx.globalAlpha = alpha;
  drawFillImageInBox(tctx, source, pw, ph, fit === 'tile' ? 'crop' : fit, rotate, {
    scalePct: fit === 'tile' ? 100 : imageScale,
    offsetXPct: imageOffsetX,
    offsetYPct: imageOffsetY,
  });
  tctx.filter = 'none';
  tctx.globalAlpha = 1;
  try {
    return ctx.createPattern(canvas, fit === 'tile' ? 'repeat' : 'no-repeat');
  } catch {
    return null;
  }
}

/**
 * Fill current path or Path2D with solid/gradient/image/diffuse.
 * Image uses cached decode; diffuse uses IDW bake (capped resolution).
 */
export function fillCanvasShapeGeometry(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    path?: Path2D;
    fillRule?: CanvasFillRule;
    /** When no Path2D: caller builds the current path inside this callback. */
    trace?: () => void;
  }
): void {
  const { node, width: w, height: h, path, fillRule, trace } = opts;
  const attrs = node.attrs || {};
  const fillType = parseFillType(attrs['fill-type']);

  applyCanvasDropShadow(ctx, node);

  if (fillType === 'image' || fillType === 'diffuse') {
    const pattern = createImageOrDiffusePattern(ctx, node, w, h);
    if (pattern) {
      ctx.fillStyle = pattern;
      if (path) {
        if (fillRule) ctx.fill(path, fillRule);
        else ctx.fill(path);
      } else {
        trace?.();
        if (fillRule) ctx.fill(fillRule);
        else ctx.fill();
      }
    }
    clearCanvasDropShadow(ctx);
    return;
  }

  const fillStyle = resolveCanvasFillStyle(ctx, node, w, h, '#FFFFFF');
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    if (path) {
      if (fillRule) ctx.fill(path, fillRule);
      else ctx.fill(path);
    } else {
      trace?.();
      if (fillRule) ctx.fill(fillRule);
      else ctx.fill();
    }
  }
  clearCanvasDropShadow(ctx);
}

function applyCanvasDropShadow(ctx: CanvasRenderingContext2D, node: SceneNodeInput): void {
  const shadow = resolveShadow(node);
  if (!shadow) {
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    return;
  }
  ctx.shadowColor = shadow.color;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowOffsetX = shadow.offsetX;
  ctx.shadowOffsetY = shadow.offsetY;
}

function clearCanvasDropShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/**
 * Fill then stroke with strokeAlign (center|inside|outside).
 * Outside: stroke first at 2×, then fill covers inward half.
 */
function paintCanvasFillAndAlignedStroke(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    stroke: string;
    strokeWidth: number;
    path?: Path2D;
    fillRule?: CanvasFillRule;
    trace?: () => void;
  }
): void {
  const { node, width: w, height: h, stroke, strokeWidth, path, fillRule, trace } = opts;
  const align = resolveStrokeAlignForPaint(node);
  const doStroke = strokeWidth > 0 && !isTransparentCssColor(stroke);
  const dasharray =
    strokeDashForStyle(node.attrs?.strokeStyle) ||
    String(node.attrs?.strokeDasharray || node.attrs?.dasharray || '').trim() ||
    undefined;
  const shapeType = String(node.attrs?.shapeType || '').toLowerCase();
  const sideRuns =
    doStroke && isRectLikeStrokeSidesShape(shapeType, node.key)
      ? rectStrokeSideRuns(w, h, node.attrs, radiiFromAttrs(node.attrs))
      : null;
  const sideHandled = sideRuns != null;
  const strokeOpts = {
    align,
    stroke,
    strokeWidth,
    dasharray,
    path,
    fillRule,
  } as const;
  const traceFn =
    trace ||
    (() => {
      /* Path2D-only callers */
    });

  if (doStroke && !sideHandled && align === 'outside') {
    strokeCanvasAligned(ctx, {
      ...strokeOpts,
      trace: traceFn,
    });
  }

  fillCanvasShapeGeometry(ctx, {
    node,
    width: w,
    height: h,
    path,
    fillRule,
    trace,
  });

  if (sideHandled) {
    for (const run of sideRuns!) {
      if (run.length < 2) continue;
      strokeCanvasAligned(ctx, {
        align: 'center',
        stroke,
        strokeWidth,
        dasharray,
        trace: () => traceStrokeSideRun(ctx, run),
      });
    }
  } else if (doStroke && align !== 'outside') {
    strokeCanvasAligned(ctx, {
      ...strokeOpts,
      trace: traceFn,
    });
  }
}

/**
 * Trace donut / arc / polygon / star / triangle from the same baseline `d` as SVG
 * when Path2D is available; otherwise a Canvas-native fallback (happy-dom / older engines).
 * Returns true when geo ink was painted.
 */
function paintCanvasShapeInkViaBaseline(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    shapeType: string;
    stroke: string;
    strokeWidth: number;
  }
): boolean {
  const { node, width: w, height: h, shapeType, stroke, strokeWidth } = opts;
  const isEllipse =
    shapeType === 'ellipse' || shapeType === 'circle' || shapeType === 'oval';
  const isPolyStar =
    shapeType === 'triangle' || shapeType === 'star' || shapeType === 'polygon';
  if (!isEllipse && !isPolyStar) return false;

  const baselineShapeType = isEllipse ? 'circle' : shapeType;
  const nodeId = String(node.id || '');
  const mergedAttrs = mergeLiveCornerRadiiIntoAttrs(
    nodeId,
    mergeLiveShapeParamsIntoAttrs(nodeId, node.attrs)
  );
  const useEvenodd =
    isEllipse && effectiveEllipseInnerRatioFromAttrs(nodeId, node.attrs) > 1e-4;

  if (typeof Path2D !== 'undefined') {
    const baseline = getShapeBaseline(
      {
        key: 'shape',
        width: w,
        height: h,
        attrs: { ...mergedAttrs, shapeType: baselineShapeType },
      } as SceneNodeInput,
      { width: w, height: h }
    );
    const d = String(baseline?.d || '').trim();
    if (d) {
      try {
        const path =
          (nodeId ? rememberNodePath2D(nodeId, d) : null) || getCachedPath2D(d);
        if (!path) throw new Error('Path2D unavailable');
        paintCanvasFillAndAlignedStroke(ctx, {
          node,
          width: w,
          height: h,
          stroke,
          strokeWidth,
          path,
          fillRule: useEvenodd ? 'evenodd' : undefined,
        });
        return true;
      } catch {
        /* fall through to native */
      }
    }
  }

  if (isEllipse) {
    return paintEllipseVariantNative(ctx, {
      node,
      width: w,
      height: h,
      stroke,
      strokeWidth,
    });
  }
  return paintPolyStarNative(ctx, {
    node,
    width: w,
    height: h,
    shapeType: baselineShapeType,
    stroke,
    strokeWidth,
  });
}

/** Full disk / donut / pie / annular sector without Path2D. */
function paintEllipseVariantNative(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    stroke: string;
    strokeWidth: number;
  }
): boolean {
  const { node, width: w, height: h, stroke, strokeWidth } = opts;
  const cx = w / 2;
  const cy = h / 2;
  const rx = Math.max(0.5, w / 2);
  const ry = Math.max(0.5, h / 2);
  const nodeId = String(node.id || '');
  const inner = effectiveEllipseInnerRatioFromAttrs(nodeId, node.attrs);
  const arcPct = effectiveEllipseArcPercentFromAttrs(nodeId, node.attrs);
  const startDeg = ellipseStartDegFromAttrs(node.attrs);
  const full = Math.abs(arcPct) >= 99.5;
  const hasHole = inner > 1e-4;
  const irx = Math.max(0.25, rx * inner);
  const iry = Math.max(0.25, ry * inner);
  const { a0, a1 } = ellipseArcEndAngles(arcPct, startDeg);
  const ccw = arcPct < 0;

  const traceEllipse = () => {
    ctx.beginPath();
    if (full && !hasHole) {
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    } else if (full && hasHole) {
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.ellipse(cx, cy, irx, iry, 0, 0, Math.PI * 2, true);
    } else if (!hasHole) {
      ctx.moveTo(cx, cy);
      ctx.ellipse(cx, cy, rx, ry, 0, a0, a1, ccw);
      ctx.closePath();
    } else {
      ctx.ellipse(cx, cy, rx, ry, 0, a0, a1, ccw);
      ctx.ellipse(cx, cy, irx, iry, 0, a1, a0, !ccw);
      ctx.closePath();
    }
  };

  paintCanvasFillAndAlignedStroke(ctx, {
    node,
    width: w,
    height: h,
    stroke,
    strokeWidth,
    fillRule: hasHole ? 'evenodd' : undefined,
    trace: traceEllipse,
  });
  return true;
}

/** Sharp triangle / polygon / star without Path2D (vertex radii omitted). */
function paintPolyStarNative(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    shapeType: string;
    stroke: string;
    strokeWidth: number;
  }
): boolean {
  const { node, width: w, height: h, shapeType, stroke, strokeWidth } = opts;
  const nodeId = String(node.id || '');
  const pts = shapeVertexPoints(
    shapeType,
    w,
    h,
    effectiveSidesFromAttrs(nodeId, node.attrs),
    effectiveStarInnerRatioFromAttrs(nodeId, node.attrs)
  );
  if (pts.length < 3) return false;

  const tracePoly = () => {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(pts[i][0], pts[i][1]);
    }
    ctx.closePath();
  };

  paintCanvasFillAndAlignedStroke(ctx, {
    node,
    width: w,
    height: h,
    stroke,
    strokeWidth,
    trace: tracePoly,
  });
  return true;
}

/** Local-origin fill + stroke ink for idle Canvas shapes (0,0 → w×h). */
export function paintCanvasShapeInk(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    opacity?: number;
  }
): void {
  const node = opts.node;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const { stroke, strokeWidth } = resolveStroke(node, '#333333');
  const t = String(node.attrs?.shapeType || 'rect').toLowerCase();
  const isEllipse = t === 'ellipse' || t === 'circle' || t === 'oval';

  ctx.save();
  ctx.globalAlpha = opacity;
  // Match SVG host joins — default Canvas miterLimit (10) + AABB pad otherwise
  // clips star/poly tips and the outline reads thinner than a rect.
  ctx.lineCap = resolveStrokeLinecap(node.attrs);
  ctx.lineJoin = resolveStrokeLinejoin(node.attrs);
  ctx.miterLimit = resolveStrokeMiterlimit(node.attrs);

  if (
    paintCanvasShapeInkViaBaseline(ctx, {
      node,
      width: w,
      height: h,
      shapeType: t,
      stroke,
      strokeWidth,
    })
  ) {
    ctx.restore();
    return;
  }

  const trace = () => {
    if (isEllipse) {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      const nodeId = String(node.id || '');
      const liveAttrs = mergeLiveCornerRadiiIntoAttrs(nodeId, node.attrs || {});
      const r = clampCornerRadii(radiiFromAttrs(liveAttrs), w, h);
      traceRoundedRectLocal(ctx, w, h, r);
    }
  };

  paintCanvasFillAndAlignedStroke(ctx, {
    node,
    width: w,
    height: h,
    stroke,
    strokeWidth,
    trace,
  });
  ctx.restore();
}

function canvasFillRuleFromAttr(raw: unknown): CanvasFillRule | undefined {
  const attr = String(raw || '').toLowerCase();
  if (attr === 'evenodd') return 'evenodd';
  if (attr === 'nonzero') return 'nonzero';
  return undefined;
}

/**
 * Pen / pencil / path ink in local node space.
 * Pencil ribbons are closed filled outlines (perfect-freehand); pen/line stroke the path `d`.
 * Falls back to subsampled centerline when Path2D is unavailable.
 */
export function paintCanvasPathInk(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    opacity?: number;
    zoom?: number;
  }
): void {
  const node = opts.node;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const t = String(node.attrs?.shapeType || node.key || '').toLowerCase();
  let d = String(node.attrs?.path || '').trim();
  if (!d && (t === 'line' || t === 'arrow')) {
    const baseline = getShapeBaseline(node, { width: w, height: h });
    d = String(baseline?.d || '').trim();
  }
  const isPencil = t === 'pencil';
  const strokeOnly = canvasIdleIsStrokeOnly(node);
  const paintColor = resolveNodeProxyFill(node);
  const { stroke, strokeWidth } = resolveStroke(node, paintColor || '#333333');
  const lineW =
    strokeWidth > 0 ? strokeWidth : canvasIdleStrokeWidth(node, opts.zoom ?? 1);

  ctx.save();
  ctx.globalAlpha = opacity;
  // Pencil keeps round ribbon caps. Line/arrow/pen use authored cap/join
  // (default butt/miter) so arrow tips stay sharp — not soft round atlas blobs.
  if (isPencil) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  } else {
    ctx.lineCap = resolveStrokeLinecap(node.attrs);
    ctx.lineJoin = resolveStrokeLinejoin(node.attrs);
    ctx.miterLimit = resolveStrokeMiterlimit(node.attrs);
  }

  let paintD = d;
  if (isPencil && d) {
    const customOutline = String(node.attrs?.pencilOutlinePath || '').trim();
    if (customOutline) {
      paintD = customOutline;
    } else {
      const pts = parseSimplePathPoints(d);
      const brushId = String(node.attrs?.brushStyle || 'vector-ink');
      const pressures = parsePathPressures(node.attrs?.pathPressure, pts.length);
      const pressureEnabled =
        node.attrs?.pressureEnabled !== false &&
        String(node.attrs?.pressureEnabled || 'true') !== 'false';
      const capRaw = String(node.attrs?.strokeLinecap || 'round').toLowerCase();
      const linecap =
        capRaw === 'butt' || capRaw === 'square' ? (capRaw as 'butt' | 'square') : 'round';
      paintD =
        pencilInkPathFromPoints(pts, lineW, brushId, {
          linecap,
          pressures,
          pressureEnabled,
          simplify: false,
          dasharray: String(node.attrs?.strokeDasharray || node.attrs?.dasharray || '').trim() || undefined,
        }) || d;
    }
  } else if (t === 'path' || (t !== 'pen' && d)) {
    // Closed path + radius* (boolean results): fillet like sceneToSvg so Canvas
    // fill matches the blue path chrome / SVG host ink.
    paintD = pathPaintDFromAttrs(node.attrs as Record<string, unknown>, { shapeType: t }) || d;
  }

  if (typeof Path2D !== 'undefined' && paintD) {
    try {
      const nodeId = String(node.id || '');
      const path =
        (nodeId ? rememberNodePath2D(nodeId, paintD) : null) || getCachedPath2D(paintD);
      if (!path) throw new Error('Path2D unavailable');
      const fillRule = canvasFillRuleFromAttr(node.attrs?.['fill-rule']);
      if (isPencil) {
        ctx.fillStyle = paintColor;
        if (fillRule) ctx.fill(path, fillRule);
        else ctx.fill(path);
      } else if (!strokeOnly) {
        paintCanvasFillAndAlignedStroke(ctx, {
          node,
          width: w,
          height: h,
          stroke,
          strokeWidth: lineW,
          path,
          fillRule,
        });
      } else if (lineW > 0) {
        ctx.strokeStyle = !isTransparentCssColor(stroke) ? stroke : paintColor;
        ctx.lineWidth = lineW;
        ctx.stroke(path);
      }
      ctx.restore();
      return;
    } catch {
      /* fall through */
    }
  }

  paintStrokeCanvasIdle(ctx, {
    pathD: paintD || d,
    width: w,
    height: h,
    stroke: paintColor,
    lineWidth: Math.max(lineW, canvasIdleStrokeWidth(node, opts.zoom ?? 1)),
  });
  ctx.restore();
}

/** Idle text glyphs (wrapped) in local node space — not greeking bars. */
export function paintCanvasTextInk(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    opacity?: number;
  }
): void {
  const node = opts.node;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const style = parseNodeTextStyle(node.attrs || {});
  const plain = parseNodeText(node.attrs || {});
  const textFrame =
    node.attrs?.textFrame === true ||
    node.attrs?.textFrame === 'true' ||
    node.attrs?.textFrame === 1 ||
    node.attrs?.textFrame === '1';
  const framePad = textFrame ? TEXT_FRAME_PADDING : 0;
  const innerW = textFrame ? Math.max(1, w - framePad * 2) : w;
  const lines = wrapPlainTextLines(plain, style, innerW);
  const fontSize = Math.max(1, Number(style.fontSize) || 14);
  const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const lineH = fontSize * lineHeight;
  const italic = style.fontStyle === 'italic' ? 'italic ' : '';
  const weight = style.fontWeight || 'normal';
  const fillOpacity = Math.max(0, Math.min(100, Number(style.fillOpacity) || 100)) / 100;

  ctx.save();
  ctx.globalAlpha = opacity * fillOpacity;
  if (textFrame) {
    const cornerR = clampCornerRadii(textFrameCornerRadii(node.attrs || {}), w, h);
    traceRoundedRectLocal(ctx, w, h, cornerR);
    ctx.fillStyle = resolveTextFramePlateFill(node.attrs?.['fill-color']);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    traceRoundedRectLocal(ctx, w, h, cornerR);
    ctx.clip();
  }
  applyCanvasDropShadow(ctx, node);
  ctx.font = `${italic}${weight} ${fontSize}px "${style.fontFamily}"`;
  ctx.fillStyle = style.fill || '#333333';
  ctx.textBaseline = 'top';

  const outline = getIdleTextOutlinePath(node);
  if (outline) {
    // Canvas-traced CJK / boolean compounds need evenodd; default nonzero fills holes.
    try {
      ctx.fill(outline, 'evenodd');
    } catch {
      ctx.fill(outline);
    }
    clearCanvasDropShadow(ctx);
    ctx.restore();
    return;
  }

  const align = String(style.textAlign || 'left');
  let x = framePad;
  if (align === 'center' || align === 'middle') {
    ctx.textAlign = 'center';
    x = w / 2;
  } else if (align === 'right' || align === 'end') {
    ctx.textAlign = 'right';
    x = w - framePad;
  } else {
    ctx.textAlign = 'left';
    x = framePad;
  }

  const innerH = Math.max(1, h - framePad * 2);
  const originY = textFrame
    ? 0
    : textVerticalOriginY(
        innerH,
        fontSize,
        lineHeight,
        Math.max(1, lines.length),
        measureTextEmBoxHeight(style, (plain || '永').slice(0, 1) || '永')
      );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] || ' ';
    const y = framePad + originY + i * lineH;
    // Fixed text frames: skip lines fully below the plate (scroll lives in HTML).
    if (textFrame && y >= h - framePad) break;
    ctx.fillText(line, x, y);
  }
  clearCanvasDropShadow(ctx);
  ctx.restore();
}

// Wire SoA idle text paint (artboard FO / Canvas2D).
setSoaTextInkPainter(paintCanvasTextInk);

function traceRoundedRectLocal(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  r: { tl: number; tr: number; br: number; bl: number }
): void {
  const { tl, tr, br, bl } = r;
  ctx.beginPath();
  ctx.moveTo(tl, 0);
  ctx.lineTo(w - tr, 0);
  if (tr > 0) ctx.arcTo(w, 0, w, tr, tr);
  else ctx.lineTo(w, 0);
  ctx.lineTo(w, h - br);
  if (br > 0) ctx.arcTo(w, h, w - br, h, br);
  else ctx.lineTo(w, h);
  ctx.lineTo(bl, h);
  if (bl > 0) ctx.arcTo(0, h, 0, h - bl, bl);
  else ctx.lineTo(0, h);
  ctx.lineTo(0, tl);
  if (tl > 0) ctx.arcTo(0, 0, tl, 0, tl);
  else ctx.lineTo(0, 0);
  ctx.closePath();
}

function isTransparentPaint(v: unknown): boolean {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return !s || s === 'none' || s === 'transparent' || s === 'rgba(0,0,0,0)';
}

/** Pencil / open strokes must never become solid AABB 色块 at far zoom. */
export function canvasIdleIsStrokeOnly(node: SceneNodeInput): boolean {
  const a = node?.attrs || {};
  const t = String(a.shapeType || '');
  if (t === 'pencil' || t === 'line' || t === 'arrow') return true;
  if (t === 'pen') {
    const d = String(a.path || '');
    const closed =
      a.closed !== false &&
      a.closed !== 'false' &&
      (a.closed === true || a.closed === 'true' || /\sZ\s*$/i.test(d.trim()));
    if (!closed) return true;
    if (!boolEffectAttr(a['fill-enabled'], true) || !boolEffectAttr(a['fill-visible'], true)) {
      return true;
    }
    return isTransparentPaint(a['fill-color']);
  }
  if (t === 'path' || String(node?.key || '') === 'path') {
    return isTransparentPaint(a['fill-color']);
  }
  return false;
}

export function canvasIdleStrokeWidth(node: SceneNodeInput, zoom: number): number {
  const a = node?.attrs || {};
  const raw = Number(a['border-width'] ?? 2);
  const w = Number.isFinite(raw) && raw > 0 ? raw : 2;
  return Math.max(0.75, Math.min(6, w * Math.max(0.35, zoom || 1)));
}

/**
 * Subsample path centerline into ctx stroke (local path coords).
 * Returns false if path unusable — caller may draw a fallback midline.
 */
export function strokeCanvasIdleCenterline(
  ctx: CanvasRenderingContext2D,
  d: string,
  maxPts = CANVAS_IDLE_STROKE_MAX_PTS
): boolean {
  const trimmed = String(d || '').trim();
  if (!trimmed) return false;
  const pts = parseSimplePathPoints(trimmed);
  if (pts.length < 2) return false;
  const step = Math.max(1, Math.ceil(pts.length / maxPts));
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    if (!p) continue;
    if (!started) {
      ctx.moveTo(p.x, p.y);
      started = true;
    } else {
      ctx.lineTo(p.x, p.y);
    }
  }
  const last = pts[pts.length - 1];
  if (last && started) ctx.lineTo(last.x, last.y);
  ctx.stroke();
  return started;
}

/** Stroke path centerline or a horizontal midline fallback inside the node box. */
export function paintStrokeCanvasIdle(
  ctx: CanvasRenderingContext2D,
  opts: {
    pathD: string;
    width: number;
    height: number;
    stroke: string;
    lineWidth: number;
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  ctx.strokeStyle = opts.stroke;
  ctx.lineWidth = opts.lineWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (!strokeCanvasIdleCenterline(ctx, opts.pathD)) {
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
  }
}

/** Idle text proxy: greeking bars (no solid AABB slab). Origin = top-left of node. */
export function paintTextProxyLines(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    fill: string;
    opacity?: number;
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const fontSize = Math.max(6, Number(opts.node.attrs?.fontSize) || 14);
  const lineH = fontSize * (Number(opts.node.attrs?.lineHeight) || 1.4);
  const lineCount = Math.max(1, Math.round(h / lineH));
  const barH = Math.max(1, Math.min(fontSize * 0.55, lineH * 0.55));
  const lastLineW = w * (0.35 + 0.4 * Math.abs(Math.sin(w * 0.05)));
  ctx.fillStyle = opts.fill;
  for (let li = 0; li < lineCount; li++) {
    const barW = li === lineCount - 1 && lineCount > 1 ? lastLineW : w;
    ctx.globalAlpha = opacity * 0.72;
    ctx.fillRect(0, li * lineH + (lineH - barH) / 2, barW, barH);
  }
}

/**
 * Idle audio plate (gen-empty wash + waveform bars). Interactive transport stays
 * on the single selected HTML FO — same split as idle video posters.
 */
/**
 * Idle audio plate (gen-empty wash + Lucide AudioLines — same glyph as the
 * selection title). Interactive transport stays on the HTML host.
 */
export function paintCanvasAudioInk(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    opacity?: number;
    /** Camera zoom — empty-gen border stays ~1 CSS px (same as artboard plate). */
    zoom?: number;
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const attrs = opts.node.attrs || {};
  const isGen =
    attrs.audioGenerator === true || String(attrs.audioGenerator || '') === 'true';
  const r = clampCornerRadii(
    isGen ? { tl: 0, tr: 0, br: 0, bl: 0 } : radiiFromAttrs(attrs),
    w,
    h
  );
  ctx.save();
  ctx.globalAlpha = opacity;
  traceRoundedRectLocal(ctx, w, h, r);
  ctx.fillStyle = '#e9eaee';
  ctx.fill();
  if (isGen) {
    // Screen-constant hairline — never bake 0.75–1.5 scene units (fat at 1000%+).
    const zoom = Math.max(0.05, Number(opts.zoom) || 1);
    strokeCanvasPlateHairline(ctx, w, h, {
      strokeCss: '#c5c9d2',
      strokeWidth: framePlateStrokeSceneWidth(zoom),
    });
  }
  const icon = generatorEmptyIconSize(w, h);
  if (generatorEmptyIconVisible(icon)) {
    paintGeneratorEmptyPlateIcon(ctx, 'audio', w / 2, h / 2, icon, GENERATOR_EMPTY_ICON_COLOR);
  }
  ctx.restore();
}

/** Minimal image/video/lottie placeholder (mountain + sun) at local (0,0). */
export function paintMediaProxyIcon(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opacity: number
): void {
  const s = Math.min(w, h) * 0.28;
  if (s < 3) return;
  const cx = w / 2;
  const cy = h / 2;
  ctx.save();
  ctx.globalAlpha = opacity * 0.55;
  ctx.fillStyle = '#cbd5e1';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = Math.max(0.5, Math.min(1.5, s * 0.06));
  ctx.strokeRect(0, 0, w, h);
  const sunR = s * 0.18;
  ctx.fillStyle = '#94a3b8';
  ctx.beginPath();
  ctx.arc(cx - s * 0.28, cy - s * 0.22, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.5, cy + s * 0.35);
  ctx.lineTo(cx, cy - s * 0.2);
  ctx.lineTo(cx + s * 0.5, cy + s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.1, cy + s * 0.35);
  ctx.lineTo(cx + s * 0.45, cy + s * 0.05);
  ctx.lineTo(cx + s * 0.8, cy + s * 0.35);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Empty image/video generator plate for canvas / atlas idle ink — rect wash +
 * filled play (video) or mountain+sun (image), matching the product empty-state
 * glyphs. Border uses artboard plate hairline (`framePlateStrokeSceneWidth`).
 */
export function paintGeneratorEmptyInk(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opacity = 1,
  opts?: {
    fill?: boolean;
    border?: boolean;
    icon?: boolean;
    zoom?: number;
    strokeWidth?: number;
    /** Default `image` (mountain+sun). Video plates pass `video`. */
    iconKind?: 'image' | 'video';
  }
): void {
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  const drawFill = opts?.fill !== false;
  const drawBorder = opts?.border !== false;
  const drawIcon = opts?.icon !== false;
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0.05, opacity));
  if (drawFill) {
    ctx.fillStyle = '#e9eaee';
    ctx.fillRect(0, 0, width, height);
  }
  if (drawBorder) {
    // Match artboard / sharp SoA rect: closed path + miter, ~1 CSS px on screen.
    const zoom = Math.max(0.05, Number(opts?.zoom) || 1);
    const sw =
      opts?.strokeWidth != null && Number.isFinite(Number(opts.strokeWidth))
        ? Math.max(0, Number(opts.strokeWidth))
        : framePlateStrokeSceneWidth(zoom);
    strokeCanvasPlateHairline(ctx, width, height, {
      strokeCss: '#c5c9d2',
      strokeWidth: sw,
    });
  }
  if (drawIcon) {
    const icon = generatorEmptyIconSize(width, height);
    if (generatorEmptyIconVisible(icon)) {
      paintGeneratorEmptyPlateIcon(
        ctx,
        opts?.iconKind === 'video' ? 'video' : 'image',
        width / 2,
        height / 2,
        icon,
        GENERATOR_EMPTY_ICON_COLOR
      );
    }
  }
  ctx.restore();
}

/**
 * Centered empty-gen plate glyph: filled ▶ (video), mountain+sun (image), or
 * solid audio bars. Filled shapes stay sharp under atlas LINEAR upscale —
 * Lucide hairline strokes crushed to a few texels and looked “虚”.
 */
export function paintGeneratorEmptyPlateIcon(
  ctx: CanvasRenderingContext2D,
  kind: 'image' | 'video' | 'audio',
  cx: number,
  cy: number,
  size: number,
  color = GENERATOR_EMPTY_ICON_COLOR
): void {
  const s = Math.max(0.35, Number(size) || 0);
  if (!(s > 0)) return;
  ctx.fillStyle = color;
  if (kind === 'video') {
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.28, cy - s * 0.38);
    ctx.lineTo(cx + s * 0.42, cy);
    ctx.lineTo(cx - s * 0.28, cy + s * 0.38);
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (kind === 'audio') {
    // Six bars in the Lucide AudioLines layout, drawn as filled round-caps
    // (not 2px strokes) so atlas stamps stay crisp.
    const barW = Math.max(s * 0.08, s * (2 / 24));
    const xs = [-0.42, -0.25, -0.08, 0.09, 0.26, 0.43];
    // Normalized half-heights matching LU_AUDIO_LINES_SEGS proportions.
    const halfHs = [0.12, 0.28, 0.42, 0.22, 0.34, 0.12];
    for (let i = 0; i < xs.length; i += 1) {
      const x = cx + s * xs[i]!;
      const hh = s * halfHs[i]!;
      const top = cy - hh;
      const h = hh * 2;
      const r = Math.min(barW * 0.5, h * 0.45);
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x - barW / 2, top, barW, h, r);
      } else {
        ctx.rect(x - barW / 2, top, barW, h);
      }
      ctx.fill();
    }
    return;
  }
  // Mountain + sun
  const sunR = s * 0.18;
  ctx.beginPath();
  ctx.arc(cx - s * 0.22, cy - s * 0.28, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.5, cy + s * 0.38);
  ctx.lineTo(cx - s * 0.05, cy - s * 0.12);
  ctx.lineTo(cx + s * 0.35, cy + s * 0.38);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(cx - s * 0.05, cy + s * 0.38);
  ctx.lineTo(cx + s * 0.28, cy + s * 0.02);
  ctx.lineTo(cx + s * 0.55, cy + s * 0.38);
  ctx.closePath();
  ctx.fill();
}

/** Normalized crop from image/video attrs (matches sceneToSvg). */
function readMediaCropNorm(
  node: SceneNodeInput
): { x: number; y: number; w: number; h: number } | null {
  const fx = Number(node?.attrs?.cropX);
  const fy = Number(node?.attrs?.cropY);
  const fw = Number(node?.attrs?.cropW);
  const fh = Number(node?.attrs?.cropH);
  if (
    Number.isFinite(fx) &&
    Number.isFinite(fy) &&
    Number.isFinite(fw) &&
    Number.isFinite(fh) &&
    fw > 0 &&
    fh > 0 &&
    (fx !== 0 || fy !== 0 || fw !== 1 || fh !== 1)
  ) {
    return { x: fx, y: fy, w: fw, h: fh };
  }
  return null;
}

/** Prefer pause-frame still over attrs.poster for video idle ink. */
export function mediaPaintSrc(node: SceneNodeInput, nodeId?: string): string {
  const key = String(node.key || '');
  const attrs = node.attrs || {};
  if (key === 'video') {
    const id = String(nodeId || node.id || '').trim();
    const runtime = id ? getVideoIdlePaintFrame(id) : null;
    if (runtime) return runtime;
    const poster = String(attrs.poster || '').trim();
    if (poster) return poster;
  }
  return String(attrs.src || '').trim();
}

/**
 * Local-origin image / video poster ink (0,0 → w×h), with crop + corner clip.
 * Starts decode via `getFillImageReady` when missing; falls back to icon.
 */
export function paintCanvasMediaInk(
  ctx: CanvasRenderingContext2D,
  opts: {
    node: SceneNodeInput;
    width: number;
    height: number;
    opacity?: number;
    nodeId?: string;
    zoom?: number;
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const opacity = Math.min(1, Math.max(0.05, opts.opacity ?? 1));
  const src = mediaPaintSrc(opts.node, opts.nodeId);
  const img = src ? getFillImageReady(src) : null;
  if (!img) {
    const attrs = opts.node.attrs || {};
    const isGen =
      attrs.imageGenerator === true ||
      String(attrs.imageGenerator || '') === 'true' ||
      attrs.videoGenerator === true ||
      String(attrs.videoGenerator || '') === 'true';
    if (isGen || !src) {
      // Empty generator / missing bitmap: draw plate ink (not wait on src).
      if (isGen) {
        const isVideo =
          attrs.videoGenerator === true || String(attrs.videoGenerator || '') === 'true';
        paintGeneratorEmptyInk(ctx, w, h, opacity, {
          zoom: Math.max(0.05, Number(opts.zoom) || 1),
          iconKind: isVideo ? 'video' : 'image',
        });
      } else paintMediaProxyIcon(ctx, w, h, opacity);
    } else {
      // src present but still decoding — soft proxy until ready.
      paintMediaProxyIcon(ctx, w, h, opacity);
    }
    return;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  const r = clampCornerRadii(radiiFromAttrs(opts.node.attrs), w, h);
  traceRoundedRectLocal(ctx, w, h, r);
  ctx.clip();

  const attrs = (opts.node.attrs || {}) as Record<string, unknown>;
  if (nodeNeedsPuppetWarp(opts.node)) {
    const pins = (() => {
      const track = attrs.puppetTrack;
      if (Array.isArray(track) && track.length) {
        const frame = secToFrame(getAnimationWorkbenchPlayheadSec(), 30);
        return samplePuppetPinsAtFrame(attrs, frame);
      }
      return readPuppetPins(attrs);
    })();
    paintPuppetWarpedImage(ctx, {
      image: img,
      width: w,
      height: h,
      pins,
      attrs,
    });
    ctx.restore();
    return;
  }

  const crop = readMediaCropNorm(opts.node);
  if (crop) {
    const imgW = w / crop.w;
    const imgH = h / crop.h;
    const imgX = (-crop.x / crop.w) * w;
    const imgY = (-crop.y / crop.h) * h;
    ctx.drawImage(img, imgX, imgY, imgW, imgH);
  } else {
    drawFillImageInBox(ctx, img, w, h, 'fill', 0);
  }
  ctx.restore();
}

/**
 * Bake static image / video poster for WebGL textured media mesh (crop + corners).
 * Empty generators / missing src bake a plate glyph (same as 2d idle ink).
 * Returns null only while a real src is still decoding or is WebGL-unsafe.
 */
export function bakeMediaInkForAtlas(
  node: SceneNodeInput,
  width: number,
  height: number,
  nodeId?: string,
  zoom = 1
): HTMLCanvasElement | OffscreenCanvas | null {
  if (nodeNeedsPuppetWarp(node)) return null;
  const id = String(nodeId || node.id || '').trim();
  const src = mediaPaintSrc(node, id);
  if (src) {
    if (isFillImageWebglUnsafe(src)) return null;
    if (!getFillImageReady(src)) return null;
  }
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const z = Math.max(0.05, Number(zoom) || 1);
  // Empty plates: fill atlas cell so Lucide Path2D stays sharp (old min(1,…)
  // left soft densified WebGL strokes as the only idle icon path).
  // Bitmaps: cap at 512 to avoid huge decode stamps.
  const scale = src
    ? Math.min(1, 512 / Math.max(w, h))
    : atlasBakePixelScale(w, h, z);
  const bw = Math.max(1, Math.round(w * scale));
  const bh = Math.max(1, Math.round(h * scale));
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  // Prefer OffscreenCanvas in tests — setupTests stubs HTMLCanvasElement.getContext → null.
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(bw, bh);
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = bw;
    c.height = bh;
    canvas = c;
  } else {
    return null;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  paintCanvasMediaInk(ctx as CanvasRenderingContext2D, {
    node,
    width: w,
    height: h,
    opacity: 1,
    nodeId: id || undefined,
    zoom: z,
  });
  // Never return a tainted bake — stamping it would poison the shared WebGL atlas.
  // Empty plates have no external image; skip the readback gate when there is no src.
  if (src && !canvasPixelsReadable(canvas)) {
    markFillImageWebglUnsafe(src);
    return null;
  }
  return canvas;
}

/**
 * Bake idle audio plate for WebGL textured media mesh (wash + waveform bars).
 */
export function bakeAudioInkForAtlas(
  node: SceneNodeInput,
  width: number,
  height: number,
  zoom = 1
): HTMLCanvasElement | OffscreenCanvas | null {
  if (String(node.key || '') !== 'audio') return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const z = Math.max(0.05, Number(zoom) || 1);
  // Match screen coverage up to atlas cell — tiny high-zoom plates used to bake
  // as ~16×9 px then upscale soft.
  const scale = atlasBakePixelScale(w, h, z);
  const bw = Math.max(1, Math.round(w * scale));
  const bh = Math.max(1, Math.round(h * scale));
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(bw, bh);
  } else if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = bw;
    c.height = bh;
    canvas = c;
  } else {
    return null;
  }
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const opacity = Math.min(1, Math.max(0, parseLayerOpacity(node.attrs?.opacity, 1)));
  const screenH = h * z;
  if (screenH < 18) {
    const c2 = ctx as CanvasRenderingContext2D;
    c2.save();
    c2.globalAlpha = Math.max(0.05, opacity);
    c2.fillStyle = '#e9eaee';
    c2.fillRect(0, 0, w, h);
    strokeCanvasPlateHairline(c2, w, h, {
      strokeCss: '#c5c9d2',
      strokeWidth: framePlateStrokeSceneWidth(z),
    });
    c2.restore();
  } else {
    paintCanvasAudioInk(ctx as CanvasRenderingContext2D, {
      node,
      width: w,
      height: h,
      opacity,
      zoom: z,
    });
  }
  return canvas;
}

export function clipCanvasIdleToOwningFrame(
  ctx: CanvasRenderingContext2D,
  document: SceneDocument | null | undefined,
  node: SceneNodeInput | null | undefined,
  zoom = 1
): boolean {
  const nodeId = String(node?.id || '').trim();
  if (frameClipRevealsOverflow(nodeId)) return false;
  const frame = findClippingFrameForNode(document, node as Record<string, unknown> | null);
  if (!frame) return false;
  const ox = Number(document?.x) || 0;
  const oy = Number(document?.y) || 0;
  // findClippingFrameForNode already merges live artboard geometry when present.
  const fx = Number(frame.x) - ox;
  const fy = Number(frame.y) - oy;
  const fw = Math.max(1, Number(frame.width) || 1);
  const fh = Math.max(1, Number(frame.height) || 1);
  const inset = Math.min(2, 0.5 / Math.max(0.05, zoom || 1));
  ctx.beginPath();
  ctx.rect(fx + inset, fy + inset, Math.max(1, fw - inset * 2), Math.max(1, fh - inset * 2));
  ctx.clip();
  return true;
}

/**
 * One Canvas2D idle node (path / text / media / shape fill).
 * Scene coords; applies node angle when needed.
 */
export type CanvasIdleNodePaintOpts = {
  node: SceneNodeInput;
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
  zoom?: number;
  document?: SceneDocument | null;
  nodeId?: string;
};

export function paintCanvasIdleNode(
  ctx: CanvasRenderingContext2D,
  opts: CanvasIdleNodePaintOpts
): void {
  const node = opts.node;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const left = opts.left;
  const top = opts.top;
  const angle = opts.angle != null ? Number(opts.angle) : Number(node.attrs?.angle) || 0;
  const fill = resolveNodeProxyFill(node);
  const opacity = Math.min(1, Math.max(0, parseLayerOpacity(node.attrs?.opacity, 1) || 0.15));
  const strokeOnly = canvasIdleIsStrokeOnly(node);
  const pathD = String(node.attrs?.path || '');
  const key = String(node.key || '');
  const isMedia = key === 'image' || key === 'video' || key === 'lottie' || key === 'audio';

  const paintAtLocalOrigin = (c: CanvasRenderingContext2D) => {
    if (key === 'text') {
      const fontPx = Math.max(1, Number(node.attrs?.fontSize) || 14);
      const screenFont = fontPx * Math.max(0.05, opts.zoom || 1);
      // Far / dense: greeking bars — full glyphs only when readable on screen.
      if (screenFont < 7 || !canIdlePaintOnCanvas(node)) {
        c.save();
        c.globalAlpha = opacity;
        paintTextProxyLines(c, { node, width: w, height: h, fill, opacity });
        c.restore();
      } else {
        paintCanvasTextInk(c, { node, width: w, height: h, opacity });
      }
      return;
    }
    if (isMedia) {
      if (isImageProcessRunning(node)) {
        paintProcessPlateCanvas(c, w, h, opacity, String(node.id || ''));
        return;
      }
      if (key === 'audio') {
        const z = Math.max(0.05, Number(opts.zoom) || 1);
        const screenH = h * z;
        if (screenH < 18) {
          // Tiny audio plates: solid wash + hairline (no per-bar path work).
          c.save();
          c.globalAlpha = opacity;
          c.fillStyle = '#e9eaee';
          c.fillRect(0, 0, w, h);
          strokeCanvasPlateHairline(c, w, h, {
            strokeCss: '#c5c9d2',
            strokeWidth: framePlateStrokeSceneWidth(z),
          });
          c.restore();
          return;
        }
        paintCanvasAudioInk(c, { node, width: w, height: h, opacity, zoom: z });
        return;
      }
      if (key === 'image' || key === 'video') {
        paintCanvasMediaInk(c, {
          node,
          width: w,
          height: h,
          opacity,
          zoom: opts.zoom,
        });
      } else {
        c.save();
        c.globalAlpha = opacity;
        paintMediaProxyIcon(c, w, h, opacity);
        c.restore();
      }
      return;
    }
    const shapeType = String(node.attrs?.shapeType || key || '').toLowerCase();
    const isPathLike =
      strokeOnly ||
      shapeType === 'pencil' ||
      shapeType === 'pen' ||
      shapeType === 'path' ||
      shapeType === 'line' ||
      shapeType === 'arrow' ||
      key === 'path';
    if (isPathLike) {
      // Path `d` is in document-local coords. Scale into the live preview box so
      // resize handles update ink in real time (not only translate).
      const baseW = Math.max(1, Number(node.width) || w);
      const baseH = Math.max(1, Number(node.height) || h);
      const sx = w / baseW;
      const sy = h / baseH;
      const needsScale = Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6;
      if (needsScale) c.save();
      if (needsScale) c.scale(sx, sy);
      if (canIdlePaintOnCanvas(node)) {
        paintCanvasPathInk(c, {
          node,
          width: baseW,
          height: baseH,
          opacity,
          zoom: opts.zoom,
        });
      } else {
        c.save();
        c.globalAlpha = opacity;
        paintStrokeCanvasIdle(c, {
          pathD,
          width: baseW,
          height: baseH,
          stroke: fill,
          lineWidth: canvasIdleStrokeWidth(node, opts.zoom),
        });
        c.restore();
      }
      if (needsScale) c.restore();
      return;
    }
    if (canIdlePaintOnCanvas(node)) {
      paintCanvasShapeInk(c, { node, width: w, height: h, opacity });
      return;
    }
    c.save();
    c.globalAlpha = opacity;
    paintBasicShapeFill(c, {
      left: 0,
      top: 0,
      width: w,
      height: h,
      fill,
      shapeType: String(node.attrs?.shapeType || key || ''),
      opacity,
    });
    c.restore();
  };

  ctx.save();
  clipCanvasIdleToOwningFrame(ctx, opts.document, node, opts.zoom);
  const flipX = node.attrs?.flipX === true || node.attrs?.flipX === 'true';
  const flipY = node.attrs?.flipY === true || node.attrs?.flipY === 'true';
  // Match sceneToSvg reapplySceneTransform: pivot → rotate → flip → unpivot.
  if (Math.abs(angle) > 0.5 || flipX || flipY) {
    const cx = left + w / 2;
    const cy = top + h / 2;
    ctx.translate(cx, cy);
    if (Math.abs(angle) > 0.5) ctx.rotate((angle * Math.PI) / 180);
    if (flipX || flipY) ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.translate(-w / 2, -h / 2);
  } else {
    ctx.translate(left, top);
  }
  paintLocalInkWithBlend(ctx, {
    node,
    width: w,
    height: h,
    paintCore: paintAtLocalOrigin,
  });
  ctx.restore();
}

/**
 * Live Canvas-idle id list published by RcbShapesLayer for the stage ink overlay.
 * Screen-space paint uses CameraTransform (same lattice as the pixel grid).
 */
export type SceneCanvasIdlePaintSnapshot = {
  document: SceneDocument;
  canvasIds: readonly string[];
  hiddenNodeId: string | null;
  getNodeBox: (nodeId: string) => SceneHitBox | null;
};

let sceneCanvasIdlePaint: SceneCanvasIdlePaintSnapshot | null = null;
const sceneCanvasIdlePaintListeners = new Set<() => void>();
let sceneCanvasIdlePaintFp = '';
/** Prior canvas-ink count — avoid split() of a multi-KB join fingerprint. */
let sceneCanvasIdlePaintLen = 0;

/**
 * Membership fingerprint without `canvasIds.join` (that allocated ~N×id
 * strings on every paste and dominated grow-only wake at 2k+).
 * Hash is order-sensitive over the cull list; rootLen catches doc grows.
 */
function sceneCanvasIdlePaintFingerprint(
  next: SceneCanvasIdlePaintSnapshot | null
): string {
  if (!next) return '';
  const doc = next.document;
  const framesLen = Array.isArray(doc?.frames) ? doc.frames.length : 0;
  const rootLen = Array.isArray(doc?.deltaSetLike?.ROOT?.children)
    ? doc.deltaSetLike!.ROOT!.children!.length
    : 0;
  const coord = String((doc as { coordSpace?: string } | null)?.coordSpace || '');
  let hash = 2166136261 >>> 0;
  const ids = next.canvasIds;
  for (let i = 0; i < ids.length; i += 1) {
    const id = String(ids[i] || '');
    for (let j = 0; j < id.length; j += 1) {
      hash ^= id.charCodeAt(j);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    hash ^= 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${next.hiddenNodeId || ''}\0${ids.length}\0${hash.toString(36)}\0${coord}\0${framesLen}\0${rootLen}`;
}

export function getSceneCanvasIdlePaint(): SceneCanvasIdlePaintSnapshot | null {
  return sceneCanvasIdlePaint;
}

export function setSceneCanvasIdlePaint(next: SceneCanvasIdlePaintSnapshot | null): boolean {
  const fp = sceneCanvasIdlePaintFingerprint(next);
  // Always replace snapshot (getNodeBox may close over fresher geometry) but
  // only wake listeners when membership / doc identity changes — otherwise
  // every parent re-render during frame drag bumps canvasIdlePaintEpoch and
  // stacks full SoA paints until the tab hangs.
  const prevHidden = sceneCanvasIdlePaint?.hiddenNodeId ?? null;
  sceneCanvasIdlePaint = next;
  if (typeof window !== 'undefined' && import.meta.env.DEV) {
    (window as Window & { __RCB_E2E_SCENE_DOC__?: unknown }).__RCB_E2E_SCENE_DOC__ =
      next?.document ?? null;
  }
  if (fp === sceneCanvasIdlePaintFp) return false;
  sceneCanvasIdlePaintFp = fp;
  // Shrink / clear (delete, cull): must full-clear stale ink.
  // Grow-only (paste add): dirty AABB on new slots is enough — full wipe on
  // every Ctrl+V is what made ~12 rect pastes feel like a freeze.
  // Empty → first ink: still force full so a deferred bump cannot no-op-skip
  // before dirty flags land (draw-then-blank regression).
  const prevLen = sceneCanvasIdlePaintLen;
  const nextLen = next?.canvasIds.length ?? 0;
  sceneCanvasIdlePaintLen = nextLen;
  const nextHidden = next?.hiddenNodeId ?? null;
  // Inline text/pen edit toggles hidden without membership shrink — WebGL must
  // still full-clear or the prior mesh/atlas frame ghosts under the editor.
  if (
    next == null ||
    nextLen < prevLen ||
    (prevLen === 0 && nextLen > 0) ||
    nextHidden !== prevHidden
  ) {
    idleCanvasFullRepaintPending = true;
  }
  for (const fn of sceneCanvasIdlePaintListeners) {
    fn();
  }
  return true;
}

/** Re-paint idle ink without changing the id set (e.g. fill-image decode finished). */
let idlePaintBumpRaf = 0;

export function bumpSceneCanvasIdlePaint(): void {
  // Coalesce to rAF — calling setState from a child useLayoutEffect (reveal /
  // demotion) otherwise nests a full RcbCanvas→SvgCanvas re-render inside layout
  // and freezes select after long paste sessions (history + 100+ nodes).
  if (typeof requestAnimationFrame !== 'function') {
    for (const fn of sceneCanvasIdlePaintListeners) {
      fn();
    }
    return;
  }
  if (idlePaintBumpRaf) return;
  idlePaintBumpRaf = requestAnimationFrame(() => {
    idlePaintBumpRaf = 0;
    for (const fn of sceneCanvasIdlePaintListeners) {
      fn();
    }
  });
}

let idleCanvasFullRepaintPending = false;
let soaBakeTileReadyBridgeInstalled = false;

/** Wire Worker/idle bake completion → idle paint bump (call after modules settle). */
export function ensureSoaBakeTileReadyBridge(): void {
  if (soaBakeTileReadyBridgeInstalled) return;
  soaBakeTileReadyBridgeInstalled = true;
  subscribeSoaBakeTileReady(() => {
    bumpSceneCanvasIdlePaint();
  });
}

/** Workbench focus / visibility gate changed — next idle paint must full-clear stale ink. */
export function requestIdleCanvasFullRepaint(): void {
  idleCanvasFullRepaintPending = true;
  bumpSceneCanvasIdlePaint();
}

export function consumeIdleCanvasFullRepaintPending(): boolean {
  const pending = idleCanvasFullRepaintPending;
  idleCanvasFullRepaintPending = false;
  return pending;
}

export function clearSceneCanvasIdlePaint(): void {
  if (sceneCanvasIdlePaint == null) return;
  setSceneCanvasIdlePaint(null);
}

export function subscribeSceneCanvasIdlePaint(listener: () => void): () => void {
  sceneCanvasIdlePaintListeners.add(listener);
  return () => {
    sceneCanvasIdlePaintListeners.delete(listener);
  };
}

/** Ids to paint as canvas ink (excludes the inline-edit hidden node). */
export function listSceneCanvasIdlePaintIds(): readonly string[] {
  const snap = sceneCanvasIdlePaint;
  if (!snap?.canvasIds.length) return [];
  const hidden = snap.hiddenNodeId;
  if (!hidden) return snap.canvasIds;
  return snap.canvasIds.filter((id) => id !== hidden);
}

/** Default factory — DOM hosts on svg; product ink on webgl; canvas2d = grid + tests. */
export function createSceneRenderer(
  backend: SceneRendererBackend,
  deps: CanvasSceneRendererDeps | SceneRendererHitDeps
): SceneRenderer {
  if (backend === 'webgl') {
    const canvasDeps = deps as CanvasSceneRendererDeps;
    if (!canvasDeps.canvas) {
      throw new Error('createSceneRenderer(webgl) requires deps.canvas');
    }
    if (!isSoaCanvasShapesEnabled()) {
      throw new Error('createSceneRenderer(webgl) requires SoA canvas shapes');
    }
    // Probe on a throwaway canvas first — never bind webgl2 onto the stage ink
    // canvas unless the ink program links (otherwise Canvas2D fallback is dead).
    if (!soaWebglInkShadersOk()) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          '[scene] WebGL2 ink shaders unavailable; using canvas2d idle ink (do not claim webgl2 on stage canvas)'
        );
      }
      ensureSoaBakeTileReadyBridge();
      return createCanvasSceneRenderer(canvasDeps);
    }
    const gl = createWebglSceneRenderer(canvasDeps);
    if (!gl) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[scene] WebGL2 ink unavailable after probe; falling back to canvas2d');
      }
      ensureSoaBakeTileReadyBridge();
      return createCanvasSceneRenderer(canvasDeps);
    }
    ensureSoaBakeTileReadyBridge();
    return gl;
  }
  if (backend === 'canvas2d') {
    const canvasDeps = deps as CanvasSceneRendererDeps;
    if (!canvasDeps.canvas) {
      throw new Error('createSceneRenderer(canvas2d) requires deps.canvas');
    }
    ensureSoaBakeTileReadyBridge();
    return createCanvasSceneRenderer(canvasDeps);
  }
  return createSvgSceneRenderer(deps);
}

/** Product idle ink: WebGL vector when SoA is on, else Canvas2D vector. */
export function resolveIdleInkBackend(): SceneRendererBackend {
  if (!isSoaCanvasShapesEnabled()) return 'canvas2d';
  return 'webgl';
}

/** E2E / DEV probe — reads the app module singletons (not a separate Vite graph). */
export type SoaRuntimeProbe = {
  inkBackend: SceneRendererBackend;
  webglEnv: boolean;
  bakeThreshold: number;
  shouldBake: boolean;
  bufCount: number;
  bakeTiles: number;
};

if (typeof window !== 'undefined') {
  (
    window as Window & {
      __RCB_SOA_RUNTIME__?: () => SoaRuntimeProbe;
    }
  ).__RCB_SOA_RUNTIME__ = () => {
    const buf = getSharedSceneRenderBuffer();
    const cache = getSharedSoaBakeCache();
    return {
      inkBackend: resolveIdleInkBackend(),
      webglEnv: isSoaWebglEnvEnabled(),
      bakeThreshold: getSoaBakeCountThreshold(),
      shouldBake: shouldUseSoaBake(buf),
      bufCount: buf.count,
      bakeTiles: cache?.tiles?.size ?? 0,
    };
  };
}

export {
  getGpuDepthOfFieldParams,
  setGpuDepthOfFieldParams,
  resetGpuDepthOfFieldParams,
  subscribeGpuDepthOfField,
  isGpuDofEnvEnabled,
  shouldRunGpuDepthOfField,
  resolveGpuDofBackend,
  circleOfConfusionPx,
  buildNormalizedDepthLookup,
} from '@/components/rcb/render/gpuDepthOfField';

// Re-export bake invalidate for AI flush listeners.
export { resetSharedSoaBake } from '@/components/rcb/render/soaBakeLayer';
export { markAllSoaDirty } from '@/components/rcb/render/sceneRenderBuffer';
