/**
 * Dirty-state transitions for Document (the mutation-counter model).
 * Pure logic — no WASM, no DOM.
 */
import { describe, expect, it } from 'vitest';
import { Document } from './document';

describe('Document dirty tracking', () => {
    it('starts clean', () => {
        const d = new Document();
        expect(d.dirty).toBe(false);
        expect(d.name).toBe('Untitled');
    });

    it('becomes dirty on mutation', () => {
        const d = new Document();
        d.markMutated();
        expect(d.dirty).toBe(true);
    });

    it('clears dirty on save', () => {
        const d = new Document();
        d.markMutated();
        d.markMutated();
        expect(d.dirty).toBe(true);
        d.markSaved();
        expect(d.dirty).toBe(false);
    });

    it('re-dirties after a save when mutated again', () => {
        const d = new Document();
        d.markMutated();
        d.markSaved();
        expect(d.dirty).toBe(false);
        d.markMutated();
        expect(d.dirty).toBe(true);
    });

    it('gives each document a unique id', () => {
        const a = new Document();
        const b = new Document();
        expect(a.id).not.toBe(b.id);
    });
});
