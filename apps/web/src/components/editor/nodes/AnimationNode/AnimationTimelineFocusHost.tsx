/**
 * Timeline focus: center the 动画工作—once in the free band above the
 * floating tools + timeline (and between side docks). Restore camera on close.
 * Fit/release is event-driven (`requestTimelineCameraFit` / Release).
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useSelector } from '@/store';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { RCB_MAX_ZOOM } from '@/components/rcb/core/math';
import {
  popSessionCamera,
  pushSessionCamera,
  type SessionCameraBandInsets,
  type SessionCameraBounds,
  type SessionCameraFitOpts,
} from '@/utils/sessionCamera';
import {
  setAnimationWorkbenchTimelineFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { getCanvasEngine } from '@/components/rcb/canvas/KitCanvasHost';
import { syncKitWorkbenchIsolation } from '@/components/rcb/canvas/kitBridge';
import {
  RCB_TIMELINE_CAMERA_FIT,
  RCB_TIMELINE_CAMERA_RELEASE,
} from '@/components/editor/sceneEvents';
import store from '@/store';

/** Fallback when the dock has not painted yet (~default dock height). */
const TIMELINE_DOCK_FALLBACK_H = 240;
/** Air between workbench and the floating tool strip. */
const BOTTOM_BAND_GAP = 40;
/** Top chrome — keep light so the board can sit higher. */
const TOP_BAND_INSET = 40;
/** Allow fit to zoom in for tiny plates; keepZoomIfLarger preserves intentional high zoom. */
const TIMELINE_FOCUS_MAX_ZOOM = RCB_MAX_ZOOM;
const TIMELINE_FOCUS_PADDING = 64;
/** Sit in the upper half of the free band (0 = top, 1 = bottom). */
const TIMELINE_FOCUS_BAND_ANCHOR_Y = 0.38;

function boundsForWorkbench(
  document: SceneDocument | null | undefined,
  nodeId: string
): SessionCameraBounds | null {
  if (!document || !nodeId) return null;
  const node = document.deltaSetLike?.[nodeId];
  const frameId = resolveAnimationFrameId(document, node);
  if (frameId) {
    const frame = (Array.isArray(document.frames) ? document.frames : []).find(
      (f: { id?: string }) => String(f?.id) === frameId
    );
    if (frame) {
      return {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1),
        height: Math.max(1, Number(frame.height) || 1),
      };
    }
  }
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  return {
    x: left,
    y: top,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

function readBottomBandInset(stageEl: HTMLElement | null): number {
  if (!stageEl) return TIMELINE_DOCK_FALLBACK_H + BOTTOM_BAND_GAP;
  const stageRect = stageEl.getBoundingClientRect();
  let chromeTop = stageRect.bottom;
  for (const sel of ['[data-tour="editor-tools"]', '[data-lottie-timeline-dock]']) {
    const el = window.document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    const top = el.getBoundingClientRect().top;
    if (Number.isFinite(top) && top < chromeTop) chromeTop = top;
  }
  const inset = Math.round(stageRect.bottom - chromeTop);
  return Math.max(TIMELINE_DOCK_FALLBACK_H, inset) + BOTTOM_BAND_GAP;
}

function toolsAreLiftedAboveDock(): boolean {
  const tools = window.document.querySelector(
    '[data-tour="editor-tools"]'
  ) as HTMLElement | null;
  const dock = window.document.querySelector(
    '[data-lottie-timeline-dock]'
  ) as HTMLElement | null;
  if (!tools || !dock) return false;
  return tools.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 2;
}

function fitOptsForWorkbench(
  stageEl: HTMLElement | null,
  bandLeftPx: number,
  bandRightPx: number
): SessionCameraFitOpts {
  const bandInsets: SessionCameraBandInsets = {
    top: TOP_BAND_INSET,
    right: Math.max(0, bandRightPx),
    bottom: readBottomBandInset(stageEl),
    left: Math.max(0, bandLeftPx),
  };
  return {
    padding: TIMELINE_FOCUS_PADDING,
    maxZoom: TIMELINE_FOCUS_MAX_ZOOM,
    // Opening 关键帧 must not collapse 1700% → 140% (old hard cap).
    keepZoomIfLarger: true,
    bandInsets,
    bandAnchorY: TIMELINE_FOCUS_BAND_ANCHOR_Y,
  };
}

function AnimationTimelineFocusHost({
  document,
  stageEl = null,
  bandLeftPx = 0,
  bandRightPx = 0,
}: {
  document: SceneDocument | null;
  stageEl?: HTMLElement | null;
  bandLeftPx?: number;
  bandRightPx?: number;
}) {
  const timelineNodeId = useSelector((s: any) =>
    String(s.editor.lottieTimelinePanel?.nodeId || '')
  );
  const open = Boolean(timelineNodeId);
  const pushedRef = useRef(false);
  const fittedForNodeRef = useRef('');
  const stageElRef = useRef(stageEl);
  const bandLeftRef = useRef(bandLeftPx);
  const bandRightRef = useRef(bandRightPx);
  const documentRef = useRef(document);
  stageElRef.current = stageEl;
  bandLeftRef.current = bandLeftPx;
  bandRightRef.current = bandRightPx;
  documentRef.current = document;

  const focusFrameId =
    open && document
      ? resolveAnimationFrameId(document, document.deltaSetLike?.[timelineNodeId])
      : null;

  // Focus only — do not depend on `document`. Open/ensure/playhead all swap the
  // document ref; re-running on each swap froze Keyframes open for large LOT plates.
  useLayoutEffect(() => {
    setAnimationWorkbenchTimelineFocus(focusFrameId);
    // Focus is module state — must push Kit visibility immediately (no doc patch).
    syncKitWorkbenchIsolation(getCanvasEngine());
    // Engine may not be ready on first layout — retry a few frames.
    let tries = 0;
    let raf = 0;
    const retry = () => {
      if (getCanvasEngine()) {
        syncKitWorkbenchIsolation(getCanvasEngine());
        return;
      }
      if (tries++ < 24) raf = window.requestAnimationFrame(retry);
    };
    raf = window.requestAnimationFrame(retry);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [focusFrameId]);

  // Unmount only — avoid A→B cleanup bouncing through null (briefly re-shows all Kit ink).
  useLayoutEffect(() => {
    return () => {
      setAnimationWorkbenchTimelineFocus(null);
      syncKitWorkbenchIsolation(getCanvasEngine());
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let raf = 0;

    const release = () => {
      if (pushedRef.current) {
        popSessionCamera();
        pushedRef.current = false;
      }
      fittedForNodeRef.current = '';
    };

    const fit = () => {
      tries = 0;
      const apply = () => {
        if (cancelled) return;
        const editor = (store.getState() as { editor?: any }).editor;
        const nodeId = String(editor?.lottieTimelinePanel?.nodeId || '').trim();
        if (!nodeId) return;
        if (fittedForNodeRef.current === nodeId && pushedRef.current) return;
        const doc =
          (editor?.document as SceneDocument | null | undefined) || documentRef.current;
        const bounds = boundsForWorkbench(doc, nodeId);
        if (!bounds) {
          if (tries++ < 16) raf = window.requestAnimationFrame(apply);
          return;
        }
        if (tries < 24) {
          const dock = window.document.querySelector('[data-lottie-timeline-dock]');
          if (!dock || !toolsAreLiftedAboveDock()) {
            tries += 1;
            raf = window.requestAnimationFrame(apply);
            return;
          }
        }
        if (pushedRef.current && fittedForNodeRef.current === nodeId) return;
        if (!pushedRef.current) {
          pushSessionCamera(
            bounds,
            fitOptsForWorkbench(stageElRef.current, bandLeftRef.current, bandRightRef.current)
          );
          pushedRef.current = true;
        }
        fittedForNodeRef.current = nodeId;
      };
      raf = window.requestAnimationFrame(apply);
    };

    const onFit = () => {
      // Ignore late afterPaint FIT that lands after the panel was closed.
      const nodeId = String(
        (store.getState() as { editor?: any }).editor?.lottieTimelinePanel?.nodeId || ''
      ).trim();
      if (!nodeId) return;
      cancelled = false;
      fit();
    };
    const onRelease = () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      release();
    };
    window.addEventListener(RCB_TIMELINE_CAMERA_FIT, onFit);
    window.addEventListener(RCB_TIMELINE_CAMERA_RELEASE, onRelease);
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener(RCB_TIMELINE_CAMERA_FIT, onFit);
      window.removeEventListener(RCB_TIMELINE_CAMERA_RELEASE, onRelease);
      setAnimationWorkbenchTimelineFocus(null);
      release();
    };
  }, []);

  return null;
}

export default memo(AnimationTimelineFocusHost);
