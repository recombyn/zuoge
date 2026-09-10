/**
 * Font loading system for the vector editor.
 * Loads Google Fonts dynamically and registers them with CanvasKit.
 */
import type { CanvasKit } from 'canvaskit-wasm';
import { type FontMeta, lookupFont } from './font_catalog';

/**
 * Family assigned to newly created text. Needed because CanvasKit's RefDefault
 * typeface is not a sans-serif, so text created with an empty family renders in
 * a font that doesn't match the HTML edit overlay's `sans-serif` preview. Using
 * a concrete, loadable family makes the preview and the committed node agree.
 */
/**
 * Product default is Alibaba PuHuiTi (registered via apps/web kitTextFonts from
 * Noto Sans SC TTFs). Kit standalone still works: loadGoogleFontData no-ops
 * when the family is already in fontDataCache from registerEmbeddedFaces.
 */
export const DEFAULT_TEXT_FONT = 'Alibaba PuHuiTi';

/**
 * Which faces to fetch for a family, and from where.
 *
 * Not every family publishes 400 and 700: Instrument Serif is 400-only, Buda is
 * 300-only, Molle has no upright face at all. Asking the CDN for a face that
 * was never published costs a 404 per family per session and, worse, leaves the
 * family with no regular face and so no text on screen. The catalog says what
 * exists, so we ask only for that and snap each slot to the nearest real
 * weight.
 */
interface FacePlan {
    subset: string;
    regular: number;
    /** Null when the family has nothing heavier than its regular face. */
    bold: number | null;
    /** Whether to fetch a SEPARATE italic face — false for an italic-only
     *  family, whose italic is already its regular. */
    italic: boolean;
    /** True for an italic-only family, whose italic face IS its regular one. */
    italicOnly: boolean;
}

/** The weight in `weights` closest to `target`; ties go to the heavier face. */
function nearestWeight(weights: readonly number[], target: number): number {
    let best = weights[0];
    for (const w of weights) {
        if (Math.abs(w - target) <= Math.abs(best - target)) best = w;
    }
    return best;
}

/**
 * CJK families also publish a tiny `latin` face. The catalog used to prefer
 * latin whenever present, so CanvasKit registered a font with no Han glyphs
 * and committed Chinese text showed as tofu / mojibake. Prefer the script
 * subset that actually covers the writing system.
 */
const CJK_SUBSET_BY_FAMILY: Record<string, string> = {
    'Noto Sans SC': 'chinese-simplified',
    'Noto Sans TC': 'chinese-traditional',
    'Noto Sans JP': 'japanese',
    'Noto Sans KR': 'korean',
    'Noto Serif SC': 'chinese-simplified',
    'Noto Serif TC': 'chinese-traditional',
    'Noto Serif JP': 'japanese',
    'Noto Serif KR': 'korean',
};

/** Product CSS family names → CanvasKit faces come from Noto Sans SC. */
const APP_CJK_FONT_ALIASES = new Set([
    'Alibaba PuHuiTi',
    '阿里巴巴普惠体',
    '普惠体',
]);

/** Latin-only Noto SC is ~100KB; the CJK face is >1MB. */
const CJK_FACE_MIN_BYTES = 500_000;

function facePlan(meta: FontMeta | undefined, familyName?: string): FacePlan {
    // A family the catalog has never heard of — an older document, or one saved
    // after the catalog was generated — keeps the old blind guess: latin 400
    // and 700, with 404s tolerated.
    if (!meta) {
        return { subset: 'latin', regular: 400, bold: 700, italic: true, italicOnly: false };
    }
    const regular = nearestWeight(meta.weights, 400);
    const bold = nearestWeight(meta.weights, 700);
    const cjkSubset = familyName ? CJK_SUBSET_BY_FAMILY[familyName] : undefined;
    return {
        subset: cjkSubset ?? meta.subset,
        regular,
        bold: bold > regular ? bold : null,
        italic: meta.hasItalic && meta.hasNormal,
        italicOnly: !meta.hasNormal,
    };
}

/**
 * The faces of one family. Named rather than positional: these used to be a
 * bare array indexed 0 = regular, 1 = bold, which silently mis-selects as soon
 * as a family publishes some faces but not others.
 */
export interface FontFaces {
    regular: ArrayBuffer;
    bold: ArrayBuffer | null;
    italic: ArrayBuffer | null;
    boldItalic: ArrayBuffer | null;
}

/** Cache of loaded faces per family. */
const fontDataCache = new Map<string, FontFaces>();

/** Google Fonts family name → fontsource CDN id (lowercase, hyphenated). */
function fontsourceId(fontFamily: string): string {
    return fontFamily.toLowerCase().replace(/\s+/g, '-');
}

/** Set of fonts currently being loaded (to avoid duplicate fetches). */
const loadingFonts = new Set<string>();

/** Families the CDN has no face for — remembered so they aren't retried. */
const failedFonts = new Set<string>();

/** Callbacks to invoke when a font finishes loading. */
const fontLoadCallbacks: Array<() => void> = [];

/**
 * Register a callback that fires whenever a new font finishes loading.
 * The renderer uses this to trigger a repaint.
 */
export function onFontLoaded(cb: () => void) {
    fontLoadCallbacks.push(cb);
}

/**
 * Ensure a Google Font CSS link is added to the document head
 * (so the inline text editor uses the correct font).
 *
 * The requested axes come from the catalog: Google's css2 endpoint answers 400
 * Bad Request — and the overlay then falls back to a system face — for an
 * `ital` it does not publish, so asking every family for italic is not an
 * option.
 */
export function ensureFontCSS(fontFamily: string) {
    // Product CJK aliases are CSS-only on the app side; Google has no face
    // under these names (overlay would fall back anyway).
    if (APP_CJK_FONT_ALIASES.has(fontFamily)) return;
    const linkId = `gfont-${fontFamily.replace(/\s+/g, '-')}`;
    if (document.getElementById(linkId)) return;
    const meta = lookupFont(fontFamily);
    const weights = meta
        ? [...new Set([nearestWeight(meta.weights, 400), nearestWeight(meta.weights, 700)])]
        : [400, 700];
    const axes = meta?.hasItalic
        ? `ital,wght@${[
              ...(meta.hasNormal ? weights.map((w) => `0,${w}`) : []),
              ...weights.map((w) => `1,${w}`),
          ].join(';')}`
        : `wght@${weights.join(';')}`;
    const link = document.createElement('link');
    link.id = linkId;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:${axes}&display=swap`;
    document.head.appendChild(link);
}

/**
 * Make one family renderable in ordinary HTML, cheaply, for previewing it in a
 * list.
 *
 * `ensureFontCSS` is the wrong tool for a font picker: it adds a stylesheet
 * link per family, and scrolling a two-thousand-family list would leave that
 * many <link> elements and Google round-trips in the document. This registers a
 * single face straight from the same CDN the editor already fetches from.
 */
const previewFaces = new Set<string>();
export function ensurePreviewFace(fontFamily: string): void {
    if (previewFaces.has(fontFamily) || fontDataCache.has(fontFamily)) return;
    previewFaces.add(fontFamily);
    const meta = lookupFont(fontFamily);
    if (!meta || typeof FontFace === 'undefined') return;
    const plan = facePlan(meta, fontFamily);
    const style = plan.italicOnly ? 'italic' : 'normal';
    const url = `https://cdn.jsdelivr.net/fontsource/fonts/${meta.id}@latest/${plan.subset}-${plan.regular}-${style}.woff2`;
    try {
        const face = new FontFace(fontFamily, `url(${url})`, {
            weight: String(plan.regular),
            style,
            display: 'swap',
        });
        face.load()
            .then((f) => document.fonts.add(f))
            .catch(() => {
                /* a preview that won't load just renders in the fallback face */
            });
    } catch {
        /* ignore — preview only */
    }
}

/**
 * Load a Google Font's binary data (for CanvasKit registration).
 * Fetches the CSS, extracts the font file URL, downloads it.
 * Returns the ArrayBuffer, or null if loading fails.
 */
export async function loadGoogleFontData(fontFamily: string): Promise<ArrayBuffer | null> {
    // Product default family: mirror Noto Sans SC (CJK) under the CSS name.
    if (APP_CJK_FONT_ALIASES.has(fontFamily)) {
        if (fontDataCache.has(fontFamily)) {
            return fontDataCache.get(fontFamily)!.regular;
        }
        if (failedFonts.has(fontFamily)) return null;
        let source = await loadGoogleFontData('Noto Sans SC');
        // Concurrent Noto fetch returns null while in-flight — wait for it.
        if (!source && !fontDataCache.has('Noto Sans SC')) {
            await fontsSettled();
            source = fontDataCache.get('Noto Sans SC')?.regular ?? null;
        }
        const faces = fontDataCache.get('Noto Sans SC');
        if (!source || !faces) {
            failedFonts.add(fontFamily);
            return null;
        }
        fontDataCache.set(fontFamily, {
            regular: faces.regular,
            bold: faces.bold,
            italic: faces.italic,
            boldItalic: faces.boldItalic,
        });
        failedFonts.delete(fontFamily);
        for (const cb of fontLoadCallbacks) cb();
        return faces.regular;
    }

    // Drop a previously cached latin-only CJK face so a reload picks the
    // script subset (latin Noto SC is ~35KB; CJK is ~2.5MB).
    if (CJK_SUBSET_BY_FAMILY[fontFamily] && fontDataCache.has(fontFamily)) {
        const cached = fontDataCache.get(fontFamily)!;
        if (cached.regular.byteLength < CJK_FACE_MIN_BYTES) {
            fontDataCache.delete(fontFamily);
            failedFonts.delete(fontFamily);
            // Aliases were copied from the latin face — drop them too.
            for (const alias of APP_CJK_FONT_ALIASES) {
                fontDataCache.delete(alias);
                failedFonts.delete(alias);
            }
        }
    }

    if (fontDataCache.has(fontFamily)) return fontDataCache.get(fontFamily)!.regular;
    if (loadingFonts.has(fontFamily)) return null; // already in progress
    // A family the CDN doesn't have must be remembered as absent. The renderer
    // asks for any unloaded family of every text node it draws, so without this
    // a document naming an unavailable font re-issues a failing request on
    // EVERY frame, forever.
    if (failedFonts.has(fontFamily)) return null;

    loadingFonts.add(fontFamily);
    ensureFontCSS(fontFamily); // still needed for the HTML edit overlay (woff2 is fine there)

    try {
        // Fetch raw TTFs, NOT the Google Fonts CSS: for a modern browser
        // User-Agent that CSS resolves to woff2, which CanvasKit/FreeType can't
        // decode (renders tofu). The fontsource CDN serves plain TTF that
        // CanvasKit registers correctly.
        const id = fontsourceId(fontFamily);
        const plan = facePlan(lookupFont(fontFamily), fontFamily);
        const url = (w: number, style: 'normal' | 'italic') =>
            `https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${plan.subset}-${w}-${style}.ttf`;
        const fetchTtf = async (
            w: number | null,
            style: 'normal' | 'italic',
        ): Promise<ArrayBuffer | null> => {
            if (w === null) return null;
            try {
                const resp = await fetch(url(w, style));
                return resp.ok ? await resp.arrayBuffer() : null;
            } catch {
                return null;
            }
        };
        // Italic faces are fetched too: the renderer asks the paragraph API for
        // a slant, and without an italic face registered there is nothing for
        // it to select, so `italic: true` silently renders upright. Not every
        // family publishes one (Bebas Neue, for instance), hence the nulls.
        //
        // An italic-only family (Molle) has no upright face to fetch at all, so
        // its italic IS its regular — otherwise it would fail as unavailable.
        const upright = plan.italicOnly ? 'italic' : 'normal';
        const [regular, bold, italic, boldItalic] = await Promise.all([
            fetchTtf(plan.regular, upright),
            fetchTtf(plan.bold, upright),
            fetchTtf(plan.italic ? plan.regular : null, 'italic'),
            fetchTtf(plan.italic ? plan.bold : null, 'italic'),
        ]);
        if (!regular) throw new Error('no TTF for regular weight');

        fontDataCache.set(fontFamily, { regular, bold, italic, boldItalic });
        loadingFonts.delete(fontFamily);

        // Notify listeners (renderer repaints)
        for (const cb of fontLoadCallbacks) cb();

        return regular;
    } catch (err) {
        console.warn(`[fonts] Failed to load "${fontFamily}":`, err);
        loadingFonts.delete(fontFamily);
        failedFonts.add(fontFamily);
        return null;
    }
}

/**
 * Build a CanvasKit TypefaceFontProvider with all currently loaded fonts.
 * Returns null if no custom fonts have been loaded yet.
 */
export function buildFontProvider(
    ck: CanvasKit,
): ReturnType<CanvasKit['TypefaceFontProvider']['Make']> | null {
    if (fontDataCache.size === 0) return null;
    const provider = ck.TypefaceFontProvider.Make();
    for (const [name, faces] of fontDataCache) {
        // All faces register under the SAME family name; the paragraph API
        // picks between them using each face's own weight/slant metadata.
        for (const data of [faces.regular, faces.bold, faces.italic, faces.boldItalic]) {
            if (data) provider.registerFont(data, name);
        }
    }
    return provider;
}

/**
 * Resolve once no font load is in flight.
 *
 * Font loading is async, but an agent's loop is create-then-render with no
 * pause in between — so without this, the first render after adding text
 * always shows the fallback face, and an agent judging its own work from that
 * image draws the wrong conclusion about weight and shape. Rendering awaits
 * this; interactive use doesn't need to, because a human's next frame comes
 * long after the fetch.
 *
 * Waits are bounded: a family that 404s or a machine that is offline must
 * degrade to the fallback face, not hang the render.
 */
export async function fontsSettled(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (loadingFonts.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
    }
}

/** Check if a font's binary data is already cached. */
export function isFontLoaded(fontFamily: string): boolean {
    return fontDataCache.has(fontFamily);
}

/** Get cached font data — the regular weight (or null). */
export function getFontData(fontFamily: string): ArrayBuffer | null {
    return fontDataCache.get(fontFamily)?.regular ?? null;
}

/** Get cached font data for a weight/slant, falling back to the nearest face
 *  the family actually publishes. Null if the family isn't loaded. */
export function getFontDataForWeight(
    fontFamily: string,
    weight: number,
    italic = false,
): ArrayBuffer | null {
    const faces = fontDataCache.get(fontFamily);
    if (!faces) return null;
    const wantBold = weight >= 600;
    if (wantBold && italic) return faces.boldItalic ?? faces.bold ?? faces.italic ?? faces.regular;
    if (wantBold) return faces.bold ?? faces.regular;
    if (italic) return faces.italic ?? faces.regular;
    return faces.regular;
}

// ─── Document embedding ─────────────────────────────────────────────────────
//
// A saved document embeds the faces its text uses, so it renders identically
// offline and stays correct if the CDN later reissues a family with different
// metrics. These two functions are the save and load ends of that.

/**
 * The bytes for one face, fetching the family first if it isn't loaded yet.
 * Used when saving, to embed exactly the faces the document needs.
 */
export async function getFaceBytes(
    fontFamily: string,
    weight: number,
    italic = false,
): Promise<ArrayBuffer | null> {
    if (!fontDataCache.has(fontFamily)) {
        await loadGoogleFontData(fontFamily);
        // `loadGoogleFontData` returns null while a fetch is already in flight
        // for this family, so wait for whichever request is running to land
        // rather than reporting the face as unavailable.
        await fontsSettled();
    }
    return getFontDataForWeight(fontFamily, weight, italic);
}

/** One face as embedded in a document. */
export interface EmbeddedFace {
    family: string;
    weight: number;
    italic: boolean;
    bytes: ArrayBuffer;
}

/**
 * Register faces carried inside a document, so its text renders correctly with
 * no network round-trip.
 *
 * Embedded faces take precedence over anything the CDN would serve: the whole
 * point is that the document looks the way its author saw it. Returns the
 * number of families affected, so the caller knows whether to rebuild the
 * renderer's font provider.
 */
export function registerEmbeddedFaces(faces: EmbeddedFace[]): number {
    const touched = new Set<string>();
    for (const face of faces) {
        if (!face.bytes || face.bytes.byteLength === 0) continue;
        const existing = fontDataCache.get(face.family) ?? {
            regular: face.bytes,
            bold: null,
            italic: null,
            boldItalic: null,
        };
        const slot: keyof FontFaces =
            face.weight >= 600
                ? face.italic
                    ? 'boldItalic'
                    : 'bold'
                : face.italic
                  ? 'italic'
                  : 'regular';
        existing[slot] = face.bytes;
        fontDataCache.set(face.family, existing);
        // A family that previously 404'd may well be embedded here; clear the
        // negative cache so it is no longer treated as unavailable.
        failedFonts.delete(face.family);
        touched.add(face.family);
    }
    if (touched.size) {
        for (const cb of fontLoadCallbacks) cb();
    }
    return touched.size;
}
