/**
 * Unit tests for the SVG `<style>` / CSS selector support (svg_css.ts).
 *
 * The full import path lives in UIEngine (needs WasmScene), but the
 * correctness-sensitive CSS parsing/matching/cascade is pure and DOM-only, so
 * it's tested here directly against jsdom's DOMParser + Element.matches — the
 * same engine the app uses at runtime.
 */
import { describe, expect, it } from 'vitest';
import { type CssRule, cssSpecificity, matchedCssStyles, parseSvgStylesheet } from './svg_css';

/** Parse an SVG string and return its root <svg> element. */
function parseSvg(svg: string): Element {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    return doc.querySelector('svg')!;
}

/** Build the rule list + a getter for the winning value of a property on `#id`. */
function setup(svg: string) {
    const root = parseSvg(svg);
    const rules = parseSvgStylesheet(root);
    const el = (id: string) => root.querySelector(`#${id}`)!;
    const val = (id: string, prop: string): string | undefined =>
        matchedCssStyles(el(id), rules)[prop]?.value;
    const important = (id: string, prop: string): boolean | undefined =>
        matchedCssStyles(el(id), rules)[prop]?.important;
    return { root, rules, el, val, important };
}

// ─── Specificity ──────────────────────────────────────────────────────────────

describe('cssSpecificity', () => {
    it('orders id > class > type', () => {
        expect(cssSpecificity('#a')).toBeGreaterThan(cssSpecificity('.a'));
        expect(cssSpecificity('.a')).toBeGreaterThan(cssSpecificity('rect'));
    });

    it('a compound type+class beats a bare class', () => {
        expect(cssSpecificity('rect.a')).toBeGreaterThan(cssSpecificity('.a'));
    });

    it('more classes beat fewer', () => {
        expect(cssSpecificity('.a.b')).toBeGreaterThan(cssSpecificity('.a'));
    });

    it('a single id beats any number of classes/types', () => {
        expect(cssSpecificity('#a')).toBeGreaterThan(cssSpecificity('.a.b.c.d rect path'));
    });

    it('counts attribute and pseudo-class selectors as class-level', () => {
        expect(cssSpecificity('[data-x]')).toBe(cssSpecificity('.a'));
        expect(cssSpecificity(':hover')).toBe(cssSpecificity('.a'));
    });
});

// ─── Parsing ────────────────────────────────────────────────────────────────

describe('parseSvgStylesheet', () => {
    it('splits comma-separated selectors into separate ordered rules', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>
            .a, .b { fill: red; }
        </style></svg>`);
        const rules = parseSvgStylesheet(root);
        expect(rules.map((r) => r.selector).sort()).toEqual(['.a', '.b']);
        // Distinct source order for tie-breaking.
        expect(rules[0].order).not.toBe(rules[1].order);
    });

    it('captures !important and strips it from the value', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>
            .a { fill: #123456 !important; stroke: blue; }
        </style></svg>`);
        const [rule] = parseSvgStylesheet(root);
        expect(rule.decls.get('fill')).toEqual({ value: '#123456', important: true });
        expect(rule.decls.get('stroke')).toEqual({ value: 'blue', important: false });
    });

    it('strips CSS comments', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>
            /* header comment { not a rule } */
            .a { fill: red; /* inline */ }
        </style></svg>`);
        const rules = parseSvgStylesheet(root);
        expect(rules).toHaveLength(1);
        expect(rules[0].selector).toBe('.a');
        expect(rules[0].decls.get('fill')!.value).toBe('red');
    });

    it('accumulates rules across multiple <style> blocks in source order', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg">
            <style>.a { fill: red; }</style>
            <defs><style>.b { fill: blue; }</style></defs>
        </svg>`);
        const rules = parseSvgStylesheet(root);
        expect(rules.map((r) => r.selector)).toEqual(['.a', '.b']);
        expect(rules[1].order).toBeGreaterThan(rules[0].order);
    });

    it('skips at-rule preludes like @font-face', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><style>
            @font-face { font-family: "X"; src: url(x.woff); }
            .a { fill: red; }
        </style></svg>`);
        const rules = parseSvgStylesheet(root);
        expect(rules.map((r) => r.selector)).toEqual(['.a']);
    });

    it('returns no rules when there is no <style>', () => {
        const root = parseSvg(`<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>`);
        expect(parseSvgStylesheet(root)).toEqual([]);
    });
});

// ─── Matching + cascade ─────────────────────────────────────────────────────

describe('matchedCssStyles', () => {
    it('matches class, type and id selectors', () => {
        const { val } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style>
                .c { fill: #f00; }
                rect { stroke: #00f; }
                #i { opacity: 0.5; }
            </style>
            <rect id="byClass" class="c"/>
            <rect id="byType"/>
            <rect id="i"/>
        </svg>`);
        expect(val('byClass', 'fill')).toBe('#f00');
        expect(val('byType', 'stroke')).toBe('#00f');
        expect(val('i', 'opacity')).toBe('0.5');
    });

    it('a compound selector matches only the right element type', () => {
        const { val } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style> path.c { fill: orange; } </style>
            <path id="p" class="c" d="M0 0 L1 1"/>
            <rect id="r" class="c"/>
        </svg>`);
        expect(val('p', 'fill')).toBe('orange'); // path.c matches the path
        expect(val('r', 'fill')).toBeUndefined(); // ...but not the rect
    });

    it('resolves specificity: id > class > type for the same property', () => {
        const { val } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style>
                rect     { fill: blue; }
                .c       { fill: red; }
                #special { fill: green; }
            </style>
            <rect id="t"/>
            <rect id="cl" class="c"/>
            <rect id="special" class="c"/>
        </svg>`);
        expect(val('t', 'fill')).toBe('blue'); // only type matches
        expect(val('cl', 'fill')).toBe('red'); // class beats type
        expect(val('special', 'fill')).toBe('green'); // id beats class + type
    });

    it('!important beats a higher-specificity non-important rule', () => {
        const { val, important } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style>
                #x { fill: blue; }
                .c { fill: red !important; }
            </style>
            <rect id="x" class="c"/>
        </svg>`);
        expect(val('x', 'fill')).toBe('red');
        expect(important('x', 'fill')).toBe(true);
    });

    it('breaks specificity ties by source order (last wins)', () => {
        const { val } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style>
                .c { fill: red; }
                .c { fill: green; }
            </style>
            <rect id="x" class="c"/>
        </svg>`);
        expect(val('x', 'fill')).toBe('green');
    });

    it('supports descendant combinators', () => {
        const { val } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style> g .c { fill: teal; } </style>
            <g><rect id="inside" class="c"/></g>
            <rect id="outside" class="c"/>
        </svg>`);
        expect(val('inside', 'fill')).toBe('teal');
        expect(val('outside', 'fill')).toBeUndefined(); // not inside a <g>
    });

    it('returns an empty map for a non-matching element or empty stylesheet', () => {
        const { el, rules } = setup(`<svg xmlns="http://www.w3.org/2000/svg">
            <style> .c { fill: red; } </style>
            <rect id="plain"/>
        </svg>`);
        expect(matchedCssStyles(el('plain'), rules)).toEqual({});
        expect(matchedCssStyles(el('plain'), [] as CssRule[])).toEqual({});
    });
});
