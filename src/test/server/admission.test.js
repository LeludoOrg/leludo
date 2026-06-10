import { describe, it, expect } from 'vitest';
import { Admission } from '../../server/admission.js';

describe('Admission — capacity gate', () => {
    it('admits up to the concurrent cap, then returns BUSY_CONCURRENT', () => {
        const a = new Admission({ maxConcurrentGames: 2, maxGamesPerDay: 100 });
        expect(a.tryAdmit('r1').ok).toBe(true);
        expect(a.tryAdmit('r2').ok).toBe(true);
        const third = a.tryAdmit('r3');
        expect(third).toEqual({ ok: false, reason: 'BUSY_CONCURRENT' });
        expect(a.stats().active).toBe(2);
    });

    it('returns BUSY_DAILY once the per-day cap is reached, even after rooms free up', () => {
        const a = new Admission({ maxConcurrentGames: 10, maxGamesPerDay: 2 });
        expect(a.tryAdmit('r1').ok).toBe(true);
        expect(a.tryAdmit('r2').ok).toBe(true);
        a.release('r1');
        a.release('r2');
        // Slots are free, but the *daily* budget is spent.
        expect(a.tryAdmit('r3')).toEqual({ ok: false, reason: 'BUSY_DAILY' });
    });

    it('joining an already-active room is allowed and does not consume a new daily slot', () => {
        const a = new Admission({ maxConcurrentGames: 1, maxGamesPerDay: 1 });
        expect(a.tryAdmit('r1').ok).toBe(true);
        const again = a.tryAdmit('r1');
        expect(again.ok).toBe(true);
        expect(again.already).toBe(true);
        expect(a.stats().today).toBe(1); // not double-counted
    });

    it('release decrements the concurrent count and is idempotent', () => {
        const a = new Admission({ maxConcurrentGames: 1, maxGamesPerDay: 100 });
        a.tryAdmit('r1');
        expect(a.release('r1')).toBe(true);
        expect(a.release('r1')).toBe(false); // already released — no negative drift
        expect(a.stats().active).toBe(0);
        // Slot is free again.
        expect(a.tryAdmit('r2').ok).toBe(true);
    });

    it('resets the daily counter at UTC midnight (injected clock)', () => {
        let now = 0; // 1970-01-01T00:00:00Z
        const a = new Admission({ maxConcurrentGames: 10, maxGamesPerDay: 1 }, () => now);
        expect(a.tryAdmit('r1').ok).toBe(true);
        a.release('r1');
        expect(a.tryAdmit('r2')).toEqual({ ok: false, reason: 'BUSY_DAILY' });
        now = 86_400_000; // advance one full UTC day
        expect(a.tryAdmit('r3').ok).toBe(true);
        expect(a.stats().today).toBe(1);
    });
});
