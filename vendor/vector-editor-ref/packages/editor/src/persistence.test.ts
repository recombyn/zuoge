/**
 * Pure backup-policy helpers: snapshot throttling and rolling-cap pruning.
 * No IndexedDB (jsdom has none) — these are the decision functions the
 * AutosaveManager / PersistenceManager delegate to.
 */
import { describe, expect, it } from 'vitest';
import {
    BACKUP_CAP,
    BACKUP_THROTTLE_MS,
    type BackupEntry,
    backupIdsToPrune,
    shouldSnapshot,
} from './persistence';

const entry = (id: string, createdAt: number): BackupEntry => ({
    id,
    docId: 'd1',
    name: 'Doc',
    bytes: new Uint8Array([1]),
    createdAt,
});

describe('shouldSnapshot (throttle)', () => {
    it('is false before the throttle window elapses', () => {
        expect(shouldSnapshot(1000, 1000 + BACKUP_THROTTLE_MS - 1)).toBe(false);
    });
    it('is true once the window has elapsed', () => {
        expect(shouldSnapshot(1000, 1000 + BACKUP_THROTTLE_MS)).toBe(true);
    });
    it('is true for a never-snapshotted document (lastAt 0)', () => {
        expect(shouldSnapshot(0, Date.now())).toBe(true);
    });
});

describe('backupIdsToPrune (rolling cap)', () => {
    it('returns nothing when at or under the cap', () => {
        const es = Array.from({ length: BACKUP_CAP }, (_, i) => entry(`b${i}`, i));
        expect(backupIdsToPrune(es)).toEqual([]);
    });

    it('drops the oldest entries beyond the cap, keeping the newest', () => {
        const es = Array.from({ length: BACKUP_CAP + 3 }, (_, i) => entry(`b${i}`, i));
        const pruned = backupIdsToPrune(es);
        expect(pruned).toHaveLength(3);
        // The three oldest (createdAt 0,1,2) are pruned.
        expect(pruned.sort()).toEqual(['b0', 'b1', 'b2']);
    });

    it('respects a custom cap and ignores input ordering', () => {
        const es = [entry('a', 30), entry('b', 10), entry('c', 20), entry('d', 40)];
        // cap 2 → keep the two newest (40, 30), prune the two oldest (10, 20).
        expect(backupIdsToPrune(es, 2).sort()).toEqual(['b', 'c']);
    });
});
