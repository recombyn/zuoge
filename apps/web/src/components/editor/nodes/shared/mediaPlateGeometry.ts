import type { CSSProperties } from 'react';
import { radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';

export type MediaGeomOverride = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Live rotate preview — omit to use document attrs.angle. */
  angle?: number;
};

export type ScenePlateStyle = CSSProperties & {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function readOptionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function readNodeAngle(node: SceneNodeInput): number {
  const n = Number(node?.attrs?.angle);
  return Number.isFinite(n) ? n : 0;
}

export function plateTransform(angle: number): string | undefined {
  if (Math.abs(angle) <= 0.001) return undefined;
  return `rotate(${angle}deg)`;
}

export function buildScenePlateStyle(
  document: SceneDocument,
  node: SceneNodeInput,
  override?: MediaGeomOverride | null,
): ScenePlateStyle {
  const { left, top } = nodeLeftTop(document, node);
  const width = Math.max(1, override?.width ?? (Number(node.width) || 1));
  const height = Math.max(1, override?.height ?? (Number(node.height) || 1));
  const angle = Number.isFinite(override?.angle) ? Number(override!.angle) : readNodeAngle(node);
  const radii = radiiFromAttrs(node.attrs || {});
  return {
    left: override?.left ?? left,
    top: override?.top ?? top,
    width,
    height,
    borderRadius: `${radii.tl}px ${radii.tr}px ${radii.br}px ${radii.bl}px`,
    transform: plateTransform(angle),
    transformOrigin: 'center center',
  };
}
