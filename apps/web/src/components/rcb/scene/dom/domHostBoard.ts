/**

 * DomHost board helpers — empty SVG anchors for HTML FO (lottie/group/media).

 * Kit paints all ink. Prefer `@/components/rcb/scene/dom/domHostShell` for shell primitives.

 */

export {
  HTML_MEDIA_MOUNT_ATTR,
  findHtmlMediaMount,
  ensureHtmlMediaMount,
  syncHtmlMediaMountGeometry,
  nodeNeedsHtmlMediaMount,
  createDomHostBoard,
  mountDomHostAnchor,
  remountDomHostAnchor,
  removeDomHostAnchor,
  type DomHostEl,
} from './domHostShell';


import type { SceneDocument } from '@/components/rcb/sceneNode';



/** Clear DomHost layer; Kit owns ink membership. */

export async function mountDomHostBoard(

  _root: SVGSVGElement,

  layer: SVGElement,

  _document: SceneDocument

): Promise<Map<string, SVGElement>> {

  while (layer.firstChild) layer.removeChild(layer.firstChild);

  return new Map();

}



export function dedupeSceneNode(

  layer: SVGElement,

  nodeId: string,

  keep?: SVGElement | null

): void {

  const matches = [...layer.querySelectorAll('[data-scene-node-id], [data-node-id]')].filter(

    (n) =>

      n.getAttribute('data-scene-node-id') === nodeId ||

      n.getAttribute('data-node-id') === nodeId

  );

  if (matches.length <= 1) return;

  const survivor = keep && matches.includes(keep) ? keep : matches[matches.length - 1];

  matches.forEach((n) => {

    if (n !== survivor) n.parentNode?.removeChild(n);

  });

}



export function editorChromeStrokeSceneWidth(cssPx = 1): number {

  return Math.max(1e-4, cssPx);

}



export function applyInfiniteSvgViewport(_root: SVGSVGElement): void {

  /* Kit owns viewport */

}



export function videoSvgOwnsPixels(_root: SVGSVGElement): boolean {

  return false;

}



export function panInfiniteSvgViewport(): void {

  /* Kit owns viewport */

}



export function fitInfiniteSvgToContent(): void {

  /* Kit owns viewport */

}



export function clearSceneDragPreview(

  _nodeEls?: Map<string, SVGElement> | null,

  _nodeId?: string

): void {

  /* Kit owns ink */

}



export function readScenePaintLocalSize(

  _el: SVGElement | null | undefined,

  fallback: { width: number; height: number }

): { width: number; height: number } {

  return {

    width: Math.max(1, fallback.width),

    height: Math.max(1, fallback.height),

  };

}



export function purgeOrphanSceneNodes(

  layer: SVGElement,

  nodeEls: Map<string, SVGElement>,

  validIds?: Iterable<string>

): void {

  const allowed = validIds ? new Set(validIds) : null;

  layer.querySelectorAll('[data-scene-node-id], [data-node-id]').forEach((n) => {

    const id = n.getAttribute('data-scene-node-id') || n.getAttribute('data-node-id');

    if (!id) return;

    if (allowed && !allowed.has(id)) {

      n.parentNode?.removeChild(n);

      return;

    }

    const keep = nodeEls.get(id);

    if (keep && n !== keep) n.parentNode?.removeChild(n);

  });

}


