import { describe, expect, it } from 'vitest';
import { supportsCornerRadius } from '../nodeCapabilities';

describe('supportsCornerRadius — closed boolean / path', () => {
  it('allows closed shape path (boolean result)', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          closed: 'true',
          path: 'M 0 0 L 100 0 L 100 80 L 40 80 L 40 40 L 0 40 Z',
        },
      })
    ).toBe(true);
  });

  it('allows closed path when only Z marks closure', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          path: 'M 0 0 L 10 0 L 10 10 L 0 10 Z',
        },
      })
    ).toBe(true);
  });

  it('rejects open pen / pencil / explicitly open path', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: { shapeType: 'pen', closed: 'false', path: 'M 0 0 L 10 10' },
      })
    ).toBe(false);
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: { shapeType: 'pencil', path: 'M 0 0 L 10 10' },
      })
    ).toBe(false);
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: { shapeType: 'path', closed: 'false', path: 'M 0 0 L 10 10' },
      })
    ).toBe(false);
  });

  it('rejects multi-glyph outlined text paths (R-dots only in path-edit)', () => {
    expect(
      supportsCornerRadius({
        key: 'shape',
        attrs: {
          shapeType: 'path',
          closed: 'true',
          // 4+ closed rings — same threshold as Kit path-edit / convertToPath
          path: 'M 0 0 L 10 0 L 10 10 Z M 20 0 L 30 0 L 30 10 Z M 40 0 L 50 0 L 50 10 Z M 60 0 L 70 0 L 70 10 Z',
        },
      })
    ).toBe(false);
  });
});
