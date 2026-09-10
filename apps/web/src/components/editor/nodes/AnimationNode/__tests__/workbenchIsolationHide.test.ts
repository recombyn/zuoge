import { afterEach, describe, expect, it } from 'vitest';
import {
  isArtboardVisibleInDocument,
  isHiddenByAnimationWorkbenchFocus,
  setAnimationWorkbenchTimelineFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { isNodeStructurallyHiddenInDocument } from '@/components/rcb/scene/document/nodeCapabilities';
import type { SceneDocument } from '@/components/rcb/sceneNode';

describe('workbench timeline isolation hides other plates', () => {
  afterEach(() => {
    setAnimationWorkbenchTimelineFocus(null);
  });

  it('hides path ink bound to another animation workbench when timeline opens', () => {
    setAnimationWorkbenchTimelineFocus('anim-a');
    const doc = {
      frames: [
        { id: 'anim-a', kind: 'animation', x: 0, y: 0, width: 400, height: 300 },
        { id: 'anim-b', kind: 'animation', x: 500, y: 0, width: 400, height: 300 },
      ],
      deltaSetLike: {
        ROOT: { children: ['path-a', 'path-b'] },
        'path-a': {
          id: 'path-a',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 40,
          attrs: { shapeType: 'path', frameId: 'anim-a' },
        },
        'path-b': {
          id: 'path-b',
          key: 'shape',
          x: 10,
          y: 10,
          width: 80,
          height: 40,
          attrs: { shapeType: 'path', frameId: 'anim-b' },
        },
      },
    } as unknown as SceneDocument;

    expect(isHiddenByAnimationWorkbenchFocus(doc.deltaSetLike!['path-a'])).toBe(false);
    expect(isHiddenByAnimationWorkbenchFocus(doc.deltaSetLike!['path-b'])).toBe(true);
    expect(isNodeStructurallyHiddenInDocument(doc, doc.deltaSetLike!['path-b'])).toBe(true);
    expect(isArtboardVisibleInDocument(doc.frames![0])).toBe(true);
    expect(isArtboardVisibleInDocument(doc.frames![1])).toBe(false);
  });

  it('hides other-workbench surround pasteboard paths while focused elsewhere', () => {
    setAnimationWorkbenchTimelineFocus('anim-a');
    const foreign = {
      attrs: {
        shapeType: 'path',
        animationWorkbenchSurround: 'anim-b',
      },
    };
    expect(isHiddenByAnimationWorkbenchFocus(foreign)).toBe(true);
  });
});
