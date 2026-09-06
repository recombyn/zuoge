import { describe, expect, it } from 'vitest';
import { tessellateStroke } from '@/components/rcb/render/vector/tessellateStroke';

describe('tessellateStroke edge AA attrs', () => {
  it('emits ±1 rim edges for a straight segment ribbon', () => {
    const mesh = tessellateStroke(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
      ],
      { width: 4 }
    );
    expect(mesh).not.toBeNull();
    expect(mesh!.edges.length).toBe(mesh!.positions.length / 2);
    const abs = [...mesh!.edges].map((e) => Math.abs(e));
    expect(Math.max(...abs)).toBeCloseTo(1, 5);
    expect(abs.some((e) => e > 0.9)).toBe(true);
  });
});
