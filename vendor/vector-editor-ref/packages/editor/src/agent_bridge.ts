/**
 * Agent bridge — lets an out-of-process agent drive THIS editor tab.
 *
 * An MCP server (packages/mcp) sends calls; this services them against
 * `EditorHandle.agent`. The human keeps working in the same window: an agent's
 * edits are ordinary edits, so they land in the same undo history and can be
 * undone, corrected, or taken over at any point.
 *
 * TWO TRANSPORTS, because one cannot cover both cases:
 *
 *   local — the page opens a socket straight to `ws://127.0.0.1:<port>`.
 *           Direct and dependency-free, and only usable when the page itself is
 *           served from localhost.
 *   relay — the page holds an SSE stream from its OWN origin and posts results
 *           back. Required for the hosted app: Chrome's Local Network Access
 *           checks block a public origin from reaching loopback at all
 *           (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS), so both sides have to
 *           connect outward and the backend pairs them.
 *
 * Opt-in only, and never by discovery. The page connects when it is given a
 * token — as `?agentBridge=<port|cloud>&token=…` or from a previous session.
 * Nothing connects on its own.
 *
 * The channel is deliberately narrow: it carries a method name and JSON args,
 * and will only ever invoke a function that exists on the agent API. It cannot
 * evaluate arbitrary code in the page.
 */

import type { AgentApi } from './agent';

/**
 * Where a bridge lives. `local` targets a loopback port; `relay` targets this
 * page's own origin, which proxies to an agent connected from elsewhere.
 */
export type BridgeCredentials =
    | { kind: 'local'; port: number; token: string }
    | { kind: 'relay'; token: string };

const STORAGE_KEY = 'rcb.vectorAgentBridge';

/**
 * Is this page served from the machine the loopback port would be on?
 *
 * Only a loopback origin may use the local transport. From anywhere else
 * Chrome's Local Network Access checks hold the connection at a permission
 * prompt ("this origin wants to access other apps and services on this device")
 * and then block it — so the socket cannot work, but it CAN nag the user on
 * every load and every reconnect.
 */
function isLoopbackOrigin(): boolean {
    const host = window.location.hostname;
    return (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host === '127.0.0.1' ||
        host === '[::1]' ||
        host === '::1'
    );
}

/** Parse whatever was stored or supplied into credentials, or null. */
function toCredentials(raw: {
    kind?: string;
    port?: number;
    token?: string;
}): BridgeCredentials | null {
    if (!raw?.token) return null;
    if (raw.kind === 'relay') return { kind: 'relay', token: raw.token };
    // Older stored values predate `kind` and were always local.
    if (typeof raw.port === 'number' && raw.port > 0) {
        return { kind: 'local', port: raw.port, token: raw.token };
    }
    return null;
}

/**
 * Drop credentials this page cannot act on, and say why.
 *
 * Local credentials on a hosted origin are the one case that matters: they are
 * usually left over from a session where the same browser drove a local editor,
 * and they outlive it in localStorage. Dialling loopback from there cannot ever
 * connect, but it does put a device-access permission prompt in front of the
 * user on every load and every reconnect — so refuse once, forget, and point at
 * the transport that does work from here.
 */
function usable(creds: BridgeCredentials | null): BridgeCredentials | null {
    if (creds?.kind === 'local' && !isLoopbackOrigin()) {
        clearBridgeCredentials();
        console.warn(
            '[rcb-vector] ignoring a local agent bridge on a hosted origin — a page served from ' +
                `${window.location.origin} is not allowed to reach 127.0.0.1. Stored credentials ` +
                'cleared. Run the MCP server with `--mode relay` and open the URL it prints ' +
                '(?agentBridge=cloud&token=…) to drive this editor.',
        );
        return null;
    }
    return creds;
}

/**
 * Read bridge credentials from the URL, falling back to a previous session.
 *
 * `?agentBridge=cloud` selects the relay; a number selects that loopback port.
 * Credentials found in the URL are persisted so a reload stays attached (the
 * editor reloads often, and re-pasting a URL each time would make the mode
 * unusable), and stripped from the address bar so the token isn't left sitting
 * in browser history or copied into a shared link.
 */
export function readBridgeCredentials(): BridgeCredentials | null {
    try {
        const params = new URLSearchParams(window.location.search);
        const target = params.get('agentBridge');
        const token = params.get('token');
        if (target && token) {
            const creds = usable(
                target === 'cloud' || target === 'relay'
                    ? { kind: 'relay', token }
                    : toCredentials({ kind: 'local', port: Number(target), token }),
            );
            // Strip the parameters whether or not they were usable: a rejected
            // token left in the address bar would be re-read on every reload,
            // and re-warn, and still be sitting in history.
            if (target || token) {
                params.delete('agentBridge');
                params.delete('token');
                const qs = params.toString();
                window.history.replaceState(
                    {},
                    '',
                    window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
                );
            }
            if (creds) {
                try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
                } catch {
                    // Private mode / storage disabled: still connect for this load.
                }
                return creds;
            }
            return null;
        }
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved ? usable(toCredentials(JSON.parse(saved))) : null;
    } catch {
        return null;
    }
}

/**
 * A fresh relay token, minted in the page.
 *
 * The token is a bearer capability for editing this document, so it is 192 bits
 * from the platform CSPRNG — the same shape the MCP server generates, because
 * the backend accepts exactly one format and neither side should be able to
 * weaken it.
 */
export function newBridgeToken(): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Remember credentials so a reload stays attached. */
export function saveBridgeCredentials(creds: BridgeCredentials) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    } catch {
        // Private mode / storage disabled: this session still works.
    }
}

/** Forget any stored bridge, so the tab stops attaching on reload. */
export function clearBridgeCredentials() {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Nothing to do — the caller only wants it gone if it can be.
    }
}

export interface BridgeHandle {
    /** Close the channel and stop reconnecting. */
    disconnect(): void;
    /** True while a live channel is attached. */
    readonly connected: boolean;
}

export interface BridgeOptions {
    /** Called on connect/disconnect so a host can show status. */
    onStatus?: (connected: boolean) => void;
    /**
     * Called when an agent actually joins this session — distinct from the
     * channel being up. With the pairing-code flow the tab connects first and
     * the agent arrives later, so "my stream is open" no longer implies "an
     * agent is here", and a host that conflates the two tells the user an agent
     * is driving their document before one exists.
     */
    onAgentPresent?: (present: boolean) => void;
    /** Reconnect backoff ceiling. */
    maxRetryMs?: number;
    /**
     * Where the relay lives, for `relay` credentials. Defaults to this page's
     * origin, which is right in production (the backend serves the SPA). A host
     * whose API is on a different origin — a dev server proxying nothing, for
     * instance — must say so, or the editor would post calls at itself.
     */
    relayOrigin?: string;
}

/** One incoming call, from either transport. */
interface CallFrame {
    id?: number;
    method?: string;
    args?: unknown[];
}

/**
 * Run one call against the agent API and produce the reply body.
 *
 * Shared by both transports so they cannot drift on the part that matters: only
 * a real function on the agent API is ever dispatched to, which is what keeps
 * this from becoming a way to evaluate arbitrary code in the page.
 */
async function invoke(agent: AgentApi, msg: CallFrame): Promise<Record<string, unknown>> {
    const fn = (agent as unknown as Record<string, unknown>)[msg.method ?? ''];
    if (typeof fn !== 'function') return { ok: false, error: `unknown method ${msg.method}` };
    try {
        const value = await (fn as (...a: unknown[]) => unknown).apply(agent, msg.args ?? []);
        return { ok: true, value: value ?? null };
    } catch (err) {
        return { ok: false, error: (err as Error)?.message ?? String(err) };
    }
}

/** Local transport: a socket straight to the MCP server on loopback. */
function connectLocal(
    agent: AgentApi,
    creds: { port: number; token: string },
    opts: BridgeOptions,
): BridgeHandle {
    const { onStatus, maxRetryMs = 10_000 } = opts;
    let socket: WebSocket | null = null;
    let stopped = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
        if (stopped) return;
        const ws = new WebSocket(
            `ws://127.0.0.1:${creds.port}/?token=${encodeURIComponent(creds.token)}`,
        );
        socket = ws;

        ws.onopen = () => {
            retry = 500;
            onStatus?.(true);
            console.info('[rcb-vector] agent bridge attached (local)');
        };

        ws.onmessage = async (event) => {
            let msg: CallFrame;
            try {
                msg = JSON.parse(String(event.data));
            } catch {
                return;
            }
            if (typeof msg.id !== 'number' || !msg.method) return;
            const body = await invoke(agent, msg);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ id: msg.id, ...body }));
            }
        };

        const closed = (why: string) => {
            if (socket !== ws) return;
            socket = null;
            onStatus?.(false);
            if (stopped) return;
            // A rejected token is permanent; retrying would just spin. Discard
            // the stored credentials too — the usual cause is a restarted MCP
            // server issuing a fresh token, and keeping them would make every
            // future reload of this tab fail the same way.
            if (why === 'rejected') {
                clearBridgeCredentials();
                console.warn(
                    '[rcb-vector] agent bridge rejected this tab — token invalid, or another editor ' +
                        'is already attached. Stored credentials cleared; re-open with the URL ' +
                        'the server printed to attach again.',
                );
                return;
            }
            timer = setTimeout(open, retry);
            retry = Math.min(retry * 2, maxRetryMs);
        };

        ws.onclose = (e) => closed(e.code === 4401 || e.code === 4409 ? 'rejected' : 'closed');
        ws.onerror = () => {
            // onclose always follows, which is where reconnect is handled.
        };
    };

    open();
    return {
        get connected() {
            return socket?.readyState === WebSocket.OPEN;
        },
        disconnect() {
            stopped = true;
            if (timer) clearTimeout(timer);
            socket?.close();
            socket = null;
            onStatus?.(false);
        },
    };
}

/**
 * Relay transport: long-poll this origin for calls, post results back.
 *
 * WHY NOT SSE. This used to hold an EventSource. On the managed runtime that
 * silently does not work: a custom function's response is completed rather than
 * streamed, so the request finishes the moment `start()` has written its first
 * frame — `GET /editor` returns in 4ms — and the tab sees a stream that attaches
 * and immediately dies, forever. The browser reported it as a parade of
 * ERR_ABORTED and ERR_HTTP2_PROTOCOL_ERROR, which reads like flaky networking
 * rather than a transport that was never going to work.
 *
 * A held request, by contrast, is fine: the relay keeps `/call` open for 25s
 * routinely. So the editor asks for its next call and the relay simply does not
 * answer until there is one, or until it has waited long enough to say so. That
 * is one ordinary request per 20 idle seconds, and an immediate answer when
 * there is work — and, unlike a stream, it does not pin the editor to whichever
 * replica happened to accept the connection.
 */
function connectRelay(
    agent: AgentApi,
    creds: { token: string },
    opts: BridgeOptions,
): BridgeHandle {
    const { onStatus, maxRetryMs = 10_000 } = opts;
    // The relay is a Rebase custom function, so it is mounted under
    // /api/functions — not at the top level. It has to be: the managed runtime
    // only ships config/, backend/functions/ and the generated schema, so a
    // route mounted anywhere else exists in dev and 404s in production.
    const base = `${(opts.relayOrigin ?? window.location.origin).replace(/\/+$/, '')}/api/functions/agent-bridge`;
    const qs = `token=${encodeURIComponent(creds.token)}`;
    let stopped = false;
    let live = false;
    let retry = 500;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let announced = false;

    const settle = (ok: boolean) => {
        if (ok === live) return;
        live = ok;
        onStatus?.(ok);
    };

    /** Run one call and hand the relay its result. */
    async function serve(call: { id: string; method: string; args: unknown[] }) {
        // A call is proof of an agent, whichever way it arrived — this also
        // covers a reconnect that missed the announcement.
        if (!announced) {
            announced = true;
            opts.onAgentPresent?.(true);
        }
        // `invoke` dispatches on method and args; the id is the relay's, and
        // travels back on the reply rather than through the agent.
        const body = await invoke(agent, { method: call.method, args: call.args });
        // Results go over an ordinary POST; a failure here just means the agent
        // sees its own timeout, which is the right outcome.
        await fetch(`${base}/reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: creds.token, id: call.id, ...body }),
            credentials: 'omit',
        }).catch(() => {});
    }

    async function loop() {
        while (!stopped) {
            try {
                const res = await fetch(`${base}/poll?${qs}`, { credentials: 'omit' });
                if (!res.ok) throw new Error(`poll ${res.status}`);
                const data = (await res.json()) as {
                    call?: { id: string; method: string; args: unknown[] };
                    agentPresent?: boolean;
                };
                settle(true);
                retry = 500;

                if (data.call) {
                    await serve(data.call);
                    continue; // straight back for the next one, no idle gap
                }
                if (data.agentPresent && !announced) {
                    announced = true;
                    opts.onAgentPresent?.(true);
                }
            } catch {
                // The relay is unreachable, or answered badly. Back off rather
                // than spin, and report the channel down so the UI can say so.
                settle(false);
                await new Promise((resolve) => {
                    timer = setTimeout(resolve, retry);
                });
                retry = Math.min(retry * 2, maxRetryMs);
            }
        }
    }

    void loop();
    return {
        get connected() {
            return live;
        },
        disconnect() {
            stopped = true;
            if (timer) clearTimeout(timer);
            settle(false);
        },
    };
}

/**
 * Connect this editor to an agent bridge and service calls until disconnected.
 *
 * Reconnects with backoff: the MCP server is restarted often during a session
 * (every client restart spawns a fresh one), and an editor that gave up after
 * the first drop would need a manual reload each time.
 */
export function connectAgentBridge(
    agent: AgentApi,
    creds: BridgeCredentials,
    opts: BridgeOptions = {},
): BridgeHandle {
    if (creds.kind === 'relay') return connectRelay(agent, creds, opts);
    // Same rule as `usable`, enforced here as well: this is exported, so a host
    // can hand us local credentials without going through the reader.
    if (!usable(creds)) {
        return { disconnect() {}, connected: false };
    }
    return connectLocal(agent, creds, opts);
}
