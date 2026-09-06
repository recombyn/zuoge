/**
 * Content strokes are authored in **scene** units and scale with the camera.
 *
 * Hairline policy (WebGL ribbons):
 * 1. Always tessellate the full stroke ribbon at geometric scene width.
 * 2. Measure projected screen width: `sceneWidth * zoom * dpr`.
 * 3. Screen width > 1px → submit the ribbon for draw.
 * 4. Screen width ≤ 1px → skip draw submission; cached geometry stays intact.
 *
 * This avoids sub-pixel ribbon raster instability (ants / broken dashes) without
 * expanding width or inventing a solid min-width floor.
 *
 * `floorContentStrokeSceneWidth` keeps the historic name/signature for callers
 * that still want geometric scene width (default minCssPx = 0).
 */

/** @deprecated Prefer strokeRibbonPaint for WebGL ribbons. */
export const CONTENT_STROKE_MIN_CSS_PX = 0;

/**
 * Screen-pixel threshold for submitting stroke ribbons.
 * At or below this, geometry is kept but not drawn.
 */
export const STROKE_SUBMIT_MIN_SCREEN_PX = 1;

export type StrokeRibbonPaint = {
  /** Scene-space ribbon width to tessellate (always authored / geometric). */
  width: number;
  /** Projected screen width (`scene * zoom * dpr`). */
  screenWidth: number;
  /** True when the ribbon should be submitted for GPU draw this frame. */
  submit: boolean;
};

/**
 * Projected stroke width in screen pixels (includes devicePixelRatio).
 */
export function strokeScreenWidth(sceneWidth: number, zoom: number, dpr = 1): number {
  const sw = Math.max(0, Number(sceneWidth) || 0);
  if (!(sw > 0)) return 0;
  const z = Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
  return sw * z;
}

/** Submit ribbon only when projected screen width is strictly greater than 1px. */
export function shouldSubmitStrokeRibbon(screenWidthPx: number): boolean {
  return Number(screenWidthPx) > STROKE_SUBMIT_MIN_SCREEN_PX;
}

/**
 * Stroke ribbon paint decision for WebGL.
 * Geometry width is always geometric; `submit` gates draw only.
 */
export function strokeRibbonPaint(
  sceneWidth: number,
  zoom: number,
  dpr = 1
): StrokeRibbonPaint {
  const width = Math.max(0, Number(sceneWidth) || 0);
  if (!(width > 0)) return { width: 0, screenWidth: 0, submit: false };
  const screenWidth = strokeScreenWidth(width, zoom, dpr);
  return {
    width,
    screenWidth,
    submit: shouldSubmitStrokeRibbon(screenWidth),
  };
}

/**
 * @deprecated Use strokeRibbonPaint. Kept for call-site migration:
 * returns geometric `width` and `alphaScale` 1 when submit else 0.
 */
export function coverageConservingStrokePaint(
  sceneWidth: number,
  zoom: number,
  dpr = 1
): { width: number; alphaScale: number } {
  const p = strokeRibbonPaint(sceneWidth, zoom, dpr);
  return { width: p.width, alphaScale: p.submit ? 1 : 0 };
}

/** @deprecated Alias — coverage expansion removed; threshold is STROKE_SUBMIT_MIN_SCREEN_PX. */
export const STROKE_COVERAGE_CSS_PX = STROKE_SUBMIT_MIN_SCREEN_PX;

/**
 * Scene stroke width for paint. Returns geometric `sceneWidth` (no screen floor
 * / no CSS-px quantization). Optional `minCssPx` is ignored when <= 0; when > 0
 * it still lifts `sw` so `sw * zoom >= minCssPx` (chrome / tests only).
 * Returns 0 when `sceneWidth` is non-positive (no stroke).
 */
export function floorContentStrokeSceneWidth(
  sceneWidth: number,
  zoom: number,
  minCssPx = CONTENT_STROKE_MIN_CSS_PX
): number {
  const sw = Math.max(0, Number(sceneWidth) || 0);
  if (!(sw > 0)) return 0;
  const minCss = Math.max(0, Number(minCssPx) || 0);
  if (!(minCss > 0)) return sw;
  const z = Math.max(0.05, Number(zoom) || 1);
  return Math.max(sw, minCss / z);
}

/**
 * Cap path segment emission when zoomed out — dense boolean outlines otherwise
 * explode the instance batch while screen coverage is already a hairline.
 */
export function adaptivePathStrokeMaxSegs(zoom: number, cap = 96): number {
  const z = Math.max(0.05, Number(zoom) || 1);
  const hard = Math.max(8, Math.floor(Number(cap) || 96));
  if (z >= 0.75) return hard;
  if (z >= 0.4) return Math.max(24, Math.floor(hard * 0.5));
  if (z >= 0.2) return Math.max(16, Math.floor(hard * 0.33));
  return Math.max(12, Math.floor(hard * 0.2));
}
