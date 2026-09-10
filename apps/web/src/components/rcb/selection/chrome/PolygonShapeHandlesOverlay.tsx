/**
 * Polygon shape handles — corner radius + sides count.
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
  polygonCornerHandleSites,
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
} from './shapeHandleChrome';

const DRAG_DISTANCE_SQUARED = 16;
const SIDES_DRAG_STEP_PX = 14;
const KNOB_VIS_PX = CHROME_HANDLE_VIS_PX;
const KNOB_STROKE_PX = CHROME_STROKE_PX;

type TopSite = { x: number; y: number; ix: number; iy: number };

type DragState =
  | {
      mode: 'radius';
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

  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const maxR = Math.min(w, h) / 2;
  const shapeType = String(node?.attrs?.shapeType || 'polygon');
  const baseSides = sidesFromAttrs(node?.attrs);
  const sides = liveSides ?? baseSides;
  const baseRadii = clampCornerRadii(radiiFromAttrs(node?.attrs), w, h);
  const linked = isRadiusLinked(node?.attrs);
  const linkedAvg = (baseRadii.tl + baseRadii.tr + baseRadii.br + baseRadii.bl) / 4;
  const baseR = Math.round(linked ? linkedAvg : baseRadii.tl);
  const radius = activeKey === 'radius' && dragValue != null ? dragValue : baseR;

  const previewRadii = (r: number, nextSides?: number) => {
    previewShapeParamsToKit(
      nodeId,
      node,
      {
        ...linkedCornerRadiusCommitAttrs(node, r),
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
      setLiveCornerRadiusPreview({ nodeId, display: rounded, radii: uniformCornerRadii(rounded) });
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
        commitShapeParamsToKit(nodeId, node, { sides: next });
        return;
      }

      const sc = toScene(e.clientX, e.clientY);
      const local = scenePointToLocal(sc.x, sc.y, box, angle);
      const rounded = Math.round(radiusAlongSite(d.site, local));
      commitShapeParamsToKit(nodeId, node, linkedCornerRadiusCommitAttrs(node, rounded));
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

  const sites = polygonCornerHandleSites(shapeType, w, h, sides);
  if (!sites) return null;
  const topSite = sites.radius;

  // Radius knob rides the fillet; at 0 it sits on the vertex (no forced tuck).
  const insetFor = (r: number) => {
    const along = Math.max(0, Number(r) || 0);
    return Math.min(along, Math.max(0, maxR - 1));
  };
  const radiusLocal = {
    x: topSite.x + topSite.ix * insetFor(radius),
    y: topSite.y + topSite.iy * insetFor(radius),
  };
  const sidesLocal = sites.sides;
  const radiusPos = localPointToScene(radiusLocal.x, radiusLocal.y, box, angle);
  const sidesPos = localPointToScene(sidesLocal.x, sidesLocal.y, box, angle);

  const visualSize = KNOB_VIS_PX * k;
  const stroke = KNOB_STROKE_PX * k;
  const halfVis = visualSize / 2;
  const left = box.left;
  const top = box.top;

  const sidesLabel = t('editor.imageToolbar.sideCount', { defaultValue: '边数' });
  const radiusLabel = t('editor.imageToolbar.cornerRadius');

  let badgePos: { x: number; y: number } | null = null;
  let badgeText = '';
  if (activeKey === 'sides') {
    badgePos = sidesPos;
    badgeText = `${sidesLabel} ${dragValue ?? sides}`;
  } else if (activeKey === 'radius') {
    badgePos = radiusPos;
    badgeText = `${radiusLabel} ${dragValue ?? radius}`;
  }

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
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragRef.current = {
          mode: 'radius',
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
