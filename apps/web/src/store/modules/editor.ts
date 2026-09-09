import type { PayloadAction } from '@/store/payload';
import { applyEditorReducer, bindEditorMutator } from '@/store/editorBind';
import { nanoid } from 'nanoid';
import {
  createEmptyDocument,
  normalizeDocument,
  reconcileStackOrder,
  setDocumentCanvasMeta,
  setDocumentSize,
  updateNodeInDocument,
  mergeNodePatch,
  alignImportedDocumentOrigin,
  mergeImportedIntoDocument,
  ensureDocumentContentOnCanvas,
  addNodeToDocument,
  removeNodesFromDocument,
  type DocumentCanvasMetaPatch,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  clearImageProcessAttrs,
  spawnImageProcessNode,
  spawnImportPlaceholderNode,
  spawnImageUploadPlaceholderNode,
  spawnVideoUploadPlaceholderNode,
  spawnAudioUploadPlaceholderNode,
  promoteImageGeneratorToImage,
  promoteVideoGeneratorToVideo,
  promoteAudioGeneratorToAudio,
  applyImageDecomposeLayers,
  detachImageVariantToNode} from '@/components/rcb/scene/document/mediaLifecycle';
import {
  createImageGeneratorNode,
  createVideoGeneratorNode,
  createLottieNode,
  createLottieGeneratorNode,
  createAudioNode,
  createAudioGeneratorNode,
  createImageNode,
  createVideoNode,
  MEDIA_PLACE_DEFAULT,
  parseLottieAnimationData,
  serializeLottieAnimationData} from '@/components/rcb/scene/document/nodeFactories';
import {
  isEphemeralUploadNode
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  loadTemplates,
  saveTemplates,
  isSessionTemplate,
  type EditorLibraryItem,
  type TemplateSource} from '@/utils/templatesStorage';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import { bindUnownedNodesToFrames } from '@/components/rcb/frames/frameNodeBinding';
import { frameIsEmpty } from '@/components/rcb/frames/framePlatePointer';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';
import { coerceSceneDocumentInput } from '@/components/rcb/sceneNode';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { isFrameLocalCoordSpace } from '@/components/rcb/scene/layout/nodeLayout';
import { createBlankLottieAnimation } from '@/components/editor/nodes/AnimationNode/animationComposeLayers';
import { syncArtboardChildrenIntoAnimation } from '@/components/editor/nodes/AnimationNode/animationFrameSync';
import { materializeRootShapeLayers } from '@/components/editor/nodes/AnimationNode/animationLottieMaterialize';
import { linkedLotNodeIdFromAsset } from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import {
  endPrecompEditFromState,
  persistPrecompSessionEdits,
  resolvePrecompSessionNodeIds,
  syncLotNodeFromHostPrecompAsset,
  type LottiePrecompEditState} from '@/components/editor/nodes/AnimationNode/animationPrecompSession';
import {
  findAnimationFrameAtDocPoint,
  findFrameAnimationMediaId,
  resolveAnimationFrameId} from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  finalizeNodeForAnimationWorkbenchFocus,
  getAnimationWorkbenchTimelineFocus,
  isAnimationWorkbenchGeometryPreview,
  isAnimationWorkbenchPreviewChild,
  isAvBlockedByAnimationWorkbenchFocus,
  isNewPlateBlockedByAnimationWorkbenchFocus,
  setAnimationWorkbenchGeometryPreview,
  setAnimationWorkbenchPlayheadSec,
  setAnimationWorkbenchTimelineFocus,
  tagCreatedNodeForWorkbenchSurround} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { isAnimationFrameHostNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { setLottiePrecompEditFocus } from '@/components/editor/nodes/AnimationNode/animationPrecompEditFocus';
import { convertLottiePrecompTab } from '@/components/editor/nodes/AnimationNode/lottiePrecompTabConvert';
import { clearStuckLottieMountVisibility, schedulePrecompTabArtboardDump } from '@/components/editor/nodes/AnimationNode/precompTabArtboardDump';
import { collectPrecompSessionDocumentPatches } from '@/components/editor/nodes/AnimationNode/animationPlayheadSceneApply';
import { requestPlayheadSceneApply } from '@/components/editor/nodes/AnimationNode/animationPlayheadApplyEvent';
import { requestPuppetWarpApply } from '@/components/editor/nodes/ImageNode/puppet/puppetWarpApplyEvent';
import {
  getAnimationPlaying,
  writeAnimationPlayheadSec,
  writeAnimationPlaying} from '@/components/editor/nodes/AnimationNode/animationTransport';
import {
  queueEnsureAnimationFrame,
  queueIdleAnimationHostJson,
  requestPrecompCameraFit,
  requestPrecompCameraRelease,
  requestAiFlush,
  requestSyncNestedLotHosts,
  requestTimelineCameraFit,
  requestTimelineCameraRelease,
  markPastePerf,
} from '@/components/editor/sceneEvents';
import { queueEnsureAnimationFramesForDocChange, nodePatchNeedsTimelineBake, frameBakeSignature } from '@/components/editor/nodes/AnimationNode/queueEnsureAnimationFramesForDocChange';
import { notifyShapeHostGeometry } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  asHistoryEntry,
  cloneDocument,
  cloneNodeForHistory,
  pushAddHistory as snapshotAddHistory,
  pushHistory as snapshotEditorHistory,
  pushNodePatchHistory as snapshotNodePatchHistory,
  pushRemoveHistory as snapshotRemoveHistory,
  redoAddHistoryEntry,
  restoreNodesIntoDocument,
  scrubNodeIdsFromHistory,
  trimHistoryPast,
  undoAddHistoryEntry,
  type HistoryEntry} from './editorHistory';

export type { ArtboardFrame } from '@/components/rcb/frames/types';
export type { SceneDocument } from '@/components/rcb/sceneNode';

/** Import / hydrate: Zod at boundary, then align origin + normalize. */
function documentFromExternalPayload(raw: unknown): SceneDocument {
  return alignImportedDocumentOrigin(coerceSceneDocumentInput(raw));
}

/** Side panel / toolbar kinds for image tools. */
export type ImageToolPanelKind =
  | 'eraser'
  | 'removeBg'
  | 'opacity'
  | 'multiAngle'
  | 'expand'
  | 'crop'
  | 'adjust'
  | 'effects'
  | 'blendMode'
  | 'flipRotate'
  | 'quickEdit'
  | 'replaceText'
  | 'lottieEdit'
  | 'mark'
  | 'puppet'
  | 'mockup'
  | 'upscale'
  | 'translateImage'
  | 'productScene';

export type ImageToolPanelState = {
  nodeId: string;
  kind: ImageToolPanelKind;
  /** `quickEdit` / `imageGen` / `videoGen` — mark regions land in the floating composer; default is agent chat. */
  markSink?: 'agent' | 'quickEdit' | 'imageGen' | 'videoGen';
};

export type PendingMarkContextChip = {
  key: string;
  label: string;
  kind: string;
  payload: string;
  dataUrl?: string;
  thumbUrl?: string;
  appendText?: string;
};

/** Single pinned mark region on an image (shown after confirm). */
export type ImageMarkPin = {
  nodeId: string;
  id: string;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  kind?: string;
  label?: string;
  sink: 'agent' | 'quickEdit' | 'imageGen' | 'videoGen';
};

export function canvasAttachTargetForNode(nodeId: string): string {
  return `node:${nodeId}`;
}

export function isCanvasAttachForNode(
  nodeId: string,
  canvasAttachPick: { target: string } | null | undefined,
  pendingCanvasAttach: { target: string } | null | undefined
): boolean {
  const target = canvasAttachTargetForNode(nodeId);
  return (
    canvasAttachPick?.target === target || pendingCanvasAttach?.target === target
  );
}

export function isMultiImageMarkPanel(
  panel: ImageToolPanelState | null | undefined
): boolean {
  return (
    panel?.kind === 'mark' &&
    (panel.markSink === 'quickEdit' ||
      panel.markSink === 'imageGen' ||
      panel.markSink === 'videoGen')
  );
}

export function isQuickEditMarkPanel(
  panel: ImageToolPanelState | null | undefined,
  nodeId: string,
  nodeKey = 'image'
): boolean {
  return (
    nodeKey === 'image' &&
    panel?.nodeId === nodeId &&
    panel?.kind === 'mark' &&
    panel?.markSink === 'quickEdit'
  );
}

export function markPanelSink(
  panel: ImageToolPanelState | null | undefined
): 'agent' | 'quickEdit' | 'imageGen' | 'videoGen' {
  if (panel?.markSink === 'quickEdit') return 'quickEdit';
  if (panel?.markSink === 'imageGen') return 'imageGen';
  if (panel?.markSink === 'videoGen') return 'videoGen';
  return 'agent';
}

function pruneMarkPinsBySink(
  pins: Record<string, ImageMarkPin[]>,
  sink: 'quickEdit' | 'imageGen' | 'videoGen'
): Record<string, ImageMarkPin[]> {
  const out: Record<string, ImageMarkPin[]> = {};
  for (const [nodeId, raw] of Object.entries(pins || {})) {
    const list = (Array.isArray(raw) ? raw : []).filter((p) => p.sink !== sink);
    if (list.length) out[nodeId] = list;
  }
  return out;
}

function pruneQuickEditMarkPins(
  pins: Record<string, ImageMarkPin[]>
): Record<string, ImageMarkPin[]> {
  return pruneMarkPinsBySink(pins, 'quickEdit');
}

const IMAGE_TOOL_SIDE_PANEL_KIND: Record<string, true> = {
  eraser: true,
  removeBg: true,
  opacity: true,
  replaceText: true,
  multiAngle: true,
  adjust: true,
  effects: true,
  blendMode: true,
  /** Density; pins + mesh live on PuppetPinHost while panel is open. */
  puppet: true};

/** Blend / effects dock beside any selected node (not image-only tools). */
const NODE_LAYER_TOOL_PANEL_KIND: Record<string, true> = {
  effects: true,
  blendMode: true,
  opacity: true,
};

const IMAGE_TOOL_CROP_SESSION_KIND: Record<string, true> = {
  crop: true,
  expand: true,
  upscale: true,
  /** Bottom session bars — hide the main image toolbar (same as upscale). */
  translateImage: true,
  productScene: true,
};

const IMAGE_TOOL_EXTERNAL_SESSION_KIND: Record<string, true> = {
  crop: true,
  expand: true,
  upscale: true,
  translateImage: true,
  productScene: true,
  flipRotate: true,
  quickEdit: true,
  lottieEdit: true,
  mark: true};

const TRANSIENT_NODE_ATTR_KEYS = new Set([
  'processStatus',
  'processKind',
  'processLabel',
  'processMeta',
  'processSourceId',
  'processTargetWidth',
  'processTargetHeight',
]);

const TRANSIENT_FRAME_KEYS = new Set(['processStatus', 'processKind', 'processLabel']);

function isTransientNodePatch(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const patchKeys = Object.keys(patch as Record<string, unknown>);
  if (patchKeys.length !== 1 || patchKeys[0] !== 'attrs') return false;
  const attrs = (patch as { attrs?: unknown }).attrs;
  if (!attrs || typeof attrs !== 'object') return false;
  const keys = Object.keys(attrs as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => TRANSIENT_NODE_ATTR_KEYS.has(key));
}

const GEOMETRY_NODE_KEYS = new Set(['x', 'y', 'width', 'height', 'attrs']);
const GEOMETRY_ATTR_KEYS = new Set(['angle', 'flipX', 'flipY']);

/**
 * Pure geometry / transform commit — Kit TransformPreview + DomHost noop only.
 * Must not bump sceneReloadToken or remount RcbShapeHost.
 */
function isGeometryOnlyNodePatch(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const p = patch as Record<string, unknown>;
  const keys = Object.keys(p);
  if (!keys.length || !keys.every((k) => GEOMETRY_NODE_KEYS.has(k))) return false;
  const hasGeom = keys.some((k) => k === 'x' || k === 'y' || k === 'width' || k === 'height');
  if (p.attrs == null) return hasGeom;
  if (typeof p.attrs !== 'object') return false;
  const attrKeys = Object.keys(p.attrs as Record<string, unknown>);
  if (!attrKeys.every((k) => GEOMETRY_ATTR_KEYS.has(k))) return false;
  return hasGeom || attrKeys.length > 0;
}

function patchSkipsHostRemount(patch: unknown): boolean {
  return isGeometryOnlyNodePatch(patch);
}

function isTransientFramePatch(patch: unknown): boolean {
  if (!patch || typeof patch !== 'object') return false;
  const keys = Object.keys(patch as Record<string, unknown>);
  return keys.length > 0 && keys.every((key) => TRANSIENT_FRAME_KEYS.has(key));
}

function shouldSkipPatchHostReload(skipHostReload: unknown, patch: unknown): boolean {
  return Boolean(skipHostReload) || isTransientNodePatch(patch);
}

function rootChildrenIds(doc: SceneDocument | null | undefined): string[] {
  return (doc?.deltaSetLike?.ROOT?.children || []).map(String);
}

function listChangedChildIds(
  prevDoc: SceneDocument | null | undefined,
  nextDoc: SceneDocument | null | undefined,
  ids: readonly string[]
): string[] {
  const prevMap = prevDoc?.deltaSetLike || {};
  const nextMap = nextDoc?.deltaSetLike || {};
  const patched: string[] = [];
  for (const id of ids) {
    if (prevMap[id] !== nextMap[id]) patched.push(id);
  }
  return patched;
}

/** Frame ids whose plate x/y/w/h changed (frameLocal children need SoA rewrite). */
function listMovedArtboardFrameIds(
  prevDoc: SceneDocument | null | undefined,
  nextDoc: SceneDocument | null | undefined
): string[] {
  const prevFrames = Array.isArray(prevDoc?.frames) ? prevDoc!.frames : [];
  const nextFrames = Array.isArray(nextDoc?.frames) ? nextDoc!.frames : [];
  if (!nextFrames.length) return [];
  const prevById = new Map(prevFrames.map((f) => [String(f?.id), f]));
  const out: string[] = [];
  for (const frame of nextFrames) {
    const id = String(frame?.id || '').trim();
    if (!id) continue;
    const prev = prevById.get(id);
    if (!prev) continue;
    if (
      Math.round(Number(prev.x) || 0) !== Math.round(Number(frame.x) || 0) ||
      Math.round(Number(prev.y) || 0) !== Math.round(Number(frame.y) || 0) ||
      Math.round(Number(prev.width) || 0) !== Math.round(Number(frame.width) || 0) ||
      Math.round(Number(prev.height) || 0) !== Math.round(Number(frame.height) || 0)
    ) {
      out.push(id);
    }
  }
  return out;
}

/**
 * While Kit flushes WasmScene → SceneDocument, do not bump `sceneReloadToken`.
 * Bumping it re-hydrates Kit from the document (destroy + rebuild) — the opposite
 * of the engine-as-SoT contract and the root cause of draw/marquee/position bugs.
 */
let kitCanvasDocFlushDepth = 0;

export function withKitCanvasDocumentFlush<T>(fn: () => T): T {
  kitCanvasDocFlushDepth += 1;
  try {
    return fn();
  } finally {
    kitCanvasDocFlushDepth -= 1;
  }
}

function applyCanvasDocPatchTokens(
  state: typeof initialState,
  prevDoc: SceneDocument | null | undefined
): void {
  const prevKids = rootChildrenIds(prevDoc);
  const nextKids = rootChildrenIds(state.document);
  const membershipChanged =
    prevKids.length !== nextKids.length || prevKids.some((id, i) => id !== nextKids[i]);
  const fromKit = kitCanvasDocFlushDepth > 0;

  if (fromKit) {
    // Kit already holds ink. Document is a mirror for panels / DomHost / persist.
    // DomHost mounts via documentPatchToken + child list — not a full Kit hydrate.
    if (membershipChanged) {
      state.lastPatchedNodeIds = [];
      state.lastPatchTransformOnly = false;
    } else {
      let patched = listChangedChildIds(prevDoc, state.document, nextKids);
      if (isFrameLocalCoordSpace(state.document)) {
        const movedFrames = listMovedArtboardFrameIds(prevDoc, state.document);
        if (movedFrames.length) {
          const bound = nodeIdsBoundToFrames(state.document, movedFrames);
          if (bound.length) patched = [...new Set([...patched, ...bound])];
        }
      }
      state.lastPatchedNodeIds = patched;
      // Must stay false so KitCanvasHost does not push RCB→Kit geometry.
      state.lastPatchTransformOnly = false;
    }
    state.lastPatchFromKitCanvas = true;
    return;
  }

  state.lastPatchFromKitCanvas = false;
  if (membershipChanged) {
    state.sceneReloadToken += 1;
    state.lastPatchedNodeIds = [];
    state.lastPatchTransformOnly = false;
    return;
  }
  let patched = listChangedChildIds(prevDoc, state.document, nextKids);
  // Plate-only commits leave child node identity unchanged, but frameLocal
  // world paint boxes move — refresh those Kit slots or cull stale ink.
  if (isFrameLocalCoordSpace(state.document)) {
    const movedFrames = listMovedArtboardFrameIds(prevDoc, state.document);
    if (movedFrames.length) {
      const bound = nodeIdsBoundToFrames(state.document, movedFrames);
      if (bound.length) {
        patched = [...new Set([...patched, ...bound])];
      }
    }
  }
  state.lastPatchedNodeIds = patched;
  state.lastPatchTransformOnly = true;
}

export function shouldClearImageToolPanelOnSelect(
  panel: { nodeId: string; kind: string } | null | undefined,
  nextNodeId: string | null
): boolean {
  if (!panel) return false;
  // Mark / quick-edit / puppet stay open while picking empty canvas or same image.
  if (panel.kind === 'mark' || panel.kind === 'quickEdit' || panel.kind === 'puppet') {
    return Boolean(nextNodeId && panel.nodeId !== nextNodeId);
  }
  return !nextNodeId || panel.nodeId !== nextNodeId;
}

export function isImageToolSidePanelKind(kind: string | undefined | null): boolean {
  return Boolean(kind && kind in IMAGE_TOOL_SIDE_PANEL_KIND);
}

export function isNodeLayerToolPanelKind(kind: string | undefined | null): boolean {
  return Boolean(kind && kind in NODE_LAYER_TOOL_PANEL_KIND);
}

export function isImageToolCropSessionKind(kind: string | undefined | null): boolean {
  return Boolean(kind && kind in IMAGE_TOOL_CROP_SESSION_KIND);
}

export function isImageToolExternalSessionKind(kind: string | undefined | null): boolean {
  return Boolean(kind && kind in IMAGE_TOOL_EXTERNAL_SESSION_KIND);
}

/** On-canvas video tool sessions (trim timeline). Spatial crop reuses image crop panel. */
export type VideoToolPanelKind = 'trim';

/** On-canvas audio tool sessions — 截取 / 变速 only. */
export type AudioToolPanelKind = 'trim' | 'speed';

function createFrame(partial?: Partial<ArtboardFrame>): ArtboardFrame {
  const hasW = partial?.width != null && Number.isFinite(Number(partial.width));
  const hasH = partial?.height != null && Number.isFinite(Number(partial.height));
  const width = Math.max(1, Math.round(hasW ? Number(partial!.width) : 794));
  const height = Math.max(1, Math.round(hasH ? Number(partial!.height) : 1123));
  const rawKind = String(partial?.kind || '').trim();
  const kind =
    rawKind === 'animation' || rawKind === 'lottie'
      ? 'animation'
      : rawKind === 'artboard'
        ? 'artboard'
        : undefined;
  const durationSec = isAnimationArtboardKind(kind)
    ? Math.max(
        0.5,
        Number.isFinite(Number(partial?.durationSec)) ? Number(partial!.durationSec) : 5
      )
    : partial?.durationSec;
  const fps = isAnimationArtboardKind(kind)
    ? Math.max(1, Math.round(Number.isFinite(Number(partial?.fps)) ? Number(partial!.fps) : 30))
    : partial?.fps;
  return {
    id: partial?.id || nanoid(8),
    name: partial?.name || (isAnimationArtboardKind(kind) ? '动画工作台' : 'Frame'),
    x: Math.round(partial?.x ?? 0),
    y: Math.round(partial?.y ?? 0),
    width,
    height,
    backgroundColor: partial?.backgroundColor ?? '#FFFFFF',
    backgroundOpacity: partial?.backgroundOpacity ?? 100,
    clipContent: partial?.clipContent ?? true,
    ...(kind ? { kind } : {}),
    ...(durationSec != null ? { durationSec } : {}),
    ...(fps != null ? { fps } : {})};
}

/**
 * Claim session (`case`/`scratch`) as owned on first real edit.
 * Full document snapshots (local + cloud) are debounced in `useProjectCloudSync`.
 */
function syncLibraryOnEdit(state: typeof initialState, claim = true) {
  if (!state.currentId || !state.document) return;
  const item = state.templates.find((t) => t.id === state.currentId);
  if (!item) return;
  // Share-edit sessions stay off the Projects library.
  if (String(state.currentId).startsWith('share_')) return;
  if (!(claim && isSessionTemplate(item))) return;
  item.source = 'user' as TemplateSource;
  item.updatedAt = Date.now();
  // Do not cloneDocument here — O(doc) on every first-edit claim froze paste
  // at 2k–10k. Cloud/local drafts read store.document via useProjectCloudSync.
  saveTemplates(state.templates);
}

function touchOpened(item: EditorLibraryItem | null | undefined) {
  if (!item) return;
  item.openedAt = Date.now();
}

const templates = loadTemplates();

/** Stable empty id list for useSelector fallbacks (avoid `|| []` new refs). */
export const EMPTY_ID_LIST: string[] = [];

/**
 * Ephemeral AI overlay (PR9). Highlight / outline / operation label / AI cursor.
 * Must never enter SceneDocument, frames, or Yjs.
 */
export type AiOperationState = {
  active: boolean;
  transactionId?: string;
  frameId?: string | null;
  nodeId?: string | null;
  action?: string;
  label?: string;
};

const initialState = {
  templates,
  currentId: null as string | null,
  document: null as SceneDocument | null,
  selectedNodeId: null as string | null,
  selectedNodeIds: [] as string[],
  /** Multi artboard selection (UI); document.activeFrameId is the primary. */
  selectedFrameIds: [] as string[],
  /**
   * Artboard chrome level:
   * - soft: edge highlight only (interior click / working inside)
   * - full: toolbar + resize handles + title drag (title click)
   */
  frameChromeMode: 'soft' as 'soft' | 'full',
  dirty: false,
  /**
   * Monotonic local scene version. Human edits bump it; AI transactions hold
   * `aiMutationLock` so per-op setDocument snapshots do not look like user edits.
   */
  sceneRevision: 0,
  /** >0 while an AI DesignTransaction is applying (PR7 Scene Mutation). */
  aiMutationLock: 0,
  /** >0 while tool_ops are visibly applying — block select/edit; pan/zoom stay enabled. */
  canvasApplyLock: 0,
  sceneReloadToken: 0,
  documentPatchToken: 0,
  /**
   * Monotonic doc mutation counter (incl. setDocumentFromCanvas).
   * Collab / persist subscribe to this instead of whole `document` identity.
   */
  documentRevision: 0,
  /** Node ids last touched by `patchDocumentNode` — SvgCanvas refreshes these even with no selection. */
  lastPatchedNodeIds: [] as string[],
  /** Latest patch only changed angle / flip — SvgCanvas updates transform, not path `d`. */
  lastPatchTransformOnly: false,
  /**
   * Document patch originated from Kit→SceneDocument mirror flush.
   * KitCanvasHost must not push geometry/style back into Kit (engine is SoT).
   */
  lastPatchFromKitCanvas: false,
  historyPast: [] as HistoryEntry[],
  historyFuture: [] as HistoryEntry[],
  activeTool: 'select' as string,
  /** Local grid snap + overlay (session-persisted; not in cloud document). */
  isGridMode: false,
  shapeKind: 'rect' as string,
  pendingImageSrc: null as string | null,
  pendingImageProcessId: null as string | null,
  /** Blank loading node while image import runs. */
  pendingImportPlaceholderId: null as string | null,
  /** Interactive image tool panel docked to the right of the source image (figs 2-5). */
  imageToolPanel: null as null | ImageToolPanelState,
  videoToolPanel: null as null | {
    nodeId: string;
    kind: VideoToolPanelKind;
    /** Canvas playhead at open — trim preview must not jump to 0. */
    keepTime?: number;
  },
  audioToolPanel: null as null | {
    nodeId: string;
    kind: AudioToolPanelKind;
    /** Canvas playhead at open — trim preview must not jump to 0. */
    keepTime?: number;
  },
  /** Lottie in-plate compose mode (artboard-like tools on the plate). */
  lottieComposePanel: null as null | {
    nodeId: string;
    tool: 'select' | 'rect' | 'ellipse' | 'pen' | 'text';
  },
  /** Bottom timeline dock for a Lottie plate. */
  lottieTimelinePanel: null as null | { nodeId: string },
  /**
   * Precomp isolation edit (timeline scene tab).
   * hostNodeId = timeline Lottie host; assetId = precomp asset id (e.g. lot_<nodeId>).
   * On enter: workbench resizes to the lot plate and JSON layers become real scene nodes.
   */
  lottiePrecompEdit: null as null | LottiePrecompEditState,
  /** 动画工作台 (artboard) workbench — quick edit on the plate. */
  animationFramePanel: null as null | { frameId: string; kind: 'quickEdit' | 'timeline' },
  /** Playhead time (seconds) — shared by dock scrub and undocked playback. */
  lottiePlayheadSec: 0 as number,
  /** Shared transport playing flag (dock + frame/host toolbars). */
  lottiePlaying: false as boolean,
  /**
   * Host node for canvas playback without opening the timeline dock.
   * Same playhead sync path as `lottieTimelinePanel.nodeId`.
   */
  lottiePlayingHostId: null as string | null,
  /** Fill / stroke panel docked to the right of the selection (hides top chrome while open). */
  shapeStylePanel: null as null | { kind: 'fill' | 'stroke' | 'radius'; nodeIds: string[] },
  /** Shared stroke settings for pen / pencil tools. */
  penStrokeColor: '#000000' as string,
  penFillColor: '#CCCCCC' as string,
  penStrokeWidth: 1 as number,
  /** Brush / stroke opacity while painting (0–100). */
  penStrokeOpacity: 100 as number,
  /** Paint-bucket fill (same schema as FillPanel). */
  bucketFill: {
    fillType: 'solid' as const,
    fillColor: '#333333',
    fillOpacity: 100,
    fillGradient: undefined as string | undefined,
    fillImageSrc: undefined as string | undefined,
    fillImageFit: undefined as 'fill' | 'fit' | 'crop' | 'tile' | undefined,
    fillImageRotate: undefined as number | undefined,
    fillImageScale: undefined as number | undefined,
    fillImageOffsetX: undefined as number | undefined,
    fillImageOffsetY: undefined as number | undefined,
    fillImageAdjust: undefined as Record<string, number> | undefined},
  /** Pencil brush wheel selection (default = first: 矢量墨线). */
  pencilBrushId: 'vector-ink' as string,
  /** When true, pencil uses stylus/touch pressure for width. */
  pencilPressureEnabled: true,
  /** Design = edit; Dev = inspect spacing / margins. */
  workspaceMode: 'design' as 'design' | 'dev',
  /** Dev-mode node under pointer (inspect panel + spacing overlay). */
  devHoverNodeId: null as string | null,
  /** True while the design agent is mutating the canvas (hides selection chrome). */
  agentBusy: false,
  /** Local AI generating chrome — not persisted, not collab-synced. */
  aiOperationState: null as AiOperationState | null,
  /**
   * Composer canvas pick — next click attaches (group-expanded) to the target.
   * `target`: `'agent'` | `` `node:${nodeId}` ``
   * `accept`: `'image'` = stills only (image generator / quick-edit); omit/`'media'` allows video.
   */
  canvasAttachPick: null as null | { target: string; accept?: 'image' | 'media' },
  /** Hover is over a node that cannot be added (generator / shimmer). */
  canvasAttachPickBlocked: false,
  /** Delivered once after a successful pick; composers consume and clear. */
  pendingCanvasAttach: null as null | { target: string; payload: string | string[] },
  /**
   * Mark / programmatic chips for the right AgentDock (@ mentions).
   * EditorPage opens the panel when `agentOpenNonce` bumps; dock inserts then clears.
   */
  pendingAgentContexts: [] as PendingMarkContextChip[],
  pendingQuickEditMarkContexts: [] as PendingMarkContextChip[],
  pendingImageGenMarkContexts: [] as PendingMarkContextChip[],
  pendingVideoGenMarkContexts: [] as PendingMarkContextChip[],
  /** One pinned mark per image node (compact badge after confirm). */
  imageMarkPins: {} as Record<string, ImageMarkPin[]>,
  /** Composer chip hover — highlights the matching canvas mark pin. */
  hoveredMarkPin: null as { nodeId: string; pinId: string } | null,
  agentOpenNonce: 0};

/** Stage fill lives on the editor store; SvgCanvas view docs force transparent paper for hosts. */
const STAGE_CANVAS_META_KEYS = [
  'backgroundColor',
  'backgroundFillType',
  'backgroundGradient',
  'backgroundOpacity',
  'backgroundImageSrc',
  'backgroundImageFit',
  'backgroundImageRotate',
  'backgroundImageScale',
  'backgroundImageOffsetX',
  'backgroundImageOffsetY',
  'backgroundImageAdjust',
] as const;

/**
 * Embedded canvas passes a view document with `backgroundColor: 'transparent'`.
 * Geometry commits must not write that back over the real stage fill.
 */
function preserveStageCanvasMeta(
  prev: SceneDocument | null | undefined,
  incoming: SceneDocument
): SceneDocument {
  if (!prev || !incoming || typeof incoming !== 'object') return incoming;
  if (String(incoming.backgroundColor) !== 'transparent') return incoming;
  if (String(prev.backgroundColor ?? '') === 'transparent') return incoming;
  const next = { ...incoming } as Record<string, unknown>;
  const src = prev as Record<string, unknown>;
  for (const key of STAGE_CANVAS_META_KEYS) {
    if (key in prev) next[key] = src[key];
  }
  return next as SceneDocument;
}

function clearSelection(state: typeof initialState) {
  state.selectedNodeId = null;
  state.selectedNodeIds = [];
  state.selectedFrameIds = [];
  state.imageToolPanel = null;
  state.videoToolPanel = null;
  state.audioToolPanel = null;
  state.lottieComposePanel = null;
  // Keep lottieTimelinePanel — dock stays until explicit close / node delete.
  state.shapeStylePanel = null;
}

/** Selecting scene elements while playing → pause (keep host so pose stays). */
function pauseLottieIfPlaying(state: typeof initialState) {
  // Dock/toolbar read transport via useAnimationPlaying — the store alone does not stop RAF.
  if (!state.lottiePlaying && !getAnimationPlaying()) return;
  state.lottiePlaying = false;
  writeAnimationPlaying(false, { hostNodeId: state.lottiePlayingHostId });
}

function readSelectedLayerInd(raw: unknown, fallback: number | null = null): number | null {
  if (raw == null || !Number.isFinite(Number(raw))) return fallback;
  return Number(raw);
}

/** Restore workbench geom + drop LOT-tab session shapes. Returns true if document changed. */
function tearDownLottiePrecompEdit(state: typeof initialState): boolean {
  const prev = state.lottiePrecompEdit;
  if (!prev || !state.document) return false;
  // Clear module focus BEFORE document write so the same React commit that
  // remounts nested LOT ink does not keep visibility:hidden (layout-effect
  // clear alone leaves overlays stuck blank until an unrelated re-render).
  setLottiePrecompEditFocus({ active: false });
  const next = endPrecompEditFromState(
    state.document,
    prev,
    Number(state.lottiePlayheadSec) || 0
  );
  if (!next) return false;
  const sessionIds = resolvePrecompSessionNodeIds(next, prev);
  let doc = syncLotNodeFromHostPrecompAsset(
    next,
    prev.hostNodeId,
    prev.assetId,
    sessionIds
  );
  state.document = doc;
  state.documentPatchToken += 1;
  // Keep the nested-lot LottiePlate that was painting on 第一次打开 / LOT tab.
  // Forced inkRevision remount here blanked 主场景 and broke nested playback.
  const lotId = prev.lotNodeId ?? linkedLotNodeIdFromAsset(String(prev.assetId || ''));
  if (lotId) {
    const lot = state.document.deltaSetLike?.[lotId];
    if (lot && (lot.attrs?.hidden === true || lot.attrs?.hidden === 'true')) {
      state.document.deltaSetLike[lotId] = {
        ...lot,
        attrs: { ...(lot.attrs || {}), hidden: false },
      };
    }
    notifyShapeHostGeometry(lotId);
  }
  return true;
}

function persistActivePrecompSession(state: typeof initialState) {
  const edit = state.lottiePrecompEdit;
  if (!edit?.frameId || !state.document) return;
  const next = persistPrecompSessionEdits(
    state.document,
    edit,
    Number(state.lottiePlayheadSec) || 0
  );
  if (next === state.document) return;
  state.document = next;
  state.documentPatchToken += 1;
}

/**
 * LOT-tab: bake playhead-sampled poses into session shapes in-mutator.
 * Called from enter / setLottiePlayhead — never from a document watcher.
 */
function bakePrecompSessionDocumentPoses(state: typeof initialState) {
  const edit = state.lottiePrecompEdit;
  if (!edit?.sessionNodeIds?.length || !state.document || state.lottiePlaying) return;
  const hostId = String(edit.hostNodeId || '').trim();
  if (!hostId) return;
  const patches = collectPrecompSessionDocumentPatches({
    document: state.document,
    hostNodeId: hostId,
    playheadSec: Number(state.lottiePlayheadSec) || 0});
  if (!patches.length) return;
  const applied: string[] = [];
  for (const item of patches) {
    const id = String(item.nodeId || '');
    if (!id || !state.document.deltaSetLike?.[id]) continue;
    state.document.deltaSetLike[id] = mergeNodePatch(
      state.document.deltaSetLike[id],
      item.patch
    );
    applied.push(id);
  }
  if (!applied.length) return;
  state.documentPatchToken += 1;
  state.lastPatchedNodeIds = applied;
  state.lastPatchTransformOnly = false;
}

function clearLottiePrecompEdit(state: typeof initialState): boolean {
  const prev = state.lottiePrecompEdit;
  const hostNodeId = String(prev?.hostNodeId || '').trim();
  const changed = tearDownLottiePrecompEdit(state);
  state.lottiePrecompEdit = null;
  if (prev) {
    requestPrecompCameraRelease();
    if (hostNodeId) {
      requestSyncNestedLotHosts({
        frameHostId: hostNodeId,
        timeSec: Number(state.lottiePlayheadSec) || 0,
        afterPaint: true});
    }
  }
  return changed;
}

/** Drop pending process id when its node was deleted (upload-in-flight must not revive it). */
function clearPendingProcessIfNodeGone(state: typeof initialState) {
  const pending = state.pendingImageProcessId;
  if (!pending) return;
  if (!state.document?.deltaSetLike?.[pending]) {
    state.pendingImageProcessId = null;
  }
}

function bumpDocumentRevision(state: typeof initialState) {
  state.documentRevision = (Number(state.documentRevision) || 0) + 1;
}

function bumpSceneRevisionIfUnlocked(state: typeof initialState) {
  if ((state.aiMutationLock || 0) > 0) return;
  state.sceneRevision = (state.sceneRevision || 0) + 1;
}

/** Remount SVG hosts — skipped while AI transaction is open (flush on unlock). */
function bumpSceneReloadIfUnlocked(state: typeof initialState) {
  if ((state.aiMutationLock || 0) > 0) return;
  state.sceneReloadToken = (Number(state.sceneReloadToken) || 0) + 1;
}

/** Remote Yjs is a user-visible scene change — AI must rebase, not silent-overwrite. */
function bumpSceneRevisionForRemoteCollab(state: typeof initialState) {
  state.sceneRevision = (state.sceneRevision || 0) + 1;
}

function pushHistory(state: typeof initialState) {
  snapshotEditorHistory(state);
  bumpSceneRevisionIfUnlocked(state);
}

/** Paste/dupe: O(paste) history instead of O(doc) full snap. */
function pushAddHistory(
  state: typeof initialState,
  opts: {
    nodeIds: readonly string[];
    frameIds?: readonly string[];
    fromDocument?: SceneDocument | null;
  }
) {
  snapshotAddHistory(state, opts);
  // Do not bump sceneRevision / documentRevision here. Both wake
  // useEditorDocumentOnCommit (LayerPanel / AgentDock / timeline). Rebuilding
  // docks in the same turn as Kit paste dominated paste #2+ at 2k+.
  // Callers schedule touchDocumentRevision after paint.
}

/** Cut / delete: O(removed) history instead of O(doc) full snap. */
function pushRemoveHistory(
  state: typeof initialState,
  opts: {
    nodeIds: readonly string[];
    frameIds?: readonly string[];
    fromDocument?: SceneDocument | null;
  }
) {
  snapshotRemoveHistory(state, opts);
}

/** Insert + select a generator plate without remounting the whole scene. */
function commitSpawnedGenerator(
  state: typeof initialState,
  created: { id: string; node: SceneNode }
) {
  const { id, node } = created;
  let next = addNodeToDocument(state.document, id, node);
  // Timeline focus hides unbound nodes — mark surround / bind so the plate is visible.
  next = finalizeNodeForAnimationWorkbenchFocus(next, id);
  state.document = next;
  state.dirty = true;
  state.documentPatchToken += 1;
  state.lastPatchedNodeIds = [id];
  state.lastPatchTransformOnly = false;
  // Must clear sticky Kit→doc flag — otherwise KitCanvasHost skips reconcile and
  // the new plate never maps (blank selection outline only, no gray wash / icon).
  state.lastPatchFromKitCanvas = false;
  state.selectedNodeId = id;
  state.selectedNodeIds = [id];
  // Generator chrome requires single-node selection (frame chrome otherwise wins).
  state.selectedFrameIds = [];
  if (state.document) state.document.activeFrameId = null;
  state.pendingImageSrc = null;
  state.activeTool = 'select';
}

/**
 * Record the document before a transient node becomes real content.
 * Loading/process nodes are deliberately excluded so Undo returns directly
 * to the user's pre-upload document instead of resurrecting the shimmer plate.
 */
function pushHistoryBeforeTransientNodeCommit(
  state: typeof initialState,
  nodeId: string
) {
  const current = state.document;
  if (!current?.deltaSetLike?.[nodeId]) return false;
  state.document = removeNodesFromDocument(current, [nodeId]);
  pushHistory(state);
  state.document = current;
  return true;
}

function pushNodePatchHistory(state: typeof initialState, nodeIds: string[]) {
  snapshotNodePatchHistory(state, nodeIds);
  bumpSceneRevisionIfUnlocked(state);
  bumpDocumentRevision(state);
}

export const editorReducers = {
    createTemplate(state, action) {
      const id = nanoid();
      const now = Date.now();
      const doc = normalizeDocument(
        action.payload?.document ||
          createEmptyDocument({
            width: action.payload?.width,
            height: action.payload?.height,
            emptyWorld: action.payload?.emptyWorld})
      );
      const source: TemplateSource =
        action.payload?.source === 'user' ||
        action.payload?.source === 'import' ||
        action.payload?.source === 'case' ||
        action.payload?.source === 'scratch'
          ? action.payload.source
          : 'scratch';
      const item = {
        id,
        name: action.payload?.name || '未命名作品',
        updatedAt: now,
        openedAt: now,
        source,
        document: doc};
      state.templates.unshift(item);
      state.currentId = id;
      state.document = doc;
      clearSelection(state);
      state.dirty = Boolean(action.payload?.dirty);
      state.historyPast = [];
      state.historyFuture = [];
      state.sceneReloadToken += 1;
      bumpDocumentRevision(state);
      saveTemplates(state.templates);
    },
    openTemplate(state, action) {
      const item = state.templates.find((t) => t.id === action.payload);
      if (!item) return;
      state.currentId = item.id;
      const doc = ensureDocumentContentOnCanvas(item.document as SceneDocument);
      // Enter editor with nothing selected (cases often ship activeFrameId).
      doc.activeFrameId = null;
      state.document = doc;
      // Keep library copy origin-cleared so reopen doesn't re-jump.
      item.document = doc;
      clearSelection(state);
      state.dirty = false;
      state.historyPast = [];
      state.historyFuture = [];
      state.sceneReloadToken += 1;
      bumpDocumentRevision(state);
      touchOpened(item);
      saveTemplates(state.templates);
    },
    /**
     * Bake non-zero document.x/y into node coords before first fit/paint.
     * Idempotent when origin is already 0.
     */
    bakeDocumentOrigin(state) {
      if (!state.document) return;
      const ox = Number(state.document.x) || 0;
      const oy = Number(state.document.y) || 0;
      if (ox === 0 && oy === 0) return;
      const doc = alignImportedDocumentOrigin(state.document);
      state.document = doc;
      const item = state.templates.find((t) => t.id === state.currentId);
      if (item) item.document = doc;
      state.sceneReloadToken += 1;
    },
    setDocument(state, action: PayloadAction<SceneDocument>) {
      pushHistory(state);
      state.document = normalizeDocument(
        preserveStageCanvasMeta(state.document, action.payload)
      );
      state.dirty = true;
      // Full doc replace (boolean / paste / import) — do not reuse stale patch
      // ids; Kit incremental sync would keep deleted operands as paint ghosts.
      state.lastPatchedNodeIds = [];
      state.documentPatchToken += 1;
      bumpSceneReloadIfUnlocked(state);
      // Deleted upload placeholder — drop pending id (caller aborts the HTTP request).
      if (
        state.pendingImageProcessId &&
        !state.document?.deltaSetLike?.[state.pendingImageProcessId]
      ) {
        state.pendingImageProcessId = null;
      }
      syncLibraryOnEdit(state);
      // Pencil / paste / agent may add workbench children without patchDocumentNode —
      // bake them into the timeline host after this mutator exits (same as patches).
      const focusAfterSet = String(getAnimationWorkbenchTimelineFocus() || '').trim();
      if (focusAfterSet && state.document) {
        queueEnsureAnimationFramesForDocChange(null, state.document, {
          includeFocus: true,
          skipHistory: true,
        });
      }
    },
    /**
     * Paste / duplicate commit: membership grew with known new ids.
     * Sets `lastPatchedNodeIds` so Kit can bulk-insert instead of full remount,
     * and skips `sceneReloadToken` (same idea as generator spawn).
     * History stores only inserted nodes (not a full-doc snap).
     */
    commitPastedDocument(
      state,
      action: PayloadAction<{
        document: SceneDocument;
        patchedNodeIds?: string[];
        /** Frames inserted with this paste (artboard clipboard). */
        addedFrameIds?: string[];
        /** Apply selection in the same mutator — avoids a second render that
         * used to rewrite `document` via setMixedSelection+normalizeDocument. */
        selectedNodeIds?: string[];
        selectedFrameIds?: string[];
      }>
    ) {
      const payload = action.payload;
      if (!payload?.document) return;
      const prevDoc = state.document;
      const patched = (payload.patchedNodeIds || [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      const addedFrames = (payload.addedFrameIds || [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);
      // pasteClipboardIntoDocument already normalizeDocument'd — only restore
      // stage meta if the embedded canvas forced transparent background.
      const nextDoc = preserveStageCanvasMeta(state.document, payload.document);
      pushAddHistory(state, {
        nodeIds: patched,
        frameIds: addedFrames,
        fromDocument: nextDoc,
      });
      markPastePerf('pushHistory', {
        kind: 'add',
        nodes: patched.length,
        frames: addedFrames.length,
      });
      state.document = nextDoc;
      markPastePerf('normalizeDocument', {
        skipped: true,
        nodes: Object.keys(state.document.deltaSetLike || {}).length,
      });
      state.dirty = true;
      state.lastPatchedNodeIds = patched;
      state.lastPatchTransformOnly = false;
      state.documentPatchToken += 1;
      if (
        state.pendingImageProcessId &&
        !state.document?.deltaSetLike?.[state.pendingImageProcessId]
      ) {
        state.pendingImageProcessId = null;
      }
      if (payload.selectedNodeIds || payload.selectedFrameIds) {
        const nodeIds = (payload.selectedNodeIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean);
        const frameIdsRaw = (payload.selectedFrameIds || [])
          .map((id) => String(id || '').trim())
          .filter(Boolean);
        const doc = state.document;
        const valid = new Set(
          (Array.isArray(doc.frames) ? doc.frames : [])
            .map((f) => String(f?.id || ''))
            .filter(Boolean)
        );
        const frameIds = Array.from(
          new Set(frameIdsRaw.filter((id) => valid.has(id)))
        );
        let active = frameIds[0] || null;
        if (!active && nodeIds.length) {
          const bound = String(
            doc.deltaSetLike?.[nodeIds[0]]?.attrs?.frameId || ''
          ).trim();
          if (bound && valid.has(bound)) active = bound;
          else if (doc.activeFrameId && valid.has(String(doc.activeFrameId))) {
            active = String(doc.activeFrameId);
          }
        }
        const curActive =
          doc.activeFrameId == null ? null : String(doc.activeFrameId);
        if (curActive !== active) doc.activeFrameId = active;
        state.selectedNodeIds = Array.from(new Set(nodeIds));
        state.selectedNodeId = state.selectedNodeIds[0] || null;
        state.selectedFrameIds = frameIds;
        state.frameChromeMode = 'soft';
        if (nodeIds.length) pauseLottieIfPlaying(state);
        markPastePerf('selectionInCommit', {
          selectedNodes: state.selectedNodeIds.length,
          selectedFrames: frameIds.length,
        });
      }
      syncLibraryOnEdit(state);
      markPastePerf('syncLibraryOnEdit');
      const focusAfterPaste = String(getAnimationWorkbenchTimelineFocus() || '').trim();
      if (focusAfterPaste && state.document) {
        queueEnsureAnimationFramesForDocChange(prevDoc, state.document, {
          nodeIds: patched,
          includeFocus: true,
          skipHistory: true,
        });
        markPastePerf('queueEnsureAnimationFrames', { patched: patched.length });
      }
    },
    /**
     * Delete nodes / artboards. In-flight process placeholders (upload / AI) are
     * permanent: scrubbed from history so Ctrl+Z cannot bring them back, and
     * pendingImageProcessId is cleared so the watcher stops applying results.
     */
    removeDocumentNodes(state, action) {
      if (!state.document) return;
      const requestedNodeIds = (action.payload?.nodeIds || [])
        .map((id: unknown) => String(id || '').trim())
        .filter(Boolean);
      const frameIds = (action.payload?.frameIds || [])
        .map((id: unknown) => String(id || '').trim())
        .filter(Boolean);
      const frameIdSet = new Set(frameIds);
      const frameNodeIds = Object.values(state.document.deltaSetLike || {})
        .filter((node: SceneNode) => frameIdSet.has(String(node?.attrs?.frameId || '').trim()))
        .map((node: SceneNode) => String(node?.id || '').trim())
        .filter(Boolean);
      const nodeIds = [...new Set([...requestedNodeIds, ...frameNodeIds])];
      if (!nodeIds.length && !frameIds.length) return;

      // Canvas Delete / ctx-menu remove must re-sync 动画工作台 layers so orphan
      // timeline tracks (ln → deleted node) drop with the shape.
      const ensureFrameIds = new Set<string>();
      const focusFid = String(getAnimationWorkbenchTimelineFocus() || '').trim();
      if (focusFid) ensureFrameIds.add(focusFid);
      for (const id of nodeIds) {
        const n = state.document.deltaSetLike?.[id];
        const fid = resolveAnimationFrameId(state.document, n);
        if (fid) ensureFrameIds.add(fid);
      }
      for (const fid of frameIds) {
        const frame = (Array.isArray(state.document.frames) ? state.document.frames : []).find(
          (f) => String(f?.id) === fid
        );
        if (frame && isAnimationArtboardKind(frame.kind)) ensureFrameIds.add(fid);
      }

      const ephemeralIds = nodeIds.filter((id: string) =>
        isEphemeralUploadNode(state.document?.deltaSetLike?.[id])
      );
      const undoableNodeIds = nodeIds.filter((id: string) => !ephemeralIds.includes(id));
      const hasUndoableChange = undoableNodeIds.length > 0 || frameIds.length > 0;

      if (hasUndoableChange) {
        pushRemoveHistory(state, {
          nodeIds: undoableNodeIds,
          frameIds,
          fromDocument: state.document,
        });
      }

      let next: SceneDocument | null | undefined = state.document;
      if (nodeIds.length) next = removeNodesFromDocument(next, nodeIds);
      if (frameIds.length) {
        const idSet = frameIdSet;
        const frames = (Array.isArray(next.frames) ? next.frames : []).filter(
          (f) => f && !idSet.has(String(f.id))
        );
        const active =
          next.activeFrameId && idSet.has(String(next.activeFrameId))
            ? frames[0]?.id ?? null
            : next.activeFrameId ?? null;
        next = { ...next, frames, activeFrameId: active };
        if (Array.isArray(next.stackOrder)) {
          next.stackOrder = next.stackOrder.filter((key: string) => {
            const k = String(key);
            if (!k.startsWith('frame:')) return true;
            return !idSet.has(k.slice(6));
          });
        }
        state.selectedFrameIds = state.selectedFrameIds.filter((id) => !idSet.has(id));
        if (active && !state.selectedFrameIds.includes(active)) {
          state.selectedFrameIds = [active];
        }
      }

      // Bulk remove already reconciled stack / ROOT — skip a second normalizeDocument
      // walk over the surviving map (that dominated Ctrl+X at a few hundred nodes).
      state.document = next;
      if (ephemeralIds.length) scrubNodeIdsFromHistory(state, ephemeralIds);

      const gone = new Set(nodeIds);
      if (state.selectedNodeId && gone.has(state.selectedNodeId)) state.selectedNodeId = null;
      state.selectedNodeIds = state.selectedNodeIds.filter((id) => !gone.has(id));
      if (state.imageToolPanel && gone.has(state.imageToolPanel.nodeId)) {
        state.imageToolPanel = null;
      }
      if (state.videoToolPanel && gone.has(state.videoToolPanel.nodeId)) {
        state.videoToolPanel = null;
      }
      if (state.audioToolPanel && gone.has(state.audioToolPanel.nodeId)) {
        state.audioToolPanel = null;
      }
      if (
        state.pendingImportPlaceholderId &&
        gone.has(state.pendingImportPlaceholderId)
      ) {
        state.pendingImportPlaceholderId = null;
      }
      clearPendingProcessIfNodeGone(state);

      state.dirty = true;
      // Surgical paint: deleted hosts unmount via id cull; do not remount every
      // survivor (audio WaveSurfer flash on delete / select-clear).
      state.documentPatchToken += 1;
      state.lastPatchedNodeIds = nodeIds;
      // LayerPanel / docks (not sceneReloadToken remount).
      bumpDocumentRevision(state);
      syncLibraryOnEdit(state);

      if (!state.lottiePrecompEdit?.frameId) {
        for (const fid of ensureFrameIds) {
          if (frameIdSet.has(fid)) continue;
          queueEnsureAnimationFrame(fid, { skipHistory: true });
        }
      }
    },
    setDocumentFromCanvas(state, action: PayloadAction<SceneDocument>) {
      const prevDoc = state.document;
      state.document = normalizeDocument(
        preserveStageCanvasMeta(state.document, action.payload)
      );
      state.dirty = true;
      bumpDocumentRevision(state);
      state.documentPatchToken += 1;
      applyCanvasDocPatchTokens(state, prevDoc);
      if (
        state.pendingImageProcessId &&
        !state.document?.deltaSetLike?.[state.pendingImageProcessId]
      ) {
        state.pendingImageProcessId = null;
      }
      // While LOT tab is open, canvas remounts must not autoKey/persist — that
      // rewrites host JSON every paint and deadlocks with playhead pose bake.
      if (!state.lottiePrecompEdit?.frameId) {
        persistActivePrecompSession(state);
      }
      syncLibraryOnEdit(state);
      // Shape draw / text place / bind move: bake timeline from membership delta
      // (not only open focus — move-out must refresh the plate that lost the child).
      if (!state.lottiePrecompEdit?.frameId && state.document) {
        queueEnsureAnimationFramesForDocChange(prevDoc, state.document, {
          includeFocus: true,
          skipHistory: true,
        });
      }
    },
    /** Clear SoftGlow / process attrs and force host remount (no stuck overlay). */
    clearImageProcess(state, action) {
      const nodeId = String(action.payload?.nodeId || '').trim();
      if (!state.document || !nodeId) return;
      if (!state.document.deltaSetLike?.[nodeId]) return;
      state.document = clearImageProcessAttrs(state.document, nodeId);
      state.dirty = true;
      state.sceneReloadToken += 1;
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      syncLibraryOnEdit(state);
    },
    patchDocumentNode(
      state,
      action: PayloadAction<{
        nodeId: string;
        patch: Record<string, unknown> | object;
        skipHistory?: boolean;
        skipHostReload?: boolean;
      }>
    ) {
      const { nodeId, patch, skipHistory, skipHostReload } = action.payload || {};
      if (!state.document || !nodeId) return;
      const id = String(nodeId);
      if (!state.document.deltaSetLike?.[id]) return;
      const transientOnly = isTransientNodePatch(patch);
      if (!skipHistory && !transientOnly) {
        pushNodePatchHistory(state, [id]);
      }
      // Immer draft: single-key write — O(1) structural share, no custom Proxy.
      state.document.deltaSetLike[id] = mergeNodePatch(state.document.deltaSetLike[id], patch);
      state.dirty = true;
      state.documentPatchToken += 1;
      if (!skipHistory && !transientOnly) bumpDocumentRevision(state);
      // Geometry already previewed against a mounted SVG must stay mounted. The
      // document token still updates selection/chrome, but this id skips a host
      // teardown that would briefly repaint the old centre-anchored box.
      const skipHost = shouldSkipPatchHostReload(skipHostReload, patch);
      state.lastPatchedNodeIds = skipHost ? [] : [id];
      state.lastPatchTransformOnly = !skipHost && patchSkipsHostRemount(patch);
      state.lastPatchFromKitCanvas = false;
      // Playhead bake uses skipHistory — must not persist/autoKey or LOT tab freezes
      // (pose patch → JSON rewrite → pose differs → infinite layout loop).
      if (!skipHistory && !transientOnly) persistActivePrecompSession(state);
      syncLibraryOnEdit(state);
      if (!skipHistory && !transientOnly && state.document) {
        const node = state.document.deltaSetLike?.[id];
        if (nodePatchNeedsTimelineBake(patch, node, state.document)) {
          const fid = resolveAnimationFrameId(state.document, node);
          if (fid) queueEnsureAnimationFrame(fid, { skipHistory: true });
        }
      }
    },
    /** Apply many node patches in one store write (align / distribute / flip). */
    patchDocumentNodes(state, action) {
      const { patches, skipHistory } = action.payload || {};
      if (!state.document || !Array.isArray(patches) || !patches.length) return;
      const ids: string[] = [];
      for (const item of patches) {
        if (item?.nodeId && item?.patch && !isTransientNodePatch(item.patch)) {
          ids.push(String(item.nodeId));
        }
      }
      if (!skipHistory && ids.length) pushNodePatchHistory(state, ids);
      const applied: string[] = [];
      let anyNonTransient = false;
      // Capture prior frameIds + bake signatures before merge.
      const priorFrameIds = new Set<string>();
      const priorSig = new Map<string, string>();
      for (const item of patches) {
        const id = item?.nodeId ? String(item.nodeId) : '';
        if (!id || !state.document.deltaSetLike?.[id]) continue;
        const fid = resolveAnimationFrameId(state.document, state.document.deltaSetLike[id]);
        if (fid) priorFrameIds.add(fid);
      }
      for (const fid of priorFrameIds) {
        priorSig.set(fid, frameBakeSignature(state.document, fid));
      }
      let anyBakePatch = false;
      for (const item of patches) {
        const id = item?.nodeId ? String(item.nodeId) : '';
        const patch = item?.patch;
        if (!id || !patch || !state.document.deltaSetLike?.[id]) continue;
        if (!isTransientNodePatch(patch)) anyNonTransient = true;
        const beforeNode = state.document.deltaSetLike[id];
        if (nodePatchNeedsTimelineBake(patch, beforeNode, state.document)) {
          anyBakePatch = true;
        }
        state.document.deltaSetLike[id] = mergeNodePatch(state.document.deltaSetLike[id], patch);
        applied.push(id);
      }
      if (!applied.length) return;
      state.dirty = true;
      state.documentPatchToken += 1;
      if (!skipHistory && anyNonTransient) bumpDocumentRevision(state);
      state.lastPatchedNodeIds = applied;
      state.lastPatchTransformOnly =
        applied.length > 0 &&
        patches.every((item: { patch?: unknown }) => {
          if (!item?.patch) return true;
          return isTransientNodePatch(item.patch) || patchSkipsHostRemount(item.patch);
        });
      if (!skipHistory) persistActivePrecompSession(state);
      syncLibraryOnEdit(state);
      // Bake only frames whose signature actually changed (not every focus tick).
      if (anyBakePatch && state.document) {
        const frames = new Set<string>(priorFrameIds);
        for (const nid of applied) {
          const fid = resolveAnimationFrameId(
            state.document,
            state.document.deltaSetLike?.[nid]
          );
          if (fid) frames.add(fid);
        }
        for (const fid of frames) {
          const before = priorSig.get(fid) ?? '';
          if (before === frameBakeSignature(state.document, fid)) continue;
          queueEnsureAnimationFrame(fid, { skipHistory: true });
        }
      }
    },
    setSelectedNodeId(state, action: PayloadAction<string | null | undefined>) {
      const id = action.payload ? String(action.payload) : null;
      // Preview / host: promote to parent 动画工作台 (workbench stays selectable).
      if (id && state.document) {
        const node = state.document.deltaSetLike?.[id];
        const promoteFrame =
          isAnimationFrameHostNode(node, state.document) ||
          isAnimationWorkbenchPreviewChild(state.document, node);
        if (promoteFrame) {
          const fid = String(node?.attrs?.frameId || '').trim();
          if (fid) {
            const next = normalizeDocument(state.document);
            next.activeFrameId = fid;
            state.document = next;
            state.selectedNodeId = null;
            state.selectedNodeIds = [];
            state.selectedFrameIds = [fid];
            state.frameChromeMode = frameIsEmpty(next, fid) ? 'full' : 'soft';
            pauseLottieIfPlaying(state);
            queueEnsureAnimationFrame(fid);
            return;
          }
        }
      }
      state.selectedNodeId = id;
      state.selectedNodeIds = id ? [id] : [];
      // Selecting a node clears artboard multi-select (single-target click).
      if (id) {
        state.selectedFrameIds = [];
        pauseLottieIfPlaying(state);
      }
      if (shouldClearImageToolPanelOnSelect(state.imageToolPanel, id)) {
        state.imageToolPanel = null;
      }
      if (!id || state.videoToolPanel?.nodeId !== id) {
        state.videoToolPanel = null;
      }
      if (!id || state.audioToolPanel?.nodeId !== id) {
        state.audioToolPanel = null;
      }
      if (!id || state.lottieComposePanel?.nodeId !== id) {
        state.lottieComposePanel = null;
      }
      // Keep Lottie timeline dock open across selection changes (close via X / delete).
      if (
        !id ||
        !state.shapeStylePanel?.nodeIds?.length ||
        state.shapeStylePanel.nodeIds.length !== 1 ||
        state.shapeStylePanel.nodeIds[0] !== id
      ) {
        state.shapeStylePanel = null;
      }
    },
    setSelectedNodeIds(state, action: PayloadAction<string[]>) {
      let ids = Array.isArray(action.payload) ? action.payload.filter(Boolean).map(String) : [];
      // 动画工作台内部播放宿主 / 预览态子元素：点到时改选父画板。
      if (ids.length === 1 && state.document) {
        const host = state.document.deltaSetLike?.[ids[0]!];
        if (
          isAnimationFrameHostNode(host, state.document) ||
          isAnimationWorkbenchPreviewChild(state.document, host)
        ) {
          const fid = String(host?.attrs?.frameId || '').trim();
          if (fid) {
            const next = normalizeDocument(state.document);
            next.activeFrameId = fid;
            state.document = next;
            state.selectedNodeIds = [];
            state.selectedNodeId = null;
            state.selectedFrameIds = [fid];
            // Occupied workbench → soft (no handles); empty plate keeps full chrome.
            state.frameChromeMode = frameIsEmpty(next, fid) ? 'full' : 'soft';
            pauseLottieIfPlaying(state);
            return;
          }
        }
      }
      // Drop any preview-locked workbench children from multi-select.
      if (state.document && ids.length) {
        ids = ids.filter(
          (nid) =>
            !isAnimationWorkbenchPreviewChild(
              state.document,
              state.document?.deltaSetLike?.[nid]
            )
        );
      }
      state.selectedNodeIds = Array.from(new Set(ids));
      state.selectedNodeId = state.selectedNodeIds[0] || null;
      // Do not clear selectedFrameIds here — marquee may select frames + nodes together.
      // Callers that want nodes-only should also call setSelectedFrameIds([]).
      if (ids.length) pauseLottieIfPlaying(state);
      if (shouldClearImageToolPanelOnSelect(state.imageToolPanel, ids[0] || null)) {
        state.imageToolPanel = null;
      }
      if (!ids[0] || state.videoToolPanel?.nodeId !== ids[0]) {
        state.videoToolPanel = null;
      }
      if (!ids[0] || state.audioToolPanel?.nodeId !== ids[0]) {
        state.audioToolPanel = null;
      }
      if (!ids[0] || state.lottieComposePanel?.nodeId !== ids[0]) {
        state.lottieComposePanel = null;
      }
      const panelIds = state.shapeStylePanel?.nodeIds || [];
      const same =
        panelIds.length === ids.length &&
        panelIds.every((id) => ids.includes(id)) &&
        ids.every((id) => panelIds.includes(id));
      if (!same) state.shapeStylePanel = null;
    },
    addArtboardFrame(
      state,
      action: PayloadAction<Partial<ArtboardFrame> & { activate?: boolean }>
    ) {
      if (!state.document) return;
      // Timeline focus: only the current 动画工作台 is visible — a new world
      // artboard would steal activeFrameId and vanish under focus.
      if (isNewPlateBlockedByAnimationWorkbenchFocus()) return;
      const next = normalizeDocument(state.document);
      const frames = Array.isArray(next.frames) ? [...next.frames] : [];
      const payload = action.payload || {};
      const { activate, ...framePartial } = payload;
      const frame = createFrame(framePartial);
      // Same id must not appear twice (Kit bridge used to re-push `kit1`).
      if (frames.some((f) => String(f?.id) === String(frame.id))) {
        if (activate !== false) {
          state.selectedFrameIds = [frame.id];
          state.selectedNodeId = null;
          state.selectedNodeIds = [];
          state.frameChromeMode = 'full';
        }
        return;
      }
      pushHistory(state);
      frames.push(frame);
      next.frames = frames;
      const key = `frame:${frame.id}`;
      const order = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
      if (!order.includes(key)) {
        // Current max layer + 1 (5 items → new is 6).
        next.stackOrder = [...order, key];
      }
      reconcileStackOrder(next);
      // Draw-commit = bind + clip: assign frameId to unowned overlaps so SVG
      // clip (gated on ownership + default clipContent) applies immediately.
      const bound = bindUnownedNodesToFrames(next, [frame.id]);
      if (activate !== false) {
        bound.activeFrameId = frame.id;
        state.selectedFrameIds = [frame.id];
        state.selectedNodeId = null;
        state.selectedNodeIds = [];
        state.frameChromeMode = 'full';
      }
      state.document = bound;
      state.dirty = true;
      state.sceneReloadToken += 1;
      syncLibraryOnEdit(state);
    },
    setActiveFrameId(state, action: PayloadAction<string | null | undefined>) {
      if (!state.document) return;
      const id = action.payload ? String(action.payload) : null;
      // Selection-only: do not normalizeDocument — that minted a new document
      // identity every click and re-ran Kit sync / idle full-clear (paste freeze).
      const cur =
        state.document.activeFrameId == null
          ? null
          : String(state.document.activeFrameId);
      if (cur !== id) state.document.activeFrameId = id;
      state.selectedFrameIds = id ? [id] : [];
      if (id) {
        state.selectedNodeId = null;
        state.selectedNodeIds = [];
      } else {
        state.frameChromeMode = 'soft';
      }
      state.dirty = true;
    },
    setFrameChromeMode(state, action: PayloadAction<'soft' | 'full'>) {
      state.frameChromeMode = action.payload === 'full' ? 'full' : 'soft';
    },
    /**
     * Soft context focus for an occupied artboard while nodes stay selected
     * (or after an interior plate click). Does not change selectedNodeIds /
     * selectedFrameIds — SelectionChrome stays on nodes; plate edge uses
     * activeFrameId + frameChromeMode soft.
     */
    setSoftFrameContext(state, action: PayloadAction<string | null | undefined>) {
      if (!state.document) return;
      const id = action.payload ? String(action.payload) : null;
      if (!id) {
        if (
          state.frameChromeMode === 'soft' &&
          !state.selectedFrameIds.length &&
          state.document.activeFrameId
        ) {
          state.document.activeFrameId = null;
        }
        return;
      }
      const valid = (Array.isArray(state.document.frames) ? state.document.frames : []).some(
        (f) => String(f?.id || '') === id
      );
      if (!valid) return;
      const cur =
        state.document.activeFrameId == null
          ? null
          : String(state.document.activeFrameId);
      if (cur !== id) state.document.activeFrameId = id;
      state.frameChromeMode = 'soft';
      state.dirty = true;
    },
    setSelectedFrameIds(state, action: PayloadAction<string[]>) {
      if (!state.document) return;
      const ids = Array.isArray(action.payload)
        ? [...new Set(action.payload.filter(Boolean).map(String))]
        : [];
      const doc = state.document;
      const valid = new Set(
        (Array.isArray(doc.frames) ? doc.frames : [])
          .map((f) => String(f?.id || ''))
          .filter(Boolean)
      );
      const filtered = ids.filter((id) => valid.has(id));
      const nextActive = filtered[0] || null;
      const cur =
        doc.activeFrameId == null ? null : String(doc.activeFrameId);
      if (cur !== nextActive) doc.activeFrameId = nextActive;
      state.selectedFrameIds = filtered;
      if (filtered.length) state.frameChromeMode = 'full';
      state.dirty = true;
      for (const fid of filtered) {
        const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
          (f) => String(f?.id) === fid
        );
        if (frame && isAnimationArtboardKind(frame.kind)) {
          queueEnsureAnimationFrame(fid);
        }
      }
    },
    /** Set node + artboard selection together (marquee / unified control box). */
    setMixedSelection(
      state,
      action: PayloadAction<{ nodeIds?: string[]; frameIds?: string[] }>
    ) {
      if (!state.document) return;
      let nodeIds = (action.payload?.nodeIds || []).filter(Boolean).map(String);
      const frameIdsRaw = (action.payload?.frameIds || []).filter(Boolean).map(String);
      const doc = state.document;
      const valid = new Set(
        (Array.isArray(doc.frames) ? doc.frames : [])
          .map((f) => String(f?.id || ''))
          .filter(Boolean)
      );
      // Solo 动画工作台 host / preview child → select parent frame only.
      if (nodeIds.length === 1 && !frameIdsRaw.length) {
        const host = doc.deltaSetLike?.[nodeIds[0]!];
        if (
          isAnimationFrameHostNode(host, doc) ||
          isAnimationWorkbenchPreviewChild(doc, host)
        ) {
          const fid = String(host?.attrs?.frameId || '').trim();
          if (fid && valid.has(fid)) {
            const cur =
              doc.activeFrameId == null ? null : String(doc.activeFrameId);
            if (cur !== fid) doc.activeFrameId = fid;
            state.selectedNodeIds = [];
            state.selectedNodeId = null;
            state.selectedFrameIds = [fid];
            state.frameChromeMode = frameIsEmpty(doc, fid) ? 'full' : 'soft';
            pauseLottieIfPlaying(state);
            queueEnsureAnimationFrame(fid);
            return;
          }
        }
      }
      const frameIds = Array.from(new Set(frameIdsRaw.filter((id) => valid.has(id))));
      let active = frameIds[0] || null;
      if (!active && nodeIds.length) {
        const bound = String(doc.deltaSetLike?.[nodeIds[0]]?.attrs?.frameId || '').trim();
        if (bound && valid.has(bound)) active = bound;
        else if (doc.activeFrameId && valid.has(String(doc.activeFrameId))) {
          active = String(doc.activeFrameId);
        }
      }
      const curActive =
        doc.activeFrameId == null ? null : String(doc.activeFrameId);
      if (curActive !== active) doc.activeFrameId = active;
      state.selectedNodeIds = Array.from(new Set(nodeIds));
      state.selectedNodeId = state.selectedNodeIds[0] || null;
      state.selectedFrameIds = frameIds;
      // Multi artboard / 动画, or mixed frames+nodes: one union control box so
      // drag moves every member together. Soft is only for single occupied-plate
      // interior focus (no handles).
      if (
        frameIds.length > 1 ||
        (frameIds.length >= 1 && state.selectedNodeIds.length >= 1)
      ) {
        state.frameChromeMode = 'full';
      } else {
        // Marquee / interior work stays soft — title / layer panel set full explicitly.
        state.frameChromeMode = 'soft';
      }
      if (nodeIds.length) pauseLottieIfPlaying(state);
      if (shouldClearImageToolPanelOnSelect(state.imageToolPanel, nodeIds[0] || null)) {
        state.imageToolPanel = null;
      }
      if (!nodeIds[0] || state.videoToolPanel?.nodeId !== nodeIds[0]) {
        state.videoToolPanel = null;
      }
      if (!nodeIds[0] || state.audioToolPanel?.nodeId !== nodeIds[0]) {
        state.audioToolPanel = null;
      }
      const panelIds = state.shapeStylePanel?.nodeIds || [];
      const same =
        panelIds.length === nodeIds.length &&
        panelIds.every((id: string) => nodeIds.includes(id)) &&
        nodeIds.every((id: string) => panelIds.includes(id));
      if (!same) state.shapeStylePanel = null;
    },
    /** Remove artboards and every scene node bound to them (`attrs.frameId`). */
    removeArtboardFrames(state, action) {
      if (!state.document) return;
      const ids: string[] = [];
      if (Array.isArray(action.payload)) ids.push(...action.payload.filter(Boolean).map(String));
      else if (action.payload) ids.push(String(action.payload));
      if (!ids.length) return;

      const nodeIds = nodeIdsBoundToFrames(state.document, ids);
      const ephemeralIds = nodeIds.filter((id) =>
        isEphemeralUploadNode(state.document?.deltaSetLike?.[id])
      );
      const undoableNodeIds = nodeIds.filter((id) => !ephemeralIds.includes(id));
      pushRemoveHistory(state, {
        nodeIds: undoableNodeIds,
        frameIds: ids,
        fromDocument: state.document,
      });

      let next = removeNodesFromDocument(state.document, nodeIds);
      next = normalizeDocument(next);
      const idSet = new Set(ids);
      const frames = (Array.isArray(next.frames) ? next.frames : []).filter(
        (f) => f && !idSet.has(f.id)
      );
      next.frames = frames;
      if (next.activeFrameId && idSet.has(next.activeFrameId)) {
        next.activeFrameId = frames[0]?.id ?? null;
      }
      if (Array.isArray(next.stackOrder)) {
        next.stackOrder = next.stackOrder.filter((key: string) => {
          const k = String(key);
          if (!k.startsWith('frame:')) return true;
          return !idSet.has(k.slice(6));
        });
      }
      state.selectedFrameIds = (state.selectedFrameIds || []).filter((id) => !idSet.has(id));
      if (next.activeFrameId && !state.selectedFrameIds.includes(next.activeFrameId)) {
        state.selectedFrameIds = next.activeFrameId ? [next.activeFrameId] : [];
      }

      const nodeIdSet = new Set(nodeIds);
      if (state.selectedNodeId && nodeIdSet.has(state.selectedNodeId)) {
        state.selectedNodeId = null;
      }
      state.selectedNodeIds = (state.selectedNodeIds || []).filter(
        (id) => !nodeIdSet.has(id)
      );
      if (state.imageToolPanel && nodeIdSet.has(state.imageToolPanel.nodeId)) {
        state.imageToolPanel = null;
      }
      if (state.videoToolPanel && nodeIdSet.has(state.videoToolPanel.nodeId)) {
        state.videoToolPanel = null;
      }
      if (state.audioToolPanel && nodeIdSet.has(state.audioToolPanel.nodeId)) {
        state.audioToolPanel = null;
      }
      if (state.lottieComposePanel && nodeIdSet.has(state.lottieComposePanel.nodeId)) {
        state.lottieComposePanel = null;
      }
      if (state.lottieTimelinePanel && nodeIdSet.has(state.lottieTimelinePanel.nodeId)) {
        state.lottieTimelinePanel = null;
        clearLottiePrecompEdit(state);
      }
      if (state.animationFramePanel && idSet.has(state.animationFramePanel.frameId)) {
        state.animationFramePanel = null;
      }
      if (
        state.pendingImportPlaceholderId &&
        nodeIdSet.has(state.pendingImportPlaceholderId)
      ) {
        state.pendingImportPlaceholderId = null;
      }
      if (ephemeralIds.length) scrubNodeIdsFromHistory(state, ephemeralIds);
      state.document = next;
      clearPendingProcessIfNodeGone(state);
      state.dirty = true;
      // Same as removeDocumentNodes — avoid remounting surviving media plates.
      state.documentPatchToken += 1;
      state.lastPatchedNodeIds = nodeIds;
      syncLibraryOnEdit(state);
    },
    renameArtboardFrame(
      state,
      action: PayloadAction<{ id: string; name: string; skipHistory?: boolean }>
    ) {
      if (!state.document) return;
      const { id, name, skipHistory } = action.payload || {};
      if (!id) return;
      if (!skipHistory) pushHistory(state);
      const next = normalizeDocument(state.document);
      const frames = Array.isArray(next.frames) ? next.frames : [];
      const frame = frames.find((f) => f.id === id);
      if (frame) frame.name = String(name || frame.name || 'Frame');
      next.frames = frames;
      state.document = next;
      state.dirty = true;
      if (!skipHistory) bumpDocumentRevision(state);
      syncLibraryOnEdit(state);
    },
    updateArtboardFrame(state, action) {
      if (!state.document) return;
      const { id, patch, skipHistory } = action.payload || {};
      if (!id || !patch) return;
      if (!skipHistory && !isTransientFramePatch(patch)) pushHistory(state);
      const next = normalizeDocument(state.document);
      const frames = Array.isArray(next.frames) ? next.frames : [];
      const frame = frames.find((f) => f.id === id);
      if (frame) Object.assign(frame, patch);
      next.frames = frames;
      state.document = next;
      state.dirty = true;
      if (!skipHistory && !isTransientFramePatch(patch)) bumpDocumentRevision(state);
      // Frame plates repaint in place. Only geometry of a clipping frame needs a
      // scene reload so dependent clip paths are rebuilt.
      // skipHistory previews (live drag) also skip SVG remount — commit bumps token.
      const keys = Object.keys(patch);
      const chromeKeys = new Set([
        'x',
        'y',
        'width',
        'height',
        'locked',
        'hidden',
        'processStatus',
        'processLabel',
        'processKind',
      ]);
      const onlyChrome =
        keys.length > 0 &&
        keys.every((k) => chromeKeys.has(k)) &&
        !(Boolean(frame?.clipContent) &&
          (keys.includes('x') ||
            keys.includes('y') ||
            keys.includes('width') ||
            keys.includes('height')));
      if (!onlyChrome && !skipHistory) state.sceneReloadToken += 1;
      syncLibraryOnEdit(state);
    },
    /** Batch frame patches in one document write (multi-select drag / lock). */
    updateArtboardFrames(state, action) {
      if (!state.document) return;
      const { patches, skipHistory } = action.payload || {};
      if (!Array.isArray(patches) || !patches.length) return;
      const hasUndoablePatch = patches.some((item: { patch?: unknown }) => {
        return Boolean(item?.patch) && !isTransientFramePatch(item.patch);
      });
      if (!skipHistory && hasUndoablePatch) pushHistory(state);
      const next = normalizeDocument(state.document);
      const frames = Array.isArray(next.frames) ? next.frames : [];
      const byId = new Map<string, ArtboardFrame>(frames.map((f) => [String(f?.id), f]));
      const chromeKeys = new Set([
        'x',
        'y',
        'width',
        'height',
        'locked',
        'hidden',
        'processStatus',
        'processLabel',
        'processKind',
      ]);
      let needsReload = false;
      const geomMovedIds: string[] = [];
      for (const item of patches) {
        const id = item?.id;
        const patch = item?.patch;
        if (!id || !patch) continue;
        const frame = byId.get(String(id));
        if (!frame) continue;
        Object.assign(frame, patch);
        const keys = Object.keys(patch);
        if (
          keys.includes('x') ||
          keys.includes('y') ||
          keys.includes('width') ||
          keys.includes('height')
        ) {
          geomMovedIds.push(String(id));
        }
        const onlyChrome =
          keys.length > 0 &&
          keys.every((k) => chromeKeys.has(k)) &&
          !(Boolean(frame.clipContent) &&
            (keys.includes('x') ||
              keys.includes('y') ||
              keys.includes('width') ||
              keys.includes('height')));
        if (!onlyChrome && !skipHistory) needsReload = true;
      }
      next.frames = frames;
      state.document = next;
      state.dirty = true;
      if (!skipHistory && hasUndoablePatch) bumpDocumentRevision(state);
      if (needsReload) state.sceneReloadToken += 1;
      // skipHistory plate drag: child nodes are unchanged but world paint boxes
      // move under frameLocal — mark bound ids so Kit refresh.
      if (geomMovedIds.length && isFrameLocalCoordSpace(next)) {
        const bound = nodeIdsBoundToFrames(next, geomMovedIds);
        if (bound.length) {
          state.lastPatchedNodeIds = bound;
          state.documentPatchToken += 1;
          state.lastPatchTransformOnly = true;
        }
      }
      syncLibraryOnEdit(state);
    },
    /** Snapshot history without changing the document (e.g. before a live frame drag). */
    pushEditorHistory(state) {
      if (!state.document) return;
      pushHistory(state);
    },
    /** Bump collab/layer revision after skipHistory patches that still commit user geometry. */
    touchDocumentRevision(state) {
      bumpDocumentRevision(state);
    },
    /** AI DesignTransaction: freeze user revision while tool_ops apply. */
    beginAiSceneMutation(state) {
      state.aiMutationLock = (state.aiMutationLock || 0) + 1;
    },
    endAiSceneMutation(state) {
      state.aiMutationLock = Math.max(0, (state.aiMutationLock || 0) - 1);
      if (state.aiMutationLock === 0) {
        state.sceneRevision = (state.sceneRevision || 0) + 1;
        // One remount + SoA flush after the whole transaction (not per tool_op).
        state.sceneReloadToken = (Number(state.sceneReloadToken) || 0) + 1;
        bumpDocumentRevision(state);
        requestAiFlush();
      }
    },
    beginCanvasApplyLock(state) {
      state.canvasApplyLock = (state.canvasApplyLock || 0) + 1;
    },
    endCanvasApplyLock(state) {
      state.canvasApplyLock = Math.max(0, (state.canvasApplyLock || 0) - 1);
    },
    renameTemplate(state, action) {
      const item = state.templates.find((t) => t.id === state.currentId);
      if (!item) return;
      const next = String(action.payload ?? '');
      if (item.name === next) return;
      item.name = next;
      item.updatedAt = Date.now();
      // Renaming is an explicit claim → show in Projects.
      if (isSessionTemplate(item)) item.source = 'user';
      // Name is synced via cloud flush (same path as document edits).
      state.dirty = true;
      saveTemplates(state.templates);
    },
    persistCurrent(state, action) {
      if (!state.currentId || !state.document) return;
      const item = state.templates.find((t) => t.id === state.currentId);
      if (!item) return;
      // Autosave (keepDirty) flush already snapshots store.document into IDB —
      // skip a second O(doc) clone that raced paste paint at 2k+ nodes.
      if (!action.payload?.keepDirty) {
        item.document = cloneDocument(state.document) ?? state.document;
      }
      item.updatedAt = Date.now();
      if (isSessionTemplate(item)) item.source = 'user';
      // keepDirty: cloud push not ACKed yet — stay dirty so refresh-before-upload retries.
      if (!action.payload?.keepDirty) state.dirty = false;
      saveTemplates(state.templates);
    },
    clearEditorDirty(state) {
      state.dirty = false;
    },
    /**
     * Apply a remote Yjs scene snapshot. No history push, no dirty flag —
     * collab room owns live truth; persistence is handled by CollabRoomProvider.
     */
    applyCollabDocument(state, action) {
      if (!action.payload) return;
      state.document = normalizeDocument(
        preserveStageCanvasMeta(
          state.document,
          coerceSceneDocumentInput(action.payload)
        )
      );
      state.dirty = false;
      state.sceneReloadToken += 1;
      if (
        state.pendingImageProcessId &&
        !state.document?.deltaSetLike?.[state.pendingImageProcessId]
      ) {
        state.pendingImageProcessId = null;
      }
      bumpSceneRevisionForRemoteCollab(state);
      syncLibraryOnEdit(state);
    },
    /**
     * Granular remote Yjs apply: COW node/frame/meta patches without full remount
     * when possible. Payload shape matches `CollabSceneDiff` from sceneYBridge.
     */
    applyCollabScenePatch(state, action) {
      const patch = action.payload;
      if (!patch || !state.document) return;
      if (patch.mode === 'full' && patch.scene) {
        state.document = normalizeDocument(
          preserveStageCanvasMeta(
            state.document,
            coerceSceneDocumentInput(patch.scene)
          )
        );
        state.dirty = false;
        state.sceneReloadToken += 1;
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = [];
        if (
          state.pendingImageProcessId &&
          !state.document?.deltaSetLike?.[state.pendingImageProcessId]
        ) {
          state.pendingImageProcessId = null;
        }
        bumpSceneRevisionForRemoteCollab(state);
        syncLibraryOnEdit(state);
        return;
      }

      let doc: SceneDocument = state.document;
      const touched: string[] = [];

      if (patch.meta && typeof patch.meta === 'object') {
        doc = { ...doc, ...patch.meta };
      }

      const delta = { ...(doc.deltaSetLike || {}) };
      const upsertNodes =
        patch.upsertNodes && typeof patch.upsertNodes === 'object' ? patch.upsertNodes : {};
      for (const [id, node] of Object.entries(upsertNodes)) {
        if (!id || id === 'ROOT' || !node || typeof node !== 'object') continue;
        delta[id] = node as unknown as SceneNode;
        touched.push(String(id));
      }
      for (const raw of Array.isArray(patch.removeNodeIds) ? patch.removeNodeIds : []) {
        const id = String(raw || '');
        if (!id || id === 'ROOT') continue;
        if (id in delta) {
          delete delta[id];
          touched.push(id);
        }
      }

      if (Array.isArray(patch.pageChildren)) {
        const children = patch.pageChildren.map(String);
        const pageId = String(doc.activePageId || doc.pages?.[0]?.id || 'page');
        delta.ROOT = {
          id: 'ROOT',
          key: 'entry',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          attrs: {},
          ...(delta.ROOT || {}),
          children};
        const pages = Array.isArray(doc.pages) ? [...doc.pages] : [{ id: pageId, children }];
        if (pages[0]) pages[0] = { ...pages[0], id: pageId, children };
        else pages.push({ id: pageId, children });
        doc = { ...doc, pages, activePageId: pageId };
      }

      if (Array.isArray(patch.stackOrder)) {
        doc = { ...doc, stackOrder: patch.stackOrder.map(String) };
      }

      const frameById = new Map<string, any>();
      for (const frame of Array.isArray(doc.frames) ? doc.frames : []) {
        if (frame?.id) frameById.set(String(frame.id), frame);
      }
      const upsertFrames =
        patch.upsertFrames && typeof patch.upsertFrames === 'object' ? patch.upsertFrames : {};
      for (const [id, frame] of Object.entries(upsertFrames)) {
        if (!id || !frame || typeof frame !== 'object') continue;
        frameById.set(String(id), frame);
      }
      for (const raw of Array.isArray(patch.removeFrameIds) ? patch.removeFrameIds : []) {
        frameById.delete(String(raw || ''));
      }
      if (
        Object.keys(upsertFrames).length ||
        (Array.isArray(patch.removeFrameIds) && patch.removeFrameIds.length)
      ) {
        doc = { ...doc, frames: [...frameById.values()] };
      }

      doc = { ...doc, deltaSetLike: delta };
      state.document = doc;
      state.dirty = false;
      state.documentPatchToken += 1;
      state.lastPatchedNodeIds = touched;
      if (
        state.pendingImageProcessId &&
        !state.document?.deltaSetLike?.[state.pendingImageProcessId]
      ) {
        state.pendingImageProcessId = null;
      }
      bumpSceneRevisionForRemoteCollab(state);
      syncLibraryOnEdit(state);
    },
    importDocument(
      state,
      action: PayloadAction<{
        id?: string;
        name?: string;
        document?: unknown;
        source?: TemplateSource | string;
        originCaseId?: string;
        dirty?: boolean;
      } | null | undefined>
    ) {
      const payload = action.payload || {};
      const source: TemplateSource =
        payload.source === 'case' ||
        payload.source === 'import' ||
        payload.source === 'user' ||
        payload.source === 'scratch'
          ? payload.source
          : 'import';
      const originCaseId = payload.originCaseId
        ? String(payload.originCaseId)
        : undefined;
      const now = Date.now();

      // Reuse an unclaimed case session instead of duplicating Projects noise.
      if (source === 'case' && originCaseId) {
        const existing = state.templates.find(
          (t) => t.originCaseId === originCaseId && t.source === 'case'
        );
        if (existing) {
          const doc = documentFromExternalPayload(payload.document);
          doc.activeFrameId = null;
          existing.document = doc;
          existing.name = payload.name || existing.name || '导入作品';
          existing.updatedAt = now;
          touchOpened(existing);
          state.currentId = existing.id;
          state.document = doc;
          clearSelection(state);
          state.dirty = false;
          state.historyPast = [];
          state.historyFuture = [];
          state.sceneReloadToken += 1;
          bumpDocumentRevision(state);
          saveTemplates(state.templates);
          return;
        }
      }

      const id = payload.id ? String(payload.id) : nanoid();
      const doc = documentFromExternalPayload(payload.document);
      // Inspiration / import → editor: do not pre-select an artboard.
      doc.activeFrameId = null;
      const existingById = state.templates.find((t) => t.id === id);
      if (existingById) {
        existingById.document = doc;
        existingById.name = payload.name || existingById.name || '导入作品';
        existingById.updatedAt = now;
        touchOpened(existingById);
        state.currentId = id;
        state.document = doc;
        clearSelection(state);
        state.dirty = Boolean(payload.dirty);
        state.historyPast = [];
        state.historyFuture = [];
        state.sceneReloadToken += 1;
        bumpDocumentRevision(state);
        saveTemplates(state.templates);
        return;
      }
      const item: EditorLibraryItem = {
        id,
        name: payload.name || '导入作品',
        updatedAt: now,
        openedAt: now,
        source,
        document: doc};
      if (originCaseId) item.originCaseId = originCaseId;
      state.templates.unshift(item);
      state.currentId = id;
      state.document = doc;
      clearSelection(state);
      state.dirty = Boolean(payload.dirty);
      state.historyPast = [];
      state.historyFuture = [];
      state.sceneReloadToken += 1;
      bumpDocumentRevision(state);
      saveTemplates(state.templates);
    },
    /** Spawn blank loading plate for file import (image). */
    startImportPlaceholder(state, action) {
      if (!state.document) return;
      const { document: next, id } = spawnImportPlaceholderNode(state.document, {
        label: action.payload?.label || '解析设计文件中',
        width: action.payload?.width,
        height: action.payload?.height,
        x: action.payload?.x,
        y: action.payload?.y});
      if (!id) return;
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.pendingImportPlaceholderId = id;
      // Agent design placeholder should not steal the user's current selection.
      if (action.payload?.select !== false) {
        state.selectedNodeId = id;
        state.selectedNodeIds = [id];
        state.activeTool = 'select';
      }
    },
    /** Drop placeholder and merge parsed document at its position. */
    finishImportPlaceholder(state, action) {
      const incoming = action.payload?.document;
      const id = state.pendingImportPlaceholderId;
      let offsetX = Number(action.payload?.offsetX);
      let offsetY = Number(action.payload?.offsetY);
      if (!Number.isFinite(offsetX)) offsetX = 40;
      if (!Number.isFinite(offsetY)) offsetY = 40;

      if (state.document && id) {
        const ph = state.document.deltaSetLike?.[id];
        if (ph) {
          offsetX = Number(ph.x) || offsetX;
          offsetY = Number(ph.y) || offsetY;
        }
        state.document = removeNodesFromDocument(state.document, [id]);
        scrubNodeIdsFromHistory(state, [id]);
        if (incoming) pushHistory(state);
      } else if (incoming) {
        pushHistory(state);
      }

      state.pendingImportPlaceholderId = null;

      if (!incoming) {
        state.dirty = true;
        state.sceneReloadToken += 1;
        clearSelection(state);
        return;
      }

      if (!state.document) {
        state.document = alignImportedDocumentOrigin(coerceSceneDocumentInput(incoming));
      } else {
        state.document = mergeImportedIntoDocument(state.document, coerceSceneDocumentInput(incoming), {
          offsetX,
          offsetY});
      }
      state.dirty = true;
      clearSelection(state);
      state.sceneReloadToken += 1;
    },
    /** Remove failed/cancelled import placeholder. */
    cancelImportPlaceholder(state) {
      const id = state.pendingImportPlaceholderId;
      if (state.document && id) {
        state.document = removeNodesFromDocument(state.document, [id]);
        scrubNodeIdsFromHistory(state, [id]);
        state.dirty = true;
        state.sceneReloadToken += 1;
        if (state.selectedNodeId === id) clearSelection(state);
      }
      state.pendingImportPlaceholderId = null;
    },
    /** Ephemeral AI overlay. Never writes SceneDocument. */
    setAiOperationState(state, action: PayloadAction<AiOperationState | null>) {
      const next = action.payload;
      if (!next || !next.active) {
        state.aiOperationState = null;
        return;
      }
      const transactionId = String(next.transactionId || '').trim();
      const frameId = next.frameId == null ? next.frameId : String(next.frameId).trim() || null;
      const nodeId = next.nodeId == null ? next.nodeId : String(next.nodeId).trim() || null;
      const actionName = String(next.action || '').trim();
      const label = String(next.label || '').trim();
      state.aiOperationState = {
        active: true,
        ...(transactionId ? { transactionId } : {}),
        frameId: frameId ?? null,
        nodeId: nodeId ?? null,
        ...(actionName ? { action: actionName } : {}),
        ...(label ? { label } : {})};
    },
    /** Clear AI overlay; also strip leftover pre-PR9 frame generating chrome. */
    clearArtboardGenerating(state) {
      state.aiOperationState = null;
      if (!state.document) return;
      const frames = Array.isArray(state.document.frames) ? state.document.frames : [];
      let cleared = false;
      for (const f of frames) {
        if (!f || String(f.processStatus || '') !== 'running') continue;
        delete f.processStatus;
        delete f.processLabel;
        delete f.processKind;
        cleared = true;
      }
      if (cleared) {
        state.document = { ...state.document, frames: [...frames] };
        state.dirty = true;
      }
    },
    /** Merge image-import parse result into the open canvas. */
    mergeImportedDocument(state, action) {
      const incoming = action.payload?.document;
      if (!incoming) return;
      pushHistory(state);
      const coerced = coerceSceneDocumentInput(incoming);
      if (!state.document) {
        state.document = alignImportedDocumentOrigin(coerced);
      } else {
        state.document = mergeImportedIntoDocument(state.document, coerced, {
          offsetX: Number(action.payload?.offsetX) || 40,
          offsetY: Number(action.payload?.offsetY) || 40});
      }
      state.dirty = true;
      clearSelection(state);
      state.sceneReloadToken += 1;
    },
    deleteTemplate(state, action) {
      state.templates = state.templates.filter((t) => t.id !== action.payload);
      saveTemplates(state.templates);
      if (state.currentId === action.payload) {
        state.currentId = null;
        state.document = null;
        clearSelection(state);
        state.dirty = false;
      }
    },
    deleteTemplates(state, action) {
      const ids = new Set(Array.isArray(action.payload) ? action.payload : []);
      if (!ids.size) return;
      state.templates = state.templates.filter((t) => !ids.has(t.id));
      saveTemplates(state.templates);
      if (state.currentId && ids.has(state.currentId)) {
        state.currentId = null;
        state.document = null;
        clearSelection(state);
        state.dirty = false;
      }
    },
    renameTemplateById(state, action) {
      const { id, name, skipUpdatedAt } = action.payload || {};
      if (!id) return;
      const item = state.templates.find((t) => t.id === id);
      if (!item) return;
      const next = String(name || item.name || '未命名作品');
      if (item.name === next) return;
      item.name = next;
      if (!skipUpdatedAt) item.updatedAt = Date.now();
      if (isSessionTemplate(item)) item.source = 'user';
      if (state.currentId === id) state.dirty = true;
      saveTemplates(state.templates);
    },
    /**
     * Drop in-memory open project + sessions (logout / guest).
     * Home / Mine lists live in Query — do not keep owned rows after sign-out.
     */
    clearProjectsLibrary(state) {
      state.templates = [];
      state.currentId = null;
      state.document = null;
      state.dirty = false;
      state.historyPast = [];
      state.historyFuture = [];
      state.selectedNodeId = null;
      state.selectedNodeIds = [];
      state.selectedFrameIds = [];
      state.sceneReloadToken += 1;
      state.documentPatchToken += 1;
      state.lastPatchedNodeIds = [];
      saveTemplates();
    },
    undo(state) {
      if (!state.historyPast.length || !state.document) return;
      const prevDoc = state.document;
      const entry = asHistoryEntry(state.historyPast.pop());
      if (entry.kind === 'nodes') {
        const after: Record<string, SceneNode> = {};
        for (const id of Object.keys(entry.before)) {
          const cur = state.document.deltaSetLike?.[id];
          if (cur) after[id] = cloneNodeForHistory(cur);
        }
        state.historyFuture.unshift({ kind: 'nodes', before: after });
        state.document = restoreNodesIntoDocument(state.document, entry.before);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = Object.keys(entry.before);
      } else if (entry.kind === 'add') {
        // Redo re-inserts the same add payload (no O(doc) snap).
        state.historyFuture.unshift(entry);
        const removedIds = Object.keys(entry.nodes || {});
        state.document = undoAddHistoryEntry(state.document, entry);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = removedIds;
        // Surgical remove — do not remount survivors (audio / hosts flash).
      } else if (entry.kind === 'remove') {
        // Undo cut/delete: restore removed nodes (same payload as paste-add redo).
        state.historyFuture.unshift(entry);
        state.document = redoAddHistoryEntry(state.document, entry);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = Object.keys(entry.nodes || {});
      } else {
        const currentSnap = cloneDocument(state.document);
        if (currentSnap) {
          state.historyFuture.unshift({
            kind: 'snap',
            doc: currentSnap});
        }
        state.document = entry.doc;
        state.sceneReloadToken += 1;
        state.lastPatchedNodeIds = [];
      }
      state.dirty = true;
      // Timeline dock / LayerPanel use useEditorDocumentOnCommit (documentRevision).
      // Without this bump, canvas remounts (sceneReloadToken) but 「图层」 stays stale
      // after delete→undo (empty list while restored shapes are visible).
      bumpDocumentRevision(state);
      // Drop selection that pointed at nodes removed by this undo (e.g. detach).
      const ds = state.document?.deltaSetLike || {};
      const ids = (state.selectedNodeIds || []).filter((id: string) => Boolean(ds[id]));
      state.selectedNodeIds = ids;
      state.selectedNodeId = ids[0] || null;
      clearPendingProcessIfNodeGone(state);
      syncLibraryOnEdit(state);
      if (!state.lottiePrecompEdit?.frameId && state.document) {
        queueEnsureAnimationFramesForDocChange(prevDoc, state.document, {
          includeFocus: true,
          skipHistory: true,
        });
      }
    },
    redo(state) {
      if (!state.historyFuture.length || !state.document) return;
      const prevDoc = state.document;
      const entry = asHistoryEntry(state.historyFuture.shift());
      if (entry.kind === 'nodes') {
        const before: Record<string, SceneNode> = {};
        for (const id of Object.keys(entry.before)) {
          const cur = state.document.deltaSetLike?.[id];
          if (cur) before[id] = cloneNodeForHistory(cur);
        }
        state.historyPast.push({ kind: 'nodes', before });
        state.document = restoreNodesIntoDocument(state.document, entry.before);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = Object.keys(entry.before);
      } else if (entry.kind === 'add') {
        state.historyPast.push(entry);
        trimHistoryPast(state);
        state.document = redoAddHistoryEntry(state.document, entry);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = Object.keys(entry.nodes || {});
      } else if (entry.kind === 'remove') {
        // Redo cut/delete: drop the nodes again.
        state.historyPast.push(entry);
        trimHistoryPast(state);
        const removedIds = Object.keys(entry.nodes || {});
        state.document = undoAddHistoryEntry(state.document, entry);
        state.documentPatchToken += 1;
        state.lastPatchedNodeIds = removedIds;
      } else {
        const currentSnap = cloneDocument(state.document);
        if (currentSnap) {
          state.historyPast.push({ kind: 'snap', doc: currentSnap });
        }
        state.document = entry.doc;
        state.sceneReloadToken += 1;
        state.lastPatchedNodeIds = [];
      }
      state.dirty = true;
      bumpDocumentRevision(state);
      const ds = state.document?.deltaSetLike || {};
      const ids = (state.selectedNodeIds || []).filter((id: string) => Boolean(ds[id]));
      state.selectedNodeIds = ids;
      state.selectedNodeId = ids[0] || null;
      clearPendingProcessIfNodeGone(state);
      syncLibraryOnEdit(state);
      if (!state.lottiePrecompEdit?.frameId && state.document) {
        queueEnsureAnimationFramesForDocChange(prevDoc, state.document, {
          includeFocus: true,
          skipHistory: true,
        });
      }
    },
    setActiveTool(state, action: PayloadAction<string>) {
      state.activeTool = action.payload;
      if (action.payload !== 'image') state.pendingImageSrc = null;
    },
    setGridMode(state, action: PayloadAction<boolean>) {
      state.isGridMode = Boolean(action.payload);
    },
    setShapeKind(state, action) {
      state.shapeKind = action.payload;
      state.activeTool = action.payload === 'image' ? 'image' : 'shape';
    },
    setPendingImageSrc(state, action) {
      state.pendingImageSrc = action.payload;
      if (action.payload) state.activeTool = 'image';
    },
    setCanvasSize(state, action) {
      if (!state.document) return;
      const { width, height } = action.payload || {};
      pushHistory(state);
      state.document = setDocumentSize(
        state.document,
        width ?? state.document.width,
        height ?? state.document.height
      );
      state.dirty = true;
      state.sceneReloadToken += 1;
    },
    setCanvasMeta(state, action: PayloadAction<DocumentCanvasMetaPatch>) {
      if (!state.document) return;
      pushHistory(state);
      state.document = setDocumentCanvasMeta(state.document, action.payload || {});
      state.dirty = true;
      // Background is stage CSS — do not bump sceneReloadToken (that remounts every
      // RcbShapeHost and makes in-flight canvas edits appear to "vanish").
      syncLibraryOnEdit(state);
    },
    /** Spawn canvas Image Generator plate at given document coords. */
    spawnImageGenerator(state, action) {
      if (!state.document) return;
      pushHistory(state);
      commitSpawnedGenerator(
        state,
        createImageGeneratorNode({
          x: action.payload?.x,
          y: action.payload?.y,
          width: action.payload?.width,
          height: action.payload?.height,
          name: action.payload?.name})
      );
    },
    /** Spawn canvas Video Generator plate at given document coords. */
    spawnVideoGenerator(state, action) {
      if (!state.document) return;
      if (isAvBlockedByAnimationWorkbenchFocus()) return;
      pushHistory(state);
      commitSpawnedGenerator(
        state,
        createVideoGeneratorNode({
          x: action.payload?.x,
          y: action.payload?.y,
          width: action.payload?.width,
          height: action.payload?.height,
          name: action.payload?.name})
      );
    },
    /** Spawn 动画工作台 as a real artboard (same clip / children as 画板). */
    spawnAnimationBoard(state, action) {
      if (!state.document) return;
      // Already inside a focused workbench — do not spawn an empty second board
      // (that lands as a blank plate and closes the open timeline).
      if (isNewPlateBlockedByAnimationWorkbenchFocus()) return;
      if (!action.payload?.skipHistory) pushHistory(state);
      const width = Math.max(1, Math.round(Number(action.payload?.width) || 364));
      const height = Math.max(1, Math.round(Number(action.payload?.height) || 364));
      const next = normalizeDocument(state.document);
      const frames = Array.isArray(next.frames) ? [...next.frames] : [];
      const frame = createFrame({
        x: action.payload?.x,
        y: action.payload?.y,
        width,
        height,
        name: action.payload?.name || '动画工作台',
        kind: 'animation',
        clipContent: true});
      frames.push(frame);
      next.frames = frames;
      const key = `frame:${frame.id}`;
      const order = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
      // Current max layer + 1 (5 items → new is 6).
      if (!order.includes(key)) {
        next.stackOrder = [...order, key];
      }
      reconcileStackOrder(next);
      const bound = bindUnownedNodesToFrames(next, [frame.id]);
      bound.activeFrameId = frame.id;
      state.selectedFrameIds = [frame.id];
      state.selectedNodeId = null;
      state.selectedNodeIds = [];
      state.frameChromeMode = 'full';
      state.document = bound;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.activeTool = 'select';
      state.lottieComposePanel = null;
      state.animationFramePanel = null;
      state.lottieTimelinePanel = null;
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.shapeStylePanel = null;
      state.pendingImageSrc = null;
      // Host media must exist immediately so the plate toolbar shows transport
      // (关键帧 + play strip), not the empty-board stub that appears until move.
      editorReducers.ensureAnimationFrameMedia(state, { payload: { frameId: frame.id, skipHistory: true }});
      syncLibraryOnEdit(state);
    },
    /** Spawn AI Lottie generator plate (composer) — secondary to 动画工作台. */
    spawnLottieGeneratorPlate(state, action) {
      if (!state.document) return;
      pushHistory(state);
      commitSpawnedGenerator(
        state,
        createLottieGeneratorNode({
          x: action.payload?.x,
          y: action.payload?.y,
          width: action.payload?.width,
          height: action.payload?.height,
          name: action.payload?.name})
      );
    },
    /** Spawn canvas Audio Generator plate at given document coords. */
    spawnAudioGenerator(state, action) {
      if (!state.document) return;
      if (isAvBlockedByAnimationWorkbenchFocus()) return;
      pushHistory(state);
      commitSpawnedGenerator(
        state,
        createAudioGeneratorNode({
          x: action.payload?.x,
          y: action.payload?.y,
          width: action.payload?.width,
          height: action.payload?.height,
          name: action.payload?.name})
      );
    },
    /** Spawn finished Lottie as free preview — never auto-nests into 动画工作台. */
    spawnLottie(state, action) {
      if (!state.document) return;
      const animationData = action.payload?.animationData;
      const parsed = parseLottieAnimationData(animationData);
      if (!parsed) return;
      if (!action.payload?.skipHistory) pushHistory(state);
      const width = Math.max(
        32,
        Math.round(Number(action.payload?.width) || Number(parsed.w) || 200)
      );
      const height = Math.max(
        32,
        Math.round(Number(action.payload?.height) || Number(parsed.h) || 200)
      );
      const name = String(action.payload?.name || '').trim() || 'Lottie';
      let x = Number(action.payload?.x);
      let y = Number(action.payload?.y);
      // While a workbench timeline is open, keep the plate on the pasteboard
      // (outside the plate) so edit isolation does not hide it on the world canvas.
      const focusId = String(getAnimationWorkbenchTimelineFocus() || '').trim();
      if (focusId && state.document.frames && (!Number.isFinite(x) || !Number.isFinite(y))) {
        const fr = state.document.frames.find((f) => String(f?.id) === focusId);
        if (fr) {
          const fx = Number(fr.x) || 0;
          const fy = Number(fr.y) || 0;
          const fw = Math.max(1, Number(fr.width) || 1);
          // Sit just to the right of the plate — still "outside", user drags in.
          x = fx + fw + 24;
          y = fy;
        }
      }
      try {
        const { id, node } = createLottieNode({
          x: Number.isFinite(x) ? x : undefined,
          y: Number.isFinite(y) ? y : undefined,
          width,
          height,
          name,
          animationData: parsed});
        // Free preview only — never frameId / host. User drags into the workbench.
        if (node.attrs) {
          delete node.attrs.animationFrameHost;
          delete node.attrs.lottieFrameHost;
          delete node.attrs.frameId;
          delete node.attrs.frameOrder;
        }
        const genPrompt = String(
          action.payload?.genPrompt || action.payload?.prompt || ''
        ).trim();
        if (genPrompt) {
          node.attrs = { ...(node.attrs || {}), genPrompt };
        }
        state.document = addNodeToDocument(state.document, id, node);
        // Edit mode: mark surround so focus isolation keeps this LOT visible
        // (do NOT finalize/bind — that would auto-embed into the plate).
        if (focusId) {
          state.document = tagCreatedNodeForWorkbenchSurround(state.document, id);
        }

        state.dirty = true;
        state.sceneReloadToken += 1;
        state.selectedNodeId = id;
        state.selectedNodeIds = [id];
        // Select the free LOT alone so selection chrome (toolbar / title gates) mounts.
        state.selectedFrameIds = [];
        state.activeTool = 'select';
        state.pendingImageSrc = null;
        syncLibraryOnEdit(state);
      } catch {
        /* invalid animationData */
      }
    },
    /**
     * Promote free LOT → 动画工作台 with nested lot plate + precomp tab.
     * Main scene stays preview; click the LOT tab to edit. Upload uses spawnLottie.
     */
    placeUploadedLottie(state, action) {
      if (!state.document) return;
      if (isNewPlateBlockedByAnimationWorkbenchFocus()) return;
      const animationData = action.payload?.animationData;
      const parsed = parseLottieAnimationData(animationData);
      if (!parsed) return;
      const width = Math.max(
        32,
        Math.round(Number(action.payload?.width) || Number(parsed.w) || 200)
      );
      const height = Math.max(
        32,
        Math.round(Number(action.payload?.height) || Number(parsed.h) || 200)
      );
      const lotName =
        String(action.payload?.name || '').trim() ||
        String(parsed.nm || '').trim() ||
        'Lottie';
      const boardName =
        String(action.payload?.boardName || '').trim() || lotName;
      const x = Number(action.payload?.x);
      const y = Number(action.payload?.y);
      if (!action.payload?.skipHistory) pushHistory(state);
      editorReducers.spawnAnimationBoard(state, { payload: {
          x: Number.isFinite(x) ? x : undefined,
          y: Number.isFinite(y) ? y : undefined,
          width,
          height,
          name: boardName,
          skipHistory: true}});
      const frameId = String(state.selectedFrameIds?.[0] || '').trim();
      if (!frameId || !state.document) return;
      const frame = (state.document.frames || []).find((f) => String(f?.id) === frameId);
      if (!frame) return;

      editorReducers.ensureAnimationFrameMedia(state, { payload: { frameId, skipHistory: true }});
      const hostId = findFrameAnimationMediaId(state.document, frameId);
      if (!hostId) return;

      const fx = Number(frame.x) || 0;
      const fy = Number(frame.y) || 0;
      const fw = Math.max(1, Number(frame.width) || width);
      const fh = Math.max(1, Number(frame.height) || height);
      const nestW = Math.min(width, fw);
      const nestH = Math.min(height, fh);
      // frameLocal docs store children in plate-local space (0,0 = frame TL).
      // World (fx+…) coords leave the lot outside clipContent → no 主场景 preview.
      const localPlate = String(state.document.coordSpace || '') === 'frameLocal';
      const nestX = Math.max(0, (fw - nestW) / 2);
      const nestY = Math.max(0, (fh - nestH) / 2);
      try {
        const { id, node } = createLottieNode({
          x: localPlate ? nestX : fx + nestX,
          y: localPlate ? nestY : fy + nestY,
          width: nestW,
          height: nestH,
          name: lotName,
          animationData: parsed});
        if (node.attrs) {
          delete node.attrs.animationFrameHost;
          delete node.attrs.lottieFrameHost;
        }
        const bound = nodeIdsBoundToFrames(state.document, [frameId]);
        const orders = bound
          .map((nid) => Number(state.document?.deltaSetLike?.[nid]?.attrs?.frameOrder))
          .filter(Number.isFinite);
        node.attrs = {
          ...(node.attrs || {}),
          frameId,
          frameOrder: orders.length ? Math.max(...orders) + 1 : 1,
          'fill-color': 'transparent'};
        const genPrompt = String(
          action.payload?.genPrompt || action.payload?.prompt || ''
        ).trim();
        if (genPrompt) {
          node.attrs = { ...(node.attrs || {}), genPrompt };
        }
        state.document = addNodeToDocument(state.document, id, node);

        editorReducers.ensureAnimationFrameMedia(state, { payload: { frameId, skipHistory: true }});

        state.lottieTimelinePanel = { nodeId: hostId };
        setAnimationWorkbenchTimelineFocus(frameId);
        // Stay on 主场景 (preview). User clicks the LOT tab to edit.
        clearLottiePrecompEdit(state);
        state.lottiePlayingHostId = hostId;
        state.lottiePlayheadSec = 0;
        writeAnimationPlayheadSec(0);
        setAnimationWorkbenchPlayheadSec(0);
        state.dirty = true;
        state.sceneReloadToken += 1;
        state.selectedNodeId = null;
        state.selectedNodeIds = [];
        state.selectedFrameIds = [frameId];
        state.activeTool = 'select';
        state.pendingImageSrc = null;
        syncLibraryOnEdit(state);
      } catch {
        /* invalid animationData */
      }
    },
    /** Spawn finished audio plate (upload / paste) at document coords. */
    spawnAudio(state, action) {
      if (!state.document) return;
      if (isAvBlockedByAnimationWorkbenchFocus()) return;
      const src = String(action.payload?.src || '').trim();
      if (!src) return;
      pushHistory(state);
      const { id, node } = createAudioNode({
        x: action.payload?.x,
        y: action.payload?.y,
        width: action.payload?.width,
        height: action.payload?.height,
        name: action.payload?.name,
        src,
        duration: action.payload?.duration,
        uploadKey: action.payload?.uploadKey});
      state.document = addNodeToDocument(state.document, id, node);
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
    },
    /**
     * Insert a pre-built scene node (canvas plugins / host helpers).
     * Payload must already include a stable ``id`` matching ``node.id``.
     */
    spawnCreatedNode(state, action) {
      if (!state.document) return;
      const id = String(action.payload?.id || '').trim();
      const node = action.payload?.node;
      if (!id || !node || typeof node !== 'object') return;
      pushHistory(state);
      const next = { ...node, id };
      state.document = addNodeToDocument(state.document, id, next);
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
    },
    /**
     * Place a library / AI asset onto the canvas (image | video | audio | lottie).
     * Used by the Assets dock — source URL already hosted.
     */
    placeMediaAsset(state, action) {
      if (!state.document) return;
      const kind = String(action.payload?.kind || '').trim().toLowerCase();
      if (
        (kind === 'video' || kind === 'audio') &&
        isAvBlockedByAnimationWorkbenchFocus()
      ) {
        return;
      }
      const src = String(action.payload?.src || '').trim();
      if (kind === 'lottie') {
        const animationData = action.payload?.animationData;
        if (!animationData && !src) return;
        // Workbench edit → free lot at drop; otherwise new 动画工作台 + import JSON.
        if (animationData) {
          const dropX = Number(action.payload?.x);
          const dropY = Number(action.payload?.y);
          const parsed = parseLottieAnimationData(animationData);
          const width = Math.max(
            32,
            Number(action.payload?.width) || Number(parsed?.w) || 200
          );
          const height = Math.max(
            32,
            Number(action.payload?.height) || Number(parsed?.h) || 200
          );
          const name = String(action.payload?.name || '').trim() || 'Lottie';
          // Upload / drop always lands as an independent preview plate.
          editorReducers.spawnLottie(state, { payload: {
              x: Number.isFinite(dropX) ? dropX : undefined,
              y: Number.isFinite(dropY) ? dropY : undefined,
              width,
              height,
              name,
              animationData,
              prompt: action.payload?.prompt,
              genPrompt: action.payload?.genPrompt}});
        }
        return;
      }
      if (!src) return;
      if (kind !== 'image' && kind !== 'video' && kind !== 'audio') return;
      pushHistory(state);
      const x = Number(action.payload?.x);
      const y = Number(action.payload?.y);
      const name = String(action.payload?.name || '').trim() || undefined;
      const uploadKey = String(action.payload?.uploadKey || '').trim() || undefined;
      const prompt = String(action.payload?.prompt || '').trim();
      let id = '';
      let node: SceneNode | null = null;
      if (kind === 'image') {
        const w = Math.max(1, Math.round(Number(action.payload?.width) || 360));
        const h = Math.max(1, Math.round(Number(action.payload?.height) || 360));
        ({ id, node } = createImageNode({
          x: Number.isFinite(x) ? x : 40,
          y: Number.isFinite(y) ? y : 40,
          width: w,
          height: h,
          src,
          name: name || 'Image'}));
        if (uploadKey) node.attrs.uploadKey = uploadKey;
        if (prompt) node.attrs.genPrompt = prompt;
      } else if (kind === 'video') {
        const w = Math.max(1, Math.round(Number(action.payload?.width) || MEDIA_PLACE_DEFAULT.width));
        const h = Math.max(1, Math.round(Number(action.payload?.height) || MEDIA_PLACE_DEFAULT.height));
        ({ id, node } = createVideoNode({
          x: Number.isFinite(x) ? x : 40,
          y: Number.isFinite(y) ? y : 40,
          width: w,
          height: h,
          src,
          name: name || 'Video',
          duration: action.payload?.duration}));
        if (uploadKey) node.attrs.uploadKey = uploadKey;
        if (prompt) node.attrs.genPrompt = prompt;
      } else {
        const w = Math.max(1, Math.round(Number(action.payload?.width) || MEDIA_PLACE_DEFAULT.width));
        const h = Math.max(1, Math.round(Number(action.payload?.height) || MEDIA_PLACE_DEFAULT.height));
        ({ id, node } = createAudioNode({
          x: Number.isFinite(x) ? x : 40,
          y: Number.isFinite(y) ? y : 40,
          width: w,
          height: h,
          src,
          name: name || 'Audio',
          duration: action.payload?.duration,
          uploadKey}));
        if (prompt) node.attrs.genPrompt = prompt;
      }
      state.document = addNodeToDocument(state.document, id, node);
      state.document = finalizeNodeForAnimationWorkbenchFocus(state.document, id);
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
      syncLibraryOnEdit(state);
      const focus = getAnimationWorkbenchTimelineFocus();
      const boundFid = String(state.document.deltaSetLike?.[id]?.attrs?.frameId || '').trim();
      if (focus && boundFid === focus) {
        queueEnsureAnimationFrame(focus, { skipHistory: true });
      }
    },
    /** Convert Image Generator plate → normal image node (same id). */
    /** Pull one multi-gen variant out into a sibling image node (undoable). */
    detachImageVariant(state, action) {
      const nodeId = String(action.payload?.nodeId || '');
      const url = String(action.payload?.url || '').trim();
      const name = String(action.payload?.name || '').trim() || undefined;
      if (!state.document || !nodeId || !url) return;
      pushHistory(state);
      const { document: next, id } = detachImageVariantToNode(state.document, nodeId, url, {
        name});
      if (!id) {
        state.historyPast.pop();
        return;
      }
      state.document = finalizeNodeForAnimationWorkbenchFocus(next, id);
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      syncLibraryOnEdit(state);
    },
    finishImageGenerator(state, action) {
      const nodeId = String(action.payload?.nodeId || '');
      const src = String(action.payload?.src || '').trim();
      if (!state.document || !nodeId || !src) return;
      // Deleted while generating — do not resurrect via promote.
      if (!state.document.deltaSetLike?.[nodeId]) {
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        return;
      }
      pushHistory(state);
      const variants = Array.isArray(action.payload?.variants)
        ? action.payload.variants.map((u: unknown) => String(u || '').trim()).filter(Boolean)
        : undefined;
      const next = promoteImageGeneratorToImage(state.document, nodeId, {
        src,
        width: action.payload?.width,
        height: action.payload?.height,
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name,
        variants,
        genPrompt: action.payload?.genPrompt});
      if (next === state.document) {
        state.historyPast.pop();
        return;
      }
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = nodeId;
      state.selectedNodeIds = [nodeId];
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      syncLibraryOnEdit(state);
    },
    /** Convert Video Generator plate → normal video node (same id). */
    finishVideoGenerator(state, action) {
      const nodeId = String(action.payload?.nodeId || '');
      const src = String(action.payload?.src || '').trim();
      if (!state.document || !nodeId || !src) return;
      // Deleted while generating — do not resurrect via promote.
      if (!state.document.deltaSetLike?.[nodeId]) {
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        return;
      }
      pushHistory(state);
      const next = promoteVideoGeneratorToVideo(state.document, nodeId, {
        src,
        poster: action.payload?.poster,
        width: action.payload?.width,
        height: action.payload?.height,
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name,
        genPrompt: action.payload?.genPrompt});
      if (next === state.document) {
        state.historyPast.pop();
        return;
      }
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = nodeId;
      state.selectedNodeIds = [nodeId];
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      syncLibraryOnEdit(state);
    },
    /** Convert Lottie Generator plate → 动画工作台 + host (not a free Lottie plate). */
    finishLottieGenerator(state, action) {
      const nodeId = String(action.payload?.nodeId || '');
      const animationData = action.payload?.animationData;
      if (!state.document || !nodeId || animationData == null) return;
      const plate = state.document.deltaSetLike?.[nodeId];
      if (!plate) {
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        return;
      }
      const x =
        action.payload?.x != null ? Number(action.payload.x) : Number(plate.x) || 0;
      const y =
        action.payload?.y != null ? Number(action.payload.y) : Number(plate.y) || 0;
      const width = Math.max(
        32,
        Number(action.payload?.width) || Number(plate.width) || 200
      );
      const height = Math.max(
        32,
        Number(action.payload?.height) || Number(plate.height) || 200
      );
      const name =
        String(action.payload?.name || plate.attrs?.name || '').trim() || '动画工作台';
      const genPrompt = String(action.payload?.genPrompt || '').trim();

      pushHistory(state);
      state.document = removeNodesFromDocument(state.document, [nodeId]);
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;

      editorReducers.spawnAnimationBoard(state, { payload: {
          x,
          y,
          width,
          height,
          name,
          skipHistory: true}});
      const frameId = String(state.selectedFrameIds?.[0] || '').trim();
      if (!frameId) return;
      editorReducers.importLottieIntoAnimationFrame(state, { payload: {
          frameId,
          animationData,
          name,
          skipHistory: true}});
      if (genPrompt) {
        const hostId = Object.keys(state.document?.deltaSetLike || {}).find((id) => {
          const n = state.document?.deltaSetLike?.[id];
          return isAnimationFrameHostNode(n, state.document);
        });
        if (hostId && String(state.document?.deltaSetLike?.[hostId]?.attrs?.frameId || '') === frameId) {
          const host = state.document!.deltaSetLike[hostId];
          host.attrs = { ...(host.attrs || {}), genPrompt };
        }
      }
    },
    /** Convert Audio Generator plate → normal audio node (same id). */
    finishAudioGenerator(state, action) {
      const nodeId = String(action.payload?.nodeId || '');
      const src = String(action.payload?.src || '').trim();
      if (!state.document || !nodeId || !src) return;
      if (!state.document.deltaSetLike?.[nodeId]) {
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        return;
      }
      pushHistory(state);
      const next = promoteAudioGeneratorToAudio(state.document, nodeId, {
        src,
        width: action.payload?.width,
        height: action.payload?.height,
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name,
        genPrompt: action.payload?.genPrompt,
        duration: action.payload?.duration,
        uploadKey: action.payload?.uploadKey});
      if (next === state.document) {
        state.historyPast.pop();
        return;
      }
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.selectedNodeId = nodeId;
      state.selectedNodeIds = [nodeId];
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      syncLibraryOnEdit(state);
    },
    /** Spawn image node with local preview while remote upload runs. */
    startImageUploadPlaceholder(state, action) {
      if (!state.document) return;
      const src = String(action.payload?.src || '');
      if (!src) return;
      const { document: spawned, id } = spawnImageUploadPlaceholderNode(state.document, {
        src,
        width: Number(action.payload?.width) || 200,
        height: Number(action.payload?.height) || 200,
        label: action.payload?.label || '上传中',
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name});
      if (!id) return;
      const next = finalizeNodeForAnimationWorkbenchFocus(spawned, id);
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.pendingImageProcessId = id;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
      const focus = getAnimationWorkbenchTimelineFocus();
      const boundFid = String(next.deltaSetLike?.[id]?.attrs?.frameId || '').trim();
      if (focus && boundFid === focus) {
        editorReducers.ensureAnimationFrameMedia(state, { payload: { frameId: focus }});
      }
    },
    /** Spawn video node with local preview while remote upload runs. */
    startVideoUploadPlaceholder(state, action) {
      if (!state.document) return;
      if (isAvBlockedByAnimationWorkbenchFocus()) return;
      const src = String(action.payload?.src || '');
      if (!src) return;
      const { document: next, id } = spawnVideoUploadPlaceholderNode(state.document, {
        src,
        poster: action.payload?.poster,
        width: Number(action.payload?.width) || 640,
        height: Number(action.payload?.height) || 360,
        label: action.payload?.label || '上传中',
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name,
        duration: action.payload?.duration});
      if (!id) return;
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.pendingImageProcessId = id;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
    },
    /** Spawn audio plate with local preview while remote upload runs (same sweep chrome). */
    startAudioUploadPlaceholder(state, action) {
      if (!state.document) return;
      if (isAvBlockedByAnimationWorkbenchFocus()) return;
      const src = String(action.payload?.src || '');
      if (!src) return;
      const { document: next, id } = spawnAudioUploadPlaceholderNode(state.document, {
        src,
        width: Number(action.payload?.width) || 360,
        height: Number(action.payload?.height) || 200,
        label: action.payload?.label || '上传中',
        x: action.payload?.x,
        y: action.payload?.y,
        name: action.payload?.name,
        duration: action.payload?.duration});
      if (!id) return;
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.pendingImageProcessId = id;
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageSrc = null;
      state.activeTool = 'select';
    },
    /** Spawn a right-side image processing node (original untouched). */
    startImageProcess(state, action) {
      if (!state.document) return;
      const { sourceId, kind, label, targetWidth, targetHeight, meta } = action.payload || {};
      if (!sourceId || !kind) return;
      const { document: next, id } = spawnImageProcessNode(state.document, sourceId, {
        kind,
        label: label || '处理中',
        targetWidth,
        targetHeight,
        meta});
      if (!id) return;
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      // Select the loading clone so it can be moved / scaled like any other object.
      state.selectedNodeId = id;
      state.selectedNodeIds = [id];
      state.pendingImageProcessId = id;
    },
    /** Finish processing overlay on a spawned node. Optional `src` replaces image pixels (e.g. upscale). */
    finishImageProcess(state, action) {
      const nodeId = action.payload?.nodeId || state.pendingImageProcessId;
      const nextSrc = action.payload?.src as string | undefined;
      const layers = action.payload?.layers as
        | import('@/components/rcb/scene/document/mediaLifecycle').DecomposeLayer[]
        | undefined;
      const sourceWidth = action.payload?.sourceWidth as number | undefined;
      const sourceHeight = action.payload?.sourceHeight as number | undefined;
      if (!state.document || !nodeId) return;
      // User deleted the placeholder while upload/AI was in flight — do not resurrect it.
      if (!state.document.deltaSetLike?.[nodeId]) {
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        return;
      }

      const isTransientCommit = isEphemeralUploadNode(state.document.deltaSetLike[nodeId]);
      if (isTransientCommit) {
        pushHistoryBeforeTransientNodeCommit(state, nodeId);
      }

      // editText / editElements: replace placeholder with split layers (grouped).
      if (Array.isArray(layers) && layers.length > 0) {
        const { document: next, ids } = applyImageDecomposeLayers(state.document, nodeId, layers, {
          sourceWidth,
          sourceHeight});
        state.document = next;
        state.dirty = true;
        state.sceneReloadToken += 1;
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        if (ids.length) {
          state.selectedNodeId = ids[0];
          state.selectedNodeIds = ids;
        }
        syncLibraryOnEdit(state);
        return;
      }

      const nextSvg = String(action.payload?.svg || '').trim();
      let next = clearImageProcessAttrs(state.document, nodeId);
      // Vectorize: convert process clone from image → editable svg node.
      if (nextSvg) {
        const extra = (action.payload?.attrs || {}) as Record<string, unknown>;
        const prev = next.deltaSetLike?.[nodeId];
        const attrs = { ...(prev?.attrs || {}) } as Record<string, unknown>;
        delete attrs.src;
        delete attrs.cutout;
        delete attrs.assetKind;
        delete attrs.uploadKey;
        delete attrs.imageVariants;
        delete attrs.imageVariantPrompts;
        attrs.svg = nextSvg;
        attrs.name = String(extra.name || attrs.name || 'SVG');
        next = updateNodeInDocument(next, nodeId, { key: 'svg', attrs } as any);
        state.document = next;
        state.dirty = true;
        state.sceneReloadToken += 1;
        if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
        syncLibraryOnEdit(state);
        return;
      }

      if (nextSrc) {
        const extra = (action.payload?.attrs || {}) as Record<string, unknown>;
        next = updateNodeInDocument(next, nodeId, {
          attrs: {
            src: nextSrc,
            // Cutouts are always transparent PNG assets.
            ...(String(extra.cutout || '') === 'true' || String(extra.cutout) === '1'
              ? { cutout: 'true', assetKind: 'image' }
              : {}),
            ...(extra.name ? { name: String(extra.name) } : {}),
            ...(extra.assetKind ? { assetKind: String(extra.assetKind) } : {}),
            ...(extra.uploadKey ? { uploadKey: String(extra.uploadKey) } : {}),
            ...(extra.genPrompt != null
              ? { genPrompt: String(extra.genPrompt || '').trim() || undefined }
              : {}),
            ...(extra.imageVariants != null
              ? { imageVariants: extra.imageVariants }
              : {}),
            ...(extra.imageVariantPrompts != null
              ? { imageVariantPrompts: extra.imageVariantPrompts }
              : {})}});
      }
      state.document = next;
      state.dirty = true;
      state.sceneReloadToken += 1;
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      syncLibraryOnEdit(state);
    },
    /** Drop a failed process clone and clear pending id. */
    failImageProcess(state, action) {
      const nodeId = action.payload?.nodeId || state.pendingImageProcessId;
      if (!nodeId) return;
      if (state.pendingImageProcessId === nodeId) state.pendingImageProcessId = null;
      if (!state.document?.deltaSetLike?.[nodeId]) return;
      state.document = removeNodesFromDocument(state.document, [nodeId]);
      scrubNodeIdsFromHistory(state, [nodeId]);
      state.dirty = true;
      state.sceneReloadToken += 1;
      if (state.selectedNodeId === nodeId) {
        state.selectedNodeId = null;
        state.selectedNodeIds = [];
      } else if (state.selectedNodeIds?.includes(nodeId)) {
        state.selectedNodeIds = state.selectedNodeIds.filter((id: string) => id !== nodeId);
        state.selectedNodeId = state.selectedNodeIds[0] || null;
      }
      syncLibraryOnEdit(state);
    },
    /** Reattach ImageProcessWatcher after refresh for a still-running AI placeholder. */
    resumePendingImageProcess(state, action) {
      const nodeId = String(action.payload?.nodeId || '').trim();
      if (!nodeId || !state.document?.deltaSetLike?.[nodeId]) return;
      if (String(state.document.deltaSetLike[nodeId]?.attrs?.processStatus || '') !== 'running') {
        return;
      }
      state.pendingImageProcessId = nodeId;
    },
    openImageToolPanel(state, action) {
      const { nodeId, kind, markSink } = action.payload || {};
      if (!nodeId || !kind) return;
      state.imageToolPanel = {
        nodeId,
        kind,
        ...(markSink === 'quickEdit' && { markSink: 'quickEdit' as const }),
        ...(markSink === 'imageGen' && { markSink: 'imageGen' as const }),
        ...(markSink === 'videoGen' && { markSink: 'videoGen' as const })};
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.lottieComposePanel = null;
      // Keep 动画工作台 timeline edit open — tool panels nest inside edit mode.
      state.shapeStylePanel = null;
    },
    closeImageToolPanel(state) {
      const panel = state.imageToolPanel;
      state.imageToolPanel = null;
      if (
        panel?.kind === 'quickEdit' ||
        (panel?.kind === 'mark' && panel.markSink === 'quickEdit')
      ) {
        state.imageMarkPins = pruneQuickEditMarkPins(state.imageMarkPins);
        state.pendingQuickEditMarkContexts = [];
      }
      if (panel?.kind === 'mark' && panel.markSink === 'imageGen') {
        state.imageMarkPins = pruneMarkPinsBySink(state.imageMarkPins, 'imageGen');
        state.pendingImageGenMarkContexts = [];
      }
      if (panel?.kind === 'mark' && panel.markSink === 'videoGen') {
        state.imageMarkPins = pruneMarkPinsBySink(state.imageMarkPins, 'videoGen');
        state.pendingVideoGenMarkContexts = [];
      }
      // Puppet exit remounts selection chrome / SVG — re-bake Canvas 2D warp onto href.
      if (panel?.kind === 'puppet') {
        state.documentPatchToken += 1;
        state.sceneReloadToken += 1;
        requestPuppetWarpApply({ afterPaint: true });
      }
    },
    openVideoToolPanel(state, action) {
      const { nodeId, kind, keepTime } = action.payload || {};
      if (!nodeId || kind !== 'trim') return;
      const t = Number(keepTime);
      state.videoToolPanel = {
        nodeId,
        kind,
        ...(Number.isFinite(t) && t >= 0 ? { keepTime: t } : null)};
      state.imageToolPanel = null;
      state.audioToolPanel = null;
      state.lottieComposePanel = null;
      state.shapeStylePanel = null;
    },
    closeVideoToolPanel(state) {
      state.videoToolPanel = null;
    },
    openAudioToolPanel(state, action) {
      const { nodeId, kind, keepTime } = action.payload || {};
      if (!nodeId || (kind !== 'trim' && kind !== 'speed')) return;
      const t = Number(keepTime);
      state.audioToolPanel = {
        nodeId,
        kind,
        ...(kind === 'trim' && Number.isFinite(t) && t >= 0 ? { keepTime: t } : null)};
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.lottieComposePanel = null;
      state.shapeStylePanel = null;
    },
    closeAudioToolPanel(state) {
      state.audioToolPanel = null;
    },
    openLottieComposePanel(state, action) {
      const nodeId = String(action.payload?.nodeId || '').trim();
      if (!nodeId) return;
      const tool = action.payload?.tool;
      const allowed = new Set(['select', 'rect', 'ellipse', 'pen', 'text']);
      state.lottieComposePanel = {
        nodeId,
        tool: allowed.has(tool) ? tool : 'select'};
      state.lottieTimelinePanel = null;
      clearLottiePrecompEdit(state);
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.shapeStylePanel = null;
      // Scene shape/pen tools must not steal gestures while composing on the plate.
      state.activeTool = 'select';
    },
    setLottieComposeTool(state, action) {
      if (!state.lottieComposePanel) return;
      const tool = action.payload;
      const allowed = new Set(['select', 'rect', 'ellipse', 'pen', 'text']);
      if (!allowed.has(tool)) return;
      state.lottieComposePanel.tool = tool;
    },
    closeLottieComposePanel(state) {
      state.lottieComposePanel = null;
    },
    openLottieTimelinePanel(
      state,
      action: PayloadAction<{ nodeId: string; play?: boolean }>
    ) {
      let nodeId = String(action.payload?.nodeId || '').trim();
      if (!nodeId || !state.document) return;
      let host = state.document.deltaSetLike?.[nodeId];
      // Free LOT preview plate → promote to 动画工作台 (layers + isolation) then open.
      if (
        host?.key === 'lottie' &&
        !isAnimationFrameHostNode(host, state.document) &&
        !resolveAnimationFrameId(state.document, host)
      ) {
        const animationData = parseLottieAnimationData(host.attrs?.animationData);
        if (animationData && !isNewPlateBlockedByAnimationWorkbenchFocus()) {
          const x = Number(host.x) || 0;
          const y = Number(host.y) || 0;
          const width = Math.max(32, Number(host.width) || Number(animationData.w) || 200);
          const height = Math.max(32, Number(host.height) || Number(animationData.h) || 200);
          const name =
            String(host.attrs?.name || '').trim() ||
            String(animationData.nm || '').trim() ||
            '动画工作台';
          pushHistory(state);
          state.document = removeNodesFromDocument(state.document, [nodeId]);
          editorReducers.placeUploadedLottie(state, { payload: {
              animationData,
              x,
              y,
              width,
              height,
              name,
              skipHistory: true}});
          const frameId = String(state.selectedFrameIds?.[0] || '').trim();
          const promoted = frameId
            ? findFrameAnimationMediaId(state.document, frameId)
            : null;
          if (promoted) nodeId = promoted;
          host = state.document?.deltaSetLike?.[nodeId];
        }
      }
      if (!nodeId) return;
      state.lottieTimelinePanel = { nodeId };
      // Bind play session to this host so other plates do not co-play.
      state.lottiePlayingHostId = nodeId;
      // Always enter at t=0 — stale playhead / host time must not stick.
      state.lottiePlayheadSec = 0;
      writeAnimationPlayheadSec(0);
      setAnimationWorkbenchPlayheadSec(0);
      // Optional: start playing when caller requests play:true.
      state.lottiePlaying = Boolean(action.payload?.play);
      // Point activeFrameId at the workbench so new uploads / JSON land in-plate
      // (spawn centers + Lottie import resolve via activeFrameId).
      host = state.document?.deltaSetLike?.[nodeId];
      const frameId = resolveAnimationFrameId(state.document, host);
      if (frameId && state.document) {
        // Avoid a needless document identity swap when already focused —
        // WorkbenchHost / FocusHost used to re-ensure/repaint on every swap.
        if (String(state.document.activeFrameId || '') !== frameId) {
          state.document = { ...state.document, activeFrameId: frameId };
        }
        state.selectedFrameIds = [frameId];
        // Sync module focus immediately (do not wait for React paint).
        setAnimationWorkbenchTimelineFocus(frameId);
        // Bake layers without history — opening the dock is not an undo step.
        queueEnsureAnimationFrame(frameId, { skipHistory: true });
      }
      if (state.lottiePrecompEdit?.hostNodeId !== nodeId) {
        clearLottiePrecompEdit(state);
      }
      state.lottieComposePanel = null;
      state.animationFramePanel = null;
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.shapeStylePanel = null;
      requestTimelineCameraFit({ afterPaint: true });
    },
    closeLottieTimelinePanel(state) {
      if (clearLottiePrecompEdit(state)) state.dirty = true;
      state.lottieTimelinePanel = null;
      state.lottiePlaying = false;
      state.lottiePlayingHostId = null;
      // Exit at first frame so the canvas isn't left mid-scrub.
      state.lottiePlayheadSec = 0;
      writeAnimationPlayheadSec(0);
      setAnimationWorkbenchTimelineFocus(null);
      setAnimationWorkbenchPlayheadSec(0);
      requestTimelineCameraRelease();
      // Preview mode: inner elements are not selectable — clear child picks.
      if (state.document && state.selectedNodeIds?.length) {
        const kept = state.selectedNodeIds.filter(
          (nid) =>
            !isAnimationWorkbenchPreviewChild(
              state.document,
              state.document?.deltaSetLike?.[nid]
            )
        );
        if (kept.length !== state.selectedNodeIds.length) {
          state.selectedNodeIds = kept;
          state.selectedNodeId = kept[0] || null;
        }
      }
    },
    enterLottiePrecompEdit(state, action) {
      const hostNodeId = String(action.payload?.hostNodeId || '').trim();
      const assetId = String(action.payload?.assetId || '').trim();
      if (!hostNodeId || !assetId || !state.document) return;

      // Drop any legacy materialized session (old tab path shrunk the plate).
      if (state.lottiePrecompEdit?.frameSnapshot) {
        clearLottiePrecompEdit(state);
      }

      const layerInd = readSelectedLayerInd(action.payload?.selectedLayerInd);
      const next = convertLottiePrecompTab({
        mode: 'lot',
        hostNodeId,
        assetId,
        selectedLayerInd: layerInd,
      });
      state.lottiePrecompEdit = next.lottiePrecompEdit;
      setLottiePrecompEditFocus(next.focus);
      state.selectedNodeId = null;
      state.selectedNodeIds = [];
      requestPrecompCameraFit({ afterPaint: true });
      schedulePrecompTabArtboardDump('enter-session', {
        hostNodeId,
        assetId,
        lotNodeId: next.lottiePrecompEdit?.lotNodeId,
      });
    },
    exitLottiePrecompEdit(state) {
      const prev = state.lottiePrecompEdit;
      if (!prev) return;

      // Legacy only: restore geom if an old session still has a snapshot.
      if (prev.frameId && prev.frameSnapshot) {
        pushHistory(state);
        if (tearDownLottiePrecompEdit(state)) {
          state.dirty = true;
          state.document!.activeFrameId = prev.frameId;
          state.selectedFrameIds = [prev.frameId];
        }
      }

      const hostNodeId = String(prev.hostNodeId || '').trim();
      const exitLotId =
        String(prev.lotNodeId || '').trim() ||
        linkedLotNodeIdFromAsset(String(prev.assetId || '')) ||
        '';
      const next = convertLottiePrecompTab({ mode: 'main' });
      state.lottiePrecompEdit = next.lottiePrecompEdit;
      setLottiePrecompEditFocus(next.focus);
      state.selectedNodeId = null;
      state.selectedNodeIds = [];
      if (exitLotId && typeof window !== 'undefined') {
        queueMicrotask(() => clearStuckLottieMountVisibility(exitLotId));
      }
      requestPlayheadSceneApply({ afterPaint: true });
      requestPrecompCameraRelease();
      if (hostNodeId) {
        requestSyncNestedLotHosts({
          frameHostId: hostNodeId,
          timeSec: Number(state.lottiePlayheadSec) || 0,
          afterPaint: true});
      }
      schedulePrecompTabArtboardDump('exit-session', {
        hostNodeId: prev.hostNodeId,
        assetId: prev.assetId,
        lotNodeId: prev.lotNodeId,
      });
    },
    setLottiePrecompSelectedLayer(state, action) {
      if (!state.lottiePrecompEdit) return;
      const ind = action.payload;
      state.lottiePrecompEdit.selectedLayerInd =
        ind == null || !Number.isFinite(Number(ind)) ? null : Math.round(Number(ind));
    },
    setLottiePlayhead(state, action) {
      const n = Number(action.payload);
      if (!Number.isFinite(n)) return;
      const sec = Math.max(0, n);
      // Recover stuck mid-drag gate so ensure/sync + playhead pose stay live.
      if (isAnimationWorkbenchGeometryPreview()) {
        setAnimationWorkbenchGeometryPreview(false);
      }
      // Transport first — Dock/Selection opt into useAnimationPlayheadSec (not whole editor).
      writeAnimationPlayheadSec(sec);
      state.lottiePlayheadSec = sec;
      setAnimationWorkbenchPlayheadSec(sec);
      bakePrecompSessionDocumentPoses(state);
      requestPlayheadSceneApply();
      requestPuppetWarpApply();
    },
    setLottiePlaying(state, action) {
      const payload = action.payload;
      const wasPlaying = Boolean(state.lottiePlaying);
      let playing = false;
      if (payload && typeof payload === 'object') {
        playing = Boolean((payload as { playing?: unknown }).playing);
        state.lottiePlaying = playing;
        const hostRaw = (payload as { hostNodeId?: unknown }).hostNodeId;
        if (hostRaw != null) {
          const id = String(hostRaw || '').trim();
          // Keep host on pause so playhead/pose don't reset to t=0.
          if (id) state.lottiePlayingHostId = id;
        }
      } else {
        playing = Boolean(payload);
        state.lottiePlaying = playing;
        // Pausing must not clear the playhead host (SceneSync would seek 0).
      }
      writeAnimationPlaying(playing, {
        hostNodeId: state.lottiePlayingHostId});
      // Drop selection chrome when playback starts (handles / toolbars hide).
      if (playing && !wasPlaying) {
        state.selectedNodeId = null;
        state.selectedNodeIds = [];
        state.imageToolPanel = null;
        state.shapeStylePanel = null;
      }
    },
    openAnimationFramePanel(state, action) {
      const frameId = String(action.payload?.frameId || '').trim();
      const kind = action.payload?.kind;
      if (!frameId || (kind !== 'quickEdit' && kind !== 'timeline')) return;
      state.animationFramePanel = { frameId, kind };
      state.lottieComposePanel = null;
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.shapeStylePanel = null;
      if (kind === 'timeline') {
        // Prefer the node-based bottom dock when media already exists.
        state.lottieTimelinePanel = null;
      }
    },
    closeAnimationFramePanel(state) {
      state.animationFramePanel = null;
    },
    /**
     * Ensure a full-bleed Lottie media node exists inside a 动画工作台 frame
     * (playback / timeline host). Invisible — not a second user plate.
     * Syncs artboard children (shapes / images) into animationData layers.
     * Does not change selection.
     */
    ensureAnimationFrameMedia(
      state,
      action: PayloadAction<{ frameId: string; skipHistory?: boolean }>
    ) {
      if (!state.document) return;
      if (isAnimationWorkbenchGeometryPreview()) return;
      const frameId = String(action.payload?.frameId || '').trim();
      if (!frameId) return;
      const skipHistory = Boolean(action.payload?.skipHistory);
      const frames = Array.isArray(state.document.frames) ? state.document.frames : [];
      const frame = frames.find((f) => String(f?.id) === frameId);
      if (!frame || !isAnimationArtboardKind(frame.kind)) return;
      const hostAttrs = {
        frameId,
        frameOrder: 0,
        /** Invisible host under 动画工作台 — not a second plate. */
        animationFrameHost: true,
        'fill-color': 'transparent',
        locked: true,
        name: ''} as const;

      const applyHostGeometry = (host: SceneNode) => {
        const localPlate = String(state.document?.coordSpace || '') === 'frameLocal';
        host.x = localPlate ? 0 : Number(frame.x) || 0;
        host.y = localPlate ? 0 : Number(frame.y) || 0;
        host.width = Math.max(1, Number(frame.width) || 1);
        host.height = Math.max(1, Number(frame.height) || 1);
      };

      const finishSync = (hostId: string) => {
        if (!state.document) return;
        const synced = syncArtboardChildrenIntoAnimation(state.document, frameId, hostId);
        if (!synced) return;
        const hostBefore = state.document.deltaSetLike?.[hostId];
        const prevJson = String(hostBefore?.attrs?.animationData || '');
        const hasHostFlag = hostBefore?.attrs?.animationFrameHost === true;
        const localPlate = String(state.document?.coordSpace || '') === 'frameLocal';
        const expectX = localPlate ? 0 : Math.round(Number(frame.x) || 0);
        const expectY = localPlate ? 0 : Math.round(Number(frame.y) || 0);
        const geomNeed =
          Math.round(Number(hostBefore?.x) || 0) !== expectX ||
          Math.round(Number(hostBefore?.y) || 0) !== expectY ||
          Math.round(Number(hostBefore?.width) || 0) !== Math.round(Number(frame.width) || 0) ||
          Math.round(Number(hostBefore?.height) || 0) !== Math.round(Number(frame.height) || 0);
        const attrsNeedHost =
          !hasHostFlag ||
          String(hostBefore?.attrs?.['fill-color'] || '') !== 'transparent' ||
          hostBefore?.attrs?.locked !== true ||
          String(hostBefore?.attrs?.name || '').trim() !== '';
        let childrenNeed = false;
        for (const p of synced.childAttrPatches) {
          const child = state.document.deltaSetLike?.[p.nodeId];
          if (Number(child?.attrs?.lottieLayerInd) !== p.lottieLayerInd) {
            childrenNeed = true;
            break;
          }
          if (
            p.lottieInFrame != null &&
            Number(child?.attrs?.lottieInFrame) !== p.lottieInFrame
          ) {
            childrenNeed = true;
            break;
          }
          if (
            p.lottieOutFrame != null &&
            Number(child?.attrs?.lottieOutFrame) !== p.lottieOutFrame
          ) {
            childrenNeed = true;
            break;
          }
        }
        if (!attrsNeedHost && !childrenNeed && !geomNeed && prevJson === synced.animationJson) {
          if (!skipHistory) persistActivePrecompSession(state);
          return;
        }

        if (!skipHistory) pushHistory(state);
        const next = normalizeDocument(state.document);
        const host = next.deltaSetLike?.[hostId];
        if (!host) return;
        applyHostGeometry(host);
        // Large LOT JSON: apply geom/child attrs now (dock can open), defer host
        // animationData to idle so ensure does not freeze the main thread.
        const LARGE_LOT_JSON_CHARS = 120_000;
        const deferHostJson =
          synced.animationJson !== prevJson &&
          synced.animationJson.length >= LARGE_LOT_JSON_CHARS;
        let animationData = synced.animationJson;
        if (deferHostJson) animationData = prevJson;
        host.attrs = {
          ...(host.attrs || {}),
          ...hostAttrs,
          animationData,
        };
        for (const p of synced.childAttrPatches) {
          const child = next.deltaSetLike?.[p.nodeId];
          if (!child) continue;
          const nextAttrs: Record<string, unknown> = {
            ...(child.attrs || {}),
            lottieLayerInd: p.lottieLayerInd,
          };
          if (p.lottieInFrame != null) nextAttrs.lottieInFrame = p.lottieInFrame;
          if (p.lottieOutFrame != null) nextAttrs.lottieOutFrame = p.lottieOutFrame;
          child.attrs = nextAttrs;
        }
        state.document = next;
        state.dirty = true;
        state.documentPatchToken += 1;
        // Timeline dock uses useEditorDocumentOnCommit (documentRevision only).
        // skipHistory ensure still bakes layers — must bump or 「图层」 stays
        // stale until the next touchDocumentRevision (e.g. a drag).
        // Do not bump sceneReloadToken — host JSON is patch-only (Phase 4).
        bumpDocumentRevision(state);
        state.lastPatchedNodeIds = [hostId, ...synced.childAttrPatches.map((p) => p.nodeId)];
        state.lastPatchTransformOnly = false;
        if (!skipHistory) persistActivePrecompSession(state);
        syncLibraryOnEdit(state);
        if (deferHostJson) {
          queueIdleAnimationHostJson({
            hostId,
            animationJson: synced.animationJson,
            skipHistory: true,
          });
        }
      };

      const bound = nodeIdsBoundToFrames(state.document, [frameId]);
      let flaggedHostId: string | null = null;
      for (const id of bound) {
        const n = state.document.deltaSetLike?.[id];
        if (n?.key !== 'lottie') continue;
        if (isAnimationFrameHostNode(n, state.document)) {
          flaggedHostId = id;
          break;
        }
      }
      if (flaggedHostId) {
        finishSync(flaggedHostId);
        return;
      }
      if (!skipHistory) pushHistory(state);
      try {
        const blank = createBlankLottieAnimation({
          width: Math.max(32, Math.round(frame.width)),
          height: Math.max(32, Math.round(frame.height)),
          durationSec: Math.max(0.5, Number(frame.durationSec) || 5),
          fps: Math.max(1, Math.round(Number(frame.fps) || 30))});
        const localPlate = String(state.document?.coordSpace || '') === 'frameLocal';
        const { id, node } = createLottieNode({
          x: localPlate ? 0 : frame.x,
          y: localPlate ? 0 : frame.y,
          width: frame.width,
          height: frame.height,
          name: ' ',
          animationData: blank});
        node.attrs = {
          ...(node.attrs || {}),
          ...hostAttrs};
        state.document = addNodeToDocument(state.document, id, node);
        // History already pushed; sync writes without a second pushHistory.
        const synced = syncArtboardChildrenIntoAnimation(state.document, frameId, id);
        if (synced) {
          const next = normalizeDocument(state.document);
          const host = next.deltaSetLike?.[id];
          if (host) {
            host.x = localPlate ? 0 : Number(frame.x) || 0;
            host.y = localPlate ? 0 : Number(frame.y) || 0;
            host.width = Math.max(1, Number(frame.width) || 1);
            host.height = Math.max(1, Number(frame.height) || 1);
            host.attrs = {
              ...(host.attrs || {}),
              ...hostAttrs,
              animationData: synced.animationJson};
            for (const p of synced.childAttrPatches) {
              const child = next.deltaSetLike?.[p.nodeId];
              if (!child) continue;
              child.attrs = {
                ...(child.attrs || {}),
                lottieLayerInd: p.lottieLayerInd,
                ...(p.lottieInFrame != null ? { lottieInFrame: p.lottieInFrame } : null),
                ...(p.lottieOutFrame != null ? { lottieOutFrame: p.lottieOutFrame } : null)};
            }
            state.document = next;
          }
        }
        state.dirty = true;
        state.documentPatchToken += 1;
        // See finishSync — timeline dock is revision-gated, not patchToken-gated.
        bumpDocumentRevision(state);
        state.lastPatchedNodeIds = [id];
        state.lastPatchTransformOnly = false;
        syncLibraryOnEdit(state);
      } catch {
        /* invalid animationData */
      }
    },
    /**
     * Import Bodymovin JSON into a 动画工作台 host (full-bleed playback + timeline layers).
     * Does not spawn a second free Lottie plate.
     */
    importLottieIntoAnimationFrame(state, action) {
      if (!state.document) return;
      const frameId = String(action.payload?.frameId || '').trim();
      const parsed = parseLottieAnimationData(action.payload?.animationData);
      if (!frameId || !parsed) return;
      const frames = Array.isArray(state.document.frames) ? [...state.document.frames] : [];
      const frameIdx = frames.findIndex((f) => String(f?.id) === frameId);
      if (frameIdx < 0) return;
      const frame = frames[frameIdx];
      if (!frame || !isAnimationArtboardKind(frame.kind)) return;

      const json = serializeLottieAnimationData(parsed);
      if (!json) return;

      const fps = Math.max(1, Math.round(Number(parsed.fr) || Number(frame.fps) || 30));
      const ip = Number(parsed.ip) || 0;
      const op = Number(parsed.op);
      const durationSec =
        Number.isFinite(op) && op > ip
          ? Math.max(0.5, (op - ip) / fps)
          : Math.max(0.5, Number(frame.durationSec) || 5);
      const natW = Math.max(32, Math.round(Number(parsed.w) || Number(frame.width) || 200));
      const natH = Math.max(32, Math.round(Number(parsed.h) || Number(frame.height) || 200));

      const hostAttrs = {
        frameId,
        frameOrder: 0,
        animationFrameHost: true,
        'fill-color': 'transparent',
        locked: true,
        name: ''} as const;
      const genPrompt = String(
        action.payload?.genPrompt || action.payload?.prompt || ''
      ).trim();

      if (!action.payload?.skipHistory) pushHistory(state);
      let next = normalizeDocument(state.document);
      // Match plate to composition so imported layers aren't stranded in a corner.
      frames[frameIdx] = {
        ...frame,
        width: natW,
        height: natH,
        durationSec,
        fps};
      next.frames = frames;
      const sizedFrame = frames[frameIdx];

      const bound = nodeIdsBoundToFrames(next, [frameId]);
      let hostId: string | null = null;
      for (const id of bound) {
        const n = next.deltaSetLike?.[id];
        if (isAnimationFrameHostNode(n, next)) {
          hostId = id;
          break;
        }
      }

      if (!hostId) {
        try {
          const { id, node } = createLottieNode({
            x: sizedFrame.x,
            y: sizedFrame.y,
            width: sizedFrame.width,
            height: sizedFrame.height,
            name: ' ',
            animationData: parsed});
          node.attrs = {
            ...(node.attrs || {}),
            ...hostAttrs,
            animationData: json};
          next = addNodeToDocument(next, id, node);
          hostId = id;
        } catch {
          return;
        }
      } else {
        const host = next.deltaSetLike?.[hostId];
        if (!host) return;
        host.x = Number(sizedFrame.x) || 0;
        host.y = Number(sizedFrame.y) || 0;
        host.width = Math.max(1, Number(sizedFrame.width) || 1);
        host.height = Math.max(1, Number(sizedFrame.height) || 1);
        host.attrs = {
          ...(host.attrs || {}),
          ...hostAttrs,
          animationData: json};
      }

      // Drop stray free Lottie plates on this board — they looked like blue
      // placeholders and are not syncable scene layers.
      const removeIds: string[] = [];
      for (const id of nodeIdsBoundToFrames(next, [frameId])) {
        if (id === hostId) continue;
        const n = next.deltaSetLike?.[id];
        if (n?.key === 'lottie' && !isAnimationFrameHostNode(n, next)) {
          removeIds.push(id);
        }
      }
      if (removeIds.length) {
        next = removeNodesFromDocument(next, removeIds);
      }

      // Explode simple shape layers into editable scene nodes (not one LOT blob).
      let maturedIds: string[] = [];
      if (hostId) {
        const hostBefore = next.deltaSetLike?.[hostId];
        const matured = materializeRootShapeLayers({
          document: next,
          frameId,
          animationData: hostBefore?.attrs?.animationData ?? parsed,
          plate: {
            x: Number(sizedFrame.x) || 0,
            y: Number(sizedFrame.y) || 0,
            width: Math.max(1, Number(sizedFrame.width) || 1),
            height: Math.max(1, Number(sizedFrame.height) || 1)}});
        if (matured) {
          next = matured.document;
          maturedIds = matured.nodeIds;
          const hostM = next.deltaSetLike?.[hostId];
          if (hostM) {
            hostM.attrs = {
              ...(hostM.attrs || {}),
              ...hostAttrs,
              animationData: matured.animationJson};
          }
        }
      }

      const synced = hostId
        ? syncArtboardChildrenIntoAnimation(next, frameId, hostId)
        : null;
      if (synced && hostId) {
        const host = next.deltaSetLike?.[hostId];
        if (host) {
          host.attrs = {
            ...(host.attrs || {}),
            ...hostAttrs,
            animationData: synced.animationJson};
          for (const p of synced.childAttrPatches) {
            const child = next.deltaSetLike?.[p.nodeId];
            if (!child) continue;
            child.attrs = {
              ...(child.attrs || {}),
              lottieLayerInd: p.lottieLayerInd,
              ...(p.lottieInFrame != null ? { lottieInFrame: p.lottieInFrame } : null),
              ...(p.lottieOutFrame != null ? { lottieOutFrame: p.lottieOutFrame } : null)};
          }
        }
      }

      next.activeFrameId = frameId;
      if (genPrompt && hostId) {
        const host = next.deltaSetLike?.[hostId];
        if (host) {
          host.attrs = { ...(host.attrs || {}), genPrompt };
        }
      }
      state.document = next;
      state.selectedFrameIds = [frameId];
      // Pick first exploded shape so the canvas shows a real editable element.
      const pickId = maturedIds[0] || null;
      state.selectedNodeId = pickId;
      state.selectedNodeIds = pickId ? [pickId] : [];
      state.frameChromeMode = 'full';
      state.dirty = true;
      state.sceneReloadToken += 1;
      state.documentPatchToken += 1;
      state.lastPatchedNodeIds = hostId
        ? [hostId, ...maturedIds]
        : maturedIds;
      state.lastPatchTransformOnly = false;
      state.activeTool = 'select';
      // Keep timeline dock open on the playback host when already editing.
      if (hostId && (state.lottieTimelinePanel?.nodeId || getAnimationWorkbenchTimelineFocus())) {
        state.lottieTimelinePanel = { nodeId: hostId };
        setAnimationWorkbenchTimelineFocus(frameId);
      }
      // Do not auto-open the timeline dock on import/upload when it was closed —
      // user opens via 关键帧.
      state.animationFramePanel = null;
      state.lottieComposePanel = null;
      clearLottiePrecompEdit(state);
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.shapeStylePanel = null;
      state.pendingImageSrc = null;
      state.lottiePlayheadSec = 0;
      writeAnimationPlayheadSec(0);
      setAnimationWorkbenchPlayheadSec(0);
      syncLibraryOnEdit(state);
    },
    openShapeStylePanel(state, action) {
      const kind = action.payload?.kind;
      const nodeIds = Array.isArray(action.payload?.nodeIds)
        ? action.payload.nodeIds.filter(Boolean)
        : [];
      if ((kind !== 'fill' && kind !== 'stroke' && kind !== 'radius') || !nodeIds.length) return;
      state.shapeStylePanel = { kind, nodeIds };
      state.imageToolPanel = null;
      state.videoToolPanel = null;
      state.audioToolPanel = null;
      state.lottieComposePanel = null;
      // Keep animation timeline / 动画工作台 dock open while editing fill/stroke/radius.
    },
    closeShapeStylePanel(state) {
      state.shapeStylePanel = null;
    },
    setPenStrokeColor(state, action) {
      const hex = String(action.payload || '').trim();
      if (hex) state.penStrokeColor = hex;
    },
    setPenFillColor(state, action) {
      const hex = String(action.payload ?? '').trim();
      state.penFillColor = hex || '#CCCCCC';
    },
    setPenStrokeWidth(state, action) {
      const n = Number(action.payload);
      if (!Number.isFinite(n)) return;
      state.penStrokeWidth = Math.max(1, Math.min(200, Math.round(n)));
    },
    setPenStrokeOpacity(state, action) {
      const n = Number(action.payload);
      if (!Number.isFinite(n)) return;
      state.penStrokeOpacity = Math.max(1, Math.min(100, Math.round(n)));
    },
    setBucketFill(state, action) {
      const next = action.payload;
      if (!next || typeof next !== 'object') return;
      const fillColorRaw =
        next.fillColor != null ? String(next.fillColor) : String(state.bucketFill.fillColor || '');
      const opRaw = next.fillOpacity ?? state.bucketFill.fillOpacity;
      const op = Number(opRaw);
      state.bucketFill = {
        ...state.bucketFill,
        ...next,
        fillType: next.fillType || state.bucketFill.fillType || 'solid',
        // Keep explicit `transparent` / `none` (|| would fall back to previous solid).
        fillColor: fillColorRaw || '#333333',
        fillOpacity: Math.max(0, Math.min(100, Math.round(Number.isFinite(op) ? op : 100))),
      };
    },
    setPencilBrushId(state, action) {
      const id = String(action.payload || '').trim();
      if (id) state.pencilBrushId = id;
    },
    setPencilPressureEnabled(state, action) {
      state.pencilPressureEnabled = Boolean(action.payload);
    },
    setWorkspaceMode(state, action: PayloadAction<'design' | 'dev'>) {
      const mode = action.payload;
      if (mode === 'design' || mode === 'dev') {
        state.workspaceMode = mode;
        if (mode !== 'dev') state.devHoverNodeId = null;
      }
    },
    setDevHoverNodeId(state, action) {
      state.devHoverNodeId = action.payload || null;
    },
    setAgentBusy(state, action) {
      state.agentBusy = Boolean(action.payload);
    },
    startCanvasAttachPick(
      state,
      action: PayloadAction<{ target: string; accept?: 'image' | 'media' }>
    ) {
      const target = String(action.payload?.target || '').trim();
      if (!target) {
        state.canvasAttachPick = null;
        state.canvasAttachPickBlocked = false;
        return;
      }
      const accept = action.payload?.accept === 'image' ? 'image' : 'media';
      state.canvasAttachPick = { target, accept };
      state.canvasAttachPickBlocked = false;
      state.pendingCanvasAttach = null;
    },
    clearCanvasAttachPick(state) {
      state.canvasAttachPick = null;
      state.canvasAttachPickBlocked = false;
    },
    setCanvasAttachPickBlocked(state, action: PayloadAction<boolean>) {
      state.canvasAttachPickBlocked = Boolean(action.payload);
    },
    setPendingCanvasAttach(
      state,
      action: PayloadAction<{ target: string; payload: string | string[] } | null>
    ) {
      if (!action.payload) {
        state.pendingCanvasAttach = null;
        return;
      }
      const target = String(action.payload.target || '').trim();
      if (!target) {
        state.pendingCanvasAttach = null;
        return;
      }
      state.pendingCanvasAttach = {
        target,
        payload: action.payload.payload};
      // Keep canvasAttachPick until consume — cleared by SvgCanvas after one pick.
    },
    consumePendingCanvasAttach(state) {
      state.pendingCanvasAttach = null;
    },
    enqueueAgentContexts(
      state,
      action: PayloadAction<PendingMarkContextChip[]>
    ) {
      const list = Array.isArray(action.payload) ? action.payload : [];
      if (!list.length) return;
      state.pendingAgentContexts = [...state.pendingAgentContexts, ...list];
      state.agentOpenNonce = (Number(state.agentOpenNonce) || 0) + 1;
    },
    consumePendingAgentContexts(state) {
      state.pendingAgentContexts = [];
    },
    enqueueQuickEditMarkContexts(
      state,
      action: PayloadAction<PendingMarkContextChip[]>
    ) {
      const list = Array.isArray(action.payload) ? action.payload : [];
      if (!list.length) return;
      state.pendingQuickEditMarkContexts = [...state.pendingQuickEditMarkContexts, ...list];
    },
    consumePendingQuickEditMarkContexts(state) {
      state.pendingQuickEditMarkContexts = [];
    },
    enqueueImageGenMarkContexts(
      state,
      action: PayloadAction<PendingMarkContextChip[]>
    ) {
      const list = Array.isArray(action.payload) ? action.payload : [];
      if (!list.length) return;
      state.pendingImageGenMarkContexts = [...state.pendingImageGenMarkContexts, ...list];
    },
    consumePendingImageGenMarkContexts(state) {
      state.pendingImageGenMarkContexts = [];
    },
    enqueueVideoGenMarkContexts(
      state,
      action: PayloadAction<PendingMarkContextChip[]>
    ) {
      const list = Array.isArray(action.payload) ? action.payload : [];
      if (!list.length) return;
      state.pendingVideoGenMarkContexts = [...state.pendingVideoGenMarkContexts, ...list];
    },
    consumePendingVideoGenMarkContexts(state) {
      state.pendingVideoGenMarkContexts = [];
    },
    setImageMarkPin(state, action: PayloadAction<ImageMarkPin>) {
      const pin = action.payload;
      if (!pin?.nodeId) return;
      const list = [...(state.imageMarkPins[pin.nodeId] || [])];
      const idx = list.findIndex((p) => p.id === pin.id);
      if (idx >= 0) list[idx] = pin;
      else list.push(pin);
      state.imageMarkPins[pin.nodeId] = list;
    },
    removeImageMarkPin(
      state,
      action: PayloadAction<{ nodeId: string; pinId: string }>
    ) {
      const nodeId = String(action.payload?.nodeId || '').trim();
      const pinId = String(action.payload?.pinId || '').trim();
      if (!nodeId || !pinId) return;
      const list = state.imageMarkPins[nodeId] || [];
      const next = list.filter((p) => p.id !== pinId);
      if (!next.length) delete state.imageMarkPins[nodeId];
      else state.imageMarkPins[nodeId] = next;
    },
    clearImageMarkPin(state, action: PayloadAction<string>) {
      const nodeId = String(action.payload || '').trim();
      if (!nodeId) return;
      delete state.imageMarkPins[nodeId];
    },
    setHoveredMarkPin(
      state,
      action: PayloadAction<{ nodeId: string; pinId: string } | null>
    ) {
      state.hoveredMarkPin = action.payload;
    },
} as const;


export const createTemplate = bindEditorMutator(editorReducers.createTemplate);
export const openTemplate = bindEditorMutator(editorReducers.openTemplate);
export const setDocument = bindEditorMutator(editorReducers.setDocument);
export const commitPastedDocument = bindEditorMutator(editorReducers.commitPastedDocument);
export const setDocumentFromCanvas = bindEditorMutator(editorReducers.setDocumentFromCanvas);
export const bakeDocumentOrigin = bindEditorMutator(editorReducers.bakeDocumentOrigin);
export const removeDocumentNodes = bindEditorMutator(editorReducers.removeDocumentNodes);
export const clearImageProcess = bindEditorMutator(editorReducers.clearImageProcess);
export const patchDocumentNode = bindEditorMutator<
  typeof initialState,
  {
    nodeId: string;
    patch: Record<string, unknown> | object;
    skipHistory?: boolean;
    skipHostReload?: boolean;
  }
>(editorReducers.patchDocumentNode);
export const patchDocumentNodes = bindEditorMutator(editorReducers.patchDocumentNodes);
export const setSelectedNodeId = bindEditorMutator(editorReducers.setSelectedNodeId);
export const setSelectedNodeIds = bindEditorMutator(editorReducers.setSelectedNodeIds);
export const addArtboardFrame = bindEditorMutator(editorReducers.addArtboardFrame);
export const setActiveFrameId = bindEditorMutator(editorReducers.setActiveFrameId);
export const setFrameChromeMode = bindEditorMutator(editorReducers.setFrameChromeMode);
export const setSoftFrameContext = bindEditorMutator(editorReducers.setSoftFrameContext);
export const setSelectedFrameIds = bindEditorMutator(editorReducers.setSelectedFrameIds);
export const setMixedSelection = bindEditorMutator(editorReducers.setMixedSelection);
export const removeArtboardFrames = bindEditorMutator(editorReducers.removeArtboardFrames);
export const renameArtboardFrame = bindEditorMutator(editorReducers.renameArtboardFrame);
export const updateArtboardFrame = bindEditorMutator(editorReducers.updateArtboardFrame);
export const updateArtboardFrames = bindEditorMutator(editorReducers.updateArtboardFrames);
export const pushEditorHistory = bindEditorMutator(editorReducers.pushEditorHistory);
export const touchDocumentRevision = bindEditorMutator(editorReducers.touchDocumentRevision);
export const beginAiSceneMutation = bindEditorMutator(editorReducers.beginAiSceneMutation);
export const endAiSceneMutation = bindEditorMutator(editorReducers.endAiSceneMutation);
export const beginCanvasApplyLock = bindEditorMutator(editorReducers.beginCanvasApplyLock);
export const endCanvasApplyLock = bindEditorMutator(editorReducers.endCanvasApplyLock);
export const renameTemplate = bindEditorMutator(editorReducers.renameTemplate);
export const persistCurrent = bindEditorMutator(editorReducers.persistCurrent);
export const clearEditorDirty = bindEditorMutator(editorReducers.clearEditorDirty);
export const applyCollabDocument = bindEditorMutator(editorReducers.applyCollabDocument);
export const applyCollabScenePatch = bindEditorMutator(editorReducers.applyCollabScenePatch);
export const importDocument = bindEditorMutator(editorReducers.importDocument);
export const mergeImportedDocument = bindEditorMutator(editorReducers.mergeImportedDocument);
export const startImportPlaceholder = bindEditorMutator(editorReducers.startImportPlaceholder);
export const finishImportPlaceholder = bindEditorMutator(editorReducers.finishImportPlaceholder);
export const cancelImportPlaceholder = bindEditorMutator(editorReducers.cancelImportPlaceholder);
export const setAiOperationState = bindEditorMutator(editorReducers.setAiOperationState);
export const clearArtboardGenerating = bindEditorMutator(editorReducers.clearArtboardGenerating);
export const deleteTemplate = bindEditorMutator(editorReducers.deleteTemplate);
export const deleteTemplates = bindEditorMutator(editorReducers.deleteTemplates);
export const renameTemplateById = bindEditorMutator(editorReducers.renameTemplateById);
export const clearProjectsLibrary = bindEditorMutator(editorReducers.clearProjectsLibrary);
export const undo = bindEditorMutator(editorReducers.undo);
export const redo = bindEditorMutator(editorReducers.redo);
export const setActiveTool = bindEditorMutator(editorReducers.setActiveTool);
export const setGridMode = bindEditorMutator(editorReducers.setGridMode);
export const setShapeKind = bindEditorMutator(editorReducers.setShapeKind);
export const setPendingImageSrc = bindEditorMutator(editorReducers.setPendingImageSrc);
export const setCanvasSize = bindEditorMutator(editorReducers.setCanvasSize);
export const setCanvasMeta = bindEditorMutator(editorReducers.setCanvasMeta);
export const startImageUploadPlaceholder = bindEditorMutator(editorReducers.startImageUploadPlaceholder);
export const startVideoUploadPlaceholder = bindEditorMutator(editorReducers.startVideoUploadPlaceholder);
export const startAudioUploadPlaceholder = bindEditorMutator(editorReducers.startAudioUploadPlaceholder);
export const spawnImageGenerator = bindEditorMutator(editorReducers.spawnImageGenerator);
export const spawnVideoGenerator = bindEditorMutator(editorReducers.spawnVideoGenerator);
export const spawnAnimationBoard = bindEditorMutator(editorReducers.spawnAnimationBoard);
export const spawnLottieGeneratorPlate = bindEditorMutator(editorReducers.spawnLottieGeneratorPlate);
export const spawnAudioGenerator = bindEditorMutator(editorReducers.spawnAudioGenerator);
export const spawnLottie = bindEditorMutator(editorReducers.spawnLottie);
export const placeUploadedLottie = bindEditorMutator(editorReducers.placeUploadedLottie);
export const spawnAudio = bindEditorMutator(editorReducers.spawnAudio);
export const spawnCreatedNode = bindEditorMutator(editorReducers.spawnCreatedNode);
export const placeMediaAsset = bindEditorMutator(editorReducers.placeMediaAsset);
export const importLottieIntoAnimationFrame = bindEditorMutator(editorReducers.importLottieIntoAnimationFrame);
export const finishImageGenerator = bindEditorMutator(editorReducers.finishImageGenerator);
export const finishVideoGenerator = bindEditorMutator(editorReducers.finishVideoGenerator);
export const finishLottieGenerator = bindEditorMutator(editorReducers.finishLottieGenerator);
export const finishAudioGenerator = bindEditorMutator(editorReducers.finishAudioGenerator);
export const detachImageVariant = bindEditorMutator(editorReducers.detachImageVariant);
export const startImageProcess = bindEditorMutator(editorReducers.startImageProcess);
export const finishImageProcess = bindEditorMutator(editorReducers.finishImageProcess);
export const failImageProcess = bindEditorMutator(editorReducers.failImageProcess);
export const resumePendingImageProcess = bindEditorMutator(editorReducers.resumePendingImageProcess);
export const openImageToolPanel = bindEditorMutator(editorReducers.openImageToolPanel);
export const closeImageToolPanel = bindEditorMutator(editorReducers.closeImageToolPanel);
export const openVideoToolPanel = bindEditorMutator(editorReducers.openVideoToolPanel);
export const closeVideoToolPanel = bindEditorMutator(editorReducers.closeVideoToolPanel);
export const openAudioToolPanel = bindEditorMutator(editorReducers.openAudioToolPanel);
export const closeAudioToolPanel = bindEditorMutator(editorReducers.closeAudioToolPanel);
export const openLottieComposePanel = bindEditorMutator(editorReducers.openLottieComposePanel);
export const setLottieComposeTool = bindEditorMutator(editorReducers.setLottieComposeTool);
export const closeLottieComposePanel = bindEditorMutator(editorReducers.closeLottieComposePanel);
export const openLottieTimelinePanel = bindEditorMutator(editorReducers.openLottieTimelinePanel);
export const closeLottieTimelinePanel = bindEditorMutator(editorReducers.closeLottieTimelinePanel);
export const enterLottiePrecompEdit = bindEditorMutator(editorReducers.enterLottiePrecompEdit);
export const exitLottiePrecompEdit = bindEditorMutator(editorReducers.exitLottiePrecompEdit);
export const setLottiePrecompSelectedLayer = bindEditorMutator(editorReducers.setLottiePrecompSelectedLayer);
export const setLottiePlayhead = bindEditorMutator(editorReducers.setLottiePlayhead);
export const setLottiePlaying = bindEditorMutator(editorReducers.setLottiePlaying);
export const openAnimationFramePanel = bindEditorMutator(editorReducers.openAnimationFramePanel);
export const closeAnimationFramePanel = bindEditorMutator(editorReducers.closeAnimationFramePanel);
export const ensureAnimationFrameMedia = bindEditorMutator(editorReducers.ensureAnimationFrameMedia);
export const openShapeStylePanel = bindEditorMutator(editorReducers.openShapeStylePanel);
export const closeShapeStylePanel = bindEditorMutator(editorReducers.closeShapeStylePanel);
export const setPenStrokeColor = bindEditorMutator(editorReducers.setPenStrokeColor);
export const setPenFillColor = bindEditorMutator(editorReducers.setPenFillColor);
export const setPenStrokeWidth = bindEditorMutator(editorReducers.setPenStrokeWidth);
export const setPenStrokeOpacity = bindEditorMutator(editorReducers.setPenStrokeOpacity);
export const setBucketFill = bindEditorMutator(editorReducers.setBucketFill);
export const setPencilBrushId = bindEditorMutator(editorReducers.setPencilBrushId);
export const setPencilPressureEnabled = bindEditorMutator(editorReducers.setPencilPressureEnabled);
export const setWorkspaceMode = bindEditorMutator(editorReducers.setWorkspaceMode);
export const setDevHoverNodeId = bindEditorMutator(editorReducers.setDevHoverNodeId);
export const setAgentBusy = bindEditorMutator(editorReducers.setAgentBusy);
export const startCanvasAttachPick = bindEditorMutator(editorReducers.startCanvasAttachPick);
export const clearCanvasAttachPick = bindEditorMutator(editorReducers.clearCanvasAttachPick);
export const setCanvasAttachPickBlocked = bindEditorMutator(editorReducers.setCanvasAttachPickBlocked);
export const setPendingCanvasAttach = bindEditorMutator(editorReducers.setPendingCanvasAttach);
export const consumePendingCanvasAttach = bindEditorMutator(editorReducers.consumePendingCanvasAttach);
export const enqueueAgentContexts = bindEditorMutator(editorReducers.enqueueAgentContexts);
export const consumePendingAgentContexts = bindEditorMutator(editorReducers.consumePendingAgentContexts);
export const enqueueQuickEditMarkContexts = bindEditorMutator(editorReducers.enqueueQuickEditMarkContexts);
export const consumePendingQuickEditMarkContexts = bindEditorMutator(editorReducers.consumePendingQuickEditMarkContexts);
export const enqueueImageGenMarkContexts = bindEditorMutator(editorReducers.enqueueImageGenMarkContexts);
export const consumePendingImageGenMarkContexts = bindEditorMutator(editorReducers.consumePendingImageGenMarkContexts);
export const enqueueVideoGenMarkContexts = bindEditorMutator(editorReducers.enqueueVideoGenMarkContexts);
export const consumePendingVideoGenMarkContexts = bindEditorMutator(editorReducers.consumePendingVideoGenMarkContexts);
export const setImageMarkPin = bindEditorMutator(editorReducers.setImageMarkPin);
export const removeImageMarkPin = bindEditorMutator(editorReducers.removeImageMarkPin);
export const clearImageMarkPin = bindEditorMutator(editorReducers.clearImageMarkPin);
export const setHoveredMarkPin = bindEditorMutator(editorReducers.setHoveredMarkPin);

export type EditorState = typeof initialState;
export { initialState as editorInitialState };
export { applyEditorReducer };

/**
 * Pure test helper: apply one case mutator without touching Zustand.
 * Prefer `applyEditorReducer(state, editorReducers.foo, payload)`.
 */
export function reduceEditor(
  state: EditorState | undefined,
  reducer: (state: EditorState, action: { payload: any }) => void,
  payload?: unknown
): EditorState {
  return applyEditorReducer(state ?? initialState, reducer as any, payload);
}
