import { describe, expect, it } from 'vitest';
import {
  listHigherArtboardOccluderBoxes,
  isNodeAabbFullyOccludedByHigherArtboard,
} from '../sceneHitBridge';
import {
  addNodeToDocument,
  createBareDocument,
} from '../sceneDocument';
import { setSelectionPaintRaiseFrameIds } from '@/components/rcb/selection/selectionPaintRaise';

describe('higher artboard paint occlusion', () => {
  it('lists plates above an unbound world node', () => {
    let doc = createBareDocument();
    doc = addNodeToDocument(doc, 'rect', {
      id: 'rect',
      key: 'rect',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      attrs: {},
      children: [],
    });
    doc.frames = [
      {
        id: 'board',
        name: '动画工作台',
        backgroundColor: '#fff',
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        kind: 'animation',
      },
    ];
    doc.stackOrder = ['node:rect', 'frame:board'];
    const holes = listHigherArtboardOccluderBoxes(doc, doc.deltaSetLike.rect);
    expect(holes).toHaveLength(1);
    expect(holes[0]).toEqual({ left: 50, top: 50, right: 150, bottom: 150 });
    expect(
      isNodeAabbFullyOccludedByHigherArtboard(doc, doc.deltaSetLike.rect, {
        left: 60,
        top: 60,
        width: 20,
        height: 20,
      })
    ).toBe(true);
    expect(
      isNodeAabbFullyOccludedByHigherArtboard(doc, doc.deltaSetLike.rect, {
        left: 0,
        top: 0,
        width: 200,
        height: 200,
      })
    ).toBe(false);
  });

  it('does not occlude frame-bound children (they paint above their plate)', () => {
    let doc = createBareDocument();
    doc.frames = [
      {
        id: 'board',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    ];
    doc.stackOrder = ['frame:board'];
    doc = addNodeToDocument(doc, 'child', {
      id: 'child',
      key: 'rect',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      attrs: { frameId: 'board' },
      children: [],
    });
    expect(listHigherArtboardOccluderBoxes(doc, doc.deltaSetLike.child)).toEqual([]);
  });

  it('frame-bound child is still occluded by a later artboard', () => {
    let doc = createBareDocument();
    doc.frames = [
      {
        id: 'a',
        name: 'A',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      {
        id: 'b',
        name: '动画',
        backgroundColor: '#eee',
        x: 20,
        y: 20,
        width: 80,
        height: 80,
        kind: 'animation',
      },
    ];
    doc.stackOrder = ['frame:a', 'node:child', 'frame:b'];
    doc = addNodeToDocument(doc, 'child', {
      id: 'child',
      key: 'rect',
      x: 30,
      y: 30,
      width: 40,
      height: 40,
      attrs: { frameId: 'a' },
      children: [],
    });
    const holes = listHigherArtboardOccluderBoxes(doc, doc.deltaSetLike.child);
    expect(holes).toHaveLength(1);
    expect(holes[0]).toEqual({ left: 20, top: 20, right: 100, bottom: 100 });
  });

  it('selection-raised frame occludes world nodes even when they stack above', () => {
    let doc = createBareDocument();
    doc = addNodeToDocument(doc, 'rect', {
      id: 'rect',
      key: 'rect',
      x: 0,
      y: 0,
      width: 200,
      height: 200,
      attrs: {},
      children: [],
    });
    doc.frames = [
      {
        id: 'board',
        name: '动画工作台',
        backgroundColor: '#fff',
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        kind: 'animation',
      },
    ];
    // World node above the plate in stackOrder (would cover without select raise).
    doc.stackOrder = ['frame:board', 'node:rect'];
    expect(listHigherArtboardOccluderBoxes(doc, doc.deltaSetLike.rect)).toEqual([]);

    setSelectionPaintRaiseFrameIds(['board']);
    try {
      const holes = listHigherArtboardOccluderBoxes(doc, doc.deltaSetLike.rect);
      expect(holes).toHaveLength(1);
      expect(
        isNodeAabbFullyOccludedByHigherArtboard(doc, doc.deltaSetLike.rect, {
          left: 60,
          top: 60,
          width: 20,
          height: 20,
        })
      ).toBe(true);
    } finally {
      setSelectionPaintRaiseFrameIds(null);
    }
  });

  it('outlined boolean under a later artboard is fully occluded for host clip', () => {
    let doc = createBareDocument();
    doc = addNodeToDocument(doc, 'bool', {
      id: 'bool',
      key: 'shape',
      x: 40,
      y: 40,
      width: 200,
      height: 200,
      attrs: {
        shapeType: 'path',
        path: 'M0 0 H200 V200 H0 Z M40 40 H160 V160 H40 Z',
        closed: 'true',
        outlined: 'true',
        'fill-rule': 'evenodd',
        'fill-color': '#ffffff',
      },
      children: [],
    });
    doc.frames = [
      {
        id: 'board',
        name: '动画工作台',
        backgroundColor: '#fff',
        x: 0,
        y: 0,
        width: 364,
        height: 364,
        kind: 'animation',
      },
    ];
    doc.stackOrder = ['node:bool', 'frame:board'];
    expect(
      isNodeAabbFullyOccludedByHigherArtboard(doc, doc.deltaSetLike.bool, {
        left: 40,
        top: 40,
        width: 200,
        height: 200,
      })
    ).toBe(true);
  });
});
