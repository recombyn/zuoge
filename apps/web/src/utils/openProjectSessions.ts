/** Cross-tab probe: is this project open in another editor tab? */

const CHANNEL = 'recombyn-open-projects';
const PROBE_TIMEOUT_MS = 120;

type CheckMsg = { type: 'check'; projectId: string; requestId: string };
type EditingMsg = { type: 'editing'; projectId: string; requestId: string };

let channel: BroadcastChannel | null = null;

function channelOrNull(): BroadcastChannel | null {
  if (typeof window === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
}

function isCheckFor(msg: unknown, projectId: string): msg is CheckMsg {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as CheckMsg).type === 'check' &&
    (msg as CheckMsg).projectId === projectId
  );
}

function isEditingReply(msg: unknown, projectId: string, requestId: string): boolean {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as EditingMsg).type === 'editing' &&
    (msg as EditingMsg).projectId === projectId &&
    (msg as EditingMsg).requestId === requestId
  );
}

/** Correlation id — works on plain HTTP (non-secure) deploys where randomUUID is missing. */
export function probeRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** EditorPage: answer delete probes from home / projects list. */
export function listenForProjectOpenProbes(projectId: string | null | undefined): () => void {
  const id = String(projectId || '').trim();
  let ch: BroadcastChannel | null = null;
  try {
    ch = channelOrNull();
  } catch {
    return () => {};
  }
  if (!id || !ch) return () => {};

  const onMessage = (event: MessageEvent<CheckMsg>) => {
    const msg = event.data;
    if (!isCheckFor(msg, id)) return;
    try {
      ch!.postMessage({ type: 'editing', projectId: id, requestId: msg.requestId });
    } catch {
      /* ignore — peer probe will time out / fail closed */
    }
  };

  ch.addEventListener('message', onMessage);
  return () => ch!.removeEventListener('message', onMessage);
}

/**
 * True when another tab has this project open in the editor.
 * Runs on all deploys (incl. HTTP servers) — only the request id is polyfilled.
 */
export function probeProjectOpenElsewhere(projectId: string): Promise<boolean> {
  const id = String(projectId || '').trim();
  if (!id) return Promise.resolve(false);

  let ch: BroadcastChannel | null = null;
  try {
    ch = channelOrNull();
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error('broadcast_channel_unavailable'));
  }
  if (!ch) {
    // SSR / no window — nothing to probe.
    return Promise.resolve(false);
  }

  const requestId = probeRequestId();

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = 0;

    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      ch!.removeEventListener('message', onReply);
      window.clearTimeout(timer);
      resolve(open);
    };

    const onReply = (event: MessageEvent<EditingMsg>) => {
      if (isEditingReply(event.data, id, requestId)) finish(true);
    };

    try {
      ch.addEventListener('message', onReply);
      ch.postMessage({ type: 'check', projectId: id, requestId });
    } catch (err) {
      settled = true;
      ch.removeEventListener('message', onReply);
      reject(err instanceof Error ? err : new Error('project_open_probe_failed'));
      return;
    }
    timer = window.setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
  });
}
