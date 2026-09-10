import { markdownToPlain } from './sceneMarkdown';
import { normalizeColor, TEXT_FRAME_PADDING } from './sceneEffects';

const APP_FONT_FAMILY = 'Alibaba PuHuiTi';
const FABRIC_FONT_FAMILY = APP_FONT_FAMILY;

/** Canvas / SVG text face from a CSS stack or stored value. */
export function toFabricFontFamily(raw: unknown, fallback = FABRIC_FONT_FAMILY): string {
  if (raw == null) return fallback;
  const first = String(raw)
    .split(',')[0]
    ?.trim()
    .replace(/^['"]|['"]$/g, '');
  if (!first || first.toLowerCase() === 'sans-serif' || first.toLowerCase() === 'serif') {
    return fallback;
  }
  if (first === '阿里巴巴普惠体' || first === '普惠体') return APP_FONT_FAMILY;
  return first;
}

export type TextStyle = {
  fontSize: number;
  fill: string;
  /** 0–100 text fill alpha (stored as attrs['fill-opacity']). */
  fillOpacity: number;
  fontWeight: string;
  fontFamily: string;
  fontStyle: string;
  textAlign: string;
  lineHeight: number;
  letterSpacing: number;
  /** CSS text-decoration: none | line-through | underline | …
   *  (comma-separated when stacking). */
  textDecoration: string;
};

export const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 14,
  fill: '#333333',
  fillOpacity: 100,
  fontWeight: 'normal',
  fontFamily: FABRIC_FONT_FAMILY,
  fontStyle: 'normal',
  textAlign: 'left',
  lineHeight: 1.4,
  letterSpacing: 0,
  textDecoration: 'none',
};

/** Bold = CSS weight ≥600, or a dedicated catalog Bold face (… Bold + weight normal). */
export function isTextBold(style: Partial<TextStyle> | null | undefined) {
  const w = style?.fontWeight;
  if (w === 'bold' || Number(w) >= 600) return true;
  return /\bbold\b/i.test(String(style?.fontFamily || ''));
}

export function isTextItalic(style: Partial<TextStyle> | null | undefined) {
  return String(style?.fontStyle || '') === 'italic';
}

function textDecorationTokens(raw: unknown): Set<string> {
  return new Set(
    String(raw || '')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t && t !== 'none')
  );
}

export function isTextStrike(style: Partial<TextStyle> | null | undefined) {
  return textDecorationTokens(style?.textDecoration).has('line-through');
}

export function isTextUnderline(style: Partial<TextStyle> | null | undefined) {
  return textDecorationTokens(style?.textDecoration).has('underline');
}

export function isTextOverline(style: Partial<TextStyle> | null | undefined) {
  return textDecorationTokens(style?.textDecoration).has('overline');
}

/** Toggle one CSS text-decoration token; returns canonical string or `none`. */
export function toggleTextDecoration(
  current: unknown,
  token: 'underline' | 'overline' | 'line-through'
): string {
  const set = textDecorationTokens(current);
  if (set.has(token)) set.delete(token);
  else set.add(token);
  if (!set.size) return 'none';
  return (['underline', 'overline', 'line-through'] as const)
    .filter((t) => set.has(t))
    .join(' ');
}

/** Default text-box width when placing / typing (wrap instead of growing sideways).
 *  Scene px at place font (~18 screen px). Scale with `defaultTextWrapWidthForFontSize`. */
export const DEFAULT_TEXT_BOX_WIDTH = 240;

/** Place-font reference matching `RCB_PLACE_TEXT_SCREEN_PX` (keep in sync with layout). */
const PLACE_TEXT_FONT_REF = 18;

/** On-screen wrap target for fixed text (CSS px) — wider than place glyph for readable columns. */
const TEXT_WRAP_SCREEN_PX = 400;

/**
 * Fixed wrap width in scene px for the node's fontSize — same on-screen ratio as
 * TEXT_WRAP_SCREEN_PX at the default place size (zoom-fitted fonts included).
 * Floor ≈ 8 CJK cells so paste/unfix never collapses to one glyph.
 */
export function defaultTextWrapWidthForFontSize(fontSize: number): number {
  const fs = Math.max(1, Number(fontSize) || DEFAULT_TEXT_STYLE.fontSize);
  const ratio = TEXT_WRAP_SCREEN_PX / PLACE_TEXT_FONT_REF;
  return Math.max(Math.ceil(fs * 8), Math.round(fs * ratio));
}

/** Toolbar / attrs font size — always a positive integer (no 162.77 in UI). */
export function normalizeTextFontSize(raw: unknown, fallback = DEFAULT_TEXT_STYLE.fontSize): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return Math.max(1, Math.round(fallback));
  return Math.max(1, Math.min(400, Math.round(n)));
}

/** Recompute node box after font/style edits so selection chrome hugs the glyphs. */
export function measureTextNodeBoxAfterStyleChange(
  node: { width?: number; height?: number; attrs?: Record<string, unknown> },
  style: Partial<TextStyle> = {}
): { width: number; height: number } {
  const merged: TextStyle = {
    ...parseNodeTextStyle(node.attrs || {}),
    ...style,
    fontSize: normalizeTextFontSize(
      style.fontSize ?? parseNodeTextStyle(node.attrs || {}).fontSize
    ),
  };
  const plain = parseNodeText(node.attrs || {}) || ' ';
  const autoSize = String(node.attrs?.autoSize ?? 'true') !== 'false';
  const textFrame =
    node.attrs?.textFrame === true ||
    node.attrs?.textFrame === 'true' ||
    node.attrs?.textFrame === 1 ||
    node.attrs?.textFrame === '1';
  const currentW = Math.max(1, Number(node.width) || DEFAULT_TEXT_BOX_WIDTH);
  const currentH = Math.max(1, Number(node.height) || Math.ceil(merged.fontSize * merged.lineHeight));

  // Image-like text plate: keep the authored box; content scrolls inside.
  if (textFrame) {
    return { width: Math.max(8, Math.round(currentW)), height: Math.max(8, Math.round(currentH)) };
  }

  if (autoSize) {
    const measured = measurePlainTextSize(plain, merged);
    return {
      width: Math.max(8, Math.round(measured.width)),
      height: Math.max(8, Math.round(measured.height)),
    };
  }

  const wrapped = measureWrappedTextSize(plain, merged, currentW);
  return {
    width: Math.max(8, Math.round(wrapped.width)),
    height: Math.max(
      8,
      Math.round(Math.max(wrapped.height, merged.fontSize))
    ),
  };
}

/**
 * Box when leaving fixed text-frame mode — font-scaled wrap width + height to ink.
 */
export function measureTextFrameExitBox(
  node: { width?: number; height?: number; attrs?: Record<string, unknown> },
  style: Partial<TextStyle> = {}
): { width: number; height: number } {
  const merged: TextStyle = {
    ...parseNodeTextStyle(node.attrs || {}),
    ...style,
    fontSize: normalizeTextFontSize(
      style.fontSize ?? parseNodeTextStyle(node.attrs || {}).fontSize
    ),
  };
  const plain = parseNodeText(node.attrs || {}) || ' ';
  const fontSize = Math.max(1, Number(merged.fontSize) || 14);
  const frameW = Math.max(1, Number(node.width) || DEFAULT_TEXT_BOX_WIDTH);
  const innerW = Math.max(fontSize, frameW - TEXT_FRAME_PADDING * 2);
  const preferred = defaultTextWrapWidthForFontSize(fontSize);
  const wrapW = Math.min(preferred * 2, Math.max(preferred, innerW));
  const wrapped = measureWrappedTextSize(plain, merged, wrapW);
  return {
    width: Math.max(8, Math.round(wrapW)),
    height: Math.max(8, Math.round(Math.max(wrapped.height, fontSize))),
  };
}

function measureLineWidth(
  ctx: CanvasRenderingContext2D | null,
  line: string,
  fontSize: number,
  letterSpacing: number
) {
  const raw = line.length ? line : ' ';
  if (ctx && typeof ctx.measureText === 'function') {
    const base = ctx.measureText(raw).width;
    return base + letterSpacing * Math.max(0, raw.length - 1);
  }
  let approx = 0;
  for (const ch of raw) {
    approx += /[\u3400-\u9fff]/.test(ch) ? fontSize : fontSize * 0.55;
  }
  return approx + letterSpacing * Math.max(0, raw.length - 1);
}

function getMeasureContext(style: TextStyle): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const fontSize = Math.max(1, Number(style.fontSize) || 14);
  const family = toFabricFontFamily(style.fontFamily);
  const weight = style.fontWeight || 'normal';
  const italic = style.fontStyle === 'italic' ? 'italic ' : '';
  ctx.font = `${italic}${weight} ${fontSize}px "${family}"`;
  return ctx;
}

/**
 * Visual lines as painted on canvas — soft-wrap when the text box is fixed-width
 * (`autoSize=false`); otherwise hard `\n` only. Keep Outline / SVG / measure in sync.
 */
export function textVisualLines(
  text: string,
  style: Partial<TextStyle> = {},
  opts: { width: number; autoSize?: boolean }
): string[] {
  const plain = String(text ?? '');
  const boxW = Math.max(0, Number(opts.width) || 0);
  const autoSize = opts.autoSize !== false;
  if (!autoSize && boxW > 8) {
    return wrapPlainTextLines(plain || ' ', style, boxW);
  }
  const lines = plain.split(/\n/);
  return lines.length ? lines : [''];
}

/**
 * Soft-wrap plain text into visual lines that fit `maxWidth` (CJK breaks per char).
 * Hard `\n` still starts a new paragraph line.
 */
export function wrapPlainTextLines(
  text: string,
  style: Partial<TextStyle> = {},
  maxWidth = DEFAULT_TEXT_BOX_WIDTH
): string[] {
  const merged = { ...DEFAULT_TEXT_STYLE, ...style };
  const fontSize = Math.max(1, Number(merged.fontSize) || 14);
  const letterSpacing = Number(merged.letterSpacing) || 0;
  // Match measurePlainTextSize (tight ink width). An old 8px pad made one-line
  // text wrap when node.width === content width.
  const limit = Math.max(fontSize, maxWidth + 0.5);
  const ctx = getMeasureContext(merged);
  const paragraphs = String(text ?? '').split('\n');
  const out: string[] = [];

  for (const para of paragraphs) {
    if (!para.length) {
      out.push('');
      continue;
    }
    let line = '';
    for (const ch of para) {
      const next = line + ch;
      if (measureLineWidth(ctx, next, fontSize, letterSpacing) <= limit || !line) {
        line = next;
      } else {
        out.push(line);
        line = ch;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/** Measure plain text box so new text nodes hug their content (not a fixed 200–240 width). */
export function measurePlainTextSize(text: string, style: Partial<TextStyle> = {}) {
  const merged = { ...DEFAULT_TEXT_STYLE, ...style };
  const fontSize = Math.max(1, Number(merged.fontSize) || 14);
  const lineHeight = Math.max(0.8, Number(merged.lineHeight) || 1.4);
  const letterSpacing = Number(merged.letterSpacing) || 0;
  const lines = String(text ?? '').split('\n');
  const sample = lines.length ? lines : [' '];
  const ctx = getMeasureContext(merged);

  let maxW = 0;
  for (const line of sample) {
    maxW = Math.max(maxW, measureLineWidth(ctx, line.length ? line : ' ', fontSize, letterSpacing));
  }

  // Tight width = ink metrics. Height = font em-box / line box so control chrome
  // covers CJK glyphs and matches the inline editor line-height.
  const emBox = measureTextEmBoxHeight(merged, sample[0] || '\u6c38');
  const height = Math.ceil(textHugContentHeight(fontSize, lineHeight, sample.length, emBox));
  return {
    width: Math.max(Math.ceil(fontSize), Math.ceil(maxW)),
    height: Math.max(Math.ceil(fontSize), height),
  };
}

/** Box size when text wraps inside a fixed width (height grows, width stays). */
export function measureWrappedTextSize(
  text: string,
  style: Partial<TextStyle> = {},
  maxWidth = DEFAULT_TEXT_BOX_WIDTH
) {
  const merged = { ...DEFAULT_TEXT_STYLE, ...style };
  const fontSize = Math.max(1, Number(merged.fontSize) || 14);
  const lineHeight = Math.max(0.8, Number(merged.lineHeight) || 1.4);
  const boxW = Math.max(
    Math.ceil(fontSize),
    Math.round(maxWidth) || DEFAULT_TEXT_BOX_WIDTH
  );
  const lines = wrapPlainTextLines(text, merged, boxW);
  const emBox = measureTextEmBoxHeight(merged, (lines[0] || '\u6c38').slice(0, 1) || '\u6c38');
  const height = Math.ceil(
    textHugContentHeight(fontSize, lineHeight, Math.max(1, lines.length), emBox)
  );
  return {
    width: boxW,
    height: Math.max(Math.ceil(fontSize), height),
    lines,
  };
}

/** Resolve editor / node width for wrapping (empty caret stays thin until typing). */
export function resolveTextBoxWidth(
  nodeWidth: unknown,
  hasContent: boolean,
  fontSize = DEFAULT_TEXT_STYLE.fontSize
) {
  const fs = Math.max(1, Number(fontSize) || DEFAULT_TEXT_STYLE.fontSize);
  const w = Number(nodeWidth);
  if (hasContent) {
    return Math.max(
      Math.ceil(fs),
      Number.isFinite(w) && w > fs * 0.5 ? Math.round(w) : DEFAULT_TEXT_BOX_WIDTH
    );
  }
  if (Number.isFinite(w) && w > fs * 0.5) return Math.round(w);
  return Math.max(1, Math.round(fs * 0.15));
}

/** Content height of n line boxes (CSS-style full leading). */
export function textContentHeight(
  fontSize: number,
  lineHeight: number,
  lineCount = 1
) {
  const fs = Math.max(1, fontSize);
  const lh = Math.max(0.8, lineHeight);
  return Math.max(1, lineCount) * fs * lh;
}

/**
 * AutoSize / selection height that hugs glyph ink + CSS line box.
 * Single line uses max(em-box metrics, fontSize×lineHeight) so CJK (e.g. 普惠体)
 * and the inline editor's unitless line-height both fit the control chrome.
 * Multi-line = first-line hug + (n−1)×lineHeight·em (SVG tspan dy).
 */
export function textHugContentHeight(
  fontSize: number,
  lineHeight: number,
  lineCount = 1,
  emBoxHeight?: number
) {
  const fs = Math.max(1, fontSize);
  const lh = Math.max(0.8, lineHeight);
  const n = Math.max(1, Math.floor(Number(lineCount)) || 1);
  const lineBox = fs * lh;
  const first = Math.max(fs, lineBox, Math.max(0, Number(emBoxHeight) || 0));
  if (n <= 1) return first;
  return first + (n - 1) * lineBox;
}

/**
 * Font em-box height from Canvas metrics when available (covers ink past 1em).
 * Falls back to `fontSize` when measure APIs are missing (jsdom / stubs).
 */
export function measureTextEmBoxHeight(
  style: Partial<TextStyle> = {},
  sample = '\u6c38'
): number {
  const merged = { ...DEFAULT_TEXT_STYLE, ...style };
  const fs = Math.max(1, Number(merged.fontSize) || 14);
  const ctx = getMeasureContext(merged);
  if (!ctx || typeof ctx.measureText !== 'function') return fs;
  try {
    const m = ctx.measureText(String(sample || '\u6c38'));
    const ascent = Number(
      (m as TextMetrics).fontBoundingBoxAscent ?? (m as TextMetrics).actualBoundingBoxAscent
    );
    const descent = Number(
      (m as TextMetrics).fontBoundingBoxDescent ?? (m as TextMetrics).actualBoundingBoxDescent
    );
    if (Number.isFinite(ascent) && Number.isFinite(descent) && ascent + descent > fs * 0.5) {
      return Math.max(fs, ascent + descent);
    }
  } catch {
    /* ignore */
  }
  return fs;
}

/**
 * SVG text `y` for `dominant-baseline: text-before-edge` so the hugged line
 * stack is vertically centered inside the selection height.
 */
export function textVerticalOriginY(
  boxH: number,
  fontSize: number,
  lineHeight: number,
  lineCount = 1,
  emBoxHeight?: number
) {
  const contentH = textHugContentHeight(fontSize, lineHeight, lineCount, emBoxHeight);
  // Center the ink stack; half-leading above the first line looked like a gap.
  return Math.max(0, (Math.max(1, boxH) - contentH) / 2);
}

function asRec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function originBlocksToPlain(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((block) => {
      const children = asRec(block)?.children;
      if (!Array.isArray(children)) return '';
      return children
        .map((child) => {
          const text = asRec(child)?.text;
          return typeof text === 'string' ? text : '';
        })
        .join('');
    })
    .filter(Boolean)
    .join('\n');
}

function dataRunsToPlain(raw: unknown): string {
  if (!Array.isArray(raw)) return '';
  return raw
    .map((run) => {
      const chars = asRec(run)?.chars;
      if (!Array.isArray(chars)) return '';
      return chars
        .map((item) => {
          const ch = asRec(item)?.char;
          return typeof ch === 'string' ? ch : '';
        })
        .join('');
    })
    .join('\n');
}

export function parseNodeText(attrs: Record<string, unknown> = {}) {
  if (attrs.ORIGIN_DATA) {
    try {
      const plain = originBlocksToPlain(JSON.parse(String(attrs.ORIGIN_DATA)));
      if (plain) return plain;
    } catch {
      /* fall through */
    }
  }

  if (attrs.DATA) {
    try {
      return dataRunsToPlain(JSON.parse(String(attrs.DATA)));
    } catch {
      /* fall through */
    }
  }

  return '';
}

/** Markdown source for the property editor (falls back to plain text). */
export function parseNodeMarkdown(attrs: Record<string, unknown> = {}) {
  if (typeof attrs.markdown === 'string') return attrs.markdown;
  return parseNodeText(attrs);
}

export function parseNodeTextStyle(attrs: Record<string, unknown> = {}): TextStyle {
  const style: TextStyle = { ...DEFAULT_TEXT_STYLE };

  if (attrs.DATA) {
    try {
      const runs = JSON.parse(String(attrs.DATA));
      const firstRun = Array.isArray(runs) ? asRec(runs[0]) : null;
      const chars = Array.isArray(firstRun?.chars) ? firstRun.chars : [];
      const firstChar = chars.find((item) => {
        const ch = asRec(item)?.char;
        return typeof ch === 'string' && ch.trim();
      });
      const config = asRec(asRec(firstChar)?.config) || {};
      if (config.SIZE) style.fontSize = Number(config.SIZE) || style.fontSize;
      if (config.COLOR) style.fill = normalizeColor(String(config.COLOR));
      if (config.WEIGHT)
        style.fontWeight = config.WEIGHT === 'bold' ? 'bold' : String(config.WEIGHT);
      if (config.FAMILY) style.fontFamily = toFabricFontFamily(config.FAMILY);
      if (config.STYLE) style.fontStyle = String(config.STYLE);
      if (config.ALIGN) style.textAlign = String(config.ALIGN);
      if (config.LINE_HEIGHT) style.lineHeight = Number(config.LINE_HEIGHT) || style.lineHeight;
      if (config.LETTER_SPACING != null) style.letterSpacing = Number(config.LETTER_SPACING) || 0;
      if (config.DECORATION) style.textDecoration = String(config.DECORATION);
    } catch {
      /* ignore */
    }
  }

  if (attrs.ORIGIN_DATA) {
    try {
      const blocks = JSON.parse(String(attrs.ORIGIN_DATA));
      const firstBlock = Array.isArray(blocks) ? asRec(blocks[0]) : null;
      const children = Array.isArray(firstBlock?.children) ? firstBlock.children : [];
      const child = asRec(children[0]);
      const fontBase = asRec(child?.['font-base']) || {};
      if (child?.bold) style.fontWeight = 'bold';
      if (child?.italic) style.fontStyle = 'italic';
      {
        const deco = textDecorationTokens(style.textDecoration);
        if (child?.strike || child?.strikethrough) deco.add('line-through');
        if (child?.underline) deco.add('underline');
        if (child?.overline) deco.add('overline');
        style.textDecoration = deco.size
          ? (['underline', 'overline', 'line-through'] as const)
              .filter((t) => deco.has(t))
              .join(' ')
          : 'none';
      }
      if (fontBase.fontSize != null && Number.isFinite(Number(fontBase.fontSize))) {
        style.fontSize = Number(fontBase.fontSize);
      }
      if (fontBase.color) style.fill = normalizeColor(String(fontBase.color));
      if (fontBase.fontFamily) style.fontFamily = toFabricFontFamily(fontBase.fontFamily);
      if (fontBase.textAlign) style.textAlign = String(fontBase.textAlign);
      if (fontBase.lineHeight != null && Number.isFinite(Number(fontBase.lineHeight))) {
        style.lineHeight = Number(fontBase.lineHeight);
      }
      if (fontBase.letterSpacing != null && Number.isFinite(Number(fontBase.letterSpacing))) {
        style.letterSpacing = Number(fontBase.letterSpacing);
      }
      if (fontBase.textDecoration) style.textDecoration = String(fontBase.textDecoration);
    } catch {
      /* ignore */
    }
  }

  style.fontFamily = toFabricFontFamily(style.fontFamily);
  const opacityRaw = attrs['fill-opacity'];
  if (opacityRaw != null && Number.isFinite(Number(opacityRaw))) {
    style.fillOpacity = Math.max(0, Math.min(100, Math.round(Number(opacityRaw))));
  }
  style.fontSize = normalizeTextFontSize(style.fontSize);
  return style;
}

export function buildTextAttrs(text: string, style: Partial<TextStyle> = {}) {
  const merged: TextStyle = {
    ...DEFAULT_TEXT_STYLE,
    ...style,
    fontFamily: toFabricFontFamily(style.fontFamily ?? DEFAULT_TEXT_STYLE.fontFamily),
    fontSize: normalizeTextFontSize(style.fontSize),
  };
  const chars = String(text || '')
    .split('')
    .map((char) => ({
      char,
      config: {
        SIZE: merged.fontSize,
        COLOR: merged.fill,
        WEIGHT: merged.fontWeight,
        FAMILY: merged.fontFamily,
        STYLE: merged.fontStyle,
        ALIGN: merged.textAlign,
        LINE_HEIGHT: merged.lineHeight,
        LETTER_SPACING: merged.letterSpacing,
        DECORATION: merged.textDecoration,
      },
    }));

  return {
    DATA: JSON.stringify([{ chars, config: {} }]),
    ORIGIN_DATA: JSON.stringify([
      {
        children: [
          {
            text,
            bold: merged.fontWeight === 'bold' || Number(merged.fontWeight) >= 600,
            italic: merged.fontStyle === 'italic',
            strike: String(merged.textDecoration || '').includes('line-through'),
            underline: String(merged.textDecoration || '').includes('underline'),
            overline: String(merged.textDecoration || '').includes('overline'),
            'font-base': {
              fontSize: merged.fontSize,
              color: merged.fill,
              fontFamily: merged.fontFamily,
              textAlign: merged.textAlign,
              lineHeight: merged.lineHeight,
              letterSpacing: merged.letterSpacing,
              textDecoration: merged.textDecoration,
            },
          },
        ],
      },
    ]),
  };
}

/**
 * Commit markdown source + base text style.
 * Canvas text = plain rendering of markdown; `markdown` attr keeps the source.
 */
export function buildMarkdownTextAttrs(markdown: string, style: Partial<TextStyle> = {}) {
  const md = String(markdown ?? '');
  // Allow truly empty text (placement caret) — do not force a space.
  const plain = markdownToPlain(md);
  return {
    ...buildTextAttrs(plain, style),
    markdown: md,
  };
}

/** Style-only update while preserving existing markdown source. */
export function buildTextAttrsPreservingMarkdown(
  attrs: Record<string, unknown> = {},
  style: Partial<TextStyle> = {}
) {
  const md = parseNodeMarkdown(attrs);
  const merged = { ...parseNodeTextStyle(attrs), ...style };
  return {
    ...buildMarkdownTextAttrs(md, merged),
    'fill-opacity': Math.max(0, Math.min(100, Math.round(Number(merged.fillOpacity) || 100))),
  };
}
