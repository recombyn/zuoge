import { describe, expect, it } from 'vitest';
import { createShapeNode } from '@/components/rcb/scene/document/nodeFactories';

const PENCIL_OPS: Array<{ name: string; args: Record<string, unknown> }> = [
  {
    name: 'create_shape',
    args: {
      shapeType: 'pencil',
      x: 40,
      y: 40,
      width: 120,
      height: 80,
      stroke: '#333333',
      borderWidth: 2,
      path: 'M 0 40 L 40 10 L 80 50 L 120 20',
      brushStyle: 'vector-calligraphy',
      pathPressure: '0.4,0.8,0.55,0.9',
      pressureEnabled: true,
    },
  },
  {
    name: 'create_shape',
    args: {
      shapeType: 'pencil',
      x: 40,
      y: 140,
      width: 120,
      height: 80,
      stroke: '#222222',
      borderWidth: 2,
      path: 'M 0 20 L 30 60 L 70 15 L 120 45',
      brushStyle: 'vector-pencil',
      pathPressure: '0.3,0.7,0.5,0.85',
      pressureEnabled: true,
    },
  },
  {
    name: 'create_shape',
    args: {
      shapeType: 'pencil',
      x: 40,
      y: 240,
      width: 120,
      height: 80,
      stroke: '#111111',
      borderWidth: 3,
      path: 'M 10 40 L 50 10 L 90 55 L 110 25',
      brushStyle: 'vector-soft',
      pathPressure: '0.5,0.9,0.35,0.75',
      pressureEnabled: true,
    },
  },
];

describe('agent pencil ops → FE attrs', () => {
  it('maps open centerline path + brushStyle / pressure onto nodes', () => {
    const created: ReturnType<typeof createShapeNode>['node'][] = [];
    for (const op of PENCIL_OPS) {
      const a = op.args || {};
      const brushStyle = String(a.brushStyle || 'vector-ink');
      const pathPressure = a.pathPressure != null ? String(a.pathPressure) : undefined;
      const pressureEnabled =
        a.pressureEnabled == null ? undefined : Boolean(a.pressureEnabled);
      const path = String(a.path || '');
      const { node } = createShapeNode({
        x: Number(a.x) || 40,
        y: Number(a.y) || 40,
        width: Number(a.width) || 120,
        height: Number(a.height) || 80,
        shapeType: 'pencil',
        stroke: String(a.stroke || '#333'),
        borderWidth: Number(a.borderWidth) || 2,
        path,
        closed: false,
        brushStyle,
        pressureEnabled,
        pathPressure,
      });
      created.push(node);
      expect(node.attrs.shapeType).toBe('pencil');
      expect(node.attrs.closed).toBe('false');
      expect(String(node.attrs.path || '')).toBe(path);
      expect(String(node.attrs.path || '').toUpperCase()).not.toContain('Z');
      expect(node.attrs.brushStyle).toBe(brushStyle);
      expect(node.attrs.pathPressure).toBeTruthy();
      expect(node.attrs.pressureEnabled).toBe(true);
    }

    const styles = created.map((n) => n.attrs.brushStyle);
    expect(styles).toEqual(
      expect.arrayContaining(['vector-calligraphy', 'vector-pencil', 'vector-soft'])
    );
  });
});
