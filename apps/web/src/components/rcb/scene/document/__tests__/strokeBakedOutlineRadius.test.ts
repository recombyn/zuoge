import { describe, expect, it } from 'vitest';
import { isOutlinedPath, supportsCornerRadius } from '../nodeCapabilities';
import { outlineNodePatch } from '../../outline/outlineToPath';

describe('轮廓化后不显示圆角控制点', () => {
  it('outlineNodePatch sets outlined flag', () => {
    const node = {
      key: 'shape' as const,
      x: 10,
      y: 20,
      width: 100,
      height: 40,
      attrs: {
        shapeType: 'line',
        'border-width': 8,
        'border-color': '#111',
      },
    };
    const patch = outlineNodePatch(node, {
      path: 'M 0 0 L 10 0 L 10 8 L 0 8 Z',
      width: 100,
      height: 40,
    });
    expect(patch.attrs?.outlined).toBe(true);
    expect(isOutlinedPath({ key: 'shape', attrs: patch.attrs })).toBe(true);
    expect(supportsCornerRadius({ key: 'shape', attrs: patch.attrs })).toBe(false);
  });

  it('boolean-style closed paths without outlined still allow R', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          closed: 'true',
          path: 'M 0 0 L 40 0 L 40 30 L 0 30 Z',
          'fill-color': '#fff',
          'stroke-enabled': 'true',
          'border-width': 2,
        },
      })
    ).toBe(true);
  });

  it('boolean result with outlined hides R like 轮廓化', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          closed: 'true',
          outlined: 'true',
          path: 'M 0 0 L 40 0 L 40 30 L 0 30 Z',
          'fill-color': '#fff',
          'stroke-enabled': 'true',
          'border-width': 2,
        },
      })
    ).toBe(false);
  });
});
