import { describe, expect, it } from 'vitest';
import {
  appendTexturedMediaQuad,
  createMediaTexBatch,
  mediaTextureFingerprint,
} from '@/components/rcb/render/mediaTextureMesh';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';

describe('mediaTextureMesh', () => {
  it('fingerprint for filled image ignores zoom bucket', () => {
    const node = {
      id: 'p1',
      key: 'image',
      width: 200,
      height: 100,
      attrs: { src: 'https://example.com/a.png' },
    } as SceneNodeInput;
    const a = mediaTextureFingerprint(node, 'p1', 200, 100, 1);
    const b = mediaTextureFingerprint(node, 'p1', 200, 100, 8);
    expect(a).toBe(b);
    expect(a.includes(':z')).toBe(false);
  });

  it('fingerprint for empty plate includes zoom bucket', () => {
    const node = {
      id: 'e1',
      key: 'image',
      width: 120,
      height: 80,
      attrs: { imageGenerator: true },
    } as SceneNodeInput;
    const a = mediaTextureFingerprint(node, 'e1', 120, 80, 1);
    const b = mediaTextureFingerprint(node, 'e1', 120, 80, 4);
    expect(a).not.toBe(b);
    expect(a.startsWith('img:e1:empty:')).toBe(true);
  });

  it('appendTexturedMediaQuad emits 6 verts with UVs', () => {
    const batch = createMediaTexBatch();
    const n = appendTexturedMediaQuad(
      40,
      20,
      10,
      5,
      [1, 1, 1, 0.8],
      [-1e8, -1e8, 1e8, 1e8],
      batch
    );
    expect(n).toBe(6);
    expect(batch.pos.length).toBe(12);
    expect(batch.uv.length).toBe(12);
    expect(batch.col.length).toBe(24);
    // Top-left world
    expect(batch.pos[0]).toBe(10);
    expect(batch.pos[1]).toBe(5);
    expect(batch.uv[0]).toBe(0);
    expect(batch.uv[1]).toBe(0);
  });
});
