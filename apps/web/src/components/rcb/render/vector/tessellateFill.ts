/**
 * Ear-clip fill triangulation.
 * Holes: prefer WASM boolean difference, else polygon-clipping.
 */
import polygonClipping from 'polygon-clipping';
import type { Vec2 } from '@/components/rcb/render/vector/contour';
import { booleanPolygonsWasm } from '@/components/rcb/render/vector/wasmGeom';

export type FillMesh = {
  positions: Float32Array;
  triangleCount: number;
};

function area(poly: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    a += poly[j]!.x * poly[i]!.y - poly[i]!.x * poly[j]!.y;
  }
  return a * 0.5;
}

function isConvex(a: Vec2, b: Vec2, c: Vec2, ccw: boolean): boolean {
  const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  return ccw ? cross > 1e-12 : cross < -1e-12;
}

function pointInTri(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const v0x = c.x - a.x;
  const v0y = c.y - a.y;
  const v1x = b.x - a.x;
  const v1y = b.y - a.y;
  const v2x = p.x - a.x;
  const v2y = p.y - a.y;
  const dot00 = v0x * v0x + v0y * v0y;
  const dot01 = v0x * v1x + v0y * v1y;
  const dot02 = v0x * v2x + v0y * v2y;
  const dot11 = v1x * v1x + v1y * v1y;
  const dot12 = v1x * v2x + v1y * v2y;
  const inv = 1 / (dot00 * dot11 - dot01 * dot01 + 1e-20);
  const u = (dot11 * dot02 - dot01 * dot12) * inv;
  const v = (dot00 * dot12 - dot01 * dot02) * inv;
  return u >= 0 && v >= 0 && u + v <= 1;
}

function cleanRing(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.y - p.y) < 1e-6) continue;
    out.push(p);
  }
  if (out.length <= 2) return out;
  const a = out[0]!;
  const b = out[out.length - 1]!;
  if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) out.pop();
  return out;
}

function ringIsConvex(ring: Vec2[], ccw: boolean): boolean {
  for (let i = 0; i < ring.length; i += 1) {
    const prev = ring[(i - 1 + ring.length) % ring.length]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    if (!isConvex(prev, cur, next, ccw)) return false;
  }
  return true;
}

function fanTris(ring: Vec2[]): number[] {
  const tris: number[] = [];
  const o = ring[0]!;
  for (let i = 1; i + 1 < ring.length; i += 1) {
    tris.push(o.x, o.y, ring[i]!.x, ring[i]!.y, ring[i + 1]!.x, ring[i + 1]!.y);
  }
  return tris;
}

function earclipTris(ring: Vec2[], ccw: boolean): number[] {
  const tris: number[] = [];
  const idx = ring.map((_, i) => i);
  let guard = ring.length * ring.length + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i += 1) {
      const i0 = idx[(i - 1 + idx.length) % idx.length]!;
      const i1 = idx[i]!;
      const i2 = idx[(i + 1) % idx.length]!;
      const a0 = ring[i0]!;
      const a1 = ring[i1]!;
      const a2 = ring[i2]!;
      if (!isConvex(a0, a1, a2, ccw)) continue;
      let ear = true;
      for (const k of idx) {
        if (k === i0 || k === i1 || k === i2) continue;
        if (pointInTri(ring[k]!, a0, a1, a2)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      tris.push(a0.x, a0.y, a1.x, a1.y, a2.x, a2.y);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) {
    const a0 = ring[idx[0]!]!;
    const a1 = ring[idx[1]!]!;
    const a2 = ring[idx[2]!]!;
    tris.push(a0.x, a0.y, a1.x, a1.y, a2.x, a2.y);
  }
  return tris;
}

function meshFromTris(tris: number[]): FillMesh | null {
  if (tris.length < 6) return null;
  return { positions: new Float32Array(tris), triangleCount: tris.length / 6 };
}

export function tessellateFill(points: Vec2[]): FillMesh | null {
  const ring = cleanRing(points);
  if (ring.length < 3) return null;
  const a = area(ring);
  if (Math.abs(a) < 1e-10) return null;
  const ccw = a > 0;
  const tris = ringIsConvex(ring, ccw) ? fanTris(ring) : earclipTris(ring, ccw);
  return meshFromTris(tris);
}

function toClosedRing(pts: Vec2[]): Array<[number, number]> {
  const r: Array<[number, number]> = pts.map((p) => [p.x, p.y]);
  const a = r[0]!;
  const b = r[r.length - 1]!;
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
  return r;
}

function appendMeshPositions(dst: number[], mesh: FillMesh): void {
  for (let i = 0; i < mesh.positions.length; i += 1) dst.push(mesh.positions[i]!);
}

/**
 * Cut a hairline channel from outside the AABB into the hole so the donut
 * becomes a single simple ring (ear-clip safe). Avoids zero-area keyhole bridges.
 */
function openHoleWithSlit(
  poly: Array<Array<[number, number]>>
): Array<Array<Array<[number, number]>>> {
  if (poly.length < 2) return [poly];
  const outer = poly[0]!;
  const hole = poly[1]!;
  if (!outer?.length || !hole?.length) return [poly];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of outer) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  let hx = 0;
  let hy = 0;
  for (const [x, y] of hole) {
    hx += x;
    hy += y;
  }
  hx /= hole.length;
  hy /= hole.length;

  // Find hole point closest to the left exterior (short horizontal slit).
  let best = hole[0]!;
  let bestD = Infinity;
  for (const p of hole) {
    const d = (p[0]! - minX) * (p[0]! - minX) + (p[1]! - hy) * (p[1]! - hy);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  const span = Math.max(1, maxX - minX, maxY - minY);
  const eps = Math.max(1e-3, span * 1e-5);
  const x0 = minX - Math.max(1, span * 0.02);
  const slit: Array<Array<[number, number]>> = [
    [
      [x0, best[1]! - eps],
      [best[0]! + eps, best[1]! - eps],
      [best[0]! + eps, best[1]! + eps],
      [x0, best[1]! + eps],
      [x0, best[1]! - eps],
    ],
  ];
  try {
    const opened = polygonClipping.difference([poly], [slit]);
    if (opened?.length) return opened;
  } catch {
    /* fall through */
  }
  return [poly];
}

/**
 * Outer + holes → difference → open slits with a slit → ear-clip.
 */
export function tessellateFillWithHoles(
  outer: Vec2[],
  holes: Vec2[][]
): FillMesh | null {
  const outerRing = cleanRing(outer);
  if (outerRing.length < 3) return null;
  if (!holes.length) return tessellateFill(outerRing);

  let geom: Array<Array<Array<[number, number]>>> = [[toClosedRing(outerRing)]];
  for (const hole of holes) {
    const h = cleanRing(hole);
    if (h.length < 3) continue;
    const clipHole: Array<Array<[number, number]>> = [toClosedRing(h)];
    // polygon-clipping is the reliable hole path. WASM boolean can return an
    // empty multipolygon on dense glyph rings → skeletal / blank text fills.
    let next: typeof geom | null = null;
    try {
      next = polygonClipping.difference(geom, [clipHole]);
    } catch {
      next = null;
    }
    if (next == null || next.length === 0) {
      // Last resort: WASM fold (pairwise only).
      if (geom.length === 1 && geom[0]) {
        const wasmNext = booleanPolygonsWasm('difference', [geom[0], clipHole]);
        if (wasmNext != null && wasmNext.length > 0) next = wasmNext;
      }
    }
    if (next != null && next.length > 0) geom = next;
  }

  // Turn leftover hole rings into simple C-rings before ear-clip.
  const opened: typeof geom = [];
  for (const poly of geom) {
    if (poly.length > 1) opened.push(...openHoleWithSlit(poly));
    else opened.push(poly);
  }

  const tris: number[] = [];
  for (const poly of opened) {
    if (!poly.length) continue;
    // Prefer the outer ring; if a slit left nested rings, keep differencing via slit
    // until a single ring remains (cap iterations).
    let rings = poly;
    let guard = 4;
    while (rings.length > 1 && guard-- > 0) {
      const next = openHoleWithSlit(rings);
      rings = next[0] ?? rings.slice(0, 1);
      if (next.length > 1) {
        // Extra islands — tessellate separately below by flattening.
        for (let i = 1; i < next.length; i += 1) opened.push(next[i]!);
      }
    }
    const outerPts = rings[0]!.slice(0, -1).map(([x, y]) => ({ x, y }));
    const mesh = tessellateFill(outerPts);
    if (mesh) appendMeshPositions(tris, mesh);
  }
  return meshFromTris(tris);
}
