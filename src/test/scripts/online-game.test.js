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
 * Authoritative frame ingest. The server stamps a full snapshot on every frame
 * and the driver must apply it UNCONDITIONALLY after the frame's cosmetic
 * delta — so one dropped/guarded/drifted delta (a backgrounded tab, a paused
 * client, a 1s socket blip, a swallowed animation error) can never leave the
 * board diverged past the frame that follows. These guard the desync class the
 * old replay-only pipeline shipped: clients visibly out of sync for a turn or
 * more until a later snapshot happened to repair them.
 */
describe('online frame ingest (server snapshot is the last word)', () => {
    // 2-player match on adjacent server seats 0 & 1, viewed from the host (seat 0).
    // The diagonal arrangement maps server seat 0 → local pos 2, seat 1 → local 0.
    const twoPlayerState = (positions, extra = {}) => ({
        started: true,
        playerTypes: ['PLAYER', 'PLAYER', null, null],
        playerNames: ['Host', 'Guest', '', ''],
        positions,
        currentPlayerIndex: 0,
        dice: 0,
        legalMoves: [],
        captures: [0, 0, 0, 0],
        ranks: [0, 0, 0, 0],
        phase: 'AWAIT_ROLL',
        disconnects: [],
        ...extra,
    });

    beforeEach(() => {
        recorded.length = 0;
        clearOnline();
        startOnlineGame({ net: {}, seat: 0, state: twoPlayerState([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null]) });
        recorded.length = 0; // drop the NET_START_GAME from mount
    });

    it('a `moved` frame applies the move delta from the payload, then the snapshot', async () => {
        // Captures come from the server's `caps`, never re-derived from the local
        // board (re-deriving them on a drifted board sent the wrong pawns home).
        const serverPositions = [[5, -1, -1, -1], [-1, 3, -1, -1], null, null];
        handleOnlineMessage({
            t: MSG.MOVED, p: 0, token: 0, from: -1, to: 5,
            caps: [{ playerIndex: 1, tokenIndex: 0 }],
            state: twoPlayerState(serverPositions),
        });
        await flush();

        const moves = ofType(COMMANDS.NET_APPLY_MOVE);
        expect(moves).toHaveLength(1);
        expect(moves[0].playerIndex).toBe(2);            // server seat 0 → local 2
        expect(moves[0].tokenIndex).toBe(0);
        expect(moves[0].fromPosition).toBe(-1);
        expect(moves[0].toPosition).toBe(5);
        expect(moves[0].captures).toEqual([{ playerIndex: 0, tokenIndex: 0 }]); // seat 1 → local 0

        // The authoritative snapshot lands AFTER the delta, mapped to local.
        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs).toHaveLength(1);
        expect(syncs[0].positions[2]).toEqual([5, -1, -1, -1]);  // server seat 0
        expect(syncs[0].positions[0]).toEqual([-1, 3, -1, -1]);  // server seat 1 (captured token home)
        expect(syncs[0].positions[1]).toBeUndefined();
        expect(syncs[0].positions[3]).toBeUndefined();
        const moveIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_APPLY_MOVE);
        const syncIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_SYNC_STATE);
        expect(syncIdx).toBeGreaterThan(moveIdx);
    });

    it('forwards the server turn count so every client shows the same "Turn N"', async () => {
        // The displayed turn number is server-authoritative; a client must not tally
        // its own replay (which undercounts a missed turn — the live 218-vs-214 gap).
        handleOnlineMessage({ t: MSG.STATE, reason: REASON.TURN, state: twoPlayerState([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { turn: 217 }) });
        await flush();
        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs.length).toBeGreaterThanOrEqual(1);
        expect(syncs[syncs.length - 1].turnCount).toBe(217);
    });

    it('a reconnect snapshot restores board AND phase/movable (catch-up for missed moves)', async () => {
        // Reconnect is the ONLY signal carrying what happened while we were gone.
        // Restoring positions but not phase used to leave a client that came back
        // mid-AWAIT_MOVE stuck AWAITING_ROLL — its roll intents rejected, the
        // server waiting for a move it could never send: the whole room hung.
        const serverPositions = [[20, 14, -1, -1], [8, -1, -1, -1], null, null];
        handleOnlineMessage({
            t: MSG.STATE, reason: REASON.RECONNECT,
            state: twoPlayerState(serverPositions, { phase: 'AWAIT_MOVE', dice: 4, legalMoves: [0, 1] }),
        });
        await flush();

        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs).toHaveLength(1);
        expect(syncs[0].positions[2]).toEqual([20, 14, -1, -1]); // server seat 0 → local 2
        expect(syncs[0].positions[0]).toEqual([8, -1, -1, -1]);  // server seat 1 → local 0
        expect(syncs[0].phase).toBe('AWAIT_MOVE');
        expect(syncs[0].dice).toBe(4);
        expect(syncs[0].legalMoves).toEqual([0, 1]);
    });

    it('drops duplicate/stale frames by seq (zombie socket racing a reconnect)', async () => {
        const frame = (seq, turn) => ({
            t: MSG.STATE, reason: REASON.TURN, seq,
            state: twoPlayerState([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { turn }),
        });
        handleOnlineMessage(frame(5, 10));
        handleOnlineMessage(frame(5, 10)); // duplicate delivery
        handleOnlineMessage(frame(4, 9));  // stale frame from the old socket
        handleOnlineMessage(frame(6, 11));
        await flush();
        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs).toHaveLength(2);
        expect(syncs.map(s => s.turnCount)).toEqual([10, 11]);
    });

    it('a REJECTED intent re-applies the newest snapshot (self-heal, not a black hole)', async () => {
        // The server refusing one of our intents means our local view was wrong.
        // Before the fix the client ignored REJECTED entirely and stayed wrong
        // until some later broadcast happened to repair it.
        handleOnlineMessage({ t: MSG.STATE, reason: REASON.TURN, state: twoPlayerState([[7, -1, -1, -1], [-1, -1, -1, -1], null, null], { turn: 12 }) });
        await flush();
        recorded.length = 0;

        handleOnlineMessage({ t: MSG.REJECTED, error: 'NOT_AWAITING_ROLL' });
        await flush();
        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs).toHaveLength(1);
        expect(syncs[0].positions[2]).toEqual([7, -1, -1, -1]);
        expect(syncs[0].turnCount).toBe(12);
    });

    /**
     * A FINISH-driven end where the client MISSED the final `moved` frame. The
     * ENDED frame carries the authoritative positions + ranks for EVERY reason,
     * so the driver must sync the board AND drive NET_END — the client can't
     * reach GAME_ENDED on its own without the finishing move.
     */
    it('syncs + ends on a FINISHED end even when the finishing `moved` was dropped', async () => {
        // Server: seat 0 finished all four (winner), seat 1 trails. The matching
        // `moved` (token0 → 56) was never delivered to this client.
        const serverPositions = [[56, 56, 56, 56], [55, 30, -1, -1], null, null];
        handleOnlineMessage({
            t: MSG.ENDED,
            reason: REASON.FINISHED,
            ranks: [1, 2, 0, 0],
            state: twoPlayerState(serverPositions, { phase: 'ENDED', ranks: [1, 2, 0, 0] }),
        });
        await flush();

        // Board syncs to the server truth, remapped: seat 0 → local 2, seat 1 → local 0.
        const syncs = ofType(COMMANDS.NET_SYNC_STATE);
        expect(syncs).toHaveLength(1);
        expect(syncs[0].positions[2]).toEqual([56, 56, 56, 56]); // finishing seat snapped to done
        expect(syncs[0].positions[0]).toEqual([55, 30, -1, -1]);

        // And the client is driven to the ended state with the server's ranks +
        // mapped winner.
        const ends = ofType(COMMANDS.NET_END);
        expect(ends).toHaveLength(1);
        expect(ends[0].playerRanks[2]).toBe(1); // seat 0 → local 2, rank 1
        expect(ends[0].playerRanks[0]).toBe(2); // seat 1 → local 0, rank 2
        expect(ends[0].winnerIndex).toBe(2);    // winner remapped to local 2

        // The board must settle on truth BEFORE the end flips to GAME_ENDED
        // (netSyncState no-ops once ended).
        const syncIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_SYNC_STATE);
        const endIdx = recorded.findIndex((c) => c.type === COMMANDS.NET_END);
        expect(syncIdx).toBeGreaterThanOrEqual(0);
        expect(endIdx).toBeGreaterThan(syncIdx);
    });
});
