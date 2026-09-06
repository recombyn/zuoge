/**
 * Move bind/unbind must use document AABB vs frame.x/y.
 * Feeding scene-local GeomPatch left/top with document.x/y ≠ 0 inverted
 * membership (on-plate emptied the timeline; off-plate kept the layer).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { applyNodeFrameBindings } from '@/components/editor/canvas/canvasSession';
import { setAnimationWorkbenchTimelineFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import type { SceneDocument } from '@/components/rcb/sceneNode';

afterEach(() => {
  setAnimationWorkbenchTimelineFocus(null);
});

function makeDoc(opts: {
  ox: number;
  oy: number;
  frame: { x: number; y: number; width: number; height: number };
  node: { x: number; y: number; width: number; height: number; frameId?: string };
}): SceneDocument {
  return {
    x: opts.ox,
    y: opts.oy,
    frames: [
      {
        id: 'anim',
        kind: 'animation',
        x: opts.frame.x,
        y: opts.frame.y,
        width: opts.frame.width,
        height: opts.frame.height,
        backgroundColor: '#fff',
        clipContent: true},
    ],
    deltaSetLike: {
      ROOT: { id: 'ROOT', key: 'group', children: ['s1'] },
      s1: {
        id: 's1',
        key: 'shape',
        x: opts.node.x,
        y: opts.node.y,
        width: opts.node.width,
        height: opts.node.height,
        attrs: {
          shapeType: 'path',
          ...(opts.node.frameId ? { frameId: opts.node.frameId } : {})},
        children: []}},
    stackOrder: ['frame:anim', 'node:s1']} as unknown as SceneDocument;
}

describe('applyNodeFrameBindings document-space membership', () => {
  it('binds on-plate and unbinds off-plate when document origin is non-zero', () => {
    setAnimationWorkbenchTimelineFocus('anim');
    const ox = 200;
    const oy = 200;
    const frame = { x: 200, y: 200, width: 364, height: 364 };

    // Visually on plate (document box overlaps frame).
    const onPlate = makeDoc({
      ox,
      oy,
      frame,
      node: { x: 250, y: 250, width: 80, height: 60 }});
    // Deliberately wrong scene-local patch (would miss the frame if trusted).
    const sceneLocalOnPlate = {
      nodeId: 's1',
      left: 250 - ox,
      top: 250 - oy,
      width: 80,
      height: 60};
    const bound = applyNodeFrameBindings(onPlate, [sceneLocalOnPlate]);
    expect(String(bound.deltaSetLike?.s1?.attrs?.frameId || '')).toBe('anim');

    // Visually off plate to the right — scene left still overlaps frame.x..x+w
    // if you wrongly compare scene left to document frame (the old bug).
    const offPlate = makeDoc({
      ox,
      oy,
      frame,
      node: { x: 600, y: 250, width: 80, height: 60, frameId: 'anim' }});
    const sceneLocalOffPlate = {
      nodeId: 's1',
      left: 600 - ox, // 400 — intersects document frame [200,564) by mistake
      top: 250 - oy,
      width: 80,
      height: 60};
    const unbound = applyNodeFrameBindings(offPlate, [sceneLocalOffPlate]);
    expect(String(unbound.deltaSetLike?.s1?.attrs?.frameId || '')).toBe('');
  });

  it('keeps bind when still overlapping after a document-space move', () => {
    setAnimationWorkbenchTimelineFocus('anim');
    const doc = makeDoc({
      ox: 0,
      oy: 0,
      frame: { x: 0, y: 0, width: 400, height: 400 },
      node: { x: 300, y: 40, width: 80, height: 60, frameId: 'anim' }});
    const next = applyNodeFrameBindings(doc, [
      { nodeId: 's1', left: 300, top: 40, width: 80, height: 60 },
    ]);
    expect(String(next.deltaSetLike?.s1?.attrs?.frameId || '')).toBe('anim');
  });
});

describe('bindCreatedNodeToFrame final AABB', () => {
  it('drops preferred plate when finished box is fully outside', async () => {
    const { bindCreatedNodeToFrame } = await import(
      '@/components/editor/canvas/canvasSession'
    );
    setAnimationWorkbenchTimelineFocus('anim');
    const doc = makeDoc({
      ox: 0,
      oy: 0,
      frame: { x: 0, y: 0, width: 364, height: 364 },
      node: { x: 400, y: 40, width: 80, height: 60 },
    });
    // Preferred = plate (pointer-down hit), final rect off-plate to the right.
    const next = bindCreatedNodeToFrame(
      doc,
      's1',
      { left: 400, top: 40, width: 80, height: 60 },
      'anim'
    );
    expect(String(next.deltaSetLike?.s1?.attrs?.frameId || '')).toBe('');
    expect(String(next.deltaSetLike?.s1?.attrs?.animationWorkbenchSurround || '')).toBe(
      'anim'
    );
  });

  it('binds when finished box overlaps the open animation workbench', async () => {
    const { bindCreatedNodeToFrame } = await import(
      '@/components/editor/canvas/canvasSession'
    );
    setAnimationWorkbenchTimelineFocus('anim');
    const doc = makeDoc({
      ox: 0,
      oy: 0,
      frame: { x: 0, y: 0, width: 364, height: 364 },
      // Overlaps right edge — must become a workbench layer (on plate), not surround.
      node: { x: 300, y: 40, width: 120, height: 80 },
    });
    const next = bindCreatedNodeToFrame(
      doc,
      's1',
      { left: 300, top: 40, width: 120, height: 80 },
      null
    );
    expect(String(next.deltaSetLike?.s1?.attrs?.frameId || '')).toBe('anim');
    expect(next.deltaSetLike?.s1?.attrs?.animationWorkbenchSurround).toBeUndefined();
  });
});
