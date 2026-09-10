import { afterEach, describe, expect, it } from 'vitest';
import {
    type AnalyticsSink,
    logAppEvent,
    registerAnalyticsSink,
    withBulkAnalytics,
} from './analytics';

type Event = { name: string; params?: Record<string, any> };

function capture(): Event[] {
    const seen: Event[] = [];
    const sink: AnalyticsSink = (name, params) => seen.push({ name, params });
    registerAnalyticsSink(sink);
    return seen;
}

afterEach(() => registerAnalyticsSink(null));

describe('withBulkAnalytics', () => {
    it('collapses per-object events into one summary carrying the counts', () => {
        const seen = capture();

        withBulkAnalytics('svg_imported', { roots: 1 }, () => {
            for (let i = 0; i < 500; i++) logAppEvent('object_created', { type: 'rect' });
            for (let i = 0; i < 500; i++) logAppEvent('property_changed', { property: 'style' });
        });

        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe('svg_imported');
        expect(seen[0].params).toMatchObject({
            roots: 1,
            n_object_created: 500,
            n_property_changed: 500,
            collapsed_events: 1000,
        });
    });

    it('leaves ordinary events alone outside a bulk', () => {
        const seen = capture();
        logAppEvent('document_created');
        withBulkAnalytics('svg_imported', undefined, () => logAppEvent('object_created'));
        logAppEvent('export_started');
        expect(seen.map((e) => e.name)).toEqual([
            'document_created',
            'svg_imported',
            'export_started',
        ]);
    });

    it('reports only once when bulks nest', () => {
        const seen = capture();
        withBulkAnalytics('outer', undefined, () => {
            logAppEvent('object_created');
            withBulkAnalytics('inner', undefined, () => logAppEvent('object_created'));
            logAppEvent('object_created');
        });
        expect(seen).toHaveLength(1);
        expect(seen[0].name).toBe('outer');
        // The inner bulk's events still land in the outer tally.
        expect(seen[0].params).toMatchObject({ n_object_created: 3, collapsed_events: 3 });
    });

    it('evaluates a params thunk after fn, so post-hoc values can be reported', () => {
        const seen = capture();
        let roots = 0;
        withBulkAnalytics(
            'svg_imported',
            () => ({ roots }),
            () => {
                roots = 7;
                logAppEvent('object_created');
            },
        );
        expect(seen[0].params).toMatchObject({ roots: 7 });
    });

    it('still reports, and does not swallow the error, when fn throws', () => {
        const seen = capture();
        expect(() =>
            withBulkAnalytics('svg_imported', undefined, () => {
                logAppEvent('object_created');
                throw new Error('bad svg');
            }),
        ).toThrow('bad svg');
        expect(seen).toHaveLength(1);
        expect(seen[0].params).toMatchObject({ n_object_created: 1 });
    });

    it('restores normal dispatch after a throw rather than suppressing forever', () => {
        const seen = capture();
        try {
            withBulkAnalytics('svg_imported', undefined, () => {
                throw new Error('boom');
            });
        } catch {
            /* expected */
        }
        logAppEvent('document_created');
        expect(seen.map((e) => e.name)).toEqual(['svg_imported', 'document_created']);
    });

    it('does not let a throwing params thunk break the operation', () => {
        const seen = capture();
        const out = withBulkAnalytics(
            'svg_imported',
            () => {
                throw new Error('instrumentation bug');
            },
            () => 'result',
        );
        expect(out).toBe('result');
        expect(seen).toHaveLength(1);
        expect(seen[0].params).toMatchObject({ collapsed_events: 0 });
    });

    it('returns fn’s value through', () => {
        capture();
        expect(withBulkAnalytics('x', undefined, () => 42)).toBe(42);
    });
});
