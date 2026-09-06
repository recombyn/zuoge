/**
 * Sole paint-route resolver for idle ink.
 * Sharpness = remesh / restamp / artboard tiles — never DomHost-for-blur.
 */
import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import {
  isGeneratorNode,
  isImageProcessRunning,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { nodeOwnerFrameId } from '@/components/rcb/frames/frameNodeBinding';
import { worldNodeStacksAboveAnyFrame } from '@/components/rcb/scene/document/sceneDocument';
import { canIdlePaintOnCanvas } from '@/components/rcb/render/sceneRenderer';
import {
  atlasZoomBucket,
  idleMediaScreenEdgePx,
  SOA_ATLAS_INNER,
} from '@/components/rcb/render/webglInstanceAtlas';

export type PaintIntent =
  | { kind: 'gpu-mesh' }
  | { kind: 'atlas-stamp'; zoomBucket: number }
  | { kind: 'artboard-tile' }
  | { kind: 'dom-obligatory'; reason: string };

export type PaintIntentCtx = {
  zoom: number;
  dpr: number;
  /** Camera gesture — artboard may use low-res proxy. */
  gesture?: boolean;
  raised?: boolean;
  revealed?: boolean;
  forceFull?: boolean;
  holdHost?: boolean;
  /** Owning artboard idle ink (FO tile path), not world mesh. */
  artboardInk?: boolean;
};

let paintDebugStats = {
  restamp: 0,
  artboardTiles: 0,
  insufficient: 0,
  domObligatory: 0,
};

export function resetPaintIntentDebugStats(): void {
  paintDebugStats = {
    restamp: 0,
    artboardTiles: 0,
    insufficient: 0,
    domObligatory: 0,
  };
}

export function getPaintIntentDebugStats(): typeof paintDebugStats {
  return { ...paintDebugStats };
}

export function notePaintRestamp(n = 1): void {
  paintDebugStats.restamp += n;
}

export function noteArtboardTiles(n = 1): void {
  paintDebugStats.artboardTiles += n;
}

/** True when media display edge exceeds one atlas cell (needs restamp / multi-cell — not DomHost). */
export function backingInsufficientForAtlas(
  node:
    | {
        key?: unknown;
        width?: unknown;
        height?: unknown;
      }
    | null
    | undefined,
  zoom: number,
  dpr = 1
): boolean {
  if (!node) return false;
  const key = String(node.key || '');
  if (key !== 'image' && key !== 'video' && key !== 'audio') return false;
  const screenEdge = idleMediaScreenEdgePx(
    Number(node.width) || 1,
    Number(node.height) || 1,
    zoom,
    dpr
  );
  return screenEdge > SOA_ATLAS_INNER;
}

function setHas(
  ids: ReadonlySet<string> | readonly string[] | undefined,
  id: string
): boolean {
  if (!ids) return false;
  return ids instanceof Set
    ? ids.has(id)
    : (ids as readonly string[]).includes(id);
}

/**
 * Resolve how idle paint should draw this node.
 * DomHost only for obligatory browser surfaces / selection raise over plates / stack.
 */
export function resolvePaintIntent(
  document: SceneDocument | null | undefined,
  id: string,
  node: SceneNodeInput | null | undefined,
  ctx: PaintIntentCtx
): PaintIntent {
  const zoom = Math.max(0.05, Number(ctx.zoom) || 1);
  const dpr = Math.max(0.5, Number(ctx.dpr) || 1);
  const bucket = atlasZoomBucket(zoom);

  if (ctx.forceFull) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'force-full' };
  }
  if (ctx.holdHost) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'hold-host' };
  }
  if (!node) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'missing-node' };
  }
  if (isImageProcessRunning(node)) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'image-process' };
  }

  const key = String(node.key || '');
  if (key === 'lottie' || key === 'group') {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: key };
  }

  const plateBound = Boolean(nodeOwnerFrameId(node));
  const raiseHost =
    (Boolean(ctx.raised) && isGeneratorNode(node)) ||
    (plateBound && (Boolean(ctx.raised) || Boolean(ctx.revealed)));
  if (raiseHost) {
    paintDebugStats.domObligatory += 1;
    return {
      kind: 'dom-obligatory',
      reason: plateBound
        ? ctx.revealed
          ? 'plate-reveal'
          : 'plate-raise'
        : 'generator-raise',
    };
  }

  if (document && worldNodeStacksAboveAnyFrame(document, id)) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'stack-above-plate' };
  }

  if (!canIdlePaintOnCanvas(node)) {
    paintDebugStats.domObligatory += 1;
    return { kind: 'dom-obligatory', reason: 'canvas-ineligible' };
  }

  if (ctx.artboardInk && plateBound) {
    paintDebugStats.artboardTiles += 1;
    return { kind: 'artboard-tile' };
  }

  if (
    key === 'image' ||
    key === 'video' ||
    key === 'audio' ||
    key === 'text'
  ) {
    if (backingInsufficientForAtlas(node, zoom, dpr)) {
      paintDebugStats.insufficient += 1;
    }
    return { kind: 'atlas-stamp', zoomBucket: bucket };
  }

  // Rich path / atlas-bakeable fills share stamp restamp; basics are gpu mesh.
  // Collect path still decides mesh vs atlas; Intent marks mesh as default GPU.
  return { kind: 'gpu-mesh' };
}

/** Whether pickFullAndCanvasIds should mount a DOM host for this id. */
export function paintIntentNeedsDomHost(
  document: SceneDocument | null | undefined,
  id: string,
  node: SceneNodeInput | null | undefined,
  opts: {
    zoom: number;
    dpr: number;
    forceFull?: boolean;
    holdHost?: boolean;
    raised?: boolean;
    revealed?: boolean;
  }
): boolean {
  const intent = resolvePaintIntent(document, id, node, {
    zoom: opts.zoom,
    dpr: opts.dpr,
    forceFull: opts.forceFull,
    holdHost: opts.holdHost,
    raised: opts.raised,
    revealed: opts.revealed,
  });
  return intent.kind === 'dom-obligatory';
}

export function paintIntentSetMembership(
  ids: ReadonlySet<string> | readonly string[] | undefined,
  id: string
): boolean {
  return setHas(ids, id);
}
