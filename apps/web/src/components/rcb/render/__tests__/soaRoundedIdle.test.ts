import { describe, expect, it } from 'vitest';
import { createEmptyDocument, addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  applySoaHostInkFlags,
  createSceneRenderBuffer,
  isSoaBasicGeomSufficient,
  isSoaCanvasEligible,
  setSoaWebglEnvEnabledForTests,
  syncSceneRenderBufferFromDocument,
  SOA_FLAG_ATLAS_STAMP,
  SOA_FLAG_BASIC_GEOM,
  SOA_FLAG_CANVAS_IDLE,
} from '../sceneRenderBuffer';
import { canIdlePaintOnCanvas } from '../sceneRenderer';

describe('SoA basic geom vs rounded / poly', () => {
  it('product WebGL: closed fills use BASIC_GEOM vector mesh (not ATLAS_STAMP)', () => {
    setSoaWebglEnvEnabledForTests(true);
    try {
      let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
      for (const [id, shapeType] of [
        ['r', 'rect'],
        ['e', 'ellipse'],
        ['p', 'polygon'],
        ['s', 'star'],
      ] as const) {
        doc = addNodeToDocument(doc, id, {
          id,
          key: 'shape',
          x: 0,
          y: 0,
          width: 80,
          height: 80,
          attrs: {
            shapeType,
            fill: '#ffffff',
            'fill-color': '#ffffff',
            'stroke-enabled': true,
            'border-width': 2,
            'border-color': '#000',
            sides: 5,
            points: 5,
          },
          children: [],
        });
      }
      const buf = createSceneRenderBuffer();
      syncSceneRenderBufferFromDocument(buf, doc);
      for (let i = 0; i < buf.count; i += 1) {
        const id = buf.ids[i]!;
        expect(isSoaBasicGeomSufficient(doc.deltaSetLike[id]), id).toBe(true);
        expect(buf.flags[i] & SOA_FLAG_BASIC_GEOM, id).toBeTruthy();
        expect(buf.flags[i] & SOA_FLAG_ATLAS_STAMP, id).toBe(0);
        expect(buf.flags[i] & SOA_FLAG_CANVAS_IDLE, id).toBeTruthy();
      }
    } finally {
      setSoaWebglEnvEnabledForTests(null);
    }
  });

  it('marks sharp solid rect as BASIC_GEOM', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'a', {
      id: 'a',
      key: 'shape',
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      attrs: {
        shapeType: 'rect',
        fill: '#ffffff',
        'fill-color': '#ffffff',
        'stroke-enabled': false,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.a)).toBe(true);
  });

  it('rounded solid rect is BASIC_GEOM and stores radii', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'r', {
      id: 'r',
      key: 'shape',
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      attrs: {
        shapeType: 'rect',
        fill: '#ffffff',
        'fill-color': '#ffffff',
        cornerRadius: 16,
        radiusLinked: true,
        'stroke-enabled': false,
      },
      children: [],
    });
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.r)).toBe(true);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.r)).toBe(true);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.radii[0]).toBeGreaterThan(0);
    expect(buf.radii[1]).toBeGreaterThan(0);
  });

  it('polygon path samples follow rounded baseline (vertex radii)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p', {
      id: 'p',
      key: 'shape',
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      attrs: {
        shapeType: 'polygon',
        sides: 5,
        cornerRadius: 12,
        radiusLinked: true,
        fill: '#fff',
        'fill-color': '#fff',
        'stroke-enabled': false,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.pathLen[0]).toBeGreaterThan(5);
  });

  it('angled line/arrow stay SoA-basic on Canvas2D test path', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'ln', {
      id: 'ln',
      key: 'shape',
      x: 0,
      y: 0,
      width: 120,
      height: 1,
      attrs: { shapeType: 'line', angle: 40, 'border-width': 2, 'border-color': '#111' },
      children: [],
    });
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.ln)).toBe(true);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.pathLen[0]).toBeGreaterThanOrEqual(2);
  });

  it('product WebGL: angled line/arrow stay BASIC_GEOM (crisp segments)', () => {
    setSoaWebglEnvEnabledForTests(true);
    try {
      let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
      doc = addNodeToDocument(doc, 'ln', {
        id: 'ln',
        key: 'shape',
        x: 0,
        y: 0,
        width: 120,
        height: 1,
        attrs: { shapeType: 'line', angle: 40, 'border-width': 2, 'border-color': '#111' },
        children: [],
      });
      expect(isSoaBasicGeomSufficient(doc.deltaSetLike.ln)).toBe(true);
      const buf = createSceneRenderBuffer();
      syncSceneRenderBufferFromDocument(buf, doc);
      expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
      expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    } finally {
      setSoaWebglEnvEnabledForTests(null);
    }
  });

  it('polygon is SoA-basic on Canvas2D path (samples into pathXY)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'p', {
      id: 'p',
      key: 'shape',
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      attrs: { shapeType: 'polygon', sides: 6, fill: '#fff', 'fill-color': '#fff', 'stroke-enabled': false },
      children: [],
    });
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.p)).toBe(true);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.p)).toBe(true);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.pathLen[0]).toBeGreaterThanOrEqual(3);
    expect(buf.pathClosed[0]).toBe(1);
  });

  it('center outline stroke on solid rect is SoA-basic', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 's', {
      id: 's',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      attrs: {
        shapeType: 'rect',
        fill: '#fff',
        'fill-color': '#fff',
        'stroke-enabled': true,
        'border-width': 2,
        'border-color': '#000',
        strokeAlign: 'center',
      },
      children: [],
    });
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.s)).toBe(true);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.strokeWidths[0]).toBe(2);
    expect(buf.strokeColors[0]).toBeTruthy();
  });

  it('flipped rect stays idle-capable but not SoA-basic', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'f', {
      id: 'f',
      key: 'shape',
      x: 0,
      y: 0,
      width: 40,
      height: 80,
      attrs: {
        shapeType: 'rect',
        fill: '#ffffff',
        'fill-color': '#ffffff',
        'stroke-enabled': false,
        flipX: 'true',
        angle: 90,
      },
      children: [],
    });
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.f)).toBe(true);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.f)).toBe(false);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeFalsy();
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeFalsy();
  });

  it('boolean evenodd / outlined idle on SoA basic (atlas stamp)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'b', {
      id: 'b',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      attrs: {
        shapeType: 'path',
        path: 'M0 0 H100 V80 H0 Z M20 20 H80 V60 H20 Z',
        closed: 'true',
        outlined: 'true',
        'fill-rule': 'evenodd',
        'fill-color': '#ffffff',
        'stroke-enabled': false,
      },
      children: [],
    });
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.b)).toBe(true);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.b)).toBe(true);
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(buf.flags[0] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.flags[0] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
  });

  it('gradient / text stay off SoA basic; image+gradient idle via atlas; outside-stroke enters basic idle', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    const cases: Array<{ id: string; node: Parameters<typeof addNodeToDocument>[2] }> = [
      {
        id: 'outside',
        node: {
          id: 'outside',
          key: 'shape',
          x: 0,
          y: 0,
          width: 40,
          height: 40,
          attrs: {
            shapeType: 'rect',
            fill: '#fff',
            'fill-color': '#fff',
            'stroke-enabled': true,
            'border-width': 2,
            'border-color': '#000',
            strokeAlign: 'outside',
          },
          children: [],
        },
      },
      {
        id: 'grad',
        node: {
          id: 'grad',
          key: 'shape',
          x: 50,
          y: 0,
          width: 40,
          height: 40,
          attrs: {
            shapeType: 'rect',
            'fill-type': 'linear',
            'fill-gradient': '{}',
            'stroke-enabled': false,
          },
          children: [],
        },
      },
      {
        id: 'txt',
        node: {
          id: 'txt',
          key: 'text',
          x: 150,
          y: 0,
          width: 80,
          height: 24,
          attrs: { fontSize: 14 },
          children: [],
        },
      },
      {
        id: 'img',
        node: {
          id: 'img',
          key: 'image',
          x: 240,
          y: 0,
          width: 64,
          height: 48,
          attrs: { src: 'https://example.com/a.png' },
          children: [],
        },
      },
    ];
    for (const c of cases) {
      doc = addNodeToDocument(doc, c.id, c.node);
    }
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.outside)).toBe(true);
    expect(buf.flags[buf.indexById.get('outside')!] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.flags[buf.indexById.get('outside')!] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.strokeWidths[buf.indexById.get('outside')!]).toBe(2);
    for (const id of ['grad'] as const) {
      const node = doc.deltaSetLike[id];
      expect(isSoaBasicGeomSufficient(node), id).toBe(false);
      const i = buf.indexById.get(id);
      expect(i).toBeDefined();
      expect(buf.flags[i!] & SOA_FLAG_BASIC_GEOM, id).toBeFalsy();
      // Rich fills idle via Canvas2D Path2D (CANVAS_IDLE), not BASIC_GEOM / ATLAS_STAMP.
      expect(buf.flags[i!] & SOA_FLAG_CANVAS_IDLE, id).toBeTruthy();
    }
    // Static image: atlas-stamp idle. Text: outline mesh. Both CANVAS_IDLE without BASIC_GEOM.
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.img)).toBe(false);
    const imgIdx = buf.indexById.get('img')!;
    expect(buf.flags[imgIdx] & SOA_FLAG_BASIC_GEOM).toBeFalsy();
    expect(buf.flags[imgIdx] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.txt)).toBe(false);
    const txtIdx = buf.indexById.get('txt')!;
    expect(buf.flags[txtIdx] & SOA_FLAG_BASIC_GEOM).toBeFalsy();
    expect(buf.flags[txtIdx] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(isSoaCanvasEligible(doc.deltaSetLike.outside)).toBe(true);
    expect(isSoaCanvasEligible(doc.deltaSetLike.grad)).toBe(true);
    expect(isSoaCanvasEligible(doc.deltaSetLike.txt)).toBe(true);
    expect(isSoaCanvasEligible(doc.deltaSetLike.img)).toBe(true);
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.outside)).toBe(true);
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.grad)).toBe(true);
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.txt)).toBe(true);
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.img)).toBe(true);
  });

  it('donut ellipse stays BASIC_GEOM + SoA idle (mesh hole path)', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'donut', {
      id: 'donut',
      key: 'shape',
      x: 0,
      y: 0,
      width: 80,
      height: 80,
      attrs: {
        shapeType: 'ellipse',
        'fill-color': '#0cf',
        ellipseInnerRatio: 0.4,
        'stroke-enabled': false,
      },
      children: [],
    });
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.donut)).toBe(true);
    const i = buf.indexById.get('donut')!;
    expect(buf.flags[i] & SOA_FLAG_BASIC_GEOM).toBeTruthy();
    expect(buf.flags[i] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    // Host-flag sync must not strip idle ink (previously left empty selection box).
    applySoaHostInkFlags(buf, new Set());
    expect(buf.flags[i] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
  });

  it('pencil freehand is BASIC_GEOM vector mesh (not atlas stamp)', () => {
    let doc = createEmptyDocument({ width: 400, height: 400, emptyWorld: true });
    doc = addNodeToDocument(doc, 'pen', {
      id: 'pen',
      key: 'shape',
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      attrs: {
        shapeType: 'pencil',
        path: 'M0 20 L100 20',
        'border-color': '#111',
        'border-width': 8,
        brushStyle: 'vector-ink',
      },
      children: [],
    });
    expect(isSoaBasicGeomSufficient(doc.deltaSetLike.pen)).toBe(true);
    expect(canIdlePaintOnCanvas(doc.deltaSetLike.pen)).toBe(true);
  });
});
