import { describe, it, expect } from 'vitest';
import { ringDistance, spreadPick, spreadSeatPlan } from '../../scripts/core/seat-allocation.js';

describe('seat-allocation', () => {
    describe('ringDistance', () => {
        it('is 1 for adjacent chairs and 2 for diagonally-opposite ones', () => {
            expect(ringDistance(0, 1)).toBe(1);
            expect(ringDistance(0, 3)).toBe(1); // wraps around the ring
            expect(ringDistance(0, 2)).toBe(2); // opposite corner
            expect(ringDistance(1, 3)).toBe(2);
            expect(ringDistance(2, 2)).toBe(0);
        });
    });

    describe('spreadPick', () => {
        it('returns the lowest open seat for the first human', () => {
            expect(spreadPick([], [0, 1, 2, 3])).toBe(0);
        });

        it('seats the second human diagonally opposite the first', () => {
            expect(spreadPick([0], [1, 2, 3])).toBe(2);
            expect(spreadPick([1], [0, 2, 3])).toBe(3);
            expect(spreadPick([3], [0, 1, 2])).toBe(1);
        });

        it('keeps spreading 3rd/4th humans and breaks ties toward the lowest seat', () => {
            expect(spreadPick([0, 2], [1, 3])).toBe(1); // both dist 1 -> lowest
            expect(spreadPick([0, 1, 2], [3])).toBe(3);
        });

        it('returns -1 when nothing is open', () => {
            expect(spreadPick([0, 1], [])).toBe(-1);
        });
    });

    describe('spreadSeatPlan', () => {
        it('interleaves 2 humans + 2 bots so the humans are diagonal', () => {
            // The reported online bug: a 2-human, bot-filled room must not put the
            // humans on adjacent chairs. PLAYER seats land on 0 & 2 (a diagonal),
            // bots take 1 & 3 (the other diagonal).
            expect(spreadSeatPlan(4, 2, true)).toEqual(['PLAYER', 'BOT', 'PLAYER', 'BOT']);
        });

        it('seats a single human at 0 with bots filling the rest', () => {
            expect(spreadSeatPlan(4, 1, true)).toEqual(['PLAYER', 'BOT', 'BOT', 'BOT']);
        });

        it('closes seats beyond the active size', () => {
            expect(spreadSeatPlan(2, 1, true)).toEqual(['PLAYER', 'BOT', null, null]);
        });

        it('leaves every active seat a PLAYER when not bot-filling (full human match)', () => {
            expect(spreadSeatPlan(4, 4, false)).toEqual(['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER']);
        });
    });
});
