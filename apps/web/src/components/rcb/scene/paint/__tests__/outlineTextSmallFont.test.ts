import { describe, expect, it } from 'vitest';
import { outlinePathDecimals } from '../outlineTextFont';
import { outlineNodePatch, pathDBounds } from '../outlineToPath';

describe('text outline precision (small scene fontSize)', () => {
  it('uses more decimals when fontkit scale is tiny (high-zoom ~1px text)', () => {
    // fontSize 1 / unitsPerEm 1000
    expect(outlinePathDecimals(0.001)).toBeGreaterThanOrEqual(3);
    // fontSize 14 / 1000
    expect(outlinePathDecimals(0.014)).toBe(2);
    // fontSize 50 / 1000 — still ≥2dp so counters in o/d do not collapse
    expect(outlinePathDecimals(0.05)).toBe(2);
  });

  it('pathDBounds does not collapse multi-glyph absolute paths to ~1px height', () => {
    // Simulated CJK-ish rings at ~1 scene-px font (detail at 0.01 grid).
    const d = [
      'M 0.02 0.05 C 0.20 0.01 0.40 0.02 0.55 0.18 C 0.70 0.35 0.65 0.80 0.40 0.95 C 0.15 1.05 -0.05 0.70 0.02 0.05 Z',
      'M 0.70 0.08 C 0.95 0.05 1.20 0.20 1.25 0.45 C 1.30 0.75 1.05 1.00 0.75 0.95 C 0.50 0.90 0.45 0.35 0.70 0.08 Z',
      'M 1.40 0.10 L 1.90 0.10 L 1.90 0.95 L 1.40 0.95 Z',
      'M 2.10 0.12 C 2.40 0.05 2.70 0.25 2.65 0.55 C 2.60 0.85 2.30 1.00 2.05 0.90 C 1.85 0.80 1.90 0.30 2.10 0.12 Z',
    ].join(' ');
    const bb = pathDBounds(d);
    expect(bb).toBeTruthy();
    expect(bb!.width).toBeGreaterThan(2);
    expect(bb!.height).toBeGreaterThan(0.7);
    expect(bb!.height).toBeLessThan(3);

    const patch = outlineNodePatch(
      {
        key: 'text',
        x: 100,
        y: 200,
        width: 5,
        height: 1,
        attrs: {
          ORIGIN_DATA: JSON.stringify([{ children: [{ text: '测试' }] }]),
          fontSize: 1,
        },
      },
      {
        pathD: d,
        closed: true,
        fillColor: '#111',
        fillRule: 'nonzero',
        bounds: bb!,
      }
    );
    expect(patch.width).toBeGreaterThan(2);
    expect(patch.height).toBeGreaterThan(0.7);
    // Must not keep the pre-outline 5×1 chrome while ink is larger.
    expect(patch.width).toBe(bb!.width);
    expect(patch.height).toBe(bb!.height);
  });
});
