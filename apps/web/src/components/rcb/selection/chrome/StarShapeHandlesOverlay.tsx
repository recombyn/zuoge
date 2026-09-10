/**
 * Star shape handles — corner radius + inner ratio + sides count.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useRcbCamera } from '@/components/rcb/camera/context';
import {
  clampCornerRadii,
  cornerVertexCount,
  isRadiusLinked,
  radiiFromAttrs,
  serializeRadiusVertices,
  setLiveCornerRadiusPreview,
  type CornerRadii,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  clampShapeSides,
  clampStarInnerRatio,
  shapeVertexPoints,
  sidesFromAttrs,
  starInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
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
  scenePointToLocal,
  setOverlayHandleSeats,
} from './shapeHandleChrome';

const DRAG_DISTANCE_SQUARED = 16;
const SIDES_DRAG_STEP_PX = 14;
const KNOB_VIS_PX = CHROME_HANDLE_VIS_PX;
const KNOB_STROKE_PX = CHROME_STROKE_PX;

function uniformRadii(r: number): CornerRadii {
  const v = Math.max(0, Math.round(r));
  return { tl: v, tr: v, br: v, bl: v };
}

function rightmostOuterTip(pts: Array<[number, number]>): { x: number; y: number } {
  let best = pts[0];
  for (let i = 0; i < pts.length; i += 2) {
    const p = pts[i];
    if (p[0] > best[0] + 1e-6 || (Math.abs(p[0] - best[0]) <= 1e-6 && p[1] < best[1])) {
      best = p;
    }
  }
  return { x: best[0], y: best[1] };
}

function starSites(width: number, height: number, sides: number, innerRatio: number) {
  const pts = shapeVertexPoints('star', width, height, sides, innerRatio);
  if (pts.length < 2) return null;
  const cx = width / 2;
  const cy = height / 2;
  const top = pts[0];
  const valley = pts[1];
  let ix = cx - top[0];
  let iy = cy - top[1];
  const len = Math.hypot(ix, iy) || 1;
  ix /= len;
  iy /= len;
  let vix = cx - valley[0];
  let viy = cy - valley[1];
  const vlen = Math.hypot(vix, viy) || 1;
  vix /= vlen;
  viy /= vlen;
  const outerDist = Math.hypot(top[0] - cx, top[1] - cy) || 1;
  const tip = rightmostOuterTip(pts);
  let tix = cx - tip.x;
  let tiy = cy - tip.y;
  const tlen = Math.hypot(tix, tiy) || 1;
  tix /= tlen;
  tiy /= tlen;
  return {
    pts,
    cx,
    cy,
    top: { x: top[0], y: top[1], ix, iy },
    valley: { x: valley[0], y: valley[1], ix: vix, iy: viy },
    tip: { x: tip.x, y: tip.y, ix: tix, iy: tiy },
    outerDist,
  };
}

function radiusAttrsForCommit(
  node: SceneNodeInput,
  radius: number
): Record<string, unknown> {
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const clamped = clampCornerRadii(uniformRadii(radius), w, h);
  const count = Math.max(1, cornerVertexCount(node));
  const vertices = Array.from({ length: count }, () => Math.round(clamped.tl));
  return {
    radiusTL: clamped.tl,
    radiusTR: clamped.tr,
    radiusBR: clamped.br,
    radiusBL: clamped.bl,
    radiusLinked: 'true',
    radiusVertices: serializeRadiusVertices(vertices),
    radius: Math.round(clamped.tl),
    cornerRadius: Math.round(clamped.tl),
  };
}

type DragState =
  | {
      mode: 'radius';
      startR: number;
      site: { x: number; y: number; ix: number; iy: number };
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      mode: 'inner';
      startRatio: number;
      outerDist: number;
      cx: number;
      cy: number;
      startX: number;
      startY: number;
      moved: boolean;
    }
  | {
      mode: 'sides';
      startSides: number;
      startX: number;
      startY: number;
      moved: boolean;
    };

function StarShapeHandlesOverlay({
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

  const [activeKey, setActiveKey] = useState<'radius' | 'inner' | 'sides' | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [liveSides, setLiveSides] = useState<number | null>(null);
  const [liveInner, setLiveInner] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const seatOwnerId = `star:${nodeId}`;

  useEffect(
    () => () => {
      setOverlayHandleSeats(seatOwnerId, null);
    },
    [seatOwnerId]
  );

  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const maxR = Math.min(w, h) / 2;
  const baseSides = sidesFromAttrs(node?.attrs);
  const sides = liveSides ?? baseSides;
  const baseInner = starInnerRatioFromAttrs(node?.attrs);
  const innerRatio = liveInner ?? baseInner;
  const baseRadii = clampCornerRadii(radiiFromAttrs(node?.attrs), w, h);
  const linked = isRadiusLinked(node?.attrs);
  const baseR = Math.round(
    linked
      ? (baseRadii.tl + baseRadii.tr + baseRadii.br + baseRadii.bl) / 4
      : baseRadii.tl
  );
  const radius = dragValue != null && activeKey === 'radius' ? dragValue : baseR;

  const sites = starSites(w, h, sides, innerRatio);
  // Radius rides the fillet; at 0 all knobs sit on exact vertices (no tuck).
  const insetFor = (r: number) => {
    const along = Math.max(0, Number(r) || 0);
    return Math.min(along, Math.max(0, maxR - 1));
  };

  let radiusLocal = { x: w / 2, y: insetFor(radius) };
  let innerLocal = { x: w * 0.65, y: h * 0.35 };
  let sidesLocal = { x: w, y: h / 2 };
  if (sites) {
    radiusLocal = {
      x: sites.top.x + sites.top.ix * insetFor(radius),
      y: sites.top.y + sites.top.iy * insetFor(radius),
    };
    // Inner-ratio sits on the valley tip.
    innerLocal = {
      x: sites.valley.x,
      y: sites.valley.y,
    };
    // Vertex-count sits on the rightmost outer tip.
    sidesLocal = {
      x: sites.tip.x,
      y: sites.tip.y,
    };
  }

  const radiusPos = localPointToScene(radiusLocal.x, radiusLocal.y, box, angle);
  const innerPos = localPointToScene(innerLocal.x, innerLocal.y, box, angle);
  const sidesPos = localPointToScene(sidesLocal.x, sidesLocal.y, box, angle);

  const preview = (opts: { r?: number; sides?: number; inner?: number }) => {
    const r = opts.r ?? radius;
    const nextSides = opts.sides ?? sides;
    const nextInner = opts.inner ?? innerRatio;
    const radii = uniformRadii(r);
    previewShapeParamsToKit(
      nodeId,
      node,
      {
        radiusTL: radii.tl,
        radiusTR: radii.tr,
        radiusBR: radii.br,
        radiusBL: radii.bl,
        radiusLinked: 'true',
        radiusVertices: serializeRadiusVertices(
          Array.from({ length: Math.max(1, cornerVertexCount(node)) }, () =>
            Math.round(radii.tl)
          )
        ),
        radius: Math.round(radii.tl),
        cornerRadius: Math.round(radii.tl),
        sides: nextSides,
        starInnerRatio: nextInner,
      },
      {
        ...(opts.sides != null ? { sides: nextSides } : {}),
        ...(opts.inner != null ? { starInnerRatio: nextInner } : {}),
      }
    );
  };

  useEffect(() => {
    if (!interactive) return undefined;

    const onMove = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const distSq = (e.clientX - d.startX) ** 2 + (e.clientY - d.startY) ** 2;
      if (!d.moved && distSq <= DRAG_DISTANCE_SQUARED) return;
      d.moved = true;

      if (d.mode === 'sides') {
        const delta = Math.round((d.startY - e.clientY) / SIDES_DRAG_STEP_PX);
        const next = clampShapeSides(d.startSides + delta, d.startSides);
        setDragValue(next);
        setLiveSides(next);
        preview({ sides: next });
        return;
      }

      if (d.mode === 'inner') {
        const sc = toScene(e.clientX, e.clientY);
        const local = scenePointToLocal(sc.x, sc.y, box, angle);
        const dist = Math.hypot(local.x - d.cx, local.y - d.cy);
        const next = clampStarInnerRatio(dist / Math.max(1e-3, d.outerDist), d.startRatio);
        setDragValue(Math.round(next * 100));
        setLiveInner(next);
        preview({ inner: next });
        return;
      }

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);
      const along = (local.x - d.site.x) * d.site.ix + (local.y - d.site.y) * d.site.iy;
      const rounded = Math.max(0, Math.min(maxR, Math.round(along)));
      setDragValue(rounded);
      setLiveCornerRadiusPreview({ nodeId, display: rounded, radii: uniformRadii(rounded) });
      preview({ r: rounded });
    };

    const onUp = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const soft = !d.moved;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveSides(null);
      setLiveInner(null);
      setLiveCornerRadiusPreview(null);

      if (soft) {
        clearShapeParamPreviews(nodeId, node);
        return;
      }

      if (d.mode === 'sides') {
        const delta = Math.round((d.startY - e.clientY) / SIDES_DRAG_STEP_PX);
        const next = clampShapeSides(d.startSides + delta, d.startSides);
        commitShapeParamsToKit(nodeId, node, { sides: next });
        return;
      }

      if (d.mode === 'inner') {
        const sc = toScene(e.clientX, e.clientY);
        const local = scenePointToLocal(sc.x, sc.y, box, angle);
        const dist = Math.hypot(local.x - d.cx, local.y - d.cy);
        const next = clampStarInnerRatio(dist / Math.max(1e-3, d.outerDist), d.startRatio);
        commitShapeParamsToKit(nodeId, node, { starInnerRatio: next });
        return;
      }

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);
      const along = (local.x - d.site.x) * d.site.ix + (local.y - d.site.y) * d.site.iy;
      const rounded = Math.max(0, Math.min(maxR, Math.round(along)));
      commitShapeParamsToKit(nodeId, node, radiusAttrsForCommit(node, rounded));
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveSides(null);
      setLiveInner(null);
      setLiveCornerRadiusPreview(null);
      clearShapeParamPreviews(nodeId, node);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('keydown', onKey);
      setLiveCornerRadiusPreview(null);
    };
  }, [
    interactive,
    nodeId,
    node,
    box,
    angle,
    toScene,
    baseR,
    baseSides,
    baseInner,
    sides,
    innerRatio,
    radius,
    maxR,
  ]);

  const visualSize = KNOB_VIS_PX * k;
  const stroke = KNOB_STROKE_PX * k;
  const halfVis = visualSize / 2;
  const left = box.left;
  const top = box.top;

  const radiusLabel = t('editor.imageToolbar.cornerRadius');
  const innerLabel = t('editor.imageToolbar.innerRadius', { defaultValue: '内角半径' });
  const sidesLabel = t('editor.imageToolbar.vertexCount', { defaultValue: '顶点' });

  let badgePos: { x: number; y: number } | null = null;
  let badgeText = '';
  if (activeKey && dragValue != null) {
    if (activeKey === 'radius') {
      badgePos = radiusPos;
      badgeText = `${radiusLabel} ${dragValue}`;
    } else if (activeKey === 'inner') {
      badgePos = innerPos;
      badgeText = `${innerLabel} ${dragValue}%`;
    } else {
      badgePos = sidesPos;
      badgeText = `${sidesLabel} ${dragValue}`;
    }
  }

  if (!sites) return null;

  type KnobSpec = {
    key: 'radius' | 'inner' | 'sides';
    lx: number;
    ly: number;
    label: string;
    onDown: (e: ReactPointerEvent) => void;
  };

  const knobs: KnobSpec[] = [
    {
      key: 'radius',
      lx: radiusLocal.x,
      ly: radiusLocal.y,
      label: radiusLabel,
      onDown: (e) => {
        if (e.button !== 0 || !sites) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'radius',
          startR: baseR,
          site: sites.top,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        setActiveKey('radius');
        setDragValue(baseR);
      },
    },
    {
      key: 'inner',
      lx: innerLocal.x,
      ly: innerLocal.y,
      label: innerLabel,
      onDown: (e) => {
        if (e.button !== 0 || !sites) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'inner',
          startRatio: baseInner,
          outerDist: sites.outerDist,
          cx: sites.cx,
          cy: sites.cy,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        setActiveKey('inner');
        setDragValue(Math.round(baseInner * 100));
        setLiveInner(baseInner);
      },
    },
    {
      key: 'sides',
      lx: sidesLocal.x,
      ly: sidesLocal.y,
      label: sidesLabel,
      onDown: (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'sides',
          startSides: baseSides,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        setActiveKey('sides');
        setDragValue(baseSides);
        setLiveSides(baseSides);
      },
    },
  ];

  if (interactive && knobs.length > 0) {
    setOverlayHandleSeats(
      seatOwnerId,
      knobs.map((knob) => ({
        pickKey: `star-${knob.key}`,
        start: (e) => knob.onDown(e as unknown as ReactPointerEvent),
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
        {knobs.map((knob) => {
          const isActive = activeKey === knob.key;
          return (
            <g
              key={knob.key}
              data-star-handle={knob.key}
              transform={`translate(${knob.lx} ${knob.ly})`}
              style={{ pointerEvents: 'all', cursor: 'pointer' }}
              onPointerDown={knob.onDown}
            >
              <title>{knob.label}</title>
              <ShapeHandleKnob
                r={Math.max(0.01, halfVis - stroke / 2)}
                stroke={stroke}
                active={isActive}
                activeHalo={2 * k}
              />
            </g>
          );
        })}
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

export default StarShapeHandlesOverlay;
