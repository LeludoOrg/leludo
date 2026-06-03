/**
 * RoomEngine — server-authoritative Ludo room, runtime-agnostic.
 *
 * This is the "thin state shell" from docs/multiplayer-plan.md. ALL game rules
 * stay in the existing pure modules (game-logic / turn-rules / bot-ai); this
 * class is an *interactive* version of scripts/game-driver.js `runGame`: instead
 * of one synchronous `while`, it pauses at each human decision and waits for an
 * intent message, then resumes the same loop body.
 *
 * It owns no transport. The host (Node ws server, Cloudflare DO, or a unit-test
 * fake) injects a `transport` with broadcast/send/release, and a `schedule` for
 * paced bot turns. That keeps this file identical across runtimes.
 *
 * Authority guarantees (every handler validates against server state):
 *   - roll only when phase===AWAIT_ROLL and sender===currentPlayer
 *   - move only when phase===AWAIT_MOVE, sender===currentPlayer, token∈legalMoves
 *   - the client never sends positions/dice — those live here only
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
     * @param {('PLAYER'|'BOT'|undefined|null)[]} opts.playerTypes  length-4 seat plan
     * @param {string[]} [opts.names]
     * @param {string[]} [opts.personalities]   per-seat bot personality
     * @param {number} [opts.seed]              server dice RNG seed (deterministic)
     * @param {{broadcast:Function, send:Function, release?:Function}} opts.transport
     * @param {(fn:Function, ms:number)=>void} [opts.schedule]  paced bot scheduler
     * @param {number} [opts.botDelayMs]
     */
    constructor(opts) {
        this.roomId = opts.roomId;
        this.playerTypes = [0, 1, 2, 3].map(i => opts.playerTypes[i] || undefined);
        this.playerNames = [0, 1, 2, 3].map(i =>
            opts.names?.[i] || (this.playerTypes[i] === 'BOT' ? `Bot ${i + 1}` : `Player ${i + 1}`));
        this.botPersonalities = [0, 1, 2, 3].map(i =>
            this.playerTypes[i] === 'BOT' ? (opts.personalities?.[i] || 'balanced') : null);
        this.rng = makeRng(opts.seed ?? 1);
        this.transport = opts.transport;
        this.schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
        this.botDelayMs = opts.botDelayMs ?? 600;

        this.positions = this.playerTypes.map(t => (t ? [-1, -1, -1, -1] : null));
        this.currentPlayerIndex = this._firstActive();
        this.currentDiceRoll = 0;
        this.consecutiveSixes = 0;
        this.captures = [0, 0, 0, 0];
        this.ranks = [0, 0, 0, 0];
        this.lastRank = 0;
        this.legalMoves = [];
        this.phase = PHASES.LOBBY;

        this.seatBySession = new Map(); // sessionId -> seat index
        this.connected = new Set();     // connected seat indexes
        this.started = false;
    }

    // ---- seat helpers -------------------------------------------------------

    _firstActive() {
        return this.playerTypes.findIndex(t => t !== undefined);
    }

    _humanSeats() {
        return [0, 1, 2, 3].filter(i => this.playerTypes[i] === 'PLAYER');
    }

    _nextOpenHumanSeat() {
        const taken = new Set(this.seatBySession.values());
        return this._humanSeats().find(i => !taken.has(i)) ?? -1;
    }

    seatOf(sessionId) {
        return this.seatBySession.get(sessionId) ?? -1;
    }

    // ---- intents ------------------------------------------------------------

    /**
     * Seat a (re)connecting human. Reconnect is keyed by sessionId → same seat.
     * @returns {{ok:true, seat:number} | {ok:false, error:string}}
     */
    handleJoin(sessionId, name) {
        let seat = this.seatBySession.get(sessionId);
        if (seat === undefined) {
            seat = this._nextOpenHumanSeat();
            if (seat === -1) return { ok: false, error: 'ROOM_FULL' };
            this.seatBySession.set(sessionId, seat);
        }
        if (name) this.playerNames[seat] = name;
        this.connected.add(seat);
        this.transport.send(seat, { t: 'seated', playerIndex: seat, roomId: this.roomId });
        this._broadcastState('join');
        this._maybeStart();
        return { ok: true, seat };
    }

    handleDisconnect(sessionId) {
        const seat = this.seatBySession.get(sessionId);
        if (seat === undefined) return;
        this.connected.delete(seat);
        this._broadcastState('disconnect');
        // Pause-and-forfeit grace handling is a later phase; if nobody human is
        // left connected, release the room so it never holds a capacity slot.
        const anyHumanConnected = this._humanSeats().some(i => this.connected.has(i));
        if (!anyHumanConnected) this._end('abandoned');
    }

    /** @returns {{ok:true} | {ok:false, error:string}} */
    handleRoll(sessionId) {
        const seat = this.seatBySession.get(sessionId);
        if (seat === undefined) return this._reject(seat, 'NOT_SEATED');
        if (this.phase !== PHASES.AWAIT_ROLL) return this._reject(seat, 'NOT_AWAITING_ROLL');
        if (seat !== this.currentPlayerIndex) return this._reject(seat, 'NOT_YOUR_TURN');
        if (this.playerTypes[seat] !== 'PLAYER') return this._reject(seat, 'NOT_A_HUMAN_SEAT');
        this._doRoll(seat);
        return { ok: true };
    }

    /** @returns {{ok:true} | {ok:false, error:string}} */
    handleMove(sessionId, tokenIndex) {
        const seat = this.seatBySession.get(sessionId);
        if (seat === undefined) return this._reject(seat, 'NOT_SEATED');
        if (this.phase !== PHASES.AWAIT_MOVE) return this._reject(seat, 'NOT_AWAITING_MOVE');
        if (seat !== this.currentPlayerIndex) return this._reject(seat, 'NOT_YOUR_TURN');
        if (!this.legalMoves.includes(tokenIndex)) return this._reject(seat, 'ILLEGAL_MOVE');
        this._applyMoveAndContinue(tokenIndex);
        return { ok: true };
    }

    // ---- turn machine -------------------------------------------------------

    _maybeStart() {
        if (this.started) return;
        const taken = new Set(this.seatBySession.values());
        const allHumansSeated = this._humanSeats().every(i => taken.has(i));
        if (!allHumansSeated) return;
        this.started = true;
        this.currentPlayerIndex = this._firstActive();
        this._beginTurn();
    }

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

    _doRoll(seat) {
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
        // Forced-move optimization: a single legal move auto-applies (saves the
        // client a second message). Bots always auto-apply via _botStep.
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

        // A 6, a capture, or a completed trip grants another turn — unless the
        // player just finished their last token. Mirrors game-driver `playsAgain`.
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
        // Rank anyone still unranked (covers abandonment / early end).
        computeLeftoverRankOrder(this.playerTypes, this.positions, this.ranks)
            .forEach(idx => { this.ranks[idx] = ++this.lastRank; });
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

    /** Seat-agnostic public snapshot. Each client knows its own seat from `seated`. */
    _publicState() {
        const claimed = new Set(this.seatBySession.values());
        return {
            roomId: this.roomId,
            phase: this.phase,
            started: this.started,
            currentPlayerIndex: this.currentPlayerIndex,
            dice: this.currentDiceRoll,
            legalMoves: this.legalMoves.slice(),
            playerTypes: this.playerTypes.map(t => t ?? null),
            playerNames: this.playerNames.slice(),
            positions: this.positions.map(p => (p ? p.slice() : null)),
            captures: this.captures.slice(),
            ranks: this.ranks.slice(),
            lastRank: this.lastRank,
            seats: [0, 1, 2, 3].map(i => ({
                index: i,
                type: this.playerTypes[i] ?? null,
                name: this.playerNames[i],
                connected: this.connected.has(i),
                claimed: claimed.has(i),
            })),
        };
    }

    _broadcastState(reason) {
        this.transport.broadcast({ t: 'state', reason, state: this._publicState() });
    }
}
