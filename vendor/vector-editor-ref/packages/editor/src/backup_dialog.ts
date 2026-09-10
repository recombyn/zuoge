/**
 * BackupDialog — browse and restore automatic version-history snapshots.
 *
 * A modal (same .modal-* chrome as ExportDialog) listing backups grouped by
 * document, newest first. Restore opens the snapshot as a new tab; Delete
 * removes a single snapshot. Data is supplied through callbacks so this stays a
 * pure view.
 */
import type { BackupEntry } from './persistence';

export interface BackupDialogCallbacks {
    /** Fetch all backups (newest first). */
    list: () => Promise<BackupEntry[]>;
    /** Restore a snapshot (opens as a new tab). */
    restore: (entry: BackupEntry) => void;
    /** Delete a single snapshot by id. */
    remove: (id: string) => Promise<void>;
}

export class BackupDialog {
    private overlay: HTMLElement;
    private listEl!: HTMLElement;

    constructor(private cb: BackupDialogCallbacks) {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.display = 'none';
        this.build();
        document.body.appendChild(this.overlay);

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.overlay.style.display !== 'none') this.close();
        });
    }

    private build(): void {
        const card = document.createElement('div');
        card.className = 'modal-card backup-card';
        card.addEventListener('click', (e) => e.stopPropagation());
        card.innerHTML = `
            <div class="modal-title">Version History</div>
            <div class="backup-list" id="backup-list"></div>
            <div class="modal-actions">
                <button class="header-btn header-btn-secondary" id="backup-close">Close</button>
            </div>
        `;
        this.overlay.appendChild(card);
        this.listEl = card.querySelector('#backup-list') as HTMLElement;
        (card.querySelector('#backup-close') as HTMLButtonElement).addEventListener('click', () =>
            this.close(),
        );
    }

    async open(): Promise<void> {
        this.overlay.style.display = 'flex';
        await this.render();
    }

    close(): void {
        this.overlay.style.display = 'none';
    }

    private async render(): Promise<void> {
        const entries = await this.cb.list();
        this.listEl.innerHTML = '';

        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'backup-empty';
            empty.textContent = 'No backups yet. Snapshots are captured automatically as you edit.';
            this.listEl.appendChild(empty);
            return;
        }

        // Group by document, preserving newest-first order.
        const groups = new Map<string, BackupEntry[]>();
        for (const e of entries) {
            if (!groups.has(e.docId)) groups.set(e.docId, []);
            groups.get(e.docId)!.push(e);
        }

        for (const [, items] of groups) {
            const header = document.createElement('div');
            header.className = 'backup-group-header';
            header.textContent = items[0].name || 'Untitled';
            this.listEl.appendChild(header);

            for (const entry of items) {
                const row = document.createElement('div');
                row.className = 'backup-row';

                const when = document.createElement('span');
                when.className = 'backup-when';
                when.textContent = formatWhen(entry.createdAt);
                row.appendChild(when);

                const actions = document.createElement('span');
                actions.className = 'backup-actions';

                const restore = document.createElement('button');
                restore.className = 'backup-btn';
                restore.textContent = 'Restore';
                restore.addEventListener('click', () => {
                    this.cb.restore(entry);
                    this.close();
                });

                const del = document.createElement('button');
                del.className = 'backup-btn backup-btn-danger';
                del.textContent = 'Delete';
                del.addEventListener('click', async () => {
                    await this.cb.remove(entry.id);
                    await this.render();
                });

                actions.appendChild(restore);
                actions.appendChild(del);
                row.appendChild(actions);
                this.listEl.appendChild(row);
            }
        }
    }
}

/** "2:45 PM · today" style relative + absolute label. */
function formatWhen(ts: number): string {
    const d = new Date(ts);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return `${time} · today`;
    const yst = new Date(now);
    yst.setDate(now.getDate() - 1);
    if (d.toDateString() === yst.toDateString()) return `${time} · yesterday`;
    return `${time} · ${d.toLocaleDateString()}`;
}
