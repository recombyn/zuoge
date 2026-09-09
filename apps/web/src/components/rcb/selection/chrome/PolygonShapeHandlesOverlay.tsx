/**
 * Polygon shape handles — corner radius + sides count.
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
  DEFAULT_SHAPE_SIDES,
  shapeVertexPoints,
  sidesFromAttrs,
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
  vertexHandleParkScene,
} from './shapeHandleChrome';

const DRAG_DISTANCE_SQUARED = 16;
const SIDES_DRAG_STEP_PX = 14;
const KNOB_VIS_PX = CHROME_HANDLE_VIS_PX;
const KNOB_STROKE_PX = CHROME_STROKE_PX;

type TopSite = { x: number; y: number; ix: number; iy: number };

function topRadiusSite(
  shapeType: string,
  width: number,
  height: number,
  sides: number
): TopSite | null {
  const pts = shapeVertexPoints(shapeType, width, height, sides);
  if (!pts.length) return null;
  let top = pts[0];
  for (const p of pts) {
    if (p[1] < top[1] - 1e-6 || (Math.abs(p[1] - top[1]) <= 1e-6 && p[0] < top[0])) {
      top = p;
    }
  }
  const cx = width / 2;
  const cy = height / 2;
  let ix = cx - top[0];
  let iy = cy - top[1];
  const len = Math.hypot(ix, iy) || 1;
  return { x: top[0], y: top[1], ix: ix / len, iy: iy / len };
}

function sidesHandleLocal(
  shapeType: string,
  width: number,
  height: number,
  sides: number,
  parkScene: number
): { x: number; y: number } {
  const pts = shapeVertexPoints(shapeType, width, height, sides);
  const cx = width / 2;
  const cy = height / 2;
  if (!pts.length) {
    const park = Math.max(0, parkScene);
    return { x: width - park, y: height / 2 };
  }
  let best = pts[0];
  for (const p of pts) {
    if (p[0] > best[0] + 1e-6 || (Math.abs(p[0] - best[0]) <= 1e-6 && p[1] < best[1])) {
      best = p;
    }
  }
  let ix = cx - best[0];
  let iy = cy - best[1];
  const len = Math.hypot(ix, iy) || 1;
  const park = Math.max(0, parkScene);
  return {
    x: best[0] + (ix / len) * park,
    y: best[1] + (iy / len) * park,
  };
}

function uniformRadii(r: number): CornerRadii {
  const v = Math.max(0, Math.round(r));
  return { tl: v, tr: v, br: v, bl: v };
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
      site: TopSite;
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

function PolygonShapeHandlesOverlay({
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

  const [activeKey, setActiveKey] = useState<'radius' | 'sides' | null>(null);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [liveSides, setLiveSides] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const seatOwnerId = `poly:${nodeId}`;

  useEffect(
    () => () => {
      setOverlayHandleSeats(seatOwnerId, null);
    },
    [seatOwnerId]
  );

  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const maxR = Math.min(w, h) / 2;
  const shapeType = String(node?.attrs?.shapeType || 'polygon');
  const baseSides = sidesFromAttrs(node?.attrs);
  const sides = liveSides ?? baseSides;
  const baseRadii = clampCornerRadii(radiiFromAttrs(node?.attrs), w, h);
  const linked = isRadiusLinked(node?.attrs);
  const baseR = Math.round(
    linked
      ? (baseRadii.tl + baseRadii.tr + baseRadii.br + baseRadii.bl) / 4
      : baseRadii.tl
  );
  const radius = dragValue != null && activeKey === 'radius' ? dragValue : baseR;

  const parkScene = Math.max(2 / z, vertexHandleParkScene(z));
  const insetFor = (r: number) => {
    const maxAlong = Math.max(parkScene, maxR - 1);
    return Math.max(parkScene, Math.min(Math.max(0, Number(r) || 0), maxAlong));
  };

  const topSite = topRadiusSite(shapeType, w, h, sides);
  const radiusLocal = topSite
    ? {
        x: topSite.x + topSite.ix * insetFor(radius),
        y: topSite.y + topSite.iy * insetFor(radius),
      }
    : { x: w / 2, y: insetFor(radius) };
  const sidesLocal = sidesHandleLocal(shapeType, w, h, sides, parkScene);
  const radiusPos = localPointToScene(radiusLocal.x, radiusLocal.y, box, angle);
  const sidesPos = localPointToScene(sidesLocal.x, sidesLocal.y, box, angle);

  const previewRadii = (r: number, nextSides?: number) => {
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
        ...(nextSides != null ? { sides: nextSides } : {}),
      },
      nextSides != null ? { sides: nextSides } : undefined
    );
  };

  const radiusAlongSite = (site: TopSite, local: { x: number; y: number }) => {
    const along = (local.x - site.x) * site.ix + (local.y - site.y) * site.iy;
    return Math.max(0, Math.min(maxR, along));
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
        previewRadii(baseR, next);
        return;
      }

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);
      const rounded = Math.round(radiusAlongSite(d.site, local));
      setDragValue(rounded);
      setLiveCornerRadiusPreview({ nodeId, display: rounded, radii: uniformRadii(rounded) });
      previewRadii(rounded, sides);
    };

    const onUp = (e: globalThis.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const soft = !d.moved;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveSides(null);
      setLiveCornerRadiusPreview(null);

      if (soft) {
        clearShapeParamPreviews(nodeId, node);
        return;
      }

      if (d.mode === 'sides') {
        const delta = Math.round((d.startY - e.clientY) / SIDES_DRAG_STEP_PX);
        const next = clampShapeSides(d.startSides + delta, d.startSides);
        commitShapeParamsToKit(nodeId, node, {
          sides: clampShapeSides(next, DEFAULT_SHAPE_SIDES),
        });
        return;
      }

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);
      const rounded = Math.round(radiusAlongSite(d.site, local));
      commitShapeParamsToKit(nodeId, node, radiusAttrsForCommit(node, rounded));
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setActiveKey(null);
      setDragValue(null);
      setLiveSides(null);
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
    sides,
    maxR,
  ]);

  const visualSize = KNOB_VIS_PX * k;
  const stroke = KNOB_STROKE_PX * k;
  const halfVis = visualSize / 2;
  const left = box.left;
  const top = box.top;

  const sidesLabel = t('editor.imageToolbar.sideCount', { defaultValue: '边数' });
  const radiusLabel = t('editor.imageToolbar.cornerRadius');

  const badgePos = activeKey === 'sides' ? sidesPos : activeKey === 'radius' ? radiusPos : null;
  const badgeText =
    activeKey === 'sides'
      ? `${sidesLabel} ${dragValue ?? sides}`
      : `${radiusLabel} ${dragValue ?? radius}`;

  if (!topSite) return null;

  type KnobSpec = {
    key: 'radius' | 'sides';
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
        if (e.button !== 0 || !topSite) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'radius',
          startR: baseR,
          site: topSite,
          startX: e.clientX,
          startY: e.clientY,
          moved: false,
        };
        setActiveKey('radius');
        setDragValue(baseR);
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
        pickKey: `poly-${knob.key}`,
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
              data-poly-handle={knob.key}
              transform={`translate(${knob.lx} ${knob.ly})`}
              style={{ pointerEvents: 'all' }}
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
      {badgePos && activeKey && dragValue != null ? (
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

export default PolygonShapeHandlesOverlay;
