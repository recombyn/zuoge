/**
 * keybindings.ts — the one description of what every key does.
 *
 * Rendered by the in-editor Keyboard Shortcuts dialog and by the web app's
 * /shortcuts page, so the two can never disagree with each other. The tool
 * letters go further than description: `InputManager.TOOL_SHORTCUTS` is built
 * from `TOOL_BINDINGS` below, so a tool key documented here is the tool key the
 * editor actually listens for, and `keybindings.test.ts` fails if that link is
 * broken.
 *
 * The rest are declared rather than derived — they live as branches inside
 * `onKeyDown` and there is no honest way to read them back out. Treat this file
 * as their contract: change a binding, change it here.
 *
 * A note on modes, because it is the single most surprising thing about the
 * keyboard: **a mode owns its keys**. While a pen path is open, while a path is
 * being node-edited, and while a panel field has focus, keys belong to that
 * activity and not to the document behind it. `mode` on a binding records where
 * that changes what a key means.
 */

/** A key's behaviour inside one specific mode. */
export interface ModeNote {
    /** Human name of the mode, e.g. "While drawing with the pen". */
    mode: string;
    /** What the key does there instead. */
    does: string;
}

export interface Binding {
    /** Display chords. Two entries = two ways to do the same thing. */
    keys: string[];
    action: string;
    /** Extra context worth one short line. */
    note?: string;
    /** Where this key means something different. */
    modes?: ModeNote[];
}

export interface BindingSection {
    title: string;
    blurb?: string;
    bindings: Binding[];
}

/** Tool letter → tool id. The editor's shortcut table is built from this. */
export const TOOL_BINDINGS: ReadonlyArray<{ key: string; tool: string; label: string }> = [
    { key: 'v', tool: 'selection', label: 'Select' },
    { key: 'p', tool: 'pen', label: 'Pen' },
    { key: 'n', tool: 'pencil', label: 'Pencil' },
    { key: 'l', tool: 'line', label: 'Line' },
    { key: 'r', tool: 'rect', label: 'Rectangle' },
    { key: 'o', tool: 'ellipse', label: 'Ellipse' },
    { key: 't', tool: 'text', label: 'Text' },
    { key: 'a', tool: 'artboard', label: 'Artwork frame' },
    { key: 'b', tool: 'paint-bucket', label: 'Paint bucket' },
    { key: 'c', tool: 'scissors', label: 'Scissors' },
    { key: 'i', tool: 'eyedropper', label: 'Eyedropper' },
    { key: 'u', tool: 'mesh', label: 'Mesh' },
];

const MOD = '⌘';

export const KEYBINDINGS: ReadonlyArray<BindingSection> = [
    {
        title: 'Tools',
        blurb: 'Press a letter to pick up a tool. Press it twice quickly to lock it, so it stays put after you draw instead of snapping back to Select.',
        bindings: TOOL_BINDINGS.map((t) => ({ keys: [t.key.toUpperCase()], action: t.label })),
    },
    {
        title: 'Editing',
        bindings: [
            {
                keys: ['Delete', '⌫'],
                action: 'Delete the selection',
                modes: [
                    { mode: 'While drawing with the pen', does: 'Removes the last anchor' },
                    { mode: 'Editing a path', does: 'Deletes the selected points' },
                ],
            },
            {
                keys: ['←↑→↓'],
                action: 'Nudge by 1px',
                note: 'Hold ⇧ for 10px.',
                modes: [
                    { mode: 'Editing a path', does: 'Moves the selected points, handles and all' },
                    {
                        mode: 'While drawing with the pen',
                        does: 'Nothing — the path is not geometry yet',
                    },
                ],
            },
            { keys: [`${MOD}D`], action: 'Duplicate' },
            { keys: [`${MOD}C`, `${MOD}V`], action: 'Copy and paste' },
            {
                keys: [`⇧${MOD}V`],
                action: 'Paste in place',
                note: 'Lands the copy squarely on the original, instead of offset beside it.',
            },
            {
                keys: [`${MOD}X`],
                action: 'Cut',
                note: 'The cut objects wait in the clipboard until you paste them — a save never writes them and an undo never drops them.',
            },
            {
                keys: [`⌥${MOD}C`, `⌥${MOD}V`],
                action: 'Copy and paste appearance',
                note: 'Fills, strokes, opacity, blend mode and effects — not geometry. What the eyedropper transfers.',
            },
            {
                keys: ['1…9', '0'],
                action: 'Set opacity: 10–90%, or 100%',
                note: 'Type two digits quickly for an exact value — 45 is 45%.',
            },
            { keys: [`⇧${MOD}L`], action: 'Lock / unlock' },
            { keys: [`⇧${MOD}H`], action: 'Hide / show' },
            { keys: ['F2'], action: 'Rename the selected layer' },
            { keys: [`${MOD}G`], action: 'Group' },
            { keys: [`⇧${MOD}G`], action: 'Ungroup' },
            { keys: [`${MOD}A`], action: 'Select everything' },
            { keys: [`⇧${MOD}A`], action: 'Deselect' },
            { keys: [`${MOD}E`], action: 'Flatten to a single path' },
            {
                keys: [`${MOD}J`],
                action: 'Join two open paths',
                modes: [{ mode: 'Editing a path', does: 'Merges the selected points into one' }],
            },
            { keys: [`⇧${MOD}O`], action: 'Convert text to outlines' },
        ],
    },
    {
        title: 'Live Paint',
        blurb: 'B picks up the bucket; double-click a Live Paint group to get back into it. While the bucket is armed, these keys belong to painting.',
        bindings: [
            { keys: ['Click'], action: 'Fill the region under the cursor' },
            { keys: ['⇧Click'], action: 'Paint the line under the cursor instead' },
            {
                keys: ['⌥Click', '⇧⌥Click'],
                action: 'Pick up the colour under the cursor, as fill / as edge colour',
                note: 'Reads what is actually on screen — a region you already painted, a point along a gradient, a pixel of an image.',
            },
            { keys: ['Enter'], action: 'Done painting' },
        ],
    },
    {
        title: 'Undo & history',
        bindings: [
            {
                keys: [`${MOD}Z`],
                action: 'Undo',
                modes: [
                    {
                        mode: 'While drawing with the pen',
                        does: 'Takes back the last anchor you placed, rather than undoing the document',
                    },
                ],
            },
            { keys: [`⇧${MOD}Z`], action: 'Redo' },
        ],
    },
    {
        title: 'Arranging',
        bindings: [
            { keys: [']', '['], action: 'Bring forward / send backward' },
            { keys: [`${MOD}]`, `${MOD}[`], action: 'Bring to front / send to back' },
            { keys: ['⇧H', '⇧V'], action: 'Flip horizontally / vertically' },
            {
                keys: ['⌥A', '⌥H', '⌥D'],
                action: 'Align left / centre / right',
                note: 'Needs two or more objects — alignment is to the selection’s own bounds.',
            },
            { keys: ['⌥W', '⌥V', '⌥S'], action: 'Align top / middle / bottom' },
        ],
    },
    {
        title: 'Combining',
        blurb: 'Boolean groups are non-destructive: the operands stay inside, still editable.',
        bindings: [
            { keys: [`⌥${MOD}U`], action: 'Union' },
            { keys: [`⌥${MOD}S`], action: 'Subtract' },
            { keys: [`⌥${MOD}I`], action: 'Intersect' },
            {
                keys: [`⇧⌥${MOD}X`],
                action: 'Exclude',
                note: `Figma puts Exclude on ⌥${MOD}X, which is Make Live Paint here.`,
            },
            { keys: [`⌥${MOD}X`], action: 'Make Live Paint group' },
        ],
    },
    {
        title: 'Text',
        blurb: 'These only act on selected text — everywhere else the same keys keep their usual meaning.',
        bindings: [
            { keys: [`${MOD}B`, `${MOD}I`], action: 'Bold / italic' },
            { keys: [`⇧${MOD}.`, `⇧${MOD},`], action: 'Bigger / smaller' },
            { keys: ['⌥→', '⌥←'], action: 'Loosen / tighten tracking' },
        ],
    },
    {
        title: 'Paths',
        blurb: 'Press Enter on a selected shape — or double-click it — to edit its points.',
        bindings: [
            {
                keys: ['+'],
                action: 'Add Point mode, while editing a path',
                note: 'Click a segment to insert an anchor. Outside path editing this zooms in instead.',
            },
            { keys: ['Enter'], action: 'Enter the selected shape, or finish editing it' },
            {
                keys: ['Esc'],
                action: 'Step back out',
                note: 'Finishes the pen path you are drawing rather than discarding it — placed points are real geometry. Leaves a path edit, disarms a tool, then clears the selection.',
            },
        ],
    },
    {
        title: 'View',
        bindings: [
            { keys: ['Space'], action: 'Hold to pan', note: 'Drag the canvas while held.' },
            { keys: ['+', '−'], action: 'Zoom in / out' },
            { keys: ['⇧1'], action: 'Fit the artwork' },
            { keys: ['⇧2'], action: 'Zoom to the selection' },
            { keys: ['⇧0'], action: 'Zoom to 100%' },
            { keys: ['⇧R'], action: 'Toggle rulers', note: `${MOD}R stays your browser's reload.` },
            {
                keys: [`${MOD}\\`, 'Tab'],
                action: 'Hide the panels',
                note: 'Full-bleed canvas. Every tool has a letter, so a hidden toolbar costs you nothing.',
            },
        ],
    },
    {
        title: 'Files',
        bindings: [
            { keys: [`${MOD}S`], action: 'Save' },
            { keys: [`⇧${MOD}S`], action: 'Save as…' },
            { keys: [`${MOD}O`], action: 'Open…' },
            { keys: [`⌥${MOD}N`], action: 'New document' },
            { keys: [`⇧${MOD}E`], action: 'Export…' },
            { keys: ['?'], action: 'This list' },
        ],
    },
];

/**
 * Fields are their own mode, and the rules are worth stating plainly because
 * they are the ones people trip over.
 */
export const FIELD_RULES: ReadonlyArray<{ keys: string[]; does: string }> = [
    { keys: ['Letters', 'Digits', 'Delete'], does: 'Edit the value — never a tool shortcut' },
    { keys: ['↑↓'], does: 'Step the value' },
    { keys: [`${MOD}Z`], does: 'Undoes the document, without leaving the field first' },
    {
        keys: [`${MOD}A`, `${MOD}C`, `${MOD}V`, `${MOD}X`],
        does: "Stay the field's own select-all, copy, paste and cut",
    },
    { keys: ['Esc'], does: 'Hands the keyboard back to the canvas' },
];
