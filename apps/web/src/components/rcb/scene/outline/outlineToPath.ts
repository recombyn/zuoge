/**
 * Outline / path-edit helpers — Kit paints ink + convertToPath.
 * Classifies editable path attrs and builds attrs patches when a caller
 * already has outline geometry.
 */
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { isCustomPathShape } from '@/components/rcb/scene/document/pathScale';

export type OutlineResult = {
  path: string;
  width: number;
  height: number;
  [key: string]: unknown;
};

/** Path / pen / pencil shapes with a `path` attr — editable in path-edit / resume. */
export function isEditablePathNode(node: SceneNodeInput | null | undefined): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  if (key !== 'shape' && key !== 'path') return false;
  const shapeType = String(node.attrs?.shapeType || (key === 'path' ? 'path' : '')).toLowerCase();
  if (!isCustomPathShape(shapeType)) return false;
  return Boolean(String(node.attrs?.path || '').trim());
}

/** Apply outline geometry onto a node (attrs + size). Kit owns convertToPath paint. */
export function outlineNodePatch(
  node: SceneNodeInput,
  outline: OutlineResult
): Partial<SceneNodeInput> {
  return {
    attrs: {
      ...(node.attrs || {}),
      path: outline.path,
      outlined: true,
      shapeType: 'path',
    },
    width: outline.width,
    height: outline.height,
  };
}
