import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  memo,
  type RefObject,
} from 'react';
import { useSelector } from '@/store';
import { useActiveFrameId, useSelectedFrameIds } from '@/store/editorSelectors';
import {
  addNodeToDocument,
  listSingleSelectionPaintRaiseNodeIds,
  removeNodesFromDocument,
  reorderNodesInDocument,
  listSceneNodes,
  updateNodeInDocument,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  createImageNode,
  createShapeNode,
  measureImageNaturalSize,
  parseLottieAnimationData,
  serializeLottieAnimationData,
  prepareVideoUploadPreview,
  fitMediaIntoViewport,
  MEDIA_PLACE_DEFAULT,
} from '@/components/rcb/scene/document/nodeFactories';
import { expandSelectionWithGroups } from '@/components/rcb/scene/document/sceneGroups';
import { listProcessingNodeIds } from '@/components/rcb/process/processGlow';
import {
  nodeIdsBoundToFrames,
  type SceneClipboardPayload,
} from '@/components/rcb/scene/document/sceneClipboard';
import {
  canvasBulkItemCount,
  runCanvasBulkOp,
} from '@/components/editor/canvas/canvasBulkOpLoading';
import {
  loadSceneOntoSvg,
  nodeLeftTop,
} from '@/components/rcb/scene/paint/sceneToSvg';
import { sceneToDocumentCoords } from '@/components/rcb/scene/paint/svgToScene';
import { strokeCenterlineToFilledOutline } from '@/components/rcb/scene/paint/outlineToPath';
import { computeShapeBoolean, type ShapeBox } from '@/components/rcb/selection/shapeBoolean';
import { createDragWriteCoalescer } from './dragWriteCoalescer';
import {
  bindCreatedNodeToFrame,
  createCanvasSession,
  type CanvasSession,
  layoutGeneratorPlateAtScene,
} from './canvasSession';
import { runCanvasCtxAction } from './runCanvasCtxAction';
import {
  setSceneHitTestBridge,
} from '@/components/rcb/scene/document/sceneHitBridge';
import {
  SceneSpatialRuntime,
  getSharedSceneSpatialRuntime,
  setSharedSceneSpatialRuntime,
} from '@/components/rcb/core/spatialIndex';
import {
  createSvgSceneRenderer,
  type SceneRenderer,
} from '@/components/rcb/render/sceneRenderer';
import { useSvgBoard } from '@/components/rcb/canvas/useSvgBoard';
import {
  RcbShapesLayer,
  replaceShapePaint,
  setSharedNodeEls,
  listShapeHosts,
  rcbScreenToScene,
  type SvgBoardHandle,
} from '@/components/rcb';
import {
  getSceneWorldRoot,
  subscribeShapeHosts,
} from '@/components/rcb/shapes/shapeHostRegistry';
import {
  clearLiveArtboardFrameGeometry,
  previewArtboardFrameGeometry,
} from '@/components/rcb/frames/HtmlArtboardFrame';
import { listSelectionRevealOverflowIds } from '@/components/rcb/selection/selectionPaintRaise';
import { previewSvgNodeTransform } from '@/components/rcb/scene/paint/sceneToSvg';
import {
  abortNodeUpload,
  formatUploadErrorMessage,
  isUploadAbortError,
  createFilePreviewUrl,
  revokeNodePreviewSrc,
} from '@/utils/uploadImage';
import { uploadCanvasPlaceholderFile } from '@/utils/canvasUploadFlow';
import { probeAudioDuration } from '@/components/editor/nodes/shared/mediaProbe';
import store, { type RootState } from '@/store';
import { message } from '@/components/base';
import { useTranslation } from 'react-i18next';
import {
  cssPreviewForGradient,
  parseFillGradient,
  parseFillType,
  parseFillImageAdjust,
  serializeFillImageAttrs,
} from '@/components/rcb/scene/document/sceneFill';
import { cssSolidWithOpacity } from '@/components/base/colorPanel';
import {
  patchDocumentNode,
  setActiveFrameId,
  setFrameChromeMode,
  setSelectedFrameIds,
  setMixedSelection,
  setActiveTool,
  setDocument,
  setDocumentFromCanvas,
  removeDocumentNodes,
  pushEditorHistory,
  setPendingImageSrc,
  setSelectedNodeId,
  setSelectedNodeIds,
  startImageUploadPlaceholder,
  startVideoUploadPlaceholder,
  startAudioUploadPlaceholder,
  finishImageProcess,
  failImageProcess,
  spawnAnimationBoard,
  spawnLottie,
  undo,
  redo,
  clearCanvasAttachPick,
  setCanvasAttachPickBlocked,
  setPendingCanvasAttach,
  isImageToolSidePanelKind,
  isImageToolCropSessionKind,
} from '@/store/modules/editor';
import {
  beginSelectPerf,
  endSelectPerfAfterPaint,
  markInteractionPerf,
  markSelectPerf,
} from '@/components/editor/sceneEvents';
import { requestProjectFlush } from '@/components/editor/useProjectCloudSync';
import {
  canCollabRedo,
  canCollabUndo,
  collabRedo,
  collabUndo,
  getCollabUndoEpoch,
  getCollabViewEpoch,
  isCollabActive,
  isCollabViewOnly,
  subscribeCollabUndo,
  subscribeCollabView,
} from '@/components/editor/collab/collabRuntime';
import SvgPaper from './SvgPaper';
import { pointerToWorld, type ArtboardRect } from './pointerToWorld';
import {
  attachPickFilterOpts,
  canAttachFrameToPick,
  ctxMenuSeedNodeIds,
  filterChatAttachNodeIds,
  frameForFullBleedPlate,
  resolveAttachPickPayload,
} from './attachPick';
import { parseFrameSelId } from '@/components/rcb/selection/frameSelectionIds';
import { ctxMenuTargetHasProcessing, resolveCtxMenuTargets } from './ctxMenuGuards';
import { buildCanvasContextMenuProps } from './buildCanvasContextMenuProps';
import { closedPenFillAttrs, pathNodeHasSolidFill } from './penFillAttrs';
import {
  resolveAnimationFrameId,
} from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  getWorkbenchToolPolicy,
  setSceneGeometryGestureActive,
  warnIfAvBlockedByAnimationWorkbenchFocus,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { requestPlayheadSceneApply } from '@/components/editor/nodes/AnimationNode/animationPlayheadApplyEvent';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import {
  useCanvasClipboard,
  type CanvasClipboardApi,
} from './clipboard/useCanvasClipboard';
import { useCanvasContextMenu } from './contextMenu/useCanvasContextMenu';
import { useChatImageDrop } from './drop/useChatImageDrop';
import { useCanvasHotkeys } from './keyboard/useCanvasHotkeys';
import {
  SelectionFeature,
  ShapeDrawFeature,
  TextPlaceFeature,
  ImagePlaceFeature,
  PencilDrawFeature,
  PenDrawFeature,
  PenPathEditFeature,
  BucketFillFeature,
  DEFAULT_PENCIL_BRUSH_ID,
  findPencilBrush,
  rcbCenterOnPoint,
  getDocumentGridSize,
  snapCoordToGrid,
} from '@/components/rcb';
import AudioNodeOverlay, {
  resolveActiveAudioPlayerId,
  type AudioGeomOverride,
} from '@/components/editor/nodes/AudioNode/AudioNodeOverlay';
import VideoNodeOverlay, {
  type VideoGeomOverride,
} from '@/components/editor/nodes/VideoNode/VideoNodeOverlay';
import { resolveActiveVideoDecoderId } from '@/components/editor/nodes/VideoNode/VideoHoverPlayback';
import AnimationPlayheadSceneSync from '@/components/editor/nodes/AnimationNode/AnimationPlayheadSceneSync';
import AnimationNodeOverlay, {
  type LottieGeomOverride,
} from '@/components/editor/nodes/AnimationNode/AnimationNodeOverlay';
import type { SceneDocument, ScenePage } from '@/components/rcb/sceneNode';
import TextInlineEditor from '@/components/editor/nodes/TextNode/TextInlineEditor';
import TextFrameOverlay from '@/components/editor/nodes/TextNode/TextFrameOverlay';
import CanvasContextMenu, {
  type ContextMenuState,
  type CtxAction,
} from '@/components/rcb/selection/chrome/CanvasContextMenu';
import {
  useRcbCamera,
  useRcbOverlayRoot,
  useRcbViewportEl,
} from '@/components/rcb';

const EMPTY_NODE_IDS: string[] = [];

type SvgCanvasProps = {
  document: SceneDocument;
  readOnly?: boolean;
  /**
   * Skip image/video-generator plates and process-shimmer (share preview / export-like view).
   */
  omitNonExportable?: boolean;
  reloadToken?: number;
  selectedNodeId?: string | null;
  selectedNodeIds?: string[];
  documentPatchToken?: number;
  /** Nodes patched via the editor store — refresh SVG even when selection is empty (e.g. agent busy). */
  lastPatchedNodeIds?: string[];
  lastPatchTransformOnly?: boolean;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onLoadStart?: () => void;
  onReady?: () => void;
  /** Notify the parent world while selection move / resize / rotate is active. */
  onTransformingChange?: (transforming: boolean) => void;
  /** Artboard drag — same handlers as title label move (hide title, co-move children). */
  onFrameMoveStart?: (frameId: string) => void;
  onFrameMoveEnd?: () => void;
  onFrameMove?: (
    frameId: string,
    x: number,
    y: number,
    opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }
  ) => void;
  /**
   * Hide selection control box while an artboard/workbench is title-dragged
   * (SelectionFeature transforming is not set for that path — same UX as shapes).
   */
  suppressChromeWhileFrameMoving?: boolean;
  /** Open the editor AI agent dock (selection contextual bar). */
  onOpenAgent?: (opts?: { prompt?: string }) => void;
  /** Right-click 銆屾坊鍔犲埌 Chat銆嶁€?one node id, `frame:id`, or multiple selected ids as one group. */
  onAddToChat?: (target: string | string[]) => void;
  /** When true, paper has no outer shadow (hosted inside HtmlArtboardFrame). */
  embedded?: boolean;
  /** Full viewport stage — pencil/pen hit-test beyond the finite SVG paper. */
  stageEl?: HTMLElement | null;
  /**
   * Drawable paper in world units. Prefer origin at (0,0) and grow width/height
   * to cover the camera frustum — do not slide the origin with pan/zoom.
   */
  viewRect?: { x: number; y: number; width: number; height: number } | null;
  /** Parent frame-drag — same preview path as shape move (updates documentRef). */
  geometryPreviewRef?: RefObject<CanvasSession['onGeometryPreview'] | null>;
  getPreviewDocumentRef?: RefObject<() => SceneDocument | null>;
  /**
   * Title-label / workbench plate drag sets this synchronously on pointer-down.
   * Without it, render syncs `documentRef` from the committed store doc and
   * preview ink jumps against the live plate.
   */
  frameGestureActiveRef?: RefObject<boolean>;
  resetFrameGestureRef?: RefObject<(() => void) | null>;
  /** Reactive companion to frameGestureActiveRef (bumps spatial / patch guards). */
  frameGestureActive?: boolean;
};

/**
 * SVG.js editor shell — mounts the board and composes feature components.
 */
function SvgCanvas({
  document,
  readOnly = false,
  omitNonExportable = false,
  reloadToken = 0,
  selectedNodeId = null,
  selectedNodeIds = [],
  documentPatchToken = 0,
  lastPatchedNodeIds = [],
  lastPatchTransformOnly = false,
  onZoomIn,
  onZoomOut,
  onReady,
  onTransformingChange,
  onFrameMoveStart,
  onFrameMoveEnd,
  onFrameMove,
  suppressChromeWhileFrameMoving = false,
  onOpenAgent,
  onAddToChat,
  embedded = false,
  stageEl = null,
  viewRect = null,
  geometryPreviewRef,
  getPreviewDocumentRef,
  frameGestureActiveRef,
  resetFrameGestureRef,
  frameGestureActive = false,
}: SvgCanvasProps) {
  const { t } = useTranslation();
  const camera = useRcbCamera();
  const viewportEl = useRcbViewportEl();
  useSyncExternalStore(subscribeCollabView, getCollabViewEpoch, getCollabViewEpoch);
  const collabViewOnly = isCollabViewOnly();
  // Collab share viewers: block mutations while still allowing pan/zoom/select chrome.
  readOnly = Boolean(readOnly || collabViewOnly);
  const canvasApplyLock = useSelector(
    (s: RootState) => (s.editor.canvasApplyLock || 0) as number
  );
  const applyLocked = canvasApplyLock > 0;
  const activeTool = useSelector((s: RootState) => s.editor.activeTool);
  const shapeKind = useSelector((s: RootState) => s.editor.shapeKind);
  const pendingImageSrc = useSelector((s: RootState) => s.editor.pendingImageSrc);
  const penStrokeColor = useSelector((s: RootState) => String(s.editor.penStrokeColor || '#333333'));
  const penFillColor = useSelector((s: RootState) =>
    String(s.editor.penFillColor ?? 'transparent')
  );
  const penStrokeWidth = useSelector((s: RootState) => {
    const n = Number(s.editor.penStrokeWidth);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
  const pencilBrushId = useSelector((s: RootState) =>
    String(s.editor.pencilBrushId || DEFAULT_PENCIL_BRUSH_ID)
  );
  const pencilPressureEnabled = useSelector((s: RootState) =>
    s.editor.pencilPressureEnabled !== false
  );
  const penStrokeOpacity = useSelector((s: RootState) => {
    const n = Number(s.editor.penStrokeOpacity);
    return Number.isFinite(n) ? Math.max(1, Math.min(100, n)) : 100;
  });
  const bucketFill = useSelector((s: RootState) => s.editor.bucketFill);
  const bucketFillRef = useRef(bucketFill);
  bucketFillRef.current = bucketFill;
  const workspaceMode = useSelector(
    (s: RootState) => (s.editor.workspaceMode || 'design') as 'design' | 'dev'
  );
  const canvasAttachPick = useSelector(
    (s: RootState) =>
      s.editor.canvasAttachPick as null | { target: string; accept?: 'image' | 'media' }
  );
  const canvasAttachPickRef = useRef(canvasAttachPick);
  canvasAttachPickRef.current = canvasAttachPick;
  const onAddToChatRef = useRef(onAddToChat);
  onAddToChatRef.current = onAddToChat;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const lastPointerClientRef = useRef({ x: 0, y: 0 });
  const hitTestRef = useRef<(x: number, y: number, screen?: { clientX: number; clientY: number }) => string | null>(
    () => null
  );
  const storeCanUndo = useSelector((s: RootState) => (s.editor.historyPast?.length || 0) > 0);
  const storeCanRedo = useSelector((s: RootState) => (s.editor.historyFuture?.length || 0) > 0);
  useSyncExternalStore(subscribeCollabUndo, getCollabUndoEpoch, getCollabUndoEpoch);
  // Collab prefers Yjs undo; if that stack is empty (pre-seed / sync lag), fall
  // back to the editor store so the menu and Ctrl+Z stay usable. View-only never undoes.
  const viewOnly = isCollabViewOnly();
  const collabActive = isCollabActive();
  const canUndo = !viewOnly && (collabActive ? canCollabUndo() || storeCanUndo : storeCanUndo);
  const canRedo = !viewOnly && (collabActive ? canCollabRedo() || storeCanRedo : storeCanRedo);
  const imageToolPanel = useSelector(
    (s: RootState) => s.editor.imageToolPanel as null | { nodeId: string; kind: string }
  );
  const imageToolSessionNodeId =
    imageToolPanel &&
    (imageToolPanel.kind === 'mark' ||
      imageToolPanel.kind === 'quickEdit')
      ? imageToolPanel.nodeId
      : null;
  const imageToolPanelKind = imageToolPanel?.kind;
  const shapeStylePanel = useSelector((s: RootState) => s.editor.shapeStylePanel as null | { kind: string });
  const shapeStylePanelOpen = Boolean(shapeStylePanel);
  const cropExpandOpen = isImageToolCropSessionKind(imageToolPanelKind);
  const imageToolSidePanelOpen = isImageToolSidePanelKind(imageToolPanelKind);
  const videoToolPanelKind = useSelector(
    (s: RootState) => s.editor.videoToolPanel?.kind as string | undefined
  );
  const videoToolPanel = useSelector(
    (s: RootState) => s.editor.videoToolPanel as null | { nodeId: string; kind: string }
  );
  const videoToolOpen = videoToolPanelKind === 'trim';
  const audioToolPanelKind = useSelector(
    (s: RootState) => s.editor.audioToolPanel?.kind as string | undefined
  );
  const audioToolPanel = useSelector(
    (s: RootState) => s.editor.audioToolPanel as null | { nodeId: string; kind: string }
  );
  const audioToolOpen =
    audioToolPanelKind === 'trim' || audioToolPanelKind === 'speed';
  const activeFrameId = useActiveFrameId();
  const selectedFrameIds = useSelectedFrameIds();
  const animationTimelineOpen = useSelector(
    (s: RootState) => Boolean(s.editor.lottieTimelinePanel?.nodeId)
  );

  const paperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Scene / selection refs (declared once — do not duplicate in this component).
  const documentRef = useRef(document);
  const selectedIdsRef = useRef<string[]>([]);
  const activeFrameIdRef = useRef<string | null>(null);
  const selectedFrameIdsRef = useRef<string[]>([]);
  const loadSeqRef = useRef(0);
  const lastLoadKeyRef = useRef<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imagePlaceAtRef = useRef<{ x: number; y: number } | null>(null);
  const [paperEl, setPaperEl] = useState<HTMLElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const clipboardRef = useRef<SceneClipboardPayload | null>(null);
  /** When the in-app node clipboard was last written (Ctrl+C / cut / context copy). */
  const internalClipboardAtRef = useRef(0);
  /** Last seen OS clipboard fingerprint + when it changed (for paste priority). */
  const osClipboardMetaRef = useRef<{ fingerprint: string; at: number }>({
    fingerprint: '',
    at: 0,
  });
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  /** Double-click pen path → anchor / handle edit. */
  const [editingPenId, setEditingPenId] = useState<string | null>(null);
  const [pathEditSubtool, setPathEditSubtool] = useState<'select' | 'pen' | 'add-anchor' | 'curve'>('select');
  /** After inline text commit, blank-canvas pointerup must not clear selection. */
  const keepSelectAfterTextEditRef = useRef<string | null>(null);
  /** Frames painted directly during a mixed transform; restored on cancellation. */
  const frameGeometryPreviewIdsRef = useRef(new Set<string>());
  const resetFrameMoveOwnersRef = useRef<() => void>(() => undefined);
  const [geometryTransforming, setGeometryTransforming] = useState(false);
  const geometryTransformingRef = useRef(false);
  /** Live video plate boxes while dragging — editor store only commits on gesture end. */
  const [videoLiveGeom, setVideoLiveGeom] = useState<Record<string, VideoGeomOverride> | null>(
    null
  );
  const setVideoLiveGeomRef = useRef(setVideoLiveGeom);
  setVideoLiveGeomRef.current = setVideoLiveGeom;
  const dragWriteCoalesceRef = useRef(
    createDragWriteCoalescer(({ videoGeom }) => {
      if (videoGeom !== undefined) setVideoLiveGeomRef.current(videoGeom);
    })
  );
  useEffect(
    () => () => {
      dragWriteCoalesceRef.current.cancel();
    },
    []
  );
  const overlayRoot = useRcbOverlayRoot();

  const clearFrameGeometryPreview = useCallback((frameIds?: readonly string[]) => {
    // Prefer the editor store after setDocumentFromCanvas. documentRef can still
    // hold a mid-gesture snapshot, or get overwritten by a one-frame-stale
    // props.document when preserveLiveDocumentRef flips false on pointer-up —
    // baking hosts from that stale doc desyncs the white plate from the blue box.
    const storeDoc = (store.getState() as RootState).editor?.document ?? null;
    const liveDoc = documentRef.current;
    const framesSource = storeDoc || liveDoc;
    const frames = Array.isArray(framesSource?.frames) ? framesSource.frames : [];
    // Prefer explicit commit ids — multi-frame mode:move can cancel the last
    // preview rAF so the tracked preview set is empty while hosts are still stale.
    const fromArg = (frameIds || []).map(String).filter(Boolean);
    const fromPreview = [...frameGeometryPreviewIdsRef.current];
    const ids = [...new Set(fromArg.length ? [...fromArg, ...fromPreview] : fromPreview)];
    if (storeDoc) documentRef.current = storeDoc;
    clearLiveArtboardFrameGeometry(ids.length ? ids : undefined);
    ids.forEach((id) => {
      const frame = frames.find((item: any) => String(item?.id) === id);
      if (frame) previewArtboardFrameGeometry(frame, { recordLive: false });
    });
    frameGeometryPreviewIdsRef.current.clear();
  }, []);

  const onGeometryTransformingChange = useCallback((next: boolean) => {
    geometryTransformingRef.current = next;
    // Plate drag uses `setAnimationWorkbenchGeometryPreview` (blocks ensure/collab).
    // Selection transforms use a separate gate so playhead stops fighting child
    // TransformPreview without sticking the plate-only ensure/collab path.
    setSceneGeometryGestureActive(next);
    if (next) {
      // Drop playhead-owned previews so drag coalescer owns only moved ids
      // (avoids QT markDirtyMany across every linked workbench child each frame).
      clearNodeTransformPreviews();
    } else {
      requestPlayheadSceneApply({ afterPaint: true });
    }
    setGeometryTransforming(next);
    onTransformingChange?.(next);
    if (!next) {
      dragWriteCoalesceRef.current.cancel();
      // Clear live geom with the editor store document write in onGeometryCommit when
      // possible. Soft-click / cancelled transforms still need a clear here.
      setVideoLiveGeom(null);
      clearFrameGeometryPreview();
      resetFrameMoveOwnersRef.current();
    }
  }, [clearFrameGeometryPreview, onTransformingChange]);
  // Geometry previews update documentRef before the editor store commits on pointer-up.
  // Do not overwrite that live document with the committed store snapshot while
  // a transform is active, otherwise cleared frame bindings reappear.
  function preserveLiveDocumentRef(): boolean {
    if (geometryTransformingRef.current) return true;
    if (frameGestureActiveRef?.current) return true;
    if (frameGestureActive) return true;
    return false;
  }
  if (!preserveLiveDocumentRef()) {
    documentRef.current = document;
  }
  selectedIdsRef.current = ctxMenuSeedNodeIds(selectedNodeIds || [], selectedNodeId);
  activeFrameIdRef.current = activeFrameId;
  selectedFrameIdsRef.current = selectedFrameIds;

  // Content bounds (export / guides). Infinite embedded mode has no DOM paper size —
  // camera CSS on RcbCanvas world layer owns pan/zoom.
  const paperW = viewRect?.width || document?.width || 794;
  const paperH = viewRect?.height || document?.height || 1123;
  const infinite = Boolean(embedded);
  const artboard = useMemo(
    () => ({ x: 0, y: 0, width: paperW, height: paperH }),
    [paperW, paperH]
  );
  const modLabel = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? '?' : 'Ctrl';
  // Embedded infinite canvas: per-shape hosts (RcbShapesLayer). Finite paper keeps mono board.
  const { boardRef: monoBoardRef, boardEpoch } = useSvgBoard(hostRef, paperW, paperH, {
    infinite,
    enabled: !infinite,
  });
  const nodeElsRef = useRef(new Map<string, SVGElement>());
  const perShapeBoardRef = useRef<SvgBoardHandle>({
    root: null as unknown as SVGSVGElement,
    layer: null as unknown as SVGGElement,
    nodeEls: nodeElsRef.current,
    getSvgElement: () => null,
    toSvgString: () => '',
  });
  const boardRef = infinite ? perShapeBoardRef : monoBoardRef;

  useEffect(() => {
    if (!infinite) return undefined;
    setSharedNodeEls(nodeElsRef.current);
    perShapeBoardRef.current.nodeEls = nodeElsRef.current;
    // Clip defs / syncFrameContentClip need a real SVG root on infinite canvas.
    const worldRoot = getSceneWorldRoot();
    if (worldRoot) perShapeBoardRef.current.root = worldRoot;
    // Hosts that painted before shared map was set wrote into a throwaway Map.
    listShapeHosts().forEach((h) => {
      if (h.el) nodeElsRef.current.set(h.nodeId, h.el);
    });
    return () => setSharedNodeEls(null);
  }, [infinite]);

  // Scene world SVG mounts after first layout — keep board.root wired for clip sync.
  useEffect(() => {
    if (!infinite) return undefined;
    function syncWorldRoot() {
      const worldRoot = getSceneWorldRoot();
      if (worldRoot) perShapeBoardRef.current.root = worldRoot;
    }
    syncWorldRoot();
    return subscribeShapeHosts(syncWorldRoot);
  }, [infinite]);

  useEffect(() => {
    setPaperEl(paperRef.current);
  }, [boardEpoch, infinite]);

  // Non-infinite only: keep a finite SVG paper. Embedded infinite must NOT re-apply viewBox.
  useEffect(() => {
    if (infinite) return;
    const board = boardRef.current;
    if (!board) return;
    const w = Math.max(1, Math.round(paperW));
    const h = Math.max(1, Math.round(paperH));
    try {
      board.root.setAttribute('width', String(w));
      board.root.setAttribute('height', String(h));
      board.root.setAttribute('viewBox', `0 0 ${w} ${h}`);
      board.root.setAttribute('preserveAspectRatio', 'none');
    } catch {
      /* ignore */
    }
  }, [infinite, paperW, paperH, boardEpoch, boardRef]);

  useEffect(() => {
    if (infinite) {
      // Per-shape hosts mount via RcbShapesLayer; signal ready once children are known.
      onReadyRef.current?.();
      return;
    }
    const board = boardRef.current;
    if (!board || !document) return;
    // Width/height omitted: world surface padding changes on every edge move.
    const key = `${reloadToken}:${boardEpoch}:${String(document.backgroundColor || '')}`;
    if (lastLoadKeyRef.current === key) return;
    lastLoadKeyRef.current = key;

    const seq = ++loadSeqRef.current;
    board.loadSeq = seq;
    // Drop stale wrappers immediately so in-place preview cannot re-attach detached ghosts.
    board.nodeEls = new Map();
    async function loadScene() {
      const map = await loadSceneOntoSvg(board.root, board.layer, document, seq, board, {
        infinite,
        omitNonExportable,
      });
      if (loadSeqRef.current !== seq) return;
      board.nodeEls = map || new Map();
      onReadyRef.current?.();
    }
    void loadScene();
  }, [document, reloadToken, boardEpoch, infinite, omitNonExportable, boardRef]);

  useEffect(() => {
    if (!documentPatchToken || preserveLiveDocumentRef()) return;
    const board = boardRef.current;
    const doc = documentRef.current;
    if (!board || !doc) return;
    // Only nodes touched by the latest document patch — never repaint on selection
    // alone (re-setting a video poster flashes the first frame under the live <video>).
    lastPatchedNodeIds.forEach((id) => {
      if (!id) return;
      if (lastPatchTransformOnly) {
        const node = doc.deltaSetLike?.[id];
        if (previewSvgNodeTransform(board.nodeEls, id, node)) return;
      }
      void replaceShapePaint(doc, board.nodeEls, id, board.root ? board : null);
    });
  }, [
    documentPatchToken,
    lastPatchTransformOnly,
    lastPatchedNodeIds,
    geometryTransforming,
    frameGestureActive,
    boardRef,
  ]);

  const cameraZoomRef = useRef(camera.zoom);
  cameraZoomRef.current = camera.zoom;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const overlayRootRef = useRef(overlayRoot);
  overlayRootRef.current = overlayRoot;
  const paperElRef = useRef(paperEl);
  paperElRef.current = paperEl;
  // boardRef identity flips with infinite mode — hold the live ref object.
  const boardRefHolder = useRef(boardRef);
  boardRefHolder.current = boardRef;

  /**
   * Spatial index — owned by SceneSpatialRuntime (reload / membership / patch).
   * Never rebuild every AABB because size drifted by 1.
   * Published via setSharedSceneSpatialRuntime for stage underlay consumers.
   */
  const spatialRuntimeRef = useRef(new SceneSpatialRuntime(256));
  useEffect(() => {
    setSharedSceneSpatialRuntime(spatialRuntimeRef.current);
    return () => {
      if (getSharedSceneSpatialRuntime() === spatialRuntimeRef.current) {
        setSharedSceneSpatialRuntime(null);
      }
    };
  }, []);
  const session = useMemo(
    () =>
      createCanvasSession({
        getDocument: () => documentRef.current,
        getCommittedDocument: () =>
          (store.getState() as RootState).editor?.document ?? null,
        setDocumentLocal: (doc) => {
          documentRef.current = doc;
        },
        getBoard: () => {
          const board = boardRefHolder.current.current;
          if (board && !board.root) {
            const worldRoot = getSceneWorldRoot();
            if (worldRoot) board.root = worldRoot;
          }
          return board;
        },
        getZoom: () => cameraZoomRef.current,
        isReadOnly: () => readOnlyRef.current,
        spatial: spatialRuntimeRef.current,
        setEditingTextId,
        measureViewport: () =>
          overlayRootRef.current?.getBoundingClientRect() ||
          paperElRef.current?.parentElement?.getBoundingClientRect() ||
          null,
        getDragWriteCoalescer: () => dragWriteCoalesceRef.current,
        previewFrameGeometry: (frames) => {
          frames.forEach((frame) => {
            if (previewArtboardFrameGeometry(frame)) {
              frameGeometryPreviewIdsRef.current.add(String(frame.id));
            }
          });
        },
        clearFrameGeometryPreview,
        publishVideoLiveGeom: (next) => {
          dragWriteCoalesceRef.current.queueVideoGeom(next);
        },
        clearVideoLiveGeom: () => {
          setVideoLiveGeomRef.current(null);
        },
      }),
    [clearFrameGeometryPreview]
  );
  resetFrameMoveOwnersRef.current = session.resetFrameMoveOwners;
  const {
    listNodeIds,
    getNodeBox,
    hitTestFrame,
    queryNodeIdsInRect,
    finishToSelect,
    onCreateShape,
    onPlaceText,
    imageSizeForViewport,
    placeImageAt,
    onGeometryCommit,
    onGeometryPreview,
    onAngleCommit,
    onAnglePreview,
  } = session;

  useEffect(() => {
    if (geometryPreviewRef) geometryPreviewRef.current = onGeometryPreview;
    if (getPreviewDocumentRef) {
      getPreviewDocumentRef.current = () => documentRef.current;
    }
    if (resetFrameGestureRef) {
      resetFrameGestureRef.current = () => {
        resetFrameMoveOwnersRef.current();
      };
    }
    return () => {
      if (geometryPreviewRef) geometryPreviewRef.current = null;
      if (getPreviewDocumentRef) getPreviewDocumentRef.current = () => null;
      if (resetFrameGestureRef) resetFrameGestureRef.current = null;
    };
  }, [geometryPreviewRef, getPreviewDocumentRef, resetFrameGestureRef, onGeometryPreview]);

  /**
   * ADR 0027 SceneRenderer — svg adapter owns hit; paint still via shape hosts.
   * Precise hit is Path2D / AABB only (no live SVG DOM lattice).
   * canvasSession.hitTest uses the same spatial helper for non-UI callers.
   */
  const sceneRenderer = useMemo(
    (): SceneRenderer =>
      createSvgSceneRenderer({
        getDocument: () => documentRef.current,
        getSpatial: () => spatialRuntimeRef.current,
        getZoom: () => cameraZoomRef.current,
        listNodeIds,
        getNodeBox,
      }),
    [listNodeIds, getNodeBox]
  );
  useEffect(() => () => sceneRenderer.dispose(), [sceneRenderer]);

  const hitTest = useCallback(
    (x: number, y: number, screen?: { clientX: number; clientY: number }) =>
      sceneRenderer.hitTest({ x, y }, screen),
    [sceneRenderer]
  );

  const nodeSpatialIndex = useMemo(() => {
    const tMemo0 = performance.now();
    const runtime = spatialRuntimeRef.current;
    const doc = preserveLiveDocumentRef() ? documentRef.current : document;
    if (!doc) {
      runtime.clear();
      return runtime.index;
    }
    const page: ScenePage | undefined =
      doc?.pages?.find((p) => p.id === doc?.activePageId) || doc?.pages?.[0];
    const fromPage = page?.children;
    let childrenSrc: string[] = [];
    if (Array.isArray(fromPage) && fromPage.length) {
      childrenSrc = fromPage;
    } else if (Array.isArray(doc?.deltaSetLike?.ROOT?.children)) {
      childrenSrc = doc.deltaSetLike.ROOT.children;
    }
    const index = runtime.sync({
      document: doc,
      childrenIds: childrenSrc,
      reloadToken,
      patchedNodeIds: lastPatchedNodeIds,
      aabbPad: 32,
    });
    markInteractionPerf('spatial-sync-memo', {
      ms: Number((performance.now() - tMemo0).toFixed(2)),
      children: childrenSrc.length,
      patched: lastPatchedNodeIds.length,
      indexSize: index.size,
    });
    return index;
  }, [document, reloadToken, lastPatchedNodeIds, geometryTransforming, frameGestureActive]);

  useEffect(() => {
    setSceneHitTestBridge(hitTest);
    return () => setSceneHitTestBridge(null);
  }, [hitTest]);

  hitTestRef.current = hitTest;

  /** Apply one canvas pick into composer, then exit pick mode (one pick per activation). */
  const completeCanvasAttachPick = useCallback(
    (pickTarget: string, payload: string | string[]) => {
      if (pickTarget === 'agent') {
        onAddToChatRef.current?.(payload);
      } else {
        // Pending attach keeps the node composer open via the payload — do not
        // steal selection onto the host plate (that feels like exiting pick).
        setPendingCanvasAttach({ target: pickTarget, payload });
      }
      clearCanvasAttachPick();
    },
    []
  );

  const emitAddToChat = useCallback((payload: string | string[]) => {
    onAddToChatRef.current?.(payload);
  }, []);

  // Track pointer for paste anchor / place-at.
  useEffect(() => {
    if (!stageEl) return undefined;
    const onPointer = (e: PointerEvent) => {
      lastPointerClientRef.current = { x: e.clientX, y: e.clientY };
    };
    stageEl.addEventListener('pointerdown', onPointer, true);
    stageEl.addEventListener('pointermove', onPointer, true);
    return () => {
      stageEl.removeEventListener('pointerdown', onPointer, true);
      stageEl.removeEventListener('pointermove', onPointer, true);
    };
  }, [stageEl]);

  // Plus / not-allowed cursor while picking for Chat.
  useEffect(() => {
    if (!canvasAttachPick || !stageEl) {
      setCanvasAttachPickBlocked(false);
      return undefined;
    }
    const onMove = (e: PointerEvent) => {
      const pt = rcbScreenToScene(camera, stageEl, e.clientX, e.clientY);
      const rawHit = hitTestRef.current(pt.x, pt.y, {
        clientX: e.clientX,
        clientY: e.clientY,
      });
      const opts = attachPickFilterOpts(canvasAttachPickRef.current);
      const doc = documentRef.current;
      const frameFromHit = rawHit ? parseFrameSelId(rawHit) : null;
      if (frameFromHit) {
        setCanvasAttachPickBlocked(!canAttachFrameToPick(doc, frameFromHit, opts));
        return;
      }
      if (!rawHit) {
        setCanvasAttachPickBlocked(false);
        return;
      }
      const seed = expandSelectionWithGroups(doc, [rawHit]);
      const attachable = filterChatAttachNodeIds(doc, seed, opts);
      // Full-bleed plate → click promotes to frame; mirror that for the cursor.
      const plate = frameForFullBleedPlate(doc, rawHit);
      if (plate && attachable.length === 0) {
        setCanvasAttachPickBlocked(!canAttachFrameToPick(doc, plate.id, opts));
        return;
      }
      setCanvasAttachPickBlocked(seed.length > 0 && attachable.length === 0);
    };
    stageEl.addEventListener('pointermove', onMove);
    return () => {
      stageEl.removeEventListener('pointermove', onMove);
      setCanvasAttachPickBlocked(false);
    };
  }, [canvasAttachPick, stageEl, camera]);

  const onSelectFrame = useCallback(
    (frameId: string | null, opts?: { chrome?: 'soft' | 'full' }) => {
      const pick = canvasAttachPickRef.current;
      if (pick?.target) {
        if (!frameId) {
          clearCanvasAttachPick();
          return;
        }
        const filter = attachPickFilterOpts(pick);
        if (!canAttachFrameToPick(documentRef.current, frameId, filter)) {
          setCanvasAttachPickBlocked(true);
          return; // stay in pick mode (matches not-allowed cursor)
        }
        completeCanvasAttachPick(pick.target, `frame:${frameId}`);
        return;
      }
      if (!frameId) {
        setActiveFrameId(null);
        return;
      }
      const chrome = opts?.chrome === 'soft' ? 'soft' : 'full';
      setSelectedNodeIds([]);
      setSelectedNodeId(null);
      setActiveFrameId(frameId);
      setFrameChromeMode(chrome);
    },
    [completeCanvasAttachPick]
  );

  const onSelectFrames = useCallback(
    (frameIds: string[]) => {
      const pick = canvasAttachPickRef.current;
      const ids = Array.isArray(frameIds) ? frameIds.filter(Boolean) : [];
      if (pick?.target) {
        if (!ids.length) {
          clearCanvasAttachPick();
          return;
        }
        const filter = attachPickFilterOpts(pick);
        if (!canAttachFrameToPick(documentRef.current, ids[0], filter)) {
          setCanvasAttachPickBlocked(true);
          return;
        }
        completeCanvasAttachPick(pick.target, `frame:${ids[0]}`);
        return;
      }
      if (!ids.length) {
        setActiveFrameId(null);
        return;
      }
      setSelectedNodeIds([]);
      setSelectedFrameIds(ids);
    },
    [completeCanvasAttachPick]
  );

  const onSelectMixed = useCallback(
    (nodeIds: string[], frameIds: string[], opts?: { additive?: boolean }) => {
      const pick = canvasAttachPickRef.current;
      if (pick?.target && !opts?.additive) {
        const resolved = resolveAttachPickPayload(
          documentRef.current,
          nodeIds || [],
          (frameIds || [])[0],
          attachPickFilterOpts(pick)
        );
        if (!resolved) {
          clearCanvasAttachPick();
          return;
        }
        if (resolved.blockedOnly) return; // stay in pick mode
        completeCanvasAttachPick(pick.target, resolved.payload);
        return;
      }
      keepSelectAfterTextEditRef.current = null;
      let nextNodes = expandSelectionWithGroups(documentRef.current, nodeIds || []);
      let nextFrames = [...new Set((frameIds || []).filter(Boolean))];
      if (opts?.additive) {
        const curNodes = new Set(selectedIdsRef.current);
        nextNodes.forEach((id) => {
          if (curNodes.has(id)) curNodes.delete(id);
          else curNodes.add(id);
        });
        nextNodes = [...curNodes];
        const curFrames = new Set(selectedFrameIdsRef.current);
        nextFrames.forEach((id) => {
          if (curFrames.has(id)) curFrames.delete(id);
          else curFrames.add(id);
        });
        nextFrames = [...curFrames];
      }
      const liveN = Object.keys(documentRef.current?.deltaSetLike || {}).length;
      beginSelectPerf(
        `mixed nodes=${nextNodes.length} frames=${nextFrames.length} live≈${liveN}`
      );
      setMixedSelection({ nodeIds: nextNodes, frameIds: nextFrames });
      markSelectPerf('setMixedSelection', {
        selectedNodes: nextNodes.length,
        selectedFrames: nextFrames.length,
      });
      endSelectPerfAfterPaint();
    },
    [ completeCanvasAttachPick]
  );

  const onSelect = useCallback(
    (ids: string[], opts?: { additive?: boolean }) => {
      // Allow selection in read-only Dev/preview so inspect annotations work.
      // Do not re-select after text blur: blank click must clear focus/selection.
      keepSelectAfterTextEditRef.current = null;
      const doc = documentRef.current;
      const pick = canvasAttachPickRef.current;

      // Composer pick mode — attach hit (group-expanded); blocked nodes keep pick active.
      if (pick?.target && !opts?.additive) {
        if (!ids.length) {
          clearCanvasAttachPick();
          return;
        }
        const filter = attachPickFilterOpts(pick);
        if (ids.length === 1) {
          const plateFrame = frameForFullBleedPlate(doc, ids[0]);
          if (plateFrame) {
            if (!canAttachFrameToPick(doc, plateFrame.id, filter)) {
              setCanvasAttachPickBlocked(true);
              return;
            }
            completeCanvasAttachPick(pick.target, `frame:${plateFrame.id}`);
            return;
          }
        }
        const resolved = resolveAttachPickPayload(doc, ids, undefined, filter);
        if (!resolved) {
          clearCanvasAttachPick();
          return;
        }
        if (resolved.blockedOnly) return;
        completeCanvasAttachPick(pick.target, resolved.payload);
        return;
      }

      // Soft-click a near-full-bleed background plate → select the artboard instead
      // (avoids a white+stroke rect looking like a UI overlay on the poster).
      if (!opts?.additive && ids.length === 1) {
        const plateFrame = frameForFullBleedPlate(doc, ids[0]);
        if (plateFrame) {
          const liveN = Object.keys(doc?.deltaSetLike || {}).length;
          beginSelectPerf(`plate-frame live≈${liveN}`);
          setSelectedNodeIds([]);
          setActiveFrameId(plateFrame.id);
          setFrameChromeMode('soft');
          markSelectPerf('plate-frame-dispatch');
          endSelectPerfAfterPaint();
          return;
        }
      }
      // Clicking any grouped member selects the whole group.
      let seed = expandSelectionWithGroups(doc, ids);
      let next = seed;
      const liveN = Object.keys(doc?.deltaSetLike || {}).length;
      if (opts?.additive) {
        const cur = new Set(selectedIdsRef.current);
        seed.forEach((id) => {
          if (cur.has(id)) cur.delete(id);
          else cur.add(id);
        });
        next = [...cur];
        beginSelectPerf(`additive n=${next.length} live≈${liveN}`);
        // Keep frames when shift-adding nodes.
        setSelectedNodeIds(next);
        markSelectPerf('setSelectedNodeIds', { selectedNodes: next.length });
        endSelectPerfAfterPaint();
        return;
      }
      beginSelectPerf(`select n=${next.length} live≈${liveN}`);
      // Prefer setSelectedNodeIds only — setSelectedNodeId clears multi-select to [id].
      setMixedSelection({ nodeIds: next, frameIds: [] });
      markSelectPerf('setMixedSelection', { selectedNodes: next.length });
      endSelectPerfAfterPaint();
    },
    [ completeCanvasAttachPick]
  );

  const onTextEditCommit = useCallback(
    (next: {
      attrs: Record<string, unknown>;
      width: number;
      height: number;
      left?: number;
    }) => {
      if (!editingTextId) return;
      const id = editingTextId;
      const doc = documentRef.current;
      keepSelectAfterTextEditRef.current = null;
      const patch: Record<string, unknown> = {
        attrs: next.attrs,
        width: next.width,
        height: next.height,
      };
      if (next.left != null && doc) {
        const coords = sceneToDocumentCoords(doc, next.left, 0);
        patch.x = coords.x;
      }
      patchDocumentNode({
          nodeId: id,
          patch,
        });
      setEditingTextId(null);
    },
    [ editingTextId]
  );

  const onTextLiveSize = useCallback(
    (next: { width: number; height: number; left?: number; autoSize?: boolean }) => {
      if (!editingTextId) return;
      const doc = documentRef.current;
      const patch: Record<string, unknown> = {
        width: next.width,
        height: next.height,
      };
      if (next.autoSize != null) {
        patch.attrs = { autoSize: next.autoSize ? 'true' : 'false' };
      }
      if (next.left != null && doc) {
        const coords = sceneToDocumentCoords(doc, next.left, 0);
        patch.x = coords.x;
      }
      patchDocumentNode({
          nodeId: editingTextId,
          patch,
          skipHistory: true,
        });
    },
    [ editingTextId]
  );

  const onTextEditCancel = useCallback(() => {
    const id = editingTextId;
    keepSelectAfterTextEditRef.current = null;
    setEditingTextId(null);
    if (!id || !documentRef.current) return;
    const node = documentRef.current.deltaSetLike?.[id];
    const md = String(node?.attrs?.markdown ?? '').trim();
    // Delete empty / freshly placed text that was cancelled.
    if (!md) {
      const next = removeNodesFromDocument(documentRef.current, [id]);
      documentRef.current = next;
      setDocument(next);
      setSelectedNodeIds([]);
      setSelectedNodeId(null);
    } else {
      // Discard edits but keep the node selected (same as blur-to-select).
      setSelectedNodeIds([id]);
      setSelectedNodeId(id);
    }
  }, [ editingTextId]);

  // Text edit: canvas ink is skipped via hiddenNodeId (listSceneCanvasIdlePaintIds).
  // No ShapeHost opacity toggle — static text no longer mounts RcbShapeHost.

  /**
   * Size an incoming image against what is actually on screen, so the same file
   * lands at a usable size whether the user is zoomed way in or way out.
   */
  // Upload: place immediately at the visible viewport center (not world paper center).
  const autoPlaceSrcRef = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || !pendingImageSrc) {
      autoPlaceSrcRef.current = null;
      return;
    }
    if (autoPlaceSrcRef.current === pendingImageSrc) return;
    autoPlaceSrcRef.current = pendingImageSrc;

    const view =
      overlayRoot?.getBoundingClientRect() ||
      paperEl?.parentElement?.getBoundingClientRect() ||
      null;
    const center = view && (stageEl || paperEl)
      ? pointerToWorld(
          camera,
          { viewportEl, stageEl, paperEl, artboard },
          view.left + view.width / 2,
          view.top + view.height / 2
        )
      : { x: paperW / 2, y: paperH / 2 };
    placeImageAt(pendingImageSrc, center.x, center.y);
  }, [
    pendingImageSrc,
    paperW,
    paperH,
    paperEl,
    stageEl,
    viewportEl,
    camera,
    overlayRoot,
    artboard,
    placeImageAt,
    readOnly,
  ]);

  const onPencilCommit = useCallback(
    (
      pathD: string,
      box: { left: number; top: number; width: number; height: number },
      meta?: {
        pathPressure?: string;
        brushCategory?: string;
        frameId?: string | null;
      }
    ) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return;
      const origin = sceneToDocumentCoords(doc, box.left, box.top);
      const { id, node } = createShapeNode({
        x: origin.x,
        y: origin.y,
        width: box.width,
        height: box.height,
        shapeType: 'pencil',
        fill: 'transparent',
        stroke: penStrokeColor,
        borderWidth: penStrokeWidth,
        path: pathD,
        closed: false,
        brushStyle: pencilBrushId || DEFAULT_PENCIL_BRUSH_ID,
        opacity: penStrokeOpacity / 100,
      });
      if (meta?.pathPressure) {
        (node.attrs as Record<string, unknown>).pathPressure = meta.pathPressure;
      }
      if (meta?.brushCategory) {
        (node.attrs as Record<string, unknown>).brushCategory = meta.brushCategory;
      }
      (node.attrs as Record<string, unknown>).pressureEnabled = pencilPressureEnabled;
      const inkBrush = findPencilBrush(pencilBrushId || DEFAULT_PENCIL_BRUSH_ID);
      (node.attrs as Record<string, unknown>).pencilFill = inkBrush.fillEnabled !== false;
      (node.attrs as Record<string, unknown>).pencilOutlineWidth =
        Number(inkBrush.outlineStrokeWidth) || 0;
      (node.attrs as Record<string, unknown>).pencilOutlineColor =
        inkBrush.outlineStrokeColor || penStrokeColor;
      const next = bindCreatedNodeToFrame(
        addNodeToDocument(doc, id, node),
        id,
        { left: origin.x, top: origin.y, width: box.width, height: box.height },
        meta?.frameId
      );
      documentRef.current = next;
      pushEditorHistory();
      setDocumentFromCanvas(next);
      // Stay in pencil mode for continuous strokes; do not auto-select.
      setSelectedNodeIds([]);
      setSelectedNodeId(null);
      return id;
    },
    [ readOnly, penStrokeColor, penStrokeWidth, pencilBrushId, penStrokeOpacity, pencilPressureEnabled]
  );

  const onBucketFill = useCallback(
    (nodeId: string) => {
      if (readOnly || !nodeId) return;
      const fill = bucketFillRef.current;
      const fillType = String(fill.fillType || 'solid');
      const attrs: Record<string, unknown> = {
        'fill-color': String(fill.fillColor || '#333333'),
        'fill-type': fillType,
        'fill-opacity': Math.max(0, Math.min(100, Number(fill.fillOpacity) || 100)),
        'fill-enabled': 'true',
        'fill-visible': 'true',
      };
      if (fillType !== 'solid' && fillType !== 'image' && fill.fillGradient) {
        attrs['fill-gradient'] = String(fill.fillGradient);
      } else {
        attrs['fill-gradient'] = undefined;
      }
      if (fillType === 'image') {
        Object.assign(
          attrs,
          serializeFillImageAttrs({
            fillImageSrc: fill.fillImageSrc,
            fillImageFit: fill.fillImageFit,
            fillImageRotate: fill.fillImageRotate,
            fillImageScale: fill.fillImageScale,
            fillImageOffsetX: fill.fillImageOffsetX,
            fillImageOffsetY: fill.fillImageOffsetY,
            ...(fill.fillImageAdjust != null
              ? { fillImageAdjust: parseFillImageAdjust(fill.fillImageAdjust) }
              : {}),
          })
        );
      }
      patchDocumentNode({
          nodeId,
          patch: { attrs },
        });
    },
    [ readOnly]
  );

  const onPenCommit = useCallback(
    (
      pathD: string,
      box: { left: number; top: number; width: number; height: number },
      closed: boolean,
      opts?: { replaceNodeId?: string; frameId?: string | null }
    ) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return;
      const origin = sceneToDocumentCoords(doc, box.left, box.top);
      const replaceId = opts?.replaceNodeId;
      if (replaceId && doc.deltaSetLike?.[replaceId]) {
        const prev = doc.deltaSetLike[replaceId];
        const prevType = String(prev?.attrs?.shapeType || 'pen');
        const shapeType = prevType === 'path' ? 'path' : 'pen';
        pushEditorHistory();
        patchDocumentNode({
            nodeId: replaceId,
            patch: {
              x: origin.x,
              y: origin.y,
              width: Math.max(1, box.width),
              height: Math.max(1, box.height),
              attrs: {
                shapeType,
                path: pathD,
                closed: closed ? 'true' : 'false',
                'border-color': penStrokeColor,
                'border-width': penStrokeWidth,
                'fill-color': penFillColor,
                ...(closed ? closedPenFillAttrs(penFillColor) : {}),
              },
            },
          });
        setSelectedNodeIds([replaceId]);
        return;
      }
      const { id, node } = createShapeNode({
        x: origin.x,
        y: origin.y,
        width: box.width,
        height: box.height,
        shapeType: 'pen',
        fill: penFillColor,
        stroke: penStrokeColor,
        borderWidth: penStrokeWidth,
        path: pathD,
        closed,
      });
      if (closed) {
        Object.assign(node.attrs, closedPenFillAttrs(penFillColor));
      }
      const next = bindCreatedNodeToFrame(
        addNodeToDocument(doc, id, node),
        id,
        { left: origin.x, top: origin.y, width: box.width, height: box.height },
        opts?.frameId
      );
      documentRef.current = next;
      pushEditorHistory();
      setDocumentFromCanvas(next);
      // Close / Enter finish — keep pen tool so the next click starts a new path.
      setSelectedNodeIds([id]);
    },
    [ readOnly, penStrokeColor, penFillColor, penStrokeWidth]
  );

  const onPenPathEditCommit = useCallback(
    (payload: {
      nodeId: string;
      pathD: string;
      box: { left: number; top: number; width: number; height: number };
      closed: boolean;
      clearAngle?: boolean;
      clearFlip?: boolean;
    }) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return;
      const origin = sceneToDocumentCoords(doc, payload.box.left, payload.box.top);
      const prev = doc.deltaSetLike?.[payload.nodeId];
      const prevType = String(prev?.attrs?.shapeType || 'path');
      const shapeType = prevType === 'pen' ? 'pen' : 'path';
      pushEditorHistory();
      patchDocumentNode({
          nodeId: payload.nodeId,
          patch: {
            x: origin.x,
            y: origin.y,
            width: Math.max(1, payload.box.width),
            height: Math.max(1, payload.box.height),
            attrs: {
              shapeType,
              path: payload.pathD,
              closed: payload.closed ? 'true' : 'false',
              ...(payload.closed && pathNodeHasSolidFill(prev?.attrs)
                ? {
                    'fill-enabled': 'true',
                    'fill-visible': 'true',
                  }
                : {}),
              // Baked world path — leaving angle/flip would double-transform the silhouette.
              ...(payload.clearAngle ? { angle: 0 } : {}),
              ...(payload.clearFlip ? { flipX: 'false', flipY: 'false' } : {}),
            },
          },
        });
    },
    [ readOnly]
  );

  const onPathEditUnionNewShape = useCallback(
    (
      editingId: string,
      addition: {
        pathD: string;
        box: { left: number; top: number; width: number; height: number };
        closed: boolean;
      },
      strokeWidth: number
    ) => {
      const doc = documentRef.current;
      if (!doc || readOnly || !editingId) return;
      const baseNode = doc.deltaSetLike?.[editingId];
      if (!baseNode) return;

      const ink = String(
        baseNode.attrs?.['border-color'] || penStrokeColor || '#333333'
      );
      const sw = Math.max(1, Number(strokeWidth) || penStrokeWidth || 2);
      const baseType = String(baseNode.attrs?.shapeType || 'path');
      const basePath = String(baseNode.attrs?.path || '').trim();
      const baseClosed =
        baseNode.attrs?.closed === true ||
        baseNode.attrs?.closed === 'true' ||
        /\sZ\s*$/i.test(basePath);
      // Open stroke pens must stay stroked siblings — boolean-union turns them into
      // fill-only silhouettes (stroke-enabled=false) and they disappear if fill is clear.
      const baseIsOpenStroke =
        baseType === 'pen' || baseType === 'pencil' || !baseClosed;

      if (!addition.closed || baseIsOpenStroke) {
        const origin = sceneToDocumentCoords(doc, addition.box.left, addition.box.top);
        const { id, node } = createShapeNode({
          x: origin.x,
          y: origin.y,
          width: Math.max(1, addition.box.width),
          height: Math.max(1, addition.box.height),
          shapeType: 'pen',
          fill: 'transparent',
          stroke: ink,
          borderWidth: sw,
          path: addition.pathD,
          closed: addition.closed,
        });
        const next = addNodeToDocument(doc, id, node);
        documentRef.current = next;
        pushEditorHistory();
        setDocument(next);
        setSelectedNodeIds([id]);
        setSelectedNodeId(id);
        return;
      }

      const { left: bx, top: by } = nodeLeftTop(doc, baseNode);
      if (!basePath) return;

      const baseBox: ShapeBox = {
        left: bx,
        top: by,
        width: Math.max(1, Number(baseNode.width) || 1),
        height: Math.max(1, Number(baseNode.height) || 1),
        shapeType: 'path',
        path: basePath,
        angle: Number(baseNode.attrs?.angle) || 0,
      };

      const addBox: ShapeBox = {
        left: addition.box.left,
        top: addition.box.top,
        width: addition.box.width,
        height: addition.box.height,
        shapeType: 'path',
        path: addition.pathD,
        angle: 0,
      };

      const { result } = computeShapeBoolean([baseBox, addBox], 'union');
      if (!result?.path) return;

      const fillKeep = String(baseNode.attrs?.['fill-color'] || ink);
      const origin = sceneToDocumentCoords(doc, result.x, result.y);
      pushEditorHistory();
      patchDocumentNode({
          nodeId: editingId,
          patch: {
            x: origin.x,
            y: origin.y,
            width: Math.max(1, result.width),
            height: Math.max(1, result.height),
            attrs: {
              shapeType: 'path',
              path: result.path,
              closed: 'true',
              outlined: 'true',
              // Boolean result is world-baked — drop host angle or the silhouette spins.
              angle: 0,
              'fill-rule': result.fillRule,
              'fill-enabled': 'true',
              'fill-visible': 'true',
              'fill-color': fillKeep === 'transparent' ? ink : fillKeep,
              'fill-type': 'solid',
              'stroke-enabled': 'false',
              'border-width': 0,
            },
          },
        });
      setSelectedNodeIds([editingId]);
      setSelectedNodeId(editingId);
    },
    [ readOnly, penStrokeColor, penStrokeWidth]
  );

  const reorderLayer = useCallback(
    (action: 'front' | 'back' | 'forward' | 'backward', ids: string[]) => {
      const doc = documentRef.current;
      if (!doc || !ids.length) return;
      const next = reorderNodesInDocument(doc, ids, action);
      // Reorder only changes z-order — do not bump sceneReloadToken (full remount).
      // Hosts keep their SVG; CSS z-index + DOM order update instead.
      documentRef.current = next;
      pushEditorHistory();
      setDocumentFromCanvas(next);
    },
    []
  );

  const deleteSelected = useCallback(
    (ids: string[]) => {
      if (!ids.length || !documentRef.current) return;
      // Abort in-flight placeholder uploads so finishImageProcess cannot resurrect them.
      ids.forEach((id) => abortNodeUpload(id));
      removeDocumentNodes({ nodeIds: ids });
      // Persist ASAP — refresh must not restore deleted nodes from a stale cloud doc.
      requestProjectFlush();
    },
    []
  );

  /**
   * Delete selected nodes and/or artboards in one history step so Undo restores
   * frame + content together (Ctrl+A → Delete must not split into two undos).
   * Upload placeholders are scrubbed from history (not restorable via Undo).
   */
  const deleteCanvasSelection = useCallback(
    (opts?: { nodeIds?: string[]; frameIds?: string[]; skipLoading?: boolean }) => {
      const doc0 = documentRef.current;
      if (!doc0) return false;
      const nodeIds = opts?.nodeIds ? [...opts.nodeIds] : [...selectedIdsRef.current];
      let frameIds = opts?.frameIds ? [...opts.frameIds] : [...selectedFrameIdsRef.current];
      if (!frameIds.length && !nodeIds.length && activeFrameIdRef.current) {
        frameIds = [activeFrameIdRef.current];
      }
      if (!nodeIds.length && !frameIds.length) return false;

      // A clipped node can have its center outside the frame. Deletion must
      // use visible overlap so all content belonging to the artboard is removed.
      const bound = frameIds.length ? nodeIdsBoundToFrames(doc0, frameIds) : [];
      const allNodes = [...new Set([...nodeIds, ...bound])];
      const count = canvasBulkItemCount(allNodes.length, frameIds.length);
      const apply = () => {
        allNodes.forEach((id) => abortNodeUpload(id));
        removeDocumentNodes({ nodeIds: allNodes, frameIds });
        requestProjectFlush();
        return true;
      };
      if (opts?.skipLoading) return apply();
      runCanvasBulkOp({
        count,
        label: t('editor.bulkOp.deleting', { defaultValue: '正在删除…' }),
        run: () => {
          apply();
        },
      });
      return true;
    },
    [t]
  );


  useCanvasContextMenu({
    readOnly,
    viewportEl,
    stageEl,
    paperEl,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    hitTest,
    setCtxMenu,
  });

  useChatImageDrop({
    readOnly,
    camera,
    artboard,
    viewportEl,
    stageEl,
    paperEl,
    documentRef,
    imageSizeForViewport,
    finishToSelect,
  });

  const clipboardApiRef = useRef<CanvasClipboardApi | null>(null);

  const runCtxAction = (action: CtxAction) => {
    runCanvasCtxAction(action, {
      getCtxMenu: () => ctxMenu,
      clearCtxMenu: () => setCtxMenu(null),
      selectedIdsRef,
      selectedFrameIdsRef,
      activeFrameIdRef,
      documentRef,
      imagePlaceAtRef,
      imageInputRef,
      clipboardApiRef,
      readOnly: Boolean(readOnly),
      camera,
      stageEl: stageEl ?? null,
      t,
      onAddToChat: emitAddToChat,
      collabUndo,
      collabRedo,
      deleteCanvasSelection,
      reorderLayer,
    });
  };

  const runCtxActionRef = useRef(runCtxAction);
  runCtxActionRef.current = runCtxAction;

  /** Document x/y so a box of given size is centered on anchor or viewport. */
  const placeOriginForSize = useCallback(
    (
      size: { width: number; height: number },
      anchor?: { x: number; y: number } | null
    ): { x: number; y: number } | null => {
      const doc = documentRef.current;
      if (!doc) return null;
      if (anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
        const placed = rcbCenterOnPoint({ x: anchor.x, y: anchor.y }, size);
        const origin = sceneToDocumentCoords(doc, placed.left, placed.top);
        const grid = getDocumentGridSize(doc);
        return {
          x: snapCoordToGrid(origin.x, grid),
          y: snapCoordToGrid(origin.y, grid),
        };
      }
      const view =
        overlayRoot?.getBoundingClientRect() ||
        paperEl?.parentElement?.getBoundingClientRect() ||
        null;
      if (view && (stageEl || paperEl)) {
        const center = pointerToWorld(
          camera,
          { viewportEl, stageEl, paperEl, artboard },
          view.left + view.width / 2,
          view.top + view.height / 2
        );
        const placed = rcbCenterOnPoint(center, size);
        const origin = sceneToDocumentCoords(doc, placed.left, placed.top);
        const grid = getDocumentGridSize(doc);
        return {
          x: snapCoordToGrid(origin.x, grid),
          y: snapCoordToGrid(origin.y, grid),
        };
      }
      return { x: 40, y: 40 };
    },
    [artboard, camera, overlayRoot, paperEl, stageEl, viewportEl]
  );

  const getPasteAnchor = useCallback(() => {
    const point = lastPointerClientRef.current;
    if (!point.x && !point.y) return null;
    return pointerToWorld(
      camera,
      { viewportEl, stageEl, paperEl, artboard },
      point.x,
      point.y
    );
  }, [artboard, camera, paperEl, stageEl, viewportEl]);

  const onImageFile = async (file: File | null) => {
    if (!file) return;
    const at = imagePlaceAtRef.current;
    imagePlaceAtRef.current = null;
    let spawnedId = '';
    try {
      const preview = createFilePreviewUrl(file);
      const natural = await measureImageNaturalSize(preview);
      const { width, height } = imageSizeForViewport(natural);
      const origin = placeOriginForSize({ width, height }, at);
      startImageUploadPlaceholder({
          src: preview,
          width,
          height,
          x: origin?.x,
          y: origin?.y,
          label: '上传中',
          name: file.name?.replace(/\.[^.]+$/, '') || 'Image',
        });
      finishToSelect();
      spawnedId = String(store.getState().editor?.pendingImageProcessId || '');
      await uploadCanvasPlaceholderFile({ nodeId: spawnedId, file });
    } catch (err: unknown) {
      if (isUploadAbortError(err)) return;
      revokeNodePreviewSrc(store.getState().editor?.document, spawnedId || undefined);
      failImageProcess({ nodeId: spawnedId || undefined });
      message.error(formatUploadErrorMessage(err, t, '图片上传失败'));
    }
  };

  const onVideoFile = async (file: File | null) => {
    if (!file) return;
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    const at = imagePlaceAtRef.current;
    imagePlaceAtRef.current = null;
    try {
      const prepared = await prepareVideoUploadPreview(file);
      const { width, height } = imageSizeForViewport({
        width: prepared.width,
        height: prepared.height,
      });
      const origin = placeOriginForSize({ width, height }, at);
      startVideoUploadPlaceholder({
          src: prepared.preview,
          poster: prepared.poster,
          width,
          height,
          x: origin?.x,
          y: origin?.y,
          label: '上传中',
          name: prepared.name,
          duration: prepared.duration,
        });
      finishToSelect();
      const spawnedId = String(store.getState().editor?.pendingImageProcessId || '');
      await uploadCanvasPlaceholderFile({ nodeId: spawnedId,
        file,
        waitDecode: false,
        extraAttrs: {
          ...(prepared.poster ? { poster: prepared.poster } : {}),
          ...(Number.isFinite(prepared.duration) && prepared.duration > 0
            ? { duration: prepared.duration }
            : {}),
          assetKind: 'video',
        },
      });
    } catch (err: unknown) {
      if (isUploadAbortError(err)) return;
      const failedId = String(store.getState().editor?.pendingImageProcessId || '');
      revokeNodePreviewSrc(store.getState().editor?.document, failedId || undefined);
      failImageProcess({ nodeId: failedId || undefined });
      message.error(formatUploadErrorMessage(err, t, '视频上传失败'));
    }
  };

  const onAudioFile = async (file: File | null) => {
    if (!file) return;
    if (warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)) return;
    const at = imagePlaceAtRef.current;
    imagePlaceAtRef.current = null;
    try {
      const preview = createFilePreviewUrl(file);
      const duration = (await probeAudioDuration(preview)) || undefined;
      const { width, height } = fitMediaIntoViewport(
        'audio',
        { ...MEDIA_PLACE_DEFAULT },
        imageSizeForViewport
      );
      const origin = placeOriginForSize({ width, height }, at);
      startAudioUploadPlaceholder({
          src: preview,
          width,
          height,
          x: origin?.x,
          y: origin?.y,
          label: '上传中',
          name:
            file.name?.replace(/\.[^.]+$/, '') ||
            t('editor.tools.audio', { defaultValue: 'Audio' }),
          duration,
        });
      finishToSelect();
      const spawnedId = String(store.getState().editor?.pendingImageProcessId || '');
      await uploadCanvasPlaceholderFile({ nodeId: spawnedId,
        file,
        waitDecode: false,
        extraAttrs: {
          ...(duration ? { duration } : {}),
          assetKind: 'audio',
        },
      });
    } catch (err: unknown) {
      if (isUploadAbortError(err)) return;
      const failedId = String(store.getState().editor?.pendingImageProcessId || '');
      revokeNodePreviewSrc(store.getState().editor?.document, failedId || undefined);
      failImageProcess({ nodeId: failedId || undefined });
      message.error(formatUploadErrorMessage(err, t, '音频上传失败'));
    }
  };

  const onLottiePaste = async (payload: {
    animationData: Record<string, unknown>;
    name?: string;
    anchor?: { x: number; y: number } | null;
  }) => {
    const data = parseLottieAnimationData(payload.animationData);
    if (!data) {
      message.error(t('editor.tools.lottieGenInvalidJson'));
      return;
    }
    const doc = documentRef.current;
    const anchor = payload.anchor ?? null;
    const timelineHostId = String(
      (store.getState() as any)?.editor?.lottieTimelinePanel?.nodeId || ''
    ).trim();
    const timelineHost = timelineHostId ? doc?.deltaSetLike?.[timelineHostId] : null;
    const timelineOnWorkbench = Boolean(resolveAnimationFrameId(doc, timelineHost));
    // Replace JSON only when editing an existing free preview plate (not workbench).
    if (timelineHostId && timelineHost?.key === 'lottie' && !timelineOnWorkbench) {
      const json = serializeLottieAnimationData(data);
      if (!json) {
        message.error(t('editor.tools.lottieGenInvalidJson'));
        return;
      }
      patchDocumentNode({
          nodeId: timelineHostId,
          patch: {
            attrs: {
              animationData: json,
              ...(payload.name ? { name: payload.name } : {}),
            },
          },
        });
      finishToSelect();
      return;
    }
    const natW = Math.max(1, Math.round(Number(data.w) || 200));
    const natH = Math.max(1, Math.round(Number(data.h) || 200));
    const { width, height } = imageSizeForViewport({ width: natW, height: natH });
    const origin = placeOriginForSize({ width, height }, anchor);
    // Always independent preview plate — open 「关键帧」 to promote into a workbench.
    spawnLottie({
        width,
        height,
        x: origin?.x,
        y: origin?.y,
        name: payload.name || 'Lottie',
        animationData: data,
      });
    finishToSelect();
  };

  const onLottieFile = async (file: File | null) => {
    if (!file) return;
    const at = imagePlaceAtRef.current;
    imagePlaceAtRef.current = null;
    try {
      const text = await file.text();
      const animationData = parseLottieAnimationData(text);
      if (!animationData) throw new Error('invalid lottie');
      await onLottiePaste({
        animationData,
        name: file.name?.replace(/\.(json|lot)$/i, '') || undefined,
        anchor: at,
      });
    } catch {
      message.error(t('editor.tools.lottieGenInvalidJson'));
    }
  };

  const onMediaFile = (file: File | null) => {
    if (!file) return;
    const mime = (file.type || '').toLowerCase();
    const name = file.name || '';
    if (mime.startsWith('video/')) {
      onVideoFile(file);
      return;
    }
    if (mime.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(name)) {
      onAudioFile(file);
      return;
    }
    if (mime === 'application/json' || mime === 'text/json' || /\.(json|lot)$/i.test(name)) {
      void onLottieFile(file);
      return;
    }
    if (/\.lottie$/i.test(name)) {
      message.error(
        t('editor.tools.lottieGenNeedJson', {
          defaultValue: '请上传 Bodymovin JSON（.json / .lot），暂不支持 .lottie 压缩包',
        })
      );
      return;
    }
    onImageFile(file);
  };


  const clipboardApi = useCanvasClipboard({
    readOnly,
    artboardWidth: artboard?.width,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    clipboardRef,
    internalClipboardAtRef,
    osClipboardMetaRef,
    imagePlaceAtRef,
    deleteCanvasSelection,
    placeOriginForSize,
    finishToSelect,
    getZoom: () => cameraZoomRef.current,
    onImageFile,
    onVideoFile,
    onAudioFile,
    onLottiePaste,
    getPasteAnchor,
  });
  clipboardApiRef.current = clipboardApi;

  useCanvasHotkeys({
    readOnly,
    activeTool,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    canvasAttachPickRef,
    imagePlaceAtRef,
    imageInputRef,
    runCtxActionRef,
    onZoomIn,
    onZoomOut,
    onSelectMixed,
    listNodeIds,
    deleteCanvasSelection,
    reorderLayer,
    copySelected: clipboardApi.copySelected,
    cutSelected: clipboardApi.cutSelected,
    duplicateSelected: clipboardApi.duplicateSelected,
    onAddToChat: emitAddToChat,
  });

  const bgType = parseFillType(document?.backgroundFillType);
  const bgOpacity = Number(document?.backgroundOpacity ?? 100);
  const bgColor = String(document?.backgroundColor || '#ffffff');
  let paperBackground = cssSolidWithOpacity(bgColor, bgOpacity);
  if (bgType === 'image') {
    const src = String(document?.backgroundImageSrc || '');
    if (src) paperBackground = `url(${src}) center / cover no-repeat`;
  } else if (bgType !== 'solid') {
    paperBackground = cssPreviewForGradient(
      {
        ...parseFillGradient(
          document?.backgroundGradient,
          bgType,
          String(document?.backgroundColor || '#3B82F6')
        ),
        type: bgType,
      },
      bgOpacity
    );
  }

  const ids = useMemo(() => {
    if (selectedNodeIds?.length > 0) return selectedNodeIds;
    if (selectedNodeId) return [selectedNodeId];
    return EMPTY_NODE_IDS;
  }, [selectedNodeIds, selectedNodeId]);

  const ctxMenuBusy = useMemo(
    () =>
      ctxMenuTargetHasProcessing({
        document,
        ids,
        selectedFrameIds,
        ctxNodeId: ctxMenu?.nodeId,
        ctxFrameId: ctxMenu?.frameId,
        activeFrameId,
      }),
    [document, ids, selectedFrameIds, ctxMenu?.nodeId, ctxMenu?.frameId, activeFrameId]
  );

  const ctxMenuCapabilities = useMemo(
    () =>
      buildCanvasContextMenuProps({
        document,
        readOnly,
        ids,
        selectedFrameIds,
        ctxMenu,
        activeFrameId,
      }),
    [document, readOnly, ids, selectedFrameIds, ctxMenu, activeFrameId]
  );

  const handleCloseCtxMenu = useCallback(() => setCtxMenu(null), [setCtxMenu]);

  const processingNodeIds = useMemo(
    () => listProcessingNodeIds(document),
    [document]
  );

  const keepVisibleIds = useMemo(() => {
    const out = [...ids, ...processingNodeIds];
    if (editingTextId) out.push(editingTextId);
    if (editingPenId) out.push(editingPenId);
    // Keep single-selected frame children mounted/cull-safe with the plate.
    // Reveal/unclip is separate — selecting the frame must not show overflow.
    if (document && selectedFrameIds.length === 1 && ids.length === 0) {
      const frameId = String(selectedFrameIds[0] || '');
      const pageKids = document.pages?.[0]?.children;
      let kids: unknown[] = [];
      if (Array.isArray(pageKids)) kids = pageKids;
      else if (Array.isArray(document.deltaSetLike?.ROOT?.children)) {
        kids = document.deltaSetLike.ROOT.children;
      }
      for (const raw of kids) {
        const id = String(raw || '');
        if (!id) continue;
        if (String(document.deltaSetLike?.[id]?.attrs?.frameId || '').trim() === frameId) {
          out.push(id);
        }
      }
    }
    return out;
  }, [ids, editingTextId, editingPenId, processingNodeIds, document, selectedFrameIds]);

  /** Unclip selected shapes only — keep clip when their owning plate is also selected. */
  const revealOverflowIds = useMemo(
    () =>
      listSelectionRevealOverflowIds({
        selectedNodeIds: ids,
        selectedFrameIds,
        document,
        processingNodeIds,
        editingTextId,
        editingPenId,
      }),
    [ids, selectedFrameIds, document, processingNodeIds, editingTextId, editingPenId]
  );

  const paintRaiseIds = useMemo(
    () => listSingleSelectionPaintRaiseNodeIds(document, ids, selectedFrameIds),
    [document, ids, selectedFrameIds]
  );

  /** Single-selected artboard — temporary front over world SoA ink (plate under ink CSS). */
  const paintRaiseFrameIds = useMemo(() => {
    if (selectedFrameIds.length !== 1 || ids.length > 0) return [] as string[];
    return [String(selectedFrameIds[0] || '')].filter(Boolean);
  }, [ids.length, selectedFrameIds]);

  /** DOM hosts: SoftGlow process + pen path-edit + active video/audio FO (≤1 each).
   * Text edit → TextInlineEditor overlay. Idle image/video/audio → canvas ink / plate. */
  const forceFullIds = useMemo(() => {
    const out = [...processingNodeIds];
    if (editingPenId) out.push(editingPenId);
    const decoderId = resolveActiveVideoDecoderId({
      document,
      selectedNodeIds: ids,
      videoToolPanel,
    });
    if (decoderId) out.push(decoderId);
    const audioPlayerId = resolveActiveAudioPlayerId({
      document,
      selectedNodeIds: ids,
      audioToolPanel,
    });
    if (audioPlayerId) out.push(audioPlayerId);
    return out;
  }, [editingPenId, processingNodeIds, ids, document, videoToolPanel, audioToolPanel]);

  // Path-edit stays open on empty selection (blank click must not dismiss).
  // Only leave when the user selects a *different* node.
  useEffect(() => {
    if (!editingPenId) return;
    if (!ids.length) return;
    if (!ids.includes(editingPenId)) setEditingPenId(null);
  }, [editingPenId, ids]);

  // Outline / toolbar: enter path-edit chrome for a node.
  useEffect(() => {
    const onEnter = (e: Event) => {
      const nodeId = String((e as CustomEvent).detail?.nodeId || '');
      if (!nodeId || readOnly) return;
      setEditingTextId(null);
      setEditingPenId(nodeId);
      setSelectedNodeIds([nodeId]);
      setActiveTool('select');
      // Outline / enter path-edit: default to Select (edit anchors), not Pen (draw).
      setPathEditSubtool('select');
      window.dispatchEvent(
        new CustomEvent('resume:path-edit-subtool', { detail: { subtool: 'select' } })
      );
    };
    window.addEventListener('resume:enter-path-edit', onEnter);
    return () => window.removeEventListener('resume:enter-path-edit', onEnter);
  }, [ readOnly]);

  useEffect(() => {
    const onSub = (e: Event) => {
      const s = (e as CustomEvent).detail?.subtool;
      if (s === 'pen') setPathEditSubtool('pen');
      else if (s === 'add-anchor') setPathEditSubtool('add-anchor');
      else if (s === 'curve') setPathEditSubtool('curve');
      else setPathEditSubtool('select');
    };
    window.addEventListener('resume:path-edit-subtool', onSub);
    return () => window.removeEventListener('resume:path-edit-subtool', onSub);
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('resume:path-edit', { detail: { active: Boolean(editingPenId) } })
    );
    return () => {
      if (editingPenId) {
        window.dispatchEvent(new CustomEvent('resume:path-edit', { detail: { active: false } }));
      }
    };
  }, [editingPenId]);

  // Path-edit ink is painted on the overlay canvas; host is forceHidden via
  // RcbShapesLayer (same gate as inline text edit) so the committed SVG does
  // not ghost under the live path.

  // Select / inspect: share preview is readOnly — always allow hit-test + chrome
  // (workspaceMode may briefly lag behind 'dev'). Path-edit owns the pointer
  // (anchors / draft pen) — do not let SelectionFeature clear selection on empty
  // click (that unmounts path-edit and looks like “auto exit”).
  const selectToolActive = activeTool === 'select' || activeTool === 'scale';
  const selectMode = selectToolActive && !editingPenId;
  const shapeMode = !readOnly && activeTool === 'shape';
  const textMode = !readOnly && activeTool === 'text';
  const imageMode = !readOnly && activeTool === 'image';
  const pencilMode = !readOnly && activeTool === 'pencil';
  const penMode = !readOnly && activeTool === 'pen';

  return (
    <div className={embedded ? 'contents' : 'relative rcb-canvas-stage'}>
      <SvgPaper
        paperRef={paperRef}
        hostRef={hostRef}
        width={paperW}
        height={paperH}
        infinite={infinite}
        background={embedded ? 'transparent' : paperBackground}
        className={
          embedded
            ? 'rcb-shapes relative overflow-visible'
            : 'rcb-canvas-paper relative shadow-[0_8px_40px_rgba(15,23,42,0.12)] ring-1 ring-black/5'
        }
      >
        {infinite ? (
          <AnimationPlayheadSceneSync document={document} />
        ) : null}
        {infinite ? (
          <RcbShapesLayer
            document={document}
            reloadToken={reloadToken}
            documentPatchToken={documentPatchToken}
            lastPatchedNodeIds={lastPatchedNodeIds}
            lastPatchTransformOnly={lastPatchTransformOnly}
            hiddenNodeId={editingTextId || editingPenId}
            keepVisibleIds={keepVisibleIds}
            revealOverflowIds={revealOverflowIds}
            paintRaiseIds={paintRaiseIds}
            paintRaiseFrameIds={paintRaiseFrameIds}
            forceFullIds={forceFullIds}
            spatialIndex={nodeSpatialIndex}
          />
        ) : null}
        {/* HTML <video>/Lottie live in SVG foreignObject — keep visible during
            transform (same as audio). FO rides previewSvgNodeGeometry with the
            node; hiding globally made unrelated image drags blank every video. */}
        {infinite ? (
          <VideoNodeOverlay
            document={document}
            geometryOverrides={videoLiveGeom}
          />
        ) : null}
        {infinite ? (
          <AnimationNodeOverlay
            document={document}
            geometryOverrides={videoLiveGeom as Record<string, LottieGeomOverride> | null}
          />
        ) : null}
        {infinite ? (
          <AudioNodeOverlay
            document={document}
            // Keep HTML waveform during drag — SVG underlay is plate-only (no poster).
            geometryOverrides={videoLiveGeom as Record<string, AudioGeomOverride> | null}
          />
        ) : null}
        {infinite ? (
          <TextFrameOverlay
            document={document}
            hiddenNodeId={editingTextId}
            selectedNodeIds={ids}
          />
        ) : null}
        {/* Process SoftGlow is owned by RcbShapeHost (node attrs.processStatus). */}
        {/* Scene-space HTML overlays (selection / draw previews). Origin matches SVG. */}
        {/* Above frame/node stackOrder so preview select/hover strokes aren't covered. */}
        {/* Above HostPathChrome (z=1e6) so poly/star/radius knobs receive hits
            over resize hotzones; wrapper is 0×0 + overflow visible, empty areas
            still pass through to chrome / shapes. */}
        <div className="absolute left-0 top-0 z-[1000001] h-0 w-0 overflow-visible">
          <SelectionFeature
            enabled={selectMode && !applyLocked}
            readOnly={readOnly}
            attachPickActive={Boolean(canvasAttachPick)}
            imageToolSessionNodeId={imageToolSessionNodeId}
            document={document}
            selectedNodeIds={ids}
            selectedFrameIds={selectedFrameIds}
            paperEl={paperEl}
            stageEl={stageEl}
            artboard={artboard}
            onSelect={onSelect}
            onGeometryCommit={onGeometryCommit}
            onGeometryPreview={onGeometryPreview}
            onAngleCommit={onAngleCommit}
            onAnglePreview={onAnglePreview}
            hitTest={hitTest}
            hitTestFrame={hitTestFrame}
            onSelectFrame={onSelectFrame}
            onSelectFrames={onSelectFrames}
            onSelectMixed={onSelectMixed}
            getNodeBox={getNodeBox}
            listNodeIds={listNodeIds}
            queryNodeIdsInRect={queryNodeIdsInRect}
            onOpenAgent={onOpenAgent}
            onEditText={(id) => {
              setEditingPenId(null);
              setEditingTextId(id);
            }}
            onEditPenPath={(id) => {
              setEditingTextId(null);
              setEditingPenId(id);
              setPathEditSubtool('select');
              window.dispatchEvent(
                new CustomEvent('resume:path-edit-subtool', { detail: { subtool: 'select' } })
              );
            }}
            suppressChrome={
              Boolean(editingTextId) ||
              Boolean(editingPenId) ||
              cropExpandOpen ||
              imageToolSidePanelOpen ||
              videoToolOpen ||
              audioToolOpen ||
              suppressChromeWhileFrameMoving ||
              // Keep chrome while editing radius so the outline can follow rounded corners.
              (shapeStylePanelOpen && shapeStylePanel?.kind !== 'radius')
            }
            onTransformingChange={onGeometryTransformingChange}
            onFrameMoveStart={onFrameMoveStart}
            onFrameMoveEnd={onFrameMoveEnd}
            onFrameMove={onFrameMove}
          />
          <ShapeDrawFeature
            enabled={shapeMode}
            shapeKind={shapeKind || 'rect'}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            onCreate={onCreateShape}
            hitTestFrame={hitTestFrame}
            // Draw always snaps to the document grid; overlay visibility is separate.
            gridSnap
            gridSize={getDocumentGridSize(document)}
          />
          <TextPlaceFeature
            enabled={textMode}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            onPlace={onPlaceText}
          />
          <ImagePlaceFeature
            enabled={imageMode}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            pendingSrc={pendingImageSrc}
            onPlace={placeImageAt}
          />
          <PencilDrawFeature
            enabled={pencilMode}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            strokeColor={penStrokeColor}
            strokeWidth={penStrokeWidth}
            strokeOpacity={penStrokeOpacity / 100}
            brushId={pencilBrushId}
            pressureEnabled={pencilPressureEnabled}
            onCommit={onPencilCommit}
            hitTestFrame={hitTestFrame}
          />
          <BucketFillFeature
            enabled={!readOnly && activeTool === 'bucket'}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            fillColor={String(bucketFill.fillColor || '#333333')}
            hitTest={hitTest}
            onFill={onBucketFill}
          />
          <PenDrawFeature
            enabled={penMode && !editingPenId}
            artboard={artboard}
            paperEl={paperEl}
            stageEl={stageEl}
            strokeColor={penStrokeColor}
            strokeWidth={penStrokeWidth}
            gridSnap
            gridSize={getDocumentGridSize(document)}
            onCommit={onPenCommit}
            hitTestFrame={hitTestFrame}
            onCancel={finishToSelect}
            hitTest={hitTest}
            document={document}
            onEditExistingPath={(id) => {
              setEditingTextId(null);
              setEditingPenId(id);
              setPathEditSubtool('select');
              window.dispatchEvent(
                new CustomEvent('resume:path-edit-subtool', { detail: { subtool: 'select' } })
              );
              setActiveTool('select');
            }}
          />
          {editingPenId ? (
            <PenPathEditFeature
              enabled={!readOnly}
              nodeId={editingPenId}
              document={document}
              paperEl={paperEl}
              stageEl={stageEl}
              drawNewShapeMode={pathEditSubtool === 'pen'}
              insertAnchorMode={pathEditSubtool === 'add-anchor'}
              convertPointMode={pathEditSubtool === 'curve'}
              newStrokeColor={penStrokeColor}
              // Path-edit Pen adds geometry to the existing path; it is not
              // the freehand drawing tool and must not inherit its width.
              newStrokeWidth={2}
              gridSnap
              gridSize={getDocumentGridSize(document)}
              onCommitNewShape={({ pathD, box, closed }) => {
                if (!editingPenId) return;
                onPathEditUnionNewShape(editingPenId, { pathD, box, closed }, 2);
              }}
              onCommit={onPenPathEditCommit}
              onExit={() => setEditingPenId(null)}
            />
          ) : null}
        </div>
      </SvgPaper>

      {editingTextId ? (
        <TextInlineEditor
          document={document}
          nodeId={editingTextId}
          onCommit={onTextEditCommit}
          onLiveSize={onTextLiveSize}
          onCancel={onTextEditCancel}
        />
      ) : null}

      <input
        ref={imageInputRef}
        type="file"
        accept={getWorkbenchToolPolicy().fileAccept}
        className="hidden"
        onChange={(e) => {
          onMediaFile(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />

      <CanvasContextMenu
        menu={ctxMenu}
        hasNode={ctxMenuCapabilities.hasNode}
        canReplace={ctxMenuCapabilities.canReplace}
        canAddToChat={ctxMenuCapabilities.canAddToChat}
        canDelete={ctxMenuCapabilities.canDelete}
        canLayerActions={ctxMenuCapabilities.canLayerActions}
        canExport={ctxMenuCapabilities.canExport}
        canToggleHidden={ctxMenuCapabilities.canToggleHidden}
        canToggleLocked={ctxMenuCapabilities.canToggleLocked}
        canGroup={ctxMenuCapabilities.canGroup}
        canUngroup={ctxMenuCapabilities.canUngroup}
        targetHidden={ctxMenuCapabilities.targetHidden}
        targetLocked={ctxMenuCapabilities.targetLocked}
        exportKind={ctxMenuCapabilities.exportKind}
        canUndo={canUndo}
        canRedo={canRedo}
        canPaste
        canMutateSelection={!ctxMenuBusy}
        modLabel={modLabel}
        onAction={runCtxAction}
        onClose={handleCloseCtxMenu}
      />
    </div>
  );
}

export default memo(SvgCanvas);
