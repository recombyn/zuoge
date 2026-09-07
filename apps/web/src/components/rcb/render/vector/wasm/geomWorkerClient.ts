/**
 * Client for geom Worker (batch fill + text glyph contour/simplify).
 */
import type { Vec2 } from '@/components/rcb/render/vector/contour';
import type { FillMesh } from '@/components/rcb/render/vector/tessellateFill';
import { unpackContours } from '@/components/rcb/render/vector/contourSimplify';
import { tessellateBatchFill } from '@/components/rcb/render/vector/wasmGeom';

let worker: Worker | null = null;
let seq = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./geomWorker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as {
        id: number;
        ok: boolean;
        packed?: Float32Array;
        error?: string;
      };
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (!msg.ok) p.reject(new Error(msg.error || 'geom worker error'));
      else p.resolve(msg);
    };
    worker.onerror = () => {
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function callWorker<T>(payload: object, transfer?: Transferable[]): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.reject(new Error('no worker'));
  const id = seq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, {
      resolve: resolve as (v: unknown) => void,
      reject,
    });
    w.postMessage({ ...payload, id }, transfer || []);
  });
}

/** Batch fill via Worker when available; else main-thread tessellateBatchFill. */
export async function tessellateBatchFillAsync(
  rings: Vec2[][]
): Promise<(FillMesh | null)[]> {
  if (!rings.length) return [];
  try {
    const counts = new Uint32Array(rings.length);
    let total = 0;
    for (let i = 0; i < rings.length; i += 1) {
      counts[i] = rings[i]!.length;
      total += rings[i]!.length * 2;
    }
    const xyAll = new Float32Array(total);
    let off = 0;
    for (const ring of rings) {
      for (const p of ring) {
        xyAll[off++] = p.x;
        xyAll[off++] = p.y;
      }
    }
    await callWorker({ type: 'init' });
    const res = await callWorker<{ packed: Float32Array }>(
      { type: 'batch_fill', xyAll, counts },
      [xyAll.buffer, counts.buffer]
    );
    const packed = res.packed;
    const out: (FillMesh | null)[] = [];
    let i = 0;
    while (i < packed.length) {
      const n = packed[i++]! | 0;
      if (n <= 0) {
        out.push(null);
        continue;
      }
      const slice = packed.slice(i, i + n);
      i += n;
      out.push({ positions: slice, triangleCount: slice.length / 6 });
    }
    return out;
  } catch {
    return tessellateBatchFill(rings);
  }
}

/**
 * Tessellate one stroke centerline on the geom Worker (off main thread).
 * Returns interleaved x,y,edge Float32Array or null if Worker unavailable.
 */
export async function strokeTessellateAsync(opts: {
  xy: Float32Array;
  width: number;
  closed?: boolean;
  align?: number;
  linejoin?: number;
  miterLimit?: number;
}): Promise<Float32Array | null> {
  const xy = opts.xy;
  if (!xy || xy.length < 4 || !(opts.width > 0)) return null;
  try {
    await callWorker({ type: 'init' });
    const res = await callWorker<{ packed: Float32Array }>(
      {
        type: 'stroke',
        xy,
        width: opts.width,
        closed: Boolean(opts.closed),
        align: Math.max(0, Math.min(2, Math.floor(opts.align ?? 0))),
        linejoin: Math.max(0, Math.min(2, Math.floor(opts.linejoin ?? 0))),
        miterLimit: Number.isFinite(opts.miterLimit) ? Number(opts.miterLimit) : 4,
      },
      [xy.buffer]
    );
    return res.packed ?? null;
  } catch {
    return null;
  }
}

export type TextGlyphOutlineOpts = {
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
  alphaThreshold?: number;
  simplifyEps: number;
  simplifyMaxPts: number;
  simplifyCap: number;
};

/**
 * Trace + simplify one glyph mask on the geom Worker.
 * Returns simplified pixel-space rings, or null if Worker unavailable.
 */
export async function textGlyphOutlineAsync(
  opts: TextGlyphOutlineOpts
): Promise<Array<Array<[number, number]>> | null> {
  const w = Math.max(0, Math.floor(opts.width));
  const h = Math.max(0, Math.floor(opts.height));
  if (!w || !h) return [];
  const src = opts.rgba;
  if (src.length < w * h * 4) return null;
  try {
    // Copy so the canvas ImageData buffer stays usable on the main thread.
    const rgba = new Uint8Array(src.length);
    rgba.set(src);
    await callWorker({ type: 'init' });
    const res = await callWorker<{ packed: Float32Array }>(
      {
        type: 'text_glyph',
        rgba,
        width: w,
        height: h,
        alphaThreshold: Math.max(0, Math.min(255, Math.round(opts.alphaThreshold ?? 20))),
        simplifyEps: opts.simplifyEps,
        simplifyMaxPts: opts.simplifyMaxPts,
        simplifyCap: opts.simplifyCap,
      },
      [rgba.buffer]
    );
    if (!res.packed || res.packed.length === 0) return null;
    if (res.packed.length === 1 && res.packed[0] === 0) return [];
    return unpackContours(res.packed);
  } catch {
    return null;
  }
}
