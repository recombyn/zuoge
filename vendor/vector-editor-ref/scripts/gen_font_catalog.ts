/**
 * Regenerate `packages/editor/src/font_catalog.ts` from the Fontsource API.
 *
 *     node --experimental-strip-types scripts/gen_font_catalog.ts
 *
 * The catalog is CHECKED IN rather than fetched at runtime. The editor must
 * open its font list offline and with no third-party API on the critical path,
 * and a list that shifts under the user between sessions is worse than one that
 * moves when we say so. Re-run this when Google publishes families worth having
 * (it is idempotent — the diff is the new families).
 *
 * Fontsource is the source of truth because it is also what `fonts.ts` fetches
 * faces from: its per-family weights/styles/subsets say exactly which files
 * exist on the CDN, which Google's own metadata does not.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.fontsource.org/v1/fonts?type=google';
const OUT = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'packages',
    'editor',
    'src',
    'font_catalog.ts',
);

/** Category order — mirrored in the generated file, so it is an index there. */
const CATEGORIES = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace', 'icons'];

interface ApiFont {
    id: string;
    family: string;
    subsets: string[];
    weights: number[];
    styles: string[];
    defSubset: string;
    category: string;
}

const resp = await fetch(API);
if (!resp.ok) throw new Error(`fontsource API ${resp.status} ${resp.statusText}`);
const fonts = (await resp.json()) as ApiFont[];
if (!Array.isArray(fonts) || fonts.length < 1000) {
    throw new Error(`suspiciously short catalog (${fonts?.length}) — refusing to overwrite`);
}

const rows: string[] = [];
const skipped: string[] = [];
for (const f of fonts.sort((a, b) => a.family.localeCompare(b.family))) {
    // The id is what builds a CDN path, and `fonts.ts` derives it from the
    // family name. Any family where that derivation disagrees with the real id
    // would 404 at load time, so drop it here rather than offer a dead entry.
    if (f.family.toLowerCase().replace(/\s+/g, '-') !== f.id) {
        skipped.push(`${f.family} (id ${f.id})`);
        continue;
    }
    if (f.family.includes('|')) {
        skipped.push(`${f.family} (pipe in name)`);
        continue;
    }
    const cat = CATEGORIES.indexOf(f.category);
    if (cat < 0) {
        skipped.push(`${f.family} (category ${f.category})`);
        continue;
    }
    // Weights are 100–900 in hundreds throughout Google Fonts, so one digit
    // each keeps the whole catalog a couple of characters per family.
    const weights = [...new Set(f.weights)]
        .filter((w) => w >= 100 && w <= 900 && w % 100 === 0)
        .sort((a, b) => a - b)
        .map((w) => w / 100)
        .join('');
    if (!weights) {
        skipped.push(`${f.family} (no usable weight)`);
        continue;
    }
    const styles =
        (f.styles.includes('normal') ? 'n' : '') + (f.styles.includes('italic') ? 'i' : '');
    // Prefer a CJK script subset when present — latin-only faces make Han
    // glyphs tofu in CanvasKit. Otherwise empty means latin (see parser).
    const CJK_SUBSETS = [
        'chinese-simplified',
        'chinese-traditional',
        'japanese',
        'korean',
    ];
    const cjkSubset = f.subsets.find((s) => CJK_SUBSETS.includes(s));
    const subset = cjkSubset
        ? cjkSubset
        : f.subsets.includes('latin')
          ? ''
          : f.defSubset;
    rows.push(`${f.family}|${cat}|${weights}|${styles}|${subset}`);
}

const file = `/**
 * The Google Fonts catalog, as served by the Fontsource CDN.
 *
 * GENERATED FILE — do not edit by hand. Run \`scripts/gen_font_catalog.ts\` to
 * refresh it. Generated ${new Date().toISOString().slice(0, 10)} from ${rows.length} families.
 *
 * Stored as one packed line per family rather than an array of objects: at this
 * size the object literal costs a few hundred KB of source and a parse on every
 * load, while the packed form is a single string the module splits once, the
 * first time anything asks for a font.
 *
 * Line format: \`family|category|weights|styles|subset\`
 *   category  index into FONT_CATEGORIES
 *   weights   one digit per hundred, ascending — "4567" is 400/500/600/700
 *   styles    "n", "i", or "ni"
 *   subset    the subset to fetch faces from; empty means latin
 */

/** Category names, in the order the packed \`category\` index refers to. */
export const FONT_CATEGORIES = [
    'sans-serif',
    'serif',
    'display',
    'handwriting',
    'monospace',
    'icons',
] as const;

export type FontCategory = (typeof FONT_CATEGORIES)[number];

/** One family: what it is called, and which faces actually exist for it. */
export interface FontMeta {
    /** Display name, e.g. "Instrument Sans". */
    family: string;
    /** Fontsource CDN id, e.g. "instrument-sans". */
    id: string;
    category: FontCategory;
    /** Published weights, ascending. Never empty. */
    weights: number[];
    hasNormal: boolean;
    hasItalic: boolean;
    /** Subset the faces are fetched from — "latin" for all but a handful. */
    subset: string;
}

const PACKED = \`\\
${rows.join('\n')}\`;

let catalog: FontMeta[] | null = null;
let byFamily: Map<string, FontMeta> | null = null;

function parse(): FontMeta[] {
    if (catalog) return catalog;
    const list: FontMeta[] = [];
    const index = new Map<string, FontMeta>();
    for (const line of PACKED.split('\\n')) {
        const [family, cat, weights, styles, subset] = line.split('|');
        const meta: FontMeta = {
            family,
            id: family.toLowerCase().replace(/\\s+/g, '-'),
            category: FONT_CATEGORIES[Number(cat)] ?? 'sans-serif',
            weights: [...weights].map((d) => Number(d) * 100),
            hasNormal: styles.includes('n'),
            hasItalic: styles.includes('i'),
            subset: subset || 'latin',
        };
        list.push(meta);
        index.set(meta.family.toLowerCase(), meta);
    }
    catalog = list;
    byFamily = index;
    return list;
}

/** Every family, sorted by name. Parsed on first call, then cached. */
export function fontCatalog(): readonly FontMeta[] {
    return parse();
}

/**
 * Look up a family by name, case-insensitively.
 *
 * Undefined for anything not in the catalog — a document may name a font that
 * was never on the CDN, or one embedded by its author — so callers must treat
 * a miss as "unknown", not "invalid".
 */
export function lookupFont(family: string): FontMeta | undefined {
    parse();
    return byFamily!.get(family.trim().toLowerCase());
}
`;

writeFileSync(OUT, file);
console.log(`wrote ${OUT}: ${rows.length} families, ${(file.length / 1024) | 0}KB`);
if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join(', ')}`);
