/**
 * Shared decoded fill-image cache for SVG paint / puppet bake.
 * Kit owns live ink — on decode, request a Kit render wake.
 */
import { getCanvasEngine } from '@/components/rcb/canvas/KitCanvasHost';

const FILL_IMAGE_CACHE_MAX = 64;

const fillImageCache = new Map<string, CanvasImageSource>();
/** Srcs that painted a non-readable canvas (CORS). */
const fillImageCorsUnsafe = new Set<string>();

/** True when canvas pixels can be read (safe to sample / upload). */
export function canvasPixelsReadable(
  canvas: HTMLCanvasElement | OffscreenCanvas | null | undefined
): boolean {
  if (!canvas) return false;
  try {
    const ctx = canvas.getContext('2d') as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) return false;
    ctx.getImageData(0, 0, 1, 1);
  } catch {
    return false;
  }
  return true;
}

/** Remote http(s) need CORS; blob/data are same-document. */
function fillImageShouldUseCors(url: string): boolean {
  const u = String(url || '').trim();
  if (!u) return false;
  if (u.startsWith('blob:') || u.startsWith('data:') || u.startsWith('file:')) return false;
  return /^https?:\/\//i.test(u) || u.startsWith('//');
}

export function isFillImageCorsUnsafe(src: string): boolean {
  return fillImageCorsUnsafe.has(String(src || '').trim());
}

export function markFillImageCorsUnsafe(src: string): void {
  const url = String(src || '').trim();
  if (url) fillImageCorsUnsafe.add(url);
}

export function imageSourceSize(img: CanvasImageSource): { iw: number; ih: number } {
  if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
    return { iw: img.naturalWidth || img.width || 1, ih: img.naturalHeight || img.height || 1 };
  }
  if (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement) {
    return { iw: img.width || 1, ih: img.height || 1 };
  }
  const anyImg = img as {
    width?: number;
    height?: number;
    naturalWidth?: number;
    naturalHeight?: number;
  };
  return {
    iw: anyImg.naturalWidth || anyImg.width || 1,
    ih: anyImg.naturalHeight || anyImg.height || 1,
  };
}

/** Sync image ready for fill paint. Starts decode when missing; on load wakes Kit. */
export function getFillImageReady(src: string): CanvasImageSource | null {
  const url = String(src || '').trim();
  if (!url) return null;
  const cached = fillImageCache.get(url);
  if (cached) {
    if (typeof HTMLImageElement !== 'undefined' && cached instanceof HTMLImageElement) {
      if (fillImageShouldUseCors(url) && cached.crossOrigin !== 'anonymous') {
        fillImageCache.delete(url);
      } else if (cached.complete && (cached.naturalWidth || cached.width)) {
        return cached;
      } else {
        return null;
      }
    } else {
      return cached;
    }
  }
  if (typeof Image === 'undefined') return null;
  if (fillImageCache.size >= FILL_IMAGE_CACHE_MAX) {
    const oldest = fillImageCache.keys().next().value;
    if (oldest != null) fillImageCache.delete(oldest);
  }
  const img = new Image();
  img.decoding = 'async';
  if (fillImageShouldUseCors(url)) {
    img.crossOrigin = 'anonymous';
  }
  img.src = url;
  fillImageCache.set(url, img);
  if (img.complete && (img.naturalWidth || img.width)) return img;
  if (!(img as HTMLImageElement & { __fillNotify?: boolean }).__fillNotify) {
    (img as HTMLImageElement & { __fillNotify?: boolean }).__fillNotify = true;
    img.addEventListener(
      'load',
      () => {
        getCanvasEngine()?.renderer.requestRender();
      },
      { once: true }
    );
    img.addEventListener(
      'error',
      () => {
        markFillImageCorsUnsafe(url);
        fillImageCache.delete(url);
      },
      { once: true }
    );
  }
  return null;
}

/** Test helper: seed a decoded fill image / canvas (skips network / decode). */
export function setFillImageCacheEntry(src: string, img: CanvasImageSource): void {
  const url = String(src || '').trim();
  if (!url) return;
  fillImageCache.set(url, img);
}

/** Test / dispose helper. */
export function clearFillImageCache(): void {
  fillImageCache.clear();
  fillImageCorsUnsafe.clear();
}
