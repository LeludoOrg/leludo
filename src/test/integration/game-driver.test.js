import { describe, it, expect } from 'vitest';
import { runGame, makeRng } from '../../scripts/game-driver.js';

describe('makeRng', () => {
    it('same seed produces same sequence', () => {
        const a = makeRng(42);
        const b = makeRng(42);
        for (let i = 0; i < 20; i++) {
            expect(a()).toBe(b());
        }
    });

    it('different seeds diverge', () => {
        const a = makeRng(1);
        const b = makeRng(2);
        const seqA = Array.from({ length: 10 }, () => a());
        const seqB = Array.from({ length: 10 }, () => b());
        expect(seqA).not.toEqual(seqB);
    });

    it('values in [0, 1)', () => {
        const r = makeRng(99);
        for (let i = 0; i < 1000; i++) {
            const v = r();
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });
});

describe('runGame', () => {
    const BOT4 = ['BOT', 'BOT', 'BOT', 'BOT'];

    it('terminates with all players ranked (4 bots, seed 1)', () => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(1), maxTurns: 10000 });
        expect(result.ended).toBe(true);
        expect(result.lastRank).toBe(4);
        expect(result.ranks.every(r => r >= 1 && r <= 4)).toBe(true);
        expect(new Set(result.ranks).size).toBe(4);
    });

    it('deterministic given same seed', () => {
        const a = runGame({ playerTypes: BOT4, rng: makeRng(7), maxTurns: 10000 });
        const b = runGame({ playerTypes: BOT4, rng: makeRng(7), maxTurns: 10000 });
        expect(a.ranks).toEqual(b.ranks);
        expect(a.turns).toBe(b.turns);
        expect(a.captures).toEqual(b.captures);
        expect(a.positions).toEqual(b.positions);
    });

    it('winner is the player with rank 1', () => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(3), maxTurns: 10000 });
        expect(result.ranks[result.winner]).toBe(1);
    });

    it('ends early when all humans finish vs bots', () => {
        // Single human at slot 2 with 3 tokens already at 56 and 1 token at 55.
        // Bots still mostly home. Roll a 1 -> human finishes -> shouldEndGame fires.
        const types = ['BOT', undefined, 'PLAYER', 'BOT'];
        const initial = [
            [-1, -1, -1, -1],
            null,
            [56, 56, 56, 55],
            [-1, -1, -1, -1],
        ];
        const result = runGame({
            playerTypes: types,
            initialPositions: initial,
            startingPlayerIndex: 2,
            rng: makeRng(11),
            maxTurns: 5000,
        });
        expect(result.ended).toBe(true);
        // Human must rank 1 (only player who could finish first here).
        expect(result.ranks[2]).toBe(1);
        // Undefined slot has no rank.
        expect(result.ranks[1]).toBe(0);
        // Defined non-human slots have ranks > 1.
        expect(result.ranks[0]).toBeGreaterThan(1);
        expect(result.ranks[3]).toBeGreaterThan(1);
    });

    it('handles 2-player games', () => {
        const types = [undefined, 'BOT', undefined, 'BOT'];
        const result = runGame({
            playerTypes: types,
            startingPlayerIndex: 1,
            rng: makeRng(5),
            maxTurns: 10000,
        });
        expect(result.ended).toBe(true);
        expect(result.ranks[0]).toBe(0);
        expect(result.ranks[2]).toBe(0);
        expect(result.ranks[1]).toBeGreaterThan(0);
        expect(result.ranks[3]).toBeGreaterThan(0);
        expect(result.lastRank).toBe(2);
    });

    // Regression: a bot that finished its 4th/last token used to be granted
    // an extra turn (the finished-trip "play again" rule) even though it had
    // no tokens left to move — so it rolled the dice one more pointless time
    // before the turn advanced. A fully-finished player must never roll again.
    it('finished player never rolls again while the game continues', () => {
        const types = ['BOT', 'BOT', 'BOT', undefined];
        // Bot 0 one roll from finishing its last token; others still home, so
        // the game keeps going after bot 0 finishes (2 bots remain).
        const initial = [
            [56, 56, 56, 51],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
            null,
        ];
        const result = runGame({
            playerTypes: types,
            initialPositions: initial,
            startingPlayerIndex: 0,
            rng: makeRng(4),
            maxTurns: 20000,
        });

        // Replay the event log, tracking whose turn it is and who has finished.
        let current = result.events[0].currentPlayerIndex;
        const finished = new Set();
        for (const ev of result.events) {
            if (ev.type === 'DICE_ROLLED') {
                expect(finished.has(current)).toBe(false);
            } else if (ev.type === 'PLAYER_FINISHED') {
                finished.add(ev.playerIndex);
            } else if (ev.type === 'TURN_ADVANCED') {
                current = ev.nextPlayerIndex;
            }
        }
    });

    describe('invariants across many seeds', () => {
        const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

        it.each(seeds)('seed %i: game terminates within bound', (seed) => {
            const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
            expect(result.ended).toBe(true);
        });

        it.each(seeds)('seed %i: token positions stay within [-1, 56]', (seed) => {
            const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
            for (const row of result.positions) {
                for (const p of row) {
                    expect(p).toBeGreaterThanOrEqual(-1);
                    expect(p).toBeLessThanOrEqual(56);
                }
            }
        });

        it.each(seeds)('seed %i: all 4 players ranked 1..4', (seed) => {
            const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
            const sortedRanks = result.ranks.slice().sort((a, b) => a - b);
            expect(sortedRanks).toEqual([1, 2, 3, 4]);
        });

        it.each(seeds)('seed %i: captures are non-negative', (seed) => {
            const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
            for (const c of result.captures) {
                expect(c).toBeGreaterThanOrEqual(0);
            }
        });

        it.each(seeds)('seed %i: rank-1 player has all 4 tokens finished', (seed) => {
            const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
            const winner = result.ranks.indexOf(1);
            expect(result.positions[winner].every(p => p === 56)).toBe(true);
        });
    });
});
