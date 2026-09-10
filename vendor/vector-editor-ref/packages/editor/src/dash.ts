/**
 * dash.ts — how a stroke's `dash_array` becomes an actual dash pattern.
 *
 * One rule, in one place, because two things have to agree about it: the
 * renderer, which draws the dashes, and Outline Stroke, which converts them to
 * filled geometry. If those two ever disagree, Flatten silently redraws the
 * artwork — and the difference only shows up after the fact.
 */

/**
 * The interval list to hand to Skia, or null when the stroke isn't dashed.
 *
 * Follows SVG's rules, which the engine's model inherits:
 *  - an empty array, a negative or non-finite entry, or intervals summing to
 *    zero is not a dash — the stroke is solid;
 *  - an odd number of intervals repeats doubled, so "5" means 5 on, 5 off.
 *    (Skia requires an even count anyway, so this is not merely cosmetic.)
 */
export function dashIntervals(dashArray: readonly number[] | undefined | null): number[] | null {
    if (!dashArray || dashArray.length === 0) return null;
    if (dashArray.some((n) => !Number.isFinite(n) || n < 0)) return null;
    let sum = 0;
    for (const n of dashArray) sum += n;
    if (sum <= 0) return null;
    return dashArray.length % 2 === 1 ? [...dashArray, ...dashArray] : [...dashArray];
}
