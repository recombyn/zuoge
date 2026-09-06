import type { ComposerContext } from '@/components/editor/panels/AgentComposerInput';

/** Plain-text length at or above this → paste becomes a text chip. */
export const LONG_PASTE_MIN_CHARS = 1000;

export function isTextSnippetChip(ctx: Pick<ComposerContext, 'kind' | 'key'>): boolean {
  return ctx.kind === 'text' || String(ctx.key || '').startsWith('text-snippet:');
}

/** Next label: 文字 1 / 文字 2 … */
export function nextTextSnippetChipLabel(chips: ComposerContext[]): string {
  let max = 0;
  for (const c of chips) {
    if (!isTextSnippetChip(c)) continue;
    const m = /^文字\s*(\d+)$/u.exec(String(c.label || '').trim());
    if (m) max = Math.max(max, Number(m[1]) || 0);
  }
  return `文字 ${max + 1}`;
}

export function buildTextSnippetContext(
  text: string,
  existing: ComposerContext[]
): ComposerContext {
  const content = String(text || '').trim();
  const label = nextTextSnippetChipLabel(existing);
  return {
    key: `text-snippet:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    label,
    kind: 'text',
    payload: `[Pasted text snippet — label: ${label}]\ncontent:\n${content}`,
  };
}

export function shouldConvertPasteToTextChip(text: string): boolean {
  const t = String(text || '').trim();
  return t.length >= LONG_PASTE_MIN_CHARS;
}
