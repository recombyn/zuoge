/**
 * Track Kit selection-frame AABB for HTML toolbar / property-panel docking.
 * While anything is selected, re-read every animation frame so chrome stays
 * aligned after create / reconcile / font-settle (not only mid-gesture).
 * Keep the last good box when Kit briefly returns null for the same selection.
 */
import { useEffect, useState } from 'react';
import {
  getKitSelectionDockAabb,
  kitSelectionGestureActive,
  kitSelectionMoveActive,
  kitSelectionResizeOrRotateActive,
} from '@/components/rcb/canvas/kitBridge';
import type { SceneBox } from '@/components/rcb/selection/alignGuides';

function sameBox(a: SceneBox | null, b: SceneBox | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) < 0.25 &&
    Math.abs(a.top - b.top) < 0.25 &&
    Math.abs(a.width - b.width) < 0.25 &&
    Math.abs(a.height - b.height) < 0.25
  );
}

export function useKitSelectionDockAabb(
  selectedNodeIds: readonly string[],
  selectedFrameIds: readonly string[] = []
): SceneBox | null {
  const hasSel = selectedNodeIds.length > 0 || selectedFrameIds.length > 0;
  const [box, setBox] = useState<SceneBox | null>(() =>
    hasSel ? getKitSelectionDockAabb() : null
  );

  useEffect(() => {
    if (!hasSel) {
      setBox(null);
      return;
    }
    let raf = 0;
    let alive = true;
    const pull = () => {
      if (!alive) return;
      const next = getKitSelectionDockAabb();
      setBox((prev) => {
        // Transient null (Kit mapping lag) — keep last box for this selection.
        // Cleared when selection is empty (hasSel) or ids change (effect restart).
        if (!next) return prev;
        return sameBox(prev, next) ? prev : next;
      });
      // Always tick while selected so toolbar + style panel recompute together.
      raf = requestAnimationFrame(pull);
    };
    pull();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [hasSel, selectedNodeIds.join('|'), selectedFrameIds.join('|')]);

  return hasSel ? box : null;
}

/** True while Kit is mid move-drag — hide HTML selection toolbars. */
export function useKitSelectionMoveActive(): boolean {
  const [moving, setMoving] = useState(() => kitSelectionMoveActive());
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const pull = () => {
      if (!alive) return;
      const next = kitSelectionMoveActive();
      setMoving((prev) => (prev === next ? prev : next));
      if (next || kitSelectionGestureActive()) {
        raf = requestAnimationFrame(pull);
      }
    };
    pull();
    const onPtr = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(pull);
    };
    window.addEventListener('pointerdown', onPtr, true);
    window.addEventListener('pointermove', onPtr, true);
    window.addEventListener('pointerup', onPtr, true);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onPtr, true);
      window.removeEventListener('pointermove', onPtr, true);
      window.removeEventListener('pointerup', onPtr, true);
    };
  }, []);
  return moving;
}

/**
 * True while Kit is resizing/rotating — hide parametric shape knobs so they
 * do not sit on the pre-resize box until geometry flush lands.
 */
export function useKitSelectionResizeOrRotateActive(): boolean {
  const [busy, setBusy] = useState(() => kitSelectionResizeOrRotateActive());
  useEffect(() => {
    let raf = 0;
    let alive = true;
    const pull = () => {
      if (!alive) return;
      const next = kitSelectionResizeOrRotateActive();
      setBusy((prev) => (prev === next ? prev : next));
      if (next || kitSelectionGestureActive()) {
        raf = requestAnimationFrame(pull);
      }
    };
    pull();
    const onPtr = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(pull);
    };
    window.addEventListener('pointerdown', onPtr, true);
    window.addEventListener('pointermove', onPtr, true);
    window.addEventListener('pointerup', onPtr, true);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointerdown', onPtr, true);
      window.removeEventListener('pointermove', onPtr, true);
      window.removeEventListener('pointerup', onPtr, true);
    };
  }, []);
  return busy;
}
