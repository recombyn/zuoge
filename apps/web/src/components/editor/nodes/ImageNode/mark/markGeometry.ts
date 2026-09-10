import { rcbSceneToScreen, type RcbCamera } from '@/components/rcb';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  isImageGeneratorNode,
  isNodeHidden,
} from '@/components/rcb/scene/document/nodeCapabilities';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import type { MarkRegion } from './MarkRegionOverlay';

/** On-image mark rubber-band (must stay below composer so cancel/toggle stays clickable). */
export const MARK_REGION_OVERLAY_Z = 34;
/** Floating composer / generator shell while mark mode is active. */
export const MARK_COMPOSER_Z = 40;

export type SceneBox = { left: number; top: number; width: number; height: number };

export type MarkSessionTarget = {
  nodeId: string;
  box: SceneBox;
  node: SceneNodeInput;
  /** True → overlay present but box drawing blocked (not-allowed cursor only). */
  blocked: boolean;
};

export type MarkGateReason = 'not_image' | 'processing' | 'unavailable';

export type MarkNodeGate =
  | { status: 'ready' }
  | { status: 'disabled'; reason: MarkGateReason };

const MARK_BLOCKED_MEDIA = new Set(['video', 'audio', 'lottie']);

/** Scene keys that are never mark targets (containers / chrome). */
const MARK_SKIP_KEYS = new Set(['group', 'frame', 'artboard']);

export function isMarkBlockedMediaKey(key: unknown): boolean {
  return MARK_BLOCKED_MEDIA.has(String(key || ''));
}

/**
 * Single gate for toolbar / composer / session: only ready raster images mark.
 * Everything else is disabled (vectors, frames-as-nodes, video, empty generators…).
 */
export function markNodeGate(node: SceneNodeInput | null | undefined): MarkNodeGate {
  if (!node || String(node.key || '') !== 'image') {
    return { status: 'disabled', reason: 'not_image' };
  }
  if (String(node.attrs?.processStatus || '') === 'running') {
    return { status: 'disabled', reason: 'processing' };
  }
  const hasSrc = Boolean(String(node.attrs?.src || '').trim());
  if (!hasSrc) {
    return { status: 'disabled', reason: 'unavailable' };
  }
  return { status: 'ready' };
}

export function canMarkNode(node: SceneNodeInput | null | undefined): boolean {
  return markNodeGate(node).status === 'ready';
}

export function markGateTipKey(gate: MarkNodeGate): string {
  if (gate.status === 'ready') return 'editor.imageToolbar.mark';
  switch (gate.reason) {
    case 'processing':
      return 'editor.imageToolbar.markBlockedProcessing';
    case 'not_image':
      return 'editor.imageToolbar.markBlockedNotImage';
    case 'unavailable':
    default:
      return 'editor.imageToolbar.markBlockedUnavailable';
  }
}

export function nodeSceneBox(
  document: SceneDocument,
  node: SceneNodeInput | null | undefined
): SceneBox | null {
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  return {
    left,
    top,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

export function listCanvasImageNodes(
  document: SceneDocument
): Array<{ nodeId: string; box: SceneBox; node: SceneNodeInput }> {
  return listMarkSessionTargets(document)
    .filter((t) => !t.blocked)
    .map(({ nodeId, box, node }) => ({ nodeId, box, node }));
}

/**
 * While Mark is active: every visible scene node is a target.
 * - Ready images → interactive
 * - Everything else (vectors, text, video, processing images…) → blocked overlay
 */
export function listMarkSessionTargets(document: SceneDocument): MarkSessionTarget[] {
  const out: MarkSessionTarget[] = [];
  const dsl = document?.deltaSetLike || {};

  for (const nodeId of Object.keys(dsl)) {
    if (nodeId === 'ROOT') continue;
    const node = dsl[nodeId];
    if (!node) continue;
    const key = String(node.key || '');
    if (MARK_SKIP_KEYS.has(key)) continue;
    if (isNodeHidden(node)) continue;
    const box = nodeSceneBox(document, node);
    if (!box) continue;

    if (key === 'image') {
      const gate = markNodeGate(node);
      if (gate.status === 'ready') {
        out.push({ nodeId, box, node, blocked: false });
      } else {
        // Empty non-generator plates are not on canvas as real images — skip.
        if (gate.reason === 'unavailable' && !isImageGeneratorNode(node)) continue;
        out.push({ nodeId, box, node, blocked: true });
      }
      continue;
    }

    // Vectors / text / video / audio / lottie / … — show blocked plate, cannot mark.
    out.push({ nodeId, box, node, blocked: true });
  }
  return out;
}

export function markPromptFixedStyle(
  camera: RcbCamera,
  box: SceneBox,
  region: Pick<MarkRegion, 'x' | 'y' | 'w'>
) {
  const center = rcbSceneToScreen(
    camera,
    box.left + region.x + region.w / 2,
    box.top + region.y
  );
  return {
    position: 'fixed' as const,
    left: center.x,
    top: Math.max(72, center.y - 52),
    transform: 'translate(-50%, -100%)',
    zIndex: 9998,
  };
}
