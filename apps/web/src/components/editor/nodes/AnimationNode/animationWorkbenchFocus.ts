/**
 * Timeline focus for 动画工作台:
 * - Surround pasteboard nodes (`animationWorkbenchSurround`) belong to a workbench
 *   but live outside its plate; saved with the project, shown only while that
 *   workbench's timeline is open. Attr is visibility/isolation only — ink uses
 *   the same Kit mesh path as closed-timeline unbound world (never DomHost via
 *   stack-above; see worldNodeStacksAboveAnyFrame).
 * - While the timeline is open, unrelated frames/nodes are paint/hit hidden.
 * - Bound children outside the playhead in/out range are visually hidden and
 *   not pickable (same inRange rule as AnimationPlayheadSceneSync).
 */

import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';

export const WORKBENCH_SURROUND_ATTR = 'animationWorkbenchSurround';

let timelineFocusFrameId: string | null = null;
let timelinePlayheadSec = 0;
/** Kit bridge registers here so focus changes push isolation without import cycles. */
let workbenchIsolationSync: (() => void) | null = null;
/** True while 动画工作台 plate is mid-drag (blocks ensure/sync / collab). */
let geometryPreviewActive = false;
/**
 * True while any selection node transform is mid-gesture.
 * Gates playhead TransformPreview storm only — does NOT block ensure/collab
 * (those stay on {@link isAnimationWorkbenchGeometryPreview} / plate drag).
 */
let sceneGeometryGestureActive = false;

export function setAnimationWorkbenchGeometryPreview(active: boolean) {
  geometryPreviewActive = Boolean(active);
}

export function isAnimationWorkbenchGeometryPreview(): boolean {
  return geometryPreviewActive;
}

/** Selection move/resize/rotate — pause playhead scene pose apply. */
export function setSceneGeometryGestureActive(active: boolean) {
  sceneGeometryGestureActive = Boolean(active);
}

export function isSceneGeometryGestureActive(): boolean {
  return sceneGeometryGestureActive;
}

/** Playhead must not fight plate or selection TransformPreview ownership. */
export function isPlayheadScenePoseBlocked(): boolean {
  return geometryPreviewActive || sceneGeometryGestureActive;
}

export function setAnimationWorkbenchTimelineFocus(frameId: string | null) {
  const next = String(frameId || '').trim() || null;
  const changed = timelineFocusFrameId !== next;
  timelineFocusFrameId = next;
  if (!timelineFocusFrameId) timelinePlayheadSec = 0;
  // Always notify — Kit may attach after focus was already set.
  if (changed || workbenchIsolationSync) {
    try {
      workbenchIsolationSync?.();
    } catch {
      /* ignore */
    }
  }
}

/** Register Kit isolation sync (avoid kitBridge ↔ focus import cycle). */
export function registerWorkbenchIsolationSync(fn: (() => void) | null) {
  workbenchIsolationSync = fn;
}

export function getAnimationWorkbenchTimelineFocus(): string | null {
  return timelineFocusFrameId;
}

export function setAnimationWorkbenchPlayheadSec(sec: number) {
  timelinePlayheadSec = Number.isFinite(sec) ? Math.max(0, Number(sec)) : 0;
}

export function getAnimationWorkbenchPlayheadSec(): number {
  return timelinePlayheadSec;
}

/** Default canvas file picker: image + AV + JSON (.lot = Bodymovin JSON alias). */
export const CANVAS_MEDIA_FILE_ACCEPT =
  'image/*,video/*,audio/*,.json,.lot,application/json';

/** File input accept when timeline focus blocks AV (image + JSON only). */
export const WORKBENCH_IMAGE_JSON_FILE_ACCEPT =
  'image/png,image/jpeg,image/jpg,image/webp,image/gif,image/svg+xml,application/json,.png,.jpg,.jpeg,.webp,.gif,.svg,.json,.lot';

/** Bodymovin JSON / `.lot` text — not binary `.lottie` (zip). */
export function isLottieJsonFile(file: { name?: string; type?: string } | null | undefined): boolean {
  if (!file) return false;
  const mime = String(file.type || '').toLowerCase();
  const name = String(file.name || '');
  if (/\.lottie$/i.test(name)) return false;
  return (
    mime === 'application/json' ||
    mime === 'text/json' ||
    mime === 'text/plain' ||
    /\.(json|lot)$/i.test(name)
  );
}

/**
 * React-friendly accept string: pass timeline-open from the editor store (`lottieTimelinePanel`).
 * Prefer this over reading the module focus flag (does not trigger re-render).
 */
export function mediaFileAcceptForWorkbenchTimeline(timelineOpen: boolean): string {
  return timelineOpen ? WORKBENCH_IMAGE_JSON_FILE_ACCEPT : CANVAS_MEDIA_FILE_ACCEPT;
}

export const AV_BLOCKED_IN_WORKBENCH_I18N = 'editor.animation.noAvInWorkbench';
export const AV_BLOCKED_IN_WORKBENCH_DEFAULT =
  '动画时间轴模式下不支持视频/音频，请使用图片或 JSON';

export const ARTBOARD_BLOCKED_IN_WORKBENCH_I18N = 'editor.animation.noArtboardInWorkbench';
export const ARTBOARD_BLOCKED_IN_WORKBENCH_DEFAULT =
  '动画时间轴模式下不能新建普通画板，请在当前工作台内绘制或上传';

export const NEW_BOARD_BLOCKED_IN_WORKBENCH_I18N = 'editor.animation.noNewBoardInWorkbench';
export const NEW_BOARD_BLOCKED_IN_WORKBENCH_DEFAULT =
  '动画时间轴模式下请使用当前工作台，不要再新建动画板';

export const WORKBENCH_PREVIEW_ONLY_I18N = 'editor.animation.previewOnly';
export const WORKBENCH_PREVIEW_ONLY_DEFAULT =
  '工作台预览中：请先打开关键帧时间轴再编辑内部元素';

function isAnimationPlateKind(kind: unknown): boolean {
  return String(kind || '') === 'animation';
}

function isAnimationFrameHostAttrs(
  attrs: Record<string, unknown> | null | undefined
): boolean {
  if (!attrs) return false;
  return attrs.animationFrameHost === true || attrs.animationFrameHost === 'true';
}

/**
 * Timeline dock open for this plate — children selectable / bindable / editable.
 * Pass frameId to check a specific workbench; omit to mean “any workbench is in edit”.
 */
export function isAnimationWorkbenchEditOpen(frameId?: string | null): boolean {
  const focus = timelineFocusFrameId;
  if (!focus) return false;
  if (frameId != null && String(frameId).trim()) {
    return focus === String(frameId).trim();
  }
  return true;
}

/** Animation plate accepts new binds / imports only while its timeline is focused. */
export function canEditAnimationWorkbenchPlate(
  frameId: string | null | undefined
): boolean {
  return isAnimationWorkbenchEditOpen(frameId);
}

/**
 * Animation / lottie workbench plate with timeline closed — main-scene preview:
 * plate stays selectable; resize must stay proportional (no free width/height).
 */
export function isAnimationWorkbenchFrameInPreview(
  document:
    | { frames?: Array<{ id?: unknown; kind?: unknown }> | null }
    | null
    | undefined,
  frameId: string | null | undefined
): boolean {
  const fid = String(frameId || '').trim();
  if (!fid || !document) return false;
  const plate = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === fid
  );
  if (!plate || !isAnimationPlateKind(plate.kind)) return false;
  return !isAnimationWorkbenchEditOpen(fid);
}

/**
 * Bound child of a 动画工作台 whose timeline is closed — visible preview only:
 * not pickable, not editable. The workbench frame itself stays selectable.
 * (LOT content editing is separate: 主场景 = plate only; click LOT tab to edit insides.)
 */
export function isAnimationWorkbenchPreviewChild(
  document:
    | { frames?: Array<{ id?: unknown; kind?: unknown }> | null }
    | null
    | undefined,
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  if (!node || !document) return false;
  if (isAnimationFrameHostAttrs(node.attrs)) return false;
  const frameId = String(node.attrs?.frameId || '').trim();
  if (!frameId) return false;
  if (isAnimationWorkbenchEditOpen(frameId)) return false;
  const plate = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === frameId
  );
  return Boolean(plate && isAnimationPlateKind(plate.kind));
}

/** Timeline focus is open — video/audio plates must not be created. */
export function isAvBlockedByAnimationWorkbenchFocus(): boolean {
  return getWorkbenchToolPolicy().avBlocked;
}

/** Timeline focus is open — world artboards / extra workbenches must not be created. */
export function isNewPlateBlockedByAnimationWorkbenchFocus(): boolean {
  return getWorkbenchToolPolicy().newPlateBlocked;
}

/**
 * UI gate: warn once and return true when AV is blocked under timeline focus.
 * Reducers use {@link isAvBlockedByAnimationWorkbenchFocus} silently.
 */
export function warnIfAvBlockedByAnimationWorkbenchFocus(
  warn: (msg: string) => void,
  t?: (key: string, opts?: { defaultValue?: string }) => string
): boolean {
  if (!getWorkbenchToolPolicy().avBlocked) return false;
  warn(
    t
      ? t(AV_BLOCKED_IN_WORKBENCH_I18N, { defaultValue: AV_BLOCKED_IN_WORKBENCH_DEFAULT })
      : AV_BLOCKED_IN_WORKBENCH_DEFAULT
  );
  return true;
}

/** UI gate: block `#` artboard / spawnAnimationBoard while a workbench timeline is focused. */
export function warnIfNewPlateBlockedByAnimationWorkbenchFocus(
  warn: (msg: string) => void,
  t?: (key: string, opts?: { defaultValue?: string }) => string,
  kind: 'artboard' | 'animationBoard' = 'artboard'
): boolean {
  if (!getWorkbenchToolPolicy().newPlateBlocked) return false;
  const key =
    kind === 'animationBoard'
      ? NEW_BOARD_BLOCKED_IN_WORKBENCH_I18N
      : ARTBOARD_BLOCKED_IN_WORKBENCH_I18N;
  const fallback =
    kind === 'animationBoard'
      ? NEW_BOARD_BLOCKED_IN_WORKBENCH_DEFAULT
      : ARTBOARD_BLOCKED_IN_WORKBENCH_DEFAULT;
  warn(t ? t(key, { defaultValue: fallback }) : fallback);
  return true;
}

export function workbenchSurroundFrameId(
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): string | null {
  const id = String(node?.attrs?.[WORKBENCH_SURROUND_ATTR] || '').trim();
  return id || null;
}

/** True → skip paint / hit-test for this node under current timeline focus. */
export function isHiddenByAnimationWorkbenchFocus(
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  if (!node) return true;
  const surround = workbenchSurroundFrameId(node);
  const frameId = String(node.attrs?.frameId || '').trim();
  const focus = timelineFocusFrameId;

  if (focus) {
    if (frameId === focus) return false;
    if (surround === focus) return false;
    return true;
  }

  // Timeline closed: surround pasteboard stays saved but invisible.
  return Boolean(surround);
}

/**
 * Bound to a clipContent plate but AABB fully outside — stale create bind
 * (pointer-down on plate, finish off-plate). Hide so they cannot ghost on the
 * main canvas as unselectable preview ink after the timeline closes.
 */
export function isBoundOutsideOwningClipPlate(
  document:
    | {
        frames?: Array<{
          id?: unknown;
          x?: unknown;
          y?: unknown;
          width?: unknown;
          height?: unknown;
          clipContent?: unknown;
          hidden?: unknown;
        }> | null;
      }
    | null
    | undefined,
  node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown> | null;
  } | null | undefined
): boolean {
  if (!document || !node) return false;
  if (isAnimationFrameHostAttrs(node.attrs)) return false;
  const frameId = String(node.attrs?.frameId || '').trim();
  if (!frameId) return false;
  const frame = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === frameId
  );
  if (!frame || frame.hidden) return false;
  if (frame.clipContent === false) return false;
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const localX = Number(node.x) || 0;
  const localY = Number(node.y) || 0;
  // frameLocal stores plate-local x/y; compare in document/world space.
  const frameLocal = String(
    (document as { coordSpace?: unknown } | null | undefined)?.coordSpace || ''
  ) === 'frameLocal';
  const left = frameLocal ? fx + localX : localX;
  const top = frameLocal ? fy + localY : localY;
  const width = Math.max(1, Number(node.width) || 1);
  const height = Math.max(1, Number(node.height) || 1);
  const fw = Math.max(1, Number(frame.width) || 1);
  const fh = Math.max(1, Number(frame.height) || 1);
  const intersects =
    left < fx + fw && left + width > fx && top < fy + fh && top + height > fy;
  return !intersects;
}

export function shouldShowArtboardInWorkbenchFocus(
  frame: { id?: unknown } | null | undefined
): boolean {
  const focus = timelineFocusFrameId;
  if (!focus) return true;
  return String(frame?.id || '') === focus;
}

/**
 * Unified frame visibility under workbench isolation.
 * Includes `frame.hidden` + timeline focus filter.
 */
export function isArtboardVisibleInDocument(
  frame: { id?: unknown; hidden?: unknown } | null | undefined
): boolean {
  if (!frame || frame.hidden) return false;
  return shouldShowArtboardInWorkbenchFocus(frame);
}

/**
 * Unified bind/edit gate: frame must be visible; animation plates also need
 * timeline focus for that plate.
 */
export function canBindToArtboard(
  frame: { id?: unknown; hidden?: unknown; kind?: unknown } | null | undefined
): boolean {
  if (!isArtboardVisibleInDocument(frame)) return false;
  const id = String(frame?.id || '').trim();
  if (!id) return false;
  if (isAnimationPlateKind(frame?.kind)) {
    return canEditAnimationWorkbenchPlate(id);
  }
  return true;
}

export type WorkbenchToolPolicy = {
  /** Timeline dock open for some workbench. */
  timelineOpen: boolean;
  /** Block video/audio plate creation. */
  avBlocked: boolean;
  /** Block new world artboard / extra workbench. */
  newPlateBlocked: boolean;
  /** `<input type=file accept>` for canvas media pickers. */
  fileAccept: string;
};

/** Single tool-gate snapshot for toolbar / drop / spawn paths. */
export function getWorkbenchToolPolicy(): WorkbenchToolPolicy {
  const timelineOpen = Boolean(timelineFocusFrameId);
  return {
    timelineOpen,
    avBlocked: timelineOpen,
    newPlateBlocked: timelineOpen,
    fileAccept: mediaFileAcceptForWorkbenchTimeline(timelineOpen),
  };
}

/**
 * Bound workbench child whose layer in/out excludes the current playhead.
 * Same rule whether the timeline dock is open or closed (playhead stays at 0
 * after exit = first frame). Pass `playheadSec` from the editor store during React render.
 */
export function isInactiveAtAnimationPlayhead(
  document: {
    frames?: Array<{ id?: unknown; fps?: unknown; kind?: unknown }> | null;
  } | null | undefined,
  node: { attrs?: Record<string, unknown> | null; key?: unknown } | null | undefined,
  playheadSec?: number
): boolean {
  if (!node || !document) return false;
  const frameId = String(node.attrs?.frameId || '').trim();
  if (!frameId) return false;

  const focus = timelineFocusFrameId;
  // Timeline focus: only trim children of the focused plate.
  // Focus cleared (dock closed): still trim animation-plate children — same gate.
  if (focus && frameId !== focus) return false;

  const plate = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === frameId
  );
  if (!plate) return false;
  const kind = String(plate.kind || '');
  if (kind !== 'animation') return false;

  if (workbenchSurroundFrameId(node)) return false;
  if (isAnimationFrameHostAttrs(node.attrs)) {
    return false;
  }

  const ip = Number(node.attrs?.lottieInFrame);
  const op = Number(node.attrs?.lottieOutFrame);
  if (!Number.isFinite(ip) && !Number.isFinite(op)) return false;

  const fps = Math.max(1, Number(plate.fps) || 30);
  const t =
    playheadSec != null && Number.isFinite(playheadSec)
      ? Math.max(0, Number(playheadSec))
      : timelinePlayheadSec;
  const frameN = secToFrame(t, fps);
  const inRange =
    (!Number.isFinite(ip) || frameN >= ip - 1e-6) &&
    (!Number.isFinite(op) || frameN < op - 1e-6);
  return !inRange;
}

/**
 * After create/bind: intersecting the focused plate → bind as workbench layer
 * (same membership as a world artboard); fully outside → surround pasteboard.
 */
export function tagCreatedNodeForWorkbenchSurround<T extends {
  deltaSetLike?: Record<string, any> | null;
  frames?: any[];
}>(doc: T, nodeId: string): T {
  const focus = timelineFocusFrameId;
  const id = String(nodeId || '').trim();
  if (!focus || !id || !doc?.deltaSetLike?.[id]) return doc;
  const node = doc.deltaSetLike[id];
  if (!node || id === 'ROOT') return doc;

  const fid = String(node.attrs?.frameId || '').trim();
  const attrs = { ...(node.attrs || {}) } as Record<string, unknown>;

  if (fid === focus) {
    if (!(WORKBENCH_SURROUND_ATTR in attrs)) return doc;
    delete attrs[WORKBENCH_SURROUND_ATTR];
    return {
      ...doc,
      deltaSetLike: {
        ...doc.deltaSetLike,
        [id]: { ...node, attrs },
      },
    };
  }

  if (fid) return doc;

  // Unbound but overlapping the open workbench → bind like a world artboard.
  // Do not leave as surround: world mesh sits under plate SVG (looks “behind”).
  const key = String(node.key || '');
  if (
    key !== 'video' &&
    key !== 'audio' &&
    !isGeneratorPlateAttrs(node.attrs) &&
    nodeIntersectsFocusedWorkbenchPlate(doc, node, focus)
  ) {
    return bindUnboundNodeToFocusedWorkbench(doc, id, focus);
  }

  if (attrs[WORKBENCH_SURROUND_ATTR] === focus) return doc;
  attrs[WORKBENCH_SURROUND_ATTR] = focus;
  return {
    ...doc,
    deltaSetLike: {
      ...doc.deltaSetLike,
      [id]: { ...node, attrs },
    },
  };
}

/** Document AABB of an unbound node vs focused workbench plate. */
function nodeIntersectsFocusedWorkbenchPlate(
  doc: { frames?: any[] | null },
  node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  },
  focus: string
): boolean {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const plate = frames.find((f: any) => String(f?.id) === focus);
  if (!plate) return false;
  const left = Number(node.x) || 0;
  const top = Number(node.y) || 0;
  const width = Math.max(1, Number(node.width) || 1);
  const height = Math.max(1, Number(node.height) || 1);
  const fx = Number(plate.x) || 0;
  const fy = Number(plate.y) || 0;
  const fw = Math.max(1, Number(plate.width) || 1);
  const fh = Math.max(1, Number(plate.height) || 1);
  return left < fx + fw && left + width > fx && top < fy + fh && top + height > fy;
}

function bindUnboundNodeToFocusedWorkbench<T extends {
  deltaSetLike?: Record<string, any> | null;
  frames?: any[];
  coordSpace?: unknown;
}>(doc: T, nodeId: string, focus: string): T {
  const node = doc.deltaSetLike?.[nodeId];
  if (!node) return doc;
  const attrs = { ...(node.attrs || {}) } as Record<string, unknown>;
  const orders = Object.values(doc.deltaSetLike || {})
    .filter((item: any) => String(item?.attrs?.frameId || '').trim() === focus)
    .map((item: any) => Number(item?.attrs?.frameOrder))
    .filter(Number.isFinite);
  attrs.frameId = focus;
  attrs.frameOrder = orders.length ? Math.max(...orders) + 1 : 0;
  delete attrs[WORKBENCH_SURROUND_ATTR];

  let nextX = Number(node.x) || 0;
  let nextY = Number(node.y) || 0;
  // Avoid importing sceneToSvg (cycle via playhead). Mirror frameLocal store.
  if (String((doc as { coordSpace?: unknown }).coordSpace || '') === 'frameLocal') {
    const plate = (Array.isArray(doc.frames) ? doc.frames : []).find(
      (f: any) => String(f?.id) === focus
    );
    if (plate) {
      nextX -= Number(plate.x) || 0;
      nextY -= Number(plate.y) || 0;
    }
  }

  return {
    ...doc,
    deltaSetLike: {
      ...doc.deltaSetLike,
      [nodeId]: { ...node, attrs, x: nextX, y: nextY },
    },
  };
}

/** Keep surround attr in sync when frame binding changes. */
export function syncWorkbenchSurroundOnFrameBind(
  attrs: Record<string, unknown>,
  nextFrameId: string | null
): Record<string, unknown> {
  const focus = timelineFocusFrameId;
  const next = { ...attrs };
  if (nextFrameId) {
    delete next[WORKBENCH_SURROUND_ATTR];
    return next;
  }
  if (focus) {
    next[WORKBENCH_SURROUND_ATTR] = focus;
  } else {
    delete next[WORKBENCH_SURROUND_ATTR];
  }
  return next;
}

/** True when attrs mark a generator plate (any media key). Avoids importing nodeCapabilities (cycle). */
function isGeneratorPlateAttrs(attrs: Record<string, unknown> | null | undefined): boolean {
  if (!attrs) return false;
  return (
    attrs.imageGenerator === true ||
    attrs.imageGenerator === 'true' ||
    attrs.videoGenerator === true ||
    attrs.videoGenerator === 'true' ||
    attrs.audioGenerator === true ||
    attrs.audioGenerator === 'true' ||
    attrs.lottieGenerator === true ||
    attrs.lottieGenerator === 'true'
  );
}

/**
 * Bind into the focused plate when geometry intersects; otherwise mark surround.
 * Call after spawning nodes while the timeline is open — otherwise they have
 * neither frameId nor surround and are paint-hidden by focus.
 *
 * Uses local geometry (avoids importing frameNodeBinding → circular deps).
 */
export function finalizeNodeForAnimationWorkbenchFocus<T extends {
  deltaSetLike?: Record<string, any> | null;
  frames?: any[];
}>(doc: T, nodeId: string): T {
  const id = String(nodeId || '').trim();
  const focus = timelineFocusFrameId;
  if (!focus || !id || !doc?.deltaSetLike?.[id]) return doc;
  const node = doc.deltaSetLike[id];
  if (!node || id === 'ROOT') return doc;

  const key = String(node.key || '');
  // Generators / AV stay on the workbench pasteboard (not timeline layers).
  if (key === 'video' || key === 'audio' || isGeneratorPlateAttrs(node.attrs)) {
    return tagCreatedNodeForWorkbenchSurround(doc, id);
  }

  // Intersect → bind; outside → surround. Shared with tagCreatedNodeForWorkbenchSurround.
  return tagCreatedNodeForWorkbenchSurround(doc, id);
}
