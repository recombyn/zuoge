/**
 * Font embedding: what makes a native document file self-contained.
 *
 * Text nodes reference a family by NAME, and faces are fetched from a CDN at
 * render time. That means the same document lays out differently offline, and
 * differently again if the CDN reissues a family with new metrics — the file is
 * not archival. Saving embeds the faces the document actually uses; opening
 * registers them before the first paint.
 *
 * Driven against the real wasm Engine, with the network stubbed.
 */
/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import init, { Engine } from '../engine/pkg/engine';

beforeAll(async () => {
    await init({
        module_or_path: readFileSync(resolve('packages/editor/engine/pkg/engine_bg.wasm')),
    });
});

/** Distinctive bytes, so we can prove these exact ones came back out. */
function fakeFace(tag: string): Uint8Array {
    const bytes = new Uint8Array(512);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (tag.charCodeAt(i % tag.length) + i) % 256;
    return bytes;
}

/** A document with one Inter text node. `add_text` leaves the family empty —
 *  the editor assigns it in a second call — so do the same here. */
function textDoc(): Engine {
    const e = new Engine();
    const id = e.add_text(10, 20, 'Hello', 24);
    e.set_text_properties(id, 'Inter', 0, 1.2);
    return e;
}

describe('required font discovery', () => {
    it('reports the family/weight/slant each text node needs', () => {
        const e = textDoc();
        const required = JSON.parse(e.get_required_fonts_json());
        expect(required).toEqual([{ family: 'Inter', weight: 400, italic: false }]);
    });

    it('reports nothing for a document with no text', () => {
        const e = new Engine();
        e.add_rect(0, 0, 10, 10);
        expect(JSON.parse(e.get_required_fonts_json())).toEqual([]);
    });

    it('deduplicates: many nodes in one face need it embedded once', () => {
        const e = new Engine();
        for (let i = 0; i < 5; i++) {
            const id = e.add_text(0, i * 30, `line ${i}`, 16);
            e.set_text_properties(id, 'Inter', 0, 1.2);
        }
        expect(JSON.parse(e.get_required_fonts_json())).toHaveLength(1);
    });
});

describe('embedding and round-trip', () => {
    it('carries the exact face bytes through a save and load', () => {
        const e = textDoc();
        const bytes = fakeFace('INTER-REGULAR');
        e.embed_font('Inter', 400, false, bytes, 'fontsource:inter');

        const saved = e.serialize_proto();
        const reloaded = new Engine();
        expect(reloaded.load_document(new Uint8Array(saved))).toContain('"ok":true');

        expect(reloaded.embedded_font_count()).toBe(1);
        expect(reloaded.embedded_font_family(0)).toBe('Inter');
        expect(reloaded.embedded_font_weight(0)).toBe(400);
        expect(reloaded.embedded_font_italic(0)).toBe(false);
        // Bytes come back raw, not base64 inside a JSON blob.
        expect(Array.from(reloaded.embedded_font_bytes(0))).toEqual(Array.from(bytes));
    });

    it('replaces rather than duplicates when the same face is embedded twice', () => {
        const e = textDoc();
        e.embed_font('Inter', 400, false, fakeFace('FIRST'), 'a');
        e.embed_font('Inter', 400, false, fakeFace('SECOND'), 'b');

        expect(e.embedded_font_count()).toBe(1);
        // The later embed replaced the earlier one rather than duplicating it.
        expect(Array.from(e.embedded_font_bytes(0))).toEqual(Array.from(fakeFace('SECOND')));
    });

    it('keeps weight and slant variants of one family apart', () => {
        const e = textDoc();
        e.embed_font('Inter', 400, false, fakeFace('R'), '');
        e.embed_font('Inter', 700, false, fakeFace('B'), '');
        e.embed_font('Inter', 400, true, fakeFace('I'), '');
        expect(e.embedded_font_count()).toBe(3);
    });
});

describe('pruning', () => {
    it('drops faces no text node uses any more', () => {
        const e = textDoc();
        e.embed_font('Inter', 400, false, fakeFace('USED'), '');
        e.embed_font('Comic Sans', 400, false, fakeFace('UNUSED'), '');
        expect(e.embedded_font_count()).toBe(2);

        // A document shouldn't accumulate megabytes of typefaces for text that
        // has since been deleted.
        expect(e.prune_unused_fonts()).toBe(1);
        expect(e.embedded_font_count()).toBe(1);
        expect(e.embedded_font_family(0)).toBe('Inter');
    });

    it('keeps a face still referenced by text', () => {
        const e = textDoc();
        e.embed_font('Inter', 400, false, fakeFace('USED'), '');
        expect(e.prune_unused_fonts()).toBe(0);
    });
});

describe('version floor', () => {
    // min_reader_version lives at offset 10 of the header (see container.rs).
    const floorOf = (e: Engine) => {
        const saved = new Uint8Array(e.serialize_proto());
        return new DataView(saved.buffer, saved.byteOffset).getUint32(10, true);
    };

    it('embedded fonts are part of v1, so they do not raise the floor', () => {
        const e = textDoc();
        e.embed_font('Inter', 400, false, fakeFace('X'), '');
        expect(floorOf(e)).toBe(e.get_format_version());
    });

    it('a plain document sits at the same baseline', () => {
        const e = new Engine();
        e.add_rect(0, 0, 10, 10);
        expect(floorOf(e)).toBe(e.get_format_version());
    });
});
