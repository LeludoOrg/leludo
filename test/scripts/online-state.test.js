import { describe, it, expect, beforeEach } from 'vitest';
import {
    setOnline, clearOnline, isOnlineActive,
    toLocal, toServer, onlineLocalSelf, onlineSeat, SELF_LOCAL,
} from '../../scripts/online-state.js';
import { HUMAN_PREFERRED_POSITIONS } from '../../scripts/game-logic.js';

/**
 * The online seat→board mapping mirrors offline play (HUMAN_PREFERRED_POSITIONS):
 * the local player always renders bottom-right (board position 2), the next
 * player diagonally opposite top-left (0), then 1 and 3. These guard that the
 * local user is always bottom-right in their own colour and the second player
 * sits top-left — the requested layout — for every seat the server might assign.
 */
describe('online-state seat → board-position mapping', () => {
    beforeEach(() => clearOnline());

    it('starts inactive and activates on setOnline', () => {
        expect(isOnlineActive()).toBe(false);
        setOnline({}, 1);
        expect(isOnlineActive()).toBe(true);
        expect(onlineSeat()).toBe(1);
    });

    it('always seats the local player bottom-right (position 2)', () => {
        for (let seat = 0; seat < 4; seat++) {
            setOnline({}, seat);
            expect(toLocal(seat)).toBe(2);       // self → bottom-right
            expect(onlineLocalSelf()).toBe(2);
        }
        expect(SELF_LOCAL).toBe(2);
        expect(HUMAN_PREFERRED_POSITIONS[0]).toBe(2); // shared source of truth
    });

    it('seats the second player (next in turn order) top-left (position 0)', () => {
        for (let seat = 0; seat < 4; seat++) {
            setOnline({}, seat);
            expect(toLocal((seat + 1) % 4)).toBe(0); // the player after me → top-left
        }
    });

    it('lays the remaining players out diagonal-first, matching offline', () => {
        setOnline({}, 0); // local is server seat 0
        // seats 0,1,2,3 → board positions 2,0,1,3 (HUMAN_PREFERRED_POSITIONS)
        expect([0, 1, 2, 3].map(toLocal)).toEqual([2, 0, 1, 3]);

        setOnline({}, 2); // local is server seat 2 — layout rotates with the seat
        // ranks from self: seat2→0th, seat3→1st, seat0→2nd, seat1→3rd
        expect([2, 3, 0, 1].map(toLocal)).toEqual([2, 0, 1, 3]);
    });

    it('seats a 2-player match diagonally for BOTH players, even on adjacent seats', () => {
        // A public 2-player match lands on server seats 0 and 1. Ranking must be
        // over the occupied seats, not raw seat numbers: otherwise seat 1's view
        // of seat 0 ranks 3 → board position 3 (bottom-left) and the opponent
        // is no longer diagonal. This is the exact bug the screenshot showed.
        setOnline({}, 0, [0, 1]);
        expect(toLocal(0)).toBe(2); // host: self bottom-right
        expect(toLocal(1)).toBe(0); // host: opponent top-left

        setOnline({}, 1, [0, 1]);   // the OTHER player's perspective
        expect(toLocal(1)).toBe(2); // self bottom-right
        expect(toLocal(0)).toBe(0); // opponent top-left (was 3/bottom-left before fix)
    });

    it('ranks over active seats for a 3-player match with a gap', () => {
        // Seats 0, 1, 3 occupied (seat 2 empty). The active order is [0,1,3];
        // each player sees self → 2, next active → 0, next → 1.
        setOnline({}, 3, [0, 1, 3]);
        expect(toLocal(3)).toBe(2); // self bottom-right
        expect(toLocal(0)).toBe(0); // next in turn order → top-left
        expect(toLocal(1)).toBe(1); // then top-right
    });

    it('toServer inverts toLocal over only the active seats', () => {
        setOnline({}, 1, [0, 1]);
        for (const s of [0, 1]) expect(toServer(toLocal(s))).toBe(s);
        setOnline({}, 3, [0, 1, 3]);
        for (const s of [0, 1, 3]) expect(toServer(toLocal(s))).toBe(s);
    });

    it('toServer is the exact inverse of toLocal for every seat', () => {
        for (let seat = 0; seat < 4; seat++) {
            setOnline({}, seat);
            for (let s = 0; s < 4; s++) {
                expect(toServer(toLocal(s))).toBe(s);
            }
        }
    });

    it('clearOnline resets to local-only mode', () => {
        setOnline({}, 3);
        clearOnline();
        expect(isOnlineActive()).toBe(false);
        expect(onlineSeat()).toBe(-1);
    });
});
