/** Artboard: Kit paints fill / idle / soft / selected stroke; SoftGlow when generating. */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  memo,
} from 'react';
import { useRcbCamera } from '../camera/context';
import { rcbCameraCssZoom } from '../core/math';
import { createDomHostBoard } from '@/components/rcb/scene/dom/domHostShell';
import { append, setAttrs, svgEl } from '@/components/rcb/scene/dom/svgDom';
import {
  getShapeHost,
  getSceneShapesMount,
  getSceneWorldRoot,
  getSceneWorldEpoch,
  registerShapeHost,
  subscribeShapeHosts,
  syncSharedMountPaintOrder,
  unregisterShapeHost,
  updateShapeHostElement,
} from '@/components/rcb/shapes/shapeHostRegistry';
import NodeTitleLabel from '../selection/chrome/NodeTitleLabel';
import { ProcessGlowShell } from '@/components/rcb/process/ProcessGlowShell';
import {
  appendProcessPlatePaths,
  syncProcessPlateGeometry,
} from '@/components/rcb/process/processPlateSvg';
import { roundedRectPath } from '@/components/rcb/scene/document/sceneRadii';
import {
  FRAME_HIGHLIGHT_STROKE,
  FRAME_PLATE_STROKE,
  applyArtboardPlateEdgeStroke,
  framePlateStrokeSceneWidth,
  type ArtboardFrame,
} from '@/components/rcb/frames/types';
import { isKitBridgeAttached } from '@/components/rcb/canvas/kitBridge';

/**
 * Clear plate stroke only when selection chrome owns the outline.
 * - Sole full-chrome plate: selection paints **this** plate's box.
 * - Bound child selected: keep the idle gray hairline (plate silhouette); soft
 *   blue edge still shows via {@link framePlateShowsHighlightEdge} (generator-like).
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

/** Soft / multi-member highlight edge when selection chrome is not owning the plate. */
export function framePlateShowsHighlightEdge(opts: {
  chromeMode: 'soft' | 'full';
  selectedFrameIds: readonly string[];
  frameId: string;
  activeFrameId?: string | null;
  moving?: boolean;
  /**
   * Bound child selected — still allow soft edge when this plate is the soft
   * context (`activeFrameId` / selectedFrameIds), like an occupied generator.
   */
  boundChildSelected?: boolean;
}): boolean {
  const {
    chromeMode,
    selectedFrameIds,
    frameId,
    activeFrameId = null,
    moving = false,
  } = opts;
  if (moving) return true;
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
  /** Full chrome selected — plate stroke off (selection owns the box). */
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

/** Kit / host must re-read `nodeLeftTop` when the live plate moves. */
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
  // Kit paints artboard fill / selected ring.
  // Idle hairline: SVG edge tracks resize via previewArtboardFrameGeometry.
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
  return true;
}

function paintFramePlate(
  layer: SVGGElement,
  frame: ArtboardFrame,
  selected: boolean,
  highlighted: boolean,
  generating: boolean,
  zoom: number
): SVGGElement {
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

  // Kit paints SoftGlow + plate chrome when generating (drawProcessingPlates).
  if (generating && isKitBridgeAttached()) {
    return g;
  }

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

  // Kit paints artboard fill / idle gray / selected+soft blue (dadaki drawArtboards).
  // When Kit is attached, never paint an SVG soft edge — it drifts from Kit's
  // plate stroke (same geometry must be recolored in drawArtboards instead).
  const edge = svgEl('rect') as SVGRectElement;
  setAttrs(edge, {
    fill: 'none',
    'data-rcb-artboard-edge': '1',
    'pointer-events': 'none',
  });
  const kitOwnsIdleEdge = isKitBridgeAttached();
  applyArtboardPlateEdgeStroke(edge, {
    // Kit owns all plate strokes — suppress SVG edge entirely.
    selected: selected || kitOwnsIdleEdge,
    highlighted: kitOwnsIdleEdge ? false : highlighted && !selected,
    zoom,
    width: w,
    height: h,
  });
  append(g, edge);
  return g;
}

type PlateInkHost = {
  __sceneLeft?: number;
  __sceneTop?: number;
  sceneWidth?: number;
  sceneHeight?: number;
};

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
  const z = rcbCameraCssZoom(camera);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);

  const generating = Boolean(aiGenerating);
  const processLabel = String(aiProcessLabel || 'Preparing…');
  // Remount into shared world SVG when it appears (same as media hosts).
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
    const { root, layer: sceneLayer, hostLayer, shared } = createDomHostBoard(host, 1, 1, {
      infinite: true,
      sharedRoot,
      sharedMount,
    });
    layerRef.current = sceneLayer;
    // data-z / frame-layer on the HTML wrap (sharedMount child), not the private SVG g.
    const orderEl = shared ? hostLayer : sceneLayer;
    orderEl.removeAttribute('data-rcb-shape-layer');
    orderEl.setAttribute('data-rcb-frame-layer', frame.id);
    orderEl.setAttribute('data-z', String(zIndex));
    const paintFrame = { ...frame, ...resolvePaintFrameGeometry(frame) };
    const el = paintFramePlate(
      sceneLayer,
      paintFrame,
      selected,
      highlighted,
      generating,
      z
    );
    registerShapeHost({ nodeId: frame.id, root, layer: sceneLayer, el, kind: 'svg' });
    updateShapeHostElement(frame.id, el);

    if (shared && sharedMount) {
      syncSharedMountPaintOrder(sharedMount);
    }

    return () => {
      unregisterShapeHost(frame.id);
      try {
        if (shared) hostLayer.remove();
        else sceneLayer.remove();
      } catch {
        /* ignore */
      }
      layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, frame.id, worldEpoch]);

  // Selection / zoom hairline: repaint plate in place (do not remount the layer g).
  useLayoutEffect(() => {
    if (layer !== 'body') return;
    const sceneLayer = layerRef.current;
    if (!sceneLayer) return;
    // Live drag still needs edge W/H + stroke-width — previewArtboardFrameGeometry
    // only patches an existing edge rect; paintFramePlate rebuilds it from live geom.
    const paintFrame = { ...frame, ...resolvePaintFrameGeometry(frame) };
    const el = paintFramePlate(
      sceneLayer,
      paintFrame,
      selected,
      highlighted,
      generating,
      z
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
    if (!sceneLayer || !sharedMount) return;
    const wrap = sceneLayer.ownerSVGElement?.parentElement ?? null;
    const orderEl =
      wrap instanceof HTMLElement && wrap.hasAttribute('data-rcb-dom-host-layer')
        ? wrap
        : sceneLayer;
    if (orderEl.parentNode !== sharedMount) return;
    orderEl.setAttribute('data-z', String(zIndex));
    syncSharedMountPaintOrder(sharedMount);
  }, [layer, zIndex]);
  if (layer === 'label') {
    // Kit drawArtboards owns artboard / 动画工作台 titles — no HTML fork.
    if (hideTitle) return null;
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
          icon="frame"
          dataProps={{ 'data-frame-id': frame.id }}
          hidden={false}
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
    return (
      <ProcessGlowShell
        seed={frame.id}
        label={processLabel}
        box={{
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
        }}
        labelDataAttr="data-artboard-process-label"
      />
    );
  }

  return (
    <div
      ref={hostRef}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      data-frame-id={frame.id}
      data-rcb-shape-host={frame.id}
      style={{ width: 0, height: 0, overflow: 'visible', zIndex: 0 }}
    />
  );
}

export default memo(HtmlArtboardFrame);
