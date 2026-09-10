/**
 * Apply playhead pose to 动画工作台 scene children (DOM preview).
 * Shared by AnimationPlayheadSceneSync (scrub + resting ink).
 *
 * Geometry preview is only for an active scrub/play session.
 * Resting canvas (dock closed): ink in/out only — restore document x/y/w/h
 * so other hosts / duplicate ops cannot drag sibling node boxes around.
 */
import { getSharedNodeEls, notifyShapeHostGeometry } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  isFrameLocalCoordSpace,
  nodeLeftTop,
} from '@/components/rcb/scene/layout/nodeLayout';
import { clearNodeTransformPreviews, setNodeTransformHidden, setNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { parseLottieAnimationData } from '@/components/rcb/scene/document/nodeFactories';
import { lottieLocalToScenePoint } from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import {
  isTransformPropAnimated,
  sampleLayerTransformAtFrame,
} from '@/components/editor/nodes/AnimationNode/animationTimelineMutate';
import { lottieLayerBaseSize } from '@/components/editor/nodes/AnimationNode/animationLottieMaterialize';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { isPlayheadScenePoseBlocked } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';

const LINK_KEY = 'ln';

function plateFitScale(
  plate: { width: number; height: number },
  animW: number,
  animH: number
): number {
  return Math.min(
    plate.width / Math.max(1, animW),
    plate.height / Math.max(1, animH)
  );
}

function applyLayerInkVisibility(
  el: SVGElement | HTMLElement | null | undefined,
  inRange: boolean,
  opacityPct: number
) {
  if (!el) return;
  if (inRange) {
    const opN = Math.max(0, Math.min(1, opacityPct / 100));
    if (opN < 0.999) {
      el.style.opacity = String(opN);
      el.setAttribute('opacity', String(opN));
    } else {
      el.style.opacity = '';
      el.removeAttribute('opacity');
    }
    el.style.visibility = '';
    el.style.pointerEvents = '';
  } else {
    el.style.opacity = '0';
    el.setAttribute('opacity', '0');
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
  }
}

function documentOpacityPct(node: { attrs?: Record<string, unknown> | null }): number {
  const prevOp = Number(node.attrs?.opacity);
  if (!Number.isFinite(prevOp)) return 100;
  return prevOp <= 1 ? prevOp * 100 : prevOp;
}

function restoreDocumentGeometry(
  nodeEls: Map<string, SVGElement>,
  sceneNodeId: string,
  node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown> | null;
  },
  document?: SceneDocument | null
) {
  const abs = document
    ? nodeLeftTop(document, node as SceneNodeInput)
    : { left: Number(node.x) || 0, top: Number(node.y) || 0 };
  const left = abs.left;
  const top = abs.top;
  const width = Math.max(1, Number(node.width) || 1);
  const height = Math.max(1, Number(node.height) || 1);
  // Drop TransformPreview first so ink snaps to document without a publish flash.
  clearNodeTransformPreviews([sceneNodeId]);
  const el = nodeEls.get(sceneNodeId) as any;
  if (el) {
    el.__sceneAngle = Number(node.attrs?.angle) || 0;
    el.__sceneSkewX = Number(node.attrs?.skewX) || 0;
    el.__sceneSkewY = Number(node.attrs?.skewY) || 0;
    el.__sceneSkewAxis = Number(node.attrs?.skewAxis) || 0;
    // Drop scrub resize bases so the next paint matches document size.
    delete el.__sceneDidResize;
    delete el.__sceneDragBaseW;
    delete el.__sceneDragBaseH;
  }
  notifyShapeHostGeometry(sceneNodeId);
  return { left, top, width, height };
}

function listLinkedSceneNodeIds(
  anim: Record<string, unknown>,
  document: SceneDocument,
  frameId: string | null
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (layers: unknown) => {
    if (!Array.isArray(layers)) return;
    for (const raw of layers) {
      if (!raw || typeof raw !== 'object') continue;
      const sceneNodeId = String((raw as Record<string, unknown>)[LINK_KEY] || '').trim();
      if (!sceneNodeId || seen.has(sceneNodeId)) continue;
      const node = document.deltaSetLike?.[sceneNodeId];
      if (!node) continue;
      const nodeFrame = String(node.attrs?.frameId || '').trim();
      if (frameId && nodeFrame && nodeFrame !== frameId) continue;
      seen.add(sceneNodeId);
      out.push(sceneNodeId);
    }
  };
  walk(anim.layers);
  const assets = Array.isArray(anim.assets) ? (anim.assets as Record<string, unknown>[]) : [];
  for (const asset of assets) {
    walk(asset?.layers);
  }
  return out;
}

function layerTransformAnimated(
  anim: Record<string, unknown>,
  sceneKind: 'main' | 'precomp',
  assetId: string | undefined,
  layerInd: number,
  propKey: string
): boolean {
  return isTransformPropAnimated({
    animationData: anim,
    sceneKind,
    assetId,
    layerInd,
    propKey,
  });
}

export type PrecompSessionShapePose = {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  skew: number;
  skewAxis: number;
  roundness: number;
};

/** Resolve LOT-tab session shape pose at the playhead (DOM + document). */
export function resolvePrecompSessionShapePose(opts: {
  anim: Record<string, unknown>;
  sceneKind: 'main' | 'precomp';
  assetId?: string;
  layerInd: number;
  frameN: number;
  plate: { left: number; top: number; width: number; height: number };
  localAnimW: number;
  localAnimH: number;
  raw: Record<string, unknown>;
  node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown> | null;
  };
  /** When set, base left/top are scene paint coords (frameLocal-aware). */
  document?: SceneDocument | null;
}): PrecompSessionShapePose | null {
  const {
    anim,
    sceneKind,
    assetId,
    layerInd,
    frameN,
    plate,
    localAnimW,
    localAnimH,
    raw,
    node,
    document,
  } = opts;
  const sampled = sampleLayerTransformAtFrame({
    animationData: anim,
    sceneKind,
    assetId,
    layerInd,
    frame: frameN,
  });
  const fit = plateFitScale(plate, localAnimW, localAnimH);
  // Lottie-local base only — never node.width (already plate-fitted scene px).
  const baseFromLayer = lottieLayerBaseSize(raw);

  const baseOrigin = document
    ? nodeLeftTop(document, node as SceneNodeInput)
    : { left: Number(node.x) || 0, top: Number(node.y) || 0 };
  let left = baseOrigin.left;
  let top = baseOrigin.top;
  let width = Math.max(1, Number(node.width) || 1);
  let height = Math.max(1, Number(node.height) || 1);
  let rotation = Number(node.attrs?.angle) || 0;
  let skew = Number(node.attrs?.skewX) || 0;
  let skewAxis = Number(node.attrs?.skewAxis) || 0;
  let opacity = documentOpacityPct(node);
  let roundness = -1;

  if (!sampled) {
    return { left, top, width, height, rotation, opacity, skew, skewAxis, roundness };
  }

  opacity = sampled.opacity;
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 's') && baseFromLayer) {
    const sx = Math.max(0.01, sampled.scaleX / 100);
    const sy = Math.max(0.01, sampled.scaleY / 100);
    width = Math.max(1, baseFromLayer.w * sx * fit);
    height = Math.max(1, baseFromLayer.h * sy * fit);
  }
  // Shape corner radius is in Lottie local units (rc.r), not ks.rd.
  if (baseFromLayer && baseFromLayer.r > 0) {
    roundness = baseFromLayer.r * fit * Math.min(
      Math.max(0.01, sampled.scaleX / 100),
      Math.max(0.01, sampled.scaleY / 100)
    );
  }
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 'p')) {
    const center = lottieLocalToScenePoint(
      sampled.cx,
      sampled.cy,
      plate,
      localAnimW,
      localAnimH
    );
    left = center.x - width / 2;
    top = center.y - height / 2;
  }
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 'r')) {
    rotation = sampled.rotation;
  }
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 'sk')) {
    skew = sampled.skew;
  }
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 'sa')) {
    skewAxis = sampled.skewAxis;
  }
  if (layerTransformAnimated(anim, sceneKind, assetId, layerInd, 'rd')) {
    roundness = sampled.roundness;
  }

  return { left, top, width, height, rotation, opacity, skew, skewAxis, roundness };
}

function poseDiffers(
  node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown> | null;
  },
  pose: PrecompSessionShapePose,
  document?: SceneDocument | null
): boolean {
  const eps = 0.05;
  // Pose plate matches document storage space (frameLocal → {0,0} plate → compare node.x/y).
  // Do NOT use nodeLeftTop (world) here — that always "differs" by frame.x and rewrites x off-plate.
  const stored =
    document && !isFrameLocalCoordSpace(document)
      ? nodeLeftTop(document, node as SceneNodeInput)
      : { left: Number(node.x) || 0, top: Number(node.y) || 0 };
  if (Math.abs(stored.left - pose.left) > eps) return true;
  if (Math.abs(stored.top - pose.top) > eps) return true;
  if (Math.abs((Number(node.width) || 0) - pose.width) > eps) return true;
  if (Math.abs((Number(node.height) || 0) - pose.height) > eps) return true;
  if (Math.abs((Number(node.attrs?.angle) || 0) - pose.rotation) > eps) return true;
  if (Math.abs(documentOpacityPct(node) - pose.opacity) > eps) return true;
  if (Math.abs((Number(node.attrs?.skewX) || 0) - pose.skew) > eps) return true;
  if (Math.abs((Number(node.attrs?.skewAxis) || 0) - pose.skewAxis) > eps) return true;
  if (pose.roundness >= 0) {
    const curR = Number(node.attrs?.rx ?? node.attrs?.cornerRadius ?? node.attrs?.radiusTL);
    if (Number.isFinite(curR) && Math.abs(curR - pose.roundness) > eps) return true;
    if (!Number.isFinite(curR) && pose.roundness > eps) return true;
  }
  return false;
}

/**
 * Bake pose → document x/y. Plate is already in document storage space
 * (frameLocal uses {0,0}), so pose.left/top are the stored coords — no subtract.
 */
function poseToStoredXY(
  _document: SceneDocument,
  _node: {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
    attrs?: Record<string, unknown> | null;
  },
  pose: PrecompSessionShapePose
): { x: number; y: number } {
  return { x: pose.left, y: pose.top };
}

/** Bake playhead pose into document so host repaints cannot reset siblings. */
export function collectPrecompSessionDocumentPatches(opts: {
  document: SceneDocument;
  hostNodeId: string;
  playheadSec: number;
}): Array<{
  nodeId: string;
  patch: {
    x: number;
    y: number;
    width: number;
    height: number;
    attrs: Record<string, unknown>;
  };
}> {
  const host = opts.document?.deltaSetLike?.[opts.hostNodeId];
  if (!host) return [];
  const anim = parseLottieAnimationData(host.attrs?.animationData);
  if (!anim || !Array.isArray(anim.layers)) return [];

  const frameId = resolveAnimationFrameId(opts.document, host);
  const frames = Array.isArray(opts.document.frames) ? opts.document.frames : [];
  const frame = frameId ? frames.find((f) => String(f?.id) === frameId) : null;
  // Match materialize + layerLinkPlate: frameLocal plate is {0,0} so stored x/y stay local.
  // World plate + live-geometry subtract was writing x≈frame.x+local → shapes paint off-plate.
  const frameLocal = isFrameLocalCoordSpace(opts.document);
  const plate = {
    left: frameLocal ? 0 : Number(frame?.x ?? host.x) || 0,
    top: frameLocal ? 0 : Number(frame?.y ?? host.y) || 0,
    width: Math.max(1, Number(frame?.width ?? host.width) || 1),
    height: Math.max(1, Number(frame?.height ?? host.height) || 1),
  };
  const animW = Math.max(1, Number(anim.w) || plate.width);
  const animH = Math.max(1, Number(anim.h) || plate.height);
  const fps = Math.max(1, Number(anim.fr) || Number(frame?.fps) || 30);
  const frameN = secToFrame(Math.max(0, Number(opts.playheadSec) || 0), fps);
  const out: Array<{
    nodeId: string;
    patch: {
      x: number;
      y: number;
      width: number;
      height: number;
      attrs: Record<string, unknown>;
    };
  }> = [];

  const collectFromLayers = (
    layers: Record<string, unknown>[],
    sceneKind: 'main' | 'precomp',
    assetId: string | undefined,
    localAnimW: number,
    localAnimH: number
  ) => {
    for (const raw of layers) {
      const sceneNodeId = String(raw?.[LINK_KEY] || '').trim();
      if (!sceneNodeId) continue;
      const node = opts.document.deltaSetLike?.[sceneNodeId];
      if (!node) continue;
      if (!String(node.attrs?.precompEditSession || '').trim()) continue;
      const nodeFrame = String(node.attrs?.frameId || '').trim();
      if (frameId && nodeFrame && nodeFrame !== frameId) continue;
      const ind = Number(raw.ind);
      if (!Number.isFinite(ind)) continue;

      const pose = resolvePrecompSessionShapePose({
        anim,
        sceneKind,
        assetId,
        layerInd: ind,
        frameN,
        plate,
        localAnimW,
        localAnimH,
        raw,
        node,
        document: opts.document,
      });
      if (!pose || !poseDiffers(node, pose, opts.document)) continue;

      const opacityAttr =
        Number(node.attrs?.opacity) <= 1
          ? Math.max(0, Math.min(1, pose.opacity / 100))
          : pose.opacity;
      const attrs: Record<string, unknown> = {
        angle: Math.round(pose.rotation * 100) / 100,
        opacity: opacityAttr,
        skewX: Math.round(pose.skew * 100) / 100,
        skewAxis: Math.round(pose.skewAxis * 100) / 100,
      };
      if (pose.roundness >= 0) {
        attrs.rx = pose.roundness;
        attrs.ry = pose.roundness;
        attrs.cornerRadius = pose.roundness;
      }
      const stored = poseToStoredXY(opts.document, node, pose);
      out.push({
        nodeId: sceneNodeId,
        patch: {
          x: Math.round(stored.x * 100) / 100,
          y: Math.round(stored.y * 100) / 100,
          width: Math.round(pose.width * 100) / 100,
          height: Math.round(pose.height * 100) / 100,
          attrs,
        },
      });
    }
  };

  collectFromLayers(anim.layers as Record<string, unknown>[], 'main', undefined, animW, animH);
  const assets = Array.isArray(anim.assets) ? (anim.assets as Record<string, unknown>[]) : [];
  for (const asset of assets) {
    if (!asset || !Array.isArray(asset.layers)) continue;
    const assetId = String(asset.id || '').trim();
    if (!assetId) continue;
    collectFromLayers(
      asset.layers as Record<string, unknown>[],
      'precomp',
      assetId,
      Math.max(1, Number(asset.w) || animW),
      Math.max(1, Number(asset.h) || animH)
    );
  }
  return out;
}

/** Scrub / resting: map host animation layers → live scene DOM. */
export function applyAnimationPlayheadScenePose(opts: {
  document: SceneDocument;
  hostNodeId: string;
  playheadSec: number;
  /**
   * true (default while scrubbing): sample Lottie transform onto live DOM.
   * false (resting canvas): restore each linked node from document attrs;
   * only apply in/out ink.
   */
  applyGeometry?: boolean;
}): string {
  // Plate / selection gestures own child TransformPreview (+ Kit ink). Restoring
  // document geometry here would snap linked children back to pre-drag coords.
  if (isPlayheadScenePoseBlocked()) return '';

  const { document, hostNodeId } = opts;
  const applyGeometry = opts.applyGeometry !== false;
  const playheadSec = Math.max(0, Number(opts.playheadSec) || 0);
  const host = document?.deltaSetLike?.[hostNodeId];
  if (!host) return '';

  const anim = parseLottieAnimationData(host.attrs?.animationData);
  if (!anim || !Array.isArray(anim.layers)) return '';

  const frameId = resolveAnimationFrameId(document, host);
  const frames = Array.isArray(document.frames) ? document.frames : [];
  const frame = frameId ? frames.find((f) => String(f?.id) === frameId) : null;
  const livePlate = frameId ? getLiveArtboardFrameGeometry(frameId) : null;
  const plate = {
    left: Number(livePlate?.x ?? frame?.x ?? host.x) || 0,
    top: Number(livePlate?.y ?? frame?.y ?? host.y) || 0,
    width: Math.max(1, Number(livePlate?.width ?? frame?.width ?? host.width) || 1),
    height: Math.max(1, Number(livePlate?.height ?? frame?.height ?? host.height) || 1),
  };
  const animW = Math.max(1, Number(anim.w) || plate.width);
  const animH = Math.max(1, Number(anim.h) || plate.height);
  const fps = Math.max(1, Number(anim.fr) || Number(frame?.fps) || 30);
  const frameN = secToFrame(playheadSec, fps);

  const nodeElsRaw = getSharedNodeEls();
  const nodeEls =
    nodeElsRaw && nodeElsRaw instanceof Map
      ? (nodeElsRaw as Map<string, SVGElement>)
      : new Map<string, SVGElement>();

  const touchedIds: string[] = [];
  const sigParts: string[] = [String(frameN), applyGeometry ? 'g' : 'i'];

  const applyLinkedLayers = (
    layers: Record<string, unknown>[],
    sceneKind: 'main' | 'precomp',
    assetId: string | undefined,
    localAnimW: number,
    localAnimH: number
  ) => {
    for (const raw of layers) {
      const sceneNodeId = String(raw?.[LINK_KEY] || '').trim();
      if (!sceneNodeId) continue;
      const node = document.deltaSetLike?.[sceneNodeId];
      if (!node) continue;
      // Never let another plate's layer links rewrite this node's live DOM.
      const nodeFrame = String(node.attrs?.frameId || '').trim();
      if (frameId && nodeFrame && nodeFrame !== frameId) continue;
      const ind = Number(raw.ind);
      if (!Number.isFinite(ind)) continue;
      touchedIds.push(sceneNodeId);

      const ip = Number(raw.ip);
      const op = Number(raw.op);
      const inRange =
        (!Number.isFinite(ip) || frameN >= ip - 1e-6) &&
        (!Number.isFinite(op) || frameN < op - 1e-6);

      if (!applyGeometry) {
        const box = restoreDocumentGeometry(nodeEls, sceneNodeId, node, document);
        const el = nodeEls.get(sceneNodeId) as any;
        applyLayerInkVisibility(el, inRange, documentOpacityPct(node));
        sigParts.push(
          `${sceneNodeId}:${box.left.toFixed(1)},${box.top.toFixed(1)},${box.width.toFixed(1)},${box.height.toFixed(1)},ink:${inRange ? 1 : 0}`
        );
        continue;
      }

      // LOT-tab session shapes: keep static pose from document; sample only
      // channels that are actually keyed so scrub/play matches the timeline.
      const precompSessionAsset = String(node.attrs?.precompEditSession || '').trim();
      if (precompSessionAsset) {
        const pose = resolvePrecompSessionShapePose({
          anim,
          sceneKind,
          assetId,
          layerInd: ind,
          frameN,
          plate,
          localAnimW,
          localAnimH,
          raw,
          node,
          document,
        });
        if (!pose) {
          restoreDocumentGeometry(nodeEls, sceneNodeId, node, document);
          const el = nodeEls.get(sceneNodeId) as any;
          applyLayerInkVisibility(el, inRange, documentOpacityPct(node));
          continue;
        }

        const { left, top, width: w, height: h, rotation, opacity, skew, skewAxis } =
          pose;
        const el = nodeEls.get(sceneNodeId) as any;
        if (el) {
          el.__sceneAngle = rotation;
          el.__sceneSkewX = skew;
          el.__sceneSkewY = 0;
          el.__sceneSkewAxis = skewAxis;
        }
        setNodeTransformPreviews([
          {
            nodeId: sceneNodeId,
            left,
            top,
            width: w,
            height: h,
            angle: rotation,
            hidden: !inRange,
          },
        ]);
        setNodeTransformHidden([{ nodeId: sceneNodeId, hidden: !inRange }]);

        notifyShapeHostGeometry(sceneNodeId);
        applyLayerInkVisibility(el, inRange, opacity);
        sigParts.push(
          `${sceneNodeId}:${left.toFixed(1)},${top.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)},session:${inRange ? 1 : 0}`
        );
        continue;
      }

      const sampled = sampleLayerTransformAtFrame({
        animationData: anim,
        sceneKind,
        assetId,
        layerInd: ind,
        frame: frameN,
      });
      if (!sampled) {
        restoreDocumentGeometry(nodeEls, sceneNodeId, node, document);
        const el = nodeEls.get(sceneNodeId) as any;
        applyLayerInkVisibility(el, inRange, documentOpacityPct(node));
        continue;
      }

      const fit = plateFitScale(plate, localAnimW, localAnimH);
      const baseW = Math.max(1, Number(raw.w) || Number(node.width) || 1);
      const baseH = Math.max(1, Number(raw.h) || Number(node.height) || 1);
      const sx = Math.max(0.01, sampled.scaleX / 100);
      const sy = Math.max(0.01, sampled.scaleY / 100);
      const w = Math.max(1, baseW * sx * fit);
      const h = Math.max(1, baseH * sy * fit);

      const center = lottieLocalToScenePoint(
        sampled.cx,
        sampled.cy,
        plate,
        localAnimW,
        localAnimH
      );
      const left = center.x - w / 2;
      const top = center.y - h / 2;

      const el = nodeEls.get(sceneNodeId) as any;
      if (el) {
        el.__sceneAngle = sampled.rotation;
        el.__sceneSkewX = sampled.skew;
        el.__sceneSkewY = 0;
        el.__sceneSkewAxis = sampled.skewAxis;
      }
      setNodeTransformPreviews([
        {
          nodeId: sceneNodeId,
          left,
          top,
          width: w,
          height: h,
          angle: sampled.rotation,
          hidden: !inRange,
        },
      ]);
      setNodeTransformHidden([{ nodeId: sceneNodeId, hidden: !inRange }]);

      notifyShapeHostGeometry(sceneNodeId);
      applyLayerInkVisibility(el, inRange, sampled.opacity);

      sigParts.push(
        `${sceneNodeId}:${left.toFixed(1)},${top.toFixed(1)},${w.toFixed(1)},${h.toFixed(1)},${sampled.rotation.toFixed(1)},${sampled.skew.toFixed(1)},${sampled.roundness.toFixed(1)},${inRange ? 1 : 0}`
      );
    }
  };

  applyLinkedLayers(anim.layers as Record<string, unknown>[], 'main', undefined, animW, animH);

  // LOT-tab session shapes are linked inside precomp assets.
  const assets = Array.isArray(anim.assets) ? (anim.assets as Record<string, unknown>[]) : [];
  for (const asset of assets) {
    if (!asset || !Array.isArray(asset.layers)) continue;
    const assetId = String(asset.id || '').trim();
    if (!assetId) continue;
    applyLinkedLayers(
      asset.layers as Record<string, unknown>[],
      'precomp',
      assetId,
      Math.max(1, Number(asset.w) || animW),
      Math.max(1, Number(asset.h) || animH)
    );
  }

  // Resting path: restore already cleared per-node previews — wipe any leftovers
  // so Kit bake is not stuck gated after dock close.
  if (!applyGeometry) {
    const linked = listLinkedSceneNodeIds(anim, document, frameId);
    if (linked.length) clearNodeTransformPreviews(linked);
  }
  return sigParts.join('|');
}
