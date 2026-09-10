/**
 * Stroke width and the "last used" style — the two places a bad value could
 * become permanent.
 *
 * `min="0"` on a number input only constrains its spinner, so a typed or pasted
 * "-8" reached the model untouched. A negative width renders as no stroke at
 * all while the panel still shows a colour swatch, and because new shapes
 * inherit the last style you set, the broken value propagated to everything you
 * drew afterwards.
 */
import { describe, expect, it } from 'vitest';
import { UIEngine } from './ui';

describe('clampStrokeWidth', () => {
    it('keeps ordinary widths exactly', () => {
        expect(UIEngine.clampStrokeWidth('2')).toBe(2);
        expect(UIEngine.clampStrokeWidth('0.5')).toBe(0.5);
        expect(UIEngine.clampStrokeWidth(12.25)).toBe(12.25);
    });

    it('floors a negative width at zero rather than storing it', () => {
        expect(UIEngine.clampStrokeWidth('-8')).toBe(0);
        expect(UIEngine.clampStrokeWidth(-0.5)).toBe(0);
    });

    it('reads a blank or unparseable field as no stroke', () => {
        expect(UIEngine.clampStrokeWidth('')).toBe(0);
        expect(UIEngine.clampStrokeWidth('   ')).toBe(0);
        expect(UIEngine.clampStrokeWidth('abc')).toBe(0);
    });

    it('refuses non-finite values, which would poison the style JSON', () => {
        expect(UIEngine.clampStrokeWidth(Number.POSITIVE_INFINITY)).toBe(0);
        expect(UIEngine.clampStrokeWidth(Number.NaN)).toBe(0);
        expect(UIEngine.clampStrokeWidth('1e400')).toBe(0); // parses to Infinity
    });
});
