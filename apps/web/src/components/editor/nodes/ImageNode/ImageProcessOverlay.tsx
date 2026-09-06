import { useSyncExternalStore, type ReactNode, memo } from 'react';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { ProcessGlowShell } from '@/components/rcb/process/ProcessGlowShell';
import { liveShapeGeomBox } from '@/components/rcb/selection/HostPathChrome';
import {
  hasNodeTransformPreviews,
  subscribeTransformPreview,
} from '@/components/rcb/core/transformPreview';
import {
  hasLiveArtboardFrameGeometry,
  subscribeLiveArtboardFrameGeometry,
} from '@/components/rcb/frames/HtmlArtboardFrame';

function subscribeProcessPillHide(listener: () => void): () => void {
  const a = subscribeTransformPreview(listener);
  const b = subscribeLiveArtboardFrameGeometry(listener);
  return () => {
    a();
    b();
  };
}

function processPillShouldHide(): boolean {
  return hasNodeTransformPreviews() || hasLiveArtboardFrameGeometry();
}

/**
 * Status pill for a node whose `attrs.processStatus === 'running'`.
 * Gradient is SVG-native on the process plate; the label docks on the overlay
 * like selection titles / toolbars (screen-constant gap, never FO-clipped).
 * Hidden while drag/resize or plate move — same as titles / toolbars.
 */
export function NodeProcessGlow({
  nodeId,
  node,
}: {
  nodeId: string;
  node: SceneNodeInput;
  /** Kept for call-site compat; label no longer portals into the SVG host. */
  paintHost?: SVGElement | null;
}): ReactNode {
  const hide = useSyncExternalStore(
    subscribeProcessPillHide,
    processPillShouldHide,
    () => false
  );
  if (hide) return null;

  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const geom = liveShapeGeomBox(nodeId) || {
    left: Number(node.x) || 0,
    top: Number(node.y) || 0,
    width: w,
    height: h,
  };
  const angle = Number(node.attrs?.angle) || 0;
  const label = String(node.attrs?.processLabel || '处理中');

  return (
    <ProcessGlowShell
      seed={nodeId}
      label={label}
      box={geom}
      angle={angle}
      labelDataAttr="data-image-process-label"
    />
  );
}

export default memo(NodeProcessGlow);
