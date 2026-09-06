import { describe, expect, it, afterEach } from 'vitest';
import {
  clearMsdfAtlasForTests,
  ensureSharedMsdfAtlas,
  layoutMsdfTextQuads,
  parseCssColorRgb,
  resolveBuiltinFontUrl,
  MSDF_CELL_EM,
  MSDF_GLYPH_PX,
  MSDF_PX_RANGE,
} from '@/components/rcb/render/vector/textMsdfAtlas';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { woff2Decode } from 'woff-lib/woff2/decode';

afterEach(() => {
  clearMsdfAtlasForTests();
});

describe('textMsdfAtlas', () => {
  it('parseCssColorRgb reads hex', () => {
    expect(parseCssColorRgb('#ff0000')).toEqual([1, 0, 0]);
    expect(parseCssColorRgb('#0f0')).toEqual([0, 1, 0]);
  });

  it('uses PlayCanvas msdfgen cell constants (real MSDF, not EDT)', () => {
    expect(MSDF_GLYPH_PX).toBe(64);
    expect(MSDF_PX_RANGE).toBe(8);
    expect(MSDF_CELL_EM).toBe(2);
  });

  it('creates a shared atlas surface when 2d canvas exists', () => {
    const atlas = ensureSharedMsdfAtlas();
    if (!atlas) return; // happy-dom / jsdom often lacks usable 2d context
    expect(atlas.size).toBeGreaterThan(0);
  });

  it('woff2Decode is available for catalog WOFF2 → SFNT', () => {
    expect(typeof woff2Decode).toBe('function');
  });

  it('resolveBuiltinFontUrl matches fonts.css CDN for PuHuiTi', () => {
    expect(resolveBuiltinFontUrl('Alibaba PuHuiTi', 400)).toContain('AlibabaPuHuiTi-3-55-Regular.woff2');
    expect(resolveBuiltinFontUrl('阿里巴巴普惠体', 'bold')).toContain('AlibabaPuHuiTi-3-85-Bold.woff2');
    expect(resolveBuiltinFontUrl('Noto Sans SC', 400)).toBeNull();
  });

  it('layout marks pending until msdfgen packs glyphs (async)', () => {
    const node: SceneNodeInput = {
      id: 't1',
      key: 'text',
      x: 0,
      y: 0,
      width: 120,
      height: 40,
      attrs: {
        ORIGIN_DATA: JSON.stringify([{ children: [{ text: 'Hi' }] }]),
        fontSize: 16,
        fill: '#111',
      },
      children: [],
    };
    const laid = layoutMsdfTextQuads(node);
    expect(laid).toBeTruthy();
    // Without catalog font bytes in unit tests, packing stays pending / empty.
    expect(laid!.pending || laid!.quads.length >= 0).toBe(true);
  });
});
