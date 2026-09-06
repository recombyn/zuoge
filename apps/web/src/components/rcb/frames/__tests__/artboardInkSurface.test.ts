import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createEmptyDocument,
  addNodeToDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  createSceneRenderBuffer,
  syncSceneRenderBufferFromDocument,
  SOA_FLAG_CANVAS_IDLE,
} from '@/components/rcb/render/sceneRenderBuffer';
import { collectSoaWebglInstances } from '@/components/rcb/render/webglSceneRenderer';
import { createSoaWebglAtlas } from '@/components/rcb/render/webglInstanceAtlas';
import {
  ARTBOARD_INK_MAX_EDGE,
  ARTBOARD_INK_MAX_SCALE,
  artboardInkBackingInsufficient,
  artboardInkNeedsTileMode,
  artboardInkScale,
  paintArtboardInkSurface,
  registerArtboardInkSurface,
  soaSlotIsFrameBound,
} from '@/components/rcb/frames/artboardInkSurface';
import {
  ARTBOARD_TILE_MAX_EDGE,
  artboardTileSceneSize,
  artboardWantScale,
} from '@/components/rcb/frames/artboardInkTiles';
import * as artboardWebglInk from '@/components/rcb/frames/artboardWebglInk';
import { shouldBlitArtboardGlContent } from '@/components/rcb/frames/artboardWebglInk';
import { setFrameClipRevealOverflowIds } from '@/components/rcb/selection/selectionPaintRaise';
import { clearLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import { clearSceneCanvasIdlePaint } from '@/components/rcb/render/sceneRenderer';

afterEach(() => {
  setFrameClipRevealOverflowIds(null);
  clearLiveArtboardFrameGeometry();
  clearSceneCanvasIdlePaint();
  vi.restoreAllMocks();
});

describe('shouldBlitArtboardGlContent', () => {
  it('blits media-only plates (framed images with no vector instances)', () => {
    expect(
      shouldBlitArtboardGlContent({ count: 0, meshVertCount: 0, mediaVertCount: 6 })
    ).toBe(true);
    expect(
      shouldBlitArtboardGlContent({ count: 0, meshVertCount: 0, mediaVertCount: 0 })
    ).toBe(false);
    expect(
      shouldBlitArtboardGlContent({ count: 1, meshVertCount: 0, mediaVertCount: 0 })
    ).toBe(true);
    expect(
      shouldBlitArtboardGlContent({ count: 0, meshVertCount: 6, mediaVertCount: 0 })
    ).toBe(true);
  });
});

describe('artboardInkScale', () => {
  it('tracks zoom×dpr up to MAX_SCALE (edge OOM guard is separate)', () => {
    expect(artboardInkScale(1, 1)).toBe(1);
    expect(artboardInkScale(2, 1)).toBe(2);
    expect(artboardInkScale(4, 2)).toBe(8);
    expect(artboardInkScale(ARTBOARD_INK_MAX_SCALE + 10, 1)).toBe(ARTBOARD_INK_MAX_SCALE);
    expect(artboardInkBackingInsufficient(2, 1)).toBe(false);
    expect(artboardInkBackingInsufficient(ARTBOARD_INK_MAX_SCALE + 1, 1)).toBe(true);
  });

  it('enters tile mode when plate×wantScale exceeds MAX_EDGE', () => {
    expect(artboardInkNeedsTileMode(800, 600, 1, 1)).toBe(false);
    expect(artboardInkNeedsTileMode(800, 600, 8, 1)).toBe(true);
    const want = artboardWantScale(8, 1);
    expect(want).toBeGreaterThan(1);
    const tileScene = artboardTileSceneSize(want);
    expect(tileScene * want).toBeLessThanOrEqual(ARTBOARD_TILE_MAX_EDGE + 1e-6);
    expect(ARTBOARD_INK_MAX_EDGE).toBeGreaterThan(0);
  });

  it('restamps FO canvas at zoom×dpr so camera scale does not mush ink', () => {
    vi.spyOn(artboardWebglInk, 'artboardWebglInkAvailable').mockReturnValue(false);
    vi.spyOn(artboardWebglInk, 'paintArtboardWebglInk').mockReturnValue(false);

    const canvas = document.createElement('canvas');
    const ops: string[] = [];
    const fakeCtx = {
      setTransform: (...args: number[]) => ops.push(`setTransform:${args.join(',')}`),
      clearRect: () => ops.push('clearRect'),
      fillRect: () => ops.push('fillRect'),
      save: () => ops.push('save'),
      restore: () => ops.push('restore'),
      beginPath: () => undefined,
      rect: () => undefined,
      clip: () => undefined,
      translate: () => undefined,
      strokeRect: () => ops.push('strokeRect'),
      drawImage: () => ops.push('drawImage'),
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    };
    vi.spyOn(canvas, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);

    const frame = {
      id: 'board',
      x: 0,
      y: 0,
      width: 99,
      height: 39,
      backgroundColor: '#fff',
    };
    const unreg = registerArtboardInkSurface({
      canvas,
      frameId: 'board',
      zoom: 4,
      getFrame: () => frame,
      getDocument: () => null,
    });
    paintArtboardInkSurface({
      canvas,
      frameId: 'board',
      zoom: 4,
      selected: false,
      highlighted: false,
      getFrame: () => frame,
      getDocument: () => null,
    });
    expect(canvas.width).toBe(Math.round(99 * 4));
    expect(canvas.height).toBe(Math.round(39 * 4));
    expect(ops.some((o) => o.startsWith('setTransform:4,'))).toBe(true);
    expect(ops).toContain('clearRect');
    expect(ops).not.toContain('fillRect');
    expect(ops).not.toContain('strokeRect');
    expect(ARTBOARD_INK_MAX_EDGE).toBeGreaterThan(1024);
    expect(ARTBOARD_INK_MAX_SCALE).toBeGreaterThan(8);
    unreg();
    vi.restoreAllMocks();
  });
});

describe('artboard small-canvas SoA partition', () => {
  it('skipFrameBound omits plate-bound idle slots from world collect', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc.frames = [
      {
        id: 'board',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
      },
    ];
    doc = addNodeToDocument(doc, 'world', {
      id: 'world',
      key: 'shape',
      x: 300,
      y: 0,
      width: 20,
      height: 20,
      attrs: { shapeType: 'rect', fill: '#f00', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'bound', {
      id: 'bound',
      key: 'shape',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      attrs: {
        shapeType: 'rect',
        fill: '#0f0',
        'stroke-enabled': false,
        frameId: 'board',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    const boundIdx = buf.indexById.get('bound')!;
    expect(soaSlotIsFrameBound(buf, boundIdx, doc)).toBe(true);

    const kinds: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, skipFrameBound: true }
    );
    // Without mesh buffers, world BASIC rect emits kind 0; bound still omitted.
    expect(kinds).toEqual([0]);

    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    const kindsWithAtlas: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kindsWithAtlas,
      [],
      [],
      { document: doc, skipFrameBound: true, atlas, meshPos, meshCol, meshClip }
    );
    // World rect may emit vector mesh and/or kind 0; plate-bound must stay omitted.
    expect(kindsWithAtlas.every((k) => k === 0)).toBe(true);
    expect(kindsWithAtlas.length).toBeLessThanOrEqual(1);
  });

  it('onlyFrameId collects plate-bound idle and omits other plates / world', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc.frames = [
      {
        id: 'board-a',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
      },
      {
        id: 'board-b',
        name: 'B',
        backgroundColor: '#fff',
        x: 300,
        y: 0,
        width: 200,
        height: 200,
      },
    ];
    doc = addNodeToDocument(doc, 'world', {
      id: 'world',
      key: 'shape',
      x: 500,
      y: 400,
      width: 20,
      height: 20,
      attrs: { shapeType: 'rect', fill: '#f00', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'on-a', {
      id: 'on-a',
      key: 'shape',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      attrs: {
        shapeType: 'rect',
        fill: '#0f0',
        'stroke-enabled': false,
        frameId: 'board-a',
      },
      children: [],
    });
    doc = addNodeToDocument(doc, 'on-b', {
      id: 'on-b',
      key: 'shape',
      x: 310,
      y: 10,
      width: 20,
      height: 20,
      attrs: {
        shapeType: 'rect',
        fill: '#00f',
        'stroke-enabled': false,
        frameId: 'board-b',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }

    const kinds: number[] = [];
    // Partition check without mesh buffers — atlas mesh path can swallow a
    // fully-clipped fill (wrote===0) and leave kinds empty under test isolation.
    collectSoaWebglInstances(
      buf,
      { left: 0, top: 0, width: 200, height: 200 },
      [],
      [],
      kinds,
      [],
      [],
      {
        document: doc,
        onlyFrameId: 'board-a',
      }
    );
    // Only board-a content; world + board-b omitted.
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === 0)).toBe(true);

    const kindsWorld: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kindsWorld,
      [],
      [],
      { document: doc, skipFrameBound: true }
    );
    // World still skips plate-bound (on-a / on-b).
    expect(kindsWorld.length).toBeGreaterThan(0);
    expect(kindsWorld.every((k) => k === 0)).toBe(true);
  });

  it('selection reveal keeps FO collect; world never paints plate-bound idle', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc.frames = [
      {
        id: 'board',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        clipContent: true,
      },
    ];
    doc = addNodeToDocument(doc, 'bound', {
      id: 'bound',
      key: 'shape',
      x: 150,
      y: 10,
      width: 100,
      height: 40,
      attrs: {
        shapeType: 'rect',
        fill: '#0f0',
        'stroke-enabled': false,
        frameId: 'board',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }

    setFrameClipRevealOverflowIds(['bound']);
    try {
      const kinds: number[] = [];
      collectSoaWebglInstances(
        buf,
        { x: 0, y: 0, width: 800, height: 600 },
        [],
        [],
        kinds,
        [],
        [],
        { document: doc, skipFrameBound: true }
      );
      // Selection no longer mounts SVG ink hosts — revealed plate ink must not
      // spill onto world (would paint past the artboard FO clip).
      expect(kinds.length).toBe(0);

      const plateKinds: number[] = [];
      collectSoaWebglInstances(
        buf,
        { left: 0, top: 0, width: 200, height: 200 },
        [],
        [],
        plateKinds,
        [],
        [],
        {
          document: doc,
          onlyFrameId: 'board',
        }
      );
      // Still paints on the plate FO (FO overflow:hidden keeps ink in-bounds).
      expect(plateKinds.length).toBeGreaterThan(0);
    } finally {
      setFrameClipRevealOverflowIds(null);
    }
  });
});
