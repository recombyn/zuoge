import { describe, expect, it } from 'vitest';
import { resolveFrameChromeBox } from '../selectionLogic';

describe('resolveFrameChromeBox live plate', () => {
  it('prefers live artboard geometry over stale document', async () => {
    const { previewArtboardFrameGeometry, clearLiveArtboardFrameGeometry } = await import(
      '@/components/rcb/frames/HtmlArtboardFrame'
    );
    previewArtboardFrameGeometry({ id: 'f1', x: 120, y: 80, width: 200, height: 200 });
    const box = resolveFrameChromeBox('f1', { x: 0, y: 0, width: 200, height: 200 });
    expect(box.left).toBe(120);
    expect(box.top).toBe(80);
    clearLiveArtboardFrameGeometry(['f1']);
    const after = resolveFrameChromeBox('f1', { x: 50, y: 60, width: 200, height: 200 });
    expect(after.left).toBe(50);
    expect(after.top).toBe(60);
  });

  it('live plate geom stays through a second preview (commit re-bake) until cleared', async () => {
    const { previewArtboardFrameGeometry, clearLiveArtboardFrameGeometry } = await import(
      '@/components/rcb/frames/HtmlArtboardFrame'
    );
    previewArtboardFrameGeometry({ id: 'f1', x: 10, y: 20, width: 100, height: 80 });
    // Pointer-up re-bakes committed lattice into live (onFrameMoveEnd) before store paint.
    previewArtboardFrameGeometry({ id: 'f1', x: 40, y: 60, width: 100, height: 80 });
    const box = resolveFrameChromeBox('f1', { x: 10, y: 20, width: 100, height: 80 });
    expect(box).toEqual({ left: 40, top: 60, width: 100, height: 80 });
    clearLiveArtboardFrameGeometry(['f1']);
  });
});
