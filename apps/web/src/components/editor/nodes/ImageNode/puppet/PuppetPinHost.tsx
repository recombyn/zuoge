/**
 * Puppet tool: canvas overlay (mesh + pins), SVG warp sync, and toolbar icon.
 * Overlay mounts only while the puppet panel is open so 退—restores image drag.
 * Warp bake is Canvas 2D; apply is event-driven (not a document watcher).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  memo,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useSelector } from '@/store';
import { RcbOverlayPortal, useRcbCamera, rcbSceneToScreen } from '@/components/rcb';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { buildPuppetWarpGrid, bakePuppetWarpDataUrl } from '@/components/rcb/scene/paint/puppetWarp';
import { getFillImageReady } from '@/components/rcb/scene/media/fillImageCache';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import { getAnimationWorkbenchPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { getAnimationPlayheadSec } from '@/components/editor/nodes/AnimationNode/animationTransport';
import type { ImageToolPanelState } from '@/store/modules/editor';
import { patchDocumentNode } from '@/store/modules/editor';
import store from '@/store';
import {
  effectivePuppetPins,
  newPuppetPinId,
  nodeNeedsPuppetWarp,
  readPuppetDensity,
  readPuppetPins,
  type PuppetPin,
} from './puppetModel';
import { autoKeyPuppetPins } from './puppetTimeline';
import {
  RCB_PUPPET_WARP_APPLY,
  requestPuppetWarpApply,
} from './puppetWarpApplyEvent';

const HANDLE = 12;
const MESH_STROKE = 'rgba(255, 107, 53, 0.55)';

function meshPathD(pins: PuppetPin[], density: number, stageW: number, stageH: number) {
  const grid = buildPuppetWarpGrid(pins, density);
  const n = grid.density;
  const cols = n + 1;
  const parts: string[] = [];
  const pt = (x: number, y: number) => {
    const i = (y * cols + x) * 2;
    return `${((grid.destUv[i] ?? 0) * stageW).toFixed(1)},${((grid.destUv[i + 1] ?? 0) * stageH).toFixed(1)}`;
  };
  for (let y = 0; y <= n; y += 1) {
    const row: string[] = [];
    for (let x = 0; x <= n; x += 1) row.push(pt(x, y));
    parts.push(`M ${row.join(' L ')}`);
  }
  for (let x = 0; x <= n; x += 1) {
    const col: string[] = [];
    for (let y = 0; y <= n; y += 1) col.push(pt(x, y));
    parts.push(`M ${col.join(' L ')}`);
  }
  return parts.join(' ');
}

function fpsForNode(document: SceneDocument, nodeId: string) {
  const node = document.deltaSetLike?.[nodeId];
  const frameId = resolveAnimationFrameId(document, node);
  if (!frameId) return 30;
  const frame = (document.frames || []).find((f) => String(f?.id) === frameId);
  const fps = Math.round(Number(frame?.fps) || 30);
  return fps > 0 ? fps : 30;
}

function applyPuppetWarpsFromStore() {
  const editor = (store.getState() as { editor?: { document?: SceneDocument } }).editor;
  const document = editor?.document;
  if (!document) return;
  for (const id of Object.keys(document.deltaSetLike || {})) {
    const node = document.deltaSetLike?.[id];
    if (!node || !nodeNeedsPuppetWarp(node)) continue;
    const src = String(node.attrs?.src || '').trim();
    if (!src) continue;
    const img = getFillImageReady(src);
    if (!img) continue;
    const attrs = (node.attrs || {}) as Record<string, unknown>;
    const frame = secToFrame(getAnimationWorkbenchPlayheadSec(), fpsForNode(document, id));
    const pins = effectivePuppetPins(attrs, frame);
    const dataUrl = bakePuppetWarpDataUrl(img, {
      width: Math.max(1, Math.round(Number(node.width) || 1)),
      height: Math.max(1, Math.round(Number(node.height) || 1)),
      pins,
      attrs,
    });
    if (!dataUrl) continue;
    const sel = `[data-scene-node-id="${id.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"] image`;
    window.document.querySelectorAll(sel).forEach((el) => {
      if (!(el instanceof SVGImageElement)) return;
      el.setAttribute('href', dataUrl);
      el.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
      el.setAttribute('data-puppet-warped', '1');
    });
  }
}

function PuppetOverlay({
  nodeId,
  left,
  top,
  width,
  height,
  angle,
  pins,
  density,
}: {
  nodeId: string;
  left: number;
  top: number;
  width: number;
  height: number;
  angle: number;
  pins: PuppetPin[];
  density: number;
}) {
  const camera = useRcbCamera();
  const z = Math.max(0.05, camera.zoom || 1);
  const dragIdRef = useRef<string | null>(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;

  const origin = rcbSceneToScreen(camera, left, top);
  const stageW = width * z;
  const stageH = height * z;
  const meshD = useMemo(
    () => meshPathD(pins, density, stageW, stageH),
    [pins, density, stageW, stageH]
  );

  const commitPins = useCallback(
    (next: PuppetPin[], skipHistory?: boolean) => {
      const state = store.getState() as {
        editor?: { document?: unknown; lottiePlayheadSec?: number };
      };
      const keyed = autoKeyPuppetPins({
        document: state.editor?.document,
        nodeId,
        pins: next,
        playheadSec: getAnimationPlayheadSec(),
      });
      patchDocumentNode({
          nodeId,
          patch: {
            attrs: {
              puppetEnabled: true,
              puppetPins: next,
              ...(keyed ? { puppetTrack: keyed.track } : null),
            },
          },
          skipHistory,
        });
      requestPuppetWarpApply();
    },
    [nodeId]
  );

  const toUv = (clientX: number, clientY: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return { u: 0, v: 0 };
    let lx = ((clientX - rect.left) / rect.width) * width;
    let ly = ((clientY - rect.top) / rect.height) * height;
    if (angle) {
      const rad = (-angle * Math.PI) / 180;
      const cx = width / 2;
      const cy = height / 2;
      const dx = lx - cx;
      const dy = ly - cy;
      lx = cx + dx * Math.cos(rad) - dy * Math.sin(rad);
      ly = cy + dx * Math.sin(rad) + dy * Math.cos(rad);
    }
    return {
      u: Math.max(0, Math.min(1, lx / Math.max(1, width))),
      v: Math.max(0, Math.min(1, ly / Math.max(1, height))),
    };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const id = dragIdRef.current;
      if (!id) return;
      e.preventDefault();
      commitPins(pinsRef.current.filter((p) => p.id !== id));
      dragIdRef.current = null;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commitPins]);

  const shellStyle: CSSProperties = {
    position: 'absolute',
    left: origin.x,
    top: origin.y,
    width: stageW,
    height: stageH,
    zIndex: 34,
    touchAction: 'none',
    transform: angle ? `rotate(${angle}deg)` : undefined,
    transformOrigin: 'center center',
  };

  const onPlateDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('[data-puppet-pin-handle]')) return;
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();
    const uv = toUv(e.clientX, e.clientY, e.currentTarget);
    commitPins([...pinsRef.current, { id: newPuppetPinId(), u: uv.u, v: uv.v, dx: 0, dy: 0 }]);
  };

  const onPinDown = (e: ReactPointerEvent<HTMLButtonElement>, pinId: string) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation?.();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragIdRef.current = pinId;
  };

  const onPinMove = (e: ReactPointerEvent<HTMLButtonElement>, pinId: string) => {
    if (dragIdRef.current !== pinId) return;
    const plate = e.currentTarget.parentElement;
    if (!plate) return;
    const uv = toUv(e.clientX, e.clientY, plate);
    const next = pinsRef.current.map((p) =>
      p.id === pinId ? { ...p, dx: uv.u - p.u, dy: uv.v - p.v } : p
    );
    pinsRef.current = next;
    commitPins(next, true);
  };

  const onPinUp = (e: ReactPointerEvent<HTMLButtonElement>, pinId: string) => {
    if (dragIdRef.current !== pinId) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    commitPins(pinsRef.current);
  };

  return (
    <RcbOverlayPortal>
      <div
        data-puppet-pin-overlay
        className="pointer-events-auto absolute"
        style={shellStyle}
        onPointerDown={onPlateDown}
      >
        <svg
          className="pointer-events-none absolute inset-0"
          width={stageW}
          height={stageH}
          aria-hidden
        >
          <path d={meshD} fill="none" stroke={MESH_STROKE} strokeWidth={1} />
        </svg>
        {pins.map((pin) => (
          <button
            key={pin.id}
            type="button"
            data-puppet-pin-handle={pin.id}
            aria-label="Puppet pin"
            className="absolute z-[1] rounded-full border-2 border-white bg-[#FF6B35] shadow"
            style={{
              width: HANDLE,
              height: HANDLE,
              left: (pin.u + pin.dx) * width * z - HANDLE / 2,
              top: (pin.v + pin.dy) * height * z - HANDLE / 2,
              cursor: 'grab',
              boxSizing: 'border-box',
            }}
            onPointerDown={(e) => onPinDown(e, pin.id)}
            onPointerMove={(e) => onPinMove(e, pin.id)}
            onPointerUp={(e) => onPinUp(e, pin.id)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              commitPins(pinsRef.current.filter((p) => p.id !== pin.id));
            }}
          />
        ))}
      </div>
    </RcbOverlayPortal>
  );
}

/** Mount once; applies only when `requestPuppetWarpApply` fires. */
function PuppetWarpSyncHost(): ReactNode {
  useEffect(() => {
    const onApply = () => applyPuppetWarpsFromStore();
    window.addEventListener(RCB_PUPPET_WARP_APPLY, onApply);
    onApply();
    return () => window.removeEventListener(RCB_PUPPET_WARP_APPLY, onApply);
  }, []);
  return null;
}

function PuppetPinHost({
  document,
  hidden = false,
}: {
  document: SceneDocument;
  hidden?: boolean;
}): ReactNode {
  const panel = useSelector(
    (s: any) => s.editor.imageToolPanel as ImageToolPanelState | null
  );

  const entry = useMemo(() => {
    if (hidden || panel?.kind !== 'puppet' || !panel.nodeId) return null;
    const nodeId = String(panel.nodeId);
    const node = document.deltaSetLike?.[nodeId];
    if (!node || node.key !== 'image') return null;
    if (!resolveAnimationFrameId(document, node)) return null;
    const { left, top } = nodeLeftTop(document, node);
    const attrs = (node.attrs || {}) as Record<string, unknown>;
    return {
      nodeId,
      left,
      top,
      width: Math.max(1, Number(node.width) || 1),
      height: Math.max(1, Number(node.height) || 1),
      angle: Number(node.attrs?.angle) || 0,
      pins: readPuppetPins(attrs),
      density: readPuppetDensity(attrs),
      layerNode: node,
    };
  }, [document, hidden, panel]);

  return (
    <>
      <PuppetWarpSyncHost />
      {entry ? (
        <PuppetOverlay
          nodeId={entry.nodeId}
          left={entry.left}
          top={entry.top}
          width={entry.width}
          height={entry.height}
          angle={entry.angle}
          pins={entry.pins}
          density={entry.density}
        />
      ) : null}
    </>
  );
}

export default memo(PuppetPinHost);
