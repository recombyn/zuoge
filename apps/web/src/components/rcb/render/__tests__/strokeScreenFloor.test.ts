import { describe, expect, it } from 'vitest';
import {
  adaptivePathStrokeMaxSegs,
  coverageConservingStrokePaint,
  floorContentStrokeSceneWidth,
  shouldSubmitStrokeRibbon,
  strokeRibbonPaint,
  strokeScreenWidth,
  STROKE_SUBMIT_MIN_SCREEN_PX,
} from '../strokeScreenFloor';

describe('floorContentStrokeSceneWidth', () => {
  it('keeps geometric width at any zoom (no hairline floor)', () => {
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
  it('always keeps geometric width; submit only when screen > 1px', () => {
    expect(STROKE_SUBMIT_MIN_SCREEN_PX).toBe(1);
    // 2px @ 100% → screen 2 → submit
    expect(strokeRibbonPaint(2, 1)).toEqual({
      width: 2,
      screenWidth: 2,
      submit: true,
    });
    // 1px @ 100% → screen 1 → do not submit
    expect(strokeRibbonPaint(1, 1)).toEqual({
      width: 1,
      screenWidth: 1,
      submit: false,
    });
    // 2px @ 50% → screen 1 → do not submit (geometry unchanged)
    expect(strokeRibbonPaint(2, 0.5)).toEqual({
      width: 2,
      screenWidth: 1,
      submit: false,
    });
    // Just above threshold
    const over = strokeRibbonPaint(1.01, 1);
    expect(over.width).toBe(1.01);
    expect(over.screenWidth).toBeCloseTo(1.01, 5);
    expect(over.submit).toBe(true);
  });

  it('includes dpr in screen projection', () => {
    // 1 scene px @ zoom 1 @ dpr 2 → screen 2 → submit
    expect(strokeRibbonPaint(1, 1, 2)).toEqual({
      width: 1,
      screenWidth: 2,
      submit: true,
    });
    // 1 scene px @ zoom 0.5 @ dpr 2 → screen 1 → cull
    expect(strokeRibbonPaint(1, 0.5, 2)).toEqual({
      width: 1,
      screenWidth: 1,
      submit: false,
    });
  });

  it('does not expand width when sub-pixel', () => {
    const p = strokeRibbonPaint(1, 0.25);
    expect(p.width).toBe(1);
    expect(p.screenWidth).toBeCloseTo(0.25, 5);
    expect(p.submit).toBe(false);
  });

  it('returns zero width / no submit for missing stroke', () => {
    expect(strokeRibbonPaint(0, 0.2)).toEqual({
      width: 0,
      screenWidth: 0,
      submit: false,
    });
  });
});

describe('strokeScreenWidth + shouldSubmitStrokeRibbon', () => {
  it('projects and gates at the 1px boundary', () => {
    expect(strokeScreenWidth(2, 0.5)).toBe(1);
    expect(shouldSubmitStrokeRibbon(1)).toBe(false);
    expect(shouldSubmitStrokeRibbon(1.0001)).toBe(true);
  });
});

describe('coverageConservingStrokePaint (compat)', () => {
  it('maps submit to alphaScale without expanding width', () => {
    expect(coverageConservingStrokePaint(2, 1)).toEqual({ width: 2, alphaScale: 1 });
    expect(coverageConservingStrokePaint(1, 1)).toEqual({ width: 1, alphaScale: 0 });
    expect(coverageConservingStrokePaint(1, 0.25)).toEqual({ width: 1, alphaScale: 0 });
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
