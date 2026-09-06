/**
 * Shared vector contours from scene nodes — feeds Path2D + tessellation.
 */
import { getShapeBaselineD } from '@/components/rcb/core/geometry/baseline';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { shapeGeomFingerprint } from '@/components/rcb/render/vector/geomFingerprint';
import { densifyPathDJs, DENSIFY_DEFAULT_FLATNESS, splitPolylineContours, sceneFlatness } from '@/components/rcb/render/vector/densifyPathDJs';
import { densifyPathDWasm } from '@/components/rcb/render/vector/wasmGeom';
import {
  ellipseArcPercentFromAttrs,
  ellipseInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
import {
  parsePathPressures,
  parseSimplePathPoints,
  pencilInkPathFromPoints,
} from '@/components/rcb/tools/pencilBrushes';

export type Vec2 = { x: number; y: number };

export type ShapeContour = {
  /** SVG path `d` in local node space (origin top-left of node box). */
  d: string;
  closed: boolean;
  /** Flattened polyline samples for tessellation (local space). */
  points: Vec2[];
  geomFp: string;
  /** Pencil freehand silhouette — paint as filled ink, not centerline stroke. */
  pencilSilhouette?: boolean;
};

/** Densify SVG path `d` — prefers WASM when ready, else JS. */
export function densifyPathD(d: string, flatness = DENSIFY_DEFAULT_FLATNESS): Vec2[] {
  const src = String(d || '');
  // Multi-subpath (arrow shaft + V): JS densify inserts NaN breaks. Old WASM
  // densify concatenated subpaths into one zigzag stroke mesh.
  const moveCount = (src.match(/[Mm]/g) || []).length;
  if (moveCount > 1) return densifyPathDJs(d, flatness);
  return densifyPathDWasm(d, flatness);
}

/** Explicit JS-only densify (tests / golden). */
export { densifyPathDJs, DENSIFY_DEFAULT_FLATNESS, splitPolylineContours, sceneFlatness };

/** Full ellipse / circle ring — peri÷flatness samples (not 4×8 Bézier chords). */
export function sampleEllipseRing(
  w: number,
  h: number,
  flatness = DENSIFY_DEFAULT_FLATNESS
): Vec2[] {
  const rx = Math.max(0.5, w / 2);
  const ry = Math.max(0.5, h / 2);
  const cx = rx;
  const cy = ry;
  const peri =
    Math.PI *
    (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const n = Math.max(64, Math.min(1024, Math.ceil(peri / Math.max(0.05, flatness))));
  const pts: Vec2[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
  }
  return pts;
}

/** Perfect-freehand outline `d` (same as live preview / SVG host). */
export function pencilSilhouettePathD(
  node: SceneNodeInput,
  strokeWidth: number
): string | null {
  const custom = String(node.attrs?.pencilOutlinePath || '').trim();
  if (custom) return custom;
  const d = String(node.attrs?.path || '').trim();
  if (!d) return null;
  const pts = parseSimplePathPoints(d);
  if (pts.length < 2) return null;
  const brushId = String(node.attrs?.brushStyle || 'vector-ink');
  const pressures = parsePathPressures(node.attrs?.pathPressure, pts.length);
  const capRaw = String(node.attrs?.strokeLinecap || 'round').toLowerCase();
  const linecap =
    capRaw === 'butt' || capRaw === 'square' ? (capRaw as 'butt' | 'square') : 'round';
  const pressureEnabled =
    node.attrs?.pressureEnabled !== false &&
    String(node.attrs?.pressureEnabled || 'true') !== 'false';
  const outline = pencilInkPathFromPoints(pts, Math.max(0.5, strokeWidth), brushId, {
    linecap,
    pressures,
    pressureEnabled,
    // Capture path is already the centerline — RDP here kinked commit vs live.
    simplify: false,
    dasharray:
      String(node.attrs?.strokeDasharray || node.attrs?.dasharray || '').trim() || undefined,
  });
  return outline || null;
}

export function contourFromNode(
  node: SceneNodeInput,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number }
): ShapeContour | null {
  const w = Math.max(1, Number(opts?.width ?? node.width) || 1);
  const h = Math.max(1, Number(opts?.height ?? node.height) || 1);
  const shapeType = String(node.attrs?.shapeType || node.key || '').toLowerCase();
  const flat = sceneFlatness(opts?.zoom ?? 1, opts?.dpr ?? 1);
  const geomFp = shapeGeomFingerprint(node, {
    width: w,
    height: h,
    zoom: opts?.zoom,
    dpr: opts?.dpr,
  });

  if (shapeType === 'pencil') {
    const sw = Math.max(
      0.5,
      Number(node.attrs?.['border-width'] ?? node.attrs?.strokeWidth) || 1
    );
    const outlineD = pencilSilhouettePathD(node, sw);
    if (outlineD) {
      const points = densifyPathD(outlineD, flat);
      if (points.length >= 3) {
        return { d: outlineD, closed: true, points, geomFp, pencilSilhouette: true };
      }
    }
  }

  const d = getShapeBaselineD(node, { width: w, height: h });
  if (!d) return null;
  const closed =
    node.attrs?.closed === true ||
    node.attrs?.closed === 'true' ||
    /\sZ\s*$/i.test(d.trim()) ||
    !(shapeType === 'line' || shapeType === 'arrow' || shapeType === 'pen' || shapeType === 'pencil');

  let points: Vec2[];
  const isEllipse =
    shapeType === 'ellipse' || shapeType === 'circle' || shapeType === 'oval';
  const arcPct = Math.abs(ellipseArcPercentFromAttrs(node.attrs || {}));
  const inner = ellipseInnerRatioFromAttrs(node.attrs || {});
  if (isEllipse && arcPct >= 99.95 && inner < 1e-4) {
    points = sampleEllipseRing(w, h, flat);
  } else {
    points = densifyPathD(d, flat);
  }
  if (points.length < 2) return null;
  return {
    d,
    closed,
    points,
    geomFp,
  };
}
