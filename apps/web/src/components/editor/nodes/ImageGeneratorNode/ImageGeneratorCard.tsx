import type { SceneDocument } from '@/components/rcb/sceneNode';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from '@/store';
import { useEditorDocument } from '@/store/editorSelectors';
import { FloatingPortal } from '@floating-ui/react';
import { HiArrowUp, HiOutlineBolt, HiOutlineChevronDown } from 'react-icons/hi2';
import { BiExit } from 'react-icons/bi';
import { PiSelectionPlus } from 'react-icons/pi';
import { useBillingEnabled } from '@/service/wallet';
import { generateImage } from '@/service/chat';
import { generateImageBatch } from '@/service/generateImageBatch';
import { getHttpErrorMessage } from '@/service/client';
import { Dropdown, DropdownPanel, message, Tooltip } from '@/components/base';
import {
  SelectionToolbarShell,
} from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import AgentComposerInput, {
  chipBaseKey,
  upsertLibraryAssetAttachment,
  type AgentComposerHandle,
  type ComposerContext,
} from '@/components/editor/panels/AgentComposerInput';
import {
  composerAttachActionClass,
} from '@/components/editor/panels/agent/composer/AgentComposerShell';
import {
  CanvasMediaComposerShell,
  ComposerAttachmentStrip,
  ComposerCanvasPickButton,
  ComposerFooterActions,
  ComposerFooterBar,
  ComposerPromptRegion,
} from '@/components/editor/panels/agent/composer/CanvasMediaComposerShell';
import {
  composerCanSend,
  composerSendDisabledReason,
} from '@/components/editor/panels/agent/composer/composerModelsGate';
import MentionAttachPanel, {
  type MentionAttachItem,
} from '@/components/editor/panels/agent/composer/MentionAttachPanel';
import { useComposerSlashSkills } from '@/components/editor/panels/agent/composer/useComposerSlashSkills';
import { useComposerMentionPanel } from '@/components/editor/panels/agent/composer/useComposerMentionPanel';
import { useGeneratorModelsCatalog } from '@/components/editor/panels/agent/composer/useGeneratorModelsCatalog';
import { insertMentionFromAttachment } from '@/components/editor/panels/agent/composer/composerMentionHelpers';
import type { UserAsset } from '@/models/assets';
import ImageAspectRatioPicker, {
  DEFAULT_IMAGE_COUNT,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  modelImageLimits,
  resolveImagePixelSize,
} from '@/components/editor/panels/agent/shared/ImageAspectRatioPicker';
import ModelPickerPanel, {
  ModelBrandIcon,
} from '@/components/editor/panels/agent/models/ModelPickerPanel';
import { cloudImageFallbackId } from '@/components/editor/panels/agent/llmModelMeta';
import { promptForImageSrc } from '@/components/rcb/scene/document/mediaLifecycle';
import {
  readGenAttrString,
  readGenAttrCount,
  ratioSummaryLabel,
} from '@/components/editor/nodes/shared/generatorAttrs';
import {
  buildImageGeneratorModelList,
  nextImageModelId,
} from '@/components/editor/nodes/shared/generatorModelLists';
import {
  attachSelectionToComposer,
  pickOrAttachFromCanvas,
  usePendingCanvasAttachFly,
} from '@/components/editor/nodes/shared/composerCanvasAttach';
import { finishGeneratorGenerateSession } from '@/components/editor/nodes/shared/finishGeneratorGenerate';
import { imageToolExitBtn } from '@/components/editor/nodes/ImageNode/imageToolbarShared';
import {
  hasActiveGeneratorSession,
  registerGeneratorSession,
} from '@/components/editor/nodes/shared/generatorSessionRegistry';
import { processJobAttrPatch } from '@/components/rcb/scene/document/processJobAttrs';
import { noteCanvasFlyLand } from '@/components/editor/panels/agent/composer/flyToChat';
import {
  buildComposerChipPrompt,
  collectComposerRefImages,
} from '@/components/editor/panels/agent/agentSendPath';
import { insertPendingComposerChips } from '@/components/editor/panels/agent/composerChipInsert';
import { isMarkContextKey, syncMarkPinRemoved } from '@/components/editor/nodes/ImageNode/mark/markChipSync';
import { clearImageGenMarkSession } from '@/components/editor/nodes/ImageNode/mark/markSessionCleanup';
import {
  listMarkSessionTargets,
} from '@/components/editor/nodes/ImageNode/mark/markGeometry';
import { isImageGeneratorNode } from '@/components/rcb/scene/document/nodeCapabilities';
import {
  clearCanvasAttachPick,
  closeImageToolPanel,
  consumePendingImageGenMarkContexts,
  finishImageGenerator,
  openImageToolPanel,
  patchDocumentNode,
  startCanvasAttachPick,
  setSelectedNodeIds,
  EMPTY_ID_LIST,
  type PendingMarkContextChip,
} from '@/store/modules/editor';
import { cn } from '@/utils/classnames';
import { estimateImageCredits } from '@/utils/imageCredits';
import {
  deleteUploadedFile,
  createFilePreviewUrl,
  revokeComposerPreviewUrls,
  finishComposerAttachmentUpload,
} from '@/utils/uploadImage';
import store from '@/store';

type Props = {
  nodeId: string;
  /** Scene plate box — composer anchors under it; promote keeps document geometry. */
  sceneBox: { x: number; y: number; width: number; height: number };
  disabled?: boolean;
};

/** Keep plate area; apply new aspect ratio; return size centered on current box. */
function plateSizeForAspect(
  box: { x: number; y: number; width: number; height: number },
  aspectRatio: string,
  resolution: string
) {
  const area = Math.max(1, box.width * box.height);
  const pixels = resolveImagePixelSize(aspectRatio, resolution);
  const ratio = Math.max(0.05, pixels.w / Math.max(1, pixels.h));
  let height = Math.sqrt(area / ratio);
  let width = height * ratio;
  // Soft clamp so extreme ratios stay editable on canvas.
  const maxSide = Math.max(box.width, box.height) * 1.6;
  const minSide = 120;
  if (Math.max(width, height) > maxSide) {
    const s = maxSide / Math.max(width, height);
    width *= s;
    height *= s;
  }
  if (Math.min(width, height) < minSide) {
    const s = minSide / Math.min(width, height);
    width *= s;
    height *= s;
  }
  width = Math.max(minSide, Math.round(width));
  height = Math.max(minSide, Math.round(height));
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return {
    width,
    height,
    x: Math.round(cx - width / 2),
    y: Math.round(cy - height / 2),
  };
}

function ImageGeneratorCard({
  nodeId,
  sceneBox,
  disabled,
}: Props): ReactNode {
  const { t } = useTranslation();
  const inputRef = useRef<AgentComposerHandle | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const genAttrs = useSelector(
    (state: any) => state.editor?.document?.deltaSetLike?.[nodeId]?.attrs as
      | Record<string, unknown>
      | undefined
  );
  const editorDocument = useEditorDocument();
  const canvasAttachPick = useSelector(
    (state: any) => state.editor?.canvasAttachPick as null | { target: string }
  );
  const pendingCanvasAttach = useSelector(
    (state: any) =>
      state.editor?.pendingCanvasAttach as null | {
        target: string;
        payload: string | string[];
      }
  );
  const pickTarget = `node:${nodeId}`;
  const pickingFromCanvas = canvasAttachPick?.target === pickTarget;
  const selectedNodeIds = useSelector(
    (state: any) => (state.editor?.selectedNodeIds as string[]) ?? EMPTY_ID_LIST
  );
  const selectedFrameIds = useSelector(
    (state: any) => (state.editor?.selectedFrameIds as string[]) ?? EMPTY_ID_LIST
  );
  const pendingImageGenMarks = useSelector(
    (state: any) => (state.editor.pendingImageGenMarkContexts || []) as PendingMarkContextChip[]
  );
  const imageToolPanel = useSelector(
    (state: any) =>
      state.editor.imageToolPanel as null | { nodeId: string; kind: string; markSink?: string }
  );
  const markActive =
    imageToolPanel?.kind === 'mark' &&
    imageToolPanel?.markSink === 'imageGen' &&
    imageToolPanel?.nodeId === nodeId;
  const nodeProcessing = String(genAttrs?.processStatus || '') === 'running';
  const pendingMarksLockRef = useRef<string | null>(null);
  const mainSrc = String(genAttrs?.src || '').trim();

  const [prompt, setPrompt] = useState(() =>
    promptForImageSrc(genAttrs, mainSrc)
  );
  const [sending, setSending] = useState(false);
  const composerVisible = !sending && !nodeProcessing;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [resolution, setResolution] = useState<string>(() => {
    return readGenAttrString(genAttrs, 'imageGenResolution') || DEFAULT_IMAGE_RESOLUTION;
  });
  const [aspectRatio, setAspectRatio] = useState<string>(() => {
    return readGenAttrString(genAttrs, 'imageGenAspect') || DEFAULT_IMAGE_ASPECT_RATIO;
  });
  /** Keep latest resolution across batched picker callbacks (res + WxH rescale). */
  const resolutionRef = useRef(resolution);
  resolutionRef.current = resolution;
  const [imageCount, setImageCount] = useState<number>(() => {
    return readGenAttrCount(genAttrs) ?? DEFAULT_IMAGE_COUNT;
  });
  const [modelId, setModelId] = useState(() => {
    return readGenAttrString(genAttrs, 'imageGenModel') || cloudImageFallbackId();
  });
  const { models, status: modelsStatus, catalogAvailable: apiAvailable } = useGeneratorModelsCatalog({
    buildList: buildImageGeneratorModelList,
    modelId,
    setModelId,
    resolveModelId: nextImageModelId,
  });
  const [contexts, setContexts] = useState<ComposerContext[]>([]);
  const contextsRef = useRef<ComposerContext[]>([]);
  contextsRef.current = contexts;

  const {
    mentionOpen,
    mentionQuery,
    closeMention,
    openMention,
    mentionFloating,
    mentionIx,
  } = useComposerMentionPanel(inputRef);

  usePendingCanvasAttachFly({
    pickTarget,
    pending: pendingCanvasAttach,
    document: editorDocument || (store.getState() as any).editor?.document,
    contextsRef,
    setContexts,
    insertChip: (ctx) => {
      inputRef.current?.insertContextAtCaret(ctx);
      inputRef.current?.focus();
    },
  });

  // Re-hydrate after overlay remount (e.g. geometry transform hides the portal).
  useEffect(() => {
    const nextAspect = readGenAttrString(genAttrs, 'imageGenAspect');
    if (nextAspect) setAspectRatio(nextAspect);
    const nextRes = readGenAttrString(genAttrs, 'imageGenResolution');
    if (nextRes) setResolution(nextRes);
    const nextCount = readGenAttrCount(genAttrs);
    if (nextCount != null) setImageCount(nextCount);
    const nextModel = readGenAttrString(genAttrs, 'imageGenModel');
    if (nextModel) setModelId(nextModel);
    setPrompt(promptForImageSrc(genAttrs, mainSrc));
  }, [
    nodeId,
    mainSrc,
    genAttrs?.imageGenAspect,
    genAttrs?.imageGenResolution,
    genAttrs?.imageGenCount,
    genAttrs?.imageGenModel,
    genAttrs?.genPrompt,
    genAttrs?.imageVariantPrompts,
  ]);

  // Auto-focus once when the composer first becomes visible — skip remount churn.
  const wasComposerVisibleRef = useRef(false);
  useEffect(() => {
    if (!composerVisible || disabled) {
      wasComposerVisibleRef.current = false;
      return;
    }
    if (wasComposerVisibleRef.current) return;
    wasComposerVisibleRef.current = true;
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [composerVisible, disabled]);

  useEffect(() => {
    const id = nodeId;
    return () => {
      // Card unmounts when selection clears / processing hides the toolbar —
      // keep the in-flight generate promise alive (session registry).
      if (hasActiveGeneratorSession(id)) return;
      abortRef.current?.abort();
    };
  }, [nodeId]);

  useEffect(() => {
    pendingMarksLockRef.current = null;
  }, [nodeId]);

  useEffect(() => {
    if (!pendingImageGenMarks.length) {
      pendingMarksLockRef.current = null;
      return;
    }
    const token = pendingImageGenMarks.map((c) => c.key).join('|');
    if (pendingMarksLockRef.current === token) return;
    pendingMarksLockRef.current = token;
    const list = pendingImageGenMarks.slice();
    consumePendingImageGenMarkContexts();
    insertPendingComposerChips(() => inputRef.current, list, { focus: 'caret' });
  }, [pendingImageGenMarks]);

  const attachments = useMemo(
    () => contexts.filter((c) => c.kind === 'attachment'),
    [contexts]
  );
  const attachmentsUploading = attachments.some((c) => c.uploadStatus === 'uploading');
  /** Attachments render as thumbs above; keep long filenames out of the inline composer chips. */
  const inlineContexts = useMemo(
    () => contexts.filter((c) => c.kind !== 'attachment'),
    [contexts]
  );
  const selectedModel = models.find((m) => m.id === modelId);
  const billingEnabled = useBillingEnabled();
  const creditCost = estimateImageCredits(selectedModel, imageCount, resolution);
  const settingsSummary = `${resolution} · ${ratioSummaryLabel(aspectRatio, t)} · ${t('agent.genCountN', { count: imageCount })}`;
  const canSendComposer = Boolean(prompt.trim()) || inlineContexts.length > 0;
  const canSendGen = composerCanSend({
    hasContent: canSendComposer,
    sending: sending || attachmentsUploading,
    disabled,
    apiAvailable,
    modelsStatus,
  });
  const sendDisabledReason = composerSendDisabledReason({
    t,
    hasContent: canSendComposer,
    apiAvailable,
    modelsStatus,
    blockWhileModelsLoading: true,
  });

  const removeContext = (key: string) => {
    if (isMarkContextKey(key)) syncMarkPinRemoved(key);
    const removed = contextsRef.current.find((c) => c.key === key);
    if (removed) revokeComposerPreviewUrls(removed);
    if (removed?.kind === 'attachment' && removed.uploadKey) {
      void deleteUploadedFile(removed.uploadKey).catch(() => undefined);
    }
    setContexts((prev) =>
      prev.filter((c) => c.key !== key && chipBaseKey(c.key) !== chipBaseKey(key))
    );
  };

  const onInlineContextsChange = (next: ComposerContext[]) => {
    const prevInline = contextsRef.current.filter((c) => c.kind !== 'attachment');
    for (const c of prevInline) {
      if (!next.some((item) => item.key === c.key) && isMarkContextKey(c.key)) {
        syncMarkPinRemoved(c.key);
      }
    }
    const attachmentsOnly = contextsRef.current.filter((c) => c.kind === 'attachment');
    setContexts([...attachmentsOnly, ...next]);
  };

  // Mark draws on *other* canvas images as refs — never on the generator plate itself.
  const markableRefCount = useMemo(() => {
    const doc = editorDocument || (store.getState() as any).editor?.document;
    if (!doc) return 0;
    return listMarkSessionTargets(doc).filter(
      (t) => !t.blocked && t.nodeId !== nodeId && !isImageGeneratorNode(t.node)
    ).length;
  }, [editorDocument, nodeId]);

  const markReady = !nodeProcessing && markableRefCount > 0;
  const markTip = nodeProcessing
    ? t('editor.imageToolbar.markBlockedProcessing')
    : markableRefCount <= 0
      ? t('editor.imageToolbar.markBlockedUnavailable')
      : t('editor.imageToolbar.mark');

  const onMark = () => {
    if (nodeProcessing || disabled || sending) return;
    const doc = editorDocument || (store.getState() as any).editor?.document;
    if (markActive) {
      clearImageGenMarkSession(doc);
      closeImageToolPanel();
      return;
    }
    openImageToolPanel({ nodeId, kind: 'mark', markSink: 'imageGen' });
  };

  const onPickRef = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    if (!files.length) return;
    await attachRefFiles(files);
  };

  const attachRefFiles = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return;

    // Stage chips with spinner, then upload (same as VideoGenerator / AgentDock).
    const staged: Array<{
      file: File;
      key: string;
      preview: string;
      pending: ComposerContext;
    }> = [];
    for (let i = 0; i < images.length; i++) {
      const file = images[i]!;
      try {
        const preview = createFilePreviewUrl(file);
        const key = `attach:${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`;
        staged.push({
          file,
          key,
          preview,
          pending: {
            key,
            label: file.name || t('editor.tools.imageGenRef'),
            kind: 'attachment',
            payload: `[Attached image]\nname: ${file.name}\nmime: ${file.type}`,
            dataUrl: preview,
            thumbUrl: preview,
            uploadStatus: 'uploading',
          },
        });
      } catch {
        message.error(t('agent.attachReadFailed', { name: file.name }));
      }
    }
    if (!staged.length) return;
    setContexts((prev) => [...prev, ...staged.map((s) => s.pending)]);

    await Promise.all(
      staged.map(async ({ file, key, preview }) => {
        try {
          const { dataUrl, thumbUrl, uploadKey } = await finishComposerAttachmentUpload(
            file,
            preview
          );
          setContexts((prev) => {
            if (!prev.some((c) => c.key === key)) {
              if (uploadKey) void deleteUploadedFile(uploadKey).catch(() => undefined);
              return prev;
            }
            return prev.map((c) =>
              c.key === key
                ? {
                    ...c,
                    dataUrl,
                    thumbUrl,
                    uploadKey: uploadKey || undefined,
                    uploadStatus: 'ready' as const,
                  }
                : c
            );
          });
        } catch (err: unknown) {
          setContexts((prev) => prev.filter((c) => c.key !== key));
          message.error(
            getHttpErrorMessage(err, t('agent.uploadFailed', { name: file.name }))
          );
        }
      })
    );
  };

  const {
    skillOpen,
    skillQuery,
    skillItems,
    skillFloating,
    skillIx,
    maybeOpenComposerMentions,
    pickSkill,
  } = useComposerSlashSkills({
    inputRef,
    setPrompt,
    onCloseAtMention: closeMention,
    onOpenAtMention: openMention,
  });

  const mentionItems = useMemo(
    (): MentionAttachItem[] =>
      attachments.map((c, i) => ({
        id: c.key,
        label: t('agent.mentionAttachImageN', { n: i + 1 }),
        ...(c.thumbUrl || c.dataUrl ? { thumbUrl: String(c.thumbUrl || c.dataUrl) } : {}),
      })),
    [attachments, t]
  );

  const pickMentionAttach = (pickId: string) => {
    const list = contextsRef.current.filter((c) => c.kind === 'attachment');
    const idx = list.findIndex((c) => c.key === pickId);
    if (idx < 0) return;
    const att = list[idx]!;
    insertMentionFromAttachment({
      att,
      n: idx + 1,
      label: t('agent.mentionAttachImageN', { n: idx + 1 }),
      payload: att.payload || `[User attachment ${idx + 1}]`,
      prompt,
      setPrompt,
      closeMention,
      inputRef,
    });
  };

  const pickMentionLibraryAsset = (asset: UserAsset) => {
    if (asset.kind !== 'image') return;
    const upserted = upsertLibraryAssetAttachment(
      contextsRef.current,
      asset,
      t('me.assetKindImage')
    );
    if (!upserted) return;
    setContexts(upserted.contexts);
    contextsRef.current = upserted.contexts;
    insertMentionFromAttachment({
      att: upserted.attachment,
      n: upserted.ordinal,
      label: t('agent.mentionAttachImageN', { n: upserted.ordinal }),
      payload: upserted.attachment.payload || `[User attachment ${upserted.ordinal}]`,
      prompt,
      setPrompt,
      closeMention,
      inputRef,
    });
  };

  const onGenerate = async () => {
    const text = prompt.trim();
    if (!canSendGen || attachmentsUploading) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Register before clearing selection — toolbar unmount must not abort this run.
    registerGeneratorSession(nodeId);
    setSelectedNodeIds([]);
    setSending(true);
    let finished = false;
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: {
            processStatus: 'running',
            processKind: 'generate',
            processLabel: t('editor.tools.imageGenerating'),
            processStartedAt: String(Date.now()),
            // Durable on the node — quick-edit reads attrs.genPrompt after promote.
            genPrompt: text,
          },
        },
      });
    try {
      const promptForApi = buildComposerChipPrompt(contextsRef.current, text);
      const body: Parameters<typeof generateImage>[0] = {
        prompt: promptForApi,
        model: modelId,
        quality: DEFAULT_IMAGE_QUALITY,
        resolution,
      };
      // Smart ratio: omit so the model picks a fitting aspect.
      if (aspectRatio !== 'smart') body.aspect_ratio = aspectRatio;
      const refImages = collectComposerRefImages(contextsRef.current).filter(
        (u) => !u.startsWith('data:video/')
      );
      if (refImages.length) body.images = refImages;
      const count = Math.max(1, Math.min(4, Math.round(imageCount) || 1));
      const urls = await generateImageBatch(body, count, {
        signal: ac.signal,
        emptyMessage: t('editor.tools.imageGenEmpty'),
        onJobsCreated: (jobIds) => {
          patchDocumentNode({
              nodeId,
              skipHistory: true,
              patch: { attrs: processJobAttrPatch(jobIds) },
            });
        },
      });
      const src = urls[0] || '';
      if (!src) throw new Error(t('editor.tools.imageGenEmpty'));

      if (urls.length < count) {
        message.warning(
          t('editor.tools.imageGenPartialBatch', {
            got: urls.length,
            count,
          })
        );
      }

      finishImageGenerator({
          nodeId,
          src,
          name: t('editor.tools.imageGenerator'),
          variants: urls,
          genPrompt: text,
        });
      for (const c of contextsRef.current) {
        if (isMarkContextKey(c.key)) syncMarkPinRemoved(c.key);
      }
      closeImageToolPanel();
      finished = true;
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        message.error(getHttpErrorMessage(err, t('editor.tools.imageGenFail')));
      }
    } finally {
      finishGeneratorGenerateSession({
        nodeId,
        finished,
        abortRef,
        ac,
        setSending,
      });
    }
  };

  const persistGenSettings = (
    patch: {
      aspect?: string;
      resolution?: string;
      count?: number;
      model?: string;
    },
    opts?: { skipHistory?: boolean }
  ) => {
    const attrs: Record<string, unknown> = {};
    if (patch.aspect != null) attrs.imageGenAspect = patch.aspect;
    if (patch.resolution != null) attrs.imageGenResolution = patch.resolution;
    if (patch.count != null) attrs.imageGenCount = patch.count;
    if (patch.model != null) attrs.imageGenModel = patch.model;
    if (!Object.keys(attrs).length) return;
    patchDocumentNode({
        nodeId,
        patch: { attrs },
        skipHistory: opts?.skipHistory !== false,
      });
  };

  const applyAspectToNode = (nextAspect: string, nextResolution = resolutionRef.current) => {
    const res = String(nextResolution || resolutionRef.current || DEFAULT_IMAGE_RESOLUTION);
    resolutionRef.current = res;
    setAspectRatio(nextAspect);
    setResolution(res);
    if (disabled || sending) {
      persistGenSettings({ aspect: nextAspect, resolution: res });
      return;
    }
    // Smart = model picks aspect; keep the current plate (don't collapse to 1:1).
    if (String(nextAspect).trim() === 'smart') {
      persistGenSettings({ aspect: 'smart', resolution: res });
      return;
    }
    const next = plateSizeForAspect(sceneBox, nextAspect, res);
    patchDocumentNode({
        nodeId,
        patch: {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          attrs: {
            imageGenAspect: nextAspect,
            imageGenResolution: res,
          },
        },
      });
  };

  const onCanvasPick = () => {
    void pickOrAttachFromCanvas({
      pickingFromCanvas,
      clearPick: () => clearCanvasAttachPick(),
      attachSelection: async () => {
        const doc = editorDocument || (store.getState() as any).editor?.document;
        const insertChip = (ctx: ComposerContext) => {
          inputRef.current?.insertContextAtCaret(ctx);
          inputRef.current?.focus();
        };
        return attachSelectionToComposer({
          hostNodeId: nodeId,
          landId: pickTarget,
          document: doc,
          selectedNodeIds,
          selectedFrameIds,
          existing: contextsRef.current,
          setContexts,
          insertChip,
        });
      },
      startPick: () => {
        noteCanvasFlyLand(pickTarget);
        startCanvasAttachPick({ target: pickTarget, accept: 'image' });
      },
    });
  };

  return (
    <>
      {composerVisible ? (
        <SelectionToolbarShell
          box={{
            left: sceneBox.x,
            top: sceneBox.y,
            width: sceneBox.width,
            height: sceneBox.height,
          }}
          bare
          dock="below"
          zIndexClassName={markActive ? 'z-[40]' : 'z-[32]'}
          data-image-generator
          {...(markActive ? { 'data-mark-composer': true } : {})}
          data-scene-node-id={nodeId}
        >
          <CanvasMediaComposerShell
            attachment={
              <ComposerAttachmentStrip
                scrollable
                attachments={attachments}
                disabled={disabled || sending}
                onRemove={removeContext}
                attachTooltip={t('editor.tools.imageGenRef')}
                attachAriaLabel={t('editor.tools.imageGenRef')}
                onAttachClick={() => fileRef.current?.click()}
                fileInput={{
                  ref: fileRef,
                  accept: 'image/*',
                  multiple: true,
                  onChange: onPickRef,
                }}
                extraActions={
                  <>
                    <Tooltip tip={markTip} placement="top">
                      <button
                        type="button"
                        disabled={disabled || sending || !markReady}
                        aria-label={t('editor.imageToolbar.mark')}
                        aria-pressed={markActive}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          e.nativeEvent.stopImmediatePropagation?.();
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onMark();
                        }}
                        className={composerAttachActionClass(markActive)}
                      >
                        <PiSelectionPlus className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    <ComposerCanvasPickButton
                      pickingFromCanvas={pickingFromCanvas}
                      disabled={disabled || sending}
                      onClick={onCanvasPick}
                    />
                  </>
                }
              />
            }
            prompt={
              <ComposerPromptRegion onFocusInput={() => inputRef.current?.focus()}>
                <AgentComposerInput
                  ref={inputRef}
                  contexts={inlineContexts}
                  onContextsChange={onInlineContextsChange}
                  value={prompt}
                  onChange={(next) => {
                    setPrompt(next);
                    maybeOpenComposerMentions(next);
                  }}
                  onSubmit={() => {
                    if (canSendGen) void onGenerate();
                  }}
                  // canSendGen only gates the send button — empty prompt must stay editable.
                  disabled={disabled || sending}
                  placeholder={t('editor.tools.imageGenPlaceholder')}
                  flyLandId={pickTarget}
                  className="min-h-full w-full text-[13px]"
                  onPasteImages={(files) => {
                    attachRefFiles(files);
                  }}
                />
              </ComposerPromptRegion>
            }
            footer={
              <ComposerFooterBar>
            <Dropdown
              trigger="click"
              placement="top-start"
              strategy="fixed"
              offset={8}
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
              items={[]}
              floatingClassName="z-[90]"
              referenceClassName="inline-flex min-w-0"
              popupRender={() => (
                <DropdownPanel className="w-[min(26rem,calc(100vw-2rem))] p-3">
                  <p className="mb-2.5 text-[13px] font-semibold text-[var(--ink)]">
                    {t('editor.tools.imageSettings')}
                  </p>
                  <div onPointerDown={(e) => e.stopPropagation()}>
                    <ImageAspectRatioPicker
                      variant="image"
                      resolution={resolution}
                      aspectRatio={aspectRatio}
                      imageCount={imageCount}
                      imageLimits={modelImageLimits(selectedModel)}
                      onResolutionChange={(r) => {
                        resolutionRef.current = r;
                        applyAspectToNode(aspectRatio, r);
                      }}
                      onAspectRatioChange={(r) =>
                        applyAspectToNode(r, resolutionRef.current)
                      }
                      onImageCountChange={(n) => {
                        setImageCount(n);
                        persistGenSettings({ count: n });
                      }}
                      disabled={disabled || sending}
                    />
                  </div>
                </DropdownPanel>
              )}
            >
              <button
                type="button"
                disabled={disabled || sending}
                className={cn(
                  'inline-flex h-7 max-w-[min(100%,11rem)] items-center gap-1 truncate rounded-full px-2 text-[12px] font-medium transition-colors disabled:opacity-40',
                  settingsOpen
                    ? 'bg-[var(--accent-soft)] text-[var(--ink)]'
                    : 'bg-[var(--canvas)] text-[var(--ink)] hover:bg-[var(--accent-soft)]'
                )}
              >
                <span className="truncate">{settingsSummary}</span>
                <HiOutlineChevronDown
                  className={cn(
                    'h-3 w-3 shrink-0 opacity-70 transition-transform duration-150',
                    settingsOpen && 'rotate-180'
                  )}
                  strokeWidth={2}
                />
              </button>
            </Dropdown>

            <ComposerFooterActions>
              <Dropdown
                trigger="click"
                placement="top-end"
                strategy="fixed"
                offset={8}
                open={modelOpen}
                onOpenChange={setModelOpen}
                items={[]}
                floatingClassName="z-[90]"
                referenceClassName="inline-flex"
                popupRender={() => (
                  <div onPointerDown={(e) => e.stopPropagation()}>
                    <ModelPickerPanel
                      tab="image"
                      models={models}
                      selectedId={modelId}
                      status={modelsStatus}
                      onPick={(id) => {
                        setModelId(id);
                        persistGenSettings({ model: id });
                        setModelOpen(false);
                      }}
                    />
                  </div>
                )}
              >
                <Tooltip
                  tip={selectedModel?.label || modelId}
                  placement="top"
                  disabled={modelOpen}
                >
                  <button
                    type="button"
                    disabled={disabled || sending}
                    aria-label={selectedModel?.label || modelId}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:opacity-40"
                  >
                    <ModelBrandIcon
                      model={selectedModel || { id: modelId }}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                  </button>
                </Tooltip>
              </Dropdown>

              <Tooltip
                tip={
                  sendDisabledReason ||
                  (billingEnabled
                    ? t('wallet.creditCostTip', { count: creditCost })
                    : t('agent.send'))
                }
                placement="top"
              >
                <button
                  type="button"
                  disabled={!canSendGen}
                  onClick={() => void onGenerate()}
                  className={cn(
                    'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition',
                    'bg-[var(--ink)] text-[var(--on-brand)] disabled:opacity-40',
                    !billingEnabled && 'h-7 w-7 justify-center px-0'
                  )}
                >
                  {billingEnabled ? (
                    <>
                      <HiOutlineBolt className="h-3.5 w-3.5" strokeWidth={2} />
                      <span className="tabular-nums">{creditCost}</span>
                    </>
                  ) : (
                    <HiArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                  )}
                </button>
              </Tooltip>
            </ComposerFooterActions>
              </ComposerFooterBar>
            }
          />
        </SelectionToolbarShell>
      ) : null}

      {composerVisible && mentionOpen ? (
        <FloatingPortal>
          <div
            ref={mentionFloating.refs.setFloating}
            style={mentionFloating.floatingStyles as CSSProperties}
            className="z-[95]"
            {...mentionIx.getFloatingProps()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MentionAttachPanel
              items={mentionItems}
              query={mentionQuery}
              onPick={pickMentionAttach}
              onPickLibraryAsset={pickMentionLibraryAsset}
              assetKinds={['image']}
            />
          </div>
        </FloatingPortal>
      ) : null}

      {composerVisible && skillOpen ? (
        <FloatingPortal>
          <div
            ref={skillFloating.refs.setFloating}
            style={skillFloating.floatingStyles as CSSProperties}
            className="z-[95]"
            {...skillIx.getFloatingProps()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <MentionAttachPanel
              variant="skill"
              items={skillItems}
              query={skillQuery}
              onPick={pickSkill}
            />
          </div>
        </FloatingPortal>
      ) : null}
    </>
  );
}

export default memo(ImageGeneratorCard);
