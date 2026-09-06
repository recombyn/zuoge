/**
 * Selection paint raise / overflow reveal registries.
 * Kept out of frameContentClip so that module stays clip geometry only.
 */

const EMPTY_REVEAL_OVERFLOW = new Set<string>();
let revealOverflowNodeIds: ReadonlySet<string> = EMPTY_REVEAL_OVERFLOW;

const EMPTY_PAINT_RAISE = new Set<string>();
let paintRaiseNodeIds: ReadonlySet<string> = EMPTY_PAINT_RAISE;
let paintRaiseFrameIds: ReadonlySet<string> = EMPTY_PAINT_RAISE;

/**
 * Optional registry for hosts that temporarily paint past clipContent
 * (selected shapes / SoftGlow / path edit). Callers must not include
 * children of a co-selected artboard — those stay clipped.
 */
export function setFrameClipRevealOverflowIds(ids: Iterable<string> | null | undefined): void {
  if (!ids) {
    revealOverflowNodeIds = EMPTY_REVEAL_OVERFLOW;
    return;
  }
  const next = new Set<string>();
  for (const id of ids) {
    const s = String(id || '').trim();
    if (s) next.add(s);
  }
  revealOverflowNodeIds = next.size ? next : EMPTY_REVEAL_OVERFLOW;
}

export function frameClipRevealsOverflow(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  return revealOverflowNodeIds.has(nodeId);
}

/**
 * Node ids that may temporarily drop clipContent while selected / editing.
 * When the owning artboard is also selected (marquee frame+content), keep clip
 * so overflow does not leak past the plate.
 */
export function listSelectionRevealOverflowIds(opts: {
  selectedNodeIds: readonly string[];
  selectedFrameIds?: readonly string[];
  document?: {
    deltaSetLike?: Record<string, { attrs?: Record<string, unknown> } | undefined> | null;
  } | null;
  processingNodeIds?: readonly string[];
  editingTextId?: string | null;
  editingPenId?: string | null;
}): string[] {
  const selectedFrames = new Set(
    (opts.selectedFrameIds || []).map((id) => String(id || '').trim()).filter(Boolean)
  );
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined) => {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) return;
    if (selectedFrames.size) {
      const owner = String(opts.document?.deltaSetLike?.[id]?.attrs?.frameId || '').trim();
      if (owner && selectedFrames.has(owner)) return;
    }
    seen.add(id);
    out.push(id);
  };
  for (const id of opts.selectedNodeIds) push(id);
  for (const id of opts.processingNodeIds || []) push(id);
  push(opts.editingTextId);
  push(opts.editingPenId);
  return out;
}

/** Single-select temporary paint raise (max+1). Multi-select leaves this empty. */
export function setSelectionPaintRaiseIds(ids: Iterable<string> | null | undefined): void {
  if (!ids) {
    paintRaiseNodeIds = EMPTY_PAINT_RAISE;
    return;
  }
  const next = new Set<string>();
  for (const id of ids) {
    const s = String(id || '').trim();
    if (s) next.add(s);
  }
  paintRaiseNodeIds = next.size ? next : EMPTY_PAINT_RAISE;
}

export function selectionPaintRaises(nodeId: string | null | undefined): boolean {
  if (!nodeId) return false;
  return paintRaiseNodeIds.has(nodeId);
}

/** Single-selected artboard / 动画工作台 — temporary paint front over world ink. */
export function setSelectionPaintRaiseFrameIds(ids: Iterable<string> | null | undefined): void {
  if (!ids) {
    paintRaiseFrameIds = EMPTY_PAINT_RAISE;
    return;
  }
  const next = new Set<string>();
  for (const id of ids) {
    const s = String(id || '').trim();
    if (s) next.add(s);
  }
  paintRaiseFrameIds = next.size ? next : EMPTY_PAINT_RAISE;
}

export function selectionPaintRaisesFrame(frameId: string | null | undefined): boolean {
  if (!frameId) return false;
  return paintRaiseFrameIds.has(frameId);
}

export function hasSelectionPaintRaise(): boolean {
  return paintRaiseNodeIds.size > 0 || paintRaiseFrameIds.size > 0;
}

/** Ids currently raised above stack max for paint (selection). */
export function listSelectionPaintRaiseIds(): string[] {
  if (!paintRaiseNodeIds.size) return [];
  return [...paintRaiseNodeIds];
}

export function listSelectionPaintRaiseFrameIds(): string[] {
  if (!paintRaiseFrameIds.size) return [];
  return [...paintRaiseFrameIds];
}

export function hasFrameClipRevealOverflow(): boolean {
  return revealOverflowNodeIds.size > 0;
}
