/**
 * Unified paint-order contract: visual stacking is `stackOrder` only.
 *
 * Physical surfaces may differ (Kit ink vs SVG hosts), but anything that
 * participates in cross-type occlusion (artboard plates, DOM hosts, world nodes
 * above plates) shares one SVG mount ordered by `data-z` = stack z. Kit ink sits
 * under that mount and only paints nodes that do not need to interleave with
 * plates (world nodes below all frames). Selection raise is temporary max+1.
 *
 * Do not add per-key CSS z bands or type-specific "always on top" hacks.
 */
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  maxDocumentStackZ,
  nodePaintZIndex,
  selectionPaintZIndex,
  stackZIndex,
} from '@/components/rcb/scene/document/sceneDocument';
import { syncSharedMountPaintOrder } from '@/components/rcb/shapes/shapeHostRegistry';

/** Stack z for paint (`data-z`), including temporary selection raise. */
export function stackPaintZ(
  doc: SceneDocument | null | undefined,
  kind: 'frame' | 'node',
  id: string,
  raised = false
): number {
  if (kind === 'node') return nodePaintZIndex(doc, id, raised);
  return selectionPaintZIndex(doc, kind, id, raised);
}

/** Persistent max stack depth (no selection raise). */
export function stackPaintMaxZ(doc: SceneDocument | null | undefined): number {
  return maxDocumentStackZ(doc);
}

/** Natural stack z without selection raise. */
export function stackPaintNaturalZ(
  doc: SceneDocument | null | undefined,
  kind: 'frame' | 'node',
  id: string
): number {
  return stackZIndex(doc, kind, id);
}

/** Re-sort the shared plate+host mount by `data-z` / stackOrder. */
export function syncStackPaintOrder(mount?: SVGGElement | null): void {
  syncSharedMountPaintOrder(mount);
}
