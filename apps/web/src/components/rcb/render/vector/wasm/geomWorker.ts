/**
 * Geom Worker — batch fill + text glyph contour/simplify off the main thread.
 */
/// <reference lib="webworker" />

import {
  packContours,
  simplifyClosedPolylineGrow,
  unpackContours,
} from '@/components/rcb/render/vector/contourSimplify';

type WorkerReq =
  | { id: number; type: 'init' }
  | {
      id: number;
      type: 'batch_fill';
      xyAll: Float32Array;
      counts: Uint32Array;
    }
  | {
      id: number;
      type: 'stroke';
      xy: Float32Array;
      width: number;
      closed: boolean;
      align: string;
      linejoin: string;
      miterLimit: number;
    }
  | {
      id: number;
      type: 'text_glyph';
      rgba: Uint8Array;
      width: number;
      height: number;
      alphaThreshold: number;
      simplifyEps: number;
      simplifyMaxPts: number;
      simplifyCap: number;
    };

type WorkerRes =
  | { id: number; ok: true; type: 'init' }
  | { id: number; ok: true; type: 'batch_fill'; packed: Float32Array }
  | { id: number; ok: true; type: 'stroke'; packed: Float32Array }
  | { id: number; ok: true; type: 'text_glyph'; packed: Float32Array }
  | { id: number; ok: false; error: string };

type WasmApi = {
  tessellate_batch_fill: (xy: Float32Array, counts: Uint32Array) => Float32Array;
  tessellate_stroke?: (
    xy: Float32Array,
    width: number,
    closed: boolean,
    align: string,
    linejoin: string,
    miterLimit: number
  ) => Float32Array;
  trace_rgba_contours?: (
    rgba: Uint8Array,
    width: number,
    height: number,
    alphaThreshold: number
  ) => Float32Array;
  simplify_rdp_closed?: (xy: Float32Array, epsilon: number) => Float32Array;
};

let api: WasmApi | null = null;

async function ensureInit(): Promise<void> {
  if (api) return;
  const dynamicImport = new Function('u', 'return import(u)') as (
    u: string
  ) => Promise<Record<string, unknown> & { default?: (opts: { module_or_path: string }) => Promise<void> }>;
  const mod = await dynamicImport('/rcb-wasm/rcb_wasm_geom.js');
  if (typeof mod.default === 'function') {
    await mod.default({ module_or_path: '/rcb-wasm/rcb_wasm_geom_bg.wasm' });
  }
  api = {
    tessellate_batch_fill: mod.tessellate_batch_fill as WasmApi['tessellate_batch_fill'],
    tessellate_stroke:
      typeof mod.tessellate_stroke === 'function'
        ? (mod.tessellate_stroke as NonNullable<WasmApi['tessellate_stroke']>)
        : undefined,
    trace_rgba_contours:
      typeof mod.trace_rgba_contours === 'function'
        ? (mod.trace_rgba_contours as NonNullable<WasmApi['trace_rgba_contours']>)
        : undefined,
    simplify_rdp_closed:
      typeof mod.simplify_rdp_closed === 'function'
        ? (mod.simplify_rdp_closed as NonNullable<WasmApi['simplify_rdp_closed']>)
        : undefined,
  };
}

function rdpClosedWasm(
  pts: Array<[number, number]>,
  epsilon: number
): Array<[number, number]> | null {
  if (!api?.simplify_rdp_closed || pts.length < 3) return null;
  const xy = new Float32Array(pts.length * 2);
  for (let i = 0; i < pts.length; i += 1) {
    xy[i * 2] = pts[i]![0];
    xy[i * 2 + 1] = pts[i]![1];
  }
  const raw = api.simplify_rdp_closed(xy, Math.max(0, epsilon));
  if (!raw || raw.length < 6) return null;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < raw.length; i += 2) {
    out.push([raw[i]!, raw[i + 1]!]);
  }
  return out;
}

function processTextGlyph(msg: Extract<WorkerReq, { type: 'text_glyph' }>): Float32Array {
  if (!api?.trace_rgba_contours) {
    throw new Error('trace_rgba_contours unavailable');
  }
  const traced = api.trace_rgba_contours(
    msg.rgba,
    msg.width,
    msg.height,
    msg.alphaThreshold
  );
  if (!traced || traced.length === 0) {
    throw new Error('trace failed');
  }
  // [0] => empty glyph
  if (traced.length === 1 && traced[0] === 0) {
    return new Float32Array([0]);
  }
  const rings = unpackContours(traced);
  const simplified: Array<Array<[number, number]>> = [];
  for (const ring of rings) {
    const s = simplifyClosedPolylineGrow(
      ring,
      msg.simplifyEps,
      msg.simplifyMaxPts,
      msg.simplifyCap,
      rdpClosedWasm
    );
    if (s.length >= 3) simplified.push(s);
  }
  return packContours(simplified);
}

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      await ensureInit();
      const res: WorkerRes = { id: msg.id, ok: true, type: 'init' };
      (self as unknown as Worker).postMessage(res);
      return;
    }
    if (msg.type === 'batch_fill') {
      await ensureInit();
      const packed = api!.tessellate_batch_fill(msg.xyAll, msg.counts);
      const res: WorkerRes = { id: msg.id, ok: true, type: 'batch_fill', packed };
      (self as unknown as Worker).postMessage(res, [packed.buffer]);
      return;
    }
    if (msg.type === 'stroke') {
      await ensureInit();
      if (!api?.tessellate_stroke) throw new Error('tessellate_stroke unavailable');
      const packed = api.tessellate_stroke(
        msg.xy,
        msg.width,
        msg.closed,
        msg.align,
        msg.linejoin,
        msg.miterLimit
      );
      const res: WorkerRes = { id: msg.id, ok: true, type: 'stroke', packed };
      (self as unknown as Worker).postMessage(res, [packed.buffer]);
      return;
    }
    if (msg.type === 'text_glyph') {
      await ensureInit();
      const packed = processTextGlyph(msg);
      const res: WorkerRes = { id: msg.id, ok: true, type: 'text_glyph', packed };
      (self as unknown as Worker).postMessage(res, [packed.buffer]);
    }
  } catch (e) {
    const res: WorkerRes = {
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(res);
  }
};

export {};
