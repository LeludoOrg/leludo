import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Online delta animation (dice spins + pawn glides) under STREAMED frames.
 *
 * Regression (the live reports "pawns teleport — cell-by-cell motion is gone"
 * and "the dice roll gets skipped, especially for bots"): the server stamps the
 * next frame on the wire right after every delta. Rolls and moves shared no
 * common backlog gate — a move animated only if few newer MOVES trailed it, but
 * a roll animated only if it was the very newest delta, so a bot's roll-then-move
 * in one beat dropped the dice spin entirely (the move bumped the newest-delta
 * marker past the roll).
 *
 * The fix puts rolls and moves on ONE backlog counter: a delta animates while the
 * number of deltas received behind it is within MAX_DELTA_BACKLOG. So a roll spin
 * and the move that follows it both play, a trailing turn snapshot (not a delta)
 * never suppresses the move it follows, and a genuine burst still fast-forwards.
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
    for (let i = 0; i < 32 && gate.release; i++) {
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

    it('a dice roll trailed by its own move still spins (bot roll-and-move in one beat)', async () => {
        // The live "dice roll gets skipped for bots" case: a bot resolves a roll
        // and the move it produces in the same beat. Pre-fix the move bumped the
        // newest-delta marker past the roll, so the roll's spin was dropped. Now
        // rolls share the move backlog counter, so the spin plays. Hold the queue
        // with a prior in-flight roll so the pair below queue before either runs.
        handleOnlineMessage({
            t: MSG.STATE, seq: 1, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 2, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        await tick(); // first roll spin in flight, holding the queue

        // A second roll, immediately followed by the move it resolved.
        handleOnlineMessage({
            t: MSG.STATE, seq: 2, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 5, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        handleOnlineMessage({
            t: MSG.MOVED, seq: 3, p: 1, token: 0, from: -1, to: 4, caps: [],
            state: base([[-1, -1, -1, -1], [4, -1, -1, -1], null, null]),
        });

        await drain();

        const rolls = ofType('NET_APPLY_ROLL');
        expect(rolls).toHaveLength(2);
        expect(rolls[1].animate).toBe(true); // the trailing move must not skip the spin
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

    /** Queue `count` moves behind an in-flight animation; return their animate flags in order. */
    async function queueMoves(count) {
        // A prior in-flight roll holds the queue so every move below piles up before
        // any of them is processed.
        handleOnlineMessage({
            t: MSG.STATE, seq: 1, reason: REASON.ROLLED,
            state: base([[-1, -1, -1, -1], [-1, -1, -1, -1], null, null], { dice: 4, currentPlayerIndex: 1, phase: 'AWAIT_MOVE', legalMoves: [0] }),
        });
        await tick();
        for (let i = 0; i < count; i++) {
            handleOnlineMessage({
                t: MSG.MOVED, seq: 2 + i, p: 1, token: 0, from: i - 1, to: i, caps: [],
                state: base([[i, -1, -1, -1], [-1, -1, -1, -1], null, null]),
            });
        }
        await drain();
        return ofType('NET_APPLY_MOVE').map((m) => m.animate);
    }

    it('TOLERANCE: a small backlog (<= MAX_DELTA_BACKLOG newer deltas) still animates every move', async () => {
        // Transient bunching — a plays-again chain, a brief stall — should glide,
        // not teleport. Three moves stacked behind one roll: the oldest move has
        // only a few deltas behind it (well within the cap), so all three animate.
        expect(await queueMoves(3)).toEqual([true, true, true]);
    });

    it('CATCH-UP: a deep backlog (> MAX_DELTA_BACKLOG newer deltas) snaps the stale ones only', async () => {
        // Twelve moves stacked behind one roll → 13 deltas total. The oldest move
        // has 11 deltas behind it (over the cap of 10) → snap; once the remaining
        // backlog is within the cap of the freshest, moves glide again. Keeps
        // live-lag bounded without teleporting on every transient bunch.
        expect(await queueMoves(12)).toEqual([false, ...Array(11).fill(true)]);
    });
});
