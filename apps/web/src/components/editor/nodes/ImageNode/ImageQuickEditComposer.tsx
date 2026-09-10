import type { SceneDocument } from '@/components/rcb/sceneNode';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from '@/store';
import { HiArrowUp, HiOutlineBolt, HiOutlineChevronDown, HiOutlinePlus, HiOutlineViewfinderCircle } from 'react-icons/hi2';
import { BiExit } from 'react-icons/bi';
import { PiSelectionPlus } from 'react-icons/pi';
import { generateImage, type LlmModel } from '@/service/chat';
import { generateImageBatch } from '@/service/generateImageBatch';
import { processJobAttrPatch } from '@/components/rcb/scene/document/processJobAttrs';
import {
  registerGeneratorSession,
  unregisterGeneratorSession,
} from '@/components/editor/nodes/shared/generatorSessionRegistry';
import { getHttpErrorMessage } from '@/service/client';
import { Dropdown, DropdownPanel, message, Tooltip } from '@/components/base';
import {
  SelectionToolbarShell,
} from '@/components/rcb/selection/chrome/SelectionToolbarShell';
import AgentComposerInput, {
  type AgentComposerHandle,
  type ComposerContext,
} from '@/components/editor/panels/AgentComposerInput';
import {
  ComposerAttachmentChip,
  composerAttachActionClass,
} from '@/components/editor/panels/agent/composer/AgentComposerShell';
import {
  GeneratorComposerPanel,
  GeneratorComposerUploadPanel,
} from '@/components/editor/panels/agent/composer/GeneratorComposerPanel';
import {
  composerCanSend,
  composerSendDisabledReason,
} from '@/components/editor/panels/agent/composer/composerModelsGate';
import { clearGeneratorProcessOverlay } from '@/components/editor/nodes/shared/clearGeneratorProcess';
import {
  buildImageGeneratorModelList,
} from '@/components/editor/nodes/shared/generatorModelLists';
import { ratioSummaryLabel } from '@/components/editor/nodes/shared/generatorAttrs';
import { usePendingCanvasAttachFly } from '@/components/editor/nodes/shared/composerCanvasAttach';
import { MEDIA_QUICK_EDIT_ATTR } from '@/components/editor/panels/agent/composer/composerMentionHelpers';
import { useGeneratorModelsCatalog } from '@/components/editor/panels/agent/composer/useGeneratorModelsCatalog';
import {
  buildComposerChipPrompt,
  collectComposerRefImages,
} from '@/components/editor/panels/agent/agentSendPath';
import ImageAspectRatioPicker, {
  DEFAULT_IMAGE_COUNT,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_IMAGE_RESOLUTION,
  modelImageLimits,
} from '@/components/editor/panels/agent/shared/ImageAspectRatioPicker';
import ModelPickerPanel, {
  ModelBrandIcon,
} from '@/components/editor/panels/agent/models/ModelPickerPanel';
import { cloudImageFallbackId } from '@/components/editor/panels/agent/llmModelMeta';
import {
  listImageVariantUrls,
  promptForImageSrc,
  applyVariantPromptPatch,
  writeImageVariantsAttr,
} from '@/components/rcb/scene/document/mediaLifecycle';
import {
  clearCanvasAttachPick,
  closeImageToolPanel,
  consumePendingQuickEditMarkContexts,
  finishImageProcess,
  openImageToolPanel,
  patchDocumentNode,
  pushEditorHistory,
  startCanvasAttachPick,
  setHoveredMarkPin,
  setSelectedNodeIds,
  type PendingMarkContextChip,
} from '@/store/modules/editor';
import {
  canMarkNode,
  markGateTipKey,
  markNodeGate,
} from '@/components/editor/nodes/ImageNode/mark/markGeometry';
import { noteCanvasFlyLand } from '@/components/editor/panels/agent/composer/flyToChat';
import { FREE_IMAGE_MODEL_ID, planAllowsModelPick } from '@/utils/wallet';
import { useShowCreditCosts, useWalletSnapshot } from '@/service/wallet';
import { cn } from '@/utils/classnames';
import { estimateImageCredits } from '@/utils/imageCredits';
import { createFilePreviewUrl } from '@/utils/uploadImage';
import { isMarkContextKey, syncMarkPinRemoved } from '@/components/editor/nodes/ImageNode/mark/markChipSync';
import { clearQuickEditMarkSession } from '@/components/editor/nodes/ImageNode/mark/markSessionCleanup';
import { insertPendingComposerChips } from '@/components/editor/panels/agent/composerChipInsert';
import store from '@/store';

type SceneBox = { left: number; top: number; width: number; height: number };

function nextQuickEditImageModelId(
  models: LlmModel[],
  currentId: string,
  canPickModel: boolean
): string | null {
  if (!canPickModel) {
    const fallback = cloudImageFallbackId();
    if (!fallback || currentId === fallback) return null;
    return fallback;
  }
  if (!models.length || models.some((m) => m.id === currentId)) return null;
  const preferred =
      models.find((m) => m.id === FREE_IMAGE_MODEL_ID) ||
      models.find((m) => /seedream/i.test(m.id));
    if (preferred) return preferred.id;
  return models[0]?.id ?? null;
}

/**
 * Floating quick-edit composer under a selected image.
 * Prefills `attrs.genPrompt`; uses the image as the primary i2i reference.
 */
function ImageQuickEditComposer({
  document,
  nodeId,
  box,
}: {
  document: SceneDocument;
  nodeId: string;
  box: SceneBox;
}): ReactNode {
  const { t } = useTranslation();
  const inputRef = useRef<AgentComposerHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const node = document?.deltaSetLike?.[nodeId];
  const src = String(node?.attrs?.src || '').trim();
  const savedPrompt = promptForImageSrc(node?.attrs, src);

  const [prompt, setPrompt] = useState(savedPrompt);
  const [contexts, setContexts] = useState<ComposerContext[]>([]);
  const [sending, setSending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [modelId, setModelId] = useState(() => cloudImageFallbackId());
  const [resolution, setResolution] = useState<string>(DEFAULT_IMAGE_RESOLUTION);
  const [aspectRatio, setAspectRatio] = useState<string>(DEFAULT_IMAGE_ASPECT_RATIO);
  const [imageCount, setImageCount] = useState<number>(DEFAULT_IMAGE_COUNT);

  const { planId } = useWalletSnapshot();
  const showCreditCosts = useShowCreditCosts();
  const canPickModel = planAllowsModelPick(planId);
  const resolveQuickEditModelId = useCallback(
    (list: LlmModel[], currentId: string) =>
      nextQuickEditImageModelId(list, currentId, canPickModel),
    [canPickModel]
  );
  const { models, status: modelsStatus, catalogAvailable: apiAvailable } = useGeneratorModelsCatalog({
    buildList: buildImageGeneratorModelList,
    modelId,
    setModelId,
    resolveModelId: resolveQuickEditModelId,
    resetKey: `${nodeId}:${canPickModel ? '1' : '0'}`,
  });
  const pendingQuickEditMarks = useSelector(
    (s: any) => (s.editor.pendingQuickEditMarkContexts || []) as PendingMarkContextChip[]
  );
  const imageToolPanel = useSelector(
    (s: any) => s.editor.imageToolPanel as null | { nodeId: string; kind: string; markSink?: string }
  );
  const markActive =
    imageToolPanel?.kind === 'mark' &&
    imageToolPanel?.markSink === 'quickEdit' &&
    imageToolPanel?.nodeId === nodeId;
  const nodeProcessing = String(node?.attrs?.processStatus || '') === 'running';
  const canvasAttachPick = useSelector(
    (s: any) => s.editor?.canvasAttachPick as null | { target: string }
  );
  const pendingCanvasAttach = useSelector(
    (s: any) =>
      s.editor?.pendingCanvasAttach as null | {
        target: string;
        payload: string | string[];
      }
  );
  const pickTarget = `node:${nodeId}`;
  const pickingFromCanvas = canvasAttachPick?.target === pickTarget;
  const contextsRef = useRef(contexts);
  contextsRef.current = contexts;
  const pendingMarksLockRef = useRef<string | null>(null);
  const promptRef = useRef(prompt);
  promptRef.current = prompt;
  const prevSrcRef = useRef(src);

  useEffect(() => {
    const prevSrc = prevSrcRef.current;
    if (prevSrc && prevSrc !== src) {
      const draft = promptRef.current.trim();
      if (draft && nodeId) {
        const attrs = { ...(node?.attrs || {}) } as Record<string, unknown>;
        applyVariantPromptPatch(attrs, prevSrc, draft);
        patchDocumentNode({
            nodeId,
            skipHistory: true,
            patch: { attrs },
          });
      }
    }
    prevSrcRef.current = src;
    setPrompt(promptForImageSrc(node?.attrs, src));
    pendingMarksLockRef.current = null;
  }, [nodeId, src, savedPrompt, node?.attrs?.imageVariantPrompts, node?.attrs]);

  usePendingCanvasAttachFly({
    pickTarget,
    pending: pendingCanvasAttach,
    document,
    contextsRef,
    setContexts,
    insertChip: (ctx) => {
      inputRef.current?.insertContextAtCaret(ctx);
      inputRef.current?.focus();
    },
  });

  // Auto-focus prompt when the floating chat panel opens.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [nodeId]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!pendingQuickEditMarks.length) {
      pendingMarksLockRef.current = null;
      return;
    }
    const token = pendingQuickEditMarks.map((c) => c.key).join('|');
    if (pendingMarksLockRef.current === token) {
      return;
    }
    pendingMarksLockRef.current = token;
    const list = pendingQuickEditMarks.slice();
    consumePendingQuickEditMarkContexts();
    // Same caret path as Add from canvas — never force chips before typed text.
    insertPendingComposerChips(() => inputRef.current, list, { focus: 'caret' });
  }, [pendingQuickEditMarks]);

  const attachments = contexts.filter((c) => c.kind === 'attachment');
  const inlineContexts = contexts.filter((c) => c.kind !== 'attachment');
  const canSendComposer =
    Boolean(prompt.trim()) || inlineContexts.length > 0;
  const canSendGen = composerCanSend({
    hasContent: canSendComposer,
    sending,
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
  const selectedModel = models.find((m) => m.id === modelId);
  const creditCost = estimateImageCredits(selectedModel, imageCount, resolution);
  const settingsSummary = `${resolution} · ${ratioSummaryLabel(aspectRatio, t)} · ${imageCount}`;

  const removeContext = (key: string) => {
    if (isMarkContextKey(key)) syncMarkPinRemoved(key);
    setContexts((prev) => prev.filter((c) => c.key !== key));
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

  const onPickRef = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith('image/'));
    e.target.value = '';
    if (!files.length) return;
    const results = await Promise.all(
      files.map(async (file, i) => {
        try {
          const dataUrl = createFilePreviewUrl(file);
          return {
            key: `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${i}`,
            kind: 'attachment' as const,
            label: file.name || 'image',
            payload: dataUrl,
            dataUrl,
            thumbUrl: dataUrl,
          } satisfies ComposerContext;
        } catch {
          return null;
        }
      })
    );
    const next = results.filter(Boolean) as ComposerContext[];
    if (!next.length) return;
    setContexts((prev) => [...prev, ...next]);
  };

  const dismissComposerAfterSend = () => {
    clearCanvasAttachPick();
    setHoveredMarkPin(null);
    for (const c of contextsRef.current) {
      if (isMarkContextKey(c.key)) syncMarkPinRemoved(c.key);
    }
    closeImageToolPanel();
  };

  const onGenerate = async () => {
    const text = prompt.trim();
    if (!canSendGen || !src) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dismissComposerAfterSend();
    setSelectedNodeIds([]);
    registerGeneratorSession(nodeId);
    setSending(true);
    let finished = false;
    pushEditorHistory();
    patchDocumentNode({
        nodeId,
        skipHistory: true,
        patch: {
          attrs: {
            processStatus: 'running',
            processKind: 'quickEdit',
            processLabel: t('editor.imageToolbar.processingQuickEdit'),
            processStartedAt: String(Date.now()),
            genPrompt: text,
          },
        },
      });
    try {
      const promptForApi = buildComposerChipPrompt(contexts, text);
      const body: Parameters<typeof generateImage>[0] = {
        prompt: promptForApi,
        model: canPickModel ? modelId : cloudImageFallbackId() || modelId,
        quality: DEFAULT_IMAGE_QUALITY,
        resolution,
        images: collectComposerRefImages(contexts, src),
      };
      if (aspectRatio !== 'smart') body.aspect_ratio = aspectRatio;

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
      const nextSrc = urls[0] || '';
      if (!nextSrc) throw new Error(t('editor.tools.imageGenEmpty'));

      const prev = listImageVariantUrls(node);
      const stack = [...new Set([nextSrc, ...urls, ...prev.filter((u) => u !== nextSrc)])];
      const variantAttrs: Record<string, unknown> = {};
      writeImageVariantsAttr(variantAttrs, stack);
      applyVariantPromptPatch(variantAttrs, nextSrc, text);
      for (const u of urls) applyVariantPromptPatch(variantAttrs, u, text);

      finishImageProcess({
          nodeId,
          src: nextSrc,
          attrs: {
            ...variantAttrs,
          },
        });
      for (const c of contexts) {
        if (isMarkContextKey(c.key)) syncMarkPinRemoved(c.key);
      }
      closeImageToolPanel();
      finished = true;
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        message.error(getHttpErrorMessage(err, t('editor.tools.imageGenFail')));
      }
    } finally {
      unregisterGeneratorSession(nodeId);
      const doc = (store.getState() as { editor?: { document?: SceneDocument } }).editor
        ?.document;
      if (!finished) {
        clearGeneratorProcessOverlay(doc, nodeId);
      }
      if (abortRef.current === ac) abortRef.current = null;
      setSending(false);
    }
  };

  const subjectChip = useMemo(
    () =>
      src
        ? ({
            key: `subject-${nodeId}`,
            kind: 'attachment',
            label: t('editor.imageToolbar.chatSubject'),
            payload: src,
            dataUrl: src,
            thumbUrl: src,
          } satisfies ComposerContext)
        : null,
    [nodeId, src, t]
  );

  const markGate = useMemo(() => markNodeGate(node), [node]);
  const markReady = markGate.status === 'ready';
  const onMark = () => {
    if (!markReady) {
      return;
    }
    if (markActive) {
      clearQuickEditMarkSession(document);
      openImageToolPanel({ nodeId, kind: 'quickEdit' });
      return;
    }
    openImageToolPanel({ nodeId, kind: 'mark', markSink: 'quickEdit' });
  };

  const onCloseQuickEdit = () => {
    abortRef.current?.abort();
    clearCanvasAttachPick();
    setHoveredMarkPin(null);
    for (const c of contextsRef.current) {
      if (isMarkContextKey(c.key)) syncMarkPinRemoved(c.key);
    }
    closeImageToolPanel();
  };

  if (!node) return null;

  // Send → exit immediately; loading uses the node glow badge only (no bottom bar).
  if (sending || nodeProcessing) return null;

  if (!src) {
    return (
      <SelectionToolbarShell
        box={box}
        bare
        dock="below"
        zIndexClassName="z-[32]"
        {...{ [MEDIA_QUICK_EDIT_ATTR]: true }}
        data-scene-node-id={nodeId}
      >
        <GeneratorComposerUploadPanel
          label={t('editor.imageToolbar.processingUpload', '上传中…')}
        />
      </SelectionToolbarShell>
    );
  }

  return (
    <SelectionToolbarShell
      box={box}
      bare
      dock="below"
      zIndexClassName={markActive ? 'z-[40]' : 'z-[32]'}
      {...{ [MEDIA_QUICK_EDIT_ATTR]: true }}
      {...(markActive ? { 'data-mark-composer': true } : {})}
      data-scene-node-id={nodeId}
    >
      <GeneratorComposerPanel>
        <div className="flex min-h-0 shrink-0 items-start justify-between gap-2 px-3 pt-2.5">
          <div className="flex max-h-[72px] min-w-0 flex-1 flex-wrap items-center gap-1.5 overflow-y-auto">
          {subjectChip ? (
            <ComposerAttachmentChip
              attachment={subjectChip}
              removable={false}
              onRemove={() => undefined}
            />
          ) : null}
          {attachments.map((att) => (
            <ComposerAttachmentChip
              key={att.key}
              attachment={att}
              disabled={sending}
              onRemove={removeContext}
            />
          ))}
          <Tooltip tip={t('editor.tools.imageGenRef')} placement="top">
            <button
              type="button"
              disabled={sending}
              aria-label={t('editor.tools.imageGenRef')}
              onClick={() => fileRef.current?.click()}
              className={composerAttachActionClass()}
            >
              <HiOutlinePlus className="h-4 w-4" strokeWidth={2} />
            </button>
          </Tooltip>
          <Tooltip tip={t(markGateTipKey(markGate))} placement="top">
            <button
              type="button"
              disabled={sending || !markReady}
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
          <Tooltip
            tip={pickingFromCanvas ? t('agent.pickFromCanvasCancel') : t('agent.pickFromCanvas')}
            placement="top"
          >
            <button
              type="button"
              disabled={sending}
              aria-label={t('agent.pickFromCanvas')}
              aria-pressed={pickingFromCanvas}
              onClick={() => {
                if (pickingFromCanvas) {
                  clearCanvasAttachPick();
                  return;
                }
                noteCanvasFlyLand(pickTarget);
                startCanvasAttachPick({ target: pickTarget, accept: 'image' });
              }}
              className={composerAttachActionClass(pickingFromCanvas)}
            >
              <HiOutlineViewfinderCircle className="h-4 w-4" strokeWidth={2} />
            </button>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={onPickRef}
          />
          </div>
          <Tooltip tip={t('editor.exit')} placement="top">
            <button
              type="button"
              aria-label={t('editor.exit')}
              onClick={onCloseQuickEdit}
              className={composerAttachActionClass()}
            >
              <BiExit className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>

        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- pointer padding to focus; keyboard tabs into contenteditable */}
        <div
          className="min-h-0 min-w-0 flex-1 cursor-text overflow-hidden px-3 pt-2"
          onClick={(e) => {
            if ((e.target as HTMLElement | null)?.closest?.('[data-agent-composer]')) return;
            inputRef.current?.focus();
          }}
        >
          <AgentComposerInput
            ref={inputRef}
            contexts={inlineContexts}
            onContextsChange={onInlineContextsChange}
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => {
              if (canSendGen) onGenerate();
            }}
            // canSendGen only gates the send button — empty prompt must stay editable.
            disabled={sending}
            placeholder={t('editor.tools.imageGenPlaceholder')}
            flyLandId={pickTarget}
            className="min-h-full w-full text-[13px]"
          />
        </div>

        <div className="mt-1 flex items-center gap-1.5 px-2.5 pb-2">
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
                <ImageAspectRatioPicker
                  variant="image"
                  resolution={resolution}
                  aspectRatio={aspectRatio}
                  imageCount={imageCount}
                  imageLimits={modelImageLimits(selectedModel)}
                  onResolutionChange={(r) => setResolution(r)}
                  onAspectRatioChange={(r) => setAspectRatio(r)}
                  onImageCountChange={(n) => setImageCount(n)}
                  disabled={sending}
                />
              </DropdownPanel>
            )}
          >
            <button
              type="button"
              disabled={sending}
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

          <div className="ml-auto flex items-center gap-1">
            {canPickModel ? (
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
                    disabled={sending}
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
            ) : (
              <span className="inline-flex h-7 w-7 items-center justify-center">
                <ModelBrandIcon
                  model={{ id: cloudImageFallbackId() || modelId || '' }}
                  className="h-3.5 w-3.5"
                />
              </span>
            )}

            <Tooltip
              tip={
                sendDisabledReason ||
                (showCreditCosts
                  ? t('wallet.creditCostTip', { count: creditCost })
                  : t('agent.send'))
              }
              placement="top"
            >
              <button
                type="button"
                disabled={!canSendGen}
                onClick={() => {
                  onGenerate();
                }}
                className={cn(
                  'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11px] font-semibold transition',
                  'bg-[var(--ink)] text-[var(--on-brand)] disabled:opacity-40',
                  !showCreditCosts && 'h-7 w-7 justify-center px-0'
                )}
              >
                {showCreditCosts ? (
                  <>
                    <HiOutlineBolt className="h-3.5 w-3.5" strokeWidth={2} />
                    <span className="tabular-nums">{creditCost}</span>
                  </>
                ) : (
                  <HiArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />
                )}
              </button>
            </Tooltip>
          </div>
        </div>
      </GeneratorComposerPanel>
    </SelectionToolbarShell>
  );
}

export default memo(ImageQuickEditComposer);
