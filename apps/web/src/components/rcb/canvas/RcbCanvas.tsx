import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  memo,
} from 'react';
import { cn } from '@/utils/classnames';
import {
  RcbCameraContext,
  RcbCameraMotionContext,
  RcbDevicePixelRatioContext,
  RcbOverlayRootContext,
  RcbViewportElContext,
} from '../camera/context';
import { readDevicePixelRatio, subscribeDevicePixelRatio } from '../core/dpr';
import {
  rcbCameraCssZoom,
  rcbCameraScreenOffset,
  rcbClientToStageLocal,
  rcbFitCamera,
  rcbStepZoom,
  rcbZoomAtPoint,
} from '../core/math';
import { getSharedSceneSpatialRuntime } from '../core/spatialIndex';
import { RCB_DEFAULT_CAMERA, type RcbCamera } from '../core/types';
import { cameraSvgTransform, createCameraTransform } from '../camera/transform';
import {
  createCanvasSceneRenderer,
  createSceneRenderer,
  getSceneCanvasIdlePaint,
  listSceneCanvasIdlePaintIds,
  resolveIdleInkBackend,
  isNoopSoaDirtyRegion,
  resolveSoaCanvasDirtyRegion,
  subscribeSceneCanvasIdlePaint,
  subscribeGpuDepthOfField,
  consumeIdleCanvasFullRepaintPending,
  type SceneRenderer,
} from '../render/sceneRenderer';
import { soaWebglInkShadersOk } from '../render/webglSceneRenderer';
import {
  getSharedSceneRenderBuffer,
  isSoaCanvasShapesEnabled,
  markSoaDirtyById,
  markAllSoaDirty,
  markSoaDirtyForFrameIds,
} from '../render/sceneRenderBuffer';
import {
  accumulateSoaGestureDirtyFromBuffer,
  clearSoaGestureDirtyAccum,
  setSoaCameraGestureActive,
} from '../render/soaBakeLayer';
import {
  hasNodeTransformPreviews,
  listNodeTransformPreviewIds,
  subscribeTransformPreview,
} from '../core/transformPreview';
import {
  getLiveArtboardFrameIds,
  subscribeLiveArtboardFrameGeometry,
} from '../frames/HtmlArtboardFrame';
import {
  getLiveCornerRadiusPreviewNodeId,
  hasLiveCornerRadiusPreview,
  subscribeLiveCornerRadiusPreview,
} from '../scene/document/sceneRadii';
import {
  getLiveShapeParamsPreviewNodeId,
  hasLiveShapeParamsPreview,
  subscribeLiveShapeParamsPreview,
} from '../scene/document/sceneShapes';
import type { SceneDocument } from '../sceneNode';
import { setInfiniteSvgPaintCamera } from '../scene/paint/sceneToSvg';
import { notifyShapeHostGeometry, setSceneWorldRoot } from '../shapes/shapeHostRegistry';
import { DEFAULT_GRID_SIZE, shouldShowPixelGrid } from '../selection/alignGuides';
import { textFrameBlocksBrowserZoom, wheelShouldStayLocal } from './wheelScrollOwners';
import { tryConsumeLottieTimelineSpace } from '@/components/editor/nodes/AnimationNode/animationTimelineHotkeys';
import { markInteractionPerf } from '@/components/editor/sceneEvents';
import { ensureRcbPaintDebugInstalled } from '@/components/rcb/render/paintDebug';

const EMPTY_SCENE_DOC: SceneDocument = {
  deltaSetLike: {
    ROOT: {
      id: 'ROOT',
      key: 'group',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      attrs: {},
      children: [],
    },
  },
};

export type { RcbCamera };
export { RCB_DEFAULT_CAMERA };

function markGestureSoaDirty(opts: {
  previewIds: readonly string[];
  liveFrameIds: readonly string[];
  plateOrParamGesture: boolean;
}): void {
  if (!isSoaCanvasShapesEnabled()) return;
  const buf = getSharedSceneRenderBuffer();
  if (opts.previewIds.length) {
    for (const id of opts.previewIds) markSoaDirtyById(buf, id);
    accumulateSoaGestureDirtyFromBuffer(buf);
    return;
  }
  if (opts.liveFrameIds.length) {
    const idleDoc = getSceneCanvasIdlePaint()?.document ?? EMPTY_SCENE_DOC;
    markSoaDirtyForFrameIds(buf, idleDoc, new Set(opts.liveFrameIds));
    return;
  }
  if (opts.plateOrParamGesture) markAllSoaDirty(buf);
}

/**
 * Scene-space pixel-grid path (integer multiples of `g`).
 * Kept for tests / export helpers — live editor paints the grid on the
 * Canvas2D grid surface (`createCanvasSceneRenderer`), not as SVG path ink.
 */
export function buildPixelGridPathD(
  left: number,
  top: number,
  width: number,
  height: number,
  gridSize: number
): string {
  const g = gridSize > 0 ? gridSize : 1;
  const right = left + Math.max(0, width);
  const bottom = top + Math.max(0, height);
  const x0 = Math.floor(left / g) * g;
  const y0 = Math.floor(top / g) * g;
  const parts: string[] = [];
  for (let x = x0; x <= right + 1e-9; x += g) {
    parts.push(`M ${x} ${y0} V ${bottom}`);
  }
  for (let y = y0; y <= bottom + 1e-9; y += g) {
    parts.push(`M ${x0} ${y} H ${right}`);
  }
  return parts.join(' ');
}

/** Zoom about a stage-local point — convenience for host zoom controls. */
export function zoomAtPoint(
  camera: RcbCamera,
  nextZoom: number,
  localX: number,
  localY: number,
  dpr?: number
): RcbCamera {
  return rcbZoomAtPoint(camera, nextZoom, localX, localY, dpr);
}

export type RcbCanvasProps = {
  /**
   * Scene bounds used for one-shot autofit when `fitKey` changes.
   * Pass `{ width: 0, height: 0 }` to skip fit (empty document).
   */
  artboard: { x?: number; y?: number; width: number; height: number };
  camera: RcbCamera;
  onCameraChange: (next: RcbCamera) => void;
  /** Hand / space-pan mode. */
  panMode?: boolean;
  /** Select tool: left-drag on empty canvas starts pan after a short threshold. */
  emptyDragPans?: boolean;
  shouldBlockEmptyPan?: (e: PointerEvent) => boolean;
  /**
   * CSS selectors that block empty-canvas pan (selection chrome, etc.).
   * Host app supplies product-specific targets.
   */
  panBlockSelector?: string;
  className?: string;
  /** World-layer scene content (scaled with camera). */
  children: ReactNode;
  /** Optional SVG defs / ambient nodes inside the viewport (not scaled). */
  defs?: ReactNode;
  /**
   * Pixel-grid pitch in scene units (default 1). Auto-shows around ≥800% zoom.
   * Painted on the stage Canvas2D grid surface (camera baked into ctx — not under
   * world CSS `scale`).
   */
  gridSize?: number;
  stageRef?: RefObject<HTMLDivElement | null>;
  /**
   * Fires whenever the live viewport node mounts/unmounts.
   * Hosts must use this (not a one-shot effect) so stageEl stays connected
   * after resize / mobile breakpoint remounts.
   */
  onViewportEl?: (el: HTMLElement | null) => void;
  cursor?: string;
  background?: string;
  /** Stable id for one-time autofit (e.g. document id). */
  fitKey?: string;
};

/**
 * Layers:
 *   1. Grid canvas
 *   2. SoA / canvas shape ink (under stack SVG)
 *   3. Stack SVG — artboard plates + DOM hosts interleaved by stackOrder data-z
 *   4. Chrome SVG (preview, guides, selection)
 *   5. Overlay HTML UI
 */
function RcbCanvas({
  artboard,
  camera,
  onCameraChange,
  panMode = false,
  emptyDragPans = false,
  shouldBlockEmptyPan,
  panBlockSelector = '',
  className,
  children,
  defs = null,
  gridSize = DEFAULT_GRID_SIZE,
  stageRef: stageRefProp,
  onViewportEl,
  cursor,
  background,
  fitKey,
}: RcbCanvasProps) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const stageRef = stageRefProp || localRef;
  const onViewportElRef = useRef(onViewportEl);
  onViewportElRef.current = onViewportEl;
  const cameraRef = useRef(camera);
  const panRef = useRef<{ x: number; y: number; scaleX: number; scaleY: number } | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const spaceDown = useRef(false);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [cameraMoving, setCameraMoving] = useState(false);
  const cameraMovingRef = useRef(false);
  cameraMovingRef.current = cameraMoving;
  const emptyDragPansRef = useRef(emptyDragPans);
  const shouldBlockEmptyPanRef = useRef(shouldBlockEmptyPan);
  const panBlockSelectorRef = useRef(panBlockSelector);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const fittedKey = useRef('');
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => readDevicePixelRatio());
  const devicePixelRatioRef = useRef(devicePixelRatio);
  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const paintRendererRef = useRef<SceneRenderer | null>(null);
  const inkRendererRef = useRef<SceneRenderer | null>(null);
  const gridSizeRef = useRef(gridSize);
  const paintStageSurfacesNowRef = useRef<(opts?: { forceFull?: boolean }) => void>(
    () => undefined
  );

  cameraRef.current = camera;
  gridSizeRef.current = gridSize;
  devicePixelRatioRef.current = devicePixelRatio;

  const markCameraMoving = useCallback(() => {
    setCameraMoving(true);
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      setCameraMoving(false);
    }, 140);
  }, []);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current);
      setSoaCameraGestureActive(false);
    };
  }, []);

  useEffect(() => {
    ensureRcbPaintDebugInstalled();
  }, []);

  const cameraMotion = useMemo(
    () => ({
      moving: cameraMoving,
      efficientZoom: cameraMoving ? rcbStepZoom(camera.zoom) : camera.zoom,
    }),
    [cameraMoving, camera.zoom]
  );

  // Browser zoom / HiDPI — keep DPR in sync (camera pan snaps to this).
  useEffect(() => subscribeDevicePixelRatio(setDevicePixelRatio), []);

  emptyDragPansRef.current = emptyDragPans;
  shouldBlockEmptyPanRef.current = shouldBlockEmptyPan;
  panBlockSelectorRef.current = panBlockSelector;
  const emptyWorld = !(artboard.width > 0 && artboard.height > 0);

  // Must be stable: a new ref callback every render makes React detach (null) +
  // reattach (node), which re-enters setState and hits max update depth (e.g. tour
  // opening Agent and re-layouting the stage).
  const setStageNode = useCallback((node: HTMLDivElement | null) => {
    if (stageRefProp) {
      (stageRefProp as { current: HTMLDivElement | null }).current = node;
    } else {
      localRef.current = node;
    }
    setViewportEl((prev) => (prev === node ? prev : node));
    onViewportElRef.current?.(node);
  }, [stageRefProp]);

  useEffect(() => {
    const key = fitKey || 'default';
    if (emptyWorld) {
      // Remember we opened empty so the first real artboard can still autofit.
      if (fittedKey.current !== key) fittedKey.current = `${key}:empty`;
      return;
    }
    // Already fitted for this key — skip. Do NOT treat `:empty` as fitted:
    // empty → first frame must run rcbFitCamera so content centers in the viewport.
    if (fittedKey.current === key) return;
    const el = stageRef.current || viewportEl;
    if (!el) return;
    let cancelled = false;
    let tries = 0;
    const applyFit = () => {
      if (cancelled) return;
      const stage = stageRef.current || viewportEl;
      if (!stage) return;
      const vw = stage.clientWidth;
      const vh = stage.clientHeight;
      if (vw < 40 || vh < 40) {
        // Stage not laid out yet — retry a few frames.
        if (tries++ < 30) requestAnimationFrame(applyFit);
        return;
      }
      fittedKey.current = key;
      // clientWidth/Height match camera.x/y layout space (not visual getBoundingClientRect).
      onCameraChange(rcbFitCamera({ width: vw, height: vh }, artboard));
    };
    applyFit();
    return () => {
      cancelled = true;
    };
  }, [fitKey, emptyWorld, artboard.x, artboard.y, artboard.width, artboard.height, onCameraChange, stageRef, viewportEl, artboard]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      const t = e.target as HTMLElement | null;
      if (
        t instanceof HTMLInputElement ||
        t instanceof HTMLTextAreaElement ||
        t?.isContentEditable
      ) {
        return;
      }
      if (tryConsumeLottieTimelineSpace()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (e.repeat) return;
      spaceDown.current = true;
      setSpaceHeld(true);
      e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      spaceDown.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
    };
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;

    const isPanTool = () => panMode || spaceDown.current;

    const beginPan = (e: PointerEvent) => {
      pendingPanRef.current = null;
      e.preventDefault();
      e.stopPropagation();
      const local = rcbClientToStageLocal(el, e.clientX, e.clientY);
      panRef.current = { x: local.x, y: local.y, scaleX: local.scaleX, scaleY: local.scaleY };
      el.setPointerCapture?.(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      const target = e.target as Element | null;
      // Text-frame + pinch: prevent browser page-zoom, then fall through to canvas zoom.
      if (textFrameBlocksBrowserZoom(target, e)) {
        e.preventDefault();
      } else if (wheelShouldStayLocal(target, e)) {
        // Scrollable panels/menus own wheel — do not pan/zoom or preventDefault.
        return;
      } else {
        e.preventDefault();
      }
      const local = rcbClientToStageLocal(el, e.clientX, e.clientY);
      const cam = cameraRef.current;
      markCameraMoving();

      let deltaX = e.deltaX;
      let deltaY = e.deltaY;
      // Normalize line/page deltas so trackpads don't pan/zoom by huge jumps.
      if (e.deltaMode === 1) {
        deltaX *= 16;
        deltaY *= 16;
      } else if (e.deltaMode === 2) {
        deltaX *= el.clientWidth;
        deltaY *= el.clientHeight;
      }

      if (e.ctrlKey || e.metaKey) {
        onCameraChange(
          rcbZoomAtPoint(
            cam,
            cam.zoom * (deltaY > 0 ? 0.92 : 1.08),
            local.x,
            local.y,
            devicePixelRatioRef.current
          )
        );
        return;
      }
      const sx = local.scaleX > 0 ? local.scaleX : 1;
      const sy = local.scaleY > 0 ? local.scaleY : 1;
      onCameraChange({
        ...cam,
        x: cam.x - deltaX / sx,
        y: cam.y - deltaY / sy,
      });
    };

    const onDown = (e: PointerEvent) => {
      if (e.button === 1 || isPanTool()) {
        beginPan(e);
        return;
      }
      if (e.button !== 0 || !emptyDragPansRef.current) return;
      const target = e.target as Element | null;
      const block = panBlockSelectorRef.current;
      if (block && target?.closest?.(block)) return;
      if (shouldBlockEmptyPanRef.current?.(e)) return;
      pendingPanRef.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    };
    const onMove = (e: PointerEvent) => {
      if (panRef.current) {
        const local = rcbClientToStageLocal(el, e.clientX, e.clientY);
        const dx = local.x - panRef.current.x;
        const dy = local.y - panRef.current.y;
        panRef.current = {
          x: local.x,
          y: local.y,
          scaleX: local.scaleX,
          scaleY: local.scaleY,
        };
        const cam = cameraRef.current;
        markCameraMoving();
        onCameraChange({ ...cam, x: cam.x + dx, y: cam.y + dy });
        return;
      }
      const pending = pendingPanRef.current;
      if (!pending || pending.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < 4) return;
      beginPan(e);
    };
    const onUp = (e: PointerEvent) => {
      pendingPanRef.current = null;
      if (!panRef.current) return;
      panRef.current = null;
      try {
        el.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown, { capture: true });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown, { capture: true } as EventListenerOptions);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panMode, onCameraChange, stageRef, markCameraMoving]);

  const panning = panMode || spaceHeld;

  // Re-assert after child tool effects (pen cleanup used to wipe style.cursor).
  useEffect(() => {
    const el = stageRef.current;
    if (!el || panning) return;
    el.style.cursor = cursor || '';
  }, [cursor, panning, stageRef]);

  // Snap pan to the device-pixel grid. Shape hosts share one camera world
  // viewport; the pixel lattice paints on the stage Canvas grid surface.
  const { x: camX, y: camY } = rcbCameraScreenOffset(camera, devicePixelRatio);
  const camZ = rcbCameraCssZoom(camera);
  const stageW = viewportEl?.clientWidth || 0;
  const stageH = viewportEl?.clientHeight || 0;
  setInfiniteSvgPaintCamera(camera, devicePixelRatio, { width: stageW, height: stageH });
  const g = gridSize > 0 ? gridSize : DEFAULT_GRID_SIZE;
  const showPixelGrid = shouldShowPixelGrid(camZ);
  const sceneLeft = -camX / camZ;
  const sceneTop = -camY / camZ;

  // Keep every host on the shared world viewport; bump chrome to re-mirror.
  // useLayoutEffect: same frame as world CSS camera — useEffect left one paint of desync.
  useLayoutEffect(() => {
    setInfiniteSvgPaintCamera(camera, devicePixelRatio, {
      width: viewportEl?.clientWidth || 0,
      height: viewportEl?.clientHeight || 0,
    });
  }, [camera, devicePixelRatio, viewportEl?.clientWidth, viewportEl?.clientHeight]);

  // z-order: grid → SoA canvas ink → stack SVG (plates+hosts) → chrome.
  const sceneInkSvgRef = useRef<SVGSVGElement | null>(null);
  const sceneChromeSvgRef = useRef<SVGSVGElement | null>(null);

  const publishSceneWorldMounts = useCallback(() => {
    const ink = sceneInkSvgRef.current;
    const chrome = sceneChromeSvgRef.current;
    const inkCamera = ink
      ? (ink.querySelector(':scope > g[data-rcb-scene-camera]') as SVGGElement | null)
      : null;
    const chromeCamera = chrome
      ? (chrome.querySelector(':scope > g[data-rcb-scene-camera]') as SVGGElement | null)
      : null;
    const mount = inkCamera
      ? (inkCamera.querySelector(':scope > g[data-rcb-shapes-mount]') as SVGGElement | null)
      : null;
    const previewMount = chromeCamera
      ? (chromeCamera.querySelector(
          ':scope > g[data-rcb-draw-preview-mount]'
        ) as SVGGElement | null)
      : null;
    const guidesMount = chromeCamera
      ? (chromeCamera.querySelector(':scope > g[data-rcb-smart-guides-mount]') as SVGGElement | null)
      : null;
    const selectionChromeMount = chromeCamera
      ? (chromeCamera.querySelector(
          ':scope > g[data-rcb-selection-chrome-mount]'
        ) as SVGGElement | null)
      : null;
    // Plates alias onto the shapes mount inside setSceneWorldRoot.
    setSceneWorldRoot(ink, mount, previewMount, guidesMount, selectionChromeMount);
  }, []);

  const setSceneInkRootNode = useCallback(
    (node: SVGSVGElement | null) => {
      sceneInkSvgRef.current = node;
      publishSceneWorldMounts();
    },
    [publishSceneWorldMounts]
  );

  const setSceneChromeRootNode = useCallback(
    (node: SVGSVGElement | null) => {
      sceneChromeSvgRef.current = node;
      publishSceneWorldMounts();
    },
    [publishSceneWorldMounts]
  );
  useEffect(() => {
    return () => setSceneWorldRoot(null, null, null, null, null);
  }, []);

  const paintCameraKeyRef = useRef('');
  const paintStageKeyRef = useRef('');
  /** Zoom/DPR/stage changes need full ink; pan uses dirty AABB / live WebGL. */
  const paintCameraZoomRef = useRef(Number.NaN);
  const paintCameraOffsetRef = useRef<{ x: number; y: number } | null>(null);
  /** Backend recreate / idle-list identity still forces one full ink pass. */
  const transformPreviewFullPaintRef = useRef(false);

  // Stage: grid → SoA ink → shared stack SVG (plates+hosts by stackOrder) → chrome.
  // Hit uses the product SceneSpatialRuntime published by SvgCanvas (one path).
  // Recreate ink backend when GPU DOF params change (WebGL2 DOF pass).
  const [inkBackendKey, setInkBackendKey] = useState(() => resolveIdleInkBackend());
  const inkBackendKeyRef = useRef(inkBackendKey);
  inkBackendKeyRef.current = inkBackendKey;
  // If WebGL shaders fail, never bind webgl2 onto the stage ink canvas (blocks 2d).
  // Remount the <canvas> when falling back so a prior failed GL claim is discarded.
  const inkUsesWebgl = inkBackendKey === 'webgl' && soaWebglInkShadersOk();
  const inkSurfaceKey = `${inkBackendKey}:${inkUsesWebgl ? 'gl' : '2d'}`;
  const effectiveInkBackend =
    inkBackendKey === 'webgl' && !inkUsesWebgl ? 'canvas2d' : inkBackendKey;
  useEffect(() => {
    return subscribeGpuDepthOfField(() => {
      setInkBackendKey(resolveIdleInkBackend());
      transformPreviewFullPaintRef.current = true;
      paintStageSurfacesNowRef.current({ forceFull: true });
    });
  }, []);

  // Idle-preload WASM geom (densify / tessellate / boolean / offset / contour).
  useEffect(() => {
    void import('@/components/rcb/render/vector/wasmGeom').then((m) => {
      m.preloadWasmGeom();
    });
  }, []);

  useEffect(() => {
    const gridCanvas = paintCanvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!gridCanvas || !inkCanvas) return;
    const sharedDeps = {
      getDocument: () => getSceneCanvasIdlePaint()?.document ?? EMPTY_SCENE_DOC,
      getSpatial: () => {
        const shared = getSharedSceneSpatialRuntime();
        if (!shared) {
          throw new Error('SceneSpatialRuntime not published');
        }
        return shared;
      },
      getZoom: () => rcbCameraCssZoom(cameraRef.current),
      listNodeIds: () => listSceneCanvasIdlePaintIds(),
      getNodeBox: (id: string) => getSceneCanvasIdlePaint()?.getNodeBox(id) ?? null,
      drawNodeProxies: false,
      drawBasicShapes: false,
      getGridSize: () => {
        const n = gridSizeRef.current;
        return n > 0 ? n : DEFAULT_GRID_SIZE;
      },
      shouldShowGrid: shouldShowPixelGrid,
    };
    const gridRenderer = createCanvasSceneRenderer({
      ...sharedDeps,
      canvas: gridCanvas,
      paintGrid: true,
      drawCanvasIdle: false,
    });
    const inkRenderer = createSceneRenderer(effectiveInkBackend, {
      ...sharedDeps,
      canvas: inkCanvas,
      paintGrid: false,
      drawCanvasIdle: true,
    });
    paintRendererRef.current = gridRenderer;
    inkRendererRef.current = inkRenderer;
    transformPreviewFullPaintRef.current = true;
    return () => {
      gridRenderer.dispose();
      inkRenderer.dispose();
      paintRendererRef.current = null;
      inkRendererRef.current = null;
    };
  }, [effectiveInkBackend, inkSurfaceKey]);

  useEffect(() => {
    return subscribeSceneCanvasIdlePaint(() => {
      // Paint immediately from the subscription. setState here used to nest a full
      // RcbCanvas→SvgCanvas re-render inside RcbShapesLayer's layout reveal and
      // froze multi-paste once the React tree + history got heavy.
      paintStageSurfacesNowRef.current();
    });
  }, []);

  const stageSizeRef = useRef({ w: stageW, h: stageH });
  stageSizeRef.current = { w: stageW, h: stageH };
  const showPixelGridRef = useRef(showPixelGrid);
  showPixelGridRef.current = showPixelGrid;

  /**
   * Paint grid + SoA ink from live refs.
   * Frame-plate SVG updates synchronously on drag; ink must not wait for React
   * setState or children jitter one frame behind the plate.
   */
  const paintStageSurfacesNow = useCallback((opts?: { forceFull?: boolean }) => {
    const { w: sw, h: sh } = stageSizeRef.current;
    if (sw <= 0 || sh <= 0) return;
    const cam = cameraRef.current;
    const dpr = devicePixelRatioRef.current;
    const grid = gridSizeRef.current;
    const idleDoc = getSceneCanvasIdlePaint()?.document ?? EMPTY_SCENE_DOC;
    const cameraKey = `${cam.x},${cam.y},${cam.zoom}`;
    const stageKey = `${sw}x${sh}@${dpr}|g${grid > 0 ? grid : DEFAULT_GRID_SIZE}|pg${showPixelGridRef.current ? 1 : 0}`;
    const prevZoom = paintCameraZoomRef.current;
    const zoomChanged =
      !Number.isFinite(prevZoom) || Math.abs(prevZoom - cam.zoom) > 1e-9;
    const stageChanged = paintStageKeyRef.current !== stageKey;
    const zoomOrStageChanged = stageChanged || zoomChanged;
    const cameraPanOnly =
      paintCameraKeyRef.current !== cameraKey &&
      !zoomOrStageChanged &&
      Number.isFinite(prevZoom);
    paintCameraKeyRef.current = cameraKey;
    paintStageKeyRef.current = stageKey;
    paintCameraZoomRef.current = cam.zoom;

    const nextOffset = rcbCameraScreenOffset(cam, dpr);
    paintCameraOffsetRef.current = nextOffset;

    // Skip Worker bake while pan/zoom is in flight; resume on settle.
    setSoaCameraGestureActive(cameraMovingRef.current);

    // WebGL ink clears every frame. Camera/stage changes must still mark dirty:full
    // so paint is not skipped as empty-noop; bake is gated by camera gesture above.
    let forceFull =
      opts?.forceFull === true ||
      transformPreviewFullPaintRef.current ||
      consumeIdleCanvasFullRepaintPending() ||
      zoomOrStageChanged ||
      cameraPanOnly;
    transformPreviewFullPaintRef.current = false;

    const soaOn = isSoaCanvasShapesEnabled();

    const dirty = resolveSoaCanvasDirtyRegion({
      full: forceFull || !soaOn,
      buf: soaOn ? getSharedSceneRenderBuffer() : null,
    });
    // Second bump after dirty flags cleared must not wipe retained ink.
    if (isNoopSoaDirtyRegion(dirty)) {
      markInteractionPerf('idle-paint', {
        dirty: 'skip-empty',
        forceFull,
        cameraPanOnly,
        zoomOrStageChanged,
        soaOn,
      });
      return;
    }

    const req = {
      document: idleDoc,
      camera: cam,
      dirty,
      stage: { width: sw, height: sh },
      dpr,
    };
    paintRendererRef.current?.render(req);
    inkRendererRef.current?.render(req);
    // Keep cross-frame dirty union while TransformPreview is live. Clearing every
    // paint left S-curve / wave trails: each frame only unions doc-base↔current,
    // so mid-path peaks outside that AABB never erase (幻影).
    // Full clear already wiped the surface — accum can drop. Preview end clears
    // on the following paint (hasNodeTransformPreviews → false).
    if (forceFull || dirty.kind === 'full' || !hasNodeTransformPreviews()) {
      clearSoaGestureDirtyAccum();
    }
    markInteractionPerf('idle-paint', {
      dirty: dirty.kind,
      forceFull,
      cameraPanOnly,
      zoomOrStageChanged,
      soaOn,
      bakeSkippedForGesture: cameraMovingRef.current,
    });
  }, []);
  paintStageSurfacesNowRef.current = paintStageSurfacesNow;

  const gestureInkRafRef = useRef(0);
  const scheduleGestureInkRepaint = useCallback(() => {
    if (gestureInkRafRef.current) return;
    gestureInkRafRef.current = requestAnimationFrame(() => {
      gestureInkRafRef.current = 0;
      const previewIds = listNodeTransformPreviewIds();
      const liveFrameIds = getLiveArtboardFrameIds();
      // Selection reveal dirties entered/left ids only — see RcbShapesLayer.
      const plateOrParamGesture =
        liveFrameIds.length > 0 ||
        hasLiveCornerRadiusPreview() ||
        hasLiveShapeParamsPreview();
      markGestureSoaDirty({ previewIds, liveFrameIds, plateOrParamGesture });
      // Plate-local / radius / params still full-clear (frameLocal ink).
      if (plateOrParamGesture) {
        transformPreviewFullPaintRef.current = true;
        paintStageSurfacesNow({ forceFull: true });
        return;
      }
      paintStageSurfacesNow();
    });
  }, [paintStageSurfacesNow]);

  useEffect(() => {
    return () => {
      if (gestureInkRafRef.current) {
        cancelAnimationFrame(gestureInkRafRef.current);
        gestureInkRafRef.current = 0;
      }
    };
  }, []);

  useEffect(() => {
    return subscribeTransformPreview(() => {
      scheduleGestureInkRepaint();
    });
  }, [scheduleGestureInkRepaint]);

  // Frame-local children: plate live geom changes world paint without child attrs.
  // Coalesce to one rAF — sync full paint on every pointermove freezes the tab.
  useEffect(() => {
    return subscribeLiveArtboardFrameGeometry(() => {
      scheduleGestureInkRepaint();
    });
  }, [scheduleGestureInkRepaint]);

  useEffect(() => {
    return subscribeLiveCornerRadiusPreview(() => {
      if (isSoaCanvasShapesEnabled()) {
        const nodeId = getLiveCornerRadiusPreviewNodeId();
        if (nodeId) markSoaDirtyById(getSharedSceneRenderBuffer(), nodeId);
      }
      transformPreviewFullPaintRef.current = true;
      paintStageSurfacesNow({ forceFull: true });
    });
  }, [paintStageSurfacesNow]);

  useEffect(() => {
    return subscribeLiveShapeParamsPreview(() => {
      if (isSoaCanvasShapesEnabled()) {
        const nodeId = getLiveShapeParamsPreviewNodeId();
        if (nodeId) markSoaDirtyById(getSharedSceneRenderBuffer(), nodeId);
      }
      transformPreviewFullPaintRef.current = true;
      paintStageSurfacesNow({ forceFull: true });
    });
  }, [paintStageSurfacesNow]);

  useLayoutEffect(() => {
    paintStageSurfacesNow();
  }, [camera, devicePixelRatio, stageW, stageH, g, showPixelGrid, paintStageSurfacesNow]);

  const sceneCameraTransform = cameraSvgTransform(
    createCameraTransform(camera, devicePixelRatio)
  );

  return (
    <RcbCameraContext.Provider value={camera}>
      <RcbCameraMotionContext.Provider value={cameraMotion}>
      <RcbDevicePixelRatioContext.Provider value={devicePixelRatio}>
        <RcbViewportElContext.Provider value={viewportEl}>
          <RcbOverlayRootContext.Provider value={overlayEl}>
            <div
              ref={setStageNode}
              data-rcb-canvas="1"
              data-canvas-stage="1"
              data-rcb-dpr={String(devicePixelRatio)}
              className={cn(
                // Own pan/zoom/draw — block browser scroll/pinch so it cannot
                // fire pointercancel mid-gesture (common on tablet / DevTools device).
                'relative h-full w-full touch-none overflow-hidden select-none',
                !background && 'bg-[var(--canvas)]',
                panning && 'cursor-grab active:cursor-grabbing',
                // Tool cursors (eraser / pencil / …) inherit onto shapes — but
                // selection resize/rotate hits must keep their own cursors.
                !panning && cursor && '[&_*:not([data-sel-handle]):not([data-radius-handle]):not([data-star-handle]):not([data-poly-handle]):not([data-circle-handle])]:!cursor-inherit',
                !panning && !cursor && 'cursor-default',
                className
              )}
              style={{
                ...(background ? { background } : null),
                // Always set so leaving a tool clears any previous inline cursor.
                cursor: !panning && cursor ? cursor : '',
              }}
            >
              <style>{`
                /* HTML <video> paints; SVG poster is hit/export underlay only.
                   Hide on the live canvas so move cannot show a second layer.
                   Export builds its own SVG (no this rule). */
                [data-rcb-canvas] [data-rcb-video-svg-underlay="1"] { opacity: 0; }
              `}</style>
              {defs}
              {/* Grid under stack ink. */}
              <canvas
                ref={paintCanvasRef}
                aria-hidden
                data-rcb-scene-canvas="1"
                data-rcb-pixel-grid={showPixelGrid ? '1' : undefined}
                data-rcb-grid-size={String(g)}
                data-rcb-grid-left={String(Math.floor(sceneLeft / g) * g)}
                data-rcb-grid-top={String(Math.floor(sceneTop / g) * g)}
                className="pointer-events-none absolute inset-0 z-0"
              />
              <canvas
                key={inkSurfaceKey}
                ref={inkCanvasRef}
                aria-hidden
                data-rcb-idle-ink-canvas="1"
                data-rcb-ink-surface={inkSurfaceKey}
                data-rcb-canvas-idle-count={String(listSceneCanvasIdlePaintIds().length)}
                className="pointer-events-none absolute inset-0 z-[1]"
              />
              {/* Plates + DOM hosts — one mount, stackOrder data-z. */}
              {stageW > 0 && stageH > 0 ? (
                <svg
                  ref={setSceneInkRootNode}
                  aria-hidden
                  data-rcb-scene-root="1"
                  data-rcb-screen-surface="1"
                  data-rcb-infinite="1"
                  data-rcb-shared-scene-surface="1"
                  data-rcb-scene-surface="1"
                  data-rcb-grid-size={String(g)}
                  className="pointer-events-none absolute inset-0 z-[2] overflow-hidden"
                  width={stageW}
                  height={stageH}
                  viewBox={`0 0 ${stageW} ${stageH}`}
                  preserveAspectRatio="none"
                  style={{
                    width: stageW,
                    height: stageH,
                    display: 'block',
                    // Hard clip at the camera viewport (viewBox). Parent also
                    // overflow-hidden; keep SVG clipped so overflow:visible ink
                    // cannot paint past the stage edge.
                    overflow: 'hidden',
                    shapeRendering: 'geometricPrecision',
                    pointerEvents: 'none',
                    isolation: 'isolate',
                  }}
                >
                  <g data-rcb-scene-camera="1" transform={sceneCameraTransform}>
                    <g data-rcb-shapes-mount="1" />
                  </g>
                </svg>
              ) : null}
              {/* Draw preview / guides / selection above stack paint. */}
              {stageW > 0 && stageH > 0 ? (
                <svg
                  ref={setSceneChromeRootNode}
                  aria-hidden
                  data-rcb-scene-chrome-root="1"
                  data-rcb-screen-surface="1"
                  data-rcb-infinite="1"
                  className="pointer-events-none absolute inset-0 z-[3] overflow-visible"
                  width={stageW}
                  height={stageH}
                  viewBox={`0 0 ${stageW} ${stageH}`}
                  preserveAspectRatio="none"
                  style={{
                    width: stageW,
                    height: stageH,
                    display: 'block',
                    overflow: 'visible',
                    shapeRendering: 'geometricPrecision',
                    pointerEvents: 'none',
                    isolation: 'isolate',
                  }}
                >
                  <g data-rcb-scene-camera="1" transform={sceneCameraTransform}>
                    <g data-rcb-draw-preview-mount="1" />
                    <g data-rcb-smart-guides-mount="1" />
                    <g data-rcb-selection-chrome-mount="1" pointerEvents="none" />
                  </g>
                </svg>
              ) : null}
              {children}
              <div
                ref={setOverlayEl}
                data-rcb-overlay="1"
                className="pointer-events-none absolute inset-0 z-[20] overflow-visible"
              />
            </div>
          </RcbOverlayRootContext.Provider>
        </RcbViewportElContext.Provider>
      </RcbDevicePixelRatioContext.Provider>
      </RcbCameraMotionContext.Provider>
    </RcbCameraContext.Provider>
  );
}

export default memo(RcbCanvas);
