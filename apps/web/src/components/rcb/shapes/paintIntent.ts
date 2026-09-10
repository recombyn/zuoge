/**
 * Kit-only paint route (vector-editor-ref / CanvasKit).
 * DomHost is reserved for HTML widgets Kit cannot replace.
 */
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  isAudioNode,
  isEmptyGeneratorPlate,
  isVideoNode,
} from '@/components/rcb/scene/document/nodeCapabilities';

export type PaintIntent =
  | { kind: 'kit' }
  | { kind: 'dom-host'; reason: string };

export type PaintIntentCtx = {
  /** Active video/audio FO shell (HTML decoder). SoftGlow uses its own route. */
  forceFull?: boolean;
};

/**
 * Resolve paint route. Kit owns vector / image ink.
 * DomHost: lottie/group shells, active video/audio FO. SoftGlow → Kit overlay.
 * Empty generators: Kit gray wash + Lucide glyph overlay (no DomHost).
 */
export function resolvePaintIntent(
  _document: SceneDocument | null | undefined,
  _id: string,
  node: SceneNodeInput | null | undefined,
  ctx: PaintIntentCtx = {}
): PaintIntent {
  if (!node) {
    return { kind: 'dom-host', reason: 'missing-node' };
  }
  const key = String(node.key || '');
  // Kit owns wash + center glyph + pick (see kitBridge drawProductSceneOverlay).
  if (isEmptyGeneratorPlate(node)) {
    return { kind: 'kit' };
  }
  // Upload / remove-bg / 图片分层 — Kit SoftGlow (same for video/audio as images).
  // Do not mount HTML decoder FO while processStatus is running.
  if (String(node.attrs?.processStatus || '') === 'running') {
    return { kind: 'kit' };
  }
  if (key === 'lottie' || key === 'group') {
    return { kind: 'dom-host', reason: key };
  }
  // Active HTML decoder shell only.
  if (ctx.forceFull && (isVideoNode(node) || isAudioNode(node) || key === 'video' || key === 'audio')) {
    return { kind: 'dom-host', reason: 'html-media-fo' };
  }
  return { kind: 'kit' };
}

export function paintIntentNeedsDomHost(
  document: SceneDocument | null | undefined,
  id: string,
  node: SceneNodeInput | null | undefined,
  opts?: PaintIntentCtx
): boolean {
  return resolvePaintIntent(document, id, node, opts).kind === 'dom-host';
}
