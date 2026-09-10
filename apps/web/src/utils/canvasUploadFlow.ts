/**
 * Shared canvas upload-placeholder flow (spawn node → upload → finish SoftGlow).
 */

import { formatProcessProgressLabel } from '@/components/rcb/scene/document/processJobAttrs';
import type { UploadedFileItem } from '@/service/upload';
import { finishImageProcess, patchDocumentNode } from '@/store/modules/editor';
import {
  beginNodeUpload,
  finishNodeUpload,
  uploadImageFile,
  uploadImageFromSrc,
  waitForImageReady,
  revokeNodePreviewSrc,
} from '@/utils/uploadImage';
import store from '@/store';

export function buildUploadFinishAttrs(
  nodeAttrs: Record<string, unknown> | undefined,
  uploaded: Pick<UploadedFileItem, 'key'>
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (uploaded.key) attrs.uploadKey = uploaded.key;
  const assetKind = String(nodeAttrs?.assetKind || '').trim();
  if (assetKind) attrs.assetKind = assetKind;
  const poster = String(nodeAttrs?.poster || '').trim();
  if (poster) attrs.poster = poster;
  const duration = Number(nodeAttrs?.duration);
  if (Number.isFinite(duration) && duration > 0) attrs.duration = duration;
  return attrs;
}

async function withManagedNodeUpload<T>(
  nodeId: string,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T | undefined> {
  const id = String(nodeId || '').trim();
  if (!id) return fn(new AbortController().signal);
  const signal = beginNodeUpload(id);
  try {
    return await fn(signal);
  } finally {
    finishNodeUpload(id);
  }
}

function finishPlaceholderUpload(
  nodeId: string,
  uploaded: UploadedFileItem,
  opts: {
    extraAttrs?: Record<string, unknown>;
    remoteReady?: boolean;
    waitDecode?: boolean;
  }
): void {
  const attrs = {
    ...(uploaded.key ? { uploadKey: uploaded.key } : {}),
    ...opts.extraAttrs,
  };
  const useRemote = opts.waitDecode === false || opts.remoteReady;
  // Only drop the local blob after a usable remote URL is applied — otherwise a
  // bad S3/public URL leaves a huge empty plate with a revoked blob: src.
  if (useRemote) {
    const doc = (store.getState() as { editor?: { document?: unknown } }).editor?.document;
    revokeNodePreviewSrc(doc as Parameters<typeof revokeNodePreviewSrc>[0], nodeId);
  }
  finishImageProcess({
    nodeId,
    ...(useRemote ? { src: uploaded.url } : {}),
    attrs,
  });
}

/** Local video poster → durable http URL so Kit idle paint survives blob revoke. */
async function resolveDurablePosterUrl(
  poster: string | undefined,
  signal: AbortSignal
): Promise<string | undefined> {
  const p = String(poster || '').trim();
  if (!p) return undefined;
  if (!p.startsWith('blob:') && !p.startsWith('data:')) return p;
  try {
    const uploaded = await uploadImageFromSrc(p, 'video-poster.jpg', { signal });
    const url = String(uploaded?.url || '').trim();
    return url || p;
  } catch {
    // Keep local still rather than finishing with no poster (black Kit plate).
    return p;
  }
}

async function withDurableVideoPosterAttrs(
  extraAttrs: Record<string, unknown> | undefined,
  signal: AbortSignal
): Promise<Record<string, unknown> | undefined> {
  if (!extraAttrs) return extraAttrs;
  const kind = String(extraAttrs.assetKind || '').trim().toLowerCase();
  if (kind !== 'video') return extraAttrs;
  const durable = await resolveDurablePosterUrl(
    extraAttrs.poster != null ? String(extraAttrs.poster) : undefined,
    signal
  );
  if (!durable) return extraAttrs;
  return { ...extraAttrs, poster: durable };
}

/** Upload a file for a spawned placeholder node. */
export async function uploadCanvasPlaceholderFile(opts: {
  nodeId: string;
  file: File;
  extraAttrs?: Record<string, unknown>;
  /** Default true — decode remote image before swapping off local preview. */
  waitDecode?: boolean;
}): Promise<boolean> {
  const id = String(opts.nodeId || '').trim();
  if (!id) return false;
  const waitDecode = opts.waitDecode !== false;

  const done = await withManagedNodeUpload(id, async (signal) => {
    const uploaded = await uploadImageFile(opts.file, {
      signal,
      nodeId: id,
      onProgress: (pct) => {
        if (signal.aborted) return;
        patchDocumentNode({
          nodeId: id,
          skipHistory: true,
          skipHostReload: true,
          patch: {
            attrs: { processLabel: formatProcessProgressLabel('上传中', pct, '上传中') },
          },
        });
      },
    });
    if (signal.aborted) return false;

    const remoteReady = waitDecode
      ? await waitForImageReady(uploaded.url, { signal })
      : true;
    if (signal.aborted) return false;

    const extraAttrs = await withDurableVideoPosterAttrs(opts.extraAttrs, signal);
    if (signal.aborted) return false;

    finishPlaceholderUpload(id, uploaded, {
      extraAttrs,
      remoteReady,
      waitDecode,
    });
    return true;
  });
  return done ?? false;
}

/** Upload a remote/data URL into a spawned placeholder node. */
export async function uploadCanvasPlaceholderSrc(opts: {
  nodeId: string;
  src: string;
  filename?: string;
  extraAttrs?: Record<string, unknown>;
}): Promise<boolean> {
  const id = String(opts.nodeId || '').trim();
  if (!id) return false;

  const done = await withManagedNodeUpload(id, async (signal) => {
    const uploaded = await uploadImageFromSrc(opts.src, opts.filename || 'upload.png', {
      signal,
      nodeId: id,
    });
    if (signal.aborted) return false;
    if (!uploaded?.url) throw new Error('upload returned no url');

    const remoteReady = await waitForImageReady(uploaded.url, { signal });
    if (signal.aborted) return false;

    const extraAttrs = await withDurableVideoPosterAttrs(opts.extraAttrs, signal);
    if (signal.aborted) return false;

    finishPlaceholderUpload(id, uploaded, {
      extraAttrs,
      remoteReady,
      waitDecode: true,
    });
    return true;
  });
  return done ?? false;
}
