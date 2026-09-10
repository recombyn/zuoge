/**
 * Figma / Illustrator-style color picker.
 *
 * A single reusable popover (one instance shared across the whole app) plus a
 * `createColorSwatch` factory that produces a clickable swatch button. Clicking
 * the swatch opens the popover anchored to it.
 *
 * The picker offers a saturation/value square, hue + alpha sliders, HEX and RGB
 * inputs, an eyedropper (where the native `EyeDropper` API is available), a row
 * of recently-used colors and a grid of user-saved swatches. Recents and saved
 * swatches persist to `localStorage`, so users stop re-typing the same colors.
 */

import type { Color } from './types';

// ─── Color math ──────────────────────────────────────────────────────────

interface HSV {
    h: number;
    s: number;
    v: number;
} // h 0-360, s/v 0-1

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0,
        g = 0,
        b = 0;
    if (h < 60) {
        r = c;
        g = x;
    } else if (h < 120) {
        r = x;
        g = c;
    } else if (h < 180) {
        g = c;
        b = x;
    } else if (h < 240) {
        g = x;
        b = c;
    } else if (h < 300) {
        r = x;
        b = c;
    } else {
        r = c;
        b = x;
    }
    return { r: r + m, g: g + m, b: b + m };
}

function rgbToHsv(r: number, g: number, b: number): HSV {
    const max = Math.max(r, g, b),
        min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
}

function clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
}

function toHex2(n: number): string {
    return Math.round(clamp01(n) * 255)
        .toString(16)
        .padStart(2, '0');
}

/** Format a color as #RRGGBB, or #RRGGBBAA when it is not fully opaque. */
export function colorToHex(c: Color, withAlpha = true): string {
    const base = `#${toHex2(c.r)}${toHex2(c.g)}${toHex2(c.b)}`;
    return withAlpha && (c.a ?? 1) < 1 ? `${base}${toHex2(c.a ?? 1)}` : base;
}

/** Parse #RGB / #RRGGBB / #RRGGBBAA (with or without '#'). Returns null if invalid. */
export function parseHex(input: string): Color | null {
    let h = input.trim().replace(/^#/, '');
    if (h.length === 3)
        h = h
            .split('')
            .map((ch) => ch + ch)
            .join('');
    if (h.length === 6) h += 'ff';
    if (h.length !== 8 || /[^0-9a-fA-F]/.test(h)) return null;
    return {
        r: parseInt(h.slice(0, 2), 16) / 255,
        g: parseInt(h.slice(2, 4), 16) / 255,
        b: parseInt(h.slice(4, 6), 16) / 255,
        a: parseInt(h.slice(6, 8), 16) / 255,
    };
}

function rgbaCss(c: Color): string {
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${c.a ?? 1})`;
}

const CHECKER = 'repeating-conic-gradient(#bdbdbd 0% 25%, #fff 0% 50%) 0 0 / 12px 12px';

/** Paint a checkerboard + solid color onto an element's background. */
function paintSwatch(el: HTMLElement, c: Color): void {
    el.style.background = `linear-gradient(${rgbaCss(c)}, ${rgbaCss(c)}), ${CHECKER}`;
}

// ─── Persistence (recent + saved swatches) ───────────────────────────────

const RECENT_KEY = 've.color.recent';
const SAVED_KEY = 've.color.saved';
const RECENT_MAX = 14;

function loadList(key: string): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
function saveList(key: string, list: string[]): void {
    try {
        localStorage.setItem(key, JSON.stringify(list));
    } catch {
        /* ignore quota */
    }
}
function pushRecent(hex: string): void {
    const list = loadList(RECENT_KEY).filter((h) => h.toLowerCase() !== hex.toLowerCase());
    list.unshift(hex);
    saveList(RECENT_KEY, list.slice(0, RECENT_MAX));
}

// ─── Swatch factory ──────────────────────────────────────────────────────

export interface SwatchOptions {
    /** Initial color. */
    color: Color;
    /** Show the alpha slider + alpha input (default true). */
    alpha?: boolean;
    /** Tooltip / accessible label. */
    title?: string;
    /** Extra class names appended to the swatch button (for layout parity). */
    className?: string;
    /** Fired continuously while dragging — apply live, WITHOUT history. */
    onInput: (c: Color) => void;
    /** Fired when a gesture settles / the picker closes — push history here. */
    onChange?: (c: Color) => void;
}

export interface SwatchHandle {
    el: HTMLButtonElement;
    /** Update the swatch's displayed color (e.g. after an external edit). */
    setColor: (c: Color) => void;
}

/**
 * Build a swatch button that opens the shared color picker on click.
 * Replaces `<input type="color">` throughout the app.
 */
export function createColorSwatch(opts: SwatchOptions): SwatchHandle {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cp-swatch${opts.className ? ` ${opts.className}` : ''}`;
    if (opts.title) btn.title = opts.title;

    let current: Color = { ...opts.color };
    const setColor = (c: Color) => {
        current = { ...c };
        paintSwatch(btn, current);
    };
    setColor(current);

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        getPicker().open(btn, current, {
            alpha: opts.alpha !== false,
            title: opts.title,
            onInput: (c) => {
                setColor(c);
                opts.onInput(c);
            },
            onChange: (c) => {
                setColor(c);
                (opts.onChange ?? opts.onInput)(c);
            },
        });
    });

    return { el: btn, setColor };
}

// ─── The shared popover ──────────────────────────────────────────────────

interface OpenOptions {
    alpha: boolean;
    title?: string;
    onInput: (c: Color) => void;
    onChange: (c: Color) => void;
}

let _picker: ColorPicker | null = null;
function getPicker(): ColorPicker {
    if (!_picker) _picker = new ColorPicker();
    return _picker;
}

/** Open the shared color picker anchored to `anchor`, without wiring it to a
 *  persistent swatch button. Used by the swatches palette to edit a swatch. */
export function openColorPicker(
    anchor: HTMLElement,
    color: Color,
    opts: {
        alpha?: boolean;
        title?: string;
        onInput: (c: Color) => void;
        onChange?: (c: Color) => void;
    },
): void {
    getPicker().open(anchor, color, {
        alpha: opts.alpha !== false,
        title: opts.title,
        onInput: opts.onInput,
        onChange: opts.onChange ?? opts.onInput,
    });
}

class ColorPicker {
    private root: HTMLElement;
    private svArea!: HTMLElement;
    private svThumb!: HTMLElement;
    private hueTrack!: HTMLElement;
    private hueThumb!: HTMLElement;
    private alphaRow!: HTMLElement;
    private alphaTrack!: HTMLElement;
    private alphaFill!: HTMLElement;
    private alphaThumb!: HTMLElement;
    private preview!: HTMLElement;
    private hexInput!: HTMLInputElement;
    private rInput!: HTMLInputElement;
    private gInput!: HTMLInputElement;
    private bInput!: HTMLInputElement;
    private aInput!: HTMLInputElement;
    private aField!: HTMLElement;
    private recentRow!: HTMLElement;
    private savedGrid!: HTMLElement;

    private hsv: HSV = { h: 0, s: 0, v: 0 };
    private a = 1;
    private opts: OpenOptions | null = null;
    private anchor: HTMLElement | null = null;
    private dirty = false; // an edit happened since open → commit on close
    private onDocDown = (e: MouseEvent) => this.handleOutside(e);
    private onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') this.close();
    };
    private onReposition = () => this.position();

    constructor() {
        this.root = document.createElement('div');
        this.root.className = 'cp-popover';
        this.root.style.display = 'none';
        this.build();
        document.body.appendChild(this.root);
    }

    // ── Construction ──
    private build() {
        // Saturation / value square
        this.svArea = el('div', 'cp-sv');
        this.svThumb = el('div', 'cp-sv-thumb');
        this.svArea.appendChild(this.svThumb);
        this.root.appendChild(this.svArea);

        // Sliders + eyedropper
        const sliders = el('div', 'cp-sliders');
        const sliderCol = el('div', 'cp-slider-col');

        const hueRow = el('div', 'cp-slider-row');
        this.hueTrack = el('div', 'cp-hue');
        this.hueThumb = el('div', 'cp-slider-thumb');
        this.hueTrack.appendChild(this.hueThumb);
        hueRow.appendChild(this.hueTrack);
        sliderCol.appendChild(hueRow);

        this.alphaRow = el('div', 'cp-slider-row');
        this.alphaTrack = el('div', 'cp-alpha');
        this.alphaFill = el('div', 'cp-alpha-fill');
        this.alphaThumb = el('div', 'cp-slider-thumb');
        this.alphaTrack.appendChild(this.alphaFill);
        this.alphaTrack.appendChild(this.alphaThumb);
        this.alphaRow.appendChild(this.alphaTrack);
        sliderCol.appendChild(this.alphaRow);

        // Preview / eyedropper column — sits to the LEFT of the sliders.
        const side = el('div', 'cp-side');
        const eye = document.createElement('button');
        eye.type = 'button';
        eye.className = 'cp-eyedropper';
        eye.title = 'Pick color from screen';
        eye.innerHTML = EYE_ICON;
        eye.style.display = supportsEyeDropper() ? '' : 'none';
        eye.addEventListener('click', () => this.pickFromScreen());
        this.preview = el('div', 'cp-preview');
        side.appendChild(this.preview);
        side.appendChild(eye);

        sliders.appendChild(side);
        sliders.appendChild(sliderCol);

        this.root.appendChild(sliders);

        // Numeric inputs: HEX + R G B A
        const inputs = el('div', 'cp-inputs');
        this.hexInput = field(inputs, 'HEX', 'cp-hex');
        this.rInput = field(inputs, 'R', 'cp-num');
        this.gInput = field(inputs, 'G', 'cp-num');
        this.bInput = field(inputs, 'B', 'cp-num');
        const aWrap = fieldWrap('A', 'cp-num');
        this.aInput = aWrap.input;
        this.aField = aWrap.wrap;
        inputs.appendChild(this.aField);
        this.root.appendChild(inputs);

        // Recent colors
        this.recentRow = el('div', 'cp-swatch-row');
        const recentSection = section('Recent', this.recentRow);
        this.root.appendChild(recentSection);

        // Saved swatches (with add button)
        this.savedGrid = el('div', 'cp-swatch-row');
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'cp-add-swatch';
        addBtn.title = 'Save current color';
        addBtn.textContent = '+';
        addBtn.addEventListener('click', () => this.saveCurrent());
        const savedSection = section('Swatches', this.savedGrid, addBtn);
        this.root.appendChild(savedSection);

        this.wireInteractions();
    }

    private wireInteractions() {
        // SV square drag
        dragArea(this.svArea, (nx, ny, done) => {
            this.hsv.s = clamp01(nx);
            this.hsv.v = clamp01(1 - ny);
            this.render(true);
            this.emit(done);
        });

        // Hue drag
        dragArea(this.hueTrack, (nx, _ny, done) => {
            this.hsv.h = clamp01(nx) * 360;
            this.render(true);
            this.emit(done);
        });

        // Alpha drag
        dragArea(this.alphaTrack, (nx, _ny, done) => {
            this.a = clamp01(nx);
            this.render(true);
            this.emit(done);
        });

        // HEX
        const commitHex = () => {
            const parsed = parseHex(this.hexInput.value);
            if (parsed) {
                this.setColor(parsed, this.opts?.alpha === false);
                this.render(true);
                this.emit(true);
            } else {
                this.render(false); // revert to valid value
            }
        };
        this.hexInput.addEventListener('change', commitHex);
        this.hexInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') commitHex();
        });

        // RGBA numeric
        const readRgb = (): Color => ({
            r: clamp01((parseFloat(this.rInput.value) || 0) / 255),
            g: clamp01((parseFloat(this.gInput.value) || 0) / 255),
            b: clamp01((parseFloat(this.bInput.value) || 0) / 255),
            a: this.opts?.alpha === false ? 1 : clamp01((parseFloat(this.aInput.value) || 0) / 100),
        });
        const onRgb = (done: boolean) => {
            this.setColor(readRgb(), false);
            this.render(true, /*skipInputs*/ !done);
            this.emit(done);
        };
        for (const inp of [this.rInput, this.gInput, this.bInput, this.aInput]) {
            inp.addEventListener('input', () => onRgb(false));
            inp.addEventListener('change', () => onRgb(true));
        }
    }

    // ── Open / close ──
    open(anchor: HTMLElement, color: Color, opts: OpenOptions) {
        this.anchor = anchor;
        this.opts = opts;
        this.dirty = false;
        this.setColor(color, opts.alpha === false);

        this.aField.style.display = opts.alpha ? '' : 'none';
        this.alphaRow.style.display = opts.alpha ? '' : 'none';

        this.renderSavedRows();
        this.render(false);
        this.root.style.display = '';
        this.position();

        // Defer outside-click binding so the opening click doesn't close it.
        setTimeout(() => {
            document.addEventListener('mousedown', this.onDocDown, true);
            document.addEventListener('keydown', this.onKey, true);
            window.addEventListener('resize', this.onReposition);
            window.addEventListener('scroll', this.onReposition, true);
        }, 0);
    }

    close() {
        if (this.root.style.display === 'none') return;
        if (this.dirty && this.opts) {
            this.opts.onChange(this.color());
            pushRecent(colorToHex(this.color(), this.opts.alpha !== false));
        }
        this.root.style.display = 'none';
        this.opts = null;
        this.anchor = null;
        document.removeEventListener('mousedown', this.onDocDown, true);
        document.removeEventListener('keydown', this.onKey, true);
        window.removeEventListener('resize', this.onReposition);
        window.removeEventListener('scroll', this.onReposition, true);
    }

    private handleOutside(e: MouseEvent) {
        const t = e.target as Node;
        if (this.root.contains(t) || this.anchor?.contains(t)) return;
        // A click outside should ONLY close the picker. Swallow the event so it
        // doesn't also reach the canvas (deselecting the shape) or start a drag.
        // This works because the listener runs in the capture phase (see open()),
        // ahead of the canvas's own mousedown handler in the target/bubble phase.
        e.stopPropagation();
        e.stopImmediatePropagation();
        this.close();
    }

    private position() {
        if (!this.anchor) return;
        const r = this.anchor.getBoundingClientRect();
        const pw = this.root.offsetWidth || 240;
        const ph = this.root.offsetHeight || 300;
        const margin = 8;
        let left = r.left;
        let top = r.bottom + 6;
        if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
        if (left < margin) left = margin;
        if (top + ph > window.innerHeight - margin) top = r.top - ph - 6; // flip above
        if (top < margin) top = margin;
        this.root.style.left = `${Math.round(left)}px`;
        this.root.style.top = `${Math.round(top)}px`;
    }

    // ── State helpers ──
    private color(): Color {
        const { r, g, b } = hsvToRgb(this.hsv.h, this.hsv.s, this.hsv.v);
        return { r, g, b, a: this.a };
    }
    private setColor(c: Color, ignoreAlpha: boolean) {
        this.hsv = rgbToHsv(c.r, c.g, c.b);
        this.a = ignoreAlpha ? 1 : (c.a ?? 1);
    }
    private emit(done: boolean) {
        if (!this.opts) return;
        this.dirty = true;
        const c = this.color();
        if (done) {
            this.opts.onChange(c);
            pushRecent(colorToHex(c, this.opts.alpha !== false));
            this.renderSavedRows(); // reflect new recent
        } else {
            this.opts.onInput(c);
        }
    }

    // ── Rendering ──
    private render(skipHexFocus: boolean, skipInputs = false) {
        const c = this.color();
        const hueRgb = hsvToRgb(this.hsv.h, 1, 1);
        const hueCss = `rgb(${Math.round(hueRgb.r * 255)},${Math.round(hueRgb.g * 255)},${Math.round(hueRgb.b * 255)})`;

        // SV backdrop = hue, with white(→right) and black(→bottom) overlays.
        this.svArea.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueCss}`;
        this.svThumb.style.left = `${this.hsv.s * 100}%`;
        this.svThumb.style.top = `${(1 - this.hsv.v) * 100}%`;
        this.svThumb.style.background = rgbaCss({ ...c, a: 1 });

        this.hueThumb.style.left = `${(this.hsv.h / 360) * 100}%`;
        this.alphaFill.style.background = `linear-gradient(to right, transparent, ${rgbaCss({ ...c, a: 1 })})`;
        this.alphaThumb.style.left = `${this.a * 100}%`;

        paintSwatch(this.preview, c);

        if (!skipInputs) {
            const active = document.activeElement;
            if (!(skipHexFocus && active === this.hexInput)) {
                this.hexInput.value = colorToHex(c, this.opts?.alpha !== false)
                    .toUpperCase()
                    .replace('#', '');
            }
            if (active !== this.rInput) this.rInput.value = String(Math.round(c.r * 255));
            if (active !== this.gInput) this.gInput.value = String(Math.round(c.g * 255));
            if (active !== this.bInput) this.bInput.value = String(Math.round(c.b * 255));
            if (active !== this.aInput) this.aInput.value = String(Math.round((c.a ?? 1) * 100));
        }
    }

    private renderSavedRows() {
        const build = (row: HTMLElement, hexes: string[], removable: boolean) => {
            row.innerHTML = '';
            if (hexes.length === 0) {
                const empty = el('span', 'cp-empty');
                empty.textContent = '—';
                row.appendChild(empty);
                return;
            }
            for (const hex of hexes) {
                const c = parseHex(hex);
                if (!c) continue;
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'cp-chip';
                chip.title = hex.toUpperCase();
                paintSwatch(chip, c);
                chip.addEventListener('click', () => {
                    this.setColor(c, this.opts?.alpha === false);
                    this.render(true);
                    this.emit(true);
                });
                if (removable) {
                    chip.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        saveList(
                            SAVED_KEY,
                            loadList(SAVED_KEY).filter(
                                (h) => h.toLowerCase() !== hex.toLowerCase(),
                            ),
                        );
                        this.renderSavedRows();
                    });
                }
                row.appendChild(chip);
            }
        };
        build(this.recentRow, loadList(RECENT_KEY), false);
        build(this.savedGrid, loadList(SAVED_KEY), true);
    }

    private saveCurrent() {
        const hex = colorToHex(this.color(), this.opts?.alpha !== false);
        const list = loadList(SAVED_KEY).filter((h) => h.toLowerCase() !== hex.toLowerCase());
        list.unshift(hex);
        saveList(SAVED_KEY, list.slice(0, 30));
        this.renderSavedRows();
    }

    private async pickFromScreen() {
        try {
            // @ts-expect-error — EyeDropper is not yet in the TS DOM lib.
            const result = await new EyeDropper().open();
            const c = parseHex(result.sRGBHex);
            if (c) {
                if (this.opts?.alpha === false) c.a = 1;
                else c.a = this.a;
                this.setColor(c, this.opts?.alpha === false);
                this.render(true);
                this.emit(true);
            }
        } catch {
            /* user cancelled */
        }
    }
}

// ─── Small DOM helpers ───────────────────────────────────────────────────

function el(tag: string, className: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = className;
    return e;
}

function fieldWrap(label: string, cls: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = el('label', 'cp-field');
    const span = el('span', 'cp-field-label');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = cls;
    input.spellcheck = false;
    wrap.appendChild(input);
    wrap.appendChild(span);
    return { wrap, input };
}

function field(parent: HTMLElement, label: string, cls: string): HTMLInputElement {
    const { wrap, input } = fieldWrap(label, cls);
    parent.appendChild(wrap);
    return input;
}

function section(title: string, body: HTMLElement, action?: HTMLElement): HTMLElement {
    const wrap = el('div', 'cp-section');
    const head = el('div', 'cp-section-head');
    const label = el('span', 'cp-section-title');
    label.textContent = title;
    head.appendChild(label);
    if (action) head.appendChild(action);
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
}

/**
 * Normalized pointer-drag over an element: reports (x, y) in 0..1 and a `done`
 * flag on pointer-up. Fires once immediately on pointer-down.
 */
function dragArea(elm: HTMLElement, onMove: (nx: number, ny: number, done: boolean) => void) {
    const compute = (ev: PointerEvent, rect: DOMRect, done: boolean) => {
        const nx = (ev.clientX - rect.left) / rect.width;
        const ny = (ev.clientY - rect.top) / rect.height;
        onMove(Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny)), done);
    };
    elm.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        const rect = elm.getBoundingClientRect();
        try {
            elm.setPointerCapture(ev.pointerId);
        } catch {
            /* ignore */
        }
        const move = (e: PointerEvent) => compute(e, rect, false);
        const up = (e: PointerEvent) => {
            compute(e, rect, true);
            elm.removeEventListener('pointermove', move);
            elm.removeEventListener('pointerup', up);
            elm.removeEventListener('pointercancel', up);
        };
        elm.addEventListener('pointermove', move);
        elm.addEventListener('pointerup', up);
        elm.addEventListener('pointercancel', up);
        compute(ev, rect, false);
    });
}

function supportsEyeDropper(): boolean {
    return typeof (window as any).EyeDropper === 'function';
}

// Canonical pipette / eyedropper: squared bulb (top-right), shaft, and a
// two-stroke dripping nib (bottom-left) so it reads unmistakably as a dropper.
const EYE_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L21 9l-3-3Z"/><path d="m14 7 3 3"/></svg>';
