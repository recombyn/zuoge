import { describe, expect, it } from 'vitest';
import { shouldRevealShapeOverflow } from '../RcbShapesLayer';
import { findClippingFrameForNode } from '@/components/rcb/frames/frameContentClip';
import {
  frameClipRevealsOverflow,
  hasFrameClipRevealOverflow,
  hasSelectionPaintRaise,
  listSelectionRevealOverflowIds,
  setFrameClipRevealOverflowIds,
  setSelectionPaintRaiseIds,
} from '@/components/rcb/selection/selectionPaintRaise';

describe('shouldRevealShapeOverflow', () => {
  it('keeps clip for plain selection; reveals only SoftGlow / process', () => {
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'n1',
        key: 'image',
        attrs: {},
      })
    ).toBe(false);
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'n1',
        key: 'shape',
        attrs: { frameId: 'f1' },
      })
    ).toBe(false);
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'load',
        key: 'image',
        attrs: {
          frameId: 'f1',
          processStatus: 'running',
          processKind: 'removeBg',
          processLabel: 'Removing background...',
        },
      })
    ).toBe(true);
    expect(
      shouldRevealShapeOverflow(false, {
        id: 'n1',
        key: 'image',
        attrs: {},
      })
    ).toBe(false);
  });

  it('keeps frame clip for video/audio even when forceFull / selected', () => {
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'v1',
        key: 'video',
        attrs: { frameId: 'f1', src: 'https://example.com/a.mp4' },
      })
    ).toBe(false);
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'a1',
        key: 'audio',
        attrs: { frameId: 'f1', src: 'https://example.com/a.mp3' },
      })
    ).toBe(false);
    expect(
      shouldRevealShapeOverflow(true, {
        id: 'v-glow',
        key: 'video',
        attrs: {
          frameId: 'f1',
          src: 'https://example.com/a.mp4',
          processStatus: 'running',
          processKind: 'removeBg',
        },
      })
    ).toBe(true);
  });

  it('frame-selected children stay clipped (reveal flag false)', () => {
    expect(
      shouldRevealShapeOverflow(false, {
        id: 'child',
        key: 'shape',
        attrs: { frameId: 'f1', shapeType: 'pen' },
      })
    ).toBe(false);
  });
});

describe('findClippingFrameForNode still owns clip outside plate AABB', () => {
  it('returns the owning clipContent frame when the node is fully outside', () => {
    const doc = {
      frames: [{ id: 'f1', x: 0, y: 0, width: 100, height: 100, clipContent: true }],
    };
    const frame = findClippingFrameForNode(doc, {
      id: 'n1',
      x: 400,
      y: 400,
      width: 40,
      height: 40,
      attrs: { frameId: 'f1' },
    });
    expect(frame?.id).toBe('f1');
  });
});

describe('frameClip reveal-overflow registry', () => {
  it('marks ids so canvas ink can skip artboard clip when set', () => {
    setFrameClipRevealOverflowIds(['a', 'b']);
    expect(frameClipRevealsOverflow('a')).toBe(true);
    expect(frameClipRevealsOverflow('c')).toBe(false);
    setFrameClipRevealOverflowIds(null);
    expect(frameClipRevealsOverflow('a')).toBe(false);
  });

  it('hasFrameClipRevealOverflow tracks whether any reveal is active', () => {
    setFrameClipRevealOverflowIds(null);
    expect(hasFrameClipRevealOverflow()).toBe(false);
    setFrameClipRevealOverflowIds(['sel']);
    expect(hasFrameClipRevealOverflow()).toBe(true);
    setFrameClipRevealOverflowIds([]);
    expect(hasFrameClipRevealOverflow()).toBe(false);
  });

  it('hasSelectionPaintRaise tracks temporary max+1 raise', () => {
    setSelectionPaintRaiseIds(null);
    expect(hasSelectionPaintRaise()).toBe(false);
    setSelectionPaintRaiseIds(['back']);
    expect(hasSelectionPaintRaise()).toBe(true);
    setSelectionPaintRaiseIds([]);
    expect(hasSelectionPaintRaise()).toBe(false);
  });
});

describe('listSelectionRevealOverflowIds', () => {
  const doc = {
    deltaSetLike: {
      inside: { attrs: { frameId: 'board' } },
      world: { attrs: {} },
      other: { attrs: { frameId: 'other' } },
    },
  };

  it('does not reveal plain selection (keeps artboard clip)', () => {
    expect(
      listSelectionRevealOverflowIds({
        selectedNodeIds: ['inside', 'world'],
        selectedFrameIds: [],
        document: doc,
      })
    ).toEqual([]);
  });

  it('still reveals SoftGlow / process and editors', () => {
    expect(
      listSelectionRevealOverflowIds({
        selectedNodeIds: ['inside'],
        selectedFrameIds: [],
        document: doc,
        processingNodeIds: ['inside'],
        editingPenId: 'world',
      })
    ).toEqual(['inside', 'world']);
  });

  it('keeps clip when frame owns the processing child', () => {
    expect(
      listSelectionRevealOverflowIds({
        selectedNodeIds: ['inside'],
        selectedFrameIds: ['board'],
        document: doc,
        processingNodeIds: ['inside'],
      })
    ).toEqual([]);
  });
});
