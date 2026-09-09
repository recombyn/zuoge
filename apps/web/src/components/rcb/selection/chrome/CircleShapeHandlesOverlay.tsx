/**
 * Circle / ellipse knobs: 内半径, 开始位置 (display), 弧度 / 周弧度.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useRcbCamera } from '@/components/rcb/camera/context';
import {
  clampEllipseInnerRatio,
  clampEllipseArcPercent,
  advanceEllipseArcAlong,
  ellipseArcAlongRadFromPercent,
  ellipseArcEndAngles,
  ellipseArcPercentFromAlongRad,
  ellipseArcPercentFromAttrs,
  ellipseInnerRatioFromAttrs,
  ellipseStartDegFromAttrs,
  snapEllipseInnerRatio,
  wrapAngleDelta,
} from '@/components/rcb/scene/document/sceneShapes';
import { strokeInnerClearanceScene } from '@/components/rcb/scene/document/sceneEffects';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import type { SceneBox } from '../alignGuides';
import {
  CHROME_HANDLE_VIS_PX,
  CHROME_STROKE_PX,
  ShapeHandleKnob,
  WorldScreenBadge,
  WorldSvgFrame,
  clearShapeParamPreviews,
  commitShapeParamsToKit,
  localPointToScene,
  previewShapeParamsToKit,
  radiusHandleParkScreenPx,
  radiusParkSceneForBox,
  scenePointToLocal,
  setOverlayHandleSeats,
} from './shapeHandleChrome';

const DRAG_DISTANCE_SQUARED = 16;
const KNOB_VIS_PX = CHROME_HANDLE_VIS_PX;
const KNOB_STROKE_PX = CHROME_STROKE_PX;

type DragState =
  | {
      mode: 'inner';
      startRatio: number;
      current: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      mode: 'arc';
      startPercent: number;
      current: number;
      lockSign: 1 | -1;
      alongRad: number;
      lastPointerAngle: number;
      startX: number;
      startY: number;
      moved: boolean;
    };

function CircleShapeHandlesOverlay({
  box,
  angle,
  nodeId,
  node,
  toScene,
  interactive = true,
}: {
  box: SceneBox;
  angle: number;
  nodeId: string;
  node: SceneNodeInput;
  toScene: (clientX: number, clientY: number) => { x: number; y: number };
  interactive?: boolean;
}) {
  const { t } = useTranslation();
  const camera = useRcbCamera();
  const z = Math.max(0.05, camera.zoom || 1);
  const k = 1 / z;

  const [activeKey, setActiveKey] = useState<'inner' | 'arc' | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [liveInner, setLiveInner] = useState<number | null>(null);
  const [liveArc, setLiveArc] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const seatOwnerId = `circle:${nodeId}`;

  useEffect(
    () => () => {
      setOverlayHandleSeats(seatOwnerId, null);
    },
    [seatOwnerId]
  );

  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const outerR = Math.min(rx, ry);

  const baseInner = ellipseInnerRatioFromAttrs(node?.attrs);
  const baseArc = ellipseArcPercentFromAttrs(node?.attrs);
  const startDeg = ellipseStartDegFromAttrs(node?.attrs);
  const innerRatio = liveInner ?? baseInner;
  const arcPercent = liveArc ?? baseArc;
  const isFull = Math.abs(arcPercent) >= 99.95;

  const rimInset = radiusParkSceneForBox(
    w,
    h,
    z,
    radiusHandleParkScreenPx(),
    strokeInnerClearanceScene(node)
  );
  const arcSeatR = Math.max(outerR * 0.2, outerR - rimInset);
  const { a1, mid } = ellipseArcEndAngles(arcPercent, startDeg);
  const seatOnRim = (ang: number, r: number) => ({
    x: cx + Math.cos(ang) * (rx / outerR) * r,
    y: cy + Math.sin(ang) * (ry / outerR) * r,
  });
  const innerSeatR = innerRatio > 1e-4 ? Math.max(2 * k, outerR * innerRatio) : 0;
  // Solid: 内半径 at center. Hole: on the inner rim along mid-arc.
  let innerLocal = { x: cx, y: cy };
  if (innerRatio > 1e-4) {
    const parkedInnerR = Math.max(0, innerSeatR - rimInset);
    innerLocal = seatOnRim(mid, Math.max(2 * k, parkedInnerR));
  }
  // 弧度 on the outer rim — opposite the mid when full so it won't sit on 内半径.
  const arcLocal = seatOnRim(isFull ? mid + Math.PI * 0.5 : a1, arcSeatR);

  const innerPos = localPointToScene(innerLocal.x, innerLocal.y, box, angle);
  const arcPos = localPointToScene(arcLocal.x, arcLocal.y, box, angle);

  const preview = (opts: { inner?: number; arc?: number }) => {
    const attrs: Record<string, unknown> = {};
    const live: Record<string, number> = {};
    if (opts.inner != null) {
      attrs.ellipseInnerRatio = snapEllipseInnerRatio(opts.inner);
      live.ellipseInnerRatio = attrs.ellipseInnerRatio as number;
    }
    if (opts.arc != null) {
      attrs.ellipseArcPercent = clampEllipseArcPercent(opts.arc);
      live.ellipseArcPercent = attrs.ellipseArcPercent as number;
    }
    previewShapeParamsToKit(nodeId, node, attrs, live);
  };

  useEffect(() => {
    if (!interactive) return undefined;

    const onMove = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'inner') {
        const distSq = (e.clientX - d.startX) ** 2 + (e.clientY - d.startY) ** 2;
        if (!d.moved && distSq <= DRAG_DISTANCE_SQUARED) return;
      }
      d.moved = true;

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);

      if (d.mode === 'inner') {
        const dist = Math.hypot(local.x - cx, local.y - cy);
        const next = snapEllipseInnerRatio(
          clampEllipseInnerRatio(dist / Math.max(1e-3, outerR), d.startRatio),
          { sceneDist: dist, zoom: z }
        );
        d.current = next;
        setDragValue(Math.round(next * 100));
        setLiveInner(next);
        preview({ inner: next });
        return;
      }

      const pointerAngle = Math.atan2(local.y - cy, local.x - cx);
      const delta = wrapAngleDelta(pointerAngle - d.lastPointerAngle);
      d.lastPointerAngle = pointerAngle;
      d.alongRad = advanceEllipseArcAlong(d.alongRad, delta, d.lockSign);
      const next = ellipseArcPercentFromAlongRad(d.alongRad, d.lockSign);
      d.current = next;
      setDragValue(Math.round(next * 10) / 10);
      setLiveArc(next);
      preview({ arc: next });
    };

    const onUp = () => {
      const d = dragRef.current;
      if (!d) return;
      const soft = !d.moved;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveInner(null);
      setLiveArc(null);

      if (soft) {
        clearShapeParamPreviews(nodeId, node);
        return;
      }

      commitShapeParamsToKit(nodeId, node, {
        ellipseInnerRatio:
          d.mode === 'inner' ? snapEllipseInnerRatio(d.current) : snapEllipseInnerRatio(baseInner),
        ellipseArcPercent:
          d.mode === 'arc' ? clampEllipseArcPercent(d.current) : clampEllipseArcPercent(baseArc),
        ellipseStartDeg: startDeg,
      });
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveInner(null);
      setLiveArc(null);
      clearShapeParamPreviews(nodeId, node);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [
    interactive,
    box,
    angle,
    toScene,
    cx,
    cy,
    outerR,
    z,
    baseInner,
    baseArc,
    startDeg,
    nodeId,
    node,
    w,
    h,
  ]);

  const visualSize = KNOB_VIS_PX * k;
  const stroke = KNOB_STROKE_PX * k;
  const halfVis = visualSize / 2;
  const left = box.left;
  const top = box.top;

  const innerLabel = t('editor.imageToolbar.ellipseInnerRadius', {
    defaultValue: '内半径',
  });
  const arcLabel = isFull
    ? t('editor.imageToolbar.ellipseFullArc', { defaultValue: '周弧度' })
    : t('editor.imageToolbar.arcPercent', { defaultValue: '弧度' });

  let badgePos: { x: number; y: number } | null = null;
  let badgeText = '';
  if (activeKey === 'inner' && dragValue != null) {
    badgePos = innerPos;
    badgeText = `${innerLabel} ${dragValue}%`;
  } else if (activeKey === 'arc' && dragValue != null) {
    badgePos = arcPos;
    badgeText = `${arcLabel} ${dragValue}%`;
  }

  const beginInner = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      mode: 'inner',
      startRatio: baseInner,
      current: baseInner,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setActiveKey('inner');
    setDragValue(Math.round(baseInner * 100));
    setLiveInner(baseInner);
  };

  const resetInnerSolid = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = null;
    setActiveKey(null);
    setDragValue(null);
    setLiveInner(null);
    setLiveArc(null);
    commitShapeParamsToKit(nodeId, node, {
      ellipseInnerRatio: 0,
      ellipseArcPercent: clampEllipseArcPercent(baseArc),
      ellipseStartDeg: startDeg,
    });
  };

  const beginArc = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sc = toScene(e.clientX, e.clientY);
    const local = scenePointToLocal(sc.x, sc.y, box, angle);
    const pointerAngle = Math.atan2(local.y - cy, local.x - cx);
    const startRad = (startDeg * Math.PI) / 180;
    const deltaFromStart = wrapAngleDelta(pointerAngle - startRad);
    const lockSign: 1 | -1 =
      Math.abs(baseArc) >= 99.95
        ? Math.abs(deltaFromStart) < 1e-6
          ? 1
          : deltaFromStart < 0
            ? 1
            : -1
        : baseArc < 0
          ? -1
          : 1;
    dragRef.current = {
      mode: 'arc',
      startPercent: baseArc,
      current: baseArc,
      lockSign,
      alongRad: ellipseArcAlongRadFromPercent(baseArc),
      lastPointerAngle: pointerAngle,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setActiveKey('arc');
    setDragValue(Math.round(baseArc * 10) / 10);
    setLiveArc(baseArc);
  };

  const resetArcFull = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const full = baseArc < 0 ? -100 : 100;
    dragRef.current = null;
    setActiveKey(null);
    setDragValue(null);
    setLiveInner(null);
    setLiveArc(null);
    commitShapeParamsToKit(nodeId, node, {
      ellipseInnerRatio: snapEllipseInnerRatio(baseInner),
      ellipseArcPercent: full,
      ellipseStartDeg: startDeg,
    });
  };

  type KnobSpec = {
    key: string;
    lx: number;
    ly: number;
    label: string;
    interactive: boolean;
    isActive: boolean;
    onDown?: (e: ReactPointerEvent) => void;
    onDoubleClick?: (e: ReactMouseEvent) => void;
    onEnter?: () => void;
    onLeave?: () => void;
  };

  const knobs: KnobSpec[] = [
    {
      key: 'inner',
      lx: innerLocal.x,
      ly: innerLocal.y,
      label: innerLabel,
      interactive: true,
      isActive: activeKey === 'inner',
      onDown: beginInner,
      onDoubleClick: resetInnerSolid,
    },
    {
      key: 'arc',
      lx: arcLocal.x,
      ly: arcLocal.y,
      label: arcLabel,
      interactive: true,
      isActive: activeKey === 'arc',
      onDown: beginArc,
      onDoubleClick: resetArcFull,
    },
  ];

  if (interactive && knobs.length > 0) {
    setOverlayHandleSeats(
      seatOwnerId,
      knobs.map((knob) => ({
        pickKey: `circle-${knob.key}`,
        interactive: knob.interactive,
        start: (e) => {
          if (knob.onDown) {
            knob.onDown(e as unknown as ReactPointerEvent);
          }
        },
        onDoubleClick: knob.onDoubleClick
          ? (e) => knob.onDoubleClick?.(e as unknown as ReactMouseEvent)
          : undefined,
        onEnter: knob.onEnter,
        onLeave: knob.onLeave,
      }))
    );
  } else {
    setOverlayHandleSeats(seatOwnerId, null);
  }

  return (
    <>
      <WorldSvgFrame
        left={left}
        top={top}
        width={w}
        height={h}
        angle={angle}
        pointerEvents="auto"
      >
        {knobs.map((knob) => (
          <g
            key={knob.key}
            data-circle-handle={knob.key}
            transform={`translate(${knob.lx} ${knob.ly})`}
            style={{
              // Display-only start seat still needs hit-testing for hover badge.
              pointerEvents:
                knob.interactive || knob.onEnter || knob.onLeave ? 'all' : 'none',
            }}
            onPointerDown={knob.onDown}
            onDoubleClick={knob.onDoubleClick}
            onPointerEnter={knob.onEnter}
            onPointerLeave={knob.onLeave}
          >
            <title>{knob.label}</title>
            <ShapeHandleKnob
              r={Math.max(0.01, halfVis - stroke / 2)}
              stroke={stroke}
              active={knob.isActive}
              activeHalo={2 * k}
            />
          </g>
        ))}
      </WorldSvgFrame>
      {badgePos ? (
        <WorldScreenBadge
          text={badgeText}
          x={badgePos.x}
          y={badgePos.y}
          inv={k}
          anchor="right"
          clearance={halfVis + 2 * k}
        />
      ) : null}
    </>
  );
}

export default CircleShapeHandlesOverlay;
