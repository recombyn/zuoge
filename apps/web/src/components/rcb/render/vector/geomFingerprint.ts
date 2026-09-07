/**
 * Shared geometry fingerprint for Path2D cache + WebGL meshCache.
 * Includes densify LOD bucket so zoom-driven remesh invalidates correctly.
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { getPencilBrushPaintRev } from '@/components/rcb/tools/pencilBrushes';
import { densifyLodBucketSticky } from '@/components/rcb/render/vector/densifyPathDJs';
import { strokeCoverageFingerprintKey } from '@/components/rcb/render/strokeScreenFloor';

export function shapeGeomFingerprint(
  node: SceneNodeInput | null | undefined,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number; lodBucket?: number }
): string {
  if (!node) return '';
  const attrs = node.attrs || {};
  const w = Math.max(1, Number(opts?.width ?? node.width) || 1);
  const h = Math.max(1, Number(opts?.height ?? node.height) || 1);
  const key = String(node.key || '');
  const t = String(attrs.shapeType || (key === 'shape' ? 'rect' : key) || '');
  const lod =
    opts?.lodBucket != null
      ? Number(opts.lodBucket)
      : densifyLodBucketSticky(String(node.id || ''), opts?.zoom ?? 1, opts?.dpr ?? 1);
  const authoredSw = Math.max(0, Number(attrs['border-width'] ?? attrs.strokeWidth) || 0);
  // Baked freehand silhouette: skip zoom LOD remesh (outline already dense).
  const pencilBaked = t === 'pencil' && String(attrs.pencilOutlinePath || '').trim();
  const flatKey = pencilBaked ? 'flat:pencilBake' : `flat:${lod}`;
  // Pencil silhouette has no stroke ribbon — do not hairline-remesh on zoom.
  const strokeCovKey =
    t === 'pencil'
      ? `sw:${authoredSw.toFixed(3)}`
      : strokeCoverageFingerprintKey(authoredSw, opts?.zoom ?? 1, opts?.dpr ?? 1);
  const parts = [
    'strokeTess:v12-coverageHairline',
    'densify:v4',
    'arrowOpenChevron:v1',
    'pencilSil:v2-bake',
    flatKey,
    // Sub-pixel: remesh at quantized hairline width (Skia coverage); else geometric.
    strokeCovKey,
    key,
    t,
    w.toFixed(2),
    h.toFixed(2),
    String(attrs.sides ?? ''),
    String(attrs.T ?? ''),
    String(attrs.R ?? ''),
    String(attrs.B ?? ''),
    String(attrs.L ?? ''),
    String(attrs.points ?? ''),
    String(attrs.cornerRadius ?? ''),
    String(attrs.radiusTL ?? attrs.tl ?? ''),
    String(attrs.radiusTR ?? attrs.tr ?? ''),
    String(attrs.radiusBR ?? attrs.br ?? ''),
    String(attrs.radiusBL ?? attrs.bl ?? ''),
    String(attrs.tl ?? ''),
    String(attrs.tr ?? ''),
    String(attrs.br ?? ''),
    String(attrs.bl ?? ''),
    String(attrs.path ?? '').slice(0, 512),
    String(attrs.closed ?? ''),
    // Prefer camelCase product attrs (ellipseInnerRatio / ellipseArcPercent).
    String(
      attrs.ellipseInnerRatio ??
        attrs.circleInnerRatio ??
        attrs['ellipse-inner-ratio'] ??
        attrs.innerRatio ??
        attrs['inner-radius'] ??
        ''
    ),
    String(
      attrs.ellipseArcPercent ??
        attrs.circleArcPercent ??
        attrs['ellipse-arc-percent'] ??
        attrs.arcPercent ??
        attrs['arc-percent'] ??
        ''
    ),
    String(
      attrs.ellipseStartDeg ??
        attrs.circleStartDeg ??
        attrs['ellipse-start-deg'] ??
        attrs.startDeg ??
        attrs['start-deg'] ??
        ''
    ),
    String(attrs.starInnerRatio ?? attrs['inner-ratio'] ?? ''),
    String(attrs['arrow-head-size'] ?? ''),
    String(attrs['border-width'] ?? attrs.strokeWidth ?? ''),
    String(attrs.strokeAlign ?? attrs['stroke-align'] ?? ''),
    String(attrs.strokeStyle ?? attrs.strokeDasharray ?? attrs.dasharray ?? ''),
    String(attrs.strokeLinejoin ?? ''),
    String(attrs.strokeLinecap ?? ''),
    String(attrs.strokeMiterlimit ?? ''),
    String(attrs['stroke-enabled'] ?? ''),
    String(attrs['stroke-visible'] ?? ''),
    String(attrs['fill-color'] ?? attrs.fill ?? ''),
    String(attrs['fill-enabled'] ?? ''),
    String(attrs['fill-visible'] ?? ''),
    String(attrs['fill-rule'] ?? ''),
    String(attrs.brushStyle ?? ''),
    String(attrs.pathPressure ?? '').slice(0, 256),
    String(attrs.pressureEnabled ?? ''),
    (() => {
      const o = String(attrs.pencilOutlinePath ?? '');
      if (!o) return '';
      // Full outline can be multi-KB — length + head/tail avoid false mesh hits.
      return `${o.length}:${o.slice(0, 64)}:${o.slice(-64)}`;
    })(),
    t === 'pencil' ? String(getPencilBrushPaintRev()) : '',
    String(attrs.angle ?? ''),
    String(attrs.flipX ?? ''),
    String(attrs.flipY ?? ''),
  ];
  return parts.join('|');
}
