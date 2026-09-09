import { describe, expect, it } from 'vitest';
import {
  LU_AUDIO_LINES_SEGS,
  LU_IMAGE_PLUS_PATHS,
  buildGeneratorEmptyIconSvg,
  generatorEmptyIconWorldSegs,
  paintGeneratorEmptyLucideIcon,
} from '../../core/generatorEmptyIcons';

describe('generatorEmptyIcons', () => {
  it('exposes the same six Lucide AudioLines stems as NodeTitleLabel', () => {
    expect(LU_AUDIO_LINES_SEGS).toHaveLength(6);
    expect(LU_AUDIO_LINES_SEGS[2]).toEqual([10, 3, 10, 21]);
  });

  it('exposes Lucide ImagePlus path list', () => {
    expect(LU_IMAGE_PLUS_PATHS.length).toBeGreaterThanOrEqual(3);
  });

  it('buildGeneratorEmptyIconSvg returns inline svg for each kind', () => {
    for (const kind of ['audio', 'image', 'video'] as const) {
      const html = buildGeneratorEmptyIconSvg(kind, 24);
      expect(html).toContain('<svg');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('width="24"');
    }
    expect(buildGeneratorEmptyIconSvg('audio', 24)).toContain('<line ');
    expect(buildGeneratorEmptyIconSvg('image', 24)).toContain('<path ');
    expect(buildGeneratorEmptyIconSvg('video', 24)).toContain('<path ');
  });

  it('maps centered audio icon segs into plate world space', () => {
    const segs = generatorEmptyIconWorldSegs('audio', 100, 50, 160, 90, 24);
    expect(segs).toHaveLength(6);
    // Icon origin = plate center - 12: (100+68, 50+33) = (168, 83)
    expect(segs[0].x0).toBeCloseTo(168 + 2, 5);
    expect(segs[0].y0).toBeCloseTo(83 + 10, 5);
    expect(segs[0].stroke).toBeCloseTo(2, 5);
  });

  it('paintGeneratorEmptyLucideIcon strokes audio without throwing', () => {
    const ops: string[] = [];
    const ctx = {
      save: () => ops.push('save'),
      restore: () => ops.push('restore'),
      translate: () => undefined,
      scale: () => undefined,
      beginPath: () => undefined,
      moveTo: () => undefined,
      lineTo: () => undefined,
      stroke: () => ops.push('stroke'),
      strokeStyle: '',
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
    } as unknown as CanvasRenderingContext2D;
    paintGeneratorEmptyLucideIcon(ctx, 'audio', 40, 40, 24);
    expect(ops.filter((o) => o === 'stroke')).toHaveLength(6);
  });
});
