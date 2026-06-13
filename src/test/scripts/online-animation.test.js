import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Online move animation under STREAMED frames.
 *
 * Regression (the live report "pawns teleport — cell-by-cell motion is gone"):
 * the server stamps the next player's delta-less AWAIT_ROLL snapshot on the wire
 * right after every MOVED. The driver gated the move's glide on "is this still
 * the newest frame received?" — so that trailing snapshot (a higher seq, no
 * motion of its own) classified the move as stale backlog and snapped the pawn
 * straight to its target whenever the move was processed a beat late (any prior
 * animation still in flight). The fix gates on the newest *delta-bearing* frame,
 * so a trailing turn snapshot no longer suppresses the move it follows, while a
 * genuine backlog of moves still fast-forwards.
 *
 * dispatch is ASYNC here: an animated NET_APPLY_* holds the driver's serial queue
 * (a controllable gate) exactly like a real multi-cell glide / dice spin spanning
 * several macrotasks — the only way to reproduce frames arriving mid-animation.
 */
const recorded = vi.hoisted(() => []);
const gate = vi.hoisted(() => ({ release: null }));

vi.mock('../../scripts/state/game-store.js', async (importOriginal) => ({
    ...(await importOriginal()),
    dispatch: (cmd) => {
        recorded.push(cmd);
        if ((cmd.type === 'NET_APPLY_MOVE' || cmd.type === 'NET_APPLY_ROLL') && cmd.animate) {
            return new Promise((res) => { gate.release = res; });
        }
    },
}));

import { startOnlineGame, handleOnlineMessage } from '../../scripts/net/online-game.js';
import { clearOnline } from '../../scripts/net/online-state.js';
import { MSG, REASON } from '../../scripts/net/net-protocol.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const ofType = (t) => recorded.filter((c) => c.type === t);
/** Release the in-flight animation gate, if any, and let the queue advance. */
async function drain() {
    for (let i = 0; i < 8 && gate.release; i++) {
        const r = gate.release; gate.release = null; r(); await tick();
    }
}

const base = (positions, extra = {}) => ({
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

describe('online move animation under streamed frames', () => {
    beforeEach(() => {
        recorded.length = 0;
        gate.release = null;
        clearOnline();
        startOnlineGame({ net: {}, seat: 0, seq: 0, state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null]) });
        recorded.length = 0;
    });

    it('IDLE: a single move animates its glide', async () => {
        handleOnlineMessage({
            t: MSG.MOVED, seq: 1, p: 1, token: 0, from: -1, to: 5, caps: [],
            state: base([[-1, -1, -1, -1], [5, -1, -1, -1], null, null]),
        });
        await tick();
        const moves = ofType('NET_APPLY_MOVE');
        expect(moves).toHaveLength(1);
        expect(moves[0].animate).toBe(true);
        await drain();
    });

    it('STREAMED: a move trailed by its turn-snapshot still animates the glide', async () => {
        // Hold the queue with a prior in-flight roll so the move is processed
        // AFTER the (delta-less) next-turn snapshot has already been received.
        handleOnlineMessage({
            t: MSG.STATE, seq: 1, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 4, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        await tick(); // roll spin now in flight, holding the queue

        handleOnlineMessage({
            t: MSG.MOVED, seq: 2, p: 1, token: 0, from: -1, to: 4, caps: [],
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null]),
        });
        handleOnlineMessage({
            t: MSG.STATE, seq: 3, reason: REASON.TURN,
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null], { currentPlayerIndex: 0, turn: 2 }),
        });

        await drain();

        const moves = ofType('NET_APPLY_MOVE');
        expect(moves).toHaveLength(1);
        expect(moves[0].animate).toBe(true); // the trailing turn-snapshot must not skip it
    });

    it('a move trailed by the NEXT player\'s dice spin still animates (a roll must not teleport a pawn)', async () => {
        // The live "still jumps sometimes" case: a bot / auto-rolling opponent's
        // next dice spin arrives while THIS move is still gliding. A newer roll is
        // a delta, but it must NOT classify the pawn move as stale — only a newer
        // MOVE supersedes a move. Hold the queue with a prior in-flight roll.
        handleOnlineMessage({
            t: MSG.STATE, seq: 1, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 4, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        await tick(); // roll spin in flight, holding the queue

        handleOnlineMessage({
            t: MSG.MOVED, seq: 2, p: 1, token: 0, from: -1, to: 4, caps: [],
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null]),
        });
        // The next player's roll lands before the move above gets to animate.
        handleOnlineMessage({
            t: MSG.STATE, seq: 3, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null], { dice: 6, currentPlayerIndex: 0, phase: 'AWAIT_MOVE', legalMoves: [0], turn: 2 }),
        });

        await drain();

        const moves = ofType('NET_APPLY_MOVE');
        expect(moves).toHaveLength(1);
        expect(moves[0].animate).toBe(true); // the move glides; the later dice spin doesn't preempt it
    });

    it('BACKLOG: an older move SNAPS when a newer move is already queued (catch-up preserved)', async () => {
        // Genuine backlog: two real moves pile up behind an in-flight animation.
        // The older one fast-forwards (snap), only the newest animates — the
        // behaviour the seq gate exists to provide must survive the fix.
        handleOnlineMessage({
            t: MSG.STATE, seq: 1, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 4, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        await tick(); // roll spin in flight, holding the queue

        handleOnlineMessage({
            t: MSG.MOVED, seq: 2, p: 1, token: 0, from: -1, to: 4, caps: [],
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null]),
        });
        handleOnlineMessage({
            t: MSG.MOVED, seq: 3, p: 1, token: 1, from: -1, to: 6, caps: [],
            state: base([[-1, -1, -1, -1], [4, 6, -1, -1], null, null]),
        });

        await drain();

        const moves = ofType('NET_APPLY_MOVE');
        expect(moves).toHaveLength(2);
        expect(moves[0].animate).toBe(false); // older move: snap to catch up
        expect(moves[1].animate).toBe(true);  // newest move: animate
    });
});
