/**
 * Idle text → glyph outline fill mesh (no atlas).
 * Async outline via buildOutlinePathAsync; paint uses get when ready.
 * Stale-while-revalidate: keep last good mesh while LOD remesh runs (zoom).
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { parseNodeText, parseNodeTextStyle } from '@/components/rcb/scene/document/sceneText';
import { buildOutlinePathAsync } from '@/components/rcb/scene/paint/outlineToPath';
import { densifyPathD, sceneFlatness } from '@/components/rcb/render/vector/contour';
import { densifyLodBucket } from '@/components/rcb/render/vector/densifyPathDJs';
import { buildCompoundFillMeshes } from '@/components/rcb/render/vector/wasmGeom';
import type { FillMesh } from '@/components/rcb/render/vector/tessellateFill';

export type CachedTextOutlineMesh = {
  fp: string;
  fill: FillMesh | null;
  fillRule: 'nonzero' | 'evenodd';
};

const cache = new Map<string, CachedTextOutlineMesh>();
type WantedBuild = {
  fp: string;
  width: number;
  height: number;
  zoom: number;
  dpr: number;
};
/** Desired build while in flight (supersede on zoom). */
const wanted = new Map<string, WantedBuild>();
const inflight = new Map<string, Promise<void>>();
const TEXT_MESH_MAX = 2048;
const touchOrder: string[] = [];
const QUEUE_CONCURRENCY = 3;
type QueueJob = () => Promise<void>;
const jobQueue: QueueJob[] = [];
let queueActive = 0;
let bumpRaf = 0;

function pumpQueue() {
  while (queueActive < QUEUE_CONCURRENCY && jobQueue.length) {
    const job = jobQueue.shift()!;
    queueActive += 1;
    void job().finally(() => {
      queueActive -= 1;
      pumpQueue();
    });
  }
}

function enqueueTextMeshJob(job: QueueJob) {
  jobQueue.push(job);
  pumpQueue();
}

function scheduleIdleBump() {
  if (bumpRaf) return;
  bumpRaf = requestAnimationFrame(() => {
    bumpRaf = 0;
    void import('@/components/rcb/render/sceneRenderer').then((m) => {
      m.bumpSceneCanvasIdlePaint();
    });
  });
}

function touch(id: string) {
  const i = touchOrder.indexOf(id);
  if (i >= 0) touchOrder.splice(i, 1);
  touchOrder.push(id);
  while (touchOrder.length > TEXT_MESH_MAX) {
    const drop = touchOrder.shift();
    if (drop) cache.delete(drop);
  }
}

function fillUsable(fill: FillMesh | null | undefined): fill is FillMesh {
  return Boolean(fill && fill.triangleCount > 0 && fill.positions.length >= 6);
}

/** Layout + style fingerprint — must match idle text paint fields. */
export function textOutlineGeomFingerprint(
  node: SceneNodeInput,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number }
): string {
  const attrs = node.attrs || {};
  const style = parseNodeTextStyle(attrs);
  const w = Math.max(1, Number(opts?.width ?? node.width) || 1);
  const h = Math.max(1, Number(opts?.height ?? node.height) || 1);
  const lod = densifyLodBucket(opts?.zoom ?? 1, opts?.dpr ?? 1);
  return [
    'textOutline:v3',
    `flat:${lod}`,
    parseNodeText(attrs),
    w.toFixed(2),
    h.toFixed(2),
    String(style.fontSize ?? ''),
    String(style.fontFamily ?? ''),
    String(style.fontWeight ?? ''),
    String(style.fontStyle ?? ''),
    String(style.textAlign ?? ''),
    String(style.lineHeight ?? ''),
    String(style.letterSpacing ?? ''),
    String(style.fill ?? ''),
    String(attrs.textFrame ?? ''),
    String(attrs.verticalAlign ?? ''),
    String(attrs.angle ?? ''),
  ].join('|');
}

export function invalidateTextOutlineMesh(nodeId: string) {
  const id = String(nodeId || '').trim();
  if (!id) return;
  cache.delete(id);
  wanted.delete(id);
  inflight.delete(id);
  const i = touchOrder.indexOf(id);
  if (i >= 0) touchOrder.splice(i, 1);
}

export function clearTextOutlineMeshCache() {
  cache.clear();
  wanted.clear();
  inflight.clear();
  touchOrder.length = 0;
}

/**
 * Ready mesh for paint. Exact fp match preferred; otherwise last good fill
 * (stale-while-revalidate) so zoom remesh does not blank the glyph.
 */
export function getTextOutlineMesh(
  nodeId: string,
  node: SceneNodeInput,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number }
): CachedTextOutlineMesh | null {
  const id = String(nodeId || '').trim();
  if (!id || !node) return null;
  const fp = textOutlineGeomFingerprint(node, opts);
  const hit = cache.get(id);
  if (!hit || !fillUsable(hit.fill)) return null;
  touch(id);
  if (hit.fp === fp) return hit;
  // Stale but drawable — ensureTextOutlineMesh will rebuild for `fp`.
  return hit;
}

/**
 * Kick async outline→mesh when missing/stale. Completes with coalesced idle bump.
 */
export function ensureTextOutlineMesh(
  nodeId: string,
  node: SceneNodeInput,
  opts?: { width?: number; height?: number; zoom?: number; dpr?: number }
): void {
  const id = String(nodeId || '').trim();
  if (!id || !node || String(node.key || '') !== 'text') return;
  const text = parseNodeText(node.attrs || {}).trim();
  if (!text) return;
  const fp = textOutlineGeomFingerprint(node, opts);
  const hit = cache.get(id);
  if (hit && hit.fp === fp && fillUsable(hit.fill)) return;

  const build: WantedBuild = {
    fp,
    width: Math.max(1, Number(opts?.width ?? node.width) || 1),
    height: Math.max(1, Number(opts?.height ?? node.height) || 1),
    zoom: opts?.zoom ?? 1,
    dpr: Math.max(1, Number(opts?.dpr) || 1),
  };
  wanted.set(id, build);
  if (inflight.has(id)) return;

  const runOne = async (req: WantedBuild) => {
    const paintNode: SceneNodeInput = {
      ...node,
      id,
      width: req.width,
      height: req.height,
    };
    const flat = sceneFlatness(req.zoom, req.dpr);
    try {
      const outline = await buildOutlinePathAsync(paintNode);
      const latest = wanted.get(id);
      if (latest && latest.fp !== req.fp) return;
      const d = String(outline?.pathD || '').trim();
      if (!d) {
        if (!fillUsable(cache.get(id)?.fill)) {
          cache.set(id, { fp: req.fp, fill: null, fillRule: 'evenodd' });
          touch(id);
        }
        return;
      }
      const fillRule = outline?.fillRule === 'nonzero' ? 'nonzero' : 'evenodd';
      const points = densifyPathD(d, flat);
      const fill = buildCompoundFillMeshes(points, fillRule);
      const latest2 = wanted.get(id);
      if (latest2 && latest2.fp !== req.fp) return;
      if (!fillUsable(fill)) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn('[textOutlineMesh] empty fill', id, 'tris', fill?.triangleCount ?? 0);
        }
        if (!fillUsable(cache.get(id)?.fill)) {
          cache.set(id, { fp: req.fp, fill: null, fillRule });
          touch(id);
        }
        return;
      }
      cache.set(id, { fp: req.fp, fill, fillRule });
      touch(id);
      scheduleIdleBump();
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn('[textOutlineMesh] build failed', id, err);
      }
      if (!fillUsable(cache.get(id)?.fill)) {
        cache.set(id, { fp: req.fp, fill: null, fillRule: 'evenodd' });
      }
    }
  };

  const tracked = new Promise<void>((resolve) => {
    enqueueTextMeshJob(async () => {
      try {
        let guard = 8;
        while (guard-- > 0) {
          const req = wanted.get(id);
          if (!req) break;
          wanted.delete(id);
          await runOne(req);
          if (!wanted.has(id)) break;
        }
      } finally {
        inflight.delete(id);
        resolve();
        const pending = wanted.get(id);
        if (pending) {
          const again = cache.get(id);
          if (!(again && again.fp === pending.fp && fillUsable(again.fill))) {
            ensureTextOutlineMesh(id, node, {
              width: pending.width,
              height: pending.height,
              zoom: pending.zoom,
              dpr: pending.dpr,
            });
          }
        }
      }
    });
  });
  inflight.set(id, tracked);
}

/** Test helper: inject a ready mesh from path `d`. */
export function setTextOutlineMeshForTests(
  nodeId: string,
  node: SceneNodeInput,
  pathD: string,
  opts?: {
    width?: number;
    height?: number;
    fillRule?: 'nonzero' | 'evenodd';
    zoom?: number;
    dpr?: number;
  }
): CachedTextOutlineMesh | null {
  const id = String(nodeId || '').trim();
  if (!id) return null;
  const fp = textOutlineGeomFingerprint(node, opts);
  const fillRule = opts?.fillRule === 'nonzero' ? 'nonzero' : 'evenodd';
  const flat = sceneFlatness(opts?.zoom ?? 1, opts?.dpr ?? 1);
  const fill = buildCompoundFillMeshes(densifyPathD(pathD, flat), fillRule);
  const entry: CachedTextOutlineMesh = { fp, fill, fillRule };
  cache.set(id, entry);
  touch(id);
  return entry;
}
