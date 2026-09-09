/**
 * Explode Bodymovin root shape layers into editable scene nodes on a 动画工作台.
 * Stamps `ln` so sync / playhead keep keyframes linked to those nodes.
 */
import { nanoid } from 'nanoid';
import {
  parseLottieAnimationData,
  serializeLottieAnimationData,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  addNodeToDocument,
  removeNodesFromDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';
import { lottieLocalToScenePoint } from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import { sampleLayerTransformAtFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineMutate';
import {
  isFrameLocalCoordSpace,
  nodeLeftTop,
} from '@/components/rcb/scene/layout/nodeLayout';
const LINK_KEY = 'ln';

function asObj(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readStaticVec(prop: unknown): number[] | null {
  const p = asObj(prop);
  if (!p) return null;
  const animated = p.a === 1 || p.a === true || p.a === '1';
  if (animated) {
    const k = p.k;
    if (!Array.isArray(k) || !k.length) return null;
    const first = asObj(k[0]);
    if (first && Array.isArray(first.s)) return first.s.map((x) => num(x));
    return null;
  }
  if (Array.isArray(p.k)) return p.k.map((x) => num(x));
  return null;
}

function readStaticNum(prop: unknown, fallback = 0): number {
  const p = asObj(prop);
  if (!p) return fallback;
  const animated = p.a === 1 || p.a === true || p.a === '1';
  if (animated) {
    const k = p.k;
    if (!Array.isArray(k) || !k.length) return fallback;
    const first = asObj(k[0]);
    if (first) {
      if (Array.isArray(first.s)) return num(first.s[0], fallback);
      return num(first.s, fallback);
    }
    return fallback;
  }
  if (Array.isArray(p.k)) return num(p.k[0], fallback);
  return num(p.k, fallback);
}

function rgbToHex(c: number[]): string {
  const r = Math.round(Math.max(0, Math.min(1, num(c[0]))) * 255);
  const g = Math.round(Math.max(0, Math.min(1, num(c[1]))) * 255);
  const b = Math.round(Math.max(0, Math.min(1, num(c[2]))) * 255);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function readFill(shapes: unknown[]): string {
  for (const raw of shapes) {
    const s = asObj(raw);
    if (!s || s.ty !== 'fl') continue;
    const c = readStaticVec(s.c);
    if (c && c.length >= 3) return rgbToHex(c);
  }
  return '#3B82F6';
}

function readRectSize(shapes: unknown[]): {
  w: number;
  h: number;
  r: number;
  ellipse: boolean;
} | null {
  for (const raw of shapes) {
    const s = asObj(raw);
    if (!s) continue;
    if (s.ty === 'rc' || s.ty === 'el') {
      const size = readStaticVec(s.s);
      if (!size || size.length < 2) continue;
      const w = Math.max(1, Math.abs(size[0]));
      const h = Math.max(1, Math.abs(size[1]));
      return {
        w,
        h,
        r: s.ty === 'rc' ? Math.max(0, readStaticNum(s.r, 0)) : Math.max(w, h) / 2,
        ellipse: s.ty === 'el',
      };
    }
    if (Array.isArray(s.it)) {
      const nested = readRectSize(s.it as unknown[]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Lottie-local base size for a ty:4 layer (layer.w/h or rect/ellipse `s`).
 * Do NOT fall back to scene node.width — that already includes plate fit and
 * would double-scale LOT-tab bake / autoKey.
 */
export function lottieLayerBaseSize(layer: Record<string, unknown> | null | undefined): {
  w: number;
  h: number;
  r: number;
} | null {
  if (!layer) return null;
  const lw = num(layer.w, 0);
  const lh = num(layer.h, 0);
  const shapes = Array.isArray(layer.shapes) ? (layer.shapes as unknown[]) : [];
  const fromShapes = readRectSize(shapes);
  if (lw > 0 && lh > 0) {
    return { w: lw, h: lh, r: fromShapes?.r ?? 0 };
  }
  if (fromShapes) return { w: fromShapes.w, h: fromShapes.h, r: fromShapes.r };
  return null;
}

/** Root ty:4 layers that materializeRootShapeLayers can explode. */
export function countMaterializableRootShapeLayers(animationData: unknown): number {
  const root = parseLottieAnimationData(animationData);
  if (!root || !Array.isArray(root.layers)) return 0;
  let n = 0;
  for (const raw of root.layers as unknown[]) {
    const layer = asObj(raw);
    if (!layer) continue;
    if (num(layer.ty, -1) !== 4) continue;
    const shapes = Array.isArray(layer.shapes) ? (layer.shapes as unknown[]) : [];
    if (readRectSize(shapes)) n += 1;
  }
  return n;
}

/**
 * True when LOT tab may hide lottie-web ink (session shapes fully replace it).
 * Partial explode + hide = blank tab (paths / images stay only in the JSON).
 */
export function sessionCoversLotInk(
  animationData: unknown,
  sessionNodeCount: number
): boolean {
  if (sessionNodeCount <= 0) return false;
  const root = parseLottieAnimationData(animationData);
  if (!root || !Array.isArray(root.layers)) return false;
  let materializable = 0;
  for (const raw of root.layers as unknown[]) {
    const layer = asObj(raw);
    if (!layer) continue;
    const ty = num(layer.ty, -1);
    if (ty === 4) {
      const shapes = Array.isArray(layer.shapes) ? (layer.shapes as unknown[]) : [];
      if (readRectSize(shapes)) materializable += 1;
      else return false; // path / complex shape — keep ink
    } else if (ty === 0 || ty === 2 || ty === 1) {
      // precomp / image / text — keep ink
      return false;
    }
  }
  return materializable > 0 && sessionNodeCount >= materializable;
}

export type MaterializeLottieResult = {
  document: SceneDocument;
  animationJson: string;
  nodeIds: string[];
};

/**
 * Turn root ty:4 rect/ellipse layers into scene shapes bound to `frameId`.
 * Leaves complex / precomp layers unlinked (still host ink until edited).
 */
export function materializeRootShapeLayers(opts: {
  document: SceneDocument;
  frameId: string;
  animationData: unknown;
  plate: { x: number; y: number; width: number; height: number };
  /** Sample animated pose at this frame (defaults to layer ip). */
  sampleFrame?: number;
}): MaterializeLottieResult | null {
  const root = parseLottieAnimationData(opts.animationData);
  if (!root || !Array.isArray(root.layers)) return null;
  const frameId = String(opts.frameId || '').trim();
  if (!frameId) return null;

  const animW = Math.max(1, num(root.w, opts.plate.width));
  const animH = Math.max(1, num(root.h, opts.plate.height));
  // frameLocal children store plate-local x/y — map Lottie with a 0,0 plate.
  const plate = isFrameLocalCoordSpace(opts.document)
    ? {
        left: 0,
        top: 0,
        width: Math.max(1, Number(opts.plate.width) || 1),
        height: Math.max(1, Number(opts.plate.height) || 1),
      }
    : {
        left: Number(opts.plate.x) || 0,
        top: Number(opts.plate.y) || 0,
        width: Math.max(1, Number(opts.plate.width) || 1),
        height: Math.max(1, Number(opts.plate.height) || 1),
      };

  const layers = (root.layers as unknown[]).map((row) =>
    row && typeof row === 'object' ? { ...(row as object) } : row
  ) as Record<string, unknown>[];

  let doc = opts.document;
  const nodeIds: string[] = [];
  const existing = Object.values(doc.deltaSetLike || {}).filter(
    (n) => String(n?.attrs?.frameId || '').trim() === frameId
  );
  let frameOrder =
    existing
      .map((n) => Number(n?.attrs?.frameOrder))
      .filter(Number.isFinite)
      .reduce((m, n) => Math.max(m, n), 0) + 1;

  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue;
    const linkedId = String(layer[LINK_KEY] || '').trim();
    // Skip only live document links; stale ln from a prior session must not block rematerialize.
    if (linkedId && opts.document.deltaSetLike?.[linkedId]) continue;
    if (num(layer.ty, -1) !== 4) continue;
    const shapes = Array.isArray(layer.shapes) ? (layer.shapes as unknown[]) : [];
    const size = readRectSize(shapes);
    if (!size) continue;

    const ks = asObj(layer.ks);
    const p = readStaticVec(ks?.p) || [size.w / 2, size.h / 2, 0];
    const ip = Math.max(0, Math.round(num(layer.ip, 0)));
    const ind = Math.max(1, Math.round(num(layer.ind, nodeIds.length + 1)));
    const sampleAt = Number.isFinite(Number(opts.sampleFrame))
      ? Math.max(0, Math.round(Number(opts.sampleFrame)))
      : ip;
    const sampled = sampleLayerTransformAtFrame({
      animationData: root,
      sceneKind: 'main',
      layerInd: ind,
      frame: sampleAt,
    });
    const fit = Math.min(plate.width / animW, plate.height / animH);
    const sx = Math.max(0.01, (sampled?.scaleX ?? 100) / 100);
    const sy = Math.max(0.01, (sampled?.scaleY ?? 100) / 100);
    const cx = sampled?.cx ?? p[0];
    const cy = sampled?.cy ?? p[1];
    const center = lottieLocalToScenePoint(cx, cy, plate, animW, animH);
    const w = Math.max(1, size.w * fit * sx);
    const h = Math.max(1, size.h * fit * sy);
    const x = center.x - w / 2;
    const y = center.y - h / 2;
    const fill = readFill(shapes);
    const opacityPct = sampled?.opacity ?? readStaticNum(ks?.o, 100);
    const angle = sampled?.rotation ?? readStaticNum(ks?.r, 0);
    const name = String(layer.nm || 'Layer').trim() || 'Layer';
    const op = Math.max(ip + 1, Math.round(num(layer.op, ip + 1)));

    const id = nanoid(10);
    const r = Math.max(0, size.r * fit * Math.min(sx, sy));
    const node: SceneNode = {
      id,
      key: 'shape',
      x,
      y,
      z: 0,
      width: w,
      height: h,
      attrs: {
        name,
        shapeType: size.ellipse ? 'ellipse' : 'rect',
        'fill-color': fill,
        'fill-type': 'solid',
        'fill-enabled': 'true',
        'fill-visible': 'true',
        'border-color': 'transparent',
        'border-width': 0,
        'stroke-enabled': 'false',
        'stroke-visible': 'false',
        opacity: Math.max(0, Math.min(1, opacityPct / 100)),
        angle,
        radiusTL: r,
        radiusTR: r,
        radiusBR: r,
        radiusBL: r,
        radiusLinked: 'true',
        frameId,
        frameOrder: frameOrder++,
        lottieLayerInd: ind,
        lottieInFrame: ip,
        lottieOutFrame: op,
      },
      children: [],
    };
    doc = addNodeToDocument(doc, id, node);
    nodeIds.push(id);

    layer[LINK_KEY] = id;
    layer.w = Math.round(size.w);
    layer.h = Math.round(size.h);
    layer.nm = name;
  }

  if (!nodeIds.length) return null;

  const nextRoot = { ...root, layers };
  const animationJson = serializeLottieAnimationData(nextRoot);
  if (!animationJson) return null;
  return { document: doc, animationJson, nodeIds };
}

/**
 * Nested lot_* plate → real shape nodes on the workbench (keeps keyframes).
 * Returns null when the plate has no simple rect/ellipse layers to explode.
 */
export function explodeLinkedLottiePlate(opts: {
  document: SceneDocument;
  lotNodeId: string;
  hostNodeId: string;
  frameId: string;
}): MaterializeLottieResult | null {
  const lotId = String(opts.lotNodeId || '').trim();
  const hostId = String(opts.hostNodeId || '').trim();
  const frameId = String(opts.frameId || '').trim();
  if (!lotId || !hostId || !frameId) return null;

  const lot = opts.document.deltaSetLike?.[lotId];
  const host = opts.document.deltaSetLike?.[hostId];
  if (!lot || lot.key !== 'lottie' || !host) return null;

  const { left, top } = nodeLeftTop(opts.document, lot);
  const matured = materializeRootShapeLayers({
    document: opts.document,
    frameId,
    animationData: lot.attrs?.animationData,
    plate: {
      x: left,
      y: top,
      width: Math.max(1, Number(lot.width) || 1),
      height: Math.max(1, Number(lot.height) || 1),
    },
  });
  if (!matured) return null;

  let doc = removeNodesFromDocument(matured.document, [lotId]);
  const hostNode = doc.deltaSetLike?.[hostId];
  if (!hostNode) return null;

  const hostParsed = parseLottieAnimationData(hostNode.attrs?.animationData);
  const maturedParsed = parseLottieAnimationData(matured.animationJson);
  if (!hostParsed || !maturedParsed) return null;

  const assetId = `lot_${lotId}`;
  const prevLayers = Array.isArray(hostParsed.layers)
    ? (hostParsed.layers as Record<string, unknown>[])
    : [];
  const kept = prevLayers.filter((layer) => {
    if (!layer || typeof layer !== 'object') return false;
    const ln = String(layer[LINK_KEY] || '').trim();
    const ref = String(layer.refId || '').trim();
    return ln !== lotId && ref !== assetId;
  });
  const maturedLayers = Array.isArray(maturedParsed.layers)
    ? (maturedParsed.layers as unknown[])
    : [];
  const prevAssets = Array.isArray(hostParsed.assets)
    ? (hostParsed.assets as unknown[])
    : [];
  const assets = prevAssets.filter((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const id = String((raw as { id?: unknown }).id || '').trim();
    return id !== assetId && !id.startsWith(`${assetId}_`);
  });

  const nextHost = {
    ...hostParsed,
    layers: [...kept, ...maturedLayers],
    assets,
  };
  const animationJson = serializeLottieAnimationData(nextHost);
  if (!animationJson) return null;

  const nextHostNode: SceneNode = {
    ...hostNode,
    attrs: {
      ...(hostNode.attrs || {}),
      animationData: animationJson,
    },
  };
  doc = {
    ...doc,
    deltaSetLike: {
      ...(doc.deltaSetLike || {}),
      [hostId]: nextHostNode,
    },
  };
  return { document: doc, animationJson, nodeIds: matured.nodeIds };
}
