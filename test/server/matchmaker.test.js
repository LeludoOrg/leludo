import { describe, it, expect } from 'vitest';
import { Matchmaker } from '../../server/matchmaker.js';

/** Build a matchmaker whose bot-fill timers are captured, not real, so the
 *  timeout path can be fired by hand. */
function makeMM(opts = {}) {
    const formed = [];
    const timers = [];
    const mm = new Matchmaker({
        formMatch: (size, entries, withBots) => formed.push({ size, ids: entries.map(e => e.id), withBots }),
        schedule: (fn) => { timers.push(fn); return timers.length - 1; },
        cancelTimer: () => {},
        ...opts,
    });
    return { mm, formed, timers };
}

describe('Matchmaker — public queue', () => {
    it('forms a match (no bots) as soon as the queue reaches the target size', () => {
        const { mm, formed } = makeMM();
        expect(mm.enqueue({ id: 'a', size: 2 })).toEqual({ queued: true, waiting: 1 });
        expect(formed).toHaveLength(0);
        expect(mm.enqueue({ id: 'b', size: 2 })).toEqual({ queued: false });
        expect(formed).toEqual([{ size: 2, ids: ['a', 'b'], withBots: false }]);
        expect(mm.waiting(2)).toBe(0);
    });

    it('keeps separate queues per requested size', () => {
        const { mm, formed } = makeMM();
        mm.enqueue({ id: 'a', size: 2 });
        mm.enqueue({ id: 'b', size: 3 }); // different bucket — no match
        expect(formed).toHaveLength(0);
        expect(mm.waiting(2)).toBe(1);
        expect(mm.waiting(3)).toBe(1);
    });

    it('cancel removes a waiting player and prevents the match', () => {
        const { mm, formed } = makeMM();
        mm.enqueue({ id: 'a', size: 2 });
        expect(mm.cancel('a')).toBe(true);
        expect(mm.waiting(2)).toBe(0);
        mm.enqueue({ id: 'b', size: 2 });
        expect(formed).toHaveLength(0); // 'a' is gone, only 'b' waits
    });

    it('bot-fills a partial match when the fill timer fires', () => {
        const { mm, formed, timers } = makeMM();
        mm.enqueue({ id: 'a', size: 4 }); // one human, waiting
        expect(formed).toHaveLength(0);
        timers[0](); // fire the bot-fill timeout
        expect(formed).toEqual([{ size: 4, ids: ['a'], withBots: true }]);
        expect(mm.waiting(4)).toBe(0);
    });

    it('re-enqueueing the same id does not double-seat', () => {
        const { mm, formed } = makeMM();
        mm.enqueue({ id: 'a', size: 2 });
        mm.enqueue({ id: 'a', size: 2 }); // same player re-queues
        expect(mm.waiting(2)).toBe(1);
        mm.enqueue({ id: 'b', size: 2 });
        expect(formed).toEqual([{ size: 2, ids: ['a', 'b'], withBots: false }]);
    });
});
