import { useEffect, useRef, useState, memo } from 'react';
import { createPortal } from 'react-dom';
import {
  brushPad,
  brushSize,
  DEFAULT_PENCIL_BRUSH_ID,
  findPencilBrush,
  interpolateStrokeGaps,
  outlinePathFromPoints,
  pencilSampleMinStep,
  pencilSimplifyEpsilon,
  polylinePathD,
  serializePathPressures,
  simplifyPencilCenterline,
  STROKE_GAP_INTERP,
  type PencilBrushId,
} from './pencilBrushes';
import { snapStrokeOctant } from './ShapeDrawFeature';
import {
  rcbCameraCssZoom,
  rcbCameraScreenOffset,
  rcbResolveViewportEl,
  rcbScreenToScene,
  rcbViewportMetrics,
} from '../core/math';
import {
  useRcbCamera,
  useRcbViewportEl,
} from '../camera/context';
import {
  type RcbCamera as CanvasCamera,
} from '../core/types';
import {
  getShapeHost,
  getSceneDrawPreviewMount,
  getSceneWorldEpoch,
  subscribeShapeHosts,
} from '../shapes/shapeHostRegistry';

type SceneBox = { left: number; top: number; width: number; height: number };

type PencilPreview = {
  box: SceneBox;
  pathD: string;
  color: string;
  opacity: number;
  fillEnabled: boolean;
  outlineStrokeWidth: number;
  outlineStrokeColor: string;
};

import pencilCursorUrl from '@/assets/svg/editor/cursor_pencil.svg?url';
import penCursorUrl from '@/assets/svg/editor/cursor_pen.svg?url';
import bucketCursorUrl from '@/assets/svg/editor/cursor_bucket.svg?url';

/** CSS cursors — icons in `assets/svg/editor/cursor_*.svg` (hotspot = tip). */
export const PENCIL_CURSOR = `url("${pencilCursorUrl}") 2 13, crosshair`;
/** Pen nib is at viewBox (2,2) on 24→18 CSS: hotspot ≈ (1.5,1.5) → use 2 2 was ~0.5px late; 1 1 tracks the tip. */
export const PEN_CURSOR = `url("${penCursorUrl}") 1 1, crosshair`;
export const BUCKET_CURSOR = `url("${bucketCursorUrl}") 15 18, fill`;

function clientToPaperScene(
  paperEl: HTMLElement | null,
  artboard: { x?: number; y?: number; width: number; height: number },
  clientX: number,
  clientY: number
) {
  if (!paperEl) return { x: 0, y: 0 };
  const rect = paperEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return { x: 0, y: 0 };
  const w = Math.max(1, artboard.width);
  const h = Math.max(1, artboard.height);
  const ox = Number(artboard.x) || 0;
  const oy = Number(artboard.y) || 0;
  return {
    x: ox + ((clientX - rect.left) / rect.width) * w,
    y: oy + ((clientY - rect.top) / rect.height) * h,
  };
}

function clientToDrawScene(
  opts: {
    stageEl: HTMLElement | null;
    paperEl: HTMLElement | null;
    artboard: { width: number; height: number };
    camera: CanvasCamera;
  },
  clientX: number,
  clientY: number
) {
  // Prefer a *connected* stage — prop can go stale after resize remounts.
  const stage = rcbResolveViewportEl(opts.stageEl);
  if (stage) return rcbScreenToScene(opts.camera, stage, clientX, clientY);
  return clientToPaperScene(opts.paperEl, opts.artboard, clientX, clientY);
}

/** Stable scene rect covering the current viewport (for stroke preview — avoids per-point shell resize jitter). */
function visibleSceneOverlayBox(
  camera: CanvasCamera,
  stageEl: HTMLElement | null
): SceneBox | null {
  const stage = rcbResolveViewportEl(stageEl);
  if (!stage) return null;
  const { clientWidth, clientHeight } = rcbViewportMetrics(stage);
  if (!(clientWidth > 0 && clientHeight > 0)) return null;
  const z = rcbCameraCssZoom(camera);
  const { x: camX, y: camY } = rcbCameraScreenOffset(camera);
  const pad = 48 / z;
  return {
    left: (-camX) / z - pad,
    top: (-camY) / z - pad,
    width: clientWidth / z + pad * 2,
    height: clientHeight / z + pad * 2,
  };
}

function unionSceneOverlayBox(a: SceneBox, b: SceneBox): SceneBox {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  const right = Math.max(a.left + a.width, b.left + b.width);
  const bottom = Math.max(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

type PencilDrawFeatureProps = {
  enabled: boolean;
  artboard: { width: number; height: number };
  paperEl: HTMLElement | null;
  /** Full viewport stage — when set, drawing works anywhere on screen (not only SVG paper). */
  stageEl?: HTMLElement | null;
  strokeColor?: string;
  strokeWidth?: number;
  /** 0–1 preview opacity while painting. */
  strokeOpacity?: number;
  brushId?: PencilBrushId | string;
  /** Use stylus/touch pressure for width. */
  pressureEnabled?: boolean;
  onCommit: (
    pathD: string,
    box: { left: number; top: number; width: number; height: number },
    meta?: {
      pathPressure?: string;
      brushCategory?: string;
      frameId?: string | null;
      /** Baked perfect-freehand silhouette — idle ink must not re-run getStroke. */
      pencilOutlinePath?: string;
    }
  ) => string | null | void;
  hitTestFrame?: (x: number, y: number) => string | null;
};

function pointerPressure(e: PointerEvent): number | undefined {
  // Real hardware pressure only (pen / touch). Mouse always undefined → constant width.
  // Allow 0 (lightest) — do not invent speed-based pressure.
  if (e.pointerType !== 'pen' && e.pointerType !== 'touch') return undefined;
  const p = Number(e.pressure);
  if (!Number.isFinite(p)) return undefined;
  return Math.min(1, Math.max(0, p));
}

/** Freehand pencil → store baseline centerline; paint filled ink centered on that path. */
function PencilDrawFeature({
  enabled,
  artboard,
  paperEl,
  stageEl = null,
  strokeColor = '#333333',
  strokeWidth = 10,
  strokeOpacity = 1,
  brushId = DEFAULT_PENCIL_BRUSH_ID,
  pressureEnabled = true,
  onCommit,
  hitTestFrame,
}: PencilDrawFeatureProps) {
  const camera = useRcbCamera();
  const viewportEl = useRcbViewportEl();
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const pts = useRef<{ x: number; y: number; pressure?: number }[]>([]);
  const drawing = useRef(false);
  const drawingFrameId = useRef<string | null>(null);
  /** Last pointer while drawing — Shift keyup/down can rebuild a straight stroke. */
  const lastDrawPointerRef = useRef<{
    x: number;
    y: number;
    pressure?: number;
  } | null>(null);
  /** Locked overlay viewport for the active stroke — stops per-point shell resize jitter. */
  const strokeViewBoxRef = useRef<SceneBox | null>(null);
  const redrawRafRef = useRef(0);
  const handoffRafRef = useRef(0);
  const previewEpochRef = useRef(0);
  const redrawOverlayRef = useRef<() => void>(() => {});
  const previewGroupRef = useRef<SVGGElement | null>(null);
  const previewPathRef = useRef<SVGPathElement | null>(null);
  /** Bump when shared world SVG remounts so portals retarget. */
  const [, setWorldEpoch] = useState(() => getSceneWorldEpoch());
  const lastTipPosRef = useRef<{ x: number; y: number } | null>(null);
  const brushRef = useRef(brushId);
  const widthRef = useRef(strokeWidth);
  const colorRef = useRef(strokeColor);
  const opacityRef = useRef(strokeOpacity);
  const pressureRef = useRef(false);
  brushRef.current = brushId;
  widthRef.current = strokeWidth;
  colorRef.current = strokeColor;
  opacityRef.current = Math.min(1, Math.max(0, strokeOpacity));
  pressureRef.current = pressureEnabled !== false;

  const liveStage = rcbResolveViewportEl(viewportEl, stageEl);
  const paperElRef = useRef(paperEl);
  const artboardRef = useRef(artboard);
  const liveStageRef = useRef(liveStage);
  paperElRef.current = paperEl;
  artboardRef.current = artboard;
  liveStageRef.current = liveStage;

  const toScene = (clientX: number, clientY: number) =>
    clientToDrawScene(
      {
        stageEl: liveStageRef.current,
        paperEl: paperElRef.current,
        artboard: artboardRef.current,
        camera: cameraRef.current,
      },
      clientX,
      clientY
    );
  const toSceneRef = useRef(toScene);
  toSceneRef.current = toScene;

  const pointsBounds = (
    points: Array<{ x: number; y: number }>,
    pad: number
  ) => {
    if (!points.length) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return {
      left: minX - pad,
      top: minY - pad,
      width: Math.max(1, maxX - minX + pad * 2),
      height: Math.max(1, maxY - minY + pad * 2),
    };
  };

  const ensureSvgPreviewNode = <T extends SVGElement>(
    ref: { current: T | null },
    tag: string
  ): T | null => {
    const group = previewGroupRef.current;
    if (!group) return null;
    if (!ref.current) {
      ref.current = window.document.createElementNS('http://www.w3.org/2000/svg', tag) as T;
      group.appendChild(ref.current);
    }
    return ref.current;
  };

  const clearPreview = () => {
    const group = previewGroupRef.current;
    if (!group) return;
    group.setAttribute('display', 'none');
    if (previewPathRef.current) previewPathRef.current.setAttribute('d', '');
  };

  const renderPreview = (next: PencilPreview) => {
    const group = previewGroupRef.current;
    if (!group) return;
    group.setAttribute('display', '');
    const path = ensureSvgPreviewNode(previewPathRef, 'path');
    if (path) {
      path.setAttribute('d', next.pathD);
      path.setAttribute('fill', next.fillEnabled ? next.color : 'none');
      path.setAttribute('fill-opacity', String(next.opacity));
      if (next.outlineStrokeWidth > 0) {
        path.setAttribute('stroke', next.outlineStrokeColor);
        path.setAttribute('stroke-width', String(next.outlineStrokeWidth));
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('stroke-opacity', String(next.opacity));
      } else {
        path.setAttribute('stroke', 'none');
        path.removeAttribute('stroke-width');
      }
      path.setAttribute('display', next.pathD ? '' : 'none');
    }
  };

  const redrawOverlay = () => {
    const tip = lastTipPosRef.current;
    const points = pts.current;
    const pad = Math.max(
      brushSize(findPencilBrush(brushRef.current), widthRef.current),
      8
    );
    const all: Array<{ x: number; y: number }> = [...points];
    if (tip) all.push(tip);
    const contentBox = pointsBounds(all, pad);
    if (!contentBox) {
      clearPreview();
      strokeViewBoxRef.current = null;
      return;
    }
    let box = contentBox;
    if (drawing.current) {
      let view = strokeViewBoxRef.current;
      if (!view) {
        view =
          visibleSceneOverlayBox(cameraRef.current, liveStageRef.current) ||
          unionSceneOverlayBox(contentBox, {
            left: contentBox.left - 256,
            top: contentBox.top - 256,
            width: contentBox.width + 512,
            height: contentBox.height + 512,
          });
        strokeViewBoxRef.current = view;
      } else if (
        contentBox.left < view.left ||
        contentBox.top < view.top ||
        contentBox.left + contentBox.width > view.left + view.width ||
        contentBox.top + contentBox.height > view.top + view.height
      ) {
        view = unionSceneOverlayBox(view, contentBox);
        strokeViewBoxRef.current = view;
      }
      box = view;
    }

    if (points.length < 2) {
      clearPreview();
      return;
    }
    const brush = findPencilBrush(brushRef.current);

    const pressures = points.map((p) => p.pressure);
    const hasPressure = pressures.some((p) => typeof p === 'number' && Number.isFinite(p));
    const d = outlinePathFromPoints(points, widthRef.current, brush.id, {
      pressureEnabled: true,
      simplify: false,
      pressures: hasPressure
        ? pressures.map((p) => (typeof p === 'number' && Number.isFinite(p) ? p : 0.5))
        : undefined,
    });
    renderPreview({
      box,
      pathD: d,
      color: colorRef.current,
      opacity: opacityRef.current,
      fillEnabled: brush.fillEnabled !== false,
      outlineStrokeWidth: Number(brush.outlineStrokeWidth) || 0,
      outlineStrokeColor: brush.outlineStrokeColor || colorRef.current,
    });
  };
  redrawOverlayRef.current = redrawOverlay;

  const scheduleOverlayRedraw = () => {
    if (redrawRafRef.current) return;
    redrawRafRef.current = window.requestAnimationFrame(() => {
      redrawRafRef.current = 0;
      redrawOverlayRef.current();
    });
  };

  const holdPreviewUntilCommittedPaint = (nodeId: string, epoch: number) => {
    if (handoffRafRef.current) window.cancelAnimationFrame(handoffRafRef.current);
    let attempts = 0;
    let readyFrames = 0;
    const check = () => {
      if (previewEpochRef.current !== epoch) return;
      const committedEl = getShapeHost(nodeId)?.el;
      const committedPaintReady = Boolean(
        committedEl &&
          (committedEl.querySelector?.('image') ||
            committedEl.querySelector?.(
              'path:not([data-baseline="1"]), rect, circle, ellipse'
            ))
      );
      if (committedPaintReady) readyFrames += 1;
      else readyFrames = 0;
      if (readyFrames >= 2 || attempts >= 120) {
        handoffRafRef.current = 0;
        clearPreview();
        return;
      }
      attempts += 1;
      handoffRafRef.current = window.requestAnimationFrame(check);
    };
    handoffRafRef.current = window.requestAnimationFrame(check);
  };

  const paintTipCursor = (p: { x: number; y: number } | null) => {
    if (!p) lastTipPosRef.current = null;
    if (drawing.current) return;
    redrawOverlay();
  };

  const paintPreview = (points: { x: number; y: number; pressure?: number }[]) => {
    pts.current = points;
    scheduleOverlayRedraw();
  };

  const paintTipCursorRef = useRef(paintTipCursor);
  const paintPreviewRef = useRef(paintPreview);
  const holdPreviewUntilCommittedPaintRef = useRef(holdPreviewUntilCommittedPaint);
  paintTipCursorRef.current = paintTipCursor;
  paintPreviewRef.current = paintPreview;
  holdPreviewUntilCommittedPaintRef.current = holdPreviewUntilCommittedPaint;

  useEffect(() => {
    const hitEl = rcbResolveViewportEl(viewportEl, stageEl, paperEl);
    if (!enabled || !hitEl) return undefined;

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Ignore chrome / overlays outside the canvas stage content.
      const t = e.target as Element | null;
      if (t?.closest?.('[data-sel-toolbar],[data-frame-toolbar],[data-ctx-menu],[data-image-tool-panel],[data-shape-style-panel]')) {
        return;
      }
      const p = toSceneRef.current(e.clientX, e.clientY);
      drawingFrameId.current = hitTestFrame?.(p.x, p.y) || null;
      const pressure = pressureRef.current ? pointerPressure(e) : undefined;
      previewEpochRef.current += 1;
      if (handoffRafRef.current) {
        window.cancelAnimationFrame(handoffRafRef.current);
        handoffRafRef.current = 0;
      }
      drawing.current = true;
      strokeViewBoxRef.current = null;
      lastDrawPointerRef.current = pressure != null ? { ...p, pressure } : p;
      pts.current = [pressure != null ? { ...p, pressure } : p];
      paintTipCursorRef.current(p);
      paintPreviewRef.current(pts.current);
      hitEl.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };

    // Absolute screen→scene each sample (same as pen). Delta+frozen scale drifted
    // under layout/DPR changes.
    const sampleScenePoint = (e: PointerEvent) => toSceneRef.current(e.clientX, e.clientY);

    const appendStrokePoint = (raw: {
      x: number;
      y: number;
      pressure?: number;
    }) => {
      const brush = findPencilBrush(brushRef.current);
      const minStep = pencilSampleMinStep(widthRef.current, brush);
      const last = pts.current[pts.current.length - 1];
      if (last && Math.hypot(raw.x - last.x, raw.y - last.y) < minStep) {
        return false;
      }
      const next = raw;
      // Gap fill so sparse tablet events still keep a continuous centerline.
      if (last && Math.hypot(next.x - last.x, next.y - last.y) > STROKE_GAP_INTERP) {
        const filled = interpolateStrokeGaps([last, next], STROKE_GAP_INTERP);
        for (let i = 1; i < filled.length; i += 1) pts.current.push(filled[i]);
      } else {
        pts.current.push(next);
      }
      return true;
    };

    /** Shift: keep brush ink, but centerline is one octant-snapped segment (H/V/45°). */
    const applyShiftStraightTip = (tip: {
      x: number;
      y: number;
      pressure?: number;
    }) => {
      const origin = pts.current[0];
      if (!origin) {
        pts.current = [tip];
        return;
      }
      const snapped = snapStrokeOctant(origin.x, origin.y, tip.x, tip.y, true);
      pts.current = [
        origin,
        {
          x: snapped.x1,
          y: snapped.y1,
          ...(tip.pressure != null ? { pressure: tip.pressure } : {}),
        },
      ];
    };

    const onMove = (e: PointerEvent) => {
      if (!drawing.current) {
        paintTipCursorRef.current(toSceneRef.current(e.clientX, e.clientY));
        return;
      }
      const coalesced =
        typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const events = coalesced.length ? coalesced : [e];
      let tip = pts.current[pts.current.length - 1] || toSceneRef.current(e.clientX, e.clientY);
      for (const ev of events) {
        const p = sampleScenePoint(ev);
        tip = p;
        const pressure = pressureRef.current ? pointerPressure(ev) : undefined;
        lastDrawPointerRef.current = pressure != null ? { ...p, pressure } : p;
      }

      // Shift+pencil: straight octant segment — same H/V/45° as line tool.
      if (e.shiftKey) {
        const pressure = pressureRef.current ? pointerPressure(e) : undefined;
        const straightTip = pressure != null ? { ...tip, pressure } : tip;
        applyShiftStraightTip(straightTip);
        paintTipCursorRef.current(tip);
        paintPreviewRef.current(pts.current);
        return;
      }

      let changed = false;
      for (const ev of events) {
        const p = sampleScenePoint(ev);
        tip = p;
        const pressure = pressureRef.current ? pointerPressure(ev) : undefined;
        const pt = pressure != null ? { ...p, pressure } : p;
        if (appendStrokePoint(pt)) {
          changed = true;
        }
      }
      paintTipCursorRef.current(tip);
      if (!changed) return;
      paintPreviewRef.current(pts.current);
    };

    const onMoveWhileDrawing = (e: PointerEvent) => {
      if (!drawing.current) return;
      onMove(e);
    };

    const onMoveIdle = (e: PointerEvent) => {
      if (drawing.current) return;
      paintTipCursorRef.current(toSceneRef.current(e.clientX, e.clientY));
    };

    const finishStroke = (e: PointerEvent, commit: boolean) => {
      if (!drawing.current) return;
      drawing.current = false;
      strokeViewBoxRef.current = null;
      if (redrawRafRef.current) {
        window.cancelAnimationFrame(redrawRafRef.current);
        redrawRafRef.current = 0;
      }
      try {
        hitEl.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      // Pin the last sample to the tip.
      if (pts.current.length >= 1) {
        const tip = toSceneRef.current(e.clientX, e.clientY);
        const pressure = pressureRef.current ? pointerPressure(e) : undefined;
        const tipPt = pressure != null ? { ...tip, pressure } : tip;
        lastDrawPointerRef.current = tipPt;
        if (e.shiftKey) {
          applyShiftStraightTip(tipPt);
        } else {
          const last = pts.current[pts.current.length - 1];
          if (Math.hypot(tip.x - last.x, tip.y - last.y) > 0.05) {
            pts.current.push(tipPt);
          } else {
            pts.current[pts.current.length - 1] = tipPt;
          }
        }
      }
      // Pin the final raw sample into the preview before it hands off to the
      // committed host. Clearing first caused a visible blank frame on pointerup.
      if (commit && pts.current.length >= 2) {
        redrawOverlayRef.current();
      }
      const points = pts.current;
      pts.current = [];
      lastDrawPointerRef.current = null;
      lastTipPosRef.current = null;
      if (!commit || points.length < 2) {
        clearPreview();
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      points.forEach((pt) => {
        minX = Math.min(minX, pt.x);
        minY = Math.min(minY, pt.y);
        maxX = Math.max(maxX, pt.x);
        maxY = Math.max(maxY, pt.y);
      });
      const brush = findPencilBrush(brushRef.current);
      const pad = brushPad(brush, widthRef.current);
      const originX = minX - pad;
      const originY = minY - pad;
      const local = points.map((pt) => ({
        x: pt.x - originX,
        y: pt.y - originY,
        ...(pt.pressure != null ? { pressure: pt.pressure } : {}),
      }));
      const sw = Math.max(0.5, widthRef.current);
      const pressures = pressureRef.current
        ? local.map((p) => (p.pressure != null && Number.isFinite(p.pressure) ? p.pressure : 0.5))
        : undefined;
      // Bake silhouette once at commit — idle WebGL/Canvas must not re-run getStroke.
      // Linear M/L/Z (not Q midpoints) so densify/tessellate stay cheap.
      const pencilOutlinePath = outlinePathFromPoints(local, sw, brushRef.current, {
        linecap: 'round',
        pressures,
        pressureEnabled: pressureRef.current,
        simplify: false,
        pathStyle: 'linear',
      });
      // Store a light RDP centerline for edits; silhouette is already baked.
      const size = brushSize(brush, sw);
      const stored = simplifyPencilCenterline(local, pencilSimplifyEpsilon(size));
      const d = polylinePathD(stored.length >= 2 ? stored : local);
      const pathPressure = pressureRef.current
        ? serializePathPressures(stored.length >= 2 ? stored : local)
        : undefined;
      const committedId = onCommit(
        d,
        {
          left: originX,
          top: originY,
          width: Math.max(1, maxX - minX + pad * 2),
          height: Math.max(1, maxY - minY + pad * 2),
        },
        {
          ...(pathPressure ? { pathPressure } : {}),
          ...(pencilOutlinePath ? { pencilOutlinePath } : {}),
          brushCategory: brush.category || 'basic',
          frameId: drawingFrameId.current,
        }
      );
      drawingFrameId.current = null;
      if (committedId) {
        holdPreviewUntilCommittedPaintRef.current(committedId, previewEpochRef.current);
      } else {
        clearPreview();
      }
    };

    const onUp = (e: PointerEvent) => finishStroke(e, true);
    const onCancel = (e: PointerEvent) => finishStroke(e, false);
    const onLeave = () => {
      if (!drawing.current) paintTipCursorRef.current(null);
    };

    const onShiftKey = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || !drawing.current) return;
      const tip = lastDrawPointerRef.current;
      if (!tip || pts.current.length < 1) return;
      if (e.type === 'keydown') {
        applyShiftStraightTip(tip);
        paintTipCursorRef.current(tip);
        paintPreviewRef.current(pts.current);
      }
      // keyup: keep the current two-point line; further moves resume freehand.
    };

    hitEl.addEventListener('pointerdown', onDown, true);
    hitEl.addEventListener('pointermove', onMoveIdle);
    // Window move/up while drawing — stage-only move drops samples when the
    // pointer briefly leaves / is coalesced away (feels choppy / broken).
    window.addEventListener('pointermove', onMoveWhileDrawing);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onShiftKey, true);
    window.addEventListener('keyup', onShiftKey, true);
    hitEl.addEventListener('pointerleave', onLeave);
    return () => {
      hitEl.removeEventListener('pointerdown', onDown, true);
      hitEl.removeEventListener('pointermove', onMoveIdle);
      window.removeEventListener('pointermove', onMoveWhileDrawing);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onShiftKey, true);
      window.removeEventListener('keyup', onShiftKey, true);
      hitEl.removeEventListener('pointerleave', onLeave);
      if (handoffRafRef.current) window.cancelAnimationFrame(handoffRafRef.current);
      paintTipCursorRef.current(null);
    };
  }, [enabled, stageEl, paperEl, viewportEl, onCommit]);

  useEffect(
    () =>
      subscribeShapeHosts(() => {
        setWorldEpoch((prev) => {
          const next = getSceneWorldEpoch();
          return prev === next ? prev : next;
        });
      }),
    []
  );

  if (!enabled) return null;

  const previewMount = getSceneDrawPreviewMount();

  if (!previewMount) return null;
  return createPortal(
    <g
      ref={previewGroupRef}
      data-pencil-draw-preview
      pointerEvents="none"
      aria-hidden
      display="none"
    />,
    previewMount
  );
}

export default memo(PencilDrawFeature);
