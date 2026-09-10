/**
 * CSS `<style>` support for SVG import.
 *
 * Parses `<style>` blocks into rules and matches them against elements using
 * the DOM's own selector engine (`el.matches`), so class / id / type / compound
 * / combinator selectors all work. Rules are cascade-resolved (`!important` >
 * specificity > source order). This is the novel, correctness-sensitive part of
 * the import cascade, extracted here so it can be unit-tested without WasmScene
 * (it only needs a DOM — jsdom in tests, the real DOM in the app).
 *
 * The full import cascade an element sees for a property is:
 *   !important stylesheet rule > inline style="" > normal stylesheet rule >
 *   presentation attribute
 * (see `getStyleAttr` in ui.ts). This module supplies the stylesheet layer.
 */

export interface CssDecl {
    value: string;
    important: boolean;
}

export interface CssRule {
    /** A single (comma-split) selector. */
    selector: string;
    /** Specificity as a single sortable number (see cssSpecificity). */
    spec: number;
    /** Source order across all <style> blocks (for tie-breaking). */
    order: number;
    /** property → declaration. */
    decls: Map<string, CssDecl>;
}

/**
 * Compute a single sortable specificity: a*10000 + b*100 + c, where
 * a = #id selectors, b = class/attr/pseudo-class, c = type/pseudo-element.
 * (An approximation of the CSS specificity tuple, adequate for SVG stylesheets.)
 */
export function cssSpecificity(sel: string): number {
    const ids = (sel.match(/#[\w-]+/g) || []).length;
    const cls =
        (sel.match(/\.[\w-]+/g) || []).length +
        (sel.match(/\[[^\]]*\]/g) || []).length +
        (sel.match(/:(?!:)[\w-]+/g) || []).length; // pseudo-classes
    const types = (
        sel
            .replace(/[.#][\w-]+/g, ' ')
            .replace(/\[[^\]]*\]/g, ' ')
            .replace(/::?[\w-]+/g, ' ')
            .match(/[a-zA-Z][\w-]*/g) || []
    ).length; // type / pseudo-element
    return Math.min(ids, 9) * 10000 + Math.min(cls, 99) * 100 + Math.min(types, 99);
}

/**
 * Parse every `<style>` block under `svgEl` into a flat list of rules (one per
 * comma-separated selector, preserving source order). Strips CSS comments and
 * skips at-rules (@media/@font-face/…); rules nested inside an @media block are
 * still collected (applied unconditionally — an acceptable simplification).
 */
export function parseSvgStylesheet(svgEl: Element): CssRule[] {
    const out: CssRule[] = [];
    let order = 0;
    for (const styleEl of Array.from(svgEl.querySelectorAll('style'))) {
        // Strip comments; textContent already unwraps CDATA sections.
        const css = (styleEl.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '');
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        for (const m of css.matchAll(ruleRe)) {
            const selectorList = m[1];
            const decls = new Map<string, CssDecl>();
            for (const decl of m[2].split(';')) {
                const idx = decl.indexOf(':');
                if (idx < 0) continue;
                const prop = decl.slice(0, idx).trim().toLowerCase();
                let value = decl.slice(idx + 1).trim();
                if (!prop || !value) continue;
                let important = false;
                const imp = value.match(/!\s*important\s*$/i);
                if (imp) {
                    important = true;
                    value = value.slice(0, imp.index).trim();
                }
                if (value) decls.set(prop, { value, important });
            }
            if (decls.size === 0) continue;
            for (let sel of selectorList.split(',')) {
                sel = sel.trim();
                if (!sel || sel.startsWith('@')) continue; // skip at-rule preludes
                out.push({ selector: sel, spec: cssSpecificity(sel), order: order++, decls });
            }
        }
    }
    return out;
}

/**
 * Resolve the winning CSS declaration per property for an element against a
 * parsed stylesheet, using `el.matches()` and cascade order
 * (!important > specificity > source order). Returns a plain map of the winning
 * declarations (property → {value, important}); empty when nothing matches.
 */
export function matchedCssStyles(el: Element, rules: CssRule[]): Record<string, CssDecl> {
    if (rules.length === 0) return {};
    const winners: Record<string, CssRule> = {};
    for (const rule of rules) {
        let matches = false;
        try {
            matches = el.matches(rule.selector);
        } catch {
            matches = false;
        }
        if (!matches) continue;
        for (const prop of rule.decls.keys()) {
            const cur = winners[prop];
            if (!cur) {
                winners[prop] = rule;
                continue;
            }
            const d = rule.decls.get(prop)!;
            const cd = cur.decls.get(prop)!;
            if (d.important !== cd.important) {
                if (d.important) winners[prop] = rule;
                continue;
            }
            if (rule.spec > cur.spec || (rule.spec === cur.spec && rule.order > cur.order))
                winners[prop] = rule;
        }
    }
    const result: Record<string, CssDecl> = {};
    for (const prop in winners) result[prop] = winners[prop].decls.get(prop)!;
    return result;
}
