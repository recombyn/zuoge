import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useSelector } from '@/store';
import { useTranslation } from 'react-i18next';
import { isLottieTimelineUiActive } from '@/components/editor/nodes/AnimationNode/animationTimelineHotkeys';
import { useAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import { isAnimationWorkbenchSelection, resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { isAnimationWorkbenchPreviewChild } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { nodeLeftTop } from '@/components/rcb/scene/paint/sceneToSvg';
import ImageVariantsOverlay from '@/components/editor/nodes/ImageNode/ImageVariantsOverlay';
import { useImageVariantsExpandedNodeId } from '@/components/editor/nodes/ImageNode/imageVariantsExpand';
import {
  useRcbCamera,
  useRcbOverlayRoot,
  useRcbScreenToScene,
  useRcbViewportEl,
} from '@/components/rcb/camera/context';
import {
  rcbCameraCssZoom,
  rcbResolveViewportEl,
} from '@/components/rcb/core/math';
import { logSelectClick } from '@/components/editor/sceneEvents';
import {
  getDocumentGridSize,
  collectPairSpacingGuides,
  SMART_GUIDE_COLOR,
  type SceneBox,
  type SmartGuideLine,
} from './alignGuides';
import SelectionChrome, {
  clearSelectionChromeCursor,
  pickOverlayHandleAtClient,
  pickSelectionInkAtClient,
  syncOverlayHandleHoverAtClient,
  tryOverlayHandleDoubleClick,
  tryStartOverlayHandleSeat,
  type ChromeHandlePick,
} from './SelectionChrome';
import {
  applyPaintedChromeHover,
  isSelectionHoverUiTarget,
} from './selectionHoverChrome';
import SelectionContextToolbar from './chrome/SelectionContextToolbar';
import MultiSelectionToolbar from './chrome/MultiSelectionToolbar';
import NodeTitleLabel from './chrome/NodeTitleLabel';
import BrushOverlay from './chrome/BrushOverlay';
import SmartGuidesOverlay from './chrome/SmartGuidesOverlay';
import CornerRadiusHandlesOverlay from './chrome/CornerRadiusHandlesOverlay';
import PolygonShapeHandlesOverlay from './chrome/PolygonShapeHandlesOverlay';
import StarShapeHandlesOverlay from './chrome/StarShapeHandlesOverlay';
import CircleShapeHandlesOverlay from './chrome/CircleShapeHandlesOverlay';
import {
  rotateBoxesAround,
  scaleBoxesToOrientedUnion,
  resolveControlChrome,
  getSelectionSharedRotation,
  pointInOrientedBox,
  type ResizeHandle,
} from './resizeGeometry';
import { rememberNodePath2D, strokeEndpointsFromBox, subscribeLiveShapeParamsPreview } from '@/components/rcb/scene/document/sceneShapes';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { nodePaintZIndex } from '@/components/rcb/scene/document/sceneDocument';
import { expandSelectionWithGroups } from '@/components/rcb/scene/document/sceneGroups';
import {
  isAudioGeneratorNode,
  isImageGeneratorNode,
  isLottieGeneratorNode,
  isAnimationFrameHostNode,
  isVideoGeneratorNode,
  isNodeHidden,
  isNodeHiddenInDocument,
  isNodeLocked,
  isTextFrameNode,
  supportsCornerRadius,
  supportsShapeSides,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { parseNodeText } from '@/components/rcb/scene/document/sceneText';
import { listImageVariantUrls } from '@/components/rcb/scene/document/mediaLifecycle';
import { deflateSelectionBox, inflateSelectionBox, strokeOuterClearanceScene } from '@/components/rcb/scene/document/sceneEffects';
import { isEditablePathNode } from '@/components/rcb/scene/paint/outlineToPath';
import {
  patchDocumentNode,
  setDevHoverNodeId,
  type ImageToolPanelState,
} from '@/store/modules/editor';
import { dismissMarkToolSession } from '@/components/editor/nodes/ImageNode/mark/markSessionCleanup';
import type { TextResizeMode } from '@/components/rcb/scene/paint/svgToScene';
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import store from '@/store';

/** Soft blank click while an image quick-edit / mark session is pinned. */
function handlePinnedImageToolBlankClick(
  pin: string) {
  const editor = (store.getState() as { editor?: { imageToolPanel?: ImageToolPanelState | null; document?: SceneDocument } })
    .editor;
  dismissMarkToolSession(editor?.document, editor?.imageToolPanel, pin);
}

function isImageToolSessionPinned(
  pin: string | null | undefined,
  liveOrigins: Array<{ nodeId: string; box: SceneBox }> | null | undefined,
  selectedIds: string[],
  storeSelectedIds: string[]
): pin is string {
  if (!pin) return false;
  return (
    liveOrigins?.some((o) => o.nodeId === pin) ||
    selectedIds.includes(pin) ||
    storeSelectedIds.includes(pin)
  );
}

function setEndpointHover(handle: 'w' | 'e' | null) {
  if (typeof window === 'undefined') return;
  const root = window.document;
  root.querySelectorAll('[data-rcb-endpoint-hover="1"]').forEach((el) =>
    el.removeAttribute('data-rcb-endpoint-hover')
  );
  if (!handle) return;
  root.querySelectorAll(`[data-rcb-sel-endpoint="${handle}"]`).forEach((el) => {
    const halo = el.parentElement?.querySelector('.sel-ep-halo');
    halo?.setAttribute('data-rcb-endpoint-hover', '1');
  });
}
import {
  ShapeOutlineSvg,
  liveShapeGeomBox,
  nodeUsesOpenStrokeEndpoints,
  pathLocalEndpoints,
  type ShapeOutlineItem,
} from './HostPathChrome';
import { subscribeShapeHosts } from '@/components/rcb/shapes/shapeHostRegistry';
import { smartSnapThreshold } from './alignGuides';
import {
  CORNER_HANDLES,
  textResizeModeForHandle,
  nodeAspectLockDefault,
  mediaTitleChrome,
  textFrameTitleChrome,
  readNodeAspectLocked,
  combineAspectLock,
  resolveLockAspect,
  applyTextWrapHeight,
  normalizeBox,
  boxesIntersect,
  expandSceneBox,
  marqueeHitPadScene,
  MARQUEE_MIN_HIT_SCREEN_PX,
  framesHittingMarquee,
  resolveMarqueeFrameHits,
  resolveInspectPrimaryId,
  isHostInjectedSelection,
  frameForFullBleedPlate,
  sceneBoxFromMountedNode,
  pointInBox,
  nodeHitsMarquee,
  selectionToolbarDock,
  patchesAsOrigins,
  multiMembersKey,
  DRAG_DISTANCE_SQUARED,
  isMotionlessClick,
  BRUSH_SCREEN_PX,
  TOUCH_BRUSH_SCREEN_PX,
  brushScreenPx,
  makeDragSeed,
  sceneFromClientGesture,
  screenDragDistSq,
  evaluateBrushGate,
  isSelectionOriginsLocked,
  isRecentNodeDoubleTap,
  buildMoveOriginsForHit,
  filterMarqueeContentHits,
  commitMarqueeSelection,
  fallbackVisibleNodeHit,
  computeMovedUnion,
  shiftConstrainedMoveDelta,
  computeResizedUnion,
  resizeDragNearBox,
  collectSmartGuideTargets,
  smartGuideTargetsForDrag,
  shouldSkipSmartGuidesForAnimationWorkbenchDrag,
  computeRotateDelta,
  strokeEndpointBox,
  resizeOpenPathByEndpoint,
  readNodeAngle,
  readNodeShapeType,
  isStrokeShapeType,
  resolveChromeAngle,
  resolveMeasurePairNodeId,
  resolveMeasureBox,
  resolveClippedMeasureBox,
  deflateChromeBox,
  resolveTransformHostGuideBox,
  buildShapeOutlines,
  resolveChromeUnion,
  resolvePaintedControlChrome,
  resolveHoverImageVariantsId,
  resolveSelectionEdgeHandles,
  resolveFrameChromeBox,
  type MediaTitleIcon,
  type GeometryPatch,
  type DragState,
  type MoveSnapContext,
  type ResizeSnapContext,
  type SelectionEdgeHandles,
} from './selectionLogic';
import { frameSelId, parseFrameSelId } from './frameSelectionIds';
import {
  getFrameBox,
  frameIsEmpty,
  isPointOnFrameEdge,
  resolveFramePlateDragMode,
} from '@/components/rcb/frames/framePlatePointer';

function sceneBoxClose(
  a: SceneBox | null | undefined,
  b: SceneBox | null | undefined,
  eps = 1e-3
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.left - b.left) <= eps &&
    Math.abs(a.top - b.top) <= eps &&
    Math.abs(a.width - b.width) <= eps &&
    Math.abs(a.height - b.height) <= eps
  );
}

/** Anchor 0–100% — same rules as scene paint (`anchorPreset` wins). */
function selectionAnchorPercents(node: SceneNodeInput | null | undefined): {
  anchorX: number;
  anchorY: number;
} {
  if (!node) return { anchorX: 50, anchorY: 50 };
  const preset = String(node.attrs?.anchorPreset || '')
    .trim()
    .toLowerCase();
  if (/^[tmb][lmr]$/.test(preset)) {
    let anchorX = 50;
    if (preset.endsWith('l')) anchorX = 0;
    else if (preset.endsWith('r')) anchorX = 100;
    let anchorY = 50;
    if (preset.startsWith('t')) anchorY = 0;
    else if (preset.startsWith('b')) anchorY = 100;
    return { anchorX, anchorY };
  }
  const ax = Number(node.attrs?.anchorX);
  const ay = Number(node.attrs?.anchorY);
  return {
    anchorX: Number.isFinite(ax) ? Math.max(0, Math.min(100, ax)) : 50,
    anchorY: Number.isFinite(ay) ? Math.max(0, Math.min(100, ay)) : 50,
  };
}

function selectionSkewProps(node: SceneNodeInput | null | undefined): {
  skewX: number;
  skewAxis: number;
} {
  if (!node) return { skewX: 0, skewAxis: 0 };
  const skewX = Number(node.attrs?.skewX ?? node.attrs?.skew) || 0;
  const rawAxis = node.attrs?.skewAxis;
  const skewAxis =
    rawAxis != null && rawAxis !== '' ? Number(rawAxis) || 0 : 0;
  return { skewX, skewAxis };
}

function toolbarValueBox(
  preferred: SceneBox | null | undefined,
  node: SceneNodeInput
): SceneBox {
  if (preferred) {
    return {
      left: preferred.left,
      top: preferred.top,
      width: preferred.width,
      height: preferred.height,
    };
  }
  return {
    left: Number(node.x) || 0,
    top: Number(node.y) || 0,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

function isEllipseLikeNode(node: SceneNodeInput): boolean {
  return (
    String(node.attrs?.shapeType || '') === 'circle' || node.key === 'ellipse'
  );
}

function isTitledMediaNode(
  node: SceneNodeInput | null | undefined,
  isTextFrame: boolean
): boolean {
  if (!node) return false;
  if (isTextFrame) return true;
  const key = String(node.key || '');
  return key === 'image' || key === 'video' || key === 'lottie' || key === 'audio';
}

function selectionOriginsClose(
  a: Array<{ nodeId: string; box: SceneBox }> | null | undefined,
  b: Array<{ nodeId: string; box: SceneBox }> | null | undefined,
  eps = 1e-3
): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].nodeId !== b[i].nodeId) return false;
    if (!sceneBoxClose(a[i].box, b[i].box, eps)) return false;
  }
  return true;
}

/**
 * Soft plate focus: plate edge only — clear node/frame handle chrome.
 * Full chrome: one frame origin. Applied on pointerdown because the store→live
 * sync effect skips while dragRef is set; if selection already matches on up,
 * deps won't fire and stale liveOrigins would keep ghost handles.
 */
function framePlateLiveChrome(
  frameId: string,
  box: SceneBox | null,
  chrome: 'soft' | 'full'
): {
  origins: Array<{ nodeId: string; box: SceneBox }>;
  union: SceneBox | null;
  angle: number;
} {
  if (chrome === 'full' && box) {
    return {
      origins: [{ nodeId: frameSelId(frameId), box }],
      union: box,
      angle: 0,
    };
  }
  return { origins: [], union: null, angle: 0 };
}

/** One frame of live transform chrome + paint (ADR 0027 — RAF preview). */
export type TransformPreviewBatch = {
  union?: SceneBox | null;
  origins?: Array<{ nodeId: string; box: SceneBox }> | null;
  angle?: number;
  guides?: SmartGuideLine[];
  clearGuides?: boolean;
  marquee?: SceneBox | null;
  geom?: GeometryPatch[];
  geomOpts?: { textResizeMode?: TextResizeMode };
  angles?: Array<{ nodeId: string; angle: number }>;
  frameMove?: {
    frameId: string;
    left: number;
    top: number;
    opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' };
  };
};

/**
 * Coalesce pointermove transform previews to one rAF.
 * Commit path must {@link TransformPreviewCoalescer.cancel} — do not flush stale
 * mid-gesture paint over the final pointerup geometry.
 */
export type TransformPreviewCoalescer = {
  queue: (patch: TransformPreviewBatch) => void;
  cancel: () => void;
};

export function createTransformPreviewCoalescer(handlers: {
  applyChrome: (batch: TransformPreviewBatch) => void;
  applyGeom: (
    patches: GeometryPatch[],
    opts?: { textResizeMode?: TextResizeMode }
  ) => void;
  applyAngles: (angles: Array<{ nodeId: string; angle: number }>) => void;
  applyFrameMove?: (
    move: NonNullable<TransformPreviewBatch['frameMove']>
  ) => void;
}): TransformPreviewCoalescer {
  let raf = 0;
  let pending: TransformPreviewBatch | null = null;

  const flush = () => {
    raf = 0;
    const batch = pending;
    pending = null;
    if (!batch) return;
    handlers.applyChrome(batch);
    // Fold per-node angles into geom so box+angle land in one TransformPreview write.
    // Angle-then-box rotated the previous shaft about its center (both tips moved).
    const angles = batch.angles || [];
    const angleById = new Map(angles.map((a) => [a.nodeId, a.angle]));
    if (batch.geom?.length) {
      const merged = batch.geom.map((p) => {
        if (p.angle !== undefined) return p;
        const a = angleById.get(p.nodeId);
        return a !== undefined ? { ...p, angle: a } : p;
      });
      handlers.applyGeom(merged, batch.geomOpts);
      const geomIds = new Set(merged.map((p) => p.nodeId));
      const leftover = angles.filter((a) => !geomIds.has(a.nodeId));
      if (leftover.length) handlers.applyAngles(leftover);
    } else if (angles.length) {
      handlers.applyAngles(angles);
    }
    if (batch.frameMove) handlers.applyFrameMove?.(batch.frameMove);
  };

  return {
    queue(patch) {
      pending = pending
        ? {
            ...pending,
            ...patch,
            geom: patch.geom !== undefined ? patch.geom : pending.geom,
            geomOpts: patch.geomOpts !== undefined ? patch.geomOpts : pending.geomOpts,
            angles: patch.angles !== undefined ? patch.angles : pending.angles,
            guides: patch.guides !== undefined ? patch.guides : pending.guides,
            frameMove: patch.frameMove !== undefined ? patch.frameMove : pending.frameMove,
          }
        : { ...patch };
      if (!raf) raf = requestAnimationFrame(flush);
    },
    cancel() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      pending = null;
    },
  };
}

type SelectionFeatureProps = {
  enabled: boolean;
  /** Share/preview: select + Dev annotations only — no move/resize/edit. */
  readOnly?: boolean;
  document: SceneDocument;
  selectedNodeIds: string[];
  /** Artboard frames in the same selection as nodes (union control box). */
  selectedFrameIds?: string[];
  paperEl: HTMLElement | null;
  /** Viewport element for infinite canvas (optional; camera context is preferred). */
  stageEl?: HTMLElement | null;
  artboard: { width: number; height: number };
  onSelect: (ids: string[], opts?: { additive?: boolean }) => void;
  /** Hit-test artboard frames in scene coords. */
  hitTestFrame?: (x: number, y: number) => string | null;
  onSelectFrame?: (frameId: string | null, opts?: { chrome?: 'soft' | 'full' }) => void;
  /** Same artboard move pipeline as the title label (hide title, co-move children). */
  onFrameMoveStart?: (frameId: string) => void;
  onFrameMoveEnd?: () => void;
  onFrameMove?: (
    frameId: string,
    x: number,
    y: number,
    opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }
  ) => void;
  /** Marquee / multi artboard selection (frames only). */
  onSelectFrames?: (frameIds: string[]) => void;
  /** Marquee selecting nodes and/or frames together. */
  onSelectMixed?: (
    nodeIds: string[],
    frameIds: string[],
    opts?: { additive?: boolean }
  ) => void;
  onGeometryCommit: (
    patches: GeometryPatch[],
    options?: { textResizeMode?: TextResizeMode; skipHistory?: boolean }
  ) => void;
  /** Live DOM preview while dragging (does not write document). */
  onGeometryPreview?: (
    patches: GeometryPatch[],
    options?: { textResizeMode?: TextResizeMode }
  ) => void;
  onAngleCommit?: (
    nodeId: string,
    angleDeg: number,
    options?: { skipHistory?: boolean }
  ) => void;
  onAnglePreview?: (nodeId: string, angleDeg: number) => void;
  hitTest: (
    x: number,
    y: number,
    screen?: { clientX: number; clientY: number }
  ) => string | null;
  getNodeBox: (nodeId: string) => SceneBox | null;
  listNodeIds: () => readonly string[];
  /**
   * Optional spatial prefilter for marquee (and similar rect queries).
   * Return candidate ids that may intersect `box`; fine hit still uses nodeHitsMarquee.
   */
  queryNodeIdsInRect?: (box: SceneBox) => string[];
  onOpenAgent?: (opts?: { prompt?: string }) => void;
  /** Double-click a text node to edit inline. */
  onEditText?: (nodeId: string) => void;
  /** Double-click a pen path to edit anchors / handles. */
  onEditPenPath?: (nodeId: string) => void;
  /** Hide selection chrome / toolbars (e.g. while inline text editing). */
  suppressChrome?: boolean;
  /** Fires when move / resize / rotate starts or ends (for hiding node titles). */
  onTransformingChange?: (transforming: boolean) => void;
  /**
   * Composer "Add from canvas" pick mode — clicks attach via onSelect and must
   * not start a move (already-selected hits would otherwise skip onSelect).
   */
  attachPickActive?: boolean;
  /** Keep the pinned node selected during quick-edit / mark box sessions. */
  imageToolSessionNodeId?: string | null;
};

function guidesForSelection(
  frameIds: string[],
  transforming: boolean,
  smartGuides: SmartGuideLine[],
  idleGuides: SmartGuideLine[]
) {
  if (frameIds.length > 0) return [];
  if (transforming) return smartGuides;
  return idleGuides;
}


function SelectionFeature({
  enabled,
  readOnly = false,
  document,
  selectedNodeIds,
  selectedFrameIds = [],
  paperEl,
  stageEl = null,
  artboard,
  onSelect,
  hitTestFrame,
  onSelectFrame,
  onFrameMoveStart,
  onFrameMoveEnd,
  onFrameMove,
  onSelectFrames,
  onSelectMixed,
  onGeometryCommit,
  onGeometryPreview,
  onAngleCommit,
  onAnglePreview,
  hitTest,
  getNodeBox,
  listNodeIds,
  queryNodeIdsInRect,
  onOpenAgent,
  onEditText,
  onEditPenPath,
  suppressChrome = false,
  onTransformingChange,
  attachPickActive = false,
  imageToolSessionNodeId = null,
}: SelectionFeatureProps) {
  const overlayRoot = useRcbOverlayRoot();
  const viewportEl = useRcbViewportEl();
  const toScene = useRcbScreenToScene();
  const camera = useRcbCamera();
  // Same CSS zoom the world layer / grid use (not raw camera.zoom drift).
  const zoom = Math.max(0.05, rcbCameraCssZoom(camera));
  const workspaceMode = useSelector(
    (s: any) => (s.editor.workspaceMode || 'design') as 'design' | 'dev'
  );
  const gridSize = getDocumentGridSize(document);
  /** Prefer live context viewport — prop stageEl can go stale after resize remounts. */
  const hitEl = rcbResolveViewportEl(viewportEl, stageEl, paperEl);
  const frameChromeMode = useSelector(
    (s: { editor?: { frameChromeMode?: 'soft' | 'full' } }) =>
      s.editor?.frameChromeMode === 'full' ? 'full' : 'soft'
  );
  const { t } = useTranslation();
  const shapeStylePanel = useSelector(
    (s: any) => s.editor.shapeStylePanel as null | { kind: string }
  );
  // Scrubbing updates host `__sceneAngle` without store attrs — re-read chrome angle.
  const lottiePlayheadSec = useAnimationPlayheadSec();
  /** Radius panel keeps chrome (rounded outline) but hides floating toolbars. */
  const suppressToolbars = suppressChrome || shapeStylePanel?.kind === 'radius';
  const imageVariantsExpandedId = useImageVariantsExpandedNodeId();
  const variantsStackOpen = Boolean(imageVariantsExpandedId);
  const effectiveSuppressToolbars = suppressToolbars || variantsStackOpen;
  /** Share preview / Dev: select?hover spacing + orange pair chrome. */
  const inspectDev = workspaceMode === 'dev' || readOnly;
  const dragRef = useRef<DragState | null>(null);
  const liveUnionRef = useRef<SceneBox | null>(null);
  const liveOriginsRef = useRef<Array<{ nodeId: string; box: SceneBox }> | null>(null);
  const liveAngleRef = useRef(0);
  /** Held multi control pose until doc shared-angle catches up or members move (undo). */
  const multiChromeRef = useRef<{
    selKey: string;
    box: SceneBox;
    angle: number;
    membersKey: string;
  } | null>(null);
  const idsKeyRef = useRef('');
  const frameIdsKeyRef = useRef('');
  const holdMultiChrome = (
    box: SceneBox,
    angle: number,
    origins: Array<{ nodeId: string; box: SceneBox }>
  ) => {
    if (origins.length < 2 || Math.abs(angle) < 0.01) return;
    multiChromeRef.current = {
      selKey: `${idsKeyRef.current}#${frameIdsKeyRef.current}`,
      box: { ...box },
      angle,
      membersKey: multiMembersKey(origins),
    };
  };
  /** Soft-click double-tap on text (counted on pointerup; native dblclick is the primary path). */
  const lastTextClickRef = useRef<{ id: string; at: number } | null>(null);
  const lastNodeTapRef = useRef<{ id: string; t: number; x: number; y: number } | null>(null);
  const onTransformingChangeRef = useRef(onTransformingChange);
  onTransformingChangeRef.current = onTransformingChange;

  // Keep pointer handlers stable — document identity churn must not tear down
  // window listeners mid-marquee (setMarquee re-render used to drop pointerup — stuck brush).
  const documentRef = useRef(document);
  const getNodeBoxRef = useRef(getNodeBox);
  const listNodeIdsRef = useRef(listNodeIds);
  const queryNodeIdsInRectRef = useRef(queryNodeIdsInRect);
  const hitTestRef = useRef(hitTest);
  const hitTestFrameRef = useRef(hitTestFrame);
  const onSelectRef = useRef(onSelect);
  const onSelectFrameRef = useRef(onSelectFrame);
  const onFrameMoveStartRef = useRef(onFrameMoveStart);
  const onFrameMoveEndRef = useRef(onFrameMoveEnd);
  const onFrameMoveRef = useRef(onFrameMove);
  const onSelectMixedRef = useRef(onSelectMixed);
  const onSelectFramesRef = useRef(onSelectFrames);
  const toSceneRef = useRef(toScene);
  const onGeometryCommitRef = useRef(onGeometryCommit);
  const onGeometryPreviewRef = useRef(onGeometryPreview);
  const onAngleCommitRef = useRef(onAngleCommit);
  const onAnglePreviewRef = useRef(onAnglePreview);
  const onEditTextRef = useRef(onEditText);
  const onEditPenPathRef = useRef(onEditPenPath);
  const zoomRef = useRef(zoom);
  const gridSizeRef = useRef(gridSize);
  const readOnlyRef = useRef(readOnly);
  const attachPickActiveRef = useRef(attachPickActive);
  const imageToolSessionNodeIdRef = useRef(imageToolSessionNodeId);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const selectedFrameIdsRef = useRef(selectedFrameIds);
  const transformingRef = useRef(false);
  /** Latest chrome pick options — read on pointer events (not effect deps). */
  const chromePickOptsRef = useRef({
    zoom: 1,
    showHandles: false,
    allowHandlePick: false,
    showRotate: false,
    lineMode: false,
    cornerHandlesOnly: false,
    edgeHandles: 'all' as SelectionEdgeHandles,
    suppressChrome: false,
    strokeOuterScene: 0,
    clientToScene: (clientX: number, clientY: number) => ({ x: clientX, y: clientY }),
  });
  documentRef.current = document;
  getNodeBoxRef.current = getNodeBox;
  listNodeIdsRef.current = listNodeIds;
  queryNodeIdsInRectRef.current = queryNodeIdsInRect;
  hitTestRef.current = hitTest;
  hitTestFrameRef.current = hitTestFrame;
  onSelectRef.current = onSelect;
  onSelectFrameRef.current = onSelectFrame;
  onFrameMoveStartRef.current = onFrameMoveStart;
  onFrameMoveEndRef.current = onFrameMoveEnd;
  onFrameMoveRef.current = onFrameMove;
  onSelectMixedRef.current = onSelectMixed;
  onSelectFramesRef.current = onSelectFrames;
  toSceneRef.current = toScene;
  onGeometryCommitRef.current = onGeometryCommit;
  onGeometryPreviewRef.current = onGeometryPreview;
  onAngleCommitRef.current = onAngleCommit;
  onAnglePreviewRef.current = onAnglePreview;
  onEditTextRef.current = onEditText;
  onEditPenPathRef.current = onEditPenPath;
  zoomRef.current = zoom;
  gridSizeRef.current = gridSize;
  readOnlyRef.current = readOnly;
  attachPickActiveRef.current = attachPickActive;
  imageToolSessionNodeIdRef.current = imageToolSessionNodeId;
  selectedNodeIdsRef.current = selectedNodeIds;
  selectedFrameIdsRef.current = selectedFrameIds;

  const [liveUnion, setLiveUnion] = useState<SceneBox | null>(null);
  const [liveOrigins, setLiveOrigins] = useState<Array<{ nodeId: string; box: SceneBox }> | null>(
    null
  );
  const [liveAngle, setLiveAngle] = useState(0);
  /** Host mount / sticky re-align after draw — force live boxes to match paint. */
  const [hostEpoch, setHostEpoch] = useState(0);
  useEffect(() => subscribeShapeHosts(() => setHostEpoch((n) => n + 1)), []);
  useEffect(
    () =>
      subscribeLiveShapeParamsPreview(() => {
        setHostEpoch((n) => n + 1);
      }),
    []
  );
  const [marquee, setMarquee] = useState<SceneBox | null>(null);
  /** Live object-align guides while move / resize. */
  const [smartGuides, setSmartGuides] = useState<SmartGuideLine[]>([]);
  /** Hide chrome/toolbars while move / resize / rotate is in progress. */
  const [transforming, setTransforming] = useState(false);
  /** Dev inspect: node under pointer (annotations follow mouse). */
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const hoverNodeIdRef = useRef<string | null>(null);
  /** Preview / Dev: previous single selection — click A then B shows A?B spacing. */
  const [inspectPairNodeId, setInspectPairNodeId] = useState<string | null>(null);
  const prevInspectSelRef = useRef<string | null>(null);

  const setTransformingNotify = (next: boolean) => {
    transformingRef.current = next;
    setTransforming(next);
    if (!next) setSmartGuides([]);
    onTransformingChangeRef.current?.(next);
  };

  liveUnionRef.current = liveUnion;
  liveOriginsRef.current = liveOrigins;
  liveAngleRef.current = liveAngle;

  const idsKey = selectedNodeIds.join('|');
  const frameIdsKey = selectedFrameIds.join('|');
  idsKeyRef.current = idsKey;
  frameIdsKeyRef.current = frameIdsKey;
  const selectionCount = selectedNodeIds.length + selectedFrameIds.length;
  const single = selectionCount === 1;
  const singleNode = selectedNodeIds.length === 1 && selectedFrameIds.length === 0;

  const baseOrigins = useMemo(() => {
    // Derive ids from keys so a new array reference does not recreate origins
    // every render (that caused Maximum update depth loops).
    const ids = idsKey ? idsKey.split('|').filter(Boolean) : [];
    // Soft single-frame focus: plate edge only — no control chrome.
    // Multi-frame or mixed (nodes + frames) always need frames in the union
    // so drag/move can seed every `__frame__:` origin together.
    const fids = (() => {
      if (!frameIdsKey) return [];
      const list = frameIdsKey.split('|').filter(Boolean);
      if (!list.length) return [];
      if (list.length > 1) return list;
      if (idsKey) return list; // mixed selection
      if (frameChromeMode === 'full') return list;
      return [];
    })();
    const nodeOrigins = ids
      .map((id) => {
        const box = getNodeBox(id);
        if (!box) {
          const node = document?.deltaSetLike?.[id];
          if (!node) return null;
          const { left, top } = nodeLeftTop(document, node);
          return {
            nodeId: id,
            box: {
              left,
              top,
              width: Math.max(1, Number(node.width) || 1),
              height: Math.max(1, Number(node.height) || 1),
            },
          };
        }
        return { nodeId: id, box };
      })
      .filter(Boolean) as Array<{ nodeId: string; box: SceneBox }>;
    const frames = Array.isArray(document?.frames) ? document.frames : [];
    const frameOrigins = fids
      .map((fid) => {
        const f = frames.find((x: any) => x?.id === fid);
        if (!f) return null;
        return {
          nodeId: frameSelId(fid),
          box: resolveFrameChromeBox(fid, f),
        };
      })
      .filter(Boolean) as Array<{ nodeId: string; box: SceneBox }>;
    return [...nodeOrigins, ...frameOrigins];
  }, [document, idsKey, frameIdsKey, frameChromeMode, getNodeBox]);

  const selectionSharedRotation = useMemo(() => {
    if (selectedNodeIds.length <= 1) return 0;
    return getSelectionSharedRotation(document, selectedNodeIds);
  }, [document, selectedNodeIds]);

  const selectionUnion = useMemo(() => {
    if (!baseOrigins.length) return null;
    return resolveControlChrome(
      document,
      baseOrigins,
      null,
      baseOrigins.length > 1 ? selectionSharedRotation : undefined
    ).box;
  }, [baseOrigins, document, selectionSharedRotation]);

  useEffect(() => {
    if (dragRef.current) return;
    // After draw/remount, prefer live host geom so picks match HostPathChrome paint
    // (store AABB alone drifts under sticky lattice at high zoom).
    // Frames: baseOrigins already went through resolveFrameChromeBox (live plate /
    // host-if-close / document) — do not overwrite with a bare stale host lattice
    // after multi-frame mode:move.
    const origins = baseOrigins.map((o) => {
      const frameId = parseFrameSelId(o.nodeId);
      if (frameId) return o;
      const live = liveShapeGeomBox(o.nodeId);
      if (!live) return o;
      const node = document?.deltaSetLike?.[o.nodeId];
      return { nodeId: o.nodeId, box: inflateSelectionBox(live, node) };
    });

    let nextUnion: SceneBox | null = null;
    let nextAngle = 0;
    const onlyNodeId =
      !frameIdsKey && idsKey && !idsKey.includes('|') ? idsKey : null;
    if (onlyNodeId) {
      multiChromeRef.current = null;
      nextUnion = origins[0]?.box || selectionUnion;
      nextAngle = readNodeAngle(document, onlyNodeId);
    } else if (!selectionUnion) {
      multiChromeRef.current = null;
      nextUnion = null;
      nextAngle = 0;
    } else if (!idsKey || Math.abs(selectionSharedRotation) < 0.01) {
      // Frame-only or multi without shared rotation — use current union.
      const prev = multiChromeRef.current;
      const selKey = `${idsKey}#${frameIdsKey}`;
      const membersKey = multiMembersKey(baseOrigins);
      if (
        prev?.selKey === selKey &&
        Math.abs(prev.angle) > 0.01 &&
        prev.membersKey === membersKey
      ) {
        nextUnion = prev.box;
        nextAngle = prev.angle;
      } else {
        multiChromeRef.current = {
          selKey,
          box: { ...selectionUnion },
          angle: 0,
          membersKey,
        };
        // Multi artboard / 动画: always the full selection union — origins[0]
        // collapsed the blue box onto the first plate after move (chrome drift).
        nextUnion =
          !idsKey && origins.length === 1 && origins[0]?.box
            ? origins[0].box
            : selectionUnion;
        nextAngle = 0;
      }
    } else {
      const selKey = `${idsKey}#${frameIdsKey}`;
      const membersKey = multiMembersKey(baseOrigins);
      multiChromeRef.current = {
        selKey,
        box: { ...selectionUnion },
        angle: selectionSharedRotation,
        membersKey,
      };
      nextUnion = selectionUnion;
      nextAngle = selectionSharedRotation;
    }

    // Unconditional setLiveOrigins([]) / new arrays re-render forever when a
    // dep (hostEpoch / document) chatters — React compares by Object.is.
    if (!selectionOriginsClose(liveOriginsRef.current, origins)) {
      setLiveOrigins(origins);
    }
    if (!sceneBoxClose(liveUnionRef.current, nextUnion)) {
      setLiveUnion(nextUnion);
    }
    if (Math.abs((liveAngleRef.current || 0) - nextAngle) > 1e-3) {
      setLiveAngle(nextAngle);
    }
  }, [
    baseOrigins,
    document,
    idsKey,
    frameIdsKey,
    selectionUnion,
    selectionSharedRotation,
    hostEpoch,
  ]);

  // Inspect: keep prior selection as pair target when clicking another element.
  useEffect(() => {
    const next = resolveInspectPrimaryId(selectedNodeIds, selectedFrameIds);
    const prev = prevInspectSelRef.current;
    if (next && prev && prev !== next) {
      setInspectPairNodeId(prev);
    } else if (!next) {
      setInspectPairNodeId(null);
    }
    prevInspectSelRef.current = next;
  }, [selectedNodeIds, selectedFrameIds]);

  useEffect(() => {
    if (!enabled || !hitEl) return undefined;

    const applyHover = (id: string | null) => {
      if (hoverNodeIdRef.current === id) return;
      hoverNodeIdRef.current = id;
      setHoverNodeId(id);
      // Dev / share inspect panel reads hover from the editor store.
      if (workspaceMode === 'dev' || readOnly) {
        setDevHoverNodeId(id);
      }
    };

    let hoverRaf = 0;
    let pending: PointerEvent | null = null;

    const clearChromeCursor = () => clearSelectionChromeCursor(hitEl);

    const paintedChromeHover = (
      e: PointerEvent,
      scene: { x: number; y: number },
      includeOverlayKnobs: boolean
    ) =>
      applyPaintedChromeHover({
        hitEl,
        clientX: e.clientX,
        clientY: e.clientY,
        target: e.target,
        scene,
        sceneDoc: documentRef.current,
        liveUnion: liveUnionRef.current,
        liveOrigins: liveOriginsRef.current,
        liveAngle: liveAngleRef.current || 0,
        pickOpts: chromePickOptsRef.current,
        setEndpointHover,
        includeOverlayKnobs,
      });

    const runHoverHit = (e: PointerEvent) => {
      setEndpointHover(null);
      if (dragRef.current) {
        applyHover(null);
        clearChromeCursor();
        return;
      }
      const hoverScene = toScene(e.clientX, e.clientY);
      syncOverlayHandleHoverAtClient(e.clientX, e.clientY, e.target, hoverScene);
      const target = e.target as HTMLElement | null;

      const variantsHost = target?.closest?.(
        '[data-image-variants-bar]'
      ) as HTMLElement | null;
      if (variantsHost) {
        const pinned = variantsHost.getAttribute('data-image-node-id');
        if (pinned) {
          clearChromeCursor();
          applyHover(pinned);
          return;
        }
      }

      // Inspector docks over E resize seats — do not paint chrome cursors through it.
      if (target?.closest?.('[data-lottie-inspector]')) {
        clearChromeCursor();
        applyHover(null);
        return;
      }

      if (isSelectionHoverUiTarget(target)) {
        if (paintedChromeHover(e, hoverScene, false)) {
          applyHover(null);
          return;
        }
        applyHover(null);
        return;
      }

      const p = toScene(e.clientX, e.clientY);
      if (paintedChromeHover(e, p, true)) {
        applyHover(null);
        return;
      }

      // Only hit-test when the pointer is over the stage / paper / selection chrome.
      if (
        target &&
        !hitEl.contains(target) &&
        !paperEl?.contains(target) &&
        !overlayRoot?.contains(target) &&
        !target.closest?.('[data-sel-box],[data-sel-handle]')
      ) {
        applyHover(null);
        return;
      }
      const rawHit = hitTestRef.current(p.x, p.y, {
        clientX: e.clientX,
        clientY: e.clientY,
      });
      const frameFromHit = rawHit ? parseFrameSelId(rawHit) : null;
      if (frameFromHit) {
        applyHover(frameSelId(frameFromHit));
        return;
      }
      if (rawHit) {
        const hitNode = documentRef.current?.deltaSetLike?.[rawHit];
        // Preview-only workbench ink must not get hover path silhouettes.
        if (isAnimationWorkbenchPreviewChild(documentRef.current, hitNode)) {
          const fid = String(hitNode?.attrs?.frameId || '').trim();
          applyHover(fid ? frameSelId(fid) : null);
          return;
        }
        applyHover(rawHit);
        return;
      }
      // Empty artboard / frame chrome: still measure select?hover spacing.
      const frameHit = hitTestFrameRef.current?.(p.x, p.y) ?? null;
      applyHover(frameHit ? frameSelId(frameHit) : null);
    };

    const onHoverMove = (e: PointerEvent) => {
      pending = e;
      if (hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const next = pending;
        pending = null;
        if (next) runHoverHit(next);
      });
    };

    const onLeave = () => {
      pending = null;
      if (hoverRaf) {
        cancelAnimationFrame(hoverRaf);
        hoverRaf = 0;
      }
      clearSelectionChromeCursor(hitEl);
      applyHover(null);
    };

    window.addEventListener('pointermove', onHoverMove, { passive: true });
    window.addEventListener('blur', onLeave);
    return () => {
      pending = null;
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      window.removeEventListener('pointermove', onHoverMove);
      window.removeEventListener('blur', onLeave);
      clearSelectionChromeCursor(hitEl);
    };
  }, [enabled, hitEl, paperEl, overlayRoot, artboard, hitTest, toScene, workspaceMode, readOnly]);

  useEffect(() => {
    if (!enabled || !hitEl) return undefined;

    // Recover from a stuck scrub flag left by a missed pointerup.
    // Use window.document — `document` in this scope is the scene model.
    if (window.document.documentElement.hasAttribute('data-lottie-scrubbing')) {
      window.document.documentElement.removeAttribute('data-lottie-scrubbing');
    }

    const previewCoalesce = createTransformPreviewCoalescer({
      applyChrome: (batch) => {
        if (batch.union !== undefined) setLiveUnion(batch.union);
        if (batch.origins !== undefined) setLiveOrigins(batch.origins);
        if (batch.angle !== undefined) setLiveAngle(batch.angle);
        if (batch.clearGuides) setSmartGuides([]);
        else if (batch.guides) setSmartGuides(batch.guides);
        if (batch.marquee !== undefined) setMarquee(batch.marquee);
      },
      applyGeom: (patches, opts) => {
        onGeometryPreviewRef.current?.(patches, opts);
      },
      applyAngles: (angles) => {
        for (const a of angles) {
          onAnglePreviewRef.current?.(a.nodeId, a.angle);
        }
      },
      applyFrameMove: (move) => {
        onFrameMoveRef.current?.(move.frameId, move.left, move.top, move.opts);
      },
    });

    /** Sync hit refs immediately; paint/chrome flush on rAF (ADR 0027). */
    const queuePreview = (batch: TransformPreviewBatch) => {
      if (batch.union !== undefined) liveUnionRef.current = batch.union;
      if (batch.origins !== undefined) liveOriginsRef.current = batch.origins;
      if (batch.angle !== undefined) liveAngleRef.current = batch.angle;
      previewCoalesce.queue(batch);
    };

    const getPointerCtx = () => ({
      // Scene model — never shadow DOM Document (elementsFromPoint / querySelector).
      sceneDoc: documentRef.current,
      toScene: toSceneRef.current,
      zoom: zoomRef.current,
      gridSize: gridSizeRef.current,
      readOnly: readOnlyRef.current,
      attachPickActive: attachPickActiveRef.current,
      hitTest: hitTestRef.current,
      hitTestFrame: hitTestFrameRef.current,
      getNodeBox: getNodeBoxRef.current,
      listNodeIds: listNodeIdsRef.current,
      queryNodeIdsInRect: queryNodeIdsInRectRef.current,
      onSelect: onSelectRef.current,
      onSelectFrame: onSelectFrameRef.current,
      onSelectMixed: onSelectMixedRef.current,
      onSelectFrames: onSelectFramesRef.current,
      onGeometryCommit: onGeometryCommitRef.current,
      onGeometryPreview: onGeometryPreviewRef.current,
      onAngleCommit: onAngleCommitRef.current,
      onAnglePreview: onAnglePreviewRef.current,
      onEditText: onEditTextRef.current,
      onEditPenPath: onEditPenPathRef.current,
    });

    const TEXT_DBLCLICK_MS = 450;

    /**
     * Soft-click on text: open edit when it was already selected before this
     * gesture, or on a second soft-click within TEXT_DBLCLICK_MS.
     * (Must not open on the first click that only selects — that gesture sets
     * selection on pointerdown, so "already selected" must be captured then.)
     */
    const tryOpenTextEdit = (id: string, wasSelectedOnDown = false) => {
      const { sceneDoc, onEditText, onSelect, readOnly } = getPointerCtx();
      if (readOnly) return false;
      const node = sceneDoc?.deltaSetLike?.[id];
      if (node?.key !== 'text' || !onEditText) {
        lastTextClickRef.current = null;
        return false;
      }
      const now = performance.now();
      const prev = lastTextClickRef.current;
      const doubleSoft =
        Boolean(prev && prev.id === id && now - prev.at < TEXT_DBLCLICK_MS);
      if (wasSelectedOnDown || doubleSoft) {
        lastTextClickRef.current = null;
        onSelect([id]);
        onEditText(id);
        return true;
      }
      lastTextClickRef.current = { id, at: now };
      return false;
    };

    const capture = (pointerId: number) => {
      hitEl.setPointerCapture?.(pointerId);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // New gesture — drop any brush left stuck after a lost pointerup.
      setMarquee(null);
      const {
        sceneDoc,
        toScene,
        zoom,
        readOnly,
        attachPickActive,
        hitTest,
        hitTestFrame,
        getNodeBox,
        listNodeIds,
        onSelect,
        onSelectFrame,
      } = getPointerCtx();
      // Text nodes are not Elements — normalize so `.closest` cannot throw and miss UI docks.
      const targetNode = e.target as Node | null;
      const target = (
        targetNode && targetNode.nodeType === 1
          ? (targetNode as Element)
          : targetNode?.parentElement
      ) as HTMLElement | null;
      if (!target) {
        logSelectClick({
          phase: 'pointerdown',
          branch: 'no-target',
          client: { x: e.clientX, y: e.clientY },
        });
        return;
      }
      if (window.document.documentElement.hasAttribute('data-lottie-scrubbing')) {
        logSelectClick({
          phase: 'pointerdown',
          branch: 'lottie-scrubbing',
          client: { x: e.clientX, y: e.clientY },
        });
        return;
      }
      const seed = (
        mode: DragState['mode'],
        ev: { clientX: number; clientY: number },
        pt: { x: number; y: number },
        extras?: Partial<DragState>
      ) => makeDragSeed(mode, ev, pt, extras, hitEl);

      const p = toScene(e.clientX, e.clientY);
      const liveUnionNow = liveUnionRef.current;
      const liveOriginsNow = liveOriginsRef.current;
      const liveAngleNow = liveAngleRef.current;
      const lockedSelection = isSelectionOriginsLocked(sceneDoc, liveOriginsNow);
      // Fresh pointerdown owns the gesture. A missed pointerup leaves dragRef +
      // transforming stuck — chrome/toolbars stay hidden (looks unselected) even
      // when storeNodeIds still hold the pick. Clear before any new branch.
      if (dragRef.current || transformingRef.current) {
        dragRef.current = null;
        setTransformingNotify(false);
      }
      // After clear, do not reuse chromePickOptsRef.showHandles from the prior
      // transforming frame — that skipped endpoint seats → whole-stroke move.
      const basePickOpts = chromePickOptsRef.current;
      const pickOpts = {
        ...basePickOpts,
        showHandles: Boolean(basePickOpts.allowHandlePick),
      };
      const storeNodeIds = selectedNodeIdsRef.current;
      const storeFrameIds = selectedFrameIdsRef.current;
      const markSessionActive =
        ((store.getState() as { editor?: { imageToolPanel?: ImageToolPanelState | null } })
          .editor?.imageToolPanel?.kind === 'mark');
      const clickLog = (branch: string, extra?: Record<string, unknown>) => {
        logSelectClick({
          phase: 'pointerdown',
          branch,
          client: { x: e.clientX, y: e.clientY },
          scene: { x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)) },
          storeNodeIds,
          storeFrameIds,
          liveOriginIds: liveOriginsNow?.map((o) => o.nodeId) ?? [],
          transforming: transformingRef.current,
          suppressChrome: pickOpts.suppressChrome,
          showHandles: pickOpts.showHandles,
          shiftKey: e.shiftKey,
          readOnly,
          attachPickActive,
          markSessionActive,
          ...extra,
        });
      };

      // UI panels own the gesture before geometric chrome pick. The Lottie
      // inspector docks on the selection's E edge and overlaps resize seats —       // `[data-lottie-inspector]` below must win.
      if (target.closest('[data-sel-toolbar],[data-frame-toolbar]')) {
        clickLog('ui-toolbar');
        return;
      }
      if (
        target.closest(
          '[data-ctx-menu],[data-export-panel],[data-image-label],[data-frame-label],[data-crop-expand-overlay],[data-crop-expand-toolbar],[data-image-tool-panel],[data-image-variants],[data-media-quick-edit],[data-mark-composer],[data-shape-style-panel],[data-gradient-handles],[data-mesh-handles],[data-fill-image-handles],[data-fill-image-preview],[data-color-panel],[data-text-inline-editor],[data-frame-handle],[data-image-generator],[data-video-generator],[data-video-playback-bar],[data-video-trim-toolbar],[data-audio-playback-bar],[data-audio-trim-toolbar],[data-audio-speed-toolbar],[data-mockup-session],[data-mockup-toolbar],[data-upscale-toolbar],[data-translate-image-toolbar],[data-product-scene-toolbar],[data-mark-overlay],[data-mark-pin-overlay],[data-mark-prompt],[data-puppet-pin-overlay],[data-lottie-inspector],[data-lottie-kf-popover]'
        )
      ) {
        clickLog('ui-panel');
        return;
      }

      // Mark session: never start geometry transforms. setTransformingNotify(true)
      // used to unmount MarkSessionHost; even when mounted, capture steals the
      // rubber-band. Soft blank still dismisses via pointing_canvas below.
      if (markSessionActive && !attachPickActive) {
        const hitEarly = hitTest(p.x, p.y, { clientX: e.clientX, clientY: e.clientY });
        if (hitEarly) {
          clickLog('mark-session-yield', { hitId: hitEarly });
          return;
        }
        const selectedIdsEarly = liveOriginsNow?.map((o) => o.nodeId) ?? [];
        clickLog('mark-session-blank', {
          hitId: null,
          pointInLiveUnion: Boolean(
            liveUnionNow && pointInOrientedBox(p, liveUnionNow, liveAngleNow || 0)
          ),
        });
        if (!e.shiftKey) {
          const pin = imageToolSessionNodeIdRef.current;
          if (
            !isImageToolSessionPinned(pin, liveOriginsNow, selectedIdsEarly, storeNodeIds)
          ) {
            onSelectFrame?.(null);
            onSelect([]);
          }
        }
        dragRef.current = seed('pointing_canvas', e, p);
        capture(e.pointerId);
        return;
      }

      // One pick: overlay seats — geometry chrome — DOM chrome.
      // Scene point shared with CameraTransform (ADR 0027).
      let chromePick: ChromeHandlePick | null = null;
      if (
        !pickOpts.suppressChrome &&
        pickOpts.showHandles &&
        liveUnionNow &&
        liveOriginsNow?.length
      ) {
        const painted = resolvePaintedControlChrome(
          sceneDoc,
          liveOriginsNow,
          liveUnionNow,
          liveAngleNow
        );
        const ink = pickSelectionInkAtClient(e.clientX, e.clientY, e.target, {
          ...pickOpts,
          box: painted.box,
          angle: painted.angle,
          scene: p,
        });
        if (ink?.layer === 'overlay') {
          tryStartOverlayHandleSeat(ink.pick, e);
          e.preventDefault();
          e.stopPropagation();
          clickLog('chrome-overlay', { chromePick: ink.pick?.kind ?? null });
          return;
        }
        if (ink?.layer === 'chrome') chromePick = ink.pick;
      }

      if (chromePick?.kind === 'rotate' && liveUnionNow && liveOriginsNow?.length) {
        if (readOnly || lockedSelection) {
          clickLog('chrome-rotate-blocked', {
            readOnly,
            lockedSelection,
            chromePick: chromePick.kind,
          });
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        clickLog('chrome-rotate', { chromePick: chromePick.kind });
        const { box: union, angle: angle0 } = resolvePaintedControlChrome(
          sceneDoc,
          liveOriginsNow,
          liveUnionNow,
          liveAngleNow
        );
        const center = {
          x: union.left + union.width / 2,
          y: union.top + union.height / 2,
        };
        const pointerAngle0 = (Math.atan2(p.y - center.y, p.x - center.x) * 180) / Math.PI;
        dragRef.current = seed('rotate', e, p, {
          origins: liveOriginsNow.map((o) => ({
            nodeId: o.nodeId,
            box: { ...o.box },
            angle0: readNodeAngle(sceneDoc, o.nodeId),
          })),
          union: { ...union },
          angle0,
          center,
          pointerAngle0,
        });
        setLiveUnion(union);
        setLiveAngle(angle0);
        setTransformingNotify(true);
        capture(e.pointerId);
        return;
      }

      if (
        (chromePick?.kind === 'resize' || chromePick?.kind === 'endpoint') &&
        liveUnionNow &&
        liveOriginsNow?.length
      ) {
        if (readOnly || lockedSelection) {
          clickLog('chrome-resize-blocked', {
            readOnly,
            lockedSelection,
            chromePick: chromePick.kind,
          });
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        clickLog('chrome-resize', { chromePick: chromePick.kind, handle: chromePick.handle });
        const handle = chromePick.handle;
        const singleId = liveOriginsNow.length === 1 ? liveOriginsNow[0].nodeId : '';
        const singleNode = singleId ? sceneDoc?.deltaSetLike?.[singleId] : null;
        const shapeType = singleNode ? String(singleNode.attrs?.shapeType || '') : '';
        const { box: union, angle: shared } = resolvePaintedControlChrome(
          sceneDoc,
          liveOriginsNow,
          liveUnionNow,
          liveAngleNow
        );
        let pathEpLocal0: [number, number] | undefined;
        let pathEpLocal1: [number, number] | undefined;
        // Open stroke tips: record path-local ends so resize tracks the grabbed tip.
        if (
          singleId &&
          (handle === 'e' || handle === 'w') &&
          nodeUsesOpenStrokeEndpoints(singleNode) &&
          shapeType !== 'line' &&
          shapeType !== 'arrow'
        ) {
          const box = liveOriginsNow[0].box;
          const d = String(singleNode?.attrs?.path || '');
          const [a, b] = pathLocalEndpoints(d, box.width, box.height, 'path');
          pathEpLocal0 = a;
          pathEpLocal1 = b;
        }
        // Line/arrow: seed shaft geometry (not stroke-inflated chrome) so the
        // opposite endpoint stays fixed while this handle moves.
        const strokeGeom =
          singleId && (shapeType === 'line' || shapeType === 'arrow')
            ? deflateSelectionBox(
                liveOriginsNow[0].box,
                singleNode
              )
            : null;
        let strokeFixedWorld: { x: number; y: number } | undefined;
        if (strokeGeom && (handle === 'e' || handle === 'w')) {
          const ep = strokeEndpointsFromBox(strokeGeom, shared);
          strokeFixedWorld =
            handle === 'e'
              ? { x: ep.x0, y: ep.y0 }
              : { x: ep.x1, y: ep.y1 };
        }
        dragRef.current = seed('resize', e, p, {
          origins: liveOriginsNow.map((o) => ({
            nodeId: o.nodeId,
            box:
              strokeGeom && o.nodeId === singleId
                ? { ...strokeGeom }
                : { ...o.box },
          })),
          union: strokeGeom ? { ...strokeGeom } : { ...union },
          handle,
          angle0: shared,
          aspectRatio: (strokeGeom || union).width / Math.max(1, (strokeGeom || union).height),
          pathEpLocal0,
          pathEpLocal1,
          strokeFixedWorld,
        });
        setLiveUnion(union);
        setLiveAngle(shared);
        setTransformingNotify(true);
        capture(e.pointerId);
        return;
      }

      const beginMoveSelection = () => {
        if (readOnly || !liveUnionNow || !liveOriginsNow?.length) return false;
        if (lockedSelection) return false;
        e.preventDefault();
        e.stopPropagation();
        const origins = liveOriginsNow.map((o) => ({ nodeId: o.nodeId, box: { ...o.box } }));
        const soleId = origins.length === 1 ? origins[0].nodeId : '';
        dragRef.current = seed('move', e, p, {
          origins,
          union: { ...liveUnionNow },
          textWasSelectedOnDown:
            Boolean(soleId) && sceneDoc?.deltaSetLike?.[soleId]?.key === 'text',
        });
        setLiveOrigins(origins);
        setLiveUnion(liveUnionNow);
        // Defer transforming until onMove passes travel gate — click-in-AABB
        // must keep chrome/toolbars visible (missed pointerup used to stick hide).
        capture(e.pointerId);
        return true;
      };

      const pointInLiveUnion =
        liveUnionNow && pointInOrientedBox(p, liveUnionNow, liveAngleNow || 0);
      const selectionHasFrame = Boolean(
        liveOriginsNow?.some((o) => parseFrameSelId(o.nodeId))
      );

      // Ideal hit: QT → permanent stackOrder → first node ink or plate AABB.
      // Frame hits are encoded as __frame__:id (frameSelId).
      let hitRaw = hitTest(p.x, p.y, { clientX: e.clientX, clientY: e.clientY });
      const frameFromHit = hitRaw ? parseFrameSelId(hitRaw) : null;
      let hitId = frameFromHit ? null : hitRaw;
      const frameAtPoint = frameFromHit ?? hitTestFrame?.(p.x, p.y) ?? null;
      const selectedIds = liveOriginsNow?.map((o) => o.nodeId) ?? [];
      // Bbox fallback only outside artboard interior — frame plate owns its blank area.
      if (!hitId && !frameAtPoint && selectedIds.some((id) => parseFrameSelId(id))) {
        hitId = fallbackVisibleNodeHit(sceneDoc, p, listNodeIds(), getNodeBox, lottiePlayheadSec);
      }
      const plateFrameId = hitId ? frameForFullBleedPlate(sceneDoc, hitId) : null;
      // Unified walk already returns the plate when it wins — no secondary resolve.
      const framePlateId = frameFromHit;
      const hitExtras = {
        hitId,
        frameAtPoint,
        framePlateId,
        plateFrameId,
        liveHasHit: hitId ? selectedIds.includes(hitId) : false,
        storeHasHit: hitId
          ? storeNodeIds.includes(hitId) || storeFrameIds.includes(hitId)
          : false,
      };

      const beginFramePlateGesture = (frameId: string) => {
        e.preventDefault();
        e.stopPropagation();

        // Member of an existing multi / mixed selection: move the whole union.
        // Calling onSelectFrame → setActiveFrameId would collapse to one plate.
        const selectionTotal = storeFrameIds.length + storeNodeIds.length;
        if (
          !readOnly &&
          !e.shiftKey &&
          storeFrameIds.includes(frameId) &&
          selectionTotal > 1 &&
          (liveOriginsNow?.length ?? 0) > 0
        ) {
          if (beginMoveSelection()) {
            clickLog('multi-selection-plate-move', { ...hitExtras, frameId });
            return;
          }
        }

        const mode = resolveFramePlateDragMode(sceneDoc, frameId, {
          readOnly,
          canMove: Boolean(onFrameMoveRef.current),
        });
        const box = getFrameBox(sceneDoc, frameId);
        const empty = mode === 'frame_move';
        const onEdge = box ? isPointOnFrameEdge(p, box, zoom) : false;
        // Occupied interior: soft focus only (no handles / no move). Empty or
        // border band still get full chrome. First-click must not force full.
        const chrome: 'soft' | 'full' = empty || onEdge ? 'full' : 'soft';
        onSelectFrame?.(frameId, { chrome });
        // Store clears nodes immediately; live chrome must follow on down —
        // dragRef blocks the store sync effect until pointerup.
        const live = framePlateLiveChrome(frameId, box, chrome);
        setLiveOrigins(live.origins);
        setLiveUnion(live.union);
        setLiveAngle(live.angle);

        if (!box || !empty) {
          dragRef.current = seed('pointing_canvas', e, p, {
            frameId,
            framePlatePick: true,
            framePlateChrome: chrome,
          });
          capture(e.pointerId);
          return;
        }

        dragRef.current = seed('frame_move', e, p, {
          origins: live.origins,
          union: box,
          frameId,
          frameStartX: box.left,
          frameStartY: box.top,
          frameWidth: box.width,
          frameHeight: box.height,
          frameMoveStarted: false,
        });
        capture(e.pointerId);
      };

      // Composer pick: attach node or artboard; never move / never treat frame as blank cancel.
      if (attachPickActive) {
        e.preventDefault();
        e.stopPropagation();
        let frameUnder = plateFrameId || (!hitId ? hitTestFrame?.(p.x, p.y) : null);
        if (!frameUnder && selectionHasFrame && pointInLiveUnion) {
          frameUnder =
            liveOriginsNow
              ?.map((o) => parseFrameSelId(o.nodeId))
              .find((fid): fid is string => Boolean(fid)) || null;
        }
        if (hitId && !plateFrameId) {
          clickLog('attach-pick-node', { ...hitExtras, calledOnSelect: true });
          onSelect(expandSelectionWithGroups(sceneDoc, [hitId]));
        } else if (frameUnder) {
          clickLog('attach-pick-frame', { ...hitExtras, frameUnder, calledOnSelect: false });
          onSelectFrame?.(frameUnder);
        } else {
          clickLog('attach-pick-clear', { ...hitExtras, calledOnSelect: true });
          onSelect([]);
        }
        dragRef.current = seed('blank', e, p, { skipSelectOnUp: true });
        capture(e.pointerId);
        return;
      }

      if (framePlateId) {
        clickLog('frame-plate', { ...hitExtras });
        beginFramePlateGesture(framePlateId);
        return;
      }

      // Full-bleed background plate outside frame match — marquee only.
      if (hitId && plateFrameId) {
        e.preventDefault();
        clickLog('full-bleed-plate', {
          ...hitExtras,
          calledOnSelect: !e.shiftKey && !readOnly,
        });
        if (!e.shiftKey && !readOnly) {
          onSelectFrame?.(null);
          onSelect([]);
        }
        dragRef.current = seed('pointing_canvas', e, p);
        capture(e.pointerId);
        return;
      }

      // Shape under pointer — select (if needed) then move. Never start a marquee on a shape.
      if (hitId) {
        e.preventDefault();
        e.stopPropagation();
        const additive = e.shiftKey;
        const expandedHit = expandSelectionWithGroups(sceneDoc, [hitId]);
        // Store selection drives chrome/toolbar. liveOrigins alone can stay hot after a
        // missed pointerup — skipping onSelect then lets drag work with no chrome.
        const storeHasNode =
          storeNodeIds.includes(hitId) ||
          expandedHit.some((id) => storeNodeIds.includes(id));

        if (readOnly) {
          // Preview / Dev inspect: select only (no move).
          clickLog('hit-readonly-select', {
            ...hitExtras,
            expandedHit,
            calledOnSelect: true,
            storeHasNode,
          });
          onSelect(expandedHit, { additive });
          dragRef.current = seed('blank', e, p);
          capture(e.pointerId);
          return;
        }

        const willCallOnSelect = !storeHasNode || additive;
        if (willCallOnSelect) {
          // Do not open text edit on pointerdown — a single click's up would
          // otherwise count as a second tap and enter edit immediately.
          lastTextClickRef.current = null;
          onSelect(expandedHit, { additive });
        }
        // Shift-add only: wait for pointer-up; don't start a translate.
        if (additive && !storeHasNode) {
          clickLog('hit-shift-add', {
            ...hitExtras,
            expandedHit,
            calledOnSelect: willCallOnSelect,
            storeHasNode,
            dragMode: 'blank',
          });
          dragRef.current = seed('blank', e, p);
          capture(e.pointerId);
          return;
        }

        const { origins, union } = buildMoveOriginsForHit({
          document: sceneDoc,
          hitId,
          selectedIds: storeHasNode ? storeNodeIds : selectedIds,
          expandedHit,
          liveOriginsNow,
          liveUnionNow,
          liveAngleNow,
          getNodeBox,
          fallbackPoint: p,
        });
        if (!origins.length) {
          clickLog('hit-no-origins', {
            ...hitExtras,
            expandedHit,
            calledOnSelect: willCallOnSelect,
            storeHasNode,
          });
          return;
        }

        // Second click of a double-click: do not start a translate.
        if (isRecentNodeDoubleTap(lastNodeTapRef.current, hitId, e)) {
          lastNodeTapRef.current = null;
          clickLog('hit-double-tap', {
            ...hitExtras,
            expandedHit,
            calledOnSelect: willCallOnSelect,
            storeHasNode,
            dragMode: 'blank',
          });
          dragRef.current = seed('blank', e, p);
          capture(e.pointerId);
          return;
        }
        lastNodeTapRef.current = { id: hitId, t: Date.now(), x: e.clientX, y: e.clientY };

        // Keep chrome rotation in sync — transforming flips chromeAngle onto liveAngle.
        if (origins.length === 1 && !parseFrameSelId(origins[0].nodeId)) {
          setLiveAngle(readNodeAngle(sceneDoc, origins[0].nodeId));
        } else if (origins.length > 1) {
          const shared =
            liveAngleNow ||
            getSelectionSharedRotation(
              sceneDoc,
              origins.map((o) => o.nodeId)
            );
          setLiveAngle(shared);
        }
        // Locked layers stay selectable but cannot start a drag.
        if (isSelectionOriginsLocked(sceneDoc, origins)) {
          clickLog('hit-locked', {
            ...hitExtras,
            expandedHit,
            calledOnSelect: willCallOnSelect,
            storeHasNode,
            dragMode: 'blank',
            originIds: origins.map((o) => o.nodeId),
          });
          dragRef.current = seed('blank', e, p);
          capture(e.pointerId);
          return;
        }
        clickLog('hit-move', {
          ...hitExtras,
          expandedHit,
          calledOnSelect: willCallOnSelect,
          storeHasNode,
          dragMode: 'move',
          originIds: origins.map((o) => o.nodeId),
        });
        dragRef.current = seed('move', e, p, {
          origins,
          union,
          textWasSelectedOnDown:
            storeNodeIds.length === 1 &&
            storeNodeIds[0] === hitId &&
            sceneDoc?.deltaSetLike?.[hitId]?.key === 'text',
        });
        setLiveOrigins(origins);
        setLiveUnion(union);
        // Defer transforming until travel gate — see beginMoveSelection.
        capture(e.pointerId);
        return;
      }

      // Shape under pointer — select (if needed) then move. Never start a marquee on a shape.
      e.preventDefault();
      // Sparse path / star ink often misses hit-test inside a large control box.
      // Clicking empty space still inside the selection union should move, not clear.
      const frameOnlySelection =
        selectionHasFrame &&
        Boolean(liveOriginsNow?.length) &&
        liveOriginsNow.every((o) => parseFrameSelId(o.nodeId));
      if (
        !readOnly &&
        pointInLiveUnion &&
        frameOnlySelection &&
        liveOriginsNow?.length === 1 &&
        onFrameMoveRef.current
      ) {
        const frameId = parseFrameSelId(liveOriginsNow[0].nodeId);
        const box = liveUnionNow;
        if (frameId && box) {
          // Occupied artboard/workbench: interior stays soft + marquee, never drag plate.
          if (!frameIsEmpty(sceneDoc, frameId)) {
            clickLog('union-frame-occupied', { ...hitExtras, frameId });
            beginFramePlateGesture(frameId);
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          clickLog('union-frame-move', { ...hitExtras, frameId, dragMode: 'frame_move' });
          const origins = [{ nodeId: frameSelId(frameId), box: { ...box } }];
          dragRef.current = seed('frame_move', e, p, {
            origins,
            union: box,
            frameId,
            frameStartX: box.left,
            frameStartY: box.top,
            frameWidth: box.width,
            frameHeight: box.height,
            frameMoveStarted: true,
          });
          onFrameMoveStartRef.current?.(frameId);
          setLiveOrigins(origins);
          setLiveUnion(box);
          setLiveAngle(0);
          setTransformingNotify(true);
          capture(e.pointerId);
          return;
        }
      }
      // Multi-frame / mixed / nodes-only: unified mode:'move' (geom path already
      // applies `__frame__:` patches). Single empty plate uses frame_move above.
      if (
        !readOnly &&
        pointInLiveUnion &&
        (liveOriginsNow?.length ?? 0) > 0 &&
        !(frameOnlySelection && liveOriginsNow!.length === 1)
      ) {
        const liveNodeIds = liveOriginsNow
          .map((o) => o.nodeId)
          .filter((id) => !parseFrameSelId(id));
        const liveFrameIds = liveOriginsNow
          .map((o) => parseFrameSelId(o.nodeId))
          .filter((id): id is string => Boolean(id));
        // Store drives chrome/toolbar. liveOrigins can stay hot after a missed
        // pointerup while store is empty — move without onSelect = no chrome.
        // Never onSelect(nodes-only) when frames are in the live union — that
        // would drop artboards from the selection mid-gesture.
        const storeCoversLive =
          (liveNodeIds.length === 0 ||
            liveNodeIds.every((id) => storeNodeIds.includes(id))) &&
          (liveFrameIds.length === 0 ||
            liveFrameIds.every((id) => storeFrameIds.includes(id)));
        const resyncedStore =
          !storeCoversLive && liveNodeIds.length > 0 && liveFrameIds.length === 0;
        if (resyncedStore) {
          onSelect(expandSelectionWithGroups(sceneDoc, liveNodeIds));
        }
        if (beginMoveSelection()) {
          clickLog('union-move-selection', {
            ...hitExtras,
            pointInLiveUnion: true,
            dragMode: 'move',
            calledOnSelect: resyncedStore,
            liveNodeIds,
            liveFrameIds,
          });
          return;
        }
      }
      if (!hitId && frameAtPoint) {
        clickLog('blank-frame-at-point', { ...hitExtras });
        beginFramePlateGesture(frameAtPoint);
        return;
      }
      if (!e.shiftKey) {
        const pin = imageToolSessionNodeIdRef.current;
        if (
          !isImageToolSessionPinned(pin, liveOriginsNow, selectedIds, storeNodeIds)
        ) {
          clickLog('blank-clear', {
            ...hitExtras,
            calledOnSelect: true,
            pointInLiveUnion: Boolean(pointInLiveUnion),
          });
          onSelectFrame?.(null);
          onSelect([]);
        } else {
          clickLog('blank-pinned', { ...hitExtras, pin });
        }
      } else {
        clickLog('blank-marquee-shift', { ...hitExtras });
      }
      dragRef.current = seed('pointing_canvas', e, p);
      capture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (window.document.documentElement.hasAttribute('data-lottie-scrubbing')) {
        if (dragRef.current) {
          dragRef.current = null;
          setTransformingNotify(false);
          clearSelectionChromeCursor(hitEl);
        }
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const {
        sceneDoc,
        toScene,
        zoom,
        gridSize,
        readOnly,
        getNodeBox,
        listNodeIds,
        queryNodeIdsInRect: queryIdsInRect,
      } = getPointerCtx();
      drag.currentClientX = e.clientX;
      drag.currentClientY = e.clientY;
      drag.currentShift = e.shiftKey;
      const screenDistSq = screenDragDistSq(drag, e.clientX, e.clientY);
      if (drag.mode === 'blank') {
        // Abandon soft click once past drag threshold (— CSS px).
        if (screenDistSq >= DRAG_DISTANCE_SQUARED) {
          dragRef.current = null;
        }
        return;
      }
      // PointingCanvas — Brushing after dual screen-px gate.
      if (drag.mode === 'pointing_canvas') {
        if (readOnly) return;
        const { passed, box } = evaluateBrushGate(
          drag,
          zoom,
          e.clientX,
          e.clientY,
          e.pointerType || 'mouse'
        );
        if (!passed) return;
        drag.mode = 'marquee';
        queuePreview({ marquee: box });
        return;
      }
      // Client-delta keeps the selection under the pointer when the stage rect
      // shifts (mobile chrome / small-viewport reflow). Rotate still needs an
      // absolute scene point for atan2 around the pivot.
      const gesture = sceneFromClientGesture(drag, zoom, e.clientX, e.clientY);
      const dx = gesture.dx;
      const dy = gesture.dy;
      const abs = toScene(e.clientX, e.clientY);
      const p =
        drag.mode === 'rotate' ? abs : { x: gesture.x, y: gesture.y };

      if (drag.mode === 'marquee') {
        queuePreview({ marquee: normalizeBox(drag.sceneX0, drag.sceneY0, p.x, p.y) });
        return;
      }

      if (drag.mode === 'frame_move' && drag.frameId) {
        if (readOnly) return;
        if (!drag.frameMoveStarted) {
          if (screenDistSq < DRAG_DISTANCE_SQUARED) return;
          drag.frameMoveStarted = true;
          onFrameMoveStartRef.current?.(drag.frameId);
          // Same as shape move — hide selection chrome while the plate is dragged.
          setTransformingNotify(true);
        }
        const { dx: cdx, dy: cdy } = shiftConstrainedMoveDelta(drag, dx, dy, e.shiftKey);
        const box = {
          left: Math.round((drag.frameStartX ?? 0) + cdx),
          top: Math.round((drag.frameStartY ?? 0) + cdy),
          width: drag.frameWidth ?? drag.union.width,
          height: drag.frameHeight ?? drag.union.height,
        };
        const origins = [{ nodeId: frameSelId(drag.frameId), box }];
        queuePreview({
          union: box,
          origins,
          frameMove: {
            frameId: drag.frameId,
            left: box.left,
            top: box.top,
            opts: {
              skipGrid: e.ctrlKey || e.metaKey,
              axisLock: drag.moveAxisLock,
            },
          },
        });
        return;
      }

      if (drag.mode === 'rotate' && drag.center && drag.pointerAngle0 != null) {
        // Soft-click on rotate knob — ignore OS pointer jitter.
        if (screenDistSq < DRAG_DISTANCE_SQUARED) return;
        const { next, delta } = computeRotateDelta(drag, p, e.shiftKey);
        if (drag.origins.length === 1) {
          queuePreview({
            angle: next,
            clearGuides: true,
            angles: [{ nodeId: drag.origins[0].nodeId, angle: next }],
          });
          return;
        }
        const moved = rotateBoxesAround(
          drag.origins.map((o) => o.box),
          drag.center,
          delta
        );
        const nextOrigins = drag.origins.map((o, i) => ({
          nodeId: o.nodeId,
          box: moved[i],
          angle0: o.angle0,
        }));
        // Keep oriented control box (do not expand to AABB of orbited members).
        queuePreview({
          angle: next,
          clearGuides: true,
          origins: nextOrigins.map((o) => ({ nodeId: o.nodeId, box: o.box })),
          union: drag.union,
          geom: nextOrigins.map((o) => ({
            nodeId: o.nodeId,
            left: o.box.left,
            top: o.box.top,
            width: o.box.width,
            height: o.box.height,
          })),
          angles: nextOrigins.map((o) => ({
            nodeId: o.nodeId,
            angle: Number(o.angle0 || 0) + delta,
          })),
        });
        return;
      }

      if (drag.mode === 'move') {
        // Hide chrome only after real travel (same gate as resize soft-click).
        if (!transformingRef.current && screenDistSq >= DRAG_DISTANCE_SQUARED) {
          setTransformingNotify(true);
        }
        // Follow the pointer immediately — only grid may quantize (no travel gate).
        const { dx: cdx, dy: cdy } = shiftConstrainedMoveDelta(drag, dx, dy, e.shiftKey);
        const exclude = new Set(drag.origins.map((o) => o.nodeId));
        const threshold = smartSnapThreshold(zoom);
        const skipWorkbenchSnap = shouldSkipSmartGuidesForAnimationWorkbenchDrag(
          sceneDoc,
          drag.origins.map((o) => o.nodeId)
        );
        const { nextUnion, sdx, sdy, guides } = computeMovedUnion({
          union: drag.union,
          origins: drag.origins,
          document: sceneDoc,
          dx: cdx,
          dy: cdy,
          disableSnap: e.ctrlKey || e.metaKey || skipWorkbenchSnap,
          gridSize,
          axisLock: drag.moveAxisLock,
          targets: skipWorkbenchSnap
            ? []
            : smartGuideTargetsForDrag({
                document: sceneDoc,
                listNodeIds,
                getNodeBox,
                excludeIds: exclude,
                nearBox: {
                  ...drag.union,
                  left: drag.union.left + cdx,
                  top: drag.union.top + cdy,
                },
                threshold,
                queryNodeIdsInRect: queryIdsInRect,
              }),
          threshold,
        });
        const nextOrigins = drag.origins.map((o) => ({
          nodeId: o.nodeId,
          box: { ...o.box, left: o.box.left + sdx, top: o.box.top + sdy },
        }));
        queuePreview({
          union: nextUnion,
          origins: nextOrigins,
          guides,
          geom: nextOrigins.map((o) => ({
            nodeId: o.nodeId,
            left: o.box.left,
            top: o.box.top,
            width: o.box.width,
            height: o.box.height,
          })),
        });
        return;
      }

      if (drag.mode === 'resize' && drag.handle) {
        // Soft-click on a handle must not resize: at 3% zoom, 2px jitter — 60+
        // scene units and snap threshold is huge (8/zoom), so the box jumps.
        if (screenDistSq < DRAG_DISTANCE_SQUARED) return;
        const stroke = strokeEndpointBox(drag, sceneDoc, p.x, p.y, e.shiftKey);
        if (stroke) {
          // Box + angle in one geom patch — do not queue a separate angles batch
          // (that would rotate the previous shaft about its center → both ends move).
          queuePreview({
            union: stroke.next,
            origins: [{ nodeId: stroke.strokeId, box: stroke.next }],
            angle: stroke.angle,
            clearGuides: true,
            geom: [
              {
                nodeId: stroke.strokeId,
                left: stroke.next.left,
                top: stroke.next.top,
                width: stroke.next.width,
                height: stroke.next.height,
                angle: stroke.angle,
              },
            ],
            angles: [],
          });
          return;
        }
        const exclude = new Set(drag.origins.map((o) => o.nodeId));
        const threshold = smartSnapThreshold(zoom);
        const { next, textMode, guides } = computeResizedUnion({
          document: sceneDoc,
          drag,
          dx,
          dy,
          shiftKey: e.shiftKey,
          disableSnap: e.ctrlKey || e.metaKey,
          gridSize,
          targets: smartGuideTargetsForDrag({
            document: sceneDoc,
            listNodeIds,
            getNodeBox,
            excludeIds: exclude,
            nearBox: resizeDragNearBox(drag, dx, dy),
            threshold,
            queryNodeIdsInRect: queryIdsInRect,
          }),
          threshold,
        });
        if (drag.origins.length === 1) {
          queuePreview({
            union: next,
            origins: [{ nodeId: drag.origins[0].nodeId, box: next }],
            guides,
            geom: [
              {
                nodeId: drag.origins[0].nodeId,
                left: next.left,
                top: next.top,
                width: next.width,
                height: next.height,
              },
            ],
            geomOpts: textMode ? { textResizeMode: textMode } : undefined,
          });
          return;
        }
        const scaled = scaleBoxesToOrientedUnion(
          drag.origins.map((o) => o.box),
          drag.union,
          next,
          drag.angle0 || 0
        );
        const nextOrigins = drag.origins.map((o, i) => ({
          nodeId: o.nodeId,
          box: scaled[i],
        }));
        queuePreview({
          union: next,
          origins: nextOrigins,
          guides,
          geom: nextOrigins.map((o) => ({
            nodeId: o.nodeId,
            left: o.box.left,
            top: o.box.top,
            width: o.box.width,
            height: o.box.height,
          })),
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      // Drop pending rAF preview — pointerup recomputes and commits final geom.
      previewCoalesce.cancel();
      // Always clear the brush — even if the gesture ref was lost mid-flight
      // (effect remount used to drop pointerup and leave the box stuck).
      setMarquee(null);
      if (!drag) {
        // dragRef lost but transforming may still hide chrome/toolbars.
        if (transformingRef.current) setTransformingNotify(false);
        return;
      }
      dragRef.current = null;
      clearSelectionChromeCursor(hitEl);
      const {
        sceneDoc,
        toScene,
        zoom,
        gridSize,
        readOnly,
        attachPickActive,
        hitTest,
        hitTestFrame,
        getNodeBox,
        listNodeIds,
        queryNodeIdsInRect: queryIdsInRect,
        onSelect,
        onSelectFrame,
        onSelectMixed,
        onSelectFrames,
        onGeometryCommit,
        onAngleCommit,
        onAnglePreview: anglePreview,
      } = getPointerCtx();
      try {
        hitEl.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }

      // End events are lifecycle-only; geometry uses last down/move client point.
      const clientX = drag.currentClientX;
      const clientY = drag.currentClientY;
      const shiftKey = drag.currentShift ?? e.shiftKey;
      const gesture = sceneFromClientGesture(drag, zoom, clientX, clientY);
      const dx = gesture.dx;
      const dy = gesture.dy;
      const absEnd = toScene(clientX, clientY);
      // Move / resize / marquee: client-delta (stable if stage rect jitters).
      // Rotate: absolute scene point for atan2 around the pivot.
      let p = absEnd;
      if (drag.mode === 'move' || drag.mode === 'resize' || drag.mode === 'marquee') {
        p = { x: gesture.x, y: gesture.y };
      }
      const screenDistSq = screenDragDistSq(drag, clientX, clientY);

      const endTransform = () => setTransformingNotify(false);

      if (drag.mode === 'frame_move') {
        if (drag.frameMoveStarted) onFrameMoveEndRef.current?.();
        // Keep last previewed plate box — getFrameBox(sceneDoc) is still pre-commit
        // and would snap chrome back (looks like the box "overshoots" then jumps).
        const box = liveUnionRef.current;
        if (box && drag.frameId) {
          setLiveUnion(box);
          setLiveOrigins([{ nodeId: frameSelId(drag.frameId), box }]);
        }
        endTransform();
        return;
      }

      // Soft click on empty stage (never entered Brushing).
      if (drag.mode === 'pointing_canvas') {
        setMarquee(null);
        lastTextClickRef.current = null;
        const pin = imageToolSessionNodeIdRef.current;
        const platePick = Boolean(drag.framePlatePick && drag.frameId);
        const frameHit =
          screenDistSq < DRAG_DISTANCE_SQUARED
            ? hitTestFrame?.(p.x, p.y) ?? null
            : null;
        // Re-pick on up: thin pen/line hits can miss on down (stale spatial /
        // promote race) then succeed a frame later — same point, no drag.
        const rawUpHit =
          !platePick && screenDistSq < DRAG_DISTANCE_SQUARED
            ? hitTest(p.x, p.y, { clientX, clientY })
            : null;
        const frameFromUp = rawUpHit ? parseFrameSelId(rawUpHit) : null;
        const nodeHit = frameFromUp ? null : rawUpHit;
        if (pin) {
          handlePinnedImageToolBlankClick(pin);
        } else if (nodeHit) {
          onSelect(expandSelectionWithGroups(sceneDoc, [nodeHit]), {
            additive: shiftKey,
          });
        } else if (platePick && drag.frameId) {
          const chrome = drag.framePlateChrome === 'full' ? 'full' : 'soft';
          onSelectFrame?.(drag.frameId, { chrome });
          // Same as pointerdown: re-apply live chrome when store deps are unchanged
          // (selection already applied on down → effect would not re-run).
          const box = getFrameBox(sceneDoc, drag.frameId);
          const live = framePlateLiveChrome(drag.frameId, box, chrome);
          setLiveOrigins(live.origins);
          setLiveUnion(live.union);
          setLiveAngle(live.angle);
        } else if (frameFromUp || frameHit) {
          onSelectFrame?.(frameFromUp || frameHit, { chrome: 'soft' });
          setLiveOrigins([]);
          setLiveUnion(null);
          setLiveAngle(0);
        } else {
          onSelectFrame?.(null);
          onSelect([]);
          setLiveOrigins([]);
          setLiveUnion(null);
          setLiveAngle(0);
        }
        endTransform();
        return;
      }

      if (drag.mode === 'marquee') {
        setMarquee(null);
        lastTextClickRef.current = null;
        const { passed, box } = evaluateBrushGate(
          drag,
          zoom,
          clientX,
          clientY,
          e.pointerType || 'mouse'
        );
        // Still under brush gate — treat as an empty click, not an artboard pick.
        if (!passed) {
          const pin = imageToolSessionNodeIdRef.current;
          if (pin) {
            handlePinnedImageToolBlankClick(pin);
          } else {
            onSelectFrame?.(null);
            onSelect([]);
          }
          endTransform();
          return;
        }
        // Pad spatial prefilter the same as fine hit — tiny nodes near the brush edge.
        const queryPad = marqueeHitPadScene(zoom) + MARQUEE_MIN_HIT_SCREEN_PX / Math.max(0.05, zoom);
        const queryBox = expandSceneBox(box, queryPad);
        const candidates = queryIdsInRect?.(queryBox) ?? [];
        const rawHits = candidates.filter((id) =>
          nodeHitsMarquee(sceneDoc, id, box, getNodeBox, toScene, zoom)
        );
        // Intersecting plates for content filter; commit uses crossing when the
        // brush only hits boards, enclosure when content is also selected.
        const intersectingFrameIds = framesHittingMarquee(sceneDoc, box).map((f) => f.id);
        const contentHits = filterMarqueeContentHits(
          sceneDoc,
          rawHits,
          new Set(intersectingFrameIds),
          box
        );
        const frameHits = resolveMarqueeFrameHits(sceneDoc, box, contentHits.length);
        commitMarqueeSelection({
          contentHits,
          frameHits,
          rawHits,
          shiftKey,
          onSelectMixed,
          onSelectFrames,
          onSelectFrame,
          onSelect,
        });
        endTransform();
        return;
      }

      if (drag.mode === 'blank') {
        // Attach-pick already applied on pointerdown — do not onSelect on up
        // (one-shot clearPick flips attachPickActive off before up; selecting
        // here would steal focus from the host node / double-add chips).
        if (
          !drag.skipSelectOnUp &&
          !attachPickActive &&
          screenDistSq < DRAG_DISTANCE_SQUARED
        ) {
          const pin = imageToolSessionNodeIdRef.current;
          if (pin) {
            handlePinnedImageToolBlankClick(pin);
            endTransform();
            return;
          }
          const id = hitTest(p.x, p.y, { clientX, clientY });
          if (id && tryOpenTextEdit(id, false)) {
            endTransform();
            return;
          }
          if (id) onSelect([id], { additive: shiftKey });
        }
        endTransform();
        return;
      }

      if (drag.mode === 'rotate' && drag.center && drag.pointerAngle0 != null) {
        // Soft-click: restore start pose — do not apply angle jitter.
        if (screenDistSq < DRAG_DISTANCE_SQUARED) {
          setLiveAngle(drag.angle0 || 0);
          setLiveUnion({ ...drag.union });
          setLiveOrigins(drag.origins.map((o) => ({ nodeId: o.nodeId, box: { ...o.box } })));
          endTransform();
          return;
        }
        const { next, delta } = computeRotateDelta(drag, p, shiftKey);
        setLiveAngle(next);
        if (drag.origins.length === 1) {
          onAngleCommit?.(drag.origins[0].nodeId, next);
          endTransform();
          return;
        }
        const moved = rotateBoxesAround(
          drag.origins.map((o) => o.box),
          drag.center,
          delta
        );
        const patches = drag.origins.map((o, i) => ({
          nodeId: o.nodeId,
          left: moved[i].left,
          top: moved[i].top,
          width: moved[i].width,
          height: moved[i].height,
        }));
        const origins = patchesAsOrigins(patches);
        setLiveUnion(drag.union);
        setLiveAngle(next);
        setLiveOrigins(origins);
        holdMultiChrome(drag.union, next, origins);
        if (Math.abs(delta) > 0.01) {
          // Angles first so geometry commit's document snapshot already carries them.
          drag.origins.forEach((o) => {
            onAngleCommit?.(o.nodeId, Number(o.angle0 || 0) + delta, { skipHistory: true });
          });
          onGeometryCommit(patches);
        }
        endTransform();
        return;
      }

      if (drag.mode === 'move') {
        // Pure click (no pointer travel): restore + maybe text edit. Any travel commits.
        if (isMotionlessClick(screenDistSq)) {
          const pin = imageToolSessionNodeIdRef.current;
          const panel = (store.getState() as { editor?: { imageToolPanel?: ImageToolPanelState | null } })
            .editor?.imageToolPanel;
          if (pin && panel?.kind === 'mark' && panel.nodeId === pin) {
            handlePinnedImageToolBlankClick(pin);
            endTransform();
            return;
          }
          setLiveUnion({ ...drag.union });
          setLiveOrigins(drag.origins.map((o) => ({ nodeId: o.nodeId, box: { ...o.box } })));
          if (
            drag.origins.length === 1 &&
            tryOpenTextEdit(drag.origins[0].nodeId, Boolean(drag.textWasSelectedOnDown))
          ) {
            endTransform();
            return;
          }
          endTransform();
          return;
        }
        const exclude = new Set(drag.origins.map((o) => o.nodeId));
        const threshold = smartSnapThreshold(zoom);
        const { dx: cdx, dy: cdy } = shiftConstrainedMoveDelta(drag, dx, dy, shiftKey);
        const { nextUnion, sdx, sdy } = computeMovedUnion({
          union: drag.union,
          origins: drag.origins,
          document: sceneDoc,
          dx: cdx,
          dy: cdy,
          disableSnap: e.ctrlKey || e.metaKey,
          gridSize,
          axisLock: drag.moveAxisLock,
          targets: smartGuideTargetsForDrag({
            document: sceneDoc,
            listNodeIds,
            getNodeBox,
            excludeIds: exclude,
            nearBox: {
              ...drag.union,
              left: drag.union.left + cdx,
              top: drag.union.top + cdy,
            },
            threshold,
            queryNodeIdsInRect: queryIdsInRect,
          }),
          threshold,
        });
        const patches = drag.origins.map((o) => ({
          nodeId: o.nodeId,
          left: o.box.left + sdx,
          top: o.box.top + sdy,
          width: o.box.width,
          height: o.box.height,
        }));
        const origins = patchesAsOrigins(patches);
        setLiveUnion(nextUnion);
        setLiveOrigins(origins);
        holdMultiChrome(nextUnion, liveAngleRef.current, origins);
        if (Math.hypot(sdx, sdy) > 0.01) {
          lastTextClickRef.current = null;
          onGeometryCommit(patches);
        }
        endTransform();
        return;
      }

      if (drag.mode === 'resize' && drag.handle) {
        if (screenDistSq < DRAG_DISTANCE_SQUARED) {
          setLiveUnion({ ...drag.union });
          setLiveOrigins(drag.origins.map((o) => ({ nodeId: o.nodeId, box: { ...o.box } })));
          endTransform();
          return;
        }
        const stroke = strokeEndpointBox(drag, sceneDoc, p.x, p.y, shiftKey);
        if (stroke) {
          setLiveUnion(stroke.next);
          setLiveOrigins([{ nodeId: stroke.strokeId, box: stroke.next }]);
          setLiveAngle(stroke.angle);
          lastTextClickRef.current = null;
          // Bake angle into documentRef first so geometry rebuild reads attrs.angle;
          // one history entry via onGeometryCommit (do not patch angle into the editor store first).
          anglePreview?.(stroke.strokeId, stroke.angle);
          onGeometryCommit([
            {
              nodeId: stroke.strokeId,
              left: stroke.next.left,
              top: stroke.next.top,
              width: stroke.next.width,
              height: stroke.next.height,
            },
          ]);
          endTransform();
          return;
        }
        const excludeUp = new Set(drag.origins.map((o) => o.nodeId));
        const thresholdUp = smartSnapThreshold(zoom);
        const { next, textMode } = computeResizedUnion({
          document: sceneDoc,
          drag,
          dx,
          dy,
          shiftKey,
          disableSnap: e.ctrlKey || e.metaKey,
          gridSize,
          targets: smartGuideTargetsForDrag({
            document: sceneDoc,
            listNodeIds,
            getNodeBox,
            excludeIds: excludeUp,
            nearBox: resizeDragNearBox(drag, dx, dy),
            threshold: thresholdUp,
            queryNodeIdsInRect: queryIdsInRect,
          }),
          threshold: thresholdUp,
        });
        if (drag.origins.length === 1) {
          setLiveUnion(next);
          setLiveOrigins([{ nodeId: drag.origins[0].nodeId, box: next }]);
          onGeometryCommit(
            [
              {
                nodeId: drag.origins[0].nodeId,
                left: next.left,
                top: next.top,
                width: next.width,
                height: next.height,
              },
            ],
            textMode ? { textResizeMode: textMode } : undefined
          );
          endTransform();
          return;
        }
        const scaled = scaleBoxesToOrientedUnion(
          drag.origins.map((o) => o.box),
          drag.union,
          next,
          drag.angle0 || 0
        );
        const patches = drag.origins.map((o, i) => ({
          nodeId: o.nodeId,
          left: scaled[i].left,
          top: scaled[i].top,
          width: scaled[i].width,
          height: scaled[i].height,
        }));
        const groupAngle = drag.angle0 || 0;
        const origins = patchesAsOrigins(patches);
        setLiveUnion(next);
        setLiveAngle(groupAngle);
        setLiveOrigins(origins);
        holdMultiChrome(next, groupAngle, origins);
        onGeometryCommit(patches);
      }
      endTransform();
    };

    const onDblClick = (e: MouseEvent) => {
      const {
        sceneDoc,
        toScene,
        readOnly,
        hitTest,
        onSelect,
        onEditText,
        onEditPenPath,
      } = getPointerCtx();
      if (readOnly) return;
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[data-sel-toolbar],[data-frame-toolbar],[data-text-inline-editor]')) {
        return;
      }
      const p = toScene(e.clientX, e.clientY);
      const overlayPick = pickOverlayHandleAtClient(e.clientX, e.clientY, e.target, p);
      if (overlayPick && tryOverlayHandleDoubleClick(overlayPick, e)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      let hit = hitTest(p.x, p.y, { clientX: e.clientX, clientY: e.clientY });
      // Selection chrome covers the glyph — fall back to the single selected node.
      if (!hit && target?.closest?.('[data-sel-box]')) {
        const ids = liveOriginsRef.current?.map((o) => o.nodeId) || [];
        if (ids.length === 1) hit = ids[0];
      }
      if (!hit || parseFrameSelId(hit)) return;
      const node = sceneDoc?.deltaSetLike?.[hit];
      if (node?.key === 'text') {
        e.preventDefault();
        e.stopPropagation();
        lastTextClickRef.current = null;
        onSelect([hit]);
        onEditText?.(hit);
        return;
      }
      if (isEditablePathNode(node)) {
        e.preventDefault();
        e.stopPropagation();
        lastNodeTapRef.current = null;
        onSelect([hit]);
        onEditPenPath?.(hit);
      }
    };

    // Single stage capture entry (ADR 0027). Overlay is usually under hitEl
    // ([data-rcb-canvas]); only attach a second listener when it is not.
    hitEl.addEventListener('pointerdown', onDown, true);
    const overlayNeedsOwn =
      Boolean(overlayRoot) && overlayRoot !== hitEl && !hitEl.contains(overlayRoot!);
    if (overlayNeedsOwn) {
      overlayRoot!.addEventListener('pointerdown', onDown, true);
    }
    const onWindowPaintChromeDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const node = e.target as Node | null;
      if (node && hitEl.contains(node)) return;
      if (node && overlayRoot?.contains(node)) return;
      const el = e.target as HTMLElement | null;
      if (
        el?.closest?.(
          'input,textarea,button,a,select,[role="button"],[contenteditable="true"],[data-agent-dock],[data-agent-composer],[data-lottie-inspector],[data-lottie-timeline-dock],[data-lottie-kf-popover]'
        )
      ) {
        return;
      }
      const pickOpts = chromePickOptsRef.current;
      if (pickOpts.suppressChrome || !pickOpts.showHandles) return;
      const liveUnion = liveUnionRef.current;
      const liveOrigins = liveOriginsRef.current;
      if (!liveUnion || !liveOrigins?.length) return;
      const painted = resolvePaintedControlChrome(
        documentRef.current,
        liveOrigins,
        liveUnion,
        liveAngleRef.current || 0
      );
      if (
        !pickSelectionInkAtClient(e.clientX, e.clientY, e.target, {
          ...pickOpts,
          box: painted.box,
          angle: painted.angle,
        })
      ) {
        return;
      }
      onDown(e);
    };
    window.addEventListener('pointerdown', onWindowPaintChromeDown, true);
    hitEl.addEventListener('dblclick', onDblClick);
    if (overlayNeedsOwn) {
      overlayRoot!.addEventListener('dblclick', onDblClick);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      previewCoalesce.cancel();
      clearNodeTransformPreviews();
      hitEl.removeEventListener('pointerdown', onDown, true);
      if (overlayNeedsOwn) {
        overlayRoot!.removeEventListener('pointerdown', onDown, true);
        overlayRoot!.removeEventListener('dblclick', onDblClick);
      }
      window.removeEventListener('pointerdown', onWindowPaintChromeDown, true);
      hitEl.removeEventListener('dblclick', onDblClick);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      dragRef.current = null;
      setMarquee(null);
    };
  }, [enabled, hitEl, overlayRoot]);

  /** Arrow keys nudge selection 1px (Shift = 10px). Grid mode: step = gridSize (Shift = 5?). */
  useEffect(() => {
    if (!enabled || suppressChrome || readOnly) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (dragRef.current) return;
      if (isLottieTimelineUiActive(e.target)) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable ||
          t.closest?.(
            '[data-fill-panel],[data-color-panel],[data-stroke-panel],[data-shape-style-panel],[data-sel-toolbar],[data-frame-toolbar],[data-text-inline-editor],[data-lottie-timeline-dock],[data-lottie-inspector]'
          ))
      ) {
        return;
      }
      const origins = liveOriginsRef.current;
      const union = liveUnionRef.current;
      if (!origins?.length || !union) return;
      if (isSelectionOriginsLocked(document, origins)) return;

      e.preventDefault();
      const step = e.shiftKey ? Math.max(10, gridSize * 10) : Math.max(1, gridSize);
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      // Same visual-outer 1px grid as drag-move (not path half-pixels).
      const { nextUnion, sdx, sdy } = computeMovedUnion({
        union,
        origins,
        document,
        dx,
        dy,
        disableSnap: false,
        gridSize,
        targets: [],
        threshold: 0,
      });
      const nextOrigins = origins.map((o) => ({
        nodeId: o.nodeId,
        box: { ...o.box, left: o.box.left + sdx, top: o.box.top + sdy },
      }));
      setLiveUnion(nextUnion);
      setLiveOrigins(nextOrigins);
      onGeometryCommit(
        nextOrigins.map((o) => ({
          nodeId: o.nodeId,
          left: o.box.left,
          top: o.box.top,
          width: o.box.width,
          height: o.box.height,
        }))
      );
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [
    enabled,
    readOnly,
    suppressChrome,
    document,
    listNodeIds,
    getNodeBox,
    onGeometryCommit,
    queryNodeIdsInRect,
    gridSize,
  ]);

  const singleId = singleNode ? selectedNodeIds[0] : null;
  const singleNodeData = singleId ? document?.deltaSetLike?.[singleId] : null;
  /**
   * Same gate as LayerPanel hide (`isNodeHiddenInDocument`): no control box,
   * path outlines, or toolbars while the layer is hidden (incl. playhead trim).
   */
  const selectionFullyHidden = Boolean(
    selectedNodeIds.length > 0 &&
      selectedNodeIds.every((id) => {
        const n = document?.deltaSetLike?.[id];
        return (
          !n ||
          isNodeHiddenInDocument(
            document,
            n,
            lottiePlayheadSec
          )
        );
      })
  );
  const hideSelectionChrome = suppressChrome || selectionFullyHidden;
  const hideSelectionToolbars =
    effectiveSuppressToolbars || selectionFullyHidden;
  /** Workbench multi-select: canvas MultiSelectionToolbar ? animation inspector. */
  const lottieWorkbenchMulti =
    !single &&
    isAnimationWorkbenchSelection(document, selectedNodeIds, selectedFrameIds);
  const lottieMultiPrimaryId = lottieWorkbenchMulti
    ? selectedNodeIds[selectedNodeIds.length - 1]
    : null;
  const lottieMultiPrimaryData = lottieMultiPrimaryId
    ? document?.deltaSetLike?.[lottieMultiPrimaryId]
    : null;
  const contextToolbarNodeId = singleNode
    ? selectedNodeIds[0]
    : lottieMultiPrimaryId;
  const contextToolbarNodeData = singleNode ? singleNodeData : lottieMultiPrimaryData;
  const selectedIsImageGen = Boolean(singleNodeData && isImageGeneratorNode(singleNodeData));
  const selectedIsVideoGen = Boolean(singleNodeData && isVideoGeneratorNode(singleNodeData));
  const selectedIsLottieGen = Boolean(singleNodeData && isLottieGeneratorNode(singleNodeData));
  const selectedIsAudioGen = Boolean(singleNodeData && isAudioGeneratorNode(singleNodeData));
  const selectedIsVideo = Boolean(singleNodeData && singleNodeData.key === 'video' && !selectedIsVideoGen);
  const selectedIsTextFrame = Boolean(singleNodeData && isTextFrameNode(singleNodeData));
  /** SoftGlow / mockup bake / etc. — hide in-node knobs (radius, sides) while running. */
  const selectedNodeProcessing =
    String(singleNodeData?.attrs?.processStatus || '') === 'running';
  const textFrameTitle = useMemo(() => {
    if (!selectedIsTextFrame || !singleNodeData) return null;
    if (resolveAnimationFrameId(document, singleNodeData)) return null;
    return textFrameTitleChrome({
      name: singleNodeData.attrs?.name,
      plainText: parseNodeText(singleNodeData.attrs || {}),
    });
  }, [selectedIsTextFrame, singleNodeData, document]);
  const lottieTimelineOpen = useSelector((s: any) =>
    Boolean(s.editor.lottieTimelinePanel?.nodeId)
  );
  const mediaTitle = useMemo(() => {
    if (!singleNodeData || selectedIsTextFrame) return null;
    if (isAnimationFrameHostNode(singleNodeData, document)) return null;
    // Workbench children — no media title chrome.
    if (resolveAnimationFrameId(document, singleNodeData)) return null;
    // Free LOT tagged as workbench surround while timeline is open — same as child.
    const surround = String(
      singleNodeData.attrs?.animationWorkbenchSurround || ''
    ).trim();
    if (lottieTimelineOpen && surround) return null;
    return mediaTitleChrome({
      key: singleNodeData.key,
      name: singleNodeData.attrs?.name,
      isImageGen: selectedIsImageGen,
      isVideoGen: selectedIsVideoGen,
      isLottieGen: selectedIsLottieGen,
      isAudioGen: selectedIsAudioGen,
      isVideo: selectedIsVideo,
    });
  }, [
    singleNodeData,
    selectedIsTextFrame,
    selectedIsImageGen,
    selectedIsVideoGen,
    selectedIsLottieGen,
    selectedIsAudioGen,
    selectedIsVideo,
    document,
    lottieTimelineOpen,
  ]);
  const selectedIsMediaGen =
    selectedIsImageGen || selectedIsVideoGen || selectedIsLottieGen || selectedIsAudioGen;
  const singleShapeType = singleNodeData
    ? String(singleNodeData?.attrs?.shapeType || '')
    : '';
  const lineChrome =
    singleNode && (singleShapeType === 'line' || singleShapeType === 'arrow');

  const chromeAngle = resolveChromeAngle({
    enabled,
    singleNode,
    multiSelected: !single,
    selectedNodeId: selectedNodeIds[0],
    document,
    transforming,
    dragMode: dragRef.current?.mode,
    hasPathEndpoints: Boolean(dragRef.current?.pathEpLocal0 && dragRef.current?.pathEpLocal1),
    liveAngle,
  });

  /** Single node or single frame — inspect size badge + hover spacing. */
  const inspectPrimaryId = resolveInspectPrimaryId(selectedNodeIds, selectedFrameIds);

  const measurePairId = resolveMeasurePairNodeId({
    inspectDev,
    transforming,
    hoverNodeId,
    inspectPairNodeId,
    inspectPrimaryId,
    selectedNodeIds,
  });

  const measurePrimaryBox = useMemo(
    () => resolveMeasureBox(inspectPrimaryId, document, getNodeBox),
    [inspectPrimaryId, document, getNodeBox]
  );

  const idleMeasureGuides = useMemo(() => {
    if (!inspectDev || transforming) return [] as SmartGuideLine[];
    const a = resolveClippedMeasureBox(inspectPrimaryId, document, getNodeBox);
    const b = resolveClippedMeasureBox(measurePairId, document, getNodeBox);
    if (!a || !b) return [] as SmartGuideLine[];
    return collectPairSpacingGuides(a, b);
  }, [inspectDev, transforming, inspectPrimaryId, measurePairId, document, getNodeBox]);

  // Artboard movement already has a stable frame boundary. Object guides add
  // extra lines and repaint churn while the frame and its contents translate.
  const displayGuides = guidesForSelection(
    selectedFrameIds,
    transforming,
    smartGuides,
    idleMeasureGuides
  );
  // WxH under the box: inspect/preview only — edit already has the title size label.
  const measureSizeBox =
    inspectDev && inspectPrimaryId && !hideSelectionChrome
      ? transforming && liveUnion
        ? liveUnion
        : measurePrimaryBox
      : null;

  const shapeOutlines = buildShapeOutlines({
    enabled,
    suppressChrome: hideSelectionChrome,
    readOnly,
    document,
    selectedNodeIds,
    selectedFrameIds,
    hoverNodeId,
    inspectDev,
    transforming,
    inspectPrimaryId,
    inspectPairNodeId,
    singleId,
    chromeAngle,
    selectedIsImageGen,
    selectedIsVideoGen,
    selectedIsLottieGen,
    liveOrigins,
    multiUnionBox: !single ? liveUnion || selectionUnion : null,
    multiUnionAngle: !single ? chromeAngle : 0,
    getNodeBox,
    playheadSec: lottiePlayheadSec,
  });

  const hostInjectedSelection = isHostInjectedSelection(
    singleNode,
    singleId,
    shapeOutlines,
    {
      inspectDev,
      node: singleNodeData,
      selectedFrameIds,
      selectedNodeIds,
    }
  );

  const edgeHandles = resolveSelectionEdgeHandles({
    selectedIsImageGen,
    selectedIsVideoGen,
    selectedIsLottieGen,
    selectedIsVideo,
    selectedIsTextFrame,
    lineChrome,
    nodeKey: singleNodeData?.key,
  });

  let strokeOuterScene = 0;
  if (singleNodeData) {
    strokeOuterScene = strokeOuterClearanceScene(singleNodeData);
  } else if (selectedNodeIds.length > 1) {
    for (const id of selectedNodeIds) {
      const n = document?.deltaSetLike?.[id];
      if (n) strokeOuterScene = Math.max(strokeOuterScene, strokeOuterClearanceScene(n));
    }
  }
  // Outside stroke ink (screen px) — applied inside scale(1/zoom) so the pill
  // clears painted stroke at any zoom without scene-space drift.
  const strokeUiPadScreen = Math.max(0, strokeOuterScene) * zoom;

  chromePickOptsRef.current = {
    zoom,
    showHandles: !inspectDev && !readOnly && !selectedIsMediaGen && !transforming,
    /** Same as showHandles but ignores transforming — pointerdown clears stuck transforms. */
    allowHandlePick: !inspectDev && !readOnly && !selectedIsMediaGen,
    showRotate:
      !inspectDev &&
      !readOnly &&
      !lineChrome &&
      !selectedIsMediaGen &&
      !selectedIsTextFrame &&
      !transforming &&
      selectedNodeIds.length >= 1 &&
      selectedFrameIds.length === 0,
    lineMode: Boolean(lineChrome),
    cornerHandlesOnly: !single,
    edgeHandles,
    suppressChrome: hideSelectionChrome,
    strokeOuterScene,
    clientToScene: (clientX, clientY) => toScene(clientX, clientY),
  };

  const chromeUnion = resolveChromeUnion({
    transforming,
    liveUnion,
    selectionUnion,
    selectedNodeIds,
    selectedFrameIds,
    document,
    multiGroupAngle: !single ? chromeAngle : 0,
  });

  /** Radius / ellipse knobs sit on path geom (host-local), not visual-outer chrome. */
  const chromeGeomBox =
    chromeUnion && singleNodeData
      ? deflateSelectionBox(chromeUnion, singleNodeData)
      : chromeUnion;
  // Path control chrome follows the path geometry itself. Stroke expansion is
  // used for spacing/toolbar clearance, never as the control-box position.
  const selectionChromeBox =
    hostInjectedSelection && !lineChrome ? chromeGeomBox || chromeUnion : chromeUnion;
  const hideMultiMoveChrome =
    !single && transforming && dragRef.current?.mode === 'move';

  const hoverImageVariantsId = resolveHoverImageVariantsId({
    inspectDev,
    transforming,
    suppressToolbars,
    hoverNodeId,
    selectedNodeIds,
    document,
    pinnedExpandedNodeId: imageVariantsExpandedId,
  });
  const hoverImageVariantsBox = useMemo(() => {
    if (!hoverImageVariantsId) return null;
    const node = document?.deltaSetLike?.[hoverImageVariantsId];
    const live = liveShapeGeomBox(hoverImageVariantsId);
    if (live && node) return inflateSelectionBox(live, node);
    return getNodeBox(hoverImageVariantsId);
  }, [hoverImageVariantsId, document, getNodeBox]);

  // Marquee only — path multi-select uses host silhouettes + world union box.
  // Vector ink uses host path chrome; non-path uses SelectionChrome (handles / box).

  if (!enabled) return null;

  // HostPathChrome owns the precise open-stroke endpoints for lines/arrows.
  // Other path shapes use the shared SelectionChrome for their box/handles.
  const skipWorldSelectionChrome = hostInjectedSelection && lineChrome;
  const showWorldSelectionChrome =
    Boolean(selectionChromeBox) &&
    !hideSelectionChrome &&
    selectionCount > 0 &&
    !skipWorldSelectionChrome &&
    !hideMultiMoveChrome &&
    (!transforming || !single);

  const shapeKnobBox = chromeGeomBox || chromeUnion;
  const canEditShapeKnobs =
    !inspectDev &&
    !readOnly &&
    !transforming &&
    Boolean(shapeKnobBox) &&
    Boolean(singleNode && singleId && singleNodeData) &&
    !lineChrome &&
    !hideSelectionChrome &&
    !selectedIsImageGen &&
    !selectedNodeProcessing;

  const showCornerRadiusKnobs =
    canEditShapeKnobs &&
    Boolean(singleNodeData) &&
    supportsCornerRadius(singleNodeData!) &&
    !supportsShapeSides(singleNodeData!);
  const showCircleKnobs =
    canEditShapeKnobs && Boolean(singleNodeData) && isEllipseLikeNode(singleNodeData!);
  const showPolygonKnobs = canEditShapeKnobs && singleShapeType === 'polygon';
  const showStarKnobs = canEditShapeKnobs && singleShapeType === 'star';

  const showContextToolbar =
    !inspectDev &&
    Boolean(chromeUnion) &&
    Boolean(contextToolbarNodeId && contextToolbarNodeData) &&
    !transforming &&
    !hideSelectionToolbars &&
    !selectedNodeProcessing;

  const nodeTitleChrome = textFrameTitle || mediaTitle;
  const showNodeTitle =
    !inspectDev &&
    Boolean(chromeUnion) &&
    Boolean(singleNode && singleId) &&
    !transforming &&
    !hideSelectionToolbars &&
    isTitledMediaNode(singleNodeData, selectedIsTextFrame) &&
    Boolean(nodeTitleChrome);

  const showSelectedImageVariants =
    !inspectDev &&
    Boolean(chromeUnion || liveUnion) &&
    Boolean(singleNode && singleId && singleNodeData) &&
    !transforming &&
    !hideSelectionToolbars &&
    singleNodeData?.key === 'image' &&
    listImageVariantUrls(singleNodeData).length > 1 &&
    !selectedNodeProcessing;

  const showHoverImageVariants =
    !inspectDev &&
    Boolean(hoverImageVariantsId && hoverImageVariantsBox) &&
    !transforming &&
    !hideSelectionToolbars;

  const showMultiToolbar =
    !inspectDev &&
    Boolean(chromeUnion) &&
    !single &&
    selectedNodeIds.length >= 1 &&
    // Artboard / 动画 multi uses FrameMultiSelectionToolbar; avoid an empty
    // node-style pill when frame co-selection strips style chrome.
    selectedFrameIds.length === 0 &&
    !transforming &&
    !hideSelectionToolbars &&
    !isAnimationWorkbenchSelection(document, selectedNodeIds, selectedFrameIds);

  const chromeAnchor = selectionAnchorPercents(singleNodeData);
  const chromeSkew = selectionSkewProps(singleNodeData);
  const showChromeHandles =
    !inspectDev && !readOnly && !selectedIsMediaGen && !transforming;
  const showChromeRotate =
    showChromeHandles &&
    !lineChrome &&
    !selectedIsTextFrame &&
    selectedNodeIds.length >= 1 &&
    selectedFrameIds.length === 0;

  return (
    <>
      <ShapeOutlineSvg outlines={shapeOutlines} />
      <BrushOverlay box={marquee} />
      <SmartGuidesOverlay
        guides={displayGuides}
        sizeBox={measureSizeBox}
      />

      {/* World SelectionChrome — path single/multi use host-mirrored chrome instead.
          Multi non-path keeps chrome while rotating so the control box can tilt.
          Frames use the same hide-while-transforming rule as single shapes. */}
      {showWorldSelectionChrome ? (
        <SelectionChrome
          box={selectionChromeBox!}
          angle={chromeAngle}
          showHandles={showChromeHandles}
          cornerHandlesOnly={!single}
          variant={lineChrome ? 'line' : 'box'}
          showRotate={showChromeRotate}
          showBoxStroke={!lineChrome}
          interactiveBox={frameChromeMode === 'full' && selectedFrameIds.length > 0}
          edgeHandles={edgeHandles}
          strokeOuterScene={strokeOuterScene}
          anchorX={chromeAnchor.anchorX}
          anchorY={chromeAnchor.anchorY}
          skewX={chromeSkew.skewX}
          skewAxis={chromeSkew.skewAxis}
        />
      ) : null}

      {showCornerRadiusKnobs ? (
        <CornerRadiusHandlesOverlay
          box={shapeKnobBox!}
          angle={chromeAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
          stageEl={hitEl}
          interactive
        />
      ) : null}

      {showCircleKnobs ? (
        <CircleShapeHandlesOverlay
          box={shapeKnobBox!}
          angle={chromeAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
          stageEl={hitEl}
          interactive
        />
      ) : null}

      {showPolygonKnobs ? (
        <PolygonShapeHandlesOverlay
          box={shapeKnobBox!}
          angle={chromeAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
          stageEl={hitEl}
          interactive
        />
      ) : null}

      {showStarKnobs ? (
        <StarShapeHandlesOverlay
          box={shapeKnobBox!}
          angle={chromeAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
          stageEl={hitEl}
          interactive
        />
      ) : null}

      {showContextToolbar ? (
        <SelectionContextToolbar
          document={document}
          nodeId={contextToolbarNodeId!}
          {...selectionToolbarDock(chromeUnion!, {
            angle: chromeAngle,
            edgePadScene: strokeUiPadScreen,
            lineChrome: singleNode ? lineChrome : false,
            node: contextToolbarNodeData!,
          })}
          valueBox={toolbarValueBox(shapeKnobBox, contextToolbarNodeData!)}
          onOpenAgent={onOpenAgent}
        />
      ) : null}

      {showNodeTitle ? (
        <NodeTitleLabel
          box={chromeUnion!}
          angle={chromeAngle}
          nodeId={singleId!}
          zIndex={nodePaintZIndex(document, singleId!, singleNode)}
          name={nodeTitleChrome!.name}
          sizeWidth={chromeUnion!.width}
          sizeHeight={chromeUnion!.height}
          dataAttr="image-label"
          icon={nodeTitleChrome!.icon}
          dataProps={{ 'data-scene-node-id': singleId! }}
          onRename={(name, options) =>
            patchDocumentNode({
              nodeId: singleId!,
              patch: { attrs: { name } },
              skipHistory: options?.skipHistory,
              // A title is chrome metadata; the media SVG pixels do not change.
              skipHostReload: true,
            })
          }
          renameAriaLabel={nodeTitleChrome!.renameAriaLabel}
        />
      ) : null}

      {showSelectedImageVariants ? (
        <ImageVariantsOverlay
          document={document}
          nodeId={singleId!}
          box={(chromeUnion || liveUnion)!}
          angle={chromeAngle}
          imageHovered={hoverNodeId === singleId}
          readOnly={readOnly}
        />
      ) : null}

      {showHoverImageVariants ? (
        <ImageVariantsOverlay
          document={document}
          nodeId={hoverImageVariantsId!}
          box={hoverImageVariantsBox!}
          angle={readNodeAngle(document, hoverImageVariantsId!)}
          imageHovered
          readOnly={readOnly}
        />
      ) : null}

      {/* Multi-select bar: canvas / overlay only.
          Frame multi-select uses FrameMultiSelectionToolbar. */}
      {showMultiToolbar ? (
        <MultiSelectionToolbar
          document={document}
          nodeIds={selectedNodeIds}
          frameIds={selectedFrameIds}
          {...selectionToolbarDock(chromeUnion!, {
            angle: chromeAngle,
            edgePadScene: strokeUiPadScreen,
          })}
        />
      ) : null}
    </>
  );
}

export default memo(SelectionFeature);
