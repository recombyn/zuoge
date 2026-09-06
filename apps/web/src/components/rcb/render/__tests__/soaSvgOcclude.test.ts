import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createEmptyDocument,
  addNodeToDocument,
  stackNodeKey,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  createSceneRenderBuffer,
  paintSoaBufferBasic,
  syncSceneRenderBufferFromDocument,
  applySoaHostInkFlags,
  SOA_FLAG_CANVAS_IDLE,
} from '../sceneRenderBuffer';
import { clearShapeHosts, registerShapeHost } from '@/components/rcb/shapes/shapeHostRegistry';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { pickFullAndCanvasIds, nodeNeedsDomShapeHost } from '@/components/rcb/shapes/RcbShapesLayer';
import { setSelectionPaintRaiseIds } from '@/components/rcb/selection/selectionPaintRaise';

function whiteRect(id: string, x: number, y: number) {
  return {
    id,
    key: 'shape',
    x,
    y,
    width: 100,
    height: 100,
    attrs: {
      shapeType: 'rect',
      fill: '#ffffff',
      'fill-color': '#ffffff',
      'stroke-enabled': false,
    },
    children: [],
  };
}

function mockCtx(opts?: {
  onFillRect?: (x: number, y: number, w: number, h: number) => void;
  onClip?: (rule?: string) => void;
}) {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    clip: vi.fn((rule?: string) => {
      opts?.onClip?.(rule);
    }),
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      opts?.onFillRect?.(x, y, w, h);
    }),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    ellipse: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    set fillStyle(_v: string) {},
    set strokeStyle(_v: string) {},
    set lineWidth(_v: number) {},
    set lineJoin(_v: string) {},
    set lineCap(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
}

describe('SoA canvas ink (single surface)', () => {
  afterEach(() => {
    clearShapeHosts();
    clearNodeTransformPreviews();
  });

  it('basic rects and static text use canvas ink; lottie needs DOM host', () => {
    expect(nodeNeedsDomShapeHost(whiteRect('r', 0, 0) as never)).toBe(false);
    expect(
      nodeNeedsDomShapeHost({
        id: 't',
        key: 'text',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        attrs: {},
        children: [],
      } as never)
    ).toBe(false);
    expect(
      nodeNeedsDomShapeHost({
        id: 'l',
        key: 'lottie',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        attrs: {},
        children: [],
      } as never)
    ).toBe(true);
  });

  it('overlapping vectors stay on canvasIds; forceFull is the only host escape', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'back', whiteRect('back', 0, 0));
    doc = addNodeToDocument(doc, 'front', whiteRect('front', 40, 40));
    doc = {
      ...doc,
      stackOrder: [stackNodeKey('back'), stackNodeKey('front')],
    };
    const { fullIds, canvasIds } = pickFullAndCanvasIds({
      document: doc,
      visibleIds: ['back', 'front'],
      forceFullSet: new Set(['front']),
      zoom: 1,
    });
    expect(fullIds).toEqual(['front']);
    expect(canvasIds).toEqual(['back']);
  });

  it('paints back-to-front without evenodd clip holes', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'back', whiteRect('back', 0, 0));
    doc = addNodeToDocument(doc, 'front', whiteRect('front', 40, 40));
    doc = {
      ...doc,
      stackOrder: [stackNodeKey('back'), stackNodeKey('front')],
    };
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    applySoaHostInkFlags(buf, new Set());
    expect(buf.flags[buf.indexById.get('back')!] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();
    expect(buf.flags[buf.indexById.get('front')!] & SOA_FLAG_CANVAS_IDLE).toBeTruthy();

    let clipRule: string | undefined;
    const fillOrder: string[] = [];
    const ctx = mockCtx({
      onFillRect: (x) => {
        fillOrder.push(Math.abs(x - 40) < 0.1 ? 'front' : 'back');
      },
      onClip: (rule) => {
        clipRule = rule;
      },
    });
    paintSoaBufferBasic(ctx, buf, { left: 0, top: 0, width: 800, height: 600 }, { document: doc });
    expect(fillOrder).toEqual(['back', 'front']);
    expect(clipRule).toBeUndefined();
  });

  it('paints selection-reveal ink after higher stack siblings', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'back', whiteRect('back', 0, 0));
    doc = addNodeToDocument(doc, 'front', whiteRect('front', 40, 40));
    doc = {
      ...doc,
      stackOrder: [stackNodeKey('back'), stackNodeKey('front')],
    };
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    applySoaHostInkFlags(buf, new Set());
    setSelectionPaintRaiseIds(['back']);
    const fillOrder: string[] = [];
    const ctx = mockCtx({
      onFillRect: (x) => {
        fillOrder.push(Math.abs(x - 40) < 0.1 ? 'front' : 'back');
      },
    });
    try {
      paintSoaBufferBasic(ctx, buf, { left: 0, top: 0, width: 800, height: 600 }, { document: doc });
      // Selected (back) paints last so it is not covered by front.
      expect(fillOrder).toEqual(['front', 'back']);
    } finally {
      setSelectionPaintRaiseIds(null);
    }
  });

  it('skips SoA paint when a live DOM host owns the node', () => {
    let doc = createEmptyDocument({ width: 800, height: 600, emptyWorld: true });
    doc = addNodeToDocument(doc, 'live', whiteRect('live', 10, 10));
    const buf = createSceneRenderBuffer();
    syncSceneRenderBufferFromDocument(buf, doc);
    const hostEl = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    registerShapeHost({
      nodeId: 'live',
      root: hostEl as unknown as SVGSVGElement,
      layer: hostEl as unknown as SVGGElement,
      el: hostEl,
      kind: 'svg',
    });
    const fillRects: number[][] = [];
    const ctx = mockCtx({
      onFillRect: (x, y, w, h) => fillRects.push([x, y, w, h]),
    });
    paintSoaBufferBasic(
      ctx as unknown as CanvasRenderingContext2D,
      buf,
      { left: 0, top: 0, width: 800, height: 600 },
      { document: doc }
    );
    expect(fillRects.length).toBe(0);
  });
});
