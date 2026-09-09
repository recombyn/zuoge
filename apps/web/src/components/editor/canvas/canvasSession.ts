/**
 * Canvas write / hit / geometry session — imperative API used by SvgCanvas.
 */
import {
  patchDeltaSetLike,
  reconcileStackOrder,
  updateNodesInDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  nodeIdsBoundToFrames,
} from '@/components/rcb/scene/document/sceneClipboard';
import {
  fitImageSize,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  isAudioNode,
  isLottieNode,
  isNodeMarqueeSkippable,
  isTextFrameNode,
  isVideoNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  canBindToArtboard,
  getAnimationWorkbenchTimelineFocus,
  isArtboardVisibleInDocument,
  syncWorkbenchSurroundOnFrameBind,
  tagCreatedNodeForWorkbenchSurround,
  WORKBENCH_SURROUND_ATTR,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { getLottiePrecompEditFocus } from '@/components/editor/nodes/AnimationNode/animationPrecompEditFocus';
import { clearImageProcessAttrs } from '@/components/rcb/scene/document/mediaLifecycle';
import {
  STROKE_GEOMETRY_HEIGHT,
} from '@/components/rcb/scene/document/sceneShapes';
import {
  deflateSelectionBox,
  inflateSelectionBox,
} from '@/components/rcb/scene/document/sceneEffects';
import { hitTestRcbIdFromKit } from '@/components/rcb/canvas/kitBridge';
import {
  clearNodeTransformPreviews,
  effectivePaintBox,
  getNodeTransformPreview,
  setNodeTransformAngles,
  setNodeTransformPreviews,
} from '@/components/rcb/core/transformPreview';
import {
  parseNodeText,
  parseNodeTextStyle,
  measurePlainTextSize,
} from '@/components/rcb/scene/document/sceneText';
import {
  nodeLeftTop,
  isFrameLocalCoordSpace,
  nodeDocumentLeftTop,
  nodeLocalToDocumentPoint,
  frameSceneBounds,
} from '@/components/rcb/scene/layout/nodeLayout';
import {
  clearSceneDragPreview,
  purgeOrphanSceneNodes,
} from '@/components/rcb/scene/dom/domHostBoard';
import { patchNodesGeometry, sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';
import {
  getShapeHost,
  getSharedNodeEls,
  replaceShapePaint,
  shapeHostRevealsOverflow,
  type DomHostBoardHandle,
} from '@/components/rcb';
import {
  getSceneWorldRoot,
  listShapeHosts,
} from '@/components/rcb/shapes/shapeHostRegistry';
import {
  rcbFitImageIntoViewport,
  rcbLayoutGeneratorPlate,
  GENERATOR_EMPTY_STROKE_OUTSET,
  getDocumentGridSize,
} from '@/components/rcb';
import { parseFrameSelId } from '@/components/rcb/frames/frameSceneQuery';
import { syncFrameContentClip } from '@/components/rcb/frames/frameContentClip';
import {
  canBindNodeToArtboardFrame,
  frameForNodeIntersectPlacement,
  acceptCreateFrameId,
} from '@/components/rcb/frames/frameNodeBinding';
import { findFrameAnimationMediaId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  autoKeyAnimatedGeometry,
  autoKeyAnimatedProp,
} from '@/components/editor/nodes/AnimationNode/animationAutoKey';
import { getAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import { queueEnsureAnimationFramesForDocChange } from '@/components/editor/nodes/AnimationNode/queueEnsureAnimationFramesForDocChange';
import type { VideoGeomOverride } from '@/components/editor/nodes/VideoNode/VideoNodeOverlay';
import type { createDragWriteCoalescer } from './dragWriteCoalescer';
import type { ArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import {
  patchDocumentNode,
  patchDocumentNodes,
  pushEditorHistory,
  setActiveTool,
  setDocument,
  setDocumentFromCanvas,
  setSelectedNodeId,
  setSelectedNodeIds,
  touchDocumentRevision,
  updateArtboardFrames,
} from '@/store/modules/editor';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';

type DragWriteCoalescer = ReturnType<typeof createDragWriteCoalescer>;

/** Infinite canvas leaves `board.root` null — clip defs live on the shared scene SVG. */
function resolveBoardClipRoot(board: DomHostBoardHandle | null | undefined): SVGSVGElement | null {
  if (board?.root) return board.root;
  return getSceneWorldRoot();
}

/** Merge live DOM hosts into board.nodeEls so frame-drag clip sync can find boolean paths. */
function mergeLiveHostElsIntoBoard(board: DomHostBoardHandle): void {
  const shared = getSharedNodeEls();
  for (const host of listShapeHosts()) {
    if (!host.el) continue;
    board.nodeEls.set(host.nodeId, host.el);
    if (shared) shared.set(host.nodeId, host.el);
  }
}

function syncOwnedFrameClipsOnBoard(
  board: DomHostBoardHandle,
  document: SceneDocument,
  opts: {
    zoom: number;
    nodeIds?: Iterable<string>;
  }
): void {
  const root = resolveBoardClipRoot(board);
  if (!root) return;
  mergeLiveHostElsIntoBoard(board);
  const ids = opts.nodeIds;
  if (ids) {
    for (const nodeId of ids) {
      const node = document.deltaSetLike?.[nodeId];
      const el = board.nodeEls.get(nodeId);
      if (!node || !el) continue;
      syncFrameContentClip(root, el, document, node as Record<string, unknown>, {
        zoom: opts.zoom,
        revealOverflow: shapeHostRevealsOverflow(nodeId),
      });
    }
    return;
  }
  for (const [nodeId, el] of board.nodeEls.entries()) {
    const node = document.deltaSetLike?.[nodeId];
    if (!node) continue;
    syncFrameContentClip(root, el, document, node as Record<string, unknown>, {
      zoom: opts.zoom,
      revealOverflow: shapeHostRevealsOverflow(nodeId),
    });
  }
}

export type SceneBox = { left: number; top: number; width: number; height: number };

export type GeomPatch = {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** Atomic with box — line/arrow endpoint drag must not angle-preview alone. */
  angle?: number;
};

/** Fit generator plate to viewport, center on scene click (or fallback), snap to grid. */
export function layoutGeneratorPlateAtScene(opts: {
  document: SceneDocument | null | undefined;
  camera: { zoom?: number };
  stageEl: HTMLElement | null;
  natural: { width: number; height: number };
  center: { x: number; y: number } | null;
  fit?: { minRatio?: number; maxRatio?: number };
}): { x: number; y: number; width: number; height: number } {
  const doc = opts.document;
  const fallback = { x: 40, y: 40, width: 360, height: 360 };
  if (!doc) return fallback;
  const view = opts.stageEl?.getBoundingClientRect();
  const zoom = Math.max(0.05, Number(opts.camera?.zoom) || 1);
  const center =
    opts.center && Number.isFinite(opts.center.x) && Number.isFinite(opts.center.y)
      ? opts.center
      : { x: 40 + fallback.width / 2, y: 40 + fallback.height / 2 };
  if (!view || view.width <= 0 || view.height <= 0) {
    const origin = sceneToDocumentCoords(
      doc,
      center.x - fallback.width / 2,
      center.y - fallback.height / 2
    );
    return { ...fallback, x: origin.x, y: origin.y };
  }
  const laid = rcbLayoutGeneratorPlate({
    natural: opts.natural,
    viewport: { width: view.width, height: view.height },
    zoom,
    center,
    gridSize: getDocumentGridSize(doc),
    visualOutset: GENERATOR_EMPTY_STROKE_OUTSET,
    fit: opts.fit,
  });
  const origin = sceneToDocumentCoords(doc, laid.left, laid.top);
  return { x: origin.x, y: origin.y, width: laid.width, height: laid.height };
}

export function listNodeIdsFromDoc(doc: SceneDocument | null | undefined): readonly string[] {
  const page = doc?.pages?.find((p) => p.id === doc?.activePageId) || doc?.pages?.[0];
  const fromPage = page?.children;
  // Return live children — never copy O(N) on every hit/guides call.
  if (Array.isArray(fromPage) && fromPage.length) return fromPage;
  const rootKids = doc?.deltaSetLike?.ROOT?.children;
  return Array.isArray(rootKids) ? rootKids : [];
}

/**
 * Ctrl/Cmd+A targets: same visibility as marquee / hit-test.
 * Under animation timeline focus, paint-hidden main artboards and their
 * children are excluded so select-all does not inflate a ghost AABB.
 */
export function collectSelectAllTargets(doc: SceneDocument | null | undefined): {
  nodeIds: string[];
  frameIds: string[];
} {
  if (!doc) return { nodeIds: [], frameIds: [] };
  const nodeIds: string[] = [];
  for (const id of listNodeIdsFromDoc(doc)) {
    if (!id || id === 'ROOT') continue;
    const node = doc.deltaSetLike?.[id];
    if (!node || isNodeMarqueeSkippable(doc, node)) continue;
    nodeIds.push(String(id));
  }
  const frameIds: string[] = [];
  for (const f of Array.isArray(doc.frames) ? doc.frames : []) {
    if (!f?.id || f.locked || !isArtboardVisibleInDocument(f)) continue;
    frameIds.push(String(f.id));
  }
  return { nodeIds, frameIds };
}

export function getNodeBoxFromDoc(doc: SceneDocument | null | undefined, nodeId: string): SceneBox | null {
  const node = doc?.deltaSetLike?.[nodeId];
  if (!node) return null;
  const { left, top } = nodeLeftTop(doc, node);
  let width = Math.max(1, Number(node.width) || 1);
  let height = Math.max(1, Number(node.height) || 1);
  // AutoSize text: grow chrome to measured line/em box so CJK ink is not clipped
  // when stored height is still the old 1em hug.
  if (
    node.key === 'text' &&
    !isTextFrameNode(node) &&
    String(node.attrs?.autoSize ?? 'true') !== 'false'
  ) {
    const style = parseNodeTextStyle(node.attrs || {});
    const plain = parseNodeText(node.attrs || {}) || ' ';
    const measured = measurePlainTextSize(plain, style);
    width = Math.max(width, measured.width);
    height = Math.max(height, measured.height);
  }
  const paint = effectivePaintBox(
    nodeId,
    {
      left,
      top,
      width,
      height,
    },
    Number(node.attrs?.angle) || 0
  );
  if (paint.hidden) return null;
  const geom: SceneBox = {
    left: paint.left,
    top: paint.top,
    width: paint.width,
    height: paint.height,
  };
  // Control box = path + stroke visual outer (resize / rotate follow ink).
  return inflateSelectionBox(geom, node);
}

/** Persist chrome box → stored path geometry. */
export function toGeometryPatches(doc: SceneDocument | null | undefined, patches: GeomPatch[]): GeomPatch[] {
  return patches.map((p) => {
    const node = doc?.deltaSetLike?.[p.nodeId];
    const deflated = deflateSelectionBox(p, node);
    return {
      ...p,
      left: deflated.left,
      top: deflated.top,
      width: deflated.width,
      height: deflated.height,
    };
  });
}

/**
 * Merge live preview angles from documentRef into the committed store base.
 * Line/arrow endpoint drags update angle only on the live doc until commit.
 */
export function mergeLiveAnglesIntoDoc(
  base: SceneDocument,
  live: SceneDocument | null | undefined,
  nodeIds: string[]
): SceneDocument {
  if (!live?.deltaSetLike || !nodeIds.length) return base;
  let deltaSetLike = base.deltaSetLike;
  let changed = false;
  for (const nodeId of nodeIds) {
    const liveNode = live.deltaSetLike[nodeId];
    const node = deltaSetLike?.[nodeId];
    if (!liveNode || !node) continue;
    const liveAngle = Number(liveNode.attrs?.angle);
    if (!Number.isFinite(liveAngle)) continue;
    const curAngle = Number(node.attrs?.angle) || 0;
    if (Math.abs(curAngle - liveAngle) < 1e-6) continue;
    if (!changed) {
      deltaSetLike = { ...deltaSetLike };
      changed = true;
    }
    deltaSetLike[nodeId] = {
      ...node,
      attrs: { ...node.attrs, angle: liveAngle },
    };
  }
  return changed ? { ...base, deltaSetLike } : base;
}

/** Line/arrow keep a 1px geometry height — hit tolerance is handled separately. */
export function normalizeGeomPatches(doc: SceneDocument | null | undefined, patches: GeomPatch[]): GeomPatch[] {
  return patches.map((p) => {
    const t = String(doc?.deltaSetLike?.[p.nodeId]?.attrs?.shapeType || '');
    if (t !== 'line' && t !== 'arrow') return p;
    const midY = p.top + p.height / 2;
    return {
      ...p,
      height: STROKE_GEOMETRY_HEIGHT,
      top: midY - STROKE_GEOMETRY_HEIGHT / 2,
      width: Math.max(1, p.width),
    };
  });
}

function rectIntersectsFrame(
  rect: { left: number; top: number; width: number; height: number },
  frame: { x?: number; y?: number; width?: number; height?: number }
) {
  const right = rect.left + Math.max(1, rect.width);
  const bottom = rect.top + Math.max(1, rect.height);
  const frameLeft = Number(frame.x) || 0;
  const frameTop = Number(frame.y) || 0;
  const frameRight = frameLeft + Math.max(1, Number(frame.width) || 1);
  const frameBottom = frameTop + Math.max(1, Number(frame.height) || 1);
  return rect.left < frameRight && right > frameLeft && rect.top < frameBottom && bottom > frameTop;
}

function frameForNodePlacement(
  doc: SceneDocument,
  rect: { left: number; top: number; width: number; height: number },
  node?: { key?: unknown; attrs?: Record<string, unknown> | null } | null
) {
  return frameForNodeIntersectPlacement(doc, rect, node);
}

function keepFrameOwner(
  doc: SceneDocument,
  node: SceneNode,
  ownerId: string,
  rect: { left: number; top: number; width: number; height: number }
): boolean {
  const owner = (doc.frames || []).find((frame) => String(frame.id) === ownerId);
  if (!owner || !rectIntersectsFrame(rect, owner)) return false;
  if (!canBindToArtboard(owner)) return false;
  if (!canBindNodeToArtboardFrame(owner, node)) return false;
  return true;
}

/** Maintain one explicit artboard binding through node moves and resizes. */
export function applyNodeFrameBindings(
  doc: SceneDocument,
  patches: GeomPatch[],
  detachedSink?: Set<string>
): SceneDocument {
  // LOT / precomp tab: canvas nodes are isolated; never rebind or drag-out.
  if (getLottiePrecompEditFocus().active) return doc;
  const bindingPatches: Array<{
    nodeId: string;
    patch: { attrs: Record<string, unknown>; x?: number; y?: number };
  }> = [];
  const focus = getAnimationWorkbenchTimelineFocus();
  for (const patch of patches) {
    const node = doc.deltaSetLike?.[patch.nodeId];
    if (!node) continue;
    // Membership vs frame.x/y must use document AABB (world absolute).
    const abs = nodeDocumentLeftTop(doc, node);
    const rect = {
      left: abs.left,
      top: abs.top,
      width: Math.max(1, Number(node.width) || Number(patch.width) || 1),
      height: Math.max(1, Number(node.height) || Number(patch.height) || 1),
    };
    const currentId = String(node.attrs?.frameId || '').trim();
    const nextId =
      currentId && keepFrameOwner(doc, node, currentId, rect)
        ? currentId
        : frameForNodePlacement(doc, rect, node);
    const surround = String(node.attrs?.[WORKBENCH_SURROUND_ATTR] || '').trim();
    if (nextId === currentId) {
      if (focus && !currentId && surround !== focus) {
        bindingPatches.push({
          nodeId: patch.nodeId,
          patch: {
            attrs: syncWorkbenchSurroundOnFrameBind({ ...(node.attrs || {}) }, null),
          },
        });
      }
      continue;
    }
    let attrs = { ...(node.attrs || {}) } as Record<string, unknown>;
    let nextX = Number(node.x) || 0;
    let nextY = Number(node.y) || 0;
    if (nextId) {
      attrs.frameId = nextId;
      if (nextId !== currentId) {
        const orders = Object.values(doc.deltaSetLike || {})
          .filter((item) => String(item?.attrs?.frameId || '').trim() === nextId)
          .map((item) => Number(item?.attrs?.frameOrder))
          .filter(Number.isFinite);
        attrs.frameOrder = orders.length ? Math.max(...orders) + 1 : 0;
      }
      attrs = syncWorkbenchSurroundOnFrameBind(attrs, nextId);
      // World absolute → plate local when entering / switching frames.
      if (isFrameLocalCoordSpace(doc)) {
        const world = currentId
          ? nodeLocalToDocumentPoint(doc, currentId, nextX, nextY)
          : { x: nextX, y: nextY };
        const origin = (Array.isArray(doc.frames) ? doc.frames : []).find(
          (f) => String(f?.id) === nextId
        );
        const fx = Number(origin?.x) || 0;
        const fy = Number(origin?.y) || 0;
        nextX = world.x - fx;
        nextY = world.y - fy;
      }
    } else {
      delete attrs.frameId;
      delete attrs.frameOrder;
      attrs = syncWorkbenchSurroundOnFrameBind(attrs, null);
      // Plate local → world absolute when leaving a frame.
      if (isFrameLocalCoordSpace(doc) && currentId) {
        const world = nodeLocalToDocumentPoint(doc, currentId, nextX, nextY);
        nextX = world.x;
        nextY = world.y;
      }
    }
    bindingPatches.push({
      nodeId: patch.nodeId,
      patch: { attrs, x: nextX, y: nextY },
    });
  }
  if (!bindingPatches.length) return doc;

  const nodeReplacements: Record<string, SceneNode> = {};
  for (const item of bindingPatches) {
    const node = doc.deltaSetLike?.[item.nodeId];
    if (!node) continue;
    nodeReplacements[item.nodeId] = {
      ...node,
      attrs: item.patch.attrs,
      ...(item.patch.x != null ? { x: item.patch.x } : null),
      ...(item.patch.y != null ? { y: item.patch.y } : null),
    };
  }
  let next = {
    ...doc,
    deltaSetLike: patchDeltaSetLike(doc.deltaSetLike, nodeReplacements),
  };

  const detachedIds = bindingPatches
    .filter(({ nodeId, patch }) => {
      const before = doc.deltaSetLike?.[nodeId];
      return (
        Boolean(String(before?.attrs?.frameId || '').trim()) &&
        !String(patch.attrs?.frameId || '').trim()
      );
    })
    .map(({ nodeId }) => nodeId);
  if (detachedIds.length) {
    detachedIds.forEach((id) => detachedSink?.add(id));
    const detachedKeys = new Set(detachedIds.map((id) => `node:${id}`));
    const order = Array.isArray(next?.stackOrder) ? next.stackOrder.map(String) : [];
    next = {
      ...next,
      stackOrder: [
        ...order.filter((key) => !detachedKeys.has(key)),
        ...detachedIds.map((id) => `node:${id}`),
      ],
    };
  }
  reconcileStackOrder(next);
  return next;
}

/** Bind a freshly created node to the clipContent frame its bbox intersects. */
export function bindCreatedNodeToFrame(
  doc: SceneDocument,
  nodeId: string,
  rect: { left: number; top: number; width: number; height: number },
  preferredFrameId?: string | null
): SceneDocument {
  const node = doc.deltaSetLike?.[nodeId];
  if (!node) return doc;
  const preferred = acceptCreateFrameId(
    doc,
    preferredFrameId ?? (node.attrs?.frameId != null ? String(node.attrs.frameId) : null),
    node
  );
  let next = doc;
  if (preferred && String(node.attrs?.frameId || '').trim() !== preferred) {
    const patch: { attrs: Record<string, unknown>; x?: number; y?: number } = {
      attrs: { ...(node.attrs || {}), frameId: preferred },
    };
    if (isFrameLocalCoordSpace(doc)) {
      const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
        (f) => String(f?.id) === preferred
      );
      if (frame) {
        // `rect` is world/scene absolute from the create gesture.
        const abs = {
          x: (Number(doc.x) || 0) + rect.left,
          y: (Number(doc.y) || 0) + rect.top,
        };
        patch.x = abs.x - (Number(frame.x) || 0);
        patch.y = abs.y - (Number(frame.y) || 0);
      }
    }
    next = updateNodesInDocument(doc, [{ nodeId, patch }]);
  }
  // Final AABB wins — drop preferred when the finished ink is off-plate.
  next = applyNodeFrameBindings(next, [{ nodeId, ...rect }]);
  return tagCreatedNodeForWorkbenchSurround(next, nodeId);
}

function promoteNodesToWorldTop(doc: SceneDocument, nodeIds: Iterable<string>): SceneDocument {
  const ids = [...new Set([...nodeIds].map(String).filter(Boolean))];
  if (!ids.length) return doc;
  const keys = new Set(ids.map((id) => `node:${id}`));
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder.map(String) : [];
  const remaining = order.filter((key) => !keys.has(key));
  return {
    ...doc,
    stackOrder: [...remaining, ...ids.map((id) => `node:${id}`)],
  };
}

function sameStringList(a: unknown, b: unknown): boolean {
  const aa = Array.isArray(a) ? a.map(String) : [];
  const bb = Array.isArray(b) ? b.map(String) : [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) if (aa[i] !== bb[i]) return false;
  return true;
}

/** True when ROOT/stack/frame membership changed — needs a full document write. */
function geometryCommitNeedsFullDocumentWrite(
  before: SceneDocument,
  after: SceneDocument
): boolean {
  if (!sameStringList(before.deltaSetLike?.ROOT?.children, after.deltaSetLike?.ROOT?.children)) {
    return true;
  }
  if (!sameStringList(before.stackOrder, after.stackOrder)) return true;
  const beforeIds = Object.keys(before.deltaSetLike || {});
  const afterIds = Object.keys(after.deltaSetLike || {});
  if (beforeIds.length !== afterIds.length) return true;
  for (const id of afterIds) {
    if (id === 'ROOT') continue;
    const bn = before.deltaSetLike?.[id];
    const an = after.deltaSetLike?.[id];
    if (!bn || !an) return true;
    if (String(bn.attrs?.frameId || '') !== String(an.attrs?.frameId || '')) return true;
    if (String(bn.attrs?.frameOrder ?? '') !== String(an.attrs?.frameOrder ?? '')) return true;
    if (
      String(bn.attrs?.[WORKBENCH_SURROUND_ATTR] || '') !==
      String(an.attrs?.[WORKBENCH_SURROUND_ATTR] || '')
    ) {
      return true;
    }
  }
  const bf = Array.isArray(before.frames) ? before.frames : [];
  const af = Array.isArray(after.frames) ? after.frames : [];
  if (bf.length !== af.length) return true;
  for (let i = 0; i < bf.length; i += 1) {
    if (String(bf[i]?.id) !== String(af[i]?.id)) return true;
  }
  return false;
}

/**
 * Build an editor-store node patch from before→after.
 * Callers must pass the **store head** as `before` (not a doc that already
 * baked live preview attrs). Diffing against a merged live angle hides the
 * angle change and line/arrow endpoint release keeps the pre-drag angle.
 */
export function nodePatchFromGeometryDiff(
  before: SceneNode | undefined,
  after: SceneNode | undefined
): Record<string, unknown> | null {
  if (!before || !after) return null;
  const patch: Record<string, unknown> = {};
  if ((Number(before.x) || 0) !== (Number(after.x) || 0)) patch.x = after.x;
  if ((Number(before.y) || 0) !== (Number(after.y) || 0)) patch.y = after.y;
  if ((Number(before.width) || 0) !== (Number(after.width) || 0)) patch.width = after.width;
  if ((Number(before.height) || 0) !== (Number(after.height) || 0)) patch.height = after.height;
  const ba = (before.attrs || {}) as Record<string, unknown>;
  const aa = (after.attrs || {}) as Record<string, unknown>;
  const attrKeys = new Set([...Object.keys(ba), ...Object.keys(aa)]);
  let attrsChanged = false;
  const nextAttrs: Record<string, unknown> = { ...ba };
  for (const key of attrKeys) {
    if (key === 'frameId' || key === 'frameOrder' || key === WORKBENCH_SURROUND_ATTR) continue;
    if (!(key in aa)) {
      if (key in ba) return null; // key removal — fall back to full write
      continue;
    }
    if (ba[key] === aa[key]) continue;
    try {
      if (JSON.stringify(ba[key]) === JSON.stringify(aa[key])) continue;
    } catch {
      /* treat as changed */
    }
    nextAttrs[key] = aa[key];
    attrsChanged = true;
  }
  if (attrsChanged) patch.attrs = nextAttrs;
  return Object.keys(patch).length ? patch : null;
}

export type CanvasSessionDeps = {
  getDocument: () => SceneDocument | null;
  /** Prefer store head during transform — local ref can lag finishImageProcess. */
  getCommittedDocument?: () => SceneDocument | null;
  setDocumentLocal: (doc: SceneDocument) => void;
  getBoard: () => DomHostBoardHandle | null;
  getZoom: () => number;
  isReadOnly: () => boolean;

  setEditingTextId: (id: string | null) => void;
  measureViewport: () => DOMRect | null;
  getDragWriteCoalescer: () => DragWriteCoalescer;
  previewFrameGeometry: (frames: ArtboardFrameGeometry[]) => void;
  clearFrameGeometryPreview: (frameIds?: readonly string[]) => void;
  publishVideoLiveGeom: (next: Record<string, VideoGeomOverride> | null) => void;
  clearVideoLiveGeom: () => void;
};

function resolvePreviewHostEl(board: DomHostBoardHandle, nodeId: string): SVGElement | null {
  const cached = board.nodeEls.get(nodeId);
  if (cached) return cached;
  const fromHost = getShapeHost(nodeId)?.el;
  if (fromHost) {
    board.nodeEls.set(nodeId, fromHost);
    return fromHost;
  }
  const fromShared = getSharedNodeEls()?.get(nodeId);
  if (fromShared) {
    board.nodeEls.set(nodeId, fromShared);
    return fromShared;
  }
  return null;
}

function previewAngleDeg(nodeId: string, node: { attrs?: Record<string, unknown> } | null | undefined): number {
  const live = getNodeTransformPreview(nodeId)?.angle;
  if (Number.isFinite(live)) return Number(live);
  return Number(node?.attrs?.angle) || 0;
}

export type CanvasSession = {
  listNodeIds: () => readonly string[];
  getNodeBox: (nodeId: string) => SceneBox | null;
  hitTest: (
    x: number,
    y: number,
    screen?: { clientX: number; clientY: number }
  ) => string | null;
  finishToSelect: () => void;
  imageSizeForViewport: (natural: { width: number; height: number }) => {
    width: number;
    height: number;
  };
  onGeometryCommit: (
    patches: GeomPatch[],
    options?: { textResizeMode?: 'scale' | 'wrap'; skipHistory?: boolean }
  ) => void;
  onGeometryPreview: (
    patches: GeomPatch[],
    options?: { textResizeMode?: 'scale' | 'wrap' | 'frame' }
  ) => void;
  resetFrameMoveOwners: () => void;
  onAngleCommit: (nodeId: string, angleDeg: number, options?: { skipHistory?: boolean }) => void;
  onAnglePreview: (nodeId: string, angleDeg: number) => void;
};

export function createCanvasSession(deps: CanvasSessionDeps): CanvasSession {
  const frameMoveOwners = new Map<string, string[]>();
  const detachedNodeIds = new Set<string>();
  const listNodeIds = () => listNodeIdsFromDoc(deps.getDocument());

  const getNodeBox = (nodeId: string) => getNodeBoxFromDoc(deps.getDocument(), nodeId);

  const hitTest = (
    x: number,
    y: number,
    _screen?: { clientX: number; clientY: number }
  ) => hitTestRcbIdFromKit(x, y);

  const finishToSelect = () => {
    setActiveTool('select');
  };

  const imageSizeForViewport = (natural: { width: number; height: number }) => {
    const view = deps.measureViewport();
    if (!view || view.width < 1 || view.height < 1) {
      return fitImageSize(natural.width, natural.height, 2400);
    }
    return rcbFitImageIntoViewport(natural, view, deps.getZoom());
  };

  const applyFrameGeometryPatches = (
    patches: GeomPatch[],
    opts?: { preview?: boolean }
  ) => {
    const nodePatches: GeomPatch[] = [];
    const frames: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
    for (const p of patches) {
      const fid = parseFrameSelId(p.nodeId);
      if (fid) {
        frames.push({
          id: fid,
          x: p.left,
          y: p.top,
          width: Math.max(1, p.width),
          height: Math.max(1, p.height),
        });
      } else {
        nodePatches.push(p);
      }
    }
    if (!frames.length) return { nodePatches, frames };
    // Live paint is imperative, just like node SVG geometry. The store only
    // receives the final document on commit so frame and content cannot alternate.
    if (opts?.preview) {
      deps.previewFrameGeometry(frames);
    }
    return { nodePatches, frames };
  };

  const translateFrameContent = (
    doc: SceneDocument,
    _frames: Array<{ id: string; x: number; y: number }>,
    _owners: Map<string, string[]> = frameMoveOwners,
    _skipNodeIds?: ReadonlySet<string>
  ) => {
    // Plate-local children: frame move never rewrites child x/y.
    return doc;
  };

  const onGeometryCommit = (
    patches: GeomPatch[],
    options?: { textResizeMode?: 'scale' | 'wrap'; skipHistory?: boolean }
  ) => {
    // Drop coalesced media previews — frame paint is committed below.
    deps.getDragWriteCoalescer().cancel();
    // Base geometry on the committed editor-store doc. During a transform,
    // documentRef is intentionally not synced from the store — writing it
    // back would revive attrs cleared mid-drag (e.g. processStatus after
    // upload finishes).
    const committed = deps.getCommittedDocument?.() ?? null;
    const live = deps.getDocument();
    const board = deps.getBoard();
    if ((!committed && !live) || deps.isReadOnly() || !patches.length) return;
    const { nodePatches, frames } = applyFrameGeometryPatches(patches);
    const touchedNodeIds = nodePatches
      .map((p) => String(p.nodeId || '').trim())
      .filter(Boolean);
    // Store head before baking live preview angles — incremental patches must
    // diff against this, or endpoint-drag angle never lands in the store.
    const committedBase = committed || live!;
    const doc = mergeLiveAnglesIntoDoc(committedBase, live, touchedNodeIds);
    let next = doc;
    if (nodePatches.length) {
      const normalized = normalizeGeomPatches(doc, toGeometryPatches(doc, nodePatches));
      next = patchNodesGeometry(doc, normalized, {
        fitTextBox: true,
        textResizeMode: options?.textResizeMode,
      });
      next = applyNodeFrameBindings(next, normalized, detachedNodeIds);
      next = promoteNodesToWorldTop(next, detachedNodeIds);
      // Sync SVG for node patches (below). Keep normalized in scope via rebuild from next.
      deps.setDocumentLocal(next);
      if (board) {
        normalized.forEach((p) => {
          clearSceneDragPreview(board.nodeEls, p.nodeId);
          // Bake drag preview into host paint (noop preview always returned false).
          void replaceShapePaint(next, board.nodeEls, p.nodeId, board.root ? board : null);
        });
        const validIds = next?.deltaSetLike?.ROOT?.children || [];
        if (board.layer) {
          purgeOrphanSceneNodes(board.layer, board.nodeEls, validIds);
        } else {
          [...board.nodeEls.keys()].forEach((id) => {
            if (!validIds.includes(id)) board.nodeEls.delete(id);
          });
        }
      }
    }
    // Merge frame boxes into the same document write so nodes don't clobber frames.
    if (frames.length) {
      next = translateFrameContent(next, frames, frameMoveOwners);
      const byId = new Map(frames.map((f) => [f.id, f]));
      next = {
        ...next,
        frames: (Array.isArray(next.frames) ? next.frames : []).map((f: any) => {
          const hit = byId.get(String(f?.id));
          if (!hit) return f;
          return { ...f, x: hit.x, y: hit.y, width: hit.width, height: hit.height };
        }),
      };
      // Keep animation workbench host glued to the plate on commit.
      const hostPatches: Array<{ nodeId: string; patch: Record<string, unknown> }> = [];
      for (const frame of frames) {
        const hostId = findFrameAnimationMediaId(next, frame.id);
        if (!hostId) continue;
        const host = next.deltaSetLike?.[hostId];
        if (!host) continue;
        const localPlate = String(next.coordSpace || '') === 'frameLocal';
        const patch: Record<string, unknown> = {
          x: localPlate ? 0 : frame.x,
          y: localPlate ? 0 : frame.y,
          width: frame.width,
          height: frame.height,
        };
        // Keep Bodymovin w/h in lockstep so timeline / export match the plate
        // without a second ensureAnimationFrameMedia history entry.
        if (host.key === 'lottie' && host.attrs?.animationData) {
          try {
            const raw = host.attrs.animationData;
            const data =
              typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : raw;
            if (data && typeof data === 'object') {
              patch.attrs = {
                ...(host.attrs || {}),
                animationData: JSON.stringify({
                  ...data,
                  w: frame.width,
                  h: frame.height,
                }),
              };
            }
          } catch {
            /* ignore malformed animation JSON */
          }
        }
        hostPatches.push({ nodeId: hostId, patch });
      }
      if (hostPatches.length) {
        next = updateNodesInDocument(next, hostPatches);
      }
    }
    const latestCommitted = deps.getCommittedDocument?.() ?? committed;
    if (latestCommitted && touchedNodeIds.length) {
      for (const id of touchedNodeIds) {
        const committedNode = latestCommitted.deltaSetLike?.[id];
        const pending = String(committedNode?.attrs?.processStatus || '') === 'running';
        const written = String(next?.deltaSetLike?.[id]?.attrs?.processStatus || '') === 'running';
        if (!pending && written) {
          next = clearImageProcessAttrs(next, id);
        }
      }
    }
    deps.setDocumentLocal(next);
    if (!options?.skipHistory) {
      pushEditorHistory();
    }
    const useFullWrite =
      detachedNodeIds.size > 0 || geometryCommitNeedsFullDocumentWrite(doc, next);
    if (useFullWrite) {
      setDocumentFromCanvas(next);
    } else {
      const nodeWrites: Array<{ nodeId: string; patch: Record<string, unknown> }> = [];
      const ids = Object.keys(next.deltaSetLike || {});
      for (const id of ids) {
        if (id === 'ROOT') continue;
        const patch = nodePatchFromGeometryDiff(
          committedBase.deltaSetLike?.[id],
          next.deltaSetLike?.[id]
        );
        if (patch) nodeWrites.push({ nodeId: id, patch });
      }
      if (nodeWrites.length) {
        patchDocumentNodes({ patches: nodeWrites, skipHistory: true });
      }
      if (frames.length) {
        updateArtboardFrames({
            patches: frames.map((f) => ({
              id: f.id,
              patch: { x: f.x, y: f.y, width: f.width, height: f.height },
            })),
            skipHistory: true,
          });
      }
      if (!options?.skipHistory && (nodeWrites.length || frames.length)) {
        touchDocumentRevision();
      }
    }
    // skipHistory geometry patches skip store ensure — refresh timeline when
    // bind/unbind changed 动画工作台 children (create/move-in/move-out).
    queueEnsureAnimationFramesForDocChange(committedBase, next, {
      nodeIds: touchedNodeIds,
      skipHistory: true,
    });
    // Auto-key animated p/s when moving/resizing on a 动画工作台.
    const playheadSec = getAnimationPlayheadSec();
    for (const id of touchedNodeIds) {
      const before = doc.deltaSetLike?.[id];
      const after = next.deltaSetLike?.[id];
      if (!before || !after) continue;
      const moved =
        Math.abs((Number(before.x) || 0) - (Number(after.x) || 0)) > 0.01 ||
        Math.abs((Number(before.y) || 0) - (Number(after.y) || 0)) > 0.01;
      const resized =
        Math.abs((Number(before.width) || 0) - (Number(after.width) || 0)) > 0.01 ||
        Math.abs((Number(before.height) || 0) - (Number(after.height) || 0)) > 0.01;
      if (!moved && !resized) continue;
      const keyed = autoKeyAnimatedGeometry({
        document: next,
        nodeId: id,
        playheadSec,
        moved,
        resized,
      });
      if (!keyed) continue;
      patchDocumentNode({
          nodeId: keyed.hostId,
          patch: { attrs: { animationData: keyed.animationJson } },
          skipHistory: Boolean(options?.skipHistory),
        });
    }
    // Same React turn as the store doc — HTML plates must not fall back to
    // stale coords between commit and onTransformingChange(false).
    // Pass committed frame ids so multi-frame mode:move rebakes every host even
    // when the last preview coalesce was cancelled (empty preview set).
    deps.clearVideoLiveGeom();
    deps.clearFrameGeometryPreview(frames.map((f) => f.id));
    clearNodeTransformPreviews();
    if (frames.length && board) {
      syncOwnedFrameClipsOnBoard(board, next, { zoom: deps.getZoom() });
    }
    frameMoveOwners.clear();
    detachedNodeIds.clear();
  };

  const onGeometryPreview = (
    patches: GeomPatch[],
    options?: { textResizeMode?: 'scale' | 'wrap' | 'frame' }
  ) => {
    const doc = deps.getDocument();
    const board = deps.getBoard();
    if (!doc || deps.isReadOnly() || !patches.length) return;
    const { nodePatches, frames } = applyFrameGeometryPatches(patches, { preview: true });
    if (!board) return;
    // Plate-only + frameLocal: skip binding owner scans — they are O(bound) and
    // unused when children keep local x/y (animation workbench drag).
    const plateOnlyFrameLocal =
      frames.length > 0 && !nodePatches.length && isFrameLocalCoordSpace(doc);
    if (frames.length && !plateOnlyFrameLocal) {
      for (const frame of frames) {
        if (!frameMoveOwners.has(frame.id)) {
          frameMoveOwners.set(frame.id, nodeIdsBoundToFrames(doc, [frame.id]));
        }
      }
    }
    const normalized = nodePatches.length
      ? normalizeGeomPatches(doc, toGeometryPatches(doc, nodePatches))
      : [];
    let next = normalized.length
      ? patchNodesGeometry(doc, normalized, {
          textResizeMode: options?.textResizeMode,
        })
      : doc;
    // Stroke endpoint (and any patch that carries angle): bake attrs.angle with the
    // same local write as geometry so live doc never shows new angle + old shaft.
    if (normalized.length) {
      let angleDelta = next.deltaSetLike;
      let angleDirty = false;
      for (const p of normalized) {
        const nextAngle = Number(p.angle);
        if (!Number.isFinite(nextAngle)) continue;
        const node = angleDelta?.[p.nodeId];
        if (!node) continue;
        const baked = Number(nextAngle.toFixed(2));
        const cur = Number(node.attrs?.angle) || 0;
        if (Math.abs(cur - baked) < 1e-6) continue;
        if (!angleDirty) {
          angleDelta = { ...angleDelta };
          angleDirty = true;
        }
        angleDelta[p.nodeId] = {
          ...node,
          attrs: { ...node.attrs, angle: baked },
        };
      }
      if (angleDirty) next = { ...next, deltaSetLike: angleDelta };
    }
    if (normalized.length) {
      next = applyNodeFrameBindings(next, normalized, detachedNodeIds);
      next = promoteNodesToWorldTop(next, detachedNodeIds);
      // Detach stays on documentRef until pointer-up commit — mid-drag store
      // writes re-render the whole editor and push Yjs on every move.
    }
    const translated = plateOnlyFrameLocal
      ? next
      : translateFrameContent(
          next,
          frames,
          frameMoveOwners,
          new Set(normalized.map((p) => String(p.nodeId || '').trim()).filter(Boolean))
        );
    const framePatchById = frames.length
      ? new Map(frames.map((frame) => [frame.id, frame]))
      : null;
    let previewDocument = frames.length
      ? {
          ...translated,
          frames: (Array.isArray(translated.frames) ? translated.frames : []).map((frame) => {
            const patch = framePatchById?.get(frame.id);
            return patch ? { ...frame, ...patch } : frame;
          }),
        }
      : next;
    deps.setDocumentLocal(previewDocument);
    const videoOverrides: Record<string, VideoGeomOverride> = {};
    let hasVideo = false;
    const coalescer = deps.getDragWriteCoalescer();
    const previewPatches: Array<{
      nodeId: string;
      left: number;
      top: number;
      width: number;
      height: number;
      angle?: number;
    }> = [];
    const previewBoxes = new Map<
      string,
      { left: number; top: number; width: number; height: number }
    >();
    normalized.forEach((p) => {
      const node = previewDocument?.deltaSetLike?.[p.nodeId];
      const isText = node?.key === 'text';
      const box =
        isText && options?.textResizeMode === 'wrap'
          ? {
              left: p.left,
              top: p.top,
              width: Math.max(1, Number(node.width) || p.width),
              height: Math.max(1, Number(node.height) || p.height),
            }
          : p;
      previewBoxes.set(p.nodeId, box);
      const patchAngle = Number(p.angle);
      previewPatches.push({
        nodeId: p.nodeId,
        left: box.left,
        top: box.top,
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
        angle: Number.isFinite(patchAngle) ? patchAngle : previewAngleDeg(p.nodeId, node),
      });
      if (
        node?.key === 'video' ||
        node?.key === 'lottie' ||
        node?.key === 'audio' ||
        // SoftGlow process plates sit in HTML — keep them glued like media hosts.
        node?.key === 'image'
      ) {
        hasVideo = true;
        const pending = coalescer.getPendingVideoGeom()?.[p.nodeId];
        const host = board.nodeEls.get(p.nodeId) as
          | (SVGElement & {
              __sceneDidResize?: boolean;
              __sceneDragBaseW?: number;
              __sceneDragBaseH?: number;
            })
          | undefined;
        // While CSS-scale resizing, FO stays at drag-base size — HTML plate must
        // match that base box or scrubber/video layout drifts inside the FO.
        const useBase =
          Boolean(host?.__sceneDidResize) &&
          Number(host?.__sceneDragBaseW) > 0 &&
          Number(host?.__sceneDragBaseH) > 0;
        videoOverrides[p.nodeId] = {
          left: box.left,
          top: box.top,
          width: useBase ? Number(host!.__sceneDragBaseW) : Math.max(1, box.width),
          height: useBase ? Number(host!.__sceneDragBaseH) : Math.max(1, box.height),
          angle: Number.isFinite(pending?.angle)
            ? Number(pending!.angle)
            : Number(node.attrs?.angle) || 0,
        };
      }
    });
    if (frames.length) {
      const movingFrameIds = new Set(frames.map((frame) => String(frame.id || '').trim()));
      const frameLocal = isFrameLocalCoordSpace(previewDocument);
      // Frame-local plate drag: children keep local x/y. Kit ink follows live plate
      // via nodeLeftTop — do NOT spatial-patch / rewrite every bound child each move
      // (animation workbench with hundreds of layers freezes the tab).
      if (frameLocal && !normalized.length) {
        // Only touch mounted DOM hosts — Kit shapes have no lattice entry.
        if (board.nodeEls.size) {
          mergeLiveHostElsIntoBoard(board);
          const animHostByFrame = new Map<string, string | null>();
          for (const frame of frames) {
            if (!animHostByFrame.has(frame.id)) {
              animHostByFrame.set(frame.id, findFrameAnimationMediaId(previewDocument, frame.id));
            }
            const hostId = animHostByFrame.get(frame.id);
            if (!hostId) continue;
            const host = previewDocument.deltaSetLike?.[hostId];
            if (!host) continue;
            // Invisible animationFrameHost FO: skip geometry + videoLiveGeom.
            // Updating the FO every move reflows lottie-web and freezes the tab.
            const isAnimHost =
              host.attrs?.animationFrameHost === true ||
              host.attrs?.animationFrameHost === 'true';
            if (isAnimHost) continue;
            if (host.key === 'lottie' || host.key === 'video' || host.key === 'image') {
              hasVideo = true;
              videoOverrides[hostId] = {
                left: frame.x,
                top: frame.y,
                width: frame.width,
                height: frame.height,
                angle: Number(host.attrs?.angle) || 0,
              };
            }
          }
          const clipIds: string[] = [];
          for (const [nodeId] of board.nodeEls.entries()) {
            const node = previewDocument.deltaSetLike?.[nodeId];
            if (!node) continue;
            const owner = String(
              (node.attrs as Record<string, unknown> | undefined)?.frameId || ''
            ).trim();
            if (!owner || !movingFrameIds.has(owner)) continue;
            if (animHostByFrame.get(owner) === nodeId) continue;
            clipIds.push(nodeId);
          }
          if (clipIds.length) {
            syncOwnedFrameClipsOnBoard(board, previewDocument, {
              zoom: deps.getZoom(),
              nodeIds: clipIds,
            });
          }
        }
        if (hasVideo) {
          deps.publishVideoLiveGeom({
            ...(coalescer.getPendingVideoGeom() || {}),
            ...videoOverrides,
          });
        }
        return;
      }
      // Animation frame host tracks plate size — local 0,0 under frameLocal.
      let hostDelta = previewDocument.deltaSetLike || {};
      let hostDeltaDirty = false;
      const localPlate = String(previewDocument.coordSpace || '') === 'frameLocal';
      for (const frame of frames) {
        const hostId = findFrameAnimationMediaId(previewDocument, frame.id);
        if (!hostId) continue;
        const host = hostDelta[hostId];
        if (!host) continue;
        const box = {
          left: frame.x,
          top: frame.y,
          width: frame.width,
          height: frame.height,
        };
        const isAnimHost =
          host.attrs?.animationFrameHost === true ||
          host.attrs?.animationFrameHost === 'true';
        if (isAnimHost) {
          // Invisible host — do not re-seat FO or rewrite geom mid-drag.
          continue;
        }
        if (host.key === 'lottie' || host.key === 'video' || host.key === 'image') {
          hasVideo = true;
          videoOverrides[hostId] = {
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            angle: Number(host.attrs?.angle) || 0,
          };
        }
        const nextX = localPlate ? 0 : box.left;
        const nextY = localPlate ? 0 : box.top;
        if (
          Number(host.x) === nextX &&
          Number(host.y) === nextY &&
          Number(host.width) === box.width &&
          Number(host.height) === box.height
        ) {
          continue;
        }
        if (!hostDeltaDirty) {
          hostDelta = { ...hostDelta };
          hostDeltaDirty = true;
        }
        hostDelta[hostId] = {
          ...host,
          x: nextX,
          y: nextY,
          width: box.width,
          height: box.height,
        };
      }
      if (hostDeltaDirty) {
        previewDocument = { ...previewDocument, deltaSetLike: hostDelta };
        deps.setDocumentLocal(previewDocument);
      }
    }
    // TransformPreview before clip — findClippingFrameForNode prefers preview
    // over node x/y; stale preview + live plate = one-frame spill/jitter.
    setNodeTransformPreviews(previewPatches);
    // Frame move/resize: clip only hosts bound to the moving plate(s).
    // Infinite canvas: board.root is null — use shared scene world root.
    if (frames.length) {
      const movingFrameIds = new Set(frames.map((frame) => String(frame.id || '').trim()));
      const clipIds: string[] = [];
      mergeLiveHostElsIntoBoard(board);
      for (const [nodeId] of board.nodeEls.entries()) {
        const node = previewDocument.deltaSetLike?.[nodeId];
        if (!node) continue;
        const owner = String(
          (node.attrs as Record<string, unknown> | undefined)?.frameId || ''
        ).trim();
        const coMoves = frames.some((frame) =>
          (frameMoveOwners.get(frame.id) || []).includes(nodeId)
        );
        if (!coMoves && (!owner || !movingFrameIds.has(owner))) continue;
        clipIds.push(nodeId);
      }
      syncOwnedFrameClipsOnBoard(board, previewDocument, {
        zoom: deps.getZoom(),
        nodeIds: clipIds,
      });
    } else if (previewBoxes.size) {
      const root = resolveBoardClipRoot(board);
      if (root) {
        mergeLiveHostElsIntoBoard(board);
        for (const [nodeId, box] of previewBoxes) {
          const node = previewDocument.deltaSetLike?.[nodeId];
          const el = board.nodeEls.get(nodeId);
          if (!node || !el) continue;
          syncFrameContentClip(
            root,
            el,
            previewDocument,
            { ...node, x: box.left, y: box.top, width: box.width, height: box.height },
            {
              zoom: deps.getZoom(),
              revealOverflow: shapeHostRevealsOverflow(nodeId),
            }
          );
        }
      }
    }
    // Kit owns ink AABB - DomHost cull uses live document geometry.
    // Keep HTML <video> plates glued to chrome (store doc is still pre-gesture).
    if (hasVideo) {
      deps.publishVideoLiveGeom({
        ...(coalescer.getPendingVideoGeom() || {}),
        ...videoOverrides,
      });
    }
  };

  const onAngleCommit = (
    nodeId: string,
    angleDeg: number,
    options?: { skipHistory?: boolean }
  ) => {
    if (deps.isReadOnly() || !nodeId) return;
    const nextAngle = Number(angleDeg.toFixed(2));
    const doc = deps.getDocument();
    if (doc?.deltaSetLike?.[nodeId]) {
      const node = doc.deltaSetLike[nodeId];
      deps.setDocumentLocal({
        ...doc,
        deltaSetLike: patchDeltaSetLike(doc.deltaSetLike, {
          [nodeId]: {
            ...node,
            attrs: { ...node.attrs, angle: nextAngle },
          },
        }),
      });
    }
    patchDocumentNode({
        nodeId,
        patch: { attrs: { angle: nextAngle } },
        skipHistory: Boolean(options?.skipHistory),
      });
    // When rotation is already keyframed, write the live angle into the curve
    // at the playhead (frame sync skips animated `r`, so attrs-only would no-op).
    const keyed = autoKeyAnimatedProp({
      document: deps.getDocument() || doc,
      nodeId,
      propKey: 'r',
      playheadSec: getAnimationPlayheadSec(),
      value: nextAngle,
    });
    if (keyed) {
      patchDocumentNode({
          nodeId: keyed.hostId,
          patch: { attrs: { animationData: keyed.animationJson } },
          skipHistory: Boolean(options?.skipHistory),
        });
    }
    clearNodeTransformPreviews([nodeId]);
  };

  const onAnglePreview = (nodeId: string, angleDeg: number) => {
    const doc = deps.getDocument();
    const board = deps.getBoard();
    if (!doc || !board || deps.isReadOnly() || !nodeId) return;
    const node = doc.deltaSetLike?.[nodeId];
    if (!node) return;
    const nextAngle = Number(angleDeg.toFixed(2));
    deps.setDocumentLocal({
      ...doc,
      deltaSetLike: patchDeltaSetLike(doc.deltaSetLike, {
        [nodeId]: {
          ...node,
          attrs: { ...node.attrs, angle: nextAngle },
        },
      }),
    });

    setNodeTransformAngles([{ nodeId, angle: nextAngle }]);
    if (!resolvePreviewHostEl(board, nodeId)) {
      return;
    }
    if (board.nodeEls.get(nodeId)) {
      void replaceShapePaint(
        deps.getDocument(),
        board.nodeEls,
        nodeId,
        board.root ? board : null
      );
    }
    // HTML video / lottie / audio / image SoftGlow plates read store doc —
    // push live angle so rotate tracks chrome.
    if (
      isVideoNode(node) ||
      isLottieNode(node) ||
      isAudioNode(node) ||
      node.key === 'image'
    ) {
      const live = deps.getDocument()?.deltaSetLike?.[nodeId] || node;
      const { left, top } = nodeLeftTop(deps.getDocument(), live);
      const coalescer = deps.getDragWriteCoalescer();
      const pending = coalescer.getPendingVideoGeom()?.[nodeId];
      deps.publishVideoLiveGeom({
        ...(coalescer.getPendingVideoGeom() || {}),
        [nodeId]: {
          left: pending?.left ?? left,
          top: pending?.top ?? top,
          width: Math.max(1, pending?.width != null ? pending.width : Number(live.width) || 1),
          height: Math.max(
            1,
            pending?.height != null ? pending.height : Number(live.height) || 1
          ),
          angle: nextAngle,
        },
      });
    }
  };

  return {
    listNodeIds,
    getNodeBox,
    hitTest,
    finishToSelect,
    imageSizeForViewport,
    onGeometryCommit,
    onGeometryPreview,
    resetFrameMoveOwners: () => {
      frameMoveOwners.clear();
      detachedNodeIds.clear();
    },
    onAngleCommit,
    onAnglePreview,
  };
}
