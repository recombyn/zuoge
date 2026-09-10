/**
 * Multi-document semantics for DocumentManager, driven against the REAL wasm
 * Engine + History (loaded headless, same pattern as gesture_history.test.ts).
 *
 * The collaborators DocumentManager only calls into (ui/input/renderer/tabStrip/
 * fileService) are stubbed; persistence is mocked so no IndexedDB is needed
 * (jsdom has none). The load-bearing claim under test is D2: each document holds
 * its own live engine + history, and switching tabs preserves both.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import init, { Engine } from '../engine/pkg/engine';
import { DocumentManager } from './document_manager';
import { PersistenceManager } from './persistence';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(PersistenceManager, 'saveManifest').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'saveDocument').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'deleteDocument').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'loadManifest').mockResolvedValue(null);
    vi.spyOn(PersistenceManager, 'loadAllDocuments').mockResolvedValue([]);
    vi.spyOn(PersistenceManager, 'loadLegacyScene').mockResolvedValue(null);
    vi.spyOn(PersistenceManager, 'saveBackup').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'deleteBackup').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'listBackups').mockResolvedValue([]);
});

function makeManager() {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    const ui = {
        setZoom: vi.fn(),
        updateLayerList: vi.fn(),
        syncWithSelection: vi.fn(),
        parseSVG: vi.fn(),
    };
    const input = {
        exitEditMode: vi.fn(),
        commitActiveTextEdit: vi.fn(),
        currentPathPoints: [] as unknown[],
    };
    const renderer = {
        zoom: 1,
        pan: { x: 0, y: 0 },
        fitToArtboard: vi.fn(),
        notifyViewChange: vi.fn(),
    };
    const tabStrip = { render: vi.fn() };
    const fileService = { activeDoc: null as unknown, refreshChrome: vi.fn() };
    const dm = new DocumentManager(
        scene,
        ui as any,
        input as any,
        renderer as any,
        fileService as any,
        tabStrip as any,
        () => {},
    );
    return { dm, scene, renderer, fileService };
}

describe('DocumentManager multi-doc', () => {
    it('gives each document its own engine; switching preserves content', () => {
        const { dm, scene } = makeManager();
        const a = dm.create('A');
        scene.addRect(0, 0, 100, 100); // mutate A's engine

        expect(a.engine).not.toBeNull();
        expect(a.engine!.get_root_nodes().length).toBe(1);

        const b = dm.create('B');
        expect(scene.engine).toBe(b.engine);
        expect(b.engine!.get_root_nodes().length).toBe(0); // B is blank
        expect(a.engine!.get_root_nodes().length).toBe(1); // A untouched
    });

    it('preserves per-document undo history across a switch', () => {
        const { dm, scene } = makeManager();
        const a = dm.create('A');
        scene.addRect(0, 0, 50, 50);
        dm.create('B'); // switch away
        dm.activate(a.id); // ...and back

        expect(scene.engine).toBe(a.engine);
        expect(scene.engine!.get_root_nodes().length).toBe(1);
        scene.undo();
        expect(scene.engine!.get_root_nodes().length).toBe(0); // undo still works on A
    });

    it('tracks dirty state per document', () => {
        const { dm, scene } = makeManager();
        const a = dm.create('A');
        scene.addRect(0, 0, 10, 10);
        expect(a.dirty).toBe(true);

        const b = dm.create('B');
        expect(b.dirty).toBe(false); // B never mutated
        expect(a.dirty).toBe(true);
    });

    it('confirms before closing a dirty document and keeps it on decline', () => {
        const { dm, scene } = makeManager();
        const a = dm.create('A');
        dm.create('B');
        dm.activate(a.id);
        scene.addRect(0, 0, 10, 10); // A dirty

        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        dm.close(a.id);

        expect(confirmSpy).toHaveBeenCalled();
        expect(dm.byId(a.id)).toBeTruthy(); // decline → still open
    });

    it('never leaves zero tabs; closing the last opens a fresh one', () => {
        const { dm } = makeManager();
        const a = dm.create('A');
        vi.spyOn(window, 'confirm').mockReturnValue(true);
        dm.close(a.id);
        expect(dm.all().length).toBe(1);
        expect(dm.active()).not.toBeNull();
    });

    it('openBackup restores a snapshot into a new tab without touching the current one', () => {
        const { dm, scene } = makeManager();
        // Build a snapshot of a doc with two rects.
        const seed = new Engine();
        seed.add_rect(0, 0, 10, 10);
        seed.add_rect(20, 20, 10, 10);
        const bytes = new Uint8Array(seed.serialize_proto());

        const current = dm.create('Working');
        scene.addRect(0, 0, 5, 5); // current has 1 node

        dm.openBackup({ id: 'd0:1', docId: 'd0', name: 'Design', bytes, createdAt: 1 });

        // A new tab is active with the restored content (2 nodes)...
        expect(dm.all().length).toBe(2);
        expect(dm.active()!.name).toContain('Design (restored');
        expect(scene.engine!.get_root_nodes().length).toBe(2);
        // ...and the original tab is untouched (still 1 node).
        expect(current.engine!.get_root_nodes().length).toBe(1);
    });

    it('captures a final snapshot on close (recoverable after close)', () => {
        const { dm, scene } = makeManager();
        const a = dm.create('A');
        dm.create('B'); // so closing A doesn't hit the last-tab path
        dm.activate(a.id);
        scene.addRect(0, 0, 10, 10);
        const saveBackup = PersistenceManager.saveBackup as unknown as ReturnType<typeof vi.fn>;
        saveBackup.mockClear();
        vi.spyOn(window, 'confirm').mockReturnValue(true);

        dm.close(a.id);

        expect(saveBackup).toHaveBeenCalled(); // snapshotNow fired before removal
    });

    it('restoreSession with no data creates one Untitled document', async () => {
        const { dm } = makeManager();
        await dm.restoreSession();
        expect(dm.all().length).toBe(1);
        expect(dm.active()!.name).toBe('Untitled');
    });

    it('restoreSession migrates a legacy scene into a document', async () => {
        // Craft legacy bytes: an engine with one rect.
        const seed = new Engine();
        seed.add_rect(0, 0, 20, 20);
        const legacyBytes = new Uint8Array(seed.serialize_proto());
        vi.spyOn(PersistenceManager, 'loadLegacyScene').mockResolvedValue(legacyBytes);

        const { dm, scene } = makeManager();
        await dm.restoreSession();

        expect(dm.all().length).toBe(1);
        expect(scene.engine!.get_root_nodes().length).toBe(1); // the migrated rect
    });

    it('restoreSession rebuilds open tabs from a manifest', async () => {
        const seedA = new Engine();
        seedA.add_rect(0, 0, 10, 10);
        const seedB = new Engine(); // blank
        vi.spyOn(PersistenceManager, 'loadManifest').mockResolvedValue({
            open: ['d1', 'd2'],
            active: 'd2',
        });
        vi.spyOn(PersistenceManager, 'loadAllDocuments').mockResolvedValue([
            {
                id: 'd1',
                name: 'One',
                bytes: new Uint8Array(seedA.serialize_proto()),
                handle: null,
                updatedAt: 0,
            },
            {
                id: 'd2',
                name: 'Two',
                bytes: new Uint8Array(seedB.serialize_proto()),
                handle: null,
                updatedAt: 0,
            },
        ]);

        const { dm, scene } = makeManager();
        await dm.restoreSession();

        expect(dm.all().map((d) => d.name)).toEqual(['One', 'Two']);
        expect(dm.active()!.id).toBe('d2'); // manifest's active
        expect(scene.engine!.get_root_nodes().length).toBe(0); // d2 is blank
    });
});
