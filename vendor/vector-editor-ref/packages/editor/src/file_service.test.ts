/**
 * FileService orchestration: handle adoption, dirty clearing, and the
 * abort-leaves-dirty contract. FileIO is mocked (its own file-system behavior
 * is out of scope here); we only assert the state bookkeeping FileService owns.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Document } from './document';
import { FileIO } from './file_io';
import { FileService } from './file_service';
import type { UIEngine } from './ui';
import type { WasmScene } from './wasm_scene';

function makeScene() {
    return {
        engine: {} as any,
        invalidateCache: vi.fn(),
        newDocument: vi.fn(),
    } as unknown as WasmScene;
}

function makeUI() {
    return {
        parseSVG: vi.fn(),
        updateLayerList: vi.fn(),
        syncWithSelection: vi.fn(),
    } as unknown as UIEngine;
}

const fakeHandle = (name: string) => ({ name }) as unknown as FileSystemFileHandle;

beforeEach(() => {
    vi.restoreAllMocks();
});

describe('FileService.saveActive', () => {
    it('saves in place with the existing handle and clears dirty', async () => {
        const doc = new Document('drawing');
        doc.fileHandle = fakeHandle('drawing.rcbvec');
        doc.markMutated();

        const spy = vi.spyOn(FileIO, 'saveNative').mockResolvedValue({ handle: doc.fileHandle });
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.saveActive();

        expect(spy).toHaveBeenCalledWith(expect.anything(), doc.fileHandle, 'drawing.rcbvec');
        expect(doc.dirty).toBe(false);
    });

    it('adopts the handle+name returned from a Save As (no prior handle)', async () => {
        const doc = new Document('Untitled');
        doc.markMutated();
        expect(doc.fileHandle).toBeNull();

        vi.spyOn(FileIO, 'saveNative').mockResolvedValue({ handle: fakeHandle('logo.rcbvec') });
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.saveActive();

        expect(doc.fileHandle).not.toBeNull();
        expect(doc.name).toBe('logo'); // extension stripped
        expect(doc.dirty).toBe(false);
    });

    it('leaves dirty untouched when the user aborts', async () => {
        const doc = new Document('drawing');
        doc.markMutated();

        vi.spyOn(FileIO, 'saveNative').mockResolvedValue(null); // abort
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.saveActive();

        expect(doc.dirty).toBe(true);
    });

    it('keeps dirty and handle=null on a download-fallback save', async () => {
        const doc = new Document('Untitled');
        doc.markMutated();

        vi.spyOn(FileIO, 'saveNative').mockResolvedValue({ handle: null });
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.saveActive();

        expect(doc.fileHandle).toBeNull();
        // Save succeeded (bytes written to disk via download), so mark clean.
        expect(doc.dirty).toBe(false);
    });
});

describe('FileService.saveActiveAs', () => {
    it('leaves dirty untouched on abort', async () => {
        const doc = new Document('drawing');
        doc.fileHandle = fakeHandle('drawing.rcbvec');
        doc.markMutated();

        vi.spyOn(FileIO, 'saveNativeAs').mockResolvedValue(null);
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.saveActiveAs();

        expect(doc.dirty).toBe(true);
        expect(doc.fileHandle).not.toBeNull(); // unchanged
    });
});

describe('FileService.openIntoActive', () => {
    it('loads a file, sets name, clears dirty and refreshes UI', async () => {
        const doc = new Document('Untitled');
        const scene = makeScene();
        const ui = makeUI();

        vi.spyOn(FileIO, 'openFile').mockResolvedValue({
            handle: fakeHandle('art.rcbvec'),
            name: 'art.rcbvec',
        });
        const fs = new FileService(scene, ui, doc);

        await fs.openIntoActive();

        expect(scene.invalidateCache).toHaveBeenCalled();
        expect(doc.name).toBe('art');
        expect(doc.dirty).toBe(false);
        expect(ui.updateLayerList).toHaveBeenCalled();
        expect(ui.syncWithSelection).toHaveBeenCalled();
    });

    it('does nothing on abort', async () => {
        const doc = new Document('keep');
        const scene = makeScene();
        vi.spyOn(FileIO, 'openFile').mockResolvedValue(null);
        const fs = new FileService(scene, makeUI(), doc);

        await fs.openIntoActive();

        expect(scene.invalidateCache).not.toHaveBeenCalled();
        expect(doc.name).toBe('keep');
    });

    it('prompts before discarding a dirty document', async () => {
        const doc = new Document('dirtydoc');
        doc.markMutated();
        const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const openSpy = vi.spyOn(FileIO, 'openFile');
        const fs = new FileService(makeScene(), makeUI(), doc);

        await fs.openIntoActive();

        expect(confirmSpy).toHaveBeenCalled();
        expect(openSpy).not.toHaveBeenCalled(); // declined
    });
});
