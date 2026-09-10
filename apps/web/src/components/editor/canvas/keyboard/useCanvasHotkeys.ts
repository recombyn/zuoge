import { useEffect, type RefObject } from 'react';

import {
  isGeneratorNode
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  resolveSelectionNodeIds
} from '@/components/rcb/scene/document/sceneClipboard';
import { collectSelectAllTargets } from '@/components/editor/canvas/canvasSession';
import {
  canvasBulkItemCount,
  runCanvasBulkOp,
} from '@/components/editor/canvas/canvasBulkOpLoading';
import i18n from '@/i18n';
import {
  clearCanvasAttachPick,
  closeImageToolPanel,
  redo,
  setActiveFrameId,
  setSelectedFrameIds,
  setSelectedNodeId,
  setSelectedNodeIds,
  undo,
} from '@/store/modules/editor';
import store from '@/store';
import { collabRedo, collabUndo } from '@/components/editor/collab/collabRuntime';
import type { CtxAction } from '@/components/rcb/selection/chrome/CanvasContextMenu';
import { filterChatAttachNodeIds } from '../attachPick';
import { selectionMutationBlocked } from '../ctxMenuGuards';
import { tryConsumeGradientStopDelete } from '@/components/editor/panels/FillPanel';
import {
  tryConsumeLottieTimelineCopy,
  tryConsumeLottieTimelineDelete,
  tryConsumeLottieTimelinePaste,
} from '@/components/editor/nodes/AnimationNode/animationTimelineHotkeys';
import { kitOwnsStagePointer } from '@/components/rcb/canvas/toolMap';
import {
  groupKitSelection,
  redoKit,
  selectionUsesKitClipboard,
  undoKit,
  ungroupKitSelection,
  rcbIdsAllKitMapped,
  deleteKitSelection,
} from '@/components/rcb/canvas/kitBridge';
import { unlockedGroupableIds } from '@/components/rcb/scene/document/sceneGroups';

type UseCanvasHotkeysArgs = {
  readOnly: boolean;
  activeTool: string;
  shapeKind?: string | null;
  documentRef: RefObject<any>;
  selectedIdsRef: RefObject<string[]>;
  selectedFrameIdsRef: RefObject<string[]>;
  activeFrameIdRef: RefObject<string | null>;
  canvasAttachPickRef: RefObject<unknown>;
  imagePlaceAtRef: RefObject<{ x: number; y: number } | null>;
  imageInputRef: RefObject<HTMLInputElement | null>;
  runCtxActionRef: RefObject<(action: CtxAction) => void>;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onSelectMixed: (nodeIds: string[], frameIds: string[]) => void;
  listNodeIds: () => readonly string[];
  deleteCanvasSelection: () => boolean;
  reorderLayer: (dir: 'front' | 'forward' | 'backward' | 'back', ids: string[]) => void;
  copySelected: (nodeIds?: string[], frameIds?: string[]) => boolean;
  cutSelected: (nodeIds?: string[], frameIds?: string[]) => void;
  duplicateSelected: (nodeIds?: string[], frameIds?: string[]) => void;
  onAddToChat?: (target: string | string[]) => void;
};

export function useCanvasHotkeys(args: UseCanvasHotkeysArgs) {
  const {
    readOnly,
    activeTool,
    shapeKind = null,
    documentRef,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    canvasAttachPickRef,
    imagePlaceAtRef,
    imageInputRef,
    runCtxActionRef,
    onZoomIn,
    onZoomOut,
    onSelectMixed,
    listNodeIds,
    deleteCanvasSelection,
    reorderLayer,
    copySelected,
    cutSelected,
    duplicateSelected,
    onAddToChat,
  } = args;
  const kitOwns = () => kitOwnsStagePointer(activeTool, shapeKind);
  useEffect(() => {
    const isTypingTarget = (t: HTMLElement | null) =>
      Boolean(
        t &&
          (t.tagName === 'INPUT' ||
            t.tagName === 'TEXTAREA' ||
            t.isContentEditable ||
            t.closest?.(
              '[data-fill-panel], [data-color-panel], [data-select-dropdown], [data-frame-label], [data-text-inline-editor]'
            ))
      );

    const SCENE_COMPOSER_HOST =
      '[data-image-generator], [data-video-generator], [data-lottie-generator], [data-audio-generator], [data-media-quick-edit]';
    const COMPOSER_HOST = `[data-agent-composer], ${SCENE_COMPOSER_HOST}`;

    const isComposerTarget = (t: HTMLElement | null) => Boolean(t?.closest?.(COMPOSER_HOST));

    const selectionBusy = () => {
      const doc = documentRef.current;
      let frameIds = [...selectedFrameIdsRef.current];
      let nodeIds = [...selectedIdsRef.current];
      if (!frameIds.length && !nodeIds.length && activeFrameIdRef.current) {
        frameIds = [activeFrameIdRef.current];
      }
      const expanded = resolveSelectionNodeIds(doc, nodeIds, frameIds);
      return selectionMutationBlocked(doc, expanded.length ? expanded : nodeIds, frameIds);
    };

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const typing = isTypingTarget(target);
      const inComposer = isComposerTarget(target);

      if (e.key === 'Escape') {
        const panel = store.getState().editor?.imageToolPanel;
        if (
          panel?.kind === 'quickEdit' ||
          (panel?.kind === 'mark' && panel.markSink === 'quickEdit')
        ) {
          e.preventDefault();
          closeImageToolPanel();
          return;
        }
        if (canvasAttachPickRef.current) {
          e.preventDefault();
          clearCanvasAttachPick();
          return;
        }
      }

      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        onZoomIn?.();
      }
      if (mod && e.key === '-') {
        e.preventDefault();
        onZoomOut?.();
      }
      if (mod && e.key === 'z' && !e.shiftKey) {
        if (typing) return;
        e.preventDefault();
        // Kit owns stage history — one owner; stop Kit InputManager from also undoing.
        if (kitOwns()) {
          e.stopImmediatePropagation();
          if (!collabUndo()) {
            if (!undoKit()) undo();
          }
          return;
        }
        if (!collabUndo()) undo();
      }
      if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        if (typing) return;
        e.preventDefault();
        if (kitOwns()) {
          e.stopImmediatePropagation();
          if (!collabRedo()) {
            if (!redoKit()) redo();
          }
          return;
        }
        if (!collabRedo()) redo();
      }
      if (mod && e.key.toLowerCase() === 'a' && activeTool === 'select' && !typing) {
        e.preventDefault();
        const doc = documentRef.current;
        const { nodeIds, frameIds } = collectSelectAllTargets(doc);
        const count = canvasBulkItemCount(nodeIds.length, frameIds.length);
        runCanvasBulkOp({
          count,
          label: i18n.t('editor.bulkOp.selectingAll', { defaultValue: '正在全选…' }),
          run: () => {
            onSelectMixed(nodeIds, frameIds);
          },
        });
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        imagePlaceAtRef.current = null;
        imageInputRef.current?.click();
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'h' && !typing && !readOnly) {
        const ids = selectedIdsRef.current;
        const frameIds = selectedFrameIdsRef.current;
        const targetIds = resolveSelectionNodeIds(documentRef.current, ids, frameIds).filter(
          (id) => !isGeneratorNode(documentRef.current?.deltaSetLike?.[id])
        );
        if (!targetIds.length || selectionBusy()) return;
        e.preventDefault();
        runCtxActionRef.current('toggleHidden');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k' && !typing && !readOnly) {
        const ids = selectedIdsRef.current;
        const frameIds = selectedFrameIdsRef.current;
        const lockableNodes = ids.filter(
          (id) => !isGeneratorNode(documentRef.current?.deltaSetLike?.[id])
        );
        if (!lockableNodes.length && !frameIds.length && !activeFrameIdRef.current) return;
        if (ids.length && !lockableNodes.length && !frameIds.length) return;
        if (selectionBusy()) return;
        e.preventDefault();
        runCtxActionRef.current('toggleLocked');
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'l' && !typing) {
        const clearAfterAddToChat = () => {
          setSelectedNodeIds([]);
          setSelectedNodeId(null);
          setSelectedFrameIds([]);
          setActiveFrameId(null);
        };
        const attachable = filterChatAttachNodeIds(
          documentRef.current,
          resolveSelectionNodeIds(
            documentRef.current,
            selectedIdsRef.current,
            selectedFrameIdsRef.current
          )
        );
        if (attachable.length > 1) {
          e.preventDefault();
          onAddToChat?.(attachable);
          clearAfterAddToChat();
          return;
        }
        const id = attachable[0];
        if (id) {
          e.preventDefault();
          onAddToChat?.(id);
          clearAfterAddToChat();
          return;
        }
        if (selectedIdsRef.current.length || selectedFrameIdsRef.current.length) return;
        if (activeFrameIdRef.current) {
          e.preventDefault();
          onAddToChat?.(`frame:${activeFrameIdRef.current}`);
          clearAfterAddToChat();
        }
      }
      if (mod && !typing && !readOnly) {
        const k = e.key.toLowerCase();
        // Kit owns clipboard for Kit-mapped selection; DomHost-only (lottie/group) stays on RCB.
        if (kitOwns() && (k === 'c' || k === 'x' || k === 'v' || k === 'd')) {
          if (k === 'c' && tryConsumeLottieTimelineCopy()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          if (k === 'v' && tryConsumeLottieTimelinePaste()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          const ids = selectedIdsRef.current;
          const frameIds = selectedFrameIdsRef.current;
          // Artboard-only: Kit Ctrl+X only cuts node selection (not selectedArtboardId).
          // Route frame clipboard / duplicate through RCB.
          const artboardOnly =
            !ids.length && (frameIds.length > 0 || Boolean(activeFrameIdRef.current));
          const useKitClip =
            !artboardOnly && selectionUsesKitClipboard(documentRef.current, ids);
          if (!useKitClip) {
            // DomHost-only, mixed DomHost, or artboard-only: RCB clipboard.
            if (k === 'c') {
              if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
              if (selectionBusy()) return;
              e.preventDefault();
              e.stopImmediatePropagation();
              copySelected(ids, frameIds);
              return;
            }
            if (k === 'x') {
              if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
              if (selectionBusy()) return;
              e.preventDefault();
              e.stopImmediatePropagation();
              cutSelected(ids, frameIds);
              return;
            }
            if (k === 'v') {
              e.preventDefault();
              e.stopImmediatePropagation();
              runCtxActionRef.current('paste');
              return;
            }
            if (k === 'd') {
              if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
              if (selectionBusy()) return;
              e.preventDefault();
              e.stopImmediatePropagation();
              duplicateSelected(ids, frameIds);
              return;
            }
          }
          // Let Kit InputManager handle canvas clipboard / duplicate for Kit-mapped shapes.
          return;
        }
        if (k === 'c') {
          if (tryConsumeLottieTimelineCopy()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          const ids = selectedIdsRef.current;
          const frameIds = selectedFrameIdsRef.current;
          if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
          if (selectionBusy()) return;
          e.preventDefault();
          copySelected(ids, frameIds);
          return;
        }
        if (k === 'x') {
          const ids = selectedIdsRef.current;
          const frameIds = selectedFrameIdsRef.current;
          if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
          if (selectionBusy()) return;
          e.preventDefault();
          cutSelected(ids, frameIds);
          return;
        }
        if (k === 'v') {
          if (tryConsumeLottieTimelinePaste()) {
            e.preventDefault();
            e.stopImmediatePropagation();
            return;
          }
          return;
        }
        if (k === 'd') {
          const ids = selectedIdsRef.current;
          const frameIds = selectedFrameIdsRef.current;
          if (!ids.length && !frameIds.length && !activeFrameIdRef.current) return;
          if (selectionBusy()) return;
          e.preventDefault();
          duplicateSelected(ids, frameIds);
          return;
        }
        if (k === 'g') {
          const ids = selectedIdsRef.current;
          const frameIds = selectedFrameIdsRef.current;
          const targetIds = resolveSelectionNodeIds(documentRef.current, ids, frameIds);
          if (selectionBusy()) return;
          if (kitOwns()) {
            const unlocked = unlockedGroupableIds(documentRef.current, targetIds);
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.shiftKey) {
              if (rcbIdsAllKitMapped(unlocked) && ungroupKitSelection(unlocked)) return;
              runCtxActionRef.current('ungroup');
              return;
            }
            if (unlocked.length < 2) return;
            if (rcbIdsAllKitMapped(unlocked) && groupKitSelection(unlocked)) return;
            runCtxActionRef.current('group');
            return;
          }
          if (targetIds.length < 2 && !e.shiftKey) return;
          e.preventDefault();
          if (e.shiftKey) {
            runCtxActionRef.current('ungroup');
          } else {
            runCtxActionRef.current('group');
          }
          return;
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !readOnly) {
        if (typing && !inComposer) return;
        // Generator / quick-edit / agent composer own Backspace+Delete — even when
        // the prompt is empty. Never fall through to canvas delete (that closed the
        // plate and removed the selected node while the caret was in the input).
        if (inComposer) return;
        const el = target as HTMLElement | null;
        if (
          el &&
          (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        ) {
          return;
        }
        if (tryConsumeGradientStopDelete()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (tryConsumeLottieTimelineDelete()) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (el?.closest?.('[data-fill-panel], [data-color-panel]')) return;
        const ids = selectedIdsRef.current;
        const frameIds = selectedFrameIdsRef.current;
        if (ids.length || frameIds.length || activeFrameIdRef.current) {
          // Kit: explicitly call InputManager.delete* — do not rely on Kit
          // keydown alone (selection can be store-only / drawKeyboard gated).
          if (
            kitOwns() &&
            selectionUsesKitClipboard(documentRef.current, ids) &&
            !frameIds.length
          ) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!deleteKitSelection(ids, [])) {
              deleteCanvasSelection();
            }
            return;
          }
          e.preventDefault();
          deleteCanvasSelection();
        }
      }
      if (e.key === ']' || e.key === '[') {
        const ids = resolveSelectionNodeIds(
          documentRef.current,
          selectedIdsRef.current,
          selectedFrameIdsRef.current
        );
        if (!ids.length || selectionBusy()) return;
        e.preventDefault();
        if (e.key === ']' && mod) reorderLayer('forward', ids);
        else if (e.key === ']') reorderLayer('front', ids);
        else if (e.key === '[' && mod) reorderLayer('backward', ids);
        else reorderLayer('back', ids);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [
    activeFrameIdRef,
    activeTool,
    shapeKind,
    canvasAttachPickRef,
    copySelected,
    cutSelected,
    deleteCanvasSelection, documentRef,
    duplicateSelected,
    imageInputRef,
    imagePlaceAtRef,
    listNodeIds,
    onAddToChat,
    onSelectMixed,
    onZoomIn,
    onZoomOut,
    readOnly,
    reorderLayer,
    runCtxActionRef,
    selectedFrameIdsRef,
    selectedIdsRef,
  ]);
}
