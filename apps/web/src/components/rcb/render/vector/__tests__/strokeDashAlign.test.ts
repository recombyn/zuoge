import { describe, expect, it } from 'vitest';
import { buildShapeMeshes } from '@/components/rcb/render/vector/wasmGeom';
import { tessellateStroke } from '@/components/rcb/render/vector/tessellateStroke';
import { splitPolylineByDash } from '@/components/rcb/render/vector/strokeDash';
import { rectStrokeSideRuns } from '@/components/rcb/render/vector/strokeSides';

describe('stroke dash + align + caps + sides', () => {
  it('splitPolylineByDash yields multiple segments for dashed pattern', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ];
    const segs = splitPolylineByDash(pts, '8 4');
    expect(segs.length).toBeGreaterThan(1);
    expect(segs.every((s) => s.length >= 2)).toBe(true);
  });

  it('buildShapeMeshes with dasharray emits a different mesh than solid', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    const solid = buildShapeMeshes(rect, {
      closed: true,
      wantFill: false,
      strokeWidth: 2,
      dasharray: undefined,
    });
    const dashed = buildShapeMeshes(rect, {
      closed: true,
      wantFill: false,
      strokeWidth: 2,
      dasharray: '16 6',
    });
    expect(solid.stroke?.triangleCount ?? 0).toBeGreaterThan(0);
    expect(dashed.stroke?.triangleCount ?? 0).toBeGreaterThan(0);
    expect(dashed.stroke!.triangleCount).not.toBe(solid.stroke!.triangleCount);
  });

  it('inside align shifts ribbon fully inward vs center', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const center = tessellateStroke(line, { width: 10, closed: false, align: 'center' })!;
    const inside = tessellateStroke(line, { width: 10, closed: false, align: 'inside' })!;
    let cMinY = Infinity;
    let cMaxY = -Infinity;
    let iMinY = Infinity;
    let iMaxY = -Infinity;
    for (let i = 1; i < center.positions.length; i += 2) {
      cMinY = Math.min(cMinY, center.positions[i]!);
      cMaxY = Math.max(cMaxY, center.positions[i]!);
    }
    for (let i = 1; i < inside.positions.length; i += 2) {
      iMinY = Math.min(iMinY, inside.positions[i]!);
      iMaxY = Math.max(iMaxY, inside.positions[i]!);
    }
    expect(cMinY).toBeCloseTo(-5, 3);
    expect(cMaxY).toBeCloseTo(5, 3);
    expect(iMinY).toBeCloseTo(-10, 3);
    expect(iMaxY).toBeCloseTo(0, 3);
  });

  it('round linecap extends past open ends vs butt', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
    ];
    const butt = tessellateStroke(line, { width: 8, closed: false, linecap: 'butt' })!;
    const round = tessellateStroke(line, { width: 8, closed: false, linecap: 'round' })!;
    let buttMinX = Infinity;
    let roundMinX = Infinity;
    for (let i = 0; i < butt.positions.length; i += 2) {
      buttMinX = Math.min(buttMinX, butt.positions[i]!);
    }
    for (let i = 0; i < round.positions.length; i += 2) {
      roundMinX = Math.min(roundMinX, round.positions[i]!);
    }
    expect(round.triangleCount).toBeGreaterThan(butt.triangleCount);
    expect(roundMinX).toBeLessThan(buttMinX - 1);
  });

  it('rectStrokeSideRuns matches SVG partial-side rules', () => {
    expect(rectStrokeSideRuns(100, 50, { T: true, R: true, B: true, L: true })).toBeNull();
    expect(rectStrokeSideRuns(100, 50, { T: false, R: false, B: false, L: false })).toEqual([]);
    const topOnly = rectStrokeSideRuns(100, 50, { T: true, R: false, B: false, L: false });
    expect(topOnly).toHaveLength(1);
    expect(topOnly![0]).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    // Rounded rect: partial sides still stroke (inset by corner radii).
    const topRounded = rectStrokeSideRuns(
      100,
      50,
      { T: true, R: false, B: false, L: false },
      { tl: 8, tr: 8, br: 0, bl: 0 }
    );
    expect(topRounded).toHaveLength(1);
    expect(topRounded![0]![0]).toEqual({ x: 8, y: 0 });
    expect(topRounded![0]![topRounded![0]!.length - 1]).toEqual({ x: 92, y: 0 });
  });

  it('rectStrokeSideRuns includes shared corner arcs when contiguous sides share radius', () => {
    const tr = rectStrokeSideRuns(
      100,
      50,
      { T: true, R: true, B: false, L: false },
      { tl: 0, tr: 10, br: 0, bl: 0 }
    );
    expect(tr).toHaveLength(1);
    const poly = tr![0]!;
    expect(poly[0]).toEqual({ x: 0, y: 0 });
    expect(poly.length).toBeGreaterThan(4);
    // Ends on the right edge below the TR arc.
    expect(poly[poly.length - 1]).toEqual({ x: 100, y: 50 });
    // Arc densify should leave the corner of the bounding box.
    expect(poly.some((p) => p.x > 95 && p.y > 0 && p.y < 10)).toBe(true);
  });

  it('rectStrokeSideRuns merges contiguous sides so joins share corners', () => {
    const tlb = rectStrokeSideRuns(100, 50, { T: true, R: false, B: true, L: true });
    expect(tlb).toHaveLength(1);
    expect(tlb![0]).toEqual([
      { x: 100, y: 50 },
      { x: 0, y: 50 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const topBottom = rectStrokeSideRuns(100, 50, { T: true, R: false, B: true, L: false });
    expect(topBottom).toHaveLength(2);
    expect(topBottom![0]).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(topBottom![1]).toEqual([
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ]);
  });
  it('inside-align round join fans the fat side (not a zero-radius outer)', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
    ];
    const round = tessellateStroke(pts, {
      width: 8,
      closed: false,
      align: 'inside',
      linejoin: 'round',
    });
    const bevel = tessellateStroke(pts, {
      width: 8,
      closed: false,
      align: 'inside',
      linejoin: 'bevel',
    });
    expect(round).not.toBeNull();
    expect(bevel).not.toBeNull();
    // Old bug: inside hl≈0 → round fan collapsed to ≈bevel.
    expect(round!.triangleCount).toBeGreaterThan(bevel!.triangleCount);
    const pos = round!.positions;
    let minY = Infinity;
    for (let i = 1; i < pos.length; i += 2) minY = Math.min(minY, pos[i]!);
    // Fat side for this polyline is −Y (hr); round must reach ~half-width out.
    expect(minY).toBeLessThan(-3);
  });

  it('buildShapeMeshes strokeRuns paints only selected edges', () => {
    const rect = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    const full = buildShapeMeshes(rect, {
      closed: true,
      wantFill: true,
      strokeWidth: 2,
    });
    const top = buildShapeMeshes(rect, {
      closed: true,
      wantFill: true,
      strokeWidth: 2,
      strokeRuns: [
        [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      ],
    });
    const none = buildShapeMeshes(rect, {
      closed: true,
      wantFill: true,
      strokeWidth: 2,
      strokeRuns: [],
    });
    expect(full.stroke?.triangleCount ?? 0).toBeGreaterThan(0);
    expect(top.stroke?.triangleCount ?? 0).toBeGreaterThan(0);
    expect(top.stroke!.triangleCount).toBeLessThan(full.stroke!.triangleCount);
    expect(none.stroke).toBeNull();
    expect(top.fill?.triangleCount ?? 0).toBeGreaterThan(0);
  });
});
