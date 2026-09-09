/**
 * Empty-generator plate glyphs — same Lucide paths as selection chrome
 * (`NodeTitleLabel`), stroked live (Canvas / WebGL lines). Do not atlas-bake:
 * tiny high-zoom plates crushed icons into a few texels and looked “gone”.
 */

/** Lucide default stroke in the 24×24 box. */
export const LU_ICON_STROKE = 2;

/**
 * Empty-generator center glyph — soft cool gray (historical atlas idle ink).
 * Keep lighter than `--muted` (#767676) so large plates don't read as ink blobs.
 */
export const GENERATOR_EMPTY_ICON_COLOR = '#9aa3b2';

/**
 * Idle generator plate hairline — same cool gray used by historical
 * `paintGeneratorEmptyInk` / audio idle plates (`#c5c9d2`).
 */
export const GENERATOR_EMPTY_PLATE_STROKE = '#c5c9d2';

/** Target hairline in CSS px (artboard idle edge is also 1 CSS px). */
export const GENERATOR_EMPTY_PLATE_STROKE_WIDTH = 1;

export type GeneratorEmptyIconKind = 'audio' | 'image' | 'video';

/** LuAudioLines vertical stems in 24×24 (react-icons/lu). */
export const LU_AUDIO_LINES_SEGS: ReadonlyArray<
  readonly [x0: number, y0: number, x1: number, y1: number]
> = [
  [2, 10, 2, 13],
  [6, 6, 6, 17],
  [10, 3, 10, 21],
  [14, 8, 14, 15],
  [18, 5, 18, 18],
  [22, 10, 22, 13],
];

/** LuImagePlus path `d` list + sun circle (react-icons/lu). */
export const LU_IMAGE_PLUS_PATHS: readonly string[] = [
  'M16 5h6',
  'M19 2v6',
  'M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5',
  'm21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21',
];

export const LU_IMAGE_PLUS_CIRCLE = { cx: 9, cy: 9, r: 2 } as const;

/** LuVideo path + body rect (stroke twin of the title video glyph). */
export const LU_VIDEO_PATHS: readonly string[] = [
  'm16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5',
];

export const LU_VIDEO_RECT_PATH =
  'M4 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z';

export type IconWorldSeg = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  stroke: number;
};

const pathPointCache = new Map<string, Array<readonly [number, number]>>();

function densifySvgPathD(d: string, steps = 28): Array<readonly [number, number]> {
  const cached = pathPointCache.get(d);
  if (cached) return cached;
  if (typeof document === 'undefined') {
    pathPointCache.set(d, []);
    return [];
  }
  try {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    const len = el.getTotalLength();
    if (!(len > 0) || !Number.isFinite(len)) {
      pathPointCache.set(d, []);
      return [];
    }
    const n = Math.max(4, steps);
    const pts: Array<readonly [number, number]> = [];
    for (let i = 0; i <= n; i += 1) {
      const p = el.getPointAtLength((i / n) * len);
      pts.push([p.x, p.y]);
    }
    pathPointCache.set(d, pts);
    return pts;
  } catch {
    pathPointCache.set(d, []);
    return [];
  }
}

function densifyCircle(
  cx: number,
  cy: number,
  r: number,
  steps = 16
): Array<readonly [number, number]> {
  const pts: Array<readonly [number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function polylineToLocalSegs(
  pts: Array<readonly [number, number]>,
  stroke: number
): Array<{ x0: number; y0: number; x1: number; y1: number; stroke: number }> {
  const out: Array<{ x0: number; y0: number; x1: number; y1: number; stroke: number }> = [];
  for (let i = 1; i < pts.length; i += 1) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    out.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1], stroke });
  }
  return out;
}

function localSegsForKind(
  kind: GeneratorEmptyIconKind
): Array<{ x0: number; y0: number; x1: number; y1: number; stroke: number }> {
  const stroke = LU_ICON_STROKE;
  if (kind === 'audio') {
    return LU_AUDIO_LINES_SEGS.map(([x0, y0, x1, y1]) => ({ x0, y0, x1, y1, stroke }));
  }
  const paths = kind === 'image' ? LU_IMAGE_PLUS_PATHS : [...LU_VIDEO_PATHS, LU_VIDEO_RECT_PATH];
  const out: Array<{ x0: number; y0: number; x1: number; y1: number; stroke: number }> = [];
  for (const d of paths) {
    out.push(...polylineToLocalSegs(densifySvgPathD(d), stroke));
  }
  if (kind === 'image') {
    const { cx, cy, r } = LU_IMAGE_PLUS_CIRCLE;
    out.push(...polylineToLocalSegs(densifyCircle(cx, cy, r), stroke));
  }
  return out;
}

/** World-space stroke segments for a centered empty-gen Lucide glyph. */
export function generatorEmptyIconWorldSegs(
  kind: GeneratorEmptyIconKind,
  left: number,
  top: number,
  plateW: number,
  plateH: number,
  size: number
): IconWorldSeg[] {
  const side = Math.max(0.5, Number(size) || 0);
  if (!(side > 0)) return [];
  const s = side / 24;
  const ox = left + (plateW - side) / 2;
  const oy = top + (plateH - side) / 2;
  const stroke = LU_ICON_STROKE * s;
  return localSegsForKind(kind).map((seg) => ({
    x0: ox + seg.x0 * s,
    y0: oy + seg.y0 * s,
    x1: ox + seg.x1 * s,
    y1: oy + seg.y1 * s,
    stroke,
  }));
}

function strokePathList(
  ctx: CanvasRenderingContext2D,
  paths: readonly string[],
  color: string
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = LU_ICON_STROKE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Prefer Path2D when available; fall back to densified polylines (vitest / older envs).
  if (typeof Path2D === 'function') {
    for (const d of paths) {
      ctx.stroke(new Path2D(d));
    }
    return;
  }
  for (const d of paths) {
    for (const seg of polylineToLocalSegs(densifySvgPathD(d), LU_ICON_STROKE)) {
      ctx.beginPath();
      ctx.moveTo(seg.x0, seg.y0);
      ctx.lineTo(seg.x1, seg.y1);
      ctx.stroke();
    }
  }
}

/**
 * HTML/SVG markup for the empty-gen Lucide glyph (fallback DomHost overlay).
 * Built from the same path constants as canvas strokes — not `svg?raw`.
 */
export function buildGeneratorEmptyIconSvg(
  kind: GeneratorEmptyIconKind,
  size: number,
  color = GENERATOR_EMPTY_ICON_COLOR
): string {
  const side = Math.max(1, Math.round(Number(size) || 24));
  const stroke = `stroke="${color}" stroke-width="${LU_ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  let body = '';
  if (kind === 'audio') {
    body = LU_AUDIO_LINES_SEGS.map(
      ([x0, y0, x1, y1]) =>
        `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" ${stroke}/>`
    ).join('');
  } else if (kind === 'image') {
    body =
      LU_IMAGE_PLUS_PATHS.map((d) => `<path d="${d}" ${stroke}/>`).join('') +
      `<circle cx="${LU_IMAGE_PLUS_CIRCLE.cx}" cy="${LU_IMAGE_PLUS_CIRCLE.cy}" r="${LU_IMAGE_PLUS_CIRCLE.r}" ${stroke}/>`;
  } else {
    body =
      LU_VIDEO_PATHS.map((d) => `<path d="${d}" ${stroke}/>`).join('') +
      `<path d="${LU_VIDEO_RECT_PATH}" ${stroke}/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/**
 * Paint a centered empty-gen Lucide glyph (scene units).
 */
export function paintGeneratorEmptyLucideIcon(
  ctx: CanvasRenderingContext2D,
  kind: GeneratorEmptyIconKind,
  cx: number,
  cy: number,
  size: number,
  color = GENERATOR_EMPTY_ICON_COLOR
): void {
  const side = Math.max(0.5, Number(size) || 0);
  if (!(side > 0)) return;
  const s = side / 24;
  ctx.save();
  ctx.translate(cx - side / 2, cy - side / 2);
  ctx.scale(s, s);
  if (kind === 'audio') {
    ctx.strokeStyle = color;
    ctx.lineWidth = LU_ICON_STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const [x0, y0, x1, y1] of LU_AUDIO_LINES_SEGS) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  } else if (kind === 'image') {
    strokePathList(ctx, LU_IMAGE_PLUS_PATHS, color);
    ctx.strokeStyle = color;
    ctx.lineWidth = LU_ICON_STROKE;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (typeof ctx.arc === 'function') {
      ctx.beginPath();
      ctx.arc(LU_IMAGE_PLUS_CIRCLE.cx, LU_IMAGE_PLUS_CIRCLE.cy, LU_IMAGE_PLUS_CIRCLE.r, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const { cx, cy, r } = LU_IMAGE_PLUS_CIRCLE;
      for (const seg of polylineToLocalSegs(densifyCircle(cx, cy, r), LU_ICON_STROKE)) {
        ctx.beginPath();
        ctx.moveTo(seg.x0, seg.y0);
        ctx.lineTo(seg.x1, seg.y1);
        ctx.stroke();
      }
    }
  } else {
    strokePathList(ctx, LU_VIDEO_PATHS, color);
    strokePathList(ctx, [LU_VIDEO_RECT_PATH], color);
  }
  ctx.restore();
}
