import { describe, expect, it } from 'vitest';
import { meshStrokeCover } from '@/components/rcb/render/meshStrokeCover';

describe('meshStrokeCover', () => {
  it('keeps shaft solid when fwidth is small (high zoom)', () => {
    expect(meshStrokeCover(0, 0.02)).toBe(1);
    expect(meshStrokeCover(0.2, 0.02)).toBe(1);
    // Near rim softens
    expect(meshStrokeCover(0.99, 0.02)).toBeLessThan(1);
    expect(meshStrokeCover(0.99, 0.02)).toBeGreaterThan(0);
  });

  it('deposits fractional cover for thin ribbons (large fwidth) instead of zero', () => {
    // Sub-pixel: fwidth spans most of the edge attribute range.
    const mid = meshStrokeCover(0.5, 1.5);
    const rim = meshStrokeCover(0.95, 1.5);
    expect(mid).toBeGreaterThan(0.3);
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(mid);
  });

  it('never snaps thin cover to hard zero at mid-edge', () => {
    for (let d = 0; d <= 1; d += 0.1) {
      expect(meshStrokeCover(d, 2)).toBeGreaterThan(0);
    }
  });
});
