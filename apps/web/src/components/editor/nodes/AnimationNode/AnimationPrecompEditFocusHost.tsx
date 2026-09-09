/**
 * Precomp edit: center the lot plate once; restore camera on exit.
 * Isolation paint is owned by animationPrecompEditFocus module.
 * Camera fit/release is event-driven (`requestPrecompCameraFit` / Release).
 */
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { useSelector } from '@/store';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import {
  linkedLotNodeIdFromAsset,
  resolvePrecompAsset,
} from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import {
  setLottiePrecompEditFocus,
} from '@/components/editor/nodes/AnimationNode/animationPrecompEditFocus';
import {
  fitSessionCamera,
  popSessionCamera,
  pushSessionCamera,
  type SessionCameraBandInsets,
  type SessionCameraBounds,
  type SessionCameraFitOpts,
} from '@/utils/sessionCamera';
import { exitLottiePrecompEdit } from '@/store/modules/editor';
import {
  RCB_PRECOMP_CAMERA_FIT,
  RCB_PRECOMP_CAMERA_RELEASE,
} from '@/components/editor/sceneEvents';
import store from '@/store';

const DOCK_FALLBACK_H = 240;
const BOTTOM_BAND_GAP = 40;
const TOP_BAND_INSET = 40;
const MAX_ZOOM = 1.6;
const PADDING = 72;
/** Match 主场—fit — center in the free band above the timeline (not upper-biased). */
const BAND_ANCHOR_Y = 0.5;

function readBottomBandInset(stageEl: HTMLElement | null): number {
  if (!stageEl) return DOCK_FALLBACK_H + BOTTOM_BAND_GAP;
  const stageRect = stageEl.getBoundingClientRect();
  let chromeTop = stageRect.bottom;
  for (const sel of ['[data-tour="editor-tools"]', '[data-lottie-timeline-dock]']) {
    const el = window.document.querySelector(sel) as HTMLElement | null;
    if (!el) continue;
    const top = el.getBoundingClientRect().top;
    if (Number.isFinite(top) && top < chromeTop) chromeTop = top;
  }
  const inset = Math.round(stageRect.bottom - chromeTop);
  return Math.max(DOCK_FALLBACK_H, inset) + BOTTOM_BAND_GAP;
}

function fitOpts(
  stageEl: HTMLElement | null,
  bandLeftPx: number,
  bandRightPx: number
): SessionCameraFitOpts {
  const bandInsets: SessionCameraBandInsets = {
    top: TOP_BAND_INSET,
    right: Math.max(0, bandRightPx),
    bottom: readBottomBandInset(stageEl),
    left: Math.max(0, bandLeftPx),
  };
  return {
    padding: PADDING,
    maxZoom: MAX_ZOOM,
    bandInsets,
    bandAnchorY: BAND_ANCHOR_Y,
  };
}

function boundsForPrecompEdit(
  document: SceneDocument | null | undefined,
  hostNodeId: string,
  assetId: string,
  frameId?: string | null
): SessionCameraBounds | null {
  if (!document) return null;
  const fid = String(frameId || '').trim();
  if (fid) {
    const frame = (Array.isArray(document.frames) ? document.frames : []).find(
      (f: { id?: string }) => String(f?.id) === fid
    );
    if (frame) {
      return {
        x: Number(frame.x) || 0,
        y: Number(frame.y) || 0,
        width: Math.max(1, Number(frame.width) || 1),
        height: Math.max(1, Number(frame.height) || 1),
      };
    }
  }
  const lotId = linkedLotNodeIdFromAsset(assetId);
  if (lotId) {
    const node = document.deltaSetLike?.[lotId];
    if (node) {
      const { left, top } = nodeLeftTop(document, node);
      return {
        x: left,
        y: top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
      };
    }
  }
  const host = document.deltaSetLike?.[hostNodeId];
  if (!host) return null;
  const { left, top } = nodeLeftTop(document, host);
  const resolved = resolvePrecompAsset(host.attrs?.animationData, assetId);
  const aw = resolved?.w || Math.max(1, Number(host.width) || 1);
  const ah = resolved?.h || Math.max(1, Number(host.height) || 1);
  const hw = Math.max(1, Number(host.width) || aw);
  const hh = Math.max(1, Number(host.height) || ah);
  const scale = Math.min(hw / aw, hh / ah);
  const contentW = aw * scale;
  const contentH = ah * scale;
  return {
    x: left + (hw - contentW) / 2,
    y: top + (hh - contentH) / 2,
    width: contentW,
    height: contentH,
  };
}

function AnimationPrecompEditFocusHost({
  document,
  stageEl = null,
  bandLeftPx = 0,
  bandRightPx = 0,
}: {
  document: SceneDocument | null;
  stageEl?: HTMLElement | null;
  bandLeftPx?: number;
  bandRightPx?: number;
}) {
  const edit = useSelector(
    (s: any) =>
      s.editor.lottiePrecompEdit as null | {
        hostNodeId: string;
        assetId: string;
        selectedLayerInd: number | null;
        lotNodeId?: string | null;
        sessionNodeIds?: string[];
        sessionHidesLotInk?: boolean;
        frameId?: string;
      }
  );
  const active = Boolean(edit?.hostNodeId && edit?.assetId);
  const hostNodeId = edit?.hostNodeId || '';
  const assetId = edit?.assetId || '';
  const frameId = edit?.frameId || '';
  const lotNodeId = edit?.lotNodeId ?? linkedLotNodeIdFromAsset(assetId);
  const sessionMaterialized = Boolean(edit?.sessionHidesLotInk);
  const pushedRef = useRef(false);
  const fittedKeyRef = useRef('');
  const stageElRef = useRef(stageEl);
  const bandLeftRef = useRef(bandLeftPx);
  const bandRightRef = useRef(bandRightPx);
  const documentRef = useRef(document);
  stageElRef.current = stageEl;
  bandLeftRef.current = bandLeftPx;
  bandRightRef.current = bandRightPx;
  documentRef.current = document;

  useLayoutEffect(() => {
    setLottiePrecompEditFocus({
      active,
      lotNodeId: active ? lotNodeId : null,
      sessionMaterialized: active ? sessionMaterialized : false,
    });
    return () => {
      if (active) setLottiePrecompEditFocus({ active: false });
    };
  }, [active, lotNodeId, sessionMaterialized]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      exitLottiePrecompEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  useEffect(() => {
    let cancelled = false;
    let tries = 0;
    let raf = 0;

    const release = () => {
      if (pushedRef.current) {
        popSessionCamera();
        pushedRef.current = false;
      }
      fittedKeyRef.current = '';
    };

    const fit = () => {
      cancelled = false;
      tries = 0;
      const apply = () => {
        if (cancelled) return;
        const editor = (store.getState() as { editor?: any }).editor;
        const pre = editor?.lottiePrecompEdit as
          | null
          | { hostNodeId?: string; assetId?: string; frameId?: string };
        const host = String(pre?.hostNodeId || '').trim();
        const asset = String(pre?.assetId || '').trim();
        if (!host || !asset) return;
        const key = `${host}:${asset}`;
        if (fittedKeyRef.current === key && pushedRef.current) return;
        const doc =
          (editor?.document as SceneDocument | null | undefined) || documentRef.current;
        const bounds = boundsForPrecompEdit(doc, host, asset, pre?.frameId);
        if (!bounds) {
          if (tries++ < 16) raf = window.requestAnimationFrame(apply);
          return;
        }
        const fid = String(pre?.frameId || '').trim();
        if (fid && tries < 8) {
          const frame = (Array.isArray(doc?.frames) ? doc!.frames : []).find(
            (f: { id?: string }) => String(f?.id) === fid
          );
          const fw = Math.max(1, Number(frame?.width) || 0);
          const fh = Math.max(1, Number(frame?.height) || 0);
          if (!frame || fw < 1 || fh < 1) {
            tries += 1;
            raf = window.requestAnimationFrame(apply);
            return;
          }
        }
        if (fittedKeyRef.current === key && pushedRef.current) return;
        const opts = fitOpts(stageElRef.current, bandLeftRef.current, bandRightRef.current);
        if (!pushedRef.current) {
          pushSessionCamera(bounds, opts);
          pushedRef.current = true;
        } else {
          fitSessionCamera(bounds, opts);
        }
        fittedKeyRef.current = key;
      };
      raf = window.requestAnimationFrame(apply);
    };

    const onFit = () => fit();
    const onRelease = () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      release();
    };
    window.addEventListener(RCB_PRECOMP_CAMERA_FIT, onFit);
    window.addEventListener(RCB_PRECOMP_CAMERA_RELEASE, onRelease);
    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener(RCB_PRECOMP_CAMERA_FIT, onFit);
      window.removeEventListener(RCB_PRECOMP_CAMERA_RELEASE, onRelease);
      setLottiePrecompEditFocus({ active: false });
      release();
    };
  }, []);

  return null;
}

export default memo(AnimationPrecompEditFocusHost);
