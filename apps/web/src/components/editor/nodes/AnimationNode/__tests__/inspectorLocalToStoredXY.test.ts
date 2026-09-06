import { describe, expect, it } from 'vitest';
import { inspectorLocalToStoredXY } from '../AnimationFrameChildToolbar';
import type { SceneDocument } from '@/components/rcb/sceneNode';

describe('inspectorLocalToStoredXY', () => {
  it('keeps plate-local under frameLocal (no double frame origin)', () => {
    const doc = { coordSpace: 'frameLocal' } as SceneDocument;
    expect(inspectorLocalToStoredXY(doc, 'f1', 200, 100, 472.5, 247.5)).toEqual({
      x: 472.5,
      y: 247.5,
    });
  });

  it('writes world abs when not frameLocal', () => {
    const doc = {} as SceneDocument;
    expect(inspectorLocalToStoredXY(doc, 'f1', 200, 100, 472.5, 247.5)).toEqual({
      x: 672.5,
      y: 347.5,
    });
  });
});
