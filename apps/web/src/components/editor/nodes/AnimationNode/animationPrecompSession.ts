/**
 * LOT tab session: resize workbench to the nested plate and materialize
 * real scene shapes from the precomp JSON (tab-only; revert on exit).
 */
import {
  parseLottieAnimationData,
  serializeLottieAnimationData,
} from '@/components/rcb/scene/document/nodeFactories';
import { removeNodesFromDocument } from '@/components/rcb/scene/document/sceneDocument';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  nodeLeftTop,
  isFrameLocalCoordSpace,
} from '@/components/rcb/scene/layout/nodeLayout';
import { materializeRootShapeLayers, sessionCoversLotInk } from '@/components/editor/nodes/AnimationNode/animationLottieMaterialize';
import {
  extractPrecompAssetJson,
  linkedLotNodeIdFromAsset,
  resolvePrecompAsset,
} from '@/components/editor/nodes/AnimationNode/animationPrecompEditModel';
import { resolveAnimationFrameId } from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import { secToFrame } from '@/components/editor/nodes/AnimationNode/animationTimelineModel';
import { syncPrecompSessionShapesIntoHost } from '@/components/editor/nodes/AnimationNode/animationFrameSync';
import { autoKeyAnimatedGeometry } from '@/components/editor/nodes/AnimationNode/animationAutoKey';
import { isAnimationFrameHostNode } from '@/components/rcb/scene/document/nodeCapabilities';

export const PRECOMP_EDIT_SESSION_ATTR = 'precompEditSession';
/** Bumped on LOT write-back so lottie-web remounts after precomp tab exit. */
export const LOTTIE_INK_REVISION_ATTR = 'lottieInkRevision';

export type FrameGeomSnapshot = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PrecompSessionBegin = {
  document: SceneDocument;
  frameId: string;
  frameSnapshot: FrameGeomSnapshot;
  /** Nested LOT plate-local geom before LOT-tab frame shrink (frameLocal). */
  lotSnapshot: FrameGeomSnapshot | null;
  /** Nested LOT animationData before enter — restore if host write-back would drop ink. */
  lotAnimationSnapshot: string | null;
  lotNodeId: string | null;
  sessionNodeIds: string[];
  /** True only when session shapes fully cover materializable layers (safe to hide ink). */
  sessionHidesLotInk: boolean;
};

export type LottiePrecompEditState = {
  hostNodeId: string;
  assetId: string;
  selectedLayerInd: number | null;
  frameId?: string;
  frameSnapshot?: FrameGeomSnapshot;
  lotSnapshot?: FrameGeomSnapshot | null;
  lotAnimationSnapshot?: string | null;
  lotNodeId?: string | null;
  sessionNodeIds?: string[];
  sessionHidesLotInk?: boolean;
};

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function patchNode(
  doc: SceneDocument,
  nodeId: string,
  patch: Partial<{ x: number; y: number; width: number; height: number; attrs: Record<string, unknown> }>
): SceneDocument {
  const node = doc.deltaSetLike?.[nodeId];
  if (!node) return doc;
  return {
    ...doc,
    deltaSetLike: {
      ...(doc.deltaSetLike || {}),
      [nodeId]: {
        ...node,
        ...patch,
        attrs: patch.attrs ? { ...(node.attrs || {}), ...patch.attrs } : node.attrs,
      },
    },
  };
}

function stripSessionLinks(
  layers: unknown[],
  sessionIds: string[]
): Record<string, unknown>[] {
  return layers.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw as Record<string, unknown>;
    const layer = { ...(raw as Record<string, unknown>) };
    const ln = String(layer.ln || '').trim();
    if (ln && sessionIds.includes(ln)) delete layer.ln;
    return layer;
  });
}

function nextLottieInkRevision(
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): number {
  const prev = Number(node?.attrs?.[LOTTIE_INK_REVISION_ATTR]);
  return Number.isFinite(prev) ? Math.max(0, Math.floor(prev)) + 1 : 1;
}

function unhideLotNode(
  doc: SceneDocument,
  lotId: string,
  extraAttrs?: Record<string, unknown>
): SceneDocument {
  if (!doc.deltaSetLike?.[lotId]) return doc;
  const lot = doc.deltaSetLike[lotId];
  const prevHidden = lot.attrs?.hidden === true || lot.attrs?.hidden === 'true';
  const prevJson = String(lot.attrs?.animationData || '');
  const attrs: Record<string, unknown> = {
    ...(lot.attrs || {}),
    hidden: false,
  };
  if (extraAttrs) Object.assign(attrs, extraAttrs);
  const nextJson = String(attrs.animationData ?? prevJson);
  // 主场景 preview = same live LottiePlate as first open. Bumping revision on every
  // LOT→主场景 exit remounts ink and races SVG paint → blank plate + dead playback.
  if (nextJson !== prevJson) {
    attrs[LOTTIE_INK_REVISION_ATTR] = nextLottieInkRevision(lot);
  }
  if (!prevHidden && nextJson === prevJson && !extraAttrs) return doc;
  return patchNode(doc, lotId, { attrs });
}

function lotJsonFromHostExtract(
  hostNode: { attrs?: Record<string, unknown> | null },
  assetId: string,
  sessionIds: string[]
): string | null {
  const childJson = extractPrecompAssetJson(hostNode.attrs?.animationData, assetId);
  if (!childJson) return null;
  const parsed = parseLottieAnimationData(childJson);
  if (!parsed || !Array.isArray(parsed.layers)) return childJson;
  return (
    serializeLottieAnimationData({
      ...parsed,
      layers: stripSessionLinks(parsed.layers as unknown[], sessionIds),
    }) || childJson
  );
}

function syncHostPrecompAssets(
  doc: SceneDocument,
  hostId: string,
  hostNode: { attrs?: Record<string, unknown> | null },
  assetId: string,
  sessionIds: string[]
): SceneDocument {
  const root = parseLottieAnimationData(
    doc.deltaSetLike?.[hostId]?.attrs?.animationData ?? hostNode.attrs?.animationData
  );
  if (!root || !Array.isArray(root.assets)) return doc;

  const assets = (root.assets as Record<string, unknown>[]).map((asset) => {
    if (!asset || String(asset.id || '') !== assetId) return asset;
    if (!Array.isArray(asset.layers)) return asset;
    return {
      ...asset,
      layers: stripSessionLinks(asset.layers as unknown[], sessionIds),
    };
  });
  const json = serializeLottieAnimationData({ ...root, assets });
  if (!json) return doc;
  return patchNode(doc, hostId, { attrs: { animationData: json } });
}

function lotJsonFallbackFromNode(
  lotAnimRaw: unknown,
  sessionIds: string[]
): string | null {
  const parsed = parseLottieAnimationData(lotAnimRaw);
  if (!parsed || !Array.isArray(parsed.layers)) return null;
  return (
    serializeLottieAnimationData({
      ...parsed,
      layers: stripSessionLinks(parsed.layers as unknown[], sessionIds),
    }) || null
  );
}

function writeBackLotOnPrecompExit(
  doc: SceneDocument,
  hostId: string,
  assetId: string,
  lotId: string | null,
  sessionIds: string[]
): SceneDocument {
  const hostNode = hostId ? doc.deltaSetLike?.[hostId] : null;
  const hostAnim = hostNode?.attrs?.animationData;
  if (hostNode && assetId) {
    let lotJson =
      lotId && hostAnim ? lotJsonFromHostExtract(hostNode, assetId, sessionIds) : null;
    if (!lotJson && lotId) {
      lotJson = lotJsonFallbackFromNode(doc.deltaSetLike?.[lotId]?.attrs?.animationData, sessionIds);
    }
    if (lotId) {
      doc = lotJson ? unhideLotNode(doc, lotId, { animationData: lotJson }) : unhideLotNode(doc, lotId);
    }
    return syncHostPrecompAssets(doc, hostId, hostNode, assetId, sessionIds);
  }
  if (lotId) return unhideLotNode(doc, lotId);
  return doc;
}

/** Keep nested lot JSON aligned with host precomp asset (single source of truth). */
export function syncLotNodeFromHostPrecompAsset(
  document: SceneDocument,
  hostNodeId: string,
  assetId: string,
  sessionIds: string[] = []
): SceneDocument {
  const hostId = String(hostNodeId || '').trim();
  const aid = String(assetId || '').trim();
  const lotId = linkedLotNodeIdFromAsset(aid);
  if (!hostId || !aid || !lotId || !document.deltaSetLike?.[lotId]) return document;
  const host = document.deltaSetLike[hostId];
  if (!host) return document;
  const lotJson = lotJsonFromHostExtract(host, aid, sessionIds);
  if (!lotJson) return document;
  const prev = String(document.deltaSetLike[lotId].attrs?.animationData || '');
  if (prev === lotJson) return document;
  return patchNode(document, lotId, {
    attrs: {
      animationData: lotJson,
      [LOTTIE_INK_REVISION_ATTR]: nextLottieInkRevision(document.deltaSetLike[lotId]),
    },
  });
}

export function isPrecompEditSessionNode(
  node: { attrs?: Record<string, unknown> | null } | null | undefined
): boolean {
  return Boolean(String(node?.attrs?.[PRECOMP_EDIT_SESSION_ATTR] || '').trim());
}

export function listPrecompSessionNodeIds(
  document: SceneDocument | null | undefined,
  assetId: string
): string[] {
  const aid = String(assetId || '').trim();
  if (!document?.deltaSetLike || !aid) return [];
  const out: string[] = [];
  for (const [id, node] of Object.entries(document.deltaSetLike)) {
    if (id === 'ROOT' || !node) continue;
    if (String(node.attrs?.[PRECOMP_EDIT_SESSION_ATTR] || '') === aid) out.push(id);
  }
  return out;
}

export function resolvePrecompSessionNodeIds(
  document: SceneDocument | null | undefined,
  edit: Pick<LottiePrecompEditState, 'assetId' | 'sessionNodeIds'>
): string[] {
  if (edit.sessionNodeIds?.length) return edit.sessionNodeIds;
  return listPrecompSessionNodeIds(document, edit.assetId);
}

function plateForLot(
  document: SceneDocument,
  hostNodeId: string,
  assetId: string
): { left: number; top: number; width: number; height: number; lotNodeId: string | null } | null {
  const lotId = linkedLotNodeIdFromAsset(assetId);
  if (lotId && document.deltaSetLike?.[lotId]) {
    const node = document.deltaSetLike[lotId];
    const { left, top } = nodeLeftTop(document, node);
    return {
      left,
      top,
      width: Math.max(1, Number(node.width) || 1),
      height: Math.max(1, Number(node.height) || 1),
      lotNodeId: lotId,
    };
  }
  const host = document.deltaSetLike?.[hostNodeId];
  if (!host) return null;
  const resolved = resolvePrecompAsset(host.attrs?.animationData, assetId);
  const aw = Math.max(1, resolved?.w || 100);
  const ah = Math.max(1, resolved?.h || 100);
  const { left, top } = nodeLeftTop(document, host);
  const hw = Math.max(1, Number(host.width) || aw);
  const hh = Math.max(1, Number(host.height) || ah);
  const scale = Math.min(hw / aw, hh / ah);
  const contentW = aw * scale;
  const contentH = ah * scale;
  return {
    left: left + (hw - contentW) / 2,
    top: top + (hh - contentH) / 2,
    width: contentW,
    height: contentH,
    lotNodeId: null,
  };
}

/**
 * Stamp `ln` (+ base w/h) onto existing precomp asset layers by `ind` — keep
 * original shapes/keyframes. Replacing the whole layer list on enter was
 * dropping path ink and blanking the LOT tab.
 * Base w/h must land on the host asset so playhead bake / autoKey use Lottie
 * local size — not scene node.width (which already includes plate fit).
 */
function stampSessionLinksIntoHostAsset(
  hostAnimationData: unknown,
  assetId: string,
  maturedLayers: unknown[]
): string | null {
  const root = parseLottieAnimationData(hostAnimationData);
  if (!root || !Array.isArray(root.assets)) return null;
  const metaByInd = new Map<number, { ln: string; w?: number; h?: number }>();
  for (const raw of maturedLayers) {
    if (!raw || typeof raw !== 'object') continue;
    const layer = raw as Record<string, unknown>;
    const ln = String(layer.ln || '').trim();
    const ind = Math.round(num(layer.ind, NaN));
    if (!ln || !Number.isFinite(ind)) continue;
    const w = num(layer.w, 0);
    const h = num(layer.h, 0);
    metaByInd.set(ind, {
      ln,
      ...(w > 0 ? { w } : {}),
      ...(h > 0 ? { h } : {}),
    });
  }
  if (!metaByInd.size) return null;

  const assets = (root.assets as Record<string, unknown>[]).map((asset) => {
    if (!asset || String(asset.id || '') !== assetId) return asset;
    if (!Array.isArray(asset.layers)) return asset;
    const layers = (asset.layers as unknown[]).map((raw) => {
      if (!raw || typeof raw !== 'object') return raw;
      const layer = { ...(raw as Record<string, unknown>) };
      const ind = Math.round(num(layer.ind, NaN));
      const meta = Number.isFinite(ind) ? metaByInd.get(ind) : undefined;
      if (meta) {
        layer.ln = meta.ln;
        if (meta.w != null && !(num(layer.w, 0) > 0)) layer.w = meta.w;
        if (meta.h != null && !(num(layer.h, 0) > 0)) layer.h = meta.h;
      }
      return layer;
    });
    return { ...asset, layers };
  });
  return serializeLottieAnimationData({ ...root, assets });
}

function resolveSourceAnim(
  document: SceneDocument,
  hostAnimationData: unknown,
  assetId: string,
  lotId: string | null
): Record<string, unknown> | null {
  const extracted = extractPrecompAssetJson(hostAnimationData, assetId);
  const fromHost = extracted ? parseLottieAnimationData(extracted) : null;
  if (fromHost) return fromHost;
  if (lotId) {
    const fromLot = parseLottieAnimationData(document.deltaSetLike?.[lotId]?.attrs?.animationData);
    if (fromLot) return fromLot;
  }
  return null;
}

/** LOT tab always rematerializes from JSON — drop stale ln so enter never falls back to overlay. */
function stripAllLayerLinks(anim: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(anim.layers)) return anim;
  const layers = (anim.layers as Record<string, unknown>[]).map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const layer = { ...raw };
    delete layer.ln;
    return layer;
  });
  return { ...anim, layers };
}

/** Enter LOT tab: workbench = plate size; explode JSON → real linked shapes. */
export function beginPrecompEditSession(opts: {
  document: SceneDocument;
  hostNodeId: string;
  assetId: string;
  /** Match main-scene preview pose when exploding (defaults to 0). */
  playheadSec?: number;
}): PrecompSessionBegin | null {
  const hostId = String(opts.hostNodeId || '').trim();
  const assetId = String(opts.assetId || '').trim();
  if (!hostId || !assetId) return null;

  const host = opts.document.deltaSetLike?.[hostId];
  if (!host || host.key !== 'lottie') return null;
  const frameId = resolveAnimationFrameId(opts.document, host);
  if (!frameId) return null;

  const frames = Array.isArray(opts.document.frames) ? [...opts.document.frames] : [];
  const frameIdx = frames.findIndex((f) => String(f?.id) === frameId);
  if (frameIdx < 0) return null;

  const plate = plateForLot(opts.document, hostId, assetId);
  if (!plate) return null;

  const prevFrame = frames[frameIdx];
  const frameSnapshot: FrameGeomSnapshot = {
    x: num(prevFrame.x),
    y: num(prevFrame.y),
    width: Math.max(1, num(prevFrame.width, 1)),
    height: Math.max(1, num(prevFrame.height, 1)),
  };

  const lotId = plate.lotNodeId;
  const frameLocal = isFrameLocalCoordSpace(opts.document);
  let lotSnapshot: FrameGeomSnapshot | null = null;
  let lotAnimationSnapshot: string | null = null;
  if (lotId && opts.document.deltaSetLike?.[lotId]) {
    const lotNode = opts.document.deltaSetLike[lotId];
    lotSnapshot = {
      x: num(lotNode.x),
      y: num(lotNode.y),
      width: Math.max(1, num(lotNode.width, 1)),
      height: Math.max(1, num(lotNode.height, 1)),
    };
    const raw = String(lotNode.attrs?.animationData || '').trim();
    lotAnimationSnapshot = raw || null;
  }

  // Shrink workbench to the nested LOT plate (world).
  frames[frameIdx] = {
    ...prevFrame,
    x: plate.left,
    y: plate.top,
    width: plate.width,
    height: plate.height,
  };

  let doc: SceneDocument = {
    ...opts.document,
    frames,
    deltaSetLike: { ...(opts.document.deltaSetLike || {}) },
  };
  // Host fills the resized plate. frameLocal → local 0,0 (not world plate.left).
  doc = patchNode(doc, hostId, {
    x: frameLocal ? 0 : plate.left,
    y: frameLocal ? 0 : plate.top,
    width: plate.width,
    height: plate.height,
  });
  // Rebase nested LOT into the new plate — otherwise frameLocal children keep
  // their old local x/y and fall outside clipContent (blank 主场景 after tab switch).
  if (lotId && lotSnapshot) {
    doc = patchNode(doc, lotId, {
      x: frameLocal ? 0 : plate.left,
      y: frameLocal ? 0 : plate.top,
      width: plate.width,
      height: plate.height,
    });
  }

  const sourceAnim = resolveSourceAnim(doc, host.attrs?.animationData, assetId, lotId);
  if (!sourceAnim) return null;
  const materializeAnim = stripAllLayerLinks(sourceAnim);

  const fps = Math.max(1, num(materializeAnim.fr, 30));
  const sampleFrame = secToFrame(Math.max(0, Number(opts.playheadSec) || 0), fps);

  const matured = materializeRootShapeLayers({
    document: doc,
    frameId,
    animationData: materializeAnim,
    plate: {
      x: frameLocal ? 0 : plate.left,
      y: frameLocal ? 0 : plate.top,
      width: plate.width,
      height: plate.height,
    },
    sampleFrame,
  });

  // Resize always; materialize when layers are simple rect/ellipse.
  if (!matured?.nodeIds.length) {
    return {
      document: doc,
      frameId,
      frameSnapshot,
      lotSnapshot,
      lotAnimationSnapshot,
      lotNodeId: lotId,
      sessionNodeIds: [],
      sessionHidesLotInk: false,
    };
  }

  doc = matured.document;
  for (const id of matured.nodeIds) {
    doc = patchNode(doc, id, { attrs: { [PRECOMP_EDIT_SESSION_ATTR]: assetId } });
  }

  const maturedParsed = parseLottieAnimationData(matured.animationJson);
  const maturedLayers = Array.isArray(maturedParsed?.layers)
    ? (maturedParsed!.layers as unknown[])
    : [];
  // Stamp ln only — never replace asset layers with a re-serialized subset
  // (that permanently deleted path/image layers and blanked the LOT).
  const hostJson = stampSessionLinksIntoHostAsset(
    doc.deltaSetLike?.[hostId]?.attrs?.animationData ?? host.attrs?.animationData,
    assetId,
    maturedLayers
  );
  if (hostJson) {
    doc = patchNode(doc, hostId, { attrs: { animationData: hostJson } });
  }
  const sessionHidesLotInk = sessionCoversLotInk(sourceAnim, matured.nodeIds.length);
  // Keep nested lot in the SVG paint tree (no attrs.hidden). Removing the node
  // from SVG drops the foreignObject mount; after LOT tab exit the 主场景 lottie
  // overlay never reattaches. Ink hide during LOT edit is overlay-only.

  return {
    document: doc,
    frameId,
    frameSnapshot,
    lotSnapshot,
    lotAnimationSnapshot,
    lotNodeId: lotId,
    sessionNodeIds: matured.nodeIds,
    sessionHidesLotInk,
  };
}

/** Flush LOT-tab scene edits (incl. keyed transforms) into host JSON. */
function flushPrecompSessionEditsIntoHost(opts: {
  document: SceneDocument;
  hostNodeId: string;
  assetId: string;
  sessionNodeIds: string[];
  frameId: string;
  playheadSec: number;
}): SceneDocument {
  let doc = opts.document;
  const hostId = String(opts.hostNodeId || '').trim();
  for (const nodeId of opts.sessionNodeIds) {
    const keyed = autoKeyAnimatedGeometry({
      document: doc,
      nodeId,
      playheadSec: Math.max(0, Number(opts.playheadSec) || 0),
      moved: true,
      resized: true,
    });
    if (!keyed?.hostId || !keyed.animationJson) continue;
    const host = doc.deltaSetLike?.[keyed.hostId];
    if (!host) continue;
    doc = patchNode(doc, keyed.hostId, {
      attrs: { animationData: keyed.animationJson },
    });
  }
  return syncPrecompSessionShapesIntoHost({
    document: doc,
    hostNodeId: hostId,
    assetId: opts.assetId,
    sessionNodeIds: opts.sessionNodeIds,
    frameId: opts.frameId,
  });
}

/** Write LOT-tab shape edits into host precomp + nested lot immediately (not only on tab exit). */
export function persistPrecompSessionEdits(
  document: SceneDocument,
  edit: LottiePrecompEditState,
  playheadSec = 0
): SceneDocument {
  const hostId = String(edit.hostNodeId || '').trim();
  const assetId = String(edit.assetId || '').trim();
  const frameId = String(edit.frameId || '').trim();
  const sessionIds = resolvePrecompSessionNodeIds(document, edit);
  if (!hostId || !assetId || !frameId || !sessionIds.length) return document;
  let doc = flushPrecompSessionEditsIntoHost({
    document,
    hostNodeId: hostId,
    assetId,
    sessionNodeIds: sessionIds,
    frameId,
    playheadSec: Math.max(0, Number(playheadSec) || 0),
  });
  return syncLotNodeFromHostPrecompAsset(doc, hostId, assetId, sessionIds);
}

/** Leave LOT tab: write-back JSON, drop session shapes, restore workbench size. */
export function endPrecompEditSession(opts: {
  document: SceneDocument;
  hostNodeId: string;
  assetId: string;
  frameId: string;
  frameSnapshot: FrameGeomSnapshot;
  lotSnapshot?: FrameGeomSnapshot | null;
  lotAnimationSnapshot?: string | null;
  lotNodeId: string | null;
  sessionNodeIds: string[];
  playheadSec?: number;
}): SceneDocument {
  let doc = flushPrecompSessionEditsIntoHost({
    document: opts.document,
    hostNodeId: opts.hostNodeId,
    assetId: opts.assetId,
    sessionNodeIds: opts.sessionNodeIds,
    frameId: opts.frameId,
    playheadSec: Math.max(0, Number(opts.playheadSec) || 0),
  });

  const hostId = String(opts.hostNodeId || '').trim();
  const assetId = String(opts.assetId || '').trim();
  const frameId = String(opts.frameId || '').trim();
  const sessionIds = opts.sessionNodeIds.filter(Boolean);
  const lotId = opts.lotNodeId || linkedLotNodeIdFromAsset(assetId);
  const frameLocal = isFrameLocalCoordSpace(doc);

  doc = writeBackLotOnPrecompExit(doc, hostId, assetId, lotId, sessionIds);

  // If write-back lost layers vs enter snapshot, restore the original LOT JSON
  // then re-apply host-synced transforms only when session fully covered ink.
  if (lotId && opts.lotAnimationSnapshot && doc.deltaSetLike?.[lotId]) {
    const snap = parseLottieAnimationData(opts.lotAnimationSnapshot);
    const now = parseLottieAnimationData(doc.deltaSetLike[lotId].attrs?.animationData);
    const snapCount = Array.isArray(snap?.layers) ? snap!.layers.length : 0;
    const nowCount = Array.isArray(now?.layers) ? now!.layers.length : 0;
    if (snapCount > 0 && nowCount < snapCount) {
      doc = patchNode(doc, lotId, {
        attrs: { animationData: opts.lotAnimationSnapshot },
      });
    }
  }

  if (sessionIds.length) doc = removeNodesFromDocument(doc, sessionIds);

  if (frameId) {
    const frames = Array.isArray(doc.frames) ? [...doc.frames] : [];
    const idx = frames.findIndex((f) => String(f?.id) === frameId);
    if (idx >= 0) {
      frames[idx] = { ...frames[idx], ...opts.frameSnapshot };
      doc = { ...doc, frames };
    }
    const host = doc.deltaSetLike?.[hostId];
    if (host && isAnimationFrameHostNode(host, doc)) {
      doc = patchNode(
        doc,
        hostId,
        frameLocal
          ? {
              x: 0,
              y: 0,
              width: opts.frameSnapshot.width,
              height: opts.frameSnapshot.height,
            }
          : { ...opts.frameSnapshot }
      );
    }
    if (lotId && opts.lotSnapshot && doc.deltaSetLike?.[lotId]) {
      doc = patchNode(doc, lotId, { ...opts.lotSnapshot });
    }
  }

  return doc;
}

/** Apply end session when the editor store edit state has a restorable snapshot. */
export function endPrecompEditFromState(
  document: SceneDocument,
  edit: LottiePrecompEditState,
  playheadSec = 0
): SceneDocument | null {
  if (!edit.frameId || !edit.frameSnapshot) return null;
  return endPrecompEditSession({
    document,
    hostNodeId: edit.hostNodeId,
    assetId: edit.assetId,
    frameId: edit.frameId,
    frameSnapshot: edit.frameSnapshot,
    lotSnapshot: edit.lotSnapshot ?? null,
    lotAnimationSnapshot: edit.lotAnimationSnapshot ?? null,
    lotNodeId: edit.lotNodeId ?? null,
    sessionNodeIds: resolvePrecompSessionNodeIds(document, edit),
    playheadSec,
  });
}
