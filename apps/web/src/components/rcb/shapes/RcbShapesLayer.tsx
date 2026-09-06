import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import { useSelector } from '@/store';
import { useRcbCamera, useRcbCameraMotion, useRcbViewportEl } from '../camera/context';
import { rcbViewportSceneBounds } from '../core/math';
import {
  RcbSpatialIndex,
  SCENE_SPATIAL_LARGE_THRESHOLD,
  boxesIntersect,
  buildIdRankMap,
  getSharedSceneSpatialRuntime,
  nodeSceneAabb,
  sortIdsByRank,
} from '../core/spatialIndex';
import {
  isImageProcessRunning,
  isNodeOverlayHidden,
  isNodeStructurallyHiddenInDocument,
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  nodePaintZIndex,
  uniqueStringIds,
} from '@/components/rcb/scene/document/sceneDocument';
import { syncStackPaintOrder } from '@/components/rcb/scene/document/sceneStackPainter';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import {
  setFrameClipRevealOverflowIds,
  setSelectionPaintRaiseIds,
  setSelectionPaintRaiseFrameIds,
} from '@/components/rcb/selection/selectionPaintRaise';
import { nodeOwnerFrameId } from '@/components/rcb/frames/frameNodeBinding';
import { scheduleArtboardInkPaint } from '@/components/rcb/frames/artboardInkSurface';
import { nodeLeftTop } from '@/components/rcb/scene/paint/sceneToSvg';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  clearSceneCanvasIdlePaint,
  canIdlePaintOnCanvas,
  canvasIdleIsStrokeOnly,
  bumpSceneCanvasIdlePaint,
  clearIdleTextOutlineCache,
  getSceneCanvasIdlePaint,
  requestIdleCanvasFullRepaint,
  setSceneCanvasIdlePaint,
} from '@/components/rcb/render/sceneRenderer';
import { paintIntentNeedsDomHost } from '@/components/rcb/render/paintIntent';
import {
  getLiveCornerRadiusPreviewNodeId,
  subscribeLiveCornerRadiusPreview,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  clearNodePathFingerprints,
  getLiveShapeParamsPreviewNodeId,
  subscribeLiveShapeParamsPreview,
} from '@/components/rcb/scene/document/sceneShapes';
import { effectivePaintBox } from '@/components/rcb/core/transformPreview';
import {
  applySoaHostInkFlags,
  bulkInsertSoaFromDocument,
  bulkRemoveSoaByIds,
  bulkUpsertSoaQuadtree,
  getSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  markAllSoaDirty,
  markSoaDirtyById,
  resolveSoaPaintBox,
  SOA_FLAG_FREE,
  syncSceneRenderBufferFromDocument,
  type SceneRenderBuffer,
} from '@/components/rcb/render/sceneRenderBuffer';
import {
  bindSoaBakeElementTiles,
  getSharedSoaBake,
  getSharedSoaBakeCache,
  patchSoaBakeDirty,
  resetSharedSoaBake,
  setSharedSoaBake,
  unbindSoaBakeElement,
} from '@/components/rcb/render/soaBakeLayer';
import {
  createRenderDemotionScheduler,
  type RenderDemotionScheduler,
} from '@/components/rcb/render/renderDemotionScheduler';
import { RCB_SOA_AI_FLUSH, markInteractionPerf } from '@/components/editor/sceneEvents';
import RcbShapeHost from './RcbShapeHost';

export { canvasIdleIsStrokeOnly, canIdlePaintOnCanvas };

function bindDemoteBakeTiles(buf: SceneRenderBuffer, ids: readonly string[]): void {
  const cache = getSharedSoaBakeCache();
  if (!cache) return;
  for (const id of ids) {
    const i = buf.indexById.get(id);
    if (i == null) continue;
    const { x, y, w, h } = resolveSoaPaintBox(buf, i);
    bindSoaBakeElementTiles(cache, id, {
      minX: Math.min(x, x + w),
      minY: Math.min(y, y + h),
      maxX: Math.max(x, x + w),
      maxY: Math.max(y, y + h),
    });
  }
}

function unbindPromoteBakeTiles(ids: readonly string[]): void {
  const cache = getSharedSoaBakeCache();
  if (!cache) return;
  for (const id of ids) unbindSoaBakeElement(cache, id);
}

function flushDemotionPaintWake(ids?: readonly string[]): void {
  const buf = getSharedSceneRenderBuffer();
  if (ids && ids.length > 0) {
    patchSharedSpatialFromSoaIds(buf, ids);
  } else {
    refreshSharedSpatialFromSoa(buf);
  }
  const bake = getSharedSoaBake();
  const cache = getSharedSoaBakeCache();
  if (bake?.valid && cache) patchSoaBakeDirty(buf, bake);
  bumpSceneCanvasIdlePaint();
}

/**
 * Refresh scene spatial AABBs for SoA-touched ids. Prefer document
 * `nodeSceneAabb` (rotation + stroke pad) — raw SoA x/y/w/h omit angle and
 * shrunk angled pen/line pick after select→promote→demote.
 */
function patchSharedSpatialFromSoaIds(
  buf: SceneRenderBuffer,
  ids: readonly string[]
): void {
  if (!ids.length) return;
  const runtime = getSharedSceneSpatialRuntime();
  if (!runtime) return;
  const doc = getSceneCanvasIdlePaint()?.document;
  if (doc) {
    runtime.patchNodes(doc, ids, 32);
    return;
  }
  runtime.upsertIdsFromRenderBuffer(buf, ids, { pad: 32 });
}

function createShapesDemotionScheduler(
  forceFullSetRef: { current: ReadonlySet<string> },
  fullHostsRef: { current: ReadonlySet<string> },
  onHintsChanged: () => void
): RenderDemotionScheduler {
  return createRenderDemotionScheduler({
    demoteDelayMs: 300,
    onHintsChanged,
    sink: {
      promote(ids) {
        const buf = getSharedSceneRenderBuffer();
        if (buf.count === 0) return;
        const hosts = new Set(forceFullSetRef.current);
        for (const id of fullHostsRef.current) hosts.add(id);
        for (const id of ids) hosts.add(id);
        applySoaHostInkFlags(buf, hosts, { onlyIds: ids });
        unbindPromoteBakeTiles(ids);
      },
      demote(ids) {
        const buf = getSharedSceneRenderBuffer();
        if (buf.count === 0) return;
        const hosts = new Set(forceFullSetRef.current);
        for (const id of fullHostsRef.current) hosts.add(id);
        applySoaHostInkFlags(buf, hosts, { onlyIds: ids });
        bulkUpsertSoaQuadtree(buf, ids);
        bindDemoteBakeTiles(buf, ids);
      },
      afterFlips(ids) {
        flushDemotionPaintWake(ids);
      },
    },
  });
}

/** After SoA sync, push shape AABBs into the shared spatial runtime (large N). */
function refreshSharedSpatialFromSoa(buf: SceneRenderBuffer) {
  if (buf.count < SCENE_SPATIAL_LARGE_THRESHOLD) return;
  const runtime = getSharedSceneSpatialRuntime();
  if (!runtime) return;
  const doc = getSceneCanvasIdlePaint()?.document;
  if (doc) {
    const ids: string[] = [];
    for (let i = 0; i < buf.count; i += 1) {
      if (buf.flags[i] & SOA_FLAG_FREE) continue;
      const id = buf.ids[i];
      if (id) ids.push(id);
    }
    if (ids.length) runtime.patchNodes(doc, ids, 32);
    return;
  }
  runtime.upsertFromRenderBuffer(buf, { pad: 32 });
}

/**
 * Sync document —SoA buffer (+ host ink flags + spatial). Used by the shapes layer and
 * AI flush. Prefer calling once per AI transaction commit, not per tool_op.
 *
 * Membership changes (boolean delete+add, paste, undo) must full-rebuild: callers
 * like `setDocument` often leave `lastPatchedNodeIds` stale / omit deleted ids,
 * and incremental-with-removeMissing:false left ghost rects that still painted
 * but could not be selected.
 */
export function syncSoaBufferFromDocumentNow(
  document: SceneDocument,
  opts: {
    ids: readonly string[];
    lastPatchedNodeIds?: readonly string[];
    forceFullIds: ReadonlySet<string> | readonly string[];
    fullRebuild?: boolean;
  }
): boolean {
  if (!isSoaCanvasShapesEnabled()) return false;
  const buf = getSharedSceneRenderBuffer();
  const patchedList = (opts.lastPatchedNodeIds || []).filter(Boolean);
  const liveIds = opts.ids.map(String).filter((id) => id && id !== 'ROOT');
  const membershipChanged = soaBufferMembershipChanged(buf, liveIds);

  // Paste / large patch batch: upsert known ids —never fall through to a full
  // rebuild just because patchedList is big (that froze 100+ node paste).
  if (!opts.fullRebuild && buf.count > 0 && patchedList.length > 0) {
    const liveSet = new Set(liveIds);
    const patchedSet = new Set(patchedList.map(String));

    if (membershipChanged) {
      let removedGhost = false;
      for (let i = 0; i < buf.count; i += 1) {
        if (buf.flags[i] & SOA_FLAG_FREE) continue;
        const id = buf.ids[i];
        if (id && !liveSet.has(id)) {
          removedGhost = true;
          break;
        }
      }
      if (!removedGhost) {
        const missing: string[] = [];
        for (const id of liveIds) {
          if (buf.indexById.get(id) == null) missing.push(id);
        }
        const covered = missing.length === 0 || missing.every((id) => patchedSet.has(id));
        if (covered) {
          const t0 = performance.now();
          let tInsert = 0;
          let tFlags = 0;
          let tSpatial = 0;
          if (missing.length) {
            const tA = performance.now();
            bulkInsertSoaFromDocument(buf, document, missing);
            tInsert = performance.now() - tA;
          }
          // Second-pass paste (selection) may re-enter with membership already
          // matched —still upsert patched so geometry stays fresh without rebuild.
          const toRefresh = patchedList.filter((id) => liveSet.has(id) && !missing.includes(id));
          if (toRefresh.length) {
            const tA = performance.now();
            bulkInsertSoaFromDocument(buf, document, toRefresh);
            tInsert += performance.now() - tA;
          }
          const flagIds = missing.length || toRefresh.length ? [...missing, ...toRefresh] : patchedList;
          {
            const tA = performance.now();
            applySoaHostInkFlags(buf, opts.forceFullIds, { onlyIds: flagIds });
            tFlags = performance.now() - tA;
          }
          // Document SceneSpatialRuntime already ingested patched ids in SvgCanvas
          // useMemo sync this commit — do not bulkUpsert/rebuild the same tree again
          // from SoA (that doubled paste #2+ cost at 2k+).
          {
            const tA = performance.now();
            if (!missing.length && toRefresh.length) {
              patchSharedSpatialFromSoaIds(buf, toRefresh);
            }
            tSpatial = performance.now() - tA;
          }
          markInteractionPerf('soa-sync', {
            branch: 'bulk-membership',
            missing: missing.length,
            refresh: toRefresh.length,
            bufCount: buf.count,
            patched: patchedList.length,
            insertMs: Number(tInsert.toFixed(2)),
            flagsMs: Number(tFlags.toFixed(2)),
            spatialMs: Number(tSpatial.toFixed(2)),
            spatialSkipped: missing.length > 0,
            bodyMs: Number((performance.now() - t0).toFixed(2)),
          });
          return true;
        }
      }
    } else {
      const t0 = performance.now();
      const toWrite: string[] = [];
      const toRemove: string[] = [];
      for (const id of patchedList) {
        if (!document.deltaSetLike?.[id]) toRemove.push(id);
        else toWrite.push(id);
      }
      if (toRemove.length) bulkRemoveSoaByIds(buf, toRemove);
      if (toWrite.length) bulkInsertSoaFromDocument(buf, document, toWrite);
      const keep = new Set(liveIds);
      const ghosts: string[] = [];
      for (let i = 0; i < buf.count; i += 1) {
        if (buf.flags[i] & SOA_FLAG_FREE) continue;
        const id = buf.ids[i];
        if (id && !keep.has(id)) ghosts.push(id);
      }
      if (ghosts.length) bulkRemoveSoaByIds(buf, ghosts);
      applySoaHostInkFlags(buf, opts.forceFullIds, {
        onlyIds: toWrite.length ? toWrite : patchedList,
      });
      if (toWrite.length) patchSharedSpatialFromSoaIds(buf, toWrite);
      else refreshSharedSpatialFromSoa(buf);
      markInteractionPerf('soa-sync', {
        branch: 'bulk-patch',
        write: toWrite.length,
        remove: toRemove.length + ghosts.length,
        bufCount: buf.count,
        patched: patchedList.length,
        bodyMs: Number((performance.now() - t0).toFixed(2)),
      });
      return true;
    }
  }

  const t0 = performance.now();
  syncSceneRenderBufferFromDocument(buf, document);
  markAllSoaDirty(buf);
  resetSharedSoaBake();
  setSharedSoaBake(null);
  clearNodePathFingerprints();
  clearIdleTextOutlineCache();
  applySoaHostInkFlags(buf, opts.forceFullIds);
  refreshSharedSpatialFromSoa(buf);
  markInteractionPerf('soa-sync', {
    branch: opts.fullRebuild ? 'full-rebuild-forced' : 'full-rebuild',
    membershipChanged,
    bufCount: buf.count,
    patched: patchedList.length,
    live: liveIds.length,
    bodyMs: Number((performance.now() - t0).toFixed(2)),
  });
  return true;
}

/** HTML/SVG hosts when canvas ink cannot occupy the correct stackOrder slot. */
export function nodeNeedsDomShapeHost(
  node: SceneNodeInput | null | undefined,
  forceFull = false
): boolean {
  if (forceFull) return true;
  if (!node) return true;
  if (isImageProcessRunning(node)) return true;
  // Artboard-bound idle vectors use ArtboardLayer ink — not SVG hosts for frameId alone.
  const key = String(node.key || '');
  if (key === 'lottie' || key === 'group') return true;
  return !canIdlePaintOnCanvas(node);
}

/** True when SoA slot ids diverge from document ROOT children (add/remove). */
export function soaBufferMembershipChanged(
  buf: SceneRenderBuffer,
  liveIds: readonly string[]
): boolean {
  const keep = new Set(liveIds.map(String).filter(Boolean));
  let liveCount = 0;
  for (let i = 0; i < buf.count; i += 1) {
    if (buf.flags[i] & SOA_FLAG_FREE) continue;
    const id = buf.ids[i];
    if (!id || !keep.has(id)) return true;
    liveCount += 1;
  }
  return liveCount !== keep.size;
}

/**
 * Drop artboard clipContent for selected / SoftGlow hosts so overflow matches
 * unclipped selection chrome. Idle (unselected) ink stays clipped.
 * Frame-only selection must NOT reveal child overflow — pass selected node ids
 * (not frame-kept cull ids) into the reveal set.
 *
 * Video/audio stay as forceFull DOM hosts for the HTML decoder, but must NOT
 * clear clipContent — sole-on-board media would otherwise paint past the Frame.
 */
export function shouldRevealShapeOverflow(
  selectedOrForceFull: boolean,
  node: SceneNodeInput | null | undefined
): boolean {
  if (!selectedOrForceFull) return false;
  const key = String(node?.key || '');
  if (key === 'video' || key === 'audio') {
    return isImageProcessRunning(node);
  }
  return true;
}

type Props = {
  document: SceneDocument;
  reloadToken?: number | string;
  /** Bumps paint for nodes touched by the latest document patch. */
  documentPatchToken?: number;
  lastPatchedNodeIds?: string[];
  /** Geometry / angle commits —keep host reloadToken stable (Phase 3). */
  lastPatchTransformOnly?: boolean;
  /** Hide this node's SVG paint (e.g. while inline text editor is open). */
  hiddenNodeId?: string | null;
  /** Never cull these (selection / inline editors) even if off-screen. */
  keepVisibleIds?: readonly string[];
  /**
   * Node ids that temporarily drop clipContent (selected shapes / path edit).
   * Must not include children of a co-selected artboard — those stay clipped.
   */
  revealOverflowIds?: readonly string[];
  /** Single-select temporary paint raise (max+1). Empty for multi-select. */
  paintRaiseIds?: readonly string[];
  /** Single-selected artboard id — temporary front over world ink under the plate. */
  paintRaiseFrameIds?: readonly string[];
  /** Must stay as full SVG hosts (SoftGlow / inline editors —selection stays on canvas ink). */
  forceFullIds?: readonly string[];
  /** Shared scene index from SvgCanvas —drives viewport visible set. */
  spatialIndex?: RcbSpatialIndex | null;
};

const EMPTY_KEEP: readonly string[] = [];
const EMPTY_FORCE_FULL: readonly string[] = [];
const EMPTY_FORCE_FULL_SET = new Set<string>();

/** Screen-px margin so shapes entering the view aren't blank for a frame. */
const CULL_PAD_SCREEN_PX = 96;

/** Above this count, use stepped zoom while the camera is moving. */
const EFFICIENT_ZOOM_SHAPE_THRESHOLD = 80;

/** Prefer index.search over O(N) AABB walk once the scene is this large. */
const INDEX_CULL_THRESHOLD = 64;

/** Cap on canvas ink ids after viewport cull. */
const MAX_CANVAS_INK_PAINT = 4096;

function screenAreaPx(node: SceneNodeInput, zoom: number): number {
  const w = Math.max(1, Number(node?.width) || 1);
  const h = Math.max(1, Number(node?.height) || 1);
  const z = Math.max(0.05, zoom || 1);
  return w * h * z * z;
}

function trimCanvasInkIds(opts: {
  document: SceneDocument;
  canvasIds: string[];
  zoom: number;
  maxCanvasInk: number;
}): string[] {
  const { document, canvasIds, zoom, maxCanvasInk } = opts;
  if (canvasIds.length <= maxCanvasInk) return canvasIds;
  const scored = canvasIds.map((id) => ({
    id,
    score: screenAreaPx(document?.deltaSetLike?.[id], zoom),
  }));
  scored.sort((a, b) => b.score - a.score);
  const keep = new Set(scored.slice(0, maxCanvasInk).map((s) => s.id));
  return canvasIds.filter((id) => keep.has(id));
}

/**
 * Split in-viewport ids: DOM hosts vs SoA/canvas ink.
 * Hosts share one mount with artboard plates (`data-z` = stackOrder).
 * SoA only for world nodes that sit under every artboard plate.
 */
export function pickFullAndCanvasIds(opts: {
  document: SceneDocument;
  visibleIds: string[];
  /** Editors / SoftGlow only —not selection of canvas-ink shapes. */
  forceFullSet?: Set<string>;
  /**
   * Extra ids that must keep a DOM host during demote quiet period
   * (RenderDemotionScheduler CANDIDATE / ACTIVE_SVG).
   */
  holdHostIds?: ReadonlySet<string>;
  /**
   * Single-select temporary raise (within-ink z + hit).
   * World basics stay on SoA; generators + plate-bound promote to SVG so max+1
   * data-z can cover sibling hosts / artboard plates (world WebGL sits under SVG).
   */
  paintRaiseIds?: ReadonlySet<string> | readonly string[];
  paintRaiseFrameIds?: ReadonlySet<string> | readonly string[];
  /**
   * Selection / SoftGlow overflow reveal. Plate-bound ids must leave FO ink
   * (see artboardInkSurface) — promote to SVG host even when paint-raise is
   * empty (multi-select), otherwise overflow only paints under the plate.
   */
  revealOverflowIds?: ReadonlySet<string> | readonly string[];
  zoom: number;
  /** Device pixel ratio for idle media sharpness (defaults to window.devicePixelRatio). */
  dpr?: number;
  maxCanvasInk?: number;
}): { fullIds: string[]; canvasIds: string[] } {
  const { document, visibleIds, zoom } = opts;
  const forceFullSet = opts.forceFullSet ?? EMPTY_FORCE_FULL_SET;
  const holdHostIds = opts.holdHostIds;
  const maxCanvasInk = opts.maxCanvasInk ?? MAX_CANVAS_INK_PAINT;
  const dpr =
    opts.dpr ??
    (typeof window !== 'undefined' ? Number(window.devicePixelRatio) || 1 : 1);
  const fullIds: string[] = [];
  const canvasRaw: string[] = [];
  for (const id of visibleIds) {
    const node = document?.deltaSetLike?.[id];
    if (isNodeStructurallyHiddenInDocument(document, node)) continue;
    const raiseIds = opts.paintRaiseIds;
    const isPaintRaised = Boolean(
      raiseIds &&
        (raiseIds instanceof Set
          ? raiseIds.has(id)
          : (raiseIds as readonly string[]).includes(id))
    );
    const revealIds = opts.revealOverflowIds;
    const isRevealed = Boolean(
      revealIds &&
        (revealIds instanceof Set
          ? revealIds.has(id)
          : (revealIds as readonly string[]).includes(id))
    );
    // Sole route: paintIntent — DomHost only for obligatory / raise / stack.
    // Sharpness never promotes media via SharpHost.
    if (
      paintIntentNeedsDomHost(document, id, node, {
        zoom,
        dpr,
        forceFull: forceFullSet.has(id),
        holdHost: Boolean(holdHostIds?.has(id)),
        raised: isPaintRaised,
        revealed: isRevealed,
      })
    ) {
      fullIds.push(id);
    } else {
      canvasRaw.push(id);
    }
  }
  return {
    fullIds,
    canvasIds: trimCanvasInkIds({
      document,
      canvasIds: canvasRaw,
      zoom,
      maxCanvasInk,
    }),
  };
}

/**
 * Mounts DOM hosts (text/media/editors). Vector ink is SoA canvas (single surface).
 * Off-viewport nodes are culled; keepVisibleIds stay for selection chrome.
 */
function RcbShapesLayer({
  document,
  reloadToken = 0,
  documentPatchToken = 0,
  lastPatchedNodeIds = [],
  lastPatchTransformOnly = false,
  hiddenNodeId = null,
  keepVisibleIds = EMPTY_KEEP,
  revealOverflowIds = EMPTY_KEEP,
  paintRaiseIds = EMPTY_KEEP,
  paintRaiseFrameIds = EMPTY_KEEP,
  forceFullIds = EMPTY_FORCE_FULL,
  spatialIndex = null,
}: Props) {
  const camera = useRcbCamera();
  const { moving, efficientZoom } = useRcbCameraMotion();
  const viewportEl = useRcbViewportEl();
  const frameClipToken = useMemo(
    () =>
      (document.frames || [])
        .map((frame) =>
          [
            frame.id,
            frame.x,
            frame.y,
            frame.width,
            frame.height,
            frame.clipContent,
            frame.hidden,
          ].join(','),
        )
        .join('|'),
    [document.frames],
  );
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  /** Coalesce pan/zoom cull to one update per frame. */
  const [cullCam, setCullCam] = useState({ x: camera.x, y: camera.y, zoom: camera.zoom });

  useEffect(() => {
    if (!viewportEl) return undefined;
    const measure = () => {
      const r = viewportEl.getBoundingClientRect();
      setStageSize({
        width: Math.max(0, r.width),
        height: Math.max(0, r.height),
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewportEl);
    return () => ro.disconnect();
  }, [viewportEl]);

  const ids = useMemo(() => {
    const children = document?.deltaSetLike?.ROOT?.children;
    return Array.isArray(children) ? uniqueStringIds(children) : [];
  }, [document]);

  const idRank = useMemo(() => buildIdRankMap(ids), [ids]);

  const zoomForCull =
    moving && ids.length >= EFFICIENT_ZOOM_SHAPE_THRESHOLD ? efficientZoom : camera.zoom;

  useEffect(() => {
    let raf = 0;
    raf = requestAnimationFrame(() => {
      setCullCam({ x: camera.x, y: camera.y, zoom: zoomForCull });
    });
    return () => cancelAnimationFrame(raf);
  }, [camera.x, camera.y, zoomForCull]);

  const keepSet = useMemo(
    () => new Set(keepVisibleIds.filter(Boolean)),
    [keepVisibleIds]
  );
  const revealSet = useMemo(
    () => new Set(revealOverflowIds.filter(Boolean)),
    [revealOverflowIds]
  );
  const paintRaiseSet = useMemo(
    () => new Set(paintRaiseIds.filter(Boolean)),
    [paintRaiseIds]
  );
  const paintRaiseFrameSet = useMemo(
    () => new Set(paintRaiseFrameIds.filter(Boolean)),
    [paintRaiseFrameIds]
  );
  const forceFullSet = useMemo(
    () => new Set(forceFullIds.filter(Boolean)),
    [forceFullIds]
  );

  /** Defer SoA buffer rebuild while AI tool_ops apply —flush once on unlock. */
  const aiMutationLock = useSelector(
    (s) => (s.editor?.aiMutationLock as number) || 0
  );
  /** Bumps pick/publish when 动画工作—isolation toggles (document unchanged). */
  const workbenchTimelineToken = useSelector(
    (s) => String(s.editor?.lottieTimelinePanel?.nodeId || '')
  );

  /** Mount only in-view (+ keep) ids —never `ids.filter` over 100k after spatial hits. */
  const visibleIds = useMemo(() => {
    // Stage not measured yet: mount nothing (returning all ids disabled cull).
    if (!document || !ids.length || stageSize.width < 1 || stageSize.height < 1) {
      return [];
    }
    const vp = rcbViewportSceneBounds(cullCam, stageSize);
    const pad = CULL_PAD_SCREEN_PX / Math.max(0.05, cullCam.zoom || 1);
    const view = {
      minX: vp.x - pad,
      minY: vp.y - pad,
      maxX: vp.x + vp.width + pad,
      maxY: vp.y + vp.height + pad,
    };

    if (ids.length >= INDEX_CULL_THRESHOLD && spatialIndex && spatialIndex.size > 0) {
      const hits = spatialIndex.search(view.minX, view.minY, view.maxX, view.maxY);
      const vis = new Set(hits.map((h) => h.id));
      for (const id of keepSet) vis.add(id);
      return sortIdsByRank(vis, idRank, { ascending: true });
    }

    const out: string[] = [];
    for (const id of ids) {
      if (keepSet.has(id)) {
        out.push(id);
        continue;
      }
      const box = nodeSceneAabb(document, id, 8);
      if (!box) continue;
      if (boxesIntersect(box, view)) out.push(id);
    }
    return out;
  }, [document, ids, stageSize, cullCam, spatialIndex, idRank, keepSet]);

  const forceFullSetRef = useRef(forceFullSet);
  forceFullSetRef.current = forceFullSet;
  const idsRef = useRef(ids);
  idsRef.current = ids;
  /** Skip re-applying the same documentPatchToken when selection/layout re-enters. */
  const syncedPatchTokenRef = useRef(-1);

  // Promote/demote quiet period: CANDIDATE keeps DOM host until timer fires.
  const [holdEpoch, setHoldEpoch] = useState(0);
  const fullHostsRef = useRef<ReadonlySet<string>>(EMPTY_FORCE_FULL_SET);
  const demotionRef = useRef<RenderDemotionScheduler | null>(null);
  if (!demotionRef.current) {
    demotionRef.current = createShapesDemotionScheduler(
      forceFullSetRef,
      fullHostsRef,
      () => {
        setHoldEpoch((n) => n + 1);
      }
    );
  }

  const holdHostIds = useMemo(() => {
    return demotionRef.current?.heldHostIds() ?? forceFullSet;
  }, [holdEpoch, forceFullSet]);

  const { fullIds, canvasIds } = useMemo(
    () =>
      pickFullAndCanvasIds({
        document,
        visibleIds,
        forceFullSet,
        holdHostIds,
        paintRaiseIds: paintRaiseSet,
        paintRaiseFrameIds: paintRaiseFrameSet,
        revealOverflowIds: revealSet,
        zoom: cullCam.zoom || 1,
      }),
    [
      document,
      visibleIds,
      forceFullSet,
      holdHostIds,
      paintRaiseSet,
      paintRaiseFrameSet,
      revealSet,
      cullCam.zoom,
      workbenchTimelineToken,
    ]
  );
  const fullHostSet = useMemo(() => new Set(fullIds), [fullIds]);
  fullHostsRef.current = fullHostSet;

  useLayoutEffect(() => {
    if (!isSoaCanvasShapesEnabled() || !document) return;
    if (aiMutationLock > 0) return;
    const liveIds = ids.map(String).filter((id) => id && id !== 'ROOT');
    const bufBefore = getSharedSceneRenderBuffer();
    const membershipChanged = soaBufferMembershipChanged(bufBefore, liveIds);
    // Selection / dock wakes re-render this layer with the same paste patch token.
    // Re-running bulk-patch on lastPatchedNodeIds (text ×64 @5k) was multi-second.
    if (
      !membershipChanged &&
      documentPatchToken > 0 &&
      syncedPatchTokenRef.current === documentPatchToken
    ) {
      return;
    }
    markInteractionPerf('react-layout-enter', {
      ids: ids.length,
      patched: lastPatchedNodeIds.length,
    });
    const synced = syncSoaBufferFromDocumentNow(document, {
      ids,
      lastPatchedNodeIds,
      forceFullIds: forceFullSetRef.current,
    });
    if (synced) syncedPatchTokenRef.current = documentPatchToken;
    if (lastPatchedNodeIds.length) {
      demotionRef.current?.noteElementsActive(lastPatchedNodeIds);
      // Attr-only commits keep the idle membership fingerprint unchanged, so
      // setSceneCanvasIdlePaint does not wake paint —bump after SoA write.
      // Paste/dupe changes membership and already wakes via fingerprint; bumping
      // again stacked full clears and froze multi-copy.
      if (synced && !membershipChanged) {
        const buf = getSharedSceneRenderBuffer();
        for (const id of lastPatchedNodeIds) {
          markSoaDirtyById(buf, id);
        }
        bumpSceneCanvasIdlePaint();
        markInteractionPerf('soa-attr-bump', { patched: lastPatchedNodeIds.length });
      }
    }
  }, [document, documentPatchToken, reloadToken, ids, lastPatchedNodeIds, aiMutationLock]);

  // sceneReloadToken remounts hosts — allow the next layout to sync again.
  useEffect(() => {
    syncedPatchTokenRef.current = -1;
  }, [reloadToken]);

  useLayoutEffect(() => {
    if (!isSoaCanvasShapesEnabled() || aiMutationLock > 0 || !document) return;
    const buf = getSharedSceneRenderBuffer();
    if (buf.count === 0) return;
    demotionRef.current?.setForceHosts(forceFullSet);
  }, [forceFullSet, aiMutationLock, document]);

  // Paint-raise / stack-above DOM hosts must leave SoA ink (not SoftGlow-only).
  // Otherwise Canvas keeps CANVAS_IDLE under the SVG host and drag leaves 幻影.
  useLayoutEffect(() => {
    if (!isSoaCanvasShapesEnabled() || aiMutationLock > 0) return;
    const buf = getSharedSceneRenderBuffer();
    if (buf.count === 0) return;
    const flipped = applySoaHostInkFlags(buf, fullHostSet);
    if (flipped > 0) {
      // Ink flag flips do not change geometry — do not upsert raw SoA AABBs
      // (that dropped rotation expansion and broke angled stroke click-pick).
      bumpSceneCanvasIdlePaint();
    }
  }, [fullHostSet, aiMutationLock]);

  useEffect(() => {
    return () => {
      demotionRef.current?.dispose();
      demotionRef.current = null;
    };
  }, []);

  // Corner-radius drag stays on SoA canvas (transparent SVG corners).
  useLayoutEffect(() => {
    if (!isSoaCanvasShapesEnabled() || aiMutationLock > 0) return;
    const flipHostInk = (
      previewNodeId: string | null,
      mode: 'host' | 'canvas'
    ) => {
      const buf = getSharedSceneRenderBuffer();
      if (buf.count === 0) return;
      const hostIds = new Set(fullHostsRef.current);
      for (const id of forceFullSetRef.current) hostIds.add(id);
      if (previewNodeId) {
        if (mode === 'host') hostIds.add(previewNodeId);
        else hostIds.delete(previewNodeId);
      }
      const flipped = applySoaHostInkFlags(buf, hostIds);
      if (flipped > 0) flushDemotionPaintWake();
    };
    const unsubRadius = subscribeLiveCornerRadiusPreview(() => {
      // Live corner radii are applied on SoA/WebGL (getLiveCornerRadiusPreviewRadii).
      // Keep CANVAS_IDLE — selection no longer mounts an SVG ink host for R-drag.
      flipHostInk(getLiveCornerRadiusPreviewNodeId(), 'canvas');
    });
    const unsubShapeParams = subscribeLiveShapeParamsPreview(() => {
      // Poly/star sides need SoA live-geo rebuild — demote host for that node.
      flipHostInk(getLiveShapeParamsPreviewNodeId(), 'canvas');
    });
    return () => {
      unsubRadius();
      unsubShapeParams();
    };
  }, [aiMutationLock]);

  // AI transaction commit —one buffer sync + bake invalidate + idle paint bump.
  useEffect(() => {
    if (!isSoaCanvasShapesEnabled()) return;
    const onFlush = () => {
      if (!document) return;
      syncSoaBufferFromDocumentNow(document, {
        ids: idsRef.current,
        forceFullIds: forceFullSetRef.current,
        fullRebuild: true,
      });
      bumpSceneCanvasIdlePaint();
    };
    window.addEventListener(RCB_SOA_AI_FLUSH, onFlush);
    return () => window.removeEventListener(RCB_SOA_AI_FLUSH, onFlush);
  }, [document]);

  // Publish canvas-ink ids + paint-raise / selection-reveal registries.
  const revealKeyRef = useRef('');
  const revealIdsRef = useRef<string[]>([]);
  const raiseIdsRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (!document) {
      setFrameClipRevealOverflowIds(null);
      setSelectionPaintRaiseIds(null);
      setSelectionPaintRaiseFrameIds(null);
      revealKeyRef.current = '';
      revealIdsRef.current = [];
      raiseIdsRef.current = [];
      clearSceneCanvasIdlePaint();
      return;
    }
    const revealIds: string[] = [];
    // Selected shapes / SoftGlow only — frame-kept children stay clipped.
    for (const id of revealSet) {
      const node = document.deltaSetLike?.[id];
      if (node && shouldRevealShapeOverflow(true, node)) revealIds.push(id);
    }
    for (const id of forceFullSet) {
      if (revealSet.has(id)) continue;
      const node = document.deltaSetLike?.[id];
      if (node && shouldRevealShapeOverflow(true, node)) revealIds.push(id);
    }
    const raiseIds = [...paintRaiseSet];
    const raiseFrameIds = [...paintRaiseFrameSet];
    const revealKey = `${revealIds.slice().sort().join('\0')}|${raiseIds.slice().sort().join('\0')}|${raiseFrameIds.slice().sort().join('\0')}`;
    const revealChanged = revealKey !== revealKeyRef.current;
    const prevRevealIds = revealIdsRef.current;
    const prevRaiseIds = raiseIdsRef.current;
    revealKeyRef.current = revealKey;
    revealIdsRef.current = revealIds;
    raiseIdsRef.current = raiseIds;
    setFrameClipRevealOverflowIds(revealIds);
    setSelectionPaintRaiseIds(raiseIds);
    setSelectionPaintRaiseFrameIds(raiseFrameIds);
    // Plates + hosts share one mount — re-sort by data-z after selection raise.
    syncStackPaintOrder();

    if (aiMutationLock > 0) return;
    if (!canvasIds.length) {
      clearSceneCanvasIdlePaint();
      if (revealChanged) {
        requestIdleCanvasFullRepaint();
        markInteractionPerf('reveal-idle', {
          mode: 'empty-full',
          revealCount: revealIds.length,
          fullHosts: fullIds.length,
          canvasIdle: 0,
        });
      }
      return;
    }
    const sceneDoc = document;
    const paintCanvasIds = canvasIds.filter((id) => {
      const node = sceneDoc.deltaSetLike?.[id];
      return node && !isNodeStructurallyHiddenInDocument(sceneDoc, node);
    });
    const wokeMembership = setSceneCanvasIdlePaint({
      document: sceneDoc,
      canvasIds: paintCanvasIds,
      hiddenNodeId: hiddenNodeId ?? null,
      getNodeBox: (id) => {
        const node = sceneDoc.deltaSetLike?.[id];
        // Structural only — playhead in/out is AnimationPlayheadSceneSync (DOM).
        if (!node || isNodeStructurallyHiddenInDocument(sceneDoc, node)) return null;
        const { left, top } = nodeLeftTop(sceneDoc, node);
        const box = effectivePaintBox(
          id,
          {
            left,
            top,
            width: Math.max(1, Number(node.width) || 1),
            height: Math.max(1, Number(node.height) || 1),
          },
          Number(node.attrs?.angle) || 0
        );
        if (box.hidden) return null;
        return {
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        };
      },
    });
    // Selection reveal: only dirty ids that entered/left AND are clipped by an
    // artboard — pasteboard shapes have nothing to re-ink on select/deselect.
    if (revealChanged && isSoaCanvasShapesEnabled()) {
      const prevSet = new Set(prevRevealIds);
      const nextSet = new Set(revealIds);
      const dirtyIds: string[] = [];
      for (const id of revealIds) {
        if (!prevSet.has(id)) dirtyIds.push(id);
      }
      for (const id of prevRevealIds) {
        if (!nextSet.has(id)) dirtyIds.push(id);
      }
      const buf = getSharedSceneRenderBuffer();
      let paintDirty = 0;
      for (const id of dirtyIds) {
        const node = sceneDoc.deltaSetLike?.[id];
        if (!findClippingFrameForNode(sceneDoc, node as never)) continue;
        markSoaDirtyById(buf, id);
        paintDirty += 1;
        // FO plate must drop/restore clipped ink when selection reveal toggles.
        const owner = nodeOwnerFrameId(node);
        if (owner) scheduleArtboardInkPaint(owner);
      }
      // Raise changes z-order for all idle ink. Without a wake, SoA bake keeps
      // the pre-select order (front sibling border stays visible while hits
      // already use max+1).
      const raiseChanged =
        prevRaiseIds.length !== raiseIds.length ||
        prevRaiseIds.some((id, i) => id !== raiseIds[i]);
      if (raiseChanged) {
        resetSharedSoaBake();
        if (!wokeMembership) requestIdleCanvasFullRepaint();
      } else if (paintDirty > 0 && !wokeMembership) {
        bumpSceneCanvasIdlePaint();
      }
      let idleMode = 'reveal-set-only';
      if (raiseChanged) idleMode = 'raise-full';
      else if (paintDirty > 0) idleMode = 'delta-dirty';
      markInteractionPerf('reveal-idle', {
        mode: idleMode,
        dirty: paintDirty,
        revealDelta: dirtyIds.length,
        revealCount: revealIds.length,
        raiseCount: raiseIds.length,
        fullHosts: fullIds.length,
        canvasIdle: canvasIds.length,
        wokeMembership,
      });
    } else if (wokeMembership) {
      markInteractionPerf('reveal-idle', {
        mode: 'membership-wake',
        revealCount: revealIds.length,
        fullHosts: fullIds.length,
        canvasIdle: canvasIds.length,
        wokeMembership: true,
      });
    }
  }, [
    document,
    canvasIds,
    hiddenNodeId,
    documentPatchToken,
    aiMutationLock,
    workbenchTimelineToken,
    keepSet,
    revealSet,
    forceFullSet,
    paintRaiseSet,
    paintRaiseFrameSet,
  ]);

  useEffect(() => {
    return () => {
      setFrameClipRevealOverflowIds(null);
      setSelectionPaintRaiseIds(null);
      setSelectionPaintRaiseFrameIds(null);
      clearSceneCanvasIdlePaint();
    };
  }, []);

  const patched = useMemo(() => new Set(lastPatchedNodeIds.filter(Boolean)), [lastPatchedNodeIds]);

  if (!document || !visibleIds.length) return null;

  function hostReloadTokenFor(id: string): number | string {
    if (!patched.has(id) || lastPatchTransformOnly) return reloadToken;
    return `${reloadToken}:${documentPatchToken}`;
  }

  return (
    <div
      data-rcb-shapes-layer="1"
      data-rcb-visible-count={visibleIds.length}
      data-rcb-full-host-count={fullIds.length}
      data-rcb-canvas-idle-count={canvasIds.length}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
    >
      {fullIds.map((id) => {
        const node = document?.deltaSetLike?.[id];
        return (
          <RcbShapeHost
            key={id}
            nodeId={id}
            document={document}
            zIndex={nodePaintZIndex(
              document,
              id,
              // Plate-bound reveal must share max+1 with single-select raise —
              // otherwise the host mounts at natural z under / inside the plate.
              paintRaiseSet.has(id) || revealSet.has(id)
            )}
            reloadToken={hostReloadTokenFor(id)}
            frameClipToken={frameClipToken}
            forceHidden={isNodeOverlayHidden(document, node, hiddenNodeId === id)}
            // SoftGlow / selected shapes: drop clip so overflow matches chrome.
            // Video/audio keep clip even when forceFull (decoder host).
            revealOverflow={shouldRevealShapeOverflow(
              revealSet.has(id) || forceFullSet.has(id),
              node
            )}
          />
        );
      })}
    </div>
  );
}

export default memo(RcbShapesLayer);
