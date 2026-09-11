/**
 * Host bridge: Kit WasmScene ↔ RCB SceneDocument.
 *
 * - Kit InputManager creates / selects / transforms / clipboard natively.
 * - Mutations flush into SceneDocument (create / delete / geometry / style).
 * - Kit owns undo/redo/group for Kit-mapped nodes (undoKit / redoKit / groupKit*).
 * - Document load/reload hydrates Kit once; paste/undo reconcile membership.
 * - Selection mirrors via UIEngine.syncWithSelection → editor store (panels).
 */
import {
  createImageNode,
  createShapeNode,
  createTextNode,
  fitImageSize,
  measureImageNaturalSize,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  addArtboardFrame,
  pushEditorHistory,
  removeDocumentNodes,
  setActiveFrameId,
  setActiveTool,
  setDocumentFromCanvas,
  setMixedSelection,
  setPendingImageSrc,
  setSelectedFrameIds,
  setSelectedNodeIds,
  setSoftFrameContext,
  patchDocumentNode,
  withKitCanvasDocumentFlush,
  clearCanvasAttachPick,
  setCanvasAttachPickBlocked,
  setPendingCanvasAttach,
} from '@/store/modules/editor';
import {
  attachPickBlockedUnderHit,
  attachPickFilterOpts,
  canAttachFrameToPick,
  frameForFullBleedPlate,
  resolveAttachPickPayload,
} from '@/components/editor/canvas/attachPick';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  addNodeToDocument,
  normalizeDocument,
  removeNodesFromDocument,
  updateNodeInDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  buildMarkdownTextAttrs,
  isTextBold,
  isTextItalic,
  isTextOverline,
  isTextStrike,
  isTextUnderline,
  measurePlainTextSize,
  measureWrappedTextSize,
  parseNodeMarkdown,
  parseNodeTextStyle,
  toFabricFontFamily,
  type TextStyle,
} from '@/components/rcb/scene/document/sceneText';
import { ensureKitFontFamily, KIT_APP_TEXT_FONT } from './kitTextFonts';
import {
  getNodeTransformPreview,
  listNodeTransformPreviewIds,
} from '@/components/rcb/core/transformPreview';
import {
  parseFillGradient,
  parseFillType,
  resolveLinearCoords,
  serializeFillGradient,
  serializeShapeFillAttrs,
  type FillGradient,
  type FillImageAdjust,
  type FillImageFit,
} from '@/components/rcb/scene/document/sceneFill';
import { normalizeColor, resolveStrokeLinecap, resolveStrokeLinejoin, resolveStrokeMiterlimit } from '@/components/rcb/scene/document/sceneEffects';
import { strokeDashForStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import { store } from '@/store';
import type { CanvasEngineHandle } from './mountCore';
import {
  discardKitArtboardNoHistory,
  isKitEngineSeedArtboard,
  stripKitSeedArtboards,
} from './mountCore';
import { isPersistentDrawSessionTool } from './toolMap';
import {
  isNodeProcessRunning,
  paintKitProcessPlateLocal,
} from '@/components/rcb/process/processPlateKit';
import { listProcessingNodeIds } from '@/components/rcb/process/processGlow';
import type { WasmScene } from '@rcb-vector/wasm_scene';
import type { SceneNode as KitSceneNode } from '@rcb-vector/types';
import { isGradient, isMeshGradient, isSolid } from '@rcb-vector/types';
import { applyBooleanOp, type BoolOp } from '@rcb-vector/boolean_ops';
import { cornerRadiusHandles } from '@rcb-vector/corner_handles';
import { FRAME_SEL_PREFIX, frameSelId } from '@/components/rcb/frames/frameSceneQuery';
import { frameForNodeIntersectPlacement } from '@/components/rcb/frames/frameNodeBinding';
import { frameIsEmpty } from '@/components/rcb/frames/framePlatePointer';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import {
  isAnimationFrameHostNode,
  isArtboardVisibleInDocument,
  isAudioGeneratorNode,
  isEmptyGeneratorPlate,
  isGeneratorNode,
  isImageGeneratorNode,
  isLottieGeneratorNode,
  isNodeMarqueeSkippable,
  isNodePickableInDocument,
  isNodeStructurallyHiddenInDocument,
  isVideoGeneratorNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  isAnimationWorkbenchPreviewChild,
  registerWorkbenchIsolationSync,
  tagCreatedNodeForWorkbenchSurround,
  getAnimationWorkbenchTimelineFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { nodeSceneAabb } from '@/components/rcb/scene/layout/nodeAabb';
import { storedOriginForSceneResult } from '@/components/rcb/scene/layout/coords';
import {
  frameSceneBounds,
  isFrameLocalCoordSpace,
  nodeLeftTop,
} from '@/components/rcb/scene/layout/nodeLayout';
import {
  getLiveArtboardFrameGeometry,
  previewArtboardFrameGeometry,
} from '@/components/rcb/frames/HtmlArtboardFrame';
import {
  applyNodeFrameBindings,
  type GeomPatch,
} from '@/components/editor/canvas/canvasSession';
import {
  GEN_AUDIO_BARS,
  GEN_AUDIO_BAR_STROKE,
  GEN_IMAGE_MOUNTAIN_PATH,
  GEN_IMAGE_SUN,
  GEN_VIDEO_PLAY_PATH,
  GENERATOR_EMPTY_ICON_COLOR,
  GENERATOR_EMPTY_PLATE_STROKE,
  GENERATOR_EMPTY_PLATE_STROKE_WIDTH,
  generatorEmptyCssRgb,
  type GeneratorEmptyIconKind,
} from '@/components/rcb/core/generatorEmptyIcons';
import {
  generatorEmptyIconSize,
  generatorEmptyIconVisible,
} from '@/components/rcb/core/layout';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import { frameClipRevealsOverflow } from '@/components/rcb/selection/selectionPaintRaise';
import { getShapeBaselineD } from '@/components/rcb/core/geometry';
import { translatePathData } from '@/components/rcb/scene/document/pathScale';
import {
  ellipseArcPercentFromAttrs,
  ellipseInnerRatioFromAttrs,
  ellipseStartDegFromAttrs,
  sidesFromAttrs,
  starInnerRatioFromAttrs,
} from '@/components/rcb/scene/document/sceneShapes';
import {
  isRadiusLinked,
  maxRadius,
  radiiFromAttrs,
  uniformCornerRadii,
} from '@/components/rcb/scene/document/sceneRadii';

/** Kit→SceneDocument mirror — never triggers Kit re-hydrate / geom push-back. */
function mirrorKitDocument(doc: SceneDocument) {
  withKitCanvasDocumentFlush(() => {
    setDocumentFromCanvas(doc);
  });
}

const kitToRcb = new Map<number, string>();
const rcbToKit = new Map<string, number>();
const kitArtboardToFrame = new Map<number, string>();
const frameToKitArtboard = new Map<string, number>();

let suppressDepth = 0;
let attached: CanvasEngineHandle | null = null;
let lastHydrateKey = '';
let origSyncWithSelection: ((opts?: { interactive?: boolean; gesture?: boolean }) => void) | null =
  null;
let lastSelKey = '';
/**
 * Bumped whenever Kit writes selection into the store.
 * Host uses this to skip store→Kit echo (engine is SoT on canvas;
 * store is a one-way mirror for HTML toolbars / layers highlight).
 */
let selectionMirrorGeneration = 0;

/** Coalesce Kit→RCB flushes off the WASM call stack (avoids wasm-bindgen aliasing). */
let mutateFlushQueued = false;
/**
 * Draw-tool id captured during onMutate (still polygon/star/…) before
 * maybeRevertTool flips Kit + store to selection. flushCreates must tag
 * shapeType from this — otherwise polygons land as plain `path` and lose
 * 圆角 / 边数 chrome.
 */
let pendingCreateTool: string | null = null;
/** Kit undo/redo reconcile — update SceneDocument without pushing RCB editorHistory. */
let kitHistoryReconcile = false;
/** Kit placeImage has no src URL — remember product URL until flushCreates maps Image → RCB. */
const pendingImageSrcByKitId = new Map<number, string>();
/** Bucket image fill — Kit Live Paint has no image face fill; apply on RCB node click. */
type PendingBucketImageFill = {
  fillColor: string;
  fillOpacity: number;
  fillImageSrc: string;
  fillImageFit?: FillImageFit;
  fillImageRotate?: number;
  fillImageScale?: number;
  fillImageOffsetX?: number;
  fillImageOffsetY?: number;
  fillImageAdjust?: FillImageAdjust | Record<string, number>;
};
let pendingBucketImageFill: PendingBucketImageFill | null = null;
let origEnterPathEdit: ((nodeId: number) => void) | null = null;
let origExitEditMode: (() => void) | null = null;
let origHandlePaintBucketClick:
  | ((pos: { x: number; y: number }, wantEdge?: boolean, erase?: boolean) => void)
  | null = null;
let origOnMouseUp: ((e: MouseEvent) => void) | null = null;
let origOnMouseMove: ((e: MouseEvent) => void) | null = null;
/**
 * Occupied plate body press: Kit must marquee (not artboard-drag). Stash the
 * RCB frame so a click (no drag) can soft-select the plate like a generator.
 */
let pendingSoftArtboardFrameId: string | null = null;
/**
 * Fingerprint of which Kit-mapped nodes are artboard-clipped.
 * Clips are baked into the retained scene picture at record time — when this
 * changes (frameId bind, clipContent toggle) we must invalidateScenePicture,
 * not only requestRender (replay keeps the old clip state).
 */
let lastArtboardClipPaintSig = '';

function withSuppress<T>(fn: () => T): T {
  suppressDepth += 1;
  try {
    return fn();
  } finally {
    suppressDepth -= 1;
  }
}

function colorToCss(paint: unknown): string | null {
  if (!paint || typeof paint !== 'object') return null;
  if (!isSolid(paint as never)) return null;
  const c = paint as { r: number; g: number; b: number; a: number };
  const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
  const a = Number.isFinite(c.a) ? Math.max(0, Math.min(1, c.a)) : 1;
  if (a < 1) return `rgba(${r},${g},${b},${a})`;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function kitColorToCssHex(c: { r: number; g: number; b: number; a?: number } | null | undefined): string {
  if (!c) return '#FFFFFF';
  const r = Math.round(Math.max(0, Math.min(1, c.r)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c.g)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c.b)) * 255);
  const a = Number.isFinite(c.a) ? Math.max(0, Math.min(1, Number(c.a))) : 1;
  if (a < 1) return `rgba(${r},${g},${b},${a})`;
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function solidFillAttrs(css: string, enabled: boolean): Record<string, unknown> {
  return {
    'fill-type': 'solid',
    'fill-color': css,
    fill: css,
    'fill-enabled': enabled ? 'true' : 'false',
    'fill-visible': enabled ? 'true' : 'false',
  };
}

function kitGradientToRcbFill(
  paint: {
    gradient_type?: string;
    stops?: Array<{ offset: number; color: { r: number; g: number; b: number; a?: number } }>;
    start_x?: number;
    start_y?: number;
    end_x?: number;
    end_y?: number;
  },
  nodeW: number,
  nodeH: number
): Record<string, unknown> | null {
  const w = Math.max(1, nodeW);
  const h = Math.max(1, nodeH);
  const stops = (paint.stops || []).map((s) => ({
    offset: Math.max(0, Math.min(1, Number(s.offset) || 0)),
    color: kitColorToCssHex(s.color),
  }));
  if (stops.length < 2) return null;

  const isRadial = String(paint.gradient_type || '') === 'Radial';
  let grad: FillGradient;
  if (isRadial) {
    grad = {
      type: 'radial',
      cx: ((Number(paint.start_x) || 0) / w) * 100,
      cy: ((Number(paint.start_y) || 0) / h) * 100,
      r: Math.max(
        1,
        (Math.hypot(
          (Number(paint.end_x) || 0) - (Number(paint.start_x) || 0),
          (Number(paint.end_y) || 0) - (Number(paint.start_y) || 0)
        ) /
          Math.max(w, h)) *
          100 *
          2
      ),
      colorStops: stops,
    };
  } else {
    grad = {
      type: 'linear',
      x1: ((Number(paint.start_x) || 0) / w) * 100,
      y1: ((Number(paint.start_y) || 0) / h) * 100,
      x2: ((Number(paint.end_x) || w) / w) * 100,
      y2: ((Number(paint.end_y) || 0) / h) * 100,
      colorStops: stops,
    };
  }

  const first = stops[0]?.color || '#FFFFFF';
  return {
    'fill-type': isRadial ? 'radial' : 'linear',
    'fill-color': first,
    fill: first,
    'fill-gradient': serializeFillGradient(grad),
    'fill-enabled': 'true',
    'fill-visible': 'true',
  };
}

/** Kit node fill paint → RCB fill attrs (solid or linear/radial). Null = skip fill sync. */
function kitFillToRcbAttrs(
  paint: unknown,
  nodeW: number,
  nodeH: number
): Record<string, unknown> | null {
  if (paint == null) return solidFillAttrs('transparent', false);
  if (isGradient(paint as never)) {
    return kitGradientToRcbFill(paint as never, nodeW, nodeH);
  }
  const css = colorToCss(paint);
  if (!css) return null;
  if (css === 'transparent' || css === 'none') return solidFillAttrs(css, false);
  return solidFillAttrs(css, true);
}

function kitFillStroke(node: KitSceneNode): {
  fillPaint: unknown;
  stroke: string;
  borderWidth: number;
} {
  const fills = node.style?.fills;
  const strokes = node.style?.strokes;
  const fillPaint = fills?.[0] ?? node.style?.fill ?? null;
  const strokePaint = strokes?.[0]?.paint ?? node.style?.stroke ?? null;
  const borderWidth = Number(strokes?.[0]?.width ?? node.style?.stroke_width ?? 1) || 1;
  return {
    fillPaint,
    stroke: colorToCss(strokePaint) || '#333333',
    borderWidth,
  };
}

function subpathsToSvgD(subpaths: Array<{ points: Array<{ x: number; y: number; cp1: [number, number]; cp2: [number, number] }>; closed: boolean }>): string {
  const parts: string[] = [];
  for (const sp of subpaths || []) {
    const pts = sp.points || [];
    if (!pts.length) continue;
    const first = pts[0];
    parts.push(`M ${first.x} ${first.y}`);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const prev = pts[i - 1];
      parts.push(
        `C ${prev.cp2[0]} ${prev.cp2[1]} ${p.cp1[0]} ${p.cp1[1]} ${p.x} ${p.y}`
      );
    }
    if (sp.closed) parts.push('Z');
  }
  return parts.join(' ');
}

/** Densify one SVG elliptical arc into line samples (Kit path points lack native A). */
function densifySvgArc(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  largeArc: number,
  sweep: number,
  x2: number,
  y2: number
): Array<{ x: number; y: number }> {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-6 || ry < 1e-6) return [{ x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  let x1p = cosPhi * dx + sinPhi * dy;
  let y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  let sq =
    (rxSq * rySq - rxSq * y1pSq - rySq * x1pSq) / Math.max(1e-12, rxSq * y1pSq + rySq * x1pSq);
  sq = Math.max(0, sq);
  const sign = largeArc === sweep ? -1 : 1;
  const co = sign * Math.sqrt(sq);
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (co * (-ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const start = Math.atan2(uy, ux);
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (sweep === 0 && delta > 0) delta -= Math.PI * 2;
  if (sweep === 1 && delta < 0) delta += Math.PI * 2;
  const steps = Math.max(2, Math.ceil((Math.abs(delta) / (Math.PI * 2)) * 32));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= steps; i += 1) {
    const t = start + (delta * i) / steps;
    const px = cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi;
    const py = cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi;
    out.push({ x: px, y: py });
  }
  return out;
}

function svgDToSubpathsJson(d: string): string {
  const tokens = String(d || '')
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const mk = (x: number, y: number) => ({ x, y, cp1: [x, y] as [number, number], cp2: [x, y] as [number, number] });
  const subpaths: Array<{ points: ReturnType<typeof mk>[]; closed: boolean }> = [];
  let cur: ReturnType<typeof mk>[] = [];
  let closed = false;
  let i = 0;
  let cx = 0;
  let cy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'm') {
      if (cur.length) subpaths.push({ points: cur, closed });
      cur = [];
      closed = false;
      const x = num();
      const y = num();
      cx = cmd === 'm' ? cx + x : x;
      cy = cmd === 'm' ? cy + y : y;
      cur.push(mk(cx, cy));
    } else if (cmd === 'L' || cmd === 'l') {
      const x = num();
      const y = num();
      cx = cmd === 'l' ? cx + x : x;
      cy = cmd === 'l' ? cy + y : y;
      cur.push(mk(cx, cy));
    } else if (cmd === 'C' || cmd === 'c') {
      const x1 = num();
      const y1 = num();
      const x2 = num();
      const y2 = num();
      const x = num();
      const y = num();
      const abs = cmd === 'C';
      const p1x = abs ? x1 : cx + x1;
      const p1y = abs ? y1 : cy + y1;
      const p2x = abs ? x2 : cx + x2;
      const p2y = abs ? y2 : cy + y2;
      cx = abs ? x : cx + x;
      cy = abs ? y : cy + y;
      if (cur.length) cur[cur.length - 1].cp2 = [p1x, p1y];
      const pt = mk(cx, cy);
      pt.cp1 = [p2x, p2y];
      cur.push(pt);
    } else if (cmd === 'A' || cmd === 'a') {
      const rx = num();
      const ry = num();
      const rot = num();
      const large = num();
      const sweep = num();
      const x = num();
      const y = num();
      const endX = cmd === 'a' ? cx + x : x;
      const endY = cmd === 'a' ? cy + y : y;
      const samples = densifySvgArc(cx, cy, rx, ry, rot, large, sweep, endX, endY);
      for (const p of samples) {
        cx = p.x;
        cy = p.y;
        cur.push(mk(cx, cy));
      }
    } else if (cmd === 'Z' || cmd === 'z') {
      closed = true;
      if (cur.length) {
        subpaths.push({ points: cur, closed });
        cur = [];
        closed = false;
      }
    } else if (/^-?\d/.test(cmd)) {
      // Bare numbers after M/L — treat as L
      i -= 1;
      const x = num();
      const y = num();
      cx = x;
      cy = y;
      cur.push(mk(cx, cy));
    }
  }
  if (cur.length) subpaths.push({ points: cur, closed });
  return JSON.stringify(subpaths.length ? subpaths : [{ points: [mk(0, 0), mk(1, 1)], closed: false }]);
}

function remember(kitId: number, rcbId: string) {
  kitToRcb.set(kitId, rcbId);
  rcbToKit.set(rcbId, kitId);
}

/** Last style/effects JSON pushed per Kit id — skip identical setNodeStyleNoHistory. */
const lastKitStyleJson = new Map<number, string>();
const lastKitEffectsJson = new Map<number, string>();
/** Text content + typography fingerprint pushed RCB→Kit. */
const lastKitTextSig = new Map<number, string>();
/** Parametric outline fingerprint (sides / IR / Ar / radii) → rebuild Kit path when changed. */
const lastParametricSig = new Map<string, string>();
/**
 * Still URL last registered into Kit for an RCB raster node.
 * Video/audio must rebind when poster changes; never leave a failed mp4 decode stuck.
 */
const lastKitRasterSrc = new Map<string, string>();

function forgetKitStyle(kitId: number) {
  lastKitStyleJson.delete(kitId);
  lastKitEffectsJson.delete(kitId);
  lastKitTextSig.delete(kitId);
}

/** Kit `register_image` only accepts stills — video/audio use poster (or empty plate). */
function kitStillRasterUrl(node: SceneNodeInput): string {
  const key = String(node.key || '');
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const assetKind = String(attrs.assetKind || '')
    .trim()
    .toLowerCase();
  if (key === 'video' || assetKind === 'video' || key === 'audio' || assetKind === 'audio') {
    return String(attrs.poster || '').trim();
  }
  return String(attrs.src || attrs.poster || '').trim();
}

/** Sync RCB autoSize / box width → Kit Paragraph wrap width. */
function applyKitTextLayoutWidth(
  scene: WasmScene,
  kitId: number,
  node: { width?: number; attrs?: Record<string, unknown> | null }
) {
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const autoSize = String(attrs.autoSize ?? 'true') !== 'false';
  const renderer = scene.renderer as
    | {
        setTextLayoutWidth?: (id: number, w: number | null) => void;
        clearTextLayoutWidth?: (id: number) => void;
      }
    | null
    | undefined;
  if (!renderer) return;
  if (!autoSize) {
    const w = Math.max(8, Number(node.width) || 0);
    renderer.setTextLayoutWidth?.(kitId, w > 0 ? w : null);
  } else {
    renderer.clearTextLayoutWidth?.(kitId);
  }
}

function clearKitTextLayoutWidth(scene: WasmScene | null | undefined, kitId: number) {
  try {
    (
      scene?.renderer as { clearTextLayoutWidth?: (id: number) => void } | null | undefined
    )?.clearTextLayoutWidth?.(kitId);
  } catch {
    /* optional */
  }
}

/** Drop Paragraph decoration map when a Kit text node is removed / remounted. */
function clearKitTextDecoration(scene: WasmScene | null | undefined, kitId: number) {
  try {
    (
      scene?.renderer as { clearTextDecoration?: (id: number) => void } | null | undefined
    )?.clearTextDecoration?.(kitId);
  } catch {
    /* optional */
  }
}

function forgetKitTextChrome(scene: WasmScene | null | undefined, kitId: number) {
  clearKitTextLayoutWidth(scene, kitId);
  clearKitTextDecoration(scene, kitId);
}

function kitTextAlignFromStyle(textAlign: string | undefined): number {
  const a = String(textAlign || '').toLowerCase();
  if (a === 'center' || a === 'middle') return 1;
  if (a === 'right' || a === 'end') return 2;
  return 0;
}

/** CanvasKit / Skia TextDecoration bitflags (Underline|Overline|LineThrough). */
function kitTextDecorationFlags(style: Partial<TextStyle> | null | undefined): number {
  let flags = 0;
  if (isTextUnderline(style)) flags |= 1;
  if (isTextOverline(style)) flags |= 2;
  if (isTextStrike(style)) flags |= 4;
  return flags;
}

function applyKitTextDecoration(
  scene: WasmScene,
  kitId: number,
  style: Partial<TextStyle> | null | undefined
) {
  try {
    (
      scene.renderer as { setTextDecoration?: (id: number, flags: number) => void } | null | undefined
    )?.setTextDecoration?.(kitId, kitTextDecorationFlags(style));
  } catch {
    /* optional */
  }
}

/**
 * Map RCB / catalog text style → Kit face + weight.
 * Catalog Bold often uses a dedicated family ("Alibaba PuHuiTi Bold") with CSS
 * weight normal — Kit CJK aliases are registered on the base name at weight 700.
 */
function kitTextTypoFromStyle(style: Partial<TextStyle> | null | undefined): {
  family: string;
  weight: number;
  italic: boolean;
  letterSpacing: number;
} {
  const raw = toFabricFontFamily(style?.fontFamily) || KIT_APP_TEXT_FONT;
  const italic = isTextItalic(style);
  const letterSpacing = Number(style?.letterSpacing) || 0;
  const bold = isTextBold(style);
  let weight = 400;
  if (bold) {
    const n = Number(style?.fontWeight);
    weight = Number.isFinite(n) && n >= 600 ? Math.round(n) : 700;
  } else {
    const n = Number(style?.fontWeight);
    if (Number.isFinite(n) && n > 0) weight = Math.round(n);
  }
  // "… Bold" dedicated faces → base family @ 700 (Kit paint lookup).
  const family = raw.replace(/\s+Bold$/i, '').trim() || raw;
  return { family, weight, italic, letterSpacing };
}

function applyKitTextStyleNoHistory(
  scene: WasmScene,
  kitId: number,
  weight: number,
  italic: boolean,
  letterSpacing: number
) {
  try {
    scene.engine?.set_text_style(kitId, weight, italic, letterSpacing);
  } catch {
    /* optional on older wasm */
  }
}

/** Push SceneDocument text content / family into Kit (paste, hydrate, panel edits). */
function applyKitTextProps(scene: WasmScene, kitId: number, node: SceneNodeInput): boolean {
  if (String(node.key || '') !== 'text') return false;
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const style = parseNodeTextStyle(attrs);
  const content = parseNodeMarkdown(attrs);
  const fontSize = Number(attrs.fontSize || attrs['font-size'] || style.fontSize || 16) || 16;
  const typo = kitTextTypoFromStyle(style);
  const align = kitTextAlignFromStyle(style.textAlign);
  const lh = Number(style.lineHeight) || 1.2;
  const deco = kitTextDecorationFlags(style);
  const sig = `${content}\0${fontSize}\0${typo.family}\0${typo.weight}\0${typo.italic ? 1 : 0}\0${typo.letterSpacing}\0${align}\0${lh}\0${deco}`;
  if (lastKitTextSig.get(kitId) === sig) return false;
  ensureKitFontFamily(typo.family);
  try {
    scene.engine?.set_text_content(kitId, content, fontSize);
  } catch {
    /* ignore */
  }
  // Weight/italic before setTextPropertiesNoHistory so its invalidateCache sees them.
  applyKitTextStyleNoHistory(scene, kitId, typo.weight, typo.italic, typo.letterSpacing);
  try {
    scene.setTextPropertiesNoHistory(kitId, typo.family, align, lh);
  } catch {
    /* ignore */
  }
  applyKitTextDecoration(scene, kitId, style);
  lastKitTextSig.set(kitId, sig);
  applyKitTextLayoutWidth(scene, kitId, node);
  return true;
}

function resolveParametricShapeType(node: SceneNodeInput): string {
  const key = String(node.key || '').toLowerCase();
  if (key === 'ellipse') return 'ellipse';
  return String(
    (node.attrs as Record<string, unknown> | undefined)?.shapeType ||
      (key === 'shape' ? 'rect' : key) ||
      ''
  ).toLowerCase();
}

function isParametricOutlineShape(shapeType: string): boolean {
  return (
    shapeType === 'polygon' ||
    shapeType === 'star' ||
    shapeType === 'triangle' ||
    shapeType === 'circle' ||
    shapeType === 'ellipse' ||
    shapeType === 'oval'
  );
}

function ellipseNeedsVariantPath(attrs: Record<string, unknown> | null | undefined): boolean {
  if (ellipseInnerRatioFromAttrs(attrs) > 1e-4) return true;
  return Math.abs(Math.abs(ellipseArcPercentFromAttrs(attrs)) - 100) > 0.05;
}

function parametricAttrsSig(node: SceneNodeInput): string | null {
  const shapeType = resolveParametricShapeType(node);
  if (!isParametricOutlineShape(shapeType)) return null;
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const radii =
    attrs.radiusVertices ??
    attrs['corner-radius'] ??
    attrs.cornerRadius ??
    attrs.rx ??
    '';
  return [
    shapeType,
    Math.round(Number(node.width) || 1),
    Math.round(Number(node.height) || 1),
    sidesFromAttrs(attrs),
    starInnerRatioFromAttrs(attrs).toFixed(4),
    ellipseInnerRatioFromAttrs(attrs).toFixed(4),
    ellipseArcPercentFromAttrs(attrs).toFixed(2),
    ellipseStartDegFromAttrs(attrs).toFixed(1),
    String(radii),
  ].join('|');
}

function rememberParametricSig(rcbId: string, node: SceneNodeInput) {
  const sig = parametricAttrsSig(node);
  if (sig) lastParametricSig.set(rcbId, sig);
  else lastParametricSig.delete(rcbId);
}

/**
 * Rebuild Kit outline when RCB parametric attrs change (sides / IR / Ar).
 * Polygon/star/triangle are always Path; ellipse stays Ellipse until IR/Ar need a variant.
 */
function syncParametricKitShape(
  handle: CanvasEngineHandle,
  rcbId: string,
  kitId: number,
  node: SceneNodeInput,
  worldX: number,
  worldY: number
): number {
  const scene = handle.scene;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const cx = worldX + w / 2;
  const cy = worldY + h / 2;
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const shapeType = resolveParametricShapeType(node);
  const angle = Number(attrs.angle) || 0;
  const kn = scene.getNode(kitId);
  if (!kn) return kitId;

  const applyPose = (id: number, centered: boolean) => {
    try {
      if (centered) scene.engine?.set_node_position(id, cx, cy);
      else scene.engine?.set_node_position(id, worldX, worldY);
      scene.engine?.set_node_rotation(id, angle);
    } catch {
      /* optional */
    }
  };

  const remountKeepingSelection = (create: () => number): number => {
    let selected = false;
    try {
      const sel = scene.engine?.get_selection?.() as Uint32Array | number[] | undefined;
      if (sel) {
        for (let i = 0; i < sel.length; i += 1) {
          if (Number(sel[i]) === kitId) {
            selected = true;
            break;
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      scene.removeNode(kitId);
    } catch {
      /* ignore */
    }
    kitToRcb.delete(kitId);
    rcbToKit.delete(rcbId);
    forgetKitTextChrome(scene, kitId);
    forgetKitStyle(kitId);
    const newId = create();
    remember(newId, rcbId);
    applyKitNodeStyle(scene, newId, node);
    if (selected) {
      try {
        scene.engine?.clear_selection();
        scene.selectNode(newId, false);
      } catch {
        /* ignore */
      }
    }
    return newId;
  };

  if (shapeType === 'circle' || shapeType === 'ellipse' || shapeType === 'oval') {
    if (!ellipseNeedsVariantPath(attrs)) {
      if (kn.geometry?.Ellipse) {
        applyPose(kitId, true);
        try {
          scene.engine?.resize_node(kitId, w, h);
        } catch {
          /* ignore */
        }
        return kitId;
      }
      return remountKeepingSelection(() => {
        const id = scene.addEllipse(cx, cy, w / 2, h / 2);
        applyPose(id, true);
        return id;
      });
    }
    const d = getShapeBaselineD(node);
    if (!d) return kitId;
    const centeredD = translatePathData(d, -w / 2, -h / 2);
    const json = svgDToSubpathsJson(centeredD);
    if (kn.geometry?.Path && typeof scene.updatePathPointsNoHistory === 'function') {
      try {
        scene.updatePathPointsNoHistory(kitId, json);
        applyPose(kitId, true);
        return kitId;
      } catch {
        /* fall through remount */
      }
    }
    return remountKeepingSelection(() => {
      const id = scene.addPath(json);
      applyPose(id, true);
      return id;
    });
  }

  // polygon / star / triangle
  const d = getShapeBaselineD(node);
  if (!d) return kitId;
  const centeredD = translatePathData(d, -w / 2, -h / 2);
  const json = svgDToSubpathsJson(centeredD);
  if (kn.geometry?.Path && typeof scene.updatePathPointsNoHistory === 'function') {
    try {
      scene.updatePathPointsNoHistory(kitId, json);
      applyPose(kitId, true);
      return kitId;
    } catch {
      /* fall through remount */
    }
  }
  return remountKeepingSelection(() => {
    const id = scene.addPath(json);
    applyPose(id, true);
    return id;
  });
}

/**
 * Push RCB parametric outline attrs (sides / IR / Ar / radii) into Kit.
 * Safe during Kit→doc mirror frames — does not push box transforms.
 */
export function syncParametricOutlinesFromDocument(
  handle: CanvasEngineHandle,
  document: SceneDocument | null | undefined,
  onlyIds?: Iterable<string>
) {
  if (!document || suppressDepth > 0) return;
  const delta = document.deltaSetLike || {};
  const idList = onlyIds
    ? [...onlyIds].map(String).filter(Boolean)
    : [...rcbToKit.keys()];
  withSuppress(() => {
    let dirty = false;
    for (const rcbId of idList) {
      const kitId = rcbToKit.get(rcbId);
      const node = delta[rcbId];
      if (kitId == null || !node) continue;
      const sig = parametricAttrsSig(node);
      if (sig == null) {
        lastParametricSig.delete(rcbId);
        continue;
      }
      const prev = lastParametricSig.get(rcbId);
      if (prev === sig) continue;
      if (!getShapeBaselineD(node)) continue;
      const { left, top } = nodeLeftTop(document, node);
      const liveKitId = syncParametricKitShape(handle, rcbId, kitId, node, left, top);
      lastParametricSig.set(rcbId, sig);
      applyKitNodeStyle(handle.scene, liveKitId, node);
      dirty = true;
    }
    if (dirty) handle.renderer.requestRender();
  });
}

/**
 * Force Kit outline rebuild for one RCB node after chrome parametric edits.
 * Call after patchDocumentNode so Kit ink tracks sides / IR / Ar immediately —
 * even when a concurrent Kit→doc flush would skip full reconcile.
 */
export function pushParametricOutlineToKit(
  rcbId: string,
  nodeOverride?: SceneNodeInput | null
): boolean {
  const handle = attached;
  const id = String(rcbId || '').trim();
  if (!handle || !id || suppressDepth > 0) return false;
  const doc = store.getState().editor.document as SceneDocument | null;
  if (!doc) return false;
  const node = nodeOverride || doc.deltaSetLike?.[id];
  if (!node) return false;
  const kitId = rcbToKit.get(id);
  if (kitId == null) return false;
  const sig = parametricAttrsSig(node);
  if (sig == null || !getShapeBaselineD(node)) return false;
  const { left, top } = nodeLeftTop(doc, node);
  withSuppress(() => {
    lastParametricSig.delete(id);
    const liveKitId = syncParametricKitShape(handle, id, kitId, node, left, top);
    lastParametricSig.set(id, sig);
    applyKitNodeStyle(handle.scene, liveKitId, node);
    handle.renderer.requestRender();
  });
  return true;
}

function rememberFrame(kitId: number, frameId: string) {
  kitArtboardToFrame.set(kitId, frameId);
  frameToKitArtboard.set(frameId, kitId);
}

function kitNodeToCreated(
  kitId: number,
  node: KitSceneNode,
  createTool?: string | null
) {
  const t = node.transform || { x: 0, y: 0, rotation_deg: 0 };
  const paint = kitFillStroke(node);
  const fillCss = colorToCss(paint.fillPaint) || '#FFFFFF';
  const g = node.geometry || {};
  const tool = String(createTool || '').toLowerCase();

  if (g.Rect) {
    const rw = Number(g.Rect.width);
    const rh = Number(g.Rect.height);
    const w = Number.isFinite(rw) && rw > 0 ? rw : 1;
    const h = Number.isFinite(rh) && rh > 0 ? rh : 1;
    const created = createShapeNode({
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      width: w,
      height: h,
      shapeType: 'rect',
      fill: fillCss,
      stroke: paint.stroke,
      borderWidth: paint.borderWidth,
      angle: Number(t.rotation_deg) || 0,
    });
    // Kit duplicate/paste copies style.corner_radius; createShapeNode seeds 0.
    // Mirror into attrs so reconcile / 副本 keep the same roundness.
    const kitCorner = Math.round(Number(node.style?.corner_radius) || 0);
    if (kitCorner > 0) {
      applyUniformCornerRadiusAttrs(
        (created.node.attrs || (created.node.attrs = {})) as Record<string, unknown>,
        kitCorner
      );
    }
    return created;
  }
  if (g.Ellipse) {
    const rx = Math.max(1e-6, Number(g.Ellipse.radius_x) || 1);
    const ry = Math.max(1e-6, Number(g.Ellipse.radius_y) || 1);
    return createShapeNode({
      x: (Number(t.x) || 0) - rx,
      y: (Number(t.y) || 0) - ry,
      width: rx * 2,
      height: ry * 2,
      shapeType: 'circle',
      fill: fillCss,
      stroke: paint.stroke,
      borderWidth: paint.borderWidth,
      angle: Number(t.rotation_deg) || 0,
    });
  }
  if (g.Path) {
    const subpaths = g.Path.subpaths || [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const sp of subpaths) {
      for (const p of sp.points || []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!Number.isFinite(minX)) {
      minX = 0;
      minY = 0;
      maxX = 1;
      maxY = 1;
    }
    const local = subpaths.map((sp) => ({
      closed: Boolean(sp.closed),
      points: (sp.points || []).map((p) => ({
        x: p.x - minX,
        y: p.y - minY,
        cp1: [p.cp1[0] - minX, p.cp1[1] - minY] as [number, number],
        cp2: [p.cp2[0] - minX, p.cp2[1] - minY] as [number, number],
      })),
    }));
    const closed = local.some((s) => s.closed);
    const pointCount = local.reduce((n, sp) => n + (sp.points?.length || 0), 0);
    let shapeType = closed ? 'path' : 'pencil';
    let sides: number | undefined;
    if (tool === 'line' || tool === 'arrow') {
      shapeType = tool === 'arrow' ? 'arrow' : 'line';
    } else if (tool === 'pen') {
      shapeType = 'pen';
    } else if (tool === 'pencil') {
      shapeType = 'pencil';
    } else if (tool === 'polygon') {
      shapeType = 'polygon';
      sides = Math.max(3, pointCount || 6);
    } else if (tool === 'star') {
      shapeType = 'star';
      sides = Math.max(3, Math.round((pointCount || 10) / 2));
    } else if (!closed && pointCount <= 2) {
      shapeType = 'line';
    }
    return createShapeNode({
      x: (Number(t.x) || 0) + minX,
      y: (Number(t.y) || 0) + minY,
      width: Math.max(1e-6, maxX - minX),
      height: Math.max(1e-6, maxY - minY),
      shapeType,
      fill: closed && shapeType !== 'pen' && shapeType !== 'pencil' ? fillCss : 'transparent',
      stroke: paint.stroke,
      borderWidth: paint.borderWidth,
      path: subpathsToSvgD(local),
      closed,
      sides,
      angle: Number(t.rotation_deg) || 0,
    });
  }
  if (g.Text) {
    return createTextNode({
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      text: String(g.Text.content || ''),
      fontSize: Number(g.Text.font_size) || 16,
      fontFamily: String(g.Text.font_family || KIT_APP_TEXT_FONT) || KIT_APP_TEXT_FONT,
    });
  }
  if (g.Image) {
    const w = Math.max(1, Number(g.Image.width) || 1);
    const h = Math.max(1, Number(g.Image.height) || 1);
    const src = pendingImageSrcByKitId.get(kitId) || '';
    pendingImageSrcByKitId.delete(kitId);
    return createImageNode({
      x: Number(t.x) || 0,
      y: Number(t.y) || 0,
      width: w,
      height: h,
      src,
    });
  }
  return null;
}

function notifyPathEditChrome(active: boolean, rcbId: string | null) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent('resume:path-edit', { detail: { active, nodeId: rcbId } })
  );
}

function editorNodeByRcbId(rcbId: string | null | undefined): SceneNodeInput | null {
  if (!rcbId) return null;
  const raw = store.getState().editor.document;
  if (!raw) return null;
  return normalizeDocument(raw).deltaSetLike?.[rcbId] ?? null;
}

/** Generators must not convertToPath / enter direct path-edit. */
function bounceGeneratorOffPathEdit(
  handle: CanvasEngineHandle,
  node: SceneNodeInput | null | undefined
): boolean {
  if (!isGeneratorNode(node)) return false;
  try {
    handle.setTool('selection');
  } catch {
    /* ignore */
  }
  setActiveTool('select');
  return true;
}

function flushCreates(
  scene: WasmScene,
  opts?: { preserveKitStyle?: boolean; skipHistory?: boolean }
) {
  if (suppressDepth > 0) return;
  // preserveKitStyle retained for callers; create import never rewrites Kit style
  // (Kit InputManager already applied getCurrentStyle / drawnPathStyle).
  void opts?.preserveKitStyle;
  const skipHistory = Boolean(opts?.skipHistory) || kitHistoryReconcile;
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc) {
    // No document to import into — drop hint so paste/boolean cannot inherit it.
    pendingCreateTool = null;
    return;
  }

  let dirty = false;
  let lastCreated: string | null = null;
  let createdArtboardId: string | null = null;
  // Prefer product tool id for shapeType tagging (arrow vs line); engine tool is
  // already applied at create time via InputManager.
  // pendingCreateTool wins: maybeRevertTool sets store+Kit to selection before
  // this microtask runs, which would otherwise tag polygons as plain `path`.
  const editorTool =
    editor.activeTool === 'shape'
      ? String(editor.shapeKind || 'rect')
      : String(editor.activeTool || '');
  const hintedTool = pendingCreateTool;
  const createTool =
    hintedTool ||
    editorTool ||
    attached?.ui?.activeTool ||
    '';
  // Consume once per flush; restore below if we bail before import.
  pendingCreateTool = null;

  // Import Kit-created artboards (frame tool / duplicate / paste). Never promote
  // Engine seed / empty-deserialize "Artwork 1" — undo-to-empty and resize used
  // to call addArtboardFrame and leave a ghost board on the canvas.
  for (const ab of [...scene.getArtboards()]) {
    if (kitArtboardToFrame.has(ab.id)) continue;
    const frameId = `kit${ab.id}`;
    // Never push a second frame with the same id (React key body-kit1 / …).
    const framesNow = Array.isArray(doc.frames) ? doc.frames : [];
    if (frameToKitArtboard.has(frameId) || framesNow.some((f) => String(f?.id) === frameId)) {
      rememberFrame(ab.id, frameId);
      continue;
    }
    const createIsArtboard =
      String(createTool || '').toLowerCase() === 'artboard' ||
      String(hintedTool || '').toLowerCase() === 'artboard';
    // Engine::new / empty-artboards deserialize mint Artwork 1 at the origin.
    // Keep user-drawn frames (artboard tool) and Kit duplicate/paste boards.
    if (!createIsArtboard && isKitEngineSeedArtboard(ab)) {
      discardKitArtboardNoHistory(scene, ab.id);
      continue;
    }
    addArtboardFrame({
      id: frameId,
      x: ab.x,
      y: ab.y,
      width: ab.w,
      height: ab.h,
      name: ab.name || 'Frame',
      activate: true,
    });
    rememberFrame(ab.id, frameId);
    createdArtboardId = frameId;
    dirty = true;
    doc = store.getState().editor.document
      ? normalizeDocument(store.getState().editor.document)
      : doc;
  }

  doc = store.getState().editor.document
    ? normalizeDocument(store.getState().editor.document)
    : doc;
  if (!doc) {
    if (hintedTool) pendingCreateTool = hintedTool;
    return;
  }

  const data = scene.getSceneData();
  for (const rootId of data.root_nodes || []) {
    if (kitToRcb.has(rootId)) continue;
    const node = data.nodes?.[rootId];
    if (!node) continue;
    const styled = scene.getNode(rootId) || node;
    // Kit: InputManager already applied ui.getCurrentStyle() / drawnPathStyle
    // at commit — never overwrite WASM style with a product palette rewrite.
    const created = kitNodeToCreated(rootId, styled, createTool);
    if (!created) continue;
    // Bind to the intersecting artboard so clipContent applies on first paint.
    const owner = frameForNodeIntersectPlacement(
      doc,
      {
        left: Number(created.node.x) || 0,
        top: Number(created.node.y) || 0,
        width: Math.max(1, Number(created.node.width) || 1),
        height: Math.max(1, Number(created.node.height) || 1),
      },
      created.node
    );
    if (owner) {
      let nextNode = {
        ...created.node,
        attrs: { ...(created.node.attrs || {}), frameId: owner },
      };
      // Kit create is world-absolute; frameLocal store must keep plate-local xy
      // or the next geom sync parks ink outside the workbench clip.
      if (isFrameLocalCoordSpace(doc)) {
        const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
          (f) => String(f?.id) === owner
        );
        if (frame) {
          nextNode = {
            ...nextNode,
            x: (Number(nextNode.x) || 0) - (Number(frame.x) || 0),
            y: (Number(nextNode.y) || 0) - (Number(frame.y) || 0),
          };
        }
      }
      created.node = nextNode;
    }
    doc = addNodeToDocument(doc, created.id, created.node);
    // Timeline open: bind overlapping ink to the plate; off-plate → surround
    // (hidden when timeline closes). Never leave a free world orphan.
    doc = tagCreatedNodeForWorkbenchSurround(doc, created.id);
    remember(rootId, created.id);
    rememberParametricSig(created.id, created.node);
    lastCreated = created.id;
    dirty = true;
  }

  if (!dirty || !doc) return;
  if (!skipHistory) pushEditorHistory();
  mirrorKitDocument(doc);
  // frameId lands after Kit already recorded the scene picture — re-record so
  // clipContent applies on the first post-create paint (not only after a later mutation).
  refreshKitArtboardClipPaint();
  // New creates may pick up workbench surround / plate bind — refresh Kit hide set.
  syncKitWorkbenchIsolation();
  // Figma-style finish: select the new object and return to the select tool.
  // Pen/pencil stay armed until 退出编辑 — skip select + one-shot revert so
  // continuous strokes do not flash a transform box after every mouse-up.
  // Skip during Kit history reconcile — undo/redo must not steal selection/tool.
  if (!skipHistory) {
    const stayOnDrawTool = isPersistentDrawSessionTool(createTool);
    if (lastCreated && !stayOnDrawTool) {
      // Engine already holds the new selection — store is a mirror, not a push-back.
      selectionMirrorGeneration += 1;
      lastSelKey = `${lastCreated}|`;
      // Prefer setSelectedNodeIds only — setSelectedNodeId collapses multi to [id].
      setSelectedNodeIds([lastCreated]);
      setSelectedFrameIds([]);
    } else if (stayOnDrawTool) {
      // Mirror Kit's empty selection while the draw session stays locked.
      selectionMirrorGeneration += 1;
      lastSelKey = '|';
      setSelectedNodeIds([]);
      setSelectedFrameIds([]);
    }
    if ((lastCreated || createdArtboardId) && !stayOnDrawTool) {
      setActiveTool('select');
      attached?.setTool('selection');
    }
  }
}

function flushDeletesFromKit(scene: WasmScene, opts?: { skipHistory?: boolean }) {
  if (suppressDepth > 0) return;
  const skipHistory = Boolean(opts?.skipHistory) || kitHistoryReconcile;
  const live = new Set<number>();
  const data = scene.getSceneData();
  for (const id of data.root_nodes || []) live.add(id);
  for (const id of Object.keys(data.nodes || {}).map(Number)) live.add(id);
  for (const ab of scene.getArtboards()) live.add(ab.id);

  const dropNodes: string[] = [];
  for (const [kitId, rcbId] of [...kitToRcb.entries()]) {
    if (live.has(kitId)) continue;
    dropNodes.push(rcbId);
    forgetKitTextChrome(scene, kitId);
    kitToRcb.delete(kitId);
    rcbToKit.delete(rcbId);
    lastKitRasterSrc.delete(rcbId);
  }
  const dropFrames: string[] = [];
  for (const [kitId, frameId] of [...kitArtboardToFrame.entries()]) {
    if (live.has(kitId)) continue;
    dropFrames.push(frameId);
    kitArtboardToFrame.delete(kitId);
    frameToKitArtboard.delete(frameId);
  }

  if (!dropNodes.length && !dropFrames.length) return;

  // Kit history reconcile must not push a competing RCB undo entry.
  if (skipHistory) {
    const editor = store.getState().editor;
    let doc = editor.document ? normalizeDocument(editor.document) : null;
    if (!doc) return;
    if (dropNodes.length) doc = removeNodesFromDocument(doc, dropNodes);
    if (dropFrames.length && Array.isArray(doc.frames)) {
      const gone = new Set(dropFrames);
      const frames = doc.frames.filter((f) => f && !gone.has(String(f.id)));
      const active =
        doc.activeFrameId && gone.has(String(doc.activeFrameId))
          ? frames[0]?.id ?? null
          : doc.activeFrameId ?? null;
      doc = { ...doc, frames, activeFrameId: active };
    }
    mirrorKitDocument(doc);
    return;
  }

  // One mutator for nodes+frames. Splitting removeDocumentNodes(nodes) then
  // removeArtboardFrames(frames) queued ensure for animation plates that were
  // about to die — multi artboard Delete could resurrect / leave one board.
  removeDocumentNodes({
    nodeIds: dropNodes,
    frameIds: dropFrames,
  });
}

/** Full Kit → SceneDocument membership/geometry/style sync (creates+deletes+maps). */
function flushKitSceneToDocument(opts?: { preserveKitStyle?: boolean; skipHistory?: boolean }) {
  const handle = attached;
  if (!handle || suppressDepth > 0) return;
  const skipHistory = Boolean(opts?.skipHistory) || kitHistoryReconcile;
  flushCreates(handle.scene, {
    preserveKitStyle: opts?.preserveKitStyle ?? skipHistory,
    skipHistory,
  });
  flushDeletesFromKit(handle.scene, { skipHistory });
  flushMappedGeometry(handle.scene);
  flushMappedStyle(handle.scene);
  syncGroupIdAttrsFromKit(handle.scene);
}

/**
 * Kit→Document geometry mirror:
 * - Rotate / move / resize are transform-only in the engine — local path points
 *   are never rewritten here (see InputManager.applyRotationDrag).
 * - Angle comes from getNodeTransformComponents (same as Kit prop-rotation).
 * - Centered Ellipse / Polygon / Star keep transform-at-center; RCB stores
 *   top-left box = center − half size.
 * - Path local AABB (after Kit resize_node) updates RCB width/height so
 *   freehand / boolean paths track the resized outline.
 * - Parametric polygon/star/triangle keep the document box as SoT — fillet
 *   rebuilds must not rewrite W/H from the rounded path AABB (that stretched
 *   the shape when dragging corner radius).
 */
function isCenteredKitMirror(rn: SceneNodeInput, kn: KitSceneNode): boolean {
  const shapeType = String(
    (rn.attrs as Record<string, unknown> | undefined)?.shapeType || rn.key || ''
  ).toLowerCase();
  if (kn.geometry?.Ellipse) return true;
  return (
    shapeType === 'polygon' ||
    shapeType === 'star' ||
    shapeType === 'triangle' ||
    shapeType === 'circle' ||
    shapeType === 'ellipse' ||
    shapeType === 'oval'
  );
}

/** Local AABB of a Kit Path (resolved outline when available). */
function kitPathLocalAabb(
  scene: WasmScene,
  kitId: number,
  kn: KitSceneNode
): { minX: number; minY: number; w: number; h: number } | null {
  let subpaths = kn.geometry?.Path?.subpaths as
    | Array<{ points?: Array<{ x: number; y: number }> }>
    | undefined;
  try {
    const resolved = scene.getResolvedSubpaths?.(kitId);
    if (resolved && resolved.length) subpaths = resolved as typeof subpaths;
  } catch {
    /* optional on older wasm */
  }
  if (!subpaths?.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const sp of subpaths) {
    for (const p of sp.points || []) {
      const px = Number(p.x);
      const py = Number(p.y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  if (!Number.isFinite(minX) || !(maxX > minX) || !(maxY > minY)) return null;
  return {
    minX,
    minY,
    w: Math.max(1, maxX - minX),
    h: Math.max(1, maxY - minY),
  };
}

/**
 * Path → RCB box. Parametric outlines keep document W/H (fillets must not stretch).
 * Freehand / boolean paths mirror Kit local AABB + centered transform.
 */
function mirrorPathBoxFromKit(
  scene: WasmScene,
  kitId: number,
  kn: KitSceneNode,
  rn: SceneNodeInput,
  centered: boolean,
  tx: number,
  ty: number,
  w: number,
  h: number
): { x: number; y: number; w: number; h: number } {
  const parametric =
    centered && isParametricOutlineShape(resolveParametricShapeType(rn));
  if (parametric) {
    return { x: tx - w / 2, y: ty - h / 2, w, h };
  }
  const local = kitPathLocalAabb(scene, kitId, kn);
  if (local) {
    return {
      x: tx + local.minX,
      y: ty + local.minY,
      w: local.w,
      h: local.h,
    };
  }
  if (centered) return { x: tx - w / 2, y: ty - h / 2, w, h };
  return { x: tx, y: ty, w, h };
}

function flushMappedGeometry(scene: WasmScene) {
  if (suppressDepth > 0 || scene.inGesture) return;
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc) return;
  let dirty = false;
  const geomPatches: GeomPatch[] = [];

  // Artboards before nodes (Kit artboard+contained move): world' = world+d
  // and frame' = frame+d — converting with the new frame keeps frameLocal stable.
  for (const ab of scene.getArtboards()) {
    const frameId = kitArtboardToFrame.get(ab.id);
    if (!frameId || !doc.frames) continue;
    const idx = doc.frames.findIndex((f) => String(f?.id) === frameId);
    if (idx < 0) continue;
    const f = doc.frames[idx];
    if (
      Math.abs((Number(f.x) || 0) - ab.x) < 0.01 &&
      Math.abs((Number(f.y) || 0) - ab.y) < 0.01 &&
      Math.abs((Number(f.width) || 0) - ab.w) < 0.01 &&
      Math.abs((Number(f.height) || 0) - ab.h) < 0.01
    ) {
      continue;
    }
    const nextFrames = [...doc.frames];
    nextFrames[idx] = { ...f, x: ab.x, y: ab.y, width: ab.w, height: ab.h };
    doc = { ...doc, frames: nextFrames };
    dirty = true;
  }

  for (const [kitId, rcbId] of kitToRcb.entries()) {
    const kn = scene.getNode(kitId);
    const rn = doc.deltaSetLike?.[rcbId];
    if (!kn || !rn) continue;

    let tx = Number(kn.transform?.x) || 0;
    let ty = Number(kn.transform?.y) || 0;
    let angle = Number(kn.transform?.rotation_deg) || 0;
    try {
      const tc = scene.getNodeTransformComponents(kitId);
      if (tc) {
        tx = Number(tc.x) || 0;
        ty = Number(tc.y) || 0;
        angle = Number(tc.rotation_deg) || 0;
      }
    } catch {
      /* optional on older wasm */
    }

    let x = tx;
    let y = ty;
    let w = Math.max(1, Number(rn.width) || 1);
    let h = Math.max(1, Number(rn.height) || 1);
    const centered = isCenteredKitMirror(rn, kn);

    if (kn.geometry?.Rect) {
      w = Math.max(1, Number(kn.geometry.Rect.width) || 1);
      h = Math.max(1, Number(kn.geometry.Rect.height) || 1);
      x = tx;
      y = ty;
    } else if (kn.geometry?.Ellipse) {
      const rx = Math.max(0.5, Number(kn.geometry.Ellipse.radius_x) || 1);
      const ry = Math.max(0.5, Number(kn.geometry.Ellipse.radius_y) || 1);
      w = rx * 2;
      h = ry * 2;
      x = tx - rx;
      y = ty - ry;
    } else if (kn.geometry?.Image) {
      w = Math.max(1, Number(kn.geometry.Image.width) || 1);
      h = Math.max(1, Number(kn.geometry.Image.height) || 1);
      x = tx;
      y = ty;
    } else if (kn.geometry?.Path) {
      const box = mirrorPathBoxFromKit(scene, kitId, kn, rn, centered, tx, ty, w, h);
      x = box.x;
      y = box.y;
      w = box.w;
      h = box.h;
    } else if (kn.geometry?.Text) {
      x = tx;
      y = ty;
    }

    const frameId = String(
      (rn.attrs as Record<string, unknown> | undefined)?.frameId || ''
    ).trim();
    const stored = storedOriginForSceneResult(doc, x, y, frameId || null);
    x = stored.x;
    y = stored.y;

    if (kn.geometry?.Text) {
      const content = String(kn.geometry.Text.content || '');
      const fontSize = Number(kn.geometry.Text.font_size) || 16;
      const family =
        toFabricFontFamily(kn.geometry.Text.font_family || KIT_APP_TEXT_FONT) || KIT_APP_TEXT_FONT;
      const prevPlain = parseNodeMarkdown((rn.attrs || {}) as Record<string, unknown>);
      const prevStyle = parseNodeTextStyle((rn.attrs || {}) as Record<string, unknown>);
      const kitWeight = Math.round(Number(kn.geometry.Text.font_weight) || 400);
      const kitItalic = Boolean(kn.geometry.Text.italic);
      const kitLetter = Number(kn.geometry.Text.letter_spacing) || 0;
      let prevWeight = Math.round(Number(prevStyle.fontWeight) || 400) || 400;
      if (isTextBold(prevStyle) && prevWeight < 600) prevWeight = 700;
      const textChanged =
        content !== prevPlain ||
        Math.abs(fontSize - prevStyle.fontSize) > 0.01 ||
        family !== prevStyle.fontFamily ||
        kitWeight !== prevWeight ||
        kitItalic !== isTextItalic(prevStyle) ||
        Math.abs(kitLetter - (Number(prevStyle.letterSpacing) || 0)) > 0.01;
      const layoutW = (
        scene.renderer as { getTextLayoutWidth?: (id: number) => number | undefined } | null
      )?.getTextLayoutWidth?.(kitId);
      const tb = (
        scene.renderer as {
          getTextLocalBounds?: (id: number) => { x: number; y: number; w: number; h: number } | null;
        } | null
      )?.getTextLocalBounds?.(kitId);
      const wrapMode = layoutW != null && layoutW > 0;
      const styleForMeasure = {
        fontSize,
        fontFamily: family,
        lineHeight: Number(kn.geometry.Text.line_height) || prevStyle.lineHeight || 1.2,
        letterSpacing: kitLetter || prevStyle.letterSpacing || 0,
        fontWeight: String(kitWeight || prevStyle.fontWeight || '400'),
        fontStyle: kitItalic ? 'italic' : 'normal',
      };
      let nextW = w;
      let nextH = h;
      let nextAuto = String((rn.attrs as Record<string, unknown>)?.autoSize || 'true') !== 'false';
      if (wrapMode) {
        // Layout width is a wrap *max* — hug when glyphs are narrower (short lines).
        const measured = measureWrappedTextSize(content || ' ', styleForMeasure, layoutW);
        const glyphW = Math.max(8, Math.round(tb?.w ?? measured.width));
        if (glyphW + 1 < layoutW && !/\n/.test(content)) {
          nextAuto = true;
          nextW = glyphW;
          nextH = Math.max(1, Math.round(tb?.h ?? measured.height));
          clearKitTextLayoutWidth(scene, kitId);
        } else {
          nextAuto = false;
          nextW = Math.max(8, layoutW);
          nextH = Math.max(1, Math.round(tb?.h ?? measured.height));
        }
      } else if (textChanged || nextAuto) {
        const measured = measurePlainTextSize(content || 'M', styleForMeasure);
        nextW = Math.max(2, Math.round(tb?.w ?? measured.width));
        nextH = Math.max(1, Math.round(tb?.h ?? measured.height));
        nextAuto = true;
      }
      const autoAttr = nextAuto ? 'true' : 'false';
      const prevAuto = String((rn.attrs as Record<string, unknown>)?.autoSize || 'true');
      if (
        textChanged ||
        prevAuto !== autoAttr ||
        Math.abs((Number(rn.x) || 0) - x) >= 0.01 ||
        Math.abs((Number(rn.y) || 0) - y) >= 0.01 ||
        Math.abs((Number(rn.width) || 0) - nextW) >= 0.01 ||
        Math.abs((Number(rn.height) || 0) - nextH) >= 0.01 ||
        Math.abs(Number((rn.attrs as Record<string, unknown>)?.angle || 0) - angle) >= 0.01
      ) {
        const stylePatch = textChanged
          ? buildMarkdownTextAttrs(content, {
              ...prevStyle,
              fontSize,
              fontFamily: family,
              fontWeight: kitWeight >= 600 ? String(kitWeight) : prevStyle.fontWeight || 'normal',
              fontStyle: kitItalic ? 'italic' : 'normal',
              letterSpacing: kitLetter,
            })
          : {};
        doc = updateNodeInDocument(doc, rcbId, {
          x,
          y,
          width: nextW,
          height: nextH,
          attrs: {
            ...(rn.attrs || {}),
            angle,
            ...stylePatch,
            autoSize: autoAttr,
          },
        });
        dirty = true;
        geomPatches.push({
          nodeId: rcbId,
          left: x,
          top: y,
          width: nextW,
          height: nextH,
        });
      }
      continue;
    }

    if (
      Math.abs((Number(rn.x) || 0) - x) < 0.01 &&
      Math.abs((Number(rn.y) || 0) - y) < 0.01 &&
      Math.abs((Number(rn.width) || 0) - w) < 0.01 &&
      Math.abs((Number(rn.height) || 0) - h) < 0.01 &&
      Math.abs(Number((rn.attrs as Record<string, unknown>)?.angle || 0) - angle) < 0.01
    ) {
      continue;
    }
    doc = updateNodeInDocument(doc, rcbId, {
      x,
      y,
      width: w,
      height: h,
      attrs: { ...(rn.attrs || {}), angle },
    });
    dirty = true;
    geomPatches.push({ nodeId: rcbId, left: x, top: y, width: w, height: h });
  }

  // Drag-out / drag-in: clear sticky frameId + convert frameLocal↔world so clip
  // / hit wrappers stop hiding ink that left the plate (images often still painted).
  if (geomPatches.length && doc) {
    const rebound = applyNodeFrameBindings(doc, geomPatches);
    if (rebound !== doc) {
      doc = rebound;
      dirty = true;
    }
  }

  if (dirty && doc) mirrorKitDocument(doc);
  // Ownership may have changed without a style/geom changeCounter bump.
  if (dirty) refreshKitArtboardClipPaint();
}

/** Kit Live Paint / style mutations → SceneDocument fill/stroke attrs. */
function flushMappedStyle(scene: WasmScene) {
  if (suppressDepth > 0 || scene.inGesture) return;
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc) return;
  let dirty = false;

  for (const [kitId, rcbId] of kitToRcb.entries()) {
    const kn = scene.getNode(kitId);
    const rn = doc.deltaSetLike?.[rcbId];
    if (!kn || !rn || kn.geometry?.Image || kn.geometry?.Text) continue;
    const paint = kitFillStroke(kn);
    const attrs = { ...(rn.attrs || {}) } as Record<string, unknown>;
    const prevFillType = parseFillType(attrs['fill-type'] ?? attrs.fillType);
    // Image fills are RCB-only (Kit LP has no image faces) — never clobber with solid.
    const skipFill = prevFillType === 'image';
    const fillPatch = skipFill
      ? null
      : kitFillToRcbAttrs(
          paint.fillPaint,
          Math.max(1, Number(rn.width) || 1),
          Math.max(1, Number(rn.height) || 1)
        );
    const prevStroke = String(attrs['border-color'] || attrs.stroke || '');
    const prevWidth = Number(attrs['border-width'] ?? attrs.strokeWidth ?? 1) || 1;
    const strokeChanged = paint.stroke !== prevStroke;
    const widthChanged = Math.abs(paint.borderWidth - prevWidth) > 0.01;
    let fillChanged = false;
    if (fillPatch) {
      const nextType = String(fillPatch['fill-type'] || '');
      const nextColor = String(fillPatch['fill-color'] || '');
      const nextGrad = String(fillPatch['fill-gradient'] || '');
      const prevColor = String(attrs['fill-color'] || attrs.fill || '');
      const prevGrad = String(attrs['fill-gradient'] || '');
      fillChanged =
        nextType !== prevFillType ||
        nextColor !== prevColor ||
        (nextGrad || '') !== (prevGrad || '');
    }
    // Kit rect corner handles mutate style.corner_radius only — mirror into attrs
    // so duplicate / toolbar / rehydrate keep the same roundness.
    const shapeType = String(attrs.shapeType || rn.key || '').toLowerCase();
    const kitCorner =
      kn.geometry?.Rect && shapeType !== 'polygon' && shapeType !== 'star' && shapeType !== 'triangle'
        ? Math.round(Number(kn.style?.corner_radius) || 0)
        : null;
    const docCorner =
      kitCorner != null ? kitStyleCornerRadius(shapeType, attrs) : null;
    const radiusChanged = kitCorner != null && docCorner != null && kitCorner !== docCorner;
    if (!fillChanged && !strokeChanged && !widthChanged && !radiusChanged) continue;
    if (fillChanged && fillPatch) Object.assign(attrs, fillPatch);
    if (strokeChanged) attrs['border-color'] = paint.stroke;
    if (widthChanged) attrs['border-width'] = paint.borderWidth;
    if (radiusChanged && kitCorner != null) applyUniformCornerRadiusAttrs(attrs, kitCorner);
    doc = updateNodeInDocument(doc, rcbId, { attrs });
    dirty = true;
  }

  if (dirty && doc) mirrorKitDocument(doc);
}

function flushSelectionToStore(
  handle: CanvasEngineHandle,
  opts?: {
    force?: boolean;
    /** Captured before InputManager mouseup clears `input.marqueeRect`. */
    marquee?: { x: number; y: number; w: number; h: number } | null;
  }
) {
  if (suppressDepth > 0) return;
  const sel = Array.from(handle.scene.getSelection() || []);
  const nodeIds: string[] = [];
  const seen = new Set<string>();
  const pushRcb = (rcbId: string | undefined) => {
    if (!rcbId || seen.has(rcbId)) return;
    seen.add(rcbId);
    nodeIds.push(rcbId);
  };

  /** Kit id → RCB id; heal stale/missing maps by world AABB so multi-select chrome works. */
  const resolveRcbForKitId = (kitId: number): string | undefined => {
    const mapped = kitToRcb.get(kitId);
    if (mapped) return mapped;
    const editor = store.getState().editor;
    const doc = editor.document ? normalizeDocument(editor.document) : null;
    if (!doc?.deltaSetLike) return undefined;
    let minX = NaN;
    let minY = NaN;
    let maxX = NaN;
    let maxY = NaN;
    try {
      const b = handle.scene.getMeasuredNodeBounds?.(kitId);
      if (b && b.length >= 4) {
        minX = Number(b[0]);
        minY = Number(b[1]);
        maxX = Number(b[2]);
        maxY = Number(b[3]);
      }
    } catch {
      /* fall through */
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      try {
        const b = Array.from(handle.scene.engine?.get_node_bounds(kitId) || []);
        if (b.length >= 4) {
          // Engine returns x,y,x2,y2 (same as getMeasuredNodeBounds).
          minX = Number(b[0]);
          minY = Number(b[1]);
          maxX = Number(b[2]);
          maxY = Number(b[3]);
        }
      } catch {
        return undefined;
      }
    }
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined;
    const eps = 1.5;
    let best: string | null = null;
    let bestArea = Infinity;
    for (const [rcbId, node] of Object.entries(doc.deltaSetLike)) {
      if (!node || rcbId === 'ROOT') continue;
      // Already claimed by another Kit id in this selection pass.
      if (seen.has(rcbId)) continue;
      const box = nodeSceneAabb(doc, rcbId);
      if (!box) continue;
      if (
        Math.abs(box.minX - minX) <= eps &&
        Math.abs(box.minY - minY) <= eps &&
        Math.abs(box.maxX - maxX) <= eps &&
        Math.abs(box.maxY - maxY) <= eps
      ) {
        const mappedKit = rcbToKit.get(rcbId);
        // Prefer unbound / stale-bound nodes over ones firmly tied to another
        // selected Kit id (those will resolve via their own kit entry).
        if (mappedKit != null && mappedKit !== kitId && sel.includes(mappedKit)) {
          continue;
        }
        const area = Math.max(1, (box.maxX - box.minX) * (box.maxY - box.minY));
        if (area < bestArea) {
          bestArea = area;
          best = rcbId;
        }
      }
    }
    if (!best) return undefined;
    // Heal map so later flushes / style sync stay consistent.
    const staleKit = rcbToKit.get(best);
    if (staleKit != null && staleKit !== kitId) kitToRcb.delete(staleKit);
    remember(kitId, best);
    return best;
  };

  for (const kitId of sel) {
    const kn = handle.scene.getNode(kitId);
    // Kit Group has no SceneDocument row — expand to mapped children for panels/toolbar.
    if (kn?.node_type === 'Group') {
      let kids: number[] = [];
      if (Array.isArray(kn.children) && kn.children.length) {
        kids = kn.children.map(Number).filter((n) => Number.isFinite(n));
      } else {
        try {
          kids = Array.from(handle.scene.getNodeChildren?.(kitId) || []).map(Number);
        } catch {
          kids = [];
        }
      }
      if (kids.length) {
        for (const childId of kids) {
          pushRcb(resolveRcbForKitId(childId));
        }
        continue;
      }
    }
    pushRcb(resolveRcbForKitId(kitId));
  }

  // Timeline-closed 动画工作台: never keep preview children / host in selection —
  // promote to the plate (preview unit) and clear Kit node picks.
  const editorDocSel = store.getState().editor.document;
  const docSel = editorDocSel ? normalizeDocument(editorDocSel) : null;
  const promotePreviewFrames = new Set<string>();
  if (docSel?.deltaSetLike && nodeIds.length) {
    const kept: string[] = [];
    for (const id of nodeIds) {
      const node = docSel.deltaSetLike[id];
      if (!node) continue;
      if (isAnimationFrameHostNode(node, docSel) || isAnimationWorkbenchPreviewChild(docSel, node)) {
        const fid = String(node.attrs?.frameId || '').trim();
        if (fid) promotePreviewFrames.add(fid);
        continue;
      }
      kept.push(id);
    }
    if (kept.length !== nodeIds.length) {
      nodeIds.length = 0;
      seen.clear();
      for (const id of kept) {
        seen.add(id);
        nodeIds.push(id);
      }
    }
  }
  // Union DomHost-only plates (lottie / group / empty generators) Kit never maps.
  // Prefer the rect captured before mouseup — `input.marqueeRect` is already cleared.
  const marquee =
    opts?.marquee && opts.marquee.w > 1 && opts.marquee.h > 1
      ? opts.marquee
      : handle.input?.marqueeRect;
  if (marquee && marquee.w > 1 && marquee.h > 1) {
    const editor = store.getState().editor;
    const doc = editor.document ? normalizeDocument(editor.document) : null;
    const delta = doc?.deltaSetLike || {};
    const mx0 = marquee.x;
    const my0 = marquee.y;
    const mx1 = marquee.x + marquee.w;
    const my1 = marquee.y + marquee.h;
    for (const [id, node] of Object.entries(delta)) {
      if (!node || id === 'ROOT' || rcbToKit.has(id)) continue;
      if (!isDomHostOnlyRcbNode(node) && !isEmptyGeneratorPlate(node)) continue;
      // Host chrome / preview-isolated / locked — not marquee targets.
      if (isAnimationFrameHostNode(node, doc)) continue;
      if (isNodeMarqueeSkippable(doc, node)) continue;
      const box = nodeSceneAabb(doc!, id);
      if (!box) continue;
      if (box.minX < mx1 && box.maxX > mx0 && box.minY < my1 && box.maxY > my0) {
        pushRcb(id);
      }
    }
  }
  const abId = Number(
    (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId ?? NaN
  );
  const frameIds: string[] = [];
  if (Number.isFinite(abId) && kitArtboardToFrame.has(abId)) {
    frameIds.push(kitArtboardToFrame.get(abId)!);
  }
  for (const fid of promotePreviewFrames) {
    if (!frameIds.includes(fid)) frameIds.push(fid);
  }
  // Drop only remapped Kit picks; keep pasteboard / other selectable nodes.
  if (promotePreviewFrames.size) {
    const skipKit = new Set<number>();
    for (const [kitId, rcbId] of kitToRcb.entries()) {
      const node = docSel?.deltaSetLike?.[rcbId];
      if (!node || !docSel) continue;
      if (isAnimationFrameHostNode(node, docSel) || isAnimationWorkbenchPreviewChild(docSel, node)) {
        skipKit.add(kitId);
      }
    }
    if (skipKit.size) {
      withSuppress(() => {
        try {
          const keep = Array.from(handle.scene.getSelection?.() || [])
            .map(Number)
            .filter((id) => Number.isFinite(id) && !skipKit.has(id));
          handle.scene.engine?.clear_selection();
          for (const id of keep) {
            try {
              handle.scene.selectNode(id, true);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
        if (!nodeIds.length) {
          try {
            (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId =
              null;
          } catch {
            /* ignore */
          }
        }
      });
    }
  }
  const editorDocForSoft = store.getState().editor.document;
  const softParent =
    !frameIds.length && nodeIds.length
      ? sharedBoundFrameId(
          editorDocForSoft ? normalizeDocument(editorDocForSoft) : null,
          nodeIds
        )
      : null;
  const key = `${nodeIds.join(',')}|${frameIds.join(',')}|soft:${softParent || ''}`;
  if (!opts?.force && key === lastSelKey) return;

  // Composer「从画布选择」— Kit owns hits; complete attach here (SvgCanvas onSelect is bypassed).
  const pick = store.getState().editor.canvasAttachPick as null | {
    target: string;
    accept?: 'image' | 'media';
  };
  if (pick?.target) {
    const editorDoc = store.getState().editor.document;
    const doc = editorDoc ? normalizeDocument(editorDoc) : null;
    const filter = attachPickFilterOpts(pick);
    const hostNodeId = pick.target.startsWith('node:')
      ? pick.target.slice('node:'.length).trim()
      : '';

    const keepHostComposerSelected = () => {
      if (!hostNodeId) return false;
      // Keep the generator/quick-edit composer open — do not steal selection onto the pick.
      selectionMirrorGeneration += 1;
      lastSelKey = `${hostNodeId}|`;
      setSelectedNodeIds([hostNodeId]);
      setSelectedFrameIds([]);
      setSoftFrameContext(null);
      const kitId = rcbToKit.get(hostNodeId);
      if (kitId != null && attached) {
        withSuppress(() => {
          try {
            attached.scene.engine?.clear_selection();
          } catch {
            /* ignore */
          }
          try {
            attached.scene.selectNode(kitId, false);
          } catch {
            /* ignore */
          }
        });
        syncKitArtboardChromeHighlight(attached);
        attached.renderer.requestRender();
      }
      return true;
    };

    if (!nodeIds.length && !frameIds.length) {
      // Empty click cancels pick mode only — leave the host composer selected.
      clearCanvasAttachPick();
      return;
    }
    if (!doc) return;

    const plateFrame =
      nodeIds.length === 1 && !frameIds.length
        ? frameForFullBleedPlate(doc, nodeIds[0]!)
        : null;
    if (plateFrame) {
      if (!canAttachFrameToPick(doc, plateFrame.id, filter)) {
        setCanvasAttachPickBlocked(true);
        return;
      }
      setPendingCanvasAttach({
        target: pick.target,
        payload: `frame:${plateFrame.id}`,
      });
      clearCanvasAttachPick();
      if (keepHostComposerSelected()) return;
    } else {
      const resolved = resolveAttachPickPayload(doc, nodeIds, frameIds[0], filter);
      if (!resolved) {
        clearCanvasAttachPick();
        return;
      }
      if (resolved.blockedOnly) {
        // Generators / processing nodes — stay in pick mode (not-allowed cursor).
        setCanvasAttachPickBlocked(true);
        return;
      }
      setPendingCanvasAttach({
        target: pick.target,
        payload: resolved.payload,
      });
      clearCanvasAttachPick();
      if (keepHostComposerSelected()) return;
    }
  }

  lastSelKey = key;
  selectionMirrorGeneration += 1;
  // Preview-child remaps → plate unit with full chrome (play / open timeline toolbar).
  if (promotePreviewFrames.size && !nodeIds.length && frameIds.length) {
    setSelectedNodeIds([]);
    setSelectedFrameIds(frameIds);
    setActiveFrameId(frameIds[0]);
    if (attached) syncKitArtboardChromeHighlight(attached);
    return;
  }
  // Prefer setSelectedNodeIds only — setSelectedNodeId resets selectedNodeIds to [id]
  // and was wiping Kit multi-select (boolean / align toolbar never appeared).
  setSelectedNodeIds(nodeIds);
  if (frameIds.length) {
    // Kit full artboard chrome (empty plate body / title).
    setSelectedFrameIds(frameIds);
    setActiveFrameId(frameIds[0]);
  } else {
    // Node-only Kit selection must clear leftover frame chrome — otherwise
    // SelectionFeature keeps selectedFrameIds and hides MultiSelectionToolbar
    // (`showMulti` requires frames.length === 0), or pairs one frame + one node
    // into a confusing single-toolbar path.
    setSelectedFrameIds([]);
    if (softParent) {
      // Occupied plate context: soft edge like selecting a generator parent.
      setSoftFrameContext(softParent);
    } else {
      setSoftFrameContext(null);
      if (!nodeIds.length) setActiveFrameId(null);
    }
  }
  if (attached) syncKitArtboardChromeHighlight(attached);
}

/** Soft / full artboard chrome → Kit softArtboardId / selectedArtboardId. */
export function syncKitArtboardChromeHighlight(handle: CanvasEngineHandle) {
  const editor = store.getState().editor;
  const chromeMode = editor.frameChromeMode === 'full' ? 'full' : 'soft';
  const active = String(editor.document?.activeFrameId || '').trim();
  const softFrameId =
    chromeMode === 'soft'
      ? active || String((editor.selectedFrameIds || [])[0] || '').trim()
      : '';
  const softKit = softFrameId ? frameToKitArtboard.get(softFrameId) ?? null : null;
  const r = handle.renderer as {
    softArtboardId?: number | null;
    selectedArtboardId?: number | null;
  };
  if (r.softArtboardId !== softKit) {
    r.softArtboardId = softKit;
  }
  // Soft must never leave a stale selectedArtboardId (handles / title chrome).
  if (chromeMode === 'soft' && softKit != null && r.selectedArtboardId != null) {
    r.selectedArtboardId = null;
  }
}

/** Shared attrs.frameId when every selected node is bound to the same plate. */
function sharedBoundFrameId(
  doc: SceneDocument | null | undefined,
  nodeIds: string[]
): string | null {
  if (!doc?.deltaSetLike || !nodeIds.length) return null;
  let shared: string | null = null;
  for (const id of nodeIds) {
    const fid = String(doc.deltaSetLike[id]?.attrs?.frameId || '').trim();
    if (!fid) return null;
    if (shared == null) shared = fid;
    else if (shared !== fid) return null;
  }
  return shared;
}

/** Generation for Kit→store selection mirrors (Host skips echo push-back). */
export function getKitSelectionMirrorGeneration(): number {
  return selectionMirrorGeneration;
}

/**
 * Kit marquee commit uses scene.getVisibleNodes(x,y,x+w,y+h).
 * Spatial index can under-select (1 of N) — always union with measured world
 * AABBs so multi-select chrome / MultiSelectionToolbar see every hit.
 */
function selectKitNodesInWorldRect(
  scene: WasmScene,
  rect: { x: number; y: number; w: number; h: number },
  additive: boolean
): number[] {
  const x0 = rect.x;
  const y0 = rect.y;
  const x1 = rect.x + rect.w;
  const y1 = rect.y + rect.h;
  const hit = new Set<number>();
  try {
    for (const id of scene.getVisibleNodes(x0, y0, x1, y1) || []) {
      const n = Number(id);
      if (Number.isFinite(n)) hit.add(n);
    }
  } catch {
    /* ignore */
  }
  // Measured AABB union — covers spatial-index misses / transform edge cases.
  // Walk every mapped Kit id (not only root_nodes) so grouped / nested hits
  // stay in the multi-select that move_nodes will drag together.
  try {
    for (const kitId of kitToRcb.keys()) {
      if (hit.has(kitId)) continue;
      try {
        if (typeof scene.isLockedInTree === 'function' && scene.isLockedInTree(kitId)) continue;
        if (typeof scene.isVisibleInTree === 'function' && !scene.isVisibleInTree(kitId)) continue;
        const b = scene.getMeasuredNodeBounds(kitId);
        if (!b || b.length < 4) continue;
        if (b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0) hit.add(kitId);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  const ids = [...hit];
  if (!additive) {
    try {
      scene.engine?.clear_selection();
    } catch {
      /* ignore */
    }
  }
  for (const id of ids) {
    try {
      scene.selectNode(id, true);
    } catch {
      /* ignore */
    }
  }
  return ids;
}

/** After InputManager marquee mouseup — ensure Kit selection + store mirror. */
function finalizeMarqueeSelection(
  handle: CanvasEngineHandle,
  marquee: { x: number; y: number; w: number; h: number } | null,
  shiftKey: boolean
) {
  const softPending = pendingSoftArtboardFrameId;
  pendingSoftArtboardFrameId = null;
  const marqueeSignificant = Boolean(marquee && marquee.w > 1 && marquee.h > 1);

  if (marqueeSignificant && marquee) {
    // Always rebuild from the captured rect. Kit already ran getVisibleNodes
    // on mouseup — if that under-selected, an empty-only fallback left the store
    // on one id and SelectionFeature kept showing the single-node toolbar.
    selectKitNodesInWorldRect(handle.scene, marquee, shiftKey);

    // Also pull SceneDocument AABBs (frameLocal → world) for mapped Kit ids the
    // engine still missed — covers nodes whose measured bounds lag ink.
    const editor = store.getState().editor;
    const doc = editor.document ? normalizeDocument(editor.document) : null;
    if (doc?.deltaSetLike) {
      const x0 = marquee.x;
      const y0 = marquee.y;
      const x1 = marquee.x + marquee.w;
      const y1 = marquee.y + marquee.h;
      const already = new Set(Array.from(handle.scene.getSelection() || []).map(Number));
      let multi = already.size > 0 || shiftKey;
      for (const [rcbId, kitId] of rcbToKit.entries()) {
        if (already.has(kitId)) continue;
        const node = doc.deltaSetLike[rcbId];
        if (node && isNodeMarqueeSkippable(doc, node)) continue;
        const box = nodeSceneAabb(doc, rcbId);
        if (!box) continue;
        if (box.minX < x1 && box.maxX > x0 && box.minY < y1 && box.maxY > y0) {
          try {
            handle.scene.selectNode(kitId, multi);
            multi = true;
            already.add(kitId);
          } catch {
            /* ignore */
          }
        }
      }
      // Drop Kit hits that map to preview-isolated / locked RCB nodes so
      // timeline-closed workbench marquees do not select unpickable ink.
      const skipKit = new Set<number>();
      for (const kitId of already) {
        const rcbId = kitToRcb.get(kitId);
        if (!rcbId) continue;
        const node = doc.deltaSetLike[rcbId];
        if (node && isNodeMarqueeSkippable(doc, node)) skipKit.add(kitId);
      }
      if (skipKit.size) {
        try {
          const keep = [...already].filter((id) => !skipKit.has(id));
          handle.scene.engine?.clear_selection();
          for (const id of keep) handle.scene.selectNode(id, true);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      // Marquee replaces node selection — drop stale artboard chrome so
      // showMulti is not gated off by leftover selectedFrameIds.
      if (!shiftKey) {
        (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId = null;
      }
    } catch {
      /* ignore */
    }
    handle.renderer.requestRender();
  }
  flushSelectionToStore(handle, { force: true, marquee });

  // Artboards are selection units (same as click / Shift+title multi-select).
  // Without this, a plate marquee only selects bound children → node toolbar
  // and no multi-frame control box (FrameMultiSelectionToolbar).
  if (marqueeSignificant && marquee) {
    promoteMarqueeToArtboardUnits(handle, marquee, shiftKey);
  }

  // Occupied plate body click (no marquee): soft-select like a generator.
  // Marquee that only hit preview-isolated / unpickable ink: soft-select the
  // plate — but never on Shift (additive) or when frames are already selected.
  if (softPending) {
    const kitSel = Array.from(handle.scene.getSelection?.() || []);
    const ed = store.getState().editor;
    const storeSel = ed.selectedNodeIds || [];
    const frameSel = ed.selectedFrameIds || [];
    const allowSoft =
      !kitSel.length &&
      !storeSel.length &&
      (!marqueeSignificant || (!shiftKey && !frameSel.length));
    if (allowSoft) {
      selectionMirrorGeneration += 1;
      const doc = ed.document ? normalizeDocument(ed.document) : null;
      const plate = (Array.isArray(doc?.frames) ? doc!.frames : []).find(
        (f) => String(f?.id) === softPending
      );
      if (isAnimationArtboardKind(plate?.kind)) {
        // Occupied 动画工作台 preview: full chrome so play / open-timeline mount.
        setSelectedNodeIds([]);
        setSelectedFrameIds([softPending]);
        setActiveFrameId(softPending);
        lastSelKey = `|${softPending}|`;
      } else {
        setMixedSelection({ nodeIds: [], frameIds: [softPending] });
        setSoftFrameContext(softPending);
        lastSelKey = `|${softPending}|soft:${softPending}`;
      }
    }
  }
}

/** Scene frames whose plate AABB intersects the marquee rect. */
function framesIntersectingMarquee(
  doc: SceneDocument,
  marquee: { x: number; y: number; w: number; h: number }
): string[] {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frames.length) return [];
  const x0 = marquee.x;
  const y0 = marquee.y;
  const x1 = marquee.x + marquee.w;
  const y1 = marquee.y + marquee.h;
  const out: string[] = [];
  for (const frame of frames) {
    const id = String(frame?.id || '').trim();
    if (!id || !isArtboardVisibleInDocument(frame)) continue;
    if (frame.locked) continue;
    const box = frameSceneBounds(doc, frame, getLiveArtboardFrameGeometry(id));
    if (
      box.left < x1 &&
      box.left + box.width > x0 &&
      box.top < y1 &&
      box.top + box.height > y0
    ) {
      out.push(id);
    }
  }
  return out;
}

/**
 * Marquee that targets artboard plates → select frames (full chrome), not only
 * their children. Multi-plate → FrameMultiSelectionToolbar + union control box.
 *
 * Important: if the marquee also hit scene nodes, keep that node selection so
 * multi-drag moves every ink item together. Promoting to the artboard here used
 * to clear Kit selection whenever the rect covered ≥55% of an occupied plate —
 * then a follow-up drag only moved whichever shape was clicked.
 */
function promoteMarqueeToArtboardUnits(
  handle: CanvasEngineHandle,
  marquee: { x: number; y: number; w: number; h: number },
  shiftKey: boolean
) {
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc) return;

  const hitFrames = framesIntersectingMarquee(doc, marquee);
  if (!hitFrames.length) return;

  const hitSet = new Set(hitFrames);
  const nodeIds = (editor.selectedNodeIds || []).map(String).filter(Boolean);
  const freeOrForeign = nodeIds.filter((id) => {
    const fid = String(doc.deltaSetLike?.[id]?.attrs?.frameId || '').trim();
    return !fid || !hitSet.has(fid);
  });
  // Pasteboard / other-frame content in the same marquee → keep node selection.
  if (freeOrForeign.length) return;
  // Ink was hit — keep multi/single node selection for Kit move_nodes.
  // Empty-plate marquees (no nodes) still promote to artboard units below.
  if (nodeIds.length > 0) return;

  let nextFrames = hitFrames;
  if (shiftKey) {
    const cur = new Set((editor.selectedFrameIds || []).map(String).filter(Boolean));
    for (const id of hitFrames) {
      if (cur.has(id)) cur.delete(id);
      else cur.add(id);
    }
    nextFrames = [...cur];
    if (!nextFrames.length) {
      try {
        handle.scene.engine?.clear_selection();
      } catch {
        /* ignore */
      }
      (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId = null;
      selectionMirrorGeneration += 1;
      setSelectedNodeIds([]);
      setSelectedFrameIds([]);
      lastSelKey = '|';
      syncKitArtboardChromeHighlight(handle);
      handle.renderer.requestRender();
      return;
    }
  }

  try {
    handle.scene.engine?.clear_selection();
  } catch {
    /* ignore */
  }
  selectionMirrorGeneration += 1;
  // setSelectedFrameIds → full chrome (toolbar + handles). Clear nodes so
  // SelectionFeature does not show MultiSelectionToolbar over plates.
  setSelectedNodeIds([]);
  setSelectedFrameIds(nextFrames);
  lastSelKey = `|${nextFrames.join(',')}|`;
  syncKitSelectionFromStore(handle, [], nextFrames);
  handle.renderer.requestRender();
}

/** Parse CSS hex/rgba into Kit 0–1 color. */
function parseCssColor(css: string): { r: number; g: number; b: number; a: number } | null {
  const s = String(css || '').trim();
  if (!s || s === 'transparent' || s === 'none') return null;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const hasAlpha = h.length === 8;
    return {
      r: parseInt(h.slice(0, 2), 16) / 255,
      g: parseInt(h.slice(2, 4), 16) / 255,
      b: parseInt(h.slice(4, 6), 16) / 255,
      a: hasAlpha ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(s);
  if (rgba) {
    return {
      r: Number(rgba[1]) / 255,
      g: Number(rgba[2]) / 255,
      b: Number(rgba[3]) / 255,
      a: rgba[4] != null ? Number(rgba[4]) : 1,
    };
  }
  return null;
}

/** Product 0–100 opacity → 8-digit hex for Kit `hexToRgb` (`#rrggbbaa`). */
function hexWithAlpha8(css: string, opacityPct: number): string {
  const base = normalizeColor(css);
  const raw = base.replace('#', '');
  let h = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw.slice(0, 6);
  if (h.length !== 6) h = '333333';
  const a = Math.round(Math.min(100, Math.max(0, Number(opacityPct) || 0)) * 2.55);
  return `#${h}${a.toString(16).padStart(2, '0')}`;
}

function kitColorFromStop(
  color: string,
  stopOpacityPct: number,
  globalOpacityPct: number
): { r: number; g: number; b: number; a: number } {
  const c = parseCssColor(normalizeColor(color)) || { r: 0.2, g: 0.2, b: 0.2, a: 1 };
  const local = Math.min(100, Math.max(0, Number(stopOpacityPct) || 0)) / 100;
  const global = Math.min(100, Math.max(0, Number(globalOpacityPct) || 0)) / 100;
  return { r: c.r, g: c.g, b: c.b, a: (c.a ?? 1) * local * global };
}

/** Product FillGradient → Kit Live Paint unit-space gradient (0..1). */
function fillGradientToKitLivePaint(
  gradient: FillGradient,
  fillOpacityPct: number
): {
  gradient_type: 'Linear' | 'Radial';
  stops: Array<{ offset: number; color: { r: number; g: number; b: number; a: number } }>;
  start_x: number;
  start_y: number;
  end_x: number;
  end_y: number;
} {
  const stopsSrc =
    gradient.type === 'diffuse' && (gradient.colorStops?.length || 0) >= 2
      ? [gradient.colorStops[0], gradient.colorStops[gradient.colorStops.length - 1]]
      : gradient.colorStops || [];
  const stops = (stopsSrc.length >= 2 ? stopsSrc : [
    { offset: 0, color: '#FFFFFF', opacity: 100 },
    { offset: 1, color: '#737373', opacity: 100 },
  ]).map((s) => ({
    offset: Math.max(0, Math.min(1, Number(s.offset) || 0)),
    color: kitColorFromStop(String(s.color || '#FFFFFF'), Number(s.opacity ?? 100), fillOpacityPct),
  }));

  // Kit LP only has Linear | Radial — angular/diffuse approximate as Linear.
  if (gradient.type === 'radial') {
    const cx = Math.min(1, Math.max(0, (Number.isFinite(gradient.cx) ? Number(gradient.cx) : 50) / 100));
    const cy = Math.min(1, Math.max(0, (Number.isFinite(gradient.cy) ? Number(gradient.cy) : 50) / 100));
    const rr = Math.max(0.01, ((Number.isFinite(gradient.r) ? Number(gradient.r) : 50) / 100) * 0.5);
    return {
      gradient_type: 'Radial',
      stops,
      start_x: cx,
      start_y: cy,
      end_x: cx + rr,
      end_y: cy,
    };
  }

  // linear | angular | diffuse → Linear in unit space
  const coords =
    gradient.type === 'linear' || gradient.type === 'angular'
      ? resolveLinearCoords(gradient)
      : { x1: 0, y1: 0, x2: 1, y2: 1 };
  return {
    gradient_type: 'Linear',
    stops,
    start_x: coords.x1,
    start_y: coords.y1,
    end_x: coords.x2,
    end_y: coords.y2,
  };
}

function kitStrokeAlignment(alignRaw: string): 'Inner' | 'Outer' | 'Center' {
  const a = String(alignRaw || 'center').toLowerCase();
  if (a === 'inside' || a === 'inner') return 'Inner';
  if (a === 'outside' || a === 'outer') return 'Outer';
  return 'Center';
}

function kitFillsFromRcbAttrs(
  attrs: Record<string, unknown>,
  w: number,
  h: number
): unknown[] {
  const fillType = parseFillType(attrs['fill-type'] ?? attrs.fillType);
  const solidFill = parseCssColor(String(attrs['fill-color'] || attrs.fill || '#FFFFFF'));
  const fallback = solidFill ? [solidFill] : [];

  if (fillType !== 'linear' && fillType !== 'radial') {
    if (fillType === 'solid' && !attrs['fill-color'] && !attrs.fill) {
      return [{ r: 1, g: 1, b: 1, a: 1 }];
    }
    return fallback;
  }

  const grad = parseFillGradient(
    attrs['fill-gradient'] ?? attrs.fillGradient,
    fillType,
    String(attrs['fill-color'] || '#FFFFFF')
  );
  const stops = (grad.colorStops || []).map((s) => ({
    offset: Math.max(0, Math.min(1, Number(s.offset) || 0)),
    color: parseCssColor(String(s.color || '#FFFFFF')) || { r: 1, g: 1, b: 1, a: 1 },
  }));
  if (stops.length < 2) return fallback;

  if (fillType === 'radial') {
    const cx = ((Number.isFinite(grad.cx) ? Number(grad.cx) : 50) / 100) * w;
    const cy = ((Number.isFinite(grad.cy) ? Number(grad.cy) : 50) / 100) * h;
    const rr = ((Number.isFinite(grad.r) ? Number(grad.r) : 50) / 100) * Math.max(w, h) * 0.5;
    return [
      {
        gradient_type: 'Radial',
        stops,
        start_x: cx,
        start_y: cy,
        end_x: cx + rr,
        end_y: cy,
        spread: 0,
      },
    ];
  }

  const x1 = ((Number.isFinite(grad.x1) ? Number(grad.x1) : 0) / 100) * w;
  const y1 = ((Number.isFinite(grad.y1) ? Number(grad.y1) : 50) / 100) * h;
  const x2 = ((Number.isFinite(grad.x2) ? Number(grad.x2) : 100) / 100) * w;
  const y2 = ((Number.isFinite(grad.y2) ? Number(grad.y2) : 50) / 100) * h;
  // Angle fallback when endpoints omitted (degrees, 0 = left→right).
  const angle = ((Number(grad.angle) || 0) * Math.PI) / 180;
  const hasEnds =
    Number.isFinite(grad.x1) &&
    Number.isFinite(grad.y1) &&
    Number.isFinite(grad.x2) &&
    Number.isFinite(grad.y2);
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.max(w, h) / 2;
  return [
    {
      gradient_type: 'Linear',
      stops,
      start_x: hasEnds ? x1 : cx - Math.cos(angle) * len,
      start_y: hasEnds ? y1 : cy - Math.sin(angle) * len,
      end_x: hasEnds ? x2 : cx + Math.cos(angle) * len,
      end_y: hasEnds ? y2 : cy + Math.sin(angle) * len,
      spread: 0,
    },
  ];
}

/** RCB node attrs → Kit style JSON (fill / gradient / stroke / dash / align). */
export function styleJsonFromRcbNode(node: SceneNodeInput): string {
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const fills = kitFillsFromRcbAttrs(attrs, w, h);

  const stroke = parseCssColor(String(attrs['border-color'] || attrs.stroke || '#333333'));
  const width = Number(attrs['border-width'] ?? attrs.borderWidth ?? 1) || 1;
  const opacity = Number(attrs.opacity ?? 1);
  const alignment = kitStrokeAlignment(String(attrs.strokeAlign || 'center'));
  const dashStr =
    strokeDashForStyle(attrs['stroke-style'] ?? attrs.strokeStyle) ||
    String(attrs['stroke-dasharray'] || attrs.strokeDasharray || '');
  const dash_array = dashStr
    .split(/[\s,]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > 0);

  const shapeType = String(attrs.shapeType || node.key || '').toLowerCase();
  const fill_rule = kitStyleFillRule(shapeType, attrs);
  const corner_radius = kitStyleCornerRadius(shapeType, attrs);
  // Kit Stroke.cap / join: 0/1/2 = Butt|Round|Square and Miter|Round|Bevel.
  const cap = kitStrokeCapIndex(resolveStrokeLinecap(attrs));
  const join = kitStrokeJoinIndex(resolveStrokeLinejoin(attrs));
  const miter_limit = resolveStrokeMiterlimit(attrs);
  const strokeOpacityPct = Number(attrs['stroke-opacity'] ?? 100);
  const strokeA =
    Number.isFinite(strokeOpacityPct)
      ? Math.max(0, Math.min(1, strokeOpacityPct / 100))
      : 1;
  const strokes =
    stroke && width > 0
      ? [
          {
            paint: { ...stroke, a: (stroke.a ?? 1) * strokeA },
            width,
            cap,
            join,
            dash_array,
            dash_offset: 0,
            miter_limit,
            alignment,
          },
        ]
      : [];

  return JSON.stringify({
    fills,
    strokes,
    opacity: Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1,
    blend_mode: 0,
    fill_rule,
    corner_radius,
    effects: [],
  });
}

/** Kit StrokeCap enum indices (CanvasKit Butt/Round/Square). */
function kitStrokeCapIndex(cap: ReturnType<typeof resolveStrokeLinecap>): number {
  if (cap === 'round') return 1;
  if (cap === 'square') return 2;
  return 0;
}

/** Kit StrokeJoin enum indices (CanvasKit Miter/Round/Bevel). */
function kitStrokeJoinIndex(join: ReturnType<typeof resolveStrokeLinejoin>): number {
  if (join === 'round') return 1;
  if (join === 'bevel') return 2;
  return 0;
}

function kitStyleFillRule(shapeType: string, attrs: Record<string, unknown>): number {
  const ellipseLike =
    shapeType === 'circle' || shapeType === 'ellipse' || shapeType === 'oval';
  if (ellipseLike && ellipseInnerRatioFromAttrs(attrs) > 1e-4) return 1;
  return 0;
}

/** Path-baked fillets (polygon/star/triangle) must not also set Kit style radius. */
function kitStyleCornerRadius(shapeType: string, attrs: Record<string, unknown>): number {
  if (shapeType === 'polygon' || shapeType === 'star' || shapeType === 'triangle') {
    return 0;
  }
  // Prefer radiiFromAttrs so radiusTL / radius / cornerRadius / rx stay in sync
  // (factories often seed radiusTL=0 with a positive uniform cornerRadius).
  const r = radiiFromAttrs(attrs);
  return Math.round(isRadiusLinked(attrs) ? r.tl : maxRadius(r));
}

/** Write Kit's uniform corner_radius into the RCB attr surface used by duplicate/toolbar. */
function applyUniformCornerRadiusAttrs(
  attrs: Record<string, unknown>,
  radius: number
): void {
  const r = uniformCornerRadii(radius);
  attrs.cornerRadius = r.tl;
  attrs.radius = r.tl;
  attrs.radiusTL = r.tl;
  attrs.radiusTR = r.tr;
  attrs.radiusBR = r.br;
  attrs.radiusBL = r.bl;
  attrs.radiusLinked = 'true';
}

/**
 * Push RCB box → Kit engine transform.
 * @param opts.syncPath when false (TransformPreview / live drag), skip
 *   updatePathPointsNoHistory — that path calls invalidateCache() and wipes
 *   every CanvasKit path/gradient cache (full-scene rebuild per notify).
 */
function applyKitNodeGeom(
  scene: WasmScene,
  kitId: number,
  node: SceneNodeInput,
  opts?: { syncPath?: boolean; worldX?: number; worldY?: number }
) {
  // Prefer scene-absolute origin (Kit engine space). Callers pass worldX/Y
  // from nodeLeftTop when the document uses frameLocal plate coords.
  const x =
    opts?.worldX !== undefined && Number.isFinite(opts.worldX)
      ? Number(opts.worldX)
      : Number(node.x) || 0;
  const y =
    opts?.worldY !== undefined && Number.isFinite(opts.worldY)
      ? Number(opts.worldY)
      : Number(node.y) || 0;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const kn = scene.getNode(kitId);
  if (!kn) return;
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const shapeType = String(attrs.shapeType || node.key || '').toLowerCase();
  const syncPath = opts?.syncPath !== false;
  // Kit seeds Ellipse / Polygon / Star with transform at the center and
  // local geometry around the origin. RCB only mirrors a top-left box (+ path
  // shifted to 0..w). Writing that mirror path back while keeping a center
  // transform shifts the ink by ~half the bbox — the "draw then jump" bug.
  const centered =
    Boolean(kn.geometry?.Ellipse) ||
    shapeType === 'polygon' ||
    shapeType === 'star' ||
    shapeType === 'triangle' ||
    shapeType === 'circle' ||
    shapeType === 'ellipse' ||
    shapeType === 'oval';
  // Pen/pencil/line: RCB path is the working SoT after first sync (top-left local).
  // Centered parametric shapes: Kit owns the outline — never push RCB path back.
  const pathD = String(attrs.path || attrs.d || '');
  const isPathLike =
    !centered &&
    (Boolean(kn.geometry?.Path) ||
      shapeType === 'path' ||
      shapeType === 'pen' ||
      shapeType === 'pencil' ||
      shapeType === 'line' ||
      shapeType === 'arrow');
  if (
    syncPath &&
    isPathLike &&
    pathD &&
    typeof scene.updatePathPointsNoHistory === 'function'
  ) {
    try {
      scene.updatePathPointsNoHistory(kitId, svgDToSubpathsJson(pathD));
    } catch {
      /* ignore */
    }
  }
  if (centered) {
    scene.engine?.set_node_position(kitId, x + w / 2, y + h / 2);
  } else {
    scene.engine?.set_node_position(kitId, x, y);
  }
  scene.engine?.resize_node(kitId, w, h);
  const angle = Number(attrs.angle) || 0;
  const flipX = attrs.flipX === true || attrs.flipX === 'true';
  const flipY = attrs.flipY === true || attrs.flipY === 'true';
  try {
    scene.engine?.set_node_rotation(kitId, angle);
  } catch {
    /* optional */
  }
  // RCB stores flip as attrs; Kit paints via transform scale (±1 about center).
  // Must run after resize/rotation so product Flip & rotate toolbar updates ink.
  try {
    scene.engine?.set_node_scale(kitId, flipX ? -1 : 1, flipY ? -1 : 1);
  } catch {
    /* optional on older wasm */
  }
}

const KIT_EFFECTS_EMPTY_JSON = '[]';

function kitStyleJsonForNode(node: SceneNodeInput): string {
  if (isEmptyGeneratorPlate(node)) return emptyGeneratorKitStyleJson();
  if (isNodeProcessRunning(node)) {
    return JSON.stringify({
      fills: [],
      strokes: [],
      // Ink hidden — Kit overlay paints SoftGlow in node local space.
      opacity: 0,
      blend_mode: 0,
      fill_rule: 0,
      corner_radius: 0,
      effects: [],
    });
  }
  const key = String(node.key || '');
  if (key === 'image' || key === 'video' || key === 'audio') {
    const opacity = Number(node.attrs?.opacity ?? 1);
    const o = Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
    return JSON.stringify({
      fills: [],
      strokes: [],
      opacity: o,
      blend_mode: 0,
      fill_rule: 0,
      corner_radius: 0,
      effects: [],
    });
  }
  return styleJsonFromRcbNode(node);
}

function applyKitNodeStyle(scene: WasmScene, kitId: number, node: SceneNodeInput): boolean {
  let changed = false;
  try {
    let styleJson = kitStyleJsonForNode(node);
    // Mesh fills live in Kit Mesh tool — SceneDocument only mirrors
    // solid/gradient today. Never clobber an active mesh with RCB solid attrs.
    const kitNode = scene.getNode(kitId);
    const kitFills = kitNode?.style?.fills;
    if (
      Array.isArray(kitFills) &&
      kitFills.some((f) => f != null && isMeshGradient(f as never))
    ) {
      try {
        const parsed = JSON.parse(styleJson) as { fills?: unknown[] };
        parsed.fills = kitFills;
        styleJson = JSON.stringify(parsed);
      } catch {
        /* keep RCB styleJson */
      }
    }
    if (lastKitStyleJson.get(kitId) !== styleJson) {
      scene.setNodeStyleNoHistory(kitId, styleJson);
      lastKitStyleJson.set(kitId, styleJson);
      changed = true;
    }
  } catch {
    /* ignore */
  }
  if (applyKitTextProps(scene, kitId, node)) changed = true;
  else if (String(node.key || '') === 'text') {
    applyKitTextLayoutWidth(scene, kitId, node);
  }
  try {
    if (lastKitEffectsJson.get(kitId) !== KIT_EFFECTS_EMPTY_JSON) {
      scene.setNodeEffectsNoHistory(kitId, KIT_EFFECTS_EMPTY_JSON);
      lastKitEffectsJson.set(kitId, KIT_EFFECTS_EMPTY_JSON);
      changed = true;
    }
  } catch {
    /* ignore */
  }
  // Kit lock / mask flags — keep Kit hit/edit gates in sync with SceneDocument.
  try {
    const attrs = (node.attrs || {}) as Record<string, unknown>;
    const locked =
      attrs.locked === true || attrs.locked === 'true' || attrs.locked === 1;
    if (scene.getNodeLocked(kitId) !== locked) {
      scene.setNodeLocked(kitId, locked);
      changed = true;
    }
    const isMask =
      attrs.isMask === true ||
      attrs.isMask === 'true' ||
      attrs.mask === true ||
      attrs.mask === 'true';
    if (scene.getNodeIsMask(kitId) !== isMask) {
      scene.setNodeIsMask(kitId, isMask);
      changed = true;
    }
  } catch {
    /* ignore */
  }
  // Timeline focus isolation: hide Kit ink that SceneDocument already treats as
  // structurally hidden (outside workbench / surround-only when dock closed).
  try {
    const doc = store.getState().editor.document as SceneDocument | null;
    const visible = !isNodeStructurallyHiddenInDocument(doc, node);
    if (scene.getNodeVisible(kitId) !== visible) {
      scene.setNodeVisibleNoHistory(kitId, visible);
      changed = true;
    }
  } catch {
    /* ignore */
  }
  return changed;
}

/**
 * Re-apply workbench timeline isolation to every mapped Kit node + artboard.
 * Call when timeline opens/closes — focus is module state, not a document patch.
 */
export function syncKitWorkbenchIsolation(handle?: CanvasEngineHandle | null) {
  const h = handle ?? attached;
  if (!h) return;
  const raw = store.getState().editor.document;
  const doc = raw ? normalizeDocument(raw) : null;
  if (!doc) return;
  withSuppress(() => {
    for (const [rcbId, kitId] of rcbToKit.entries()) {
      const node = doc.deltaSetLike?.[rcbId];
      if (!node) continue;
      try {
        const visible = !isNodeStructurallyHiddenInDocument(doc, node);
        // Always write — getNodeVisible can lag after hydrate/remap.
        h.scene.setNodeVisibleNoHistory(kitId, visible);
      } catch {
        /* ignore */
      }
    }
    for (const [frameId, kitId] of frameToKitArtboard.entries()) {
      const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
        (f) => String(f?.id) === frameId
      );
      if (!frame) continue;
      applyKitArtboardFromFrame(h.scene, kitId, frame);
    }
  });
  // Collapse/show plates + node visibility must re-record retained picture
  // (requestRender alone can replay a stale scene with other-workbench strokes).
  refreshKitArtboardClipPaint(true);
}

const imageBytesCache = new Map<string, { bytes: Uint8Array; mime: string }>();
const imageFetchInflight = new Set<string>();

async function fetchImageBytes(
  src: string
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const url = String(src || '').trim();
  if (!url) return null;
  const hit = imageBytesCache.get(url);
  if (hit) return hit;
  try {
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(url);
      if (!m) return null;
      const mime = m[1] || 'image/png';
      const raw = m[3] || '';
      if (m[2]) {
        const bin = atob(raw);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const packed = { bytes, mime };
        imageBytesCache.set(url, packed);
        return packed;
      }
      const bytes = new TextEncoder().encode(decodeURIComponent(raw));
      const packed = { bytes, mime };
      imageBytesCache.set(url, packed);
      return packed;
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/png';
    const buf = new Uint8Array(await res.arrayBuffer());
    const packed = { bytes: buf, mime };
    imageBytesCache.set(url, packed);
    return packed;
  } catch {
    return null;
  }
}

/**
 * removeNode / remount clears engine selection; SoftGlow still paints via
 * rcbToKit while store stays selected — re-apply Kit chrome so the control box
 * shows during upload (toolbar stays HTML-gated by !processing).
 * Deferred when inside withSuppress (reconcile / fetch commit) so
 * syncKitSelectionFromStore is not no-op'd by suppressDepth.
 */
function resyncKitSelectionIfStoreSelected(rcbId: string) {
  const handle = attached;
  const id = String(rcbId);
  if (!handle || rcbToKit.get(rcbId) == null) return;
  if (!(store.getState().editor.selectedNodeIds || []).map(String).includes(id)) return;
  const run = () => {
    if (!attached || attached !== handle) return;
    if (suppressDepth > 0) {
      queueMicrotask(run);
      return;
    }
    if (rcbToKit.get(rcbId) == null) return;
    const live = store.getState().editor;
    if (!(live.selectedNodeIds || []).map(String).includes(id)) return;
    syncKitSelectionFromStore(
      handle,
      live.selectedNodeIds || [],
      live.selectedFrameIds || []
    );
  };
  run();
}

function commitImageBytesToKit(
  scene: WasmScene,
  rcbId: string,
  node: SceneNodeInput,
  data: { bytes: Uint8Array; mime: string },
  rasterSrc?: string
): boolean {
  const expected = String(rasterSrc || '').trim();
  const existing = rcbToKit.get(rcbId);
  if (existing != null) {
    const have = kitGeomKind(scene.getNode(existing));
    if (have === 'image') {
      const bound = lastKitRasterSrc.get(rcbId) || '';
      // Same still already registered — geom/style only.
      if (expected && bound === expected) {
        applyKitNodeGeom(scene, existing, node);
        applyKitNodeStyle(scene, existing, node);
        attached?.renderer.requestRender();
        return true;
      }
      // Stale/wrong still (e.g. blob finished after durable rebind started).
      try {
        scene.removeNode(existing);
      } catch {
        /* ignore */
      }
      kitToRcb.delete(existing);
      rcbToKit.delete(rcbId);
      forgetKitStyle(existing);
      lastKitRasterSrc.delete(rcbId);
    } else {
      // Drop placeholder rect so real Kit image can take the mapping.
      try {
        scene.removeNode(existing);
      } catch {
        /* ignore */
      }
      kitToRcb.delete(existing);
      rcbToKit.delete(rcbId);
    }
  }
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  try {
    const imageId = scene.engine!.register_image(data.bytes, data.mime);
    const kitId = scene.engine!.add_image(x, y, w, h, imageId);
    scene.invalidateCache?.();
    applyKitNodeStyle(scene, kitId, node);
    remember(kitId, rcbId);
    if (expected) lastKitRasterSrc.set(rcbId, expected);
    resyncKitSelectionIfStoreSelected(rcbId);
    attached?.renderer.requestRender();
    return true;
  } catch {
    return false;
  }
}

/** Kit wash for empty generators (#e9eaee). 1px hairline + Lucide are overlay-painted. */
function emptyGeneratorKitStyleJson(): string {
  return JSON.stringify({
    fills: [{ r: 233 / 255, g: 234 / 255, b: 238 / 255, a: 1 }],
    // Edge is screen-constant in drawEmptyGeneratorIcons (GENERATOR_EMPTY_PLATE_STROKE @ 1 CSS px).
    strokes: [],
    opacity: 1,
    blend_mode: 0,
    fill_rule: 0,
    corner_radius: 0,
    effects: [],
  });
}

function pushRasterNodeToKit(scene: WasmScene, rcbId: string, node: SceneNodeInput) {
  // Empty generators: Kit gray rect (pick / select / move). Icon is HTML overlay.
  if (isEmptyGeneratorPlate(node)) {
    const doc = store.getState().editor.document as SceneDocument | null;
    const origin = doc
      ? nodeLeftTop(doc, node)
      : { left: Number(node.x) || 0, top: Number(node.y) || 0 };
    const x = origin.left;
    const y = origin.top;
    const w = Math.max(1, Number(node.width) || 1);
    const h = Math.max(1, Number(node.height) || 1);
    const styleJson = emptyGeneratorKitStyleJson();
    const existing = rcbToKit.get(rcbId);
    if (existing != null) {
      applyKitNodeGeom(scene, existing, node);
      if (lastKitStyleJson.get(existing) !== styleJson) {
        scene.setNodeStyleNoHistory(existing, styleJson);
        lastKitStyleJson.set(existing, styleJson);
      } else {
        // Wash style is constant; resize alone must still drop the retained
        // scene picture or the gray plate stays at the pre-aspect size.
        scene.invalidateCache?.(false);
      }
      return;
    }
    const kitId = scene.addRect(x, y, w, h);
    scene.setNodeStyleNoHistory(kitId, styleJson);
    lastKitStyleJson.set(kitId, styleJson);
    remember(kitId, rcbId);
    return;
  }
  const src = kitStillRasterUrl(node);
  const existing = rcbToKit.get(rcbId);
  if (existing != null) {
    const have = kitGeomKind(scene.getNode(existing));
    const bound = lastKitRasterSrc.get(rcbId) || '';
    if (have === 'image') {
      // Same still — geom/style only. Different/missing URL — drop and rebind
      // (e.g. video src was wrongly decoded as image → black plate).
      if (src && src === bound) {
        applyKitNodeGeom(scene, existing, node);
        applyKitNodeStyle(scene, existing, node);
        return;
      }
      try {
        scene.removeNode(existing);
      } catch {
        /* ignore */
      }
      kitToRcb.delete(existing);
      rcbToKit.delete(rcbId);
      forgetKitStyle(existing);
      lastKitRasterSrc.delete(rcbId);
    } else if (!src) {
      applyKitNodeGeom(scene, existing, node);
      applyKitNodeStyle(scene, existing, node);
      return;
    }
    // Placeholder rect still mapped — fall through to register real image bytes.
  }
  if (rcbToKit.get(rcbId) == null && !src) {
    // Placeholder plate until bytes exist — still Kit, not SVG.
    const x = Number(node.x) || 0;
    const y = Number(node.y) || 0;
    const w = Math.max(1, Number(node.width) || 1);
    const h = Math.max(1, Number(node.height) || 1);
    const kitId = scene.addRect(x, y, w, h);
    scene.setNodeStyleNoHistory(
      kitId,
      JSON.stringify({
        fills: [{ r: 0.92, g: 0.93, b: 0.95, a: 1 }],
        strokes: [],
        opacity: 1,
        blend_mode: 0,
        fill_rule: 0,
        corner_radius: 0,
        effects: [],
      })
    );
    remember(kitId, rcbId);
    resyncKitSelectionIfStoreSelected(rcbId);
    return;
  }
  // Upload / process: mount opacity-0 plate immediately so store→Kit selection
  // can paint the control box while SoftGlow runs and bytes are still fetching.
  if (rcbToKit.get(rcbId) == null && src && isNodeProcessRunning(node)) {
    const x = Number(node.x) || 0;
    const y = Number(node.y) || 0;
    const w = Math.max(1, Number(node.width) || 1);
    const h = Math.max(1, Number(node.height) || 1);
    const kitId = scene.addRect(x, y, w, h);
    applyKitNodeStyle(scene, kitId, node);
    remember(kitId, rcbId);
    resyncKitSelectionIfStoreSelected(rcbId);
  }
  const cached = imageBytesCache.get(src);
  if (cached) {
    commitImageBytesToKit(scene, rcbId, node, cached, src);
    return;
  }
  if (imageFetchInflight.has(src)) return;
  imageFetchInflight.add(src);
  void fetchImageBytes(src).then((data) => {
    imageFetchInflight.delete(src);
    if (!data || !attached) return;
    withSuppress(() => {
      const doc = store.getState().editor.document as SceneDocument | null;
      const live = doc?.deltaSetLike?.[rcbId];
      // Drop stale completions (blob fetch finishing after durable poster rebind).
      if (!live || kitStillRasterUrl(live) !== src) return;
      commitImageBytesToKit(attached!.scene, rcbId, live, data, src);
    });
  });
}

function pushNodeToKit(scene: WasmScene, rcbId: string, node: SceneNodeInput) {
  if (rcbToKit.has(rcbId)) return;
  if (isEmptyGeneratorPlate(node)) {
    pushRasterNodeToKit(scene, rcbId, node);
    return;
  }
  const key = String(node.key || '');
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  // Engine space is scene-absolute. Document may be frameLocal.
  const doc = store.getState().editor.document as SceneDocument | null;
  const origin = doc ? nodeLeftTop(doc, node) : { left: Number(node.x) || 0, top: Number(node.y) || 0 };
  const x = origin.left;
  const y = origin.top;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const shapeType = String(attrs.shapeType || (key === 'shape' ? 'rect' : key) || 'rect').toLowerCase();

  if (key === 'image' || key === 'video' || key === 'audio') {
    pushRasterNodeToKit(scene, rcbId, node);
    return;
  }

  let kitId: number | undefined;
  if (key === 'text') {
    const text = String(attrs.text || attrs.markdown || attrs.content || 'Text');
    const style = parseNodeTextStyle(attrs);
    const fontSize = Number(attrs.fontSize || attrs['font-size'] || style.fontSize || 16) || 16;
    const typo = kitTextTypoFromStyle(style);
    ensureKitFontFamily(typo.family);
    kitId = scene.addText(x, y, text, fontSize);
    if (kitId != null) {
      const align = kitTextAlignFromStyle(style.textAlign);
      const lh = Number(style.lineHeight) || 1.2;
      const deco = kitTextDecorationFlags(style);
      applyKitTextStyleNoHistory(scene, kitId, typo.weight, typo.italic, typo.letterSpacing);
      try {
        scene.setTextPropertiesNoHistory(kitId, typo.family, align, lh);
      } catch {
        /* optional */
      }
      applyKitTextDecoration(scene, kitId, style);
      lastKitTextSig.set(
        kitId,
        `${parseNodeMarkdown(attrs)}\0${fontSize}\0${typo.family}\0${typo.weight}\0${typo.italic ? 1 : 0}\0${typo.letterSpacing}\0${align}\0${lh}\0${deco}`
      );
      applyKitTextLayoutWidth(scene, kitId, node);
    }
  } else if (shapeType === 'circle' || shapeType === 'ellipse' || shapeType === 'oval') {
    if (ellipseNeedsVariantPath(attrs)) {
      const d = getShapeBaselineD(node);
      if (d) {
        kitId = scene.addPath(svgDToSubpathsJson(translatePathData(d, -w / 2, -h / 2)));
        if (kitId != null) {
          scene.engine?.set_node_position(kitId, x + w / 2, y + h / 2);
        }
      } else {
        kitId = scene.addEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
      }
    } else {
      kitId = scene.addEllipse(x + w / 2, y + h / 2, w / 2, h / 2);
    }
  } else if (
    shapeType === 'polygon' ||
    shapeType === 'triangle' ||
    shapeType === 'star'
  ) {
    // Always Path from shapeVertexPoints — never Kit addStar/addPolygon (circular
    // radius in max(w,h)/2). Handles and ink must share the same fitted corners.
    const d = getShapeBaselineD(node);
    if (d) {
      kitId = scene.addPath(svgDToSubpathsJson(translatePathData(d, -w / 2, -h / 2)));
      if (kitId != null) {
        scene.engine?.set_node_position(kitId, x + w / 2, y + h / 2);
      }
    }
  } else if (
    shapeType === 'path' ||
    shapeType === 'pen' ||
    shapeType === 'pencil' ||
    shapeType === 'line' ||
    shapeType === 'arrow'
  ) {
    const d = String(attrs.path || attrs.d || '');
    kitId = scene.addPath(svgDToSubpathsJson(d));
    if (kitId != null) {
      scene.engine?.set_node_position(kitId, x, y);
    }
  } else {
    kitId = scene.addRect(x, y, w, h);
  }
  if (kitId != null) {
    applyKitNodeStyle(scene, kitId, node);
    remember(kitId, rcbId);
    rememberParametricSig(rcbId, node);
  }
}

function applyKitArtboardFromFrame(
  scene: WasmScene,
  kitId: number,
  frame: {
    id?: unknown;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    backgroundColor?: string;
    backgroundOpacity?: number;
    name?: string;
    hidden?: unknown;
    kind?: unknown;
  }
) {
  const x = Number(frame.x) || 0;
  const y = Number(frame.y) || 0;
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);
  // Timeline focus: collapse non-focused Kit plates (HTML already gated).
  if (!isArtboardVisibleInDocument(frame)) {
    try {
      scene.engine?.set_artboard_bounds(kitId, x, y, 0, 0);
    } catch {
      /* ignore */
    }
    try {
      scene.engine?.set_artboard_background(kitId, 0, 0, 0, 0);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    scene.engine?.set_artboard_bounds(kitId, x, y, w, h);
  } catch {
    /* ignore */
  }
  if (frame.name != null && String(frame.name).trim() !== '') {
    try {
      scene.engine?.set_artboard_name(kitId, frame.name || 'Frame');
    } catch {
      /* ignore */
    }
  }
  const bg = parseCssColor(String(frame.backgroundColor || '#FFFFFF'));
  if (!bg) return;
  const opRaw = Number(frame.backgroundOpacity);
  const opacityPct = Number.isFinite(opRaw) ? Math.min(100, Math.max(0, opRaw)) : 100;
  const a = bg.a * (opacityPct / 100);
  try {
    scene.engine?.set_artboard_background(kitId, bg.r, bg.g, bg.b, a);
  } catch {
    /* ignore */
  }
}

function kitGeomKind(kn: { geometry?: unknown } | null | undefined): string {
  const g = kn?.geometry as Record<string, unknown> | undefined;
  if (!g) return '';
  if (g.Rect) return 'rect';
  if (g.Ellipse) return 'ellipse';
  if (g.Path) return 'path';
  if (g.Text) return 'text';
  if (g.Image) return 'image';
  return '';
}

function rcbGeomKind(node: SceneNodeInput): string {
  const key = String(node.key || '');
  if (key === 'text') return 'text';
  // Empty generators are Kit gray rects (wash + pick) — not Image textures.
  // Returning 'image' here remount-thrashed every reconcile → blank plate.
  if (isEmptyGeneratorPlate(node)) return 'rect';
  if (key === 'image' || key === 'video' || key === 'audio') return 'image';
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const shapeType = String(attrs.shapeType || key || 'rect').toLowerCase();
  if (shapeType === 'circle' || shapeType === 'ellipse' || shapeType === 'oval') {
    // Donut / pie / annular sector are Path in Kit — must match or reconcile thrash-remounts.
    return ellipseNeedsVariantPath(attrs) ? 'path' : 'ellipse';
  }
  if (
    shapeType === 'path' ||
    shapeType === 'pen' ||
    shapeType === 'pencil' ||
    shapeType === 'line' ||
    shapeType === 'arrow' ||
    shapeType === 'polygon' ||
    shapeType === 'star' ||
    shapeType === 'triangle'
  ) {
    return 'path';
  }
  return 'rect';
}

/** Incremental membership sync (paste / delete / undo) — not a continuous idle paint loop. */
export function reconcileKitWithDocument(
  handle: CanvasEngineHandle,
  document: SceneDocument | null | undefined
) {
  if (!document || suppressDepth > 0) return;
  const scene = handle.scene;
  let dirty = false;
  withSuppress(() => {
    const delta = document.deltaSetLike || {};
    for (const [kitId, rcbId] of [...kitToRcb.entries()]) {
      if (delta[rcbId]) continue;
      scene.removeNode(kitId);
      forgetKitTextChrome(scene, kitId);
      kitToRcb.delete(kitId);
      rcbToKit.delete(rcbId);
      forgetKitStyle(kitId);
      lastParametricSig.delete(rcbId);
      lastKitRasterSrc.delete(rcbId);
      dirty = true;
    }
    // Boolean / replace: path result reuses id but Kit still holds Rect → recreate.
    for (const [rcbId, kitId] of [...rcbToKit.entries()]) {
      const node = delta[rcbId];
      if (!node) continue;
      const kn = scene.getNode(kitId);
      const want = rcbGeomKind(node);
      const have = kitGeomKind(kn);
      if (!have || !want || have === want) continue;
      try {
        scene.removeNode(kitId);
      } catch {
        /* ignore */
      }
      kitToRcb.delete(kitId);
      rcbToKit.delete(rcbId);
      forgetKitTextChrome(scene, kitId);
      forgetKitStyle(kitId);
      lastParametricSig.delete(rcbId);
      lastKitRasterSrc.delete(rcbId);
      dirty = true;
    }
    const frames = new Set(
      (Array.isArray(document.frames) ? document.frames : [])
        .map((f) => String(f?.id || ''))
        .filter(Boolean)
    );
    for (const [kitId, frameId] of [...kitArtboardToFrame.entries()]) {
      if (frames.has(frameId)) continue;
      try {
        scene.engine?.remove_artboard(kitId);
      } catch {
        /* optional */
      }
      kitArtboardToFrame.delete(kitId);
      frameToKitArtboard.delete(frameId);
      dirty = true;
    }
    const mapSizeBefore = rcbToKit.size + frameToKitArtboard.size;
    for (const frame of Array.isArray(document.frames) ? document.frames : []) {
      if (!frame?.id || frameToKitArtboard.has(String(frame.id))) continue;
      const kitId = scene.addArtboard(
        Number(frame.x) || 0,
        Number(frame.y) || 0,
        Math.max(1, Number(frame.width) || 1),
        Math.max(1, Number(frame.height) || 1)
      );
      rememberFrame(kitId, String(frame.id));
      applyKitArtboardFromFrame(scene, kitId, frame);
      dirty = true;
    }
    for (const [id, node] of Object.entries(delta)) {
      if (!node || id === 'ROOT' || rcbToKit.has(id)) continue;
      const key = String(node.key || '');
      // DomHost FO owns these — never seed a Kit twin (double paint / hug race).
      if (isDomHostOnlyRcbNode(node)) continue;
      if ((key === 'lottie' || key === 'group') && !isEmptyGeneratorPlate(node)) continue;
      if (
        isEmptyGeneratorPlate(node) ||
        key === 'shape' ||
        key === 'text' ||
        key === 'rect' ||
        key === 'circle' ||
        key === 'image' ||
        key === 'video' ||
        key === 'audio'
      ) {
        pushNodeToKit(scene, id, node);
        dirty = true;
      }
    }
    for (const [rcbId, kitId] of [...rcbToKit.entries()]) {
      const node = delta[rcbId];
      if (!node) continue;
      const key = String(node.key || '');
      if (isEmptyGeneratorPlate(node) || key === 'image' || key === 'video' || key === 'audio') {
        // Upgrade placeholder → real Kit image when src/poster arrives.
        // Empty generators stay Kit gray rect + overlay glyph paint.
        pushRasterNodeToKit(scene, rcbId, node);
        dirty = true;
        continue;
      }
      // Kit: engine owns geometry. Never push RCB top-left/path mirrors back
      // into Kit on reconcile — that is the draw-then-jump / marquee desync loop.
      // Exception: parametric outline attrs (sides / IR / Ar) live in RCB chrome.
      const { left, top } = nodeLeftTop(document, node);
      const sig = parametricAttrsSig(node);
      let liveKitId = kitId;
      if (sig != null) {
        const prev = lastParametricSig.get(rcbId);
        if (prev !== sig && getShapeBaselineD(node)) {
          liveKitId = syncParametricKitShape(handle, rcbId, kitId, node, left, top);
          lastParametricSig.set(rcbId, sig);
          dirty = true;
        }
      } else {
        lastParametricSig.delete(rcbId);
      }
      // Remount may have replaced kitId — always style the live mapping.
      liveKitId = rcbToKit.get(rcbId) ?? liveKitId;
      // RCB→Kit geom only via syncKitGeometryFromDocument (chrome) / hydrate.
      applyKitNodeStyle(scene, liveKitId, node);
      dirty = true;
    }
    for (const [frameId, kitId] of frameToKitArtboard.entries()) {
      const frame = (Array.isArray(document.frames) ? document.frames : []).find(
        (f) => String(f?.id) === frameId
      );
      if (!frame) continue;
      applyKitArtboardFromFrame(scene, kitId, frame);
    }
    // Membership / style changes only — avoid idle requestRender storms when
    // React re-fires this effect with an unchanged scene.
    if (dirty || rcbToKit.size + frameToKitArtboard.size !== mapSizeBefore) {
      handle.renderer.requestRender();
    }
  });
  // clipContent / frameId can change with no Kit changeCounter — re-record clips.
  refreshKitArtboardClipPaint();
  // First generator spawn: store selection lands before Kit maps the plate.
  // Retry Store→Kit now that membership is current.
  const editor = store.getState().editor;
  syncKitSelectionFromStore(
    handle,
    editor.selectedNodeIds || [],
    editor.selectedFrameIds || []
  );
}

/**
 * Live drag/resize: push RCB preview geometry into Kit so ink tracks selection chrome.
 * Call on every geometry preview (not only documentRevision).
 */
export function syncKitGeometryFromDocument(
  handle: CanvasEngineHandle,
  document: SceneDocument | null | undefined,
  onlyIds?: Iterable<string>
) {
  if (!document || suppressDepth > 0) return;
  const scene = handle.scene;
  const delta = document.deltaSetLike || {};
  const idList = onlyIds ? [...onlyIds] : [...rcbToKit.keys()];
  withSuppress(() => {
    for (const rcbId of idList) {
      const kitId = rcbToKit.get(String(rcbId));
      const node = delta[String(rcbId)];
      if (kitId == null || !node) continue;
      const { left, top } = nodeLeftTop(document, node);
      applyKitNodeGeom(scene, kitId, node, { worldX: left, worldY: top });
      // Gradients store absolute local endpoints — re-push style so fill tracks
      // the new box (resize_node only stretches path/rect, not fill coords).
      applyKitNodeStyle(scene, kitId, node);
    }
    // engine.resize_node does not bump Kit caches. Empty-generator wash style
    // is unchanged across aspect presets, so applyKitNodeStyle is a no-op and
    // requestRender alone would replay the old landscape picture under a
    // portrait selection outline. Drop retained picture + path caches without
    // onMutate (false); same class of fix as refreshKitArtboardClipPaint.
    if (typeof scene.invalidateCache === 'function') {
      scene.invalidateCache(false);
    } else {
      try {
        handle.renderer.invalidateScenePicture?.();
      } catch {
        /* optional */
      }
      handle.renderer.requestRender();
    }
  });
}

/**
 * Publish TransformPreview boxes into Kit (playhead scrub / RCB chrome previews).
 * Overlays preview left/top/w/h/angle on the mapped document node.
 *
 * Transform-only: never rewrite path points (full invalidateCache storm) and
 * skip requestRender when no mapped preview actually applied.
 */
export function syncKitGeometryFromTransformPreviews(
  handle: CanvasEngineHandle,
  document: SceneDocument | null | undefined,
  onlyIds?: Iterable<string>
) {
  if (!document || suppressDepth > 0) return;
  const scene = handle.scene;
  const delta = document.deltaSetLike || {};
  const idList = onlyIds
    ? [...onlyIds].map(String)
    : listNodeTransformPreviewIds();
  // Empty map (incl. clear notify) — do not paint; caller may restore from doc.
  if (!idList.length) return;
  withSuppress(() => {
    const changedKitIds: number[] = [];
    for (const rcbId of idList) {
      const kitId = rcbToKit.get(rcbId);
      const node = delta[rcbId];
      const preview = getNodeTransformPreview(rcbId);
      if (kitId == null || !node || !preview) continue;
      // Angle/hide-only sentinels use NaN box — keep document geometry.
      const x = Number.isFinite(preview.left) ? preview.left : Number(node.x) || 0;
      const y = Number.isFinite(preview.top) ? preview.top : Number(node.y) || 0;
      const width = Number.isFinite(preview.width)
        ? Math.max(1, preview.width)
        : Math.max(1, Number(node.width) || 1);
      const height = Number.isFinite(preview.height)
        ? Math.max(1, preview.height)
        : Math.max(1, Number(node.height) || 1);
      const angle =
        preview.angle !== undefined && Number.isFinite(preview.angle)
          ? preview.angle
          : Number(node.attrs?.angle) || 0;
      applyKitNodeGeom(
        scene,
        kitId,
        {
          ...node,
          x,
          y,
          width,
          height,
          attrs: { ...(node.attrs || {}), angle },
        },
        { syncPath: false }
      );
      changedKitIds.push(kitId);
    }
    if (!changedKitIds.length) return;
    // Transform-only invalidation (no path/gradient wipe) + one frame.
    if (typeof scene.invalidateCacheTransformOnly === 'function') {
      scene.invalidateCacheTransformOnly(changedKitIds);
    } else {
      handle.renderer.requestRender();
    }
  });
}

/**
 * Store → Kit selection (layers / paste / external chrome only).
 * Kit: canvas pick/marquee/move live in the engine — never fight that with a
 * React effect that clear_selection + re-select every store tick.
 * KitCanvasHost skips this when {@link getKitSelectionMirrorGeneration} shows
 * the store update was an echo of Kit→store.
 */
export function syncKitSelectionFromStore(
  handle: CanvasEngineHandle,
  selectedNodeIds: readonly string[],
  selectedFrameIds: readonly string[] = []
) {
  if (suppressDepth > 0) return;
  if (handle.input?.isMouseDown) return;
  const nodes = (selectedNodeIds || []).map(String).filter(Boolean);
  const frames = (selectedFrameIds || []).map(String).filter(Boolean);

  // Empty store while Kit still has a selection → pull Kit→store (do not wipe chrome).
  if (!nodes.length && !frames.length) {
    const kitSel = Array.from(handle.scene.getSelection?.() || []);
    if (kitSel.length) {
      flushSelectionToStore(handle, { force: true });
      return;
    }
  }

  const key = `${nodes.join(',')}|${frames.join(',')}`;
  const kitIds = Array.from(handle.scene.getSelection?.() || []);
  const kitNodeKey = kitIds
    .map((id) => kitToRcb.get(id))
    .filter((id): id is string => Boolean(id))
    .sort()
    .join(',');
  const wantNodeKey = [...nodes].sort().join(',');
  const chromeMode =
    store.getState().editor.frameChromeMode === 'full' ? 'full' : 'soft';
  // Soft plate focus: Kit recolors the plate stroke (softArtboardId) — do not
  // set selectedArtboardId (that paints full handles / title drag chrome).
  // Multi-frame full: keep selectedArtboardId on primary for Kit body-drag, and
  // stamp rcbSelectedArtboardKitIds so drawArtboards paints the union control box.
  const kitFrameIds = frames
    .map((fid) => frameToKitArtboard.get(fid))
    .filter((id): id is number => id != null);
  const wantAb =
    chromeMode === 'full' && frames[0] != null
      ? frameToKitArtboard.get(frames[0]) ?? null
      : null;
  const curAb =
    (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId ?? null;
  const artboardMatches =
    wantAb == null ? curAb == null : wantAb === curAb;
  const kitMatchesWant = kitNodeKey === wantNodeKey && artboardMatches;

  const stampMultiArtboards = () => {
    const r = handle.renderer as {
      rcbSelectedArtboardKitIds?: number[];
    };
    r.rcbSelectedArtboardKitIds =
      chromeMode === 'full' && kitFrameIds.length > 1 ? kitFrameIds : [];
  };

  if (kitMatchesWant) {
    lastSelKey = key;
    stampMultiArtboards();
    syncKitArtboardChromeHighlight(handle);
    handle.renderer.requestRender();
    return;
  }

  lastSelKey = key;
  let applied = 0;
  withSuppress(() => {
    try {
      handle.scene.engine?.clear_selection();
    } catch {
      /* ignore */
    }
    (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId = null;
    let multi = false;
    for (const rcbId of nodes) {
      const kitId = rcbToKit.get(rcbId);
      if (kitId == null) continue;
      try {
        handle.scene.selectNode(kitId, multi);
        multi = true;
        applied += 1;
      } catch {
        /* ignore */
      }
    }
    const frameId = frames[0];
    if (frameId && chromeMode === 'full') {
      const ab = frameToKitArtboard.get(frameId);
      if (ab != null) {
        (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId = ab;
        applied += 1;
      }
    } else if (frameId && chromeMode === 'soft') {
      applied += 1;
    }
    stampMultiArtboards();
    // Tool stays with Kit InputManager / toolbar setTool — do not re-assert
    // 'selection' here (that fought create one-shot + path-edit).
    syncKitArtboardChromeHighlight(handle);
    handle.renderer.requestRender();
  });
  // Store selected a node/frame before Kit mapped it — leave lastSelKey unset
  // so reconcile can retry once the mapping exists.
  if (applied === 0 && (nodes.length || frames.length)) {
    lastSelKey = '';
  }
}

/** Rebuild Kit scene from SceneDocument once (load / reload). */
export function hydrateKitFromDocument(
  handle: CanvasEngineHandle,
  document: SceneDocument | null | undefined,
  hydrateKey: string
) {
  if (!document || hydrateKey === lastHydrateKey) return;
  lastHydrateKey = hydrateKey;
  const scene = handle.scene;
  withSuppress(() => {
    kitToRcb.clear();
    rcbToKit.clear();
    kitArtboardToFrame.clear();
    frameToKitArtboard.clear();
    lastKitStyleJson.clear();
    lastKitEffectsJson.clear();
    lastParametricSig.clear();
    lastKitRasterSrc.clear();
    scene.newDocument();
    // Engine::new seeds "Artwork 1" — strip without history so Undo cannot
    // resurrect it while the user is resizing shapes.
    stripKitSeedArtboards(scene);
    const rawFrames = Array.isArray(document.frames) ? document.frames : [];
    const seenFrameIds = new Set<string>();
    const frames = rawFrames.filter((frame) => {
      const id = String(frame?.id || '');
      if (!id || seenFrameIds.has(id)) return false;
      seenFrameIds.add(id);
      return true;
    });
    if (frames.length !== rawFrames.length) {
      // Repair duplicated kit* frames left by older bridge flushes.
      mirrorKitDocument({ ...normalizeDocument(document), frames });
    }
    for (const frame of frames) {
      if (!frame?.id) continue;
      const kitId = scene.addArtboard(
        Number(frame.x) || 0,
        Number(frame.y) || 0,
        Math.max(1, Number(frame.width) || 1),
        Math.max(1, Number(frame.height) || 1)
      );
      rememberFrame(kitId, String(frame.id));
      applyKitArtboardFromFrame(scene, kitId, frame);
    }
    const delta = document.deltaSetLike || {};
    for (const [id, node] of Object.entries(delta)) {
      if (!node || id === 'ROOT') continue;
      if (isDomHostOnlyRcbNode(node)) continue;
      const key = String(node.key || '');
      if ((key === 'lottie' || key === 'group') && !isEmptyGeneratorPlate(node)) continue;
      if (
        isEmptyGeneratorPlate(node) ||
        key === 'shape' ||
        key === 'text' ||
        key === 'rect' ||
        key === 'circle' ||
        key === 'image' ||
        key === 'video' ||
        key === 'audio'
      ) {
        pushNodeToKit(scene, id, node);
      }
    }
    handle.renderer.requestRender();
  });
  lastArtboardClipPaintSig = '';
  refreshKitArtboardClipPaint(true);
  // Hydrate/remap can finish after store already selected upload placeholders.
  const ed = store.getState().editor;
  syncKitSelectionFromStore(
    handle,
    ed.selectedNodeIds || [],
    ed.selectedFrameIds || []
  );
}

function emptyGeneratorIconKind(
  node: SceneNodeInput | null | undefined
): GeneratorEmptyIconKind | null {
  if (!node) return null;
  if (isImageGeneratorNode(node) || isLottieGeneratorNode(node)) return 'image';
  if (isVideoGeneratorNode(node)) return 'video';
  if (isAudioGeneratorNode(node)) return 'audio';
  return null;
}

/** True when Kit selection is only empty generator plates (outline, no handles). */
function kitSelectionIsEmptyGeneratorsOnly(handle: CanvasEngineHandle): boolean {
  const sel = Array.from(handle.scene.getSelection?.() || []);
  if (!sel.length) return false;
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc?.deltaSetLike) return false;
  for (const kitId of sel) {
    const rcbId = kitToRcb.get(kitId);
    if (!rcbId) return false;
    if (!isEmptyGeneratorPlate(doc.deltaSetLike[rcbId])) return false;
  }
  return true;
}

let processGlowRaf = 0;

function hasActiveProcessGlow(): boolean {
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (doc && listProcessingNodeIds(doc).length > 0) return true;
  const ai = editor.aiOperationState;
  return Boolean(ai?.active && ai.frameId);
}

function ensureProcessGlowAnimation(handle: CanvasEngineHandle) {
  if (processGlowRaf || !hasActiveProcessGlow()) return;
  const tick = () => {
    if (!attached || attached !== handle || !hasActiveProcessGlow()) {
      processGlowRaf = 0;
      return;
    }
    try {
      handle.renderer.requestRender();
    } catch {
      /* ignore */
    }
    processGlowRaf = requestAnimationFrame(tick);
  };
  processGlowRaf = requestAnimationFrame(tick);
}

function stopProcessGlowAnimation() {
  if (!processGlowRaf) return;
  cancelAnimationFrame(processGlowRaf);
  processGlowRaf = 0;
}

/** Kit-local SoftGlow for processing nodes + AI-generating artboards. */
function drawProcessingPlates(handle: CanvasEngineHandle, canvas: unknown, dpr: number) {
  if (!hasActiveProcessGlow()) return;
  ensureProcessGlowAnimation(handle);

  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  const timeMs = performance.now();

  const renderer = handle.renderer as {
    ck: {
      Paint: new () => {
        setStyle: (s: unknown) => void;
        setShader?: (s: unknown | null) => void;
        setColor: (c: unknown) => void;
        setAntiAlias: (v: boolean) => void;
        delete: () => void;
      };
      PaintStyle: { Fill: unknown };
      Color4f?: (r: number, g: number, b: number, a: number) => unknown;
      Color: (r: number, g: number, b: number, a: number) => unknown;
      LTRBRect?: (l: number, t: number, r: number, b: number) => unknown;
      ClipOp?: { Intersect: unknown };
    };
    zoom: number;
    pan: { x: number; y: number };
  };
  const ck = renderer.ck;
  const c = canvas as {
    save: () => void;
    restore: () => void;
    scale: (x: number, y: number) => void;
    translate: (x: number, y: number) => void;
    concat: (m: unknown) => void;
    clipRect?: (r: unknown, op: unknown, aa: boolean) => void;
    drawRect: (r: unknown, paint: unknown) => void;
    drawCircle?: (cx: number, cy: number, r: number, paint: unknown) => void;
  };
  const paint = new ck.Paint();
  paint.setAntiAlias(true);

  c.save();
  c.scale(dpr, dpr);
  c.translate(renderer.pan.x, renderer.pan.y);
  c.scale(renderer.zoom, renderer.zoom);

  if (doc?.deltaSetLike) {
    for (const rcbId of listProcessingNodeIds(doc)) {
      const node = doc.deltaSetLike[rcbId];
      const kitId = rcbToKit.get(rcbId);
      if (!node || kitId == null || isEmptyGeneratorPlate(node)) continue;

      // World AABB — Image/Path local origins differ; never concat(getTransform)
      // with document width (that stretched SoftGlow into a huge black plate).
      let x = Number(node.x) || 0;
      let y = Number(node.y) || 0;
      let w = Math.max(1, Number(node.width) || 1);
      let h = Math.max(1, Number(node.height) || 1);
      const aabb = kitNodeWorldAabb(handle.scene, kitId);
      if (aabb) {
        x = aabb.minX;
        y = aabb.minY;
        w = aabb.maxX - aabb.minX;
        h = aabb.maxY - aabb.minY;
      }
      if (!(w > 0) || !(h > 0)) continue;

      c.save();
      try {
        const clip = kitNodeArtboardClipRect(handle, kitId);
        if (clip && clip.w > 0 && clip.h > 0 && c.clipRect && ck.LTRBRect && ck.ClipOp) {
          c.clipRect(
            ck.LTRBRect(clip.x, clip.y, clip.x + clip.w, clip.y + clip.h),
            ck.ClipOp.Intersect,
            true
          );
        }
      } catch {
        /* ignore artboard clip */
      }
      try {
        c.translate(x, y);
        paintKitProcessPlateLocal(c, ck, paint, w, h, rcbId, timeMs);
      } catch {
        /* skip node */
      }
      c.restore();
    }
  }

  const ai = editor.aiOperationState;
  if (ai?.active && ai.frameId) {
    const abId = frameToKitArtboard.get(String(ai.frameId));
    if (abId != null) {
      const ab = handle.scene.getArtboards().find((a) => a.id === abId);
      if (ab && ab.w > 0 && ab.h > 0) {
        c.save();
        c.translate(ab.x, ab.y);
        paintKitProcessPlateLocal(c, ck, paint, ab.w, ab.h, String(ai.frameId), timeMs);
        c.restore();
      }
    }
  }

  c.restore();
  paint.delete();
}

/** World AABB from Kit bounds (`[minX,minY,maxX,maxY]`), or null. */
function kitNodeWorldAabb(
  scene: { getNodeBounds: (id: number) => ArrayLike<number> | null | undefined },
  kitId: number
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  try {
    const b = scene.getNodeBounds(kitId);
    if (!b || b.length < 4) return null;
    const minX = Number(b[0]);
    const minY = Number(b[1]);
    const maxX = Number(b[2]);
    const maxY = Number(b[3]);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
    if (!(maxX > minX) || !(maxY > minY)) return null;
    return { minX, minY, maxX, maxY };
  } catch {
    return null;
  }
}

/** CanvasKit: 1 CSS px plate hairline + filled empty-gen glyphs (never squash). */
function drawEmptyGeneratorIcons(handle: CanvasEngineHandle, canvas: unknown, dpr: number) {
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc?.deltaSetLike) return;
  const renderer = handle.renderer as {
    ck: {
      Paint: new () => {
        setStyle: (s: unknown) => void;
        setAntiAlias: (v: boolean) => void;
        setColor: (c: unknown) => void;
        setStrokeWidth: (w: number) => void;
        setStrokeCap: (c: unknown) => void;
        setStrokeJoin: (j: unknown) => void;
        delete: () => void;
      };
      Path: {
        new (): {
          moveTo: (x: number, y: number) => void;
          lineTo: (x: number, y: number) => void;
          close?: () => void;
          addCircle?: (cx: number, cy: number, r: number) => void;
          addRect?: (r: unknown) => void;
          delete: () => void;
        };
        MakeFromSVGString?: (d: string) => { delete: () => void } | null;
      };
      PaintStyle: { Stroke: unknown; Fill: unknown };
      StrokeCap: { Round: unknown; Butt?: unknown };
      StrokeJoin: { Round: unknown; Miter?: unknown };
      Color: (r: number, g: number, b: number, a: number) => unknown;
      LTRBRect?: (l: number, t: number, r: number, b: number) => unknown;
      XYWHRect?: (x: number, y: number, w: number, h: number) => unknown;
      ClipOp?: { Intersect: unknown };
    };
    zoom: number;
    pan: { x: number; y: number };
  };
  const ck = renderer.ck;
  const c = canvas as {
    save: () => void;
    restore: () => void;
    scale: (x: number, y: number) => void;
    translate: (x: number, y: number) => void;
    concat: (m: unknown) => void;
    drawPath: (path: unknown, paint: unknown) => void;
    drawRect?: (r: unknown, paint: unknown) => void;
    drawCircle?: (cx: number, cy: number, r: number, paint: unknown) => void;
    clipRect?: (r: unknown, op: unknown, aa: boolean) => void;
  };
  const zoom = Math.max(0.05, Number(renderer.zoom) || 1);
  const plateSw = GENERATOR_EMPTY_PLATE_STROKE_WIDTH / zoom;
  const plateRgb = generatorEmptyCssRgb(GENERATOR_EMPTY_PLATE_STROKE);
  const iconRgb = generatorEmptyCssRgb(GENERATOR_EMPTY_ICON_COLOR);

  const paint = new ck.Paint();
  paint.setAntiAlias(true);

  c.save();
  c.scale(dpr, dpr);
  c.translate(renderer.pan.x, renderer.pan.y);
  c.scale(renderer.zoom, renderer.zoom);

  for (const [rcbId, kitId] of rcbToKit.entries()) {
    const node = doc.deltaSetLike[rcbId];
    if (!isEmptyGeneratorPlate(node)) continue;
    const kind = emptyGeneratorIconKind(node);
    if (!kind) continue;
    const kn = handle.scene.getNode(kitId);
    const rect = kn?.geometry?.Rect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) continue;
    const w = rect.width;
    const h = rect.height;

    // World AABB — icon size/placement must ignore non-uniform node scale
    // (16:9 plates used to squash Lucide strokes via concat(transform)).
    let worldW = w;
    let worldH = h;
    let worldCx = w / 2;
    let worldCy = h / 2;
    let haveWorld = false;
    const aabb = kitNodeWorldAabb(handle.scene, kitId);
    if (aabb) {
      worldW = aabb.maxX - aabb.minX;
      worldH = aabb.maxY - aabb.minY;
      worldCx = (aabb.minX + aabb.maxX) / 2;
      worldCy = (aabb.minY + aabb.maxY) / 2;
      haveWorld = true;
    }
    const icon = generatorEmptyIconSize(worldW, worldH, zoom);

    c.save();
    try {
      const clip = kitNodeArtboardClipRect(handle, kitId);
      if (clip && clip.w > 0 && clip.h > 0 && c.clipRect && ck.LTRBRect && ck.ClipOp) {
        c.clipRect(
          ck.LTRBRect(clip.x, clip.y, clip.x + clip.w, clip.y + clip.h),
          ck.ClipOp.Intersect,
          true
        );
      }
    } catch {
      /* ignore clip */
    }

    // Idle plate hairline in local node space (follows plate transform).
    c.save();
    try {
      c.concat(handle.scene.getTransform(kitId));
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeCap(ck.StrokeCap.Butt ?? ck.StrokeCap.Round);
      paint.setStrokeJoin(ck.StrokeJoin.Miter ?? ck.StrokeJoin.Round);
      paint.setStrokeWidth(plateSw);
      paint.setColor(ck.Color(plateRgb.r, plateRgb.g, plateRgb.b, 1));
      const inset = plateSw / 2;
      const x0 = inset;
      const y0 = inset;
      const x1 = Math.max(inset, w - inset);
      const y1 = Math.max(inset, h - inset);
      if (typeof c.drawRect === 'function' && ck.LTRBRect) {
        c.drawRect(ck.LTRBRect(x0, y0, x1, y1), paint);
      } else {
        const edge = new ck.Path();
        edge.moveTo(x0, y0);
        edge.lineTo(x1, y0);
        edge.lineTo(x1, y1);
        edge.lineTo(x0, y1);
        edge.lineTo(x0, y0);
        c.drawPath(edge, paint);
        edge.delete();
      }
    } catch {
      /* skip edge */
    }
    c.restore();

    if (generatorEmptyIconVisible(icon)) {
      // Filled glyphs in WORLD space — uniform scale only (图1 play / 图2 landscape / 图3 bars).
      c.save();
      if (haveWorld) {
        c.translate(worldCx - icon / 2, worldCy - icon / 2);
      } else {
        try {
          c.concat(handle.scene.getTransform(kitId));
        } catch {
          c.restore();
          c.restore();
          continue;
        }
        c.translate((w - icon) / 2, (h - icon) / 2);
      }
      c.scale(icon / 24, icon / 24);
      paint.setColor(ck.Color(iconRgb.r, iconRgb.g, iconRgb.b, 1));
      drawGeneratorEmptyFilledOnCk(ck, c, paint, kind);
      c.restore();
    }
    c.restore();
  }

  c.restore();
  paint.delete();
}

function drawGeneratorEmptyFilledOnCk(
  ck: {
    Path: {
      new (): {
        moveTo: (x: number, y: number) => void;
        lineTo: (x: number, y: number) => void;
        close?: () => void;
        delete: () => void;
      };
      MakeFromSVGString?: (d: string) => { delete: () => void } | null;
    };
    PaintStyle: { Stroke: unknown; Fill: unknown };
    StrokeCap: { Round: unknown };
  },
  c: {
    drawPath: (path: unknown, paint: unknown) => void;
    drawCircle?: (cx: number, cy: number, r: number, paint: unknown) => void;
  },
  paint: {
    setStyle: (s: unknown) => void;
    setStrokeWidth: (w: number) => void;
    setStrokeCap: (c: unknown) => void;
  },
  kind: GeneratorEmptyIconKind
) {
  const makeSvg = ck.Path.MakeFromSVGString?.bind(ck.Path);

  if (kind === 'audio') {
    paint.setStyle(ck.PaintStyle.Stroke);
    paint.setStrokeCap(ck.StrokeCap.Round);
    paint.setStrokeWidth(GEN_AUDIO_BAR_STROKE);
    for (const [x, y0, y1] of GEN_AUDIO_BARS) {
      const path = new ck.Path();
      path.moveTo(x, y0);
      path.lineTo(x, y1);
      c.drawPath(path, paint);
      path.delete();
    }
    return;
  }

  paint.setStyle(ck.PaintStyle.Fill);
  if (kind === 'video') {
    const p = makeSvg?.(GEN_VIDEO_PLAY_PATH);
    if (p) {
      c.drawPath(p, paint);
      p.delete();
      return;
    }
    const tri = new ck.Path();
    tri.moveTo(9, 6.5);
    tri.lineTo(9, 17.5);
    tri.lineTo(18, 12);
    tri.close?.();
    c.drawPath(tri, paint);
    tri.delete();
    return;
  }

  // image — sun + mountains
  if (typeof c.drawCircle === 'function') {
    c.drawCircle(GEN_IMAGE_SUN.cx, GEN_IMAGE_SUN.cy, GEN_IMAGE_SUN.r, paint);
  } else {
    const circ = makeSvg?.(
      `M ${GEN_IMAGE_SUN.cx - GEN_IMAGE_SUN.r} ${GEN_IMAGE_SUN.cy} a ${GEN_IMAGE_SUN.r} ${GEN_IMAGE_SUN.r} 0 1 0 ${GEN_IMAGE_SUN.r * 2} 0 a ${GEN_IMAGE_SUN.r} ${GEN_IMAGE_SUN.r} 0 1 0 ${-GEN_IMAGE_SUN.r * 2} 0`
    );
    if (circ) {
      c.drawPath(circ, paint);
      circ.delete();
    }
  }
  const mt = makeSvg?.(GEN_IMAGE_MOUNTAIN_PATH);
  if (mt) {
    c.drawPath(mt, paint);
    mt.delete();
    return;
  }
  const poly = new ck.Path();
  poly.moveTo(3.2, 18.2);
  poly.lineTo(9.4, 8.6);
  poly.lineTo(12.8, 13.4);
  poly.lineTo(16.2, 9.2);
  poly.lineTo(20.8, 18.2);
  poly.close?.();
  c.drawPath(poly, paint);
  poly.delete();
}

/**
 * Ownership / clipContent fingerprint for Kit-mapped nodes (no live bounds —
 * plate drag already invalidates via move_nodes / invalidateCache).
 */
function artboardClipPaintSig(): string {
  const doc = store.getState().editor.document as SceneDocument | null;
  if (!doc?.deltaSetLike) return '';
  const focus = getAnimationWorkbenchTimelineFocus() || '';
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const frameById = new Map(
    frames.map((f) => [String(f?.id || ''), f] as const).filter(([id]) => Boolean(id))
  );
  const parts: string[] = [`focus:${focus}`];
  for (const frame of frames) {
    const id = String(frame?.id || '').trim();
    if (!id) continue;
    const shown = isArtboardVisibleInDocument(frame) ? 1 : 0;
    const on = frame.clipContent !== false && !frame.hidden ? 1 : 0;
    parts.push(`f:${id}:${on}:${shown}`);
  }
  for (const rcbId of rcbToKit.keys()) {
    const node = doc.deltaSetLike[rcbId] as
      | { attrs?: Record<string, unknown> }
      | undefined;
    const frameId = String(node?.attrs?.frameId || '').trim();
    if (!frameId) continue;
    const frame = frameById.get(frameId);
    const on =
      frame && frame.clipContent !== false && !frame.hidden ? 1 : 0;
    const shown = frame && isArtboardVisibleInDocument(frame) ? 1 : 0;
    parts.push(`n:${rcbId}:${frameId}:${on}:${shown}`);
  }
  parts.sort();
  return parts.join('|');
}

/**
 * Clips bake into Kit's retained scene picture at record time. Changing
 * frameId / clipContent without bumping changeCounter leaves requestRender
 * replaying an unclipped (or stale) picture — invalidate then redraw.
 */
function refreshKitArtboardClipPaint(force = false) {
  const handle = attached;
  if (!handle) return;
  const sig = artboardClipPaintSig();
  if (!force && sig === lastArtboardClipPaintSig) return;
  lastArtboardClipPaintSig = sig;
  try {
    handle.renderer.invalidateScenePicture?.();
  } catch {
    /* optional */
  }
  try {
    handle.renderer.requestRender();
  } catch {
    /* optional */
  }
}

/**
 * World-space clip rect for a Kit node when its RCB frame has clipContent.
 * SoftGlow / process reveal temporarily returns null so glow can spill.
 */
function kitNodeArtboardClipRect(
  handle: CanvasEngineHandle,
  kitNodeId: number
): { x: number; y: number; w: number; h: number } | null {
  const rcbId = kitToRcb.get(kitNodeId);
  if (!rcbId) return null;
  if (frameClipRevealsOverflow(rcbId)) return null;
  const doc = store.getState().editor.document as SceneDocument | null;
  if (!doc) return null;
  const node = doc.deltaSetLike?.[rcbId] as Record<string, unknown> | undefined;
  if (!node) return null;
  const frame = findClippingFrameForNode(doc, node);
  if (!frame) return null;
  // Timeline focus: never fall back to full plate bounds for a hidden workbench —
  // collapsed Kit artboards (0×0) used to miss this check and unclip other plates' paths.
  if (!isArtboardVisibleInDocument(frame)) {
    return {
      x: Number(frame.x) || 0,
      y: Number(frame.y) || 0,
      w: 0,
      h: 0,
    };
  }
  // Kit artboard bounds are authoritative world space (incl. mid-drag).
  const abId = frameToKitArtboard.get(String(frame.id));
  if (abId != null) {
    try {
      const ab = handle.scene.getArtboards().find((a) => a.id === abId);
      if (ab && ab.w > 0 && ab.h > 0) {
        return { x: ab.x, y: ab.y, w: ab.w, h: ab.h };
      }
    } catch {
      /* fall through */
    }
  }
  const w = Math.max(1, Number(frame.width) || 1);
  const h = Math.max(1, Number(frame.height) || 1);
  return {
    x: Number(frame.x) || 0,
    y: Number(frame.y) || 0,
    w,
    h,
  };
}

type KitHitScene = {
  hitTest: (x: number, y: number) => number | undefined;
  hitTestGrouped?: (x: number, y: number) => number | undefined;
  __rcbClipHitWrapped?: boolean;
  __rcbOrigHitTest?: (x: number, y: number) => number | undefined | null;
  __rcbOrigHitTestGrouped?: (x: number, y: number) => number | undefined | null;
};

function pointInClip(
  clip: { x: number; y: number; w: number; h: number },
  x: number,
  y: number
): boolean {
  return x >= clip.x && x <= clip.x + clip.w && y >= clip.y && y <= clip.y + clip.h;
}

/** Kit select must match clipped ink — ignore hits on overflow outside the plate.
 * Also skip 动画工作台 preview children / host (timeline closed) so clicks soft-select
 * the plate instead of editing insides. */
function wrapKitHitTestForArtboardClip(handle: CanvasEngineHandle) {
  const scene = handle.scene as unknown as KitHitScene;
  if (scene.__rcbClipHitWrapped) return;

  const gateHit = (
    id: number | undefined | null,
    x: number,
    y: number
  ): number | undefined => {
    // Must return `undefined` (not `null`) on miss — Kit uses `!== undefined`
    // for empty pasteboard → marquee. `null` was treated as a hit (id 0).
    if (id == null) return undefined;
    const clip = kitNodeArtboardClipRect(handle, id);
    if (clip && !pointInClip(clip, x, y)) return undefined;
    const rcbId = kitToRcb.get(id);
    if (!rcbId) return id;
    const raw = store.getState().editor.document;
    const doc = raw ? normalizeDocument(raw) : null;
    const node = doc?.deltaSetLike?.[rcbId];
    if (!doc || !node) return id;
    // Timeline-closed workbench: ink is preview-only — not pickable.
    if (
      isAnimationFrameHostNode(node, doc) ||
      isAnimationWorkbenchPreviewChild(doc, node) ||
      !isNodePickableInDocument(doc, node)
    ) {
      return undefined;
    }
    return id;
  };

  scene.__rcbOrigHitTest = scene.hitTest.bind(scene);
  scene.hitTest = (x, y) => gateHit(scene.__rcbOrigHitTest?.(x, y), x, y);
  if (typeof scene.hitTestGrouped === 'function') {
    scene.__rcbOrigHitTestGrouped = scene.hitTestGrouped.bind(scene);
    scene.hitTestGrouped = (x, y) =>
      gateHit(scene.__rcbOrigHitTestGrouped?.(x, y), x, y);
  }
  scene.__rcbClipHitWrapped = true;
}

function unwrapKitHitTestForArtboardClip(handle: CanvasEngineHandle) {
  const scene = handle.scene as unknown as KitHitScene;
  if (!scene.__rcbClipHitWrapped) return;
  if (scene.__rcbOrigHitTest) scene.hitTest = scene.__rcbOrigHitTest;
  if (scene.__rcbOrigHitTestGrouped && scene.hitTestGrouped) {
    scene.hitTestGrouped = scene.__rcbOrigHitTestGrouped;
  }
  delete scene.__rcbClipHitWrapped;
  delete scene.__rcbOrigHitTest;
  delete scene.__rcbOrigHitTestGrouped;
}

type KitArtboardContainInput = {
  artboardContainedRoots?: (ab: { id: number; x: number; y: number; w: number; h: number }) => number[];
  __rcbOrigArtboardContainedRoots?: (ab: {
    id: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }) => number[];
  __rcbArtboardContainWrapped?: boolean;
};

/**
 * Kit stock containment uses AABB center-in-rect. Product binding is
 * attrs.frameId — patch so plate move carries every mapped child, not only
 * roots whose center still sits inside the plate.
 */
function wrapKitArtboardContainedRoots(handle: CanvasEngineHandle) {
  const input = handle.input as unknown as KitArtboardContainInput;
  if (!input || input.__rcbArtboardContainWrapped) return;
  if (typeof input.artboardContainedRoots !== 'function') return;
  input.__rcbOrigArtboardContainedRoots = input.artboardContainedRoots.bind(input);
  input.artboardContainedRoots = (ab) => {
    const frameId = kitArtboardToFrame.get(ab.id);
    if (frameId) {
      const bound = kitIdsBoundToFrame(frameId);
      if (bound.length) return bound;
    }
    return input.__rcbOrigArtboardContainedRoots?.(ab) ?? [];
  };
  input.__rcbArtboardContainWrapped = true;
}

function unwrapKitArtboardContainedRoots(handle: CanvasEngineHandle) {
  const input = handle.input as unknown as KitArtboardContainInput;
  if (!input?.__rcbArtboardContainWrapped) return;
  if (input.__rcbOrigArtboardContainedRoots) {
    input.artboardContainedRoots = input.__rcbOrigArtboardContainedRoots;
  }
  delete input.__rcbArtboardContainWrapped;
  delete input.__rcbOrigArtboardContainedRoots;
}

type KitArtboardBodyRenderer = {
  artboardBodyHitTest?: (wx: number, wy: number) => number | null;
  __rcbOrigArtboardBodyHitTest?: (wx: number, wy: number) => number | null;
  __rcbArtboardBodyWrapped?: boolean;
};

/**
 * Occupied plates: Kit stock path is selectArtboard + beginArtboardDrag on body
 * miss. Product rule ({@link frameIsEmpty} / resolveFramePlateDragMode) is
 * marquee / soft select — return null so InputManager falls through to marquee,
 * and stash the frame for a click soft-select.
 */
function wrapKitOccupiedArtboardBody(handle: CanvasEngineHandle) {
  const renderer = handle.renderer as unknown as KitArtboardBodyRenderer;
  if (!renderer || renderer.__rcbArtboardBodyWrapped) return;
  if (typeof renderer.artboardBodyHitTest !== 'function') return;
  renderer.__rcbOrigArtboardBodyHitTest = renderer.artboardBodyHitTest.bind(renderer);
  renderer.artboardBodyHitTest = (wx, wy) => {
    const id = renderer.__rcbOrigArtboardBodyHitTest?.(wx, wy) ?? null;
    if (id == null) {
      pendingSoftArtboardFrameId = null;
      return null;
    }
    const frameId = kitArtboardToFrame.get(id);
    if (!frameId) return id;
    const raw = store.getState().editor.document;
    const doc = raw ? normalizeDocument(raw) : null;
    if (doc && !frameIsEmpty(doc, frameId)) {
      pendingSoftArtboardFrameId = frameId;
      return null;
    }
    pendingSoftArtboardFrameId = null;
    return id;
  };
  renderer.__rcbArtboardBodyWrapped = true;
}

function unwrapKitOccupiedArtboardBody(handle: CanvasEngineHandle) {
  const renderer = handle.renderer as unknown as KitArtboardBodyRenderer;
  if (!renderer?.__rcbArtboardBodyWrapped) return;
  if (renderer.__rcbOrigArtboardBodyHitTest) {
    renderer.artboardBodyHitTest = renderer.__rcbOrigArtboardBodyHitTest;
  }
  delete renderer.__rcbArtboardBodyWrapped;
  delete renderer.__rcbOrigArtboardBodyHitTest;
  pendingSoftArtboardFrameId = null;
}

/**
 * Never call engine APIs synchronously from onMutate.
 * InputManager.transaction does: addRect → invalidateCache → onMutate → setNodeStyle.
 * A sync flushCreates/getSceneJson here re-enters WASM and throws
 * "recursive use of an object" — poisoning get_selection / render forever.
 */
function capturePendingCreateTool() {
  const editor = store.getState().editor;
  const fromStore =
    editor.activeTool === 'shape'
      ? String(editor.shapeKind || 'rect')
      : String(editor.activeTool || '');
  const storeTool = fromStore.toLowerCase();
  // Product create tools / shapeKinds that kitNodeToCreated understands.
  const PRODUCT_CREATE = new Set([
    'rect',
    'rectangle',
    'circle',
    'ellipse',
    'oval',
    'polygon',
    'star',
    'line',
    'arrow',
    'pen',
    'pencil',
    'brush',
    'frame',
    'artboard',
    'text',
    'type',
  ]);
  if (PRODUCT_CREATE.has(storeTool)) {
    pendingCreateTool = fromStore;
    return;
  }
  const kitTool = String(attached?.ui?.activeTool || '');
  if (
    kitTool === 'rect' ||
    kitTool === 'ellipse' ||
    kitTool === 'polygon' ||
    kitTool === 'star' ||
    kitTool === 'line' ||
    kitTool === 'pen' ||
    kitTool === 'pencil' ||
    kitTool === 'artboard' ||
    kitTool === 'text'
  ) {
    pendingCreateTool = kitTool;
  }
}

function enqueueKitMutateFlush() {
  if (mutateFlushQueued) return;
  mutateFlushQueued = true;
  queueMicrotask(() => {
    mutateFlushQueued = false;
    const handle = attached;
    if (!handle) {
      pendingCreateTool = null;
      return;
    }
    // Do not drop a queued create flush while suppress is held — retry so
    // pendingCreateTool cannot stick and mis-tag a later paste/boolean.
    if (suppressDepth > 0) {
      enqueueKitMutateFlush();
      return;
    }
    try {
      flushKitSceneToDocument({
        preserveKitStyle: kitHistoryReconcile,
        skipHistory: kitHistoryReconcile,
      });
    } catch (err) {
      console.error('[rcb/canvas] kit mutate flush failed', err);
    }
  });
}

function scheduleKitMutateFlush() {
  if (suppressDepth > 0) return;
  // Capture while draw tool is still active (onMutate runs inside create,
  // before maybeRevertTool → selection).
  capturePendingCreateTool();
  enqueueKitMutateFlush();
}

export function attachKitBridge(handle: CanvasEngineHandle) {
  detachKitBridge();
  attached = handle;
  registerWorkbenchIsolationSync(() => {
    syncKitWorkbenchIsolation(handle);
  });
  // Apply current timeline focus (may have been set before Kit mounted).
  syncKitWorkbenchIsolation(handle);
  handle.scene.onMutate = () => {
    scheduleKitMutateFlush();
  };
  const renderer = handle.renderer as {
    selectionOutlineOnly: (() => boolean) | null;
    drawProductSceneOverlay: ((canvas: unknown, dpr: number) => void) | null;
    getNodeArtboardClip:
      | ((nodeId: number) => { x: number; y: number; w: number; h: number } | null)
      | null;
  };
  renderer.selectionOutlineOnly = () => kitSelectionIsEmptyGeneratorsOnly(handle);
  renderer.getNodeArtboardClip = (nodeId) => kitNodeArtboardClipRect(handle, nodeId);
  renderer.drawProductSceneOverlay = (canvas, dpr) => {
    drawProcessingPlates(handle, canvas, dpr);
    drawEmptyGeneratorIcons(handle, canvas, dpr);
  };
  wrapKitHitTestForArtboardClip(handle);
  wrapKitArtboardContainedRoots(handle);
  wrapKitOccupiedArtboardBody(handle);
  origSyncWithSelection = handle.ui.syncWithSelection.bind(handle.ui);
  handle.ui.syncWithSelection = (opts) => {
    origSyncWithSelection?.(opts);
    // Selection sync can also run mid-engine call; defer with the same rule.
    queueMicrotask(() => {
      if (!attached || attached !== handle || suppressDepth > 0) return;
      try {
        flushSelectionToStore(handle);
      } catch (err) {
        console.error('[rcb/canvas] kit selection flush failed', err);
      }
    });
  };
  // Dev aid: inspect Kit↔RCB id maps when multi-select chrome desyncs.
  try {
    (window as unknown as { __RCB_KIT_MAP__?: unknown }).__RCB_KIT_MAP__ = () => ({
      kitToRcb: [...kitToRcb.entries()],
      rcbToKit: [...rcbToKit.entries()],
      sel: Array.from(handle.scene.getSelection() || []),
      storeSel: store.getState().editor.selectedNodeIds,
      lastSelKey,
    });
  } catch {
    /* ignore */
  }
  // Mirror Kit-native double-click path-edit into product chrome.
  // Do NOT call handle.setTool here: UIEngine.setActiveTool exits path-edit.
  // Kit already arms `direct` *before* enterPathEditMode on double-click;
  // product store sync is enough for RCB chrome.
  origEnterPathEdit = handle.input.enterPathEditMode.bind(handle.input);
  handle.input.enterPathEditMode = (nodeId: number) => {
    const rcbId = kitToRcb.get(nodeId) ?? null;
    if (bounceGeneratorOffPathEdit(handle, editorNodeByRcbId(rcbId))) return;
    origEnterPathEdit?.(nodeId);
    if (handle.input.editingNodeId == null) return;
    notifyPathEditChrome(true, rcbId);
    if (rcbId) {
      // Kit already selected this node — mark store write as Kit mirror echo.
      selectionMirrorGeneration += 1;
      lastSelKey = `${rcbId}|`;
      setSelectedNodeIds([rcbId]);
    }
    setActiveTool('direct');
  };
  origExitEditMode = handle.input.exitEditMode.bind(handle.input);
  handle.input.exitEditMode = () => {
    const wasEditing = handle.input.editingNodeId != null;
    origExitEditMode?.();
    if (wasEditing) notifyPathEditChrome(false, null);
  };
  // Image bucket: Kit LP has no image face fill — patch RCB node attrs on hit.
  origHandlePaintBucketClick = handle.input.handlePaintBucketClick.bind(handle.input);
  handle.input.handlePaintBucketClick = (
    pos: { x: number; y: number },
    wantEdge = false,
    erase = false
  ) => {
    const pending = pendingBucketImageFill;
    if (pending?.fillImageSrc && !erase && !wantEdge) {
      const rcbId = hitTestRcbIdFromKit(pos.x, pos.y);
      if (rcbId && !rcbId.startsWith(FRAME_SEL_PREFIX)) {
        patchDocumentNode({
          nodeId: rcbId,
          patch: {
            attrs: serializeShapeFillAttrs({
              fillType: 'image',
              fillColor: pending.fillColor,
              fillOpacity: pending.fillOpacity,
              fillImageSrc: pending.fillImageSrc,
              fillImageFit: pending.fillImageFit,
              fillImageRotate: pending.fillImageRotate,
              fillImageScale: pending.fillImageScale,
              fillImageOffsetX: pending.fillImageOffsetX,
              fillImageOffsetY: pending.fillImageOffsetY,
              fillImageAdjust: pending.fillImageAdjust as FillImageAdjust | undefined,
            }),
          },
        });
        return;
      }
    }
    origHandlePaintBucketClick?.(pos, wantEdge, erase);
  };
  // Kit marquee: InputManager commits on window mouseup via getVisibleNodes.
  // Capture the rect before handleMouseUp clears it; if engine selection stays
  // empty, fall back to measured world AABBs then mirror into the editor store.
  origOnMouseUp = handle.input.onMouseUp.bind(handle.input);
  handle.input.onMouseUp = (e: MouseEvent) => {
    const rect = handle.input.marqueeRect;
    const marquee =
      rect && rect.w > 1 && rect.h > 1
        ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
        : null;
    const shiftKey = Boolean(e.shiftKey);
    origOnMouseUp?.(e);
    queueMicrotask(() => {
      if (!attached || attached !== handle || suppressDepth > 0) return;
      try {
        finalizeMarqueeSelection(handle, marquee, shiftKey);
      } catch (err) {
        console.error('[rcb/canvas] marquee finalize failed', err);
      }
    });
  };
  // 「从画布选择」: Kit InputManager owns canvas.style.cursor — overwrite after
  // its hover pass so the stage shows copy / not-allowed (matches SvgCanvas).
  origOnMouseMove = handle.input.onMouseMove.bind(handle.input);
  handle.input.onMouseMove = (e: MouseEvent) => {
    origOnMouseMove?.(e);
    const pick = store.getState().editor.canvasAttachPick as null | {
      target: string;
      accept?: 'image' | 'media';
    };
    if (!pick?.target || !attached || attached !== handle) return;
    const canvas = handle.input.canvas as HTMLElement | null | undefined;
    if (!canvas) return;
    try {
      const pos = handle.input.getPos(e);
      const rawHit = hitTestRcbIdFromKit(pos.x, pos.y);
      const editorDoc = store.getState().editor.document;
      const doc = editorDoc ? normalizeDocument(editorDoc) : null;
      const blocked = attachPickBlockedUnderHit(
        doc,
        rawHit,
        attachPickFilterOpts(pick)
      );
      setCanvasAttachPickBlocked(blocked);
      canvas.style.cursor = blocked ? 'not-allowed' : 'copy';
    } catch {
      canvas.style.cursor = 'copy';
    }
  };
}

export function detachKitBridge() {
  stopProcessGlowAnimation();
  mutateFlushQueued = false;
  pendingCreateTool = null;
  registerWorkbenchIsolationSync(null);
  if (attached) {
    unwrapKitHitTestForArtboardClip(attached);
    unwrapKitArtboardContainedRoots(attached);
    unwrapKitOccupiedArtboardBody(attached);
    attached.scene.onMutate = null;
    const rendererHooks = attached.renderer as {
      selectionOutlineOnly: (() => boolean) | null;
      drawProductSceneOverlay: ((canvas: unknown, dpr: number) => void) | null;
      getNodeArtboardClip:
        | ((nodeId: number) => { x: number; y: number; w: number; h: number } | null)
        | null;
    };
    rendererHooks.selectionOutlineOnly = null;
    rendererHooks.drawProductSceneOverlay = null;
    rendererHooks.getNodeArtboardClip = null;
    try {
      (attached.renderer as { softArtboardId?: number | null }).softArtboardId = null;
    } catch {
      /* ignore */
    }
    if (origSyncWithSelection) {
      attached.ui.syncWithSelection = origSyncWithSelection;
    }
    if (origEnterPathEdit) {
      attached.input.enterPathEditMode = origEnterPathEdit;
    }
    if (origExitEditMode) {
      attached.input.exitEditMode = origExitEditMode;
    }
    if (origHandlePaintBucketClick) {
      attached.input.handlePaintBucketClick = origHandlePaintBucketClick;
    }
    if (origOnMouseUp) {
      attached.input.onMouseUp = origOnMouseUp;
    }
    if (origOnMouseMove) {
      attached.input.onMouseMove = origOnMouseMove;
    }
  }
  attached = null;
  origSyncWithSelection = null;
  origEnterPathEdit = null;
  origExitEditMode = null;
  origHandlePaintBucketClick = null;
  origOnMouseUp = null;
  origOnMouseMove = null;
  pendingSoftArtboardFrameId = null;
  pendingBucketImageFill = null;
  lastSelKey = '';
  lastHydrateKey = '';
  lastArtboardClipPaintSig = '';
  pendingImageSrcByKitId.clear();
  lastKitRasterSrc.clear();
}

/** True while Kit canvas bridge owns wash / Lucide / pick for mapped nodes. */
export function isKitBridgeAttached(): boolean {
  return attached != null;
}

/** Last Kit canvas pointer in scene space (null until a pointer sample). */
export function getKitPointerScenePos(): { x: number; y: number } | null {
  const im = attached?.input as
    | {
        currentPos?: { x: number; y: number };
        pointerSceneReady?: boolean;
      }
    | null
    | undefined;
  if (!im?.pointerSceneReady || !im.currentPos) return null;
  const { x, y } = im.currentPos;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Kit numeric id for an RCB scene node (null when unmapped / DomHost-only). */
export function kitIdForRcbId(rcbId: string): number | null {
  const id = rcbToKit.get(String(rcbId || ''));
  return id != null && Number.isFinite(id) ? id : null;
}

/** True when every id maps into Kit (no DomHost-only / unmapped rows). */
export function rcbIdsAllKitMapped(rcbIds: readonly string[]): boolean {
  const ids = (rcbIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return false;
  return ids.every((id) => rcbToKit.has(id));
}

/** DomHost-only SceneDocument nodes that Kit never maps (lottie / group). */
export function isDomHostOnlyRcbNode(node: SceneNodeInput | null | undefined): boolean {
  if (isEmptyGeneratorPlate(node)) return false;
  const key = String(node?.key || '');
  return key === 'lottie' || key === 'group';
}

/**
 * Kit owns clipboard when selection has no DomHost-only ids and no empty
 * generator plates. Empty gens stay Kit-mapped for paint/hit, but generator
 * flags live only in RCB attrs — Kit duplicate → kitNodeToCreated(rect) drops
 * them and the center Lucide glyph never paints.
 * Empty node selection still lets Kit handle artboard / engine clipboard.
 */
export function selectionUsesKitClipboard(
  document: SceneDocument | null | undefined,
  nodeIds: readonly string[]
): boolean {
  const ids = (nodeIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (!ids.length) return true;
  return !ids.some((id) => {
    const node = document?.deltaSetLike?.[id];
    return isEmptyGeneratorPlate(node) || isDomHostOnlyRcbNode(node);
  });
}

/** Mirror Kit Group parents into SceneDocument attrs.groupId (product chrome). */
function syncGroupIdAttrsFromKit(scene: WasmScene) {
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc) return;
  let dirty = false;
  for (const [kitId, rcbId] of kitToRcb.entries()) {
    const node = doc.deltaSetLike?.[rcbId];
    if (!node) continue;
    const parent = scene.getNodeParent(kitId);
    let nextGid: string | null = null;
    if (parent >= 0) {
      const pn = scene.getNode(parent);
      if (pn?.node_type === 'Group') nextGid = `kitg${parent}`;
    }
    const prev = String((node.attrs as Record<string, unknown>)?.groupId || '').trim();
    const prevIsKit = prev.startsWith('kitg');
    if (nextGid) {
      if (prev === nextGid) continue;
      doc = updateNodeInDocument(doc, rcbId, {
        attrs: { ...(node.attrs || {}), groupId: nextGid },
      });
      dirty = true;
    } else if (prevIsKit) {
      const attrs = { ...(node.attrs || {}) };
      delete attrs.groupId;
      doc = updateNodeInDocument(doc, rcbId, { attrs });
      dirty = true;
    }
  }
  if (dirty && doc) mirrorKitDocument(doc);
}

function syncAfterKitHistory() {
  const handle = attached;
  if (!handle) return;
  mutateFlushQueued = false;
  try {
    flushKitSceneToDocument({ preserveKitStyle: true, skipHistory: true });
    // Empty-artboards deserialize synthesizes Artwork 1 — drop if still unmapped.
    for (const ab of [...handle.scene.getArtboards()]) {
      if (kitArtboardToFrame.has(ab.id)) continue;
      if (!isKitEngineSeedArtboard(ab)) continue;
      discardKitArtboardNoHistory(handle.scene, ab.id);
    }
    flushSelectionToStore(handle);
    handle.ui.syncWithSelection?.();
    handle.renderer.requestRender();
  } catch (err) {
    console.error('[rcb/canvas] kit history reconcile failed', err);
  }
}

/**
 * Kit InputManager.deleteSelection / deleteSelectedArtboard.
 * Sync store → Kit selection first (engine selection must be non-empty).
 * Document membership is flushed **synchronously** after Kit remove — the
 * onMutate microtask alone races React hydrate and resurrects artboards.
 *
 * deleteCanvasSelection expands selected frames → bound children, so the
 * common "Delete artboard" case arrives as frames+nodes. Prefer artboard
 * delete (frame + contents); never treat that as node-only delete.
 */
function resolveKitArtboardIdForDelete(frameId: string): number | null {
  const mapped = frameToKitArtboard.get(frameId);
  if (mapped != null) return mapped;
  // flushCreates seeds `kit${ab.id}` — recover if the map was cleared mid-session.
  const m = /^kit(\d+)$/i.exec(String(frameId || ''));
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) ? id : null;
}

/**
 * Remove Kit nodes by RCB id map (keep maps so flushDeletesFromKit can drop
 * SceneDocument rows). Empty-generator marquee often leaves store selection
 * without a matching engine selection — deleteSelection alone no-ops and only
 * the overlay icon disappears after a document scrub.
 */
function removeMappedKitNodesByRcbIds(rcbIds: readonly string[]): number {
  const handle = attached;
  if (!handle || !rcbIds.length) return 0;
  const kitIds: number[] = [];
  const seen = new Set<number>();
  for (const raw of rcbIds) {
    const kitId = rcbToKit.get(String(raw));
    if (kitId == null || seen.has(kitId)) continue;
    seen.add(kitId);
    kitIds.push(kitId);
  }
  if (!kitIds.length) return 0;
  try {
    handle.scene.engine?.clear_selection();
  } catch {
    /* ignore */
  }
  try {
    handle.scene.removeNodes(kitIds);
  } catch {
    for (const kitId of kitIds) {
      try {
        handle.scene.removeNode(kitId);
      } catch {
        /* ignore */
      }
    }
  }
  return kitIds.length;
}

export function deleteKitSelection(
  rcbNodeIds: readonly string[] = [],
  rcbFrameIds: readonly string[] = []
): boolean {
  const handle = attached;
  if (!handle) return false;
  const requestedNodes = [...rcbNodeIds].map(String).filter(Boolean);
  const nodes = requestedNodes.filter((id) => rcbToKit.has(id));
  const requestedFrames = [...rcbFrameIds].map(String).filter(Boolean);
  const frameKitPairs = requestedFrames
    .map((frameId) => {
      const ab = resolveKitArtboardIdForDelete(frameId);
      return ab == null ? null : { frameId, ab };
    })
    .filter((p): p is { frameId: string; ab: number } => p != null);
  if (!requestedNodes.length && !requestedFrames.length) return false;

  if (requestedFrames.length) {
    withSuppress(() => {
      try {
        handle.scene.engine?.clear_selection();
      } catch {
        /* ignore */
      }
      const deletedAbs = new Set<number>();
      for (const { ab } of frameKitPairs) {
        if (deletedAbs.has(ab)) continue;
        const stillThere = handle.scene.getArtboards().some((a) => a.id === ab);
        if (!stillThere) continue;
        (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId = ab;
        handle.input.deleteSelectedArtboard();
        deletedAbs.add(ab);
      }
      // Full chrome may still point at a Kit plate even if the RCB↔Kit map was lost.
      const danglingAb = Number(
        (handle.renderer as { selectedArtboardId?: number | null }).selectedArtboardId ?? NaN
      );
      if (Number.isFinite(danglingAb) && !deletedAbs.has(danglingAb)) {
        handle.input.deleteSelectedArtboard();
        deletedAbs.add(danglingAb);
      }
    });
    // Apply SceneDocument drops now (do not wait for onMutate microtask).
    try {
      flushDeletesFromKit(handle.scene);
    } catch (err) {
      console.error('[rcb/canvas] kit artboard delete flush failed', err);
    }
    // Always scrub every requested RCB frame in one shot — Kit may only map a
    // subset (or flushDeletes may miss an unmapped animation plate).
    const docAfterKit = store.getState().editor.document;
    const stillFrames = requestedFrames.filter((fid) =>
      (docAfterKit?.frames || []).some((f: { id?: string }) => String(f?.id) === fid)
    );
    const frameSet = new Set(requestedFrames);
    const leftoverNodes = nodes.filter((id) => {
      if (!docAfterKit?.deltaSetLike?.[id]) return false;
      const fid = String(
        (docAfterKit.deltaSetLike[id]?.attrs as Record<string, unknown> | undefined)?.frameId ||
          ''
      ).trim();
      // Bound children of deleted plates are included via removeDocumentNodes(frameIds).
      return !fid || !frameSet.has(fid);
    });
    if (stillFrames.length || leftoverNodes.length) {
      removeDocumentNodes({
        nodeIds: leftoverNodes,
        frameIds: stillFrames,
      });
    }
    handle.renderer.requestRender();
    return true;
  }

  // Node delete: do not trust engine selection alone. Empty generators are often
  // store-selected via marquee union while Kit selection is empty / outline-only.
  if (nodes.length) {
    removeMappedKitNodesByRcbIds(nodes);
    try {
      flushDeletesFromKit(handle.scene);
    } catch (err) {
      console.error('[rcb/canvas] kit node delete flush failed', err);
    }
    handle.renderer.requestRender();
    return true;
  }

  // Requested nodes but none mapped — document path must scrub; Kit has nothing.
  return false;
}

/** Kit node ids bound to an RCB frame (frameLocal children travel with the plate). */
function kitIdsBoundToFrame(frameId: string): number[] {
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc?.deltaSetLike) return [];
  const out: number[] = [];
  for (const [rcbId, kitId] of rcbToKit.entries()) {
    const rn = doc.deltaSetLike[rcbId];
    const fid = String(
      (rn?.attrs as Record<string, unknown> | undefined)?.frameId || ''
    ).trim();
    if (fid === frameId) out.push(kitId);
  }
  return out;
}

/** Live artboard bounds → Kit (set_artboard_bounds + move_nodes on move). */
export function syncKitArtboardBoundsLive(frame: {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  name?: string;
}): boolean {
  const handle = attached;
  const frameId = String(frame?.id || '');
  if (!handle || !frameId) return false;
  const kitId = frameToKitArtboard.get(frameId);
  if (kitId == null) return false;
  const x = Number(frame.x) || 0;
  const y = Number(frame.y) || 0;
  const ab = handle.scene.getArtboards().find((a) => a.id === kitId);
  const dx = ab ? x - ab.x : 0;
  const dy = ab ? y - ab.y : 0;
  withSuppress(() => {
    applyKitArtboardFromFrame(handle.scene, kitId, frame);
    // Kit updateArtboardDrag: plate move carries contained roots by the same delta.
    if ((dx !== 0 || dy !== 0) && Number.isFinite(dx) && Number.isFinite(dy)) {
      const contained = kitIdsBoundToFrame(frameId);
      if (contained.length) {
        try {
          handle.scene.engine?.move_nodes(
            JSON.stringify(contained.map((id) => ({ id, dx, dy })))
          );
          handle.scene.invalidateCache?.();
        } catch {
          /* optional */
        }
      }
    } else {
      // Resize-only: clip rects bake into the scene picture; changeCounter may
      // not bump when only artboard bounds change.
      try {
        handle.renderer.invalidateScenePicture?.();
      } catch {
        /* optional */
      }
    }
  });
  handle.renderer.requestRender();
  return true;
}

/**
 * During Kit artboard drag/resize, mirror engine bounds into RCB live plate geom
 * so DomHost / frameLocal children track (Kit paints the plate itself).
 */
export function syncLiveArtboardPreviewsFromKit(): boolean {
  const handle = attached;
  if (!handle?.input?.isMouseDown) return false;
  let any = false;
  for (const ab of handle.scene.getArtboards()) {
    const frameId = kitArtboardToFrame.get(ab.id);
    if (!frameId) continue;
    previewArtboardFrameGeometry({
      id: frameId,
      x: ab.x,
      y: ab.y,
      width: Math.max(1, ab.w),
      height: Math.max(1, ab.h),
    });
    any = true;
  }
  return any;
}

/**
 * Kit WasmScene.undo → force SceneDocument to match.
 * Returns false when bridge detached or Kit undo stack is empty.
 */
export function kitCanUndo(): boolean {
  const hist = attached?.scene?.history;
  return Boolean(hist && hist.undo_len() > 0);
}

export function kitCanRedo(): boolean {
  const hist = attached?.scene?.history;
  return Boolean(hist && hist.redo_len() > 0);
}

export function undoKit(): boolean {
  const handle = attached;
  if (!handle?.scene?.history) return false;
  if (!(handle.scene.history.undo_len() > 0)) return false;
  kitHistoryReconcile = true;
  const prevMutate = handle.scene.onMutate;
  handle.scene.onMutate = null;
  try {
    handle.scene.undo();
  } finally {
    handle.scene.onMutate = prevMutate;
  }
  try {
    syncAfterKitHistory();
  } finally {
    kitHistoryReconcile = false;
  }
  return true;
}

/** Kit WasmScene.redo → force SceneDocument to match. */
export function redoKit(): boolean {
  const handle = attached;
  if (!handle?.scene?.history) return false;
  if (!(handle.scene.history.redo_len() > 0)) return false;
  kitHistoryReconcile = true;
  const prevMutate = handle.scene.onMutate;
  handle.scene.onMutate = null;
  try {
    handle.scene.redo();
  } finally {
    handle.scene.onMutate = prevMutate;
  }
  try {
    syncAfterKitHistory();
  } finally {
    kitHistoryReconcile = false;
  }
  return true;
}

/**
 * Kit scene.groupNodes for fully Kit-mapped selection, then flush + mirror attrs.groupId
 * so product toolbar/selection chrome still sees a shared group.
 * Returns member RCB ids, or null when Kit cannot own the gesture.
 */
export function groupKitSelection(rcbIds: readonly string[]): string[] | null {
  const handle = attached;
  if (!handle?.scene) return null;
  const ids = [...new Set((rcbIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (ids.length < 2 || !rcbIdsAllKitMapped(ids)) return null;

  const kitIds: number[] = [];
  for (const id of ids) {
    const kitId = rcbToKit.get(id);
    if (kitId == null) return null;
    kitIds.push(kitId);
  }

  let groupId = -1;
  withSuppress(() => {
    groupId = handle.scene.groupNodes(kitIds);
    handle.scene.engine?.clear_selection();
    handle.scene.selectNode(groupId, false);
  });
  if (!(groupId >= 0)) return null;

  const groupKey = `kitg${groupId}`;
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (doc) {
    for (const id of ids) {
      const node = doc.deltaSetLike?.[id];
      if (!node) continue;
      doc = updateNodeInDocument(doc, id, {
        attrs: { ...(node.attrs || {}), groupId: groupKey },
      });
    }
    pushEditorHistory();
    mirrorKitDocument(doc);
  }

  try {
    flushKitSceneToDocument({ preserveKitStyle: true });
    flushSelectionToStore(handle);
    handle.renderer.requestRender();
  } catch (err) {
    console.error('[rcb/canvas] kit group flush failed', err);
  }

  setSelectedNodeIds(ids);
  return ids;
}

/**
 * Kit scene.ungroupNode for groups covering the selection, then flush + clear attrs.groupId.
 */
export function ungroupKitSelection(rcbIds: readonly string[]): string[] | null {
  const handle = attached;
  if (!handle?.scene) return null;
  const ids = [...new Set((rcbIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length || !rcbIdsAllKitMapped(ids)) return null;

  const groups = new Set<number>();
  for (const id of ids) {
    const kitId = rcbToKit.get(id);
    if (kitId == null) return null;
    const self = handle.scene.getNode(kitId);
    if (self?.node_type === 'Group') {
      groups.add(kitId);
      continue;
    }
    const parent = handle.scene.getNodeParent(kitId);
    if (parent >= 0) {
      const pn = handle.scene.getNode(parent);
      if (pn?.node_type === 'Group') groups.add(parent);
    }
  }
  if (!groups.size) return null;

  const released: string[] = [];
  withSuppress(() => {
    for (const groupId of groups) {
      const kids = Array.from(handle.scene.getNodeChildren(groupId) || []);
      for (const kid of kids) {
        const rcb = kitToRcb.get(kid);
        if (rcb) released.push(rcb);
      }
      handle.scene.ungroupNode(groupId);
    }
    handle.scene.engine?.clear_selection();
    for (const id of ids) {
      const kitId = rcbToKit.get(id);
      if (kitId != null) handle.scene.selectNode(kitId, true);
    }
  });

  const memberIds = [...new Set(released.length ? released : ids)];
  const editor = store.getState().editor;
  let doc = editor.document ? normalizeDocument(editor.document) : null;
  if (doc) {
    for (const id of memberIds) {
      const node = doc.deltaSetLike?.[id];
      if (!node?.attrs || !('groupId' in (node.attrs || {}))) continue;
      const attrs = { ...(node.attrs || {}) };
      delete attrs.groupId;
      doc = updateNodeInDocument(doc, id, { attrs });
    }
    pushEditorHistory();
    mirrorKitDocument(doc);
  }

  try {
    flushKitSceneToDocument({ preserveKitStyle: true });
    flushSelectionToStore(handle);
    handle.renderer.requestRender();
  } catch (err) {
    console.error('[rcb/canvas] kit ungroup flush failed', err);
  }

  setSelectedNodeIds(memberIds);
  return memberIds;
}

/**
 * Destructive Kit boolean (`applyBooleanOp`).
 * Product modes `xor` / `exclude` → Kit `exclude`; `subtract` is already Kit's
 * name (maps to CanvasKit PathOp.Difference internally).
 * Returns the new RCB node id, or null on failure.
 */
export function runKitBooleanOp(
  rcbIds: string[],
  mode: 'union' | 'subtract' | 'intersect' | 'xor' | 'exclude'
): string | null {
  const handle = attached;
  if (!handle?.ck || !handle.scene) return null;
  const ids = (rcbIds || []).map((id) => String(id || '').trim()).filter(Boolean);
  if (ids.length < 2) return null;

  const kitIds: number[] = [];
  for (const rcbId of ids) {
    const kitId = rcbToKit.get(rcbId);
    if (kitId == null || !Number.isFinite(kitId)) return null;
    kitIds.push(kitId);
  }

  const op = toKitBoolOp(mode);
  if (!op) return null;

  // Suppress onMutate flush while Kit mutates; we sync maps synchronously below.
  let newKitId: number | null = null;
  withSuppress(() => {
    newKitId = applyBooleanOp(handle.ck, handle.scene, kitIds, op);
  });
  if (newKitId == null) return null;

  try {
    flushCreates(handle.scene, { preserveKitStyle: true });
    flushDeletesFromKit(handle.scene);
    flushMappedGeometry(handle.scene);
    handle.renderer.requestRender();
  } catch (err) {
    console.error('[rcb/canvas] kit boolean flush failed', err);
    return null;
  }

  return kitToRcb.get(newKitId) ?? null;
}

function toKitBoolOp(mode: string): BoolOp | null {
  const m = String(mode || '').toLowerCase();
  // Kit BoolOp uses `subtract` (PathOp.Difference) and `exclude` (XOR).
  if (m === 'union' || m === 'intersect' || m === 'subtract') return m;
  if (m === 'xor' || m === 'exclude') return 'exclude';
  if (m === 'difference') return 'subtract';
  return null;
}

/**
 * Product pick (attach / context-menu): Kit wasm `Engine.hit_test` via WasmScene.
 * Maps kit numeric id → RCB node id, or `__frame__:${frameId}` for artboards.
 * Returns null when the bridge is detached or nothing is under (x, y).
 */
export function hitTestRcbIdFromKit(x: number, y: number): string | null {
  if (!attached) return null;
  const scene = attached.scene;
  // Grouped pick matches Kit select (promote leaf → group root when needed).
  const kitId =
    typeof scene.hitTestGrouped === 'function'
      ? scene.hitTestGrouped(x, y)
      : scene.hitTest(x, y);
  if (kitId != null && Number.isFinite(kitId)) {
    // Reject picks on clipped-away overflow (ink is clipped; hit must match).
    const clip = kitNodeArtboardClipRect(attached, kitId);
    const inClip =
      !clip ||
      (x >= clip.x && x <= clip.x + clip.w && y >= clip.y && y <= clip.y + clip.h);
    if (inClip) {
      const rcbId = kitToRcb.get(kitId);
      if (rcbId) return rcbId;
      const frameId = kitArtboardToFrame.get(kitId);
      if (frameId) return frameSelId(frameId);
    }
  }
  // DomHost-only plates (empty generators) — AABB pick in document order (topmost).
  const editor = store.getState().editor;
  const doc = editor.document ? normalizeDocument(editor.document) : null;
  if (!doc?.deltaSetLike) return null;
  const kids = (doc.deltaSetLike.ROOT?.children || []).map(String).filter(Boolean);
  for (let i = kids.length - 1; i >= 0; i -= 1) {
    const id = kids[i];
    const node = doc.deltaSetLike[id];
    if (!node || (!isDomHostOnlyRcbNode(node) && !isEmptyGeneratorPlate(node))) continue;
    const box = nodeSceneAabb(doc, id);
    if (!box) continue;
    if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) return id;
  }
  return null;
}

/** Enter Kit path-edit for an RCB node (convertToPath + direct tool). */
export function enterKitPathEditForRcbId(rcbId: string): boolean {
  if (!attached || !rcbId) return false;
  const node = editorNodeByRcbId(rcbId);
  if (isGeneratorNode(node)) return false;
  let kitId = rcbToKit.get(rcbId);
  if (kitId == null) {
    if (!node) return false;
    withSuppress(() => {
      pushNodeToKit(attached!.scene, rcbId, node);
      attached!.renderer.requestRender();
    });
    kitId = rcbToKit.get(rcbId);
  }
  if (kitId == null) return false;
  // Tool first: setActiveTool exits node editing, so entering before it would
  // undo itself (same order as Kit InputManager double-click / undo restore).
  // If already editing another node, exit first — keepPathEdit wrap would
  // otherwise skip exitEditMode cleanup when re-arming `direct`.
  if (attached.isPathEditing()) attached.exitPathEdit();
  attached.setTool('direct');
  attached.enterPathEdit(kitId);
  if (!attached.isPathEditing()) return false;
  notifyPathEditChrome(true, rcbId);
  setSelectedNodeIds([rcbId]);
  setActiveTool('direct');
  return true;
}

export function exitKitPathEdit(): void {
  if (!attached) {
    notifyPathEditChrome(false, null);
    return;
  }
  attached.exitPathEdit();
  notifyPathEditChrome(false, null);
}

export function kitRcbIdBeingPathEdited(): string | null {
  const kitId = attached?.getEditingKitId() ?? null;
  if (kitId == null) return null;
  return kitToRcb.get(kitId) ?? null;
}

/**
 * Scene AABB of Kit's live selection frame (oriented control box → axis box).
 * HTML toolbars / style panels must dock to this — never CSS-rotate, and never
 * re-apply document angle on top of an already-oriented frame.
 * Includes selected artboard plates (engine selection is empty for artboards).
 */
export function getKitSelectionDockAabb(): {
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  if (!attached) return null;
  try {
    // Multi artboard full chrome: union of every selected plate (not only
    // selectedArtboardId / frames[0]).
    const frameIds = (store.getState().editor.selectedFrameIds || [])
      .map(String)
      .filter(Boolean);
    if (frameIds.length > 1) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      let any = false;
      for (const fid of frameIds) {
        const kitId = frameToKitArtboard.get(fid);
        const ab =
          kitId != null
            ? attached.scene.getArtboards().find((a) => a.id === kitId)
            : null;
        if (ab && ab.w > 1e-6 && ab.h > 1e-6) {
          any = true;
          minX = Math.min(minX, ab.x);
          minY = Math.min(minY, ab.y);
          maxX = Math.max(maxX, ab.x + ab.w);
          maxY = Math.max(maxY, ab.y + ab.h);
          continue;
        }
        const doc = store.getState().editor.document;
        const frame = (Array.isArray(doc?.frames) ? doc!.frames : []).find(
          (f) => String(f?.id) === fid
        );
        if (!frame) continue;
        const box = frameSceneBounds(doc, frame, getLiveArtboardFrameGeometry(fid));
        any = true;
        minX = Math.min(minX, box.left);
        minY = Math.min(minY, box.top);
        maxX = Math.max(maxX, box.left + box.width);
        maxY = Math.max(maxY, box.top + box.height);
      }
      if (any && maxX > minX && maxY > minY) {
        return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
      }
    }

    // Artboard-only selection: Kit keeps selectedArtboardId, not node selection.
    const abId = Number(
      (attached.renderer as { selectedArtboardId?: number | null }).selectedArtboardId ?? NaN
    );
    if (Number.isFinite(abId)) {
      const ab = attached.scene.getArtboards().find((a) => a.id === abId);
      if (ab && ab.w > 1e-6 && ab.h > 1e-6) {
        return { left: ab.x, top: ab.y, width: ab.w, height: ab.h };
      }
    }

    if (!attached.input) return null;
    const frame = attached.input.getSelectionFrame();
    if (!frame || !(frame.w > 1e-6) || !(frame.h > 1e-6)) return null;
    const m = frame.m;
    const pt = (fx: number, fy: number) => ({
      x: m.a * fx + m.c * fy + m.e,
      y: m.b * fx + m.d * fy + m.f,
    });
    const corners = [pt(0, 0), pt(frame.w, 0), pt(frame.w, frame.h), pt(0, frame.h)];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const c of corners) {
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    if (!(maxX > minX) || !(maxY > minY)) return null;
    return {
      left: minX,
      top: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  } catch {
    return null;
  }
}

/** True while Kit select tool is mid gesture (move/resize/rotate/marquee/artboard). */
export function kitSelectionGestureActive(): boolean {
  const im = attached?.input as
    | {
        isMouseDown?: boolean;
        dragMode?: string | null;
        didMove?: boolean;
        resizeHandleType?: string | null;
        resizeSnapshot?: unknown;
        rotateHandleType?: string | null;
        rotateSnapshot?: unknown;
        isArtboardMoving?: () => boolean;
        isArtboardResizing?: () => boolean;
      }
    | null
    | undefined;
  if (!im?.isMouseDown) return false;
  if (im.resizeHandleType || im.resizeSnapshot || im.rotateHandleType || im.rotateSnapshot) {
    return true;
  }
  if (im.isArtboardMoving?.() || im.isArtboardResizing?.()) return true;
  const mode = im.dragMode;
  return mode === 'move' || mode === 'marquee' || Boolean(im.didMove);
}

/** True while Kit is mid move-drag (nodes or artboard) past press threshold. */
export function kitSelectionMoveActive(): boolean {
  const im = attached?.input as
    | {
        dragMode?: string;
        didMove?: boolean;
        isArtboardMoving?: () => boolean;
      }
    | null
    | undefined;
  if (!im) return false;
  if (im.isArtboardMoving?.()) return true;
  return im.dragMode === 'move' && Boolean(im.didMove);
}

/**
 * True while Kit is resizing or rotating the selection (mouse still down).
 * Kit does NOT set dragMode to 'resize'/'rotate' — those stay on
 * resizeHandleType / rotateHandleType (+ snapshots).
 */
export function kitSelectionResizeOrRotateActive(): boolean {
  const im = attached?.input as
    | {
        isMouseDown?: boolean;
        resizeHandleType?: string | null;
        resizeSnapshot?: unknown;
        rotateHandleType?: string | null;
        rotateSnapshot?: unknown;
      }
    | null
    | undefined;
  if (!im?.isMouseDown) return false;
  return Boolean(
    im.resizeHandleType ||
      im.resizeSnapshot ||
      im.rotateHandleType ||
      im.rotateSnapshot
  );
}

export type KitCornerRadiusChrome = {
  /** Live corner radius (rounded). */
  radius: number;
  /** Active handle centre in scene space. */
  x: number;
  y: number;
  mode: 'drag' | 'hover';
};

/**
 * Live rect corner-radius chrome for the HTML 「圆角 N」 badge.
 * Kit draws the four dots; product overlays the value tip (matches polygon/star).
 */
export function getKitCornerRadiusChrome(): KitCornerRadiusChrome | null {
  const handle = attached;
  if (!handle?.input || !handle.scene) return null;
  const im = handle.input as {
    ui?: { activeTool?: string };
    editingNodeId?: number | null;
    isMouseDown?: boolean;
    currentPos?: { x: number; y: number };
    cornerRadiusDragging?: {
      nodeId: number;
      startPos: { x: number; y: number };
      startRadius: number;
    } | null;
    checkCornerRadiusHandle?: (pos: { x: number; y: number }) => { nodeId: number } | null;
  };
  if (String(im.ui?.activeTool || '') !== 'selection') return null;
  if (im.editingNodeId != null) return null;

  const drag = im.cornerRadiusDragging ?? null;
  let nodeId: number | null = null;
  let probe: { x: number; y: number } | null = null;
  let mode: 'drag' | 'hover' = 'hover';

  if (drag) {
    nodeId = drag.nodeId;
    probe = drag.startPos;
    mode = 'drag';
  } else if (!im.isMouseDown && im.currentPos && im.checkCornerRadiusHandle) {
    const hit = im.checkCornerRadiusHandle(im.currentPos);
    if (!hit) return null;
    nodeId = hit.nodeId;
    probe = im.currentPos;
    mode = 'hover';
  } else {
    return null;
  }

  try {
    const node = handle.scene.getNode(nodeId);
    const rect = node?.geometry?.Rect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    const radius = Math.round(Number(node?.style?.corner_radius) || 0);
    const zoom = Math.max(1e-6, Number(handle.renderer.zoom) || 1);
    const handles = cornerRadiusHandles(rect.width, rect.height, radius, zoom);
    if (!handles?.positions?.length || !probe) return null;

    const t = handle.scene.getTransform(nodeId);
    // Row-major: x = a*lx + b*ly + tx, y = c*lx + d*ly + ty
    const a = t[0];
    const b = t[1];
    const tx = t[2];
    const c = t[3];
    const d = t[4];
    const ty = t[5];
    const toWorld = (lx: number, ly: number) => ({
      x: a * lx + b * ly + tx,
      y: c * lx + d * ly + ty,
    });

    let best = handles.positions[0];
    let bestDist = Infinity;
    for (const [hx, hy] of handles.positions) {
      const w = toWorld(hx, hy);
      const dist = Math.hypot(w.x - probe.x, w.y - probe.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = [hx, hy];
      }
    }
    const world = toWorld(best[0], best[1]);
    return { radius, x: world.x, y: world.y, mode };
  } catch {
    return null;
  }
}

/**
 * Fetch image bytes and place via WasmScene.placeImage.
 * flushCreates maps Kit Image → RCB image node using the remembered src.
 */
export async function placeKitImageFromUrl(
  src: string,
  cx: number,
  cy: number,
  displayW?: number,
  displayH?: number
): Promise<string | null> {
  if (!attached || !src) return null;
  const data = await fetchImageBytes(src);
  if (!data || !attached) return null;
  let w = Number(displayW);
  let h = Number(displayH);
  if (!(w > 0 && h > 0)) {
    try {
      const natural = await measureImageNaturalSize(src);
      const fitted = fitImageSize(natural.width, natural.height, 2400);
      w = fitted.width;
      h = fitted.height;
    } catch {
      w = 200;
      h = 200;
    }
  }
  const kitId = attached.placeImage(data.bytes, data.mime, cx, cy, w, h);
  pendingImageSrcByKitId.set(kitId, src);
  // onMutate schedules flushCreates; wait one microtask so mapping exists.
  await Promise.resolve();
  await new Promise<void>((r) => queueMicrotask(() => r()));
  const rcbId = kitToRcb.get(kitId) ?? null;
  if (rcbId) {
    setPendingImageSrc(null);
    setSelectedNodeIds([rcbId]);
    setActiveTool('select');
    attached.setTool('selection');
  }
  return rcbId;
}

/** Drive Kit Live Paint fill from product BucketFillToolbar store. */
export function syncKitLivePaintFromBucketFill(fill: {
  fillType?: string;
  fillColor?: string;
  fillOpacity?: number;
  fillGradient?: unknown;
  fillImageSrc?: string;
  fillImageFit?: FillImageFit | string;
  fillImageRotate?: number;
  fillImageScale?: number;
  fillImageOffsetX?: number;
  fillImageOffsetY?: number;
  fillImageAdjust?: FillImageAdjust | Record<string, number>;
}): void {
  if (!attached) return;
  const fillType = parseFillType(fill.fillType);
  const fillColor = String(fill.fillColor || '#333333');
  const fillOpacity = Number.isFinite(Number(fill.fillOpacity))
    ? Math.min(100, Math.max(0, Number(fill.fillOpacity)))
    : 100;

  pendingBucketImageFill = null;

  if (
    fillType === 'solid' &&
    (fillColor === 'none' || fillColor === 'transparent')
  ) {
    attached.setLivePaintFillNone?.(true);
    return;
  }
  if (String(fill.fillType || '').toLowerCase() === 'none') {
    attached.setLivePaintFillNone?.(true);
    return;
  }

  if (fillType === 'image') {
    const src = String(fill.fillImageSrc || '').trim();
    if (src) {
      pendingBucketImageFill = {
        fillColor,
        fillOpacity,
        fillImageSrc: src,
        fillImageFit:
          fill.fillImageFit === 'fit' ||
          fill.fillImageFit === 'crop' ||
          fill.fillImageFit === 'tile' ||
          fill.fillImageFit === 'fill'
            ? fill.fillImageFit
            : 'fill',
        fillImageRotate: fill.fillImageRotate,
        fillImageScale: fill.fillImageScale,
        fillImageOffsetX: fill.fillImageOffsetX,
        fillImageOffsetY: fill.fillImageOffsetY,
        fillImageAdjust: fill.fillImageAdjust,
      };
    }
    attached.setLivePaintGradient(null);
    attached.setLivePaintFillNone?.(false);
    attached.setLivePaintFill(hexWithAlpha8(fillColor, fillOpacity));
    return;
  }

  if (
    fillType === 'linear' ||
    fillType === 'radial' ||
    fillType === 'angular' ||
    fillType === 'diffuse'
  ) {
    const grad = parseFillGradient(fill.fillGradient, fillType, fillColor);
    const kitGrad = fillGradientToKitLivePaint(grad, fillOpacity);
    const first = kitGrad.stops[0]?.color;
    const firstHex = first
      ? `#${[first.r, first.g, first.b, first.a ?? 1]
          .map((n) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0'))
          .join('')}`
      : hexWithAlpha8(fillColor, fillOpacity);
    attached.setLivePaintFillNone?.(false);
    attached.setLivePaintFill(firstHex);
    attached.setLivePaintGradient(kitGrad);
    return;
  }

  // solid
  attached.setLivePaintGradient(null);
  attached.setLivePaintFillNone?.(false);
  attached.setLivePaintFill(hexWithAlpha8(fillColor, fillOpacity));
}
