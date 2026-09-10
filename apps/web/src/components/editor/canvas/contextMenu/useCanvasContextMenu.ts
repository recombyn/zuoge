import {
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

import { rcbResolveViewportEl, useRcbScreenToScene } from '@/components/rcb';
import type { ContextMenuState } from '@/components/rcb/selection/chrome/CanvasContextMenu';
import { parseFrameSelId } from '@/components/rcb/frames/frameSceneQuery';
import {
  setActiveFrameId,
  setFrameChromeMode,
  setMixedSelection,
  setSelectedNodeId,
  setSelectedNodeIds,
} from '@/store/modules/editor';

type UseCanvasContextMenuArgs = {
  readOnly: boolean;
  viewportEl: HTMLElement | null;
  stageEl: HTMLElement | null;
  paperEl: HTMLElement | null;
  documentRef: RefObject<any>;
  selectedIdsRef: RefObject<string[]>;
  selectedFrameIdsRef: RefObject<string[]>;
  activeFrameIdRef: RefObject<string | null>;
  hitTest: (
    x: number,
    y: number,
    opts?: { clientX?: number; clientY?: number }
  ) => string | null;
  setCtxMenu: Dispatch<SetStateAction<ContextMenuState | null>>;
};

const LONG_PRESS_MS = 520;
const LONG_PRESS_MOVE_PX = 10;
/** Open on pointercancel only if held long enough (ignore scroll aborts). */
const CANCEL_OPEN_MIN_MS = 400;
const OPEN_DEBOUNCE_MS = 400;

const CHROME_SKIP_SEL =
  '[data-sel-toolbar],[data-frame-toolbar],[data-ctx-menu],[data-export-panel],[data-crop-expand-overlay],[data-crop-expand-toolbar],[data-image-tool-panel],[data-text-inline-editor],[data-video-trim-toolbar],[data-video-playback-bar],[data-audio-playback-bar],[data-audio-trim-toolbar],[data-audio-speed-toolbar]';
const SCENE_COMPOSER_SEL =
  '[data-image-generator],[data-video-generator],[data-lottie-generator],[data-audio-generator],[data-media-quick-edit]';
/** Account / settings / any Headless UI dialog — portaled over the canvas. */
const OVERLAY_UI_SEL =
  '[role="dialog"],[data-headlessui-portal],[data-account-settings],[data-rcb-overlay]';
/** Frame / media titles — portaled under overlay but must open the canvas menu. */
const NODE_TITLE_SEL =
  '[data-rcb-node-title],[data-frame-label],[data-image-label]';

type LongPress = {
  pointerId: number;
  x: number;
  y: number;
  target: EventTarget | null;
  startedAt: number;
};

function isBogusClient(clientX: number, clientY: number) {
  return (
    !Number.isFinite(clientX) ||
    !Number.isFinite(clientY) ||
    (clientX <= 2 && clientY <= 2)
  );
}

function prefersCoarsePointer() {
  if (typeof window.matchMedia !== 'function') return false;
  return (
    window.matchMedia('(pointer: coarse)').matches ||
    window.matchMedia('(any-pointer: coarse)').matches
  );
}

function isTouchLikePointer(e: PointerEvent, coarse: boolean) {
  if (e.pointerType === 'touch' || e.pointerType === 'pen') return true;
  return e.button === 0 && coarse;
}

function isChromeTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.closest(SCENE_COMPOSER_SEL)) return false;
  return Boolean(el.closest(CHROME_SKIP_SEL));
}

/** Settings modal / floating UI above the board — must not open the canvas menu. */
function isOverlayUiTarget(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return Boolean(el.closest(OVERLAY_UI_SEL));
}

/** Frame / image / media title row (HTML chrome above the control box). */
export function isNodeTitleTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return Boolean(el.closest(NODE_TITLE_SEL));
}

/** Fallback when geometry hit misses but the pointer landed on an SVG host. */
function nodeIdFromEventTarget(target: EventTarget | null): string | null {
  const el = target as Element | null;
  if (!el?.closest) return null;
  const host = el.closest('[data-rcb-shape-id],[data-scene-node-id]');
  if (!host) return null;
  return (
    host.getAttribute('data-rcb-shape-id') ||
    host.getAttribute('data-scene-node-id') ||
    null
  );
}

export function frameIdFromEventTarget(target: EventTarget | null): string | null {
  const el = target as Element | null;
  if (!el?.closest) return null;
  const label = el.closest('[data-frame-label],[data-frame-id]');
  if (!label) return null;
  return label.getAttribute('data-frame-id');
}

function clientInElement(el: HTMLElement, clientX: number, clientY: number) {
  const r = el.getBoundingClientRect();
  return (
    clientX >= r.left &&
    clientX <= r.right &&
    clientY >= r.top &&
    clientY <= r.bottom
  );
}

function stageContainsTarget(stage: HTMLElement, target: EventTarget | null) {
  const node = target as Node | null;
  if (!node) return false;
  return node === stage || stage.contains(node);
}

/**
 * Canvas menu only for presses that actually hit the stage tree
 * (or portaled node titles above it).
 * Coords alone are wrong when a portaled dialog sits over the board.
 */
export function isCanvasGestureTarget(
  hitEl: HTMLElement,
  target: EventTarget | null
): boolean {
  // Titles live under [data-rcb-overlay] via RcbOverlayPortal — still canvas chrome.
  if (isNodeTitleTarget(target)) return true;
  if (isOverlayUiTarget(target) || isChromeTarget(target)) return false;
  return stageContainsTarget(hitEl, target);
}

function findFrameIdAtScene(
  frames: any[] | undefined,
  sceneX: number,
  sceneY: number
): string | null {
  if (!Array.isArray(frames)) return null;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const f = frames[i];
    if (!f || f.hidden) continue;
    const fx = Number(f.x) || 0;
    const fy = Number(f.y) || 0;
    const fw = Math.max(1, Number(f.width) || 1);
    const fh = Math.max(1, Number(f.height) || 1);
    if (sceneX >= fx && sceneX <= fx + fw && sceneY >= fy && sceneY <= fy + fh) {
      return String(f.id);
    }
  }
  return null;
}

function selectFrameOnly(
  frameId: string
) {
  setActiveFrameId(frameId);
  setFrameChromeMode('full');
  setSelectedNodeIds([]);
  setSelectedNodeId(null);
}

function selectNodeOnly(
  nodeId: string
) {
  // Clears selectedFrameIds so soft frame highlight is not a mutation target.
  setMixedSelection({ nodeIds: [nodeId], frameIds: [] });
}

type MenuHit = {
  nodeId: string | null;
  frameId: string | null;
};

export function resolveContextMenuHit(opts: {
  sceneX: number;
  sceneY: number;
  target: EventTarget | null;
  hitTest: (
    x: number,
    y: number,
    opts?: { clientX?: number; clientY?: number }
  ) => string | null;
  clientX: number;
  clientY: number;
  frames: any[] | undefined;
  selectedIds: string[];
  activeFrameId: string | null;
}): MenuHit {
  const titleFrameId = frameIdFromEventTarget(opts.target);
  const rawHit =
    opts.hitTest(opts.sceneX, opts.sceneY, {
      clientX: opts.clientX,
      clientY: opts.clientY,
    }) || nodeIdFromEventTarget(opts.target);

  // Kit hitTest returns `__frame__:id` for plate hits — same as SelectionFeature.
  // Treating that string as a node id clears artboard selection and makes
  // 副本 / copy / cut no-op (no deltaSetLike entry).
  const frameFromHit = rawHit ? parseFrameSelId(rawHit) : null;
  if (frameFromHit) {
    return { nodeId: null, frameId: frameFromHit };
  }

  if (rawHit) {
    // Soft activeFrameId is highlight context only — never treat it as a
    // frame mutation target when the menu is opened on a scene node.
    return { nodeId: rawHit, frameId: titleFrameId };
  }
  if (titleFrameId) {
    return { nodeId: null, frameId: titleFrameId };
  }
  const sceneFrameId = findFrameIdAtScene(opts.frames, opts.sceneX, opts.sceneY);
  if (sceneFrameId) {
    return { nodeId: null, frameId: sceneFrameId };
  }
  // Empty canvas: keep a single selected node, or fall back to soft-focused frame.
  if (opts.selectedIds.length === 1) {
    return { nodeId: opts.selectedIds[0], frameId: null };
  }
  if (opts.selectedIds.length > 1) {
    return { nodeId: null, frameId: null };
  }
  return {
    nodeId: null,
    frameId: opts.activeFrameId,
  };
}

/**
 * Canvas context menu — driven only by our pointer gestures (not browser
 * `contextmenu`, whose coords are often 0/1 on touch). Native menu is suppressed.
 *
 * - mouse right button — open on pointerdown/mousedown
 * - touch / coarse — long-press at down position
 * - pointercancel after a long hold — open (browser stole the gesture)
 */
export function useCanvasContextMenu(args: UseCanvasContextMenuArgs) {
  const {
    readOnly,
    viewportEl,
    stageEl,
    paperEl,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    hitTest,
    setCtxMenu,
  } = args;
  /** Same CameraTransform path as SelectionFeature (DPR-snapped pan). */
  const toScene = useRcbScreenToScene();

  const openedAtRef = useRef(0);
  const hitTestRef = useRef(hitTest);
  const toSceneRef = useRef(toScene);
  hitTestRef.current = hitTest;
  toSceneRef.current = toScene;

  useEffect(() => {
    const hitEl = rcbResolveViewportEl(viewportEl, stageEl, paperEl);
    if (readOnly || !hitEl) return undefined;

    const coarse = prefersCoarsePointer();
    let longPressTimer: number | null = null;
    let longPress: LongPress | null = null;

    const clearLongPress = () => {
      if (longPressTimer != null) {
        window.clearTimeout(longPressTimer);
        longPressTimer = null;
      }
      longPress = null;
    };

    const openMenuAt = (clientX: number, clientY: number, target: EventTarget | null) => {
      const p = toSceneRef.current(clientX, clientY);
      const selected = [...selectedIdsRef.current];
      const selectedFrames = [...selectedFrameIdsRef.current];
      const hit = resolveContextMenuHit({
        sceneX: p.x,
        sceneY: p.y,
        target,
        hitTest: hitTestRef.current,
        clientX,
        clientY,
        frames: documentRef.current?.frames,
        selectedIds: selected,
        activeFrameId: activeFrameIdRef.current,
      });

      let menuNodeId = hit.nodeId;
      let menuFrameId = hit.frameId;
      let keepMultiFrames = selectedFrames.length > 1;
      let keepMultiNodes = selected.length > 1;

      if (hit.nodeId && !selected.includes(hit.nodeId)) {
        const boundFrame = String(
          documentRef.current?.deltaSetLike?.[hit.nodeId]?.attrs?.frameId || ''
        ).trim();
        // Artboard already selected: keep plate as the mutation target so 副本
        // duplicates the board (not a single child under the pointer).
        if (boundFrame && selectedFrames.includes(boundFrame)) {
          menuNodeId = null;
          menuFrameId = boundFrame;
        } else {
          selectNodeOnly(hit.nodeId);
          keepMultiFrames = false;
          keepMultiNodes = false;
        }
      } else if (
        !hit.nodeId &&
        hit.frameId &&
        !selectedFrames.includes(hit.frameId)
      ) {
        selectFrameOnly(hit.frameId);
        keepMultiFrames = false;
        keepMultiNodes = false;
      }

      setCtxMenu({
        clientX,
        clientY,
        sceneX: p.x,
        sceneY: p.y,
        nodeId: menuNodeId,
        frameId: menuFrameId,
        selectionNodeIds: keepMultiNodes ? selected : undefined,
        selectionFrameIds: keepMultiFrames ? selectedFrames : undefined,
      });
    };

    const tryOpen = (clientX: number, clientY: number, target: EventTarget | null) => {
      if (performance.now() - openedAtRef.current < OPEN_DEBOUNCE_MS) return;
      if (isBogusClient(clientX, clientY)) return;
      if (!clientInElement(hitEl, clientX, clientY)) return;
      if (!isCanvasGestureTarget(hitEl, target)) return;
      openedAtRef.current = performance.now();
      openMenuAt(clientX, clientY, target);
    };

    const startLongPress = (
      pointerId: number,
      x: number,
      y: number,
      target: EventTarget | null
    ) => {
      clearLongPress();
      longPress = { pointerId, x, y, target, startedAt: performance.now() };
      longPressTimer = window.setTimeout(() => {
        const lp = longPress;
        clearLongPress();
        if (!lp) return;
        tryOpen(lp.x, lp.y, lp.target);
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!longPress || longPress.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - longPress.x, e.clientY - longPress.y) > LONG_PRESS_MOVE_PX) {
        clearLongPress();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!isCanvasGestureTarget(hitEl, e.target)) {
        clearLongPress();
        return;
      }
      if (isBogusClient(e.clientX, e.clientY) || !clientInElement(hitEl, e.clientX, e.clientY)) {
        clearLongPress();
        return;
      }

      if (e.button === 2) {
        clearLongPress();
        e.preventDefault();
        e.stopPropagation();
        tryOpen(e.clientX, e.clientY, e.target);
        return;
      }

      if (e.button === 0 && isTouchLikePointer(e, coarse)) {
        startLongPress(e.pointerId, e.clientX, e.clientY, e.target);
      }
    };

    /** Some hybrid drivers skip PointerEvent button=2 but still fire MouseEvent. */
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return;
      if (!isCanvasGestureTarget(hitEl, e.target)) return;
      if (isBogusClient(e.clientX, e.clientY) || !clientInElement(hitEl, e.clientX, e.clientY)) {
        return;
      }
      clearLongPress();
      e.preventDefault();
      e.stopPropagation();
      tryOpen(e.clientX, e.clientY, e.target);
    };

    const onPointerUp = (e: PointerEvent) => {
      if (longPress && e.pointerId === longPress.pointerId) clearLongPress();
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (!longPress) return;
      if (longPress.pointerId !== e.pointerId && longPress.pointerId !== -1) return;
      const lp = longPress;
      const held = performance.now() - lp.startedAt;
      clearLongPress();
      if (held < CANCEL_OPEN_MIN_MS) return;
      tryOpen(lp.x, lp.y, lp.target);
    };

    const onContextMenu = (e: MouseEvent) => {
      const allow =
        stageContainsTarget(hitEl, e.target) ||
        isChromeTarget(e.target) ||
        isNodeTitleTarget(e.target);
      if (!allow) return;
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('pointermove', onPointerMove, { capture: true });
    window.addEventListener('pointerdown', onPointerDown, { capture: true });
    window.addEventListener('mousedown', onMouseDown, { capture: true });
    window.addEventListener('pointerup', onPointerUp, { capture: true });
    window.addEventListener('pointercancel', onPointerCancel, { capture: true });
    window.addEventListener('contextmenu', onContextMenu, { capture: true });
    return () => {
      clearLongPress();
      window.removeEventListener('pointermove', onPointerMove, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('pointerup', onPointerUp, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('contextmenu', onContextMenu, true);
    };
  }, [
    activeFrameIdRef, documentRef,
    paperEl,
    readOnly,
    selectedFrameIdsRef,
    selectedIdsRef,
    setCtxMenu,
    stageEl,
    toScene,
    viewportEl,
  ]);
}
