import { describe, expect, it } from 'vitest';
import { styleJsonFromRcbNode } from '../kitBridge';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';

function styleOf(partial: Partial<SceneNodeInput> & { attrs?: Record<string, unknown> }) {
  const node = {
    key: 'shape',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    ...partial,
    attrs: { shapeType: 'rect', ...(partial.attrs || {}) },
  } as SceneNodeInput;
  return JSON.parse(styleJsonFromRcbNode(node)) as {
    fills: Array<Record<string, unknown>>;
    strokes: Array<Record<string, unknown>>;
    opacity: number;
    corner_radius: number;
  };
}

describe('styleJsonFromRcbNode', () => {
  it('maps solid fill + stroke color/width', () => {
    const s = styleOf({
      attrs: {
        'fill-color': '#ff0000',
        'border-color': '#00ff00',
        'border-width': 4,
      },
    });
    expect(s.fills[0]).toMatchObject({ r: 1, g: 0, b: 0, a: 1 });
    expect(s.strokes[0]).toMatchObject({
      width: 4,
      paint: { r: 0, g: 1, b: 0, a: 1 },
      alignment: 'Center',
    });
  });

  it('maps linear gradient fills', () => {
    const s = styleOf({
      width: 200,
      height: 100,
      attrs: {
        'fill-type': 'linear',
        'fill-gradient': {
          type: 'linear',
          x1: 0,
          y1: 50,
          x2: 100,
          y2: 50,
          colorStops: [
            { offset: 0, color: '#000000' },
            { offset: 1, color: '#ffffff' },
          ],
        },
      },
    });
    expect(s.fills[0]?.gradient_type).toBe('Linear');
    expect(s.fills[0]?.start_x).toBe(0);
    expect(s.fills[0]?.end_x).toBe(200);
    expect((s.fills[0]?.stops as unknown[])?.length).toBe(2);
  });

  it('maps radial gradient fills', () => {
    const s = styleOf({
      width: 100,
      height: 100,
      attrs: {
        'fill-type': 'radial',
        'fill-gradient': {
          type: 'radial',
          cx: 50,
          cy: 50,
          r: 50,
          colorStops: [
            { offset: 0, color: '#112233' },
            { offset: 1, color: '#ffffff' },
          ],
        },
      },
    });
    expect(s.fills[0]?.gradient_type).toBe('Radial');
    expect(s.fills[0]?.start_x).toBe(50);
    expect(s.fills[0]?.start_y).toBe(50);
  });

  it('maps stroke dash + inside alignment + opacity + corner radius', () => {
    const s = styleOf({
      attrs: {
        'fill-color': '#ffffff',
        'border-color': '#333333',
        'stroke-style': 'dashed',
        strokeAlign: 'inside',
        opacity: 0.5,
        cornerRadius: 8,
      },
    });
    expect(s.strokes[0]?.dash_array).toEqual([8, 4]);
    expect(s.strokes[0]?.alignment).toBe('Inner');
    expect(s.opacity).toBe(0.5);
    expect(s.corner_radius).toBe(8);
  });

  it('does not push Kit corner_radius for path-baked polygon fillets', () => {
    const s = styleOf({
      attrs: {
        shapeType: 'polygon',
        cornerRadius: 24,
        sides: 10,
      },
    });
    expect(s.corner_radius).toBe(0);
  });

  it('defaults white fill when solid fill color omitted', () => {
    const s = styleOf({ attrs: { 'border-color': '#000000' } });
    expect(s.fills[0]).toMatchObject({ r: 1, g: 1, b: 1, a: 1 });
  });
});
