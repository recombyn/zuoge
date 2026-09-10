import type { SceneDocument } from '@/components/rcb/sceneNode';
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from '@/store';
import { useEditorDocument } from '@/store/editorSelectors';
import { FloatingPortal } from '@floating-ui/react';
import { HiArrowUp, HiOutlineBolt, HiOutlineChevronDown } from 'react-icons/hi2';
import { PiSelectionPlus } from 'react-icons/pi';
import { generateVideo, createVideoJob, waitForVideoJob } from '@/service/chat';
import { getHttpErrorMessage } from '@/service/client';
import { useBillingEnabled } from '@/service/wallet';
import { Dropdown, DropdownPanel, message, Tooltip } from '@/components/base';
import {
  SelectionToolbarShell,
} from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import AgentComposerInput, {
  chipBaseKey,
  composerAttachmentMediaKind,
  upsertLibraryAssetAttachment,
  type AgentComposerHandle,
  type ComposerContext,
} from '@/components/editor/panels/AgentComposerInput';
import {
  CanvasMediaComposerShell,
  ComposerAttachmentStrip,
  ComposerCanvasPickButton,
  ComposerFooterActions,
  ComposerFooterBar,
  ComposerPromptRegion,
} from '@/components/editor/panels/agent/composer/CanvasMediaComposerShell';
import {
  composerAttachActionClass,
} from '@/components/editor/panels/agent/composer/AgentComposerShell';
import {
  buildComposerChipPrompt,
  collectComposerRefImages,
} from '@/components/editor/panels/agent/agentSendPath';
import MentionAttachPanel, {
  type MentionAttachItem,
} from '@/components/editor/panels/agent/composer/MentionAttachPanel';
import { useComposerSlashSkills } from '@/components/editor/panels/agent/composer/useComposerSlashSkills';
import { useComposerMentionPanel } from '@/components/editor/panels/agent/composer/useComposerMentionPanel';
import { useGeneratorModelsCatalog } from '@/components/editor/panels/agent/composer/useGeneratorModelsCatalog';
import { insertMentionFromAttachment } from '@/components/editor/panels/agent/composer/composerMentionHelpers';
import type { UserAsset } from '@/models/assets';
import {
  DEFAULT_VIDEO_ASPECT_RATIO,
  DEFAULT_VIDEO_DURATION,
  DEFAULT_VIDEO_RESOLUTION,
  VideoSettingsPanel,
} from '@/components/editor/panels/agent/shared/VideoSettingsPanel';
import ModelPickerPanel, {
  ModelBrandIcon,
} from '@/components/editor/panels/agent/models/ModelPickerPanel';
import {
  attachSelectionToComposer,
  pickOrAttachFromCanvas,
  usePendingCanvasAttachFly,
} from '@/components/editor/nodes/shared/composerCanvasAttach';
import { readGenAttrString, readGenAttrDuration } from '@/components/editor/nodes/shared/generatorAttrs';
import {
  buildVideoGeneratorModelList,
  nextVideoModelId,
} from '@/components/editor/nodes/shared/generatorModelLists';
import { finishGeneratorGenerateSession } from '@/components/editor/nodes/shared/finishGeneratorGenerate';
import { pickVideoUrl } from '@/components/editor/nodes/shared/mediaProbe';
import { processJobAttrPatch } from '@/components/rcb/scene/document/processJobAttrs';
import {
  hasActiveGeneratorSession,
  registerGeneratorSession,
} from '@/components/editor/nodes/shared/generatorSessionRegistry';
import {
  captureVideoPosterFrame
} from '@/components/rcb/scene/document/nodeFactories';
import {
  clearCanvasAttachPick,
  closeImageToolPanel,
  consumePendingVideoGenMarkContexts,
  finishVideoGenerator,
  openImageToolPanel,
  patchDocumentNode,
  setSelectedNodeIds,
  startCanvasAttachPick,
  EMPTY_ID_LIST,
  type PendingMarkContextChip,
} from '@/store/modules/editor';
import { noteCanvasFlyLand } from '@/components/editor/panels/agent/composer/flyToChat';
import { insertPendingComposerChips } from '@/components/editor/panels/agent/composerChipInsert';
import { isMarkContextKey, syncMarkPinRemoved } from '@/components/editor/nodes/ImageNode/mark/markChipSync';
import { clearVideoGenMarkSession } from '@/components/editor/nodes/ImageNode/mark/markSessionCleanup';
import { listMarkSessionTargets } from '@/components/editor/nodes/ImageNode/mark/markGeometry';
import { isVideoGeneratorNode } from '@/components/rcb/scene/document/nodeCapabilities';
import { cn } from '@/utils/classnames';
import { estimateVideoCredits } from '@/utils/imageCredits';
import { finishComposerAttachmentUpload, createFilePreviewUrl, revokeComposerPreviewUrls } from '@/utils/uploadImage';
import { cloudVideoFallbackId } from '@/components/editor/panels/agent/llmModelMeta';
import store from '@/store';

type Props = {
  nodeId: string;
  /** Scene plate box — composer anchors under it; promote keeps document geometry. */
  sceneBox: { x: number; y: number; width: number; height: number };
  disabled?: boolean;
};

/** Keep plate area; apply new aspect ratio; return size centered on current box. */
function plateSizeForVideoAspect(
  box: { x: number; y: number; width: number; height: number },
  aspectRatio: string
) {
  const [rw, rh] = String(aspectRatio || DEFAULT_VIDEO_ASPECT_RATIO)
    .split(':')
    .map(Number);
  const ratio = rw > 0 && rh > 0 ? rw / rh : 16 / 9;
  const area = Math.max(1, box.width * box.height);
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

function VideoGeneratorCard({
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
  const nodeProcessing = String(genAttrs?.processStatus || '') === 'running';
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
  const pendingVideoGenMarks = useSelector(
    (state: any) => (state.editor.pendingVideoGenMarkContexts || []) as PendingMarkContextChip[]
  );
  const imageToolPanel = useSelector(
    (state: any) =>
      state.editor.imageToolPanel as null | { nodeId: string; kind: string; markSink?: string }
  );
  const markActive =
    imageToolPanel?.kind === 'mark' &&
    imageToolPanel?.markSink === 'videoGen' &&
    imageToolPanel?.nodeId === nodeId;
  const pendingMarksLockRef = useRef<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [sending, setSending] = useState(false);
  const composerVisible = !sending && !nodeProcessing;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [resolution, setResolution] = useState<string>(() => {
    return readGenAttrString(genAttrs, 'videoGenResolution') || DEFAULT_VIDEO_RESOLUTION;
  });
  const [aspectRatio, setAspectRatio] = useState<string>(() => {
    return readGenAttrString(genAttrs, 'videoGenAspect') || DEFAULT_VIDEO_ASPECT_RATIO;
  });
  const [duration, setDuration] = useState<number>(() => {
    return readGenAttrDuration(genAttrs, 'videoGenDuration', 4, 15) ?? DEFAULT_VIDEO_DURATION;
  });
  const [modelId, setModelId] = useState(() => {
    return readGenAttrString(genAttrs, 'videoGenModel') || cloudVideoFallbackId();
  });
  const { models, status: modelsStatus } = useGeneratorModelsCatalog({
    buildList: buildVideoGeneratorModelList,
    modelId,
    setModelId,
    resolveModelId: nextVideoModelId,
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
    imagesOnly: false,
    insertChip: (ctx) => {
      inputRef.current?.insertContextAtCaret(ctx);
      inputRef.current?.focus();
    },
  });

  // Re-hydrate after overlay remount (e.g. geometry transform hides the portal).
  useEffect(() => {
    const nextAspect = readGenAttrString(genAttrs, 'videoGenAspect');
    if (nextAspect) setAspectRatio(nextAspect);
    const nextRes = readGenAttrString(genAttrs, 'videoGenResolution');
    if (nextRes) setResolution(nextRes);
    const nextDuration = readGenAttrDuration(genAttrs, 'videoGenDuration', 4, 15);
    if (nextDuration != null) setDuration(nextDuration);
    const nextModel = readGenAttrString(genAttrs, 'videoGenModel');
    if (nextModel) setModelId(nextModel);
  }, [
    nodeId,
    genAttrs?.videoGenAspect,
    genAttrs?.videoGenResolution,
    genAttrs?.videoGenDuration,
    genAttrs?.videoGenModel,
  ]);

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
    if (!pendingVideoGenMarks.length) {
      pendingMarksLockRef.current = null;
      return;
    }
    const token = pendingVideoGenMarks.map((c) => c.key).join('|');
    if (pendingMarksLockRef.current === token) return;
    pendingMarksLockRef.current = token;
    const list = pendingVideoGenMarks.slice();
    consumePendingVideoGenMarkContexts();
    insertPendingComposerChips(() => inputRef.current, list, { focus: 'caret' });
  }, [pendingVideoGenMarks]);

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
  const creditCost = estimateVideoCredits(selectedModel);
  const settingsSummary = `${resolution} · ${aspectRatio} · ${duration}s`;

  const removeContext = (key: string) => {
    if (isMarkContextKey(key)) syncMarkPinRemoved(key);
    setContexts((prev) => {
      const removed = prev.find((c) => c.key === key);
      if (removed) revokeComposerPreviewUrls(removed);
      return prev.filter((c) => c.key !== key && chipBaseKey(c.key) !== chipBaseKey(key));
    });
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
      (t) => !t.blocked && t.nodeId !== nodeId && !isVideoGeneratorNode(t.node)
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
      clearVideoGenMarkSession(doc);
      closeImageToolPanel();
      return;
    }
    openImageToolPanel({ nodeId, kind: 'mark', markSink: 'videoGen' });
  };

  const onPickRef = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    e.target.value = '';
    if (!files.length) return;
    await attachRefFiles(files);
  };

  const attachRefFiles = async (files: File[]) => {
    const media = files.filter(
      (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
    );
    if (!media.length) return;

    // Stage chips immediately with spinner, then upload (same pattern as AgentDock).
    const staged: Array<{
      file: File;
      key: string;
      preview: string;
      thumb: string;
      pending: ComposerContext;
    }> = [];
    for (let i = 0; i < media.length; i++) {
      const file = media[i]!;
      try {
        const preview = createFilePreviewUrl(file);
        let thumb = preview;
        if (file.type.startsWith('video/')) {
          try {
            thumb = await captureVideoPosterFrame(preview);
          } catch {
            thumb = preview;
          }
        }
        const key = `attach:${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`;
        staged.push({
          file,
          key,
          preview,
          thumb,
          pending: {
            key,
            label: file.name || t('editor.tools.videoGenRef'),
            kind: 'attachment',
            payload: file.type.startsWith('video/')
              ? `[Attached video]\nname: ${file.name}\nmime: ${file.type}`
              : `[Attached image]\nname: ${file.name}\nmime: ${file.type}`,
            dataUrl: preview,
            thumbUrl: thumb,
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
      staged.map(async ({ file, key, preview, thumb }) => {
        try {
          const { dataUrl, thumbUrl, uploadKey } = await finishComposerAttachmentUpload(
            file,
            preview,
            thumb
          );
          setContexts((prev) => {
            if (!prev.some((c) => c.key === key)) return prev;
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

  const mentionItems = useMemo((): MentionAttachItem[] => {
    return attachments.map((c, i) => {
      const kind = composerAttachmentMediaKind(c);
      const thumb = String(c.thumbUrl || c.dataUrl || '').trim();
      return {
        id: c.key,
        label:
          kind === 'video'
            ? t('agent.mentionAttachVideoN', { n: i + 1 })
            : t('agent.mentionAttachImageN', { n: i + 1 }),
        mediaKind: kind === 'video' ? 'video' : 'image',
        ...((kind === 'image' || kind === 'video') && thumb ? { thumbUrl: thumb } : {}),
      };
    });
  }, [attachments, t]);

  const pickMentionAttach = (pickId: string) => {
    const list = contextsRef.current.filter((c) => c.kind === 'attachment');
    const idx = list.findIndex((c) => c.key === pickId);
    if (idx < 0) return;
    const att = list[idx]!;
    const kind = composerAttachmentMediaKind(att);
    insertMentionFromAttachment({
      att,
      n: idx + 1,
      label:
        kind === 'video'
          ? t('agent.mentionAttachVideoN', { n: idx + 1 })
          : t('agent.mentionAttachImageN', { n: idx + 1 }),
      payload: att.payload || `[User attachment ${idx + 1}]`,
      prompt,
      setPrompt,
      closeMention,
      inputRef,
    });
  };

  const pickMentionLibraryAsset = (asset: UserAsset) => {
    if (asset.kind !== 'image' && asset.kind !== 'video') return;
    const upserted = upsertLibraryAssetAttachment(
      contextsRef.current,
      asset,
      asset.kind === 'video' ? t('me.assetKindVideo') : t('me.assetKindImage')
    );
    if (!upserted) return;
    setContexts(upserted.contexts);
    contextsRef.current = upserted.contexts;
    const kind = composerAttachmentMediaKind(upserted.attachment);
    insertMentionFromAttachment({
      att: upserted.attachment,
      n: upserted.ordinal,
      label:
        kind === 'video'
          ? t('agent.mentionAttachVideoN', { n: upserted.ordinal })
          : t('agent.mentionAttachImageN', { n: upserted.ordinal }),
      payload: upserted.attachment.payload || `[User attachment ${upserted.ordinal}]`,
      prompt,
      setPrompt,
      closeMention,
      inputRef,
    });
  };

  const onGenerate = async () => {
    const text = prompt.trim();
    const canSendComposer = Boolean(text) || inlineContexts.length > 0;
    if (!canSendComposer || sending || disabled || attachmentsUploading) return;
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
            processLabel: t('editor.tools.videoGenerating'),
            processStartedAt: String(Date.now()),
            genPrompt: text,
          },
        },
      });
    try {
      const promptForApi = buildComposerChipPrompt(contextsRef.current, text);
      const body: Parameters<typeof generateVideo>[0] = {
        prompt: promptForApi,
        model: modelId,
        aspect_ratio: aspectRatio,
        resolution,
        duration,
      };
      const refImages = collectComposerRefImages(contextsRef.current).filter(
        (u) => Boolean(u) && !u.startsWith('data:video/')
      );
      if (refImages.length) body.images = refImages;

      const jobId = await createVideoJob(body, { signal: ac.signal });
      patchDocumentNode({
          nodeId,
          skipHistory: true,
          patch: { attrs: processJobAttrPatch([jobId]) },
        });
      const res = await waitForVideoJob(jobId, { signal: ac.signal });
      const src = pickVideoUrl(res);
      if (!src) throw new Error(t('editor.tools.videoGenEmpty'));

      let poster = '';
      try {
        poster = await captureVideoPosterFrame(src);
      } catch {
        /* poster is a nice-to-have — video still plays without it */
      }
      // Promote in place — keep the generator plate's document x/y/size so the
      // result appears exactly where the plate was (sceneBox is origin-relative).
      finishVideoGenerator({
          nodeId,
          src,
          ...(poster ? { poster } : {}),
          name: t('editor.tools.videoGenerator'),
          genPrompt: text,
        });
      finished = true;
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        message.error(getHttpErrorMessage(err, t('editor.tools.videoGenFail')));
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
      duration?: number;
      model?: string;
    },
    opts?: { skipHistory?: boolean }
  ) => {
    const attrs: Record<string, unknown> = {};
    if (patch.aspect != null) attrs.videoGenAspect = patch.aspect;
    if (patch.resolution != null) attrs.videoGenResolution = patch.resolution;
    if (patch.duration != null) attrs.videoGenDuration = patch.duration;
    if (patch.model != null) attrs.videoGenModel = patch.model;
    if (!Object.keys(attrs).length) return;
    patchDocumentNode({
        nodeId,
        patch: { attrs },
        skipHistory: opts?.skipHistory !== false,
      });
  };

  const applyAspectToNode = (nextAspect: string) => {
    setAspectRatio(nextAspect);
    if (disabled || sending) {
      persistGenSettings({ aspect: nextAspect });
      return;
    }
    const next = plateSizeForVideoAspect(sceneBox, nextAspect);
    patchDocumentNode({
        nodeId,
        patch: {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          attrs: {
            videoGenAspect: nextAspect,
          },
        },
      });
  };

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
          imagesOnly: false,
        });
      },
      startPick: () => {
        noteCanvasFlyLand(pickTarget);
        startCanvasAttachPick({ target: pickTarget });
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
          data-video-generator
          {...(markActive ? { 'data-mark-composer': true } : {})}
          data-scene-node-id={nodeId}
        >
          <CanvasMediaComposerShell
            panelOverflow="visible"
            attachment={
              <ComposerAttachmentStrip
                attachments={attachments}
                disabled={disabled || sending}
                onRemove={removeContext}
                attachTooltip={t('editor.tools.videoGenRef')}
                onAttachClick={() => fileRef.current?.click()}
                fileInput={{
                  ref: fileRef,
                  accept: 'image/*,video/*',
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
                  onSubmit={() => onGenerate()}
                  disabled={disabled || sending}
                  placeholder={t('editor.tools.videoGenPlaceholder')}
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
                    {t('editor.tools.videoSettings')}
                  </p>
                  <div onPointerDown={(e) => e.stopPropagation()}>
                    <VideoSettingsPanel
                      aspectRatio={aspectRatio}
                      resolution={resolution}
                      duration={duration}
                      onAspectRatioChange={applyAspectToNode}
                      onResolutionChange={(r) => {
                        setResolution(r);
                        persistGenSettings({ resolution: r });
                      }}
                      onDurationChange={(n) => {
                        setDuration(n);
                        persistGenSettings({ duration: n });
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
                      tab="video"
                      models={models}
                      selectedId={modelId}
                      status={modelsStatus}
                      hideAuto
                      useModelsAsIs
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
                  billingEnabled
                    ? t('wallet.creditCostTip', { count: creditCost })
                    : t('agent.send')
                }
                placement="top"
              >
                <button
                  type="button"
                  disabled={disabled || sending || attachmentsUploading || !prompt.trim()}
                  aria-label={t('editor.tools.videoGenSubmit')}
                  onClick={() => onGenerate()}
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
              assetKinds={['image', 'video']}
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

export default memo(VideoGeneratorCard);
