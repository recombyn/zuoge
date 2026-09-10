import { describe, expect, it, vi } from 'vitest';
import {
  defaultTextWrapWidthForFontSize,
  measurePlainTextSize,
  measureTextNodeBoxAfterStyleChange,
  normalizeTextFontSize,
  textVisualLines,
  wrapPlainTextLines,
} from '@/components/rcb/scene/document/sceneText';

/**
 * jsdom often has no Canvas 2D — measureLineWidth falls back to CJK ≈ fontSize.
 * That keeps wrap math deterministic for regression checks.
 */
describe('normalizeTextFontSize', () => {
  it('rounds decimals to integers', () => {
    expect(normalizeTextFontSize(162.77)).toBe(163);
    expect(normalizeTextFontSize('14.2')).toBe(14);
  });
});

describe('measureTextNodeBoxAfterStyleChange', () => {
  it('grows height when font size increases in a fixed-width box', () => {
    const node = {
      width: 200,
      height: 40,
      attrs: {
        autoSize: 'false',
        markdown: '可乐',
        DATA: JSON.stringify([
          {
            chars: [{ char: '可', config: { SIZE: 14 } }, { char: '乐', config: { SIZE: 14 } }],
            config: {},
          },
        ]),
      },
    };
    const before = measureTextNodeBoxAfterStyleChange(node, { fontSize: 14 });
    const after = measureTextNodeBoxAfterStyleChange(node, { fontSize: 48 });
    expect(after.width).toBe(before.width);
    expect(after.height).toBeGreaterThan(before.height);
  });
});

describe('wrapPlainTextLines', () => {
  it('keeps one CJK line when width equals ink width (no phantom 8px pad)', () => {
    const text = '你好世界';
    const fontSize = 14;
    // Fallback: each CJK char ≈ fontSize → 56px ink
    const inkW = text.length * fontSize;
    const lines = wrapPlainTextLines(text, { fontSize }, inkW);
    expect(lines).toEqual([text]);
  });

  it('soft-wraps when maxWidth is narrower than ink', () => {
    const text = '你好世界';
    const fontSize = 14;
    const lines = wrapPlainTextLines(text, { fontSize }, fontSize * 2);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(text);
  });

  it('respects hard newlines', () => {
    const lines = wrapPlainTextLines('一行\n二行', { fontSize: 14 }, 999);
    expect(lines).toEqual(['一行', '二行']);
  });
});

describe('textVisualLines', () => {
  it('soft-wraps fixed-width boxes (Outline must match paint)', () => {
    const text = '你好世界测试文字';
    const fontSize = 14;
    const lines = textVisualLines(text, { fontSize }, {
      width: fontSize * 3,
      autoSize: false,
    });
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(text);
  });

  it('keeps hug text as hard newlines only', () => {
    const lines = textVisualLines('你好世界测试文字', { fontSize: 14 }, {
      width: 40,
      autoSize: true,
    });
    expect(lines).toEqual(['你好世界测试文字']);
  });
});

describe('defaultTextWrapWidthForFontSize', () => {
  it('at place font ≈400 screen-px column', () => {
    expect(defaultTextWrapWidthForFontSize(18)).toBe(400);
  });

  it('at zoom-fitted 360 keeps ≥8 CJK cells', () => {
    const w = defaultTextWrapWidthForFontSize(360);
    expect(w).toBeGreaterThanOrEqual(360 * 8);
    expect(w).toBe(Math.round(360 * (400 / 18)));
  });
});

describe('measurePlainTextSize', () => {
  it('returns tight width; height covers line box (not bare 1em)', () => {
    const text = '移动任务页';
    const fontSize = 14;
    const lineHeight = 1.4;
    const size = measurePlainTextSize(text, { fontSize, lineHeight });
    expect(size.width).toBe(Math.max(fontSize, text.length * fontSize));
    // jsdom has no font metrics → hug = fontSize × lineHeight.
    expect(size.height).toBe(Math.ceil(fontSize * lineHeight));
  });

  it('at high-zoom fontSize=1 does not keep a document-24px floor', () => {
    const text = '大撤大撒';
    const fontSize = 1;
    const lineHeight = 1.4;
    const size = measurePlainTextSize(text, { fontSize, lineHeight });
    // eslint-disable-next-line no-console
    console.log('[test:text-measure@fs1]', { size, oldFloor: 24 });
    expect(size.width).toBeLessThan(24);
    expect(size.width).toBe(Math.max(fontSize, text.length * fontSize));
    expect(size.height).toBe(Math.ceil(fontSize * lineHeight));
  });

  it('multi-line height = first line box + (n-1)×lineHeight·em', () => {
    const fontSize = 20;
    const lineHeight = 1.4;
    const size = measurePlainTextSize('甲\n乙\n丙', { fontSize, lineHeight });
    const first = fontSize * lineHeight;
    expect(size.height).toBe(Math.ceil(first + 2 * fontSize * lineHeight));
  });
});

describe('toFabricFontFamily (via wrap side-effects)', () => {
  it('does not throw when canvas getContext is stubbed null', () => {
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(null);
    try {
      expect(wrapPlainTextLines('测', { fontSize: 14 }, 100)).toEqual(['测']);
    } finally {
      spy.mockRestore();
    }
  });
});
