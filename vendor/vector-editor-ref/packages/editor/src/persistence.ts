/**
 * Persistence — IndexedDB storage for open documents and the session manifest.
 *
 * Schema (DB version 2):
 *   - `documents`: keyed by document id → StoredDoc {id, name, bytes, handle, updatedAt}
 *   - `session`:   key 'manifest' → SessionManifest {open[], active}
 *   - `scenes`:    legacy v1 store (key 'current_scene'), kept read-only so a
 *                  pre-tabs autosave can be migrated into a single document.
 *
 * FileSystemFileHandle is structured-cloneable, so it round-trips through
 * IndexedDB; re-permissioning on restore is handled by FileService.
 */
import type { Engine } from '../engine/pkg/engine';
import { stampDocumentIdentity } from './file_io';

export interface StoredDoc {
    id: string;
    name: string;
    bytes: Uint8Array;
    handle: FileSystemFileHandle | null;
    updatedAt: number;
}

export interface SessionManifest {
    open: string[];
    active: string | null;
}

/** One timestamped version snapshot of a document (for restore). */
export interface BackupEntry {
    /** `${docId}:${createdAt}` — unique per snapshot. */
    id: string;
    docId: string;
    name: string;
    bytes: Uint8Array;
    createdAt: number;
}

/** Rolling cap of snapshots kept per document. */
export const BACKUP_CAP = 20;
/** Minimum gap between automatic snapshots of the same document. */
export const BACKUP_THROTTLE_MS = 2 * 60 * 1000; // 2 minutes

/** Decide whether enough time has passed to take another automatic snapshot. */
export function shouldSnapshot(
    lastAt: number,
    now: number,
    throttleMs = BACKUP_THROTTLE_MS,
): boolean {
    return now - lastAt >= throttleMs;
}

/**
 * Given a doc's backups (any order) and a cap, return the ids of the oldest
 * entries to delete so that at most `cap` (newest) remain.
 */
export function backupIdsToPrune(entries: BackupEntry[], cap = BACKUP_CAP): string[] {
    if (entries.length <= cap) return [];
    // Newest first; tiebreak on id so same-millisecond entries prune deterministically.
    const byNewest = [...entries].sort(
        (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1),
    );
    return byNewest.slice(cap).map((e) => e.id);
}

const DB_NAME = 'VectorEditorDB';
const VERSION = 3;
const DOCS = 'documents';
const SESSION = 'session';
const BACKUPS = 'backups';
const LEGACY = 'scenes';
const LEGACY_KEY = 'current_scene';
const MANIFEST_KEY = 'manifest';

export class PersistenceManager {
    static async saveDocument(doc: StoredDoc): Promise<void> {
        const db = await PersistenceManager.openDB();
        return PersistenceManager.tx(db, DOCS, 'readwrite', (store) => store.put(doc, doc.id));
    }

    static async deleteDocument(id: string): Promise<void> {
        const db = await PersistenceManager.openDB();
        return PersistenceManager.tx(db, DOCS, 'readwrite', (store) => store.delete(id));
    }

    static async loadAllDocuments(): Promise<StoredDoc[]> {
        const db = await PersistenceManager.openDB();
        return new Promise((resolve) => {
            const req = db.transaction(DOCS, 'readonly').objectStore(DOCS).getAll();
            req.onsuccess = () => resolve((req.result as StoredDoc[]) ?? []);
            req.onerror = () => resolve([]);
        });
    }

    static async saveManifest(m: SessionManifest): Promise<void> {
        const db = await PersistenceManager.openDB();
        return PersistenceManager.tx(db, SESSION, 'readwrite', (store) =>
            store.put(m, MANIFEST_KEY),
        );
    }

    static async loadManifest(): Promise<SessionManifest | null> {
        const db = await PersistenceManager.openDB();
        return new Promise((resolve) => {
            const req = db.transaction(SESSION, 'readonly').objectStore(SESSION).get(MANIFEST_KEY);
            req.onsuccess = () => resolve((req.result as SessionManifest) ?? null);
            req.onerror = () => resolve(null);
        });
    }

    /** Read the legacy v1 single-scene autosave, if any (for migration). */
    static async loadLegacyScene(): Promise<Uint8Array | null> {
        const db = await PersistenceManager.openDB();
        if (!db.objectStoreNames.contains(LEGACY)) return null;
        return new Promise((resolve) => {
            const req = db.transaction(LEGACY, 'readonly').objectStore(LEGACY).get(LEGACY_KEY);
            req.onsuccess = () => {
                const data = req.result;
                resolve(data ? new Uint8Array(data) : null);
            };
            req.onerror = () => resolve(null);
        });
    }

    /** Delete the legacy scene once migrated, so it isn't re-imported. */
    static async clearLegacyScene(): Promise<void> {
        const db = await PersistenceManager.openDB();
        if (!db.objectStoreNames.contains(LEGACY)) return;
        return PersistenceManager.tx(db, LEGACY, 'readwrite', (store) => store.delete(LEGACY_KEY));
    }

    // ─── Backups (version history) ───────────────────────────────────────────

    /** Write a version snapshot, then prune that document to the newest cap. */
    static async saveBackup(entry: BackupEntry, cap = BACKUP_CAP): Promise<void> {
        const db = await PersistenceManager.openDB();
        await PersistenceManager.tx(db, BACKUPS, 'readwrite', (store) =>
            store.put(entry, entry.id),
        );
        const existing = await PersistenceManager.listBackupsForDoc(entry.docId);
        const toPrune = backupIdsToPrune(existing, cap);
        for (const id of toPrune) await PersistenceManager.deleteBackup(id);
    }

    /** All backups across all documents, newest first. */
    static async listBackups(): Promise<BackupEntry[]> {
        const db = await PersistenceManager.openDB();
        return new Promise((resolve) => {
            const req = db.transaction(BACKUPS, 'readonly').objectStore(BACKUPS).getAll();
            req.onsuccess = () => {
                const all = (req.result as BackupEntry[]) ?? [];
                all.sort((a, b) => b.createdAt - a.createdAt);
                resolve(all);
            };
            req.onerror = () => resolve([]);
        });
    }

    static async listBackupsForDoc(docId: string): Promise<BackupEntry[]> {
        const all = await PersistenceManager.listBackups();
        return all.filter((b) => b.docId === docId);
    }

    static async loadBackup(id: string): Promise<BackupEntry | null> {
        const db = await PersistenceManager.openDB();
        return new Promise((resolve) => {
            const req = db.transaction(BACKUPS, 'readonly').objectStore(BACKUPS).get(id);
            req.onsuccess = () => resolve((req.result as BackupEntry) ?? null);
            req.onerror = () => resolve(null);
        });
    }

    static async deleteBackup(id: string): Promise<void> {
        const db = await PersistenceManager.openDB();
        return PersistenceManager.tx(db, BACKUPS, 'readwrite', (store) => store.delete(id));
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private static tx(
        db: IDBDatabase,
        storeName: string,
        mode: IDBTransactionMode,
        op: (store: IDBObjectStore) => IDBRequest,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const req = op(tx.objectStore(storeName));
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    private static openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS);
                if (!db.objectStoreNames.contains(SESSION)) db.createObjectStore(SESSION);
                // v3: version-history snapshots (keyed by BackupEntry.id).
                if (!db.objectStoreNames.contains(BACKUPS)) db.createObjectStore(BACKUPS);
                // Keep the legacy 'scenes' store if it exists (created in v1) so
                // loadLegacyScene() can migrate it. Do not create it fresh.
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
}

/**
 * AutosaveManager — debounced per-document persistence.
 *
 * One instance per document, bound to that document's engine and id. `getMeta`
 * pulls the current name/handle at save time so renames and Save-As are picked
 * up without re-wiring. `flush()` fires any pending write immediately (used on
 * tab switch so a debounced change isn't lost).
 */
export class AutosaveManager {
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private interval = 2000; // 2 seconds
    /** Timestamp of the last version snapshot written to `backups`. */
    private lastBackupAt = 0;

    constructor(
        private engine: Engine,
        private docId: string,
        private getMeta: () => { name: string; handle: FileSystemFileHandle | null },
    ) {}

    trigger(): void {
        if (this.timeout) clearTimeout(this.timeout);
        this.timeout = setTimeout(() => this.save(), this.interval);
    }

    /** Fire a pending save immediately (no-op if nothing is pending). */
    flush(): void {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.save();
        }
    }

    /** Force a version snapshot now, ignoring the throttle (Save / tab close). */
    snapshotNow(): void {
        stampDocumentIdentity(this.engine);
        this.writeBackup(this.engine.serialize_proto());
    }

    private save(): void {
        this.timeout = null;
        const meta = this.getMeta();
        // Assign the document's uuid and creation time on the first autosave if
        // it doesn't have them yet, so identity is established before the
        // document ever reaches a file or the cloud. Fonts are deliberately not
        // embedded here: autosave runs constantly and must not await a fetch.
        stampDocumentIdentity(this.engine, meta.name);
        const bytes = this.engine.serialize_proto();
        PersistenceManager.saveDocument({
            id: this.docId,
            name: meta.name,
            bytes: new Uint8Array(bytes),
            handle: meta.handle,
            updatedAt: Date.now(),
        }).catch(console.error);

        // Additionally keep a throttled version-history snapshot.
        if (shouldSnapshot(this.lastBackupAt, Date.now())) {
            this.writeBackup(bytes);
        }
    }

    private writeBackup(bytes: Uint8Array | number[]): void {
        const now = Date.now();
        this.lastBackupAt = now;
        // A monotonic suffix keeps ids unique even for snapshots taken within
        // the same millisecond (e.g. rapid Save presses).
        const id = `${this.docId}:${now}:${AutosaveManager.backupSeq++}`;
        PersistenceManager.saveBackup({
            id,
            docId: this.docId,
            name: this.getMeta().name,
            bytes: new Uint8Array(bytes),
            createdAt: now,
        }).catch(console.error);
    }

    private static backupSeq = 0;
}
