import type { ArtboardFrame } from '@/components/rcb/frames/types';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { updateNodesInDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  canBindToArtboard,
  WORKBENCH_SURROUND_ATTR,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { isGeneratorNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { isFrameLocalCoordSpace } from '@/components/rcb/scene/layout/nodeLayout';
export type BBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function isAvMediaSceneNode(node: { key?: unknown } | null | undefined): boolean {
  const key = String(node?.key || '');
  return key === 'video' || key === 'audio';
}

/** Owning artboard id from `attrs.frameId`, or empty when unbound. */
export function nodeOwnerFrameId(
  node: { attrs?: { frameId?: unknown } | null } | null | undefined
): string {
  return String(node?.attrs?.frameId || '').trim();
}

/** 动画工作台 rejects AV + generators; nested free Lottie plates become precomp tabs. */
export function canBindNodeToArtboardFrame(
  frame: ArtboardFrame | null | undefined,
  node: { key?: unknown; attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  if (!frame || !node || !isAnimationArtboardKind(frame.kind)) return true;
  if (isAvMediaSceneNode(node) || isGeneratorNode(node as any)) return false;
  return true;
}

export function sceneBBox(box: {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}): BBox {
  return {
    left: Number(box.x) || 0,
    top: Number(box.y) || 0,
    width: Math.max(1, Number(box.width) || 1),
    height: Math.max(1, Number(box.height) || 1),
  };
}

export function boxesIntersect(a: BBox, b: BBox): boolean {
  return (
    a.left < b.left + b.width &&
    a.left + a.width > b.left &&
    a.top < b.top + b.height &&
    a.top + a.height > b.top
  );
}

/**
 * Topmost artboard under `rect`. Animation workbench only while its timeline
 * is open; preview mode never claims via move/overlap.
 */
export function frameForNodeIntersectPlacement(
  doc: SceneDocument,
  rect: BBox,
  node?: { key?: unknown; attrs?: Record<string, unknown> | null } | null
): string | null {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i];
    if (!canBindToArtboard(frame)) continue;
    if (!boxesIntersect(rect, sceneBBox(frame))) continue;
    if (!canBindNodeToArtboardFrame(frame, node)) continue;
    return String(frame.id);
  }
  return null;
}

/** Auto-bind on artboard draw/move — workbench only when timeline is open. */
export function shouldBindUnownedNodeToFrame(
  node: {
    key?: unknown;
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown>;
  },
  frame: ArtboardFrame
): boolean {
  if (String(node.attrs?.frameId || '').trim()) return false;
  if (!canBindToArtboard(frame)) return false;
  if (!canBindNodeToArtboardFrame(frame, node)) return false;
  return boxesIntersect(sceneBBox(node), sceneBBox(frame));
}

export function bindUnownedNodesToFrames(
  doc: SceneDocument,
  frameIds: string[]
): SceneDocument {
  const idSet = new Set(frameIds.map((id) => String(id || '').trim()).filter(Boolean));
  const frames = (doc.frames || []).filter((frame) => idSet.has(String(frame.id)));
  if (!frames.length) return doc;

  const nodes = Object.values(doc.deltaSetLike || {});
  const patches: Array<{
    nodeId: string;
    patch: { attrs: Record<string, unknown>; x?: number; y?: number };
  }> = [];
  const localPlate = isFrameLocalCoordSpace(doc);
  for (const node of nodes) {
    if (!node?.id || node.id === 'ROOT') continue;
    const frame = frames.find((item) => shouldBindUnownedNodeToFrame(node, item));
    if (!frame) continue;
    const orders = nodes
      .filter((item) => String(item?.attrs?.frameId || '').trim() === String(frame.id))
      .map((item) => Number(item?.attrs?.frameOrder))
      .filter(Number.isFinite);
    const { [WORKBENCH_SURROUND_ATTR]: _s, ...rest } = (node.attrs || {}) as Record<
      string,
      unknown
    >;
    const patch: { attrs: Record<string, unknown>; x?: number; y?: number } = {
      attrs: {
        ...rest,
        frameId: String(frame.id),
        frameOrder: orders.length ? Math.max(...orders) + 1 : 0,
      },
    };
    // Free nodes still store world absolute; convert to plate-local on bind.
    if (localPlate) {
      patch.x = (Number(node.x) || 0) - (Number(frame.x) || 0);
      patch.y = (Number(node.y) || 0) - (Number(frame.y) || 0);
    }
    patches.push({
      nodeId: String(node.id),
      patch,
    });
  }
  return patches.length ? updateNodesInDocument(doc, patches) : doc;
}

/** Create-time frameId: only when the plate may own the node (timeline open for workbench). */
export function acceptCreateFrameId(
  doc: SceneDocument,
  frameId: string | null | undefined,
  node?: { key?: unknown; attrs?: Record<string, unknown> | null } | null
): string | null {
  const id = String(frameId || '').trim();
  if (!id) return null;
  const frame = (doc.frames || []).find((item) => String(item?.id) === id);
  if (!canBindToArtboard(frame)) return null;
  return canBindNodeToArtboardFrame(frame, node) ? id : null;
}

/** Bound children follow owner; free ink never co-moves with an animation workbench. */
export function shouldCoMoveNodeWithFrames(
  node: { attrs?: Record<string, unknown> },
  nodeRect: BBox,
  movedFrameIds: Set<string>,
  frameRect: BBox,
  movedFrameKind?: ArtboardFrame['kind'] | string | null
): boolean {
  const ownerId = String(node.attrs?.frameId || '').trim();
  if (ownerId) return movedFrameIds.has(ownerId);
  if (isAnimationArtboardKind(movedFrameKind)) return false;
  return boxesIntersect(nodeRect, frameRect);
}
