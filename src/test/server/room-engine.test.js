import { describe, it, expect } from 'vitest';
import { RoomEngine, PHASES } from '../../server/room-engine.js';
import { PITY_SIX_CEIL } from '../../scripts/core/game-logic.js';
import { BOT_NAME_POOLS } from '../../scripts/core/bot-names.js';
import { PERSONALITIES } from '../../scripts/core/bot-ai.js';
import { makeRng } from '../../scripts/core/game-driver.js';

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

    // An online game is human-vs-human: a lone host can't start a solo-vs-bots
    // match (that's offline play). Two REAL players must be seated first — a bot
    // in the other chair doesn't satisfy the minimum.
    it('rejects start until a second human joins (a bot does not count)', () => {
        const { engine } = room(4);
        engine.handleJoin('h', 'Host');          // 1 human
        engine.handleSetSeat('h', 1, 'BOT');     // + a bot, still only 1 human
        expect(engine.handleStart('h')).toEqual({ ok: false, error: 'NEED_TWO_PLAYERS' });
        expect(engine.started).toBe(false);
        engine.handleJoin('g', 'Guest');         // a 2nd human arrives
        expect(engine.handleStart('h')).toEqual({ ok: true });
        expect(engine.started).toBe(true);
    });

    // The seat index doubles as the player's colour, so a joiner can request
    // their colour by asking for that seat. Honoured when free, else fall back.
    it('seats a joiner in their requested colour when it is free', () => {
        const { engine } = room(4);
        expect(engine.handleJoin('a', 'A', 2)).toEqual({ ok: true, seat: 2 });
        expect(engine.handleJoin('b', 'B', 3)).toEqual({ ok: true, seat: 3 });
    });

    it('falls back to the seat furthest from those taken when the requested colour is taken', () => {
        const { engine } = room(4);
        engine.handleJoin('a', 'A', 2);                                  // takes seat 2
        // Seat 0 is the chair diagonally opposite seat 2 (furthest away).
        expect(engine.handleJoin('b', 'B', 2)).toEqual({ ok: true, seat: 0 });
    });

    // Regression: an online "you vs a friend" game (2 humans + 2 auto-bots in a
    // 4-seat room) used to seat the joiner on the chair ADJACENT to the host
    // (lowest open), so the two humans never rendered diagonally opposite. They
    // must land on a diagonal, with the bots filling the other diagonal.
    it('seats two humans diagonally opposite in a 4-seat room, bots on the other diagonal', () => {
        const fake = makeFake();
        const engine = new RoomEngine({ roomId: 'r', size: 4, transport: fake.transport, schedule: fake.schedule });
        expect(engine.handleJoin('h', 'Host')).toEqual({ ok: true, seat: 0 }); // host, no colour pick -> seat 0
        expect(engine.handleJoin('g', 'Guest')).toEqual({ ok: true, seat: 2 }); // joiner -> diagonal, not adjacent
        engine.handleStart('h');
        expect(engine.seats.map(s => s.type)).toEqual(['PLAYER', 'BOT', 'PLAYER', 'BOT']);
    });

    it('respects the host colour pick and still seats the joiner diagonally opposite', () => {
        const fake = makeFake();
        const engine = new RoomEngine({ roomId: 'r', size: 4, transport: fake.transport, schedule: fake.schedule });
        expect(engine.handleJoin('h', 'Host', 3)).toEqual({ ok: true, seat: 3 }); // host picks blue (seat 3)
        expect(engine.handleJoin('g', 'Guest')).toEqual({ ok: true, seat: 1 });   // diagonal to 3
    });

    it('ignores an out-of-range or closed preferred seat', () => {
        const { engine } = room(2);                                      // seats 2,3 closed
        expect(engine.handleJoin('a', 'A', 3)).toEqual({ ok: true, seat: 0 }); // closed → lowest open
        expect(engine.handleJoin('b', 'B', 9)).toEqual({ ok: true, seat: 1 }); // out of range → lowest open
    });

    it('keeps your seat on reconnect, ignoring a fresh colour request', () => {
        const { engine } = room(4);
        engine.handleJoin('a', 'A', 1);                                  // seat 1
        expect(engine.handleJoin('a', 'A', 3)).toEqual({ ok: true, seat: 1 }); // reconnect → same seat
    });

    // Name + colour are picked in the lobby now (not on the entry screen), via
    // handleProfile. A rename sets your seat name; a colour pick moves you to that
    // open seat (the seat index doubles as the colour).
    describe('handleProfile (lobby name + colour)', () => {
        it('renames your own seat, clamped to 12 chars', () => {
            const { engine } = room(2);
            engine.handleJoin('h', 'Host');
            expect(engine.handleProfile('h', { name: '  Newby  ' })).toEqual({ ok: true, seat: 0 });
            expect(engine.seats[0].name).toBe('Newby');                 // trimmed
            engine.handleProfile('h', { name: 'x'.repeat(40) });
            expect(engine.seats[0].name).toHaveLength(12);              // clamped
        });

        it('moves you to a free colour and reopens the chair you left', () => {
            const { engine } = room(4);
            engine.handleJoin('h', 'Host');                            // host at seat 0
            expect(engine.handleProfile('h', { seat: 2 })).toEqual({ ok: true, seat: 2 });
            expect(engine.seats[2].sessionId).toBe('h');               // moved in
            expect(engine.seats[2].name).toBe('Host');                 // name follows
            expect(engine.seats[0].sessionId).toBe(null);              // old chair reopened
            expect(engine.seats[0].type).toBe('PLAYER');
            // Host-ness is keyed by session, so it follows the move.
            expect(engine.hostSession).toBe('h');
            expect(engine._hostSeat()).toBe(2);
        });

        it('tells the mover their new seat index (a fresh SEATED frame)', () => {
            const { fake, engine } = room(4);
            engine.handleJoin('h', 'Host');
            engine.handleProfile('h', { seat: 3 });
            const seated = fake.sends.filter(s => s.msg.t === 'seated');
            expect(seated.at(-1).msg.playerIndex).toBe(3);
            expect(seated.at(-1).msg.isHost).toBe(true);
        });

        it('rejects moving onto a taken, bot, or closed colour', () => {
            const { engine } = room(4);
            engine.handleJoin('h', 'Host');                            // seat 0
            engine.handleJoin('g', 'Guest', 2);                        // seat 2 (taken)
            engine.handleSetSeat('h', 1, 'BOT');                       // seat 1 (bot)
            expect(engine.handleProfile('g', { seat: 2 })).toEqual({ ok: true, seat: 2 }); // same seat = no-op move
            expect(engine.handleProfile('g', { seat: 0 })).toEqual({ ok: false, error: 'BAD_SEAT' }); // host's seat
            expect(engine.handleProfile('g', { seat: 1 })).toEqual({ ok: false, error: 'BAD_SEAT' }); // bot seat
            expect(engine.handleProfile('g', { seat: 9 })).toEqual({ ok: false, error: 'BAD_SEAT' }); // out of range
        });

        it('rejects a profile change from an unseated session or once started', () => {
            const { engine } = room(2);
            expect(engine.handleProfile('nobody', { name: 'X' })).toEqual({ ok: false, error: 'NOT_SEATED' });
            engine.handleJoin('h', 'Host');
            engine.handleJoin('g', 'Guest');
            engine.handleStart('h');
            expect(engine.handleProfile('h', { name: 'X' })).toEqual({ ok: false, error: 'NOT_IN_LOBBY' });
        });
    });

    it('fills open human seats with bots on start', () => {
        const { engine } = room(3);     // 3 seats: host + a guest join, one stays open
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest'); // a 2nd human is required to start
        engine.handleStart('h');
        // The two seated humans keep their seats; the leftover open seat becomes a
        // bot, and the closed 4th seat stays out of the game.
        expect(engine.playerTypes.filter(t => t === 'PLAYER')).toHaveLength(2);
        expect(engine.playerTypes.filter(t => t === 'BOT')).toHaveLength(1);
        expect(engine.playerTypes[3]).toBeUndefined();
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

    // Online bots used to get placeholder "Bot N" names + a hard-coded "balanced"
    // personality. These guard that the server now populates bot seats the same
    // way the offline setup does: a cheeky pool name + a random AI personality.
    it('a host-added bot gets a cheeky pool name and a random personality, not "Bot N"', () => {
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleSetSeat('h', 1, 'BOT');
        const seat = engine.seats[1];
        expect(seat.name).not.toMatch(/^Bot \d+$/);
        expect(BOT_NAME_POOLS[engine.botNamePool]).toContain(seat.name);
        expect(Object.keys(PERSONALITIES)).toContain(seat.personality);
    });

    it('honours the host bot-name pool ("hindi") for auto-filled bots', () => {
        const fake = makeFake();
        const engine = new RoomEngine({
            roomId: 'r', size: 4, botNamePool: 'hindi',
            transport: fake.transport, schedule: fake.schedule,
        });
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest'); // 2 humans seat diagonally; the other 2 seats bot-fill
        engine.handleStart('h');
        const botNames = engine.seats.filter(s => s.type === 'BOT').map(s => s.name);
        expect(botNames).toHaveLength(2);
        for (const n of botNames) expect(BOT_NAME_POOLS.hindi).toContain(n);
    });

    it('gives every auto-filled bot a unique name within the room', () => {
        const fake = makeFake();
        const engine = new RoomEngine({ roomId: 'r', size: 4, transport: fake.transport, schedule: fake.schedule });
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest'); // 2 humans; the remaining seats fill with bots
        engine.handleStart('h');
        const names = engine.seats.filter(s => s.type === 'BOT').map(s => s.name);
        expect(new Set(names).size).toBe(names.length);
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

    // A flaky link must not flip the host the instant a socket closes (the live
    // bug: device 2 became host "in a split second" when device 1 blipped). The
    // lobby now holds the chair for the reconnect window — same grace as in-game.
    describe('lobby disconnect grace', () => {
        // A lobby seeded on the injectable clock so the grace window is deterministic.
        function lobbyWith(sessions, size = sessions.length) {
            const fake = makeFake();
            const clock = makeClock();
            const engine = new RoomEngine({
                roomId: 'r', size, transport: fake.transport, schedule: fake.schedule,
                graceMs: 30_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
            });
            sessions.forEach(s => engine.handleJoin(s, s.toUpperCase()));
            return { fake, clock, engine };
        }

        it('does NOT change the host on a brief drop — the chair is held', () => {
            const { engine, clock } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('h'); // host's link blips
            expect(engine.hostSession).toBe('h');           // STILL the host
            expect(engine.seats[0].sessionId).toBe('h');    // chair held, not freed
            expect(engine.seats[0].connected).toBe(false);  // shown as disconnected
            expect(clock.pending()).toBe(1);                // counting down to eviction
        });

        it('a reconnecting host keeps the chair AND the host crown', () => {
            const { engine, clock } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('h');
            engine.handleJoin('h', 'Host'); // back within the window
            expect(engine.hostSession).toBe('h');
            expect(engine.seats[0].sessionId).toBe('h');
            expect(engine.seats[0].connected).toBe(true);
            expect(clock.pending()).toBe(0); // grace cancelled, no pending eviction
        });

        it('promotes a new host only after the grace window lapses', () => {
            const { engine, clock } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('h');
            expect(engine.hostSession).toBe('h'); // not yet — still holding
            clock.fireAll();                      // window elapses with nobody back
            expect(engine.hostSession).toBe('g');          // guest promoted
            expect(engine.seats[0].sessionId).toBe(null);  // host chair reopened
        });

        it('holds a non-host drop too, then reopens the seat on grace expiry', () => {
            const { engine, clock } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('g');
            expect(engine.seats[1].sessionId).toBe('g'); // held, not freed
            expect(engine.hostSession).toBe('h');        // host untouched
            clock.fireAll();
            expect(engine.seats[1].sessionId).toBe(null); // seat reopened
            expect(engine.hostSession).toBe('h');         // still the host
        });

        it('a host converting a held seat to a bot cancels the deferred eviction', () => {
            // Reassigning a still-counting-down chair must kill its grace timer,
            // or the stale eviction later stomps the bot that took the seat.
            const { engine, clock } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('g');            // seat 1 held, grace armed
            expect(clock.pending()).toBe(1);
            engine.handleSetSeat('h', 1, 'BOT');     // host fills it with a bot
            expect(clock.pending()).toBe(0);         // timer cancelled with the boot
            const botName = engine.seats[1].name;
            expect(engine.seats[1].type).toBe('BOT');
            expect(botName).toBeTruthy();
            clock.fireAll();                         // no stale timer to fire
            expect(engine.seats[1].type).toBe('BOT'); // bot untouched
            expect(engine.seats[1].name).toBe(botName); // name not wiped
        });

        it('re-arms a held lobby chair across a snapshot restore (hibernation)', () => {
            const { engine } = lobbyWith(['h', 'g']);
            engine.handleDisconnect('h'); // graceUntil stamped at now()+30s
            const snap = JSON.parse(JSON.stringify(engine.serialize()));

            // Rebuild on a fresh clock whose now() is already past the deadline:
            // the eviction the evicted instance owed must fire on resume.
            const fake = makeFake();
            const fresh = new RoomEngine({
                roomId: 'r', transport: fake.transport, schedule: fake.schedule,
                setTimer: (fn) => fn(), clearTimer: () => {}, now: () => 1_000_000,
            });
            fresh.restore(snap);
            fresh._resumeTimers();
            expect(fresh.hostSession).toBe('g');          // promoted on resume
            expect(fresh.seats[0].sessionId).toBe(null);  // chair reopened
        });
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

    it('counts turn passes authoritatively and exposes them in the snapshot', () => {
        // The turn number is server-owned so every client renders the same "Turn N"
        // instead of tallying its own replay (which drifts on a missed delta).
        const { engine } = started2();
        expect(engine.turnCount).toBe(0);
        expect(engine._publicState().turn).toBe(0);

        // A move that does NOT play again advances the turn → +1.
        engine.positions = [[10, -1, -1, -1], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.7; // dice 5, forced single move, no replay
        engine.handleRoll('h');
        expect(engine.currentPlayerIndex).toBe(1);
        expect(engine.turnCount).toBe(1);
        expect(engine._publicState().turn).toBe(1);
    });

    it('a play-again (six) does not advance the turn count', () => {
        const { engine } = started2();
        engine.positions = [[10, 56, 56, 56], [-1, -1, -1, -1], null, null];
        engine.rng = () => 0.85; // dice 6 → plays again, no turn pass
        engine.handleRoll('h');
        expect(engine.currentPlayerIndex).toBe(0);
        expect(engine.turnCount).toBe(0);
    });

    // The three-sixes forfeit confused players, so the third six is never dealt:
    // after two sixes a would-be third six is downgraded to a normal 1..5 roll,
    // so the bust never fires and the turn is played out instead of lost.
    it('never deals a third six — downgrades it, no forfeit bust', () => {
        const { fake, engine } = started2();
        engine.rng = () => 0.85; // a six normally; the third is downgraded to 1..5
        engine.handleRoll('h');
        engine.handleMove('h', 0);
        expect(engine.currentPlayerIndex).toBe(0); // first six keeps the turn
        engine.handleRoll('h');
        engine.handleMove('h', 0);
        expect(engine.currentPlayerIndex).toBe(0); // second six keeps the turn
        fake.broadcasts.length = 0;                // focus on the third roll
        engine.handleRoll('h');                    // would-be third six -> 1..5
        const rolled = fake.broadcasts.find(b => b.reason === 'rolled');
        expect(rolled.state.dice).not.toBe(6);     // downgraded, not a six
        expect(rolled.state.dice).toBeLessThanOrEqual(5);
        // the three-sixes bust never fires
        expect(fake.broadcasts.some(b => b.reason === 'three-sixes')).toBe(false);
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
        const { engine } = room(4);
        engine.handleJoin('h', 'Human');     // seat 0 (host)
        engine.handleJoin('g', 'Guest');     // seat 2 (diagonal) — the required 2nd human
        engine.handleSetSeat('h', 1, 'BOT'); // a bot sits between them in the rotation
        engine.handleStart('h');
        expect(engine.playerTypes[1]).toBe('BOT');
        engine.rng = () => 0.7; // dice 5: every all-home roll passes (no move)
        engine.handleRoll('h');  // host passes -> bot(seat1) takes its turn synchronously -> 2nd human
        expect(engine.currentPlayerIndex).toBe(2); // advanced past the bot to the guest
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);
    });
});

/**
 * Disconnect grace, freeze, forfeit and reconnect. A fake clock makes the
 * 30s reconnect window deterministic: setTimer records callbacks, fireAll()
 * runs them (the grace expiry), and clearTimer cancels a pending forfeit.
 */
function makeClock() {
    let nowMs = 0;
    let id = 0;
    const timers = new Map();
    return {
        now: () => nowMs,
        advance(ms) { nowMs += ms; },
        setTimer: (fn) => { const h = ++id; timers.set(h, fn); return h; },
        clearTimer: (h) => { timers.delete(h); },
        pending: () => timers.size,
        fireAll() { const fns = [...timers.values()]; timers.clear(); fns.forEach(fn => fn()); },
    };
}

function gameWith(sessions) {
    const fake = makeFake();
    const clock = makeClock();
    const engine = new RoomEngine({
        roomId: 'r', size: sessions.length, transport: fake.transport, schedule: fake.schedule,
        graceMs: 30_000, setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now,
    });
    sessions.forEach(s => engine.handleJoin(s, s.toUpperCase()));
    engine.handleStart(sessions[0]);
    return { fake, clock, engine };
}

// The five active-seat scans share one `_seatsWhere` helper + named predicates.
// Construct a fixed in-game state and assert each one reports exactly the seats
// it always did, so a future predicate tweak can't silently shift semantics.
describe('RoomEngine — active-seat predicates', () => {
    function configured() {
        const { engine } = gameWith(['h', 'g', 'k', 'j']); // 4 humans in-game
        // Seat 0: live human, mid-board.        -> active human, connected
        // Seat 1: disconnected human, mid-board -> active human, NOT connected
        // Seat 2: human who has FINISHED        -> not active (finished)
        // Seat 3: forfeited (no pawns)          -> not in game at all
        engine.positions = [[5, -1, -1, -1], [10, -1, -1, -1], [56, 56, 56, 56], null];
        engine.playerTypes = ['PLAYER', 'PLAYER', 'PLAYER', undefined];
        engine.seats[0].connected = true;
        engine.seats[1].connected = false;
        engine.seats[2].connected = true;
        return engine;
    }

    it('_activeInGameSeats counts any seat still holding pawns, finished included', () => {
        // Seat 2 is finished but still on the board, so it counts here.
        expect(configured()._activeInGameSeats()).toEqual([0, 1, 2]);
    });

    it('_seatedActiveHumans excludes finished + forfeited seats, link-agnostic', () => {
        expect(configured()._seatedActiveHumans()).toEqual([0, 1]);
    });

    it('_disconnectedActiveHumans is only the unfinished humans whose link is down', () => {
        expect(configured()._disconnectedActiveHumans()).toEqual([1]);
    });

    it('_isDisconnectedHuman tracks those same seats', () => {
        const engine = configured();
        expect(engine._isDisconnectedHuman(1)).toBe(true);
        expect(engine._isDisconnectedHuman(0)).toBe(false); // connected
        expect(engine._isDisconnectedHuman(2)).toBe(false); // finished
    });
});

describe('RoomEngine — disconnect grace', () => {
    it('HOLDS the game when the current player drops — their turn is never skipped', () => {
        const { fake, engine } = gameWith(['h', 'g']);
        expect(engine.currentPlayerIndex).toBe(0); // host's turn

        engine.handleDisconnect('h'); // current player vanishes
        expect(engine.waiting).toBe(true);           // game held, not skipped
        expect(engine.currentPlayerIndex).toBe(0);   // still the host's turn
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);

        const last = [...fake.broadcasts].reverse().find(b => b.t === 'state');
        expect(last.state.waiting).toBe(true);       // clients show the banner
        expect(last.state.disconnects.map(d => d.index)).toEqual([0]); // host dimmed
        expect(last.state.disconnects[0].remainingMs).toBe(30_000);

        // The other player CANNOT play through the hold.
        expect(engine.handleRoll('g')).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });

        // Reconnect lifts the hold and the held turn resumes with its owner.
        engine.handleJoin('h', 'Host');
        expect(engine.waiting).toBe(false);
        const reconnect = [...fake.broadcasts].reverse().find(b => b.t === 'state');
        expect(reconnect.state.waiting).toBe(false); // banner lifts in the same frame
        expect(engine.handleRoll('h')).toMatchObject({ ok: true });
    });

    it('holds mid-AWAIT_MOVE and resumes the SAME move selection on reconnect', () => {
        const { engine } = gameWith(['h', 'g']);
        engine.rng = () => 0.85; // a six: all four yard tokens become movable
        engine.handleRoll('h');
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);
        const legal = engine.legalMoves.slice();

        engine.handleDisconnect('h'); // drops while choosing a token
        expect(engine.waiting).toBe(true);
        expect(engine.phase).toBe(PHASES.AWAIT_MOVE);   // roll preserved, not reset
        expect(engine.currentDiceRoll).toBe(6);
        expect(engine.legalMoves).toEqual(legal);

        engine.handleJoin('h', 'Host'); // back — same turn, same pending move
        expect(engine.waiting).toBe(false);
        expect(engine.handleMove('h', legal[0])).toMatchObject({ ok: true });
    });

    it('holds when the rotation REACHES a disconnected player (no skip mid-rotation)', () => {
        const { fake, engine } = gameWith(['h', 'g']);
        engine.handleDisconnect('g'); // not their turn yet — game flows on
        expect(engine.waiting).toBe(false);

        engine.rng = () => 0.7; // a five: every pawn is in the yard → no move
        engine.handleRoll('h'); // host's turn passes to the guest… who is gone
        expect(engine.currentPlayerIndex).toBe(1);
        expect(engine.waiting).toBe(true);            // held on the guest's turn
        const last = [...fake.broadcasts].reverse().find(b => b.t === 'state');
        expect(last.reason).toBe('waiting');
        expect(last.state.waiting).toBe(true);

        // Guest reconnects: the hold lifts and it is THEIR turn.
        engine.handleJoin('g', 'Guest');
        expect(engine.waiting).toBe(false);
        expect(engine.handleRoll('g')).toMatchObject({ ok: true });
    });

    it('keeps the game flowing for the current player when a non-current player drops', () => {
        const { engine } = gameWith(['h', 'g', 'k']);
        expect(engine.currentPlayerIndex).toBe(0); // host's turn

        engine.handleDisconnect('g'); // seat 1, not the current player
        expect(engine.currentPlayerIndex).toBe(0); // host's turn untouched
        expect(engine.waiting).toBe(false);
        expect(engine.handleRoll('h')).toMatchObject({ ok: true });
    });

    it('cancels the forfeit and keeps the player in when they reconnect in time', () => {
        const { engine, clock } = gameWith(['h', 'g']);
        engine.handleDisconnect('h');
        expect(clock.pending()).toBe(1); // forfeit timer armed

        engine.handleJoin('h', 'Host'); // reconnect
        expect(clock.pending()).toBe(0); // timer cancelled
        expect(engine.positions[0]).not.toBeNull(); // pawns intact
        expect(engine.seats[0].connected).toBe(true);
    });

    it('forfeits the seat and ends the game when only one human is left (2P)', () => {
        const { fake, engine, clock } = gameWith(['h', 'g']);
        engine.handleDisconnect('g');
        clock.fireAll(); // grace window elapses

        const dropped = fake.broadcasts.find(b => b.t === 'dropped');
        expect(dropped.seat).toBe(1);
        expect(engine.positions[1]).toBeNull(); // pawns removed
        expect(engine.playerTypes[1]).toBeUndefined();

        const ended = fake.broadcasts.find(b => b.t === 'ended');
        expect(ended.reason).toBe('opponent-left');
        expect(engine.phase).toBe(PHASES.ENDED);
    });

    it('forfeit of the held player hands the turn on and the 3-player game continues', () => {
        const { engine, clock } = gameWith(['h', 'g', 'k']);
        expect(engine.currentPlayerIndex).toBe(0);
        engine.handleDisconnect('h'); // current player drops → game HOLDS on them
        expect(engine.currentPlayerIndex).toBe(0); // not skipped
        expect(engine.waiting).toBe(true);
        clock.fireAll();              // grace elapses → forfeit

        expect(engine.phase).not.toBe(PHASES.ENDED); // two humans remain
        expect(engine.positions[0]).toBeNull();       // forfeited
        expect(engine.currentPlayerIndex).not.toBe(0); // NOW the turn moves on
        expect(engine.waiting).toBe(false);
    });

    it('a non-current forfeit does not steal the turn the game is holding for', () => {
        const { engine } = gameWith(['h', 'g', 'k']);
        engine.handleDisconnect('h'); // current → game held on h
        engine.handleDisconnect('g'); // not current — counting down in parallel
        expect(engine.waiting).toBe(true);
        expect(engine.currentPlayerIndex).toBe(0);

        const gSeat = engine._seatOf('g');
        engine._dropSeat(gSeat); // g's grace expires first
        expect(engine.playerTypes[gSeat]).toBeUndefined(); // g forfeited
        expect(engine.currentPlayerIndex).toBe(0);         // still held on h's turn
        expect(engine.waiting).toBe(true);

        engine.handleJoin('h', 'Host'); // h back → their held turn resumes
        expect(engine.waiting).toBe(false);
        expect(engine.handleRoll('h')).toMatchObject({ ok: true });
    });

    it('a different player reconnecting does not lift a hold on someone else', () => {
        const { engine } = gameWith(['h', 'g']);
        engine.handleDisconnect('h'); // held on h's turn
        engine.handleDisconnect('g'); // g drops too
        expect(engine.waiting).toBe(true);
        expect(engine.phase).toBe(PHASES.AWAIT_ROLL);

        engine.handleJoin('g', 'Guest'); // g is back — but the game waits on h
        expect(engine.waiting).toBe(true);
        expect(engine.handleRoll('g')).toEqual({ ok: false, error: 'NOT_YOUR_TURN' });

        engine.handleJoin('h', 'Host'); // the held player returns
        expect(engine.waiting).toBe(false);
        expect(engine.handleRoll('h')).toMatchObject({ ok: true });
    });
});

// Explicit "Leave game" (the exit-dialog confirm) must forfeit the seat
// IMMEDIATELY — the old behaviour left the player in the room until the 60s
// reconnect grace lapsed. The client delivers a LEAVE over a throwaway socket
// that the server first sees as a reconnect (handleJoin), so these tests model
// that join-then-leave sequence.
describe('RoomEngine — explicit leave (immediate forfeit)', () => {
    it('frees the seat the instant LEAVE arrives, without waiting out the grace window', () => {
        const { fake, engine, clock } = gameWith(['h', 'g']);
        engine.handleJoin('g', 'G'); // throwaway reconnect that carries the LEAVE
        engine.handleLeave('g');     // player confirmed "Leave game"

        // Forfeited NOW — no clock.fireAll(), and nothing left counting down.
        expect(engine.positions[1]).toBeNull();
        expect(engine.playerTypes[1]).toBeUndefined();
        expect(clock.pending()).toBe(0);
        expect(fake.broadcasts.find(b => b.t === 'dropped')?.seat).toBe(1);
        // One human left → the game ends straight away (no grace delay).
        expect(fake.broadcasts.find(b => b.t === 'ended')?.reason).toBe('opponent-left');
        expect(engine.phase).toBe(PHASES.ENDED);
    });

    it('leaving on your own turn hands the turn on at once in a 3-player game', () => {
        const { engine, clock } = gameWith(['h', 'g', 'k']);
        expect(engine.currentPlayerIndex).toBe(0);

        engine.handleLeave('h'); // host confirms leave while it is their turn
        expect(engine.positions[0]).toBeNull();        // forfeited immediately
        expect(engine.phase).not.toBe(PHASES.ENDED);   // two players remain
        expect(engine.currentPlayerIndex).not.toBe(0); // turn advanced now, not in 60s
        expect(clock.pending()).toBe(0);
    });

    it('LEAVE after a real disconnect forfeits now and leaves no orphan grace timer', () => {
        const { engine, clock } = gameWith(['h', 'g', 'k']);
        const gSeat = engine._seatOf('g');
        engine.handleDisconnect('g'); // a link blip arms the 30s forfeit
        expect(clock.pending()).toBe(1);
        engine.handleJoin('g', 'G');  // throwaway reconnect cancels the timer
        expect(clock.pending()).toBe(0);

        engine.handleLeave('g');      // then the explicit confirm forfeits at once
        expect(engine.playerTypes[gSeat]).toBeUndefined();
        expect(clock.pending()).toBe(0);
    });

    it('no-ops for an unknown / already-gone session', () => {
        const { engine } = gameWith(['h', 'g']);
        expect(() => engine.handleLeave('nobody')).not.toThrow();
        expect(engine.positions[0]).not.toBeNull();
        expect(engine.positions[1]).not.toBeNull();
    });
});

describe('RoomEngine — frame sequencing + input hardening', () => {
    it('stamps a strictly increasing seq on every broadcast frame', () => {
        // Clients use seq to drop duplicate/stale frames when a reconnect races
        // a zombie socket — without it the same frame can replay twice.
        const { fake, engine } = room(2);
        engine.handleJoin('h', 'Host');
        engine.handleJoin('g', 'Guest');
        engine.handleStart('h');
        engine.rng = () => 0.7; // a 5: normal roll, no six
        engine.handleRoll('h');

        const seqs = fake.broadcasts.map(b => b.seq);
        expect(seqs.every(s => Number.isInteger(s) && s > 0)).toBe(true);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    });

    it('rejects a non-integer seat index instead of touching Array.prototype', () => {
        // "__proto__" as an array index resolves to Array.prototype — an
        // unchecked handleSetSeat would let a hostile lobby frame write bot
        // fields onto EVERY array in the isolate (prototype pollution).
        const { engine } = room(2);
        engine.handleJoin('h', 'Host');
        expect(engine.handleSetSeat('h', '__proto__', 'BOT')).toEqual({ ok: false, error: 'BAD_SEAT' });
        expect(Array.prototype.type).toBeUndefined();
        expect([].type).toBeUndefined();
        expect(engine.handleKick('h', '__proto__')).toEqual({ ok: false, error: 'NOTHING_TO_KICK' });
        expect(engine.handleProfile('h', { seat: '__proto__' })).toEqual({ ok: false, error: 'BAD_SEAT' });
        // Fractional / out-of-range indexes are rejected the same way.
        expect(engine.handleSetSeat('h', 1.5, 'BOT')).toEqual({ ok: false, error: 'BAD_SEAT' });
        expect(engine.handleSetSeat('h', 7, 'BOT')).toEqual({ ok: false, error: 'BAD_SEAT' });
    });
});

/**
 * Hibernation round-trip. A Cloudflare DO evicts the engine from memory between
 * moves to save duration, then reconstructs it from a `serialize()` snapshot.
 * These guard that the reconstruction is byte-identical — board, seats, counters
 * AND the dice RNG stream — so a resumed game plays on exactly as it would have.
 */
describe('RoomEngine — snapshot / restore', () => {
    const sid = ['h', 'g'];
    const step = (e) => {
        const seat = e.currentPlayerIndex;
        if (e.phase === PHASES.AWAIT_ROLL) e.handleRoll(sid[seat]);
        else if (e.phase === PHASES.AWAIT_MOVE) e.handleMove(sid[seat], e.legalMoves[0]);
    };

    it('makeRng resumes an identical stream from getState/setState', () => {
        const a = makeRng(0xC0FFEE);
        for (let i = 0; i < 5; i++) a();          // advance into the stream
        const saved = a.getState();
        const expected = [a(), a(), a(), a()];
        const b = makeRng(1);                      // different seed...
        b.setState(saved);                         // ...rewound to a's position
        expect([b(), b(), b(), b()]).toEqual(expected);
    });

    it('round-trips full mid-game state, internals included', () => {
        const { engine } = started2();
        for (let i = 0; i < 12 && engine.phase !== PHASES.ENDED; i++) step(engine); // churn real state

        const fake2 = makeFake();
        const restored = new RoomEngine({ roomId: 'r', size: 2, transport: fake2.transport, schedule: fake2.schedule });
        restored.restore(engine.serialize());

        // serialize() captures everything the turn machine reads — public view,
        // hostSession, counters, legalMoves, seq, and both RNG states — so a deep
        // equality of the snapshot is a complete round-trip assertion.
        expect(restored.serialize()).toEqual(engine.serialize());
        expect(restored._publicState()).toEqual(engine._publicState());
        expect(restored.rng.getState()).toBe(engine.rng.getState());
    });

    it('resumes the dice stream so the next roll is identical', () => {
        const { engine } = started2();
        for (let i = 0; i < 9 && engine.phase !== PHASES.ENDED; i++) step(engine);
        if (engine.phase === PHASES.ENDED) return; // unlucky fast finish — nothing to resume

        const fake2 = makeFake();
        const restored = new RoomEngine({ roomId: 'r', size: 2, transport: fake2.transport, schedule: fake2.schedule });
        restored.restore(engine.serialize());

        // One more identical action on each: a resumed RNG must roll the SAME
        // dice, so the resulting states stay byte-identical. A diverged stream
        // would roll differently and this would fail.
        step(engine);
        step(restored);
        expect(restored.serialize()).toEqual(engine.serialize());
    });

    it('re-arms and fires a lapsed reconnect-grace forfeit on resume', () => {
        // A DO evicted DURING a grace window loses the setTimeout; on the next
        // wake _resumeTimers must forfeit a seat whose deadline already passed.
        const { engine } = started2();
        const snap = engine.serialize();
        snap.seats[1].connected = false;   // guest dropped mid-game...
        snap.seats[1].graceUntil = 500;    // ...and the window lapsed (< now below)

        const fake2 = makeFake();
        const restored = new RoomEngine({
            roomId: 'r', size: 2, transport: fake2.transport, schedule: fake2.schedule,
            setTimer: (fn) => fn(), now: () => 10_000,
        });
        restored.restore(snap);
        restored._resumeTimers();

        // Two-human game minus the forfeiting seat → the match ends for the survivor.
        expect(restored.seats[1].type).toBe(null);
        expect(restored.phase).toBe(PHASES.ENDED);
        expect(fake2.broadcasts.some(b => b.t === 'ended')).toBe(true);
    });
});
