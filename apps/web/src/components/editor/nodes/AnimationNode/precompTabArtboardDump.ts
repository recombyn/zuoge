/**
 * BIG copyable dumps for 主场景 ↔ LOT tab blank bugs.
 * Always logs (not DEV-gated) — paste the yellow [precomp-tab] warn strings back.
 */
import { extractPrecompAssetJson } from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import {
  getMainSceneLotPreviewState,
  isMainSceneLotPreviewReady,
  resolveLottieInkJson,
  resolveMainSceneNestedLotAnimationJson,
} from '@/components/editor/nodes/AnimationNode/mainSceneLotPreview';
import { getLottiePrecompEditFocus } from '@/components/editor/nodes/AnimationNode/animationPrecompEditFocus';
import { isHiddenByAnimationWorkbenchFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { animationHostHasUnlinkedInk } from '@/components/editor/nodes/AnimationNode/animationFrameSync';
import { getNodeTransformPreview } from '@/components/rcb/core/transformPreview';
import { parseLottieAnimationData } from '@/components/rcb/scene/document/nodeFactories';
import { findHtmlMediaMount } from '@/components/rcb/scene/dom/domHostBoard';
import { getShapeHost } from '@/components/rcb/shapes/shapeHostRegistry';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import store from '@/store';

/** Cap huge JSON so DevTools still copies; bump if needed. */
const JSON_DUMP_MAX = 120_000;

function clipJson(raw: string | null | undefined): {
  len: number;
  clipped: boolean;
  json: string;
} {
  const s = String(raw || '');
  if (s.length <= JSON_DUMP_MAX) return { len: s.length, clipped: false, json: s };
  return {
    len: s.length,
    clipped: true,
    json: `${s.slice(0, JSON_DUMP_MAX)}\n/*…clipped ${s.length - JSON_DUMP_MAX} chars…*/`,
  };
}

function layerStats(anim: Record<string, unknown> | null | undefined) {
  const layers = Array.isArray(anim?.layers) ? (anim!.layers as unknown[]) : [];
  let shape = 0;
  let precomp = 0;
  let other = 0;
  for (const raw of layers) {
    if (!raw || typeof raw !== 'object') continue;
    const ty = Number((raw as { ty?: unknown }).ty);
    if (ty === 4) shape += 1;
    else if (ty === 0) precomp += 1;
    else other += 1;
  }
  return { total: layers.length, shape, precomp, other };
}

function inkBrief(json: string | null | undefined) {
  const raw = String(json || '').trim();
  if (!raw) return { ok: false as const, jsonLen: 0 };
  const anim = parseLottieAnimationData(raw);
  if (!anim) return { ok: false as const, jsonLen: raw.length, parseFail: true };
  const layers = Array.isArray(anim.layers) ? (anim.layers as Record<string, unknown>[]) : [];
  const L0 = layers[0] || null;
  const shapes = Array.isArray(L0?.shapes) ? (L0!.shapes as unknown[]) : [];
  const ks = (L0?.ks || {}) as Record<string, any>;
  const p0 = Array.isArray(ks.p?.k) ? ks.p.k[0] : ks.p?.k;
  const s0 = Array.isArray(ks.s?.k) ? ks.s.k[0] : ks.s?.k;
  const hasRc = shapes.some((s) => s && typeof s === 'object' && (s as any).ty === 'rc');
  return {
    ok: true as const,
    jsonLen: raw.length,
    w: anim.w,
    h: anim.h,
    layerCount: layers.length,
    shapeCount: shapes.length,
    layerTy: L0?.ty,
    layerNm: L0?.nm,
    layerInd: L0?.ind,
    p0,
    s0,
    hasRc,
    layersBrief: layers.slice(0, 8).map((l) => ({
      ty: l?.ty,
      nm: l?.nm,
      ind: l?.ind,
      ln: (l as any)?.ln,
      w: l?.w,
      h: l?.h,
      shapes: Array.isArray(l?.shapes) ? (l.shapes as any[]).map((s) => s?.ty) : [],
    })),
  };
}

function nodeBrief(id: string, node: any) {
  const attrs = node?.attrs || {};
  return {
    id,
    key: node?.key,
    name: attrs.name || attrs.label || undefined,
    x: node?.x,
    y: node?.y,
    w: node?.width,
    h: node?.height,
    frameId: attrs.frameId || undefined,
    hidden: Boolean(attrs.hidden),
    workbenchHidden: isHiddenByAnimationWorkbenchFocus(node),
    animationFrameHost: Boolean(attrs.animationFrameHost),
    precompEditSession: attrs.precompEditSession || undefined,
    hasAnimJson: Boolean(String(attrs.animationData || '').trim()),
    animJsonLen: String(attrs.animationData || '').length || undefined,
    inkRevision: attrs.lottieInkRevision ?? undefined,
    shapeType: attrs.shapeType || undefined,
    fill: attrs['fill-color'] || attrs.fill || undefined,
    opacity: attrs.opacity,
    angle: attrs.angle,
    radiusTL: attrs.radiusTL ?? attrs.cornerRadius ?? undefined,
    lottieLayerInd: attrs.lottieLayerInd,
    transformPreviewHidden: Boolean(getNodeTransformPreview(id)?.hidden),
  };
}

function mountDomBrief(nodeId: string) {
  const host = getShapeHost(nodeId);
  const mount = findHtmlMediaMount(host?.el ?? host?.layer ?? null);
  if (!mount) return { present: false as const };
  const el = mount as HTMLElement | SVGElement;
  const cs = typeof window !== 'undefined' ? window.getComputedStyle(el) : null;
  const parent = el.parentElement as HTMLElement | SVGElement | null;
  const parentCs = parent && typeof window !== 'undefined' ? window.getComputedStyle(parent) : null;
  return {
    present: true as const,
    tag: el.tagName,
    childElementCount: el.childElementCount,
    innerLen: String((el as any).innerHTML || '').length,
    hasNestedSvg: Boolean(el.querySelector?.('svg')),
    styleVisibility: el.style?.visibility || '',
    styleOpacity: el.style?.opacity || '',
    computedVisibility: cs?.visibility || '',
    computedOpacity: cs?.opacity || '',
    computedDisplay: cs?.display || '',
    parentTag: parent?.tagName || null,
    parentStyleVisibility: parent?.style?.visibility || '',
    parentComputedVisibility: parentCs?.visibility || '',
    parentComputedOpacity: parentCs?.opacity || '',
  };
}

function emit(label: string, payload: unknown) {
  const text =
    typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  // warn = yellow, hard to miss / filter vs info
  // eslint-disable-next-line no-console
  console.warn(`[precomp-tab] ${label}\n${text}`);
}

/** Recover stuck hide styles left on the shared SVG mount (LOT-tab leftover). */
export function clearStuckLottieMountVisibility(nodeId: string) {
  const id = String(nodeId || '').trim();
  if (!id) return;
  const host = getShapeHost(id);
  const mount = findHtmlMediaMount(host?.el ?? host?.layer ?? null);
  if (!mount) return;
  const el = mount as HTMLElement | SVGElement;
  el.style?.removeProperty?.('visibility');
  el.style?.removeProperty?.('opacity');
  el.removeAttribute?.('opacity');
}

export type PrecompTabDumpReason =
  | 'tab→precomp'
  | 'tab→main'
  | 'enter-session'
  | 'exit-session'
  | string;

/**
 * Snapshot + FULL animation JSON strings for paste-back.
 * Always on (not DEV-gated).
 */
export function logPrecompTabArtboardDump(
  reason: PrecompTabDumpReason,
  opts?: {
    hostNodeId?: string | null;
    assetId?: string | null;
    frameId?: string | null;
    lotNodeId?: string | null;
  }
) {
  try {
    const editor = (store.getState() as { editor?: any }).editor;
    const doc = editor?.document as SceneDocument | null | undefined;
    if (!doc) {
      emit(String(reason), { document: null, hint: 'store.editor.document missing' });
      return;
    }

    const pre = editor?.lottiePrecompEdit as null | {
      hostNodeId?: string;
      assetId?: string;
      frameId?: string;
      lotNodeId?: string | null;
      sessionNodeIds?: string[];
      sessionHidesLotInk?: boolean;
    };

    const hostNodeId = String(opts?.hostNodeId || pre?.hostNodeId || '').trim();
    const assetId = String(opts?.assetId || pre?.assetId || '').trim();
    let frameId = String(opts?.frameId || pre?.frameId || doc.activeFrameId || '').trim();
    let lotNodeId = String(opts?.lotNodeId || pre?.lotNodeId || '').trim();
    if (!lotNodeId && assetId.startsWith('lot_')) lotNodeId = assetId.slice(4);

    const host = hostNodeId ? doc.deltaSetLike?.[hostNodeId] : null;
    if (!frameId && host) frameId = String(host.attrs?.frameId || '').trim();

    const frame = (doc.frames || []).find((f) => String(f?.id) === frameId) || null;
    const bound: ReturnType<typeof nodeBrief>[] = [];
    for (const [id, node] of Object.entries(doc.deltaSetLike || {})) {
      if (!node || id === 'ROOT') continue;
      if (frameId && String(node.attrs?.frameId || '').trim() !== frameId) continue;
      bound.push(nodeBrief(id, node));
    }
    bound.sort((a, b) => String(a.id).localeCompare(String(b.id)));

    const lot = lotNodeId ? doc.deltaSetLike?.[lotNodeId] : null;
    const plateJson = lot ? String(lot.attrs?.animationData || '').trim() : '';
    const hostRootJson = host ? String(host.attrs?.animationData || '').trim() : '';
    const hostAssetJson =
      host && assetId ? extractPrecompAssetJson(host.attrs?.animationData, assetId) : null;
    const resolvedJson = lot
      ? resolveLottieInkJson(doc, lotNodeId, lot, { hostFallback: true })
      : null;
    const mainPreferHost = lotNodeId
      ? resolveMainSceneNestedLotAnimationJson(doc, lotNodeId)
      : null;
    const lotAnim = lot ? parseLottieAnimationData(lot.attrs?.animationData) : null;
    const hostAssetAnim = hostAssetJson ? parseLottieAnimationData(hostAssetJson) : null;
    const focus = getLottiePrecompEditFocus();

    if (String(reason).includes('exit') || String(reason).includes('tab→main')) {
      if (lotNodeId) clearStuckLottieMountVisibility(lotNodeId);
    }

    const sessionNodes = (pre?.sessionNodeIds || [])
      .map((id) => nodeBrief(id, doc.deltaSetLike?.[id]))
      .filter(Boolean);

    const summary = {
      reason,
      tab: pre ? 'LOT/precomp' : '主场景/main',
      coordSpace: doc.coordSpace || null,
      frameId: frameId || null,
      frame: frame
        ? {
            name: (frame as { name?: string }).name,
            x: frame.x,
            y: frame.y,
            w: frame.width,
            h: frame.height,
          }
        : null,
      host: hostNodeId ? nodeBrief(hostNodeId, host) : null,
      hostUnlinkedInk: host
        ? animationHostHasUnlinkedInk(host.attrs?.animationData)
        : null,
      lot: lotNodeId
        ? {
            ...nodeBrief(lotNodeId, lot),
            layers: layerStats(lotAnim),
            previewReady: isMainSceneLotPreviewReady(doc, lotNodeId),
            previewState: getMainSceneLotPreviewState(doc, lotNodeId),
            ink: {
              plate: inkBrief(plateJson),
              hostAsset: inkBrief(hostAssetJson),
              resolved: inkBrief(resolvedJson),
              mainPreferHost: inkBrief(mainPreferHost),
              plateEqHost:
                Boolean(plateJson) &&
                Boolean(hostAssetJson) &&
                plateJson === hostAssetJson,
              resolvedSource:
                resolvedJson && resolvedJson === plateJson
                  ? 'plate'
                  : resolvedJson && resolvedJson === hostAssetJson
                    ? 'hostAsset'
                    : resolvedJson
                      ? 'other'
                      : 'none',
            },
            mountDom: mountDomBrief(lotNodeId),
          }
        : null,
      hostAssetLayers: layerStats(hostAssetAnim),
      precompEdit: pre
        ? {
            hostNodeId: pre.hostNodeId,
            assetId: pre.assetId,
            lotNodeId: pre.lotNodeId,
            sessionHidesLotInk: pre.sessionHidesLotInk,
            sessionCount: (pre.sessionNodeIds || []).length,
            sessionNodeIds: pre.sessionNodeIds || [],
          }
        : null,
      sessionNodes,
      focus,
      boundToFrame: bound,
      boundCount: bound.length,
      selectedFrameIds: editor?.selectedFrameIds || [],
      selectedNodeIds: editor?.selectedNodeIds || [],
      playheadSec: editor?.lottiePlayheadSec,
      sceneReloadToken: editor?.sceneReloadToken,
      jsonLens: {
        hostRoot: hostRootJson.length,
        hostAsset: hostAssetJson?.length || 0,
        plate: plateJson.length,
        resolved: resolvedJson?.length || 0,
        mainPreferHost: mainPreferHost?.length || 0,
      },
    };

    emit(`${reason} SUMMARY (copy this)`, summary);

    // Separate full JSON strings — easiest to paste one-by-one
    emit(
      `${reason} JSON hostRoot`,
      clipJson(hostRootJson)
    );
    emit(
      `${reason} JSON hostAsset (${assetId || 'no-assetId'})`,
      clipJson(hostAssetJson)
    );
    emit(`${reason} JSON plate`, clipJson(plateJson));
    emit(`${reason} JSON resolved`, clipJson(resolvedJson));
    emit(`${reason} JSON mainPreferHost`, clipJson(mainPreferHost));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[precomp-tab] dump failed',
      reason,
      err instanceof Error ? err.stack || err.message : String(err)
    );
  }
}

/** After Redux mutators flush — dump microtask + after paint. Always on. */
export function schedulePrecompTabArtboardDump(
  reason: PrecompTabDumpReason,
  opts?: Parameters<typeof logPrecompTabArtboardDump>[1]
) {
  queueMicrotask(() => logPrecompTabArtboardDump(reason, opts));
  if (typeof window !== 'undefined' && import.meta.env.MODE !== 'test') {
    window.setTimeout(() => logPrecompTabArtboardDump(`${reason}:afterPaint`, opts), 100);
    window.setTimeout(() => logPrecompTabArtboardDump(`${reason}:afterPaint400`, opts), 400);
  }
}

// Manual: in DevTools console → __dumpPrecompTab('manual')
if (typeof window !== 'undefined') {
  (window as any).__dumpPrecompTab = (reason = 'manual') => {
    logPrecompTabArtboardDump(String(reason));
  };
}
