/** Kit HTML selection chrome shell — toolbars/titles only; Kit owns gestures. */
import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { useSelector } from '@/store';
import { useAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import ImageVariantsOverlay from '@/components/editor/nodes/ImageNode/ImageVariantsOverlay';
import { useImageVariantsExpandedNodeId } from '@/components/editor/nodes/ImageNode/imageVariantsExpand';
import PathEditToolbar, {
  type PathEditSubtool,
} from '@/components/editor/chrome/PathEditToolbar';
import { useRcbCamera, useRcbScreenToScene } from '@/components/rcb/camera/context';
import {
  supportsCornerRadius,
  supportsShapeSides,
} from '@/components/rcb/scene/document/nodeCapabilities';
import CircleShapeHandlesOverlay from './chrome/CircleShapeHandlesOverlay';
import PolygonShapeHandlesOverlay from './chrome/PolygonShapeHandlesOverlay';
import StarShapeHandlesOverlay from './chrome/StarShapeHandlesOverlay';
import { rcbCameraCssZoom } from '@/components/rcb/core/math';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  collectPairSpacingGuides,
  type SceneBox,
  type SmartGuideLine,
} from './alignGuides';
import SelectionContextToolbar from './chrome/SelectionContextToolbar';
import MultiSelectionToolbar from './chrome/MultiSelectionToolbar';
import NodeTitleLabel from './chrome/NodeTitleLabel';
import SmartGuidesOverlay from './chrome/SmartGuidesOverlay';
import { SelectionToolbarShell } from './chrome/SelectionToolbarShell';
import { subscribeLiveShapeParamsPreview } from '@/components/rcb/scene/document/sceneShapes';
import { liveShapeGeomBox } from './hostGeom';
import { nodePaintZIndex } from '@/components/rcb/scene/document/sceneDocument';
import { listImageVariantUrls } from '@/components/rcb/scene/document/mediaLifecycle';
import {
  inflateSelectionBox,
  strokeOuterClearanceScene,
} from '@/components/rcb/scene/document/sceneEffects';
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
import { useKitSelectionDockAabb, useKitSelectionMoveActive } from './useKitSelectionDockAabb';

type SelectionFeatureProps = {
  enabled: boolean;
  readOnly?: boolean;
  document: SceneDocument;
  selectedNodeIds: string[];
  selectedFrameIds?: string[];
  getNodeBox: (nodeId: string) => SceneBox | null;
  suppressChrome?: boolean;
  /** Kit path-edit: dock PathEditToolbar above the path (same shell as rect). */
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
  const [pathEditSubtool, setPathEditSubtool] = useState<PathEditSubtool>('select');

  useEffect(() => {
    if (!pathEditNodeId) {
      setPathEditSubtool('select');
      return;
    }
    setPathEditSubtool('select');
    const onSubtool = (e: Event) => {
      const s = (e as CustomEvent).detail?.subtool;
      if (s === 'pen' || s === 'add-anchor' || s === 'curve') setPathEditSubtool(s);
      else setPathEditSubtool('select');
    };
    window.addEventListener('resume:path-edit-subtool', onSubtool);
    return () => window.removeEventListener('resume:path-edit-subtool', onSubtool);
  }, [pathEditNodeId]);
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
    suppressToolbars || model.selectionFullyHidden || kitMoving;
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

  const pathEditId = pathEditNodeId ? String(pathEditNodeId) : '';
  const pathEditNode = pathEditId ? document?.deltaSetLike?.[pathEditId] : null;
  const pathEditShapeType = String(pathEditNode?.attrs?.shapeType || '');
  const pathEditLineChrome =
    pathEditShapeType === 'line' || pathEditShapeType === 'arrow';
  const pathEditBox = useMemo(() => {
    if (!pathEditId || !pathEditNode) return null;
    const live = liveShapeGeomBox(pathEditId);
    if (live) return inflateSelectionBox(live, pathEditNode);
    const fromDoc = getNodeBox(pathEditId);
    if (fromDoc) return inflateSelectionBox(fromDoc, pathEditNode);
    const { left, top } = nodeLeftTop(document, pathEditNode);
    return inflateSelectionBox(
      {
        left,
        top,
        width: Math.max(1, Number(pathEditNode.width) || 1),
        height: Math.max(1, Number(pathEditNode.height) || 1),
      },
      pathEditNode
    );
  }, [pathEditId, pathEditNode, document, getNodeBox, hostEpoch]);
  const pathEditAngle = pathEditId ? readNodeAngle(document, pathEditId) : 0;
  const pathEditEdgePad = pathEditNode
    ? Math.max(0, strokeOuterClearanceScene(pathEditNode)) * zoom
    : 0;
  const pathEditDock = selectionToolbarDock(pathEditBox, {
    angle: pathEditAngle,
    edgePadScene: pathEditEdgePad,
    lineChrome: pathEditLineChrome,
    node: pathEditNode,
  });

  if (!enabled) return null;

  const showPathEditToolbar =
    Boolean(pathEditId && pathEditDock.box) && !inspectDev && !readOnly;
  const chromeIdle = !inspectDev && !showPathEditToolbar && !hideToolbars;
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
  const showCircleHandles =
    chromeIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && chromeGeomBox) &&
    !readOnly &&
    !kitMoving &&
    (paramShapeType === 'circle' ||
      paramShapeType === 'ellipse' ||
      singleNodeData?.key === 'ellipse');
  const showPolygonHandles =
    chromeIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && chromeGeomBox) &&
    !readOnly &&
    !kitMoving &&
    paramShapeType === 'polygon' &&
    supportsCornerRadius(singleNodeData) &&
    supportsShapeSides(singleNodeData);
  const showStarHandles =
    chromeIdle &&
    singleNode &&
    Boolean(singleId && singleNodeData && chromeGeomBox) &&
    !readOnly &&
    !kitMoving &&
    paramShapeType === 'star' &&
    supportsCornerRadius(singleNodeData) &&
    supportsShapeSides(singleNodeData);
  const shapeHandleAngle =
    singleId && singleNodeData ? readNodeAngle(document, singleId) : 0;

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
      {showPathEditToolbar ? (
        <SelectionToolbarShell
          box={pathEditDock.box}
          angle={pathEditDock.angle}
          edgePadScene={pathEditDock.edgePadScene}
          bare
        >
          <PathEditToolbar
            chrome="pill"
            subtool={pathEditSubtool}
            onSubtoolChange={(s) => {
              setPathEditSubtool(s);
              window.dispatchEvent(
                new CustomEvent('resume:path-edit-subtool', { detail: { subtool: s } })
              );
            }}
            onExit={() => {
              window.dispatchEvent(new Event('resume:exit-path-edit'));
            }}
          />
        </SelectionToolbarShell>
      ) : null}
      {showToolbar ? (
        <SelectionContextToolbar
          document={document}
          nodeId={toolbarNodeId!}
          {...selectionToolbarDock(toolbarChromeBox!, {
            angle: toolbarChromeAngle,
            edgePadScene: edgePad,
            lineChrome,
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
      {showCircleHandles ? (
        <CircleShapeHandlesOverlay
          box={chromeGeomBox!}
          angle={shapeHandleAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
        />
      ) : null}
      {showPolygonHandles ? (
        <PolygonShapeHandlesOverlay
          box={chromeGeomBox!}
          angle={shapeHandleAngle}
          nodeId={singleId!}
          node={singleNodeData!}
          toScene={toScene}
        />
      ) : null}
      {showStarHandles ? (
        <StarShapeHandlesOverlay
          box={chromeGeomBox!}
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
