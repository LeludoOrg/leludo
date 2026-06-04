import { describe, it, expect } from 'vitest';
import { RoomEngine, PHASES } from '../../server/room-engine.js';
import { PITY_SIX_CEIL } from '../../scripts/game-logic.js';

/**
 * Authority + host-lobby tests. A fake transport collects every broadcast /
 * per-seat send; bots run synchronously via the injected scheduler. Dice are
 * weighted, so we force rolls by stubbing `engine.rng` with a constant in the
 * band that maps to the value we want (cumulative weights [1,3,5,7,9,12]):
 *   0.05 -> 1, 0.7 -> 5, 0.85 -> 6.
 */
function makeFake() {
    const broadcasts = [];
    const sends = [];
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
        schedule: (fn) => fn(),
    };
}

function room(size = 2) {
    const fake = makeFake();
    const engine = new RoomEngine({ roomId: 'r', size, transport: fake.transport, schedule: fake.schedule });
    return { fake, engine };
}

/** Host + guest seated and the host has started a 2-human game. */
function started2() {
    const { fake, engine } = room(2);
    engine.handleJoin('h', 'Host');
    engine.handleJoin('g', 'Guest');
    engine.handleStart('h');
    return { fake, engine };
}

describe('RoomEngine — host lobby', () => {
    it('makes the first joiner the host and does NOT auto-start when full', () => {
        const { engine } = room(2);
        expect(engine.handleJoin('h', 'Host')).toEqual({ ok: true, seat: 0 });
        expect(engine.handleJoin('g', 'Guest')).toEqual({ ok: true, seat: 1 });
        expect(engine.hostSession).toBe('h');     // first in is host
        expect(engine._hostSeat()).toBe(0);
        expect(engine.started).toBe(false);        // waits for the host
        expect(engine.phase).toBe(PHASES.LOBBY);
    });

    it('tells the joining seat whether it is the host', () => {
        const { fake, engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        const hostSeated = fake.sends.find(s => s.msg.t === 'seated' && s.seat === 0);
        const guestSeated = fake.sends.find(s => s.msg.t === 'seated' && s.seat === 1);
        expect(hostSeated.msg.isHost).toBe(true);
        expect(guestSeated.msg.isHost).toBe(false);
    });

    it('only the host can start; a non-host start is rejected', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        expect(engine.handleStart('g')).toEqual({ ok: false, error: 'NOT_HOST' });
        expect(engine.started).toBe(false);
        expect(engine.handleStart('h')).toEqual({ ok: true });
        expect(engine.started).toBe(true);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });

    it('fills open human seats with bots on start', () => {
        const { engine } = room(3);     // 3 seats, only the host joins
        engine.handleJoin('h', 'Host');
        engine.handleStart('h');
        expect(engine.playerTypes[0]).toBe('PLAYER'); // host
        expect(engine.playerTypes[1]).toBe('BOT');    // open -> bot
        expect(engine.playerTypes[2]).toBe('BOT');    // open -> bot
    });

    it('host can grow and shrink the room size', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleSetSize('h', 4);
        expect(engine._activeCount()).toBe(4);
        engine.handleSetSize('h', 2);
        expect(engine._activeCount()).toBe(2);
        // never closes below two
        engine.handleSetSize('h', 1);
        expect(engine._activeCount()).toBe(2);
    });

    it('host can set a seat to a bot', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleSetSeat('h', 1, 'BOT');
        expect(engine.seats[1].type).toBe('BOT');
        expect(engine.seats[1].sessionId).toBe(null);
    });

    it('host can kick a player, reopening the seat and notifying them', () => {
        const { fake, engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        expect(engine.seats[1].sessionId).toBe('g');
        expect(engine.handleKick('h', 1)).toEqual({ ok: true });
        expect(engine.seats[1].sessionId).toBe(null);   // seat reopened
        expect(engine.seats[1].type).toBe('PLAYER');
        expect(fake.sends.some(s => s.seat === 1 && s.msg.t === 'kicked')).toBe(true);
    });

    it('a non-host cannot change the room, and the host cannot be kicked', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        expect(engine.handleSetSize('g', 4)).toEqual({ ok: false, error: 'NOT_HOST' });
        expect(engine.handleSetSeat('g', 0, 'BOT')).toEqual({ ok: false, error: 'NOT_HOST' });
        expect(engine.handleKick('g', 0)).toEqual({ ok: false, error: 'NOT_HOST' });
        expect(engine.handleKick('h', 0)).toEqual({ ok: false, error: 'CANT_KICK_HOST' });
    });

    it('auto-starts a public room once every human seat is filled', () => {
        const fake = makeFake();
        const engine = new RoomEngine({ roomId: 'r', size: 2, autoStart: true, transport: fake.transport, schedule: fake.schedule });
        engine.handleJoin('a', 'A');
        expect(engine.started).toBe(false); // 1/2, still waiting
        engine.handleJoin('b', 'B');
        expect(engine.started).toBe(true);  // full -> auto-start, no host action
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });

    it('auto-starts a public bot-filled room after the lone human joins', () => {
        const fake = makeFake();
        const engine = new RoomEngine({ roomId: 'r', seatPlan: ['PLAYER', 'BOT', null, null], autoStart: true, transport: fake.transport, schedule: fake.schedule });
        engine.handleJoin('a', 'A');
        expect(engine.started).toBe(true);
        expect(engine.playerTypes[1]).toBe('BOT');
    });

    it('does NOT auto-start a private room (host must press start)', () => {
        const { engine } = room(2); // autoStart defaults to false
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        expect(engine.started).toBe(false);
    });

    it('promotes a new host when the host leaves the lobby', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        engine.handleDisconnect('h');
        expect(engine.hostSession).toBe('g'); // guest promoted
        expect(engine.seats[0].sessionId).toBe(null); // host seat reopened
    });
});

describe('RoomEngine — in-game authority', () => {
    it('rejects a roll from the player whose turn it is NOT', () => {
        const { engine } = started2();
        const before = JSON.stringify(engine.positions);
        const res = engine.handleRoll('g'); // seat 1, current is 0
        expect(res).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });
        expect(JSON.stringify(engine.positions)).toBe(before);
    });

    it('rejects a move while still awaiting a roll', () => {
        const { engine } = started2();
        expect(engine.handleMove('h', 0)).toEqual({ ok: false, error: 'NOT_AWAITING_MOVE' });
    });

    it('rejects an illegal token (not in the server-computed legal set)', () => {
        const { engine } = started2();
        engine.positions = [[10, 20, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5
        engine.handleRoll('h');
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);
        expect(engine.legalMoves).toEqual([0, 1]);
        const before = JSON.stringify(engine.positions);
        expect(engine.handleMove('h', 2)).toEqual({ ok: false, error: 'ILLEGAL_MOVE' });
        expect(JSON.stringify(engine.positions)).toBe(before);
    });
});

describe('RoomEngine — rules fidelity', () => {
    it('auto-applies a forced single legal move', () => {
        const { fake, engine } = started2();
        engine.positions = [[10, -1, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5, only token 0 movable
        engine.handleRoll('h');
        expect(engine.positions[0][0]).toBe(15);
        expect(engine.currentPlayerIndex).toBe(1);
        expect(fake.broadcasts.some(b => b.t === 'moved')).toBe(true);
    });

    it('captures an opponent on a non-safe square', () => {
        const { engine } = started2();
        engine.positions = [[0, -1, -1, -1], [44, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5: 0 -> 5 (mark 5) captures p1 at 44 (mark 5)
        engine.handleRoll('h');
        expect(engine.positions[0][0]).toBe(5);
        expect(engine.positions[1][0]).toBe(-1);
        expect(engine.captures[0]).toBe(1);
    });

    it('grants another turn on a 6', () => {
        const { engine } = started2();
        engine.positions = [[10, 56, 56, 56], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.85; // dice 6, only token 0 legal
        engine.handleRoll('h');
        expect(engine.positions[0][0]).toBe(16);
        expect(engine.currentPlayerIndex).toBe(0);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });

    it('loses the turn after three consecutive sixes', () => {
        const { engine } = started2();
        engine.rng = () => 0.85; // every roll is a 6
        engine.handleRoll('h');
        engine.handleMove('h', 0);
        expect(engine.currentPlayerIndex).toBe(0);
        engine.handleRoll('h');
        engine.handleMove('h', 0);
        expect(engine.currentPlayerIndex).toBe(0);
        engine.handleRoll('h'); // third six -> forfeit
        expect(engine.currentPlayerIndex).toBe(1);
        expect(engine.consecutiveSixes).toBe(0);
    });

    it('ranks players and ends when the leader finishes', () => {
        const { fake, engine } = started2();
        engine.positions = [[50, 56, 56, 56], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.85; // dice 6: 50 -> 56 finishes
        engine.handleRoll('h');
        expect(engine.phase).toBe(PHASES.ENDED);
        expect(engine.ranks[0]).toBe(1);
        expect(engine.ranks[1]).toBe(2);
        expect(fake.released).toBe(true);
        expect(fake.broadcasts.some(b => b.t === 'ended')).toBe(true);
    });

    // Regression: an online player stuck in the yard could never roll a six and
    // sat out the whole game. After a long no-move drought the server forces a
    // six so the pawn finally launches. rng=0.7 normally rolls a 5 (no move with
    // all pawns home), so the six can only come from the pity rule.
    it('grants a pity six to a player stranded in the yard', () => {
        const { fake, engine } = started2();
        engine.positions = [[-1, -1, -1, -1], [-1, -1, -1, -1], null, null];
        engine.noMoveStreak[0] = PITY_SIX_CEIL; // long drought for the current seat
        engine.rng = () => 0.7;                 // a normal roll would be a 5 (no move)
        engine.handleRoll('h');
        const rolled = [...fake.broadcasts].reverse().find(b => b.reason === 'rolled' || b.reason === 'no-move');
        expect(rolled.state.dice).toBe(6);          // pity six, not the 5 the rng gives
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE); // a launch is now possible
        expect(engine.noMoveStreak[0]).toBe(0);       // drought cleared once movable
    });
});

describe('RoomEngine — server-driven bots', () => {
    it('auto-plays a bot seat with no client input', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Human');
        engine.handleSetSeat('h', 1, 'BOT'); // host adds a bot
        engine.handleStart('h');
        expect(engine.playerTypes[1]).toBe('BOT');
        engine.rng = () => 0.7; // dice 5: all-home rolls pass
        engine.handleRoll('h');  // human passes -> bot takes its turn synchronously -> back to human
        expect(engine.currentPlayerIndex).toBe(0);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });
});
