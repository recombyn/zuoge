/**
 * WebGL instance atlas — fixed-cell LRU packer for media bake tiles (ADR 0027).
 * Shape / text ink is vector (mesh / Path2D); never stamped here.
 */
import {
  SOA_KIND_IMAGE,
  type SceneRenderBuffer,
} from '@/components/rcb/render/sceneRenderBuffer';

export const SOA_ATLAS_DEFAULT_SIZE = 4096;
/** Larger cells keep baked strokes/curves sharp without SVG hosts or segment tessellation. */
export const SOA_ATLAS_CELL = 512;
export const SOA_ATLAS_PAD = 2;
/** Usable texels per cell after padding — idle media softer than this on screen. */
export const SOA_ATLAS_INNER = SOA_ATLAS_CELL - SOA_ATLAS_PAD * 2;
/** Prefer atlas stamp when a path would emit at least this many segments. */
export const SOA_ATLAS_SEG_THRESHOLD = 12;

/** Longest screen edge (CSS px × dpr) for an idle media stamp. */
export function idleMediaScreenEdgePx(
  width: number,
  height: number,
  zoom: number,
  dpr = 1
): number {
  const edge = Math.max(Math.max(1, Number(width) || 1), Math.max(1, Number(height) || 1));
  return edge * Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
}

/**
 * Scene→bake texel scale matching on-screen coverage (capped by atlas cell).
 * Zoom / coverage buckets force rebake so stroke density tracks the camera —
 * do not pre-fill the cell at low zoom (that fought dynamic rebake).
 */
export function atlasBakePixelScale(
  width: number,
  height: number,
  zoom = 1,
  opts?: { dpr?: number; maxEdge?: number }
): number {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const edge = Math.max(w, h);
  const maxEdge = Math.max(16, Number(opts?.maxEdge) || SOA_ATLAS_INNER);
  const screen = idleMediaScreenEdgePx(w, h, zoom, opts?.dpr ?? 1);
  const target = Math.min(maxEdge, Math.max(4, screen));
  return Math.max(1e-6, target / edge);
}

/** Scene→atlas texel scale: always fill the usable cell (never cap at 1). */
export function atlasStampSceneScale(
  worldWidth: number,
  worldHeight: number,
  cellInner = SOA_ATLAS_INNER
): number {
  const edge = Math.max(1, Math.max(Number(worldWidth) || 1, Number(worldHeight) || 1));
  const inner = Math.max(16, Number(cellInner) || SOA_ATLAS_INNER);
  return inner / edge;
}

/** Zoom key so atlas restamps when coverage jumps (finer → less mush mid-bucket). */
export function atlasZoomBucket(zoom: number): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  return Math.round(Math.log2(z) * 16);
}

/** Screen-edge bands for rich ink keys — rebake when on-screen size jumps ~N px. */
export const ATLAS_COVERAGE_BUCKET_PX = 32;

/** Discrete coverage key from world AABB × camera × dpr. */
export function atlasCoverageBucket(
  width: number,
  height: number,
  zoom: number,
  dpr = 1
): number {
  return Math.round(
    idleMediaScreenEdgePx(width, height, zoom, dpr) / ATLAS_COVERAGE_BUCKET_PX
  );
}

export type SoaAtlasRegion = {
  key: string;
  cell: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** World AABB stamped into this cell. */
  world: { left: number; top: number; width: number; height: number };
};

export type SoaAtlasStats = {
  hits: number;
  misses: number;
  evictions: number;
  restamps: number;
  releases: number;
};

export type SoaWebglAtlas = {
  size: number;
  cell: number;
  cols: number;
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  regions: Map<string, SoaAtlasRegion>;
  /** Free cell indices. */
  free: number[];
  /** LRU order: oldest at front. */
  lru: string[];
  revision: number;
  stats: SoaAtlasStats;
};

export function createEmptySoaAtlasStats(): SoaAtlasStats {
  return { hits: 0, misses: 0, evictions: 0, restamps: 0, releases: 0 };
}

function createAtlasSurface(size: number): {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
} | null {
  // Reuse the first 2d context — some envs null a second getContext on the same canvas.
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const oc = new OffscreenCanvas(size, size);
      const ctx = oc.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
      if (ctx) return { canvas: oc, ctx };
    } catch {
      /* fall through */
    }
  }
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  return { canvas: c, ctx };
}

/** Atlas stamps — product always on with WebGL. Off in Vitest. */
export function isSoaWebglAtlasEnabled(): boolean {
  try {
    if (import.meta.env.MODE === 'test' || import.meta.env.VITEST) return false;
    return true;
  } catch {
    return true;
  }
}

export function createSoaWebglAtlas(
  size = SOA_ATLAS_DEFAULT_SIZE,
  cell = SOA_ATLAS_CELL
): SoaWebglAtlas | null {
  const surface = createAtlasSurface(size);
  if (!surface) return null;
  const { canvas, ctx } = surface;
  const cols = Math.max(1, Math.floor(size / cell));
  const n = cols * cols;
  const free: number[] = [];
  for (let i = 0; i < n; i += 1) free.push(i);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  return {
    size,
    cell,
    cols,
    canvas,
    ctx,
    regions: new Map(),
    free,
    lru: [],
    revision: 0,
    stats: createEmptySoaAtlasStats(),
  };
}

export function resetSoaWebglAtlas(atlas: SoaWebglAtlas) {
  atlas.regions.clear();
  atlas.lru = [];
  atlas.free = [];
  const n = atlas.cols * atlas.cols;
  for (let i = 0; i < n; i += 1) atlas.free.push(i);
  atlas.revision += 1;
  atlas.stats = createEmptySoaAtlasStats();
  atlas.ctx.setTransform(1, 0, 0, 1, 0, 0);
  atlas.ctx.clearRect(0, 0, atlas.size, atlas.size);
}

function touchLru(atlas: SoaWebglAtlas, key: string) {
  const i = atlas.lru.indexOf(key);
  if (i >= 0) atlas.lru.splice(i, 1);
  atlas.lru.push(key);
}

function cellOrigin(atlas: SoaWebglAtlas, cellIndex: number) {
  const col = cellIndex % atlas.cols;
  const row = Math.floor(cellIndex / atlas.cols);
  return { x: col * atlas.cell, y: row * atlas.cell };
}

/** Evict oldest LRU entry and free its cell. Returns false if nothing to evict. */
export function evictSoaAtlasOldest(atlas: SoaWebglAtlas): boolean {
  const oldest = atlas.lru.shift();
  if (!oldest) return false;
  const region = atlas.regions.get(oldest);
  if (!region) return false;
  atlas.regions.delete(oldest);
  const { x, y } = cellOrigin(atlas, region.cell);
  atlas.ctx.clearRect(x, y, atlas.cell, atlas.cell);
  atlas.free.push(region.cell);
  atlas.revision += 1;
  atlas.stats.evictions += 1;
  return true;
}

/** Free one region by key (keeps other cells intact). */
export function releaseSoaAtlasRegion(atlas: SoaWebglAtlas, key: string): boolean {
  const region = atlas.regions.get(key);
  if (!region) return false;
  atlas.regions.delete(key);
  const i = atlas.lru.indexOf(key);
  if (i >= 0) atlas.lru.splice(i, 1);
  const { x, y } = cellOrigin(atlas, region.cell);
  atlas.ctx.clearRect(x, y, atlas.cell, atlas.cell);
  atlas.free.push(region.cell);
  atlas.revision += 1;
  atlas.stats.releases += 1;
  return true;
}

/** Release all regions whose key starts with `prefix`. */
export function releaseSoaAtlasPrefix(atlas: SoaWebglAtlas, prefix: string): number {
  let n = 0;
  for (const key of [...atlas.regions.keys()]) {
    if (!key.startsWith(prefix)) continue;
    if (releaseSoaAtlasRegion(atlas, key)) n += 1;
  }
  return n;
}

/**
 * Drop stale atlas stamps. Legacy shape keys (`rich:` / `path:` / `round:` / `txt:`)
 * are always released. Media (`img:` / `aud:`) kept while the slot remains.
 */
export function pruneSoaAtlasForBuffer(atlas: SoaWebglAtlas, buf: SceneRenderBuffer): number {
  const keep = new Set<string>();
  for (let i = 0; i < buf.count; i += 1) {
    const id = buf.ids[i];
    if (!id) continue;
    const kind = buf.kinds[i];
    if (kind === SOA_KIND_IMAGE) {
      keep.add(`img:${id}`);
      keep.add(`aud:${id}`);
    }
  }
  let n = 0;
  for (const key of [...atlas.regions.keys()]) {
    if (
      key.startsWith('rich:') ||
      key.startsWith('path:') ||
      key.startsWith('round:') ||
      key.startsWith('txt:')
    ) {
      if (releaseSoaAtlasRegion(atlas, key)) n += 1;
      continue;
    }
    if (!key.startsWith('img:') && !key.startsWith('aud:')) {
      continue;
    }
    const kept = [...keep].some((k) => key === k || key.startsWith(`${k}:`));
    if (kept) continue;
    if (releaseSoaAtlasRegion(atlas, key)) n += 1;
  }
  return n;
}

export function getSoaAtlasStats(atlas: SoaWebglAtlas): SoaAtlasStats {
  return { ...atlas.stats };
}

function allocateCell(atlas: SoaWebglAtlas): number | null {
  if (atlas.free.length > 0) return atlas.free.pop()!;
  if (!evictSoaAtlasOldest(atlas)) return null;
  if (atlas.free.length > 0) return atlas.free.pop()!;
  return null;
}

function atlasStampTexelScale(
  worldWidth: number,
  worldHeight: number,
  cellInner: number,
  texScale?: number
): number {
  const fill = atlasStampSceneScale(worldWidth, worldHeight, cellInner);
  if (texScale != null && Number(texScale) > 0) {
    // Cap at fill-cell so stamps never exceed the atlas cell.
    return Math.min(fill, Math.max(1e-6, Number(texScale)));
  }
  return fill;
}

function beginCellStamp(
  atlas: SoaWebglAtlas,
  key: string,
  world: { left: number; top: number; width: number; height: number },
  texScale?: number
): SoaAtlasRegion | null {
  const hit = atlas.regions.get(key);
  if (hit) {
    touchLru(atlas, key);
    return hit;
  }
  const cell = allocateCell(atlas);
  if (cell == null) return null;
  const origin = cellOrigin(atlas, cell);
  const inner = atlas.cell - SOA_ATLAS_PAD * 2;
  const scale = atlasStampTexelScale(world.width, world.height, inner, texScale);
  const pw = Math.min(inner, Math.max(4, Math.ceil(world.width * scale)));
  const ph = Math.min(inner, Math.max(4, Math.ceil(world.height * scale)));
  const x = origin.x + SOA_ATLAS_PAD;
  const y = origin.y + SOA_ATLAS_PAD;
  atlas.ctx.clearRect(origin.x, origin.y, atlas.cell, atlas.cell);
  const region: SoaAtlasRegion = {
    key,
    cell,
    x,
    y,
    w: pw,
    h: ph,
    world,
  };
  atlas.regions.set(key, region);
  touchLru(atlas, key);
  atlas.revision += 1;
  return region;
}

type AtlasWorldBox = { left: number; top: number; width: number; height: number };

/** True when a cached stamp's world AABB no longer matches the live box. */
function atlasWorldMismatch(a: AtlasWorldBox, b: AtlasWorldBox): boolean {
  return (
    Math.abs(a.left - b.left) > 0.5 ||
    Math.abs(a.top - b.top) > 0.5 ||
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.height - b.height) > 0.5
  );
}

/**
 * Copy a bake / OffscreenCanvas / media tile into the atlas.
 * Pass `force: true` after a bake tile rebuild so pixels refresh in-place.
 */
export function stampImageToAtlas(
  atlas: SoaWebglAtlas,
  key: string,
  source: CanvasImageSource,
  world: { left: number; top: number; width: number; height: number },
  opts?: { force?: boolean; /** Scene→texel scale; omit to fill the atlas cell. */ texScale?: number }
): SoaAtlasRegion | null {
  if (!atlasStampSourceIsSafe(source)) return null;
  const existing = atlas.regions.get(key);
  // Empty-gen icons used to keep a stale world AABB after resize → glyph
  // stretched into a corner while live x/y/w/h kept moving.
  const worldMoved = Boolean(existing && atlasWorldMismatch(existing.world, world));
  const inner = atlas.cell - SOA_ATLAS_PAD * 2;
  const scale = atlasStampTexelScale(world.width, world.height, inner, opts?.texScale);
  const wantW = Math.min(inner, Math.max(4, Math.ceil(world.width * scale)));
  const wantH = Math.min(inner, Math.max(4, Math.ceil(world.height * scale)));
  // Upgrade legacy soft stamps (scene-capped at scale≤1 → ~13 texels for 13px plates).
  const undersized = Boolean(
    existing && (existing.w < wantW - 1 || existing.h < wantH - 1)
  );
  const force = Boolean(opts?.force) || worldMoved || undersized;
  if (existing && !force) {
    touchLru(atlas, key);
    atlas.stats.hits += 1;
    return existing;
  }
  if (existing && force) {
    // Redraw into the same cell (stable UV).
    const { ctx } = atlas;
    existing.world = world;
    existing.w = wantW;
    existing.h = wantH;
    ctx.save();
    const origin = cellOrigin(atlas, existing.cell);
    ctx.clearRect(origin.x, origin.y, atlas.cell, atlas.cell);
    try {
      ctx.drawImage(source, existing.x, existing.y, existing.w, existing.h);
    } catch {
      ctx.restore();
      releaseSoaAtlasRegion(atlas, key);
      return null;
    }
    ctx.restore();
    touchLru(atlas, key);
    atlas.revision += 1;
    atlas.stats.restamps += 1;
    return existing;
  }
  atlas.stats.misses += 1;
  const region = beginCellStamp(atlas, key, world, opts?.texScale);
  if (!region) return null;
  const { ctx } = atlas;
  ctx.save();
  ctx.clearRect(region.x, region.y, region.w, region.h);
  try {
    ctx.drawImage(source, region.x, region.y, region.w, region.h);
  } catch {
    atlas.regions.delete(key);
    const i = atlas.lru.indexOf(key);
    if (i >= 0) atlas.lru.splice(i, 1);
    atlas.free.push(region.cell);
    ctx.restore();
    return null;
  }
  ctx.restore();
  return region;
}

export function atlasRegionToUv(atlas: SoaWebglAtlas, region: SoaAtlasRegion) {
  const s = atlas.size;
  return {
    u0: region.x / s,
    v0: region.y / s,
    u1: (region.x + region.w) / s,
    v1: (region.y + region.h) / s,
  };
}

export function pushAtlasRegionInstance(
  atlas: SoaWebglAtlas,
  region: SoaAtlasRegion,
  rects: number[],
  colors: number[],
  kinds: number[],
  angles: number[],
  uvs: number[],
  angleRad = 0,
  offsetX = 0,
  offsetY = 0
) {
  const uv = atlasRegionToUv(atlas, region);
  const { world } = region;
  rects.push(world.left + offsetX, world.top + offsetY, world.width, world.height);
  colors.push(1, 1, 1, 1);
  kinds.push(3);
  angles.push(Number(angleRad) || 0);
  uvs.push(uv.u0, uv.v0, uv.u1, uv.v1);
}

/** Collect atlas quads for viewport bake tiles; returns number of tiles stamped. */
export function collectSoaBakeTilesIntoAtlas(
  atlas: SoaWebglAtlas,
  tiles: Array<{
    key: string;
    canvas: CanvasImageSource;
    bounds: { left: number; top: number; width: number; height: number };
    /** True when bake canvas was just rebuilt — force atlas pixel refresh. */
    force?: boolean;
  }>,
  rects: number[],
  colors: number[],
  kinds: number[],
  angles: number[],
  uvs: number[]
): number {
  let n = 0;
  for (const tile of tiles) {
    const region = stampImageToAtlas(
      atlas,
      `bake:${tile.key}`,
      tile.canvas,
      tile.bounds,
      { force: tile.force === true }
    );
    if (!region) continue;
    pushAtlasRegionInstance(atlas, region, rects, colors, kinds, angles, uvs);
    n += 1;
  }
  return n;
}

let sharedAtlas: SoaWebglAtlas | null = null;

export function ensureSharedSoaWebglAtlas(): SoaWebglAtlas | null {
  if (!sharedAtlas) sharedAtlas = createSoaWebglAtlas();
  return sharedAtlas;
}

/** Drop a tainted atlas surface and allocate a fresh one (WebGL texImage2D recovery). */
export function recreateSharedSoaWebglAtlas(): SoaWebglAtlas | null {
  sharedAtlas = createSoaWebglAtlas();
  return sharedAtlas;
}

/** True when a stamp source will not taint the atlas canvas. */
export function atlasStampSourceIsSafe(source: CanvasImageSource): boolean {
  if (typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement) {
    try {
      const ctx = source.getContext('2d');
      if (!ctx) return false;
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch {
      return false;
    }
  }
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
    try {
      const ctx = source.getContext('2d');
      if (!ctx) return false;
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch {
      return false;
    }
  }
  // HTMLImageElement / ImageBitmap / Video — trust caller CORS; drawImage of
  // cross-origin without CORS taints. Prefer baking through a readable canvas.
  return true;
}
