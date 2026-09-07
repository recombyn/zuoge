/**
 * Per-node GPU mesh cache — fill + stroke triangles keyed by geom fingerprint.
 * Builds via `wasmGeom.buildShapeMeshes` (WASM with JS fallback).
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { contourFromNode } from '@/components/rcb/render/vector/contour';
import { shapeGeomFingerprint } from '@/components/rcb/render/vector/geomFingerprint';
import type { FillMesh } from '@/components/rcb/render/vector/tessellateFill';
import type { StrokeMesh } from '@/components/rcb/render/vector/tessellateStroke';
import { buildShapeMeshes } from '@/components/rcb/render/vector/wasmGeom';
import type { Vec2 } from '@/components/rcb/render/vector/contour';
import { sceneFlatness } from '@/components/rcb/render/vector/densifyPathDJs';
import {
  boolEffectAttr,
  resolveStrokeAlignForPaint,
  resolveStrokeLinecap,
  resolveStrokeLinejoin,
  resolveStrokeMiterlimit,
} from '@/components/rcb/scene/document/sceneEffects';
import { mergeLiveCornerRadiiIntoAttrs, radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import {
  ellipseArcPercentFromAttrs,
  ellipseInnerRatioFromAttrs,
  mergeLiveShapeParamsIntoAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
import { strokeDashForStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import {
  isRectLikeStrokeSidesShape,
  rectStrokeSideRuns,
} from '@/components/rcb/render/vector/strokeSides';
import { lruDelete, lruSet, lruTouch } from '@/components/rcb/render/vector/stringKeyLru';
import { strokeRibbonPaint } from '@/components/rcb/render/strokeScreenFloor';

export type CachedShapeMesh = {
  geomFp: string;
  fill: FillMesh | null;
  stroke: StrokeMesh | null;
  /**
   * Coverage alpha from build-time strokeRibbonPaint (draw path multiplies live
   * alphaScale again from strokeRibbonPaint for smooth zoom between remesh buckets).
   */
  strokeAlphaScale: number;
};

const cache = new Map<string, CachedShapeMesh>();
const MESH_CACHE_MAX = 4096;

export function invalidateShapeMesh(nodeId: string) {
  const id = String(nodeId || '');
  if (!id) return;
  lruDelete(cache, id);
}

export function clearShapeMeshCache() {
  cache.clear();
}

export function getShapeMeshCacheSize(): number {
  return cache.size;
}

function strokeWidthOf(node: SceneNodeInput): number {
  const attrs = node.attrs || {};
  if (!boolEffectAttr(attrs['stroke-enabled'], true)) return 0;
  if (!boolEffectAttr(attrs['stroke-visible'], true)) return 0;
  return Math.max(0, Number(attrs['border-width'] ?? attrs.strokeWidth) || 0);
}

function strokeAlignOf(node: SceneNodeInput): string {
  return resolveStrokeAlignForPaint(node);
}

function nodeWantsSolidFill(node: SceneNodeInput): boolean {
  const attrs = node.attrs || {};
  if (attrs['fill-enabled'] === false || String(attrs['fill-enabled']) === 'false') return false;
  if (attrs['fill-visible'] === false || String(attrs['fill-visible']) === 'false') return false;
  const fill = String(attrs['fill-color'] ?? attrs.fill ?? '')
    .trim()
    .toLowerCase();
  if (fill === 'none' || fill === 'transparent' || fill === 'rgba(0,0,0,0)') return false;
  return true;
}

/** Ellipse donut hole as local-space ring (for WebGL fill mesh). */
function ellipseHoleRing(
  node: SceneNodeInput,
  w: number,
  h: number,
  flatness: number
): Vec2[] | null {
  const ratio = ellipseInnerRatioFromAttrs(node.attrs);
  if (!(ratio > 1e-4)) return null;
  const cx = w / 2;
  const cy = h / 2;
  // Match PathBuilder.ellipseVariant: hole radius = outer * innerRatio.
  const rx = Math.max(0.5, (w / 2) * ratio);
  const ry = Math.max(0.5, (h / 2) * ratio);
  if (rx < 0.5 || ry < 0.5) return null;
  const steps = Math.max(64, Math.min(1024, Math.ceil((Math.PI * (rx + ry)) / Math.max(0.05, flatness))));
  const pts: Vec2[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return pts;
}

/** Build or reuse fill+stroke meshes for a node (local space). */
export function getOrBuildShapeMesh(
  nodeId: string,
  node: SceneNodeInput,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number }
): CachedShapeMesh | null {
  const id = String(nodeId || '');
  if (!id || !node) return null;
  const liveAttrs = mergeLiveCornerRadiiIntoAttrs(
    id,
    mergeLiveShapeParamsIntoAttrs(id, node.attrs)
  );
  const paintNode: SceneNodeInput = {
    ...node,
    id,
    attrs: liveAttrs,
  };
  const fp = shapeGeomFingerprint(paintNode, opts);
  const hit = cache.get(id);
  if (hit && hit.geomFp === fp) {
    lruTouch(cache, id);
    return hit;
  }

  const flat = sceneFlatness(opts?.zoom ?? 1, opts?.dpr ?? 1);
  const contour = contourFromNode(paintNode, opts);
  if (!contour) return null;
  const w = Math.max(1, Number(opts?.width ?? paintNode.width) || 1);
  const h = Math.max(1, Number(opts?.height ?? paintNode.height) || 1);
  const t = String(paintNode.attrs?.shapeType || '').toLowerCase();
  const holes: Vec2[][] = [];
  let meshPoints = contour.points;
  // Full donut only: outer ring + punched hole. Partial annular sectors already
  // densify PathBuilder's C-ring (outer arc → radial → inner arc → radial);
  // punching a full circle hole here bridged a fake chord across the open gap.
  const arcPct = Math.abs(ellipseArcPercentFromAttrs(paintNode.attrs || {}));
  if (
    (t === 'ellipse' || t === 'circle' || t === 'oval') &&
    arcPct >= 99.95
  ) {
    const hole = ellipseHoleRing(paintNode, w, h, flat);
    if (hole) {
      holes.push(hole);
      meshPoints = [
        ...contour.points,
        { x: Number.NaN, y: Number.NaN },
        ...hole,
      ];
    }
  }
  const fillRule =
    String(paintNode.attrs?.['fill-rule'] || 'nonzero').toLowerCase() === 'evenodd'
      ? 'evenodd'
      : 'nonzero';
  const pencilSil = Boolean(contour.pencilSilhouette);
  // Arrow stays open chevron (shaft + V strokes) — match Canvas/SVG live preview.
  // Do not fill the head triangle (that made idle look solid after commit).
  const authoredStroke = pencilSil ? 0 : strokeWidthOf(paintNode);
  const strokePaint = strokeRibbonPaint(
    authoredStroke,
    opts?.zoom ?? 1,
    opts?.dpr ?? 1
  );
  // Hairline coverage is a centered 1px strip (Skia); don't inflate inside/outside inset.
  const strokeAlign =
    !pencilSil && strokePaint.alphaScale < 1 - 1e-6
      ? 'center'
      : strokeAlignOf(paintNode);
  const dasharray = pencilSil
    ? undefined
    : strokeDashForStyle(paintNode.attrs?.strokeStyle) ||
      String(paintNode.attrs?.strokeDasharray || paintNode.attrs?.dasharray || '').trim() ||
      undefined;
  const shapeType = String(paintNode.attrs?.shapeType || '').toLowerCase();
  const sideRuns =
    !pencilSil && isRectLikeStrokeSidesShape(shapeType, paintNode.key)
      ? rectStrokeSideRuns(w, h, paintNode.attrs, radiiFromAttrs(paintNode.attrs))
      : null;
  const { fill, stroke } = buildShapeMeshes(meshPoints, {
        closed: contour.closed,
        wantFill: pencilSil || (contour.closed && nodeWantsSolidFill(paintNode)),
        // Sub-pixel: tessellate hairline scene width (Skia coverage); else authored.
        strokeWidth: pencilSil ? 0 : strokePaint.width,
        strokeAlign,
        linejoin: resolveStrokeLinejoin(paintNode.attrs),
        linecap: resolveStrokeLinecap(paintNode.attrs),
        miterLimit: resolveStrokeMiterlimit(paintNode.attrs),
        holes: holes.length ? holes : undefined,
        fillRule,
        arrowHeadFill: false,
        dasharray,
        strokeRuns: sideRuns ?? undefined,
      });
  let fillOut = fill;
  let strokeOut = stroke;
  // Pencil: vector silhouette fill only (scales crisp). No constant-width ribbon
  // (blunt tips) and no Path2D texture bake (soft on zoom-in).
  const entry: CachedShapeMesh = {
    geomFp: fp,
    fill: fillOut,
    stroke: pencilSil ? null : strokeOut,
    strokeAlphaScale: strokePaint.alphaScale,
  };
  lruSet(cache, id, entry, MESH_CACHE_MAX);
  return entry;
}
