/**
 * Where a rectangle's corner-radius handles sit, and how close a press has to
 * be to count as grabbing one.
 *
 * One module because the answer has to be the SAME for the renderer that draws
 * the dots and the input layer that reads the press. When they disagreed, the
 * grab zones were three times the size of the dots that advertised them and
 * met in the middle of the shape: on a 40×40 rectangle at 100% every point but
 * the exact centre rounded the corners instead of moving it — a drag meant to
 * shift a small square turned it into a circle and left it where it was. The
 * shape looked ordinary; only the handles told you, and they are 3.5px dots.
 *
 * The rules, all in SCREEN pixels (so they hold at every zoom):
 *   - the handles sit `INSET` in from each corner, or at the radius if it is
 *     further in, never past the middle;
 *   - a press grabs one within `REACH`, but the four zones may only reach
 *     halfway to the centre, so a band down the middle of the shape always
 *     MOVES it;
 *   - below `MIN_REACH` of usable room the shape is too small to carry a
 *     control worth aiming at, and gets none — drawn or grabbable. The corner
 *     radius is still on the properties panel, and zooming in brings the
 *     handles back.
 *   - large radii used to drive `room` → 0 and hide every handle (looked like
 *     the dots vanished at max roundness). Keep a screen-constant centre gap
 *     so the control stays parked just inside the rounded corner.
 */

/** Distance in from each corner where a handle rests, in screen pixels. */
const INSET = 14;
/** How far a press may be from a handle and still grab it, in screen pixels. */
const REACH = 6;
/** Less usable room than this (screen px) and the shape carries no handles. */
const MIN_REACH = 2;
/** Keep this much screen-px between a parked handle and the box centre. */
const CENTER_GAP = 8;

export interface CornerHandles {
    /** Handle centres in the rectangle's local space, clockwise from top-left. */
    positions: [number, number][];
    /** Half-width of a handle's square grab zone, in local units. */
    reach: number;
}

/**
 * The corner-radius handles of a `width`×`height` rectangle drawn at `zoom`,
 * or null when it is too small to carry any. Returned in the rectangle's own
 * coordinate space, so a rotated or scaled shape needs no special case.
 */
export function cornerRadiusHandles(
    width: number,
    height: number,
    radius: number,
    zoom: number,
): CornerHandles | null {
    if (!(width > 0) || !(height > 0)) return null;

    const z = Math.max(1e-6, zoom);
    const inset = INSET / z;
    const centerGap = CENTER_GAP / z;
    // Cap park so a near-pill radius never collapses the handle into the centre
    // (and never fails the reach check below — that used to erase the dots).
    const maxRx = Math.max(inset, width / 2 - centerGap);
    const maxRy = Math.max(inset, height / 2 - centerGap);
    if (maxRx < inset - 1e-6 || maxRy < inset - 1e-6) return null;

    const rx = Math.min(Math.max(radius, inset), maxRx);
    const ry = Math.min(Math.max(radius, inset), maxRy);

    // What is left between a handle and the shape's centre.
    const room = Math.min(width / 2 - rx, height / 2 - ry);
    const reach = Math.min(REACH / z, Math.max(room / 2, MIN_REACH / z));
    if (reach < MIN_REACH / z - 1e-9) return null;

    return {
        positions: [
            [rx, ry],
            [width - rx, ry],
            [width - rx, height - ry],
            [rx, height - ry],
        ],
        reach,
    };
}

/** True if a point in the rectangle's local space grabs one of its handles. */
export function grabsCornerHandle(h: CornerHandles, lx: number, ly: number): boolean {
    return h.positions.some(
        ([hx, hy]) => Math.abs(lx - hx) < h.reach && Math.abs(ly - hy) < h.reach,
    );
}
