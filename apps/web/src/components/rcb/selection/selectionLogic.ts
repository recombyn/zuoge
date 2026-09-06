import { nodeLeftTop, isFrameLocalCoordSpace } from '@/components/rcb/scene/paint/sceneToSvg';
import { frameIdAtPoint, frameForFullBleedPlate as frameForFullBleedPlateGeom } from '@/components/rcb/scene/document/sceneHitBridge';
import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  getDocumentGridSize,
  snapBoxToGrid,
  snapResizeToGrid,
  snapResizeToPeers,
  smartSnapThreshold,
  smartGuideTargetPad,
  collectMoveSnapIndicators,
  snapTranslateToPeers,
  collectPairSpacingGuides,
  GUIDE_COINCIDE_EPS,
  SMART_GUIDE_COLOR,
  type SceneBox,
  type SmartGuideLine,
  type SmartGuideTarget,
} from './alignGuides';
import {
  RESIZE_MIN_SIZE,
  resizeFromHandle,
  resizeOppositeWorld,
  reanchorResizeOpposite,
  rotateBoxesAround,
  scaleBoxesToOrientedUnion,
  unionOfBoxes,
  resolveControlChrome,
  getSelectionSharedRotation,
  pointInOrientedBox,
  type ResizeHandle,
} from './resizeGeometry';
import {
  pathStrokeHitsSceneBox,
  rememberNodePath2D,
  resizeStrokeByEndpoint,
  strokeEndpointsFromBox,
  strokeNodeFromEndpoints,
} from '@/components/rcb/scene/document/sceneShapes';
import { expandSelectionWithGroups } from '@/components/rcb/scene/document/sceneGroups';
import {
  isAudioGeneratorNode,
  isImageGeneratorNode,
  isAnimationFrameHostNode,
  isArtboardVisibleInDocument,
  isLottieGeneratorNode,
  isVideoGeneratorNode,
  isNodeHiddenInDocument,
  isNodeMarqueeSkippable,
  isNodeLocked,
  supportsCornerRadius,
  supportsFill,
  supportsShapeSides,
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  getAnimationWorkbenchTimelineFocus,
  isAnimationWorkbenchFrameInPreview,
  isAnimationWorkbenchPreviewChild,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { listImageVariantUrls } from '@/components/rcb/scene/document/mediaLifecycle';
import { nodeIdsInsideFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { buildNodeStackZMap } from '@/components/rcb/scene/document/sceneDocument';
import {
  TEXT_SELECTION_PAD,
  deflateSelectionBox,
  inflateBoxByVisualOutset,
  inflateSelectionBox,
  strokeChromeOutset,
  strokeOuterClearanceScene,
  strokeVisualOutset,
} from '@/components/rcb/scene/document/sceneEffects';
import { isEditablePathNode } from '@/components/rcb/scene/paint/outlineToPath';
import {
  measureWrappedTextSize,
  parseNodeText,
  parseNodeTextStyle,
} from '@/components/rcb/scene/document/sceneText';
import type { TextResizeMode } from '@/components/rcb/scene/paint/svgToScene';
import { getSharedNodeEls } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  liveShapeGeomBox,
  hostAngleDeg,
  nodeUsesPathChrome,
  shapeNeedsSelectedPathSilhouette,
  nodeUsesOpenStrokeEndpoints,
  pathLocalEndpoints,
  localPointToWorld,
  boxFromLocalAnchor,
  resolveOutlinePathD,
  type ShapeOutlineItem,
} from './HostPathChrome';
import {
  rcbCameraCssZoom,
  rcbClientDeltaToScene,
  rcbClientToStageLocal,
  rcbResolveViewportEl,
  rcbViewportMetrics,
} from '@/components/rcb/core/math';
import { frameSelId, parseFrameSelId } from './frameSelectionIds';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';

export const CORNER_HANDLES = new Set<ResizeHandle>(['nw', 'ne', 'sw', 'se']);

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

export function textResizeModeForHandle(
  handle: ResizeHandle,
  opts?: { textFrame?: boolean }
): TextResizeMode {
  // Fixed text plates: resize box only — font size stays constant.
  if (opts?.textFrame) return 'frame';
  return handle === 'e' || handle === 'w' ? 'wrap' : 'scale';
}

/**
 * Aspect lock while resizing.
 * - Toolbar lock and Shift are OR'd: Shift reinforces proportional scale,
 *   and never unlocks when the chain icon is already on (avoids fight with lock).
 * - Single text corners: proportional by default; Shift allows free resize.
 * - Image/video default locked; other nodes free unless `lockAspect` is set.
 */
export function nodeAspectLockDefault(key: string | undefined): boolean {
  return key === 'image' || key === 'video' || key === 'lottie' || key === 'audio';
}

export type MediaTitleIcon =
  | 'image'
  | 'image-generator'
  | 'video'
  | 'video-generator'
  | 'lottie'
  | 'lottie-generator'
  | 'audio'
  | 'text';

export function textFrameTitleChrome(opts: {
  name?: unknown;
  plainText?: string;
}): { name: string; icon: 'text'; renameAriaLabel: string } {
  const existing = String(opts.name || '').trim();
  if (existing) {
    return { name: existing, icon: 'text', renameAriaLabel: 'Text name' };
  }
  const snippet = String(opts.plainText || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return {
    name: snippet || 'Text',
    icon: 'text',
    renameAriaLabel: 'Text name',
  };
}

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

export function readNodeAspectLocked(node: SceneNodeInput): boolean {
  const raw = node?.attrs?.lockAspect;
  if (raw === true || raw === 'true' || raw === 1 || raw === '1') return true;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return nodeAspectLockDefault(node?.key);
}

/** Persist lock OR Shift — Shift adds constraint, does not toggle it off. */
export function combineAspectLock(locked: boolean, shiftKey: boolean) {
  return locked || shiftKey;
}

export function resolveLockAspect(
  document: SceneDocument,
  origins: Array<{ nodeId: string }>,
  handle: ResizeHandle | undefined,
  shiftKey: boolean
) {
  if (!handle) return shiftKey;
  if (origins.length === 1) {
    const frameId = parseFrameSelId(origins[0].nodeId);
    if (frameId && isAnimationWorkbenchFrameInPreview(document, frameId)) {
      return true;
    }
    const node = document?.deltaSetLike?.[origins[0].nodeId];
    const key = node?.key;
    const textFrame =
      node?.attrs?.textFrame === true ||
      node?.attrs?.textFrame === 'true' ||
      node?.attrs?.textFrame === 1 ||
      node?.attrs?.textFrame === '1';
    // Fixed text plates: always 1:1 aspect while resizing.
    if (key === 'text' && textFrame) return combineAspectLock(true, shiftKey);
    // Text side handles have independent semantics: L/R change wrap width,
    // N/S change height only. A persisted aspect lock must not turn a vertical
    // text-edge drag into a diagonal resize; only corners scale proportionally.
    if (key === 'text' && (handle === 'n' || handle === 's')) return false;
    // Text corners: default scale; Shift temporarily unlocks for free reshape.
    if (key === 'text' && CORNER_HANDLES.has(handle)) return !shiftKey;
    return combineAspectLock(readNodeAspectLocked(node), shiftKey);
  }
  // Multi / group: lock when selection includes images/videos (unless explicitly unlocked).
  const nodes = origins
    .map(({ nodeId }) => document?.deltaSetLike?.[nodeId])
    .filter(Boolean);
  const hasExplicitUnlock = nodes.some((n) => {
    const raw = n?.attrs?.lockAspect;
    return raw === false || raw === 'false' || raw === 0 || raw === '0';
  });
  const allLocked =
    !hasExplicitUnlock &&
    nodes.some(
      (n) => n.key === 'image' || n.key === 'video' || n.key === 'lottie' || n.key === 'audio'
    )
      ? true
      : nodes.length > 0 && nodes.every((n) => readNodeAspectLocked(n));
  return combineAspectLock(allLocked, shiftKey);
}

/** Remasure text height for L/R wrap so chrome hugs wrapped lines while dragging. */
export function applyTextWrapHeight(
  document: SceneDocument,
  nodeId: string,
  box: SceneBox
): SceneBox {
  const node = document?.deltaSetLike?.[nodeId];
  if (!node || node.key !== 'text') return box;
  const style = parseNodeTextStyle(node.attrs || {});
  const plain = parseNodeText(node.attrs || {}) || ' ';
  // `box` is chrome bounds (includes TEXT_SELECTION_PAD); measure wrap on content width.
  const contentW = Math.max(24, box.width - TEXT_SELECTION_PAD * 2);
  const measured = measureWrappedTextSize(plain, style, contentW);
  return {
    ...box,
    height: Math.max(1, Math.round(measured.height) + TEXT_SELECTION_PAD * 2),
  };
}

export function normalizeBox(x0: number, y0: number, x1: number, y1: number) {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  return {
    left,
    top,
    width: Math.max(1, Math.abs(x1 - x0)),
    height: Math.max(1, Math.abs(y1 - y0)),
  };
}

export function boxesIntersect(a: SceneBox, b: SceneBox) {
  return !(
    a.left + a.width < b.left ||
    b.left + b.width < a.left ||
    a.top + a.height < b.top ||
    b.top + b.height < a.top
  );
}

/** Overlap of two AABBs, or null when they do not intersect. */
export function intersectSceneBoxes(a: SceneBox, b: SceneBox): SceneBox | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function unionSceneBoxes(a: SceneBox, b: SceneBox): SceneBox {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

export function expandSceneBox(box: SceneBox, pad: number): SceneBox {
  if (!(pad > 0)) return box;
  return {
    left: box.left - pad,
    top: box.top - pad,
    width: Math.max(1, box.width + pad * 2),
    height: Math.max(1, box.height + pad * 2),
  };
}

/**
 * Screen-constant marquee slack (px) → scene units.
 * Small brush / tiny nodes otherwise miss when the rect only grazes ink.
 */
export const MARQUEE_HIT_PAD_SCREEN_PX = 3;
/** Floor hit AABB so sub-pixel / hairline nodes stay brushable. */
export const MARQUEE_MIN_HIT_SCREEN_PX = 6;

export function marqueeHitPadScene(zoom: number): number {
  return MARQUEE_HIT_PAD_SCREEN_PX / Math.max(0.05, zoom || 1);
}

export function ensureMinScreenHitBox(box: SceneBox, zoom: number): SceneBox {
  const z = Math.max(0.05, zoom || 1);
  const min = MARQUEE_MIN_HIT_SCREEN_PX / z;
  const w = Math.max(box.width, min);
  const h = Math.max(box.height, min);
  if (w === box.width && h === box.height) return box;
  return {
    left: box.left + box.width / 2 - w / 2,
    top: box.top + box.height / 2 - h / 2,
    width: w,
    height: h,
  };
}

/** True when the marquee completely contains the artboard plate. */
export function frameFullyEnclosedByMarquee(
  frame: { x?: unknown; y?: unknown; width?: unknown; height?: unknown },
  marquee: SceneBox
): boolean {
  const fb: SceneBox = {
    left: Number(frame.x) || 0,
    top: Number(frame.y) || 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1),
  };
  return (
    marquee.left <= fb.left &&
    marquee.top <= fb.top &&
    marquee.left + marquee.width >= fb.left + fb.width &&
    marquee.top + marquee.height >= fb.top + fb.height
  );
}

/**
 * Return frames that intersect the marquee (crossing select).
 * Same rule as scene nodes — requiring full enclosure made artboard / 动画
 * boards unselectable until the brush swallowed the whole plate.
 */
export function framesHittingMarquee(doc: SceneDocument, marquee: SceneBox): Array<{ id: string; area: number }> {
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  const out: Array<{ id: string; area: number }> = [];
  for (const f of frames) {
    if (!f?.id || f.locked) continue;
    const fb: SceneBox = {
      left: Number(f.x) || 0,
      top: Number(f.y) || 0,
      width: Math.max(1, Number(f.width) || 1),
      height: Math.max(1, Number(f.height) || 1),
    };
    if (!boxesIntersect(marquee, fb)) continue;
    out.push({ id: String(f.id), area: fb.width * fb.height });
  }
  out.sort((a, b) => b.area - a.area);
  return out;
}

/**
 * Frames to commit from a marquee: crossing when the brush only hits plates;
 * fully enclosed plates only when scene content is also hit (so grazing a
 * child does not also select its parent artboard).
 */
export function resolveMarqueeFrameHits(
  doc: SceneDocument,
  marquee: SceneBox,
  contentHitCount: number
): string[] {
  const intersecting = framesHittingMarquee(doc, marquee);
  if (contentHitCount <= 0) return intersecting.map((h) => h.id);
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  return intersecting
    .filter((h) => {
      const frame = frames.find((f) => String(f?.id) === h.id);
      return frame ? frameFullyEnclosedByMarquee(frame, marquee) : false;
    })
    .map((h) => h.id);
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

export function isHostInjectedSelection(
  singleNode: boolean,
  singleId: string | null,
  shapeOutlines: ShapeOutlineItem[],
  opts?: { inspectDev?: boolean; node?: any; selectedFrameIds?: string[]; selectedNodeIds?: string[] }
): boolean {
  // Multi path union AABB / single frame AABB is host-mirrored (or scene self-fit).
  if (shapeOutlines.some((o) => o.unionChrome)) return true;
  if (
    opts?.selectedFrameIds?.length === 1 &&
    (!opts.selectedNodeIds || opts.selectedNodeIds.length === 0) &&
    shapeOutlines.some((o) => parseFrameSelId(o.id))
  ) {
    return true;
  }
  if (!singleNode || !singleId) return false;
  // Host already paints the path silhouette (with or without handles / aux).
  if (shapeOutlines.some((o) => o.id === singleId)) return true;
  // Inspect: never fall back to world AABB SelectionChrome for path ink.
  if (opts?.inspectDev && nodeUsesPathChrome(opts.node)) return true;
  return false;
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

/** Visual AABB in scene space via mounted SVG (matches what the user sees). */
export function sceneBoxFromMountedNode(
  nodeId: string,
  toScene: (clientX: number, clientY: number) => { x: number; y: number }
): SceneBox | null {
  if (typeof document === 'undefined') return null;
  const shared = getSharedNodeEls()?.get(nodeId) as SVGGraphicsElement | undefined;
  let el: SVGGraphicsElement | null = shared || null;
  if (!el) {
    const safe =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(nodeId)
        : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    el = document.querySelector(
      `[data-scene-node-id="${safe}"]`
    ) as SVGGraphicsElement | null;
  }
  if (!el) return null;
  let r: DOMRect;
  try {
    r = el.getBoundingClientRect();
  } catch {
    return null;
  }
  if (!(r.width >= 0.5 || r.height >= 0.5)) return null;
  const a = toScene(r.left, r.top);
  const b = toScene(r.right, r.bottom);
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.max(1, Math.abs(b.x - a.x)),
    height: Math.max(1, Math.abs(b.y - a.y)),
  };
}

/** Point-in-AABB (inclusive). */
export function pointInBox(x: number, y: number, box: SceneBox, pad = 0) {
  return (
    x >= box.left - pad &&
    x <= box.left + box.width + pad &&
    y >= box.top - pad &&
    y <= box.top + box.height + pad
  );
}

/**
 * Marquee hit — match click semantics per type, using **visible** (frame-clipped)
 * geometry so overflow ink outside a clipping artboard cannot be brushed:
 * - rect / geo / text / image / filled path: clipped AABB
 * - open pen / pencil / path stroke: ink samples, but only inside the clipped box
 * - line / arrow: shaft endpoints / mid within the clipped box
 *
 * Uses union(data, DOM) + screen-constant pad so small nodes / tight brushes
 * don't miss when ink is slightly outside the stored geom box.
 */
export function nodeHitsMarquee(
  doc: SceneDocument,
  nodeId: string,
  marquee: SceneBox,
  getNodeBox: (id: string) => SceneBox | null,
  toScene: (clientX: number, clientY: number) => { x: number; y: number },
  zoom = 1
): boolean {
  const node = doc?.deltaSetLike?.[nodeId];
  // Locked layers: click/context still works so users can Unlock; marquee skips
  // them (same as locked frames) — all node kinds.
  if (!node || isNodeMarqueeSkippable(doc, node)) return false;
  const dataBox = getNodeBox(nodeId);
  const domBox = sceneBoxFromMountedNode(nodeId, toScene);
  const fullBox = dataBox && domBox ? unionSceneBoxes(dataBox, domBox) : domBox || dataBox;
  if (!fullBox) return false;
  let box = visibleNodeBoxForSelection(doc, node, fullBox);
  if (!box) return false;
  box = ensureMinScreenHitBox(box, zoom);
  const hitMarquee = expandSceneBox(marquee, marqueeHitPadScene(zoom));
  const strokePad = 3 + marqueeHitPadScene(zoom);

  const shapeType = String(node.attrs?.shapeType || '');
  if (shapeType === 'line' || shapeType === 'arrow') {
    const ep = strokeEndpointsFromBox(box, Number(node.attrs?.angle) || 0);
    if (
      pointInBox(ep.x0, ep.y0, hitMarquee, strokePad) ||
      pointInBox(ep.x1, ep.y1, hitMarquee, strokePad)
    ) {
      return true;
    }
    const mx = (ep.x0 + ep.x1) / 2;
    const my = (ep.y0 + ep.y1) / 2;
    return pointInBox(mx, my, hitMarquee, strokePad) || boxesIntersect(hitMarquee, box);
  }

  if (shapeType === 'pen' || shapeType === 'pencil' || shapeType === 'path') {
    const d = String(node.attrs?.path || '');
    // Filled closed path: clipped AABB only — same as rect (no overflow stroke fallthrough).
    if (supportsFill(node)) {
      return boxesIntersect(hitMarquee, box);
    }
    // Open stroke: sample against full geom, but only count ink still visible in-frame.
    if (d) {
      const visibleHit = intersectSceneBoxes(hitMarquee, expandSceneBox(box, strokePad));
      if (!visibleHit) return false;
      return pathStrokeHitsSceneBox(
        d,
        fullBox,
        Number(node.attrs?.angle) || 0,
        visibleHit,
        strokePad
      );
    }
    return boxesIntersect(hitMarquee, box);
  }

  // rect / ellipse / text / image / other geo — clipped AABB like click.
  return boxesIntersect(hitMarquee, box);
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

export function patchesAsOrigins(
  patches: Array<{ nodeId: string; left: number; top: number; width: number; height: number }>
) {
  return patches.map((pt) => ({
    nodeId: pt.nodeId,
    box: { left: pt.left, top: pt.top, width: pt.width, height: pt.height },
  }));
}

export function multiMembersKey(origins: Array<{ nodeId: string; box: SceneBox }>): string {
  return origins
    .map((o) => {
      const b = o.box;
      return `${o.nodeId}:${b.left.toFixed(1)}:${b.top.toFixed(1)}:${b.width.toFixed(1)}:${b.height.toFixed(1)}`;
    })
    .join('|');
}

export type GeometryPatch = {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  /** With box in one preview — required for line/arrow endpoint drag (fixed opposite tip). */
  angle?: number;
};

/**
 * Soft-click vs drag — **monitor travel**, not scene/world units.
 *
 * Move follows the pointer immediately (no travel gate). Soft-click is only
 * `screenDistSq === 0` on pointerup (pure click → select / text-edit, no nudge).
 * Resize/rotate may still ignore sub-pixel jitter via {@link DRAG_DISTANCE_SQUARED}.
 *
 * 门槛用屏幕 px，不随画布缩放变（禁止用场景距离，否则 1% 时一点击就进拖拽）。
 */
export const DRAG_SCREEN_PX = 1;
export const DRAG_DISTANCE_SQUARED = DRAG_SCREEN_PX * DRAG_SCREEN_PX;

/** True only when the pointer never left the down pixel (move soft-click). */
export function isMotionlessClick(screenDistSq: number): boolean {
  return !(screenDistSq > 0);
}
/**
 * Empty canvas → blue brush. Both gates use CSS client / screen px (not scene):
 * pointer travel since down, and marquee longer side × zoom (avoids hairline slips).
 */
export const BRUSH_SCREEN_PX = 56;
export const TOUCH_BRUSH_SCREEN_PX = 64;

export function brushScreenPx(pointerType: string): number {
  return pointerType === 'touch' ? TOUCH_BRUSH_SCREEN_PX : BRUSH_SCREEN_PX;
}

export type DragState = {
  /** pointing_canvas: empty press; marquee only after brush gate. */
  mode: 'move' | 'resize' | 'rotate' | 'marquee' | 'pointing_canvas' | 'blank' | 'frame_move';
  startX: number;
  startY: number;
  sceneX0: number;
  sceneY0: number;
  origins: Array<{ nodeId: string; box: SceneBox; angle0?: number }>;
  union: SceneBox;
  handle?: ResizeHandle;
  angle0?: number;
  aspectRatio?: number;
  center?: { x: number; y: number };
  pointerAngle0?: number;
  /**
   * Open pen/pencil/path: drag endpoint by uniform scale+rotate about the
   * opposite path end (local coords at gesture start).
   */
  pathEpLocal0?: [number, number];
  pathEpLocal1?: [number, number];
  /**
   * Line/arrow: world position of the fixed opposite tip at pointerdown.
   * Endpoint math must not re-derive it from a drifting live box.
   */
  strokeFixedWorld?: { x: number; y: number };
  /**
   * Composer canvas-pick gesture: attach already ran on pointerdown.
   * Skip pointerup onSelect so one-shot clearPick does not steal node selection.
   */
  skipSelectOnUp?: boolean;
  /** Visual/layout scale at pointerdown (from rcbViewportMetrics). */
  scaleX?: number;
  scaleY?: number;
  /**
   * Continuously updated from pointerdown/move.
   * End events (up/cancel) must not supply geometry — their clientX/Y can be 0,0.
   */
  currentClientX: number;
  currentClientY: number;
  currentShift?: boolean;
  /** Empty artboard interior drag — same pipeline as title label move. */
  frameId?: string;
  /** Occupied plate soft-click — preserve frame pick on pointerup. */
  framePlatePick?: boolean;
  framePlateChrome?: 'soft' | 'full';
  frameStartX?: number;
  frameStartY?: number;
  frameWidth?: number;
  frameHeight?: number;
  frameMoveStarted?: boolean;
  /** Shift+move: lock to horizontal or vertical after first axis pick. */
  moveAxisLock?: 'h' | 'v';
  /**
   * Text was already the sole selection before this pointerdown.
   * Soft-click then enters inline edit (no 450ms double-tap window).
   */
  textWasSelectedOnDown?: boolean;
};

/** Shared seed for blank / pointing_canvas / move / resize / rotate drags. */
export function makeDragSeed(
  mode: DragState['mode'],
  e: { clientX: number; clientY: number },
  p: { x: number; y: number },
  extras?: Partial<DragState>,
  viewport?: HTMLElement | null
): DragState {
  const m = viewport ? rcbViewportMetrics(viewport) : null;
  return {
    mode,
    startX: e.clientX,
    startY: e.clientY,
    sceneX0: p.x,
    sceneY0: p.y,
    scaleX: m?.scaleX ?? 1,
    scaleY: m?.scaleY ?? 1,
    currentClientX: e.clientX,
    currentClientY: e.clientY,
    origins: [],
    union: { left: p.x, top: p.y, width: 1, height: 1 },
    ...extras,
  };
}

/** Scene point / delta from pointerdown — stable if stage rect jitters mid-gesture. */
export function sceneFromClientGesture(
  drag: Pick<DragState, 'sceneX0' | 'sceneY0' | 'startX' | 'startY' | 'scaleX' | 'scaleY'>,
  zoom: number,
  clientX: number,
  clientY: number
) {
  const d = rcbClientDeltaToScene(
    zoom,
    clientX - drag.startX,
    clientY - drag.startY,
    drag.scaleX ?? 1,
    drag.scaleY ?? 1
  );
  return { x: drag.sceneX0 + d.x, y: drag.sceneY0 + d.y, dx: d.x, dy: d.y };
}

/** Raw CSS client travel² since pointerdown (no layout-scale ÷, no scene/zoom). */
export function screenDragDistSq(
  drag: Pick<DragState, 'startX' | 'startY'>,
  clientX: number,
  clientY: number
): number {
  const dx = clientX - drag.startX;
  const dy = clientY - drag.startY;
  return dx * dx + dy * dy;
}

/** Dual brush gate: pointer travel + on-screen marquee size. */
export function evaluateBrushGate(
  drag: Pick<DragState, 'startX' | 'startY' | 'sceneX0' | 'sceneY0' | 'scaleX' | 'scaleY'>,
  zoom: number,
  clientX: number,
  clientY: number,
  pointerType: string
): { passed: boolean; box: SceneBox } {
  const brushPx = brushScreenPx(pointerType);
  const gesture = sceneFromClientGesture(drag, zoom, clientX, clientY);
  const box = normalizeBox(drag.sceneX0, drag.sceneY0, gesture.x, gesture.y);
  const z = Math.max(0.05, zoom || 1);
  const screenLong = Math.max(box.width, box.height) * z;
  const passed =
    screenDragDistSq(drag, clientX, clientY) >= brushPx * brushPx && screenLong >= brushPx;
  return { passed, box };
}

export function isSelectionOriginsLocked(
  document: SceneDocument,
  origins: Array<{ nodeId: string }> | null | undefined
): boolean {
  if (!origins?.length) return false;
  const frames = Array.isArray(document?.frames) ? document.frames : [];
  return origins.some((o) => {
    const fid = parseFrameSelId(o.nodeId);
    if (fid) return Boolean(frames.find((x: any) => x?.id === fid)?.locked);
    return isNodeLocked(document?.deltaSetLike?.[o.nodeId]);
  });
}

export function isRecentNodeDoubleTap(
  prev: { id: string; t: number; x: number; y: number } | null,
  hitId: string,
  e: { clientX: number; clientY: number },
  ms = 400,
  distPx = 10
): boolean {
  if (!prev || prev.id !== hitId) return false;
  return Date.now() - prev.t < ms && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < distPx;
}

export function buildMoveOriginsForHit(opts: {
  document: SceneDocument;
  hitId: string;
  selectedIds: string[];
  expandedHit: string[];
  liveOriginsNow: Array<{ nodeId: string; box: SceneBox }> | null | undefined;
  /** Current control box — keep oriented multi chrome instead of local AABB union. */
  liveUnionNow?: SceneBox | null;
  liveAngleNow?: number;
  getNodeBox: (id: string) => SceneBox | null | undefined;
  fallbackPoint: { x: number; y: number };
}): { origins: Array<{ nodeId: string; box: SceneBox }>; union: SceneBox } {
  const {
    document,
    hitId,
    selectedIds,
    expandedHit,
    liveOriginsNow,
    liveUnionNow,
    liveAngleNow,
    getNodeBox,
    fallbackPoint,
  } = opts;
  const moveNodeIds = expandSelectionWithGroups(
    document,
    selectedIds.includes(hitId) ? selectedIds.filter((id) => !parseFrameSelId(id)) : expandedHit
  );
  const frameOrigins =
    selectedIds.includes(hitId) && liveOriginsNow
      ? liveOriginsNow.filter((o) => parseFrameSelId(o.nodeId))
      : [];
  const origins = [
    ...moveNodeIds
      .map((id) => {
        const box = liveOriginsNow?.find((o) => o.nodeId === id)?.box || getNodeBox(id);
        return box ? { nodeId: id, box: { ...box } } : null;
      })
      .filter(Boolean),
    ...frameOrigins.map((o) => ({ nodeId: o.nodeId, box: { ...o.box } })),
  ] as Array<{ nodeId: string; box: SceneBox }>;
  if (!origins.length) {
    return {
      origins,
      union: {
        left: fallbackPoint.x,
        top: fallbackPoint.y,
        width: 1,
        height: 1,
      },
    };
  }
  return {
    origins,
    union: resolveControlChrome(document, origins, liveUnionNow, liveAngleNow).box,
  };
}

export function filterMarqueeContentHits(
  document: SceneDocument,
  rawHits: string[],
  frameHitSet: Set<string>,
  marquee?: SceneBox
) {
  const selectedFrames = (document.frames || []).filter((frame) =>
    frameHitSet.has(String(frame.id))
  );
  const touchedFrameIds = new Set(frameHitSet);
  if (marquee) {
    for (const id of framesIntersectingBox(document, marquee)) {
      touchedFrameIds.add(id);
    }
  }
  return rawHits.filter((id) => {
    const node = document.deltaSetLike?.[id];
    if (node) {
      const ownerId = String(node.attrs?.frameId || '').trim();
      if (ownerId && touchedFrameIds.size) {
        return touchedFrameIds.has(ownerId);
      }
    }
    const plateFrame = frameForFullBleedPlate(document, id);
    if (!plateFrame) return true;
    // A full-bleed plate is the artboard background, not user content. When
    // the marquee encloses that artboard, let the frame selection own it.
    if (frameHitSet.has(plateFrame)) return false;
    return rawHits.some((other) => other !== id && !frameForFullBleedPlate(document, other));
  });
}

/**
 * Conservative fallback for clicks while an artboard is selected. The normal
 * Path2D hit can briefly miss during a live frame repaint; use the visible
 * node box so a node click cannot fall back to the artboard.
 */
export function fallbackVisibleNodeHit(
  document: SceneDocument,
  point: { x: number; y: number },
  nodeIds: readonly string[],
  getNodeBox: (id: string) => SceneBox | null,
  playheadSec?: number
): string | null {
  const frames = Array.isArray(document?.frames) ? document.frames : [];
  const nodeIntersectsFrame = (node: any, frame: any) => {
    const left = Number(node.x) || 0;
    const top = Number(node.y) || 0;
    const right = left + Math.max(1, Number(node.width) || 1);
    const bottom = top + Math.max(1, Number(node.height) || 1);
    const frameLeft = Number(frame.x) || 0;
    const frameTop = Number(frame.y) || 0;
    const frameRight = frameLeft + Math.max(1, Number(frame.width) || 1);
    const frameBottom = frameTop + Math.max(1, Number(frame.height) || 1);
    return left < frameRight && right > frameLeft && top < frameBottom && bottom > frameTop;
  };
  const frameBox = (frame: any): SceneBox => ({
    left: Number(frame.x) || 0,
    top: Number(frame.y) || 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1),
  });
  const orderedNodeIds = (() => {
    const ids = nodeIds.map(String);
    const zMap = buildNodeStackZMap(document, ids);
    return [...ids].sort((a, b) => (zMap.get(b) || 0) - (zMap.get(a) || 0));
  })();
  for (const rawId of orderedNodeIds) {
    const id = String(rawId || '');
    const node = document?.deltaSetLike?.[id];
    if (!id || !node || isNodeHiddenInDocument(document, node, playheadSec) || frameForFullBleedPlate(document, id)) continue;
    const ownerId = String(node.attrs?.frameId || '').trim();
    if (ownerId && frameIdAtPoint(document, point.x, point.y) !== ownerId) continue;
    const box = getNodeBox(id);
    if (!box || !pointInBox(point.x, point.y, box)) continue;
    const clippingFrames = frames.filter((frame) => {
      if (!frame || frame.clipContent === false || frame.hidden) return false;
      return nodeIntersectsFrame(node, frame);
    });
    if (clippingFrames.length && !clippingFrames.some((frame) => pointInBox(point.x, point.y, frameBox(frame)))) continue;
    return id;
  }
  return null;
}

function visibleNodeBoxWithinFrames(
  doc: SceneDocument,
  node: any,
  box: SceneBox
): SceneBox | null {
  const frames = (doc.frames || []).filter((frame) => frame?.clipContent !== false);
  const left = Number(node.x) || 0;
  const top = Number(node.y) || 0;
  const right = left + Math.max(1, Number(node.width) || 1);
  const bottom = top + Math.max(1, Number(node.height) || 1);
  const clipping = frames.filter((frame) => {
    const frameLeft = Number(frame.x) || 0;
    const frameTop = Number(frame.y) || 0;
    const frameRight = frameLeft + Math.max(1, Number(frame.width) || 1);
    const frameBottom = frameTop + Math.max(1, Number(frame.height) || 1);
    return left < frameRight && right > frameLeft && top < frameBottom && bottom > frameTop;
  });
  if (!clipping.length) return box;
  const visibleParts = clipping
    .map((frame) => {
      const frameBox = {
        left: Number(frame.x) || 0,
        top: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1),
        height: Math.max(1, Number(frame.height) || 1),
      };
      const leftEdge = Math.max(box.left, frameBox.left);
      const topEdge = Math.max(box.top, frameBox.top);
      const rightEdge = Math.min(box.left + box.width, frameBox.left + frameBox.width);
      const bottomEdge = Math.min(box.top + box.height, frameBox.top + frameBox.height);
      if (rightEdge <= leftEdge || bottomEdge <= topEdge) return null;
      return {
        left: leftEdge,
        top: topEdge,
        width: rightEdge - leftEdge,
        height: bottomEdge - topEdge,
      };
    })
    .filter((part): part is SceneBox => Boolean(part));
  if (!visibleParts.length) return null;
  return visibleParts.reduce((acc, part) => unionSceneBoxes(acc, part));
}

/** Artboards whose bounds overlap a scene rect (marquee brush, not full enclosure). */
export function framesIntersectingBox(doc: SceneDocument, rect: SceneBox): string[] {
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  const out: string[] = [];
  for (const frame of frames) {
    if (!frame || frame.hidden) continue;
    const fb: SceneBox = {
      left: Number(frame.x) || 0,
      top: Number(frame.y) || 0,
      width: Math.max(1, Number(frame.width) || 1),
      height: Math.max(1, Number(frame.height) || 1),
    };
    if (boxesIntersect(rect, fb)) out.push(String(frame.id));
  }
  return out;
}

/**
 * Pick/marquee visible bounds — bound nodes clip to their owning artboard only,
 * so overflow geometry cannot be selected from an adjacent frame.
 */
export function visibleNodeBoxForSelection(
  doc: SceneDocument,
  node: any,
  box: SceneBox
): SceneBox | null {
  const ownerId = String(node?.attrs?.frameId || '').trim();
  if (ownerId) {
    const frame = (doc.frames || []).find((f) => String(f?.id) === ownerId);
    if (!frame || frame.hidden) return null;
    const fb: SceneBox = {
      left: Number(frame.x) || 0,
      top: Number(frame.y) || 0,
      width: Math.max(1, Number(frame.width) || 1),
      height: Math.max(1, Number(frame.height) || 1),
    };
    const leftEdge = Math.max(box.left, fb.left);
    const topEdge = Math.max(box.top, fb.top);
    const rightEdge = Math.min(box.left + box.width, fb.left + fb.width);
    const bottomEdge = Math.min(box.top + box.height, fb.top + fb.height);
    if (rightEdge <= leftEdge || bottomEdge <= topEdge) return null;
    return {
      left: leftEdge,
      top: topEdge,
      width: rightEdge - leftEdge,
      height: bottomEdge - topEdge,
    };
  }
  return visibleNodeBoxWithinFrames(doc, node, box);
}

export function commitMarqueeSelection(opts: {
  contentHits: string[];
  frameHits: string[];
  rawHits: string[];
  shiftKey: boolean;
  onSelectMixed?: (
    nodeIds: string[],
    frameIds: string[],
    opts?: { additive?: boolean }
  ) => void;
  onSelectFrames?: (ids: string[]) => void;
  onSelectFrame?: (id: string | null) => void;
  onSelect: (ids: string[], opts?: { additive?: boolean }) => void;
}) {
  const {
    contentHits,
    frameHits,
    rawHits,
    shiftKey,
    onSelectMixed,
    onSelectFrames,
    onSelectFrame,
    onSelect,
  } = opts;
  const uniqueFrameHits = [...new Set(frameHits.filter(Boolean))];
  const selectedContent = contentHits.length ? contentHits : rawHits;

  // Multiple intersecting artboards — select as units; canvas-root nodes in
  // the same brush (outside those frames) can still join the selection.
  if (uniqueFrameHits.length > 1) {
    if (onSelectMixed) {
      onSelectMixed(selectedContent, uniqueFrameHits, { additive: shiftKey });
    } else if (onSelectFrames) {
      onSelectFrames(uniqueFrameHits);
    }
    return;
  }

  // Frame + scene content in one brush — unified mixed selection.
  if (uniqueFrameHits.length === 1 && selectedContent.length) {
    if (onSelectMixed) {
      onSelectMixed(selectedContent, uniqueFrameHits, { additive: shiftKey });
      return;
    }
  }

  // A single intersecting artboard is selected only when no scene content
  // was hit. If content is present, the user is selecting that content.
  if (uniqueFrameHits.length === 1 && contentHits.length === 0) {
    if (onSelectFrame) onSelectFrame(uniqueFrameHits[0]);
    else if (onSelectFrames) onSelectFrames(uniqueFrameHits);
    return;
  }

  if (selectedContent.length) {
    onSelect(selectedContent, { additive: shiftKey });
    return;
  }
  if (uniqueFrameHits.length && onSelectFrames) {
    onSelectFrames(uniqueFrameHits);
    return;
  }
  onSelect([], { additive: shiftKey });
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
export function visualGuideBoxForNode(
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
export function clippedGuideBoxForNode(
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
export function visualBoxFromChromeOrigin(
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

function guidePaintEps(threshold: number): number {
  return Math.max(GUIDE_COINCIDE_EPS, Number(threshold) || 0);
}

function pathInsetFromVisualOuter(visual: SceneBox, outset: number): SceneBox {
  return {
    left: visual.left + outset,
    top: visual.top + outset,
    width: Math.max(1, visual.width - outset * 2),
    height: Math.max(1, visual.height - outset * 2),
  };
}

/** Pick dominant drag axis for Shift-constrained move (ties → horizontal). */
export function resolveMoveAxisLock(
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

export function constrainMoveDelta(
  dx: number,
  dy: number,
  axis: 'h' | 'v'
): { dx: number; dy: number } {
  return axis === 'h' ? { dx, dy: 0 } : { dx: 0, dy };
}

/** Shift+drag move: constrain to one axis; release Shift to move freely again. */
export function shiftConstrainedMoveDelta(
  drag: Pick<DragState, 'moveAxisLock'>,
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

export type ResizeSnapContext = {
  document: SceneDocument;
  drag: DragState;
  dx: number;
  dy: number;
  shiftKey: boolean;
  disableSnap: boolean;
  gridSize: number;
  targets: SmartGuideTarget[];
  threshold: number;
};

/** Rough resized union for smart-guide target queries during resize drag. */
export function resizeDragNearBox(
  drag: Pick<DragState, 'union' | 'handle' | 'angle0'>,
  dx: number,
  dy: number
): SceneBox {
  if (!drag.handle) return drag.union;
  const rough = resizeFromHandle(drag.union, drag.handle, dx, dy, drag.angle0 || 0, {});
  return unionOfBoxes([drag.union, rough]) ?? rough;
}

export function computeResizedUnion(ctx: ResizeSnapContext): {
  next: SceneBox;
  textMode: TextResizeMode | undefined;
  lockAspect: boolean;
  guides: SmartGuideLine[];
} {
  const handle = ctx.drag.handle!;
  const angle0 = ctx.drag.angle0 || 0;
  const rotated = Math.abs(angle0) >= 0.01;
  const lockAspect = resolveLockAspect(ctx.document, ctx.drag.origins, handle, ctx.shiftKey);
  let next = resizeFromHandle(ctx.drag.union, handle, ctx.dx, ctx.dy, angle0, {
    lockAspect,
    aspectRatio: ctx.drag.aspectRatio,
  });
  let guides: SmartGuideLine[] = [];
  const singleId = ctx.drag.origins.length === 1 ? ctx.drag.origins[0].nodeId : null;
  const singleNode = singleId ? ctx.document?.deltaSetLike?.[singleId] : null;
  const snapAsPath = Boolean(singleId && !parseFrameSelId(singleId));
  const paintEps = guidePaintEps(ctx.threshold);
  if (!ctx.disableSnap) {
    // Grid **outer ink** (match draw + move); inset back to path. Guides when near.
    // Axis-aligned grid snap fights oriented resize — skip when rotated.
    if (snapAsPath && singleNode) {
      const path0 = deflateSelectionBox({ ...next }, singleNode);
      const outset = strokeVisualOutset(singleNode);
      let pathNext = path0;
      if (ctx.gridSize > 0 && !rotated) {
        const visualNext = snapResizeToGrid(
          inflateBoxByVisualOutset(path0, singleNode),
          handle,
          ctx.gridSize,
          Math.max(RESIZE_MIN_SIZE, Math.ceil(outset * 2) + ctx.gridSize),
          { lockAspect, aspectRatio: ctx.drag.aspectRatio }
        );
        pathNext = pathInsetFromVisualOuter(visualNext, outset);
      }
      if (ctx.targets.length) {
        const peerSnapped = snapResizeToPeers(pathNext, handle, ctx.targets, ctx.threshold, Math.max(RESIZE_MIN_SIZE, Math.ceil(outset * 2)), {
          lockAspect,
          aspectRatio: ctx.drag.aspectRatio,
        });
        pathNext = peerSnapped.box;
        guides = peerSnapped.guides;
      }
      next = inflateSelectionBox(pathNext, singleNode);
    } else {
      if (ctx.gridSize > 0 && !rotated) {
        next = snapResizeToGrid(next, handle, ctx.gridSize, RESIZE_MIN_SIZE, {
          lockAspect,
          aspectRatio: ctx.drag.aspectRatio,
        });
      }
      if (ctx.targets.length) {
        const peerSnapped = snapResizeToPeers(next, handle, ctx.targets, ctx.threshold, RESIZE_MIN_SIZE, {
          lockAspect,
          aspectRatio: ctx.drag.aspectRatio,
        });
        next = peerSnapped.box;
        guides = peerSnapped.guides;
      }
    }
  }
  next = {
    ...next,
    width: Math.max(1, next.width),
    height: Math.max(1, next.height),
  };
  const singleTextMode =
    ctx.drag.origins.length === 1 && String(singleNode?.key || '') === 'text'
      ? textResizeModeForHandle(handle, {
          textFrame:
            singleNode?.attrs?.textFrame === true ||
            singleNode?.attrs?.textFrame === 'true' ||
            singleNode?.attrs?.textFrame === 1 ||
            singleNode?.attrs?.textFrame === '1',
        })
      : undefined;
  // Only horizontal edge resizing changes wrapping. Corner and vertical
  // resizing must preserve the requested control-box height while scaling text.
  if (singleTextMode === 'wrap') {
    next = applyTextWrapHeight(ctx.document, ctx.drag.origins[0].nodeId, next);
  }
  // Text wrap / path inflate can nudge size — pin opposite again when rotated.
  if (rotated) {
    next = reanchorResizeOpposite(
      next,
      handle,
      angle0,
      resizeOppositeWorld(ctx.drag.union, handle, angle0)
    );
  }
  return { next, textMode: singleTextMode, lockAspect, guides };
}

/** Sibling **visual-outer** AABBs for align guides (exclude selection + hidden/locked). */
export function collectSmartGuideTargets(
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

/**
 * Timeline-open workbench child drag: skip O(n) sibling snap.
 */
export function shouldSkipSmartGuidesForAnimationWorkbenchDrag(
  document: SceneDocument,
  originNodeIds: readonly string[]
): boolean {
  const focus = getAnimationWorkbenchTimelineFocus();
  if (!focus || !originNodeIds.length) return false;
  for (const id of originNodeIds) {
    const node = document.deltaSetLike?.[id];
    if (!node) return false;
    if (String(node.attrs?.frameId || '').trim() !== focus) return false;
  }
  return true;
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

export function computeRotateDelta(
  drag: DragState,
  p: { x: number; y: number },
  shiftKey: boolean
): { next: number; delta: number } {
  const now = (Math.atan2(p.y - drag.center!.y, p.x - drag.center!.x) * 180) / Math.PI;
  let next = (drag.angle0 || 0) + (now - drag.pointerAngle0!);
  if (shiftKey) next = Math.round(next / 15) * 15;
  return { next, delta: next - (drag.angle0 || 0) };
}

export function strokeEndpointBox(
  drag: DragState,
  document: SceneDocument,
  sceneX: number,
  sceneY: number,
  shiftKey = false
): { next: SceneBox; angle: number; strokeId: string } | null {
  const strokeId = drag.origins.length === 1 ? drag.origins[0].nodeId : '';
  if (!strokeId || !drag.handle) return null;
  if (drag.handle !== 'e' && drag.handle !== 'w') return null;
  const shapeType = readNodeShapeType(document, strokeId);

  // Open pen/pencil/path: scale+rotate about the opposite path endpoint so the
  // grabbed tip follows the pointer (AABB edge resize would miss the tip).
  if (
    drag.pathEpLocal0 &&
    drag.pathEpLocal1 &&
    (shapeType === 'pen' || shapeType === 'pencil' || shapeType === 'path')
  ) {
    const placed = resizeOpenPathByEndpoint(
      drag.union,
      drag.angle0 || 0,
      drag.pathEpLocal0,
      drag.pathEpLocal1,
      drag.handle,
      sceneX,
      sceneY
    );
    if (!placed) return null;
    return { strokeId, angle: placed.angle, next: placed.box };
  }

  if (!isStrokeShapeType(shapeType)) return null;
  // Prefer the world tip frozen at pointerdown — recomputing from live origins
  // after preview writes can let the "fixed" end drift.
  if (drag.strokeFixedWorld) {
    const fixed = drag.strokeFixedWorld;
    let nextX = sceneX;
    let nextY = sceneY;
    if (shiftKey) {
      const dx = sceneX - fixed.x;
      const dy = sceneY - fixed.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-6) {
        const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        nextX = fixed.x + Math.cos(snapped) * length;
        nextY = fixed.y + Math.sin(snapped) * length;
      }
    }
    const placed =
      drag.handle === 'e'
        ? strokeNodeFromEndpoints({ x0: fixed.x, y0: fixed.y, x1: nextX, y1: nextY })
        : strokeNodeFromEndpoints({ x0: nextX, y0: nextY, x1: fixed.x, y1: fixed.y });
    return {
      strokeId,
      angle: placed.angle,
      next: { left: placed.x, top: placed.y, width: placed.width, height: placed.height },
    };
  }
  // Endpoint math must use the shaft geometry box — painted chrome unions /
  // liveOrigins are often stroke-inflated and would move the "fixed" end.
  const originBox = drag.origins.find((o) => o.nodeId === strokeId)?.box;
  const node = document.deltaSetLike?.[strokeId];
  const geomBox = deflateSelectionBox(
    originBox ? { ...originBox } : { ...drag.union },
    node
  );
  const placed = resizeStrokeByEndpoint(
    geomBox,
    drag.angle0 || 0,
    drag.handle,
    sceneX,
    sceneY,
    shiftKey
  );
  return {
    strokeId,
    angle: placed.angle,
    next: { left: placed.x, top: placed.y, width: placed.width, height: placed.height },
  };
}

/**
 * Uniform scale + rotate about the fixed path end so the free end tracks the pointer.
 * Path local coords scale with the box (same as live geometry preview).
 */
export function resizeOpenPathByEndpoint(
  box: SceneBox,
  angleDeg: number,
  ep0: [number, number],
  ep1: [number, number],
  handle: 'e' | 'w',
  pointerX: number,
  pointerY: number
): { box: SceneBox; angle: number } | null {
  const freeLocal = handle === 'w' ? ep0 : ep1;
  const fixedLocal = handle === 'w' ? ep1 : ep0;
  const fixedW = localPointToWorld(fixedLocal[0], fixedLocal[1], box, angleDeg);
  const free0W = localPointToWorld(freeLocal[0], freeLocal[1], box, angleDeg);
  const len0 = Math.hypot(free0W.x - fixedW.x, free0W.y - fixedW.y);
  if (!(len0 > 1e-4)) return null;
  const len1 = Math.hypot(pointerX - fixedW.x, pointerY - fixedW.y);
  const scale = Math.max(0.05, len1 / len0);
  const a0 = Math.atan2(free0W.y - fixedW.y, free0W.x - fixedW.x);
  const a1 = Math.atan2(pointerY - fixedW.y, pointerX - fixedW.x);
  const newAngle = angleDeg + ((a1 - a0) * 180) / Math.PI;
  const newW = Math.max(1, box.width * scale);
  const newH = Math.max(1, box.height * scale);
  // Path scales from local origin with the box — fixed/free locals scale too.
  const fixedLocal2: [number, number] = [fixedLocal[0] * scale, fixedLocal[1] * scale];
  const next = boxFromLocalAnchor(
    fixedLocal2[0],
    fixedLocal2[1],
    fixedW.x,
    fixedW.y,
    newW,
    newH,
    newAngle
  );
  return { box: next, angle: Number(newAngle.toFixed(2)) };
}

export function readNodeAngle(document: SceneDocument, nodeId: string) {
  // Prefer live host angle (playhead scrub / in-progress transform) over attrs.
  const live = hostAngleDeg(nodeId, Number.NaN);
  if (Number.isFinite(live)) return live;
  const node = document?.deltaSetLike?.[nodeId];
  const n = Number(node?.attrs?.angle);
  return Number.isFinite(n) ? n : 0;
}

export function readNodeShapeType(document: SceneDocument, nodeId: string) {
  return String(document?.deltaSetLike?.[nodeId]?.attrs?.shapeType || '');
}

export function isStrokeShapeType(t: string) {
  return t === 'line' || t === 'arrow';
}

/** Live angle while rotating / free-angle stroke resize; otherwise stored attrs. */
export function resolveChromeAngle(opts: {
  enabled: boolean;
  singleNode: boolean;
  /** Multi-select: shared member angle (0 when angles differ). */
  multiSelected: boolean;
  selectedNodeId: string | undefined;
  document: SceneDocument;
  transforming: boolean;
  dragMode: string | undefined;
  hasPathEndpoints: boolean;
  liveAngle: number;
}): number {
  if (!opts.enabled) return 0;
  if (opts.multiSelected) return opts.liveAngle;
  if (!opts.singleNode || !opts.selectedNodeId) return 0;
  const fromDoc = readNodeAngle(opts.document, opts.selectedNodeId);
  if (!opts.transforming) return fromDoc;
  if (opts.dragMode === 'rotate') return opts.liveAngle;
  if (
    opts.dragMode === 'resize' &&
    isStrokeShapeType(readNodeShapeType(opts.document, opts.selectedNodeId))
  ) {
    return opts.liveAngle;
  }
  if (opts.dragMode === 'resize' && opts.hasPathEndpoints) {
    return opts.liveAngle;
  }
  // Move / box-resize: always use stored angle — avoids click flash when liveAngle lags at 0.
  return fromDoc;
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

export function deflateChromeBox(chrome: SceneBox | null | undefined, node: SceneNodeInput): SceneBox | null {
  return chrome ? deflateSelectionBox(chrome, node) : null;
}

export function resolveTransformHostGuideBox(
  sid: string,
  sn: any,
  getNodeBox: (id: string) => SceneBox | null,
  liveOrigins: Array<{ nodeId: string; box: SceneBox }> | null | undefined
): SceneBox | null {
  const hostGeom = liveShapeGeomBox(sid);
  if (hostGeom) return hostGeom;
  const liveChrome = liveOrigins?.find((o) => o.nodeId === sid)?.box;
  const fromLive = deflateChromeBox(liveChrome, sn);
  if (fromLive) return fromLive;
  return deflateChromeBox(getNodeBox(sid), sn);
}

/** Host path silhouette / handles / transform spacing aux for vector nodes. */
export function buildShapeOutlines(opts: {
  enabled: boolean;
  suppressChrome: boolean;
  readOnly: boolean;
  document: SceneDocument;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  hoverNodeId: string | null;
  inspectDev: boolean;
  transforming: boolean;
  inspectPrimaryId: string | null;
  inspectPairNodeId: string | null;
  singleId: string | null;
  chromeAngle: number;
  selectedIsImageGen: boolean;
  selectedIsVideoGen: boolean;
  selectedIsLottieGen?: boolean;
  liveOrigins: Array<{ nodeId: string; box: SceneBox }> | null | undefined;
  /** Oriented multi-select control box (session); falls back to member AABB union. */
  multiUnionBox?: SceneBox | null;
  multiUnionAngle?: number;
  getNodeBox: (id: string) => SceneBox | null;
  /** store playhead — same hide gate as selection chrome / hit-test. */
  playheadSec?: number;
}): ShapeOutlineItem[] {
  if (!opts.enabled || opts.suppressChrome) return [];

  const ids: string[] = [];
  const handleIds = new Set<string>();
  /** Geom box override while dragging (host live origin). */
  const hostGuideBoxById = new Map<string, SceneBox>();
  /** Single: host silhouettes + handles. Multi path: silhouettes + host-mirrored union box. */
  const hostHandlesOk =
    !opts.readOnly &&
    opts.selectedNodeIds.length === 1 &&
    opts.selectedFrameIds.length === 0;

  const pushId = (id: string | null | undefined) => {
    if (!id || parseFrameSelId(id) || ids.includes(id)) return;
    const node = opts.document?.deltaSetLike?.[id];
    // One hide gate: attrs.hidden, workbench focus, playhead trim, …
    if (node && isNodeHiddenInDocument(opts.document, node, opts.playheadSec)) return;
    ids.push(id);
  };

  const measurePairId = resolveMeasurePairNodeId({
    inspectDev: opts.inspectDev,
    transforming: opts.transforming,
    hoverNodeId: opts.hoverNodeId,
    inspectPairNodeId: opts.inspectPairNodeId,
    inspectPrimaryId: opts.inspectPrimaryId,
    selectedNodeIds: opts.selectedNodeIds,
  });

  // Inspect measure-pair silhouette (orange + spacing).
  if (!opts.transforming && measurePairId) {
    pushId(measurePairId);
  } else if (
    // Edit: light blue hover outline only — no spacing pair chrome.
    !opts.inspectDev &&
    !opts.transforming &&
    opts.hoverNodeId &&
    !opts.selectedNodeIds.includes(opts.hoverNodeId)
  ) {
    const hoverNode = opts.document?.deltaSetLike?.[opts.hoverNodeId];
    // 动画工作台 preview children are display-only — no hover path silhouette.
    if (!isAnimationWorkbenchPreviewChild(opts.document, hoverNode)) {
      pushId(opts.hoverNodeId);
    }
  }

  // Inspect select: path silhouette only (spacing drawn via SmartGuidesOverlay).
  if (
    opts.inspectDev &&
    !opts.transforming &&
    opts.inspectPrimaryId &&
    !parseFrameSelId(opts.inspectPrimaryId) &&
    nodeUsesPathChrome(opts.document?.deltaSetLike?.[opts.inspectPrimaryId])
  ) {
    pushId(opts.inspectPrimaryId);
  }

  // Edit idle: selected path chrome + handles (single).
  if (!opts.inspectDev && !opts.transforming) {
    for (const sid of opts.selectedNodeIds) {
      const sn = opts.document?.deltaSetLike?.[sid];
      if (isAnimationWorkbenchPreviewChild(opts.document, sn)) continue;
      if (!nodeUsesPathChrome(sn)) continue;
      pushId(sid);
      // Single: host handles. Multi path: host-mirrored union chrome (below).
      // Generators keep the blue box but no resize knobs (same as SelectionChrome).
      if (hostHandlesOk) handleIds.add(sid);
    }
  }

  // Transform: keep mover path chrome mounted (geometry live-updates with drag).
  if (
    !opts.inspectDev &&
    opts.transforming &&
    opts.selectedNodeIds.length === 1 &&
    opts.selectedFrameIds.length === 0
  ) {
    const sid = opts.selectedNodeIds[0];
    const sn = sid ? opts.document?.deltaSetLike?.[sid] : null;
    if (sid && nodeUsesPathChrome(sn)) {
      pushId(sid);
      const anchorBox = resolveTransformHostGuideBox(sid, sn, opts.getNodeBox, opts.liveOrigins);
      if (anchorBox) hostGuideBoxById.set(sid, anchorBox);
    }
  }

  const out: ShapeOutlineItem[] = [];
  for (const id of ids) {
    const node = opts.document?.deltaSetLike?.[id];
    if (!nodeUsesPathChrome(node)) continue;
    const liveChrome =
      opts.transforming && opts.liveOrigins
        ? opts.liveOrigins.find((o) => o.nodeId === id)?.box
        : null;
    const chromeBox = liveChrome || opts.getNodeBox(id);
    if (!chromeBox) continue;
    const geomBox =
      hostGuideBoxById.get(id) ||
      (liveChrome
        ? deflateSelectionBox(liveChrome, node)
        : liveShapeGeomBox(id) || deflateSelectionBox(chromeBox, node));
    const gw = Math.max(1, geomBox.width);
    const gh = Math.max(1, geomBox.height);
    const pathD = resolveOutlinePathD(node, gw, gh, id);
    if (!pathD) continue;
    rememberNodePath2D(id, pathD);
    const angle = id === opts.singleId ? opts.chromeAngle : readNodeAngle(opts.document, id);
    const lineMode = nodeUsesOpenStrokeEndpoints(node);
    const shapeType = String(node.attrs?.shapeType || '');
    const shaftEndpoints = shapeType === 'line' || shapeType === 'arrow';
    const withHandles = handleIds.has(id);
    const nodeKey = String(node.key || '');
    const isGen =
      isImageGeneratorNode(node) ||
      isVideoGeneratorNode(node) ||
      isLottieGeneratorNode(node) ||
      isAudioGeneratorNode(node);
    let edgeHandles: SelectionEdgeHandles = 'all';
    if (isGen) edgeHandles = 'none';
    else if (nodeKey === 'video') edgeHandles = 'horizontal';
    const isMeasurePair =
      Boolean(measurePairId) && id === measurePairId && !opts.selectedNodeIds.includes(id);
    out.push({
      id,
      pathD,
      box: geomBox,
      angle,
      flipX: node?.attrs?.flipX === true || node?.attrs?.flipX === 'true',
      flipY: node?.attrs?.flipY === true || node?.attrs?.flipY === 'true',
      color: isMeasurePair ? SMART_GUIDE_COLOR : '#3388ff',
      withHandles,
      // Rect / ellipse: AABB matches ink — box stroke is enough when selected.
      // Triangle / path / pen: keep blue silhouette so clipped overflow outside a
      // frame still shows (chrome mounts outside frame clip), matching rect UX.
      showPath:
        !opts.transforming &&
        (!withHandles || shapeNeedsSelectedPathSilhouette(node)),
      lineMode,
      shaftEndpoints,
      edgeHandles,
      chromeOutset: Math.max(0, strokeChromeOutset(node)),
      strokeOuterScene: Math.max(0, strokeOuterClearanceScene(node)),
      showRotate:
        withHandles &&
        !lineMode &&
        !isGen &&
        !opts.selectedIsImageGen &&
        !opts.selectedIsVideoGen &&
        !opts.selectedIsLottieGen &&
        edgeHandles === 'all',
    });
  }

  // Single artboard / 动画工作台: same as shapes — hide host chrome while transforming.
  const singleFrameOnly =
    opts.selectedFrameIds.length === 1 &&
    (!opts.selectedNodeIds || opts.selectedNodeIds.length === 0);
  if (!opts.inspectDev && !opts.transforming && singleFrameOnly) {
    const fid = opts.selectedFrameIds[0];
    const frames = Array.isArray(opts.document?.frames) ? opts.document.frames : [];
    const frame = frames.find((f: any) => f && String(f.id) === String(fid));
    if (frame) {
      const previewPlate = isAnimationWorkbenchFrameInPreview(opts.document, fid);
      const { left, top, width, height } = resolveFrameChromeBox(String(fid), frame);
      out.push({
        id: frameSelId(fid),
        mirrorHostId: String(fid),
        pathD: '',
        box: { left, top, width, height },
        angle: 0,
        color: '#3388ff',
        withHandles: !opts.readOnly,
        showPath: false,
        unionChrome: true,
        cornerHandlesOnly: previewPlate,
        showRotate: false,
        edgeHandles: previewPlate ? 'none' : 'all',
      });
    }
  }

  // Multi artboard: AABB union chrome (same host-mirrored path as single frame).
  // Hide while transforming — same as multi-shape move chrome.
  const multiFrameOnly =
    opts.selectedFrameIds.length > 1 &&
    (!opts.selectedNodeIds || opts.selectedNodeIds.length === 0);
  if (!opts.inspectDev && !opts.transforming && multiFrameOnly) {
    const frames = Array.isArray(opts.document?.frames) ? opts.document.frames : [];
    const memberBoxes: SceneBox[] = [];
    for (const fid of opts.selectedFrameIds) {
      const frame = frames.find((f: any) => f && String(f.id) === String(fid));
      if (!frame) continue;
      memberBoxes.push(resolveFrameChromeBox(String(fid), frame));
    }
    const union = unionOfBoxes(memberBoxes);
    if (union) {
      out.push({
        id: '__rcb_frame_union__',
        mirrorHostId: String(opts.selectedFrameIds[0]),
        pathD: '',
        box: union,
        angle: 0,
        color: '#3388ff',
        withHandles: !opts.readOnly,
        showPath: false,
        unionChrome: true,
        cornerHandlesOnly: false,
        showRotate: false,
        edgeHandles: 'all',
      });
    }
  }

  // Multi path-only: oriented union box + corner handles via host-mirrored chrome
  // (same method as single — world SelectionChrome drifts at high zoom).
  const multiPathOnly =
    !opts.inspectDev &&
    !opts.readOnly &&
    opts.selectedFrameIds.length === 0 &&
    opts.selectedNodeIds.length > 1 &&
    opts.selectedNodeIds.every((id) => nodeUsesPathChrome(opts.document?.deltaSetLike?.[id]));
  if (multiPathOnly) {
    let union = opts.multiUnionBox || null;
    if (!union) {
      const memberBoxes: SceneBox[] = [];
      for (const id of opts.selectedNodeIds) {
        const node = opts.document?.deltaSetLike?.[id];
        const live = liveShapeGeomBox(id);
        const fallback = opts.getNodeBox(id);
        const geom =
          live || (fallback ? deflateSelectionBox(fallback, node) : null);
        if (geom) memberBoxes.push(inflateSelectionBox(geom, node));
      }
      union = unionOfBoxes(memberBoxes);
    }
    if (union) {
      let strokeOuter = 0;
      for (const id of opts.selectedNodeIds) {
        const node = opts.document?.deltaSetLike?.[id];
        if (node) strokeOuter = Math.max(strokeOuter, strokeOuterClearanceScene(node));
      }
      out.push({
        id: '__rcb_sel_union__',
        mirrorHostId: opts.selectedNodeIds[0],
        pathD: '',
        box: union,
        angle: Number(opts.multiUnionAngle) || 0,
        color: '#3388ff',
        // Keep the control box mounted while rotating (handles-key draws the stroke).
        withHandles: true,
        showPath: false,
        unionChrome: true,
        cornerHandlesOnly: true,
        // Same multi-rotate as world chrome (orbit about union center).
        showRotate: !opts.transforming,
        strokeOuterScene: strokeOuter,
      });
    }
  }

  return out;
}

/**
 * Control box for painted chrome — must match HostPathChrome / SelectionChrome ink.
 * Prefer live host `__sceneLeft` lattice; store `liveUnion` alone drifts after sticky re-align.
 */
export function resolvePaintedControlChrome(
  document: SceneDocument,
  origins: Array<{ nodeId: string; box: SceneBox }>,
  liveUnion?: SceneBox | null,
  liveAngle?: number
): { box: SceneBox; angle: number } {
  const fallback = resolveControlChrome(document, origins, liveUnion, liveAngle);
  if (!origins.length) return fallback;

  // Oriented multi / session box is what host union chrome paints.
  if (origins.length > 1 && Math.abs(fallback.angle) > 0.01 && liveUnion) {
    return { box: { ...liveUnion }, angle: fallback.angle };
  }

  const lives: SceneBox[] = [];
  for (const o of origins) {
    if (parseFrameSelId(o.nodeId)) {
      lives.push({ ...o.box });
      continue;
    }
    const live = liveShapeGeomBox(o.nodeId);
    if (!live) return fallback;
    const node = document?.deltaSetLike?.[o.nodeId];
    const shapeType = String(node?.attrs?.shapeType || '').toLowerCase();
    const openStroke = shapeType === 'line' || shapeType === 'arrow';
    // HostPathChrome paints line/arrow knobs on path geometry. Inflating the
    // pick box put (w/e) seats past the blue handles — pointerdown missed
    // endpoint and fell through to whole-stroke move.
    lives.push(
      openStroke || nodeUsesPathChrome(node)
        ? { ...live }
        : inflateSelectionBox(live, node)
    );
  }
  if (lives.length !== origins.length) return fallback;
  const box = origins.length === 1 ? lives[0] : unionOfBoxes(lives);
  if (!box) return fallback;
  return { box: { ...box }, angle: fallback.angle };
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

/** Expanded stack on an unselected node — survives hover loss while alt tiles are open. */
export function resolvePinnedImageVariantsId(opts: {
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

/** SelectionChrome edge knobs: generators none; video/text L/R only; text frame SE only; else all. */
export type SelectionEdgeHandles = 'all' | 'horizontal' | 'none' | 'se-only';

export function resolveSelectionEdgeHandles(opts: {
  selectedIsImageGen: boolean;
  selectedIsVideoGen: boolean;
  selectedIsLottieGen: boolean;
  selectedIsVideo: boolean;
  selectedIsTextFrame?: boolean;
  lineChrome: boolean;
  nodeKey: string | undefined;
}): SelectionEdgeHandles {
  if (opts.selectedIsImageGen || opts.selectedIsVideoGen || opts.selectedIsLottieGen) return 'none';
  // Video scrubber on bottom — keep L/R only so S handle does not steal events.
  if (opts.selectedIsVideo) return 'horizontal';
  // Fixed text plates: bottom-right grip only (card-like resize).
  if (opts.selectedIsTextFrame) return 'se-only';
  // Text supports width and height wrapping/scaling from all four edges.
  if (!opts.lineChrome && opts.nodeKey === 'text') return 'all';
  return 'all';
}

/**
 * Selection: marquee / move / 8-way resize / rotate.
 */
