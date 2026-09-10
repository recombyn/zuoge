// Live collaborator presence: peer cursors + selection, Figma-style.
//
// This is the *rendering and local-capture* half of real-time collaboration.
// It is deliberately transport-agnostic: the host (the cloud app) owns the
// network — it pushes remote peers in via `setPeers` and forwards this
// session's own cursor/selection out via `onLocalPresence`. The editor owns
// where things are drawn, because that needs the live pan/zoom and the render
// loop, which only it has.
//
// It is strictly ADDITIVE: an absolutely-positioned overlay over the canvas,
// plus a passive pointer listener. Nothing here touches the scene graph, the
// engine, or the save path — if it fails it can only fail to show a cursor.

import type { Renderer } from './renderer';

/** One collaborator's live state, as the transport hands it to us. */
export interface PeerPresence {
    /** Stable per-connection id (a peer with two tabs is two entries). */
    clientId: string;
    name: string;
    /** CSS colour for the cursor + label + selection outline. */
    color: string;
    /** Cursor position in document (world) space, or null if unknown/away. */
    cursor: { x: number; y: number } | null;
    /** Node ids this peer has selected (drawn as outlines when resolvable). */
    selection?: number[];
}

/** What this session publishes about itself, throttled. */
export interface LocalPresence {
    cursor: { x: number; y: number } | null;
    selection: number[];
}

/**
 * World (document) point → on-screen CSS pixels, relative to the canvas box.
 *
 * The inverse of the input layer's screen→world (`(screen - pan) / zoom`), so a
 * peer cursor lands exactly where that peer's pointer is. `pan`/`zoom` are in
 * CSS-pixel space, so device pixel ratio never enters.
 */
export function worldToScreen(
    world: { x: number; y: number },
    pan: { x: number; y: number },
    zoom: number,
): { x: number; y: number } {
    return { x: world.x * zoom + pan.x, y: world.y * zoom + pan.y };
}

/** Screen CSS pixels (relative to the canvas box) → world point. */
export function screenToWorld(
    screen: { x: number; y: number },
    pan: { x: number; y: number },
    zoom: number,
): { x: number; y: number } {
    return { x: (screen.x - pan.x) / zoom, y: (screen.y - pan.y) / zoom };
}

/**
 * A trailing throttle: run `fn` at most once per `ms`, always delivering the
 * most recent call's arguments. Cursor streams are high-frequency and only the
 * latest position matters, so intermediate ones are safely dropped.
 */
export function throttle<A extends unknown[]>(
    fn: (...args: A) => void,
    ms: number,
): { (...args: A): void; cancel: () => void } {
    // -Infinity so the very first call always clears the window and runs now.
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: A | null = null;
    // performance.now avoids wall-clock jumps; falls back for non-DOM tests.
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const run = (args: A) => {
        last = now();
        fn(...args);
    };
    const wrapped = (...args: A) => {
        const dt = now() - last;
        if (dt >= ms) {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            run(args);
        } else {
            pending = args;
            if (!timer) {
                timer = setTimeout(() => {
                    timer = null;
                    if (pending) {
                        const p = pending;
                        pending = null;
                        run(p);
                    }
                }, ms - dt);
            }
        }
    };
    wrapped.cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        pending = null;
    };
    return wrapped;
}

/**
 * Diff two peer rosters by clientId. Returns which ids are new, which went
 * away, and which persist — the minimum work to reconcile a DOM overlay
 * without tearing every cursor down each frame.
 */
export function diffPeers(
    prev: Iterable<string>,
    next: Iterable<string>,
): { added: string[]; removed: string[]; kept: string[] } {
    const prevSet = new Set(prev);
    const nextSet = new Set(next);
    const added: string[] = [];
    const kept: string[] = [];
    const removed: string[] = [];
    for (const id of nextSet) (prevSet.has(id) ? kept : added).push(id);
    for (const id of prevSet) if (!nextSet.has(id)) removed.push(id);
    return { added, removed, kept };
}

/** Escape text for safe insertion as element textContent-equivalent HTML. */
function esc(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    );
}

interface PeerEls {
    root: HTMLDivElement;
    label: HTMLDivElement;
}

/**
 * Owns the peer-cursor overlay and this session's presence emission.
 *
 * Construction attaches an overlay to the canvas's container and starts
 * listening for local pointer motion; everything else is driven by the host:
 * `setPeers` in, `onLocalPresence` out.
 */
export class PresenceController {
    private overlay: HTMLDivElement | null = null;
    private peers = new Map<string, PeerPresence>();
    private els = new Map<string, PeerEls>();
    private localSelection: number[] = [];
    private localCursor: { x: number; y: number } | null = null;
    private listeners: Array<(p: LocalPresence) => void> = [];
    private emitThrottled: ((p: LocalPresence) => void) & { cancel: () => void };
    private disposed = false;
    private readonly onMove: (e: PointerEvent) => void;
    private readonly onLeave: () => void;
    private stopViewChange: (() => void) | null = null;

    constructor(
        private readonly canvas: HTMLCanvasElement,
        private readonly renderer: Renderer,
        /** Cursor broadcast cadence. 40ms ≈ 25/s, smooth without flooding. */
        emitMs = 40,
    ) {
        this.emitThrottled = throttle((p: LocalPresence) => {
            for (const cb of this.listeners) cb(p);
        }, emitMs);

        try {
            const container = canvas.parentElement;
            if (container) {
                const ov = document.createElement('div');
                ov.className = 'rcb-vector-presence-overlay';
                ov.style.cssText =
                    'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5;';
                // The container must establish a positioning context; canvas
                // containers here already do, but be defensive.
                if (getComputedStyle(container).position === 'static') {
                    container.style.position = 'relative';
                }
                container.appendChild(ov);
                this.overlay = ov;
            }
        } catch {
            this.overlay = null; // rendering is best-effort; capture still works
        }

        this.onMove = (e: PointerEvent) => {
            const rect = this.canvas.getBoundingClientRect();
            const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this.localCursor = screenToWorld(screen, this.renderer.pan, this.renderer.zoom);
            this.emitLocal();
        };
        this.onLeave = () => {
            this.localCursor = null;
            this.emitLocal();
        };
        this.canvas.addEventListener('pointermove', this.onMove);
        this.canvas.addEventListener('pointerleave', this.onLeave);

        // Peer cursors are positioned in screen space, so a pan/zoom must move
        // them even when no new peer state arrives.
        this.renderer.onViewChange(() => this.reposition());
        // onViewChange has no unsubscribe; guard the callback with `disposed`.
        this.stopViewChange = null;
    }

    /** Subscribe to this session's throttled presence (cursor + selection). */
    onLocalPresence(cb: (p: LocalPresence) => void): () => void {
        this.listeners.push(cb);
        return () => {
            this.listeners = this.listeners.filter((f) => f !== cb);
        };
    }

    /** The host calls this whenever the local selection changes. */
    reportLocalSelection(ids: number[]): void {
        this.localSelection = ids.slice();
        this.emitLocal();
    }

    private emitLocal(): void {
        if (this.disposed) return;
        this.emitThrottled({ cursor: this.localCursor, selection: this.localSelection.slice() });
    }

    /** Replace the set of remote peers (the transport hands us the full set). */
    setPeers(peers: PeerPresence[]): void {
        if (this.disposed) return;
        const next = new Map<string, PeerPresence>();
        for (const p of peers) next.set(p.clientId, p);
        const { added, removed } = diffPeers(this.peers.keys(), next.keys());
        this.peers = next;
        for (const id of removed) this.destroyPeerEl(id);
        for (const id of added) this.createPeerEl(id);
        this.reposition();
    }

    private createPeerEl(clientId: string): void {
        if (!this.overlay) return;
        const p = this.peers.get(clientId);
        if (!p) return;
        const root = document.createElement('div');
        root.style.cssText =
            'position:absolute;top:0;left:0;will-change:transform;transition:transform 80ms linear;';
        // A simple arrow cursor + a name pill, both tinted to the peer colour.
        root.innerHTML =
            `<svg width="18" height="18" viewBox="0 0 18 18" style="display:block;filter:drop-shadow(0 1px 1px rgba(0,0,0,.3))">` +
            `<path d="M2 2 L2 15 L6 11 L9 17 L11 16 L8 10 L14 10 Z" fill="${esc(p.color)}" stroke="white" stroke-width="1"/></svg>`;
        const label = document.createElement('div');
        label.style.cssText =
            `position:absolute;left:14px;top:12px;white-space:nowrap;font:600 11px/1.4 system-ui,sans-serif;` +
            `color:#fff;background:${esc(p.color)};padding:1px 6px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,.25);`;
        label.textContent = p.name;
        root.appendChild(label);
        this.overlay.appendChild(root);
        this.els.set(clientId, { root, label });
    }

    private destroyPeerEl(clientId: string): void {
        const e = this.els.get(clientId);
        if (e) {
            e.root.remove();
            this.els.delete(clientId);
        }
    }

    /** Reposition every peer cursor for the current pan/zoom. */
    private reposition(): void {
        if (this.disposed || !this.overlay) return;
        const pan = this.renderer.pan;
        const zoom = this.renderer.zoom;
        for (const [id, els] of this.els) {
            const p = this.peers.get(id);
            if (!p?.cursor) {
                els.root.style.display = 'none';
                continue;
            }
            const s = worldToScreen(p.cursor, pan, zoom);
            els.root.style.display = '';
            els.root.style.transform = `translate(${s.x}px, ${s.y}px)`;
            // Keep the label current if the name changed.
            if (els.label.textContent !== p.name) els.label.textContent = p.name;
        }
    }

    dispose(): void {
        this.disposed = true;
        this.canvas.removeEventListener('pointermove', this.onMove);
        this.canvas.removeEventListener('pointerleave', this.onLeave);
        this.emitThrottled.cancel();
        this.stopViewChange?.();
        for (const id of Array.from(this.els.keys())) this.destroyPeerEl(id);
        this.overlay?.remove();
        this.overlay = null;
        this.listeners = [];
    }
}
