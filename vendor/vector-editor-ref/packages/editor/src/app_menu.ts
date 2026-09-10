/**
 * AppMenu — the top-left menu button (☰) and its dropdown of file actions.
 *
 * Purely a view: it takes a callbacks object so the wiring (FileService,
 * DocumentManager, ExportDialog) stays out of here and can be re-pointed
 * without touching the menu. Modelled on the existing #context-menu pattern.
 */

export interface AppMenuCallbacks {
    onNew: () => void;
    onOpen: () => void;
    onSave: () => void;
    onSaveAs: () => void;
    onImportSVG: () => void;
    onExport: () => void;
    onAddArtboard: () => void;
    onBackups: () => void;
    onShortcuts: () => void;
    onAbout: () => void;
}

interface MenuEntry {
    label: string;
    shortcut?: string;
    action: keyof AppMenuCallbacks;
}

const ENTRIES: (MenuEntry | 'separator')[] = [
    { label: 'New', shortcut: '⌥⌘N', action: 'onNew' },
    { label: 'Open…', shortcut: '⌘O', action: 'onOpen' },
    'separator',
    { label: 'Save', shortcut: '⌘S', action: 'onSave' },
    { label: 'Save As…', shortcut: '⇧⌘S', action: 'onSaveAs' },
    { label: 'Version History…', action: 'onBackups' },
    'separator',
    { label: 'Add Artwork', action: 'onAddArtboard' },
    'separator',
    { label: 'Import SVG…', action: 'onImportSVG' },
    { label: 'Export…', shortcut: '⇧⌘E', action: 'onExport' },
    'separator',
    { label: 'Keyboard Shortcuts…', shortcut: '?', action: 'onShortcuts' },
    { label: 'About…', action: 'onAbout' },
];

export class AppMenu {
    private dropdown: HTMLElement;
    private isOpen = false;

    constructor(
        private btn: HTMLButtonElement,
        private cb: AppMenuCallbacks,
    ) {
        this.dropdown = document.createElement('div');
        this.dropdown.className = 'app-menu-dropdown';
        this.buildItems();
        document.body.appendChild(this.dropdown);

        this.btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });
        // Close on any outside interaction.
        document.addEventListener('click', () => this.close());
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.close();
        });
    }

    private buildItems(): void {
        for (const entry of ENTRIES) {
            if (entry === 'separator') {
                const sep = document.createElement('div');
                sep.className = 'context-menu-separator';
                this.dropdown.appendChild(sep);
                continue;
            }
            const item = document.createElement('div');
            item.className = 'context-menu-item';
            const label = document.createElement('span');
            label.textContent = entry.label;
            item.appendChild(label);
            if (entry.shortcut) {
                const sc = document.createElement('span');
                sc.className = 'context-menu-shortcut';
                sc.textContent = entry.shortcut;
                item.appendChild(sc);
            }
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
                this.cb[entry.action]();
            });
            this.dropdown.appendChild(item);
        }
    }

    private toggle(): void {
        this.isOpen ? this.close() : this.open();
    }

    private open(): void {
        const r = this.btn.getBoundingClientRect();
        this.dropdown.style.left = `${Math.round(r.left)}px`;
        this.dropdown.style.top = `${Math.round(r.bottom + 4)}px`;
        this.dropdown.style.display = 'block';
        this.isOpen = true;
    }

    private close(): void {
        if (!this.isOpen) return;
        this.dropdown.style.display = 'none';
        this.isOpen = false;
    }
}
