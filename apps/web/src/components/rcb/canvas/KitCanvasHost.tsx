/**
 * Kit surface host for RCB stage (lazy-loads mountCore).
 * InputManager draws into WasmScene; CanvasKit paints.
 */
import { useEffect, useRef, useState } from 'react';
import {
  rcbCameraCssZoom,
  rcbCameraScreenOffset,
} from '@/components/rcb/core/math';
import type { RcbCamera } from '@/components/rcb/core/types';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { getDocumentGridSize } from '@/components/rcb/selection/alignGuides';
import { EMPTY_ID_LIST } from '@/store/modules/editor';
import { store, useSelector, type RootState } from '@/store';
import type { CanvasEngineHandle } from './mountCore';
import {
  attachKitBridge,
  detachKitBridge,
  hydrateKitFromDocument,
  reconcileKitWithDocument,
  syncKitArtboardChromeHighlight,
  syncKitGeometryFromDocument,
  syncKitGeometryFromTransformPreviews,
  syncKitLivePaintFromBucketFill,
  syncKitSelectionFromStore,
  syncParametricOutlinesFromDocument,
  getKitSelectionMirrorGeneration,
  syncLiveArtboardPreviewsFromKit,
} from './kitBridge';
import { resolveEngineTool } from './toolMap';
import {
  listNodeTransformPreviewIds,
  subscribeTransformPreview,
} from '@/components/rcb/core/transformPreview';

let sharedHandle: CanvasEngineHandle | null = null;
/** Bumps on every KitCanvasHost mount attempt (StrictMode-safe). */
let kitMountGeneration = 0;

export function getCanvasEngine(): CanvasEngineHandle | null {
  return sharedHandle;
}

export function setEngineToolFromRcb(rcbTool: string, shapeKind?: string | null) {
  sharedHandle?.setTool(resolveEngineTool(rcbTool, shapeKind));
}

function syncCamera(handle: CanvasEngineHandle, camera: RcbCamera, dpr: number) {
  const zoom = rcbCameraCssZoom(camera);
  const pan = rcbCameraScreenOffset(camera, dpr > 0 ? dpr : 1);
  handle.renderer.zoom = zoom;
  handle.renderer.pan.x = pan.x;
  handle.renderer.pan.y = pan.y;
  handle.renderer.requestRender();
  try {
    handle.renderer.notifyViewChange();
  } catch {
    /* optional */
  }
}

type Props = {
  className?: string;
  activeTool?: string;
  interactive?: boolean;
  camera?: RcbCamera;
  dpr?: number;
};

export default function KitCanvasHost({
  className,
  activeTool: _activeToolProp = 'select',
  interactive = true,
  camera,
  dpr = 1,
}: Props) {
  void _activeToolProp; // Store tools are SoT — prop kept for RcbCanvas API compat.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<CanvasEngineHandle | null>(null);
  /** Last Kit→store selection mirror gen absorbed — skip echo push-back. */
  const selectionMirrorSeenRef = useRef(0);
  const [engineReady, setEngineReady] = useState(false);
  const document = useSelector((s: RootState) => s.editor.document as SceneDocument | null);
  const reloadToken = useSelector((s: RootState) => s.editor.sceneReloadToken);
  const documentRevision = useSelector((s: RootState) => s.editor.documentRevision);
  const documentPatchToken = useSelector((s: RootState) => s.editor.documentPatchToken);
  const lastPatchTransformOnly = useSelector((s: RootState) =>
    Boolean(s.editor.lastPatchTransformOnly)
  );
  const lastPatchFromKitCanvas = useSelector((s: RootState) =>
    Boolean((s.editor as { lastPatchFromKitCanvas?: boolean }).lastPatchFromKitCanvas)
  );
  const lastPatchedNodeIds = useSelector(
    (s: RootState) =>
      (s.editor.lastPatchedNodeIds as string[] | undefined)?.length
        ? (s.editor.lastPatchedNodeIds as string[])
        : EMPTY_ID_LIST
  );
  const storeActiveTool = useSelector((s: RootState) => String(s.editor.activeTool || 'select'));
  const storeShapeKind = useSelector((s: RootState) => String(s.editor.shapeKind || 'rect'));
  const penStrokeColor = useSelector((s: RootState) =>
    String(s.editor.penStrokeColor || '#000000')
  );
  const penStrokeWidth = useSelector((s: RootState) => {
    const n = Number(s.editor.penStrokeWidth);
    return Number.isFinite(n) && n > 0 ? n : 1;
  });
  const penFillColor = useSelector((s: RootState) =>
    String(s.editor.penFillColor ?? '#CCCCCC')
  );
  const selectedNodeIds = useSelector(
    (s: RootState) => s.editor.selectedNodeIds || EMPTY_ID_LIST
  );
  const selectedFrameIds = useSelector(
    (s: RootState) => s.editor.selectedFrameIds || EMPTY_ID_LIST
  );
  const frameChromeMode = useSelector((s: RootState) =>
    s.editor.frameChromeMode === 'full' ? 'full' : 'soft'
  );
  const activeFrameId = useSelector((s: RootState) =>
    s.editor.document?.activeFrameId != null
      ? String(s.editor.document.activeFrameId)
      : ''
  );
  const bucketFill = useSelector((s: RootState) => s.editor.bucketFill);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let handle: CanvasEngineHandle | null = null;
    // StrictMode remounts can finish an older async init after a newer one —
    // only the latest generation may own the host DOM / sharedHandle.
    const mountId = ++kitMountGeneration;

    void (async () => {
      try {
        const { createCanvasEngine, loadCanvasKit } = await import('./mountCore');
        const ck = await loadCanvasKit();
        if (cancelled) return;
        handle = await createCanvasEngine(host, ck);
        if (cancelled || mountId !== kitMountGeneration) {
          handle.destroy();
          return;
        }
        engineRef.current = handle;
        sharedHandle = handle;
        attachKitBridge(handle);
        setEngineReady(true);
        handle.setTool(resolveEngineTool(storeActiveTool, storeShapeKind));
        handle.setDrawKeyboard(interactive);
        if (camera) syncCamera(handle, camera, dpr);
        const doc = (store.getState().editor.document as SceneDocument | null) ?? null;
        if (doc) {
          hydrateKitFromDocument(
            handle,
            doc,
            `reload:${store.getState().editor.sceneReloadToken}`
          );
          const g = getDocumentGridSize(doc);
          // Always lock create/pen/artboard to the document lattice (1wu default).
          // isGridMode is display chrome only — snap must not wait on that toggle.
          handle.setGridSnap(g);
        }
      } catch (err) {
        console.error('[rcb/canvas] kit mount failed', err);
        if (!cancelled) setEngineReady(false);
      }
    })();

    return () => {
      cancelled = true;
      setEngineReady(false);
      detachKitBridge();
      if (sharedHandle === handle) sharedHandle = null;
      engineRef.current = null;
      handle?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, []);

  useEffect(() => {
    // Always resolve from the store (shape flyout → shapeKind). Do not trust the
    // `activeTool` prop alone — it can lag Kit one-shot revert and leave
    // renderSelectionOverlay gated off for ellipses.
    sharedHandle?.setTool(resolveEngineTool(storeActiveTool, storeShapeKind));
  }, [storeActiveTool, storeShapeKind]);

  useEffect(() => {
    if (String(storeActiveTool).toLowerCase() !== 'bucket') return;
    syncKitLivePaintFromBucketFill({
      fillType: bucketFill?.fillType,
      fillColor: bucketFill?.fillColor,
      fillOpacity: bucketFill?.fillOpacity,
      fillGradient: bucketFill?.fillGradient,
      fillImageSrc: bucketFill?.fillImageSrc,
      fillImageFit: bucketFill?.fillImageFit,
      fillImageRotate: bucketFill?.fillImageRotate,
      fillImageScale: bucketFill?.fillImageScale,
      fillImageOffsetX: bucketFill?.fillImageOffsetX,
      fillImageOffsetY: bucketFill?.fillImageOffsetY,
      fillImageAdjust: bucketFill?.fillImageAdjust,
    });
  }, [storeActiveTool, bucketFill]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    handle?.setDrawKeyboard(interactive);
  }, [interactive]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    if (!handle) return;
    const g = document ? getDocumentGridSize(document) : 1;
    handle.setGridSnap(g);
  }, [document]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    if (!handle) return;
    // Kit UIEngine.buildCurrentStyleJson: fill #CCCCCC (0.8), stroke #000 1px.
    const stroke = penStrokeColor || '#000000';
    const fill =
      penFillColor && penFillColor !== 'transparent' && penFillColor !== 'none'
        ? penFillColor
        : '#CCCCCC';
    handle.setCreateStyle({
      fill,
      stroke,
      strokeWidth: penStrokeWidth > 0 ? penStrokeWidth : 1,
    });
  }, [storeActiveTool, penStrokeColor, penStrokeWidth, penFillColor]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    if (!handle || !camera) return;
    syncCamera(handle, camera, dpr);
    // Only when pan/zoom/dpr change — not every new camera object identity.
  }, [camera?.x, camera?.y, camera?.zoom, dpr]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    const doc =
      (store.getState().editor.document as SceneDocument | null) ?? document;
    if (!handle || !doc) return;
    hydrateKitFromDocument(handle, doc, `reload:${reloadToken}`);
    // reloadToken is the hydrate gate — do not re-hydrate on every document identity.
  }, [reloadToken, document]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    const doc =
      (store.getState().editor.document as SceneDocument | null) ?? document;
    if (!handle || !doc) return;
    // Kit→doc mirror: engine already has transform/style truth — do not push
    // RCB box/style back. Parametric chrome (sides / IR / Ar) still lives in RCB
    // and must apply even when a Kit flush raced the same revision tick.
    if (lastPatchFromKitCanvas) {
      syncParametricOutlinesFromDocument(handle, doc);
      return;
    }
    // Geometry-only Kit→store flushes must not re-push every node style (lag).
    if (lastPatchTransformOnly) {
      syncKitGeometryFromDocument(
        handle,
        doc,
        lastPatchedNodeIds.length ? lastPatchedNodeIds : undefined
      );
      // Width/height are part of the parametric fingerprint — rebuild outline
      // when chrome resized a polygon/star/donut box.
      syncParametricOutlinesFromDocument(
        handle,
        doc,
        lastPatchedNodeIds.length ? lastPatchedNodeIds : undefined
      );
      return;
    }
    reconcileKitWithDocument(handle, doc);
    // Aspect / W·H toolbar patches that also write lockAspect were historically
    // treated as non-transform-only → reconcile skipped Kit geom. Always push
    // geometry for the patched ids when the write came from RCB chrome.
    if (lastPatchedNodeIds.length) {
      syncKitGeometryFromDocument(handle, doc, lastPatchedNodeIds);
    }
    // Intentionally omit document object identity — revision+token are the truth.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [
    documentRevision,
    documentPatchToken,
    lastPatchTransformOnly,
    lastPatchFromKitCanvas,
    lastPatchedNodeIds,
  ]);

  useEffect(() => {
    if (!engineReady || !document) return;
    // Track last non-empty preview set so clear→empty can restore Kit from doc
    // (preview sync early-returns on empty and must not leave Kit mid-scrub).
    let lastPreviewIds: string[] = listNodeTransformPreviewIds();
    return subscribeTransformPreview(() => {
      const handle = engineRef.current ?? sharedHandle;
      if (!handle) return;
      // Kit: while InputManager owns move/resize/rotate, do not push RCB
      // TransformPreview into Kit — that fights liveFrame and flashes a white AABB.
      if (handle.input?.isMouseDown) return;
      const ids = listNodeTransformPreviewIds();
      if (!ids.length) {
        if (lastPreviewIds.length) {
          syncKitGeometryFromDocument(handle, document, lastPreviewIds);
          lastPreviewIds = [];
        }
        return;
      }
      lastPreviewIds = ids;
      syncKitGeometryFromTransformPreviews(handle, document, ids);
    });
  }, [engineReady, document]);

  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    if (!handle || !engineReady) return;
    // Kit: canvas selection lives in the engine. Kit→store is a one-way mirror
    // for HTML chrome — never echo that write back with clear_selection.
    const gen = getKitSelectionMirrorGeneration();
    if (gen > selectionMirrorSeenRef.current) {
      selectionMirrorSeenRef.current = gen;
      return;
    }
    syncKitSelectionFromStore(handle, selectedNodeIds, selectedFrameIds);
    selectionMirrorSeenRef.current = getKitSelectionMirrorGeneration();
  }, [engineReady, selectedNodeIds, selectedFrameIds]);

  // Soft plate focus can change without selection ids (setSoftFrameContext).
  useEffect(() => {
    const handle = engineRef.current ?? sharedHandle;
    if (!handle || !engineReady) return;
    syncKitArtboardChromeHighlight(handle);
    handle.renderer.requestRender();
  }, [engineReady, frameChromeMode, activeFrameId, selectedFrameIds]);

  // Kit artboard drag: Kit bounds move every frame while inGesture skips flush —
  // mirror into RCB live plate geom so DomHost / clips track.
  useEffect(() => {
    if (!engineReady) return;
    let raf = 0;
    const tick = () => {
      syncLiveArtboardPreviewsFromKit();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engineReady]);

  // Never capture hits until the engine is live — an empty host at z-15 would
  // swallow draw/select gestures with no InputManager attached.
  const liveInteractive = Boolean(interactive && engineReady);

  return (
    <div
      ref={hostRef}
      className={className}
      data-rcb-kit-surface="1"
      data-rcb-kit-ready={engineReady ? '1' : '0'}
      // Stay under host SVG (z-2) so media FO still receives hits; empty SVG
      // areas are pointer-events:none and fall through to Kit (z-1).
      style={{
        pointerEvents: liveInteractive ? 'auto' : 'none',
      }}
    />
  );
}
