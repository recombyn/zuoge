import type { SceneNodeInput } from '@/components/rcb/sceneNode';
export function boolEffectAttr(v: unknown, fallback: boolean) {
  if (v == null) return fallback;
  return v === true || v === 'true';
}

export function normalizeColor(color: unknown) {
  if (!color || typeof color !== 'string') return '#333333';
  const trimmed = color.trim();
  const cssVarMatch = trimmed.match(/rgb\(var\((--[\w-]+)\)\)/i);
  const CSS_VAR_COLORS: Record<string, string> = {
    '--orange-6': '#FF7D00',
    '--red-6': '#F53F3F',
    '--blue-6': '#165DFF',
  };
  if (cssVarMatch && CSS_VAR_COLORS[cssVarMatch[1]]) return CSS_VAR_COLORS[cssVarMatch[1]];
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgbMatch) {
    const r = Number(rgbMatch[1]);
    const g = Number(rgbMatch[2]);
    const b = Number(rgbMatch[3]);
    return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
  }
  return trimmed;
}

export function hexWithOpacity(hex: string, opacityPct: number) {
  const normalized = normalizeColor(hex);
  const pct = Math.min(100, Math.max(0, opacityPct));
  if (pct >= 100) return normalized;
  const raw = normalized.replace('#', '');
  if (raw.length !== 6) return normalized;
  const r = parseInt(raw.slice(0, 2), 16);
  const g = parseInt(raw.slice(2, 4), 16);
  const b = parseInt(raw.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${pct / 100})`;
}

export function resolveFillColor(node: SceneNodeInput, fallback = '#FFFFFF') {
  const attrs = node?.attrs || {};
  if (!boolEffectAttr(attrs['fill-enabled'], true)) return 'rgba(0,0,0,0)';
  const fill = attrs['fill-color'] ?? fallback;
  if (fill === 'transparent') return 'rgba(0,0,0,0)';
  const opacity = Number(attrs['fill-opacity'] ?? 100);
  if (!boolEffectAttr(attrs['fill-visible'], true)) return 'rgba(0,0,0,0)';
  return hexWithOpacity(String(fill ?? fallback), opacity);
}

export function resolveStroke(node: SceneNodeInput, fallback = '#333333') {
  const attrs = node?.attrs || {};
  if (!boolEffectAttr(attrs['stroke-enabled'], true) || !boolEffectAttr(attrs['stroke-visible'], true)) {
    return { stroke: 'transparent', strokeWidth: 0 };
  }
  const stroke = normalizeColor(attrs['border-color'] || fallback);
  const opacity = Number(attrs['stroke-opacity'] ?? 100);
  const color = hexWithOpacity(stroke, opacity);
  const rawW = attrs['border-width'];
  const parsed = rawW == null || rawW === '' ? 1 : parseFloat(String(rawW));
  const strokeWidth = Math.max(0, Number.isFinite(parsed) ? parsed : 0);
  return { stroke: color, strokeWidth };
}

export type StrokeAlign = 'center' | 'inside' | 'outside';
export type StrokeLinecap = 'butt' | 'round' | 'square';
export type StrokeLinejoin = 'miter' | 'round' | 'bevel';

export function resolveStrokeAlign(attrs: Record<string, unknown> | null | undefined): StrokeAlign {
  const v = String(attrs?.strokeAlign || 'center');
  if (v === 'inside' || v === 'outside' || v === 'center') return v;
  return 'center';
}

/**
 * Outside stroke needs an opaque fill to cover the inward half (SVG underlay trick).
 * Match {@link applyElementStroke} / {@link strokePaintMeta}.
 */
export function nodeHasOpaqueFillForStrokeAlign(node: SceneNodeInput): boolean {
  const fillType = String(node.attrs?.['fill-type'] || 'solid');
  if (fillType === 'solid' || fillType === '') {
    const fill = resolveFillColor(node, '#FFFFFF');
    if (!fill || fill === 'transparent' || fill === 'rgba(0,0,0,0)') return false;
    if (/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(fill)) return false;
    return true;
  }
  // gradient / image / mesh still cover the inner half
  return true;
}

/** Align used for Canvas/SVG paint after outside→center fallback when fill is transparent. */
export function resolveStrokeAlignForPaint(node: SceneNodeInput): StrokeAlign {
  let align = resolveStrokeAlign(node.attrs);
  if (align === 'outside' && !nodeHasOpaqueFillForStrokeAlign(node)) {
    return 'center';
  }
  return align;
}

function strokePaintMeta(node: SceneNodeInput): { align: StrokeAlign; strokeWidth: number } | null {
  if (!node) return null;
  const key = String(node.key || '');
  const shapeType = String(node.attrs?.shapeType || '');
  // Line/arrow use a dedicated hit height; freehand / pen store padded AABB already.
  if (shapeType === 'line' || shapeType === 'arrow' || shapeType === 'pencil' || shapeType === 'pen')
    return null;
  if (key === 'text' || key === 'frame') return null;
  if (key === 'image' || key === 'video' || key === 'lottie' || key === 'audio') return null;

  // Same color fallback as Kit style — a missing border-color still paints #333.
  const { stroke, strokeWidth } = resolveStroke(node, '#333333');
  if (!(strokeWidth > 0) || !stroke || stroke === 'transparent') return null;
  if (/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/i.test(stroke)) return null;

  const align = resolveStrokeAlignForPaint(node);
  return { align, strokeWidth };
}

/**
 * How far painted stroke extends **outside** the geometric box (≥ 0).
 * Hit-testing / outer-ink bounds — inside stroke stays within geom.
 */
export function strokeVisualOutset(node: SceneNodeInput): number {
  const meta = strokePaintMeta(node);
  if (!meta) return 0;
  if (meta.align === 'inside') return 0;
  if (meta.align === 'outside') return meta.strokeWidth;
  return meta.strokeWidth / 2;
}

/**
 * Scene distance from the path into the fill past the **inner** stroke edge.
 * Radius knobs park here so they stay inside the stroke band at any zoom
 * (stroke width is scene-constant; screen park alone cannot clear it).
 */
export function strokeInnerClearanceScene(node: SceneNodeInput): number {
  const meta = strokePaintMeta(node);
  if (!meta || !(meta.strokeWidth > 0)) return 0;
  if (meta.align === 'outside') return 0;
  if (meta.align === 'inside') return meta.strokeWidth;
  return meta.strokeWidth / 2;
}

/**
 * Scene distance from the path into the exterior past the **outer** stroke edge.
 * Rotate hotzones sit beyond this so they stay outside the stroke at any zoom.
 */
export function strokeOuterClearanceScene(node: SceneNodeInput): number {
  const meta = strokePaintMeta(node);
  if (!meta || !(meta.strokeWidth > 0)) return 0;
  if (meta.align === 'inside') return 0;
  if (meta.align === 'outside') return meta.strokeWidth;
  return meta.strokeWidth / 2;
}

/**
 * Selection and resize own the stored node geometry, not painted stroke ink.
 * This keeps every control edge on the same grid lattice as x/y/width/height;
 * visual stroke extent remains available through `strokeVisualOutset` for paint
 * and hit testing.
 */
export function strokeChromeOutset(_node: SceneNodeInput): number {
  return 0;
}

function padBox<T extends { left: number; top: number; width: number; height: number }>(
  box: T,
  pad: number
): T {
  if (!pad) return box;
  return {
    ...box,
    left: box.left - pad,
    top: box.top - pad,
    width: Math.max(1, box.width + pad * 2),
    height: Math.max(1, box.height + pad * 2),
  };
}

/** Selection chrome AABB from geometry (padded to visual outer when stroked). */
export function inflateBoxByStrokeOutset<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  return padBox(box, strokeChromeOutset(node));
}

/** Inverse — selection chrome → stored geometry. */
export function deflateBoxByStrokeOutset<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  return padBox(box, -strokeChromeOutset(node));
}

/** Outer-ink AABB from geometry (≥ geometry). For hit-testing thick strokes. */
export function inflateBoxByVisualOutset<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  return padBox(box, strokeVisualOutset(node));
}

/** Half-pixel quantize — same as createShapeNode (odd center strokes). */
function quantizeHalfPx(n: number) {
  return Math.round(n * 2) / 2;
}

/**
 * Outset as if stroke were painted (ignore current stroke-visible/enabled).
 * Used when turning stroke back on to inset geom again.
 */
function strokeVisualOutsetAssumingPainted(node: SceneNodeInput): number {
  if (!node) return 0;
  return strokeVisualOutset({
    ...node,
    attrs: {
      ...(node.attrs || {}),
      'stroke-enabled': 'true',
      'stroke-visible': 'true',
    },
  });
}

/**
 * Closed shapes drawn with center/outside stroke store path geom inset so outer
 * ink sits on the integer grid. AABB-only adjust — skip open strokes / freehand /
 * custom path `d` (those need curve offset, not box resize).
 */
function canAdjustClosedStrokeGeomBox(node: SceneNodeInput): boolean {
  if (!node) return false;
  const shapeType = String(node.attrs?.shapeType || '');
  if (
    shapeType === 'line' ||
    shapeType === 'arrow' ||
    shapeType === 'pencil' ||
    shapeType === 'pen' ||
    shapeType === 'path'
  ) {
    return false;
  }
  if (
    node.key === 'text' ||
    node.key === 'frame' ||
    node.key === 'image' ||
    node.key === 'video' ||
    node.key === 'lottie' ||
    node.key === 'audio'
  ) {
    return false;
  }
  // Boolean / pasted outlines keep absolute local `path` — resizing the box alone
  // would not grow the fill to the old outer ink.
  if (typeof node.attrs?.path === 'string' && String(node.attrs.path).trim()) {
    return false;
  }
  return true;
}

/** Inset (+delta) or expand (−delta) path so outer ink stays put. */
function patchNodeBoxByOutsetDelta(
  node: SceneNodeInput,
  delta: number,
  opts?: { rejectIfNoShrink?: boolean }
): { x: number; y: number; width: number; height: number } | null {
  if (!(Math.abs(delta) > 1e-9)) return null;
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const width = Math.max(1, Number(node.width) || 1);
  const height = Math.max(1, Number(node.height) || 1);
  const nextW = Math.max(1, width - delta * 2);
  const nextH = Math.max(1, height - delta * 2);
  if (opts?.rejectIfNoShrink && nextW >= width && nextH >= height) return null;
  return {
    x: quantizeHalfPx(x + delta),
    y: quantizeHalfPx(y + delta),
    width: quantizeHalfPx(nextW),
    height: quantizeHalfPx(nextH),
  };
}

/**
 * Closed shapes drawn with center stroke store path geom inset by sw/2 so outer
 * ink sits on the integer grid. Hiding stroke without expanding leaves the fill
 * on half-pixels. Expand/inset AABB to keep the visible edge stable.
 */
export function geometryPatchForStrokeVisibilityToggle(
  node: SceneNodeInput,
  nextVisible: boolean
): { x: number; y: number; width: number; height: number } | null {
  if (!canAdjustClosedStrokeGeomBox(node)) return null;

  const attrs = node.attrs || {};
  const currentlyVisible =
    boolEffectAttr(attrs['stroke-enabled'], true) && boolEffectAttr(attrs['stroke-visible'], true);
  if (currentlyVisible === nextVisible) return null;

  const outset = nextVisible
    ? strokeVisualOutsetAssumingPainted(node)
    : strokeVisualOutset(node);
  if (!(outset > 0)) return null;

  // Show → inset (+outset); hide → expand (−outset).
  return patchNodeBoxByOutsetDelta(node, nextVisible ? outset : -outset, {
    rejectIfNoShrink: nextVisible,
  });
}

/**
 * Keep **outer ink** fixed when border-width / strokeAlign change (panel edits).
 * Path insets or expands by Δoutset so the painted edge stays on the same grid.
 */
export function geometryPatchForStrokeOutsetChange(
  node: SceneNodeInput,
  nextAttrs: Record<string, unknown>
): { x: number; y: number; width: number; height: number } | null {
  if (!canAdjustClosedStrokeGeomBox(node)) return null;

  const prevOutset = strokeVisualOutset(node);
  const nextOutset = strokeVisualOutset({
    ...node,
    attrs: { ...(node.attrs || {}), ...nextAttrs },
  });
  return patchNodeBoxByOutsetDelta(node, nextOutset - prevOutset);
}

/** Scene-space air between text glyphs and selection chrome (flush / ~0). */
export const TEXT_SELECTION_PAD = 0;

export function inflateBoxByTextSelectionPad<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  if (node?.key !== 'text') return box;
  const pad = TEXT_SELECTION_PAD;
  return {
    ...box,
    left: box.left - pad,
    top: box.top - pad,
    width: Math.max(1, box.width + pad * 2),
    height: Math.max(1, box.height + pad * 2),
  };
}

export function deflateBoxByTextSelectionPad<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  if (node?.key !== 'text') return box;
  const pad = TEXT_SELECTION_PAD;
  return {
    ...box,
    left: box.left + pad,
    top: box.top + pad,
    width: Math.max(1, box.width - pad * 2),
    height: Math.max(1, box.height - pad * 2),
  };
}

/**
 * Selection chrome AABB = path geom (+ text pad). Stroke does not expand the
 * control box — knobs sit on the path; outer-ink snap uses visual outset.
 */
export function inflateSelectionBox<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  return inflateBoxByStrokeOutset(inflateBoxByTextSelectionPad(box, node), node);
}

/** Inverse of inflateSelectionBox for geometry commits. */
export function deflateSelectionBox<
  T extends { left: number; top: number; width: number; height: number },
>(box: T, node: SceneNodeInput): T {
  return deflateBoxByTextSelectionPad(deflateBoxByStrokeOutset(box, node), node);
}

export function resolveStrokeLinecap(attrs: Record<string, unknown> | null | undefined): StrokeLinecap {
  const v = String(attrs?.strokeLinecap || 'butt');
  if (v === 'butt' || v === 'round' || v === 'square') return v;
  return 'butt';
}

export function resolveStrokeLinejoin(attrs: Record<string, unknown> | null | undefined): StrokeLinejoin {
  const v = String(attrs?.strokeLinejoin || 'miter');
  if (v === 'miter' || v === 'round' || v === 'bevel') return v;
  return 'miter';
}

/** Match outline / design tools — keep acute pen tips (SVG default 4 clips them flat). */
export function resolveStrokeMiterlimit(attrs: Record<string, unknown> | null | undefined): number {
  const raw = attrs?.strokeMiterlimit;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.min(1000, Math.max(1, n));
  return 100;
}

export type ShadowSpec = {
  color: string;
  blur: number;
  offsetX: number;
  offsetY: number;
} | null;

export type InnerShadowSpec = ShadowSpec;

export type BackdropBlurSpec = {
  blur: number;
  brightness: number;
} | null;

export type ObjectBlurSpec = { blur: number } | null;

function effectNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function hasShadowGeometry(blur: number, offsetX: number, offsetY: number): boolean {
  return blur > 0 || offsetX !== 0 || offsetY !== 0;
}

export function resolveShadow(node: SceneNodeInput): ShadowSpec {
  const attrs = node?.attrs || {};
  if (!boolEffectAttr(attrs['shadow-enabled'], false) || !boolEffectAttr(attrs['shadow-visible'], true)) {
    return null;
  }
  const blur = Math.max(0, effectNumber(attrs['shadow-blur'] ?? 4, 4));
  const offsetX = effectNumber(attrs['shadow-x'] ?? 0, 0);
  const offsetY = effectNumber(attrs['shadow-y'] ?? 2, 2);
  if (!hasShadowGeometry(blur, offsetX, offsetY)) return null;
  return {
    color: String(attrs['shadow-color'] || 'rgba(0,0,0,0.25)'),
    blur,
    offsetX,
    offsetY,
  };
}

export function resolveInnerShadow(node: SceneNodeInput): InnerShadowSpec {
  const attrs = node?.attrs || {};
  if (
    !boolEffectAttr(attrs['inner-shadow-enabled'], false) ||
    !boolEffectAttr(attrs['inner-shadow-visible'], true)
  ) {
    return null;
  }
  const blur = Math.max(0, effectNumber(attrs['inner-shadow-blur'] ?? 4, 4));
  const offsetX = effectNumber(attrs['inner-shadow-x'] ?? 0, 0);
  const offsetY = effectNumber(attrs['inner-shadow-y'] ?? 2, 2);
  if (!hasShadowGeometry(blur, offsetX, offsetY)) return null;
  return {
    color: String(attrs['inner-shadow-color'] || 'rgba(0,0,0,0.25)'),
    blur,
    offsetX,
    offsetY,
  };
}

export function resolveBackdropBlur(node: SceneNodeInput): BackdropBlurSpec {
  const attrs = node?.attrs || {};
  if (!boolEffectAttr(attrs['backdrop-blur-enabled'], false)) return null;
  const blur = Math.max(0, effectNumber(attrs['backdrop-blur-amount'] ?? 12, 12));
  const brightness = Math.max(0, effectNumber(attrs['backdrop-blur-brightness'] ?? 100, 100));
  // A zero blur value is the panel's explicit off state. Do not leave a
  // brightness-only backdrop filter behind when the user returns blur to 0.
  if (blur === 0) return null;
  return {
    blur,
    brightness,
  };
}

/** Blur the selected object's own pixels (distinct from backdrop blur). */
export function resolveObjectBlur(node: SceneNodeInput): ObjectBlurSpec {
  const attrs = node?.attrs || {};
  if (!boolEffectAttr(attrs['blur-enabled'], false)) return null;
  return { blur: Math.max(0, Number(attrs['blur-amount'] ?? 12)) };
}
