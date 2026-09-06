/**
 * Stroke → triangle list. Default join is miter (matches attrs / Canvas).
 * Bevel only when miterLength/half exceeds miterLimit — never always-bevel
 * (that clipped star tips and square corners flat).
 *
 * `edges` is per-vertex signed side across the ribbon (±1 at rims, 0 on the
 * centerline) for mesh fragment-shader AA (same idea as kind-2 vUv.y).
 */
import type { Vec2 } from '@/components/rcb/render/vector/contour';

export type StrokeMesh = {
  positions: Float32Array;
  /** Parallel to positions (one float per vertex). */
  edges: Float32Array;
  triangleCount: number;
};

export type StrokeTessOpts = {
  width: number;
  closed?: boolean;
  /** 'center' | 'inside' | 'outside' */
  align?: string;
  /** Default 'miter' — product attrs / Canvas. */
  linejoin?: 'miter' | 'round' | 'bevel';
  /** Default 100 — keep acute tips (see resolveStrokeMiterlimit). */
  miterLimit?: number;
  /** Open ends only — 'butt' | 'round' | 'square' (default butt). */
  linecap?: 'butt' | 'round' | 'square' | string;
};

type SegOff = {
  l0: Vec2;
  r0: Vec2;
  l1: Vec2;
  r1: Vec2;
  n: Vec2;
};

function leftNormal(dx: number, dy: number): Vec2 {
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

function strokeBias(align: string, half: number): number {
  // Full shift: inside/outside put the entire ribbon on one side of the path
  // (matches Canvas 2× + clip/fill semantics). ±0.5*half only half-shifted —
  // UI inside/outside looked almost like center.
  if (align === 'inside') return -half;
  if (align === 'outside') return half;
  return 0;
}

function closePolylineIfNeeded(points: Vec2[], closed: boolean): Vec2[] {
  const pts = points.slice();
  if (!closed || pts.length <= 2) return pts;
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  if (Math.abs(a.x - b.x) > 1e-5 || Math.abs(a.y - b.y) > 1e-5) pts.push({ ...a });
  return pts;
}

function pushTri(
  tris: number[],
  edges: number[],
  ax: number,
  ay: number,
  ea: number,
  bx: number,
  by: number,
  eb: number,
  cx: number,
  cy: number,
  ec: number
) {
  tris.push(ax, ay, bx, by, cx, cy);
  edges.push(ea, eb, ec);
}

function pushQuad(tris: number[], edges: number[], s: SegOff) {
  // Four tris sharing the centerline (edge=0). Avoids a two-triangle diagonal
  // where fwidth(edge) discontinuities look like a mid-shaft hole at high zoom.
  // Pair with coverage-preserving MESH_FS (no low-cover discard).
  const c0x = (s.l0.x + s.r0.x) * 0.5;
  const c0y = (s.l0.y + s.r0.y) * 0.5;
  const c1x = (s.l1.x + s.r1.x) * 0.5;
  const c1y = (s.l1.y + s.r1.y) * 0.5;
  pushTri(tris, edges, s.l0.x, s.l0.y, -1, c0x, c0y, 0, s.l1.x, s.l1.y, -1);
  pushTri(tris, edges, s.l1.x, s.l1.y, -1, c0x, c0y, 0, c1x, c1y, 0);
  pushTri(tris, edges, c0x, c0y, 0, s.r0.x, s.r0.y, 1, c1x, c1y, 0);
  pushTri(tris, edges, c1x, c1y, 0, s.r0.x, s.r0.y, 1, s.r1.x, s.r1.y, 1);
}

function pushBevelWedges(tris: number[], edges: number[], cur: Vec2, a: SegOff, b: SegOff) {
  pushTri(tris, edges, cur.x, cur.y, 0, a.l1.x, a.l1.y, -1, b.l0.x, b.l0.y, -1);
  pushTri(tris, edges, cur.x, cur.y, 0, a.r1.x, a.r1.y, 1, b.r0.x, b.r0.y, 1);
}

/**
 * Round join: fan on the side that actually has stroke extent.
 * Inside align puts the whole ribbon on the right (hr); outside on the left (hl).
 * Geometric “outer” alone fails for inside — hl≈0 so the fan was invisible.
 */
function pushRoundJoin(
  tris: number[],
  edges: number[],
  cur: Vec2,
  a: SegOff,
  b: SegOff,
  hl: number,
  hr: number
) {
  const cross = a.n.x * b.n.y - a.n.y * b.n.x;
  let roundLeft: boolean;
  if (hl > hr + 1e-6) roundLeft = true;
  else if (hr > hl + 1e-6) roundLeft = false;
  else roundLeft = cross < 0;
  if (roundLeft) {
    pushTri(tris, edges, cur.x, cur.y, 0, a.r1.x, a.r1.y, 1, b.r0.x, b.r0.y, 1);
    fanOuterArc(tris, edges, cur, a.l1, b.l0, Math.max(hl, 1e-4), -1);
  } else {
    pushTri(tris, edges, cur.x, cur.y, 0, a.l1.x, a.l1.y, -1, b.l0.x, b.l0.y, -1);
    fanOuterArc(tris, edges, cur, a.r1, b.r0, Math.max(hr, 1e-4), 1);
  }
}

function fanOuterArc(
  tris: number[],
  edges: number[],
  cur: Vec2,
  from: Vec2,
  to: Vec2,
  radius: number,
  rimEdge: number
) {
  let a0 = Math.atan2(from.y - cur.y, from.x - cur.x);
  let a1 = Math.atan2(to.y - cur.y, to.x - cur.x);
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  const steps = Math.max(2, Math.min(24, Math.ceil((Math.abs(d) * radius) / Math.max(0.5, radius * 0.35))));
  let prev = from;
  for (let s = 1; s <= steps; s += 1) {
    const t = s / steps;
    const ang = a0 + d * t;
    const p = {
      x: cur.x + Math.cos(ang) * radius,
      y: cur.y + Math.sin(ang) * radius,
    };
    if (s === steps) {
      p.x = to.x;
      p.y = to.y;
    }
    pushTri(tris, edges, cur.x, cur.y, 0, prev.x, prev.y, rimEdge, p.x, p.y, rimEdge);
    prev = p;
  }
}

/**
 * Try miter tip at `cur`. Returns null → caller keeps segment butts + bevel wedges.
 */
function tryMiterTips(
  cur: Vec2,
  n0: Vec2,
  n1: Vec2,
  hl: number,
  hr: number,
  miterLimit: number
): { left: Vec2; right: Vec2 } | null {
  let mx = n0.x + n1.x;
  let my = n0.y + n1.y;
  const mlen = Math.hypot(mx, my);
  if (mlen < 1e-8) return null;
  mx /= mlen;
  my /= mlen;
  const den = mx * n0.x + my * n0.y;
  if (Math.abs(den) < 1e-6) return null;
  const scaleL = hl / den;
  const scaleR = hr / den;
  // Canvas: miterLength / (lineWidth/2) > miterLimit → bevel.
  if (Math.abs(scaleL) > hl * miterLimit + 1e-6) return null;
  if (Math.abs(scaleR) > hr * miterLimit + 1e-6) return null;
  return {
    left: { x: cur.x + mx * scaleL, y: cur.y + my * scaleL },
    right: { x: cur.x - mx * scaleR, y: cur.y - my * scaleR },
  };
}

export function tessellateStroke(points: Vec2[], opts: StrokeTessOpts): StrokeMesh | null {
  const w = Math.max(0, Number(opts.width) || 0);
  if (!(w > 0) || points.length < 2) return null;

  const closed = Boolean(opts.closed);
  const half = w * 0.5;
  const bias = strokeBias(String(opts.align || 'center').toLowerCase(), half);
  const hl = half + bias;
  const hr = half - bias;
  const join = String(opts.linejoin || 'miter').toLowerCase();
  const wantMiter = join === 'miter';
  const wantRound = join === 'round';
  const miterLimit = Math.max(1, Number(opts.miterLimit) || 100);

  const pts = closePolylineIfNeeded(points, closed);
  const n = pts.length;
  if (n < 2) return null;

  const segs: SegOff[] = [];
  for (let i = 0; i + 1 < n; i += 1) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const nor = leftNormal(b.x - a.x, b.y - a.y);
    segs.push({
      n: nor,
      l0: { x: a.x + nor.x * hl, y: a.y + nor.y * hl },
      r0: { x: a.x - nor.x * hr, y: a.y - nor.y * hr },
      l1: { x: b.x + nor.x * hl, y: b.y + nor.y * hl },
      r1: { x: b.x - nor.x * hr, y: b.y - nor.y * hr },
    });
  }
  if (!segs.length) return null;

  const tris: number[] = [];
  const edges: number[] = [];
  const joinCount = segs.length - (closed ? 0 : 1);

  for (let j = 0; j < joinCount; j += 1) {
    const aIdx = j;
    const bIdx = closed ? (j + 1) % segs.length : j + 1;
    if (bIdx >= segs.length) break;
    const a = segs[aIdx]!;
    const b = segs[bIdx]!;
    const cur = pts[closed && bIdx === 0 ? 0 : aIdx + 1]!;
    // Vertex between seg a and seg b.
    if (wantMiter) {
      const tips = tryMiterTips(cur, a.n, b.n, hl, hr, miterLimit);
      if (tips) {
        a.l1 = tips.left;
        a.r1 = tips.right;
        b.l0 = tips.left;
        b.r0 = tips.right;
        continue;
      }
    }
    if (wantRound) {
      pushRoundJoin(tris, edges, cur, a, b, hl, hr);
      continue;
    }
    pushBevelWedges(tris, edges, cur, a, b);
  }

  for (const s of segs) pushQuad(tris, edges, s);

  if (!closed && segs.length) {
    const cap = String(opts.linecap || 'butt').toLowerCase();
    const rad = Math.max(hl, hr, 1e-4);
    if (cap === 'round' || cap === 'square') {
      const first = segs[0]!;
      const last = segs[segs.length - 1]!;
      const a0 = pts[0]!;
      const a1 = pts[1]!;
      const b0 = pts[pts.length - 2]!;
      const b1 = pts[pts.length - 1]!;
      const t0len = Math.hypot(a1.x - a0.x, a1.y - a0.y) || 1;
      const t1len = Math.hypot(b1.x - b0.x, b1.y - b0.y) || 1;
      const out0 = { x: -(a1.x - a0.x) / t0len, y: -(a1.y - a0.y) / t0len };
      const out1 = { x: (b1.x - b0.x) / t1len, y: (b1.y - b0.y) / t1len };
      if (cap === 'square') {
        pushSquareCap(tris, edges, first.l0, first.r0, a0, out0, rad);
        pushSquareCap(tris, edges, last.l1, last.r1, b1, out1, rad);
      } else {
        // Semicircle: fan the diameter rim through the outward tip.
        pushRoundCap(tris, edges, a0, first.l0, first.r0, out0, rad);
        pushRoundCap(tris, edges, b1, last.r1, last.l1, out1, rad);
      }
    }
  }

  if (tris.length < 6) return null;
  return {
    positions: new Float32Array(tris),
    edges: new Float32Array(edges),
    triangleCount: tris.length / 6,
  };
}

function pushSquareCap(
  tris: number[],
  edges: number[],
  left: Vec2,
  right: Vec2,
  center: Vec2,
  outward: Vec2,
  radius: number
) {
  const ox = outward.x * radius;
  const oy = outward.y * radius;
  const l2 = { x: left.x + ox, y: left.y + oy };
  const r2 = { x: right.x + ox, y: right.y + oy };
  const c2 = { x: center.x + ox, y: center.y + oy };
  // Two quads as four tris (rim edges ±1, centerline 0).
  pushTri(tris, edges, left.x, left.y, -1, c2.x, c2.y, 0, l2.x, l2.y, -1);
  pushTri(tris, edges, left.x, left.y, -1, center.x, center.y, 0, c2.x, c2.y, 0);
  pushTri(tris, edges, right.x, right.y, 1, r2.x, r2.y, 1, c2.x, c2.y, 0);
  pushTri(tris, edges, right.x, right.y, 1, c2.x, c2.y, 0, center.x, center.y, 0);
}

function pushRoundCap(
  tris: number[],
  edges: number[],
  center: Vec2,
  from: Vec2,
  to: Vec2,
  outward: Vec2,
  radius: number
) {
  const tip = {
    x: center.x + outward.x * radius,
    y: center.y + outward.y * radius,
  };
  // Two quarter-arcs: from → tip → to (always the outward hemisphere).
  fanOuterArc(tris, edges, center, from, tip, radius, -1);
  fanOuterArc(tris, edges, center, tip, to, radius, 1);
}
