import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture every command the online driver dispatches without running the real
// (DOM-heavy) command handler. Partial mock: only `dispatch` is stubbed so the
// rest of the store wiring (setCommandHandler, EVENTS, subscribe) stays intact.
const recorded = vi.hoisted(() => []);
vi.mock('../../scripts/state/game-store.js', async (importOriginal) => ({
    ...(await importOriginal()),
    dispatch: (cmd) => { recorded.push(cmd); },
}));

import { buildSeatLayout, startOnlineGame, handleOnlineMessage } from '../../scripts/net/online-game.js';
import { clearOnline } from '../../scripts/net/online-state.js';
import { COMMANDS } from '../../scripts/state/command-handler.js';
import { MSG, REASON } from '../../scripts/net/net-protocol.js';

/** Flush the online driver's promise queue (enqueue chains on microtasks). */
const flush = () => new Promise((r) => setTimeout(r, 0));
const ofType = (t) => recorded.filter((c) => c.type === t);

/**
 * buildSeatLayout maps a server snapshot onto this client's board positions.
 * These guard the two bugs the live 2-player game surfaced: the opponent must
 * sit diagonally for BOTH players, and the colour map must stay a permutation
 * so an empty quad never repeats an active player's colour (the "two greens,
 * no yellow" board).
 */
describe('buildSeatLayout (online seat → board layout)', () => {
    beforeEach(() => clearOnline());

    // A 2-player public match on adjacent server seats 0 (red) and 1 (green).
    const twoPlayerState = {
        playerTypes: ['PLAYER', 'PLAYER', null, null],
        playerNames: ['Divya', 'Giddu', '', ''],
        positions: [[-1, -1, -1, -1], [-1, -1, -1, -1], null, null],
        currentPlayerIndex: 0,
    };

    it('keeps the colour map a permutation (no repeated colour, yellow present)', () => {
        // Before the fix this returned [1,1,0,3] for the non-host: two greens
        // (1) and no yellow (2). The empty quads must take the leftover colours.
        const host = buildSeatLayout({}, 0, twoPlayerState);
        expect([...host.colorMap].sort()).toEqual([0, 1, 2, 3]);

        const guest = buildSeatLayout({}, 1, twoPlayerState);
        expect([...guest.colorMap].sort()).toEqual([0, 1, 2, 3]);
        expect(guest.colorMap).toContain(2); // yellow is on the board
    });

    it('seats this client bottom-right in its own colour, opponent top-left', () => {
        // Guest = server seat 1 (green). Self at board pos 2 (bottom-right) shows
        // seat 1's colour; the opponent (seat 0) sits diagonally at pos 0.
        const guest = buildSeatLayout({}, 1, twoPlayerState);
        expect(guest.playerTypes[2]).toBe('PLAYER'); // self bottom-right
        expect(guest.colorMap[2]).toBe(1);           // in seat 1's colour (green)
        expect(guest.playerTypes[0]).toBe('PLAYER'); // opponent top-left
        expect(guest.colorMap[0]).toBe(0);           // seat 0's colour (red)
        expect(guest.playerNames[2]).toBe('Giddu');
        expect(guest.playerNames[0]).toBe('Divya');
    });

    it('colours the two empty quads consistently across both 2P screens', () => {
        // Regression (the two-screenshot report): the empty quads must be the same
        // board rotated, so a pawn sits next to the SAME colours on both screens.
        // The guest's whole colour map must be the host's rotated 180° (the two
        // players are diagonal), empty quads included — not the leftover colours
        // dropped into board order, which swapped red/yellow between the screens.
        const host = buildSeatLayout({}, 0, twoPlayerState).colorMap;
        const guest = buildSeatLayout({}, 1, twoPlayerState).colorMap;
        const rotated180 = [host[2], host[3], host[0], host[1]];
        expect(guest).toEqual(rotated180);
    });

    it('4-player game keeps every seat in its own colour (identity map)', () => {
        const state = {
            playerTypes: ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'],
            playerNames: ['A', 'B', 'C', 'D'],
            positions: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
            currentPlayerIndex: 0,
        };
        const view = buildSeatLayout({}, 2, state);
        expect([...view.colorMap].sort()).toEqual([0, 1, 2, 3]);
        // Self is server seat 2 → board pos 2 in seat 2's colour.
        expect(view.colorMap[2]).toBe(2);
    });
});

/**
 * Server reconciliation. The online client RENDERS by replaying the server's
 * roll/move deltas, but it re-derives captures locally and never ingested the
 * authoritative `positions` the server stamps on every frame — so one dropped
 * `moved` (a backgrounded tab, a 1s socket blip, a swallowed animation error)
 * left the board permanently diverged from the server and the other player. The
 * driver must now fold the snapshot back in: every `moved` and every `state`
 * frame (critically reason=RECONNECT, the only catch-up for moves missed while
 * offline) must enqueue NET_RECONCILE with the server board mapped to LOCAL
 * indexes. These tests FAIL before that wiring exists.
 */
describe('online reconciliation (server positions fold back into the render)', () => {
    // 2-player match on adjacent server seats 0 & 1, viewed from the host (seat 0).
    // The diagonal arrangement maps server seat 0 → local pos 2, seat 1 → local 0.
    const twoPlayerState = (positions, extra = {}) => ({
        started: true,
        playerTypes: ['PLAYER', 'PLAYER', null, null],
        playerNames: ['Host', 'Guest', '', ''],
        positions,
        currentPlayerIndex: 0,
        dice: 0,
        disconnects: [],
        ...extra,
    });

    beforeEach(() => {
        recorded.length = 0;
        clearOnline();
        startOnlineGame({ net: {}, seat: 0, state: twoPlayerState([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null]) });
        recorded.length = 0; // drop the NET_START_GAME from mount
    });

    it('a `moved` frame reconciles to the server board, mapped to local indexes', async () => {
        // Server seat 1 captured: its token0 is home (-1) on the server. A lagging
        // client would still show it on the track; the reconcile must carry the
        // server truth, remapped: seat 0 → local 2, seat 1 → local 0.
        const serverPositions = [[5, -1, -1, -1], [-1, 3, -1, -1], null, null];
        handleOnlineMessage({ t: MSG.MOVED, p: 0, token: 0, caps: [{ playerIndex: 1, tokenIndex: 0 }], state: twoPlayerState(serverPositions) });
        await flush();

        const reconciles = ofType(COMMANDS.NET_RECONCILE);
        expect(reconciles).toHaveLength(1);
        expect(reconciles[0].positions[2]).toEqual([5, -1, -1, -1]);  // server seat 0
        expect(reconciles[0].positions[0]).toEqual([-1, 3, -1, -1]);  // server seat 1 (captured token home)
        expect(reconciles[0].positions[1]).toBeUndefined();
        expect(reconciles[0].positions[3]).toBeUndefined();

        // It must run AFTER the move delta, so the snap settles on the final board.
        const moveIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_APPLY_MOVE);
        const recIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_RECONCILE);
        expect(moveIdx).toBeGreaterThanOrEqual(0);
        expect(recIdx).toBeGreaterThan(moveIdx);
    });

    it('forwards the server turn count to NET_SYNC_TURN so every client shows the same "Turn N"', async () => {
        // The displayed turn number is server-authoritative; a client must not tally
        // its own replay (which undercounts a missed turn — the live 218-vs-214 gap).
        handleOnlineMessage({ t: MSG.STATE, reason: REASON.TURN, state: twoPlayerState([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { turn: 217 }) });
        await flush();
        const syncs = ofType(COMMANDS.NET_SYNC_TURN);
        expect(syncs.length).toBeGreaterThanOrEqual(1);
        expect(syncs[syncs.length - 1].turnCount).toBe(217);
    });

    it('a reconnect `state` snapshot reconciles the board (catch-up for missed moves)', async () => {
        // Reconnect is the ONLY signal carrying the moves made while we were gone.
        const serverPositions = [[20, 14, -1, -1], [8, -1, -1, -1], null, null];
        handleOnlineMessage({ t: MSG.STATE, reason: REASON.RECONNECT, state: twoPlayerState(serverPositions) });
        await flush();

        const reconciles = ofType(COMMANDS.NET_RECONCILE);
        expect(reconciles).toHaveLength(1);
        expect(reconciles[0].positions[2]).toEqual([20, 14, -1, -1]); // server seat 0 → local 2
        expect(reconciles[0].positions[0]).toEqual([8, -1, -1, -1]);  // server seat 1 → local 0
    });
});
