/**
 * Scrub playhead → live-update 动画工作台 scene children.
 * DOM apply is event-driven (`requestPlayheadSceneApply`) — no document watchers.
 * LOT-tab document pose bake happens in the editor reducer on enter / setPlayhead.
 */
import { useEffect, type ReactNode, memo } from 'react';
import { isAnimationFrameHostNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { applyAnimationPlayheadScenePose } from '@/components/editor/nodes/AnimationNode/animationPlayheadSceneApply';
import {
  RCB_ANIMATION_PLAYHEAD_APPLY,
} from '@/components/editor/nodes/AnimationNode/animationPlayheadApplyEvent';
import { resolveLottiePlayheadHostId } from '@/components/editor/nodes/AnimationNode/resolveLottiePlayheadHostId';
import {
  getAnimationPlayheadSec,
  getAnimationPlaying,
  getAnimationPlayingHostId,
} from '@/components/editor/nodes/AnimationNode/animationTransport';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { isPlayheadScenePoseBlocked } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import store from '@/store';
import type { SceneDocument } from '@/components/rcb/sceneNode';

function listAnimationFrameHostIds(document: SceneDocument | null | undefined): string[] {
  const out: string[] = [];
  const map = document?.deltaSetLike;
  if (!map) return out;
  for (const id of Object.keys(map)) {
    if (id === 'ROOT') continue;
    const node = map[id];
    if (node?.key === 'lottie' && isAnimationFrameHostNode(node, document)) {
      out.push(id);
    }
  }
  return out;
}

function applyFromStore() {
  if (isPlayheadScenePoseBlocked()) return;
  const editor = (store.getState() as { editor?: any }).editor;
  if (!editor) return;
  const document = editor.document as SceneDocument | null | undefined;
  if (!document) return;
  const playhead = getAnimationPlayheadSec() || Number(editor.lottiePlayheadSec) || 0;
  const playing = getAnimationPlaying() || Boolean(editor.lottiePlaying);
  const playingHostId =
    getAnimationPlayingHostId() || String(editor.lottiePlayingHostId || '').trim();
  const hostNodeId = resolveLottiePlayheadHostId(editor);
  const host = hostNodeId ? document.deltaSetLike?.[hostNodeId] : null;
  const primaryActive =
    Boolean(host) &&
    host?.key === 'lottie' &&
    isAnimationFrameHostNode(host, document);

  if (primaryActive && hostNodeId) {
    applyAnimationPlayheadScenePose({
      document,
      hostNodeId,
      playheadSec: playhead,
      applyGeometry: true,
    });
    for (const id of listAnimationFrameHostIds(document)) {
      if (id === hostNodeId) continue;
      applyAnimationPlayheadScenePose({
        document,
        hostNodeId: id,
        playheadSec: 0,
        applyGeometry: false,
      });
    }
    return;
  }

  const playingNode = playingHostId ? document.deltaSetLike?.[playingHostId] : null;
  const foreignPlay =
    playing &&
    playingHostId &&
    playingNode?.key === 'lottie' &&
    !isAnimationFrameHostNode(playingNode, document);

  for (const id of listAnimationFrameHostIds(document)) {
    applyAnimationPlayheadScenePose({
      document,
      hostNodeId: id,
      playheadSec: foreignPlay ? 0 : playhead,
      applyGeometry: false,
    });
  }
}

/** Mount once; applies only when `requestPlayheadSceneApply` fires. */
function AnimationPlayheadSceneSync(_props: { document: SceneDocument }): ReactNode {
  useEffect(() => {
    const onApply = () => applyFromStore();
    window.addEventListener(RCB_ANIMATION_PLAYHEAD_APPLY, onApply);
    onApply();
    return () => {
      window.removeEventListener(RCB_ANIMATION_PLAYHEAD_APPLY, onApply);
      // Drop scrub TransformPreview so Kit bake / chrome return to document.
      clearNodeTransformPreviews();
    };
  }, []);

  return null;
}

export default memo(AnimationPlayheadSceneSync);
