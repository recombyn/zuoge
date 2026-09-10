/**
 * The collaboration version gate, driven against the REAL wasm Engine.
 *
 * This is the sharpest edge in the whole format. Live sync is last-writer-wins
 * over *whole document snapshots*, and prost silently drops fields it does not
 * know. So an older build that accepted a newer peer's scene would decode it
 * lossily, then broadcast the lossy copy back as authoritative — destroying
 * everyone's work in the session, not just its own view of it.
 *
 * The fix has two halves, and both are tested here because either alone is
 * useless:
 *   1. refuse to APPLY a scene that needs a newer reader, and
 *   2. stop BROADCASTING once such a peer is known, since our scene is by then
 *      a downgraded rendering of theirs.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import init, { Engine } from '../engine/pkg/engine';
import { DocumentManager } from './document_manager';
import { setLoadReporters } from './load_status';
import { PersistenceManager } from './persistence';
import { WasmScene } from './wasm_scene';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

let alerts: string[] = [];

beforeEach(() => {
    vi.restoreAllMocks();
    alerts = [];
    setLoadReporters({ failure: (m) => alerts.push(m), repairs: () => {} });
    vi.spyOn(PersistenceManager, 'saveManifest').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'saveDocument').mockResolvedValue();
    vi.spyOn(PersistenceManager, 'loadManifest').mockResolvedValue(null);
    vi.spyOn(PersistenceManager, 'loadAllDocuments').mockResolvedValue([]);
    vi.spyOn(PersistenceManager, 'loadLegacyScene').mockResolvedValue(null);
    vi.spyOn(PersistenceManager, 'saveBackup').mockResolvedValue();
});

function makeManager() {
    const scene = new WasmScene({} as never);
    scene.engine = new Engine();
    const dm = new DocumentManager(
        scene,
        {
            setZoom: vi.fn(),
            updateLayerList: vi.fn(),
            syncWithSelection: vi.fn(),
            parseSVG: vi.fn(),
        } as any,
        { exitEditMode: vi.fn(), commitActiveTextEdit: vi.fn(), currentPathPoints: [] } as any,
        {
            zoom: 1,
            pan: { x: 0, y: 0 },
            fitToArtboard: vi.fn(),
            notifyViewChange: vi.fn(),
            clearImageCache: vi.fn(),
            requestRender: vi.fn(),
        } as any,
        { activeDoc: null, refreshChrome: vi.fn() } as any,
        { render: vi.fn() } as any,
        () => {},
    );
    return { dm, scene };
}

/** A peer's scene, as broadcast: a real serialized document. */
function peerScene(build: (e: Engine) => void): Uint8Array {
    const e = new Engine();
    build(e);
    return new Uint8Array(e.serialize_proto());
}

/**
 * Rewrite a document's `min_reader_version` in place.
 *
 * Offset 10 of the container header, little-endian u32 — see `container.rs`.
 * Forging it directly is how we simulate a peer running a future build without
 * having to invent a future feature.
 */
function withRequiredVersion(bytes: Uint8Array, version: number): Uint8Array {
    const out = new Uint8Array(bytes);
    new DataView(out.buffer).setUint32(10, version, true);
    return out;
}

describe('collab version gate', () => {
    it('applies a peer scene from a compatible build', () => {
        const { dm, scene } = makeManager();
        dm.create('doc');
        const incoming = peerScene((e) => {
            e.add_rect(0, 0, 40, 40);
            e.add_rect(60, 0, 40, 40);
        });

        expect(dm.applyRemoteScene(incoming)).toBe(true);
        expect(scene.engine!.get_root_nodes().length).toBe(2);
        expect(dm.hasNewerPeer()).toBe(false);
        expect(alerts).toEqual([]);
    });

    it('refuses a peer scene that needs a newer reader, leaving ours intact', () => {
        const { dm, scene } = makeManager();
        dm.create('doc');
        scene.addRect(0, 0, 10, 10); // our own work
        const before = scene.engine!.serialize_scene();

        const incoming = withRequiredVersion(
            peerScene((e) => e.add_rect(0, 0, 40, 40)),
            999,
        );

        expect(dm.applyRemoteScene(incoming)).toBe(false);
        expect(scene.engine!.serialize_scene()).toEqual(before);
    });

    it('stops broadcasting once a newer peer is seen', () => {
        const { dm } = makeManager();
        dm.create('doc');
        expect(dm.hasNewerPeer()).toBe(false);

        dm.applyRemoteScene(
            withRequiredVersion(
                peerScene((e) => e.add_rect(0, 0, 1, 1)),
                999,
            ),
        );

        // The host reads this to suppress broadcasts and saves. Without it the
        // refusal above is pointless: we would keep sending our downgraded copy
        // and the newer peer would accept it.
        expect(dm.hasNewerPeer()).toBe(true);
    });

    it('warns the user exactly once, however many updates the peer sends', () => {
        const { dm } = makeManager();
        dm.create('doc');
        const incoming = withRequiredVersion(
            peerScene((e) => e.add_rect(0, 0, 1, 1)),
            999,
        );

        for (let i = 0; i < 5; i++) dm.applyRemoteScene(incoming);

        // Peers re-broadcast on every keystroke; a dialog per message would
        // make the editor unusable.
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatch(/newer editor version/i);
    });

    it('ignores a corrupt peer scene without claiming a newer peer', () => {
        const { dm, scene } = makeManager();
        dm.create('doc');
        scene.addRect(0, 0, 10, 10);
        const before = scene.engine!.serialize_scene();

        const corrupt = peerScene((e) => e.add_rect(0, 0, 40, 40));
        corrupt[corrupt.length - 1] ^= 0xff;

        expect(dm.applyRemoteScene(corrupt)).toBe(false);
        expect(scene.engine!.serialize_scene()).toEqual(before);
        // Corruption on the wire is not a version problem — it must not silence
        // this tab's own broadcasts.
        expect(dm.hasNewerPeer()).toBe(false);
        expect(alerts).toEqual([]);
    });

    it('ignores an empty peer scene rather than blanking the canvas', () => {
        const { dm, scene } = makeManager();
        dm.create('doc');
        scene.addRect(0, 0, 10, 10);

        expect(dm.applyRemoteScene(new Uint8Array(0))).toBe(false);
        expect(scene.engine!.get_root_nodes().length).toBe(1);
    });
});
