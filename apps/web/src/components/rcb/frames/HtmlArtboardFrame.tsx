/** Artboard: SVG plate + world-layer title / process chrome. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  memo,
} from 'react';
import { createPortal } from 'react-dom';
import { useRcbCamera, useRcbViewportEl } from '../camera/context';
import { rcbCameraCssZoom, rcbViewportSceneBounds } from '../core/math';
import { createSvgBoard } from '@/components/rcb/scene/paint/sceneToSvg';
import { append, setAttrs, setFill, setStroke, svgEl } from '@/components/rcb/scene/paint/svgDom';
import {
  getShapeHost,
  getSceneShapesMount,
  getSceneWorldRoot,
  getSceneSelectionChromeMount,
  getSceneWorldEpoch,
  registerShapeHost,
  subscribeShapeHosts,
  syncSharedMountPaintOrder,
  unregisterShapeHost,
  updateShapeHostElement,
} from '@/components/rcb/shapes/shapeHostRegistry';
import NodeTitleLabel from '../selection/chrome/NodeTitleLabel';
import { ProcessGlowShell } from '@/components/rcb/process/ProcessGlowShell';
import { processGlowForeignObjectBounds } from '@/components/rcb/process/processGlow';
import { appendProcessPlatePaths, syncProcessPlateGeometry } from '@/components/rcb/process/processPlateSvg';
import { roundedRectPath } from '@/components/rcb/scene/document/sceneRadii';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import {
  FRAME_HIGHLIGHT_STROKE,
  FRAME_PLATE_STROKE,
  applyArtboardPlateEdgeStroke,
  framePlateStrokeSceneWidth,
  isAnimationArtboardKind,
} from '@/components/rcb/frames/types';
import {
  getSceneCanvasIdlePaint,
  subscribeSceneCanvasIdlePaint,
} from '@/components/rcb/render/sceneRenderer';
import { getSoaPaintDocument } from '@/components/rcb/render/sceneRenderBuffer';
import {
  registerArtboardInkSurface,
  scheduleArtboardInkPaint,
  updateArtboardInkChrome,
} from '@/components/rcb/frames/artboardInkSurface';

/**
 * Clear plate stroke only when SelectionChrome owns the outline.
 * - Sole full-chrome plate: SelectionChrome paints **this** plate's box.
 * - Bound child selected: keep the idle gray hairline (plate silhouette); blue
 *   soft-focus is suppressed separately via {@link framePlateShowsHighlightEdge}.
 * Multi-frame full chrome uses a union outline — members must keep their edges.
 */
export function framePlateClearsIdleStroke(opts: {
  chromeMode: 'soft' | 'full';
  selectedFrameIds: readonly string[];
  frameId: string;
  /** True when a selected scene node is bound to this plate. */
  boundChildSelected?: boolean;
}): boolean {
  const { chromeMode, selectedFrameIds, frameId } = opts;
  return (
    chromeMode === 'full' &&
    selectedFrameIds.length === 1 &&
    selectedFrameIds[0] === frameId
  );
}

/** Soft / multi-member highlight edge when SelectionChrome is not owning the plate. */
export function framePlateShowsHighlightEdge(opts: {
  chromeMode: 'soft' | 'full';
  selectedFrameIds: readonly string[];
  frameId: string;
  activeFrameId?: string | null;
  moving?: boolean;
  /** Bound child SelectionChrome — suppress competing plate soft edge. */
  boundChildSelected?: boolean;
}): boolean {
  const {
    chromeMode,
    selectedFrameIds,
    frameId,
    activeFrameId = null,
    moving = false,
    boundChildSelected = false,
  } = opts;
  if (moving) return true;
  if (boundChildSelected) return false;
  if (chromeMode === 'soft') {
    return activeFrameId === frameId || selectedFrameIds.includes(frameId);
  }
  return (
    chromeMode === 'full' &&
    selectedFrameIds.length > 1 &&
    selectedFrameIds.includes(frameId)
  );
}

type HtmlArtboardFrameProps = {
  frame: ArtboardFrame;
  /** Full chrome selected — plate stroke off (SelectionChrome owns the box). */
  selected?: boolean;
  /** Soft context focus — blue edge only (interior click / working inside). */
  highlighted?: boolean;
  onSelect?: () => void;
  onRename?: (name: string) => void;
  /** Drag the label to move the artboard. */
  onMove?: (x: number, y: number, opts?: { skipGrid?: boolean }) => void;
  onMoveStart?: () => void;
  /** Label drag ended (clear guides, etc.). */
  onMoveEnd?: () => void;
  /** Hide title while the frame is being moved. */
  hideTitle?: boolean;
  /** body under shapes; process above shapes (cover until run ends); label clickable */
  layer?: 'body' | 'process' | 'label';
  /** Unified stack z-index (interleaves with shapes). */
  zIndex?: number;
  /** PR9 ephemeral overlay — not read from SceneDocument. */
  aiGenerating?: boolean;
  aiProcessLabel?: string;
};

export type ArtboardFrameGeometry = Pick<ArtboardFrame, 'id' | 'x' | 'y' | 'width' | 'height'>;

/**
 * Gesture-time plate geometry (ADR 0027). Selection chrome updates every move;
 * React still holds the pre-gesture editor store frame — without this map, a layout
 * effect would rebuild the plate from stale width/height and desync the white
 * plate from the blue selection box (and leave clipContent one frame behind).
 */
const liveArtboardGeomById = new Map<string, ArtboardFrameGeometry>();
const liveArtboardListeners = new Set<() => void>();

function notifyLiveArtboardFrameGeometry() {
  for (const fn of liveArtboardListeners) fn();
}

export function getLiveArtboardFrameGeometry(id: string): ArtboardFrameGeometry | null {
  const key = String(id || '').trim();
  if (!key) return null;
  return liveArtboardGeomById.get(key) ?? null;
}

/** Drop live overrides after commit / cancelled transform. */
export function clearLiveArtboardFrameGeometry(ids?: readonly string[]): void {
  if (!ids || !ids.length) {
    liveArtboardGeomById.clear();
  } else {
    for (const id of ids) liveArtboardGeomById.delete(String(id || '').trim());
  }
  notifyLiveArtboardFrameGeometry();
}

/** True while any artboard plate is at gesture-time geometry. */
export function hasLiveArtboardFrameGeometry(): boolean {
  return liveArtboardGeomById.size > 0;
}

/** Frame ids with live plate geometry (plate drag repaint scope). */
export function getLiveArtboardFrameIds(): readonly string[] {
  return [...liveArtboardGeomById.keys()];
}

/** SoA / host ink must re-read `nodeLeftTop` when the live plate moves. */
export function subscribeLiveArtboardFrameGeometry(listener: () => void): () => void {
  liveArtboardListeners.add(listener);
  return () => {
    liveArtboardListeners.delete(listener);
  };
}

function resolvePaintFrameGeometry(frame: ArtboardFrameGeometry): ArtboardFrameGeometry {
  const live = getLiveArtboardFrameGeometry(frame.id);
  if (!live) return frame;
  return {
    id: frame.id,
    x: live.x,
    y: live.y,
    width: live.width,
    height: live.height,
  };
}

/**
 * Drag-time frame paint follows the same immediate SVG path as scene nodes.
 * React receives the final document position on pointer-up; repainting through
 * editor store during the drag puts frame paint one animation frame behind its nodes.
 */
export function previewArtboardFrameGeometry(
  frame: ArtboardFrameGeometry,
  opts?: { recordLive?: boolean }
): boolean {
  const id = String(frame.id || '').trim();
  if (!id) return false;
  const x = Number(frame.x) || 0;
  const y = Number(frame.y) || 0;
  const width = Math.max(1, Number(frame.width) || 1);
  const height = Math.max(1, Number(frame.height) || 1);
  if (opts?.recordLive !== false) {
    const prev = liveArtboardGeomById.get(id);
    const same =
      prev &&
      prev.x === x &&
      prev.y === y &&
      prev.width === width &&
      prev.height === height;
    liveArtboardGeomById.set(id, { id, x, y, width, height });
    // Skip notify when the plate did not move — pointermove can repeat snaps.
    if (!same) notifyLiveArtboardFrameGeometry();
  }
  const el = getShapeHost(id)?.el as SVGGElement | null | undefined;
  if (!el) return false;
  setAttrs(el, { transform: `translate(${x} ${y})` });
  const host = el as typeof el & {
    __sceneLeft?: number;
    __sceneTop?: number;
    sceneWidth?: number;
    sceneHeight?: number;
  };
  host.__sceneLeft = x;
  host.__sceneTop = y;
  host.sceneWidth = width;
  host.sceneHeight = height;
  if (el.getAttribute('data-rcb-process-plate') === '1') {
    syncProcessPlateGeometry(
      el,
      roundedRectPath(width, height, { tl: 0, tr: 0, br: 0, bl: 0 })
    );
    return true;
  }
  const plate = el.querySelector<SVGRectElement>(
    'rect[data-rcb-artboard-edge="1"], rect[data-baseline="1"]'
  );
  if (plate) {
    const stroke = String(plate.getAttribute('stroke') || 'none');
    const sw =
      stroke !== 'none' ? Math.max(0, Number(plate.getAttribute('stroke-width')) || 0) : 0;
    if (sw > 0) {
      setAttrs(plate, {
        x: sw / 2,
        y: sw / 2,
        width: Math.max(0, width - sw),
        height: Math.max(0, height - sw),
      });
    } else {
      setAttrs(plate, { x: 0, y: 0, width, height });
    }
  }
  const fill = el.querySelector<SVGRectElement>('rect[data-rcb-artboard-fill="1"]');
  if (fill) setAttrs(fill, { width, height });
  const fo = el.querySelector<SVGForeignObjectElement>('foreignObject[data-rcb-artboard-ink="1"]');
  if (fo) setAttrs(fo, { width, height });
  const inkCanvas = el.querySelector<HTMLCanvasElement>('canvas[data-rcb-artboard-ink-canvas]');
  if (inkCanvas) {
    inkCanvas.style.width = `${width}px`;
    inkCanvas.style.height = `${height}px`;
  }
  scheduleArtboardInkPaint(id);
  return true;
}

function paintFramePlate(
  layer: SVGGElement,
  frame: ArtboardFrame,
  selected: boolean,
  highlighted: boolean,
  generating: boolean,
  zoom: number,
  getViewScene?: () => { left: number; top: number; width: number; height: number } | null
): SVGGElement {
  const prevPlate = layer.querySelector<SVGGElement>(':scope > g[data-rcb-frame-plate="1"]');
  const prevHost = prevPlate as PlateInkHost | null;
  prevHost?.__artboardInkUnregister?.();
  while (layer.firstChild) layer.removeChild(layer.firstChild);

  const x = Number(frame.x) || 0;
  const y = Number(frame.y) || 0;
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);

  const g = svgEl('g') as SVGGElement & PlateInkHost;
  append(layer, g);
  setAttrs(g, {
    transform: `translate(${x} ${y})`,
    'data-frame-id': frame.id,
    'data-scene-node-id': frame.id,
    'data-rcb-frame-plate': '1',
  });
  if (generating) setAttrs(g, { 'data-rcb-process-plate': '1' });
  g.__sceneLeft = x;
  g.__sceneTop = y;
  g.sceneWidth = w;
  g.sceneHeight = h;

  const root = layer.ownerSVGElement;
  if (generating && root) {
    const stroke = selected
      ? undefined
      : {
          color: highlighted ? FRAME_HIGHLIGHT_STROKE : FRAME_PLATE_STROKE,
          width: framePlateStrokeSceneWidth(zoom),
        };
    const clipD = roundedRectPath(w, h, { tl: 0, tr: 0, br: 0, bl: 0 });
    appendProcessPlatePaths(g, root, frame.id, clipD, w, h, stroke);
    return g;
  }

  mountArtboardInk(g, frame, w, h, selected, highlighted, zoom, getViewScene);
  return g;
}

type PlateInkHost = {
  __sceneLeft?: number;
  __sceneTop?: number;
  sceneWidth?: number;
  sceneHeight?: number;
  __artboardInkCanvas?: HTMLCanvasElement;
  __artboardInkUnregister?: () => void;
};

function inkPaintFrameFrom(frame: ArtboardFrame) {
  const geom = resolvePaintFrameGeometry(frame);
  return {
    id: frame.id,
    x: Number(geom.x) || 0,
    y: Number(geom.y) || 0,
    width: Math.max(1, Number(geom.width) || 1),
    height: Math.max(1, Number(geom.height) || 1),
    backgroundColor: frame.backgroundColor,
    backgroundOpacity: frame.backgroundOpacity,
  };
}

function mountArtboardInk(
  g: SVGGElement & PlateInkHost,
  frame: ArtboardFrame,
  w: number,
  h: number,
  selected: boolean,
  highlighted: boolean,
  zoom: number,
  getViewScene?: () => { left: number; top: number; width: number; height: number } | null
): void {
  // SVG fill owns the plate silhouette so selection chrome AABB matches pixels
  // (Canvas FO fill under CSS scale could bleed past the blue box by ~1px).
  const { css, alpha } = (() => {
    const raw = frame.backgroundColor;
    const fill = raw && raw !== 'transparent' ? String(raw) : '#FFFFFF';
    const a = Math.max(0, Math.min(100, Number(frame.backgroundOpacity ?? 100))) / 100;
    return { css: fill, alpha: a };
  })();
  const fillRect = svgEl('rect', {
    x: 0,
    y: 0,
    width: w,
    height: h,
    'data-rcb-artboard-fill': '1',
  });
  append(g, fillRect);
  setFill(fillRect, css);
  setStroke(fillRect, 'none');
  if (alpha < 1) setAttrs(fillRect, { opacity: String(alpha) });
  setAttrs(fillRect, { 'pointer-events': 'none' });

  const fo = svgEl('foreignObject', {
    x: 0,
    y: 0,
    width: w,
    height: h,
    'data-rcb-artboard-ink': '1',
  }) as SVGForeignObjectElement;
  // FO default can be visible — keep plate-bound idle pixels inside the board.
  fo.style.overflow = 'hidden';
  append(g, fo);

  const canvas = document.createElement('canvas');
  canvas.setAttribute('data-rcb-artboard-ink-canvas', frame.id);
  canvas.style.display = 'block';
  canvas.style.position = 'absolute';
  canvas.style.left = '0';
  canvas.style.top = '0';
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  // Do not force pixelated — AA strokes + nearest-neighbor looked soft inside plates.
  fo.style.position = 'relative';
  fo.appendChild(canvas);

  g.__artboardInkCanvas = canvas;
  g.__artboardInkUnregister = registerArtboardInkSurface({
    canvas,
    frameId: frame.id,
    selected,
    highlighted,
    zoom,
    getFrame: () => inkPaintFrameFrom(frame),
    getDocument: () => getSceneCanvasIdlePaint()?.document ?? getSoaPaintDocument() ?? null,
    getViewScene,
  });

  const plate = svgEl('rect', {
    x: 0,
    y: 0,
    width: w,
    height: h,
    'data-baseline': '1',
    'data-radius-body': '1',
    'data-rcb-artboard-edge': '1',
  });
  append(g, plate);
  setFill(plate, 'none');
  setAttrs(plate, { 'pointer-events': 'none' });
  // SVG edge (not canvas): ink FO backing is resolution-capped — canvas
  // hairlines drop below 1px and vanish when zoomed in.
  applyArtboardPlateEdgeStroke(plate, {
    selected,
    highlighted,
    zoom,
    width: w,
    height: h,
  });
}


function HtmlArtboardFrame({
  frame,
  selected = false,
  highlighted = false,
  onSelect,
  onRename,
  onMove,
  onMoveStart,
  onMoveEnd,
  hideTitle = false,
  layer = 'body',
  zIndex = 0,
  aiGenerating = false,
  aiProcessLabel,
}: HtmlArtboardFrameProps): ReactNode {
  const camera = useRcbCamera();
  const viewportEl = useRcbViewportEl();
  const z = rcbCameraCssZoom(camera);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const viewportElRef = useRef(viewportEl);
  viewportElRef.current = viewportEl;

  function readInkViewScene() {
    const el = viewportElRef.current;
    const cam = cameraRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const sw = Math.max(1, rect.width);
    const sh = Math.max(1, rect.height);
    const b = rcbViewportSceneBounds(cam, { width: sw, height: sh });
    return { left: b.x, top: b.y, width: b.width, height: b.height };
  }
  const generating = Boolean(aiGenerating);
  const processLabel = String(aiProcessLabel || 'Preparing…');
  // Remount into shared world SVG when it appears (same as RcbShapeHost).
  // Private fallback SVGs stack via HTML z-index and cover shared shape paint.
  const [worldEpoch, setWorldEpoch] = useState(() => getSceneWorldEpoch());
  useEffect(
    () =>
      subscribeShapeHosts(() => {
        setWorldEpoch((prev) => {
          const next = getSceneWorldEpoch();
          return prev === next ? prev : next;
        });
      }),
    []
  );

  useLayoutEffect(() => {
    if (layer !== 'body') return undefined;
    const host = hostRef.current;
    if (!host) return undefined;

    // Plates + node hosts share the shapes mount; data-z = stackOrder so a
    // newer 画板 covers boolean / media hosts without type-specific clips.
    const sharedRoot = getSceneWorldRoot();
    const sharedMount = getSceneShapesMount();
    if (!sharedRoot || !sharedMount) return undefined;
    const { root, layer: sceneLayer, shared } = createSvgBoard(host, 1, 1, {
      infinite: true,
      sharedRoot,
      sharedMount,
    });
    layerRef.current = sceneLayer;
    // createSvgBoard tags shared layers as shape; frames must not share that attr
    // or shape-only reorder / hit paths treat the plate as a node layer.
    sceneLayer.removeAttribute('data-rcb-shape-layer');
    sceneLayer.setAttribute('data-rcb-frame-layer', frame.id);
    sceneLayer.setAttribute('data-z', String(zIndex));
    const paintFrame = { ...frame, ...resolvePaintFrameGeometry(frame) };
    const el = paintFramePlate(
      sceneLayer,
      paintFrame,
      selected,
      highlighted,
      generating,
      z,
      readInkViewScene
    );
    registerShapeHost({ nodeId: frame.id, root, layer: sceneLayer, el, kind: 'svg' });
    updateShapeHostElement(frame.id, el);

    if (shared && sharedMount && sceneLayer.parentNode === sharedMount) {
      syncSharedMountPaintOrder(sharedMount);
    }

    return () => {
      const plate = sceneLayer.querySelector<SVGGElement>(':scope > g[data-rcb-frame-plate="1"]');
      (plate as PlateInkHost | null)?.__artboardInkUnregister?.();
      unregisterShapeHost(frame.id);
      try {
        sceneLayer.remove();
      } catch {
        /* ignore */
      }
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, frame.id, worldEpoch]);

  // Idle SoA / document paint → restamp every artboard small-canvas.
  useEffect(() => {
    if (layer !== 'body') return undefined;
    return subscribeSceneCanvasIdlePaint(() => {
      scheduleArtboardInkPaint(frame.id);
    });
  }, [layer, frame.id]);

  // Live plate geometry → restamp ink (bounds already updated in previewArtboardFrameGeometry).
  useEffect(() => {
    if (layer !== 'body') return undefined;
    return subscribeLiveArtboardFrameGeometry(() => {
      scheduleArtboardInkPaint(frame.id);
    });
  }, [layer, frame.id]);

  // Selection / zoom hairline: repaint plate in place (do not remount the layer g).
  useLayoutEffect(() => {
    if (layer !== 'body') return;
    const sceneLayer = layerRef.current;
    if (!sceneLayer) return;
    // During frame drag, previewArtboardFrameGeometry owns translate/size.
    // A full paintFramePlate rebuild here races children TransformPreview and
    // makes bound content look like it is sliding inside the plate.
    const live = getLiveArtboardFrameGeometry(frame.id);
    if (live) {
      updateArtboardInkChrome(frame.id, {
        selected,
        highlighted,
        zoom: z,
        getViewScene: readInkViewScene,
      });
      return;
    }
    const paintFrame = { ...frame, ...resolvePaintFrameGeometry(frame) };
    const el = paintFramePlate(
      sceneLayer,
      paintFrame,
      selected,
      highlighted,
      generating,
      z,
      readInkViewScene
    );
    // Avoid bumpHostEpoch on every parent render when only the frame object
    // identity changed (SelectionFeature hostEpoch would thrash).
    const prev = getShapeHost(frame.id)?.el;
    if (prev !== el) updateShapeHostElement(frame.id, el);
  }, [
    layer,
    selected,
    highlighted,
    generating,
    z,
    frame.id,
    frame.x,
    frame.y,
    frame.width,
    frame.height,
    frame.backgroundColor,
    frame.backgroundOpacity,
    frame.clipContent,
  ]);

  // Same as RcbShapeHost: update data-z + reorder without remounting the plate.
  useLayoutEffect(() => {
    if (layer !== 'body') return;
    const sceneLayer = layerRef.current;
    const sharedMount = getSceneShapesMount();
    if (!sceneLayer || !sharedMount || sceneLayer.parentNode !== sharedMount) return;
    sceneLayer.setAttribute('data-z', String(zIndex));
    syncSharedMountPaintOrder(sharedMount);
  }, [layer, zIndex]);
  if (layer === 'label') {
    const live = resolvePaintFrameGeometry(frame);
    return (
      <>
        <NodeTitleLabel
          box={{
            left: live.x,
            top: live.y,
            width: live.width,
            height: live.height,
          }}
          name={frame.name || 'Frame'}
          sizeWidth={live.width}
          sizeHeight={live.height}
          dataAttr="frame-label"
          icon={isAnimationArtboardKind(frame.kind) ? 'lottie' : 'frame'}
          dataProps={{ 'data-frame-id': frame.id }}
          hidden={hideTitle}
          onSelect={onSelect}
          onRename={onRename}
          onMove={onMove}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          originX={live.x}
          originY={live.y}
          renameAriaLabel="Frame name"
          nodeId={frame.id}
          zIndex={zIndex}
        />
      </>
    );
  }

  // Above SvgCanvas so paint/review/retry stays covered until the AI overlay clears.
  if (layer === 'process') {
    if (!generating) return null;
    const mount = getSceneSelectionChromeMount();
    if (!mount) return null;
    const foBox = processGlowForeignObjectBounds(frame.width, frame.height);
    return createPortal(
      <g data-artboard-process-layer={frame.id} pointerEvents="none">
        <foreignObject
          x={frame.x + foBox.x}
          y={frame.y + foBox.y}
          width={foBox.width}
          height={foBox.height}
          pointerEvents="none"
          style={{ overflow: 'hidden' }}
        >
          <ProcessGlowShell
            seed={frame.id}
            label={processLabel}
            width={frame.width}
            zoom={z}
            labelDataAttr="data-artboard-process-label"
          />
        </foreignObject>
      </g>,
      mount
    );
  }

  return (
    <>
      <div
        className="pointer-events-none absolute left-0 top-0 overflow-visible"
        // Plate paints on the shared stack SVG via data-z. Do not mirror
        // stack z on this HTML anchor — a private-SVG fallback with high CSS z
        // covers shapes while still letting clicks through (SVG is none).
        style={{ zIndex: 0 }}
        data-rcb-frame={frame.id}
        data-frame-id={frame.id}
      >
        <div
          ref={hostRef}
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          data-rcb-shape-host={frame.id}
          style={{ width: 0, height: 0, overflow: 'visible' }}
        />
      </div>
    </>
  );
}

export default memo(HtmlArtboardFrame);
