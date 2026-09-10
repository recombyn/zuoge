import {
  canAttachNodeToChat
} from '@/components/rcb/scene/document/mediaLifecycle';
import {
  expandSelectionWithGroups,
  readNodeGroupId
} from '@/components/rcb/scene/document/sceneGroups';
import {
  frameForFullBleedPlate as frameForFullBleedPlateId,
  parseFrameSelId,
} from '@/components/rcb/frames/frameSceneQuery';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import type { SceneDocument } from '@/components/rcb/sceneNode';

/** Near-full-bleed plate covering an artboard — treat click as frame select.
 *  Rect / path / image backgrounds all count (vector artboards often use a path fill). */
export function frameForFullBleedPlate(doc: SceneDocument, nodeId: string): { id: string } | null {
  const id = frameForFullBleedPlateId(doc, nodeId);
  return id ? { id } : null;
}

/** Drop generator plates + process-shimmer (+ videos when images-only) from attach targets. */
export function filterChatAttachNodeIds(
  doc: SceneDocument,
  ids: string[],
  opts?: { imagesOnly?: boolean }
): string[] {
  const delta = doc?.deltaSetLike || {};
  return ids.filter((id) => canAttachNodeToChat(delta[id], opts));
}

/** Prefer live selection; fall back to the node under the context menu. */
export function ctxMenuSeedNodeIds(selectedIds: string[], menuNodeId?: string | null): string[] {
  if (selectedIds.length) return selectedIds;
  if (menuNodeId) return [menuNodeId];
  return [];
}

/** Prefer live artboard selection; fall back to the frame under the context menu. */
export function ctxMenuSeedFrameIds(selectedFrameIds: string[], menuFrameId?: string | null): string[] {
  if (selectedFrameIds.length) return selectedFrameIds;
  if (menuFrameId) return [menuFrameId];
  return [];
}

export type AttachPickOpts = { imagesOnly?: boolean };

/**
 * Frame attach during canvas pick.
 * Image-only composers must not swallow animation / empty plates (hover shows
 * not-allowed, but frame: shortcuts used to attach anyway).
 */
export function canAttachFrameToPick(
  doc: SceneDocument | null | undefined,
  frameId: string | null | undefined,
  opts?: AttachPickOpts
): boolean {
  const fid = String(frameId || '').trim();
  if (!fid || !doc) return false;
  if (!opts?.imagesOnly) return true;
  const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
    (f) => String(f?.id || '') === fid
  );
  if (!frame || frame.hidden) return false;
  // 动画工作台 is LOT ink — never a valid image reference.
  if (isAnimationArtboardKind(frame.kind)) return false;
  const bound = nodeIdsBoundToFrames(doc, [fid]);
  return filterChatAttachNodeIds(doc, bound, opts).some(
    (id) => doc.deltaSetLike?.[id]?.key === 'image'
  );
}

/** Resolve a pick click into an attach payload, or null if empty / only blocked nodes. */
export function resolveAttachPickPayload(
  doc: SceneDocument,
  nodeIds: string[],
  frameId?: string | null,
  opts?: AttachPickOpts
): { payload: string | string[]; blockedOnly: boolean } | null {
  const raw = (nodeIds || []).filter(Boolean);
  // Ungrouped media: attach that file alone. Grouped members expand to the whole 编组
  // so the composer can attach one composite (not peel siblings into separate thumbs).
  if (raw.length === 1) {
    const hitId = raw[0]!;
    const hit = doc?.deltaSetLike?.[hitId];
    if (!readNodeGroupId(hit)) {
      const src = String(hit?.attrs?.src || '').trim();
      const mediaKey = hit?.key === 'video' || hit?.key === 'image';
      if (
        mediaKey &&
        src &&
        canAttachNodeToChat(hit, opts) &&
        !(opts?.imagesOnly && hit?.key === 'video')
      ) {
        return { payload: hitId, blockedOnly: false };
      }
    }
  }
  const seed = expandSelectionWithGroups(doc, raw);
  const attachable = filterChatAttachNodeIds(doc, seed, opts);
  if (attachable.length) {
    return {
      payload: attachable.length === 1 ? attachable[0]! : attachable,
      blockedOnly: false,
    };
  }
  if (seed.length) return { payload: '', blockedOnly: true };
  const fid = String(frameId || '').trim();
  if (fid) {
    if (!canAttachFrameToPick(doc, fid, opts)) {
      return { payload: '', blockedOnly: true };
    }
    return { payload: `frame:${fid}`, blockedOnly: false };
  }
  return null;
}

export function attachPickFilterOpts(
  pick: null | { target: string; accept?: 'image' | 'media' }
): AttachPickOpts | undefined {
  return pick?.accept === 'image' ? { imagesOnly: true } : undefined;
}

/**
 * Hover under pointer during「从画布选择」— true → not-allowed cursor, stay in pick.
 * Mirrors SvgCanvas / Kit attach-pick hit rules (frame, full-bleed plate, blocked gens).
 */
export function attachPickBlockedUnderHit(
  doc: SceneDocument | null | undefined,
  rawHit: string | null | undefined,
  opts?: AttachPickOpts
): boolean {
  if (!doc || !rawHit) return false;
  const frameFromHit = parseFrameSelId(rawHit);
  if (frameFromHit) {
    return !canAttachFrameToPick(doc, frameFromHit, opts);
  }
  const seed = expandSelectionWithGroups(doc, [rawHit]);
  const attachable = filterChatAttachNodeIds(doc, seed, opts);
  const plate = frameForFullBleedPlate(doc, rawHit);
  if (plate && attachable.length === 0) {
    return !canAttachFrameToPick(doc, plate.id, opts);
  }
  return seed.length > 0 && attachable.length === 0;
}
