/**
 * FileService — orchestrates save/open/new against the active Document.
 *
 * Sits between the raw stateless FileIO and the app: it owns the "which file
 * are we editing" bookkeeping (handle, name, dirty) and refreshes the chrome
 * (title, breadcrumb, tab strip) after each operation. FileIO stays pure; this
 * layer carries the state.
 */

import { logAppEvent } from './analytics';
import type { Document } from './document';
import { FileIO } from './file_io';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

export class FileService {
    constructor(
        private scene: WasmScene,
        private ui: UIEngine,
        /** The document being edited. Reassigned by the DocumentManager (Phase B). */
        public activeDoc: Document,
        /** Refresh breadcrumb / tab strip after title update. */
        private onChrome: () => void = () => {},
    ) {}

    /** Save in place if we have a handle, else Save As. */
    async saveActive(): Promise<void> {
        const engine = this.scene.engine;
        if (!engine) return;

        // A handle restored from a previous session needs its write permission
        // re-granted before we can save in place; fall back to Save As if denied.
        let handle = this.activeDoc.fileHandle;
        if (handle && !(await ensureWritePermission(handle))) {
            handle = null;
        }

        const res = await FileIO.saveNative(engine, handle, this.suggestedName());
        if (!res) return; // user aborted — keep dirty state
        this.adoptHandle(res.handle);
        this.activeDoc.markSaved();
        this.activeDoc.autosave?.snapshotNow(); // checkpoint the saved state
        this.refreshChrome();
        logAppEvent('document_saved', { format: 'native', type: 'save' });
    }

    async saveActiveAs(): Promise<void> {
        const engine = this.scene.engine;
        if (!engine) return;
        const res = await FileIO.saveNativeAs(engine, this.suggestedName());
        if (!res) return;
        this.adoptHandle(res.handle);
        this.activeDoc.markSaved();
        this.activeDoc.autosave?.snapshotNow();
        this.refreshChrome();
        logAppEvent('document_saved', { format: 'native', type: 'saveAs' });
    }

    /** Open a file, replacing the active document's content (Phase A semantics). */
    async openIntoActive(): Promise<void> {
        const engine = this.scene.engine;
        if (!engine) return;
        if (!this.confirmDiscardIfDirty()) return;

        const res = await FileIO.openFile(engine, (svg) => this.ui.parseSVG(svg));
        if (!res) return;

        this.scene.invalidateCache();
        this.activeDoc.fileHandle = res.handle;
        this.activeDoc.name = stripExt(res.name);
        this.activeDoc.markSaved();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.refreshChrome();
    }

    /** Update document.title and downstream chrome. */
    refreshChrome(): void {
        const doc = this.activeDoc;
        document.title = `${doc.dirty ? '● ' : ''}${doc.name} — Vector editor`;
        this.onChrome();
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private adoptHandle(handle: FileSystemFileHandle | null): void {
        if (handle) {
            this.activeDoc.fileHandle = handle;
            this.activeDoc.name = stripExt(handle.name);
        }
    }

    private confirmDiscardIfDirty(): boolean {
        if (!this.activeDoc.dirty) return true;
        return window.confirm(`"${this.activeDoc.name}" has unsaved changes. Discard them?`);
    }

    private suggestedName(): string {
        const n = this.activeDoc.name || 'untitled';
        return n.endsWith('.rcbvec') ? n : `${n}.rcbvec`;
    }
}

function stripExt(name: string): string {
    return name.replace(/\.(rcbvec|svg)$/i, '');
}

/** Ensure readwrite permission on a (possibly restored) handle. */
async function ensureWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
    const h = handle as any;
    if (!h.queryPermission) return true; // older impl — assume granted
    const opts = { mode: 'readwrite' as const };
    if ((await h.queryPermission(opts)) === 'granted') return true;
    return (await h.requestPermission(opts)) === 'granted';
}
