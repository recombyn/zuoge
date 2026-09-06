/**

 * Content strokes are authored in **scene** units and scale with the camera.

 *

 * Policy (world + artboard FO — same as timeline-open pasteboard draw):

 * 1. Always tessellate at geometric authored width (never inflate when zoomed out).

 * 2. Always submit when authored width > 0 (do not cull sub-pixel ribbons).

 * 3. Artboard passes effectiveScale as zoom with dpr=1 so dpr is not double-counted.

 */



/** @deprecated Prefer strokeRibbonPaint for WebGL ribbons. */

export const CONTENT_STROKE_MIN_CSS_PX = 0;



/**

 * Legacy constant. Hairline width inflation was removed — keep geometric width.

 */

export const STROKE_SUBMIT_MIN_SCREEN_PX = 0;



export type StrokeRibbonPaint = {

  /** Scene-space ribbon width (always geometric authored width). */

  width: number;

  /** Projected screen width (`authored * zoom * dpr`). */

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



/** True when projected coverage is positive. */

export function shouldSubmitStrokeRibbon(screenWidthPx: number): boolean {

  return Number(screenWidthPx) > 0;

}



/**

 * Stroke ribbon paint — geometric width only (matches timeline-open pasteboard).

 */

export function strokeRibbonPaint(

  sceneWidth: number,

  zoom: number,

  dpr = 1

): StrokeRibbonPaint {

  const authored = Math.max(0, Number(sceneWidth) || 0);

  if (!(authored > 0)) return { width: 0, screenWidth: 0, submit: false };

  const z = Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);

  return {

    width: authored,

    screenWidth: authored * z,

    submit: true,

  };

}



/**

 * @deprecated Use strokeRibbonPaint.

 */

export function coverageConservingStrokePaint(

  sceneWidth: number,

  zoom: number,

  dpr = 1

): { width: number; alphaScale: number } {

  const p = strokeRibbonPaint(sceneWidth, zoom, dpr);

  return { width: p.width, alphaScale: p.submit ? 1 : 0 };

}



/** @deprecated Alias. */

export const STROKE_COVERAGE_CSS_PX = STROKE_SUBMIT_MIN_SCREEN_PX;



/**

 * Scene stroke width for paint. Returns geometric `sceneWidth`.

 * Optional `minCssPx` > 0 still lifts for chrome/tests only.

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

 * Cap path segment emission when zoomed out.

 */

export function adaptivePathStrokeMaxSegs(zoom: number, cap = 96): number {

  const z = Math.max(0.05, Number(zoom) || 1);

  const hard = Math.max(8, Math.floor(Number(cap) || 96));

  if (z >= 0.75) return hard;

  if (z >= 0.4) return Math.max(24, Math.floor(hard * 0.5));

  if (z >= 0.2) return Math.max(16, Math.floor(hard * 0.33));

  return Math.max(12, Math.floor(hard * 0.2));

}


