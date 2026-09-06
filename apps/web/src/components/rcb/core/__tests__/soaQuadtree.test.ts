import { describe, expect, it } from 'vitest';
import { SoaQuadtree } from '../soaQuadtree';
import { RcbSpatialIndex } from '../spatialIndex';
import {
  createSceneRenderBuffer,
  forEachVisibleInRect,
  hitTestSoaBuffer,
  upsertSoaGeom,
} from '../../render/sceneRenderBuffer';

describe('SoaQuadtree', () => {
  it('finds items by point and rect', () => {
    const tree = new SoaQuadtree({ maxItems: 4 });
    tree.upsert({ id: 'a', minX: 0, minY: 0, maxX: 50, maxY: 50 });
    tree.upsert({ id: 'b', minX: 200, minY: 200, maxX: 250, maxY: 250 });
    expect(tree.searchPoint(25, 25).map((x) => x.id)).toEqual(['a']);
    expect(tree.searchPoint(210, 210).map((x) => x.id)).toEqual(['b']);
    expect(tree.search(0, 0, 300, 300).map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(tree.search(180, 180, 190, 190)).toEqual([]);
  });

  it('restamp finds new ids without tree rebuild', () => {
    const tree = new SoaQuadtree({ maxItems: 8 });
    tree.upsert({ id: 'a', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.restamp({ id: 'b', minX: 100, minY: 100, maxX: 110, maxY: 110 });
    expect(tree.dirtySize).toBe(1);
    expect(tree.search(95, 95, 115, 115).map((x) => x.id).sort()).toEqual(['b']);
    tree.compact();
    expect(tree.dirtySize).toBe(0);
    expect(tree.searchPoint(105, 105).map((x) => x.id)).toEqual(['b']);
  });

  it('bulkUpsert restamps without compact until dirty threshold', () => {
    const tree = new SoaQuadtree({ maxItems: 8 });
    tree.upsert({ id: 'seed', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    const items = [];
    for (let i = 0; i < 40; i += 1) {
      items.push({
        id: `p${i}`,
        minX: i * 20,
        minY: 0,
        maxX: i * 20 + 10,
        maxY: 10,
      });
    }
    tree.bulkUpsert(items, 512);
    expect(tree.dirtySize).toBe(40);
    expect(tree.search(0, 0, 15, 15).map((x) => x.id).sort()).toEqual(
      expect.arrayContaining(['p0', 'seed'])
    );
    // Moved dirty id: tree still has old leaf; search must use byId AABB.
    tree.restamp({ id: 'seed', minX: 1000, minY: 1000, maxX: 1010, maxY: 1010 });
    expect(tree.search(0, 0, 15, 15).map((x) => x.id)).not.toContain('seed');
    expect(tree.search(995, 995, 1015, 1015).map((x) => x.id)).toContain('seed');
    tree.bulkUpsert(
      Array.from({ length: 512 }, (_, i) => ({
        id: `storm${i}`,
        minX: i,
        minY: 100,
        maxX: i + 1,
        maxY: 101,
      })),
      512
    );
    expect(tree.dirtySize).toBe(0);
  });

  it('upsert replaces bounds without duplicate ids', () => {
    const tree = new SoaQuadtree({ maxItems: 4 });
    tree.upsert({ id: 'a', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.upsert({ id: 'a', minX: 500, minY: 500, maxX: 510, maxY: 510 });
    expect(tree.searchPoint(5, 5)).toEqual([]);
    expect(tree.searchPoint(505, 505).map((x) => x.id)).toEqual(['a']);
    expect(tree.size).toBe(1);
  });

  it('remove drops membership', () => {
    const tree = new SoaQuadtree();
    tree.upsert({ id: 'a', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.remove('a');
    expect(tree.has('a')).toBe(false);
    expect(tree.size).toBe(0);
    expect(tree.searchPoint(5, 5)).toEqual([]);
  });

  it('expands root when inserting far outside', () => {
    const tree = new SoaQuadtree({ maxItems: 8 });
    tree.upsert({ id: 'near', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.upsert({ id: 'far', minX: 50_000, minY: 50_000, maxX: 50_040, maxY: 50_040 });
    expect(tree.searchPoint(5, 5).map((x) => x.id)).toEqual(['near']);
    expect(tree.searchPoint(50_020, 50_020).map((x) => x.id)).toEqual(['far']);
    expect(tree.size).toBe(2);
  });

  it('splits under dense local clusters without missing hits', () => {
    const tree = new SoaQuadtree({ maxItems: 4, maxDepth: 10 });
    for (let i = 0; i < 64; i += 1) {
      const x = (i % 8) * 12;
      const y = Math.floor(i / 8) * 12;
      tree.upsert({ id: `n${i}`, minX: x, minY: y, maxX: x + 8, maxY: y + 8 });
    }
    expect(tree.size).toBe(64);
    const hits = tree.search(0, 0, 20, 20).map((h) => h.id).sort();
    expect(hits).toContain('n0');
    expect(hits).toContain('n1');
    expect(hits).toContain('n8');
    expect(hits).not.toContain('n63');
  });

  it('replaceAll builds a spread grid in one rebuild', () => {
    const tree = new SoaQuadtree({ maxItems: 8 });
    const items = [];
    for (let i = 0; i < 2000; i += 1) {
      const x = (i % 50) * 40;
      const y = Math.floor(i / 50) * 40;
      items.push({ id: `g${i}`, minX: x, minY: y, maxX: x + 16, maxY: y + 16 });
    }
    const t0 = performance.now();
    tree.replaceAll(items);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(tree.size).toBe(2000);
    expect(tree.searchPoint(8, 8).map((h) => h.id)).toEqual(['g0']);
    expect(tree.searchPoint(40 * 49 + 8, 40 * 39 + 8).some((h) => h.id === 'g1999')).toBe(true);
  });

  it('dirty + liveAabb rescues moves without per-frame upsert', () => {
    const tree = new SoaQuadtree({ maxItems: 8 });
    tree.upsert({ id: 'a', minX: 0, minY: 0, maxX: 10, maxY: 10 });
    tree.markDirty('a');
    expect(tree.dirtySize).toBe(1);
    const live = (): { id: string; minX: number; minY: number; maxX: number; maxY: number } => ({
      id: 'a',
      minX: 500,
      minY: 500,
      maxX: 510,
      maxY: 510,
    });
    // Stale tree still thinks a is near origin — live filter drops false positive.
    expect(tree.search(0, 0, 20, 20, { liveAabb: live })).toEqual([]);
    // Rescue into new viewport.
    expect(tree.search(490, 490, 520, 520, { liveAabb: live }).map((h) => h.id)).toEqual(['a']);
    // Gesture end restamps stored AABB (same as bulkUpsertSoaQuadtree).
    tree.upsert(live());
    expect(tree.dirtySize).toBe(0);
    expect(tree.searchPoint(505, 505).map((h) => h.id)).toEqual(['a']);
  });
});

describe('RcbSpatialIndex (quadtree backend)', () => {
  it('keeps the public search API', () => {
    const idx = new RcbSpatialIndex(100);
    idx.upsert({ id: 'a', minX: 0, minY: 0, maxX: 50, maxY: 50 });
    idx.upsert({ id: 'b', minX: 200, minY: 200, maxX: 250, maxY: 250 });
    expect(idx.searchPoint(25, 25).map((x) => x.id)).toEqual(['a']);
    expect(idx.search(0, 0, 300, 300).map((x) => x.id).sort()).toEqual(['a', 'b']);
  });
});

describe('SceneRenderBuffer.quadtree', () => {
  it('maintains AABBs on upsertSoaGeom and serves hit / rect cull', () => {
    const buf = createSceneRenderBuffer();
    for (let i = 0; i < 64; i += 1) {
      upsertSoaGeom(buf, `r${i}`, {
        x: (i % 8) * 100,
        y: Math.floor(i / 8) * 100,
        w: 40,
        h: 40,
        color: 0xffff0000,
      });
    }
    expect(buf.quadtree.size).toBe(64);
    expect(hitTestSoaBuffer(buf, 20, 20)).toBe('r0');
    expect(hitTestSoaBuffer(buf, 9000, 9000)).toBeNull();

    const seen: string[] = [];
    forEachVisibleInRect(buf, { minX: 0, minY: 0, maxX: 50, maxY: 50 }, (_i, id) => {
      seen.push(id);
    });
    expect(seen).toEqual(['r0']);
  });
});
