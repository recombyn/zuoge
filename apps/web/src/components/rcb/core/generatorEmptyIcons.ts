/**
 * Empty-generator center glyphs — filled plate icons (not Lucide title chrome).
 * Video = play triangle; image = sun + mountains; audio = 7 rounded bars.
 * Drawn in a uniform 24×24 box so plate aspect never squashes the glyph.
 */
import { FRAME_PLATE_STROKE } from '@/components/rcb/frames/types';

/** Soft gray glyph fill — same as artboard idle edge. */
export const GENERATOR_EMPTY_ICON_COLOR = FRAME_PLATE_STROKE;

/** Idle generator plate hairline — match artboard border. */
export const GENERATOR_EMPTY_PLATE_STROKE = FRAME_PLATE_STROKE;

/** Target hairline in CSS px (artboard idle edge is also 1 CSS px). */
export const GENERATOR_EMPTY_PLATE_STROKE_WIDTH = 1;

/** Parse `#rrggbb` → 0–255 RGB for CanvasKit `Color(r,g,b,a)`. */
export function generatorEmptyCssRgb(css: string): { r: number; g: number; b: number } {
  const hex = /^#([0-9a-f]{6})$/i.exec(String(css || '').trim());
  if (!hex) return { r: 0xc5, g: 0xc9, b: 0xd2 };
  const n = parseInt(hex[1], 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
  };
}

export type GeneratorEmptyIconKind = 'audio' | 'image' | 'video';

/** Play triangle in 24×24 (video generator). */
export const GEN_VIDEO_PLAY_PATH = 'M9 6.5v11l9-5.5z';

/** Sun + dual peaks in 24×24 (image generator). */
export const GEN_IMAGE_SUN = { cx: 7.2, cy: 7.4, r: 2.4 } as const;
export const GEN_IMAGE_MOUNTAIN_PATH =
  'M3.2 18.2 L9.4 8.6 L12.8 13.4 L16.2 9.2 L20.8 18.2 Z';

/**
 * Seven capsule stems (audio). Drawn as thick round-cap strokes in 24×24 —
 * x + [y0,y1]; stroke width `GEN_AUDIO_BAR_STROKE`.
 */
export const GEN_AUDIO_BARS: ReadonlyArray<readonly [x: number, y0: number, y1: number]> = [
  [3, 9.5, 14.5],
  [6, 7, 17],
  [9, 4, 20],
  [12, 2, 22],
  [15, 4, 20],
  [18, 7, 17],
  [21, 9.5, 14.5],
];
export const GEN_AUDIO_BAR_STROKE = 2.1;

/** HTML/SVG markup for the empty-gen filled glyph (export / offline fallback). */
export function buildGeneratorEmptyIconSvg(
  kind: GeneratorEmptyIconKind,
  size: number,
  color = GENERATOR_EMPTY_ICON_COLOR
): string {
  const side = Math.max(1, Math.round(Number(size) || 24));
  let body = '';
  if (kind === 'video') {
    body = `<path d="${GEN_VIDEO_PLAY_PATH}" fill="${color}" stroke="none"/>`;
  } else if (kind === 'image') {
    body =
      `<circle cx="${GEN_IMAGE_SUN.cx}" cy="${GEN_IMAGE_SUN.cy}" r="${GEN_IMAGE_SUN.r}" fill="${color}" stroke="none"/>` +
      `<path d="${GEN_IMAGE_MOUNTAIN_PATH}" fill="${color}" stroke="none"/>`;
  } else {
    const stroke = `stroke="${color}" stroke-width="${GEN_AUDIO_BAR_STROKE}" stroke-linecap="round" fill="none"`;
    body = GEN_AUDIO_BARS.map(
      ([x, y0, y1]) => `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y1}" ${stroke}/>`
    ).join('');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}
