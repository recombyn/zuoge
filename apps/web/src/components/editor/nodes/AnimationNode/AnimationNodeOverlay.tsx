import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';
/**
 * Lottie ink mounts into the node's nested SVG layer (lottie-web SVG renderer).
 * Preview and edit share the same SVG stack; preview is pointer-events:none.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode, memo } from 'react';
import { useSelector } from '@/store';
import { useSceneReloadToken } from '@/store/editorSelectors';
import lottie, { type AnimationItem } from 'lottie-web';
import {
  isAnimationFrameHostNode,
  isLottieNode,
  isNodeHidden,
  isWorkbenchNestedLottieNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { isHiddenByAnimationWorkbenchFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { parseLottieAnimationData } from '@/components/rcb/scene/document/nodeFactories';
import { animationHostHasUnlinkedInk } from '@/components/editor/nodes/AnimationNode/animationFrameSync';
import { isPrecompEditSessionNode } from '@/components/editor/nodes/AnimationNode/animationPrecompSession';
import {
  lottieNodeHasInkJson,
  resolveLottieInkJson,
} from '@/components/editor/nodes/AnimationNode/mainSceneLotPreview';
import type { MediaGeomOverride } from '@/components/editor/nodes/shared/mediaPlateGeometry';
import { useHtmlMediaMount } from '@/components/editor/nodes/useHtmlMediaMount';
import {
  getShapeHostNodeEpoch,
  subscribeShapeHost,
} from '@/components/rcb/shapes/shapeHostRegistry';
import store from '@/store';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';

export type LottieGeomOverride = MediaGeomOverride;

export type LottieHostApi = {
  play: () => void;
  pause: () => void;
  isPaused: () => boolean;
  setLoop: (loop: boolean) => void;
  setSpeed: (speed: number) => void;
  getSpeed: () => number;
  seek: (timeSec: number) => void;
  playFrom: (timeSec: number) => void;
  getCurrentTime: () => number;
  getDurationSec: () => number;
};

const lottieHosts = new Map<string, LottieHostApi>();

export function getLottieHost(nodeId: string): LottieHostApi | null {
  return lottieHosts.get(nodeId) || null;
}

/** Drive nested LOT plates on — —while the workbench timeline plays. */
export function syncFrameNestedLotLottieHosts(opts: {
  document: SceneDocument;
  frameHostId: string;
  timeSec: number;
  playing: boolean;
}) {
  const host = opts.document?.deltaSetLike?.[opts.frameHostId];
  if (!host) return;
  const frameId = resolveAnimationFrameId(opts.document, host);
  if (!frameId) return;
  for (const [id, node] of Object.entries(opts.document.deltaSetLike || {})) {
    if (!node || id === 'ROOT') continue;
    if (node.key !== 'lottie') continue;
    if (isAnimationFrameHostNode(node, opts.document)) continue;
    if (String(node.attrs?.frameId || '').trim() !== frameId) continue;
    if (node.attrs?.hidden === true || node.attrs?.hidden === 'true') continue;
    const api = getLottieHost(id);
    if (!api) continue;
    if (opts.playing) {
      if (api.isPaused()) api.playFrom(opts.timeSec);
      else api.seek(opts.timeSec);
    } else {
      api.seek(opts.timeSec);
      api.pause();
    }
  }
}

function readLoop(attrs: any): boolean {
  const raw = attrs?.lottieLoop;
  if (raw === false || raw === 'false' || raw === 0 || raw === '0') return false;
  return true;
}

function readSpeed(attrs: any): number {
  const n = Number(attrs?.lottieSpeed);
  if (Number.isFinite(n) && n > 0) return n;
  return 1;
}

function lottieFrameMetrics(anim: AnimationItem) {
  const fr = Math.max(1, Number(anim.frameRate) || 30);
  const total = Math.max(1, Number(anim.totalFrames) || 1);
  return { fr, total, durationSec: total / fr };
}

function lottieFrameAt(anim: AnimationItem, timeSec: number): number {
  const { fr, total } = lottieFrameMetrics(anim);
  return Math.max(0, Math.min(total - 1e-3, timeSec * fr));
}

function cloneAnimationData(data: Record<string, unknown>) {
  if (structuredClone) return structuredClone(data);
  return JSON.parse(JSON.stringify(data));
}

type EditorLottieState = {
  lottieTimelinePanel?: { nodeId?: string } | null;
  lottiePlayheadSec?: number;
  lottiePlaying?: boolean;
  lottiePlayingHostId?: string | null;
};

function readEditorLottieState(): EditorLottieState {
  return (store.getState()?.editor as EditorLottieState | undefined) ?? {};
}

function buildLottieHostApi(nodeId: string, anim: AnimationItem): LottieHostApi {
  const metrics = () => lottieFrameMetrics(anim);
  return {
    play: () => anim.play(),
    pause: () => anim.pause(),
    isPaused: () => Boolean(anim.isPaused),
    setLoop: (next) => {
      anim.loop = next;
    },
    setSpeed: (next) => anim.setSpeed(next),
    getSpeed: () => Number(anim.playSpeed) || 1,
    seek: (timeSec) => {
      anim.goToAndStop(lottieFrameAt(anim, timeSec), true);
    },
    playFrom: (timeSec) => {
      anim.goToAndPlay(lottieFrameAt(anim, timeSec), true);
    },
    getCurrentTime: () => {
      const { fr } = metrics();
      return Math.max(0, Number(anim.currentFrame) || 0) / fr;
    },
    getDurationSec: () => metrics().durationSec,
  };
}

function isPlayingHost(nodeId: string, hostId: string): boolean {
  return Boolean(hostId) && hostId === nodeId;
}

function isTimelineHost(nodeId: string, timelineHostId: string): boolean {
  return Boolean(timelineHostId) && timelineHostId === nodeId;
}

function LottiePlate({
  nodeId,
  animationJson,
  loop,
  speed,
  hidden,
  mount,
  paintEpoch,
}: {
  nodeId: string;
  animationJson: string;
  loop: boolean;
  speed: number;
  hidden?: boolean;
  mount: HTMLElement;
  /** Shape-host paint generation — SVG rebuild wipes mount; must reload like 主场景 first open. */
  paintEpoch: number;
}) {
  const animRef = useRef<AnimationItem | null>(null);
  const storePlaying = useSelector((s: any) => Boolean(s.editor.lottiePlaying));
  const playingHostId = useSelector((s: any) =>
    String(s.editor.lottiePlayingHostId || '').trim()
  );
  const timelineHostId = useSelector((s: any) =>
    String(s.editor.lottieTimelinePanel?.nodeId || '').trim()
  );

  // Never leave visibility:hidden on the shared SVG mount — LOT-tab hide used
  // to stick after remount and blank 主场景 even when JSON was intact.
  useEffect(() => {
    mount.style.removeProperty('visibility');
    return () => {
      mount.style.removeProperty('visibility');
    };
  }, [mount]);

  useEffect(() => {
    // While hidden, destroy — but LOT tab must not set hidden on nested lot (主场景 path).
    if (hidden) {
      // eslint-disable-next-line no-console
      console.warn(
        '[precomp-tab] lottie-ink',
        JSON.stringify({ nodeId, phase: 'hide-destroy', jsonLen: animationJson.length, paintEpoch })
      );
      const prev = animRef.current;
      if (prev) {
        prev.destroy();
        animRef.current = null;
      }
      if (lottieHosts.get(nodeId)) lottieHosts.delete(nodeId);
      mount.innerHTML = '';
      return undefined;
    }

    const data = parseLottieAnimationData(animationJson);
    if (!data) {
      // eslint-disable-next-line no-console
      console.warn(
        '[precomp-tab] lottie-ink PARSE FAIL',
        JSON.stringify({
          nodeId,
          jsonLen: animationJson.length,
          head: animationJson.slice(0, 200),
        })
      );
      return undefined;
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[precomp-tab] lottie-ink',
      JSON.stringify({
        nodeId,
        phase: 'load',
        jsonLen: animationJson.length,
        w: data.w,
        h: data.h,
        layers: Array.isArray(data.layers) ? data.layers.length : 0,
        paintEpoch,
      })
    );
    mount.innerHTML = '';
    let anim: AnimationItem;
    try {
      anim = lottie.loadAnimation({
        container: mount,
        renderer: 'svg',
        loop,
        autoplay: false,
        animationData: cloneAnimationData(data),
        rendererSettings: {
          preserveAspectRatio: 'xMidYMid meet',
          progressiveLoad: false,
          viewBoxOnly: false,
        },
      });
    } catch (err) {
      console.warn('[lottie] load failed', err);
      return undefined;
    }
    anim.setSpeed(speed);
    animRef.current = anim;
    const api = buildLottieHostApi(nodeId, anim);
    lottieHosts.set(nodeId, api);

    const editorState = readEditorLottieState();
    const timelineOwns =
      String(editorState.lottieTimelinePanel?.nodeId || '') === nodeId;
    const restoreSec = Math.max(0, Number(editorState.lottiePlayheadSec) || 0);
    const at = Math.min(restoreSec, api.getDurationSec());
    const playingHost = String(editorState.lottiePlayingHostId || '').trim();
    let hostMatches = timelineOwns;
    if (playingHost) hostMatches = isPlayingHost(nodeId, playingHost);
    if (editorState.lottiePlaying && hostMatches) api.playFrom(at);
    else api.seek(at);

    return () => {
      anim.destroy();
      animRef.current = null;
      if (lottieHosts.get(nodeId) === api) lottieHosts.delete(nodeId);
      mount.innerHTML = '';
      mount.style.removeProperty('visibility');
    };
    // paintEpoch: document/SVG rebuild clears mount without changing the element ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional (loop/speed via other effects)
  }, [mount, animationJson, nodeId, hidden, paintEpoch]);

  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return;
    anim.loop = loop;
  }, [loop]);

  useEffect(() => {
    const anim = animRef.current;
    if (!anim) return;
    anim.setSpeed(speed);
  }, [speed]);

  useEffect(() => {
    const api = lottieHosts.get(nodeId);
    if (!api) return;
    let mine = isTimelineHost(nodeId, timelineHostId);
    if (playingHostId) mine = isPlayingHost(nodeId, playingHostId);
    if (storePlaying && mine) {
      if (api.isPaused()) api.play();
      return;
    }
    if (!api.isPaused()) api.pause();
  }, [storePlaying, playingHostId, timelineHostId, nodeId, mount, animationJson, hidden]);

  useEffect(() => {
    if (hidden) return;
    const api = lottieHosts.get(nodeId);
    if (!api) return;
    const restoreSec = Math.max(0, Number(readEditorLottieState().lottiePlayheadSec) || 0);
    api.seek(restoreSec);
  }, [hidden, nodeId, mount, animationJson]);

  return null;
}

function shouldHideLottieInk(opts: {
  node: SceneNode;
  nodeId: string;
  frameHost: boolean;
  hidden?: boolean;
  precompAssetId: string;
  precompLotId: string;
  /** Unused for nested lot — destroying ink on LOT tab is what blanks 主场景 after switch. */
  precompSessionMaterialized: boolean;
}): boolean {
  const { node, nodeId, frameHost, hidden, precompAssetId, precompLotId } = opts;
  void opts.precompSessionMaterialized;
  if (frameHost && !animationHostHasUnlinkedInk(node.attrs?.animationData)) return true;
  if (hidden || isNodeHidden(node) || isHiddenByAnimationWorkbenchFocus(node)) return true;
  // 主场景 = no precomp → preview ink stays up.
  if (!precompAssetId) return false;
  if (isPrecompEditSessionNode(node)) return false;
  // LOT tab = edit session shapes, but nested lot LottiePlate must keep the same
  // live instance as 第一次打开时间轴. hide-destroy + sceneReload remount is what
  // leaves a blank selection after tab→主场景.
  if (precompLotId && nodeId === precompLotId) return false;
  if (frameHost) return true;
  if (String(node.attrs?.frameId || '').trim()) return true;
  return false;
}

function AnimationNodeOverlay({
  document,
  hidden,
  geometryOverrides = null,
}: {
  document: SceneDocument;
  hidden?: boolean;
  geometryOverrides?: Record<string, LottieGeomOverride> | null;
}): ReactNode {
  const sceneReloadToken = useSceneReloadToken();

  const ids = useMemo(() => {
    const children: string[] = document?.deltaSetLike?.ROOT?.children || [];
    return children.filter((id) => {
      const node = document?.deltaSetLike?.[id];
      return isLottieNode(node) && lottieNodeHasInkJson(document, id, node);
    });
  }, [document]);

  if (!ids.length) return null;

  return (
    <>
      {ids.map((nodeId) => (
        <LottiePlateHost
          key={`${nodeId}:${sceneReloadToken}`}
          nodeId={nodeId}
          document={document}
          hidden={hidden}
          geometryOverrides={geometryOverrides}
          reloadKey={String(sceneReloadToken)}
        />
      ))}
    </>
  );
}

function LottiePlateHost({
  nodeId,
  document,
  hidden,
  reloadKey = '',
}: {
  nodeId: string;
  document: SceneDocument;
  hidden?: boolean;
  geometryOverrides?: Record<string, LottieGeomOverride> | null;
  reloadKey?: string;
}) {
  const mount = useHtmlMediaMount(nodeId);
  const paintEpoch = useSyncExternalStore(
    (onStoreChange) => subscribeShapeHost(nodeId, onStoreChange),
    () => getShapeHostNodeEpoch(nodeId),
    () => 0
  );
  const precompEdit = useSelector(
    (s: any) =>
      s.editor.lottiePrecompEdit as null | {
        assetId?: string;
        lotNodeId?: string | null;
        sessionNodeIds?: string[];
        sessionHidesLotInk?: boolean;
      }
  );
  const node = document?.deltaSetLike?.[nodeId];
  if (!node || !(mount instanceof HTMLElement)) return null;

  const frameHost = isAnimationFrameHostNode(node, document);
  const workbenchNested = isWorkbenchNestedLottieNode(node, document);
  const precompAssetId = String(precompEdit?.assetId || '').trim();
  // 主场景 preview: nested LOT prefers host precomp asset JSON.
  const hostFallback = workbenchNested;
  const animationJson = resolveLottieInkJson(document, nodeId, node, { hostFallback });
  if (!animationJson || !parseLottieAnimationData(animationJson)) return null;

  let precompLotId = String(precompEdit?.lotNodeId || '').trim();
  if (!precompLotId && precompAssetId.startsWith('lot_')) {
    precompLotId = precompAssetId.slice(4);
  }
  const sessionMaterialized = Boolean(precompEdit?.sessionHidesLotInk);
  const hideInk = shouldHideLottieInk({
    node,
    nodeId,
    frameHost,
    hidden,
    precompAssetId,
    precompLotId,
    precompSessionMaterialized: sessionMaterialized,
  });
  const inkRevision = String(node.attrs?.lottieInkRevision ?? '');

  return (
    <LottiePlate
      key={`${nodeId}:${reloadKey}:${inkRevision}:${animationJson.length}`}
      nodeId={nodeId}
      animationJson={animationJson}
      loop={readLoop(node.attrs)}
      speed={readSpeed(node.attrs)}
      hidden={hideInk}
      mount={mount}
      paintEpoch={paintEpoch}
    />
  );
}

export default memo(AnimationNodeOverlay);
