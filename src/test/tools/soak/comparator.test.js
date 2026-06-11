import { describe, it, expect } from 'vitest';
import { toSeatSpace, compareObservation, failingMismatches, STRICTNESS } from '../../../../tools/soak/comparator.mjs';

/**
 * The comparator is the soak harness's correctness core: it projects a client's
 * LOCAL-indexed belief back into SEAT space (using the client's own toServer map)
 * and reports where it diverges from the server. These guard the seat
 * normalization (incl. the ≤2-player diagonal, the exact bug surface that desynced
 * live) and the per-field invariants.
 */

// Seat 0's mapping in a 2-player diagonal game (online-state computeArrangement
// for activeSeats [0,1]): localToSeat = [toServer(0..3)] = [1, 3, 0, 2].
const SEAT0_2P_MAP = [1, 3, 0, 2];

// A consistent 2-player snapshot: server seat 0 = [5,-1,-1,-1], seat 1 = [-1,3,-1,-1].
const server2p = (extra = {}) => ({
    phase: 'AWAIT_ROLL', turn: 10, currentPlayerIndex: 0, dice: 0,
    positions: [[5, -1, -1, -1], [-1, 3, -1, -1], null, null],
    playerTypes: ['PLAYER', 'PLAYER', null, null], ...extra,
});

// The matching client belief from seat 0: positionsLocal[local] where
// seat = localToSeat[local]. seat0→local2, seat1→local0 → local2=[5,…], local0=[-1,3,…].
const client2p = (extra = {}) => ({
    seat: 0, localToSeat: SEAT0_2P_MAP,
    currentPlayerIndexLocal: 2,          // local2 == server seat 0
    turnCountDisplayed: 10, turnCountState: 10, dice: 0, phase: 'AWAITING_ROLL',
    positionsLocal: [[-1, 3, -1, -1], null, [5, -1, -1, -1], null],
    ...extra,
});

describe('toSeatSpace (local → seat projection)', () => {
    it('inverts the 2-player diagonal mapping back to seat space', () => {
        const { positionsBySeat, currentSeat } = toSeatSpace(client2p());
        expect(positionsBySeat[0]).toEqual([5, -1, -1, -1]); // server seat 0
        expect(positionsBySeat[1]).toEqual([-1, 3, -1, -1]); // server seat 1
        expect(positionsBySeat[2]).toBeNull();
        expect(positionsBySeat[3]).toBeNull();
        expect(currentSeat).toBe(0); // currentPlayerIndexLocal 2 → seat 0
    });

    it('handles the 4-player identity mapping', () => {
        const client = {
            localToSeat: [0, 1, 2, 3], currentPlayerIndexLocal: 1,
            positionsLocal: [[0], [1], [2], [3]],
        };
        const { positionsBySeat, currentSeat } = toSeatSpace(client);
        expect(positionsBySeat).toEqual([[0], [1], [2], [3]]);
        expect(currentSeat).toBe(1);
    });
});

describe('compareObservation', () => {
    it('a perfectly synced 2-player observation has zero mismatches', () => {
        const r = compareObservation({ server: server2p(), client: client2p() });
        expect(r.ok).toBe(true);
        expect(r.mismatches).toEqual([]);
    });

    it('flags a drifted token position (the reconcile-bug class), mapped to seat', () => {
        // Client thinks server seat 0's token0 is still at 4, not 5.
        const client = client2p({ positionsLocal: [[-1, 3, -1, -1], null, [4, -1, -1, -1], null] });
        const r = compareObservation({ server: server2p(), client });
        const pos = r.mismatches.find((m) => m.field === 'positions');
        expect(pos).toBeTruthy();
        expect(pos.seat).toBe(0);
        expect(pos.server).toEqual([5, -1, -1, -1]);
        expect(pos.client).toEqual([4, -1, -1, -1]);
    });

    it('flags a turn-count drift (the reported headline symptom)', () => {
        const r = compareObservation({ server: server2p({ turn: 218 }), client: client2p({ turnCountDisplayed: 214 }) });
        const turn = r.mismatches.find((m) => m.field === 'turn');
        expect(turn).toMatchObject({ server: 218, client: 214 });
    });

    it('treats server null and client undefined empty seats as equal', () => {
        // Empty seats (2,3) are null on server, null/undefined on client — no mismatch.
        const client = client2p({ positionsLocal: [[-1, 3, -1, -1], undefined, [5, -1, -1, -1], undefined] });
        const r = compareObservation({ server: server2p(), client });
        expect(r.mismatches.filter((m) => m.field === 'positions' || m.field === 'activation')).toEqual([]);
    });

    it('only compares dice while a roll is live (AWAIT_MOVE)', () => {
        // AWAIT_ROLL: server zeroes dice, client keeps last face — must NOT flag.
        const r1 = compareObservation({ server: server2p({ phase: 'AWAIT_ROLL', dice: 0 }), client: client2p({ dice: 6 }) });
        expect(r1.mismatches.find((m) => m.field === 'dice')).toBeFalsy();
        // AWAIT_MOVE: dice is authoritative — a mismatch IS flagged.
        const r2 = compareObservation({
            server: server2p({ phase: 'AWAIT_MOVE', dice: 5 }),
            client: client2p({ phase: 'AWAITING_SELECTION', dice: 4 }),
        });
        expect(r2.mismatches.find((m) => m.field === 'dice')).toMatchObject({ server: 5, client: 4 });
    });

    it('maps server phase names to client phase names', () => {
        const r = compareObservation({
            server: server2p({ phase: 'AWAIT_MOVE' }),
            client: client2p({ phase: 'AWAITING_ROLL' }), // wrong (should be AWAITING_SELECTION)
        });
        expect(r.mismatches.find((m) => m.field === 'phase')).toMatchObject({ server: 'AWAIT_MOVE', client: 'AWAITING_ROLL' });
    });
});

describe('failingMismatches (strictness)', () => {
    const all = [
        { field: 'positions', severity: 'core' },
        { field: 'turn', severity: 'core' },
        { field: 'phase', severity: 'aux' },
        { field: 'dice', severity: 'aux' },
    ];
    it('positions-only keeps just positions + turn', () => {
        const out = failingMismatches(all, STRICTNESS.POSITIONS_ONLY).map((m) => m.field);
        expect(out.sort()).toEqual(['positions', 'turn']);
    });
    it('strict / eventual keep every field', () => {
        expect(failingMismatches(all, STRICTNESS.STRICT)).toHaveLength(4);
        expect(failingMismatches(all, STRICTNESS.EVENTUAL)).toHaveLength(4);
    });
});
