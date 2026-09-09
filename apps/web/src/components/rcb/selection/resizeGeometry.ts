import type { SceneDocument } from '@/components/rcb/sceneNode';
export type SceneBox = { left: number; top: number; width: number; height: number };
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** Scene-space floor — match Kit create (1px); stroke outset may raise it at snap. */
export const RESIZE_MIN_SIZE = 1;
const DEFAULT_MIN = RESIZE_MIN_SIZE;

export function sizeFromAspectPreset(
  box: SceneBox,
  ratioW: number,
  ratioH: number,
  min = DEFAULT_MIN
): { width: number; height: number } {
  const r = Math.max(1e-4, ratioW / ratioH);
  const width = Math.max(min, Math.round(box.width));
  const height = Math.max(min, Math.round(width / r));
  return { width, height };
}

export function matchAspectPresetKey(
  width: number,
  height: number,
  presets: Array<{ id: string; w: number; h: number }>
): string {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  for (const p of presets) {
    if (p.id === 'original' || p.w <= 0 || p.h <= 0) continue;
    // Cross-multiply with a small pixel slack — old ±0.02 ratio falsely
    // labeled 449×457 as 1:1.
    const slack = Math.max(2, 0.005 * Math.max(w, h));
    if (Math.abs(w * p.h - h * p.w) <= slack) return p.id;
  }
  return 'original';
}

/** Axis-aligned bounds of a box after rotating about its center. */
export function rotatedAabbBox(box: SceneBox, angleDeg: number): SceneBox {
  if (Math.abs(angleDeg) < 0.01) {
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const cx = box.left + w / 2;
  const cy = box.top + h / 2;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [box.left, box.top],
    [box.left + w, box.top],
    [box.left + w, box.top + h],
    [box.left, box.top + h],
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
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

export function unionOfBoxes(boxes: SceneBox[]): SceneBox | null {
  if (!boxes.length) return null;
  let minL = boxes[0].left;
  let minT = boxes[0].top;
  let maxR = boxes[0].left + boxes[0].width;
  let maxB = boxes[0].top + boxes[0].height;
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    minL = Math.min(minL, b.left);
    minT = Math.min(minT, b.top);
    maxR = Math.max(maxR, b.left + b.width);
    maxB = Math.max(maxB, b.top + b.height);
  }
  return { left: minL, top: minT, width: Math.max(1, maxR - minL), height: Math.max(1, maxB - minT) };
}

/** Control-box member: scene AABB + optional live angle override. */
export type ChromeOrigin = { nodeId: string; box: SceneBox; angle?: number };

function isFrameChromeId(id: string) {
  return typeof id === 'string' && id.startsWith('frame:');
}

function rotAroundOrigin(x: number, y: number, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function memberChromeAngle(document: SceneDocument, o: ChromeOrigin): number {
  if (o.angle != null && Number.isFinite(o.angle)) return Number(o.angle);
  if (isFrameChromeId(o.nodeId)) return 0;
  const n = Number(document?.deltaSetLike?.[o.nodeId]?.attrs?.angle);
  return Number.isFinite(n) ? n : 0;
}

/** Common member angle, or 0 when the selection is mixed. */
export function getSelectionSharedRotation(document: SceneDocument, nodeIds: string[]): number {
  let found = false;
  let rotation = 0;
  for (const id of nodeIds) {
    if (isFrameChromeId(id)) continue;
    const a = memberChromeAngle(document, { nodeId: id, box: { left: 0, top: 0, width: 1, height: 1 } });
    if (!found) {
      found = true;
      rotation = a;
    } else if (Math.abs(a - rotation) > 0.05) {
      return 0;
    }
  }
  return found ? rotation : 0;
}

/** Oriented control box when angles match; else page AABB of painted bounds. */
export function getSelectionRotatedUnion(
  document: SceneDocument,
  origins: ChromeOrigin[],
  sharedRotationDeg: number
): SceneBox | null {
  if (!origins.length) return null;
  if (Math.abs(sharedRotationDeg) < 0.01) {
    return unionOfBoxes(
      origins.map((o) =>
        isFrameChromeId(o.nodeId) ? o.box : rotatedAabbBox(o.box, memberChromeAngle(document, o))
      )
    );
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const rad = (-sharedRotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const o of origins) {
    const ang = memberChromeAngle(document, o);
    const { left, top, width, height } = o.box;
    const cx = left + width / 2;
    const cy = top + height / 2;
    const ar = (ang * Math.PI) / 180;
    const ac = Math.cos(ar);
    const as = Math.sin(ar);
    for (const [lx, ly] of [
      [left, top],
      [left + width, top],
      [left + width, top + height],
      [left, top + height],
    ] as const) {
      const dx = lx - cx;
      const dy = ly - cy;
      const px = Math.abs(ang) < 0.01 ? lx : cx + dx * ac - dy * as;
      const py = Math.abs(ang) < 0.01 ? ly : cy + dx * as + dy * ac;
      const ux = px * cos - py * sin;
      const uy = px * sin + py * cos;
      minX = Math.min(minX, ux);
      minY = Math.min(minY, uy);
      maxX = Math.max(maxX, ux);
      maxY = Math.max(maxY, uy);
    }
  }
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const centerPage = rotAroundOrigin(minX + w / 2, minY + h / 2, sharedRotationDeg);
  return {
    left: centerPage.x - w / 2,
    top: centerPage.y - h / 2,
    width: w,
    height: h,
  };
}

/** Prefer live tilted chrome; else derive from shared member angles. */
export function resolveControlChrome(
  document: SceneDocument,
  origins: ChromeOrigin[],
  liveUnion?: SceneBox | null,
  liveAngle?: number
): { box: SceneBox; angle: number } {
  const fallback = unionOfBoxes(origins.map((o) => o.box)) || {
    left: 0,
    top: 0,
    width: 1,
    height: 1,
  };
  if (!origins.length) return { box: fallback, angle: 0 };
  if (origins.length === 1) {
    const id = origins[0].nodeId;
    return {
      box: { ...(liveUnion || origins[0].box) },
      angle:
        liveAngle ||
        (isFrameChromeId(id) ? 0 : memberChromeAngle(document, origins[0])),
    };
  }
  if (liveUnion && Math.abs(Number(liveAngle) || 0) > 0.01) {
    return { box: { ...liveUnion }, angle: Number(liveAngle) };
  }
  const angle =
    Number(liveAngle) ||
    getSelectionSharedRotation(
      document,
      origins.map((o) => o.nodeId)
    );
  return {
    box: getSelectionRotatedUnion(document, origins, angle) || fallback,
    angle,
  };
}
