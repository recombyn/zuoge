import type { SceneDocument, SceneNode, SceneNodeInput } from '@/components/rcb/sceneNode';
/**
 * Canvas design tools — schemas + local execution (tool loop).
 */


import {
  addArtboardFrame,
  patchDocumentNode,
  patchDocumentNodes,
  pushEditorHistory,
  removeArtboardFrames,
  setCanvasMeta,
  setDocument,
  setActiveTool,
  setGridMode,
  setDocumentFromCanvas,
  startImageProcess,
  updateArtboardFrame,
  updateArtboardFrames,
  ensureAnimationFrameMedia,
  spawnAnimationBoard,
  importLottieIntoAnimationFrame,
  openLottieTimelinePanel,
  type ArtboardFrame,
} from '@/store/modules/editor';
import { exportFabricImage } from '@/components/rcb/scene/export/exportImage';
import {
  addNodeToDocument,
  cloneSceneValue,
  reconcileStackOrder,
  removeNodesFromDocument,
  reorderNodesInDocument
} from '@/components/rcb/scene/document/sceneDocument';
import { nodeIdsBoundToFrames } from '@/components/rcb/scene/document/sceneClipboard';
import { canBindNodeToArtboardFrame } from '@/components/rcb/frames/frameNodeBinding';
import { isAnimationArtboardKind } from '@/components/rcb/frames/types';
import {
  getAnimationWorkbenchTimelineFocus,
  tagCreatedNodeForWorkbenchSurround,
} from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import {
  findFrameAnimationMediaId,
  resolveActiveAnimationFrameId,
  resolveBooleanResultFrameId,
} from '@/components/editor/nodes/AnimationNode/resolveAnimationFrameId';
import {
  createImageNode,
  createShapeNode,
  createSvgNode,
  createLottieNode,
  createTextNode,
  parseLottieAnimationData,
} from '@/components/rcb/scene/document/nodeFactories';
import {
  supportsBooleanOp
} from '@/components/rcb/scene/document/nodeCapabilities';
import {
  applyLottieAnimationToNode
} from '@/components/rcb/scene/document/mediaLifecycle';
import {
  groupNodesInDocument,
  ungroupNodesInDocument
} from '@/components/rcb/scene/document/sceneGroups';
import {
  buildMarkdownTextAttrs,
  measurePlainTextSize,
  measureWrappedTextSize,
  parseNodeTextStyle,
} from '@/components/rcb/scene/document/sceneText';
import { serializeFillGradient, serializeFillImageAttrs } from '@/components/rcb/scene/document/sceneFill';
import { createMeshGrid, type MeshSize } from '@/components/rcb/scene/document/sceneDiffuseMesh';
import { isStrokeStyle } from '@/components/rcb/scene/document/sceneStrokeStyle';
import { nodeLeftTop } from '@/components/rcb/scene/layout/nodeLayout';
import { sceneToDocumentCoords } from '@/components/rcb/scene/layout/coords';
import { nanoid } from 'nanoid';
import { getAllowedCanvasToolKeys, filterAllowedToolOps, dedupeToolOpsById, type AgentToolOp } from '@/components/editor/panels/agent/toolOpsContract';
import { enterKitPathEditForRcbId, runKitBooleanOp } from '@/components/rcb/canvas/kitBridge';
import { isCustomPathShape } from '@/components/rcb/scene/document/pathScale';
import { rcbPlaceTextFontSize } from '@/components/rcb/core/layout';
import { normalizeHex } from '@/components/base/colorPanel';
import { store } from '@/store';

type ScenePoint = { x: number; y: number };

/** Polyline → SVG path `d` (open centerline; Kit paints stroke). */
function polylinePathD(points: ScenePoint[]): string {
  if (points.length < 1) return '';
  return points.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x} ${pt.y}`).join(' ');
}

/** RDP simplify for agent pencil/path edits — keep endpoints. */
function simplifyPencilCenterline(points: ScenePoint[], epsilon: number): ScenePoint[] {
  if (points.length <= 2) return points.map((p) => ({ ...p }));
  const eps = Number(epsilon);
  if (!(eps > 0)) return points.map((p) => ({ ...p }));

  function distToSeg(p: ScenePoint, a: ScenePoint, b: ScenePoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  function rdp(i0: number, i1: number) {
    if (i1 - i0 <= 1) return;
    let maxDist = 0;
    let maxIdx = i0;
    const first = points[i0];
    const last = points[i1];
    for (let i = i0 + 1; i < i1; i += 1) {
      const d = distToSeg(points[i], first, last);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist <= eps) return;
    keep[maxIdx] = 1;
    rdp(i0, maxIdx);
    rdp(maxIdx, i1);
  }

  rdp(0, points.length - 1);
  const out: ScenePoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    if (keep[i]) out.push({ ...points[i] });
  }
  return out;
}

const IMAGE_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect fill="#eee" width="100%" height="100%"/><text x="50%" y="50%" text-anchor="middle" fill="#999" font-size="14">Image</text></svg>'
  );
const AVATAR_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="60" fill="#ddd"/><circle cx="60" cy="48" r="22" fill="#bbb"/><ellipse cx="60" cy="100" rx="36" ry="24" fill="#bbb"/></svg>'
  );

export type AgentToolResult = {
  status: 'success' | 'warning' | 'error';
  summary: string;
  artifacts?: Record<string, unknown>;
  next_actions?: string[];
};

export type DesignToolContext = {
  getDocument: () => SceneDocument | null;
  /** Prefer placing new nodes inside this frame. When set (e.g. user @ artboard), frame ops are pinned to it. */
  targetFrameId?: string | null;
  /**
   * When true, allow delete_nodes / other destructive tools.
   * Set by the design-agent executor after backend intent approved the ops — never infer from user text here.
   */
  allowDestructive?: boolean;
  /** User-attached image data URLs (fill slots via create_image). */
  userImages?: string[];
  /** Editor chrome bridge (zoom / panels / agent mode). */
  canvasUi?: CanvasUiBridge | null;
  /** Skip per-tool undo snapshots (e.g. batch SVG → nodes import). */
  skipHistory?: boolean;
};

export type SceneMutationSource = 'ai' | 'human' | 'collab';
export type SceneMutationStage =
  | 'validate'
  | 'permission'
  | 'revision'
  | 'apply'
  | 'history'
  | 'sync';

export type SceneMutationOpResult = {
  op_id: string;
  name: string;
  ok: boolean;
  error?: string;
};

export type SceneMutationGate = {
  ok: boolean;
  stage: SceneMutationStage;
  reason?: string;
  ops: AgentToolOp[];
  /** PR8 — how revision was resolved. Absent when the gate failed earlier. */
  revisionAction?: 'apply' | 'rebase' | 'reject';
  dropped?: Array<{ op_id: string; name: string; reason: string }>;
};

export type SceneMutationDocView = {
  deltaSetLike?: Record<string, unknown> | null;
  frames?: Array<{ id?: string } | null> | null;
  activeFrameId?: string | null;
};

const DESTRUCTIVE_SCENE_OPS = new Set(['delete_nodes', 'delete_frame']);

export function sceneMutationValidate(
  ops: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>,
  appliedOpIds?: Set<string>
): SceneMutationGate {
  if (!ops.length) {
    return { ok: false, stage: 'validate', reason: 'empty_ops', ops: [] };
  }
  const allowed = dedupeToolOpsById(
    filterAllowedToolOps(ops),
    appliedOpIds || new Set()
  );
  if (!allowed.length) {
    return { ok: false, stage: 'validate', reason: 'no_allowed_ops', ops: [] };
  }
  return { ok: true, stage: 'validate', ops: allowed };
}

export function sceneMutationPermission(opts: {
  source: SceneMutationSource;
  allowDestructive?: boolean;
  ops: AgentToolOp[];
}): SceneMutationGate {
  if (opts.source === 'collab') {
    return { ok: true, stage: 'permission', ops: opts.ops };
  }
  const destructive = opts.ops.some((o) => DESTRUCTIVE_SCENE_OPS.has(o.name));
  if (destructive && !opts.allowDestructive) {
    return {
      ok: false,
      stage: 'permission',
      reason: 'destructive_not_allowed',
      ops: opts.ops,
    };
  }
  return { ok: true, stage: 'permission', ops: opts.ops };
}

export function sceneMutationRevision(opts: {
  source: SceneMutationSource;
  baseRevision?: number;
  currentRevision?: number;
}): SceneMutationGate {
  if (opts.source === 'collab') {
    return { ok: true, stage: 'revision', ops: [], revisionAction: 'apply' };
  }
  const base = Math.max(0, Number(opts.baseRevision) || 0);
  const current = Math.max(0, Number(opts.currentRevision) || 0);
  // Legacy / first paint: no revision yet — do not block.
  if (base <= 0 || current <= 0) {
    return { ok: true, stage: 'revision', ops: [], revisionAction: 'apply' };
  }
  if (base !== current) {
    return {
      ok: false,
      stage: 'revision',
      reason: 'revision_conflict',
      ops: [],
      revisionAction: 'reject',
    };
  }
  return { ok: true, stage: 'revision', ops: [], revisionAction: 'apply' };
}

function mutationArgIds(args: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const raw = args[key];
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const id = String(item || '').trim();
        if (id) out.push(id);
      }
      continue;
    }
    const id = String(raw || '').trim();
    if (id) out.push(id);
  }
  return [...new Set(out)];
}

function sceneHasNode(doc: SceneMutationDocView | null | undefined, id: string): boolean {
  const nid = String(id || '').trim();
  if (!nid) return false;
  const bag = doc?.deltaSetLike;
  return Boolean(bag && typeof bag === 'object' && bag[nid]);
}

function sceneHasFrame(doc: SceneMutationDocView | null | undefined, id: string): boolean {
  const fid = String(id || '').trim();
  if (!fid) return false;
  const frames = Array.isArray(doc?.frames) ? doc.frames : [];
  return frames.some((f) => f && String(f.id || '').trim() === fid);
}

function mutationMinLiveIds(name: string): number {
  if (
    name === 'align_nodes' ||
    name === 'distribute_nodes' ||
    name === 'group_nodes' ||
    name === 'boolean_op'
  ) {
    return 2;
  }
  return 1;
}

function rebaseRewriteCreateFrame(
  op: AgentToolOp,
  doc: SceneMutationDocView
): AgentToolOp | { drop: string } {
  const args = { ...(op.args || {}) };
  const frameId = String(args.frameId || '').trim();
  if (!frameId || sceneHasFrame(doc, frameId)) return { ...op, args };
  const fallback = String(doc.activeFrameId || '').trim();
  if (fallback && sceneHasFrame(doc, fallback)) {
    return { ...op, args: { ...args, frameId: fallback } };
  }
  return { drop: 'target_missing' };
}

/**
 * Replay AI ops onto the current SceneDocument after a revision mismatch.
 * Additive creates + updates to still-living ids rebase; live deletes reject.
 */
export function rebaseSceneMutationOps(
  ops: AgentToolOp[],
  doc: SceneMutationDocView | null | undefined
): {
  action: 'rebase' | 'reject';
  ops: AgentToolOp[];
  dropped: Array<{ op_id: string; name: string; reason: string }>;
  reason?: string;
} {
  const dropped: Array<{ op_id: string; name: string; reason: string }> = [];
  if (!doc) {
    return {
      action: 'reject',
      ops,
      dropped,
      reason: 'revision_conflict',
    };
  }
  const kept: AgentToolOp[] = [];
  for (const op of ops) {
    const name = String(op.name || '').trim();
    const opId = String(op.op_id || '');
    const args = op.args && typeof op.args === 'object' ? op.args : {};
    const drop = (reason: string) => {
      dropped.push({ op_id: opId, name, reason });
    };

    if (name === 'delete_frame') {
      const fid = mutationArgIds(args, ['frameId'])[0] || '';
      if (fid && sceneHasFrame(doc, fid)) {
        return {
          action: 'reject',
          ops,
          dropped: [...dropped, { op_id: opId, name, reason: 'unsafe_delete' }],
          reason: 'revision_conflict',
        };
      }
      drop('target_missing');
      continue;
    }

    if (name === 'delete_nodes') {
      const ids = mutationArgIds(args, ['nodeIds']);
      const live = ids.filter((id) => sceneHasNode(doc, id));
      if (live.length) {
        return {
          action: 'reject',
          ops,
          dropped: [...dropped, { op_id: opId, name, reason: 'unsafe_delete' }],
          reason: 'revision_conflict',
        };
      }
      drop('target_missing');
      continue;
    }

    if (name.startsWith('create_')) {
      if (name === 'create_frame') {
        kept.push(op);
        continue;
      }
      const rewritten = rebaseRewriteCreateFrame(op, doc);
      if ('drop' in rewritten) {
        drop(rewritten.drop);
        continue;
      }
      kept.push(rewritten);
      continue;
    }

    if (name === 'update_frame') {
      const fid = mutationArgIds(args, ['frameId'])[0] || '';
      if (fid && sceneHasFrame(doc, fid)) {
        kept.push(op);
        continue;
      }
      drop('target_missing');
      continue;
    }

    const targetIds = mutationArgIds(args, ['nodeIds', 'nodeId']);
    if (!targetIds.length) {
      kept.push(op);
      continue;
    }
    const liveIds = targetIds.filter((id) => sceneHasNode(doc, id));
    if (liveIds.length < mutationMinLiveIds(name)) {
      drop('target_missing');
      continue;
    }
    if (liveIds.length === targetIds.length) {
      kept.push(op);
      continue;
    }
    const nextArgs = { ...args };
    if (Array.isArray(args.nodeIds)) nextArgs.nodeIds = liveIds;
    else nextArgs.nodeId = liveIds[0];
    kept.push({ ...op, args: nextArgs });
  }

  if (!kept.length) {
    return {
      action: 'reject',
      ops,
      dropped,
      reason: 'revision_conflict',
    };
  }
  return { action: 'rebase', ops: kept, dropped };
}

export function resolveSceneMutationRevision(opts: {
  source: SceneMutationSource;
  ops: AgentToolOp[];
  baseRevision?: number;
  currentRevision?: number;
  document?: SceneMutationDocView | null;
}): SceneMutationGate {
  const checked = sceneMutationRevision({
    source: opts.source,
    baseRevision: opts.baseRevision,
    currentRevision: opts.currentRevision,
  });
  if (checked.ok) {
    return { ...checked, ops: opts.ops, revisionAction: 'apply' };
  }
  const rebased = rebaseSceneMutationOps(opts.ops, opts.document);
  if (rebased.action === 'reject') {
    return {
      ok: false,
      stage: 'revision',
      reason: rebased.reason || 'revision_conflict',
      ops: opts.ops,
      revisionAction: 'reject',
      dropped: rebased.dropped,
    };
  }
  return {
    ok: true,
    stage: 'revision',
    reason: 'rebased',
    ops: rebased.ops,
    revisionAction: 'rebase',
    dropped: rebased.dropped,
  };
}

export function gateSceneMutation(req: {
  source: SceneMutationSource;
  ops: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
  appliedOpIds?: Set<string>;
  allowDestructive?: boolean;
  baseRevision?: number;
  currentRevision?: number;
  document?: SceneMutationDocView | null;
}): SceneMutationGate {
  const validated = sceneMutationValidate(req.ops, req.appliedOpIds);
  if (!validated.ok) return validated;
  const permitted = sceneMutationPermission({
    source: req.source,
    allowDestructive: req.allowDestructive,
    ops: validated.ops,
  });
  if (!permitted.ok) return permitted;
  return resolveSceneMutationRevision({
    source: req.source,
    ops: validated.ops,
    baseRevision: req.baseRevision,
    currentRevision: req.currentRevision,
    document: req.document,
  });
}

function mutationRejectResults(
  ops: Array<{ name?: string; op_id?: string; args?: Record<string, unknown> }>,
  reason: string
): SceneMutationOpResult[] {
  return ops.map((op) => ({
    op_id: String(op.op_id || ''),
    name: String(op.name || ''),
    ok: false,
    error: reason,
  }));
}

/**
 * Scene Mutation Pipeline: validate → permission → revision → history → apply → sync.
 * AI / human / collab writes go through here — never AI → store action shapes.
 */
export async function applySceneMutation<T extends { opResults: SceneMutationOpResult[] }>(opts: {
  source: SceneMutationSource;
  transactionId?: string;
  ops: Array<{ name?: string; args?: Record<string, unknown>; op_id?: string }>;
  appliedOpIds?: Set<string>;
  allowDestructive?: boolean;
  baseRevision?: number;
  currentRevision?: number;
  document?: SceneMutationDocView | null;
  skipHistory?: boolean;
  execute: (ops: AgentToolOp[]) => Promise<T>;
}): Promise<{
  ok: boolean;
  stage: SceneMutationStage;
  reason?: string;
  historyPushed: boolean;
  revisionAction?: 'apply' | 'rebase' | 'reject';
  dropped?: Array<{ op_id: string; name: string; reason: string }>;
  result: T | null;
  opResults: SceneMutationOpResult[];
}> {
  const gate = gateSceneMutation({
    source: opts.source,
    ops: opts.ops,
    appliedOpIds: opts.appliedOpIds,
    allowDestructive: opts.allowDestructive,
    baseRevision: opts.baseRevision,
    currentRevision: opts.currentRevision,
    document: opts.document,
  });
  if (!gate.ok) {
    const opResults = mutationRejectResults(
      gate.ops.length ? gate.ops : opts.ops,
      String(gate.reason || 'mutation_denied')
    );
    return {
      ok: false,
      stage: gate.stage,
      reason: gate.reason,
      historyPushed: false,
      revisionAction: gate.revisionAction || 'reject',
      dropped: gate.dropped,
      result: null,
      opResults,
    };
  }
  let historyPushed = false;
  if (!opts.skipHistory && opts.source !== 'collab') {
    pushEditorHistory();
    historyPushed = true;
  }
  const result = await opts.execute(gate.ops);
  const droppedResults: SceneMutationOpResult[] = (gate.dropped || []).map((row) => ({
    op_id: row.op_id,
    name: row.name,
    ok: false,
    error: row.reason,
  }));
  return {
    ok: true,
    stage: 'sync',
    reason: gate.reason,
    historyPushed,
    revisionAction: gate.revisionAction || 'apply',
    dropped: gate.dropped,
    result,
    opResults: [...droppedResults, ...result.opResults],
  };
}

/**
 * Resolve which artboard a frame op should hit.
 * User @ / FOCUS_FRAME_ID (ctx.targetFrameId) wins over a model-guessed frameId —
 * duplicate names like "新画板" often make the model pick the wrong SCENE_FRAMES entry.
 */
function resolveFrameOpId(
  args: Record<string, any>,
  ctx: DesignToolContext
): string {
  const focus = String(ctx.targetFrameId || '').trim();
  const fromArgs = String(args.frameId || '').trim();
  // Honor model frameId when present — do not silently retarget to focus.
  if (fromArgs) return fromArgs;
  return focus;
}

/** Visible scene AABB in world coords (from camera + stage size). */
export type ViewportSceneBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Optional callbacks from EditorPage / AgentDock for non-document UI. */
export type CanvasUiBridge = {
  getZoom?: () => number;
  zoomIn?: () => void;
  zoomOut?: () => void;
  /** Absolute zoom factor (1 = 100%). */
  setZoom?: (zoom: number) => void;
  /** Fit / reset view (typically 100% at stage center). */
  fitView?: () => void;
  /** Camera viewport in world coords — reported to the agent as scene context only. */
  getViewportSceneBounds?: () => ViewportSceneBounds | null;
  getCollabMode?: () => 'collaborative' | 'milestone' | 'auto';
  setCollabMode?: (mode: 'collaborative' | 'milestone' | 'auto') => void;
  setLayersOpen?: (open: boolean) => void;
  setAssetsOpen?: (open: boolean) => void;
  setMinimapOpen?: (open: boolean) => void;
  getLayersOpen?: () => boolean;
  getAssetsOpen?: () => boolean;
  getMinimapOpen?: () => boolean;
  openAccountAgent?: () => void;
};

/** Capabilities the agent can honestly say are not wired yet. Tool-facing copy stays English. */
export const UNAVAILABLE_CAPABILITIES: Array<{
  id: string;
  label: string;
  hint: string;
}> = [
  {
    id: 'product_preview',
    label: 'Product / fullscreen preview',
    hint: 'Not wired for Agent. Use the editor fullscreen preview or top-bar share preview.',
  },
  {
    id: 'share',
    label: 'Share link',
    hint: 'Not wired for Agent. Use the editor top-bar Share control.',
  },
  {
    id: 'workspace_dev',
    label: 'Switch Design / Dev workspace',
    hint: 'Not wired for Agent. Use the top-bar Design / Dev toggle.',
  },
  {
    id: 'hand_tool',
    label: 'Hand / select tool',
    hint: 'Use set_active_tool tool=pan|select. Space still pans in the editor.',
  },
  {
    id: 'tour',
    label: 'Replay onboarding tour',
    hint: 'Not wired for Agent. Use the bottom-left "?" to replay the tour.',
  },
];

type CanvasUi = CanvasUiBridge;

/** Registry for `toggle_editor_panel` — add rows here instead of growing if-chains. */
const EDITOR_PANEL_REGISTRY: Array<
  | {
      id: string;
      aliases?: string[];
      kind: 'toggle';
      missing: string;
      opened: string;
      closed: string;
      apply: (ui: CanvasUi, open: boolean) => boolean;
    }
  | {
      id: string;
      aliases?: string[];
      kind: 'navigate';
      missing: string;
      success: string;
      apply: (ui: CanvasUi) => boolean;
    }
  | {
      id: string;
      aliases?: string[];
      kind: 'unavailable';
      /** Matches `UNAVAILABLE_CAPABILITIES.id` */
      capabilityId: string;
    }
  | {
      id: string;
      aliases?: string[];
      kind: 'redirect';
      summary: string;
      next_actions: string[];
    }
> = [
  {
    id: 'layers',
    aliases: ['layer'],
    kind: 'toggle',
    missing: 'Layers panel bridge missing. Use the bottom-left Layers control.',
    opened: 'Opened layers panel',
    closed: 'Closed layers panel',
    apply: (ui, open) => {
      if (!ui.setLayersOpen) return false;
      ui.setLayersOpen(open);
      return true;
    },
  },
  {
    id: 'minimap',
    aliases: ['map'],
    kind: 'toggle',
    missing: 'Minimap bridge missing. Use the bottom-left Minimap control.',
    opened: 'Opened minimap',
    closed: 'Closed minimap',
    apply: (ui, open) => {
      if (!ui.setMinimapOpen) return false;
      ui.setMinimapOpen(open);
      return true;
    },
  },
  {
    id: 'agent_settings',
    aliases: ['settings', 'collab'],
    kind: 'navigate',
    missing: 'Open Account → Agent to manage third-party models.',
    success: 'Opened Account → Agent model settings',
    apply: (ui) => {
      if (!ui.openAccountAgent) return false;
      ui.openAccountAgent();
      return true;
    },
  },
  {
    id: 'preview',
    aliases: ['product_preview'],
    kind: 'unavailable',
    capabilityId: 'product_preview',
  },
  {
    id: 'share',
    kind: 'unavailable',
    capabilityId: 'share',
  },
  {
    id: 'export',
    kind: 'redirect',
    summary:
      'Use export_canvas (format=png|jpeg|svg); not toggle_editor_panel.',
    next_actions: ['export_canvas'],
  },
];

function resolveEditorPanel(raw: string) {
  const key = String(raw || '')
    .toLowerCase()
    .trim();
  if (!key) return null;
  return (
    EDITOR_PANEL_REGISTRY.find(
      (p) => p.id === key || (p.aliases || []).includes(key)
    ) || null
  );
}

function supportedTogglePanelIds(): string[] {
  return EDITOR_PANEL_REGISTRY.filter(
    (p) => p.kind === 'toggle' || p.kind === 'navigate'
  ).map((p) => p.id);
}

/** FE Action op_keys live in Admin `design_canvas_tool` + executeDesignTool switch. */

export const DESIGN_TOOL_NAMES = [
  'get_scene_summary',
  'list_capabilities',
  'ask_user',
  'create_frame',
  'duplicate_frame',
  'reorder_frames',
  'fit_frame_to_content',
  'lock_frames',
  'hide_frames',
  'clip_frames',
  'update_frame',
  'create_shape',
  'create_path',
  'append_path_points',
  'simplify_path',
  'smooth_path',
  'close_path',
  'create_text',
  'outline_text',
  'create_image',
  'create_svg',
  'create_lottie',
  'create_icon',
  'update_node',
  'align_nodes',
  'distribute_nodes',
  'boolean_op',
  'reorder_nodes',
  'group_nodes',
  'ungroup_nodes',
  'duplicate_nodes',
  'flip_nodes',
  'rotate_nodes',
  'bind_nodes_to_frame',
  'unbind_nodes',
  'set_viewport',
  'set_active_tool',
  'set_grid',
  'set_canvas_background',
  'image_process',
  'export_canvas',
  'edit_path_points',
  'apply_brush_preset',
  'set_agent_mode',
  'toggle_editor_panel',
  'hide_nodes',
  'delete_nodes',
  'delete_frame',
  'finish',
] as const;

function coerceScenePoint(raw: unknown): ScenePoint | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const x = Number(raw[0]);
    const y = Number(raw[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }
  if (typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const x = Number(row.x);
  const y = Number(row.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function readScenePoints(raw: unknown): ScenePoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => coerceScenePoint(entry)).filter((entry): entry is ScenePoint => Boolean(entry));
}

function pointsToPath(points: ScenePoint[], closed: boolean): string {
  const d = polylinePathD(points);
  if (!d) return '';
  if (closed && points.length > 2) return `${d} Z`;
  return d;
}

function isEditablePathNode(node: SceneNode | undefined | null): boolean {
  if (!node || node.key !== 'shape') return false;
  return isCustomPathShape(String(node.attrs?.shapeType || '').toLowerCase());
}

function parsePathPoints(path: string): { points: ScenePoint[]; closed: boolean } {
  const raw = String(path || '').trim();
  const closed = /z\s*$/i.test(raw);
  const tokens = raw.replace(/,/g, ' ').match(/[MmLlHhVvZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  const points: ScenePoint[] = [];
  let cmd = 'L';
  let i = 0;
  let lastX = 0;
  let lastY = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^[MmLlHhVvZz]$/.test(token)) {
      cmd = token.toUpperCase();
      i += 1;
      continue;
    }
    const n = Number(token);
    if (!Number.isFinite(n)) {
      i += 1;
      continue;
    }
    if (cmd === 'H') {
      lastX = n;
      points.push({ x: lastX, y: lastY });
      i += 1;
      continue;
    }
    if (cmd === 'V') {
      lastY = n;
      points.push({ x: lastX, y: lastY });
      i += 1;
      continue;
    }
    const y = Number(tokens[i + 1]);
    if (!Number.isFinite(y)) {
      i += 1;
      continue;
    }
    lastX = n;
    lastY = y;
    if (cmd === 'M' || cmd === 'L') points.push({ x: lastX, y: lastY });
    if (cmd === 'M') cmd = 'L';
    i += 2;
  }
  return { points, closed };
}

function simplifyPolyline(points: ScenePoint[], tolerance: number): ScenePoint[] {
  return simplifyPencilCenterline(points, tolerance);
}

function lerpPoint(a: ScenePoint, b: ScenePoint, t: number): ScenePoint {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function smoothPolyline(
  points: ScenePoint[],
  iterations: number,
  closed: boolean
): ScenePoint[] {
  if (points.length < 3) return points;
  let next = points;
  const rounds = Math.max(1, Math.min(4, Math.round(iterations)));
  for (let r = 0; r < rounds; r += 1) {
    const out: ScenePoint[] = [];
    const n = next.length;
    if (closed) {
      for (let i = 0; i < n; i += 1) {
        const a = next[i];
        const b = next[(i + 1) % n];
        out.push(lerpPoint(a, b, 0.25), lerpPoint(a, b, 0.75));
      }
    } else {
      out.push(next[0]);
      for (let i = 0; i < n - 1; i += 1) {
        out.push(lerpPoint(next[i], next[i + 1], 0.25), lerpPoint(next[i], next[i + 1], 0.75));
      }
      out.push(next[n - 1]);
    }
    next = out;
  }
  return next;
}

function resolveEditablePathNode(
  doc: SceneDocument,
  nodeId: string
): { node: SceneNode } | { error: AgentToolResult } {
  const node = doc.deltaSetLike?.[nodeId];
  if (!node) {
    return { error: { status: 'error', summary: `Node not found: ${nodeId}` } };
  }
  if (!isEditablePathNode(node)) {
    const kind = String(node.attrs?.shapeType || node.key || 'node');
    return {
      error: {
        status: 'error',
        summary: `Node ${nodeId} is ${kind}; expected path/pen/pencil`,
      },
    };
  }
  return { node };
}

function parseFrameOpIds(args: Record<string, unknown>, ctx: DesignToolContext): string[] {
  if (Array.isArray(args.frameIds)) {
    return [...new Set(args.frameIds.map((id) => String(id || '').trim()).filter(Boolean))];
  }
  const focus = String(ctx.targetFrameId || '').trim();
  return focus ? [focus] : [];
}

function reorderKeysWithAction(
  keys: string[],
  selected: Set<string>,
  action: 'front' | 'back' | 'forward' | 'backward'
): string[] {
  const untouched = keys.filter((key) => !selected.has(key));
  const picked = keys.filter((key) => selected.has(key));
  if (!picked.length) return keys;
  if (action === 'front') return [...untouched, ...picked];
  if (action === 'back') return [...picked, ...untouched];
  if (action === 'forward') {
    const next = [...keys];
    for (let i = next.length - 2; i >= 0; i -= 1) {
      const cur = next[i];
      const after = next[i + 1];
      if (selected.has(cur) && !selected.has(after)) {
        next[i] = after;
        next[i + 1] = cur;
      }
    }
    return next;
  }
  const next = [...keys];
  for (let i = 1; i < next.length; i += 1) {
    const cur = next[i];
    const before = next[i - 1];
    if (selected.has(cur) && !selected.has(before)) {
      next[i] = before;
      next[i - 1] = cur;
    }
  }
  return next;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw || '{}');
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function num(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function resolvePathClosed(opts: {
  args: Record<string, unknown>;
  mapped: string;
  path: string;
}): boolean {
  const { args, mapped, path } = opts;
  const closedExplicit =
    args.closed === true ||
    args.closed === 'true' ||
    args.closed === false ||
    args.closed === 'false';
  if (closedExplicit) return args.closed === true || args.closed === 'true';
  if (mapped === 'path') return /z\s*$/i.test(path.trim());
  return mapped === 'pen' && path.length > 0;
}

function resolveCreateShapeBorderWidth(opts: {
  args: Record<string, unknown>;
  mapped: string;
  isFreePath: boolean;
  needsDefaultStroke: boolean;
  isStrokeOnly: boolean;
  strokeIsNone: boolean;
}): number {
  const {
    args,
    mapped,
    isFreePath,
    needsDefaultStroke,
    isStrokeOnly,
    strokeIsNone,
  } = opts;
  const penLike = isStrokeOnly || mapped === 'pen' || mapped === 'pencil';
  if (isFreePath) {
    if (args.borderWidth != null) return Math.max(0, num(args.borderWidth, 0));
    if (strokeIsNone) return 0;
    return 1;
  }
  if (needsDefaultStroke) {
    if (args.borderWidth != null) return num(args.borderWidth, penLike ? 2 : 1);
    return penLike ? 2 : 1;
  }
  if (args.borderWidth != null) return num(args.borderWidth, 0);
  if (args.stroke != null && !strokeIsNone) return 1;
  return 0;
}

const PENCIL_BRUSH_IDS = new Set([
  'vector-ink',
  'vector-even',
  'vector-calligraphy',
  'vector-pencil',
  'vector-marker',
  'vector-brush',
  'vector-fountain',
  'vector-technical',
  'vector-soft',
]);

function resolvePencilBrushStyle(
  mapped: string,
  args: Record<string, unknown>
): string | undefined {
  if (mapped !== 'pencil') return undefined;
  const raw = args.brushStyle != null ? String(args.brushStyle).trim() : '';
  if (!raw || !PENCIL_BRUSH_IDS.has(raw)) return 'vector-ink';
  return raw;
}

function mapCreateShapeType(shapeType: string): string {
  if (shapeType === 'ellipse') return 'circle';
  return shapeType;
}

function pickSvgMarkup(args: Record<string, unknown>): string {
  if (args.svg != null) return String(args.svg);
  return '';
}

function defaultCreateShapeFill(opts: {
  args: Record<string, unknown>;
  isStrokeOnly: boolean;
  isFreePath: boolean;
  closed: boolean;
}): string {
  if (opts.args.fill != null) return String(opts.args.fill);
  if (opts.isStrokeOnly || (opts.isFreePath && !opts.closed)) return 'transparent';
  return '#FFFFFF';
}

function resolveCreateShapeStroke(opts: {
  args: Record<string, unknown>;
  needsDefaultStroke: boolean;
}): string {
  let raw: string;
  if (opts.args.stroke != null) raw = String(opts.args.stroke);
  else if (opts.needsDefaultStroke) raw = '#333333';
  else raw = 'transparent';
  if (!raw || raw === 'none' || raw === 'rgba(0,0,0,0)') return 'transparent';
  return raw;
}

function resolveUpdateBrushStyle(
  args: Record<string, unknown>,
  currentAttrs: Record<string, unknown>
): string | undefined {
  if (args.brushStyle != null) return resolvePencilBrushStyle('pencil', args);
  if (currentAttrs.brushStyle != null) return String(currentAttrs.brushStyle);
  return undefined;
}

function normalizePressureEnabledArg(
  raw: unknown,
  opts: { hasPathPressure: boolean }
): boolean | undefined {
  const hasPathPressure = Boolean(opts?.hasPathPressure);
  if (raw == null || raw === '') {
    // Match FE default: pressure on when a pressure curve is present.
    return hasPathPressure ? true : undefined;
  }
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return hasPathPressure ? true : undefined;
}

function summarizeCreateImage(opts: {
  id: string;
  sourceKind: string;
  genPrompt: string;
  placed: { width: number; height: number };
}): string {
  const wh = `${Math.round(opts.placed.width)}×${Math.round(opts.placed.height)}`;
  if (opts.sourceKind !== 'placeholder') {
    return `Created image ${opts.id} from ${opts.sourceKind}`;
  }
  if (opts.genPrompt) {
    return `Created image placeholder ${opts.id} (genPrompt not hydrated) — ${wh}`;
  }
  return `Created image placeholder ${opts.id} (${wh}) — user can replace later`;
}

function normalizeAlignMode(rawMode: string): string {
  if (rawMode === 'center' || rawMode === 'centerx') return 'centerX';
  if (rawMode === 'centerY' || rawMode === 'centery') return 'middle';
  return rawMode;
}

function normalizeExportFormat(formatRaw: string): 'jpeg' | 'svg' | 'png' {
  if (formatRaw === 'jpg' || formatRaw === 'jpeg') return 'jpeg';
  if (formatRaw === 'svg') return 'svg';
  return 'png';
}

function resolveExportNodeIds(args: Record<string, unknown>): string[] {
  if (Array.isArray(args.nodeIds)) {
    return args.nodeIds.map((x) => String(x)).filter(Boolean);
  }
  if (args.nodeId) return [String(args.nodeId)];
  return [];
}

/** Normalize AI pathPressure (csv string or number[]) to comma-separated 0.05–1. */
function normalizePathPressureArg(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  const parts: number[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const n = Number(v);
      if (Number.isFinite(n)) parts.push(n);
    }
  } else {
    for (const tok of String(raw).split(/[,;\s]+/)) {
      if (!tok) continue;
      const n = Number(tok);
      if (Number.isFinite(n)) parts.push(n);
    }
  }
  if (!parts.length) return undefined;
  return parts
    .map((n) => {
      const t = n > 1 ? n / 100 : n;
      return Math.min(1, Math.max(0.05, t)).toFixed(3);
    })
    .join(',');
}

function listFrames(doc: SceneDocument): ArtboardFrame[] {
  return Array.isArray(doc?.frames) ? doc.frames : [];
}

/** Scene node ids whose boxes mostly overlap any of the given frames (≥35% area). */
export function nodeIdsInsideFramesOverlap(
  doc: SceneDocument,
  frameIds: string[]
): string[] {
  return nodeIdsBoundToFrames(doc, frameIds);
}

/** Single-frame helper (agent edit target / scene inventory). */
export function nodeIdsInsideFrame(
  doc: SceneDocument,
  frameId: string | null | undefined
): string[] {
  if (!frameId) return [];
  return nodeIdsInsideFramesOverlap(doc, [String(frameId)]);
}

function frameById(doc: SceneDocument, id?: string | null) {
  if (!id) return null;
  return listFrames(doc).find((f) => f.id === id) || null;
}

function sceneSummary(doc: SceneDocument, targetFrameId?: string | null) {
  const frames = listFrames(doc).map((f) => ({
    id: f.id,
    name: f.name,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
  }));
  const nodes = Object.values(doc?.deltaSetLike || {})
    .filter((n: any) => n && n.id)
    .slice(0, 80)
    .map((n: any) => ({
      id: n.id,
      key: n.key,
      shapeType: n.attrs?.shapeType,
      x: Math.round(Number(n.x) || 0),
      y: Math.round(Number(n.y) || 0),
      width: Math.round(Number(n.width) || 0),
      height: Math.round(Number(n.height) || 0),
      name: n.attrs?.name,
      fillType: n.attrs?.['fill-type'] || 'solid',
      fill: n.attrs?.['fill-color'],
      strokeStyle: n.attrs?.strokeStyle || 'solid',
      shadow: n.attrs?.['shadow-enabled'] === 'true' || n.attrs?.['shadow-enabled'] === true,
      rotation: Number(n.attrs?.angle) || 0,
      opacity: n.attrs?.opacity != null ? Number(n.attrs.opacity) : undefined,
      blendMode: n.attrs?.blendMode,
    }));
  const target = frameById(doc, targetFrameId);
  return {
    targetFrame: target
      ? {
          id: target.id,
          name: target.name,
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          hint: 'Place new elements inside this frame using absolute world coordinates (frame.x + localX).',
        }
      : null,
    frames,
    nodeCount: nodes.length,
    nodes,
  };
}

function applyCornerRadius(node: SceneNodeInput, r: number) {
  const v = Math.max(0, Math.round(r));
  node.attrs = {
    ...node.attrs,
    radiusTL: v,
    radiusTR: v,
    radiusBR: v,
    radiusBL: v,
    radiusLinked: 'true',
    radius: v,
    cornerRadius: v,
  };
}

function truthy(v: unknown) {
  return v === true || v === 'true';
}

function parseMeshPoints(raw: unknown, size: MeshSize, base: string) {
  if (!Array.isArray(raw) || !raw.length) return createMeshGrid(size, base);
  return raw.map((p: any) => ({
    x: Math.min(100, Math.max(0, Number(p?.x) || 0)),
    y: Math.min(100, Math.max(0, Number(p?.y) || 0)),
    color: String(p?.color || base),
  }));
}

function applyShapeFill(
  node: SceneNodeInput,
  args: Record<string, unknown>,
  fallbackFill: string
) {
  const fillType = String(args.fillType || 'solid').toLowerCase();
  const c0 = String(args.fill ?? fallbackFill);
  const c1 = String(args.fillEnd ?? c0);
  const fillOpacity =
    args.fillOpacity != null ? Math.min(100, Math.max(0, num(args.fillOpacity, 100))) : undefined;

  if (fillType === 'image') {
    const src = String(args.fillImageSrc ?? '').trim();
    if (!src) {
      node.attrs = {
        ...node.attrs,
        'fill-type': 'solid',
        'fill-color': c0,
        'fill-enabled': 'true',
        'fill-visible': 'true',
        ...(fillOpacity != null ? { 'fill-opacity': fillOpacity } : {}),
      };
      return;
    }
    const fit = String(args.fillImageFit || 'fill').toLowerCase();
    node.attrs = {
      ...node.attrs,
      'fill-type': 'image',
      'fill-enabled': 'true',
      'fill-visible': 'true',
      'fill-color': c0,
      ...serializeFillImageAttrs({
        fillImageSrc: src,
        fillImageFit:
          fit === 'fit' || fit === 'crop' || fit === 'tile' ? fit : 'fill',
        fillImageRotate: args.fillImageRotate != null ? num(args.fillImageRotate, 0) : 0,
        fillImageScale: args.fillImageScale != null ? num(args.fillImageScale, 100) : 100,
        fillImageOffsetX: args.fillImageOffsetX != null ? num(args.fillImageOffsetX, 0) : 0,
        fillImageOffsetY: args.fillImageOffsetY != null ? num(args.fillImageOffsetY, 0) : 0,
      }),
      ...(fillOpacity != null ? { 'fill-opacity': fillOpacity } : {}),
    };
    return;
  }

  if (fillType === 'diffuse') {
    const meshSize = Math.min(8, Math.max(3, Math.round(num(args.meshSize, 4)))) as MeshSize;
    const meshPoints = parseMeshPoints(args.meshPoints, meshSize, c0);
    node.attrs = {
      ...node.attrs,
      'fill-type': 'diffuse',
      'fill-enabled': 'true',
      'fill-visible': 'true',
      'fill-color': c0,
      'fill-gradient': serializeFillGradient({
        type: 'diffuse',
        meshSize,
        meshPoints,
        colorStops: [
          { offset: 0, color: meshPoints[0]?.color || c0 },
          { offset: 1, color: meshPoints[meshPoints.length - 1]?.color || c1 },
        ],
      }),
      ...(fillOpacity != null ? { 'fill-opacity': fillOpacity } : {}),
    };
    return;
  }

  if (fillType === 'linear' || fillType === 'radial' || fillType === 'angular') {
    const angle = num(args.gradientAngle, fillType === 'angular' ? 0 : 90);
    node.attrs = {
      ...node.attrs,
      'fill-type': fillType,
      'fill-enabled': 'true',
      'fill-visible': 'true',
      'fill-color': c0,
      'fill-gradient': serializeFillGradient({
        type: fillType as 'linear' | 'radial' | 'angular',
        angle,
        cx: 50,
        cy: 50,
        r: 70,
        colorStops: [
          { offset: 0, color: c0 },
          { offset: 1, color: c1 },
        ],
      }),
      ...(fillOpacity != null ? { 'fill-opacity': fillOpacity } : {}),
    };
    return;
  }

  node.attrs = {
    ...node.attrs,
    'fill-type': 'solid',
    'fill-color': c0,
    'fill-enabled': 'true',
    'fill-visible': 'true',
    ...(fillOpacity != null ? { 'fill-opacity': fillOpacity } : {}),
  };
}

/** Stroke dash / align / cap / join / opacity / side strokes. */
function applyStrokeExtras(node: SceneNodeInput, args: Record<string, unknown>) {
  const attrs: Record<string, unknown> = { ...(node.attrs || {}) };
  if (args.strokeStyle != null && isStrokeStyle(String(args.strokeStyle))) {
    attrs.strokeStyle = String(args.strokeStyle);
  }
  if (args.strokeAlign != null) {
    const v = String(args.strokeAlign);
    if (v === 'center' || v === 'inside' || v === 'outside') {
      attrs.strokeAlign = v;
    }
  }
  if (args.strokeLinecap != null) {
    const v = String(args.strokeLinecap);
    if (v === 'butt' || v === 'round' || v === 'square') {
      attrs.strokeLinecap = v;
    }
  }
  if (args.strokeLinejoin != null) {
    const v = String(args.strokeLinejoin);
    if (v === 'miter' || v === 'round' || v === 'bevel') {
      attrs.strokeLinejoin = v;
    }
  }
  if (args.strokeOpacity != null) {
    attrs['stroke-opacity'] = Math.min(100, Math.max(0, num(args.strokeOpacity, 100)));
  }
  const sides = args.strokeSides;
  if (sides && typeof sides === 'object' && !Array.isArray(sides)) {
    const s = sides as Record<string, unknown>;
    for (const key of ['T', 'R', 'B', 'L'] as const) {
      if (s[key] != null) attrs[key] = truthy(s[key]) ? 'true' : 'false';
    }
  }
  node.attrs = attrs;
}

function applyShadow(node: SceneNodeInput, args: Record<string, unknown>) {
  const attrs: Record<string, unknown> = { ...(node.attrs || {}) };
  if (args.shadowEnabled != null) {
    attrs['shadow-enabled'] = truthy(args.shadowEnabled) ? 'true' : 'false';
  }
  if (args.shadowVisible != null) {
    attrs['shadow-visible'] = truthy(args.shadowVisible) ? 'true' : 'false';
  }
  if (args.shadowColor != null) attrs['shadow-color'] = String(args.shadowColor);
  if (args.shadowBlur != null) attrs['shadow-blur'] = Math.max(0, num(args.shadowBlur, 4));
  if (args.shadowX != null) attrs['shadow-x'] = num(args.shadowX, 0);
  if (args.shadowY != null) attrs['shadow-y'] = num(args.shadowY, 2);
  // Convenience: any shadow-* field implies enable unless explicitly disabled.
  if (
    attrs['shadow-enabled'] == null &&
    (args.shadowColor != null ||
      args.shadowBlur != null ||
      args.shadowX != null ||
      args.shadowY != null)
  ) {
    attrs['shadow-enabled'] = 'true';
    attrs['shadow-visible'] = 'true';
  }
  node.attrs = attrs;
}

function applyCornerRadii(node: SceneNodeInput, args: Record<string, unknown>) {
  if (args.cornerRadius != null) {
    applyCornerRadius(node, num(args.cornerRadius));
    return;
  }
  const attrs: Record<string, unknown> = { ...(node.attrs || {}) };
  // Multi-corner path / polygon: "12,0,8,…" or number[] → radiusVertices.
  if (args.radiusVertices != null) {
    const parts = Array.isArray(args.radiusVertices)
      ? args.radiusVertices.map((v) => Math.max(0, Math.round(num(v))))
      : String(args.radiusVertices)
          .split(/[,\s]+/)
          .filter(Boolean)
          .map((v) => Math.max(0, Math.round(num(v))));
    if (parts.length) {
      attrs.radiusVertices = parts.join(',');
      attrs.radiusLinked = parts.every((v) => v === parts[0]) ? 'true' : 'false';
      if (parts.length >= 4) {
        attrs.radiusTL = parts[0];
        attrs.radiusTR = parts[1];
        attrs.radiusBR = parts[2];
        attrs.radiusBL = parts[3];
      }
      node.attrs = attrs;
      return;
    }
  }
  const has =
    args.radiusTL != null ||
    args.radiusTR != null ||
    args.radiusBR != null ||
    args.radiusBL != null;
  if (!has) return;
  if (args.radiusTL != null) attrs.radiusTL = Math.max(0, Math.round(num(args.radiusTL)));
  if (args.radiusTR != null) attrs.radiusTR = Math.max(0, Math.round(num(args.radiusTR)));
  if (args.radiusBR != null) attrs.radiusBR = Math.max(0, Math.round(num(args.radiusBR)));
  if (args.radiusBL != null) attrs.radiusBL = Math.max(0, Math.round(num(args.radiusBL)));
  attrs.radiusLinked = 'false';
  node.attrs = attrs;
}

type AgentNodeBox = {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  shapeType: string;
  fill: string;
  stroke: string;
  borderWidth: number;
  path?: string;
  angle?: number;
  sides?: number;
  attrs?: Record<string, unknown>;
};

function readAgentBoxes(doc: SceneDocument, nodeIds: string[]): AgentNodeBox[] {
  return nodeIds
    .map((id) => {
      const node = doc?.deltaSetLike?.[id];
      if (!node) return null;
      const { left, top } = nodeLeftTop(doc, node);
      const pathRaw = node.attrs?.path != null ? String(node.attrs.path) : '';
      const angle = Number(node.attrs?.angle ?? 0) || 0;
      const sidesRaw = Number(node.attrs?.sides);
      return {
        id,
        left,
        top,
        width: Math.max(1, Number(node.width) || 1),
        height: Math.max(1, Number(node.height) || 1),
        shapeType: String(
          node.attrs?.shapeType || (node.key === 'shape' ? 'rect' : node.key || '')
        ),
        fill: String(node.attrs?.['fill-color'] || '#FFFFFF'),
        stroke: String(node.attrs?.['border-color'] || '#333333'),
        borderWidth: Number(node.attrs?.['border-width'] ?? 1) || 1,
        path: pathRaw || undefined,
        angle,
        sides: Number.isFinite(sidesRaw) ? sidesRaw : undefined,
        attrs: node.attrs && typeof node.attrs === 'object' ? { ...node.attrs } : undefined,
      };
    })
    .filter(Boolean) as AgentNodeBox[];
}

function parseNodeIds(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.nodeIds)) return [];
  return [...new Set(args.nodeIds.map((x) => String(x)).filter(Boolean))];
}

/** nodeIds[] or a single nodeId (outline_text / image_process). */
function parseNodeIdsOrSingle(args: Record<string, unknown>): string[] {
  const many = parseNodeIds(args);
  if (many.length) return many;
  const one = String(args.nodeId || '').trim();
  return one ? [one] : [];
}

async function execOutlineText(
  args: Record<string, unknown>,
  _ctx: DesignToolContext,
  _pushHistory: () => void
): Promise<AgentToolResult> {
  const ids = parseNodeIdsOrSingle(args);
  if (!ids.length) {
    return {
      status: 'error',
      summary: 'outline_text requires nodeId or nodeIds',
      next_actions: ['Pass text/shape node id from SCENE'],
    };
  }
  const outlined: string[] = [];
  const failed: string[] = [];
  for (const nodeId of ids) {
    // Kit convertToPath + path-edit.
    if (enterKitPathEditForRcbId(nodeId)) outlined.push(nodeId);
    else failed.push(nodeId);
  }
  if (!outlined.length) {
    return {
      status: 'error',
      summary: `outline_text failed (${failed.join(', ') || 'no valid nodes'})`,
      next_actions: [
        'Ensure Kit canvas is mounted and node is convertible',
        'Or create_shape path / create_svg for letterforms',
      ],
    };
  }
  return {
    status: 'ok',
    summary: `Entered Kit path-edit for ${outlined.length} node(s)${
      failed.length ? `; skipped ${failed.join(', ')}` : ''
    }`,
    data: { nodeIds: outlined, failed },
  };
}

/** Keep new nodes inside the target artboard (models often place outside). */
function normalizeLocalGeom(
  fw: number,
  fh: number,
  x: number,
  y: number,
  width: number,
  height: number
): { x: number; y: number; width: number; height: number; scale: number } {
  let nx = x;
  let ny = y;
  let nw = Math.max(1, width);
  let nh = Math.max(1, height);
  let scale = 1;

  // Normalized 0..1 coords (model forgot × TARGET_CANVAS).
  const looksFrac =
    nx >= 0 &&
    ny >= 0 &&
    nw > 0 &&
    nh > 0 &&
    nx <= 1.01 &&
    ny <= 1.01 &&
    nw <= 1.01 &&
    nh <= 1.01 &&
    (nw < 0.999 || nh < 0.999 || (nx > 0 && nx < 1) || (ny > 0 && ny < 1));
  if (looksFrac) {
    nx = Math.round(nx * fw);
    ny = Math.round(ny * fh);
    nw = Math.max(1, Math.round(nw * fw));
    nh = Math.max(1, Math.round(nh * fh));
  }

  // Poster-scale layout on a small board (e.g. 1080×1920 ops → 390×844).
  const layoutW = Math.max(nx + nw, nw);
  const layoutH = Math.max(ny + nh, nh);
  if (layoutW > fw * 1.45 && layoutW >= 640) {
    scale = fw / layoutW;
    nx = Math.round(nx * scale);
    ny = Math.round(ny * scale);
    nw = Math.max(1, Math.round(nw * scale));
    nh = Math.max(1, Math.round(nh * scale));
  } else if (layoutH > fh * 1.45 && layoutH >= 1000 && layoutW > fw * 1.1) {
    scale = Math.min(fw / layoutW, fh / layoutH);
    if (scale < 0.95) {
      nx = Math.round(nx * scale);
      ny = Math.round(ny * scale);
      nw = Math.max(1, Math.round(nw * scale));
      nh = Math.max(1, Math.round(nh * scale));
    } else {
      scale = 1;
    }
  }

  return { x: nx, y: ny, width: nw, height: nh, scale };
}

function fitIntoFrame(
  frame: ArtboardFrame | null | undefined,
  x: number,
  y: number,
  width: number,
  height: number
): {
  x: number;
  y: number;
  width: number;
  height: number;
  clamped: boolean;
  outside: boolean;
  scale: number;
} {
  if (!frame) {
    return {
      x,
      y,
      width: Math.max(1, width),
      height: Math.max(1, height),
      clamped: false,
      outside: false,
      scale: 1,
    };
  }
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const fw = Math.max(1, Number(frame.width) || 1);
  const fh = Math.max(1, Number(frame.height) || 1);
  const norm = normalizeLocalGeom(fw, fh, x, y, width, height);
  const w = Math.max(1, Math.min(norm.width, fw));
  const h = Math.max(1, Math.min(norm.height, fh));
  // If model passed local coords (0..size) while frame is offset, promote to world.
  let wx = norm.x;
  let wy = norm.y;
  if (norm.x >= 0 && norm.x <= fw && norm.y >= 0 && norm.y <= fh && (fx !== 0 || fy !== 0)) {
    wx = fx + norm.x;
    wy = fy + norm.y;
  }
  const maxX = fx + fw - w;
  const maxY = fy + fh - h;
  const nx = Math.min(Math.max(wx, fx), Math.max(fx, maxX));
  const ny = Math.min(Math.max(wy, fy), Math.max(fy, maxY));
  const sizeClamped = w !== Math.max(1, norm.width) || h !== Math.max(1, norm.height);
  const posClamped = nx !== wx || ny !== wy;
  return {
    x: nx,
    y: ny,
    width: w,
    height: h,
    clamped: sizeClamped || posClamped || norm.scale < 0.999,
    outside: false,
    scale: norm.scale,
  };
}

/** Place size at frame center (world coords), or a small inset when no frame. */
function centerInFrame(
  frame: ArtboardFrame | null | undefined,
  width: number,
  height: number
): { x: number; y: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  if (!frame) return { x: 40, y: 40 };
  const fx = Number(frame.x) || 0;
  const fy = Number(frame.y) || 0;
  const fw = Math.max(1, Number(frame.width) || 1);
  const fh = Math.max(1, Number(frame.height) || 1);
  return {
    x: Math.round(fx + Math.max(0, (fw - w) / 2)),
    y: Math.round(fy + Math.max(0, (fh - h) / 2)),
  };
}

/** Resolve create_* origin: honor model x/y as-is; only fill gaps when omitted. */
function resolveCreateXY(
  args: Record<string, unknown>,
  frame: ArtboardFrame | null | undefined,
  width: number,
  height: number
): { x: number; y: number } {
  const hasX = args.x != null && Number.isFinite(Number(args.x));
  const hasY = args.y != null && Number.isFinite(Number(args.y));
  // Do not reinterpret (0,0) — host/model chose those coords. Fill only missing axes.
  if (!hasX && !hasY) return centerInFrame(frame, width, height);
  const fallback = centerInFrame(frame, width, height);
  return {
    x: hasX ? num(args.x) : fallback.x,
    y: hasY ? num(args.y) : fallback.y,
  };
}

/** Reject creates that would require host geometry rewrite — tell the model via op error. */
function placementRewriteError(
  tool: string,
  args: Record<string, unknown>,
  placed: {
    x: number;
    y: number;
    width: number;
    height: number;
    clamped: boolean;
    scale: number;
  }
): AgentToolResult | null {
  const hasGeom =
    args.x != null ||
    args.y != null ||
    args.width != null ||
    args.height != null;
  if (!hasGeom) return null;
  if (!placed.clamped && !(placed.scale > 0 && placed.scale < 0.999)) return null;
  return {
    status: 'error',
    summary:
      `${tool}_placement_invalid: host will not clamp/scale; ` +
      `re-emit x/y/width/height inside the target frame ` +
      `(refused rewrite → ${Math.round(placed.x)},${Math.round(placed.y)} ` +
      `${Math.round(placed.width)}×${Math.round(placed.height)}).`,
    next_actions: [
      'Use frame-local coords with frameId inside FOCUS_FRAME (0..w, 0..h)',
    ],
  };
}

function requireCreateXY(
  tool: string,
  args: Record<string, unknown>
): AgentToolResult | null {
  const hasX = args.x != null && Number.isFinite(Number(args.x));
  const hasY = args.y != null && Number.isFinite(Number(args.y));
  if (hasX && hasY) return null;
  return {
    status: 'error',
    summary:
      `${tool}_missing_xy: provide numeric x and y ` +
      `(frame-local inside FOCUS_FRAME with frameId, or free-canvas world coords).`,
    next_actions: ['Re-emit create_* with explicit x and y'],
  };
}

const FRAME_GAP = 80;
const NODE_GAP = 12;

type WorldRect = { x: number; y: number; width: number; height: number; id?: string };

function frameRectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  gap = 1
): boolean {
  return (
    ax < bx + bw + gap &&
    ax + aw + gap > bx &&
    ay < by + bh + gap &&
    ay + ah + gap > by
  );
}

function rectHitsAny(
  x: number,
  y: number,
  w: number,
  h: number,
  obstacles: WorldRect[],
  gap: number
): boolean {
  return obstacles.some((o) =>
    frameRectsOverlap(x, y, w, h, o.x, o.y, o.width, o.height, gap)
  );
}

function collectFrameObstacles(doc: SceneDocument): WorldRect[] {
  return listFrames(doc).map((f) => ({
    id: f.id,
    x: Math.round(Number(f.x) || 0),
    y: Math.round(Number(f.y) || 0),
    width: Math.max(1, Math.round(Number(f.width) || 1)),
    height: Math.max(1, Math.round(Number(f.height) || 1)),
  }));
}

function collectNodeObstacles(
  doc: SceneDocument,
  opts?: { frame?: ArtboardFrame | null; excludeIds?: Set<string> }
): WorldRect[] {
  const rootChildren: string[] = Array.isArray(doc?.deltaSetLike?.ROOT?.children)
    ? doc.deltaSetLike.ROOT.children
    : Object.keys(doc?.deltaSetLike || {}).filter((id) => id && id !== 'ROOT');
  const frame = opts?.frame;
  const fx = frame ? Number(frame.x) || 0 : 0;
  const fy = frame ? Number(frame.y) || 0 : 0;
  const fw = frame ? Math.max(1, Number(frame.width) || 1) : 0;
  const fh = frame ? Math.max(1, Number(frame.height) || 1) : 0;
  const out: WorldRect[] = [];
  for (const id of rootChildren) {
    if (!id || opts?.excludeIds?.has(id)) continue;
    const node = doc?.deltaSetLike?.[id];
    if (!node) continue;
    const { left, top } = nodeLeftTop(doc, node);
    const nw = Math.max(1, Math.round(Number(node.width) || 1));
    const nh = Math.max(1, Math.round(Number(node.height) || 1));
    if (frame) {
      const ow = Math.max(0, Math.min(left + nw, fx + fw) - Math.max(left, fx));
      const oh = Math.max(0, Math.min(top + nh, fy + fh) - Math.max(top, fy));
      if (ow * oh < nw * nh * 0.2) continue;
    }
    out.push({
      id: String(id),
      x: Math.round(left),
      y: Math.round(top),
      width: nw,
      height: nh,
    });
  }
  return out;
}

/** Scan for free top-left; prefers `prefer` when free. */
function findFreeOrigin(opts: {
  width: number;
  height: number;
  obstacles: WorldRect[];
  prefer?: { x: number; y: number };
  bounds?: { x: number; y: number; width: number; height: number };
  gap?: number;
  step?: number;
}): { x: number; y: number } | null {
  const w = Math.max(1, Math.round(opts.width));
  const h = Math.max(1, Math.round(opts.height));
  const gap = opts.gap ?? NODE_GAP;
  const step = Math.max(8, opts.step ?? Math.max(24, Math.round(Math.min(w, h) / 2)));
  const obstacles = opts.obstacles;
  const prefer = opts.prefer
    ? { x: Math.round(opts.prefer.x), y: Math.round(opts.prefer.y) }
    : null;

  const inBounds = (x: number, y: number) => {
    if (!opts.bounds) return true;
    const b = opts.bounds;
    return (
      x >= b.x - 0.5 &&
      y >= b.y - 0.5 &&
      x + w <= b.x + b.width + 0.5 &&
      y + h <= b.y + b.height + 0.5
    );
  };

  if (
    prefer &&
    inBounds(prefer.x, prefer.y) &&
    !rectHitsAny(prefer.x, prefer.y, w, h, obstacles, gap)
  ) {
    return prefer;
  }

  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  if (opts.bounds) {
    minX = Math.round(opts.bounds.x);
    minY = Math.round(opts.bounds.y);
    maxX = Math.round(opts.bounds.x + opts.bounds.width - w);
    maxY = Math.round(opts.bounds.y + opts.bounds.height - h);
  } else {
    let maxRight = 0;
    let maxBottom = 0;
    for (const o of obstacles) {
      maxRight = Math.max(maxRight, o.x + o.width);
      maxBottom = Math.max(maxBottom, o.y + o.height);
    }
    minX = prefer?.x ?? (obstacles.length ? Math.round(maxRight + gap) : 0);
    minY = prefer?.y ?? 0;
    maxX = Math.round(maxRight + gap + w * 6 + 400);
    maxY = Math.round(maxBottom + gap + h * 4 + 400);
  }
  if (maxX < minX || maxY < minY) return null;

  for (let y = minY; y <= maxY; y += step) {
    for (let x = minX; x <= maxX; x += step) {
      if (!inBounds(x, y)) continue;
      if (!rectHitsAny(x, y, w, h, obstacles, gap)) return { x, y };
    }
  }
  if (prefer) {
    const fine = Math.max(4, Math.round(step / 2));
    const x0 = Math.max(minX, prefer.x - step * 2);
    const y0 = Math.max(minY, prefer.y - step * 2);
    const x1 = Math.min(maxX, prefer.x + step * 4);
    const y1 = Math.min(maxY, prefer.y + step * 4);
    for (let y = y0; y <= y1; y += fine) {
      for (let x = x0; x <= x1; x += fine) {
        if (!inBounds(x, y)) continue;
        if (!rectHitsAny(x, y, w, h, obstacles, gap)) return { x, y };
      }
    }
  }
  return null;
}

/** Place a new artboard in empty world space (no overlap with frames or free nodes). */
export function nextArtboardOrigin(
  doc: SceneDocument,
  width = 390,
  height = 844
): { x: number; y: number } {
  const frames = listFrames(doc);
  const w = Math.max(40, Math.round(Number(width) || 390));
  const h = Math.max(40, Math.round(Number(height) || 844));
  const nodeObs = collectNodeObstacles(doc);
  if (!frames.length && !nodeObs.length) return { x: 0, y: 0 };

  const obstacles = [...collectFrameObstacles(doc), ...nodeObs];
  let maxRight = 0;
  let anchorY = 0;
  for (const f of frames) {
    const right = Number(f.x || 0) + Number(f.width || 0);
    if (right >= maxRight) {
      maxRight = right;
      anchorY = Math.round(Number(f.y) || 0);
    }
  }
  for (const o of obstacles) {
    maxRight = Math.max(maxRight, o.x + o.width);
  }

  const prefer = {
    x: Math.round((frames.length ? maxRight : 0) + (frames.length ? FRAME_GAP : 0)),
    y: anchorY,
  };
  const slot = findFreeOrigin({
    width: w,
    height: h,
    obstacles,
    prefer,
    gap: FRAME_GAP,
    step: Math.max(40, Math.round(FRAME_GAP / 2)),
  });
  if (slot) return slot;

  let maxBottom = 0;
  for (const o of obstacles) {
    maxBottom = Math.max(maxBottom, o.y + o.height);
  }
  return { x: 0, y: Math.round(maxBottom + FRAME_GAP) };
}

function execCreateShape(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {

  const shapeType = String(args.shapeType || 'rect');
  const mapped = mapCreateShapeType(shapeType);
  const width = Math.max(1, num(args.width, 120));
  const height = Math.max(1, num(args.height, 80));
  const target = ctx.targetFrameId ? frameById(doc, ctx.targetFrameId) : null;
  const missXY = requireCreateXY('create_shape', args);
  if (missXY) return missXY;
  const svgRaw = pickSvgMarkup(args);
  // Icon SVG → native svg node (not image, not path conversion).
  if (svgRaw.trim() || mapped === 'svg') {
    if (!svgRaw.trim()) {
      return {
        status: 'error',
        summary: 'create_shape type=svg requires args.svg markup.',
        next_actions: ['Pass args.svg', 'or use create_svg'],
      };
    }
    const origin = resolveCreateXY(args, target, width, height);
    const placed = fitIntoFrame(target, origin.x, origin.y, width, height);
    const placeErr = placementRewriteError('create_shape', args, placed);
    if (placeErr) return placeErr;
    const fill = args.fill != null ? String(args.fill) : undefined;
    const { id, node } = createSvgNode({
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      svg: svgRaw,
      name: String(args.name || 'SVG'),
      fill,
    });
    console.info('[create_shape → svg node]', {
      id,
      placed,
      fill,
      svgHead: svgRaw.slice(0, 160),
    });
    pushHistory();
    setDocument(addNodeToDocument(ctx.getDocument(), id, node));
    return {
      status: 'success',
      summary: `Created svg ${id}`,
      artifacts: { nodeId: id, shapeType: 'svg' },
      next_actions: ['Continue layout or create_text'],
    };
  }
  const path = args.path != null ? String(args.path) : '';
  // Honor model x/y when provided; otherwise center in the target frame.
  const origin = resolveCreateXY(args, target, width, height);
  const placed = fitIntoFrame(target, origin.x, origin.y, width, height);
  const placeErr = placementRewriteError('create_shape', args, placed);
  if (placeErr) return placeErr;
  if (mapped === 'path' || path) {
    console.info('[create_shape path diag]', {
      source: 'model tool_ops path (pass-through)',
      argsXY: { x: args.x, y: args.y, width: args.width, height: args.height },
      placed: { x: placed.x, y: placed.y, width: placed.width, height: placed.height },
      fill: args.fill,
      pathLen: path.length,
      pathHead: path.slice(0, 180),
      fullPath: path,
    });
  }
  const isFreePath = mapped === 'path';
  const closed = resolvePathClosed({ args, mapped, path });
  const isStrokeOnly = mapped === 'line' || mapped === 'arrow' || mapped === 'pencil';
  const fillDefault = defaultCreateShapeFill({ args, isStrokeOnly, isFreePath, closed });
  const fillIsNone =
    !fillDefault ||
    fillDefault === 'transparent' ||
    fillDefault === 'none' ||
    fillDefault === 'rgba(0,0,0,0)';
  // Free paths (SVG → path): never invent a border/fill — honor args as-is.
  // Pen/pencil/line still need a visible stroke when the model omits one.
  const needsDefaultStroke =
    !isFreePath &&
    (isStrokeOnly || mapped === 'pen' || mapped === 'pencil' || fillIsNone);
  const stroke = resolveCreateShapeStroke({ args, needsDefaultStroke });
  const strokeIsNone = stroke === 'transparent';
  const borderWidth = resolveCreateShapeBorderWidth({
    args,
    mapped,
    isFreePath,
    needsDefaultStroke,
    isStrokeOnly,
    strokeIsNone,
  });
  const opacityRaw = args.opacity != null ? num(args.opacity, 1) : 1;
  const opacity = opacityRaw > 1 ? Math.min(1, opacityRaw / 100) : Math.min(1, Math.max(0, opacityRaw));
  const brushStyle = resolvePencilBrushStyle(mapped, args);
  const pathPressure =
    mapped === 'pencil' ? normalizePathPressureArg(args.pathPressure) : undefined;
  const pressureEnabled =
    mapped === 'pencil'
      ? normalizePressureEnabledArg(args.pressureEnabled, {
          hasPathPressure: Boolean(pathPressure),
        })
      : undefined;
  const { id, node } = createShapeNode({
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    shapeType: mapped,
    fill: fillDefault,
    stroke,
    borderWidth,
    path: path || undefined,
    closed: mapped === 'pencil' ? false : closed,
    sides: args.sides != null ? num(args.sides, 5) : undefined,
    angle: args.rotation != null ? num(args.rotation) : undefined,
    brushStyle,
    pressureEnabled,
    pathPressure,
    opacity,
  });
  applyShapeFill(node, args, fillDefault);
  applyStrokeExtras(node, args);
  applyShadow(node, args);
  if (borderWidth <= 0 || strokeIsNone) {
    node.attrs = {
      ...node.attrs,
      'stroke-enabled': 'false',
      'stroke-visible': 'false',
      'border-width': 0,
    };
  }
  if (fillIsNone) {
    node.attrs = {
      ...node.attrs,
      'fill-enabled': 'false',
      'fill-visible': 'false',
    };
  }
  if (args.name) {
    (node.attrs as Record<string, unknown>).name = String(args.name);
  }
  applyCornerRadii(node, args);
  if (closed) node.attrs = { ...node.attrs, closed: 'true' };
  pushHistory();
  setDocument(addNodeToDocument(ctx.getDocument(), id, node));
  return {
    status: 'success',
    summary: `Created ${mapped} ${id}${path ? ' (path)' : ''}`,
    artifacts: { nodeId: id, shapeType: mapped },
    next_actions: ['Continue layout or create_text'],
  };
}

function execCreatePath(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const points = readScenePoints(args.points);
  const closed = truthy(args.closed);
  if (points.length < 2) {
    return {
      status: 'error',
      summary: 'create_path requires points (>=2)',
      next_actions: ['Pass points as [[x,y], ...]'],
    };
  }
  return execCreateShape(
    {
      ...args,
      shapeType: 'path',
      path: pointsToPath(points, closed),
      closed,
    },
    ctx,
    doc,
    pushHistory
  );
}

function execCreateText(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {

  const text = String(args.text ?? '');
  const missXY = requireCreateXY('create_text', args);
  if (missXY) return missXY;
  const target = ctx.targetFrameId ? frameById(doc, ctx.targetFrameId) : null;
  // Fixed width+height = label-in-box (button/chip); do not hug content.
  const boxMode = args.width != null && args.height != null;
  const baseStyle = parseNodeTextStyle({});
  const nextStyle: Record<string, unknown> = { ...baseStyle };
  if (args.fontSize != null) {
    nextStyle.fontSize = num(args.fontSize, 14);
  } else {
    const zoom = Math.max(0.05, ctx.canvasUi?.getZoom?.() ?? 1);
    const docW = Math.max(0, Number(doc.width) || 0);
    const vp = ctx.canvasUi?.getViewportSceneBounds?.();
    nextStyle.fontSize = rcbPlaceTextFontSize(zoom, undefined, {
      viewportWidth: vp?.width,
      docWidth: docW > 0 ? docW : undefined,
    });
  }
  const textFill = args.fill;
  if (textFill != null) nextStyle.fill = String(textFill);
  if (args.fontWeight != null) nextStyle.fontWeight = String(args.fontWeight);
  if (args.fontFamily != null) nextStyle.fontFamily = String(args.fontFamily);
  if (args.fontStyle != null) nextStyle.fontStyle = String(args.fontStyle);
  if (args.textAlign != null) nextStyle.textAlign = String(args.textAlign);
  else if (boxMode) nextStyle.textAlign = 'center';
  // Hug labels use tight leading; fixed boxes keep 1.4 unless caller sets it.
  if (args.lineHeight != null) nextStyle.lineHeight = num(args.lineHeight, 1.4);
  else if (!boxMode) nextStyle.lineHeight = 1.15;
  if (args.letterSpacing != null) nextStyle.letterSpacing = num(args.letterSpacing, 0);
  if (args.textDecoration != null) {
    nextStyle.textDecoration = String(args.textDecoration);
  }
  const measured = measurePlainTextSize(text || ' ', nextStyle);
  const wantWrap = args.wrap === true || args.wrap === 'true';
  const singleLine = !String(text).includes('\n');
  // Agent often copies full-bleed "width:W-48" for short titles — clamp to ink
  // unless this is an explicit label-in-box or wrap column.
  let boxW: number;
  if (boxMode) {
    boxW = Math.max(1, num(args.width));
  } else if (args.width != null) {
    const asked = Math.max(1, num(args.width));
    if (
      !wantWrap &&
      singleLine &&
      asked > measured.width * 1.35 &&
      measured.width > 0
    ) {
      boxW = measured.width;
    } else {
      boxW = asked;
    }
  } else {
    boxW = measured.width;
  }
  let boxH: number;
  if (args.height != null) {
    boxH = Math.max(1, num(args.height));
  } else if (args.width != null && (wantWrap || boxW === Math.max(1, num(args.width)))) {
    boxH = measureWrappedTextSize(text || ' ', nextStyle, boxW).height;
  } else {
    boxH = measured.height;
  }
  // Labels must sit on top of buttons — never nudge away from overlapping shapes.
  const textOrigin = resolveCreateXY(args, target, boxW, boxH);
  const placed = fitIntoFrame(target, textOrigin.x, textOrigin.y, boxW, boxH);
  const placeErr = placementRewriteError('create_text', args, placed);
  if (placeErr) return placeErr;
  const { id, node } = createTextNode({
    x: placed.x,
    y: placed.y,
    text,
    width: placed.width,
    height: placed.height,
    autoSize: !boxMode,
  });
  const shell = {
    attrs: {
      ...buildMarkdownTextAttrs(text, nextStyle),
      autoSize: boxMode ? 'false' : 'true',
      ...(args.name ? { name: String(args.name) } : {}),
    } as Record<string, unknown>,
  };
  applyShadow(shell, args);
  if (args.opacity != null) {
    const o = num(args.opacity, 1);
    shell.attrs.opacity = o > 1 ? Math.min(1, o / 100) : Math.min(1, Math.max(0, o));
  }
  if (args.blendMode != null) shell.attrs.blendMode = String(args.blendMode);
  // shell.attrs is widened for applyShadow; text nodes still require markdown/DATA fields.
  node.attrs = shell.attrs as typeof node.attrs;
  node.width = placed.width;
  node.height = placed.height;
  pushHistory();
  setDocument(addNodeToDocument(ctx.getDocument(), id, node));
  return {
    status: 'success',
    summary: `Created text ${id} (${Math.round(placed.width)}×${Math.round(placed.height)})`,
    artifacts: { nodeId: id },
  };
}


const UPDATE_NODE_STYLE_ARG_KEYS = [
  'stroke',
  'borderWidth',
  'strokeStyle',
  'strokeAlign',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeOpacity',
  'strokeSides',
  'shadowEnabled',
  'shadowVisible',
  'shadowColor',
  'shadowBlur',
  'shadowX',
  'shadowY',
  'cornerRadius',
  'radiusTL',
  'radiusTR',
  'radiusBR',
  'radiusBL',
  'radiusVertices',
  'opacity',
  'rotation',
  'flipX',
  'flipY',
  'hidden',
  'locked',
  'blendMode',
  'path',
  'closed',
  'name',
  'sides',
  'brushStyle',
  'pathPressure',
  'pressureEnabled',
  'text',
  'fontSize',
  'fontWeight',
  'fontFamily',
  'fontStyle',
  'textAlign',
  'lineHeight',
  'letterSpacing',
  'textDecoration',
] as const;

function updateNodeFillTouched(args: Record<string, unknown>): boolean {
  return (
    args.fillType != null ||
    args.fill != null ||
    args.fillEnd != null ||
    args.gradientAngle != null ||
    args.meshSize != null ||
    args.meshPoints != null ||
    args.fillImageSrc != null ||
    args.fillOpacity != null
  );
}

function patchUpdateNodeGeometry(
  patch: Record<string, unknown>,
  args: Record<string, unknown>,
  latest: any,
  doc: SceneDocument,
  targetFrameId: string | null | undefined
) {
  const argWidth = args.width;
  const argHeight = args.height;
  if (args.x != null && args.y != null) {
    const target = targetFrameId ? frameById(doc, targetFrameId) : null;
    const w =
      argWidth != null
        ? Math.max(1, num(argWidth))
        : Math.max(1, Number(latest.width) || 1);
    const h =
      argHeight != null
        ? Math.max(1, num(argHeight))
        : Math.max(1, Number(latest.height) || 1);
    const placed = fitIntoFrame(target, num(args.x), num(args.y), w, h);
    patch.x = placed.x;
    patch.y = placed.y;
    if (argWidth != null) patch.width = placed.width;
    if (argHeight != null) patch.height = placed.height;
    return { argWidth, argHeight };
  }
  if (args.x != null) patch.x = num(args.x);
  if (args.y != null) patch.y = num(args.y);
  if (argWidth != null) patch.width = Math.max(1, num(argWidth));
  if (argHeight != null) patch.height = Math.max(1, num(argHeight));
  return { argWidth, argHeight };
}

function applyUpdateNodeTextPatch(opts: {
  latest: any;
  shell: { attrs: Record<string, unknown> };
  args: Record<string, unknown>;
  fillRaw: unknown;
  argWidth: unknown;
  argHeight: unknown;
  patch: Record<string, unknown>;
}) {
  const { latest, shell, args, fillRaw, argWidth, argHeight, patch } = opts;
  if (latest.key !== 'text') return;
  const stylePatch: Record<string, unknown> = {};
  if (args.fontSize != null) stylePatch.fontSize = num(args.fontSize);
  if (args.fontWeight != null) stylePatch.fontWeight = String(args.fontWeight);
  if (args.fontFamily != null) stylePatch.fontFamily = String(args.fontFamily);
  if (args.fontStyle != null) stylePatch.fontStyle = String(args.fontStyle);
  if (args.textAlign != null) stylePatch.textAlign = String(args.textAlign);
  if (args.lineHeight != null) stylePatch.lineHeight = num(args.lineHeight, 1.4);
  if (args.letterSpacing != null) stylePatch.letterSpacing = num(args.letterSpacing, 0);
  if (args.textDecoration != null) stylePatch.textDecoration = String(args.textDecoration);
  if (args.fill != null && fillRaw == null) {
    shell.attrs['fill-color'] = String(args.fill);
    shell.attrs['fill-type'] = 'solid';
    stylePatch.fill = String(args.fill);
  }
  if (args.text == null && !Object.keys(stylePatch).length) return;
  const style = {
    ...parseNodeTextStyle({ ...(latest.attrs || {}), ...shell.attrs }),
    ...stylePatch,
  };
  const nextText =
    args.text != null ? String(args.text) : String(latest.attrs?.text || '');
  Object.assign(shell.attrs, buildMarkdownTextAttrs(nextText, style as any));
  if (argWidth == null || argHeight == null) {
    const measured = measurePlainTextSize(nextText, style as any);
    if (argWidth == null) patch.width = measured.width;
    if (argHeight == null) patch.height = measured.height;
  }
}

function updateNodeStyleArgsTouched(
  args: Record<string, unknown>,
  opts: { fillTouched: boolean; shapeTypeRaw: unknown; latest: any }
): boolean {
  if (opts.fillTouched) return true;
  if (opts.shapeTypeRaw != null) return true;
  if (opts.latest.key === 'image' && args.src != null) return true;
  return UPDATE_NODE_STYLE_ARG_KEYS.some((k) => args[k] != null);
}

function execUpdateNode(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '');
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const latest = ctx.getDocument()?.deltaSetLike?.[nodeId];
  if (!latest) return { status: 'error', summary: `Node not found: ${nodeId}` };

  const patch: Record<string, unknown> = {};
  const { argWidth, argHeight } = patchUpdateNodeGeometry(
    patch,
    args,
    latest,
    doc,
    ctx.targetFrameId
  );

  const shell = { attrs: { ...(latest.attrs || {}) } as Record<string, unknown> };
  const fillRaw = args.fill;
  const fillTypeArg =
    args.fillType != null ? String(args.fillType).toLowerCase() : null;
  const fillTouched = updateNodeFillTouched(args);

  if (fillTouched) {
    applyShapeFill(
      shell,
      {
        ...args,
        fillType: fillTypeArg || 'solid',
        fill: fillRaw ?? shell.attrs['fill-color'] ?? '#FFFFFF',
      },
      String(fillRaw ?? shell.attrs['fill-color'] ?? '#FFFFFF')
    );
  }

  if (args.stroke != null) {
    shell.attrs['border-color'] = String(args.stroke);
    shell.attrs['stroke-enabled'] = 'true';
    shell.attrs['stroke-visible'] = 'true';
  }
  if (args.borderWidth != null) {
    const bw = num(args.borderWidth);
    shell.attrs['border-width'] = bw;
    shell.attrs['stroke-enabled'] = bw <= 0 ? 'false' : 'true';
    shell.attrs['stroke-visible'] = bw <= 0 ? 'false' : 'true';
  }
  applyStrokeExtras(shell, args);
  applyShadow(shell, args);
  applyCornerRadii(shell, args);

  if (args.opacity != null) {
    const o = num(args.opacity, 1);
    shell.attrs.opacity = o > 1 ? Math.min(1, o / 100) : Math.min(1, Math.max(0, o));
  }
  if (args.rotation != null) shell.attrs.angle = num(args.rotation);
  if (args.flipX != null) shell.attrs.flipX = truthy(args.flipX) ? 'true' : 'false';
  if (args.flipY != null) shell.attrs.flipY = truthy(args.flipY) ? 'true' : 'false';
  if (args.hidden != null) shell.attrs.hidden = truthy(args.hidden) ? 'true' : 'false';
  if (args.locked != null) shell.attrs.locked = truthy(args.locked) ? 'true' : 'false';
  if (args.blendMode != null) shell.attrs.blendMode = String(args.blendMode);
  if (args.path != null) shell.attrs.path = String(args.path);
  if (args.closed != null) shell.attrs.closed = truthy(args.closed) ? 'true' : 'false';
  if (args.name != null) shell.attrs.name = String(args.name);

  if (args.brushStyle != null) {
    const nextStyle = resolveUpdateBrushStyle(args, shell.attrs);
    if (nextStyle) {
      shell.attrs.brushStyle = nextStyle;
    }
  }
  if (args.pathPressure != null) {
    const pp = normalizePathPressureArg(args.pathPressure);
    if (pp) shell.attrs.pathPressure = pp;
    else delete shell.attrs.pathPressure;
  }
  if (args.pressureEnabled != null || args.pathPressure != null) {
    const hasPp = Boolean(
      shell.attrs.pathPressure != null && String(shell.attrs.pathPressure).trim()
    );
    const pe = normalizePressureEnabledArg(args.pressureEnabled, {
      hasPathPressure: hasPp,
    });
    if (pe != null) shell.attrs.pressureEnabled = pe;
  }
  const shapeTypeRaw = args.shapeType;
  if (shapeTypeRaw != null && String(shapeTypeRaw).trim() && latest.key === 'shape') {
    const st = String(shapeTypeRaw).trim().toLowerCase();
    shell.attrs.shapeType = st === 'ellipse' ? 'circle' : st;
  }
  if (args.sides != null && latest.key === 'shape') {
    shell.attrs.sides = Math.max(3, Math.round(num(args.sides, 5)));
  }
  if (latest.key === 'image' && args.src != null) {
    shell.attrs.src = String(args.src);
  }

  applyUpdateNodeTextPatch({
    latest,
    shell,
    args,
    fillRaw,
    argWidth,
    argHeight,
    patch,
  });

  if (
    updateNodeStyleArgsTouched(args, {
      fillTouched,
      shapeTypeRaw,
      latest,
    })
  ) {
    patch.attrs = shell.attrs;
  }
  if (!Object.keys(patch).length) {
    return {
      status: 'warning',
      summary: `No updatable fields for ${nodeId}`,
      artifacts: { nodeId },
    };
  }
  patchDocumentNode({ nodeId, patch });
  return {
    status: 'success',
    summary: `Updated ${nodeId}`,
    artifacts: { nodeId },
  };
}

function execEditPathPoints(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '').trim();
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const resolved = resolveEditablePathNode(doc, nodeId);
  if ('error' in resolved) return resolved.error;
  const points = readScenePoints(args.points);
  if (points.length < 2) {
    return { status: 'error', summary: 'edit_path_points requires points (>=2)' };
  }
  const closed =
    args.closed != null ? truthy(args.closed) : truthy(resolved.node.attrs?.closed);
  return execUpdateNode(
    {
      nodeId,
      path: pointsToPath(points, closed),
      closed,
    },
    ctx,
    doc,
    pushHistory
  );
}

function execAppendPathPoints(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '').trim();
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const resolved = resolveEditablePathNode(doc, nodeId);
  if ('error' in resolved) return resolved.error;
  const extra = readScenePoints(args.points);
  if (extra.length < 1) {
    return { status: 'error', summary: 'append_path_points requires args.points (>=1)' };
  }
  const current = parsePathPoints(String(resolved.node.attrs?.path || ''));
  const closed =
    args.closed != null ? truthy(args.closed) : current.closed || truthy(resolved.node.attrs?.closed);
  const next = [...current.points, ...extra];
  if (next.length < 2) {
    return { status: 'error', summary: 'append_path_points needs at least 2 total points' };
  }
  return execUpdateNode(
    {
      nodeId,
      path: pointsToPath(next, closed),
      closed,
    },
    ctx,
    doc,
    pushHistory
  );
}

function execSimplifyPath(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '').trim();
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const resolved = resolveEditablePathNode(doc, nodeId);
  if ('error' in resolved) return resolved.error;
  const current = parsePathPoints(String(resolved.node.attrs?.path || ''));
  if (current.points.length < 3) {
    return {
      status: 'warning',
      summary: `Path ${nodeId} already has ${current.points.length} point(s)`,
      artifacts: { nodeId, pointCount: current.points.length },
    };
  }
  const tolerance = Math.max(0.25, num(args.tolerance, 2));
  const simplified = simplifyPolyline(current.points, tolerance);
  const closed = current.closed || truthy(resolved.node.attrs?.closed);
  if (simplified.length < 2) {
    return { status: 'error', summary: `simplify_path collapsed ${nodeId}` };
  }
  return execUpdateNode(
    {
      nodeId,
      path: pointsToPath(simplified, closed),
      closed,
    },
    ctx,
    doc,
    pushHistory
  );
}

function execSmoothPath(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '').trim();
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const resolved = resolveEditablePathNode(doc, nodeId);
  if ('error' in resolved) return resolved.error;
  const current = parsePathPoints(String(resolved.node.attrs?.path || ''));
  if (current.points.length < 3) {
    return {
      status: 'warning',
      summary: `Path ${nodeId} needs at least 3 points to smooth`,
      artifacts: { nodeId, pointCount: current.points.length },
    };
  }
  const closed = current.closed || truthy(resolved.node.attrs?.closed);
  const iterations = Math.max(1, Math.min(4, Math.round(num(args.iterations, 1))));
  const smoothed = smoothPolyline(current.points, iterations, closed);
  return execUpdateNode(
    {
      nodeId,
      path: pointsToPath(smoothed, closed),
      closed,
    },
    ctx,
    doc,
    pushHistory
  );
}

function execClosePath(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const nodeId = String(args.nodeId || '').trim();
  if (!nodeId) return { status: 'error', summary: 'nodeId required' };
  const resolved = resolveEditablePathNode(doc, nodeId);
  if ('error' in resolved) return resolved.error;
  const current = parsePathPoints(String(resolved.node.attrs?.path || ''));
  if (current.points.length < 3) {
    return {
      status: 'error',
      summary: `close_path needs at least 3 points (${nodeId})`,
    };
  }
  if (current.closed || truthy(resolved.node.attrs?.closed)) {
    return {
      status: 'warning',
      summary: `Path ${nodeId} is already closed`,
      artifacts: { nodeId },
    };
  }
  return execUpdateNode(
    {
      nodeId,
      path: pointsToPath(current.points, true),
      closed: true,
    },
    ctx,
    doc,
    pushHistory
  );
}

const BRUSH_PRESET_MAP: Record<
  string,
  { brushStyle: string; borderWidth: number; pressureEnabled: boolean }
> = {
  ink: { brushStyle: 'vector-ink', borderWidth: 2, pressureEnabled: true },
  pencil: { brushStyle: 'vector-pencil', borderWidth: 2, pressureEnabled: true },
  marker: { brushStyle: 'vector-marker', borderWidth: 6, pressureEnabled: false },
  calligraphy: { brushStyle: 'vector-calligraphy', borderWidth: 4, pressureEnabled: true },
  brush: { brushStyle: 'vector-brush', borderWidth: 5, pressureEnabled: true },
};

function execApplyBrushPreset(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const preset = String(args.preset || '').trim().toLowerCase();
  const spec = BRUSH_PRESET_MAP[preset];
  if (!spec) {
    return {
      status: 'error',
      summary: `Unknown brush preset: ${preset || '(empty)'}`,
      next_actions: [`Use one of: ${Object.keys(BRUSH_PRESET_MAP).join('|')}`],
    };
  }
  const ids = parseNodeIds(args);
  if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
  const done: string[] = [];
  for (const nodeId of ids) {
    const node = doc.deltaSetLike?.[nodeId];
    if (!node || node.key !== 'shape') continue;
    const shapeType = String(node.attrs?.shapeType || '').toLowerCase();
    const editable = shapeType === 'path' || shapeType === 'pen' || shapeType === 'pencil';
    if (!editable) continue;
    const result = execUpdateNode(
      {
        nodeId,
        brushStyle: spec.brushStyle,
        borderWidth: spec.borderWidth,
        pressureEnabled: spec.pressureEnabled,
      },
      ctx,
      doc,
      pushHistory
    );
    if (result.status !== 'error') done.push(nodeId);
  }
  if (!done.length) {
    return {
      status: 'error',
      summary: 'No editable path/pen/pencil nodes found for apply_brush_preset',
      artifacts: { requestedNodeIds: ids },
    };
  }
  return {
    status: 'success',
    summary: `Applied preset ${preset} to ${done.length} node(s)`,
    artifacts: { nodeIds: done, preset },
  };
}

function execCreateFrame(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {

  const beforeIds = new Set(listFrames(doc).map((f) => f.id));
  const width = Math.max(40, num(args.width, 390));
  const height = Math.max(40, num(args.height, 844));
  const hasExplicitXY = args.x != null || args.y != null;
  let x = num(args.x, 0);
  let y = num(args.y, 0);
  // Default (0,0) on a non-empty doc overlaps the first artboard — shift right.
  if ((!hasExplicitXY || (x === 0 && y === 0)) && listFrames(doc).length > 0) {
    const slot = nextArtboardOrigin(doc, width, height);
    x = slot.x;
    y = slot.y;
  } else if (listFrames(doc).length > 0) {
    const overlaps = listFrames(doc).some((f) =>
      frameRectsOverlap(
        x,
        y,
        width,
        height,
        Number(f.x) || 0,
        Number(f.y) || 0,
        Number(f.width) || 0,
        Number(f.height) || 0
      )
    );
    if (overlaps) {
      const slot = nextArtboardOrigin(doc, width, height);
      x = slot.x;
      y = slot.y;
    }
  }
  // Default white artboard — thematic colors belong in the color phase.
  const backgroundColor =
    args.backgroundColor != null ? String(args.backgroundColor) : '#FFFFFF';
  addArtboardFrame({
      name: String(args.name || 'Frame'),
      x,
      y,
      width,
      height,
      backgroundColor,
      // Agent tools never auto-select; user must click the artboard.
      activate: false,
    });
  const frames = listFrames(ctx.getDocument());
  const created =
    frames.find((f) => !beforeIds.has(f.id)) || frames[frames.length - 1] || null;
  if (!created?.id) {
    return {
      status: 'error',
      summary: 'create_frame failed — frame missing from document after write',
      next_actions: ['Retry create_frame', 'get_scene_summary'],
    };
  }
  return {
    status: 'success',
    summary: `Created frame ${created.id} "${created.name}" at (${Math.round(created.x)},${Math.round(created.y)}) ${Math.round(created.width)}×${Math.round(created.height)}`,
    artifacts: {
      frameId: created.id,
      x: created.x,
      y: created.y,
      width: created.width,
      height: created.height,
    },
    next_actions: ['create_shape', 'create_text inside this new frame'],
  };
}

function execGetSceneSummary(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  const summary = sceneSummary(doc, ctx.targetFrameId);
  return {
    status: 'success',
    summary: `Scene: ${summary.frames.length} frames, ${summary.nodeCount} nodes`,
    artifacts: summary,
  };
}

function execListCapabilities(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ui = ctx.canvasUi;
    const keys = [...getAllowedCanvasToolKeys()].sort();
    const available = [
      keys.length
        ? `Canvas tool_ops (design_canvas_tool): ${keys.join(' / ')}`
        : 'Canvas tool_ops: catalog not synced yet (Admin maintains design_canvas_tool)',
      'Style: solid/linear/radial/angular/diffuse/image fill, stroke dash, shadow, blend, radius, typography',
      ui?.setZoom || ui?.zoomIn
        ? 'Viewport: set_viewport (zoom / fit)'
        : null,
      ui?.setCollabMode
        ? 'Agent mode: set_agent_mode (collaborative|milestone|auto)'
        : null,
      ui?.setLayersOpen || ui?.setMinimapOpen
        ? `Panels: toggle_editor_panel (${supportedTogglePanelIds().join('|')})`
        : null,
    ].filter(Boolean);
    return {
      status: 'success',
      summary: 'Listed available and unavailable canvas capabilities for Agent',
      artifacts: {
        available,
        tool_ops: keys,
        unavailable: UNAVAILABLE_CAPABILITIES,
        zoom: ui?.getZoom?.() ?? null,
        collabMode: ui?.getCollabMode?.() ?? null,
      },
      next_actions: [
        'Call wired tools directly',
        'For unavailable capabilities, tell the user the manual path; do not pretend they ran',
      ],
    };

}

function execSetViewport(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ui = ctx.canvasUi;
    const action = String(args.action || '').toLowerCase();
    if (!ui?.zoomIn && !ui?.setZoom && !ui?.fitView) {
      return {
        status: 'error',
        summary: 'Zoom bridge missing in this session. Use the bottom-left zoom control.',
      };
    }
    if (action === 'zoom_in') {
      ui.zoomIn?.();
      return {
        status: 'success',
        summary: `Zoomed in (~${Math.round((ui.getZoom?.() || 1) * 100)}%)`,
      };
    }
    if (action === 'zoom_out') {
      ui.zoomOut?.();
      return {
        status: 'success',
        summary: `Zoomed out (~${Math.round((ui.getZoom?.() || 1) * 100)}%)`,
      };
    }
    if (action === 'fit') {
      if (typeof ui.fitView === 'function') ui.fitView();
      else ui.setZoom?.(1);
      return { status: 'success', summary: 'Fit / reset canvas zoom' };
    }
    if (action === 'set') {
      const z = Math.min(12, Math.max(0.01, num(args.percent, 100) / 100));
      if (!ui.setZoom) {
        return {
          status: 'error',
          summary: 'Exact zoom percent unavailable. Use the bottom-left zoom control.',
        };
      }
      ui.setZoom(z);
      return { status: 'success', summary: `Zoom set to ${Math.round(z * 100)}%` };
    }
    return {
      status: 'error',
      summary: 'set_viewport needs action: zoom_in|zoom_out|fit|set (optional percent)',
    };

}

function execSetActiveTool(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  _doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  const tool = String(args.tool || '').trim().toLowerCase();
  const allowed = new Set([
    'select',
    'pan',
    'frame',
    'text',
    'shape',
    'image',
    'pen',
    'pencil',
    'bucket',
    'eyedropper',
  ]);
  if (!allowed.has(tool)) {
    return {
      status: 'error',
      summary: `Unknown canvas tool: ${tool || '(empty)'}`,
      next_actions: [`Use tool one of: ${[...allowed].join('|')}`],
    };
  }
  setActiveTool(tool);
  return {
    status: 'success',
    summary: `Active tool set to ${tool}`,
    artifacts: { tool },
  };
}

function execSetGrid(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  _doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  if (args.enabled == null) {
    return { status: 'error', summary: 'set_grid requires enabled (boolean)' };
  }
  const enabled = truthy(args.enabled);
  setGridMode(enabled);
  return {
    status: 'success',
    summary: enabled ? 'Grid snap on' : 'Grid snap off',
    artifacts: { enabled },
  };
}

function execSetCanvasBackground(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const color = String(args.color ?? '').trim();
    const fillType = String(args.fillType || 'solid').toLowerCase();
    if (!color && fillType === 'solid') {
      return { status: 'error', summary: 'set_canvas_background requires color' };
    }
    const allowed = new Set(['solid', 'linear', 'radial', 'angular', 'diffuse', 'image']);
    const meta: Record<string, unknown> = {
      backgroundFillType: allowed.has(fillType) ? fillType : 'solid',
      backgroundColor: color || '#f5f5f5',
      backgroundOpacity: args.opacity != null ? num(args.opacity, 100) : 100,
    };
    if (
      fillType === 'linear' ||
      fillType === 'radial' ||
      fillType === 'angular' ||
      fillType === 'diffuse'
    ) {
      const c0 = color || '#3B82F6';
      const c1 = String(args.fillEnd ?? c0);
      const angle = num(args.gradientAngle, fillType === 'angular' ? 0 : 90);
      if (fillType === 'diffuse') {
        const meshSize = Math.min(8, Math.max(3, Math.round(num(args.meshSize, 4)))) as MeshSize;
        const meshPoints = parseMeshPoints(args.meshPoints, meshSize, c0);
        meta.backgroundGradient = serializeFillGradient({
          type: 'diffuse',
          meshSize,
          meshPoints,
          colorStops: [
            { offset: 0, color: meshPoints[0]?.color || c0 },
            { offset: 1, color: meshPoints[meshPoints.length - 1]?.color || c1 },
          ],
        });
      } else {
        meta.backgroundGradient = serializeFillGradient({
          type: fillType as 'linear' | 'radial' | 'angular',
          angle,
          cx: 50,
          cy: 50,
          r: 70,
          colorStops: [
            { offset: 0, color: c0 },
            { offset: 1, color: c1 },
          ],
        });
      }
    }
    if (fillType === 'image' && args.fillImageSrc != null) {
      meta.backgroundImageSrc = String(args.fillImageSrc);
      meta.backgroundImageFit = String(args.fillImageFit || 'fill');
    }
    setCanvasMeta(meta);
    return {
      status: 'success',
      summary: `Canvas background updated (${fillType}${color ? ` ${color}` : ''})`,
      artifacts: meta,
    };

}

function execSetAgentMode(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const mode = String(args.mode || '').toLowerCase();
    if (!['collaborative', 'milestone', 'auto'].includes(mode)) {
      return {
        status: 'error',
        summary: 'mode must be collaborative | milestone | auto',
      };
    }
    if (!ctx.canvasUi?.setCollabMode) {
      return {
        status: 'error',
        summary: 'Agent mode bridge missing. Toggle Agent / image-gen beside the composer.',
      };
    }
    ctx.canvasUi.setCollabMode(mode as 'collaborative' | 'milestone' | 'auto');
    return {
      status: 'success',
      summary: `Agent mode set to ${mode}`,
      artifacts: { mode },
    };

}

function execToggleEditorPanel(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  _doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  const spec = resolveEditorPanel(String(args.panel || ''));
  const supported = supportedTogglePanelIds().join(' | ');
  if (!spec) {
    return {
      status: 'error',
      summary: `Supported panels: ${supported}. Use list_capabilities for others.`,
    };
  }

  if (spec.kind === 'redirect') {
    return {
      status: 'error',
      summary: spec.summary,
      next_actions: spec.next_actions,
    };
  }

  if (spec.kind === 'unavailable') {
    const hit =
      UNAVAILABLE_CAPABILITIES.find((c) => c.id === spec.capabilityId) ||
      UNAVAILABLE_CAPABILITIES[0];
    return { status: 'error', summary: hit.hint };
  }

  const ui = ctx.canvasUi;
  if (!ui) {
    return { status: 'error', summary: spec.missing };
  }

  if (spec.kind === 'navigate') {
    if (!spec.apply(ui)) return { status: 'error', summary: spec.missing };
    return { status: 'success', summary: spec.success };
  }

  const open = args.open == null ? true : args.open === true || args.open === 'true';
  if (!spec.apply(ui, open)) return { status: 'error', summary: spec.missing };
  return { status: 'success', summary: open ? spec.opened : spec.closed };
}

function execAskUser(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const question = String(args.question || '').trim();
    if (!question) return { status: 'error', summary: 'question required' };
    const options = Array.isArray(args.options)
      ? args.options
          .map((x) => String(x).trim())
          .filter((x) => {
            if (!x) return false;
            const low = x.toLowerCase();
            return low !== 'cancel' && x !== '取消';
          })
          .slice(0, 6)
      : [];
    return {
      status: 'success',
      summary: question,
      artifacts: { ask: true, options },
      next_actions: options.length ? options : ['Wait for user reply'],
    };

}

function execFinish(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const summary = String(args.summary || 'Done');
    return { status: 'success', summary, artifacts: { done: true } };

}

function execCreateSvg(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const width = Math.max(1, num(args.width, 48));
    const height = Math.max(1, num(args.height, 48));
    const target = ctx.targetFrameId ? frameById(doc, ctx.targetFrameId) : null;
    const missXY = requireCreateXY('create_svg', args);
    if (missXY) return missXY;
    const svgRaw = String(args.svg || '').trim();
    if (!svgRaw) {
      return {
        status: 'error',
        summary: 'create_svg/create_icon requires args.svg (mini SVG markup).',
        next_actions: ['Pass args.svg with viewBox 0 0 24 24'],
      };
    }
    const origin = resolveCreateXY(args, target, width, height);
    const placed = fitIntoFrame(target, origin.x, origin.y, width, height);
    const placeErr = placementRewriteError('create_svg', args, placed);
    if (placeErr) return placeErr;
    const fill = args.fill != null ? String(args.fill) : undefined;
    const { id, node } = createSvgNode({
      x: placed.x,
      y: placed.y,
      width: placed.width,
      height: placed.height,
      svg: svgRaw,
      name: String(args.name || 'SVG'),
      fill,
    });
    console.info('[create_svg]', {
      id,
      placed,
      fill,
      svgHead: svgRaw.slice(0, 160),
      svgLen: svgRaw.length,
    });
    pushHistory();
    setDocument(addNodeToDocument(ctx.getDocument(), id, node));
    return {
      status: 'success',
      summary: `Created svg ${id}`,
      artifacts: { nodeId: id, shapeType: 'svg' },
      next_actions: ['Continue layout'],
    };

}

function execCreateLottie(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const raw = args.animationData;
  if (raw == null || (typeof raw === 'string' && !String(raw).trim())) {
    return {
      status: 'error',
      summary: 'create_lottie requires args.animationData (Bodymovin JSON object or string).',
      next_actions: ['Pass animationData with v/fr/ip/op/w/h/layers'],
    };
  }

  const replaceId = String(args.replaceNodeId || '').trim();
  if (replaceId && doc?.deltaSetLike?.[replaceId]?.key === 'lottie') {
    const plate = doc.deltaSetLike[replaceId];
    const width =
      args.width != null
        ? Math.max(8, num(args.width, Number(plate.width) || 200))
        : Math.max(8, Number(plate.width) || 200);
    const height =
      args.height != null
        ? Math.max(8, num(args.height, Number(plate.height) || 200))
        : Math.max(8, Number(plate.height) || 200);
    pushHistory();
    const next = applyLottieAnimationToNode(ctx.getDocument(), replaceId, {
      animationData: raw,
      width,
      height,
      x: Number(plate.x) || 0,
      y: Number(plate.y) || 0,
      name: String(args.name || 'Lottie'),
      genPrompt: String(args.genPrompt || '').trim() || undefined,
    });
    if (next === ctx.getDocument()) {
      return {
        status: 'error',
        summary: 'create_lottie: invalid Lottie JSON (need layers + canvas size).',
        next_actions: ['Fix animationData schema', 'Retry create_lottie'],
      };
    }
    setDocument(next);
    return {
      status: 'success',
      summary: `Updated lottie ${replaceId}`,
      artifacts: { nodeId: replaceId, shapeType: 'lottie' },
      next_actions: ['Continue layout'],
    };
  }

  const parsed = parseLottieAnimationData(raw);
  if (!parsed) {
    return {
      status: 'error',
      summary: 'create_lottie: invalid Lottie JSON (need layers + canvas size).',
      next_actions: ['Fix animationData schema', 'Retry create_lottie'],
    };
  }

  const width = Math.max(
    8,
    num(args.width, Number(parsed.w) || 200) || Number(parsed.w) || 200
  );
  const height = Math.max(
    8,
    num(args.height, Number(parsed.h) || 200) || Number(parsed.h) || 200
  );
  const boardName = String(args.name || '动画工作台').trim() || '动画工作台';

  // Prefer open timeline / active 动画工作台. Ignore non-animation targetFrameId
  // (design loading shimmer) so we don't leave an empty 主画板 + spawn a blank board.
  const focusId = String(getAnimationWorkbenchTimelineFocus() || '').trim();
  const activeAnimId = resolveActiveAnimationFrameId(doc, undefined);
  const preferredId = focusId || activeAnimId || String(ctx.targetFrameId || '').trim();
  const target = preferredId ? frameById(doc, preferredId) : null;
  if (target && isAnimationArtboardKind(target.kind)) {
    importLottieIntoAnimationFrame({
        frameId: target.id,
        animationData: parsed,
        name: boardName,
      });
    const afterImport = ctx.getDocument();
    const hostId = findFrameAnimationMediaId(afterImport, target.id);
    if (hostId) {
      openLottieTimelinePanel({ nodeId: hostId });
    }
    return {
      status: 'success',
      summary: `Imported lottie into animation board ${target.id}`,
      artifacts: { frameId: target.id, shapeType: 'lottie' },
      next_actions: ['Continue layout'],
    };
  }

  const missXY = requireCreateXY('create_lottie', args);
  if (missXY) return missXY;
  const origin = resolveCreateXY(args, target, width, height);
  spawnAnimationBoard({
      x: origin.x,
      y: origin.y,
      width,
      height,
      name: boardName,
    });
  const after = ctx.getDocument();
  const frameId = String(after?.activeFrameId || '').trim();
  if (!frameId) {
    return {
      status: 'error',
      summary: 'create_lottie: failed to spawn animation workbench.',
      next_actions: ['Retry create_lottie'],
    };
  }
  importLottieIntoAnimationFrame({
      frameId,
      animationData: parsed,
      name: boardName,
      skipHistory: true,
    });
  const afterBoard = ctx.getDocument();
  const hostId = findFrameAnimationMediaId(afterBoard, frameId);
  if (hostId) {
    openLottieTimelinePanel({ nodeId: hostId });
  }
  return {
    status: 'success',
    summary: `Created animation workbench ${frameId}`,
    artifacts: { frameId, shapeType: 'lottie' },
    next_actions: ['Continue layout'],
  };
}

function execCreateImage(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const width = Math.max(8, num(args.width, 240));
  const height = Math.max(8, num(args.height, 180));
  const missXY = requireCreateXY('create_image', args);
  if (missXY) return missXY;
  const target = ctx.targetFrameId ? frameById(doc, ctx.targetFrameId) : null;
  const origin = resolveCreateXY(args, target, width, height);
  const placed = fitIntoFrame(target, origin.x, origin.y, width, height);
  const placeErr = placementRewriteError('create_image', args, placed);
  if (placeErr) return placeErr;
  const userImages = Array.isArray(ctx.userImages) ? ctx.userImages : [];
  const genPrompt = String(args.genPrompt || '').trim();
  let src = '';
  let sourceKind: 'attachment' | 'src' | 'placeholder' = 'placeholder';
  if (args.attachmentIndex != null) {
    const idx = Math.max(0, Math.floor(num(args.attachmentIndex, 0)));
    src = userImages[idx] || '';
    if (!src) {
      return {
        status: 'error',
        summary: `No user attachment at index ${idx} (have ${userImages.length}). Use placeholder or ask user to attach.`,
        next_actions: ['create_image without attachmentIndex', 'ask_user'],
      };
    }
    sourceKind = 'attachment';
  } else if (args.src != null && String(args.src).trim()) {
    src = String(args.src).trim();
    sourceKind = 'src';
  } else {
    // Backend should have hydrated genPrompt → src via Seedream. If we still
    // land here, show placeholder but keep genPrompt on the node for retry.
    const kind = String(args.placeholder || 'image').toLowerCase();
    src = kind === 'avatar' ? AVATAR_PLACEHOLDER : IMAGE_PLACEHOLDER;
    sourceKind = 'placeholder';
    if (genPrompt) {
      console.warn('[create_image] genPrompt without src — hydrate missed?', {
        genPrompt: genPrompt.slice(0, 120),
        width: placed.width,
        height: placed.height,
      });
    }
  }
  const { id, node } = createImageNode({
    x: placed.x,
    y: placed.y,
    width: placed.width,
    height: placed.height,
    src,
    name: String(args.name || (sourceKind === 'placeholder' ? 'Image Placeholder' : 'Image')),
    assetKind: 'image',
  });
  const letteringText = String(args.letteringText || '').trim();
  if (genPrompt || letteringText) {
    node.attrs = {
      ...(node.attrs || {}),
      ...(genPrompt ? { genPrompt } : {}),
      ...(letteringText ? { letteringText } : {}),
    };
  }
  pushHistory();
  setDocument(addNodeToDocument(ctx.getDocument(), id, node));
  return {
    status: sourceKind === 'placeholder' && Boolean(genPrompt) ? 'warning' : 'success',
    summary: summarizeCreateImage({
      id,
      sourceKind,
      genPrompt,
      placed,
    }),
    artifacts: { nodeId: id, sourceKind },
    next_actions: ['Continue layout'],
  };
}

function execAlignNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    const rawMode = String(args.mode || '').trim();
    const mode = normalizeAlignMode(rawMode);
    const allowedAlign = new Set([
      'left',
      'centerX',
      'right',
      'top',
      'middle',
      'bottom',
    ]);
    if (ids.length < 2) return { status: 'error', summary: 'align_nodes needs at least 2 nodeIds' };
    if (!allowedAlign.has(mode)) {
      return { status: 'error', summary: `Unknown align mode: ${mode || '(empty)'}` };
    }
    const boxes = readAgentBoxes(doc, ids);
    if (boxes.length < 2) return { status: 'error', summary: 'Could not resolve node boxes' };
    const minL = Math.min(...boxes.map((b) => b.left));
    const maxR = Math.max(...boxes.map((b) => b.left + b.width));
    const minT = Math.min(...boxes.map((b) => b.top));
    const maxB = Math.max(...boxes.map((b) => b.top + b.height));
    const midX = (minL + maxR) / 2;
    const midY = (minT + maxB) / 2;
    pushHistory();
    const alignPatches = boxes.map((b) => {
      const patch: { x?: number; y?: number } = {};
      if (mode === 'left') patch.x = minL;
      else if (mode === 'centerX') patch.x = midX - b.width / 2;
      else if (mode === 'right') patch.x = maxR - b.width;
      else if (mode === 'top') patch.y = minT;
      else if (mode === 'middle') patch.y = midY - b.height / 2;
      else patch.y = maxB - b.height;
      return { nodeId: b.id, patch };
    });
    patchDocumentNodes({ patches: alignPatches, skipHistory: true });
    return {
      status: 'success',
      summary: `Aligned ${boxes.length} nodes (${mode})`,
      artifacts: { nodeIds: boxes.map((b) => b.id), mode },
    };

}

function execDistributeNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    const axisRaw = String(args.axis || 'h').toLowerCase();
    const axis =
      axisRaw === 'v' || axisRaw === 'vertical' || axisRaw === 'y' ? 'v' : 'h';
    if (ids.length < 3) return { status: 'error', summary: 'distribute_nodes needs at least 3 nodeIds' };
    const boxes = readAgentBoxes(doc, ids);
    if (boxes.length < 3) return { status: 'error', summary: 'Could not resolve node boxes' };
    const sorted = [...boxes].sort((a, b) => (axis === 'h' ? a.left - b.left : a.top - b.top));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    pushHistory();
    const distributePatches: Array<{ nodeId: string; patch: { x?: number; y?: number } }> = [];
    if (axis === 'h') {
      const span =
        last.left + last.width - first.left - sorted.reduce((s, b) => s + b.width, 0);
      const gap = span / (sorted.length - 1);
      let x = first.left;
      sorted.forEach((b, i) => {
        if (i === 0) {
          x = b.left + b.width + gap;
          return;
        }
        if (i === sorted.length - 1) return;
        distributePatches.push({ nodeId: b.id, patch: { x } });
        x += b.width + gap;
      });
    } else {
      const span =
        last.top + last.height - first.top - sorted.reduce((s, b) => s + b.height, 0);
      const gap = span / (sorted.length - 1);
      let y = first.top;
      sorted.forEach((b, i) => {
        if (i === 0) {
          y = b.top + b.height + gap;
          return;
        }
        if (i === sorted.length - 1) return;
        distributePatches.push({ nodeId: b.id, patch: { y } });
        y += b.height + gap;
      });
    }
    if (distributePatches.length) {
      patchDocumentNodes({ patches: distributePatches, skipHistory: true });
    }
    return {
      status: 'success',
      summary: `Distributed ${sorted.length} nodes (${axis})`,
      artifacts: { nodeIds: sorted.map((b) => b.id), axis },
    };

}

function execBooleanOp(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    const mode = String(args.mode || 'union');
    if (!['union', 'subtract', 'intersect', 'exclude', 'xor'].includes(mode)) {
      return { status: 'error', summary: `Unknown boolean mode: ${mode}` };
    }
    if (ids.length < 2) return { status: 'error', summary: 'boolean_op needs at least 2 nodeIds' };
    const boxes = readAgentBoxes(doc, ids).filter((b) =>
      supportsBooleanOp(doc?.deltaSetLike?.[b.id])
    );
    if (boxes.length < 2) {
      return {
        status: 'error',
        summary: 'Need 2+ closed shapes (not line/arrow/pen/pencil/text/image)',
      };
    }
    void ctx;
    void pushHistory; // Kit flushCreates already snapshots history
    const newId = runKitBooleanOp(
      boxes.map((b) => b.id),
      mode as 'union' | 'subtract' | 'intersect' | 'xor' | 'exclude'
    );
    if (!newId) {
      return {
        status: 'error',
        summary: mode === 'intersect' ? 'No overlap for intersect' : 'Boolean operation failed',
      };
    }

    const latest = store.getState().editor.document || doc;
    const created = latest?.deltaSetLike?.[newId];
    const operandFrameIds = boxes
      .map((b) => String(doc?.deltaSetLike?.[b.id]?.attrs?.frameId || '').trim())
      .filter(Boolean);
    let frameId: string | undefined;
    if (created && latest) {
      const { left, top } = nodeLeftTop(latest, created);
      const abs = sceneToDocumentCoords(latest, left, top);
      frameId =
        resolveBooleanResultFrameId(
          latest,
          operandFrameIds,
          abs.x + Number(created.width || 0) / 2,
          abs.y + Number(created.height || 0) / 2
        ) || undefined;
      const attrs: Record<string, unknown> = { outlined: 'true' };
      if (frameId) {
        attrs.frameId = frameId;
        const orders = boxes
          .map((b) => Number(doc?.deltaSetLike?.[b.id]?.attrs?.frameOrder))
          .filter(Number.isFinite);
        if (orders.length) attrs.frameOrder = Math.max(...orders) + 1;
      }
      patchDocumentNode({ nodeId: newId, patch: { attrs } });
      if (frameId) {
        const frame = (latest.frames || []).find((f) => String(f?.id) === frameId);
        if (frame && isAnimationArtboardKind(frame.kind)) {
          ensureAnimationFrameMedia({ frameId });
        }
      } else {
        const after = store.getState().editor.document;
        if (after) {
          const tagged = tagCreatedNodeForWorkbenchSurround(after, newId);
          if (tagged !== after) setDocument(tagged);
        }
      }
    }

    return {
      status: 'success',
      summary: `Boolean ${mode} → ${newId}`,
      artifacts: {
        nodeId: newId,
        mode,
        removed: boxes.map((b) => b.id),
        frameId,
      },
    };

}

function execReorderNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    const raw = String(args.action || '').toLowerCase();
    const actionMap: Record<string, 'front' | 'back' | 'forward' | 'backward'> = {
      front: 'front',
      back: 'back',
      forward: 'forward',
      backward: 'backward',
    };
    const action = actionMap[raw];
    if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
    if (!action) {
      return { status: 'error', summary: `Unknown reorder action: ${raw}` };
    }
    pushHistory();
    setDocumentFromCanvas(reorderNodesInDocument(doc, ids, action));
    return {
      status: 'success',
      summary: `Reordered ${ids.length} node(s) (${action})`,
      artifacts: { nodeIds: ids, action },
    };

}

function execGroupNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    if (ids.length < 2) return { status: 'error', summary: 'group_nodes needs at least 2 nodeIds' };
    pushHistory();
    setDocument(groupNodesInDocument(doc, ids));
    return {
      status: 'success',
      summary: `Grouped ${ids.length} nodes`,
      artifacts: { nodeIds: ids },
    };

}

function execUngroupNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
    pushHistory();
    setDocument(ungroupNodesInDocument(doc, ids));
    return {
      status: 'success',
      summary: `Ungrouped ${ids.length} node(s)`,
      artifacts: { nodeIds: ids },
    };

}

function execDuplicateNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
    const ox = num(args.offsetX, 24);
    const oy = num(args.offsetY, 24);
    let next = doc;
    const created: string[] = [];
    pushHistory();
    for (const oldId of ids) {
      const raw = next?.deltaSetLike?.[oldId];
      if (!raw) continue;
      const node = cloneSceneValue(raw);
      const newId = nanoid(10);
      node.id = newId;
      node.x = (Number(node.x) || 0) + ox;
      node.y = (Number(node.y) || 0) + oy;
      if (node.attrs?.groupId) {
        const { groupId: _g, ...rest } = node.attrs;
        node.attrs = rest;
      }
      next = addNodeToDocument(next, newId, node);
      created.push(newId);
    }
    if (!created.length) return { status: 'error', summary: 'No nodes duplicated' };
    setDocument(next);
    return {
      status: 'success',
      summary: `Duplicated ${created.length} node(s)`,
      artifacts: { nodeIds: created },
    };

}

function execFlipNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const ids = parseNodeIds(args);
    if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
    const axis = String(args.axis || '').toLowerCase();
    const doX =
      args.flipX === true ||
      args.flipX === 'true' ||
      axis === 'horizontal' ||
      axis === 'h' ||
      axis === 'x';
    const doY =
      args.flipY === true ||
      args.flipY === 'true' ||
      axis === 'vertical' ||
      axis === 'v' ||
      axis === 'y';
    if (!doX && !doY) return { status: 'error', summary: 'Set flipX and/or flipY true' };
    pushHistory();
    const flipPatches: Array<{ nodeId: string; patch: { attrs: Record<string, unknown> } }> = [];
    for (const id of ids) {
      const node = ctx.getDocument()?.deltaSetLike?.[id];
      if (!node) continue;
      const attrs: Record<string, unknown> = {};
      if (doX) {
        const cur = node.attrs?.flipX === true || node.attrs?.flipX === 'true';
        attrs.flipX = cur ? 'false' : 'true';
      }
      if (doY) {
        const cur = node.attrs?.flipY === true || node.attrs?.flipY === 'true';
        attrs.flipY = cur ? 'false' : 'true';
      }
      flipPatches.push({ nodeId: id, patch: { attrs } });
    }
    if (flipPatches.length) {
      patchDocumentNodes({ patches: flipPatches, skipHistory: true });
    }
    return {
      status: 'success',
      summary: `Flipped ${ids.length} node(s)`,
      artifacts: { nodeIds: ids, flipX: doX, flipY: doY },
    };

}

function execRotateNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const ids = parseNodeIds(args);
  if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
  if (args.rotation == null) {
    return { status: 'error', summary: 'rotate_nodes requires rotation (degrees)' };
  }
  const rotation = num(args.rotation, NaN);
  if (!Number.isFinite(rotation)) {
    return { status: 'error', summary: 'rotate_nodes requires rotation (degrees)' };
  }
  const done: string[] = [];
  for (const nodeId of ids) {
    if (!doc.deltaSetLike?.[nodeId]) continue;
    const result = execUpdateNode({ nodeId, rotation }, ctx, doc, pushHistory);
    if (result.status !== 'error') done.push(nodeId);
  }
  if (!done.length) return { status: 'error', summary: 'No matching nodes to rotate' };
  return {
    status: 'success',
    summary: `Rotated ${done.length} node(s)`,
    artifacts: { nodeIds: done, rotation },
  };
}

function bindNodesInDocument(
  doc: SceneDocument,
  nodeIds: string[],
  frameId: string | null
): { document: SceneDocument; boundIds: string[]; rejectedIds: string[] } {
  const next = cloneSceneValue(doc) as SceneDocument;
  const frame = frameId ? frameById(next, frameId) : null;
  let orderCursor = 0;
  if (frameId) {
    const existing = Object.values(next.deltaSetLike || {})
      .filter((item) => String(item?.attrs?.frameId || '').trim() === frameId)
      .map((item) => Number(item?.attrs?.frameOrder))
      .filter(Number.isFinite);
    orderCursor = existing.length ? Math.max(...existing) + 1 : 0;
  }
  const unboundKeys: string[] = [];
  const boundIds: string[] = [];
  const rejectedIds: string[] = [];
  for (const nodeId of nodeIds) {
    const node = next.deltaSetLike?.[nodeId];
    if (!node) continue;
    if (frameId && !canBindNodeToArtboardFrame(frame, node)) {
      rejectedIds.push(nodeId);
      continue;
    }
    const attrs = { ...(node.attrs || {}) };
    if (frameId) {
      attrs.frameId = frameId;
      attrs.frameOrder = orderCursor;
      orderCursor += 1;
      boundIds.push(nodeId);
    } else {
      delete attrs.frameId;
      delete attrs.frameOrder;
      unboundKeys.push(`node:${nodeId}`);
      boundIds.push(nodeId);
    }
    next.deltaSetLike[nodeId] = { ...node, attrs };
  }
  if (unboundKeys.length) {
    const order = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
    const keep = order.filter((key) => !unboundKeys.includes(key));
    next.stackOrder = [...keep, ...unboundKeys.filter((key) => !keep.includes(key))];
  }
  reconcileStackOrder(next);
  return { document: next, boundIds, rejectedIds };
}

function execBindNodesToFrame(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const frameId = resolveFrameOpId(args, ctx);
  if (!frameId) return { status: 'error', summary: 'frameId required' };
  if (!frameById(doc, frameId)) return { status: 'error', summary: `frame not found: ${frameId}` };
  const ids = parseNodeIds(args);
  if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
  const { document: next, boundIds, rejectedIds } = bindNodesInDocument(doc, ids, frameId);
  if (!boundIds.length) {
    return {
      status: 'error',
      summary: '动画工作台不支持绑定视频/音频节点',
      artifacts: { rejectedNodeIds: rejectedIds, frameId },
    };
  }
  pushHistory();
  setDocumentFromCanvas(next);
  return {
    status: 'success',
    summary:
      rejectedIds.length > 0
        ? `Bound ${boundIds.length} node(s) to frame ${frameId}; skipped ${rejectedIds.length} AV node(s)`
        : `Bound ${boundIds.length} node(s) to frame ${frameId}`,
    artifacts: { nodeIds: boundIds, rejectedNodeIds: rejectedIds, frameId },
  };
}

function execUnbindNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const ids = parseNodeIds(args);
  if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
  const { document: next, boundIds } = bindNodesInDocument(doc, ids, null);
  pushHistory();
  setDocumentFromCanvas(next);
  return {
    status: 'success',
    summary: `Unbound ${boundIds.length} node(s) from artboards`,
    artifacts: { nodeIds: boundIds },
  };
}

function execDeleteNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    if (!ctx.allowDestructive) {
      return {
        status: 'error',
        summary:
          'delete_nodes blocked: destructive ops require backend-approved allowDestructive.',
        next_actions: ['create_frame', 'create_shape', 'create_text', 'update_node'],
      };
    }
    const ids = Array.isArray(args.nodeIds)
      ? args.nodeIds.map((x) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
    const docNow = ctx.getDocument();
    const frameIdSet = new Set(listFrames(docNow).map((f) => String(f.id)));
    const frameIds = ids.filter((id) => frameIdSet.has(id));
    const nodeIds = ids.filter((id) => !frameIdSet.has(id));
    // Never remap artboard ids → wipe-all-children. That deleted "kept" colors
    // when models stuffed FOCUS frame id into delete_nodes by mistake.
    if (frameIds.length) {
      return {
        status: 'error',
        summary:
          'delete_nodes must list element node ids only (not artboard/frame ids). ' +
          'Use delete_frame to remove a board, or pass concrete nodeIds to keep.',
        next_actions: ['delete_nodes', 'delete_frame', 'update_node'],
        artifacts: { rejectedFrameIds: frameIds, nodeIds },
      };
    }
    const before = new Set(
      ((docNow?.deltaSetLike?.ROOT?.children as string[]) || []).filter(Boolean)
    );
    const next = removeNodesFromDocument(docNow, nodeIds);
    const after = new Set(
      ((next?.deltaSetLike?.ROOT?.children as string[]) || []).filter(Boolean)
    );
    const removed = nodeIds.filter((id) => before.has(id) && !after.has(id));
    if (!removed.length) {
      return {
        status: 'error',
        summary: 'delete_nodes: no matching scene nodes (use delete_frame for artboards)',
      };
    }
    setDocument(next);
    return {
      status: 'success',
      summary: `Deleted ${removed.length} node(s)`,
      artifacts: { nodeIds: removed },
    };

}

function execDeleteFrame(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    if (!ctx.allowDestructive) {
      return {
        status: 'error',
        summary:
          'delete_frame blocked: destructive ops require backend-approved allowDestructive.',
        next_actions: ['delete_nodes', 'update_frame'],
      };
    }
    const fid = resolveFrameOpId(args, ctx);
    if (!fid) return { status: 'error', summary: 'frameId required' };
    const docNow = ctx.getDocument();
    if (!listFrames(docNow).some((f) => String(f.id) === fid)) {
      return { status: 'error', summary: `frame not found: ${fid}` };
    }
    const childIds = nodeIdsBoundToFrames(docNow, [fid]);
    removeArtboardFrames([fid]);
    return {
      status: 'success',
      summary: `Deleted frame ${fid}`,
      artifacts: { frameId: fid, nodeIds: childIds },
    };

}

function execDuplicateFrame(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const frameId = resolveFrameOpId(args, ctx);
  if (!frameId) return { status: 'error', summary: 'frameId required' };
  const source = frameById(doc, frameId);
  if (!source) return { status: 'error', summary: `frame not found: ${frameId}` };
  const dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : 48;
  const dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : 48;
  const beforeIds = new Set(listFrames(doc).map((f) => String(f.id)));
  const copyName = args.name != null ? String(args.name) : `${String(source.name || 'Frame')} Copy`;
  addArtboardFrame({
      name: copyName,
      x: Math.round((Number(source.x) || 0) + dx),
      y: Math.round((Number(source.y) || 0) + dy),
      width: Math.max(40, Number(source.width) || 40),
      height: Math.max(40, Number(source.height) || 40),
      backgroundColor: source.backgroundColor,
      clipContent: source.clipContent,
      locked: false,
      hidden: false,
      activate: false,
    });
  const frames = listFrames(ctx.getDocument());
  const created = frames.find((frame) => !beforeIds.has(String(frame.id))) || null;
  if (!created?.id) {
    return { status: 'error', summary: `duplicate_frame failed for ${frameId}` };
  }
  const copyChildren = truthy(args.includeChildren);
  const copiedNodeIds: string[] = [];
  if (copyChildren) {
    const childIds = nodeIdsBoundToFrames(doc, [frameId]);
    let nextDoc = ctx.getDocument() || doc;
    for (const oldId of childIds) {
      const raw = doc.deltaSetLike?.[oldId];
      if (!raw) continue;
      const node = cloneSceneValue(raw);
      const newId = nanoid(10);
      node.id = newId;
      node.x = (Number(node.x) || 0) + dx;
      node.y = (Number(node.y) || 0) + dy;
      node.attrs = { ...(node.attrs || {}), frameId: created.id };
      nextDoc = addNodeToDocument(nextDoc, newId, node);
      copiedNodeIds.push(newId);
    }
    if (copiedNodeIds.length) setDocumentFromCanvas(nextDoc);
  }
  return {
    status: 'success',
    summary: `Duplicated frame ${frameId} -> ${created.id}${
      copiedNodeIds.length ? ` with ${copiedNodeIds.length} node(s)` : ''
    }`,
    artifacts: { sourceFrameId: frameId, frameId: created.id, nodeIds: copiedNodeIds },
  };
}

function execReorderFrames(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const frameIds = Array.isArray(args.frameIds)
    ? args.frameIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  if (!frameIds.length) return { status: 'error', summary: 'frameIds required' };
  const actionRaw = String(args.action || '').trim().toLowerCase();
  const allowed = new Set(['front', 'back', 'forward', 'backward']);
  if (!allowed.has(actionRaw)) {
    return { status: 'error', summary: `Unknown reorder action: ${actionRaw || '(empty)'}` };
  }
  const action = actionRaw as 'front' | 'back' | 'forward' | 'backward';

  const existing = new Set(listFrames(doc).map((f) => String(f.id)));
  const target = frameIds.filter((id) => existing.has(id));
  if (!target.length) return { status: 'error', summary: 'No matching frame ids' };

  const next = cloneSceneValue(doc) as SceneDocument;
  const order = Array.isArray(next.stackOrder) ? next.stackOrder.map(String) : [];
  const frameKeys = order.filter((key) => key.startsWith('frame:'));
  const nonFrameKeys = order.filter((key) => !key.startsWith('frame:'));
  const selectedKeys = new Set(target.map((id) => `frame:${id}`));
  next.stackOrder = [...reorderKeysWithAction(frameKeys, selectedKeys, action), ...nonFrameKeys];
  pushHistory();
  setDocumentFromCanvas(next);
  return {
    status: 'success',
    summary: `Reordered ${target.length} frame(s) (${action})`,
    artifacts: { frameIds: target, action },
  };
}

function execFitFrameToContent(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const frameId = resolveFrameOpId(args, ctx);
  if (!frameId) return { status: 'error', summary: 'frameId required' };
  const frame = frameById(doc, frameId);
  if (!frame) return { status: 'error', summary: `frame not found: ${frameId}` };
  const nodeIds = nodeIdsInsideFrame(doc, frameId);
  if (!nodeIds.length) {
    return {
      status: 'warning',
      summary: `Frame ${frameId} has no child nodes`,
      artifacts: { frameId, nodeIds: [] },
    };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const nodeId of nodeIds) {
    const node = doc.deltaSetLike?.[nodeId];
    if (!node) continue;
    const lt = nodeLeftTop(doc, node);
    const left = Number(lt.left) || 0;
    const top = Number(lt.top) || 0;
    const width = Math.max(1, Number(node.width) || 1);
    const height = Math.max(1, Number(node.height) || 1);
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + width);
    maxY = Math.max(maxY, top + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { status: 'error', summary: `fit_frame_to_content failed for ${frameId}` };
  }
  const padding = Math.max(0, Number(args.padding) || 24);
  updateArtboardFrame({
      id: frameId,
      patch: {
        x: Math.round(minX - padding),
        y: Math.round(minY - padding),
        width: Math.max(40, Math.round(maxX - minX + padding * 2)),
        height: Math.max(40, Math.round(maxY - minY + padding * 2)),
      },
    });
  return {
    status: 'success',
    summary: `Fitted frame ${frameId} to ${nodeIds.length} node(s)`,
    artifacts: { frameId, nodeIds },
  };
}

function execSetFrameFlag(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  flag: 'locked' | 'hidden' | 'clipContent',
  defaultOn: boolean
): AgentToolResult {
  const ids = parseFrameOpIds(args, ctx);
  if (!ids.length) return { status: 'error', summary: 'frameIds required' };
  const on = args[flag] == null ? defaultOn : truthy(args[flag]);
  const existing = new Set(listFrames(doc).map((f) => String(f.id)));
  const patches = ids
    .filter((id) => existing.has(id))
    .map((id) => ({ id, patch: { [flag]: on } }));
  if (!patches.length) return { status: 'error', summary: 'No matching frame ids' };
  updateArtboardFrames({ patches });
  let verb = 'Updated';
  if (flag === 'locked') verb = on ? 'Locked' : 'Unlocked';
  else if (flag === 'hidden') verb = on ? 'Hid' : 'Showed';
  else verb = on ? 'Clipped' : 'Unclipped';
  return {
    status: 'success',
    summary: `${verb} ${patches.length} frame(s)`,
    artifacts: { frameIds: patches.map((p) => p.id), [flag]: on },
  };
}

function execLockFrames(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  return execSetFrameFlag(args, ctx, doc, 'locked', true);
}

function execHideFrames(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  return execSetFrameFlag(args, ctx, doc, 'hidden', true);
}

function execClipFrames(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  _pushHistory: () => void
): AgentToolResult {
  return execSetFrameFlag(args, ctx, doc, 'clipContent', true);
}

function execHideNodes(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
  const ids = parseNodeIds(args);
  if (!ids.length) return { status: 'error', summary: 'nodeIds required' };
  const hidden = args.hidden == null ? true : truthy(args.hidden);
  const done: string[] = [];
  for (const nodeId of ids) {
    if (!doc.deltaSetLike?.[nodeId]) continue;
    const result = execUpdateNode({ nodeId, hidden }, ctx, doc, pushHistory);
    if (result.status !== 'error') done.push(nodeId);
  }
  if (!done.length) {
    return { status: 'error', summary: 'No matching scene nodes to hide/show' };
  }
  return {
    status: 'success',
    summary: `${hidden ? 'Hid' : 'Showed'} ${done.length} node(s)`,
    artifacts: { nodeIds: done, hidden },
  };
}

function execUpdateFrame(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const id = resolveFrameOpId(args, ctx);
    if (!id) return { status: 'error', summary: 'frameId required' };
    const patch: Partial<ArtboardFrame> = {};
    if (args.width != null) patch.width = Math.max(40, num(args.width));
    if (args.height != null) patch.height = Math.max(40, num(args.height));
    if (args.name != null) patch.name = String(args.name);
    if (args.backgroundColor != null) {
      patch.backgroundColor = String(args.backgroundColor || 'transparent');
    }
    if (args.locked != null) patch.locked = truthy(args.locked);
    if (args.hidden != null) patch.hidden = truthy(args.hidden);
    if (args.clipContent != null) patch.clipContent = truthy(args.clipContent);
    updateArtboardFrame({ id, patch });
    return { status: 'success', summary: `Updated frame ${id}`, artifacts: { frameId: id } };

}

function execImageProcess(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const nodeId = String(args.nodeId || '').trim();
    const kind = String(args.kind || '').trim();
    const allowed = new Set([
      'upscale',
      'removeBg',
      'eraser',
      'editText',
      'editElements',
      'replaceText',
      'translateImage',
      'productScene',
      'multiAngle',
      'expand',
      'adjust',
      'crop',
      'flipRotate',
      'moveObject',
      'vector',
    ]);
    if (!nodeId) {
      return {
        status: 'error',
        summary: 'image_process requires args.nodeId',
        next_actions: ['Pass image node id'],
      };
    }
    if (!allowed.has(kind)) {
      return {
        status: 'error',
        summary: `image_process unknown kind=${kind || '(empty)'}`,
        next_actions: [`Use kind one of: ${[...allowed].join('|')}`],
      };
    }
    const node = doc.deltaSetLike?.[nodeId];
    if (!node) {
      return {
        status: 'error',
        summary: `image_process: node ${nodeId} not found`,
        next_actions: ['get_scene_summary'],
      };
    }
    const label = String(args.label || kind);
    startImageProcess({
        sourceId: nodeId,
        kind,
        label,
        targetWidth:
          args.targetWidth != null ? Number(args.targetWidth) : undefined,
        targetHeight:
          args.targetHeight != null ? Number(args.targetHeight) : undefined,
        meta:
          args.meta && typeof args.meta === 'object'
            ? (args.meta as Record<string, unknown>)
            : undefined,
      });
    return {
      status: 'success',
      summary: `Started image_process ${kind} on ${nodeId}`,
      artifacts: { sourceId: nodeId, kind },
      next_actions: ['Wait for process UI / continue other ops'],
    };

}

function execExportCanvas(
  args: Record<string, unknown>,
  ctx: DesignToolContext,
  doc: SceneDocument,
  pushHistory: () => void
): AgentToolResult {
    const formatRaw = String(args.format || 'png').toLowerCase();
    const format = normalizeExportFormat(formatRaw);
    const nodeIds = resolveExportNodeIds(args);
    const multiplier = Math.max(0.25, Math.min(4, Number(args.multiplier) || 1));
    const filename = String(args.filename || 'export').replace(/[^\w-]+/g, '_');
    const ok = exportFabricImage({
      format,
      multiplier,
      filename,
      selectionOnly: nodeIds.length > 0,
      nodeIds: nodeIds.length ? nodeIds : undefined,
      document: doc,
    });
    if (!ok) {
      return {
        status: 'error',
        summary: 'export_canvas failed to start (empty selection?)',
        next_actions: ['Pass nodeIds or export full board'],
      };
    }
    return {
      status: 'success',
      summary: `Export started (${format}${nodeIds.length ? `, ${nodeIds.length} nodes` : ', full'})`,
      artifacts: { format, nodeIds, multiplier },
    };

}

function resolveUnknownToolError(name: string): AgentToolResult {
  return {
        status: 'error',
        summary: (() => {
          const n = String(name || '').toLowerCase().trim();
          const panel = resolveEditorPanel(n);
          if (panel?.kind === 'unavailable') {
            const hit = UNAVAILABLE_CAPABILITIES.find((c) => c.id === panel.capabilityId);
            if (hit) return hit.hint;
          }
          if (panel?.kind === 'redirect') return panel.summary;
          const byId = UNAVAILABLE_CAPABILITIES.find(
            (c) => n === c.id || n.includes(c.id)
          );
          if (byId) return byId.hint;
          return `Unknown tool: ${name}. Call list_capabilities first; do not pretend unavailable capabilities ran.`;
        })(),
        next_actions: ['list_capabilities', ...DESIGN_TOOL_NAMES.slice(0, 8)],
      };
}

/**
 * Async entry — use for outline_text (fontkit). Other ops run sync via executeDesignTool.
 */
export async function executeDesignToolAsync(
  name: string,
  argsRaw: string,
  ctx: DesignToolContext
): Promise<AgentToolResult> {
  if (name === 'outline_text') {
    const doc = ctx.getDocument();
    if (!doc) {
      return { status: 'error', summary: 'No document open', next_actions: ['Open a project first'] };
    }
    const pushHistory = () => {
      if (!ctx.skipHistory) pushEditorHistory();
    };
    try {
      return await execOutlineText(parseArgs(argsRaw), ctx, pushHistory);
    } catch (err: any) {
      return {
        status: 'error',
        summary: err?.message || String(err),
        next_actions: ['Fix arguments and retry'],
      };
    }
  }
  return executeDesignTool(name, argsRaw, ctx);
}

export function executeDesignTool(
  name: string,
  argsRaw: string,
  ctx: DesignToolContext
): AgentToolResult {
  const args = parseArgs(argsRaw);
  const doc = ctx.getDocument();
  if (!doc) {
    return { status: 'error', summary: 'No document open', next_actions: ['Open a project first'] };
  }
  const pushHistory = () => {
    if (!ctx.skipHistory) pushEditorHistory();
  };

  try {
    // When a target frame was requested but is gone, block creates.
    if (
      ctx.targetFrameId &&
      (name === 'create_shape' ||
        name === 'create_text' ||
        name === 'create_image' ||
        name === 'create_svg' ||
        name === 'create_lottie' ||
        name === 'create_icon')
    ) {
      const target = frameById(doc, ctx.targetFrameId);
      if (!target) {
        return {
          status: 'error',
          summary: `Target frame ${ctx.targetFrameId} not found (deleted?). Call create_frame or ask_user.`,
          next_actions: ['create_frame', 'ask_user', 'get_scene_summary'],
        };
      }
    }

    switch (name) {
      case 'outline_text':
        return {
          status: 'error',
          summary: 'outline_text must run via executeDesignToolAsync',
          next_actions: ['Retry through agent tool_ops pipeline'],
        };
      case 'get_scene_summary':
        return execGetSceneSummary(args, ctx, doc, pushHistory);
      case 'list_capabilities':
        return execListCapabilities(args, ctx, doc, pushHistory);
      case 'set_viewport':
        return execSetViewport(args, ctx, doc, pushHistory);
      case 'set_active_tool':
        return execSetActiveTool(args, ctx, doc, pushHistory);
      case 'set_grid':
        return execSetGrid(args, ctx, doc, pushHistory);
      case 'set_canvas_background':
        return execSetCanvasBackground(args, ctx, doc, pushHistory);
      case 'set_agent_mode':
        return execSetAgentMode(args, ctx, doc, pushHistory);
      case 'toggle_editor_panel':
        return execToggleEditorPanel(args, ctx, doc, pushHistory);
      case 'ask_user':
        return execAskUser(args, ctx, doc, pushHistory);
      case 'finish':
        return execFinish(args, ctx, doc, pushHistory);
      case 'create_svg':
        return execCreateSvg(args, ctx, doc, pushHistory);
      case 'create_lottie':
        return execCreateLottie(args, ctx, doc, pushHistory);
      case 'create_icon':
        return execCreateSvg(args, ctx, doc, pushHistory);
      case 'create_shape':
        return execCreateShape(args, ctx, doc, pushHistory);
      case 'create_path':
        return execCreatePath(args, ctx, doc, pushHistory);
      case 'append_path_points':
        return execAppendPathPoints(args, ctx, doc, pushHistory);
      case 'simplify_path':
        return execSimplifyPath(args, ctx, doc, pushHistory);
      case 'smooth_path':
        return execSmoothPath(args, ctx, doc, pushHistory);
      case 'close_path':
        return execClosePath(args, ctx, doc, pushHistory);
      case 'create_image':
        return execCreateImage(args, ctx, doc, pushHistory);
      case 'create_text':
        return execCreateText(args, ctx, doc, pushHistory);
      case 'update_node':
        return execUpdateNode(args, ctx, doc, pushHistory);
      case 'align_nodes':
        return execAlignNodes(args, ctx, doc, pushHistory);
      case 'distribute_nodes':
        return execDistributeNodes(args, ctx, doc, pushHistory);
      case 'boolean_op':
        return execBooleanOp(args, ctx, doc, pushHistory);
      case 'reorder_nodes':
        return execReorderNodes(args, ctx, doc, pushHistory);
      case 'group_nodes':
        return execGroupNodes(args, ctx, doc, pushHistory);
      case 'ungroup_nodes':
        return execUngroupNodes(args, ctx, doc, pushHistory);
      case 'duplicate_nodes':
        return execDuplicateNodes(args, ctx, doc, pushHistory);
      case 'flip_nodes':
        return execFlipNodes(args, ctx, doc, pushHistory);
      case 'rotate_nodes':
        return execRotateNodes(args, ctx, doc, pushHistory);
      case 'bind_nodes_to_frame':
        return execBindNodesToFrame(args, ctx, doc, pushHistory);
      case 'unbind_nodes':
        return execUnbindNodes(args, ctx, doc, pushHistory);
      case 'delete_nodes':
        return execDeleteNodes(args, ctx, doc, pushHistory);
      case 'delete_frame':
        return execDeleteFrame(args, ctx, doc, pushHistory);
      case 'duplicate_frame':
        return execDuplicateFrame(args, ctx, doc, pushHistory);
      case 'reorder_frames':
        return execReorderFrames(args, ctx, doc, pushHistory);
      case 'fit_frame_to_content':
        return execFitFrameToContent(args, ctx, doc, pushHistory);
      case 'lock_frames':
        return execLockFrames(args, ctx, doc, pushHistory);
      case 'hide_frames':
        return execHideFrames(args, ctx, doc, pushHistory);
      case 'clip_frames':
        return execClipFrames(args, ctx, doc, pushHistory);
      case 'hide_nodes':
        return execHideNodes(args, ctx, doc, pushHistory);
      case 'update_frame':
        return execUpdateFrame(args, ctx, doc, pushHistory);
      case 'create_frame':
        return execCreateFrame(args, ctx, doc, pushHistory);
      case 'image_process':
        return execImageProcess(args, ctx, doc, pushHistory);
      case 'export_canvas':
        return execExportCanvas(args, ctx, doc, pushHistory);
      case 'edit_path_points':
        return execEditPathPoints(args, ctx, doc, pushHistory);
      case 'apply_brush_preset':
        return execApplyBrushPreset(args, ctx, doc, pushHistory);
      default:
        return resolveUnknownToolError(name);
    }

  } catch (err: any) {
    return {
      status: 'error',
      summary: err?.message || String(err),
      next_actions: ['Fix arguments and retry'],
    };
  }
}
