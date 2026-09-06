/**
 * Debounced project sync: IndexedDB draft — incremental PATCH (or PUT) for document.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useSelector } from '@/store';
import { useCurrentProjectId, useEditorDocument } from '@/store/editorSelectors';
import { useTranslation } from 'react-i18next';
import {
  upsertProjectApi,
  patchProjectApi,
  deleteProjectApi,
  deleteProjectsApi,
  fetchProject,
  findProjectSummaryInListCache,
  syncProjectRowFromServer,
  removeProjectFromListCache,
  refreshProjectsListAfterMutation,
  type ProjectSummaryDto,
} from '@/service/projects';
import store from '@/store';
import {
  clearEditorDirty,
  persistCurrent,
} from '@/store/modules/editor';
import { isOwnedTemplate } from '@/utils/templatesStorage';
import { getToken } from '@/utils/token';
import { getHttpStatus, getHttpErrorBody } from '@/service/client';
import { normalizeProjectThumbnailUrls } from '@/utils/projectThumb';
import {
  buildProjectDocumentPatch,
  deleteProjectDrafts,
  getProjectDraft,
  hashDocument,
  markProjectDraftSynced,
  putProjectDraft,
} from '@/components/editor/projectDraftStore';
import { isCollabCloudPersistOwned } from '@/components/editor/collab/collabRuntime';
import { isInteractionPerfSessionActive } from '@/components/editor/sceneEvents';
import { message } from '@/components/base';
import {
  isProjectDeleted,
  markProjectsDeleted,
  unmarkProjectsDeleted,
} from '@/utils/deletedProjectsGuard';
import { normalizeProjectIds } from '@/utils/normalizeProjectId';
import { probeProjectOpenElsewhere } from '@/utils/openProjectSessions';

const DEBOUNCE_MS = 800;
/** Large scenes: give paste/select paint room before IDB/hash work. */
const LARGE_DOC_DEBOUNCE_MS = 2500;
const LARGE_DOC_NODE_THRESHOLD = 800;
/** Coalesce rapid Ctrl/⌘S into one flush. */
const MANUAL_SAVE_DEBOUNCE_MS = 300;
/** Delete / structural edits should hit the cloud ASAP (refresh must not restore old nodes). */
const FLUSH_NOW_EVENT = 'resume:flush-project';
/**
 * After a failed PUT/PATCH, do not hammer the API every debounce tick.
 * Pause auto-retry for the same document hash once this ladder is exhausted.
 */
const CLOUD_FAIL_BACKOFF_MS = [2_000, 5_000, 15_000, 45_000] as const;

function cloudFailRetryDelayMs(failCount: number): number {
  const idx = Math.max(
    0,
    Math.min(failCount - 1, CLOUD_FAIL_BACKOFF_MS.length - 1)
  );
  return CLOUD_FAIL_BACKOFF_MS[idx];
}

function shouldPauseCloudAutoRetry(failCount: number): boolean {
  return failCount >= CLOUD_FAIL_BACKOFF_MS.length;
}

function editorFlushDelayMs(document: unknown): number {
  const delta =
    document &&
    typeof document === 'object' &&
    (document as { deltaSetLike?: Record<string, unknown> }).deltaSetLike;
  const n = delta && typeof delta === 'object' ? Object.keys(delta).length : 0;
  if (n >= LARGE_DOC_NODE_THRESHOLD) return LARGE_DOC_DEBOUNCE_MS;
  return DEBOUNCE_MS;
}

/** Latest in-flight / queued editor flush — Home awaits this before re-listing projects. */
let flushChain: Promise<void> = Promise.resolve();
let flushRunner: ((opts?: FlushProjectOptions) => Promise<FlushProjectResult>) | null = null;

export type FlushProjectOptions = {
  /** Leave-editor / Home: push document even when dirty is false or draft looks synced. */
  force?: boolean;
};

/** Outcome of a single flush pass — manual save uses this for user feedback. */
export type FlushProjectResult = 'saved' | 'local' | 'unchanged' | 'failed' | 'conflict' | 'skipped';

/** Force an immediate project sync and wait until it settles. */
export function flushCurrentProjectNow(opts?: FlushProjectOptions): Promise<FlushProjectResult> {
  const run = flushRunner;
  if (!run) return Promise.resolve('skipped');
  const next: Promise<FlushProjectResult> = (async () => {
    await flushChain;
    return run(opts);
  })();
  // Keep the queue alive even if one pass fails.
  flushChain = (async () => {
    try {
      await next;
    } catch {
      /* ignore */
    }
  })();
  return next;
}

/** Multi-tab / stale client lost the race — server document is newer. */
export class ProjectRevisionConflictError extends Error {
  projectId: string;
  revision: number;
  updatedAt: number;

  constructor(opts: { projectId: string; revision: number; updatedAt?: number }) {
    super('project_revision_conflict');
    this.name = 'ProjectRevisionConflictError';
    this.projectId = opts.projectId;
    this.revision = opts.revision;
    this.updatedAt = opts.updatedAt || 0;
  }
}

export type CloudAck = {
  revision: number;
  thumbnailUrl?: string | string[] | null;
  updatedAt?: number;
};

/** Discriminated write outcome — callers branch on `status`, not nested catch. */
export type CloudWriteResult =
  | { status: 'ok'; ack: CloudAck }
  | { status: 'conflict'; conflict: ProjectRevisionConflictError }
  | { status: 'failed' };

export class ProjectDeleteBlockedError extends Error {
  projectId: string;

  constructor(projectId: string) {
    super('project_open_for_editing');
    this.name = 'ProjectDeleteBlockedError';
    this.projectId = projectId;
  }
}

async function removeProjectsFromCloudInternal(rawIds: string[]): Promise<void> {
  const list = normalizeProjectIds(rawIds);
  if (!list.length) return;

  // Always probe — including HTTP deploys (request id falls back when randomUUID
  // is missing). Fail closed: if a probe errors, treat as open-for-editing so we
  // never delete a project that may still be in an editor tab.
  const probes = await Promise.all(
    list.map(async (id) => {
      try {
        return await probeProjectOpenElsewhere(id);
      } catch {
        return true;
      }
    })
  );
  const blocked = list.find((_, i) => probes[i]);
  if (blocked) throw new ProjectDeleteBlockedError(blocked);

  markProjectsDeleted(list);
  await deleteProjectDrafts(list);
  if (!getToken()) return;

  const rollback = () => unmarkProjectsDeleted(list);

  try {
    if (list.length === 1) {
      const outcome = await tryCloudApi(() => deleteProjectApi(list[0]));
      if (outcome.status !== 'ok') {
        rollback();
        throw new Error('project_delete_failed');
      }
    } else {
      await deleteProjectsApi(list);
    }
  } catch (err) {
    rollback();
    throw err;
  }

  for (const id of list) removeProjectFromListCache(id);
  const refreshId = list.length === 1 ? list[0] : undefined;
  void refreshProjectsListAfterMutation(refreshId);
}

export async function removeProjectFromCloud(id: string): Promise<void> {
  await removeProjectsFromCloudInternal([id]);
}

/** Batch remove owned projects from the API (no-op when logged out). */
export async function removeProjectsFromCloud(ids: string[]): Promise<void> {
  await removeProjectsFromCloudInternal(ids);
}

function asConflict(err: unknown): ProjectRevisionConflictError | null {
  if (getHttpStatus(err) !== 412) return null;
  const body = getHttpErrorBody(err) as { detail?: unknown } | undefined;
  const detail = body && typeof body === 'object' ? body.detail : undefined;
  const row =
    detail && typeof detail === 'object'
      ? (detail as Record<string, unknown>)
      : null;
  const revision = Number(row?.revision);
  return new ProjectRevisionConflictError({
    projectId: String(row?.id || ''),
    revision: Number.isFinite(revision) && revision >= 1 ? revision : 0,
    updatedAt: Number(row?.updatedAt) || 0,
  });
}

/** Single IO boundary: network throws become a status the caller can judge. */
async function tryCloudApi<T>(fn: () => Promise<T>): Promise<
  | { status: 'ok'; data: T }
  | { status: 'conflict'; conflict: ProjectRevisionConflictError }
  | { status: 'failed' }
> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (err) {
    const conflict =
      err instanceof ProjectRevisionConflictError ? err : asConflict(err);
    if (conflict) return { status: 'conflict', conflict };
    return { status: 'failed' };
  }
}

type ThumbUpload = {
  thumbnailUrls?: string[];
};

function applyThumbUpload(
  data: {
    thumbnailUrls?: string[] | null;
  },
  thumb: ThumbUpload
) {
  if (thumb.thumbnailUrls?.length) data.thumbnailUrls = thumb.thumbnailUrls;
}

function clearDirtyIfSameDoc(
  pushedDoc: unknown
): void {
  const after = store.getState().editor as { document: unknown };
  if (after.document === pushedDoc) clearEditorDirty();
}

async function applyCloudAck(opts: {
  projectId: string;
  contentHash: string;
  pushedDoc: unknown;
  ack?: CloudAck;
  projectName?: string;
}): Promise<void> {
  const ed = store.getState().editor as {
    templates?: { id: string; name?: string }[];
  };
  const tplName =
    opts.projectName ||
    ed.templates?.find((t) => t.id === opts.projectId)?.name ||
    'Untitled';
  const existing = findProjectSummaryInListCache(opts.projectId);
  const ackUpdatedAt = opts.ack?.updatedAt ?? Date.now();

  if (opts.ack) {
    if (isProjectDeleted(opts.projectId)) return;
    const thumb =
      opts.ack.thumbnailUrl !== undefined
        ? opts.ack.thumbnailUrl
        : existing?.thumbnailUrl ?? null;
    const row: ProjectSummaryDto = {
      id: opts.projectId,
      name: tplName,
      thumbnailUrl: thumb,
      thumbnailCustom: existing?.thumbnailCustom ?? false,
      revision: opts.ack.revision ?? existing?.revision,
      updatedAt: ackUpdatedAt,
      createdAt: existing?.createdAt ?? ackUpdatedAt,
      orgId: existing?.orgId ?? null,
      orgName: existing?.orgName ?? null,
      hasDocument: existing?.hasDocument ?? true,
    };
    syncProjectRowFromServer(row);
  }

  await markProjectDraftSynced(
    opts.projectId,
    opts.contentHash,
    opts.ack?.revision ?? null
  );
  clearDirtyIfSameDoc(opts.pushedDoc);
}

export function asCloudRevision(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.floor(n);
}

function isDraftAlreadyAcked(
  draft: { syncedAt?: number | null; contentHash?: string; name?: string } | null | undefined,
  contentHash: string,
  name: string
): boolean {
  return Boolean(
    draft?.syncedAt &&
      draft.contentHash === contentHash &&
      String(draft.name || '') === name
  );
}

function fullPutReason(
  baseDoc: unknown | null,
  baseRevision: number | null,
  preferFull: boolean | undefined
): string {
  if (!baseDoc) return 'missing_baseDocument';
  if (baseRevision == null) return 'missing_baseRevision';
  if (preferFull) return 'preferFull';
  return 'fallback';
}

function ackFromProject(project: {
  revision?: unknown;
  thumbnailUrl?: string | string[] | null;
  updatedAt?: unknown;
} | null | undefined): CloudAck | null {
  const revision = asCloudRevision(project?.revision);
  if (revision == null) return null;
  const updatedAt = Number(project?.updatedAt);
  return {
    revision,
    thumbnailUrl: project?.thumbnailUrl ?? null,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : undefined,
  };
}

/** Placeholder until a real conflict dialog lands — keeps EditorPage mount valid. */
export function ProjectRevisionConflictDialog() {
  return null;
}

/** Push one owned project to the API (no-op when logged out). */
export async function pushProjectToCloud(payload: {
  id: string;
  name: string;
  document: unknown;
  thumb?: ThumbUpload;
  baseRevision?: number | null;
}): Promise<CloudWriteResult> {
  if (!getToken()) return { status: 'failed' };
  if (!payload.id || !payload.document) return { status: 'failed' };
  if (isProjectDeleted(payload.id)) return { status: 'failed' };
  const base = asCloudRevision(payload.baseRevision);
  const data: Parameters<typeof upsertProjectApi>[0] = {
    id: payload.id,
    name: payload.name || 'Untitled',
    document: payload.document as Record<string, unknown>,
  };
  if (payload.thumb) applyThumbUpload(data, payload.thumb);
  if (base != null) data.baseRevision = base;
  // First cloud write — attach preferred team org when set in Account — Organization.
  if (base == null) {
    try {
      const orgId = localStorage.getItem('recombyn.preferredOrgId')?.trim();
      if (orgId) data.orgId = orgId;
    } catch {
      /* ignore */
    }
  }

  const outcome = await tryCloudApi(() =>
    upsertProjectApi(data, base != null ? { 'If-Match': `"${base}"` } : undefined)
  );
  if (outcome.status !== 'ok') return outcome;
  const ack = ackFromProject(outcome.data?.project);
  if (!ack) return { status: 'failed' };
  return { status: 'ok', ack };
}

/** Incremental node patch — requires a known baseRevision. */
export async function patchProjectToCloud(payload: {
  id: string;
  name: string;
  baseRevision: number;
  patch: NonNullable<ReturnType<typeof buildProjectDocumentPatch>>['patch'];
  thumb?: ThumbUpload;
}): Promise<CloudWriteResult> {
  if (!getToken()) return { status: 'failed' };
  if (!payload.id || !(payload.baseRevision >= 1)) return { status: 'failed' };
  if (isProjectDeleted(payload.id)) return { status: 'failed' };
  const base = Math.max(1, Math.floor(Number(payload.baseRevision)));
  const data: Parameters<typeof patchProjectApi>[1] = {
    baseRevision: base,
    name: payload.name || 'Untitled',
  };
  if (payload.thumb) applyThumbUpload(data, payload.thumb);
  if (payload.patch.upsertNodes) {
    data.upsertNodes = payload.patch.upsertNodes as Record<string, unknown>;
  }
  if (payload.patch.removeNodeIds) data.removeNodeIds = payload.patch.removeNodeIds;
  if (payload.patch.pageChildren) data.pageChildren = payload.patch.pageChildren;
  if (payload.patch.frames) data.frames = payload.patch.frames;
  if (payload.patch.activeFrameId !== undefined) {
    data.activeFrameId = payload.patch.activeFrameId;
  }
  if (payload.patch.canvas) data.canvas = payload.patch.canvas;

  const outcome = await tryCloudApi(() =>
    patchProjectApi(payload.id, data, { 'If-Match': `"${base}"` })
  );
  if (outcome.status !== 'ok') return outcome;
  const ack = ackFromProject(outcome.data?.project);
  if (!ack) return { status: 'failed' };
  return { status: 'ok', ack };
}

/** Ask the open editor to flush the project to the cloud immediately. */
export function requestProjectFlush() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FLUSH_NOW_EVENT));
  }
  void flushCurrentProjectNow();
}

/** Rename an owned project on the API (home grid / offline-safe local first). */
export async function renameProjectOnCloud(id: string, name: string): Promise<void> {
  const projectId = String(id || '').trim();
  const nextName = String(name || '').trim() || 'Untitled';
  if (!projectId) return;

  const draft = await getProjectDraft(projectId);
  if (draft?.document) {
    await putProjectDraft({
      projectId,
      name: nextName,
      document: draft.document,
      updatedAt: Date.now(),
      keepSyncedAt: true,
      keepCloudRevision: true,
      keepBaseDocument: true,
    });
  }

  if (!getToken()) return;

  const rev = asCloudRevision(draft?.cloudRevision);
  if (rev != null && draft?.document) {
    const patched = await patchProjectToCloud({
      id: projectId,
      name: nextName,
      baseRevision: rev,
      patch: {},
    });
    if (patched.status === 'ok') {
      await markProjectDraftSynced(
        projectId,
        draft.contentHash,
        patched.ack.revision
      );
      return;
    }
  }

  const fetched = await tryCloudApi(() => fetchProject(projectId));
  if (fetched.status !== 'ok') return;
  const proj = fetched.data.project;
  if (!proj?.document) return;
  const existingUrls = normalizeProjectThumbnailUrls(proj.thumbnailUrl);
  const pushed = await pushProjectToCloud({
    id: projectId,
    name: nextName,
    document: proj.document,
    thumb: existingUrls.length ? { thumbnailUrls: existingUrls } : undefined,
    baseRevision: asCloudRevision(proj.revision),
  });
  if (pushed.status !== 'ok') return;
  await putProjectDraft({
    projectId,
    name: nextName,
    document: proj.document,
    updatedAt: Date.now(),
    syncedAt: Date.now(),
    cloudRevision: asCloudRevision(pushed.ack.revision ?? proj.revision),
    baseDocument: proj.document,
  });
}

/** Prefer incremental PATCH; fall back to full PUT. Callers judge `status`. */
export async function syncOwnedDocumentToCloud(opts: {
  id: string;
  name: string;
  document: unknown;
  baseRevision: number | null;
  baseDoc: unknown | null;
}): Promise<CloudWriteResult> {
  const { id, name, document, baseRevision, baseDoc } = opts;
  const delta =
    baseDoc && baseRevision != null
      ? buildProjectDocumentPatch(baseDoc, document)
      : null;

  if (delta && !delta.preferFull && baseRevision != null) {
    const patched = await patchProjectToCloud({
      id,
      name,
      baseRevision,
      patch: delta.patch,
    });
    if (patched.status !== 'failed') return patched;
    if (import.meta.env.DEV) {
      console.warn('[project-sync] PATCH failed → full PUT');
    }
    return pushProjectToCloud({ id, name, document, baseRevision });
  }

  if (!delta && baseDoc && baseRevision != null) {
    // Document unchanged — still PATCH so renames reach the server (empty delta alone skips).
    const patched = await patchProjectToCloud({
      id,
      name,
      baseRevision,
      patch: {},
    });
    if (patched.status !== 'failed') return patched;
    return pushProjectToCloud({ id, name, document, baseRevision });
  }

  return pushProjectToCloud({ id, name, document, baseRevision });
}

async function handleFlushConflict(opts: {
  projectId: string;
  name: string;
  pushedDoc: unknown;
  conflict: ProjectRevisionConflictError;
}): Promise<void> {
  const serverRev = asCloudRevision(opts.conflict.revision);
  if (serverRev == null) return;
  // Keep the local canvas. Only refresh If-Match — GET+importDocument realigns
  // frameless boolean results to (0,0) and looks like the page jumped.
  await putProjectDraft({
    projectId: opts.projectId,
    name: opts.name,
    document: opts.pushedDoc,
    updatedAt: Date.now(),
    syncedAt: null,
    cloudRevision: serverRev,
    keepBaseDocument: true,
  });
}

const MANUAL_SAVE_TOAST: Partial<
  Record<FlushProjectResult, { level: 'success' | 'error' | 'warning'; key: string }>
> = {
  saved: { level: 'success', key: 'editor.projectSavedOk' },
  local: { level: 'success', key: 'editor.projectSavedLocal' },
  unchanged: { level: 'success', key: 'editor.projectSavedUpToDate' },
  failed: { level: 'error', key: 'editor.projectSaveFailed' },
  conflict: { level: 'warning', key: 'editor.revisionConflictTitle' },
};

function notifyManualSaveResult(result: FlushProjectResult, t: (key: string) => string): void {
  const spec = MANUAL_SAVE_TOAST[result];
  if (!spec) return;
  const text = t(spec.key);
  if (spec.level === 'error') message.error(text);
  else if (spec.level === 'warning') message.warning(text);
  else message.success(text);
}

/** Editor: debounce local draft + cloud upsert while editing. */
export function useProjectCloudSync() {
  const { t } = useTranslation();
  const dirty = useSelector((s: any) => Boolean(s.editor.dirty));
  const document = useEditorDocument();
  const currentId = useCurrentProjectId();
  const template = useSelector((s: any) =>
    s.editor.templates.find((t: any) => t.id === s.editor.currentId)
  );
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushingRef = useRef(false);
  /** Delete/edit while a flush is in-flight — run again after current finishes. */
  const pendingFlushRef = useRef(false);
  /** Consecutive cloud write failures for the current document hash. */
  const cloudFailCountRef = useRef(0);
  const cloudFailHashRef = useRef<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const scheduleFlush = useCallback((delayMs: number) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void flushCurrentProjectNow();
    }, delayMs);
  }, []);

  const flush = useCallback(async (opts?: FlushProjectOptions): Promise<FlushProjectResult> => {
    // Read editor store directly — requestProjectFlush may fire before this hook re-renders.
    const force = Boolean(opts?.force);
    const w = typeof window !== 'undefined' ? window : null;
    const skipFlush =
      Boolean((w as Window & { __RCB_SKIP_PROJECT_FLUSH__?: boolean })?.__RCB_SKIP_PROJECT_FLUSH__) ||
      Boolean((w as Window & { __RCB_PASTE_PERF__?: boolean })?.__RCB_PASTE_PERF__);
    // Paste perf / stress: IDB structured-clone of 2k+ docs blocked the next Ctrl+V.
    if (!force && skipFlush) {
      scheduleFlush(LARGE_DOC_DEBOUNCE_MS);
      return 'skipped';
    }
    // Paste/select paint must finish before O(doc) draft hash / IDB write.
    if (!force && isInteractionPerfSessionActive()) {
      scheduleFlush(LARGE_DOC_DEBOUNCE_MS);
      return 'skipped';
    }
    const ed = store.getState().editor as {
      dirty: boolean;
      document: unknown;
      currentId: string | null;
      templates: any[];
    };
    const id = ed.currentId;
    const tpl = ed.templates.find((t) => t.id === id);
    if ((!ed.dirty && !force) || !ed.document || !id || !tpl) return 'skipped';
    if (isProjectDeleted(id)) return 'skipped';
    if (id.startsWith('share_') || !isOwnedTemplate(tpl)) return 'skipped';
    if (flushingRef.current) {
      pendingFlushRef.current = true;
      return 'skipped';
    }
    flushingRef.current = true;
    let cloudAttempted = false;
    let cloudOk = false;
    let pauseAutoRetry = false;

    try {
      persistCurrent({ keepDirty: true });
      const pushedDoc = (store.getState().editor as { document: unknown }).document;
      const name = String(tpl.name || 'Untitled');
      const draft = await putProjectDraft({
        projectId: id,
        name,
        document: pushedDoc,
        updatedAt: Date.now(),
        keepSyncedAt: true,
        keepCloudRevision: true,
        keepBaseDocument: true,
      });
      const contentHash = draft?.contentHash || hashDocument(pushedDoc);

      // New edits unlock a previously paused failure streak.
      if (cloudFailHashRef.current && cloudFailHashRef.current !== contentHash) {
        cloudFailCountRef.current = 0;
        cloudFailHashRef.current = null;
      }

      if (!force && isDraftAlreadyAcked(draft, contentHash, name)) {
        clearDirtyIfSameDoc(pushedDoc);
        return 'unchanged';
      }
      if (!getToken()) {
        clearDirtyIfSameDoc(pushedDoc);
        return 'local';
      }
      if (isCollabCloudPersistOwned() && !force) {
        clearDirtyIfSameDoc(pushedDoc);
        return 'skipped';
      }

      // Same doc already failed the backoff ladder — wait for edits or force save.
      if (
        !force &&
        shouldPauseCloudAutoRetry(cloudFailCountRef.current) &&
        cloudFailHashRef.current === contentHash
      ) {
        pauseAutoRetry = true;
        return 'failed';
      }

      cloudAttempted = true;
      const written = await syncOwnedDocumentToCloud({
        id,
        name,
        document: pushedDoc,
        baseRevision: asCloudRevision(draft?.cloudRevision),
        baseDoc: draft?.baseDocument ?? null,
      });
      if (written.status === 'ok') {
        cloudOk = true;
        cloudFailCountRef.current = 0;
        cloudFailHashRef.current = null;
        await applyCloudAck({
          projectId: id,
          contentHash,
          pushedDoc,
          ack: written.ack,
          projectName: name,
        });
        return 'saved';
      }
      if (written.status === 'conflict') {
        cloudFailCountRef.current = 0;
        cloudFailHashRef.current = null;
        await handleFlushConflict({
          projectId: id,
          name,
          pushedDoc,
          conflict: written.conflict,
        });
        return 'conflict';
      }
      cloudFailCountRef.current += 1;
      cloudFailHashRef.current = contentHash;
      if (shouldPauseCloudAutoRetry(cloudFailCountRef.current)) {
        pauseAutoRetry = true;
      }
      if (import.meta.env.DEV) {
        console.warn('[project-sync] cloud write failed', {
          id,
          fails: cloudFailCountRef.current,
          paused: pauseAutoRetry,
        });
      }
      return 'failed';
    } catch {
      return 'failed';
    } finally {
      flushingRef.current = false;
      const still = store.getState().editor as {
        dirty: boolean;
        currentId: string | null;
        document: unknown;
      };
      const queued = pendingFlushRef.current;
      pendingFlushRef.current = false;
      // No `return` in finally — eslint no-unsafe-finally.
      if (still.currentId === id) {
        if (queued) {
          // Never scheduleFlush(0) on large docs — immediate re-hash/IDB after a
          // paste-interrupted flush is what stacked paste #2+ to multi-second stalls.
          scheduleFlush(editorFlushDelayMs(still.document));
        } else if (still.dirty && !pauseAutoRetry) {
          if (cloudAttempted && !cloudOk && cloudFailCountRef.current > 0) {
            scheduleFlush(cloudFailRetryDelayMs(cloudFailCountRef.current));
          } else {
            scheduleFlush(editorFlushDelayMs(still.document));
          }
        }
      }
    }
  }, [scheduleFlush]);

  flushRunner = flush;

  useEffect(() => {
    if (!dirty || !document || !currentId || !template) return;
    if (String(currentId).startsWith('share_')) return;
    if (!isOwnedTemplate(template)) return;
    scheduleFlush(editorFlushDelayMs(document));
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [dirty, document, currentId, template, scheduleFlush]);

  // Clear debounce timers only — requestProjectFlush owns the single flush enqueue.
  useEffect(() => {
    const onFlushNow = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      if (manualSaveTimerRef.current) clearTimeout(manualSaveTimerRef.current);
      manualSaveTimerRef.current = null;
    };
    window.addEventListener(FLUSH_NOW_EVENT, onFlushNow);
    return () => window.removeEventListener(FLUSH_NOW_EVENT, onFlushNow);
  }, []);

  // Ctrl/⌘S — manual save (debounced so key-repeat / rapid presses don't spam).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 's') return;
      e.preventDefault();
      if (manualSaveTimerRef.current) clearTimeout(manualSaveTimerRef.current);
      manualSaveTimerRef.current = setTimeout(() => {
        manualSaveTimerRef.current = null;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = null;
        void flushCurrentProjectNow({ force: true }).then((result) => {
          notifyManualSaveResult(result, t);
        });
      }, MANUAL_SAVE_DEBOUNCE_MS);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (manualSaveTimerRef.current) clearTimeout(manualSaveTimerRef.current);
      manualSaveTimerRef.current = null;
    };
  }, [t]);

  // Leave / hide: force sync once (not every debounce). Unmount same.
  useEffect(() => {
    const onHide = () => {
      if (!dirtyRef.current) return;
      void flushCurrentProjectNow({ force: true });
    };
    const onVisibility = () => {
      if (window.document.visibilityState === 'hidden') onHide();
    };
    window.addEventListener('pagehide', onHide);
    window.document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      window.document.removeEventListener('visibilitychange', onVisibility);
      if (dirtyRef.current) {
        void flushCurrentProjectNow({ force: true });
      }
    };
  }, []);
}

/** Placeholder until a real conflict dialog lands — keeps EditorPage mount valid. */
export async function applyProjectRevisionConflictChoice(_opts: {
  projectId: string;
  name: string;
  localDocument?: unknown;
  mode?: 'solo' | 'collab';
}): Promise<'adopted' | 'failed'> {
  return 'failed';
}

