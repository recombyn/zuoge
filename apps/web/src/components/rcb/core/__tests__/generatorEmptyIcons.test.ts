import { describe, expect, it } from 'vitest';
import {
  GEN_AUDIO_BARS,
  GEN_VIDEO_PLAY_PATH,
  GEN_IMAGE_MOUNTAIN_PATH,
  buildGeneratorEmptyIconSvg,
} from '../../core/generatorEmptyIcons';

describe('generatorEmptyIcons', () => {
  it('exposes seven audio capsule stems', () => {
    expect(GEN_AUDIO_BARS).toHaveLength(7);
    expect(GEN_AUDIO_BARS[3]).toEqual([12, 2, 22]);
  });

  it('exposes filled video play + image mountain paths', () => {
    expect(GEN_VIDEO_PLAY_PATH).toContain('M9');
    expect(GEN_IMAGE_MOUNTAIN_PATH).toContain('M3.2');
  });

  it('buildGeneratorEmptyIconSvg returns filled markup for each kind', () => {
    expect(buildGeneratorEmptyIconSvg('video', 24)).toContain('fill=');
    expect(buildGeneratorEmptyIconSvg('video', 24)).toContain(GEN_VIDEO_PLAY_PATH);
    expect(buildGeneratorEmptyIconSvg('image', 24)).toContain('<circle');
    expect(buildGeneratorEmptyIconSvg('image', 24)).toContain('<path');
    expect(buildGeneratorEmptyIconSvg('audio', 24)).toContain('<line ');
    expect(buildGeneratorEmptyIconSvg('audio', 24).match(/<line /g)?.length).toBe(7);
  });
});
