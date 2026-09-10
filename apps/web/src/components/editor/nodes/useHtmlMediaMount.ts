/**
 * Resolve the foreignObject HTML mount painted into a scene node’s SVG layer.
 * Lottie / video / audio portal here so CSS z-index is not a parallel stack.
 *
 * Subscribes per-node only — selecting / remounting an unrelated host must not
 * recreate WaveSurfer / video / Lottie portals (selection flash).
 */
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  getShapeHost,
  getShapeHostNodeEpoch,
  subscribeShapeHost,
} from '@/components/rcb/shapes/shapeHostRegistry';
import { findHtmlMediaMount } from '@/components/rcb/scene/dom/domHostBoard';

export function useHtmlMediaMount(nodeId: string): HTMLElement | null {
  const id = String(nodeId || '');
  const subscribe = useCallback(
    (onStoreChange: () => void) => subscribeShapeHost(id, onStoreChange),
    [id]
  );
  const getSnapshot = useCallback(() => getShapeHostNodeEpoch(id), [id]);
  const epoch = useSyncExternalStore(subscribe, getSnapshot, () => 0);
  return useMemo(() => {
    if (!id) return null;
    const host = getShapeHost(id);
    const root = host?.el ?? host?.layer ?? null;
    const mount = findHtmlMediaMount(root);
    return mount instanceof HTMLElement ? mount : null;
  }, [id, epoch]);
}
