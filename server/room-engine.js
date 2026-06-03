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
    generateDiceRoll,
} from '../scripts/game-logic.js';
import { pickBestMove, PERSONALITIES } from '../scripts/bot-ai.js';
import {
    isPlayerFinished,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
} from '../scripts/turn-rules.js';
import { makeRng } from '../scripts/game-driver.js';

export const PHASES = Object.freeze({
    LOBBY: 'LOBBY',
    AWAIT_ROLL: 'AWAIT_ROLL',
    AWAIT_MOVE: 'AWAIT_MOVE',
    ENDED: 'ENDED',
});

const MIN_PLAYERS = 2;

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
        this.transport = opts.transport;
        this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
        this.botDelayMs = opts.botDelayMs ?? 600;

        // ---- lobby seat model ----
        const size = Math.max(MIN_PLAYERS, Math.min(4, opts.size ?? 2));
        const plan = opts.seatPlan || [0, 1, 2, 3].map(i => (i < size ? 'PLAYER' : null));
        this.seats = [0, 1, 2, 3].map(i => ({
            type: plan[i] || null,       // 'PLAYER' | 'BOT' | null(closed)
            sessionId: null,             // null = open (PLAYER) or n/a (BOT/closed)
            name: plan[i] === 'BOT' ? `Bot ${i + 1}` : '',
            personality: plan[i] === 'BOT' ? 'balanced' : null,
            connected: false,
        }));
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
        this.consecutiveSixes = 0;
        this.captures = [0, 0, 0, 0];
        this.ranks = [0, 0, 0, 0];
        this.lastRank = 0;
        this.legalMoves = [];
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

    _firstActive() {
        return this.playerTypes.findIndex(t => t !== undefined);
    }

    // ---- lobby intents ------------------------------------------------------

    /** Seat a (re)connecting human. First to join becomes host. Reconnect = same seat. */
    handleJoin(sessionId, name) {
        let seat = this._seatOf(sessionId);
        if (seat === -1) {
            seat = this.seats.findIndex(s => s.type === 'PLAYER' && s.sessionId === null);
            if (seat === -1) return { ok: false, error: 'ROOM_FULL' };
            this.seats[seat].sessionId = sessionId;
            this.seats[seat].name = name || `Player ${seat + 1}`;
            if (this.hostSession == null) this.hostSession = sessionId;
        }
        if (name) this.seats[seat].name = name;
        this.seats[seat].connected = true;
        this.transport.send(seat, {
            t: 'seated',
            playerIndex: seat,
            isHost: this._isHost(sessionId),
            roomId: this.roomId,
        });
        this._broadcastState('join');
        return { ok: true, seat };
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
            if (i === -1) return this._reject(this._seatOf(sessionId), 'CANT_SHRINK'); // would kick a human
            this._closeSeat(i);
        }
        this._broadcastState('lobby');
        return { ok: true };
    }

    /**
     * Host: set seat `i` to 'PLAYER' (open human seat), 'BOT', or 'CLOSED'.
     * Replacing a connected human boots them (a kick).
     */
    handleSetSeat(sessionId, i, type) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        const seat = this.seats[i];
        if (!seat) return this._reject(this._seatOf(sessionId), 'BAD_SEAT');
        if (seat.sessionId === this.hostSession) return this._reject(this._seatOf(sessionId), 'CANT_CHANGE_HOST');

        if (type === 'BOT') {
            this._bootIfHuman(i);
            seat.type = 'BOT';
            seat.sessionId = null;
            seat.connected = false;
            seat.name = `Bot ${i + 1}`;
            seat.personality = 'balanced';
        } else if (type === 'PLAYER') {
            this._openSeat(i);
        } else if (type === 'CLOSED') {
            if (this._activeCount() <= MIN_PLAYERS) return this._reject(this._seatOf(sessionId), 'MIN_TWO');
            this._closeSeat(i);
        } else {
            return this._reject(this._seatOf(sessionId), 'BAD_TYPE');
        }
        this._broadcastState('lobby');
        return { ok: true };
    }

    /** Host: remove the human in seat `i` (back to an open seat). */
    handleKick(sessionId, i) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        const seat = this.seats[i];
        if (!seat || seat.type !== 'PLAYER' || !seat.sessionId) return this._reject(this._seatOf(sessionId), 'NOTHING_TO_KICK');
        if (seat.sessionId === this.hostSession) return this._reject(this._seatOf(sessionId), 'CANT_KICK_HOST');
        this._bootIfHuman(i); // notifies + reopens
        this._broadcastState('lobby');
        return { ok: true };
    }

    /** Host: start the game. Open human seats fill with bots. */
    handleStart(sessionId) {
        const guard = this._hostLobbyGuard(sessionId);
        if (guard) return guard;
        if (this._activeCount() < MIN_PLAYERS) return this._reject(this._seatOf(sessionId), 'NEED_TWO_PLAYERS');
        this._startGame();
        return { ok: true };
    }

    _hostLobbyGuard(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, 'NOT_SEATED');
        if (this.phase !== PHASES.LOBBY) return this._reject(seat, 'NOT_IN_LOBBY');
        if (!this._isHost(sessionId)) return this._reject(seat, 'NOT_HOST');
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

    /** If a connected human sits here, tell them they were removed, then clear. */
    _bootIfHuman(i) {
        const s = this.seats[i];
        if (s.type === 'PLAYER' && s.sessionId && s.sessionId !== this.hostSession) {
            this.transport.send(i, { t: 'kicked' });
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

    _startGame() {
        // Open human seats with nobody in them become bots.
        this.seats.forEach((s, i) => {
            if (s.type === 'PLAYER' && s.sessionId === null) {
                s.type = 'BOT';
                s.name = `Bot ${i + 1}`;
                s.personality = 'balanced';
            }
            if (s.type === 'BOT' && !s.personality) s.personality = 'balanced';
        });

        this.playerTypes = this.seats.map(s => s.type || undefined);
        this.playerNames = this.seats.map((s, i) => s.name || (s.type === 'BOT' ? `Bot ${i + 1}` : `Player ${i + 1}`));
        this.botPersonalities = this.seats.map(s => (s.type === 'BOT' ? (s.personality || 'balanced') : null));
        this.positions = this.seats.map(s => (s.type ? [-1, -1, -1, -1] : null));
        this.captures = [0, 0, 0, 0];
        this.ranks = [0, 0, 0, 0];
        this.lastRank = 0;
        this.consecutiveSixes = 0;
        this.currentPlayerIndex = this._firstActive();
        this.started = true;
        this._beginTurn();
    }

    handleDisconnect(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return;
        this.seats[seat].connected = false;

        if (this.phase === PHASES.LOBBY) {
            // Free the seat so someone else can take it; promote a new host if needed.
            this.seats[seat].sessionId = null;
            this.seats[seat].name = '';
            if (sessionId === this.hostSession) {
                const next = this.seats.find(s => s.sessionId && s.connected);
                this.hostSession = next ? next.sessionId : null;
            }
            if (!this.seats.some(s => s.type === 'PLAYER' && s.connected)) return this._end('abandoned');
            this._broadcastState('disconnect');
            return;
        }

        this._broadcastState('disconnect');
        if (!this.seats.some(s => s.type === 'PLAYER' && s.connected)) this._end('abandoned');
    }

    // ---- in-game intents ----------------------------------------------------

    handleRoll(sessionId) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, 'NOT_SEATED');
        if (this.phase !== PHASES.AWAIT_ROLL) return this._reject(seat, 'NOT_AWAITING_ROLL');
        if (seat !== this.currentPlayerIndex) return this._reject(seat, 'NOT_YOUR_TURN');
        if (this.playerTypes[seat] !== 'PLAYER') return this._reject(seat, 'NOT_A_HUMAN_SEAT');
        this._doRoll(seat);
        return { ok: true };
    }

    handleMove(sessionId, tokenIndex) {
        const seat = this._seatOf(sessionId);
        if (seat === -1) return this._reject(seat, 'NOT_SEATED');
        if (this.phase !== PHASES.AWAIT_MOVE) return this._reject(seat, 'NOT_AWAITING_MOVE');
        if (seat !== this.currentPlayerIndex) return this._reject(seat, 'NOT_YOUR_TURN');
        if (!this.legalMoves.includes(tokenIndex)) return this._reject(seat, 'ILLEGAL_MOVE');
        this._applyMoveAndContinue(tokenIndex);
        return { ok: true };
    }

    // ---- turn machine -------------------------------------------------------

    _beginTurn() {
        if (this.phase === PHASES.ENDED) return;
        this.phase = PHASES.AWAIT_ROLL;
        this.currentDiceRoll = 0;
        this.legalMoves = [];
        this._broadcastState('turn');
        if (this.playerTypes[this.currentPlayerIndex] === 'BOT') {
            this.schedule(() => this._botStep(), this.botDelayMs);
        }
    }

    _doRoll() {
        const dice = generateDiceRoll(this.rng);
        this.currentDiceRoll = dice;
        this.consecutiveSixes = dice === 6 ? this.consecutiveSixes + 1 : 0;

        if (this.consecutiveSixes === 3) {
            this.consecutiveSixes = 0;
            this._broadcastState('three-sixes');
            return this._advanceTurn();
        }
        const movable = this._movable();
        if (movable.length === 0) {
            this.consecutiveSixes = 0;
            this._broadcastState('no-move');
            return this._advanceTurn();
        }
        this.legalMoves = movable;
        this.phase = PHASES.AWAIT_MOVE;
        this._broadcastState('rolled');
        if (movable.length === 1) this._applyMoveAndContinue(movable[0]);
    }

    _botStep() {
        if (this.phase === PHASES.ENDED) return;
        const pi = this.currentPlayerIndex;
        if (this.playerTypes[pi] !== 'BOT') return;

        const dice = generateDiceRoll(this.rng);
        this.currentDiceRoll = dice;
        this.consecutiveSixes = dice === 6 ? this.consecutiveSixes + 1 : 0;

        if (this.consecutiveSixes === 3) {
            this.consecutiveSixes = 0;
            this._broadcastState('three-sixes');
            return this._advanceTurn();
        }
        const movable = this._movable();
        if (movable.length === 0) {
            this.consecutiveSixes = 0;
            this._broadcastState('no-move');
            return this._advanceTurn();
        }
        this.legalMoves = movable;
        this.phase = PHASES.AWAIT_MOVE;
        this._broadcastState('rolled');
        const weights = PERSONALITIES[this.botPersonalities[pi]] || PERSONALITIES.balanced;
        let tokenIndex = pickBestMove(pi, dice, this.positions, weights, 0);
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
                computeLeftoverRankOrder(this.playerTypes, this.positions, this.ranks)
                    .forEach(idx => { this.ranks[idx] = ++this.lastRank; });
                ended = true;
            }
        }

        this.transport.broadcast({
            t: 'moved',
            p: pi,
            token: tokenIndex,
            from: result.fromPosition,
            to: result.newPosition,
            caps: result.captured,
            state: this._publicState(),
        });

        if (ended) return this._end('finished');

        const playsAgain = (dice === 6 || result.captureCount > 0 || result.tripComplete)
            && !isPlayerFinished(this.positions[pi]);
        if (playsAgain) {
            this.phase = PHASES.AWAIT_ROLL;
            this.currentDiceRoll = 0;
            this._broadcastState('again');
            if (this.playerTypes[pi] === 'BOT') this.schedule(() => this._botStep(), this.botDelayMs);
        } else {
            this._advanceTurn();
        }
    }

    _advanceTurn() {
        const next = getNextPlayerIndex(this.currentPlayerIndex, this.playerTypes, this.positions);
        if (next === -1) return this._end('no-active-players');
        this.currentPlayerIndex = next;
        this.consecutiveSixes = 0;
        this._beginTurn();
    }

    _end(reason) {
        if (this.phase === PHASES.ENDED) return;
        if (this.started) {
            computeLeftoverRankOrder(this.playerTypes, this.positions, this.ranks)
                .forEach(idx => { this.ranks[idx] = ++this.lastRank; });
        }
        this.phase = PHASES.ENDED;
        this.transport.broadcast({ t: 'ended', reason, ranks: this.ranks.slice(), state: this._publicState() });
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
        if (seat !== undefined && seat !== -1) this.transport.send(seat, { t: 'rejected', error });
        return { ok: false, error };
    }

    _publicState() {
        return {
            roomId: this.roomId,
            phase: this.phase,
            started: this.started,
            hostSeat: this._hostSeat(),
            size: this._activeCount(),
            currentPlayerIndex: this.currentPlayerIndex,
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
        this.transport.broadcast({ t: 'state', reason, state: this._publicState() });
    }
}
