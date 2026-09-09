/**
 * Map RCB toolbar / editor.activeTool ids → Kit tool ids.
 *
 * Single ownership table — every create/select gesture goes to InputManager.
 * Do not invent parallel RCB draw Features.
 */
import pencilCursorUrl from '@/assets/svg/editor/cursor_pencil.svg?url';
import penCursorUrl from '@/assets/svg/editor/cursor_pen.svg?url';
import bucketCursorUrl from '@/assets/svg/editor/cursor_bucket.svg?url';

/** CSS cursors — icons in `assets/svg/editor/cursor_*.svg` (hotspot = tip). */
export const PENCIL_CURSOR = `url("${pencilCursorUrl}") 2 13, crosshair`;
export const PEN_CURSOR = `url("${penCursorUrl}") 1 1, crosshair`;
export const BUCKET_CURSOR = `url("${bucketCursorUrl}") 15 18, fill`;

/**
 * RCB toolbar / shapeKind → Kit UIEngine.activeTool.
 * Arrow has no Kit tool — maps to `line` (open path), tagged arrow in SceneDocument.
 */
const RCB_TO_ENGINE: Record<string, string> = {
  select: 'selection',
  selection: 'selection',
  scale: 'selection',
  direct: 'direct',
  rect: 'rect',
  rectangle: 'rect',
  circle: 'ellipse',
  ellipse: 'ellipse',
  oval: 'ellipse',
  polygon: 'polygon',
  star: 'star',
  line: 'line',
  arrow: 'line',
  pen: 'pen',
  pencil: 'pencil',
  brush: 'pencil',
  frame: 'artboard',
  artboard: 'artboard',
  text: 'text',
  type: 'text',
  bucket: 'paint-bucket',
  'paint-bucket': 'paint-bucket',
  eyedropper: 'eyedropper',
  pipette: 'eyedropper',
  scissors: 'scissors',
  'add-anchor': 'scissors',
  mesh: 'mesh',
};

/** Kit draw tools that create via previewRect / pencil / pen / text / artboard. */
export const ENGINE_DRAW_TOOLS = new Set([
  'rect',
  'ellipse',
  'polygon',
  'star',
  'line',
  'pen',
  'pencil',
  'artboard',
  'text',
]);

export const ENGINE_SELECT_TOOLS = new Set(['selection', 'direct']);

/** Kit owns Live Paint / path-edit / eyedropper / mesh tools that are neither draw nor select. */
export const ENGINE_EDIT_TOOLS = new Set(['paint-bucket', 'scissors', 'eyedropper', 'mesh']);

/**
 * Resolve the tool id that Kit InputManager should run.
 * When toolbar is on the shape flyout (`activeTool === 'shape'`), use `shapeKind`.
 */
export function resolveEngineTool(
  activeTool: string | null | undefined,
  shapeKind?: string | null
): string {
  const tool = String(activeTool ?? 'select').toLowerCase();
  if (tool === 'shape') {
    return rcbToolToEngine(shapeKind || 'rect');
  }
  return rcbToolToEngine(tool);
}

export function rcbToolToEngine(rcbTool: string | null | undefined): string {
  const key = String(rcbTool ?? 'select').toLowerCase();
  if (key === 'shape') return 'rect';
  return RCB_TO_ENGINE[key] ?? 'selection';
}

/**
 * Kit owns stage pointer: draw + select/direct + bucket + eyedropper + mesh.
 * Media place (image/video/audio/lottie) stays off Kit interactive — image
 * still commits via WasmScene.placeImage from a thin click/drop listener.
 */
export function kitOwnsStagePointer(
  rcbTool: string | null | undefined,
  shapeKind?: string | null
): boolean {
  const key = String(rcbTool ?? 'select').toLowerCase();
  if (
    key === 'image' ||
    key === 'video' ||
    key === 'audio' ||
    key === 'lottie' ||
    key === 'hand' ||
    key === 'pan' ||
    key === 'comment'
  ) {
    return false;
  }
  const engine = resolveEngineTool(rcbTool, shapeKind);
  return (
    ENGINE_DRAW_TOOLS.has(engine) ||
    ENGINE_SELECT_TOOLS.has(engine) ||
    ENGINE_EDIT_TOOLS.has(engine)
  );
}

/** Product shapeKinds that are Kit draw tools (for tests / strip checks). */
export const KIT_SHAPE_KINDS = [
  'rect',
  'line',
  'circle',
  'ellipse',
  'polygon',
  'star',
] as const;

export const KIT_STANDALONE_TOOLS = [
  'select',
  'pen',
  'pencil',
  'text',
  'frame',
  'bucket',
  'eyedropper',
  'mesh',
  'direct',
] as const;
