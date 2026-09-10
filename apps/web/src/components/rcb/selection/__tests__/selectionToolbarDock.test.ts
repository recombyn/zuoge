import { describe, expect, it } from 'vitest';
import { selectionToolbarDock } from '../selectionLogic';

describe('selectionToolbarDock', () => {
  const box = { left: 10, top: 20, width: 100, height: 50 };

  it('passes chromeUnion through with angle and pad', () => {
    expect(
      selectionToolbarDock(box, { angle: 45, edgePadScene: 8 })
    ).toEqual({
      box,
      angle: 45,
      edgePadScene: 8,
    });
  });

  it('returns null box when chromeUnion is missing', () => {
    expect(selectionToolbarDock(null)).toEqual({
      box: null,
      angle: 0,
      edgePadScene: 0,
    });
  });

  it('zeros angle after lineChrome endpoint AABB remap', () => {
    const lineBox = { left: 0, top: 0, width: 100, height: 24 };
    const dock = selectionToolbarDock(lineBox, {
      angle: 45,
      lineChrome: true,
      node: { attrs: { angle: 45, shapeType: 'line' } },
    });
    expect(dock.angle).toBe(0);
    expect(dock.box).not.toBeNull();
    expect(dock.box!.height).toBeGreaterThan(1);
  });
});
