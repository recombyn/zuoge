/**
 * Client-side cover rasterization for list-card fallbacks (TemplateThumbnail / doc collage).
 */

import { inlineSvgImages, rasterizeSvgString } from '@/components/rcb/scene/export/exportImage';
import { createDomHostBoard, mountDomHostBoard } from '@/components/rcb/scene/dom/domHostBoard';
import {
  isExportableSceneNode
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  listSceneNodes
} from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  coverDocumentHasContent,
  findPlazaCoverFrame,
  type PlazaCoverFrame,
} from '@/utils/plazaCover';

const MAX_EDGE = 480;
const MAX_TILES = 4;
const WEBP_QUALITY = 0.82;
/** Skip decorative noise smaller than ~1% of the artboard (or 40px edge). */
const MIN_ELEMENT_EDGE = 40;
/** Case preview modal — keep panels sharp (not list-card WebP). */
export const PREVIEW_PNG_MAX_EDGE = 1600;

export type ThumbRasterOptions = {
  allowEmpty?: boolean;
  format?: 'webp' | 'png' | 'jpeg';
  maxEdge?: number;
};

function paperBackground(document: SceneDocument): string {
  const frame = Array.isArray(document?.frames) ? document.frames[0] : null;
  const fromFrame = String(frame?.backgroundColor || '').trim();
  if (fromFrame && fromFrame !== 'none' && fromFrame !== 'transparent') return fromFrame;
  const fromDoc = String(document?.backgroundColor || '').trim();
  if (fromDoc && fromDoc !== 'none' && fromDoc !== 'transparent') return fromDoc;
  return '#ffffff';
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Same overlap rule as plaza cover extract — node must sit mostly on the artboard. */
function nodeOverlapsFrame(node: Record<string, unknown>, frame: PlazaCoverFrame): boolean {
  const x = num(node.x);
  const y = num(node.y);
  const w = Math.max(1, num(node.width, 1));
  const h = Math.max(1, num(node.height, 1));
  const ow = Math.max(0, Math.min(x + w, frame.x + frame.width) - Math.max(x, frame.x));
  const oh = Math.max(0, Math.min(y + h, frame.y + frame.height) - Math.max(y, frame.y));
  return ow * oh >= w * h * 0.12;
}

/** Media → shape/svg → text → other (collage prefers visual tiles). */
function coverElementTypeRank(key: string): number {
  if (key === 'image' || key === 'video') return 0;
  if (key === 'lottie' || key === 'audio') return 1;
  if (
    key === 'svg' ||
    key === 'path' ||
    key === 'shape' ||
    key === 'rect' ||
    key === 'ellipse' ||
    key === 'circle' ||
    key === 'line'
  ) {
    return 2;
  }
  if (key === 'text') return 3;
  return 4;
}

/** Skip empty media plates (#E5E7EB placeholders) — they steal collage slots from real shapes. */
function coverElementHasVisual(node: Record<string, unknown>): boolean {
  const key = String(node.key || '');
  const attrs =
    node.attrs && typeof node.attrs === 'object'
      ? (node.attrs as Record<string, unknown>)
      : {};
  if (key === 'image' || key === 'video' || key === 'lottie') {
    const src = String(attrs.src || '').trim();
    const poster = String(attrs.poster || '').trim();
    return Boolean(src || poster);
  }
  if (key === 'audio') return Boolean(String(attrs.src || '').trim());
  return true;
}

/**
 * Pick up to 4 exportable scene elements for the home collage.
 * Scope: active/cover artboard when present; rank image-first, then area, then z-order.
 */
export function pickCoverElementIds(document: unknown): string[] {
  if (!document || typeof document !== 'object') return [];
  const frame = findPlazaCoverFrame(document);
  const frameArea = frame ? frame.width * frame.height : 0;
  const minArea = frameArea > 0 ? frameArea * 0.01 : MIN_ELEMENT_EDGE * MIN_ELEMENT_EDGE;

  type Ranked = { id: string; typeRank: number; area: number; z: number };
  const ranked: Ranked[] = [];
  const nodes = listSceneNodes(document as SceneDocument) as Array<{
    id: string;
    node: Record<string, unknown>;
  }>;

  nodes.forEach(({ id, node }, z) => {
    if (!id || !node || typeof node !== 'object') return;
    if (!isExportableSceneNode(node)) return;
    if (!coverElementHasVisual(node)) return;
    if (frame && !nodeOverlapsFrame(node, frame)) return;
    const w = Math.max(1, num(node.width, 1));
    const h = Math.max(1, num(node.height, 1));
    const area = w * h;
    if (area < minArea && Math.min(w, h) < MIN_ELEMENT_EDGE) return;
    ranked.push({
      id: String(id),
      typeRank: coverElementTypeRank(String(node.key || '')),
      area,
      z,
    });
  });

  ranked.sort((a, b) => {
    if (a.typeRank !== b.typeRank) return a.typeRank - b.typeRank;
    if (b.area !== a.area) return b.area - a.area;
    return b.z - a.z;
  });

  return ranked.slice(0, MAX_TILES).map((r) => r.id);
}

/**
 * Mini document with one element on a white board — same finite-board path as list thumbs.
 * Avoids infinite-canvas selection export (shapes often rasterized to empty/gray tiles).
 */
export function extractElementCoverDocument(document: unknown, nodeId: string): unknown | null {
  const dsl = (document as { deltaSetLike?: Record<string, unknown> })?.deltaSetLike;
  const raw = dsl?.[nodeId];
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (!isExportableSceneNode(node) || !coverElementHasVisual(node)) return null;

  const w = Math.max(1, num(node.width, 1));
  const h = Math.max(1, num(node.height, 1));
  // Edge-to-edge — list cards object-cover; no letterbox margin around the element.
  const boardW = Math.max(32, Math.round(w));
  const boardH = Math.max(32, Math.round(h));
  const id = String(nodeId);

  return {
    width: boardW,
    height: boardH,
    backgroundColor: '#ffffff',
    backgroundFillType: 'solid',
    frames: [
      {
        id: 'element-cover',
        x: 0,
        y: 0,
        width: boardW,
        height: boardH,
        backgroundColor: '#ffffff',
      },
    ],
    deltaSetLike: {
      ROOT: { id: 'ROOT', key: 'entry', children: [id] },
      [id]: {
        ...node,
        id,
        x: 0,
        y: 0,
        width: w,
        height: h,
      },
    },
  };
}

/**
 * Rasterize an already-extracted cover / artboard document to a data URL.
 * Used by list cards so the DOM shows `<img>`, not live SVG.
 */
export async function renderDocumentThumbnail(
  document: unknown,
  opts?: ThumbRasterOptions
): Promise<string | null> {
  if (!document || typeof document !== 'object') return null;
  if (!opts?.allowEmpty && !coverDocumentHasContent(document)) return null;

  const format = opts?.format || 'webp';
  const maxEdge = Math.max(64, Math.round(opts?.maxEdge || MAX_EDGE));

  const doc = document as {
    width?: number;
    height?: number;
    frames?: Array<{ width?: number; height?: number }>;
  };
  const frame = Array.isArray(doc.frames) ? doc.frames[0] : null;
  const docW = Math.max(1, Math.round(Number(frame?.width || doc.width) || 794));
  const docH = Math.max(1, Math.round(Number(frame?.height || doc.height) || 1123));
  const scale = Math.min(1, maxEdge / Math.max(docW, docH));
  const outW = Math.max(32, Math.round(docW * scale));
  const outH = Math.max(32, Math.round(docH * scale));
  const bg = paperBackground(document as SceneDocument);

  const host = window.document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText =
    'position:fixed;left:-99999px;top:0;width:0;height:0;overflow:hidden;pointer-events:none';
  window.document.body.appendChild(host);

  try {
    const previewDoc = {
      ...(document as object),
      width: docW,
      height: docH,
      backgroundColor: bg,
      backgroundFillType: 'solid',
    } as unknown as SceneDocument;
    const { root, layer } = createDomHostBoard(host, docW, docH);
    await mountDomHostBoard(root, layer, previewDoc);

    const xml = new XMLSerializer().serializeToString(root);
    const inlined = await inlineSvgImages(xml, previewDoc, { failClosed: false });
    const mime =
      format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
    const quality = format === 'png' ? undefined : WEBP_QUALITY;
    return await rasterizeSvgString(inlined, outW, outH, mime, quality, false, bg);
  } catch {
    return null;
  } finally {
    host.remove();
  }
}
