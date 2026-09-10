/**
 * Rasterize Lottie → canvas stream → MediaRecorder, optional FFmpeg to MP4 / GIF.
 */
import lottie, { type AnimationItem } from 'lottie-web';
import { downloadFileBlob } from '@/components/rcb/scene/export/exportImage';
import { parseLottieAnimationData } from '@/components/rcb/scene/document/nodeFactories';
import { getFFmpeg } from '@/utils/audioExporter';
import { fetchFile } from '@ffmpeg/util';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { nodeNeedsPuppetWarp } from '@/components/editor/nodes/ImageNode/puppet/puppetModel';
import { bakePuppetDataUrlForNode } from '@/components/editor/nodes/ImageNode/puppet/puppetBake';
import {
  getAnimationWorkbenchPlayheadSec,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';

function pickRecorderMime(): { mime: string; ext: string } {
  const candidates: { mime: string; ext: string }[] = [
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
    { mime: 'video/mp4', ext: 'mp4' },
  ];
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mime)) {
      return c;
    }
  }
  return { mime: 'video/webm', ext: 'webm' };
}

function waitMs(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function safeBaseName(name: string | undefined, fallback: string) {
  return (
    String(name || fallback)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || fallback
  );
}

/** Record Lottie animation to a video Blob (usually WebM). */
export async function recordLottieToVideoBlob(opts: {
  animationData: unknown;
}): Promise<{ blob: Blob; mime: string; ext: string }> {
  const data = parseLottieAnimationData(opts.animationData);
  if (!data) throw new Error('invalid lottie');
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder unavailable');
  }

  const w = Math.max(32, Math.min(1920, Math.round(Number(data.w) || 400)));
  const h = Math.max(32, Math.min(1920, Math.round(Number(data.h) || 400)));
  const fr = Math.max(1, Math.min(60, Math.round(Number(data.fr) || 30)));
  const ip = Number(data.ip) || 0;
  const op = Number(data.op);
  const frameCount = Number.isFinite(op) && op > ip ? Math.max(1, Math.round(op - ip)) : fr * 2;
  const durationMs = Math.max(200, (frameCount / fr) * 1000);

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-9999px;top:0;width:${w}px;height:${h}px;overflow:hidden;pointer-events:none;opacity:0;`;
  document.body.appendChild(host);

  let anim: AnimationItem | null = null;
  try {
    anim = lottie.loadAnimation({
      container: host,
      renderer: 'canvas',
      loop: false,
      autoplay: false,
      animationData: structuredClone
        ? structuredClone(data)
        : JSON.parse(JSON.stringify(data)),
      rendererSettings: {
        clearCanvas: true,
        preserveAspectRatio: 'xMidYMid meet',
      },
    });

    await new Promise<void>((resolve) => {
      const onData = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        anim?.removeEventListener('data_ready', onData);
      };
      anim?.addEventListener('data_ready', onData);
      window.setTimeout(() => {
        cleanup();
        resolve();
      }, 4000);
    });

    const canvas = host.querySelector('canvas');
    if (!canvas) throw new Error('lottie canvas missing');

    const stream = canvas.captureStream(fr);
    const { mime, ext } = pickRecorderMime();
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
      recorder.onerror = () => reject(new Error('recorder error'));
    });

    recorder.start(100);
    anim.goToAndPlay(ip, true);

    const endAt = performance.now() + durationMs + 120;
    while (performance.now() < endAt) {
      await waitMs(32);
    }
    try {
      anim.goToAndStop(Math.max(ip, (Number.isFinite(op) ? op : ip + frameCount) - 1), true);
    } catch {
      /* ignore */
    }
    await waitMs(80);
    recorder.stop();
    stream.getTracks().forEach((t) => t.stop());

    const blob = await stopped;
    if (!blob.size) throw new Error('empty video');
    return { blob, mime, ext };
  } finally {
    try {
      anim?.destroy();
    } catch {
      /* ignore */
    }
    host.remove();
  }
}

async function convertVideoBlobWithFfmpeg(
  input: Blob,
  inputExt: string,
  outputExt: 'mp4' | 'gif'
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const id = Math.random().toString(36).slice(2, 8);
  const inName = `lin_${id}.${inputExt || 'webm'}`;
  const outName = `lout_${id}.${outputExt}`;
  await ffmpeg.writeFile(inName, await fetchFile(input));
  try {
    if (outputExt === 'gif') {
      // Palette for cleaner GIF; fps capped for size.
      await ffmpeg.exec([
        '-i',
        inName,
        '-vf',
        'fps=12,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop',
        '0',
        outName,
      ]);
    } else {
      await ffmpeg.exec([
        '-i',
        inName,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        '-an',
        outName,
      ]);
    }
    const data = (await ffmpeg.readFile(outName)) as Uint8Array;
    const mime = outputExt === 'gif' ? 'image/gif' : 'video/mp4';
    // Copy into a plain ArrayBuffer-backed view for Blob compatibility.
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new Blob([copy], { type: mime });
  } finally {
    try {
      await ffmpeg.deleteFile(inName);
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile(outName);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Prefer a real MP4 when the browser only recorded WebM (FFmpeg remux/transcode).
 * Falls back to the recorded blob if FFmpeg fails.
 */
async function ensureMp4Blob(recorded: {
  blob: Blob;
  mime: string;
  ext: string;
}): Promise<{ blob: Blob; ext: string }> {
  if (recorded.ext === 'mp4' || recorded.mime.includes('mp4')) {
    return { blob: recorded.blob, ext: 'mp4' };
  }
  try {
    const blob = await convertVideoBlobWithFfmpeg(recorded.blob, recorded.ext, 'mp4');
    if (blob.size > 0) return { blob, ext: 'mp4' };
  } catch (err) {
    console.warn('[lottie-video] mp4 convert failed, keeping recorded format', err);
  }
  return { blob: recorded.blob, ext: recorded.ext };
}

export async function downloadLottieAsVideo(opts: {
  animationData: unknown;
  baseName?: string;
}): Promise<'saved' | 'cancelled'> {
  const recorded = await recordLottieToVideoBlob({ animationData: opts.animationData });
  const { blob, ext } = await ensureMp4Blob(recorded);
  const base = safeBaseName(opts.baseName, 'animation');
  const filename = base.toLowerCase().endsWith(`.${ext}`) ? base : `${base}.${ext}`;
  const result = await downloadFileBlob(blob, filename);
  if (result === 'cancelled') return 'cancelled';
  if (result !== 'saved') throw new Error('download failed');
  return 'saved';
}

export async function downloadLottieAsGif(opts: {
  animationData: unknown;
  baseName?: string;
}): Promise<'saved' | 'cancelled'> {
  const recorded = await recordLottieToVideoBlob({ animationData: opts.animationData });
  let blob: Blob;
  try {
    blob = await convertVideoBlobWithFfmpeg(recorded.blob, recorded.ext, 'gif');
  } catch (err) {
    console.warn('[lottie-gif] convert failed', err);
    throw new Error('gif convert failed', { cause: err });
  }
  if (!blob.size) throw new Error('empty gif');
  const base = safeBaseName(opts.baseName, 'animation');
  const filename = base.toLowerCase().endsWith('.gif') ? base : `${base}.gif`;
  const result = await downloadFileBlob(blob, filename);
  if (result === 'cancelled') return 'cancelled';
  if (result !== 'saved') throw new Error('download failed');
  return 'saved';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Make Lottie JSON portable for external players: embed image assets as data URLs.
 * When `document` is provided, puppet-warped images bake at the current playhead
 * (external players cannot replay attrs.puppetTrack).
 */
export async function prepareLottieJsonForExport(
  animationData: unknown,
  opts?: {
    document?: SceneDocument | null;
    playheadSec?: number;
  }
): Promise<Record<string, unknown>> {
  const data = parseLottieAnimationData(animationData);
  if (!data) throw new Error('invalid lottie');
  const root = structuredClone
    ? (structuredClone(data) as Record<string, unknown>)
    : (JSON.parse(JSON.stringify(data)) as Record<string, unknown>);
  const assets = Array.isArray(root.assets) ? (root.assets as Record<string, unknown>[]) : [];
  const doc = opts?.document || null;
  const playheadSec =
    typeof opts?.playheadSec === 'number' && Number.isFinite(opts.playheadSec)
      ? opts.playheadSec
      : getAnimationWorkbenchPlayheadSec();
  const nextAssets: Record<string, unknown>[] = [];
  for (const raw of assets) {
    if (!raw || typeof raw !== 'object') {
      nextAssets.push(raw);
      continue;
    }
    const asset = { ...raw };
    const p = String(asset.p || '').trim();
    const u = String(asset.u || '').trim();
    const isImageAsset = Boolean(p) && !Array.isArray(asset.layers);
    if (isImageAsset && !p.startsWith('data:')) {
      const url = p.startsWith('http') || p.startsWith('blob:') || p.startsWith('/') ? p : `${u}${p}`;
      try {
        const res = await fetch(url);
        if (res.ok) {
          const blob = await res.blob();
          const dataUrl = await blobToDataUrl(blob);
          if (dataUrl.startsWith('data:')) {
            asset.p = dataUrl;
            asset.u = '';
            asset.e = 1;
          }
        }
      } catch {
        /* keep original path */
      }
    }

    const assetId = String(asset.id || '').trim();
    if (doc && assetId.startsWith('img_')) {
      const nodeId = assetId.slice(4);
      const node = doc.deltaSetLike?.[nodeId];
      if (node && nodeNeedsPuppetWarp(node)) {
        let fps = 30;
        const frameId = resolveAnimationFrameId(doc, node);
        if (frameId) {
          const frame = (doc.frames || []).find((f) => String(f?.id) === frameId);
          const n = Math.round(Number(frame?.fps) || 30);
          if (n > 0) fps = n;
        }
        const baked = await bakePuppetDataUrlForNode(node, {
          frame: secToFrame(playheadSec, fps),
          sourceDataUrl: String(asset.p || '').startsWith('data:')
            ? String(asset.p)
            : undefined,
        });
        if (baked) {
          asset.p = baked;
          asset.u = '';
          asset.e = 1;
        }
      }
    }
    nextAssets.push(asset);
  }
  root.assets = nextAssets;
  return root;
}
