/**
 * Bake puppet-warped bitmaps for export / Lottie asset embed.
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  effectivePuppetPins,
  nodeNeedsPuppetWarp,
} from '@/components/editor/nodes/ImageNode/puppet/puppetModel';
import { bakePuppetWarpDataUrl } from '@/components/rcb/scene/paint/puppetWarp';
import { getFillImageReady } from '@/components/rcb/scene/media/fillImageCache';

function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  if (typeof Image === 'undefined') return Promise.resolve(null);
  const ready = getFillImageReady(src);
  if (
    ready &&
    typeof HTMLImageElement !== 'undefined' &&
    ready instanceof HTMLImageElement &&
    ready.complete &&
    ready.naturalWidth > 0
  ) {
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Warped PNG data URL, or null when the node does not need puppet warp. */
export async function bakePuppetDataUrlForNode(
  node: SceneNodeInput | null | undefined,
  opts?: { frame?: number; sourceDataUrl?: string }
): Promise<string | null> {
  if (!node || !nodeNeedsPuppetWarp(node)) return null;
  const src =
    String(opts?.sourceDataUrl || '').trim() || String(node.attrs?.src || '').trim();
  if (!src) return null;
  const img = await loadImageElement(src);
  if (!img) return null;
  const frame = Number.isFinite(opts?.frame) ? Number(opts?.frame) : 0;
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  return bakePuppetWarpDataUrl(img, {
    width: Math.max(1, Math.round(Number(node.width) || 1)),
    height: Math.max(1, Math.round(Number(node.height) || 1)),
    pins: effectivePuppetPins(attrs, frame),
    attrs,
  });
}
