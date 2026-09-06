/**
 * SoA render-engine tier benches (2k / 10k / 100k light rects).
 *
 * Records create (doc+buffer sync), pan cull proxy, hit, and RSS when available.
 * 1M is noted as bake-path only — not first-class editable layers.
 *
 * Run: `npm run test:stress --workspace=apps/web`
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  createEmptyDocument,
  stackNodeKey,
  buildNodeStackZMap,
} from '@/components/rcb/scene/document/sceneDocument';
import { boxesIntersect, nodeSceneAabb, RcbSpatialIndex } from '@/components/rcb/core/spatialIndex';
import { HEAVY_PATH_D_CHARS } from '@/components/rcb/scene/document/sceneShapes';
import { pickFullAndCanvasIds } from '@/components/rcb/shapes/RcbShapesLayer';
import { paintCanvasIdleNode } from '../sceneRenderer';
import {
  createSceneRenderBuffer,
  forEachVisibleInRect,
  hitTestSoaBuffer,
  hitTestSoaBufferOrdered,
  paintSoaBufferBasic,
  paintSoaIdleSlot,
  rebuildSoaPathSamples,
  resolveSoaPaintBox,
  setSoaCanvasShapesEnabledForTests,
  syncSceneRenderBufferFromDocument,
  syncSceneRenderBufferIncremental,
  SOA_FLAG_BASIC_GEOM,
  SOA_FLAG_CANVAS_IDLE,
  SOA_FLAG_VISIBLE,
  type SceneRenderBuffer,
} from '../sceneRenderBuffer';
import {
  ensureSoaBake,
  ensureSoaBakeTile,
  getSoaBakeCountThreshold,
  setSharedSoaBakeCache,
  createSoaBakeCache,
  shouldUseSoaBake,
} from '../soaBakeLayer';

type TierRow = {
  n: number;
  buildDocMs: number;
  syncMs: number;
  panCullMs: number;
  panCullVisible: number;
  hitLinearMs: number;
  hitOrderedMs: number;
  spatialBuildMs: number;
  spatialHitCandAvg: number;
  bakeEnsureMs: number | null;
  bakeTiles: number | null;
  rssMb: number | null;
  heapMb: number | null;
  bakeRecommended: boolean;
  bakeThreshold: number;
};

const RESULTS: TierRow[] = [];

function smallPathD() {
  return 'M 0 0 L 40 0 L 40 40 L 0 40 Z';
}

function heavyPathD() {
  const parts: string[] = ['M 0 0'];
  for (let i = 1; i <= 800; i += 1) {
    parts.push(`L ${(i % 40) * 1.1} ${(i % 37) * 0.9}`);
  }
  parts.push('Z');
  const d = parts.join(' ');
  return d.length < HEAVY_PATH_D_CHARS ? `${d} ${d}` : d;
}

function mixedKindForIndex(i: number): 'rect' | 'text' | 'path' | 'heavyPath' {
  const m = i % 20;
  if (m < 10) return 'rect';
  if (m < 14) return 'text';
  if (m < 18) return 'path';
  return 'heavyPath';
}

function makeMixedNode(id: string, i: number, cols: number): SceneNodeInput {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = col * 48;
  const y = row * 48;
  const base = {
    id,
    x,
    y,
    z: i,
    width: 40,
    height: 40,
    children: [] as string[],
  };
  const kind = mixedKindForIndex(i);
  if (kind === 'text') {
    return {
      ...base,
      key: 'text',
      width: 120,
      height: 28,
      attrs: {
        markdown: `Label ${i}`,
        DATA: `Label ${i}`,
        fontSize: 14,
        fontFamily: 'Inter',
        'fill-color': '#111827',
      },
    };
  }
  if (kind === 'rect') {
    return {
      ...base,
      key: 'shape',
      attrs: {
        shapeType: 'rect',
        'fill-color': i % 3 === 0 ? '#EEF2FF' : '#F8FAFC',
        'fill-enabled': 'true',
        'border-color': '#334155',
        'border-width': 1,
        'stroke-enabled': 'true',
        strokeAlign: i % 5 === 0 ? 'outside' : 'center',
        cornerRadius: i % 7 === 0 ? 8 : 0,
      },
    };
  }
  const d = kind === 'heavyPath' ? heavyPathD() : smallPathD();
  return {
    ...base,
    key: 'shape',
    attrs: {
      shapeType: 'path',
      path: d,
      closed: 'true',
      'fill-color': '#FEE2E2',
      'fill-enabled': 'true',
      'border-width': 0,
      'stroke-enabled': 'false',
    },
  };
}

function buildMixedDesignDoc(n: number): SceneDocument {
  const doc = createEmptyDocument({ emptyWorld: true, width: 4000, height: 4000 });
  const cols = Math.ceil(Math.sqrt(n));
  const children: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `n${i}`;
    children.push(id);
    doc.deltaSetLike[id] = makeMixedNode(id, i, cols);
  }
  doc.pages[0].children = children;
  doc.deltaSetLike.ROOT = {
    ...doc.deltaSetLike.ROOT,
    children: [...children],
  };
  doc.stackOrder = children.map((id) => stackNodeKey(id));
  return doc;
}

function visibleRootIds(doc: SceneDocument, view: { minX: number; minY: number; maxX: number; maxY: number }) {
  const ids: string[] = doc.deltaSetLike?.ROOT?.children || [];
  const out: string[] = [];
  for (const id of ids) {
    const box = nodeSceneAabb(doc, id, 8);
    if (box && boxesIntersect(box, view)) out.push(id);
  }
  return out;
}

function sortIdsByDocumentZ(doc: SceneDocument, ids: readonly string[]): string[] {
  if (ids.length < 2) return ids.slice();
  const zMap = buildNodeStackZMap(doc, ids);
  const rank = new Map(ids.map((id, i) => [id, i]));
  return ids.slice().sort((a, b) => {
    return (zMap.get(a) || 0) - (zMap.get(b) || 0) || (rank.get(a) || 0) - (rank.get(b) || 0);
  });
}

function paintMixedInkFrame(
  ctx: CanvasRenderingContext2D,
  buf: SceneRenderBuffer,
  doc: SceneDocument,
  visibleIds: readonly string[],
  view: { minX: number; minY: number; maxX: number; maxY: number },
  aabbDirty?: { minX: number; minY: number; maxX: number; maxY: number } | null
): void {
  const viewBox = {
    left: view.minX,
    top: view.minY,
    right: view.maxX,
    bottom: view.maxY,
  };
  for (const id of sortIdsByDocumentZ(doc, visibleIds)) {
    const si = buf.indexById.get(id);
    const flags = si != null ? buf.flags[si] : 0;
    if (
      si != null &&
      (flags & SOA_FLAG_CANVAS_IDLE) !== 0 &&
      (flags & SOA_FLAG_BASIC_GEOM) !== 0
    ) {
      if (aabbDirty) {
        const { x, y, w, h } = resolveSoaPaintBox(buf, si, doc);
        const box = { minX: x, minY: y, maxX: x + w, maxY: y + h };
        if (!boxesIntersect(box, aabbDirty)) continue;
      }
      paintSoaIdleSlot(ctx, buf, si, viewBox, doc);
      continue;
    }
    const node = doc.deltaSetLike?.[id] as SceneNodeInput | undefined;
    if (!node) continue;
    const box = nodeSceneAabb(doc, id, 8);
    if (!box || !boxesIntersect(box, view)) continue;
    if (aabbDirty && !boxesIntersect(box, aabbDirty)) continue;
    paintCanvasIdleNode(ctx, {
      left: box.minX,
      top: box.minY,
      width: box.maxX - box.minX,
      height: box.maxY - box.minY,
      node,
      zoom: 1,
      document: doc,
    });
  }
}

function rssMb(): number | null {
  try {
    const mem = (process as NodeJS.Process & { memoryUsage?: () => NodeJS.MemoryUsage }).memoryUsage?.();
    if (!mem) return null;
    return Math.round((mem.rss / (1024 * 1024)) * 10) / 10;
  } catch {
    return null;
  }
}

function heapMb(): number | null {
  try {
    const mem = (process as NodeJS.Process & { memoryUsage?: () => NodeJS.MemoryUsage }).memoryUsage?.();
    if (!mem) return null;
    return Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10;
  } catch {
    return null;
  }
}

function buildLightRectDoc(n: number): SceneDocument {
  const children: string[] = [];
  const deltaSetLike: Record<string, unknown> = {};
  const cols = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i += 1) {
    const id = `r${i}`;
    children.push(id);
    deltaSetLike[id] = {
      id,
      key: 'shape',
      x: (i % cols) * 24,
      y: Math.floor(i / cols) * 24,
      width: 16,
      height: 16,
      attrs: { shapeType: 'rect', fill: i % 2 ? '#334155' : '#94a3b8' },
      children: [],
    };
  }
  const base = createEmptyDocument({
    width: cols * 24 + 64,
    height: Math.ceil(n / cols) * 24 + 64,
    emptyWorld: true,
  });
  return {
    ...base,
    deltaSetLike: {
      ...base.deltaSetLike,
      ...deltaSetLike,
      ROOT: { ...(base.deltaSetLike.ROOT as object), children },
    },
    stackOrder: children.map((id) => `node:${id}`),
  } as SceneDocument;
}

function runTier(n: number): TierRow {
  const tDoc0 = performance.now();
  const doc = buildLightRectDoc(n);
  const buildDocMs = performance.now() - tDoc0;

  const buf = createSceneRenderBuffer(n);
  const tSync0 = performance.now();
  syncSceneRenderBufferFromDocument(buf, doc);
  const syncMs = performance.now() - tSync0;
  expect(buf.count).toBe(n);

  const view = { minX: 0, minY: 0, maxX: 480, maxY: 320 };
  const tCull0 = performance.now();
  let panCullVisible = 0;
  for (let rep = 0; rep < 20; rep += 1) {
    panCullVisible = 0;
    forEachVisibleInRect(buf, view, () => {
      panCullVisible += 1;
    });
  }
  const panCullMs = (performance.now() - tCull0) / 20;

  const mid = Math.floor(n / 2);
  const midId = `r${mid}`;
  const idx = buf.indexById.get(midId)!;
  const hx = buf.positions[idx * 4] + 4;
  const hy = buf.positions[idx * 4 + 1] + 4;

  const tHit0 = performance.now();
  let hitId: string | null = null;
  for (let rep = 0; rep < 50; rep += 1) {
    hitId = hitTestSoaBuffer(buf, hx, hy);
  }
  const hitLinearMs = (performance.now() - tHit0) / 50;
  expect(hitId).toBeTruthy();

  const order = [midId];
  const tOrd0 = performance.now();
  for (let rep = 0; rep < 200; rep += 1) {
    hitTestSoaBufferOrdered(buf, hx, hy, order);
  }
  const hitOrderedMs = (performance.now() - tOrd0) / 200;

  const tSp0 = performance.now();
  const spatial = RcbSpatialIndex.fromRenderBuffer(buf);
  const spatialBuildMs = performance.now() - tSp0;

  let candSum = 0;
  const probes = 40;
  for (let p = 0; p < probes; p += 1) {
    const id = `r${Math.floor((p / probes) * n)}`;
    const i = buf.indexById.get(id)!;
    const x = buf.positions[i * 4] + 2;
    const y = buf.positions[i * 4 + 1] + 2;
    candSum += spatial.search(x - 8, y - 8, x + 24, y + 24).length;
  }
  const spatialHitCandAvg = candSum / probes;

  let bakeEnsureMs: number | null = null;
  let bakeTiles: number | null = null;
  if (shouldUseSoaBake(buf)) {
    const cache = createSoaBakeCache();
    setSharedSoaBakeCache(cache);
    const tw = 2_048;
    const tBake0 = performance.now();
    const bake = ensureSoaBake(buf, null);
    if (bake?.valid) {
      for (const [tx, ty] of [
        [0, 0],
        [1, 0],
        [0, 1],
      ] as const) {
        ensureSoaBakeTile(buf, cache, tx, ty, {
          left: tx * tw,
          top: ty * tw,
          width: tw,
          height: tw,
        });
      }
    }
    bakeEnsureMs = Math.round((performance.now() - tBake0) * 10) / 10;
    bakeTiles = cache.tiles.size;
  }

  return {
    n,
    buildDocMs: Math.round(buildDocMs * 10) / 10,
    syncMs: Math.round(syncMs * 10) / 10,
    panCullMs: Math.round(panCullMs * 100) / 100,
    panCullVisible,
    hitLinearMs: Math.round(hitLinearMs * 1000) / 1000,
    hitOrderedMs: Math.round(hitOrderedMs * 1000) / 1000,
    spatialBuildMs: Math.round(spatialBuildMs * 10) / 10,
    spatialHitCandAvg: Math.round(spatialHitCandAvg * 10) / 10,
    bakeEnsureMs,
    bakeTiles,
    rssMb: rssMb(),
    heapMb: heapMb(),
    bakeRecommended: shouldUseSoaBake(buf),
    bakeThreshold: getSoaBakeCountThreshold(),
  };
}

function mockBenchCtx(): CanvasRenderingContext2D {
  const noop = () => undefined;
  return {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    bezierCurveTo: noop,
    arc: noop,
    arcTo: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    translate: noop,
    rotate: noop,
    scale: noop,
    transform: noop,
    setTransform: noop,
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set lineCap(_v: string) {},
    set lineJoin(_v: string) {},
    set globalAlpha(_v: number) {},
    set shadowColor(_v: string) {},
    set shadowBlur(_v: number) {},
    set shadowOffsetX(_v: number) {},
    set shadowOffsetY(_v: number) {},
    set font(_v: string) {},
    set textBaseline(_v: string) {},
    set textAlign(_v: string) {},
    measureText(_text: string) {
      return { width: 40 } as TextMetrics;
    },
    fillText: noop,
  } as unknown as CanvasRenderingContext2D;
}

describe('SoA render tier benches', () => {
  it('2k / 10k / 100k light rects — sync, pan cull, hit, RSS', () => {
    for (const n of [2_000, 10_000, 100_000] as const) {
      RESULTS.push(runTier(n));
    }
    expect(RESULTS).toHaveLength(3);
    expect(RESULTS[0].n).toBe(2_000);
    expect(RESULTS[2].syncMs).toBeLessThan(20_000);
    // Ordered + spatial candidates stay interactive; linear scan grows with N.
    expect(RESULTS[0].hitOrderedMs).toBeLessThan(2);
    expect(RESULTS[1].hitOrderedMs).toBeLessThan(2);

    const outPath = resolve(__dirname, '../../../../../soa-render-tiers.bench.json');
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          note:
            '1M light shapes: use SoA bake tiles + pick (not 1M SVG hosts / editable layers).',
          bakeThresholdDefault: getSoaBakeCountThreshold(),
          tiers: RESULTS,
        },
        null,
        2
      )
    );
  });

  it('documents 1M as bake-path (threshold), not host-per-node', () => {
    const thr = getSoaBakeCountThreshold();
    const fake = createSceneRenderBuffer(thr);
    fake.count = thr;
    for (let i = 0; i < thr; i += 1) {
      fake.flags[i] =
        (SOA_FLAG_CANVAS_IDLE | SOA_FLAG_VISIBLE | SOA_FLAG_BASIC_GEOM) >>> 0;
    }
    expect(shouldUseSoaBake(fake)).toBe(true);
    expect(thr).toBeLessThanOrEqual(1_000_000);
  });

  it('polygon + stroked-rect paint path: 150 / 1k / 5k / 10k', () => {
    type ShapeRow = {
      kind: 'polygon' | 'strokedRect';
      n: number;
      syncMs: number;
      paint60Ms: number;
      paintFrameMs: number;
      incrementalOneMs: number;
      basicGeomCount: number;
    };
    const rows: ShapeRow[] = [];

    function buildDoc(
      n: number,
      kind: 'polygon' | 'strokedRect'
    ): SceneDocument {
      const children: string[] = [];
      const deltaSetLike: Record<string, unknown> = {};
      const cols = Math.ceil(Math.sqrt(n));
      for (let i = 0; i < n; i += 1) {
        const id = `s${i}`;
        children.push(id);
        deltaSetLike[id] = {
          id,
          key: 'shape',
          x: (i % cols) * 28,
          y: Math.floor(i / cols) * 28,
          width: 48,
          height: 48,
          attrs:
            kind === 'polygon'
              ? {
                  shapeType: 'polygon',
                  sides: 6,
                  'fill-color': '#ffffff',
                  'border-color': '#111111',
                  'border-width': 1,
                }
              : {
                  shapeType: 'rect',
                  'fill-color': '#ffffff',
                  'border-color': '#111111',
                  'border-width': 1,
                },
          children: [],
        };
      }
      const base = createEmptyDocument({
        width: cols * 28 + 64,
        height: Math.ceil(n / cols) * 28 + 64,
        emptyWorld: true,
      });
      // Put all shapes on one artboard — matches product path (frameId siblings).
      const frames = [
        {
          id: 'board',
          x: 0,
          y: 0,
          width: cols * 28 + 64,
          height: Math.ceil(n / cols) * 28 + 64,
          clipContent: true,
        },
      ];
      for (const id of children) {
        const node = deltaSetLike[id] as { attrs: Record<string, unknown> };
        node.attrs = { ...node.attrs, frameId: 'board' };
      }
      return {
        ...base,
        frames,
        deltaSetLike: {
          ...base.deltaSetLike,
          ...deltaSetLike,
          ROOT: { ...(base.deltaSetLike.ROOT as object), children },
        },
        stackOrder: [`frame:board`],
      } as SceneDocument;
    }

    function runShape(kind: 'polygon' | 'strokedRect', n: number): ShapeRow {
      const doc = buildDoc(n, kind);
      const buf = createSceneRenderBuffer(n);
      const t0 = performance.now();
      syncSceneRenderBufferFromDocument(buf, doc);
      const syncMs = performance.now() - t0;
      expect(buf.count).toBe(n);

      let basicGeomCount = 0;
      for (let i = 0; i < buf.count; i += 1) {
        if (buf.flags[i] & SOA_FLAG_BASIC_GEOM) basicGeomCount += 1;
      }

      const ctx = mockBenchCtx();
      const view = { left: 0, top: 0, width: 1200, height: 800 };
      const tPaint0 = performance.now();
      for (let f = 0; f < 60; f += 1) {
        paintSoaBufferBasic(ctx, buf, view, { document: doc });
      }
      const paint60Ms = performance.now() - tPaint0;

      const patchId = `s${n - 1}`;
      const patched = {
        ...doc,
        deltaSetLike: {
          ...doc.deltaSetLike,
          [patchId]: {
            ...(doc.deltaSetLike[patchId] as object),
            x: 10,
            y: 10,
          },
        },
      } as SceneDocument;
      const tInc0 = performance.now();
      syncSceneRenderBufferIncremental(buf, patched, [patchId]);
      const incrementalOneMs = performance.now() - tInc0;

      return {
        kind,
        n,
        syncMs: Math.round(syncMs * 10) / 10,
        paint60Ms: Math.round(paint60Ms * 10) / 10,
        paintFrameMs: Math.round((paint60Ms / 60) * 100) / 100,
        incrementalOneMs: Math.round(incrementalOneMs * 100) / 100,
        basicGeomCount,
      };
    }

    for (const kind of ['strokedRect', 'polygon'] as const) {
      for (const n of [150, 1_000, 5_000, 10_000] as const) {
        rows.push(runShape(kind, n));
      }
    }

    // 150 shapes must stay interactive on the SoA paint path (<16ms/frame budget).
    for (const row of rows.filter((r) => r.n === 150)) {
      expect(row.basicGeomCount).toBe(150);
      expect(row.paintFrameMs).toBeLessThan(16);
      expect(row.incrementalOneMs).toBeLessThan(50);
    }

    const outPath = resolve(__dirname, '../../../../../soa-shape-paint.bench.json');
    writeFileSync(
      outPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2)
    );
    // eslint-disable-next-line no-console
    console.log('\nSOA_SHAPE_PAINT_BENCH\n', JSON.stringify({ rows }, null, 2));
  });

  it('mixed design-like 10k — host budget + ink frame budget (headless)', () => {
    setSoaCanvasShapesEnabledForTests(true);
    try {
      const n = 10_000;
      const doc = buildMixedDesignDoc(n);
      const buf = createSceneRenderBuffer(n);
      const tSync0 = performance.now();
      syncSceneRenderBufferFromDocument(buf, doc);
      rebuildSoaPathSamples(buf, doc);
      const syncMs = performance.now() - tSync0;
      expect(buf.count).toBe(n);

      const view = { minX: 0, minY: 0, maxX: 960, maxY: 960 };
      const visibleIds = visibleRootIds(doc, view);
      expect(visibleIds.length).toBeGreaterThan(200);

      const host1 = pickFullAndCanvasIds({ document: doc, visibleIds, zoom: 1 });
      const hostMotion = pickFullAndCanvasIds({ document: doc, visibleIds, zoom: 0.25 });
      expect(host1.fullIds.length).toBeLessThanOrEqual(96);
      expect(host1.canvasIds.length).toBeGreaterThan(0);
      expect(hostMotion.fullIds.length).toBeLessThanOrEqual(96);
      expect(hostMotion.canvasIds.length).toBeGreaterThan(0);

      let basicGeomCount = 0;
      for (let i = 0; i < buf.count; i += 1) {
        if (buf.flags[i] & SOA_FLAG_BASIC_GEOM) basicGeomCount += 1;
      }

      const ctx = mockBenchCtx();
      const panView = { minX: 0, minY: 0, maxX: 960, maxY: 960 };
      const panVisible = visibleRootIds(doc, panView);

      const tFull0 = performance.now();
      for (let f = 0; f < 20; f += 1) {
        paintMixedInkFrame(ctx, buf, doc, panVisible, panView, null);
      }
      const fullViewportPaintFrameMs =
        Math.round(((performance.now() - tFull0) / 20) * 100) / 100;

      const tPaint0 = performance.now();
      for (let f = 0; f < 60; f += 1) {
        const pan = f * 48;
        const frameView = {
          minX: pan,
          minY: pan * 0.5,
          maxX: pan + 960,
          maxY: pan * 0.5 + 960,
        };
        const dirty = {
          minX: pan + 120,
          minY: pan * 0.5 + 80,
          maxX: pan + 480,
          maxY: pan * 0.5 + 400,
        };
        const frameVisible = visibleRootIds(doc, frameView);
        paintMixedInkFrame(ctx, buf, doc, frameVisible, frameView, dirty);
      }
      const paint60Ms = performance.now() - tPaint0;
      const dirtyStripePaintFrameMs = Math.round((paint60Ms / 60) * 100) / 100;

      const row = {
        n,
        syncMs: Math.round(syncMs * 10) / 10,
        paint60Ms: Math.round(paint60Ms * 10) / 10,
        dirtyStripePaintFrameMs,
        fullViewportPaintFrameMs,
        visibleInView: visibleIds.length,
        basicGeomCount,
        hostFullAt1x: host1.fullIds.length,
        hostCanvasAt1x: host1.canvasIds.length,
        hostFullAtMotion: hostMotion.fullIds.length,
        hostCanvasAtMotion: hostMotion.canvasIds.length,
      };

      const outPath = resolve(__dirname, '../../../../../soa-mixed-10k.bench.json');
      writeFileSync(
        outPath,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            env: 'vitest+jsdom (SoA sync/cull/Canvas2D paint proxy)',
            budgets: { dirtyStripePaintFrameMs: 16, fullViewportPaintFrameMs: 20 },
            row,
            pass: {
              dirty: dirtyStripePaintFrameMs < 16,
              fullViewport: fullViewportPaintFrameMs < 20,
              sync: row.syncMs < 1500,
            },
          },
          null,
          2
        )
      );
      // eslint-disable-next-line no-console
      console.log('\nSOA_MIXED_10K_BENCH\n', JSON.stringify({ row }, null, 2));

      expect(dirtyStripePaintFrameMs).toBeLessThan(16);
      expect(fullViewportPaintFrameMs).toBeLessThan(20);
      expect(row.syncMs).toBeLessThan(1500);
    } finally {
      setSoaCanvasShapesEnabledForTests(null);
    }
  });
});
