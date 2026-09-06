import { describe, expect, it } from 'vitest';
import {
  arrowBaselinePath,
  getShapeBaseline,
  lineBaselinePath,
  PathBuilder,
} from '@/components/rcb/core/geometry';

describe('PathBuilder', () => {
  it('builds a closed rect', () => {
    const d = new PathBuilder()
      .moveTo(0, 0)
      .lineTo(10, 0)
      .lineTo(10, 5)
      .lineTo(0, 5)
      .close()
      .toD();
    expect(d).toContain('M 0 0');
    expect(d).toContain('Z');
  });

  it('builds an ellipse', () => {
    const d = PathBuilder.ellipse(100, 50).toD();
    expect(d.startsWith('M ')).toBe(true);
    expect(d).toContain('C ');
    expect(d.endsWith('Z')).toBe(true);
  });

  it('builds a donut with evenodd compound path', () => {
    const d = PathBuilder.ellipseVariant(100, 100, { innerRatio: 0.4, arcPercent: 100 }).toD();
    expect(d.split('M ').length).toBeGreaterThan(2);
    expect(d).toContain('Z');
  });

  it('builds a pie sector', () => {
    const d = PathBuilder.ellipseVariant(100, 100, { innerRatio: 0, arcPercent: 50 }).toD();
    expect(d).toContain('A ');
    expect(d).toContain('Z');
  });

  it('sweeps from fixed startDeg (default south)', () => {
    // start=90°, +50% → south to north via west.
    const d = PathBuilder.ellipseVariant(100, 100, {
      innerRatio: 0,
      arcPercent: 50,
      startDeg: 90,
    }).toD();
    expect(d).toMatch(/M 50 50/);
    // First rim point is start (south).
    expect(d).toMatch(/L 50(?:\.\d+)? 100/);
  });

  it('builds an annular sector with hole + partial arc', () => {
    const d = PathBuilder.ellipseVariant(100, 100, {
      innerRatio: 0.4,
      arcPercent: -76.7,
      startDeg: 90,
    }).toD();
    expect(d).toContain('A ');
    expect(d.match(/A /g)?.length).toBeGreaterThanOrEqual(2);
    expect(d).toContain('Z');
  });
});

describe('advanceEllipseArcAlong', () => {
  it('uses one continuous direction and never wraps a full circle to the other opening side', async () => {
    const { advanceEllipseArcAlong, ellipseArcPercentFromAlongRad } = await import(
      '@/components/rcb/scene/document/sceneShapes'
    );
    const twoPi = Math.PI * 2;
    const almostFull = twoPi - 0.08;
    const closed = advanceEllipseArcAlong(almostFull, 0.2, 1);
    expect(closed).toBeCloseTo(twoPi, 5);

    // Continuing through the fixed start ray stays closed rather than reopening on the other side.
    expect(advanceEllipseArcAlong(closed, 0.5, 1)).toBeCloseTo(twoPi, 5);
    // Reversing the drag moves back along the same opening direction.
    const reopened = advanceEllipseArcAlong(closed, -0.3, 1);
    expect(ellipseArcPercentFromAlongRad(reopened, 1)).toBeCloseTo(95.2, 1);
  });

  it('allows a zero-degree arc without retaining a minimum wedge', () => {
    const d = PathBuilder.ellipseVariant(100, 100, { innerRatio: 0.4, arcPercent: 0 }).toD();
    expect(d).toContain('A 50 50 0 0 1');
    expect(d).toContain('A 20 20 0 0 0');
  });

  it('preserves reverse arc direction without selecting a new direction mid-drag', async () => {
    const { advanceEllipseArcAlong, ellipseArcPercentFromAlongRad } = await import(
      '@/components/rcb/scene/document/sceneShapes'
    );
    const along = advanceEllipseArcAlong(Math.PI, -0.4, -1);
    expect(ellipseArcPercentFromAlongRad(along, -1)).toBeLessThan(-50);
  });
});

describe('ellipseArcPercentFromAlongRad', () => {
  it('covers a full turn without flipping sign', async () => {
    const { ellipseArcPercentFromAlongRad, ellipseArcAlongRadFromPercent } =
      await import('@/components/rcb/scene/document/sceneShapes');
    const half = Math.PI;
    expect(ellipseArcPercentFromAlongRad(half, 1)).toBeCloseTo(50, 5);
    expect(ellipseArcPercentFromAlongRad(half, -1)).toBeCloseTo(-50, 5);
    expect(ellipseArcAlongRadFromPercent(100)).toBeCloseTo(Math.PI * 2, 5);
    expect(ellipseArcPercentFromAlongRad(Math.PI * 2, -1)).toBe(-100);
    expect(ellipseArcPercentFromAlongRad(0, 1)).toBe(0);
    expect(ellipseArcAlongRadFromPercent(0)).toBe(0);
  });
});

describe('snapEllipseInnerRatio', () => {
  it('snaps a near-zero hole', async () => {
    const { snapEllipseInnerRatio } = await import(
      '@/components/rcb/scene/document/sceneShapes'
    );
    expect(snapEllipseInnerRatio(0.02)).toBe(0);
    expect(snapEllipseInnerRatio(0.1)).toBe(0);
    expect(snapEllipseInnerRatio(0.4)).toBeCloseTo(0.4);
    // Near-center in screen px also snaps (zoom=1 → sceneDist ≤ 18).
    expect(snapEllipseInnerRatio(0.2, { sceneDist: 10, zoom: 1 })).toBe(0);
    expect(snapEllipseInnerRatio(0.2, { sceneDist: 40, zoom: 1 })).toBeCloseTo(0.2);
  });
});

describe('node effects', () => {
  it('resolves inner shadow and backdrop blur only when enabled', async () => {
    const { resolveBackdropBlur, resolveInnerShadow } = await import(
      '@/components/rcb/scene/document/sceneEffects'
    );
    const node = {
      key: 'shape',
      attrs: {
        'inner-shadow-enabled': true,
        'inner-shadow-x': -2,
        'inner-shadow-y': 3,
        'inner-shadow-blur': 9,
        'backdrop-blur-enabled': true,
        'backdrop-blur-amount': 18,
        'backdrop-blur-brightness': 115,
      },
    };
    expect(resolveInnerShadow(node)).toMatchObject({ offsetX: -2, offsetY: 3, blur: 9 });
    expect(resolveBackdropBlur(node)).toEqual({ blur: 18, brightness: 115 });
    expect(resolveBackdropBlur({ key: 'shape', attrs: {} })).toBeNull();
  });
});

describe('getShapeBaseline', () => {
  it('line is a horizontal centerline', () => {
    expect(lineBaselinePath(80, 24)).toBe('M 0 12 L 80 12');
  });

  it('arrow shaft tucks under head; only V meets the tip', () => {
    const d = arrowBaselinePath(100, 24);
    expect(d).toContain('M 0 12');
    // Default ARROW_HEAD=14 → head base at 86; shaft tucks slightly past base.
    expect(d).toMatch(/L 87\.?\d* 12/);
    expect(d).not.toMatch(/M 0 12 L 100 12/);
    // V still shares the tip once.
    expect(d.match(/L 100 12/g)?.length).toBe(1);
  });

  it('circle uses ellipse baseline', () => {
    const b = getShapeBaseline({
      key: 'shape',
      width: 40,
      height: 40,
      attrs: { shapeType: 'circle' },
    });
    expect(b?.closed).toBe(true);
    expect(b?.kind).toBe('geo');
    expect(b?.d).toContain('C ');
  });

  it('lottie generator uses sharp box baseline like image/video generators', () => {
    const b = getShapeBaseline({
      key: 'lottie',
      width: 80,
      height: 80,
      attrs: { lottieGenerator: true },
    });
    expect(b?.closed).toBe(true);
    expect(b?.kind).toBe('box');
    expect(b?.d).toMatch(/^M 0 0/);
  });

  it('scales path baseline on live resize', () => {
    const b = getShapeBaseline(
      {
        key: 'shape',
        width: 100,
        height: 50,
        attrs: { shapeType: 'pen', path: 'M 0 0 L 100 50' },
      },
      { width: 200, height: 100 }
    );
    expect(b?.d).toContain('200');
    expect(b?.d).toContain('100');
  });

  it('rebuilds polygon for live size', () => {
    const small = getShapeBaseline({
      key: 'shape',
      width: 50,
      height: 50,
      attrs: { shapeType: 'polygon', sides: 5 },
    });
    const large = getShapeBaseline(
      {
        key: 'shape',
        width: 50,
        height: 50,
        attrs: { shapeType: 'polygon', sides: 5 },
      },
      { width: 200, height: 200 }
    );
    expect(small?.d).toBeTruthy();
    expect(large?.d).toBeTruthy();
    expect(small?.d).not.toBe(large?.d);
  });
});
