import { describe, expect, it } from 'vitest';
import { toolbarBoxForSelection } from '../selectionLogic';

describe('toolbarBoxForSelection — line/arrow outer AABB', () => {
  it('docks to shaft endpoint AABB, not mid-shaft 1×1', () => {
    // Oriented line AABB: length 100, STROKE_HIT height 24, angle 0 → shaft left→right.
    const box = { left: 0, top: 0, width: 100, height: 24 };
    const dock = toolbarBoxForSelection(box, {
      lineChrome: true,
      node: { attrs: { angle: 0, shapeType: 'line' } },
    });
    expect(dock).toEqual({ left: 0, top: 12, width: 100, height: 1 });
  });

  it('clears the higher endpoint on a diagonal stroke', () => {
    // 45°: endpoints around center; AABB top = higher endpoint y.
    const box = { left: 0, top: 0, width: 100, height: 24 };
    const dock = toolbarBoxForSelection(box, {
      lineChrome: true,
      node: { attrs: { angle: 45, shapeType: 'line' } },
    });
    expect(dock).not.toBeNull();
    const cx = 50;
    const cy = 12;
    const hx = 50 * Math.cos((45 * Math.PI) / 180);
    const hy = 50 * Math.sin((45 * Math.PI) / 180);
    const y0 = cy - hy;
    const y1 = cy + hy;
    const top = Math.min(y0, y1);
    expect(dock!.top).toBeCloseTo(top, 5);
    expect(dock!.top).toBeLessThan(cy);
    expect(dock!.height).toBeGreaterThan(1);
    expect(dock!.left + dock!.width / 2).toBeCloseTo(cx, 5);
  });

  it('passes through non-line boxes unchanged', () => {
    const box = { left: 10, top: 20, width: 80, height: 60 };
    expect(toolbarBoxForSelection(box, { lineChrome: false })).toEqual(box);
  });

  it('does not collapse a Kit world AABB with attrs.angle (mid-box bug)', () => {
    // Diagonal line's oriented control-box corner AABB — already outer bounds.
    const world = { left: 0, top: 0, width: 700, height: 700 };
    const dock = toolbarBoxForSelection(world, {
      lineChrome: true,
      node: { attrs: { angle: 45, shapeType: 'line' }, height: 2, width: 992 },
    });
    expect(dock).toEqual(world);
  });
});
