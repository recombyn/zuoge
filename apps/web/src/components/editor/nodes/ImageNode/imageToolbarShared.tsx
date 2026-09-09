import { memo, type ReactNode } from 'react';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';

export const imageToolBtn =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)]';

/** Compact session title (放大 / 场景 / 翻译) — no forced min-width. */
export const imageToolSessionTitle =
  'inline-flex h-8 shrink-0 items-center gap-1 px-1.5 text-[12px] font-medium text-[var(--ink)]';

/** Chat-style panel exit — square icon on a soft plate (FlipRotate / tool panels). */
export const imageToolExitBtn =
  'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-[var(--canvas)] text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-40';

/** Scene AABB for docking image-tool chrome under / beside a node. */
export function sessionNodeBox(
  document: SceneDocument,
  node: SceneNodeInput | null | undefined
): { left: number; top: number; width: number; height: number } | null {
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  return {
    left,
    top,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

function ImageToolSep() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-[var(--line)]" aria-hidden />;
}

export function imageMoreRow(icon: ReactNode, label: string, extra?: ReactNode) {
  return (
    <span className="flex w-full items-center gap-2.5 text-[var(--ink)]">
      <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="flex-1 text-left text-[13px] font-medium">{label}</span>
      {extra}
    </span>
  );
}

const MemoizedImageToolSep = memo(ImageToolSep);
export { MemoizedImageToolSep as ImageToolSep };
