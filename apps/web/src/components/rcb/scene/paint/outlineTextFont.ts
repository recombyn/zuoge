import type { SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Text → vector path via fontkit (TrueType / CFF / WOFF / WOFF2 glyph outlines).
 * Prefer this over canvas raster tracing — glyphs stay complete and crisp.
 */

import { create as createFontkitFont } from 'fontkit';
import {
  findFontChild,
  loadFontCatalog,
  resolveFontFileUrl,
} from '@/components/rcb/scene/document/fontCatalog';
import {
  parseNodeText,
  parseNodeTextStyle,
  textVerticalOriginY,
  textVisualLines,
  toFabricFontFamily,
} from '@/components/rcb/scene/document/sceneText';
import type { OutlineResult } from '@/components/rcb/scene/paint/outlineToPath';

type FkCommand = { command: string; args: number[] };
type FkGlyph = {
  id?: number;
  codePoints?: number[];
  path?: { commands: FkCommand[] };
  advanceWidth?: number;
};
type FkFont = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  layout: (text: string) => {
    glyphs: FkGlyph[];
    positions: Array<{ xAdvance?: number; yAdvance?: number; xOffset?: number; yOffset?: number }>;
  };
};

const fontCache = new Map<string, Promise<FkFont | null>>();

/** Catalog faces to try when the chosen family lacks CJK (or other) glyphs. */
const OUTLINE_FONT_FALLBACKS = [
  'Alibaba PuHuiTi',
  'Noto Sans SC',
  'Source Han Sans SC',
  'Noto Sans CJK SC',
];

function parseWeight(fontWeight: string | number | undefined): number {
  if (fontWeight === 'bold' || fontWeight === '700') return 700;
  if (fontWeight === 'normal' || fontWeight === '400') return 400;
  const n = Number(fontWeight);
  return Number.isFinite(n) ? n : 400;
}

/** True when layout substituted .notdef / empty outline for a character that should draw. */
function runHasMissingGlyphs(run: { glyphs: FkGlyph[] }): boolean {
  for (const glyph of run.glyphs) {
    const cps = glyph.codePoints || [];
    const needsInk = cps.some((cp) => {
      try {
        // Skip space / ZW* / BOM — empty path is fine for those.
        return /[^\s\u200b-\u200d\ufeff]/.test(String.fromCodePoint(cp));
      } catch {
        return false;
      }
    });
    if (!needsInk) continue;
    // id 0 is .notdef — common when a Latin face layouts CJK (identical tofu boxes).
    if (glyph.id === 0) return true;
    if (!glyph.path?.commands?.length) return true;
  }
  return false;
}

function asSingleFont(created: unknown): FkFont | null {
  if (!created || typeof created !== 'object') return null;
  const any = created as FkFont & { fonts?: FkFont[] };
  if (Array.isArray(any.fonts) && any.fonts.length) {
    const face = any.fonts.find((f) => f?.unitsPerEm) || any.fonts[0];
    return face?.unitsPerEm ? face : null;
  }
  return any.unitsPerEm ? any : null;
}

async function fetchFontkitFont(url: string): Promise<FkFont | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font fetch ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    return asSingleFont(createFontkitFont(buf));
  } catch (err) {
    console.warn('[outlineTextFont] failed to load font', url, err);
    fontCache.delete(url);
    return null;
  }
}

async function loadFontkitFont(url: string): Promise<FkFont | null> {
  if (!url) return null;
  let pending = fontCache.get(url);
  if (!pending) {
    pending = fetchFontkitFont(url);
    fontCache.set(url, pending);
  }
  return pending;
}

function commandsToPathD(commands: FkCommand[], ox: number, oy: number, scale: number): string {
  if (!commands?.length) return '';
  const out: string[] = [];
  // Scene-space decimals: ~0.05px accuracy. Fixed toFixed(1) collapsed CJK
  // outlines when fontSize is ~1 scene px (common at high zoom) → W≈few H≈1 junk.
  const decimals = outlinePathDecimals(scale);
  const X = (x: number) => (ox + x * scale).toFixed(decimals);
  const Y = (y: number) => (oy - y * scale).toFixed(decimals); // font space ↑ → SVG ↓
  for (const c of commands) {
    const a = c.args || [];
    switch (c.command) {
      case 'moveTo':
        if (a.length >= 2) out.push(`M ${X(a[0])} ${Y(a[1])}`);
        break;
      case 'lineTo':
        if (a.length >= 2) out.push(`L ${X(a[0])} ${Y(a[1])}`);
        break;
      case 'quadraticCurveTo':
        if (a.length >= 4) {
          out.push(`Q ${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])}`);
        }
        break;
      case 'bezierCurveTo':
        if (a.length >= 6) {
          out.push(
            `C ${X(a[0])} ${Y(a[1])} ${X(a[2])} ${Y(a[3])} ${X(a[4])} ${Y(a[5])}`
          );
        }
        break;
      case 'closePath':
        out.push('Z');
        break;
      default:
        break;
    }
  }
  return out.join(' ');
}

/** Decimal places for glyph coords so small scene fontSize keeps counters. */
export function outlinePathDecimals(scale: number): number {
  const s = Math.max(1e-9, Number(scale) || 0);
  // Never use 1dp — counters in o/d/4 collapse into solid blobs at common sizes.
  if (s >= 0.01) return 2;
  if (s >= 0.002) return 3;
  return 4;
}

function measureLayoutWidth(
  font: FkFont,
  line: string,
  scale: number,
  letterSpacing: number
): number {
  if (!line) return 0;
  const run = font.layout(line);
  let w = 0;
  const n = run.glyphs.length;
  for (let i = 0; i < n; i += 1) {
    const pos = run.positions[i];
    w += (pos?.xAdvance ?? run.glyphs[i]?.advanceWidth ?? 0) * scale;
    if (i < n - 1) w += letterSpacing;
  }
  return w;
}

/** Font file URLs to try — painted face first, then a short CJK-capable list. */
function outlineFontCandidateUrls(family: string, weight: number): string[] {
  const urls: string[] = [];
  const push = (url: string | null | undefined) => {
    const u = url ? String(url) : '';
    if (u && !urls.includes(u)) urls.push(u);
  };
  // Exact catalog face the node stores (e.g. Alibaba PuHuiTi Bold) — 延用自身.
  const exact = findFontChild(family);
  if (exact?.url && exact.family === family) {
    push(resolveFontFileUrl(exact.family, exact.weight ?? weight));
  }
  push(resolveFontFileUrl(family, weight));
  for (const name of OUTLINE_FONT_FALLBACKS) {
    push(resolveFontFileUrl(name, weight));
  }
  // Cap: full-catalog CJK sweeps load multi‑MB faces serially and freeze the
  // main thread (e2e / Outline button hang). Named fallbacks above are enough.
  return urls.slice(0, 6);
}

function yieldMain(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function buildGlyphPathParts(
  font: FkFont,
  lines: string[],
  opts: {
    boxW: number;
    boxH: number;
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
    align: string;
    autoSize: boolean;
  }
): string[] | null {
  const scale = opts.fontSize / font.unitsPerEm;
  const ascentPx = font.ascent * scale;
  const parts: string[] = [];
  const originY = textVerticalOriginY(
    opts.boxH,
    opts.fontSize,
    opts.lineHeight,
    Math.max(1, lines.length)
  );

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    const raw = line.length ? line : ' ';
    const run = font.layout(raw);
    if (runHasMissingGlyphs(run)) return null;

    const lineW = measureLayoutWidth(font, raw, scale, opts.letterSpacing);
    let penX = 0;
    if (opts.align === 'center') penX = (opts.boxW - lineW) / 2;
    else if (opts.align === 'right') penX = opts.boxW - lineW;

    const lineTop = originY + lineIdx * opts.fontSize * opts.lineHeight;
    const baseline = lineTop + ascentPx;

    for (let i = 0; i < run.glyphs.length; i += 1) {
      const glyph = run.glyphs[i];
      const pos = run.positions[i] || {};
      const gx = penX + (pos.xOffset || 0) * scale;
      const gy = baseline - (pos.yOffset || 0) * scale;
      const d = commandsToPathD(glyph.path?.commands || [], gx, gy, scale);
      if (d.trim()) parts.push(d);
      penX += (pos.xAdvance ?? glyph.advanceWidth ?? 0) * scale;
      if (i < run.glyphs.length - 1) penX += opts.letterSpacing;
    }
  }
  return parts;
}

/**
 * Build closed glyph paths for a text node using the catalog font file.
 * Returns null when no face can cover the text (caller may raster-fallback).
 */
export async function outlineTextFromFont(node: SceneNodeInput): Promise<OutlineResult | null> {
  if (typeof document === 'undefined' || !node) return null;
  const plain = parseNodeText(node.attrs || {}).trim();
  if (!plain) return null;

  // fontkit parses CJK OTF/TTF synchronously on the main thread (multi‑MB faces).
  // That freezes Outline UI / e2e for minutes. Let `outlineTextLocal` trace the
  // already-painted CSS face instead; Latin stays on the vector fontkit path.
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(plain)) {
    return null;
  }

  await loadFontCatalog();

  const style = parseNodeTextStyle(node.attrs || {});
  const family = toFabricFontFamily(style.fontFamily);
  const weight = parseWeight(style.fontWeight);
  const urls = outlineFontCandidateUrls(family, weight);
  if (!urls.length) return null;

  const boxW = Math.max(1, Number(node.width) || 1);
  const boxH = Math.max(1, Number(node.height) || 1);
  const fontSize = Math.max(1, Number(style.fontSize) || 14);
  const lineHeight = Math.max(0.8, Number(style.lineHeight) || 1.4);
  const letterSpacing = Number(style.letterSpacing) || 0;
  const align = String(style.textAlign || 'left');
  const autoSize = String(node.attrs?.autoSize ?? 'true') !== 'false';
  const lines = textVisualLines(plain, style, { width: boxW, autoSize });
  const layoutOpts = {
    boxW,
    boxH,
    fontSize,
    lineHeight,
    letterSpacing,
    align,
    autoSize,
  };

  for (const url of urls) {
    await yieldMain();
    const font = await loadFontkitFont(url);
    if (!font?.unitsPerEm) continue;
    const parts = buildGlyphPathParts(font, lines, layoutOpts);
    if (!parts?.length) {
      console.warn(
        '[outlineTextFont] missing glyphs for',
        url,
        urls.length > 1 ? '— trying next face' : '— no usable face for this text'
      );
      continue;
    }
    return {
      pathD: parts.join(' '),
      glyphPathDs: parts,
      closed: true,
      fillColor: String(style.fill || '#333333'),
      // TrueType / CFF glyph contours use nonzero winding (not evenodd).
      fillRule: 'nonzero',
    };
  }

  return null;
}
