/** Editor artboard frame (document.frames). Canvas domain — not the editor store-specific. */

/**
 * Idle artboard plate chrome — screen-constant hairline (not closed-rect #333).
 * World camera uses CSS `scale(zoom)`, so paint stroke in **scene** units = CSS_px / zoom.
 * Edge ink uses the same Canvas miter closed-path recipe as plate hairlines
 * (`strokeCanvasPlateHairline`).
 */
export const FRAME_PLATE_STROKE = 'color-mix(in srgb, var(--ink) 42%, transparent)';
/**
 * Canvas / WebGL cannot resolve `var(--ink)` / color-mix — solid stand-in for
 * light theme plate hairlines (matches ~42% of #141414).
 */
export const FRAME_PLATE_STROKE_CANVAS = 'rgba(20, 20, 20, 0.55)';
/** Soft interior / context focus — same blue as selection chrome edge. */
export const FRAME_HIGHLIGHT_STROKE = '#3388ff';
/** Target hairline in CSS px after camera scale. */
export const FRAME_PLATE_STROKE_WIDTH = 1;

/** Scene stroke width so CSS `scale(zoom)` yields ~FRAME_PLATE_STROKE_WIDTH CSS px. */
export function framePlateStrokeSceneWidth(zoom: number): number {
  return FRAME_PLATE_STROKE_WIDTH / Math.max(0.05, Number(zoom) || 1);
}

/**
 * Crisp axis-aligned hairline on a Canvas2D context that already has a scene
 * transform — same miter closed-path recipe as stroked Kit rects (not strokeRect AA).
 *
 * Prefer {@link applyArtboardPlateEdgeStroke} for live plate chrome: artboard ink
 * canvas backing is edge-capped (`ARTBOARD_INK_MAX_EDGE`), so canvas hairlines vanish
 * when zoomed in past that cap.
 */
export function strokeCanvasPlateHairline(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  opts: { strokeCss: string; strokeWidth: number }
): void {
  const sw = Math.max(0, Number(opts.strokeWidth) || 0);
  if (!(sw > 0) || w <= 0 || h <= 0) return;
  const inset = sw / 2;
  ctx.beginPath();
  ctx.rect(inset, inset, Math.max(0, w - sw), Math.max(0, h - sw));
  ctx.strokeStyle = opts.strokeCss;
  ctx.lineWidth = sw;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.stroke();
}

/**
 * SVG plate edge — screen-constant hairline via scene width `1/zoom`.
 * Lives outside the ink FO so overflow:hidden / canvas scale caps cannot eat it.
 */
export function applyArtboardPlateEdgeStroke(
  edge: Element,
  opts: {
    selected: boolean;
    highlighted: boolean;
    zoom: number;
    width: number;
    height: number;
  }
): void {
  const w = Math.max(1, Number(opts.width) || 1);
  const h = Math.max(1, Number(opts.height) || 1);
  if (opts.selected) {
    edge.setAttribute('x', '0');
    edge.setAttribute('y', '0');
    edge.setAttribute('width', String(w));
    edge.setAttribute('height', String(h));
    edge.setAttribute('stroke', 'none');
    edge.removeAttribute('stroke-width');
    return;
  }
  const sw = framePlateStrokeSceneWidth(opts.zoom);
  edge.setAttribute('x', String(sw / 2));
  edge.setAttribute('y', String(sw / 2));
  edge.setAttribute('width', String(Math.max(0, w - sw)));
  edge.setAttribute('height', String(Math.max(0, h - sw)));
  edge.setAttribute(
    'stroke',
    opts.highlighted ? FRAME_HIGHLIGHT_STROKE : FRAME_PLATE_STROKE
  );
  edge.setAttribute('stroke-width', String(sw));
  edge.setAttribute('stroke-linejoin', 'miter');
  edge.setAttribute('stroke-linecap', 'butt');
  edge.setAttribute('fill', 'none');
}

export type ArtboardFrame = {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  backgroundColor: string;
  /** Artboard fill alpha, stored as a percentage from 0 to 100. */
  backgroundOpacity?: number;
  /**
   * Plate role. `animation` = 动画工作台 — same Kit artboard chrome
   * (fill / border / label / handles) as `artboard`; selection toolbar differs.
   * Default / omitted = normal artboard.
   */
  kind?: 'artboard' | 'animation';
  /** 动画工作台 composition length (seconds). */
  durationSec?: number;
  /** 动画工作台 frame rate. */
  fps?: number;
  layoutMode?: 'auto' | 'manual';
  /** When true, frame cannot be moved or resized. */
  locked?: boolean;
  /** When true, artboard plate + chrome are hidden (layer panel eye). */
  hidden?: boolean;
  /** When true, drag-resize / W·H edits keep width:height (Shift temporarily unlocks). */
  lockAspect?: boolean;
  /** When true, content outside the frame bounds is clipped (hidden). */
  clipContent?: boolean;
  /** Size before first ratio preset — restored by 「原始」. */
  aspectOriginalWidth?: number;
  aspectOriginalHeight?: number;
};

/** True for 动画工作台 plates. */
export function isAnimationArtboardKind(
  kind: ArtboardFrame['kind'] | string | null | undefined
): boolean {
  return kind === 'animation';
}
