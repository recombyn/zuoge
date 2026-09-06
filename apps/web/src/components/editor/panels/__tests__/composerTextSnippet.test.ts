import { describe, expect, it } from 'vitest';
import {
  buildTextSnippetContext,
  nextTextSnippetChipLabel,
  shouldConvertPasteToTextChip,
} from '../composerTextSnippet';
import type { ComposerContext } from '../AgentComposerInput';

describe('composerTextSnippet', () => {
  it('labels increment for text snippet chips', () => {
    const chips: ComposerContext[] = [
      { key: 'text-snippet:a', label: '文字 1', kind: 'text', payload: '' },
      { key: 'node:x', label: '图片 1', kind: 'image', payload: '' },
    ];
    expect(nextTextSnippetChipLabel(chips)).toBe('文字 2');
  });

  it('converts only pastes at or above 1000 chars', () => {
    expect(shouldConvertPasteToTextChip('a'.repeat(1000))).toBe(true);
    expect(shouldConvertPasteToTextChip('a'.repeat(999))).toBe(false);
  });

  it('does not convert short multi-line paste', () => {
    const multi = ['line one here', 'line two here', 'line three here'].join('\n');
    expect(shouldConvertPasteToTextChip(multi)).toBe(false);
    expect(shouldConvertPasteToTextChip('ab\ncd')).toBe(false);
  });

  it('builds chip with payload content', () => {
    const ctx = buildTextSnippetContext('hello world', []);
    expect(ctx.label).toBe('文字 1');
    expect(ctx.kind).toBe('text');
    expect(ctx.payload).toContain('hello world');
    expect(ctx.key.startsWith('text-snippet:')).toBe(true);
  });
});
