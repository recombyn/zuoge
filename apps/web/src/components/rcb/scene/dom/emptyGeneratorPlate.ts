/**
 * Empty generator center glyph — HTML overlay only (fallback / export).
 * Kit paints wash + Lucide strokes on the canvas; this overlay stays transparent
 * so a missing Kit decorate pass still shows the icon without a second wash.
 *
 * Icons are built from `generatorEmptyIcons` path data — never `svg?raw` under
 * `vite-plugin-svg-icons` (that pipeline can leave a blank rect in the plate).
 */
import {
  buildGeneratorEmptyIconSvg,
  type GeneratorEmptyIconKind,
} from '@/components/rcb/core/generatorEmptyIcons';
import { generatorEmptyIconSize, generatorEmptyIconVisible } from '@/components/rcb/core/layout';
import {
  isAudioGeneratorNode,
  isEmptyGeneratorPlate,
  isImageGeneratorNode,
  isLottieGeneratorNode,
  isVideoGeneratorNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import type { SceneNodeInput } from '@/components/rcb/sceneNode';
import { isKitBridgeAttached } from '@/components/rcb/canvas/kitBridge';

function iconKindForNode(node: SceneNodeInput): GeneratorEmptyIconKind | null {
  if (isImageGeneratorNode(node) || isLottieGeneratorNode(node)) return 'image';
  if (isVideoGeneratorNode(node)) return 'video';
  if (isAudioGeneratorNode(node)) return 'audio';
  return null;
}

/** Mount HTML Lucide glyph over Kit wash (pointer-events none — Kit picks). */
export function mountEmptyGeneratorIconOverlay(
  parent: HTMLElement,
  node: SceneNodeInput,
  nodeId: string
): HTMLElement | null {
  if (!isEmptyGeneratorPlate(node)) return null;
  // Kit `drawProductSceneOverlay` owns the glyph — avoid double (darker) paint.
  if (isKitBridgeAttached()) return null;
  const el = globalThis.document.createElement('div');
  el.setAttribute('data-rcb-gen-empty-icon', '1');
  el.setAttribute('data-scene-node-id', nodeId);
  el.setAttribute('data-rcb-dom-host', '1');
  parent.appendChild(el);
  syncEmptyGeneratorIconOverlay(el, node);
  return el;
}

/** Keep icon box aligned to scene geometry (Kit wash is SoT for the plate). */
export function syncEmptyGeneratorIconOverlay(
  el: HTMLElement,
  node: SceneNodeInput
): void {
  if (!isEmptyGeneratorPlate(node)) return;
  // Kit owns the glyph while the canvas bridge is live.
  if (isKitBridgeAttached()) {
    el.innerHTML = '';
    el.removeAttribute('data-icon-token');
    return;
  }
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const x = Number(node.x) || 0;
  const y = Number(node.y) || 0;
  const kind = iconKindForNode(node);
  const icon = kind ? generatorEmptyIconSize(w, h) : 0;
  const show = Boolean(kind && generatorEmptyIconVisible(icon));

  // Transparent — Kit owns the gray wash. Only the Lucide glyph lives here.
  el.style.cssText = [
    'position:absolute',
    `left:${x}px`,
    `top:${y}px`,
    `width:${w}px`,
    `height:${h}px`,
    'pointer-events:none',
    'overflow:hidden',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-sizing:border-box',
    'background:transparent',
  ].join(';');

  if (!show || !kind) {
    el.innerHTML = '';
    el.removeAttribute('data-icon-token');
    return;
  }
  const token = `${kind}|${Math.round(icon)}`;
  if (el.dataset.iconToken === token && el.querySelector('svg')) {
    const svg = el.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', String(Math.round(icon)));
      svg.setAttribute('height', String(Math.round(icon)));
    }
    return;
  }
  el.dataset.iconToken = token;
  el.innerHTML = buildGeneratorEmptyIconSvg(kind, icon);
}

/** @deprecated Prefer mountEmptyGeneratorIconOverlay. */
export function paintEmptyGeneratorPlate(
  host: HTMLElement,
  node: SceneNodeInput,
  nodeId: string
): void {
  if (host.getAttribute('data-rcb-gen-empty-icon') === '1') {
    syncEmptyGeneratorIconOverlay(host, node);
    return;
  }
  mountEmptyGeneratorIconOverlay(host, node, nodeId);
}
