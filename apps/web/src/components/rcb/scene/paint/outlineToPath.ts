import type { SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Convert geometric shapes / text / strokes into editable SVG path `d`（轮廓化）.
 * Stroke offset + text canvas contour prefer WASM; result is `shapeType: 'path'`.
 */

import {
  clampCornerRadii,
  radiiFromAttrs,
  roundedPolygonPath,
  roundedRectPath,
  vertexRadiiFromAttrs,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  clampShapeSides,
  DEFAULT_SHAPE_SIDES,
  HEAVY_PATH_D_CHARS,
  ellipseInnerRatioFromAttrs,
  shapeVertexPoints,
  sidesFromAttrs,
  starInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
import {
  parseNodeText,
  parseNodeTextStyle,
  textVerticalOriginY,
  textVisualLines,
  toFabricFontFamily,
} from '@/components/rcb/scene/document/sceneText';
import {
  parsePathPressures,
  parseSimplePathPoints,
  pencilInkPathFromPoints,
} from '@/components/rcb/tools/pencilBrushes';
import { getShapeBaselineD, PathBuilder } from '@/components/rcb/core/geometry';
import { computeShapeBoolean, type ShapeBox } from '@/components/rcb/selection/shapeBoolean';
import { getInfiniteSvgPaintZoom } from '@/components/rcb/scene/paint/sceneToSvg';
import {
  offsetPolylineWasm,
  simplifyRdpClosedWasm,
  traceRgbaContoursWasm,
  type BoolMultiPolygon,
} from '@/components/rcb/render/vector/wasmGeom';
import { simplifyClosedPolylineGrow } from '@/components/rcb/render/vector/contourSimplify';
import { textGlyphOutlineAsync } from '@/components/rcb/render/vector/wasm/geomWorkerClient';

export type OutlineResult = {
  pathD: string;
  closed: boolean;
  /** Fill color to keep after outlining (text → shape fill). */
  fillColor?: string;
  /** SVG fill-rule — text glyphs need evenodd for counters/holes. */
  fillRule?: 'nonzero' | 'evenodd';
  /** Tight local bounds of pathD (before any node translation). */
  bounds?: { minX: number; minY: number; width: number; height: number };
  /** Rotation was baked into pathD — outlineNodePatch must clear attrs.angle. */
  bakeAngle?: boolean;
};

/** Shapes / text / stroke tools that can become an editable filled path. */
export function canOutlineNode(node: SceneNodeInput): boolean {
  if (!node) return false;
  if (node.key === 'text') return Boolean(parseNodeText(node.attrs || {}).trim());
  if (node.key === 'rect' || node.key === 'ellipse') return true;
  if (node.key === 'path') {
    // Already a free path — outlining is a no-op (still editable via dblclick).
    return false;
  }
  if (node.key !== 'shape') return false;
  const t = String(node.attrs?.shapeType || 'rect');
  if (t === 'path') return false;
  // Pen / pencil / line: outline the painted SVG stroke (keep visual silhouette).
  if (t === 'pen' || t === 'pencil') {
    return Boolean(String(node.attrs?.path || '').trim());
  }
  if (t === 'line' || t === 'arrow') return true;
  return ['rect', 'roundRect', 'circle', 'triangle', 'star', 'polygon', ''].includes(t);
}

/** Already an editable path (pen / boolean / outlined). */
export function isEditablePathNode(node: SceneNodeInput): boolean {
  if (!node) return false;
  if (node.key === 'path') {
    return Boolean(String(node.attrs?.path || '').trim());
  }
  if (node.key !== 'shape') return false;
  const t = String(node.attrs?.shapeType || '');
  if (t === 'pen' || t === 'path') {
    return Boolean(String(node.attrs?.path || '').trim());
  }
  return false;
}

/**
 * Vector baseline path in local space — delegates to geometry kernel (SoT).
 */
export function geometryIndicatorPathD(
  node: SceneNodeInput,
  opts?: { width?: number; height?: number }
): string | null {
  return getShapeBaselineD(node, opts);
}

/** Unit circle as 4 cubic Bézier segments in box [0,w]×[0,h]. */
export function ellipsePathD(w: number, h: number): string {
  return PathBuilder.ellipse(w, h).toD();
}

/**
 * Convert SVG arc / shorthand to line segments so penSubpathsFromD can parse.
 * Keeps Q/C (fontkit outlines); only densify arcs / S/T.
 */
export function normalizePathDForEdit(d: string, sampleStep?: number): string {
  const raw = String(d || '').trim();
  if (!raw) return '';
  if (typeof document === 'undefined') return raw;
  if (!/[AaSsTt]/.test(raw)) return raw;

  // Multi-contour: normalize each subpath alone (avoid stitching glyph rings).
  const chunks = raw.split(/(?=[Mm])/).map((s) => s.trim()).filter(Boolean);
  if (chunks.length > 1) {
    return chunks
      .map((c) => normalizePathDForEdit(c, sampleStep))
      .filter(Boolean)
      .join(' ');
  }

  try {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', raw);
    const len = el.getTotalLength?.() ?? 0;
    if (!(len > 0)) return raw;
    // Default ~1.25px along path (was len/48 → very jagged on long strokes).
    const step = Math.max(0.75, Math.min(2.5, sampleStep ?? len / 400));
    const pts: Array<[number, number]> = [];
    for (let t = 0; t <= len; t += step) {
      const p = el.getPointAtLength(t);
      pts.push([p.x, p.y]);
    }
    const end = el.getPointAtLength(len);
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - end.x, last[1] - end.y) > 0.35) {
      pts.push([end.x, end.y]);
    }
    const closed = /z\s*$/i.test(raw);
    if (pts.length < 2) return raw;
    let out = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i += 1) {
      out += ` L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)}`;
    }
    if (closed) out += ' Z';
    return out;
  } catch {
    return raw;
  }
}

/** AABB from absolute M/L/C/Q number pairs when SVG getBBox is unavailable. */
function pathDBoundsFromAbsolutePairs(
  d: string
): { minX: number; minY: number; width: number; height: number } | null {
  // Relative cmds — pair scanning is unsafe (H/V singles, etc.).
  if (/[mlhvcsqta]/.test(d)) return null;
  const re = /(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*,?\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(d))) {
    const x = parseFloat(m[1]);
    const y = parseFloat(m[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    n += 1;
  }
  if (n < 2 || !Number.isFinite(minX)) return null;
  return {
    minX,
    minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/** AABB of an SVG path `d` in local coordinates. */
export function pathDBounds(d: string): { minX: number; minY: number; width: number; height: number } | null {
  const raw = String(d || '').trim();
  if (!raw) return null;
  // Absolute M/L/C/Q/Z: pair AABB is stable. Chromium getBBox inside a 0×0 SVG
  // often under-reports multi-glyph text outlines → node W/H collapses (e.g. 5×1)
  // while ink still paints the full path (chrome detaches / looks “乱”).
  if (!/[mlhvcsqta]/.test(raw)) {
    const pairs = pathDBoundsFromAbsolutePairs(raw);
    if (pairs) return pairs;
  }
  if (typeof document !== 'undefined') {
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '1');
      svg.setAttribute('height', '1');
      svg.style.position = 'absolute';
      svg.style.visibility = 'hidden';
      svg.style.overflow = 'visible';
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', raw);
      svg.appendChild(el);
      document.body.appendChild(svg);
      const bb = el.getBBox();
      document.body.removeChild(svg);
      if (bb.width > 0 || bb.height > 0) {
        return {
          minX: bb.x,
          minY: bb.y,
          width: Math.max(1, bb.width),
          height: Math.max(1, bb.height),
        };
      }
    } catch {
      /* fall through — jsdom often returns empty getBBox */
    }
  }
  return pathDBoundsFromAbsolutePairs(raw);
}

/**
 * Translate absolute-coordinate path so its top-left sits at origin.
 * Relative commands are left unchanged (caller should skip geometry fit).
 */
function translatePathD(d: string, dx: number, dy: number): string | null {
  if (!dx && !dy) return d;
  // Relative commands and arc commands cannot be translated by the simple
  // coordinate-pair replacement below: arc radii / flags are numeric too.
  if (/[mlhvcsqtaAa]/.test(d)) return null;
  return d.replace(
    /(-?\d*\.?\d+(?:e[-+]?\d+)?)\s*,?\s*(-?\d*\.?\d+(?:e[-+]?\d+)?)/gi,
    (_, a: string, b: string) =>
      `${(parseFloat(a) - dx).toFixed(2)} ${(parseFloat(b) - dy).toFixed(2)}`
  );
}

function dedupePolylinePts(
  pts: Array<[number, number]>,
  eps = 0.05
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  return out;
}

/**
 * Corner vertices of an M/L/H/V polyline — no arc/curve densify.
 * Returns null when the path needs sampling (C/Q/A/S/T).
 */
function polylineVertsFromLinearPath(d: string): Array<[number, number]> | null {
  const raw = String(d || '').trim();
  if (!raw) return null;
  if (/[AaCcQqSsTt]/.test(raw)) return null;
  const tokens = raw
    .replace(/,/g, ' ')
    .replace(/([MmLlHhVvZz])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  const pts: Array<[number, number]> = [];
  let i = 0;
  let cmd = 'M';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;

  const readNum = (): number | null => {
    if (i >= tokens.length) return null;
    const n = Number(tokens[i]);
    if (!Number.isFinite(n)) return null;
    i += 1;
    return n;
  };

  const push = (x: number, y: number) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(last[0] - x, last[1] - y) < 1e-4) return;
    pts.push([x, y]);
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[MmLlHhVvZz]$/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        cx = startX;
        cy = startY;
        continue;
      }
    }
    if (cmd === 'M' || cmd === 'L') {
      const x = readNum();
      const y = readNum();
      if (x == null || y == null) break;
      cx = x;
      cy = y;
      if (cmd === 'M') {
        startX = cx;
        startY = cy;
        cmd = 'L';
      }
      push(cx, cy);
      continue;
    }
    if (cmd === 'm' || cmd === 'l') {
      const dx = readNum();
      const dy = readNum();
      if (dx == null || dy == null) break;
      cx += dx;
      cy += dy;
      if (cmd === 'm') {
        startX = cx;
        startY = cy;
        cmd = 'l';
      }
      push(cx, cy);
      continue;
    }
    if (cmd === 'H') {
      const x = readNum();
      if (x == null) break;
      cx = x;
      push(cx, cy);
      continue;
    }
    if (cmd === 'h') {
      const dx = readNum();
      if (dx == null) break;
      cx += dx;
      push(cx, cy);
      continue;
    }
    if (cmd === 'V') {
      const y = readNum();
      if (y == null) break;
      cy = y;
      push(cx, cy);
      continue;
    }
    if (cmd === 'v') {
      const dy = readNum();
      if (dy == null) break;
      cy += dy;
      push(cx, cy);
      continue;
    }
    // Unknown token — not a pure polyline.
    return null;
  }
  const cleaned = dedupePolylinePts(pts, 0.02);
  return cleaned.length >= 2 ? cleaned : null;
}

function segUnitNormal(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

function segUnitTangent(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy) || 1;
  return [dx / len, dy / len];
}

/** Seat a point on the stroke circle (same idea as corner-radius handle seats). */
function seatOnCircle(
  center: [number, number],
  p: [number, number],
  radius: number
): [number, number] {
  const r = Math.max(0.25, radius);
  const dx = p[0] - center[0];
  const dy = p[1] - center[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-8) return [center[0] + r, center[1]];
  return [center[0] + (dx / len) * r, center[1] + (dy / len) * r];
}

/** Offset-line intersection for miter tips (null if parallel). */
function intersectOffsetLines(
  a0: [number, number],
  a1: [number, number],
  b0: [number, number],
  b1: [number, number]
): [number, number] | null {
  const dax = a1[0] - a0[0];
  const day = a1[1] - a0[1];
  const dbx = b1[0] - b0[0];
  const dby = b1[1] - b0[1];
  const cross = dax * dby - day * dbx;
  if (Math.abs(cross) < 1e-10) return null;
  const t = ((b0[0] - a0[0]) * dby - (b0[1] - a0[1]) * dbx) / cross;
  return [a0[0] + t * dax, a0[1] + t * day];
}

/**
 * Round cap/join as L samples on the circle (no cubics — path-edit diamonds looked floated).
 * `outward` picks the exterior arc. Keep step fine on thick strokes so round tips stay round.
 */
function appendCircularArcPolyline(
  parts: string[],
  center: [number, number],
  from: [number, number],
  to: [number, number],
  radius: number,
  outward: [number, number]
) {
  const r = Math.max(0.25, radius);
  const fromS = seatOnCircle(center, from, r);
  const toS = seatOnCircle(center, to, r);
  const a0 = Math.atan2(fromS[1] - center[1], fromS[0] - center[0]);
  const a1 = Math.atan2(toS[1] - center[1], toS[0] - center[0]);

  let dCcw = a1 - a0;
  while (dCcw <= 1e-10) dCcw += Math.PI * 2;
  let dCw = a1 - a0;
  while (dCw >= -1e-10) dCw -= Math.PI * 2;

  const midDot = (delta: number) => {
    const mid = a0 + delta / 2;
    return Math.cos(mid) * outward[0] + Math.sin(mid) * outward[1];
  };
  let delta = midDot(dCcw) >= midDot(dCw) ? dCcw : dCw;
  if (Math.abs(delta) > Math.PI + 1e-3) {
    delta = delta > 0 ? Math.PI : -Math.PI;
  }
  if (Math.abs(delta) < 1e-4) {
    parts.push(`L ${toS[0].toFixed(2)} ${toS[1].toFixed(2)}`);
    return;
  }

  // ~60° / sample → semicircle ≈ 3 verts (corner knobs, not a bead arc).
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 3) - 1e-6));
  for (let s = 1; s <= steps; s += 1) {
    const ang = a0 + (delta * s) / steps;
    parts.push(
      `L ${(center[0] + Math.cos(ang) * r).toFixed(2)} ${(center[1] + Math.sin(ang) * r).toFixed(2)}`
    );
  }
}

/**
 * Keep centerline verts as drawn. Only drop consecutive duplicates.
 */
function prepareStrokeCenterline(
  ptsIn: Array<[number, number]>,
  _strokeWidth: number
): Array<[number, number]> {
  return dedupePolylinePts(ptsIn, 0.02);
}

/** Merge consecutive verts closer than `minLen` (keep endpoints). */
function enforceMinSegLength(
  pts: Array<[number, number]>,
  minLen: number
): Array<[number, number]> {
  if (pts.length <= 2) return pts;
  const out: Array<[number, number]> = [pts[0]];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = out[out.length - 1];
    const p = pts[i];
    if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) >= minLen) out.push(p);
  }
  const last = pts[pts.length - 1];
  const prev = out[out.length - 1];
  if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) < minLen && out.length > 1) {
    out[out.length - 1] = last;
  } else if (Math.hypot(last[0] - prev[0], last[1] - prev[1]) >= 1e-6) {
    out.push(last);
  }
  return out.length >= 2 ? out : pts.slice(0, 2);
}

/**
 * Drop needle / hairline tips on a closed outline (self-crossed offset leftovers).
 * A vert is a needle when both adjacent edges are short and the turn is ~flat back.
 * Do not treat dense round-cap samples (short chords, gentle turn) as needles.
 */
function stripOutlineNeedles(
  ptsIn: Array<[number, number]>,
  strokeWidth: number
): Array<[number, number]> {
  if (ptsIn.length < 4) return ptsIn;
  // Only true spikes (≪ half-width); round-cap chords are ~3–4px and must stay.
  const minEdge = Math.max(0.8, strokeWidth * 0.12);
  let pts = ptsIn.slice();
  let guard = 0;
  while (guard < 24) {
    guard += 1;
    const n = pts.length;
    if (n < 4) break;
    let removed = false;
    const next: Array<[number, number]> = [];
    for (let i = 0; i < n; i += 1) {
      const prev = pts[(i - 1 + n) % n];
      const curr = pts[i];
      const nxt = pts[(i + 1) % n];
      const d0 = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]);
      const d1 = Math.hypot(nxt[0] - curr[0], nxt[1] - curr[1]);
      if (d0 < minEdge && d1 < minEdge) {
        const ax = curr[0] - prev[0];
        const ay = curr[1] - prev[1];
        const bx = nxt[0] - curr[0];
        const by = nxt[1] - curr[1];
        const la = d0 || 1;
        const lb = d1 || 1;
        const dot = (ax / la) * (bx / lb) + (ay / la) * (by / lb);
        // Sharp reverse / hairline spike (not a gentle round-cap turn).
        if (dot < -0.45) {
          removed = true;
          continue;
        }
      }
      next.push(curr);
    }
    if (!removed || next.length < 3) break;
    pts = next;
  }
  return pts.length >= 3 ? pts : ptsIn;
}

function closedPathDFromPts(pts: Array<[number, number]>): string {
  if (pts.length < 2) return '';
  const a = pts[0]!;
  let d = `M ${a[0].toFixed(2)} ${a[1].toFixed(2)}`;
  for (let i = 1; i < pts.length; i += 1) {
    d += ` L ${pts[i]![0].toFixed(2)} ${pts[i]![1].toFixed(2)}`;
  }
  return `${d} Z`;
}

/** MultiPolygon (WASM offset / boolean) → SVG path `d` (absolute, evenodd-friendly). */
function boolMultiPolygonToPathD(mp: BoolMultiPolygon): string | null {
  const parts: string[] = [];
  for (const poly of mp) {
    for (const ring of poly) {
      if (!ring || ring.length < 3) continue;
      const pts: Array<[number, number]> = ring.map((p) => [
        Number(p[0]) || 0,
        Number(p[1]) || 0,
      ]);
      const d = closedPathDFromPts(dedupePolylinePts(pts, 0.15));
      if (d) parts.push(d);
    }
  }
  return parts.length ? parts.join(' ') : null;
}

function parseClosedOutlineVerts(d: string): Array<[number, number]> | null {
  const linear = polylineVertsFromLinearPath(String(d || '').replace(/[Zz]\s*$/i, ''));
  return linear && linear.length >= 3 ? linear : null;
}

/**
 * Uniform-width stroke outline of a polyline.
 * Offset the drawn centerline with the painted linecap / linejoin — no reshape.
 * `closed`: Z / coincident ends — miter every vertex incl. closure (no butt caps).
 */
function outlinePolylineStroke(
  ptsIn: Array<[number, number]>,
  strokeWidth: number,
  linecap: CanvasLineCap = 'butt',
  linejoin: CanvasLineJoin = 'miter',
  miterLimit = 100,
  closed = false
): string | null {
  let pts = prepareStrokeCenterline(ptsIn, strokeWidth);
  if (closed && pts.length >= 3) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05) pts = pts.slice(0, -1);
  }
  if (closed && pts.length >= 3) {
    const wasmClosed = offsetPolylineWasm(pts, strokeWidth, true, {
      linejoin,
      linecap,
      miterLimit,
    });
    if (wasmClosed) {
      const d = boolMultiPolygonToPathD(wasmClosed);
      if (d) return d;
    }
    return outlineClosedPolylineStroke(pts, strokeWidth, linejoin, miterLimit);
  }
  if (pts.length < 2) return null;

  const wasmOpen = offsetPolylineWasm(pts, strokeWidth, false, {
    linejoin,
    linecap,
    miterLimit,
  });
  if (wasmOpen) {
    const d = boolMultiPolygonToPathD(wasmOpen);
    if (d) return d;
  }

  const join = linejoin;
  const half = Math.max(0.25, strokeWidth / 2);
  const miterCap = half * Math.max(1, miterLimit);
  const n = pts.length;

  type SegOff = {
    l0: [number, number];
    l1: [number, number];
    r0: [number, number];
    r1: [number, number];
  };
  const segs: SegOff[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const [nx, ny] = segUnitNormal(b[0] - a[0], b[1] - a[1]);
    segs.push({
      l0: [a[0] + nx * half, a[1] + ny * half],
      l1: [b[0] + nx * half, b[1] + ny * half],
      r0: [a[0] - nx * half, a[1] - ny * half],
      r1: [b[0] - nx * half, b[1] - ny * half],
    });
  }
  if (!segs.length) return null;

  const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  // Skip near-duplicate verts so path-edit does not show stacked / “floated” knobs.
  // Keep below half-width so butt short-sides (length = strokeWidth) are not dropped.
  const mergeEps = Math.max(0.2, Math.min(0.85, half * 0.15));
  let curX = segs[0].l0[0];
  let curY = segs[0].l0[1];
  const parts: string[] = [`M ${curX.toFixed(2)} ${curY.toFixed(2)}`];
  const emitL = (x: number, y: number) => {
    if (Math.hypot(x - curX, y - curY) < mergeEps) return;
    parts.push(`L ${x.toFixed(2)} ${y.toFixed(2)}`);
    curX = x;
    curY = y;
  };
  /** Exterior miter: replace the just-emitted offset end (`from`) with the tip. */
  const replaceCursorWith = (x: number, y: number) => {
    if (parts.length <= 1) {
      parts[0] = `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    } else {
      parts[parts.length - 1] = `L ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    curX = x;
    curY = y;
  };
  const emitArc = (
    center: [number, number],
    from: [number, number],
    to: [number, number],
    outward: [number, number]
  ) => {
    const before = parts.length;
    appendCircularArcPolyline(parts, center, from, to, half, outward);
    for (let i = parts.length - 1; i >= before; i -= 1) {
      const m = /^L\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(parts[i]);
      if (m) {
        curX = parseFloat(m[1]);
        curY = parseFloat(m[2]);
        break;
      }
    }
  };

  const appendJoin = (
    vertex: [number, number],
    from: [number, number],
    to: [number, number],
    leftSide: boolean,
    prevSeg: SegOff,
    nextSeg: SegOff
  ) => {
    if (join === 'bevel') {
      emitL(to[0], to[1]);
      return;
    }
    if (join === 'miter') {
      const tip = leftSide
        ? intersectOffsetLines(prevSeg.l0, prevSeg.l1, nextSeg.l0, nextSeg.l1)
        : intersectOffsetLines(prevSeg.r0, prevSeg.r1, nextSeg.r0, nextSeg.r1);
      if (tip) {
        const miterLen = Math.hypot(tip[0] - vertex[0], tip[1] - vertex[1]);
        // Always keep the geometric tip when within limit — do not gate on
        // “exterior” (that mis-classified acute pen corners as bevels).
        if (Number.isFinite(miterLen) && miterLen <= miterCap + 1e-6) {
          if (Math.hypot(curX - from[0], curY - from[1]) < mergeEps * 4) {
            replaceCursorWith(tip[0], tip[1]);
          } else {
            emitL(tip[0], tip[1]);
          }
          return;
        }
      }
      emitL(to[0], to[1]);
      return;
    }
    // round
    const vx0 = from[0] - vertex[0];
    const vy0 = from[1] - vertex[1];
    const vx1 = to[0] - vertex[0];
    const vy1 = to[1] - vertex[1];
    const cr = cross(vx0, vy0, vx1, vy1);
    const exterior = leftSide ? cr > 1e-8 : cr < -1e-8;
    if (!exterior) {
      emitL(to[0], to[1]);
      return;
    }
    const len0 = Math.hypot(vx0, vy0) || 1;
    const len1 = Math.hypot(vx1, vy1) || 1;
    emitArc(vertex, from, to, [vx0 / len0 + vx1 / len1, vy0 / len0 + vy1 / len1]);
  };

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (i > 0) {
      appendJoin(pts[i], segs[i - 1].l1, seg.l0, true, segs[i - 1], seg);
    }
    emitL(seg.l1[0], seg.l1[1]);
  }

  const end = pts[n - 1];
  const last = segs[segs.length - 1];
  if (linecap === 'round') {
    const [tx, ty] = segUnitTangent(end[0] - pts[n - 2][0], end[1] - pts[n - 2][1]);
    emitArc(end, last.l1, last.r1, [tx, ty]);
  } else if (linecap === 'square') {
    const [tx, ty] = segUnitTangent(end[0] - pts[n - 2][0], end[1] - pts[n - 2][1]);
    emitL(last.l1[0] + tx * half, last.l1[1] + ty * half);
    emitL(last.r1[0] + tx * half, last.r1[1] + ty * half);
  } else {
    emitL(last.r1[0], last.r1[1]);
  }

  for (let i = segs.length - 1; i >= 0; i -= 1) {
    const seg = segs[i];
    if (i < segs.length - 1) {
      appendJoin(pts[i + 1], segs[i + 1].r0, seg.r1, false, segs[i + 1], seg);
    }
    emitL(seg.r0[0], seg.r0[1]);
  }

  const start = pts[0];
  const first = segs[0];
  if (linecap === 'round') {
    const [tx, ty] = segUnitTangent(pts[1][0] - start[0], pts[1][1] - start[1]);
    emitArc(start, first.r0, first.l0, [-tx, -ty]);
  } else if (linecap === 'square') {
    const [tx, ty] = segUnitTangent(pts[1][0] - start[0], pts[1][1] - start[1]);
    emitL(first.r0[0] - tx * half, first.r0[1] - ty * half);
    emitL(first.l0[0] - tx * half, first.l0[1] - ty * half);
  }

  parts.push('Z');
  // Keep the offset silhouette as emitted — do not strip miter tips as “needles”.
  return parts.join(' ');
}

type StrokeSegOff = {
  l0: [number, number];
  l1: [number, number];
  r0: [number, number];
  r1: [number, number];
};

/** Join point(s) at a vertex for closed-ring offset (miter / bevel / round). */
function closedJoinRingPoints(
  vertex: [number, number],
  from: [number, number],
  to: [number, number],
  leftSide: boolean,
  prevSeg: StrokeSegOff,
  nextSeg: StrokeSegOff,
  join: CanvasLineJoin,
  half: number,
  miterCap: number
): Array<[number, number]> {
  if (join === 'bevel') return [to];
  if (join === 'miter') {
    const tip = leftSide
      ? intersectOffsetLines(prevSeg.l0, prevSeg.l1, nextSeg.l0, nextSeg.l1)
      : intersectOffsetLines(prevSeg.r0, prevSeg.r1, nextSeg.r0, nextSeg.r1);
    if (tip) {
      const miterLen = Math.hypot(tip[0] - vertex[0], tip[1] - vertex[1]);
      if (Number.isFinite(miterLen) && miterLen <= miterCap + 1e-6) return [tip];
    }
    return [to];
  }
  const cross2 = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
  const vx0 = from[0] - vertex[0];
  const vy0 = from[1] - vertex[1];
  const vx1 = to[0] - vertex[0];
  const vy1 = to[1] - vertex[1];
  const cr = cross2(vx0, vy0, vx1, vy1);
  const exterior = leftSide ? cr > 1e-8 : cr < -1e-8;
  if (!exterior) return [to];
  const len0 = Math.hypot(vx0, vy0) || 1;
  const len1 = Math.hypot(vx1, vy1) || 1;
  const parts: string[] = [];
  appendCircularArcPolyline(parts, vertex, from, to, half, [
    vx0 / len0 + vx1 / len1,
    vy0 / len0 + vy1 / len1,
  ]);
  const out: Array<[number, number]> = [];
  for (const p of parts) {
    const m = /^L\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(p);
    if (m) out.push([parseFloat(m[1]), parseFloat(m[2])]);
  }
  return out.length ? out : [to];
}

/**
 * Closed centerline → outer + inner offset rings (evenodd fill).
 * Joins every vertex including the Z closure — same miter as mid-path corners.
 */
function outlineClosedPolylineStroke(
  ptsIn: Array<[number, number]>,
  strokeWidth: number,
  linejoin: CanvasLineJoin,
  miterLimit: number
): string | null {
  // Collapse near-duplicate consecutive verts (incl. wrap) so every edge is real.
  const raw = dedupePolylinePts(ptsIn, 0.05);
  if (raw.length < 3) return null;
  const pts =
    Math.hypot(raw[0][0] - raw[raw.length - 1][0], raw[0][1] - raw[raw.length - 1][1]) < 0.05
      ? raw.slice(0, -1)
      : raw;
  const n = pts.length;
  if (n < 3) return null;
  const join = linejoin;
  const half = Math.max(0.25, strokeWidth / 2);
  const miterCap = half * Math.max(1, miterLimit);
  const segs: StrokeSegOff[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (Math.hypot(dx, dy) < 1e-8) return null;
    const [nx, ny] = segUnitNormal(dx, dy);
    segs.push({
      l0: [a[0] + nx * half, a[1] + ny * half],
      l1: [b[0] + nx * half, b[1] + ny * half],
      r0: [a[0] - nx * half, a[1] - ny * half],
      r1: [b[0] - nx * half, b[1] - ny * half],
    });
  }
  if (segs.length < 3) return null;

  const leftRing: Array<[number, number]> = [];
  const rightRing: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const prev = segs[(i - 1 + n) % n];
    const next = segs[i];
    const vertex = pts[i];
    leftRing.push(
      ...closedJoinRingPoints(vertex, prev.l1, next.l0, true, prev, next, join, half, miterCap)
    );
    rightRing.push(
      ...closedJoinRingPoints(vertex, prev.r1, next.r0, false, prev, next, join, half, miterCap)
    );
  }
  const outer = closedPathDFromPts(dedupePolylinePts(leftRing, 0.15));
  const inner = closedPathDFromPts(dedupePolylinePts(rightRing.slice().reverse(), 0.15));
  if (!outer || !inner) return outer || inner || null;
  return `${outer} ${inner}`;
}

/** True when an SVG subpath closes (Z) or ends on its start. */
function strokeSubpathIsClosed(chunk: string, pts: Array<[number, number]>): boolean {
  if (/[zZ]\s*$/.test(String(chunk || '').trim())) return true;
  if (pts.length < 3) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.05;
}

/** Sample each SVG subpath into a polyline (absolute). */
function samplePathSubpaths(
  d: string,
  stepPx = 1.25
): Array<{ pts: Array<[number, number]>; closed: boolean }> {
  const chunks = String(d || '')
    .split(/(?=[Mm])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: Array<{ pts: Array<[number, number]>; closed: boolean }> = [];
  for (const chunk of chunks) {
    // Straight M/L/H/V polylines keep corner verts only (no px densify).
    const linear = polylineVertsFromLinearPath(chunk);
    if (linear) {
      out.push({ pts: linear, closed: strokeSubpathIsClosed(chunk, linear) });
      continue;
    }
    if (typeof document === 'undefined') continue;
    try {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', chunk);
      const len = el.getTotalLength?.() ?? 0;
      if (!(len > 0)) continue;
      const n = Math.max(2, Math.ceil(len / Math.max(0.5, stepPx)));
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= n; i += 1) {
        const p = el.getPointAtLength((len * i) / n);
        pts.push([p.x, p.y]);
      }
      // Curves: keep samples dense — do not RDP-shred the silhouette.
      const cleaned = dedupePolylinePts(pts, 0.15);
      if (cleaned.length >= 2) {
        out.push({ pts: cleaned, closed: strokeSubpathIsClosed(chunk, cleaned) });
      }
    } catch {
      /* skip bad subpath */
    }
  }
  return out;
}

/**
 * Stroke → filled outline (pen / line / arrow / pencil).
 * Pure geometric offset of the drawn path — no reshape / sparsify / tip stripping.
 */
function outlineFromSvgStroke(opts: {
  pathD: string;
  strokeWidth: number;
  linecap?: CanvasLineCap;
  linejoin?: CanvasLineJoin;
  miterLimit?: number;
  fillColor: string;
  zoom?: number;
}): OutlineResult | null {
  const raw = String(opts.pathD || '').trim();
  const sw = Math.max(0.5, Number(opts.strokeWidth) || 1);
  if (!raw) return null;
  const linecap = opts.linecap || 'butt';
  const linejoin = opts.linejoin || 'miter';
  const miterLimit = opts.miterLimit ?? 100;

  const finish = (d: string | null, fillRule?: 'nonzero' | 'evenodd'): OutlineResult | null => {
    if (!d) return null;
    return {
      pathD: d,
      closed: true,
      fillColor: opts.fillColor,
      ...(fillRule ? { fillRule } : {}),
    };
  };

  // M/L corners as-is; curves → dense polyline (fine step, light dedupe only).
  const subpaths = samplePathSubpaths(raw, Math.max(0.5, Math.min(1.5, sw * 0.2)));
  if (!subpaths.length) return null;

  const parts: OutlineResult[] = [];
  let anyClosed = false;
  for (const sub of subpaths) {
    const d = outlinePolylineStroke(sub.pts, sw, linecap, linejoin, miterLimit, sub.closed);
    if (d) {
      if (sub.closed) anyClosed = true;
      parts.push({
        pathD: d,
        closed: true,
        fillColor: opts.fillColor,
        fillRule: sub.closed ? 'evenodd' : undefined,
      });
    }
  }
  if (!parts.length) return null;
  if (parts.length === 1) {
    return finish(parts[0].pathD, parts[0].fillRule);
  }

  const u = unionOutlineResults(parts, opts.fillColor);
  if (u) return finish(u.pathD, u.fillRule || (anyClosed ? 'evenodd' : undefined));
  return finish(parts.map((p) => p.pathD).join(' '), anyClosed ? 'evenodd' : undefined);
}

export type OutlineBuildOpts = {
  /** CSS zoom — reserved for callers; silhouette is not sparsified by zoom. */
  zoom?: number;
};

/**
 * Bake node rotation into path so path-edit anchors match the on-canvas silhouette
 * (path-edit chrome is axis-aligned; leaving angle only on attrs looked “水平”).
 */
function bakeNodeAngleIntoOutline(
  outline: OutlineResult,
  boxW: number,
  boxH: number,
  angleDeg: number
): OutlineResult {
  if (!outline.pathD || Math.abs(angleDeg) < 0.01) return outline;
  const cx = boxW / 2;
  const cy = boxH / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // A command contains radius and flag fields that are not coordinates. The old
  // number-pair regex rotated those fields too, corrupting rounded outlines.
  // Rebuild from the path parser's subpaths so only actual points are transformed.
  const subpaths = samplePathSubpaths(outline.pathD, 0.5);
  if (!subpaths.length) return outline;
  const rotated = subpaths
    .map((sub) => {
      if (!sub.pts.length) return '';
      const points = sub.pts.map(([x, y]) => {
        const dx = x - cx;
        const dy = y - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as const;
      });
      const [first, ...rest] = points;
      const part = `M ${first[0].toFixed(2)} ${first[1].toFixed(2)}${rest
        .map(([x, y]) => ` L ${x.toFixed(2)} ${y.toFixed(2)}`)
        .join('')}`;
      return sub.closed ? `${part} Z` : part;
    })
    .filter(Boolean)
    .join(' ');
  if (!rotated) return outline;
  // The original local bounds no longer describe the rotated path. Let the
  // normal path-bound calculation derive the rotated AABB instead.
  return { ...outline, pathD: rotated, bounds: undefined, bakeAngle: true };
}

function readStrokeLinecap(
  attrs: Record<string, unknown> | undefined,
  shapeType?: string
): CanvasLineCap {
  const raw = attrs?.strokeLinecap;
  if (raw != null) {
    const v = String(raw).toLowerCase();
    if (v === 'butt' || v === 'square' || v === 'round') return v;
  }
  // Match create / stroke panel: pen + line + arrow → butt; pencil → round.
  if (shapeType === 'pencil') return 'round';
  if (shapeType === 'pen' || shapeType === 'line' || shapeType === 'arrow') return 'butt';
  return 'butt';
}

function readStrokeLinejoin(
  attrs: Record<string, unknown> | undefined,
  shapeType?: string
): CanvasLineJoin {
  const raw = attrs?.strokeLinejoin;
  if (raw != null) {
    const v = String(raw).toLowerCase();
    if (v === 'bevel' || v === 'miter' || v === 'round') return v;
  }
  if (shapeType === 'pencil') return 'round';
  if (shapeType === 'pen' || shapeType === 'line' || shapeType === 'arrow') return 'miter';
  return 'miter';
}

function readStrokeMiterLimit(attrs: Record<string, unknown> | undefined): number {
  const raw = attrs?.strokeMiterlimit;
  const n = Number(raw);
  // High default: keep acute pen tips. Only clamp when the node stores a limit.
  if (Number.isFinite(n) && n > 0) return Math.min(1000, Math.max(1, n));
  return 100;
}

/** Simplify a closed contour and hard-cap vertex count for path-edit UX. */
function simplifyClosedPolyline(
  pts: Array<[number, number]>,
  epsilon: number,
  maxPts: number,
  maxEpsilon?: number
): Array<[number, number]> {
  return simplifyClosedPolylineGrow(pts, epsilon, maxPts, maxEpsilon, (ring, eps) =>
    simplifyRdpClosedWasm(ring, eps)
  );
}

function outlineResultToShapeBox(o: OutlineResult): ShapeBox | null {
  if (!o.pathD) return null;
  const bb = o.bounds ?? pathDBounds(o.pathD);
  if (!bb) return null;
  let path = o.pathD;
  if (Math.abs(bb.minX) > 0.01 || Math.abs(bb.minY) > 0.01) {
    // translatePathD subtracts (dx,dy) — same contract as fitOutlineResult.
    const shifted = translatePathD(path, bb.minX, bb.minY);
    if (shifted) path = shifted;
  }
  return {
    left: bb.minX,
    top: bb.minY,
    width: Math.max(1, bb.width),
    height: Math.max(1, bb.height),
    shapeType: 'path',
    path,
  };
}

function unionOutlineResults(parts: OutlineResult[], fillColor: string): OutlineResult | null {
  const boxes = parts.map(outlineResultToShapeBox).filter(Boolean) as ShapeBox[];
  if (!boxes.length) return null;
  if (boxes.length === 1) return parts[0];
  const { result } = computeShapeBoolean(boxes, 'union');
  if (!result?.path) return parts[0];
  // Boolean path is local to the union AABB (origin at result.x/y). Push it back
  // into the same node-local space as `parts` so fitOutlineResult / outlineNodePatch
  // keep the silhouette where the stroke was (arrows used to jump to the box corner).
  let pathD = result.path;
  if (Math.abs(result.x) > 0.01 || Math.abs(result.y) > 0.01) {
    pathD = translatePathD(result.path, -result.x, -result.y) || result.path;
  }
  return {
    pathD,
    closed: true,
    fillColor,
    fillRule: result.fillRule,
  };
}

/** Open centerline + width → closed fill path (path-edit boolean union). */
export function strokeCenterlineToFilledOutline(
  pathD: string,
  strokeWidth: number,
  attrs?: Record<string, unknown>
): OutlineResult | null {
  const raw = String(pathD || '').trim();
  if (!raw) return null;
  return outlineFromSvgStroke({
    pathD: raw,
    strokeWidth,
    linecap: readStrokeLinecap(attrs),
    linejoin: readStrokeLinejoin(attrs),
    miterLimit: readStrokeMiterLimit(attrs),
    fillColor: '#000000',
  });
}

function nodeBoxSize(node: SceneNodeInput): { w: number; h: number } {
  return {
    w: Math.max(1, Number(node.width) || 1),
    h: Math.max(1, Number(node.height) || 1),
  };
}

function nodeStrokeWidth(node: SceneNodeInput, fallback = 2): number {
  return Math.max(
    1,
    Number(
      node.attrs?.['border-width'] ?? fallback
    ) || fallback
  );
}

function nodeStrokeInk(node: SceneNodeInput, fallback = '#333333'): string {
  return String(node.attrs?.['border-color'] || fallback);
}

function nodeFillColor(node: SceneNodeInput, fallback = '#FFFFFF'): string {
  return String(node.attrs?.['fill-color'] || fallback);
}

/** Bake attrs.angle into path so every shape’s path-edit matches the painted silhouette. */
function withBakedNodeAngle(node: SceneNodeInput, outline: OutlineResult | null): OutlineResult | null {
  if (!outline) return null;
  const { w, h } = nodeBoxSize(node);
  return bakeNodeAngleIntoOutline(outline, w, h, Number(node.attrs?.angle) || 0);
}

function outlinePencilLocal(node: SceneNodeInput, _zoom = 1): OutlineResult | null {
  const raw = String(node.attrs?.path || '').trim();
  if (!raw) return null;
  const sw = nodeStrokeWidth(node, 10);
  const brushId = String(node.attrs?.brushStyle || 'vector-ink');
  const ink = nodeStrokeInk(node);
  const linecap = readStrokeLinecap(node.attrs, 'pencil');
  const pts = parseSimplePathPoints(raw);
  if (pts.length < 2) return null;

  // Same silhouette as scene paint (keep Q; no linear flatten / RDP shred).
  const pressures = parsePathPressures(node.attrs?.pathPressure, pts.length);
  const outlineD = pencilInkPathFromPoints(pts, sw, brushId, {
    linecap,
    pressures,
    pressureEnabled: true,
    simplify: false,
  });
  if (!outlineD.trim()) return null;
  return withBakedNodeAngle(node, {
    pathD: outlineD,
    closed: true,
    fillColor: ink,
  });
}

function outlinePenLocal(node: SceneNodeInput, zoom = 1): OutlineResult | null {
  const raw = String(node.attrs?.path || '').trim();
  if (!raw) return null;
  return withBakedNodeAngle(
    node,
    outlineFromSvgStroke({
      pathD: raw,
      strokeWidth: nodeStrokeWidth(node, 2),
      linecap: readStrokeLinecap(node.attrs, 'pen'),
      linejoin: readStrokeLinejoin(node.attrs, 'pen'),
      miterLimit: readStrokeMiterLimit(node.attrs),
      fillColor: nodeStrokeInk(node),
      zoom,
    })
  );
}

/** Horizontal shaft stroke → filled ribbon; rotation baked afterward. */
function outlineLineLocal(node: SceneNodeInput, zoom = 1): OutlineResult | null {
  const { w, h } = nodeBoxSize(node);
  const mid = h / 2;
  return withBakedNodeAngle(
    node,
    outlineFromSvgStroke({
      pathD: `M 0 ${mid} L ${w} ${mid}`,
      strokeWidth: nodeStrokeWidth(node, 2),
      linecap: readStrokeLinecap(node.attrs, 'line'),
      linejoin: readStrokeLinejoin(node.attrs, 'line'),
      miterLimit: readStrokeMiterLimit(node.attrs),
      fillColor: nodeStrokeInk(node),
      zoom,
    })
  );
}

/** Shaft + V head (multi-subpath stroke) → one silhouette; rotation baked afterward. */
function outlineArrowLocal(node: SceneNodeInput, zoom = 1): OutlineResult | null {
  const { w, h } = nodeBoxSize(node);
  const d = getShapeBaselineD({
    key: 'shape',
    width: w,
    height: h,
    attrs: { ...(node.attrs || {}), shapeType: 'arrow' },
  });
  if (!d) return null;
  return withBakedNodeAngle(
    node,
    outlineFromSvgStroke({
      pathD: d,
      strokeWidth: nodeStrokeWidth(node, 2),
      linecap: readStrokeLinecap(node.attrs, 'arrow'),
      linejoin: readStrokeLinejoin(node.attrs, 'arrow'),
      miterLimit: readStrokeMiterLimit(node.attrs),
      fillColor: nodeStrokeInk(node),
      zoom,
    })
  );
}

/** Circle / ellipse fill baseline (inner hole + arc params preserved). */
function outlineCircleLocal(node: SceneNodeInput): OutlineResult | null {
  const { w, h } = nodeBoxSize(node);
  const d =
    getShapeBaselineD({
      key: 'shape',
      width: w,
      height: h,
      attrs: { ...(node.attrs || {}), shapeType: 'circle' },
    }) || ellipsePathD(w, h);
  const fillColor = nodeFillColor(node);
  const fillNone =
    !fillColor ||
    fillColor === 'transparent' ||
    fillColor === 'none' ||
    fillColor === 'rgba(0,0,0,0)';
  const innerRatio = ellipseInnerRatioFromAttrs(node.attrs);
  return withBakedNodeAngle(node, {
    pathD: d,
    closed: true,
    fillColor: fillNone ? undefined : fillColor,
    ...(innerRatio > 1e-4 ? { fillRule: 'evenodd' as const } : null),
    // Donut / arc rings use `A` commands — pair-scan bounds + translatePathD
    // mis-fit the path and detach the selection box from the ink.
    bounds: { minX: 0, minY: 0, width: w, height: h },
  });
}

/**
 * Rect / roundRect fill only — keep SVG stroke on the node (outlineNodePatch).
 * Do NOT densify A-arcs (normalizePathDForEdit); round joins would scallop edges.
 */
function outlineRectLocal(node: SceneNodeInput): OutlineResult | null {
  const { w, h } = nodeBoxSize(node);
  const r = clampCornerRadii(radiiFromAttrs(node.attrs), w, h);
  return withBakedNodeAngle(node, {
    pathD: roundedRectPath(w, h, r),
    closed: true,
    fillColor: nodeFillColor(node),
    // Arc-aware browser getBBox() can report only the first rounded corner.
    // Rect geometry already owns this exact local box, so keep it explicit.
    bounds: { minX: 0, minY: 0, width: w, height: h },
  });
}

/** Triangle / star / polygon fill (rounded vertices kept as A arcs). */
function outlinePolyLocal(node: SceneNodeInput, shapeType: 'triangle' | 'star' | 'polygon'): OutlineResult | null {
  const { w, h } = nodeBoxSize(node);
  const sides = sidesFromAttrs(node.attrs) || DEFAULT_SHAPE_SIDES;
  const pts = shapeVertexPoints(
    shapeType,
    w,
    h,
    clampShapeSides(sides),
    starInnerRatioFromAttrs(node.attrs)
  );
  if (pts.length < 3) return null;
  const vertexRadii = vertexRadiiFromAttrs(node.attrs, pts.length, shapeType);
  const d = roundedPolygonPath(pts, vertexRadii);
  return withBakedNodeAngle(node, {
    pathD: d || `M ${pts.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`,
    closed: true,
    fillColor: nodeFillColor(node),
  });
}

/**
 * Per-shape outline entry — each kind has its own builder so stroke vs fill,
 * multi-subpath arrows, and angle baking stay explicit and consistent.
 */
function outlineShapeLocal(node: SceneNodeInput, zoom = 1): OutlineResult | null {
  const key = node.key;
  let shapeType = String(node.attrs?.shapeType || 'rect');
  if (key === 'ellipse') shapeType = 'circle';
  else if (key === 'rect') shapeType = 'rect';

  switch (shapeType) {
    case 'pencil':
      return outlinePencilLocal(node, zoom);
    case 'pen':
      return outlinePenLocal(node, zoom);
    case 'line':
      return outlineLineLocal(node, zoom);
    case 'arrow':
      return outlineArrowLocal(node, zoom);
    case 'circle':
      return outlineCircleLocal(node);
    case 'rect':
    case 'roundRect':
    case '':
      return outlineRectLocal(node);
    case 'triangle':
      return outlinePolyLocal(node, 'triangle');
    case 'star':
      return outlinePolyLocal(node, 'star');
    case 'polygon':
      return outlinePolyLocal(node, 'polygon');
    default:
      return null;
  }
}

/**
 * Moore-neighborhood contour walker for a binary mask.
 * `region` is true for pixels that belong to the component being traced.
 */
function traceContoursInRegion(
  region: (x: number, y: number) => boolean,
  cw: number,
  ch: number
): Array<Array<[number, number]>> {
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  const visited = new Uint8Array(cw * ch);
  const contours: Array<Array<[number, number]>> = [];

  const floodMark = (sx: number, sy: number) => {
    const stack: Array<[number, number]> = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      const i = y * cw + x;
      if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
      if (visited[i] || !region(x, y)) continue;
      visited[i] = 1;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  };

  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const i = y * cw + x;
      // Left edge of a region component.
      if (visited[i] || !region(x, y) || region(x - 1, y)) continue;

      const sx = x;
      const sy = y;
      const pts: Array<[number, number]> = [];
      let cx = sx;
      let cy = sy;
      let dir = 0;
      const maxSteps = cw * ch * 2;
      for (let step = 0; step < maxSteps; step += 1) {
        pts.push([cx, cy]);
        let found = false;
        for (let k = 0; k < 8; k += 1) {
          const nd = (dir + 6 + k) % 8;
          const nx = cx + dx[nd];
          const ny = cy + dy[nd];
          if (region(nx, ny)) {
            cx = nx;
            cy = ny;
            dir = nd;
            found = true;
            break;
          }
        }
        if (!found) break;
        if (cx === sx && cy === sy && pts.length > 8) break;
      }

      floodMark(sx, sy);
      if (pts.length >= 8) contours.push(pts);
    }
  }

  return contours;
}

/** Mark empty pixels connected to the canvas border (outside / background). */
function markOutsideEmpty(
  solid: (x: number, y: number) => boolean,
  cw: number,
  ch: number
): Uint8Array {
  const outside = new Uint8Array(cw * ch);
  const stack: Array<[number, number]> = [];
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= cw || y >= ch) return;
    const i = y * cw + x;
    if (outside[i] || solid(x, y)) return;
    outside[i] = 1;
    stack.push([x, y]);
  };
  for (let x = 0; x < cw; x += 1) {
    push(x, 0);
    push(x, ch - 1);
  }
  for (let y = 0; y < ch; y += 1) {
    push(0, y);
    push(cw - 1, y);
  }
  while (stack.length) {
    const [x, y] = stack.pop()!;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  return outside;
}

/**
 * Approximate text glyphs as closed paths via canvas alpha contour (CJK / no font file).
 * Prefers WASM `trace_rgba_contours`; JS Moore when WASM is off.
 * Traces each character separately so adjacent CJK glyphs do not merge.
 */
function outlineTextLocal(node: SceneNodeInput): OutlineResult | null {
  if (typeof document === 'undefined') return null;
  const plain = parseNodeText(node.attrs || {}).trim();
  if (!plain) return null;
  const style = parseNodeTextStyle(node.attrs || {});
  const boxW = Math.max(1, Math.round(Number(node.width) || 1));
  const boxH = Math.max(1, Math.round(Number(node.height) || 1));
  const autoSize = String(node.attrs?.autoSize ?? 'true') !== 'false';
  const pad = 4;
  // CJK glyphs are dense — scale 8 keeps counters; 5 shredded thin strokes into
  // hollow tubes after evenodd nest + remesh.
  const isCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(plain);
  const scale = isCjk ? 8 : 12;
  const fontSizeScene = Math.max(1e-3, Number(style.fontSize) || 14);
  const fontSize = fontSizeScene * scale;
  const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const lh = lineHeight * fontSize;
  const letterSpacing = (Number(style.letterSpacing) || 0) * scale;
  const align = String(style.textAlign || 'left');
  const lines = textVisualLines(plain, style, { width: boxW, autoSize });
  // Same CSS face as SVG paint (延用自身) — no substitute stack.
  const family = toFabricFontFamily(style.fontFamily);
  const fontCss = `${style.fontWeight || 400} ${fontSize}px "${family}"`;
  // Scene epsilon scales with fontSize — fixed 0.18 shredded ~1px high-zoom text.
  const simplifyEps = Math.max(0.015, Math.min(0.18, fontSizeScene * 0.045));
  const simplifyCap = Math.max(simplifyEps * 3, simplifyEps + fontSizeScene * 0.08);
  const simplifyMaxPts = isCjk ? 360 : 720;

  const measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || typeof measureCtx.measureText !== 'function') return null;
  measureCtx.font = fontCss;

  const measureLine = (line: string) => {
    if (!letterSpacing) return measureCtx.measureText(line || ' ').width;
    let total = 0;
    const chars = Array.from(line);
    chars.forEach((ch, i) => {
      total += measureCtx.measureText(ch).width;
      if (i < chars.length - 1) total += letterSpacing;
    });
    return total || measureCtx.measureText(' ').width;
  };

  const parts: string[] = [];
  const originY = textVerticalOriginY(
    boxH,
    style.fontSize,
    lineHeight,
    Math.max(1, lines.length)
  );

  const pathDecimals =
    fontSizeScene >= 8 ? 1 : fontSizeScene >= 2 ? 2 : fontSizeScene >= 0.5 ? 3 : 4;
  const fmtPt = (a: number, b: number) =>
    `${a.toFixed(pathDecimals)} ${b.toFixed(pathDecimals)}`;

  const traceChar = (ch: string, destX: number, destY: number) => {
    if (!ch.trim()) return;
    const metrics = measureCtx.measureText(ch);
    const gw = Math.ceil(Math.max(metrics.width, fontSize * 0.4) + pad * 2 * scale);
    const gh = Math.ceil(fontSize * 1.35 + pad * 2 * scale);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(8, gw);
    canvas.height = Math.max(8, gh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    ctx.font = fontCss;
    ctx.fillText(ch, pad * scale, pad * scale);

    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const wasmContours = traceRgbaContoursWasm(data, canvas.width, canvas.height, 20);
    let traced: Array<Array<[number, number]>>;
    if (wasmContours) {
      traced = wasmContours;
    } else {
      const solid = (x: number, y: number) => {
        if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
        return data[(y * canvas.width + x) * 4 + 3] > 20;
      };
      const outside = markOutsideEmpty(solid, canvas.width, canvas.height);
      const outer = traceContoursInRegion(solid, canvas.width, canvas.height);
      const hole = traceContoursInRegion(
        (x, y) => {
          if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return false;
          return !solid(x, y) && !outside[y * canvas.width + x];
        },
        canvas.width,
        canvas.height
      );
      traced = [...outer, ...hole];
    }
    for (const pts of traced) {
      const world: Array<[number, number]> = pts.map(([px, py]) => [
        px / scale - pad + destX,
        py / scale - pad + destY,
      ]);
      const simplified = simplifyClosedPolyline(world, simplifyEps, simplifyMaxPts, simplifyCap);
      if (simplified.length < 3) continue;
      parts.push(`M ${simplified.map(([a, b]) => fmtPt(a, b)).join(' L ')} Z`);
    }
  };

  lines.forEach((line, lineIdx) => {
    const lineW = measureLine(line) / scale;
    let x = 0;
    if (align === 'center') x = (boxW - lineW) / 2;
    else if (align === 'right') x = boxW - lineW;
    const y = originY + (lineIdx * lh) / scale;
    let cx = x;
    const chars: string[] = Array.from(line.length ? line : ' ');
    for (const ch of chars) {
      const cw = measureCtx.measureText(ch).width / scale;
      traceChar(ch, cx, y);
      cx += cw + (letterSpacing ? letterSpacing / scale : 0);
    }
  });

  if (!parts.length) return null;

  return {
    pathD: parts.join(' '),
    closed: true,
    fillColor: String(style.fill || '#333333'),
    fillRule: 'evenodd',
  };
}

/**
 * Canvas alpha 轮廓化（CJK）. Paint on main thread; contour+RDP on geom Worker when possible.
 */
export async function outlineTextLocalAsync(
  node: SceneNodeInput
): Promise<OutlineResult | null> {
  if (typeof document === 'undefined') return null;
  await ensureTextFontsLoaded(node);

  const plain = parseNodeText(node.attrs || {}).trim();
  if (!plain) return null;
  const style = parseNodeTextStyle(node.attrs || {});
  const boxW = Math.max(1, Math.round(Number(node.width) || 1));
  const boxH = Math.max(1, Math.round(Number(node.height) || 1));
  const autoSize = String(node.attrs?.autoSize ?? 'true') !== 'false';
  const pad = 4;
  const isCjk = /[\u3400-\u9fff\uf900-\ufaff]/.test(plain);
  const scale = isCjk ? 8 : 12;
  const fontSizeScene = Math.max(1e-3, Number(style.fontSize) || 14);
  const fontSize = fontSizeScene * scale;
  const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const lh = lineHeight * fontSize;
  const letterSpacing = (Number(style.letterSpacing) || 0) * scale;
  const align = String(style.textAlign || 'left');
  const lines = textVisualLines(plain, style, { width: boxW, autoSize });
  const family = toFabricFontFamily(style.fontFamily);
  const fontCss = `${style.fontWeight || 400} ${fontSize}px "${family}"`;
  const simplifyEps = Math.max(0.015, Math.min(0.18, fontSizeScene * 0.045));
  const simplifyCap = Math.max(simplifyEps * 3, simplifyEps + fontSizeScene * 0.08);
  const simplifyMaxPts = isCjk ? 360 : 720;

  const measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx || typeof measureCtx.measureText !== 'function') {
    return outlineTextLocal(node);
  }
  measureCtx.font = fontCss;

  const measureLine = (line: string) => {
    if (!letterSpacing) return measureCtx.measureText(line || ' ').width;
    let total = 0;
    const chars = Array.from(line);
    chars.forEach((ch, i) => {
      total += measureCtx.measureText(ch).width;
      if (i < chars.length - 1) total += letterSpacing;
    });
    return total || measureCtx.measureText(' ').width;
  };

  const pathDecimals =
    fontSizeScene >= 8 ? 1 : fontSizeScene >= 2 ? 2 : fontSizeScene >= 0.5 ? 3 : 4;
  const fmtPt = (a: number, b: number) =>
    `${a.toFixed(pathDecimals)} ${b.toFixed(pathDecimals)}`;

  const originY = textVerticalOriginY(
    boxH,
    style.fontSize,
    lineHeight,
    Math.max(1, lines.length)
  );

  const parts: string[] = [];
  let workerOk = true;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    const lineW = measureLine(line) / scale;
    let cx =
      align === 'center'
        ? (boxW - lineW) / 2
        : align === 'right'
          ? boxW - lineW
          : 0;
    const y = originY + (lineIdx * lh) / scale;
    const chars: string[] = Array.from(line.length ? line : ' ');
    for (const ch of chars) {
      const cw = measureCtx.measureText(ch).width / scale;
      if (ch.trim() && workerOk) {
        const metrics = measureCtx.measureText(ch);
        const gw = Math.ceil(Math.max(metrics.width, fontSize * 0.4) + pad * 2 * scale);
        const gh = Math.ceil(fontSize * 1.35 + pad * 2 * scale);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(8, gw);
        canvas.height = Math.max(8, gh);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#000';
          ctx.textBaseline = 'top';
          ctx.font = fontCss;
          ctx.fillText(ch, pad * scale, pad * scale);
          const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const rings = await textGlyphOutlineAsync({
            rgba: data,
            width: canvas.width,
            height: canvas.height,
            alphaThreshold: 20,
            // Worker traces in pixel space — convert scene eps → pixels.
            simplifyEps: simplifyEps * scale,
            simplifyMaxPts,
            simplifyCap: simplifyCap * scale,
          });
          if (rings == null) {
            workerOk = false;
          } else {
            for (const pts of rings) {
              const world: Array<[number, number]> = pts.map(([px, py]) => [
                px / scale - pad + cx,
                py / scale - pad + y,
              ]);
              if (world.length < 3) continue;
              parts.push(`M ${world.map(([a, b]) => fmtPt(a, b)).join(' L ')} Z`);
            }
          }
        }
      }
      cx += cw + (letterSpacing ? letterSpacing / scale : 0);
    }
  }

  if (!workerOk) return outlineTextLocal(node);
  if (!parts.length) return null;
  return {
    pathD: parts.join(' '),
    closed: true,
    fillColor: String(style.fill || '#333333'),
    fillRule: 'evenodd',
  };
}

/** Normalize outline into node-local top-left space + tight bounds. */
function fitOutlineResult(result: OutlineResult): OutlineResult | null {
  if (!result?.pathD) return null;
  const explicit = result.bounds;
  const bounds = explicit ?? pathDBounds(result.pathD);
  if (!bounds) return result;
  const needShift = Math.abs(bounds.minX) > 0.01 || Math.abs(bounds.minY) > 0.01;
  const shifted = needShift
    ? translatePathD(result.pathD, bounds.minX, bounds.minY)
    : result.pathD;
  if (shifted != null) {
    return {
      ...result,
      pathD: shifted,
      bounds: {
        minX: bounds.minX,
        minY: bounds.minY,
        width: bounds.width,
        height: bounds.height,
      },
    };
  }
  if (explicit) {
    return {
      ...result,
      bounds: {
        minX: explicit.minX,
        minY: explicit.minY,
        width: explicit.width,
        height: explicit.height,
      },
    };
  }
  return {
    ...result,
    bounds: {
      minX: 0,
      minY: 0,
      width: Math.max(bounds.width + bounds.minX, 1),
      height: Math.max(bounds.height + bounds.minY, 1),
    },
  };
}

/** Build local-space outline path for a node (sync; text requires async fontkit). */
export function buildOutlinePath(node: SceneNodeInput, opts?: OutlineBuildOpts): OutlineResult | null {
  if (!canOutlineNode(node)) return null;
  // Text: only `buildOutlinePathAsync` (fontkit). No sync canvas downgrade.
  if (node.key === 'text') return null;
  const zoom = resolveOutlineZoom(opts?.zoom);
  return fitOutlineResult(outlineShapeLocal(node, zoom) as OutlineResult);
}

/** Ensure the CSS face used for canvas tracing is ready (avoids empty / tofu outlines). */
async function ensureTextFontsLoaded(node: SceneNodeInput): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts?.load) return;
  try {
    const style = parseNodeTextStyle(node.attrs || {});
    const family = toFabricFontFamily(style.fontFamily || 'sans-serif');
    const size = Math.max(1, Number(style.fontSize) || 14);
    const weight = style.fontWeight || 400;
    const css = `${weight} ${size}px "${family}"`;
    const load = document.fonts.load(css);
    // Never await unbounded `fonts.ready` — a pending catalog face can stall Outline forever.
    await Promise.race([
      load,
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2500);
      }),
    ]);
  } catch {
    /* ignore — canvas still attempts with whatever is available */
  }
}

/**
 * Text outline: fontkit glyph paths when available; else canvas trace of the painted face.
 */
export async function buildOutlinePathAsync(
  node: SceneNodeInput,
  opts?: OutlineBuildOpts
): Promise<OutlineResult | null> {
  if (!canOutlineNode(node)) return null;
  const zoom = resolveOutlineZoom(opts?.zoom);
  if (node.key === 'text') {
    try {
      const { outlineTextFromFont } = await import('@/components/rcb/scene/paint/outlineTextFont');
      const fromFont = await outlineTextFromFont(node);
      if (fromFont?.pathD) return fitOutlineResult(fromFont);
    } catch (err) {
      console.warn('[outline] fontkit outline failed', err);
    }
    try {
      const fromCanvas = await outlineTextLocalAsync(node);
      if (fromCanvas?.pathD) return fitOutlineResult(fromCanvas);
    } catch (err) {
      console.warn('[outline] canvas text outline failed', err);
    }
    return null;
  }
  try {
    return fitOutlineResult(outlineShapeLocal(node, zoom) as OutlineResult);
  } catch (err) {
    console.warn('[outline] shape outline failed', err);
    return null;
  }
}

function resolveOutlineZoom(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.15, Math.min(8, explicit));
  }
  return Math.max(0.15, Math.min(8, getInfiniteSvgPaintZoom() || 1));
}

/** Attrs + geometry patch after outline — keeps paint, switches to editable path. */
export function outlineNodePatch(node: SceneNodeInput, outline: OutlineResult) {
  const prev = { ...(node.attrs || {}) };
  const fill =
    outline.fillColor ||
    String(prev['fill-color'] || '#FFFFFF');
  delete prev.sides;
  delete prev.ORIGIN_DATA;
  delete prev.DATA;
  delete prev.markdown;
  delete prev.brushStyle;
  delete prev.d;
  // Radius / side-stroke are baked into path geometry (or unsupported on path).
  // Leaving them makes filletPathD re-round densified verts and confuse stroke.
  delete prev.radius;
  delete prev.radiusTL;
  delete prev.radiusTR;
  delete prev.radiusBR;
  delete prev.radiusBL;
  delete prev.radiusLinked;
  delete prev.cornerRadius;
  delete prev.rx;
  delete prev.ry;
  delete prev.L;
  delete prev.R;
  delete prev.T;
  delete prev.B;
  delete prev.radiusVertices;

  const b = outline.bounds;
  const left = Number(node.x ?? node.left ?? 0) + (b?.minX ?? 0);
  const top = Number(node.y ?? node.top ?? 0) + (b?.minY ?? 0);
  const width = b ? Math.max(1, b.width) : Math.max(1, Number(node.width) || 1);
  const height = b ? Math.max(1, b.height) : Math.max(1, Number(node.height) || 1);

  const shapeType = String(node.attrs?.shapeType || node.key || 'rect');
  // Stroke-ink tools bake the ribbon into fill — disable SVG stroke to avoid a
  // double outline. Filled shapes (rect / polygon / …) keep their border paint.
  const strokeBakedIntoFill =
    shapeType === 'pen' ||
    shapeType === 'pencil' ||
    shapeType === 'line' ||
    shapeType === 'arrow' ||
    node.key === 'text';
  if (strokeBakedIntoFill) {
    // Disable SVG stroke so paint is fill-only — but keep border-width so the
    // style panel still shows the original thickness (geometry holds the ink).
    prev['stroke-enabled'] = 'false';
    prev['stroke-visible'] = 'false';
  } else {
    // Keep original stroke state — don't invent a border after outlining.
    const prevStrokeOn = String(prev['stroke-enabled'] ?? 'true') !== 'false';
    const prevBw = Number(prev['border-width'] ?? 0);
    if (!prevStrokeOn || !(prevBw > 0)) {
      prev['stroke-enabled'] = 'false';
      prev['stroke-visible'] = 'false';
      prev['border-width'] = 0;
    }
    // Keep strokeAlign as-is (do not force center — outside→center looks thinner).
  }
  // Rotation baked into pathD for every shape (line/arrow/rect/…).
  if (outline.bakeAngle) {
    prev.angle = 0;
  }
  const fillNone =
    !fill ||
    fill === 'transparent' ||
    fill === 'none' ||
    fill === 'rgba(0,0,0,0)';
  if (fillNone) {
    prev['fill-enabled'] = 'false';
    prev['fill-visible'] = 'false';
  }
  if (outline.fillRule) {
    prev['fill-rule'] = outline.fillRule;
  }

  return {
    key: 'shape' as const,
    x: left,
    y: top,
    width,
    height,
    attrs: {
      ...prev,
      shapeType: 'path',
      // Mark 轮廓化 / densified silhouette — no R-dots or toolbar radius.
      outlined: 'true',
      path: outline.pathD,
      closed: outline.closed ? 'true' : 'false',
      'fill-color': fillNone ? 'transparent' : fill,
      'fill-type': String(prev['fill-type'] || 'solid'),
      'fill-enabled': fillNone ? 'false' : 'true',
      'fill-visible': fillNone ? 'false' : 'true',
    },
  };
}

/**
 * Fire after outline so canvas can open path-edit chrome.
 * Prefer not calling after 轮廓化: path-edit force-hides the host on dense silhouettes.
 * Users enter path-edit manually (dblclick / toolbar) when they want anchors.
 */
export function requestEnterPathEdit(
  nodeId: string,
  pathD?: string,
  opts?: { fromStrokeOutline?: boolean }
) {
  if (typeof window === 'undefined' || !nodeId) return;
  if (opts?.fromStrokeOutline) return;
  const d = pathD != null ? String(pathD) : '';
  if (d.length >= HEAVY_PATH_D_CHARS) return;
  if (d) {
    const rings = d.split(/(?=[Mm])/).filter((s) => s.trim()).length;
    if (rings >= 4) return;
    const vertApprox = (d.match(/[MLQCmlqc]/g) || []).length;
    const closedRibbon = /z\s*$/i.test(d.trim());
    if (vertApprox > 64) return;
    if (closedRibbon && vertApprox > 24) return;
  }
  queueMicrotask(() => {
    window.dispatchEvent(
      new CustomEvent('resume:enter-path-edit', { detail: { nodeId } })
    );
  });
}
