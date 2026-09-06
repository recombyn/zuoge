/**
 * Artboard viewport tiles — full zoom×dpr sharpness without one full-plate bitmap.
 * Composites into the existing single FO canvas (stackOrder / FO interleave intact).
 */
export const ARTBOARD_TILE_SCENE_BASE = 512;
/** Longest backing edge per tile (device px). */
export const ARTBOARD_TILE_MAX_EDGE = 2048;
const MAX_CACHED_TILES = 64;

export type ArtboardTileKey = string;

export type ArtboardTileBounds = {
  tx: number;
  ty: number;
  /** Plate-local scene rect (origin = plate top-left). */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type ArtboardTile = {
  key: ArtboardTileKey;
  bounds: ArtboardTileBounds;
  canvas: HTMLCanvasElement;
  /** Scene→backing scale used when last painted. */
  scale: number;
  revision: number;
};

type FrameTileCache = {
  tiles: Map<ArtboardTileKey, ArtboardTile>;
  lru: string[];
  revision: number;
};

const caches = new Map<string, FrameTileCache>();

function cacheFor(frameId: string): FrameTileCache {
  let c = caches.get(frameId);
  if (!c) {
    c = { tiles: new Map(), lru: [], revision: 0 };
    caches.set(frameId, c);
  }
  return c;
}

export function artboardTileKey(tx: number, ty: number): ArtboardTileKey {
  return `${tx},${ty}`;
}

/**
 * Scene edge per tile so `tileScene × wantScale ≤ MAX_EDGE` (sharp at full zoom×dpr).
 */
export function artboardTileSceneSize(wantScale: number): number {
  const s = Math.max(1e-6, Number(wantScale) || 1);
  const maxScene = ARTBOARD_TILE_MAX_EDGE / s;
  return Math.max(32, Math.min(ARTBOARD_TILE_SCENE_BASE, Math.floor(maxScene)));
}

/** Wanted device pixels per scene unit (uncapped). */
export function artboardWantScale(zoom: number, dpr = 1): number {
  return Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
}

export function listArtboardTilesForView(
  plateW: number,
  plateH: number,
  /** Plate-local view (intersected with plate). */
  viewLocal: { left: number; top: number; width: number; height: number },
  tileScene: number
): ArtboardTileBounds[] {
  const tw = Math.max(32, tileScene);
  const pw = Math.max(1, plateW);
  const ph = Math.max(1, plateH);
  const vl = Math.max(0, viewLocal.left);
  const vt = Math.max(0, viewLocal.top);
  const vr = Math.min(pw, viewLocal.left + viewLocal.width);
  const vb = Math.min(ph, viewLocal.top + viewLocal.height);
  if (vr <= vl || vb <= vt) return [];
  const tx0 = Math.floor(vl / tw);
  const ty0 = Math.floor(vt / tw);
  const tx1 = Math.floor((vr - 1e-6) / tw);
  const ty1 = Math.floor((vb - 1e-6) / tw);
  const out: ArtboardTileBounds[] = [];
  for (let ty = ty0; ty <= ty1; ty += 1) {
    for (let tx = tx0; tx <= tx1; tx += 1) {
      const left = tx * tw;
      const top = ty * tw;
      const width = Math.min(tw, pw - left);
      const height = Math.min(tw, ph - top);
      if (width < 1e-6 || height < 1e-6) continue;
      out.push({ tx, ty, left, top, width, height });
    }
  }
  return out;
}

function touchLru(cache: FrameTileCache, key: string) {
  const i = cache.lru.indexOf(key);
  if (i >= 0) cache.lru.splice(i, 1);
  cache.lru.push(key);
  while (cache.lru.length > MAX_CACHED_TILES) {
    const drop = cache.lru.shift();
    if (!drop) break;
    cache.tiles.delete(drop);
  }
}

/** Ensure a tile canvas at `scale` (scene→backing). Reallocates when size/scale changes. */
export function ensureArtboardTile(
  frameId: string,
  bounds: ArtboardTileBounds,
  scale: number,
  revision: number
): ArtboardTile {
  const cache = cacheFor(frameId);
  const key = artboardTileKey(bounds.tx, bounds.ty);
  const bw = Math.max(1, Math.round(bounds.width * scale));
  const bh = Math.max(1, Math.round(bounds.height * scale));
  let tile = cache.tiles.get(key);
  if (
    !tile ||
    tile.canvas.width !== bw ||
    tile.canvas.height !== bh ||
    Math.abs(tile.scale - scale) > 1e-6
  ) {
    const canvas = tile?.canvas ?? document.createElement('canvas');
    canvas.width = bw;
    canvas.height = bh;
    tile = { key, bounds, canvas, scale, revision: -1 };
    cache.tiles.set(key, tile);
  } else {
    tile.bounds = bounds;
  }
  touchLru(cache, key);
  return tile;
}

export function artboardTileNeedsPaint(tile: ArtboardTile, revision: number): boolean {
  return tile.revision !== revision;
}

export function markArtboardTilePainted(tile: ArtboardTile, revision: number): void {
  tile.revision = revision;
}

export function bumpArtboardTileCacheRevision(frameId: string): number {
  const cache = cacheFor(frameId);
  cache.revision += 1;
  return cache.revision;
}

export function getArtboardTileCacheRevision(frameId: string): number {
  return cacheFor(frameId).revision;
}

export function releaseArtboardTileCache(frameId: string): void {
  caches.delete(String(frameId || '').trim());
}

export function artboardTileCacheStats(frameId?: string): {
  frames: number;
  tiles: number;
} {
  if (frameId) {
    const c = caches.get(String(frameId).trim());
    return { frames: c ? 1 : 0, tiles: c?.tiles.size ?? 0 };
  }
  let tiles = 0;
  for (const c of caches.values()) tiles += c.tiles.size;
  return { frames: caches.size, tiles };
}

/** Intersect scene viewport with plate → plate-local AABB. */
export function plateLocalView(
  plate: { x: number; y: number; width: number; height: number },
  viewScene: { left?: number; top?: number; x?: number; y?: number; width: number; height: number }
): { left: number; top: number; width: number; height: number } {
  const fx = Number(plate.x) || 0;
  const fy = Number(plate.y) || 0;
  const fw = Math.max(1, Number(plate.width) || 1);
  const fh = Math.max(1, Number(plate.height) || 1);
  const vl = (viewScene.left ?? viewScene.x ?? 0) - fx;
  const vt = (viewScene.top ?? viewScene.y ?? 0) - fy;
  const vr = vl + viewScene.width;
  const vb = vt + viewScene.height;
  const left = Math.max(0, vl);
  const top = Math.max(0, vt);
  const right = Math.min(fw, vr);
  const bottom = Math.min(fh, vb);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}
