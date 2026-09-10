/**
 * panel_focus.ts — keep keyboard focus alive across a panel list rebuild.
 *
 * The property panel's paint and effects lists are rebuilt wholesale: clear
 * `innerHTML`, recreate every row. That is fine until the edit being committed
 * came from one of those rows' own fields — then committing destroys the control
 * the user is working in, focus falls to `<body>`, and the *next* keystroke
 * belongs to someone else. Concretely: press Up on the stroke-width field and
 * the width steps by 0.5; press Up again and the canvas nudges the shape 1px,
 * because the field it was meant for no longer exists.
 *
 * Rather than teach each list not to rebuild, record where focus was and put it
 * back afterwards. Identity is the child-index chain from the container down to
 * the element, checked against the tag and input type on the way back in — the
 * list comes back the same shape after a value edit, and when it doesn't (a
 * stroke was removed, rows shifted up) the mismatch is caught and focus is left
 * alone rather than landing on an unrelated control.
 */

export interface PanelFocusSnapshot {
    /** The element that had focus. Used to tell "rebuilt" from "left alone". */
    element: HTMLElement;
    container: HTMLElement;
    /** Child-index chain from `container` down to `element`. */
    path: number[];
    tag: string;
    type: string;
    start: number | null;
    end: number | null;
}

/**
 * Record the focused element's position within whichever of `containers` holds
 * it. Returns null when focus is elsewhere (or nowhere) — the common case, and
 * the one where a rebuild is nothing to worry about.
 */
export function capturePanelFocus(
    containers: (HTMLElement | null | undefined)[],
): PanelFocusSnapshot | null {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;

    const container = containers.find((c) => c?.contains(el)) ?? null;
    if (!container) return null;

    const path: number[] = [];
    let cur: HTMLElement = el;
    while (cur !== container) {
        const parent: HTMLElement | null = cur.parentElement;
        if (!parent) return null; // detached mid-walk — nothing to restore into
        path.unshift(Array.prototype.indexOf.call(parent.children, cur));
        cur = parent;
    }

    const input = el as HTMLInputElement;
    // `selectionStart` is only defined for text-like inputs; reading it on a
    // number input throws in some engines, so a caret simply isn't always
    // restorable — which is fine, the focus itself is what matters.
    let start: number | null = null;
    let end: number | null = null;
    try {
        start = input.selectionStart;
        end = input.selectionEnd;
    } catch {
        /* not a text-like input */
    }

    return { element: el, container, path, tag: el.tagName, type: input.type ?? '', start, end };
}

/**
 * Put focus back where `snap` says it was. No-op unless the original element
 * actually went away: if the rebuild left it alone then focus never moved, and
 * re-focusing could steal it from wherever it legitimately went instead.
 */
export function restorePanelFocus(snap: PanelFocusSnapshot | null): boolean {
    if (!snap || snap.element.isConnected) return false;

    let cur: Element | undefined = snap.container;
    for (const i of snap.path) {
        cur = cur?.children[i];
        if (!cur) return false; // the list came back a different shape
    }

    const el = cur as HTMLElement;
    // Same slot — but the same kind of control? Removing a row shifts the rest
    // up, and focusing whatever now sits at that index is worse than not.
    if (el.tagName !== snap.tag || ((el as HTMLInputElement).type ?? '') !== snap.type)
        return false;

    el.focus();
    if (snap.start !== null) {
        try {
            (el as HTMLInputElement).setSelectionRange(snap.start, snap.end ?? snap.start);
        } catch {
            /* not a text-like input */
        }
    }
    return true;
}

/** Run a rebuild of `containers` with the focused field inside them preserved. */
export function withPanelFocusPreserved(
    containers: (HTMLElement | null | undefined)[],
    render: () => void,
): void {
    const snap = capturePanelFocus(containers);
    try {
        render();
    } finally {
        restorePanelFocus(snap);
    }
}
