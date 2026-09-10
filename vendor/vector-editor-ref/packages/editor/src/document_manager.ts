/**
 * DocumentManager — owns the set of open documents and the active one.
 *
 * Each document holds its own live Engine + History + AutosaveManager (see
 * Document); switching tabs is a pointer swap on the shared WasmScene
 * (D2 in the plan), so switches are instant and per-document undo is preserved.
 * Restored-but-unviewed tabs stay as serialized bytes until first activation.
 */
import { Engine, History } from '../engine/pkg/engine';
import { logAppEvent } from './analytics';
import { Document } from './document';
import { adoptEmbeddedFonts, FileIO, isNativeDoc } from './file_io';
import type { FileService } from './file_service';
import type { InputManager } from './input';
import { parseLoadResult, reportLoadFailure } from './load_status';
import { AutosaveManager, type BackupEntry, PersistenceManager } from './persistence';
import type { Renderer } from './renderer';
import type { TabStrip } from './tab_strip';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

export class DocumentManager {
    private docs: Document[] = [];
    private activeId: string | null = null;

    /**
     * Optional host callbacks (embedding API — see EditorOptions). `opened`
     * fires when the USER brings a document with content into the editor (file
     * picker, backup restore) — i.e. documents the host doesn't yet know about;
     * `activated` fires on every active-tab change, including the first one;
     * `mutated` fires on every scene mutation, carrying the document it
     * belongs to; `closed` fires when a tab is closed.
     */
    hostEvents: {
        opened?: (doc: Document) => void;
        activated?: (doc: Document) => void;
        mutated?: (doc: Document) => void;
        closed?: (doc: Document) => void;
    } = {};

    constructor(
        private scene: WasmScene,
        private ui: UIEngine,
        private input: InputManager,
        private renderer: Renderer,
        private fileService: FileService,
        private tabStrip: TabStrip,
        /** Refresh breadcrumb root + document.title for the active doc. */
        private refreshChrome: () => void,
        private maxHistory = 50,
        /**
         * Site identity for object-id allocation, applied to every engine this
         * manager instantiates. See `EditorOptions.siteId`. 0 = the original
         * single-writer numbering.
         */
        private siteId = 0,
    ) {}

    /** True once we've told the user a peer is on a newer build. */
    private warnedAboutNewerPeer = false;

    /**
     * True when a collaborator is editing this document with a newer format
     * than this build understands.
     *
     * The host must stop broadcasting and stop saving while this holds. Under
     * last-writer-wins sync our scene is a *lossy* rendering of theirs — every
     * field it could not decode simply gone — so sending it would overwrite their
     * work with a downgraded copy. Going quiet is the only safe move; the user
     * has been told why.
     */
    hasNewerPeer(): boolean {
        return this.warnedAboutNewerPeer;
    }

    /**
     * Tell the user, once per session, that a collaborator's edits can't be
     * shown here.
     *
     * Once, because peers re-broadcast their scene on every change: without the
     * latch this would open a dialog on each keystroke of theirs. And it must
     * be said at all — otherwise the tab simply stops updating, which looks
     * exactly like a broken connection.
     */
    private warnOnceAboutNewerPeer(required: number, supported: number): void {
        console.warn(
            `[collab] a peer is editing with a newer document format ` +
                `(needs v${required}, this build supports v${supported}); ignoring their updates`,
        );
        if (this.warnedAboutNewerPeer) return;
        this.warnedAboutNewerPeer = true;
        reportLoadFailure(
            'Someone else in this document is using a newer editor version.\n\n' +
                "Their changes can't be shown here, and this tab will not send changes " +
                'that would overwrite them. Please update the editor to keep collaborating.',
        );
    }

    /**
     * Change the site used for NEW object ids. Applies to already-open
     * documents as well as ones opened later, so a host that learns its site
     * asynchronously (e.g. from a presence handshake) can set it once the
     * answer arrives.
     */
    setSiteId(site: number): void {
        this.siteId = site;
        for (const doc of this.docs) doc.engine?.set_site_id(site);
    }

    // ─── Queries ────────────────────────────────────────────────────────────

    active(): Document | null {
        return this.docs.find((d) => d.id === this.activeId) ?? null;
    }

    all(): readonly Document[] {
        return this.docs;
    }

    byId(id: string): Document | undefined {
        return this.docs.find((d) => d.id === id);
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    /** Create a new blank document and activate it. */
    create(name = 'Untitled'): Document {
        const doc = new Document(name);
        this.docs.push(doc);
        this.activate(doc.id);
        this.persistManifest();
        logAppEvent('document_created');
        return doc;
    }

    /** Adopt an already-built document (e.g. opened from a file) and activate it. */
    adopt(doc: Document): void {
        this.docs.push(doc);
        this.activate(doc.id);
        this.persistManifest();
    }

    /** Restore a version snapshot as a new tab (never overwrites current work). */
    openBackup(entry: BackupEntry): void {
        const time = new Date(entry.createdAt).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
        });
        const doc = new Document(`${entry.name} (restored ${time})`);
        doc.pendingBytes = entry.bytes; // lazily deserialized on activate
        this.adopt(doc);
        logAppEvent('document_opened', { source: 'backup' });
        this.hostEvents.opened?.(doc);
    }

    /** Close a document (with a dirty-confirm). Never leaves zero tabs open. */
    close(id: string): void {
        const doc = this.byId(id);
        if (!doc) return;
        if (doc.dirty && !window.confirm(`"${doc.name}" has unsaved changes. Close anyway?`))
            return;

        logAppEvent('document_closed');

        // Capture a final version snapshot before dropping the working copy, so
        // the closed document stays recoverable from the backups list.
        doc.autosave?.snapshotNow();

        // Tell the host while the document is still fully addressable, so it
        // can flush a pending save (which needs to look the doc up and
        // serialize it) before dropping its per-document state.
        this.hostEvents.closed?.(doc);

        const idx = this.docs.findIndex((d) => d.id === id);
        this.docs.splice(idx, 1);
        // Remove the working-copy slot (so it won't reopen), but KEEP its backups.
        PersistenceManager.deleteDocument(id).catch(console.error);

        if (this.docs.length === 0) {
            // Always keep one document open.
            this.create();
            return;
        }
        if (this.activeId === id) {
            const next = this.docs[Math.min(idx, this.docs.length - 1)];
            this.activate(next.id, true);
        } else {
            this.renderTabs();
        }
        this.persistManifest();
    }

    /** Cycle the active tab by direction (+1 next, -1 previous), wrapping. */
    cycle(dir: 1 | -1): void {
        if (this.docs.length < 2) return;
        const idx = this.docs.findIndex((d) => d.id === this.activeId);
        const next = (idx + dir + this.docs.length) % this.docs.length;
        this.activate(this.docs[next].id);
    }

    /**
     * Open a file picker and load the chosen file into a NEW tab. If the same
     * file is already open (matched by handle), just activates that tab.
     */
    async openFromPicker(): Promise<void> {
        const picked = await FileIO.pickFile();
        if (!picked) return;

        if (picked.handle) {
            const existing = await this.findOpenByHandle(picked.handle);
            if (existing) {
                this.activate(existing.id);
                return;
            }
        }

        // Create + activate a blank tab so the scene points at its engine, then
        // load into it (SVG import parses into the active engine).
        const isNative = isNativeDoc(picked.file.name);
        const doc = this.create(stripExt(picked.file.name));
        const ok = await FileIO.loadFile(this.scene.engine!, picked.file, (svg) =>
            this.ui.parseSVG(svg),
        );
        if (!ok) {
            this.close(doc.id);
            return;
        }
        doc.fileHandle = isNative ? picked.handle : null;
        this.scene.invalidateCache();
        doc.markSaved();
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.refreshChrome();
        this.renderTabs();
        doc.autosave?.trigger();
        this.persistManifest();

        const ext = picked.file.name.split('.').pop() || 'unknown';
        logAppEvent('document_opened', { source: 'picker', format: ext });
        this.hostEvents.opened?.(doc);
    }

    private async findOpenByHandle(handle: FileSystemFileHandle): Promise<Document | null> {
        for (const d of this.docs) {
            if (d.fileHandle && (await handle.isSameEntry(d.fileHandle))) return d;
        }
        return null;
    }

    rename(id: string, name: string): void {
        const doc = this.byId(id);
        if (!doc) return;
        doc.name = name;
        doc.autosave?.trigger();
        if (doc.id === this.activeId) this.fileService.activeDoc = doc;
        this.refreshChrome();
        this.renderTabs();
        this.persistManifest();
        // A rename is a document change the host must persist too — without
        // this, an embedding app (cloud) never saves the new name.
        this.hostEvents.mutated?.(doc);
    }

    /** Switch the editor to a different document. */
    activate(id: string, force = false): void {
        if (!force && id === this.activeId) return;
        const doc = this.byId(id);
        if (!doc) return;

        const outgoing = this.active();

        // 1. Exit any editing / gesture on the outgoing document first, while
        //    the scene still points at its engine.
        this.input.commitActiveTextEdit(); // close any open inline text overlay
        this.input.exitEditMode();
        this.input.currentPathPoints = [];
        this.scene.endGesture(); // no-op unless a gesture is mid-flight

        if (outgoing && outgoing !== doc) {
            // 2. Save the outgoing camera.
            outgoing.viewport = {
                zoom: this.renderer.zoom,
                panX: this.renderer.pan.x,
                panY: this.renderer.pan.y,
            };
            // 3. Flush its debounced autosave so nothing is lost on switch.
            outgoing.autosave?.flush();
        }

        // 4. Lazily instantiate the incoming document's engine.
        this.ensureInstantiated(doc);

        // 5. Swap the scene onto it and re-point the mutation handler.
        this.scene.attachDocument(doc);
        this.scene.onMutate = () => this.handleMutation(doc);
        this.activeId = doc.id;
        this.fileService.activeDoc = doc;

        // 6. Restore camera + rebuild UI for the new document.
        if (doc.viewport) {
            this.renderer.zoom = doc.viewport.zoom;
            this.renderer.pan = { x: doc.viewport.panX, y: doc.viewport.panY };
            this.renderer.notifyViewChange();
        } else {
            this.renderer.fitToArtboard();
        }
        this.ui.setZoom(this.renderer.zoom);
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.refreshChrome();
        this.renderTabs();
        this.hostEvents.activated?.(doc);
    }

    /**
     * Mirror a collaborator's snapshot onto the ACTIVE document, in place.
     *
     * This is the receive half of live co-editing: a peer broadcast the latest
     * bytes of the document we both have open, and we swap them onto the canvas
     * so their change simply appears — no new tab, no prompt to reload.
     * Deliberately NOT a mutation: it takes no undo step, doesn't bump the
     * change counter, and doesn't fire the host `mutated` hook, so mirroring a
     * peer's edit can never loop back out as our own broadcast/save.
     *
     * Declines (returns false) when there is no active engine, or when the
     * local user is mid-gesture / editing text — yanking the scene out from
     * under a live drag is worse than a moment's lag, so the caller re-applies
     * the latest bytes once the action ends.
     */
    applyRemoteScene(bytes: Uint8Array): boolean {
        const doc = this.active();
        if (!doc?.engine) return false;
        if (
            this.scene.inGesture ||
            this.renderer.editingTextId != null ||
            this.input.isDraggingHandle
        ) {
            return false;
        }
        // Keep the local user's selection across the swap. Object ids are
        // site-partitioned, so they mean the same node in every tab; we drop
        // any the peer has since deleted.
        const priorSelection = Array.from(this.scene.getSelection());

        // Refuse a scene this build would silently downgrade.
        //
        // This is the sharpest edge of the whole format: sync is last-writer-
        // wins over full snapshots, so if a stale tab applied a newer peer's
        // scene it would drop every field it didn't understand and then
        // broadcast the lossy version back as authoritative — destroying that
        // work for everyone in the session, not just locally. Declining costs
        // this one client freshness; applying costs everyone their data.
        const result = parseLoadResult(doc.engine.load_document(bytes));
        if (!result.ok) {
            if (result.error === 'too_new' || result.error === 'container_too_new') {
                this.warnOnceAboutNewerPeer(result.requiredVersion, result.supportedVersion);
            } else {
                console.warn('[collab] ignoring an unreadable peer scene:', result.detail);
            }
            return false;
        }
        if (result.repaired) {
            console.warn('[collab] peer scene needed repairs:', result.summary);
        }
        void adoptEmbeddedFonts(doc.engine);
        // Re-assert OUR object-id site: deserialize resumes the id counter from
        // the loaded document, but new local objects must keep allocating from
        // our own site so they can't collide with the peer's.
        doc.engine.set_site_id(this.siteId);
        // The peer's snapshot carries its own image-id space; drop decoded-image
        // caches keyed to the previous content (same reason as the load path).
        this.renderer.clearImageCache();
        // Refresh JS + renderer caches and request a frame — but as a load, not
        // a mutation (invalidateCache(false): no counter bump, no onMutate).
        this.scene.invalidateCache(false);
        // Restore selection to the nodes that still exist.
        doc.engine.clear_selection();
        if (priorSelection.length) {
            const present = this.collectNodeIds(doc);
            for (const id of priorSelection) {
                if (present.has(id)) doc.engine.select_node(id, true);
            }
        }
        this.ui.updateLayerList();
        this.ui.syncWithSelection();
        this.renderer.requestRender();
        return true;
    }

    /** Every node id currently in a document (roots + all descendants). */
    private collectNodeIds(doc: Document): Set<number> {
        const engine = doc.engine!;
        const out = new Set<number>();
        const walk = (ids: Uint32Array) => {
            for (const id of ids) {
                out.add(id);
                walk(engine.get_node_children(id));
            }
        };
        walk(engine.get_root_nodes());
        return out;
    }

    // ─── Session restore ──────────────────────────────────────────────────

    /**
     * Rebuild the open-document set from IndexedDB. Falls back to migrating the
     * legacy single-scene autosave, or a fresh Untitled document.
     */
    async restoreSession(): Promise<void> {
        const [manifest, stored] = await Promise.all([
            PersistenceManager.loadManifest(),
            PersistenceManager.loadAllDocuments(),
        ]);

        if (manifest && stored.length > 0) {
            const byId = new Map(stored.map((s) => [s.id, s]));
            for (const openId of manifest.open) {
                const s = byId.get(openId);
                if (!s) continue;
                const doc = new Document(s.name, s.id);
                doc.fileHandle = s.handle;
                doc.pendingBytes = s.bytes; // stays lazy until activated
                this.docs.push(doc);
            }
        }

        if (this.docs.length === 0) {
            // Migrate a pre-tabs autosave, if present.
            const legacy = await PersistenceManager.loadLegacyScene();
            const doc = new Document('Untitled');
            if (legacy) {
                doc.pendingBytes = legacy;
                PersistenceManager.clearLegacyScene().catch(() => {});
            }
            this.docs.push(doc);
        }

        const wanted =
            manifest?.active && this.byId(manifest.active) ? manifest.active : this.docs[0].id;
        this.activate(wanted, true);
        this.persistManifest();
    }

    // ─── Internals ──────────────────────────────────────────────────────────

    private handleMutation(doc: Document): void {
        doc.markMutated();
        // Every scene mutation funnels through here regardless of how it was
        // triggered (gesture, menu, SVG import, paste, programmatic), so this
        // is the one place a host can reliably learn "this document changed".
        this.hostEvents.mutated?.(doc);
        // Autosave itself is triggered by the WasmScene mutation wrappers via
        // this.scene.autosave (= doc.autosave). Here we only reflect the dirty
        // state in the chrome.
        this.refreshChrome();
        this.renderTabs();
    }

    private ensureInstantiated(doc: Document): void {
        if (doc.engine) return;
        doc.engine = new Engine();
        // Set the site BEFORE loading: deserializing resumes this site's
        // counter from what the document already holds, so the order matters.
        doc.engine.set_site_id(this.siteId);
        if (doc.pendingBytes) {
            const result = parseLoadResult(doc.engine.load_document(doc.pendingBytes));
            // Tell the user rather than silently presenting an empty canvas.
            // This path covers restoring an autosave and reopening a tab, where
            // a truncated or too-new document used to look like a blank one.
            FileIO.announce(result, doc.name);
            if (result.ok) void adoptEmbeddedFonts(doc.engine);
            doc.pendingBytes = null;
        }
        doc.history = new History(this.maxHistory);
        doc.autosave = new AutosaveManager(doc.engine, doc.id, () => ({
            name: doc.name,
            handle: doc.fileHandle,
        }));
    }

    private renderTabs(): void {
        this.tabStrip.render(
            this.docs.map((d) => ({
                id: d.id,
                name: d.name,
                dirty: d.dirty,
                active: d.id === this.activeId,
            })),
        );
    }

    private persistManifest(): void {
        PersistenceManager.saveManifest({
            open: this.docs.map((d) => d.id),
            active: this.activeId,
        }).catch(console.error);
    }
}

function stripExt(name: string): string {
    return name.replace(/\.(rcbvec|svg)$/i, '');
}
