/** Kit HTML selection chrome shell — toolbars/titles only; Kit owns gestures. */
import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useSelector } from '@/store';
import { useAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import ImageVariantsOverlay from '@/components/editor/nodes/ImageNode/ImageVariantsOverlay';
import { useImageVariantsExpandedNodeId } from '@/components/editor/nodes/ImageNode/imageVariantsExpand';
import { useRcbCamera, useRcbScreenToScene } from '@/components/rcb/camera/context';
import {
  supportsCornerRadius,
  supportsShapeSides,
} from '@/components/rcb/scene/document/nodeCapabilities';
import CircleShapeHandlesOverlay from './chrome/CircleShapeHandlesOverlay';
import PolygonShapeHandlesOverlay from './chrome/PolygonShapeHandlesOverlay';
import StarShapeHandlesOverlay from './chrome/StarShapeHandlesOverlay';
import RectCornerRadiusBadgeOverlay from './chrome/RectCornerRadiusBadgeOverlay';
import { rcbCameraCssZoom } from '@/components/rcb/core/math';
import {
  collectPairSpacingGuides,
  type SceneBox,
  type SmartGuideLine,
} from './alignGuides';
import SelectionContextToolbar from './chrome/SelectionContextToolbar';
import MultiSelectionToolbar from './chrome/MultiSelectionToolbar';
import NodeTitleLabel from './chrome/NodeTitleLabel';
import SmartGuidesOverlay from './chrome/SmartGuidesOverlay';
import { subscribeLiveShapeParamsPreview } from '@/components/rcb/scene/document/sceneShapes';
import { liveShapeGeomBox } from './hostGeom';
import { nodePaintZIndex } from '@/components/rcb/scene/document/sceneDocument';
import { listImageVariantUrls } from '@/components/rcb/scene/document/mediaLifecycle';
import {
  inflateSelectionBox,
} from '@/components/rcb/scene/document/sceneEffects';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { patchDocumentNode } from '@/store/modules/editor';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { subscribeShapeHosts } from '@/components/rcb/shapes/shapeHostRegistry';
import {
  resolveInspectPrimaryId,
  selectionToolbarDock,
  readNodeAngle,
  resolveMeasurePairNodeId,
  resolveMeasureBox,
  resolveClippedMeasureBox,
  resolveHoverImageVariantsId,
} from './selectionLogic';
import {
  resolveSelectionChromeModel,
  toolbarValueBox,
} from './selectionChromeModel';
import { useKitSelectionDockAabb, useKitSelectionMoveActive, useKitSelectionResizeOrRotateActive } from './useKitSelectionDockAabb';

type SelectionFeatureProps = {
  enabled: boolean;
  readOnly?: boolean;
  document: SceneDocument;
  selectedNodeIds: string[];
  selectedFrameIds?: string[];
  getNodeBox: (nodeId: string) => SceneBox | null;
  suppressChrome?: boolean;
  /** Kit path-edit: hide selection chrome; PathEditToolbar docks at page top-center. */
  pathEditNodeId?: string | null;
  onOpenAgent?: (opts?: { prompt?: string }) => void;
};

function SelectionFeature({
  enabled,
  readOnly = false,
  document,
  selectedNodeIds,
  selectedFrameIds = [],
  getNodeBox,
  suppressChrome = false,
  pathEditNodeId = null,
  onOpenAgent,
}: SelectionFeatureProps) {
  const zoom = Math.max(0.05, rcbCameraCssZoom(useRcbCamera()));
  const toScene = useRcbScreenToScene();
  const workspaceMode = useSelector(
    (s: any) => (s.editor.workspaceMode || 'design') as 'design' | 'dev'
  );
  const frameChromeMode = useSelector(
    (s: { editor?: { frameChromeMode?: 'soft' | 'full' } }) =>
      s.editor?.frameChromeMode === 'full' ? 'full' : 'soft'
  );
  const shapeStylePanel = useSelector(
    (s: any) => s.editor.shapeStylePanel as null | { kind: string }
  );
  const lottieTimelineOpen = useSelector((s: any) =>
    Boolean(s.editor.lottieTimelinePanel?.nodeId)
  );
  const playhead = useAnimationPlayheadSec();
  const variantsExpandedId = useImageVariantsExpandedNodeId();
  const suppressToolbars =
    suppressChrome ||
    shapeStylePanel?.kind === 'radius' ||
    Boolean(variantsExpandedId);
  const kitMoving = useKitSelectionMoveActive();
  const kitResizeOrRotate = useKitSelectionResizeOrRotateActive();
  const inspectDev = workspaceMode === 'dev' || readOnly;

  const [hostEpoch, setHostEpoch] = useState(0);
  const [inspectPairNodeId, setInspectPairNodeId] = useState<string | null>(null);
  const prevInspectSelRef = useRef<string | null>(null);

  useEffect(() => subscribeShapeHosts(() => setHostEpoch((n) => n + 1)), []);
  useEffect(
    () => subscribeLiveShapeParamsPreview(() => setHostEpoch((n) => n + 1)),
    []
  );

  useEffect(() => {
    const next = resolveInspectPrimaryId(selectedNodeIds, selectedFrameIds);
    const prev = prevInspectSelRef.current;
    if (next && prev && prev !== next) setInspectPairNodeId(prev);
    else if (!next) setInspectPairNodeId(null);
    prevInspectSelRef.current = next;
  }, [selectedNodeIds, selectedFrameIds]);

  const model = useMemo(
    () =>
      resolveSelectionChromeModel({
        document,
        selectedNodeIds,
        selectedFrameIds,
        frameChromeMode,
        getNodeBox,
        playheadSec: playhead,
        lottieTimelineOpen,
      }),
    [
      document,
      selectedNodeIds,
      selectedFrameIds,
      frameChromeMode,
      getNodeBox,
      playhead,
      lottieTimelineOpen,
      hostEpoch,
    ]
  );

  const hideToolbars =
    suppressToolbars ||
    model.selectionFullyHidden ||
    kitMoving ||
    kitResizeOrRotate;
  // Kit control-box AABB is SoT for dock. Do not pass stroke×zoom as screen pad —
  // SelectionToolbarShell already clears handles in screen px.
  const edgePad = 0;
  const kitDockAabb = useKitSelectionDockAabb(selectedNodeIds, selectedFrameIds);
  /** Prefer Kit live frame AABB; angle stays 0 (pill never CSS-rotates). */
  const toolbarChromeBox = kitDockAabb ?? model.chromeUnion;
  const toolbarChromeAngle = kitDockAabb ? 0 : model.chromeAngle;

  const inspectPrimaryId = resolveInspectPrimaryId(
    selectedNodeIds,
    selectedFrameIds
  );
  const measurePairId = resolveMeasurePairNodeId({
    inspectDev,
    transforming: false,
    hoverNodeId: null,
    inspectPairNodeId,
    inspectPrimaryId,
    selectedNodeIds,
  });
  const measureBox = useMemo(
    () => resolveMeasureBox(inspectPrimaryId, document, getNodeBox),
    [inspectPrimaryId, document, getNodeBox]
  );
  const idleGuides = useMemo(() => {
    if (!inspectDev) return [] as SmartGuideLine[];
    const a = resolveClippedMeasureBox(inspectPrimaryId, document, getNodeBox);
    const b = resolveClippedMeasureBox(measurePairId, document, getNodeBox);
    if (!a || !b) return [] as SmartGuideLine[];
    return collectPairSpacingGuides(a, b);
  }, [inspectDev, inspectPrimaryId, measurePairId, document, getNodeBox]);

  const hoverVariantsId = resolveHoverImageVariantsId({
    inspectDev,
    transforming: false,
    suppressToolbars,
    hoverNodeId: null,
    selectedNodeIds,
    document,
    pinnedExpandedNodeId: variantsExpandedId,
  });
  const hoverVariantsBox = useMemo(() => {
    if (!hoverVariantsId) return null;
    const node = document?.deltaSetLike?.[hoverVariantsId];
    const live = liveShapeGeomBox(hoverVariantsId);
    if (live && node) return inflateSelectionBox(live, node);
    return getNodeBox(hoverVariantsId);
  }, [hoverVariantsId, document, getNodeBox]);

  const {
    chromeGeomBox,
    single,
    singleNode,
    singleId,
    singleNodeData,
    toolbarNodeId,
    toolbarNode,
    titleChrome,
    titled,
    processing,
    lineChrome,
    isWorkbenchMulti,
  } = model;

  if (!enabled) return null;

  // Path-edit chrome lives in EditorToolDocks (page top-center); only suppress
  // selection toolbars/handles while Kit path-edit is active.
  const pathEditActive = Boolean(pathEditNodeId) && !inspectDev && !readOnly;
  const chromeIdle = !inspectDev && !pathEditActive && !hideToolbars;
  const showToolbar =
    chromeIdle &&
    Boolean(toolbarChromeBox && toolbarNodeId && toolbarNode) &&
    !processing;
  const showTitle =
    chromeIdle &&
    Boolean(toolbarChromeBox && singleNode && singleId && titleChrome && titled);
  const showSelectedVariants =
    chromeIdle &&
    Boolean(toolbarChromeBox && singleNode && singleId && singleNodeData) &&
    singleNodeData?.key === 'image' &&
    listImageVariantUrls(singleNodeData).length > 1 &&
    !processing;
  const showHoverVariants =
    chromeIdle && Boolean(hoverVariantsId && hoverVariantsBox);
  const showMulti =
    chromeIdle &&
    Boolean(toolbarChromeBox) &&
    selectedNodeIds.length >= 2 &&
    selectedFrameIds.length === 0 &&
    !isWorkbenchMulti;

  const paramShapeType = String(singleNodeData?.attrs?.shapeType || '');
  const shapeHandleAngle =
    singleId && singleNodeData ? readNodeAngle(document, singleId) : 0;
  // Document plate box only — Kit dock AABB can differ by a few px; regenerating
  // star/polygon vertices in that box parks knobs off the true corners (same
  // path AABB as getShapeBaselineD / Kit parametric path).
  const shapeHandleBox =
    singleId && singleNodeData
      ? (() => {
          const { left, top } = nodeLeftTop(document, singleNodeData);
          return {
            left,
            top,
            width: Math.max(1, Number(singleNodeData.width) || 1),
            height: Math.max(1, Number(singleNodeData.height) || 1),
          };
        })()
      : null;
  const shapeHandlesIdle = chromeIdle && !readOnly && !kitMoving && !kitResizeOrRotate;
  const showCircleHandles =
    shapeHandlesIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && shapeHandleBox) &&
    (paramShapeType === 'circle' ||
      paramShapeType === 'ellipse' ||
      singleNodeData?.key === 'ellipse');
  const showPolygonHandles =
    shapeHandlesIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && shapeHandleBox) &&
    paramShapeType === 'polygon' &&
    supportsCornerRadius(singleNodeData) &&
    supportsShapeSides(singleNodeData);
  const showStarHandles =
    shapeHandlesIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && shapeHandleBox) &&
    paramShapeType === 'star' &&
    supportsCornerRadius(singleNodeData) &&
    supportsShapeSides(singleNodeData);
  const showRectRadiusBadge =
    chromeIdle &&
    !readOnly &&
    singleNode &&
    Boolean(singleId && singleNodeData) &&
    supportsCornerRadius(singleNodeData) &&
    (paramShapeType === 'rect' ||
      paramShapeType === 'roundRect' ||
      singleNodeData?.key === 'rect');

  return (
    <>
      <SmartGuidesOverlay
        guides={selectedFrameIds.length > 0 ? [] : idleGuides}
        sizeBox={
          inspectDev && inspectPrimaryId && !suppressChrome && !model.selectionFullyHidden
            ? measureBox
            : null
        }
      />
      {showToolbar ? (
        <SelectionContextToolbar
          document={document}
          nodeId={toolbarNodeId!}
          {...selectionToolbarDock(toolbarChromeBox!, {
            angle: toolbarChromeAngle,
            edgePadScene: edgePad,
            // Kit dock AABB is already a world corner AABB — skip lineChrome remap.
            lineChrome: Boolean(lineChrome && !kitDockAabb),
            node: toolbarNode!,
          })}
          valueBox={toolbarValueBox(chromeGeomBox, toolbarNode)}
          onOpenAgent={onOpenAgent}
        />
      ) : null}
      {showTitle ? (
        <NodeTitleLabel
          box={toolbarChromeBox!}
          angle={toolbarChromeAngle}
          nodeId={singleId!}
          zIndex={nodePaintZIndex(document, singleId!, singleNode)}
          name={titleChrome!.name}
          sizeWidth={toolbarChromeBox!.width}
          sizeHeight={toolbarChromeBox!.height}
          dataAttr="image-label"
          icon={titleChrome!.icon}
          dataProps={{ 'data-scene-node-id': singleId! }}
          onRename={(name, options) =>
            patchDocumentNode({
              nodeId: singleId!,
              patch: { attrs: { name } },
              skipHistory: options?.skipHistory,
              skipHostReload: true,
            })
          }
          renameAriaLabel={titleChrome!.renameAriaLabel}
        />
      ) : null}
      {showSelectedVariants ? (
        <ImageVariantsOverlay
          document={document}
          nodeId={singleId!}
          box={toolbarChromeBox!}
          angle={toolbarChromeAngle}
          imageHovered={false}
          readOnly={readOnly}
        />
      ) : null}
      {showHoverVariants ? (
        <ImageVariantsOverlay
          document={document}
          nodeId={hoverVariantsId!}
          box={hoverVariantsBox!}
          angle={readNodeAngle(document, hoverVariantsId!)}
          imageHovered
          readOnly={readOnly}
        />
      ) : null}
      {showMulti ? (
        <MultiSelectionToolbar
          document={document}
          nodeIds={selectedNodeIds}
          frameIds={selectedFrameIds}
          {...selectionToolbarDock(toolbarChromeBox!, {
            angle: toolbarChromeAngle,
            edgePadScene: edgePad,
          })}
        />
      ) : null}
      {showRectRadiusBadge ? (
        <RectCornerRadiusBadgeOverlay enabled />
      ) : null}
      {showCircleHandles ? (
        <CircleShapeHandlesOverlay
          box={shapeHandleBox!}
          angle={shapeHandleAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
        />
      ) : null}
      {showPolygonHandles ? (
        <PolygonShapeHandlesOverlay
          box={shapeHandleBox!}
          angle={shapeHandleAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
        />
      ) : null}
      {showStarHandles ? (
        <StarShapeHandlesOverlay
          box={shapeHandleBox!}
          angle={shapeHandleAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
        />
      ) : null}
    </>
  );
}

export default memo(SelectionFeature);
