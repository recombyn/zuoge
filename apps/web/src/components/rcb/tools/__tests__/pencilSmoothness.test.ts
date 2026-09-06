import { describe, expect, it } from 'vitest';
import {
  findPencilBrush,
  getPencilBrushPaintRev,
  outlinePathFromPoints,
  downsampleStrokePointsForLive,
  PENCIL_COMMIT_MAX_PTS,
  PENCIL_LIVE_MAX_PTS,
  pencilSampleMinStep,
  pencilSimplifyEpsilon,
  resetPencilBrushOptions,
  simplifyPencilCenterline,
  updatePencilBrushOptions,
  type Pt,
} from '../pencilBrushes';

describe('pencil stroke smoothness', () => {
  it('sample min step is dense at 1px stroke', () => {
    const brush = findPencilBrush('vector-ink');
    const step = pencilSampleMinStep(1, brush);
    expect(step).toBeLessThan(0.3);
    expect(step).toBeGreaterThanOrEqual(0.06);
  });

  it('downsampleStrokePointsForLive caps input and keeps endpoints', () => {
    const dense: Pt[] = [];
    for (let i = 0; i <= 500; i += 1) dense.push({ x: i, y: i * 0.1 });
    const out = downsampleStrokePointsForLive(dense, PENCIL_LIVE_MAX_PTS);
    expect(out.length).toBeLessThanOrEqual(PENCIL_LIVE_MAX_PTS);
    expect(out.length).toBeGreaterThan(8);
    expect(out[0]).toEqual(dense[0]);
    expect(out[out.length - 1]).toEqual(dense[dense.length - 1]);
  });

  it('commit bake path caps before RDP (dense scribbles stay cheap)', () => {
    const dense: Pt[] = [];
    for (let i = 0; i <= 8000; i += 1) {
      dense.push({ x: Math.sin(i * 0.05) * 40 + i * 0.02, y: Math.cos(i * 0.07) * 40 });
    }
    const t0 = performance.now();
    const capped = downsampleStrokePointsForLive(dense, PENCIL_COMMIT_MAX_PTS);
    const simplified = simplifyPencilCenterline(capped, pencilSimplifyEpsilon(4));
    const ms = performance.now() - t0;
    expect(capped.length).toBeLessThanOrEqual(PENCIL_COMMIT_MAX_PTS);
    expect(simplified.length).toBeGreaterThanOrEqual(2);
    expect(simplified.length).toBeLessThanOrEqual(capped.length);
    // RDP-on-raw used to multi-second freeze; capped path must stay interactive.
    expect(ms).toBeLessThan(50);
  });

  it('simplifyPencilCenterline drops colinear points and keeps pressure', () => {
    const dense: Pt[] = [];
    for (let i = 0; i <= 40; i += 1) {
      dense.push({ x: i, y: i * 0.01, pressure: 0.2 + (i / 40) * 0.6 });
    }
    const out = simplifyPencilCenterline(dense, 0.5);
    expect(out.length).toBeLessThan(dense.length);
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
    expect(out[out.length - 1].x).toBe(40);
    expect(out.every((p) => typeof p.pressure === 'number')).toBe(true);
  });

  it('freehand outline stays centered on sharp polyline', () => {
    const pts: Pt[] = [
      { x: 0, y: 10 },
      { x: 40, y: 10 },
      { x: 40, y: 50 },
      { x: 90, y: 50 },
    ];
    const d = outlinePathFromPoints(pts, 8, 'vector-ink', {
      pressureEnabled: false,
      linecap: 'round',
      // Keep polyline corners sharp so containment asserts stay deterministic.
      streamline: 0,
    });
    expect(d.startsWith('M')).toBe(true);
    const nums = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    const verts: Pt[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      verts.push({ x: nums[i], y: nums[i + 1] });
    }
    expect(verts.length).toBeGreaterThan(8);

    function pointInPoly(x: number, y: number): boolean {
      let inside = false;
      for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
        const xi = verts[i].x;
        const yi = verts[i].y;
        const xj = verts[j].x;
        const yj = verts[j].y;
        const hit =
          yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
        if (hit) inside = !inside;
      }
      return inside;
    }
    expect(pointInPoly(20, 10)).toBe(true);
    expect(pointInPoly(40, 30)).toBe(true);
    expect(pointInPoly(40, 10)).toBe(true);
  });

  it('pencilSimplifyEpsilon scales with tip size', () => {
    expect(pencilSimplifyEpsilon(10)).toBeCloseTo(0.45, 5);
    expect(pencilSimplifyEpsilon(1)).toBe(0.25);
  });

  it('unknown brushStyle falls back to vector-ink', () => {
    expect(findPencilBrush('unknown-id').id).toBe('vector-ink');
    expect(findPencilBrush(undefined).id).toBe('vector-ink');
  });

  it('start/end taper from brush options change the silhouette', () => {
    const pts: Pt[] = [
      { x: 0, y: 20 },
      { x: 100, y: 20 },
    ];
    const flat = outlinePathFromPoints(pts, 12, 'vector-ink', {
      pressureEnabled: false,
      streamline: 0,
    });
    const rev0 = getPencilBrushPaintRev();
    updatePencilBrushOptions('vector-ink', {
      start: { taper: 40 },
      end: { taper: 40 },
    });
    expect(getPencilBrushPaintRev()).toBeGreaterThan(rev0);
    const tapered = outlinePathFromPoints(pts, 12, 'vector-ink', {
      pressureEnabled: false,
      streamline: 0,
    });
    resetPencilBrushOptions('vector-ink');
    expect(tapered).not.toBe(flat);
    expect(tapered.length).toBeGreaterThan(10);
  });
});
