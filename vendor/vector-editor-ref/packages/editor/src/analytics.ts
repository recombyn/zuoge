// Lightweight, dependency-free analytics dispatcher.
//
// The core editor emits events through `logAppEvent`. It knows nothing about
// any analytics backend — the app layer registers a single sink at init
// via `registerAnalyticsSink` to forward events wherever it likes. This keeps
// the core clean and makes analytics trivially swappable / testable.

export type AnalyticsSink = (eventName: string, eventParams?: Record<string, any>) => void;

let sink: AnalyticsSink | null = null;

/** >0 while a bulk operation is collapsing its per-object events. */
let bulkDepth = 0;
/** Event-name -> count, accumulated for the duration of the outermost bulk. */
let bulkCounts: Map<string, number> | null = null;

/**
 * Wire the analytics backend. Call once, early, at app init.
 * Passing `null` disables analytics (e.g. in tests).
 */
export function registerAnalyticsSink(next: AnalyticsSink | null): void {
    sink = next;
}

/**
 * Emit an analytics event.
 *
 * @param eventName   e.g. 'document_created', 'export_completed'
 * @param eventParams optional context for the event
 */
export function logAppEvent(eventName: string, eventParams?: Record<string, any>): void {
    if (bulkDepth > 0) {
        bulkCounts?.set(eventName, (bulkCounts.get(eventName) ?? 0) + 1);
        return;
    }
    sink?.(eventName, eventParams);
}

/**
 * Run `fn` with its per-object analytics collapsed into a single summary event.
 *
 * Bulk work - an SVG import, a paste of a large subtree - goes through the same
 * per-object helpers as a single user edit, so each created node emits its own
 * event. Forwarding those individually is bad twice over: as signal it's noise
 * (one user action arriving as thousands of identical rows), and it's slow,
 * because every sink call reaches the analytics backend, which reads cookies and
 * pushes to a dataLayer. A 2000-element SVG import fired 4000 events; removing
 * them took the import from ~872ms to ~350ms.
 *
 * Events raised inside `fn` are counted rather than forwarded. When the
 * outermost bulk finishes, one `summaryName` event carries the totals as
 * `n_<event_name>` params. Nesting is safe: only the outermost call reports.
 * The summary is emitted even if `fn` throws, so a failed import still records
 * what it managed to do.
 *
 * `extraParams` may be a thunk when the values are only known once `fn` has run
 * (an imported root count, say); it is evaluated at summary time and a throw
 * from it is swallowed so instrumentation can never break the operation.
 */
export function withBulkAnalytics<T>(
    summaryName: string,
    extraParams: Record<string, any> | (() => Record<string, any>) | undefined,
    fn: () => T,
): T {
    if (bulkDepth === 0) bulkCounts = new Map();
    bulkDepth++;
    try {
        return fn();
    } finally {
        bulkDepth--;
        if (bulkDepth === 0) {
            const counts = bulkCounts;
            bulkCounts = null;
            let resolvedExtra: Record<string, any> = {};
            try {
                resolvedExtra =
                    typeof extraParams === 'function' ? (extraParams() ?? {}) : (extraParams ?? {});
            } catch {
                // Instrumentation must never take down the operation it measures.
            }
            const params: Record<string, any> = { ...resolvedExtra };
            let collapsed = 0;
            if (counts) {
                for (const [name, n] of counts) {
                    params[`n_${name}`] = n;
                    collapsed += n;
                }
            }
            params.collapsed_events = collapsed;
            sink?.(summaryName, params);
        }
    }
}
