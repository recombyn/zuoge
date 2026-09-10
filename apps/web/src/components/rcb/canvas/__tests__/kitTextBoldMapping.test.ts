import { describe, expect, it } from 'vitest';
import {
  isTextBold,
  isTextOverline,
  isTextStrike,
  isTextUnderline,
  toFabricFontFamily,
  toggleTextDecoration,
} from '@/components/rcb/scene/document/sceneText';

/**
 * Mirror of kitBridge.kitTextTypoFromStyle mapping rules — keep in sync.
 * Catalog Bold uses "Alibaba PuHuiTi Bold" + CSS weight normal.
 */
function kitFamilyAndWeight(fontFamily: string, fontWeight: string) {
  const raw = toFabricFontFamily(fontFamily) || 'Alibaba PuHuiTi';
  const style = { fontFamily: raw, fontWeight };
  const bold = isTextBold(style);
  let weight = 400;
  if (bold) {
    const n = Number(fontWeight);
    weight = Number.isFinite(n) && n >= 600 ? Math.round(n) : 700;
  }
  const family = raw.replace(/\s+Bold$/i, '').trim() || raw;
  return { family, weight };
}

/** Mirror of kitBridge.kitTextDecorationFlags — Skia bitflags. */
function kitDecorationFlags(textDecoration: string) {
  const style = { textDecoration };
  let flags = 0;
  if (isTextUnderline(style)) flags |= 1;
  if (isTextOverline(style)) flags |= 2;
  if (isTextStrike(style)) flags |= 4;
  return flags;
}

describe('Kit text bold face mapping', () => {
  it('maps catalog Bold face to base family @ 700', () => {
    expect(kitFamilyAndWeight('Alibaba PuHuiTi Bold', 'normal')).toEqual({
      family: 'Alibaba PuHuiTi',
      weight: 700,
    });
  });

  it('keeps numeric bold weight on base family', () => {
    expect(kitFamilyAndWeight('Alibaba PuHuiTi', '700')).toEqual({
      family: 'Alibaba PuHuiTi',
      weight: 700,
    });
  });

  it('leaves regular face at 400', () => {
    expect(kitFamilyAndWeight('Alibaba PuHuiTi', 'normal')).toEqual({
      family: 'Alibaba PuHuiTi',
      weight: 400,
    });
  });
});

describe('Kit text decoration flags', () => {
  it('maps underline / overline / strike to Skia bitflags', () => {
    expect(kitDecorationFlags('underline')).toBe(1);
    expect(kitDecorationFlags('overline')).toBe(2);
    expect(kitDecorationFlags('line-through')).toBe(4);
    expect(kitDecorationFlags('underline line-through')).toBe(5);
    expect(kitDecorationFlags('none')).toBe(0);
  });

  it('toggleTextDecoration round-trips tokens', () => {
    const next = toggleTextDecoration('none', 'underline');
    expect(next).toBe('underline');
    expect(toggleTextDecoration(next, 'underline')).toBe('none');
  });
});
