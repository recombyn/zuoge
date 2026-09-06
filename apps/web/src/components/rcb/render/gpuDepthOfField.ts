/**
 * GPU depth-of-field — shared depth normalization, CoC math, and runtime params.
 * Depth is derived from existing stackOrder z-map (no SceneDocument schema change).
 */
import { buildNodeStackZMap } from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument } from '@/components/rcb/sceneNode';

export type GpuDofBackend = 'webgl2';

export type GpuDepthOfFieldParams = {
  /** Master switch — when false, ink backends skip the GPU DOF pass. */
  enabled: boolean;
  /** Normalized stack depth in focus [0,1]. Higher = nearer (top of stack). */
  focalDepth: number;
  /** CoC scale — max blur radius scales with |depth − focal|. */
  aperture: number;
  /** Hard cap on blur radius in device pixels. */
  maxCoCPx: number;
  /** Load shedding — downsample factor (1 = full res, 2 = half). */
  downsample: number;
};

const DEFAULT_PARAMS: GpuDepthOfFieldParams = {
  enabled: false,
  focalDepth: 0.55,
  aperture: 1,
  maxCoCPx: 28,
  downsample: 1,
};

let runtimeParams: GpuDepthOfFieldParams = { ...DEFAULT_PARAMS };
const listeners = new Set<() => void>();

function notifyDofListeners() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore listener errors */
    }
  }
}

function clampFocal(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARAMS.focalDepth;
  return Math.max(0, Math.min(1, n));
}

function clampAperture(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARAMS.aperture;
  return Math.max(0, Math.min(4, n));
}

function clampMaxCoC(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PARAMS.maxCoCPx;
  return Math.max(0, Math.min(64, n));
}

export function getGpuDepthOfFieldParams(): GpuDepthOfFieldParams {
  return runtimeParams;
}

export function setGpuDepthOfFieldParams(patch: Partial<GpuDepthOfFieldParams>): void {
  const next: GpuDepthOfFieldParams = { ...runtimeParams };
  if (patch.enabled != null) next.enabled = Boolean(patch.enabled);
  if (patch.focalDepth != null) next.focalDepth = clampFocal(Number(patch.focalDepth));
  if (patch.aperture != null) next.aperture = clampAperture(Number(patch.aperture));
  if (patch.maxCoCPx != null) next.maxCoCPx = clampMaxCoC(Number(patch.maxCoCPx));
  if (patch.downsample != null) next.downsample = clampDownsample(Number(patch.downsample));
  runtimeParams = next;
  notifyDofListeners();
}

export function resetGpuDepthOfFieldParams(): void {
  runtimeParams = {
    ...DEFAULT_PARAMS,
    enabled: isGpuDofEnvEnabled(),
  };
  notifyDofListeners();
}

/** Subscribe to runtime DOF param changes (repaint / backend recreate). */
export function subscribeGpuDepthOfField(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Env opt-in: `VITE_GPU_DOF=1`. */
export function isGpuDofEnvEnabled(): boolean {
  if (typeof import.meta === 'undefined') return false;
  const v = String(import.meta.env?.VITE_GPU_DOF ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export function shouldRunGpuDepthOfField(): boolean {
  return isGpuDofEnvEnabled() && runtimeParams.enabled;
}

/** When GPU DOF is active, skip CPU tile bake — full-res FBO replaces baked tiles. */
export function gpuDofSkipsSoaTileBake(): boolean {
  return shouldRunGpuDepthOfField();
}

/** Env backend preference (WebGPU removed — always WebGL2 when set). */
export function resolveGpuDofBackendEnv(): GpuDofBackend | null {
  if (typeof import.meta === 'undefined') return null;
  const raw = String(import.meta.env?.VITE_GPU_DOF_BACKEND ?? '').toLowerCase();
  if (!raw) return null;
  if (raw === 'webgl2' || raw === 'webgl') return 'webgl2';
  return null;
}

/**
 * GPU DOF always uses WebGL2 when enabled (WebGPU ink renderer removed).
 */
export function resolveGpuDofBackend(): GpuDofBackend | null {
  if (!shouldRunGpuDepthOfField()) return null;
  return 'webgl2';
}

if (typeof import.meta !== 'undefined' && isGpuDofEnvEnabled()) {
  runtimeParams = { ...runtimeParams, enabled: true };
}

export type NormalizedDepthLookup = {
  minZ: number;
  maxZ: number;
  depthForId(id: string): number;
};

/** Map stack z-indices to [0,1] for GPU depth attachment (0 = back, 1 = front). */
export function buildNormalizedDepthLookup(
  doc: SceneDocument | null | undefined,
  ids: readonly string[]
): NormalizedDepthLookup {
  const zMap = buildNodeStackZMap(doc, ids);
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const id of ids) {
    const z = zMap.get(id) ?? 0;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minZ)) {
    minZ = 0;
    maxZ = 1;
  }
  const span = Math.max(1, maxZ - minZ);
  return {
    minZ,
    maxZ,
    depthForId(id: string) {
      const z = zMap.get(id) ?? minZ;
      return (z - minZ) / span;
    },
  };
}

/** Circle-of-confusion radius in pixels (thin-lens approximation on normalized depth). */
export function circleOfConfusionPx(
  depth: number,
  params: Pick<GpuDepthOfFieldParams, 'focalDepth' | 'aperture' | 'maxCoCPx'>
): number {
  const d = Math.max(0, Math.min(1, depth));
  const focal = Math.max(0, Math.min(1, params.focalDepth));
  const delta = Math.abs(d - focal);
  const raw = delta * params.aperture * params.maxCoCPx;
  return Math.min(params.maxCoCPx, Math.max(0, raw));
}

export function clampDownsample(n: number): number {
  if (n >= 2) return 2;
  return 1;
}
