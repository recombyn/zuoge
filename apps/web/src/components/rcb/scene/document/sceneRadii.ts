import type { SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/** Shared independent corner-radius helpers for scene nodes. */

import {
  clampShapeSides,
  DEFAULT_SHAPE_SIDES,
  shapeVertexPoints,
  sidesFromAttrs,
  starInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';

export type CornerRadii = { tl: number; tr: number; br: number; bl: number };
export type CornerKey = keyof CornerRadii;

/** Per-vertex editors stay usable; denser paths keep uniform R only. */
export const MAX_EDITABLE_CORNER_VERTICES = 24;

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function isRadiusLinked(attrs: Record<string, unknown> | null | undefined): boolean {
  return attrs?.radiusLinked !== false && attrs?.radiusLinked !== 'false';
}

/** Parse `radiusVertices` ("12,0,8,…" or number[]). */
export function parseRadiusVertices(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.map((v) => Math.max(0, Math.round(Number(v) || 0)));
  }
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((v) => Math.max(0, Math.round(Number(v) || 0)));
}

export function serializeRadiusVertices(rs: number[]): string {
  return rs.map((v) => Math.max(0, Math.round(Number(v) || 0))).join(',');
}

/** Signed polygon area (shoelace). Sign = winding (CCW > 0 in Y-down scene too). */
function ringSignedArea(ring: Array<[number, number]>): number {
  const n = ring.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a * 0.5;
}

/** Absolute area for picking the exterior ring. */
function ringPolygonArea(ring: Array<[number, number]>): number {
  return Math.abs(ringSignedArea(ring));
}

/**
 * Convex relative to ring winding (left turn for CCW, right for CW).
 * Dense curve polylines after path-edit / outline are full of concave
 * micro-notches — those used to get R-dots parked outside the fill, and a
 * linked drag filleted them into self-intersecting mush.
 */
function isConvexRingVertex(
  prev: [number, number],
  curr: [number, number],
  next: [number, number],
  ccw: boolean
): boolean {
  const cross =
    (curr[0] - prev[0]) * (next[1] - curr[1]) - (curr[1] - prev[1]) * (next[0] - curr[0]);
  return ccw ? cross > 1e-9 : cross < -1e-9;
}

/** Exterior / primary ring — largest area (not vertex count; holes are denser). */
export function primaryClosedPathRingIndex(rings: Array<Array<[number, number]>>): number {
  if (rings.length <= 1) return 0;
  let best = 0;
  let bestA = ringPolygonArea(rings[0]);
  for (let i = 1; i < rings.length; i += 1) {
    const a = ringPolygonArea(rings[i]);
    if (a > bestA) {
      best = i;
      bestA = a;
    }
  }
  return best;
}

/**
 * How many fillet-able corners a node has (rect=4, path=sharp verts only…).
 */
export function cornerVertexCount(node: SceneNodeInput): number {
  if (!node) return 4;
  const key = String(node.key || '');
  const t = String(node.attrs?.shapeType || (key === 'path' ? 'path' : key) || 'rect');
  if (t === 'triangle') return 3;
  if (t === 'star') return clampShapeSides(sidesFromAttrs(node.attrs), DEFAULT_SHAPE_SIDES) * 2;
  if (t === 'polygon') return sidesFromAttrs(node.attrs);
  if (t === 'path' || t === 'pen' || key === 'path') {
    const rings = parseClosedPathRings(String(node.attrs?.path || ''));
    if (!rings.length) return 4;
    let n = 0;
    for (const ring of rings) {
      n += sharpCornerIndices(ring).length;
      if (n >= MAX_EDITABLE_CORNER_VERTICES) {
        return MAX_EDITABLE_CORNER_VERTICES;
      }
    }
    if (n > 0) return n;
    const primary = rings[primaryClosedPathRingIndex(rings)];
    return Math.max(1, Math.min(primary.length, 4));
  }
  if (
    t === 'rect' ||
    t === 'roundRect' ||
    t === '' ||
    key === 'rect' ||
    key === 'image' ||
    key === 'video' ||
    key === 'audio'
  ) {
    return 4;
  }
  return 4;
}

/** Minimum turn (deg from straight) to treat a polyline vertex as a real corner. */
const SHARP_CORNER_MIN_DEG = 32;
/** Dense arc polylines (boolean crescents): only cusps should get R dots. */
const SHARP_CORNER_DENSE_MIN_DEG = 48;
/** ≥ this many verts ⇒ treat as densified curve, raise turn threshold. */
const SHARP_CORNER_DENSE_VERT_COUNT = 24;

/**
 * Turn away from a straight line at `curr` (0 = collinear, 90 = right angle).
 * Vectors are from the vertex toward its neighbors.
 */
export function vertexTurnDegrees(
  prev: [number, number],
  curr: [number, number],
  next: [number, number]
): number {
  const v1x = prev[0] - curr[0];
  const v1y = prev[1] - curr[1];
  const v2x = next[0] - curr[0];
  const v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y) || 1;
  const len2 = Math.hypot(v2x, v2y) || 1;
  const dot = (v1x / len1) * (v2x / len2) + (v1y / len1) * (v2y / len2);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
  return ((Math.PI - ang) * 180) / Math.PI;
}

/**
 * Edge length from corner `i` along `dir`, merging near-colinear stubs.
 * Boolean rings often leave 1–2 micro verts on an AABB edge before a real
 * mouth fold; measuring only the last stub made those folds look “short”
 * and dropped their R-dots.
 */
function edgeLenSkippingColinear(
  points: Array<[number, number]>,
  edgeLens: number[],
  cornerIndex: number,
  dir: 1 | -1
): number {
  const n = points.length;
  const colinearDeg = 3;
  const maxHops = 4;
  let len = 0;
  let at = cornerIndex;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const edgeIdx = dir === 1 ? at : (at - 1 + n) % n;
    len += edgeLens[edgeIdx];
    const nxt = (at + dir + n) % n;
    const after = (nxt + dir + n) % n;
    // Far vertex still on the same line → absorb the next stub.
    if (vertexTurnDegrees(points[at], points[nxt], points[after]) >= colinearDeg) break;
    at = nxt;
  }
  return len;
}

/**
 * Indices of real corners on a closed polyline.
 * Skips dense curve samples and line→arc joins (one long edge + one short
 * chord). Those joins used to get handles but barely move when R is large,
 * because fillet clamps to half the short edge — looking “stuck” while true
 * corners round a lot.
 *
 * Sparse rings (boolean leftovers / simple polygons): only drop micro-edges —
 * `maxEdge * 0.08` was wiping real corners that sit on a long AABB side next
 * to a shorter edge (missing R-dots on the flush side).
 *
 * Edge lengths skip near-colinear stubs so a notch mouth on the AABB edge
 * still counts as a real corner even when the last segment is tiny.
 */
export function sharpCornerIndices(points: Array<[number, number]>): number[] {
  const n = points.length;
  if (n < 3) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const edgeLens: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const [x, y] = points[i];
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    const next = points[(i + 1) % n];
    edgeLens.push(Math.hypot(next[0] - x, next[1] - y));
  }
  const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
  const maxEdge = Math.max(...edgeLens, 1);
  const dense = n >= SHARP_CORNER_DENSE_VERT_COUNT;
  // Dense: chord filter keeps arc micro-stubs out, but must not discard real
  // junction edges (boolean intersection points near a straight side).
  // Use diag-fraction only — arc turn < minTurn already guards smooth samples.
  const minCornerEdge = dense
    ? Math.max(diag * 0.01, maxEdge * 0.03)
    : Math.max(1e-4, diag * 0.002);
  const minTurn = dense ? SHARP_CORNER_DENSE_MIN_DEG : SHARP_CORNER_MIN_DEG;
  // Dense outlines from curve/path-edit densify: only convex tips. Concave
  // valleys park R-dots outside the silhouette and linked fillet destroys the path.
  const ccw = dense ? ringSignedArea(points) >= 0 : true;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const turn = vertexTurnDegrees(prev, curr, next);
    if (turn < minTurn) continue;
    const len1 = edgeLenSkippingColinear(points, edgeLens, i, -1);
    const len2 = edgeLenSkippingColinear(points, edgeLens, i, 1);
    if (len1 < minCornerEdge || len2 < minCornerEdge) continue;
    if (dense && !isConvexRingVertex(prev, curr, next, ccw)) continue;
    out.push(i);
  }
  return out;
}

export type SharpCornerSite = {
  /** Index in the sharp-corner list (maps to radiusVertices[i]). */
  sharpIndex: number;
  /** Index in the polyline ring. */
  ringIndex: number;
  x: number;
  y: number;
  /** Inward unit (angle bisector) in local path space. */
  ix: number;
  iy: number;
  /**
   * Max fillet R for this corner alone (adjacent edges × tan(α/2)).
   * Drag / seat range must use this — not the node AABB half-min — so small
   * hole corners cannot be dragged to the outer stadium's min(w,h)/2.
   */
  maxR: number;
};

/** Geometry for a tangent fillet at one polyline corner. */
export function filletCornerMetric(
  prev: [number, number],
  curr: [number, number],
  next: [number, number]
): { len1: number; len2: number; tanHalf: number; maxR: number } {
  const v1x = prev[0] - curr[0];
  const v1y = prev[1] - curr[1];
  const v2x = next[0] - curr[0];
  const v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y) || 1;
  const len2 = Math.hypot(v2x, v2y) || 1;
  const dot = Math.max(
    -1,
    Math.min(1, (v1x / len1) * (v2x / len2) + (v1y / len1) * (v2y / len2))
  );
  const alpha = Math.acos(dot);
  const tanHalfRaw = Math.tan(alpha / 2);
  const tanHalf = tanHalfRaw > 1e-6 && Number.isFinite(tanHalfRaw) ? tanHalfRaw : 0;
  const maxR = tanHalf > 0 ? Math.min(len1, len2) * tanHalf : 0;
  return { len1, len2, tanHalf, maxR };
}

function unitEdgeBisector(
  prev: [number, number],
  curr: [number, number],
  next: [number, number]
): { ix: number; iy: number } {
  const v1x = prev[0] - curr[0];
  const v1y = prev[1] - curr[1];
  const v2x = next[0] - curr[0];
  const v2y = next[1] - curr[1];
  const len1 = Math.hypot(v1x, v1y) || 1;
  const len2 = Math.hypot(v2x, v2y) || 1;
  let ix = v1x / len1 + v2x / len2;
  let iy = v1y / len1 + v2y / len2;
  const len = Math.hypot(ix, iy);
  if (len < 1e-6) return { ix: 1, iy: 0 };
  return { ix: ix / len, iy: iy / len };
}

/**
 * R-dot sites on one closed ring.
 * Park along the corner's ≤180° angle bisector (no centroid flip):
 * convex tips → into the fold / fill; concave valleys → into the exterior notch.
 * Forcing every site toward the ring centroid parked valleys deep inside stars.
 * `sharpIndex` is the flat radiusVertices index.
 */
function sitesFromClosedRing(
  ring: Array<[number, number]>,
  opts: {
    startSharpIndex: number;
    budget: number;
    /** Geo star/polygon/triangle: every vert is a fold. */
    useAllVerts?: boolean;
  }
): SharpCornerSite[] {
  if (ring.length < 3 || opts.budget <= 0) return [];
  const sharp = opts.useAllVerts
    ? ring.map((_, i) => i).slice(0, opts.budget)
    : sharpCornerIndices(ring).slice(0, opts.budget);
  if (!sharp.length) return [];
  const n = ring.length;
  return sharp.map((ringIndex, j) => {
    const prev = ring[(ringIndex - 1 + n) % n];
    const curr = ring[ringIndex];
    const next = ring[(ringIndex + 1) % n];
    const { ix, iy } = unitEdgeBisector(prev, curr, next);
    const { maxR } = filletCornerMetric(prev, curr, next);
    return {
      sharpIndex: opts.startSharpIndex + j,
      ringIndex,
      x: curr[0],
      y: curr[1],
      ix,
      iy,
      maxR,
    };
  });
}

/**
 * Sharp corner handle sites (local geom coords).
 * Paths: exterior + hole sharp verts (boolean cutouts). Geo star/polygon/triangle:
 * every vertex. Returns null for rect-like shapes that keep AABB corner handles.
 */
export function sharpCornerSitesForNode(node: SceneNodeInput): SharpCornerSite[] | null {
  if (!node) return null;
  const key = String(node.key || '');
  const t = String(node.attrs?.shapeType || (key === 'path' ? 'path' : key) || 'rect');

  if (t === 'path' || key === 'path') {
    const rings = parseClosedPathRings(String(node.attrs?.path || ''));
    if (!rings.length) return null;
    const primaryIdx = primaryClosedPathRingIndex(rings);
    const order = [
      primaryIdx,
      ...rings.map((_, i) => i).filter((i) => i !== primaryIdx),
    ];
    const sites: SharpCornerSite[] = [];
    for (const ri of order) {
      const budget = MAX_EDITABLE_CORNER_VERTICES - sites.length;
      if (budget <= 0) break;
      sites.push(
        ...sitesFromClosedRing(rings[ri], {
          startSharpIndex: sites.length,
          budget,
        })
      );
    }
    return sites.length ? sites : null;
  }

  if (t === 'star' || t === 'polygon' || t === 'triangle') {
    const w = Math.max(1, Number(node.width) || 1);
    const h = Math.max(1, Number(node.height) || 1);
    const sides = clampShapeSides(sidesFromAttrs(node.attrs), DEFAULT_SHAPE_SIDES);
    const pts = shapeVertexPoints(
      t,
      w,
      h,
      sides,
      starInnerRatioFromAttrs(node.attrs)
    );
    if (pts.length < 3) return null;
    const sites = sitesFromClosedRing(pts, {
      startSharpIndex: 0,
      budget: MAX_EDITABLE_CORNER_VERTICES,
      useAllVerts: true,
    });
    return sites.length ? sites : null;
  }

  return null;
}

/**
 * Per-vertex radii for polygon / path fillet.
 * Prefers `radiusVertices` when present; otherwise maps the 4 rect corners.
 */
export function vertexRadiiFromAttrs(
  attrs: Record<string, unknown> | null | undefined,
  pointCount: number,
  shapeHint?: string
): number[] {
  if (pointCount <= 0) return [];
  const corners = radiiFromAttrs(attrs);
  const linked = isRadiusLinked(attrs);
  const stored = parseRadiusVertices(attrs?.radiusVertices);

  if (linked) {
    const u = stored.length
      ? stored.reduce((a, b) => a + b, 0) / stored.length
      : (corners.tl + corners.tr + corners.br + corners.bl) / 4;
    const v = Math.max(0, Math.round(u));
    return Array.from({ length: pointCount }, () => v);
  }

  if (stored.length === pointCount) {
    return stored.map((v) => Math.max(0, v));
  }
  if (stored.length > 0) {
    return Array.from({ length: pointCount }, (_, i) =>
      Math.max(0, stored[i] ?? stored[stored.length - 1] ?? 0)
    );
  }
  return polygonRadiiFromCorners(pointCount, corners, shapeHint);
}

export function radiiFromAttrs(attrs: Record<string, unknown> | null | undefined): CornerRadii {
  const linked = isRadiusLinked(attrs);
  const hasCornerAttrs =
    attrs?.radiusTL != null ||
    attrs?.radiusTR != null ||
    attrs?.radiusBR != null ||
    attrs?.radiusBL != null;
  // Uniform keys: `radius`, `cornerRadius`, SVG `rx`/`ry`.
  const uniform = num(
    attrs?.radius ?? attrs?.cornerRadius ?? attrs?.rx ?? attrs?.ry,
    NaN
  );
  const stored = parseRadiusVertices(attrs?.radiusVertices);
  // Factories often seed radiusTL…=0 with a positive uniform cornerRadius.
  // When linked and every corner is zero, prefer the uniform value.
  if (
    linked &&
    Number.isFinite(uniform) &&
    uniform > 0 &&
    num(attrs?.radiusTL, 0) === 0 &&
    num(attrs?.radiusTR, 0) === 0 &&
    num(attrs?.radiusBR, 0) === 0 &&
    num(attrs?.radiusBL, 0) === 0
  ) {
    return { tl: uniform, tr: uniform, br: uniform, bl: uniform };
  }
  // Prefer per-corner attrs whenever present (toolbar / stroke panel).
  // Fall back to uniform `radius` only when corner keys are absent.
  if (hasCornerAttrs || !linked || !Number.isFinite(uniform)) {
    let fallback = 0;
    if (Number.isFinite(uniform)) fallback = uniform;
    else if (stored.length) fallback = stored.reduce((a, b) => a + b, 0) / stored.length;
    return {
      tl: Math.max(0, num(attrs?.radiusTL, stored[0] ?? fallback)),
      tr: Math.max(0, num(attrs?.radiusTR, stored[1] ?? fallback)),
      br: Math.max(0, num(attrs?.radiusBR, stored[2] ?? fallback)),
      bl: Math.max(0, num(attrs?.radiusBL, stored[3] ?? fallback)),
    };
  }
  return { tl: uniform, tr: uniform, br: uniform, bl: uniform };
}

export function clampCornerRadii(r: CornerRadii, width: number, height: number): CornerRadii {
  const w = Math.max(width, 1);
  const h = Math.max(height, 1);
  const maxR = Math.min(w, h) / 2;
  return {
    tl: Math.min(Math.max(0, r.tl), maxR),
    tr: Math.min(Math.max(0, r.tr), maxR),
    br: Math.min(Math.max(0, r.br), maxR),
    bl: Math.min(Math.max(0, r.bl), maxR),
  };
}

/** SVG path for a rect with independent corner radii (local 0,0). */
export function roundedRectPath(w: number, h: number, r: CornerRadii) {
  const width = Math.max(w, 1);
  const height = Math.max(h, 1);
  const c = clampCornerRadii(r, width, height);
  const { tl, tr, br, bl } = c;
  return [
    `M ${tl} 0`,
    `H ${width - tr}`,
    tr ? `A ${tr} ${tr} 0 0 1 ${width} ${tr}` : `L ${width} 0`,
    `V ${height - br}`,
    br ? `A ${br} ${br} 0 0 1 ${width - br} ${height}` : `L ${width} ${height}`,
    `H ${bl}`,
    bl ? `A ${bl} ${bl} 0 0 1 0 ${height - bl}` : `L 0 ${height}`,
    `V ${tl}`,
    tl ? `A ${tl} ${tl} 0 0 1 ${tl} 0` : `L 0 0`,
    'Z',
  ].join(' ');
}

export function maxRadius(r: CornerRadii) {
  return Math.max(r.tl, r.tr, r.br, r.bl, 0);
}

/**
 * Parse closed M/L(/H/V)Z path(s) into rings (local coords).
 * Used for boolean results and other polyline paths.
 * Curves (C/Q/A/…) abort → [] so callers skip R-dots / fillet (must not
 * treat command letters as coordinates — that parked dots in empty space).
 */
export function parseClosedPathRings(d: string): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  // Split ALL SVG path letters so C/Q/A are not left as bare tokens under an
  // implicit L command (Number('C')===0 produced ghost verts after 曲线编辑).
  const tokens = String(d || '')
    .replace(/,/g, ' ')
    .replace(/([MmLlHhVvCcQqSsTtAaZz])/g, ' $1 ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let i = 0;
  let cmd = 'M';
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let ring: Array<[number, number]> = [];

  const readNum = () => {
    if (i >= tokens.length) return NaN;
    // Never swallow a command letter as 0 — that invented off-path R sites.
    if (/^[A-Za-z]$/.test(tokens[i])) return NaN;
    const n = Number(tokens[i]);
    i += 1;
    return Number.isFinite(n) ? n : NaN;
  };

  const pushRing = () => {
    if (ring.length < 2) {
      ring = [];
      return;
    }
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first[0] === last[0] && first[1] === last[1]) {
      ring = ring.slice(0, -1);
    }
    if (ring.length >= 3) rings.push(ring);
    ring = [];
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z]$/.test(t)) {
      // Polyline-only parser — any curve command means “no sharp R sites”.
      if (!/^[MmLlHhVvZz]$/.test(t)) return [];
      cmd = t;
      i += 1;
      if (cmd === 'Z' || cmd === 'z') {
        pushRing();
        cx = startX;
        cy = startY;
        continue;
      }
      if ((cmd === 'M' || cmd === 'm') && ring.length) {
        pushRing();
      }
    }

    if (cmd === 'M' || cmd === 'L') {
      const x = readNum();
      const y = readNum();
      if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
      cx = x;
      cy = y;
      if (cmd === 'M') {
        startX = x;
        startY = y;
      }
      ring.push([x, y]);
      cmd = cmd === 'M' ? 'L' : cmd;
      continue;
    }
    if (cmd === 'm' || cmd === 'l') {
      const dx = readNum();
      const dy = readNum();
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [];
      const x = cx + dx;
      const y = cy + dy;
      cx = x;
      cy = y;
      if (cmd === 'm') {
        startX = x;
        startY = y;
      }
      ring.push([x, y]);
      cmd = cmd === 'm' ? 'l' : cmd;
      continue;
    }
    if (cmd === 'H') {
      const x = readNum();
      if (!Number.isFinite(x)) return [];
      cx = x;
      ring.push([cx, cy]);
      continue;
    }
    if (cmd === 'h') {
      const dx = readNum();
      if (!Number.isFinite(dx)) return [];
      cx += dx;
      ring.push([cx, cy]);
      continue;
    }
    if (cmd === 'V') {
      const y = readNum();
      if (!Number.isFinite(y)) return [];
      cy = y;
      ring.push([cx, cy]);
      continue;
    }
    if (cmd === 'v') {
      const dy = readNum();
      if (!Number.isFinite(dy)) return [];
      cy += dy;
      ring.push([cx, cy]);
      continue;
    }
    // Unsupported command — abort so caller keeps the original path.
    return [];
  }
  if (ring.length >= 3) pushRing();
  return rings;
}

/**
 * Fillet sharp corners of a closed polyline path (exterior + holes).
 * Falls back to `d` when the path cannot be parsed (curves, etc.).
 * `radiusVertices` is a flat list: primary-ring sharps, then each hole's sharps
 * (same order as {@link sharpCornerSitesForNode}).
 * Only real corners are filleted — arc / curve samples stay smooth.
 */
export function filletPathD(
  d: string,
  r: CornerRadii,
  attrs?: Record<string, unknown> | null
): string {
  const raw = String(d || '');
  if (!raw) return raw;
  const rings = parseClosedPathRings(raw);
  if (!rings.length) return raw;
  const effectiveAttrs: Record<string, unknown> = attrs
    ? { ...attrs }
    : {
        radiusTL: r.tl,
        radiusTR: r.tr,
        radiusBR: r.br,
        radiusBL: r.bl,
        radiusLinked: 'true',
      };
  const primaryIdx = primaryClosedPathRingIndex(rings);
  const order = [
    primaryIdx,
    ...rings.map((_, i) => i).filter((i) => i !== primaryIdx),
  ];
  const sharpByRing = order.map((ri) => sharpCornerIndices(rings[ri]));
  const totalSharp = sharpByRing.reduce((n, s) => n + s.length, 0);
  const flat =
    totalSharp > 0
      ? vertexRadiiFromAttrs(effectiveAttrs, totalSharp, 'path')
      : [];

  let offset = 0;
  let out = '';
  let anyFillet = false;
  for (let oi = 0; oi < order.length; oi += 1) {
    const ring = rings[order[oi]];
    const sharp = sharpByRing[oi];
    const full = ring.map(() => 0);
    for (let j = 0; j < sharp.length; j += 1) {
      full[sharp[j]] = flat[offset + j] ?? 0;
    }
    offset += sharp.length;
    if (full.some((v) => v >= 0.5)) {
      out += roundedPolygonPath(ring, full);
      anyFillet = true;
    } else {
      out += `M ${ring.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
    }
  }
  return anyFillet ? out || raw : raw;
}

/**
 * Painted closed-path `d` (boolean / path nodes) — same fillet as pathPaintD.
 * Sharp base + radius* attrs → filleted silhouette for Canvas/WebGL idle ink.
 */
export function pathPaintDFromAttrs(
  attrs: Record<string, unknown> | null | undefined,
  opts?: { shapeType?: string; skipFillet?: boolean }
): string {
  const a = attrs || {};
  const baseD = String(a.path || '').trim();
  if (!baseD) return '';
  const shapeType = String(opts?.shapeType || a.shapeType || 'path').toLowerCase();
  if (opts?.skipFillet || shapeType === 'pen' || shapeType === 'pencil') return baseD;
  const closed =
    a.closed === true ||
    a.closed === 'true' ||
    a.closed === 1 ||
    a.closed === '1' ||
    /\sZ\s*$/i.test(baseD);
  if (!closed) return baseD;
  const outlined = a.outlined === true || a.outlined === 'true' || a.outlined === 1 || a.outlined === '1';
  if (outlined) return baseD;
  const cornerR = radiiFromAttrs(a);
  if (maxRadius(cornerR) <= 0.5) return baseD;
  return filletPathD(baseD, cornerR, a);
}

/**
 * Rounded polygon path. `radii[i]` fillets vertex `points[i]`.
 * Soft curve-sample vertices are forced to 0 even if radii says otherwise.
 *
 * Tangent fillet: offset along each edge is `r / tan(α/2)` (α = angle between
 * edges). Using offset=`r` is only correct for 90° — elsewhere the arc is not
 * tangent and the corner “bulges” or kinks at the join.
 * Radii are clamped so adjacent offsets never consume more than an edge.
 */
export function roundedPolygonPath(
  points: Array<[number, number]>,
  radii: number[] | number
): string {
  const n = points.length;
  if (n < 3) return '';
  const sharp = new Set(sharpCornerIndices(points));
  let rs = points.map((_, i) => {
    const raw = Math.max(0, typeof radii === 'number' ? radii : Number(radii[i] ?? 0) || 0);
    // Path arc densification: never fillet non-corners.
    if (sharp.size > 0 && !sharp.has(i)) return 0;
    return raw;
  });
  if (rs.every((r) => r < 0.5)) {
    return `M ${points.map(([x, y]) => `${x} ${y}`).join(' L ')} Z`;
  }

  const len1s: number[] = [];
  const len2s: number[] = [];
  const tanHalfs: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const m = filletCornerMetric(prev, curr, next);
    len1s.push(m.len1);
    len2s.push(m.len2);
    tanHalfs.push(m.tanHalf);
    if (!(m.tanHalf > 0) || rs[i] < 0.5) {
      rs[i] = 0;
      continue;
    }
    // offset = r / tan(α/2) must fit on both adjacent edges.
    rs[i] = Math.min(rs[i], m.maxR);
  }

  // Shared-edge budget on tangent offsets (not raw r — acute corners offset > r).
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const edge = Math.hypot(points[j][0] - points[i][0], points[j][1] - points[i][1]) || 1;
    const oi = tanHalfs[i] > 0 ? rs[i] / tanHalfs[i] : 0;
    const oj = tanHalfs[j] > 0 ? rs[j] / tanHalfs[j] : 0;
    if (oi + oj > edge && oi + oj > 1e-6) {
      const scale = edge / (oi + oj);
      rs[i] *= scale;
      rs[j] *= scale;
    }
  }

  const parts: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const v1x = prev[0] - curr[0];
    const v1y = prev[1] - curr[1];
    const v2x = next[0] - curr[0];
    const v2y = next[1] - curr[1];
    const len1 = len1s[i];
    const len2 = len2s[i];
    const r = rs[i];
    const ux1 = v1x / len1;
    const uy1 = v1y / len1;
    const ux2 = v2x / len2;
    const uy2 = v2y / len2;
    const tanHalf = tanHalfs[i];
    const offset = r > 0.5 && tanHalf > 0 ? r / tanHalf : 0;
    const p1x = curr[0] + ux1 * offset;
    const p1y = curr[1] + uy1 * offset;
    const p2x = curr[0] + ux2 * offset;
    const p2y = curr[1] + uy2 * offset;

    if (i === 0) parts.push(`M ${p1x} ${p1y}`);
    else parts.push(`L ${p1x} ${p1y}`);

    if (r > 0.5 && offset > 0) {
      const cross = v1x * v2y - v1y * v2x;
      const dot = ux1 * ux2 + uy1 * uy2;
      // Near-collinear: skip arc, keep sharp.
      if (dot > 0.999 || dot < -0.999) {
        parts.push(`L ${curr[0]} ${curr[1]}`);
        parts.push(`L ${p2x} ${p2y}`);
      } else {
        const sweep = cross < 0 ? 1 : 0;
        parts.push(`A ${r} ${r} 0 0 ${sweep} ${p2x} ${p2y}`);
      }
    } else {
      parts.push(`L ${curr[0]} ${curr[1]}`);
      parts.push(`L ${p2x} ${p2y}`);
    }
  }
  parts.push('Z');
  return parts.join(' ');
}

/** Map rect corner radii onto polygon vertices (best-effort). */
export function polygonRadiiFromCorners(
  pointCount: number,
  r: CornerRadii,
  shapeHint?: string
): number[] {
  const c = r;
  if (pointCount <= 0) return [];
  if (pointCount === 3 || shapeHint === 'triangle') {
    return [Math.max(c.tl, c.tr), c.br, c.bl];
  }
  if (pointCount === 4) {
    return [c.tl, c.tr, c.br, c.bl];
  }
  const u = (c.tl + c.tr + c.br + c.bl) / 4;
  return Array.from({ length: pointCount }, () => u);
}

/**
 * Live corner-radius while knob-dragging (DOM preview only — editor store stays idle
 * mid-drag to avoid remount ghosts). Toolbars subscribe for the compact R label.
 */
type LiveCornerRadiusPreview = {
  nodeId: string;
  display: number;
  radii: CornerRadii;
};

let liveCornerRadiusPreview: LiveCornerRadiusPreview | null = null;
const liveCornerRadiusListeners = new Set<() => void>();

export function cornerRadiusToolbarDisplay(
  attrs: Record<string, unknown> | null | undefined
): number {
  const r = radiiFromAttrs(attrs);
  if (isRadiusLinked(attrs)) return Math.round(r.tl);
  return Math.round(maxRadius(r));
}

export function cornerRadiusDisplayFromRadii(radii: CornerRadii, linked: boolean): number {
  if (linked) return Math.round(radii.tl);
  return Math.round(maxRadius(radii));
}

export function setLiveCornerRadiusPreview(next: LiveCornerRadiusPreview | null) {
  const prev = liveCornerRadiusPreview;
  if (
    prev?.nodeId === next?.nodeId &&
    prev?.display === next?.display &&
    prev?.radii.tl === next?.radii.tl &&
    prev?.radii.tr === next?.radii.tr &&
    prev?.radii.br === next?.radii.br &&
    prev?.radii.bl === next?.radii.bl
  ) {
    return;
  }
  if (prev == null && next == null) return;
  liveCornerRadiusPreview = next;
  liveCornerRadiusListeners.forEach((l) => l());
}

export function hasLiveCornerRadiusPreview(): boolean {
  return liveCornerRadiusPreview != null;
}

export function getLiveCornerRadiusPreviewNodeId(): string | null {
  return liveCornerRadiusPreview?.nodeId ?? null;
}

export function getLiveCornerRadiusPreviewRadii(nodeId: string): CornerRadii | null {
  if (!nodeId || liveCornerRadiusPreview?.nodeId !== nodeId) return null;
  return liveCornerRadiusPreview.radii;
}

/**
 * Overlay live corner-radius preview onto attrs for Kit / DomHost paint.
 * Document attrs stay idle mid-drag; paint callers merge here.
 */
export function mergeLiveCornerRadiiIntoAttrs(
  nodeId: string,
  attrs: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  const base = attrs ? { ...attrs } : {};
  const live = getLiveCornerRadiusPreviewRadii(nodeId);
  if (!live) return base;
  const avg = (live.tl + live.tr + live.br + live.bl) / 4;
  return {
    ...base,
    radiusTL: live.tl,
    radiusTR: live.tr,
    radiusBR: live.br,
    radiusBL: live.bl,
    // Fingerprint / legacy aliases
    tl: live.tl,
    tr: live.tr,
    br: live.br,
    bl: live.bl,
    radius: avg,
    cornerRadius: avg,
  };
}

export function getLiveCornerRadiusPreview(nodeId: string): number | null {
  if (!nodeId || liveCornerRadiusPreview?.nodeId !== nodeId) return null;
  return liveCornerRadiusPreview.display;
}

export function subscribeLiveCornerRadiusPreview(onStoreChange: () => void): () => void {
  liveCornerRadiusListeners.add(onStoreChange);
  return () => {
    liveCornerRadiusListeners.delete(onStoreChange);
  };
}
