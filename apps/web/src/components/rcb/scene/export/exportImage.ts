/**
 * Kit / Kit-backed scene export (PNG preferred; SVG via Kit buildSVGString when available).
 *
 * Replaces the deleted paint/exportImage SoA + sceneToSvg dual path. Public API
 * signatures match the previous module so existing imports keep compiling.
 *
 * Limitations:
 * - SVG export prefers Kit `UIEngine.buildSVGString` / `buildSVGStringForSelection`.
 *   If Kit SVG is unavailable, falls back to a minimal SVG wrapping a PNG raster
 *   (not editable vector geometry).
 * - DomHost-only media (video/lottie shells) is not inked by Kit and will be
 *   missing from Kit raster/SVG exports.
 * - `renderComposerChipThumb` / `renderExport` return null when the canvas engine
 *   is not mounted (no SoA fallback).
 */
import { imageSrcToFile } from '@/utils/uploadImage';
import { resolveApiUrl } from '@/utils/apiBase';
import { getToken } from '@/utils/token';
import { withTimeout } from '@/utils/withTimeout';
import { getCanvasEngine } from '@/components/rcb/canvas/KitCanvasHost';
import { kitIdForRcbId } from '@/components/rcb/canvas/kitBridge';
import { isExportableSceneNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { strokeVisualOutset } from '@/components/rcb/scene/document/sceneEffects';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
import { nodeNeedsPuppetWarp } from '@/components/editor/nodes/ImageNode/puppet/puppetModel';
import { bakePuppetDataUrlForNode } from '@/components/editor/nodes/ImageNode/puppet/puppetBake';
import { getAnimationWorkbenchPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';

const EXPORT_HREF_FETCH_TIMEOUT_MS = 10_000;

export type ExportImageFormat = 'png' | 'jpeg' | 'svg';

/**
 * Browser canvas hard limits (Chrome ~16384/edge; area also capped).
 * Stay under both so 4× of large selections fails in the UI instead of at download.
 */
export const MAX_EXPORT_CANVAS_EDGE = 16384;
export const MAX_EXPORT_CANVAS_AREA = 268_435_456; // 16384²

export type ExportImageOptions = {
  /** Output scale relative to scene pixels (1 = document / selection size). */
  multiplier?: number;
  format?: ExportImageFormat;
  /** When true, JPEG uses lower quality; PNG unchanged. */
  compress?: boolean;
  /** Optional filename stem (without extension). */
  filename?: string;
  /** Export only the given nodes (or current selection bbox). */
  selectionOnly?: boolean;
  /** Node ids to include when selectionOnly is true. */
  nodeIds?: string[];
  /** Crop region in scene coords (artboard / frame). Overrides selection bbox. */
  crop?: { x: number; y: number; width: number; height: number } | null;
  /** Fill behind crop (HTML frame bg is not in the SVG board). */
  backgroundColor?: string;
  /** Scene document — preferred for selection crop boxes. */
  document?: SceneDocument | null;
};

export type ExportAffixMode = 'prefix' | 'suffix';

export type ExportSlotConfig = {
  id: string;
  scale: number;
  affixMode: ExportAffixMode;
  affix: string;
  format: ExportImageFormat;
};

type SceneBox = { x: number; y: number; width: number; height: number };

type KitColor = { r: number; g: number; b: number; a: number };

/** True when width×scale / height×scale fit in a browser canvas. */
export function isExportScaleSafe(
  width: number,
  height: number,
  scale: number
): boolean {
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const s = Math.max(0.01, Number(scale) || 1);
  const outW = w * s;
  const outH = h * s;
  if (outW > MAX_EXPORT_CANVAS_EDGE || outH > MAX_EXPORT_CANVAS_EDGE) return false;
  if (outW * outH > MAX_EXPORT_CANVAS_AREA) return false;
  return true;
}

/** Largest scale ≤ preferred that still fits the canvas budget. */
export function clampExportScale(
  width: number,
  height: number,
  preferred: number
): number {
  const want = Math.max(0.01, Number(preferred) || 1);
  if (isExportScaleSafe(width, height, want)) return want;
  const w = Math.max(1, Number(width) || 1);
  const h = Math.max(1, Number(height) || 1);
  const byEdge = Math.min(MAX_EXPORT_CANVAS_EDGE / w, MAX_EXPORT_CANVAS_EDGE / h);
  const byArea = Math.sqrt(MAX_EXPORT_CANVAS_AREA / (w * h));
  return Math.max(0.01, Math.min(want, byEdge, byArea));
}

function isTauriShell(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__ || import.meta.env.TAURI_ENV_PLATFORM);
}

function clickDownloadLink(href: string, filename: string) {
  const a = window.document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  window.document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveDialogFilters(filename: string): { name: string; extensions: string[] }[] | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  if (!m) return undefined;
  const ext = m[1].toLowerCase();
  return [{ name: ext.toUpperCase(), extensions: [ext] }];
}

/** Decode a data: URL without `fetch` — Tauri/WebView often blocks or empties data: fetches. */
function blobFromDataUrl(dataUrl: string): Blob | null {
  try {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    const header = dataUrl.slice(0, comma);
    const data = dataUrl.slice(comma + 1);
    const mime = /data:([^;,]+)/i.exec(header)?.[1] || 'application/octet-stream';
    if (/;base64/i.test(header)) {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(data)], { type: mime });
  } catch {
    return null;
  }
}

export type DownloadFileResult = 'saved' | 'cancelled' | 'failed';

/**
 * Trigger a file download. Web: `<a download>`. Tauri WebView ignores that, so use
 * a native Save dialog + fs write instead.
 *
 * - `saved`: wrote (or browser download started)
 * - `cancelled`: user closed the Save dialog
 * - `failed`: write/encode error
 */
export async function downloadFileBlob(
  blob: Blob,
  filename: string
): Promise<DownloadFileResult> {
  const safeName = sanitizeFilename(filename) || 'export';
  if (isTauriShell()) {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { writeFile } = await import('@tauri-apps/plugin-fs');
      const picked = await save({
        defaultPath: safeName,
        filters: saveDialogFilters(safeName),
      });
      if (picked == null || picked === '') return 'cancelled';
      const path = String(picked).replace(/^file:\/\//i, '');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await writeFile(path, bytes);
      return 'saved';
    } catch (err) {
      console.warn('[download] tauri save failed', err);
      return 'failed';
    }
  }
  const url = URL.createObjectURL(blob);
  clickDownloadLink(url, safeName);
  // Defer revoke — some browsers cancel the download if the blob URL dies immediately.
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000);
  return 'saved';
}

async function downloadDataUrl(
  dataUrl: string,
  filename: string
): Promise<DownloadFileResult> {
  const blob = blobFromDataUrl(dataUrl);
  if (!blob || !(blob.size > 0)) return 'failed';
  return downloadFileBlob(blob, filename);
}

export function sanitizeFilename(name: string) {
  return (
    String(name || 'export')
      // Windows-forbidden chars + C0 controls (keep * and - as literals, not a range).
      // eslint-disable-next-line no-control-regex -- intentional strip of C0 controls
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
      .trim() || 'export'
  );
}

export function buildExportFilename(
  base: string,
  affixMode: ExportAffixMode,
  affix: string
) {
  const stem = sanitizeFilename(base);
  const part = sanitizeFilename(affix).replace(/^\.+/, '');
  if (!part) return stem;
  return affixMode === 'prefix' ? `${part}${stem}` : `${stem}${part}`;
}

function resolveExportMultiplier(requested: number) {
  return Math.min(6, Math.max(0.25, Number(requested) || 1));
}

function rotatedAabb(x: number, y: number, w: number, h: number, angleDeg: number): SceneBox {
  if (!angleDeg) return { x, y, width: w, height: h };
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ] as const) {
    const dx = px - cx;
    const dy = py - cy;
    const rx = cx + dx * cos - dy * sin;
    const ry = cy + dx * sin + dy * cos;
    minX = Math.min(minX, rx);
    minY = Math.min(minY, ry);
    maxX = Math.max(maxX, rx);
    maxY = Math.max(maxY, ry);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function boxFromSceneNode(document: SceneDocument, node: SceneNodeInput): SceneBox | null {
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  const w = Number(node.width);
  const h = Number(node.height);
  if (![left, top, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
  const angle = Number(node.attrs?.angle) || 0;
  const geom = rotatedAabb(left, top, w, h, angle);
  const outset = Math.max(0, strokeVisualOutset(node));
  if (!(outset > 0)) return geom;
  return {
    x: geom.x - outset,
    y: geom.y - outset,
    width: geom.width + outset * 2,
    height: geom.height + outset * 2,
  };
}

/** Integer scene crop — fractional viewBox origins make 1px strokes look uneven after rasterize. */
function snapExportCrop(crop: SceneBox): SceneBox {
  const x0 = Math.floor(crop.x);
  const y0 = Math.floor(crop.y);
  const x1 = Math.ceil(crop.x + crop.width);
  const y1 = Math.ceil(crop.y + crop.height);
  return {
    x: x0,
    y: y0,
    width: Math.max(1, x1 - x0),
    height: Math.max(1, y1 - y0),
  };
}

function unionDocumentNodeBoxes(
  document: SceneDocument,
  nodeIds: string[]
): SceneBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let hit = false;
  for (const id of nodeIds) {
    const node = document.deltaSetLike?.[id];
    if (!node || !isExportableSceneNode(node)) continue;
    const box = boxFromSceneNode(document, node);
    if (!box) continue;
    hit = true;
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!hit) return null;
  return snapExportCrop({
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  });
}

function parseCssColor(css: string | null | undefined): KitColor | null {
  const s = String(css || '').trim();
  if (!s || s === 'transparent' || s === 'none') return null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a,
    };
  }
  const rgba =
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
  if (rgba) {
    return {
      r: Number(rgba[1]) / 255,
      g: Number(rgba[2]) / 255,
      b: Number(rgba[3]) / 255,
      a: rgba[4] != null ? Number(rgba[4]) : 1,
    };
  }
  return null;
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('blob-read-failed'));
    reader.readAsDataURL(blob);
  });
}

/** Last-resort: draw via HTMLImageElement (works when img already paints on canvas). */
function rasterizeViaHtmlImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const absolute = src.startsWith('/') ? resolveApiUrl(src) : src;
    const el = new Image();
    let settled = false;
    const finish = (data: string | null) => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    el.onload = () => {
      try {
        const w = Math.max(1, el.naturalWidth || el.width || 1);
        const h = Math.max(1, el.naturalHeight || el.height || 1);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(el, 0, 0);
        finish(canvas.toDataURL('image/png'));
      } catch {
        finish(null);
      }
    };
    el.onerror = () => finish(null);
    try {
      el.crossOrigin = 'anonymous';
    } catch {
      /* ignore */
    }
    el.src = absolute;
  });
}

async function fetchHrefAsDataUrl(
  href: string,
  opts?: { uploadKey?: string | null }
): Promise<string | null> {
  return withTimeout(fetchHrefAsDataUrlInner(href, opts), EXPORT_HREF_FETCH_TIMEOUT_MS, 'export_href_timeout').catch(
    () => null
  );
}

async function fetchHrefAsDataUrlInner(
  href: string,
  opts?: { uploadKey?: string | null }
): Promise<string | null> {
  const src = (href || '').trim();
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  try {
    const file = await imageSrcToFile(src, 'export-img.png', {
      uploadKey: opts?.uploadKey,
    });
    if (file && file.size >= 8) return await blobToDataUrl(file);
  } catch (err) {
    console.warn('[export] imageSrcToFile failed', err);
  }
  try {
    const absolute = src.startsWith('/') ? resolveApiUrl(src) : src;
    const headers: HeadersInit = {};
    const token = getToken();
    if (token && (src.startsWith('/api/') || absolute.includes('/api/v1/uploads/'))) {
      headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(absolute, { headers, mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    if (!blob || blob.size < 8) throw new Error('empty body');
    return await blobToDataUrl(blob);
  } catch {
    /* fall through to HTMLImageElement */
  }
  try {
    return await rasterizeViaHtmlImage(src);
  } catch {
    return null;
  }
}

/**
 * Blob-URL SVG→canvas cannot load external <image> hrefs (CORS / blob policy).
 * Inline every raster as a data URL before rasterizing.
 * @param opts.failClosed default true — throw if any non-data image cannot be embedded
 *   (export). Pass false for list thumbnails (best-effort; keep what inlined).
 */
export async function inlineSvgImages(
  svgString: string,
  sceneDocument?: SceneDocument | null,
  opts?: { failClosed?: boolean }
): Promise<string> {
  const failClosed = opts?.failClosed !== false;
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return svgString;
  const images = Array.from(doc.querySelectorAll('image'));
  if (!images.length) return svgString;

  const uploadKeyBySrc = new Map<string, string>();
  const nodes = sceneDocument?.deltaSetLike;
  if (nodes && typeof nodes === 'object') {
    for (const node of Object.values(nodes) as SceneNode[]) {
      const key = String(node?.attrs?.uploadKey || '').trim();
      if (!key) continue;
      const src = String(node?.attrs?.src || '').trim();
      if (src) uploadKeyBySrc.set(src, key);
      const fillSrc = String(node?.attrs?.['fill-image-src'] || '').trim();
      if (fillSrc) uploadKeyBySrc.set(fillSrc, key);
    }
  }

  const failures: string[] = [];

  await Promise.all(
    images.map(async (el) => {
      let href =
        el.getAttribute('href') ||
        el.getAttribute('xlink:href') ||
        el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
        '';
      if (href.startsWith('data:')) return;

      const host = el.closest('[data-scene-node-id]');
      const nodeId = host?.getAttribute('data-scene-node-id') || '';
      const sceneNode = nodeId ? sceneDocument?.deltaSetLike?.[nodeId] : null;
      const sceneSrc = String(sceneNode?.attrs?.src || '').trim();
      if (!href && sceneSrc) href = sceneSrc;
      const fetchSrc = sceneSrc || href;
      if (!fetchSrc) return;

      const uploadKey =
        String(sceneNode?.attrs?.uploadKey || '').trim() ||
        uploadKeyBySrc.get(fetchSrc) ||
        uploadKeyBySrc.get(href) ||
        null;

      const data = await fetchHrefAsDataUrl(fetchSrc, { uploadKey });
      if (!data) {
        failures.push(fetchSrc.slice(0, 96));
        return;
      }
      let finalData = data;
      if (sceneNode && nodeNeedsPuppetWarp(sceneNode)) {
        const frameId = sceneDocument
          ? resolveAnimationFrameId(sceneDocument, sceneNode)
          : null;
        let fps = 30;
        if (frameId && sceneDocument) {
          const frame = (sceneDocument.frames || []).find((f) => String(f?.id) === frameId);
          const n = Math.round(Number(frame?.fps) || 30);
          if (n > 0) fps = n;
        }
        const frame = secToFrame(getAnimationWorkbenchPlayheadSec(), fps);
        const baked = await bakePuppetDataUrlForNode(sceneNode, {
          frame,
          sourceDataUrl: data,
        });
        if (baked) finalData = baked;
      }
      el.setAttribute('href', finalData);
      el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', finalData);
      el.removeAttribute('xlink:href');
    })
  );

  if (failures.length && failClosed) {
    throw new Error(`export-inline-failed:${failures.length}:${failures[0]}`);
  }

  const root = doc.documentElement;
  if (!root.getAttribute('xmlns')) {
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  if (!root.getAttribute('xmlns:xlink')) {
    root.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  }
  return new XMLSerializer().serializeToString(root);
}

/** Encode / tip-bake prefer OffscreenCanvas worker (SVG decode stays on main). */
function canUseRasterWorker(): boolean {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function'
  );
}

let rasterWorker: Worker | null = null;
let rasterWorkerId = 1;
const rasterWorkerWaiters = new Map<
  number,
  { resolve: (url: string) => void; reject: (err: Error) => void }
>();

function getRasterWorker(): Worker | null {
  if (!canUseRasterWorker()) return null;
  if (rasterWorker) return rasterWorker;
  try {
    const w = new Worker(new URL('./exportRaster.worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; dataUrl?: string; error?: string }>) => {
      const { id, ok, dataUrl, error } = ev.data || {};
      const waiter = rasterWorkerWaiters.get(id);
      if (!waiter) return;
      rasterWorkerWaiters.delete(id);
      if (ok && dataUrl) waiter.resolve(dataUrl);
      else waiter.reject(new Error(error || 'raster-worker-failed'));
    };
    w.onerror = () => {
      for (const [, waiter] of rasterWorkerWaiters) {
        waiter.reject(new Error('raster-worker-crashed'));
      }
      rasterWorkerWaiters.clear();
      rasterWorker = null;
    };
    rasterWorker = w;
    return w;
  } catch {
    return null;
  }
}

function encodeBitmapInWorker(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mime: string,
  quality?: number,
  transparent = false,
  backgroundColor?: string
): Promise<string> {
  const w = getRasterWorker();
  if (!w) {
    bitmap.close();
    return Promise.reject(new Error('no-raster-worker'));
  }
  const id = rasterWorkerId++;
  return new Promise((resolve, reject) => {
    rasterWorkerWaiters.set(id, { resolve, reject });
    try {
      w.postMessage(
        {
          kind: 'encode',
          id,
          bitmap,
          width,
          height,
          mime,
          quality,
          transparent,
          backgroundColor,
        },
        [bitmap]
      );
    } catch (err) {
      rasterWorkerWaiters.delete(id);
      try {
        bitmap.close();
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function paintBitmapToCanvas(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: CanvasImageSource,
  pw: number,
  ph: number,
  opts?: { transparent?: boolean; backgroundColor?: string; sourceW?: number; sourceH?: number }
) {
  if (!opts?.transparent) {
    const bg = String(opts?.backgroundColor || '').trim();
    ctx.fillStyle = bg && bg !== 'transparent' ? bg : '#ffffff';
    ctx.fillRect(0, 0, pw, ph);
  }
  const sw = Math.max(1, Math.round(Number(opts?.sourceW) || 0));
  const sh = Math.max(1, Math.round(Number(opts?.sourceH) || 0));
  const needsScale = sw > 0 && sh > 0 ? sw !== pw || sh !== ph : true;
  ctx.imageSmoothingEnabled = needsScale;
  if (needsScale && 'imageSmoothingQuality' in ctx) {
    (ctx as CanvasRenderingContext2D).imageSmoothingQuality = 'high';
  }
  ctx.drawImage(bitmap, 0, 0, pw, ph);
}

function rasterizeSvgStringMainThread(
  svgString: string,
  width: number,
  height: number,
  mime: string,
  quality?: number,
  transparent = false,
  backgroundColor?: string
) {
  return new Promise<string>((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const pw = Math.max(1, Math.round(width));
        const ph = Math.max(1, Math.round(height));
        const canvas = window.document.createElement('canvas');
        canvas.width = pw;
        canvas.height = ph;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('no-2d'));
          return;
        }
        paintBitmapToCanvas(ctx, img, pw, ph, {
          transparent,
          backgroundColor,
          sourceW: img.naturalWidth || img.width,
          sourceH: img.naturalHeight || img.height,
        });
        resolve(canvas.toDataURL(mime, quality));
      } catch (err) {
        reject(err);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('svg-image-load-failed'));
    };
    img.src = url;
  });
}

async function rasterizeSvgToBitmap(
  svgString: string,
  width: number,
  height: number
): Promise<ImageBitmap> {
  const pw = Math.max(1, Math.round(width));
  const ph = Math.max(1, Math.round(height));
  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });

  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, {
        resizeWidth: pw,
        resizeHeight: ph,
        resizeQuality: 'high',
      });
    } catch {
      /* fall through */
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('svg-image-load-failed'));
      el.src = url;
    });
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(img, {
          resizeWidth: pw,
          resizeHeight: ph,
          resizeQuality: 'high',
        });
      } catch {
        return await createImageBitmap(img);
      }
    }
    throw new Error('no-createImageBitmap');
  } finally {
    URL.revokeObjectURL(url);
  }
}

function encodeBitmapOnMainThread(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mime: string,
  quality?: number,
  transparent = false,
  backgroundColor?: string
): string {
  const pw = Math.max(1, Math.round(width));
  const ph = Math.max(1, Math.round(height));
  const canvas = window.document.createElement('canvas');
  canvas.width = pw;
  canvas.height = ph;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new Error('no-2d');
  }
  paintBitmapToCanvas(ctx, bitmap, pw, ph, {
    transparent,
    backgroundColor,
    sourceW: bitmap.width,
    sourceH: bitmap.height,
  });
  bitmap.close();
  return canvas.toDataURL(mime, quality);
}

/** SVG string → data URL. Decode at target size; PNG/JPEG encode prefers worker. */
export async function rasterizeSvgString(
  svgString: string,
  width: number,
  height: number,
  mime: string,
  quality?: number,
  transparent = false,
  backgroundColor?: string
): Promise<string> {
  const pw = Math.max(1, Math.round(width));
  const ph = Math.max(1, Math.round(height));

  try {
    const bitmap = await rasterizeSvgToBitmap(svgString, pw, ph);
    if (canUseRasterWorker()) {
      try {
        return await encodeBitmapInWorker(
          bitmap,
          pw,
          ph,
          mime,
          quality,
          transparent,
          backgroundColor
        );
      } catch {
        /* Worker path transfers/closes the bitmap — rebuild via Image fallback. */
      }
    } else {
      return encodeBitmapOnMainThread(
        bitmap,
        pw,
        ph,
        mime,
        quality,
        transparent,
        backgroundColor
      );
    }
  } catch {
    /* Image() fallback below */
  }

  return rasterizeSvgStringMainThread(
    svgString,
    pw,
    ph,
    mime,
    quality,
    transparent,
    backgroundColor
  );
}

function kitBoundsFromCrop(crop: SceneBox): { x: number; y: number; w: number; h: number } {
  return { x: crop.x, y: crop.y, w: crop.width, h: crop.height };
}

function resolveExportCrop(options: ExportImageOptions): SceneBox | null {
  const {
    selectionOnly = false,
    nodeIds,
    document,
    crop: cropOpt,
  } = options;

  if (cropOpt && cropOpt.width > 0 && cropOpt.height > 0) {
    return snapExportCrop({
      x: Number(cropOpt.x) || 0,
      y: Number(cropOpt.y) || 0,
      width: Math.max(1, Number(cropOpt.width) || 1),
      height: Math.max(1, Number(cropOpt.height) || 1),
    });
  }

  const ids = (nodeIds || []).filter((id) => {
    if (!id) return false;
    if (!document?.deltaSetLike?.[id]) return true;
    return isExportableSceneNode(document.deltaSetLike[id]);
  });

  if (selectionOnly) {
    if (!ids.length || !document) return null;
    // Prefer live Kit node bounds when mapped; fall back to document AABB.
    const engine = getCanvasEngine();
    if (engine) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let hit = false;
      for (const rcbId of ids) {
        const kitId = kitIdForRcbId(rcbId);
        if (kitId == null) continue;
        try {
          const b = engine.scene.getNodeBounds(kitId);
          if (!b || b.length < 4) continue;
          if (!(b[2] > b[0]) || !(b[3] > b[1])) continue;
          hit = true;
          minX = Math.min(minX, b[0]);
          minY = Math.min(minY, b[1]);
          maxX = Math.max(maxX, b[2]);
          maxY = Math.max(maxY, b[3]);
        } catch {
          /* ignore */
        }
      }
      if (hit) {
        return snapExportCrop({
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        });
      }
    }
    return unionDocumentNodeBoxes(document, ids);
  }

  // Full export: artboard union from Kit, else document frames, else default page.
  const engine = getCanvasEngine();
  if (engine) {
    try {
      const arts = engine.scene.getArtboards?.() ?? [];
      if (arts.length === 1 && arts[0]) {
        const ab = arts[0];
        return snapExportCrop({
          x: Number(ab.x) || 0,
          y: Number(ab.y) || 0,
          width: Math.max(1, Number(ab.w) || 1),
          height: Math.max(1, Number(ab.h) || 1),
        });
      }
      const b = engine.renderer.getArtboardsBounds?.();
      if (b && b.w > 0 && b.h > 0) {
        return snapExportCrop({ x: b.x, y: b.y, width: b.w, height: b.h });
      }
    } catch {
      /* fall through */
    }
  }

  if (document) {
    const frames = Array.isArray(document.frames) ? document.frames : [];
    if (frames.length) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const f of frames) {
        const x = Number(f?.x) || 0;
        const y = Number(f?.y) || 0;
        const w = Math.max(1, Number(f?.width) || 1);
        const h = Math.max(1, Number(f?.height) || 1);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + w);
        maxY = Math.max(maxY, y + h);
      }
      if (Number.isFinite(minX)) {
        return snapExportCrop({
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        });
      }
    }
  }

  return snapExportCrop({ x: 0, y: 0, width: 794, height: 1123 });
}

function resolveKitSelectionIds(options: ExportImageOptions): number[] {
  if (!options.selectionOnly && !(options.crop && (options.nodeIds || []).length)) {
    return [];
  }
  const ids = (options.nodeIds || []).filter(Boolean);
  const kitIds: number[] = [];
  for (const rcbId of ids) {
    const kitId = kitIdForRcbId(rcbId);
    if (kitId != null) kitIds.push(kitId);
  }
  return kitIds;
}

async function pngBlobToJpegDataUrl(
  pngBlob: Blob,
  quality: number,
  backgroundColor?: string
): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(pngBlob);
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.max(1, bitmap.width);
    canvas.height = Math.max(1, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return null;
    }
    const bg = String(backgroundColor || '').trim();
    ctx.fillStyle = bg && bg !== 'transparent' ? bg : '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return null;
  }
}

/** Minimal SVG wrapper around a PNG data URL when Kit vector SVG is unavailable. */
function svgWrapperAroundPngDataUrl(
  dataUrl: string,
  width: number,
  height: number
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  // Note: raster-backed SVG — geometry is not editable vectors.
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image href="${dataUrl}" width="${w}" height="${h}" preserveAspectRatio="none"/>` +
    `</svg>`
  );
}

export type ExportRenderResult =
  | { kind: 'svg'; svgString: string; width: number; height: number }
  | { kind: 'raster'; dataUrl: string; width: number; height: number; format: 'png' | 'jpeg' };

/** Build SVG / raster bytes without triggering a download (Kit exportPNG / buildSVGString). */
export async function renderExport(options: ExportImageOptions): Promise<ExportRenderResult | null> {
  const {
    multiplier = 2,
    format = 'png',
    compress = false,
    backgroundColor,
  } = options;

  try {
    const engine = getCanvasEngine();
    if (!engine) {
      console.warn('[export] renderExport: canvas engine not mounted');
      return null;
    }

    const crop = resolveExportCrop(options);
    if (!crop) return null;

    const m = resolveExportMultiplier(multiplier);
    const fmt = format === 'svg' ? 'svg' : format === 'jpeg' ? 'jpeg' : 'png';
    const quality = fmt === 'jpeg' ? (compress ? 0.78 : 0.95) : 1;

    if (fmt !== 'svg' && !isExportScaleSafe(crop.width, crop.height, m)) {
      console.warn(
        `[export] scale ${m}× exceeds canvas limit for ${crop.width}×${crop.height}`
      );
      return null;
    }

    const outW = Math.max(1, Math.round(crop.width * m));
    const outH = Math.max(
      1,
      Math.round((outW * crop.height) / Math.max(1e-6, crop.width))
    );
    const bounds = kitBoundsFromCrop(crop);
    const bg = parseCssColor(backgroundColor);
    const kitIds = resolveKitSelectionIds(options);

    if (fmt === 'svg') {
      try {
        const ui = engine.ui as {
          buildSVGString?: (
            b?: { x: number; y: number; w: number; h: number },
            c?: KitColor
          ) => string;
          buildSVGStringForSelection?: (
            ids: number[],
            b?: { x: number; y: number; w: number; h: number },
            c?: KitColor
          ) => string;
        };
        let svgString = '';
        if (kitIds.length && typeof ui.buildSVGStringForSelection === 'function') {
          svgString = ui.buildSVGStringForSelection(kitIds, bounds, bg ?? undefined);
        } else if (typeof ui.buildSVGString === 'function') {
          svgString = ui.buildSVGString(bounds, bg ?? undefined);
        }
        if (svgString) {
          return { kind: 'svg', svgString, width: outW, height: outH };
        }
      } catch (err) {
        console.warn('[export] Kit SVG build failed; wrapping PNG', err);
      }
      // Prefer working PNG wrapped as SVG over failing the export.
      const pngBlob = kitIds.length
        ? engine.scene.withOnlyVisible(kitIds, () =>
            engine.exportPNG(m, bounds, bg, { w: outW, h: outH })
          )
        : engine.exportPNG(m, bounds, bg, { w: outW, h: outH });
      if (!pngBlob) return null;
      const dataUrl = await blobToDataUrl(pngBlob);
      return {
        kind: 'svg',
        svgString: svgWrapperAroundPngDataUrl(dataUrl, outW, outH),
        width: outW,
        height: outH,
      };
    }

    const runExport = () => engine.exportPNG(m, bounds, bg, { w: outW, h: outH });
    const pngBlob =
      kitIds.length > 0
        ? engine.scene.withOnlyVisible(kitIds, runExport)
        : runExport();
    if (!pngBlob || !(pngBlob.size > 0)) return null;

    if (fmt === 'jpeg') {
      const dataUrl = await pngBlobToJpegDataUrl(pngBlob, quality, backgroundColor);
      if (!dataUrl || dataUrl === 'data:,') return null;
      return { kind: 'raster', dataUrl, width: outW, height: outH, format: 'jpeg' };
    }

    const dataUrl = await blobToDataUrl(pngBlob);
    if (!dataUrl || dataUrl === 'data:,') return null;
    return { kind: 'raster', dataUrl, width: outW, height: outH, format: 'png' };
  } catch (err) {
    console.warn('[export] renderExport failed', err);
    return null;
  }
}

export type ExportOnceResult = DownloadFileResult | 'render-failed';

async function exportOnce(options: ExportImageOptions): Promise<ExportOnceResult> {
  const filename = options.filename || 'export';
  try {
    const rendered = await renderExport(options);
    if (!rendered) return 'render-failed';
    if (rendered.kind === 'svg') {
      const blob = new Blob([rendered.svgString], { type: 'image/svg+xml;charset=utf-8' });
      return downloadFileBlob(blob, `${sanitizeFilename(filename)}.svg`);
    }
    const ext = rendered.format === 'jpeg' ? 'jpg' : 'png';
    const blob = blobFromDataUrl(rendered.dataUrl);
    if (blob && blob.size > 0) {
      return downloadFileBlob(blob, `${sanitizeFilename(filename)}.${ext}`);
    }
    return downloadDataUrl(rendered.dataUrl, `${sanitizeFilename(filename)}.${ext}`);
  } catch (err) {
    console.warn('[export] exportOnce failed', err);
    return 'failed';
  }
}

/** Download the scene document as pretty-printed JSON (round-trips with import). */
export async function exportDocumentJson(
  document: SceneDocument,
  filename = 'document'
): Promise<DownloadFileResult> {
  if (!document || typeof document !== 'object') return 'failed';
  const blob = new Blob([JSON.stringify(document, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  return downloadFileBlob(blob, `${sanitizeFilename(filename)}.json`);
}

/**
 * Small PNG data-URL for composer / chat chips (single node, group, or artboard).
 * Best-effort — returns null when the Kit engine is not mounted.
 */
export async function renderComposerChipThumb(opts: {
  document: SceneDocument;
  nodeIds?: string[];
  frameId?: string | null;
  /** Longest edge of the raster preview (device pixels). */
  maxSide?: number;
}): Promise<string | null> {
  const doc = opts.document;
  if (!doc) return null;
  if (!getCanvasEngine()) return null;
  const maxSide = Math.max(32, Math.min(160, Number(opts.maxSide) || 96));

  const frameId = String(opts.frameId || '').trim();
  if (frameId) {
    const frames = Array.isArray(doc.frames) ? doc.frames : [];
    const frame = frames.find((f) => f?.id === frameId);
    if (!frame) return null;
    const w = Math.max(1, Number(frame.width) || 1);
    const h = Math.max(1, Number(frame.height) || 1);
    const multiplier = Math.min(2, Math.max(0.25, maxSide / Math.max(w, h)));
    const rendered = await renderExport({
      document: doc,
      format: 'png',
      multiplier,
      crop: {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: w,
        height: h,
      },
      backgroundColor: String(frame.backgroundColor || '#FFFFFF'),
    });
    return rendered?.kind === 'raster' ? rendered.dataUrl : null;
  }

  const nodeIds = (opts.nodeIds || []).filter(Boolean);
  if (!nodeIds.length) return null;

  let maxDim = 1;
  for (const id of nodeIds) {
    const node = doc?.deltaSetLike?.[id];
    if (!node) continue;
    maxDim = Math.max(maxDim, Number(node.width) || 0, Number(node.height) || 0);
  }
  if (nodeIds.length > 1) maxDim = Math.max(maxDim, 240);
  const multiplier = Math.min(2, Math.max(0.25, maxSide / Math.max(maxDim, 1)));
  const rendered = await renderExport({
    document: doc,
    format: 'png',
    multiplier,
    selectionOnly: true,
    nodeIds,
  });
  return rendered?.kind === 'raster' ? rendered.dataUrl : null;
}

/** Rasterize via Kit; with selectionOnly, only the given nodes are exported. */
export function exportFabricImage(options: ExportImageOptions = {}): boolean {
  try {
    if (options.selectionOnly && !(options.nodeIds || []).length) {
      return false;
    }
    async function runExportOnce() {
      try {
        await exportOnce(options);
      } catch (err) {
        console.error(err);
      }
    }
    void runExportOnce();
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

/** Export several scale/format slots for the same selection. */
export async function exportSelectionSlots(opts: {
  nodeIds: string[];
  baseName: string;
  compress: boolean;
  slots: ExportSlotConfig[];
  document?: SceneDocument | null;
}): Promise<{ saved: number; cancelled: number; failed: number }> {
  const { nodeIds, baseName, compress, slots, document } = opts;
  const tally = { saved: 0, cancelled: 0, failed: 0 };
  if (!nodeIds.length || !slots.length) return tally;

  for (const slot of slots) {
    const filename = buildExportFilename(baseName, slot.affixMode, slot.affix);
    const result = await exportOnce({
      selectionOnly: true,
      nodeIds,
      document,
      multiplier: slot.scale,
      format: slot.format,
      compress,
      filename,
    });
    if (result === 'saved') tally.saved += 1;
    else if (result === 'cancelled') tally.cancelled += 1;
    else tally.failed += 1;
  }
  return tally;
}

/** Export an artboard / frame region (scene crop + optional background). */
export async function exportCropSlots(opts: {
  crop: { x: number; y: number; width: number; height: number };
  backgroundColor?: string;
  baseName: string;
  compress: boolean;
  slots: ExportSlotConfig[];
  /** Document context for crop metadata (Kit paints live scene). */
  document?: SceneDocument | null;
}): Promise<{ saved: number; cancelled: number; failed: number }> {
  const { crop, backgroundColor, baseName, compress, slots, document } = opts;
  const tally = { saved: 0, cancelled: 0, failed: 0 };
  if (!crop || !(crop.width > 0) || !(crop.height > 0) || !slots.length) return tally;
  for (const slot of slots) {
    const filename = buildExportFilename(baseName, slot.affixMode, slot.affix);
    const result = await exportOnce({
      crop,
      backgroundColor,
      document,
      multiplier: slot.scale,
      format: slot.format,
      compress,
      filename,
    });
    if (result === 'saved') tally.saved += 1;
    else if (result === 'cancelled') tally.cancelled += 1;
    else tally.failed += 1;
  }
  return tally;
}
