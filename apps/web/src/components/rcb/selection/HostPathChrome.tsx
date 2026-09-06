import type { SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Path indicator + path handles on screen overlay (ADR 0027).
 * Paint via CameraTransform; hit via geometry (no HTML hit-pad divs).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useRcbCamera, useRcbDevicePixelRatio } from '@/components/rcb/camera/context';
import { HEAVY_PATH_D_CHARS, rememberNodePath2D, mergeLiveShapeParamsIntoAttrs, subscribeLiveShapeParamsPreview } from '@/components/rcb/scene/document/sceneShapes';
import { geometryIndicatorPathD } from '@/components/rcb/scene/paint/outlineToPath';
import { pathPaintDFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import {
  getShapeHost,
  getSharedNodeEls,
  getSceneSelectionChromeMount,
  listShapeHosts,
  subscribeShapeHosts,
} from '@/components/rcb/shapes/shapeHostRegistry';
import type { SceneBox } from './alignGuides';
import {
  CHROME_CORNER_L_ARM_PX,
  CHROME_CORNER_L_CLEAR_PX,
  CHROME_CORNER_L_THICK_PX,
  CHROME_HANDLE_VIS_PX,
  CHROME_LINE_ENDPOINT_HALO_PX,
  CHROME_LINE_ENDPOINT_VIS_PX,
  CHROME_STROKE_PX,
  chromeHitScaleForBox,
  clearChromeHitPads,
  cornerLLocalPath,
  liveHostPaintOrigin,
  sceneChromeBodyTransform,
  strokeOuterForRotateLScene,
} from './SelectionChrome';
import type { RcbCamera } from '@/components/rcb/core/types';
import { rcbCameraCssZoom } from '@/components/rcb/core/math';
import { getNodeTransformPreview, subscribeTransformPreview } from '@/components/rcb/core/transformPreview';

function liveNodeEl(nodeId: string): Element | null {
  // Prefer the live shape host — shared map can lag one frame after draw/remount
  // and at high zoom that desyncs paint vs pick.
  return (
    (getShapeHost(nodeId)?.el as Element | null | undefined) ||
    (getSharedNodeEls()?.get(nodeId) as Element | undefined) ||
    null
  );
}

/** Prefer the host leaf itself when it is the baseline, else first descendant. */
function resolveBaselineEl(el: SVGElement | null | undefined): SVGElement | null {
  if (!el) return null;
  if (el.getAttribute?.('data-baseline') === '1') return el;
  return (
    (el.querySelector?.(':scope > [data-baseline="1"]') as SVGElement | null) ||
    (el.querySelector?.('[data-baseline="1"]') as SVGElement | null) ||
    null
  );
}

function outlineSyncKey(o: ShapeOutlineItem): string {
  const hostKeyId = o.mirrorHostId || o.id;
  const host = getShapeHost(hostKeyId);
  const hostEl = (host?.el || getSharedNodeEls()?.get(hostKeyId)) as SVGElement | null | undefined;
  const baseline = resolveBaselineEl(hostEl);
  const liveD = readBaselinePathD(baseline, o.pathD);
  const tf = hostEl?.getAttribute?.('transform') || '';
  const anyEl = hostEl as {
    __sceneLeft?: number;
    __sceneTop?: number;
    __sceneAngle?: number;
  } | null | undefined;
  const origin = `${Number(anyEl?.__sceneLeft) || o.box.left},${Number(anyEl?.__sceneTop) || o.box.top}`;
  const liveAngle = Number.isFinite(Number(anyEl?.__sceneAngle))
    ? Number(anyEl?.__sceneAngle)
    : o.angle;
  return [
    o.id,
    o.unionChrome ? 1 : 0,
    o.mirrorHostId || '',
    liveD.length,
    liveD.slice(0, 24),
    liveD.slice(-24),
    `${o.box.left.toFixed(1)},${o.box.top.toFixed(1)},${o.box.width}x${o.box.height}`,
    liveAngle.toFixed(2),
    o.flipX ? 1 : 0,
    o.flipY ? 1 : 0,
    o.withHandles ? 1 : 0,
    o.showPath === false ? 0 : 1,
    o.lineMode ? 1 : 0,
    o.shaftEndpoints ? 1 : 0,
    o.showRotate ? 1 : 0,
    o.cornerHandlesOnly ? 1 : 0,
    o.edgeHandles || 'all',
    o.color || '',
    tf,
    origin,
  ].join(':');
}

function hostAnchorPercents(nodeId: string): { ax: number; ay: number } {
  const el = liveNodeEl(nodeId) as {
    __sceneAnchorX?: number;
    __sceneAnchorY?: number;
  } | null;
  return {
    ax: Math.max(0, Math.min(100, Number(el?.__sceneAnchorX ?? 50))),
    ay: Math.max(0, Math.min(100, Number(el?.__sceneAnchorY ?? 50))),
  };
}

function hostSkewDeg(nodeId: string): { skewX: number; skewAxis: number } {
  const el = liveNodeEl(nodeId) as {
    __sceneSkewX?: number;
    __sceneSkewAxis?: number;
  } | null;
  return {
    skewX: Number(el?.__sceneSkewX) || 0,
    skewAxis: Number(el?.__sceneSkewAxis) || 0,
  };
}

function previewGeomBox(nodeId: string): SceneBox | null {
  const preview = getNodeTransformPreview(nodeId);
  if (
    !preview ||
    !Number.isFinite(preview.left) ||
    !Number.isFinite(preview.top) ||
    !Number.isFinite(preview.width) ||
    !Number.isFinite(preview.height) ||
    preview.width <= 0 ||
    preview.height <= 0
  ) {
    return null;
  }
  return {
    left: preview.left,
    top: preview.top,
    width: preview.width,
    height: preview.height,
  };
}

/** Live rotation: TransformPreview (gesture) → host `__sceneAngle` → fallback. */
function hostAngleDeg(nodeId: string, fallback = 0): number {
  const previewAngle = getNodeTransformPreview(nodeId)?.angle;
  if (previewAngle !== undefined && Number.isFinite(previewAngle)) return Number(previewAngle);
  const el = liveNodeEl(nodeId) as { __sceneAngle?: number } | null;
  const n = Number(el?.__sceneAngle);
  if (Number.isFinite(n)) return n;
  return fallback;
}

/**
 * Live geometry for path chrome / control box.
 * Same lattice as SoA ink + marquee/group move: TransformPreview wins while
 * gesturing. Idle: active shape host only — shared `nodeEls` can keep a stale
 * leaf for canvas-ink shapes and desync the blue path from fill (脱落路径线).
 */
function liveShapeGeomBox(nodeId: string): SceneBox | null {
  const fromPreview = previewGeomBox(nodeId);
  if (fromPreview) return fromPreview;
  const el = getShapeHost(nodeId)?.el as
    | (SVGElement & {
        __sceneLeft?: number;
        __sceneTop?: number;
        sceneWidth?: number;
        sceneHeight?: number;
      })
    | null
    | undefined;
  if (!el) return null;
  const origin = liveHostPaintOrigin(el);
  const width = Number(el.sceneWidth);
  const height = Number(el.sceneHeight);
  if (origin && [width, height].every(Number.isFinite) && width > 0 && height > 0) {
    return { left: origin.left, top: origin.top, width, height };
  }
  return null;
}

/** Shape / image / video / lottie / path on SVG host (not text / frame). */
function nodeUsesPathChrome(node: SceneNodeInput): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  if (key === 'text' || key === 'frame') return false;
  // Media / vector plates use path chrome so the silhouette tracks live host geom.
  if (key === 'image' || key === 'video' || key === 'lottie' || key === 'audio') return true;
  if (key === 'shape' || key === 'path' || key === 'rect' || key === 'ellipse') return true;
  return Boolean(node.attrs?.shapeType);
}

/**
 * Ink silhouette differs from the AABB (triangle corners, freehand path, etc.).
 * Keep the blue path stroke while selected so clipped overflow outside a frame
 * still reads like a rectangle's selection box (chrome is not frame-clipped).
 */
function shapeNeedsSelectedPathSilhouette(node: SceneNodeInput): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  if (key === 'path') return true;
  const shapeType = String(node.attrs?.shapeType || (key === 'shape' ? 'rect' : ''));
  return (
    shapeType === 'triangle' ||
    shapeType === 'star' ||
    shapeType === 'polygon' ||
    shapeType === 'pen' ||
    shapeType === 'pencil' ||
    shapeType === 'path'
  );
}

export type ShapeOutlineItem = {
  id: string;
  pathD: string;
  box: SceneBox;
  angle: number;
  /** Mirror host ink flip (center scale) on the silhouette body transform. */
  flipX?: boolean;
  flipY?: boolean;
  color?: string;
  /** Selected: inject resize (and rotate) hits into the host with the outline. */
  withHandles?: boolean;
  lineMode?: boolean;
  /** Line/arrow: knobs at shaft ends (not path tip). */
  shaftEndpoints?: boolean;
  showRotate?: boolean;
  /** When false, handles/edges only. */
  showPath?: boolean;
  /** Multi-select union control box; mirrors `mirrorHostId` viewport. */
  unionChrome?: boolean;
  mirrorHostId?: string;
  cornerHandlesOnly?: boolean;
  edgeHandles?: 'all' | 'horizontal' | 'none' | 'se-only';
  /**
   * Pad from geom-local origin to control box (≥ 0). Normally 0 — box on path.
   */
  chromeOutset?: number;
  /**
   * Past outer stroke edge (scene). Rotate = screen gap + this — same at any zoom.
   */
  strokeOuterScene?: number;
};

const SVG_NS = 'http://www.w3.org/2000/svg' as const;
const SEL_OUTLINE_ATTR = 'data-rcb-sel-outline';
const SEL_CHROME_ATTR = 'data-rcb-sel-chrome';
const HOST_PATH_CHROME_ATTR = 'data-rcb-host-path-chrome';
/** Inspect pair top/bottom (or L/R) edge rails — host-injected. */
const SEL_EDGE_ATTR = 'data-rcb-sel-edge';
/** Gap / size badge pill — host-injected. */
const SEL_BADGE_ATTR = 'data-rcb-sel-badge';
const SEL_EP_HOVER_STYLE =
  'g.sel-hit:hover > .sel-ep-halo, .sel-ep-halo[data-rcb-endpoint-hover="1"] { opacity: 0.24; }';

function ensureSelEpHoverStyle(root: SVGSVGElement) {
  if (root.querySelector('style[data-rcb-sel-ep-style]')) return;
  const style = document.createElementNS(SVG_NS, 'style');
  style.setAttribute('data-rcb-sel-ep-style', '1');
  style.textContent = SEL_EP_HOVER_STYLE;
  root.insertBefore(style, root.firstChild);
}

/** Local (box) → world, matching host chrome rotate-about-center. */
function localPointToWorld(
  lx: number,
  ly: number,
  box: SceneBox,
  angleDeg: number,
  hostEl?: SVGElement | null
): { x: number; y: number } {
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const cx = w / 2;
  const cy = h / 2;
  const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = lx - cx;
  const dy = ly - cy;
  // Prefer the live paint origin so geometry hits follow the same scene values.
  // so hit pads stay under painted knobs after high-zoom sticky re-align.
  const origin = liveHostPaintOrigin(hostEl);
  const left = origin ? origin.left : box.left;
  const top = origin ? origin.top : box.top;
  return {
    x: left + cx + dx * cos - dy * sin,
    y: top + cy + dx * sin + dy * cos,
  };
}

/** Place AABB so local point maps to a world point under `angleDeg`. */
function boxFromLocalAnchor(
  localX: number,
  localY: number,
  worldX: number,
  worldY: number,
  width: number,
  height: number,
  angleDeg: number
): SceneBox {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const cx = w / 2;
  const cy = h / 2;
  const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = localX - cx;
  const dy = localY - cy;
  const centerX = worldX - (dx * cos - dy * sin);
  const centerY = worldY - (dx * sin + dy * cos);
  return { left: centerX - cx, top: centerY - cy, width: w, height: h };
}

/** One chrome group under the same camera `<g>` as scene ink. */
function ensureSharedChromeGroup(chromeId: string): SVGGElement | null {
  const layer = getSceneSelectionChromeMount();
  if (!layer) return null;
  let root = layer.querySelector(
    `:scope > g[${SEL_CHROME_ATTR}="${CSS.escape(chromeId)}"]`
  ) as SVGGElement | null;
  if (!root) {
    root = document.createElementNS(SVG_NS, 'g');
    root.setAttribute(SEL_CHROME_ATTR, chromeId);
    root.setAttribute(HOST_PATH_CHROME_ATTR, '1');
    root.style.pointerEvents = 'none';
    // Path silhouette stays under world SelectionChrome (handles must occlude ink).
    layer.insertBefore(root, layer.firstChild);
  } else if (root.parentNode === layer && layer.firstChild !== root) {
    layer.insertBefore(root, layer.firstChild);
  }
  return root;
}

/** Fingerprint for resize/rotate DOM — skip tear-down when only camera pan updates. */
function hostSelHandlesKey(
  o: ShapeOutlineItem,
  stroke: number,
  inv: number,
  outlineD: string
): string {
  // Live host lattice (not the editor store alone) — at 5000%+ even 0.01 scene is a screen px.
  const live = liveShapeGeomBox(o.id);
  const origin = liveHostPaintOrigin(liveNodeEl(o.id));
  const left = live?.left ?? origin?.left ?? o.box.left;
  const top = live?.top ?? origin?.top ?? o.box.top;
  const width = live?.width ?? o.box.width;
  const height = live?.height ?? o.box.height;
  return [
    o.withHandles ? 1 : 0,
    o.showRotate ? 1 : 0,
    o.lineMode ? 1 : 0,
    o.shaftEndpoints ? 1 : 0,
    o.cornerHandlesOnly ? 1 : 0,
    o.edgeHandles || 'all',
    o.color || '',
    stroke.toFixed(5),
    inv.toFixed(6),
    left.toFixed(4),
    top.toFixed(4),
    width.toFixed(4),
    height.toFixed(4),
    hostAngleDeg(o.id, Number(o.angle) || 0).toFixed(3),
    o.flipX ? 1 : 0,
    o.flipY ? 1 : 0,
    Number(o.chromeOutset) || 0,
    Number(o.strokeOuterScene) || 0,
    outlineD.length,
    outlineD.slice(0, 32),
    outlineD.slice(-32),
  ].join('|');
}

function syncHostSelHandlesIfNeeded(
  chrome: SVGGElement,
  o: ShapeOutlineItem,
  stroke: number,
  inv: number,
  outlineD: string,
  camera: RcbCamera,
  dpr?: number
) {
  const key = hostSelHandlesKey(o, stroke, inv, outlineD);
  if (!o.withHandles) {
    // SVG knobs gone — also drop overlay HTML pads (otherwise path-edit sees
    // leftover green DevTools boxes / steals clicks at high zoom).
    clearChromeHitPads(`sel-chrome:${o.id}`);
    if (chrome.getAttribute('data-rcb-handles-key')) {
      chrome
        .querySelectorAll(
          `g.sel-hit,[data-sel-handle],[data-rcb-sel-knob],[data-rcb-sel-rotate-l]`
        )
        .forEach((n) => n.remove());
      chrome.removeAttribute('data-rcb-handles-key');
    }
    return;
  }
  if (chrome.getAttribute('data-rcb-handles-key') === key) return;
  syncHostSelHandles(chrome, o, stroke, inv, outlineD, camera, dpr);
  chrome.setAttribute('data-rcb-handles-key', key);
}

function clearHostSelOutline(nodeId: string) {
  clearChromeHitPads(`sel-chrome:${nodeId}`);
  const host = getShapeHost(nodeId);
  const el = host?.el || getSharedNodeEls()?.get(nodeId);
  const scopes: Array<Element | null | undefined> = [
    el,
    host?.root,
    el?.parentElement,
    getSceneSelectionChromeMount(),
  ];
  const edgeForSel = `g[data-rcb-sel-edge-for="${CSS.escape(nodeId)}"]`;
  for (const scope of scopes) {
    if (!scope || typeof scope.querySelectorAll !== 'function') continue;
    scope
      .querySelectorAll(
        `[${SEL_OUTLINE_ATTR}="${CSS.escape(nodeId)}"],[${SEL_CHROME_ATTR}="${CSS.escape(nodeId)}"],[${SEL_EDGE_ATTR}="${CSS.escape(nodeId)}"],[${SEL_BADGE_ATTR}="${CSS.escape(nodeId)}"],${edgeForSel}`
      )
      .forEach((n) => {
        try {
          n.remove();
        } catch {
          /* ignore */
        }
      });
  }
}

function readBaselinePathD(baseline: SVGElement | null, fallback: string): string {
  if (!baseline) return fallback;
  const tag = baseline.tagName.toLowerCase();
  if (tag === 'path') {
    const d = baseline.getAttribute('d') || '';
    return d.trim().length >= 2 ? d : fallback;
  }
  if (tag === 'line') {
    const x1 = Number(baseline.getAttribute('x1') || 0);
    const y1 = Number(baseline.getAttribute('y1') || 0);
    const x2 = Number(baseline.getAttribute('x2') || 0);
    const y2 = Number(baseline.getAttribute('y2') || 0);
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }
  return fallback;
}

/** Keep first subpath only (donut outer). */
function silhouettePathD(d: string): string {
  const raw = String(d || '').trim();
  if (!raw) return raw;
  // Each M/m starts a subpath; keep only the first (outer).
  const parts = raw.match(/[Mm][^Mm]*/g);
  if (!parts || parts.length <= 1) return raw;
  return parts[0].trim();
}

/** Path chrome `d` — prefer live host baseline, else attrs path; single contour. */
function readHostOutlinePathD(baseline: SVGElement | null, o: ShapeOutlineItem): string {
  const d = readBaselinePathD(baseline, o.pathD);
  const subpaths = String(d || '').trim().match(/[Mm][^Mm]*/g);
  if (subpaths && subpaths.length > 1) return d;
  return silhouettePathD(d);
}

function pathLocalEndpoints(
  d: string,
  w: number,
  h: number,
  mode: 'path' | 'shaft' = 'path'
): [[number, number], [number, number]] {
  const midY = h / 2;
  const fallback: [[number, number], [number, number]] = [
    [0, midY],
    [Math.max(1, w), midY],
  ];
  if (mode === 'shaft') return fallback;
  const raw = String(d || '').trim();
  if (!raw || typeof document === 'undefined') return fallback;
  try {
    const el = document.createElementNS(SVG_NS, 'path');
    el.setAttribute('d', raw);
    const len = el.getTotalLength?.() ?? 0;
    if (!(len > 0)) return fallback;
    const a = el.getPointAtLength(0);
    const b = el.getPointAtLength(len);
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return fallback;
    return [
      [a.x, a.y],
      [b.x, b.y],
    ];
  } catch {
    return fallback;
  }
}

/** Line / arrow only — shaft endpoint knobs. Pen / pencil / path use AABB control box. */
function nodeUsesOpenStrokeEndpoints(node: SceneNodeInput): boolean {
  if (!node) return false;
  const t = String(node.attrs?.shapeType || '');
  return t === 'line' || t === 'arrow';
}

/** Freehand / boolean / stroke paths that must show real path ink as object outline. */
export function isVectorStrokeNode(node: SceneNodeInput, shapeType?: string): boolean {
  const t = shapeType ?? String(node?.attrs?.shapeType || '');
  return (
    t === 'pencil' ||
    t === 'pen' ||
    t === 'path' ||
    t === 'line' ||
    t === 'arrow' ||
    String(node?.key || '') === 'path' ||
    nodeUsesOpenStrokeEndpoints(node)
  );
}

/**
 * Object-outline path `d` in local geom space (HostPathChrome silhouette).
 * Vector strokes always use painted path; heavy geo falls back to AABB stand-in.
 * Merges live polygon/star/ellipse params so side-count drag matches ink.
 */
export function resolveOutlinePathD(
  node: SceneNodeInput,
  gw: number,
  gh: number,
  nodeId?: string
): string {
  const id = String(nodeId || node.id || '').trim();
  const attrs = id
    ? mergeLiveShapeParamsIntoAttrs(id, node.attrs as Record<string, unknown>)
    : ((node.attrs || {}) as Record<string, unknown>);
  const paintNode: SceneNodeInput = { ...node, attrs };
  const rawPath = String(attrs.path || '');
  const shapeType = String(attrs.shapeType || '');
  if (isVectorStrokeNode(paintNode, shapeType)) {
    if (rawPath.trim().length >= 2) {
      // Match Canvas/SVG paint: closed path + radius* uses filleted silhouette.
      return pathPaintDFromAttrs(attrs, { shapeType }) || rawPath;
    }
    return geometryIndicatorPathD(paintNode, { width: gw, height: gh });
  }
  if (rawPath.length >= HEAVY_PATH_D_CHARS) {
    return `M 0 0 H ${gw} V ${gh} H 0 Z`;
  }
  return geometryIndicatorPathD(paintNode, { width: gw, height: gh });
}

type BoxResizeKnob = ['n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw', number, number];

/** Control-box resize seats for the given edge/corner policy. */
function boxResizeKnobs(
  bx: number,
  by: number,
  bw: number,
  bh: number,
  opts: { cornerHandlesOnly?: boolean; edgeHandles?: 'all' | 'horizontal' | 'none' | 'se-only' }
): BoxResizeKnob[] {
  if (opts.cornerHandlesOnly) {
    return [
      ['nw', bx, by],
      ['ne', bx + bw, by],
      ['se', bx + bw, by + bh],
      ['sw', bx, by + bh],
    ];
  }
  if (opts.edgeHandles === 'none') return [];
  if (opts.edgeHandles === 'se-only') {
    return [['se', bx + bw, by + bh]];
  }
  if (opts.edgeHandles === 'horizontal') {
    return [
      ['w', bx, by + bh / 2],
      ['e', bx + bw, by + bh / 2],
    ];
  }
  return [
    ['nw', bx, by],
    ['n', bx + bw / 2, by],
    ['ne', bx + bw, by],
    ['e', bx + bw, by + bh / 2],
    ['se', bx + bw, by + bh],
    ['s', bx + bw / 2, by + bh],
    ['sw', bx, by + bh],
    ['w', bx, by + bh / 2],
  ];
}

function syncHostSelHandles(
  chrome: SVGGElement,
  o: ShapeOutlineItem,
  stroke: number,
  inv: number,
  outlineD: string,
  camera: RcbCamera,
  dpr?: number
) {
  // Drop previous handle/rotate/box (keep path silhouette outline).
  chrome
    .querySelectorAll(
      `g.sel-hit,[data-sel-handle],[data-rcb-sel-knob],[data-rcb-sel-rotate-l]`
    )
    .forEach((n) => n.remove());

  const handleVis = CHROME_HANDLE_VIS_PX * inv;
  const halfVis = handleVis / 2;
  const lineEpVis = CHROME_LINE_ENDPOINT_VIS_PX * inv;
  const angle = Number(o.angle) || 0;
  const color = o.color || '#3388ff';
  // Prefer outline box (already live geom for singles; union AABB for multi).
  // Do not re-query liveShapeGeomBox(o.id) — union id has no host.
  const w = Math.max(1, o.box.width);
  const h = Math.max(1, o.box.height);

  if (o.lineMode) {
    const [start, end] = pathLocalEndpoints(
      outlineD,
      w,
      h,
      o.shaftEndpoints ? 'shaft' : 'path'
    );
    const knobs: Array<[string, number, number]> = [
      ['w', start[0], start[1]],
      ['e', end[0], end[1]],
    ];
    const lineEpHalo = CHROME_LINE_ENDPOINT_HALO_PX * inv;
    const root = chrome.ownerSVGElement as SVGSVGElement | null;
    if (root) ensureSelEpHoverStyle(root);
    for (const [dir, lx, ly] of knobs) {
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'sel-hit');
      g.setAttribute('transform', `translate(${lx} ${ly})`);

      const halo = document.createElementNS(SVG_NS, 'circle');
      halo.setAttribute('class', 'sel-ep-halo');
      halo.setAttribute('r', String(lineEpHalo / 2));
      halo.setAttribute('fill', `${color}59`);
      // The SVG surface is geometry-hit-tested with pointer-events disabled;
      // keep a subtle transparent circle visible instead of relying on :hover.
      halo.setAttribute('opacity', '0.12');
      halo.setAttribute('pointer-events', 'none');
      g.appendChild(halo);

      const vis = document.createElementNS(SVG_NS, 'circle');
      vis.setAttribute('data-rcb-sel-knob', dir);
      vis.setAttribute('data-rcb-sel-endpoint', dir);
      vis.setAttribute('r', String(Math.max(0.01, lineEpVis / 2 - stroke / 2)));
      vis.setAttribute('fill', '#fff');
      vis.setAttribute('stroke', color);
      vis.setAttribute('stroke-width', String(stroke));
      // Same SVG element for ink + hit.
      vis.setAttribute('pointer-events', 'none');
      g.appendChild(vis);

      chrome.appendChild(g);
    }
    // Geometry hit owns knobs (ADR 0027) — do not mount HTML hit-pad divs.
    clearChromeHitPads(`sel-chrome:${o.id}`);
    return;
  }

  // Generic resize/rotate chrome is painted by the shared SelectionChrome.
  // HostPathChrome only owns the path silhouette and open-stroke endpoints.
  clearChromeHitPads(`sel-chrome:${o.id}`);
}

/** Multi-select / frame AABB control box on the screen overlay. */
function syncHostSelUnionChrome(
  o: ShapeOutlineItem,
  stroke: number,
  inv: number,
  camera: RcbCamera,
  dpr?: number
): boolean {
  const root = ensureSharedChromeGroup(o.id);
  if (!root) return false;

  let chrome = root.querySelector(`:scope > g[${SEL_CHROME_ATTR}="body"]`) as SVGGElement | null;
  if (!chrome) {
    chrome = document.createElementNS(SVG_NS, 'g');
    chrome.setAttribute(SEL_CHROME_ATTR, 'body');
    chrome.setAttribute('pointer-events', 'none');
    root.appendChild(chrome);
  }
  // Multi-node union AABB stays on o.box — never first member live (shrinks chrome).
  // Single frame: prefer live plate geom (mirrorHostId) so chrome tracks ink.
  const frameHostId =
    typeof o.id === 'string' && o.id.startsWith('__frame__:')
      ? o.mirrorHostId || o.id.slice('__frame__:'.length)
      : null;
  const angle = hostAngleDeg(frameHostId || o.id, Number(o.angle) || 0);
  const liveFrame = frameHostId ? liveShapeGeomBox(frameHostId) : null;
  const paintBox = liveFrame || o.box;
  const { ax, ay } = hostAnchorPercents(frameHostId || o.id);
  const { skewX, skewAxis } = hostSkewDeg(frameHostId || o.id);
  chrome.setAttribute(
    'transform',
    sceneChromeBodyTransform(
      paintBox,
      angle,
      Boolean(o.flipX),
      Boolean(o.flipY),
      ax,
      ay,
      skewX,
      skewAxis
    )
  );
  syncHostSelHandlesIfNeeded(chrome, { ...o, box: paintBox, angle }, stroke, inv, '', camera, dpr);
  return true;
}

/**
 * Blue path outline (+ handles) on the screen overlay (ADR 0027).
 * Body uses live host origin; path `d` stays in scene-local units.
 */
function syncHostSelOutline(
  o: ShapeOutlineItem,
  stroke: number,
  inv: number,
  camera: RcbCamera,
  dpr?: number
): boolean {
  if (o.unionChrome) return syncHostSelUnionChrome(o, stroke, inv, camera, dpr);

  const host = getShapeHost(o.id);
  const el = (host?.el || getSharedNodeEls()?.get(o.id)) as SVGElement | null | undefined;
  const baseline = resolveBaselineEl(el);

  const d = readHostOutlinePathD(baseline, o);
  if (!d) {
    clearHostSelOutline(o.id);
    return false;
  }

  // Strip leftover chrome still injected inside the shape host (never paint there).
  if (el) {
    const hostParent =
      (baseline?.parentElement as Element | null) ||
      (el.tagName.toLowerCase() === 'g' ? el : el.parentElement);
    hostParent
      ?.querySelectorAll?.(
        `[${SEL_OUTLINE_ATTR}="${CSS.escape(o.id)}"],[${SEL_CHROME_ATTR}="${CSS.escape(o.id)}"]`
      )
      .forEach((n) => {
        try {
          n.remove();
        } catch {
          /* ignore */
        }
      });
  }
  const angle = hostAngleDeg(o.id, Number(o.angle) || 0);
  const root = ensureSharedChromeGroup(o.id);
  if (!root) return false;

  let chrome = root.querySelector(`:scope > g[${SEL_CHROME_ATTR}="body"]`) as SVGGElement | null;
  if (!chrome) {
    chrome = document.createElementNS(SVG_NS, 'g');
    chrome.setAttribute(SEL_CHROME_ATTR, 'body');
    chrome.setAttribute('pointer-events', 'none');
    root.appendChild(chrome);
  }

  // Control box (selected handles): one paint AABB for CTM + knobs.
  // Hover path silhouette (`showPath`) is best-effort and not alignment-critical.
  const paintBox = liveShapeGeomBox(o.id) || o.box;
  const { ax, ay } = hostAnchorPercents(o.id);
  const { skewX, skewAxis } = hostSkewDeg(o.id);
  chrome.setAttribute(
    'transform',
    sceneChromeBodyTransform(
      paintBox,
      angle,
      Boolean(o.flipX),
      Boolean(o.flipY),
      ax,
      ay,
      skewX,
      skewAxis
    )
  );

  let outline = chrome.querySelector(
    `:scope > path[${SEL_OUTLINE_ATTR}="${CSS.escape(o.id)}"]`
  ) as SVGPathElement | null;
  if (!outline) {
    outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute(SEL_OUTLINE_ATTR, o.id);
    outline.setAttribute('fill', 'none');
    outline.setAttribute('pointer-events', 'none');
    chrome.insertBefore(outline, chrome.firstChild);
  }

  rememberNodePath2D(o.id, d);
  outline.setAttribute('d', d);
  const showPath = o.showPath !== false;
  outline.setAttribute('stroke', showPath ? o.color || '#3388ff' : 'none');
  outline.setAttribute('stroke-width', String(stroke));
  const roundStroke = Boolean(o.lineMode || o.shaftEndpoints);
  outline.setAttribute('stroke-linejoin', roundStroke ? 'round' : 'miter');
  outline.setAttribute('stroke-linecap', roundStroke ? 'round' : 'butt');

  const handleItem = { ...o, box: paintBox, angle };
  if (o.withHandles) syncHostSelHandlesIfNeeded(chrome, handleItem, stroke, inv, d, camera, dpr);
  else syncHostSelHandlesIfNeeded(chrome, { ...handleItem, withHandles: false }, stroke, inv, d, camera, dpr);

  return true;
}

/** Path chrome on screen overlay (ADR 0027); ShapeOutlineSvg drives sync only. */
function ShapeOutlineSvg({ outlines }: { outlines: ShapeOutlineItem[] }) {
  const camera = useRcbCamera();
  const dpr = useRcbDevicePixelRatio();
  const z = Math.max(0.05, rcbCameraCssZoom(camera));
  const inv = 1 / z;
  const stroke = CHROME_STROKE_PX * inv;
  const [hostEpoch, setHostEpoch] = useState(0);
  const outlineKey = outlines.map((o) => outlineSyncKey(o)).join('|');
  const outlinesRef = useRef(outlines);
  outlinesRef.current = outlines;

  useEffect(() => subscribeShapeHosts(() => setHostEpoch((n) => n + 1)), []);
  useEffect(
    () =>
      subscribeLiveShapeParamsPreview(() => {
        setHostEpoch((n) => n + 1);
      }),
    []
  );

  // Same beat as SoA ink / frame-plate move: TransformPreview writers paint
  // immediately — re-sync path chrome in that callback so blue outline cannot
  // lag a stale host leaf (marquee/group move already share this preview lattice).
  useEffect(() => {
    return subscribeTransformPreview(() => {
      const strokeNow = CHROME_STROKE_PX * (1 / Math.max(0.05, rcbCameraCssZoom(camera)));
      const invNow = 1 / Math.max(0.05, rcbCameraCssZoom(camera));
      for (const o of outlinesRef.current) {
        syncHostSelOutline(o, strokeNow, invNow, camera, dpr);
      }
    });
  }, [camera, dpr]);

  useLayoutEffect(() => {
    const current = outlinesRef.current;
    const active = new Set(current.map((o) => o.id));
    let pending = current.filter((o) => !syncHostSelOutline(o, stroke, inv, camera, dpr));
    for (const h of listShapeHosts()) {
      if (!active.has(h.nodeId)) clearHostSelOutline(h.nodeId);
    }
    const layer = getSceneSelectionChromeMount();
    // Only direct chrome roots (node id) — never nested body g[…="body"].
    layer?.querySelectorAll?.(`:scope > g[${HOST_PATH_CHROME_ATTR}]`).forEach((n) => {
      const id = n.getAttribute(SEL_CHROME_ATTR);
      if (id && !active.has(id)) {
        try {
          n.remove();
        } catch {
          /* ignore */
        }
      }
    });

    let raf = 0;
    let tries = 0;
    const retry = () => {
      if (!pending.length) return;
      tries += 1;
      pending = pending.filter((o) => !syncHostSelOutline(o, stroke, inv, camera, dpr));
      if (pending.length && tries < 120) raf = requestAnimationFrame(retry);
    };
    if (pending.length) raf = requestAnimationFrame(retry);

    // High zoom: sticky host origin can drift without React props — refresh transform.
    let stickRaf = 0;
    const stickLoop = () => {
      for (const o of outlinesRef.current) {
        syncHostSelOutline(o, stroke, inv, camera, dpr);
      }
      stickRaf = requestAnimationFrame(stickLoop);
    };
    if (z >= 2) stickRaf = requestAnimationFrame(stickLoop);

    return () => {
      cancelAnimationFrame(raf);
      if (stickRaf) cancelAnimationFrame(stickRaf);
      // Always clear this pass's ids. Re-run remounts survivors; unmount
      // (path-edit disables SelectionFeature) must not leave HTML hit pads.
      for (const id of active) {
        clearHostSelOutline(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlineKey, stroke, inv, hostEpoch, camera.x, camera.y, camera.zoom, dpr]);

  useEffect(() => {
    return () => {
      for (const o of outlinesRef.current) {
        clearHostSelOutline(o.id);
      }
    };
  }, []);

  return null;
}

export {
  liveShapeGeomBox,
  hostAngleDeg,
  nodeUsesPathChrome,
  shapeNeedsSelectedPathSilhouette,
  nodeUsesOpenStrokeEndpoints,
  pathLocalEndpoints,
  localPointToWorld,
  boxFromLocalAnchor,
  hostSelHandlesKey,
  ShapeOutlineSvg,
};
