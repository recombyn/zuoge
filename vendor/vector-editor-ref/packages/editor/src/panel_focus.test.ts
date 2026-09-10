/**
 * The property panel rebuilds its paint/effects lists wholesale, which used to
 * destroy the field the user was editing. Focus fell to <body>, so the next
 * keystroke went to the canvas instead: press Up on stroke width and it stepped
 * by 0.5, press Up again and the shape moved 1px.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { capturePanelFocus, restorePanelFocus, withPanelFocusPreserved } from './panel_focus';

/** A stroke row: [colour swatch, [label, number input], select]. */
function buildList(container: HTMLElement, width = '2') {
    container.innerHTML = '';
    const row = document.createElement('div');
    const swatch = document.createElement('button');
    const wrap = document.createElement('div');
    const label = document.createElement('span');
    const input = document.createElement('input');
    input.type = 'number';
    input.value = width;
    input.step = '0.5';
    const select = document.createElement('select');
    wrap.append(label, input);
    row.append(swatch, wrap, select);
    container.appendChild(row);
    return input;
}

let panel: HTMLElement;

beforeEach(() => {
    document.body.innerHTML = '';
    panel = document.createElement('div');
    document.body.appendChild(panel);
});

describe('panel focus preservation', () => {
    it('keeps focus on the field when the list is rebuilt under it', () => {
        const input = buildList(panel);
        input.focus();
        expect(document.activeElement).toBe(input);

        withPanelFocusPreserved([panel], () => buildList(panel, '2.5'));

        const rebuilt = panel.querySelector('input[type=number]')!;
        expect(rebuilt).not.toBe(input); // genuinely a new element
        expect(document.activeElement).toBe(rebuilt);
        expect((rebuilt as HTMLInputElement).value).toBe('2.5');
    });

    it('survives repeated commits, so every arrow key reaches the field', () => {
        let input = buildList(panel);
        input.focus();

        for (let i = 0; i < 5; i++) {
            const next = String(parseFloat(input.value) + 0.5);
            withPanelFocusPreserved([panel], () => buildList(panel, next));
            input = panel.querySelector('input[type=number]')!;
            expect(document.activeElement).toBe(input);
        }
        expect(input.value).toBe('4.5');
    });

    it('leaves focus alone when the rebuild did not destroy the field', () => {
        const input = buildList(panel);
        input.focus();
        // A no-op "render" — the element survives, so nothing should be touched.
        withPanelFocusPreserved([panel], () => {});
        expect(document.activeElement).toBe(input);
    });

    it('ignores focus that was never inside the rebuilt container', () => {
        const outside = document.createElement('input');
        document.body.appendChild(outside);
        buildList(panel);
        outside.focus();

        withPanelFocusPreserved([panel], () => buildList(panel, '9'));

        expect(document.activeElement).toBe(outside);
    });

    it('does not hand focus to an unrelated control when the row shape changed', () => {
        const input = buildList(panel);
        input.focus();
        const snap = capturePanelFocus([panel]);

        // The stroke was removed: same index now holds a different kind of node.
        panel.innerHTML = '';
        const row = document.createElement('div');
        row.append(
            document.createElement('button'),
            document.createElement('div'),
            document.createElement('select'),
        );
        panel.appendChild(row);

        expect(restorePanelFocus(snap)).toBe(false);
        expect(document.activeElement).not.toBe(row.children[1]);
    });

    it('returns nothing to restore when the list empties out', () => {
        const input = buildList(panel);
        input.focus();
        const snap = capturePanelFocus([panel]);

        panel.innerHTML = ''; // last stroke deleted

        expect(restorePanelFocus(snap)).toBe(false);
    });

    it('restores the caret inside a text field', () => {
        const text = document.createElement('input');
        text.type = 'text';
        text.value = 'hello';
        panel.appendChild(text);
        text.focus();
        text.setSelectionRange(2, 4);

        withPanelFocusPreserved([panel], () => {
            panel.innerHTML = '';
            const fresh = document.createElement('input');
            fresh.type = 'text';
            fresh.value = 'hello';
            panel.appendChild(fresh);
        });

        const rebuilt = panel.querySelector('input') as HTMLInputElement;
        expect(document.activeElement).toBe(rebuilt);
        expect([rebuilt.selectionStart, rebuilt.selectionEnd]).toEqual([2, 4]);
    });

    it('searches every container it is given', () => {
        const other = document.createElement('div');
        document.body.appendChild(other);
        const input = buildList(other);
        input.focus();

        withPanelFocusPreserved([panel, other], () => buildList(other, '7'));

        expect(document.activeElement).toBe(other.querySelector('input[type=number]'));
    });

    it('restores focus even if the render throws', () => {
        const input = buildList(panel);
        input.focus();

        expect(() =>
            withPanelFocusPreserved([panel], () => {
                buildList(panel, '3');
                throw new Error('render blew up');
            }),
        ).toThrow('render blew up');

        expect(document.activeElement).toBe(panel.querySelector('input[type=number]'));
    });
});
