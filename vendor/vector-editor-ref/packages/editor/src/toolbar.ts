/**
 * Left tool rail — Figma-style: few top-level tools, related tools collapsed
 * into flyout groups.
 *
 * Layout (6 buttons, not one per tool):
 *
 *   Selection (V) · Direct Selection (A)
 *   ─────
 *   Pen (P)      ▸ flyout: Pen, Scissors        — path creation & surgery
 *   Shape (R)    ▸ flyout: Rect, Ellipse, Polygon, Star
 *   Text (T)
 *   ─────
 *   Live Paint (B)
 *
 * A group button always shows its most recently used member; click activates
 * it, long-press / right-click opens the flyout to pick another member.
 * Keyboard shortcuts keep working for every member (input.ts calls
 * ui.setActiveTool, which routes back here via sync()).
 */

import type { UIEngine } from './ui';

declare const lucide: { createIcons: () => void } | undefined;

interface ToolMeta {
    label: string;
    shortcut?: string;
    /** lucide icon name */
    icon: string;
}

const TOOL_META: Record<string, ToolMeta> = {
    selection: { label: 'Selection', shortcut: 'V', icon: 'mouse-pointer-2' },
    direct: { label: 'Direct Selection', icon: 'mouse-pointer-click' },
    artboard: { label: 'Artwork', shortcut: 'A', icon: 'frame' },
    pen: { label: 'Pen', shortcut: 'P', icon: 'pen-tool' },
    pencil: { label: 'Pencil', shortcut: 'N', icon: 'pencil' },
    scissors: { label: 'Scissors', shortcut: 'C', icon: 'scissors' },
    line: { label: 'Line', shortcut: 'L', icon: 'slash' },
    rect: { label: 'Rectangle', shortcut: 'R', icon: 'square' },
    ellipse: { label: 'Ellipse', shortcut: 'O', icon: 'circle' },
    polygon: { label: 'Polygon', icon: 'hexagon' },
    star: { label: 'Star', icon: 'star' },
    text: { label: 'Text', shortcut: 'T', icon: 'type' },
    'paint-bucket': { label: 'Live Paint', shortcut: 'B', icon: 'paint-bucket' },
    mesh: { label: 'Mesh', shortcut: 'U', icon: 'grid-3x3' },
    eyedropper: { label: 'Eyedropper', shortcut: 'I', icon: 'pipette' },
};

/** One rail slot: a tool group (first member = default face) or a divider. */
type LayoutEntry = string[] | 'sep';

const LAYOUT: LayoutEntry[] = [
    ['selection'],
    ['direct'],
    'sep',
    ['artboard'],
    ['pen', 'pencil', 'scissors'],
    ['line', 'rect', 'ellipse', 'polygon', 'star'],
    ['text'],
    'sep',
    ['paint-bucket'],
    ['mesh'],
    ['eyedropper'],
];

const LONG_PRESS_MS = 250;

/** Drag-to-create tools that one-shot back to Selection after each draw, so
 *  double-clicking them to lock (stay active) is meaningful — the tooltip says so. */
const LOCKABLE_TOOLS = new Set(['line', 'pencil', 'rect', 'ellipse', 'polygon', 'star']);

export class Toolbar {
    private el: HTMLElement;
    private ui: UIEngine;
    /** Group index → currently shown member (most recently used). */
    private groupFace: Map<number, string> = new Map();
    /** Group index → its rail button. */
    private buttons: Map<number, HTMLElement> = new Map();
    private flyout: HTMLElement | null = null;
    private pressTimer: number | null = null;
    private suppressClick = false;

    constructor(el: HTMLElement, ui: UIEngine) {
        this.el = el;
        this.ui = ui;
        this.render();
        this.sync(ui.activeTool);

        // Any pointerdown outside the flyout dismisses it
        document.addEventListener(
            'pointerdown',
            (e) => {
                if (this.flyout && !this.flyout.contains(e.target as Node)) this.closeFlyout();
            },
            true,
        );
        window.addEventListener('blur', () => this.closeFlyout());
    }

    /** Group index containing a tool id, or -1. */
    private groupOf(toolId: string): number {
        for (let i = 0; i < LAYOUT.length; i++) {
            const entry = LAYOUT[i];
            if (entry !== 'sep' && entry.includes(toolId)) return i;
        }
        return -1;
    }

    /** Reflect the active tool: promote it to its group's face, highlight it. */
    sync(toolId: string) {
        const activeGroup = this.groupOf(toolId);
        if (activeGroup >= 0 && this.groupFace.get(activeGroup) !== toolId) {
            this.groupFace.set(activeGroup, toolId);
            this.updateButtonFace(activeGroup);
        }
        for (const [idx, btn] of this.buttons) {
            const isActive = idx === activeGroup;
            btn.classList.toggle('active', isActive);
            btn.classList.toggle('locked', isActive && this.ui.toolLocked);
            // Tooltip hint: how to lock, or how to release once locked.
            const face = this.groupFace.get(idx);
            if (face && LOCKABLE_TOOLS.has(face)) {
                btn.dataset.lockhint =
                    isActive && this.ui.toolLocked
                        ? 'Locked · click to release'
                        : 'Double-click to lock';
            } else {
                delete btn.dataset.lockhint;
            }
        }
    }

    private render() {
        this.el.innerHTML = '';
        for (let i = 0; i < LAYOUT.length; i++) {
            const entry = LAYOUT[i];
            if (entry === 'sep') {
                const sep = document.createElement('div');
                sep.className = 'toolbar-sep';
                this.el.appendChild(sep);
                continue;
            }

            this.groupFace.set(i, entry[0]);

            const btn = document.createElement('div');
            btn.className = 'tool-btn';
            const groupIdx = i;
            this.buttons.set(groupIdx, btn);
            this.updateButtonFace(groupIdx);

            btn.addEventListener('click', () => {
                if (this.suppressClick) {
                    this.suppressClick = false;
                    return;
                }
                this.closeFlyout();
                this.ui.setActiveTool(this.groupFace.get(groupIdx)!);
            });

            // Double-click locks the tool so it stays active after each draw
            // (rapid-fire drawing), instead of reverting to Selection.
            btn.addEventListener('dblclick', () => {
                this.closeFlyout();
                this.ui.setActiveTool(this.groupFace.get(groupIdx)!, true);
            });

            if (entry.length > 1) {
                // Long-press or right-click opens the member flyout
                btn.addEventListener('pointerdown', (e) => {
                    if (e.button !== 0) return;
                    this.pressTimer = window.setTimeout(() => {
                        this.suppressClick = true;
                        this.openFlyout(groupIdx, btn);
                    }, LONG_PRESS_MS);
                });
                const cancelPress = () => {
                    if (this.pressTimer !== null) {
                        clearTimeout(this.pressTimer);
                        this.pressTimer = null;
                    }
                };
                btn.addEventListener('pointerup', cancelPress);
                btn.addEventListener('pointerleave', cancelPress);
                btn.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.openFlyout(groupIdx, btn);
                });
            }

            this.el.appendChild(btn);
        }
        this.refreshIcons();
    }

    /** Redraw a group button as its current face tool (icon, tooltip, id). */
    private updateButtonFace(groupIdx: number) {
        const btn = this.buttons.get(groupIdx);
        const entry = LAYOUT[groupIdx];
        if (!btn || entry === 'sep') return;
        const toolId = this.groupFace.get(groupIdx)!;
        const meta = TOOL_META[toolId];

        // Keep the `tool-<id>` id convention so tests/automation can find tools
        btn.id = `tool-${toolId}`;
        btn.dataset.tooltip = meta.label;
        if (meta.shortcut) btn.dataset.shortcut = meta.shortcut;
        else delete btn.dataset.shortcut;

        btn.innerHTML =
            `<i data-lucide="${meta.icon}"></i>` +
            (entry.length > 1 ? '<span class="tool-flyout-indicator"></span>' : '');
        this.refreshIcons();
    }

    private openFlyout(groupIdx: number, anchor: HTMLElement) {
        this.closeFlyout();
        const entry = LAYOUT[groupIdx];
        if (entry === 'sep') return;

        const panel = document.createElement('div');
        panel.className = 'tool-flyout';

        for (const toolId of entry) {
            const meta = TOOL_META[toolId];
            const item = document.createElement('div');
            item.className = 'tool-flyout-item';
            if (toolId === this.ui.activeTool) item.classList.add('active');
            item.innerHTML =
                `<i data-lucide="${meta.icon}"></i><span>${meta.label}</span>` +
                (meta.shortcut ? `<span class="tool-flyout-shortcut">${meta.shortcut}</span>` : '');
            item.addEventListener('click', () => {
                this.closeFlyout();
                this.ui.setActiveTool(toolId);
            });
            panel.appendChild(item);
        }

        const r = anchor.getBoundingClientRect();
        panel.style.left = `${r.right + 6}px`;
        panel.style.top = `${r.top}px`;
        document.body.appendChild(panel);
        this.flyout = panel;
        this.refreshIcons();
    }

    private closeFlyout() {
        this.flyout?.remove();
        this.flyout = null;
    }

    /** Materialize any pending <i data-lucide> tags into inline SVGs. */
    private refreshIcons() {
        if (typeof lucide !== 'undefined' && lucide) lucide.createIcons();
    }
}
