import { useEffect, useRef, type MutableRefObject } from 'react';
import type { SceneDocument } from '@/components/rcb/sceneNode';
import {
  buildComposerContext,
  enrichComposerContextThumb,
  rasterizeNodesToPngDataUrl,
  type ComposerContext,
} from '@/components/editor/panels/AgentComposerInput';
import {
  noteCanvasFlyLand,
  playFlyChipToChat,
} from '@/components/editor/panels/agent/composer/flyToChat';
import { canvasAttachToken } from '@/components/editor/panels/agent/canvasAttach';
import { canAttachNodeToChat, canvasAttachPickPayload } from '@/components/rcb/scene/document/mediaLifecycle';
import { captureVideoPosterFrame } from '@/components/rcb/scene/document/nodeFactories';
import {
  expandSelectionWithGroups,
  listGroupMemberIds,
  readNodeGroupId,
} from '@/components/rcb/scene/document/sceneGroups';
import { consumePendingCanvasAttach } from '@/store/modules/editor';

function resolveSharedGroupAttachIds(doc: SceneDocument, ids: string[]): string[] | null {
  if (!doc || !ids || ids.length < 2) return null;
  const first = readNodeGroupId(doc?.deltaSetLike?.[ids[0]]);
  if (!first) return null;
  if (!ids.every((id) => readNodeGroupId(doc?.deltaSetLike?.[id]) === first)) return null;
  const members = listGroupMemberIds(doc, first);
  return members.length >= 2 ? members : ids;
}

async function attachGroupAsComposerChip(opts: {
  doc: SceneDocument;
  groupIds: string[];
  frameId: string | null;
  existing: ComposerContext[];
  insertChip: (ctx: ComposerContext) => void;
}): Promise<boolean> {
  const { doc, groupIds, frameId, existing, insertChip } = opts;
  const base = buildComposerContext(doc, groupIds, frameId, existing);
  if (!base) return false;
  let ctx = await enrichComposerContextThumb(doc, base, {
    nodeIds: groupIds,
    frameId,
  });
  if (ctx && !String(ctx.dataUrl || '').trim()) {
    const dataUrl = await rasterizeNodesToPngDataUrl(doc, groupIds);
    if (dataUrl) {
      ctx = { ...ctx, dataUrl, thumbUrl: String(ctx.thumbUrl || '').trim() || dataUrl };
    }
  }
  if (!ctx) return false;
  insertChip(ctx);
  return true;
}

export async function applyCanvasPickToComposer(opts: {
  document: SceneDocument;
  payload: string | string[];
  existing: ComposerContext[];
  setContexts: (
    next: ComposerContext[] | ((prev: ComposerContext[]) => ComposerContext[])
  ) => void;
  insertChip: (ctx: ComposerContext) => void;
  imagesOnly?: boolean;
}) {
  const {
    document: doc,
    payload,
    existing,
    setContexts,
    insertChip,
    imagesOnly = true,
  } = opts;
  let ids: string[] = [];
  let frameId: string | null = null;
  if (Array.isArray(payload)) {
    ids = payload.map(String).filter(Boolean);
  } else if (String(payload).startsWith('frame:')) {
    frameId = String(payload).slice('frame:'.length);
  } else {
    ids = [String(payload)];
  }

  if (imagesOnly) {
    ids = ids.filter((id) => doc?.deltaSetLike?.[id]?.key !== 'video');
    if (!ids.length && !frameId) return;
  }

  const pushAttachment = (att: ComposerContext) => {
    setContexts((prev: ComposerContext[]) => {
      const base = Array.isArray(prev) ? prev : existing;
      const atts = base.filter((c) => c.kind === 'attachment');
      const inline = base.filter((c) => c.kind !== 'attachment');
      if (atts.some((c) => c.key === att.key) || inline.some((c) => c.key === att.key)) {
        return [...atts, ...inline];
      }
      return [...atts, att, ...inline];
    });
  };

  const groupIds = resolveSharedGroupAttachIds(doc, ids);
  if (groupIds) {
    await attachGroupAsComposerChip({
      doc,
      groupIds,
      frameId,
      existing,
      insertChip,
    });
    return;
  }

  if (ids.length > 1) {
    const videos: string[] = [];
    const images: string[] = [];
    const others: string[] = [];
    for (const mid of ids) {
      const n = doc?.deltaSetLike?.[mid];
      const s = String(n?.attrs?.src || '').trim();
      if (!imagesOnly && n?.key === 'video' && s) videos.push(mid);
      else if (n?.key === 'image' && s) images.push(mid);
      else others.push(mid);
    }

    for (const vid of videos) {
      const n = doc?.deltaSetLike?.[vid];
      const s = String(n?.attrs?.src || '').trim();
      const labeled = buildComposerContext(doc, [vid], null, existing);
      let thumb = String(n?.attrs?.poster || '').trim();
      if (!thumb) {
        try {
          thumb = await captureVideoPosterFrame(s);
        } catch {
          /* optional */
        }
      }
      pushAttachment({
        key: `attach:canvas:${vid}:${Date.now()}`,
        label: labeled?.label || vid,
        kind: 'attachment',
        payload: `[Canvas video]\nid: ${vid}${labeled?.payload ? `\n${labeled.payload}` : ''}`,
        dataUrl: s,
        thumbUrl: thumb || undefined,
      });
    }
    for (const iid of images) {
      const s = String(doc?.deltaSetLike?.[iid]?.attrs?.src || '').trim();
      const labeled = buildComposerContext(doc, [iid], null, existing);
      pushAttachment({
        key: `attach:canvas:${iid}:${Date.now()}`,
        label: labeled?.label || iid,
        kind: 'attachment',
        payload: labeled?.payload || `[Canvas image]\nid: ${iid}`,
        dataUrl: s,
        thumbUrl: s,
      });
    }

    if (others.length > 1) {
      const dataUrl = await rasterizeNodesToPngDataUrl(doc, others);
      if (dataUrl) {
        pushAttachment({
          key: `attach:canvas-group:${Date.now()}`,
          label: 'canvas-group.png',
          kind: 'attachment',
          payload: `[Canvas group]\nids: ${others.join(', ')}`,
          dataUrl,
          thumbUrl: dataUrl,
        });
        return;
      }
      const base = buildComposerContext(doc, others, frameId, existing);
      const ctx = await enrichComposerContextThumb(doc, base, { nodeIds: others, frameId });
      if (ctx) insertChip(ctx);
      return;
    }
    if (others.length === 1) {
      const oid = others[0]!;
      const base = buildComposerContext(doc, [oid], null, existing);
      const ctx = await enrichComposerContextThumb(doc, base, { nodeIds: [oid] });
      if (ctx) insertChip(ctx);
    }
    return;
  }

  if (frameId) {
    const base = buildComposerContext(doc, [], frameId, existing);
    const ctx = await enrichComposerContextThumb(doc, base, { frameId });
    if (ctx) insertChip(ctx);
    return;
  }

  const id = ids[0];
  if (!id) return;
  const node = doc?.deltaSetLike?.[id];
  if (imagesOnly && node?.key === 'video') return;
  const src = String(node?.attrs?.src || '').trim();
  if (node?.key === 'image' && src) {
    const labeled = buildComposerContext(doc, [id], null, existing);
    pushAttachment({
      key: `attach:canvas:${id}:${Date.now()}`,
      label: labeled?.label || id,
      kind: 'attachment',
      payload: labeled?.payload || `[Canvas image]\nid: ${id}`,
      dataUrl: src,
      thumbUrl: src,
    });
    return;
  }

  if (!imagesOnly && node?.key === 'video' && src) {
    const labeled = buildComposerContext(doc, [id], null, existing);
    let thumb = String(node?.attrs?.poster || '').trim();
    if (!thumb) {
      try {
        thumb = await captureVideoPosterFrame(src);
      } catch {
        /* optional */
      }
    }
    pushAttachment({
      key: `attach:canvas:${id}:${Date.now()}`,
      label: labeled?.label || id,
      kind: 'attachment',
      payload: `[Canvas video]\nid: ${id}${labeled?.payload ? `\n${labeled.payload}` : ''}`,
      dataUrl: src,
      thumbUrl: thumb || undefined,
    });
    return;
  }

  const base = buildComposerContext(doc, [id], null, existing);
  const ctx = await enrichComposerContextThumb(doc, base, { nodeIds: [id] });
  if (ctx) insertChip(ctx);
}

export async function flyPickIntoComposer(opts: {
  landId: string;
  document: SceneDocument;
  payload: string | string[];
  existing: ComposerContext[];
  setContexts: (
    next: ComposerContext[] | ((prev: ComposerContext[]) => ComposerContext[])
  ) => void;
  insertChip: (ctx: ComposerContext) => void;
  imagesOnly?: boolean;
}) {
  const { landId, document: doc, payload, ...applyOpts } = opts;
  noteCanvasFlyLand(landId);
  const apply = () =>
    applyCanvasPickToComposer({
      document: doc,
      payload,
      ...applyOpts,
    });
  try {
    await playFlyChipToChat({ onLand: apply });
  } catch {
    await apply();
  }
}

export async function attachSelectionToComposer(opts: {
  hostNodeId: string;
  landId: string;
  document: SceneDocument;
  selectedNodeIds: string[];
  selectedFrameIds: string[];
  existing: ComposerContext[];
  setContexts: (
    next: ComposerContext[] | ((prev: ComposerContext[]) => ComposerContext[])
  ) => void;
  insertChip: (ctx: ComposerContext) => void;
  imagesOnly?: boolean;
}): Promise<boolean> {
  const {
    hostNodeId,
    landId,
    document: doc,
    selectedNodeIds,
    selectedFrameIds,
    existing,
    setContexts,
    insertChip,
    imagesOnly = true,
  } = opts;
  const seed = expandSelectionWithGroups(
    doc,
    (selectedNodeIds || []).filter((id) => id && id !== hostNodeId)
  );
  const attachable = seed.filter((id) =>
    canAttachNodeToChat(doc?.deltaSetLike?.[id], { imagesOnly })
  );
  const frameId = (selectedFrameIds || []).find(Boolean) || null;
  if (!attachable.length && !frameId) return false;
  const payload = canvasAttachPickPayload(attachable, frameId);
  await flyPickIntoComposer({
    landId,
    document: doc,
    payload,
    existing,
    setContexts,
    insertChip,
    imagesOnly,
  });
  return true;
}

/** Toggle pick mode, or attach current selection before entering one-shot pick. */
export async function pickOrAttachFromCanvas(opts: {
  pickingFromCanvas: boolean;
  clearPick: () => void;
  attachSelection: () => Promise<boolean>;
  startPick: () => void;
}): Promise<void> {
  if (opts.pickingFromCanvas) {
    opts.clearPick();
    return;
  }
  const attached = await opts.attachSelection();
  if (!attached) opts.startPick();
}

type PendingAttach = { target: string; payload: string | string[] } | null;

/**
 * One-shot consume of `pendingCanvasAttach` for a node composer (`node:${id}`).
 * Token lock prevents StrictMode / double-flush from inserting the same chip twice.
 */
export function usePendingCanvasAttachFly(opts: {
  pickTarget: string;
  pending: PendingAttach;
  document: SceneDocument | null | undefined;
  contextsRef: MutableRefObject<ComposerContext[]>;
  setContexts: (
    next: ComposerContext[] | ((prev: ComposerContext[]) => ComposerContext[])
  ) => void;
  insertChip: (ctx: ComposerContext) => void;
  imagesOnly?: boolean;
}) {
  const {
    pickTarget,
    pending,
    document: doc,
    contextsRef,
    setContexts,
    insertChip,
    imagesOnly = true,
  } = opts;
  const lockRef = useRef<string | null>(null);
  const insertChipRef = useRef(insertChip);
  insertChipRef.current = insertChip;
  const setContextsRef = useRef(setContexts);
  setContextsRef.current = setContexts;
  const imagesOnlyRef = useRef(imagesOnly);
  imagesOnlyRef.current = imagesOnly;

  useEffect(() => {
    if (!pending) {
      lockRef.current = null;
      return;
    }
    if (pending.target !== pickTarget || !doc) return;
    const token = `pending:${pending.target}:${canvasAttachToken(pending.payload)}`;
    if (lockRef.current === token) {
      consumePendingCanvasAttach();
      return;
    }
    lockRef.current = token;
    const payload = pending.payload;
    consumePendingCanvasAttach();
    void flyPickIntoComposer({
      landId: pickTarget,
      document: doc,
      payload,
      existing: contextsRef.current,
      setContexts: (next) => setContextsRef.current(next),
      imagesOnly: imagesOnlyRef.current,
      insertChip: (ctx) => insertChipRef.current(ctx),
    });
    // One-shot attach — fly reads latest via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, pickTarget, doc]);
}
