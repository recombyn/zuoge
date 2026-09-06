/**
 * Dual-backend ink contract (final state).
 * Shape ink is always vector — WebGL mesh or Canvas2D Path2D — never atlas bake.
 */

/** Product idle ink backends after vector migration. */
export type InkBackend = 'webgl-vector' | 'canvas2d-vector';

/**
 * Shape / text / path ink must never use atlas bake.
 * Media (image/video/audio) still uses GPU atlas textures.
 */
export function isShapeInkKey(key: string, shapeType?: string): boolean {
  const k = String(key || '').toLowerCase();
  const t = String(shapeType || '').toLowerCase();
  if (k === 'image' || k === 'video' || k === 'audio' || k === 'lottie') return false;
  // Text idle is glyph outline mesh — not atlas.
  if (k === 'text' || t === 'text') return true;
  if (k === 'shape' || k === 'path') return true;
  return (
    t === 'rect' ||
    t === 'roundrect' ||
    t === 'circle' ||
    t === 'ellipse' ||
    t === 'oval' ||
    t === 'triangle' ||
    t === 'polygon' ||
    t === 'star' ||
    t === 'line' ||
    t === 'arrow' ||
    t === 'pen' ||
    t === 'pencil' ||
    t === 'path' ||
    t === ''
  );
}

/** Gate: shape ink forbids atlas stamps / bake tiles. */
export function shapeInkForbidsAtlas(
  node: { key?: unknown; attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  const t = String(node.attrs?.shapeType || (key === 'shape' ? 'rect' : key) || '');
  return isShapeInkKey(key, t);
}
