import { describe, expect, it } from 'vitest';
import {
  SMART_SNAP_PX,
  SMART_SNAP_MAX_SCENE,
  GUIDE_COINCIDE_EPS,
  smartSnapThreshold,
  snapBoxToGrid,
  collectMoveSnapIndicators,
} from '../alignGuides';

/** Canvas zooms from floor → extreme (includes user repro ~31%). */
const CANVAS_ZOOMS = [0.05, 0.13, 0.25, 0.31, 0.5, 0.8, 1, 2, 8, 20, 40, 80] as const;

describe('smartSnapThreshold @ all canvas zooms (guide proximity, no magnets)', () => {
  it.each([...CANVAS_ZOOMS])('is screen-constant (px/zoom) at zoom %s', (zoom) => {
    const threshold = smartSnapThreshold(zoom);
    expect(threshold).toBeCloseTo(Math.min(SMART_SNAP_PX / zoom, SMART_SNAP_MAX_SCENE), 6);
  });

  it.each([0.13, 0.25, 0.31, 0.5, 1])(
    'move and inspect show gap badges when elements are separated at zoom %s',
    (zoom) => {
      const left = { left: 0, top: 0, width: 100, height: 80 };
      const right = { left: 140, top: 10, width: 100, height: 80 };
      const guides = collectMoveSnapIndicators(right, [left], GUIDE_COINCIDE_EPS);
      const gaps = guides.filter((g) => g.kind === 'gap');
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.some((g) => g.kind === 'gap' && g.dist === 40)).toBe(true);
      expect(guides.some((g) => g.kind === 'align')).toBe(false);
      void zoom;
    }
  );

  it('at 31% zoom move paints near-align guides without claiming distant edges', () => {
    const zoom = 0.31;
    const threshold = smartSnapThreshold(zoom);
    expect(threshold).toBeCloseTo(Math.min(SMART_SNAP_PX / zoom, SMART_SNAP_MAX_SCENE), 6);
    const left = { left: 0, top: 0, width: 100, height: 80 };
    const gap = Math.max(1, Math.floor(threshold * 0.5));
    const right = {
      left: left.left + left.width + gap,
      top: 6,
      width: 100,
      height: 80,
    };

    expect(collectMoveSnapIndicators(right, [left], GUIDE_COINCIDE_EPS).some((g) => g.kind === 'align')).toBe(
      false
    );

    // Production drag paints with screen-constant threshold (still no magnets).
    const nearPaint = collectMoveSnapIndicators(right, [left], Math.max(0.51, threshold));
    expect(nearPaint.some((g) => g.kind === 'align' && g.axis === 'x')).toBe(true);
    expect(nearPaint.some((g) => g.kind === 'align' && g.axis === 'x' && g.at === 100)).toBe(true);
  });

  it('near-align probe must not clear guides (old stillAligned bug)', () => {
    const left = { left: 0, top: 0, width: 100, height: 80 };
    const right = { left: 100.3, top: 0, width: 100, height: 80 };
    const guides = collectMoveSnapIndicators(snapBoxToGrid(right, 1), [left], 8);
    expect(guides.some((g) => g.kind === 'gap' || g.kind === 'align')).toBe(true);
  });
});
