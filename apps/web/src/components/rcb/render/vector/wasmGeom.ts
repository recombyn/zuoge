/**
 * WASM geom adapter — densify, tessellate, boolean, offset, RDP, contour.
 * Lazy-loads `packages/rcb-wasm-geom`; each export falls back to JS when unavailable.
 */
import type { Vec2 } from '@/components/rcb/render/vector/contour';
import { densifyPathDJs, DENSIFY_DEFAULT_FLATNESS, splitPolylineContours } from '@/components/rcb/render/vector/densifyPathDJs';
import {
  tessellateFill as tessellateFillJs,
  tessellateFillWithHoles as tessellateFillWithHolesJs,
  type FillMesh,
} from '@/components/rcb/render/vector/tessellateFill';
import {
  tessellateStroke as tessellateStrokeJs,
  type StrokeMesh,
  type StrokeTessOpts,
} from '@/components/rcb/render/vector/tessellateStroke';
import {
  closePolylineForDash,
  splitPolylineByDash,
} from '@/components/rcb/render/vector/strokeDash';
import {
  geomNow,
  isGeomProfileEnabled,
  recordGeomProfile,
} from '@/components/rcb/render/vector/geomProfile';

export type WasmGeomBackend = 'js' | 'wasm';

type WasmApi = {
  densify_path_d: (d: string, flatness: number) => Float32Array;
  tessellate_fill: (xy: Float32Array) => Float32Array;
  tessellate_fill_with_holes: (
    outer: Float32Array,
    holesFlat: Float32Array,
    holeCounts: Uint32Array
  ) => Float32Array;
  tessellate_stroke: (
    xy: Float32Array,
    width: number,
    closed: boolean,
    align: string,
    linejoin?: string,
    miterLimit?: number
  ) => Float32Array;
  tessellate_batch_fill: (xyAll: Float32Array, counts: Uint32Array) => Float32Array;
  boolean_polygons?: (op: number, packed: Float32Array) => Float32Array;
  offset_polyline?: (
    xy: Float32Array,
    width: number,
    closed: boolean,
    join: number,
    cap: number,
    miterLimit: number,
    roundApprox: number
  ) => Float32Array;
  simplify_rdp?: (xy: Float32Array, epsilon: number) => Float32Array;
  simplify_rdp_closed?: (xy: Float32Array, epsilon: number) => Float32Array;
  trace_rgba_contours?: (
    rgba: Uint8Array,
    width: number,
    height: number,
    alphaThreshold: number
  ) => Float32Array;
};

/** polygon-clipping-compatible rings (may or may not repeat the first point). */
export type BoolRing = Array<[number, number]>;
export type BoolPolygon = BoolRing[];
export type BoolMultiPolygon = BoolPolygon[];
export type BoolPolygonOp = 'union' | 'difference' | 'intersection' | 'xor';

const BOOL_OP_CODE: Record<BoolPolygonOp, number> = {
  union: 0,
  difference: 1,
  intersection: 2,
  xor: 3,
};

let api: WasmApi | null = null;
let initPromise: Promise<boolean> | null = null;
let forceJs = false;

function wasmLive(): boolean {
  return Boolean(api) && !forceJs;
}

function queryDisablesWasm(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).get('rcb_wasm') === '0';
  } catch {
    return false;
  }
}

export function setWasmGeomForceJs(on: boolean): void {
  forceJs = Boolean(on);
  if (!forceJs) return;
  api = null;
  initPromise = null;
}

export function getWasmGeomBackend(): WasmGeomBackend {
  return wasmLive() ? 'wasm' : 'js';
}

export function isWasmGeomReady(): boolean {
  return wasmLive();
}

function pointsToFlat(points: Vec2[]): Float32Array {
  const out = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    out[i * 2] = points[i]!.x;
    out[i * 2 + 1] = points[i]!.y;
  }
  return out;
}

function flatToPoints(xy: ArrayLike<number>): Vec2[] {
  const n = Math.floor(xy.length / 2);
  const out: Vec2[] = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = { x: Number(xy[i * 2]), y: Number(xy[i * 2 + 1]) };
  }
  return out;
}

function meshFromFlat(flat: ArrayLike<number>): FillMesh | null {
  if (flat.length < 6) return null;
  const positions =
    flat instanceof Float32Array ? flat.slice() : new Float32Array(flat);
  return { positions, triangleCount: positions.length / 6 };
}

/**
 * Unpack WASM stroke: interleaved x,y,edge (3 floats/vert). Legacy packs that
 * are only x,y pairs fall back to positions without edges (caller may JS-AA).
 */
function strokeMeshFromWasmFlat(flat: ArrayLike<number>): StrokeMesh | null {
  if (flat.length < 9) return null;
  // Edged format length is multiple of 3 and not of 2-only legacy (ambiguous
  // when both divide — prefer edged when len%3===0 && (len/3)%3===0).
  const asEdged = flat.length % 3 === 0 && (flat.length / 3) % 3 === 0;
  if (asEdged) {
    const n = flat.length / 3;
    const positions = new Float32Array(n * 2);
    const edges = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      positions[i * 2] = Number(flat[i * 3]);
      positions[i * 2 + 1] = Number(flat[i * 3 + 1]);
      edges[i] = Number(flat[i * 3 + 2]);
    }
    return { positions, edges, triangleCount: n / 3 };
  }
  if (flat.length % 2 !== 0 || flat.length < 6) return null;
  // Legacy positions-only — synthesize ±1 rim edges from triangle winding is
  // unreliable; return null so JS tessellator owns AA.
  return null;
}

function packHoles(holes: Vec2[][]): { flat: Float32Array; counts: Uint32Array } {
  const counts: number[] = [];
  const xy: number[] = [];
  for (const h of holes) {
    if (h.length < 3) continue;
    counts.push(h.length);
    for (const p of h) xy.push(p.x, p.y);
  }
  return { flat: new Float32Array(xy), counts: new Uint32Array(counts) };
}

function unpackBatch(packed: Float32Array): (FillMesh | null)[] {
  const out: (FillMesh | null)[] = [];
  let i = 0;
  while (i < packed.length) {
    const n = packed[i++]! | 0;
    if (n <= 0) {
      out.push(null);
      continue;
    }
    out.push(meshFromFlat(packed.subarray(i, i + n)));
    i += n;
  }
  return out;
}

async function loadWasmModule(): Promise<WasmApi | null> {
  try {
    // Served from public/rcb-wasm (copied by build-wasm.mjs) so Vite ships .wasm.
    // Avoid `import('/public/...')` — Vite rejects public JS as bundle imports; runtime fetch via Function.
    const dynamicImport = new Function('u', 'return import(u)') as (
      u: string
    ) => Promise<Record<string, unknown> & { default?: (opts: { module_or_path: string }) => Promise<void> }>;
    const mod = await dynamicImport('/rcb-wasm/rcb_wasm_geom.js');
    if (typeof mod.default === 'function') {
      await mod.default({ module_or_path: '/rcb-wasm/rcb_wasm_geom_bg.wasm' });
    }
    if (
      typeof mod.densify_path_d !== 'function' ||
      typeof mod.tessellate_fill !== 'function' ||
      typeof mod.tessellate_stroke !== 'function'
    ) {
      return null;
    }
    return {
      densify_path_d: mod.densify_path_d as WasmApi['densify_path_d'],
      tessellate_fill: mod.tessellate_fill as WasmApi['tessellate_fill'],
      tessellate_fill_with_holes: mod.tessellate_fill_with_holes as WasmApi['tessellate_fill_with_holes'],
      tessellate_stroke: mod.tessellate_stroke as WasmApi['tessellate_stroke'],
      tessellate_batch_fill: mod.tessellate_batch_fill as WasmApi['tessellate_batch_fill'],
      boolean_polygons:
        typeof mod.boolean_polygons === 'function'
          ? (mod.boolean_polygons as NonNullable<WasmApi['boolean_polygons']>)
          : undefined,
      offset_polyline:
        typeof mod.offset_polyline === 'function'
          ? (mod.offset_polyline as NonNullable<WasmApi['offset_polyline']>)
          : undefined,
      simplify_rdp:
        typeof mod.simplify_rdp === 'function'
          ? (mod.simplify_rdp as NonNullable<WasmApi['simplify_rdp']>)
          : undefined,
      simplify_rdp_closed:
        typeof mod.simplify_rdp_closed === 'function'
          ? (mod.simplify_rdp_closed as NonNullable<WasmApi['simplify_rdp_closed']>)
          : undefined,
      trace_rgba_contours:
        typeof mod.trace_rgba_contours === 'function'
          ? (mod.trace_rgba_contours as NonNullable<WasmApi['trace_rgba_contours']>)
          : undefined,
    };
  } catch {
    return null;
  }
}

export function initWasmGeom(): Promise<boolean> {
  if (forceJs || queryDisablesWasm()) return Promise.resolve(false);
  if (api) return Promise.resolve(true);
  if (initPromise) return initPromise;
  initPromise = (async () => {
    api = await loadWasmModule();
    return Boolean(api);
  })();
  return initPromise;
}

export function preloadWasmGeom(): void {
  if (typeof window === 'undefined') return;
  const run = () => {
    void initWasmGeom();
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 2000 });
    return;
  }
  setTimeout(run, 0);
}

function recordOp(
  kind: 'densify' | 'fill' | 'stroke',
  t0: number,
  pointCount: number,
  fillTris: number,
  strokeTris: number
): void {
  if (!isGeomProfileEnabled()) return;
  const dt = geomNow() - t0;
  recordGeomProfile({
    densifyMs: kind === 'densify' ? dt : 0,
    fillMs: kind === 'fill' ? dt : 0,
    strokeMs: kind === 'stroke' ? dt : 0,
    totalMs: dt,
    pointCount,
    fillTris,
    strokeTris,
    backend: getWasmGeomBackend(),
  });
}

export function densifyPathDWasm(d: string, flatness = DENSIFY_DEFAULT_FLATNESS): Vec2[] {
  const t0 = geomNow();
  const flat = Math.max(0.15, Number(flatness) || DENSIFY_DEFAULT_FLATNESS);
  const pts = wasmLive()
    ? flatToPoints(api!.densify_path_d(String(d || ''), flat))
    : densifyPathDJs(d, flat);
  recordOp('densify', t0, pts.length, 0, 0);
  return pts;
}

export function tessellateFillWasm(points: Vec2[]): FillMesh | null {
  const t0 = geomNow();
  const mesh =
    wasmLive() && points.length >= 3
      ? meshFromFlat(api!.tessellate_fill(pointsToFlat(points)))
      : tessellateFillJs(points);
  recordOp('fill', t0, points.length, mesh?.triangleCount ?? 0, 0);
  return mesh;
}

export function tessellateFillWithHolesWasm(
  outer: Vec2[],
  holes: Vec2[][]
): FillMesh | null {
  const t0 = geomNow();
  const mesh = fillMeshFor(outer, holes);
  recordOp('fill', t0, outer.length, mesh?.triangleCount ?? 0, 0);
  return mesh;
}

export function tessellateStrokeWasm(
  points: Vec2[],
  opts: StrokeTessOpts
): StrokeMesh | null {
  const t0 = geomNow();
  let mesh: StrokeMesh | null = null;
  if (wasmLive() && points.length >= 2) {
    try {
      const raw = api!.tessellate_stroke(
        pointsToFlat(points),
        Math.max(0, Number(opts.width) || 0),
        Boolean(opts.closed),
        String(opts.align || 'center'),
        String(opts.linejoin || 'miter'),
        Math.max(1, Number(opts.miterLimit) || 100)
      );
      mesh = strokeMeshFromWasmFlat(raw);
    } catch {
      mesh = null;
    }
  }
  if (!mesh) mesh = tessellateStrokeJs(points, opts);
  recordOp('stroke', t0, points.length, 0, mesh?.triangleCount ?? 0);
  return mesh;
}

function fillMeshFor(
  points: Vec2[],
  holes: Vec2[][] | undefined
): FillMesh | null {
  const hasHoles = Boolean(holes?.length);
  if (hasHoles) {
    // Prefer WASM boolean-difference + slit; reject skeletal failures.
    if (wasmLive()) {
      try {
        const { flat, counts } = packHoles(holes!);
        const mesh = meshFromFlat(
          api!.tessellate_fill_with_holes(pointsToFlat(points), flat, counts)
        );
        const minTris = Math.max(4, Math.floor(points.length / 4));
        if (mesh && mesh.triangleCount >= minTris) return mesh;
      } catch {
        /* fall through */
      }
    }
    return tessellateFillWithHolesJs(points, holes!);
  }

  if (wasmLive()) {
    try {
      const mesh = meshFromFlat(api!.tessellate_fill(pointsToFlat(points)));
      if (mesh && mesh.triangleCount > 0) return mesh;
      // Empty WASM result — try JS before giving up.
      return tessellateFillJs(points);
    } catch {
      /* fall through to JS */
    }
  }
  return tessellateFillJs(points);
}

function strokeMeshFor(points: Vec2[], opts: StrokeTessOpts): StrokeMesh | null {
  if (points.length < 2) return null;
  return tessellateStrokeWasm(points, opts);
}

/** Tessellate a centerline, optionally splitting into SVG dash segments. */
function strokeMeshForDashed(
  points: Vec2[],
  opts: StrokeTessOpts,
  dasharray?: string
): StrokeMesh | null {
  const dash = dasharray?.trim();
  if (!dash) return strokeMeshFor(points, opts);
  const ring = opts.closed ? closePolylineForDash(points) : points;
  const segs = splitPolylineByDash(ring, dash);
  if (segs.length <= 1) {
    return strokeMeshFor(segs[0] ?? points, { ...opts, closed: false });
  }
  const parts: StrokeMesh[] = [];
  for (const seg of segs) {
    if (seg.length < 2) continue;
    const m = strokeMeshFor(seg as Vec2[], { ...opts, closed: false });
    if (m) parts.push(m);
  }
  return mergeStrokeMeshes(parts);
}

function mergeStrokeMeshes(parts: StrokeMesh[]): StrokeMesh | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const p of parts) total += p.positions.length;
  const positions = new Float32Array(total);
  const edges = new Float32Array(total / 2);
  let o = 0;
  let eo = 0;
  let tris = 0;
  for (const p of parts) {
    positions.set(p.positions, o);
    o += p.positions.length;
    const srcEdges = p.edges;
    const vertCount = p.positions.length / 2;
    if (srcEdges && srcEdges.length >= vertCount) {
      edges.set(srcEdges.subarray(0, vertCount), eo);
    }
    eo += vertCount;
    tris += p.triangleCount;
  }
  return { positions, edges, triangleCount: tris };
}

function mergeFillMeshes(parts: FillMesh[]): FillMesh | null {
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const p of parts) total += p.positions.length;
  const positions = new Float32Array(total);
  let o = 0;
  let tris = 0;
  for (const p of parts) {
    positions.set(p.positions, o);
    o += p.positions.length;
    tris += p.triangleCount;
  }
  return { positions, triangleCount: tris };
}

function ringSignedArea(ring: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j]!.x * ring[i]!.y - ring[i]!.x * ring[j]!.y;
  }
  return a * 0.5;
}

function pointInRing(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]!.x;
    const yi = ring[i]!.y;
    const xj = ring[j]!.x;
    const yj = ring[j]!.y;
    if ((yi > p.y) !== (yj > p.y) && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi + 1e-20) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ringCentroid(ring: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p.x;
    y += p.y;
  }
  const n = Math.max(1, ring.length);
  return { x: x / n, y: y / n };
}

/**
 * Multi-subpath fill (text glyphs / compound paths): nest rings → outer+holes
 * compounds, then tessellate. Works for evenodd canvas traces and nonzero fontkit.
 */
export function buildCompoundFillMeshes(
  points: Vec2[],
  _fillRule: 'nonzero' | 'evenodd' = 'evenodd'
): FillMesh | null {
  const runs = splitPolylineContours(points)
    .map((r) => {
      const out = r.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (out.length < 3) return out;
      const a = out[0]!;
      const b = out[out.length - 1]!;
      if (Math.abs(a.x - b.x) > 1e-5 || Math.abs(a.y - b.y) > 1e-5) out.push({ ...a });
      return out;
    })
    .filter((r) => r.length >= 3);
  if (!runs.length) return null;
  if (runs.length === 1) return fillMeshFor(runs[0]!, undefined);

  const indexed = runs.map((ring, i) => ({
    ring,
    i,
    area: Math.abs(ringSignedArea(ring)),
  }));
  indexed.sort((a, b) => b.area - a.area);

  const parent = new Array<number>(runs.length).fill(-1);
  for (let a = 0; a < indexed.length; a += 1) {
    const child = indexed[a]!;
    const c = ringCentroid(child.ring);
    for (let b = a - 1; b >= 0; b -= 1) {
      const cand = indexed[b]!;
      if (cand.area <= child.area + 1e-6) continue;
      if (pointInRing(c, cand.ring)) {
        parent[child.i] = cand.i;
        break;
      }
    }
  }

  const depth = new Array<number>(runs.length).fill(0);
  const depthOf = (i: number): number => {
    if (parent[i] < 0) return 0;
    if (depth[i]) return depth[i]!;
    depth[i] = depthOf(parent[i]!) + 1;
    return depth[i]!;
  };
  for (let i = 0; i < runs.length; i += 1) depthOf(i);

  const compounds: { outer: Vec2[]; holes: Vec2[][] }[] = [];
  const outerIndex = new Map<number, number>();
  for (let i = 0; i < runs.length; i += 1) {
    if (depth[i]! % 2 === 0) {
      outerIndex.set(i, compounds.length);
      compounds.push({ outer: runs[i]!, holes: [] });
    }
  }
  for (let i = 0; i < runs.length; i += 1) {
    if (depth[i]! % 2 === 0) continue;
    let p = parent[i]!;
    while (p >= 0 && depth[p]! % 2 !== 0) p = parent[p]!;
    const ci = p >= 0 ? outerIndex.get(p) : undefined;
    if (ci == null) {
      compounds.push({ outer: runs[i]!, holes: [] });
    } else {
      compounds[ci]!.holes.push(runs[i]!);
    }
  }

  const parts: FillMesh[] = [];
  for (const c of compounds) {
    const m = fillMeshFor(c.outer, c.holes.length ? c.holes : undefined);
    if (m) parts.push(m);
  }
  return mergeFillMeshes(parts);
}

/**
 * Tessellate each glyph path alone then merge. Avoids global nest across a
 * whole string, which treats counters as filled islands (solid o/d/4).
 */
export function buildTextGlyphFillMeshes(
  glyphPathDs: readonly string[],
  fillRule: 'nonzero' | 'evenodd' = 'evenodd',
  flatness = DENSIFY_DEFAULT_FLATNESS
): FillMesh | null {
  const parts: FillMesh[] = [];
  for (const d of glyphPathDs) {
    const src = String(d || '').trim();
    if (!src) continue;
    const m = buildCompoundFillMeshes(densifyPathDJs(src, flatness), fillRule);
    if (m && m.triangleCount > 0) parts.push(m);
  }
  return mergeFillMeshes(parts);
}

/** Build fill+stroke for one contour (profiles once). */
export function buildShapeMeshes(
  points: Vec2[],
  opts: {
    closed: boolean;
    wantFill: boolean;
    strokeWidth: number;
    strokeAlign?: string;
    linejoin?: 'miter' | 'round' | 'bevel';
    miterLimit?: number;
    holes?: Vec2[][];
    /** Boolean compound paths — nest subpaths when evenodd/nonzero multi-M. */
    fillRule?: 'nonzero' | 'evenodd';
    /**
     * Arrow: fill the V head as a solid triangle; stroke only the shaft.
     * Avoids butt-gap between shaft and open chevron + open tip from miter AA.
     */
    arrowHeadFill?: boolean;
    /** SVG stroke-dasharray; when set, stroke is split into open dash ribbons. */
    dasharray?: string;
    linecap?: 'butt' | 'round' | 'square' | string;
    /**
     * Partial rect sides: open polylines stroked instead of the closed contour.
     * `[]` = no stroke; omit/undefined = stroke primary contour.
     */
    strokeRuns?: Vec2[][];
  }
): { fill: FillMesh | null; stroke: StrokeMesh | null } {
  const t0 = geomNow();
  let fill: FillMesh | null = null;
  let stroke: StrokeMesh | null = null;
  let tFill = 0;
  let tStroke = 0;

  const runs = splitPolylineContours(points);
  const primary = runs[0] ?? points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));

  if (opts.arrowHeadFill && runs.length >= 2 && opts.strokeWidth > 0) {
    const a = geomNow();
    const head = runs[1]!;
    if (head.length >= 3) {
      fill = fillMeshFor(head.slice(0, 3), undefined);
    }
    tFill = geomNow() - a;
    const a2 = geomNow();
    stroke = strokeMeshForDashed(
      primary,
      {
        width: opts.strokeWidth,
        closed: false,
        align: opts.strokeAlign,
        linejoin: opts.linejoin,
        miterLimit: opts.miterLimit,
        linecap: opts.linecap,
      },
      opts.dasharray
    );
    tStroke = geomNow() - a2;
  } else {
    if (opts.wantFill && opts.closed && primary.length >= 3) {
      const a = geomNow();
      if (opts.holes?.length) {
        // Explicit holes (ellipse donut attrs).
        fill = fillMeshFor(primary, opts.holes);
      } else if (runs.length > 1) {
        // Boolean subtract / compound path: nest subpaths → outer+holes.
        // (Previously only the first M-run was filled → solid plate, no hollow.)
        fill = buildCompoundFillMeshes(
          points,
          opts.fillRule === 'nonzero' ? 'nonzero' : 'evenodd'
        );
      } else {
        fill = fillMeshFor(primary, undefined);
      }
      tFill = geomNow() - a;
    }
    if (opts.strokeWidth > 0) {
      const a = geomNow();
      const strokeOpts: StrokeTessOpts = {
        width: opts.strokeWidth,
        closed: opts.closed,
        align: opts.strokeAlign,
        linejoin: opts.linejoin,
        miterLimit: opts.miterLimit,
        linecap: opts.linecap,
      };
      if (opts.strokeRuns) {
        // Partial sides / explicit open runs — SVG forces center align.
        const parts: StrokeMesh[] = [];
        for (const run of opts.strokeRuns) {
          if (run.length < 2) continue;
          const m = strokeMeshForDashed(
            run,
            { ...strokeOpts, closed: false, align: 'center' },
            opts.dasharray
          );
          if (m) parts.push(m);
        }
        stroke = mergeStrokeMeshes(parts);
      } else if (runs.length <= 1) {
        stroke = strokeMeshForDashed(primary, strokeOpts, opts.dasharray);
      } else {
        // Multi-M open strokes: stroke each subpath; never bridge across M breaks.
        const parts: StrokeMesh[] = [];
        for (const run of runs) {
          const m = strokeMeshForDashed(run, { ...strokeOpts, closed: false }, opts.dasharray);
          if (m) parts.push(m);
        }
        stroke = mergeStrokeMeshes(parts);
      }
      tStroke = geomNow() - a;
    }
  }

  if (isGeomProfileEnabled()) {
    recordGeomProfile({
      densifyMs: 0,
      fillMs: tFill,
      strokeMs: tStroke,
      totalMs: geomNow() - t0,
      pointCount: points.length,
      fillTris: fill?.triangleCount ?? 0,
      strokeTris: stroke?.triangleCount ?? 0,
      backend: getWasmGeomBackend(),
    });
  }
  return { fill, stroke };
}

export function tessellateBatchFill(rings: Vec2[][]): (FillMesh | null)[] {
  if (!rings.length) return [];
  if (!wasmLive()) return rings.map((r) => tessellateFillJs(r));

  const counts = new Uint32Array(rings.length);
  let total = 0;
  for (let i = 0; i < rings.length; i += 1) {
    counts[i] = rings[i]!.length;
    total += rings[i]!.length * 2;
  }
  const xyAll = new Float32Array(total);
  let off = 0;
  for (const ring of rings) {
    for (const p of ring) {
      xyAll[off++] = p.x;
      xyAll[off++] = p.y;
    }
  }
  return unpackBatch(api!.tessellate_batch_fill(xyAll, counts));
}

function packBoolPolygons(polygons: BoolPolygon[]): Float32Array {
  const buf: number[] = [polygons.length];
  for (const poly of polygons) {
    const rings = Array.isArray(poly) ? poly : [];
    buf.push(rings.length);
    for (const ring of rings) {
      if (!ring || ring.length < 3) {
        buf.push(0);
        continue;
      }
      let n = ring.length;
      const a = ring[0]!;
      const b = ring[n - 1]!;
      if (a[0] === b[0] && a[1] === b[1] && n > 1) n -= 1;
      if (n < 3) {
        buf.push(0);
        continue;
      }
      buf.push(n);
      for (let i = 0; i < n; i += 1) {
        buf.push(Number(ring[i]![0]) || 0, Number(ring[i]![1]) || 0);
      }
    }
  }
  return new Float32Array(buf);
}

function unpackBoolPolygons(packed: ArrayLike<number>): BoolMultiPolygon | null {
  if (!packed.length) return null;
  let i = 0;
  const polyCount = packed[i++]! | 0;
  if (polyCount < 0) return null;
  const out: BoolMultiPolygon = [];
  for (let p = 0; p < polyCount; p += 1) {
    if (i >= packed.length) return null;
    const ringCount = packed[i++]! | 0;
    const poly: BoolPolygon = [];
    for (let r = 0; r < ringCount; r += 1) {
      if (i >= packed.length) return null;
      const vertCount = packed[i++]! | 0;
      if (vertCount < 0 || i + vertCount * 2 > packed.length) return null;
      const ring: BoolRing = [];
      for (let v = 0; v < vertCount; v += 1) {
        ring.push([Number(packed[i++]), Number(packed[i++])]);
      }
      if (ring.length >= 3) {
        const a = ring[0]!;
        const b = ring[ring.length - 1]!;
        if (a[0] !== b[0] || a[1] !== b[1]) ring.push([a[0], a[1]]);
        poly.push(ring);
      }
    }
    if (poly.length) out.push(poly);
  }
  return out;
}

/**
 * WASM polygon boolean (`i_overlay`). Null when unavailable / decode fails.
 */
export function booleanPolygonsWasm(
  op: BoolPolygonOp,
  polygons: BoolPolygon[]
): BoolMultiPolygon | null {
  if (!wasmLive() || typeof api?.boolean_polygons !== 'function') return null;
  if (!polygons || polygons.length < 2) return null;
  try {
    const packed = packBoolPolygons(polygons);
    const raw = api.boolean_polygons(BOOL_OP_CODE[op], packed);
    // length 0 → hard failure (fall back to polygon-clipping).
    // `[0]` → successful empty multipolygon.
    if (!raw || raw.length === 0) return null;
    const mp = unpackBoolPolygons(raw);
    if (mp == null) return null;
    return mp;
  } catch {
    return null;
  }
}

const JOIN_CODE = { bevel: 0, miter: 1, round: 2 } as const;
const CAP_CODE = { butt: 0, round: 1, square: 2 } as const;

export type OffsetPolylineOpts = {
  linejoin?: 'miter' | 'bevel' | 'round';
  linecap?: 'butt' | 'round' | 'square';
  miterLimit?: number;
  /** Round cap/join tessellation step (radians). Default ~0.15. */
  roundApprox?: number;
};

/** WASM stroke centerline → filled MultiPolygon. Null when unavailable. */
export function offsetPolylineWasm(
  points: Array<[number, number]> | Vec2[],
  width: number,
  closed: boolean,
  opts: OffsetPolylineOpts = {}
): BoolMultiPolygon | null {
  if (!wasmLive() || typeof api?.offset_polyline !== 'function') return null;
  if (!points || points.length < (closed ? 3 : 2) || !(width > 0)) return null;
  try {
    const xy = new Float32Array(points.length * 2);
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i]!;
      if (Array.isArray(p)) {
        xy[i * 2] = Number(p[0]) || 0;
        xy[i * 2 + 1] = Number(p[1]) || 0;
      } else {
        xy[i * 2] = Number((p as Vec2).x) || 0;
        xy[i * 2 + 1] = Number((p as Vec2).y) || 0;
      }
    }
    const join = JOIN_CODE[opts.linejoin || 'miter'] ?? 1;
    const cap = CAP_CODE[opts.linecap || 'butt'] ?? 0;
    const raw = api.offset_polyline(
      xy,
      Math.max(0.25, Number(width) || 0),
      Boolean(closed),
      join,
      cap,
      Math.max(1, Number(opts.miterLimit) || 100),
      Math.max(0.05, Number(opts.roundApprox) || 0.15)
    );
    if (!raw || raw.length === 0) return null;
    return unpackBoolPolygons(raw);
  } catch {
    return null;
  }
}

function packXyPairs(points: Array<[number, number]>): Float32Array {
  const xy = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    xy[i * 2] = Number(points[i]![0]) || 0;
    xy[i * 2 + 1] = Number(points[i]![1]) || 0;
  }
  return xy;
}

function unpackXyPairs(flat: ArrayLike<number>): Array<[number, number]> {
  const n = Math.floor(flat.length / 2);
  const out: Array<[number, number]> = new Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = [Number(flat[i * 2]), Number(flat[i * 2 + 1])];
  }
  return out;
}

/** Open RDP. Null when WASM unavailable. */
export function simplifyRdpWasm(
  points: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> | null {
  if (!wasmLive() || typeof api?.simplify_rdp !== 'function') return null;
  if (!points || points.length <= 2) return points ? points.slice() : null;
  try {
    const raw = api.simplify_rdp(packXyPairs(points), Math.max(0, Number(epsilon) || 0));
    if (!raw || raw.length < 4) return null;
    return unpackXyPairs(raw);
  } catch {
    return null;
  }
}

/** Closed-ring RDP. Null when WASM unavailable. */
export function simplifyRdpClosedWasm(
  points: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> | null {
  if (!wasmLive() || typeof api?.simplify_rdp_closed !== 'function') return null;
  if (!points || points.length < 3) return points ? points.slice() : null;
  try {
    const raw = api.simplify_rdp_closed(packXyPairs(points), Math.max(0, Number(epsilon) || 0));
    if (!raw || raw.length < 6) return null;
    return unpackXyPairs(raw);
  } catch {
    return null;
  }
}

function unpackContourList(packed: ArrayLike<number>): Array<Array<[number, number]>> | null {
  if (!packed.length) return null;
  let i = 0;
  const count = packed[i++]! | 0;
  if (count < 0) return null;
  const out: Array<Array<[number, number]>> = [];
  for (let c = 0; c < count; c += 1) {
    if (i >= packed.length) return null;
    const n = packed[i++]! | 0;
    if (n < 0 || i + n * 2 > packed.length) return null;
    const ring: Array<[number, number]> = [];
    for (let v = 0; v < n; v += 1) {
      ring.push([Number(packed[i++]), Number(packed[i++])]);
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/**
 * Trace solid + holes from ImageData RGBA. Null when WASM unavailable.
 * Empty array = successful empty (e.g. whitespace glyph).
 */
export function traceRgbaContoursWasm(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  alphaThreshold = 20
): Array<Array<[number, number]>> | null {
  if (!wasmLive() || typeof api?.trace_rgba_contours !== 'function') return null;
  const w = Math.max(0, Math.floor(Number(width) || 0));
  const h = Math.max(0, Math.floor(Number(height) || 0));
  if (!w || !h || rgba.length < w * h * 4) return null;
  try {
    const raw = api.trace_rgba_contours(
      rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      w,
      h,
      Math.max(0, Math.min(255, Math.round(Number(alphaThreshold) || 20)))
    );
    if (!raw || raw.length === 0) return null;
    const list = unpackContourList(raw);
    if (list == null) return null;
    return list;
  } catch {
    return null;
  }
}

/** Test helper — inject a mock WASM API. */
export function __setWasmGeomApiForTests(mock: WasmApi | null): void {
  api = mock;
  initPromise = mock ? Promise.resolve(true) : null;
}
