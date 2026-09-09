/**
 * Live host geometry helpers for selection control boxes / stroke endpoints.
 * Extracted from former host-path SVG chrome (Kit owns select chrome paint).
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  getShapeHost,
  getSharedNodeEls,
} from '@/components/rcb/shapes/shapeHostRegistry';
import { getNodeTransformPreview } from '@/components/rcb/core/transformPreview';
import type { SceneBox } from './alignGuides';

function liveNodeEl(nodeId: string): Element | null {
  return (
    (getShapeHost(nodeId)?.el as Element | null | undefined) ||
    (getSharedNodeEls()?.get(nodeId) as Element | undefined) ||
    null
  );
}

/**
 * Prefer SVG `transform="translate(x y)"` (sticky re-align / preview),
 * else `__sceneLeft/Top`.
 */
export function liveHostPaintOrigin(
  el: Element | null | undefined
): { left: number; top: number } | null {
  if (!el) return null;
  const tf =
    typeof (el as SVGElement).getAttribute === 'function'
      ? (el as SVGElement).getAttribute('transform') || ''
      : '';
  const m =
    /translate\(\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*[, ]\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
      tf
    );
  if (m) {
    const left = Number(m[1]);
    const top = Number(m[2]);
    if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
  }
  const left = Number((el as { __sceneLeft?: number }).__sceneLeft);
  const top = Number((el as { __sceneTop?: number }).__sceneTop);
  if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
  return null;
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
export function hostAngleDeg(nodeId: string, fallback = 0): number {
  const previewAngle = getNodeTransformPreview(nodeId)?.angle;
  if (previewAngle !== undefined && Number.isFinite(previewAngle)) return Number(previewAngle);
  const el = liveNodeEl(nodeId) as { __sceneAngle?: number } | null;
  const n = Number(el?.__sceneAngle);
  if (Number.isFinite(n)) return n;
  return fallback;
}

/**
 * Live geometry for path chrome / control box.
 * TransformPreview wins while gesturing; idle uses active shape host only.
 */
export function liveShapeGeomBox(nodeId: string): SceneBox | null {
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
export function nodeUsesPathChrome(node: SceneNodeInput): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  if (key === 'text' || key === 'frame') return false;
  if (key === 'image' || key === 'video' || key === 'lottie' || key === 'audio') return true;
  if (key === 'shape' || key === 'path' || key === 'rect' || key === 'ellipse') return true;
  return Boolean(node.attrs?.shapeType);
}

/**
 * Ink silhouette differs from the AABB (triangle corners, freehand path, etc.).
 */
export function shapeNeedsSelectedPathSilhouette(node: SceneNodeInput): boolean {
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

/** Line / arrow only — shaft endpoint knobs. */
export function nodeUsesOpenStrokeEndpoints(node: SceneNodeInput): boolean {
  if (!node) return false;
  const t = String(node.attrs?.shapeType || '');
  return t === 'line' || t === 'arrow';
}

/** Local (box) → world, matching host chrome rotate-about-center. */
export function localPointToWorld(
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
  const origin = liveHostPaintOrigin(hostEl);
  const left = origin ? origin.left : box.left;
  const top = origin ? origin.top : box.top;
  return {
    x: left + cx + dx * cos - dy * sin,
    y: top + cy + dx * sin + dy * cos,
  };
}

/** Place AABB so local point maps to a world point under `angleDeg`. */
export function boxFromLocalAnchor(
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

export function pathLocalEndpoints(
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
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
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

/** Outline item for Kit-painted path / union chrome. */
export type ShapeOutlineItem = {
  id: string;
  pathD: string;
  box: SceneBox;
  angle: number;
  flipX?: boolean;
  flipY?: boolean;
  color?: string;
  withHandles?: boolean;
  lineMode?: boolean;
  shaftEndpoints?: boolean;
  showRotate?: boolean;
  showPath?: boolean;
  unionChrome?: boolean;
  mirrorHostId?: string;
  cornerHandlesOnly?: boolean;
  edgeHandles?: 'all' | 'horizontal' | 'none' | 'se-only';
  chromeOutset?: number;
  strokeOuterScene?: number;
};
