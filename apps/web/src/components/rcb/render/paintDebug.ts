/**
 * `?rcbDebug=paint` — log restamp / artboardTiles / insufficient / domObligatory.
 */
import { getArtboardInkDebugStats } from '@/components/rcb/frames/artboardInkSurface';
import {
  getPaintIntentDebugStats,
  resetPaintIntentDebugStats,
} from '@/components/rcb/render/paintIntent';
import {
  ensureSharedSoaWebglAtlas,
  getSoaAtlasStats,
} from '@/components/rcb/render/webglInstanceAtlas';

let lastLogMs = 0;
let installed = false;

export function isRcbPaintDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const q = new URLSearchParams(window.location.search);
    return q.get('rcbDebug') === 'paint';
  } catch {
    return false;
  }
}

export function collectRcbPaintDebugSnapshot(): {
  restamp: number;
  artboardTiles: number;
  insufficient: number;
  domObligatory: number;
  artboard: ReturnType<typeof getArtboardInkDebugStats>;
  atlasRestamp: number;
} {
  const intent = getPaintIntentDebugStats();
  const atlas = ensureSharedSoaWebglAtlas();
  const atlasStats = atlas ? getSoaAtlasStats(atlas) : null;
  return {
    restamp: intent.restamp + (atlasStats?.restamps || 0),
    artboardTiles: intent.artboardTiles,
    insufficient: intent.insufficient,
    domObligatory: intent.domObligatory,
    artboard: getArtboardInkDebugStats(),
    atlasRestamp: atlasStats?.restamps || 0,
  };
}

/** Throttled console snapshot while `?rcbDebug=paint` is on. */
export function maybeLogRcbPaintDebug(force = false): void {
  if (!isRcbPaintDebugEnabled()) return;
  const now = Date.now();
  if (!force && now - lastLogMs < 1000) return;
  lastLogMs = now;
  // eslint-disable-next-line no-console
  console.info('[rcbDebug=paint]', collectRcbPaintDebugSnapshot());
}

/** Install a lightweight interval logger once per page. */
export function ensureRcbPaintDebugInstalled(): void {
  if (installed || typeof window === 'undefined') return;
  if (!isRcbPaintDebugEnabled()) return;
  installed = true;
  window.setInterval(() => maybeLogRcbPaintDebug(), 2000);
  resetPaintIntentDebugStats();
  // eslint-disable-next-line no-console
  console.info('[rcbDebug=paint] installed');
}
