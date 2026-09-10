/**
 * Processing plate paint — seeded pastel tones + SMIL gradient drift.
 */

import {
  pickSoftGlowTone,
  type SoftGlowListTone,
} from '@/components/base/SoftGlowSurface';
import {
  append,
  ensureDefs,
  setAttrs,
  setFill,
  setStroke,
  svgEl,
  urlRef,
} from '@/components/rcb/scene/dom/svgDom';
import {
  PROCESS_PLATE_STROKE,
  processGlowForeignObjectBounds,
} from './processGlow';

function hashSeed(seed: string | number): number {
  const s = String(seed);
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export type ProcessPlateStroke = {
  color: string;
  width: number;
  dasharray?: string;
};

export type ProcessPlatePalette = {
  tone: SoftGlowListTone;
  base: string;
  core: string;
  coreOpacity: number;
  soft: string;
  softOpacity: number;
};

const DRIFT_DUR = '7.5s';
const DRIFT_KEY_TIMES = '0;0.4;0.7;1';
const DRIFT_KEY_SPLINES = '0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1';

const TONE_PALETTES: Record<SoftGlowListTone, Omit<ProcessPlatePalette, 'tone'>> = {
  rose: {
    base: '#f7f8fa',
    core: '255, 176, 196',
    coreOpacity: 0.58,
    soft: '255, 210, 220',
    softOpacity: 0.26,
  },
  sky: {
    base: '#f7f8fa',
    core: '160, 195, 255',
    coreOpacity: 0.55,
    soft: '200, 220, 255',
    softOpacity: 0.28,
  },
  peach: {
    base: '#f7f8fa',
    core: '255, 200, 160',
    coreOpacity: 0.52,
    soft: '255, 220, 190',
    softOpacity: 0.26,
  },
  lilac: {
    base: '#f7f8fa',
    core: '210, 185, 255',
    coreOpacity: 0.5,
    soft: '230, 210, 255',
    softOpacity: 0.26,
  },
  mint: {
    base: '#f7f8fa',
    core: '170, 225, 205',
    coreOpacity: 0.5,
    soft: '200, 235, 220',
    softOpacity: 0.26,
  },
};

const DRIFT_SPECS = {
  core: {
    cx: '0.58;0.70;0.62;0.50;0.58',
    cy: '0.38;0.44;0.54;0.42;0.38',
    r: '0.65;0.73;0.68;0.70;0.65',
  },
  soft: {
    cx: '0.32;0.44;0.38;0.26;0.32',
    cy: '0.68;0.74;0.82;0.72;0.68',
    r: '0.60;0.68;0.63;0.66;0.60',
  },
} as const;

function safePlateKey(plateKey: string): string {
  return String(plateKey || 'plate')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 48);
}

function rgba(rgb: string, alpha: number): string {
  return `rgba(${rgb}, ${alpha})`;
}

/** Stable random pastel per node / frame — same seed → same tone. */
export function resolveProcessPlatePalette(plateKey: string): ProcessPlatePalette {
  const tone = pickSoftGlowTone(plateKey);
  const palette = TONE_PALETTES[tone];
  return { tone, ...palette };
}

export function processPlateGradientIds(plateKey: string): { coreId: string; softId: string } {
  const safe = safePlateKey(plateKey);
  return {
    coreId: `rcb-process-glow-core-${safe}`,
    softId: `rcb-process-glow-soft-${safe}`,
  };
}

function appendGradientDrift(
  grad: SVGRadialGradientElement,
  layer: keyof typeof DRIFT_SPECS,
  delaySec: number
): void {
  const spec = DRIFT_SPECS[layer];
  for (const attr of ['cx', 'cy', 'r'] as const) {
    const anim = svgEl('animate', {
      attributeName: attr,
      values: spec[attr],
      dur: DRIFT_DUR,
      repeatCount: 'indefinite',
      calcMode: 'spline',
      keyTimes: DRIFT_KEY_TIMES,
      keySplines: DRIFT_KEY_SPLINES,
    });
    if (delaySec > 0) anim.setAttribute('begin', `${delaySec}s`);
    grad.appendChild(anim);
  }
}

function upsertRadialGradient(
  defs: SVGDefsElement,
  id: string,
  layer: keyof typeof DRIFT_SPECS,
  opts: {
    cx: number;
    cy: number;
    r: number;
    coreColor: string;
    baseColor: string;
    fadeOffset: string;
    delaySec: number;
  }
): void {
  let grad = defs.querySelector(`#${CSS.escape(id)}`) as SVGRadialGradientElement | null;
  if (!grad) {
    grad = svgEl('radialGradient', {
      id,
      gradientUnits: 'objectBoundingBox',
      cx: opts.cx,
      cy: opts.cy,
      r: opts.r,
    });
    defs.appendChild(grad);
  } else {
    setAttrs(grad, { cx: opts.cx, cy: opts.cy, r: opts.r });
    while (grad.firstChild) grad.removeChild(grad.firstChild);
  }

  grad.appendChild(
    svgEl('stop', {
      offset: '0%',
      'stop-color': opts.coreColor,
      'stop-opacity': 1,
    })
  );
  grad.appendChild(
    svgEl('stop', {
      offset: opts.fadeOffset,
      'stop-color': opts.baseColor,
      'stop-opacity': 0,
    })
  );
  appendGradientDrift(grad, layer, opts.delaySec);
}

function ensureProcessPlateGradients(
  root: SVGSVGElement,
  plateKey: string,
  palette: ProcessPlatePalette,
  delaySec: number
): { coreId: string; softId: string } {
  const defs = ensureDefs(root);
  const ids = processPlateGradientIds(plateKey);
  upsertRadialGradient(defs, ids.coreId, 'core', {
    cx: 0.58,
    cy: 0.38,
    r: 0.65,
    coreColor: rgba(palette.core, palette.coreOpacity),
    baseColor: palette.base,
    fadeOffset: '82%',
    delaySec,
  });
  upsertRadialGradient(defs, ids.softId, 'soft', {
    cx: 0.32,
    cy: 0.68,
    r: 0.6,
    coreColor: rgba(palette.soft, palette.softOpacity),
    baseColor: palette.base,
    fadeOffset: '84%',
    delaySec: delaySec + 0.21,
  });
  return ids;
}

/** Opaque base + two SMIL-drifting radial blooms on the same plate path. */
export function appendProcessPlatePaths(
  parent: SVGElement,
  root: SVGSVGElement,
  plateKey: string,
  clipD: string,
  _width: number,
  _height: number,
  stroke?: ProcessPlateStroke
): ProcessPlatePalette {
  const palette = resolveProcessPlatePalette(plateKey);
  const delaySec = ((hashSeed(plateKey) % 7) * 420) / 1000;
  const { coreId, softId } = ensureProcessPlateGradients(root, plateKey, palette, delaySec);

  const base = svgEl('path', { d: clipD });
  setFill(base, palette.base);
  setAttrs(base, {
    'data-process-plate-base': '1',
    'data-radius-body': '1',
    'data-baseline': '1',
    'data-process-plate-tone': palette.tone,
  });
  if (stroke) setStroke(base, stroke);
  append(parent, base);

  for (const fillId of [coreId, softId]) {
    const glow = svgEl('path', {
      d: clipD,
      fill: urlRef(fillId),
      'pointer-events': 'none',
      'data-process-plate-glow': '1',
    });
    append(parent, glow);
  }

  setAttrs(parent, { 'data-process-plate-tone': palette.tone });

  return palette;
}

/** Keep all process plate paths in sync during live resize. */
export function syncProcessPlateGeometry(host: SVGElement, clipD: string): void {
  host.querySelectorAll('[data-process-plate-base], [data-process-plate-glow]').forEach((node) => {
    if (node.tagName.toLowerCase() === 'path') node.setAttribute('d', clipD);
  });
}

/** Status pill foreignObject — gradient is SVG-only; FO is label chrome. */
export function syncProcessPillForeignObject(
  host: SVGElement | null | undefined,
  width: number,
  height: number
): void {
  if (!host) return;
  const box = processGlowForeignObjectBounds(width, height);
  const fo = host.querySelector(
    'foreignObject[data-rcb-process-glow]'
  ) as SVGForeignObjectElement | null;
  if (!fo) return;
  fo.setAttribute('x', String(box.x));
  fo.setAttribute('y', String(box.y));
  fo.setAttribute('width', String(box.width));
  fo.setAttribute('height', String(box.height));
}

/** Canvas ink — static process blooms (no SMIL on canvas). */
export function paintProcessPlateCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  opacity = 1,
  plateKey?: string
): void {
  const palette = resolveProcessPlatePalette(plateKey || 'canvas-fallback');
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, w, h);

  const bloomFill = (cx: number, cy: number, r: number, rgb: string, alpha: number, fade: number) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, rgba(rgb, alpha));
    g.addColorStop(fade, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };

  bloomFill(w * 0.58, h * 0.38, Math.max(w, h) * 0.65, palette.core, palette.coreOpacity, 0.82);
  bloomFill(w * 0.32, h * 0.68, Math.max(w, h) * 0.6, palette.soft, palette.softOpacity, 0.84);
  ctx.restore();
}

export { PROCESS_PLATE_STROKE };
