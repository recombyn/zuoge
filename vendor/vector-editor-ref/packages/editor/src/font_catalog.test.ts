/**
 * The font catalog, and the face requests it drives.
 *
 * The editor offers the whole Google Fonts library, which means it can no
 * longer assume a family has a 400 and a 700 in latin: Instrument Serif is
 * 400-only, Buda is 300-only, Molle has no upright face, and a handful of
 * families have no latin subset at all. Each of those used to cost a 404 per
 * face per session, and for the weight-less ones it meant no text on screen.
 * These tests hold the URL construction to what the CDN actually publishes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fontCatalog, lookupFont } from './font_catalog';
import { ensureFontCSS, loadGoogleFontData } from './fonts';

describe('catalog', () => {
    it('carries the whole Google Fonts library', () => {
        expect(fontCatalog().length).toBeGreaterThan(1500);
    });

    it('is sorted by family, so the list reads alphabetically', () => {
        const families = fontCatalog().map((f) => f.family);
        const sorted = [...families].sort((a, b) => a.localeCompare(b));
        expect(families).toEqual(sorted);
    });

    it('has the fonts a hardcoded list of seventeen did not', () => {
        // The bug that prompted all this: Instrument was not pickable.
        expect(lookupFont('Instrument Sans')).toBeDefined();
        expect(lookupFont('Instrument Serif')).toBeDefined();
    });

    it('looks families up regardless of case or stray space', () => {
        expect(lookupFont('  instrument SANS ')?.family).toBe('Instrument Sans');
    });

    it('is undefined for a family that was never on the CDN', () => {
        expect(lookupFont('Helvetica Neue')).toBeUndefined();
    });

    it('derives every CDN id from the family name', () => {
        for (const f of fontCatalog()) {
            expect(f.id).toBe(f.family.toLowerCase().replace(/\s+/g, '-'));
        }
    });

    it('records the real published weights and styles', () => {
        const sans = lookupFont('Instrument Sans')!;
        expect(sans.weights).toEqual([400, 500, 600, 700]);
        expect(sans.hasItalic).toBe(true);
        const serif = lookupFont('Instrument Serif')!;
        expect(serif.weights).toEqual([400]);
    });

    it('never lists a family with no weights, which could not be fetched', () => {
        for (const f of fontCatalog()) expect(f.weights.length).toBeGreaterThan(0);
    });
});

/** Capture every URL a family's load asks for. */
async function facesFetchedFor(family: string): Promise<string[]> {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
        urls.push(url);
        return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    });
    await loadGoogleFontData(family);
    return urls;
}

describe('face requests', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('asks for the four faces of a family that publishes them', async () => {
        const urls = await facesFetchedFor('Instrument Sans');
        expect(urls.map((u) => u.split('/').pop())).toEqual([
            'latin-400-normal.ttf',
            'latin-700-normal.ttf',
            'latin-400-italic.ttf',
            'latin-700-italic.ttf',
        ]);
    });

    it('does not ask for a bold a family never published', async () => {
        // Instrument Serif is 400 only — asking for 700 is a guaranteed 404.
        const urls = await facesFetchedFor('Instrument Serif');
        expect(urls.some((u) => u.includes('700'))).toBe(false);
        expect(urls.map((u) => u.split('/').pop())).toEqual([
            'latin-400-normal.ttf',
            'latin-400-italic.ttf',
        ]);
    });

    it('does not ask for an italic a family never published', async () => {
        const urls = await facesFetchedFor('Bebas Neue');
        expect(urls.some((u) => u.includes('italic'))).toBe(false);
    });

    it('snaps to the nearest weight when 400 does not exist', async () => {
        // Buda ships 300 alone; UnifrakturCook ships 700 alone. Both used to
        // fail their regular face outright and so render nothing.
        expect((await facesFetchedFor('Buda')).join()).toContain('latin-300-normal.ttf');
        expect((await facesFetchedFor('UnifrakturCook')).join()).toContain('latin-700-normal.ttf');
    });

    it('uses the italic face as the regular one for an italic-only family', async () => {
        const urls = await facesFetchedFor('Molle');
        expect(urls).toHaveLength(1);
        expect(urls[0]).toContain('latin-400-italic.ttf');
    });

    it('fetches a non-latin family from the subset it does publish', async () => {
        const urls = await facesFetchedFor('Noto Sans Lycian');
        expect(urls[0]).toContain('lycian-400-normal.ttf');
    });

    it('falls back to a blind latin 400/700 guess for an unknown family', async () => {
        // A document may name a font that has left the CDN, or arrive from a
        // build with a newer catalog. It still gets a chance to load.
        const urls = await facesFetchedFor('Some Font That Left The Cdn');
        expect(urls.map((u) => u.split('/').pop())).toEqual([
            'latin-400-normal.ttf',
            'latin-700-normal.ttf',
            'latin-400-italic.ttf',
            'latin-700-italic.ttf',
        ]);
    });
});

describe('overlay stylesheet', () => {
    beforeEach(() => {
        document.head.innerHTML = '';
    });

    const href = () => document.head.querySelector('link')!.getAttribute('href')!;

    it('requests the italic axis only for a family that has one', () => {
        ensureFontCSS('Instrument Sans');
        expect(decodeURIComponent(href())).toContain('ital,wght@0,400;0,700;1,400;1,700');
        document.head.innerHTML = '';
        // Google answers 400 Bad Request for an ital it does not publish, and
        // the overlay then shows a system face instead of the chosen font.
        ensureFontCSS('Bebas Neue');
        expect(href()).not.toContain('ital');
    });

    it('requests only weights the family publishes', () => {
        ensureFontCSS('Instrument Serif');
        expect(decodeURIComponent(href())).toContain('ital,wght@0,400;1,400');
    });

    it('adds one link per family, however often it is asked for', () => {
        ensureFontCSS('Lora');
        ensureFontCSS('Lora');
        expect(document.head.querySelectorAll('link')).toHaveLength(1);
    });
});
