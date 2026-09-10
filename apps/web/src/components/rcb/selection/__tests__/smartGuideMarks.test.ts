import { describe, expect, it } from 'vitest';
import { collectMoveSnapIndicators } from '../alignGuides';

/**
 * Edge-align guides must mark corners AND edge midpoints.
 * Does not move the box ? guides are display-only.
 */
describe('smart guide marks (corners + edge mids, continuous line)', () => {
  it('left-edge align exposes TL / left-mid / BL on both boxes', () => {
    const moving = { left: 10, top: 8, width: 12, height: 10 };
    const target = { left: 10, top: 30, width: 8, height: 14 };
    const guides = collectMoveSnapIndicators(moving, [target], 0.51);
    const vert = guides.find((g) => g.kind === 'align' && g.axis === 'x' && g.at === 10);
    expect(vert && vert.kind === 'align').toBe(true);
    if (!vert || vert.kind !== 'align') return;

    const marks = vert.marks || [];
    expect(vert.from).toBeLessThanOrEqual(8);
    expect(vert.to).toBeGreaterThanOrEqual(44);

    const has = (x: number, y: number) =>
      marks.some((m) => Math.abs(m.x - x) < 1e-9 && Math.abs(m.y - y) < 1e-9);

    expect(has(10, 8)).toBe(true);
    expect(has(10, 8 + 5)).toBe(true);
    expect(has(10, 18)).toBe(true);
    expect(has(10, 30)).toBe(true);
    expect(has(10, 30 + 7)).toBe(true);
    expect(has(10, 44)).toBe(true);
  });

  it('top-edge align exposes TL / top-mid / TR', () => {
    const moving = { left: 10, top: 20, width: 12, height: 8 };
    const target = { left: 40, top: 20, width: 10, height: 6 };
    const guides = collectMoveSnapIndicators(moving, [target], 0.51);
    const hor = guides.find((g) => g.kind === 'align' && g.axis === 'y' && g.at === 20);
    expect(hor && hor.kind === 'align').toBe(true);
    if (!hor || hor.kind !== 'align') return;

    const marks = hor.marks || [];
    const has = (x: number, y: number) =>
      marks.some((m) => Math.abs(m.x - x) < 1e-9 && Math.abs(m.y - y) < 1e-9);

    expect(has(10, 20)).toBe(true);
    expect(has(10 + 6, 20)).toBe(true);
    expect(has(22, 20)).toBe(true);
    expect(has(40, 20)).toBe(true);
    expect(has(40 + 5, 20)).toBe(true);
    expect(has(50, 20)).toBe(true);
  });

  it('right-edge align exposes TR / right-mid / BR', () => {
    const moving = { left: 30, top: 8, width: 10, height: 12 };
    const target = { left: 20, top: 30, width: 20, height: 10 };
    const guides = collectMoveSnapIndicators(moving, [target], 0.51);
    const vert = guides.find((g) => g.kind === 'align' && g.axis === 'x' && g.at === 40);
    expect(vert && vert.kind === 'align').toBe(true);
    if (!vert || vert.kind !== 'align') return;
    const marks = vert.marks || [];
    const has = (x: number, y: number) =>
      marks.some((m) => Math.abs(m.x - x) < 1e-9 && Math.abs(m.y - y) < 1e-9);
    expect(has(40, 8)).toBe(true);
    expect(has(40, 8 + 6)).toBe(true);
    expect(has(40, 20)).toBe(true);
    expect(has(40, 30)).toBe(true);
    expect(has(40, 30 + 5)).toBe(true);
    expect(has(40, 40)).toBe(true);
  });

  it('bottom-edge align exposes BL / bottom-mid / BR', () => {
    const moving = { left: 10, top: 10, width: 12, height: 10 };
    const target = { left: 40, top: 14, width: 10, height: 6 };
    const guides = collectMoveSnapIndicators(moving, [target], 0.51);
    const hor = guides.find((g) => g.kind === 'align' && g.axis === 'y' && g.at === 20);
    expect(hor && hor.kind === 'align').toBe(true);
    if (!hor || hor.kind !== 'align') return;
    const marks = hor.marks || [];
    const has = (x: number, y: number) =>
      marks.some((m) => Math.abs(m.x - x) < 1e-9 && Math.abs(m.y - y) < 1e-9);
    expect(has(10, 20)).toBe(true);
    expect(has(10 + 6, 20)).toBe(true);
    expect(has(22, 20)).toBe(true);
    expect(has(40, 20)).toBe(true);
    expect(has(40 + 5, 20)).toBe(true);
    expect(has(50, 20)).toBe(true);
  });

  it('center-line align still marks box centers (not only corners)', () => {
    const moving = { left: 10, top: 10, width: 10, height: 10 };
    const target = { left: 40, top: 10, width: 10, height: 10 };
    const guides = collectMoveSnapIndicators(moving, [target], 0.51);
    const midY = guides.find((g) => g.kind === 'align' && g.axis === 'y' && g.at === 15);
    expect(midY && midY.kind === 'align').toBe(true);
    if (!midY || midY.kind !== 'align') return;
    expect(midY.marks?.some((m) => m.x === 15 && m.y === 15)).toBe(true);
    expect(midY.marks?.some((m) => m.x === 45 && m.y === 15)).toBe(true);
  });

  it('guide from/to is one continuous span (not multi stubs)', () => {
    const moving = { left: 5, top: 0, width: 4, height: 4 };
    const a = { left: 5, top: 20, width: 4, height: 4 };
    const b = { left: 5, top: 40, width: 4, height: 4 };
    const guides = collectMoveSnapIndicators(moving, [a, b], 0.51);
    const verts = guides.filter((g) => g.kind === 'align' && g.axis === 'x' && g.at === 5);
    expect(verts.length).toBe(1);
    if (verts[0]?.kind !== 'align') return;
    expect(verts[0].from).toBe(0);
    expect(verts[0].to).toBe(44);
  });
});
