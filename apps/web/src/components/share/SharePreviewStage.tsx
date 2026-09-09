import { memo, type RefObject } from 'react';
import {
  RcbCanvas,
  type RcbCamera as CanvasCamera,
} from '@/components/rcb';
import SvgCanvas from '@/components/editor/canvas/SvgCanvas';
import HtmlArtboardFrame from '@/components/rcb/frames/HtmlArtboardFrame';
import EditorToolStrip from '@/components/editor/chrome/EditorToolStrip';
import {
  stackZIndex
} from '@/components/rcb/scene/document/sceneDocument';
import type { ArtboardFrame } from '@/store/modules/editor';
import ShareBottomHud from './ShareBottomHud';
import type { SceneDocument } from '@/components/rcb/sceneNode';

type Props = {
  document: SceneDocument;
  frames: ArtboardFrame[];
  worldBounds: { x: number; y: number; width: number; height: number };
  worldSurface: { x: number; y: number; width: number; height: number };
  camera: CanvasCamera;
  onCameraChange: (camera: CanvasCamera) => void;
  stageBackground?: string;
  stageRef: RefObject<HTMLDivElement | null>;
  onViewportEl: (el: HTMLElement | null) => void;
  stageEl: HTMLElement | null;
  sceneReloadToken: number;
  documentPatchToken: number;
  lastPatchedNodeIds: string[];
  selectedNodeId: string | null;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  zoomPercent: number;
  zoomFitActive: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFitView: () => void;
  zoomAtStageCenter: (zoom: number) => void;
};

/** Read-only share preview canvas + toolstrip + zoom HUD. */
function SharePreviewStage({
  document,
  frames,
  worldBounds,
  worldSurface,
  camera,
  onCameraChange,
  stageBackground,
  stageRef,
  onViewportEl,
  stageEl,
  sceneReloadToken,
  documentPatchToken,
  lastPatchedNodeIds,
  selectedNodeId,
  selectedNodeIds,
  selectedFrameIds,
  zoomPercent,
  zoomFitActive,
  onZoomIn,
  onZoomOut,
  onFitView,
  zoomAtStageCenter,
}: Props) {
  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <RcbCanvas
        artboard={worldBounds}
        camera={camera}
        onCameraChange={onCameraChange}
        panMode={false}
        emptyDragPans={false}
        background={stageBackground}
        stageRef={stageRef}
        onViewportEl={onViewportEl}
      >
        {frames.map((frame) =>
          frame.hidden ? null : (
            <HtmlArtboardFrame
              key={`body-${frame.id}`}
              frame={frame}
              zIndex={stackZIndex(document, 'frame', frame.id)}
              selected={selectedFrameIds.includes(frame.id)}
              layer="body"
              hideTitle
            />
          )
        )}

        <SvgCanvas
          document={{
            ...document,
            x: 0,
            y: 0,
            width: worldSurface.width,
            height: worldSurface.height,
            backgroundColor: 'transparent',
            backgroundFillType: 'solid',
          }}
          reloadToken={sceneReloadToken}
          documentPatchToken={documentPatchToken}
          lastPatchedNodeIds={lastPatchedNodeIds}
          selectedNodeId={selectedNodeId}
          selectedNodeIds={selectedNodeIds}
          readOnly
          omitNonExportable
          embedded
          stageEl={stageEl}
        />

        {frames.map((frame) =>
          frame.hidden ? null : (
            <HtmlArtboardFrame
              key={`label-${frame.id}`}
              frame={frame}
              selected={selectedFrameIds.includes(frame.id)}
              layer="label"
              hideTitle
            />
          )
        )}
      </RcbCanvas>

      <div
        data-tour="editor-tools"
        className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2"
      >
        <div className="pointer-events-auto">
          <EditorToolStrip camera={camera} stageEl={stageEl} compact={false} selectOnly />
        </div>
      </div>

      <ShareBottomHud
        document={document}
        frames={frames}
        camera={camera}
        stageEl={stageEl}
        stageBackground={stageBackground}
        selectedFrameIds={selectedFrameIds}
        selectedNodeIds={selectedNodeIds}
        onCameraChange={onCameraChange}
        zoomPercent={zoomPercent}
        zoomFitActive={zoomFitActive}
        onZoomIn={onZoomIn}
        onZoomOut={onZoomOut}
        onFitView={onFitView}
        zoomAtStageCenter={zoomAtStageCenter}
      />
    </div>
  );
}

export default memo(SharePreviewStage);
