import { describe, expect, it } from 'vitest';
import {
  PROCESS_GLOW_BLEED_PX,
  PROCESS_PILL_BOTTOM_PAD_PX,
  processGlowForeignObjectBounds,
} from '../processGlow';

describe('processGlowForeignObjectBounds', () => {
  it('expands foreignObject by bleed on all sides (SVG plate glow only)', () => {
    const box = processGlowForeignObjectBounds(100, 50);
    expect(box).toEqual({
      x: -PROCESS_GLOW_BLEED_PX,
      y: -PROCESS_GLOW_BLEED_PX,
      width: 100 + PROCESS_GLOW_BLEED_PX * 2,
      height: 50 + PROCESS_GLOW_BLEED_PX * 2,
    });
  });

  it('status pill docks inside plate bottom with 10px screen inset', () => {
    // Pill uses WorldScreenChromeRoot at plate bottom, anchor=bottom,
    // edgeGapPx = PROCESS_PILL_BOTTOM_PAD_PX (inside, not below the box).
    expect(PROCESS_PILL_BOTTOM_PAD_PX).toBe(10);
  });
});
