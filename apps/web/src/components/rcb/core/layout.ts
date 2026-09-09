import { RCB_MIN_ZOOM, rcbCameraCssZoom } from './math';
import type { RcbCamera } from './types';
import type { RcbVec } from './types';

/**
 * On-canvas size for an uploaded / pasted image / generator plate.
 *
 * Scene units are zoom-independent, so a fixed pixel cap lands huge when the user
 * is zoomed out and postage-stamp small when zoomed in. Measure against the visible
 * viewport instead: keep the natural size while it already reads well, otherwise
 * scale so the image covers between `minRatio` and `maxRatio` of the screen.
 *
 * `viewport` is the on-screen stage size in CSS px; `zoom` the current camera zoom.
 *
 * When natural is larger than the viewport band, we **shrink** (scale < 1).
 * When natural is smaller, we may upscale up to `maxRatio` but never above
 * `contain(maxRatio)`.
 */
export function rcbFitImageIntoViewport(
  natural: { width: number; height: number },
  viewport: { width: number; height: number },
  zoom: number,
  { minRatio = 0.25, maxRatio = 0.6 }: { minRatio?: number; maxRatio?: number } = {}
): { width: number; height: number } {
  const nw = Math.max(1, Number(natural.width) || 1);
  const nh = Math.max(1, Number(natural.height) || 1);
  const z = Math.max(RCB_MIN_ZOOM, Number(zoom) || 1);
  // Visible scene rect (CSS px / zoom).
  const vw = Math.max(1, (Number(viewport.width) || 1) / z);
  const vh = Math.max(1, (Number(viewport.height) || 1) / z);
  const contain = (ratio: number) => Math.min((vw * ratio) / nw, (vh * ratio) / nh);
  const maxScale = contain(maxRatio);
  const minScale = contain(minRatio);
  // Prefer natural (scale 1) when it already sits in [min, max] band.
  let scale = 1;
  if (maxScale < 1) {
    // Natural too big for the viewport band — shrink to maxRatio.
    scale = maxScale;
  } else if (minScale > 1) {
    // Natural too small — grow toward minRatio (capped by maxScale).
    scale = Math.min(minScale, maxScale);
  }
  return {
    width: Math.max(1, Math.round(nw * scale)),
    height: Math.max(1, Math.round(nh * scale)),
  };
}

/**
 * Center a node-sized rect on a point (e.g. drop image centered on pointer).
 */
export function rcbCenterOnPoint(
  point: RcbVec,
  size: { width: number; height: number }
): { left: number; top: number; width: number; height: number } {
  const w = Math.max(1, Number(size.width) || 1);
  const h = Math.max(1, Number(size.height) || 1);
  return {
    left: point.x - w / 2,
    top: point.y - h / 2,
    width: w,
    height: h,
  };
}

/** Empty generator plates use an inset border — outer edge === path (no center-stroke outset). */
export const GENERATOR_EMPTY_STROKE_OUTSET = 0;

function snapCoord(value: number, gridSize: number): number {
  if (!(gridSize > 0) || !Number.isFinite(value)) return value;
  return Math.round(value / gridSize) * gridSize;
}

/** Snap all four edges (same contract as selection `snapBoxEdgesToGrid`). */
function snapEdgesToGrid(
  box: { left: number; top: number; width: number; height: number },
  gridSize: number,
  minCells = 1
): { left: number; top: number; width: number; height: number } {
  if (!(gridSize > 0)) return box;
  let left = snapCoord(box.left, gridSize);
  let top = snapCoord(box.top, gridSize);
  let right = snapCoord(box.left + box.width, gridSize);
  let bottom = snapCoord(box.top + box.height, gridSize);
  const min = Math.max(1, minCells) * gridSize;
  if (right - left < min) right = left + min;
  if (bottom - top < min) bottom = top + min;
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Fit → center → snap painted outer to the pixel grid → optional outset inset
 * for path geom. Image/video generators use inset borders (outset 0) so path
 * edges are the ink edges — never leave a half-cell float outside the grid.
 */
export function rcbLayoutGeneratorPlate(opts: {
  natural: { width: number; height: number };
  viewport: { width: number; height: number };
  zoom: number;
  center: RcbVec;
  gridSize?: number;
  /** Outside path extent of center stroke (generators = 0.5). */
  visualOutset?: number;
  fit?: { minRatio?: number; maxRatio?: number };
}): { left: number; top: number; width: number; height: number; visual: { left: number; top: number; width: number; height: number } } {
  const gridSize = opts.gridSize != null && opts.gridSize > 0 ? opts.gridSize : 1;
  const outset = Math.max(0, Number(opts.visualOutset) || 0);
  const sized = rcbFitImageIntoViewport(opts.natural, opts.viewport, opts.zoom, opts.fit);
  const placed = rcbCenterOnPoint(opts.center, sized);
  const rawVisual = {
    left: placed.left - outset,
    top: placed.top - outset,
    width: placed.width + outset * 2,
    height: placed.height + outset * 2,
  };
  const minCells = Math.max(1, Math.ceil((outset * 2) / gridSize) + 1);
  const visual = snapEdgesToGrid(rawVisual, gridSize, minCells);
  const geom = {
    left: visual.left + outset,
    top: visual.top + outset,
    width: Math.max(gridSize, visual.width - outset * 2),
    height: Math.max(gridSize, visual.height - outset * 2),
  };
  return { ...geom, visual };
}

/** Empty-state glyph size in scene units — always fits inside the plate. */
/**
 * Cap Lucide size in CSS px so stroke weight stays title-like (~2 in 24 box).
 * Without this, a 360wu plate made a ~100wu icon with ~8 CSS px strokes (too dark).
 */
export const GENERATOR_EMPTY_ICON_MAX_CSS_PX = 48;

export function generatorEmptyIconSize(boxW: number, boxH: number, zoom = 1): number {
  const side = Math.min(Math.max(0, boxW), Math.max(0, boxH));
  // Never floor to a fixed scene px (old Math.max(72, …) overflowed at 3000% zoom).
  const byPlate = side * 0.28;
  const z = Math.max(0.05, Number(zoom) || 1);
  const byScreen = GENERATOR_EMPTY_ICON_MAX_CSS_PX / z;
  return Math.min(byPlate, byScreen);
}

/**
 * Whether to paint the empty-gen glyph.
 * High zoom places ~5–18 scene plates — old `>= 4` skipped icons that still
 * read clearly once CSS/`uZoom` scales the plate up.
 */
export function generatorEmptyIconVisible(iconSize: number): boolean {
  return Number(iconSize) >= 0.35;
}

/** On-screen target when placing new text (T-tool, paste, agent). ~18 CSS px ≈ readable body copy. */
export const RCB_PLACE_TEXT_SCREEN_PX = 18;

/** On-screen target for pen / pencil default stroke (~1 CSS px ≈ “1p”). */
export const RCB_PLACE_STROKE_SCREEN_PX = 1;

/**
 * Default font size when placing text with the T tool.
 * Targets ~`screenPx` CSS pixels on screen so high zoom does not spawn
 * tiny document glyphs and zoom-out does not spawn invisible text.
 */
export function rcbDefaultPlaceFontSize(
  zoom: number,
  screenPx = RCB_PLACE_TEXT_SCREEN_PX
): number {
  const z = Math.max(RCB_MIN_ZOOM, Number(zoom) || 1);
  const target = Math.max(1, Number(screenPx) || RCB_PLACE_TEXT_SCREEN_PX);
  const raw = target / z;
  // Half-pixel steps (same lattice as odd center strokes); never below 1 scene px.
  return Math.max(1, Math.round(raw * 2) / 2);
}

export type RcbPlaceTextFontSizeOpts = {
  /** Stage viewport width in CSS px. */
  viewportWidth?: number;
  /** Document / artboard width in scene px. */
  docWidth?: number;
};

/**
 * Scene font size for a newly placed text node (~`screenPx` on screen).
 * Uses CSS zoom and, when the whole artboard fits in view, infers zoom from
 * viewport vs document width (guards stale camera.zoom).
 */
export function rcbPlaceTextFontSize(
  zoom: number,
  screenPx = RCB_PLACE_TEXT_SCREEN_PX,
  opts?: RcbPlaceTextFontSizeOpts
): number {
  const cam = { x: 0, y: 0, zoom: Number(zoom) || 1 } satisfies RcbCamera;
  let z = Math.max(RCB_MIN_ZOOM, rcbCameraCssZoom(cam));
  const vw = opts?.viewportWidth;
  const dw = opts?.docWidth;
  if (vw != null && vw > 40 && dw != null && dw > vw + 1) {
    const visibleSceneW = vw / z;
    if (visibleSceneW >= dw * 0.85 && visibleSceneW <= dw * 1.15) {
      z = Math.max(RCB_MIN_ZOOM, vw / dw);
    }
  }
  return rcbDefaultPlaceFontSize(z, screenPx);
}

/**
 * Scene stroke width for pen / pencil (~`screenPx` on screen).
 * Same zoom fit as text place; clamped to the pen toolbar range (1–200).
 */
export function rcbPlaceStrokeWidth(
  zoom: number,
  screenPx = RCB_PLACE_STROKE_SCREEN_PX,
  opts?: RcbPlaceTextFontSizeOpts
): number {
  return Math.max(
    1,
    Math.min(200, Math.round(rcbPlaceTextFontSize(zoom, screenPx, opts)))
  );
}
