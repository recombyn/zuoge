import { describe, expect, it } from 'vitest';
import {
  frameIsEmpty,
  framePlateEdgeBandScene,
  getFrameBox,
  isPointOnFrameEdge,
  listContentNodeIds,
  resolveFramePlateDragMode,
} from '../framePlatePointer';
import type { SceneDocument } from '@/components/rcb/sceneNode';

describe('framePlatePointer', () => {
  it('lists page children before ROOT children', () => {
    const doc = {
      pages: [{ id: 'p1', children: ['a', 'b'] }],
      deltaSetLike: { ROOT: { children: ['z'] } },
      activePageId: 'p1',
    } as unknown as SceneDocument;
    expect(listContentNodeIds(doc)).toEqual(['a', 'b']);
  });

  it('frameIsEmpty uses bound children (attrs.frameId), not geometry', () => {
    const doc = {
      pages: [{ id: 'p1', children: ['inner', 'neighbor'] }],
      activePageId: 'p1',
      frames: [
        { id: 'f1', x: 0, y: 0, width: 300, height: 300 },
        { id: 'f2', x: 400, y: 0, width: 300, height: 300 },
      ],
      deltaSetLike: {
        ROOT: { children: [] },
        inner: {
          id: 'inner',
          key: 'shape',
          x: 40,
          y: 40,
          width: 80,
          height: 80,
          attrs: { frameId: 'f1' },
        },
        // Sits inside f2 geometrically but belongs to f1 — must not occupy f2.
        neighbor: {
          id: 'neighbor',
          key: 'image',
          x: 420,
          y: 40,
          width: 200,
          height: 200,
          attrs: { frameId: 'f1' },
        },
      },
    } as unknown as SceneDocument;
    expect(frameIsEmpty(doc, 'f1')).toBe(false);
    expect(frameIsEmpty(doc, 'f2')).toBe(true);
    expect(getFrameBox(doc, 'f1')).toEqual({
      left: 0,
      top: 0,
      width: 300,
      height: 300,
    });
  });

  it('frameIsEmpty ignores unbound overlap from adjacent artboards', () => {
    const doc = {
      pages: [{ id: 'p1', children: ['spill'] }],
      activePageId: 'p1',
      frames: [
        { id: 'left', x: 0, y: 0, width: 200, height: 200 },
        { id: 'right', x: 220, y: 0, width: 200, height: 200 },
      ],
      deltaSetLike: {
        ROOT: { children: [] },
        spill: {
          id: 'spill',
          key: 'image',
          x: 100,
          y: 20,
          width: 200,
          height: 160,
          attrs: { frameId: 'left' },
        },
      },
    } as unknown as SceneDocument;
    expect(frameIsEmpty(doc, 'left')).toBe(false);
    expect(frameIsEmpty(doc, 'right')).toBe(true);
    expect(
      resolveFramePlateDragMode(doc, 'right', { readOnly: false, canMove: true })
    ).toBe('frame_move');
  });

  it('frameIsEmpty ignores hidden nodes and full-bleed plates', () => {
    const doc = {
      pages: [{ id: 'p1', children: ['hidden', 'bg'] }],
      activePageId: 'p1',
      frames: [{ id: 'f1', x: 0, y: 0, width: 300, height: 300 }],
      deltaSetLike: {
        ROOT: { children: [] },
        hidden: {
          id: 'hidden',
          key: 'shape',
          x: 40,
          y: 40,
          width: 80,
          height: 80,
          attrs: { hidden: true, frameId: 'f1' },
        },
        bg: {
          id: 'bg',
          key: 'shape',
          x: 0,
          y: 0,
          width: 300,
          height: 300,
          attrs: { shapeType: 'rect', frameId: 'f1' },
        },
      },
    } as unknown as SceneDocument;
    expect(frameIsEmpty(doc, 'f1')).toBe(true);
  });

  it('frameIsEmpty ignores Lottie frame host (host-only plate is empty)', () => {
    const doc = {
      frames: [{ id: 'lot', x: 0, y: 0, width: 300, height: 300, kind: 'animation' }],
      deltaSetLike: {
        ROOT: { children: ['host'] },
        host: {
          id: 'host',
          key: 'lottie',
          x: 0,
          y: 0,
          width: 300,
          height: 300,
          attrs: { frameId: 'lot', animationFrameHost: true },
        },
      },
    } as unknown as SceneDocument;
    expect(frameIsEmpty(doc, 'lot')).toBe(true);
  });

  it('animation workbench with timeline-closed preview children is occupied (marquee, not frame_move)', () => {
    const doc = {
      frames: [{ id: 'anim', x: 0, y: 0, width: 300, height: 300, kind: 'animation' }],
      deltaSetLike: {
        ROOT: { children: ['host', 'shape'] },
        host: {
          id: 'host',
          key: 'lottie',
          x: 0,
          y: 0,
          width: 300,
          height: 300,
          attrs: { frameId: 'anim', animationFrameHost: true },
        },
        shape: {
          id: 'shape',
          key: 'shape',
          x: 40,
          y: 40,
          width: 80,
          height: 80,
          attrs: { shapeType: 'rect', frameId: 'anim' },
        },
      },
    } as unknown as SceneDocument;
    expect(frameIsEmpty(doc, 'anim')).toBe(false);
    expect(
      resolveFramePlateDragMode(doc, 'anim', { readOnly: false, canMove: true })
    ).toBe('pointing_canvas');
  });

  it('animation workbench edit-open treats full-bleed ink as occupied content', async () => {
    const { setAnimationWorkbenchTimelineFocus } = await import(
      '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus'
    );
    setAnimationWorkbenchTimelineFocus('anim');
    try {
      const doc = {
        frames: [{ id: 'anim', x: 0, y: 0, width: 300, height: 300, kind: 'animation' }],
        deltaSetLike: {
          ROOT: { children: ['bg'] },
          bg: {
            id: 'bg',
            key: 'shape',
            x: 0,
            y: 0,
            width: 300,
            height: 300,
            attrs: { shapeType: 'rect', frameId: 'anim' },
          },
        },
      } as unknown as SceneDocument;
      expect(frameIsEmpty(doc, 'anim')).toBe(false);
    } finally {
      setAnimationWorkbenchTimelineFocus(null);
    }
  });

  it('edge band scales with zoom and detects border hits', () => {
    const box = { left: 0, top: 0, width: 200, height: 100 };
    expect(framePlateEdgeBandScene(1)).toBeGreaterThan(0);
    expect(isPointOnFrameEdge({ x: 2, y: 50 }, box, 1)).toBe(true);
    expect(isPointOnFrameEdge({ x: 100, y: 50 }, box, 1)).toBe(false);
  });
});
