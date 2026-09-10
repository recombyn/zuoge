/**
 * Pure helpers for Kit HTML selection chrome placement (toolbars / titles).
 * Pointer / hit-test / marquee stay in Kit InputManager — not here.
 */
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  isAnimationWorkbenchSelection,
  resolveAnimationFrameId,
} from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  isAudioGeneratorNode,
  isImageGeneratorNode,
  isLottieGeneratorNode,
  isAnimationFrameHostNode,
  isVideoGeneratorNode,
  isNodeHiddenInDocument,
  isTextFrameNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { parseNodeText } from '@/components/rcb/scene/document/sceneText';
import { liveShapeGeomBox } from './hostGeom';
import {
  deflateSelectionBox,
  inflateSelectionBox,
  strokeOuterClearanceScene,
} from '@/components/rcb/scene/document/sceneEffects';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { resolveControlChrome, getSelectionSharedRotation } from './resizeGeometry';
import type { SceneBox } from './alignGuides';
import {
  mediaTitleChrome,
  textFrameTitleChrome,
  readNodeAngle,
  resolveChromeUnion,
  resolveFrameChromeBox,
} from './selectionLogic';
import { frameSelId } from '@/components/rcb/frames/frameSceneQuery';

export function resolveSelectionChromeModel(opts: {
  document: SceneDocument;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  frameChromeMode: 'soft' | 'full';
  getNodeBox: (nodeId: string) => SceneBox | null;
  playheadSec?: number;
  lottieTimelineOpen?: boolean;
}) {
  const {
    document,
    selectedNodeIds,
    selectedFrameIds,
    frameChromeMode,
    getNodeBox,
    playheadSec,
    lottieTimelineOpen,
  } = opts;

  const selectionCount = selectedNodeIds.length + selectedFrameIds.length;
  const single = selectionCount === 1;
  const singleNode = selectedNodeIds.length === 1 && selectedFrameIds.length === 0;
  const singleId = singleNode ? selectedNodeIds[0] : null;
  const singleNodeData = singleId ? document?.deltaSetLike?.[singleId] : null;

  const fids = (() => {
    if (!selectedFrameIds.length) return [] as string[];
    if (selectedFrameIds.length > 1 || selectedNodeIds.length || frameChromeMode === 'full') {
      return selectedFrameIds;
    }
    return [] as string[];
  })();

  const nodeOrigins = selectedNodeIds
    .map((id) => {
      const box = getNodeBox(id);
      if (box) return { nodeId: id, box };
      const node = document?.deltaSetLike?.[id];
      if (!node) return null;
      const { left, top } = nodeLeftTop(document, node);
      return {
        nodeId: id,
        box: {
          left,
          top,
          width: Math.max(1, Number(node.width) || 1),
          height: Math.max(1, Number(node.height) || 1),
        },
      };
    })
    .filter(Boolean) as Array<{ nodeId: string; box: SceneBox }>;

  const frames = Array.isArray(document?.frames) ? document.frames : [];
  const frameOrigins = fids
    .map((fid) => {
      const f = frames.find((x: any) => x?.id === fid);
      if (!f) return null;
      return { nodeId: frameSelId(fid), box: resolveFrameChromeBox(fid, f) };
    })
    .filter(Boolean) as Array<{ nodeId: string; box: SceneBox }>;

  const origins = [...nodeOrigins, ...frameOrigins].map((o) => {
    if (String(o.nodeId).startsWith('__frame__:')) return o;
    const live = liveShapeGeomBox(o.nodeId);
    if (!live) return o;
    return {
      nodeId: o.nodeId,
      box: inflateSelectionBox(live, document?.deltaSetLike?.[o.nodeId]),
    };
  });

  const sharedRot =
    selectedNodeIds.length > 1
      ? getSelectionSharedRotation(document, selectedNodeIds)
      : 0;
  const selectionUnion = origins.length
    ? resolveControlChrome(
        document,
        origins,
        null,
        origins.length > 1 ? sharedRot : undefined
      ).box
    : null;

  let chromeAngle = 0;
  if (singleNode && singleId) chromeAngle = readNodeAngle(document, singleId);
  else if (!single) chromeAngle = sharedRot;

  const chromeUnion = resolveChromeUnion({
    transforming: false,
    liveUnion: selectionUnion,
    selectionUnion,
    selectedNodeIds,
    selectedFrameIds,
    document,
    multiGroupAngle: single ? 0 : chromeAngle,
  });

  const chromeGeomBox =
    chromeUnion && singleNodeData
      ? deflateSelectionBox(chromeUnion, singleNodeData)
      : chromeUnion;

  let strokeOuterScene = 0;
  if (singleNodeData) {
    strokeOuterScene = strokeOuterClearanceScene(singleNodeData);
  } else {
    for (const id of selectedNodeIds) {
      const n = document?.deltaSetLike?.[id];
      if (n) strokeOuterScene = Math.max(strokeOuterScene, strokeOuterClearanceScene(n));
    }
  }

  const selectionFullyHidden = Boolean(
    selectedNodeIds.length > 0 &&
      selectedNodeIds.every((id) => {
        const n = document?.deltaSetLike?.[id];
        return !n || isNodeHiddenInDocument(document, n, playheadSec);
      })
  );

  const isImageGen = Boolean(singleNodeData && isImageGeneratorNode(singleNodeData));
  const isVideoGen = Boolean(singleNodeData && isVideoGeneratorNode(singleNodeData));
  const isLottieGen = Boolean(singleNodeData && isLottieGeneratorNode(singleNodeData));
  const isAudioGen = Boolean(singleNodeData && isAudioGeneratorNode(singleNodeData));
  const isVideo = Boolean(
    singleNodeData && singleNodeData.key === 'video' && !isVideoGen
  );
  const isTextFrame = Boolean(singleNodeData && isTextFrameNode(singleNodeData));
  const processing = String(singleNodeData?.attrs?.processStatus || '') === 'running';
  const shapeType = String(singleNodeData?.attrs?.shapeType || '');
  const lineChrome = singleNode && (shapeType === 'line' || shapeType === 'arrow');

  const lottieMulti =
    !single &&
    isAnimationWorkbenchSelection(document, selectedNodeIds, selectedFrameIds);

  let toolbarNodeId: string | null = null;
  if (singleNode) toolbarNodeId = selectedNodeIds[0];
  else if (lottieMulti) toolbarNodeId = selectedNodeIds[selectedNodeIds.length - 1];

  const toolbarNode = toolbarNodeId
    ? document?.deltaSetLike?.[toolbarNodeId]
    : null;

  let titleChrome: ReturnType<typeof mediaTitleChrome> | ReturnType<
    typeof textFrameTitleChrome
  > | null = null;
  if (singleNodeData) {
    if (isTextFrame) {
      if (!resolveAnimationFrameId(document, singleNodeData)) {
        titleChrome = textFrameTitleChrome({
          name: singleNodeData.attrs?.name,
          plainText: parseNodeText(singleNodeData.attrs || {}),
        });
      }
    } else if (
      !isAnimationFrameHostNode(singleNodeData, document) &&
      !resolveAnimationFrameId(document, singleNodeData)
    ) {
      const surround = String(
        singleNodeData.attrs?.animationWorkbenchSurround || ''
      ).trim();
      if (!(lottieTimelineOpen && surround)) {
        titleChrome = mediaTitleChrome({
          key: singleNodeData.key,
          name: singleNodeData.attrs?.name,
          isImageGen,
          isVideoGen,
          isLottieGen,
          isAudioGen,
          isVideo,
        });
      }
    }
  }

  const titled =
    Boolean(singleNodeData) &&
    (isTextFrame ||
      ['image', 'video', 'lottie', 'audio'].includes(String(singleNodeData?.key || '')));

  return {
    single,
    singleNode,
    singleId,
    singleNodeData,
    chromeUnion,
    chromeGeomBox,
    chromeAngle,
    strokeOuterScene,
    selectionFullyHidden,
    processing,
    lineChrome: Boolean(lineChrome),
    toolbarNodeId,
    toolbarNode,
    titleChrome,
    titled,
    isTextFrame,
    isWorkbenchMulti: isAnimationWorkbenchSelection(
      document,
      selectedNodeIds,
      selectedFrameIds
    ),
  };
}

export function toolbarValueBox(
  preferred: SceneBox | null | undefined,
  node: SceneNodeInput | null | undefined
): SceneBox {
  if (preferred) {
    return {
      left: preferred.left,
      top: preferred.top,
      width: preferred.width,
      height: preferred.height,
    };
  }
  return {
    left: Number(node?.x) || 0,
    top: Number(node?.y) || 0,
    width: Math.max(1, Number(node?.width) || 1),
    height: Math.max(1, Number(node?.height) || 1),
  };
}
