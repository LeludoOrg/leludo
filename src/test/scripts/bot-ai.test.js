import { describe, it, expect, vi, afterEach } from 'vitest';
import { evalState, pickBestMove, PERSONALITIES, randomPersonality, applyMove } from '../../scripts/core/bot-ai.js';

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

    it('pair-safety: 2-stack opponent tokens not captured', () => {
        // P0 can move token 0 from position 10 by rolling 1 -> lands on position 11.
        // Position 11 for P0 maps to mark (11+0)%52=11.
        // P1 has 2 tokens at position 45, which maps to mark (45+13)%52=6 (not 11, different mark).
        // P1 also has 1 lone token at position 38 -> mark (38+13)%52=51 (not 11).
        // So P0 rolling 1 should result in 0 captures.
        // But if we place P1 at a position whose mark is 11: we need mark = 11 for P1.
        // For P1: mark = (pos + 13) % 52 = 11 => pos = (11 - 13) % 52 = -2 % 52 = 50.
        // So P1 token at position 50 gives P1 mark = 11.
        // P0 at 10 rolling 1 -> pos 11, mark 11 collides with P1 at 50 mark 11.
        // With 2 P1 tokens on pos 50, P0 should NOT capture (pair-safety).
        const positions = makeBoard([[10, -1, -1, -1], [50, 50, -1, -1], HOME, HOME]);
        // With only P0 token 0 movable, pickBestMove must pick it (single move).
        const result = pickBestMove(0, 1, positions, W);
        expect(result).toBe(0);
        // Now verify the move itself: apply the move and check caps = 0.
        const { next: nextPos, caps } = applyMove(0, result, 1, positions);
        // After move, P0 token 0 should be at position 11.
        expect(nextPos[0][0]).toBe(11);
        // No capture should occur (pair-safety): caps should be 0.
        expect(caps).toBe(0);
        // P1's 2 tokens at position 50 should still be there.
        expect(nextPos[1][0]).toBe(50);
        expect(nextPos[1][1]).toBe(50);
    });

    it('pair-safety: lone opponent token IS captured when other safe', () => {
        // P0 token at 10, rolls 1, lands on mark 11.
        // P1 has 1 token at mark 11 (pos 50), and 1 at safe square 8.
        // The lone token at 50 should be captured.
        const positions = makeBoard([[10, -1, -1, -1], [50, 8, -1, -1], HOME, HOME]);
        const { next: nextPos, caps } = applyMove(0, 0, 1, positions);
        expect(nextPos[0][0]).toBe(11);
        // Lone token at 50 captured.
        expect(caps).toBe(1);
        expect(nextPos[1][0]).toBe(-1); // sent to yard
        expect(nextPos[1][1]).toBe(8);  // safe token untouched
    });

    it('captures: when 1 or 3+ opponent tokens on mark (pair-safe: 2 only)', () => {
        // P0 token at 10, rolls 1 -> position 11, mark (11+0)%52 = 11.
        // All opponents on mark 11 (via position offset):
        // - P1 at mark 11: pos = 50 (mark = (50+13)%52 = 11)
        // - P2 at mark 11: pos = 37 (mark = (37+26)%52 = 11)
        // - P3 at mark 11: pos = 24 (mark = (24+39)%52 = 11)
        // P1: 1 token on mark 11 -> CAPTURED (not pair-safe: len != 2).
        // P2: 2 tokens on mark 11 -> SAFE (pair-safety rule: len === 2).
        // P3: 3 tokens on mark 11 -> CAPTURED (not pair-safe: len != 2).
        // This pins the game-logic rule: only lists of exactly 2 are safe.
        const positions = makeBoard(
            [[10, -1, -1, -1],
             [50, -1, -1, -1],    // P1: 1 token at mark 11 -> CAPTURED
             [37, 37, -1, -1],    // P2: 2 tokens at mark 11 -> SAFE (pair-safety)
             [24, 24, 24, -1]]    // P3: 3 tokens at mark 11 -> CAPTURED (all 3)
        );
        const { next: nextPos, caps } = applyMove(0, 0, 1, positions);
        expect(nextPos[0][0]).toBe(11);
        // P1: 1 token captured = 1. P2: 0 (pair-safe). P3: 3 tokens = 3. Total = 4.
        expect(caps).toBe(4);
        expect(nextPos[1][0]).toBe(-1); // P1 token captured -> yard
        expect(nextPos[2][0]).toBe(37); // P2 tokens safe
        expect(nextPos[2][1]).toBe(37);
        expect(nextPos[3][0]).toBe(-1); // P3 all 3 tokens captured -> yard
        expect(nextPos[3][1]).toBe(-1);
        expect(nextPos[3][2]).toBe(-1);
    });
});

