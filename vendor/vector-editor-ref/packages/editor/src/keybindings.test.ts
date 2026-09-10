/**
 * The shortcut list is only worth having if it is true. These tests are the
 * link between the documentation and the handler: the tool letters are asserted
 * to be the ones the editor listens for, and the rest is checked for the
 * mistakes a hand-maintained list actually makes — a key documented twice in one
 * context, an empty row, a chord written with the wrong glyph.
 */
import { describe, expect, it } from 'vitest';
import { InputManager } from './input';
import { FIELD_RULES, KEYBINDINGS, TOOL_BINDINGS } from './keybindings';

describe('tool letters match the handler', () => {
    it('every documented tool key is one the editor listens for', () => {
        const listens = InputManager.TOOL_SHORTCUTS;
        for (const { key, tool } of TOOL_BINDINGS) {
            expect(listens[key], `tool key "${key}"`).toBe(tool);
        }
    });

    it('the editor listens for no tool key the list omits', () => {
        const documented = new Set(TOOL_BINDINGS.map((t) => t.key));
        for (const key of Object.keys(InputManager.TOOL_SHORTCUTS)) {
            expect(documented.has(key), `undocumented tool key "${key}"`).toBe(true);
        }
    });

    it('no letter drives two different tools', () => {
        const keys = TOOL_BINDINGS.map((t) => t.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('tool keys are single lowercase letters, as the handler lower-cases input', () => {
        for (const { key } of TOOL_BINDINGS) expect(key).toMatch(/^[a-z]$/);
    });
});

describe('the list itself holds together', () => {
    const allBindings = KEYBINDINGS.flatMap((s) => s.bindings);

    it('every row has keys and says what they do', () => {
        for (const b of allBindings) {
            expect(b.keys.length, `"${b.action}" has no keys`).toBeGreaterThan(0);
            expect(b.action.trim().length).toBeGreaterThan(0);
            for (const k of b.keys) expect(k.trim().length).toBeGreaterThan(0);
        }
    });

    it('every section is titled and non-empty', () => {
        for (const s of KEYBINDINGS) {
            expect(s.title.trim().length).toBeGreaterThan(0);
            expect(s.bindings.length, `section "${s.title}" is empty`).toBeGreaterThan(0);
        }
    });

    it('no chord is documented twice within one section', () => {
        for (const s of KEYBINDINGS) {
            const seen = new Set<string>();
            for (const b of s.bindings) {
                for (const k of b.keys) {
                    // `+` legitimately appears in both Paths and View — it means
                    // different things by mode, which is the point of the note
                    // attached to it. Within a section, though, a repeat is a bug.
                    expect(seen.has(k), `"${k}" listed twice under "${s.title}"`).toBe(false);
                    seen.add(k);
                }
            }
        }
    });

    it('uses the platform glyphs, never spelled-out modifier names', () => {
        const spelled = /\b(cmd|command|ctrl|control|shift|alt|option|meta)\b/i;
        for (const b of allBindings) {
            for (const k of b.keys) {
                expect(spelled.test(k), `"${k}" should use glyphs (⌘ ⇧ ⌥)`).toBe(false);
            }
        }
    });

    it('mode notes name both the mode and the behaviour', () => {
        for (const b of allBindings) {
            for (const m of b.modes ?? []) {
                expect(m.mode.trim().length).toBeGreaterThan(0);
                expect(m.does.trim().length).toBeGreaterThan(0);
            }
        }
    });

    it('documents the field rules that people trip over', () => {
        expect(FIELD_RULES.length).toBeGreaterThan(0);
        const joined = FIELD_RULES.map((r) => `${r.keys} ${r.does}`).join(' ');
        // The two that caused real bug reports.
        expect(joined).toContain('⌘Z');
        expect(joined).toContain('Esc');
    });
});
