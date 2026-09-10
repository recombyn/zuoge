import { useEffect, useRef, useState, memo } from 'react';
import { NodeProcessGlow } from '@/components/editor/nodes/ImageNode/ImageProcessOverlay';
import { useRcbCamera } from '@/components/rcb/camera/context';
import { rcbCameraCssZoom } from '@/components/rcb/core/math';
import {
  syncFrameContentClip,
} from '@/components/rcb/frames/frameContentClip';
import { syncStackPaintOrder } from '@/components/rcb/scene/document/sceneStackPainter';
import {
  createDomHostBoard,
  mountDomHostAnchor,
  nodeNeedsHtmlMediaMount,
  syncHtmlMediaMountGeometry,
} from '@/components/rcb/scene/dom/domHostShell';
import { isEmptyGeneratorPlate } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  blendModeToCss,
  parseBlendMode,
  parseLayerOpacity,
} from '@/components/rcb/selection/chrome/BlendModeControl';
import {
  getSceneShapesMount,
  getSceneWorldEpoch,
  getSceneWorldRoot,
  getShapeHost,
  getSharedNodeEls,
  registerShapeHost,
  setShapeHostRevealOverflow,
  subscribeShapeHost,
  subscribeShapeHosts,
  unregisterShapeHost,
  updateShapeHostElement,
} from '@/components/rcb/shapes/shapeHostRegistry';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';

type Props = {
  nodeId: string;
  document: SceneDocument;
  /** Paint order among siblings (ROOT.children index). */
  zIndex: number;
  /** Bumps force a full remount / redraw of this host. */
  reloadToken?: number | string;
  /** Changes when frame geometry or clipping settings change. */
  frameClipToken?: string;
  /** Keep SVG paint invisible (inline text editor owns the glyphs). */
  forceHidden?: boolean;
  /** Selected nodes show their full paint while crossing an artboard edge. */
  revealOverflow?: boolean;
};

/** Geometry / angle commits may replace the node record — keep host mounted. */
function hostNodePaintIdentityEqual(prev: unknown, next: unknown): boolean {
  if (prev === next) return true;
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return false;
  const a = prev as { key?: string; attrs?: Record<string, unknown> | null };
  const b = next as { key?: string; attrs?: Record<string, unknown> | null };
  if (String(a.key || '') !== String(b.key || '')) return false;
  if (a.attrs === b.attrs) return true;
  const pa = a.attrs || {};
  const pb = b.attrs || {};
  const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
  for (const k of keys) {
    if (k === 'angle' || k === 'flipX' || k === 'flipY') continue;
    if (pa[k] !== pb[k]) return false;
  }
  return true;
}

/**
 * A geometry commit creates a new document shell, while every untouched node
 * keeps its object identity. Comparing the whole document here made every
 * mounted brush host render on each drag commit, which is costly enough for
 * dense pencil strokes to visibly shake. A host only needs its own node.
 */
export function shapeHostPropsEqual(previous: Props, next: Props): boolean {
  if (previous.nodeId !== next.nodeId) return false;
  if (previous.zIndex !== next.zIndex) return false;
  if (previous.reloadToken !== next.reloadToken) return false;
  if (previous.frameClipToken !== next.frameClipToken) return false;
  if (previous.forceHidden !== next.forceHidden) return false;
  if (previous.revealOverflow !== next.revealOverflow) return false;
  const prevNode = previous.document?.deltaSetLike?.[previous.nodeId];
  const nextNode = next.document?.deltaSetLike?.[next.nodeId];
  return hostNodePaintIdentityEqual(prevNode, nextNode);
}

function setHostPaintOpacity(el: Element | null | undefined, hidden: boolean) {
  if (!el) return;
  const v = hidden ? '0' : '1';
  if (el instanceof HTMLElement || el instanceof SVGElement) {
    el.style.opacity = v;
  }
  el.setAttribute('opacity', v);
  const anyEl = el as any;
  if (typeof anyEl.opacity === 'function') anyEl.opacity(hidden ? 0 : 1);
}

function resolveHostPaintEl(
  nodeId: string,
  layer?: Element | null
): Element | null {
  return (
    getSharedNodeEls()?.get(nodeId) ||
    (layer?.querySelector?.(
      `[data-scene-node-id="${CSS.escape(nodeId)}"]`
    ) as Element | null) ||
    null
  );
}

/** Blend on the paint node only — never on the stack layer (under-plate bug). */
function applyHostBlend(el: Element | null | undefined, blendCss: string) {
  if (!el || !(el instanceof HTMLElement || el instanceof SVGElement)) return;
  if (blendCss) el.style.mixBlendMode = blendCss;
  else el.style.removeProperty('mix-blend-mode');
}

/**
 * One paint host per scene node under the camera world layer.
 * Paints only in the shared scene SVG. A missing mount means this render waits
 * for the registry epoch instead of creating a second camera/viewBox pipeline.
 */
function RcbShapeHost({
  nodeId,
  document,
  zIndex,
  reloadToken = 0,
  frameClipToken = '',
  forceHidden = false,
  revealOverflow = false,
}: Props) {
  const camera = useRcbCamera();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layerRef = useRef<SVGGElement | null>(null);
  const bootRef = useRef(0);
  const forceHiddenRef = useRef(forceHidden);
  forceHiddenRef.current = forceHidden;
  const revealOverflowRef = useRef(revealOverflow);
  revealOverflowRef.current = revealOverflow;
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
  const node = document?.deltaSetLike?.[nodeId];
  const clipGeometryToken = [node?.x, node?.y, node?.width, node?.height].join('|');
  const blendMode = parseBlendMode(node?.attrs?.blendMode, { allowPassThrough: false });
  const layerOpacity = parseLayerOpacity(node?.attrs?.opacity, 1);
  // SoftGlow / process may clear clipContent; plain selection keeps plate clip.
  const activeBlendCss = revealOverflow ? '' : blendModeToCss(blendMode);
  // revealOverflow clears clipContent only for SoftGlow / editors — not selection.
  const paintZIndex = zIndex;
  // Remount when stroke/fill paint attrs change — not on every geometry nudge.
  const paintToken = [
    node?.attrs?.hidden,
    node?.attrs?.locked,
    node?.attrs?.strokeAlign,
    node?.attrs?.['border-width'],
    node?.attrs?.['border-color'],
    node?.attrs?.['stroke-opacity'],
    node?.attrs?.strokeStyle,
    node?.attrs?.strokeLinecap,
    node?.attrs?.strokeLinejoin,
    node?.attrs?.['stroke-enabled'],
    node?.attrs?.['stroke-visible'],
    node?.attrs?.['fill-color'],
    node?.attrs?.['fill-type'],
    node?.attrs?.['fill-opacity'],
    node?.attrs?.['fill-enabled'],
    node?.attrs?.['fill-visible'],
    node?.attrs?.['fill-gradient'],
    node?.attrs?.['fill-image-src'],
    node?.attrs?.['fill-image-fit'],
    node?.attrs?.['fill-image-rotate'],
    node?.attrs?.['fill-image-scale'],
    node?.attrs?.['fill-image-offset-x'],
    node?.attrs?.['fill-image-offset-y'],
    node?.attrs?.['fill-image-adjust'],
    node?.attrs?.opacity,
    node?.attrs?.blendMode,
    // Track markdown *and* DATA/ORIGIN_DATA — style-only edits (fontSize) keep
    // markdown identical, so `markdown —  DATA` would skip remounts.
    node?.attrs?.markdown,
    node?.attrs?.DATA,
    node?.attrs?.ORIGIN_DATA,
    node?.attrs?.fontSize,
    node?.attrs?.fontFamily,
    node?.attrs?.autoSize,
    node?.attrs?.textFrame,
    node?.attrs?.path,
    node?.attrs?.shapeType,
    // Angle / flip are transform-only — DomHost preview noop / Kit TransformPreview
    // without remounting (full rebuild corrupts boolean / outlined compound paths).
    node?.attrs?.brushStyle,
    node?.attrs?.pathPressure,
    // All effects share the SVG paint path. Include their complete input so a
    // path/line/pen gets the same immediate repaint as an image or rect.
    node?.attrs?.['shadow-enabled'],
    node?.attrs?.['shadow-visible'],
    node?.attrs?.['shadow-color'],
    node?.attrs?.['shadow-x'],
    node?.attrs?.['shadow-y'],
    node?.attrs?.['shadow-blur'],
    node?.attrs?.['inner-shadow-enabled'],
    node?.attrs?.['inner-shadow-visible'],
    node?.attrs?.['inner-shadow-color'],
    node?.attrs?.['inner-shadow-x'],
    node?.attrs?.['inner-shadow-y'],
    node?.attrs?.['inner-shadow-blur'],
    node?.attrs?.['backdrop-blur-enabled'],
    node?.attrs?.['backdrop-blur-amount'],
    node?.attrs?.['backdrop-blur-brightness'],
    node?.attrs?.['blur-enabled'],
    node?.attrs?.['blur-amount'],
    // Empty generator / process hairlines are screen-constant (css/zoom) — remount on zoom.
    String(node?.attrs?.processStatus || '') === 'running' ||
    node?.attrs?.imageGenerator ||
    node?.attrs?.videoGenerator ||
    node?.attrs?.lottieGenerator ||
    node?.attrs?.audioGenerator
      ? rcbCameraCssZoom(camera).toFixed(3)
      : '',
    // Process SoftGlow lives on this host — remount when status/label flips so
    // finishImageProcess drops the glow with the plate (no orphan overlay).
    String(node?.attrs?.processStatus || ''),
    String(node?.attrs?.processLabel || ''),
  ].join('|');

  const processing = String(node?.attrs?.processStatus || '') === 'running';
  const [paintEl, setPaintEl] = useState<Element | null>(null);
  const paintElRef = useRef<Element | null>(null);
  paintElRef.current = paintEl;
  const hostLayerRef = useRef<HTMLElement | null>(null);

  const resolvePaintEl = (): Element | null => {
    const fromHost = getShapeHost(nodeId)?.el;
    if (fromHost) return fromHost;
    return resolveHostPaintEl(nodeId, layerRef.current ?? hostLayerRef.current);
  };

  const syncOwnedFrameClip = () => {
    const el = resolvePaintEl();
    if (!(el instanceof SVGElement)) return;
    const root = getSceneWorldRoot();
    setShapeHostRevealOverflow(nodeId, revealOverflow);
    syncFrameContentClip(root, el, document, node as Record<string, unknown> | null, {
      zoom: camera.zoom,
      revealOverflow,
    });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !document) return undefined;

    const seq = ++bootRef.current;
    const n = document.deltaSetLike?.[nodeId];
    let cancelled = false;
    const sharedRoot = getSceneWorldRoot();
    const sharedMount = getSceneShapesMount();
    if (!sharedRoot || !sharedMount) return undefined;

    // Empty generators: Kit owns wash + Lucide + 1px hairline (no DomHost icon).
    if (n && isEmptyGeneratorPlate(n)) {
      return undefined;
    }

    // Kit paints SoftGlow in node local space — host is pill-only (no SVG plate).
    if (n && String(n.attrs?.processStatus || '') === 'running' && !nodeNeedsHtmlMediaMount(n)) {
      return undefined;
    }

    const { root, layer, hostLayer, shared } = createDomHostBoard(host, 1, 1, {
      infinite: true,
      sharedRoot,
      sharedMount,
    });
    layerRef.current = layer;
    hostLayerRef.current = hostLayer;
    const orderEl = shared ? hostLayer : layer;
    orderEl.setAttribute('data-rcb-shape-id', nodeId);
    orderEl.setAttribute('data-rcb-shape-layer', nodeId);
    orderEl.setAttribute('data-z', String(paintZIndex));
    orderEl.style.opacity = forceHiddenRef.current ? '0' : String(layerOpacity);
    if (orderEl instanceof HTMLElement) {
      orderEl.style.removeProperty('mix-blend-mode');
    } else {
      (orderEl as SVGGElement).style.removeProperty('mix-blend-mode');
    }

    const nodeEls = getSharedNodeEls() || new Map();
    registerShapeHost({
      nodeId,
      root,
      layer: hostLayer,
      svgLayer: layer,
      el: null,
      kind: 'svg',
      revealOverflow,
    });
    setPaintEl(null);

    const el = mountDomHostAnchor(layer, n, nodeId);
    if (el && !cancelled && bootRef.current === seq) {
      applyHostBlend(el, activeBlendCss);
      el.style.opacity = '1';
      el.setAttribute('opacity', '1');
      if (forceHiddenRef.current) setHostPaintOpacity(el, true);
      const reveal = revealOverflowRef.current;
      setShapeHostRevealOverflow(nodeId, reveal);
      syncFrameContentClip(root, el, document, n as Record<string, unknown> | null, {
        zoom: camera.zoom,
        revealOverflow: reveal,
      });
      const sharedMap = getSharedNodeEls();
      if (sharedMap) sharedMap.set(nodeId, el);
      else nodeEls.set(nodeId, el);
      updateShapeHostElement(nodeId, el);
      setPaintEl(el);
    }

    return () => {
      cancelled = true;
      setPaintEl(null);
      unregisterShapeHost(nodeId);
      try {
        if (shared) hostLayer.remove();
        else layer.remove();
      } catch {
        /* ignore */
      }
      layerRef.current = null;
      hostLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, reloadToken, paintToken, worldEpoch]);

  useEffect(() => {
    syncOwnedFrameClip();
  }, [camera.zoom, clipGeometryToken, document, frameClipToken, node, nodeId, revealOverflow, worldEpoch]);

  // DomHost FO size follows SceneDocument geometry without full remount.
  useEffect(() => {
    if (!node || !paintEl || !(paintEl instanceof SVGElement)) return;
    syncHtmlMediaMountGeometry(paintEl, node);
  }, [clipGeometryToken, node, paintEl]);

  // replaceShapePaint swaps `el` without remounting — re-own clip and rebind SoftGlow.
  useEffect(
    () =>
      subscribeShapeHost(nodeId, () => {
        syncOwnedFrameClip();
        const el = resolvePaintEl();
        if (el && el !== paintElRef.current) {
          paintElRef.current = el;
          setPaintEl(el);
        }
      }),
    [camera.zoom, document, node, nodeId, revealOverflow]
  );

  useEffect(() => {
    const el = resolveHostPaintEl(nodeId, layerRef.current ?? hostLayerRef.current);
    setHostPaintOpacity(el, forceHidden);
    const layer = layerRef.current ?? hostLayerRef.current;
    if (layer) layer.style.opacity = forceHidden ? '0' : String(layerOpacity);
  }, [forceHidden, nodeId, paintToken, reloadToken, layerOpacity]);

  useEffect(() => {
    const layer = layerRef.current ?? hostLayerRef.current;
    if (layer) layer.style.removeProperty('mix-blend-mode');
    applyHostBlend(resolveHostPaintEl(nodeId, layer), activeBlendCss);
  }, [activeBlendCss, paintToken, nodeId]);

  useEffect(() => {
    const layer = layerRef.current;
    const hostLayer = hostLayerRef.current;
    const mount = getSceneShapesMount();
    const orderEl = hostLayer ?? (layer as Element | null);
    if (!orderEl || !mount) return;
    const wrap = layer?.ownerSVGElement?.parentElement ?? null;
    const zEl =
      wrap instanceof HTMLElement && wrap.hasAttribute('data-rcb-dom-host-layer')
        ? wrap
        : orderEl;
    zEl.setAttribute('data-z', String(paintZIndex));
    if (zEl.parentNode !== mount) return;
    syncStackPaintOrder(mount);
  }, [paintZIndex, paintToken, worldEpoch]);

  return (
    <div
      ref={hostRef}
      data-rcb-shape-host={nodeId}
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      style={{
        zIndex,
        width: 0,
        height: 0,
        overflow: 'visible',
        opacity: 1,
      }}
    >
      {processing && node ? (
        <NodeProcessGlow nodeId={nodeId} node={node} paintHost={paintEl} />
      ) : null}
    </div>
  );
}

export default memo(RcbShapeHost, shapeHostPropsEqual);
