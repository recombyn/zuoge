/**
 * Static shape overlay while editing a Lottie precomp (lot).
 * Replaces bouncing Lottie ink with selectable AABB + position KF handles.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useSelector } from '@/store';
import { useAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import {
  RcbOverlayPortal,
  rcbSceneToScreen,
  useRcbCamera,
  useRcbDevicePixelRatio,
  useRcbScreenToScene,
} from '@/components/rcb';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  extractPrecompAssetJson,
  linkedLotNodeIdFromAsset,
  lottieLocalToScenePoint,
  parsePrecompEditableLayers,
  patchPrecompLayerGeometry,
  patchPrecompPositionKeyframe,
  resolvePrecompAsset,
  samplePositionAtTime,
  scenePointToPrecompLocal,
  type PrecompEditableLayer,
  type PrecompEditPlate,
} from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import type { LottiePrecompEditState } from '@/components/editor/nodes/AnimationNode/animationPrecompSession';
import {
  patchDocumentNode,
  setLottiePrecompSelectedLayer,
} from '@/store/modules/editor';

type DragMode =
  | { kind: 'move'; ind: number; startLocal: { x: number; y: number }; origin: PrecompEditableLayer }
  | {
      kind: 'resize';
      ind: number;
      handle: 'nw' | 'ne' | 'sw' | 'se';
      startLocal: { x: number; y: number };
      origin: PrecompEditableLayer;
    }
  | {
      kind: 'kf';
      ind: number;
      frame: number;
      startLocal: { x: number; y: number };
      originX: number;
      originY: number;
    };

function plateForTarget(
  document: SceneDocument,
  hostNodeId: string,
  assetId: string
): { plate: PrecompEditPlate; animW: number; animH: number } | null {
  const lotId = linkedLotNodeIdFromAsset(assetId);
  const host = document.deltaSetLike?.[hostNodeId];
  if (!host) return null;
  const resolved = resolvePrecompAsset(host.attrs?.animationData, assetId);
  const animW = resolved?.w || 100;
  const animH = resolved?.h || 100;
  if (lotId && document.deltaSetLike?.[lotId]) {
    const node = document.deltaSetLike[lotId];
    const { left, top } = nodeLeftTop(document, node);
    return {
      plate: {
        left,
        top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
      },
      animW,
      animH,
    };
  }
  const { left, top } = nodeLeftTop(document, host);
  return {
    plate: {
      left,
      top,
      width: Math.max(1, Number(host.width) || 1),
      height: Math.max(1, Number(host.height) || 1),
    },
    animW,
    animH,
  };
}

function layerSceneBox(
  layer: PrecompEditableLayer,
  plate: PrecompEditPlate,
  animW: number,
  animH: number,
  /** When set, AABB follows playhead-sampled position (skip while draft/drag uses layer.cx). */
  playheadSec?: number | null
) {
  const sampled =
    playheadSec != null ? samplePositionAtTime(layer.positionKfs, playheadSec) : null;
  const cx = sampled?.x ?? layer.cx;
  const cy = sampled?.y ?? layer.cy;
  const tl = lottieLocalToScenePoint(cx - layer.w / 2, cy - layer.h / 2, plate, animW, animH);
  const br = lottieLocalToScenePoint(cx + layer.w / 2, cy + layer.h / 2, plate, animW, animH);
  return {
    left: Math.min(tl.x, br.x),
    top: Math.min(tl.y, br.y),
    width: Math.max(1, Math.abs(br.x - tl.x)),
    height: Math.max(1, Math.abs(br.y - tl.y)),
  };
}

function AnimationPrecompEditOverlay({
  document,
  hidden = false,
}: {
  document: SceneDocument;
  hidden?: boolean;
}): ReactNode {  const camera = useRcbCamera();
  const dpr = useRcbDevicePixelRatio();
  const toScene = useRcbScreenToScene();
  const edit = useSelector(
    (s: any) => s.editor.lottiePrecompEdit as LottiePrecompEditState | null
  );
  const playhead = useAnimationPlayheadSec();
  const dragRef = useRef<DragMode | null>(null);
  const [draft, setDraft] = useState<PrecompEditableLayer[] | null>(null);
  const draftRef = useRef<PrecompEditableLayer[] | null>(null);
  draftRef.current = draft;

  const hostNodeId = edit?.hostNodeId || '';
  const assetId = edit?.assetId || '';
  const selectedInd = edit?.selectedLayerInd ?? null;
  const host = hostNodeId ? document.deltaSetLike?.[hostNodeId] : null;
  // Real scene shapes replace the static overlay when the LOT tab session materialized.
  const active = Boolean(edit && host && !hidden && !edit.sessionNodeIds?.length);

  const target = useMemo(
    () => (active ? plateForTarget(document, hostNodeId, assetId) : null),
    [active, assetId, document, hostNodeId]
  );

  const layers = useMemo(() => {
    if (!active || !host) return [];
    return draft || parsePrecompEditableLayers(host.attrs?.animationData, assetId);
  }, [active, assetId, draft, host]);

  useEffect(() => {
    setDraft(null);
  }, [assetId, hostNodeId, host?.attrs?.animationData]);

  const commitHostJson = useCallback(
    (json: string | null) => {
      if (!json || !hostNodeId) return;
      patchDocumentNode({
          nodeId: hostNodeId,
          patch: { attrs: { animationData: json } },
        });
      const lotId = linkedLotNodeIdFromAsset(assetId);
      if (lotId && document.deltaSetLike?.[lotId]) {
        const childJson = extractPrecompAssetJson(json, assetId);
        if (childJson) {
          patchDocumentNode({
              nodeId: lotId,
              patch: { attrs: { animationData: childJson } },
            });
        }
      }
      setDraft(null);
    },
    [assetId, document.deltaSetLike, hostNodeId]
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !target) return;
      const scene = toScene(e.clientX, e.clientY);
      const local = scenePointToPrecompLocal(
        scene.x,
        scene.y,
        target.plate,
        target.animW,
        target.animH
      );
      if (drag.kind === 'move') {
        const dx = local.x - drag.startLocal.x;
        const dy = local.y - drag.startLocal.y;
        setDraft((prev) => {
          const base =
            prev ||
            parsePrecompEditableLayers(host?.attrs?.animationData, assetId);
          return base.map((layer) =>
            layer.ind === drag.ind
              ? { ...layer, cx: drag.origin.cx + dx, cy: drag.origin.cy + dy }
              : layer
          );
        });
        return;
      }
      if (drag.kind === 'resize') {
        const dx = local.x - drag.startLocal.x;
        const dy = local.y - drag.startLocal.y;
        let { cx, cy, w, h } = drag.origin;
        const left = cx - w / 2;
        const top = cy - h / 2;
        const right = cx + w / 2;
        const bottom = cy + h / 2;
        let nL = left;
        let nT = top;
        let nR = right;
        let nB = bottom;
        if (drag.handle.includes('w')) nL = left + dx;
        if (drag.handle.includes('e')) nR = right + dx;
        if (drag.handle.includes('n')) nT = top + dy;
        if (drag.handle.includes('s')) nB = bottom + dy;
        w = Math.max(8, nR - nL);
        h = Math.max(8, nB - nT);
        cx = (nL + nR) / 2;
        cy = (nT + nB) / 2;
        setDraft((prev) => {
          const base =
            prev ||
            parsePrecompEditableLayers(host?.attrs?.animationData, assetId);
          return base.map((layer) =>
            layer.ind === drag.ind ? { ...layer, cx, cy, w, h } : layer
          );
        });
        return;
      }
      if (drag.kind === 'kf') {
        const dx = local.x - drag.startLocal.x;
        const dy = local.y - drag.startLocal.y;
        setDraft((prev) => {
          const base =
            prev ||
            parsePrecompEditableLayers(host?.attrs?.animationData, assetId);
          return base.map((layer) => {
            if (layer.ind !== drag.ind) return layer;
            return {
              ...layer,
              cx: drag.originX + dx,
              cy: drag.originY + dy,
              positionKfs: layer.positionKfs.map((kf) =>
                kf.frame === drag.frame
                  ? { ...kf, x: drag.originX + dx, y: drag.originY + dy }
                  : kf
              ),
            };
          });
        });
      }
    },
    [assetId, host?.attrs?.animationData, target, toScene]
  );

  const endDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
    if (!drag || !host) return;
    const live =
      draftRef.current ||
      parsePrecompEditableLayers(host.attrs?.animationData, assetId);
    const layer = live.find((l) => l.ind === drag.ind);
    if (!layer) {
      setDraft(null);
      return;
    }
    if (drag.kind === 'kf') {
      const kf = layer.positionKfs.find((k) => k.frame === drag.frame);
      const json = patchPrecompPositionKeyframe({
        hostAnimationData: host.attrs?.animationData,
        assetId,
        layerInd: drag.ind,
        frame: drag.frame,
        x: kf?.x ?? layer.cx,
        y: kf?.y ?? layer.cy,
      });
      commitHostJson(json);
      return;
    }
    const json = patchPrecompLayerGeometry({
      hostAnimationData: host.attrs?.animationData,
      assetId,
      layerInd: layer.ind,
      cx: layer.cx,
      cy: layer.cy,
      w: layer.w,
      h: layer.h,
    });
    commitHostJson(json);
  }, [assetId, commitHostJson, host, onPointerMove]);

  const startDrag = (mode: DragMode) => (e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = mode;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  };

  if (!active || !target) return null;

  const { plate, animW, animH } = target;
  const boardTl = lottieLocalToScenePoint(0, 0, plate, animW, animH);
  const boardBr = lottieLocalToScenePoint(animW, animH, plate, animW, animH);
  const boardLeft = Math.min(boardTl.x, boardBr.x);
  const boardTop = Math.min(boardTl.y, boardBr.y);
  const boardW = Math.abs(boardBr.x - boardTl.x);
  const boardH = Math.abs(boardBr.y - boardTl.y);
  const boardScreen = rcbSceneToScreen(camera, boardLeft, boardTop, dpr);
  const boardScreenBr = rcbSceneToScreen(camera, boardLeft + boardW, boardTop + boardH, dpr);
  const z = Math.max(0.05, camera.zoom || 1);

  const boardStyle: CSSProperties = {
    position: 'absolute',
    left: boardScreen.x,
    top: boardScreen.y,
    width: Math.max(1, boardScreenBr.x - boardScreen.x),
    height: Math.max(1, boardScreenBr.y - boardScreen.y),
    zIndex: 42,
    pointerEvents: 'auto',
    backgroundColor: '#FFFFFF',
    boxShadow: 'inset 0 0 0 1px rgba(15,23,42,0.12)',
  };

  return (
    <RcbOverlayPortal>
      <div
        style={boardStyle}
        data-lottie-precomp-edit-board
        onPointerDown={(e) => {
          // Click empty board — clear selection.
          if (e.target === e.currentTarget) {
            setLottiePrecompSelectedLayer(null);
          }
        }}
      >
        <div
          className="pointer-events-none absolute left-2 top-1.5 truncate text-[11px] font-medium text-slate-600"
          style={{ maxWidth: '90%' }}
        >
          {String(
            resolvePrecompAsset(host?.attrs?.animationData, assetId)?.asset.nm || assetId
          )}
        </div>
      </div>

      {layers.map((layer) => {
        // While drafting (drag), use live cx/cy; otherwise follow playhead.
        const box = layerSceneBox(
          layer,
          plate,
          animW,
          animH,
          draft ? null : playhead
        );
        const tl = rcbSceneToScreen(camera, box.left, box.top, dpr);
        const br = rcbSceneToScreen(camera, box.left + box.width, box.top + box.height, dpr);
        const w = Math.max(4, br.x - tl.x);
        const h = Math.max(4, br.y - tl.y);
        const selected = selectedInd === layer.ind;
        const radius = Math.min(layer.cornerRadius, layer.w / 2, layer.h / 2) * z;

        return (
          <div key={layer.ind}>
            <div
              role="button"
              tabIndex={0}
              data-lottie-precomp-layer={layer.ind}
              style={{
                position: 'absolute',
                left: tl.x,
                top: tl.y,
                width: w,
                height: h,
                zIndex: 43,
                pointerEvents: 'auto',
                background: layer.fill,
                borderRadius: Math.max(0, radius),
                boxShadow: selected
                  ? '0 0 0 1.5px #3388ff, 0 0 0 3px rgba(51,136,255,0.25)'
                  : '0 0 0 1px rgba(15,23,42,0.2)',
                cursor: 'move',
              }}
              onPointerDown={(e) => {
                setLottiePrecompSelectedLayer(layer.ind);
                const scene = toScene(e.clientX, e.clientY);
                const local = scenePointToPrecompLocal(
                  scene.x,
                  scene.y,
                  plate,
                  animW,
                  animH
                );
                const atHead = samplePositionAtTime(layer.positionKfs, playhead);
                startDrag({
                  kind: 'move',
                  ind: layer.ind,
                  startLocal: local,
                  origin: {
                    ...layer,
                    cx: atHead?.x ?? layer.cx,
                    cy: atHead?.y ?? layer.cy,
                  },
                })(e);
              }}
            />
            {selected ? (
              <>
                {(['nw', 'ne', 'sw', 'se'] as const).map((handle) => {
                  const hx = handle.includes('w') ? tl.x : br.x;
                  const hy = handle.includes('n') ? tl.y : br.y;
                  return (
                    <div
                      key={handle}
                      style={{
                        position: 'absolute',
                        left: hx,
                        top: hy,
                        width: 8,
                        height: 8,
                        marginLeft: -4,
                        marginTop: -4,
                        zIndex: 45,
                        pointerEvents: 'auto',
                        background: '#fff',
                        border: '1.5px solid #3388ff',
                        borderRadius: 1,
                        cursor:
                          handle === 'nw' || handle === 'se'
                            ? 'nwse-resize'
                            : 'nesw-resize',
                      }}
                      onPointerDown={(e) => {
                        const scene = toScene(e.clientX, e.clientY);
                        const local = scenePointToPrecompLocal(
                          scene.x,
                          scene.y,
                          plate,
                          animW,
                          animH
                        );
                        const atHead = samplePositionAtTime(layer.positionKfs, playhead);
                        startDrag({
                          kind: 'resize',
                          ind: layer.ind,
                          handle,
                          startLocal: local,
                          origin: {
                            ...layer,
                            cx: atHead?.x ?? layer.cx,
                            cy: atHead?.y ?? layer.cy,
                          },
                        })(e);
                      }}
                    />
                  );
                })}
                {layer.positionKfs.length > 1
                  ? layer.positionKfs.map((kf) => {
                      const pt = lottieLocalToScenePoint(kf.x, kf.y, plate, animW, animH);
                      const scr = rcbSceneToScreen(camera, pt.x, pt.y, dpr);
                      const nearPlayhead = Math.abs(kf.timeSec - playhead) < 0.05;
                      return (
                        <div
                          key={`${layer.ind}-${kf.frame}`}
                          title={`f${kf.frame}`}
                          style={{
                            position: 'absolute',
                            left: scr.x,
                            top: scr.y,
                            width: nearPlayhead ? 12 : 10,
                            height: nearPlayhead ? 12 : 10,
                            marginLeft: nearPlayhead ? -6 : -5,
                            marginTop: nearPlayhead ? -6 : -5,
                            zIndex: 46,
                            pointerEvents: 'auto',
                            borderRadius: 999,
                            background: nearPlayhead ? '#22C55E' : '#86EFAC',
                            border: '2px solid #166534',
                            boxShadow: '0 0 0 1px rgba(255,255,255,0.8)',
                            cursor: 'grab',
                          }}
                          onPointerDown={(e) => {
                            const scene = toScene(e.clientX, e.clientY);
                            const local = scenePointToPrecompLocal(
                              scene.x,
                              scene.y,
                              plate,
                              animW,
                              animH
                            );
                            startDrag({
                              kind: 'kf',
                              ind: layer.ind,
                              frame: kf.frame,
                              startLocal: local,
                              originX: kf.x,
                              originY: kf.y,
                            })(e);
                          }}
                        />
                      );
                    })
                  : null}
              </>
            ) : null}
          </div>
        );
      })}
    </RcbOverlayPortal>
  );
}

export default memo(AnimationPrecompEditOverlay);
