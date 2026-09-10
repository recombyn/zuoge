import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import { maxRadius, radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { parseNodeText, parseNodeTextStyle } from '@/components/rcb/scene/document/sceneText';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { parseFillGradient, parseFillType } from '@/components/rcb/scene/document/sceneFill';
import { frameIsEmpty } from './agentMemory';
/** Pick artboard for edit context: @ chip → last agent frame → active → sole frame. */
export function resolveDesignTargetFrame(
  doc: SceneDocument,
  chipFrameId?: string | null,
  lastAgentFrameId?: string | null
): { id: string; width: number; height: number; x: number; y: number; name?: string } | null {
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  if (!frames.length) return null;
  const pick = (id?: string | null) =>
    id ? frames.find((f) => f && f.id === id) || null : null;
  const frame =
    pick(chipFrameId) ||
    pick(lastAgentFrameId) ||
    pick(doc?.activeFrameId) ||
    (frames.length === 1 ? frames[0] : null);
  if (!frame?.id) return null;
  return {
    id: String(frame.id),
    width: Math.max(64, Math.round(Number(frame.width) || 390)),
    height: Math.max(64, Math.round(Number(frame.height) || 844)),
    x: Math.round(Number(frame.x) || 0),
    y: Math.round(Number(frame.y) || 0),
    name: frame.name ? String(frame.name) : undefined,
  };
}

/** Scene node ids that mostly overlap a frame — re-export for AgentDock / send path. */
export { nodeIdsInsideFrame } from '@/components/editor/panels/agent/designTools';

/** Frame that mostly contains a node, or null for free-canvas shapes. */
export function frameIdContainingNode(
  doc: SceneDocument,
  nodeId: string | null | undefined
): string | null {
  if (!doc || !nodeId) return null;
  const node = doc?.deltaSetLike?.[nodeId];
  if (!node) return null;
  const frameId = String(node.attrs?.frameId || '').trim();
  if (!frameId) return null;
  return nodeIdsBoundToFrames(doc, [frameId]).includes(nodeId) ? frameId : null;
}

export type SceneNodeInventoryItem = {
  id: string;
  type: string;
  frameId?: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Full snapshot for @ edits — model may change any field. */
  fill?: string;
  fillType?: string;
  stroke?: string;
  borderWidth?: number;
  /** center | inside | outside — selection chrome sits on mid of stroke band. */
  strokeAlign?: string;
  opacity?: number;
  rotation?: number;
  path?: string;
  closed?: boolean;
  text?: string;
  fontSize?: number;
  fontWeight?: string;
  fontFamily?: string;
  textAlign?: string;
  lineHeight?: number;
  cornerRadius?: number;
  radiusTL?: number;
  radiusTR?: number;
  radiusBR?: number;
  radiusBL?: number;
};

/** Prefer solid fills for inventory (text color + shape fill). */
function nodeFillForInventory(node: SceneNodeInput): string {
  const attrs = node?.attrs || {};
  const solid = attrs['fill-color'];
  const s = solid != null ? String(solid).trim() : '';
  if (s && s !== 'none' && s !== 'transparent') return s;
  const fillType = parseFillType(attrs['fill-type']);
  if (fillType === 'solid' || fillType === 'image' || attrs['fill-gradient'] == null) return '';
  const g = parseFillGradient(attrs['fill-gradient'], fillType, '#FFFFFF');
  const from = String(g.colorStops?.[0]?.color || '').trim();
  if (from && from !== 'none' && from !== 'transparent') return from;
  return '';
}

/** Inventory opacity is 0–100; attrs may store 0–1 or already percent. */
function sceneNodeOpacityPercent(opacityRaw: number): number {
  if (!Number.isFinite(opacityRaw)) return 100;
  if (opacityRaw > 1) return Math.min(100, opacityRaw);
  return Math.round(opacityRaw * 100);
}

/**
 * Parent artboard for tool_ops.
 * Prefer Host-opened / @-pinned board; free-canvas when none.
 */
export function resolveToolOpsFrameId(opts: {
  editInPlace: boolean;
  liveFrameId: string | null;
  targetFrameId: string | null | undefined;
  pinnedFrameId?: string | null;
}): string | null {
  const pinned = String(opts.pinnedFrameId || '').trim() || null;
  const target = String(opts.targetFrameId || '').trim() || null;
  return opts.liveFrameId || pinned || target || null;
}

/** Explicit @ / chip pin only — ambient focus must not swallow free-canvas creates. */
export function explicitPinnedFrameId(opts: {
  pinnedFrameId?: string | null;
}): string | null {
  return String(opts.pinnedFrameId || '').trim() || null;
}

/** Pull WxH from a create_frame op when Host size is still unknown. */
export function sizeFromCreateFrameOp(
  ops: Array<{ name?: string; args?: Record<string, unknown> }>
): { width: number; height: number } | null {
  for (const o of ops) {
    if (String(o?.name || '').trim() !== 'create_frame') continue;
    const args = o?.args && typeof o.args === 'object' ? o.args : {};
    const width = Math.round(Number(args.width) || 0);
    const height = Math.round(Number(args.height) || 0);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

/** Full node snapshot for SCENE_NODES (@ targets + edit inventory). No field filtering. */
function nodeToInventoryItem(
  doc: SceneDocument,
  id: string,
  node: SceneNodeInput,
  originX = 0,
  originY = 0,
  frameId?: string | null
): SceneNodeInventoryItem {
  const { left, top } = nodeLeftTop(doc, node);
  const attrs = node?.attrs || {};
  const key = String(node.key || '').toLowerCase();
  const shapeType = String(attrs.shapeType || key || 'shape').toLowerCase();
  const fill = nodeFillForInventory(node);
  const stroke = String(attrs['border-color'] ?? '').trim();
  const borderRaw = Number(attrs['border-width']);
  const strokeAlignRaw = String(attrs.strokeAlign || 'center')
    .trim()
    .toLowerCase();
  const strokeAlign =
    strokeAlignRaw === 'inside' || strokeAlignRaw === 'outside' || strokeAlignRaw === 'center'
      ? strokeAlignRaw
      : 'center';
  const opacityRaw = Number(attrs.opacity);
  const angleRaw = Number(attrs.angle);
  const path = String(attrs.path || '').trim();
  const fillType = String(attrs['fill-type'] || 'solid').trim() || 'solid';
  const w = Math.max(1, Math.round(Number(node.width) || 1));
  const h = Math.max(1, Math.round(Number(node.height) || 1));
  const item: SceneNodeInventoryItem = {
    id: String(id),
    type: key === 'text' ? 'text' : shapeType || key || 'shape',
    ...(frameId ? { frameId: String(frameId) } : {}),
    x: Math.round(left - originX),
    y: Math.round(top - originY),
    w,
    h,
    fill: fill || undefined,
    fillType,
    stroke: stroke && stroke !== 'transparent' && stroke !== 'none' ? stroke : undefined,
    borderWidth: Number.isFinite(borderRaw) && borderRaw >= 0 ? borderRaw : 0,
    strokeAlign,
    opacity: sceneNodeOpacityPercent(opacityRaw),
    rotation: Number.isFinite(angleRaw) ? Math.round(angleRaw * 100) / 100 : 0,
  };
  const name = attrs.name != null ? String(attrs.name).trim() : '';
  if (name) item.name = name;
  // Truncate huge outline paths in SCENE — full `d` blows context + clone cost.
  const SCENE_PATH_MAX = 480;
  if (path) {
    if (path.length > SCENE_PATH_MAX) {
      item.path = `${path.slice(0, SCENE_PATH_MAX)}…(/*${path.length} chars; use update_node path sparingly*/)`;
    } else {
      item.path = path;
    }
  }
  if (attrs.closed != null) {
    item.closed = attrs.closed === true || attrs.closed === 'true';
  }
  if (key === 'text') {
    const text = parseNodeText(attrs).trim();
    const style = parseNodeTextStyle(attrs);
    item.text = text.slice(0, 500);
    const fontSizeRaw = Number(style?.fontSize);
    if (Number.isFinite(fontSizeRaw) && fontSizeRaw > 0) item.fontSize = Math.round(fontSizeRaw);
    const lineHeightRaw = Number(style?.lineHeight);
    if (Number.isFinite(lineHeightRaw) && lineHeightRaw > 0) {
      item.lineHeight = Math.round(lineHeightRaw * 100) / 100;
    }
    if (style?.fontWeight) item.fontWeight = String(style.fontWeight);
    if (style?.fontFamily) item.fontFamily = String(style.fontFamily);
    if (style?.textAlign) item.textAlign = String(style.textAlign);
  } else {
    const radii = radiiFromAttrs(attrs);
    item.cornerRadius = Math.round(maxRadius(radii));
    item.radiusTL = Math.round(radii.tl);
    item.radiusTR = Math.round(radii.tr);
    item.radiusBR = Math.round(radii.br);
    item.radiusBL = Math.round(radii.bl);
  }
  return item;
}

/** World-space inventory for free-canvas @ targets (no artboard). */
export function buildSceneNodesForIds(
  doc: SceneDocument,
  nodeIds: string[]
): SceneNodeInventoryItem[] {
  if (!doc || !nodeIds.length) return [];
  const items: SceneNodeInventoryItem[] = [];
  for (const id of nodeIds) {
    const node = doc?.deltaSetLike?.[id];
    if (!node || !id) continue;
    items.push(nodeToInventoryItem(doc, id, node, 0, 0));
  }
  return items;
}

/** Frame-local node inventory for edit-in-place tool ops (full snapshot per node). */
export function buildSceneNodesForEdit(
  doc: SceneDocument,
  frameId: string | null | undefined,
  forceIds?: string[] | null
): SceneNodeInventoryItem[] {
  if (!doc || !frameId) return [];
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const frame = frames.find((f) => f?.id === frameId);
  if (!frame) return [];
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const forced = new Set(
    (forceIds || []).filter((id) => id && doc?.deltaSetLike?.[id]).map(String)
  );
  const idSet = new Set(nodeIdsBoundToFrames(doc, [frameId]));
  for (const id of forced) idSet.add(id);
  const items: SceneNodeInventoryItem[] = [];
  for (const id of idSet) {
    const node = doc?.deltaSetLike?.[id];
    if (!node) continue;
    items.push(nodeToInventoryItem(doc, id, node, fx, fy, frameId));
  }
  // Always keep @ / live forceIds; fill remaining slots with largest plates.
  const pinned = items.filter((n) => forced.has(n.id));
  const rest = items
    .filter((n) => !forced.has(n.id))
    .sort((a, b) => b.w * b.h - a.w * a.h);
  const room = Math.max(0, 60 - pinned.length);
  return [...pinned, ...rest.slice(0, room)];
}

/** All artboards + free-canvas nodes — what the agent actually "sees". */
export function buildSceneNodesForCanvas(
  doc: SceneDocument,
  opts?: {
    focusFrameId?: string | null;
    forceIds?: string[] | null;
    maxNodes?: number;
  }
): SceneNodeInventoryItem[] {
  if (!doc) return [];
  const maxNodes = Math.max(1, opts?.maxNodes ?? 120);
  const forced = new Set(
    (opts?.forceIds || []).filter((id) => id && doc?.deltaSetLike?.[id]).map(String)
  );
  const focus = String(opts?.focusFrameId || '').trim();
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  const ordered = [...frames].sort((a, b) => {
    const aid = String(a?.id || '');
    const bid = String(b?.id || '');
    if (aid === focus) return -1;
    if (bid === focus) return 1;
    return (Number(a?.x) || 0) - (Number(b?.x) || 0);
  });

  const byId = new Map<string, SceneNodeInventoryItem>();
  for (const frame of ordered) {
    const fid = frame?.id != null ? String(frame.id) : '';
    if (!fid) continue;
    for (const item of buildSceneNodesForEdit(doc, fid, [...forced])) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }

  const rootChildren: string[] = doc?.deltaSetLike?.ROOT?.children || [];
  for (const id of rootChildren) {
    const sid = String(id || '');
    if (!sid || byId.has(sid)) continue;
    if (frameIdContainingNode(doc, sid)) continue;
    const node = doc?.deltaSetLike?.[sid];
    if (!node) continue;
    byId.set(sid, nodeToInventoryItem(doc, sid, node, 0, 0));
  }

  const all = [...byId.values()];
  const pinned = all.filter((n) => forced.has(n.id));
  const rest = all
    .filter((n) => !forced.has(n.id))
    .sort((a, b) => {
      const af = a.frameId && a.frameId === focus ? 0 : 1;
      const bf = b.frameId && b.frameId === focus ? 0 : 1;
      if (af !== bf) return af - bf;
      return b.w * b.h - a.w * a.h;
    });
  const room = Math.max(0, maxNodes - pinned.length);
  return [...pinned, ...rest.slice(0, room)];
}

export type SceneFrameSnapshot = {
  id: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  is_empty: boolean;
};

/** Artboard list for SCENE_FRAMES — sent with every agent turn. */
export function buildSceneFramesSnapshot(doc: SceneDocument): SceneFrameSnapshot[] {
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  return frames.slice(0, 32).map((f) => {
    const id = String(f.id);
    return {
      id,
      name: f.name ? String(f.name) : undefined,
      x: Math.round(Number(f.x) || 0),
      y: Math.round(Number(f.y) || 0),
      w: Math.round(Number(f.width) || 0),
      h: Math.round(Number(f.height) || 0),
      is_empty: frameIsEmpty(doc, id),
    };
  });
}

export type SpatialBox = { x: number; y: number; w: number; h: number };

export type SpatialSummary = {
  focus_frame_id: string | null;
  gap_px: number;
  /** Frame-local boxes for create_* inside the focus artboard. */
  focused: Array<{
    id: string;
    type: string;
    name?: string;
    text?: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }>;
  /** World-space other artboards. */
  peripheral: Array<{
    id: string;
    name?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    child_count: number;
    is_empty: boolean;
  }>;
  overlaps: Array<{ a: string; b: string; iou: number }>;
  /** Frame-local empty slots — intentionally unused (no invented WxH suggestions). */
  empty_rects: SpatialBox[];
  /** World-space slots for create_frame (same size as focus plate). */
  new_frame_slots: SpatialBox[];
  /** Not set — host must not invent place WxH for the model. */
  suggested_place?: SpatialBox;
  /** Raw camera viewport in world coords (sensor only). */
  viewport?: SpatialBox;
};

const SPATIAL_GAP = 40;
const SPATIAL_FOCUSED_MAX = 36;

function _boxIou(a: SpatialBox, b: SpatialBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const iw = Math.max(0, x2 - x1);
  const ih = Math.max(0, y2 - y1);
  const inter = iw * ih;
  if (inter <= 0) return 0;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

function _boxesOverlap(a: SpatialBox, b: SpatialBox, gap = 0): boolean {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

/** Map-like summary for the agent (focused / peripheral / empty slots). */
export function buildSpatialSummary(
  doc: SceneDocument,
  opts?: {
    focusFrameId?: string | null;
    maxFocused?: number;
    /** Raw camera viewport — report only; do not invent placement on the client. */
    viewport?: SpatialBox | null;
  }
): SpatialSummary {
  const gap = SPATIAL_GAP;
  const frames = buildSceneFramesSnapshot(doc);
  const focus =
    String(opts?.focusFrameId || '').trim() ||
    (frames.find((f) => !f.is_empty)?.id ?? frames[0]?.id ?? '') ||
    null;
  const maxFocused = Math.max(8, opts?.maxFocused ?? SPATIAL_FOCUSED_MAX);

  const focusFrame = focus ? frames.find((f) => f.id === focus) : undefined;
  const fw = Math.max(1, focusFrame?.w || 1280);
  const fh = Math.max(1, focusFrame?.h || 720);
  // Pass-through camera AABB only (no client-side "where to put" logic).
  const viewport = opts?.viewport && opts.viewport.w > 8 && opts.viewport.h > 8
    ? {
        x: Math.round(opts.viewport.x),
        y: Math.round(opts.viewport.y),
        w: Math.round(opts.viewport.w),
        h: Math.round(opts.viewport.h),
      }
    : undefined;

  const inventory = buildSceneNodesForCanvas(doc, {
    focusFrameId: focus,
    maxNodes: 120,
  });
  const inFocus = inventory
    .filter((n) => (focus ? n.frameId === focus : !n.frameId))
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, maxFocused)
    .map((n) => ({
      id: n.id,
      type: n.type,
      ...(n.name ? { name: n.name } : {}),
      ...(n.text ? { text: String(n.text).slice(0, 80) } : {}),
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
    }));

  const peripheral = frames
    .filter((f) => f.id !== focus)
    .slice(0, 16)
    .map((f) => ({
      id: f.id,
      ...(f.name ? { name: f.name } : {}),
      x: f.x,
      y: f.y,
      w: f.w,
      h: f.h,
      child_count: inventory.filter((n) => n.frameId === f.id).length,
      is_empty: f.is_empty,
    }));

  const overlaps: SpatialSummary['overlaps'] = [];
  for (let i = 0; i < inFocus.length; i++) {
    for (let j = i + 1; j < inFocus.length; j++) {
      const a = inFocus[i];
      const b = inFocus[j];
      const iou = _boxIou(a, b);
      if (iou >= 0.08) overlaps.push({ a: a.id, b: b.id, iou: Math.round(iou * 100) / 100 });
    }
  }
  overlaps.sort((a, b) => b.iou - a.iou);

  // Do NOT invent empty_rects / suggested_place with stock 320×200 (etc.).
  // Those slots leaked into PLACEMENT and models copied them as create_frame size.
  const new_frame_slots: SpatialBox[] = [];
  if (frames.length) {
    let worldR = 0;
    let worldB = 0;
    for (const f of frames) {
      worldR = Math.max(worldR, f.x + f.w);
      worldB = Math.max(worldB, f.y + f.h);
    }
    new_frame_slots.push({
      x: Math.round(worldR + gap),
      y: Math.round(frames[0]?.y || 0),
      w: Math.round(fw),
      h: Math.round(fh),
    });
    new_frame_slots.push({
      x: Math.round(frames[0]?.x || 0),
      y: Math.round(worldB + gap),
      w: Math.round(fw),
      h: Math.round(fh),
    });
  }

  return {
    focus_frame_id: focus,
    gap_px: gap,
    focused: inFocus,
    peripheral,
    overlaps: overlaps.slice(0, 12),
    empty_rects: [],
    new_frame_slots,
    // viewport is raw camera AABB only (no invented place slots).
    ...(viewport ? { viewport } : {}),
  };
}

/**
 * Cheap layout schematic of the focus artboard → JPEG data URL for vision.
 * Not a photoreal export — colored boxes so the model sees denseness / stacking.
 */
