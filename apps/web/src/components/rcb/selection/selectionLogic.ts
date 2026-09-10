/**
 * Selection chrome / snap helpers still used by product UI.
 * Pointer / marquee / resize gestures live in Kit — not duplicated here.
 */
import { isFrameLocalCoordSpace } from '@/components/rcb/scene/layout/nodeLayout';
import { frameForFullBleedPlate as frameForFullBleedPlateGeom } from '@/components/rcb/frames/frameSceneQuery';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  snapBoxToGrid,
  smartGuideTargetPad,
  snapTranslateToPeers,
  type SceneBox,
  type SmartGuideLine,
  type SmartGuideTarget,
} from './alignGuides';
import { unionOfBoxes } from './resizeGeometry';
import { strokeEndpointsFromBox } from '@/components/rcb/scene/document/sceneShapes';
import {
  isImageGeneratorNode,
  isAnimationFrameHostNode,
  isArtboardVisibleInDocument,
  isLottieGeneratorNode,
  isVideoGeneratorNode,
  isNodeMarqueeSkippable,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { isAnimationWorkbenchPreviewChild } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { listImageVariantUrls } from '@/components/rcb/scene/document/mediaLifecycle';
import {
  deflateSelectionBox,
  inflateBoxByVisualOutset,
  inflateSelectionBox,
} from '@/components/rcb/scene/document/sceneEffects';
import { liveShapeGeomBox, hostAngleDeg } from './hostGeom';
import { frameSelId, parseFrameSelId } from '@/components/rcb/frames/frameSceneQuery';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';

/** Frame chrome box: live plate (gesture) → host if it matches document → document. */
export function resolveFrameChromeBox(
  frameId: string,
  frame: { x?: number; y?: number; width?: number; height?: number }
): SceneBox {
  const docBox: SceneBox = {
    left: Number(frame.x) || 0,
    top: Number(frame.y) || 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1),
  };
  // Gesture preview owns the plate while dragging (store lags behind).
  const livePlate = getLiveArtboardFrameGeometry(String(frameId));
  if (livePlate) {
    return {
      left: Number(livePlate.x) || 0,
      top: Number(livePlate.y) || 0,
      width: Math.max(1, Number(livePlate.width) || 1),
      height: Math.max(1, Number(livePlate.height) || 1),
    };
  }
  const liveHost = liveShapeGeomBox(String(frameId));
  if (liveHost) {
    // Sticky lattice is sub-pixel. After multi-frame mode:move, hosts can lag
    // the committed store — prefer document when the host drifted.
    // Title-label plate moves keep liveArtboardGeom set through the store write
    // (see onFrameMoveEnd) so this branch is not the commit-lag glue.
    const drift = Math.hypot(liveHost.left - docBox.left, liveHost.top - docBox.top);
    if (drift <= 1.5) return liveHost;
  }
  return docBox;
}

export type MediaTitleIcon =
  | 'image'
  | 'image-generator'
  | 'video'
  | 'video-generator'
  | 'lottie'
  | 'lottie-generator'
  | 'audio';

export function mediaTitleChrome(opts: {
  key: string | undefined;
  name?: unknown;
  isImageGen: boolean;
  isVideoGen: boolean;
  isLottieGen: boolean;
  isAudioGen: boolean;
  isVideo: boolean;
}): { name: string; icon: MediaTitleIcon; renameAriaLabel: string } {
  const key = String(opts.key || '');
  if (opts.isVideoGen) {
    return {
      name: String(opts.name || 'Video'),
      icon: 'video-generator',
      renameAriaLabel: 'Video name',
    };
  }
  if (opts.isAudioGen || key === 'audio') {
    return {
      name: String(opts.name || (opts.isAudioGen ? 'Audio Generator' : 'Audio')),
      icon: 'audio',
      renameAriaLabel: 'Audio name',
    };
  }
  if (opts.isLottieGen) {
    return {
      name: String(opts.name || 'Lottie Generator'),
      icon: 'lottie-generator',
      renameAriaLabel: 'Lottie name',
    };
  }
  if (key === 'lottie') {
    return {
      name: String(opts.name || 'Lottie'),
      icon: 'lottie',
      renameAriaLabel: 'Lottie name',
    };
  }
  if (opts.isVideo || key === 'video') {
    return {
      name: String(opts.name || 'Video'),
      icon: 'video',
      renameAriaLabel: 'Video name',
    };
  }
  if (opts.isImageGen) {
    return {
      name: String(opts.name || 'Image'),
      icon: 'image-generator',
      renameAriaLabel: 'Image name',
    };
  }
  return {
    name: String(opts.name || 'Image'),
    icon: 'image',
    renameAriaLabel: 'Image name',
  };
}

/** Synthetic selection id so frames share the same union chrome / transform path as nodes. */
export function resolveInspectPrimaryId(
  selectedNodeIds: string[],
  selectedFrameIds: string[]
): string | null {
  if (selectedNodeIds.length === 1 && selectedFrameIds.length === 0) {
    return selectedNodeIds[0] ?? null;
  }
  if (selectedFrameIds.length === 1 && selectedNodeIds.length === 0) {
    return frameSelId(selectedFrameIds[0]);
  }
  return null;
}

/** Near-full-bleed artboard plate — must not block marquee / nested picks. */
export function frameForFullBleedPlate(doc: SceneDocument, nodeId: string): string | null {
  const node = doc?.deltaSetLike?.[nodeId];
  if (!node) return null;
  // Invisible 动画工作台 host / preview children are plate chrome, not selectable content.
  if (isAnimationFrameHostNode(node, doc) || isAnimationWorkbenchPreviewChild(doc, node)) {
    const fid = String(node.attrs?.frameId || '').trim();
    return fid || null;
  }
  return frameForFullBleedPlateGeom(doc, nodeId);
}

/**
 * Line/arrow nodes use a tall hit AABB (`STROKE_HIT` ≈ 24). Docking the
 * floating toolbar to that slab's top puts it half a hit-height above the shaft
 * — huge on screen at high zoom. Prefer the shaft's axis-aligned outer bounds
 * (endpoint AABB) so the pill clears both knobs instead of sitting on mid-shaft
 * and covering the higher endpoint on diagonal strokes.
 */
export function toolbarBoxForSelection(
  box: SceneBox | null | undefined,
  opts: { lineChrome: boolean; node?: any }
): SceneBox | null {
  if (!box) return null;
  if (!opts.lineChrome) return box;
  const angle = Number(opts.node?.attrs?.angle) || 0;
  const ep = strokeEndpointsFromBox(box, angle);
  const minX = Math.min(ep.x0, ep.x1);
  const maxX = Math.max(ep.x0, ep.x1);
  const minY = Math.min(ep.y0, ep.y1);
  const maxY = Math.max(ep.y0, ep.y1);
  return {
    left: minX,
    top: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/**
 * Unified dock inputs for all floating selection toolbars (single / multi / frame).
 * Always prefer {@link resolveChromeUnion} for `chromeUnion` — `liveUnion` lags one
 * effect tick after marquee / selection changes.
 */
export function selectionToolbarDock(
  chromeUnion: SceneBox | null | undefined,
  opts?: {
    angle?: number;
    edgePadScene?: number;
    lineChrome?: boolean;
    node?: any;
  }
): { box: SceneBox | null; angle: number; edgePadScene: number } {
  const angle = Number(opts?.angle) || 0;
  const edgePadScene = Math.max(0, Number(opts?.edgePadScene) || 0);
  if (!chromeUnion) return { box: null, angle, edgePadScene };
  if (!opts?.lineChrome) return { box: chromeUnion, angle, edgePadScene };
  return {
    box: toolbarBoxForSelection(chromeUnion, { lineChrome: true, node: opts.node }),
    angle,
    edgePadScene,
  };
}

export type MoveSnapContext = {
  union: SceneBox;
  /** Chrome boxes at drag start — deflated to path for smart snap. */
  origins: Array<{ nodeId: string; box: SceneBox }>;
  document: SceneDocument;
  dx: number;
  dy: number;
  disableSnap: boolean;
  gridSize: number;
  targets: SmartGuideTarget[];
  threshold: number;
  /** Shift+drag axis lock — peer/grid snap must not reintroduce cross-axis motion. */
  axisLock?: 'h' | 'v';
};

/**
 * Align-guide box = current **path geom** for this node.
 * Prefer live host box when mounted; else deflate chrome → path.
 * Never bake a stroke/visual offset — path moves with the element each frame.
 */
function visualGuideBoxForNode(
  id: string,
  document: SceneDocument,
  chrome: SceneBox | null | undefined
): SceneBox | null {
  if (!chrome) return null;
  if (parseFrameSelId(id)) return { ...chrome };
  const live = liveShapeGeomBox(id);
  if (live) return { ...live };
  return deflateSelectionBox({ ...chrome }, document?.deltaSetLike?.[id]);
}

/**
 * Guide / spacing / peer-snap target box: path geom clipped to the owning
 * artboard when `clipContent` is on. Fully clipped-away nodes return null so
 * overflow outside the plate cannot spawn align or distance guides.
 */
function clippedGuideBoxForNode(
  id: string,
  document: SceneDocument,
  chrome: SceneBox | null | undefined
): SceneBox | null {
  const path = visualGuideBoxForNode(id, document, chrome);
  if (!path) return null;
  if (parseFrameSelId(id)) return path;
  const node = document?.deltaSetLike?.[id];
  if (!node) return path;
  const ownerId = String(node.attrs?.frameId || '').trim();
  if (!ownerId) return path;
  const frame = (document.frames || []).find((f) => String(f?.id) === ownerId);
  if (!frame || frame.clipContent === false || frame.hidden) return path;
  const fb: SceneBox = {
    left: Number(frame.x) || 0,
    top: Number(frame.y) || 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1),
  };
  const leftEdge = Math.max(path.left, fb.left);
  const topEdge = Math.max(path.top, fb.top);
  const rightEdge = Math.min(path.left + path.width, fb.left + fb.width);
  const bottomEdge = Math.min(path.top + path.height, fb.top + fb.height);
  if (rightEdge <= leftEdge || bottomEdge <= topEdge) return null;
  return {
    left: leftEdge,
    top: topEdge,
    width: rightEdge - leftEdge,
    height: bottomEdge - topEdge,
  };
}

/** Painted outer ink from a chrome origin — used for grid settle only. */
function visualBoxFromChromeOrigin(
  document: SceneDocument,
  o: { nodeId: string; box: SceneBox }
): SceneBox {
  if (parseFrameSelId(o.nodeId)) return { ...o.box };
  const path = deflateSelectionBox({ ...o.box }, document?.deltaSetLike?.[o.nodeId]);
  return inflateBoxByVisualOutset(path, document?.deltaSetLike?.[o.nodeId]);
}

/**
 * Path box for a drag origin. Uses the origin chrome (drag-start + apply sdx later),
 * not live host — live already includes preview and would double-count.
 */
function pathBoxFromChromeOrigin(
  document: SceneDocument,
  o: { nodeId: string; box: SceneBox }
): SceneBox {
  if (parseFrameSelId(o.nodeId)) return { ...o.box };
  return deflateSelectionBox({ ...o.box }, document?.deltaSetLike?.[o.nodeId]);
}

/** Pick dominant drag axis for Shift-constrained move (ties → horizontal). */
function resolveMoveAxisLock(
  dx: number,
  dy: number,
  prev?: 'h' | 'v' | null
): 'h' | 'v' | null {
  if (prev) return prev;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 1e-9 && ady < 1e-9) return null;
  return adx >= ady ? 'h' : 'v';
}

function constrainMoveDelta(
  dx: number,
  dy: number,
  axis: 'h' | 'v'
): { dx: number; dy: number } {
  return axis === 'h' ? { dx, dy: 0 } : { dx: 0, dy };
}

/** Shift+drag move: constrain to one axis; release Shift to move freely again. */
export function shiftConstrainedMoveDelta(
  drag: { moveAxisLock?: 'h' | 'v' },
  dx: number,
  dy: number,
  shiftKey: boolean
): { dx: number; dy: number } {
  if (!shiftKey) {
    drag.moveAxisLock = undefined;
    return { dx, dy };
  }
  const lock = resolveMoveAxisLock(dx, dy, drag.moveAxisLock);
  if (lock) drag.moveAxisLock = lock;
  if (!drag.moveAxisLock) return { dx, dy };
  return constrainMoveDelta(dx, dy, drag.moveAxisLock);
}

export function computeMovedUnion(ctx: MoveSnapContext): {
  nextUnion: SceneBox;
  sdx: number;
  sdy: number;
  guides: SmartGuideLine[];
} {
  // 1) pointer → visual  2) 1px grid  3) 自动吸附 on path  4) guides
  const visualBoxes = ctx.origins.map((o) => visualBoxFromChromeOrigin(ctx.document, o));
  const visualUnion = unionOfBoxes(visualBoxes);
  if (!visualUnion) {
    return {
      nextUnion: {
        ...ctx.union,
        left: ctx.union.left + ctx.dx,
        top: ctx.union.top + ctx.dy,
      },
      sdx: ctx.dx,
      sdy: ctx.dy,
      guides: [],
    };
  }
  let nextVisual = {
    ...visualUnion,
    left: visualUnion.left + ctx.dx,
    top: visualUnion.top + ctx.dy,
  };
  if (!ctx.disableSnap && ctx.gridSize > 0) {
    nextVisual = snapBoxToGrid(nextVisual, ctx.gridSize);
  }
  let sdx = nextVisual.left - visualUnion.left;
  let sdy = nextVisual.top - visualUnion.top;
  let guides: SmartGuideLine[] = [];
  if (!ctx.disableSnap && ctx.targets.length) {
    const pathBoxes = ctx.origins.map((o) => pathBoxFromChromeOrigin(ctx.document, o));
    const pathUnion = unionOfBoxes(pathBoxes);
    if (pathUnion) {
      const movedPath = {
        ...pathUnion,
        left: pathUnion.left + sdx,
        top: pathUnion.top + sdy,
      };
      const snapped = snapTranslateToPeers(movedPath, ctx.targets, ctx.threshold);
      sdx += snapped.nudgeX;
      sdy += snapped.nudgeY;
      guides = snapped.guides;
    }
  }
  if (ctx.axisLock) {
    const locked = constrainMoveDelta(sdx, sdy, ctx.axisLock);
    sdx = locked.dx;
    sdy = locked.dy;
  }
  return {
    nextUnion: {
      ...ctx.union,
      left: ctx.union.left + sdx,
      top: ctx.union.top + sdy,
    },
    sdx,
    sdy,
    guides,
  };
}

/** Sibling **visual-outer** AABBs for align guides (exclude selection + hidden/locked). */
function collectSmartGuideTargets(
  document: SceneDocument,
  listNodeIds: () => readonly string[],
  getNodeBox: (id: string) => SceneBox | null,
  excludeIds: Set<string>,
  opts?: {
    nearBox?: SceneBox | null;
    pad?: number;
    queryNodeIdsInRect?: (box: SceneBox) => string[];
  }
): SmartGuideTarget[] {
  let ids = listNodeIds();
  const near = opts?.nearBox;
  const query = opts?.queryNodeIdsInRect;
  const pad = Math.max(0, opts?.pad ?? 0);
  if (near && query && near.width > 0 && near.height > 0) {
    const nearby = query({
      left: near.left - pad,
      top: near.top - pad,
      width: near.width + pad * 2,
      height: near.height + pad * 2,
    });
    if (nearby.length) {
      ids = nearby;
    } else if (ids.length >= 48) {
      ids = [];
    }
  }
  const out: SmartGuideTarget[] = [];
  for (const id of ids) {
    if (excludeIds.has(id)) continue;
    const node = document?.deltaSetLike?.[id];
    if (!node || isNodeMarqueeSkippable(document, node)) continue;
    const box = clippedGuideBoxForNode(id, document, getNodeBox(id));
    if (box && box.width > 0 && box.height > 0) out.push({ ...box, guideKind: 'peer' });
  }
  const frames = Array.isArray(document?.frames) ? document.frames : [];
  for (const f of frames) {
    // Timeline edit focus: other plates are paint-hidden — do not snap/space to them.
    if (!f?.id || f.locked || !isArtboardVisibleInDocument(f)) continue;
    const fid = String(f.id);
    if (excludeIds.has(fid) || excludeIds.has(frameSelId(fid))) continue;
    const left = Number(f.x) || 0;
    const top = Number(f.y) || 0;
    const width = Math.max(1, Number(f.width) || 1);
    const height = Math.max(1, Number(f.height) || 1);
    if (near && near.width > 0 && near.height > 0) {
      const nl = near.left - pad;
      const nt = near.top - pad;
      const nr = near.left + near.width + pad;
      const nb = near.top + near.height + pad;
      if (left + width < nl || left > nr || top + height < nt || top > nb) continue;
    }
    out.push({ left, top, width, height, guideKind: 'frame' });
  }
  return out;
}

/**
 * Frame-local plate drag: children keep local x/y; only `frames[].x/y` moves.
 * Smart-guide scans over hundreds of in-plate siblings freeze the tab — same
 * pipeline as any other artboard plate move, just skip O(n) snap here.
 */
export function shouldSkipSmartGuidesForFramePlateDrag(document: SceneDocument): boolean {
  return isFrameLocalCoordSpace(document);
}

export function smartGuideTargetsForDrag(opts: {
  document: SceneDocument;
  listNodeIds: () => readonly string[];
  getNodeBox: (id: string) => SceneBox | null;
  excludeIds: Set<string>;
  nearBox: SceneBox;
  threshold: number;
  queryNodeIdsInRect?: (box: SceneBox) => string[];
}): SmartGuideTarget[] {
  return collectSmartGuideTargets(
    opts.document,
    opts.listNodeIds,
    opts.getNodeBox,
    opts.excludeIds,
    {
      nearBox: opts.nearBox,
      pad: smartGuideTargetPad(opts.threshold),
      queryNodeIdsInRect: opts.queryNodeIdsInRect,
    }
  );
}

export function readNodeAngle(document: SceneDocument, nodeId: string) {
  // Prefer live host angle (playhead scrub / in-progress transform) over attrs.
  const live = hostAngleDeg(nodeId, Number.NaN);
  if (Number.isFinite(live)) return live;
  const node = document?.deltaSetLike?.[nodeId];
  const n = Number(node?.attrs?.angle);
  return Number.isFinite(n) ? n : 0;
}

/** Share / Dev inspect spacing pair: live hover first, then sticky prior selection. */
export function resolveMeasurePairNodeId(opts: {
  inspectDev: boolean;
  transforming: boolean;
  hoverNodeId: string | null;
  inspectPairNodeId: string | null;
  inspectPrimaryId: string | null;
  selectedNodeIds: string[];
}): string | null {
  // Design edit: no preview-style select↔hover measure / orange pair chrome.
  if (!opts.inspectDev || opts.transforming || !opts.inspectPrimaryId) return null;
  if (
    opts.hoverNodeId &&
    opts.hoverNodeId !== opts.inspectPrimaryId &&
    !opts.selectedNodeIds.includes(opts.hoverNodeId)
  ) {
    return opts.hoverNodeId;
  }
  if (
    opts.inspectPairNodeId &&
    opts.inspectPairNodeId !== opts.inspectPrimaryId &&
    !opts.selectedNodeIds.includes(opts.inspectPairNodeId)
  ) {
    return opts.inspectPairNodeId;
  }
  return null;
}

/** Resolve node or `__frame__:` synthetic id to a scene AABB (selection chrome). */
export function resolveMeasureBox(
  selId: string | null | undefined,
  document: SceneDocument,
  getNodeBox: (id: string) => SceneBox | null
): SceneBox | null {
  if (!selId) return null;
  const frameId = parseFrameSelId(selId);
  if (frameId) {
    const frames = Array.isArray(document?.frames) ? document.frames : [];
    const frame = frames.find((f: any) => f && String(f.id) === String(frameId));
    if (!frame) return null;
    const left = Number(frame.x) || 0;
    const top = Number(frame.y) || 0;
    const width = Math.max(1, Number(frame.width) || 1);
    const height = Math.max(1, Number(frame.height) || 1);
    return { left, top, width, height };
  }
  return getNodeBox(selId);
}

/**
 * Idle select↔hover spacing boxes: same as {@link resolveMeasureBox}, but
 * frame-clipped so overflow outside the artboard cannot spawn gap/align guides.
 */
export function resolveClippedMeasureBox(
  selId: string | null | undefined,
  document: SceneDocument,
  getNodeBox: (id: string) => SceneBox | null
): SceneBox | null {
  if (!selId) return null;
  if (parseFrameSelId(selId)) return resolveMeasureBox(selId, document, getNodeBox);
  return clippedGuideBoxForNode(selId, document, getNodeBox(selId));
}

/**
 * Idle selection bounds update in the same paint as store; liveUnion lags one
 * effect tick and used to flash empty chrome when switching frames in preview.
 */
export function resolveChromeUnion(opts: {
  transforming: boolean;
  liveUnion: SceneBox | null;
  selectionUnion: SceneBox | null;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  document: SceneDocument;
  /** Multi session group angle — keep oriented liveUnion, do not swap in AABB. */
  multiGroupAngle?: number;
}): SceneBox | null {
  // Oriented multi control box (or any in-flight transform) uses liveUnion as-is.
  if (opts.transforming) return opts.liveUnion;
  if (
    opts.selectedNodeIds.length > 1 &&
    Math.abs(Number(opts.multiGroupAngle) || 0) > 0.01
  ) {
    return opts.liveUnion || opts.selectionUnion;
  }
  const base = opts.selectionUnion;
  if (!base) return opts.liveUnion;
  // Prefer live host → path chrome (single + multi) so the box tracks remounts.
  // No scene-unit drift gate: at 6000% zoom, 0.1 scene = 6px and sticky re-align
  // routinely exceeds the old 2-unit threshold, which forced editor store while paint
  // stayed on the host — chrome looked right but picks missed.
  if (opts.selectedFrameIds.length === 0 && opts.selectedNodeIds.length >= 1) {
    const lives: SceneBox[] = [];
    for (const id of opts.selectedNodeIds) {
      const live = liveShapeGeomBox(id);
      if (!live) break;
      lives.push(inflateSelectionBox(live, opts.document?.deltaSetLike?.[id]));
    }
    if (lives.length === opts.selectedNodeIds.length) {
      const liveUnion =
        opts.selectedNodeIds.length === 1 ? lives[0] : unionOfBoxes(lives);
      if (liveUnion) return liveUnion;
    }
  }
  // Frames: gesture live plate / committed document via resolveFrameChromeBox —
  // do not prefer bare host lattice (stale after multi-frame mode:move).
  if (opts.selectedNodeIds.length === 0 && opts.selectedFrameIds.length >= 1) {
    const frames = Array.isArray(opts.document?.frames) ? opts.document.frames : [];
    const lives: SceneBox[] = [];
    for (const id of opts.selectedFrameIds) {
      const frame = frames.find((f: any) => f && String(f.id) === String(id));
      if (!frame) break;
      lives.push(resolveFrameChromeBox(String(id), frame));
    }
    if (lives.length === opts.selectedFrameIds.length) {
      const liveUnion =
        opts.selectedFrameIds.length === 1 ? lives[0] : unionOfBoxes(lives);
      if (liveUnion) return liveUnion;
    }
  }
  return base;
}

/** Expanded stack on an unselected node — survives hover loss while alt tiles are open. */
function resolvePinnedImageVariantsId(opts: {
  nodeId: string | null | undefined;
  inspectDev: boolean;
  transforming: boolean;
  selectedNodeIds: string[];
  document: SceneDocument;
}): string | null {
  const nodeId = String(opts.nodeId || '').trim();
  if (!nodeId || opts.inspectDev || opts.transforming) return null;
  if (opts.selectedNodeIds.includes(nodeId) || parseFrameSelId(nodeId)) return null;
  const node = opts.document?.deltaSetLike?.[nodeId];
  if (node?.key !== 'image') return null;
  if (isImageGeneratorNode(node) || isVideoGeneratorNode(node) || isLottieGeneratorNode(node)) {
    return null;
  }
  if (String(node?.attrs?.processStatus || '') === 'running') return null;
  if (listImageVariantUrls(node).length <= 1) return null;
  return nodeId;
}

/** Hovered (unselected) image with a multi-gen stack → show variants chrome. */
export function resolveHoverImageVariantsId(opts: {
  inspectDev: boolean;
  transforming: boolean;
  suppressToolbars: boolean;
  hoverNodeId: string | null;
  selectedNodeIds: string[];
  document: SceneDocument;
  /** Keep overlay mounted while stack is expanded (mouse may be on alt tiles). */
  pinnedExpandedNodeId?: string | null;
}): string | null {
  const pinned = opts.pinnedExpandedNodeId
    ? resolvePinnedImageVariantsId({
        nodeId: opts.pinnedExpandedNodeId,
        selectedNodeIds: opts.selectedNodeIds,
        document: opts.document,
        inspectDev: opts.inspectDev,
        transforming: opts.transforming,
      })
    : null;
  if (pinned) return pinned;

  if (opts.inspectDev || opts.transforming || opts.suppressToolbars) return null;
  if (
    !opts.hoverNodeId ||
    opts.selectedNodeIds.includes(opts.hoverNodeId) ||
    parseFrameSelId(opts.hoverNodeId)
  ) {
    return null;
  }
  const node = opts.document?.deltaSetLike?.[opts.hoverNodeId];
  if (node?.key !== 'image') return null;
  if (isImageGeneratorNode(node) || isVideoGeneratorNode(node) || isLottieGeneratorNode(node)) {
    return null;
  }
  if (String(node?.attrs?.processStatus || '') === 'running') return null;
  if (listImageVariantUrls(node).length <= 1) return null;
  return opts.hoverNodeId;
}
