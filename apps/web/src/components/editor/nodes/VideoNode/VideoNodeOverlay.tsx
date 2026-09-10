import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  memo,
} from 'react';
import { useSelector } from '@/store';
import { useRcbCamera } from '@/components/rcb';
import { isNodeOverlayHidden, isVideoNode } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  buildScenePlateStyle,
  readOptionalNumber,
  type MediaGeomOverride,
} from '@/components/editor/nodes/shared/mediaPlateGeometry';
import { useHtmlMediaMount } from '@/components/editor/nodes/useHtmlMediaMount';
import VideoHoverPlayback, {
  resolveActiveVideoDecoderId,
} from './VideoHoverPlayback';
import type { SceneDocument } from '@/components/rcb/sceneNode';

export type VideoGeomOverride = MediaGeomOverride;

/** Pan must not re-render every video plate — only push zoom when it changes. */
function VideoZoomSync({ onZoom }: { onZoom: (zoom: number) => void }) {
  const zoom = useRcbCamera().zoom;
  useEffect(() => {
    onZoom(Math.max(0.05, zoom || 1));
  }, [zoom, onZoom]);
  return null;
}

/**
 * Active video decoder: one HTML `<video>` portaled into the SVG foreignObject.
 * Idle (unselected) videos paint as canvas posters — no ShapeHost / FO.
 * Stays mounted during move/resize — FO is inside the SVG group that
 * Kit / DomHost geometry preview drives (same as audio). `geometryOverrides`
 * keeps plate width/height/angle chrome in sync while the editor store is still pre-gesture.
 */
function VideoNodeOverlay({
  document,
  hidden,
  geometryOverrides = null,
}: {
  document: SceneDocument;
  hidden?: boolean;
  /** Live drag/resize/rotate boxes — same scene space as selection chrome. */
  geometryOverrides?: Record<string, VideoGeomOverride> | null;
}): ReactNode {
  const [zoom, setZoom] = useState(1);
  const onZoom = useCallback((z: number) => {
    setZoom((prev) => (Math.abs(prev - z) < 1e-6 ? prev : z));
  }, []);
  const videoToolPanel = useSelector(
    (state: any) => state.editor.videoToolPanel as null | { nodeId: string; kind: string }
  );
  const imageToolPanel = useSelector(
    (state: any) => state.editor.imageToolPanel as null | { nodeId: string; kind: string }
  );
  const selectedNodeIds = useSelector(
    (state: any) => (state.editor.selectedNodeIds as string[] | undefined) || []
  );

  const decoderNodeId = useMemo(
    () =>
      resolveActiveVideoDecoderId({
        document,
        selectedNodeIds,
        videoToolPanel,
      }),
    [document, selectedNodeIds, videoToolPanel]
  );

  if (!decoderNodeId) return null;

  return (
    <>
      <VideoZoomSync onZoom={onZoom} />
      <VideoPlateHost
        nodeId={decoderNodeId}
        document={document}
        zoom={zoom}
        hidden={hidden}
        geometryOverrides={geometryOverrides}
        videoToolPanel={videoToolPanel}
        imageToolPanel={imageToolPanel}
      />
    </>
  );
}

function VideoPlateHost({
  nodeId,
  document,
  zoom,
  hidden,
  geometryOverrides,
  videoToolPanel,
  imageToolPanel,
}: {
  nodeId: string;
  document: SceneDocument;
  zoom: number;
  hidden?: boolean;
  geometryOverrides?: Record<string, VideoGeomOverride> | null;
  videoToolPanel: null | { nodeId: string; kind: string };
  imageToolPanel: null | { nodeId: string; kind: string };
}) {
  const mount = useHtmlMediaMount(nodeId);
  const node = document?.deltaSetLike?.[nodeId];
  if (!node || !isVideoNode(node)) return null;
  const src = String(node.attrs?.src || '').trim();
  if (!src) return null;
  const trimOpen = videoToolPanel?.nodeId === nodeId;
  const cropSession = imageToolPanel?.nodeId === nodeId && imageToolPanel.kind === 'crop';
  const markSession =
    imageToolPanel?.kind === 'mark' || imageToolPanel?.kind === 'quickEdit';
  const scenePlate = buildScenePlateStyle(document, node, geometryOverrides?.[nodeId]);
  return (
    <VideoHoverPlayback
      nodeId={nodeId}
      scenePlate={scenePlate}
      zoom={zoom}
      svgMount={mount}
      src={src}
      poster={String(node.attrs?.poster || '').trim() || undefined}
      uploadKey={String(node.attrs?.uploadKey || node.attrs?.key || '').trim() || null}
      // Keep pixels visible during crop (hiding left only the dark SVG underlay).
      // Playback chrome is suppressed separately via hideChrome.
      hidden={isNodeOverlayHidden(document, node, Boolean(hidden) || trimOpen)}
      hideChrome={cropSession || markSession}
      trimStart={readOptionalNumber(node.attrs?.trimStart)}
      trimEnd={readOptionalNumber(node.attrs?.trimEnd)}
      knownDuration={readOptionalNumber(node.attrs?.duration)}
      flipX={node.attrs?.flipX === true || node.attrs?.flipX === 'true'}
      flipY={node.attrs?.flipY === true || node.attrs?.flipY === 'true'}
      cropX={readOptionalNumber(node.attrs?.cropX)}
      cropY={readOptionalNumber(node.attrs?.cropY)}
      cropW={readOptionalNumber(node.attrs?.cropW)}
      cropH={readOptionalNumber(node.attrs?.cropH)}
    />
  );
}

export default memo(VideoNodeOverlay);
