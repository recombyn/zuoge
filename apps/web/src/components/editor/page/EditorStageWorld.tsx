import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { useSelector } from '@/store';
import { useActiveFrameId } from '@/store/editorSelectors';
import {
  RcbCanvas,
  HtmlArtboardFrame,
  type RcbCamera as CanvasCamera,
} from '@/components/rcb';
import type { SceneDocument, SceneNode } from '@/components/rcb/sceneNode';
import SvgCanvas from '@/components/editor/canvas/SvgCanvas';
import type { CanvasSession } from '@/components/editor/canvas/canvasSession';
import ImageProcessWatcher from '@/components/editor/nodes/ImageNode/ImageProcessWatcher';
import UploadJobWatcher from '@/components/editor/nodes/shared/UploadJobWatcher';
import GeneratorJobRecoveryHost from '@/components/editor/nodes/shared/GeneratorJobRecoveryHost';
import CropExpandSessionHost from '@/components/editor/nodes/ImageNode/cropExpand/CropExpandSessionHost';
import UpscaleSessionHost from '@/components/editor/nodes/ImageNode/UpscaleSessionHost';
import TranslateImageSessionHost from '@/components/editor/nodes/ImageNode/TranslateImageSessionHost';
import ProductSceneSessionHost from '@/components/editor/nodes/ImageNode/ProductSceneSessionHost';
import { EditorSessionHosts } from '@/components/editor/page/editorHosts';
import ImageQuickEditSessionHost from '@/components/editor/nodes/ImageNode/ImageQuickEditSessionHost';
import MarkPinHost from '@/components/editor/nodes/ImageNode/mark/MarkPinHost';
import PuppetPinHost from '@/components/editor/nodes/ImageNode/puppet/PuppetPinHost';
import ImageToolPanelHost from '@/components/editor/nodes/ImageNode/toolPanels/ImageToolPanelHost';
import ShapeStylePanelHost from '@/components/editor/nodes/ShapeNode/ShapeStylePanelHost';
import VideoTrimSessionHost from '@/components/editor/nodes/VideoNode/VideoTrimSessionHost';
import AnimationComposeSessionHost from '@/components/editor/nodes/AnimationNode/AnimationComposeSessionHost';
import AnimationPlayheadTransport from '@/components/editor/nodes/AnimationNode/AnimationPlayheadTransport';
import AnimationFrameContextToolbar from '@/components/editor/nodes/AnimationNode/AnimationFrameContextToolbar';
import AnimationFrameWorkbenchHost from '@/components/editor/nodes/AnimationNode/AnimationFrameWorkbenchHost';
import AudioTrimSessionHost from '@/components/editor/nodes/AudioNode/AudioTrimSessionHost';
import AudioSpeedSessionHost from '@/components/editor/nodes/AudioNode/AudioSpeedSessionHost';
import MeshHandlesOverlay from '@/components/editor/nodes/ShapeNode/MeshHandlesOverlay';
import FrameContextToolbar from '@/components/editor/nodes/FrameNode/FrameContextToolbar';
import FrameMultiSelectionToolbar from '@/components/editor/nodes/FrameNode/FrameMultiSelectionToolbar';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import { useKitSelectionDockAabb } from '@/components/rcb/selection/useKitSelectionDockAabb';
import type { FillPanelValue } from '@/components/editor/panels/FillPanel';
import {
  selectionPaintZIndex,
} from '@/components/rcb/scene/document/sceneDocument';
import {
  smartSnapThreshold,
  type SmartGuideLine,
} from '@/components/rcb/selection/alignGuides';
import {
  computeMovedUnion,
  shouldSkipSmartGuidesForFramePlateDrag,
  smartGuideTargetsForDrag,
} from '@/components/rcb/selection/selectionLogic';
import { unionOfBoxes } from '@/components/rcb/selection/resizeGeometry';
import { frameSelId } from '@/components/rcb/frames/frameSceneQuery';
import SmartGuidesOverlay from '@/components/rcb/selection/chrome/SmartGuidesOverlay';
import {
  getNodeBoxFromDoc,
  listNodeIdsFromDoc,
} from '@/components/editor/canvas/canvasSession';
import { paintIntentNeedsDomHost } from '@/components/rcb/shapes/paintIntent';
import {
  parseFillGradient,
  serializeFillGradient,
  type FillGradient,
} from '@/components/rcb/scene/document/sceneFill';
import {
  renameArtboardFrame,
  setActiveFrameId,
  setFrameChromeMode,
  setActiveTool,
  setCanvasMeta,
  setSelectedNodeIds,
  setDocumentFromCanvas,
  pushEditorHistory,
  clearCanvasAttachPick,
  setPendingCanvasAttach,
  type AiOperationState,
} from '@/store/modules/editor';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { canvasFillToDocumentMeta } from './EditorBottomHud';
import type { RootState } from '@/store';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { rcbCameraCssZoom } from '@/components/rcb/core/math';
import { clearNodeTransformPreviews } from '@/components/rcb/core/transformPreview';
import { syncKitArtboardBoundsLive } from '@/components/rcb/canvas/kitBridge';
import { bindUnownedNodesToFrames } from '@/components/rcb/frames/frameNodeBinding';
import {
  framePlateClearsIdleStroke,
  framePlateShowsHighlightEdge,
  previewArtboardFrameGeometry,
} from '@/components/rcb/frames/HtmlArtboardFrame';
import {
  isArtboardVisibleInDocument,
  setAnimationWorkbenchGeometryPreview,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';

const EDITOR_PAN_BLOCK_SELECTOR = [
  '[data-scene-node-id]',
  '[data-sel-box]',
  '[data-sel-handle]',
  '[data-frame-label]',
  '[data-image-label]',
  '[data-frame-toolbar]',
  '[data-sel-toolbar]',
  '[data-ctx-menu]',
  '[data-crop-expand-overlay]',
  '[data-crop-expand-toolbar]',
  '[data-image-tool-panel]',
  '[data-gradient-handles]',
  '[data-mesh-handles]',
  '[data-fill-image-handles]',
  '[data-shape-style-panel]',
  '[data-video-playback-bar]',
  '[data-video-trim-toolbar]',
  '[data-audio-playback-bar]',
  '[data-audio-trim-toolbar]',
  '[data-audio-speed-toolbar]',
  '[data-mark-pin-overlay]',
  '[data-mark-prompt]',
].join(',');

function isEditableFocusTarget(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || Boolean(el.isContentEditable)
  );
}

/** Blur stage inputs when pointer lands on the canvas chrome (not the field itself). */
function blurStageEditableOnPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
  const active = window.document.activeElement as HTMLElement | null;
  if (
    !active ||
    active === e.currentTarget ||
    !e.currentTarget.contains(active) ||
    !isEditableFocusTarget(active)
  ) {
    return;
  }
  active.blur();
}

function aiNodeWorldBox(
  document: SceneDocument,
  nodeId: string | null | undefined
): { left: number; top: number; width: number; height: number } | null {
  const id = String(nodeId || '').trim();
  if (!id || id === 'ROOT') return null;
  const node = document.deltaSetLike?.[id] as SceneNode | undefined;
  if (!node) return null;
  const { left, top } = nodeLeftTop(document, node);
  return {
    left,
    top,
    width: Math.max(1, Number(node.width) || 1),
    height: Math.max(1, Number(node.height) || 1),
  };
}

function frameShowsAiOverlay(
  frame: ArtboardFrame,
  aiOp: AiOperationState | null
): boolean {
  if (!aiOp?.active) return false;
  const fid = String(aiOp.frameId || '').trim();
  return Boolean(fid) && fid === frame.id;
}

function frameUnionBox(frames: ArtboardFrame[]) {
  if (!frames.length) return null;
  const left = Math.min(...frames.map((frame) => Number(frame.x) || 0));
  const top = Math.min(...frames.map((frame) => Number(frame.y) || 0));
  const right = Math.max(
    ...frames.map(
      (frame) => (Number(frame.x) || 0) + Math.max(1, Number(frame.width) || 1)
    )
  );
  const bottom = Math.max(
    ...frames.map(
      (frame) => (Number(frame.y) || 0) + Math.max(1, Number(frame.height) || 1)
    )
  );
  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

/** Node highlight / operation label / AI cursor — world overlay, not SceneDocument. */
function AiOperationNodeChrome({
  box,
  caption,
  zoom,
}: {
  box: { left: number; top: number; width: number; height: number };
  caption?: string;
  zoom: number;
}) {
  const inv = 1 / Math.max(0.05, zoom);
  return (
    <>
      <div
        data-ai-op-outline
        className="pointer-events-none absolute z-[42] border-[1.5px] border-[#3b82f6]"
        style={{
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
        }}
        aria-hidden
      />
      <div
        data-ai-op-cursor
        className="pointer-events-none absolute z-[43] h-2.5 w-2.5 rounded-full bg-[#3b82f6] shadow-[0_0_0_3px_rgba(59,130,246,0.28)]"
        style={{
          left: box.left + box.width,
          top: box.top + box.height,
          transform: `translate(-50%, -50%) scale(${inv})`,
          transformOrigin: 'center',
        }}
        aria-hidden
      />
      {caption ? (
        <div
          data-ai-op-label
          className="pointer-events-none absolute z-[43] whitespace-nowrap rounded-full bg-[rgba(37,99,235,0.88)] px-2 py-0.5 text-[10px] font-medium leading-none text-white"
          style={{
            left: box.left + box.width / 2,
            top: box.top - 6 * inv,
            transform: `translate(-50%, -100%) scale(${inv})`,
            transformOrigin: 'center bottom',
          }}
        >
          {caption}
        </div>
      ) : null}
    </>
  );
}

function canvasDiffuseMeshGradient(
  fill: FillPanelValue
): FillGradient & { type: 'diffuse' } {
  return {
    ...parseFillGradient(fill.fillGradient, 'diffuse', fill.fillColor),
    type: 'diffuse',
  };
}

/** Per-frame label handlers — undefined in inspect/dev so chrome stays inert.
 *  During composer「从画布选择— skip drag-move so a title click only attaches. */
function frameLabelInteractionProps(
  frameId: string,
  isDevMode: boolean,
  handlers: {
    onSelectFrame: (id: string, opts?: { chrome?: 'soft' | 'full' }) => void;
    onRenameFrame: (id: string, name: string, options?: { skipHistory?: boolean }) => void;
    onMoveFrame: (
      id: string,
      x: number,
      y: number,
      opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }
    ) => void;
    onFrameMoveStart: (id: string) => void;
    onFrameMoveEnd: () => void;
  },
  attachPickActive = false
) {
  if (isDevMode) {
    return {
      onSelect: undefined as undefined,
      onRename: undefined as undefined,
      onMove: undefined as undefined,
      onMoveStart: undefined as undefined,
      onMoveEnd: undefined as undefined,
    };
  }
  return {
    // Title click always promotes to full chrome (toolbar + handles + drag).
    // In attach-pick mode this completes `frame:<id>` via onSelectFrame.
    onSelect: () => handlers.onSelectFrame(frameId, { chrome: 'full' }),
    onRename: (name: string, options?: { skipHistory?: boolean }) =>
      handlers.onRenameFrame(frameId, name, options),
    onMove: attachPickActive
      ? undefined
      : (x: number, y: number, opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }) =>
          handlers.onMoveFrame(frameId, x, y, opts),
    onMoveStart: attachPickActive
      ? undefined
      : () => {
          handlers.onSelectFrame(frameId, { chrome: 'full' });
          handlers.onFrameMoveStart(frameId);
        },
    onMoveEnd: attachPickActive ? undefined : handlers.onFrameMoveEnd,
  };
}

type Props = {
  document: SceneDocument;
  worldBounds: { x: number; y: number; width: number; height: number };
  worldSurface: { x: number; y: number; width: number; height: number };
  camera: CanvasCamera;
  onCameraChange: (camera: CanvasCamera) => void;
  panMode: boolean;
  frameMode: boolean;
  stageBackground?: string;
  stageRef: RefObject<HTMLDivElement | null>;
  onViewportEl: (el: HTMLElement | null) => void;
  stageEl: HTMLElement | null;
  canvasCursor?: string;
  gridSize: number;
  isDevMode: boolean;
  isMobileViewport: boolean;
  activeTool: string;
  canvasDocument: SceneDocument;
  sceneReloadToken: number;
  documentPatchToken: number;
  lastPatchedNodeIds: string[];
  lastPatchTransformOnly: boolean;
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  frames: ArtboardFrame[];
  selectedFrames: ArtboardFrame[];
  activeFrame: ArtboardFrame | null;
  canvasFillValue: FillPanelValue;
  canvasBgOpen: boolean;
  canvasMeshSelectedIndex: number;
  setCanvasMeshSelectedIndex: (v: number) => void;
  canvasMeshShowGuides: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onCanvasReady: () => void;
  onOpenAgent: (opts?: { prompt?: string }) => void;
  onAddToChat: (target: string | string[]) => void;
};

/** Infinite canvas world: artboards, SvgCanvas, frame draw/move, style hosts. */
function EditorStageWorld({
  document,
  worldBounds,
  worldSurface,
  camera,
  onCameraChange,
  panMode,
  frameMode,
  stageBackground,
  stageRef,
  onViewportEl,
  stageEl,
  canvasCursor,
  gridSize,
  isDevMode,
  isMobileViewport,
  activeTool,
  canvasDocument,
  sceneReloadToken,
  documentPatchToken,
  lastPatchedNodeIds,
  lastPatchTransformOnly,
  selectedNodeId,
  selectedNodeIds,
  selectedFrameIds,
  frames,
  selectedFrames,
  activeFrame,
  canvasFillValue,
  canvasBgOpen,
  canvasMeshSelectedIndex,
  setCanvasMeshSelectedIndex,
  canvasMeshShowGuides,
  onZoomIn,
  onZoomOut,
  onCanvasReady,
  onOpenAgent,
  onAddToChat,
}: Props) {
  const aiOperationState = useSelector(
    (state: RootState) => state.editor.aiOperationState
  );
  const canvasApplyLock = useSelector(
    (state: RootState) => (state.editor.canvasApplyLock || 0) as number
  );
  const frameChromeMode = useSelector(
    (state: RootState) => state.editor.frameChromeMode as 'soft' | 'full'
  );
  const activeFrameId = useActiveFrameId();
  const canvasAttachPick = useSelector(
    (state: RootState) =>
      state.editor.canvasAttachPick as null | { target: string; accept?: 'image' | 'media' }
  );
  const attachPickActive = Boolean(canvasAttachPick?.target);
  const onAddToChatRef = useRef(onAddToChat);
  onAddToChatRef.current = onAddToChat;
  const [movingFrameIds, setMovingFrameIds] = useState<string[]>([]);
  const movingFrameIdSet = useMemo(() => new Set(movingFrameIds), [movingFrameIds]);
  const [frameSmartGuides, setFrameSmartGuides] = useState<SmartGuideLine[]>([]);
  const [selectionTransforming, setSelectionTransforming] = useState(false);
  const workbenchTimelineNodeId = useSelector((state: RootState) =>
    String(state.editor.lottieTimelinePanel?.nodeId || '')
  );
  // Drop snap guides that may still point at plates hidden by timeline focus.
  useEffect(() => {
    setFrameSmartGuides([]);
  }, [workbenchTimelineNodeId]);
  const frameDragRef = useRef<{
    frames: Array<{
      id: string;
      startX: number;
      startY: number;
      width: number;
      height: number;
      kind?: string | null;
    }>;
  } | null>(null);
  const frameMoveDocumentRef = useRef<SceneDocument | null>(document);
  const geometryPreviewRef = useRef<CanvasSession['onGeometryPreview'] | null>(null);
  const getPreviewDocumentRef = useRef<() => SceneDocument | null>(() => null);
  const resetFrameGestureRef = useRef<(() => void) | null>(null);
  /** Sync flag — label/workbench plate drag does not use SelectionFeature transforming. */
  const frameGestureActiveRef = useRef(false);
  const showWorkbenchFrame = useCallback(
    (frame: ArtboardFrame) => isArtboardVisibleInDocument(frame),
    []
  );

  const onMoveFrame = useCallback(
    (id: string, x: number, y: number, opts?: { skipGrid?: boolean; axisLock?: 'h' | 'v' }) => {
      const frame = frames.find((f) => f.id === id);
      const dragState = frameDragRef.current;
      const dragged = dragState?.frames.find((item) => item.id === id);
      if (!frame && !dragged) return;
      const baseFrame = frame || frames.find((item) => item.id === dragged?.id);
      if (!baseFrame) return;

      const movedFrames =
        dragState?.frames ||
        [
          {
            id,
            startX: Number(baseFrame.x) || 0,
            startY: Number(baseFrame.y) || 0,
            width: Math.max(1, Number(baseFrame.width) || 1),
            height: Math.max(1, Number(baseFrame.height) || 1),
          },
        ];
      const primary = dragged ?? movedFrames[0];
      const baseX = primary.startX;
      const baseY = primary.startY;
      const rawDx = x - baseX;
      const rawDy = y - baseY;

      const movedFrameIds = new Set(movedFrames.map((item) => item.id));
      const skipPlateSnap = shouldSkipSmartGuidesForFramePlateDrag(document);

      const threshold = smartSnapThreshold(camera.zoom);
      const movedChildIds = new Set(nodeIdsBoundToFrames(document, [...movedFrameIds]));
      const excludeIds = new Set<string>([
        ...movedChildIds,
        ...[...movedFrameIds, id].flatMap((frameId) => [frameId, frameSelId(frameId)]),
      ]);

      const origins = movedFrames.map((item) => ({
        nodeId: frameSelId(item.id),
        box: {
          left: item.startX,
          top: item.startY,
          width: item.width,
          height: item.height,
        },
      }));
      const startUnion =
        unionOfBoxes(origins.map((item) => item.box)) ?? origins[0].box;
      const listNodeIds = () => listNodeIdsFromDoc(document);
      const getNodeBox = (nodeId: string) => getNodeBoxFromDoc(document, nodeId);

      const { sdx, sdy, guides } = computeMovedUnion({
        union: startUnion,
        origins,
        document,
        dx: rawDx,
        dy: rawDy,
        disableSnap: Boolean(opts?.skipGrid) || skipPlateSnap,
        gridSize: opts?.skipGrid ? 0 : gridSize,
        axisLock: opts?.axisLock,
        targets: skipPlateSnap
          ? []
          : smartGuideTargetsForDrag({
              document,
              listNodeIds,
              getNodeBox,
              excludeIds,
              nearBox: {
                left: startUnion.left + rawDx,
                top: startUnion.top + rawDy,
                width: startUnion.width,
                height: startUnion.height,
              },
              threshold,
              queryNodeIdsInRect: (area) =>
                listNodeIds().filter((nodeId) => {
                  const box = getNodeBox(nodeId);
                  if (!box) return false;
                  const right = box.left + box.width;
                  const bottom = box.top + box.height;
                  return !(
                    right < area.left ||
                    box.left > area.left + area.width ||
                    bottom < area.top ||
                    box.top > area.top + area.height
                  );
                }),
            }),
        threshold,
      });

      setFrameSmartGuides((prev) => {
        if (
          prev.length === guides.length &&
          prev.every((g, i) => {
            const n = guides[i];
            if (!n || g.kind !== n.kind || g.axis !== n.axis) return false;
            if (g.at !== n.at || g.from !== n.from || g.to !== n.to) return false;
            if (g.kind === 'gap' && n.kind === 'gap' && g.dist !== n.dist) return false;
            return true;
          })
        ) {
          return prev;
        }
        return guides;
      });
      const dx = Math.round(sdx);
      const dy = Math.round(sdy);
      if (dx !== 0 || dy !== 0) {
        // Frame-local children: only the plate moves. Ink follows via live frame
        // geom + nodeLeftTop — do not rewrite child x/y or TransformPreview.
        const geomPatches = movedFrames.map((moved) => ({
          nodeId: frameSelId(moved.id),
          left: moved.startX + dx,
          top: moved.startY + dy,
          width: moved.width,
          height: moved.height,
        }));
        geometryPreviewRef.current?.(geomPatches);
        // Kit: artboard drag updates engine bounds every frame (set_artboard_bounds).
        for (const moved of movedFrames) {
          syncKitArtboardBoundsLive({
            id: moved.id,
            x: moved.startX + dx,
            y: moved.startY + dy,
            width: moved.width,
            height: moved.height,
          });
        }
      }
      const nextDocument = {
        ...document,
        frames: frames.map((item) => {
          const moved = movedFrames.find((entry) => entry.id === item.id);
          if (!moved) return item;
          return { ...item, x: moved.startX + dx, y: moved.startY + dy };
        }),
      };
      frameMoveDocumentRef.current = getPreviewDocumentRef.current?.() ?? nextDocument;
      // Preview only — do not setDocumentFromCanvas on every pointermove (that
      // re-renders EditorPage/panels and, with collab, JSON.stringifys the scene).
    },
    [camera.zoom, document, frames, gridSize]
  );

  const onFrameMoveStart = useCallback(
    (frameId: string) => {
      const frameIds = selectedFrameIds.includes(frameId) ? selectedFrameIds : [frameId];
      const movedFrames = frames
        .filter((item) => frameIds.includes(item.id))
        .map((item) => ({
          id: item.id,
          startX: Number(item.x) || 0,
          startY: Number(item.y) || 0,
          width: Math.max(1, Number(item.width) || 1),
          height: Math.max(1, Number(item.height) || 1),
          kind: item.kind,
        }));
      if (movedFrames.length) {
        frameGestureActiveRef.current = true;
        frameMoveDocumentRef.current = document;
        // Drop playhead / selection TransformPreviews so frameLocal children
        // follow live plate via nodeLeftTop (preview left/top would pin ink).
        clearNodeTransformPreviews();
        // Only gate animation ensure/sync during 动画工作台 plate drags.
        if (movedFrames.some((f) => isAnimationArtboardKind(f.kind))) {
          setAnimationWorkbenchGeometryPreview(true);
        }
        setFrameSmartGuides([]);
        frameDragRef.current = {
          frames: movedFrames,
        };
      }
      // Frame move = plate gesture only. Drop node selection so inner control
      // boxes do not ride along and look like content sliding inside the plate.
      setSelectedNodeIds([]);
      setMovingFrameIds(frameIds);
      setSelectionTransforming(true);
      pushEditorHistory();
    },
    [document, frames, selectedFrameIds]
  );

  const onFrameMoveEnd = useCallback(() => {
    frameGestureActiveRef.current = false;
    resetFrameGestureRef.current?.();
    const frameIds = frameDragRef.current?.frames.map((item) => item.id) || [];
    if (frameIds.length) {
      const liveDocument = frameMoveDocumentRef.current || document;
      const next = bindUnownedNodesToFrames(liveDocument, frameIds);
      // Always commit — move preview lived only in the ref during the gesture.
      setDocumentFromCanvas(next);
      // Keep live plate geom through the store write so chrome + SVG host stay on
      // the same box. Bare clearLiveArtboardFrameGeometry() left hosts on preview
      // while resolveFrameChromeBox fell back to a one-frame-stale document (or
      // clearFrameGeometryPreview later baked hosts from stale documentRef) —
      // white fill and blue selection outline drifted after every plate move.
      for (const id of frameIds) {
        const frame = (Array.isArray(next.frames) ? next.frames : []).find(
          (item) => String(item?.id) === String(id)
        );
        if (frame) {
          previewArtboardFrameGeometry({
            id: String(frame.id),
            x: Number(frame.x) || 0,
            y: Number(frame.y) || 0,
            width: Math.max(1, Number(frame.width) || 1),
            height: Math.max(1, Number(frame.height) || 1),
          });
        }
      }
    }
    clearNodeTransformPreviews();
    frameDragRef.current = null;
    frameMoveDocumentRef.current = document;
    setAnimationWorkbenchGeometryPreview(false);
    setFrameSmartGuides([]);
    setMovingFrameIds([]);
    setSelectionTransforming(false);
  }, [document]);

  const onSelectFrame = useCallback(
    (id: string, opts?: { chrome?: 'soft' | 'full' }) => {
      // Mirror SvgCanvas.onSelectFrame — title label must complete attach-pick.
      // Without this, clicking a vector artboard title only shows chrome while
      //「从画布选择」stays armed and nothing lands in the composer.
      const pick = canvasAttachPick;
      if (pick?.target) {
        const payload = `frame:${id}`;
        if (pick.target === 'agent') {
          onAddToChatRef.current?.(payload);
        } else {
          setPendingCanvasAttach({ target: pick.target, payload });
        }
        clearCanvasAttachPick();
        return;
      }
      setActiveFrameId(id);
      setFrameChromeMode(opts?.chrome === 'soft' ? 'soft' : 'full');
    },
    [canvasAttachPick]
  );

  const onRenameFrame = useCallback(
    (id: string, name: string, options?: { skipHistory?: boolean }) => {
      renameArtboardFrame({ id, name, skipHistory: options?.skipHistory });
    }, []
  );

  const onCanvasDiffuseMeshChange = useCallback(
    (next: FillGradient) => {
      setCanvasMeta(
          canvasFillToDocumentMeta(
            {
              ...canvasFillValue,
              fillType: 'diffuse',
              fillGradient: serializeFillGradient(next),
              fillColor: next.meshPoints?.[0]?.color || canvasFillValue.fillColor,
            },
            false
          )
        );
    },
    [canvasFillValue]
  );

  const selectedFrameBoxDoc = useMemo(() => frameUnionBox(selectedFrames), [selectedFrames]);
  const kitDockAabb = useKitSelectionDockAabb(selectedNodeIds, selectedFrameIds);
  // Same Kit AABB as node toolbars — keeps frame chrome aligned after select/reconcile.
  const selectedFrameBox = kitDockAabb ?? selectedFrameBoxDoc;

  /** Plates whose bound children own selection chrome — idle hairline kept; soft edge via activeFrameId. */
  const framesWithBoundChildSelection = useMemo(() => {
    const set = new Set<string>();
    const map = document?.deltaSetLike || {};
    for (const id of selectedNodeIds) {
      const fid = String(map[id]?.attrs?.frameId || '').trim();
      if (fid) set.add(fid);
    }
    return set;
  }, [document, selectedNodeIds]);

  // HTML camera only for DomHost / artboard plates / selection guides — not Kit ink alone.
  const needsHostSurface = useMemo(() => {
    if (!document) return false;
    if (frames.some((frame) => showWorkbenchFrame(frame))) return true;
    if (selectedNodeIds.length > 0 || selectedFrameIds.length > 0) return true;
    const map = document.deltaSetLike || {};
    for (const id of listNodeIdsFromDoc(document)) {
      if (paintIntentNeedsDomHost(document, id, map[id])) return true;
    }
    return false;
  }, [document, frames, selectedFrameIds.length, selectedNodeIds.length, showWorkbenchFrame]);

  if (isMobileViewport || !document) return null;

  const showCanvasDiffuseMesh =  canvasBgOpen && canvasFillValue.fillType === 'diffuse';
  const showFrameToolbar =
    !isDevMode &&
    canvasApplyLock <= 0 &&
    frameChromeMode === 'full' &&
    selectedFrames.length >= 1 &&
    // Multi artboards keep their align/lock bar even if a stray node is also
    // selected (MultiSelectionToolbar hides node chrome when frames are present).
    (selectedNodeIds.length === 0 || selectedFrames.length > 1) &&
    Boolean(selectedFrameBox) &&
    !selectedFrames.some((frame) => movingFrameIdSet.has(frame.id)) &&
    !selectionTransforming;
  const showMultiFrameToolbar = showFrameToolbar && selectedFrames.length > 1;
  const aiNodeBox = aiOperationState?.active ? aiNodeWorldBox(document, aiOperationState.nodeId)  : null;
  const aiNodeCaption = aiOperationState?.label || undefined;

  return (
    <div
      className="relative min-h-0 flex-1"
      onPointerDown={blurStageEditableOnPointerDown}
    >
      <RcbCanvas
        artboard={worldBounds}
        camera={camera}
        onCameraChange={onCameraChange}
        panMode={panMode}
        emptyDragPans={canvasApplyLock > 0}
        panBlockSelector={EDITOR_PAN_BLOCK_SELECTOR}
        background={stageBackground}
        stageRef={stageRef}
        onViewportEl={onViewportEl}
        cursor={canvasCursor}
        gridSize={gridSize}
        hostSurface={needsHostSurface}
      >
        {frames.map((frame) =>
          !showWorkbenchFrame(frame) ? null : (
            <HtmlArtboardFrame
              key={`body-${frame.id}`}
              frame={frame}
              zIndex={selectionPaintZIndex(
                document,
                'frame',
                frame.id,
                selectedFrameIds.length === 1 &&
                  selectedNodeIds.length === 0 &&
                  selectedFrameIds[0] === frame.id
              )}
              selected={
                !isDevMode &&
                !movingFrameIdSet.has(frame.id) &&
                framePlateClearsIdleStroke({
                  chromeMode: frameChromeMode,
                  selectedFrameIds,
                  frameId: frame.id,
                  boundChildSelected: framesWithBoundChildSelection.has(frame.id),
                })
              }
              highlighted={
                !isDevMode &&
                // While dragging: keep a visible plate edge (no handles). Hiding
                // both selected + highlighted left only a faint hairline so the
                // plate looked like it vanished on the light canvas.
                // Multi full: union chrome does not own per-plate edges — highlight.
                framePlateShowsHighlightEdge({
                  chromeMode: frameChromeMode,
                  selectedFrameIds,
                  frameId: frame.id,
                  activeFrameId,
                  moving: movingFrameIdSet.has(frame.id),
                  boundChildSelected: framesWithBoundChildSelection.has(frame.id),
                })
              }
              layer="body"
              aiGenerating={frameShowsAiOverlay(frame, aiOperationState)}
            />
          )
        )}

        <SvgCanvas
          document={canvasDocument}
          reloadToken={sceneReloadToken}
          documentPatchToken={documentPatchToken}
          lastPatchedNodeIds={lastPatchedNodeIds}
          lastPatchTransformOnly={lastPatchTransformOnly}
          selectedNodeId={selectedNodeId}
          selectedNodeIds={selectedNodeIds}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onReady={onCanvasReady}
          onTransformingChange={setSelectionTransforming}
          onFrameMoveStart={onFrameMoveStart}
          onFrameMoveEnd={onFrameMoveEnd}
          onFrameMove={onMoveFrame}
          geometryPreviewRef={geometryPreviewRef}
          getPreviewDocumentRef={getPreviewDocumentRef}
          frameGestureActiveRef={frameGestureActiveRef}
          resetFrameGestureRef={resetFrameGestureRef}
          frameGestureActive={movingFrameIds.length > 0 || selectionTransforming}
          suppressChromeWhileFrameMoving={movingFrameIds.length > 0}
          embedded
          stageEl={stageEl}
          onOpenAgent={onOpenAgent}
          onAddToChat={onAddToChat}
        />

        {frames.map((frame) =>
          !showWorkbenchFrame(frame) ||
          selectionTransforming ||
          movingFrameIdSet.has(frame.id) ? null : (
            <HtmlArtboardFrame
              key={`process-${frame.id}`}
              frame={frame}
              layer="process"
              aiGenerating={frameShowsAiOverlay(frame, aiOperationState)}
              aiProcessLabel={
                frameShowsAiOverlay(frame, aiOperationState)
                  ? aiOperationState?.label
                  : undefined
              }
            />
          )
        )}

        {aiNodeBox && !selectionTransforming && movingFrameIds.length === 0 ? (
          <AiOperationNodeChrome
            box={aiNodeBox}
            caption={aiNodeCaption}
            zoom={rcbCameraCssZoom(camera)}
          />
        ) : null}

        <SmartGuidesOverlay guides={frameSmartGuides} />

        <ImageProcessWatcher />
        <UploadJobWatcher />
        <GeneratorJobRecoveryHost />
        <ImageToolPanelHost document={document} hidden={selectionTransforming} />
        <ShapeStylePanelHost document={document} hidden={selectionTransforming} />
        <CropExpandSessionHost document={document} hidden={selectionTransforming} />
        <UpscaleSessionHost document={document} hidden={selectionTransforming} />
        <TranslateImageSessionHost document={document} hidden={selectionTransforming} />
        <ProductSceneSessionHost document={document} hidden={selectionTransforming} />
        <EditorSessionHosts document={document} selectionTransforming={selectionTransforming} />
        <ImageQuickEditSessionHost document={document} hidden={selectionTransforming} />
        <MarkPinHost document={document} hidden={selectionTransforming} />
        <PuppetPinHost document={document} hidden={selectionTransforming} />
        <VideoTrimSessionHost document={document} hidden={selectionTransforming} />
        <AnimationComposeSessionHost document={document} hidden={selectionTransforming} />
        <AnimationPlayheadTransport document={document} />
        <AnimationFrameWorkbenchHost document={document} hidden={selectionTransforming} />
        <AudioTrimSessionHost document={document} hidden={selectionTransforming} />
        <AudioSpeedSessionHost document={document} hidden={selectionTransforming} />

        {showCanvasDiffuseMesh ? (
          <MeshHandlesOverlay
            box={{
              left: 0,
              top: 0,
              width: worldSurface.width,
              height: worldSurface.height,
            }}
            gradient={canvasDiffuseMeshGradient(canvasFillValue)}
            selectedIndex={canvasMeshSelectedIndex}
            showGuides={canvasMeshShowGuides}
            onActivePointChange={setCanvasMeshSelectedIndex}
            onChange={onCanvasDiffuseMeshChange}
          />
        ) : null}

        {frames.map((frame) =>
          !showWorkbenchFrame(frame) ? null : (
            <HtmlArtboardFrame
              key={`label-${frame.id}`}
              frame={frame}
              zIndex={selectionPaintZIndex(
                document,
                'frame',
                frame.id,
                selectedFrameIds.length === 1 &&
                  selectedNodeIds.length === 0 &&
                  selectedFrameIds[0] === frame.id
              )}
              selected={
                !isDevMode &&
                !movingFrameIdSet.has(frame.id) &&
                framePlateClearsIdleStroke({
                  chromeMode: frameChromeMode,
                  selectedFrameIds,
                  frameId: frame.id,
                  boundChildSelected: framesWithBoundChildSelection.has(frame.id),
                })
              }
              highlighted={
                !isDevMode &&
                framePlateShowsHighlightEdge({
                  chromeMode: frameChromeMode,
                  selectedFrameIds,
                  frameId: frame.id,
                  activeFrameId,
                  moving: movingFrameIdSet.has(frame.id),
                  boundChildSelected: framesWithBoundChildSelection.has(frame.id),
                })
              }
              // Kit drawArtboards owns label + hit for every artboard (incl. 动画工作台).
              hideTitle
              {...frameLabelInteractionProps(
                frame.id,
                isDevMode,
                {
                  onSelectFrame,
                  onRenameFrame,
                  onMoveFrame,
                  onFrameMoveStart,
                  onFrameMoveEnd,
                },
                attachPickActive
              )}
              layer="label"
            />
          )
        )}

        {showMultiFrameToolbar && selectedFrameBox ? (
          <FrameMultiSelectionToolbar frames={selectedFrames} box={selectedFrameBox} />
        ) : null}

        {showFrameToolbar && !showMultiFrameToolbar && activeFrame && selectedFrameBox ? (
          isAnimationArtboardKind(activeFrame.kind) ? (
            <AnimationFrameContextToolbar frame={activeFrame} box={selectedFrameBox} />
          ) : (
            <FrameContextToolbar frame={activeFrame} box={selectedFrameBox} />
          )
        ) : null}
      </RcbCanvas>
    </div>
  );
}

export default memo(EditorStageWorld);
