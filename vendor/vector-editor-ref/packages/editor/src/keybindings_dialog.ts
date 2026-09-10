/**
 * KeybindingsDialog — the keyboard reference, rendered from `keybindings.ts`.
 *
 * Same modal shell as AboutDialog. The content is generated, never hand-written
 * here, so the dialog and the web app's /shortcuts page always say the same
 * thing and the tool letters are the ones the editor really listens for.
 */
import { type Binding, FIELD_RULES, KEYBINDINGS } from './keybindings';

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `⇧⌘Z` → three <kbd>s. Splitting on the modifier glyphs keeps chords legible
 *  as separate caps instead of one wide blob. */
function chord(keys: string): string {
    const parts = keys.match(/⇧|⌘|⌥|⌃|←|↑|→|↓|.+/g) ?? [keys];
    return parts.map((p) => `<kbd>${esc(p)}</kbd>`).join('');
}

function bindingRow(b: Binding): string {
    const caps = b.keys.map(chord).join('<span class="kb-or">or</span>');
    const modes = (b.modes ?? [])
        .map(
            (m) =>
                `<div class="kb-mode"><span class="kb-mode-where">${esc(m.mode)}</span>${esc(m.does)}</div>`,
        )
        .join('');
    const note = b.note ? `<div class="kb-note">${esc(b.note)}</div>` : '';
    return `
        <div class="kb-row">
            <div class="kb-keys">${caps}</div>
            <div class="kb-action">
                <div class="kb-action-main">${esc(b.action)}</div>
                ${note}
                ${modes}
            </div>
        </div>`;
}

export class KeybindingsDialog {
    private overlay: HTMLElement;

    constructor() {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.display = 'none';
        this.build();
        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e: MouseEvent) => {
            if (e.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape' && this.isOpen()) {
                e.stopPropagation();
                this.close();
            }
        });
    }

    private build(): void {
        const card = document.createElement('div');
        card.className = 'modal-card kb-card';
        card.addEventListener('click', (e: MouseEvent) => e.stopPropagation());

        const sections = KEYBINDINGS.map(
            (s) => `
            <section class="kb-section">
                <h3 class="kb-section-title">${esc(s.title)}</h3>
                ${s.blurb ? `<p class="kb-blurb">${esc(s.blurb)}</p>` : ''}
                <div class="kb-rows">${s.bindings.map(bindingRow).join('')}</div>
            </section>`,
        ).join('');

        const fieldRules = FIELD_RULES.map((r) =>
            bindingRow({ keys: [...r.keys], action: r.does }),
        ).join('');

        card.innerHTML = `
            <div class="kb-head">
                <div>
                    <div class="kb-title">Keyboard shortcuts</div>
                    <div class="kb-sub">A mode owns its keys — while you are drawing, editing a path, or typing in a field, keys belong to that, not to the document behind it.</div>
                </div>
                <button class="kb-close" type="button" aria-label="Close">&times;</button>
            </div>
            <div class="kb-body">
                ${sections}
                <section class="kb-section">
                    <h3 class="kb-section-title">When a panel field has focus</h3>
                    <p class="kb-blurb">Clicking into a value on the right-hand panel puts you in a small mode of its own.</p>
                    <div class="kb-rows">${fieldRules}</div>
                </section>
            </div>`;

        card.querySelector('.kb-close')?.addEventListener('click', () => this.close());
        this.overlay.appendChild(card);
    }

    isOpen(): boolean {
        return this.overlay.style.display === 'flex';
    }

    open(): void {
        this.overlay.style.display = 'flex';
        // Always from the top — reopening should not resume someone else's scroll.
        (this.overlay.querySelector('.kb-body') as HTMLElement | null)?.scrollTo(0, 0);
        // Deliberately no autofocus: focusing the close button paints a focus
        // ring across the header the moment the dialog appears. Escape closes
        // it, and Tab reaches the button for anyone navigating by keyboard.
    }

    close(): void {
        this.overlay.style.display = 'none';
    }

    toggle(): void {
        this.isOpen() ? this.close() : this.open();
    }
}
