/**
 * Imperative editor scene events — prefer dispatching these over useEffect([state]).
 * Hosts bind once with addEventListener; producers call request* at the action site.
 *
 * All fires are deferred (queueMicrotask) so mutators can call them safely —
 * listeners often read store.getState(), which must not run mid-write.
 */

export const RCB_ENSURE_ANIMATION_FRAME = 'rcb-ensure-animation-frame';
export const RCB_SYNC_NESTED_LOT_HOSTS = 'rcb-sync-nested-lot-hosts';
export const RCB_PRECOMP_CAMERA_FIT = 'rcb-precomp-camera-fit';
export const RCB_PRECOMP_CAMERA_RELEASE = 'rcb-precomp-camera-release';
export const RCB_MOCKUP_BAKE_COMPOSITE = 'rcb-mockup-bake-composite';
export const RCB_TIMELINE_CAMERA_FIT = 'rcb-timeline-camera-fit';
export const RCB_TIMELINE_CAMERA_RELEASE = 'rcb-timeline-camera-release';
/** AI transaction commit — reconcile Kit scene + DomHost mounts. */
export const RCB_AI_FLUSH = 'rcb-ai-flush';
/** Apply large host animationData after idle (Phase 4 bake sidecar). */
export const RCB_IDLE_ANIMATION_HOST_JSON = 'rcb-idle-animation-host-json';

type InteractionPerfKind = 'paste' | 'select';

type InteractionPerfMark = {
  name: string;
  t: number;
  ms: number;
  detail?: Record<string, unknown>;
};

type InteractionPerfSession = {
  kind: InteractionPerfKind;
  label: string;
  t0: number;
  marks: Array<{ name: string; t: number; detail?: Record<string, unknown> }>;
};

type InteractionPerfReport = {
  kind: InteractionPerfKind;
  label: string;
  totalMs: number;
  slowest: { name: string; ms: number };
  stages: InteractionPerfMark[];
};

type InteractionPerfWindow = Window & {
  __RCB_PASTE_PERF?: boolean;
  __RCB_SELECT_PERF?: boolean;
  __RCB_PASTE_PERF_LAST?: InteractionPerfReport;
  __RCB_SELECT_PERF_LAST?: InteractionPerfReport;
  /** Shared across Vite module graphs (app bundle vs page.evaluate import). */
  __RCB_INTERACTION_PERF_SESSION__?: InteractionPerfSession | null;
};

function perfWindow(): InteractionPerfWindow | null {
  if (typeof window === 'undefined') return null;
  return window as InteractionPerfWindow;
}

function getInteractionPerfSession(): InteractionPerfSession | null {
  return perfWindow()?.__RCB_INTERACTION_PERF_SESSION__ ?? null;
}

function setInteractionPerfSession(next: InteractionPerfSession | null): void {
  const w = perfWindow();
  if (!w) return;
  w.__RCB_INTERACTION_PERF_SESSION__ = next;
}

function interactionPerfFlag(
  kind: InteractionPerfKind
): boolean | undefined {
  const w = perfWindow();
  if (!w) return undefined;
  if (kind === 'paste') return w.__RCB_PASTE_PERF;
  return w.__RCB_SELECT_PERF;
}

function interactionPerfEnabled(kind: InteractionPerfKind): boolean {
  if (typeof window === 'undefined') return false;
  const flag = interactionPerfFlag(kind);
  if (flag === false) return false;
  if (flag === true) return true;
  return Boolean(import.meta.env.DEV);
}

function beginInteractionPerf(kind: InteractionPerfKind, label: string): void {
  if (!interactionPerfEnabled(kind)) return;
  setInteractionPerfSession({
    kind,
    label,
    t0: performance.now(),
    marks: [{ name: 'start', t: 0 }],
  });
}

/** Mark a stage on the active paste or select session (no-op if none). */
export function markInteractionPerf(
  name: string,
  detail?: Record<string, unknown>
): void {
  const session = getInteractionPerfSession();
  if (!session) return;
  const t = performance.now() - session.t0;
  session.marks.push({ name, t, detail });
}

function endInteractionPerf(): void {
  const session = getInteractionPerfSession();
  if (!session) return;
  const totalMs = performance.now() - session.t0;
  const stages: InteractionPerfMark[] = [];
  let slowest = { name: 'start', ms: 0 };
  for (let i = 1; i < session.marks.length; i += 1) {
    const cur = session.marks[i];
    const prev = session.marks[i - 1];
    const ms = cur.t - prev.t;
    const stage: InteractionPerfMark = {
      name: cur.name,
      t: Number(cur.t.toFixed(2)),
      ms: Number(ms.toFixed(2)),
    };
    if (cur.detail) stage.detail = cur.detail;
    stages.push(stage);
    if (ms > slowest.ms) slowest = { name: cur.name, ms: Number(ms.toFixed(2)) };
  }
  const report: InteractionPerfReport = {
    kind: session.kind,
    label: session.label,
    totalMs: Number(totalMs.toFixed(2)),
    slowest,
    stages,
  };
  const kind = session.kind;
  setInteractionPerfSession(null);
  const w = perfWindow();
  if (w) {
    if (kind === 'paste') w.__RCB_PASTE_PERF_LAST = report;
    else w.__RCB_SELECT_PERF_LAST = report;
  }
  // One JSON string — select the console string and copy.
  console.log(JSON.stringify(report));
}

/** True while a paste/select timing session is open (flush should wait). */
export function isInteractionPerfSessionActive(): boolean {
  return getInteractionPerfSession() != null;
}

function sessionHasPostCommitMark(session: InteractionPerfSession): boolean {
  for (let i = 0; i < session.marks.length; i += 1) {
    const name = session.marks[i]?.name;
    if (name === 'react-layout-enter' || name === 'soa-sync' || name === 'idle-paint') {
      return true;
    }
  }
  return false;
}

/**
 * Wait for React layout / Kit sync (or timeout), then two rAFs so paint is included.
 * Session lives on `window` so app marks and e2e begin/end share one graph.
 */
function endInteractionPerfAfterPaint(returnMark: string): void {
  if (!getInteractionPerfSession()) return;
  markInteractionPerf(returnMark);
  const session = getInteractionPerfSession();
  if (!session) return;
  const tWait0 = performance.now();
  const MAX_WAIT_MS = 8_000;

  const finishAfterPaint = () => {
    if (getInteractionPerfSession() !== session) return;
    markInteractionPerf('raf1');
    requestAnimationFrame(() => {
      if (getInteractionPerfSession() !== session) return;
      markInteractionPerf('raf2-after-paint');
      endInteractionPerf();
    });
  };

  const waitForCommit = () => {
    if (getInteractionPerfSession() !== session) return;
    if (
      sessionHasPostCommitMark(session) ||
      performance.now() - tWait0 > MAX_WAIT_MS
    ) {
      requestAnimationFrame(finishAfterPaint);
      return;
    }
    requestAnimationFrame(waitForCommit);
  };

  requestAnimationFrame(waitForCommit);
}

/** Start a paste/dupe timing session (DEV, or `window.__RCB_PASTE_PERF = true`). */
export function beginPastePerf(label: string): void {
  beginInteractionPerf('paste', label);
}

export function markPastePerf(name: string, detail?: Record<string, unknown>): void {
  markInteractionPerf(name, detail);
}

export function endPastePerf(): void {
  if (getInteractionPerfSession()?.kind !== 'paste') return;
  endInteractionPerf();
}

/** Capture React layout + canvas paint that run after the clipboard mutator returns. */
export function endPastePerfAfterPaint(): void {
  if (getInteractionPerfSession()?.kind !== 'paste') return;
  endInteractionPerfAfterPaint('clipboard-return');
}

/**
 * Selection / blank-click timing (DEV, or `window.__RCB_SELECT_PERF = true`).
 * Last report: `window.__RCB_SELECT_PERF_LAST`.
 */
export function beginSelectPerf(label: string): void {
  beginInteractionPerf('select', label);
}

export function markSelectPerf(name: string, detail?: Record<string, unknown>): void {
  markInteractionPerf(name, detail);
}

export function endSelectPerfAfterPaint(): void {
  if (getInteractionPerfSession()?.kind !== 'select') return;
  endInteractionPerfAfterPaint('select-return');
}

type SelectClickLogWindow = Window & {
  __RCB_SELECT_CLICK_LOG?: boolean;
  __RCB_SELECT_CLICK_LAST?: Record<string, unknown>;
};

/**
 * Every canvas selection pointerdown (DEV, or `window.__RCB_SELECT_CLICK_LOG = true`).
 * Unlike select-perf, this fires even when hit/select fails — last payload on
 * `window.__RCB_SELECT_CLICK_LAST`.
 */
export function logSelectClick(payload: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  const w = window as SelectClickLogWindow;
  if (w.__RCB_SELECT_CLICK_LOG === false) return;
  if (w.__RCB_SELECT_CLICK_LOG !== true && !import.meta.env.DEV) return;
  const report = {
    kind: 'select-click',
    t: Number(performance.now().toFixed(2)),
    ...payload,
  };
  w.__RCB_SELECT_CLICK_LAST = report;
  console.log(JSON.stringify(report));
}

function defer(fn: () => void) {
  if (typeof window === 'undefined') return;
  queueMicrotask(fn);
}


function deferIdle(fn: () => void, timeoutMs = 2000) {
  if (typeof window === 'undefined') return;
  const ric = (
    window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }
  ).requestIdleCallback;
  if (typeof ric === 'function') {
    ric(fn, { timeout: timeoutMs });
    return;
  }
  window.setTimeout(fn, 0);
}

/** Large LOT JSON — write host animationData off the ensure hot path. */
export function queueIdleAnimationHostJson(opts: {
  hostId: string;
  animationJson: string;
  skipHistory?: boolean;
}) {
  const hostId = String(opts.hostId || '').trim();
  const animationJson = String(opts.animationJson || '');
  if (!hostId || !animationJson || typeof window === 'undefined') return;
  // Idle/timeout already leaves the reducer stack; no extra microtask nest.
  deferIdle(() => {
    window.dispatchEvent(
      new CustomEvent(RCB_IDLE_ANIMATION_HOST_JSON, {
        detail: {
          hostId,
          animationJson,
          skipHistory: Boolean(opts.skipHistory),
        },
      })
    );
  });
}

export function requestEnsureAnimationFrame(
  frameId: string,
  opts?: { skipHistory?: boolean }
) {
  const id = String(frameId || '').trim();
  if (!id || typeof window === 'undefined') return;
  defer(() => {
    window.dispatchEvent(
      new CustomEvent(RCB_ENSURE_ANIMATION_FRAME, {
        detail: { frameId: id, skipHistory: Boolean(opts?.skipHistory) },
      })
    );
  });
}

/** Alias — ensure is always deferred. */
export function queueEnsureAnimationFrame(
  frameId: string,
  opts?: { skipHistory?: boolean }
) {
  requestEnsureAnimationFrame(frameId, opts);
}

export function requestSyncNestedLotHosts(opts?: {
  frameHostId?: string;
  timeSec?: number;
  afterPaint?: boolean;
}) {
  if (typeof window === 'undefined') return;
  const fire = () =>
    window.dispatchEvent(
      new CustomEvent(RCB_SYNC_NESTED_LOT_HOSTS, {
        detail: {
          frameHostId: String(opts?.frameHostId || '').trim() || undefined,
          timeSec: Number(opts?.timeSec) || 0,
        },
      })
    );
  defer(fire);
  if (opts?.afterPaint) defer(() => window.requestAnimationFrame(fire));
}

export function requestPrecompCameraFit(opts?: { afterPaint?: boolean }) {
  if (typeof window === 'undefined') return;
  const fire = () => window.dispatchEvent(new CustomEvent(RCB_PRECOMP_CAMERA_FIT));
  defer(fire);
  if (opts?.afterPaint) defer(() => window.requestAnimationFrame(fire));
}

export function requestPrecompCameraRelease() {
  defer(() => window.dispatchEvent(new CustomEvent(RCB_PRECOMP_CAMERA_RELEASE)));
}

export function requestMockupBakeComposite(nodeId: string, opts?: { delayMs?: number }) {
  const id = String(nodeId || '').trim();
  if (!id || typeof window === 'undefined') return;
  defer(() => {
    window.dispatchEvent(
      new CustomEvent(RCB_MOCKUP_BAKE_COMPOSITE, {
        detail: { nodeId: id, delayMs: opts?.delayMs },
      })
    );
  });
}

export function requestTimelineCameraFit(opts?: { afterPaint?: boolean }) {
  if (typeof window === 'undefined') return;
  const fire = () => window.dispatchEvent(new CustomEvent(RCB_TIMELINE_CAMERA_FIT));
  defer(fire);
  if (opts?.afterPaint) defer(() => window.requestAnimationFrame(fire));
}

export function requestTimelineCameraRelease() {
  defer(() => window.dispatchEvent(new CustomEvent(RCB_TIMELINE_CAMERA_RELEASE)));
}

/** After AI DesignTransaction commit — one Kit + DomHost flush (not per tool_op). */
export function requestAiFlush() {
  defer(() => window.dispatchEvent(new CustomEvent(RCB_AI_FLUSH)));
}
