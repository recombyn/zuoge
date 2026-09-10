/**
 * Register CJK-capable faces for CanvasKit text paint.
 *
 * Product UI defaults to "Alibaba PuHuiTi" (CSS). CanvasKit needs a TTF with
 * Han glyphs, so we load Noto Sans SC's chinese-simplified face from
 * fontsource and register it under the product family names.
 */
import {
  getFontData,
  getFontDataForWeight,
  isFontLoaded,
  loadGoogleFontData,
  registerEmbeddedFaces,
} from '@rcb-vector/fonts';

/** Product default text family (SceneDocument / toolbar). */
export const KIT_APP_TEXT_FONT = 'Alibaba PuHuiTi';

/** CJK TTF source family (Kit font_catalog → fontsource chinese-simplified). */
const KIT_CJK_SOURCE_FONT = 'Noto Sans SC';

/** Latin-only Noto SC is ~35KB; real CJK face is ~2.5MB. */
const CJK_FACE_MIN_BYTES = 500_000;

const APP_FONT_ALIASES = [
  KIT_APP_TEXT_FONT,
  '阿里巴巴普惠体',
  '普惠体',
] as const;

let loadOnce: Promise<void> | null = null;

function hasCjkFace(family: string): boolean {
  const buf = getFontData(family);
  return Boolean(buf && buf.byteLength >= CJK_FACE_MIN_BYTES);
}

function registerAliasesFromSource(): void {
  const regular = getFontDataForWeight(KIT_CJK_SOURCE_FONT, 400, false);
  const bold = getFontDataForWeight(KIT_CJK_SOURCE_FONT, 700, false);
  if (!regular || regular.byteLength < CJK_FACE_MIN_BYTES) return;
  const faces: Array<{
    family: string;
    weight: number;
    italic: boolean;
    bytes: ArrayBuffer;
  }> = [];
  for (const family of APP_FONT_ALIASES) {
    faces.push({ family, weight: 400, italic: false, bytes: regular });
    if (bold) faces.push({ family, weight: 700, italic: false, bytes: bold });
  }
  registerEmbeddedFaces(faces);
}

/** Ensure product text families are paint-ready in CanvasKit (idempotent). */
export function ensureKitAppTextFonts(): Promise<void> {
  if (hasCjkFace(KIT_APP_TEXT_FONT) && hasCjkFace(KIT_CJK_SOURCE_FONT)) {
    return Promise.resolve();
  }
  if (!loadOnce) {
    loadOnce = (async () => {
      // Must use the CJK subset — latin-only Noto SC has no Han glyphs.
      await loadGoogleFontData(KIT_CJK_SOURCE_FONT);
      registerAliasesFromSource();
    })().catch((err) => {
      console.warn('[rcb/canvas] Kit text font load failed', err);
      loadOnce = null;
    });
  }
  return loadOnce ?? Promise.resolve();
}

/** Fire-and-forget: load a family (or the app CJK fallback) for CanvasKit. */
export function ensureKitFontFamily(fontFamily: string | null | undefined): void {
  const raw = String(fontFamily || '').trim();
  const family = raw.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') || KIT_APP_TEXT_FONT;
  if (
    family === KIT_APP_TEXT_FONT ||
    family === '阿里巴巴普惠体' ||
    family === '普惠体' ||
    !family
  ) {
    if (hasCjkFace(KIT_APP_TEXT_FONT)) return;
    void ensureKitAppTextFonts();
    return;
  }
  // CJK Noto faces: require the large script subset, not latin-only cache.
  if (/^Noto (Sans|Serif) (SC|TC|JP|KR)$/.test(family)) {
    if (hasCjkFace(family)) return;
    void loadGoogleFontData(family).then((buf) => {
      if (!buf) void ensureKitAppTextFonts();
    });
    return;
  }
  if (isFontLoaded(family)) return;
  void loadGoogleFontData(family).then((buf) => {
    if (!buf) void ensureKitAppTextFonts();
  });
}
