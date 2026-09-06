/**
 * Pencil brushes: filled SVG silhouettes around a centerline.
 */

import getStroke from 'perfect-freehand';
import type { StrokeOptions } from 'perfect-freehand';
import { splitPolylineByDash } from '@/components/rcb/render/vector/strokeDash';

export type PencilBrushId = string;

export type BrushCategory = 'basic' | 'ink' | 'art';

/** Easing functions for the settings dropdown. */
export const PENCIL_EASING_IDS = [
  'linear',
  'easeInQuad',
  'easeOutQuad',
  'easeInOutQuad',
  'easeInCubic',
  'easeOutCubic',
  'easeInOutCubic',
  'easeInQuart',
  'easeOutQuart',
  'easeInOutQuart',
  'easeInQuint',
  'easeOutQuint',
  'easeInOutQuint',
  'easeInSine',
  'easeOutSine',
  'easeInOutSine',
  'easeInExpo',
  'easeOutExpo',
  'easeInOutExpo',
] as const;

export type PencilEasingId = (typeof PENCIL_EASING_IDS)[number];

function clampEasingT(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

const PENCIL_EASINGS: Record<PencilEasingId, (t: number) => number> = {
  linear: (t) => clampEasingT(t),
  easeInQuad: (t) => {
    const x = clampEasingT(t);
    return x * x;
  },
  easeOutQuad: (t) => {
    const x = clampEasingT(t);
    return x * (2 - x);
  },
  easeInOutQuad: (t) => {
    const x = clampEasingT(t);
    if (x < 0.5) return 2 * x * x;
    return 1 - Math.pow(-2 * x + 2, 2) / 2;
  },
  easeInCubic: (t) => {
    const x = clampEasingT(t);
    return x * x * x;
  },
  easeOutCubic: (t) => {
    const x = clampEasingT(t) - 1;
    return x * x * x + 1;
  },
  easeInOutCubic: (t) => {
    const x = clampEasingT(t);
    if (x < 0.5) return 4 * x * x * x;
    return 1 - Math.pow(-2 * x + 2, 3) / 2;
  },
  easeInQuart: (t) => {
    const x = clampEasingT(t);
    return x * x * x * x;
  },
  easeOutQuart: (t) => {
    const x = clampEasingT(t) - 1;
    return 1 - x * x * x * x;
  },
  easeInOutQuart: (t) => {
    const x = clampEasingT(t);
    if (x < 0.5) return 8 * x * x * x * x;
    return 1 - Math.pow(-2 * x + 2, 4) / 2;
  },
  easeInQuint: (t) => {
    const x = clampEasingT(t);
    return x * x * x * x * x;
  },
  easeOutQuint: (t) => {
    const x = clampEasingT(t) - 1;
    return 1 + x * x * x * x * x;
  },
  easeInOutQuint: (t) => {
    const x = clampEasingT(t);
    if (x < 0.5) return 16 * x * x * x * x * x;
    return 1 - Math.pow(-2 * x + 2, 5) / 2;
  },
  easeInSine: (t) => 1 - Math.cos((clampEasingT(t) * Math.PI) / 2),
  easeOutSine: (t) => Math.sin((clampEasingT(t) * Math.PI) / 2),
  easeInOutSine: (t) => -(Math.cos(Math.PI * clampEasingT(t)) - 1) / 2,
  easeInExpo: (t) => {
    const x = clampEasingT(t);
    if (x === 0) return 0;
    return Math.pow(2, 10 * x - 10);
  },
  easeOutExpo: (t) => {
    const x = clampEasingT(t);
    if (x === 1) return 1;
    return 1 - Math.pow(2, -10 * x);
  },
  easeInOutExpo: (t) => {
    const x = clampEasingT(t);
    if (x === 0) return 0;
    if (x === 1) return 1;
    if (x < 0.5) return Math.pow(2, 20 * x - 10) / 2;
    return (2 - Math.pow(2, -20 * x + 10)) / 2;
  },
};

export function isPencilEasingId(value: string | undefined | null): value is PencilEasingId {
  return Boolean(value && (PENCIL_EASING_IDS as readonly string[]).includes(value));
}

export function pencilEasingFn(id: string | undefined | null): (t: number) => number {
  if (isPencilEasingId(id)) return PENCIL_EASINGS[id];
  return PENCIL_EASINGS.linear;
}

export type PencilBrushDef = {
  id: PencilBrushId;
  label: string;
  category?: BrushCategory;
  /** Size multiplier relative to UI stroke width. */
  sizeFactor: number;
  options: Omit<StrokeOptions, 'size'>;
  easingId?: PencilEasingId;
  startEasingId?: PencilEasingId;
  endEasingId?: PencilEasingId;
  /** Fill the silhouette. */
  fillEnabled?: boolean;
  /** Outline stroke on the silhouette. */
  outlineStrokeWidth?: number;
  outlineStrokeColor?: string;
};

function vectorBrush(
  id: string,
  label: string,
  opts: {
    category?: BrushCategory;
    sizeFactor?: number;
    thinning?: number;
    smoothing?: number;
    streamline?: number;
    startTaper?: number;
    endTaper?: number;
  }
): PencilBrushDef {
  const linear = pencilEasingFn('linear');
  return {
    id,
    label,
    category: opts.category ?? 'basic',
    sizeFactor: opts.sizeFactor ?? 1,
    easingId: 'linear',
    startEasingId: 'linear',
    endEasingId: 'linear',
    fillEnabled: true,
    outlineStrokeWidth: 0,
    options: {
      thinning: opts.thinning ?? 0.4,
      smoothing: opts.smoothing ?? 0.5,
      streamline: opts.streamline ?? 0.4,
      easing: linear,
      start: { taper: opts.startTaper ?? 0, cap: true, easing: linear },
      end: { taper: opts.endTaper ?? 0, cap: true, easing: linear },
    },
  };
}

/** Filled SVG outlines. Stay sharp at any zoom. */
export const PENCIL_BRUSHES: PencilBrushDef[] = [
  // Balanced pressure ink (default vector) — width from hardware pressure only.
  vectorBrush('vector-ink', '矢量墨线', {
    category: 'ink',
    thinning: 0.4,
    smoothing: 0.5,
    streamline: 0.4,
  }),
  // Near-constant width — like a marker / pen stroke.
  vectorBrush('vector-even', '矢量匀线', {
    category: 'basic',
    sizeFactor: 1,
    thinning: 0.05,
    smoothing: 0.55,
    streamline: 0.45,
  }),
  // Strong pressure range — calligraphy feel.
  vectorBrush('vector-calligraphy', '矢量书法', {
    category: 'ink',
    sizeFactor: 1.15,
    thinning: 0.72,
    smoothing: 0.42,
    streamline: 0.35,
  }),
  vectorBrush('vector-pencil', '矢量铅笔', { category: 'basic', sizeFactor: 0.85, thinning: 0.2, smoothing: 0.35, streamline: 0.25 }),
  vectorBrush('vector-marker', '矢量马克笔', { category: 'basic', sizeFactor: 1.4, thinning: 0.02, smoothing: 0.62, streamline: 0.5 }),
  vectorBrush('vector-brush', '矢量毛笔', { category: 'ink', sizeFactor: 1.3, thinning: 0.85, smoothing: 0.35, streamline: 0.3 }),
  vectorBrush('vector-fountain', '矢量钢笔', { category: 'ink', sizeFactor: 0.75, thinning: 0.55, smoothing: 0.68, streamline: 0.55 }),
  vectorBrush('vector-technical', '矢量线稿', { category: 'basic', sizeFactor: 0.65, thinning: 0, smoothing: 0.7, streamline: 0.65 }),
  vectorBrush('vector-soft', '矢量软笔', { category: 'art', sizeFactor: 1.6, thinning: 0.15, smoothing: 0.5, streamline: 0.4 }),
];

/** Tool / store default — first wheel entry (矢量墨线). */
export const DEFAULT_PENCIL_BRUSH_ID: PencilBrushId = PENCIL_BRUSHES[0].id;

const brushOptionOverrides = new Map<string, Partial<PencilBrushDef['options']>>();
const brushInkOverrides = new Map<
  string,
  { fillEnabled?: boolean; outlineStrokeWidth?: number; outlineStrokeColor?: string }
>();
const brushEasingOverrides = new Map<
  string,
  { easing?: PencilEasingId; start?: PencilEasingId; end?: PencilEasingId }
>();

/** Bumps when brush options/ink change so Canvas atlas ribbons restamp. */
let pencilBrushPaintRev = 0;
const pencilBrushPaintListeners = new Set<() => void>();

export function getPencilBrushPaintRev(): number {
  return pencilBrushPaintRev;
}

export function subscribePencilBrushPaint(listener: () => void): () => void {
  pencilBrushPaintListeners.add(listener);
  return () => {
    pencilBrushPaintListeners.delete(listener);
  };
}

function bumpPencilBrushPaint() {
  pencilBrushPaintRev += 1;
  for (const fn of pencilBrushPaintListeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  // Restamp freehand ribbons on the Canvas/WebGL idle path (avoid SVG host).
  void import('@/components/rcb/render/sceneRenderer')
    .then((m) => {
      m.bumpSceneCanvasIdlePaint();
    })
    .catch(() => {
      /* ignore circular/boot */
    });
}

function mergeStrokeEnd(
  base: StrokeOptions['start'] | undefined,
  patch: StrokeOptions['start'] | undefined
): StrokeOptions['start'] {
  return { ...(base || {}), ...(patch || {}) };
}

export function updatePencilBrushOptions(
  id: string,
  patch: Partial<PencilBrushDef['options']>
) {
  const current = brushOptionOverrides.get(id) || {};
  brushOptionOverrides.set(id, {
    ...current,
    ...patch,
    start: patch.start ? mergeStrokeEnd(current.start, patch.start) : current.start,
    end: patch.end ? mergeStrokeEnd(current.end, patch.end) : current.end,
  });
  bumpPencilBrushPaint();
}

export function updatePencilBrushInk(
  id: string,
  patch: { fillEnabled?: boolean; outlineStrokeWidth?: number; outlineStrokeColor?: string }
) {
  const current = brushInkOverrides.get(id) || {};
  const next = { ...current, ...patch };
  if (next.outlineStrokeWidth != null) {
    next.outlineStrokeWidth = Math.max(0, Math.min(200, Math.round(Number(next.outlineStrokeWidth) || 0)));
  }
  brushInkOverrides.set(id, next);
  bumpPencilBrushPaint();
}

export function updatePencilBrushEasing(
  id: string,
  which: 'easing' | 'start' | 'end',
  easingId: PencilEasingId
) {
  const current = brushEasingOverrides.get(id) || {};
  brushEasingOverrides.set(id, { ...current, [which]: easingId });
  const fn = pencilEasingFn(easingId);
  if (which === 'easing') {
    updatePencilBrushOptions(id, { easing: fn });
    return;
  }
  updatePencilBrushOptions(id, { [which]: { easing: fn } });
}

export function resetPencilBrushOptions(id: string) {
  brushOptionOverrides.delete(id);
  brushEasingOverrides.delete(id);
  brushInkOverrides.delete(id);
  bumpPencilBrushPaint();
}

export function findPencilBrush(id: string | undefined | null): PencilBrushDef {
  const fallback = PENCIL_BRUSHES[0];
  if (!id) return fallback;
  const base = PENCIL_BRUSHES.find((b) => b.id === id) || fallback;
  const override = brushOptionOverrides.get(base.id);
  const easingOver = brushEasingOverrides.get(base.id);
  const inkOver = brushInkOverrides.get(base.id);
  const easingId = easingOver?.easing || base.easingId || 'linear';
  const startEasingId = easingOver?.start || base.startEasingId || 'linear';
  const endEasingId = easingOver?.end || base.endEasingId || 'linear';
  if (!override && !easingOver && !inkOver) {
    return base;
  }
  return {
    ...base,
    fillEnabled: inkOver?.fillEnabled ?? base.fillEnabled,
    outlineStrokeWidth: inkOver?.outlineStrokeWidth ?? base.outlineStrokeWidth,
    outlineStrokeColor: inkOver?.outlineStrokeColor ?? base.outlineStrokeColor,
    easingId,
    startEasingId,
    endEasingId,
    options: {
      ...base.options,
      ...override,
      easing: pencilEasingFn(easingId),
      start: {
        ...mergeStrokeEnd(base.options.start, override?.start),
        easing: pencilEasingFn(startEasingId),
      },
      end: {
        ...mergeStrokeEnd(base.options.end, override?.end),
        easing: pencilEasingFn(endEasingId),
      },
    },
  };
}

export type Pt = { x: number; y: number; pressure?: number };

export function brushSize(brush: PencilBrushDef, strokeWidth: number) {
  return Math.max(1, (Number(strokeWidth) || 1) * brush.sizeFactor);
}

/** Max gap (scene px) before input interpolation. */
export const STROKE_GAP_INTERP = 4;

export function pointHasPressure(p: Pt): boolean {
  return typeof p.pressure === 'number' && Number.isFinite(p.pressure);
}

function pressureAtSegment(a: Pt, b: Pt, t: number): number | undefined {
  const ha = pointHasPressure(a);
  const hb = pointHasPressure(b);
  if (!ha && !hb) return undefined;
  const pa = ha ? Math.min(1, Math.max(0, a.pressure as number)) : 0;
  const pb = hb ? Math.min(1, Math.max(0, b.pressure as number)) : pa;
  if (!ha) return pb;
  if (!hb) return pa;
  return pa + (pb - pa) * t;
}

export function interpolateStrokeGaps(points: Pt[], maxGap: number = STROKE_GAP_INTERP): Pt[] {
  if (points.length < 2 || maxGap <= 0) return points.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...points[0] }];
  for (let i = 1; i < points.length; i += 1) {
    const a = out[out.length - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist > maxGap) {
      const steps = Math.ceil(dist / maxGap);
      for (let s = 1; s < steps; s += 1) {
        const t = s / steps;
        const pr = pressureAtSegment(a, b, t);
        out.push({
          x: a.x + dx * t,
          y: a.y + dy * t,
          ...(pr != null ? { pressure: pr } : {}),
        });
      }
    }
    out.push({ ...b });
  }
  return out;
}

/** Outline polygon → SVG path `d` (quadratic midpoints, closed). */
export function getSvgPathFromStroke(stroke: number[][]): string {
  if (!stroke.length) return '';
  const d: (string | number)[] = [];
  const first = stroke[0];
  d.push('M', first[0], first[1], 'Q');
  for (let i = 1; i < stroke.length; i += 1) {
    const [x0, y0] = stroke[i];
    const [x1, y1] = stroke[(i + 1) % stroke.length];
    d.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  d.push('Z');
  return d.join(' ');
}

export type PencilStrokeDrawOpts = {
  /** Maps stroke-linecap onto freehand start/end caps. */
  linecap?: 'butt' | 'round' | 'square';
  /** Per-point pressure 0–1 (same length as points). */
  pressures?: number[];
  /** When false, force constant pressure. */
  pressureEnabled?: boolean;
  /**
   * When false, skip RDP simplify (live preview — simplify reshapes the tail every
   * frame and reads as jitter). Commit should leave this unset / true.
   */
  simplify?: boolean;
  /**
   * `quad` (default): midpoint Q silhouette for paint.
   * `linear`: M/L/Z polygon — for 轮廓化 path-edit (Q midpoints resist sparsify).
   */
  pathStyle?: 'quad' | 'linear';
  /** Override brush streamline (tests / special commit paths). */
  streamline?: number;
};

function outlineStrokePoints(pts: Pt[], hasRealPressure: boolean): Pt[] {
  if (hasRealPressure) return pts;
  return pts.map((p) => ({ ...p, pressure: 0.95 }));
}

export function outlinePathFromPoints(
  points: Pt[],
  strokeWidth: number,
  brushId?: string | null,
  strokeOpts?: PencilStrokeDrawOpts
): string {
  if (points.length < 2) return '';
  const brush = findPencilBrush(brushId);
  const size = brushSize(brush, strokeWidth);
  let pts: Pt[] = points.map((p, i) => {
    const pr = strokeOpts?.pressures?.[i];
    return pr != null && Number.isFinite(pr) ? { ...p, pressure: pr } : { ...p };
  });
  // Drop colinear noise before ribbon (commit). Live preview skips this —
  // RDP reshaping the tail every sample reads as jitter.
  if (strokeOpts?.simplify !== false) {
    pts = simplifyPencilCenterline(pts, pencilSimplifyEpsilon(size));
  }
  const options: Omit<StrokeOptions, 'size'> = { ...brush.options };
  const cap = strokeOpts?.linecap;
  const pressureOn = strokeOpts?.pressureEnabled !== false;
  if (!pressureOn) {
    pts = pts.map((p) => ({ x: p.x, y: p.y }));
  }
  const hasRealPressure = pressureOn && pts.some(pointHasPressure);
  const strokePts = outlineStrokePoints(pts, hasRealPressure);
  const start = { ...(options.start || {}) };
  const end = { ...(options.end || {}) };
  if (cap === 'butt') {
    start.cap = false;
    end.cap = false;
    start.taper = 0;
    end.taper = 0;
  }
  if (cap === 'square') {
    start.taper = 0;
    end.taper = 0;
  }
  const outline = getStroke(strokePts, {
    ...options,
    size,
    thinning: Number(options.thinning ?? 0.5),
    streamline: Number(
      strokeOpts?.streamline != null ? strokeOpts.streamline : (options.streamline ?? 0)
    ),
    simulatePressure: false,
    start,
    end,
    last: true,
  });
  if (strokeOpts?.pathStyle === 'linear') {
    if (outline.length < 3) return '';
    return `M ${outline.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
  }
  return getSvgPathFromStroke(outline);
}

/**
 * Build freehand outline path(s); dashed styles return multiple closed outlines joined.
 * Silhouette is a path-centered ribbon (selection baseline stays inside the ink).
 */
export function pencilInkPathFromPoints(
  points: Pt[],
  strokeWidth: number,
  brushId?: string | null,
  strokeOpts?: PencilStrokeDrawOpts & { dasharray?: string }
): string {
  if (points.length < 2) return '';
  const dash = strokeOpts?.dasharray?.trim();
  if (!dash) {
    return outlinePathFromPoints(points, strokeWidth, brushId, strokeOpts);
  }
  const segs = splitPolylineByDash(points, dash);
  return segs
    .map((seg) => outlinePathFromPoints(seg, strokeWidth, brushId, strokeOpts))
    .filter(Boolean)
    .join(' ');
}

/** Polyline → SVG path `d` (baseline centerline). */
export function polylinePathD(points: Pt[]): string {
  if (points.length < 1) return '';
  return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
}

/** Half-extent so the node bbox covers painted ink around the baseline. */
export function brushPad(brush: PencilBrushDef, strokeWidth: number) {
  const size = brushSize(brush, strokeWidth);
  // Freehand outline can flare beyond size/2 (thinning / taper).
  return Math.max(size * 0.7, strokeWidth / 2);
}

/** Parse simple M/L path into points (pencil centerline). */
export function parseSimplePathPoints(d: string): Pt[] {
  const pts: Pt[] = [];
  const re = /[ML]\s*([-\d.]+)\s+([-\d.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    pts.push({ x: Number(m[1]), y: Number(m[2]) });
  }
  return pts;
}

/** Serialize / parse per-point pressure stored on pencil nodes. */
export function serializePathPressures(points: Pt[]): string | undefined {
  if (!points.some(pointHasPressure)) return undefined;
  return points
    .map((p) =>
      pointHasPressure(p)
        ? Math.min(1, Math.max(0, p.pressure as number)).toFixed(3)
        : '0'
    )
    .join(',');
}

export function parsePathPressures(raw: unknown, pointCount: number): number[] | undefined {
  if (raw == null || raw === '' || pointCount < 1) return undefined;
  const parts = String(raw)
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== pointCount) return undefined;
  return parts.map((p) => (Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0));
}

/**
 * Ramer–Douglas–Peucker on pencil centerlines (MIT-safe in-repo impl).
 * Keeps endpoints and per-point pressure on retained vertices.
 */
export function simplifyPencilCenterline(points: Pt[], epsilon: number): Pt[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const eps = Number(epsilon);
  if (!(eps > 0)) return points.map((p) => ({ ...p }));

  function distToSeg(p: Pt, a: Pt, b: Pt): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function rdp(pts: Pt[]): Pt[] {
    if (pts.length <= 2) return pts;
    let maxDist = 0;
    let maxIdx = 0;
    const first = pts[0];
    const last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i += 1) {
      const d = distToSeg(pts[i], first, last);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist <= eps) return [first, last];
    const left = rdp(pts.slice(0, maxIdx + 1));
    const right = rdp(pts.slice(maxIdx));
    return left.slice(0, -1).concat(right);
  }

  return rdp(points.map((p) => ({ ...p })));
}

/** Scene-space epsilon for freehand bake / commit (~4.5% of tip size, min 0.25). */
export function pencilSimplifyEpsilon(strokeSize: number): number {
  const s = Number(strokeSize);
  if (!(s > 0)) return 0.35;
  return Math.max(0.25, s * 0.045);
}

/** Min scene step between stored samples — scales with ink size, stays dense at high zoom. */
export function pencilSampleMinStep(strokeWidth: number, brush?: PencilBrushDef | null): number {
  const size = brush ? brushSize(brush, strokeWidth) : Math.max(1, strokeWidth);
  return Math.max(0.12, Math.min(0.4, size * 0.1));
}
