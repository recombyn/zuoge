import { describe, expect, it } from 'vitest';
import { rcbStepZoom } from '../math';

describe('rcbStepZoom', () => {
  it('quantizes to 0.05 steps', () => {
    expect(rcbStepZoom(1.02)).toBe(1);
    expect(rcbStepZoom(1.03)).toBe(1.05);
    expect(rcbStepZoom(0.97)).toBe(0.95);
  });

  it('clamps tiny zoom to 1%', () => {
    expect(rcbStepZoom(0.005)).toBe(0.01);
    expect(rcbStepZoom(0.01)).toBe(0.01);
  });
});
