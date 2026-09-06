/**
 * Bound children store plate-local x/y; paint world = frame + local.
 * Moving a plate updates frames[].x/y only — child attrs stay put.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  documentPointToNodeLocal,
  isFrameLocalCoordSpace,
  nodeDocumentLeftTop,
  nodeLeftTop,
} from '@/components/rcb/scene/paint/sceneToSvg';
import { storedOriginForSceneResult } from '@/components/rcb/scene/paint/svgToScene';
import { applyNodeFrameBindings } from '@/components/editor/canvas/canvasSession';
import { setAnimationWorkbenchTimelineFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import type { SceneDocument } from '@/components/rcb/sceneNode';

afterEach(() => {
  setAnimationWorkbenchTimelineFocus(null);
});

function worldDoc(): SceneDocument {
  return {
    x: 0,
    y: 0,
    frames: [
      {
        id: 'f1',
        kind: 'animation',
        x: 100,
        y: 200,
        width: 400,
        height: 300,
        backgroundColor: '#fff',
        clipContent: true,
      },
    ],
    deltaSetLike: {
      ROOT: { id: 'ROOT', key: 'group', children: ['s1', 'host'] },
      s1: {
        id: 's1',
        key: 'shape',
        x: 150,
        y: 250,
        width: 40,
        height: 30,
        attrs: { shapeType: 'rect', frameId: 'f1' },
        children: [],
      },
      host: {
        id: 'host',
        key: 'lottie',
        x: 100,
        y: 200,
        width: 400,
        height: 300,
        attrs: { frameId: 'f1' },
        children: [],
      },
    },
    stackOrder: ['frame:f1', 'node:s1', 'node:host'],
  } as unknown as SceneDocument;
}

describe('frameLocal coord space', () => {
  it('normalizeDocument migrates bound children to plate-local once', () => {
    const next = normalizeDocument(worldDoc());
    expect(isFrameLocalCoordSpace(next)).toBe(true);
    expect(Number(next.deltaSetLike.s1.x)).toBe(50);
    expect(Number(next.deltaSetLike.s1.y)).toBe(50);
    expect(Number(next.deltaSetLike.host.x)).toBe(0);
    expect(Number(next.deltaSetLike.host.y)).toBe(0);
    // Idempotent.
    const again = normalizeDocument(next);
    expect(Number(again.deltaSetLike.s1.x)).toBe(50);
    expect(Number(again.deltaSetLike.s1.y)).toBe(50);
  });

  it('nodeLeftTop paints world = frame + local', () => {
    const doc = normalizeDocument(worldDoc());
    expect(nodeLeftTop(doc, doc.deltaSetLike.s1)).toEqual({ left: 150, top: 250 });
    expect(nodeDocumentLeftTop(doc, doc.deltaSetLike.s1)).toEqual({
      left: 150,
      top: 250,
    });
  });

  it('moving the plate leaves child local attrs unchanged', () => {
    const doc = normalizeDocument(worldDoc());
    const childX = Number(doc.deltaSetLike.s1.x);
    const childY = Number(doc.deltaSetLike.s1.y);
    const moved = {
      ...doc,
      frames: doc.frames!.map((f) =>
        f.id === 'f1' ? { ...f, x: 300, y: 400 } : f
      ),
    };
    expect(Number(moved.deltaSetLike.s1.x)).toBe(childX);
    expect(Number(moved.deltaSetLike.s1.y)).toBe(childY);
    expect(nodeLeftTop(moved, moved.deltaSetLike.s1)).toEqual({ left: 350, top: 450 });
  });

  it('boolean result store uses plate-local xy (not world abs)', () => {
    const doc = normalizeDocument(worldDoc());
    // Scene result at the child's painted origin (150,250) → local (50,50).
    const stored = storedOriginForSceneResult(doc, 150, 250, 'f1');
    expect(stored).toEqual({ x: 50, y: 50 });
    // Free (no frame) keeps document abs.
    expect(storedOriginForSceneResult(doc, 150, 250, null)).toEqual({ x: 150, y: 250 });
  });

  it('bind / unbind converts world ↔ local', () => {
    setAnimationWorkbenchTimelineFocus('f1');
    const free = normalizeDocument({
      ...worldDoc(),
      deltaSetLike: {
        ROOT: { id: 'ROOT', key: 'group', children: ['s1'] },
        s1: {
          id: 's1',
          key: 'shape',
          x: 150,
          y: 250,
          width: 40,
          height: 30,
          attrs: { shapeType: 'rect' },
          children: [],
        },
      },
    } as unknown as SceneDocument);
    // Free node keeps world coords after migrate (no frameId).
    expect(Number(free.deltaSetLike.s1.x)).toBe(150);
    const bound = applyNodeFrameBindings(free, [
      { nodeId: 's1', left: 150, top: 250, width: 40, height: 30 },
    ]);
    expect(String(bound.deltaSetLike.s1.attrs?.frameId)).toBe('f1');
    expect(Number(bound.deltaSetLike.s1.x)).toBe(50);
    expect(Number(bound.deltaSetLike.s1.y)).toBe(50);

    const unbound = applyNodeFrameBindings(
      {
        ...bound,
        deltaSetLike: {
          ...bound.deltaSetLike,
          // Local far outside the 400×300 plate → world off-plate.
          s1: { ...bound.deltaSetLike.s1, x: 900, y: 900 },
        },
      },
      [{ nodeId: 's1', left: 1000, top: 1100, width: 40, height: 30 }]
    );
    expect(String(unbound.deltaSetLike.s1.attrs?.frameId || '')).toBe('');
    expect(Number(unbound.deltaSetLike.s1.x)).toBe(1000);
    expect(Number(unbound.deltaSetLike.s1.y)).toBe(1100);
  });

  it('documentPointToNodeLocal subtracts plate origin', () => {
    const doc = normalizeDocument(worldDoc());
    const local = documentPointToNodeLocal(doc, doc.deltaSetLike.s1, 180, 270);
    expect(local).toEqual({ x: 80, y: 70 });
  });
});
