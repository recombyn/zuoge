import {
  groupKitSelection,
  redoKit,
  undoKit,
  ungroupKitSelection,
  rcbIdsAllKitMapped,
} from '@/components/rcb/canvas/kitBridge';
import { kitOwnsStagePointer } from '@/components/rcb/canvas/toolMap';
import { message } from '@/components/base';
import {
  groupNodesInDocument,
  ungroupNodesInDocument,
  unlockedGroupableIds,
} from '@/components/rcb/scene/document/sceneGroups';
import {
  isNodeHidden,
  isNodeLocked,
  isVideoNode,
  isGeneratorNode,
} from '@/components/rcb/scene/document/nodeCapabilities';
import { resolveSelectionNodeIds } from '@/components/rcb/scene/document/sceneClipboard';
import { updateNodeInDocument } from '@/components/rcb/scene/document/sceneDocument';
import { exportFabricImage, exportCropSlots, type ExportImageFormat } from '@/components/rcb/scene/export/exportImage';
import { downloadVideoNodeAsset } from '@/components/editor/nodes/VideoNode/VideoDownloadButton';
import { replaceImageNodeFromFile } from '@/components/editor/nodes/ImageNode/ImageReplaceUploadControl';
import { replaceVideoNodeFromFile } from '@/components/editor/nodes/VideoNode/VideoReplaceCornerButton';
import type { ContextMenuState, CtxAction } from '@/components/rcb/selection/chrome/CanvasContextMenu';
import {
  setActiveFrameId,
  setSelectedFrameIds,
  setMixedSelection,
  updateArtboardFrame,
  updateArtboardFrames,
  setDocument,
  setDocumentFromCanvas,
  pushEditorHistory,
  setSelectedNodeId,
  setSelectedNodeIds,
  spawnImageGenerator,
  spawnVideoGenerator,
  spawnAnimationBoard,
  spawnLottieGeneratorPlate,
  spawnAudioGenerator,
  undo,
  redo,
} from '@/store/modules/editor';
import store from '@/store';
import { layoutGeneratorPlateAtScene } from './canvasSession';
import { MEDIA_PLACE_DEFAULT } from '@/components/rcb/scene/document/nodeFactories';
import { warnIfAvBlockedByAnimationWorkbenchFocus } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import { ctxMenuSeedNodeIds, filterChatAttachNodeIds } from './attachPick';
import { ctxMenuTargetHasProcessing } from './ctxMenuGuards';
import type { CanvasClipboardApi } from './clipboard/useCanvasClipboard';
import type { SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';

export type RunCanvasCtxActionDeps = {
  getCtxMenu: () => ContextMenuState | null;
  clearCtxMenu: () => void;
  selectedIdsRef: { current: string[] };
  selectedFrameIdsRef: { current: string[] };
  activeFrameIdRef: { current: string | null };
  documentRef: { current: any };
  imagePlaceAtRef: { current: { x: number; y: number } | null };
  imageInputRef: { current: HTMLInputElement | null };
  clipboardApiRef: { current: CanvasClipboardApi | null };
  readOnly: boolean;
  camera: any;
  stageEl: HTMLElement | null;
  t: (key: string, opts?: any) => string;
  onAddToChat?: (id: string | string[]) => void;
  collabUndo: () => boolean;
  collabRedo: () => boolean;
  deleteCanvasSelection: (opts?: {
    nodeIds?: string[];
    frameIds?: string[];
    skipLoading?: boolean;
  }) => boolean;
  reorderLayer: (dir: 'front' | 'forward' | 'backward' | 'back', ids: string[]) => void;
};

export function runCanvasCtxAction(action: CtxAction, deps: RunCanvasCtxActionDeps) {
  const {
    getCtxMenu,
    clearCtxMenu,
    selectedIdsRef,
    selectedFrameIdsRef,
    activeFrameIdRef,
    documentRef,
    imagePlaceAtRef,
    imageInputRef,
    clipboardApiRef,
    readOnly,
    camera,
    stageEl,
    t,
    onAddToChat,
    collabUndo,
    collabRedo,
    deleteCanvasSelection,
    reorderLayer,
  } = deps;
  const ctxMenu = getCtxMenu();

  let ids = selectedIdsRef.current;
  if (!ids.length && ctxMenu?.nodeId) ids = [ctxMenu.nodeId];

  let placeAt: { x: number; y: number } | null = null;
  if (ctxMenu && Number.isFinite(ctxMenu.sceneX) && Number.isFinite(ctxMenu.sceneY)) {
    placeAt = { x: ctxMenu.sceneX, y: ctxMenu.sceneY };
  }

  const hitNodeId = ctxMenu?.nodeId ?? null;
  const menuFrameId = ctxMenu?.frameId || activeFrameIdRef.current;
  // Artboards for mutations: only real selection. Soft activeFrameId must not
  // ride in via ctxMenu.frameId when nodes are the action target (duplicate
  // would otherwise snapshot the whole board).
  let frameIdsForAction = selectedFrameIdsRef.current;
  if (!frameIdsForAction.length && !ids.length && ctxMenu?.frameId) {
    frameIdsForAction = [String(ctxMenu.frameId)];
  }
  const selectionBusy = ctxMenuTargetHasProcessing({
    document: documentRef.current,
    ids,
    selectedFrameIds: frameIdsForAction,
    ctxNodeId: hitNodeId,
    ctxFrameId: ctxMenu?.frameId,
    activeFrameId: activeFrameIdRef.current,
  });
  clearCtxMenu();

  if (
    selectionBusy &&
    (action === 'group' ||
      action === 'ungroup' ||
      action === 'copy' ||
      action === 'cut' ||
      action === 'duplicate' ||
      action === 'front' ||
      action === 'forward' ||
      action === 'backward' ||
      action === 'back' ||
      action === 'toggleHidden' ||
      action === 'toggleLocked')
  ) {
    return;
  }

  if (action === 'upload') {
    // Empty canvas only — disabled when right-clicking a node.
    if (hitNodeId) return;
    imagePlaceAtRef.current = placeAt;
    imageInputRef.current?.click();
    return;
  }
  if (action === 'replace') {
    if (readOnly) return;
    const targetId = hitNodeId || (ids.length === 1 ? ids[0] : null);
    if (!targetId) return;
    const node = documentRef.current?.deltaSetLike?.[targetId];
    if (!node || isGeneratorNode(node)) return;
    if (String(node?.attrs?.processStatus || '') === 'running') return;
    const isImage = node.key === 'image';
    const isVideo = isVideoNode(node);
    if (!isImage && !isVideo) return;
    const keepWidth = Math.max(1, Number(node.width) || 1);
    const input = window.document.createElement('input');
    input.type = 'file';
    input.accept = isVideo ? 'video/*' : 'image/*';
    input.style.display = 'none';
    window.document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files?.[0] ?? null;
      input.remove();
      if (!file) return;
      const opts = {
        nodeId: targetId,
        keepWidth,
        file,
      };
      if (isVideo) void replaceVideoNodeFromFile(opts);
      else void replaceImageNodeFromFile(opts);
    };
    input.oncancel = () => input.remove();
    input.click();
    return;
  }
  if (
    action === 'spawnImageGenerator' ||
    action === 'spawnVideoGenerator' ||
    action === 'spawnAnimationBoard' ||
    action === 'spawnLottieGenerator' ||
    action === 'spawnAudioGenerator'
  ) {
    if (
      (action === 'spawnVideoGenerator' || action === 'spawnAudioGenerator') &&
      warnIfAvBlockedByAnimationWorkbenchFocus(message.warning, t)
    ) {
      return;
    }
    const doc = documentRef.current;
    if (!doc) return;
    const specs = {
      spawnImageGenerator: {
        natural: { width: 1024, height: 1024 },
        fit: { minRatio: 0.28, maxRatio: 0.42 },
        nameKey: 'editor.tools.imageGenerator' as const,
        spawn: spawnImageGenerator,
      },
      spawnVideoGenerator: {
        natural: { width: 1280, height: 720 },
        fit: { minRatio: 0.28, maxRatio: 0.48 },
        nameKey: 'editor.tools.videoGenerator' as const,
        spawn: spawnVideoGenerator,
      },
      spawnAnimationBoard: {
        natural: { width: 364, height: 364 },
        fit: { minRatio: 0.22, maxRatio: 0.42 },
        nameKey: 'editor.tools.animationBoard' as const,
        spawn: spawnAnimationBoard,
      },
      spawnLottieGenerator: {
        natural: { width: 512, height: 512 },
        fit: { minRatio: 0.22, maxRatio: 0.4 },
        nameKey: 'editor.tools.lottieGenerator' as const,
        spawn: spawnLottieGeneratorPlate,
      },
      spawnAudioGenerator: {
        natural: { ...MEDIA_PLACE_DEFAULT },
        fit: { minRatio: 0.22, maxRatio: 0.4 },
        nameKey: 'editor.tools.audioGenerator' as const,
        spawn: spawnAudioGenerator,
      },
    }[action];
    const laid = layoutGeneratorPlateAtScene({
      document: doc,
      camera,
      stageEl,
      natural: specs.natural,
      center: placeAt,
      fit: specs.fit,
    });
    specs.spawn({
        x: laid.x,
        y: laid.y,
        width: laid.width,
        height: laid.height,
        name: t(specs.nameKey),
      });
    return;
  }
  if (action === 'addToChat') {
    const clearAfter = () => {
      setSelectedNodeIds([]);
      setSelectedNodeId(null);
      setSelectedFrameIds([]);
      setActiveFrameId(null);
    };
    const seedNodes = ctxMenuSeedNodeIds(ids, hitNodeId);
    const expanded = resolveSelectionNodeIds(
      documentRef.current,
      seedNodes,
      frameIdsForAction
    );
    // Box / multi-select → one group chip (unless right-click landed on an unselected node).
    if (
      seedNodes.length &&
      expanded.length > 1 &&
      (!hitNodeId || expanded.includes(hitNodeId) || ids.includes(hitNodeId))
    ) {
      const attachable = filterChatAttachNodeIds(documentRef.current, expanded);
      if (!attachable.length) return;
      onAddToChat?.(attachable.length === 1 ? attachable[0]! : attachable);
      clearAfter();
      return;
    }
    const id = hitNodeId || ids[0];
    if (id) {
      const attachable = filterChatAttachNodeIds(documentRef.current, [id]);
      if (!attachable.length) return;
      onAddToChat?.(attachable[0]!);
      clearAfter();
      return;
    }
    const frameChip = frameIdsForAction[0] || menuFrameId;
    if (frameChip) {
      // Artboard selected (no node under cursor) — pin the frame into Chat.
      onAddToChat?.(`frame:${frameChip}`);
      clearAfter();
    }
    return;
  }
  if (action === 'group') {
    const targetIds = resolveSelectionNodeIds(documentRef.current, ids, frameIdsForAction);
    const grouped = unlockedGroupableIds(documentRef.current, targetIds);
    if (grouped.length < 2) return;
    const activeTool = String(store.getState?.().editor?.activeTool || 'select');
    const shapeKind = String(store.getState?.().editor?.shapeKind || 'rect');
    if (kitOwnsStagePointer(activeTool, shapeKind) && rcbIdsAllKitMapped(grouped)) {
      if (groupKitSelection(grouped)) {
        setMixedSelection({ nodeIds: grouped, frameIds: frameIdsForAction });
        return;
      }
    }
    const next = groupNodesInDocument(documentRef.current, grouped);
    setDocument(next);
    setMixedSelection({ nodeIds: grouped, frameIds: frameIdsForAction });
    return;
  }
  if (action === 'ungroup') {
    const targetIds = resolveSelectionNodeIds(documentRef.current, ids, frameIdsForAction);
    const unlocked = unlockedGroupableIds(documentRef.current, targetIds);
    if (!unlocked.length) return;
    const activeTool = String(store.getState?.().editor?.activeTool || 'select');
    const shapeKind = String(store.getState?.().editor?.shapeKind || 'rect');
    if (kitOwnsStagePointer(activeTool, shapeKind) && rcbIdsAllKitMapped(unlocked)) {
      if (ungroupKitSelection(unlocked)) {
        setMixedSelection({ nodeIds: unlocked, frameIds: frameIdsForAction });
        return;
      }
    }
    const next = ungroupNodesInDocument(documentRef.current, unlocked);
    setDocument(next);
    setMixedSelection({ nodeIds: unlocked, frameIds: frameIdsForAction });
    return;
  }
  if (action === 'undo') {
    const activeTool = String(store.getState?.().editor?.activeTool || 'select');
    const shapeKind = String(store.getState?.().editor?.shapeKind || 'rect');
    if (kitOwnsStagePointer(activeTool, shapeKind)) {
      if (!collabUndo()) {
        if (!undoKit()) undo();
      }
      return;
    }
    if (!collabUndo()) undo();
    return;
  }
  if (action === 'redo') {
    const activeTool = String(store.getState?.().editor?.activeTool || 'select');
    const shapeKind = String(store.getState?.().editor?.shapeKind || 'rect');
    if (kitOwnsStagePointer(activeTool, shapeKind)) {
      if (!collabRedo()) {
        if (!redoKit()) redo();
      }
      return;
    }
    if (!collabRedo()) redo();
    return;
  }
  if (action === 'copy') {
    clipboardApiRef.current?.copySelected(ids, frameIdsForAction);
    return;
  }
  if (action === 'cut') {
    clipboardApiRef.current?.cutSelected(ids, frameIdsForAction);
    return;
  }
  if (action === 'paste') {
    void clipboardApiRef.current?.pasteFromOsOrInternal(
      placeAt ? { anchor: placeAt } : undefined
    );
    return;
  }
  if (action === 'duplicate') {
    clipboardApiRef.current?.duplicateSelected(ids, frameIdsForAction);
    return;
  }
  if (action === 'delete') {
    let frameIds = selectedFrameIdsRef.current;
    if (!frameIds.length && !ids.length) {
      const fid = menuFrameId || activeFrameIdRef.current;
      if (fid) frameIds = [String(fid)];
    }
    deleteCanvasSelection({ nodeIds: ids, frameIds });
    return;
  }
  if (action === 'front' || action === 'forward' || action === 'backward' || action === 'back') {
    const targetIds = resolveSelectionNodeIds(documentRef.current, ids, frameIdsForAction);
    reorderLayer(action, targetIds.length ? targetIds : ids);
    return;
  }
  if (action === 'toggleHidden') {
    const seedNodes = ctxMenuSeedNodeIds(ids, hitNodeId);
    // Frame-only selection has no hide target (artboards are not scene nodes).
    if (!seedNodes.length) return;
    const targetIds = resolveSelectionNodeIds(
      documentRef.current,
      seedNodes,
      frameIdsForAction
    ).filter((id) => !isGeneratorNode(documentRef.current?.deltaSetLike?.[id]));
    if (!targetIds.length) return;
    const doc = documentRef.current;
    if (!doc) return;
    // Hide if any target is visible; show only when all are hidden.
    const anyVisible = targetIds.some((id) => !isNodeHidden(doc?.deltaSetLike?.[id]));
    pushEditorHistory();
    let next = doc;
    for (const id of targetIds) {
      next = updateNodeInDocument(next, id, {
        attrs: { hidden: anyVisible ? 'true' : 'false' },
      });
    }
    setDocumentFromCanvas(next);
    // Drop selection on hide so the canvas cannot keep interacting with it.
    // Unhide via layers eye, or re-select the layer then Show.
    if (anyVisible) {
      setSelectedNodeIds([]);
      setSelectedNodeId(null);
    }
    return;
  }
  if (action === 'toggleLocked') {
    const seedNodes = ctxMenuSeedNodeIds(ids, hitNodeId);
    const targetIds = seedNodes.length
      ? resolveSelectionNodeIds(documentRef.current, seedNodes, frameIdsForAction).filter(
          (id) => !isGeneratorNode(documentRef.current?.deltaSetLike?.[id])
        )
      : [];
    const doc = documentRef.current;
    if (targetIds.length && doc) {
      const anyUnlocked = targetIds.some((id) => !isNodeLocked(doc?.deltaSetLike?.[id]));
      pushEditorHistory();
      let next = doc;
      for (const id of targetIds) {
        next = updateNodeInDocument(next, id, {
          attrs: { locked: anyUnlocked ? 'true' : 'false' },
        });
      }
      setDocumentFromCanvas(next);
    }
    // Also toggle co-selected artboards (same gesture as node lock).
    if (frameIdsForAction.length) {
      const frames = Array.isArray(documentRef.current?.frames)
        ? documentRef.current.frames
        : [];
      const anyFrameUnlocked = frameIdsForAction.some((fid) => {
        const frame = frames.find((f: any) => f?.id === fid);
        return frame && !frame.locked;
      });
      updateArtboardFrames({
          patches: frameIdsForAction.map((fid) => ({
            id: fid,
            patch: { locked: anyFrameUnlocked },
          })),
        });
      return;
    }
    if (!targetIds.length && menuFrameId) {
      const frames = Array.isArray(documentRef.current?.frames)
        ? documentRef.current.frames
        : [];
      const frame = frames.find((f: any) => f?.id === menuFrameId);
      updateArtboardFrame({
          id: menuFrameId,
          patch: { locked: !frame?.locked },
        });
    }
    return;
  }
  if (action === 'exportMp4' || action === 'exportMp3') {
    const doc = documentRef.current;
    const seedNodes = ctxMenuSeedNodeIds(ids, hitNodeId);
    const targetIds = resolveSelectionNodeIds(
      doc,
      seedNodes,
      frameIdsForAction
    );
    const videoNodes = targetIds
      .map((id) => doc?.deltaSetLike?.[id])
      .filter((node: SceneNodeInput) => isVideoNode(node) && String(node?.attrs?.src || '').trim());
    if (!videoNodes.length) {
      message.warning(t('editor.noSelectionExport'));
      return;
    }
    const mode = action === 'exportMp3' ? 'audio' : 'video';
    const hideLoading = message.loading(
      t(
        mode === 'audio'
          ? 'editor.videoToolbar.exportingAudio'
          : 'editor.videoToolbar.exporting',
        {
          defaultValue: mode === 'audio' ? '正在导出音频…' : '正在导出视频…',
        }
      ),
      0
    );
    const exportSelectedVideos = async () => {
      try {
        for (const node of videoNodes) {
          const attrs = node?.attrs || {};
          await downloadVideoNodeAsset({
            src: String(attrs.src || ''),
            name: String(attrs.name || 'video'),
            uploadKey: attrs.uploadKey != null ? String(attrs.uploadKey) : null,
            cropX: attrs.cropX,
            cropY: attrs.cropY,
            cropW: attrs.cropW,
            cropH: attrs.cropH,
            trimStart: attrs.trimStart,
            trimEnd: attrs.trimEnd,
            flipX: attrs.flipX === true || attrs.flipX === 'true',
            flipY: attrs.flipY === true || attrs.flipY === 'true',
            mode,
          });
        }
        hideLoading();
        message.success(
          t(mode === 'audio' ? 'editor.exportedAudio' : 'editor.exportedVideo', {
            defaultValue: mode === 'audio' ? '已导出音频' : '已导出视频',
          })
        );
      } catch (err) {
        hideLoading();
        console.warn('[ctx-video-export]', err);
        message.error(
          t(
            mode === 'audio'
              ? 'editor.videoToolbar.exportAudioFail'
              : 'editor.videoToolbar.downloadFail',
            {
              defaultValue: mode === 'audio' ? '音频导出失败（可能无音轨）' : '下载失败',
            }
          )
        );
      }
    };
    exportSelectedVideos();
    return;
  }
  if (action === 'exportPng' || action === 'exportJpg' || action === 'exportSvg') {
    let format: ExportImageFormat = 'png';
    if (action === 'exportJpg') format = 'jpeg';
    else if (action === 'exportSvg') format = 'svg';
    const doc = documentRef.current;
    const seedNodes = ctxMenuSeedNodeIds(ids, hitNodeId);
    // Mixed / node selection: export expanded nodes. Frame-only keeps crop export
    // so artboard background is preserved.
    if (seedNodes.length) {
      const targetIds = resolveSelectionNodeIds(
        documentRef.current,
        seedNodes,
        frameIdsForAction
      );
      if (targetIds.length) {
        const ok = exportFabricImage({
          selectionOnly: true,
          nodeIds: targetIds,
          document: doc,
          format,
          filename: t('editor.layerExportName'),
        });
        if (ok) {
          message.success(t(format === 'svg' ? 'editor.exportedSvg' : 'editor.exportedImage'));
        } else {
          message.error(t('editor.exportFailed'));
        }
        return;
      }
    }
    const exportFrameId = frameIdsForAction[0] || menuFrameId;
    if (exportFrameId) {
      const frames = Array.isArray(doc?.frames) ? doc.frames : [];
      const frame = frames.find((f: any) => f?.id === exportFrameId);
      if (frame && frame.width > 0 && frame.height > 0) {
        async function exportFrame() {
          const tally = await exportCropSlots({
            crop: {
              x: Number(frame.x) || 0,
              y: Number(frame.y) || 0,
              width: Number(frame.width) || 1,
              height: Number(frame.height) || 1,
            },
            backgroundColor: frame.backgroundColor,
            baseName: String(frame.name || t('editor.pageExportName')),
            compress: false,
            document: doc,
            slots: [
              {
                id: 'ctx',
                scale: 1,
                affixMode: 'suffix',
                affix: '',
                format,
              },
            ],
          });
          if (tally.saved > 0) {
            message.success(
              t(format === 'svg' ? 'editor.exportedSvg' : 'editor.exportedImage')
            );
          } else if (!(tally.cancelled > 0 && tally.failed === 0)) {
            message.error(t('editor.exportFailed'));
          }
        }
        void exportFrame();
      }
    }
  }
}
