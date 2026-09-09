/**
 * Slim selection chrome helpers for on-canvas parametric shape handles (Kit canvas).
 */
import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getShapeBaselineD } from '@/components/rcb/core/geometry';
import { pushParametricOutlineToKit } from '@/components/rcb/canvas/kitBridge';
import {
  patchLiveShapeParamsPreview,
  setLiveShapeParamsPreview,
  type LiveShapeParamsPreview,
} from '@/components/rcb/scene/document/sceneShapes';
import { setLiveCornerRadiusPreview } from '@/components/rcb/scene/document/sceneRadii';
import { patchDocumentNode } from '@/store/modules/editor';
import { getSceneSmartGuidesMount } from '@/components/rcb/shapes/shapeHostRegistry';
import type { SceneBox } from '../alignGuides';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { CHROME_STROKE_PX, SELECTION_ACCENT_HEX } from '../chromeMetrics';

export { CHROME_STROKE_PX };
export const CHROME_HANDLE_VIS_PX = 8;

const CHROME_HANDLE_HIT_PX = 24;
const CHROME_RADIUS_HIT_PX = 22;
const CHROME_RADIUS_PARK_GAP_PX = 12;
const CHROME_STROKE_L_CLEAR_MAX_SCREEN_PX = 40;

function strokeInnerForRadiusParkScene(strokeInnerScene: number, zoom: number): number {
  const outer = Math.max(0, Number(strokeInnerScene) || 0);
  if (!(outer > 0)) return 0;
  const z = Math.max(0.05, Number(zoom) || 1);
  const maxScene = CHROME_STROKE_L_CLEAR_MAX_SCREEN_PX / z;
  return Math.min(outer, maxScene);
}

export function radiusHandleParkScreenPx(): number {
  return CHROME_HANDLE_HIT_PX / 2 + CHROME_RADIUS_HIT_PX / 2 + CHROME_RADIUS_PARK_GAP_PX;
}

/** Small tuck from a vertex so the knob sits on-ink (star/polygon tips). */
export function vertexHandleParkScene(zoom: number): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  return (CHROME_HANDLE_VIS_PX / 2) / z;
}

export function radiusParkSceneForBox(
  boxW: number,
  boxH: number,
  zoom: number,
  parkPx = radiusHandleParkScreenPx(),
  strokeInnerScene = 0
): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  const half = Math.min(Math.max(1, boxW), Math.max(1, boxH)) / 2;
  const fromScreen = Math.max(0, parkPx) / z;
  const total = fromScreen + strokeInnerForRadiusParkScene(strokeInnerScene, z);
  return Math.min(total, half * 0.45);
}

export type OverlayHandleSeat = {
  pickKey: string;
  interactive?: boolean;
  start: (e: globalThis.PointerEvent) => void;
  onDoubleClick?: (e: globalThis.MouseEvent) => void;
  onEnter?: () => void;
  onLeave?: () => void;
};

/** Seat contention unused with Kit — keep API for overlay compile. */
export function setOverlayHandleSeats(_ownerId: string, _seats: OverlayHandleSeat[] | null): void {}

export function scenePointToLocal(
  sceneX: number,
  sceneY: number,
  box: SceneBox,
  angleDeg: number
): { x: number; y: number } {
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = sceneX - cx;
  const dy = sceneY - cy;
  if (Math.abs(angleDeg) < 0.001) {
    return { x: dx + box.width / 2, y: dy + box.height / 2 };
  }
  const rad = (-angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: dx * cos - dy * sin + box.width / 2,
    y: dx * sin + dy * cos + box.height / 2,
  };
}

export function localPointToScene(
  lx: number,
  ly: number,
  box: SceneBox,
  angleDeg: number
): { x: number; y: number } {
  const cx = box.width / 2;
  const cy = box.height / 2;
  const dx = lx - cx;
  const dy = ly - cy;
  if (Math.abs(angleDeg) < 0.001) {
    return { x: box.left + lx, y: box.top + ly };
  }
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return {
    x: box.left + cx + dx * cos - dy * sin,
    y: box.top + cy + dx * sin + dy * cos,
  };
}

export function previewShapeParamsToKit(
  nodeId: string,
  node: SceneNodeInput,
  attrsPatch: Record<string, unknown>,
  livePatch?: Partial<Omit<LiveShapeParamsPreview, 'nodeId'>>
): SceneNodeInput {
  const shapeType = node?.attrs?.shapeType;
  const mergedAttrs = {
    ...(node?.attrs || {}),
    ...(shapeType != null ? { shapeType } : {}),
    ...attrsPatch,
  };
  const previewNode = { ...node, attrs: mergedAttrs } as SceneNodeInput;
  const d = getShapeBaselineD(previewNode);
  const withPath = d
    ? ({ ...previewNode, attrs: { ...mergedAttrs, path: d } } as SceneNodeInput)
    : previewNode;
  if (livePatch && Object.keys(livePatch).length > 0) {
    patchLiveShapeParamsPreview(nodeId, livePatch);
  }
  pushParametricOutlineToKit(nodeId, withPath);
  return withPath;
}

export function clearShapeParamPreviews(nodeId: string, node: SceneNodeInput) {
  setLiveShapeParamsPreview(null);
  setLiveCornerRadiusPreview(null);
  pushParametricOutlineToKit(nodeId, node);
}

export function commitShapeParamsToKit(
  nodeId: string,
  node: SceneNodeInput,
  attrsPatch: Record<string, unknown>,
  skipHistory?: boolean
) {
  const shapeType = node?.attrs?.shapeType;
  const mergedAttrs = {
    ...(node?.attrs || {}),
    ...(shapeType != null ? { shapeType } : {}),
    ...attrsPatch,
  };
  const previewNode = { ...node, attrs: mergedAttrs } as SceneNodeInput;
  const d = getShapeBaselineD(previewNode);
  const nextAttrs = {
    ...(shapeType != null ? { shapeType } : {}),
    ...attrsPatch,
    ...(d ? { path: d } : {}),
  };
  patchDocumentNode({
    nodeId,
    skipHistory: Boolean(skipHistory),
    patch: { attrs: nextAttrs },
  });
  pushParametricOutlineToKit(nodeId, {
    ...node,
    attrs: { ...(node?.attrs || {}), ...nextAttrs },
  } as SceneNodeInput);
  setLiveShapeParamsPreview(null);
  setLiveCornerRadiusPreview(null);
}

export function WorldSvgFrame({
  left,
  top,
  width,
  height,
  angle = 0,
  zClass = 'z-[28]',
  pointerEvents = 'none',
  children,
}: {
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
  zClass?: string;
  pointerEvents?: 'none' | 'auto';
  children: ReactNode;
}) {
  const mount = getSceneSmartGuidesMount();
  if (!mount) return null;

  const cx = width / 2;
  const cy = height / 2;

  return createPortal(
    <div
      data-rcb-shape-handles="1"
      className={`absolute ${zClass}`}
      style={{
        left,
        top,
        width,
        height,
        pointerEvents: 'none',
        transform: Math.abs(angle) > 0.001 ? `rotate(${angle}deg)` : undefined,
        transformOrigin: `${cx}px ${cy}px`,
      }}
    >
      <svg
        width={width}
        height={height}
        className="overflow-visible"
        style={{ display: 'block', pointerEvents: 'none', overflow: 'visible' }}
        aria-hidden
      >
        <g style={{ pointerEvents: pointerEvents === 'none' ? 'none' : 'auto' }}>
          {children}
        </g>
      </svg>
    </div>,
    mount
  );
}

export function WorldScreenBadge({
  text,
  x,
  y,
  inv,
  anchor = 'right',
  fill = SELECTION_ACCENT_HEX,
  clearance = 0,
}: {
  text: string;
  x: number;
  y: number;
  inv: number;
  anchor?: 'center' | 'below' | 'above' | 'right';
  fill?: string;
  clearance?: number;
}) {
  const mount = getSceneSmartGuidesMount();
  if (!mount) return null;

  const fontSize = 11 * inv;
  const padX = 5.5 * inv;
  const padY = 2.25 * inv;
  const radius = 4 * inv;
  const gap = Math.max(6 * inv, clearance);
  const tw = Math.max(14 * inv, String(text).length * fontSize * 0.62);
  const th = fontSize * 1.2;
  const w = tw + padX * 2;
  const h = th + padY * 2;
  const cx = anchor === 'right' ? x + gap + w / 2 : x;
  const cy = anchor === 'below' ? y + gap + h / 2 : anchor === 'above' ? y - gap - h / 2 : y;

  return createPortal(
    <div
      style={{
        position: 'absolute',
        left: cx - w / 2,
        top: cy - h / 2,
        width: w,
        height: h,
        borderRadius: radius,
        background: fill,
        color: '#fff',
        fontSize,
        fontWeight: 600,
        fontFamily: 'system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {text}
    </div>,
    mount
  );
}

export function ShapeHandleKnob({
  r,
  stroke,
  active,
  activeHalo,
  hitR,
}: {
  r: number;
  stroke: number;
  active: boolean;
  activeHalo: number;
  /** Invisible hit pad (scene units). Defaults to ~3× visual radius. */
  hitR?: number;
}) {
  // Reference chrome: white disc + blue ring (bbox squares stay solid blue).
  const pad = hitR ?? Math.max(r * 3, r + stroke * 4);
  return (
    <>
      <circle r={pad} fill="transparent" style={{ pointerEvents: 'all' }} />
      <circle
        r={Math.max(0.01, r)}
        fill={active ? SELECTION_ACCENT_HEX : '#ffffff'}
        stroke={SELECTION_ACCENT_HEX}
        strokeWidth={stroke}
        style={{ pointerEvents: 'none' }}
      />
      {active ? (
        <circle
          r={Math.max(0.01, r + stroke)}
          fill="none"
          stroke="rgba(0,162,255,0.35)"
          strokeWidth={activeHalo}
          style={{ pointerEvents: 'none' }}
        />
      ) : null}
    </>
  );
}
