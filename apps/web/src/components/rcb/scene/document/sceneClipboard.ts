import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import {
  getDocumentGridSize,
  snapBoxToGrid,
  snapCoordToGrid,
} from '@/components/rcb/selection/alignGuides';
import {
  addNodesToDocument,
  cloneSceneValue,
  getActivePage,
  listSceneNodes,
  normalizeDocument,
  reconcileStackOrder,
  stackFrameKey,
} from './sceneDocument';
import { strokeVisualOutset } from './sceneEffects';
import {
  SceneNodeSchema,
  type SceneDocument,
  type SceneNode,
} from '@/components/rcb/sceneNode';

/** Copy / cut / paste / artboard selection expansion. */

export function nodeIdsInsideFrames(
  doc: SceneDocument | null | undefined,
  frameIds: string[]
): string[] {
  return nodeIdsBoundToFrames(doc, frameIds);
}

/**
 * Nodes explicitly bound to an artboard.
 * Does not infer ownership from overlap or center containment.
 */
export function nodeIdsBoundToFrames(
  doc: SceneDocument | null | undefined,
  frameIds: string[]
): string[] {
  if (!doc || !frameIds?.length) return [];
  const wanted = new Set(frameIds.filter(Boolean).map(String));
  if (!wanted.size) return [];
  return listSceneNodes(doc)
    .filter(({ node }) => wanted.has(String(node?.attrs?.frameId || '').trim()))
    .map(({ id }) => id);
}

/**
 * Post paste/duplicate selection: artboards are units (click / multi-frame marquee).
 * Keep free nodes selected; do not co-select children bound to the new frames —
 * their unclipped overflow would inflate the control box past the plate.
 */
export function selectionAfterClipboardPaste(
  doc: SceneDocument | null | undefined,
  newIds: string[],
  newFrameIds: string[]
): { nodeIds: string[]; frameIds: string[] } {
  const frameIds = (newFrameIds || []).filter(Boolean);
  const ids = (newIds || []).filter(Boolean);
  if (!frameIds.length) return { nodeIds: ids, frameIds: [] };
  const inside = new Set(nodeIdsBoundToFrames(doc, frameIds));
  return {
    nodeIds: ids.filter((id) => !inside.has(id)),
    frameIds,
  };
}

/**
 * Nodes to operate on for a canvas selection: explicit node ids plus content
 * inside selected artboards (same expansion delete / copy already use).
 */
export function resolveSelectionNodeIds(
  doc: SceneDocument,
  nodeIds: string[],
  frameIds: string[] = []
): string[] {
  const inside = nodeIdsBoundToFrames(doc, frameIds);
  return [...new Set([...(nodeIds || []).filter(Boolean), ...inside])];
}

/** Artboard slice in clipboard — required geometry; extras passthrough. */
export const SceneClipboardFrameSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    backgroundColor: z.string().optional(),
  })
  .passthrough();

export const SceneClipboardPayloadSchema = z
  .object({
    nodes: z.array(
      z.object({
        id: z.string().min(1),
        node: SceneNodeSchema,
      })
    ),
    frames: z
      .array(
        z.object({
          id: z.string().min(1),
          frame: SceneClipboardFrameSchema,
        })
      )
      .optional(),
  })
  .refine((p) => (p.nodes?.length || 0) > 0 || (p.frames?.length || 0) > 0, {
    message: 'Clipboard must include nodes or frames',
  });

export type SceneClipboardPayload = z.infer<typeof SceneClipboardPayloadSchema>;

export type ValidateSceneClipboardResult =
  | { valid: true; data: SceneClipboardPayload }
  | { valid: false; error: string };

/** Runtime-check copy/paste payload (internal memory or pasted JSON). */
export function validateSceneClipboard(data: unknown): ValidateSceneClipboardResult {
  try {
    const result = SceneClipboardPayloadSchema.safeParse(data);
    if (result.success) return { valid: true, data: result.data };
    const errorMessages = result.error.issues.map((err) => {
      const path = err.path.join('.');
      return path ? `${path}: ${err.message}` : err.message;
    });
    return {
      valid: false,
      error: `Clipboard validation failed: ${errorMessages.join('; ')}`,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown clipboard validation error',
    };
  }
}

/** Parse text as scene clipboard JSON (OS paste of exported clip). */
export function parseAndValidateSceneClipboardJson(
  rawText: string
): ValidateSceneClipboardResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { valid: false, error: 'Invalid clipboard JSON' };
  }
  return validateSceneClipboard(parsed);
}

/** Axis-aligned bounds of clipboard nodes + frames (document coords). */
export function clipboardNodesBounds(clipboard: SceneClipboardPayload | null | undefined) {
  if (!clipboard) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  // When artboards are in the clip, their plates own clipped content — skip
  // bound nodes so overflowing geom does not inflate duplicate offset / paste anchor.
  const clippedFrameIds = new Set(
    (clipboard.frames || []).map(({ id }) => String(id || '').trim()).filter(Boolean)
  );
  (clipboard.nodes || []).forEach(({ node }) => {
    const frameId = String(node?.attrs?.frameId || '').trim();
    if (frameId && clippedFrameIds.has(frameId)) return;
    const x = Number(node.x) || 0;
    const y = Number(node.y) || 0;
    const w = Math.max(0, Number(node.width) || 0);
    const h = Math.max(0, Number(node.height) || 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    any = true;
  });
  (clipboard.frames || []).forEach(({ frame }) => {
    const x = Number(frame.x) || 0;
    const y = Number(frame.y) || 0;
    const w = Math.max(0, Number(frame.width) || 0);
    const h = Math.max(0, Number(frame.height) || 0);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
    any = true;
  });
  if (!any || !Number.isFinite(minX)) return null;
  return {
    left: minX,
    top: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

/** Deep-clone selected nodes for copy / cut (preserves page z-order). */
export function snapshotNodesForClipboard(
  doc: SceneDocument,
  nodeIds: string[]
): SceneClipboardPayload | null {
  if (!doc) return null;
  const wanted = new Set((nodeIds || []).filter(Boolean));
  if (!wanted.size) return null;
  const page = getActivePage(doc);
  const ordered = (page?.children || []).filter((id: string) => wanted.has(id));
  const ids = ordered.length ? ordered : [...wanted];
  const nodes: SceneClipboardPayload['nodes'] = [];
  ids.forEach((id) => {
    const raw = doc.deltaSetLike?.[id];
    if (!raw) return;
    nodes.push({ id, node: cloneSceneValue(raw) });
  });
  return nodes.length ? { nodes } : null;
}

/** Deep-clone selected artboards for copy / cut / duplicate. */
export function snapshotFramesForClipboard(
  doc: SceneDocument,
  frameIds: string[]
): NonNullable<SceneClipboardPayload['frames']> {
  const wanted = new Set((frameIds || []).filter(Boolean).map(String));
  if (!wanted.size || !doc) return [];
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const out: NonNullable<SceneClipboardPayload['frames']> = [];
  frames.forEach((f) => {
    if (!f?.id || !wanted.has(String(f.id))) return;
    out.push({ id: String(f.id), frame: cloneSceneValue(f) });
  });
  return out;
}

/** Shallow COW shell for trusted paste — share node objects, exclusive containers. */
function shallowDocumentShell(doc: SceneDocument): SceneDocument {
  return {
    ...doc,
    deltaSetLike: { ...(doc.deltaSetLike || {}) },
    frames: Array.isArray(doc.frames) ? doc.frames.slice() : [],
    pages: Array.isArray(doc.pages)
      ? doc.pages.map((p) =>
          p && typeof p === 'object'
            ? {
                ...p,
                children: Array.isArray(p.children) ? [...p.children] : p.children,
              }
            : p
        )
      : doc.pages,
    stackOrder: Array.isArray(doc.stackOrder) ? [...doc.stackOrder] : doc.stackOrder,
  };
}

/**
 * Paste clipboard nodes + artboards with new ids.
 * - Default: nudge by offset (keyboard paste).
 * - `anchor`: place union top-left at that scene point (context-menu paste).
 * - `trusted`: skip Zod (internal memory clip already validated at copy).
 * Final path/artboard origins snap to the document grid (same lattice as move).
 */
export function pasteClipboardIntoDocument(
  doc: SceneDocument,
  clipboard: SceneClipboardPayload | null | undefined,
  opts?: {
    offsetX?: number;
    offsetY?: number;
    anchor?: { x: number; y: number };
    trusted?: boolean;
  }
): { document: SceneDocument; ids: string[]; frameIds: string[] } {
  let clip: SceneClipboardPayload;
  if (opts?.trusted) {
    if (!clipboard || (!(clipboard.nodes?.length) && !(clipboard.frames?.length))) {
      return { document: doc, ids: [], frameIds: [] };
    }
    clip = clipboard;
  } else {
    const checked = validateSceneClipboard(clipboard);
    if (!checked.valid) {
      return { document: doc, ids: [], frameIds: [] };
    }
    clip = checked.data;
  }
  const hasNodes = Boolean(clip.nodes?.length);
  const hasFrames = Boolean(clip.frames?.length);
  if (!doc || (!hasNodes && !hasFrames)) {
    return { document: doc, ids: [], frameIds: [] };
  }
  // Live store docs are already normalized (frameLocal). Full normalizeDocument
  // walks every node twice via addNodesToDocument — skip on trusted paste.
  const liveTrusted =
    Boolean(opts?.trusted) && String(doc.coordSpace || '') === 'frameLocal';
  let next = liveTrusted ? shallowDocumentShell(doc) : normalizeDocument(doc);
  const gridSize = getDocumentGridSize(next);
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();
  const frameIdMap = new Map<string, string>();
  (clip.nodes || []).forEach(({ id }) => idMap.set(id, nanoid(10)));
  (clip.frames || []).forEach(({ id }) => frameIdMap.set(id, nanoid(10)));

  let ox = opts?.offsetX ?? 24;
  let oy = opts?.offsetY ?? 24;
  if (opts?.anchor) {
    const bounds = clipboardNodesBounds(clip);
    if (bounds) {
      ox = snapCoordToGrid(opts.anchor.x, gridSize) - bounds.left;
      oy = snapCoordToGrid(opts.anchor.y, gridSize) - bounds.top;
    }
  }

  const prepared: Array<{ id: string; node: SceneNode }> = [];
  const newIds: string[] = [];
  const frameLocal = String(next.coordSpace || '') === 'frameLocal';
  const liveFrameIds = new Set(
    (Array.isArray(next.frames) ? next.frames : [])
      .map((f) => String(f?.id || '').trim())
      .filter(Boolean)
  );
  const frameOriginById = (frameId: string): { x: number; y: number } | null => {
    const fromDoc = (Array.isArray(next.frames) ? next.frames : []).find(
      (f) => String(f?.id || '') === frameId
    );
    if (fromDoc) {
      return { x: Number(fromDoc.x) || 0, y: Number(fromDoc.y) || 0 };
    }
    const fromClip = (clip.frames || []).find(({ id }) => String(id) === frameId)?.frame;
    if (fromClip) {
      return { x: Number(fromClip.x) || 0, y: Number(fromClip.y) || 0 };
    }
    return null;
  };
  (clip.nodes || []).forEach(({ id, node: raw }) => {
    const node = cloneSceneValue(raw);
    const newId = idMap.get(id)!;
    node.id = newId;
    const sourceFrameId = String(node.attrs?.frameId || '').trim();
    const mappedFrameId = sourceFrameId ? frameIdMap.get(sourceFrameId) : undefined;
    // Artboard duplicate: children stay plate-local on the *new* frame (frame moves).
    // Node-only duplicate on an existing board: offset plate-local, keep frameId.
    // Clearing frameId while leaving plate-local xy parks ink near scene origin —
    // empty-looking copies on the artboard the user is staring at.
    const artboardChildDupe = Boolean(mappedFrameId) && frameLocal;
    const sameBoardDupe =
      Boolean(sourceFrameId) &&
      !mappedFrameId &&
      liveFrameIds.has(sourceFrameId) &&
      frameLocal;
    if (artboardChildDupe) {
      node.x = Number(node.x) || 0;
      node.y = Number(node.y) || 0;
    } else {
      node.x = (Number(node.x) || 0) + ox;
      node.y = (Number(node.y) || 0) + oy;
      const outset = strokeVisualOutset(node);
      if (outset > 0) {
        const visual = snapBoxToGrid(
          {
            left: node.x - outset,
            top: node.y - outset,
            width: Math.max(1, Number(node.width) || 1) + outset * 2,
            height: Math.max(1, Number(node.height) || 1) + outset * 2,
          },
          gridSize
        );
        node.x = visual.left + outset;
        node.y = visual.top + outset;
      } else {
        node.x = snapCoordToGrid(node.x, gridSize);
        node.y = snapCoordToGrid(node.y, gridSize);
      }
      // Orphaned clip (source artboard gone): promote plate-local → world before unbind.
      if (sourceFrameId && !mappedFrameId && !sameBoardDupe && frameLocal) {
        const origin = frameOriginById(sourceFrameId);
        if (origin) {
          node.x = (Number(node.x) || 0) + origin.x;
          node.y = (Number(node.y) || 0) + origin.y;
        }
      }
    }
    const gid = String(node.attrs?.groupId || '').trim();
    if (gid) {
      if (!groupMap.has(gid)) groupMap.set(gid, nanoid(8));
      node.attrs = { ...(node.attrs || {}), groupId: groupMap.get(gid) };
    }
    if (sourceFrameId) {
      const nextFrameId = mappedFrameId || (sameBoardDupe ? sourceFrameId : undefined);
      node.attrs = {
        ...(node.attrs || {}),
        ...(nextFrameId ? { frameId: nextFrameId } : { frameId: undefined }),
      };
    }
    prepared.push({ id: newId, node });
    newIds.push(newId);
  });
  if (prepared.length) {
    next = addNodesToDocument(next, prepared, liveTrusted ? { skipNormalize: true } : undefined);
  }

  const newFrameIds: string[] = [];
  if (clip.frames?.length) {
    const frames = Array.isArray(next.frames) ? [...next.frames] : [];
    const order = Array.isArray(next.stackOrder) ? [...next.stackOrder] : [];
    clip.frames.forEach(({ id, frame: raw }) => {
      const frame = cloneSceneValue(raw);
      const newId = frameIdMap.get(id)!;
      frame.id = newId;
      frame.x = snapCoordToGrid((Number(frame.x) || 0) + ox, gridSize);
      frame.y = snapCoordToGrid((Number(frame.y) || 0) + oy, gridSize);
      // Drop transient chrome that should not clone with the artboard.
      delete frame.processStatus;
      delete frame.processLabel;
      delete frame.processKind;
      frames.push(frame as ArtboardFrame);
      newFrameIds.push(newId);
      order.push(stackFrameKey(newId));
    });
    next = {
      ...next,
      frames,
      stackOrder: order,
      activeFrameId: newFrameIds[0] || next.activeFrameId || null,
    };
  }

  reconcileStackOrder(next);
  return { document: next, ids: newIds, frameIds: newFrameIds };
}
