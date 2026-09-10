/**
 * Document — the in-memory identity of one open file.
 *
 * Phase A holds a single instance (the active document). The heavy per-document
 * engine state (engine/history/autosave/viewport) is attached in Phase B when
 * multiple documents can be open at once; the fields are declared here so the
 * shape is stable, but Phase A leaves them null and relies on the shared
 * WasmScene singleton.
 *
 * Dirty tracking is a plain mutation counter (see WasmScene.invalidateCache):
 * every mutation bumps `changeCounter`; saving/loading pins `savedCounter` to
 * it. `dirty` is simply the two diverging. This is O(1) and needs no
 * serialization. Known imprecision: undoing back to the exact saved state still
 * reads as dirty — acceptable.
 */

import type { Engine, History } from '../engine/pkg/engine';
import type { AutosaveManager } from './persistence';

let __docSeq = 0;

/** Saved viewport (camera) so switching tabs restores where you were. */
export interface DocumentViewport {
    zoom: number;
    panX: number;
    panY: number;
}

export class Document {
    readonly id: string;
    name: string;
    /** Native file handle for save-in-place (File System Access API). */
    fileHandle: FileSystemFileHandle | null = null;

    /** Monotonic mutation count; compared against savedCounter for `dirty`. */
    changeCounter = 0;
    /** Value of changeCounter at the last save/load. */
    savedCounter = 0;

    // ─── Per-document engine state ─────────────────────────────────────
    // Lazily instantiated by the DocumentManager on first activation, so a
    // restored-but-unviewed tab costs only its serialized bytes.
    engine: Engine | null = null;
    history: History | null = null;
    autosave: AutosaveManager | null = null;

    /** Saved camera, restored on tab switch. */
    viewport: DocumentViewport | null = null;
    /** Serialized bytes for a restored-but-not-yet-instantiated tab. */
    pendingBytes: Uint8Array | null = null;

    constructor(name = 'Untitled', id?: string) {
        this.id = id ?? `doc-${Date.now().toString(36)}-${(__docSeq++).toString(36)}`;
        this.name = name;
    }

    get dirty(): boolean {
        return this.changeCounter !== this.savedCounter;
    }

    /** Called on every mutation (wired to WasmScene.onMutate). */
    markMutated(): void {
        this.changeCounter++;
    }

    /** Called after a successful save or a fresh load — clears dirty. */
    markSaved(): void {
        this.savedCounter = this.changeCounter;
    }
}
