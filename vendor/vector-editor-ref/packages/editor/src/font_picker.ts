/**
 * The font family control.
 *
 * A native <select> stops being usable somewhere around fifty options, and the
 * catalog has two thousand — so the select stays as the state and event surface
 * the rest of the panel already talks to (`.value`, `input`, `change`), and
 * this draws a searchable list on top of it.
 *
 * Two things make the list worth its code:
 *   - every row is drawn in its own font, loaded only while it is on screen, so
 *     you choose by looking rather than by recognising a name;
 *   - the row you point at or arrow onto is applied to the selection live, so
 *     you judge a font on your own artwork, and Escape puts back the one you
 *     started with.
 *
 * Options are added to the select on demand rather than up front: two thousand
 * <option> nodes cost real time at editor start and nothing ever reads them.
 * `setValue` is therefore the only correct way to drive the control — assigning
 * `select.value` directly silently blanks it when no option has been made yet.
 */
import { type FontCategory, type FontMeta, fontCatalog } from './font_catalog';
import { ensurePreviewFace } from './fonts';

/** Height of one row, in px. Uniform, so the list can be windowed by index. */
const ROW_H = 28;
/** Rows drawn beyond the viewport, so a fast scroll doesn't show empty space. */
const OVERSCAN = 6;
/** How long the highlight must rest on a row before its font is applied. */
const APPLY_DELAY = 110;
const RECENT_KEY = 've.font.recent';
const RECENT_MAX = 8;

/** Filter buttons, in bar order. `null` is "everything". */
const FILTERS: Array<{ label: string; cat: FontCategory | null }> = [
    { label: 'All', cat: null },
    { label: 'Sans', cat: 'sans-serif' },
    { label: 'Serif', cat: 'serif' },
    { label: 'Display', cat: 'display' },
    { label: 'Script', cat: 'handwriting' },
    { label: 'Mono', cat: 'monospace' },
    { label: 'Icons', cat: 'icons' },
];

/** A row: either a font, the "no family set" row, or a section heading. */
type Row =
    | { kind: 'font'; meta: FontMeta }
    | { kind: 'default' }
    | { kind: 'header'; label: string };

function loadRecents(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
    } catch {
        return [];
    }
}

function pushRecent(family: string): void {
    if (!family) return;
    const list = loadRecents().filter((f) => f.toLowerCase() !== family.toLowerCase());
    list.unshift(family);
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    } catch {
        /* ignore quota */
    }
}

/** Fold a name or a query to bare lowercase letters, so "PT Serif" is found by
 *  "ptserif", "pt serif" and "pt-serif" alike. */
function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Score a family against a normalised query. Lower is better; -1 is no match.
 * Exact name first, then names that start with the query, then a word that
 * starts with it, then anything containing it — which is the order you would
 * expect typing "instrument" or "mono".
 */
function score(family: string, q: string): number {
    const n = norm(family);
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    for (const word of family.toLowerCase().split(/\s+/)) {
        if (norm(word).startsWith(q)) return 2;
    }
    return n.includes(q) ? 3 : -1;
}

export class FontPicker {
    private select: HTMLSelectElement;
    private trigger: HTMLButtonElement;
    private root: HTMLElement | null = null;
    private search!: HTMLInputElement;
    private list!: HTMLElement;
    private filterBar!: HTMLElement;
    private spacer!: HTMLElement;
    private empty!: HTMLElement;

    private rows: Row[] = [];
    /** Row elements currently in the DOM, by row index. */
    private drawn = new Map<number, HTMLElement>();
    private active = -1;
    private filter: FontCategory | null = null;
    /** Value when the popover opened, restored on Escape. */
    private valueOnOpen = '';
    /** Whether any font was applied since opening — including one that was
     *  previewed and then taken back. */
    private dirty = false;
    private previewTimer: number | null = null;
    /** Family the highlight has moved to but which is not applied yet. */
    private pendingApply: string | null = null;
    private applyTimer: number | null = null;

    private onDocDown = (e: MouseEvent) => {
        // The editor may have been torn out from under an open popover — its
        // `destroy` empties the container, which takes the trigger with it.
        // Left alone, this capture listener would go on swallowing every
        // mousedown on the page.
        if (!this.trigger.isConnected) {
            this.destroy();
            return;
        }
        const t = e.target as Node;
        if (this.root?.contains(t) || this.trigger.contains(t)) return;
        // Swallow it, like the color picker does: a click outside should close
        // the popover and not also land on the canvas and drop the selection.
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.commit();
    };
    private onReposition = () => this.position();

    private constructor(select: HTMLSelectElement) {
        this.select = select;
        const wrap = document.createElement('div');
        wrap.className = 'fp-wrap';
        select.parentNode?.insertBefore(wrap, select);
        select.style.display = 'none';
        wrap.appendChild(select);

        this.trigger = document.createElement('button');
        this.trigger.type = 'button';
        this.trigger.className = 'prop-select fp-trigger';
        this.trigger.setAttribute('aria-haspopup', 'listbox');
        this.trigger.addEventListener('mousedown', (e) => {
            e.preventDefault(); // keep panel focus off the button
            e.stopPropagation();
            this.root && this.root.style.display !== 'none' ? this.commit() : this.open();
        });
        wrap.appendChild(this.trigger);
        this.paintTrigger();
    }

    /** Take over a `<select>`, returning the picker that now drives it. */
    static attach(select: HTMLSelectElement): FontPicker {
        return new FontPicker(select);
    }

    get value(): string {
        return this.select.value;
    }

    /**
     * Point the control at a family, adding the option it needs first.
     *
     * Any family may arrive here, including one the catalog has never heard of:
     * a document can name a font that was embedded by its author or has since
     * left the CDN, and the control has to show it rather than blank itself.
     */
    setValue(family: string): void {
        this.ensureOption(family);
        this.select.value = family;
        this.paintTrigger();
    }

    private ensureOption(family: string): void {
        if (!family) return;
        for (const opt of this.select.options) {
            if (opt.value === family) return;
        }
        const opt = document.createElement('option');
        opt.value = family;
        opt.textContent = family;
        this.select.appendChild(opt);
    }

    private paintTrigger(): void {
        const family = this.select.value;
        this.trigger.textContent = family || 'Default';
        // Preview the chosen font in the button itself — the same reason the
        // rows are previewed, and it costs one face that is loaded anyway.
        if (family) {
            ensurePreviewFace(family);
            this.trigger.style.fontFamily = `"${family.replace(/"/g, '')}", sans-serif`;
        } else {
            this.trigger.style.fontFamily = '';
        }
    }

    // ── The popover ──────────────────────────────────────────────────────

    private build(): void {
        const root = document.createElement('div');
        root.className = 'fp-popover';
        root.style.display = 'none';

        this.search = document.createElement('input');
        this.search.className = 'fp-search';
        this.search.type = 'text';
        this.search.placeholder = 'Search fonts…';
        this.search.spellcheck = false;
        this.search.addEventListener('input', () => {
            this.rebuild();
            // Typing re-ranks everything, so the old highlight means nothing;
            // point at the best match instead.
            this.setActive(
                this.rows.findIndex((r) => r.kind !== 'header'),
                false,
            );
        });
        this.search.addEventListener('keydown', (e) => this.onKey(e));
        root.appendChild(this.search);

        const bar = document.createElement('div');
        bar.className = 'fp-filters';
        this.filterBar = bar;
        for (const f of FILTERS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'fp-filter';
            b.textContent = f.label;
            b.dataset.cat = f.cat ?? '';
            b.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.setFilter(f.cat);
                this.list.scrollTop = 0;
            });
            bar.appendChild(b);
        }
        root.appendChild(bar);

        this.list = document.createElement('div');
        this.list.className = 'fp-list';
        this.list.setAttribute('role', 'listbox');
        this.spacer = document.createElement('div');
        this.spacer.className = 'fp-spacer';
        this.list.appendChild(this.spacer);
        this.list.addEventListener('scroll', () => this.draw());
        // Hover follows the pointer's MOVEMENT, not a row's mouseenter: the
        // list opens under the cursor, and an enter event fired by the list
        // arriving beneath a stationary pointer would apply whatever font
        // happens to be there — you open the menu to look, and the text has
        // already changed.
        this.list.addEventListener('mousemove', (e) => {
            const y = e.clientY - this.list.getBoundingClientRect().top + this.list.scrollTop;
            this.setActive(Math.floor(y / ROW_H), false);
        });
        root.appendChild(this.list);

        this.empty = document.createElement('div');
        this.empty.className = 'fp-empty';
        this.empty.textContent = 'No fonts match';
        this.empty.style.display = 'none';
        root.appendChild(this.empty);

        document.body.appendChild(root);
        this.root = root;
    }

    private setFilter(cat: FontCategory | null): void {
        this.filter = cat;
        for (const b of this.filterBar.children) {
            b.classList.toggle('active', (b as HTMLElement).dataset.cat === (cat ?? ''));
        }
        this.rebuild();
    }

    private open(): void {
        if (!this.root) this.build();
        const root = this.root!;
        this.valueOnOpen = this.select.value;
        this.dirty = false;
        this.search.value = '';
        // A category is a refinement of one visit to the list, not a setting.
        // Left set, it silently empties the next search — you type a family you
        // can see is in the catalog and are told there is no such font.
        this.setFilter(null);
        root.style.display = '';
        this.position();
        // Land on the current font, so the list opens where you left it.
        const at = this.rows.findIndex(
            (r) => r.kind === 'font' && r.meta.family === this.select.value,
        );
        this.setActive(at >= 0 ? at : this.rows.findIndex((r) => r.kind !== 'header'), true);
        this.search.focus();
        document.addEventListener('mousedown', this.onDocDown, true);
        window.addEventListener('resize', this.onReposition);
        window.addEventListener('scroll', this.onReposition, true);
    }

    /** Release the popover and its document-level listeners. */
    destroy(): void {
        this.cancelPendingApply();
        this.detach();
        this.root?.remove();
        this.root = null;
    }

    /** Close, keeping whatever is currently applied. */
    private commit(): void {
        if (!this.root || this.root.style.display === 'none') return;
        this.flushApply();
        this.root.style.display = 'none';
        this.detach();
        if (this.select.value !== this.valueOnOpen) pushRecent(this.select.value);
        // `change` closes out the edit even when the font ends up where it
        // started: the panel opens a history snapshot on the first `input` and
        // only `change` tells it the edit is over. Skipping it after a
        // previewed-then-cancelled pick would silently fold the user's NEXT
        // property edit into this one.
        if (this.dirty) this.emit('change');
        this.dirty = false;
    }

    /** Close, putting back the font that was set before the popover opened. */
    private cancel(): void {
        this.cancelPendingApply();
        if (this.select.value !== this.valueOnOpen) {
            this.setValue(this.valueOnOpen);
            this.emit('input');
        }
        this.commit();
    }

    private detach(): void {
        document.removeEventListener('mousedown', this.onDocDown, true);
        window.removeEventListener('resize', this.onReposition);
        window.removeEventListener('scroll', this.onReposition, true);
    }

    private position(): void {
        const root = this.root;
        if (!root) return;
        const r = this.trigger.getBoundingClientRect();
        const pw = root.offsetWidth || 240;
        const ph = root.offsetHeight || 360;
        const margin = 8;
        let left = r.left;
        let top = r.bottom + 6;
        if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
        if (left < margin) left = margin;
        if (top + ph > window.innerHeight - margin) top = r.top - ph - 6; // flip above
        if (top < margin) top = margin;
        root.style.left = `${Math.round(left)}px`;
        root.style.top = `${Math.round(top)}px`;
    }

    // ── Rows ─────────────────────────────────────────────────────────────

    private rebuild(): void {
        const q = norm(this.search.value);
        const all = fontCatalog();
        const inFilter = (m: FontMeta) => !this.filter || m.category === this.filter;
        const rows: Row[] = [];

        if (!q) {
            if (!this.filter) rows.push({ kind: 'default' });
            // Recents earn the top of an unfiltered list: picking a font is
            // usually picking one of the few you are already using.
            const recents = loadRecents()
                .map((f) => all.find((m) => m.family === f))
                .filter((m): m is FontMeta => !!m && inFilter(m));
            if (recents.length) {
                rows.push({ kind: 'header', label: 'Recent' });
                for (const m of recents) rows.push({ kind: 'font', meta: m });
                rows.push({ kind: 'header', label: 'All fonts' });
            }
            for (const m of all) if (inFilter(m)) rows.push({ kind: 'font', meta: m });
        } else {
            const hits: Array<{ m: FontMeta; s: number }> = [];
            for (const m of all) {
                if (!inFilter(m)) continue;
                const s = score(m.family, q);
                if (s >= 0) hits.push({ m, s });
            }
            hits.sort((a, b) => a.s - b.s || a.m.family.localeCompare(b.m.family));
            for (const h of hits) rows.push({ kind: 'font', meta: h.m });
        }

        this.rows = rows;
        // The highlight is an INDEX into a list that has just changed shape, so
        // it no longer points at the font it did. Dropping it also lets the
        // caller re-highlight row 0, which `setActive` would otherwise treat as
        // a move to where it already was.
        this.active = -1;
        this.spacer.style.height = `${rows.length * ROW_H}px`;
        this.empty.style.display = rows.length ? 'none' : '';
        const label = FILTERS.find((f) => f.cat === this.filter)?.label;
        this.empty.textContent = this.filter ? `No ${label} fonts match` : 'No fonts match';
        this.draw();
    }

    /** Draw only the rows in view — the list is two thousand entries long. */
    private draw(): void {
        const top = this.list.scrollTop;
        const height = this.list.clientHeight || ROW_H * 10;
        const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
        const last = Math.min(this.rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);

        for (const el of this.drawn.values()) el.remove();
        this.drawn.clear();
        const frag = document.createDocumentFragment();
        for (let i = first; i < last; i++) {
            const el = this.rowEl(i, this.rows[i]);
            this.drawn.set(i, el);
            frag.appendChild(el);
        }
        this.list.appendChild(frag);

        // Preview faces are fetched for what settles on screen, not for every
        // row a flick scrolls past.
        if (this.previewTimer !== null) clearTimeout(this.previewTimer);
        this.previewTimer = window.setTimeout(() => {
            for (let i = first; i < last; i++) {
                const row = this.rows[i];
                if (row.kind === 'font') ensurePreviewFace(row.meta.family);
            }
        }, 90);
    }

    private rowEl(i: number, row: Row): HTMLElement {
        const el = document.createElement('div');
        el.className = 'fp-row';
        el.style.top = `${i * ROW_H}px`;
        if (row.kind === 'header') {
            el.classList.add('fp-header');
            el.textContent = row.label;
            return el;
        }
        const family = row.kind === 'font' ? row.meta.family : '';
        el.textContent = family || 'Default';
        el.setAttribute('role', 'option');
        if (family) el.style.fontFamily = `"${family.replace(/"/g, '')}", sans-serif`;
        if (i === this.active) el.classList.add('active');
        if (family === this.select.value) el.classList.add('current');
        el.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.cancelPendingApply();
            this.apply(family);
            this.commit();
        });
        return el;
    }

    /**
     * Highlight row `i` and, shortly after, apply its font so the canvas shows
     * what you are pointing at.
     *
     * The apply is deferred rather than immediate because every one of them is
     * a real edit to the document and a face fetch: dragging the pointer down
     * the list would otherwise fire one per row crossed. The highlight itself
     * moves instantly — only the canvas waits for you to settle.
     */
    private setActive(i: number, silent: boolean): void {
        if (i < 0 || i >= this.rows.length || i === this.active) return;
        const previous = this.active;
        this.active = i;
        this.drawn.get(previous)?.classList.remove('active');
        this.drawn.get(i)?.classList.add('active');
        this.scrollIntoView(i);
        const row = this.rows[i];
        if (silent || row.kind === 'header') return;
        this.queueApply(row.kind === 'font' ? row.meta.family : '');
    }

    private queueApply(family: string): void {
        this.pendingApply = family;
        if (this.applyTimer !== null) clearTimeout(this.applyTimer);
        this.applyTimer = window.setTimeout(() => this.flushApply(), APPLY_DELAY);
    }

    private flushApply(): void {
        if (this.applyTimer !== null) clearTimeout(this.applyTimer);
        this.applyTimer = null;
        if (this.pendingApply === null) return;
        const family = this.pendingApply;
        this.pendingApply = null;
        this.apply(family);
    }

    private cancelPendingApply(): void {
        if (this.applyTimer !== null) clearTimeout(this.applyTimer);
        this.applyTimer = null;
        this.pendingApply = null;
    }

    private scrollIntoView(i: number): void {
        const top = i * ROW_H;
        const view = this.list.scrollTop;
        const height = this.list.clientHeight;
        if (top < view) this.list.scrollTop = top;
        else if (top + ROW_H > view + height) this.list.scrollTop = top + ROW_H - height;
    }

    /** Set the family and tell the panel, as a live edit rather than a commit. */
    private apply(family: string): void {
        if (this.select.value === family) return;
        this.setValue(family);
        this.dirty = true;
        this.emit('input');
    }

    private emit(type: 'input' | 'change'): void {
        this.select.dispatchEvent(new Event(type, { bubbles: true }));
    }

    private onKey(e: KeyboardEvent): void {
        // The canvas listens on the document for single-key tool shortcuts, so
        // every key typed here has to stop before it reaches it.
        e.stopPropagation();
        /** Move `by` rows, then keep going in that direction past any heading. */
        const step = (by: number) => {
            const dir = by < 0 ? -1 : 1;
            let i = this.active + by;
            while (i >= 0 && i < this.rows.length && this.rows[i].kind === 'header') i += dir;
            this.setActive(i, false);
        };
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                step(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                step(-1);
                break;
            case 'PageDown':
                e.preventDefault();
                step(Math.min(8, this.rows.length - 1 - this.active));
                break;
            case 'PageUp':
                e.preventDefault();
                step(-Math.min(8, this.active));
                break;
            case 'Enter':
                e.preventDefault();
                this.commit();
                this.trigger.focus();
                break;
            case 'Escape':
                e.preventDefault();
                this.cancel();
                this.trigger.focus();
                break;
        }
    }
}
