/**
 * The font picker: the control that made two thousand families choosable.
 *
 * It is a searchable list drawn over a <select> that the property panel still
 * reads `.value` from and listens to `input`/`change` on. The tests below fix
 * that contract — a picker that filters beautifully but never fires `change`
 * leaves the canvas unchanged, which is the failure mode that matters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FontPicker } from './font_picker';

function mount(): { select: HTMLSelectElement; picker: FontPicker } {
    document.body.innerHTML =
        '<div id="host"><select id="f"><option value="">Default</option></select></div>';
    const select = document.getElementById('f') as HTMLSelectElement;
    return { select, picker: FontPicker.attach(select) };
}

const trigger = () => document.querySelector('.fp-trigger') as HTMLButtonElement;
const rows = () => Array.from(document.querySelectorAll('.fp-row')) as HTMLElement[];
const search = () => document.querySelector('.fp-search') as HTMLInputElement;

function open(): void {
    trigger().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}
function type(q: string): void {
    search().value = q;
    search().dispatchEvent(new Event('input'));
}
function key(k: string): void {
    search().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
}
function filterBy(label: string): void {
    const b = Array.from(document.querySelectorAll('.fp-filter')).find(
        (x) => x.textContent === label,
    )!;
    b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
}
/** Let the highlight's deferred apply reach the canvas. */
function settle(): void {
    vi.advanceTimersByTime(200);
}

beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    document.body.innerHTML = '';
});

afterEach(() => {
    vi.useRealTimers();
});

describe('choosing a font', () => {
    it('finds a family the old hardcoded list did not have', () => {
        const { select } = mount();
        open();
        type('instrument');
        // Ranked: exact-prefix families first, and both Instruments present.
        const names = rows().map((r) => r.textContent);
        expect(names).toContain('Instrument Sans');
        expect(names).toContain('Instrument Serif');
        rows()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(select.value).toBe('Instrument Sans');
    });

    it('fires input while browsing and change on commit', () => {
        const { select } = mount();
        const seen: string[] = [];
        select.addEventListener('input', () => seen.push(`input:${select.value}`));
        select.addEventListener('change', () => seen.push(`change:${select.value}`));
        open();
        type('lora');
        settle();
        key('Enter');
        expect(seen).toContain('input:Lora');
        expect(seen[seen.length - 1]).toBe('change:Lora');
    });

    it('still closes the edit out on Escape, so the next one is undoable', () => {
        // The panel opens a history snapshot on the first `input` and closes it
        // on `change`. A preview that is taken back has to close it too.
        const { select, picker } = mount();
        picker.setValue('Lora');
        const seen: string[] = [];
        select.addEventListener('change', () => seen.push(select.value));
        open();
        type('oswald');
        settle();
        key('Escape');
        expect(seen).toEqual(['Lora']);
    });

    it('does not fire change when the font was not actually changed', () => {
        const { select, picker } = mount();
        picker.setValue('Lora');
        let changes = 0;
        select.addEventListener('change', () => changes++);
        open();
        key('Escape');
        expect(changes).toBe(0);
    });

    it('puts the original font back on Escape', () => {
        const { select, picker } = mount();
        picker.setValue('Lora');
        open();
        type('oswald');
        settle(); // the highlight's font is applied live while browsing
        expect(select.value).not.toBe('Lora');
        key('Escape');
        expect(select.value).toBe('Lora');
    });

    it('matches ignoring case, spaces and punctuation', () => {
        mount();
        open();
        type('ptserif');
        expect(rows()[0].textContent).toBe('PT Serif');
    });

    it('ranks an exact name above the families containing it', () => {
        mount();
        open();
        type('lora');
        expect(rows()[0].textContent).toBe('Lora');
    });

    it('forgets the category filter between visits', () => {
        // A stuck filter empties the next search, and the user is told a font
        // they can see in the catalog does not exist.
        mount();
        open();
        filterBy('Mono');
        key('Escape');
        open();
        type('playfair');
        expect(rows()[0].textContent).toBe('Playfair');
    });

    it('names the filter that is hiding the results', () => {
        mount();
        open();
        filterBy('Mono');
        type('playfair');
        expect(rows()).toHaveLength(0);
        expect(document.querySelector('.fp-empty')!.textContent).toBe('No Mono fonts match');
    });

    it('says so when nothing matches, rather than showing an empty box', () => {
        mount();
        open();
        type('zzzznotafont');
        expect(rows()).toHaveLength(0);
        expect((document.querySelector('.fp-empty') as HTMLElement).style.display).toBe('');
    });

    it('filters by category', () => {
        mount();
        open();
        filterBy('Mono');
        type('code');
        const names = rows().map((r) => r.textContent);
        expect(names).toContain('Fira Code');
        expect(names).not.toContain('Codystar'); // display, not monospace
    });
});

describe('hover preview', () => {
    it('does not apply a font just because the list opened under the cursor', () => {
        // The popover appears where the pointer already is. Applying the row it
        // lands on would change the artwork on a look.
        const { select, picker } = mount();
        picker.setValue('Lora');
        open();
        settle();
        expect(select.value).toBe('Lora');
    });

    it('applies the font the pointer settles on', () => {
        const { select } = mount();
        open();
        type('mono');
        const list = document.querySelector('.fp-list') as HTMLElement;
        list.dispatchEvent(new MouseEvent('mousemove', { clientY: 100, bubbles: true }));
        settle();
        expect(select.value).toBe(rows()[3].textContent);
    });

    it('does not edit the document once per row a fast drag crosses', () => {
        const { select } = mount();
        let inputs = 0;
        select.addEventListener('input', () => inputs++);
        open();
        type('sans');
        const list = document.querySelector('.fp-list') as HTMLElement;
        for (let y = 0; y < 200; y += 10) {
            list.dispatchEvent(new MouseEvent('mousemove', { clientY: y, bubbles: true }));
        }
        settle();
        expect(inputs).toBe(1);
    });
});

describe('the select underneath', () => {
    it('keeps a family the catalog has never heard of', () => {
        // Documents carry embedded faces; the panel must show that family
        // rather than silently blanking to Default.
        const { select, picker } = mount();
        picker.setValue('Some Embedded Face');
        expect(select.value).toBe('Some Embedded Face');
        expect(trigger().textContent).toBe('Some Embedded Face');
    });

    it('shows Default for an empty family', () => {
        const { picker } = mount();
        picker.setValue('');
        expect(trigger().textContent).toBe('Default');
    });

    it('does not build an option per family up front', () => {
        const { select } = mount();
        expect(select.options.length).toBe(1);
    });
});

describe('recents', () => {
    it('offers the fonts you last chose at the top of the list', () => {
        const { picker } = mount();
        picker.setValue('Lora');
        open();
        type('oswald');
        settle();
        key('Enter');

        document.body.innerHTML = '';
        mount();
        open();
        const names = rows().map((r) => r.textContent);
        expect(names.slice(0, 3)).toEqual(['Default', 'Recent', 'Oswald']);
    });
});
