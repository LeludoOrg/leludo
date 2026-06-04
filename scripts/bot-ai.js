import { SAFE_SQUARES as SAFE_SQUARES_ARR, DICE_WEIGHTS } from "./game-logic.js";

const SAFE_SQUARES = new Set(SAFE_SQUARES_ARR);

// Per-face probabilities for the expectiminimax chance nodes. Derived from the
// single source of truth (DICE_WEIGHTS) so the bot's model always matches the
// real loaded die — index 0 is a placeholder, faces are 1..6.
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

export function randomPersonality() {
    return PERSONALITY_KEYS[Math.floor(Math.random() * PERSONALITY_KEYS.length)];
}

function countAt(arr, pos) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) if (arr[i] === pos) n++;
    return n;
}

function markIndex(playerIndex, tokenPosition) {
    return (tokenPosition + 13 * playerIndex) % 52;
}

function threatCount(myPi, myTi, positions) {
    const p = positions[myPi][myTi];
    if (p < 0 || p > 50 || SAFE_SQUARES.has(p)) return 0;
    const myMark = markIndex(myPi, p);
    let n = 0;
    for (let pi = 0; pi < 4; pi++) {
        if (!positions[pi] || pi === myPi) continue;
        for (let ti = 0; ti < 4; ti++) {
            const op = positions[pi][ti];
            if (op < 0 || op > 50) continue;
            const d = (myMark - markIndex(pi, op) + 52) % 52;
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
            if (p === -1) { score += sign * w.home; continue; }
            if (p === 56) { score += sign * w.finished; continue; }
            score += sign * w.progress * p;
            if (p > 50 || SAFE_SQUARES.has(p)) score += sign * w.safe;
            if (pi === playerIndex && countAt(positions[pi], p) >= 2) score += w.stack;
            if (sign === 1) score -= w.threat * threatCount(pi, ti, positions);
        }
    }
    return score;
}

/**
 * Simulate a move. Returns next positions + capture count.
 * @returns {{ next: number[][], caps: number }}
 */
function applyMove(playerIndex, tokenIndex, dice, positions) {
    const next = new Array(4);
    for (let i = 0; i < 4; i++) next[i] = positions[i] ? positions[i].slice() : positions[i];
    const cur = next[playerIndex][tokenIndex];
    const np = cur === -1 ? 0 : cur + dice;
    next[playerIndex][tokenIndex] = np;
    let caps = 0;
    if (np <= 50 && !SAFE_SQUARES.has(np)) {
        const myMark = markIndex(playerIndex, np);
        for (let pi = 0; pi < 4; pi++) {
            if (!next[pi] || pi === playerIndex) continue;
            const hits = [];
            for (let ti = 0; ti < 4; ti++) {
                const op = next[pi][ti];
                if (op < 0 || op > 50) continue;
                if (markIndex(pi, op) === myMark) hits.push(ti);
            }
            if (hits.length === 1) { next[pi][hits[0]] = -1; caps++; }
        }
    }
    return { next, caps };
}

function legalMoves(playerIndex, dice, positions) {
    const moves = [];
    const seen = new Set();
    for (let ti = 0; ti < 4; ti++) {
        const p = positions[playerIndex][ti];
        if (dice === 6 && p === -1) {
            if (!seen.has(-1)) { seen.add(-1); moves.push(ti); }
            continue;
        }
        if (p >= 0 && p + dice <= 56 && !seen.has(p)) { seen.add(p); moves.push(ti); }
    }
    return moves;
}

function nextActivePlayerIndex(pi, positions) {
    for (let k = 1; k <= 4; k++) {
        const j = (pi + k) % 4;
        if (positions[j] && positions[j].some(p => p !== 56)) return j;
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
