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
import { useSelector, type RootState } from '@/store';
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
import { RCB_DEFAULT_CAMERA, type RcbCamera } from '../core/types';
import { cameraCssTransform, createCameraTransform } from '../camera/transform';
import { setSceneWorldRoot } from '../shapes/shapeHostRegistry';
import { DEFAULT_GRID_SIZE } from '../selection/alignGuides';
import { textFrameBlocksBrowserZoom, wheelShouldStayLocal } from './wheelScrollOwners';
import { tryConsumeLottieTimelineSpace } from '@/components/editor/nodes/AnimationNode/animationTimelineHotkeys';
import KitCanvasHost from './KitCanvasHost';
import { kitOwnsStagePointer, resolveEngineTool } from './toolMap';

export type { RcbCamera };
export { RCB_DEFAULT_CAMERA };

/**
 * Scene-space pixel-grid path (integer multiples of `g`).
 * Kept for tests / export helpers — live editor paints the grid via Kit.
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
  /** Scene bounds for one-shot autofit when `fitKey` changes (`0×0` skips). */
  artboard: { x?: number; y?: number; width: number; height: number };
  camera: RcbCamera;
  onCameraChange: (next: RcbCamera) => void;
  /** Hand / space-pan mode. */
  panMode?: boolean;
  /** Select tool: left-drag on empty canvas starts pan after a short threshold. */
  emptyDragPans?: boolean;
  shouldBlockEmptyPan?: (e: PointerEvent) => boolean;
  /** CSS selectors that block empty-canvas pan (selection chrome, etc.). */
  panBlockSelector?: string;
  className?: string;
  /** World-layer scene content (scaled with camera). */
  children: ReactNode;
  /** @deprecated Stage-wide SVG removed; ignored. */
  defs?: ReactNode;
  /** When false, skip HTML DomHost camera (Kit `#editor-canvas` only). Default true. */
  hostSurface?: boolean;
  /** Document grid pitch (snap). Live lattice is Kit; kept for host API. */
  gridSize?: number;
  stageRef?: RefObject<HTMLDivElement | null>;
  /** Fires whenever the live viewport node mounts/unmounts. */
  onViewportEl?: (el: HTMLElement | null) => void;
  cursor?: string;
  background?: string;
  /** Stable id for one-time autofit (e.g. document id). */
  fitKey?: string;
};

/**
 * Layers (vector paint = Kit canvas only):
 *   1. Kit `#editor-canvas` — artboards, shapes, create ink, selection, snap guides
 *   2. Optional HTML camera — DomHost wraps only (lottie/media/plates); never stage SVG
 *   3. Overlay HTML UI
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
  defs: _defs = null,
  hostSurface = true,
  gridSize: _gridSize = DEFAULT_GRID_SIZE,
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
  const emptyDragPansRef = useRef(emptyDragPans);
  const shouldBlockEmptyPanRef = useRef(shouldBlockEmptyPan);
  const panBlockSelectorRef = useRef(panBlockSelector);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const fittedKey = useRef('');
  const [overlayEl, setOverlayEl] = useState<HTMLDivElement | null>(null);
  const [viewportEl, setViewportEl] = useState<HTMLElement | null>(null);
  const [devicePixelRatio, setDevicePixelRatio] = useState(() => readDevicePixelRatio());
  const devicePixelRatioRef = useRef(devicePixelRatio);

  const activeTool = useSelector((s: RootState) => s.editor.activeTool);
  const shapeKind = useSelector((s: RootState) => s.editor.shapeKind);
  // Kit InputManager tool id (shape flyout → shapeKind; arrow → line).
  const engineTool = resolveEngineTool(activeTool, shapeKind);
  // Kit owns create + select/direct + paint-bucket + mesh. Image place uses a thin stage
  // listener (not a Feature capturing over Kit).
  const engineInteractive = kitOwnsStagePointer(activeTool, shapeKind);

  cameraRef.current = camera;
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
    };
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

  // Stable ref callback — unstable ones remount and hit max update depth.
  const setStageNode = useCallback(
    (node: HTMLDivElement | null) => {
      if (stageRefProp) {
        (stageRefProp as { current: HTMLDivElement | null }).current = node;
      } else {
        localRef.current = node;
      }
      setViewportEl((prev) => (prev === node ? prev : node));
      onViewportElRef.current?.(node);
    },
    [stageRefProp]
  );

  useEffect(() => {
    const key = fitKey || 'default';
    if (emptyWorld) {
      if (fittedKey.current !== key) fittedKey.current = `${key}:empty`;
      return;
    }
    // Do not treat `:empty` as fitted — first real artboard must still autofit.
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
        if (tries++ < 30) requestAnimationFrame(applyFit);
        return;
      }
      fittedKey.current = key;
      onCameraChange(rcbFitCamera({ width: vw, height: vh }, artboard));
    };
    applyFit();
    return () => {
      cancelled = true;
    };
  }, [
    fitKey,
    emptyWorld,
    artboard.x,
    artboard.y,
    artboard.width,
    artboard.height,
    onCameraChange,
    stageRef,
    viewportEl,
    artboard,
  ]);

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
      // Kit InputManager owns create/select gestures — do not steal with empty-pan.
      const kitSurface = (e.target as Element | null)?.closest?.('[data-rcb-kit-surface="1"]');
      if (kitSurface?.getAttribute('data-rcb-kit-ready') === '1') {
        const pe = window.getComputedStyle(kitSurface).pointerEvents;
        if (pe !== 'none') return;
      }
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

  const stageW = viewportEl?.clientWidth || 0;
  const stageH = viewportEl?.clientHeight || 0;

  // Keep shared world viewport notification in sync (noop under Kit).
  useLayoutEffect(() => {
    void rcbCameraCssZoom(camera);
    void rcbCameraScreenOffset(camera, devicePixelRatio);
  }, [camera, devicePixelRatio, stageW, stageH]);

  /** HTML camera above Kit — DomHost wraps only (no stage-wide SVG). */
  const setHostSurfaceNode = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      setSceneWorldRoot(null, null, null);
      return;
    }
    const cameraEl = node.querySelector(
      ':scope > [data-rcb-scene-camera]'
    ) as HTMLElement | null;
    const mount = cameraEl
      ? (cameraEl.querySelector(':scope > [data-rcb-shapes-mount]') as HTMLElement | null)
      : null;
    const guidesMount = cameraEl
      ? (cameraEl.querySelector(
          ':scope > [data-rcb-smart-guides-mount]'
        ) as HTMLElement | null)
      : null;
    setSceneWorldRoot(node, mount, guidesMount);
  }, []);

  useEffect(() => {
    if (!hostSurface) {
      setSceneWorldRoot(null, null, null);
    }
  }, [hostSurface]);

  useEffect(() => {
    return () => setSceneWorldRoot(null, null, null);
  }, []);

  const sceneCameraCss = cameraCssTransform(
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
                className={cn(
                  // Own pan/zoom/draw — block browser scroll/pinch so it cannot
                  // fire pointercancel mid-gesture (common on tablet / DevTools device).
                  'relative h-full w-full touch-none overflow-hidden select-none',
                  !background && 'bg-[var(--canvas)]',
                  panning && 'cursor-grab active:cursor-grabbing',
                  // Stage cursor for create tools — skip Kit surface so
                  // InputManager resize/rotate/pen tips stay on the canvas.
                  !panning &&
                    cursor &&
                    '[&_*:not([data-rcb-kit-surface]):not([data-rcb-kit-surface]_*):not([data-sel-handle]):not([data-radius-handle]):not([data-star-handle]):not([data-poly-handle]):not([data-circle-handle])]:!cursor-inherit',
                  !panning && !cursor && !engineInteractive && 'cursor-default',
                  className
                )}
                style={{
                  ...(background ? { background } : null),
                  cursor: !panning && cursor ? cursor : engineInteractive ? 'auto' : '',
                }}
              >
                {/* Vector artboard / shapes paint here (CanvasKit #editor-canvas). */}
                <KitCanvasHost
                  className="absolute inset-0 z-[1]"
                  activeTool={engineTool}
                  interactive={engineInteractive}
                  camera={camera}
                  dpr={devicePixelRatio}
                />
                {/* HTML camera for DomHost only — Kit owns ink / selection / snap guides.
                    Never a stage-wide SVG (Kit has none). */}
                {hostSurface && stageW > 0 && stageH > 0 ? (
                  <div
                    ref={setHostSurfaceNode}
                    aria-hidden
                    data-rcb-scene-root="1"
                    data-rcb-infinite="1"
                    data-rcb-shared-scene-surface="1"
                    className="pointer-events-none absolute inset-0 z-[2] overflow-visible"
                    style={{
                      width: stageW,
                      height: stageH,
                      isolation: 'isolate',
                    }}
                  >
                    <div
                      data-rcb-scene-camera="1"
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        width: 0,
                        height: 0,
                        transform: sceneCameraCss,
                        transformOrigin: '0 0',
                        overflow: 'visible',
                      }}
                    >
                      <div
                        data-rcb-shapes-mount="1"
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          width: 0,
                          height: 0,
                          overflow: 'visible',
                        }}
                      />
                      <div
                        data-rcb-smart-guides-mount="1"
                        style={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          width: 0,
                          height: 0,
                          overflow: 'visible',
                          pointerEvents: 'none',
                        }}
                      />
                    </div>
                  </div>
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
