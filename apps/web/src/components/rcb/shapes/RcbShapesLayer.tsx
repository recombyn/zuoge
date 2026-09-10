import { useEffect, useLayoutEffect, useMemo, useRef, useState, memo } from 'react';
import { useSelector } from '@/store';
import { useRcbCamera, useRcbCameraMotion, useRcbViewportEl } from '../camera/context';
import { rcbViewportSceneBounds } from '../core/math';
import {
  boxesIntersect,
  nodeSceneAabb,
} from '../scene/layout/nodeAabb';
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
import {
  setFrameClipRevealOverflowIds,
  setSelectionPaintRaiseIds,
  setSelectionPaintRaiseFrameIds,
} from '@/components/rcb/selection/selectionPaintRaise';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { getCanvasEngine } from '@/components/rcb/canvas/KitCanvasHost';
import { paintIntentNeedsDomHost } from '@/components/rcb/shapes/paintIntent';
import {
  getLiveCornerRadiusPreviewNodeId,
  subscribeLiveCornerRadiusPreview,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  getLiveShapeParamsPreviewNodeId,
  subscribeLiveShapeParamsPreview,
} from '@/components/rcb/scene/document/sceneShapes';
import { RCB_AI_FLUSH, markInteractionPerf } from '@/components/editor/sceneEvents';
import RcbShapeHost from './RcbShapeHost';

function wakeKitRender(): void {
  getCanvasEngine()?.renderer.requestRender();
}

/** HTML/SVG hosts when Kit cannot replace the widget (lottie / group). */
export function nodeNeedsDomShapeHost(
  node: SceneNodeInput | null | undefined,
  forceFull = false
): boolean {
  if (!node) return true;
  return paintIntentNeedsDomHost(null, String(node.id || ''), node, { forceFull });
}

/**
 * Temporarily drop artboard clipContent only for SoftGlow / process plates
 * (and callers that pass selectedOrForceFull for those hosts).
 *
 * Plain selection must keep clip — otherwise center strokes / overflow ink paint
 * past the plate. Selection chrome may still extend outside; ink stays clipped.
 *
 * Video/audio FO shells must NOT clear clip — sole-on-board media would otherwise
 * paint past the Frame (unless SoftGlow).
 */
export function shouldRevealShapeOverflow(
  selectedOrForceFull: boolean,
  node: SceneNodeInput | null | undefined
): boolean {
  if (!selectedOrForceFull) return false;
  // SoftGlow / running process overlays need to paint past the plate.
  if (isImageProcessRunning(node)) return true;
  return false;
}

type Props = {
  document: SceneDocument;
  reloadToken?: number | string;
  /** Bumps paint for nodes touched by the latest document patch. */
  documentPatchToken?: number;
  lastPatchedNodeIds?: string[];
  /** Geometry / angle commits — keep host reloadToken stable (Phase 3). */
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
  /** Active video/audio FO shells + SoftGlow process plates. */
  forceFullIds?: readonly string[];
};

const EMPTY_KEEP: readonly string[] = [];
const EMPTY_FORCE_FULL: readonly string[] = [];
const EMPTY_FORCE_FULL_SET = new Set<string>();

/** Screen-px margin so shapes entering the view aren't blank for a frame. */
const CULL_PAD_SCREEN_PX = 96;

/** Above this count, use stepped zoom while the camera is moving. */
const EFFICIENT_ZOOM_SHAPE_THRESHOLD = 80;

/**
 * Split in-viewport ids into DomHost mounts (Kit paints everything else).
 */
export function pickFullAndCanvasIds(opts: {
  document: SceneDocument;
  visibleIds: string[];
  /** Active video/audio FO / path-edit shells only. */
  forceFullSet?: Set<string>;
  paintRaiseIds?: ReadonlySet<string> | readonly string[];
  paintRaiseFrameIds?: ReadonlySet<string> | readonly string[];
  revealOverflowIds?: ReadonlySet<string> | readonly string[];
  zoom: number;
  dpr?: number;
}): { fullIds: string[] } {
  const { document, visibleIds, zoom } = opts;
  const forceFullSet = opts.forceFullSet ?? EMPTY_FORCE_FULL_SET;
  const dpr =
    opts.dpr ??
    (typeof window !== 'undefined' ? Number(window.devicePixelRatio) || 1 : 1);
  const fullIds: string[] = [];
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
    if (String(node?.attrs?.processStatus || '') === 'running') {
      fullIds.push(id);
      continue;
    }
    if (
      paintIntentNeedsDomHost(document, id, node, {
        zoom,
        dpr,
        forceFull: forceFullSet.has(id),
        raised: isPaintRaised,
        revealed: isRevealed,
      })
    ) {
      fullIds.push(id);
    }
  }
  return { fullIds };
}

/**
 * Mounts DOM hosts (lottie/group/media FO). Vector ink is Kit `#editor-canvas` only.
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

  const aiMutationLock = useSelector(
    (s) => (s.editor?.aiMutationLock as number) || 0
  );
  const workbenchTimelineToken = useSelector(
    (s) => String(s.editor?.lottieTimelinePanel?.nodeId || '')
  );

  /** Mount only in-view (+ keep) ids — linear AABB (DomHost set is small). */
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
  }, [document, ids, stageSize, cullCam, keepSet]);

  /** Skip re-applying the same documentPatchToken when selection/layout re-enters. */
  const syncedPatchTokenRef = useRef(-1);

  const { fullIds } = useMemo(
    () =>
      pickFullAndCanvasIds({
        document,
        visibleIds,
        forceFullSet,
        paintRaiseIds: paintRaiseSet,
        paintRaiseFrameIds: paintRaiseFrameSet,
        revealOverflowIds: revealSet,
        zoom: cullCam.zoom || 1,
      }),
    [
      document,
      visibleIds,
      forceFullSet,
      paintRaiseSet,
      paintRaiseFrameSet,
      revealSet,
      cullCam.zoom,
      workbenchTimelineToken,
    ]
  );

  useLayoutEffect(() => {
    if (!document || aiMutationLock > 0) return;
    if (
      documentPatchToken > 0 &&
      syncedPatchTokenRef.current === documentPatchToken
    ) {
      return;
    }
    syncedPatchTokenRef.current = documentPatchToken;
    if (lastPatchedNodeIds.length) {
      wakeKitRender();
    }
  }, [document, documentPatchToken, reloadToken, ids, lastPatchedNodeIds, aiMutationLock]);

  // sceneReloadToken remounts hosts — allow the next layout to sync again.
  useEffect(() => {
    syncedPatchTokenRef.current = -1;
  }, [reloadToken]);

  // Live corner / shape-param previews — wake Kit paint.
  useLayoutEffect(() => {
    if (aiMutationLock > 0) return;
    const unsubRadius = subscribeLiveCornerRadiusPreview(() => {
      if (getLiveCornerRadiusPreviewNodeId()) wakeKitRender();
    });
    const unsubShapeParams = subscribeLiveShapeParamsPreview(() => {
      if (getLiveShapeParamsPreviewNodeId()) wakeKitRender();
    });
    return () => {
      unsubRadius();
      unsubShapeParams();
    };
  }, [aiMutationLock, document]);

  // AI transaction commit — wake Kit.
  useEffect(() => {
    const onFlush = () => {
      wakeKitRender();
    };
    window.addEventListener(RCB_AI_FLUSH, onFlush);
    return () => window.removeEventListener(RCB_AI_FLUSH, onFlush);
  }, []);

  // Publish paint-raise / selection-reveal registries; wake Kit when they change.
  const revealKeyRef = useRef('');
  const raiseIdsRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    if (!document) {
      setFrameClipRevealOverflowIds(null);
      setSelectionPaintRaiseIds(null);
      setSelectionPaintRaiseFrameIds(null);
      revealKeyRef.current = '';
      raiseIdsRef.current = [];
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
    const prevRaiseIds = raiseIdsRef.current;
    revealKeyRef.current = revealKey;
    raiseIdsRef.current = raiseIds;
    setFrameClipRevealOverflowIds(revealIds);
    setSelectionPaintRaiseIds(raiseIds);
    setSelectionPaintRaiseFrameIds(raiseFrameIds);
    // Plates + hosts share one mount — re-sort by data-z after selection raise.
    syncStackPaintOrder();

    if (aiMutationLock > 0) return;
    if (revealChanged) {
      const raiseChanged =
        prevRaiseIds.length !== raiseIds.length ||
        prevRaiseIds.some((id, i) => id !== raiseIds[i]);
      wakeKitRender();
      markInteractionPerf('reveal-kit', {
        mode: raiseChanged ? 'raise-full' : 'reveal-set',
        revealCount: revealIds.length,
        raiseCount: raiseIds.length,
        fullHosts: fullIds.length,
      });
    }
  }, [
    document,
    hiddenNodeId,
    documentPatchToken,
    aiMutationLock,
    workbenchTimelineToken,
    keepSet,
    revealSet,
    forceFullSet,
    paintRaiseSet,
    paintRaiseFrameSet,
    fullIds.length,
  ]);

  useEffect(() => {
    return () => {
      setFrameClipRevealOverflowIds(null);
      setSelectionPaintRaiseIds(null);
      setSelectionPaintRaiseFrameIds(null);
    };
  }, []);

  const patched = useMemo(() => new Set(lastPatchedNodeIds.filter(Boolean)), [lastPatchedNodeIds]);

  if (!document || !visibleIds.length) return null;

  function hostReloadTokenFor(id: string): number | string {
    if (!patched.has(id) || lastPatchTransformOnly) return reloadToken;
    return `${reloadToken}:${documentPatchToken}`;
  }

  return (
    <div className="pointer-events-none absolute left-0 top-0 overflow-visible">
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
            // SoftGlow / process: drop clip so overlays can paint past the plate.
            // Plain selection keeps clipContent (ink must not exceed artboard).
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
