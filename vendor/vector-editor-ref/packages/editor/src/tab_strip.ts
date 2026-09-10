/**
 * TabStrip — renders the document tabs in the header.
 *
 * A pure view: it takes a list of tab descriptors and callbacks and renders
 * them. Phase A drives it with a single tab; Phase B's DocumentManager drives
 * it with many. Rendering is signature-guarded so it can be called on every
 * mutation (for the dirty dot) without thrashing the DOM.
 */

export interface TabDescriptor {
    id: string;
    name: string;
    dirty: boolean;
    active: boolean;
}

export interface TabStripCallbacks {
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onNew: () => void;
    onRename?: (id: string, name: string) => void;
}

export class TabStrip {
    private _signature = '';
    /** Last descriptor list, so a rename can re-render without the manager. */
    private _lastTabs: TabDescriptor[] = [];
    /** When a click just activated a tab, ignore the immediate follow-up click
     *  on the (re-rendered) active tab so a double-click-to-focus doesn't
     *  accidentally open the rename editor. */
    private _activatedAt = 0;

    constructor(
        private el: HTMLElement,
        private cb: TabStripCallbacks,
    ) {}

    render(tabs: TabDescriptor[]): void {
        this._lastTabs = tabs;
        const sig =
            tabs.map((t) => `${t.id}:${t.name}:${t.dirty ? 1 : 0}:${t.active ? 1 : 0}`).join('|') +
            `#${tabs.length}`;
        if (sig === this._signature) return;
        this._signature = sig;

        this.el.innerHTML = '';
        const showClose = tabs.length > 1;

        for (const t of tabs) {
            const tab = document.createElement('div');
            tab.className = `doc-tab${t.active ? ' active' : ''}`;
            tab.title = t.name;

            const label = document.createElement('span');
            label.className = 'doc-tab-label';
            label.textContent = t.name;
            if (t.active && this.cb.onRename) {
                label.classList.add('renamable');
                label.title = 'Click to rename';
            }

            const dot = document.createElement('span');
            dot.className = `doc-tab-dot${t.dirty ? ' dirty' : ''}`;

            tab.appendChild(dot);
            tab.appendChild(label);

            if (showClose) {
                const close = document.createElement('button');
                close.className = 'doc-tab-close';
                close.innerHTML = '&times;';
                close.title = 'Close';
                close.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.cb.onClose(t.id);
                });
                tab.appendChild(close);
            }

            tab.addEventListener('click', (e) => {
                if (!t.active) {
                    this._activatedAt = Date.now();
                    this.cb.onSelect(t.id);
                    return;
                }
                // Clicking the title of the already-active tab starts a rename
                // — unless this click is the tail of the double-click that
                // activated it, or a rename input is already open.
                if (
                    this.cb.onRename &&
                    e.target === label &&
                    !tab.classList.contains('renaming') &&
                    Date.now() - this._activatedAt > 500
                ) {
                    this.beginRename(label, t);
                }
            });
            tab.addEventListener('mousedown', (e) => {
                // Middle-click closes.
                if (e.button === 1 && showClose) {
                    e.preventDefault();
                    this.cb.onClose(t.id);
                }
            });
            if (this.cb.onRename) {
                tab.addEventListener('dblclick', () => {
                    if (!tab.classList.contains('renaming')) this.beginRename(label, t);
                });
            }

            this.el.appendChild(tab);
        }

        const add = document.createElement('button');
        add.className = 'doc-tab-add';
        add.innerHTML = '+';
        add.title = 'New document (⌥⌘N)';
        add.addEventListener('click', () => this.cb.onNew());
        this.el.appendChild(add);
    }

    private beginRename(label: HTMLElement, t: TabDescriptor): void {
        const input = document.createElement('input');
        input.className = 'doc-tab-rename';
        input.value = t.name;
        label.replaceWith(input);
        // Lift the tab's max-width while renaming so the input can grow; the
        // re-render in finish() restores the normal tab.
        input.parentElement?.classList.add('renaming');

        // Size the input to its content so it grows while typing, between a
        // comfortable floor and a cap. Measure with a hidden mirror span so
        // the real layout engine resolves the font (input.scrollWidth is
        // unreliable for <input> in Chrome).
        const cs = getComputedStyle(input);
        const mirror = document.createElement('span');
        mirror.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
        mirror.style.fontFamily = cs.fontFamily;
        mirror.style.fontSize = cs.fontSize;
        mirror.style.fontWeight = cs.fontWeight;
        mirror.style.letterSpacing = cs.letterSpacing;
        document.body.appendChild(mirror);
        const fit = () => {
            mirror.textContent = input.value;
            const w = Math.ceil(mirror.getBoundingClientRect().width);
            input.style.width = `${Math.min(280, Math.max(90, w + 18))}px`;
        };
        fit();
        input.addEventListener('input', fit);
        input.focus();
        input.select();

        let done = false;
        const finish = (save: boolean) => {
            if (done) return;
            done = true;
            mirror.remove();
            if (save) {
                const v = input.value.trim();
                if (v && v !== t.name) this.cb.onRename?.(t.id, v);
            }
            // Always re-render so the <input> is replaced by the label again,
            // even when the name didn't change (blur/Escape with no edit).
            this._signature = '';
            this.render(this._lastTabs);
        };
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            // Some environments deliver the key as legacy 'Return' or only a
            // reliable keyCode — accept them all; this is the primary commit.
            if (e.key === 'Enter' || e.key === 'Return' || e.keyCode === 13) {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape' || e.keyCode === 27) {
                e.preventDefault();
                finish(false);
            }
        });
        // keydown can be swallowed by host-page capture listeners; keyup is a
        // second chance to commit so Enter never appears to "do nothing".
        input.addEventListener('keyup', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter' || e.key === 'Return' || e.keyCode === 13) finish(true);
        });
    }
}
