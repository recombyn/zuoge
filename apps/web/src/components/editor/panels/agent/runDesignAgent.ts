import type { SceneDocument, SceneNodeInput } from '@/components/rcb/sceneNode';
import type { ArtboardFrame } from '@/components/rcb/frames/types';
/**
 * Run backend design pipeline and stream progress into the agent UI.
 * Live-draw applies SVG via existing design tools (create_shape / create_text / …)
 * so results land as editable canvas nodes — not a single image blob.
 */


import {
  fetchDesignRunEvents,
  fetchDesignRunStatus,
  parseDesignJobEvent,
  runDesignJob,
  resumeDesignJob,
  postDesignSceneFeedback,
  acknowledgeDesignCanvasCommands,
  type DesignJobEvent,
  type DesignRunMode,
  type DesignScene,
  type DesignSvgPatch,
  type RunDesignJobBody,
} from '@/service/design';
import {
  groupNodesInDocument
} from '@/components/rcb/scene/document/sceneGroups';
import { removeNodesFromDocument } from '@/components/rcb/scene/document/sceneDocument';
import { scalePathData, translatePathData } from '@/components/rcb/scene/document/pathScale';
import { maxRadius, radiiFromAttrs } from '@/components/rcb/scene/document/sceneRadii';
import { renderExport } from '@/components/rcb/scene/export/exportImage';
import {
  applyClientFrameHints,
  applyMemoryPatch,
  frameIsEmpty,
  type DesignMemoryPayload,
  type MemoryPatch,
  type TaskState,
} from '@/components/editor/panels/agent/agentMemory';
import {
  applySceneMutation,
  executeDesignTool,
  executeDesignToolAsync,
  nextArtboardOrigin,
  type CanvasUiBridge,
} from '@/components/editor/panels/agent/designTools';
import {
  beginAiSceneMutation,
  beginCanvasApplyLock,
  cancelImportPlaceholder,
  clearArtboardGenerating,
  endAiSceneMutation,
  endCanvasApplyLock,
  pushEditorHistory,
  setDocument,
  undo,
  setAiOperationState,
} from '@/store/modules/editor';
import { resolveToolOpsInterOpDelayMs } from '@/components/editor/panels/agent/toolOpsApplyPolicy';
import { store } from '@/store';

export type ToolOpResult = {
  op_id: string;
  name: string;
  ok: boolean;
  error?: string;
  /** Intended and observed scene ids; tool input itself remains in the task event log. */
  operation?: 'create' | 'update' | 'delete' | 'other';
  expected_node_ids?: string[];
  actual_node_ids?: string[];
};

export type AiQueueStatus =
  | 'idle'
  | 'open'
  | 'applying'
  | 'paused'
  | 'committed'
  | 'rolled_back'
  | 'cancelled';

export type AiQueuedOp = {
  name?: string;
  args?: Record<string, unknown>;
  op_id?: string;
};

export type AiOperationQueue = {
  transactionId: string | null;
  phase: string;
  baseRevision: number;
  status: AiQueueStatus;
  historyPushed: boolean;
  pending: AiQueuedOp[][];
  opResults: ToolOpResult[];
};

export function createAiOperationQueue(): AiOperationQueue {
  return {
    transactionId: null,
    phase: 'paint',
    baseRevision: 0,
    status: 'idle',
    historyPushed: false,
    pending: [],
    opResults: [],
  };
}

function isClosed(status: AiQueueStatus): boolean {
  return ['rolled_back', 'cancelled', 'paused'].includes(status);
}

export function aiQueueBegin(
  queue: AiOperationQueue,
  opts: { transactionId: string; phase?: string; baseRevision?: number }
) {
  const transactionId = String(opts.transactionId || '').trim();
  if (!transactionId) return;
  queue.transactionId = transactionId;
  queue.phase = String(opts.phase || 'paint').trim() || 'paint';
  queue.baseRevision = Math.max(0, Number(opts.baseRevision) || 0);
  queue.status = 'open';
  queue.historyPushed = false;
  queue.pending = [];
  queue.opResults = [];
}

export function aiQueueBindTransaction(queue: AiOperationQueue, id: string) {
  const transactionId = String(id || '').trim();
  if (!transactionId || (queue.transactionId && queue.transactionId !== transactionId)) return;
  queue.transactionId = transactionId;
  if (queue.status === 'idle' || queue.status === 'committed') queue.status = 'open';
}

export function aiQueueEnqueue(queue: AiOperationQueue, ops: AiQueuedOp[]): boolean {
  if (!ops.length || isClosed(queue.status)) return false;
  if (queue.status === 'idle') {
    queue.status = 'open';
    queue.historyPushed = false;
  } else if (queue.status === 'committed') {
    queue.status = 'open';
  }
  queue.pending.push(ops);
  return true;
}

export function aiQueueTakeChunk(queue: AiOperationQueue): AiQueuedOp[] | null {
  if (isClosed(queue.status) || !queue.pending.length) return null;
  queue.status = 'applying';
  return queue.pending.shift() || null;
}

export function aiQueueMarkApplied(
  queue: AiOperationQueue,
  opts: { historyPushed: boolean; opResults: ToolOpResult[] }
) {
  if (opts.historyPushed) queue.historyPushed = true;
  if (opts.opResults.length) queue.opResults.push(...opts.opResults);
  if (queue.status === 'applying') {
    queue.status = queue.pending.length ? 'open' : 'committed';
  }
}

export function aiQueueShouldSkipHistory(queue: AiOperationQueue, id: string): boolean {
  const transactionId = String(id || '').trim();
  return Boolean(transactionId && queue.transactionId === transactionId && queue.historyPushed);
}

export function aiQueuePause(queue: AiOperationQueue) {
  if (queue.status === 'open' || queue.status === 'applying') queue.status = 'paused';
}

export function aiQueueCommit(queue: AiOperationQueue, id?: string) {
  const transactionId = String(id || '').trim();
  if (transactionId && !queue.transactionId) queue.transactionId = transactionId;
  if (queue.status === 'rolled_back' || queue.status === 'cancelled') return;
  if (!queue.pending.length && queue.status !== 'applying') queue.status = 'committed';
}

export function aiQueueRollback(queue: AiOperationQueue, id?: string): boolean {
  const transactionId = String(id || '').trim();
  if (
    (transactionId && queue.transactionId && transactionId !== queue.transactionId) ||
    queue.status === 'rolled_back' ||
    queue.status === 'cancelled'
  ) {
    return false;
  }
  const undo = queue.historyPushed;
  queue.status = 'rolled_back';
  queue.pending = [];
  queue.historyPushed = false;
  return undo;
}

export function aiQueueCancel(queue: AiOperationQueue): boolean {
  if (queue.status === 'rolled_back' || queue.status === 'cancelled') return false;
  const undo = queue.historyPushed;
  queue.status = 'cancelled';
  queue.pending = [];
  queue.historyPushed = false;
  return undo;
}

export function aiQueueFlushResults(queue: AiOperationQueue): ToolOpResult[] {
  const results = queue.opResults;
  queue.opResults = [];
  return results;
}

export function aiQueueAckStatus(queue: AiOperationQueue): 'ack' | 'rollback' {
  return queue.status === 'rolled_back' || queue.status === 'cancelled'
    ? 'rollback'
    : 'ack';
}

export function acknowledgeAppliedDesignCommand(
  taskId: string | null | undefined,
  sequence: number | null | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const normalizedTaskId = String(taskId || '').trim();
  const normalizedSequence = Number(sequence || 0);
  if (!normalizedTaskId || normalizedSequence <= 0) return Promise.resolve();
  return (async () => {
    try {
      await acknowledgeDesignCanvasCommands(normalizedTaskId, normalizedSequence, signal);
    } catch (error) {
      console.error('[design command ack failed]', {
        commandTaskId: normalizedTaskId,
        commandSeq: normalizedSequence,
        error,
      });
      throw error;
    }
  })();
}

function overlayArgId(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  const scalar = String(args.nodeId || '').trim();
  if (scalar) return scalar;
  const ids = args.nodeIds;
  return Array.isArray(ids) && ids.length ? String(ids[ids.length - 1] || '').trim() || null : null;
}

export function overlayLabelForAction(action?: string): string {
  const labels: Record<string, string> = {
    create_text: 'Adding text…', create_shape: 'Adding shape…', create_image: 'Adding image…',
    create_frame: 'Opening artboard…', update_node: 'Updating element…', delete_nodes: 'Removing elements…', delete_frame: 'Removing artboard…',
  };
  return labels[action || ''] || (action ? `Applying ${action}…` : 'Editing elements…');
}

export function overlayFromToolOps(opts: { ops: Array<{ name?: string; args?: Record<string, unknown> }>; frameId?: string | null; transactionId?: string; label?: string; appliedNodeIds?: string[] }) {
  const last = opts.ops.length ? opts.ops[opts.ops.length - 1] : undefined;
  const applied = (opts.appliedNodeIds || []).filter(Boolean);
  const nodeId = (applied.length ? applied[applied.length - 1] : '') || overlayArgId(last?.args) || null;
  const action = String(last?.name || '').trim() || undefined;
  return { active: true as const, transactionId: opts.transactionId, frameId: opts.frameId ?? null, nodeId, action, label: opts.label || overlayLabelForAction(action) };
}

export type ToolOpsExecutorContext = {
  getDocument: () => SceneDocument | null;
  frameId: string | null;
  signal?: AbortSignal;
  canvasUi?: CanvasUiBridge | null;
  transactionId?: string;
  baseRevision?: number;
  currentRevision?: number;
  skipHistoryPush?: boolean;
  appliedOpIds: Set<string>;
};

export type ToolOpsExecutionResult = {
  created: number;
  updated: number;
  deleted: number;
  nodeIds: string[];
  frameId: string | null;
  opResults: ToolOpResult[];
  historyPushed: boolean;
  revisionAction?: 'apply' | 'rebase' | 'reject';
};

function uniqueReceiptNodeIds(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 32);
}

function expectedNodeIds(args: Record<string, unknown>): string[] {
  const values: unknown[] = [args.nodeId];
  if (Array.isArray(args.nodeIds)) values.push(...args.nodeIds);
  return uniqueReceiptNodeIds(values);
}

function operationKind(name: string): ToolOpResult['operation'] {
  if (name.startsWith('create_')) return 'create';
  if (name.startsWith('delete_')) return 'delete';
  if (name.startsWith('update_') || name === 'outline_text') return 'update';
  return 'other';
}

function artifactNodeIds(artifacts: Record<string, unknown> | undefined): string[] {
  if (!artifacts) return [];
  const values: unknown[] = [artifacts.nodeId, artifacts.frameId];
  for (const candidate of [artifacts.nodeIds, artifacts.frameIds]) {
    if (Array.isArray(candidate)) values.push(...candidate);
  }
  return uniqueReceiptNodeIds(values);
}

function completeOperationReceipts(
  ops: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>,
  results: ToolOpResult[]
): ToolOpResult[] {
  const sourceById = new Map<string, { name?: string; args?: Record<string, unknown>; op_id?: string }>();
  for (const op of ops) {
    const opId = String(op.op_id || '').trim();
    if (opId) sourceById.set(opId, op);
  }
  return results.map((result) => {
    const source = sourceById.get(String(result.op_id || '').trim());
    const args = source?.args && typeof source.args === 'object' ? source.args : {};
    return {
      ...result,
      operation: result.operation || operationKind(String(result.name || source?.name || '')),
      expected_node_ids: result.expected_node_ids || expectedNodeIds(args),
      actual_node_ids: result.actual_node_ids || [],
    };
  });
}

function hasCompleteOperationReceipts(
  ops: Array<{ op_id?: string }>,
  results: ToolOpResult[]
): boolean {
  const expected = ops.map((op) => String(op.op_id || '').trim()).filter(Boolean);
  if (!expected.length) return false;
  const received = new Set(results.map((result) => String(result.op_id || '').trim()).filter(Boolean));
  return expected.every((opId) => received.has(opId));
}

export async function applyAgentToolOps(opts: {
  ops: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
  getDocument: () => SceneDocument | null;
  frameId: string | null;
  signal?: AbortSignal;
  /** Prefer update over create when model stacks a new bg plate. */
  sceneNodes?: SceneNodeInventoryItem[] | null;
  userImages?: string[] | null;
  /** Cross-chunk dedupe when SSE replays the same op_id. */
  appliedOpIds?: Set<string>;
  canvasUi?: CanvasUiBridge | null;
  /** DesignTransaction: skip history push when already grouped for this tx. */
  skipHistoryPush?: boolean;
  /** Scene Mutation source — AI never writes store mutator shapes directly. */
  source?: 'ai' | 'human' | 'collab';
  transactionId?: string;
  baseRevision?: number;
  currentRevision?: number;
  /** Stagger between successful ops (Figma-like reveal). 0 disables. */
  delayMs?: number;
  /** When false, canvas stays interactive during apply. Default true. */
  lockCanvas?: boolean;
  onProgress?: (info: { done: number; total: number }) => void;
}): Promise<{
  created: number;
  updated: number;
  deleted: number;
  nodeIds: string[];
  frameId: string | null;
  /** Per-op truth for scene_feedback — backend must not assume success. */
  opResults: ToolOpResult[];
  historyPushed: boolean;
  revisionAction?: 'apply' | 'rebase' | 'reject';
}> {
  const { ops, getDocument, frameId, signal, userImages, appliedOpIds } =
    opts;
  const delayMs = resolveToolOpsInterOpDelayMs({
    opCount: ops.length,
    overrideMs: opts.delayMs,
  });
  const lockCanvas = opts.lockCanvas !== false;
  if (lockCanvas) beginCanvasApplyLock();
  const toolCtx = {
    getDocument,
    skipHistory: true as const,
    targetFrameId: frameId as string | null,
    // Backend already emitted these ops after intent — allow delete_nodes if present.
    allowDestructive: true as const,
    userImages: (userImages || []).filter(Boolean),
    canvasUi: opts.canvasUi,
  };
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let outFrameId: string | null = frameId;
  const nodeIds: string[] = [];

  const pickTargetFrameIdForCreate = (
    doc: SceneDocument,
    args: Record<string, unknown>,
    fallback: string | null
  ): string | null => {
    // Host shimmer / @ pin / live plate already bound — never spatialize onto
    // ambient boards (model world x/y or guessed frameId often hits the old plate).
    if (fallback) return fallback;
    const explicit = String(args.frameId || '').trim();
    if (explicit) {
      const frames = Array.isArray(doc?.frames) ? doc.frames : [];
      if (frames.some((f) => f && String(f.id) === explicit)) return explicit;
    }
    const frames = Array.isArray(doc?.frames) ? doc.frames : [];
    if (frames.length <= 1) {
      return frames[0]?.id != null ? String(frames[0].id) : null;
    }
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let best: { id: string; area: number } | null = null;
    for (const f of frames) {
      const id = String(f?.id || '').trim();
      if (!id) continue;
      const fx = Number(f.x) || 0;
      const fy = Number(f.y) || 0;
      const fw = Math.max(1, Number(f.width) || 1);
      const fh = Math.max(1, Number(f.height) || 1);
      if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) {
        const area = fw * fh;
        if (!best || area < best.area) best = { id, area };
      }
    }
    return best?.id || null;
  };

  try {
  const mutation = await applySceneMutation({
    source: opts.source || 'ai',
    transactionId: opts.transactionId,
    ops,
    appliedOpIds: appliedOpIds || new Set(),
    allowDestructive: true,
    baseRevision: opts.baseRevision,
    currentRevision: opts.currentRevision,
    document: getDocument(),
    skipHistory: Boolean(opts.skipHistoryPush),
    execute: async (allowed) => {
      const opResults: ToolOpResult[] = [];
      const rawDeletes = ops.filter((o) =>
        ['delete_frame', 'delete_nodes'].includes(String(o?.name || '').trim())
      );
      if (rawDeletes.length) {
        const allowedDeletes = allowed.filter((o) =>
          ['delete_frame', 'delete_nodes'].includes(String(o?.name || '').trim())
        );
      }
      for (let i = 0; i < allowed.length; i++) {
    if (signal?.aborted) break;
    const op = allowed[i];
    const name = String(op?.name || '').trim();
    if (!name) continue;
    // Host auto-groups once at the end of the run — report skip, do not silently drop.
    if (name === 'group_nodes' || name === 'ungroup_nodes') {
      opResults.push({
        op_id: String((op as { op_id?: string })?.op_id || ''),
        name,
        ok: false,
        error: `${name}_deferred: host auto-groups at end of run; omit mid-stream group/ungroup`,
      });
      opts.onProgress?.({ done: i + 1, total: allowed.length });
      continue;
    }
    const opId = String((op as { op_id?: string })?.op_id || '');
    const args = op?.args && typeof op.args === 'object' ? { ...op.args } : {};
    const receiptBase = {
      op_id: opId,
      name,
      operation: operationKind(name),
      expected_node_ids: expectedNodeIds(args),
    } as const;
    if (
      name.startsWith('create_') &&
      name !== 'create_frame' &&
      name !== 'create_page'
    ) {
      const picked = pickTargetFrameIdForCreate(
        getDocument(),
        args,
        toolCtx.targetFrameId
      );
      if (picked) toolCtx.targetFrameId = picked;
    }
    const res = await executeDesignToolAsync(name, JSON.stringify(args), toolCtx);
    if (name === 'create_frame' && res.status !== 'error') {
      const fid = String(res.artifacts?.frameId || '').trim();
      if (fid) {
        outFrameId = fid;
        toolCtx.targetFrameId = fid;
      }
    }
    if (res.status === 'error') {
      console.warn('[tool_ops error]', { i, name, args, summary: res.summary });
      opResults.push({
        ...receiptBase,
        ok: false,
        error: String(res.summary || 'failed').slice(0, 200),
        actual_node_ids: [],
      });
      opts.onProgress?.({ done: i + 1, total: allowed.length });
      continue;
    }
    const actualNodeIds = artifactNodeIds(res.artifacts);
    opResults.push({
      ...receiptBase,
      ok: true,
      actual_node_ids: actualNodeIds.length ? actualNodeIds : receiptBase.expected_node_ids,
    });
    let mutated = false;
    if (name === 'update_node' || name === 'outline_text') {
      updated += 1;
      mutated = true;
      const outlined = Array.isArray(res.artifacts?.nodeIds)
        ? (res.artifacts!.nodeIds as unknown[]).map((x) => String(x)).filter(Boolean)
        : [];
      if (outlined.length) nodeIds.push(...outlined);
      else {
        const nid = String(args.nodeId || '');
        if (nid) nodeIds.push(nid);
      }
    } else if (name === 'delete_nodes') {
      deleted += 1;
      mutated = true;
    } else if (name === 'delete_frame') {
      deleted += 1;
      mutated = true;
    } else {
      const id = res.artifacts?.nodeId != null ? String(res.artifacts.nodeId) : '';
      if (id) {
        nodeIds.push(id);
        created += 1;
        mutated = true;
      }
    }
    opts.onProgress?.({ done: i + 1, total: allowed.length });
    if (mutated && delayMs > 0 && i < allowed.length - 1) {
      try {
        await sleep(delayMs, signal);
      } catch {
        break;
      }
    }
  }
      return {
        created,
        updated,
        deleted,
        nodeIds,
        frameId: outFrameId,
        opResults,
      };
    },
  });
  if (!mutation.result) {
    return {
      created: 0,
      updated: 0,
      deleted: 0,
      nodeIds: [],
      frameId: outFrameId,
      opResults: completeOperationReceipts(ops, mutation.opResults),
      historyPushed: false,
      revisionAction: mutation.revisionAction,
    };
  }
  return {
    ...mutation.result,
    opResults: completeOperationReceipts(ops, mutation.opResults),
    historyPushed: mutation.historyPushed,
    revisionAction: mutation.revisionAction,
  };
  } finally {
    if (lockCanvas) endCanvasApplyLock();
  }
}


/** Fully resolved WxH only. Auto and partial-auto never create a stock artboard. */
export function parseResolvedSize(
  canvasSize?: string | null
): { width: number; height: number } | null {
  const raw = String(canvasSize || '')
    .toLowerCase()
    .replace('*', 'x')
    .replace(/\s+/g, '')
    .trim();
  const match = raw.match(/^(\d+)x(\d+)$/);
  if (!match) return null;
  const width = Math.max(64, Number(match[1]) || 0);
  const height = Math.max(64, Number(match[2]) || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return { width, height };
}

export function frameSizeFromDoc(
  getDocument: () => SceneDocument | null,
  frameId: string | null | undefined
): { width: number; height: number } | null {
  if (!frameId) return null;
  const doc = getDocument();
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  const frame = frames.find((item) => item?.id === frameId);
  const width = Math.round(Number(frame?.width) || 0);
  const height = Math.round(Number(frame?.height) || 0);
  return width >= 64 && height >= 64 ? { width, height } : null;
}

export function ensureFrameSize(opts: {
  getDocument: () => SceneDocument | null;
  frameId: string | null;
  width: number;
  height: number;
  skipHistory?: boolean;
  name?: string;
}): string | null {
  const toolCtxBase = {
    getDocument: opts.getDocument,
    skipHistory: opts.skipHistory !== false ? (true as const) : undefined,
  };
  let doc = opts.getDocument();
  if (!doc) return null;
  let frameId = opts.frameId;
  const frames = Array.isArray(doc.frames) ? doc.frames : [];
  if (!frameId || !frames.some((frame) => frame.id === frameId)) {
    const slot = nextArtboardOrigin(doc, opts.width, opts.height);
    const created = executeDesignTool(
      'create_frame',
      JSON.stringify({
        ...(frameId ? { id: frameId } : {}),
        name: String(opts.name || 'Design').trim() || 'Design',
        x: slot.x,
        y: slot.y,
        width: opts.width,
        height: opts.height,
        backgroundColor: '#FFFFFF',
      }),
      toolCtxBase
    );
    frameId = String(created.artifacts?.frameId || '') || null;
    if (!frameId) {
      doc = opts.getDocument();
      const nextFrames = Array.isArray(doc?.frames) ? doc.frames : [];
      frameId = nextFrames[nextFrames.length - 1]?.id || null;
    }
    return frameId;
  }
  const frame = frames.find((item) => item.id === frameId);
  const width = Math.round(Number(frame?.width) || 0);
  const height = Math.round(Number(frame?.height) || 0);
  if (width !== opts.width || height !== opts.height) {
    executeDesignTool(
      'update_frame',
      JSON.stringify({ frameId, width: opts.width, height: opts.height }),
      toolCtxBase
    );
  }
  return frameId;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const SKIP_TAGS = new Set([
  'defs', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient',
  'filter', 'style', 'script', 'title', 'desc', 'metadata', 'marker', 'symbol',
]);
function wrapSvgFragment(svg: string, width: number, height: number): string {
  const trimmed = svg.trim();
  if (/^<svg[\s>]/i.test(trimmed)) return trimmed;
  return `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${trimmed}</svg>`;
}

function numAttr(el: Element, name: string, fallback = 0): number {
  const n = Number(el.getAttribute(name));
  return Number.isFinite(n) ? n : fallback;
}

function paintOf(el: Element, prop: 'fill' | 'stroke'): string {
  // Prefer the presentation attribute — computed style invents SVG defaults
  // (fill=black) which then become unwanted solid plates on path import.
  const raw = String(el.getAttribute(prop) || '').trim();
  if (raw === 'none' || raw === 'transparent') return 'transparent';
  if (raw && raw !== 'inherit' && !raw.startsWith('url(')) return raw;
  try {
    const cs = getComputedStyle(el as Element);
    const v = String(cs.getPropertyValue(prop) || '').trim();
    if (!v || v === 'none') return 'transparent';
    // Bare default black fill with no attribute → treat as none for import.
    if (prop === 'fill' && !raw && /^rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(v)) {
      return 'transparent';
    }
    return v;
  } catch {
    /* ignore */
  }
  return 'transparent';
}

function strokeWidthOf(el: Element): number {
  const strokeAttr = String(el.getAttribute('stroke') || '').trim();
  if (strokeAttr === 'none' || strokeAttr === 'transparent') return 0;
  const attr = el.getAttribute('stroke-width');
  if (attr != null && String(attr).trim() !== '') {
    const n = Number(attr);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  try {
    const cs = getComputedStyle(el as Element);
    const strokeCs = String(cs.getPropertyValue('stroke') || '').trim();
    if (!strokeCs || strokeCs === 'none') return 0;
    const n = parseFloat(cs.strokeWidth || '');
    if (Number.isFinite(n) && n >= 0) return n;
  } catch {
    /* ignore */
  }
  // Explicit stroke color but no width → SVG default 1.
  if (strokeAttr && strokeAttr !== 'none') return 1;
  return 0;
}

function opacityOf(el: Element): number {
  try {
    const cs = getComputedStyle(el as Element);
    const n = parseFloat(cs.opacity || '1');
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  } catch {
    /* ignore */
  }
  const n = Number(el.getAttribute('opacity'));
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

function matrixRelativeToRoot(el: SVGGraphicsElement, root: SVGSVGElement): DOMMatrix | null {
  try {
    const ctm = el.getCTM();
    const rootCtm = root.getCTM();
    if (!ctm) return null;
    if (!rootCtm) return ctm;
    return rootCtm.inverse().multiply(ctm);
  } catch {
    return null;
  }
}

function localBBox(el: SVGGraphicsElement): { x: number; y: number; width: number; height: number } | null {
  try {
    const bb = el.getBBox();
    return { x: bb.x, y: bb.y, width: Math.max(1, bb.width), height: Math.max(1, bb.height) };
  } catch {
    return null;
  }
}

function mapPoint(m: DOMMatrix, x: number, y: number) {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

function decomposeMatrix(m: DOMMatrix) {
  const angle = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  const scaleX = Math.hypot(m.a, m.b) || 1;
  const scaleY = Math.hypot(m.c, m.d) || 1;
  return { angle, scaleX, scaleY };
}

function isInsideSkipped(el: Element): boolean {
  let cur: Element | null = el.parentElement;
  while (cur) {
    const tag = cur.tagName.toLowerCase().replace(/^.*:/, '');
    if (SKIP_TAGS.has(tag)) return true;
    if (tag === 'svg') break;
    cur = cur.parentElement;
  }
  return false;
}

export type ToolOp = {
  name: 'create_shape' | 'create_text' | 'create_image';
  args: Record<string, unknown>;
};

type SvgElGeom = {
  el: SVGGraphicsElement;
  tag: string;
  bb: { x: number; y: number; width: number; height: number };
  dec: { angle: number; scaleX: number; scaleY: number };
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number | undefined;
  fill: string;
  stroke: string;
  borderWidth: number;
  opacity: number;
  name: string | undefined;
};

function toolOpFromRect(g: SvgElGeom): ToolOp {
  const rx = Math.max(
    0,
    numAttr(g.el, 'rx', numAttr(g.el, 'ry', 0)) * Math.abs(g.dec.scaleX)
  );
  return {
    name: 'create_shape',
    args: {
      shapeType: 'rect',
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      fill: g.fill,
      stroke: g.stroke === 'transparent' ? undefined : g.stroke,
      borderWidth: g.stroke === 'transparent' ? 0 : g.borderWidth,
      cornerRadius: rx > 0 ? Math.round(rx) : undefined,
      rotation: g.rotation,
      opacity: g.opacity,
      name: g.name || '矩形',
    },
  };
}

function toolOpFromCircle(g: SvgElGeom): ToolOp {
  return {
    name: 'create_shape',
    args: {
      shapeType: 'circle',
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      fill: g.fill,
      stroke: g.stroke === 'transparent' ? undefined : g.stroke,
      borderWidth: g.stroke === 'transparent' ? 0 : g.borderWidth,
      rotation: g.rotation,
      opacity: g.opacity,
      name: g.name || '圆形',
    },
  };
}

function toolOpFromLine(g: SvgElGeom): ToolOp {
  return {
    name: 'create_shape',
    args: {
      shapeType: 'line',
      x: g.x,
      y: g.y,
      width: Math.max(g.w, 1),
      height: Math.max(g.h, 8),
      stroke: g.stroke === 'transparent' ? '#333333' : g.stroke,
      borderWidth: Math.max(1, g.borderWidth),
      rotation: g.rotation,
      opacity: g.opacity,
      name: g.name || '直线',
    },
  };
}

function toolOpFromPath(g: SvgElGeom): ToolOp | null {
  let d = '';
  if (g.tag === 'path') {
    d = String(g.el.getAttribute('d') || '').trim();
  } else {
    const pts = String(g.el.getAttribute('points') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (pts.length >= 4) {
      const parts: string[] = [];
      for (let i = 0; i < pts.length; i += 2) {
        parts.push(`${i === 0 ? 'M' : 'L'} ${pts[i]} ${pts[i + 1]}`);
      }
      if (g.tag === 'polygon') parts.push('Z');
      d = parts.join(' ');
    }
  }
  if (!d) return null;
  let local = translatePathData(d, -g.bb.x, -g.bb.y);
  if (Math.abs(g.dec.scaleX - 1) > 0.01 || Math.abs(g.dec.scaleY - 1) > 0.01) {
    local = scalePathData(local, Math.abs(g.dec.scaleX), Math.abs(g.dec.scaleY));
  }
  const closed =
    g.tag === 'polygon' || /\bz\s*$/i.test(d.trim()) || g.fill !== 'transparent';
  const strokeIsNone = g.stroke === 'transparent';
  return {
    name: 'create_shape',
    args: {
      shapeType: 'path',
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      path: local,
      closed,
      fill: closed ? g.fill : 'transparent',
      // Keep SVG paint as-is — never invent #333 borders for fill-only paths.
      stroke: strokeIsNone ? 'transparent' : g.stroke,
      borderWidth: strokeIsNone ? 0 : g.borderWidth,
      rotation: g.rotation,
      opacity: g.opacity,
      name: g.name || '路径',
    },
  };
}

function cssTextAlignFromAnchor(textAnchor: string): 'left' | 'center' | 'right' {
  if (textAnchor === 'middle') return 'center';
  if (textAnchor === 'end') return 'right';
  return 'left';
}

function toolOpFromText(g: SvgElGeom): ToolOp | null {
  const text = String(g.el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let fontSize = 14;
  let fontFamily = 'Alibaba PuHuiTi';
  let fontWeight = 'normal';
  let textAnchor = 'start';
  try {
    const cs = getComputedStyle(g.el);
    fontSize = Math.max(8, parseFloat(cs.fontSize) || 14);
    fontFamily =
      String(cs.fontFamily || fontFamily)
        .split(',')[0]
        ?.replace(/['"]/g, '')
        .trim() || fontFamily;
    fontWeight = String(cs.fontWeight || 'normal');
    textAnchor = String(g.el.getAttribute('text-anchor') || 'start');
  } catch {
    fontSize = Math.max(8, numAttr(g.el, 'font-size', 14));
  }
  return {
    name: 'create_text',
    args: {
      text,
      x: g.x,
      y: g.y,
      width: Math.max(g.w, Math.ceil(fontSize * text.length * 0.6)),
      height: Math.max(g.h, Math.ceil(fontSize * 1.4)),
      fontSize: Math.round(fontSize * Math.abs(g.dec.scaleY) * 10) / 10,
      color: g.fill === 'transparent' ? '#333333' : g.fill,
      fontFamily,
      fontWeight: /bold|700|800|900/i.test(fontWeight) ? 'bold' : 'normal',
      textAlign: cssTextAlignFromAnchor(textAnchor),
      name: g.name || '文字',
    },
  };
}

function toolOpFromImage(g: SvgElGeom): ToolOp | null {
  const href =
    g.el.getAttribute('href') ||
    g.el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ||
    '';
  if (!href) return null;
  return {
    name: 'create_image',
    args: {
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      src: href,
      name: g.name || '图片',
    },
  };
}

function elementToToolOp(el: SVGGraphicsElement, root: SVGSVGElement): ToolOp | null {
  const tag = el.tagName.toLowerCase().replace(/^.*:/, '');
  if (SKIP_TAGS.has(tag) || tag === 'svg' || tag === 'g' || tag === 'use') return null;
  if (isInsideSkipped(el)) return null;
  if (String(el.getAttribute('display') || '') === 'none') return null;
  if (String(el.getAttribute('visibility') || '') === 'hidden') return null;

  const bb = localBBox(el);
  if (!bb) return null;
  const m = matrixRelativeToRoot(el, root);
  const dec = m ? decomposeMatrix(m) : { angle: 0, scaleX: 1, scaleY: 1 };
  const topLeft = m ? mapPoint(m, bb.x, bb.y) : { x: bb.x, y: bb.y };
  // Local to artboard — executeDesignTool.fitIntoFrame promotes to world when frame is offset.
  const g: SvgElGeom = {
    el,
    tag,
    bb,
    dec,
    x: Math.round(topLeft.x),
    y: Math.round(topLeft.y),
    w: Math.max(1, Math.round(bb.width * Math.abs(dec.scaleX))),
    h: Math.max(1, Math.round(bb.height * Math.abs(dec.scaleY))),
    rotation: Math.abs(dec.angle) < 0.5 ? undefined : Math.round(dec.angle * 10) / 10,
    fill: paintOf(el, 'fill'),
    stroke: paintOf(el, 'stroke'),
    borderWidth: strokeWidthOf(el),
    opacity: opacityOf(el),
    name: el.getAttribute('id') || undefined,
  };

  switch (tag) {
    case 'rect':
      return toolOpFromRect(g);
    case 'circle':
    case 'ellipse':
      return toolOpFromCircle(g);
    case 'line':
      return toolOpFromLine(g);
    case 'path':
    case 'polygon':
    case 'polyline':
      return toolOpFromPath(g);
    case 'text':
      return toolOpFromText(g);
    case 'image':
      return toolOpFromImage(g);
    default:
      return null;
  }
}

export function designSvgToToolOps(svg: string, size: { width: number; height: number }): ToolOp[] {
  if (typeof document === 'undefined') return [];
  const wrapped = wrapSvgFragment(svg, size.width, size.height);
  const parsed = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
  if (parsed.querySelector('parsererror')) return [];
  const svgEl = parsed.documentElement;
  if (!svgEl || svgEl.tagName.toLowerCase().replace(/^.*:/, '') !== 'svg') return [];

  const host = document.createElement('div');
  host.style.cssText =
    'position:absolute;left:-10000px;top:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none';
  document.body.appendChild(host);
  host.appendChild(svgEl);

  const root = host.querySelector('svg') as SVGSVGElement | null;
  const out: ToolOp[] = [];
  try {
    if (!root) return out;
    root.querySelectorAll('*').forEach((node) => {
      if (!(node instanceof SVGGraphicsElement)) return;
      const op = elementToToolOp(node, root);
      if (op) out.push(op);
    });
  } finally {
    host.remove();
  }
  return out;
}


export type ApplyDesignSvgResult = {
  frameId: string | null;
  nodeIds: string[];
  nodeId: string | null;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  fingerprintById: Record<string, string>;
};

function fingerprintsFor(nodeIds: string[], ops: ToolOp[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < nodeIds.length && i < ops.length; i++) {
    map[nodeIds[i]] = opFingerprint(ops[i]);
  }
  return map;
}

const GENERIC_LAYER_NAMES = new Set([
  '矩形',
  '圆形',
  '直线',
  '路径',
  '文字',
  '图片',
  'rect',
  'circle',
  'ellipse',
  'line',
  'path',
  'text',
  'image',
  'Image',
  'Image Placeholder',
  'Icon',
]);

function opFingerprint(op: ToolOp): string {
  return `${op.name}:${JSON.stringify(op.args)}`;
}

function opLayerKey(op: ToolOp): string | null {
  const name = op.args.name != null ? String(op.args.name).trim() : '';
  if (!name || GENERIC_LAYER_NAMES.has(name)) return null;
  return name;
}

function normalizeShapeType(raw: unknown): string {
  const s = String(raw || 'rect').toLowerCase();
  if (s === 'ellipse') return 'circle';
  if (s === 'pen') return 'pen';
  return s;
}

function nodeMatchesOp(node: SceneNodeInput, op: ToolOp): boolean {
  if (!node) return false;
  if (op.name === 'create_text') return node.key === 'text';
  if (op.name === 'create_image') return node.key === 'image';
  if (node.key !== 'shape') return false;
  return normalizeShapeType(node.attrs?.shapeType) === normalizeShapeType(op.args.shapeType);
}

/** Align new SVG ops to existing live nodes — prefer stable layer ids, then kind+order. */
function assignOpsToPrevNodes(
  ops: ToolOp[],
  prevIds: string[],
  getDocument: () => SceneDocument | null
): { assignment: (string | null)[]; leftoverPrev: string[] } {
  const assignment: (string | null)[] = Array(ops.length).fill(null);
  const used = new Set<string>();
  const doc = getDocument();

  for (let i = 0; i < ops.length; i++) {
    const key = opLayerKey(ops[i]);
    if (!key) continue;
    for (const id of prevIds) {
      if (used.has(id)) continue;
      const node = doc?.deltaSetLike?.[id];
      if (!nodeMatchesOp(node, ops[i])) continue;
      if (String(node?.attrs?.name || '') !== key) continue;
      assignment[i] = id;
      used.add(id);
      break;
    }
  }

  let pi = 0;
  for (let i = 0; i < ops.length; i++) {
    if (assignment[i]) continue;
    while (pi < prevIds.length && used.has(prevIds[pi])) pi += 1;
    while (pi < prevIds.length) {
      const id = prevIds[pi];
      pi += 1;
      if (used.has(id)) continue;
      const node = getDocument()?.deltaSetLike?.[id];
      if (!nodeMatchesOp(node, ops[i])) continue;
      assignment[i] = id;
      used.add(id);
      break;
    }
  }

  const leftoverPrev = prevIds.filter((id) => !used.has(id));
  return { assignment, leftoverPrev };
}

function shouldFullReplace(
  ops: ToolOp[],
  prevIds: string[],
  assignment: (string | null)[]
): boolean {
  if (!prevIds.length) return true;
  const kept = assignment.filter(Boolean).length;
  const denom = Math.max(prevIds.length, ops.length, 1);
  // Structure mostly rewritten — cheaper / safer to recreate once.
  return kept / denom < 0.35 && denom > 3;
}

type ApplyCoreOpts = {
  getDocument: () => SceneDocument | null;
  ops: ToolOp[];
  frameId: string | null;
  prevIds: string[];
  fingerprintById?: Record<string, string> | null;
  forceFullReplace?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
  onProgress?: (info: { done: number; total: number }) => void;
};

async function applyOpsIncremental(opts: ApplyCoreOpts): Promise<ApplyDesignSvgResult> {
  const {
    getDocument,
    ops,
    frameId,
    prevIds,
    fingerprintById,
    signal,
    onProgress,
  } = opts;
  const delayMs = Math.max(0, opts.delayMs ?? 0);
  const toolCtx = {
    getDocument,
    skipHistory: true as const,
    targetFrameId: frameId,
  };

  const empty: ApplyDesignSvgResult = {
    frameId,
    nodeIds: prevIds,
    nodeId: prevIds[0] || null,
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    fingerprintById: {},
  };
  if (!ops.length) return empty;

  pushEditorHistory();

  const { assignment, leftoverPrev } = assignOpsToPrevNodes(ops, prevIds, getDocument);
  const fullReplace =
    Boolean(opts.forceFullReplace) || shouldFullReplace(ops, prevIds, assignment);

  if (fullReplace) {
    if (prevIds.length) {
      setDocument(removeNodesFromDocument(getDocument(), prevIds));
    }
    const nodeIds: string[] = [];
    for (let i = 0; i < ops.length; i++) {
      if (signal?.aborted) break;
      const res = executeDesignTool(ops[i].name, JSON.stringify(ops[i].args), toolCtx);
      const id = res.artifacts?.nodeId != null ? String(res.artifacts.nodeId) : '';
      if (id) nodeIds.push(id);
      onProgress?.({ done: i + 1, total: ops.length });
      if (delayMs > 0 && i < ops.length - 1) {
        try {
          await sleep(delayMs, signal);
        } catch {
          break;
        }
      }
    }
    return {
      frameId,
      nodeIds,
      nodeId: nodeIds[0] || null,
      created: nodeIds.length,
      updated: 0,
      removed: prevIds.length,
      unchanged: 0,
      fingerprintById: fingerprintsFor(nodeIds, ops),
    };
  }

  if (leftoverPrev.length) {
    setDocument(removeNodesFromDocument(getDocument(), leftoverPrev));
  }

  const nodeIds: string[] = [];
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const totalWork = ops.length;

  for (let i = 0; i < ops.length; i++) {
    if (signal?.aborted) break;
    const op = ops[i];
    const prevId = assignment[i];
    const fp = opFingerprint(op);
    let mutated = false;

    if (prevId && getDocument()?.deltaSetLike?.[prevId]) {
      if (fingerprintById?.[prevId] === fp) {
        nodeIds.push(prevId);
        unchanged += 1;
      } else {
        executeDesignTool(
          'update_node',
          JSON.stringify({ nodeId: prevId, ...op.args }),
          toolCtx
        );
        nodeIds.push(prevId);
        updated += 1;
        mutated = true;
      }
    } else {
      const res = executeDesignTool(op.name, JSON.stringify(op.args), toolCtx);
      const id = res.artifacts?.nodeId != null ? String(res.artifacts.nodeId) : '';
      if (id) {
        nodeIds.push(id);
        created += 1;
        mutated = true;
      }
    }

    onProgress?.({ done: i + 1, total: totalWork });
    if (mutated && delayMs > 0 && i < ops.length - 1) {
      try {
        await sleep(delayMs, signal);
      } catch {
        break;
      }
    }
  }

  return {
    frameId,
    nodeIds,
    nodeId: nodeIds[0] || null,
    created,
    updated,
    removed: leftoverPrev.length,
    unchanged,
    fingerprintById: fingerprintsFor(nodeIds, ops),
  };
}

function collectPrevIds(opts: {
  liveNodeIds?: string[] | null;
  liveNodeId?: string | null;
}): string[] {
  return [
    ...(Array.isArray(opts.liveNodeIds) ? opts.liveNodeIds : []),
    ...(opts.liveNodeId ? [opts.liveNodeId] : []),
  ].filter(Boolean);
}

/** Apply design SVG through canvas tools as editable nodes (progressive live-draw). */
export async function applyDesignSvgToDocumentProgressive(opts: {
  getDocument: () => SceneDocument | null;
  svg: string;
  canvasSize?: string | null;
  targetFrameId?: string | null;
  liveNodeIds?: string[] | null;
  liveNodeId?: string | null;
  fingerprintById?: Record<string, string> | null;
  /** Backend svg_patch.mode === 'full' — wipe previous live nodes and recreate. */
  forceFullReplace?: boolean;
  delayMs?: number;
  signal?: AbortSignal;
  onProgress?: (info: { done: number; total: number }) => void;
}): Promise<ApplyDesignSvgResult> {
  const empty: ApplyDesignSvgResult = {
    frameId: null,
    nodeIds: [],
    nodeId: null,
    created: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    fingerprintById: {},
  };
  if (!opts.getDocument()) return empty;

  // Never spawn a stock 1440×900 from Auto / partial-auto.
  const resolved =
    parseResolvedSize(opts.canvasSize) ||
    frameSizeFromDoc(opts.getDocument, opts.targetFrameId);
  if (!resolved) return empty;
  const { width, height } = resolved;

  const frameId = ensureFrameSize({
    getDocument: opts.getDocument,
    frameId: opts.targetFrameId || null,
    width,
    height,
  });

  const ops = designSvgToToolOps(opts.svg, { width, height });
  const prevIds = collectPrevIds(opts);
  if (!ops.length) {
    return {
      frameId,
      nodeIds: prevIds,
      nodeId: prevIds[0] || null,
      created: 0,
      updated: 0,
      removed: 0,
      unchanged: prevIds.length,
      fingerprintById: {},
    };
  }

  const isFirstPaint = prevIds.length === 0;
  return applyOpsIncremental({
    getDocument: opts.getDocument,
    ops,
    frameId,
    prevIds,
    fingerprintById: opts.fingerprintById,
    forceFullReplace: Boolean(opts.forceFullReplace),
    delayMs: resolveToolOpsInterOpDelayMs({
      opCount: ops.length,
      firstPaint: isFirstPaint,
      overrideMs: opts.delayMs,
    }),
    signal: opts.signal,
    onProgress: opts.onProgress,
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = window.setTimeout(() => resolve(), ms);
    const onAbort = () => {
      window.clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}


import {
  buildSceneFramesSnapshot,
  buildSceneNodesForCanvas,
  buildSceneNodesForEdit,
  buildSceneNodesForIds,
  buildSpatialSummary,
  explicitPinnedFrameId,
  frameIdContainingNode,
  nodeIdsInsideFrame,
  resolveDesignTargetFrame,
  resolveToolOpsFrameId,
  sizeFromCreateFrameOp,
  type SceneFrameSnapshot,
  type SceneNodeInventoryItem,
  type SpatialSummary,
} from './agentSceneContext';
export {
  buildSceneFramesSnapshot,
  buildSceneNodesForCanvas,
  buildSceneNodesForEdit,
  buildSceneNodesForIds,
  buildSpatialSummary,
  frameIdContainingNode,
  nodeIdsInsideFrame,
  resolveDesignTargetFrame,
};
export type { SceneFrameSnapshot, SceneNodeInventoryItem, SpatialSummary } from './agentSceneContext';
type AskChoiceUi = {
  mode: 'confirm' | 'single' | 'multi' | 'buttons' | 'text';
  options: Array<{
    label: string;
    action: 'apply' | 'reply' | 'dismiss';
    value?: string;
  }>;
  placeholder?: string;
};

type DesignStatusEvent = Extract<DesignJobEvent, { type: 'status' }>;
type DesignSkillStartEvent = Extract<DesignJobEvent, { type: 'skill_start' }>;
type DesignSkillProgressEvent = Extract<DesignJobEvent, { type: 'skill_progress' }>;
type DesignActivityEvent = Extract<DesignJobEvent, { type: 'activity' }>;
type DesignToolOpsEvent = Extract<DesignJobEvent, { type: 'tool_ops' | 'transaction.chunk' }>;
type DesignSceneFeedbackEvent = Extract<DesignJobEvent, { type: 'scene_feedback_request' }>;
type DesignTransactionBeginEvent = Extract<DesignJobEvent, { type: 'transaction.begin' }>;
type DesignTransactionCommitEvent = Extract<DesignJobEvent, { type: 'transaction.commit' }>;
type DesignTransactionRollbackEvent = Extract<
  DesignJobEvent,
  { type: 'transaction.rollback' }
>;
type DesignSkillDoneEvent = Extract<DesignJobEvent, { type: 'skill_done' }>;
type DesignResultEvent = Extract<DesignJobEvent, { type: 'result' }>;

function normalizeChoiceUi(raw: unknown): AskChoiceUi | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as {
    mode?: string;
    options?: unknown[];
    placeholder?: string;
    hint?: string;
  };
  let modeRaw = String(obj.mode || '').trim().toLowerCase();
  if (
    modeRaw === 'freeform' ||
    modeRaw === 'free_text' ||
    modeRaw === 'input' ||
    modeRaw === 'textarea'
  ) {
    modeRaw = 'text';
  }
  const mode: AskChoiceUi['mode'] =
    modeRaw === 'confirm' ||
    modeRaw === 'single' ||
    modeRaw === 'multi' ||
    modeRaw === 'buttons' ||
    modeRaw === 'text'
      ? modeRaw
      : 'buttons';
  const options: AskChoiceUi['options'] = [];
  for (const item of obj.options || []) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { label?: string; action?: string; value?: string };
    let action = String(row.action || 'reply').trim().toLowerCase();
    if (action === 'cancel' || action === 'close') action = 'dismiss';
    if (action === 'ok' || action === 'confirm') action = 'apply';
    if (action !== 'apply' && action !== 'reply' && action !== 'dismiss') {
      action = 'reply';
    }
    const label = String(row.label || '').trim();
    if (!label && action === 'reply') continue;
    const value = String(row.value || '').trim() || undefined;
    options.push({
      label,
      action: action as AskChoiceUi['options'][number]['action'],
      ...(value ? { value } : {}),
    });
    if (options.length >= 8) break;
  }
  const placeholder = String(obj.placeholder || obj.hint || '').trim() || undefined;
  if (!options.length && mode !== 'text') return undefined;
  return { mode, options, ...(placeholder ? { placeholder } : {}) };
}

/** Client chip WxH — never let backend status rewrite it. */
function parseLockedClientSize(canvasSize?: string | null): string | null {
  const s = String(canvasSize || '')
    .trim()
    .toLowerCase()
    .replace('*', 'x');
  return /^\d+x\d+$/.test(s) ? s : null;
}

export async function captureFocusFramePreview(
  doc: SceneDocument,
  focusFrameId?: string | null
): Promise<string | null> {
  if (typeof window === 'undefined' || !doc) return null;
  const summary = buildSpatialSummary(doc, { focusFrameId });
  const focus = summary.focus_frame_id;
  if (!focus) return null;
  const frame = (Array.isArray(doc.frames) ? doc.frames : []).find(
    (f) => String(f?.id) === focus
  );
  const fw = Math.max(64, Math.round(Number(frame?.width) || 1280));
  const fh = Math.max(64, Math.round(Number(frame?.height) || 720));
  const maxEdge = 768;
  const scale = Math.min(1, maxEdge / Math.max(fw, fh));
  const outW = Math.max(64, Math.round(fw * scale));
  const outH = Math.max(64, Math.round(fh * scale));

  const bg = String(frame?.backgroundColor || '#ffffff');
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${fw} ${fh}">`,
    `<rect width="${fw}" height="${fh}" fill="${bg.replace(/"/g, '') || '#fff'}"/>`,
  ];
  for (const n of summary.focused) {
    const fill = n.type === 'text' ? '#94a3b8' : '#cbd5e1';
    parts.push(
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="${fill}" fill-opacity="0.55" stroke="#64748b" stroke-width="2"/>`
    );
    const label = (n.name || n.text || n.type || '').slice(0, 24);
    if (label) {
      const esc = label.replace(/[<>&"]/g, '');
      parts.push(
        `<text x="${n.x + 6}" y="${n.y + 18}" font-size="14" fill="#0f172a">${esc}</text>`
      );
    }
  }
  parts.push('</svg>');
  const svg = parts.join('');
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('preview_img_fail'));
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, outW, outH);
    ctx.drawImage(img, 0, 0, outW, outH);
    return canvas.toDataURL('image/jpeg', 0.72);
  } catch {
    return null;
  }
}

function sceneInventoryFingerprint(doc: SceneDocument | null | undefined): string {
  if (!doc) return '';
  const ids = Object.keys(doc.deltaSetLike || {})
    .filter((id) => id && id !== 'ROOT')
    .sort();
  const frames = (Array.isArray(doc.frames) ? doc.frames : [])
    .map((f: { id?: string }) => String(f?.id || ''))
    .filter(Boolean)
    .sort();
  return `${ids.length}:${ids.join(',')}|${frames.join(',')}`;
}

/** Wait until scene inventory stops changing (Yjs / mutator lag). */
async function waitSceneInventorySettled(
  getDocument: () => SceneDocument | null,
  opts?: { timeoutMs?: number; stableFrames?: number }
): Promise<void> {
  const timeoutMs = Math.max(80, opts?.timeoutMs ?? 480);
  const needStable = Math.max(1, opts?.stableFrames ?? 2);
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const t0 = Date.now();
  let prev = sceneInventoryFingerprint(getDocument());
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await frame();
    const next = sceneInventoryFingerprint(getDocument());
    if (next === prev) {
      stable += 1;
      if (stable >= needStable) return;
    } else {
      stable = 0;
      prev = next;
    }
  }
}

/**
 * Prefer a real artboard raster for CLIP critique; fall back to schematic boxes.
 * Caps longest edge so the scene_feedback POST stays small.
 */
export async function captureCritiquePreview(
  doc: SceneDocument,
  focusFrameId?: string | null
): Promise<string | null> {
  if (typeof window === 'undefined' || !doc) return null;
  const focus = String(focusFrameId || '').trim();
  const frames: ArtboardFrame[] = Array.isArray(doc.frames) ? doc.frames : [];
  const frame =
    (focus && frames.find((f) => f?.id === focus)) ||
    frames.find((f) => f?.id) ||
    null;
  if (frame) {
    try {
      const w = Math.max(1, Number(frame.width) || 1);
      const h = Math.max(1, Number(frame.height) || 1);
      const maxSide = 640;
      const multiplier = Math.min(1.25, Math.max(0.2, maxSide / Math.max(w, h)));
      const rendered = await renderExport({
        document: doc,
        format: 'jpeg',
        compress: true,
        multiplier,
        crop: {
          x: Number(frame.x) || 0,
          y: Number(frame.y) || 0,
          width: w,
          height: h,
        },
        backgroundColor: String(frame.backgroundColor || '#FFFFFF'),
      });
      if (rendered?.kind === 'raster' && rendered.dataUrl?.startsWith('data:image/')) {
        // Drop oversized payloads (API caps ~1.5MB text).
        if (rendered.dataUrl.length <= 1_400_000) return rendered.dataUrl;
      }
    } catch {
      /* fall through */
    }
  }
  return captureFocusFramePreview(doc, focusFrameId);
}

/** Apply allowlisted canvas tool_ops (Design Agent SSE). */
/** Show artboard scan/shimmer while the design agent is generating. */
function markArtboardGenerating(
  frameId: string | null | undefined,
  label = 'Preparing…',
  extra?: {
    transactionId?: string;
    nodeId?: string | null;
    action?: string;
  }
) {
  if (!frameId) return;
  setAiOperationState({
      active: true,
      frameId,
      label,
      transactionId: extra?.transactionId,
      nodeId: extra?.nodeId ?? null,
      action: extra?.action,
    });
}

export type DesignIntelligencePatch = {
  reference?: {
    thesis?: string;
    composition?: string;
    dna?: Record<string, number>;
    stages?: string[];
  };
  review?: {
    overall?: number | null;
    action?: string;
    scores?: Record<string, number>;
    lanes?: Array<{
      lane?: string;
      score?: number | null;
      evidence?: string[];
    }>;
    topIssues?: Array<{
      priority?: number;
      issue?: string;
      evidence?: string[];
      fix?: string;
      lane?: string;
    }>;
  };
  /** Design quality check (governance) — user view. */
  governance?: {
    status?: string;
    skipped?: boolean;
    lanes?: Array<{
      lane?: string;
      status?: string;
      message?: string;
    }>;
    explain?: string[];
  };
  diff?: {
    deltas?: Record<string, number>;
    visualChange?: Record<string, number | null | undefined>;
    pixelAvailable?: boolean;
  };
  iterations?: Array<{
    iteration: number;
    overall: number;
    decision?: string;
    reason?: string;
  }>;
  summary?: {
    iterations?: number;
    removed?: number;
    whitespace?: number | null;
    heroDominance?: number | null;
    scoreFrom?: number | null;
    scoreTo?: number | null;
    /** User-facing design explanation (why / weak / next). */
    thesis?: string;
    why?: string;
    purpose?: string;
    audience?: string;
    emotion?: string;
    strengths?: string[];
    weaknesses?: string[];
    nextSteps?: string[];
    marketGap?: string;
  };
};

export type AgentStepEvent =
  | {
      type: 'permission';
      can_call_llm: boolean;
      balance?: number;
      need?: number;
      free_daily?: boolean;
    }
  | { type: 'thinking'; text: string; replace?: boolean }
  | { type: 'token'; text?: string; code?: string; params?: Record<string, string> }
  | { type: 'chat' }
  | { type: 'session_control'; action: 'clear_context' | 'stop' | string }
  | { type: 'phase'; progress: PipelineProgress }
  | { type: 'analysis'; text: string }
  | {
      type: 'analysis_delta';
      text: string;
      visibility?: 'user' | 'developer' | 'internal';
    }
  | {
      type: 'intelligence';
      patch: DesignIntelligencePatch;
    }
  | {
      type: 'developer';
      kind: string;
      text?: string;
    }
  | { type: 'drawing'; active: boolean; done?: number; total?: number }
  | {
      type: 'activity';
      id: string;
      kind: 'thought' | 'added' | 'updated' | 'explored' | 'skipped' | 'deleted' | 'tool';
      status: 'running' | 'done' | 'error';
      durationSec?: number;
      count?: number;
      skillName?: string;
      /** Human-readable what happened (or machine codes when `code` is set). */
      detail?: string;
      /** Expandable secondary copy (kept out of the capsule/row label). */
      summary?: string;
      stage?: string;
      /** Stable kernel code for FE i18n (e.g. ops_validate_failed). */
      code?: string;
      item?: { id?: string; name?: string; summary?: string };
      /** Nested rows (e.g. quality-check lanes) — rendered in stream order. */
      items?: Array<{ id?: string; name?: string; summary?: string }>;
      body?: string;
      visibility?: 'user' | 'developer' | 'internal';
    }
  | { type: 'svg_delta'; svg: string }
  | { type: 'canvas'; size: string; scene?: string }
  | {
      type: 'done';
      summary?: string;
      painted?: boolean;
      proposedOps?: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
      proposalId?: string;
      taskId?: string;
      choiceUi?: AskChoiceUi;
    }
  | { type: 'error'; code: string; message?: string; resumable?: boolean }
  | {
      type: 'paused';
      taskId: string;
      resumeToken?: string | null;
      message?: string;
      interruptKind?: string;
    }
  | { type: 'task'; taskId: string };

export type PipelineProgress = {
  category: string;
  labels: string[];
  currentIndex: number;
  stepConfirm?: boolean;
  collabMode?: string;
};


export type RunDesignAgentParams = {
  userMessage: string;
  runMode?: DesignRunMode;
  /** Composer Agent / Ask — Ask proposes before paint. */
  interactionMode?: 'agent' | 'ask' | null;
  scene?: DesignScene | null;
  styleGroupId?: number | null;
  model?: string | null;
  canvasSize?: string | null;
  canvasId?: string | null;
  targetLayerId?: string | null;
  layerIds?: string[] | null;
  currentSvg?: string | null;
  /** Prefill live-draw tracking so edits patch the existing frame instead of spawning a new one. */
  seedLiveNodeIds?: string[] | null;
  /** Frame-local node inventory for edit tool ops. */
  sceneNodes?: SceneNodeInventoryItem[] | null;
  /** Artboard list (ids / sizes) for delete_frame + SCENE_FRAMES. */
  sceneFrames?: SceneFrameSnapshot[] | null;
  /** Dual-context map: focused / peripheral / empty_rects / suggested_place. */
  spatialSummary?: SpatialSummary | null;
  focusFrameId?: string | null;
  /** User-attached reference images (data URLs) for vision + create_image. */
  images?: string[] | null;
  /** Natural WxH of attachments (e.g. ["750x1624"]) — auto canvas soft hint only. */
  refImageSizes?: string[] | null;
  sessionId?: string | null;
  projectId?: string | null;
  memory?: DesignMemoryPayload | null;
  onMemoryPatch?: (patch: MemoryPatch, localHints: { lastAgentFrameId?: string | null }) => void;
  getDocument: () => SceneDocument | null;
  targetFrameId?: string | null;
  /**
   * Explicit user @ artboard (or @ node → containing frame).
   * Prefer this board for shimmer / tool_ops parent; Host never invents an empty plate.
   */
  pinnedFrameId?: string | null;
  onEvent: (ev: AgentStepEvent) => void;
  signal?: AbortSignal;
  /** Editor chrome bridge for zoom / panels / account Agent settings. */
  canvasUi?: CanvasUiBridge | null;
  /** Artboard shimmer pill copy (i18n from AgentDock). */
  processLabels?: {
    preparing?: string;
    thinking?: string;
    exploring?: string;
    editing?: string;
    reviewing?: string;
  } | null;
  /** Auto routing overrides from account prefs (null = platform). */
  routeOverrides?: Record<string, string> | null;
  /** Ask confirm: skip LLM and apply these ops (agent mode). */
  applyOps?: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }> | null;
  /** Ask confirm: bind to design_task.meta.ask_proposal. */
  proposalId?: string | null;
  proposalTaskId?: string | null;
  /** Board paint: ops (default) | img_layers (gen then split). */
  paintMode?: 'ops' | 'img_layers' | null;
  /** User-pinned skill keys/ids from `/` chips. */
  skillRefs?: string[] | null;
  /** UI locale for agent output language. */
  locale?: string | null;
  /** Design pipeline depth: light | medium | high | extreme. */
  designIntensity?: string | null;
  /** Resume a paused LangGraph run instead of starting a new /design/run. */
  resumeTaskId?: string | null;
  resumeToken?: string | null;
};

/** Map agent params → POST /design/run body (omit empty optional fields). */
function buildRunDesignJobBody(
  params: RunDesignAgentParams,
  runMode: DesignRunMode
): RunDesignJobBody {
  const body: RunDesignJobBody = {
    run_mode: runMode,
    prompt: params.userMessage,
    user_selected_model: params.model || 'auto',
  };
  if (params.interactionMode === 'ask' || params.interactionMode === 'agent') {
    body.interaction_mode = params.interactionMode;
  }
  if (params.paintMode === 'ops' || params.paintMode === 'img_layers') {
    body.paint_mode = params.paintMode;
  }
  if (runMode === 'agent' && params.scene) body.scene = params.scene;
  if (params.styleGroupId != null) body.style_group_id = params.styleGroupId;
  if (params.routeOverrides) body.route_overrides = params.routeOverrides;
  if (params.canvasId) body.canvas_id = params.canvasId;
  if (params.canvasSize) body.canvas_size = params.canvasSize;
  if (params.refImageSizes?.length) body.ref_image_sizes = params.refImageSizes;
  if (params.targetLayerId) body.target_layer_id = params.targetLayerId;
  if (params.layerIds) body.layer_ids = params.layerIds;
  if (params.currentSvg) body.current_svg = params.currentSvg;
  if (params.sceneNodes?.length) {
    body.scene_nodes = params.sceneNodes as Array<Record<string, unknown>>;
  }
  if (params.sceneFrames?.length) {
    body.scene_frames = params.sceneFrames as Array<Record<string, unknown>>;
  }
  if (params.spatialSummary) {
    body.spatial_summary = params.spatialSummary as unknown as Record<string, unknown>;
  }
  if (params.focusFrameId) body.focus_frame_id = params.focusFrameId;
  if (params.images?.length) body.images = params.images;
  if (params.sessionId) body.session_id = params.sessionId;
  if (params.projectId) body.project_id = params.projectId;
  if (params.memory) body.memory = params.memory;
  if (params.applyOps?.length) {
    body.apply_ops = params.applyOps as Array<Record<string, unknown>>;
  }
  if (params.proposalId) body.proposal_id = String(params.proposalId).trim();
  if (params.proposalTaskId) {
    body.proposal_task_id = String(params.proposalTaskId).trim();
  }
  if (params.skillRefs?.length) {
    body.skill_refs = params.skillRefs.map((x) => String(x).trim()).filter(Boolean);
  }
  if (params.locale) body.locale = String(params.locale).trim();
  if (params.designIntensity) {
    body.design_intensity = String(params.designIntensity).trim();
  }
  return body;
}

type LiveDrawState = {
  nodeIds: string[];
  frameId: string | null;
  fingerprintById: Record<string, string>;
};

type ActivityKind =
  | 'thought'
  | 'added'
  | 'updated'
  | 'explored'
  | 'skipped'
  | 'deleted'
  | 'tool';

function parseActivityKind(raw: unknown): ActivityKind {
  const k = String(raw || '').trim();
  if (
    k === 'thought' ||
    k === 'added' ||
    k === 'updated' ||
    k === 'explored' ||
    k === 'skipped' ||
    k === 'deleted' ||
    k === 'tool'
  ) {
    return k;
  }
  return 'tool';
}

function isDeveloperVisibility(raw: unknown): boolean {
  const v = String(raw || '')
    .trim()
    .toLowerCase();
  return v === 'developer' || v === 'internal' || v === 'debug';
}

function isInternalDesignDump(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^(DESIGN_[A-Z_]+|governance\s+(pass|fail)|EXPLAIN:|REPAIR:)/i.test(s);
}

function developerEventFromSse(
  kind: string,
  ev: Record<string, unknown>
): Extract<AgentStepEvent, { type: 'developer' }> {
  const text =
    String(ev.text || ev.summary || ev.detail || '').trim() ||
    (kind === 'design_governance'
      ? JSON.stringify(
          {
            status: ev.status,
            lanes: ev.lanes,
            explain: ev.explain,
            summary: ev.summary,
          },
          null,
          2
        ).slice(0, 2000)
      : '');
  return {
    type: 'developer',
    kind,
    text: text || undefined,
  };
}

function activityDetailParts(ev: {
  detail?: unknown;
  summary?: unknown;
  body?: unknown;
}): { detail: string; summaryRaw: string; body: string } {
  const detailRaw = String(ev.detail || '').trim();
  const summaryRaw = String(ev.summary || '').trim();
  const bodyRaw = String(ev.body || '').trim();
  const shortSummary =
    summaryRaw.length > 0 && summaryRaw.length <= 48 ? summaryRaw : '';
  const longSummary =
    summaryRaw.length > 48 ? summaryRaw : '';

  if (detailRaw) {
    const distinctShort =
      shortSummary && shortSummary !== detailRaw ? shortSummary : '';
    const bodyFromLong =
      longSummary && longSummary !== detailRaw ? longSummary : '';
    return {
      detail: detailRaw,
      // Keep a distinct short summary only; long copy belongs in body once.
      summaryRaw: distinctShort,
      body: bodyRaw || bodyFromLong,
    };
  }
  // No detail: short summary drives the label; long summary is body only (never both).
  if (shortSummary) {
    return { detail: shortSummary, summaryRaw: '', body: bodyRaw };
  }
  return {
    detail: '',
    summaryRaw: '',
    body: bodyRaw || summaryRaw,
  };
}

function activityItemPayload(item: {
  id?: unknown;
  name?: unknown;
  summary?: unknown;
} | null | undefined) {
  if (!item) return undefined;
  return {
    id: item.id ? String(item.id) : undefined,
    name: item.name ? String(item.name) : undefined,
    summary: item.summary ? String(item.summary) : undefined,
  };
}

function activityItemsPayload(
  items: unknown
): Array<{ id?: string; name?: string; summary?: string }> | undefined {
  if (!Array.isArray(items) || !items.length) return undefined;
  const out: Array<{ id?: string; name?: string; summary?: string }> = [];
  for (const row of items) {
    if (!row || typeof row !== 'object') continue;
    const mapped = activityItemPayload(
      row as { id?: unknown; name?: unknown; summary?: unknown }
    );
    if (mapped) out.push(mapped);
  }
  return out.length ? out : undefined;
}

function normalizeActivityStatusLocal(
  status: unknown
): 'running' | 'done' | 'error' {
  if (status === 'running') return 'running';
  if (status === 'error') return 'error';
  return 'done';
}

function bindExploredSceneActivity(opts: {
  chatDiverted: boolean;
  kind: unknown;
  stage: string;
  detail: string;
  pinnedFrameId?: string | null;
  live: LiveDrawState;
  getDocument: RunDesignAgentParams['getDocument'];
  shimmerFrameId: string | null;
  setProcessPill: (frameId: string, label: string) => void;
  exploringLabel: string;
  setLiveCanvasSize: (size: string) => void;
}): void {
  if (opts.chatDiverted || opts.kind !== 'explored') return;
  if (opts.stage !== 'scene' && !opts.detail.startsWith('canvas_size:')) return;
  if (opts.detail.startsWith('canvas_size:')) {
    const raw = opts.detail.replace(/^canvas_size:/i, '').trim().toLowerCase();
    if (/^\d+x\d+$/.test(raw)) opts.setLiveCanvasSize(raw);
  }
  const pinned = explicitPinnedFrameId({
    pinnedFrameId: opts.pinnedFrameId,
  });
  const focus = pinned || opts.live.frameId || null;
  if (!focus) return;
  const boardSize = frameSizeFromDoc(opts.getDocument, focus);
  if (boardSize) {
    opts.setLiveCanvasSize(`${boardSize.width}x${boardSize.height}`);
  }
  opts.live.frameId = focus;
  if (!opts.shimmerFrameId && !pinned) return;
  opts.setProcessPill(focus, opts.exploringLabel);
}

function refreshActivityProcessPill(opts: {
  pillFrame: string | null;
  status: unknown;
  kind: ActivityKind;
  setProcessPill: (frameId: string, label: string) => void;
  processLabels: {
    exploring?: string;
    thinking?: string;
    editing?: string;
    reviewing?: string;
  };
}): void {
  const { pillFrame, status, kind, setProcessPill, processLabels } = opts;
  if (!pillFrame || status === 'done') return;
  if (kind === 'explored') {
    setProcessPill(pillFrame, processLabels.exploring || 'Exploring…');
    return;
  }
  if (kind === 'thought') {
    setProcessPill(pillFrame, processLabels.thinking || 'Thinking…');
    return;
  }
  if (
    kind === 'tool' ||
    kind === 'added' ||
    kind === 'updated' ||
    kind === 'deleted'
  ) {
    setProcessPill(pillFrame, processLabels.editing || 'Editing elements…');
  }
}

export async function runDesignAgent(params: RunDesignAgentParams): Promise<void> {
  const runMode = params.runMode || 'agent';
  // Do NOT seed old-frame id/nodes until backend confirms edit_in_place.
  // Seeding early causes blank/create to resize the prior artboard instead of spawning a new one.
  const live: LiveDrawState = {
    nodeIds: [],
    frameId: null,
    fingerprintById: {},
  };

  const labels: string[] = [];
  const skillStartedAt = new Map<number, number>();
  const skillMeta = new Map<number, { category: string; name: string }>();

  let paintChain: Promise<void> = Promise.resolve();
  let painted = false;
  let pendingDone: {
    summary?: string;
    painted?: boolean;
    proposedOps?: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
    proposalId?: string;
    taskId?: string;
    choiceUi?: AskChoiceUi;
  } | null = null;
  let resultSummary = '';
  let lastPaintedSvg = '';
  let activitySeq = 0;
  /** Chat / session_control path — ignore Explored stage SSE after divert. */
  let chatDiverted = false;
  /** Client chip WxH — never let backend status rewrite it. */
  const lockedClientSize = parseLockedClientSize(params.canvasSize);
  let liveCanvasSize = lockedClientSize || params.canvasSize || null;
  /** Pre-draw grade=good refs actually attached to vision (activity UI). */
  /** Authoritative only after backend status.edit_in_place — never infer from local canvas. */
  let editInPlace = false;
  let toolOpsApplied = false;
  let blankArtboard = false;
  const appliedOpIdsRef = { current: new Set<string>() };
  /** Design Engine V3 — AIOperationQueue (one undo / one ACK per transaction). */
  const aiQueue = createAiOperationQueue();
  let latestMemory: TaskState | null = params.memory?.medium || null;
  let liveTaskId: string | null = null;
  let terminalErrorCode: string | null = null;
  let terminalErrorMessage: string | null = null;


  // Cover stays up through paint → review → reflect retry until settle/abort.
  const processLabels = params.processLabels || {};
  let shimmerFrameId: string | null = null;

  const setProcessPill = (frameId: string | null | undefined, label: string) => {
    if (!frameId) return;
    shimmerFrameId = frameId;
    markArtboardGenerating(frameId, label);
  };

  const clearProcessPill = () => {
    shimmerFrameId = null;
    clearArtboardGenerating();
  };

  /** Keep cover on the live board once canvas work has started (incl. edit-in-place). */
  const coverLiveBoard = (label: string) => {
    const id =
      shimmerFrameId ||
      live.frameId ||
      params.pinnedFrameId ||
      params.targetFrameId ||
      null;
    if (!id || blankArtboard) return;
    setProcessPill(id, label);
  };

  const shouldShimmerFrame = (frameId: string | null, edit: boolean): boolean => {
    if (!frameId) return false;
    if (!edit) return true;
    if (blankArtboard) return false;
    try {
      if (frameIsEmpty(params.getDocument(), frameId)) return true;
    } catch {
      /* ignore */
    }
    const nodes = params.sceneNodes || [];
    if (!nodes.length) return true;
    return !nodes.some((n) => {
      const fid = String((n as { frameId?: string }).frameId || '');
      return !fid || fid === frameId;
    });
  };

  const emitMemory = (patch: MemoryPatch | undefined, frameId: string | null) => {
    if (!params.onMemoryPatch) return;
    const hints = frameId ? { lastAgentFrameId: frameId } : {};
    if (patch?.medium) {
      const base = latestMemory || params.memory?.medium;
      if (base) {
        latestMemory = applyClientFrameHints(applyMemoryPatch(base, patch), {
          lastAgentFrameId: frameId || undefined,
          referent:
            blankArtboard && frameId
              ? { label: '新建的画布', frameId }
              : undefined,
        });
      }
      params.onMemoryPatch(patch, hints);
    } else if (frameId) {
      params.onMemoryPatch({ medium: {} }, hints);
    }
  };

  const paintCanvasSize = () => liveCanvasSize || params.canvasSize || null;

  /** SVG live-draw only: open a WxH plate when painting full SVG (not tool_ops). */
  const ensureCreateFrameReady = (): string | null => {
    if (editInPlace) {
      return live.frameId || params.targetFrameId || null;
    }
    if (live.frameId) return live.frameId;
    const resolved = parseResolvedSize(paintCanvasSize());
    if (!resolved) return null;
    const frameId = ensureFrameSize({
      getDocument: params.getDocument,
      frameId: null,
      width: resolved.width,
      height: resolved.height,
    });
    if (frameId) live.frameId = frameId;
    return frameId;
  };

  const activityKindForSkill = (
    category?: string,
    skillName?: string
  ): 'thought' | 'explored' | 'tool' | 'hidden' => {
    // Prefer structured `category` from backend — no Chinese/English name keyword lists.
    const cat = String(category || '').toLowerCase().trim();
    const name = String(skillName || '').toLowerCase().trim();
    if (cat === 'agent' || name === 'agent' || name === 'agent_loop') {
      return 'hidden';
    }
    if (cat === 'summary' || cat === 'execute' || cat === 'draw') {
      return 'hidden';
    }
    if (cat === 'plan' || cat === 'think' || cat === 'intent') {
      return 'thought';
    }
    if (cat === 'layout' || cat === 'validate' || cat === 'explore') {
      return 'explored';
    }
    // Unknown / execute / draw: backend SSE `activity` owns Tool call + op detail.
    return 'hidden';
  };

  const paintSvgProgressive = (
    svg: string,
    patch?: DesignSvgPatch | null,
    commandSeq?: number,
  ) => {
    // Edit path must only mutate via tool_ops — SVG live-draw stacks duplicate shapes.
    // Blank artboard: empty frame only — never paint invented SVG onto anything.
    if (editInPlace || toolOpsApplied || blankArtboard) return;
    const trimmed = svg?.trim();
    if (!trimmed) return;
    if (
      patch &&
      patch.mode === 'patch' &&
      patch.create_count === 0 &&
      patch.update_count === 0 &&
      patch.delete_count === 0
    ) {
      activitySeq += 1;
      params.onEvent({
        type: 'activity',
        id: `skip-${activitySeq}`,
        kind: 'skipped',
        status: 'done',
      });
      return;
    }
    if (trimmed === lastPaintedSvg) {
      activitySeq += 1;
      params.onEvent({
        type: 'activity',
        id: `skip-${activitySeq}`,
        kind: 'skipped',
        status: 'done',
      });
      return;
    }
    const prevPaint = paintChain;
    async function runPaintSvgProgressive() {
      await prevPaint;
      if (params.signal?.aborted) return;
      // Drop import placeholder only — keep artboard process cover until settle.
      cancelImportPlaceholder();
      const frameReady = ensureCreateFrameReady();
      if (!frameReady && !parseResolvedSize(paintCanvasSize())) {
        // Size still Auto — do not mark painted; allow retry after 设计思考 status.
        return;
      }
      coverLiveBoard(processLabels.editing || 'Editing elements…');
      lastPaintedSvg = trimmed;
      params.onEvent({ type: 'drawing', active: true, done: 0, total: 0 });
      try {
        const applied = await applyDesignSvgToDocumentProgressive({
          getDocument: params.getDocument,
          svg: trimmed,
          canvasSize: paintCanvasSize(),
          targetFrameId: live.frameId || params.targetFrameId,
          liveNodeIds: live.nodeIds,
          fingerprintById: live.fingerprintById,
          // Backend already decided full vs patch; honor full → wipe+recreate.
          forceFullReplace: patch?.mode === 'full' && live.nodeIds.length > 0,
          signal: params.signal,
          onProgress: (info) => {
            params.onEvent({
              type: 'drawing',
              active: true,
              done: info.done,
              total: info.total,
            });
          },
        });
        if (!applied.frameId) {
          lastPaintedSvg = '';
          return;
        }
        live.nodeIds = applied.nodeIds;
        live.frameId = applied.frameId;
        live.fingerprintById = applied.fingerprintById;
        acknowledgeAppliedDesignCommand(liveTaskId, commandSeq, params.signal).catch(
          (ackErr: unknown) => {
            params.onEvent({
              type: 'error',
              code: 'command_ack_failed',
              message:
                ackErr instanceof Error
                  ? ackErr.message
                  : String(ackErr || 'command acknowledgment failed'),
            });
          }
        );
        coverLiveBoard(processLabels.editing || 'Editing elements…');
        // Prefer backend patch counts when present (source of truth for "incremental").
        const created = patch ? patch.create_count : applied.created;
        const updated = patch ? patch.update_count : applied.updated;
        if (created > 0 || updated > 0) {
          painted = true;
          activitySeq += 1;
          params.onEvent({
            type: 'activity',
            id: `paint-${activitySeq}`,
            kind: created > 0 ? 'added' : 'updated',
            status: 'done',
            count: created + updated,
          });
        } else if (applied.unchanged > 0 || (patch && patch.total_next)) {
          activitySeq += 1;
          params.onEvent({
            type: 'activity',
            id: `skip-${activitySeq}`,
            kind: 'skipped',
            status: 'done',
          });
        } else {
          activitySeq += 1;
          params.onEvent({
            type: 'activity',
            id: `skip-${activitySeq}`,
            kind: 'skipped',
            status: 'done',
          });
        }
        params.onEvent({ type: 'svg_delta', svg: trimmed });
      } finally {
        params.onEvent({ type: 'drawing', active: false });
      }
    }
    paintChain = runPaintSvgProgressive();
  };

  const emitPhase = (currentIndex: number, category?: string) => {
    params.onEvent({
      type: 'phase',
      progress: {
        category: category || params.scene || 'design',
        labels: labels.length ? [...labels] : ['Design'],
        currentIndex,
        stepConfirm: false,
        collabMode: 'auto',
      },
    });
  };

  const handleStreamStatus = (ev: DesignStatusEvent) => {

    if (ev.task_id) {
      liveTaskId = String(ev.task_id);
      params.onEvent({ type: 'task', taskId: liveTaskId });
    }

    // Design: size resolved + needs a plate → open artboard + shimmer before content.
    // User @ board → bind + shimmer only (no second plate).
    // Host may send frame_id so paint/FOCUS and FE plate share one id.
    if (ev.open_artboard === true) {
      const sizeRaw =
        (ev.canvas_size && String(ev.canvas_size)) ||
        (ev.canvas_width != null && ev.canvas_height != null
          ? `${ev.canvas_width}x${ev.canvas_height}`
          : '');
      const size = /^\d+x\d+$/i.test(String(sizeRaw).trim())
        ? String(sizeRaw).trim().toLowerCase()
        : '';
      if (lockedClientSize) liveCanvasSize = lockedClientSize;
      else if (size) liveCanvasSize = size;
      const pinned = String(params.pinnedFrameId || '').trim() || null;
      if (pinned) {
        live.frameId = pinned;
        setProcessPill(pinned, processLabels.preparing || 'Preparing…');
        return;
      }
      const resolved = parseResolvedSize(liveCanvasSize);
      if (!resolved) return;
      live.nodeIds = [];
      live.fingerprintById = {};
      let hostFrameId =
        String(ev.frame_id || '').trim() || live.frameId || null;
      // Occupied ambient plate without user @ → sibling (do not rewrite old login).
      if (hostFrameId) {
        const docNow = params.getDocument();
        const exists = (Array.isArray(docNow?.frames) ? docNow.frames : []).some(
          (f) => f && String(f.id) === hostFrameId
        );
        if (exists && nodeIdsInsideFrame(docNow, hostFrameId).length > 0) {
          hostFrameId = null;
        }
      }
      const frameId = ensureFrameSize({
        getDocument: params.getDocument,
        frameId: hostFrameId,
        width: resolved.width,
        height: resolved.height,
      });
      if (frameId) {
        live.frameId = frameId;
        setProcessPill(frameId, processLabels.preparing || 'Preparing…');
      }
      return;
    }

    const sizeRaw =
      (ev.canvas_size && String(ev.canvas_size)) ||
      (ev.canvas_width != null && ev.canvas_height != null
        ? `${ev.canvas_width}x${ev.canvas_height}`
        : '');
    const size = /^\d+x\d+$/i.test(String(sizeRaw).trim())
      ? String(sizeRaw).trim().toLowerCase()
      : '';
    if (size || lockedClientSize) {
      // User chip wins — backend must not resize the live artboard.
      liveCanvasSize = lockedClientSize || size.toLowerCase();
      if (typeof ev.edit_in_place === 'boolean') {
        editInPlace = ev.edit_in_place;
      }
      if (ev.blank_artboard === true || ev.intent === 'blank') {
        blankArtboard = true;
      }
      if (editInPlace) {
        // Force rebind to the user's target — don't keep a sibling spawned
        // by an earlier provisional create status.
        live.frameId = params.targetFrameId || live.frameId || null;
        if (!live.nodeIds.length && params.seedLiveNodeIds?.length) {
          live.nodeIds = [...params.seedLiveNodeIds].filter(Boolean);
        }
      } else {
        // New artboard / blank — never mutate prior poster nodes.
        // Keep live.frameId only if this run already opened one (repeat status events).
        live.nodeIds = [];
        live.fingerprintById = {};
        // Provisional edit status may have bound the user's @ target; create/sibling must spawn new.
        if (
          live.frameId &&
          params.targetFrameId &&
          live.frameId === params.targetFrameId
        ) {
          live.frameId = null;
        }
      }
      const resolved = parseResolvedSize(liveCanvasSize);
      // Auto / partial-auto: wait for 设计思考 before opening a stock WxH plate.
      // edit_in_place without resolved size: bind only — never resize to 1440×900.
      let frameId: string | null = null;
      if (editInPlace) {
        frameId = live.frameId || params.targetFrameId || null;
        if (frameId && resolved) {
          frameId = ensureFrameSize({
            getDocument: params.getDocument,
            frameId,
            width: resolved.width,
            height: resolved.height,
          });
        }
      } else if (resolved) {
        // Only resize an artboard this run already opened.
        // Do NOT spawn a stock WxH plate from early status — chat
        // ("你好") shares the same status event and must not create canvas.
        if (live.frameId) {
          frameId = ensureFrameSize({
            getDocument: params.getDocument,
            frameId: live.frameId,
            width: resolved.width,
            height: resolved.height,
          });
        }
      }
      if (frameId) {
        live.frameId = frameId;
        // Placeholder only — process cover stays through the whole run.
        cancelImportPlaceholder();
        if (blankArtboard) {
          painted = true;
        } else if (shouldShimmerFrame(frameId, editInPlace) || shimmerFrameId) {
          setProcessPill(
            frameId,
            processLabels.preparing || 'Preparing…'
          );
        }
      }
      params.onEvent({
        type: 'canvas',
        size: liveCanvasSize,
        scene: ev.scene ? String(ev.scene) : undefined,
      });
    }
    emitPhase(0, ev.scene || params.scene || 'design');
    return;
    
  };

  const handleStreamSkillStart = (ev: DesignSkillStartEvent) => {

    const name = ev.skill_name || `Step ${ev.index + 1}`;
    while (labels.length <= ev.index) labels.push(`Step ${labels.length + 1}`);
    labels[ev.index] = name;
    if (!skillStartedAt.has(ev.index)) {
      skillStartedAt.set(ev.index, Date.now());
    }
    skillMeta.set(ev.index, {
      category: String(ev.category || ''),
      name,
    });
    const kind = activityKindForSkill(ev.category, name);
    const skillKey = String(ev.skill_key || '').toLowerCase();
    const isReviewSkill =
      skillKey === 'review' ||
      String(ev.category || '').toLowerCase() === 'critique' ||
      /review/i.test(name);
    if (isReviewSkill) {
      coverLiveBoard(
        processLabels.reviewing ||
          processLabels.editing ||
          'Reviewing design…'
      );
    }
    if (kind !== 'hidden') {
      params.onEvent({
        type: 'activity',
        id: `skill-${ev.index}`,
        kind,
        status: 'running',
        skillName: name,
      });
    }
    if (kind === 'thought' && shimmerFrameId) {
      setProcessPill(shimmerFrameId, processLabels.thinking || 'Thinking…');
    }
    emitPhase(ev.index, ev.category || params.scene || 'design');
    return;
    
  };

  const handleStreamSkillProgress = (ev: DesignSkillProgressEvent) => {

    const meta = skillMeta.get(ev.index);
    const kind = activityKindForSkill(
      meta?.category || '',
      ev.skill_name || meta?.name || ''
    );
    if (kind === 'hidden') return;
    // Status only — do not invent progress copy; backend text streams elsewhere.
    params.onEvent({
      type: 'activity',
      id: `skill-${ev.index}`,
      kind,
      status: 'running',
      skillName: ev.skill_name || meta?.name,
    });
    return;
    
  };

  const handleStreamActivity = (ev: DesignActivityEvent) => {
    // Backend-authored progress (counts / detail) — do not invent on the client.
    if (chatDiverted && (ev.kind === 'explored' || ev.kind === 'thought')) {
      return;
    }
    if (isDeveloperVisibility((ev as { visibility?: string }).visibility)) {
      params.onEvent(
        developerEventFromSse('activity', ev as unknown as Record<string, unknown>)
      );
      return;
    }
    const stage = ev.stage ? String(ev.stage) : '';
    let { detail, summaryRaw, body: activityBody } = activityDetailParts(ev);
    // Drop internal English DESIGN_* dumps that used to become row labels.
    if (isInternalDesignDump(detail)) detail = '';
    if (isInternalDesignDump(summaryRaw)) summaryRaw = '';
    if (isInternalDesignDump(activityBody)) activityBody = '';
    // Bind an existing @ / focus board for shimmer — never spawn an empty artboard.
    bindExploredSceneActivity({
      chatDiverted,
      kind: ev.kind,
      stage,
      detail,
      pinnedFrameId: params.pinnedFrameId,
      live,
      getDocument: params.getDocument,
      shimmerFrameId,
      setProcessPill,
      exploringLabel: processLabels.exploring || 'Exploring…',
      setLiveCanvasSize: (size) => {
        liveCanvasSize = size;
      },
    });
    const kind = parseActivityKind(ev.kind);
    const actStatus = normalizeActivityStatusLocal(ev.status);
    params.onEvent({
      type: 'activity',
      id: String(ev.id || `activity-${activitySeq++}`),
      kind,
      status: actStatus,
      count: typeof ev.count === 'number' ? ev.count : undefined,
      detail: detail || undefined,
      summary: summaryRaw || undefined,
      skillName: ev.skillName || ev.skill_name || undefined,
      durationSec: typeof ev.durationSec === 'number' ? ev.durationSec : undefined,
      stage: stage || undefined,
      code: ev.code ? String(ev.code) : undefined,
      item: activityItemPayload(ev.item),
      items: activityItemsPayload(ev.items),
      body: activityBody || undefined,
    });
    refreshActivityProcessPill({
      pillFrame: shimmerFrameId,
      status: ev.status,
      kind,
      setProcessPill,
      processLabels,
    });
  };

  const undoQueuedTransaction = (shouldUndo: boolean) => {
    if (!shouldUndo) return;
    try {
      undo();
    } catch {
      /* ignore */
    }
  };

  let aiMutationLocked = false;
  const sceneRevisionNow = (): number => {
    try {
      return Math.max(0, Number(store.getState().editor?.sceneRevision) || 0);
    } catch {
      return 0;
    }
  };
  const ensureAiMutationLock = () => {
    if (aiMutationLocked) return;
    beginAiSceneMutation();
    aiMutationLocked = true;
  };
  const releaseAiMutationLock = () => {
    if (!aiMutationLocked) return;
    endAiSceneMutation();
    aiMutationLocked = false;
  };

  const handleStreamTransactionBegin = (ev: DesignTransactionBeginEvent) => {
    const tid = String(ev.transaction_id || '').trim();
    if (!tid) return;
    const incoming = Math.max(0, Number(ev.base_revision) || 0);
    aiQueueBegin(aiQueue, {
      transactionId: tid,
      phase: ev.phase,
      baseRevision: incoming > 0 ? incoming : sceneRevisionNow(),
    });
    ensureAiMutationLock();
    const prev = store.getState().editor.aiOperationState;
    if (prev?.active) {
      setAiOperationState({ ...prev, transactionId: tid });
    }
  };

  const handleStreamTransactionCommit = (ev: DesignTransactionCommitEvent) => {
    const tid = String(ev.transaction_id || '').trim();
    if (!tid) return;
    aiQueueCommit(aiQueue, tid);
    releaseAiMutationLock();
  };

  const handleStreamTransactionRollback = (ev: DesignTransactionRollbackEvent) => {
    const tid = String(ev.transaction_id || '').trim();
    if (!tid) return;
    undoQueuedTransaction(aiQueueRollback(aiQueue, tid));
    releaseAiMutationLock();
  };

  const handleStreamToolOps = (ev: DesignToolOpsEvent) => {

    const ops = Array.isArray(ev.ops) ? ev.ops : [];
    if (!ops.length) return;
    const deleteish = ops.filter((o: { name?: string }) =>
      ['delete_frame', 'delete_nodes'].includes(String(o?.name || '').trim())
    );
    const txId = String(ev.transaction_id || aiQueue.transactionId || '').trim();
    if (txId) aiQueueBindTransaction(aiQueue, txId);
    if (!aiQueueEnqueue(aiQueue, ops)) return;
    const prevPaint = paintChain;
    async function drainQueuedToolOps() {
      await prevPaint;
      while (true) {
        if (params.signal?.aborted) {
          undoQueuedTransaction(aiQueueCancel(aiQueue));
          releaseAiMutationLock();
          return;
        }
        const chunk = aiQueueTakeChunk(aiQueue);
        if (!chunk) return;
        const chunkTxId = String(aiQueue.transactionId || txId || '').trim();
        params.onEvent({ type: 'drawing', active: true, done: 0, total: chunk.length });
        const pinned = explicitPinnedFrameId({
          pinnedFrameId: params.pinnedFrameId,
        });
        const createFrameCount = chunk.filter(
          (o: { name?: string }) => String(o?.name || '').trim() === 'create_frame'
        ).length;
        const multiArtboards = createFrameCount >= 2;
        const aiCreatesFrame = createFrameCount > 0;
        // Host may already have opened a plate via open_artboard (create_frame stripped).
        // Bind into that live plate — do not inherit ambient FOCUS alone.
        const bindToBoard = Boolean(
          pinned || aiCreatesFrame || editInPlace || live.frameId
        );

        // Single-plate fallback if backend did not emit open_artboard.
        // Multi create_frame: do not pre-open — applyAgentToolOps retargets after each plate.
        // When live.frameId is set (host shimmer), never spawn a second blank cover.
        if (
          !pinned &&
          !live.frameId &&
          aiCreatesFrame &&
          !editInPlace &&
          !multiArtboards
        ) {
          const fromOp = sizeFromCreateFrameOp(chunk);
          const resolved =
            parseResolvedSize(paintCanvasSize()) ||
            fromOp ||
            null;
          if (resolved) {
            if (!parseResolvedSize(paintCanvasSize())) {
              liveCanvasSize = `${resolved.width}x${resolved.height}`;
            }
            const opened = ensureFrameSize({
              getDocument: params.getDocument,
              frameId: null,
              width: resolved.width,
              height: resolved.height,
            });
            if (opened) live.frameId = opened;
          }
        }

        // Host already opened one plate → drop model create_frame (avoid duplicate).
        // Multi-artboard batches keep every create_frame so sibling boards are created.
        let paintOps = chunk;
        if (!multiArtboards && (live.frameId || pinned)) {
          paintOps = chunk.filter((o) => String(o?.name || '').trim() !== 'create_frame');
        }

        const frameId = !multiArtboards && bindToBoard
          ? resolveToolOpsFrameId({
                editInPlace,
                liveFrameId: live.frameId,
                targetFrameId: params.targetFrameId,
                pinnedFrameId: params.pinnedFrameId,
              })
          : null;
        if (frameId) {
          live.frameId = frameId;
          // Cover through tool_ops → observe → review → reflect (not only blank boards).
          coverLiveBoard(processLabels.editing || 'Editing elements…');
        }
        const skipHistoryPush = aiQueueShouldSkipHistory(aiQueue, chunkTxId);
        ensureAiMutationLock();
        try {
          const applied = await applyAgentToolOps({
            ops: paintOps,
            getDocument: params.getDocument,
            frameId,
            signal: params.signal,
            // Create has no prior nodes — don't rewrite create_shape against old bg.
            sceneNodes: editInPlace ? params.sceneNodes : null,
            userImages: params.images,
            appliedOpIds: appliedOpIdsRef.current,
            canvasUi: params.canvasUi,
            skipHistoryPush,
            source: 'ai',
            transactionId: chunkTxId || undefined,
            baseRevision: aiQueue.baseRevision,
            currentRevision: sceneRevisionNow(),
            onProgress: (info) => {
              params.onEvent({
                type: 'drawing',
                active: true,
                done: info.done,
                total: info.total,
              });
            },
          });
          // The host can create the target artboard before its matching
          // create_frame command arrives. Record that as an explicit receipt
          // instead of leaving the server to treat the operation as missing.
          const hostHandledResults: ToolOpResult[] = chunk
            .filter((op) => !paintOps.includes(op))
            .map((op) => {
              const name = String(op.name || '').trim();
              const args = op.args && typeof op.args === 'object' ? op.args : {};
              return {
                op_id: String(op.op_id || '').trim(),
                name,
                ok: Boolean(live.frameId),
                ...(live.frameId ? {} : { error: 'host_frame_unavailable' }),
                operation: operationKind(name),
                expected_node_ids: expectedNodeIds(args),
                actual_node_ids: live.frameId ? [live.frameId] : [],
              };
            });
          const receiptResults = [...applied.opResults, ...hostHandledResults];
          aiQueueMarkApplied(aiQueue, {
            historyPushed: applied.historyPushed,
            opResults: receiptResults,
          });
          if (applied.revisionAction === 'rebase') {
            activitySeq += 1;
            params.onEvent({
              type: 'activity',
              id: `rebase-${activitySeq}`,
              kind: 'tool',
              status: 'done',
              code: 'canvas_rebased',
            });
          }
          if (applied.opResults.some((r) => r.error === 'revision_conflict')) {
            undoQueuedTransaction(aiQueueRollback(aiQueue, chunkTxId));
            releaseAiMutationLock();
            activitySeq += 1;
            params.onEvent({
              type: 'activity',
              id: `opfail-${activitySeq}`,
              kind: 'skipped',
              status: 'error',
              code: 'revision_conflict',
            });
            return;
          }
          const overlay = overlayFromToolOps({
            ops: paintOps,
            frameId: applied.frameId || frameId,
            transactionId: chunkTxId || undefined,
            appliedNodeIds: applied.nodeIds,
          });
          if (overlay.frameId) {
            markArtboardGenerating(
              overlay.frameId,
              overlay.label,
              {
                transactionId: overlay.transactionId,
                nodeId: overlay.nodeId,
                action: overlay.action,
              }
            );
          }
          const failures = receiptResults.filter((r) => !r.ok);
          if (failures.length) {
            // Correct the backend's pre-emitted counts — user must see the truth.
            activitySeq += 1;
            params.onEvent({
              type: 'activity',
              id: `opfail-${activitySeq}`,
              kind: 'skipped',
              status: 'error',
              count: failures.length,
              detail: `${failures.length} op(s) not applied: ${failures[0].error || 'target missing'}`,
            });
          }
          const anyOk = receiptResults.some((r) => r.ok);
          if (hasCompleteOperationReceipts(chunk, receiptResults)) {
            acknowledgeAppliedDesignCommand(
              liveTaskId,
              ev.command_seq,
              params.signal
            ).catch((ackErr: unknown) => {
              params.onEvent({
                type: 'error',
                code: 'command_ack_failed',
                message:
                  ackErr instanceof Error
                    ? ackErr.message
                    : String(ackErr || 'command acknowledgment failed'),
              });
            });
          }
          toolOpsApplied = true;
          painted = painted || anyOk;
          if (applied.frameId && bindToBoard) {
            live.frameId = applied.frameId;
          }
          if (applied.nodeIds.length) {
            live.nodeIds = [...new Set([...live.nodeIds, ...applied.nodeIds])];
          }
          // Keep cover for review / reflect retries after paint lands.
          if (live.frameId && (aiCreatesFrame || editInPlace || anyOk || shimmerFrameId)) {
            coverLiveBoard(processLabels.editing || 'Editing elements…');
          }
          if (params.signal?.aborted) {
            undoQueuedTransaction(aiQueueCancel(aiQueue));
            releaseAiMutationLock();
            return;
          }
        } catch (err) {
          params.onEvent({
            type: 'error',
            code: 'tool_ops_apply_failed',
            message: err instanceof Error ? err.message : String(err || 'tool ops apply failed'),
          });
          undoQueuedTransaction(aiQueueRollback(aiQueue, chunkTxId));
          releaseAiMutationLock();
          return;
        } finally {
          params.onEvent({
            type: 'drawing',
            active: false,
            done: chunk.length,
            total: chunk.length,
          });
        }
      }
    }
    paintChain = drainQueuedToolOps();
    return;
    
  };

  const handleStreamSceneFeedback = (ev: DesignSceneFeedbackEvent) => {

    const taskId = String(ev.task_id || liveTaskId || '').trim();
    const round = typeof ev.round === 'number' ? ev.round : undefined;
    const feedbackTxId = String(
      ev.transaction_id || aiQueue.transactionId || ''
    ).trim();
    if (!taskId) return;
    // Wait until pending paints land, then POST real inventory via scene feedback.
    const prevPaint = paintChain;
    async function runSceneFeedbackAfterPaint() {
      await prevPaint;
      if (params.signal?.aborted) {
        undoQueuedTransaction(aiQueueCancel(aiQueue));
        releaseAiMutationLock();
        return;
      }
      // Let store (+ collab Y push) settle before snapshot — avoids empty-board false critique.
      await waitSceneInventorySettled(params.getDocument, { timeoutMs: 480, stableFrames: 2 });
      if (params.signal?.aborted) {
        undoQueuedTransaction(aiQueueCancel(aiQueue));
        releaseAiMutationLock();
        return;
      }
      coverLiveBoard(
        processLabels.reviewing ||
          processLabels.editing ||
          'Reviewing design…'
      );
      const docNow = params.getDocument();
      const nodes = buildSceneNodesForCanvas(docNow, {
        focusFrameId: live.frameId || params.targetFrameId || null,
        forceIds: live.nodeIds,
      });
      const frames = buildSceneFramesSnapshot(docNow);
      const focusId = live.frameId || params.targetFrameId || null;
      const vp = params.canvasUi?.getViewportSceneBounds?.() || null;
      const spatial = buildSpatialSummary(docNow, {
        focusFrameId: focusId,
        viewport: vp
          ? { x: vp.x, y: vp.y, w: vp.width, h: vp.height }
          : null,
      });
      const opResults = aiQueueFlushResults(aiQueue);
      let previewImage = null;
      try {
        previewImage = await captureCritiquePreview(docNow, focusId);
      } catch {
        previewImage = null;
      }
      const txStatus = aiQueueAckStatus(aiQueue);
      const feedback: Parameters<typeof postDesignSceneFeedback>[1] = {
        scene_nodes: nodes as Array<Record<string, unknown>>,
        spatial_summary: spatial as unknown as Record<string, unknown>,
        round,
      };
      if (frames.length) feedback.scene_frames = frames as Array<Record<string, unknown>>;
      if (opResults.length) feedback.op_results = opResults;
      if (previewImage) feedback.preview_image = previewImage;
      if (feedbackTxId) {
        feedback.transaction_id = feedbackTxId;
        feedback.transaction_status = txStatus;
        if (aiQueue.baseRevision) feedback.base_revision = aiQueue.baseRevision;
      }
      const retryDelaysMs = [0, 750, 2_000];
      let feedbackSent = false;
      for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        if (params.signal?.aborted) return;
        if (retryDelaysMs[attempt]) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, retryDelaysMs[attempt]));
        }
        try {
          await postDesignSceneFeedback(taskId, feedback, params.signal);
          feedbackSent = true;
          break;
        } catch {
          // The next attempt keeps the durable graph from waiting on a transient
          // client/network failure. The final failure is surfaced below.
        }
      }
      activitySeq += 1;
      params.onEvent({
        type: 'activity',
        id: `scene-feedback-${activitySeq}`,
        kind: feedbackSent ? 'explored' : 'skipped',
        status: feedbackSent ? 'done' : 'error',
        code: feedbackSent ? 'scene_feedback_ok' : 'scene_feedback_failed',
        stage: 'scene_check',
      });
    }
    paintChain = runSceneFeedbackAfterPaint();
    return;
    
  };

  const handleStreamSkillDone = (ev: DesignSkillDoneEvent) => {

    if (ev.analysis) params.onEvent({ type: 'analysis', text: ev.analysis });
    const meta = skillMeta.get(ev.index);
    const kind = activityKindForSkill(
      meta?.category || '',
      ev.skill_name || meta?.name || ''
    );
    if (kind !== 'hidden') {
      const started = skillStartedAt.get(ev.index);
      const durationSec = started
        ? Math.max(1, Math.round((Date.now() - started) / 1000))
        : undefined;
      params.onEvent({
        type: 'activity',
        id: `skill-${ev.index}`,
        kind,
        status: 'done',
        skillName: ev.skill_name || meta?.name,
        ...(kind === 'thought' && durationSec != null ? { durationSec } : {}),
      });
    }
    if (ev.preview_svg && !toolOpsApplied) {
      paintSvgProgressive(ev.preview_svg, ev.svg_patch);
    }
    emitPhase(ev.index + 1, params.scene || 'design');
    return;
    
  };

  const handleStreamResult = (ev: DesignResultEvent) => {

    const size =
      (ev.canvas_size && String(ev.canvas_size)) ||
      (ev.canvas_width != null && ev.canvas_height != null
        ? `${ev.canvas_width}x${ev.canvas_height}`
        : '');
    if (lockedClientSize) {
      liveCanvasSize = lockedClientSize;
    } else if (size) {
      liveCanvasSize = size.toLowerCase();
    }
    if (ev.blank_artboard === true) {
      blankArtboard = true;
      painted = true;
      cancelImportPlaceholder();
    }
    // Blank / edit tool-ops: no SVG paint. Create/sibling: paint onto new frame only.
    if (ev.svg && !(toolOpsApplied || Boolean(ev.tool_ops_applied) || blankArtboard)) {
      if (!editInPlace) {
        live.nodeIds = [];
        live.fingerprintById = {};
      }
      paintSvgProgressive(ev.svg, ev.svg_patch);
    }
    if (ev.summary) resultSummary = ev.summary;
    if (String(ev.status || '').toLowerCase() !== 'success') {
      const fromApi = String((ev as { error_code?: string }).error_code || '').trim();
      const tipFromSummary = (() => {
        const s = String(resultSummary || '').trim();
        if (s === 'Decision failed. Please try again.') return 'decide_failed';
        if (s.startsWith('Could not produce valid canvas ops')) return 'paint_failed';
        if (s.startsWith('Canvas feedback timed out')) return 'observe_scene_timeout';
        if (s.startsWith('Canvas structure check failed')) return 'observe_critique_failed';
        if (s.startsWith('Some ops failed to apply')) return 'observe_ops_failed';
        if (s.startsWith('Review did not pass')) return 'review_must_fix';
        return '';
      })();
      terminalErrorCode = fromApi || tipFromSummary || 'design_failed';
      terminalErrorMessage = String(resultSummary || '').trim() || null;
      params.onEvent({
        type: 'activity',
        id: `result-error-${activitySeq++}`,
        kind: 'skipped',
        status: 'error',
        detail: resultSummary || undefined,
        // Prefer tip/error codes so the process column can i18n (English summary is fallback only).
        code: terminalErrorCode,
        stage: 'scene_check',
      });
      return;
    }
    let resultProposed:
      | Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>
      | undefined;
    if (Array.isArray(ev.proposed_ops) && ev.proposed_ops.length) {
      resultProposed = ev.proposed_ops
        .filter((o) => o && typeof o === 'object')
        .map((o) => ({
          name: o.name,
          args: o.args && typeof o.args === 'object' ? o.args : {},
          ...(o.op_id ? { op_id: String(o.op_id) } : {}),
        }))
        .slice(0, 80);
    }
    const choiceUi = normalizeChoiceUi(ev.choice_ui);
    const proposalId = String(ev.proposal_id || '').trim() || undefined;
    const resultTaskId = String(ev.task_id || '').trim() || undefined;
    emitPhase(Math.max(labels.length, 1), ev.scene || params.scene || 'design');
    pendingDone = {
      summary: resultSummary,
      painted:
        painted ||
        toolOpsApplied ||
        Boolean(ev.tool_ops_applied) ||
        blankArtboard,
      proposedOps: resultProposed?.length ? resultProposed : undefined,
      proposalId,
      taskId: resultTaskId,
      choiceUi,
    };
    emitMemory(
      undefined,
      live.frameId || params.targetFrameId || null
    );
    return;
    
  };

  try {
    const onStreamEvent = (ev: DesignJobEvent) => {
      switch (ev.type) {
        case 'status':
          handleStreamStatus(ev);
          return;
        case 'permission': {
          // End empty Thinking pill; do NOT divert to chat-only when LLM may run.
          clearProcessPill();
          if (!ev.can_call_llm) {
            chatDiverted = true;
            pendingDone = { summary: '', painted: false };
          }
          params.onEvent({
            type: 'permission',
            can_call_llm: Boolean(ev.can_call_llm),
            balance: ev.balance,
            need: ev.need,
            free_daily: ev.free_daily,
          });
          return;
        }
        case 'thinking':
          if (ev.text) {
            params.onEvent({
              type: 'thinking',
              text: ev.text,
              ...(ev.replace ? { replace: true } : {}),
            });
          }
          return;
        case 'token':
          if (ev.code || ev.text) {
            params.onEvent({
              type: 'token',
              ...(ev.text ? { text: ev.text } : {}),
              ...(ev.code ? { code: String(ev.code) } : {}),
              ...(ev.params && typeof ev.params === 'object'
                ? { params: ev.params as Record<string, string> }
                : {}),
            });
          }
          return;
        case 'session_control': {
          const action = String((ev as { action?: string }).action || '').trim();
          if (action) {
            params.onEvent({ type: 'session_control', action });
          }
          return;
        }
        case 'chat_done': {
          // Ask proposals also finish without paint — do NOT wipe proposedOps / choiceUi.
          if (pendingDone?.proposedOps?.length) return;
          // Model returned reply-only — clear Thought / Explored chrome.
          chatDiverted = true;
          pendingDone = {
            summary: pendingDone?.summary || resultSummary || '',
            painted: false,
            choiceUi: pendingDone?.choiceUi,
          };
          params.onEvent({ type: 'chat' });
          return;
        }
        case 'analysis_delta':
          if (isDeveloperVisibility((ev as { visibility?: string }).visibility)) {
            params.onEvent(
              developerEventFromSse(
                'analysis_delta',
                ev as unknown as Record<string, unknown>
              )
            );
            return;
          }
          if (ev.text && !isInternalDesignDump(ev.text)) {
            params.onEvent({ type: 'analysis_delta', text: ev.text });
          }
          return;
        case 'analysis':
          if (ev.text) params.onEvent({ type: 'analysis', text: ev.text });
          return;
        case 'skill_start':
          handleStreamSkillStart(ev);
          return;
        case 'skill_progress':
          handleStreamSkillProgress(ev);
          return;
        case 'activity':
          if (isDeveloperVisibility((ev as { visibility?: string }).visibility)) {
            params.onEvent(
              developerEventFromSse(
                'activity',
                ev as unknown as Record<string, unknown>
              )
            );
            return;
          }
          handleStreamActivity(ev);
          return;
        case 'design_governance': {
          if (isDeveloperVisibility((ev as { visibility?: string }).visibility)) {
            params.onEvent(
              developerEventFromSse(
                'design_governance',
                ev as unknown as Record<string, unknown>
              )
            );
            return;
          }
          const row = ev as {
            status?: string;
            skipped?: boolean;
            lanes?: Array<{ lane?: string; status?: string; message?: string }>;
            explain?: string[];
          };
          params.onEvent({
            type: 'intelligence',
            patch: {
              governance: {
                status: String(row.status || '').trim() || undefined,
                skipped: Boolean(row.skipped) || undefined,
                lanes: Array.isArray(row.lanes) ? row.lanes : undefined,
                explain: Array.isArray(row.explain) ? row.explain : undefined,
              },
            },
          });
          return;
        }
        case 'tool_ops':
          handleStreamToolOps(ev);
          return;
        case 'transaction.begin':
          handleStreamTransactionBegin(ev);
          return;
        case 'transaction.chunk':
          // Apply paint ops from the transaction chunk (kernel no longer emits a
          // companion `tool_ops` event for the same batch).
          handleStreamToolOps(ev);
          return;
        case 'transaction.commit':
          handleStreamTransactionCommit(ev);
          return;
        case 'transaction.rollback':
          handleStreamTransactionRollback(ev);
          return;
        case 'scene_feedback_request':
          handleStreamSceneFeedback(ev);
          return;
        case 'skill_done':
          handleStreamSkillDone(ev);
          return;
        case 'svg_delta':
          if (!toolOpsApplied) paintSvgProgressive(ev.svg, ev.svg_patch, ev.command_seq);
          if (typeof ev.index === 'number') emitPhase(ev.index + 1, params.scene || 'design');
          return;
        case 'critique_start': {
          const row = ev as {
            round: number;
            source?: string;
            agent?: string;
          };
          const isReview = row.source === 'review_agent' || row.agent === 'review';
          const label = isReview ? `Review ${row.round}` : `Critique ${row.round}`;
          if (!labels.includes(label)) labels.push(label);
          params.onEvent({
            type: 'activity',
            id: `critique-${row.round}`,
            kind: 'tool',
            status: 'running',
            detail: isReview ? 'Review Agent' : undefined,
          });
          coverLiveBoard(
            processLabels.reviewing ||
              processLabels.editing ||
              'Reviewing design…'
          );
          emitPhase(Math.max(0, labels.length - 1), 'critique');
          return;
        }
        case 'critique_done': {
          const marketGap = String(ev.market_gap || '').trim();
          const weaknesses = Array.isArray(ev.weaknesses)
            ? ev.weaknesses.map((w) => String(w || '').trim()).filter(Boolean)
            : [];
          const tasteDetail =
            marketGap ||
            (weaknesses.length ? String(weaknesses[0]) : '') ||
            (ev.ok === false && Array.isArray(ev.issues) && ev.issues.length
              ? String(ev.issues[0] || '')
              : '');
          let critiqueDetail: string | undefined;
          if (tasteDetail) critiqueDetail = tasteDetail.slice(0, 120);
          else if (ev.source === 'review_agent') critiqueDetail = 'Review Agent';
          params.onEvent({
            type: 'activity',
            id: `critique-${ev.round}`,
            kind: ev.ok === false ? 'skipped' : 'tool',
            status: 'done',
            detail: critiqueDetail,
          });
          const scores =
            ev.scores && typeof ev.scores === 'object'
              ? (ev.scores as Record<string, number>)
              : undefined;
          const visualDiff =
            ev.visual_diff && typeof ev.visual_diff === 'object'
              ? ev.visual_diff
              : null;
          let overall: number | null = null;
          if (typeof ev.overall === 'number') overall = ev.overall;
          else if (typeof ev.total === 'number') overall = ev.total;
          const strengths = Array.isArray(ev.strengths)
            ? ev.strengths.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4)
            : [];
          const nextFromIssues = Array.isArray(ev.top_issues)
            ? ev.top_issues
                .map((row) => {
                  if (!row || typeof row !== 'object') return '';
                  const fix = String((row as { fix?: unknown }).fix || '').trim();
                  const issue = String((row as { issue?: unknown }).issue || '').trim();
                  return fix || issue;
                })
                .filter(Boolean)
                .slice(0, 5)
            : [];
          if (
            scores ||
            overall != null ||
            Array.isArray(ev.top_issues) ||
            strengths.length ||
            weaknesses.length ||
            marketGap
          ) {
            params.onEvent({
              type: 'intelligence',
              patch: {
                review: {
                  overall,
                  action: String(ev.review_action || '').trim() || undefined,
                  scores,
                  lanes: Array.isArray(ev.lanes) ? ev.lanes : undefined,
                  topIssues: Array.isArray(ev.top_issues) ? ev.top_issues : undefined,
                },
                summary: {
                  strengths: strengths.length ? strengths : undefined,
                  weaknesses: weaknesses.length ? weaknesses.slice(0, 4) : undefined,
                  marketGap: marketGap || undefined,
                  nextSteps: nextFromIssues.length ? nextFromIssues : undefined,
                },
                diff: visualDiff
                  ? {
                      deltas:
                        visualDiff.deltas && typeof visualDiff.deltas === 'object'
                          ? visualDiff.deltas
                          : undefined,
                      visualChange:
                        visualDiff.visual_change &&
                        typeof visualDiff.visual_change === 'object'
                          ? visualDiff.visual_change
                          : undefined,
                      pixelAvailable: Boolean(visualDiff.pixel_available),
                    }
                  : undefined,
                iterations:
                  overall != null
                    ? [
                        {
                          iteration: Number(ev.round) || 0,
                          overall: Number(overall),
                          decision: String(ev.review_action || '').trim() || undefined,
                        },
                      ]
                    : undefined,
              },
            });
          }
          emitPhase(labels.length, 'critique');
          return;
        }
        case 'reference_intel': {
          const dna =
            ev.visual_dna && typeof ev.visual_dna === 'object'
              ? (ev.visual_dna as Record<string, number>)
              : undefined;
          params.onEvent({
            type: 'activity',
            id: 'reference-intel',
            kind: 'explored',
            status: 'done',
            detail: String(ev.thesis || ev.composition || 'Reference DNA').slice(0, 120),
          });
          params.onEvent({
            type: 'intelligence',
            patch: {
              reference: {
                thesis: String(ev.thesis || '').trim() || undefined,
                composition: String(ev.composition || '').trim() || undefined,
                dna,
                stages: Array.isArray(ev.stages)
                  ? ev.stages.map((s) => String(s))
                  : undefined,
              },
            },
          });
          return;
        }
        case 'optimization': {
          const decision = String(ev.decision || '').trim();
          params.onEvent({
            type: 'activity',
            id: `opt-${ev.iteration ?? 0}`,
            kind: decision === 'rollback' ? 'skipped' : 'tool',
            status: 'done',
            detail: [decision, ev.reason, ev.pareto_note]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 140),
          });
          if (typeof ev.iteration === 'number') {
            params.onEvent({
              type: 'intelligence',
              patch: {
                iterations: [
                  {
                    iteration: ev.iteration,
                    overall: 0,
                    decision,
                    reason: String(ev.reason || '').trim() || undefined,
                  },
                ],
              },
            });
          }
          return;
        }
        case 'design_summary': {
          const asList = (raw: unknown): string[] | undefined => {
            if (!Array.isArray(raw)) return undefined;
            const out = raw.map((x) => String(x || '').trim()).filter(Boolean);
            return out.length ? out.slice(0, 6) : undefined;
          };
          params.onEvent({
            type: 'intelligence',
            patch: {
              summary: {
                iterations: ev.iterations,
                removed: ev.removed,
                whitespace: ev.whitespace ?? null,
                heroDominance: ev.hero_dominance ?? null,
                scoreFrom: ev.score_from ?? null,
                scoreTo: ev.score_to ?? null,
                thesis: String(ev.thesis || '').trim() || undefined,
                why: String(ev.why || '').trim() || undefined,
                purpose: String(ev.purpose || '').trim() || undefined,
                audience: String(ev.audience || '').trim() || undefined,
                emotion: String(ev.emotion || '').trim() || undefined,
                strengths: asList(ev.strengths),
                weaknesses: asList(ev.weaknesses),
                nextSteps: asList(ev.next_steps),
                marketGap: String(ev.market_gap || '').trim() || undefined,
              },
              iterations: Array.isArray(ev.timeline)
                ? ev.timeline.map((row, i) => ({
                    iteration:
                      typeof row?.iteration === 'number' ? row.iteration : i,
                    overall: typeof row?.overall === 'number' ? row.overall : 0,
                  }))
                : undefined,
            },
          });
          return;
        }
        case 'replan':
          // Dynamic skip: labels may shrink; just log, no UI needed.
          return;
        case 'subgoals':
          if (ev.goals?.length) {
            params.onEvent({
              type: 'analysis_delta',
              text: ev.goals.map((g, i) => `${i + 1}. ${g}`).join('\n'),
            });
          }
          return;
        case 'memory_patch':
          emitMemory(
            {
              medium: (ev.medium || {}) as MemoryPatch['medium'],
              long_suggestions: ev.long_suggestions,
            },
            live.frameId || params.targetFrameId || null
          );
          return;
        case 'result':
          handleStreamResult(ev);
          return;
        case 'paused': {
          const tid = String(ev.task_id || liveTaskId || '').trim();
          if (tid) liveTaskId = tid;
          aiQueuePause(aiQueue);
          releaseAiMutationLock();
          params.onEvent({
            type: 'paused',
            taskId: tid,
            resumeToken: ev.resume_token || undefined,
            message: ev.message,
            interruptKind: ev.interrupt_kind,
          });
          return;
        }
        case 'cancelled':
          undoQueuedTransaction(aiQueueCancel(aiQueue));
          releaseAiMutationLock();
          params.onEvent({
            type: 'error',
            code: 'cancelled',
          });
          return;
        case 'error':
          if (ev.resumable && (ev.task_id || liveTaskId)) {
            const tid = String(ev.task_id || liveTaskId || '').trim();
            if (tid) liveTaskId = tid;
            params.onEvent({
              type: 'paused',
              taskId: tid,
              interruptKind: 'error',
              message: String(ev.message || '').trim() || undefined,
            });
            return;
          }
          params.onEvent({
            type: 'error',
            code: String(ev.code || '').trim() || 'internal_error',
            message: String(ev.message || '').trim() || undefined,
          });
          return;
        default:
          return;
      }
    };

    const onStreamMessage = (frame: { event: string; data: string }) => {
      const raw = String(frame.data || '').trim();
      if (!raw || raw === '[DONE]') return;
      try {
        const ev = parseDesignJobEvent(JSON.parse(raw));
        if (!ev) return;
        onStreamEvent(ev);
      } catch {
        /* ignore malformed SSE frame */
      }
    };

    const onStreamError = async (err: Error) => {
      if (params.signal?.aborted) return;
      const msg = err.message || String(err);
      const networkish = /Failed to fetch|NetworkError|ERR_|timeout|aborted/i.test(msg);
      if (liveTaskId && networkish) {
        try {
          const replay = await fetchDesignRunEvents(liveTaskId, 0, params.signal);
          for (const item of replay.items || []) {
            if (item?.event) onStreamEvent(item.event);
          }
        } catch {
          // Status still provides the existing pause/resume recovery path.
        }
        try {
          const st = await fetchDesignRunStatus(liveTaskId, params.signal);
          if (st?.resumable) {
            params.onEvent({
              type: 'paused',
              taskId: liveTaskId,
              resumeToken: st.resume_token,
              interruptKind: st.interrupt_kind || 'paused',
              message: String(st.error_message || '').trim() || undefined,
            });
            return;
          }
        } catch {
          /* fall through to error */
        }
      }
      params.onEvent({
        type: 'error',
        code: networkish ? 'timeout' : 'internal_error',
        message: msg.trim() || undefined,
      });
    };

    const resumeId = String(params.resumeTaskId || '').trim();
    if (resumeId) {
      liveTaskId = resumeId;
      params.onEvent({ type: 'task', taskId: resumeId });
      await resumeDesignJob(
        resumeId,
        { resume_token: params.resumeToken || undefined },
        {
          signal: params.signal,
          onmessage: onStreamMessage,
          onerror: (err) => {
            onStreamError(err);
          },
        }
      );
    } else {
      await runDesignJob(buildRunDesignJobBody(params, runMode), {
        signal: params.signal,
        onmessage: onStreamMessage,
        onerror: (err) => {
          onStreamError(err);
        },
      });
    }
    try {
      await paintChain;
    } catch {
      /* ignore */
    }
    if (params.signal?.aborted) {
      undoQueuedTransaction(aiQueueCancel(aiQueue));
      releaseAiMutationLock();
    } else {
      releaseAiMutationLock();
    }
    // Only clear cover when the full Design→Review(+retry) run has finished.
    cancelImportPlaceholder();
    clearProcessPill();

    if (terminalErrorCode) {
      params.onEvent({
        type: 'error',
        code: terminalErrorCode,
        message: terminalErrorMessage || undefined,
      });
      return;
    }

    if (pendingDone) {
      const summary = (pendingDone.summary || resultSummary || '').trim();
      params.onEvent({
        type: 'done',
        summary,
        painted: Boolean(pendingDone.painted),
        proposedOps: pendingDone.proposedOps?.length
          ? pendingDone.proposedOps
          : undefined,
        proposalId: pendingDone.proposalId || undefined,
        taskId: pendingDone.taskId || undefined,
        choiceUi: pendingDone.choiceUi,
      });
    }

    // Only after the run is fully done (never mid tool_ops / mid-draw).
    // Prefer every node on the artboard — live.nodeIds can miss creates when
    // artifacts omit nodeId or create_frame retargets mid-batch.
    if (!params.signal?.aborted && pendingDone?.painted) {
      const doc = params.getDocument();
      const frameId = live.frameId || params.targetFrameId || null;
      const fromFrame = nodeIdsInsideFrame(doc, frameId);
      const fromLive = [
        ...new Set(
          live.nodeIds.filter((id) => Boolean(doc?.deltaSetLike?.[id]))
        ),
      ];
      const ids = fromFrame.length >= 2 ? fromFrame : fromLive;
      if (ids.length >= 2) {
        pushEditorHistory();
        setDocument(groupNodesInDocument(doc, ids));
      }
    }
  } catch (err: unknown) {
    releaseAiMutationLock();
    cancelImportPlaceholder();
    clearProcessPill();
    if (params.signal?.aborted) return;
    const message =
      err instanceof Error ? err.message.trim() : String(err || '').trim();
    params.onEvent({
      type: 'error',
      code: 'internal_error',
      message: message || undefined,
    });
  }
}
