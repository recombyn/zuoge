/**
 * Interpreting the engine's document-load status.
 *
 * `Engine.load_document` returns a JSON status object rather than a boolean,
 * because "this file didn't open" is several genuinely different situations and
 * the user needs a different action for each:
 *
 *   - **too_new** — the document uses features this build would silently drop,
 *     so it declined to open rather than destroy them. The user must update.
 *   - **truncated / checksum** — the file is damaged. Nothing to do but restore
 *     a backup, but saying so beats a blank canvas.
 *   - **empty** — a zero-byte file, almost always an interrupted save.
 *   - **unparseable** — not a supported document at all.
 *
 * A load can also *succeed* with repairs, which is worth telling the user about
 * without blocking them: their file was structurally damaged and the editor
 * fixed it, so the next save will differ from what was on disk.
 */

/** Machine-readable failure codes, mirroring `ContainerError::code()` in Rust. */
export type LoadErrorCode =
    | 'empty'
    | 'container_too_new'
    | 'too_new'
    | 'truncated'
    | 'checksum'
    | 'implausible_size'
    | 'decompress_failed'
    | 'unparseable';

/** Counts of what `validate::repair` had to change. */
export interface RepairCounts {
    duplicate_ids: number;
    dangling_roots: number;
    dangling_children: number;
    cycles_broken: number;
    reparented: number;
    orphans_rehomed: number;
    missing_images: number;
    coords_clamped: number;
}

export type LoadResult =
    | { ok: true; repaired: boolean; summary: string; repairs: RepairCounts }
    | {
          ok: false;
          error: LoadErrorCode;
          detail: string;
          requiredVersion: number;
          supportedVersion: number;
      };

/**
 * Parse the engine's status JSON.
 *
 * A malformed or empty string is treated as a failure rather than a success:
 * the whole point of this layer is that we never again report a load as having
 * worked when we don't actually know that it did.
 */
export function parseLoadResult(json: string): LoadResult {
    try {
        const parsed = JSON.parse(json);
        if (parsed && parsed.ok === true) {
            return {
                ok: true,
                repaired: Boolean(parsed.repaired),
                summary: String(parsed.summary ?? ''),
                repairs: parsed.repairs as RepairCounts,
            };
        }
        if (parsed && parsed.ok === false) {
            return {
                ok: false,
                error: (parsed.error ?? 'unparseable') as LoadErrorCode,
                detail: String(parsed.detail ?? ''),
                requiredVersion: Number(parsed.requiredVersion ?? 0),
                supportedVersion: Number(parsed.supportedVersion ?? 0),
            };
        }
    } catch {
        /* fall through */
    }
    return {
        ok: false,
        error: 'unparseable',
        detail: 'the editor could not interpret the load result',
        requiredVersion: 0,
        supportedVersion: 0,
    };
}

/** A sentence to show the user when a load fails. */
export function loadErrorMessage(
    result: Extract<LoadResult, { ok: false }>,
    fileName?: string,
): string {
    const subject = fileName ? `“${fileName}”` : 'This file';
    switch (result.error) {
        case 'too_new':
        case 'container_too_new':
            return (
                `${subject} was created with a newer editor version and uses features ` +
                `this version doesn't support yet.\n\n` +
                `Opening it here would silently discard that work, so it was left ` +
                `untouched. Please update the editor to open it.`
            );
        case 'empty':
            return (
                `${subject} is empty — usually the sign of a save that was interrupted.\n\n` +
                `Your work may still be recoverable from File ▸ Version History.`
            );
        case 'truncated':
        case 'checksum':
        case 'decompress_failed':
        case 'implausible_size':
            return (
                `${subject} appears to be damaged and could not be opened safely.\n\n` +
                `(${result.detail})\n\n` +
                `Try File ▸ Version History for a recent snapshot.`
            );
        // 'unparseable', plus any code a future engine adds that this build
        // doesn't have wording for yet.
        default:
            return `${subject} is not a supported document.`;
    }
}

/** A short note for a load that succeeded but had to repair the document. */
export function repairNoticeMessage(
    result: Extract<LoadResult, { ok: true }>,
    fileName?: string,
): string {
    const subject = fileName ? `“${fileName}”` : 'This document';
    return (
        `${subject} had structural problems that were repaired on open ` +
        `(${result.summary}).\n\n` +
        `Nothing was deleted. Check the artwork looks right before saving over the original.`
    );
}

/**
 * Report a failed load to the user.
 *
 * Injectable so tests (and headless callers) don't hit `window.alert`.
 */
export let reportLoadFailure = (message: string): void => {
    if (typeof window !== 'undefined' && typeof window.alert === 'function') {
        window.alert(message);
    } else {
        console.error(message);
    }
};

/** Report a successful-but-repaired load. Non-blocking by default. */
export let reportRepairs = (message: string): void => {
    console.warn(message);
};

/** Test seam: replace the reporters. */
export function setLoadReporters(opts: {
    failure?: (message: string) => void;
    repairs?: (message: string) => void;
}): void {
    if (opts.failure) reportLoadFailure = opts.failure;
    if (opts.repairs) reportRepairs = opts.repairs;
}
