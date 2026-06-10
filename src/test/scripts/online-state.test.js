import { describe, it, expect, beforeEach } from 'vitest';
import {
    setOnline, clearOnline, isOnlineActive,
    toLocal, toServer, onlineLocalSelf, onlineSeat, SELF_LOCAL,
} from '../../scripts/online-state.js';
import { HUMAN_PREFERRED_POSITIONS } from '../../scripts/game-logic.js';

/**
 * The online seat→board mapping always renders the local player bottom-right
 * (board position 2) in their own colour. The four server chairs form a ring
 * (turn order 0→1→2→3); each client rotates the whole ring so its chair sits
 * bottom-right, so EVERY chair — player OR empty — keeps its true cyclic slot
 * and every screen shows the identical seating, just rotated. For 3-4 players
 * that's a clockwise walk from self (BR → BL → TL → TR) over all four chairs,
 * matching the track's play order. 1-2 players are the exception: the two
 * occupied chairs spread to a diagonal head-to-head (opponent top-left) even
 * when the server seated them adjacently. These guard that the relative
 * "who's to my left / across" arrangement — empty seats included — is identical
 * on every screen. Board positions: 0=TL, 1=TR, 2=BR, 3=BL.
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

    it('seats the next player clockwise (bottom-left) in a 4-player game', () => {
        // With four players the layout is a true board rotation: the player after
        // me in the turn order sits one corner clockwise — bottom-left (3), NOT
        // top-left. (Top-left is the 2-player diagonal case, covered below.)
        for (let seat = 0; seat < 4; seat++) {
            setOnline({}, seat); // default activeSeats = all four
            expect(toLocal((seat + 1) % 4)).toBe(3); // next player → bottom-left
        }
    });

    it('lays four players out clockwise from self (BR → BL → TL → TR)', () => {
        setOnline({}, 0); // local is server seat 0
        // ranks 0,1,2,3 → board positions 2,3,0,1 (clockwise from bottom-right)
        expect([0, 1, 2, 3].map(toLocal)).toEqual([2, 3, 0, 1]);

        setOnline({}, 2); // local is server seat 2 — layout rotates with the seat
        // ranks from self: seat2→0th, seat3→1st, seat0→2nd, seat1→3rd
        expect([2, 3, 0, 1].map(toLocal)).toEqual([2, 3, 0, 1]);
    });

    it('renders the SAME cyclic neighbour order on every client (4-player)', () => {
        // Regression: [2,0,1,3] was not a board rotation, so when self changed
        // each client computed a different relative seating — seat 0's clockwise
        // neighbour was seat 3 on one screen but seat 1 on another (the bug the
        // two-screenshot report showed). Read the clockwise board order of seats
        // (TL→TR→BR→BL = positions 0,1,2,3) from each perspective; normalised so
        // seat 0 leads, they must ALL be the identical cycle.
        const cycleFrom = (selfSeat) => {
            setOnline({}, selfSeat, [0, 1, 2, 3]);
            const clockwise = [0, 1, 2, 3].map(toServer); // seat at each board pos
            const zero = clockwise.indexOf(0);
            return [0, 1, 2, 3].map((k) => clockwise[(zero + k) % 4]);
        };
        const reference = cycleFrom(0);
        expect(reference).toEqual([0, 1, 2, 3]); // clockwise = turn order
        for (let seat = 1; seat < 4; seat++) {
            expect(cycleFrom(seat)).toEqual(reference);
        }
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

    it('rotates the full four-chair ring for a 3-player match with a gap', () => {
        // Seats 0, 1, 3 occupied (seat 2 empty). The chairs are rotated as a ring
        // over ALL FOUR positions so the empty chair keeps its true slot, not
        // collapsed away. Self (3) bottom-right, then clockwise by raw distance.
        setOnline({}, 3, [0, 1, 3]);
        expect(toLocal(3)).toBe(2); // self bottom-right (distance 0)
        expect(toLocal(0)).toBe(3); // distance 1 → bottom-left
        expect(toLocal(1)).toBe(0); // distance 2 → top-left
        // The empty chair (seat 2) would land at distance 3 → top-right (1) —
        // its real rotational slot, NOT always bottom-left.
    });

    it('places an EMPTY chair consistently (same neighbours on every client)', () => {
        // Regression: a 3-player game leaves one chair empty (e.g. the screenshot:
        // red/green/yellow play, blue's chair is empty). Ranking only the occupied
        // chairs dumped the empty quad to a fixed corner, so which players flanked
        // it drifted from screen to screen. Rotating the whole ring fixes it: read
        // the clockwise board order of ALL four chairs (TL→TR→BR→BL = positions
        // 0,1,2,3) from each player's perspective; normalised so chair 0 leads,
        // they must be the identical cycle — empty chair included.
        const active = [0, 1, 2]; // chair 3 (blue) is the empty one
        const cycleFrom = (selfSeat) => {
            setOnline({}, selfSeat, active);
            const clockwise = [0, 1, 2, 3].map(toServer); // chair at each board pos
            const zero = clockwise.indexOf(0);
            return [0, 1, 2, 3].map((k) => clockwise[(zero + k) % 4]);
        };
        const reference = cycleFrom(0);
        expect(reference).toEqual([0, 1, 2, 3]); // chair 3 (empty) sits between 2 and 0
        for (const seat of active.slice(1)) {
            expect(cycleFrom(seat)).toEqual(reference);
        }
    });

    it('places 2-player EMPTY chairs consistently on adjacent server seats', () => {
        // Regression (the two-screenshot report): a 2-player match on ADJACENT
        // server seats (0,1) spreads the players to a diagonal, leaving two empty
        // quads. Those were coloured in board order on each screen, so the two
        // leftover colours swapped corners between the perspectives — a pawn sat
        // next to red on one screen, yellow on the other. The arrangement now
        // re-seats BOTH players AND empties as one shared rotation, so reading the
        // clockwise board order of all four chairs (positions 0,1,2,3) from each
        // perspective, normalised so chair 0 leads, must give the identical cycle.
        const active = [0, 1]; // adjacent — the matchmaker's 2-player default
        const cycleFrom = (selfSeat) => {
            setOnline({}, selfSeat, active);
            const clockwise = [0, 1, 2, 3].map(toServer); // chair at each board pos
            const zero = clockwise.indexOf(0);
            return [0, 1, 2, 3].map((k) => clockwise[(zero + k) % 4]);
        };
        const reference = cycleFrom(0);
        expect(cycleFrom(1)).toEqual(reference); // both screens: same ring, rotated
    });

    it('keeps the opponent diagonal AND empties consistent for adjacent 2P', () => {
        // Self always bottom-right (2), opponent top-left (0); the two empty
        // chairs take the other diagonal (top-right 1 / bottom-left 3) and land on
        // corners that are 180°-swapped between the two perspectives.
        setOnline({}, 0, [0, 1]);
        expect([0, 1, 2, 3].map(toLocal)).toEqual([2, 0, 3, 1]); // host frame
        setOnline({}, 1, [0, 1]);
        expect([0, 1, 2, 3].map(toLocal)).toEqual([0, 2, 1, 3]); // guest = host rotated 180°
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
