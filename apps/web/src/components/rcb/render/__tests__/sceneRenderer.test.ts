import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSceneCanvasIdlePaint,
  createCanvasSceneRenderer,
  createSceneRenderer,
  createSvgSceneRenderer,
  dirtyTouchesNode,
  drawSceneGrid,
  getSceneCanvasIdlePaint,
  hitTestWithSpatialIndex,
  isFullDirty,
  isNoopSoaDirtyRegion,
  listSceneCanvasIdlePaintIds,
  canvasIdleIsStrokeOnly,
  canIdlePaintOnCanvas,
  createCanvasAngularGradient,
  clearFillImageCache,
  setFillImageCacheEntry,
  bumpSceneCanvasIdlePaint,
  subscribeSceneCanvasIdlePaint,
  paintBasicShapeFill,
  paintCanvasShapeInk,
  paintCanvasPathInk,
  paintCanvasTextInk,
  clearIdleTextOutlineCache,
  primeIdleTextOutlineCache,
  paintCanvasIdleNode,
  nodeNeedsCanvasEffectBake,
  canvasCompositeFromBlendMode,
  paintCanvasMediaInk,
  bakeShapeInkForAtlas,
  isSoaAtlasBakeEligible,
  bakeMediaInkForAtlas,
  paintGeneratorEmptyInk,
  clipCanvasIdleToOwningFrame,
  paintStrokeCanvasIdle,
  paintTextProxyLines,
  resolveCanvasFillStyle,
  resolveSoaCanvasDirtyRegion,
  sceneBoxToScreenRect,
  sceneGridLineWidth,
  setSceneCanvasIdlePaint,
  strokeCanvasIdleCenterline,
  type DirtyRegion,
} from '../sceneRenderer';
import { SceneSpatialRuntime } from '@/components/rcb/core/spatialIndex';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { PIXEL_GRID_MIN_ZOOM } from '@/components/rcb/selection/alignGuides';
import {
  setFrameClipRevealOverflowIds,
  setSelectionPaintRaiseIds,
} from '@/components/rcb/selection/selectionPaintRaise';
import {
  createSceneRenderBuffer,
  getSharedSceneRenderBuffer,
  markAllSoaDirty,
  paintSoaIdleSlot,
  resetSharedSceneRenderBuffer,
  setSoaCanvasShapesEnabledForTests,
  syncSceneRenderBufferFromDocument,
  applySoaHostInkFlags,
  SOA_FLAG_DIRTY,
} from '../sceneRenderBuffer';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';
import { setLiveCornerRadiusPreview } from '@/components/rcb/scene/document/sceneRadii';
import { setLiveShapeParamsPreview } from '@/components/rcb/scene/document/sceneShapes';

function emptyDoc(): SceneDocument {
  return {
    deltaSetLike: {
      ROOT: {
        id: 'ROOT',
        key: 'group',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        attrs: {},
        children: [],
      },
    },
  };
}

function rectDoc(): SceneDocument {
  return {
    deltaSetLike: {
      ROOT: {
        id: 'ROOT',
        key: 'group',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        attrs: {},
        children: ['n1'],
      },
      n1: {
        id: 'n1',
        key: 'shape',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        children: [],
      },
    },
  };
}

function mockCtx(ops: string[]) {
  return {
    setTransform: (...args: number[]) => {
      ops.push(`setTransform:${args.join(',')}`);
    },
    clearRect: (...args: number[]) => {
      ops.push(`clearRect:${args.join(',')}`);
    },
    save: () => ops.push('save'),
    restore: () => ops.push('restore'),
    translate: () => ops.push('translate'),
    scale: (...args: number[]) => ops.push(`scale:${args.join(',')}`),
    rotate: (...args: number[]) => ops.push(`rotate:${args.join(',')}`),
    beginPath: () => ops.push('beginPath'),
    moveTo: () => ops.push('moveTo'),
    lineTo: () => ops.push('lineTo'),
    rect: (...args: number[]) => {
      ops.push(`rect:${args.map((n) => Math.round(n)).join(',')}`);
    },
    clip: () => ops.push('clip'),
    arcTo: () => ops.push('arcTo'),
    arc: () => ops.push('arc'),
    closePath: () => ops.push('closePath'),
    ellipse: () => ops.push('ellipse'),
    stroke: () => ops.push('stroke'),
    fill: (pathOrRule?: unknown, rule?: CanvasFillRule) => {
      if (pathOrRule === 'evenodd' || pathOrRule === 'nonzero') {
        ops.push(`fill:${pathOrRule}`);
      } else if (rule) {
        ops.push(`fill:${rule}`);
      } else {
        ops.push('fill');
      }
    },
    fillRect: () => ops.push('fillRect'),
    strokeRect: () => ops.push('strokeRect'),
    createLinearGradient: () => {
      ops.push('createLinearGradient');
      return {
        addColorStop: () => ops.push('addColorStop'),
      };
    },
    createRadialGradient: () => {
      ops.push('createRadialGradient');
      return {
        addColorStop: () => ops.push('addColorStop'),
      };
    },
    createConicGradient: (start: number, x: number, y: number) => {
      ops.push('createConicGradient');
      ops.push(`conic:${start.toFixed(6)},${x.toFixed(2)},${y.toFixed(2)}`);
      return {
        addColorStop: () => ops.push('addColorStop'),
      };
    },
    createPattern: () => {
      ops.push('createPattern');
      return {} as CanvasPattern;
    },
    drawImage: () => ops.push('drawImage'),
    getImageData: () => ({
      data: new Uint8ClampedArray(4),
      width: 1,
      height: 1,
      colorSpace: 'srgb' as PredefinedColorSpace,
    }),
    putImageData: () => ops.push('putImageData'),
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'butt' as CanvasLineCap,
    globalAlpha: 1,
    filter: 'none',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };
}

/** setupTests stubs getContext→null; offscreen bake / pattern tiles need a 2d surface. */
function withStubbedCanvas2d<T>(
  ctx: ReturnType<typeof mockCtx>,
  run: () => T
): T {
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const offSpy =
    typeof OffscreenCanvas !== 'undefined'
      ? vi
          .spyOn(OffscreenCanvas.prototype, 'getContext')
          .mockReturnValue(ctx as unknown as RenderingContext)
      : null;
  try {
    return run();
  } finally {
    spy.mockRestore();
    offSpy?.mockRestore();
  }
}

describe('DirtyRegion helpers', () => {
  it('isFullDirty / dirtyTouchesNode', () => {
    const full: DirtyRegion = { kind: 'full' };
    const nodes: DirtyRegion = { kind: 'nodes', ids: ['a', 'b'] };
    expect(isFullDirty(full)).toBe(true);
    expect(isFullDirty(nodes)).toBe(false);
    expect(dirtyTouchesNode(full, 'z')).toBe(true);
    expect(dirtyTouchesNode(nodes, 'a')).toBe(true);
    expect(dirtyTouchesNode(nodes, 'z')).toBe(false);
  });

  it('isNoopSoaDirtyRegion is empty nodes only', () => {
    expect(isNoopSoaDirtyRegion({ kind: 'nodes', ids: [] })).toBe(true);
    expect(isNoopSoaDirtyRegion({ kind: 'nodes', ids: ['a'] })).toBe(false);
    expect(isNoopSoaDirtyRegion({ kind: 'full' })).toBe(false);
    expect(
      isNoopSoaDirtyRegion({
        kind: 'aabb',
        box: { x: 0, y: 0, width: 1, height: 1 },
      })
    ).toBe(false);
  });

  it('resolveSoaCanvasDirtyRegion is noop when no dirty AABB (not full wipe)', () => {
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(
      buf,
      (() => {
        let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
        doc = addNodeToDocument(doc, 'a', {
          id: 'a',
          key: 'shape',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          attrs: { shapeType: 'rect', fill: '#fff' },
          children: [],
        });
        return doc;
      })()
    );
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i]! & ~SOA_FLAG_DIRTY) >>> 0;
    }
    const region = resolveSoaCanvasDirtyRegion({ full: false, buf });
    expect(region).toEqual({ kind: 'nodes', ids: [] });
    expect(isNoopSoaDirtyRegion(region)).toBe(true);
  });

  it('sceneBoxToScreenRect maps scene AABB through camera', () => {
    const scr = sceneBoxToScreenRect(
      { x: 10, y: 20, width: 40, height: 30 },
      { x: 100, y: 50, zoom: 2 },
      1,
      0
    );
    expect(scr.x).toBe(10 * 2 + 100);
    expect(scr.y).toBe(20 * 2 + 50);
    expect(scr.width).toBe(80);
    expect(scr.height).toBe(60);
  });

  it('resolveSoaCanvasDirtyRegion stays AABB during TransformPreview (not full)', async () => {
    const { setNodeTransformPreviews, clearNodeTransformPreviews } = await import(
      '@/components/rcb/core/transformPreview'
    );
    const {
      clearSoaGestureDirtyAccum,
      accumulateSoaGestureDirtyFromBuffer,
    } = await import('../soaBakeLayer');
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(
      buf,
      (() => {
        let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
        doc = addNodeToDocument(doc, 'a', {
          id: 'a',
          key: 'shape',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          attrs: { shapeType: 'rect', fill: '#fff' },
          children: [],
        });
        return doc;
      })()
    );
    setNodeTransformPreviews([{ nodeId: 'a', left: 80, top: 90, width: 30, height: 40 }]);
    markAllSoaDirty(buf);
    accumulateSoaGestureDirtyFromBuffer(buf);
    const region = resolveSoaCanvasDirtyRegion({ full: false, buf });
    expect(region.kind).toBe('aabb');
    if (region.kind === 'aabb') {
      expect(region.box.width).toBeGreaterThanOrEqual(30);
      expect(region.box.height).toBeGreaterThanOrEqual(40);
    }
    clearNodeTransformPreviews();
    clearSoaGestureDirtyAccum();
  });

  it('resolveSoaCanvasDirtyRegion uses dirty AABB when not full', () => {
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(
      buf,
      (() => {
        let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
        doc = addNodeToDocument(doc, 'a', {
          id: 'a',
          key: 'shape',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          attrs: { shapeType: 'rect', fill: '#fff' },
          children: [],
        });
        return doc;
      })()
    );
    expect(resolveSoaCanvasDirtyRegion({ full: true, buf })).toEqual({ kind: 'full' });
    const region = resolveSoaCanvasDirtyRegion({ full: false, buf });
    expect(region.kind).toBe('aabb');
    if (region.kind === 'aabb') {
      expect(region.box.x).toBeLessThanOrEqual(10);
      expect(region.box.y).toBeLessThanOrEqual(20);
      expect(region.box.width).toBeGreaterThanOrEqual(30);
      expect(region.box.height).toBeGreaterThanOrEqual(40);
    }
  });

  it('resolveSoaCanvasDirtyRegion stays AABB while selection reveals (full only on reveal change)', () => {
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(
      buf,
      (() => {
        let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
        doc = addNodeToDocument(doc, 'a', {
          id: 'a',
          key: 'shape',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          attrs: { shapeType: 'rect', fill: '#fff' },
          children: [],
        });
        return doc;
      })()
    );
    markAllSoaDirty(buf);
    setFrameClipRevealOverflowIds(['a']);
    // Steady-state selection must not force full — that froze multi-dupe paste.
    const region = resolveSoaCanvasDirtyRegion({ full: false, buf });
    expect(region.kind).toBe('aabb');
    setFrameClipRevealOverflowIds(null);
  });

  it('resolveSoaCanvasDirtyRegion is full during live corner-radius preview', () => {
    const buf = createSceneRenderBuffer();
    setLiveCornerRadiusPreview({
      nodeId: 'a',
      display: 50,
      radii: { tl: 50, tr: 50, br: 50, bl: 50 },
    });
    expect(resolveSoaCanvasDirtyRegion({ full: false, buf })).toEqual({ kind: 'full' });
    setLiveCornerRadiusPreview(null);
  });

  it('paintSoaIdleSlot applies live polygon corner radius (not baked samples)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'poly1', {
      id: 'poly1',
      key: 'shape',
      x: 10,
      y: 10,
      width: 120,
      height: 120,
      attrs: {
        shapeType: 'polygon',
        sides: 5,
        radius: 0,
        'fill-color': '#ffffff',
        'border-width': 0,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const si = buf.indexById.get('poly1');
    expect(si).toBeTypeOf('number');
    const sharpOps: string[] = [];
    paintSoaIdleSlot(
      mockCtx(sharpOps) as unknown as CanvasRenderingContext2D,
      buf,
      si!,
      { left: 0, top: 0, right: 400, bottom: 400 },
      doc
    );
    const sharpArcTo = sharpOps.filter((o) => o === 'arcTo').length;

    setLiveCornerRadiusPreview({
      nodeId: 'poly1',
      display: 30,
      radii: { tl: 30, tr: 30, br: 30, bl: 30 },
    });
    const liveOps: string[] = [];
    paintSoaIdleSlot(
      mockCtx(liveOps) as unknown as CanvasRenderingContext2D,
      buf,
      si!,
      { left: 0, top: 0, right: 400, bottom: 400 },
      doc
    );
    setLiveCornerRadiusPreview(null);

    // Rounded polygon baseline uses arc segments (Path2D) or arcTo samples.
    const liveHasCurves =
      liveOps.some((o) => o.startsWith('fill')) &&
      (liveOps.filter((o) => o === 'arcTo').length > sharpArcTo ||
        liveOps.includes('fill') ||
        liveOps.some((o) => o.startsWith('fill:')));
    expect(liveHasCurves).toBe(true);
    // Live path must differ from sharp baked samples (more geometry ops or Path2D fill).
    expect(liveOps.length).toBeGreaterThan(0);
    expect(JSON.stringify(liveOps)).not.toEqual(JSON.stringify(sharpOps));
  });

  it('paintSoaIdleSlot applies live ellipse inner ratio (donut hole)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'circ1', {
      id: 'circ1',
      key: 'shape',
      x: 20,
      y: 20,
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'circle',
        'fill-color': '#ffffff',
        'border-width': 0,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const si = buf.indexById.get('circ1');
    expect(si).toBeTypeOf('number');

    setLiveShapeParamsPreview({ nodeId: 'circ1', ellipseInnerRatio: 0.41 });
    const ops: string[] = [];
    paintSoaIdleSlot(
      mockCtx(ops) as unknown as CanvasRenderingContext2D,
      buf,
      si!,
      { left: 0, top: 0, right: 400, bottom: 400 },
      doc
    );
    setLiveShapeParamsPreview(null);

    expect(ops).toContain('fill:evenodd');
  });

  it('resolveSoaCanvasDirtyRegion is full while live artboard plate is moving', async () => {
    const { previewArtboardFrameGeometry, clearLiveArtboardFrameGeometry } = await import(
      '@/components/rcb/frames/HtmlArtboardFrame'
    );
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(
      buf,
      (() => {
        let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
        doc = addNodeToDocument(doc, 'a', {
          id: 'a',
          key: 'shape',
          x: 10,
          y: 20,
          width: 30,
          height: 40,
          attrs: { shapeType: 'rect', fill: '#fff' },
          children: [],
        });
        return doc;
      })()
    );
    previewArtboardFrameGeometry({ id: 'f1', x: 40, y: 50, width: 200, height: 160 });
    expect(resolveSoaCanvasDirtyRegion({ full: false, buf })).toEqual({ kind: 'full' });
    clearLiveArtboardFrameGeometry();
    const region = resolveSoaCanvasDirtyRegion({ full: false, buf });
    expect(region.kind).toBe('aabb');
  });
});

describe('createSvgSceneRenderer', () => {
  it('hitTest uses spatial index + scene hit bridge', () => {
    const doc = rectDoc();
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['n1'],
      reloadToken: 1,
      aabbPad: 0,
    });
    const renderer = createSvgSceneRenderer({
      getDocument: () => doc,
      getSpatial: () => spatial,
      getZoom: () => 1,
      listNodeIds: () => ['n1'],
      getNodeBox: (id) => {
        const n = doc.deltaSetLike?.[id];
        if (!n) return null;
        return {
          left: Number(n.x) || 0,
          top: Number(n.y) || 0,
          width: Number(n.width) || 1,
          height: Number(n.height) || 1,
        };
      },
    });
    expect(renderer.backend).toBe('svg');
    expect(renderer.hitTest({ x: 30, y: 40 })).toBe('n1');
    expect(renderer.hitTest({ x: -100, y: -100 })).toBeNull();
    renderer.dispose();
    // Hit stays valid after dispose — bridge may briefly retain this instance.
    expect(renderer.hitTest({ x: 30, y: 40 })).toBe('n1');
  });

  it('createSceneRenderer defaults to svg', () => {
    const r = createSceneRenderer('svg', {
      getDocument: () => emptyDoc(),
      getSpatial: () => new SceneSpatialRuntime(64),
      getZoom: () => 1,
      listNodeIds: () => [],
      getNodeBox: () => null,
    });
    expect(r.backend).toBe('svg');
    r.dispose();
  });
});

describe('scene grid (Canvas underlay)', () => {
  it('sceneGridLineWidth stays ~1 screen px', () => {
    expect(sceneGridLineWidth(1, 8)).toBeCloseTo(1 / 8, 6);
    expect(sceneGridLineWidth(1, 20)).toBeCloseTo(1 / 20, 6);
    expect(sceneGridLineWidth(8, 1)).toBeCloseTo(Math.min(8 * 0.35, 1), 6);
  });

  it('drawSceneGrid strokes lattice', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    drawSceneGrid(ctx as unknown as CanvasRenderingContext2D, { x: 0, y: 0, width: 16, height: 16 }, 8, 8);
    expect(ops).toContain('beginPath');
    expect(ops).toContain('stroke');
  });

  it('drawSceneGrid keeps axes on integer grid (no device-axis snap)', () => {
    const moves: Array<[number, number]> = [];
    const ctx = {
      beginPath() {},
      moveTo(x: number, y: number) {
        moves.push([x, y]);
      },
      lineTo() {},
      stroke() {},
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
    };
    drawSceneGrid(
      ctx as unknown as CanvasRenderingContext2D,
      { x: 0.2, y: 0.2, width: 10, height: 10 },
      1,
      100
    );
    // First vertical line starts at floor(0.2)=0 — not shifted by stroke snap.
    expect(moves.some(([x, y]) => x === 0 && y === 0)).toBe(true);
    expect(moves.every(([x]) => Math.abs(x - Math.round(x)) < 1e-9)).toBe(true);
  });

  it('paintBasicShapeFill uses ellipse for circle', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintBasicShapeFill(ctx as unknown as CanvasRenderingContext2D, {
      left: 0,
      top: 0,
      width: 40,
      height: 40,
      fill: '#f00',
      shapeType: 'circle',
    });
    expect(ops).toContain('ellipse');
    expect(ops).toContain('fill');
  });

  it('createCanvasSceneRenderer paints grid only above PIXEL_GRID_MIN_ZOOM', () => {
    const canvas = document.createElement('canvas');
    const opsLow: string[] = [];
    vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx(opsLow) as unknown as CanvasRenderingContext2D);

    const spatial = new SceneSpatialRuntime(64);
    const renderer = createCanvasSceneRenderer({
      canvas,
      getDocument: () => emptyDoc(),
      getSpatial: () => spatial,
      getZoom: () => 1,
      listNodeIds: () => [],
      getNodeBox: () => null,
      paintGrid: true,
      drawNodeProxies: false,
      gridSize: 1,
    });

    renderer.render({
      document: emptyDoc(),
      camera: { x: 0, y: 0, zoom: 1 },
      dirty: { kind: 'full' },
      stage: { width: 200, height: 150 },
      dpr: 1,
    });
    expect(opsLow).toContain('clearRect:0,0,200,150');
    expect(opsLow).not.toContain('stroke');

    const opsHi: string[] = [];
    vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx(opsHi) as unknown as CanvasRenderingContext2D);
    renderer.render({
      document: emptyDoc(),
      camera: { x: 0, y: 0, zoom: PIXEL_GRID_MIN_ZOOM },
      dirty: { kind: 'full' },
      stage: { width: 200, height: 150 },
      dpr: 1,
    });
    expect(opsHi).toContain('stroke');
    renderer.dispose();
  });

  it('createCanvasSceneRenderer clears only dirty AABB in screen space', () => {
    setSoaCanvasShapesEnabledForTests(true);
    const canvas = document.createElement('canvas');
    const ops: string[] = [];
    vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx(ops) as unknown as CanvasRenderingContext2D);
    const spatial = new SceneSpatialRuntime(64);
    const renderer = createCanvasSceneRenderer({
      canvas,
      getDocument: () => emptyDoc(),
      getSpatial: () => spatial,
      getZoom: () => 1,
      listNodeIds: () => [],
      getNodeBox: () => null,
      paintGrid: false,
      drawCanvasIdle: true,
    });
    renderer.render({
      document: emptyDoc(),
      camera: { x: 0, y: 0, zoom: 1 },
      dirty: { kind: 'aabb', box: { x: 10, y: 20, width: 40, height: 30 } },
      stage: { width: 200, height: 150 },
      dpr: 1,
    });
    // padScene=0: clearRect matches aabbDirty exactly (no ring past clip).
    expect(ops.some((o) => o.startsWith('clearRect:') && !o.endsWith('0,0,200,150'))).toBe(
      true
    );
    expect(ops).toContain('clip');
    expect(ops).not.toContain('clearRect:0,0,200,150');
    renderer.dispose();
    setSoaCanvasShapesEnabledForTests(null);
  });
});

describe('Canvas idle path / text / shape paint', () => {
  it('bakeShapeInkForAtlas returns null for shape ink (vector dual-backend)', () => {
    const mk = (shapeType: string, extra: Record<string, unknown> = {}) =>
      ({
        id: shapeType,
        key: 'shape',
        width: 80,
        height: 80,
        attrs: {
          shapeType,
          'fill-color': '#ffffff',
          'border-color': '#000000',
          'border-width': 2,
          'stroke-enabled': true,
          sides: 5,
          points: 5,
          ...extra,
        },
      }) as SceneNodeInput;
    for (const node of [mk('rect'), mk('ellipse'), mk('polygon'), mk('star')]) {
      expect(bakeShapeInkForAtlas(node, 80, 80, 1), String(node.attrs!.shapeType)).toBeNull();
    }
    const sharp = mk('rect', { 'stroke-enabled': false, cornerRadius: 12 });
    expect(bakeShapeInkForAtlas(sharp, 80, 80, 1)).toBeNull();
  });

  it('idle text uses outline mesh path (bakeTextInkForAtlas removed)', () => {
    expect(typeof bakeShapeInkForAtlas).toBe('function');
    expect(bakeShapeInkForAtlas(
      { id: 't1', key: 'text', width: 120, height: 40, attrs: { text: 'Hello' } } as SceneNodeInput,
      120,
      40,
      1
    )).toBeNull();
  });

  it('paintSoaIdleSlot draws text glyphs', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'txt1', {
      id: 'txt1',
      key: 'text',
      x: 10,
      y: 10,
      width: 120,
      height: 40,
      attrs: { text: '阿斯顿', fontSize: 16, fill: '#111' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const si = buf.indexById.get('txt1');
    expect(si).toBeTypeOf('number');
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    (ctx as { fillText?: (...a: unknown[]) => void }).fillText = () => ops.push('fillText');
    paintSoaIdleSlot(
      ctx as unknown as CanvasRenderingContext2D,
      buf,
      si!,
      { left: 0, top: 0, right: 400, bottom: 400 },
      doc
    );
    expect(ops).toContain('fillText');
  });

  it('strokeCanvasIdleCenterline strokes subsampled path', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    expect(strokeCanvasIdleCenterline(ctx as unknown as CanvasRenderingContext2D, 'M0 0 L10 0 L20 10')).toBe(
      true
    );
    expect(ops).toContain('beginPath');
    expect(ops).toContain('stroke');
    expect(strokeCanvasIdleCenterline(ctx as unknown as CanvasRenderingContext2D, '')).toBe(false);
  });

  it('paintStrokeCanvasIdle falls back to midline when path empty', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintStrokeCanvasIdle(ctx as unknown as CanvasRenderingContext2D, {
      pathD: '',
      width: 40,
      height: 20,
      stroke: '#000',
      lineWidth: 2,
    });
    expect(ops).toContain('stroke');
  });

  it('paintTextProxyLines draws greeking bars', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintTextProxyLines(ctx as unknown as CanvasRenderingContext2D, {
      node: { key: 'text', attrs: { fontSize: 14, lineHeight: 1.4 } } as SceneNodeInput,
      width: 100,
      height: 42,
      fill: '#333',
      opacity: 1,
    });
    expect(ops.filter((o) => o === 'fillRect').length).toBeGreaterThanOrEqual(1);
  });

  it('paintCanvasIdleNode routes stroke-only pencil without fillRect slab', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasIdleNode(ctx as unknown as CanvasRenderingContext2D, {
      left: 10,
      top: 20,
      width: 80,
      height: 40,
      zoom: 0.2,
      node: {
        key: 'shape',
        attrs: { shapeType: 'pencil', path: 'M0 20 L80 20', 'border-color': '#111' },
      } as SceneNodeInput,
    });
    expect(ops).toContain('stroke');
    expect(ops).not.toContain('fillRect');
  });

  it('paintCanvasIdleNode applies flip + rotate like SVG host transform', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasIdleNode(ctx as unknown as CanvasRenderingContext2D, {
      left: 0,
      top: 0,
      width: 40,
      height: 80,
      zoom: 1,
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          fill: '#fff',
          'fill-color': '#fff',
          'stroke-enabled': false,
          flipX: 'true',
          angle: 90,
        },
      } as SceneNodeInput,
    });
    expect(ops.some((o) => o.startsWith('rotate:'))).toBe(true);
    expect(ops).toContain('scale:-1,1');
  });

  it('paintCanvasIdleNode bakes object blur via offscreen drawImage', () => {
    const blurNode = {
      key: 'shape',
      attrs: {
        shapeType: 'rect',
        'fill-color': '#ff0000',
        'border-width': 0,
        'blur-enabled': true,
        'blur-amount': 12,
      },
    } as SceneNodeInput;
    expect(nodeNeedsCanvasEffectBake(blurNode)).toBe(true);
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    withStubbedCanvas2d(ctx, () => {
      paintCanvasIdleNode(ctx as unknown as CanvasRenderingContext2D, {
        left: 10,
        top: 20,
        width: 40,
        height: 30,
        zoom: 1,
        node: blurNode,
      });
    });
    expect(ops).toContain('drawImage');
    expect((ctx as { filter: string }).filter).toBe('none');
  });

  it('nodeNeedsCanvasEffectBake for inner-shadow; not for backdrop-only', () => {
    expect(
      nodeNeedsCanvasEffectBake({
        key: 'shape',
        attrs: {
          'inner-shadow-enabled': true,
          'inner-shadow-visible': true,
          'inner-shadow-blur': 4,
          'inner-shadow-y': 2,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      nodeNeedsCanvasEffectBake({
        key: 'shape',
        attrs: { 'backdrop-blur-enabled': true, 'backdrop-blur-amount': 12 },
      } as SceneNodeInput)
    ).toBe(false);
  });

  it('canvasCompositeFromBlendMode maps CSS modes; normal/pass-through → null', () => {
    expect(canvasCompositeFromBlendMode('multiply')).toBe('multiply');
    expect(canvasCompositeFromBlendMode('screen')).toBe('screen');
    expect(canvasCompositeFromBlendMode('overlay')).toBe('overlay');
    expect(canvasCompositeFromBlendMode('normal')).toBeNull();
    expect(canvasCompositeFromBlendMode('pass-through')).toBeNull();
    expect(canvasCompositeFromBlendMode('passthrough')).toBeNull();
    expect(canvasCompositeFromBlendMode('')).toBeNull();
  });

  it('paintCanvasIdleNode with multiply still draws (blend bake path)', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    const identity = {
      a: 1,
      b: 0,
      c: 0,
      d: 1,
      e: 0,
      f: 0,
      inverse() {
        return this;
      },
    };
    (ctx as { getTransform?: () => typeof identity }).getTransform = () => identity;
    (ctx as { canvas?: HTMLCanvasElement }).canvas = document.createElement('canvas');
    withStubbedCanvas2d(ctx, () => {
      paintCanvasIdleNode(ctx as unknown as CanvasRenderingContext2D, {
        left: 0,
        top: 0,
        width: 40,
        height: 30,
        zoom: 1,
        node: {
          key: 'shape',
          attrs: {
            shapeType: 'rect',
            'fill-color': '#ff0000',
            'border-width': 0,
            blendMode: 'multiply',
          },
        } as SceneNodeInput,
      });
    });
    expect(ops).toContain('drawImage');
  });

  it('paintCanvasMediaInk draws cached image with crop', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    const src = 'https://example.com/media.png';
    setFillImageCacheEntry(src, {
      width: 200,
      height: 100,
      naturalWidth: 200,
      naturalHeight: 100,
    } as CanvasImageSource);
    paintCanvasMediaInk(ctx as unknown as CanvasRenderingContext2D, {
      width: 100,
      height: 50,
      opacity: 1,
      node: {
        key: 'image',
        attrs: { src, cropX: 0.25, cropY: 0.25, cropW: 0.5, cropH: 0.5 },
      } as SceneNodeInput,
    });
    expect(ops).toContain('clip');
    expect(ops).toContain('drawImage');
  });

  it('bakeMediaInkForAtlas draws empty generator plate without src', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    // setupTests stubs HTMLCanvasElement.getContext → null for measureText math.
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const offSpy =
      typeof OffscreenCanvas !== 'undefined'
        ? vi
            .spyOn(OffscreenCanvas.prototype, 'getContext')
            .mockReturnValue(ctx as unknown as RenderingContext)
        : null;
    try {
      const baked = bakeMediaInkForAtlas(
        {
          key: 'image',
          attrs: { src: '', imageGenerator: true },
        } as SceneNodeInput,
        120,
        120,
        undefined,
        10
      );
      expect(baked).not.toBeNull();
      expect((baked as { width: number }).width).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
      offSpy?.mockRestore();
    }
    const inkOps: string[] = [];
    paintGeneratorEmptyInk(mockCtx(inkOps) as unknown as CanvasRenderingContext2D, 80, 80, 1, {
      zoom: 10,
    });
    expect(
      inkOps.some((o) => o.startsWith('fill') || o === 'fillRect' || o.includes('fill'))
    ).toBe(true);
  });

  it('paintCanvasIdleNode clips media to owning clipContent frame', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    const doc = {
      ...emptyDoc(),
      frames: [
        {
          id: 'frame',
          x: 0,
          y: 0,
          width: 200,
          height: 300,
          clipContent: true,
        },
      ],
    } as SceneDocument;
    const node = {
      id: 'img1',
      key: 'image',
      x: -20,
      y: 40,
      width: 120,
      height: 80,
      attrs: { src: 'https://example.com/a.png', frameId: 'frame' },
    } as SceneNodeInput;
    expect(clipCanvasIdleToOwningFrame(ctx as unknown as CanvasRenderingContext2D, doc, node, 1)).toBe(
      true
    );
    expect(ops).toContain('clip');
  });

  it('clipCanvasIdleToOwningFrame skips clip for selection-revealed nodes', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    const doc = {
      ...emptyDoc(),
      frames: [
        {
          id: 'frame',
          x: 0,
          y: 0,
          width: 200,
          height: 300,
          clipContent: true,
        },
      ],
    } as SceneDocument;
    const node = {
      id: 'shape1',
      key: 'shape',
      x: -20,
      y: 40,
      width: 120,
      height: 80,
      attrs: { frameId: 'frame' },
    } as SceneNodeInput;
    setFrameClipRevealOverflowIds(['shape1']);
    expect(clipCanvasIdleToOwningFrame(ctx as unknown as CanvasRenderingContext2D, doc, node, 1)).toBe(
      false
    );
    expect(ops).not.toContain('clip');
    setFrameClipRevealOverflowIds(null);
  });

  it('canvasIdleIsStrokeOnly matches pencil / unfilled path; closed pen with fill is not stroke-only', () => {
    expect(canvasIdleIsStrokeOnly({ attrs: { shapeType: 'pencil' } } as SceneNodeInput)).toBe(true);
    expect(
      canvasIdleIsStrokeOnly({
        attrs: { shapeType: 'path', path: 'M0 0 L1 1', 'fill-color': 'none' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canvasIdleIsStrokeOnly({
        attrs: {
          shapeType: 'pen',
          closed: 'true',
          path: 'M0 0 L10 0 L10 10 Z',
          'fill-enabled': 'true',
          'fill-visible': 'true',
          'fill-color': '#911B1B',
        },
      } as SceneNodeInput)
    ).toBe(false);
    expect(
      canvasIdleIsStrokeOnly({ attrs: { shapeType: 'rect', 'fill-color': '#abc' } } as SceneNodeInput)
    ).toBe(false);
  });

  it('paintCanvasShapeInk strokes rounded rect', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    (ctx as { arcTo?: () => void }).arcTo = () => ops.push('arcTo');
    (ctx as { closePath?: () => void }).closePath = () => ops.push('closePath');
    paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-color': '#ff0000',
          'border-color': '#000000',
          'border-width': 2,
          radiusTL: 4,
          radiusTR: 4,
          radiusBR: 4,
          radiusBL: 4,
        },
      } as SceneNodeInput,
      width: 40,
      height: 30,
      opacity: 1,
    });
    expect(ops).toContain('beginPath');
    expect(ops).toContain('fill');
    expect(ops).toContain('stroke');
  });

  it('paintCanvasTextInk draws fillText glyphs', () => {
    clearIdleTextOutlineCache();
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    (ctx as { fillText?: (...a: unknown[]) => void; textAlign?: string; textBaseline?: string; font?: string }).fillText =
      () => ops.push('fillText');
    paintCanvasTextInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        id: 't-fill',
        key: 'text',
        attrs: {
          ORIGIN_DATA: JSON.stringify([{ children: [{ text: 'Hello' }] }]),
          DATA: JSON.stringify([
            {
              chars: [{ char: 'H', config: { SIZE: 16, COLOR: '#111', FAMILY: 'sans-serif' } }],
            },
          ]),
        },
      } as SceneNodeInput,
      width: 120,
      height: 40,
      opacity: 1,
    });
    expect(ops).toContain('fillText');
  });

  it('paintCanvasTextInk fills primed outline Path2D instead of fillText', () => {
    clearIdleTextOutlineCache();
    const node = {
      id: 't-outline',
      key: 'text',
      width: 80,
      height: 24,
      attrs: {
        ORIGIN_DATA: JSON.stringify([{ children: [{ text: 'Hi' }] }]),
        DATA: JSON.stringify([
          { chars: [{ char: 'H', config: { SIZE: 14, COLOR: '#222', FAMILY: 'sans-serif' } }] },
        ]),
      },
    } as SceneNodeInput;
    primeIdleTextOutlineCache(node, 'M0 0 H10 V10 H0 Z');
    const g = globalThis as { Path2D?: new (d?: string) => object };
    const Prev = g.Path2D;
    g.Path2D = class {
      constructor(public d?: string) {}
    } as never;
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    (ctx as { fillText?: (...a: unknown[]) => void }).fillText = () => ops.push('fillText');
    try {
      paintCanvasTextInk(ctx as unknown as CanvasRenderingContext2D, {
        node,
        width: 80,
        height: 24,
        opacity: 1,
      });
      expect(ops.some((o) => o === 'fill' || o.startsWith('fill:'))).toBe(true);
      expect(ops).not.toContain('fillText');
    } finally {
      if (Prev) g.Path2D = Prev;
      else delete g.Path2D;
      clearIdleTextOutlineCache();
    }
  });

  it('paintCanvasTextInk keeps fillText for CJK until async outline is ready', () => {
    clearIdleTextOutlineCache();
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    (ctx as { fillText?: (...a: unknown[]) => void }).fillText = () => ops.push('fillText');
    paintCanvasTextInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        id: 't-cjk',
        key: 'text',
        attrs: {
          ORIGIN_DATA: JSON.stringify([{ children: [{ text: '你好' }] }]),
          DATA: JSON.stringify([
            {
              chars: [
                { char: '你', config: { SIZE: 16, COLOR: '#111', FAMILY: 'sans-serif' } },
                { char: '好', config: { SIZE: 16, COLOR: '#111', FAMILY: 'sans-serif' } },
              ],
            },
          ]),
        },
      } as SceneNodeInput,
      width: 120,
      height: 40,
      opacity: 1,
    });
    expect(ops).toContain('fillText');
    clearIdleTextOutlineCache();
  });

  it('paintCanvasPathInk respects evenodd fill-rule for boolean holes', () => {
    const ops: string[] = [];
    const ctx = {
      save: () => ops.push('save'),
      restore: () => ops.push('restore'),
      fill: (pathOrRule?: unknown, maybeRule?: unknown) => {
        ops.push(`fill:${String(maybeRule ?? pathOrRule ?? '')}`);
      },
      stroke: () => ops.push('stroke'),
      beginPath: () => {},
      globalAlpha: 1,
      lineCap: '',
      lineJoin: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
    } as unknown as CanvasRenderingContext2D;
    if (typeof Path2D === 'undefined') return;
    paintCanvasPathInk(ctx, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'path',
          path: 'M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z',
          closed: 'true',
          'fill-rule': 'evenodd',
          'fill-color': '#fff',
          'stroke-enabled': false,
        },
      } as SceneNodeInput,
      width: 10,
      height: 10,
    });
    expect(ops.some((o) => o.includes('evenodd'))).toBe(true);
  });

  it('paintCanvasPathInk falls back to centerline without Path2D', () => {
    const hadPath2D = typeof (globalThis as { Path2D?: unknown }).Path2D !== 'undefined';
    const prev = (globalThis as { Path2D?: unknown }).Path2D;
    (globalThis as { Path2D?: unknown }).Path2D = undefined;
    try {
      const ops: string[] = [];
      const ctx = mockCtx(ops);
      paintCanvasPathInk(ctx as unknown as CanvasRenderingContext2D, {
        node: {
          key: 'shape',
          attrs: { shapeType: 'pen', path: 'M0 10 L40 10', 'border-color': '#000', 'border-width': 2 },
        } as SceneNodeInput,
        width: 40,
        height: 20,
        opacity: 1,
        zoom: 1,
      });
      expect(ops).toContain('stroke');
    } finally {
      if (hadPath2D) (globalThis as { Path2D?: unknown }).Path2D = prev;
      else delete (globalThis as { Path2D?: unknown }).Path2D;
    }
  });

  it('paintCanvasShapeInk paints linear gradient + shadow', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-type': 'linear',
          'fill-gradient': JSON.stringify({
            type: 'linear',
            angle: 90,
            colorStops: [
              { offset: 0, color: '#ff0000' },
              { offset: 1, color: '#0000ff' },
            ],
          }),
          'shadow-enabled': true,
          'shadow-blur': 8,
          'shadow-x': 2,
          'shadow-y': 4,
          'border-width': 0,
        },
      } as SceneNodeInput,
      width: 40,
      height: 30,
      opacity: 1,
    });
    expect(ops).toContain('createLinearGradient');
    expect(ops).toContain('addColorStop');
    expect(ops).toContain('fill');
    expect(ctx.shadowBlur === 0 || ops.includes('fill')).toBe(true);
  });

  it('paintCanvasShapeInk paints angular via createConicGradient', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-type': 'angular',
          'fill-gradient': JSON.stringify({
            type: 'angular',
            angle: 45,
            cx: 50,
            cy: 50,
            colorStops: [
              { offset: 0, color: '#ff0000' },
              { offset: 1, color: '#0000ff' },
            ],
          }),
          'border-width': 0,
        },
      } as SceneNodeInput,
      width: 40,
      height: 30,
      opacity: 1,
    });
    // Same as bakeAngularGradientDataUrl: start = (angle - 90)°, center from cx/cy %.
    const expectedStart = ((45 - 90) * Math.PI) / 180;
    expect(ops).toContain(`conic:${expectedStart.toFixed(6)},20.00,15.00`);
    expect(ops).toContain('createConicGradient');
    expect(ops).toContain('addColorStop');
    expect(ops).toContain('fill');
  });

  it('createCanvasAngularGradient returns null without createConicGradient', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops) as unknown as CanvasRenderingContext2D & {
      createConicGradient?: unknown;
    };
    delete ctx.createConicGradient;
    expect(
      createCanvasAngularGradient(
        ctx,
        {
          type: 'angular',
          angle: 0,
          cx: 50,
          cy: 50,
          colorStops: [{ offset: 0, color: '#f00' }],
        },
        40,
        30,
        100
      )
    ).toBeNull();
  });

  it('canIdlePaintOnCanvas allows gradient/image/media/poly/evenodd/donut-arc/outside-stroke; rejects backdrop-blur', () => {
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'border-width': 1,
          'border-color': '#333',
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'line',
          path: 'M0 0 L40 0',
          'border-width': 2,
          'border-color': '#000',
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'pen',
          path: 'M0 0 L10 10 L20 0',
          'border-width': 2,
          'stroke-enabled': true,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-type': 'linear',
          'fill-gradient': '{}',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'ellipse',
          'fill-type': 'angular',
          'fill-gradient': '{}',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'circle', ellipseInnerRatio: 0.5, 'stroke-enabled': false },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'circle', ellipseArcPercent: 40, 'stroke-enabled': false },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'polygon', sides: 6, 'stroke-enabled': false },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'star', sides: 5, 'stroke-enabled': false },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          path: 'M0 0 H10 V10 H0 Z M2 2 H8 V8 H2 Z',
          'fill-rule': 'evenodd',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          path: 'M0 0 H10 V10 H0 Z',
          outlined: 'true',
          'fill-rule': 'evenodd',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-type': 'image',
          'fill-image-src': 'data:image/png;base64,xx',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-type': 'diffuse',
          'fill-gradient': '{}',
          'stroke-enabled': false,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'image',
        attrs: { src: 'https://example.com/a.png' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'video',
        attrs: { poster: 'https://example.com/p.png' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'audio',
        attrs: { src: '', audioGenerator: true },
      } as SceneNodeInput)
    ).toBe(false);
    // Empty image generator plates idle on atlas (zoomBucket restamp), not DomHost.
    expect(
      canIdlePaintOnCanvas({
        key: 'image',
        attrs: { src: '', imageGenerator: true },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'audio',
        attrs: { src: 'https://example.com/a.mp3' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'border-width': 2,
          strokeAlign: 'outside',
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'inner-shadow-enabled': true,
          'inner-shadow-visible': true,
          'inner-shadow-blur': 4,
          'inner-shadow-y': 2,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: {
          shapeType: 'rect',
          'blur-enabled': true,
          'blur-amount': 8,
        },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'rect', 'fill-color': '#f00', blendMode: 'multiply' },
      } as SceneNodeInput)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        key: 'shape',
        attrs: { shapeType: 'rect', 'backdrop-blur-enabled': true, 'backdrop-blur-amount': 12 },
      } as SceneNodeInput)
    ).toBe(false);
  });

  it('paintCanvasShapeInk paints donut with evenodd', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'circle',
          ellipseInnerRatio: 0.4,
          'fill-color': '#ff0000',
          'border-width': 0,
        },
      } as SceneNodeInput,
      width: 100,
      height: 100,
      opacity: 1,
    });
    expect(ops.filter((o) => o === 'ellipse').length).toBeGreaterThanOrEqual(2);
    expect(ops).toContain('fill:evenodd');
  });

  it('paintCanvasShapeInk paints star via vertex path', () => {
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
      node: {
        key: 'shape',
        attrs: {
          shapeType: 'star',
          sides: 5,
          'fill-color': '#00ff00',
          'border-color': '#000000',
          'border-width': 1,
        },
      } as SceneNodeInput,
      width: 80,
      height: 80,
      opacity: 1,
    });
    expect(ops).toContain('moveTo');
    expect(ops.filter((o) => o === 'lineTo').length).toBeGreaterThanOrEqual(9);
    expect(ops).toContain('fill');
    expect(ops).toContain('stroke');
    expect(ops).not.toContain('ellipse');
  });

  it('paintCanvasShapeInk paints image fill via createPattern when cached', () => {
    clearFillImageCache();
    const src = 'test://fill-img';
    const tile = document.createElement('canvas');
    tile.width = 8;
    tile.height = 8;
    setFillImageCacheEntry(src, tile);
    const ops: string[] = [];
    const ctx = mockCtx(ops);
    withStubbedCanvas2d(ctx, () => {
      paintCanvasShapeInk(ctx as unknown as CanvasRenderingContext2D, {
        node: {
          key: 'shape',
          attrs: {
            shapeType: 'rect',
            'fill-type': 'image',
            'fill-image-src': src,
            'fill-image-fit': 'crop',
            'border-width': 0,
          },
        } as SceneNodeInput,
        width: 40,
        height: 30,
        opacity: 1,
      });
    });
    expect(ops).toContain('createPattern');
    expect(ops).toContain('fill');
  });

  it('bumpSceneCanvasIdlePaint notifies subscribers', async () => {
    let n = 0;
    const unsub = subscribeSceneCanvasIdlePaint(() => {
      n += 1;
    });
    bumpSceneCanvasIdlePaint();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    unsub();
    expect(n).toBe(1);
  });

  it('createCanvasSceneRenderer drawCanvasIdle paints stroke centerline', () => {
    const canvas = document.createElement('canvas');
    const ops: string[] = [];
    vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx(ops) as unknown as CanvasRenderingContext2D);
    const doc = {
      deltaSetLike: {
        ROOT: {
          id: 'ROOT',
          key: 'group',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          attrs: {},
          children: ['p1'],
        },
        p1: {
          id: 'p1',
          key: 'shape',
          x: 0,
          y: 0,
          width: 50,
          height: 20,
          attrs: { shapeType: 'pen', path: 'M0 10 L50 10', 'border-color': '#000' },
          children: [],
        },
      },
    };
    const spatial = new SceneSpatialRuntime(64);
    const renderer = createCanvasSceneRenderer({
      canvas,
      getDocument: () => doc,
      getSpatial: () => spatial,
      getZoom: () => 1,
      listNodeIds: () => ['p1'],
      getNodeBox: () => ({ left: 0, top: 0, width: 50, height: 20 }),
      drawCanvasIdle: true,
      paintGrid: false,
    });
    renderer.render({
      document: doc,
      camera: { x: 0, y: 0, zoom: 1 },
      dirty: { kind: 'full' },
      stage: { width: 100, height: 80 },
      dpr: 1,
    });
    expect(ops).toContain('stroke');
    renderer.dispose();
  });
});

describe('SceneCanvasIdlePaint registry', () => {
  it('set / list / clear / subscribe', () => {
    clearSceneCanvasIdlePaint();
    let ticks = 0;
    const unsub = subscribeSceneCanvasIdlePaint(() => {
      ticks += 1;
    });
    const doc = rectDoc();
    setSceneCanvasIdlePaint({
      document: doc,
      canvasIds: ['n1', 'hidden'],
      hiddenNodeId: 'hidden',
      getNodeBox: () => ({ left: 0, top: 0, width: 10, height: 10 }),
    });
    expect(getSceneCanvasIdlePaint()?.canvasIds).toEqual(['n1', 'hidden']);
    expect(listSceneCanvasIdlePaintIds()).toEqual(['n1']);
    expect(ticks).toBe(1);
    clearSceneCanvasIdlePaint();
    expect(getSceneCanvasIdlePaint()).toBeNull();
    expect(listSceneCanvasIdlePaintIds()).toEqual([]);
    expect(ticks).toBe(2);
    unsub();
  });

  it('attr-only document replace does not wake idle paint (needs bump after SoA sync)', async () => {
    clearSceneCanvasIdlePaint();
    let ticks = 0;
    const unsub = subscribeSceneCanvasIdlePaint(() => {
      ticks += 1;
    });
    const box = () => ({ left: 0, top: 0, width: 100, height: 50 });
    const docA = rectDoc();
    setSceneCanvasIdlePaint({
      document: docA,
      canvasIds: ['n1'],
      hiddenNodeId: null,
      getNodeBox: box,
    });
    expect(ticks).toBe(1);
    const docB = {
      ...docA,
      deltaSetLike: {
        ...docA.deltaSetLike,
        n1: {
          ...docA.deltaSetLike.n1,
          attrs: {
            ...(docA.deltaSetLike.n1 as { attrs?: Record<string, unknown> }).attrs,
            cornerRadius: 24,
            radiusTL: 24,
            radiusTR: 24,
            radiusBR: 24,
            radiusBL: 24,
          },
        },
      },
    };
    setSceneCanvasIdlePaint({
      document: docB as typeof docA,
      canvasIds: ['n1'],
      hiddenNodeId: null,
      getNodeBox: box,
    });
    // Membership fingerprint unchanged — corner-radius commit must bump explicitly.
    expect(ticks).toBe(1);
    bumpSceneCanvasIdlePaint();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    expect(ticks).toBe(2);
    clearSceneCanvasIdlePaint();
    unsub();
  });
});

describe('createCanvasSceneRenderer', () => {
  it('render clears and draws basic shapes when enabled', () => {
    const canvas = document.createElement('canvas');
    const ops: string[] = [];
    vi.spyOn(canvas, 'getContext').mockReturnValue(mockCtx(ops) as unknown as CanvasRenderingContext2D);

    const doc = rectDoc();
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['n1'],
      reloadToken: 1,
      aabbPad: 0,
    });
    const renderer = createCanvasSceneRenderer({
      canvas,
      getDocument: () => doc,
      getSpatial: () => spatial,
      getZoom: () => 1,
      listNodeIds: () => ['n1'],
      getNodeBox: () => ({ left: 10, top: 20, width: 100, height: 50 }),
      drawNodeProxies: false,
      drawBasicShapes: true,
      paintGrid: false,
      gridSize: 8,
    });
    expect(renderer.backend).toBe('canvas2d');
    renderer.render({
      document: doc,
      camera: { x: 0, y: 0, zoom: 1 },
      dirty: { kind: 'full' },
      stage: { width: 200, height: 150 },
      dpr: 1,
    });
    expect(ops).toContain('clearRect:0,0,200,150');
    expect(ops).toContain('fillRect');
    expect(renderer.hitTest({ x: 30, y: 40 })).toBe('n1');
    renderer.dispose();
  });
});

describe('hitTestWithSpatialIndex', () => {
  afterEach(() => {
    setSoaCanvasShapesEnabledForTests(null);
    setSelectionPaintRaiseIds(null);
    resetSharedSceneRenderBuffer();
  });

  it('returns null for empty document', () => {
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => emptyDoc(),
          getSpatial: () => new SceneSpatialRuntime(64),
          getZoom: () => 1,
          listNodeIds: () => [],
          getNodeBox: () => null,
        },
        { x: 0, y: 0 }
      )
    ).toBeNull();
  });

  it('rescues hit when spatial AABB is stale but getNodeBox covers the point', () => {
    const doc = {
      stackOrder: ['node:moved'],
      deltaSetLike: {
        ROOT: { children: ['moved'] },
        moved: {
          id: 'moved',
          key: 'shape',
          x: 500,
          y: 500,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    // Stale index: still at the pre-move world box.
    spatial.index.upsert({ id: 'moved', minX: 0, minY: 0, maxX: 80, maxY: 80 });
    expect(spatial.hitCandidateIds({ x: 520, y: 520, pad: 8 })).toEqual([]);
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['moved'],
          getNodeBox: () => ({ left: 500, top: 500, width: 80, height: 80 }),
        },
        { x: 520, y: 520 }
      )
    ).toBe('moved');
    // Heal so the next coarse search finds it without rescue.
    expect(spatial.hitCandidateIds({ x: 520, y: 520, pad: 8 }).map((id) => id)).toEqual([
      'moved',
    ]);
  });

  it('partial-stale rescue: QT returns a neighbor while the moved node is absent', () => {
    const doc = {
      stackOrder: ['node:neighbor', 'node:moved'],
      deltaSetLike: {
        ROOT: { children: ['neighbor', 'moved'] },
        neighbor: {
          id: 'neighbor',
          key: 'shape',
          x: 0,
          y: 0,
          width: 40,
          height: 40,
          attrs: { shapeType: 'rect', 'fill-color': '#eee' },
        },
        moved: {
          id: 'moved',
          key: 'shape',
          x: 500,
          y: 500,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    // Neighbor still indexed near origin; moved still at stale (0,0) AABB — click at 520.
    spatial.index.upsert({ id: 'neighbor', minX: 0, minY: 0, maxX: 40, maxY: 40 });
    spatial.index.upsert({ id: 'moved', minX: 0, minY: 0, maxX: 80, maxY: 80 });
    // Coarse at 520 returns [] with small pad — use large pad so neighbor isn't required;
    // simulate non-empty order by also indexing a decoy at the click that misses precise.
    spatial.index.upsert({ id: 'decoy', minX: 510, minY: 510, maxX: 530, maxY: 530 });
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['neighbor', 'moved'],
          getNodeBox: (id) => {
            const node = doc.deltaSetLike[id];
            if (!node) return null;
            return { left: node.x, top: node.y, width: node.width, height: node.height };
          },
        },
        { x: 520, y: 520 }
      )
    ).toBe('moved');
  });

  it('unified walk: higher plate wins over world node under it (returns __frame__:id)', () => {
    const doc = {
      stackOrder: ['node:under', 'frame:board'],
      frames: [
        {
          id: 'board',
          name: 'A',
          backgroundColor: '#fff',
          x: 0,
          y: 0,
          width: 200,
          height: 200,
        },
      ],
      deltaSetLike: {
        ROOT: { children: ['under'] },
        under: {
          id: 'under',
          key: 'shape',
          x: 20,
          y: 20,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#0af' },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['under'],
      reloadToken: 1,
      aabbPad: 0,
    });
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['under'],
          getNodeBox: (id) => {
            const node = doc.deltaSetLike[id];
            return { left: node.x, top: node.y, width: node.width, height: node.height };
          },
        },
        { x: 40, y: 40 }
      )
    ).toBe('__frame__:board');
  });

  it('unified walk: bound child above its plate keeps the node hit', () => {
    const doc = {
      stackOrder: ['frame:board'],
      frames: [
        {
          id: 'board',
          name: 'A',
          backgroundColor: '#fff',
          x: 0,
          y: 0,
          width: 200,
          height: 200,
        },
      ],
      deltaSetLike: {
        ROOT: { children: ['child'] },
        child: {
          id: 'child',
          key: 'shape',
          x: 20,
          y: 20,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#0af', frameId: 'board', frameOrder: 0 },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['child'],
      reloadToken: 1,
      aabbPad: 0,
    });
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['child'],
          getNodeBox: (id) => {
            const node = doc.deltaSetLike[id];
            return { left: node.x, top: node.y, width: node.width, height: node.height };
          },
        },
        { x: 40, y: 40 }
      )
    ).toBe('child');
  });

  it('uses stackOrder instead of root child order for overlapping nodes', () => {
    const doc = {
      stackOrder: ['node:back', 'node:front'],
      deltaSetLike: {
        ROOT: { children: ['front', 'back'] },
        front: {
          id: 'front',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
        back: {
          id: 'back',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['front', 'back'],
      reloadToken: 1,
      aabbPad: 0,
    });
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['front', 'back'],
          getNodeBox: (id) => {
            const node = doc.deltaSetLike[id];
            return { left: node.x, top: node.y, width: node.width, height: node.height };
          },
        },
        { x: 30, y: 30 }
      )
    ).toBe('front');
  });

  it('hit keeps permanent stackOrder — selection paint raise does not steal clicks', () => {
    const doc = {
      stackOrder: ['node:back', 'node:front'],
      deltaSetLike: {
        ROOT: { children: ['front', 'back'] },
        front: {
          id: 'front',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
        back: {
          id: 'back',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 80,
          attrs: {
            shapeType: 'rect',
            'fill-color': 'transparent',
            'fill-enabled': 'false',
          },
        },
      },
    } as unknown as SceneDocument;
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['front', 'back'],
      reloadToken: 1,
      aabbPad: 0,
    });
    setSelectionPaintRaiseIds(['back']);
    try {
      expect(
        hitTestWithSpatialIndex(
          {
            getDocument: () => doc,
            getSpatial: () => spatial,
            getZoom: () => 1,
            listNodeIds: () => ['front', 'back'],
            getNodeBox: (id) => {
              const node = doc.deltaSetLike[id];
              return { left: node.x, top: node.y, width: node.width, height: node.height };
            },
          },
          { x: 30, y: 30 }
        )
      ).toBe('front');
    } finally {
      setSelectionPaintRaiseIds(null);
    }
  });

  it('picks canvas-idle shapes from SoA buffer when flag is on', () => {
    setSoaCanvasShapesEnabledForTests(true);
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'soa-rect', {
      id: 'soa-rect',
      key: 'shape',
      x: 40,
      y: 40,
      width: 60,
      height: 60,
      attrs: { shapeType: 'rect', fill: '#336699' },
      children: [],
    });
    const buf = getSharedSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['soa-rect'],
      reloadToken: 1,
      aabbPad: 0,
    });
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['soa-rect'],
          getNodeBox: () => ({ left: 40, top: 40, width: 60, height: 60 }),
        },
        { x: 50, y: 50 }
      )
    ).toBe('soa-rect');
  });

  it('prefers topmost SVG host over larger canvas-idle rect underneath', () => {
    setSoaCanvasShapesEnabledForTests(true);
    let doc = createEmptyDocument({ width: 2400, height: 1800, emptyWorld: true });
    doc = addNodeToDocument(doc, 'back', {
      id: 'back',
      key: 'shape',
      x: 0,
      y: 0,
      width: 2204,
      height: 1637,
      attrs: { shapeType: 'rect', 'fill-color': '#ffffff', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'front', {
      id: 'front',
      key: 'shape',
      x: 900,
      y: 650,
      width: 400,
      height: 300,
      attrs: { shapeType: 'rect', 'fill-color': '#ffffff', 'stroke-enabled': false },
      children: [],
    });
    doc = {
      ...doc,
      stackOrder: ['node:back', 'node:front'],
    };
    const buf = getSharedSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    applySoaHostInkFlags(buf, new Set(['front']));
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['back', 'front'],
      reloadToken: 1,
      aabbPad: 0,
    });
    const getNodeBox = (id: string) => {
      const node = doc.deltaSetLike?.[id];
      if (!node) return null;
      return {
        left: Number(node.x) || 0,
        top: Number(node.y) || 0,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
      };
    };
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['back', 'front'],
          getNodeBox,
        },
        { x: 1100, y: 800 }
      )
    ).toBe('front');
  });

  it('does not select a filled rect via the spatial +64 CSS px halo above the box', () => {
    setSoaCanvasShapesEnabledForTests(true);
    const doc = {
      stackOrder: ['node:plate'],
      deltaSetLike: {
        ROOT: { children: ['plate'] },
        plate: {
          id: 'plate',
          key: 'shape',
          x: 0,
          y: 100,
          width: 200,
          height: 200,
          attrs: { shapeType: 'rect', 'fill-color': '#fff' },
        },
      },
    } as unknown as SceneDocument;
    const buf = getSharedSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const spatial = new SceneSpatialRuntime(64);
    spatial.sync({
      document: doc,
      childrenIds: ['plate'],
      reloadToken: 1,
      aabbPad: 0,
    });
    const getNodeBox = () => ({ left: 0, top: 100, width: 200, height: 200 });
    // ~40 CSS px above the plate — inside old searchPad (12+64) but outside ink.
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['plate'],
          getNodeBox,
        },
        { x: 50, y: 60 }
      )
    ).toBeNull();
    expect(
      hitTestWithSpatialIndex(
        {
          getDocument: () => doc,
          getSpatial: () => spatial,
          getZoom: () => 1,
          listNodeIds: () => ['plate'],
          getNodeBox,
        },
        { x: 50, y: 120 }
      )
    ).toBe('plate');
  });
});
