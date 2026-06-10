import { describe, it, expect, vi, afterEach } from 'vitest';
import { evalState, pickBestMove, PERSONALITIES, randomPersonality } from '../../scripts/bot-ai.js';

const HOME = [-1, -1, -1, -1];
const W = PERSONALITIES.balanced;

function makeBoard(rows) {
    return rows.map(r => r ? r.slice() : null);
}

describe('PERSONALITIES', () => {
    it('exposes 4 personalities with required weight keys', () => {
        const keys = Object.keys(PERSONALITIES);
        expect(keys.sort()).toEqual(['aggressive', 'balanced', 'defensive', 'rusher']);
        for (const p of keys) {
            const w = PERSONALITIES[p];
            ['home', 'finished', 'progress', 'safe', 'stack', 'threat', 'captureBonus']
                .forEach(k => expect(w[k]).toBeTypeOf('number'));
        }
    });
});

describe('randomPersonality', () => {
    afterEach(() => vi.restoreAllMocks());

    it('returns a valid personality key', () => {
        for (let i = 0; i < 50; i++) {
            expect(PERSONALITIES[randomPersonality()]).toBeDefined();
        }
    });

    it('uses Math.random for selection', () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(randomPersonality()).toBe(Object.keys(PERSONALITIES)[0]);
        vi.spyOn(Math, 'random').mockReturnValue(0.999);
        expect(randomPersonality()).toBe(Object.keys(PERSONALITIES)[Object.keys(PERSONALITIES).length - 1]);
    });
});

describe('evalState', () => {
    it('all home: score is 4 * home weight (self - opponents net)', () => {
        const positions = makeBoard([HOME, HOME, HOME, HOME]);
        // home weight is 0 in balanced. Score = 0.
        expect(evalState(0, positions, W)).toBe(0);
    });

    it('own finished token contributes positive', () => {
        const positions = makeBoard([[56, -1, -1, -1], HOME, HOME, HOME]);
        expect(evalState(0, positions, W)).toBeGreaterThan(0);
    });

    it('opponent finished token contributes negative', () => {
        const positions = makeBoard([HOME, [56, -1, -1, -1], HOME, HOME]);
        expect(evalState(0, positions, W)).toBeLessThan(0);
    });

    it('own progress contributes positive', () => {
        const positions = makeBoard([[25, -1, -1, -1], HOME, HOME, HOME]);
        expect(evalState(0, positions, W)).toBeGreaterThan(0);
    });

    it('own safe-square token scores higher than equivalent unsafe', () => {
        // Position 8 is safe, 7 is not. Equal "progress" 8 vs 7 -> safe bonus wins.
        const safe = makeBoard([[8, -1, -1, -1], HOME, HOME, HOME]);
        const unsafe = makeBoard([[7, -1, -1, -1], HOME, HOME, HOME]);
        expect(evalState(0, safe, W)).toBeGreaterThan(evalState(0, unsafe, W));
    });

    it('stack bonus: 2 own tokens on same square', () => {
        const stacked = makeBoard([[10, 10, -1, -1], HOME, HOME, HOME]);
        const apart = makeBoard([[10, 11, -1, -1], HOME, HOME, HOME]);
        // progress equal-ish (10+10 vs 10+11); stack bonus should push stacked higher.
        expect(evalState(0, stacked, W) - evalState(0, apart, W)).toBeGreaterThan(0);
    });

    it('skips null player slots', () => {
        const positions = [[5, -1, -1, -1], null, null, null];
        // Should not throw, opponent slots skipped.
        expect(() => evalState(0, positions, W)).not.toThrow();
    });
});

describe('pickBestMove', () => {
    it('returns -1 when no legal moves', () => {
        const positions = makeBoard([HOME, HOME, HOME, HOME]);
        // Dice 5, all home — no token can move.
        expect(pickBestMove(0, 5, positions, W)).toBe(-1);
    });

    it('returns single legal move without scoring', () => {
        // Only token 0 on board; only it can move.
        const positions = makeBoard([[5, -1, -1, -1], HOME, HOME, HOME]);
        expect(pickBestMove(0, 3, positions, W)).toBe(0);
    });

    it('on roll of 6 with home tokens: picks token to exit home when only option', () => {
        const positions = makeBoard([HOME, HOME, HOME, HOME]);
        // Roll 6, all home, only legal move is exit-home (any token index, dedup picks first).
        const result = pickBestMove(0, 6, positions, W);
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(3);
    });

    it('prefers move that captures opponent', () => {
        // P0 token at 4 (not safe). P1 token at position 44 -> mark (44+13)%52 = 5.
        // If P0 rolls 1, token moves 4->5, mark 5, captures P1's token.
        // P0 also has a token at 20 (no captures available there).
        const positions = makeBoard([[4, 20, -1, -1], [44, -1, -1, -1], HOME, HOME]);
        const result = pickBestMove(0, 1, positions, PERSONALITIES.aggressive);
        expect(result).toBe(0);
    });

    it('depth 0 (greedy) returns valid move', () => {
        const positions = makeBoard([[5, 10, -1, -1], HOME, HOME, HOME]);
        const result = pickBestMove(0, 3, positions, W, 0);
        expect([0, 1]).toContain(result);
    });

    it('depth 1 (expectiminimax) returns valid move', () => {
        const positions = makeBoard([[5, 10, -1, -1], HOME, HOME, HOME]);
        const result = pickBestMove(0, 3, positions, W, 1);
        expect([0, 1]).toContain(result);
    });

    it('deduplicates moves: tokens on same square count as one option', () => {
        // Two tokens at position 5. Both moves identical -> only one choice considered.
        const positions = makeBoard([[5, 5, -1, -1], HOME, HOME, HOME]);
        const result = pickBestMove(0, 2, positions, W);
        // Either index 0 or 1 acceptable since dedup picks first encountered.
        expect([0, 1]).toContain(result);
    });
});
