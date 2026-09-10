/** Node predicates: is* / supports* (no document writes). */

import type { SceneDocument } from '@/components/rcb/sceneNode';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import type { SceneNodeAttrs } from '@/components/rcb/sceneNode';
import {
  isHiddenByAnimationWorkbenchFocus,
  isInactiveAtAnimationPlayhead,
  isAnimationWorkbenchPreviewChild,
  isBoundOutsideOwningClipPlate,
  isArtboardVisibleInDocument,
  canBindToArtboard,
  getWorkbenchToolPolicy,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';

export {
  isArtboardVisibleInDocument,
  canBindToArtboard,
  getWorkbenchToolPolicy,
};
import { isHiddenByLottiePrecompEditFocus } from '@/components/editor/nodes/AnimationNode/animationPrecompEditFocus';

/**
 * Predicate input — full `SceneNode` or a key/attrs stub (layer list, tests).
 */
export type SceneNodeRef = {
  key?: string;
  attrs?: SceneNodeAttrs | null;
} | null | undefined;

function attrFlagTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function looksLikeSvgSrc(src: string) {
  const s = String(src || '').trim();
  if (!s) return false;
  if (s.startsWith('data:image/svg+xml')) return true;
  const path = s.split('?')[0].toLowerCase();
  return path.endsWith('.svg');
}

export function isTextNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'text';
}

/** Canvas image-generator plate (empty image + generator overlay until promote). */
export function isImageGeneratorNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'image' && attrFlagTrue(node!.attrs?.imageGenerator);
}

/** Canvas video-generator plate (empty video + generator overlay until promote). */
export function isVideoGeneratorNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'video' && attrFlagTrue(node!.attrs?.videoGenerator);
}

/** Canvas Lottie-generator plate (empty lottie + composer until promote). */
export function isLottieGeneratorNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'lottie' && attrFlagTrue(node!.attrs?.lottieGenerator);
}

/** Canvas audio-generator plate (empty audio + generator overlay until promote). */
export function isAudioGeneratorNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'audio' && attrFlagTrue(node!.attrs?.audioGenerator);
}

/**
 * Empty generator plates (no bitmap/poster yet).
 * Kit owns gray wash + Lucide glyph + pick/select/move.
 */
export function isEmptyGeneratorPlate(node: SceneNodeRef): boolean {
  if (!node) return false;
  if (isLottieGeneratorNode(node)) return true;
  if (isAudioGeneratorNode(node)) return true;
  if (isImageGeneratorNode(node)) {
    return !String(node!.attrs?.src || '').trim();
  }
  if (isVideoGeneratorNode(node)) {
    const attrs = node!.attrs || {};
    return !String(attrs.poster || '').trim() && !String(attrs.src || '').trim();
  }
  return false;
}

/** Image / video / Lottie / audio generator plates — not real scene content (no hide / lock / export). */
export function isGeneratorNode(node: SceneNodeRef): boolean {
  return (
    isImageGeneratorNode(node) ||
    isVideoGeneratorNode(node) ||
    isLottieGeneratorNode(node) ||
    isAudioGeneratorNode(node)
  );
}

export function isVideoNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'video' && !isVideoGeneratorNode(node);
}

/** Finished audio plate (not a generator composer). */
export function isAudioNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'audio' && !isAudioGeneratorNode(node);
}

/** Layer hidden — skipped in SVG render + hit-test. */
export function isNodeHidden(node: SceneNodeRef): boolean {
  return Boolean(node) && attrFlagTrue(node!.attrs?.hidden);
}

export function isArtboardFrameHidden(
  frame: { hidden?: unknown } | null | undefined
): boolean {
  return Boolean(frame?.hidden);
}

export function findArtboardFrame(
  document: SceneDocument | null | undefined,
  frameId: string | null | undefined
) {
  const id = String(frameId || '').trim();
  if (!id || !document?.frames) return undefined;
  return document.frames.find((f) => String(f?.id) === id);
}

function resolveNodeId(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef
): string {
  const direct = String((node as { id?: unknown })?.id || '').trim();
  if (direct) return direct;
  const map = document?.deltaSetLike;
  if (!map || !node) return '';
  for (const [id, n] of Object.entries(map)) {
    if (n === node) return id;
  }
  return '';
}

/**
 * Structural hide (attrs.hidden / workbench focus / precomp / parent frame).
 * Same contract as LayerPanel `attrs.hidden` — does not include playhead trim.
 */
export function isNodeStructurallyHiddenInDocument(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef
): boolean {
  if (!node || isNodeHidden(node)) return true;
  if (isHiddenByAnimationWorkbenchFocus(node)) return true;
  if (isBoundOutsideOwningClipPlate(document, node)) return true;
  if (isHiddenByLottiePrecompEditFocus(resolveNodeId(document, node), node)) return true;
  const frameId = String(node.attrs?.frameId || '').trim();
  if (!frameId) return false;
  return isArtboardFrameHidden(findArtboardFrame(document, frameId));
}

/**
 * Editor visibility for hit / chrome / marquee.
 * Includes playhead out-of-range (same as hiding the layer for interaction).
 * Pass `playheadSec` from the editor store during React render when needed for sync.
 *
 * Do **not** use this to drive SVG/host paint opacity — playhead ink hide is
 * live DOM in AnimationPlayheadSceneSync; React hosts that skip playhead
 * subscriptions would stay at opacity 0 until an unrelated re-render.
 */
export function isNodeHiddenInDocument(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef,
  playheadSec?: number
): boolean {
  if (isNodeStructurallyHiddenInDocument(document, node)) return true;
  return isInactiveAtAnimationPlayhead(document, node, playheadSec);
}

/**
 * Hit / marquee / chrome pick gate: not hidden (incl. playhead) and not
 * workbench preview-only child.
 */
export function isNodePickableInDocument(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef,
  playheadSec?: number
): boolean {
  if (isNodeHiddenInDocument(document, node, playheadSec)) return false;
  if (isAnimationWorkbenchPreviewChild(document, node)) return false;
  return true;
}

/** Marquee + smart guides skip non-pickable and locked nodes. */
export function isNodeMarqueeSkippable(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef
): boolean {
  return !isNodePickableInDocument(document, node) || isNodeLocked(node);
}

/**
 * SVG paint list — structural hide only.
 * Playhead in/out ink is applied live in AnimationPlayheadSceneSync (one place).
 */
export function shouldSkipNodeInSvgPaint(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef,
  omitNonExportable: boolean
): boolean {
  if (omitNonExportable) return !isExportableSceneNode(node);
  return isNodeStructurallyHiddenInDocument(document, node);
}

/**
 * Overlay / shape-host mount hide: structural (+ session) only.
 * Playhead trim must not go through forceHidden — hosts often do not
 * re-render on scrub; AnimationPlayheadSceneSync owns in/out ink.
 */
export function isNodeOverlayHidden(
  document: SceneDocument | null | undefined,
  node: SceneNodeRef,
  sessionHidden = false
): boolean {
  return sessionHidden || isNodeStructurallyHiddenInDocument(document, node);
}

/**
 * Nodes that belong in export / cover / thumbnail output.
 * Skip editor-only chrome: image/video-generator plates and in-progress process shimmer.
 */
export function isExportableSceneNode(node: SceneNodeRef): boolean {
  if (!node || isNodeHidden(node)) return false;
  if (isGeneratorNode(node)) return false;
  if (String(node?.attrs?.processStatus || '') === 'running') return false;
  return true;
}

export function isImageProcessRunning(node: SceneNodeRef): boolean {
  return Boolean(node) && String(node?.attrs?.processStatus || '') === 'running';
}

/**
 * Spawned upload / import / AI-tool clone — used for history scrub on delete
 * (Ctrl+Z must not resurrect an unfinished placeholder). Never used to block delete.
 */
export function isEphemeralUploadNode(node: SceneNodeRef): boolean {
  if (!isImageProcessRunning(node)) return false;
  if (isGeneratorNode(node)) return false;
  const kind = String(node?.attrs?.processKind || '').trim();
  if (kind === 'generate' || kind === 'quickEdit') return false;
  return true;
}

/**
 * True when any selected node is still showing process SoftGlow.
 * Blocks copy / duplicate / reorder / hide / lock — not delete.
 */
export function selectionHasProcessing(
  document: SceneDocument | null | undefined,
  nodeIds: string[],
  frameIds: string[] = [],
  opts?: { expandFrameChildren?: boolean }
): boolean {
  if (!document) return false;
  let allNodeIds = nodeIds.map((id) => String(id || '').trim()).filter(Boolean);
  if (opts?.expandFrameChildren !== false && frameIds.length) {
    const bound = nodeIdsBoundToFrames(document, frameIds);
    allNodeIds = [...new Set([...allNodeIds, ...bound])];
  }
  for (const id of allNodeIds) {
    if (isImageProcessRunning(document.deltaSetLike?.[id])) return true;
  }
  return false;
}

/**
 * Nodes that may be pinned into Chat (右键 / 快捷键 / composer).
 * Generator plates and process-shimmer nodes stay out.
 * `imagesOnly` — image-generator / quick-edit pick: reject video nodes.
 */
export function isNodeLocked(node: SceneNodeRef): boolean {
  return Boolean(node) && attrFlagTrue(node!.attrs?.locked);
}

/** Finished Lottie plate (not a generator composer). */
export function isLottieNode(node: SceneNodeRef): boolean {
  return Boolean(node) && node!.key === 'lottie' && !isLottieGeneratorNode(node);
}

/**
 * Invisible playback/timeline host inside a 动画工作台 artboard.
 * Not a second user-facing plate — selection should promote to the parent frame.
 * Requires an explicit host flag (do not treat every bound Lottie as host — that
 * hid imported plates and left a blue placeholder with no editable layers).
 */
export function isAnimationFrameHostNode(
  node: SceneNodeRef,
  _document?: SceneDocument | null
): boolean {
  if (!isLottieNode(node)) return false;
  return attrFlagTrue(node!.attrs?.animationFrameHost);
}

/** Nested LOT plate inside a 动画工作台 — preview uses lottie ink, not editor fill. */
export function isWorkbenchNestedLottieNode(
  node: SceneNodeRef,
  document?: SceneDocument | null
): boolean {
  if (!isLottieNode(node)) return false;
  if (isAnimationFrameHostNode(node, document)) return false;
  return Boolean(String(node!.attrs?.frameId || '').trim());
}

/** True for icon-library assets that still use an SVG source. */
export function isIconImageNode(node: SceneNodeRef): boolean {
  if (!node || node.key !== 'image') return false;
  const kind = String(node.attrs?.assetKind || '');
  const src = String(node.attrs?.src || '');
  // Explicit photo (incl. after replace) → never annotate-as-icon.
  if (kind === 'image') return false;
  if (kind === 'icon') return looksLikeSvgSrc(src);
  return looksLikeSvgSrc(src);
}

/**
 * Per-side stroke (T/R/B/L) is only rendered for rect-like closed paths
 * (rect-like create).
 */
export function supportsSideStroke(node: SceneNodeRef) {
  if (!node) return false;
  if (node.key === 'rect') return true;
  if (node.key === 'shape') {
    const t = String(node.attrs?.shapeType || 'rect');
    return t === 'rect' || t === 'roundRect' || t === '';
  }
  return false;
}

/**
 * Closed path / boolean result — fillets sharp verts via `radiusVertices` (path fillet).
 */
function isClosedPathNode(node: SceneNodeRef): boolean {
  if (!node?.attrs) return false;
  const closed = node.attrs.closed;
  if (closed === false || closed === 'false' || closed === 0 || closed === '0') return false;
  if (closed === true || closed === 'true' || closed === 1 || closed === '1') return true;
  const d = String(node.attrs.path || '').trim();
  return /z\s*$/i.test(d);
}

function isMultiGlyphOutlinePath(node: SceneNodeRef): boolean {
  const d = String(node?.attrs?.path || '').trim();
  if (!d) return false;
  const rings = d.split(/(?=[Mm])/).filter((s) => s.trim()).length;
  return rings >= 4;
}

/** Set by `outlineNodePatch` / boolean result — densified path, no R chrome. */
export function isOutlinedPath(node: SceneNodeRef): boolean {
  const v = node?.attrs?.outlined;
  return v === true || v === 'true' || v === 1 || v === '1';
}

function pathAllowsCornerRadius(node: SceneNodeRef): boolean {
  if (isOutlinedPath(node)) return false;
  return isClosedPathNode(node) && !isMultiGlyphOutlinePath(node);
}

/** Nodes that expose corner-radius toolbar + on-canvas handles. */
export function supportsCornerRadius(node: SceneNodeRef) {
  if (!node) return false;
  // Circles / ellipses have no corners — AABB R-dots sit in the square's empty
  // corners (outside the disk). Use path/geo edit instead.
  if (node.key === 'ellipse') return false;
  if (node.key === 'rect' || node.key === 'image') return true;
  // Closed path (boolean / 轮廓化) with `outlined`: hide R dots + toolbar.
  // Open pen / pencil / freehand stay out — no meaningful box corners.
  // Multi-glyph text outlines: skipped via ring count.
  if (node.key === 'path') return pathAllowsCornerRadius(node);
  if (node.key === 'shape') {
    const t = String(node.attrs?.shapeType || 'rect');
    if (t === 'circle' || t === 'ellipse') return false;
    if (t === 'rect' || t === 'roundRect' || t === 'triangle' || t === 'polygon' || t === 'star') {
      return true;
    }
    if (t === 'pen' || t === 'pencil' || t === 'line' || t === 'arrow') return false;
    if (t === 'path') return pathAllowsCornerRadius(node);
  }
  return false;
}

/** Regular polygon / star: adjustable side (or point) count. */
export function supportsShapeSides(node: SceneNodeRef) {
  if (!node || node.key !== 'shape') return false;
  const t = String(node.attrs?.shapeType || '');
  return t === 'polygon' || t === 'star';
}

/**
 * Whether preset aspect ratios (1:1 / 16:9 …) are meaningful.
 * Freehand paths, lines, and arrows only have a loose bounding box — skip presets.
 */
export function supportsAspectPresets(node: SceneNodeRef) {
  if (!node) return false;
  if (
    node.key === 'image' ||
    node.key === 'video' ||
    node.key === 'lottie' ||
    node.key === 'audio' ||
    node.key === 'frame' ||
    node.key === 'svg'
  )
    return true;
  if (node.key === 'rect' || node.key === 'ellipse') return true;
  if (node.key !== 'shape' && node.key !== 'path') return false;
  const t = String(node.attrs?.shapeType || (node.key === 'path' ? 'path' : 'rect'));
  // Open strokes have no box aspect; closed path (e.g. boolean result) does.
  if (['line', 'arrow', 'pen', 'pencil'].includes(t)) return false;
  if (t === 'path') return String(node.attrs?.closed) !== 'false';
  return true;
}

/**
 * Whether the node can have a fill / background color.
 * Open stroke paths (line, arrow, pencil, unclosed pen/path) are stroke-only.
 */
export function supportsFill(node: SceneNodeRef) {
  if (!node) return false;
  if (
    node.key === 'rect' ||
    node.key === 'ellipse' ||
    node.key === 'image' ||
    node.key === 'video' ||
    node.key === 'lottie' ||
    node.key === 'audio' ||
    node.key === 'svg'
  )
    return true;
  if (node.key === 'path') {
    const d = String(node.attrs?.path || '');
    if (node.attrs?.closed === false || node.attrs?.closed === 'false') return false;
    return (
      node.attrs?.closed === true ||
      node.attrs?.closed === 'true' ||
      /\sZ\s*$/i.test(d.trim())
    );
  }
  if (node.key !== 'shape') return false;
  const t = String(node.attrs?.shapeType || 'rect');
  if (t === 'line' || t === 'arrow' || t === 'pencil') return false;
  if (t === 'pen' || t === 'path') return isClosedPathNode(node);
  return true;
}

/**
 * Shape stroke panel (描边). Images / text / frames use other chrome — not this control.
 */
export function supportsStroke(node: SceneNodeRef) {
  if (!node) return false;
  if (
    node.key === 'image' ||
    node.key === 'video' ||
    node.key === 'lottie' ||
    node.key === 'audio' ||
    node.key === 'text' ||
    node.key === 'frame' ||
    node.key === 'svg'
  )
    return false;
  if (node.key === 'rect' || node.key === 'ellipse' || node.key === 'path') return true;
  return node.key === 'shape';
}

/**
 * Closed shapes eligible for union / subtract / intersect / exclude.
 * Excludes open strokes and non-shape nodes (image, text, …).
 */
export function supportsBooleanOp(node: SceneNodeRef) {
  if (!node) return false;
  const key = String(node.key || '');
  if (key === 'path') return isClosedPathNode(node);
  if (key !== 'shape') return false;
  const t = String(node.attrs?.shapeType || 'rect');
  if (t === 'line' || t === 'arrow' || t === 'pencil') return false;
  if (t === 'pen' || t === 'path') return isClosedPathNode(node);
  return true;
}
