/**
 * Document identity across saves.
 *
 * The uuid is what cloud sync uses to tell "the same document, edited twice"
 * from "two documents" — filenames cannot do that, because a user renames and
 * copies files freely. So the load-bearing property is not that a uuid exists,
 * it is that it is assigned **once** and never changes again, through every
 * subsequent save, save-as, autosave and reload.
 *
 * `stampDocumentIdentity` is called on all of those paths, which is exactly why
 * a bug there would be easy to miss: it would look fine until two devices
 * decided they were editing different documents.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine } from '../engine/pkg/engine';
import { APP_VERSION, stampDocumentIdentity } from './file_io';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

describe('document identity', () => {
    it('assigns a uuid and creation time on first save', () => {
        const e = new Engine();
        expect(e.get_document_uuid()).toBe('');

        stampDocumentIdentity(e, 'artwork.rcbvec');

        expect(e.get_document_uuid()).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(e.get_document_created_at()).toBeGreaterThan(0);
        expect(e.get_document_app_version()).toBe(APP_VERSION);
    });

    it('keeps the same uuid and creation time across repeated saves', () => {
        const e = new Engine();
        stampDocumentIdentity(e, 'a.rcbvec');
        const uuid = e.get_document_uuid();
        const created = e.get_document_created_at();

        for (let i = 0; i < 5; i++) stampDocumentIdentity(e, `renamed-${i}.rcbvec`);

        expect(e.get_document_uuid()).toBe(uuid);
        expect(e.get_document_created_at()).toBe(created);
    });

    it('carries the uuid through a save and reload', () => {
        const e = new Engine();
        e.add_rect(0, 0, 10, 10);
        stampDocumentIdentity(e, 'doc.rcbvec');
        const uuid = e.get_document_uuid();
        const created = e.get_document_created_at();

        const reopened = new Engine();
        expect(reopened.load_document(e.serialize_proto())).toContain('"ok":true');
        expect(reopened.get_document_uuid()).toBe(uuid);
        expect(reopened.get_document_created_at()).toBe(created);

        // ...and saving the reopened copy still doesn't change it.
        stampDocumentIdentity(reopened, 'doc.rcbvec');
        expect(reopened.get_document_uuid()).toBe(uuid);
        expect(reopened.get_document_created_at()).toBe(created);
    });

    it('gives two independently created documents different uuids', () => {
        const a = new Engine();
        const b = new Engine();
        stampDocumentIdentity(a, 'a.rcbvec');
        stampDocumentIdentity(b, 'b.rcbvec');
        expect(a.get_document_uuid()).not.toBe(b.get_document_uuid());
    });

    it('advances the modified time without disturbing the created time', () => {
        const e = new Engine();
        e.set_document_meta('fixed-uuid', 1000, 1000, '0.0.1', 'T');
        stampDocumentIdentity(e, 'x.rcbvec');

        expect(e.get_document_uuid()).toBe('fixed-uuid');
        expect(e.get_document_created_at()).toBe(1000);
        expect(e.get_document_modified_at()).toBeGreaterThan(1000);
    });

    it('takes the title from the filename only when the document has none', () => {
        const e = new Engine();
        stampDocumentIdentity(e, 'My Logo.rcbvec');
        expect(e.get_document_title()).toBe('My Logo');

        // A title already set is the user's, and a later save must not
        // overwrite it with whatever the file happens to be called.
        stampDocumentIdentity(e, 'copy of My Logo (1).rcbvec');
        expect(e.get_document_title()).toBe('My Logo');
    });

    it('does not let identity stamping disturb the undo fixed point', () => {
        const e = new Engine();
        e.add_rect(1, 2, 3, 4);
        stampDocumentIdentity(e, 'doc.rcbvec');

        // Two snapshots of an unchanged scene must be byte-identical, or undo
        // coalescing breaks. Stamping writes a timestamp, so this checks the
        // timestamp lives on the scene rather than being minted per serialize.
        expect(e.serialize_scene()).toEqual(e.serialize_scene());
    });
});
