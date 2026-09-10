/**
 * Convert a text node to vector outlines ("Create Outlines").
 *
 * This CanvasKit build's Font API can't emit per-glyph outlines
 * (`getGlyphPaths` is missing), so we parse the same TTF the renderer uses with
 * opentype.js and build the glyph paths in JS. The result is converted to the
 * engine's Subpath format (reusing the tested CanvasKit path→Subpath decoder)
 * so it becomes a normal, editable Path node.
 */
import type { CanvasKit } from 'canvaskit-wasm';
import * as opentype from 'opentype.js';
import { pathToSubpaths } from './boolean_ops';
import { fontsSettled, getFontDataForWeight, isFontLoaded, loadGoogleFontData } from './fonts';
import type { Subpath, TextGeometry } from './types';

/** Parsed opentype fonts, keyed by `${family}@${weight >= 600 ? 'bold' : 'regular'}`. */
const parsedFontCache = new Map<string, opentype.Font | null>();

/** Family used when a text node has no explicit font (renderer falls back to a
 *  sans-serif default; we outline with Roboto, the closest freely-available match). */
const DEFAULT_OUTLINE_FAMILY = 'Roboto';

function cacheKey(family: string, weight: number): string {
    return `${family}@${weight >= 600 ? 'bold' : 'regular'}`;
}

/**
 * Ensure the opentype font for a family+weight is loaded and parsed. Fetches the
 * TTF via the shared font loader if it isn't cached yet. Returns null if the
 * font can't be loaded or parsed.
 */
export async function ensureOutlineFont(
    fontFamily: string | undefined,
    weight: number,
    italic = false,
): Promise<opentype.Font | null> {
    const family = fontFamily?.trim() ? fontFamily : DEFAULT_OUTLINE_FAMILY;
    // Italic is part of the identity of the face being parsed: outlining
    // italic text with the upright face would silently straighten it.
    const key = `${cacheKey(family, weight)}${italic ? ':italic' : ''}`;
    if (parsedFontCache.has(key)) return parsedFontCache.get(key)!;

    // Make sure the TTF bytes are cached (loadGoogleFontData is a no-op if so).
    if (!isFontLoaded(family)) {
        // loadGoogleFontData returns null IMMEDIATELY when a load for this
        // family is already in flight — it doesn't join it. Without waiting for
        // that load to settle we'd read no data and cache the failure below
        // permanently, silently disabling outlines for this family for the rest
        // of the session. Creating text starts a load, so the overlap is
        // routine, not rare.
        await loadGoogleFontData(family);
        await fontsSettled();
    }
    const data = getFontDataForWeight(family, weight, italic);
    if (!data) {
        parsedFontCache.set(key, null);
        return null;
    }
    try {
        const font = opentype.parse(data);
        parsedFontCache.set(key, font);
        return font;
    } catch {
        parsedFontCache.set(key, null);
        return null;
    }
}

/**
 * Build vector outlines for a text node's glyphs, in the node's local space
 * (matching how the renderer draws the paragraph: top at y = -fontSize, origin
 * at x = 0 for left-aligned text). Returns the engine Subpath list.
 */
export function textToSubpaths(font: opentype.Font, geo: TextGeometry, ck: CanvasKit): Subpath[] {
    const fontSize = geo.font_size;
    const lineHeight = geo.line_height || 1.2;
    const align = geo.text_align || 0; // 0 left, 1 center, 2 right
    const lines = (geo.content || '').split('\n');
    // Node stores letter-spacing in world units (same as the renderer's).
    const letterSpacing = geo.letter_spacing || 0;
    const scale = fontSize / font.unitsPerEm;

    // First-baseline offset from the paragraph top. Skia scales the line box to
    // fontSize·lineHeight and places the baseline at the ascent fraction of it.
    const asc = font.ascender / font.unitsPerEm;
    const desc = -font.descender / font.unitsPerEm; // descender is negative
    const firstBaselineFromTop = (asc / (asc + desc)) * fontSize * lineHeight;
    const baseline0 = -fontSize + firstBaselineFromTop;

    // Build glyphs per-character rather than via font.getPath(text): opentype.js's
    // text-shaping path (ccmp/GSUB) throws on some fonts (e.g. Inter uses an
    // unsupported substFormat). We resolve glyphs directly and apply simple
    // horizontal kerning, which matches the rendered advances closely.
    const advanceOf = (line: string): number => {
        let x = 0;
        let prev: opentype.Glyph | null = null;
        for (const ch of line) {
            const glyph = font.charToGlyph(ch);
            if (prev) x += font.getKerningValue(prev, glyph) * scale;
            x += (glyph.advanceWidth || 0) * scale + letterSpacing;
            prev = glyph;
        }
        return x;
    };

    // Block width = widest line, so center/right alignment stays within the same
    // box the selection frame reports (see renderer.getTextLocalBounds).
    const lineWidths = lines.map((l) => (l ? advanceOf(l) : 0));
    const blockWidth = Math.max(0, ...lineWidths);
    const blockOffsetX = align === 1 ? -blockWidth / 2 : align === 2 ? -blockWidth : 0;

    let combined = '';
    try {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const lineW = lineWidths[i];
            // Align each line within the block.
            const lineStartX =
                blockOffsetX +
                (align === 1 ? (blockWidth - lineW) / 2 : align === 2 ? blockWidth - lineW : 0);
            const y = baseline0 + i * fontSize * lineHeight;
            let penX = lineStartX;
            let prev: opentype.Glyph | null = null;
            for (const ch of line) {
                const glyph = font.charToGlyph(ch);
                if (prev) penX += font.getKerningValue(prev, glyph) * scale;
                const gp = glyph.getPath(penX, y, fontSize);
                const d = gp.toPathData(3);
                if (d) combined += (combined ? ' ' : '') + d;
                penX += (glyph.advanceWidth || 0) * scale + letterSpacing;
                prev = glyph;
            }
        }
    } catch {
        // Bail gracefully so the caller leaves the node as text rather than crashing.
        return [];
    }
    if (!combined) return [];

    const ckPath = ck.Path.MakeFromSVGString(combined);
    if (!ckPath) return [];
    try {
        return pathToSubpaths(ck, ckPath);
    } finally {
        ckPath.delete();
    }
}

/**
 * Convenience: parse the font (async) then build outlines for a text node.
 * Returns null if the font can't be loaded — callers should leave the node as
 * text in that case.
 */
export async function textNodeToSubpaths(
    geo: TextGeometry,
    ck: CanvasKit,
): Promise<Subpath[] | null> {
    const font = await ensureOutlineFont(
        geo.font_family,
        geo.font_weight || 400,
        geo.italic ?? false,
    );
    if (!font) return null;
    return textToSubpaths(font, geo, ck);
}
