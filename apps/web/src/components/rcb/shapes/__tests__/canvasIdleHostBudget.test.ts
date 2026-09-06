import { describe, expect, it } from 'vitest';
import { canIdlePaintOnCanvas, canvasIdleIsStrokeOnly, nodeNeedsDomShapeHost, pickFullAndCanvasIds } from '../RcbShapesLayer';
import { HEAVY_PATH_D_CHARS } from '@/components/rcb/scene/document/sceneShapes';
import type { SceneDocument } from '@/components/rcb/sceneNode';

function makeDoc(nodes: Record<string, any>): SceneDocument {
  const children = Object.keys(nodes);
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    deltaSetLike: {
      ROOT: { id: 'ROOT', key: 'entry', x: 0, y: 0, width: 0, height: 0, attrs: {}, children },
      ...nodes,
    },
  } as SceneDocument;
}

function rect(id: string, w = 40, h = 40) {
  return {
    id,
    key: 'shape',
    x: 0,
    y: 0,
    width: w,
    height: h,
    attrs: { shapeType: 'rect', 'fill-color': '#abc', 'stroke-enabled': false },
  };
}

function textNode(id: string) {
  return {
    id,
    key: 'text',
    x: 0,
    y: 0,
    width: 80,
    height: 24,
    attrs: {
      fontSize: 14,
      ORIGIN_DATA: JSON.stringify([{ children: [{ text: 'Hi' }] }]),
    },
  };
}

function imageNode(id: string) {
  return {
    id,
    key: 'image',
    x: 0,
    y: 0,
    width: 80,
    height: 60,
    attrs: { src: 'https://example.com/a.png' },
  };
}

function lightPen(id: string) {
  return {
    id,
    key: 'shape',
    x: 0,
    y: 0,
    width: 50,
    height: 20,
    attrs: { shapeType: 'pen', path: 'M0 10 L50 10', 'border-color': '#000', 'border-width': 2 },
  };
}

function heavy(id: string) {
  return {
    id,
    x: 0,
    y: 0,
    width: 40,
    height: 40,
    attrs: {
      shapeType: 'path',
      path: 'M0 0 ' + 'L1 1 '.repeat(HEAVY_PATH_D_CHARS),
    },
  };
}

describe('pickFullAndCanvasIds (single ink path)', () => {
  it('150 stroked rects stay on canvas ink (full-host ≈ 0)', () => {
    const nodes: Record<string, any> = {};
    for (let i = 0; i < 150; i += 1) {
      nodes[`s${i}`] = {
        id: `s${i}`,
        key: 'shape',
        x: (i % 15) * 50,
        y: Math.floor(i / 15) * 50,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'stroke-enabled': true,
          'border-color': '#111',
          'border-width': 2,
          strokeAlign: 'center',
          angle: i % 3 === 0 ? 12 : 0,
        },
      };
    }
    const doc = makeDoc(nodes);
    const ids = Object.keys(nodes);
    // Selection of light shapes must not promote DOM hosts.
    const selected = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ids,
      forceFullSet: new Set(ids.slice(0, 5)),
      zoom: 1,
    });
    // forceFullSet is SoftGlow/editors only in product; if misused for selection,
    // those five become hosts — assert the other 145 stay on canvas.
    expect(selected.fullIds.length).toBe(5);
    expect(selected.canvasIds.length).toBe(145);

    const idle = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ids,
      zoom: 1,
    });
    expect(idle.fullIds).toHaveLength(0);
    expect(idle.canvasIds).toHaveLength(150);
  });

  it('puts basic rects on canvas ink, not DOM hosts', () => {
    const nodes: Record<string, any> = {};
    for (let i = 0; i < 20; i += 1) nodes[`n${i}`] = rect(`n${i}`);
    const doc = makeDoc(nodes);
    const ids = Object.keys(nodes);
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ids,
      zoom: 1,
    });
    expect(fullIds).toHaveLength(0);
    expect(canvasIds).toHaveLength(20);
  });

  it('keeps media process hosts; static image/text and light pen on canvas ink', () => {
    const doc = makeDoc({
      t0: textNode('t0'),
      p0: lightPen('p0'),
      i0: imageNode('i0'),
    });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['t0', 'p0', 'i0'],
      zoom: 1,
      dpr: 1,
    });
    expect(fullIds).toEqual([]);
    expect(canvasIds.sort()).toEqual(['i0', 'p0', 't0']);
  });

  it('keeps large/zoomed idle images on canvas ink (restamp — never SharpHost)', () => {
    const large = {
      ...imageNode('big'),
      width: 600,
      height: 300,
    };
    const doc = makeDoc({ big: large, small: imageNode('small') });
    const at1x = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['big', 'small'],
      zoom: 1,
      dpr: 1,
    });
    expect(at1x.fullIds).toEqual([]);
    expect(at1x.canvasIds.sort()).toEqual(['big', 'small']);

    const zoomedSmall = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['small'],
      zoom: 8,
      dpr: 1,
    });
    expect(zoomedSmall.fullIds).toEqual([]);
    expect(zoomedSmall.canvasIds).toEqual(['small']);

    const retinaSmall = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['small'],
      zoom: 1,
      dpr: 8,
    });
    expect(retinaSmall.fullIds).toEqual([]);
    expect(retinaSmall.canvasIds).toEqual(['small']);
  });

  it('keeps idle image/video/audio generators on canvas ink (empty plate atlas bake)', () => {
    // Default spawn size is 360×360 — must stay under SoA (not sharp-host DOM),
    // or generators always paint above canvas rects and break stackOrder.
    const imgGen = {
      id: 'ig',
      key: 'image',
      x: 0,
      y: 0,
      width: 360,
      height: 360,
      attrs: { src: '', imageGenerator: true },
    };
    const vidGen = {
      id: 'vg',
      key: 'video',
      x: 0,
      y: 0,
      width: 640,
      height: 360,
      attrs: { src: '', videoGenerator: true },
    };
    const audGen = {
      id: 'ag',
      key: 'audio',
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      attrs: { audioGenerator: true },
    };
    const doc = makeDoc({ ig: imgGen, vg: vidGen, ag: audGen, i0: imageNode('i0') });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['ig', 'vg', 'ag', 'i0'],
      zoom: 1,
      dpr: 1,
    });
    expect(fullIds).toEqual(['ag']);
    expect(canvasIds.sort()).toEqual(['i0', 'ig', 'vg']);
    expect(canIdlePaintOnCanvas(imgGen as any)).toBe(true);
    expect(canIdlePaintOnCanvas(vidGen as any)).toBe(true);
    expect(canIdlePaintOnCanvas(audGen as any)).toBe(false);
  });

  it('forceFullSet keeps a canvas-ink node as a DOM host', () => {
    const nodes: Record<string, any> = {};
    for (let i = 0; i < 40; i += 1) nodes[`n${i}`] = rect(`n${i}`);
    const doc = makeDoc(nodes);
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: Object.keys(nodes),
      forceFullSet: new Set(['n0']),
      zoom: 0.15,
    });
    expect(fullIds).toEqual(['n0']);
    expect(canvasIds).not.toContain('n0');
    expect(canvasIds.length).toBe(39);
  });

  it('paintRaiseIds only force-host generators (world basics stay SoA under raise)', () => {
    const doc = makeDoc({ n0: rect('n0'), n1: rect('n1') });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['n0', 'n1'],
      paintRaiseIds: ['n0'],
      zoom: 1,
    });
    expect(fullIds).toEqual([]);
    expect(canvasIds.sort()).toEqual(['n0', 'n1']);
  });

  it('plate-bound paint raise / reveal leaves FO SoA for max+1 SVG host', () => {
    const bound = {
      ...rect('bound'),
      attrs: { ...rect('bound').attrs, frameId: 'board' },
    };
    const idle = {
      ...rect('idle'),
      attrs: { ...rect('idle').attrs, frameId: 'board' },
    };
    const doc = makeDoc({ bound, idle });
    doc.frames = [
      { id: 'board', name: 'A', backgroundColor: '#fff', x: 0, y: 0, width: 200, height: 200 },
    ];

    const raised = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['bound', 'idle'],
      paintRaiseIds: ['bound'],
      zoom: 1,
    });
    expect(raised.fullIds).toEqual(['bound']);
    expect(raised.canvasIds).toEqual(['idle']);

    // Multi-select: paint-raise empty, but overflow reveal still must host-raise.
    const revealed = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['bound', 'idle'],
      revealOverflowIds: ['bound'],
      zoom: 1,
    });
    expect(revealed.fullIds).toEqual(['bound']);
    expect(revealed.canvasIds).toEqual(['idle']);
  });

  it('world node above an artboard leaves SoA for shared data-z stacking', () => {
    const doc = makeDoc({ n0: rect('n0') });
    doc.frames = [
      { id: 'anim', name: 'Animation', backgroundColor: '#fff', x: 0, y: 0, width: 100, height: 100 },
    ];
    doc.stackOrder = ['frame:anim', 'node:n0'];
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['n0'],
      zoom: 1,
    });
    expect(fullIds).toEqual(['n0']);
    expect(canvasIds).toEqual([]);
  });

  it('holdHostIds keeps demote-candidate as DOM host', () => {
    const doc = makeDoc({ n0: rect('n0'), n1: rect('n1') });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['n0', 'n1'],
      zoom: 1,
      holdHostIds: new Set(['n0']),
    });
    expect(fullIds).toContain('n0');
    expect(canvasIds).toContain('n1');
    expect(canvasIds).not.toContain('n0');
  });

  it('caps canvas ink count when maxCanvasInk is set', () => {
    const nodes: Record<string, any> = {};
    for (let i = 0; i < 5000; i += 1) nodes[`n${i}`] = rect(`n${i}`);
    const doc = makeDoc(nodes);
    const ids = Object.keys(nodes);
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ids,
      zoom: 1,
      maxCanvasInk: 128,
    });
    expect(fullIds.length).toBe(0);
    expect(canvasIds.length).toBeLessThanOrEqual(128);
  });

  it('canvas-ink basic/poly/stroke/grad/text/image; DOM only when forceFull', () => {
    const doc = makeDoc({
      basic: rect('basic'),
      stroke: {
        id: 'stroke',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#abc',
          'stroke-enabled': true,
          'border-color': '#000',
          'border-width': 2,
          strokeAlign: 'center',
        },
      },
      grad: {
        id: 'grad',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-type': 'linear',
          'fill-gradient': '{}',
          'stroke-enabled': false,
        },
      },
      poly: {
        id: 'poly',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { shapeType: 'polygon', sides: 5, 'fill-color': '#abc', 'stroke-enabled': false },
      },
      t0: textNode('t0'),
      i0: imageNode('i0'),
    });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['basic', 'stroke', 'grad', 'poly', 't0', 'i0'],
      zoom: 1,
    });
    expect(canvasIds.sort()).toEqual(['basic', 'grad', 'i0', 'poly', 'stroke', 't0']);
    expect(fullIds).toEqual([]);
  });

  it('forceFull selected video stays DOM host; idle video on canvas poster', () => {
    const video = {
      id: 'v0',
      key: 'video',
      x: 0,
      y: 0,
      width: 160,
      height: 90,
      attrs: { src: 'https://example.com/a.mp4', poster: 'https://example.com/p.png' },
    };
    const doc = makeDoc({ v0: video, n0: rect('n0') });
    const idle = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['v0', 'n0'],
      zoom: 1,
    });
    expect(idle.fullIds).toEqual([]);
    expect(idle.canvasIds.sort()).toEqual(['n0', 'v0']);
    const selected = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['v0', 'n0'],
      forceFullSet: new Set(['v0']),
      zoom: 1,
    });
    expect(selected.fullIds).toEqual(['v0']);
    expect(selected.canvasIds).toEqual(['n0']);
  });

  it('forceFull selected audio stays DOM host; idle audio generator is always a host', () => {
    const audio = {
      id: 'a0',
      key: 'audio',
      x: 0,
      y: 0,
      width: 180,
      height: 100,
      attrs: { src: 'https://example.com/a.mp3', audioGenerator: true },
    };
    const doc = makeDoc({ a0: audio, n0: rect('n0') });
    const idle = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['a0', 'n0'],
      zoom: 1,
    });
    expect(idle.fullIds).toEqual(['a0']);
    expect(idle.canvasIds).toEqual(['n0']);
    const selected = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['a0', 'n0'],
      forceFullSet: new Set(['a0']),
      zoom: 1,
    });
    expect(selected.fullIds).toEqual(['a0']);
    expect(selected.canvasIds).toEqual(['n0']);
  });

  it('multi-select videos: only the active decoder is a DOM host', () => {
    const mkVideo = (id: string) => ({
      id,
      key: 'video',
      x: 0,
      y: 0,
      width: 160,
      height: 90,
      attrs: { src: `https://example.com/${id}.mp4` },
    });
    const doc = makeDoc({ v0: mkVideo('v0'), v1: mkVideo('v1'), n0: rect('n0') });
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['v0', 'v1', 'n0'],
      forceFullSet: new Set(['v1']),
      zoom: 1,
    });
    expect(fullIds).toEqual(['v1']);
    expect(canvasIds.sort()).toEqual(['n0', 'v0']);
  });

  it('heavy paths stay DOM hosts; idle images paint on canvas', () => {
    const nodes: Record<string, any> = {
      heavy: heavy('heavy'),
      big: rect('big', 400, 400),
    };
    for (let i = 0; i < 10; i += 1) nodes[`img${i}`] = imageNode(`img${i}`);
    const doc = makeDoc(nodes);
    const ids = Object.keys(nodes);
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ids,
      zoom: 1,
    });
    expect(fullIds).toContain('heavy');
    expect(fullIds).not.toContain('img0');
    // 400px < 512 atlas cell → stays on SoA ink (sharper bake, no SVG).
    expect(canvasIds).toContain('big');
    expect(canvasIds).toContain('img0');
  });
});

describe('canIdlePaintOnCanvas', () => {
  it('accepts solid rects and static text; rejects lottie', () => {
    expect(canIdlePaintOnCanvas(rect('n0'))).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        ...rect('framed'),
        attrs: { ...(rect('framed').attrs || {}), frameId: 'board', frameOrder: 0 },
      } as never)
    ).toBe(true);
    expect(canIdlePaintOnCanvas(textNode('t0'))).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'a0',
        key: 'audio',
        x: 0,
        y: 0,
        width: 120,
        height: 80,
        attrs: { audioGenerator: true },
      } as never)
    ).toBe(false);
    expect(
      canIdlePaintOnCanvas({
        id: 'l0',
        key: 'lottie',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {},
      } as never)
    ).toBe(false);
  });

  it('framed solid rects idle on ArtboardLayer ink (not full SVG hosts)', () => {
    const nodes: Record<string, any> = {
      framed: {
        ...rect('framed'),
        attrs: { ...(rect('framed').attrs || {}), frameId: 'board', frameOrder: 0 },
      },
    };
    const doc = makeDoc(nodes);
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
    ] as never;
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['framed'],
      zoom: 1,
    });
    expect(fullIds).not.toContain('framed');
    expect(canvasIds).toContain('framed');
  });

  it('framed large / arrow nodes stay on ArtboardLayer at any zoom (no z flip)', () => {
    const nodes: Record<string, any> = {
      big: {
        ...rect('big', 600, 600),
        attrs: { ...(rect('big', 600, 600).attrs || {}), frameId: 'board', frameOrder: 0 },
      },
      arrow: {
        id: 'arrow',
        key: 'shape',
        x: 0,
        y: 0,
        width: 80,
        height: 24,
        attrs: {
          shapeType: 'arrow',
          frameId: 'board',
          frameOrder: 1,
          'border-width': 2,
          stroke: '#333',
        },
      },
    };
    const doc = makeDoc(nodes);
    doc.frames = [
      {
        id: 'board',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 700,
        height: 700,
      },
    ] as never;
    for (const zoom of [0.25, 1, 4]) {
      const { fullIds, canvasIds } = pickFullAndCanvasIds({
        document: doc,
        visibleIds: ['big', 'arrow'],
        zoom,
        dpr: 2,
      });
      expect(fullIds).not.toContain('big');
      expect(fullIds).not.toContain('arrow');
      expect(canvasIds.sort()).toEqual(['arrow', 'big']);
    }
  });

  it('animation workbench: idle vectors stay on ArtboardLayer; lottie stays FO host', () => {
    const nodes: Record<string, any> = {
      ink: {
        ...rect('ink'),
        attrs: { ...(rect('ink').attrs || {}), frameId: 'lot', frameOrder: 0 },
      },
      nest: {
        id: 'nest',
        key: 'lottie',
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        attrs: { frameId: 'lot', frameOrder: 1, animationData: '{}' },
      },
    };
    const doc = makeDoc(nodes);
    doc.frames = [
      {
        id: 'lot',
        name: '动画工作台',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 364,
        height: 364,
        kind: 'animation',
      },
    ] as never;
    doc.stackOrder = ['frame:lot', 'node:ink', 'node:nest'];
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['ink', 'nest'],
      zoom: 1,
    });
    expect(fullIds).not.toContain('ink');
    expect(canvasIds).toContain('ink');
    expect(fullIds).toContain('nest');
    expect(canvasIds).not.toContain('nest');
    expect(nodeNeedsDomShapeHost(nodes.nest as never)).toBe(true);
    expect(nodeNeedsDomShapeHost(nodes.ink as never)).toBe(false);
  });

  it('canvasIdleIsStrokeOnly for stroke-only pens', () => {
    expect(canvasIdleIsStrokeOnly(lightPen('p0'))).toBe(true);
    expect(canvasIdleIsStrokeOnly(rect('n0'))).toBe(false);
  });

  it('evenodd paths and donut ellipses idle on canvas', () => {
    expect(
      canIdlePaintOnCanvas({
        id: 'bool',
        key: 'shape',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        attrs: {
          shapeType: 'path',
          path: 'M0 0 H100 V80 H0 Z M20 20 H80 V60 H20 Z',
          closed: 'true',
          'fill-rule': 'evenodd',
          'fill-color': '#ffffff',
        },
      } as never)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'donut',
        key: 'shape',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        attrs: { shapeType: 'ellipse', ellipseInnerRatio: 0.5, 'fill-color': '#ccc' },
      } as never)
    ).toBe(true);
  });

  it('outside/inside strokeAlign paint on canvas (no ShapeHost)', () => {
    expect(
      canIdlePaintOnCanvas({
        id: 'out',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'stroke-enabled': true,
          'border-width': 4,
          'border-color': '#000',
          strokeAlign: 'outside',
        },
      } as never)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'in',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'stroke-enabled': true,
          'border-width': 4,
          'border-color': '#000',
          strokeAlign: 'inside',
        },
      } as never)
    ).toBe(true);
  });

  it('object blur / inner-shadow / multiply blend idle on canvas; backdrop-blur stays DOM', () => {
    expect(
      canIdlePaintOnCanvas({
        id: 'blur',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { shapeType: 'rect', 'fill-color': '#fff', 'blur-enabled': true, 'blur-amount': 8 },
      } as never)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'inner',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'inner-shadow-enabled': true,
          'inner-shadow-visible': true,
          'inner-shadow-blur': 4,
          'inner-shadow-y': 2,
        },
      } as never)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'mul',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: { shapeType: 'rect', 'fill-color': '#f00', blendMode: 'multiply' },
      } as never)
    ).toBe(true);
    expect(
      canIdlePaintOnCanvas({
        id: 'bd',
        key: 'shape',
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        attrs: {
          shapeType: 'rect',
          'fill-color': '#fff',
          'backdrop-blur-enabled': true,
          'backdrop-blur-amount': 12,
        },
      } as never)
    ).toBe(false);
  });
});

