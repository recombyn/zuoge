import { describe, expect, it, beforeEach } from 'vitest';
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
  });

  it('shapeInkForbidsAtlas includes text', () => {
    expect(shapeInkForbidsAtlas({ key: 'text', attrs: {} })).toBe(true);
  });

  it('TEXT collect draws mesh when outline ready (no atlas kind 3)', () => {
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
    // After sync (invalidates caches) — inject ready outline mesh.
    setTextOutlineMeshForTests(
      't1',
      node,
      'M 4 8 L 20 8 L 20 32 L 4 32 Z M 28 8 L 44 8 L 44 32 L 28 32 Z',
      { width: 80, height: 40 }
    );
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, meshPos, meshCol, meshClip }
    );
    expect(kinds.some((k) => k === 3)).toBe(false);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
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
