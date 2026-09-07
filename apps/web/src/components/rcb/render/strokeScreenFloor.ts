/**
 * Content strokes are authored in **scene** units and scale with the camera.
 *
 * Policy (world + artboard FO — Skia-style coverage conservation):
 * 1. When projected screen width > 1 device px: tessellate at geometric authored width.
 * 2. When projected screen width ≤ 1: paint a 1 device-px hairline and multiply
 *    stroke alpha by the true coverage (screenWidth). Matches Skia's
 *    SkDrawTreatAAStrokeAsHairline — not an opaque min-width floor.
 * 3. Always submit when authored width > 0.
 * 4. Artboard passes effectiveScale as zoom with dpr=1 so dpr is not double-counted.
 */

/** @deprecated Prefer strokeRibbonPaint for WebGL ribbons. */
export const CONTENT_STROKE_MIN_CSS_PX = 0;

/**
 * Legacy constant. Opaque hairline inflation was removed; coverage uses alphaScale.
 */
export const STROKE_SUBMIT_MIN_SCREEN_PX = 0;

export type StrokeRibbonPaint = {
  /**
   * Scene-space ribbon width to tessellate / instance.
   * Geometric when screenWidth > 1; otherwise 1 device-px hairline in scene units.
   */
  width: number;
  /** True geometric projection (`authored * zoom * dpr`). */
  screenWidth: number;
  /**
   * Multiply stroke alpha by this (1 when ≥1px; else screenWidth coverage).
   */
  alphaScale: number;
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
 * Stroke ribbon paint — Skia-style coverage conservation under sub-pixel zoom.
 */
export function strokeRibbonPaint(
  sceneWidth: number,
  zoom: number,
  dpr = 1
): StrokeRibbonPaint {
  const authored = Math.max(0, Number(sceneWidth) || 0);
  if (!(authored > 0)) {
    return { width: 0, screenWidth: 0, alphaScale: 0, submit: false };
  }
  const z = Math.max(0.05, Number(zoom) || 1) * Math.max(1, Number(dpr) || 1);
  const screenWidth = authored * z;
  // ≤1 device px → hairline width + coverage alpha (Skia AA stroke path).
  if (screenWidth <= 1) {
    return {
      width: 1 / z,
      screenWidth,
      alphaScale: screenWidth,
      submit: true,
    };
  }
  return {
    width: authored,
    screenWidth,
    alphaScale: 1,
    submit: true,
  };
}

/**
 * Compat helper: scene width to paint + alpha scale for coverage.
 */
export function coverageConservingStrokePaint(
  sceneWidth: number,
  zoom: number,
  dpr = 1
): { width: number; alphaScale: number } {
  const p = strokeRibbonPaint(sceneWidth, zoom, dpr);
  return { width: p.width, alphaScale: p.submit ? p.alphaScale : 0 };
}

/** @deprecated Alias. */
export const STROKE_COVERAGE_CSS_PX = STROKE_SUBMIT_MIN_SCREEN_PX;

/**
 * Scene stroke width for paint / export helpers.
 * Default: geometric authored width (no opaque floor).
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

/**
 * Fingerprint fragment for mesh remesh when coverage hairline width changes.
 * Quantizes hairline scene width so continuous zoom does not thrash the cache.
 */
export function strokeCoverageFingerprintKey(
  sceneWidth: number,
  zoom: number,
  dpr = 1
): string {
  const authored = Math.max(0, Number(sceneWidth) || 0);
  if (!(authored > 0)) return 'sw:0';
  const p = strokeRibbonPaint(authored, zoom, dpr);
  if (p.alphaScale >= 1 - 1e-6) return `sw:${authored.toFixed(3)}`;
  const q = Math.round(p.width * 20) / 20;
  return `swH:${q.toFixed(2)}`;
}
