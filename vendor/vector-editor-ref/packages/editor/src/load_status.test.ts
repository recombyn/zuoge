/**
 * Load-status handling: the layer that turns the engine's JSON verdict into
 * something a user can act on.
 *
 * The behaviour under test is mostly about *not* claiming success. Before the
 * container envelope, every failure mode — truncated file, empty file, a document
 * from a newer build — arrived as `false` (or, worse, as a successful load of
 * an empty document), so the UI had nothing to say and often said nothing.
 */
import { describe, expect, it } from 'vitest';
import { loadErrorMessage, parseLoadResult, repairNoticeMessage } from './load_status';

const CLEAN_OK = JSON.stringify({
    ok: true,
    repaired: false,
    summary: 'no repairs',
    repairs: {
        duplicate_ids: 0,
        dangling_roots: 0,
        dangling_children: 0,
        cycles_broken: 0,
        reparented: 0,
        orphans_rehomed: 0,
        missing_images: 0,
        coords_clamped: 0,
    },
});

describe('parseLoadResult', () => {
    it('reads a clean success', () => {
        const r = parseLoadResult(CLEAN_OK);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.repaired).toBe(false);
            expect(r.repairs.cycles_broken).toBe(0);
        }
    });

    it('reads a success that required repairs', () => {
        const r = parseLoadResult(
            JSON.stringify({
                ok: true,
                repaired: true,
                summary: '1 cycles, 2 dangling roots',
                repairs: { cycles_broken: 1, dangling_roots: 2 },
            }),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.repaired).toBe(true);
            expect(r.summary).toContain('cycles');
        }
    });

    it('reads a too-new failure with both versions', () => {
        const r = parseLoadResult(
            JSON.stringify({
                ok: false,
                error: 'too_new',
                detail: 'needs 2',
                requiredVersion: 2,
                supportedVersion: 1,
            }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toBe('too_new');
            expect(r.requiredVersion).toBe(2);
            expect(r.supportedVersion).toBe(1);
        }
    });

    // The important one: anything we can't interpret must NOT read as success.
    // Treating an unparseable verdict as "loaded fine" is precisely the class of
    // bug this whole layer exists to prevent.
    it.each([
        ['garbage'],
        [''],
        ['null'],
        ['{}'],
        ['{"ok":"yes"}'],
        ['[1,2,3]'],
    ])('treats %j as a failure rather than a success', (input) => {
        const r = parseLoadResult(input);
        expect(r.ok).toBe(false);
    });
});

describe('loadErrorMessage', () => {
    const err = (error: string, extra: Record<string, unknown> = {}) =>
        parseLoadResult(
            JSON.stringify({ ok: false, error, detail: 'detail text', ...extra }),
        ) as Extract<ReturnType<typeof parseLoadResult>, { ok: false }>;

    it('tells the user to update when the file is from a newer build', () => {
        const msg = loadErrorMessage(err('too_new', { requiredVersion: 9 }), 'logo.rcbvec');
        expect(msg).toContain('logo.rcbvec');
        expect(msg).toMatch(/newer version/i);
        expect(msg).toMatch(/update/i);
        // Must reassure that nothing was destroyed — the reason we refused.
        expect(msg).toMatch(/left\s+untouched|discard/i);
    });

    it('points at version history for an empty file', () => {
        const msg = loadErrorMessage(err('empty'), 'wip.rcbvec');
        expect(msg).toMatch(/empty/i);
        expect(msg).toMatch(/version history/i);
    });

    it('reports damage for a checksum failure, including the detail', () => {
        const msg = loadErrorMessage(err('checksum'));
        expect(msg).toMatch(/damaged/i);
        expect(msg).toContain('detail text');
    });

    it('says plainly when the file is not a supported document', () => {
        expect(loadErrorMessage(err('unparseable'), 'notes.txt')).toMatch(/not a supported document/i);
    });

    it('works without a filename', () => {
        expect(loadErrorMessage(err('empty'))).toMatch(/^This file/);
    });
});

describe('repairNoticeMessage', () => {
    it('explains what happened and warns before overwriting the original', () => {
        const r = parseLoadResult(
            JSON.stringify({ ok: true, repaired: true, summary: '1 cycles', repairs: {} }),
        ) as Extract<ReturnType<typeof parseLoadResult>, { ok: true }>;
        const msg = repairNoticeMessage(r, 'art.rcbvec');
        expect(msg).toContain('art.rcbvec');
        expect(msg).toContain('1 cycles');
        expect(msg).toMatch(/nothing was deleted/i);
        expect(msg).toMatch(/before saving/i);
    });
});
