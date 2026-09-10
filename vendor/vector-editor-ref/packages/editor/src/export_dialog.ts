/**
 * ExportDialog — modal for choosing export format and options.
 *
 * Phase A: SVG vs PNG, plus a PNG scale selector. The options object carries an
 * optional `artboardId` slot so Phase C can add an artboard picker without
 * reworking the call sites.
 */
import { logAppEvent } from './analytics';
import { escapeHtml } from './svg_utils';

export interface ExportOptions {
    format: 'svg' | 'png';
    /** PNG pixel scale (1×/2×/4×). Ignored for SVG. */
    scale: number;
    /** Which artboard to export, or 'all' for the whole canvas. */
    artboardId: number | 'all';
    /** Omit the artboard background (export a transparent image). */
    transparent: boolean;
}

export interface ArtboardChoice {
    id: number;
    name: string;
}

export class ExportDialog {
    private overlay: HTMLElement;
    private pngScaleRow!: HTMLElement;
    private artboardSelect!: HTMLSelectElement;
    private transparentCheckbox!: HTMLInputElement;
    private format: 'svg' | 'png' = 'svg';
    private scale = 2;

    constructor(
        private onExport: (opts: ExportOptions) => void,
        /** Supplies the current artboards at open time. */
        private getArtboards: () => ArtboardChoice[] = () => [],
    ) {
        this.overlay = document.createElement('div');
        this.overlay.className = 'modal-overlay';
        this.overlay.style.display = 'none';
        this.build();
        document.body.appendChild(this.overlay);

        // Click on the backdrop (not the card) closes.
        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) this.close();
        });
    }

    private build(): void {
        const card = document.createElement('div');
        card.className = 'modal-card';
        card.addEventListener('click', (e) => e.stopPropagation());

        card.innerHTML = `
            <div class="modal-title">Export</div>
            <div class="modal-row">
                <span class="modal-label">Artboard</span>
                <select class="prop-select" id="export-artboard"></select>
            </div>
            <div class="modal-row">
                <span class="modal-label">Format</span>
                <div class="modal-segment" id="export-format">
                    <button class="modal-seg-btn active" data-format="svg">SVG</button>
                    <button class="modal-seg-btn" data-format="png">PNG</button>
                </div>
            </div>
            <div class="modal-row" id="export-png-scale-row" style="display:none;">
                <span class="modal-label">Scale</span>
                <select class="prop-select" id="export-scale">
                    <option value="1">1×</option>
                    <option value="2" selected>2×</option>
                    <option value="4">4×</option>
                </select>
            </div>
            <div class="modal-row">
                <span class="modal-label">Transparent</span>
                <input type="checkbox" id="export-transparent">
            </div>
            <div class="modal-actions">
                <button class="header-btn header-btn-secondary" id="export-cancel">Cancel</button>
                <button class="header-btn header-btn-primary" id="export-confirm">Export</button>
            </div>
        `;
        this.overlay.appendChild(card);

        this.pngScaleRow = card.querySelector('#export-png-scale-row') as HTMLElement;
        this.artboardSelect = card.querySelector('#export-artboard') as HTMLSelectElement;
        this.transparentCheckbox = card.querySelector('#export-transparent') as HTMLInputElement;

        card.querySelectorAll<HTMLButtonElement>('.modal-seg-btn').forEach((b) => {
            b.addEventListener('click', () => {
                this.format = b.dataset.format as 'svg' | 'png';
                card.querySelectorAll('.modal-seg-btn').forEach((x) => {
                    x.classList.remove('active');
                });
                b.classList.add('active');
                this.pngScaleRow.style.display = this.format === 'png' ? '' : 'none';
            });
        });

        (card.querySelector('#export-scale') as HTMLSelectElement).addEventListener(
            'change',
            (e) => {
                this.scale = parseInt((e.target as HTMLSelectElement).value, 10) || 2;
            },
        );

        (card.querySelector('#export-cancel') as HTMLButtonElement).addEventListener('click', () =>
            this.close(),
        );
        (card.querySelector('#export-confirm') as HTMLButtonElement).addEventListener(
            'click',
            () => {
                const raw = this.artboardSelect.value;
                this.close();
                const opts: ExportOptions = {
                    format: this.format,
                    scale: this.scale,
                    artboardId: raw === 'all' ? 'all' : parseInt(raw, 10),
                    transparent: this.transparentCheckbox.checked,
                };
                logAppEvent('export_completed', {
                    format: opts.format,
                    scale: opts.scale,
                    target: raw === 'all' ? 'canvas' : 'artboard',
                });
                this.onExport(opts);
            },
        );
    }

    open(): void {
        // Populate the artboard picker from the live scene each time.
        const arts = this.getArtboards();
        this.artboardSelect.innerHTML =
            arts.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('') +
            `<option value="all">Entire canvas</option>`;
        this.overlay.style.display = 'flex';
        logAppEvent('export_started');
    }

    close(): void {
        this.overlay.style.display = 'none';
    }

    private isOpen(): boolean {
        return this.overlay.style.display !== 'none';
    }
}
