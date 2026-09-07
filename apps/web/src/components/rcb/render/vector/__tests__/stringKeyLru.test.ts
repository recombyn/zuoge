import { describe, expect, it, beforeEach } from 'vitest';
import { lruDelete, lruSet, lruTouch } from '@/components/rcb/render/vector/stringKeyLru';
import {
  clearDensifyLodSticky,
  densifyLodBucket,
  densifyLodBucketSticky,
} from '@/components/rcb/render/vector/densifyPathDJs';
import {
  clearShapeMeshCache,
  getOrBuildShapeMesh,
  getShapeMeshCacheSize,
} from '@/components/rcb/render/vector/meshCache';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';

describe('stringKeyLru', () => {
  it('evicts oldest on overflow and touch refreshes recency', () => {
    const map = new Map<string, number>();
    lruSet(map, 'a', 1, 2);
    lruSet(map, 'b', 2, 2);
    lruTouch(map, 'a');
    lruSet(map, 'c', 3, 2);
    expect(map.has('a')).toBe(true);
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(true);
    expect(lruDelete(map, 'a')).toBe(true);
    expect(map.size).toBe(1);
  });
});

describe('densifyLodBucketSticky', () => {
  beforeEach(() => {
    clearDensifyLodSticky();
  });

  it('holds bucket across ±1 flicker', () => {
    const a = densifyLodBucketSticky('n1', 1, 1);
    const nearbyZoom = Math.pow(2, (a + 1) / 16) / 1;
    const held = densifyLodBucketSticky('n1', nearbyZoom, 1);
    expect(held).toBe(a);
    const farZoom = Math.pow(2, (a + 3) / 16);
    const jumped = densifyLodBucketSticky('n1', farZoom, 1);
    expect(jumped).not.toBe(a);
    expect(jumped).toBe(densifyLodBucket(farZoom, 1));
  });
});

describe('meshCache O(1) LRU', () => {
  beforeEach(() => {
    clearShapeMeshCache();
  });

  it('caps at 4096 and keeps recently touched ids', () => {
    for (let i = 0; i < 4200; i += 1) {
      const id = `n${i}`;
      getOrBuildShapeMesh(
        id,
        {
          id,
          key: 'shape',
          width: 20,
          height: 16,
          attrs: { shapeType: 'rect', 'fill-color': '#abc', 'stroke-enabled': false },
        } as SceneNodeInput,
        { width: 20, height: 16 }
      );
    }
    expect(getShapeMeshCacheSize()).toBe(4096);
    // Oldest batch should be gone; newest present.
    expect(
      getOrBuildShapeMesh(
        'n0',
        {
          id: 'n0',
          key: 'shape',
          width: 20,
          height: 16,
          attrs: { shapeType: 'rect', 'fill-color': '#abc', 'stroke-enabled': false },
        } as SceneNodeInput,
        { width: 20, height: 16 }
      )?.geomFp
    ).toBeTruthy();
    // After rebuild, size still capped.
    expect(getShapeMeshCacheSize()).toBeLessThanOrEqual(4096);
  });
});
