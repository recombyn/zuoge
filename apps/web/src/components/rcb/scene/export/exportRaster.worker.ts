/**
 * OffscreenCanvas work off the main thread:
 * - encode: ImageBitmap → data URL (export / thumbnails)
 *
 * SVG decode stays on the main thread — browsers don't reliably decode SVG here.
 */

export type RasterEncodeRequest = {
  kind?: 'encode';
  id: number;
  bitmap: ImageBitmap;
  width: number;
  height: number;
  mime: string;
  quality?: number;
  transparent?: boolean;
  backgroundColor?: string;
};

export type RasterWorkerRequest = RasterEncodeRequest;

export type RasterEncodeResponse =
  | { id: number; ok: true; dataUrl: string }
  | { id: number; ok: false; error: string };

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

async function handleEncode(msg: RasterEncodeRequest): Promise<RasterEncodeResponse> {
  const id = msg.id ?? -1;
  const pw = Math.max(1, Math.round(Number(msg.width) || 1));
  const ph = Math.max(1, Math.round(Number(msg.height) || 1));
  const canvas = new OffscreenCanvas(pw, ph);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no-2d');
  if (!msg.transparent) {
    const bg = String(msg.backgroundColor || '').trim();
    ctx.fillStyle = bg && bg !== 'transparent' ? bg : '#ffffff';
    ctx.fillRect(0, 0, pw, ph);
  }
  const srcW = msg.bitmap.width;
  const srcH = msg.bitmap.height;
  const needsScale = srcW !== pw || srcH !== ph;
  ctx.imageSmoothingEnabled = needsScale;
  if (needsScale && 'imageSmoothingQuality' in ctx) {
    ctx.imageSmoothingQuality = 'high';
  }
  ctx.drawImage(msg.bitmap, 0, 0, pw, ph);
  msg.bitmap.close();
  const mime = String(msg.mime || 'image/png');
  const blob = await canvas.convertToBlob({
    type: mime,
    quality: typeof msg.quality === 'number' ? msg.quality : undefined,
  });
  const dataUrl = await blobToDataUrl(blob);
  return { id, ok: true, dataUrl };
}

self.onmessage = async (ev: MessageEvent<RasterWorkerRequest>) => {
  const msg = ev.data;
  const id = msg?.id ?? -1;
  try {
    const res = await handleEncode(msg as RasterEncodeRequest);
    self.postMessage(res);
  } catch (err) {
    try {
      const bitmap = (msg as RasterEncodeRequest)?.bitmap;
      bitmap?.close?.();
    } catch {
      /* ignore */
    }
    const res: RasterEncodeResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(res);
  }
};

export {};
