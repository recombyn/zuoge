import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Scene → native SVG DOM (no SVG.js).
 */
import {
  append,
  clearChildren,
  createSvgRoot,
  ensureDefs,
  getBBox,
  setAttrs,
  setFill,
  setStroke,
  setStyles,
  svgEl,
  urlRef,
  XLINK_NS,
} from './svgDom';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import { resolveLottieInkJson } from '@/components/editor/nodes/AnimationNode/mainSceneLotPreview';
import {
  parseNodeText,
  parseNodeTextStyle,
  textVerticalOriginY,
  toFabricFontFamily,
  textVisualLines,
  wrapPlainTextLines,
} from '../document/sceneText';
import {
  boolEffectAttr,
  hexWithOpacity,
  resolveStroke,
  resolveStrokeAlign,
  resolveStrokeLinecap,
  resolveStrokeLinejoin,
  resolveStrokeMiterlimit,
  textFrameCornerRadii,
} from '../document/sceneEffects';
import type { StrokeAlign, StrokeLinecap, StrokeLinejoin } from '../document/sceneEffects';
import { isTransparentFill, resolveDocumentBackground, resolveFill } from '../document/sceneFill';
import {
  isAudioGeneratorNode,
  isAudioNode,
  isExportableSceneNode,
  isImageGeneratorNode,
  isImageProcessRunning,
  isLottieNode,
  isAnimationFrameHostNode,
  isWorkbenchNestedLottieNode,
  shouldSkipNodeInSvgPaint,
  isOutlinedPath,
  isTextFrameNode,
  isVideoGeneratorNode
} from '../document/nodeCapabilities';
import { PROCESS_PLATE_STROKE } from '@/components/rcb/process/processGlow';
import {
  appendProcessPlatePaths,
  syncProcessPillForeignObject,
  syncProcessPlateGeometry,
} from '@/components/rcb/process/processPlateSvg';
import {
  parseLottieAnimationData,
  resolveGenPlateFill,
  resolveTextFramePlateFill,
  resolveThemeSurfaceFill
} from '../document/nodeFactories';
import { generatorEmptyIconSize, generatorEmptyIconVisible } from '../../core/layout';
import {
  clampCornerRadii,
  filletPathD,
  radiiFromAttrs,
  vertexRadiiFromAttrs,
  roundedPolygonPath,
  roundedRectPath,
  type CornerRadii,
} from '../document/sceneRadii';
import {
  rectStrokeSideRuns,
  strokeSideRunPathD,
} from '@/components/rcb/render/vector/strokeSides';
import { isCustomPathShape, scalePathData } from '../document/pathScale';
import { shapeVertexPoints, sidesFromAttrs, clampShapeSides, DEFAULT_SHAPE_SIDES, starInnerRatioFromAttrs, ellipseInnerRatioFromAttrs, ellipseArcPercentFromAttrs, ellipseStartDegFromAttrs, clampEllipseInnerRatio, clampEllipseArcPercent, clampEllipseStartDeg } from '../document/sceneShapes';
import { getShapeBaseline, getShapeBaselineD } from '@/components/rcb/core/geometry';
import { applyNodeEffects, applySvgFill } from './svgPaint';
import {
  brushSize,
  findPencilBrush,
  parsePathPressures,
  parseSimplePathPoints,
  pencilInkPathFromPoints,
} from '@/components/rcb/tools/pencilBrushes';
import { applyFrameContentClip, detachSceneNodeEl } from '@/components/rcb/frames/frameContentClip';
import {
  FRAME_PLATE_STROKE,
  framePlateStrokeSceneWidth,
} from '@/components/rcb/frames/types';
import { floorContentStrokeSceneWidth } from '@/components/rcb/render/strokeScreenFloor';
import { strokeDashForStyle } from '../document/sceneStrokeStyle';
import type { RcbCamera } from '@/components/rcb/core/types';
import {
  rcbCameraCssZoom,
  rcbCameraScreenOffset,
  rcbDprIsFractional,
  rcbSnapSceneSurfaceOrigin,
} from '@/components/rcb/core/math';
import { readDevicePixelRatio } from '@/components/rcb/core/dpr';
import { setNodeTransformPreviews, setNodeTransformAngles } from '@/components/rcb/core/transformPreview';
import { nodeNeedsPuppetWarp, effectivePuppetPins } from '@/components/editor/nodes/ImageNode/puppet/puppetModel';
import { bakePuppetWarpDataUrl } from '@/components/rcb/scene/paint/puppetWarp';
import { getFillImageReady } from '@/components/rcb/render/sceneRenderer';
import { getAnimationWorkbenchPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';

function svgTextAnchor(textAlign: string | undefined): 'start' | 'middle' | 'end' {
  if (textAlign === 'center') return 'middle';
  if (textAlign === 'right') return 'end';
  return 'start';
}

function textLocalX(align: 'start' | 'middle' | 'end', width: number): number {
  if (align === 'middle') return width / 2;
  if (align === 'end') return width;
  return 0;
}

const TRANSPARENT_PIXEL_SRC =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  );

/** Live camera + DPR + stage size for the shared world viewport (set from RcbCanvas). */
let paintCamera: RcbCamera | null = null;
let paintDpr = 1;
let paintStage = { w: 0, h: 0 };

export function setInfiniteSvgPaintCamera(
  camera: RcbCamera,
  dpr?: number,
  stage?: { width: number; height: number }
) {
  paintCamera = camera;
  if (typeof dpr === 'number' && dpr > 0) paintDpr = dpr;
  if (stage && stage.width > 0 && stage.height > 0) {
    paintStage = { w: stage.width, h: stage.height };
  }
}

/** Current editor CSS zoom (for outline sparsify etc.). Falls back to 1. */
export function getInfiniteSvgPaintZoom(): number {
  if (!paintCamera) return 1;
  return Math.max(0.15, rcbCameraCssZoom(paintCamera));
}

function resolvePaintCamera(camera?: RcbCamera | null): RcbCamera | null {
  return camera ?? paintCamera;
}

function resolvePaintDpr(dpr?: number): number {
  if (typeof dpr === 'number' && dpr > 0) return dpr;
  if (paintDpr > 0) return paintDpr;
  return readDevicePixelRatio();
}

/**
 * Editor-only hairline under CSS camera `scale(zoom)`.
 * Fixed scene widths (e.g. 1.5) become huge screen rings at 800%+ and look
 * like the control box is larger than the image / generator plate.
 */
export function editorChromeStrokeSceneWidth(cssPx = 1): number {
  const cam = resolvePaintCamera();
  const z = cam ? rcbCameraCssZoom(cam) : 1;
  return Math.max(1e-4, cssPx / Math.max(0.05, z));
}

let clipSeq = 0;
function nextClipId(prefix: string) {
  clipSeq += 1;
  return `${prefix}-${clipSeq}`;
}

/** Normalized crop rect from node attrs, or null when full-bleed / invalid. */
function readNodeCropNorm(node: SceneNodeInput): { x: number; y: number; w: number; h: number } | null {
  const fx = Number(node?.attrs?.cropX);
  const fy = Number(node?.attrs?.cropY);
  const fw = Number(node?.attrs?.cropW);
  const fh = Number(node?.attrs?.cropH);
  if (
    Number.isFinite(fx) &&
    Number.isFinite(fy) &&
    Number.isFinite(fw) &&
    Number.isFinite(fh) &&
    fw > 0 &&
    fh > 0 &&
    (fx !== 0 || fy !== 0 || fw !== 1 || fh !== 1)
  ) {
    return { x: fx, y: fy, w: fw, h: fh };
  }
  return null;
}

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Anchor as 0–100% of box. Prefer `anchorPreset` (动画工作台) over raw anchorX/Y. */
function anchorPercentsFromAttrs(attrs: Record<string, unknown> | null | undefined): {
  anchorX: number;
  anchorY: number;
} {
  const preset = String(attrs?.anchorPreset || '')
    .trim()
    .toLowerCase();
  if (/^[tmb][lmr]$/.test(preset)) {
    const col = preset.endsWith('l') ? 0 : preset.endsWith('r') ? 100 : 50;
    const row = preset.startsWith('t') ? 0 : preset.startsWith('b') ? 100 : 50;
    return { anchorX: col, anchorY: row };
  }
  return {
    anchorX: Math.max(0, Math.min(100, num(attrs?.anchorX, 50))),
    anchorY: Math.max(0, Math.min(100, num(attrs?.anchorY, 50))),
  };
}

function sceneOrigin(document: SceneDocument | null | undefined) {
  return { ox: num(document?.x, 0), oy: num(document?.y, 0) };
}

/** Artboard plate bounds in scene space (matches pointer / nodeLeftTop). */
export function frameSceneBounds(
  document: SceneDocument | null | undefined,
  frame: { x?: unknown; y?: unknown; width?: unknown; height?: unknown },
  live?: { x?: number; y?: number; width?: number; height?: number } | null
): { left: number; top: number; width: number; height: number } {
  const { ox, oy } = sceneOrigin(document);
  return {
    left: num(live?.x ?? frame.x, 0) - ox,
    top: num(live?.y ?? frame.y, 0) - oy,
    width: Math.max(1, num(live?.width ?? frame.width, 1)),
    height: Math.max(1, num(live?.height ?? frame.height, 1)),
  };
}

/** Bound artboard children store x/y relative to the plate (00 = frame top-left). */
export const FRAME_LOCAL_COORD_SPACE = 'frameLocal';

export function isFrameLocalCoordSpace(
  document: SceneDocument | null | undefined
): boolean {
  return String(document?.coordSpace || '') === FRAME_LOCAL_COORD_SPACE;
}

function frameDocumentOrigin(
  document: SceneDocument | null | undefined,
  frameId: string
): { x: number; y: number } | null {
  const id = String(frameId || '').trim();
  if (!id || !document) return null;
  const live = getLiveArtboardFrameGeometry(id);
  if (live) return { x: num(live.x, 0), y: num(live.y, 0) };
  const frame = (Array.isArray(document.frames) ? document.frames : []).find(
    (f) => String(f?.id) === id
  );
  if (!frame) return null;
  return { x: num(frame.x, 0), y: num(frame.y, 0) };
}

/** Document-space absolute box origin (same lattice as `frames[].x/y`). */
export function nodeDocumentLeftTop(
  document: SceneDocument | null | undefined,
  node: SceneNodeInput | null | undefined
): { left: number; top: number } {
  const x = num(node?.x, 0);
  const y = num(node?.y, 0);
  if (!isFrameLocalCoordSpace(document)) return { left: x, top: y };
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) return { left: x, top: y };
  const origin = frameDocumentOrigin(document, frameId);
  if (!origin) return { left: x, top: y };
  return { left: origin.x + x, top: origin.y + y };
}

/** Scene-space paint origin (document absolute minus scene origin). */
export function nodeLeftTop(document: SceneDocument | null | undefined, node: SceneNodeInput) {
  const { ox, oy } = sceneOrigin(document);
  const abs = nodeDocumentLeftTop(document, node);
  return { left: abs.left - ox, top: abs.top - oy };
}

/** World/document absolute → frame-local (when `coordSpace` is frameLocal). */
export function documentPointToNodeLocal(
  document: SceneDocument | null | undefined,
  node: SceneNodeInput | null | undefined,
  absX: number,
  absY: number
): { x: number; y: number } {
  if (!isFrameLocalCoordSpace(document)) return { x: absX, y: absY };
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) return { x: absX, y: absY };
  const origin = frameDocumentOrigin(document, frameId);
  if (!origin) return { x: absX, y: absY };
  return { x: absX - origin.x, y: absY - origin.y };
}

/** Frame-local (or world) node x/y → document absolute. */
export function nodeLocalToDocumentPoint(
  document: SceneDocument | null | undefined,
  frameId: string | null | undefined,
  localX: number,
  localY: number
): { x: number; y: number } {
  if (!isFrameLocalCoordSpace(document)) return { x: localX, y: localY };
  const id = String(frameId || '').trim();
  if (!id) return { x: localX, y: localY };
  const origin = frameDocumentOrigin(document, id);
  if (!origin) return { x: localX, y: localY };
  return { x: origin.x + localX, y: origin.y + localY };
}

function objectMeta(node: SceneNodeInput) {
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const { anchorX, anchorY } = anchorPercentsFromAttrs(attrs);
  const skewAmount = num(attrs.skewX, 0);
  const skewAxis = num(attrs.skewAxis, 0);
  return {
    angle: num(attrs.angle, 0),
    skewX: skewAmount,
    skewY: 0,
    skewAxis,
    anchorX,
    anchorY,
    opacity: Math.min(1, Math.max(0, num(attrs.opacity, 1))),
    blendMode: String(attrs.blendMode || 'pass-through'),
    flipX: boolEffectAttr(attrs.flipX, false),
    flipY: boolEffectAttr(attrs.flipY, false),
  };
}

type ShapeStrokeOpts = {
  color: string;
  width: number;
  dasharray?: string;
  align: StrokeAlign;
  linecap: StrokeLinecap;
  linejoin: StrokeLinejoin;
  miterlimit: number;
};

function strokeOptsFromNode(node: SceneNodeInput, color: string, width: number): ShapeStrokeOpts {
  const dash = strokeDashForStyle(node?.attrs?.strokeStyle);
  // Editor SVG sits under CSS scale(zoom) — floor like WebGL so hairlines survive zoom-out.
  const floored = floorContentStrokeSceneWidth(width, getInfiniteSvgPaintZoom());
  return {
    color,
    width: floored > 0 ? floored : width,
    ...(dash ? { dasharray: dash } : {}),
    align: resolveStrokeAlign(node?.attrs),
    linecap: resolveStrokeLinecap(node?.attrs),
    linejoin: resolveStrokeLinejoin(node?.attrs),
    miterlimit: resolveStrokeMiterlimit(node?.attrs),
  };
}

function setSvgImageHref(img: SVGImageElement, href: string) {
  img.setAttributeNS(XLINK_NS, 'href', href);
  img.setAttribute('href', href);
}

/**
 * Stroke paints along the element's vector baseline.
 * Align is paint-only on the path; selection chrome pads to visual outer.
 * (`strokeChromeOutset` === 0). Draw uses a separate visual→geom inset when
 * committing path size.
 *
 * Outside: a 2× underlay stroke behind an opaque fill (fill covers the inner half).
 * Inside: 2× stroke clipped to the fill region.
 * Center: normal SVG stroke centered on the path.
 */
function applyElementStroke(
  root: SVGSVGElement,
  el: SVGElement,
  opts: ShapeStrokeOpts,
  flags?: { hasOpaqueFill?: boolean }
) {
  if (!(opts.width > 0) || !opts.color || opts.color === 'transparent') {
    setStroke(el, 'none');
    removeStrokeUnderlay(el);
    return;
  }
  let align = opts.align || 'center';
  if (align === 'outside' && flags?.hasOpaqueFill === false) {
    align = 'center';
  }

  el.removeAttribute('paint-order');
  el.style.removeProperty('paint-order');
  el.removeAttribute('clip-path');
  el.style.removeProperty('clip-path');
  el.removeAttribute('mask');
  el.style.removeProperty('mask');
  removeStrokeUnderlay(el);

  if (align === 'outside') {
    // Dual-path underlay is reliable; paint-order alone often looks like "center"
    // when fills/filters reorder painting.
    if (flags?.hasOpaqueFill !== false && applyOutsideStrokeUnderlay(el, opts)) {
      return;
    }
    const strokeSpec = {
      color: opts.color,
      width: opts.width * 2,
      linecap: opts.linecap || 'butt',
      linejoin: opts.linejoin || 'miter',
      miterlimit: opts.miterlimit ?? 100,
      ...(opts.dasharray ? { dasharray: opts.dasharray } : {}),
    };
    setAttrs(el, { 'paint-order': 'stroke fill' });
    el.style.setProperty('paint-order', 'stroke fill');
    setStroke(el, strokeSpec);
    return;
  }

  if (align === 'inside') {
    applyInsideStrokeClip(root, el);
    setAttrs(el, { 'paint-order': 'fill stroke' });
    el.style.setProperty('paint-order', 'fill stroke');
    setStroke(el, {
      color: opts.color,
      width: opts.width * 2,
      linecap: opts.linecap || 'butt',
      linejoin: opts.linejoin || 'miter',
      miterlimit: opts.miterlimit ?? 100,
      ...(opts.dasharray ? { dasharray: opts.dasharray } : {}),
    });
    return;
  }

  setStroke(el, {
    color: opts.color,
    width: opts.width,
    linecap: opts.linecap || 'butt',
    linejoin: opts.linejoin || 'miter',
    miterlimit: opts.miterlimit ?? 100,
    ...(opts.dasharray ? { dasharray: opts.dasharray } : {}),
  });
}

function removeStrokeUnderlay(el: SVGElement) {
  const prev = el.previousElementSibling;
  if (prev instanceof SVGElement && prev.getAttribute('data-stroke-under') === '1') {
    prev.remove();
  }
}

/**
 * Insert a fill-none path under `el` with 2× stroke; clear stroke on `el`.
 * Opaque fill on `el` covers the inward half → true outside stroke.
 */
function applyOutsideStrokeUnderlay(el: SVGElement, opts: ShapeStrokeOpts): boolean {
  const d = el.getAttribute('d');
  const parent = el.parentElement;
  if (!d || !parent) return false;

  const under = svgEl('path', {
    d,
    'data-stroke-under': '1',
    'data-radius-body': el.getAttribute('data-radius-body') === '1' ? '1' : null,
    'pointer-events': 'none',
  });
  setFill(under, 'none');
  setStroke(under, {
    color: opts.color,
    width: opts.width * 2,
    linecap: opts.linecap || 'butt',
    linejoin: opts.linejoin || 'miter',
    miterlimit: opts.miterlimit ?? 100,
    ...(opts.dasharray ? { dasharray: opts.dasharray } : {}),
  });
  parent.insertBefore(under, el);
  setStroke(el, 'none');
  return true;
}

/** Clip a stroked element to its own fill so only the inward half of a 2× stroke shows. */
function applyInsideStrokeClip(root: SVGSVGElement, el: SVGElement) {
  const id = nextClipId('stroke-inside');
  const defs = ensureDefs(root);
  const clip = svgEl('clipPath', { id });
  const d = el.getAttribute('d');

  if (d) {
    setAttrs(clip, { clipPathUnits: 'userSpaceOnUse' });
    clip.appendChild(svgEl('path', { d, fill: '#fff', stroke: 'none' }));
  } else {
    setAttrs(clip, { clipPathUnits: 'objectBoundingBox' });
    clip.appendChild(svgEl('rect', { x: 0, y: 0, width: 1, height: 1, fill: '#fff' }));
  }

  defs.appendChild(clip);
  const ref = urlRef(id);
  setAttrs(el, { 'clip-path': ref });
  el.style.setProperty('clip-path', ref);
}

type SceneGeom = {
  left: number;
  top: number;
  width: number;
  height: number;
  abs: boolean;
};

/** Runtime fields painted onto SVG hosts (not in the DOM schema). */
export type SceneSvgHost = SVGElement & {
  __sceneLeft?: number;
  __sceneTop?: number;
  sceneWidth?: number;
  sceneHeight?: number;
  __sceneAbsPos?: boolean;
  sceneNodeId?: string;
  sceneNodeKey?: string;
  sceneShapeType?: string;
  __sceneAngle?: number;
  __sceneSkewX?: number;
  __sceneSkewY?: number;
  __sceneSkewAxis?: number;
  __sceneAnchorX?: number;
  __sceneAnchorY?: number;
  __sceneFlipX?: boolean;
  __sceneFlipY?: boolean;
  __sceneSides?: number;
  __sceneCornerRadii?: CornerRadii;
  __sceneEllipseInner?: number;
  __sceneEllipseArc?: number;
  __sceneEllipseStart?: number;
  __sceneBasePath?: string;
  __sceneFontSize?: number;
  __sceneLineHeight?: number;
  __sceneLineCount?: number;
  __scenePlainText?: string;
  __sceneDragBaseW?: number;
  __sceneDragBaseH?: number;
  /** Painted path `d` at gesture start (custom path live resize). */
  __sceneDragBasePath?: string;
  /** Unfilleted base path at gesture start, when present. */
  __sceneDragBasePathRaw?: string;
  __sceneDragBaseFontSize?: number;
  __sceneDragBaseLetterSpacing?: number;
  __sceneDidResize?: boolean;
};

function asHost(el: SVGElement): SceneSvgHost {
  return el as SceneSvgHost;
}

const geomByDom = new WeakMap<SVGElement, SceneGeom>();

function writeGeom(el: SVGElement, geom: SceneGeom) {
  const anyEl = asHost(el);
  anyEl.__sceneLeft = geom.left;
  anyEl.__sceneTop = geom.top;
  anyEl.sceneWidth = geom.width;
  anyEl.sceneHeight = geom.height;
  anyEl.__sceneAbsPos = geom.abs;
  geomByDom.set(el, { ...geom });
}

function readGeom(el: SVGElement): SceneGeom | null {
  const anyEl = asHost(el);
  const fromMap = geomByDom.get(el);
  if (fromMap) return { ...fromMap };
  const left = Number(anyEl.__sceneLeft);
  const top = Number(anyEl.__sceneTop);
  const width = Number(anyEl.sceneWidth);
  const height = Number(anyEl.sceneHeight);
  if (![left, top, width, height].every(Number.isFinite)) return null;
  return { left, top, width, height, abs: !!anyEl.__sceneAbsPos };
}

function tagNode(
  el: SVGElement,
  nodeId: string,
  key: string,
  shapeType?: string,
  left = 0,
  top = 0,
  width = 0,
  height = 0
) {
  setAttrs(el, {
    'data-scene-node-id': nodeId,
    'data-scene-node-key': key,
    'shape-rendering': 'geometricPrecision',
    ...(shapeType ? { 'data-scene-shape-type': shapeType } : {}),
  });
  const anyEl = asHost(el);
  anyEl.sceneNodeId = nodeId;
  anyEl.sceneNodeKey = key;
  if (shapeType) anyEl.sceneShapeType = shapeType;
  writeGeom(el, { left, top, width, height, abs: false });
  return el;
}

function applyMeta(
  el: SVGElement,
  left: number,
  top: number,
  meta: ReturnType<typeof objectMeta>,
  width = 0,
  height = 0
) {
  const anyEl = asHost(el);
  anyEl.__sceneAngle = meta.angle;
  anyEl.__sceneSkewX = meta.skewX;
  anyEl.__sceneSkewY = meta.skewY;
  anyEl.__sceneSkewAxis = meta.skewAxis;
  anyEl.__sceneAnchorX = meta.anchorX;
  anyEl.__sceneAnchorY = meta.anchorY;
  anyEl.__sceneFlipX = meta.flipX;
  anyEl.__sceneFlipY = meta.flipY;
  reapplySceneTransform(el, left, top, width, height);
  setAttrs(el, { opacity: meta.opacity });
  try {
    const mode = String(meta.blendMode || 'pass-through').toLowerCase();
    if (!mode || mode === 'pass-through' || mode === 'passthrough') {
      el.style.removeProperty('mix-blend-mode');
    } else {
      el.style.mixBlendMode = mode;
    }
  } catch {
    /* ignore */
  }
  return el;
}

/**
 * Editor video plates portal a playback bar into foreignObject. Group-level
 * flip would move that chrome to the opposite edge (and upside-down), while
 * VideoHoverPlayback also CSS-flips the media — pixels look unchanged, bar jumps.
 * Isolate flip: rotate/translate stay on the group; flip only underlay + HTML media.
 */
function hostIsolatesHtmlMediaFlip(el: SVGElement): boolean {
  try {
    return Boolean(
      el.querySelector(':scope > foreignObject[data-rcb-html-media-fo="video"]')
    );
  } catch {
    return false;
  }
}

function htmlMediaLocalSize(el: SVGElement, fallbackW: number, fallbackH: number) {
  const anyEl = asHost(el);
  const baseW = Number(anyEl.__sceneDragBaseW);
  const baseH = Number(anyEl.__sceneDragBaseH);
  if (anyEl.__sceneDidResize && baseW > 0 && baseH > 0) {
    return { width: baseW, height: baseH };
  }
  const geom = readGeom(el);
  return {
    width: Math.max(1, geom?.width || fallbackW),
    height: Math.max(1, geom?.height || fallbackH),
  };
}

/** Mirror poster/underlay when group flip is suppressed for HTML video chrome. */
function syncHtmlMediaUnderlayFlip(el: SVGElement, width: number, height: number) {
  const anyEl = asHost(el);
  const flipX = !!anyEl.__sceneFlipX;
  const flipY = !!anyEl.__sceneFlipY;
  const { width: w, height: h } = htmlMediaLocalSize(el, width, height);
  const cx = w / 2;
  const cy = h / 2;
  const t =
    flipX || flipY
      ? `translate(${cx} ${cy}) scale(${flipX ? -1 : 1} ${flipY ? -1 : 1}) translate(${-cx} ${-cy})`
      : '';
  el.querySelectorAll(':scope > image, :scope > [data-rcb-video-svg-underlay="1"]').forEach(
    (node) => {
      if (!(node instanceof SVGElement)) return;
      if (t) node.setAttribute('transform', t);
      else node.removeAttribute('transform');
    }
  );
}

function reapplySceneTransform(el: SVGElement, left: number, top: number, width: number, height: number) {
  const anyEl = asHost(el);
  const angle = Number(anyEl.__sceneAngle) || 0;
  const skewX = Number(anyEl.__sceneSkewX) || 0;
  const skewY = Number(anyEl.__sceneSkewY) || 0;
  const skewAxis = Number(anyEl.__sceneSkewAxis) || 0;
  const anchorX = Math.max(0, Math.min(100, Number(anyEl.__sceneAnchorX ?? 50)));
  const anchorY = Math.max(0, Math.min(100, Number(anyEl.__sceneAnchorY ?? 50)));
  const flipX = !!anyEl.__sceneFlipX;
  const flipY = !!anyEl.__sceneFlipY;
  const geom = readGeom(el);
  const abs = geom ? geom.abs : !!anyEl.__sceneAbsPos;
  const isolateFlip = hostIsolatesHtmlMediaFlip(el);
  const parts: string[] = [];

  if (!abs) parts.push(`translate(${left} ${top})`);

  const rx = abs ? left + (width * anchorX) / 100 : (width * anchorX) / 100;
  const ry = abs ? top + (height * anchorY) / 100 : (height * anchorY) / 100;
  const doFlip = (flipX || flipY) && !isolateFlip;
  const needPivot =
    Math.abs(angle) > 1e-6 ||
    Math.abs(skewX) > 1e-6 ||
    Math.abs(skewY) > 1e-6 ||
    Math.abs(skewAxis) > 1e-6 ||
    doFlip;

  if (needPivot) {
    // Pivot all of R / Sk / Sa / flip about Anchor (matches Lottie ks.a).
    parts.push(`translate(${rx} ${ry})`);
    if (angle) parts.push(`rotate(${angle})`);
    if (skewAxis) parts.push(`rotate(${skewAxis})`);
    if (skewX) parts.push(`skewX(${skewX})`);
    if (skewAxis) parts.push(`rotate(${-skewAxis})`);
    if (skewY) parts.push(`skewY(${skewY})`);
    if (doFlip) {
      parts.push(`scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})`);
    }
    parts.push(`translate(${-rx} ${-ry})`);
  }

  if (parts.length) setAttrs(el, { transform: parts.join(' ') });
  else el.removeAttribute('transform');
  if (isolateFlip) syncHtmlMediaUnderlayFlip(el, width, height);
  syncStrokeUnderlayTransform(el);
}

/** Outside-stroke underlay is the previous sibling — mirror transforms from the filled body. */
function syncStrokeUnderlayTransform(el: SVGElement) {
  const prev = el.previousElementSibling;
  if (!(prev instanceof SVGElement) || prev.getAttribute('data-stroke-under') !== '1') return;
  const t = el.getAttribute('transform');
  if (t) prev.setAttribute('transform', t);
  else prev.removeAttribute('transform');
}

function markAbsPos(el: SVGElement) {
  const geom = readGeom(el);
  if (geom) writeGeom(el, { ...geom, abs: true });
  else asHost(el).__sceneAbsPos = true;
  return el;
}

function writeSceneSides(el: SVGElement, sides: number) {
  const n = clampShapeSides(sides);
  asHost(el).__sceneSides = n;
  setAttrs(el, { 'data-scene-sides': String(n) });
}

function readSceneSides(el: SVGElement | null | undefined): number {
  const fromMem = Number(el ? asHost(el).__sceneSides : undefined);
  if (Number.isFinite(fromMem) && fromMem >= 3) return clampShapeSides(fromMem);
  const fromAttr = Number(el?.getAttribute?.('data-scene-sides'));
  if (Number.isFinite(fromAttr) && fromAttr >= 3) return clampShapeSides(fromAttr);
  return DEFAULT_SHAPE_SIDES;
}

/** Keep live corner radii on the host so geometry preview does not flash sharp. */
function rememberSceneCornerRadii(el: SVGElement | null | undefined, r: CornerRadii) {
  if (!el) return;
  asHost(el).__sceneCornerRadii = {
    tl: Number(r.tl) || 0,
    tr: Number(r.tr) || 0,
    br: Number(r.br) || 0,
    bl: Number(r.bl) || 0,
  };
}

function readSceneCornerRadii(el: SVGElement): CornerRadii {
  const mem = asHost(el).__sceneCornerRadii;
  if (
    mem &&
    [mem.tl, mem.tr, mem.br, mem.bl].every((n: unknown) => Number.isFinite(Number(n)))
  ) {
    return {
      tl: Number(mem.tl) || 0,
      tr: Number(mem.tr) || 0,
      br: Number(mem.br) || 0,
      bl: Number(mem.bl) || 0,
    };
  }
  return { tl: 0, tr: 0, br: 0, bl: 0 };
}

function rememberSceneEllipseParams(
  el: SVGElement | null | undefined,
  innerRatio: number,
  arcPercent: number,
  startDeg: number
) {
  if (!el) return;
  const bag = asHost(el);
  bag.__sceneEllipseInner = clampEllipseInnerRatio(innerRatio);
  bag.__sceneEllipseArc = clampEllipseArcPercent(arcPercent);
  bag.__sceneEllipseStart = clampEllipseStartDeg(startDeg);
  setAttrs(el, {
    'data-ellipse-inner': String(bag.__sceneEllipseInner),
    'data-ellipse-arc': String(bag.__sceneEllipseArc),
    'data-ellipse-start': String(bag.__sceneEllipseStart),
  });
}

function readSceneEllipseParams(el: SVGElement | null | undefined): {
  innerRatio: number;
  arcPercent: number;
  startDeg: number;
} {
  const bag = el ? asHost(el) : null;
  const memInner = Number(bag?.__sceneEllipseInner);
  const memArc = Number(bag?.__sceneEllipseArc);
  const memStart = Number(bag?.__sceneEllipseStart);
  const attrInner = Number(el?.getAttribute?.('data-ellipse-inner'));
  const attrArc = Number(el?.getAttribute?.('data-ellipse-arc'));
  const attrStart = Number(el?.getAttribute?.('data-ellipse-start'));
  return {
    innerRatio: clampEllipseInnerRatio(
      Number.isFinite(memInner) ? memInner : attrInner,
      0
    ),
    arcPercent: clampEllipseArcPercent(
      Number.isFinite(memArc) ? memArc : attrArc,
      100
    ),
    startDeg: clampEllipseStartDeg(
      Number.isFinite(memStart) ? memStart : attrStart,
      90
    ),
  };
}

function roundedShapePath(
  shapeType: string,
  width: number,
  height: number,
  r: CornerRadii,
  sides: number = DEFAULT_SHAPE_SIDES,
  attrs?: Record<string, unknown> | null
) {
  const pts = shapeVertexPoints(
    shapeType,
    width,
    height,
    sides,
    starInnerRatioFromAttrs(attrs)
  );
  if (!pts.length) return '';
  const vertexRadii = vertexRadiiFromAttrs(
    attrs ?? {
      radiusTL: r.tl,
      radiusTR: r.tr,
      radiusBR: r.br,
      radiusBL: r.bl,
      radiusLinked: 'true',
    },
    pts.length,
    shapeType
  );
  return roundedPolygonPath(pts, vertexRadii);
}

type DrawCtx = { root: SVGSVGElement; parent: SVGElement };

function coverRotatedFillFringe(
  el: SVGElement,
  paint: ReturnType<typeof resolveFill>,
  stroke: string,
  strokeWidth: number,
  angleDeg: number
) {
  if (strokeWidth > 0 && stroke && stroke !== 'transparent') return;
  if (paint.kind !== 'solid' || !paint.color) return;
  if (Math.abs(angleDeg) <= 0.2) return;
  setStroke(el, { color: paint.color, width: 0.75, linejoin: 'miter' });
}

function appendChild<T extends SVGElement>(parent: SVGElement, child: T): T {
  append(parent, child);
  return child;
}

/** Portal target for HTML lottie / video / audio inside the shared SVG stack. */
export const HTML_MEDIA_MOUNT_ATTR = 'data-rcb-html-media-mount';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * Mount HTML media into the node’s SVG layer so paint order follows `data-z`
 * (same stack as images / generators). Overlays portal into this div.
 */
function appendHtmlMediaMount(
  g: SVGGElement,
  opts: {
    nodeId: string;
    width: number;
    height: number;
    kind: 'lottie' | 'video' | 'audio' | 'text';
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const fo = appendChild(
    g,
    svgEl('foreignObject', {
      x: 0,
      y: 0,
      width: w,
      height: h,
      'data-rcb-html-media-fo': opts.kind,
      // Parent SVG is pointer-events:none; keep FO none so canvas hits pass
      // through. Controls set pointer-events:auto on themselves (same as before).
      'pointer-events': 'none',
    })
  );
  const div = document.createElementNS(XHTML_NS, 'div');
  div.setAttribute(HTML_MEDIA_MOUNT_ATTR, opts.nodeId);
  div.setAttribute('data-rcb-html-media-kind', opts.kind);
  let css =
    'width:100%;height:100%;overflow:hidden;pointer-events:none;position:relative;';
  if (opts.kind === 'video') css += 'color-scheme:only light;';
  div.style.cssText = css;
  fo.appendChild(div);
}

/** Native nested SVG mount for lottie-web (no foreignObject HTML preview). */
function appendLottieSvgMount(
  g: SVGGElement,
  opts: {
    nodeId: string;
    width: number;
    height: number;
    animW: number;
    animH: number;
  }
): void {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const vbW = Math.max(1, opts.animW);
  const vbH = Math.max(1, opts.animH);
  appendChild(
    g,
    svgEl('svg', {
      x: 0,
      y: 0,
      width: w,
      height: h,
      viewBox: `0 0 ${vbW} ${vbH}`,
      preserveAspectRatio: 'xMidYMid meet',
      overflow: 'hidden',
      [HTML_MEDIA_MOUNT_ATTR]: opts.nodeId,
      'data-rcb-html-media-fo': 'lottie',
      'data-rcb-lottie-svg-ink': '1',
      'data-rcb-html-media-kind': 'lottie',
      'pointer-events': 'none',
    })
  );
}

/** Resolve the media portal mount for a painted scene node (div FO or nested SVG). */
export function findHtmlMediaMount(nodeId: string): Element | null {
  const id = String(nodeId || '');
  if (!id) return null;
  const sel = `[${HTML_MEDIA_MOUNT_ATTR}="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  try {
    const hit = document.querySelector(sel);
    return hit instanceof Element ? hit : null;
  } catch {
    return null;
  }
}

function createRectLike(
  ctx: DrawCtx,
  document: SceneDocument,
  node: SceneNodeInput,
  nodeId: string,
  sceneNodeKey: string,
  shapeType?: string
) {
  const { root, parent } = ctx;
  const paint = resolveFill(node, 'transparent');
  const { stroke, strokeWidth: sw } = resolveStroke(node, '#333333');
  const { left, top } = nodeLeftTop(document, node);
  const width = Math.max(node.width || 0, 1);
  const height = Math.max(node.height || 0, 1);
  const r = radiiFromAttrs(node.attrs);
  const meta = objectMeta(node);
  const showL = boolEffectAttr(node.attrs?.L, true);
  const showR = boolEffectAttr(node.attrs?.R, true);
  const showT = boolEffectAttr(node.attrs?.T, true);
  const showB = boolEffectAttr(node.attrs?.B, true);
  const allSides = showL && showR && showT && showB;
  const noSides = !showL && !showR && !showT && !showB;
  const fillTransparent = isTransparentFill(paint);

  const strokeFull = strokeOptsFromNode(node, stroke, sw || 1);
  const strokeOpen: ShapeStrokeOpts = { ...strokeFull, align: 'center' };

  if (showB && !showT && !showL && !showR && fillTransparent) {
    const line = appendChild(
      parent,
      svgEl('line', { x1: left, y1: top + height, x2: left + width, y2: top + height })
    );
    applyElementStroke(root, line, strokeOpen);
    setFill(line, 'none');
    tagNode(line, nodeId, sceneNodeKey, shapeType, left, top, width, height);
    markAbsPos(line);
    applyMeta(line, left, top, meta, width, height);
    applyNodeEffects(root, line, node);
    return line;
  }

  const g = appendChild(parent, svgEl('g'));
  const body = appendChild(g, svgEl('path', { d: roundedRectPath(width, height, r) }));
  setAttrs(body, { 'data-radius-body': '1', 'data-baseline': '1' });
  applySvgFill(root, body, paint, `n-${nodeId}`);
  const hasRadius = Math.max(r.tl, r.tr, r.br, r.bl) > 0.5;
  if ((allSides || hasRadius) && !noSides) {
    applyElementStroke(root, body, strokeFull, { hasOpaqueFill: !fillTransparent });
  } else {
    setStroke(body, 'none');
  }

  if (!allSides && !noSides && !hasRadius) {
    const runs = rectStrokeSideRuns(width, height, node.attrs, r) || [];
    for (const run of runs) {
      const d = strokeSideRunPathD(run);
      if (!d) continue;
      const ln = appendChild(g, svgEl('path', { d }));
      setFill(ln, 'none');
      applyElementStroke(root, ln, strokeOpen);
    }
  }

  tagNode(g, nodeId, sceneNodeKey, shapeType, left, top, width, height);
  rememberSceneCornerRadii(g, r);
  if (allSides || noSides) {
    coverRotatedFillFringe(body, paint, stroke, sw, Number(meta.angle) || 0);
  }
  applyMeta(g, left, top, meta, width, height);
  applyNodeEffects(root, g, node);
  return g;
}

async function createShape(ctx: DrawCtx, document: SceneDocument, node: SceneNodeInput, nodeId: string) {
  const { root, parent } = ctx;
  const shapeType = node.attrs?.shapeType || 'rect';
  const paint = resolveFill(node, '#FFFFFF');
  const { stroke, strokeWidth: resolvedSw } = resolveStroke(node, '#333333');
  let swFallback = 1;
  if (shapeType === 'pencil') swFallback = 1.5;
  else if (shapeType === 'pen' || shapeType === 'line' || shapeType === 'arrow') swFallback = 2;
  const strokeWidth = Number.isFinite(resolvedSw) ? resolvedSw : swFallback;
  const { left, top } = nodeLeftTop(document, node);
  const width = Math.max(node.width || 100, 1);
  const height = Math.max(node.height || 100, 1);
  const meta = objectMeta(node);
  const strokeFull = strokeOptsFromNode(node, stroke, strokeWidth);
  const hasCapAttr = node.attrs?.strokeLinecap != null;
  const hasJoinAttr = node.attrs?.strokeLinejoin != null;
  let linecap = strokeFull.linecap;
  let linejoin = strokeFull.linejoin;
  if (!hasCapAttr && shapeType === 'pencil') linecap = 'round';
  if (!hasJoinAttr && shapeType === 'pencil') linejoin = 'round';
  const strokeOpen: ShapeStrokeOpts = {
    ...strokeFull,
    align: 'center',
    linecap,
    linejoin,
  };

  if (shapeType === 'line') {
    const mid = height / 2;
    const line = appendChild(parent, svgEl('line', { x1: 0, y1: mid, x2: width, y2: mid }));
    setFill(line, 'none');
    setAttrs(line, { 'data-baseline': '1' });
    applyElementStroke(root, line, strokeOpen);
    tagNode(line, nodeId, 'shape', shapeType, left, top, width, height);
    applyMeta(line, left, top, meta, width, height);
    applyNodeEffects(root, line, node);
    return line;
  }

  if (shapeType === 'arrow') {
    const d = getShapeBaselineD({
      ...node,
      width,
      height,
    })!;
    const path = appendChild(parent, svgEl('path', { d }));
    setFill(path, 'none');
    setAttrs(path, { 'data-baseline': '1' });
    applyElementStroke(root, path, strokeOpen);
    tagNode(path, nodeId, 'shape', shapeType, left, top, width, height);
    applyMeta(path, left, top, meta, width, height);
    applyNodeEffects(root, path, node);
    return path;
  }

  if (shapeType === 'circle') {
    const innerRatio = ellipseInnerRatioFromAttrs(node.attrs);
    const arcPercent = ellipseArcPercentFromAttrs(node.attrs);
    const startDeg = ellipseStartDegFromAttrs(node.attrs);
    const baseline = getShapeBaseline({
      key: 'shape',
      width,
      height,
      attrs: {
        ...(node.attrs || {}),
        shapeType: 'circle',
        ellipseInnerRatio: innerRatio,
        ellipseArcPercent: arcPercent,
        ellipseStartDeg: startDeg,
      },
    });
    const g = appendChild(parent, svgEl('g'));
    const path = appendChild(g, svgEl('path', { d: baseline?.d || '' }));
    setAttrs(path, { 'data-baseline': '1' });
    if (innerRatio > 1e-4) setAttrs(path, { 'fill-rule': 'evenodd' });
    applySvgFill(root, path, paint, `n-${nodeId}`);
    if (strokeWidth > 0 && stroke && stroke !== 'transparent') {
      applyElementStroke(root, path, strokeFull, { hasOpaqueFill: !isTransparentFill(paint) });
    } else {
      setStroke(path, 'none');
      coverRotatedFillFringe(path, paint, stroke, strokeWidth, Number(meta.angle) || 0);
    }
    tagNode(g, nodeId, 'shape', shapeType, left, top, width, height);
    rememberSceneEllipseParams(g, innerRatio, arcPercent, startDeg);
    applyMeta(g, left, top, meta, width, height);
    applyNodeEffects(root, g, node);
    return g;
  }

  if (shapeType === 'triangle' || shapeType === 'star' || shapeType === 'polygon') {
    const baseline = getShapeBaseline({
      key: 'shape',
      width,
      height,
      attrs: { ...(node.attrs || {}), shapeType },
    });
    const g = appendChild(parent, svgEl('g'));
    const path = appendChild(g, svgEl('path', { d: baseline?.d || '' }));
    setAttrs(path, { 'data-baseline': '1' });
    applySvgFill(root, path, paint, `n-${nodeId}`);
    applyElementStroke(root, path, strokeFull, { hasOpaqueFill: !isTransparentFill(paint) });
    tagNode(g, nodeId, 'shape', shapeType, left, top, width, height);
    if (shapeType === 'star' || shapeType === 'polygon') writeSceneSides(g, sidesFromAttrs(node.attrs));
    rememberSceneCornerRadii(g, radiiFromAttrs(node.attrs));
    applyMeta(g, left, top, meta, width, height);
    applyNodeEffects(root, g, node);
    return g;
  }

  if (shapeType === 'path' || shapeType === 'pen' || shapeType === 'pencil') {
    const d = node.attrs?.path || `M 0 0 L ${width} ${height}`;
    const closed = boolEffectAttr(node.attrs?.closed, false) || /\sZ\s*$/i.test(String(d).trim());
    const brushId = String(node.attrs?.brushStyle || 'vector-ink');

    if (shapeType === 'pencil') {
      const pts = parseSimplePathPoints(String(d));
      const ink = stroke && stroke !== 'transparent' ? stroke : '#333333';
      const brush = findPencilBrush(brushId);
      const pressures = parsePathPressures(node.attrs?.pathPressure, pts.length);
      // All pencil brushes use the same perfect-freehand vector silhouette.
      // Outline is built around `pts` in place — do not translate relative to the path.
      // Keep an invisible centerline baseline for selection chrome hit-testing.
      const customOutline = String(node.attrs?.pencilOutlinePath || '').trim();
      const outlineD = customOutline || pencilInkPathFromPoints(pts, strokeWidth, brushId, {
        linecap: strokeOpen.linecap,
        dasharray: strokeFull.dasharray,
        pressures,
        pressureEnabled: boolEffectAttr(node.attrs?.pressureEnabled, true),
        // Centerline is already the capture path — RDP here kinked commits vs live.
        simplify: false,
      });
      const g = appendChild(parent, svgEl('g'));
      if (outlineD) {
        const inkPath = appendChild(g, svgEl('path', { d: outlineD }));
        const fillOn = boolEffectAttr(node.attrs?.pencilFill, brush.fillEnabled !== false);
        const outlineW = Number(node.attrs?.pencilOutlineWidth ?? brush.outlineStrokeWidth) || 0;
        const outlineC = String(
          node.attrs?.pencilOutlineColor || brush.outlineStrokeColor || ink
        );
        const customSilhouette = Boolean(customOutline);
        let pencilFill = 'none';
        if (fillOn) {
          pencilFill = customSilhouette ? String(node.attrs?.['fill-color'] || ink) : ink;
        }
        setFill(inkPath, pencilFill);
        if (outlineW > 0) {
          setStroke(inkPath, { color: outlineC, width: outlineW, linejoin: 'round' });
        } else {
          setStroke(inkPath, 'none');
        }
        setAttrs(inkPath, { 'pointer-events': 'none' });
      }
      const hit = appendChild(g, svgEl('path', { d: String(d) }));
      setFill(hit, 'none');
      setStroke(hit, {
        color: 'transparent',
        width: Math.max(brushSize(brush, strokeWidth), strokeWidth),
      });
      setAttrs(hit, { 'pointer-events': 'stroke', 'data-baseline': '1' });
      tagNode(g, nodeId, 'shape', shapeType, left, top, width, height);
      applyMeta(g, left, top, meta, width, height);
      applyNodeEffects(root, g, node);
      return g;
    }

    const fillPaint = resolveFill(node, closed ? '#FFFFFF' : 'transparent');
    const baseD = String(d);
    // Pen centerlines stay raw. 轮廓化 / densified silhouettes must not be
    // re-filleted (would shred fontkit / canvas glyph rings into wedges).
    const skipFillet = shapeType === 'pen' || !closed || isOutlinedPath(node);
    const cornerR = skipFillet
      ? { tl: 0, tr: 0, br: 0, bl: 0 }
      : radiiFromAttrs(node.attrs);
    const drawD = skipFillet ? baseD : filletPathD(baseD, cornerR, node.attrs);
    const path = appendChild(parent, svgEl('path', { d: drawD }));
    setAttrs(path, { 'data-baseline': '1' });
    if (closed && shapeType !== 'pen') {
      setAttrs(path, { 'data-scene-base-path': baseD });
      asHost(path).__sceneBasePath = baseD;
    }
    applySvgFill(root, path, fillPaint, `n-${nodeId}`);
    const fillRule = String(node.attrs?.['fill-rule'] || '');
    if (fillRule === 'evenodd' || fillRule === 'nonzero') {
      setAttrs(path, { 'fill-rule': fillRule });
    }
    applyElementStroke(root, path, closed ? strokeFull : strokeOpen, {
      hasOpaqueFill: closed && !isTransparentFill(fillPaint),
    });
    if (shapeType === 'pen') {
      setAttrs(path, {
        'pointer-events':
          closed && !isTransparentFill(fillPaint) ? 'all' : 'stroke',
      });
    }
    tagNode(path, nodeId, 'shape', shapeType, left, top, width, height);
    rememberSceneCornerRadii(path, cornerR);
    applyMeta(path, left, top, meta, width, height);
    applyNodeEffects(root, path, node);
    return path;
  }

  return createRectLike(ctx, document, node, nodeId, 'shape', 'rect');
}

function buildMultilineText(
  parent: SVGElement,
  lines: string[],
  opts: {
    localX: number;
    originY: number;
    fontFamily: string;
    fontSize: number;
    fontWeight: string;
    fontStyle: string;
    anchor: string;
    fill: string;
    letterSpacing?: number;
    decoration?: string;
    lineHeight: number;
  }
): SVGTextElement {
  const el = appendChild(
    parent,
    svgEl('text', {
      x: opts.localX,
      y: opts.originY,
      'font-family': opts.fontFamily,
      'font-size': opts.fontSize,
      'font-weight': opts.fontWeight,
      'font-style': opts.fontStyle,
      'text-anchor': opts.anchor,
      fill: opts.fill,
      'dominant-baseline': 'text-before-edge',
      'alignment-baseline': 'before-edge',
    })
  );
  if (opts.letterSpacing) {
    setAttrs(el, { 'letter-spacing': `${opts.letterSpacing}px` });
  }
  if (opts.decoration && opts.decoration !== 'none') {
    setAttrs(el, {
      'text-decoration': opts.decoration,
      'text-decoration-line': opts.decoration,
    });
  }
  const dy = `${Math.max(0.8, opts.lineHeight)}em`;
  lines.forEach((line, i) => {
    const tspan = svgEl('tspan', {
      x: opts.localX,
      ...(i === 0 ? { y: opts.originY } : { dy }),
    });
    tspan.textContent = line || ' ';
    el.appendChild(tspan);
  });
  return el;
}

export async function nodeToSvgElement(
  root: SVGSVGElement,
  parent: SVGElement,
  document: SceneDocument,
  node: SceneNodeInput,
  nodeId: string
): Promise<SVGElement | null> {
  if (!node) return null;
  const ctx: DrawCtx = { root, parent };

  if (node.key === 'text') {
    const text = parseNodeText(node.attrs);
    const style = parseNodeTextStyle(node.attrs);
    const { left, top } = nodeLeftTop(document, node);
    const meta = objectMeta(node);
    const boxW = Math.max(num(node.width, 0), 0);
    const boxH = Math.max(num(node.height, style.fontSize * (style.lineHeight || 1.4)), 1);
    const align = svgTextAnchor(style.textAlign);
    const autoSize = String(node.attrs?.autoSize ?? 'true') !== 'false';
    const textFrame = isTextFrameNode(node);

    // Fixed text plate: FO mount for HTML scroll content (image-like box).
    if (textFrame) {
      const g = appendChild(parent, svgEl('g'));
      const plateW = Math.max(1, boxW);
      const plateH = Math.max(1, boxH);
      const cornerR = textFrameCornerRadii(node.attrs);
      const clipD = roundedRectPath(plateW, plateH, cornerR);
      // Plate underlay matches HTML: artboard white + plate hairline.
      const plateFill = resolveTextFramePlateFill(node.attrs?.['fill-color']);
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      setFill(plate, plateFill);
      setStroke(plate, {
        color: FRAME_PLATE_STROKE,
        width: editorChromeStrokeSceneWidth(1),
      });
      setAttrs(plate, {
        'data-radius-body': '1',
        'data-baseline': '1',
        'data-rcb-text-frame-plate': '1',
        'shape-rendering': 'crispEdges',
      });
      rememberSceneCornerRadii(g, cornerR);
      appendHtmlMediaMount(g, {
        nodeId,
        width: plateW,
        height: plateH,
        kind: 'text',
      });
      tagNode(g, nodeId, 'text', undefined, left, top, plateW, plateH);
      const anyEl = asHost(g);
      anyEl.__sceneFontSize = Math.max(1, Number(style.fontSize) || 14);
      anyEl.__sceneLineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
      anyEl.__scenePlainText = text;
      applyMeta(g, left, top, meta, plateW, plateH);
      applyNodeEffects(root, g, node);
      return g;
    }

    const visualLines = textVisualLines(text || ' ', style, {
      width: boxW,
      autoSize,
    });

    const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
    const fontSize = Math.max(1, Number(style.fontSize) || 14);
    const lineCount = Math.max(1, visualLines.length);
    // Always center the hugged ink stack in the selection height (autoSize used
    // to pin y=0 while height was lineHeight×em → top-heavy empty chrome).
    const originY = textVerticalOriginY(boxH, fontSize, lineHeight, lineCount);
    let localX = 0;
    const measuredW = boxW > 1 ? boxW : 1;
    if (align === 'middle') localX = measuredW / 2;
    else if (align === 'end') localX = measuredW;

    const el = buildMultilineText(parent, visualLines.length ? visualLines : [' '], {
      localX,
      originY,
      fontFamily: toFabricFontFamily(style.fontFamily),
      fontSize,
      fontWeight: String(style.fontWeight),
      fontStyle: style.fontStyle,
      anchor: align,
      fill: hexWithOpacity(style.fill || '#333333', style.fillOpacity ?? 100),
      letterSpacing: style.letterSpacing || undefined,
      decoration: String(style.textDecoration || 'none').trim(),
      lineHeight,
    });

    const bbox = getBBox(el);
    const finalW = boxW > 1 ? boxW : Math.max(1, bbox.width);
    const finalH = boxH > 1 ? boxH : Math.max(1, bbox.height);
    if (boxW <= 1) {
      localX = textLocalX(align, finalW);
      setAttrs(el, { x: localX });
      el.querySelectorAll('tspan').forEach((t, i) => {
        t.setAttribute('x', String(localX));
        if (i === 0) {
          t.removeAttribute('dy');
          t.setAttribute('y', String(originY));
        }
      });
    }

    tagNode(el, nodeId, 'text', undefined, left, top, finalW, finalH);
    const anyEl = asHost(el);
    anyEl.__sceneFontSize = fontSize;
    anyEl.__sceneLineHeight = lineHeight;
    anyEl.__sceneLineCount = Math.max(1, visualLines.length);
    anyEl.__scenePlainText = text;
    applyMeta(el, left, top, meta, finalW, finalH);
    applyNodeEffects(root, el, node);
    return el;
  }

  if (node.key === 'shape') return await createShape(ctx, document, node, nodeId);
  if (node.key === 'rect') return createRectLike(ctx, document, node, nodeId, 'rect');

  if (node.key === 'svg') {
    const markup = String(node.attrs?.svg || '').trim();
    const { left, top } = nodeLeftTop(document, node);
    const boxW = Math.max(1, Number(node.width) || 24);
    const boxH = Math.max(1, Number(node.height) || 24);
    const meta = objectMeta(node);
    const fillOverride = String(node.attrs?.['fill-color'] || '').trim();
    const g = appendChild(parent, svgEl('g'));
    // Box hit target — SVG content may be sparse.
    const hit = appendChild(
      g,
      svgEl('rect', { x: 0, y: 0, width: boxW, height: boxH, fill: 'transparent' })
    );
    setAttrs(hit, { 'pointer-events': 'all', 'data-svg-hit': '1' });

    if (markup) {
      try {
        const wrapped = /^<svg[\s>]/i.test(markup)
          ? markup
          : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${markup}</svg>`;
        const parsed = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
        if (!parsed.querySelector('parsererror')) {
          const srcSvg = parsed.querySelector('svg');
          if (srcSvg) {
            const vbParts = String(srcSvg.getAttribute('viewBox') || '')
              .trim()
              .split(/[\s,]+/)
              .map(Number);
            let vbX = 0;
            let vbY = 0;
            let vbW = 24;
            let vbH = 24;
            if (vbParts.length === 4 && vbParts.every((n) => Number.isFinite(n)) && vbParts[2] > 0 && vbParts[3] > 0) {
              vbX = vbParts[0];
              vbY = vbParts[1];
              vbW = vbParts[2];
              vbH = vbParts[3];
            } else {
              const wAttr = Number(srcSvg.getAttribute('width'));
              const hAttr = Number(srcSvg.getAttribute('height'));
              if (wAttr > 0 && hAttr > 0) {
                vbW = wAttr;
                vbH = hAttr;
              }
            }
            const sx = boxW / Math.max(1e-6, vbW);
            const sy = boxH / Math.max(1e-6, vbH);
            // Uniform scale + letterbox — non-uniform stretch fattened icons into "blobs".
            const s = Math.min(sx, sy);
            const ox = (boxW - vbW * s) / 2;
            const oy = (boxH - vbH * s) / 2;
            const inner = appendChild(g, svgEl('g'));
            setAttrs(inner, {
              transform: `translate(${ox},${oy}) scale(${s}) translate(${-vbX},${-vbY})`,
              'data-svg-content': '1',
              'pointer-events': 'none',
            });
            const od = g.ownerDocument;
            for (const child of Array.from(srcSvg.childNodes)) {
              if (child.nodeType !== 1) continue;
              const tag = (child as Element).tagName.toLowerCase().replace(/^.*:/, '');
              if (tag === 'script' || tag === 'foreignobject' || tag === 'style') continue;
              inner.appendChild(od.importNode(child, true));
            }
            if (fillOverride && fillOverride !== 'none' && fillOverride !== 'transparent') {
              inner.querySelectorAll('path, circle, ellipse, rect, polygon, polyline').forEach((el) => {
                const cur = String(el.getAttribute('fill') || '').trim();
                if (!cur || cur === 'currentColor' || cur === 'black' || cur === '#000' || cur === '#000000') {
                  el.setAttribute('fill', fillOverride);
                }
                const stroke = String(el.getAttribute('stroke') || '').trim();
                if (stroke === 'currentColor') el.setAttribute('stroke', fillOverride);
              });
            }
          }
        }
      } catch {
        /* keep empty hit box */
      }
    }

    tagNode(g, nodeId, 'svg', undefined, left, top, boxW, boxH);
    applyMeta(g, left, top, meta, boxW, boxH);
    applyNodeEffects(root, g, node);
    return g;
  }

  if (node.key === 'image') {
    const src = node.attrs?.src;
    const processing = String(node.attrs?.processStatus || '') === 'running';
    const { left, top } = nodeLeftTop(document, node);
    const boxW = Math.max(1, Number(node.width) || 100);
    const boxH = Math.max(1, Number(node.height) || 100);
    const meta = objectMeta(node);
    const cssFilter = String(node.attrs?.cssFilter || '').trim();
    const isGen = isImageGeneratorNode(node);
    // Generator plates are always sharp (artboard-like), even for older docs with radius attrs.
    const cornerR = isGen
      ? { tl: 0, tr: 0, br: 0, bl: 0 }
      : radiiFromAttrs(node.attrs);
    const clipD = roundedRectPath(boxW, boxH, cornerR);

    if (!src && !processing) {
      const g = appendChild(parent, svgEl('g'));
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      // Generator empty uses --gen-empty (light: cool wash #e9eaee; dark: raised surface).
      setFill(plate, isGen ? 'var(--gen-empty)' : '#E5E7EB');
      if (isGen) {
        // Border drawn inset so the painted outer edge === path geom === pixel grid
        // (center stroke would sit ink on *.5 and look like "half a cell").
        setStroke(plate, 'none');
        const sw = editorChromeStrokeSceneWidth(1);
        const inset = sw / 2;
        const border = appendChild(
          g,
          svgEl('path', {
            d: roundedRectPath(Math.max(1, boxW - sw), Math.max(1, boxH - sw), cornerR),
            transform: `translate(${inset},${inset})`,
            'pointer-events': 'none',
          })
        );
        setFill(border, 'none');
        setStroke(border, { color: 'var(--line)', width: sw });
      } else {
        setStroke(plate, {
          color: '#9CA3AF',
          width: editorChromeStrokeSceneWidth(1.5),
          dasharray: '6 4',
        });
      }
      setAttrs(plate, { 'data-radius-body': '1', 'data-baseline': '1' });
      if (isGen) {
        // Filled mountain+sun — same as paintGeneratorEmptyPlateIcon (canvas/WebGL).
        const s = generatorEmptyIconSize(boxW, boxH);
        if (generatorEmptyIconVisible(s)) {
          const cx = boxW / 2;
          const cy = boxH / 2;
          const fill = 'var(--muted)';
          const sunR = s * 0.18;
          const sun = appendChild(
            g,
            svgEl('circle', {
              cx: cx - s * 0.22,
              cy: cy - s * 0.28,
              r: sunR,
              'pointer-events': 'none',
            })
          );
          setFill(sun, fill);
          setStroke(sun, 'none');
          const peak = appendChild(
            g,
            svgEl('path', {
              d: `M${cx - s * 0.5} ${cy + s * 0.38} L${cx - s * 0.05} ${cy - s * 0.12} L${cx + s * 0.35} ${cy + s * 0.38} Z`,
              'pointer-events': 'none',
            })
          );
          setFill(peak, fill);
          setStroke(peak, 'none');
          const ridge = appendChild(
            g,
            svgEl('path', {
              d: `M${cx - s * 0.05} ${cy + s * 0.38} L${cx + s * 0.28} ${cy + s * 0.02} L${cx + s * 0.55} ${cy + s * 0.38} Z`,
              'pointer-events': 'none',
            })
          );
          setFill(ridge, fill);
          setStroke(ridge, 'none');
        }
      } else {
        const wash = appendChild(
          g,
          svgEl('rect', {
            x: 8,
            y: 8,
            width: Math.max(1, boxW - 16),
            height: Math.max(1, boxH - 16),
            'pointer-events': 'none',
          })
        );
        setFill(wash, '#F9FAFB');
        setStroke(wash, 'none');
      }
      tagNode(g, nodeId, 'image', undefined, left, top, boxW, boxH);
      if (isGen || processing) setAttrs(g, { 'data-export-ignore': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      return g;
    }

    if (processing) {
      const g = appendChild(parent, svgEl('g'));
      appendProcessPlatePaths(g, root, nodeId, clipD, boxW, boxH, {
        color: PROCESS_PLATE_STROKE,
        width: editorChromeStrokeSceneWidth(1.5),
      });

      tagNode(g, nodeId, 'image', undefined, left, top, boxW, boxH);
      setAttrs(g, { 'data-export-ignore': '1', 'data-rcb-process-plate': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      applyNodeEffects(root, g, node);
      rememberSceneCornerRadii(g, cornerR);
      return g;
    }

    const g = appendChild(parent, svgEl('g'));
    const img = appendChild(
      g,
      svgEl('image', {
        width: boxW,
        height: boxH,
        x: 0,
        y: 0,
        // Stretch to the control box — same as shapes filling their bounds.
        // Default `xMidYMid meet` keeps photo aspect and leaves empty gutters.
        preserveAspectRatio: 'none',
      })
    );
    let paintHref = String(src);
    if (nodeNeedsPuppetWarp(node)) {
      const ready = getFillImageReady(String(src));
      if (ready) {
        const attrs = (node.attrs || {}) as Record<string, unknown>;
        const frameId = resolveAnimationFrameId(document, node);
        const frameRow = frameId
          ? (Array.isArray(document.frames) ? document.frames : []).find(
              (f) => String(f?.id) === frameId
            )
          : null;
        const fps = Math.max(1, Math.round(Number(frameRow?.fps) || 30));
        const pins = effectivePuppetPins(
          attrs,
          secToFrame(getAnimationWorkbenchPlayheadSec(), fps)
        );
        const baked = bakePuppetWarpDataUrl(ready, {
          width: boxW,
          height: boxH,
          pins,
          attrs,
        });
        if (baked) paintHref = baked;
      }
    }
    setSvgImageHref(img, paintHref);
    const defs = ensureDefs(root);
    const clipId = nextClipId('img-clip');
    const clip = svgEl('clipPath', { id: clipId });
    const clipPath = svgEl('path', { d: clipD, 'data-radius-clip': '1' });
    clip.appendChild(clipPath);
    defs.appendChild(clip);
    setAttrs(img, { 'clip-path': urlRef(clipId) });
    setAttrs(g, { 'data-radius-clip-id': clipId });
    rememberSceneCornerRadii(g, cornerR);
    // Invisible baseline for host-mirrored selection chrome (clip path lives in defs).
    appendChild(
      g,
      svgEl('path', {
        d: clipD,
        fill: 'none',
        stroke: 'none',
        'pointer-events': 'none',
        'data-baseline': '1',
      })
    );
    tagNode(g, nodeId, 'image', undefined, left, top, boxW, boxH);
    if (nodeNeedsPuppetWarp(node)) setAttrs(g, { 'data-puppet-image': '1' });
    if (isGen || isImageProcessRunning(node)) setAttrs(g, { 'data-export-ignore': '1' });
    applyMeta(g, left, top, meta, boxW, boxH);
    applyNodeEffects(root, g, node);
    if (cssFilter && cssFilter !== 'none') {
      const shadowFilter = String(g.style.filter || '').trim();
      const combined =
        shadowFilter && shadowFilter !== 'none' ? `${cssFilter} ${shadowFilter}` : cssFilter;
      setStyles(g, { filter: combined });
    }
    return g;
  }

  if (node.key === 'lottie' || isLottieNode(node)) {
    const animationJsonForPaint = resolveLottieInkJson(document, nodeId, node);
    const parsedLottie = animationJsonForPaint
      ? parseLottieAnimationData(animationJsonForPaint)
      : null;
    const hasData = Boolean(parsedLottie);
    const processing = String(node.attrs?.processStatus || '') === 'running';
    const { left, top } = nodeLeftTop(document, node);
    const boxW = Math.max(1, Number(node.width) || 100);
    const boxH = Math.max(1, Number(node.height) || 100);
    const meta = objectMeta(node);
    // Artboard-like: sharp plate (ignore stored radii).
    const cornerR = { tl: 0, tr: 0, br: 0, bl: 0 };
    const clipD = roundedRectPath(boxW, boxH, cornerR);
    const g = appendChild(parent, svgEl('g'));
    const svgOwnsPixels = videoSvgOwnsPixels(root);
    const frameHost = isAnimationFrameHostNode(node, document);
    const workbenchNested = isWorkbenchNestedLottieNode(node, document);
    const rawLottieFill = String(node.attrs?.['fill-color'] || '').trim();
    let plateFill = 'none';
    if (!frameHost && !workbenchNested) {
      const themed = !rawLottieFill || rawLottieFill === 'transparent' ? '' : rawLottieFill;
      plateFill = resolveThemeSurfaceFill(themed);
    }
    const plateStrokeW = framePlateStrokeSceneWidth(getInfiniteSvgPaintZoom());

    // Same process plate as image/video — shimmer chrome overlays this node.
    if (processing) {
      appendProcessPlatePaths(g, root, nodeId, clipD, boxW, boxH, {
        color: PROCESS_PLATE_STROKE,
        width: editorChromeStrokeSceneWidth(1.5),
      });
      rememberSceneCornerRadii(g, cornerR);
      tagNode(g, nodeId, 'lottie', undefined, left, top, boxW, boxH);
      setAttrs(g, { 'data-export-ignore': '1', 'data-rcb-process-plate': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      applyNodeEffects(root, g, node);
      return g;
    }

    if (!hasData) {
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      setFill(plate, plateFill);
      // Frame host sits under the artboard plate — a second hairline looks like a
      // thick 动画工作台 border. Nested workbench lotties follow the same rule.
      if (frameHost || workbenchNested) {
        setStroke(plate, 'none');
        setAttrs(plate, { 'pointer-events': 'none' });
      } else {
        setStroke(plate, {
          color: FRAME_PLATE_STROKE,
          width: plateStrokeW,
        });
      }
      setAttrs(plate, {
        'data-radius-body': '1',
        'data-baseline': '1',
        'shape-rendering': 'crispEdges',
      });
      rememberSceneCornerRadii(g, cornerR);
      tagNode(g, nodeId, 'lottie', undefined, left, top, boxW, boxH);
      if (isImageProcessRunning(node)) setAttrs(g, { 'data-export-ignore': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      return g;
    }

    // Plate fill under lottie SVG ink. Export keeps SVG-only pixels.
    const plate = appendChild(g, svgEl('path', { d: clipD }));
    setFill(plate, plateFill);
    if (frameHost || workbenchNested) {
      setAttrs(plate, { 'pointer-events': 'none' });
      setStroke(plate, 'none');
    } else {
      setStroke(plate, {
        color: FRAME_PLATE_STROKE,
        width: plateStrokeW,
      });
    }
    const plateAttrs: Record<string, string> = {
      'data-radius-body': '1',
      'data-baseline': '1',
      'shape-rendering': 'crispEdges',
    };
    if (!svgOwnsPixels && !frameHost && !workbenchNested) {
      plateAttrs['data-rcb-lottie-html-hit'] = '1';
    }
    setAttrs(plate, plateAttrs);
    if (!svgOwnsPixels) {
      // Nested SVG mount for lottie-web — preview + edit share the same SVG ink
      // (no foreignObject HTML plate). Frame-host ink is hidden in the overlay;
      // scene children show the scrubbed pose via playhead sync.
      const ink = appendChild(g, svgEl('g'));
      if (!frameHost) {
        const clipId = nextClipId(`lottie-clip-${nodeId}`);
        const defs = ensureDefs(root);
        const clip = appendChild(defs, svgEl('clipPath', { id: clipId }));
        appendChild(clip, svgEl('path', { d: clipD }));
        setAttrs(ink, { 'clip-path': urlRef(clipId) });
      } else {
        setAttrs(ink, { 'pointer-events': 'none' });
      }
      appendLottieSvgMount(ink, {
        nodeId,
        width: boxW,
        height: boxH,
        animW: Math.max(1, Number(parsedLottie?.w) || boxW),
        animH: Math.max(1, Number(parsedLottie?.h) || boxH),
      });
    }
    rememberSceneCornerRadii(g, cornerR);
    tagNode(g, nodeId, 'lottie', undefined, left, top, boxW, boxH);
    applyMeta(g, left, top, meta, boxW, boxH);
    applyNodeEffects(root, g, node);
    return g;
  }

  if (node.key === 'video') {
    const src = String(node.attrs?.src || '').trim();
    const posterRaw = String(node.attrs?.poster || '').trim();
    // Ephemeral posters are not paint-safe after refresh.
    const poster =
      posterRaw && !posterRaw.startsWith('blob:') && !posterRaw.startsWith('data:')
        ? posterRaw
        : '';
    const processing = String(node.attrs?.processStatus || '') === 'running';
    const { left, top } = nodeLeftTop(document, node);
    const boxW = Math.max(1, Number(node.width) || 100);
    const boxH = Math.max(1, Number(node.height) || 100);
    const meta = objectMeta(node);
    const isGen = isVideoGeneratorNode(node);
    const cornerR = isGen
      ? { tl: 0, tr: 0, br: 0, bl: 0 }
      : radiiFromAttrs(node.attrs);
    const clipD = roundedRectPath(boxW, boxH, cornerR);

    if (!src && !processing) {
      const g = appendChild(parent, svgEl('g'));
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      setFill(plate, isGen ? 'var(--gen-empty)' : '#E5E7EB');
      if (isGen) {
        setStroke(plate, 'none');
        const sw = editorChromeStrokeSceneWidth(1);
        const inset = sw / 2;
        const border = appendChild(
          g,
          svgEl('path', {
            d: roundedRectPath(Math.max(1, boxW - sw), Math.max(1, boxH - sw), cornerR),
            transform: `translate(${inset},${inset})`,
            'pointer-events': 'none',
          })
        );
        setFill(border, 'none');
        setStroke(border, { color: 'var(--line)', width: sw });
      } else {
        setStroke(plate, {
          color: '#9CA3AF',
          width: editorChromeStrokeSceneWidth(1.5),
          dasharray: '6 4',
        });
      }
      setAttrs(plate, { 'data-radius-body': '1', 'data-baseline': '1' });
      if (isGen) {
        // Filled play triangle — same as paintGeneratorEmptyPlateIcon (canvas/WebGL).
        const iconSize = generatorEmptyIconSize(boxW, boxH);
        if (generatorEmptyIconVisible(iconSize)) {
          const cx = boxW / 2;
          const cy = boxH / 2;
          const s = iconSize;
          const play = appendChild(
            g,
            svgEl('path', {
              d: `M${cx - s * 0.28} ${cy - s * 0.38} L${cx + s * 0.42} ${cy} L${cx - s * 0.28} ${cy + s * 0.38} Z`,
              'pointer-events': 'none',
            })
          );
          setFill(play, 'var(--muted)');
          setStroke(play, 'none');
        }
      }
      tagNode(g, nodeId, 'video', undefined, left, top, boxW, boxH);
      if (isGen || processing) setAttrs(g, { 'data-export-ignore': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      return g;
    }

    if (processing) {
      const g = appendChild(parent, svgEl('g'));
      // Match image upload SoftGlow — always show process plate (not poster-only).
      appendProcessPlatePaths(g, root, nodeId, clipD, boxW, boxH, {
        color: PROCESS_PLATE_STROKE,
        width: editorChromeStrokeSceneWidth(1.5),
      });
      tagNode(g, nodeId, 'video', undefined, left, top, boxW, boxH);
      setAttrs(g, { 'data-export-ignore': '1', 'data-rcb-process-plate': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      applyNodeEffects(root, g, node);
      rememberSceneCornerRadii(g, cornerR);
      return g;
    }

    const g = appendChild(parent, svgEl('g'));
    // Infinite editor: SVG poster/underlay + HTML <video> in foreignObject.
    // Both ride the same group transform during drag (previewSvgNodeGeometry).
    // Do not hide HTML globally while transforming — freeze frames live only in
    // HTML; blanking it left a dark underlay and blanked unrelated videos on
    // any geometry gesture. Export boards still use SVG-only pixels.
    const svgOwnsPixels = videoSvgOwnsPixels(root);
    const crop = readNodeCropNorm(node);
    if (poster) {
      const imgW = crop ? boxW / crop.w : boxW;
      const imgH = crop ? boxH / crop.h : boxH;
      const imgX = crop ? (-crop.x / crop.w) * boxW : 0;
      const imgY = crop ? (-crop.y / crop.h) * boxH : 0;
      const img = appendChild(
        g,
        svgEl('image', {
          width: imgW,
          height: imgH,
          x: imgX,
          y: imgY,
          preserveAspectRatio: 'none',
          'data-rcb-video-svg-underlay': '1',
        })
      );
      setSvgImageHref(img, poster);
      const clipId = nextClipId('vid-clip');
      const defs = ensureDefs(root);
      const clip = svgEl('clipPath', { id: clipId });
      clip.appendChild(svgEl('path', { d: clipD, 'data-radius-clip': '1' }));
      defs.appendChild(clip);
      setAttrs(img, { 'clip-path': urlRef(clipId) });
      setAttrs(g, { 'data-radius-clip-id': clipId });
      appendChild(
        g,
        svgEl('path', {
          d: clipD,
          fill: 'none',
          stroke: 'none',
          'pointer-events': 'none',
          'data-baseline': '1',
          ...(!svgOwnsPixels ? { 'data-rcb-video-html-hit': '1' } : {}),
        })
      );
    } else {
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      setFill(plate, '#111827');
      setStroke(plate, 'none');
      setAttrs(plate, {
        'data-radius-body': '1',
        'data-baseline': '1',
        'data-rcb-video-svg-underlay': '1',
        ...(!svgOwnsPixels ? { 'data-rcb-video-html-hit': '1' } : {}),
      });
    }
    void src;
    if (!svgOwnsPixels && src) {
      appendHtmlMediaMount(g, { nodeId, width: boxW, height: boxH, kind: 'video' });
    }
    rememberSceneCornerRadii(g, cornerR);
    tagNode(g, nodeId, 'video', undefined, left, top, boxW, boxH);
    if (isGen || isImageProcessRunning(node)) setAttrs(g, { 'data-export-ignore': '1' });
    applyMeta(g, left, top, meta, boxW, boxH);
    applyNodeEffects(root, g, node);
    return g;
  }

  if (node.key === 'audio' || isAudioNode(node) || isAudioGeneratorNode(node)) {
    const isGen = isAudioGeneratorNode(node);
    const hasSrc = Boolean(String(node.attrs?.src || '').trim());
    const processing = String(node.attrs?.processStatus || '') === 'running';
    const { left, top } = nodeLeftTop(document, node);
    const boxW = Math.max(1, Number(node.width) || 100);
    const boxH = Math.max(1, Number(node.height) || 100);
    const meta = objectMeta(node);
    const cornerR = isGen
      ? { tl: 0, tr: 0, br: 0, bl: 0 }
      : radiiFromAttrs(node.attrs);
    const clipD = roundedRectPath(boxW, boxH, cornerR);
    const g = appendChild(parent, svgEl('g'));
    const svgOwnsPixels = videoSvgOwnsPixels(root);
    const plateFill = resolveGenPlateFill(node.attrs?.['fill-color']);

    if (processing) {
      appendProcessPlatePaths(g, root, nodeId, clipD, boxW, boxH, {
        color: PROCESS_PLATE_STROKE,
        width: editorChromeStrokeSceneWidth(1.5),
      });
      rememberSceneCornerRadii(g, cornerR);
      tagNode(g, nodeId, 'audio', undefined, left, top, boxW, boxH);
      setAttrs(g, { 'data-export-ignore': '1', 'data-rcb-process-plate': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      applyNodeEffects(root, g, node);
      return g;
    }

    if (isGen || !hasSrc) {
      const plate = appendChild(g, svgEl('path', { d: clipD }));
      setFill(plate, 'var(--gen-empty)');
      if (isGen) {
        setStroke(plate, 'none');
        const sw = editorChromeStrokeSceneWidth(1);
        const inset = sw / 2;
        const border = appendChild(
          g,
          svgEl('path', {
            d: roundedRectPath(Math.max(1, boxW - sw), Math.max(1, boxH - sw), cornerR),
            transform: `translate(${inset},${inset})`,
            'pointer-events': 'none',
          })
        );
        setFill(border, 'none');
        setStroke(border, { color: 'var(--line)', width: sw });
        const iconSize = generatorEmptyIconSize(boxW, boxH);
        if (generatorEmptyIconVisible(iconSize)) {
          const cx = boxW / 2;
          const cy = boxH / 2;
          const s = iconSize;
          const fill = 'var(--muted)';
          // Filled bars (same as paintGeneratorEmptyPlateIcon audio) — not hairline strokes.
          const barW = Math.max(s * 0.08, s * (2 / 24));
          const xs = [-0.42, -0.25, -0.08, 0.09, 0.26, 0.43];
          const halfHs = [0.12, 0.28, 0.42, 0.22, 0.34, 0.12];
          for (let i = 0; i < xs.length; i += 1) {
            const x = cx + s * xs[i]!;
            const hh = s * halfHs[i]!;
            const top = cy - hh;
            const bh = hh * 2;
            const r = Math.min(barW * 0.5, bh * 0.45);
            const bar = appendChild(
              g,
              svgEl('rect', {
                x: x - barW / 2,
                y: top,
                width: barW,
                height: bh,
                rx: r,
                ry: r,
                'pointer-events': 'none',
              })
            );
            setFill(bar, fill);
            setStroke(bar, 'none');
          }
        }
      } else {
        setStroke(plate, {
          color: 'var(--line)',
          width: editorChromeStrokeSceneWidth(1),
        });
      }
      setAttrs(plate, { 'data-radius-body': '1', 'data-baseline': '1' });
      rememberSceneCornerRadii(g, cornerR);
      tagNode(g, nodeId, 'audio', undefined, left, top, boxW, boxH);
      if (isGen || isImageProcessRunning(node)) setAttrs(g, { 'data-export-ignore': '1' });
      applyMeta(g, left, top, meta, boxW, boxH);
      return g;
    }

    // Finished audio: SVG plate + decorative waveform (HTML overlay covers while idle;
    // geometryOverrides keep HTML glued during drag).
    const plate = appendChild(g, svgEl('path', { d: clipD }));
    setFill(plate, plateFill);
    setStroke(plate, 'none');
    setAttrs(plate, {
      'data-radius-body': '1',
      'data-baseline': '1',
      'data-rcb-audio-svg-underlay': '1',
      ...(!svgOwnsPixels ? { 'data-rcb-audio-html-hit': '1' } : {}),
    });
    const padX = Math.max(8, boxW * 0.04);
    const padY = Math.max(8, boxH * 0.12);
    const railW = Math.max(1, boxW - padX * 2);
    const railH = Math.max(1, boxH * 0.55);
    const railX = padX;
    const railY = Math.max(padY, (boxH - railH) * 0.38);
    const rail = appendChild(
      g,
      svgEl('rect', {
        x: railX,
        y: railY,
        width: railW,
        height: railH,
        rx: Math.min(12, railH * 0.18),
        'pointer-events': 'none',
      })
    );
    setFill(rail, 'var(--rail)');
    setStroke(rail, 'none');
    const barCount = Math.max(12, Math.min(48, Math.floor(railW / 6)));
    const gap = 2;
    const barW = Math.max(1.5, (railW - gap * (barCount - 1)) / barCount);
    const midY = railY + railH / 2;
    for (let i = 0; i < barCount; i++) {
      const t = i / Math.max(1, barCount - 1);
      const hump = Math.sin(t * Math.PI) * 0.55 + 0.25;
      const wobble = 0.35 + 0.65 * Math.abs(Math.sin(i * 2.7 + boxW * 0.01));
      const h = Math.max(4, railH * 0.72 * hump * wobble);
      const bar = appendChild(
        g,
        svgEl('rect', {
          x: railX + i * (barW + gap),
          y: midY - h / 2,
          width: barW,
          height: h,
          rx: Math.min(2, barW / 2),
          'pointer-events': 'none',
        })
      );
      setFill(bar, 'var(--muted)');
      setStroke(bar, 'none');
      setAttrs(bar, { opacity: '0.55' });
    }
    if (!svgOwnsPixels && hasSrc) {
      appendHtmlMediaMount(g, { nodeId, width: boxW, height: boxH, kind: 'audio' });
    }
    rememberSceneCornerRadii(g, cornerR);
    tagNode(g, nodeId, 'audio', undefined, left, top, boxW, boxH);
    applyMeta(g, left, top, meta, boxW, boxH);
    applyNodeEffects(root, g, node);
    return g;
  }

  return null;
}

export function applyInfiniteSvgViewport(root: SVGSVGElement) {
  setAttrs(root, {
    width: 1,
    height: 1,
    viewBox: '0 0 1 1',
    overflow: 'visible',
    preserveAspectRatio: 'none',
    'shape-rendering': 'geometricPrecision',
    'pointer-events': 'none',
    'data-rcb-infinite': '1',
  });
  setStyles(root, {
    display: 'block',
    overflow: 'visible',
    position: 'absolute',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    'pointer-events': 'none',
  });
}

const INFINITE_SVG_PAD = 64;

function isInfiniteSvgRoot(root: SVGSVGElement) {
  return root.getAttribute('data-rcb-infinite') === '1';
}

/**
 * Whether SVG alone owns the visible video pixels (no HTML plate on top).
 * Infinite editor paints an SVG poster underlay AND mounts HTML `<video>` in
 * foreignObject — both move with the node group. Export surfaces keep SVG-only
 * pixels (no FO mount).
 */
export function videoSvgOwnsPixels(root: SVGSVGElement): boolean {
  if (!isInfiniteSvgRoot(root)) return true;
  if (root.getAttribute('data-rcb-export-surface') === '1') return true;
  return false;
}

type ViewportBox = { minX: number; minY: number; w: number; h: number };

/**
 * Infinite-SVG CSS box === viewBox.
 * Under fractional browser DPR, snap the origin onto the device-pixel lattice
 * (matched left + viewBox min) so sibling surfaces (grid / hosts) do not round
 * apart. Absolute scene content still maps to scene*zoom+cam.
 */
function snapSurfaceBox(
  box: ViewportBox,
  camera?: RcbCamera | null,
  dpr?: number
): ViewportBox {
  const w = Math.max(1, box.w);
  const h = Math.max(1, box.h);
  const cam = resolvePaintCamera(camera);
  const d = resolvePaintDpr(dpr);
  if (!cam || !rcbDprIsFractional(d)) {
    return { minX: box.minX, minY: box.minY, w, h };
  }
  const z = rcbCameraCssZoom(cam);
  const { x: camX, y: camY } = rcbCameraScreenOffset(cam, d);
  return {
    minX: rcbSnapSceneSurfaceOrigin(box.minX, z, camX, d),
    minY: rcbSnapSceneSurfaceOrigin(box.minY, z, camY, d),
    w,
    h,
  };
}

function writeInfiniteViewport(
  root: SVGSVGElement,
  snapped: ViewportBox,
  opts?: { lock?: boolean; intent?: ViewportBox }
) {
  const intent = opts?.intent ?? snapped;
  const { minX, minY, w, h } = snapped;
  const attrs: Record<string, string | number> = {
    width: w,
    height: h,
    viewBox: `${minX} ${minY} ${w} ${h}`,
    overflow: 'visible',
    preserveAspectRatio: 'none',
    'shape-rendering': 'geometricPrecision',
    'pointer-events': 'none',
    'data-rcb-infinite': '1',
    // Pre-snap scene intent — re-snap when browser DPR / camera changes.
    'data-rcb-surface-x': intent.minX,
    'data-rcb-surface-y': intent.minY,
    'data-rcb-surface-w': intent.w,
    'data-rcb-surface-h': intent.h,
  };
  if (opts?.lock) attrs['data-rcb-viewport-locked'] = '1';
  setAttrs(root, attrs);
  setStyles(root, {
    display: 'block',
    overflow: 'visible',
    position: 'absolute',
    left: `${minX}px`,
    top: `${minY}px`,
    width: `${w}px`,
    height: `${h}px`,
    'pointer-events': 'none',
  });
}

function readSurfaceIntent(root: SVGSVGElement): ViewportBox | null {
  const minX = Number(root.getAttribute('data-rcb-surface-x'));
  const minY = Number(root.getAttribute('data-rcb-surface-y'));
  const w = Number(root.getAttribute('data-rcb-surface-w'));
  const h = Number(root.getAttribute('data-rcb-surface-h'));
  if (![minX, minY, w, h].every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
  return { minX, minY, w, h };
}

/**
 * Pan an infinite host SVG with a live node translate (no getBBox refit).
 * No-op for shared world-surface hosts — ink moves via element transform;
 * the CSS box stays the camera viewport so it stays locked to the grid.
 */
export function panInfiniteSvgViewport(
  root: SVGSVGElement,
  dLeft: number,
  dTop: number
) {
  if (!isInfiniteSvgRoot(root)) return;
  if (root.getAttribute('data-rcb-shared-scene-surface') === '1') return;
  if (!(dLeft || dTop)) return;
  const intent = readSurfaceIntent(root);
  const parts = (root.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length < 4 || !parts.every(Number.isFinite)) return;
  const base = intent || { minX: parts[0], minY: parts[1], w: parts[2], h: parts[3] };
  const nextIntent: ViewportBox = {
    minX: base.minX + dLeft,
    minY: base.minY + dTop,
    w: base.w,
    h: base.h,
  };
  const snapped = snapSurfaceBox(nextIntent);
  const lock = root.getAttribute('data-rcb-viewport-locked') === '1';
  writeInfiniteViewport(root, snapped, { lock: lock || undefined, intent: nextIntent });
}

export function fitInfiniteSvgToContent(root: SVGSVGElement, layer?: SVGElement | null) {
  if (!isInfiniteSvgRoot(root)) return;
  // Shared world surface — never shrink to content bbox (would desync from grid).
  if (root.getAttribute('data-rcb-shared-scene-surface') === '1') return;
  // Locked after seed — preserve half-pixel origins for
  // odd center strokes (visual outer on integer grid). getBBox often reports
  // 269.5 as ~270 and used to rewrite CSS left, which browser zoom amplifies.
  if (root.getAttribute('data-rcb-viewport-locked') === '1') return;

  let minX = 0;
  let minY = 0;
  let w = 1;
  let h = 1;
  try {
    const target = (layer || root) as SVGGraphicsElement;
    const box = getBBox(target);
    if (
      Number.isFinite(box.x) &&
      Number.isFinite(box.y) &&
      Number.isFinite(box.width) &&
      Number.isFinite(box.height) &&
      (box.width > 0 || box.height > 0)
    ) {
      minX = box.x - INFINITE_SVG_PAD;
      minY = box.y - INFINITE_SVG_PAD;
      w = Math.max(1, box.width + INFINITE_SVG_PAD * 2);
      h = Math.max(1, box.height + INFINITE_SVG_PAD * 2);
    }
  } catch {
    /* empty layer */
  }

  // Keep a freshly seeded viewport when getBBox only nudges by ≤1px (common
  // 269.5→270 jump from stroke/getBBox). That half-pixel shift desyncs guides.
  const prevIntent = readSurfaceIntent(root);
  const prevMinX = prevIntent?.minX ?? parseFloat(root.style.left);
  const prevMinY = prevIntent?.minY ?? parseFloat(root.style.top);
  const prevW = prevIntent?.w ?? parseFloat(root.style.width);
  const prevH = prevIntent?.h ?? parseFloat(root.style.height);
  if (
    [prevMinX, prevMinY, prevW, prevH].every(Number.isFinite) &&
    Math.abs(minX - prevMinX) <= 1 &&
    Math.abs(minY - prevMinY) <= 1 &&
    Math.abs(w - prevW) <= 1 &&
    Math.abs(h - prevH) <= 1
  ) {
    return;
  }

  const intent: ViewportBox = { minX, minY, w, h };
  writeInfiniteViewport(root, snapSurfaceBox(intent), { intent });
}

export async function loadSceneOntoSvg(
  root: SVGSVGElement,
  layer: SVGElement,
  document: SceneDocument,
  loadSeq = 0,
  boardMeta?: { loadSeq?: number },
  opts?: { infinite?: boolean; /** Skip generators + process-shimmer plates (export / cover). */ omitNonExportable?: boolean }
) {
  if (!root || !layer || !document?.deltaSetLike?.ROOT) {
    return new Map<string, SVGElement>();
  }

  const infinite = Boolean(opts?.infinite);
  const omitNonExportable = Boolean(opts?.omitNonExportable);
  const w = Math.round(document.width || 794);
  const h = Math.round(document.height || 1123);
  if (infinite) {
    applyInfiniteSvgViewport(root);
  } else {
    setAttrs(root, { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  }
  clearChildren(layer);

  const docBg = resolveDocumentBackground(document);
  if (!infinite && !isTransparentFill(docBg)) {
    const bg = appendChild(layer, svgEl('rect', { x: 0, y: 0, width: w, height: h }));
    setAttrs(bg, { 'data-scene-bg': '1', 'pointer-events': 'none' });
    applySvgFill(root, bg, docBg, 'doc-bg');
  }

  const children: string[] = document.deltaSetLike.ROOT.children || [];
  const nodeEls = new Map<string, SVGElement>();

  for (const nodeId of children) {
    if (boardMeta && loadSeq && boardMeta.loadSeq !== loadSeq) return nodeEls;
    const node = document.deltaSetLike[nodeId];
    if (shouldSkipNodeInSvgPaint(document, node, omitNonExportable)) continue;
    try {
      const el = await nodeToSvgElement(root, layer, document, node, nodeId);
      if (boardMeta && loadSeq && boardMeta.loadSeq !== loadSeq) {
        el?.remove();
        return nodeEls;
      }
      if (el) {
        applyFrameContentClip(root, el, document, node);
        nodeEls.set(nodeId, el);
      }
    } catch (err) {
      console.error('nodeToSvgElement failed', nodeId, err);
    }
  }

  if (infinite) fitInfiniteSvgToContent(root, layer);
  return nodeEls;
}

export function dedupeSceneNode(layer: SVGElement, nodeId: string, keep?: SVGElement | null) {
  try {
    const matches = [...layer.querySelectorAll('[data-scene-node-id]')].filter(
      (n) => n.getAttribute('data-scene-node-id') === nodeId
    );
    if (matches.length <= 1) return;
    const survivor = keep && matches.includes(keep) ? keep : matches[matches.length - 1];
    matches.forEach((n) => {
      if (n === survivor) return;
      detachSceneNodeEl(n);
    });
  } catch {
    /* ignore */
  }
}

export function purgeOrphanSceneNodes(
  layer: SVGElement,
  nodeEls: Map<string, SVGElement>,
  validIds?: Iterable<string>
) {
  try {
    const allowed = validIds ? new Set(validIds) : null;
    layer.querySelectorAll('[data-scene-node-id]').forEach((n) => {
      const id = n.getAttribute('data-scene-node-id');
      if (!id) return;
      if (allowed && !allowed.has(id)) {
        detachSceneNodeEl(n);
        return;
      }
      const keep = nodeEls.get(id);
      if (keep && n !== keep) {
        detachSceneNodeEl(n);
      }
    });
  } catch {
    /* ignore */
  }
}

function setPathD(target: Element | null | undefined, d: string): boolean {
  if (!target || !d) return false;
  target.setAttribute('d', d);
  // Keep outside-stroke underlay in sync (sibling behind the filled body).
  const parent = target.parentElement;
  if (parent) {
    parent.querySelectorAll(':scope > [data-stroke-under="1"]').forEach((u) => {
      u.setAttribute('d', d);
    });
  }
  const prev = target.previousElementSibling;
  if (prev instanceof Element && prev.getAttribute('data-stroke-under') === '1') {
    prev.setAttribute('d', d);
  }
  return true;
}

export function clearSceneDragPreview(nodeEls: Map<string, SVGElement>, nodeId: string) {
  const el = nodeEls.get(nodeId);
  if (!el) return;
  const bag = asHost(el);
  delete bag.__sceneDragBaseW;
  delete bag.__sceneDragBaseH;
  delete bag.__sceneDragBasePath;
  delete bag.__sceneDragBasePathRaw;
  delete bag.__sceneDragBaseFontSize;
  delete bag.__sceneDragBaseLetterSpacing;
  delete bag.__sceneDidResize;
}

function previewResizeText(
  el: SVGElement,
  box: { left: number; top: number; width: number; height: number },
  options?: {
    textResizeMode?: 'scale' | 'wrap' | 'frame';
    plainText?: string;
    textStyle?: ReturnType<typeof parseNodeTextStyle>;
  }
): boolean {
  const anyEl = asHost(el);
  if (String(anyEl.sceneNodeKey || '') !== 'text') return false;

  const geom = readGeom(el);
  if (!geom) return false;

  if (!anyEl.__sceneDragBaseW) {
    anyEl.__sceneDragBaseW = geom.width;
    anyEl.__sceneDragBaseH = geom.height;
    let fontSize = Number(anyEl.__sceneFontSize);
    if (!(fontSize > 0)) {
      fontSize = Number(String(el.getAttribute('font-size') || '').replace(/px$/i, '')) || 14;
    }
    anyEl.__sceneDragBaseFontSize = fontSize;
    const lsRaw = String(el.getAttribute('letter-spacing') || '0').replace(/px$/i, '');
    anyEl.__sceneDragBaseLetterSpacing = Number(lsRaw) || 0;
  }

  const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
  const baseFs = Math.max(1, Number(anyEl.__sceneDragBaseFontSize) || 14);
  const lineHeight = Math.max(0.8, Number(anyEl.__sceneLineHeight) || 1.4);
  const mode = options?.textResizeMode === 'wrap' ? 'wrap' : 'scale';
  const anchor = String(el.getAttribute('text-anchor') || 'start');
  const lineCount = Math.max(1, Number(anyEl.__sceneLineCount) || el.querySelectorAll('tspan').length || 1);
  const originY =
    anchor === 'middle'
      ? textVerticalOriginY(bh, baseFs, lineHeight, lineCount)
      : 0;

  let localX = 0;
  if (anchor === 'middle') localX = box.width / 2;
  else if (anchor === 'end') localX = box.width;

  if (mode === 'wrap') {
    const style = options?.textStyle || parseNodeTextStyle({});
    const plain =
      options?.plainText != null ? options.plainText : String(anyEl.__scenePlainText ?? '');
    // Prefer explicit style.fontSize (toolbar / style patch). Fall back to drag base
    // so width-only wrap resize keeps the committed size.
    const styleFs = Number(style.fontSize);
    const fontSize =
      Number.isFinite(styleFs) && styleFs > 0 ? Math.max(1, Math.round(styleFs)) : baseFs;
    const wrapStyle = { ...style, fontSize };
    const lines = wrapPlainTextLines(plain || ' ', wrapStyle, Math.max(24, box.width));
    const lineCountNow = Math.max(1, lines.length);
    const wrapOriginY =
      anchor === 'middle'
        ? textVerticalOriginY(box.height, fontSize, lineHeight, lineCountNow)
        : 0;
    clearChildren(el);
    const dy = `${lineHeight}em`;
    lines.forEach((line, i) => {
      const tspan = svgEl('tspan', {
        x: localX,
        ...(i === 0 ? { y: wrapOriginY } : { dy }),
      });
      tspan.textContent = line || ' ';
      el.appendChild(tspan);
    });
    setAttrs(el, {
      'font-family': toFabricFontFamily(style.fontFamily || wrapStyle.fontFamily),
      'font-size': fontSize,
      'font-weight': String(style.fontWeight || 'normal'),
      'font-style': style.fontStyle || 'normal',
      'text-anchor': svgTextAnchor(style.textAlign),
      fill: hexWithOpacity(style.fill || '#333333', style.fillOpacity ?? 100),
      x: localX,
      y: wrapOriginY,
      'dominant-baseline': 'text-before-edge',
      'alignment-baseline': 'before-edge',
    });
    anyEl.__sceneFontSize = fontSize;
    anyEl.__sceneDragBaseFontSize = fontSize;
    anyEl.__sceneDragBaseW = box.width;
    anyEl.__sceneDragBaseH = box.height;
    anyEl.__sceneLineCount = lineCountNow;
    anyEl.__scenePlainText = plain;
    anyEl.__sceneDidResize = false;
    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      abs: false,
    });
    reapplySceneTransform(el, box.left, box.top, box.width, box.height);
    return true;
  }

  const sy = box.height / bh;
  const fontSize = Math.max(1, baseFs * sy);
  setAttrs(el, {
    'font-size': fontSize,
    x: localX,
    y: originY,
    'dominant-baseline': 'text-before-edge',
    'alignment-baseline': 'before-edge',
  });
  anyEl.__sceneFontSize = fontSize;

  const baseLs = Number(anyEl.__sceneDragBaseLetterSpacing) || 0;
  if (baseLs || el.getAttribute('letter-spacing') != null) {
    setAttrs(el, { 'letter-spacing': `${baseLs * sy}px` });
  }

  el.querySelectorAll('tspan').forEach((t, i) => {
    if (i === 0) {
      t.removeAttribute('dy');
      t.setAttribute('y', String(originY));
      t.removeAttribute('x');
    }
  });

  anyEl.__sceneDidResize = false;
  writeGeom(el, {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    abs: false,
  });
  reapplySceneTransform(el, box.left, box.top, box.width, box.height);
  return true;
}

export function readScenePaintLocalSize(
  el: SVGElement | null | undefined,
  fallback: { width: number; height: number }
): { width: number; height: number } {
  if (!el) return fallback;
  const geom = readGeom(el);
  if (geom) {
    return {
      width: Math.max(1, geom.width),
      height: Math.max(1, geom.height),
    };
  }
  return {
    width: Math.max(1, fallback.width),
    height: Math.max(1, fallback.height),
  };
}

function isProcessPlateHost(el: SVGElement): boolean {
  return el.getAttribute('data-rcb-process-plate') === '1';
}

function syncTextFrameForeignObject(
  host: SVGElement | null | undefined,
  width: number,
  height: number
): void {
  if (!host) return;
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fo = host.querySelector(
    'foreignObject[data-rcb-html-media-fo="text"]'
  ) as SVGForeignObjectElement | null;
  if (!fo) return;
  fo.setAttribute('width', String(w));
  fo.setAttribute('height', String(h));
}

function previewResizeTextFrame(
  el: SVGElement,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  writeGeom(el, { left: box.left, top: box.top, width: w, height: h, abs: false });
  previewResizeLocalGeometry(el, w, h);
  syncTextFrameForeignObject(el, w, h);
  reapplySceneTransform(el, box.left, box.top, w, h);
  return true;
}

function syncElementBox(el: Element, width: number, height: number): void {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  el.setAttribute('width', String(w));
  el.setAttribute('height', String(h));
}

function syncHtmlMediaForeignObject(
  host: SVGElement | null | undefined,
  width: number,
  height: number
): void {
  if (!host) return;
  const fo = host.querySelector('foreignObject[data-rcb-html-media-fo]');
  if (fo) syncElementBox(fo, width, height);
  const lottieSvg = host.querySelector('svg[data-rcb-lottie-svg-ink="1"]');
  if (lottieSvg) syncElementBox(lottieSvg, width, height);
}

/** Poster / underlay <image> + clipPath — keep in sync when FO resizes (no CSS scale). */
function syncMediaPlateLocalPaint(el: SVGElement, width: number, height: number, prevW: number, prevH: number) {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const pw = Math.max(1, prevW);
  const ph = Math.max(1, prevH);
  previewResizeLocalGeometry(el, w, h);

  const clipId = el.getAttribute('data-radius-clip-id');
  if (clipId && el.ownerSVGElement) {
    try {
      const clipPath = el.ownerSVGElement.querySelector(
        `#${CSS.escape(clipId)} path`
      ) as SVGPathElement | null;
      if (clipPath) {
        const liveR = clampCornerRadii(readSceneCornerRadii(el), w, h);
        clipPath.setAttribute('d', roundedRectPath(w, h, liveR));
      }
    } catch {
      /* ignore bad clip id */
    }
  }

  const sx = w / pw;
  const sy = h / ph;
  if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6) {
    el.querySelectorAll(':scope > image').forEach((node) => {
      const img = node as SVGImageElement;
      const ix = Number(img.getAttribute('x') || 0);
      const iy = Number(img.getAttribute('y') || 0);
      const iw = Number(img.getAttribute('width') || pw);
      const ih = Number(img.getAttribute('height') || ph);
      setAttrs(img, {
        x: ix * sx,
        y: iy * sy,
        width: Math.max(1, iw * sx),
        height: Math.max(1, ih * sy),
      });
    });
  }

  syncHtmlMediaForeignObject(el, w, h);
}

/**
 * Video / lottie / audio HTML mounts: resize FO + underlay dims directly.
 * CSS scale(sx,sy) would leave portaled chrome (scrubber) at the wrong local
 * box while geometryOverrides already use the new size — controls "run away".
 */
function previewResizeHtmlMediaPlate(
  el: SVGElement,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  const geom = readGeom(el);
  if (!geom) return false;
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  const prevW = Math.max(1, geom.width);
  const prevH = Math.max(1, geom.height);
  writeGeom(el, { left: box.left, top: box.top, width: w, height: h, abs: false });
  syncMediaPlateLocalPaint(el, w, h, prevW, prevH);
  reapplySceneTransform(el, box.left, box.top, w, h);
  return true;
}

function previewResizeProcessPlate(
  el: SVGElement,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  writeGeom(el, { left: box.left, top: box.top, width: w, height: h, abs: false });
  if (!previewResizeLocalGeometry(el, w, h)) return false;
  const liveR = clampCornerRadii(readSceneCornerRadii(el), w, h);
  syncProcessPlateGeometry(el, roundedRectPath(w, h, liveR));
  syncProcessPillForeignObject(el, w, h);
  reapplySceneTransform(el, box.left, box.top, w, h);
  return true;
}

function previewResizeImage(
  el: SVGElement,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  const anyEl = asHost(el);
  const key = String(anyEl.sceneNodeKey || el.getAttribute('data-scene-node-key') || '');
  // Video / lottie / audio plates use the same poster/<image> (or path) group layout as images.
  if (key !== 'image' && key !== 'video' && key !== 'lottie' && key !== 'audio') {
    return false;
  }

  const geom = readGeom(el);
  if (!geom) return false;

  const w = Math.max(1, box.width);
  const h = Math.max(1, box.height);
  if (isProcessPlateHost(el)) {
    return previewResizeProcessPlate(el, box);
  }

  const EPS = 1e-3;
  const sameSize =
    Math.abs(geom.width - w) < EPS && Math.abs(geom.height - h) < EPS;

  // Pure translate — keep bitmap attrs; just move the group.
  if (sameSize && !anyEl.__sceneDidResize) {
    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: w,
      height: h,
      abs: false,
    });
    reapplySceneTransform(el, box.left, box.top, w, h);
    return true;
  }

  // Live resize: scale the group (same as svg/custom-path nodes). Mutating
  // <image width/height> alone does not reliably repaint under per-shape
  // infinite SVG hosts — the control box moves while the bitmap stays put.
  // HTML media FO stays at drag-base size and rides this CSS scale so portaled
  // chrome (scrubber) stays glued to the plate. Final size is baked on commit.
  if (!anyEl.__sceneDragBaseW) {
    anyEl.__sceneDragBaseW = geom.width;
    anyEl.__sceneDragBaseH = geom.height;
  }
  anyEl.__sceneDidResize = true;
  const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
  const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);

  writeGeom(el, {
    left: box.left,
    top: box.top,
    width: w,
    height: h,
    abs: false,
  });
  reapplySceneTransformScaled(el, box.left, box.top, bw, bh, w / bw, h / bh);
  return true;
}

export function previewSvgNodeAngle(
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  angleDeg: number,
  _sceneDocument?: SceneDocument | null,
  options?: { publishPreview?: boolean }
): boolean {
  // Fact layer (SoA / Canvas) must see playhead rotation — SVG host alone is not enough
  // when vectors paint as SoA canvas ink without a DOM host.
  if (options?.publishPreview !== false) {
    setNodeTransformAngles([{ nodeId, angle: angleDeg }]);
  }
  const el = nodeEls.get(nodeId);
  if (!el) return true;
  asHost(el).__sceneAngle = angleDeg;
  return previewSvgNodeTransform(nodeEls, nodeId);
}

/** Live-update angle / flip on an existing paint host — no path rebuild. */
export function previewSvgNodeTransform(
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  node?: SceneNodeInput | null
): boolean {
  const el = nodeEls.get(nodeId);
  if (!el) return false;
  const geom = readGeom(el);
  if (!geom) return false;

  const anyEl = asHost(el);
  if (node) {
    const meta = objectMeta(node);
    anyEl.__sceneAngle = meta.angle;
    anyEl.__sceneSkewX = meta.skewX;
    anyEl.__sceneSkewY = meta.skewY;
    anyEl.__sceneSkewAxis = meta.skewAxis;
    anyEl.__sceneAnchorX = meta.anchorX;
    anyEl.__sceneAnchorY = meta.anchorY;
    anyEl.__sceneFlipX = meta.flipX;
    anyEl.__sceneFlipY = meta.flipY;
  }
  const baseW = Number(anyEl.__sceneDragBaseW);
  const baseH = Number(anyEl.__sceneDragBaseH);
  const shapeType = String(
    anyEl.sceneShapeType || el.getAttribute('data-scene-shape-type') || ''
  );
  const pathDScaled =
    isCustomPathShape(shapeType) &&
    el.tagName.toLowerCase() === 'path' &&
    Boolean(anyEl.__sceneDragBasePath);
  if (anyEl.__sceneDidResize && baseW > 0 && baseH > 0 && !pathDScaled) {
    reapplySceneTransformScaled(
      el,
      geom.left,
      geom.top,
      baseW,
      baseH,
      geom.width / baseW,
      geom.height / baseH
    );
  } else {
    reapplySceneTransform(el, geom.left, geom.top, geom.width, geom.height);
  }
  return true;
}

function reapplySceneTransformScaled(
  el: SVGElement,
  left: number,
  top: number,
  baseW: number,
  baseH: number,
  sx: number,
  sy: number
) {
  const anyEl = asHost(el);
  const angle = Number(anyEl.__sceneAngle) || 0;
  const skewX = Number(anyEl.__sceneSkewX) || 0;
  const skewY = Number(anyEl.__sceneSkewY) || 0;
  const skewAxis = Number(anyEl.__sceneSkewAxis) || 0;
  const anchorX = Math.max(0, Math.min(100, Number(anyEl.__sceneAnchorX ?? 50)));
  const anchorY = Math.max(0, Math.min(100, Number(anyEl.__sceneAnchorY ?? 50)));
  const flipX = !!anyEl.__sceneFlipX;
  const flipY = !!anyEl.__sceneFlipY;
  const geom = readGeom(el);
  const abs = geom ? geom.abs : !!anyEl.__sceneAbsPos;
  const isolateFlip = hostIsolatesHtmlMediaFlip(el);
  const parts: string[] = [];

  if (!abs) {
    parts.push(`translate(${left} ${top})`);
    if (Math.abs(sx - 1) > 1e-4 || Math.abs(sy - 1) > 1e-4) {
      parts.push(`scale(${sx} ${sy})`);
    }
  }

  const rx = abs ? left + (baseW * sx * anchorX) / 100 : (baseW * anchorX) / 100;
  const ry = abs ? top + (baseH * sy * anchorY) / 100 : (baseH * anchorY) / 100;
  const doFlip = (flipX || flipY) && !isolateFlip;
  const needPivot =
    Math.abs(angle) > 1e-6 ||
    Math.abs(skewX) > 1e-6 ||
    Math.abs(skewY) > 1e-6 ||
    Math.abs(skewAxis) > 1e-6 ||
    doFlip;

  if (needPivot) {
    parts.push(`translate(${rx} ${ry})`);
    if (angle) parts.push(`rotate(${angle})`);
    if (skewAxis) parts.push(`rotate(${skewAxis})`);
    if (skewX) parts.push(`skewX(${skewX})`);
    if (skewAxis) parts.push(`rotate(${-skewAxis})`);
    if (skewY) parts.push(`skewY(${skewY})`);
    if (doFlip) {
      parts.push(`scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})`);
    }
    parts.push(`translate(${-rx} ${-ry})`);
  }

  if (parts.length) setAttrs(el, { transform: parts.join(' ') });
  else el.removeAttribute('transform');
  if (isolateFlip) syncHtmlMediaUnderlayFlip(el, baseW, baseH);
  syncStrokeUnderlayTransform(el);
}

/** Image / diffuse / baked-angular fills use userSpaceOnUse patterns — regen `d` alone leaves stale tiles. */
function baselineFillUsesPattern(el: SVGElement): boolean {
  const host =
    el.tagName.toLowerCase() === 'g'
      ? el
      : el.parentElement instanceof SVGElement
        ? el.parentElement
        : el;
  const body =
    host.querySelector(':scope > [data-baseline="1"]') ||
    host.querySelector(':scope > path:not([data-stroke-under])');
  const target =
    body instanceof SVGElement
      ? body
      : host.getAttribute('data-baseline') === '1'
        ? host
        : null;
  if (!target) return false;
  const fill = target.getAttribute('fill') || '';
  const m = /^url\(#([^)]+)\)$/.exec(fill.trim());
  if (!m?.[1]) return false;
  const root = el.ownerSVGElement;
  if (!root) return false;
  try {
    const ref = root.querySelector(`#${CSS.escape(m[1])}`);
    return ref?.localName === 'pattern';
  } catch {
    return false;
  }
}

function previewResizeLocalGeometry(el: SVGElement, width: number, height: number): boolean {
  const anyEl = asHost(el);
  const shapeType = String(
    anyEl.sceneShapeType || el.getAttribute('data-scene-shape-type') || ''
  );

  if (isCustomPathShape(shapeType)) return false;

  if (shapeType === 'line') {
    const mid = Math.max(1, height) / 2;
    setAttrs(el, { x1: 0, y1: mid, x2: width, y2: mid });
    return true;
  }

  if (shapeType === 'arrow') {
    const d =
      getShapeBaselineD({
        key: 'shape',
        width,
        height,
        attrs: { shapeType: 'arrow' },
      }) || '';
    if (el.tagName.toLowerCase() === 'path') return setPathD(el, d);
    return false;
  }

  if (shapeType === 'circle') {
    const live = readSceneEllipseParams(el);
    const d =
      getShapeBaselineD({
        key: 'shape',
        width,
        height,
        attrs: {
          shapeType: 'circle',
          ellipseInnerRatio: live.innerRatio,
          ellipseArcPercent: live.arcPercent,
          ellipseStartDeg: live.startDeg,
        },
      }) || '';
    const body =
      el.tagName.toLowerCase() === 'path'
        ? el
        : el.querySelector('[data-baseline="1"]') ||
          el.querySelector('path:not([data-stroke-under])');
    if (live.innerRatio > 1e-4 && body instanceof Element) {
      body.setAttribute('fill-rule', 'evenodd');
    } else if (body instanceof Element) {
      body.removeAttribute('fill-rule');
    }
    if (el.tagName.toLowerCase() === 'path') return setPathD(el, d);
    return setPathD(body, d);
  }

  const liveR = clampCornerRadii(readSceneCornerRadii(el), width, height);

  if (shapeType === 'triangle' || shapeType === 'star' || shapeType === 'polygon') {
    const d =
      getShapeBaselineD({
        key: 'shape',
        width,
        height,
        attrs: {
          shapeType,
          sides: readSceneSides(el),
          radiusTL: liveR.tl,
          radiusTR: liveR.tr,
          radiusBR: liveR.br,
          radiusBL: liveR.bl,
        },
      }) || roundedShapePath(shapeType, width, height, liveR, readSceneSides(el));
    if (el.tagName.toLowerCase() === 'path') return setPathD(el, d);
    return setPathD(el.querySelector('path'), d);
  }

  if (shapeType === 'rect' || shapeType === 'roundRect' || shapeType === '') {
    // Must keep cached corner radii — zeroR made move/resize flash a sharp rect.
    const d = roundedRectPath(width, height, liveR);
    if (el.tagName.toLowerCase() === 'path') return setPathD(el, d);
    // Prefer the filled baseline body (not the stroke underlay).
    const body =
      el.querySelector(':scope > [data-baseline="1"]') ||
      el.querySelector(':scope > [data-radius-body="1"]:not([data-stroke-under])') ||
      el.querySelector(':scope > path:not([data-stroke-under])');
    return setPathD(body, d);
  }

  return false;
}

function dmoveAbs(el: SVGElement, dx: number, dy: number) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'line') {
    setAttrs(el, {
      x1: num(el.getAttribute('x1')) + dx,
      y1: num(el.getAttribute('y1')) + dy,
      x2: num(el.getAttribute('x2')) + dx,
      y2: num(el.getAttribute('y2')) + dy,
    });
    return;
  }
  if (el.hasAttribute('x') || el.hasAttribute('y')) {
    setAttrs(el, {
      x: num(el.getAttribute('x')) + dx,
      y: num(el.getAttribute('y')) + dy,
    });
  }
}

export function previewSvgNodeGeometry(
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  box: { left: number; top: number; width: number; height: number },
  options?: {
    textResizeMode?: 'scale' | 'wrap' | 'frame';
    plainText?: string;
    textStyle?: ReturnType<typeof parseNodeTextStyle>;
    /** false = SVG/DOM only (restore after scrub — avoid preview publish flash). */
    publishPreview?: boolean;
  }
): boolean {
  // Fact-layer first (ADR 0027): Canvas/SoA reads TransformPreview even when
  // there is no SVG host (canvas-ink vectors).
  if (options?.publishPreview !== false) {
    setNodeTransformPreviews([
      {
        nodeId,
        left: box.left,
        top: box.top,
        width: Math.max(1, box.width),
        height: Math.max(1, box.height),
      },
    ]);
  }
  const el = nodeEls.get(nodeId);
  if (!el) return true;
  const anyEl = asHost(el);
  const nodeKey = String(anyEl.sceneNodeKey || el.getAttribute('data-scene-node-key') || '');

  if (nodeKey === 'image' || nodeKey === 'video' || nodeKey === 'lottie' || nodeKey === 'audio') {
    return previewResizeImage(el, box);
  }
  if (nodeKey === 'svg') {
    // Scale whole group like a custom path — content re-renders on commit.
    const geom = readGeom(el);
    if (!geom) return false;
    if (!anyEl.__sceneDragBaseW) {
      anyEl.__sceneDragBaseW = geom.width;
      anyEl.__sceneDragBaseH = geom.height;
    }
    anyEl.__sceneDidResize = true;
    const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
    const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      abs: false,
    });
    reapplySceneTransformScaled(
      el,
      box.left,
      box.top,
      bw,
      bh,
      box.width / bw,
      box.height / bh
    );
    return true;
  }

  const geom = readGeom(el);
  if (!geom) return false;

  const EPS = 1e-3;
  const sameSize =
    Math.abs(geom.width - box.width) < EPS && Math.abs(geom.height - box.height) < EPS;
  const samePos =
    Math.abs(geom.left - box.left) < EPS && Math.abs(geom.top - box.top) < EPS;

  if (geom.abs && sameSize && !samePos) {
    const dx = box.left - geom.left;
    const dy = box.top - geom.top;
    if (dx || dy) dmoveAbs(el, dx, dy);
    writeGeom(el, { ...geom, left: box.left, top: box.top });
    const root = el.ownerSVGElement;
    if (root) panInfiniteSvgViewport(root, dx, dy);
    return true;
  }

  if (!geom.abs) {
    const shapeType = String(
      anyEl.sceneShapeType || el.getAttribute('data-scene-shape-type') || ''
    );
    const isStrokeShape = shapeType === 'line' || shapeType === 'arrow';
    const isText = String(anyEl.sceneNodeKey || el.getAttribute('data-scene-node-key') || '') === 'text';

    if (isText) {
      // Fixed text plates use FO scroll mounts — resize FO dims directly (no CSS scale).
      if (el.querySelector?.('foreignObject[data-rcb-html-media-fo="text"]')) {
        return previewResizeTextFrame(el, box);
      }
      return previewResizeText(el, box, options);
    }

    // Custom path (boolean / pen): scale path `d` like commit (`scalePathData`).
    // CSS scale(sx,sy) also scales stroke → anisotropic edge thickness while dragging.
    // Stamp pencil hosts are <g> — keep CSS scale for those bitmaps.
    if (isCustomPathShape(shapeType) && (!sameSize || anyEl.__sceneDidResize)) {
      if (!anyEl.__sceneDragBaseW) {
        anyEl.__sceneDragBaseW = geom.width;
        anyEl.__sceneDragBaseH = geom.height;
      }
      anyEl.__sceneDidResize = true;
      const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
      const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
      writeGeom(el, {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        abs: false,
      });

      if (el.tagName.toLowerCase() === 'path') {
        if (!anyEl.__sceneDragBasePath) {
          anyEl.__sceneDragBasePath = el.getAttribute('d') || '';
          anyEl.__sceneDragBasePathRaw =
            String(anyEl.__sceneBasePath || '') ||
            el.getAttribute('data-scene-base-path') ||
            anyEl.__sceneDragBasePath;
        }
        const baseD = String(anyEl.__sceneDragBasePath || '');
        if (baseD) {
          const sx = box.width / bw;
          const sy = box.height / bh;
          const nextD = scalePathData(baseD, sx, sy);
          setPathD(el, nextD);
          const rawBase = String(anyEl.__sceneDragBasePathRaw || '');
          if (rawBase) {
            const nextRaw = scalePathData(rawBase, sx, sy);
            anyEl.__sceneBasePath = nextRaw;
            el.setAttribute('data-scene-base-path', nextRaw);
          }
          reapplySceneTransform(el, box.left, box.top, box.width, box.height);
          return true;
        }
      }

      reapplySceneTransformScaled(
        el,
        box.left,
        box.top,
        bw,
        bh,
        box.width / bw,
        box.height / bh
      );
      return true;
    }

    if (isStrokeShape) {
      if (!sameSize) anyEl.__sceneDidResize = true;
      writeGeom(el, {
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        abs: false,
      });
      if (!previewResizeLocalGeometry(el, box.width, box.height)) return false;
      reapplySceneTransform(el, box.left, box.top, box.width, box.height);
      return true;
    }

    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      abs: false,
    });
    // Pure move: only translate. Regenerating local `d` (even at same size) used
    // to wipe corner radii and flash a sharp rect until commit remounted.
    if (sameSize && !anyEl.__sceneDidResize) {
      const dLeft = box.left - geom.left;
      const dTop = box.top - geom.top;
      reapplySceneTransform(el, box.left, box.top, box.width, box.height);
      // Glue host viewBox to the translate so ink stays in-bounds (not overflow).
      const root = el.ownerSVGElement;
      if (root) panInfiniteSvgViewport(root, dLeft, dTop);
      return true;
    }
    if (
      !baselineFillUsesPattern(el) &&
      previewResizeLocalGeometry(el, box.width, box.height)
    ) {
      if (!sameSize) anyEl.__sceneDidResize = true;
      reapplySceneTransform(el, box.left, box.top, box.width, box.height);
      return true;
    }
    // Pattern fills: scale the painted group so the bitmap/pattern tracks the box
    // (same live-resize contract as image plates). Commit remounts at final size.
    if (baselineFillUsesPattern(el) && (!sameSize || anyEl.__sceneDidResize)) {
      if (!anyEl.__sceneDragBaseW) {
        anyEl.__sceneDragBaseW = geom.width;
        anyEl.__sceneDragBaseH = geom.height;
      }
      anyEl.__sceneDidResize = true;
      const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
      const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
      reapplySceneTransformScaled(
        el,
        box.left,
        box.top,
        bw,
        bh,
        box.width / bw,
        box.height / bh
      );
      return true;
    }
    // Scale-preview shapes (fallback): same min-clamp rule as custom path.
    if (!sameSize || anyEl.__sceneDidResize) {
      if (!anyEl.__sceneDragBaseW) {
        anyEl.__sceneDragBaseW = geom.width;
        anyEl.__sceneDragBaseH = geom.height;
      }
      anyEl.__sceneDidResize = true;
      const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
      const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
      reapplySceneTransformScaled(
        el,
        box.left,
        box.top,
        bw,
        bh,
        box.width / bw,
        box.height / bh
      );
      return true;
    }
    reapplySceneTransform(el, box.left, box.top, box.width, box.height);
    return true;
  }

  if (geom.abs && sameSize && !anyEl.__sceneDidResize) {
    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      abs: geom.abs,
    });
    reapplySceneTransform(el, box.left, box.top, box.width, box.height);
    return true;
  }

  if (!sameSize || anyEl.__sceneDidResize) {
    if (!anyEl.__sceneDragBaseW) {
      anyEl.__sceneDragBaseW = geom.width;
      anyEl.__sceneDragBaseH = geom.height;
    }
    anyEl.__sceneDidResize = true;
    const bw = Math.max(1, Number(anyEl.__sceneDragBaseW) || geom.width);
    const bh = Math.max(1, Number(anyEl.__sceneDragBaseH) || geom.height);
    writeGeom(el, {
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      abs: geom.abs,
    });
    reapplySceneTransformScaled(
      el,
      box.left,
      box.top,
      bw,
      bh,
      box.width / bw,
      box.height / bh
    );
    return true;
  }

  writeGeom(el, {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    abs: geom.abs,
  });
  reapplySceneTransform(el, box.left, box.top, box.width, box.height);
  return true;
}

/**
 * Live circle / ellipse inner-radius + arc preview without remounting.
 */
export function previewSvgNodeEllipseParams(
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  opts: {
    width: number;
    height: number;
    innerRatio: number;
    arcPercent: number;
    startDeg?: number;
  }
): boolean {
  const el = nodeEls.get(nodeId);
  if (!el) return false;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const innerRatio = clampEllipseInnerRatio(opts.innerRatio);
  const arcPercent = clampEllipseArcPercent(opts.arcPercent);
  const startDeg = clampEllipseStartDeg(opts.startDeg);
  const d =
    getShapeBaselineD({
      key: 'shape',
      width: w,
      height: h,
      attrs: {
        shapeType: 'circle',
        ellipseInnerRatio: innerRatio,
        ellipseArcPercent: arcPercent,
        ellipseStartDeg: startDeg,
      },
    }) || '';
  if (!d) return false;
  rememberSceneEllipseParams(el, innerRatio, arcPercent, startDeg);
  const body =
    el.tagName.toLowerCase() === 'path'
      ? el
      : el.querySelector(':scope > [data-baseline="1"]') ||
        el.querySelector(':scope > path:not([data-stroke-under])');
  if (body instanceof Element) {
    if (innerRatio > 1e-4) body.setAttribute('fill-rule', 'evenodd');
    else body.removeAttribute('fill-rule');
  }
  if (el.tagName.toLowerCase() === 'path') return setPathD(el, d);
  return setPathD(body, d);
}

/**
 * Live corner-radius preview without remounting the shape host.
 * (store skipHistory patches remount via documentPatchToken and can leave ghosts.)
 */
export function previewSvgNodeCornerRadii(
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  opts: {
    width: number;
    height: number;
    shapeType: string;
    radii: CornerRadii;
    attrs?: Record<string, unknown> | null;
    sides?: number;
  }
): boolean {
  const el = nodeEls.get(nodeId);
  if (!el) return false;
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const r = clampCornerRadii(opts.radii, w, h);
  const t = String(opts.shapeType || 'rect');

  let d = '';
  if (t === 'path') {
    const base =
      String(asHost(el).__sceneBasePath || '') ||
      el.getAttribute('data-scene-base-path') ||
      '';
    if (!base.trim()) return false;
    d = filletPathD(base, r, opts.attrs);
  } else if (t === 'triangle' || t === 'star' || t === 'polygon') {
    d =
      roundedShapePath(
        t,
        w,
        h,
        r,
        opts.sides ?? readSceneSides(el),
        opts.attrs
      ) || '';
  } else if (t === 'circle' || t === 'line' || t === 'arrow' || t === 'pen') {
    return false;
  } else {
    d = roundedRectPath(w, h, r);
  }
  if (!d) return false;

  rememberSceneCornerRadii(el, r);

  let ok = false;
  if (el.tagName.toLowerCase() === 'path') {
    ok = setPathD(el, d);
  } else {
    const body =
      el.querySelector(':scope > [data-baseline="1"]') ||
      el.querySelector(':scope > [data-radius-body="1"]:not([data-stroke-under])') ||
      el.querySelector(':scope > path:not([data-stroke-under])');
    ok = setPathD(body, d);
  }

  // Image / video: visible rounding is a <clipPath> in defs (baseline path is pe:none).
  const clipId = String(el.getAttribute('data-radius-clip-id') || '').trim();
  if (clipId) {
    const root = el.ownerSVGElement;
    let clipPathEl: Element | null = null;
    try {
      const clip = root?.getElementById(clipId);
      clipPathEl = clip?.querySelector('[data-radius-clip="1"]') || clip?.querySelector('path') || null;
    } catch {
      clipPathEl = null;
    }
    if (setPathD(clipPathEl, d)) ok = true;
  }

  return ok;
}

function removeSceneNodesById(layer: SVGElement, nodeId: string) {
  try {
    layer.querySelectorAll('[data-scene-node-id]').forEach((n) => {
      if (n.getAttribute('data-scene-node-id') !== nodeId) return;
      detachSceneNodeEl(n);
    });
  } catch {
    /* ignore */
  }
}

const replaceGenByMap = new WeakMap<object, Map<string, number>>();

export async function replaceSvgNode(
  root: SVGSVGElement,
  layer: SVGElement,
  document: SceneDocument,
  nodeEls: Map<string, SVGElement>,
  nodeId: string,
  opts?: { /** When false, caller (RcbShapeHost) owns frame clip. Default true. */ applyFrameClip?: boolean }
) {
  let gens = replaceGenByMap.get(nodeEls);
  if (!gens) {
    gens = new Map();
    replaceGenByMap.set(nodeEls, gens);
  }
  const gen = (gens.get(nodeId) || 0) + 1;
  gens.set(nodeId, gen);

  removeSceneNodesById(layer, nodeId);
  const prev = nodeEls.get(nodeId);
  if (prev) {
    detachSceneNodeEl(prev);
    nodeEls.delete(nodeId);
  }

  const node = document.deltaSetLike?.[nodeId];
  const el = await nodeToSvgElement(root, layer, document, node, nodeId);
  if (gens.get(nodeId) !== gen) {
    el?.remove();
    return;
  }
  if (!el) return;
  dedupeSceneNode(layer, nodeId, el);
  if (opts?.applyFrameClip !== false) {
    applyFrameContentClip(root, el, document, node);
  }
  nodeEls.set(nodeId, el);
  try {
    fitInfiniteSvgToContent(root, layer);
  } catch {
    /* ignore */
  }
}

export function createSvgBoard(
  host: HTMLElement,
  width: number,
  height: number,
  opts?: {
    infinite?: boolean;
    /** Attach a layer `<g>` into the shared world SVG instead of a private root. */
    sharedRoot?: SVGSVGElement | null;
    sharedMount?: SVGGElement | null;
  }
): { root: SVGSVGElement; layer: SVGGElement; shared: boolean } {
  const infinite = Boolean(opts?.infinite);
  const sharedRoot = opts?.sharedRoot;
  const sharedMount = opts?.sharedMount;
  if (infinite && sharedRoot && sharedMount) {
    const layer = appendChild(
      sharedMount,
      svgEl('g', { id: 'scene-layer', 'data-rcb-shape-layer': '1' })
    );
    return { root: sharedRoot, layer, shared: true };
  }
  const root = createSvgRoot(host);
  if (infinite) {
    applyInfiniteSvgViewport(root);
  } else {
    setAttrs(root, {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
      'shape-rendering': 'geometricPrecision',
    });
    setStyles(root, {
      display: 'block',
      overflow: 'visible',
      width: '100%',
      height: '100%',
    });
  }
  const layer = appendChild(root, svgEl('g', { id: 'scene-layer' }));
  return { root, layer, shared: false };
}
