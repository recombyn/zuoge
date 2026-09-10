import { describe, expect, it } from 'vitest';
import {
  framePlateClearsIdleStroke,
  framePlateShowsHighlightEdge,
} from '../HtmlArtboardFrame';

describe('multi-frame plate stroke', () => {
  it('clears idle stroke only for the sole full-chrome plate', () => {
    expect(
      framePlateClearsIdleStroke({
        chromeMode: 'full',
        selectedFrameIds: ['a'],
        frameId: 'a',
      })
    ).toBe(true);
    expect(
      framePlateClearsIdleStroke({
        chromeMode: 'full',
        selectedFrameIds: ['a', 'b'],
        frameId: 'a',
      })
    ).toBe(false);
    expect(
      framePlateClearsIdleStroke({
        chromeMode: 'soft',
        selectedFrameIds: ['a'],
        frameId: 'a',
      })
    ).toBe(false);
  });

  it('highlights multi-full members so plate edges stay under the union box', () => {
    expect(
      framePlateShowsHighlightEdge({
        chromeMode: 'full',
        selectedFrameIds: ['a', 'b'],
        frameId: 'a',
      })
    ).toBe(true);
    expect(
      framePlateShowsHighlightEdge({
        chromeMode: 'full',
        selectedFrameIds: ['a'],
        frameId: 'a',
      })
    ).toBe(false);
    expect(
      framePlateShowsHighlightEdge({
        chromeMode: 'soft',
        selectedFrameIds: ['a'],
        frameId: 'a',
      })
    ).toBe(true);
  });

  it('keeps soft plate edge when a bound child is selected (generator-like context)', () => {
    expect(
      framePlateClearsIdleStroke({
        chromeMode: 'soft',
        selectedFrameIds: [],
        frameId: 'a',
        boundChildSelected: true,
      })
    ).toBe(false);
    expect(
      framePlateShowsHighlightEdge({
        chromeMode: 'soft',
        selectedFrameIds: [],
        frameId: 'a',
        activeFrameId: 'a',
        boundChildSelected: true,
      })
    ).toBe(true);
    // Dragging still keeps a visible plate edge.
    expect(
      framePlateShowsHighlightEdge({
        chromeMode: 'soft',
        selectedFrameIds: [],
        frameId: 'a',
        activeFrameId: 'a',
        boundChildSelected: true,
        moving: true,
      })
    ).toBe(true);
  });
});
