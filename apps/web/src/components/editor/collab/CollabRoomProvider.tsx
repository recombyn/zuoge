/**
 * Yjs room lifecycle: mint token → IndexedDB (offline) + WebsocketProvider → bridge scene → store.
 * Presence (selection / cursors) via Awareness. Persist via debounced cloud PATCH (or PUT).
 * Offline: y-indexeddb keeps the room locally; reconnect merges with peers / server.
 * @see https://docs.yjs.dev/getting-started/allowing-offline-editing
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from '@/store';
import {
  useActiveFrameId,
  useCurrentProjectId,
  useDocumentRevision,
  useSelectedFrameIds,
  useSelectedNodeIds,
} from '@/store/editorSelectors';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { WebsocketProvider } from 'y-websocket';
import { Awareness } from 'y-protocols/awareness';
import { mintCollabRoomTokenApi } from '@/service/collab';
import { apiClient } from '@/service/client';
import { rcbSceneToScreen, rcbScreenToScene } from '@/components/rcb/core/math';
import type { RcbCamera } from '@/components/rcb/core/types';
import {
  getProjectDraft,
  hashDocument,
  markProjectDraftSynced,
  putProjectDraft,
} from '@/components/editor/projectDraftStore';
import {
  asCloudRevision,
  pushProjectToCloud,
  syncOwnedDocumentToCloud,
} from '@/components/editor/useProjectCloudSync';
import store from '@/store';
import { applyCollabDocument, applyCollabScenePatch } from '@/store/modules/editor';
import { getToken } from '@/utils/token';
import { isAnimationWorkbenchGeometryPreview } from '@/components/editor/nodes/AnimationNode/animationWorkbenchFocus';
import {
  bindCollabUndoManager,
  clearCollabUndoStack,
  setCollabActive,
  setCollabCloudPersistOwned,
  setCollabViewOnly,
} from './collabRuntime';
import type { CollabPeer, CollabRole, CollabStatus } from './collabTypes';
import {
  applyLocalSceneToY,
  diffScenesForCollab,
  isYDocEmpty,
  sceneFromYDoc,
  seedYDocFromScene,
  tryClaimRoomSeed,
  yFramesMap,
  yMetaMap,
  yNodesMap,
  yPageChildren,
  yStackOrder,
  Y_ORIGIN_LOCAL,
  Y_ORIGIN_SEED,
  Y_ORIGIN_SEED_CLAIM,
} from './sceneYBridge';

const CURSOR_AWARENESS_MS = 48;
/** Wait for peer seed / claim to land before electing an empty-room seeder. */
const SEED_RACE_WAIT_MS = 120;
const SEED_FOLLOWER_WAIT_MS = 450;

function waitIndexeddbSynced(persistence: IndexeddbPersistence): Promise<void> {
  if (persistence.synced) return Promise.resolve();
  return new Promise((resolve) => {
    persistence.once('synced', () => resolve());
  });
}

function dispatchRemoteScene(prev: unknown, next: unknown) {
  const diff = diffScenesForCollab(prev, next);
  if (diff.mode === 'full') {
    applyCollabDocument(diff.scene ?? next);
    return;
  }
  const noop =
    !diff.meta &&
    !Object.keys(diff.upsertNodes).length &&
    !diff.removeNodeIds.length &&
    !Object.keys(diff.upsertFrames).length &&
    !diff.removeFrameIds.length &&
    diff.pageChildren == null &&
    diff.stackOrder == null;
  if (noop) return;
  applyCollabScenePatch(diff);
}

const PERSIST_DEBOUNCE_MS = 2000;
const PEER_COLORS = ['#E4572E', '#29335C', '#F3A712', '#A8C256', '#669BBC', '#6A4C93'];
const CAMERA_AWARENESS_MS = 80;

/** One cloud write at a time — overlapping PUTs share If-Match and 412. */
let persistChain: Promise<void> = Promise.resolve();

/** Debounced cloud persist of the collab Y scene (owner/editor only) — PATCH when possible. */
async function persistCloudSnapshot(opts: {
  id: string;
  name: string;
  scene: unknown;
}): Promise<void> {
  const next = persistChain.then(() => persistCloudSnapshotOnce(opts));
  persistChain = next.then(
    () => undefined,
    () => undefined
  );
  await next;
}

async function persistCloudSnapshotOnce(opts: {
  id: string;
  name: string;
  scene: unknown;
}): Promise<void> {
  const { id, name, scene } = opts;
  const draft = await getProjectDraft(id);
  const contentHash = hashDocument(scene);
  if (
    draft?.syncedAt &&
    draft.contentHash === contentHash &&
    String(draft.name || '') === name
  ) {
    return;
  }
  const written = await syncOwnedDocumentToCloud({
    id,
    name,
    document: scene,
    baseRevision: asCloudRevision(draft?.cloudRevision),
    baseDoc: draft?.baseDocument ?? null,
  });

  if (written.status === 'ok') {
    await markProjectDraftSynced(id, contentHash, written.ack.revision);
    return;
  }
  if (written.status === 'conflict') {
    const serverRev = asCloudRevision(written.conflict.revision);
    if (serverRev == null) return;
    await putProjectDraft({
      projectId: id,
      name,
      document: scene,
      updatedAt: Date.now(),
      syncedAt: null,
      cloudRevision: serverRev,
      keepBaseDocument: true,
    });
    return;
  }

  // Transport flake — last-writer full PUT without If-Match.
  const forced = await pushProjectToCloud({
    id,
    name,
    document: scene,
    baseRevision: null,
  });
  if (forced.status === 'ok') {
    await markProjectDraftSynced(id, contentHash, forced.ack.revision);
  }
}

type CollabContextValue = {
  status: CollabStatus;
  role: CollabRole | null;
  peers: CollabPeer[];
  enabled: boolean;
  error: string | null;
  followingUserId: string | null;
  followPeer: (userId: string) => void;
  unfollowPeer: () => void;
};

const CollabContext = createContext<CollabContextValue>({
  status: 'idle',
  role: null,
  peers: [],
  enabled: false,
  error: null,
  followingUserId: null,
  followPeer: () => undefined,
  unfollowPeer: () => undefined,
});

export function useCollabRoom() {
  return useContext(CollabContext);
}

function peerColor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i += 1) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

function sceneHash(doc: unknown): string {
  try {
    return JSON.stringify(doc);
  } catch {
    return '';
  }
}

function shouldEnableCollab(searchParams: URLSearchParams): boolean {
  if (searchParams.get('collab') === '0') return false;
  if (searchParams.get('collab') === '1') return true;
  const env = String(import.meta.env.VITE_COLLAB_ENABLED || '').toLowerCase();
  if (env === '0' || env === 'false' || env === 'no') return false;
  if (env === '1' || env === 'true' || env === 'yes') return true;
  // Local Vite: on by default so two tabs on the same project sync without a query flag.
  return Boolean(import.meta.env.DEV);
}

function parsePeerCamera(raw: unknown): CollabPeer['camera'] {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as { x?: unknown; y?: unknown; zoom?: unknown };
  if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.zoom)) return null;
  return { x: Number(c.x), y: Number(c.y), zoom: Number(c.zoom) };
}

function camerasClose(a: RcbCamera, b: RcbCamera): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.zoom - b.zoom) < 0.0001
  );
}

/** Pan so a scene point sits near the stage center (fallback when peer has no camera yet). */
function cameraCenteringScenePoint(
  sceneX: number,
  sceneY: number,
  zoom: number,
  stageEl: HTMLElement
): RcbCamera {
  const z = Math.max(0.05, zoom || 1);
  const w = Math.max(1, stageEl.clientWidth || 0);
  const h = Math.max(1, stageEl.clientHeight || 0);
  return {
    x: w / 2 - sceneX * z,
    y: h / 2 - sceneY * z,
    zoom: z,
  };
}

function preferPeer(prev: CollabPeer, next: CollabPeer): CollabPeer {
  // Newer Yjs client wins (refresh / reconnect). Tie-break: prefer live cursor / camera.
  if (next.clientId > prev.clientId) return next;
  if (prev.clientId > next.clientId) return prev;
  if (next.camera && !prev.camera) return next;
  if (next.cursor && !prev.cursor) return next;
  return prev;
}

/** One entry per userId — skip self (incl. stale tabs after refresh) and merge multi-tab ghosts. */
function readPeers(awareness: Awareness, selfId: number, selfUserId: string): CollabPeer[] {
  const byUserId = new Map<string, CollabPeer>();
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === selfId) return;
    const user = (state as any)?.user;
    if (!user?.userId) return;
    const userId = String(user.userId);
    if (userId === selfUserId) return;
    const cursor = (state as any)?.cursor;
    const selected = (state as any)?.selectedNodeIds;
    const frames = (state as any)?.selectedFrameIds;
    const peer: CollabPeer = {
      clientId,
      userId,
      name: String(user.name || 'Peer'),
      color: String(user.color || peerColor(userId)),
      selectedNodeIds: Array.isArray(selected) ? selected.map(String) : [],
      selectedFrameIds: Array.isArray(frames) ? frames.map(String) : [],
      cursor:
        cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
          ? { x: Number(cursor.x), y: Number(cursor.y) }
          : null,
      camera: parsePeerCamera((state as any)?.camera),
    };
    const existing = byUserId.get(userId);
    byUserId.set(userId, existing ? preferPeer(existing, peer) : peer);
  });
  return Array.from(byUserId.values());
}

function measurePeerTarget(
  stageEl: HTMLElement,
  stageRect: DOMRect,
  peer: CollabPeer,
  id: string,
  kind: 'node' | 'frame'
): {
  key: string;
  left: number;
  top: number;
  width: number;
  height: number;
  color: string;
  name: string;
} | null {
  const selector =
    kind === 'frame'
      ? `[data-frame-id="${CSS.escape(id)}"]`
      : `[data-scene-node-id="${CSS.escape(id)}"]`;
  const el = stageEl.querySelector(selector) as Element | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return {
    key: `${peer.clientId}:${kind}:${id}`,
    left: r.left - stageRect.left,
    top: r.top - stageRect.top,
    width: r.width,
    height: r.height,
    color: peer.color,
    name: peer.name,
  };
}

/** Remote selection outlines + cursors on the stage (pointer-events none). */
function CollabPeerPresenceOverlay({
  stageEl,
  camera,
  peers,
}: {
  stageEl: HTMLElement | null;
  camera: RcbCamera;
  peers: CollabPeer[];
}) {
  const [boxes, setBoxes] = useState<
    Array<{ key: string; left: number; top: number; width: number; height: number; color: string; name: string }>
  >([]);
  const [cursors, setCursors] = useState<
    Array<{ key: string; left: number; top: number; color: string; name: string }>
  >([]);

  useEffect(() => {
    if (!stageEl) {
      setBoxes([]);
      setCursors([]);
      return undefined;
    }
    // No peers → no continuous rAF. Presence overlay must not burn a main-thread
    // frame callback forever on solo/idle editors.
    if (!peers.length) {
      setBoxes([]);
      setCursors([]);
      return undefined;
    }
    let raf = 0;
    let lastBoxesKey = '';
    let lastCursorsKey = '';
    const measure = () => {
      const stageRect = stageEl.getBoundingClientRect();
      const nextBoxes: typeof boxes = [];
      const nextCursors: typeof cursors = [];
      for (const peer of peers) {
        for (const nodeId of peer.selectedNodeIds) {
          if (!nodeId) continue;
          const box = measurePeerTarget(stageEl, stageRect, peer, nodeId, 'node');
          if (box) nextBoxes.push(box);
        }
        for (const frameId of peer.selectedFrameIds) {
          if (!frameId) continue;
          const box = measurePeerTarget(stageEl, stageRect, peer, frameId, 'frame');
          if (box) nextBoxes.push(box);
        }
        if (peer.cursor) {
          const screen = rcbSceneToScreen(camera, peer.cursor.x, peer.cursor.y);
          nextCursors.push({
            key: `cursor:${peer.userId}`,
            left: screen.x,
            top: screen.y,
            color: peer.color,
            name: peer.name,
          });
        }
      }
      const boxesKey = nextBoxes
        .map((b) => `${b.key}:${b.left|0},${b.top|0},${b.width|0},${b.height|0}`)
        .join('|');
      const cursorsKey = nextCursors
        .map((c) => `${c.key}:${c.left|0},${c.top|0}`)
        .join('|');
      if (boxesKey !== lastBoxesKey) {
        lastBoxesKey = boxesKey;
        setBoxes(nextBoxes);
      }
      if (cursorsKey !== lastCursorsKey) {
        lastCursorsKey = cursorsKey;
        setCursors(nextCursors);
      }
      raf = window.requestAnimationFrame(measure);
    };
    raf = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(raf);
  }, [stageEl, peers, camera]);

  if (!stageEl || (!boxes.length && !cursors.length)) return null;
  return createPortal(
    <div className="pointer-events-none absolute inset-0 z-[25] overflow-hidden">
      {boxes.map((b) => (
        <div
          key={b.key}
          className="absolute box-border"
          style={{
            left: b.left,
            top: b.top,
            width: b.width,
            height: b.height,
            border: `2px solid ${b.color}`,
            boxShadow: `0 0 0 1px ${b.color}55`,
          }}
        >
          <span
            className="absolute -top-5 left-0 max-w-[120px] truncate rounded px-1 text-[10px] font-medium text-white"
            style={{ background: b.color }}
          >
            {b.name}
          </span>
        </div>
      ))}
      {cursors.map((c) => (
        <div
          key={c.key}
          className="absolute"
          style={{ left: c.left, top: c.top, transform: 'translate(-2px, -2px)' }}
        >
          <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden>
            <path
              d="M1 1L1 17L5.2 13.2L8.5 19L10.5 18L7.2 12.2L13 12.2L1 1Z"
              fill={c.color}
              stroke="#fff"
              strokeWidth="1"
            />
          </svg>
          <span
            className="absolute left-3 top-3 max-w-[100px] truncate rounded px-1 text-[10px] font-medium text-white"
            style={{ background: c.color }}
          >
            {c.name}
          </span>
        </div>
      ))}
    </div>,
    stageEl
  );
}

/**
 * Peer presence: overlapping avatars.
 * Click an avatar to follow their viewport; click again or pan/zoom to stop.
 */
export function CollabPresenceBar() {
  const { t } = useTranslation();
  const { enabled, status, peers, error, followingUserId, followPeer, unfollowPeer } =
    useCollabRoom();
  if (!enabled) return null;

  if (status === 'error') {
    return (
      <div
        className="inline-flex h-8 items-center px-1"
        title={error || 'Collab error'}
        aria-label={error || 'Collab error'}
      >
        <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
      </div>
    );
  }

  if (!peers.length) return null;

  const shown = peers.slice(0, 5);
  const overflow = peers.length - shown.length;
  const following = followingUserId
    ? peers.find((p) => p.userId === followingUserId) || null
    : null;

  return (
    <div className="inline-flex h-8 items-center gap-2">
      <div
        className="inline-flex items-center"
        aria-label={`${peers.length} collaborator${peers.length === 1 ? '' : 's'}`}
      >
        {shown.map((p, i) => {
          const isFollowing = followingUserId === p.userId;
          return (
            <button
              key={p.userId}
              type="button"
              className="relative inline-flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-semibold text-white transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
              style={{
                background: p.color,
                marginLeft: i === 0 ? 0 : -10,
                zIndex: isFollowing ? shown.length + 1 : shown.length - i,
                boxShadow: isFollowing
                  ? `0 0 0 2px var(--canvas), 0 0 0 4px ${p.color}`
                  : '0 0 0 2px var(--canvas)',
              }}
              title={
                isFollowing
                  ? t('editor.collabStopFollow')
                  : t('editor.collabFollow', { name: p.name })
              }
              aria-pressed={isFollowing}
              onClick={() => {
                if (isFollowing) unfollowPeer();
                else followPeer(p.userId);
              }}
            >
              {(p.name || '?').slice(0, 1).toUpperCase()}
            </button>
          );
        })}
        {overflow > 0 ? (
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--surface)] text-[11px] font-semibold text-[var(--muted)]"
            style={{ marginLeft: -10, boxShadow: '0 0 0 2px var(--canvas)' }}
            title={`+${overflow} more`}
          >
            +{overflow}
          </span>
        ) : null}
      </div>
      {following ? (
        <button
          type="button"
          onClick={() => unfollowPeer()}
          className="inline-flex h-7 max-w-[9rem] items-center gap-1.5 truncate rounded-full px-2.5 text-[11px] font-medium text-white"
          style={{ background: following.color }}
          title={t('editor.collabStopFollow')}
        >
          <span className="truncate">
            {t('editor.collabFollowing', { name: following.name })}
          </span>
        </button>
      ) : null}
    </div>
  );
}

export function CollabRoomProvider({
  children,
  stageEl,
  camera,
  onCameraChange,
}: {
  children: ReactNode;
  stageEl: HTMLElement | null;
  camera: RcbCamera;
  onCameraChange?: (next: RcbCamera) => void;
}) {
  const [searchParams] = useSearchParams();
  const enabled = shouldEnableCollab(searchParams);
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

  const documentRevision = useDocumentRevision();
  const currentId = useCurrentProjectId();
  const selectedNodeIds = useSelectedNodeIds();
  const selectedFrameIds = useSelectedFrameIds();
  const activeFrameId = useActiveFrameId();
  const user = useSelector(
    (s: any) =>
      s.auth?.user as { id?: string; name?: string; email?: string } | null
  );

  const [status, setStatus] = useState<CollabStatus>('idle');
  const [role, setRole] = useState<CollabRole | null>(null);
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [followingUserId, setFollowingUserId] = useState<string | null>(null);

  const ydocRef = useRef<Y.Doc | null>(null);
  const providerRef = useRef<WebsocketProvider | null>(null);
  const idbRef = useRef<IndexeddbPersistence | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const applyingRemoteRef = useRef(false);
  const applyingFollowRef = useRef(false);
  const lastPushedHashRef = useRef('');
  const seededRef = useRef(false);
  const persistTimerRef = useRef<number | null>(null);
  const documentRef = useRef(store.getState().editor.document);
  documentRef.current = store.getState().editor.document;
  const lastPushedRevisionRef = useRef(-1);

  const followPeer = (userId: string) => {
    setFollowingUserId(userId);
  };
  const unfollowPeer = () => {
    setFollowingUserId(null);
  };

  const ctx = useMemo<CollabContextValue>(
    () => ({
      status,
      role,
      peers,
      enabled,
      error,
      followingUserId,
      followPeer,
      unfollowPeer,
    }),
    [status, role, peers, enabled, error, followingUserId]
  );

  // Connect / disconnect room.
  useEffect(() => {
    if (!enabled || !currentId || !user?.id || !getToken()) {
      setCollabActive(false);
      setCollabCloudPersistOwned(false);
      setStatus('idle');
      setRole(null);
      setPeers([]);
      return undefined;
    }

    let cancelled = false;
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    seededRef.current = false;
    lastPushedHashRef.current = '';
    lastPushedRevisionRef.current = -1;
    setStatus('connecting');
    setError(null);
    setCollabActive(true);
    setCollabCloudPersistOwned(false);

    const refreshCloudPersistOwned = () => {
      setCollabCloudPersistOwned(roleRef.current === 'edit' && seededRef.current);
    };

    // Track only local scene writes — seed / remote / undo replay stay out of the stack.
    const undoManager = new Y.UndoManager(
      [yMetaMap(ydoc), yFramesMap(ydoc), yNodesMap(ydoc), yPageChildren(ydoc), yStackOrder(ydoc)],
      {
        trackedOrigins: new Set([Y_ORIGIN_LOCAL]),
        captureTimeout: 500,
      }
    );
    bindCollabUndoManager(undoManager);

    const roleRef = { current: null as CollabRole | null };
    const idbReadyRef = { current: false };

    const schedulePersist = () => {
      if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = window.setTimeout(() => {
        persistTimerRef.current = null;
        // Viewers must not write cloud snapshots.
        if (roleRef.current === 'view') return;
        const id = currentId;
        const scene = sceneFromYDoc(ydoc);
        if (!id || !scene) return;
        if (id.startsWith('share_')) {
          async function persistShareDocument() {
            try {
              await apiClient.sharesSharesUpdateDocument({
                params: { share_id: id },
                body: { document: scene as Record<string, unknown> },
              });
            } catch {
              /* ignore */
            }
          }
          void persistShareDocument();
          return;
        }
        const ed = store.getState().editor as {
          templates?: Array<{ id?: string; name?: string }>;
        };
        const tpl = ed.templates?.find((t) => t.id === id);
        const name = String(tpl?.name || 'Untitled');
        void persistCloudSnapshot({ id, name, scene });
      }, PERSIST_DEBOUNCE_MS);
    };

    const syncPushedRevisionFromStore = () => {
      lastPushedRevisionRef.current = Number(store.getState().editor.documentRevision) || 0;
    };

    const hydrateFromY = () => {
      applyingRemoteRef.current = true;
      try {
        const scene = sceneFromYDoc(ydoc);
        lastPushedHashRef.current = sceneHash(scene);
        applyCollabDocument(scene);
        syncPushedRevisionFromStore();
        clearCollabUndoStack();
      } finally {
        queueMicrotask(() => {
          applyingRemoteRef.current = false;
        });
      }
    };

    const seedFromLocal = (localDoc: unknown) => {
      seedYDocFromScene(ydoc, localDoc);
      lastPushedHashRef.current = sceneHash(sceneFromYDoc(ydoc));
      syncPushedRevisionFromStore();
      clearCollabUndoStack();
    };

    /**
     * Empty-room bootstrap: wait briefly, elect one seeder (claim + lowest clientId),
     * followers wait for content before falling back to a local seed.
     */
    const resolveInitialRoomContent = (awareness: Awareness) => {
      const localDoc = documentRef.current;
      if (!isYDocEmpty(ydoc)) {
        hydrateFromY();
        return;
      }

      // Viewers never seed — wait for an editor to populate the room.
      if (roleRef.current === 'view') {
        window.setTimeout(() => {
          if (cancelled) return;
          if (!isYDocEmpty(ydoc)) hydrateFromY();
        }, SEED_FOLLOWER_WAIT_MS);
        return;
      }

      if (!localDoc) return;

      window.setTimeout(() => {
        if (cancelled) return;
        if (!isYDocEmpty(ydoc)) {
          hydrateFromY();
          return;
        }

        const peerIds = [ydoc.clientID];
        awareness.getStates().forEach((_state, clientId) => {
          peerIds.push(clientId);
        });
        const isLeader = Math.min(...peerIds) === ydoc.clientID;

        if (isLeader && tryClaimRoomSeed(ydoc, ydoc.clientID)) {
          if (!isYDocEmpty(ydoc)) {
            hydrateFromY();
            return;
          }
          seedFromLocal(localDoc);
          return;
        }

        window.setTimeout(() => {
          if (cancelled) return;
          if (!isYDocEmpty(ydoc)) {
            hydrateFromY();
            return;
          }
          // Leader never seeded (left / failed) — claim and seed as fallback.
          if (tryClaimRoomSeed(ydoc, ydoc.clientID)) {
            seedFromLocal(localDoc);
          }
        }, SEED_FOLLOWER_WAIT_MS);
      }, SEED_RACE_WAIT_MS);
    };

    const onYUpdate = (_update: Uint8Array, origin: unknown) => {
      if (cancelled) return;
      // Skip while IndexedDB is replaying history into the doc.
      if (!idbReadyRef.current) return;
      if (
        origin === Y_ORIGIN_LOCAL ||
        origin === Y_ORIGIN_SEED ||
        origin === Y_ORIGIN_SEED_CLAIM
      ) {
        if (origin === Y_ORIGIN_LOCAL || origin === Y_ORIGIN_SEED) schedulePersist();
        return;
      }
      const scene = sceneFromYDoc(ydoc);
      const hash = sceneHash(scene);
      // Websocket / y-indexeddb echo of our own boolean (or any local write).
      // Applying it as remote remounts the scene; persisting it again 412s.
      if (hash === lastPushedHashRef.current) return;
      applyingRemoteRef.current = true;
      try {
        const prev = store.getState().editor.document;
        lastPushedHashRef.current = hash;
        dispatchRemoteScene(prev, scene);
      } finally {
        queueMicrotask(() => {
          applyingRemoteRef.current = false;
        });
      }
      schedulePersist();
    };
    ydoc.on('update', onYUpdate);

    const boot = async () => {
      try {
        const body = currentId.startsWith('share_')
          ? { shareId: currentId }
          : { projectId: currentId };
        const tokenRes = await mintCollabRoomTokenApi(body);
        if (cancelled) return;
        setRole(tokenRes.role);
        roleRef.current = tokenRes.role;
        setCollabViewOnly(tokenRes.role === 'view');
        refreshCloudPersistOwned();

        // Local offline replica (same room id as WS). Meshable with WebsocketProvider.
        const persistence = new IndexeddbPersistence(tokenRes.roomId, ydoc);
        idbRef.current = persistence;
        await waitIndexeddbSynced(persistence);
        if (cancelled) return;
        idbReadyRef.current = true;

        if (!isYDocEmpty(ydoc)) {
          hydrateFromY();
          seededRef.current = true;
          refreshCloudPersistOwned();
        }

        const awareness = new Awareness(ydoc);
        awarenessRef.current = awareness;
        awareness.setLocalStateField('user', {
          userId: user.id,
          name: user.name || user.email || 'You',
          color: peerColor(user.id),
        });

        const provider = new WebsocketProvider(tokenRes.wsUrl, tokenRes.roomId, ydoc, {
          connect: true,
          params: { token: tokenRes.token },
          awareness,
        });
        providerRef.current = provider;

        const refreshPeers = () => {
          if (cancelled) return;
          setPeers(readPeers(awareness, ydoc.clientID, user.id));
        };
        awareness.on('change', refreshPeers);
        refreshPeers();

        provider.on('status', (ev: { status: string }) => {
          if (cancelled) return;
          if (ev.status === 'connected') setStatus((s) => (s === 'synced' ? s : 'connecting'));
          if (ev.status === 'disconnected') setStatus('connecting');
        });

        provider.on('sync', (isSynced: boolean) => {
          if (cancelled || !isSynced) return;
          setStatus('synced');
          if (seededRef.current) {
            refreshCloudPersistOwned();
            return;
          }
          seededRef.current = true;
          refreshCloudPersistOwned();
          resolveInitialRoomContent(awareness);
        });
      } catch (err) {
        if (cancelled) return;
        console.warn('[collab] connect failed', err);
        setStatus('error');
        setError(err instanceof Error ? err.message : 'collab_connect_failed');
        setCollabActive(false);
        setCollabCloudPersistOwned(false);
      }
    };

    void boot();

    return () => {
      cancelled = true;
      bindCollabUndoManager(null);
      try {
        undoManager.destroy();
      } catch {
        /* ignore */
      }
      setCollabActive(false);
      if (persistTimerRef.current) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      ydoc.off('update', onYUpdate);
      try {
        providerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      providerRef.current = null;
      try {
        void idbRef.current?.destroy();
      } catch {
        /* ignore */
      }
      idbRef.current = null;
      try {
        awarenessRef.current?.destroy();
      } catch {
        /* ignore */
      }
      awarenessRef.current = null;
      ydoc.destroy();
      ydocRef.current = null;
      setStatus('idle');
      setPeers([]);
      setRole(null);
      roleRef.current = null;
      setFollowingUserId(null);
      setCollabViewOnly(false);
    };
  }, [enabled, currentId, user?.id, user?.name, user?.email]);

  const followingUserIdRef = useRef<string | null>(null);
  followingUserIdRef.current = followingUserId;

  // Publish local viewport for peer follow.
  useEffect(() => {
    const awareness = awarenessRef.current;
    if (!awareness || !enabled || status === 'idle') return undefined;
    let timer: number | null = null;
    const publish = () => {
      timer = null;
      const a = awarenessRef.current;
      if (!a) return;
      const c = cameraRef.current;
      a.setLocalStateField('camera', { x: c.x, y: c.y, zoom: c.zoom });
    };
    timer = window.setTimeout(publish, CAMERA_AWARENESS_MS);
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, [enabled, status, camera.x, camera.y, camera.zoom]);

  // Local pan/zoom cancels follow (must run before the follow-apply effect).
  useEffect(() => {
    if (applyingFollowRef.current) {
      applyingFollowRef.current = false;
      return;
    }
    if (followingUserIdRef.current) {
      followingUserIdRef.current = null;
      setFollowingUserId(null);
    }
  }, [camera.x, camera.y, camera.zoom]);

  // Follow peer viewport (or cursor center fallback).
  useEffect(() => {
    const followId = followingUserIdRef.current;
    if (!followId) return;
    const peer = peers.find((p) => p.userId === followId);
    if (!peer) {
      followingUserIdRef.current = null;
      setFollowingUserId(null);
      return;
    }
    const apply = onCameraChangeRef.current;
    if (!apply) return;

    let next: RcbCamera | null = null;
    if (peer.camera) {
      next = peer.camera;
    } else if (peer.cursor && stageEl) {
      next = cameraCenteringScenePoint(
        peer.cursor.x,
        peer.cursor.y,
        cameraRef.current.zoom,
        stageEl
      );
    }
    if (!next) return;
    if (camerasClose(next, cameraRef.current)) return;
    applyingFollowRef.current = true;
    apply(next);
  }, [followingUserId, peers, stageEl]);

  // Local store → Y (editors only). Gate on documentRevision — skip playhead bake
  // (documentPatchToken only) and avoid pushEditorHistory-only false positives.
  useEffect(() => {
    if (!enabled || role !== 'edit') return;
    const ydoc = ydocRef.current;
    const document = store.getState().editor.document;
    if (!ydoc || !document || !seededRef.current) return;
    if (applyingRemoteRef.current) return;
    if (isAnimationWorkbenchGeometryPreview()) return;
    if (documentRevision === lastPushedRevisionRef.current) return;
    applyLocalSceneToY(ydoc, document);
    lastPushedRevisionRef.current = documentRevision;
    // Hash the Y snapshot (not the editor store JSON) so websocket echoes compare equal.
    lastPushedHashRef.current = sceneHash(sceneFromYDoc(ydoc));
  }, [enabled, role, documentRevision]);

  // Awareness: local node + artboard selection (republish when room syncs).
  useEffect(() => {
    const awareness = awarenessRef.current;
    if (!awareness || !enabled || status === 'idle') return;
    const frameIds = Array.isArray(selectedFrameIds) ? selectedFrameIds.map(String) : [];
    // Single activeFrameId counts as a selection when multi-select is empty.
    if (!frameIds.length && activeFrameId) frameIds.push(String(activeFrameId));
    awareness.setLocalStateField(
      'selectedNodeIds',
      Array.isArray(selectedNodeIds) ? selectedNodeIds.map(String) : []
    );
    awareness.setLocalStateField('selectedFrameIds', frameIds);
  }, [enabled, status, selectedNodeIds, selectedFrameIds, activeFrameId]);

  // Awareness: local pointer →scene coords (so peers with different cameras still align).
  useEffect(() => {
    if (!enabled || !stageEl || status === 'idle') return undefined;
    let lastSent = 0;
    let pending: { x: number; y: number } | null = null;
    let flushTimer: number | null = null;

    const publish = (cursor: { x: number; y: number } | null) => {
      const awareness = awarenessRef.current;
      if (!awareness) return;
      awareness.setLocalStateField('cursor', cursor);
    };

    const flushPending = () => {
      flushTimer = null;
      if (!pending) return;
      publish(pending);
      pending = null;
      lastSent = Date.now();
    };

    const onMove = (e: PointerEvent) => {
      const scene = rcbScreenToScene(cameraRef.current, stageEl, e.clientX, e.clientY);
      pending = { x: scene.x, y: scene.y };
      const now = Date.now();
      if (now - lastSent >= CURSOR_AWARENESS_MS) {
        if (flushTimer != null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        publish(pending);
        pending = null;
        lastSent = now;
        return;
      }
      if (flushTimer == null) {
        flushTimer = window.setTimeout(flushPending, CURSOR_AWARENESS_MS - (now - lastSent));
      }
    };

    const onLeave = () => {
      pending = null;
      if (flushTimer != null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      publish(null);
    };

    stageEl.addEventListener('pointermove', onMove);
    stageEl.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      stageEl.removeEventListener('pointermove', onMove);
      stageEl.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      if (flushTimer != null) window.clearTimeout(flushTimer);
      publish(null);
    };
  }, [enabled, stageEl, status]);

  return (
    <CollabContext.Provider value={ctx}>
      {children}
      <CollabPeerPresenceOverlay stageEl={stageEl} camera={camera} peers={peers} />
    </CollabContext.Provider>
  );
}
