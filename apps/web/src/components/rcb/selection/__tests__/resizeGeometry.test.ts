import { describe, expect, it } from 'vitest';
import {
  matchAspectPresetKey,
  resolveControlChrome,
  unionOfBoxes,
} from '../resizeGeometry';
import type { SceneDocument } from '@/components/rcb/sceneNode';

const PRESETS = [
  { id: 'original', w: 0, h: 0 },
  { id: '1:1', w: 1, h: 1 },
  { id: '16:9', w: 16, h: 9 },
];

describe('matchAspectPresetKey', () => {
  it('matches true 1:1', () => {
    expect(matchAspectPresetKey(400, 400, PRESETS)).toBe('1:1');
  });

  it('does not label near-square chrome as 1:1', () => {
    expect(matchAspectPresetKey(449, 457, PRESETS)).toBe('original');
  });

  it('matches 16:9 within slack', () => {
    expect(matchAspectPresetKey(1600, 900, PRESETS)).toBe('16:9');
  });
});

describe('resolveControlChrome', () => {
  it('uses single member box and angle', () => {
    const doc = {
      deltaSetLike: {
        a: { attrs: { angle: 30 } },
      },
    } as unknown as SceneDocument;
    const { box, angle } = resolveControlChrome(doc, [
      { nodeId: 'a', box: { left: 10, top: 20, width: 40, height: 50 } },
    ]);
    expect(box).toEqual({ left: 10, top: 20, width: 40, height: 50 });
    expect(angle).toBe(30);
  });

  it('unions axis boxes when angles match at 0', () => {
    const doc = {
      deltaSetLike: {
        a: { attrs: { angle: 0 } },
        b: { attrs: { angle: 0 } },
      },
    } as unknown as SceneDocument;
    const { box, angle } = resolveControlChrome(doc, [
      { nodeId: 'a', box: { left: 0, top: 0, width: 10, height: 10 } },
      { nodeId: 'b', box: { left: 20, top: 0, width: 10, height: 10 } },
    ]);
    expect(angle).toBe(0);
    expect(box).toEqual(
      unionOfBoxes([
        { left: 0, top: 0, width: 10, height: 10 },
        { left: 20, top: 0, width: 10, height: 10 },
      ])
    );
  });
});
