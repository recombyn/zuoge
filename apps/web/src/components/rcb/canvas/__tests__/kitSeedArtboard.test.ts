import { describe, expect, it } from 'vitest';
import { isKitEngineSeedArtboard } from '../mountCore';

describe('isKitEngineSeedArtboard', () => {
  it('matches Engine::new / empty-deserialize Artwork 1 at origin', () => {
    expect(
      isKitEngineSeedArtboard({ name: 'Artwork 1', x: 0, y: 0, w: 1000, h: 1000 })
    ).toBe(true);
    expect(
      isKitEngineSeedArtboard({ name: 'Artwork 1', x: 0, y: 0, w: 413, h: 413 })
    ).toBe(true);
  });

  it('rejects user boards away from origin or later Artwork N', () => {
    expect(
      isKitEngineSeedArtboard({ name: 'Artwork 1', x: 120, y: 40, w: 800, h: 600 })
    ).toBe(false);
    expect(
      isKitEngineSeedArtboard({ name: 'Artwork 2', x: 0, y: 0, w: 1000, h: 1000 })
    ).toBe(false);
    expect(
      isKitEngineSeedArtboard({ name: '画板 1', x: 0, y: 0, w: 1000, h: 1000 })
    ).toBe(false);
  });
});
