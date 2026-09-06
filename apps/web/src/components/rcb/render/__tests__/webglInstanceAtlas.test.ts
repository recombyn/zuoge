import { describe, expect, it } from 'vitest';
import {
  createSoaWebglAtlas,
  stampImageToAtlas,
  evictSoaAtlasOldest,
  releaseSoaAtlasRegion,
  releaseSoaAtlasPrefix,
  pruneSoaAtlasForBuffer,
  atlasRegionToUv,
  SOA_ATLAS_CELL,
  SOA_ATLAS_INNER,
  SOA_ATLAS_SEG_THRESHOLD,
  idleMediaNeedsSharpHost,
  idleMediaScreenEdgePx,
  atlasBakePixelScale,
  atlasStampSceneScale,
  atlasCoverageBucket,
  atlasZoomBucket,
} from '../webglInstanceAtlas';
import {
  createSceneRenderBuffer,
  SOA_KIND_IMAGE,
  SOA_KIND_RECT,
} from '../sceneRenderBuffer';

function tinySource(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  return c;
}

describe('webglInstanceAtlas', () => {
  it('fills atlas cell for tiny stamps; bake scale tracks screen coverage', () => {
    expect(atlasStampSceneScale(13, 13)).toBeCloseTo(SOA_ATLAS_INNER / 13, 5);
    expect(atlasBakePixelScale(13, 13, 1)).toBeCloseTo(1, 5);
    expect(atlasBakePixelScale(13, 13, 40)).toBeCloseTo(SOA_ATLAS_INNER / 13, 5);
    expect(atlasCoverageBucket(100, 100, 1, 1)).toBe(Math.round(100 / 32));
    expect(atlasCoverageBucket(100, 100, 2, 1)).not.toBe(atlasCoverageBucket(100, 100, 1, 1));
    expect(atlasZoomBucket(2)).not.toBe(atlasZoomBucket(1));
    expect(atlasStampSceneScale(800, 600)).toBeCloseTo(SOA_ATLAS_INNER / 800, 5);
    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    const inner = atlas.cell - 4;
    const region = stampImageToAtlas(atlas, 'tiny-media', tinySource(), {
      left: 0,
      top: 0,
      width: 13,
      height: 13,
    });
    expect(region).toBeTruthy();
    expect(region!.w).toBeGreaterThanOrEqual(inner - 1);
    expect(region!.h).toBeGreaterThanOrEqual(inner - 1);
    expect(region!.w).toBeGreaterThan(20);
  });

  it('idleMediaNeedsSharpHost is backing-insufficient only (never DomHost gate)', () => {
    expect(SOA_ATLAS_INNER).toBe(SOA_ATLAS_CELL - 4);
    expect(idleMediaScreenEdgePx(80, 60, 1, 1)).toBe(80);
    expect(idleMediaNeedsSharpHost({ key: 'image', width: 80, height: 60 }, 1, 1)).toBe(false);
    expect(
      idleMediaNeedsSharpHost(
        { key: 'image', width: SOA_ATLAS_INNER + 40, height: 300 },
        1,
        1
      )
    ).toBe(true);
    expect(idleMediaNeedsSharpHost({ key: 'image', width: 80, height: 60 }, 8, 1)).toBe(true);
    // Empty generators: no longer force "sharp host" — restamp via zoomBucket.
    expect(
      idleMediaNeedsSharpHost(
        { key: 'image', width: 40, height: 40, attrs: { imageGenerator: true } },
        1,
        1
      )
    ).toBe(false);
    expect(
      idleMediaNeedsSharpHost(
        { key: 'audio', width: 200, height: 80, attrs: { audioGenerator: true } },
        1,
        1
      )
    ).toBe(false);
    expect(
      idleMediaNeedsSharpHost(
        {
          key: 'image',
          width: SOA_ATLAS_INNER + 40,
          height: SOA_ATLAS_INNER + 40,
          attrs: { src: 'https://example.com/a.png', imageGenerator: true },
        },
        1,
        1
      )
    ).toBe(true);
  });

  it('shelf-packs media stamps and returns UVs', () => {
    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    expect(SOA_ATLAS_SEG_THRESHOLD).toBeGreaterThan(0);
    const region = stampImageToAtlas(atlas, 'img:p1', tinySource(), {
      left: 0,
      top: 0,
      width: 50,
      height: 8,
    });
    expect(region).not.toBeNull();
    expect(region!.w).toBeGreaterThan(0);
    const uv = atlasRegionToUv(atlas, region!);
    expect(uv.u0).toBeGreaterThanOrEqual(0);
    expect(uv.u1).toBeGreaterThan(uv.u0);
    expect(uv.v1).toBeGreaterThan(uv.v0);

    const again = stampImageToAtlas(atlas, 'img:p1', tinySource(), {
      left: 0,
      top: 0,
      width: 50,
      height: 8,
    });
    expect(again).toBe(region);
  });

  it('LRU-evicts oldest cell when atlas is full', () => {
    const atlas = createSoaWebglAtlas(SOA_ATLAS_CELL * 2, SOA_ATLAS_CELL);
    if (!atlas) return;
    const mk = (key: string, x: number) =>
      stampImageToAtlas(atlas!, key, tinySource(), {
        left: x,
        top: 0,
        width: 20,
        height: 10,
      });
    expect(mk('a', 0)).not.toBeNull();
    expect(mk('b', 20)).not.toBeNull();
    expect(mk('c', 40)).not.toBeNull();
    expect(mk('d', 60)).not.toBeNull();
    expect(atlas.regions.size).toBe(4);
    stampImageToAtlas(atlas, 'a', tinySource(), { left: 0, top: 0, width: 20, height: 10 });
    expect(mk('e', 80)).not.toBeNull();
    expect(atlas.regions.has('e')).toBe(true);
    expect(atlas.regions.size).toBe(4);
    expect(atlas.regions.has('b') || atlas.regions.has('c') || atlas.regions.has('d')).toBe(true);
    expect(evictSoaAtlasOldest(atlas)).toBe(true);
  });

  it('stamps an image/bake tile into a cell', () => {
    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    const src = document.createElement('canvas');
    src.width = 32;
    src.height = 32;
    const sctx = src.getContext('2d');
    if (!sctx) return;
    sctx.fillStyle = '#f00';
    sctx.fillRect(0, 0, 32, 32);
    const region = stampImageToAtlas(atlas, 'bake:0,0', src, {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
    expect(region).not.toBeNull();
    expect(region!.world.width).toBe(100);
    expect(atlas.stats.misses).toBe(1);

    stampImageToAtlas(atlas, 'bake:0,0', src, {
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
    expect(atlas.stats.hits).toBe(1);

    sctx.fillStyle = '#0f0';
    sctx.fillRect(0, 0, 32, 32);
    const again = stampImageToAtlas(
      atlas,
      'bake:0,0',
      src,
      { left: 0, top: 0, width: 100, height: 100 },
      { force: true }
    );
    expect(again?.cell).toBe(region!.cell);
    expect(atlas.stats.restamps).toBe(1);
  });

  it('releaseSoaAtlasRegion frees a cell for reuse', () => {
    const atlas = createSoaWebglAtlas(SOA_ATLAS_CELL * 2, SOA_ATLAS_CELL);
    if (!atlas) return;
    stampImageToAtlas(atlas, 'img:a', tinySource(), { left: 0, top: 0, width: 20, height: 10 });
    expect(releaseSoaAtlasRegion(atlas, 'img:a')).toBe(true);
    expect(atlas.regions.has('img:a')).toBe(false);
    expect(atlas.stats.releases).toBe(1);
    expect(releaseSoaAtlasPrefix(atlas, 'img:')).toBe(0);
  });

  it('pruneSoaAtlasForBuffer drops retired shape stamps; keeps media', () => {
    const atlas = createSoaWebglAtlas(SOA_ATLAS_CELL * 2, SOA_ATLAS_CELL);
    if (!atlas) return;
    stampImageToAtlas(atlas, 'path:keep', tinySource(), {
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    });
    stampImageToAtlas(atlas, 'path:gone', tinySource(), {
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    });
    stampImageToAtlas(atlas, 'round:keep', tinySource(), {
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    });
    stampImageToAtlas(atlas, 'img:photo', tinySource(), {
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    });
    stampImageToAtlas(atlas, 'bake:0,0', tinySource(), {
      left: 0,
      top: 0,
      width: 8,
      height: 8,
    });
    const buf = createSceneRenderBuffer(4);
    buf.count = 2;
    buf.ids[0] = 'photo';
    buf.kinds[0] = SOA_KIND_IMAGE;
    buf.ids[1] = 'shape';
    buf.kinds[1] = SOA_KIND_RECT;
    expect(pruneSoaAtlasForBuffer(atlas, buf)).toBe(3);
    expect(atlas.regions.has('path:keep')).toBe(false);
    expect(atlas.regions.has('path:gone')).toBe(false);
    expect(atlas.regions.has('round:keep')).toBe(false);
    expect(atlas.regions.has('img:photo')).toBe(true);
    expect(atlas.regions.has('bake:0,0')).toBe(true);
  });

  it('force restamps dirty media cell in place', () => {
    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    const a = stampImageToAtlas(atlas, 'img:p', tinySource(), {
      left: 0,
      top: 0,
      width: 20,
      height: 10,
    });
    const b = stampImageToAtlas(
      atlas,
      'img:p',
      tinySource(),
      { left: 0, top: 0, width: 20, height: 10 },
      { force: true }
    );
    expect(a).not.toBeNull();
    expect(b?.cell).toBe(a!.cell);
    expect(atlas.stats.restamps).toBe(1);
  });
});
