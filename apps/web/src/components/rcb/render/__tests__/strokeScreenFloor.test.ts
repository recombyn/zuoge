import { describe, expect, it } from 'vitest';

import {
  adaptivePathStrokeMaxSegs,
  coverageConservingStrokePaint,
  floorContentStrokeSceneWidth,
  shouldSubmitStrokeRibbon,
  strokeCoverageFingerprintKey,
  strokeRibbonPaint,
  strokeScreenWidth,
  STROKE_SUBMIT_MIN_SCREEN_PX,
} from '../strokeScreenFloor';

describe('floorContentStrokeSceneWidth', () => {
  it('keeps geometric width at any zoom (no opaque hairline floor)', () => {
    expect(floorContentStrokeSceneWidth(2, 1)).toBe(2);
    expect(floorContentStrokeSceneWidth(2, 2)).toBe(2);
    expect(floorContentStrokeSceneWidth(2, 0.25)).toBe(2);
    expect(floorContentStrokeSceneWidth(1, 0.1)).toBe(1);
    expect(floorContentStrokeSceneWidth(1, 0.77)).toBe(1);
  });

  it('still honors an explicit minCssPx when callers opt in', () => {
    expect(floorContentStrokeSceneWidth(2, 0.25, 1)).toBe(4);
    expect(floorContentStrokeSceneWidth(1, 0.1, 1)).toBe(10);
  });

  it('returns 0 for missing stroke', () => {
    expect(floorContentStrokeSceneWidth(0, 0.2)).toBe(0);
    expect(floorContentStrokeSceneWidth(-1, 0.2)).toBe(0);
  });
});

describe('strokeRibbonPaint', () => {
  it('keeps geometric width when screen coverage > 1px', () => {
    expect(STROKE_SUBMIT_MIN_SCREEN_PX).toBe(0);
    expect(strokeRibbonPaint(2, 1)).toEqual({
      width: 2,
      screenWidth: 2,
      alphaScale: 1,
      submit: true,
    });
    expect(strokeRibbonPaint(2, 0.75)).toEqual({
      width: 2,
      screenWidth: 1.5,
      alphaScale: 1,
      submit: true,
    });
  });

  it('uses hairline width + coverage alpha when screen ≤ 1px (Skia-style)', () => {
    expect(strokeRibbonPaint(1, 1)).toEqual({
      width: 1,
      screenWidth: 1,
      alphaScale: 1,
      submit: true,
    });
    expect(strokeRibbonPaint(2, 0.5)).toEqual({
      width: 2,
      screenWidth: 1,
      alphaScale: 1,
      submit: true,
    });

    const p = strokeRibbonPaint(1, 0.25);
    expect(p.submit).toBe(true);
    expect(p.width).toBeCloseTo(4, 5); // 1 / 0.25
    expect(p.screenWidth).toBeCloseTo(0.25, 5);
    expect(p.alphaScale).toBeCloseTo(0.25, 5);

    const fit = strokeRibbonPaint(1, 0.5, 1);
    expect(fit.submit).toBe(true);
    expect(fit.width).toBeCloseTo(2, 5); // 1 / 0.5
    expect(fit.screenWidth).toBeCloseTo(0.5, 5);
    expect(fit.alphaScale).toBeCloseTo(0.5, 5);
  });

  it('includes dpr in screen projection and hairline math', () => {
    expect(strokeRibbonPaint(1, 1, 2)).toEqual({
      width: 1,
      screenWidth: 2,
      alphaScale: 1,
      submit: true,
    });
    // screen = 1 * 0.5 * 2 = 1 → boundary hairline ≡ geometric
    expect(strokeRibbonPaint(1, 0.5, 2)).toEqual({
      width: 1,
      screenWidth: 1,
      alphaScale: 1,
      submit: true,
    });
    // screen = 0.5 → hairline 1/(0.5*2)=1, alpha 0.5
    const thin = strokeRibbonPaint(1, 0.25, 2);
    expect(thin.screenWidth).toBeCloseTo(0.5, 5);
    expect(thin.width).toBeCloseTo(2, 5);
    expect(thin.alphaScale).toBeCloseTo(0.5, 5);
  });

  it('returns zero width / no submit for missing stroke', () => {
    expect(strokeRibbonPaint(0, 0.2)).toEqual({
      width: 0,
      screenWidth: 0,
      alphaScale: 0,
      submit: false,
    });
  });
});

describe('strokeScreenWidth + shouldSubmitStrokeRibbon', () => {
  it('projects raw coverage; any positive screen submits', () => {
    expect(strokeScreenWidth(2, 0.5)).toBe(1);
    expect(shouldSubmitStrokeRibbon(1)).toBe(true);
    expect(shouldSubmitStrokeRibbon(0.25)).toBe(true);
    expect(shouldSubmitStrokeRibbon(0)).toBe(false);
  });
});

describe('coverageConservingStrokePaint', () => {
  it('matches strokeRibbonPaint width + alphaScale', () => {
    expect(coverageConservingStrokePaint(2, 1)).toEqual({ width: 2, alphaScale: 1 });
    expect(coverageConservingStrokePaint(1, 1)).toEqual({ width: 1, alphaScale: 1 });
    const zoomed = coverageConservingStrokePaint(1, 0.25);
    expect(zoomed.width).toBeCloseTo(4, 5);
    expect(zoomed.alphaScale).toBeCloseTo(0.25, 5);
  });
});

describe('strokeCoverageFingerprintKey', () => {
  it('uses geometric key above 1px and quantized hairline below', () => {
    expect(strokeCoverageFingerprintKey(2, 1)).toBe('sw:2.000');
    expect(strokeCoverageFingerprintKey(1, 0.25)).toMatch(/^swH:/);
  });
});

describe('adaptivePathStrokeMaxSegs', () => {
  it('keeps full cap near 1× zoom', () => {
    expect(adaptivePathStrokeMaxSegs(1, 96)).toBe(96);
    expect(adaptivePathStrokeMaxSegs(0.8, 96)).toBe(96);
  });

  it('reduces segments when zoomed out', () => {
    expect(adaptivePathStrokeMaxSegs(0.5, 96)).toBeLessThan(96);
    expect(adaptivePathStrokeMaxSegs(0.15, 96)).toBeLessThanOrEqual(24);
  });
});
