/**
 * Frame / artboard scene queries for DomHost + attach-pick chrome.
 * Ink hit stays in Kit (`hitTestRcbIdFromKit`); this module only answers
 * plate geometry questions (full-bleed background, topmost frame under point).
 * Synthetic frame selection ids for marquee / multi-select live here too.
 */
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { isArtboardVisibleInDocument } from '@/components/rcb/scene/document/nodeCapabilities';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import {
  frameSceneBounds,
  nodeLeftTop,
} from '@/components/rcb/scene/layout/nodeLayout';
import { parseStackKey } from '@/components/rcb/scene/document/sceneDocument';

/** Synthetic selection ids for artboard frames (marquee / multi-select). */
export const FRAME_SEL_PREFIX = '__frame__:';

export function frameSelId(frameId: string) {
  return `${FRAME_SEL_PREFIX}${frameId}`;
}

export function parseFrameSelId(selId: string): string | null {
  const s = String(selId || '');
  if (!s.startsWith(FRAME_SEL_PREFIX)) return null;
  const id = s.slice(FRAME_SEL_PREFIX.length);
  return id || null;
}

function pointInSceneBox(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  return (
    x >= box.left &&
    x <= box.left + box.width &&
    y >= box.top &&
    y <= box.top + box.height
  );
}

/** Frame ids top→bottom by stackOrder; frames missing from stack append in array order. */
function rankedFrameIdsTopFirst(doc: SceneDocument): string[] {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frames.length) return [];
  const byId = new Map(frames.map((f) => [String(f?.id || ''), f]));
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder : [];
  const ranked: string[] = [];
  const seen = new Set<string>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const parsed = parseStackKey(String(order[i] || ''));
    if (!parsed || parsed.kind !== 'frame') continue;
    if (!byId.has(parsed.id) || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    ranked.push(parsed.id);
  }
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const id = String(frames[i]?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ranked.push(id);
  }
  return ranked;
}

/**
 * Near-full-bleed artboard background (rect / closed path / image).
 * Not pickable as content — click should reach nested nodes or the frame plate.
 */
export function frameForFullBleedPlate(doc: SceneDocument, nodeId: string): string | null {
  const node = doc?.deltaSetLike?.[nodeId];
  if (!node) return null;
  const key = String(node.key || '');
  if (key === 'shape') {
    const shapeType = String(node.attrs?.shapeType || 'rect');
    // Open strokes are not plates.
    if (shapeType === 'line' || shapeType === 'arrow' || shapeType === 'pencil') return null;
    if (shapeType === 'pen' || shapeType === 'path') {
      const closed = node.attrs?.closed;
      if (closed === false || closed === 'false' || closed === 0 || closed === '0') return null;
    }
  } else if (key !== 'image' && key !== 'rect') {
    return null;
  }
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  if (!frames.length) return null;
  const { left, top } = nodeLeftTop(doc, node);
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const area = w * h;
  // Prefer the frame this node is bound to, then any overlapping artboard.
  const boundId = String(node.attrs?.frameId || '').trim();
  const ordered = boundId
    ? [
        ...frames.filter((f) => String(f?.id) === boundId),
        ...frames.filter((f) => String(f?.id) !== boundId),
      ]
    : frames;
  for (const f of ordered) {
    if (!f?.id) continue;
    const fx = Number(f.x) || 0;
    const fy = Number(f.y) || 0;
    const fw = Math.max(1, Number(f.width) || 1);
    const fh = Math.max(1, Number(f.height) || 1);
    const frameArea = fw * fh;
    const ow = Math.max(0, Math.min(left + w, fx + fw) - Math.max(left, fx));
    const oh = Math.max(0, Math.min(top + h, fy + fh) - Math.max(top, fy));
    const overlap = ow * oh;
    if (overlap >= frameArea * 0.9 && area >= frameArea * 0.85) {
      return String(f.id);
    }
  }
  return null;
}

/** Topmost artboard under a scene point — ordered by stackOrder, not frames[]. */
export function frameIdAtPoint(
  doc: SceneDocument | null | undefined,
  x: number,
  y: number
): string | null {
  if (!doc) return null;
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frames.length) return null;
  const byId = new Map(frames.map((f) => [String(f?.id || ''), f]));
  for (const id of rankedFrameIdsTopFirst(doc)) {
    const frame = byId.get(id);
    if (!frame || frame.locked || !isArtboardVisibleInDocument(frame)) continue;
    const live = getLiveArtboardFrameGeometry(id);
    const box = frameSceneBounds(doc, frame, live);
    if (pointInSceneBox(x, y, box)) return id;
  }
  return null;
}
