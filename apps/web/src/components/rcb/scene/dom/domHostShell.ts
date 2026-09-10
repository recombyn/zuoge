/**
 * DomHost mount shell — HTML FO (lottie/group/media). Kit paints vector / image ink
 * and SoftGlow process plates (see processPlateKit + kitBridge overlay).
 */
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { isEmptyGeneratorPlate } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  append,
  clearChildren,
  createSvgRoot,
  setAttrs,
  setStyles,
  svgEl,
} from './svgDom';

export const HTML_MEDIA_MOUNT_ATTR = 'data-rcb-html-media-mount';

export type DomHostEl = SVGElement & {
  sceneNodeId?: string;
  sceneNodeKey?: string;
  [key: string]: unknown;
};

function isDomQueryRoot(host: unknown): host is Element {
  return Boolean(
    host &&
      typeof host === 'object' &&
      typeof (host as Element).querySelector === 'function'
  );
}

function isExportSurface(el: Element | null | undefined): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('[data-rcb-export-surface="1"]'));
}

/** Find `[data-rcb-html-media-mount]` under a DomHost paint root. */
export function findHtmlMediaMount(host: Element | null | undefined): Element | null {
  if (!isDomQueryRoot(host)) return null;
  return host.querySelector(`[${HTML_MEDIA_MOUNT_ATTR}]`);
}

/** Keep FO + parent transform in sync with SceneDocument geometry / flip / angle. */
export function syncHtmlMediaMountGeometry(
  parent: SVGElement,
  node: SceneNodeInput
): void {
  const mount = findHtmlMediaMount(parent);
  if (!(mount instanceof HTMLElement)) return;
  const fo = mount.closest('foreignObject');
  if (!(fo instanceof SVGForeignObjectElement) && !(fo instanceof SVGElement)) return;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  setAttrs(parent, { transform: nodeHostTransform(node) });
  setAttrs(fo, { x: 0, y: 0, width: w, height: h });
}

function attrFlagTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * Video/audio FO flip lives on media pixels (chrome stays upright).
 * Lottie/group apply flip on the host transform with angle.
 */
function hostIsolatesHtmlMediaFlip(node: SceneNodeInput): boolean {
  const key = String(node.key || '');
  return key === 'video' || key === 'audio';
}

/** Scene translate + optional rotate/flip about the local box center. */
function nodeHostTransform(node: SceneNodeInput): string {
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const attrs = (node.attrs || {}) as Record<string, unknown>;
  const angle = Number(attrs.angle) || 0;
  const isolateFlip = hostIsolatesHtmlMediaFlip(node);
  const flipX = !isolateFlip && attrFlagTrue(attrs.flipX);
  const flipY = !isolateFlip && attrFlagTrue(attrs.flipY);
  if (!angle && !flipX && !flipY) return `translate(${x} ${y})`;
  const cx = w / 2;
  const cy = h / 2;
  const parts = [`translate(${x} ${y})`, `translate(${cx} ${cy})`];
  if (angle) parts.push(`rotate(${angle})`);
  if (flipX || flipY) parts.push(`scale(${flipX ? -1 : 1} ${flipY ? -1 : 1})`);
  parts.push(`translate(${-cx} ${-cy})`);
  return parts.join(' ');
}

/**
 * Ensure a foreignObject + HTML mount div for Lottie / video / audio portals.
 * Call when mounting DomHost anchors for those keys.
 */
export function ensureHtmlMediaMount(
  parent: SVGElement,
  node: SceneNodeInput,
  _nodeId: string
): HTMLElement {
  const existing = findHtmlMediaMount(parent);
  if (existing instanceof HTMLElement) {
    syncHtmlMediaMountGeometry(parent, node);
    return existing;
  }

  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  setAttrs(parent, {
    transform: nodeHostTransform(node),
  });

  const fo = svgEl('foreignObject', {
    x: 0,
    y: 0,
    width: w,
    height: h,
    'data-rcb-html-media-fo': String(node.key || 'media'),
  });
  // HTML namespace div — createPortal / lottie container target.
  const div = document.createElement('div');
  div.setAttribute(HTML_MEDIA_MOUNT_ATTR, '1');
  div.style.cssText =
    'width:100%;height:100%;overflow:hidden;pointer-events:none;position:relative;';
  fo.appendChild(div);
  append(parent, fo);
  return div;
}

/**
 * Keys that need an HTML FO mount for portals (not Kit ink).
 * Empty generator plates stay icon-only HTML (Kit wash). Export surfaces skip FO.
 */
export function nodeNeedsHtmlMediaMount(
  node: SceneNodeInput | null | undefined,
  parent?: Element | null
): boolean {
  if (!node) return false;
  if (isEmptyGeneratorPlate(node)) return false;
  if (parent && isExportSurface(parent)) return false;
  const key = String(node.key || '');
  return key === 'lottie' || key === 'video' || key === 'audio' || key === 'group';
}

/** Shared or private DomHost board — not an ink surface.
 *  Shared path mounts under the HTML camera layer (`sharedMount` HTMLElement)
 *  with a tiny private SVG for FO / clipPath (no full-stage scene SVG). */
export function createDomHostBoard(
  host: HTMLElement,
  width = 1,
  height = 1,
  opts?: {
    infinite?: boolean;
    /** @deprecated Shared surface is HTML; ignored when sharedMount is set. */
    sharedRoot?: Element | null;
    sharedMount?: HTMLElement | null;
  }
): {
  root: SVGSVGElement;
  layer: SVGGElement;
  /** Element under sharedMount that owns data-z (HTML wrap or private svg host). */
  hostLayer: HTMLElement;
  shared: boolean;
} {
  const sharedMount = opts?.sharedMount ?? null;
  if (sharedMount) {
    const hostLayer = document.createElement('div');
    hostLayer.setAttribute('data-rcb-dom-host-layer', '1');
    hostLayer.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;overflow:visible;pointer-events:none;';
    sharedMount.appendChild(hostLayer);

    const root = createSvgRoot(hostLayer);
    setAttrs(root, {
      width: 1,
      height: 1,
      viewBox: '0 0 1 1',
      overflow: 'visible',
      preserveAspectRatio: 'none',
      'pointer-events': 'none',
      'data-rcb-infinite': '1',
      'data-rcb-dom-host-svg': '1',
    });
    setStyles(root, {
      display: 'block',
      overflow: 'visible',
      position: 'absolute',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
    });
    const layer = svgEl('g', { id: 'dom-host-layer' });
    append(root, layer);
    return { root, layer, hostLayer, shared: true };
  }

  clearChildren(host);
  const root = createSvgRoot(host);
  if (opts?.infinite) {
    setAttrs(root, {
      width: 1,
      height: 1,
      viewBox: '0 0 1 1',
      overflow: 'visible',
      preserveAspectRatio: 'none',
      'pointer-events': 'none',
      'data-rcb-infinite': '1',
    });
    setStyles(root, {
      display: 'block',
      overflow: 'visible',
      position: 'absolute',
      left: '0',
      top: '0',
      width: '1px',
      height: '1px',
    });
  } else {
    setAttrs(root, {
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      preserveAspectRatio: 'none',
    });
    setStyles(root, {
      display: 'block',
      overflow: 'visible',
      width: '100%',
      height: '100%',
    });
  }
  const layer = svgEl('g', { id: 'dom-host-layer' });
  append(root, layer);
  return { root, layer, hostLayer: host, shared: false };
}

/** Empty `<g>` anchor for HTML FO (lottie / video / audio / group). */
export function mountDomHostAnchor(
  parent: SVGElement,
  node: SceneNodeInput | null | undefined,
  nodeId: string
): SVGElement | null {
  if (!node) return null;
  const g = svgEl('g', {
    'data-node-id': nodeId,
    'data-scene-node-id': nodeId,
    'data-scene-node-key': String(node.key || ''),
    'data-rcb-dom-host': '1',
  }) as unknown as DomHostEl;
  g.sceneNodeId = nodeId;
  g.sceneNodeKey = String(node.key || '');
  append(parent, g);

  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  setAttrs(g, { transform: `translate(${x} ${y})` });

  if (nodeNeedsHtmlMediaMount(node, parent)) {
    ensureHtmlMediaMount(g, node, nodeId);
  }
  return g;
}

export function removeDomHostAnchor(layer: SVGElement, nodeId: string): void {
  layer.querySelectorAll('[data-scene-node-id], [data-node-id]').forEach((n) => {
    const id = n.getAttribute('data-scene-node-id') || n.getAttribute('data-node-id');
    if (id === nodeId) n.parentNode?.removeChild(n);
  });
}

export async function remountDomHostAnchor(
  _root: SVGSVGElement,
  layer: SVGElement,
  document: SceneDocument,
  nodeEls: Map<string, SVGElement>,
  nodeId: string
): Promise<void> {
  const prev = nodeEls.get(nodeId);
  if (prev?.parentNode) prev.parentNode.removeChild(prev);
  nodeEls.delete(nodeId);
  removeDomHostAnchor(layer, nodeId);
  const node = document?.deltaSetLike?.[nodeId];
  if (!node) return;
  const el = mountDomHostAnchor(layer, node, nodeId);
  if (el) nodeEls.set(nodeId, el);
}
