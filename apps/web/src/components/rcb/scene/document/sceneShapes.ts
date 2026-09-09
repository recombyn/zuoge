/** Regular polygon / star / stroke (line閻犺櫣妫弐row) geometry helpers. */

import { ARROW_HEAD as ARROW_HEAD_GEOM } from '@/components/rcb/core/geometry';

export const DEFAULT_SHAPE_SIDES = 5;
export const MIN_SHAPE_SIDES = 3;
export const MAX_SHAPE_SIDES = 24;
/** Inner / outer radius ratio for stars (闂佸憡鍔曢幊鎾伙綖濡ゅ懎纭€濠电姴鍊荤粣?. */
export const DEFAULT_STAR_INNER_RATIO = 0.45;
export const MIN_STAR_INNER_RATIO = 0.08;
export const MAX_STAR_INNER_RATIO = 0.92;

/** Circle / ellipse hole as fraction of outer radii (闂佸憡鍔曢幊搴＄暦閹邦剦鍤?. */
export const DEFAULT_ELLIPSE_INNER_RATIO = 0;
export const MIN_ELLIPSE_INNER_RATIO = 0;
export const MAX_ELLIPSE_INNER_RATIO = 0.92;
/** Circle / ellipse remaining sweep as % of full turn (閻庢鍟崘顭戝敽 / 闂佸憡绋忛崝灞炬叏椤掍焦鍎?. Signed. */
export const DEFAULT_ELLIPSE_ARC_PERCENT = 100;
export const MIN_ELLIPSE_ARC_PERCENT = 0;
export const MAX_ELLIPSE_ARC_PERCENT = 100;
/**
 * Snap inner hole 闂?solid disk when ratio is within this.
 * Generous so dragging the hole closed is easy (was 3.5% 闂?1闂?px on small shapes).
 */
export const ELLIPSE_INNER_SNAP_SOLID = 0.12;
/** Also snap closed when the pointer is within this many screen px of the center. */
export const ELLIPSE_INNER_SNAP_SOLID_PX = 18;
/**
 * Fixed cut-end 闂佺偨鍎茬划宀€妲愰幋鐐村弿閻庯絺鏅濈粔瀵哥磽閸愭儳鏋撻柍?in atan2 degrees (0 = east, 90 = south).
 * Start knob does not drag; arc end must not cross past this ray.
 */
export const DEFAULT_ELLIPSE_START_DEG = 90;

export function clampEllipseInnerRatio(
  n: unknown,
  fallback = DEFAULT_ELLIPSE_INNER_RATIO
): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_ELLIPSE_INNER_RATIO, Math.max(MIN_ELLIPSE_INNER_RATIO, v));
}

/**
 * Signed arc percent in [闂?00, 闂?.5] 闂?[0.5, 100].
 * |value| = remaining sweep from 閻庢鍠掗崑鎾斥攽椤旂⒈鍎庣紓宥呮噽缁? sign = sweep direction.
 */
export function clampEllipseArcPercent(
  n: unknown,
  fallback = DEFAULT_ELLIPSE_ARC_PERCENT
): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const sign = v < 0 ? -1 : 1;
  const mag = Math.min(MAX_ELLIPSE_ARC_PERCENT, Math.max(MIN_ELLIPSE_ARC_PERCENT, Math.abs(v)));
  return sign * mag;
}

/**
 * Near-zero hole 闂?solid disk (easy restore).
 * Optional ``sceneDist`` + ``zoom`` also snap when the pointer is near the center in screen px.
 */
export function snapEllipseInnerRatio(
  n: unknown,
  opts?: { sceneDist?: number; zoom?: number }
): number {
  const v = clampEllipseInnerRatio(n);
  if (v <= ELLIPSE_INNER_SNAP_SOLID) return 0;
  const sceneDist = opts?.sceneDist;
  if (typeof sceneDist === 'number' && Number.isFinite(sceneDist)) {
    const zoom = Math.max(0.05, Number(opts?.zoom) || 1);
    if (sceneDist * zoom <= ELLIPSE_INNER_SNAP_SOLID_PX) return 0;
  }
  return v;
}

/** Normalize degrees into [0, 360). */
export function clampEllipseStartDeg(
  n: unknown,
  fallback = DEFAULT_ELLIPSE_START_DEG
): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  const m = v % 360;
  return m < 0 ? m + 360 : m;
}

/** Normalize an incremental angle delta into (闂佹剚鍘藉畷濠氬焵? 闁挎粎顕? */
export function wrapAngleDelta(delta: number): number {
  let d = delta;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

const TWO_PI = Math.PI * 2;

function minEllipseArcAlong(): number {
  return (MIN_ELLIPSE_ARC_PERCENT / 100) * TWO_PI;
}

/** Remaining sweep radians from signed arc percent. */
export function ellipseArcAlongRadFromPercent(percent: number): number {
  return (Math.abs(clampEllipseArcPercent(percent)) / 100) * TWO_PI;
}

/** Signed arc % from remaining radians + locked direction. */
export function ellipseArcPercentFromAlongRad(
  alongRad: number,
  sign: 1 | -1
): number {
  const along = Math.min(TWO_PI, Math.max(minEllipseArcAlong(), alongRad));
  return clampEllipseArcPercent(sign * (along / TWO_PI) * 100);
}

/**
 * Cut ends: a0 = fixed 閻庢鍠掗崑鎾斥攽椤旂⒈鍎庣紓宥呮噽缁? a1 = movable 閻庢鍟崘顭戝敽 end.
 * mid = bisector of the remaining sweep (inner-radius seat).
 */
export function ellipseArcEndAngles(
  arcPercent: number,
  startDeg: number = DEFAULT_ELLIPSE_START_DEG
): { a0: number; a1: number; mid: number; startRad: number } {
  const pct = clampEllipseArcPercent(arcPercent);
  const startRad = (clampEllipseStartDeg(startDeg) * Math.PI) / 180;
  const sweep = (Math.abs(pct) / 100) * Math.PI * 2;
  const signed = pct < 0 ? -sweep : sweep;
  const a0 = startRad;
  const a1 = startRad + signed;
  return { a0, a1, mid: startRad + signed / 2, startRad };
}

/** Read ellipse hole ratio (0 = solid disk). */
export function ellipseInnerRatioFromAttrs(
  attrs: Record<string, unknown> | null | undefined
): number {
  return clampEllipseInnerRatio(
    attrs?.ellipseInnerRatio ??
      attrs?.circleInnerRatio ??
      attrs?.['ellipse-inner-ratio'] ??
      attrs?.['inner-radius'],
    DEFAULT_ELLIPSE_INNER_RATIO
  );
}

/** Read ellipse arc sweep percent (100 = full / 闂佸憡绋忛崝灞炬叏椤掍焦鍎?. */
export function ellipseArcPercentFromAttrs(
  attrs: Record<string, unknown> | null | undefined
): number {
  return clampEllipseArcPercent(
    attrs?.ellipseArcPercent ?? attrs?.circleArcPercent ?? attrs?.['arc-percent'],
    DEFAULT_ELLIPSE_ARC_PERCENT
  );
}

/** Read fixed 閻庢鍠掗崑鎾斥攽椤旂⒈鍎庣紓宥呮噽缁?degrees. */
export function ellipseStartDegFromAttrs(
  attrs: Record<string, unknown> | null | undefined
): number {
  return clampEllipseStartDeg(
    attrs?.ellipseStartDeg ?? attrs?.circleStartDeg ?? attrs?.['start-deg'],
    DEFAULT_ELLIPSE_START_DEG
  );
}

/**
 * Advance an arc from the pointer's incremental angular movement.
 *
 * An absolute pointer angle has two valid representations around the start
 * ray (a tiny arc and an almost-full arc), which made the opening jump sides.
 * Accumulating movement keeps one sweep direction for a whole drag and clamps
 * it to exactly one turn: once closed, further movement cannot wrap it open.
 */
export function advanceEllipseArcAlong(
  previousAlong: number,
  pointerAngleDelta: number,
  sweepSign: 1 | -1
): number {
  const next = previousAlong + wrapAngleDelta(pointerAngleDelta) * sweepSign;
  return Math.min(TWO_PI, Math.max(minEllipseArcAlong(), next));
}

/** Fixed arrowhead length in local (pre-rotation) units. */
export const ARROW_HEAD = ARROW_HEAD_GEOM;
export function clampShapeSides(n: unknown, fallback = DEFAULT_SHAPE_SIDES): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_SHAPE_SIDES, Math.max(MIN_SHAPE_SIDES, v));
}

export function clampStarInnerRatio(
  n: unknown,
  fallback = DEFAULT_STAR_INNER_RATIO
): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_STAR_INNER_RATIO, Math.max(MIN_STAR_INNER_RATIO, v));
}

/** Read sides from node attrs (polygon / star). */
export function sidesFromAttrs(attrs: Record<string, unknown> | null | undefined): number {
  return clampShapeSides(attrs?.sides, DEFAULT_SHAPE_SIDES);
}

/** Read star inner-radius ratio from attrs (fraction of outer radius). */
export function starInnerRatioFromAttrs(
  attrs: Record<string, unknown> | null | undefined
): number {
  return clampStarInnerRatio(
    attrs?.starInnerRatio ?? attrs?.innerRatio ?? attrs?.['inner-ratio'],
    DEFAULT_STAR_INNER_RATIO
  );
}

/**
 * Live polygon / star / ellipse params while knob-dragging (DOM + Kit preview).
 * Document store stays idle mid-drag; toolbars and canvas ink subscribe here.
 */
export type LiveShapeParamsPreview = {
  nodeId: string;
  sides?: number;
  starInnerRatio?: number;
  ellipseInnerRatio?: number;
  ellipseArcPercent?: number;
};

let liveShapeParamsPreview: LiveShapeParamsPreview | null = null;
const liveShapeParamsListeners = new Set<() => void>();

function liveShapeParamsFor(nodeId: string): LiveShapeParamsPreview | null {
  if (!nodeId || liveShapeParamsPreview?.nodeId !== nodeId) return null;
  return liveShapeParamsPreview;
}

export function setLiveShapeParamsPreview(next: LiveShapeParamsPreview | null) {
  if (next == null) {
    if (liveShapeParamsPreview == null) return;
    liveShapeParamsPreview = null;
    liveShapeParamsListeners.forEach((l) => l());
    return;
  }
  const prev = liveShapeParamsPreview;
  if (
    prev?.nodeId === next.nodeId &&
    prev?.sides === next.sides &&
    prev?.starInnerRatio === next.starInnerRatio &&
    prev?.ellipseInnerRatio === next.ellipseInnerRatio &&
    prev?.ellipseArcPercent === next.ellipseArcPercent
  ) {
    return;
  }
  liveShapeParamsPreview = next;
  liveShapeParamsListeners.forEach((l) => l());
}

export function patchLiveShapeParamsPreview(
  nodeId: string,
  patch: Partial<Omit<LiveShapeParamsPreview, 'nodeId'>>
) {
  if (!nodeId) return;
  const prev =
    liveShapeParamsPreview?.nodeId === nodeId
      ? liveShapeParamsPreview
      : { nodeId };
  setLiveShapeParamsPreview({ ...prev, nodeId, ...patch });
}

export function hasLiveShapeParamsPreview(): boolean {
  return liveShapeParamsPreview != null;
}

export function getLiveShapeParamsPreviewNodeId(): string | null {
  return liveShapeParamsPreview?.nodeId ?? null;
}

export function getLiveShapeParamsPreview(nodeId: string): LiveShapeParamsPreview | null {
  return liveShapeParamsFor(nodeId);
}

export function subscribeLiveShapeParamsPreview(onStoreChange: () => void): () => void {
  liveShapeParamsListeners.add(onStoreChange);
  return () => {
    liveShapeParamsListeners.delete(onStoreChange);
  };
}

export function mergeLiveShapeParamsIntoAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const live = liveShapeParamsFor(nodeId);
  if (!live) return attrs ? { ...attrs } : {};
  const merged = { ...(attrs || {}) };
  if (live.sides != null) merged.sides = live.sides;
  if (live.starInnerRatio != null) merged.starInnerRatio = live.starInnerRatio;
  if (live.ellipseInnerRatio != null) merged.ellipseInnerRatio = live.ellipseInnerRatio;
  if (live.ellipseArcPercent != null) merged.ellipseArcPercent = live.ellipseArcPercent;
  return merged;
}

export function effectiveSidesFromAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): number {
  const live = liveShapeParamsFor(nodeId);
  if (live?.sides != null) return clampShapeSides(live.sides);
  return sidesFromAttrs(attrs);
}

export function effectiveStarInnerRatioFromAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): number {
  const live = liveShapeParamsFor(nodeId);
  if (live?.starInnerRatio != null) return clampStarInnerRatio(live.starInnerRatio);
  return starInnerRatioFromAttrs(attrs);
}

export function effectiveEllipseInnerRatioFromAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): number {
  const live = liveShapeParamsFor(nodeId);
  if (live?.ellipseInnerRatio != null) return clampEllipseInnerRatio(live.ellipseInnerRatio);
  return ellipseInnerRatioFromAttrs(attrs);
}

export function effectiveEllipseArcPercentFromAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): number {
  const live = liveShapeParamsFor(nodeId);
  if (live?.ellipseArcPercent != null) return clampEllipseArcPercent(live.ellipseArcPercent);
  return ellipseArcPercentFromAttrs(attrs);
}

export function starPoints(
  cx: number,
  cy: number,
  spikes: number,
  outerR: number,
  innerR: number
): Array<[number, number]> {
  const points: [number, number][] = [];
  let rot = (Math.PI / 2) * 3;
  const step = Math.PI / spikes;
  for (let i = 0; i < spikes; i += 1) {
    points.push([cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR]);
    rot += step;
    points.push([cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR]);
    rot += step;
  }
  return points;
}

export function polygonPoints(
  cx: number,
  cy: number,
  sides: number,
  radius: number
): Array<[number, number]> {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (Math.PI * 2 * i) / sides - Math.PI / 2;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  return points;
}

/** Scale/translate points so their AABB exactly fills width 闁?height. */
export function fitPointsToBox(
  points: Array<[number, number]>,
  width: number,
  height: number
): Array<[number, number]> {
  if (!points.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return points.map(([x, y]) => [((x - minX) / bw) * w, ((y - minY) / bh) * h]);
}

/** Uniform scale + center 闂?keeps regular polygon / star proportions. */
export function fitPointsUniformToBox(
  points: Array<[number, number]>,
  width: number,
  height: number
): Array<[number, number]> {
  if (!points.length) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const bw = Math.max(1e-6, maxX - minX);
  const bh = Math.max(1e-6, maxY - minY);
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(w / bw, h / bh);
  const ox = (w - bw * scale) / 2;
  const oy = (h - bh * scale) / 2;
  return points.map(([x, y]) => [(x - minX) * scale + ox, (y - minY) * scale + oy]);
}

/** Local vertices for triangle / star / polygon, fitted to the node box. */
export function shapeVertexPoints(
  shapeType: string,
  width: number,
  height: number,
  sides: number = DEFAULT_SHAPE_SIDES,
  innerRatio: number = DEFAULT_STAR_INNER_RATIO
): Array<[number, number]> {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (shapeType === 'triangle') {
    return [
      [w / 2, 0],
      [w, h],
      [0, h],
    ];
  }
  const n = clampShapeSides(sides);
  if (shapeType === 'star') {
    const ratio = clampStarInnerRatio(innerRatio, DEFAULT_STAR_INNER_RATIO);
    return fitPointsUniformToBox(starPoints(0, 0, n, 1, ratio), w, h);
  }
  if (shapeType === 'polygon') {
    // Stretch to path AABB so extrema sit on box edges (grid-aligned stroke outer).
    return fitPointsToBox(polygonPoints(0, 0, n, 1), w, h);
  }
  return [];
}

/** Stored line/arrow thickness. */
export const STROKE_GEOMETRY_HEIGHT = 1;

export type StrokeEndpoints = { x0: number; y0: number; x1: number; y1: number };

/** Build node placement for a free-angle line/arrow from two endpoints. */
export function strokeNodeFromEndpoints(ep: StrokeEndpoints) {
  const dx = ep.x1 - ep.x0;
  const dy = ep.y1 - ep.y0;
  const length = Math.max(1, Math.hypot(dx, dy));
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const midX = (ep.x0 + ep.x1) / 2;
  const midY = (ep.y0 + ep.y1) / 2;
  const height = STROKE_GEOMETRY_HEIGHT;
  return {
    x: midX - length / 2,
    y: midY - height / 2,
    width: length,
    height,
    angle: Number(angle.toFixed(2)),
  };
}

/** World-space endpoints of a line/arrow AABB + angle (local shaft left闂佹剚鍋呮慨鐧穏ht). */
export function strokeEndpointsFromBox(
  box: { left: number; top: number; width: number; height: number },
  angleDeg: number
): StrokeEndpoints {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const rad = ((Number(angleDeg) || 0) * Math.PI) / 180;
  const hx = (box.width / 2) * Math.cos(rad);
  const hy = (box.width / 2) * Math.sin(rad);
  return {
    x0: cx - hx,
    y0: cy - hy,
    x1: cx + hx,
    y1: cy + hy,
  };
}

/**
 * Drag an endpoint freely: opposite end stays fixed; length + angle update together.
 * `handle` `e` moves the right/local end; `w` moves the left/local start.
 */
export function resizeStrokeByEndpoint(
  box: { left: number; top: number; width: number; height: number },
  angleDeg: number,
  handle: 'e' | 'w',
  pointerX: number,
  pointerY: number,
  snapToOctant = false
) {
  const ep = strokeEndpointsFromBox(box, angleDeg);
  const fixed = handle === 'e' ? { x: ep.x0, y: ep.y0 } : { x: ep.x1, y: ep.y1 };
  let nextX = pointerX;
  let nextY = pointerY;
  if (snapToOctant) {
    const dx = pointerX - fixed.x;
    const dy = pointerY - fixed.y;
    const length = Math.hypot(dx, dy);
    if (length > 1e-6) {
      const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      nextX = fixed.x + Math.cos(snapped) * length;
      nextY = fixed.y + Math.sin(snapped) * length;
    }
  }
  if (handle === 'e') {
    return strokeNodeFromEndpoints({ x0: ep.x0, y0: ep.y0, x1: nextX, y1: nextY });
  }
  return strokeNodeFromEndpoints({ x0: nextX, y0: nextY, x1: ep.x1, y1: ep.y1 });
}

/** Outlined text / dense logos - avoid re-parsing heavy path d. */
export const HEAVY_PATH_D_CHARS = 12_000;
