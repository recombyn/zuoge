import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  memo,
} from 'react';
import { createPortal } from 'react-dom';
import { isVideoNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { usePlayableVideoSrc } from '@/components/editor/nodes/VideoNode/VideoJsPlayer';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import VideoPlaybackBar, {
  videoMediaFromElement,
  videoChromeLayout,
  VIDEO_PLAYBACK_BAR_H,
  type VideoMediaControl,
} from '@/components/editor/nodes/VideoNode/VideoPlaybackBar';
import { VideoFullscreenPreview } from '@/components/editor/nodes/VideoNode/VideoFullscreenPreviewButton';
import { waitForVideoFrame } from '@/components/editor/nodes/VideoNode/waitForVideoFrame';
import {
  clearVideoIdlePaintFrame,
  setVideoIdlePaintFrame,
} from '@/components/rcb/render/videoIdlePaintFrame';
import {
  bumpSceneCanvasIdlePaint,
  getFillImageReady,
} from '@/components/rcb/render/sceneRenderer';
import {
  getSharedSceneRenderBuffer,
  markSoaDirtyById,
} from '@/components/rcb/render/sceneRenderBuffer';

function pointInRect(x: number, y: number, r: DOMRect) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function readCropNorm(opts: {
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
}): { x: number; y: number; w: number; h: number } | null {
  const x = Number(opts.cropX);
  const y = Number(opts.cropY);
  const w = Number(opts.cropW);
  const h = Number(opts.cropH);
  if (
    ![x, y, w, h].every(Number.isFinite) ||
    !(w > 0) ||
    !(h > 0) ||
    (x === 0 && y === 0 && w === 1 && h === 1)
  ) {
    return null;
  }
  return { x, y, w, h };
}

function mediaCropStyle(crop: { x: number; y: number; w: number; h: number } | null): CSSProperties {
  // Tailwind preflight sets `video, img { max-width: 100%; height: auto }` which
  // caps crop zoom (width > 100%) and collapses height — crop then looks like a
  // thin/shifted strip instead of the selected region.
  if (!crop) {
    return {
      position: 'absolute',
      left: 0,
      top: 0,
      width: '100%',
      height: '100%',
      maxWidth: 'none',
      maxHeight: 'none',
      objectFit: 'fill',
    };
  }
  return {
    position: 'absolute',
    left: `${(-crop.x / crop.w) * 100}%`,
    top: `${(-crop.y / crop.h) * 100}%`,
    width: `${(1 / crop.w) * 100}%`,
    height: `${(1 / crop.h) * 100}%`,
    maxWidth: 'none',
    maxHeight: 'none',
    objectFit: 'fill',
  };
}

/** Freeze the current decoded video frame as a JPEG data URL. */
export function captureFrameFromVideoEl(video: HTMLVideoElement): string | null {
  if (video.readyState < 2) return null;
  const w = Math.max(1, video.videoWidth || 1);
  const h = Math.max(1, video.videoHeight || 1);
  if (w <= 1 || h <= 1) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    return null;
  }
}

type VideoHoverHost = {
  getVideo: () => HTMLVideoElement | null;
  getWrap: () => HTMLElement | null;
  getFreezeUrl: () => string;
  getFreezeAt: () => number;
  getMediaTime: () => number;
};

const videoHoverHosts = new Map<string, VideoHoverHost>();

/** App-wide single HTML `<video>` decoder — reparented into the active plate FO. */
let sharedVideoEl: HTMLVideoElement | null = null;
let sharedVideoOwnerId: string | null = null;

function createSharedVideoEl(): HTMLVideoElement {
  const el = document.createElement('video');
  el.className = 'pointer-events-none absolute block';
  el.playsInline = true;
  el.preload = 'auto';
  // Sound on by default — user can mute from the playback bar.
  el.muted = false;
  el.draggable = false;
  el.controls = false;
  return el;
}

function attachSharedVideo(nodeId: string, wrap: HTMLElement): HTMLVideoElement {
  if (!sharedVideoEl) sharedVideoEl = createSharedVideoEl();
  const id = String(nodeId);
  if (sharedVideoOwnerId && sharedVideoOwnerId !== id) {
    try {
      if (!sharedVideoEl.paused) sharedVideoEl.pause();
    } catch {
      /* ignore */
    }
  }
  sharedVideoOwnerId = id;
  if (sharedVideoEl.parentElement !== wrap) {
    wrap.appendChild(sharedVideoEl);
  }
  return sharedVideoEl;
}

function detachSharedVideo(nodeId: string) {
  if (sharedVideoOwnerId !== String(nodeId)) return;
  try {
    if (sharedVideoEl && !sharedVideoEl.paused) sharedVideoEl.pause();
  } catch {
    /* ignore */
  }
  sharedVideoEl?.remove();
  sharedVideoOwnerId = null;
}

/** Which video node owns the sole HTML decoder (trim panel → last selected → sole on board). */
export function resolveActiveVideoDecoderId(opts: {
  document: SceneDocument | null | undefined;
  selectedNodeIds: readonly string[];
  videoToolPanel?: null | { nodeId: string; kind?: string };
}): string | null {
  const { document, selectedNodeIds, videoToolPanel } = opts;
  const children: string[] = document?.deltaSetLike?.ROOT?.children || [];

  const videoWithSrc = (id: string): boolean => {
    const node = document?.deltaSetLike?.[id];
    if (!isVideoNode(node)) return false;
    return Boolean(String(node?.attrs?.src || '').trim());
  };

  const trimId = String(videoToolPanel?.nodeId || '').trim();
  if (trimId && videoWithSrc(trimId)) return trimId;

  const selectedVideos = selectedNodeIds.map(String).filter(Boolean).filter(videoWithSrc);
  if (selectedVideos.length > 0) {
    return selectedVideos[selectedVideos.length - 1];
  }

  const onBoard = children.filter(videoWithSrc);
  if (onBoard.length === 1) return onBoard[0];
  return null;
}

/** Test hook — confirms only one decoder element exists app-wide. */
export function getSharedVideoElement(): HTMLVideoElement | null {
  return sharedVideoEl;
}

/** Live plate host registered by VideoHoverPlayback (blob-backed `<video>`). */
export function getVideoHoverHost(nodeId: string): VideoHoverHost | null {
  return videoHoverHosts.get(String(nodeId)) || null;
}

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

type ScenePlate = CSSProperties & {
  left: number;
  top: number;
  width: number;
  height: number;
};

type VideoHoverPlaybackProps = {
  nodeId: string;
  scenePlate: ScenePlate;
  zoom: number;
  /** Portal into shared SVG layer mount (unified stackOrder). */
  svgMount?: HTMLElement | null;
  src: string;
  poster?: string;
  uploadKey?: string | null;
  hidden?: boolean;
  /** Hide playback bar / fullscreen chrome (e.g. while crop session is open). */
  hideChrome?: boolean;
  flipX?: boolean;
  flipY?: boolean;
  trimStart?: number;
  trimEnd?: number;
  /** Stored media length (seconds) from node attrs. */
  knownDuration?: number;
  cropX?: number;
  cropY?: number;
  cropW?: number;
  cropH?: number;
};

/**
 * Playing → live `<video>`.
 * Paused → freeze-frame `<img>` only when it matches currentTime (scrubber);
 * otherwise keep the paused `<video>` so seek/switch lands on the right frame.
 */
function VideoHoverPlayback({
  nodeId,
  scenePlate,
  zoom,
  svgMount = null,
  src,
  poster,
  uploadKey,
  hidden,
  hideChrome = false,
  trimStart,
  trimEnd,
  knownDuration,
  flipX,
  flipY,
  cropX,
  cropY,
  cropW,
  cropH,
}: VideoHoverPlaybackProps): ReactNode {
  const plateRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const freezeGenRef = useRef(0);
  const freezeUrlRef = useRef(String(poster || '').trim());
  const freezeAtRef = useRef(0);
  const mediaTimeRef = useRef(0);
  /** Track mount — public URLs set playSrc before the <video> ref exists. */
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [media, setMedia] = useState<VideoMediaControl | null>(null);
  const crop = readCropNorm({ cropX, cropY, cropW, cropH });
  const cropStyle = mediaCropStyle(crop);
  const [barHovered, setBarHovered] = useState(false);
  const [plateHovered, setPlateHovered] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fsOpen, setFsOpen] = useState(false);
  /** Mirrors video.currentTime so scrubber vs freeze can diverge and show live video. */
  const [mediaTime, setMediaTime] = useState(0);
  /** Frozen still + the mediaTime it was captured at (atlas / demoted fallback). */
  const [freeze, setFreeze] = useState<{ url: string; at: number }>(() => {
    const p = String(poster || '').trim();
    // blob: posters are revoked across refresh — never seed the freeze <img> with them.
    if (!p || p.startsWith('blob:')) return { url: '', at: -999 };
    return { url: p, at: 0 };
  });
  const playSrc = usePlayableVideoSrc(src, uploadKey);
  const showUi = !hidden;
  const z = Math.max(0.05, zoom || 1);
  const posterUrl = String(poster || '').trim();
  const capturingFreezeRef = useRef(false);
  freezeUrlRef.current = freeze.url;
  freezeAtRef.current = freeze.at;
  mediaTimeRef.current = mediaTime;
  const showUiRef = useRef(showUi);
  showUiRef.current = showUi;

  // Flip media pixels only — group flip is suppressed for HTML video FO so the
  // playback bar stays on the plate bottom (see hostIsolatesHtmlMediaFlip).
  const mediaFlip =
    flipX || flipY
      ? (`scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` as const)
      : undefined;

  useEffect(() => {
    const id = String(nodeId);
    videoHoverHosts.set(id, {
      getVideo: () => (sharedVideoOwnerId === id ? videoRef.current : null),
      getWrap: () => videoWrapRef.current,
      getFreezeUrl: () => freezeUrlRef.current,
      getFreezeAt: () => freezeAtRef.current,
      getMediaTime: () => mediaTimeRef.current,
    });
    return () => {
      videoHoverHosts.delete(id);
    };
  }, [nodeId]);

  // Single app-wide decoder — reparent into this plate's wrap when mounted.
  useEffect(() => {
    const wrap = videoWrapRef.current;
    if (!wrap || !svgMount) return;
    const el = attachSharedVideo(nodeId, wrap);
    videoRef.current = el;
    setVideoEl(el);
    return () => {
      detachSharedVideo(nodeId);
      if (videoRef.current === el) videoRef.current = null;
      setVideoEl(null);
    };
  }, [nodeId, svgMount]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || sharedVideoOwnerId !== String(nodeId)) return;
    const flipStyle: CSSProperties = mediaFlip
      ? { transform: mediaFlip, transformOrigin: 'center center' }
      : {};
    Object.assign(el.style, {
      ...cropStyle,
      background: '#111827',
      colorScheme: 'only light',
      ...flipStyle,
    });
  }, [nodeId, cropStyle, mediaFlip, cropX, cropY, cropW, cropH, flipX, flipY]);

  useEffect(() => {
    const next = String(poster || '').trim();
    if (!next || next.startsWith('blob:')) return;
    setFreeze((prev) => (prev.url ? prev : { url: next, at: 0 }));
  }, [poster]);

  // Bind src once — never via React `src={}`. Re-run when the element mounts.
  useEffect(() => {
    const el = videoEl;
    if (!el || !playSrc) return;
    if (el.getAttribute('src') === playSrc || el.currentSrc === playSrc) return;
    try {
      if (el.currentSrc && new URL(el.currentSrc).href === new URL(playSrc, window.location.href).href) {
        return;
      }
    } catch {
      /* ignore */
    }
    freezeGenRef.current += 1;
    // Prefer empty over revoked blob poster — live <video> paints the FO plate.
    setFreeze({
      url: posterUrl && !posterUrl.startsWith('blob:') ? posterUrl : '',
      at: posterUrl && !posterUrl.startsWith('blob:') ? 0 : -999,
    });
    clearVideoIdlePaintFrame(String(nodeId));
    el.src = playSrc;
  }, [playSrc, posterUrl, videoEl, nodeId]);

  useEffect(() => {
    const el = videoEl;
    if (!el) return;
    setMedia(videoMediaFromElement(el));
  }, [videoEl]);

  // Capture still for atlas demotion / extract-frame host API.
  // Do NOT drive the FO plate with this still while we own the shared decoder —
  // paused <video> already shows currentTime; covering it with a freeze <img>
  // (often a stale first frame after RVFC) is what made pause/scrub look stuck.
  useEffect(() => {
    const el = videoRef.current as VideoWithFrameCallback | null;
    if (!el) return;
    const id = String(nodeId);

    const freezeNow = () => {
      if (!el.paused && !el.ended) return;
      if (capturingFreezeRef.current) return;
      const gen = ++freezeGenRef.current;
      void (async () => {
        capturingFreezeRef.current = true;
        const wrap = videoWrapRef.current;
        const prevVis = wrap?.style.visibility;
        if (wrap && showUiRef.current) wrap.style.visibility = 'visible';
        const target = Number(el.currentTime) || 0;
        try {
          // Nudge then restore — paused RVFC alone often redraws the previous bitmap.
          const nudge =
            target <= 0.02 ? Math.min(0.05, Math.max(0.02, (Number(el.duration) || 1) * 0.01)) : target;
          if (Math.abs((Number(el.currentTime) || 0) - nudge) > 0.01) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                el.removeEventListener('seeked', done);
                window.clearTimeout(timer);
                resolve();
              };
              const timer = window.setTimeout(done, 220);
              el.addEventListener('seeked', done);
              try {
                el.currentTime = nudge;
              } catch {
                done();
              }
            });
          }
          if (Math.abs((Number(el.currentTime) || 0) - target) > 0.01) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const done = () => {
                if (settled) return;
                settled = true;
                el.removeEventListener('seeked', done);
                window.clearTimeout(timer);
                resolve();
              };
              const timer = window.setTimeout(done, 220);
              el.addEventListener('seeked', done);
              try {
                el.currentTime = target;
              } catch {
                done();
              }
            });
          }
          await waitForVideoFrame(el);
          await waitForVideoFrame(el);
          if (gen !== freezeGenRef.current) return;
          const shot = captureFrameFromVideoEl(el);
          if (!shot) return;
          const at = Number(el.currentTime) || target;
          setMediaTime(at);
          setFreeze({ url: shot, at });
          setVideoIdlePaintFrame(id, shot, at);
          getFillImageReady(shot);
          markSoaDirtyById(getSharedSceneRenderBuffer(), id);
          bumpSceneCanvasIdlePaint();
        } finally {
          capturingFreezeRef.current = false;
          if (wrap) {
            // FO plate keeps the decoder visible; don't restore a freeze-era hidden wrap.
            wrap.style.visibility = showUiRef.current ? 'visible' : prevVis || 'hidden';
          }
        }
      })();
    };

    const onPause = () => freezeNow();
    const onSeeked = () => {
      if (capturingFreezeRef.current) return;
      freezeNow();
    };
    const onLoaded = () => freezeNow();
    el.addEventListener('pause', onPause);
    el.addEventListener('seeked', onSeeked);
    el.addEventListener('loadeddata', onLoaded);
    const syncTime = () => setMediaTime(Number(el.currentTime) || 0);
    el.addEventListener('timeupdate', syncTime);
    el.addEventListener('seeked', syncTime);
    freezeNow();
    syncTime();
    return () => {
      el.removeEventListener('pause', onPause);
      el.removeEventListener('seeked', onSeeked);
      el.removeEventListener('loadeddata', onLoaded);
      el.removeEventListener('timeupdate', syncTime);
      el.removeEventListener('seeked', syncTime);
      freezeGenRef.current += 1;
      capturingFreezeRef.current = false;
    };
  }, [playSrc, nodeId]);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const plate = plateRef.current;
      if (!plate || !showUi) {
        setPlateHovered(false);
        return;
      }
      setPlateHovered(pointInRect(e.clientX, e.clientY, plate.getBoundingClientRect()));
    };
    const onLeave = () => setPlateHovered(false);
    document.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('blur', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', onLeave);
    };
  }, [showUi, scenePlate.left, scenePlate.top, scenePlate.width, scenePlate.height]);

  useEffect(() => {
    if (!media || media.isDead()) {
      setPlaying(false);
      return;
    }
    const sync = () => {
      try {
        setPlaying(!media.isPaused());
      } catch {
        setPlaying(false);
      }
    };
    sync();
    media.on('play', sync);
    media.on('pause', sync);
    media.on('ended', sync);
    return () => {
      media.off('play', sync);
      media.off('pause', sync);
      media.off('ended', sync);
    };
  }, [media]);

  if (!src) return null;
  // Wait for SVG foreignObject mount so we never fall back to a parallel CSS stack.
  if (!svgMount) return null;

  // Still only when this plate does NOT own the live decoder (demoted / no FO).
  // Owning the decoder: always paint through <video> — pause/scrub seek the element.
  const ownsDecoder = sharedVideoOwnerId === String(nodeId) && Boolean(videoEl);
  const freezeMatches =
    Boolean(freeze.url) &&
    !freeze.url.startsWith('blob:') &&
    Math.abs(mediaTime - freeze.at) <= 0.12;
  const showStill = !playing && freezeMatches && !ownsDecoder;
  const showVideo = ownsDecoder || playing || !showStill;
  const barVisible = showUi && !hideChrome && (plateHovered || barHovered || playing);
  // Layout must match FO box (drag-base while CSS-scale resizing), not the visual
  // chrome size — otherwise scrubber/video sit mid-plate during live resize.
  const layoutW = Math.max(1, scenePlate.width);
  const layoutH = Math.max(1, scenePlate.height);
  const screenW = Math.max(1, layoutW * z);
  const screenH = Math.max(1, layoutH * z);
  const chrome = videoChromeLayout(screenW, screenH);
  const mediaFlipStyle: CSSProperties = mediaFlip
    ? { transform: mediaFlip, transformOrigin: 'center center' }
    : {};

  const plate = (
    <div
      ref={plateRef}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        borderRadius: scenePlate.borderRadius,
        // opacity — not visibility. Child visibility:visible punches through
        // parent visibility:hidden (freeze / playing video wrap).
        opacity: showUi ? 1 : 0,
        colorScheme: 'only light',
      }}
      aria-hidden={showUi ? undefined : true}
      data-video-hover-plate=""
      data-video-node-id={nodeId}
    >
      {showStill ? (
        <img
          src={freeze.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute"
          style={{
            ...cropStyle,
            ...mediaFlipStyle,
          }}
        />
      ) : null}

      <div
        ref={videoWrapRef}
        className="pointer-events-none absolute left-0 top-0 overflow-hidden"
        style={{
          width: layoutW * z,
          height: layoutH * z,
          transform: `scale(${1 / z})`,
          transformOrigin: '0 0',
          visibility: showUi && showVideo ? 'visible' : 'hidden',
        }}
      />

      {showUi && !hideChrome && chrome.visible ? (
        // Full plate + overflow visible so the vertical volume slider above mute isn’t clipped
        // by a bar-height-only wrapper (overflow-hidden + short height hid it entirely).
        // Use inset-0 (not scenePlate W×H): during live resize the FO box is authoritative;
        // an explicit smaller box left the scrubber mid-plate when CSS scale was used.
        <div className="pointer-events-none absolute inset-0 z-[2] overflow-visible">
          <div
            className="pointer-events-none absolute bottom-0 left-0 overflow-visible"
            style={{
              width: chrome.layoutW,
              height: VIDEO_PLAYBACK_BAR_H,
              transform: `scale(${chrome.fit / z})`,
              transformOrigin: '0 100%',
            }}
          >
            <VideoPlaybackBar
              nodeId={nodeId}
              media={media}
              visible={barVisible}
              trimStart={trimStart}
              trimEnd={trimEnd}
              knownDuration={knownDuration}
              scale={1}
              onFullscreen={() => setFsOpen(true)}
              className="pointer-events-auto absolute inset-x-0 bottom-0"
              onHoverChange={setBarHovered}
            />
          </div>
        </div>
      ) : null}

      <VideoFullscreenPreview
        open={fsOpen}
        onClose={() => setFsOpen(false)}
        src={src}
        poster={poster}
        uploadKey={uploadKey}
        aspectWidth={layoutW}
        aspectHeight={layoutH}
        cropX={cropX}
        cropY={cropY}
        cropW={cropW}
        cropH={cropH}
        trimStart={trimStart}
        trimEnd={trimEnd}
        flipX={flipX}
        flipY={flipY}
        duration={knownDuration}
      />
    </div>
  );

  return createPortal(plate, svgMount);
}

function propsEqual(prev: VideoHoverPlaybackProps, next: VideoHoverPlaybackProps): boolean {
  return (
    prev.nodeId === next.nodeId &&
    prev.zoom === next.zoom &&
    prev.svgMount === next.svgMount &&
    prev.src === next.src &&
    prev.poster === next.poster &&
    prev.uploadKey === next.uploadKey &&
    prev.hidden === next.hidden &&
    prev.hideChrome === next.hideChrome &&
    prev.trimStart === next.trimStart &&
    prev.trimEnd === next.trimEnd &&
    prev.knownDuration === next.knownDuration &&
    prev.flipX === next.flipX &&
    prev.flipY === next.flipY &&
    prev.cropX === next.cropX &&
    prev.cropY === next.cropY &&
    prev.cropW === next.cropW &&
    prev.cropH === next.cropH &&
    prev.scenePlate.left === next.scenePlate.left &&
    prev.scenePlate.top === next.scenePlate.top &&
    prev.scenePlate.width === next.scenePlate.width &&
    prev.scenePlate.height === next.scenePlate.height &&
    prev.scenePlate.borderRadius === next.scenePlate.borderRadius &&
    prev.scenePlate.transform === next.scenePlate.transform
  );
}

export default memo(VideoHoverPlayback, propsEqual);
