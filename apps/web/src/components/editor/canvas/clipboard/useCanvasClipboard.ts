import { useCallback, useEffect, type RefObject } from 'react';

import { addNodeToDocument } from '@/components/rcb/scene/document/sceneDocument';
import {
  createSvgNode,
  createTextNode,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  nodeIdsInsideFrames,
  pasteClipboardIntoDocument,
  parseAndValidateSceneClipboardJson,
  resolveSelectionNodeIds,
  selectionAfterClipboardPaste,
  snapshotFramesForClipboard,
  snapshotNodesForClipboard,
  clipboardNodesBounds,
  type SceneClipboardPayload,
} from '@/components/rcb/scene/document/sceneClipboard';
import { selectionMutationBlocked } from '../ctxMenuGuards';
import {
  defaultTextWrapWidthForFontSize,
  measurePlainTextSize,
  measureWrappedTextSize,
} from '@/components/rcb/scene/document/sceneText';
import { getDocumentGridSize, snapCoordToGrid } from '@/components/rcb/selection/alignGuides';
import { rcbPlaceTextFontSize } from '@/components/rcb/core/layout';
import {
  commitPastedDocument,
  setDocument,
  setMixedSelection,
  setSelectedNodeId,
  setSelectedNodeIds,
  touchDocumentRevision,
} from '@/store/modules/editor';
import {
  beginPastePerf,
  endPastePerfAfterPaint,
  markPastePerf,
} from '@/components/editor/sceneEvents';
import {
  decodeClipboardSvgText,
  fileLooksLikeSvg,
  fingerprintSystemPaste,
  looksLikeSvgMarkup,
  measureSvgMarkupSize,
  readSystemPasteFromNavigator,
  readSystemPastePayload,
  type SystemPastePayload,
} from '../systemPaste';
import {
  canvasBulkItemCount,
  runCanvasBulkOp,
} from '../canvasBulkOpLoading';
import i18n from '@/i18n';

/** Multi-select chrome + SoA in one sync commit froze 64× paste at 2k+. */
const DEFER_PASTE_SELECTION_AT = 24;

/** Coalesce dock wakes across rapid Ctrl+V — LayerPanel rebuild must not stack. */
let pasteChromeRaf = 0;
let pasteChromeSelect: { nodeIds: string[]; frameIds: string[] } | null = null;

function schedulePasteChromeAfterPaint(sel: {
  nodeIds: string[];
  frameIds: string[];
  applySelect: boolean;
}): void {
  if (sel.applySelect) {
    pasteChromeSelect = { nodeIds: sel.nodeIds, frameIds: sel.frameIds };
  }
  if (pasteChromeRaf) return;
  pasteChromeRaf = requestAnimationFrame(() => {
    pasteChromeRaf = 0;
    const pending = pasteChromeSelect;
    pasteChromeSelect = null;
    touchDocumentRevision();
    if (pending) setMixedSelection(pending);
  });
}

function commitPasteThenSelect(opts: {
  document: unknown;
  newIds: string[];
  newFrameIds: string[];
  sel: { nodeIds: string[]; frameIds: string[] };
}): void {
  const large =
    opts.newIds.length + opts.newFrameIds.length >= DEFER_PASTE_SELECTION_AT;
  commitPastedDocument({
    document: opts.document as never,
    patchedNodeIds: opts.newIds,
    addedFrameIds: opts.newFrameIds,
    // Clear prior multi-select during the Kit commit — keep 64 chrome off the
    // critical path, then apply the new selection after paint.
    selectedNodeIds: large ? [] : opts.sel.nodeIds,
    selectedFrameIds: large ? [] : opts.sel.frameIds,
  });
  markPastePerf('commitPastedDocument', {
    patched: opts.newIds.length,
    selectedNodes: large ? 0 : opts.sel.nodeIds.length,
    selectedFrames: large ? 0 : opts.sel.frameIds.length,
    deferSelect: large,
  });
  endPastePerfAfterPaint();
  schedulePasteChromeAfterPaint({
    nodeIds: opts.sel.nodeIds,
    frameIds: opts.sel.frameIds,
    applySelect: large,
  });
}

export type CanvasClipboardApi = {
  copySelected: (nodeIds?: string[], frameIds?: string[]) => boolean;
  cutSelected: (nodeIds?: string[], frameIds?: string[]) => void;
  pasteClipboard: (opts?: { anchor?: { x: number; y: number } }) => void;
  duplicateSelected: (nodeIds?: string[], frameIds?: string[]) => void;
  pasteFromOsOrInternal: (opts?: {
    anchor?: { x: number; y: number } | null;
    data?: DataTransfer | null;
  }) => Promise<void>;
};

type UseCanvasClipboardArgs = {
  readOnly: boolean;
  artboardWidth?: number;
  documentRef: RefObject<any>;
  selectedIdsRef: RefObject<string[]>;
  selectedFrameIdsRef: RefObject<string[]>;
  activeFrameIdRef: RefObject<string | null>;
  clipboardRef: RefObject<SceneClipboardPayload | null>;
  internalClipboardAtRef: RefObject<number>;
  osClipboardMetaRef: RefObject<{ fingerprint: string; at: number }>;
  imagePlaceAtRef: RefObject<{ x: number; y: number } | null>;
  deleteCanvasSelection: (opts?: {
    nodeIds?: string[];
    frameIds?: string[];
    skipLoading?: boolean;
  }) => boolean;
  placeOriginForSize: (
    size: { width: number; height: number },
    anchor?: { x: number; y: number } | null
  ) => { x: number; y: number } | null;
  finishToSelect: () => void;
  getZoom?: () => number;
  onImageFile: (file: File | null) => void | Promise<void>;
  onVideoFile: (file: File | null) => void | Promise<void>;
  onAudioFile: (file: File | null) => void | Promise<void>;
  onLottiePaste: (payload: {
    animationData: Record<string, unknown>;
    name?: string;
    anchor?: { x: number; y: number } | null;
  }) => void | Promise<void>;
  getPasteAnchor?: () => { x: number; y: number } | null;
};

export function useCanvasClipboard(args: UseCanvasClipboardArgs): CanvasClipboardApi {
  const {
    readOnly,
    artboardWidth,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    clipboardRef,
    internalClipboardAtRef,
    osClipboardMetaRef,
    imagePlaceAtRef,
    deleteCanvasSelection,
    placeOriginForSize,
    finishToSelect,
    getZoom,
    onImageFile,
    onVideoFile,
    onAudioFile,
    onLottiePaste,
    getPasteAnchor,
  } = args;
  const resolveCopyTargets = useCallback(
    (nodeIds?: string[], frameIds?: string[]) => {
      const doc = documentRef.current;
      if (!doc) return null;
      let nodes = nodeIds ? [...nodeIds] : [...selectedIdsRef.current];
      let frames = frameIds ? [...frameIds] : [...selectedFrameIdsRef.current];
      if (!frames.length && !nodes.length && activeFrameIdRef.current) {
        frames = [activeFrameIdRef.current];
      }
      if (frames.length) {
        nodes = [...new Set([...nodes, ...nodeIdsInsideFrames(doc, frames)])];
      }
      const expanded = resolveSelectionNodeIds(doc, nodes, frames);
      if (selectionMutationBlocked(doc, expanded.length ? expanded : nodes, frames)) return null;
      return {
        doc,
        nodes,
        frames,
        count: canvasBulkItemCount(expanded.length || nodes.length, frames.length),
      };
    },
    [activeFrameIdRef, documentRef, selectedFrameIdsRef, selectedIdsRef]
  );

  /** Sync snapshot into memory clipboard (no loading toast). */
  const copySelectedNow = useCallback(
    (nodeIds?: string[], frameIds?: string[]) => {
      const targets = resolveCopyTargets(nodeIds, frameIds);
      if (!targets) return false;
      const { doc, nodes, frames } = targets;
      const nodeSnap = nodes.length ? snapshotNodesForClipboard(doc, nodes) : null;
      const frameSnap = snapshotFramesForClipboard(doc, frames);
      if (!nodeSnap?.nodes?.length && !frameSnap.length) return false;
      clipboardRef.current = {
        nodes: nodeSnap?.nodes || [],
        ...(frameSnap.length ? { frames: frameSnap } : {}),
      };
      internalClipboardAtRef.current = performance.now();
      const osPayload = clipboardRef.current;
      void (async () => {
        try {
          if (!navigator.clipboard?.writeText) return;
          await navigator.clipboard.writeText(JSON.stringify(osPayload));
        } catch {
          /* ignore — memory clipboard still works */
        }
      })();
      return true;
    },
    [clipboardRef, internalClipboardAtRef, resolveCopyTargets]
  );

  const copySelected = useCallback(
    (nodeIds?: string[], frameIds?: string[]) => {
      const targets = resolveCopyTargets(nodeIds, frameIds);
      if (!targets) return false;
      const { count, nodes, frames } = targets;
      runCanvasBulkOp({
        count,
        label: i18n.t('editor.bulkOp.copying', { defaultValue: '正在复制…' }),
        run: () => {
          copySelectedNow(nodes, frames);
        },
      });
      return true;
    },
    [copySelectedNow, resolveCopyTargets]
  );

  const cutSelected = useCallback(
    (nodeIds?: string[], frameIds?: string[]) => {
      const targets = resolveCopyTargets(nodeIds, frameIds);
      if (!targets) return;
      const { count, nodes, frames } = targets;
      runCanvasBulkOp({
        count,
        label: i18n.t('editor.bulkOp.cutting', { defaultValue: '正在剪切…' }),
        run: () => {
          if (!copySelectedNow(nodes, frames)) return;
          deleteCanvasSelection({ nodeIds: nodes, frameIds: frames, skipLoading: true });
        },
      });
    },
    [copySelectedNow, deleteCanvasSelection, resolveCopyTargets]
  );

  const pasteValidatedClip = useCallback(
    (clip: SceneClipboardPayload, opts?: { anchor?: { x: number; y: number } }) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return false;
      const clipN = clip.nodes?.length || 0;
      const clipF = clip.frames?.length || 0;
      const count = canvasBulkItemCount(clipN, clipF);
      const apply = () => {
        const liveN = Object.keys(doc.deltaSetLike || {}).length;
        beginPastePerf(`paste clip=${clipN} live≈${liveN}`);
        const g = getDocumentGridSize(doc);
        const nudge = Math.max(10, snapCoordToGrid(10, g));
        const { document: next, ids: newIds, frameIds: newFrameIds } = pasteClipboardIntoDocument(
          doc,
          clip,
          {
            offsetX: nudge,
            offsetY: nudge,
            anchor: opts?.anchor,
            trusted: true,
          }
        );
        markPastePerf('pasteClipboardIntoDocument', {
          newIds: newIds.length,
          newFrames: newFrameIds.length,
          nextNodes: Object.keys(next.deltaSetLike || {}).length,
        });
        if (!newIds.length && !newFrameIds.length) {
          endPastePerfAfterPaint();
          return false;
        }
        documentRef.current = next;
        const sel = selectionAfterClipboardPaste(next, newIds, newFrameIds);
        commitPasteThenSelect({
          document: next,
          newIds,
          newFrameIds,
          sel,
        });
        return true;
      };
      runCanvasBulkOp({
        count,
        label: i18n.t('editor.bulkOp.pasting', { defaultValue: '正在粘贴…' }),
        run: () => {
          apply();
        },
      });
      return true;
    },
    [documentRef, readOnly]
  );

  const pasteClipboard = useCallback(
    (opts?: { anchor?: { x: number; y: number } }) => {
      const payload = clipboardRef.current;
      if (!payload?.nodes?.length && !payload?.frames?.length) return;
      pasteValidatedClip(payload, opts);
    },
    [clipboardRef, pasteValidatedClip]
  );

  const duplicateSelected = useCallback(
    (nodeIds?: string[], frameIds?: string[]) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return;
      let nodes = nodeIds ? [...nodeIds] : [...selectedIdsRef.current];
      let frames = frameIds ? [...frameIds] : [...selectedFrameIdsRef.current];
      if (!frames.length && !nodes.length && activeFrameIdRef.current) {
        frames = [activeFrameIdRef.current];
      }
      if (frames.length) {
        nodes = [...new Set([...nodes, ...nodeIdsInsideFrames(doc, frames)])];
      }
      const expanded = resolveSelectionNodeIds(doc, nodes, frames);
      if (selectionMutationBlocked(doc, expanded.length ? expanded : nodes, frames)) return;
      const count = canvasBulkItemCount(expanded.length || nodes.length, frames.length);
      runCanvasBulkOp({
        count,
        label: i18n.t('editor.bulkOp.duplicating', { defaultValue: '正在创建副本…' }),
        run: () => {
          const liveN = Object.keys(doc.deltaSetLike || {}).length;
          beginPastePerf(`dupe sel=${nodes.length} live≈${liveN}`);
          const nodeSnap = nodes.length ? snapshotNodesForClipboard(doc, nodes) : null;
          const frameSnap = snapshotFramesForClipboard(doc, frames);
          markPastePerf('snapshot', {
            snapNodes: nodeSnap?.nodes?.length || 0,
            snapFrames: frameSnap.length,
          });
          if (!nodeSnap?.nodes?.length && !frameSnap.length) {
            endPastePerfAfterPaint();
            return;
          }
          const snap: SceneClipboardPayload = {
            nodes: nodeSnap?.nodes || [],
            ...(frameSnap.length ? { frames: frameSnap } : {}),
          };
          const bounds = clipboardNodesBounds(snap);
          // Place to the right with a 10px gutter on the snap lattice (default 1px).
          const g = getDocumentGridSize(doc);
          const gap = Math.max(10, g);
          const offsetX = snapCoordToGrid((bounds?.width ?? 0) + gap, g);
          const { document: next, ids: newIds, frameIds: newFrameIds } = pasteClipboardIntoDocument(
            doc,
            snap,
            {
              offsetX,
              offsetY: 0,
              trusted: true,
            }
          );
          markPastePerf('pasteClipboardIntoDocument', {
            newIds: newIds.length,
            newFrames: newFrameIds.length,
            nextNodes: Object.keys(next.deltaSetLike || {}).length,
          });
          if (!newIds.length && !newFrameIds.length) {
            endPastePerfAfterPaint();
            return;
          }
          documentRef.current = next;
          const sel = selectionAfterClipboardPaste(next, newIds, newFrameIds);
          commitPasteThenSelect({
            document: next,
            newIds,
            newFrameIds,
            sel,
          });
        },
      });
    },
    [
      activeFrameIdRef, documentRef,
      readOnly,
      selectedFrameIdsRef,
      selectedIdsRef,
    ]
  );

  const insertPastedText = useCallback(
    (text: string, anchor?: { x: number; y: number } | null) => {
      const doc = documentRef.current;
      const content = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      if (!doc || readOnly || !content.trim()) return false;
      const boardW = Math.max(0, Number(artboardWidth) || 0);
      const zoom = Math.max(0.05, getZoom?.() ?? 1);
      const fontSize = rcbPlaceTextFontSize(zoom, undefined, {
        viewportWidth: undefined,
        docWidth: boardW > 0 ? boardW : undefined,
      });
      // Must track zoom-fitted fontSize — raw 240 scene px is <1 CJK cell at ~5% zoom.
      const maxW = defaultTextWrapWidthForFontSize(fontSize);
      const style = { fontSize };
      const natural = measurePlainTextSize(content, style);
      const wrap = natural.width > maxW;
      const box = wrap
        ? measureWrappedTextSize(content, style, maxW)
        : { width: natural.width, height: natural.height };
      const origin =
        placeOriginForSize({ width: box.width, height: box.height }, anchor) || {
          x: 40,
          y: 40,
        };
      const { id, node } = createTextNode({
        x: origin.x,
        y: origin.y,
        text: content,
        width: box.width,
        height: box.height,
        autoSize: !wrap,
        fontSize,
      });
      const next = addNodeToDocument(doc, id, node);
      documentRef.current = next;
      setDocument(next);
      setSelectedNodeIds([id]);
      setSelectedNodeId(id);
      finishToSelect();
      return true;
    },
    [artboardWidth, documentRef, finishToSelect, getZoom, placeOriginForSize, readOnly]
  );

  const insertPastedSvg = useCallback(
    (markup: string, anchor?: { x: number; y: number } | null) => {
      const doc = documentRef.current;
      if (!doc || readOnly) return false;
      const decoded = decodeClipboardSvgText(markup);
      if (!looksLikeSvgMarkup(decoded)) return false;
      const { width, height, svg } = measureSvgMarkupSize(decoded);
      const origin = placeOriginForSize({ width, height }, anchor) || { x: 40, y: 40 };
      const { id, node } = createSvgNode({
        x: origin.x,
        y: origin.y,
        width,
        height,
        svg,
        name: 'SVG',
      });
      const next = addNodeToDocument(doc, id, node);
      documentRef.current = next;
      setDocument(next);
      setSelectedNodeIds([id]);
      setSelectedNodeId(id);
      finishToSelect();
      return true;
    },
    [documentRef, finishToSelect, placeOriginForSize, readOnly]
  );

  const pasteSystemPayload = useCallback(
    async (
      payload: SystemPastePayload,
      opts?: { anchor?: { x: number; y: number } | null }
    ): Promise<boolean> => {
      if (readOnly) return false;
      const anchor = opts?.anchor ?? null;
      if (payload.kind === 'text') {
        const asClip = parseAndValidateSceneClipboardJson(payload.text);
        if (asClip.valid) {
          return pasteValidatedClip(asClip.data, {
            anchor: opts?.anchor ?? undefined,
          });
        }
        return insertPastedText(payload.text, anchor);
      }
      if (payload.kind === 'svg') return insertPastedSvg(payload.markup, anchor);
      if (payload.kind === 'image') {
        if (fileLooksLikeSvg(payload.file)) {
          try {
            const markup = decodeClipboardSvgText(await payload.file.text());
            if (looksLikeSvgMarkup(markup)) return insertPastedSvg(markup, anchor);
          } catch {
            /* fall through to raster upload */
          }
        }
        imagePlaceAtRef.current = anchor;
        onImageFile(payload.file);
        return true;
      }
      if (payload.kind === 'video') {
        imagePlaceAtRef.current = anchor;
        onVideoFile(payload.file);
        return true;
      }
      if (payload.kind === 'audio') {
        imagePlaceAtRef.current = anchor;
        onAudioFile(payload.file);
        return true;
      }
      if (payload.kind === 'lottie') {
        void onLottiePaste({
          animationData: payload.animationData,
          name: payload.name,
          anchor,
        });
        return true;
      }
      return false;
    },
    [
      imagePlaceAtRef,
      insertPastedSvg,
      insertPastedText,
      onAudioFile,
      onImageFile,
      onLottiePaste,
      onVideoFile,
      pasteValidatedClip,
      readOnly,
    ]
  );

  const pasteFromOsOrInternal = useCallback(
    async (opts?: {
      anchor?: { x: number; y: number } | null;
      data?: DataTransfer | null;
    }) => {
      if (readOnly) return;
      const anchor = opts?.anchor ?? getPasteAnchor?.() ?? null;
      const hasInternal = Boolean(
        clipboardRef.current?.nodes?.length || clipboardRef.current?.frames?.length
      );
      const fromEvent = await readSystemPastePayload(opts?.data ?? null);
      const fromNav =
        !fromEvent && !opts?.data ? await readSystemPasteFromNavigator() : null;
      const system = fromEvent || fromNav;

      if (system) {
        const fp = fingerprintSystemPaste(system);
        if (fp && fp !== osClipboardMetaRef.current.fingerprint) {
          osClipboardMetaRef.current = { fingerprint: fp, at: performance.now() };
        } else if (fp && !osClipboardMetaRef.current.at) {
          osClipboardMetaRef.current = { fingerprint: fp, at: performance.now() };
        }
      }

      const preferInternal =
        hasInternal &&
        (!system || internalClipboardAtRef.current >= osClipboardMetaRef.current.at);

      if (preferInternal) {
        pasteClipboard(anchor ? { anchor } : undefined);
        return;
      }

      if (system) {
        const ok = await pasteSystemPayload(system, { anchor });
        if (ok) return;
      }

      if (hasInternal) {
        pasteClipboard(anchor ? { anchor } : undefined);
      }
    },
    [
      clipboardRef,
      internalClipboardAtRef,
      osClipboardMetaRef,
      pasteClipboard,
      pasteSystemPayload,
      readOnly,
      getPasteAnchor,
    ]
  );

  useEffect(() => {
    if (readOnly) return undefined;

    const isTypingTarget = (t: HTMLElement | null) => {
      if (!t) return false;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        return true;
      }
      return Boolean(
        t.closest?.(
          '[data-fill-panel], [data-color-panel], [data-select-dropdown], [data-frame-label], [data-text-inline-editor], [data-agent-composer]'
        )
      );
    };

    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (isTypingTarget(target)) return;

      const hasInternal = Boolean(
        clipboardRef.current?.nodes?.length || clipboardRef.current?.frames?.length
      );
      const data = e.clipboardData;
      let likelyOs = false;
      if (data) {
        if (data.files?.length) likelyOs = true;
        else {
          try {
            for (const item of Array.from(data.items || [])) {
              if (
                item.kind === 'file' ||
                item.type.startsWith('image/') ||
                item.type.startsWith('video/') ||
                item.type.startsWith('audio/') ||
                item.type === 'application/json' ||
                item.type === 'text/json'
              ) {
                likelyOs = true;
                break;
              }
            }
          } catch {
            /* ignore */
          }
        }
        if (!likelyOs) {
          const plain = String(data.getData('text/plain') || '').trim();
          if (plain) likelyOs = true;
        }
      }

      if (!likelyOs && !hasInternal) return;

      e.preventDefault();
      e.stopPropagation();
      void pasteFromOsOrInternal({ data });
    };

    window.addEventListener('paste', onPaste, true);
    return () => window.removeEventListener('paste', onPaste, true);
  }, [clipboardRef, pasteFromOsOrInternal, readOnly]);

  return {
    copySelected,
    cutSelected,
    pasteClipboard,
    duplicateSelected,
    pasteFromOsOrInternal,
  };
}
