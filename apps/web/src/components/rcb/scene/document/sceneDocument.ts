import { current, isDraft, produce, type WritableDraft } from 'immer';
import { nanoid } from 'nanoid';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import type {
  SceneDeltaSet,
  SceneDocument,
  SceneNode,
  SceneNodeAttrs,
  SceneNodeInput,
  ScenePage,
} from '@/components/rcb/sceneNode';

function attrFlagTrue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * Local empty-generator check for paint z — do not import nodeCapabilities here
 * (that module pulls editor focus helpers → chrome → SizePresetPanel → TDZ on A4).
 */
function isEmptyGeneratorPlateForPaintZ(
  node: SceneNode | SceneNodeInput | null | undefined
): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  const attrs = node.attrs || {};
  if (key === 'lottie' && attrFlagTrue(attrs.lottieGenerator)) return true;
  if (key === 'audio' && attrFlagTrue(attrs.audioGenerator)) return true;
  if (key === 'image' && attrFlagTrue(attrs.imageGenerator)) {
    return !String(attrs.src || '').trim();
  }
  if (key === 'video' && attrFlagTrue(attrs.videoGenerator)) {
    return !String(attrs.poster || '').trim() && !String(attrs.src || '').trim();
  }
  return false;
}

/** Default canvas size (approx A4 @ 96dpi); user can change freely */
export const DEFAULT_CANVAS = { width: 794, height: 1123 };

export const A4_PORTRAIT = { ...DEFAULT_CANVAS };

/** Partial node update: attrs shallow-merge onto the previous bag. */
export type SceneNodePatch = Partial<Omit<SceneNode, 'attrs'>> & {
  attrs?: SceneNodeAttrs | null;
};

/** Canvas chrome / size fields written by `setDocumentCanvasMeta`. */
export type DocumentCanvasMetaPatch = {
  backgroundColor?: string;
  backgroundFillType?: string;
  backgroundGradient?: unknown;
  backgroundOpacity?: number;
  backgroundImageSrc?: string;
  backgroundImageFit?: string;
  backgroundImageRotate?: number;
  backgroundImageScale?: number;
  backgroundImageOffsetX?: number;
  backgroundImageOffsetY?: number;
  backgroundImageAdjust?: unknown;
  width?: number;
  height?: number;
  gridSize?: number;
};

function createPage(id?: string): ScenePage {
  return {
    id: id || nanoid(8),
    children: [],
  };
}

/** Isolate a node/frame/doc slice without JSON.parse(JSON.stringify). */
export function cloneSceneValue<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value;
  // Reducers run under Immer — drafts are Proxies and throw DataCloneError in structuredClone.
  const plain = (isDraft(value) ? current(value as never) : value) as T;
  try {
    if (typeof structuredClone === 'function') return structuredClone(plain);
  } catch {
    /* non-cloneable fields — fall through */
  }
  return JSON.parse(JSON.stringify(plain)) as T;
}

/** World paint order: `frame:id` | unbound `node:id` (bottom → top). */
export function stackFrameKey(id: string) {
  return `frame:${id}`;
}

export function stackNodeKey(id: string) {
  return `node:${id}`;
}

export function parseStackKey(
  key: string
): { kind: 'frame' | 'node'; id: string } | null {
  if (typeof key !== 'string') return null;
  if (key.startsWith('frame:')) return { kind: 'frame', id: key.slice(6) };
  if (key.startsWith('node:')) return { kind: 'node', id: key.slice(5) };
  return null;
}

function listRootNodeIds(doc: SceneDocument): string[] {
  const page = Array.isArray(doc?.pages) ? doc.pages[0] : null;
  const fromPage = page?.children;
  if (Array.isArray(fromPage)) return uniqueStringIds(fromPage);
  const fromRoot = doc?.deltaSetLike?.ROOT?.children;
  return Array.isArray(fromRoot) ? uniqueStringIds(fromRoot) : [];
}

/** Stable unique ids — duplicate ROOT/page children break React keys + SoA sync. */
export function uniqueStringIds(ids: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isNodeBoundToFrame(doc: SceneDocument, nodeId: string): boolean {
  const frameId = String(doc.deltaSetLike?.[nodeId]?.attrs?.frameId || '').trim();
  if (!frameId) return false;
  return (doc.frames || []).some((frame) => String(frame?.id || '') === frameId);
}

function listWorldNodeIds(doc: SceneDocument): string[] {
  return listRootNodeIds(doc).filter((nodeId) => !isNodeBoundToFrame(doc, nodeId));
}

/**
 * Keep `doc.stackOrder` in sync with frames + unbound world nodes.
 * Frame children use `attrs.frameOrder` and never occupy a world stack slot.
 * Empty → frames first, then unbound nodes.
 * Missing frames insert under content; missing nodes append on top.
 */
export function reconcileStackOrder(doc: SceneDocument): string[] {
  if (!doc || typeof doc !== 'object') return [];
  const frameIds = (Array.isArray(doc.frames) ? doc.frames : [])
    .map((f) => (f?.id != null ? String(f.id) : ''))
    .filter(Boolean);
  const nodeIds = listWorldNodeIds(doc);
  const frameSet = new Set(frameIds);
  const nodeSet = new Set(nodeIds);
  const raw = Array.isArray(doc.stackOrder) ? doc.stackOrder.map(String) : [];

  if (!raw.length) {
    const migrated = [
      ...frameIds.map(stackFrameKey),
      ...nodeIds.map(stackNodeKey),
    ];
    doc.stackOrder = migrated;
    return migrated;
  }

  const seen = new Set<string>();
  let kept: string[] = [];
  for (const key of raw) {
    const parsed = parseStackKey(key);
    if (!parsed) continue;
    if (parsed.kind === 'frame' && !frameSet.has(parsed.id)) continue;
    if (parsed.kind === 'node' && !nodeSet.has(parsed.id)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }
  // Missing frames belong under content (after last kept frame, else at front).
  // Appending them on top paints the white plate over existing nodes.
  let frameInsertAt = 0;
  for (let i = 0; i < kept.length; i += 1) {
    if (parseStackKey(kept[i])?.kind === 'frame') frameInsertAt = i + 1;
  }
  const missingFrames: string[] = [];
  for (const id of frameIds) {
    const key = stackFrameKey(id);
    if (seen.has(key)) continue;
    missingFrames.push(key);
    seen.add(key);
  }
  if (missingFrames.length) {
    kept = [
      ...kept.slice(0, frameInsertAt),
      ...missingFrames,
      ...kept.slice(frameInsertAt),
    ];
  }
  for (const id of nodeIds) {
    const key = stackNodeKey(id);
    if (seen.has(key)) continue;
    kept.push(key);
    seen.add(key);
  }
  doc.stackOrder = kept;
  return kept;
}

/** 1-based CSS z-index from unified stack (0 if missing). */
const STACK_GROUP_STRIDE = 100000;

/**
 * Batch node z-index for paint/hit sorts. Avoids O(N²) from calling
 * {@link stackZIndex} inside a comparator (each call rescans frame siblings).
 */
export function buildNodeStackZMap(
  doc: SceneDocument | null | undefined,
  ids: readonly string[]
): Map<string, number> {
  const out = new Map<string, number>();
  if (!doc || !ids.length) return out;
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder : [];
  const rootIds = listRootNodeIds(doc);
  const siblingsByFrame = new Map<string, Array<SceneNode | undefined>>();
  for (const nodeId of rootIds) {
    const node = doc.deltaSetLike?.[nodeId];
    const frameId = String(node?.attrs?.frameId || '').trim();
    if (!frameId) continue;
    let list = siblingsByFrame.get(frameId);
    if (!list) {
      list = [];
      siblingsByFrame.set(frameId, list);
    }
    list.push(node);
  }
  const frameIndexById = new Map<string, number>();
  for (const id of ids) {
    const key = String(id || '');
    if (!key || out.has(key)) continue;
    const parsed = parseStackKey(key);
    if (parsed?.kind === 'frame') {
      const frameIndex = order.indexOf(stackFrameKey(parsed.id));
      out.set(key, frameIndex < 0 ? 0 : (frameIndex + 1) * STACK_GROUP_STRIDE);
      continue;
    }
    const node = doc.deltaSetLike?.[key];
    const frameId = String(node?.attrs?.frameId || '').trim();
    if (!frameId) {
      const nodeIndex = order.indexOf(stackNodeKey(key));
      out.set(
        key,
        nodeIndex < 0
          ? 0
          : (nodeIndex + 1) * STACK_GROUP_STRIDE + Math.floor(STACK_GROUP_STRIDE / 2)
      );
      continue;
    }
    let frameIndex = frameIndexById.get(frameId);
    if (frameIndex == null) {
      frameIndex = order.indexOf(stackFrameKey(frameId));
      frameIndexById.set(frameId, frameIndex);
    }
    if (frameIndex < 0) {
      const nodeIndex = order.indexOf(stackNodeKey(key));
      out.set(
        key,
        nodeIndex < 0
          ? 0
          : (nodeIndex + 1) * STACK_GROUP_STRIDE + Math.floor(STACK_GROUP_STRIDE / 2)
      );
      continue;
    }
    const siblings = siblingsByFrame.get(frameId) || [];
    const explicitOrder = Number(node?.attrs?.frameOrder);
    const localIndex = Number.isFinite(explicitOrder)
      ? explicitOrder
      : Math.max(
          0,
          siblings.findIndex((item) => item?.id === key)
        );
    const localSlot = Math.min(
      STACK_GROUP_STRIDE - 2,
      Math.max(1, Math.round(localIndex) + 1)
    );
    out.set(key, (frameIndex + 1) * STACK_GROUP_STRIDE + localSlot);
  }
  return out;
}

/**
 * Unified hit z-map: bare node ids + `frame:id` plate keys share one permanent
 * stackOrder scale (selection paint raise is ignored).
 */
export function buildUnifiedHitZMap(
  doc: SceneDocument | null | undefined,
  candidateKeys: readonly string[]
): Map<string, number> {
  return buildNodeStackZMap(doc, candidateKeys);
}

export function stackZIndex(doc: SceneDocument, kind: 'frame' | 'node', id: string): number {
  const order = Array.isArray(doc?.stackOrder) ? doc.stackOrder : [];
  if (kind === 'frame') {
    const frameIndex = order.indexOf(stackFrameKey(id));
    return frameIndex < 0 ? 0 : (frameIndex + 1) * STACK_GROUP_STRIDE;
  }
  const node = doc.deltaSetLike?.[id];
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) {
    const nodeIndex = order.indexOf(stackNodeKey(id));
    if (nodeIndex < 0) return 0;
    return (nodeIndex + 1) * STACK_GROUP_STRIDE + Math.floor(STACK_GROUP_STRIDE / 2);
  }
  const frameIndex = order.indexOf(stackFrameKey(frameId));
  if (frameIndex < 0) {
    const nodeIndex = order.indexOf(stackNodeKey(id));
    if (nodeIndex < 0) return 0;
    return (nodeIndex + 1) * STACK_GROUP_STRIDE + Math.floor(STACK_GROUP_STRIDE / 2);
  }
  const siblings = listRootNodeIds(doc)
    .map((nodeId) => doc.deltaSetLike?.[nodeId])
    .filter((item) => String(item?.attrs?.frameId || '').trim() === frameId);
  const explicitOrder = Number(node?.attrs?.frameOrder);
  const localIndex = Number.isFinite(explicitOrder)
    ? explicitOrder
    : Math.max(0, siblings.findIndex((item) => item?.id === id));
  // Keep frame children between their plate and the next world-level item.
  const localSlot = Math.min(
    STACK_GROUP_STRIDE - 2,
    Math.max(1, Math.round(localIndex) + 1)
  );
  return (frameIndex + 1) * STACK_GROUP_STRIDE + localSlot;
}

/** Highest permanent paint z on the canvas (from `stackOrder`). */
export function maxDocumentStackZ(doc: SceneDocument | null | undefined): number {
  if (!doc) return 0;
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder : [];
  let max = 0;
  for (const key of order) {
    const parsed = parseStackKey(String(key));
    if (!parsed) continue;
    const z = stackZIndex(doc, parsed.kind, parsed.id);
    if (z > max) max = z;
  }
  return max;
}

/**
 * Selection temporary paint z. Does not mutate `stackOrder`.
 * - World node / frame plate → max + 1
 * - Frame-bound child → max + 1 + localSlot so the raised plate cannot cover ink
 *   (in-frame order stays plate-relative; only the whole group lifts vs the world).
 */
export function selectionPaintZIndex(
  doc: SceneDocument | null | undefined,
  kind: 'frame' | 'node',
  id: string,
  raised: boolean
): number {
  if (!doc) return 0;
  const natural = stackZIndex(doc, kind, id);
  if (!raised) return natural;
  const base = maxDocumentStackZ(doc) + 1;
  if (kind === 'frame') return base;
  const node = doc.deltaSetLike?.[id];
  const frameId = String(node?.attrs?.frameId || '').trim();
  if (!frameId) return base;
  const plateZ = stackZIndex(doc, 'frame', frameId);
  const localSlot = Math.max(1, natural - plateZ);
  return base + localSlot;
}

/** Highest permanent z among artboard / 动画工作台 plates. */
export function maxArtboardPlateStackZ(doc: SceneDocument | null | undefined): number {
  if (!doc?.frames?.length) return 0;
  let max = 0;
  for (const frame of doc.frames) {
    const id = String(frame?.id || '').trim();
    if (!id) continue;
    max = Math.max(max, stackZIndex(doc, 'frame', id));
  }
  return max;
}

/**
 * Host + hit z for nodes. Empty world generators never sit under opaque artboard
 * plates: idle SoA used to paint under every plate, and SVG hosts that follow
 * raw stackOrder vanish under a later 画板 until selection max+1.
 * Does not mutate `stackOrder`.
 */
export function nodePaintZIndex(
  doc: SceneDocument | null | undefined,
  id: string,
  raised: boolean
): number {
  if (!doc) return 0;
  if (raised) return selectionPaintZIndex(doc, 'node', id, true);
  const natural = stackZIndex(doc, 'node', id);
  const node = doc.deltaSetLike?.[id];
  if (!isEmptyGeneratorPlateForPaintZ(node)) return natural;
  if (String(node?.attrs?.frameId || '').trim()) return natural;
  const maxFrameZ = maxArtboardPlateStackZ(doc);
  if (maxFrameZ <= 0 || natural > maxFrameZ) return natural;
  // Above every plate; keep relative order from permanent stack slots.
  return maxFrameZ + 1 + Math.floor(natural / STACK_GROUP_STRIDE);
}

/**
 * World (unbound) node whose stack z is above at least one artboard plate.
 * Those must paint as SVG hosts on the shared stack mount — SoA ink sits under
 * that SVG, so only hosts can cover 画板 / 动画工作台 plates via data-z.
 *
 * Workbench surround (`animationWorkbenchSurround`) is visibility-only: always
 * false here so pasteboard ink stays SoA mesh (same as closed-timeline world).
 * Do not reintroduce DomHost promotion for surround.
 */
export function worldNodeStacksAboveAnyFrame(
  doc: SceneDocument | null | undefined,
  nodeId: string
): boolean {
  if (!doc || !nodeId) return false;
  const node = doc.deltaSetLike?.[nodeId];
  if (!node) return false;
  if (String(node.attrs?.frameId || '').trim()) return false;
  // Attr string only — avoid importing animationWorkbenchFocus (TDZ cycles).
  if (String(node.attrs?.animationWorkbenchSurround || '').trim()) return false;
  const nodeZ = stackZIndex(doc, 'node', nodeId);
  if (nodeZ <= 0) return false;
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder : [];
  for (const key of order) {
    const parsed = parseStackKey(String(key));
    if (!parsed || parsed.kind !== 'frame') continue;
    if (nodeZ > stackZIndex(doc, 'frame', parsed.id)) return true;
  }
  return false;
}

/** Single-select only: one node and no frames, or one frame and no nodes. */
export function isSingleStackSelection(
  selectedNodeIds: readonly string[],
  selectedFrameIds: readonly string[]
): boolean {
  const nodes = selectedNodeIds.map(String).filter(Boolean);
  const frames = selectedFrameIds.map(String).filter(Boolean);
  if (nodes.length === 1 && frames.length === 0) return true;
  if (frames.length === 1 && nodes.length === 0) return true;
  return false;
}

/**
 * Node ids that temporarily paint at max+1 with a single selection.
 * Multi-select → empty (no raise). Single frame → that frame's bound children
 * (raise for stacking only — clip reveal is owned by selected *nodes*).
 */
export function listSingleSelectionPaintRaiseNodeIds(
  doc: SceneDocument | null | undefined,
  selectedNodeIds: readonly string[],
  selectedFrameIds: readonly string[]
): string[] {
  if (!doc || !isSingleStackSelection(selectedNodeIds, selectedFrameIds)) return [];
  const nodes = [...new Set(selectedNodeIds.map(String).filter(Boolean))];
  if (nodes.length === 1) return [nodes[0]];
  const frameId = String(selectedFrameIds[0] || '');
  if (!frameId) return [];
  const out: string[] = [];
  for (const id of listRootNodeIds(doc)) {
    if (String(doc.deltaSetLike?.[id]?.attrs?.frameId || '').trim() === frameId) {
      out.push(id);
    }
  }
  return out;
}

function reorderKeysInList(
  ids: string[],
  selected: string[],
  action: 'front' | 'back' | 'forward' | 'backward'
): string[] {
  if (!selected.length) return ids;
  const rest = ids.filter((id) => !selected.includes(id));
  if (action === 'front') return [...rest, ...selected];
  if (action === 'back') return [...selected, ...rest];
  if (action === 'forward') {
    const working = [...ids];
    for (let i = working.length - 2; i >= 0; i -= 1) {
      if (selected.includes(working[i]) && !selected.includes(working[i + 1])) {
        const tmp = working[i];
        working[i] = working[i + 1];
        working[i + 1] = tmp;
      }
    }
    return working;
  }
  const working = [...ids];
  for (let i = 1; i < working.length; i += 1) {
    if (selected.includes(working[i]) && !selected.includes(working[i - 1])) {
      const tmp = working[i];
      working[i] = working[i - 1];
      working[i - 1] = tmp;
    }
  }
  return working;
}

function emptyDeltaSet(): SceneDeltaSet {
  return {
    ROOT: {
      id: 'ROOT',
      key: 'entry',
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      attrs: {},
      children: [],
    },
  };
}

/** Bare infinite world (no artboard frames). */
export function createBareDocument(): SceneDocument {
  const page = createPage();
  return {
    x: 0,
    y: 0,
    width: DEFAULT_CANVAS.width,
    height: DEFAULT_CANVAS.height,
    // Empty → editor follows theme `--canvas` (light/dark).
    backgroundColor: '',
    frames: [],
    activeFrameId: null,
    pages: [page],
    activePageId: page.id,
    deltaSetLike: emptyDeltaSet(),
  };
}

export function createEmptyDocument(size?: {
  width?: number;
  height?: number;
  emptyWorld?: boolean;
}): SceneDocument {
  if (size?.emptyWorld) return createBareDocument();

  const width = Math.max(100, Math.round(size?.width || DEFAULT_CANVAS.width));
  const height = Math.max(100, Math.round(size?.height || DEFAULT_CANVAS.height));
  const page = createPage();
  return {
    x: 0,
    y: 0,
    width,
    height,
    backgroundColor: '',
    frames: [],
    activeFrameId: null,
    pages: [page],
    activePageId: page.id,
    deltaSetLike: emptyDeltaSet(),
  };
}

/** Merge a partial node patch (attrs shallow-merge; preserve shapeType). */
export function mergeNodePatch(prev: SceneNode, patch: SceneNodePatch | null | undefined): SceneNode;
export function mergeNodePatch(
  prev: SceneNode | null | undefined,
  patch: SceneNodePatch | null | undefined
): SceneNode | null | undefined;
export function mergeNodePatch(
  prev: SceneNode | null | undefined,
  patch: SceneNodePatch | null | undefined
): SceneNode | null | undefined {
  if (!prev) return prev;
  const { attrs, ...rest } = patch || {};
  const prevAttrs = prev.attrs || {};
  let nextAttrs: SceneNodeAttrs = prevAttrs;
  if (attrs) {
    nextAttrs = { ...prevAttrs, ...attrs };
    if (
      prevAttrs.shapeType != null &&
      (nextAttrs.shapeType == null || nextAttrs.shapeType === '')
    ) {
      nextAttrs.shapeType = prevAttrs.shapeType;
    }
  }
  return { ...prev, ...rest, attrs: nextAttrs };
}

/**
 * Patch deltaSetLike keys with Immer structural sharing (plain objects only).
 * Never use a custom Proxy — Immer Object.keys traps reject it.
 *
 * Always return an extensible shallow shell: Immer autoFreeze seals `produce`
 * results in DEV, but normalize/add/remove still assign or delete top-level keys.
 */
export function patchDeltaSetLike(
  delta: SceneDeltaSet | null | undefined,
  patches: Record<string, SceneNode>
): SceneDeltaSet {
  const keys = patches ? Object.keys(patches) : [];
  if (!keys.length) {
    if (!delta || typeof delta !== 'object') return {};
    return Object.isExtensible(delta) ? delta : flattenDeltaSetLike(delta);
  }
  const base: SceneDeltaSet = delta && typeof delta === 'object' ? delta : {};
  const produced = produce(base, (draft: WritableDraft<SceneDeltaSet>) => {
    for (const key of keys) {
      draft[key] = patches[key];
    }
  });
  return flattenDeltaSetLike(produced);
}

/** Shallow copy for normalize/save (delta is always a plain object now). */
export function flattenDeltaSetLike(delta: SceneDeltaSet | null | undefined): SceneDeltaSet {
  if (!delta || typeof delta !== 'object') return {};
  return { ...delta };
}

/** Fill defaults; keep a single logical page for editing. */
export function normalizeDocument(doc: unknown): SceneDocument {
  if (!doc || typeof doc !== 'object') return createEmptyDocument({ emptyWorld: true });
  const src = doc as SceneDocument;
  // Shallow COW shell — share node objects; never JSON deep-clone the whole map.
  const next: SceneDocument = {
    ...src,
    deltaSetLike: flattenDeltaSetLike(src.deltaSetLike),
    frames: Array.isArray(src.frames) ? src.frames.slice() : [],
    pages: Array.isArray(src.pages)
      ? src.pages.map((p) =>
          p && typeof p === 'object'
            ? {
                ...p,
                children: Array.isArray(p.children)
                  ? uniqueStringIds(p.children)
                  : p.children,
              }
            : p
        )
      : src.pages,
    stackOrder: Array.isArray(src.stackOrder) ? [...src.stackOrder] : src.stackOrder,
  };
  // Uploaded/generated video plates use pixel-aligned geometry. Older
  // documents and external imports may contain .5 dimensions, which makes
  // the HTML video surface and SVG selection chrome land on different edges.
  // Normalize the shared node record once so paint, hit-test and chrome all
  // consume the same integer box.
  const delta = next.deltaSetLike;
  let normalizedDelta: SceneDeltaSet | null = null;
  for (const [id, node] of Object.entries(delta)) {
    if (!node) continue;
    let patched = node;
    let dirty = false;
    if (node.key === 'video') {
      const x = Math.round(Number(node.x) || 0);
      const y = Math.round(Number(node.y) || 0);
      const width = Math.max(1, Math.round(Number(node.width) || 1));
      const height = Math.max(1, Math.round(Number(node.height) || 1));
      if (node.x !== x || node.y !== y || node.width !== width || node.height !== height) {
        patched = { ...patched, x, y, width, height };
        dirty = true;
      }
    }
    const attrs = patched.attrs as Record<string, unknown> | undefined;
    if (attrs) {
      let nextAttrs: Record<string, unknown> | null = null;
      if (attrs.lottieFrameHost === true || attrs.lottieFrameHost === 'true') {
        nextAttrs = { ...(nextAttrs || attrs), animationFrameHost: true };
        delete nextAttrs.lottieFrameHost;
      }
      if (patched.key === 'text') {
        const fill = String(attrs['fill-color'] ?? '').trim().toLowerCase();
        if (
          fill === 'var(--gen-empty)' ||
          fill === '#e9eaee' ||
          fill === 'var(--surface)' ||
          fill === 'var(--rail)'
        ) {
          nextAttrs = { ...(nextAttrs || attrs), 'fill-color': '#FFFFFF' };
        }
        const tl = Math.max(0, Math.round(Number(attrs.radiusTL) || 0));
        const tr = Math.max(0, Math.round(Number(attrs.radiusTR) || 0));
        const br = Math.max(0, Math.round(Number(attrs.radiusBR) || 0));
        const bl = Math.max(0, Math.round(Number(attrs.radiusBL) || 0));
        if (tl === 16 && tr === 16 && br === 16 && bl === 16) {
          nextAttrs = {
            ...(nextAttrs || attrs),
            radiusTL: 0,
            radiusTR: 0,
            radiusBR: 0,
            radiusBL: 0,
          };
        }
      }
      if (nextAttrs) {
        patched = { ...patched, attrs: nextAttrs };
        dirty = true;
      }
    }
    if (!dirty) continue;
    normalizedDelta ||= { ...delta };
    normalizedDelta[id] = patched;
  }
  if (normalizedDelta) next.deltaSetLike = normalizedDelta;
  next.width = Math.max(100, Math.round(Number(next.width) || DEFAULT_CANVAS.width));
  next.height = Math.max(100, Math.round(Number(next.height) || DEFAULT_CANVAS.height));
  // Empty bg follows theme `--canvas` in EditorPage.
  if (next.backgroundColor == null) next.backgroundColor = '';
  if (!Array.isArray(next.frames)) next.frames = [];
  next.frames = next.frames.map((f) => {
    if (!f || typeof f !== 'object') return f;
    const bg = String(f.backgroundColor || '').trim();
    let withBg: ArtboardFrame =
      !bg || bg === 'none' ? { ...f, backgroundColor: '#FFFFFF' } : { ...f };
    // One-shot: old docs used kind `lottie` for 动画工作台 plates.
    if (String((withBg as { kind?: string }).kind || '') === 'lottie') {
      withBg = { ...withBg, kind: 'animation' };
    }
    if (isAnimationArtboardKind(withBg.kind) && bg === 'transparent') {
      const op = withBg.backgroundOpacity;
      if (op == null || Number(op) === 0) {
        withBg = { ...withBg, backgroundColor: '#FFFFFF', backgroundOpacity: 100 };
      }
    }
    // Artboards clip their content by default; users can explicitly show overflow.
    if (withBg.clipContent === undefined) withBg.clipContent = true;
    // Ephemeral AI chrome lives in editor aiOperationState — drop frame fields.
    const cleaned = { ...withBg } as ArtboardFrame & {
      processStatus?: unknown;
      processLabel?: unknown;
      processKind?: unknown;
    };
    delete cleaned.processStatus;
    delete cleaned.processLabel;
    delete cleaned.processKind;
    return cleaned;
  });
  // Keep activeFrameId nullable — null means no frame selected (do not force frames[0]).
  if (next.activeFrameId != null) {
    const exists = next.frames.some((f) => f?.id === next.activeFrameId);
    if (!exists) next.activeFrameId = null;
  }

  // Collapse multi-page docs into one canvas
  if (!Array.isArray(next.pages) || !next.pages.length) {
    const page = createPage();
    page.children = uniqueStringIds(next.deltaSetLike?.ROOT?.children || []);
    next.pages = [page];
  } else if (next.pages.length > 1) {
    const merged = next.pages.flatMap((p) => p.children || []);
    const page = createPage(next.pages[0].id);
    page.children = uniqueStringIds(merged);
    next.pages = [page];
  }
  next.activePageId = next.pages[0].id;
  syncRootChildren(next);
  reconcileStackOrder(next);
  return migrateWorldCoordsToFrameLocal(next);
}

/**
 * One-shot: artboard children become plate-local (00 = frame top-left).
 * Dragging a frame then only moves `frames[].x/y` — child attrs stay put.
 */
function migrateWorldCoordsToFrameLocal(doc: SceneDocument): SceneDocument {
  if (String(doc.coordSpace || '') === 'frameLocal') return doc;
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const byId = new Map(
    frames.filter(Boolean).map((f) => [String(f.id), f] as const)
  );
  let delta = doc.deltaSetLike;
  let dirty = false;
  if (byId.size) {
    for (const [id, node] of Object.entries(delta || {})) {
      if (!node || id === 'ROOT') continue;
      const frameId = String(node.attrs?.frameId || '').trim();
      if (!frameId) continue;
      const frame = byId.get(frameId);
      if (!frame) continue;
      const fx = Number(frame.x) || 0;
      const fy = Number(frame.y) || 0;
      const nx = Number(node.x) || 0;
      const ny = Number(node.y) || 0;
      const lx = nx - fx;
      const ly = ny - fy;
      if (lx === nx && ly === ny && fx === 0 && fy === 0) continue;
      if (!dirty) {
        delta = { ...delta };
        dirty = true;
      }
      delta[id] = { ...node, x: lx, y: ly };
    }
  }
  return {
    ...doc,
    deltaSetLike: dirty ? delta : doc.deltaSetLike,
    coordSpace: 'frameLocal',
  };
}

/** Shift imported JSON so content sits in canvas-local coords (document origin cleared). */
export function alignImportedDocumentOrigin(doc: unknown) {
  const next = normalizeDocument(doc);
  const page = getActivePage(next);
  const ids = page?.children || [];
  const docOx = Number(next.x) || 0;
  const docOy = Number(next.y) || 0;

  /**
   * Always bake `document.x/y` into node/frame coords then clear origin.
   * Editor paint (`canvasDocument`) forces origin 0 — leaving a non-zero store
   * origin makes fitView (store) disagree with hosts (zeroed), then a later
   * align remounts every shape and the page jumps after boot.
   *
   * With artboards: only bake the document origin (do NOT also subtract minX/minY —
   * that would collapse case margins). Without frames: also pull content to (0,0).
   */
  const hasFrames = Array.isArray(next.frames) && next.frames.length > 0;
  let shiftX = docOx;
  let shiftY = docOy;
  if (!hasFrames) {
    let minX = Infinity;
    let minY = Infinity;
    for (const id of ids) {
      const node = next.deltaSetLike?.[id];
      if (!node) continue;
      const x = Number(node.x) || 0;
      const y = Number(node.y) || 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
    }
    if (Number.isFinite(minX)) {
      shiftX = docOx + minX;
      shiftY = docOy + minY;
    }
  }

  if (shiftX !== 0 || shiftY !== 0) {
    for (const id of ids) {
      const node = next.deltaSetLike?.[id];
      if (!node) continue;
      node.x = (Number(node.x) || 0) - shiftX;
      node.y = (Number(node.y) || 0) - shiftY;
    }
    if (hasFrames) {
      for (const f of next.frames) {
        if (!f) continue;
        f.x = (Number(f.x) || 0) - shiftX;
        f.y = (Number(f.y) || 0) - shiftY;
      }
    }
  }
  next.x = 0;
  next.y = 0;
  return next;
}

/**
 * Ensure content is paintable at document origin 0.
 * Non-zero `document.x/y` must always be baked away — not only when off-canvas.
 */
export function ensureDocumentContentOnCanvas(doc: SceneDocument) {
  const next = normalizeDocument(doc);
  const ox = Number(next.x) || 0;
  const oy = Number(next.y) || 0;
  if (ox !== 0 || oy !== 0) {
    return alignImportedDocumentOrigin(next);
  }

  const page = getActivePage(next);
  const ids = page?.children || [];
  if (!ids.length) return next;

  const w = next.width || DEFAULT_CANVAS.width;
  const h = next.height || DEFAULT_CANVAS.height;

  let minL = Infinity;
  let minT = Infinity;
  let maxR = -Infinity;
  let maxB = -Infinity;
  for (const id of ids) {
    const node = next.deltaSetLike?.[id];
    if (!node) continue;
    const left = Number(node.x) || 0;
    const top = Number(node.y) || 0;
    const right = left + Math.max(Number(node.width) || 0, 1);
    const bottom = top + Math.max(Number(node.height) || 0, 1);
    minL = Math.min(minL, left);
    minT = Math.min(minT, top);
    maxR = Math.max(maxR, right);
    maxB = Math.max(maxB, bottom);
  }
  if (!Number.isFinite(minL)) return next;

  const intersects = maxR > 0 && maxB > 0 && minL < w && minT < h;
  if (intersects) return next;
  return alignImportedDocumentOrigin(next);
}

export function syncRootChildren(doc: SceneDocument) {
  const page = doc.pages?.find((p) => p.id === doc.activePageId) || doc.pages?.[0];
  if (!doc.deltaSetLike?.ROOT || !page) return doc;
  const root = doc.deltaSetLike.ROOT;
  const children = uniqueStringIds(page.children || []);
  if (page.children !== children) page.children = children;
  // Always write a deduped list — Yjs / paste can leave duplicate slots.
  if (
    !Array.isArray(root.children) ||
    root.children.length !== children.length ||
    children.some((id, i) => String(root.children?.[i] || '') !== id)
  ) {
    doc.deltaSetLike = patchDeltaSetLike(doc.deltaSetLike, {
      ROOT: {
        ...root,
        children,
      },
    });
  }
  return doc;
}

export function getActivePage(doc: SceneDocument) {
  if (!doc?.pages?.length) return null;
  return doc.pages.find((p) => p.id === doc.activePageId) || doc.pages[0];
}

export function setDocumentSize(doc: SceneDocument, width: number, height: number) {
  const next = normalizeDocument(doc);
  next.width = Math.max(100, Math.round(width) || DEFAULT_CANVAS.width);
  next.height = Math.max(100, Math.round(height) || DEFAULT_CANVAS.height);
  return next;
}

export function setDocumentCanvasMeta(doc: SceneDocument, patch: DocumentCanvasMetaPatch = {}) {
  const next = normalizeDocument(doc);
  if (patch.backgroundColor != null) next.backgroundColor = patch.backgroundColor;
  if (patch.backgroundFillType != null) next.backgroundFillType = patch.backgroundFillType;
  if (patch.backgroundGradient != null) next.backgroundGradient = patch.backgroundGradient;
  if (patch.backgroundOpacity != null) next.backgroundOpacity = patch.backgroundOpacity;
  if (patch.backgroundImageSrc != null) next.backgroundImageSrc = patch.backgroundImageSrc;
  if (patch.backgroundImageFit != null) next.backgroundImageFit = patch.backgroundImageFit;
  if (patch.backgroundImageRotate != null) next.backgroundImageRotate = patch.backgroundImageRotate;
  if (patch.backgroundImageScale != null) next.backgroundImageScale = patch.backgroundImageScale;
  if (patch.backgroundImageOffsetX != null) next.backgroundImageOffsetX = patch.backgroundImageOffsetX;
  if (patch.backgroundImageOffsetY != null) next.backgroundImageOffsetY = patch.backgroundImageOffsetY;
  if (patch.backgroundImageAdjust != null) next.backgroundImageAdjust = patch.backgroundImageAdjust;
  if (patch.width != null) next.width = Math.max(100, Math.round(patch.width) || DEFAULT_CANVAS.width);
  if (patch.height != null) next.height = Math.max(100, Math.round(patch.height) || DEFAULT_CANVAS.height);
  if (patch.gridSize != null) {
    const g = Number(patch.gridSize);
    if (Number.isFinite(g) && g > 0) next.gridSize = g;
  }
  return next;
}

export function addNodeToDocument(
  doc: SceneDocument | null | undefined,
  nodeId: string,
  node: SceneNodeInput | Record<string, unknown>
) {
  return addNodesToDocument(doc, [{ id: nodeId, node }]);
}

/**
 * Insert many nodes with one normalize / ROOT sync / stack reconcile.
 * Paste / import of hundreds of nodes must use this — looping
 * {@link addNodeToDocument} is O(N×M) and freezes the tab.
 *
 * `skipNormalize`: caller already produced an exclusive COW shell (trusted paste).
 */
export function addNodesToDocument(
  doc: SceneDocument | null | undefined,
  entries: ReadonlyArray<{ id: string; node: SceneNodeInput | Record<string, unknown> }>,
  opts?: { skipNormalize?: boolean }
) {
  const list = (entries || []).filter((e) => e && String(e.id || '').trim());
  if (!list.length) {
    if (opts?.skipNormalize && doc && typeof doc === 'object') return doc;
    return normalizeDocument(doc);
  }
  const next = opts?.skipNormalize && doc && typeof doc === 'object'
    ? doc
    : normalizeDocument(doc);
  const page = getActivePage(next);
  const frameMaxOrder = new Map<string, number>();
  for (const id of listRootNodeIds(next)) {
    const item = next.deltaSetLike?.[id];
    const frameId = String(item?.attrs?.frameId || '').trim();
    if (!frameId) continue;
    const ord = Number(item?.attrs?.frameOrder);
    if (!Number.isFinite(ord)) continue;
    const prev = frameMaxOrder.get(frameId);
    if (prev == null || ord > prev) frameMaxOrder.set(frameId, ord);
  }

  const children = page ? [...(page.children || [])] : [];
  const childSet = new Set(children.map(String));
  let order = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
  const orderSet = new Set(order);

  for (const entry of list) {
    const nodeId = String(entry.id);
    const incoming = entry.node as SceneNode;
    const frameId = String(incoming.attrs?.frameId || '').trim();
    let storedNode = incoming;
    if (frameId) {
      const maxOrd = frameMaxOrder.has(frameId) ? frameMaxOrder.get(frameId)! : -1;
      const nextOrd = maxOrd + 1;
      frameMaxOrder.set(frameId, nextOrd);
      storedNode = {
        ...incoming,
        attrs: {
          ...(incoming.attrs || {}),
          frameId,
          frameOrder: nextOrd,
        },
      };
    }
    next.deltaSetLike[nodeId] = storedNode;
    if (!childSet.has(nodeId)) {
      children.push(nodeId);
      childSet.add(nodeId);
    }
    if (!frameId) {
      const key = stackNodeKey(nodeId);
      if (!orderSet.has(key)) {
        order.push(key);
        orderSet.add(key);
      }
    }
  }

  if (page) page.children = children;
  next.stackOrder = order;
  // Dedupe before sync — paste / Yjs can leave duplicate child slots.
  if (page) page.children = uniqueStringIds(page.children || []);
  syncRootChildren(next);
  reconcileStackOrder(next);
  return next;
}

/** Merge an imported Scene (image job) into the current canvas with remapped ids. */
export function mergeImportedIntoDocument(
  base: SceneDocument | null | undefined,
  incoming: SceneDocument | null | undefined,
  opts?: { offsetX?: number; offsetY?: number }
) {
  if (!base) return alignImportedDocumentOrigin(incoming);
  const src = alignImportedDocumentOrigin(incoming);
  const ox = opts?.offsetX ?? 40;
  const oy = opts?.offsetY ?? 40;
  let next = normalizeDocument(base);
  const children: string[] = src.deltaSetLike?.ROOT?.children || [];
  const idMap = new Map<string, string>();
  children.forEach((oldId) => idMap.set(oldId, nanoid(10)));

  const prepared: Array<{ id: string; node: SceneNode }> = [];
  children.forEach((oldId) => {
    const raw = src.deltaSetLike?.[oldId];
    if (!raw) return;
    const node = cloneSceneValue(raw);
    const newId = idMap.get(oldId)!;
    node.id = newId;
    node.x = (Number(node.x) || 0) + ox;
    node.y = (Number(node.y) || 0) + oy;
    prepared.push({ id: newId, node });
  });
  if (prepared.length) {
    next = addNodesToDocument(next, prepared);
  }

  // Import artboard frames if present (offset too).
  if (Array.isArray(src.frames) && src.frames.length) {
    const frames = Array.isArray(next.frames) ? [...next.frames] : [];
    const order = Array.isArray(next.stackOrder) ? [...next.stackOrder] : [];
    src.frames.forEach((f) => {
      const newId = nanoid(8);
      frames.push({
        ...cloneSceneValue(f),
        id: newId,
        x: (Number(f.x) || 0) + ox,
        y: (Number(f.y) || 0) + oy,
      });
      order.push(stackFrameKey(newId));
    });
    next.frames = frames;
    next.stackOrder = order;
    if (!next.activeFrameId && frames[0]) next.activeFrameId = frames[0].id;
  }

  reconcileStackOrder(next);
  return next;
}

export function removeNodesFromDocument(
  doc: SceneDocument | null | undefined,
  nodeIds: string[]
) {
  const ids = Array.isArray(nodeIds) ? nodeIds.filter(Boolean).map(String) : [];
  if (!ids.length || !doc) return doc;
  const gone = new Set(ids);
  // O(N+M) COW — do not filter page.children once per deleted id (that was
  // O(deleted × children) and froze Ctrl+X / Delete at a few hundred nodes).
  const next: SceneDocument = {
    ...doc,
    deltaSetLike: { ...(doc.deltaSetLike || {}) },
    pages: Array.isArray(doc.pages)
      ? doc.pages.map((p) =>
          p && typeof p === 'object'
            ? {
                ...p,
                children: Array.isArray(p.children)
                  ? p.children.filter((id: string) => !gone.has(String(id)))
                  : p.children,
              }
            : p
        )
      : doc.pages,
    stackOrder: Array.isArray(doc.stackOrder) ? [...doc.stackOrder] : doc.stackOrder,
  };
  for (const id of gone) {
    delete next.deltaSetLike[id];
  }
  syncRootChildren(next);
  reconcileStackOrder(next);
  return next;
}

export function updateNodeInDocument(
  doc: SceneDocument | null | undefined,
  nodeId: string,
  patch: SceneNodePatch
) {
  const prev = doc?.deltaSetLike?.[nodeId];
  if (!prev || !doc) return doc;
  return produce(doc, (draft: WritableDraft<SceneDocument>) => {
    draft.deltaSetLike[nodeId] = mergeNodePatch(draft.deltaSetLike[nodeId], patch);
  });
}

/** Batch node patches in one Immer produce (align / distribute / multi-drag). */
export function updateNodesInDocument(
  doc: SceneDocument | null | undefined,
  patches: Array<{ nodeId: string; patch: SceneNodePatch }>
) {
  if (!doc || !Array.isArray(patches) || !patches.length) return doc;
  return produce(doc, (draft: WritableDraft<SceneDocument>) => {
    for (const item of patches) {
      const nodeId = item?.nodeId ? String(item.nodeId) : '';
      const patch = item?.patch;
      if (!nodeId || !patch || !draft.deltaSetLike?.[nodeId]) continue;
      draft.deltaSetLike[nodeId] = mergeNodePatch(draft.deltaSetLike[nodeId], patch);
    }
  });
}

export function listSceneNodes(doc: SceneDocument | null | undefined) {
  if (!doc) return [];
  // Read-only: never mutate Immer state here
  const page = getActivePage(doc);
  const ids = page?.children || doc.deltaSetLike?.ROOT?.children || [];
  return ids
    .map((id: string) => ({ id, node: doc.deltaSetLike?.[id] }))
    .filter((item): item is { id: string; node: SceneNode } => Boolean(item.node));
}

function reorderFrameChildrenInDocument(
  doc: SceneDocument,
  frameId: string,
  nodeIds: string[],
  action: 'front' | 'back' | 'forward' | 'backward'
) {
  const siblings = listRootNodeIds(doc).filter(
    (nodeId) => String(doc.deltaSetLike?.[nodeId]?.attrs?.frameId || '').trim() === frameId
  );
  const selected = nodeIds.filter((nodeId) => siblings.includes(nodeId));
  if (!selected.length) return;
  const reordered = reorderKeysInList(siblings, selected, action);
  reordered.forEach((nodeId, index) => {
    const node = doc.deltaSetLike?.[nodeId];
    if (!node) return;
    doc.deltaSetLike[nodeId] = {
      ...node,
      attrs: { ...(node.attrs || {}), frameId, frameOrder: index },
    };
  });
}

/** Reorder selected nodes in z-order, using each node's owning scope. */
export function reorderNodesInDocument(
  doc: SceneDocument,
  nodeIds: string[],
  action: 'front' | 'back' | 'forward' | 'backward'
) {
  const next = normalizeDocument(doc);
  const page = getActivePage(next);
  if (!page) return next;
  const ids = [...(page.children || [])];
  const selected = nodeIds.filter((id) => ids.includes(id));
  if (!selected.length) return next;

  const boundGroups = new Map<string, string[]>();
  const worldSelected: string[] = [];
  for (const nodeId of selected) {
    const frameId = String(next.deltaSetLike?.[nodeId]?.attrs?.frameId || '').trim();
    if (frameId) {
      const group = boundGroups.get(frameId) || [];
      group.push(nodeId);
      boundGroups.set(frameId, group);
      continue;
    }
    worldSelected.push(nodeId);
  }
  boundGroups.forEach((group, frameId) => {
    reorderFrameChildrenInDocument(next, frameId, group, action);
  });
  if (worldSelected.length) {
    page.children = reorderKeysInList(ids, worldSelected, action);
  }
  syncRootChildren(next);

  const selectedKeys = worldSelected.map(stackNodeKey);
  const stack = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
  if (selectedKeys.length) {
    next.stackOrder = reorderKeysInList(stack, selectedKeys, action);
  }
  reconcileStackOrder(next);
  return next;
}
