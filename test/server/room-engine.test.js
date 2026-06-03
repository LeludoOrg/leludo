import { describe, it, expect, beforeEach } from 'vitest';
import { RoomEngine, PHASES } from '../../server/room-engine.js';

/**
 * Authority tests for the server-side game room. A fake transport collects every
 * broadcast / per-seat send; bot scheduling runs synchronously so turns resolve
 * inside the test. game-logic's dice is weighted, so we force specific rolls by
 * stubbing `engine.rng` with a constant in the band that maps to the value we
 * want (cumulative weights [1,3,5,6,8,10], maxWeight 10):
 *   0.05 -> 1, 0.7 -> 5, 0.85 -> 6.
 */
function makeFake() {
    const broadcasts = [];
    const sends = [];            // { seat, msg }
    let released = false;
    return {
        broadcasts,
        sends,
        get released() { return released; },
        transport: {
            broadcast: (msg) => broadcasts.push(msg),
            send: (seat, msg) => sends.push({ seat, msg }),
            release: () => { released = true; },
        },
        schedule: (fn) => fn(), // run bots immediately
    };
}

function twoHumanRoom(extra = {}) {
    const fake = makeFake();
    const engine = new RoomEngine({
        roomId: 'r1',
        playerTypes: ['PLAYER', 'PLAYER', undefined, undefined],
        transport: fake.transport,
        schedule: fake.schedule,
        ...extra,
    });
    return { fake, engine };
}

describe('RoomEngine — seating & start', () => {
    let fake, engine;
    beforeEach(() => ({ fake, engine } = twoHumanRoom()));

    it('stays in LOBBY until every human seat is claimed, then starts', () => {
        expect(engine.phase).toBe(PHASES.LOBBY);
        const a = engine.handleJoin('s0', 'A');
        expect(a).toEqual({ ok: true, seat: 0 });
        expect(engine.started).toBe(false);

        const b = engine.handleJoin('s1', 'B');
        expect(b).toEqual({ ok: true, seat: 1 });
        expect(engine.started).toBe(true);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
        expect(engine.currentPlayerIndex).toBe(0);
    });

    it('re-seats the same session on reconnect (same seat)', () => {
        engine.handleJoin('s0', 'A');
        engine.handleJoin('s1', 'B');
        const again = engine.handleJoin('s0', 'A');
        expect(again.seat).toBe(0);
    });

    it('sends a private `seated` message to the joining seat', () => {
        engine.handleJoin('s0', 'A');
        const seated = fake.sends.find(s => s.msg.t === 'seated');
        expect(seated).toMatchObject({ seat: 0, msg: { t: 'seated', playerIndex: 0 } });
    });
});

describe('RoomEngine — authority / rejection', () => {
    let fake, engine;
    beforeEach(() => {
        ({ fake, engine } = twoHumanRoom());
        engine.handleJoin('s0', 'A');
        engine.handleJoin('s1', 'B');
    });

    it('rejects a roll from the player whose turn it is NOT', () => {
        const before = JSON.stringify(engine.positions);
        const res = engine.handleRoll('s1'); // seat 1, but current is 0
        expect(res).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL); // unchanged
        expect(JSON.stringify(engine.positions)).toBe(before);
        // and the rejected seat got told why
        expect(fake.sends.some(s => s.seat === 1 && s.msg.t === 'rejected')).toBe(true);
    });

    it('rejects a move while still awaiting a roll', () => {
        const res = engine.handleMove('s0', 0);
        expect(res).toEqual({ ok: false, error: 'NOT_AWAITING_MOVE' });
    });

    it('rejects an illegal token (not in the server-computed legal set)', () => {
        engine.positions = [[10, 20, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // force dice = 5
        engine.handleRoll('s0');
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);
        expect(engine.legalMoves).toEqual([0, 1]); // tokens at 10 and 20 can move 5

        const before = JSON.stringify(engine.positions);
        const res = engine.handleMove('s0', 2); // token 2 is home, dice 5 — illegal
        expect(res).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
        expect(JSON.stringify(engine.positions)).toBe(before);
    });

    it('rejects a second roll once a roll is already pending a move', () => {
        engine.positions = [[10, 20, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7;
        engine.handleRoll('s0');
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);
        const res = engine.handleRoll('s0');
        expect(res).toEqual({ ok: false, error: 'NOT_AWAITING_ROLL' });
    });
});

describe('RoomEngine — rules fidelity', () => {
    let fake, engine;
    beforeEach(() => {
        ({ fake, engine } = twoHumanRoom());
        engine.handleJoin('s0', 'A');
        engine.handleJoin('s1', 'B');
    });

    it('auto-applies a forced single legal move (no second client message)', () => {
        engine.positions = [[10, -1, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5, only token 0 movable
        engine.handleRoll('s0');
        // forced move applied: token0 10 -> 15, turn passes to player 1
        expect(engine.positions[0][0]).toBe(15);
        expect(engine.currentPlayerIndex).toBe(1);
        expect(fake.broadcasts.some(b => b.t === 'moved')).toBe(true);
    });

    it('captures an opponent on a non-safe square and sends it home', () => {
        // p0 token at 0 (mark 0); p1 token at 44 (mark 5). p0 + dice 5 -> 5 (mark 5) captures.
        engine.positions = [[0, -1, -1, -1], [44, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5
        engine.handleRoll('s0');
        expect(engine.positions[0][0]).toBe(5);
        expect(engine.positions[1][0]).toBe(-1); // captured, sent home
        expect(engine.captures[0]).toBe(1);
    });

    it('grants another turn on a 6 (current player keeps the roll)', () => {
        // Other tokens finished so token 0 is the only legal move on the 6.
        engine.positions = [[10, 56, 56, 56], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.85; // dice 6
        engine.handleRoll('s0');
        // token0 10 -> 16, dice was 6 => same player rolls again
        expect(engine.positions[0][0]).toBe(16);
        expect(engine.currentPlayerIndex).toBe(0);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });

    it('loses the turn after three consecutive sixes', () => {
        engine.rng = () => 0.85; // every roll is a 6
        // roll 1 (six) -> 4 tokens leave home are legal; pick token 0
        engine.handleRoll('s0');
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);
        engine.handleMove('s0', 0);
        expect(engine.currentPlayerIndex).toBe(0); // plays again on the six
        // roll 2 (six)
        engine.handleRoll('s0');
        engine.handleMove('s0', 0);
        expect(engine.currentPlayerIndex).toBe(0);
        // roll 3 (six) -> three-sixes, turn forfeited to player 1
        engine.handleRoll('s0');
        expect(engine.currentPlayerIndex).toBe(1);
        expect(engine.consecutiveSixes).toBe(0);
    });

    it('ranks players and ends the game when the leader finishes', () => {
        engine.positions = [[50, 56, 56, 56], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.85; // dice 6: 50 -> 56 finishes the last token
        engine.handleRoll('s0');
        expect(engine.phase).toBe(PHASES.ENDED);
        expect(engine.ranks[0]).toBe(1);
        expect(engine.ranks[1]).toBe(2);
        expect(fake.released).toBe(true);
        expect(fake.broadcasts.some(b => b.t === 'ended')).toBe(true);
    });
});

describe('RoomEngine — server-driven bots', () => {
    it('auto-plays a bot seat to completion without any client input', () => {
        const fake = makeFake();
        const engine = new RoomEngine({
            roomId: 'rb',
            playerTypes: ['PLAYER', 'BOT', undefined, undefined],
            transport: fake.transport,
            schedule: fake.schedule, // synchronous bot turns
            botDelayMs: 0,
        });
        engine.handleJoin('s0', 'Human'); // only human seat -> game starts, bot fills seat 1
        expect(engine.started).toBe(true);
        // The human is seat 0 and starts; once the human's turn passes, the bot
        // takes its whole turn synchronously via the injected scheduler.
        expect(engine.playerTypes[1]).toBe('BOT');
        // Force a non-6 so each all-home roll yields no move and the turn passes.
        engine.rng = () => 0.7; // dice 5
        engine.handleRoll('s0'); // human: no move -> turn to bot; bot runs synchronously
        // Bot took its full turn via the injected scheduler (no client input) and,
        // also having no move on a 5, passed control back to the human.
        expect(engine.currentPlayerIndex).toBe(0);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });
});
