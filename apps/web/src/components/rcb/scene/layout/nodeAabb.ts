/**
 * Scene AABB helpers for DomHost viewport cull / linear marquee scans.
 * Kit owns ink hit — this is layout math only (no Path2D / quadtree).
 */
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  nodeLeftTop,
  frameSceneBounds,
} from '@/components/rcb/scene/layout/nodeLayout';
import { effectivePaintBox } from '@/components/rcb/core/transformPreview';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import { isArtboardVisibleInDocument } from '@/components/rcb/scene/document/nodeCapabilities';

export type SceneAabb = { minX: number; minY: number; maxX: number; maxY: number };

export function boxesIntersect(a: SceneAabb, b: SceneAabb) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** Bottom→top rank from ROOT/page children (O(N) once per id-list change). */
export function buildIdRankMap(ids: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 1) m.set(ids[i], i);
  return m;
}

/**
 * Order candidate ids by document rank without scanning the full id list.
 * ascending = bottom→top (paint / cull); descending = top→bottom.
 */
export function sortIdsByRank(
  ids: Iterable<string>,
  rank: Map<string, number>,
  opts?: { ascending?: boolean }
): string[] {
  const ascending = opts?.ascending !== false;
  const out = Array.from(ids);
  out.sort((a, b) => {
    const ra = rank.get(a) ?? -1;
    const rb = rank.get(b) ?? -1;
    return ascending ? ra - rb : rb - ra;
  });
  return out;
}

/** Axis AABB in scene space (rotation-expanded). Optional pad for stroke slack. */
export function nodeSceneAabb(
  document: SceneDocument,
  nodeId: string,
  pad = 0
): SceneAabb | null {
  const node = document?.deltaSetLike?.[nodeId];
  if (!node) return null;
  const { left: docLeft, top: docTop } = nodeLeftTop(document, node);
  const paint = effectivePaintBox(
    nodeId,
    {
      left: docLeft,
      top: docTop,
      width: Math.max(1, Number(node.width) || 1),
      height: Math.max(1, Number(node.height) || 1),
    },
    Number(node.attrs?.angle) || 0
  );
  if (paint.hidden) return null;
  const x0 = paint.left;
  const y0 = paint.top;
  const w = paint.width;
  const h = paint.height;
  const angle = paint.angle;
  let minX = x0;
  let minY = y0;
  let maxX = x0 + w;
  let maxY = y0 + h;
  if (Math.abs(angle) > 0.5) {
    const rad = (Math.abs(angle) * Math.PI) / 180;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const bw = w * cos + h * sin;
    const bh = w * sin + h * cos;
    const cx = x0 + w / 2;
    const cy = y0 + h / 2;
    minX = cx - bw / 2;
    minY = cy - bh / 2;
    maxX = cx + bw / 2;
    maxY = cy + bh / 2;
  }
  // Puppet pin displacements can pull ink outside the plate — expand AABB.
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  if (
    node.key === 'image' &&
    (attrs.puppetEnabled === true || attrs.puppetEnabled === 'true')
  ) {
    let maxOut = 0;
    const consider = (raw: unknown) => {
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const dx = Number(o.dx) || 0;
        const dy = Number(o.dy) || 0;
        maxOut = Math.max(maxOut, Math.abs(dx) * w, Math.abs(dy) * h);
      }
    };
    consider(attrs.puppetPins);
    if (Array.isArray(attrs.puppetTrack)) {
      for (const k of attrs.puppetTrack) {
        if (k && typeof k === 'object') consider((k as Record<string, unknown>).pins);
      }
    }
    if (maxOut > 0) {
      minX -= maxOut;
      minY -= maxOut;
      maxX += maxOut;
      maxY += maxOut;
    }
  }
  const stroke = Math.max(0, Number(node.attrs?.['border-width'] ?? 0) || 0);
  const expand = pad + stroke;
  return {
    minX: minX - expand,
    minY: minY - expand,
    maxX: maxX + expand,
    maxY: maxY + expand,
  };
}

/** Artboard plate AABB in the same world space as nodeSceneAabb. */
export function frameSceneAabb(
  document: SceneDocument,
  frameId: string,
  pad = 0
): SceneAabb | null {
  const fid = String(frameId || '').trim();
  if (!fid || !document) return null;
  const frame = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id || '') === fid
  );
  if (!frame || frame.locked || !isArtboardVisibleInDocument(frame)) return null;
  const live = getLiveArtboardFrameGeometry(fid);
  const box = frameSceneBounds(document, frame, live);
  const expand = Math.max(0, pad);
  return {
    minX: box.left - expand,
    minY: box.top - expand,
    maxX: box.left + box.width + expand,
    maxY: box.top + box.height + expand,
  };
}
