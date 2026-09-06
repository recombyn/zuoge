import { forwardRef, useRef, type ReactNode, type Ref, memo } from 'react';
import { useEffect, useState } from 'react';

import { useTranslation } from 'react-i18next';
import {
  HiOutlineArrowUturnLeft,
  HiOutlineCheckCircle,
  HiOutlineChevronRight,
  HiOutlineComputerDesktop,
  HiOutlineExclamationTriangle,
  HiOutlinePlay,
  HiOutlineXCircle,
} from 'react-icons/hi2';
import ChatMarkdown from '@/components/editor/panels/ChatMarkdown';
import { ContextChipPill } from '@/components/editor/panels/AgentComposerInput';
import {
  SoftGlowSurface,
  VirtualList,
  type VirtualListHandle,
} from '@/components/base';
import { message } from '@/components/base';
import { cn } from '@/utils/classnames';
import {
  scheduleClearMediaAssetDragData,
  setMediaAssetDragData,
} from '@/utils/chatImageDrag';
import { UserAssetCard } from '@/components/home/UserAssetMediaCard';
import type { UserAsset } from '@/models/assets';
import {
  localizeAgentProcessCopy,
  looksLikeKernelProcessDump,
} from '@/components/editor/panels/agent/agentProcessI18n';
import { placeMediaAsset } from '@/store/modules/editor';

/** Leading icon tone for process / explore rows. */
export type ExploreItemTone = 'ok' | 'warn' | 'error';

export type ChatUiMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** @ chips shown like the composer (label + kind + optional thumb). */
  contexts?: Array<{
    key: string;
    label: string;
    kind: string;
    thumbUrl?: string;
  }>;
  /** `content` with U+FFFC where each context chip sat (inline layout in the bubble). */
  contentMarked?: string;
  /** Design deep-think / reasoner stream — shown inside the foldable gray process. */
  thinking?: string;
  /** Intent analysis — shown inside the foldable gray process, not as final reply. */
  intent?: string;
  streaming?: boolean;
  /** Tool execution steps shown in the turn. */
  steps?: Array<{
    id: string;
    name: string;
    status: 'running' | 'done' | 'error' | 'pending';
    kind?: 'thought' | 'explored' | 'tool' | 'added' | 'updated' | 'skipped' | 'deleted';
    /** Timeline tone: confirm / success / info (all plain text rows). */
    variant?: 'confirm' | 'success' | 'info';
    summary?: string;
    /** Nested lines under Explored. */
    items?: Array<{
      id: string;
      name: string;
      summary?: string;
      /** Row tone for the leading icon (ok / warn / error). */
      tone?: 'ok' | 'warn' | 'error';
    }>;
    /** Expandable markdown body (diagrams / long notes). */
    body?: string;
  }>;
  /** Seedream / Image-mode results shown as a gallery (not SVG). */
  images?: string[];
  /** Video-mode results shown as a gallery. */
  videos?: string[];
  /** Audio-mode TTS results shown as a gallery. */
  audios?: string[];
  /** Lottie-mode results — inline animation JSON and/or stored asset URL. */
  lotties?: Array<{
    animationData?: Record<string, unknown>;
    w?: number;
    h?: number;
    url?: string;
  }>;
  /** While image-gen is running: expected card count for shimmer placeholders. */
  imagePendingCount?: number;
  /** While video-gen is running: expected card count for shimmer placeholders. */
  videoPendingCount?: number;
  /** While audio-gen is running: expected card count for shimmer placeholders. */
  audioPendingCount?: number;
  /** While lottie-gen is running: expected card count for shimmer placeholders. */
  lottiePendingCount?: number;
  /** Image-gen aspect (e.g. 9:16) — sizes shimmer / gallery cards. */
  imageAspectRatio?: string;
  /** Image-gen model id — brand icon in the worked-for row. */
  imageModelId?: string;
  /** Image-gen model display name shown before "Worked for …". */
  imageModelLabel?: string;
  /** Canvas was mutated by the reply to this user turn; restore available while editing (in-memory). */
  canRestore?: boolean;
  /** Epoch ms when this assistant turn started streaming. */
  startedAt?: number;
  /** Wall time for completed turn (ms). */
  durationMs?: number;
  /** Ask mode: proposed tool_ops waiting for an option with action=apply. */
  proposedOps?: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
  /** Server-bound Ask proposal id (design_task.meta.ask_proposal). */
  proposalId?: string;
  /** Ask interaction UI — mode + options; text = freeform reply. */
  choiceUi?: {
    mode: 'confirm' | 'single' | 'multi' | 'buttons' | 'text';
    options: Array<{
      label: string;
      action: 'apply' | 'reply' | 'dismiss';
      value?: string;
    }>;
    placeholder?: string;
  };
  /** Live-draw pipeline progress — kept for training UI; not shown in normal chat. */
  pipeline?: {
    category: string;
    labels: string[];
    currentIndex: number;
    stepConfirm: boolean;
    collabMode?: 'collaborative' | 'milestone' | 'auto';
  };
  /** True while canvas nodes are being added one-by-one. */
  drawing?: boolean;
  /** LangGraph design task id (for pause / resume). */
  designTaskId?: string;
  designResumeToken?: string;
  /** Generation paused with a durable checkpoint — show Resume. */
  canResume?: boolean;
  /** Phase-2 Design Intelligence panel (DNA / scores / diff / iterations). */
  intelligence?: import('@/components/editor/panels/agent/runDesignAgent').DesignIntelligencePatch;
  /** Developer-only SSE dumps (visibility=developer|internal). */
  debugEvents?: Array<{
    id: string;
    kind: string;
    text?: string;
    at: number;
  }>;
};

export type AssistantStep = NonNullable<ChatUiMessage['steps']>[number];

const AGENT_DEV_DEBUG_KEY = 'recombyn.agentDevDebug.v1';

/**
 * Product UI does not expose a toggle. Enable dumps by flipping this flag in code,
 * or set localStorage `recombyn.agentDevDebug.v1` = `1` in DevTools.
 */
const AGENT_DEV_DEBUG_IN_CODE = false;

export function loadAgentDevDebug(): boolean {
  if (AGENT_DEV_DEBUG_IN_CODE) return true;
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(AGENT_DEV_DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

export type ActivityStepEvent = {
  kind: 'thought' | 'added' | 'updated' | 'explored' | 'skipped' | 'deleted' | 'tool';
  status: 'running' | 'done' | 'error';
  durationSec?: number;
  count?: number;
  skillName?: string;
  detail?: string;
  stage?: string;
  /** Stable kernel code for FE i18n (e.g. ops_validate_failed). */
  code?: string;
};

const REVIEW_SCORE_ORDER = [
  'composition',
  'hierarchy',
  'typography',
  'color',
  'consistency',
  'content',
  'originality',
] as const;

export function pctLabel(value: number | null | undefined, digits = 0): string {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function formatDiffDeltaLine(
  key: string,
  delta: number | null | undefined,
  before?: number | null,
  after?: number | null
): string | null {
  if (delta == null || Math.abs(Number(delta)) < 0.005) return null;
  const d = Number(delta);
  if (before != null && after != null) {
    return `${key} ${pctLabel(before, 0)} → ${pctLabel(after, 0)} (${d >= 0 ? '+' : ''}${pctLabel(d, 0)})`;
  }
  return `${key} ${d >= 0 ? '+' : ''}${pctLabel(d, 0)}`;
}

function governanceHasLanes(
  intel: ChatUiMessage['intelligence'] | undefined
): boolean {
  const lanes = intel?.governance?.lanes || [];
  return lanes.length > 0;
}

function governanceStatusLabel(
  status: string | null | undefined,
  t: (key: string) => string
): string {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'pass') return t('agent.governancePass');
  if (normalized === 'fail') return t('agent.governanceFail');
  return String(status || '');
}

function governanceStatusMark(status: string): string {
  if (status === 'pass') return '✓';
  if (status === 'fail') return '✗';
  if (status === 'warn') return '⚠';
  return '·';
}

function governanceLaneStatusSuffix(
  status: string,
  t: (key: string) => string
): string {
  if (status === 'pass') return `：${t('agent.governanceLanePass')}`;
  if (status === 'fail') return `：${t('agent.governanceLaneFail')}`;
  if (status === 'warn') return `：${t('agent.governanceLaneWarn')}`;
  return '';
}

export function formatGovernanceLaneItems(
  t: (key: string, opts?: Record<string, unknown>) => string,
  rows: Array<{
    id?: string;
    name?: string;
    summary?: string;
    lane?: string;
    status?: string;
  }>
): ExploreItem[] {
  return rows.map((row, i) => {
    const lane = String(row.lane || row.name || '').trim();
    const st = String(row.status || row.summary || '').toLowerCase();
    const laneLabel = t(`agent.governanceLane.${lane}`, { defaultValue: lane });
    let stLabel = st;
    if (st === 'pass') stLabel = t('agent.governanceLanePass');
    else if (st === 'fail') stLabel = t('agent.governanceLaneFail');
    else if (st === 'warn') stLabel = t('agent.governanceLaneWarn');
    let tone: ExploreItemTone = 'ok';
    if (st === 'fail') tone = 'error';
    else if (st === 'warn') tone = 'warn';
    return {
      id: String(row.id || `gov-lane-${lane || i}`),
      name: stLabel ? `${laneLabel}：${stLabel}` : laneLabel,
      tone,
    };
  });
}

export function hasDesignIntelligence(
  intel: ChatUiMessage['intelligence'] | undefined
): boolean {
  if (!intel) return false;
  return Boolean(
    intel.reference?.dna ||
      intel.reference?.thesis ||
      intel.review?.scores ||
      intel.review?.overall != null ||
      governanceHasLanes(intel) ||
      intel.diff?.deltas ||
      (intel.iterations && intel.iterations.length > 0) ||
      intel.summary?.thesis ||
      intel.summary?.why ||
      intel.summary?.marketGap ||
      intel.summary?.nextSteps?.length ||
      intel.summary?.weaknesses?.length ||
      intel.summary?.strengths?.length ||
      intel.summary?.iterations != null ||
      (intel.summary?.scoreFrom != null && intel.summary?.scoreTo != null)
  );
}

function DeveloperDebugPanel({
  events,
}: {
  events: ChatUiMessage['debugEvents'];
}): ReactNode {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(() => loadAgentDevDebug());
  const [open, setOpen] = useState(false);
  const rows = events || [];

  useEffect(() => {
    const sync = () => setEnabled(loadAgentDevDebug());
    window.addEventListener('storage', sync);
    window.addEventListener('recombyn-agent-dev-debug', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('recombyn-agent-dev-debug', sync);
    };
  }, []);

  if (!enabled || rows.length === 0) return null;

  return (
    <div
      className="flex w-full flex-col gap-1.5 border-l border-amber-500/25 pl-3 text-[11px] leading-snug text-[var(--muted)]"
      data-testid="agent-developer-debug"
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-left text-[11px] uppercase tracking-[0.08em] text-amber-700/80 dark:text-amber-400/90"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <HiOutlineChevronRight
          className={cn('h-3 w-3 transition-transform', open ? 'rotate-90' : '')}
          aria-hidden
        />
        {t('agent.devDebugTitle', { defaultValue: '开发调试' })}
        <span className="normal-case tracking-normal text-[var(--muted)]">
          ({rows.length})
        </span>
      </button>
      {open ? (
        <div className="max-h-56 overflow-auto rounded-md bg-[var(--canvas)]/80 px-2 py-1.5 font-mono text-[10px] text-[var(--ink)]/75">
          {rows.map((row) => (
            <div key={row.id} className="border-b border-[var(--line)]/40 py-1 last:border-0">
              <div className="text-[var(--muted)]">{row.kind}</div>
              {row.text ? (
                <pre className="whitespace-pre-wrap break-words">{row.text}</pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DesignIntelligencePanel({
  intel,
}: {
  intel: NonNullable<ChatUiMessage['intelligence']>;
}): ReactNode {
  const { t } = useTranslation();
  const dna = intel.reference?.dna || {};
  const dnaAxes = Object.entries(dna).filter(([, v]) => typeof v === 'number');
  const scores = intel.review?.scores || {};
  const scoreRows = REVIEW_SCORE_ORDER.filter((k) => scores[k] != null).map((k) => ({
    key: k,
    value: Number(scores[k]),
  }));
  const issues = intel.review?.topIssues || [];
  const deltas = intel.diff?.deltas || {};
  const diffLines = [
    formatDiffDeltaLine('Hero', deltas.hero_coverage),
    formatDiffDeltaLine('Whitespace', deltas.whitespace_ratio),
    formatDiffDeltaLine('Decoration', deltas.decoration_area),
  ].filter(Boolean) as string[];
  const timeline = (intel.iterations || []).filter((row) => row.overall > 0);
  const summary = intel.summary;
  const explainThesis = String(summary?.thesis || '').trim();
  const explainWhy = String(summary?.why || '').trim();
  const explainStrengths = summary?.strengths || [];
  const explainWeaknesses = summary?.weaknesses || [];
  const explainNext = summary?.nextSteps || [];
  const explainGap = String(summary?.marketGap || '').trim();
  const hasExplain =
    Boolean(explainThesis || explainWhy || explainGap) ||
    explainStrengths.length > 0 ||
    explainWeaknesses.length > 0 ||
    explainNext.length > 0;

  const scoreLabel = (key: string) =>
    t(`agent.reviewScore.${key}`, { defaultValue: key });

  return (
    <div
      className="flex w-full flex-col gap-3 border-l border-[var(--ink)]/10 pl-3 text-[12px] leading-snug text-[var(--ink)]/80"
      data-testid="design-intelligence"
    >
      {hasExplain ? (
        <section className="flex flex-col gap-1.5" data-testid="design-explain">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
            {t('agent.designExplainTitle')}
          </div>
          {explainThesis ? (
            <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--ink)]">
              <span className="text-[var(--muted)]">{t('agent.designExplainThesis')}：</span>
              {explainThesis}
            </p>
          ) : null}
          {explainWhy ? (
            <p className="whitespace-pre-wrap break-words text-[12px] text-[var(--ink)]/85">
              <span className="text-[var(--muted)]">{t('agent.designExplainWhy')}：</span>
              {explainWhy}
            </p>
          ) : null}
          {explainStrengths.length ? (
            <div>
              <div className="text-[11px] text-[var(--muted)]">
                {t('agent.designExplainStrengths')}
              </div>
              <ul className="mt-0.5 list-disc pl-4">
                {explainStrengths.slice(0, 4).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {explainWeaknesses.length ? (
            <div>
              <div className="text-[11px] text-[var(--muted)]">
                {t('agent.designExplainWeaknesses')}
              </div>
              <ul className="mt-0.5 list-disc pl-4">
                {explainWeaknesses.slice(0, 4).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {explainGap ? (
            <p className="text-[12px] text-[var(--ink)]/85">
              <span className="text-[var(--muted)]">{t('agent.designExplainGap')}：</span>
              {explainGap}
            </p>
          ) : null}
          {explainNext.length ? (
            <div>
              <div className="text-[11px] text-[var(--muted)]">
                {t('agent.designExplainNext')}
              </div>
              <ol className="mt-0.5 list-decimal pl-4">
                {explainNext.slice(0, 4).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </section>
      ) : null}

      {governanceHasLanes(intel) ? (
        <section className="flex flex-col gap-1.5" data-testid="design-governance-user">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
              {t('agent.governanceTitle')}
            </span>
            <span className="tabular-nums text-[13px] text-[var(--ink)]">
              {governanceStatusLabel(intel.governance?.status, t)}
            </span>
          </div>
          {(intel.governance?.lanes || []).length ? (
            <ul className="flex flex-col gap-1">
              {(intel.governance?.lanes || []).map((row) => {
                const lane = String(row.lane || '').trim();
                const st = String(row.status || '').toLowerCase();
                const mark = governanceStatusMark(st);
                const laneStatus = governanceLaneStatusSuffix(st, t);
                return (
                  <li key={lane || `gov-${mark}`} className="flex items-start gap-2">
                    <span aria-hidden>{mark}</span>
                    <span>
                      {t(`agent.governanceLane.${lane}`, {
                        defaultValue: lane,
                      })}
                      {laneStatus}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}

      {intel.reference?.thesis || dnaAxes.length || intel.reference?.stages?.length ? (
        <section className="flex flex-col gap-1.5">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
            {t('agent.intelReference')}
          </div>
          {intel.reference?.stages?.length ? (
            <div className="flex flex-wrap gap-1.5 text-[11px] text-[var(--muted)]">
              {intel.reference.stages.map((stage) => (
                <span key={stage}>{stage}</span>
              ))}
            </div>
          ) : null}
          {intel.reference?.thesis ? (
            <p className="whitespace-pre-wrap break-words text-[13px] text-[var(--ink)]">
              {intel.reference.thesis}
            </p>
          ) : null}
          {intel.reference?.composition ? (
            <p className="text-[11px] text-[var(--muted)]">
              {intel.reference.composition}
            </p>
          ) : null}
          {dnaAxes.length ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {dnaAxes.map(([axis, value]) => (
                <div key={axis} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--muted)]">{axis}</span>
                  <span className="tabular-nums">{pctLabel(value, 0)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {scoreRows.length || intel.review?.overall != null ? (
        <section className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
              {t('agent.intelReview')}
            </span>
            {intel.review?.overall != null ? (
              <span className="tabular-nums text-[13px] text-[var(--ink)]">
                {Math.round(Number(intel.review.overall))}
                {intel.review.action ? ` · ${intel.review.action}` : ''}
              </span>
            ) : null}
          </div>
          {scoreRows.length ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              {scoreRows.map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-2">
                  <span className="truncate text-[var(--muted)]">{scoreLabel(row.key)}</span>
                  <span className="tabular-nums">{row.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {issues.length ? (
            <ol className="mt-1 flex list-decimal flex-col gap-1 pl-4">
              {issues.slice(0, 5).map((issue, i) => (
                <li key={`${issue.issue || i}-${i}`}>
                  <span className="text-[var(--ink)]">
                    {String(issue.issue || '').slice(0, 120)}
                  </span>
                  {issue.fix ? (
                    <span className="block text-[11px] text-[var(--muted)]">
                      {String(issue.fix).slice(0, 120)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}

      {diffLines.length ? (
        <section className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
            {t('agent.intelDiff')}
          </div>
          {diffLines.map((line) => (
            <div key={line} className="tabular-nums">
              {line}
            </div>
          ))}
        </section>
      ) : null}

      {timeline.length > 1 ? (
        <section className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--muted)]">
            {t('agent.intelIterations')}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 tabular-nums">
            {timeline.map((row, i) => (
              <span key={`${row.iteration}-${row.overall}-${i}`}>
                {i > 0 ? <span className="text-[var(--muted)]">→ </span> : null}
                {Math.round(row.overall)}
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {summary &&
      (summary.iterations != null ||
        (summary.removed != null && summary.removed > 0) ||
        summary.whitespace != null ||
        summary.heroDominance != null ||
        (summary.scoreFrom != null && summary.scoreTo != null)) ? (
        <section className="flex flex-col gap-1 text-[var(--muted)]">
          <div className="text-[11px] uppercase tracking-[0.08em]">
            {t('agent.intelSummary')}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 tabular-nums text-[var(--ink)]/80">
            {summary.iterations != null ? (
              <span>
                {t('agent.intelIterCount', {
                  count: summary.iterations,
                })}
              </span>
            ) : null}
            {summary.removed != null && summary.removed > 0 ? (
              <span>
                {t('agent.intelRemoved', {
                  count: summary.removed,
                })}
              </span>
            ) : null}
            {summary.whitespace != null ? (
              <span>
                {t('agent.intelWhitespace')} {pctLabel(summary.whitespace, 0)}
              </span>
            ) : null}
            {summary.heroDominance != null ? (
              <span>
                {t('agent.intelHero')} {pctLabel(summary.heroDominance, 0)}
              </span>
            ) : null}
            {summary.scoreFrom != null && summary.scoreTo != null ? (
              <span>
                {Math.round(summary.scoreFrom)}→{Math.round(summary.scoreTo)}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}

type ProcessTFn = (key: string, opts?: Record<string, unknown>) => string;

export function normalizeActivityStatus(
  status: string | undefined | null
): 'running' | 'done' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return 'done';
}

function countLabel(
  t: ProcessTFn,
  count: number | undefined,
  withCount: string,
  bare: string
): string {
  if (count != null && count > 0) return t(withCount, { count });
  return t(bare);
}

function formatThoughtLabel(
  t: ProcessTFn,
  ev: ActivityStepEvent,
  detail: string,
  preferDetail: boolean
): string | null {
  if (ev.status === 'running') {
    return preferDetail ? detail : t('agent.activityThoughtRunning');
  }
  if (preferDetail) return detail;
  if (ev.status === 'done' && ev.durationSec != null) {
    return t('agent.activityThought', { seconds: ev.durationSec });
  }
  if (ev.status === 'done') return t('agent.activityThoughtBrief');
  return null;
}

function formatPreloadExploredLabel(
  t: ProcessTFn,
  detail: string,
  stage: string | undefined
): string | null {
  const preloadTag = detail.toLowerCase();
  const isPreload =
    stage === 'skill_preload' ||
    preloadTag === 'skills' ||
    preloadTag === 'tools';
  if (!isPreload) return null;
  if (preloadTag === 'tools') return t('agent.lookupKindRule');
  return t('agent.lookupKindSkill');
}

function formatCanvasSizeExploredLabel(
  t: ProcessTFn,
  ev: ActivityStepEvent,
  detail: string
): string | null {
  if (ev.stage !== 'scene' && !detail.startsWith('canvas_size:')) return null;
  const raw = detail.replace(/^canvas_size:/i, '').trim();
  const size =
    raw && /^\d+x\d+$/i.test(raw) ? raw.replace(/x/i, '×') : detail;
  if (ev.status === 'running') {
    return size
      ? t('agent.activityCanvasSizeRunning', { size })
      : t('agent.stageScene');
  }
  return size
    ? t('agent.activityCanvasSizeDone', { size })
    : t('agent.stageScene');
}

function formatLookupExploredLabel(
  t: ProcessTFn,
  ev: ActivityStepEvent,
  detail: string
): string | null {
  if (ev.stage !== 'lookup' && !detail.includes('lookup')) return null;
  if (ev.status === 'running') return t('agent.activityLookupRunning');
  const n = ev.count != null && ev.count > 0 ? ev.count : 0;
  return countLabel(
    t,
    n || undefined,
    'agent.activityLookupDoneCount',
    'agent.activityLookupDone'
  );
}

function formatExploredLabel(
  t: ProcessTFn,
  ev: ActivityStepEvent,
  detail: string,
  preferDetail: boolean
): string {
  const code = String(ev.code || '').trim().toLowerCase();
  if (code === 'design_brief') {
    return t('agent.designBriefDone');
  }
  if (code === 'design_pipeline') {
    if (ev.status === 'running') return t('agent.activityExploredRunning');
    return t('agent.activityExplored');
  }
  const preload = formatPreloadExploredLabel(t, detail, ev.stage);
  if (preload) return preload;
  // Never surface raw DESIGN_* / REFERENCE_INTEL / English kernel dumps as the row label.
  if (
    /^DESIGN_/i.test(detail) ||
    /^REFERENCE_INTEL:/i.test(detail) ||
    detail === 'design pipeline' ||
    looksLikeKernelProcessDump(detail)
  ) {
    if (ev.status === 'running') return t('agent.activityExploredRunning');
    return t('agent.activityExplored');
  }
  if (preferDetail && !detail.startsWith('canvas_size:')) return detail;
  const canvas = formatCanvasSizeExploredLabel(t, ev, detail);
  if (canvas) return canvas;
  const lookup = formatLookupExploredLabel(t, ev, detail);
  if (lookup) return lookup;
  if (ev.status === 'running') return t('agent.activityExploredRunning');
  const fromCount = ev.count != null && ev.count > 0 ? ev.count : 0;
  const fromDetail = detail
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length;
  return countLabel(
    t,
    fromCount || fromDetail || undefined,
    'agent.activityExploredCount',
    'agent.activityExplored'
  );
}

export function formatActivityLabel(
  t: ProcessTFn,
  ev: ActivityStepEvent
): string | null {
  const detailRaw = (ev.detail || '').trim();
  const code = String(ev.code || '').trim().toLowerCase();
  const detail = localizeAgentProcessCopy(t, detailRaw, code);
  const preferDetail = detail.length > 0;
  if (code === 'design_quality_check') {
    if (ev.status === 'running') return t('agent.governanceRunning');
    if (detailRaw === 'fail' || ev.status === 'error') return t('agent.governanceFailShort');
    return t('agent.governanceDone');
  }

  if (ev.kind === 'thought') {
    return formatThoughtLabel(t, ev, detail, preferDetail);
  }
  if (ev.kind === 'added') {
    if (preferDetail) return detail;
    return countLabel(
      t,
      ev.count,
      'agent.activityAddedCount',
      'agent.activityAdded'
    );
  }
  if (ev.kind === 'updated') {
    if (preferDetail) return detail;
    return countLabel(
      t,
      ev.count,
      'agent.activityUpdatedCount',
      'agent.activityUpdated'
    );
  }
  if (ev.kind === 'explored') {
    return formatExploredLabel(t, ev, detailRaw, preferDetail && !looksLikeKernelProcessDump(detailRaw));
  }
  if (ev.kind === 'skipped') {
    if (code === 'ops_validate_failed') {
      return t('agent.activityOpsValidateFailed', {
        count: ev.count ?? 0,
        codes: detailRaw || 'invalid_op',
      });
    }
    if (preferDetail) return detail;
    return t('agent.activitySkipped');
  }
  if (ev.kind === 'deleted') {
    if (preferDetail) return detail;
    return countLabel(
      t,
      ev.count,
      'agent.activityDeletedCount',
      'agent.activityDeleted'
    );
  }
  if (preferDetail) return detail;
  if (ev.status === 'running') return t('agent.activityToolRunning');
  return t('agent.activityTool');
}

function exploreItemKindKey(id: string): string {
  if (id === 'lookup-skill' || id.startsWith('lookup-skill')) {
    return 'agent.lookupKindSkill';
  }
  if (id === 'lookup-rule' || id.startsWith('lookup-rule')) {
    return 'agent.lookupKindRule';
  }
  if (id === 'lookup-gate') return 'agent.lookupGate';
  if (id === 'stage-lookup' || id.startsWith('stage-lookup')) {
    return 'agent.stageLookup';
  }
  if (id === 'stage-scene' || id.startsWith('stage-scene')) {
    return 'agent.stageScene';
  }
  if (id === 'canvas-size') return 'agent.canvasSizeLabel';
  if (id === 'design-quality-check' || id === 'design-governance') {
    return 'agent.governanceTitle';
  }
  if (id === 'design-brief') {
    return 'agent.designBriefDone';
  }
  if (id.startsWith('stage-')) {
    const stage = id.slice('stage-'.length);
    const map: Record<string, string> = {
      prepare: 'agent.stagePrepare',
      scene: 'agent.stageScene',
      prompt: 'agent.stagePrompt',
      model_wait: 'agent.stageModelWait',
      model_stream: 'agent.stageModelStream',
      lookup: 'agent.stageLookup',
      validate: 'agent.stageValidate',
      ops: 'agent.stageOps',
      scene_check: 'agent.stageSceneCheck',
      critic: 'agent.stageCritic',
      refine: 'agent.stageRefine',
      done: 'agent.stageDone',
      failed: 'agent.stageFailed',
    };
    return map[stage] || '';
  }
  return '';
}

function mergeExploreStepStatus(
  a: 'running' | 'done' | 'error' | 'pending' | undefined,
  b: 'running' | 'done' | 'error' | 'pending' | undefined
): 'running' | 'done' | 'error' {
  if (a === 'error' || b === 'error') return 'error';
  if (a === 'running' || b === 'running') return 'running';
  return 'done';
}

export function localizeExploreItem(
  t: ProcessTFn,
  item: { id: string; name: string; summary?: string; tone?: ExploreItemTone }
): { id: string; name: string; summary?: string; tone?: ExploreItemTone } {
  const id = String(item.id || '');
  const kindKey = exploreItemKindKey(id);
  if (!kindKey) return item;
  if (kindKey === 'agent.canvasSizeLabel') {
    return {
      ...item,
      name: String(item.name || '').trim() || t(kindKey),
      summary: item.summary,
    };
  }
  const host = /^Host\s*·/i.test(String(item.name || '').trim());
  const label = t(kindKey);
  return {
    ...item,
    name: host ? t('agent.lookupHostPrefix', { name: label }) : label,
  };
}

/** Thinking-only explore row labeled “设计材料确认” — hide on simple replies. */
function isBareExplorePipelineStep(step: AssistantStep): boolean {
  if (step.id === 'chat-process') return false;
  const isExplore =
    step.id === 'explore-pipeline' ||
    (step.kind === 'explored' && step.id !== 'chat-process');
  if (!isExplore) return false;
  const items = step.items || [];
  return items.every((it) => {
    const id = String(it.id || '');
    return !id || id === 'thought-brief';
  });
}

function collapseExplorePipelineSteps(steps: AssistantStep[]): AssistantStep[] {
  let explore: AssistantStep | null = null;
  const rest: AssistantStep[] = [];
  for (const s of steps) {
    const isExplore =
      s.id === 'explore-pipeline' ||
      (s.kind === 'explored' && s.id !== 'chat-process');
    if (!isExplore) {
      rest.push(s);
      continue;
    }
    if (!explore) {
      explore = { ...s, id: 'explore-pipeline', kind: 'explored' };
      continue;
    }
    const items = [...(explore.items || [])];
    for (const it of s.items || []) {
      upsertExploreItem(items, it);
    }
    explore = unstickExplorePinnedCopy({
      ...explore,
      name: s.name || explore.name,
      summary: s.summary || explore.summary,
      body: s.body || explore.body,
      items,
      status: mergeExploreStepStatus(s.status, explore.status),
    });
  }
  if (!explore) return rest;
  explore = unstickExplorePinnedCopy({
    ...explore,
    id: 'explore-pipeline',
    kind: 'explored',
  });
  const provisional = rest.findIndex(
    (s) => s.id === 'thought-0' || s.id === 'skill-0'
  );
  if (provisional >= 0) {
    const next = [...rest];
    next.splice(provisional, 1, explore);
    return next;
  }
  return [explore, ...rest];
}

/** Chat divert: keep canvas tool rows; drop design-materials chrome. */
export function buildChatProcessSteps(_t: ProcessTFn, m: ChatUiMessage): AssistantStep[] {
  const kept = (m.steps || []).filter(
    (s) =>
      s.kind !== 'thought' &&
      s.id !== 'thought-0' &&
      !isBareExplorePipelineStep(s)
  );
  if (!kept.length) return [];
  return kept.map((s) =>
    s.status === 'running' ? { ...s, status: 'done' as const } : s
  );
}

export function applyThinkingBodyToSteps(
  stepsIn: AssistantStep[],
  piece: string,
  replace: boolean,
  t: ProcessTFn
): AssistantStep[] {
  const text = String(piece || '').trim();
  if (!text) return stepsIn;

  const steps = [...stepsIn];
  const title = t('agent.thinkingTitle');
  let idx = steps.findIndex((s) => s.id === 'thought-stream');
  const prevBody =
    idx >= 0 ? String(steps[idx].body || steps[idx].summary || '').trim() : '';
  const merged = replace ? text : `${prevBody}${text}`.trim();
  // Full replace = one complete thought snapshot from decide; otherwise still streaming.
  const status: AssistantStep['status'] = replace ? 'done' : 'running';
  const next: AssistantStep = {
    id: 'thought-stream',
    kind: 'thought',
    name: title,
    status,
    body: merged,
  };
  if (idx < 0) {
    const exploreIdx = steps.findIndex(
      (s) => s.kind === 'explored' || s.id === 'explore-pipeline'
    );
    if (exploreIdx >= 0) steps.splice(exploreIdx, 0, next);
    else steps.push(next);
    return steps;
  }
  steps[idx] = { ...steps[idx], ...next };
  return steps;
}

/** True when assistant reply is the same essay already shown in the process fold. */
export function replyDuplicatesProcessThought(
  content: string,
  steps: AssistantStep[] | undefined
): boolean {
  const reply = content.replace(/\s+/g, ' ').trim();
  if (reply.length < 24) return false;
  for (const s of steps || []) {
    if (s.kind === 'thought' || s.id === 'thought-stream') {
      const body = String(s.body || s.summary || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (body && (reply === body || (body.length >= 40 && reply.includes(body.slice(0, 40))))) {
        return true;
      }
      if (body.length >= 40 && body.includes(reply.slice(0, 40))) return true;
    }
    for (const it of s.items || []) {
      if (it.id !== 'thought-brief') continue;
      const thought = String(it.name || it.summary || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!thought) continue;
      if (reply === thought) return true;
      if (reply.length >= 40 && thought.includes(reply.slice(0, 40))) return true;
      if (thought.length >= 40 && reply.includes(thought.slice(0, 40))) return true;
    }
    const body = String(s.body || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (body && (reply === body || (body.length >= 40 && reply.includes(body.slice(0, 40))))) {
      return true;
    }
  }
  return false;
}

export function applyAnalysisDeltaToSteps(
  stepsIn: AssistantStep[],
  piece: string
): AssistantStep[] | null {
  const steps = [...stepsIn];
  let idx = steps.findIndex((s) => s.status === 'running' && s.kind === 'thought');
  if (idx < 0) idx = steps.findIndex((s) => s.status === 'running');
  if (idx < 0 && steps.length) idx = steps.length - 1;
  if (idx < 0) return null;
  const merged = `${steps[idx].summary || ''}${piece}`;
  steps[idx] = {
    ...steps[idx],
    summary: merged,
  };
  return steps;
}

export type ExploreItem = {
  id: string;
  name: string;
  summary?: string;
  tone?: ExploreItemTone;
};

/** Infer warn/error from copy when emitters did not set tone. */
function inferExploreItemTone(text: string): ExploreItemTone {
  const s = String(text || '').toLowerCase();
  if (!s) return 'ok';
  if (/revision\s*conflict|冲突/.test(s)) return 'warn';
  if (
    /校验失败|ops_validate_failed|op\(s\)\s*not\s*applied|not applied|failed|失败|error|错误/.test(
      s
    )
  ) {
    return 'error';
  }
  return 'ok';
}

export function activityItemTone(opts: {
  status?: string | null;
  kind?: string | null;
  code?: string | null;
  detail?: string | null;
  name?: string | null;
}): ExploreItemTone {
  const blob = `${opts.code || ''} ${opts.detail || ''} ${opts.name || ''}`.toLowerCase();
  // Soft conflict — warn, even when the activity is marked error.
  if (/revision\s*conflict|冲突/.test(blob)) return 'warn';
  if (opts.status === 'error') return 'error';
  if (opts.kind === 'skipped') {
    if (/ops_validate_failed|not applied|fail|失败|error|错误/.test(blob)) return 'error';
    return 'warn';
  }
  return inferExploreItemTone(blob);
}

function resolveExploreItemTone(item: ExploreItem): ExploreItemTone {
  if (item.tone === 'ok' || item.tone === 'warn' || item.tone === 'error') {
    return item.tone;
  }
  return inferExploreItemTone(`${item.name || ''} ${item.summary || ''}`);
}

function processStepTone(
  step: NonNullable<ChatUiMessage['steps']>[number]
): ExploreItemTone | 'running' {
  if (step.status === 'running' || step.status === 'pending') return 'running';
  if (step.status === 'error') return 'error';
  return activityItemTone({
    status: step.status,
    kind: step.kind,
    name: step.name,
    detail: step.summary,
  });
}

function ProcessToneIcon({
  tone,
  className,
}: {
  tone: ExploreItemTone | 'running';
  className?: string;
}): ReactNode {
  if (tone === 'running') {
    return (
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--ink)]/35',
          className
        )}
        aria-hidden
      />
    );
  }
  if (tone === 'error') {
    return (
      <HiOutlineXCircle
        className={cn('shrink-0 text-[var(--danger,#c45)]', className)}
        aria-hidden
      />
    );
  }
  if (tone === 'warn') {
    return (
      <HiOutlineExclamationTriangle
        className={cn('shrink-0 text-[var(--warning,#c48a1a)]', className)}
        aria-hidden
      />
    );
  }
  return (
    <HiOutlineCheckCircle
      className={cn('shrink-0 text-[var(--success,#22a06b)]', className)}
      aria-hidden
    />
  );
}

function upsertExploreItem(
  items: ExploreItem[],
  item: ExploreItem
): void {
  const ii = items.findIndex((x) => x.id === item.id);
  if (ii >= 0) items[ii] = { ...items[ii], ...item };
  else items.push(item);
}

/** Long summary/body used to render after items (sticky footer). Put it in the list instead. */
function adoptPinnedExploreText(
  items: ExploreItem[],
  text: string | undefined,
  id: string
): void {
  const name = String(text || '').trim();
  if (!name) return;
  if (items.some((x) => x.id === id || x.name === name)) return;
  items.unshift({ id, name, tone: inferExploreItemTone(name) });
}

function unstickExplorePinnedCopy(step: AssistantStep): AssistantStep {
  const items = [...(step.items || [])];
  adoptPinnedExploreText(items, step.body, 'explore-pinned-body');
  const summary = String(step.summary || '').trim();
  if (summary && summary !== String(step.name || '').trim()) {
    adoptPinnedExploreText(items, summary, 'explore-pinned-summary');
  }
  return { ...step, items, summary: undefined, body: undefined };
}

export function applyActivityEventToSteps(
  stepsIn: AssistantStep[],
  opts: {
    kind: NonNullable<AssistantStep['kind']>;
    eventId?: string;
    status: 'running' | 'done' | 'error';
    label: string;
    summary?: string;
    variant?: NonNullable<AssistantStep['variant']>;
    nestItem?: ExploreItem | null;
    items?: ExploreItem[];
    bodyMd: string;
  }
): AssistantStep[] | null {
  const { kind, status, label, summary, variant, nestItem, bodyMd } = opts;
  const steps = [...stepsIn];
  let idx =
    kind === 'explored'
      ? steps.findIndex((s) => s.id === 'explore-pipeline')
      : steps.findIndex((s) => s.id === String(opts.eventId || 'skill-0'));
  if (idx < 0 && kind === 'explored') {
    idx = steps.findIndex(
      (s) => s.kind === 'explored' && s.id !== 'chat-process'
    );
  }
  if (idx < 0 && kind === 'explored') {
    idx = steps.findIndex((s) => s.id === 'skill-0' || s.id === 'thought-0');
  }
  if (idx < 0 && kind === 'thought' && status === 'running') {
    idx = steps.findIndex(
      (s) =>
        s.status === 'running' &&
        (s.id === 'skill-0' || s.id === 'thought-0' || !s.id)
    );
  }

  if (kind === 'explored') {
    const prevStep = idx >= 0 ? steps[idx] : null;
    if (prevStep?.status === 'done' && status === 'running' && !nestItem && !bodyMd) {
      return null;
    }
    const items = [...(prevStep?.items || [])];
    const nestTone = activityItemTone({ status, kind });
    if (nestItem) {
      upsertExploreItem(items, {
        ...nestItem,
        tone: nestItem.tone || nestTone,
      });
    } else if (bodyMd.trim()) {
      upsertExploreItem(items, {
        id: String(opts.eventId || 'explore-note'),
        name: bodyMd.trim(),
        tone: nestTone,
      });
    } else if (summary?.trim() && summary.trim() !== label) {
      upsertExploreItem(items, {
        id: String(opts.eventId || 'explore-note'),
        name: summary.trim(),
        tone: nestTone,
      });
    }
    if (prevStep) {
      adoptPinnedExploreText(items, prevStep.body, 'explore-pinned-body');
      const prevSummary = String(prevStep.summary || '').trim();
      if (prevSummary && prevSummary !== String(prevStep.name || '').trim()) {
        adoptPinnedExploreText(items, prevSummary, 'explore-pinned-summary');
      }
    }
    const nextStep: AssistantStep = {
      id: 'explore-pipeline',
      kind: 'explored',
      name: label,
      status,
      variant: variant || 'confirm',
      items,
    };
    if (idx >= 0) steps[idx] = nextStep;
    else steps.push(nextStep);
    return collapseExplorePipelineSteps(steps);
  }

  const stepId = String(opts.eventId || 'skill-0');
  const safeId = stepId === 'explore-pipeline' ? `step-${stepId}` : stepId;
  const next: AssistantStep = {
    id: safeId,
    kind,
    name: label,
    summary,
    status,
    variant,
    items: opts.items,
    body: bodyMd.trim() || undefined,
  };
  if (idx >= 0 && steps[idx]?.id !== 'explore-pipeline') {
    if (kind === 'thought' && status === 'running' && steps[idx].status === 'done') {
      return null;
    }
    const prevStep = steps[idx];
    steps[idx] = {
      ...next,
      id: prevStep.id || next.id,
      summary: next.summary || prevStep.summary,
      items: opts.items || prevStep.items,
      body: next.body || prevStep.body,
    };
  } else {
    steps.push(next);
  }
  return collapseExplorePipelineSteps(steps);
}

export type ChatTurn = {
  user: ChatUiMessage | null;
  assistant?: ChatUiMessage;
};

type Props = {
  turns: ChatTurn[];
  editingUserId: string | null;
  editComposer?: ReactNode;
  sending: boolean;
  formatWorked: (assistant?: ChatUiMessage) => string | null;
  hasCheckpoint: (userId: string) => boolean;
  onBeginEdit: (m: ChatUiMessage) => void;
  onCancelEdit: () => void;
  onRestore: (userId: string) => void;
  onChoice?: (choice: AskChoicePick) => void;
  onResume?: (assistantId: string) => void;
  onDismissResume?: (assistantId: string) => void;
  className?: string;
};

export type AskChoicePick = {
  label: string;
  action: 'apply' | 'reply' | 'dismiss';
  /** Optional opaque value from a structured choice (for example a scene node id). */
  value?: string;
  /** multi mode: all selected labels when submitting. */
  selectedLabels?: string[];
};

const CHIP_ACTION_BTN =
  'inline-flex h-7 items-center gap-1 rounded-full bg-[var(--canvas)] px-2.5 text-[12px] text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40';
const CHIP_ACTION_TEXT =
  'inline-flex h-7 items-center rounded-full px-2.5 text-[12px] text-[var(--muted)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-40';

function hasFoldableProcess(assistant: ChatUiMessage): boolean {
  return Boolean(
    assistant.steps?.some(
      (s) =>
        s.kind !== 'thought' &&
        s.id !== 'thought-0' &&
        !isBareExplorePipelineStep(s)
    )
  );
}

/** Gallery / shimmer cards — wide enough for hover CTA; scroll when many. */
function cardBoxFromAspect(raw?: string): { width: number; height: number } {
  const TARGET_W = 168;
  let rw = 1;
  let rh = 1;
  const s = String(raw || '1:1').trim();
  if (s === 'smart' || s.toLowerCase() === 'auto') {
    /* keep 1:1 */
  } else {
    const m = /^(\d+(?:\.\d+)?)\s*[:x×]\s*(\d+(?:\.\d+)?)$/i.exec(s);
    if (m) {
      rw = Math.max(0.01, Number(m[1]));
      rh = Math.max(0.01, Number(m[2]));
    }
  }
  const width = TARGET_W;
  const height = Math.max(96, Math.min(280, Math.round((width * rh) / rw)));
  return { width, height };
}

/** User bubble: attachment thumbs above text (composer strip / 图2); @ chips inline. */
function UserMessageBody({
  content,
  contentMarked,
  contexts,
}: {
  content: string;
  contentMarked?: string;
  contexts?: ChatUiMessage['contexts'];
}): ReactNode {
  const chips = contexts || [];
  const attachments = chips.filter((c) => c.kind === 'attachment');
  const inline = chips.filter((c) => c.kind !== 'attachment');

  const attachmentStrip =
    attachments.length > 0 ? (
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {attachments.map((a) => {
          const src = String(a.thumbUrl || '').trim();
          return (
            <div
              key={a.key}
              title={a.label}
              className="h-9 w-9 shrink-0 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--canvas)]"
            >
              {src ? (
                <img src={src} alt={a.label} className="h-full w-full object-cover" />
              ) : (
                <span className="flex h-full w-full items-center justify-center px-0.5 text-center text-[8px] leading-tight text-[var(--muted)]">
                  {a.label}
                </span>
              )}
            </div>
          );
        })}
      </div>
    ) : null;

  if (!inline.length) {
    return (
      <>
        {attachmentStrip}
        {content || (attachments.length ? '' : '...')}
      </>
    );
  }

  const marked =
    contentMarked && contentMarked.includes('\uFFFC')
      ? contentMarked
      : `${'\uFFFC'.repeat(inline.length)}${content || ''}`;

  const parts = marked.split('\uFFFC');
  const nodes: ReactNode[] = [];
  let chipIdx = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part) nodes.push(<span key={`t-${i}`}>{part}</span>);
    if (i < parts.length - 1) {
      const c = inline[chipIdx++];
      if (c) {
        nodes.push(
          <ContextChipPill
            key={`${c.key}-${chipIdx}`}
            label={c.label}
            thumbUrl={c.thumbUrl}
            hideLeadingIcon={c.kind === 'skill' || c.key.startsWith('skill:')}
            className="mx-0.5"
          />
        );
      }
    }
  }
  while (chipIdx < inline.length) {
    const c = inline[chipIdx++];
    if (!c) break;
    nodes.push(
      <ContextChipPill
        key={`${c.key}-${chipIdx}`}
        label={c.label}
        thumbUrl={c.thumbUrl}
        hideLeadingIcon={c.kind === 'skill' || c.key.startsWith('skill:')}
        className="mx-0.5"
      />
    );
  }
  return (
    <>
      {attachmentStrip}
      {nodes.length ? nodes : content || '...'}
    </>
  );
}

function AssistantProcessBody({
  assistant,
}: {
  assistant: ChatUiMessage;
}): ReactNode {
  const raw = assistant.steps || [];
  const seen = new Set<string>();
  const steps = raw.filter((s) => {
    const id = String(s.id || '');
    if (!id || seen.has(id)) return false;
    // Bare explore-only chrome (no nest) — skip empty shells.
    if (isBareExplorePipelineStep(s)) return false;
    seen.add(id);
    return true;
  });
  const turnActive = Boolean(assistant.streaming);
  return (
    <div className="flex w-full flex-col items-stretch gap-2">
      {steps.map((step, i) => (
        <ProcessStepRow
          key={`${step.id}-${i}`}
          step={step}
          turnActive={turnActive}
        />
      ))}
    </div>
  );
}

function ProcessStepRow({
  step,
  turnActive,
}: {
  step: NonNullable<ChatUiMessage['steps']>[number];
  /** True while this assistant turn is still streaming — keep process expanded. */
  turnActive: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const summaryDistinct =
    Boolean(step.summary?.trim()) &&
    step.summary!.trim() !== step.name.trim() &&
    step.summary!.trim() !== (step.body || '').trim();
  const expandable = Boolean(
    (step.items && step.items.length) ||
      step.body?.trim() ||
      summaryDistinct
  );
  // Live turn: expand. Finished turn: collapse (click to re-open).
  const [open, setOpen] = useState(() => turnActive);
  const userToggledRef = useRef(false);

  useEffect(() => {
    userToggledRef.current = false;
    setOpen(turnActive);
  }, [step.id]);

  useEffect(() => {
    if (userToggledRef.current) return;
    setOpen(turnActive);
  }, [turnActive]);

  const label = (
    <>
      {step.name}
      {step.status === 'running' && !/[.…]$/.test(step.name.trim()) ? '…' : ''}
    </>
  );

  const chevron = expandable ? (
    <HiOutlineChevronRight
      className={cn(
        'h-3.5 w-3.5 shrink-0 opacity-45 transition-transform',
        open && 'rotate-90'
      )}
      aria-hidden
    />
  ) : null;

  const rowTone = processStepTone(step);

  const detail =
    open && expandable ? (
      <div className="flex w-full flex-col gap-1 text-[12px] leading-relaxed text-[var(--muted)]">
        {(step.items || []).map((it) => (
          <div key={it.id} className="flex w-full min-w-0 items-start gap-1.5">
            <ProcessToneIcon
              tone={resolveExploreItemTone(it)}
              className="mt-0.5 h-3 w-3 opacity-90"
            />
            <div className="min-w-0 flex-1">
              <span className="block whitespace-pre-wrap break-words leading-snug">
                {it.name}
              </span>
              {it.summary?.trim() && it.summary.trim() !== String(it.name || '').trim() ? (
                <span className="mt-0.5 block whitespace-pre-wrap break-words text-[11px] leading-snug opacity-80">
                  {it.summary}
                </span>
              ) : null}
            </div>
          </div>
        ))}
        {summaryDistinct ? (
          <div className="flex w-full min-w-0 items-start gap-1.5">
            <ProcessToneIcon
              tone={inferExploreItemTone(String(step.summary || ''))}
              className="mt-0.5 h-3 w-3 opacity-90"
            />
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug">
              {step.summary}
            </span>
          </div>
        ) : null}
        {step.body?.trim() ? (
          <div className="w-full whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--muted)]">
            <ChatMarkdown
              content={step.body}
              className="!text-[12px] !leading-relaxed !text-[var(--muted)]"
            />
          </div>
        ) : null}
      </div>
    ) : null;

  // Activity chrome stays muted (same as running rows) — never jump to pure ink.
  const rowClass = cn(
    'flex w-full items-center gap-1.5 text-left text-[12px] leading-none text-[var(--muted)] transition-colors',
    step.status === 'error' && 'text-[var(--ink)]'
  );

  const leadingIcon = (
    <ProcessToneIcon
      tone={rowTone}
      className={rowTone === 'running' ? undefined : 'h-3.5 w-3.5'}
    />
  );

  if (!expandable) {
    return (
      <span className={cn(rowClass, 'items-start')}>
        <span className="mt-0.5 shrink-0">{leadingIcon}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-snug">{label}</span>
      </span>
    );
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-1.5">
      <button
        type="button"
        className={cn(rowClass, 'items-start hover:text-[var(--ink)]')}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={open ? t('agent.collapseProcess') : t('agent.expandProcess')}
      >
        <span className="mt-0.5 shrink-0">{leadingIcon}</span>
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-left leading-snug">
          {label}
        </span>
        <span className="mt-0.5 shrink-0">{chevron}</span>
      </button>
      {detail}
    </div>
  );
}

function AssistantTurn({
  assistant,
  onChoice,
  onResume,
  onDismissResume,
  sending,
}: {
  assistant: ChatUiMessage;
  worked?: string | null;
  onChoice?: (choice: AskChoicePick) => void;
  onResume?: (assistantId: string) => void;
  onDismissResume?: (assistantId: string) => void;
  sending: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const foldable = hasFoldableProcess(assistant);
  const streaming = Boolean(assistant.streaming);
  const processRunning = (assistant.steps || []).some((s) => s.status === 'running');
  const contentTrim = (assistant.content || '').trim();
  // Process timeline first — don't stream the reply while earlier steps are still running.
  // Also hide black reply when it duplicates the gray thought already in the fold.
  const showReplyText =
    Boolean(contentTrim) &&
    !(streaming && processRunning) &&
    !replyDuplicatesProcessThought(contentTrim, assistant.steps);

  const mediaReplyReady = Boolean(contentTrim);
  const imagePending = Math.max(0, Number(assistant.imagePendingCount) || 0);
  const videoPending = Math.max(0, Number(assistant.videoPendingCount) || 0);
  const audioPending = Math.max(0, Number(assistant.audioPendingCount) || 0);
  const lottiePending = Math.max(0, Number(assistant.lottiePendingCount) || 0);

  const showImageGallery =
    Boolean(assistant.images?.length) || (imagePending > 0 && mediaReplyReady);
  const showVideoGallery =
    Boolean(assistant.videos?.length) || (videoPending > 0 && mediaReplyReady);
  const showAudioGallery =
    Boolean(assistant.audios?.length) || (audioPending > 0 && mediaReplyReady);
  const showLottieGallery =
    Boolean(assistant.lotties?.length) || (lottiePending > 0 && mediaReplyReady);
  const showMediaGallery =
    showImageGallery ||
    showVideoGallery ||
    showAudioGallery ||
    showLottieGallery;
  const showAskChoices =
    !streaming &&
    onChoice &&
    Boolean(
      (assistant.choiceUi?.mode !== 'text' && assistant.choiceUi?.options?.length) ||
        (assistant.choiceUi?.mode === 'text' &&
          assistant.choiceUi.options?.some(
            (o) => o.action === 'apply' || o.action === 'dismiss'
          )) ||
        assistant.proposedOps?.length
    );
  const doneMilestone =
    !streaming &&
    !showAskChoices &&
    (foldable || showMediaGallery) &&
    Boolean(assistant.content || showMediaGallery);

  return (
    <div
      data-assistant-id={assistant.id}
      className="flex w-full min-w-0 flex-col items-stretch gap-2.5 px-0.5"
    >
      {streaming && (!assistant.content?.trim() || processRunning) ? (
        <span
          className="rcb-thinking-shimmer px-0.5"
          role="status"
          aria-busy
          aria-label={t('agent.thinking')}
        >
          {t('agent.thinking')}
        </span>
      ) : null}

      {/* Process first, then reply — matching product timeline order. */}
      {foldable ? <AssistantProcessBody assistant={assistant} /> : null}
      {hasDesignIntelligence(assistant.intelligence) ? (
        <DesignIntelligencePanel intel={assistant.intelligence!} />
      ) : null}
      <DeveloperDebugPanel events={assistant.debugEvents} />

      {showReplyText ? (
        <div className="w-full min-w-0 overflow-x-hidden text-[13px] leading-[1.7] text-[var(--ink)] [&_.rcb-chat-md_p:first-child]:font-semibold">
          <ChatMarkdown content={assistant.content || ''} />
          {streaming ? (
            <span className="ml-0.5 inline-block h-3 w-1 animate-pulse bg-current align-middle opacity-50" />
          ) : null}
        </div>
      ) : null}

      {showImageGallery ? (
        <ImageGenGallery assistant={assistant} sending={sending} />
      ) : null}

      {showVideoGallery ? (
        <VideoGenGallery assistant={assistant} sending={sending} />
      ) : null}

      {showAudioGallery ? (
        <AudioGenGallery assistant={assistant} sending={sending} />
      ) : null}

      {showLottieGallery ? (
        <LottieGenGallery assistant={assistant} sending={sending} />
      ) : null}

      {doneMilestone ? (
        <div className="flex w-full items-center gap-1.5 text-[12px] text-[var(--muted)]">
          <HiOutlineComputerDesktop className="h-3.5 w-3.5 opacity-70" aria-hidden />
          <span>
            {t('agent.taskCompleteNamed', {
              name: t('app.name', { defaultValue: 'zuoge' }),
              defaultValue: '{{name}} 已完成任务',
            })}
          </span>
        </div>
      ) : null}

      {showAskChoices && onChoice ? (
        <AskChoicePanel assistant={assistant} onChoice={onChoice} sending={sending} />
      ) : null}

      {!streaming && assistant.canResume && assistant.designTaskId && onResume ? (
        <div className="flex items-center gap-1 px-0.5">
          <button
            type="button"
            disabled={sending}
            className={CHIP_ACTION_BTN}
            onClick={() => onResume(assistant.id)}
          >
            <HiOutlinePlay className="h-3.5 w-3.5" aria-hidden />
            {t('agent.resume')}
          </button>
          {onDismissResume ? (
            <button
              type="button"
              disabled={sending}
              className={CHIP_ACTION_TEXT}
              onClick={() => onDismissResume(assistant.id)}
            >
              {t('common.cancel')}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChatMediaPendingSlot({
  seed,
  box,
}: {
  seed: string;
  box: { width: number; height: number };
}): ReactNode {
  return (
    <SoftGlowSurface
      seed={seed}
      className="shrink-0 rounded-[8px] border border-[var(--line)]"
      style={{ width: box.width, height: box.height }}
      aria-hidden
    />
  );
}

function chatGenGalleryShell(children: ReactNode): ReactNode {
  return (
    <div className="mt-1 flex max-w-full gap-2 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:thin]">
      {children}
    </div>
  );
}

function chatResultAssetFromImage(
  src: string,
  index: number,
  assistantId: string,
  box: { width: number; height: number }
): UserAsset {
  return {
    id: `${assistantId}-img-${index}`,
    kind: 'image',
    url: src,
    source: 'ai_image',
    width: box.width,
    height: box.height,
  };
}

function chatResultAssetFromVideo(
  src: string,
  index: number,
  assistantId: string,
  box: { width: number; height: number }
): UserAsset {
  return {
    id: `${assistantId}-vid-${index}`,
    kind: 'video',
    url: src,
    source: 'ai_video',
    width: box.width,
    height: box.height,
  };
}

function chatResultAssetFromLottie(
  item: NonNullable<ChatUiMessage['lotties']>[number],
  index: number,
  assistantId: string,
  box: { width: number; height: number }
): UserAsset {
  const animationData = item.animationData;
  return {
    id: `${assistantId}-lottie-${index}`,
    kind: 'lottie',
    url: String(item.url || '').trim(),
    source: 'ai_lottie',
    width: item.w ?? box.width,
    height: item.h ?? box.height,
    ...(animationData ? { animationData } : {}),
  };
}

function VideoGenGallery({
  assistant,
}: {
  assistant: ChatUiMessage;
  sending?: boolean;
}): ReactNode {
  const videos = assistant.videos || [];
  const pending = Math.max(0, Number(assistant.videoPendingCount) || 0);
  const slots = Math.max(videos.length, pending);
  if (slots <= 0) return null;
  const box = cardBoxFromAspect(assistant.imageAspectRatio);

  return chatGenGalleryShell(
    Array.from({ length: slots }, (_, i) => {
      const src = videos[i];
      if (src) {
        const asset = chatResultAssetFromVideo(src, i, assistant.id, box);
        return (
          <div key={asset.id} className="shrink-0" style={{ width: box.width }}>
            <UserAssetCard
              asset={asset}
              dense
              editorMediaPreview
              onDragStart={(e, a) => {
                setMediaAssetDragData(e.dataTransfer, {
                  kind: 'video',
                  src: String(a.url || src),
                  width: box.width,
                  height: box.height,
                  name: 'Video',
                });
              }}
              onDragEnd={() => scheduleClearMediaAssetDragData(300)}
            />
          </div>
        );
      }
      return (
        <ChatMediaPendingSlot
          key={`${assistant.id}-vshimmer-${i}`}
          seed={`${assistant.id}-v-${i}`}
          box={box}
        />
      );
    })
  );
}

function chatResultAssetFromAudio(src: string, index: number, assistantId: string): UserAsset {
  return {
    id: `${assistantId}-audio-${index}`,
    kind: 'audio',
    url: src,
    source: 'ai_audio',
  };
}

function AudioGenGallery({
  assistant,
}: {
  assistant: ChatUiMessage;
  sending?: boolean;
}): ReactNode {
  const audios = assistant.audios || [];
  const pending = Math.max(0, Number(assistant.audioPendingCount) || 0);
  const slots = Math.max(audios.length, pending);
  if (slots <= 0) return null;
  const box = cardBoxFromAspect('1:1');

  return chatGenGalleryShell(
    Array.from({ length: slots }, (_, i) => {
      const src = audios[i];
      if (src) {
        const asset = chatResultAssetFromAudio(src, i, assistant.id);
        return (
          <div key={asset.id} className="shrink-0" style={{ width: box.width }}>
            <UserAssetCard
              asset={asset}
              dense
              editorMediaPreview
              onDragStart={(e, a) => {
                setMediaAssetDragData(e.dataTransfer, {
                  kind: 'audio',
                  src: String(a.url || src),
                  name: 'Audio',
                });
              }}
              onDragEnd={() => scheduleClearMediaAssetDragData(300)}
            />
          </div>
        );
      }
      return (
        <ChatMediaPendingSlot
          key={`${assistant.id}-ashimmer-${i}`}
          seed={`${assistant.id}-a-${i}`}
          box={{ width: box.width, height: box.width }}
        />
      );
    })
  );
}

function LottieGenGallery({
  assistant,
}: {
  assistant: ChatUiMessage;
  sending?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const lotties = assistant.lotties || [];
  const pending = Math.max(0, Number(assistant.lottiePendingCount) || 0);
  const slots = Math.max(lotties.length, pending);
  if (slots <= 0) return null;
  const box = cardBoxFromAspect(assistant.imageAspectRatio);

  return chatGenGalleryShell(
    Array.from({ length: slots }, (_, i) => {
      const item = lotties[i];
      if (item) {
        const asset = chatResultAssetFromLottie(item, i, assistant.id, box);
        const placeOnCanvas = () => {
          const anim = asset.animationData ?? item.animationData;
          if (!anim || typeof anim !== 'object') {
            message.warning(
              t('agent.lottiePlaceMissing', {
                defaultValue: '无法添加到画布：缺少动画数据',
              })
            );
            return;
          }
          placeMediaAsset({
              kind: 'lottie',
              animationData: anim,
              width: asset.width ?? box.width,
              height: asset.height ?? box.height,
              name: '动画工作台',
            });
          message.success(
            t('agent.lottiePlacedOnBoard', {
              defaultValue: '已添加到动画工作台',
            })
          );
        };
        return (
          <div key={asset.id} className="shrink-0" style={{ width: box.width }}>
            <UserAssetCard
              asset={asset}
              dense
              editorMediaPreview
              onActivate={() => placeOnCanvas()}
              onDragStart={(e, a) => {
                const anim = a.animationData ?? a.meta?.animationData;
                setMediaAssetDragData(e.dataTransfer, {
                  kind: 'lottie',
                  src: String(a.url || item.url || ''),
                  width: a.width ?? box.width,
                  height: a.height ?? box.height,
                  name: 'Lottie',
                  ...(anim && typeof anim === 'object' ? { animationData: anim as Record<string, unknown> } : {}),
                });
              }}
              onDragEnd={() => scheduleClearMediaAssetDragData(300)}
            />
          </div>
        );
      }
      return (
        <ChatMediaPendingSlot
          key={`${assistant.id}-lshimmer-${i}`}
          seed={`${assistant.id}-l-${i}`}
          box={box}
        />
      );
    })
  );
}

function ImageGenGallery({
  assistant,
}: {
  assistant: ChatUiMessage;
  sending?: boolean;
}): ReactNode {
  const images = assistant.images || [];
  const pending = Math.max(0, Number(assistant.imagePendingCount) || 0);
  const slots = Math.max(images.length, pending);
  if (slots <= 0) return null;
  const box = cardBoxFromAspect(assistant.imageAspectRatio);

  return chatGenGalleryShell(
    Array.from({ length: slots }, (_, i) => {
      const src = images[i];
      if (src) {
        const asset = chatResultAssetFromImage(src, i, assistant.id, box);
        return (
          <div key={asset.id} className="shrink-0" style={{ width: box.width }}>
            <UserAssetCard
              asset={asset}
              dense
              editorMediaPreview
              onDragStart={(e, a) => {
                setMediaAssetDragData(e.dataTransfer, {
                  kind: 'image',
                  src: String(a.url || src),
                  width: box.width,
                  height: box.height,
                  name: 'Image',
                });
              }}
              onDragEnd={() => scheduleClearMediaAssetDragData(300)}
            />
          </div>
        );
      }
      return (
        <ChatMediaPendingSlot
          key={`${assistant.id}-shimmer-${i}`}
          seed={`${assistant.id}-i-${i}`}
          box={box}
        />
      );
    })
  );
}

function resolveAskChoiceUi(assistant: ChatUiMessage): ChatUiMessage['choiceUi'] | null {
  if (assistant.choiceUi?.mode === 'text') {
    // Free-text answers use the bottom composer — only keep chip actions if any.
    const opts = (assistant.choiceUi.options || []).filter(
      (o) => o.action === 'apply' || o.action === 'dismiss'
    );
    if (!opts.length) return null;
    return { mode: 'buttons', options: opts };
  }
  if (assistant.choiceUi?.options?.length) return assistant.choiceUi;
  if (!assistant.proposedOps?.length) return null;
  return {
    mode: 'confirm',
    options: [
      { label: '', action: 'apply' },
      { label: '', action: 'dismiss' },
    ],
  };
}

function AskChoicePanel({
  assistant,
  onChoice,
  sending,
}: {
  assistant: ChatUiMessage;
  onChoice: (choice: AskChoicePick) => void;
  sending: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const ui = resolveAskChoiceUi(assistant);
  const [picked, setPicked] = useState<string[]>([]);
  if (!ui?.options.length) return null;

  const optionLabel = (opt: { label: string; action: string; value?: string }) => {
    if (opt.label) return opt.label;
    if (opt.action === 'apply') return t('common.confirm');
    if (opt.action === 'dismiss') return t('common.cancel');
    return opt.label;
  };

  const chipClass =
    'inline-flex h-8 max-w-full items-center rounded-full border border-[var(--line)] bg-[var(--canvas)] px-3 text-[12px] text-[var(--ink)] transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-40';

  if (ui.mode === 'multi') {
    const replyOpts = ui.options.filter((o) => o.action === 'reply');
    const applyOpt = ui.options.find((o) => o.action === 'apply');
    const dismissOpt = ui.options.find((o) => o.action === 'dismiss');
    return (
      <div className="mt-1 flex flex-col items-start gap-1.5">
        <div className="flex flex-wrap gap-1.5">
          {replyOpts.map((opt) => {
            const label = optionLabel(opt);
            const on = picked.includes(label);
            return (
              <button
                key={`m-${label}`}
                type="button"
                disabled={sending}
                className={cn(chipClass, on && 'border-[var(--ink)] bg-[var(--line)]')}
                onClick={() =>
                  setPicked((prev) =>
                    on ? prev.filter((x) => x !== label) : [...prev, label]
                  )
                }
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {applyOpt ? (
            <button
              type="button"
              disabled={sending}
              className={chipClass}
              onClick={() =>
                onChoice({
                  label: optionLabel(applyOpt),
                  action: 'apply',
                  selectedLabels: picked,
                })
              }
            >
              {optionLabel(applyOpt)}
            </button>
          ) : (
            <button
              type="button"
              disabled={sending || picked.length === 0}
              className={chipClass}
              onClick={() =>
                onChoice({
                  label: picked.join('、'),
                  action: 'reply',
                  selectedLabels: picked,
                })
              }
            >
              {t('common.confirm')}
            </button>
          )}
          {dismissOpt ? (
            <button
              type="button"
              disabled={sending}
              className={chipClass}
              onClick={() =>
                onChoice({ label: optionLabel(dismissOpt), action: 'dismiss' })
              }
            >
              {optionLabel(dismissOpt)}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-1 flex flex-col items-start gap-1.5">
      {assistant.proposedOps?.length ? (
        <div className="w-full rounded-lg border border-[var(--line)] bg-[var(--canvas)]/60 px-2.5 py-2 text-[11px] leading-relaxed text-[var(--muted)]">
          <div className="mb-1 font-medium text-[var(--ink)]/80">
            {t('agent.proposeOpsPreview', {
              count: assistant.proposedOps.length,
              defaultValue: '将应用 {{count}} 项画布操作',
            })}
          </div>
          <ul className="list-inside list-disc space-y-0.5">
            {assistant.proposedOps.slice(0, 6).map((op, i) => (
              <li key={`${op.op_id || op.name || 'op'}-${i}`} className="truncate">
                {String(op.name || 'op')}
              </li>
            ))}
            {assistant.proposedOps.length > 6 ? (
              <li>
                {t('agent.proposeOpsMore', {
                  count: assistant.proposedOps.length - 6,
                  defaultValue: '另有 {{count}} 项…',
                })}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
      {assistant.choiceUi?.mode === 'text' && assistant.choiceUi.placeholder ? (
        <p className="text-[11px] text-[var(--muted)]">{assistant.choiceUi.placeholder}</p>
      ) : null}
      {ui.options.map((opt, i) => {
        const label = optionLabel(opt);
        return (
          <button
            key={`${opt.action}-${label}-${i}`}
            type="button"
            disabled={sending}
            className={chipClass}
            onClick={() => onChoice({ label, action: opt.action, value: opt.value })}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

const ChatTurnList = forwardRef(function ChatTurnList(
  {
    turns,
    editingUserId,
    editComposer,
    sending,
    formatWorked: _formatWorked,
    hasCheckpoint,
    onBeginEdit,
    onCancelEdit,
    onRestore,
    onChoice,
    onResume,
    onDismissResume,
    className,
  }: Props,
  ref: Ref<VirtualListHandle>
): ReactNode {
  const { t } = useTranslation();

  return (
    <VirtualList
      ref={ref}
      items={turns}
      estimateSize={180}
      overscan={4}
      gap={20}
      getItemKey={(turn) => turn.user?.id || turn.assistant?.id || 'turn'}
      className={cn('px-4 py-2', className)}
      contentClassName="py-2"
      empty={
        <p className="px-1 text-left text-[14px] text-[var(--muted)]">
          {t('agent.emptyHint')}
        </p>
      }
    >
      {({ user: m, assistant }) => {
        const isEditing = Boolean(m && editingUserId === m.id);
        const canRestore = Boolean(m && hasCheckpoint(m.id));
        return (
          <div className="flex w-full min-w-0 flex-col gap-3">
            {m && isEditing ? (
                <div className="flex min-w-0 flex-col gap-1.5">
                  <div className="overflow-hidden rounded-[22px] border border-[var(--line)] bg-[var(--accent-soft)] shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
                    {editComposer}
                  </div>
                  <div className="flex items-center gap-1 px-0.5">
                    {canRestore ? (
                      <button
                        type="button"
                        className={CHIP_ACTION_BTN}
                        onClick={() => onRestore(m.id)}
                      >
                        <HiOutlineArrowUturnLeft className="h-3.5 w-3.5" />
                        {t('agent.restore')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={CHIP_ACTION_TEXT}
                      onClick={onCancelEdit}
                    >
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              ) : null}
            {m && !isEditing ? (
                <div className="group relative w-full min-w-0">
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => onBeginEdit(m)}
                    className={cn(
                      'w-full rounded-[22px] border-0 bg-[var(--accent-soft)] px-3.5 py-2.5 text-left text-[13px] leading-relaxed text-[var(--ink)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                      !sending ? 'cursor-pointer' : 'cursor-not-allowed opacity-80',
                      canRestore && !sending ? 'pr-10' : ''
                    )}
                    title={t('agent.clickToEdit')}
                  >
                    <UserMessageBody
                      content={m.content}
                      contentMarked={m.contentMarked}
                      contexts={m.contexts}
                    />
                  </button>
                  {canRestore ? (
                    <button
                      type="button"
                      aria-label={t('agent.restoreCheckpoint')}
                      title={t('agent.restoreCheckpoint')}
                      disabled={sending}
                      className={cn(
                        'absolute right-1.5 top-1.5 z-10 inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] text-[var(--muted)] transition-opacity hover:bg-[var(--canvas)] hover:text-[var(--ink)]',
                        sending
                          ? 'pointer-events-none opacity-0'
                          : 'opacity-0 group-hover:opacity-100'
                      )}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const id = m.id;
                        window.setTimeout(() => onRestore(id), 0);
                      }}
                    >
                      <HiOutlineArrowUturnLeft className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ) : null}

            {assistant && !isEditing ? (
              <AssistantTurn
                assistant={assistant}
                onChoice={onChoice}
                onResume={onResume}
                onDismissResume={onDismissResume}
                sending={sending}
              />
            ) : null}
          </div>
        );
      }}
    </VirtualList>
  );
});

export default memo(ChatTurnList);
