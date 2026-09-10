import { describe, expect, it, vi } from 'vitest';
import { diffPeers, screenToWorld, throttle, worldToScreen } from './presence';

describe('worldToScreen / screenToWorld', () => {
    it('are exact inverses', () => {
        const pan = { x: 137, y: -42 };
        const zoom = 2.5;
        for (const w of [
            { x: 0, y: 0 },
            { x: 100, y: 200 },
            { x: -33.5, y: 9.25 },
        ]) {
            const s = worldToScreen(w, pan, zoom);
            const back = screenToWorld(s, pan, zoom);
            expect(back.x).toBeCloseTo(w.x, 6);
            expect(back.y).toBeCloseTo(w.y, 6);
        }
    });

    it('matches the input layer mapping (screen = world*zoom + pan)', () => {
        // getPos does (screen - pan)/zoom; a peer cursor must invert it exactly.
        const pan = { x: 50, y: 10 };
        const zoom = 1.5;
        expect(worldToScreen({ x: 20, y: 20 }, pan, zoom)).toEqual({ x: 80, y: 40 });
        expect(screenToWorld({ x: 80, y: 40 }, pan, zoom)).toEqual({ x: 20, y: 20 });
    });
});

describe('diffPeers', () => {
    it('splits into added / removed / kept by id', () => {
        const d = diffPeers(['a', 'b', 'c'], ['b', 'c', 'd']);
        expect(d.added.sort()).toEqual(['d']);
        expect(d.removed.sort()).toEqual(['a']);
        expect(d.kept.sort()).toEqual(['b', 'c']);
    });

    it('handles empty rosters both ways', () => {
        expect(diffPeers([], ['x']).added).toEqual(['x']);
        expect(diffPeers(['x'], []).removed).toEqual(['x']);
        expect(diffPeers([], [])).toEqual({ added: [], removed: [], kept: [] });
    });
});

describe('throttle', () => {
    it('runs immediately, then coalesces to the latest args', () => {
        vi.useFakeTimers();
        const calls: number[] = [];
        const t = throttle((n: number) => calls.push(n), 40);
        t(1); // immediate
        t(2);
        t(3); // only the latest of the burst should land, after the window
        expect(calls).toEqual([1]);
        vi.advanceTimersByTime(40);
        expect(calls).toEqual([1, 3]);
        vi.useRealTimers();
    });

    it('cancel drops a pending trailing call', () => {
        vi.useFakeTimers();
        const calls: number[] = [];
        const t = throttle((n: number) => calls.push(n), 40);
        t(1);
        t(2);
        t.cancel();
        vi.advanceTimersByTime(100);
        expect(calls).toEqual([1]);
        vi.useRealTimers();
    });
});
