/**
 * Gesture-time geometry overlay (ADR 0027).
 *
 * SceneDocument stays the commit fact. During drag / resize / rotate, writers
 * publish here; Canvas underlay, chrome, and hit use
 * `effective = preview —  document` — not SVG DOM mutation alone.
 */
export type NodeTransformPreview = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Degrees; omit to keep document angle. */
  angle?: number;
  /**
   * Playhead out-of-range / ink hide — Kit paint + hit skip while true.
   * Document visibility is unchanged (scrub-only).
   */
  hidden?: boolean;
};

export type NodeTransformPreviewPatch = {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  angle?: number;
  hidden?: boolean;
};

const byId = new Map<string, NodeTransformPreview>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) {
    fn();
  }
}

export function getNodeTransformPreview(nodeId: string): NodeTransformPreview | null {
  const id = String(nodeId || '');
  if (!id) return null;
  return byId.get(id) ?? null;
}

export function listNodeTransformPreviewIds(): string[] {
  return [...byId.keys()];
}

export function hasNodeTransformPreviews(): boolean {
  return byId.size > 0;
}

/** Merge geometry patches into the live preview map (pointermove / rAF). */
export function setNodeTransformPreviews(patches: readonly NodeTransformPreviewPatch[]): void {
  if (!patches.length) return;
  let changed = false;
  for (const p of patches) {
    const id = String(p.nodeId || '');
    if (!id) continue;
    const prev = byId.get(id);
    const next: NodeTransformPreview = {
      left: Number(p.left),
      top: Number(p.top),
      width: Math.max(1, Number(p.width) || 1),
      height: Math.max(1, Number(p.height) || 1),
      angle: p.angle !== undefined ? Number(p.angle) : prev?.angle,
      hidden: p.hidden !== undefined ? Boolean(p.hidden) : prev?.hidden,
    };
    if (
      prev &&
      prev.left === next.left &&
      prev.top === next.top &&
      prev.width === next.width &&
      prev.height === next.height &&
      prev.angle === next.angle &&
      prev.hidden === next.hidden
    ) {
      continue;
    }
    byId.set(id, next);
    changed = true;
  }
  // Pointer events may be more frequent than the visual scene coordinate
  // changes (especially with snapped moves). Do not repaint the shared canvas
  // or wake unrelated SVG hosts for an identical preview frame.
  if (changed) notify();
}

/** Angle-only preview (keeps last box, or no-op box until geometry arrives). */
export function setNodeTransformAngles(
  angles: ReadonlyArray<{ nodeId: string; angle: number }>
): void {
  if (!angles.length) return;
  let changed = false;
  for (const a of angles) {
    const id = String(a.nodeId || '');
    if (!id) continue;
    const prev = byId.get(id);
    const angle = Number(a.angle);
    if (!Number.isFinite(angle)) continue;
    if (prev && prev.angle === angle) continue;
    if (prev) {
      byId.set(id, { ...prev, angle });
    } else {
      // Angle-only before box patch — keep a sentinel; paint uses doc box + angle.
      byId.set(id, {
        left: Number.NaN,
        top: Number.NaN,
        width: Number.NaN,
        height: Number.NaN,
        angle,
      });
    }
    changed = true;
  }
  if (changed) notify();
}

/** Playhead in/out hide for Kit (keeps last box/angle). */
export function setNodeTransformHidden(
  patches: ReadonlyArray<{ nodeId: string; hidden: boolean }>
): void {
  if (!patches.length) return;
  let changed = false;
  for (const p of patches) {
    const id = String(p.nodeId || '');
    if (!id) continue;
    const prev = byId.get(id);
    const hidden = Boolean(p.hidden);
    if (prev) {
      if (prev.hidden === hidden) continue;
      byId.set(id, { ...prev, hidden });
    } else if (hidden) {
      byId.set(id, {
        left: Number.NaN,
        top: Number.NaN,
        width: Number.NaN,
        height: Number.NaN,
        hidden: true,
      });
    } else {
      continue;
    }
    changed = true;
  }
  if (changed) notify();
}

export function clearNodeTransformPreviews(ids?: readonly string[]): void {
  if (!byId.size) return;
  if (!ids || !ids.length) {
    byId.clear();
    notify();
    return;
  }
  let changed = false;
  for (const raw of ids) {
    const id = String(raw || '');
    if (id && byId.delete(id)) changed = true;
  }
  if (changed) notify();
}

export function subscribeTransformPreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export type EffectivePaintBox = {
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
  hidden: boolean;
};

/**
 * Resolve paint/hit box: preview overrides document when present and finite.
 */
export function effectivePaintBox(
  nodeId: string,
  docBox: { left: number; top: number; width: number; height: number },
  docAngle = 0
): EffectivePaintBox {
  const preview = getNodeTransformPreview(nodeId);
  if (!preview) {
    return {
      left: docBox.left,
      top: docBox.top,
      width: Math.max(1, docBox.width),
      height: Math.max(1, docBox.height),
      angle: Number(docAngle) || 0,
      hidden: false,
    };
  }
  const left = Number.isFinite(preview.left) ? preview.left : docBox.left;
  const top = Number.isFinite(preview.top) ? preview.top : docBox.top;
  const width = Number.isFinite(preview.width) ? Math.max(1, preview.width) : Math.max(1, docBox.width);
  const height = Number.isFinite(preview.height)
    ? Math.max(1, preview.height)
    : Math.max(1, docBox.height);
  const angle =
    preview.angle !== undefined && Number.isFinite(preview.angle)
      ? Number(preview.angle)
      : Number(docAngle) || 0;
  return {
    left,
    top,
    width,
    height,
    angle,
    hidden: Boolean(preview.hidden),
  };
}
