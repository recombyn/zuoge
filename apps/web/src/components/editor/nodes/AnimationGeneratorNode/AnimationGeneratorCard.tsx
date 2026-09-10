import type { SceneDocument } from '@/components/rcb/sceneNode';
/**
 * Lottie generator composer under the empty plate.
 * On-plate generate — POST /api/v1/chat/lottie/jobs — promote to Lottie node.
 */
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useSelector } from '@/store';
import { useEditorDocument } from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import { FloatingPortal } from '@floating-ui/react';
import {
  HiArrowUp,
  HiOutlineBolt,
  HiOutlineChevronDown,
} from 'react-icons/hi2';
import { createLottieJob, waitForLottieJob } from '@/service/chat';
import { getHttpErrorMessage } from '@/service/client';
import { useBillingEnabled } from '@/service/wallet';
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
  CanvasMediaComposerShell,
  ComposerAttachmentStrip,
  ComposerCanvasPickButton,
  ComposerFooterActions,
  ComposerFooterBar,
  ComposerPromptRegion,
} from '@/components/editor/panels/agent/composer/CanvasMediaComposerShell';
import MentionAttachPanel, {
  type MentionAttachItem,
} from '@/components/editor/panels/agent/composer/MentionAttachPanel';
import { useComposerSlashSkills } from '@/components/editor/panels/agent/composer/useComposerSlashSkills';
import { useComposerMentionPanel } from '@/components/editor/panels/agent/composer/useComposerMentionPanel';
import { useGeneratorModelsCatalog } from '@/components/editor/panels/agent/composer/useGeneratorModelsCatalog';
import { insertMentionFromAttachment } from '@/components/editor/panels/agent/composer/composerMentionHelpers';
import type { UserAsset } from '@/models/assets';
import {
  DEFAULT_LOTTIE_ASPECT,
  DEFAULT_LOTTIE_DURATION,
  AnimationSettingsPanel,
} from '@/components/editor/panels/agent/shared/AnimationSettingsPanel';
import ModelPickerPanel, {
  ModelBrandIcon,
} from '@/components/editor/panels/agent/models/ModelPickerPanel';
import { readGenAttrString, readGenAttrDuration } from '@/components/editor/nodes/shared/generatorAttrs';
import {
  buildLottieChatModelList,
  nextLottieChatModelId,
  pickVisionChatModel,
} from '@/components/editor/nodes/shared/generatorModelLists';
import {
  attachSelectionToComposer,
  pickOrAttachFromCanvas,
  usePendingCanvasAttachFly,
} from '@/components/editor/nodes/shared/composerCanvasAttach';
import { finishGeneratorGenerateSession } from '@/components/editor/nodes/shared/finishGeneratorGenerate';
import { modelSupportsVisionInput } from '@/components/editor/panels/agent/llmModelMeta';
import {
  hasActiveGeneratorSession,
  registerGeneratorSession,
} from '@/components/editor/nodes/shared/generatorSessionRegistry';
import {
  parseLottieAnimationData
} from '@/components/rcb/scene/document/nodeFactories';
import { processJobAttrPatch } from '@/components/rcb/scene/document/processJobAttrs';
import {
  clearCanvasAttachPick,
  EMPTY_ID_LIST,
  finishLottieGenerator,
  patchDocumentNode,
  startCanvasAttachPick,
} from '@/store/modules/editor';
import { noteCanvasFlyLand } from '@/components/editor/panels/agent/composer/flyToChat';
import { cn } from '@/utils/classnames';
import { estimateLottieCredits } from '@/utils/imageCredits';
import { createFilePreviewUrl } from '@/utils/uploadImage';
import store from '@/store';

type Props = {
  nodeId: string;
  sceneBox: { x: number; y: number; width: number; height: number };
  disabled?: boolean;
};

const DEFAULT_AGENT_MODEL_ID = '';

function isImageFile(file: File) {
  return file.type.startsWith('image/');
}

function plateSizeForAspect(
  box: { x: number; y: number; width: number; height: number },
  aspectRatio: string
) {
  const [rw, rh] = String(aspectRatio || DEFAULT_LOTTIE_ASPECT)
    .split(':')
    .map(Number);
  const ratio = rw > 0 && rh > 0 ? rw / rh : 1;
  const area = Math.max(1, box.width * box.height);
  let height = Math.sqrt(area / ratio);
  let width = height * ratio;
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

function AnimationGeneratorCard({
  nodeId,
  sceneBox,
  disabled = false,
}: Props): ReactNode {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<AgentComposerHandle | null>(null);
  const contextsRef = useRef<ComposerContext[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const genAttrs = useSelector(
    (state: any) =>
      (state.editor?.document?.deltaSetLike?.[nodeId]?.attrs || null) as Record<
        string,
        unknown
      > | null
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
  const selectedNodeIds = useSelector(
    (state: any) => (state.editor?.selectedNodeIds as string[]) ?? EMPTY_ID_LIST
  );
  const selectedFrameIds = useSelector(
    (state: any) => (state.editor?.selectedFrameIds as string[]) ?? EMPTY_ID_LIST
  );

  const pickTarget = `node:${nodeId}`;
  const pickingFromCanvas = canvasAttachPick?.target === pickTarget;

  const [prompt, setPrompt] = useState('');
  const [contexts, setContexts] = useState<ComposerContext[]>([]);
  const [sending, setSending] = useState(false);
  const composerVisible = !sending;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(
    () => readGenAttrString(genAttrs, 'lottieGenAspect') || DEFAULT_LOTTIE_ASPECT
  );
  const [duration, setDuration] = useState(
    () => readGenAttrDuration(genAttrs, 'lottieGenDuration', 1, 60) ?? DEFAULT_LOTTIE_DURATION
  );
  const [modelId, setModelId] = useState(() => {
    const saved = readGenAttrString(genAttrs, 'lottieGenModel');
    return saved && saved !== 'auto' ? saved : DEFAULT_AGENT_MODEL_ID;
  });
  const { models, status: modelsStatus } = useGeneratorModelsCatalog({
    buildList: buildLottieChatModelList,
    modelId,
    setModelId,
    resolveModelId: nextLottieChatModelId,
  });

  contextsRef.current = contexts;

  const {
    mentionOpen,
    mentionQuery,
    closeMention,
    openMention,
    mentionFloating,
    mentionIx,
  } = useComposerMentionPanel(inputRef);

  const wasComposerVisibleRef = useRef(false);
  useEffect(() => {
    if (!composerVisible || disabled) {
      wasComposerVisibleRef.current = false;
      return;
    }
    if (wasComposerVisibleRef.current) return;
    wasComposerVisibleRef.current = true;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [composerVisible, disabled]);

  useEffect(() => {
    const nextAspect = readGenAttrString(genAttrs, 'lottieGenAspect');
    if (nextAspect) setAspectRatio(nextAspect);
    const nextDuration = readGenAttrDuration(genAttrs, 'lottieGenDuration', 1, 60);
    if (nextDuration != null) setDuration(nextDuration);
    const nextModel = readGenAttrString(genAttrs, 'lottieGenModel');
    if (nextModel && nextModel !== 'auto') setModelId(nextModel);
  }, [nodeId, genAttrs?.lottieGenAspect, genAttrs?.lottieGenDuration, genAttrs?.lottieGenModel]);

  usePendingCanvasAttachFly({
    pickTarget,
    pending: pendingCanvasAttach,
    document: editorDocument || (store.getState() as any).editor?.document,
    contextsRef,
    setContexts,
    imagesOnly: true,
    insertChip: (ctx) => {
      inputRef.current?.insertContextAtCaret(ctx);
      inputRef.current?.focus();
    },
  });

  useEffect(() => {
    const id = nodeId;
    return () => {
      // Card unmounts when selection clears / processing hides the toolbar —
      // keep the in-flight generate promise alive (session registry).
      if (hasActiveGeneratorSession(id)) return;
      abortRef.current?.abort();
    };
  }, [nodeId]);

  const attachments = useMemo(
    () => contexts.filter((c) => c.kind === 'attachment'),
    [contexts]
  );
  const inlineContexts = useMemo(
    () => contexts.filter((c) => c.kind !== 'attachment'),
    [contexts]
  );
  const imageRefUrls = useMemo(
    () =>
      attachments
        .map((c) => String(c.dataUrl || c.thumbUrl || '').trim())
        .filter((u) => u.startsWith('data:image/') || /^https?:\/\//i.test(u))
        .slice(0, 4),
    [attachments]
  );
  const needsVisionModel = imageRefUrls.length > 0;
  const selectedModel = models.find((m) => m.id === modelId);
  const pickerModels = useMemo(
    () => (needsVisionModel ? models.filter((m) => modelSupportsVisionInput(m)) : models),
    [models, needsVisionModel]
  );
  const billingEnabled = useBillingEnabled();
  const creditCost = estimateLottieCredits(selectedModel, duration);
  const settingsSummary = `${aspectRatio} · ${duration}s`;

  const removeContext = (key: string) =>
    setContexts((prev) =>
      prev.filter((c) => c.key !== key && chipBaseKey(c.key) !== chipBaseKey(key))
    );

  const attachRefFiles = async (files: File[]) => {
    const accepted = files.filter((f) => isImageFile(f));
    if (!accepted.length) {
      message.error(t('editor.tools.lottieGenUploadHint'));
      return;
    }
    const results = await Promise.all(
      accepted.map(async (file, i) => {
        const key = `attach:${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`;
        try {
          const dataUrl = createFilePreviewUrl(file);
          return {
            key,
            label: file.name || t('editor.tools.lottieGenRefImage'),
            kind: 'attachment' as const,
            payload: '',
            dataUrl,
            thumbUrl: dataUrl,
          } satisfies ComposerContext;
        } catch {
          message.error(t('agent.attachReadFailed', { name: file.name }));
          return null;
        }
      })
    );
    const next = results.filter(Boolean) as ComposerContext[];
    if (!next.length) return;
    setContexts((prev) => [...prev, ...next]);
  };

  const onPickRef = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    await attachRefFiles(files);
  };

  // `/` skills and `@` attachment mentions share the same composer trigger path as Agent.
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

  const persistGenSettings = (patch: {
    aspect?: string;
    duration?: number;
    model?: string;
  }) => {
    const attrs: Record<string, unknown> = {};
    if (patch.aspect != null) attrs.lottieGenAspect = patch.aspect;
    if (patch.duration != null) attrs.lottieGenDuration = patch.duration;
    if (patch.model != null) attrs.lottieGenModel = patch.model;
    if (!Object.keys(attrs).length) return;
    patchDocumentNode({ nodeId, patch: { attrs } });
  };

  // Image refs require a vision-capable model — auto-switch when current can't see images.
  useEffect(() => {
    if (!needsVisionModel || !models.length) return;
    if (modelSupportsVisionInput(selectedModel)) return;
    const next = pickVisionChatModel(models, modelId);
    if (!next || next.id === modelId) return;
    setModelId(next.id);
    persistGenSettings({ model: next.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsVisionModel, models, modelId, selectedModel]);

  const applyAspectToNode = (nextAspect: string) => {
    setAspectRatio(nextAspect);
    persistGenSettings({ aspect: nextAspect });
    const next = plateSizeForAspect(sceneBox, nextAspect);
    patchDocumentNode({
        nodeId,
        patch: {
          x: next.x,
          y: next.y,
          width: next.width,
          height: next.height,
          attrs: { lottieGenAspect: nextAspect },
        },
      });
  };

  const onGenerate = async () => {
    const text = prompt.trim();
    if (!text || sending || disabled) return;

    let useModelId = modelId;
    if (needsVisionModel && !modelSupportsVisionInput(selectedModel)) {
      const next = pickVisionChatModel(models, modelId);
      if (!next) {
        message.error(t('editor.tools.lottieGenNeedVisionModel'));
        return;
      }
      useModelId = next.id;
      setModelId(next.id);
      persistGenSettings({ model: next.id });
    }

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Register before processStatus hides the selection toolbar (unmount).
    registerGeneratorSession(nodeId);
    setSending(true);
    let finished = false;
    patchDocumentNode({
        nodeId,
        patch: {
          attrs: {
            processStatus: 'running',
            processKind: 'generate',
            processLabel: t('editor.tools.lottieGenerating'),
            processStartedAt: String(Date.now()),
            lottieGenAspect: aspectRatio,
            lottieGenDuration: duration,
            lottieGenModel: useModelId,
            genPrompt: text,
          },
        },
      });
    try {
      const genW = Math.min(512, Math.max(32, Math.round(sceneBox.width)));
      const genH = Math.min(512, Math.max(32, Math.round(sceneBox.height)));
      const jobId = await createLottieJob(
        {
          prompt: text,
          width: genW,
          height: genH,
          duration_sec: duration,
          model: useModelId || undefined,
          ...(imageRefUrls.length ? { images: imageRefUrls } : {}),
        },
        { signal: ac.signal }
      );
      patchDocumentNode({
          nodeId,
          skipHistory: true,
          patch: { attrs: processJobAttrPatch([jobId]) },
        });
      const res = await waitForLottieJob(jobId, { signal: ac.signal });
      const animationData = parseLottieAnimationData(res?.animationData) || null;
      if (!animationData) throw new Error(t('editor.tools.lottieGenEmpty'));

      const aw = Math.max(1, Number(animationData.w) || genW);
      const ah = Math.max(1, Number(animationData.h) || genH);
      // Fit natural animation into current plate (keep center).
      const fit = Math.min(sceneBox.width / aw, sceneBox.height / ah);
      const outW = Math.max(32, Math.round(aw * fit));
      const outH = Math.max(32, Math.round(ah * fit));
      const outX = Math.round(sceneBox.x + (sceneBox.width - outW) / 2);
      const outY = Math.round(sceneBox.y + (sceneBox.height - outH) / 2);

      finishLottieGenerator({
          nodeId,
          animationData,
          genPrompt: text,
          name: text,
          width: outW,
          height: outH,
          x: outX,
          y: outY,
        });
      finished = true;
    } catch (err: unknown) {
      if (!ac.signal.aborted) {
        message.error(getHttpErrorMessage(err, t('editor.tools.lottieGenFail')));
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
          imagesOnly: true,
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
      zIndexClassName="z-[32]"
      data-lottie-generator
      data-scene-node-id={nodeId}
    >
      <CanvasMediaComposerShell
        panelOverflow="visible"
        attachment={
          <ComposerAttachmentStrip
            attachments={attachments}
            disabled={disabled || sending}
            onRemove={removeContext}
            attachTooltip={t('editor.tools.lottieGenUpload')}
            attachAriaLabel={t('editor.tools.lottieGenUpload')}
            onAttachClick={() => fileRef.current?.click()}
            fileInput={{
              ref: fileRef,
              accept: 'image/*',
              multiple: true,
              onChange: onPickRef,
            }}
            extraActions={
              <ComposerCanvasPickButton
                pickingFromCanvas={pickingFromCanvas}
                disabled={disabled || sending}
                onClick={onCanvasPick}
              />
            }
          />
        }
        prompt={
          <ComposerPromptRegion onFocusInput={() => inputRef.current?.focus()}>
            <AgentComposerInput
              ref={inputRef}
              contexts={inlineContexts}
              onContextsChange={(next) => {
                setContexts([...attachments, ...next]);
              }}
              value={prompt}
              onChange={(next) => {
                setPrompt(next);
                maybeOpenComposerMentions(next);
              }}
              onSubmit={() => onGenerate()}
              disabled={disabled || sending}
              placeholder={t('editor.tools.lottieGenPlaceholder')}
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
              <DropdownPanel className="w-[min(22rem,calc(100vw-2rem))] p-3">
                <p className="mb-2.5 text-[13px] font-semibold text-[var(--ink)]">
                  {t('editor.tools.lottieSettings')}
                </p>
                <div onPointerDown={(e) => e.stopPropagation()}>
                  <AnimationSettingsPanel
                    aspectRatio={aspectRatio}
                    duration={duration}
                    onAspectRatioChange={applyAspectToNode}
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
                    tab="design"
                    models={pickerModels}
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
                disabled={disabled || sending || !prompt.trim()}
                aria-label={t('editor.tools.lottieGenSubmit')}
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

export default memo(AnimationGeneratorCard);
