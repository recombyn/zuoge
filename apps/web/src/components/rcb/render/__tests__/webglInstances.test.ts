import { describe, expect, it } from 'vitest';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';
import { setSelectionPaintRaiseIds } from '@/components/rcb/selection/selectionPaintRaise';
import {
  createSceneRenderBuffer,
  rebuildSoaPathSamples,
  syncSceneRenderBufferFromDocument,
  setSoaWebglEnvEnabledForTests,
  SOA_FLAG_ATLAS_STAMP,
  SOA_FLAG_BASIC_GEOM,
  SOA_FLAG_CANVAS_IDLE,
} from '../sceneRenderBuffer';
import {
  collectSoaWebglInstances,
  SOA_WEBGL_NO_CLIP,
} from '../webglSceneRenderer';
import { createSoaWebglAtlas } from '../webglInstanceAtlas';
import { getOrBuildShapeMesh } from '../vector/meshCache';

describe('collectSoaWebglInstances', () => {
  it('packs rect and ellipse as vector meshes in view', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      attrs: { shapeType: 'rect', 'fill-color': '#ff0000', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'e', {
      id: 'e',
      key: 'shape',
      x: 20,
      y: 0,
      width: 10,
      height: 10,
      attrs: { shapeType: 'ellipse', 'fill-color': '#00ff00', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'far', {
      id: 'far',
      key: 'shape',
      x: 9000,
      y: 9000,
      width: 10,
      height: 10,
      attrs: { shapeType: 'rect', 'fill-color': '#0000ff', 'stroke-enabled': false },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    const rects: number[] = [];
    const colors: number[] = [];
    const kinds: number[] = [];
    const angles: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      rects,
      colors,
      kinds,
      angles,
      [],
      { document: doc, meshPos, meshCol, meshClip }
    );
    // Closed fills → mesh triangles (no atlas kind 3).
    expect(kinds.length).toBe(0);
    expect(meshPos.length).toBeGreaterThanOrEqual(12);
    expect(meshCol.length).toBe(meshPos.length * 2);
  });

  it('packs stroke-disabled sharp rect as mesh when mesh buffers provided', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      attrs: {
        shapeType: 'rect',
        'fill-color': '#ff0000',
        'stroke-enabled': false,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kindsFallback: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      [],
      [],
      kindsFallback,
      [],
      [],
      { document: doc }
    );
    // Without mesh buffers: sharp rect/ellipse instance fallback (kind 0).
    expect(kindsFallback).toEqual([0]);
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 100, height: 100 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds).toEqual([]);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('packs rounded rect as vector mesh (no rich: atlas)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      attrs: {
        shapeType: 'rect',
        'fill-color': '#ffffff',
        cornerRadius: 20,
        'stroke-enabled': false,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const atlas = createSoaWebglAtlas(512, 128);
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, [], [], kinds, [], [], {
      atlas,
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds).toEqual([]);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
    if (atlas) {
      expect([...atlas.regions.keys()].some((k) => k.startsWith('rich:'))).toBe(false);
    }
  });

  it('packs line as stroke mesh when mesh buffers provided', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'ln', {
      id: 'ln',
      key: 'shape',
      x: 0,
      y: 0,
      width: 30,
      height: 40,
      attrs: { shapeType: 'line', stroke: '#111111', 'border-width': 2 },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const rects: number[] = [];
    const colors: number[] = [];
    const kinds: number[] = [];
    const angles: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, rects, colors, kinds, angles, [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds.length).toBe(0);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('packs line as kind 2 segments without mesh buffers', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'ln', {
      id: 'ln',
      key: 'shape',
      x: 0,
      y: 0,
      width: 30,
      height: 40,
      attrs: { shapeType: 'line', stroke: '#111111', 'border-width': 2 },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const rects: number[] = [];
    const colors: number[] = [];
    const kinds: number[] = [];
    const angles: number[] = [];
    // No document → mesh branch skipped; pathXY segment fallback still emits kind 2.
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, rects, colors, kinds, angles);
    expect(kinds).toEqual([2]);
    expect(rects[2]).toBeGreaterThan(0);
    expect(Number.isFinite(angles[0])).toBe(true);
  });

  it('arrows use BASIC_GEOM + stroke mesh (no rich: atlas)', () => {
    setSoaWebglEnvEnabledForTests(true);
    try {
      let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
      doc = addNodeToDocument(doc, 'ar', {
        id: 'ar',
        key: 'shape',
        x: 10,
        y: 10,
        width: 80,
        height: 24,
        attrs: { shapeType: 'arrow', stroke: '#111111', 'border-width': 4 },
        children: [],
      });
      const buf = createSceneRenderBuffer();
      syncSceneRenderBufferFromDocument(buf, doc);
      rebuildSoaPathSamples(buf, doc);
      expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
      buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
      const atlas = createSoaWebglAtlas(512, 128);
      const kinds: number[] = [];
      const meshPos: number[] = [];
      const meshCol: number[] = [];
      const meshClip: number[] = [];
      collectSoaWebglInstances(
        buf,
        { x: 0, y: 0, width: 200, height: 200 },
        [],
        [],
        kinds,
        [],
        [],
        { atlas, document: doc, meshPos, meshCol, meshClip }
      );
      expect(kinds.some((k) => k === 3)).toBe(false);
      expect(meshPos.length).toBeGreaterThanOrEqual(6);
      if (atlas) {
        expect([...atlas.regions.keys()].some((k) => k.startsWith('rich:ar'))).toBe(false);
      }
    } finally {
      setSoaWebglEnvEnabledForTests(null);
    }
  });

  it('uses document border-width for line stroke mesh', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'ln', {
      id: 'ln',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 0,
      attrs: { shapeType: 'line', stroke: '#111111', 'border-width': 6 },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    expect(buf.strokeWidths[0]).toBe(6);
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 100, height: 100 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds.length).toBe(0);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('packs open pen stroke as vector mesh (not segment instances)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p', {
      id: 'p',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: { shapeType: 'pen', path: 'M 0 0 L 10 0 L 10 10', stroke: '#000', 'border-width': 2 },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds.length).toBe(0);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('open pen stroke mesh uses strokeColors when fill colors is 0', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p', {
      id: 'p',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'pen',
        path: 'M 0 0 L 40 0 L 40 40',
        stroke: '#112233',
        'border-color': '#112233',
        'border-width': 2,
        'fill-color': 'transparent',
        closed: 'false',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    expect(buf.colors[0]).toBe(0);
    expect(buf.strokeColors[0]).toBeTruthy();
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
    });
    expect(kinds.length).toBe(0);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
    expect(meshCol[3]).toBeGreaterThan(0.9);
  });

  it('submits default 1px stroke ribbon at 100% zoom (mesh still geometric)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p', {
      id: 'p',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'pen',
        path: 'M 0 0 L 40 0 L 40 40',
        stroke: '#112233',
        'border-color': '#112233',
        'border-width': 1,
        'fill-color': 'transparent',
        closed: 'false',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
      zoom: 1,
      dpr: 1,
    });
    // Default 1p @ 100% must remain visible in the main world.
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
    expect(meshCol[3]).toBeGreaterThan(0.9);
    const cached = getOrBuildShapeMesh('p', doc.deltaSetLike!.p!, {
      width: 100,
      height: 100,
      zoom: 1,
      dpr: 1,
    });
    expect(cached?.stroke).not.toBeNull();
    expect(cached!.stroke!.triangleCount).toBeGreaterThan(0);
  });

  it('applies coverage alpha for zoomed-out 1px strokes (Skia-style)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p2', {
      id: 'p2',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'pen',
        path: 'M 0 0 L 40 0 L 40 40',
        stroke: '#112233',
        'border-color': '#112233',
        'border-width': 1,
        'fill-color': 'transparent',
        closed: 'false',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(buf, { x: 0, y: 0, width: 200, height: 200 }, [], [], kinds, [], [], {
      document: doc,
      meshPos,
      meshCol,
      meshClip,
      zoom: 0.25,
      dpr: 1,
    });
    // screenW = 0.25 → hairline submits with alphaScale 0.25
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
    expect(Number(meshCol[3])).toBeCloseTo(0.25, 2);
  });

  it('closed stroked path uses vector mesh (no atlas kind 3 / no segment notches)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'b', {
      id: 'b',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      attrs: {
        shapeType: 'path',
        path: 'M0 0 H100 V80 H0 Z',
        closed: 'true',
        'fill-color': '#ffffff',
        'fill-rule': 'evenodd',
        'stroke-enabled': true,
        'border-width': 4,
        'border-color': '#111111',
        stroke: '#111111',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    rebuildSoaPathSamples(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 200, height: 200 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, meshPos, meshCol, meshClip }
    );
    expect(kinds.includes(3)).toBe(false);
    expect(kinds.some((k) => k === 2)).toBe(false);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('skips stroke-only segment fallback for closed pens without mesh', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'pen', {
      id: 'pen',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      attrs: {
        shapeType: 'pen',
        path: 'M 10 10 L 90 10 L 50 90 Z',
        closed: 'true',
        fill: '#8b1a1a',
        'fill-color': '#8b1a1a',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    expect(buf.pathClosed[0]).toBe(1);
    expect(buf.colors[0]).toBeTruthy();
    buf.positions[0] = 0;
    buf.positions[1] = 0;
    const kinds: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 200, height: 200 },
      [],
      [],
      kinds,
      [],
      []
    );
    // Prefer invisible idle over border-only ghost when mesh buffers unavailable.
    expect(kinds).toEqual([]);
  });

  it('paints back-to-front by stackOrder and selection max+1 raise', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'back', {
      id: 'back',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: { shapeType: 'rect', 'fill-color': '#ff0000', 'stroke-enabled': false },
      children: [],
    });
    doc = addNodeToDocument(doc, 'front', {
      id: 'front',
      key: 'shape',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      attrs: { shapeType: 'rect', 'fill-color': '#00ff00', 'stroke-enabled': false },
      children: [],
    });
    // Permanent order: front under back (back on top).
    doc.stackOrder = ['node:front', 'node:back'];
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    for (let i = 0; i < buf.count; i += 1) {
      buf.flags[i] = (buf.flags[i] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    }
    expect(buf.count).toBe(2);
    expect(buf.ids.slice(0, 2).sort()).toEqual(['back', 'front']);
    const rects: number[] = [];
    const kinds: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      rects,
      [],
      kinds,
      [],
      [],
      { document: doc }
    );
    // Without mesh: BASIC rects as kind 0 instances, paint order preserved.
    expect(kinds).toEqual([0, 0]);
    // Last instance wins — back (0,0) must paint after front (10,10).
    expect(rects.slice(-4, -2)).toEqual([0, 0]);

    setSelectionPaintRaiseIds(['front']);
    const raisedRects: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      raisedRects,
      [],
      [],
      [],
      [],
      { document: doc }
    );
    setSelectionPaintRaiseIds(null);
    // Raised front (10,10) paints last despite permanent stackOrder.
    expect(raisedRects.slice(-4, -2)).toEqual([10, 10]);
  });

  it('packs clipContent LTRB for frame-owned idle slots', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = {
      ...doc,
      frames: [{ id: 'f1', x: 100, y: 50, width: 200, height: 150, clipContent: true }],
    };
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      attrs: { shapeType: 'rect', 'fill-color': '#ff0000', frameId: 'f1' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const atlas = createSoaWebglAtlas(512, 128);
    // happy-dom/jsdom often lacks a usable 2d atlas surface — skip collect asserts.
    if (!atlas) return;
    const clips: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      [],
      [],
      [],
      { atlas, clips, document: doc }
    );
    expect(clips).toEqual([100, 50, 300, 200]);
  });

  it('uses open clip when clipContent is off', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = {
      ...doc,
      frames: [{ id: 'f1', x: 100, y: 50, width: 200, height: 150, clipContent: false }],
    };
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 10,
      y: 10,
      width: 40,
      height: 40,
      attrs: { shapeType: 'rect', 'fill-color': '#ff0000', frameId: 'f1' },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const atlas = createSoaWebglAtlas(512, 128);
    // happy-dom/jsdom often lacks a usable 2d atlas surface — skip collect asserts.
    if (!atlas) return;
    const clips: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 800, height: 600 },
      [],
      [],
      [],
      [],
      [],
      { atlas, clips, document: doc }
    );
    expect(clips).toEqual([
      SOA_WEBGL_NO_CLIP[0],
      SOA_WEBGL_NO_CLIP[1],
      SOA_WEBGL_NO_CLIP[2],
      SOA_WEBGL_NO_CLIP[3],
    ]);
  });

  it('packs sharp stroked rect as mesh at low zoom (no atlas kind 3)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: {
        shapeType: 'rect',
        'fill-color': '#ff0000',
        'stroke-enabled': true,
        'border-width': 2,
        'border-color': '#000000',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, zoom: 0.25, meshPos, meshCol, meshClip }
    );
    expect(kinds).toEqual([]);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });

  it('packs rounded stroked rect as mesh at low zoom (no atlas kind 3)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: {
        shapeType: 'rect',
        'fill-color': '#ff0000',
        cornerRadius: 8,
        'stroke-enabled': true,
        'border-width': 2,
        'border-color': '#000000',
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    buf.flags[0] = (buf.flags[0] | SOA_FLAG_CANVAS_IDLE) >>> 0;
    const kinds: number[] = [];
    const meshPos: number[] = [];
    const meshCol: number[] = [];
    const meshClip: number[] = [];
    collectSoaWebglInstances(
      buf,
      { x: 0, y: 0, width: 100, height: 100 },
      [],
      [],
      kinds,
      [],
      [],
      { document: doc, zoom: 0.25, meshPos, meshCol, meshClip }
    );
    expect(kinds).toEqual([]);
    expect(meshPos.length).toBeGreaterThanOrEqual(6);
  });
});
