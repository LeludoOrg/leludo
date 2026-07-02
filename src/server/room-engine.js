/**
 * RoomEngine — server-authoritative Ludo room with a host-managed lobby.
 *
 * Two layers:
 *   1. LOBBY — a networked version of the offline "who's playing?" setup. The
 *      first human to join is the HOST. Only the host can change the room size,
 *      set a seat to a bot, kick a player, and START the game. Everyone else
 *      waits. Open (unclaimed) human seats become bots on start.
 *   2. IN-GAME — once started, this is an interactive version of
 *      scripts/game-driver.js `runGame`: roll → three-sixes → legal moves →
 *      forced-move auto-apply → capture → finish/rank → plays-again → advance.
 *      All rules stay in the pure modules; this validates every intent.
 *
 * Transport-agnostic: the host (Node ws server, Cloudflare DO, unit-test fake)
 * injects `transport` {broadcast, send, release} and a `schedule` for paced bots.
 */
import {
    isTokenMovable,
    getTokenNewPosition,
    findCapturedOpponents,
    isTripComplete,
    rollDiceWithPity,
} from '../scripts/core/game-logic.js';
import { pickBestMove, PERSONALITIES, randomPersonality } from '../scripts/core/bot-ai.js';
import {
    isPlayerFinished,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
} from '../scripts/core/turn-rules.js';
import { makeRng } from '../scripts/core/game-driver.js';
import { randomBotName } from '../scripts/core/bot-names.js';
import { spreadPick } from '../scripts/core/seat-allocation.js';
import { MSG, REASON, ERR, NAME_MAX } from '../scripts/net/net-protocol.js';

export const PHASES = Object.freeze({
    LOBBY: 'LOBBY',
    AWAIT_ROLL: 'AWAIT_ROLL',
    AWAIT_MOVE: 'AWAIT_MOVE',
    ENDED: 'ENDED',
});

const MIN_PLAYERS = 2;

/** Trim a player-supplied display name and clamp it to NAME_MAX. */
function sanitizeName(raw) {
    return String(raw ?? '').trim().slice(0, NAME_MAX);
}

/**
 * Validate a client-supplied seat index to a real 0..3 integer, or -1. Seat
 * indexes arrive raw off the wire and are used to index `this.seats` — a
 * non-integer key like "__proto__" would otherwise reach `this.seats[i]`
 * (which resolves to Array.prototype!) and let a hostile frame write onto the
 * prototype via _fillBot/_openSeat. Never index seats with an unchecked value.
 */
function asSeatIndex(raw) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isInteger(n) && n >= 0 && n < 4 ? n : -1;
}

function cloneBoard(positions) {
    return positions.map(p => (p ? p.slice() : null));
}

/** Apply one move to a board copy + resolve captures. Mirrors game-driver.applyMove. */
function applyMove(positions, playerIndex, tokenIndex, dice) {
    const next = cloneBoard(positions);
    const fromPosition = next[playerIndex][tokenIndex];
    const newPosition = getTokenNewPosition(fromPosition, dice);
    next[playerIndex][tokenIndex] = newPosition;

    const captured = findCapturedOpponents(playerIndex, newPosition, next);
    let captureCount = 0;
    const capturedList = [];
    for (let pi = 0; pi < captured.length; pi++) {
        const list = captured[pi];
        if (!list) continue;
        for (const ti of list) {
            next[pi][ti] = -1;
            captureCount++;
            capturedList.push({ playerIndex: pi, tokenIndex: ti });
        }
    }
    return { next, fromPosition, newPosition, captureCount, captured: capturedList, tripComplete: isTripComplete(newPosition) };
}

export class RoomEngine {
    /**
     * @param {object} opts
     * @param {string} opts.roomId
     * @param {number} [opts.size]       initial open human seats (2..4), default 2
     * @param {('PLAYER'|'BOT'|null)[]} [opts.seatPlan]  explicit seat plan (overrides size)
     * @param {number} [opts.seed]       server dice RNG seed (deterministic)
     * @param {{broadcast:Function, send:Function, release?:Function}} opts.transport
     * @param {(fn:Function, ms:number)=>void} [opts.schedule]
     * @param {number} [opts.botDelayMs]
     */
    constructor(opts) {
        this.roomId = opts.roomId;
        this.rng = makeRng(opts.seed ?? 1);
        // Bot naming/personality uses its OWN seeded stream so it never disturbs
        // the dice rng — keeps seeded games byte-identical regardless of how many
        // bots a room ends up with. Mirrors the offline setup (cheeky pool name +
        // varied AI personality); the pool defaults to English, overridable by the
        // host's preference forwarded at room creation.
        this.botNamePool = opts.botNamePool || 'english';
        this.botRng = makeRng((opts.seed ?? 1) ^ 0x5bd1e995);
        this.transport = opts.transport;
        this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
        this.botDelayMs = opts.botDelayMs ?? 600;
        // Optional persistence hook, called with `this` on every state-changing
        // broadcast. A hibernating host (Cloudflare DO) writes a snapshot here so
        // the room survives eviction; the always-resident Node server omits it.
        // Invoked BEFORE the broadcast so CF's output gate holds the outbound
        // frames until the write lands — clients never see an unpersisted state.
        this.persist = opts.persist || null;
        // Public matches auto-start once every human seat is filled; private
        // rooms stay host-managed (the host presses Start).
        this.autoStart = !!opts.autoStart;

        // ---- disconnect grace ----
        // When an in-game human drops, the game HOLDS at their turn: play
        // continues only until the rotation reaches them (or stops immediately
        // if it was already their turn), then waits. A turn is never skipped —
        // the hold lifts when they reconnect (resuming the turn exactly where
        // it stopped, mid-AWAIT_MOVE included) or when the grace window
        // forfeits the seat (pawns removed, game flows on; ends if one human
        // is left). Timers/clock are injectable so unit tests can drive them
        // deterministically (and a Cloudflare DO can swap setTimeout for alarms).
        this.graceMs = opts.graceMs ?? 30_000;
        this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = opts.clearTimer || ((h) => clearTimeout(h));
        this.now = opts.now || (() => Date.now());
        // True while the game is held on a disconnected human's turn. Exposed
        // in the public snapshot so clients show the "waiting for X" banner.
        this.waiting = false;

        // ---- lobby seat model ----
        const size = Math.max(MIN_PLAYERS, Math.min(4, opts.size ?? 2));
        const plan = opts.seatPlan || [0, 1, 2, 3].map(i => (i < size ? 'PLAYER' : null));
        this.seats = [0, 1, 2, 3].map(i => ({
            type: plan[i] || null,       // 'PLAYER' | 'BOT' | null(closed)
            sessionId: null,             // null = open (PLAYER) or n/a (BOT/closed)
            name: '',
            personality: null,
            connected: false,
            graceTimer: null,  // pending forfeit timer while disconnected mid-game
            graceUntil: 0,      // wall-clock deadline for the reconnect window
        }));
        // Name + personalise any bots baked into the initial plan.
        this.seats.forEach((s, i) => { if (s.type === 'BOT') this._fillBot(i); });
        this.hostSession = null;

        // ---- in-game state (materialised on start) ----
        this.phase = PHASES.LOBBY;
        this.started = false;
        this.positions = [null, null, null, null];
        this.playerTypes = [undefined, undefined, undefined, undefined];
        this.playerNames = ['', '', '', ''];
        this.botPersonalities = [null, null, null, null];
        this.currentPlayerIndex = 0;
        this.currentDiceRoll = 0;
        // Authoritative turn counter — the number of completed turn passes, sent
        // to clients so the "Turn N" label is identical on every screen instead
        // of each client tallying its own replay (which drifts when a delta is
        // missed). Mirrors the offline display counter: 0 at the opening turn,
        // +1 on every advance (move-pass, no-move, three-sixes, skip/forfeit).
        this.turnCount = 0;
        this.consecutiveSixes = 0;
        // Consecutive no-move turns per seat — feeds the pity-six rule so an
        // online player can't get stranded in the yard either.
        this.noMoveStreak = [0, 0, 0, 0];
        this.captures = [0, 0, 0, 0];
        this.ranks = [0, 0, 0, 0];
        this.lastRank = 0;
        this.legalMoves = [];
        // Monotonic frame counter stamped on every broadcast. WebSocket delivery
        // is ordered per socket, but a session can briefly hold TWO sockets (a
        // reconnect racing a zombie connection) — the client uses `seq` to drop
        // duplicate/stale frames instead of replaying them out of order.
        this.seq = 0;
    }

    /** Broadcast a frame to the room, stamped with the next sequence number.
     *  Persists first (see `this.persist`) so a crash can't leave clients ahead
     *  of stored state; the bumped `seq` is part of what gets persisted. */
    _broadcast(frame) {
        frame.seq = ++this.seq;
        this.persist?.(this);
        this.transport.broadcast(frame);
    }

    // ---- snapshot / rehydrate -----------------------------------------------
    // A hibernating host serialises the full authoritative state to storage and
    // reconstructs it after the runtime evicts the instance. Everything the turn
    // machine reads must round-trip: the RNG streams (as their resumable 32-bit
    // state), the lobby seat objects, the derived in-game arrays, and the live
    // counters. Transient handles (graceTimer) are NOT serialised — they are
    // re-armed from `graceUntil` by `_resumeTimers` on the way back in.

    /** Full authoritative state as a plain JSON-safe object. */
    serialize() {
        return {
            v: 1,
            roomId: this.roomId,
            botNamePool: this.botNamePool,
            rng: this.rng.getState(),
            botRng: this.botRng.getState(),
            autoStart: this.autoStart,
            botDelayMs: this.botDelayMs,
            graceMs: this.graceMs,
            hostSession: this.hostSession,
            phase: this.phase,
            started: this.started,
            waiting: this.waiting,
            seats: this.seats.map(s => ({
                type: s.type,
                sessionId: s.sessionId,
                name: s.name,
                personality: s.personality,
                connected: s.connected,
                graceUntil: s.graceUntil || 0,
            })),
            positions: this.positions.map(p => (p ? p.slice() : null)),
            playerTypes: this.playerTypes.slice(),
            playerNames: this.playerNames.slice(),
            botPersonalities: this.botPersonalities.slice(),
            currentPlayerIndex: this.currentPlayerIndex,
            currentDiceRoll: this.currentDiceRoll,
            turnCount: this.turnCount,
            consecutiveSixes: this.consecutiveSixes,
            noMoveStreak: this.noMoveStreak.slice(),
            captures: this.captures.slice(),
            ranks: this.ranks.slice(),
            lastRank: this.lastRank,
            legalMoves: this.legalMoves.slice(),
            seq: this.seq,
        };
    }

    /** Overwrite this engine's state from a `serialize()` snapshot. Hooks
     *  (transport/schedule/persist/now) stay as wired by the constructor. */
    restore(s) {
        this.roomId = s.roomId;
        this.botNamePool = s.botNamePool;
        this.rng.setState(s.rng);
        this.botRng.setState(s.botRng);
        this.autoStart = s.autoStart;
        this.botDelayMs = s.botDelayMs;
        this.graceMs = s.graceMs;
        this.hostSession = s.hostSession;
        this.phase = s.phase;
        this.started = s.started;
        this.waiting = s.waiting;
        this.seats = s.seats.map(x => ({
            type: x.type,
            sessionId: x.sessionId,
            name: x.name,
            personality: x.personality,
            connected: x.connected,
            graceTimer: null,
            graceUntil: x.graceUntil || 0,
        }));
        this.positions = s.positions.map(p => (p ? p.slice() : null));
        this.playerTypes = s.playerTypes.slice();
        this.playerNames = s.playerNames.slice();
        this.botPersonalities = s.botPersonalities.slice();
        this.currentPlayerIndex = s.currentPlayerIndex;
        this.currentDiceRoll = s.currentDiceRoll;
        this.turnCount = s.turnCount;
        this.consecutiveSixes = s.consecutiveSixes;
        this.noMoveStreak = s.noMoveStreak.slice();
        this.captures = s.captures.slice();
        this.ranks = s.ranks.slice();
        this.lastRank = s.lastRank;
        this.legalMoves = s.legalMoves.slice();
        this.seq = s.seq;
        return this;
    }

    /**
     * After a restore, re-create the timers that live only in memory (a fresh
     * instance has none). Idempotent intent: call EXACTLY once per reconstruction,
     * never on a warm instance, or bot turns would double-schedule.
     *   - Disconnect-grace forfeits resume from their persisted deadline (forfeit
     *     immediately if the window already lapsed while we were evicted).
     *   - A bot left mid-turn (AWAIT_ROLL, not held on a human) gets its step
     *     re-kicked, since its pacing setTimeout was lost with the old instance.
     */
    _resumeTimers() {
        if (this.phase === PHASES.ENDED) return;
        for (let i = 0; i < 4; i++) {
            const s = this.seats[i];
            // A held seat counting down toward eviction/forfeit: a disconnected
            // human still claiming an in-game seat, or a disconnected lobby chair
            // whose grace we deferred. Either way, resume from the stored deadline
            // (fire immediately if it lapsed while we were evicted).
            const held = this.phase === PHASES.LOBBY
                ? (s.sessionId != null && !s.connected)
                : this._isActiveHuman(i) && !s.connected;
            if (held && s.graceUntil > 0) {
                const remaining = s.graceUntil - this.now();
                if (remaining <= 0) { this._onGraceExpire(i); }
                else { s.graceTimer = this.setTimer(() => { s.graceTimer = null; this._onGraceExpire(i); }, remaining); }
            }
        }
        if (this.phase === PHASES.AWAIT_ROLL && !this.waiting
            && this.playerTypes[this.currentPlayerIndex] === 'BOT') {
            this.schedule(() => this._botStep(), this.botDelayMs);
        }
    }

    // ---- seat helpers -------------------------------------------------------

    _seatOf(sessionId) {
        return this.seats.findIndex(s => s.sessionId === sessionId);
    }

    _hostSeat() {
        return this.hostSession == null ? -1 : this.seats.findIndex(s => s.sessionId === this.hostSession);
    }

    _isHost(sessionId) {
        return this.hostSession != null && this.hostSession === sessionId;
    }

    _activeCount() {
        return this.seats.filter(s => s.type).length;
    }

    /** Human seats actually claimed by a person (not bots, not open seats).
     *  This — not _activeCount, which counts bots too — gates the host Start:
     *  an online game needs two real players, so a lone host can't kick off a
     *  solo-vs-bots match (that's what offline play is for). */
    _seatedHumanCount() {
        return this.seats.filter(s => s.type === 'PLAYER' && s.sessionId != null).length;
    }

    _firstActive() {
        return this.playerTypes.findIndex(t => t !== undefined);
    }

    /** Names already taken by other seats (humans or bots) so a fresh bot name
     *  won't collide with anyone in the room. */
    _usedNames(exceptIndex) {
        return this.seats.filter((s, i) => i !== exceptIndex && s.name).map(s => s.name);
    }

    /** Turn seat `i` into a freshly-populated bot — a cheeky pool name (unique in
     *  the room) plus a random AI personality, exactly like the offline setup
     *  populates its bot seats. */
    _fillBot(i) {
        const s = this.seats[i];
        s.type = 'BOT';
        s.sessionId = null;
        s.connected = false;
        s.name = randomBotName(this._usedNames(i), { poolKey: this.botNamePool, rng: this.botRng });
        s.personality = randomPersonality(this.botRng);
    }

    // ---- lobby intents ------------------------------------------------------

    /** Open human seat that sits furthest from the humans already seated, or -1 if
     *  none. This is what keeps two players diagonally opposite (and bots on the
     *  other diagonal), mirroring the offline seat-allocation order. */
    _spreadOpenSeat() {
        const taken = [], open = [];
        for (let i = 0; i < 4; i++) {
            const s = this.seats[i];
            if (s.type !== 'PLAYER') continue;
            (s.sessionId === null ? open : taken).push(i);
        }
        return spreadPick(taken, open);
    }

    /** Choose a seat for a NEW joiner: honour the requested colour seat when it's
     *  a free human seat, otherwise pick the open seat furthest from the players
     *  already in. The seat index doubles as the player's colour, so this is how a
     *  player picks their in-game colour at join time. */
    _pickSeat(preferred) {
        // No colour requested (null/''): Number('') and Number(null) both coerce to
        // 0, so guard explicitly — otherwise every preference-less joiner would
        // "prefer" seat 0 and skip the spread.
        if (preferred != null && preferred !== '') {
            const i = Number(preferred);
            if (Number.isInteger(i) && i >= 0 && i < 4
                && this.seats[i].type === 'PLAYER' && this.seats[i].sessionId === null) {
                return i;
            }
        }
        return this._spreadOpenSeat();
    }

    /** Seat a (re)connecting human. First to join becomes host. Reconnect = same
     *  seat (the preferred colour is ignored — you keep the seat you already hold). */
    handleJoin(sessionId, name, preferredSeat = null) {
        let seat = this._seatOf(sessionId);
        if (seat === -1) {
            seat = this._pickSeat(preferredSeat);
            if (seat === -1) return { ok: false, error: ERR.ROOM_FULL };
            this.seats[seat].sessionId = sessionId;
            this.seats[seat].name = name || `Player ${seat + 1}`;
            if (this.hostSession == null) this.hostSession = sessionId;
        }
        if (name) this.seats[seat].name = name;
        this.seats[seat].connected = true;
        this.transport.send(seat, {
            t: MSG.SEATED,
            playerIndex: seat,
            isHost: this._isHost(sessionId),
            roomId: this.roomId,
        });

        // Reconnecting into a live game: cancel the forfeit timer and un-dim
        // them on clients. If the game was held on this player's turn, the hold
        // lifts and the turn resumes EXACTLY where it stopped — phase, dice and
        // legal moves were preserved, so a mid-AWAIT_MOVE drop comes back still
        // awaiting that same move (no _beginTurn, which would reset the roll).
        // A different still-disconnected human keeps the game held. waiting is
        // cleared BEFORE the broadcast so the same frame lifts every client's
        // waiting banner.
        if (this.started && this.phase !== PHASES.ENDED) {
            this._clearGrace(seat);
            if (this.waiting && !this._isDisconnectedHuman(this.currentPlayerIndex)) {
                this.waiting = false;
            }
            this._broadcastState(REASON.RECONNECT);
            return { ok: true, seat };
        }

        // A lobby reconnect (same session resuming a held chair) cancels the
        // pending eviction; a fresh joiner has no timer, so this no-ops for them.
        this._clearGrace(seat);
        this._broadcastState(REASON.JOIN);
        this._maybeAutoStart();
        return { ok: true, seat };
    }

    /** Public rooms only: start as soon as every human seat is filled. */
    _maybeAutoStart() {
        if (!this.autoStart || this.phase !== PHASES.LOBBY) return;
        if (this._activeCount() < MIN_PLAYERS) return;
        const allHumansSeated = this.seats.every(s => s.type !== 'PLAYER' || s.sessionId);
        if (allHumansSeated) this._startGame();
    }

    /** Host: set the number of active seats (2..4), opening/closing as needed. */
    handleSetSize(sessionId, n) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        const size = Math.max(MIN_PLAYERS, Math.min(4, Number(n) || 0));
        while (this._activeCount() < size) {
            const i = this.seats.findIndex(s => !s.type);
            if (i === -1) break;
            this._openSeat(i);
        }
        while (this._activeCount() > size) {
            const i = this._findRemovableSeat();
            if (i === -1) return this._reject(this._seatOf(sessionId), ERR.CANT_SHRINK); // would kick a human
            this._closeSeat(i);
        }
        this._broadcastState(REASON.LOBBY);
        return { ok: true };
    }

    /**
     * Host: set seat `i` to 'PLAYER' (open human seat), 'BOT', or 'CLOSED'.
     * Replacing a connected human boots them (a kick).
     */
    handleSetSeat(sessionId, rawSeat, type) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        const i = asSeatIndex(rawSeat);
        const seat = this.seats[i];
        if (!seat) return this._reject(this._seatOf(sessionId), ERR.BAD_SEAT);
        if (seat.sessionId === this.hostSession) return this._reject(this._seatOf(sessionId), ERR.CANT_CHANGE_HOST);

        if (type === 'BOT') {
            this._bootIfHuman(i);
            this._fillBot(i);
        } else if (type === 'PLAYER') {
            this._openSeat(i);
        } else if (type === 'CLOSED') {
            if (this._activeCount() <= MIN_PLAYERS) return this._reject(this._seatOf(sessionId), ERR.MIN_TWO);
            this._closeSeat(i);
        } else {
            return this._reject(this._seatOf(sessionId), ERR.BAD_TYPE);
        }
        this._broadcastState(REASON.LOBBY);
        return { ok: true };
    }

    /** Host: remove the human in seat `i` (back to an open seat). */
    handleKick(sessionId, rawSeat) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        const i = asSeatIndex(rawSeat);
        const seat = this.seats[i];
        if (!seat || seat.type !== 'PLAYER' || !seat.sessionId) return this._reject(this._seatOf(sessionId), ERR.NOTHING_TO_KICK);
        if (seat.sessionId === this.hostSession) return this._reject(this._seatOf(sessionId), ERR.CANT_KICK_HOST);
        this._bootIfHuman(i); // notifies + reopens
        this._broadcastState(REASON.LOBBY);
        return { ok: true };
    }

    /**
     * Any seated player: set their OWN display name and/or pick their colour by
     * moving to an open seat (the seat index doubles as the colour). Lobby only.
     * `name` and `seat` are both optional — the client sends `name` on a rename,
     * `seat` on a colour tap. A colour move keeps the player's name, connection,
     * and host-ness (the host is keyed by session, so it follows them to the new
     * seat); the vacated chair reopens as a free human seat.
     */
    handleProfile(sessionId, { name, seat } = {}) {
        let from = this._seatOf(sessionId);
        if (from === -1) return this._reject(from, ERR.NOT_SEATED);
        if (this.phase !== PHASES.LOBBY) return this._reject(from, ERR.NOT_IN_LOBBY);

        if (name != null) this.seats[from].name = sanitizeName(name) || this.seats[from].name;

        if (seat != null && seat !== from) {
            seat = asSeatIndex(seat);
            const target = this.seats[seat];
            if (!target || target.type !== 'PLAYER' || target.sessionId !== null) {
                return this._reject(from, ERR.BAD_SEAT);
            }
            // Move: occupy the target, reopen the chair we left. Host-ness is keyed
            // by session, so hostSession is unchanged and _hostSeat() follows us.
            target.sessionId = sessionId;
            target.name = this.seats[from].name;
            target.connected = true;
            target.personality = null;
            const old = this.seats[from];
            old.sessionId = null;
            old.name = '';
            old.connected = false;
            old.personality = null;
            from = seat;
            // Tell the mover their new seat index so the client retints + tracks it.
            this.transport.send(from, {
                t: MSG.SEATED,
                playerIndex: from,
                isHost: this._isHost(sessionId),
                roomId: this.roomId,
            });
        }

        this._broadcastState(REASON.LOBBY);
        return { ok: true, seat: from };
    }

    /** Host: start the game. Needs two real humans seated (bots don't count);
     *  any remaining open human seats fill with bots on start. */
    handleStart(sessionId) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        if (this._seatedHumanCount() < MIN_PLAYERS) return this._reject(this._seatOf(sessionId), ERR.NEED_TWO_PLAYERS);
        this._startGame();
        return { ok: true };
    }

    _hostLobbyGuard(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, ERR.NOT_SEATED);
        if (this.phase !== PHASES.LOBBY) return this._reject(seat, ERR.NOT_IN_LOBBY);
        if (!this._isHost(sessionId)) return this._reject(seat, ERR.NOT_HOST);
        return null;
    }

    _openSeat(i) {
        const s = this.seats[i];
        this._bootIfHuman(i);
        s.type = 'PLAYER';
        s.sessionId = null;
        s.connected = false;
        s.name = '';
        s.personality = null;
    }

    _closeSeat(i) {
        this._bootIfHuman(i);
        const s = this.seats[i];
        s.type = null;
        s.sessionId = null;
        s.connected = false;
        s.name = '';
        s.personality = null;
    }

    /** If a human (connected OR mid-reconnect) sits here, tell them they were
     *  removed and clear the chair. Cancelling any pending lobby grace is the key
     *  step: a disconnected seat now lingers through its reconnect window, so a
     *  host reassigning it (kick / set-to-bot / shrink) must kill the deferred
     *  eviction — otherwise it fires later and stomps whatever now holds the seat. */
    _bootIfHuman(i) {
        const s = this.seats[i];
        if (s.type === 'PLAYER' && s.sessionId && s.sessionId !== this.hostSession) {
            this.transport.send(i, { t: MSG.KICKED });
            this._clearGrace(i);
            s.sessionId = null;
            s.connected = false;
            s.name = '';
        }
    }

    /** Removable for shrink: a bot or an open (unclaimed) human seat, highest index first. */
    _findRemovableSeat() {
        for (let i = 3; i >= 0; i--) {
            const s = this.seats[i];
            if (!s.type) continue;
            if (s.sessionId === this.hostSession) continue;
            const connectedHuman = s.type === 'PLAYER' && s.sessionId && s.connected;
            if (!connectedHuman) return i;
        }
        return -1;
    }

    /**
     * Project the lobby seat objects into the parallel in-game arrays the pure
     * scripts/* modules consume (playerTypes / playerNames / botPersonalities)
     * plus a fresh starting board. The seat objects stay the lobby source of
     * truth; these arrays are the derived in-game view. `_dropSeat` is the one
     * place that has to mutate BOTH afterwards (see the note there).
     */
    _materialisePlayers() {
        this.playerTypes = this.seats.map(s => s.type || undefined);
        this.playerNames = this.seats.map((s, i) => s.name || (s.type === 'BOT' ? `Bot ${i + 1}` : `Player ${i + 1}`));
        this.botPersonalities = this.seats.map(s => (s.type === 'BOT' ? (s.personality || 'balanced') : null));
        this.positions = this.seats.map(s => (s.type ? [-1, -1, -1, -1] : null));
    }

    _startGame() {
        // Open human seats with nobody in them become bots; any bot missing a
        // name/personality (shouldn't happen, but be defensive) gets filled too.
        this.seats.forEach((s, i) => {
            if (s.type === 'PLAYER' && s.sessionId === null) this._fillBot(i);
            else if (s.type === 'BOT' && (!s.name || !s.personality)) this._fillBot(i);
        });

        this._materialisePlayers();
        this.captures = [0, 0, 0, 0];
        this.ranks = [0, 0, 0, 0];
        this.lastRank = 0;
        this.consecutiveSixes = 0;
        this.turnCount = 0;
        this.noMoveStreak = [0, 0, 0, 0];
        this.currentPlayerIndex = this._firstActive();
        this.started = true;
        this._beginTurn();
    }

    handleDisconnect(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return;
        this.seats[seat].connected = false;

        if (this.phase === PHASES.LOBBY) {
            // A brief network blip must NOT cost you your lobby seat or hand the
            // host crown to someone else. Hold the chair (keep sessionId + name)
            // for the reconnect window — reconnecting restores you exactly, host
            // and all. Only once the window lapses does _evictLobbySeat free the
            // seat and promote the next connected human. Mirrors the in-game
            // reconnect grace so a flaky link behaves the same in the lobby as it
            // does mid-game.
            this._startGrace(seat);
            this._broadcastState(REASON.DISCONNECT);
            return;
        }

        if (this.phase === PHASES.ENDED) return;

        // A player who has already finished is just spectating — no reconnect
        // window, the game flows on. If they were the last human watching a
        // bots-only endgame, end it.
        if (!this.positions[seat] || isPlayerFinished(this.positions[seat])) {
            this._broadcastState(REASON.DISCONNECT);
            if (!this.seats.some(s => s.type === 'PLAYER' && s.connected)) this._end(REASON.ABANDONED);
            return;
        }

        // Active human dropped mid-game: start their reconnect countdown.
        // Clients dim them. If it was their turn, HOLD the game right here —
        // phase, dice and legal moves intact, so a reconnect resumes the turn
        // exactly where it stopped (even mid-AWAIT_MOVE). The turn is never
        // handed to the next player unless the grace window forfeits the seat.
        this._startGrace(seat);
        if (seat === this.currentPlayerIndex) this.waiting = true;
        this._broadcastState(REASON.DISCONNECT);
    }

    /**
     * Explicit "Leave game" — the player confirmed the exit dialog instead of
     * letting it lapse. Forfeit the seat NOW rather than arming/awaiting the
     * reconnect grace: this produces exactly the end state `_onGraceExpire`
     * would, just immediately. Safe in any phase and idempotent — a seat that's
     * already gone (sessionId not found) no-ops, and a finished/spectating seat
     * has no pawns to strip so it falls through to a plain disconnect.
     *
     * NB: the exit dialog suspended the socket, so the client delivers this over
     * a fresh throwaway connection. That connection is a reconnect server-side
     * (handleJoin un-dims + clears grace) immediately before this fires — which
     * is why we re-mark the seat disconnected here before forfeiting.
     */
    handleLeave(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return;
        this.seats[seat].connected = false;
        if (this.phase === PHASES.LOBBY) return this._evictLobbySeat(seat);
        if (this.phase === PHASES.ENDED) return;
        if (this._isActiveHuman(seat)) return this._dropSeat(seat);
        // Finished/spectating: no pawns to forfeit — mirror the disconnect path.
        this._broadcastState(REASON.DISCONNECT);
        if (!this.seats.some(s => s.type === 'PLAYER' && s.connected)) this._end(REASON.ABANDONED);
    }

    // ---- seat predicates ----------------------------------------------------
    // The disconnect/turn logic repeatedly scans the four seats for the same few
    // shapes. `_seatsWhere` runs a predicate over every seat index; the named
    // predicates below are the building blocks. Mind the subtle differences:
    // `_isActiveInGameSeat` does NOT filter out finished players (it just asks
    // "does this seat still hold pawns?"), whereas the human predicates do.

    /** Seat indexes for which `predicate(i)` is truthy. */
    _seatsWhere(predicate) {
        const out = [];
        for (let i = 0; i < 4; i++) if (predicate(i)) out.push(i);
        return out;
    }

    /** Seat still holding pawns on the board, any type, finished or not. */
    _isActiveInGameSeat(i) {
        return !!(this.playerTypes[i] && this.positions[i]);
    }

    /** Human seat still in the game: not forfeited and not finished, link aside. */
    _isActiveHuman(i) {
        return this.playerTypes[i] === 'PLAYER' && !!this.positions[i]
            && !isPlayerFinished(this.positions[i]);
    }

    // ---- disconnect / reconnect plumbing ------------------------------------

    /** Active (unfinished) human seats currently disconnected and counting down. */
    _disconnectedActiveHumans() {
        return this._seatsWhere(i => this._isActiveHuman(i) && !this.seats[i].connected);
    }

    /** Human seats still in the game (not forfeited, not finished), regardless of link. */
    _seatedActiveHumans() {
        return this._seatsWhere(i => this._isActiveHuman(i));
    }

    /** Seats still holding pawns on the board (any type). */
    _activeInGameSeats() {
        return this._seatsWhere(i => this._isActiveInGameSeat(i));
    }

    _startGrace(seat) {
        const s = this.seats[seat];
        if (s.graceTimer) return; // already counting down
        s.graceUntil = this.now() + this.graceMs;
        s.graceTimer = this.setTimer(() => { s.graceTimer = null; this._onGraceExpire(seat); }, this.graceMs);
    }

    /** Reconnect window lapsed for `seat`. The same grace clock guards a lobby
     *  chair and an in-game seat, but the consequence differs: in the lobby we
     *  release the chair (and reassign the host), in-game we forfeit the pawns.
     *  One entrypoint so the timer arm/resume paths never branch on phase. */
    _onGraceExpire(seat) {
        if (this.phase === PHASES.LOBBY) this._evictLobbySeat(seat);
        else this._dropSeat(seat);
    }

    /** Lobby reconnect window elapsed: free the held chair and, if it was the
     *  host's, promote the next connected human (null if none). Ends the room if
     *  no connected human is left. The deferred half of the LOBBY disconnect. */
    _evictLobbySeat(seat) {
        if (this.phase !== PHASES.LOBBY) return; // game started/ended while we waited
        const s = this.seats[seat];
        if (!s || s.connected) return; // raced a reconnect — keep them seated
        const wasHost = s.sessionId === this.hostSession;
        this._clearGrace(seat);
        s.sessionId = null;
        s.name = '';
        if (wasHost) {
            const next = this.seats.find(x => x.sessionId && x.connected);
            this.hostSession = next ? next.sessionId : null;
        }
        if (!this.seats.some(x => x.type === 'PLAYER' && x.connected)) return this._end(REASON.ABANDONED);
        this._broadcastState(REASON.DISCONNECT);
    }

    _clearGrace(seat) {
        const s = this.seats[seat];
        if (s.graceTimer) { this.clearTimer(s.graceTimer); s.graceTimer = null; }
        s.graceUntil = 0;
    }

    /** A seat whose human is currently disconnected mid-reconnect. */
    _isDisconnectedHuman(i) {
        return this._isActiveHuman(i) && !this.seats[i].connected;
    }

    /** Reconnect window elapsed: forfeit the seat (remove pawns) and continue. */
    _dropSeat(seat) {
        if (this.phase === PHASES.ENDED) return;
        const s = this.seats[seat];
        if (!s || this.playerTypes[seat] !== 'PLAYER') return; // already gone / not human
        if (s.connected) return; // raced a reconnect — keep them in

        this._clearGrace(seat);
        const wasCurrent = seat === this.currentPlayerIndex;

        // Forfeit: strip the pawns and deactivate the seat. This is the one spot
        // that must keep BOTH representations in sync after the game has started:
        // the derived in-game arrays (playerTypes/positions/ranks — what the pure
        // turn logic reads) AND the lobby seat object (what _publicState reports).
        // Update only one and the board and the seat list disagree.
        this.playerTypes[seat] = undefined;
        this.positions[seat] = null;
        this.ranks[seat] = 0;
        s.type = null;
        s.sessionId = null;
        s.connected = false;
        s.name = '';

        // Tell clients to clear this player's pawns from the board.
        this._broadcast({ t: MSG.DROPPED, seat, state: this._publicState() });

        // Only one human (or one participant) left → the match is over.
        if (this._seatedActiveHumans().length <= 1 || this._activeInGameSeats().length <= 1) {
            return this._end(REASON.OPPONENT_LEFT);
        }

        // The game only ever holds on the CURRENT player; if the forfeited seat
        // is the one it was held on (or it was simply their turn), advance —
        // _beginTurn re-evaluates and re-holds if the next player is also down.
        // A non-current forfeit must NOT advance: that would skip the turn the
        // game is still holding for someone else.
        if (wasCurrent) this._advanceTurn();
    }

    // ---- in-game intents ----------------------------------------------------

    handleRoll(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, ERR.NOT_SEATED);
        if (this.phase !== PHASES.AWAIT_ROLL) return this._reject(seat, ERR.NOT_AWAITING_ROLL);
        if (seat !== this.currentPlayerIndex) return this._reject(seat, ERR.NOT_YOUR_TURN);
        if (this.playerTypes[seat] !== 'PLAYER') return this._reject(seat, ERR.NOT_A_HUMAN_SEAT);
        this._doRoll();
        return { ok: true };
    }

    handleMove(sessionId, tokenIndex) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, ERR.NOT_SEATED);
        if (this.phase !== PHASES.AWAIT_MOVE) return this._reject(seat, ERR.NOT_AWAITING_MOVE);
        if (seat !== this.currentPlayerIndex) return this._reject(seat, ERR.NOT_YOUR_TURN);
        if (!this.legalMoves.includes(tokenIndex)) return this._reject(seat, ERR.ILLEGAL_MOVE);
        this._applyMoveAndContinue(tokenIndex);
        return { ok: true };
    }

    // ---- turn machine -------------------------------------------------------

    _beginTurn() {
        if (this.phase === PHASES.ENDED) return;
        // The rotation reached a disconnected human: HOLD here until they
        // reconnect or the grace window forfeits them. Their turn is never
        // skipped — a broken link must block the game, not cost the player
        // their turns while they scramble to get back.
        if (this._isDisconnectedHuman(this.currentPlayerIndex)) {
            this.waiting = true;
            this.phase = PHASES.AWAIT_ROLL;
            this.currentDiceRoll = 0;
            this.legalMoves = [];
            this._broadcastState(REASON.WAITING);
            return;
        }
        this.waiting = false;
        this.phase = PHASES.AWAIT_ROLL;
        this.currentDiceRoll = 0;
        this.legalMoves = [];
        this._broadcastState(REASON.TURN);
        if (this.playerTypes[this.currentPlayerIndex] === 'BOT') {
            this.schedule(() => this._botStep(), this.botDelayMs);
        }
    }

    /**
     * Shared roll resolution for human and bot turns: roll the dice, handle the
     * three-sixes bust and the no-legal-move pass (both advance the turn), else
     * enter AWAIT_MOVE and broadcast 'rolled'.
     * @returns {number[]|null} the legal token indexes, or null when the turn was
     *   already advanced (bust / no move) and the caller should stop.
     */
    _rollAndResolve() {
        const pi = this.currentPlayerIndex;
        const hasTokenAtHome = !!this.positions[pi] && this.positions[pi].includes(-1);
        const dice = rollDiceWithPity(this.noMoveStreak[pi], hasTokenAtHome, this.rng, this.consecutiveSixes);
        this.currentDiceRoll = dice;
        this.consecutiveSixes = dice === 6 ? this.consecutiveSixes + 1 : 0;

        // rollDiceWithPity caps the streak at two — a would-be third six is
        // downgraded to 1..5 — so this bust is now an unreachable backstop. Kept
        // for protocol compatibility and as a guard if a future non-capped roll
        // path is added.
        if (this.consecutiveSixes === 3) {
            this.consecutiveSixes = 0;
            this._broadcastState(REASON.THREE_SIXES);
            this._advanceTurn();
            return null;
        }
        const movable = this._movable();
        if (movable.length === 0) {
            this.consecutiveSixes = 0;
            this.noMoveStreak[pi]++;
            this._broadcastState(REASON.NO_MOVE);
            this._advanceTurn();
            return null;
        }
        this.noMoveStreak[pi] = 0;
        this.legalMoves = movable;
        this.phase = PHASES.AWAIT_MOVE;
        this._broadcastState(REASON.ROLLED);
        return movable;
    }

    _doRoll() {
        const movable = this._rollAndResolve();
        if (!movable) return;
        // A forced single move auto-applies; otherwise wait for the human's pick.
        if (movable.length === 1) this._applyMoveAndContinue(movable[0]);
    }

    _botStep() {
        if (this.phase === PHASES.ENDED) return;
        const pi = this.currentPlayerIndex;
        if (this.playerTypes[pi] !== 'BOT') return;
        const movable = this._rollAndResolve();
        if (!movable) return;
        const weights = PERSONALITIES[this.botPersonalities[pi]] || PERSONALITIES.balanced;
        let tokenIndex = pickBestMove(pi, this.currentDiceRoll, this.positions, weights, 0);
        if (tokenIndex < 0 || !movable.includes(tokenIndex)) tokenIndex = movable[0];
        this._applyMoveAndContinue(tokenIndex);
    }

    _applyMoveAndContinue(tokenIndex) {
        const pi = this.currentPlayerIndex;
        const dice = this.currentDiceRoll;
        const result = applyMove(this.positions, pi, tokenIndex, dice);
        this.positions = result.next;
        this.captures[pi] += result.captureCount;
        this.legalMoves = [];

        let ended = false;
        if (result.tripComplete && isPlayerFinished(this.positions[pi])) {
            this.ranks[pi] = ++this.lastRank;
            if (shouldEndGame(this.playerTypes, this.positions)) {
                this._rankLeftovers();
                ended = true;
            }
        }

        this._broadcast({
            t: MSG.MOVED,
            p: pi,
            token: tokenIndex,
            from: result.fromPosition,
            to: result.newPosition,
            caps: result.captured,
            state: this._publicState(),
        });

        if (ended) return this._end(REASON.FINISHED);

        const playsAgain = (dice === 6 || result.captureCount > 0 || result.tripComplete)
            && !isPlayerFinished(this.positions[pi]);
        if (playsAgain) {
            this.phase = PHASES.AWAIT_ROLL;
            this.currentDiceRoll = 0;
            this._broadcastState(REASON.AGAIN);
            if (this.playerTypes[pi] === 'BOT') this.schedule(() => this._botStep(), this.botDelayMs);
        } else {
            this._advanceTurn();
        }
    }

    /** Award finishing ranks to every still-unfinished active player, by progress. */
    _rankLeftovers() {
        computeLeftoverRankOrder(this.playerTypes, this.positions, this.ranks)
            .forEach(idx => { this.ranks[idx] = ++this.lastRank; });
    }

    _advanceTurn() {
        const next = getNextPlayerIndex(this.currentPlayerIndex, this.playerTypes, this.positions);
        if (next === -1) return this._end(REASON.NO_ACTIVE_PLAYERS);
        this.currentPlayerIndex = next;
        this.consecutiveSixes = 0;
        this.turnCount++;
        this._beginTurn();
    }

    _end(reason) {
        if (this.phase === PHASES.ENDED) return;
        for (let i = 0; i < 4; i++) this._clearGrace(i);
        this.waiting = false;
        if (this.started) this._rankLeftovers();
        this.phase = PHASES.ENDED;
        this._broadcast({ t: MSG.ENDED, reason, ranks: this.ranks.slice(), state: this._publicState() });
        this.transport.release?.();
    }

    // ---- helpers ------------------------------------------------------------

    _movable() {
        const out = [];
        const toks = this.positions[this.currentPlayerIndex];
        for (let ti = 0; ti < 4; ti++) {
            if (isTokenMovable(toks[ti], this.currentDiceRoll)) out.push(ti);
        }
        return out;
    }

    _reject(seat, error) {
        // seat === -1 means the sender isn't seated (no transport channel to it),
        // so we deliberately skip the per-seat frame and just return the error to
        // the caller — not a bug, there's simply nobody to send the rejection to.
        if (seat !== undefined && seat !== -1) this.transport.send(seat, { t: MSG.REJECTED, error });
        return { ok: false, error };
    }

    _publicState() {
        return {
            roomId: this.roomId,
            phase: this.phase,
            started: this.started,
            // Seats mid-reconnect, with their live countdown — clients dim these
            // players (and may show the remaining time) without a server clock.
            disconnects: this._disconnectedActiveHumans().map(i => ({
                index: i,
                name: this.seats[i].name,
                remainingMs: Math.max(0, (this.seats[i].graceUntil || 0) - this.now()),
            })),
            // The game is held on a disconnected human's turn — clients show the
            // "waiting for X to reconnect" banner off this flag.
            waiting: this.waiting,
            hostSeat: this._hostSeat(),
            size: this._activeCount(),
            currentPlayerIndex: this.currentPlayerIndex,
            turn: this.turnCount,
            dice: this.currentDiceRoll,
            legalMoves: this.legalMoves.slice(),
            playerTypes: this.seats.map(s => s.type ?? null),
            playerNames: this.seats.map(s => s.name),
            positions: this.positions.map(p => (p ? p.slice() : null)),
            captures: this.captures.slice(),
            ranks: this.ranks.slice(),
            lastRank: this.lastRank,
            seats: this.seats.map((s, i) => ({
                index: i,
                type: s.type ?? null,
                name: s.name,
                connected: s.connected,
                claimed: s.sessionId != null,
                isBot: s.type === 'BOT',
                isHost: s.sessionId != null && s.sessionId === this.hostSession,
            })),
        };
    }

    _broadcastState(reason) {
        this._broadcast({ t: MSG.STATE, reason, state: this._publicState() });
    }
}
