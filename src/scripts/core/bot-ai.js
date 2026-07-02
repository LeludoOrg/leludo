import { SAFE_SQUARES as SAFE_SQUARES_ARR, DICE_WEIGHTS, isTokenMovable, getTokenNewPosition, findCapturedOpponents } from "./game-logic.js";
import {
    YARD,
    ENTRY_SQUARE,
    TRACK_LEN,
    LAST_TRACK_SQUARE,
    FINISH,
    rawMarkIndex,
} from "./board-constants.js";
import { clonePositions } from "./board-util.js";

const SAFE_SQUARES = new Set(SAFE_SQUARES_ARR);

// Per-face probabilities for the expectiminimax chance nodes. Derived from the
// single source of truth (DICE_WEIGHTS) so the bot's model always matches the
// real die — index 0 is a placeholder, faces are 1..6.
const DICE_WEIGHT_TOTAL = DICE_WEIGHTS.reduce((a, b) => a + b, 0);
const DICE_PROB = [0, ...DICE_WEIGHTS.map(w => w / DICE_WEIGHT_TOTAL)];

const DISCOUNT = 0.7;

export const PERSONALITIES = {
    balanced:   { home: 0, finished: 60, progress: 0.5, safe: 3, stack: 4, threat: 4, captureBonus: 10 },
    aggressive: { home: 0, finished: 50, progress: 0.7, safe: 1, stack: 2, threat: 1, captureBonus: 18 },
    defensive:  { home: 0, finished: 60, progress: 0.3, safe: 6, stack: 7, threat: 8, captureBonus: 5 },
    rusher:     { home: 0, finished: 80, progress: 1.0, safe: 1, stack: 1, threat: 2, captureBonus: 6 },
};

const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

export function randomPersonality(rng = Math.random) {
    return PERSONALITY_KEYS[Math.floor(rng() * PERSONALITY_KEYS.length)];
}

function countAt(arr, pos) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === pos) n++;
    return n;
}

function threatCount(myPi, myTi, positions) {
    const p = positions[myPi][myTi];
    if (p < ENTRY_SQUARE || p > LAST_TRACK_SQUARE || SAFE_SQUARES.has(p)) return 0;
    const myMark = rawMarkIndex(myPi, p);
    let n = 0;
    for (let pi = 0; pi < 4; pi++) {
        if (!positions[pi] || pi === myPi) continue;
        for (let ti = 0; ti < 4; ti++) {
            const op = positions[pi][ti];
            if (op < ENTRY_SQUARE || op > LAST_TRACK_SQUARE) continue;
            const d = (myMark - rawMarkIndex(pi, op) + TRACK_LEN) % TRACK_LEN;
            if (d >= 1 && d <= 6) n++;
        }
    }
    return n;
}

/**
 * Score board from playerIndex POV. Higher = better.
 * @param {number} playerIndex
 * @param {number[][]} positions
 * @param {object} w
 * @returns {number}
 */
export function evalState(playerIndex, positions, w) {
    let score = 0;
    for (let pi = 0; pi < 4; pi++) {
        if (!positions[pi]) continue;
        const sign = pi === playerIndex ? 1 : -1;
        for (let ti = 0; ti < 4; ti++) {
            const p = positions[pi][ti];
            if (p === YARD) { score += sign * w.home; continue; }
            if (p === FINISH) { score += sign * w.finished; continue; }
            score += sign * w.progress * p;
            if (p > LAST_TRACK_SQUARE || SAFE_SQUARES.has(p)) score += sign * w.safe;
            if (pi === playerIndex && countAt(positions[pi], p) >= 2) score += w.stack;
            if (sign === 1) score -= w.threat * threatCount(pi, ti, positions);
        }
    }
    return score;
}

/**
 * Simulate a move. Returns next positions + capture count.
 * Uses shared game-logic functions for position calculation and capture detection
 * to ensure bot behavior matches the live game rules.
 * @returns {{ next: number[][], caps: number }}
 */
export function applyMove(playerIndex, tokenIndex, dice, positions) {
    const next = clonePositions(positions);
    const cur = next[playerIndex][tokenIndex];
    const np = getTokenNewPosition(cur, dice);
    next[playerIndex][tokenIndex] = np;

    // findCapturedOpponents returns a per-player array of captured token indices.
    // It handles: safe squares (returns all-empty), home-stretch positions (no match),
    // and two-token pair-safety rule (clears lists of length exactly 2).
    const capturedByPlayer = findCapturedOpponents(playerIndex, np, next);

    let caps = 0;
    for (let pi = 0; pi < 4; pi++) {
        if (!capturedByPlayer[pi]) continue;
        for (const ti of capturedByPlayer[pi]) {
            next[pi][ti] = YARD;
            caps++;
        }
    }

    return { next, caps };
}

function legalMoves(playerIndex, dice, positions) {
    const moves = [];
    const seen = new Set();
    for (let ti = 0; ti < 4; ti++) {
        const p = positions[playerIndex][ti];
        // Use shared isTokenMovable to check legality; keep the seen-position dedup
        // to treat all YARD tokens as one move option.
        if (!isTokenMovable(p, dice)) continue;
        if (!seen.has(p)) {
            seen.add(p);
            moves.push(ti);
        }
    }
    return moves;
}

function nextActivePlayerIndex(pi, positions) {
    for (let k = 1; k <= 4; k++) {
        const j = (pi + k) % 4;
        if (positions[j] && positions[j].some(p => p !== FINISH)) return j;
    }
    return -1;
}

/**
 * Expected value of the next opponent's turn (averaged over their dice, min over their moves).
 */
function expectiOpponent(myIndex, positions, w) {
    const opp = nextActivePlayerIndex(myIndex, positions);
    if (opp === -1) return evalState(myIndex, positions, w);
    let exp = 0;
    for (let d = 1; d <= 6; d++) {
        const moves = legalMoves(opp, d, positions);
        let worstForMe;
        if (moves.length === 0) {
            worstForMe = evalState(myIndex, positions, w);
        } else {
            worstForMe = Infinity;
            for (const ti of moves) {
                const { next: np, caps } = applyMove(opp, ti, d, positions);
                const s = evalState(myIndex, np, w) - (w.captureBonus || 0) * caps;
                if (s < worstForMe) worstForMe = s;
            }
        }
        exp += DICE_PROB[d] * worstForMe;
    }
    return exp;
}

/**
 * Pick best token to move for the current bot turn.
 * @param {number} playerIndex
 * @param {number} dice
 * @param {number[][]} positions
 * @param {object} weights
 * @param {number} depth   0 = greedy eval, 1 = include opponent expectiminimax
 * @returns {number}       token index, or -1 if no move
 */
export function pickBestMove(playerIndex, dice, positions, weights, depth = 1) {
    const moves = legalMoves(playerIndex, dice, positions);
    if (moves.length === 0) return -1;
    if (moves.length === 1) return moves[0];

    let bestScore = -Infinity;
    let best = moves[0];
    for (const ti of moves) {
        const { next, caps } = applyMove(playerIndex, ti, dice, positions);
        let s;
        if (depth > 0) {
            s = DISCOUNT * expectiOpponent(playerIndex, next, weights);
        } else {
            s = evalState(playerIndex, next, weights);
        }
        s += (weights.captureBonus || 0) * caps;
        if (s > bestScore) { bestScore = s; best = ti; }
    }
    return best;
}
