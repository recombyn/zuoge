/**
 * Kit-native process plate (SoftGlow) — painted in the node's world AABB
 * via CanvasKit soft circles (no DomHost translate; no radial-shader color traps).
 */
import {
  resolveProcessPlatePalette,
  type ProcessPlatePalette,
} from './processPlateSvg';

function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const DRIFT_CYCLE_SEC = 7.5;
const DRIFT_KEY_TIMES = [0, 0.4, 0.7, 1];

const DRIFT_SPECS = {
  core: {
    cx: [0.58, 0.7, 0.62, 0.5, 0.58],
    cy: [0.38, 0.44, 0.54, 0.42, 0.38],
    r: [0.65, 0.73, 0.68, 0.7, 0.65],
  },
  soft: {
    cx: [0.32, 0.44, 0.38, 0.26, 0.32],
    cy: [0.68, 0.74, 0.82, 0.72, 0.68],
    r: [0.6, 0.68, 0.63, 0.66, 0.6],
  },
} as const;

function parseHex(hex: string): { r: number; g: number; b: number } {
  const h = String(hex || '#f7f8fa').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  };
}

function parseRgbTriplet(rgb: string): { r: number; g: number; b: number } {
  const parts = String(rgb || '255,255,255')
    .split(',')
    .map((n) => Number(n.trim()) / 255);
  return {
    r: parts[0] ?? 1,
    g: parts[1] ?? 1,
    b: parts[2] ?? 1,
  };
}

/** Sample SMIL keyframe track at normalized cycle position [0,1]. */
function sampleDriftTrack(values: readonly number[], tNorm: number): number {
  const n = values.length;
  if (n < 2) return values[0] ?? 0;
  const t = ((tNorm % 1) + 1) % 1;
  let seg = 0;
  for (let i = 0; i < DRIFT_KEY_TIMES.length - 1; i += 1) {
    if (t >= DRIFT_KEY_TIMES[i] && t <= DRIFT_KEY_TIMES[i + 1]) {
      seg = i;
      break;
    }
    if (i === DRIFT_KEY_TIMES.length - 2) seg = DRIFT_KEY_TIMES.length - 2;
  }
  const t0 = DRIFT_KEY_TIMES[seg];
  const t1 = DRIFT_KEY_TIMES[seg + 1];
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const v0 = values[seg] ?? values[0];
  const v1 = values[seg + 1] ?? v0;
  return v0 + (v1 - v0) * u;
}

function driftLayer(
  layer: keyof typeof DRIFT_SPECS,
  timeSec: number,
  delaySec: number
): { cx: number; cy: number; r: number } {
  const spec = DRIFT_SPECS[layer];
  const tNorm = ((timeSec - delaySec) / DRIFT_CYCLE_SEC + 1) % 1;
  return {
    cx: sampleDriftTrack(spec.cx, tNorm),
    cy: sampleDriftTrack(spec.cy, tNorm),
    r: sampleDriftTrack(spec.r, tNorm),
  };
}

type CkPaint = {
  setStyle: (s: unknown) => void;
  setShader?: (s: unknown | null) => void;
  setColor: (c: unknown) => void;
  setAntiAlias: (v: boolean) => void;
  delete: () => void;
};

type CkCanvas = {
  drawRect: (r: unknown, paint: unknown) => void;
  drawCircle?: (cx: number, cy: number, r: number, paint: unknown) => void;
  clipRect?: (r: unknown, op: unknown, aa: boolean) => void;
  save?: () => void;
  restore?: () => void;
};

type CkApi = {
  Paint: new () => CkPaint;
  PaintStyle: { Fill: unknown };
  /** Prefer Color4f (0..1) — matches Kit gradient / paint path. */
  Color4f?: (r: number, g: number, b: number, a: number) => unknown;
  Color: (r: number, g: number, b: number, a: number) => unknown;
  LTRBRect?: (l: number, t: number, r: number, b: number) => unknown;
  XYWHRect?: (x: number, y: number, w: number, h: number) => unknown;
  ClipOp?: { Intersect: unknown };
};

function ckColor(
  ck: CkApi,
  r: number,
  g: number,
  b: number,
  a: number
): unknown {
  if (typeof ck.Color4f === 'function') return ck.Color4f(r, g, b, a);
  // Fallback: some builds take 0–255 in Color().
  return ck.Color(Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), a);
}

function plateRect(ck: CkApi, w: number, h: number): unknown {
  if (ck.LTRBRect) return ck.LTRBRect(0, 0, w, h);
  if (ck.XYWHRect) return ck.XYWHRect(0, 0, w, h);
  return Float32Array.of(0, 0, w, h);
}

/**
 * Soft bloom via concentric circles (no MakeRadialGradient — avoids black /
 * opaque shader failures on some CanvasKit color paths).
 */
function paintSoftBloom(
  c: CkCanvas,
  ck: CkApi,
  paint: CkPaint,
  w: number,
  h: number,
  cxPct: number,
  cyPct: number,
  rPct: number,
  rgb: string,
  alpha: number
): void {
  const cx = cxPct * w;
  const cy = cyPct * h;
  const radius = rPct * Math.max(w, h);
  const core = parseRgbTriplet(rgb);
  paint.setStyle(ck.PaintStyle.Fill);
  paint.setAntiAlias(true);
  paint.setShader?.(null);

  if (typeof c.drawCircle === 'function') {
    const rings = 10;
    for (let i = rings - 1; i >= 0; i -= 1) {
      const t = i / (rings - 1);
      const rr = Math.max(1, radius * (0.12 + 0.88 * t));
      // Quadratic falloff — soft center, transparent edge.
      const a = alpha * (1 - t) * (1 - t);
      if (a < 0.01) continue;
      paint.setColor(ckColor(ck, core.r, core.g, core.b, a));
      c.drawCircle(cx, cy, rr, paint);
    }
    return;
  }

  // No drawCircle — flat tint fallback (still clipped to the plate).
  paint.setColor(ckColor(ck, core.r, core.g, core.b, alpha * 0.35));
  c.drawRect(plateRect(ck, w, h), paint);
}

/**
 * Opaque base + two drifting soft blooms in plate-local space (0..w × 0..h).
 * Caller must already be translated to the plate's world top-left and should
 * clip to the plate before calling.
 */
export function paintKitProcessPlateLocal(
  c: CkCanvas,
  ck: CkApi,
  paint: CkPaint,
  w: number,
  h: number,
  plateKey: string,
  timeMs: number
): ProcessPlatePalette {
  const palette = resolveProcessPlatePalette(plateKey);
  const ww = Math.max(1, w);
  const hh = Math.max(1, h);
  const delaySec = ((hashSeed(plateKey) % 7) * 420) / 1000;
  const timeSec = timeMs / 1000;

  // Clip tightly so blooms never spill as a full-stage black/huge fill.
  if (c.clipRect && ck.LTRBRect && ck.ClipOp && c.save && c.restore) {
    c.save();
    c.clipRect(ck.LTRBRect(0, 0, ww, hh), ck.ClipOp.Intersect, true);
  }

  const base = parseHex(palette.base);
  paint.setShader?.(null);
  paint.setStyle(ck.PaintStyle.Fill);
  paint.setAntiAlias(true);
  paint.setColor(ckColor(ck, base.r, base.g, base.b, 1));
  c.drawRect(plateRect(ck, ww, hh), paint);

  const core = driftLayer('core', timeSec, delaySec);
  paintSoftBloom(
    c,
    ck,
    paint,
    ww,
    hh,
    core.cx,
    core.cy,
    core.r,
    palette.core,
    palette.coreOpacity
  );

  const soft = driftLayer('soft', timeSec, delaySec + 0.21);
  paintSoftBloom(
    c,
    ck,
    paint,
    ww,
    hh,
    soft.cx,
    soft.cy,
    soft.r,
    palette.soft,
    palette.softOpacity
  );

  if (c.clipRect && ck.LTRBRect && ck.ClipOp && c.save && c.restore) {
    c.restore();
  }

  return palette;
}

export function isNodeProcessRunning(
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  return String(node?.attrs?.processStatus || '') === 'running';
}
