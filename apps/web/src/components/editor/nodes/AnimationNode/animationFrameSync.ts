/**
 * Sync 动画工作台 scene children (shapes / images) into the host's
 * Bodymovin `animationData` so the timeline can list layers + keyframes.
 */
import {
  createBlankLottieAnimation,
  sceneBoxToLottieLocal,
  type LottieLocalBox,
} from '@/components/editor/nodes/AnimationNode/animationComposeLayers';
import { isAnimationFrameHostNode } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  parseLottieAnimationData,
  serializeLottieAnimationData,
} from '@/components/rcb/scene/document/nodeFactories';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';
import { isFrameLocalCoordSpace } from '@/components/rcb/scene/layout/nodeLayout';
const LINK_KEY = 'ln'; // custom: scene node id on a synced layer

/** Plate box for scene↔Lottie mapping (0,0 under frameLocal — child x/y are already local). */
function artboardSyncPlate(
  document: SceneDocument,
  frame: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }
): { left: number; top: number; width: number; height: number } {
  const width = Math.max(1, Number(frame.width) || 1);
  const height = Math.max(1, Number(frame.height) || 1);
  if (isFrameLocalCoordSpace(document)) {
    return { left: 0, top: 0, width, height };
  }
  return {
    left: Number(frame.x) || 0,
    top: Number(frame.y) || 0,
    width,
    height,
  };
}

/**
 * True when host animation still has layers not linked to scene children.
 * Those must paint via lottie-web — frame-host ink is otherwise hidden and
 * an imported JSON workbench would look empty.
 */
export function animationHostHasUnlinkedInk(
  animationData: unknown
): boolean {
  const anim = parseLottieAnimationData(animationData);
  const layers = Array.isArray(anim?.layers) ? (anim!.layers as unknown[]) : [];
  return layers.some((layer) => {
    if (!layer || typeof layer !== 'object') return false;
    return !String((layer as { [LINK_KEY]?: unknown })[LINK_KEY] || '').trim();
  });
}

/** Empty workbench / blank seed — nothing meaningful to play or scrub. */
export function animationHasPlayableContent(animationData: unknown): boolean {
  const anim = parseLottieAnimationData(animationData);
  if (!anim) return false;
  const layers = Array.isArray(anim.layers) ? anim.layers : [];
  return layers.length > 0;
}

/** Prefer clipboard helper; fall back to scanning deltaSetLike (partial docs / tests). */
function listNodesBoundToFrame(document: SceneDocument, frameId: string): string[] {
  const wanted = String(frameId || '').trim();
  if (!wanted) return [];
  const ids: string[] = [];
  const map = document.deltaSetLike || {};
  for (const id of Object.keys(map)) {
    if (id === 'ROOT') continue;
    const node = map[id];
    if (!node || typeof node !== 'object') continue;
    if (String(node.attrs?.frameId || '').trim() !== wanted) continue;
    ids.push(id);
  }
  return ids;
}

function nextLayerIndex(layers: unknown[]): number {
  let max = 0;
  for (const raw of layers) {
    if (!raw || typeof raw !== 'object') continue;
    const ind = Number((raw as { ind?: unknown }).ind);
    if (Number.isFinite(ind) && ind > max) max = ind;
  }
  return max + 1;
}

function isAnimatedProp(prop: unknown): boolean {
  if (!prop || typeof prop !== 'object') return false;
  const p = prop as { a?: unknown; k?: unknown };
  if (Number(p.a) === 1) return true;
  const k = p.k;
  return Array.isArray(k) && k.length > 0 && typeof k[0] === 'object' && k[0] != null && 't' in (k[0] as object);
}

function layerHasKeyframes(ks: unknown): boolean {
  if (!ks || typeof ks !== 'object') return false;
  const o = ks as Record<string, unknown>;
  return ['p', 's', 'r', 'o', 'a', 'sk', 'sa'].some((k) => isAnimatedProp(o[k]));
}

function parseCssColorToRgb01(raw: unknown): [number, number, number] {
  const s = String(raw || '').trim();
  if (!s || s === 'transparent' || s.startsWith('var(')) return [0.23, 0.51, 0.96];
  const hex = s.replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const r = parseInt(hex[0]! + hex[0]!, 16) / 255;
    const g = parseInt(hex[1]! + hex[1]!, 16) / 255;
    const b = parseInt(hex[2]! + hex[2]!, 16) / 255;
    return [r, g, b];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    return [r, g, b];
  }
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) {
    return [
      Math.max(0, Math.min(1, Number(m[1]) / 255)),
      Math.max(0, Math.min(1, Number(m[2]) / 255)),
      Math.max(0, Math.min(1, Number(m[3]) / 255)),
    ];
  }
  return [0.23, 0.51, 0.96];
}

function nodeOpacityPercent(node: SceneNode): number {
  const raw = node.attrs?.opacity ?? node.attrs?.['fill-opacity'];
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  if (n <= 1) return Math.round(Math.max(0, Math.min(1, n)) * 100);
  return Math.round(Math.max(0, Math.min(100, n)));
}

function nodeAngleDeg(node: SceneNode): number {
  const n = Number(node.attrs?.angle);
  return Number.isFinite(n) ? n : 0;
}

function solidFill(rgb: [number, number, number]) {
  return {
    ty: 'fl',
    c: { a: 0, k: [...rgb, 1] },
    o: { a: 0, k: 100 },
    r: 1,
    bm: 0,
    nm: 'Fill',
  };
}

function baseTransform(
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  angle: number,
  opacity: number,
  skew = 0,
  skewAxis = 0
) {
  return {
    o: { a: 0, k: opacity },
    r: { a: 0, k: angle },
    p: { a: 0, k: [cx, cy, 0] },
    a: { a: 0, k: [ax, ay, 0] },
    s: { a: 0, k: [100, 100, 100] },
    sk: { a: 0, k: skew },
    sa: { a: 0, k: skewAxis },
  };
}

function applyStaticTransform(
  layer: Record<string, unknown>,
  cx: number,
  cy: number,
  ax: number,
  ay: number,
  angle: number,
  opacity: number,
  skew = 0,
  skewAxis = 0
) {
  const ks = (layer.ks && typeof layer.ks === 'object' ? { ...(layer.ks as object) } : {}) as Record<
    string,
    unknown
  >;
  const setIfStatic = (key: string, value: number | number[]) => {
    const prop = ks[key];
    if (prop && typeof prop === 'object' && Number((prop as { a?: unknown }).a) === 1) {
      return;
    }
    ks[key] = { a: 0, k: value };
  };
  // Always refresh non-animated channels so Sk/Sa/R still apply when e.g. Position is keyed.
  setIfStatic('o', opacity);
  setIfStatic('r', angle);
  setIfStatic('p', [cx, cy, 0]);
  setIfStatic('a', [ax, ay, 0]);
  setIfStatic('s', [100, 100, 100]);
  setIfStatic('sk', skew);
  setIfStatic('sa', skewAxis);
  layer.ks = ks;
}

/** Rive-style 3×3 anchor → local [ax, ay] for image layers (top-left origin). */
export type LottieAnchorPreset =
  | 'tl'
  | 'tm'
  | 'tr'
  | 'ml'
  | 'mm'
  | 'mr'
  | 'bl'
  | 'bm'
  | 'br';

export function parseAnchorPreset(raw: unknown): LottieAnchorPreset {
  const v = String(raw || '').trim().toLowerCase();
  if (
    v === 'tl' ||
    v === 'tm' ||
    v === 'tr' ||
    v === 'ml' ||
    v === 'mm' ||
    v === 'mr' ||
    v === 'bl' ||
    v === 'bm' ||
    v === 'br'
  ) {
    return v;
  }
  return 'mm';
}

export function anchorPresetToFrac(preset: LottieAnchorPreset): { fx: number; fy: number } {
  const col = preset.endsWith('l') ? 0 : preset.endsWith('r') ? 1 : 0.5;
  const row = preset.startsWith('t') ? 0 : preset.startsWith('b') ? 1 : 0.5;
  return { fx: col, fy: row };
}

function nodeSkewDeg(node: SceneNode): number {
  const n = Number(node.attrs?.skewX ?? node.attrs?.skew);
  return Number.isFinite(n) ? n : 0;
}

function nodeSkewAxisDeg(node: SceneNode): number {
  const n = Number(node.attrs?.skewAxis ?? node.attrs?.skewY);
  return Number.isFinite(n) ? n : 0;
}

function nodeCornerRadius(node: SceneNode): number {
  const attrs = node.attrs || {};
  for (const key of [
    'cornerRadius',
    'rx',
    'ry',
    'radiusTL',
    'radiusTR',
    'radiusBR',
    'radiusBL',
  ] as const) {
    const n = Number(attrs[key]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function setLayerPathBox(
  layer: Record<string, unknown>,
  box: LottieLocalBox,
  ellipse: boolean,
  cornerRadius: number
): boolean {
  const shapes = Array.isArray(layer.shapes)
    ? (layer.shapes as Record<string, unknown>[]).map((s) =>
        s && typeof s === 'object' ? { ...s } : s
      )
    : [];
  const idx = shapes.findIndex((s) => s && (s.ty === 'rc' || s.ty === 'el'));
  if (idx < 0) return false;
  const path = { ...(shapes[idx] as Record<string, unknown>) };
  path.s = { a: 0, k: [box.w, box.h] };
  if (!ellipse && path.ty === 'rc') {
    path.r = { a: 0, k: Math.max(0, cornerRadius) };
  }
  shapes[idx] = path;
  layer.shapes = shapes;
  return true;
}

function makeRectLayer(opts: {
  ind: number;
  name: string;
  nodeId: string;
  box: LottieLocalBox;
  rgb: [number, number, number];
  angle: number;
  opacity: number;
  op: number;
  ellipse?: boolean;
  cornerRadius?: number;
  skew?: number;
  skewAxis?: number;
  ax?: number;
  ay?: number;
}): Record<string, unknown> {
  const cx = opts.box.x + opts.box.w / 2;
  const cy = opts.box.y + opts.box.h / 2;
  const ax = opts.ax ?? 0;
  const ay = opts.ay ?? 0;
  return {
    ddd: 0,
    ind: opts.ind,
    ty: 4,
    nm: opts.name,
    [LINK_KEY]: opts.nodeId,
    sr: 1,
    ks: baseTransform(
      cx,
      cy,
      ax,
      ay,
      opts.angle,
      opts.opacity,
      opts.skew || 0,
      opts.skewAxis || 0
    ),
    ao: 0,
    shapes: [
      opts.ellipse
        ? {
            ty: 'el',
            d: 1,
            s: { a: 0, k: [opts.box.w, opts.box.h] },
            p: { a: 0, k: [0, 0] },
            nm: 'Ellipse Path',
          }
        : {
            ty: 'rc',
            d: 1,
            s: { a: 0, k: [opts.box.w, opts.box.h] },
            p: { a: 0, k: [0, 0] },
            r: { a: 0, k: Math.max(0, opts.cornerRadius || 0) },
            nm: 'Rectangle Path',
          },
      solidFill(opts.rgb),
    ],
    ip: 0,
    op: opts.op,
    st: 0,
    bm: 0,
  };
}

function makeImageLayer(opts: {
  ind: number;
  name: string;
  nodeId: string;
  box: LottieLocalBox;
  assetId: string;
  angle: number;
  opacity: number;
  op: number;
  skew?: number;
  skewAxis?: number;
  ax?: number;
  ay?: number;
}): Record<string, unknown> {
  const ax = opts.ax ?? opts.box.w / 2;
  const ay = opts.ay ?? opts.box.h / 2;
  const cx = opts.box.x + ax;
  const cy = opts.box.y + ay;
  return {
    ddd: 0,
    ind: opts.ind,
    ty: 2,
    refId: opts.assetId,
    nm: opts.name,
    [LINK_KEY]: opts.nodeId,
    sr: 1,
    ks: baseTransform(
      cx,
      cy,
      ax,
      ay,
      opts.angle,
      opts.opacity,
      opts.skew || 0,
      opts.skewAxis || 0
    ),
    ao: 0,
    w: Math.max(1, Math.round(opts.box.w)),
    h: Math.max(1, Math.round(opts.box.h)),
    ip: 0,
    op: opts.op,
    st: 0,
    bm: 0,
  };
}

/** Nested Lottie plate → precomp layer so it shows on the workbench timeline. */
function makePrecompLayer(opts: {
  ind: number;
  name: string;
  nodeId: string;
  box: LottieLocalBox;
  assetId: string;
  angle: number;
  opacity: number;
  op: number;
  skew?: number;
  skewAxis?: number;
  ax?: number;
  ay?: number;
}): Record<string, unknown> {
  const ax = opts.ax ?? opts.box.w / 2;
  const ay = opts.ay ?? opts.box.h / 2;
  const cx = opts.box.x + ax;
  const cy = opts.box.y + ay;
  return {
    ddd: 0,
    ind: opts.ind,
    ty: 0,
    refId: opts.assetId,
    nm: opts.name,
    [LINK_KEY]: opts.nodeId,
    sr: 1,
    ks: baseTransform(
      cx,
      cy,
      ax,
      ay,
      opts.angle,
      opts.opacity,
      opts.skew || 0,
      opts.skewAxis || 0
    ),
    ao: 0,
    w: Math.max(1, Math.round(opts.box.w)),
    h: Math.max(1, Math.round(opts.box.h)),
    ip: 0,
    op: opts.op,
    st: 0,
    bm: 0,
  };
}

function isSyncableChild(node: SceneNode | null | undefined, document: SceneDocument): boolean {
  if (!node) return false;
  if (isAnimationFrameHostNode(node, document)) return false;
  if (node.key === 'video' || node.key === 'audio') return false;
  // Nested Lottie plates (not the invisible host) belong on the timeline.
  if (node.key === 'lottie') {
    return Boolean(parseLottieAnimationData(node.attrs?.animationData));
  }
  // LOT-tab ephemeral shapes sync via precomp asset — never as root layers.
  if (String(node.attrs?.precompEditSession || '').trim()) return false;
  if (node.key === 'image') return Boolean(String(node.attrs?.src || '').trim());
  // Match inspector: shape / rect / ellipse / path / text all appear as timeline layers.
  if (
    node.key === 'shape' ||
    node.key === 'rect' ||
    node.key === 'ellipse' ||
    node.key === 'path' ||
    node.key === 'text'
  ) {
    return true;
  }
  return false;
}

function shapeIsEllipse(node: SceneNode): boolean {
  if (node.key === 'ellipse') return true;
  const t = String(node.attrs?.shapeType || '').toLowerCase();
  return t === 'circle' || t === 'ellipse';
}

/** Resolve layer in/out: scene attrs > previous layer > short default (~2s), never full-span by default. */
function resolveSyncedLayerTrim(
  node: SceneNode,
  prev: Record<string, unknown> | undefined,
  compOp: number,
  fps: number,
  frameScale = 1
): { ip: number; op: number; writeAttrs: boolean } {
  const scale = Number.isFinite(frameScale) && frameScale > 0 ? frameScale : 1;
  const mapF = (n: number) => Math.round(n * scale);
  const attrIp = Number(node.attrs?.lottieInFrame);
  const attrOp = Number(node.attrs?.lottieOutFrame);
  if (Number.isFinite(attrIp) && Number.isFinite(attrOp) && attrOp > attrIp) {
    const ip = Math.max(0, mapF(attrIp));
    const op = Math.max(ip + 1, mapF(attrOp));
    return {
      ip,
      op,
      writeAttrs: Math.abs(scale - 1) > 1e-9,
    };
  }
  const keepIp = Number(prev?.ip);
  const keepOp = Number(prev?.op);
  if (Number.isFinite(keepIp) && Number.isFinite(keepOp) && keepOp > keepIp) {
    // prev layer frames are already rescaled with the composition when FPS changes.
    return { ip: keepIp, op: keepOp, writeAttrs: false };
  }
  const span = Math.max(1, Math.round(Math.max(1, fps) * 2));
  return { ip: 0, op: Math.min(Math.max(1, compOp), span), writeAttrs: true };
}

/** Rescale Bodymovin frame numbers after an FPS change (preserve wall-clock). */
function rescaleFramesDeep(value: unknown, scale: number): unknown {
  if (!(scale > 0) || Math.abs(scale - 1) < 1e-9) return value;
  if (Array.isArray(value)) {
    return value.map((row) => rescaleFramesDeep(row, scale));
  }
  if (!value || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(obj)) {
    if (
      (key === 't' || key === 'ip' || key === 'op' || key === 'st') &&
      typeof raw === 'number' &&
      Number.isFinite(raw)
    ) {
      next[key] = Math.round(raw * scale);
      continue;
    }
    if (key === 'ks' || key === 'layers' || key === 'assets' || key === 'k') {
      next[key] = rescaleFramesDeep(raw, scale);
      continue;
    }
    // Animated property bags: walk objects that look like keyframe lists.
    if (raw && typeof raw === 'object') {
      next[key] = rescaleFramesDeep(raw, scale);
    } else {
      next[key] = raw;
    }
  }
  return next;
}

export type LottieFrameSyncResult = {
  animationJson: string;
  /** Scene nodes that need attrs patched (layer index + optional trim). */
  childAttrPatches: Array<{
    nodeId: string;
    lottieLayerInd: number;
    lottieInFrame?: number;
    lottieOutFrame?: number;
  }>;
};

/**
 * Rebuild / update host animation layers from 动画工作台 children.
 * Preserves transform keyframes on already-linked layers.
 */
export function syncArtboardChildrenIntoAnimation(
  document: SceneDocument,
  frameId: string,
  hostId: string
): LottieFrameSyncResult | null {
  const frames = Array.isArray(document.frames) ? document.frames : [];
  const frame = frames.find((f) => String(f?.id) === frameId);
  const host = document.deltaSetLike?.[hostId];
  if (!frame || !host || host.key !== 'lottie') return null;

  const plate = artboardSyncPlate(document, frame);

  const existing = parseLottieAnimationData(host.attrs?.animationData);
  const fps = Math.max(1, Math.round(Number(frame.fps) || Number(existing?.fr) || 30));
  // Wall-clock must use the *previous* fr when deriving from op/ip — dividing by
  // the new fps after a rate change falsely stretches/shrinks duration.
  const prevFr = Math.max(1, Number(existing?.fr) || fps);
  const prevIp = Number(existing?.ip) || 0;
  const prevOp = Math.max(prevIp + 1, Number(existing?.op) || prevIp + prevFr * 5);
  const wallFromAnim = (prevOp - prevIp) / prevFr;
  const durationSec = Math.max(
    0.5,
    Number(frame.durationSec) || wallFromAnim || 5
  );
  // Keep the longer of authored duration vs current work-area wall time.
  const keepWallSec = Math.max(durationSec, wallFromAnim);
  const frameScale = Math.abs(fps - prevFr) > 1e-9 ? fps / prevFr : 1;
  let anim: Record<string, unknown> =
    existing && Array.isArray(existing.layers)
      ? { ...existing, w: plate.width, h: plate.height, fr: fps }
      : createBlankLottieAnimation({
          width: plate.width,
          height: plate.height,
          durationSec: keepWallSec,
          fps,
        });

  // FPS change: rescale frame numbers so wall-clock (and keyframes) stay put,
  // then ensure op covers keepWallSec (don't keep old frame counts at fps=1).
  if (existing && Math.abs(frameScale - 1) > 1e-9) {
    anim = rescaleFramesDeep(
      { ...anim, ip: prevIp, op: prevOp, fr: prevFr },
      frameScale
    ) as Record<string, unknown>;
  }
  const scaledIp = Number(anim.ip) || 0;
  const minOp = Math.max(scaledIp + 1, Math.round(scaledIp + keepWallSec * fps));
  anim = {
    ...anim,
    fr: fps,
    ip: scaledIp,
    op: Math.max(minOp, Number(anim.op) || minOp),
  };

  const boundIds = listNodesBoundToFrame(document, frameId);
  const children = boundIds
    .map((id) => ({ id, node: document.deltaSetLike?.[id] as SceneNode | undefined }))
    .filter(({ node }) => isSyncableChild(node, document))
    .sort((a, b) => {
      const ao = Number(a.node?.attrs?.frameOrder);
      const bo = Number(b.node?.attrs?.frameOrder);
      return (Number.isFinite(ao) ? ao : 0) - (Number.isFinite(bo) ? bo : 0);
    });

  const prevLayers = Array.isArray(anim.layers) ? (anim.layers as Record<string, unknown>[]) : [];
  const prevByNode = new Map<string, Record<string, unknown>>();
  const keepUnlinked: Record<string, unknown>[] = [];
  const unlinkedByInd = new Map<number, Record<string, unknown>>();
  for (const layer of prevLayers) {
    const ln = String(layer?.[LINK_KEY] || '').trim();
    if (ln) {
      prevByNode.set(ln, layer);
      continue;
    }
    // Layers that lost `ln` (lottie-web / idle rewrite) still carry `ind` —
    // reclaim them below so move/ensure does not keepUnlinked + re-bake duplicates.
    const ind = Number(layer?.ind);
    if (Number.isFinite(ind) && ind > 0) unlinkedByInd.set(ind, layer);
    keepUnlinked.push(layer);
  }

  const prevAssets = Array.isArray(anim.assets) ? [...(anim.assets as unknown[])] : [];
  const assetsById = new Map<string, Record<string, unknown>>();
  for (const raw of prevAssets) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String((raw as { id?: unknown }).id || '').trim();
    if (id) assetsById.set(id, { ...(raw as object) } as Record<string, unknown>);
  }

  const animW = Math.max(1, Number(anim.w) || plate.width);
  const animH = Math.max(1, Number(anim.h) || plate.height);
  const op = Math.max(1, Number(anim.op) || minOp);
  // Linked children only — empty/unlinked tracks prepended after the loop so
  // 「添加轨道」 stays at the top of the timeline (not under artboard shapes).
  const nextLayers: Record<string, unknown>[] = [];
  const childAttrPatches: LottieFrameSyncResult['childAttrPatches'] = [];
  const usedAssetIds = new Set<string>();

  // Timeline lists layers as in JSON (index 0 = top row). Ascending frameOrder
  // + unshift → highest FO at top among linked children.
  for (const { id: nodeId, node } of children) {
    if (!node) continue;
    const box = sceneBoxToLottieLocal(
      {
        x: Number(node.x) || 0,
        y: Number(node.y) || 0,
        w: Math.max(1, Number(node.width) || 1),
        h: Math.max(1, Number(node.height) || 1),
      },
      plate,
      animW,
      animH
    );
    const name = String(node.attrs?.name || node.key || 'Layer').trim() || 'Layer';
    const angle = nodeAngleDeg(node);
    const opacity = nodeOpacityPercent(node);
    const skew = nodeSkewDeg(node);
    const skewAxis = nodeSkewAxisDeg(node);
    const cornerRadius = nodeCornerRadius(node);
    const anchor = parseAnchorPreset(node.attrs?.anchorPreset);
    const { fx, fy } = anchorPresetToFrac(anchor);
    let prev = prevByNode.get(nodeId) || null;
    if (!prev) {
      const indAttr = Number(node.attrs?.lottieLayerInd);
      if (Number.isFinite(indAttr) && indAttr > 0) {
        const orphan = unlinkedByInd.get(indAttr);
        if (orphan) {
          prev = orphan;
          unlinkedByInd.delete(indAttr);
          const idx = keepUnlinked.indexOf(orphan);
          if (idx >= 0) keepUnlinked.splice(idx, 1);
        }
      }
    }
    let ind = Number(prev?.ind);
    if (!Number.isFinite(ind) || ind <= 0) {
      ind = nextLayerIndex([...keepUnlinked, ...nextLayers, ...Array.from(prevByNode.values())]);
    }

    if (node.key === 'lottie') {
      const childAnim = parseLottieAnimationData(node.attrs?.animationData);
      const assetId = `lot_${nodeId}`;
      const prevAsset = assetsById.get(assetId);
      const hasPrevLayers =
        prevAsset && Array.isArray(prevAsset.layers) && prevAsset.layers.length > 0;
      if (!hasPrevLayers && !childAnim) continue;
      usedAssetIds.add(assetId);
      if (!hasPrevLayers && childAnim) {
        const childLayers = Array.isArray(childAnim.layers)
          ? (childAnim.layers as unknown[]).map((row) =>
              row && typeof row === 'object' ? { ...(row as object) } : row
            )
          : [];
        assetsById.set(assetId, {
          id: assetId,
          nm: name,
          w: Math.max(1, Math.round(Number(childAnim.w) || box.w)),
          h: Math.max(1, Math.round(Number(childAnim.h) || box.h)),
          layers: childLayers,
        });
        const nested = Array.isArray(childAnim.assets) ? (childAnim.assets as unknown[]) : [];
        const idMap = new Map<string, string>();
        for (const raw of nested) {
          if (!raw || typeof raw !== 'object') continue;
          const oldId = String((raw as { id?: unknown }).id || '').trim();
          if (!oldId) continue;
          const newId = `${assetId}_${oldId}`;
          idMap.set(oldId, newId);
          assetsById.set(newId, { ...(raw as object), id: newId } as Record<string, unknown>);
          usedAssetIds.add(newId);
        }
        if (idMap.size) {
          for (const layer of childLayers) {
            if (!layer || typeof layer !== 'object') continue;
            const ref = String((layer as { refId?: unknown }).refId || '').trim();
            if (ref && idMap.has(ref)) {
              (layer as { refId: string }).refId = idMap.get(ref)!;
            }
          }
        }
      } else if (prevAsset) {
        // Keep timeline-edited precomp content; only refresh the display name.
        assetsById.set(assetId, { ...prevAsset, nm: name });
        usedAssetIds.add(assetId);
        for (const [id] of assetsById) {
          if (id.startsWith(`${assetId}_`)) usedAssetIds.add(id);
        }
      }
      const ax = box.w * fx;
      const ay = box.h * fy;
      let layer =
        prev && Number(prev.ty) === 0
          ? {
              ...prev,
              nm: name,
              [LINK_KEY]: nodeId,
              refId: assetId,
              w: Math.round(box.w),
              h: Math.round(box.h),
            }
          : makePrecompLayer({
              ind,
              name,
              nodeId,
              box,
              assetId,
              angle,
              opacity,
              op,
              skew,
              skewAxis,
              ax,
              ay,
            });
      if (!layer.ind) layer.ind = ind;
      applyStaticTransform(
        layer,
        box.x + ax,
        box.y + ay,
        ax,
        ay,
        angle,
        opacity,
        skew,
        skewAxis
      );
      {
        const trim = resolveSyncedLayerTrim(node, prev, op, fps, frameScale);
        layer.ip = trim.ip;
        layer.op = trim.op;
        childAttrPatches.push({
          nodeId,
          lottieLayerInd: Number(layer.ind) || ind,
          ...(trim.writeAttrs
            ? { lottieInFrame: trim.ip, lottieOutFrame: trim.op }
            : {}),
        });
      }
      nextLayers.unshift(layer);
      continue;
    }

    if (node.key === 'image') {
      const src = String(node.attrs?.src || '').trim();
      const assetId = `img_${nodeId}`;
      usedAssetIds.add(assetId);
      assetsById.set(assetId, {
        id: assetId,
        w: Math.max(1, Math.round(box.w)),
        h: Math.max(1, Math.round(box.h)),
        u: '',
        p: src,
        e: 1,
      });
      const ax = box.w * fx;
      const ay = box.h * fy;
      let layer =
        prev && Number(prev.ty) === 2
          ? { ...prev, nm: name, [LINK_KEY]: nodeId, refId: assetId, w: Math.round(box.w), h: Math.round(box.h) }
          : makeImageLayer({
              ind,
              name,
              nodeId,
              box,
              assetId,
              angle,
              opacity,
              op,
              skew,
              skewAxis,
              ax,
              ay,
            });
      if (!layer.ind) layer.ind = ind;
      applyStaticTransform(
        layer,
        box.x + ax,
        box.y + ay,
        ax,
        ay,
        angle,
        opacity,
        skew,
        skewAxis
      );
      {
        const trim = resolveSyncedLayerTrim(node, prev, op, fps, frameScale);
        layer.ip = trim.ip;
        layer.op = trim.op;
        childAttrPatches.push({
          nodeId,
          lottieLayerInd: Number(layer.ind) || ind,
          ...(trim.writeAttrs
            ? { lottieInFrame: trim.ip, lottieOutFrame: trim.op }
            : {}),
        });
      }
      nextLayers.unshift(layer);
      continue;
    }

    const rgb = parseCssColorToRgb01(node.attrs?.['fill-color'] || node.attrs?.fill);
    const ellipse = shapeIsEllipse(node);
    // Shape paths are centered at layer origin; offset anchor relative to center.
    const shapeAx = (fx - 0.5) * box.w;
    const shapeAy = (fy - 0.5) * box.h;
    let layer =
      prev && Number(prev.ty) === 4
        ? { ...prev, nm: name, [LINK_KEY]: nodeId }
        : makeRectLayer({
            ind,
            name,
            nodeId,
            box,
            rgb,
            angle,
            opacity,
            op,
            ellipse,
            cornerRadius,
            skew,
            skewAxis,
            ax: shapeAx,
            ay: shapeAy,
          });
    if (!layer.ind) layer.ind = ind;
    // Refresh shape geometry + fill when static.
    if (!layerHasKeyframes(layer.ks)) {
      layer = makeRectLayer({
        ind: Number(layer.ind) || ind,
        name,
        nodeId,
        box,
        rgb,
        angle,
        opacity,
        op,
        ellipse,
        cornerRadius,
        skew,
        skewAxis,
        ax: shapeAx,
        ay: shapeAy,
      });
    } else {
      applyStaticTransform(
        layer,
        box.x + box.w / 2,
        box.y + box.h / 2,
        shapeAx,
        shapeAy,
        angle,
        opacity,
        skew,
        skewAxis
      );
    }
    {
      const trim = resolveSyncedLayerTrim(node, prev, op, fps, frameScale);
      layer.ip = trim.ip;
      layer.op = trim.op;
      childAttrPatches.push({
        nodeId,
        lottieLayerInd: Number(layer.ind) || ind,
        ...(trim.writeAttrs
          ? { lottieInFrame: trim.ip, lottieOutFrame: trim.op }
          : {}),
      });
    }
    nextLayers.unshift(layer);
  }

  // Drop orphan image/precomp assets that belonged to removed synced layers.
  const nextAssets: unknown[] = [];
  for (const [id, asset] of assetsById) {
    if ((id.startsWith('img_') || id.startsWith('lot_')) && !usedAssetIds.has(id)) continue;
    nextAssets.push(asset);
  }
  // Keep non-managed assets from imports.
  for (const raw of prevAssets) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String((raw as { id?: unknown }).id || '').trim();
    if (!id || id.startsWith('img_') || id.startsWith('lot_')) continue;
    if (nextAssets.some((a) => a && typeof a === 'object' && String((a as { id?: unknown }).id) === id)) {
      continue;
    }
    nextAssets.push(raw);
  }

  anim = {
    ...anim,
    // Empty tracks first (top of dock); linked artboard children follow.
    layers: [...keepUnlinked, ...nextLayers],
    assets: nextAssets,
  };
  const animationJson = serializeLottieAnimationData(anim);
  if (!animationJson) return null;
  return { animationJson, childAttrPatches };
}

/**
 * Write LOT-tab session shape edits back into the host precomp asset before
 * tearing down ephemeral session nodes.
 */
export function syncPrecompSessionShapesIntoHost(opts: {
  document: SceneDocument;
  hostNodeId: string;
  assetId: string;
  sessionNodeIds: string[];
  frameId: string;
}): SceneDocument {
  const hostId = String(opts.hostNodeId || '').trim();
  const assetId = String(opts.assetId || '').trim();
  const frameId = String(opts.frameId || '').trim();
  const sessionIds = opts.sessionNodeIds.filter(Boolean);
  if (!hostId || !assetId || !frameId || !sessionIds.length) return opts.document;

  const host = opts.document.deltaSetLike?.[hostId];
  if (!host || host.key !== 'lottie') return opts.document;

  const frames = Array.isArray(opts.document.frames) ? opts.document.frames : [];
  const frame = frames.find((f) => String(f?.id) === frameId);
  if (!frame) return opts.document;

  const plate = artboardSyncPlate(opts.document, frame);

  const root = parseLottieAnimationData(host.attrs?.animationData);
  if (!root || !Array.isArray(root.assets)) return opts.document;

  const assets = (root.assets as Record<string, unknown>[]).map((a) =>
    a && typeof a === 'object' ? { ...a } : a
  ) as Record<string, unknown>[];
  const assetIdx = assets.findIndex((a) => String(a?.id || '') === assetId);
  if (assetIdx < 0) return opts.document;

  const asset = { ...assets[assetIdx] };
  const animW = Math.max(1, Number(asset.w) || plate.width);
  const animH = Math.max(1, Number(asset.h) || plate.height);
  const fps = Math.max(1, Number(root.fr) || Number(frame.fps) || 30);
  const op = Math.max(1, Number(asset.op) || Number(root.op) || fps * 2);

  const layers = Array.isArray(asset.layers)
    ? (asset.layers as Record<string, unknown>[]).map((l) =>
        l && typeof l === 'object' ? { ...l } : l
      )
    : [];

  let touched = false;
  for (const nodeId of sessionIds) {
    const node = opts.document.deltaSetLike?.[nodeId];
    if (!node) continue;
    let layerIdx = layers.findIndex(
      (l) => l && String(l[LINK_KEY] || '').trim() === nodeId
    );
    if (layerIdx < 0) {
      const ind = Number(node.attrs?.lottieLayerInd);
      if (Number.isFinite(ind) && ind > 0) {
        layerIdx = layers.findIndex((l) => l && Number(l?.ind) === ind);
      }
    }
    if (layerIdx < 0) continue;

    const box = sceneBoxToLottieLocal(
      {
        x: Number(node.x) || 0,
        y: Number(node.y) || 0,
        w: Math.max(1, Number(node.width) || 1),
        h: Math.max(1, Number(node.height) || 1),
      },
      plate,
      animW,
      animH
    );
    const name = String(node.attrs?.name || node.key || 'Layer').trim() || 'Layer';
    const angle = nodeAngleDeg(node);
    const opacity = nodeOpacityPercent(node);
    const skew = nodeSkewDeg(node);
    const skewAxis = nodeSkewAxisDeg(node);
    const cornerRadius = nodeCornerRadius(node);
    const rgb = parseCssColorToRgb01(node.attrs?.['fill-color'] || node.attrs?.fill);
    const ellipse = shapeIsEllipse(node);
    const prev = layers[layerIdx];
    const ind = Number(prev?.ind) || Number(node.attrs?.lottieLayerInd) || 1;

    let layer: Record<string, unknown>;
    if (!layerHasKeyframes(prev?.ks)) {
      layer = makeRectLayer({
        ind,
        name,
        nodeId,
        box,
        rgb,
        angle,
        opacity,
        op,
        ellipse,
        cornerRadius,
        skew,
        skewAxis,
        ax: 0,
        ay: 0,
      });
    } else {
      layer = { ...prev, nm: name, [LINK_KEY]: nodeId };
      applyStaticTransform(
        layer,
        box.x + box.w / 2,
        box.y + box.h / 2,
        0,
        0,
        angle,
        opacity,
        skew,
        skewAxis
      );
      if (!setLayerPathBox(layer, box, ellipse, cornerRadius)) {
        layer = makeRectLayer({
          ind,
          name,
          nodeId,
          box,
          rgb,
          angle,
          opacity,
          op,
          ellipse,
          cornerRadius,
          skew,
          skewAxis,
          ax: 0,
          ay: 0,
        });
      }
    }

    const trim = resolveSyncedLayerTrim(node, prev, op, fps);
    layer.ip = trim.ip;
    layer.op = trim.op;
    layers[layerIdx] = layer;
    touched = true;
  }

  if (!touched) return opts.document;

  asset.layers = layers;
  assets[assetIdx] = asset;
  const json = serializeLottieAnimationData({ ...root, assets });
  if (!json) return opts.document;
  if (json === String(host.attrs?.animationData || '')) return opts.document;

  const hostNode = opts.document.deltaSetLike?.[hostId];
  if (!hostNode) return opts.document;
  return {
    ...opts.document,
    deltaSetLike: {
      ...(opts.document.deltaSetLike || {}),
      [hostId]: {
        ...hostNode,
        attrs: {
          ...(hostNode.attrs || {}),
          animationData: json,
        },
      },
    },
  };
}
