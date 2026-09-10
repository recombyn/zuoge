/**
 * Inline Lucide icon SVG helper.
 *
 * Returns raw `<svg>…</svg>` strings sized for the context they appear in.
 * All icons come from the Lucide icon set (https://lucide.dev) to match
 * the toolbar icons already loaded via the CDN.
 *
 * By generating SVG strings we can drop them into `innerHTML` and
 * `textContent` sites where the old emoji characters were used,
 * without needing React or a DOM-diffing library.
 */

// ─── SVG wrapper ─────────────────────────────────────────────────
function svg(inner: string, size: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;">${inner}</svg>`;
}

// ─── Lucide icon paths ───────────────────────────────────────────

/** Folder icon – for Group nodes in the layer panel */
export function iconFolder(size = 14): string {
    return svg(
        '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
        size,
    );
}

/** Frame icon – for Artboards */
export function iconFrame(size = 14): string {
    return svg(
        '<line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/><line x1="8" y1="4" x2="8" y2="20"/><line x1="16" y1="4" x2="16" y2="20"/>',
        size,
    );
}

/** Square icon – for Rect nodes */
export function iconSquare(size = 14): string {
    return svg('<rect width="18" height="18" x="3" y="3" rx="2"/>', size);
}

/** Circle icon – for Ellipse nodes */
export function iconCircle(size = 14): string {
    return svg('<circle cx="12" cy="12" r="10"/>', size);
}

/** Pen-tool icon – for Path nodes */
export function iconPenTool(size = 14): string {
    return svg(
        '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        size,
    );
}

/** Type icon – for Text nodes */
export function iconType(size = 14): string {
    return svg(
        '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
        size,
    );
}

/** Hexagon icon – generic shape fallback */
export function iconHexagon(size = 14): string {
    return svg(
        '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>',
        size,
    );
}

/** Eye icon – visible layer */
export function iconEye(size = 12): string {
    return svg(
        '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
        size,
    );
}

/** Eye-off icon – hidden layer */
export function iconEyeOff(size = 12): string {
    return svg(
        '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>',
        size,
    );
}

/** Lock icon – locked layer */
export function iconLock(size = 12): string {
    return svg(
        '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        size,
    );
}

/** Unlock icon – unlocked layer */
export function iconUnlock(size = 12): string {
    return svg(
        '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
        size,
    );
}

/** Undo icon */
export function iconUndo(size = 14): string {
    return svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>', size);
}

/** Redo icon */
export function iconRedo(size = 14): string {
    return svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>', size);
}

/** Pencil / edit icon – for Edit Path */
export function iconPencil(size = 14): string {
    return svg(
        '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
        size,
    );
}

/** Trash icon – for Delete actions */
export function iconTrash(size = 14): string {
    return svg(
        '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
        size,
    );
}

/** Home icon – for breadcrumb root/canvas */
export function iconHome(size = 14): string {
    return svg(
        '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
        size,
    );
}

/** Chevron-right icon – for breadcrumb separator */
export function iconChevronRight(size = 10): string {
    return svg('<path d="m9 18 6-6-6-6"/>', size);
}

/** Dot/circle-dot icon – for path editing breadcrumb */
export function iconCircleDot(size = 14): string {
    return svg('<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="1"/>', size);
}

// ─── Alignment icons ─────────────────────────────────────────────

/** Align left – items flush to left edge */
export function iconAlignLeft(size = 14): string {
    return svg(
        '<line x1="4" x2="4" y1="2" y2="22"/><rect x="9" y="6" width="11" height="4" rx="1"/><rect x="9" y="14" width="7" height="4" rx="1"/>',
        size,
    );
}

/** Align center horizontal */
export function iconAlignCenterH(size = 14): string {
    return svg(
        '<line x1="12" x2="12" y1="2" y2="22"/><rect x="5" y="6" width="14" height="4" rx="1"/><rect x="7" y="14" width="10" height="4" rx="1"/>',
        size,
    );
}

/** Align right – items flush to right edge */
export function iconAlignRight(size = 14): string {
    return svg(
        '<line x1="20" x2="20" y1="2" y2="22"/><rect x="4" y="6" width="11" height="4" rx="1"/><rect x="8" y="14" width="7" height="4" rx="1"/>',
        size,
    );
}

/** Align top – items flush to top edge */
export function iconAlignTop(size = 14): string {
    return svg(
        '<line x1="2" x2="22" y1="4" y2="4"/><rect x="6" y="9" width="4" height="11" rx="1"/><rect x="14" y="9" width="4" height="7" rx="1"/>',
        size,
    );
}

/** Align center vertical */
export function iconAlignCenterV(size = 14): string {
    return svg(
        '<line x1="2" x2="22" y1="12" y2="12"/><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="7" width="4" height="10" rx="1"/>',
        size,
    );
}

/** Align bottom – items flush to bottom edge */
export function iconAlignBottom(size = 14): string {
    return svg(
        '<line x1="2" x2="22" y1="20" y2="20"/><rect x="6" y="4" width="4" height="11" rx="1"/><rect x="14" y="8" width="4" height="7" rx="1"/>',
        size,
    );
}

// ─── Distribution icons ──────────────────────────────────────────

/** Distribute horizontal spacing */
export function iconDistributeH(size = 14): string {
    return svg(
        '<rect x="4" y="5" width="4" height="14" rx="1"/><rect x="14" y="7" width="4" height="10" rx="1"/><line x1="1" x2="1" y1="2" y2="22"/><line x1="23" x2="23" y1="2" y2="22"/>',
        size,
    );
}

/** Distribute vertical spacing */
export function iconDistributeV(size = 14): string {
    return svg(
        '<rect x="5" y="4" width="14" height="4" rx="1"/><rect x="7" y="14" width="10" height="4" rx="1"/><line x1="2" x2="22" y1="1" y2="1"/><line x1="2" x2="22" y1="23" y2="23"/>',
        size,
    );
}

// ─── Boolean operation icons ─────────────────────────────────────
// Standard two-overlapping-rounded-rectangle convention (Figma/Sketch style).
// Back shape sits top-left, front shape sits bottom-right.
// The filled area shows the operation result.

/** Union – entire combined area filled */
export function iconBoolUnion(size = 14): string {
    return svg(
        '<rect x="2" y="2" width="14" height="14" rx="4" fill="currentColor" stroke="none"/>' +
            '<rect x="8" y="8" width="14" height="14" rx="4" fill="currentColor" stroke="none"/>' +
            '<rect x="2" y="2" width="14" height="14" rx="4" fill="none"/>' +
            '<rect x="8" y="8" width="14" height="14" rx="4" fill="none"/>',
        size,
    );
}

/** Subtract – back shape minus the overlap */
export function iconBoolSubtract(size = 14): string {
    return svg(
        '<path d="M6 2a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h2v-4a4 4 0 0 1 4-4h4V6a4 4 0 0 0-4-4H6Z" fill="currentColor" stroke="none"/>' +
            '<rect x="2" y="2" width="14" height="14" rx="4" fill="none"/>' +
            '<rect x="8" y="8" width="14" height="14" rx="4" fill="none" stroke-dasharray="3 2"/>',
        size,
    );
}

/** Intersect – only the overlap area filled */
export function iconBoolIntersect(size = 14): string {
    return svg(
        '<path d="M12 8H8v4a4 4 0 0 0 4 4h4v-4a4 4 0 0 0-4-4Z" fill="currentColor" stroke="none"/>' +
            '<rect x="2" y="2" width="14" height="14" rx="4" fill="none"/>' +
            '<rect x="8" y="8" width="14" height="14" rx="4" fill="none"/>',
        size,
    );
}

/** Exclude – everything except the overlap filled */
export function iconBoolExclude(size = 14): string {
    return svg(
        '<path d="M6 2a4 4 0 0 0-4 4v8a4 4 0 0 0 4 4h2v-4a4 4 0 0 1 4-4h4V6a4 4 0 0 0-4-4H6Z" fill="currentColor" stroke="none"/>' +
            '<path d="M18 22a4 4 0 0 0 4-4v-8a4 4 0 0 0-4-4h-2v4a4 4 0 0 1-4 4H8v6a4 4 0 0 0 4 4h6Z" fill="currentColor" stroke="none"/>' +
            '<path d="M12 8H8v4a4 4 0 0 0 4 4h4v-4a4 4 0 0 0-4-4Z" fill="var(--bg-panel, #2a2a2a)" stroke="none"/>' +
            '<rect x="2" y="2" width="14" height="14" rx="4" fill="none"/>' +
            '<rect x="8" y="8" width="14" height="14" rx="4" fill="none"/>',
        size,
    );
}

// ─── Grouping icons ──────────────────────────────────────────────

/** Group – combine into group */
export function iconGroup(size = 14): string {
    return svg(
        '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/><path d="M7 14v1a2 2 0 0 0 2 2h1"/><path d="M14 7h1a2 2 0 0 1 2 2v1"/>',
        size,
    );
}

/** Ungroup – dissolve group */
export function iconUngroup(size = 14): string {
    return svg(
        '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="14" width="8" height="8" rx="1"/><path d="M7 14v1a2 2 0 0 0 2 2h1" stroke-dasharray="3 2"/><path d="M14 7h1a2 2 0 0 1 2 2v1" stroke-dasharray="3 2"/>',
        size,
    );
}

/** Enter/step-into a group */
export function iconCornerDownRight(size = 14): string {
    return svg('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>', size);
}

/** Live Paint bucket — the verb "fill a region with colour". */
export function iconPaintBucket(size = 14): string {
    return svg(
        '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0Z"/>' +
            '<path d="m5 2 5 5"/><path d="M2 13h15"/>' +
            '<path d="M22 20a2 2 0 1 1-4 0c0-1.6 1.7-2.4 2-4 .3 1.6 2 2.4 2 4Z"/>',
        size,
    );
}

/** Duplicate / copy */
export function iconCopy(size = 14): string {
    return svg(
        '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
        size,
    );
}

/** Plus-circle icon – Add Point */
export function iconPlusCircle(size = 14): string {
    return svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>', size);
}

/** Minus-circle icon – Delete Point */
export function iconMinusCircle(size = 14): string {
    return svg('<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>', size);
}

/** Scissors icon */
export function iconScissors(size = 14): string {
    return svg(
        '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" x2="8.12" y1="4" y2="15.88"/><line x1="14.47" x2="20" y1="14.48" y2="20"/><line x1="8.12" x2="12" y1="8.12" y2="12"/>',
        size,
    );
}

/** Link icon – Join Paths */
export function iconLink(size = 14): string {
    return svg(
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
        size,
    );
}

/** Box-select icon – Outline Stroke */
export function iconBoxSelect(size = 14): string {
    return svg(
        '<path d="M5 3a2 2 0 0 0-2 2"/><path d="M19 3a2 2 0 0 1 2 2"/><path d="M21 19a2 2 0 0 1-2 2"/><path d="M5 21a2 2 0 0 1-2-2"/><path d="M9 3h1"/><path d="M9 21h1"/><path d="M14 3h1"/><path d="M14 21h1"/><path d="M3 9v1"/><path d="M21 9v1"/><path d="M3 14v1"/><path d="M21 14v1"/>',
        size,
    );
}

/** Flip Horizontal */
export function iconFlipH(size = 14): string {
    return svg(
        '<path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/><line x1="12" y1="3" x2="12" y2="21"/>',
        size,
    );
}

/** Flip Vertical */
export function iconFlipV(size = 14): string {
    return svg(
        '<path d="M3 8V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3"/><path d="M3 16v3a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><line x1="3" y1="12" x2="21" y2="12"/>',
        size,
    );
}

/** Rotate 90° clockwise */
export function iconRotateCW(size = 14): string {
    return svg(
        '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
        size,
    );
}

/** Rotate 90° counterclockwise */
export function iconRotateCCW(size = 14): string {
    return svg(
        '<path d="M3 12a9 9 0 1 0 9-9c-2.52 0-4.93 1-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
        size,
    );
}

/** Flatten Transform – bake rotation/scale/flip into geometry */
export function iconFlatten(size = 14): string {
    return svg(
        '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
        size,
    );
}

/** Text align left icon */
export function iconTextAlignLeft(size: number = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`;
}

/** Text align center icon */
export function iconTextAlignCenter(size: number = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="10" x2="6" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="18" y1="18" x2="6" y2="18"/></svg>`;
}

/** Text align right icon */
export function iconTextAlignRight(size: number = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="10" x2="7" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="21" y1="18" x2="7" y2="18"/></svg>`;
}

/** Create outlines (text to path) icon */
export function iconCreateOutlines(size: number = 16): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M7 4h10l-5 16"/><path d="M9.5 4l-3 12"/><path d="M14.5 4l3 12"/></svg>`;
}

/** Mesh grid (mesh gradient editing) — matches the Mesh tool's rail icon. */
export function iconMeshGrid(size: number = 14): string {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>`;
}
