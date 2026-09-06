import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Scene pick / hit-test domain — shared by SvgCanvas and bridge consumers
 * (e.g. FrameMoveFeature via setSceneHitTestBridge).
 *
 * Spatial candidate order stays in SceneSpatialRuntime (SoaQuadtree broad-phase);
 * this module owns per-node ink tests (Path2D / AABB; optional SVG DOM behind allowSvgDomHit).
 */

import { getShapeBaselineD } from '@/components/rcb/core/geometry';
import {
  deflateSelectionBox,
  inflateBoxByVisualOutset,
  resolveStroke,
  resolveStrokeAlign,
} from '@/components/rcb/scene/document/sceneEffects';
import {
  isAnimationFrameHostNode,
  isArtboardVisibleInDocument,
  isNodeHiddenInDocument,
  isNodePickableInDocument,
  supportsFill,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import { getLiveArtboardFrameGeometry } from '@/components/rcb/frames/HtmlArtboardFrame';
import { frameSceneBounds, nodeLeftTop } from '@/components/rcb/scene/paint/sceneToSvg';
import {
  nodePaintZIndex,
  parseStackKey,
  selectionPaintZIndex,
  stackZIndex,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  selectionPaintRaises,
  selectionPaintRaisesFrame,
} from '@/components/rcb/selection/selectionPaintRaise';
import {
  HEAVY_PATH_D_CHARS,
  distPointToPathD,
  distPointToSegment,
  hitTestPath2DLocal,
  hitTestSvgNodeAtClient,
  pathDContainsPoint,
  rememberNodePath2D,
  sceneHitSlop,
  strokeEndpointsFromBox,
} from '@/components/rcb/scene/document/sceneShapes';
import {
  hitTestSoaSlot,
  SOA_KIND_LINE,
  SOA_KIND_PATH,
  SOA_KIND_POLY,
  type SceneRenderBuffer,
} from '@/components/rcb/render/sceneRenderBuffer';

export type SceneHitFn = (
  x: number,
  y: number,
  screen?: { clientX: number; clientY: number }
) => string | null;

export type ViewportToolPointerHandlers = {
  onDown?: (e: PointerEvent) => void;
  onMove?: (e: PointerEvent) => void;
  onUp?: (e: PointerEvent) => void;
  onLeave?: (e: PointerEvent) => void;
  onDblClick?: (e: PointerEvent) => void;
};

/**
 * Shared tool pointer binder (ADR 0027 appendix A).
 * Stage capture is the authority. Window capture is a **outside-stage relay**
 * only (skips events already handled on `hitEl`) so pe:auto layers above the
 * stage cannot starve tip/drag — do not add per-feature window listeners.
 */
export function attachViewportToolPointers(
  hitEl: HTMLElement,
  handlers: ViewportToolPointerHandlers
): () => void {
  const { onDown, onMove, onUp, onLeave, onDblClick } = handlers;

  function targetOutsideHit(e: Event): boolean {
    const t = e.target;
    if (!(t instanceof Node)) return true;
    return !hitEl.contains(t);
  }

  function onWindowMove(e: PointerEvent) {
    if (!onMove || !targetOutsideHit(e)) return;
    onMove(e);
  }

  function onWindowUp(e: PointerEvent) {
    if (!onUp) return;
    // pointercancel may target hitEl while capture is held — still finish.
    if (e.type !== 'pointercancel' && !targetOutsideHit(e)) return;
    onUp(e);
  }

  if (onDown) hitEl.addEventListener('pointerdown', onDown, true);
  if (onMove) {
    hitEl.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointermove', onWindowMove, true);
  }
  if (onUp) {
    hitEl.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointerup', onWindowUp, true);
    window.addEventListener('pointercancel', onWindowUp, true);
  }
  if (onLeave) hitEl.addEventListener('pointerleave', onLeave);
  if (onDblClick) hitEl.addEventListener('dblclick', onDblClick, true);
  return () => {
    if (onDown) hitEl.removeEventListener('pointerdown', onDown, true);
    if (onMove) {
      hitEl.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointermove', onWindowMove, true);
    }
    if (onUp) {
      hitEl.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointerup', onWindowUp, true);
      window.removeEventListener('pointercancel', onWindowUp, true);
    }
    if (onLeave) hitEl.removeEventListener('pointerleave', onLeave);
    if (onDblClick) hitEl.removeEventListener('dblclick', onDblClick, true);
  };
}

export type SceneHitBox = { left: number; top: number; width: number; height: number };

export type HitTestSceneAtPointOpts = {
  document: SceneDocument;
  /** Top→bottom candidate ids (from SceneSpatialRuntime.hitCandidateIds). */
  order: readonly string[];
  x: number;
  y: number;
  zoom: number;
  screen?: { clientX: number; clientY: number };
  getNodeBox: (nodeId: string) => SceneHitBox | null;
  /**
   * Live SVG hosts for DOM isPointInFill/Stroke.
   * Only used when {@link allowSvgDomHit} is true (default off — ADR 0027).
   */
  nodeEls?: Map<string, Element> | null;
  /**
   * When true, path-like hits may fall back to SVG DOM under the cursor.
   * Default false: Path2D / AABB only (no live DOM lattice).
   */
  allowSvgDomHit?: boolean;
  /** When set, canvas-idle slots are tested in z-order alongside SVG/scene hits. */
  soaBuf?: SceneRenderBuffer | null;
  /** Override sceneHitSlop — keep in sync with spatial broad-phase pad. */
  pad?: number;
};

let hitFn: SceneHitFn | null = null;

export function setSceneHitTestBridge(fn: SceneHitFn | null) {
  if (!fn) {
    hitFn = null;
    if (typeof window !== 'undefined') {
      (window as unknown as { __rcbBridgeHitTest?: SceneHitFn | null }).__rcbBridgeHitTest = null;
    }
    return;
  }
  hitFn = (x, y, screen) => {
    const result = fn(x, y, screen);
    if (typeof window !== 'undefined' && import.meta.env.DEV) {
      (window as unknown as { __rcbBridgeWrap?: unknown }).__rcbBridgeWrap = {
        x,
        y,
        result,
        hasTrace: Boolean(
          (window as unknown as { __rcbHitTrace?: unknown }).__rcbHitTrace
        ),
        t: Date.now(),
      };
    }
    return result;
  };
  if (typeof window !== 'undefined') {
    (window as unknown as { __rcbBridgeHitTest?: SceneHitFn | null }).__rcbBridgeHitTest = hitFn;
  }
}

/**
 * Near-full-bleed artboard background (rect / closed path / image).
 * Not pickable as content — click should reach nested nodes or the frame plate.
 */
export function frameForFullBleedPlate(doc: SceneDocument, nodeId: string): string | null {
  const node = doc?.deltaSetLike?.[nodeId];
  if (!node) return null;
  const key = String(node.key || '');
  if (key === 'shape') {
    const shapeType = String(node.attrs?.shapeType || 'rect');
    // Open strokes are not plates.
    if (shapeType === 'line' || shapeType === 'arrow' || shapeType === 'pencil') return null;
    if (shapeType === 'pen' || shapeType === 'path') {
      const closed = node.attrs?.closed;
      if (closed === false || closed === 'false' || closed === 0 || closed === '0') return null;
    }
  } else if (key !== 'image' && key !== 'rect') {
    return null;
  }
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  if (!frames.length) return null;
  const { left, top } = nodeLeftTop(doc, node);
  const w = Math.max(1, Number(node.width) || 1);
  const h = Math.max(1, Number(node.height) || 1);
  const area = w * h;
  // Prefer the frame this node is bound to, then any overlapping artboard.
  const boundId = String(node.attrs?.frameId || '').trim();
  const ordered = boundId
    ? [
        ...frames.filter((f) => String(f?.id) === boundId),
        ...frames.filter((f) => String(f?.id) !== boundId),
      ]
    : frames;
  for (const f of ordered) {
    if (!f?.id) continue;
    const fx = Number(f.x) || 0;
    const fy = Number(f.y) || 0;
    const fw = Math.max(1, Number(f.width) || 1);
    const fh = Math.max(1, Number(f.height) || 1);
    const frameArea = fw * fh;
    const ow = Math.max(0, Math.min(left + w, fx + fw) - Math.max(left, fx));
    const oh = Math.max(0, Math.min(top + h, fy + fh) - Math.max(top, fy));
    const overlap = ow * oh;
    if (overlap >= frameArea * 0.9 && area >= frameArea * 0.85) {
      return String(f.id);
    }
  }
  return null;
}

export function hitTestSceneAtPoint(opts: HitTestSceneAtPointOpts): string | null {
  const {
    document: doc,
    order,
    x,
    y,
    zoom,
    screen,
    getNodeBox,
    nodeEls,
    allowSvgDomHit = false,
    soaBuf = null,
  } = opts;
  const pad =
    opts.pad != null && Number.isFinite(opts.pad)
      ? Math.max(0, Number(opts.pad))
      : sceneHitSlop(Math.max(0.05, zoom || 1));
  for (const id of order) {
    const node = doc?.deltaSetLike?.[id];
    if (!node || isNodeHiddenInDocument(doc, node)) {
      continue;
    }
    // 动画工作台 invisible host is plate chrome — never steal picks from nested
    // Lottie / shape children underneath the full-bleed plate.
    if (isAnimationFrameHostNode(node, doc)) {
      continue;
    }
    // Full-bleed image/rect backgrounds must not block picks of content underneath.
    if (frameForFullBleedPlate(doc, id)) {
      continue;
    }
    // Hidden / preview-only / playhead trim — not pickable.
    if (!isNodePickableInDocument(doc, node)) {
      continue;
    }
    if (!isNodePickableAtPoint(doc, node, x, y)) {
      continue;
    }
    const soaIndex = soaBuf?.indexById.get(id);
    const kind = soaIndex != null && soaIndex >= 0 ? soaBuf!.kinds[soaIndex] : -1;
    const strokeSoa =
      kind === SOA_KIND_PATH || kind === SOA_KIND_LINE || kind === SOA_KIND_POLY;
    // Stroke polylines stay pickable after selection paint-raise clears CANVAS_IDLE
    // (host promote). Fill shapes still require idle ink.
    if (
      soaIndex != null &&
      soaIndex >= 0 &&
      hitTestSoaSlot(soaBuf!, soaIndex, x, y, {
        requireCanvasIdle: !strokeSoa,
      })
    ) {
      return id;
    }
    // Stroke SoA miss → Path2D / geo / AABB below. Do not skip fallthrough for
    // idle slots that merely carry a path attr — atlas/rich fills need Path2D.
    const box = getNodeBox(id);
    if (!box) {
      continue;
    }
    const hit = hitTestSceneNodeAt({
      id,
      node,
      box,
      x,
      y,
      zoom,
      pad,
      screen,
      svgEl: allowSvgDomHit ? (nodeEls?.get(id) ?? null) : null,
      allowSvgDomHit,
    });
    if (hit) {
      return id;
    }
  }
  return null;
}

export type SceneStackHitKind = 'node' | 'frame';

/** Ideal hit result: first precise stack entry under the pointer. */
export type SceneStackHit = { kind: SceneStackHitKind; id: string };

/**
 * Unified stack walk (ideal contract): candidates already sorted top→bottom by
 * permanent stackOrder. Frame keys are `frame:id`; first plate AABB or node ink
 * hit wins.
 */
export function hitTestUnifiedStackAtPoint(
  opts: HitTestSceneAtPointOpts
): SceneStackHit | null {
  const { document: doc, order, x, y } = opts;
  for (const raw of order) {
    const key = String(raw || '');
    if (!key) continue;
    const parsed = parseStackKey(key);
    if (parsed?.kind === 'frame') {
      const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
        (f) => String(f?.id || '') === parsed.id
      );
      if (!frame || frame.locked || !isArtboardVisibleInDocument(frame)) continue;
      const live = getLiveArtboardFrameGeometry(parsed.id);
      const box = frameSceneBounds(doc, frame, live);
      if (pointInSceneBox(x, y, box)) {
        return { kind: 'frame', id: parsed.id };
      }
      continue;
    }
    const nodeHit = hitTestSceneAtPoint({ ...opts, order: [key] });
    if (nodeHit) return { kind: 'node', id: nodeHit };
  }
  return null;
}

function pointInSceneBox(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number }
): boolean {
  return (
    x >= box.left &&
    x <= box.left + box.width &&
    y >= box.top &&
    y <= box.top + box.height
  );
}

/** Frame ids top→bottom by stackOrder; frames missing from stack append in array order. */
function rankedFrameIdsTopFirst(doc: SceneDocument): string[] {
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frames.length) return [];
  const byId = new Map(frames.map((f) => [String(f?.id || ''), f]));
  const order = Array.isArray(doc.stackOrder) ? doc.stackOrder : [];
  const ranked: string[] = [];
  const seen = new Set<string>();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const parsed = parseStackKey(String(order[i] || ''));
    if (!parsed || parsed.kind !== 'frame') continue;
    if (!byId.has(parsed.id) || seen.has(parsed.id)) continue;
    seen.add(parsed.id);
    ranked.push(parsed.id);
  }
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const id = String(frames[i]?.id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ranked.push(id);
  }
  return ranked;
}

/** Topmost artboard under a scene point — ordered by stackOrder, not frames[]. */
export function frameIdAtPoint(
  doc: SceneDocument | null | undefined,
  x: number,
  y: number
): string | null {
  if (!doc) return null;
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frames.length) return null;
  const byId = new Map(frames.map((f) => [String(f?.id || ''), f]));
  for (const id of rankedFrameIdsTopFirst(doc)) {
    const frame = byId.get(id);
    if (!frame || frame.locked || !isArtboardVisibleInDocument(frame)) continue;
    const live = getLiveArtboardFrameGeometry(id);
    const box = frameSceneBounds(doc, frame, live);
    if (pointInSceneBox(x, y, box)) return id;
  }
  return null;
}

function effectiveNodeStackZ(doc: SceneDocument, nodeId: string): number {
  return nodePaintZIndex(doc, nodeId, selectionPaintRaises(nodeId));
}

function effectiveFrameStackZ(
  doc: SceneDocument,
  frameId: string,
  raiseFrameIds?: ReadonlySet<string> | null
): number {
  if (raiseFrameIds?.has(frameId) || selectionPaintRaisesFrame(frameId)) {
    return selectionPaintZIndex(doc, 'frame', frameId, true);
  }
  return stackZIndex(doc, 'frame', frameId);
}

/**
 * True when a higher artboard plate covers (x,y) above this node's **paint** z
 * (empty world generators sit above plates via `nodePaintZIndex`; selection
 * raise stays paint-only and is ignored here so hit matches idle visibility).
 */
export function isOccludedByHigherArtboard(
  doc: SceneDocument,
  node: SceneNode,
  x: number,
  y: number
): boolean {
  const nodeId = String(node.id || '');
  if (!nodeId) return false;
  const ownerId = String(node.attrs?.frameId || '').trim();
  // Idle paint z only — selection max+1 must not change pick occlusion.
  const nodeZ = nodePaintZIndex(doc, nodeId, false);
  if (nodeZ <= 0) return false;
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  for (const frame of frames) {
    const fid = String(frame?.id || '');
    if (!fid || frame.locked || !isArtboardVisibleInDocument(frame)) continue;
    if (ownerId && ownerId === fid) continue;
    if (stackZIndex(doc, 'frame', fid) <= nodeZ) continue;
    const live = getLiveArtboardFrameGeometry(fid);
    const box = frameSceneBounds(doc, frame, live);
    if (pointInSceneBox(x, y, box)) return true;
  }
  return false;
}

export type SceneOccluderBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Higher opaque artboard plates that cover this node in stackOrder.
 * Used for hit-testing and skipping fully covered SoA ink under plates.
 */
export function listHigherArtboardOccluderBoxes(
  doc: SceneDocument | null | undefined,
  node: SceneNode | SceneNodeInput | null | undefined,
  opts?: { raiseFrameIds?: Iterable<string> | null }
): SceneOccluderBox[] {
  if (!doc || !node) return [];
  const nodeId = String(node.id || '').trim();
  if (!nodeId) return [];
  // Bound children paint above their own plate only — still occlude under
  // any later / selection-raised artboard (same rule as hit testing).
  const ownerId = String(node.attrs?.frameId || '').trim();
  const nodeZ = effectiveNodeStackZ(doc, nodeId);
  if (nodeZ <= 0) return [];
  let raiseFrameIds: ReadonlySet<string> | null = null;
  if (opts?.raiseFrameIds) {
    const next = new Set<string>();
    for (const id of opts.raiseFrameIds) {
      const s = String(id || '').trim();
      if (s) next.add(s);
    }
    raiseFrameIds = next.size ? next : null;
  }
  const out: SceneOccluderBox[] = [];
  for (const frame of doc.frames || []) {
    const fid = String(frame?.id || '');
    if (!fid || frame.locked || !isArtboardVisibleInDocument(frame)) continue;
    if (ownerId && ownerId === fid) continue;
    if (effectiveFrameStackZ(doc, fid, raiseFrameIds) <= nodeZ) continue;
    const live = getLiveArtboardFrameGeometry(fid);
    const box = frameSceneBounds(doc, frame, live);
    const left = Number(box.left) || 0;
    const top = Number(box.top) || 0;
    const width = Math.max(1, Number(box.width) || 1);
    const height = Math.max(1, Number(box.height) || 1);
    out.push({ left, top, right: left + width, bottom: top + height });
  }
  return out;
}

export function intersectSceneOccluderBoxes(
  a: SceneOccluderBox,
  b: SceneOccluderBox
): SceneOccluderBox | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return { left, top, right, bottom };
}

/** Subject minus one hole → up to four residual rects. */
function subtractOneOccluderBox(a: SceneOccluderBox, hole: SceneOccluderBox): SceneOccluderBox[] {
  const hit = intersectSceneOccluderBoxes(a, hole);
  if (!hit) return [a];
  const out: SceneOccluderBox[] = [];
  if (a.top < hit.top) {
    out.push({ left: a.left, top: a.top, right: a.right, bottom: hit.top });
  }
  if (hit.bottom < a.bottom) {
    out.push({ left: a.left, top: hit.bottom, right: a.right, bottom: a.bottom });
  }
  if (a.left < hit.left) {
    out.push({ left: a.left, top: hit.top, right: hit.left, bottom: hit.bottom });
  }
  if (hit.right < a.right) {
    out.push({ left: hit.right, top: hit.top, right: a.right, bottom: hit.bottom });
  }
  return out.filter((r) => r.right > r.left && r.bottom > r.top);
}

/** Clip subject to the complement of opaque higher artboards (paint/hit parity). */
export function subtractHigherArtboardOccluders(
  subject: SceneOccluderBox,
  holes: readonly SceneOccluderBox[]
): SceneOccluderBox[] {
  if (!holes.length) return [subject];
  let parts = [subject];
  for (const hole of holes) {
    const next: SceneOccluderBox[] = [];
    for (const part of parts) next.push(...subtractOneOccluderBox(part, hole));
    parts = next;
    if (!parts.length) break;
  }
  return parts;
}

/** True when the node's AABB lies fully under a higher artboard plate. */
export function isNodeAabbFullyOccludedByHigherArtboard(
  doc: SceneDocument | null | undefined,
  node: SceneNode | SceneNodeInput | null | undefined,
  box?: { left?: number; top?: number; x?: number; y?: number; width?: number; height?: number }
): boolean {
  const holes = listHigherArtboardOccluderBoxes(doc, node);
  if (!holes.length || !node) return false;
  const left = Number(box?.left ?? box?.x ?? node.x) || 0;
  const top = Number(box?.top ?? box?.y ?? node.y) || 0;
  const width = Math.max(1, Number(box?.width ?? node.width) || 1);
  const height = Math.max(1, Number(box?.height ?? node.height) || 1);
  const subject: SceneOccluderBox = {
    left,
    top,
    right: left + width,
    bottom: top + height,
  };
  return subtractHigherArtboardOccluders(subject, holes).length === 0;
}

/**
 * Bound nodes only pick inside their owning artboard.
 * Unowned filled ink over a clipContent artboard is pickable only inside that
 * plate (AABB overhang is treated as clipped for pick).
 * Open strokes (pen / pencil / path / line / arrow) skip that gate — their AABB
 * often grazes a nearby plate while the ink sits in world space (marquee worked,
 * point pick did not).
 */
export function isNodePickableAtPoint(
  doc: SceneDocument,
  node: SceneNode,
  x: number,
  y: number
): boolean {
  if (isOccludedByHigherArtboard(doc, node, x, y)) return false;
  const ownerId = String(node.attrs?.frameId || '').trim();
  if (ownerId) return frameIdAtPoint(doc, x, y) === ownerId;
  return isPointVisibleForFrameClip(doc, node, x, y);
}

function isOpenStrokeShape(node: SceneNodeInput | null | undefined): boolean {
  const t = String(node?.attrs?.shapeType || node?.key || '').toLowerCase();
  return t === 'pen' || t === 'pencil' || t === 'path' || t === 'line' || t === 'arrow';
}

function frameRect(frame: { x?: unknown; y?: unknown; width?: unknown; height?: unknown }) {
  const left = Number(frame.x) || 0;
  const top = Number(frame.y) || 0;
  const width = Math.max(1, Number(frame.width) || 1);
  const height = Math.max(1, Number(frame.height) || 1);
  return { left, top, right: left + width, bottom: top + height, width, height };
}

function rectsOverlap(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function pointInRect(
  x: number,
  y: number,
  r: { left: number; top: number; right: number; bottom: number }
) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function isPointVisibleForFrameClip(doc: SceneDocument, node: SceneNode, x: number, y: number) {
  // Only called for unbound nodes (owned nodes use frameIdAtPoint above) —
  // their x/y are already world, including under frameLocal.
  const nodeRect = frameRect(node);
  // Freehand / open strokes: don't require the click to land inside a plate the
  // stroke AABB merely grazes (line/arrow already rarely hit this; pens do).
  if (isOpenStrokeShape(node)) return true;
  const clipping = (doc.frames || []).filter((frame) => {
    if (frame?.clipContent === false || isAnimationArtboardKind(frame.kind)) return false;
    return rectsOverlap(nodeRect, frameRect(frame));
  });
  if (!clipping.length) return true;
  return clipping.some((frame) => pointInRect(x, y, frameRect(frame)));
}

function toNodeLocal(
  x: number,
  y: number,
  originLeft: number,
  originTop: number,
  width: number,
  height: number,
  angle: number
): { lx: number; ly: number } {
  let lx = x - originLeft;
  let ly = y - originTop;
  if (Math.abs(angle) > 0.5) {
    const cx = width / 2;
    const cy = height / 2;
    const rad = (-angle * Math.PI) / 180;
    const dx = lx - cx;
    const dy = ly - cy;
    lx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
    ly = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
  }
  return { lx, ly };
}

function hitsRotatedAabb(
  x: number,
  y: number,
  box: SceneHitBox,
  angle: number,
  pad: number
): boolean {
  if (Math.abs(angle) > 0.5) {
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const rad = (-angle * Math.PI) / 180;
    const dx = x - cx;
    const dy = y - cy;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(lx) <= box.width / 2 + pad && Math.abs(ly) <= box.height / 2 + pad;
  }
  return (
    x >= box.left - pad &&
    x <= box.left + box.width + pad &&
    y >= box.top - pad &&
    y <= box.top + box.height + pad
  );
}

function isGeoShapeNode(node: SceneNodeInput, shapeType: string): boolean {
  const key = String(node.key || '');
  return (
    key === 'shape' ||
    key === 'rect' ||
    key === 'ellipse' ||
    shapeType === 'rect' ||
    shapeType === 'roundRect' ||
    shapeType === 'circle' ||
    shapeType === 'triangle' ||
    shapeType === 'star' ||
    shapeType === 'polygon'
  );
}

/** Non-rectangular geo / custom path — AABB fill steals empty frame clicks (L-hole). */
function shapeRequiresPrecisePathHit(shapeType: string, node: SceneNodeInput): boolean {
  if (
    shapeType === 'triangle' ||
    shapeType === 'star' ||
    shapeType === 'polygon' ||
    shapeType === 'pen' ||
    shapeType === 'pencil' ||
    shapeType === 'path' ||
    shapeType === 'line' ||
    shapeType === 'arrow'
  ) {
    return true;
  }
  const d = String(node.attrs?.path || '').trim();
  return Boolean(d);
}

function hitTestLineOrArrow(opts: {
  id: string;
  node: SceneNodeInput;
  box: SceneHitBox;
  x: number;
  y: number;
  pad: number;
}): boolean {
  const { id, node, box, x, y, pad } = opts;
  const angle = Number(node.attrs?.angle) || 0;
  const geom = deflateSelectionBox(box, node);
  const d = getShapeBaselineD(node, {
    width: Math.max(1, geom.width),
    height: Math.max(1, geom.height),
  });
  if (d) {
    const { lx, ly } = toNodeLocal(x, y, geom.left, geom.top, geom.width, geom.height, angle);
    const { strokeWidth: sw } = resolveStroke(node, '#333333');
    const hitW = Math.max(sw > 0 ? sw : 2, 0) + pad * 2;
    rememberNodePath2D(id, d);
    if (
      hitTestPath2DLocal(d, lx, ly, {
        strokeWidth: hitW,
        lineCap: 'round',
        lineJoin: 'round',
      })
    ) {
      return true;
    }
  }
  const ep = strokeEndpointsFromBox(geom, angle);
  return distPointToSegment(x, y, ep.x0, ep.y0, ep.x1, ep.y1) <= Math.max(pad, 4);
}

function hitTestPathLike(opts: {
  id: string;
  node: SceneNodeInput;
  shapeType: string;
  box: SceneHitBox;
  x: number;
  y: number;
  zoom: number;
  screen?: { clientX: number; clientY: number };
  svgEl?: Element | null;
  allowSvgDomHit?: boolean;
}): boolean {
  const { id, node, shapeType, box, x, y, zoom, screen, svgEl, allowSvgDomHit } = opts;
  const sw = Math.max(
    1,
    Number(node.attrs?.['border-width'] ?? 2) || 2
  );
  const pathPad = sw / 2 + sceneHitSlop(zoom, 10);
  // Pencil ink is a closed filled silhouette; supportsFill is false (stroke panel)
  // but pick must use fill against attrs.path, not only the outline edge.
  const fillHit = supportsFill(node) || shapeType === 'pencil';
  // Selection chrome box may be inflated — path `d` is stored in geom-local space.
  const geom = deflateSelectionBox(box, node);
  const inLooseBox =
    x >= geom.left - pathPad &&
    x <= geom.left + geom.width + pathPad &&
    y >= geom.top - pathPad &&
    y <= geom.top + geom.height + pathPad;
  if (!inLooseBox) return false;

  const d = String(node.attrs?.path || '');
  const heavyPath = d.length >= HEAVY_PATH_D_CHARS;
  const angle = Number(node.attrs?.angle) || 0;
  const { lx, ly } = toNodeLocal(x, y, geom.left, geom.top, geom.width, geom.height, angle);

  if (!heavyPath && d) {
    rememberNodePath2D(id, d);
    const hitW = sw + pathPad * 2;
    if (
      hitTestPath2DLocal(d, lx, ly, {
        fill: fillHit,
        strokeWidth: hitW,
        fillRule:
          String(node.attrs?.['fill-rule'] || 'nonzero') === 'evenodd' ? 'evenodd' : 'nonzero',
        lineCap: 'round',
        lineJoin: 'round',
      })
    ) {
      return true;
    }
  }

  // Optional SVG DOM lattice — off by default (ADR 0027 independent hit).
  if (allowSvgDomHit && svgEl && screen) {
    const mode = shapeType === 'pencil' || fillHit ? 'auto' : 'stroke';
    const hitW = sw + pathPad * 2;
    if (
      hitTestSvgNodeAtClient(svgEl, screen.clientX, screen.clientY, {
        mode,
        strokeHitWidth: hitW,
      })
    ) {
      return true;
    }
    if (heavyPath) return false;
  }

  if (heavyPath) {
    return Boolean(fillHit && lx >= 0 && ly >= 0 && lx <= geom.width && ly <= geom.height);
  }
  if (fillHit) {
    const rule = String(node.attrs?.['fill-rule'] || 'nonzero');
    if (pathDContainsPoint(lx, ly, d, rule)) return true;
  }
  return distPointToPathD(lx, ly, d) <= pathPad;
}

function hitTestGeoShape(opts: {
  id: string;
  node: SceneNodeInput;
  box: SceneHitBox;
  x: number;
  y: number;
  pad: number;
}): boolean {
  const { id, node, box, x, y, pad } = opts;
  const geom = deflateSelectionBox(box, node);
  const gw = Math.max(1, geom.width);
  const gh = Math.max(1, geom.height);
  const d = getShapeBaselineD(node, { width: gw, height: gh });
  const angle = Number(node.attrs?.angle) || 0;
  const shapeType = String(node.attrs?.shapeType || '');
  if (d) {
    const { lx, ly } = toNodeLocal(x, y, geom.left, geom.top, gw, gh, angle);
    const { stroke, strokeWidth: sw } = resolveStroke(node, '#333333');
    const align = resolveStrokeAlign(node.attrs);
    let strokeHit = 0;
    if (stroke && stroke !== 'transparent' && sw > 0) {
      const base = align === 'outside' ? sw * 2 : sw;
      strokeHit = base + pad * 2;
    }
    const fillRule =
      String(node.attrs?.['fill-rule'] || 'nonzero') === 'evenodd' ? 'evenodd' : 'nonzero';
    rememberNodePath2D(id, d);
    if (
      hitTestPath2DLocal(d, lx, ly, {
        fill: supportsFill(node),
        strokeWidth: strokeHit,
        fillRule,
        lineCap: 'butt',
        lineJoin: 'miter',
      })
    ) {
      return true;
    }
    // L / star / boolean path: Path2D miss must not fall through to AABB —
    // that selected overflow children when clicking empty artboard plate.
    if (shapeRequiresPrecisePathHit(shapeType, node)) return false;
  }
  const hitBox = inflateBoxByVisualOutset(geom, node);
  return hitsRotatedAabb(x, y, hitBox, angle, pad);
}

function hitTestVisualAabb(opts: {
  node: SceneNodeInput;
  box: SceneHitBox;
  x: number;
  y: number;
  pad: number;
}): boolean {
  const { node, box, x, y, pad } = opts;
  const geom = deflateSelectionBox(box, node);
  const hitBox = inflateBoxByVisualOutset(geom, node);
  const angle = Number(node.attrs?.angle) || 0;
  return hitsRotatedAabb(x, y, hitBox, angle, pad);
}

/** True when scene point hits this node’s ink / visual AABB. */
export function hitTestSceneNodeAt(opts: {
  id: string;
  node: SceneNodeInput;
  box: SceneHitBox;
  x: number;
  y: number;
  zoom: number;
  pad: number;
  screen?: { clientX: number; clientY: number };
  svgEl?: Element | null;
  allowSvgDomHit?: boolean;
}): boolean {
  const { id, node, box, x, y, zoom, pad, screen, svgEl, allowSvgDomHit } = opts;
  const shapeType = String(node.attrs?.shapeType || '');
  if (shapeType === 'line' || shapeType === 'arrow') {
    return hitTestLineOrArrow({ id, node, box, x, y, pad });
  }
  const customPath = String(node.attrs?.path || '').trim();
  // Freehand / boolean / outline silhouette — never solid baseline AABB.
  if (shapeType === 'pen' || shapeType === 'pencil' || shapeType === 'path' || customPath) {
    return hitTestPathLike({
      id,
      node,
      shapeType: shapeType === 'pen' || shapeType === 'pencil' ? shapeType : 'path',
      box,
      x,
      y,
      zoom,
      screen,
      svgEl,
      allowSvgDomHit,
    });
  }
  if (isGeoShapeNode(node, shapeType)) {
    return hitTestGeoShape({ id, node, box, x, y, pad });
  }
  return hitTestVisualAabb({ node, box, x, y, pad });
}
