import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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
import { buildCompoundFillMeshes } from '@/components/rcb/render/vector/wasmGeom';
import { densifyPathDJs } from '@/components/rcb/render/vector/densifyPathDJs';
import {
  clearTextOutlineMeshCache,
  setTextOutlineMeshForTests,
  getTextOutlineMesh,
} from '@/components/rcb/render/vector/textOutlineMesh';
import { shapeInkForbidsAtlas } from '@/components/rcb/render/vector/inkBackend';
import {
  clearSceneCanvasIdlePaint,
  setSceneCanvasIdlePaint,
} from '@/components/rcb/render/sceneRenderer';
import { createSoaWebglAtlas } from '@/components/rcb/render/webglInstanceAtlas';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';

describe('buildCompoundFillMeshes', () => {
  it('fills outer with hole (donut) without solid counter', () => {
    // Outer unit square + inner square (hole).
    const d = 'M 0 0 L 10 0 L 10 10 L 0 10 Z M 3 3 L 7 3 L 7 7 L 3 7 Z';
    const pts = densifyPathDJs(d);
    const mesh = buildCompoundFillMeshes(pts, 'evenodd');
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(2);
    expect(mesh!.positions.length).toBeGreaterThanOrEqual(12);
  });

  it('per-glyph mesh keeps counters on multi-letter o-like paths', async () => {
    const { buildTextGlyphFillMeshes } = await import('@/components/rcb/render/vector/wasmGeom');
    // Two letters, each outer+hole — global nest used to fill counters solid.
    const glyphs = [
      'M 0 0 L 8 0 L 8 8 L 0 8 Z M 2 2 L 6 2 L 6 6 L 2 6 Z',
      'M 10 0 L 18 0 L 18 8 L 10 8 Z M 12 2 L 16 2 L 16 6 L 12 6 Z',
    ];
    const mesh = buildTextGlyphFillMeshes(glyphs, 'evenodd');
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(4);
    // Solid fill of both outers without holes would still have tris; ensure holes
    // were applied by comparing to solid-only compound of outers.
    const solidOnly = buildCompoundFillMeshes(
      densifyPathDJs('M 0 0 L 8 0 L 8 8 L 0 8 Z M 10 0 L 18 0 L 18 8 L 10 8 Z'),
      'evenodd'
    );
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(solidOnly!.triangleCount);
  });

  it('emits fill for multiple disjoint glyph-like rings', () => {
    const d = 'M 0 0 L 2 0 L 2 4 L 0 4 Z M 4 0 L 6 0 L 6 4 L 4 4 Z';
    const mesh = buildCompoundFillMeshes(densifyPathDJs(d), 'nonzero');
    expect(mesh).not.toBeNull();
    expect(mesh!.triangleCount).toBeGreaterThanOrEqual(4);
  });
});

describe('text outline mesh idle collect', () => {
  beforeEach(() => {
    clearTextOutlineMeshCache();
    clearSceneCanvasIdlePaint();
  });
  afterEach(() => {
    clearSceneCanvasIdlePaint();
  });

  it('shapeInkForbidsAtlas includes text', () => {
    expect(shapeInkForbidsAtlas({ key: 'text', attrs: {} })).toBe(true);
  });

  it('TEXT collect is MSDF-only (injected outline mesh is not drawn on WebGL idle)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 't1', {
      id: 't1',
      key: 'text',
      x: 10,
      y: 10,
      width: 80,
      height: 40,
      attrs: { text: 'A', fontSize: 24, fill: '#111111' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    const node = doc.deltaSetLike!.t1 as SceneNodeInput;
    setTextOutlineMeshForTests(
      't1',
      node,
      'M 4 8 L 20 8 L 20 32 L 4 32 Z M 28 8 L 44 8 L 44 32 L 28 32 Z',
      { width: 80, height: 40 }
    );
    const kinds: number[] = [];
    const meshPos: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, meshPos, meshCol: [], meshClip: [] }
    );
    expect(kinds.some((k) => k === 3)).toBe(false);
    // Without MSDF glyph pack, no mesh/instance ink yet (pending async).
    expect(meshPos.length).toBe(0);
    expect(getTextOutlineMesh('t1', node, { width: 80, height: 40 })?.fill?.triangleCount ?? 0).toBeGreaterThan(
      0
    );
  });

  it('skips hiddenNodeId so inline edit is not double-drawn', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 't-edit', {
      id: 't-edit',
      key: 'text',
      x: 10,
      y: 10,
      width: 80,
      height: 40,
      attrs: { text: 'Hi', fontSize: 24, fill: '#111111' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    const node = doc.deltaSetLike!['t-edit'] as SceneNodeInput;
    setTextOutlineMeshForTests(
      't-edit',
      node,
      'M0 0H20V20H0Z',
      { width: 80, height: 40 }
    );
    setSceneCanvasIdlePaint({
      document: doc,
      canvasIds: ['t-edit'],
      hiddenNodeId: 't-edit',
      getNodeBox: () => null,
    });
    const meshPos: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      [],
      [],
      [],
      { document: doc, meshPos, meshCol: [], meshClip: [] }
    );
    expect(meshPos.length).toBe(0);
  });

  it('TEXT without mesh does not stamp soft atlas (MSDF packs async)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 't-blank', {
      id: 't-blank',
      key: 'text',
      x: 10,
      y: 10,
      width: 120,
      height: 40,
      attrs: { text: 'paste', fontSize: 18, fill: '#111111' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    const atlas = createSoaWebglAtlas(512, 128);
    if (!atlas) return;
    const kinds: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, atlas, meshPos: [], meshCol: [], meshClip: [] }
    );
    // Text forbids soft-atlas kind-3; glyphs appear when MSDF atlas packs.
    expect(kinds.some((k) => k === 3)).toBe(false);
  });

  it('keeps prior mesh visible when zoom LOD fingerprint changes (SWR)', () => {
    const node = {
      id: 't-swr',
      key: 'text',
      width: 80,
      height: 40,
      attrs: { text: 'Hi', fontSize: 20, fill: '#111' },
    } as SceneNodeInput;
    setTextOutlineMeshForTests(
      't-swr',
      node,
      'M0 0H20V20H0Z',
      { width: 80, height: 40, zoom: 1, dpr: 1 }
    );
    const stale = getTextOutlineMesh('t-swr', node, { width: 80, height: 40, zoom: 4, dpr: 1 });
    expect(stale?.fill?.triangleCount ?? 0).toBeGreaterThan(0);
  });
});
