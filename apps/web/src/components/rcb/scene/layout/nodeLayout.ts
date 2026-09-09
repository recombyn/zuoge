/**
 * Scene / document geometry helpers (no SVG paint).
 */
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sceneOrigin(document: SceneDocument | null | undefined) {
  return { ox: num(document?.x, 0), oy: num(document?.y, 0) };
}

/** Artboard plate bounds in scene space (matches pointer / nodeLeftTop). */
export function frameSceneBounds(
  document: SceneDocument | null | undefined,
  frame: { x?: unknown; y?: unknown; width?: unknown; height?: unknown },
  live?: { x?: number; y?: number; width?: number; height?: number } | null
): { left: number; top: number; width: number; height: number } {
  const { ox, oy } = sceneOrigin(document);
  return {
    left: num(live?.x ?? frame.x, 0) - ox,
    top: num(live?.y ?? frame.y, 0) - oy,
    width: Math.max(1, num(live?.width ?? frame.width, 1)),
    height: Math.max(1, num(live?.height ?? frame.height, 1)),
  };
}

/** Bound artboard children store x/y relative to the plate (0,0 = frame top-left). */
export const FRAME_LOCAL_COORD_SPACE = 'frameLocal';

export function isFrameLocalCoordSpace(
  document: SceneDocument | null | undefined
): boolean {
  return String(document?.coordSpace || '') === FRAME_LOCAL_COORD_SPACE;
}

function frameDocumentOrigin(
  document: SceneDocument | null | undefined,
  frameId: string
): { x: number; y: number } | null {
  const id = String(frameId || '').trim();
  if (!id || !document) return null;
  const live = getLiveArtboardFrameGeometry(id);
  if (live) return { x: num(live.x, 0), y: num(live.y, 0) };
  const frame = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === id
  );
  if (!frame) return null;
  return { x: num(frame.x, 0), y: num(frame.y, 0) };
}

/** Document-space absolute box origin (same lattice as `frames[].x/y`). */
export function nodeDocumentLeftTop(
  document: SceneDocument | null | undefined,
  node: SceneNodeInput | null | undefined
): { left: number; top: number } {
  const x = num(node?.x, 0);
  const y = num(node?.y, 0);
  if (!isFrameLocalCoordSpace(document)) return { left: x, top: y };
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) return { left: x, top: y };
  const origin = frameDocumentOrigin(document, frameId);
  if (!origin) return { left: x, top: y };
  return { left: origin.x + x, top: origin.y + y };
}

/** Scene-space origin (document absolute minus scene origin). */
export function nodeLeftTop(
  document: SceneDocument | null | undefined,
  node: SceneNodeInput
) {
  const { ox, oy } = sceneOrigin(document);
  const abs = nodeDocumentLeftTop(document, node);
  return { left: abs.left - ox, top: abs.top - oy };
}

/** World/document absolute → frame-local (when `coordSpace` is frameLocal). */
export function documentPointToNodeLocal(
  document: SceneDocument | null | undefined,
  node: SceneNodeInput | null | undefined,
  absX: number,
  absY: number
): { x: number; y: number } {
  if (!isFrameLocalCoordSpace(document)) return { x: absX, y: absY };
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) return { x: absX, y: absY };
  const origin = frameDocumentOrigin(document, frameId);
  if (!origin) return { x: absX, y: absY };
  return { x: absX - origin.x, y: absY - origin.y };
}

/** Frame-local (or world) node x/y → document absolute. */
export function nodeLocalToDocumentPoint(
  document: SceneDocument | null | undefined,
  frameId: string | null | undefined,
  localX: number,
  localY: number
): { x: number; y: number } {
  if (!isFrameLocalCoordSpace(document)) return { x: localX, y: localY };
  const id = String(frameId || '').trim();
  if (!id) return { x: localX, y: localY };
  const origin = frameDocumentOrigin(document, id);
  if (!origin) return { x: localX, y: localY };
  return { x: origin.x + localX, y: origin.y + localY };
}
