/**
 * Pure programmatic game driver. No DOM, no timers. Composes game-logic,
 * bot-ai, and turn-rules into a deterministic game loop given an RNG.
 * Used by integration tests; can also be reused for replay / sim tooling.
 */
import {
    isTokenMovable,
    getTokenNewPosition,
    findCapturedOpponents,
    isTripComplete,
    rollDiceWithPity,
} from './game-logic.js';
import { pickBestMove, PERSONALITIES } from './bot-ai.js';
import {
    isPlayerFinished,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
    grantsAnotherTurn,
} from './turn-rules.js';
import { EVENTS } from '../state/game-reducer.js';

/**
 * Seedable PRNG (mulberry32). Returns a function compatible with Math.random.
 * @param {number} seed
 */
export function makeRng(seed) {
    let s = seed >>> 0;
    return function rng() {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function cloneBoard(positions) {
    return positions.map(p => (p ? p.slice() : null));
}

function listMovableTokenIndexes(playerTokens, dice) {
    const out = [];
    for (let ti = 0; ti < 4; ti++) {
        if (isTokenMovable(playerTokens[ti], dice)) out.push(ti);
    }
    return out;
}

function applyMove(positions, playerIndex, tokenIndex, dice) {
    const next = cloneBoard(positions);
    const fromPos = next[playerIndex][tokenIndex];
    const newPos = getTokenNewPosition(fromPos, dice);
    next[playerIndex][tokenIndex] = newPos;

    const captured = findCapturedOpponents(playerIndex, newPos, next);
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
    return {
        next,
        fromPosition: fromPos,
        newPosition: newPos,
        captureCount,
        captured: capturedList,
        tripComplete: isTripComplete(newPos),
    };
}

/**
 * Run a full game programmatically.
 *
 * @param {object} opts
 * @param {('PLAYER'|'BOT'|undefined)[]} opts.playerTypes
 * @param {number[][]} [opts.initialPositions]  defaults to all-home for defined players
 * @param {number} [opts.startingPlayerIndex]
 * @param {() => number} [opts.rng]             defaults to seed=1 mulberry32
 * @param {string[]} [opts.botPersonalities]    per-player personality name (driver treats PLAYER same as BOT for decisions)
 * @param {number} [opts.botDepth]              expectiminimax depth (default 0 for test speed)
 * @param {number} [opts.maxTurns]              safety bail (default 5000)
 * @returns {{
 *   positions: number[][],
 *   ranks: number[],
 *   captures: number[],
 *   turns: number,
 *   ended: boolean,
 *   lastRank: number,
 *   winner: number,    -1 if not ended
 * }}
 */
export function runGame(opts) {
    const playerTypes = opts.playerTypes;
    const rng = opts.rng || makeRng(1);
    const botDepth = opts.botDepth ?? 0;
    const maxTurns = opts.maxTurns ?? 5000;
    const personalities = opts.botPersonalities
        || playerTypes.map(t => (t ? 'balanced' : null));

    const positions = playerTypes.map((t, i) => {
        if (!t) return null;
        if (opts.initialPositions && opts.initialPositions[i]) {
            return opts.initialPositions[i].slice();
        }
        return [-1, -1, -1, -1];
    });

    const ranks = [0, 0, 0, 0];
    const captures = [0, 0, 0, 0];

    let currentPlayerIndex = opts.startingPlayerIndex
        ?? playerTypes.findIndex(t => t !== undefined);
    let consecutiveSixes = 0;
    const noMoveStreak = [0, 0, 0, 0];
    let lastRank = 0;
    let turns = 0;
    let ended = false;
    let winner = -1;

    const events = [];
    events.push({
        type: EVENTS.GAME_STARTED,
        quickStartId: null,
        gameStartedAt: 0,
        playerTypes: playerTypes.slice(),
        botPersonalities: personalities.slice(),
        playerNames: ['', '', '', ''],
        playerTokenPositions: positions.map(p => p ? p.slice() : null),
        currentPlayerIndex,
    });

    while (turns++ < maxTurns) {
        if (positions[currentPlayerIndex] === null) {
            // Should never happen given valid inputs, guard anyway.
            const next = getNextPlayerIndex(currentPlayerIndex, playerTypes, positions);
            if (next === -1) break;
            events.push({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: next });
            currentPlayerIndex = next;
            continue;
        }

        const hasTokenAtHome = positions[currentPlayerIndex].includes(-1);
        const dice = rollDiceWithPity(noMoveStreak[currentPlayerIndex], hasTokenAtHome, rng);
        events.push({ type: EVENTS.DICE_ROLLED, value: dice });
        if (dice === 6) consecutiveSixes++;
        else consecutiveSixes = 0;

        if (consecutiveSixes === 3) {
            events.push({ type: EVENTS.THREE_SIXES_LOST });
            consecutiveSixes = 0;
            const next = getNextPlayerIndex(currentPlayerIndex, playerTypes, positions);
            if (next === -1) { ended = true; break; }
            events.push({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: next });
            currentPlayerIndex = next;
            continue;
        }

        const movable = listMovableTokenIndexes(positions[currentPlayerIndex], dice);

        if (movable.length === 0) {
            consecutiveSixes = 0;
            noMoveStreak[currentPlayerIndex]++;
            events.push({ type: EVENTS.PLAYER_STUCK });
            const next = getNextPlayerIndex(currentPlayerIndex, playerTypes, positions);
            if (next === -1) { ended = true; break; }
            events.push({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: next });
            currentPlayerIndex = next;
            continue;
        }

        noMoveStreak[currentPlayerIndex] = 0;

        const weights = PERSONALITIES[personalities[currentPlayerIndex]] || PERSONALITIES.balanced;
        let tokenIndex = pickBestMove(currentPlayerIndex, dice, positions, weights, botDepth);
        if (tokenIndex < 0) tokenIndex = movable[0];

        const result = applyMove(positions, currentPlayerIndex, tokenIndex, dice);
        events.push({
            type: EVENTS.TOKEN_MOVED,
            playerIndex: currentPlayerIndex,
            tokenIndex,
            fromPosition: result.fromPosition,
            toPosition: result.newPosition,
        });
        for (const cap of result.captured) {
            events.push({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: currentPlayerIndex,
                capturedPlayerIndex: cap.playerIndex,
                capturedTokenIndex: cap.tokenIndex,
            });
        }
        for (let pi = 0; pi < 4; pi++) {
            for (let ti = 0; ti < 4; ti++) {
                if (positions[pi] && result.next[pi] && positions[pi][ti] !== result.next[pi][ti]) {
                    positions[pi][ti] = result.next[pi][ti];
                }
            }
        }
        captures[currentPlayerIndex] += result.captureCount;

        let isGameDone = false;
        if (result.tripComplete && isPlayerFinished(positions[currentPlayerIndex])) {
            ranks[currentPlayerIndex] = ++lastRank;
            events.push({
                type: EVENTS.PLAYER_FINISHED,
                playerIndex: currentPlayerIndex,
                rank: lastRank,
                time: 0,
            });
            if (shouldEndGame(playerTypes, positions)) {
                computeLeftoverRankOrder(playerTypes, positions, ranks)
                    .forEach(pi => {
                        ranks[pi] = ++lastRank;
                        events.push({
                            type: EVENTS.LEFTOVER_RANKED,
                            playerIndex: pi,
                            rank: lastRank,
                            time: 0,
                        });
                    });
                isGameDone = true;
                if (winner === -1) winner = currentPlayerIndex;
                events.push({ type: EVENTS.GAME_ENDED, winnerIndex: winner });
            } else if (winner === -1) {
                winner = currentPlayerIndex;
            }
        }

        if (isGameDone) {
            ended = true;
            break;
        }

        const playsAgain = grantsAnotherTurn(
            dice, result.captureCount, result.tripComplete,
            isPlayerFinished(positions[currentPlayerIndex]),
        );
        if (!playsAgain) {
            const next = getNextPlayerIndex(currentPlayerIndex, playerTypes, positions);
            if (next === -1) { ended = true; break; }
            events.push({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: next });
            currentPlayerIndex = next;
            consecutiveSixes = 0;
        }
    }

    return { positions, ranks, captures, turns, ended, lastRank, winner, events };
}
