/**
 * Star shape handles — corner radius + inner ratio + sides count.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useRcbCamera } from '@/components/rcb/camera/context';
import {
  clampCornerRadii,
  isRadiusLinked,
  linkedCornerRadiusCommitAttrs,
  radiiFromAttrs,
  setLiveCornerRadiusPreview,
  uniformCornerRadii,
} from '@/components/rcb/scene/document/sceneRadii';
import {
  clampShapeSides,
  clampStarInnerRatio,
  sidesFromAttrs,
  starCornerHandleSites,
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

type DragState =
  | {
      mode: 'radius';
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

  const preview = (opts: { r?: number; sides?: number; inner?: number }) => {
    const r = opts.r ?? radius;
    const nextSides = opts.sides ?? sides;
    const nextInner = opts.inner ?? innerRatio;
    previewShapeParamsToKit(
      nodeId,
      node,
      {
        ...linkedCornerRadiusCommitAttrs(node, r),
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
      setLiveCornerRadiusPreview({ nodeId, display: rounded, radii: uniformCornerRadii(rounded) });
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
      commitShapeParamsToKit(nodeId, node, linkedCornerRadiusCommitAttrs(node, rounded));
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

  // Same vertices as getShapeBaselineD / Kit path — seats on true outline corners.
  const sites = starCornerHandleSites(w, h, sides, innerRatio);
  if (!sites) return null;

  // Radius rides the fillet; at 0 all knobs sit on exact vertices (no tuck).
  const insetFor = (r: number) => {
    const along = Math.max(0, Number(r) || 0);
    return Math.min(along, Math.max(0, maxR - 1));
  };
  const radiusLocal = {
    x: sites.radius.x + sites.radius.ix * insetFor(radius),
    y: sites.radius.y + sites.radius.iy * insetFor(radius),
  };
  // Inner-ratio sits on the valley adjacent to the top tip.
  const innerLocal = { x: sites.inner.x, y: sites.inner.y };
  // Vertex-count sits on the rightmost outer tip.
  const sidesLocal = { x: sites.sides.x, y: sites.sides.y };

  const radiusPos = localPointToScene(radiusLocal.x, radiusLocal.y, box, angle);
  const innerPos = localPointToScene(innerLocal.x, innerLocal.y, box, angle);
  const sidesPos = localPointToScene(sidesLocal.x, sidesLocal.y, box, angle);

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
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'radius',
          site: sites.radius,
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
        if (e.button !== 0) return;
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
