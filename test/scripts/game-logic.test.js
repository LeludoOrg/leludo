import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    isTokenMovable,
    getMarkIndex,
    isSafePosition,
    generateDiceRoll,
    getTokenNewPosition,
    findCapturedOpponents,
    isTripComplete,
    getPlayerTypes,
    getUniqueTokenPositions,
} from '../../scripts/game-logic.js';

describe('isTokenMovable', () => {
    it('home token immovable when roll < 6', () => {
        expect(isTokenMovable(-1, 1)).toBe(false);
        expect(isTokenMovable(-1, 5)).toBe(false);
    });

    it('home token movable when roll is 6', () => {
        expect(isTokenMovable(-1, 6)).toBe(true);
    });

    it('on-board token movable when new position <= 56', () => {
        expect(isTokenMovable(0, 6)).toBe(true);
        expect(isTokenMovable(50, 6)).toBe(true);
        expect(isTokenMovable(55, 1)).toBe(true);
    });

    it('on-board token immovable when new position > 56', () => {
        expect(isTokenMovable(55, 2)).toBe(false);
        expect(isTokenMovable(56, 1)).toBe(false);
    });
});

describe('getMarkIndex', () => {
    it('returns undefined for home token', () => {
        expect(getMarkIndex(0, -1)).toBeUndefined();
    });

    it('returns undefined for tokens in home stretch (>50)', () => {
        expect(getMarkIndex(0, 51)).toBeUndefined();
        expect(getMarkIndex(2, 56)).toBeUndefined();
    });

    it('player 0 maps position directly', () => {
        expect(getMarkIndex(0, 0)).toBe(0);
        expect(getMarkIndex(0, 50)).toBe(50);
    });

    it('player N offset by 13 * N mod 52', () => {
        expect(getMarkIndex(1, 0)).toBe(13);
        expect(getMarkIndex(2, 0)).toBe(26);
        expect(getMarkIndex(3, 0)).toBe(39);
        expect(getMarkIndex(1, 39)).toBe(0);
    });
});

describe('isSafePosition', () => {
    it('star squares are safe', () => {
        [0, 8, 13, 21, 26, 34, 39, 47].forEach(pos => {
            expect(isSafePosition(pos)).toBe(true);
        });
    });

    it('home stretch (>50) is safe', () => {
        expect(isSafePosition(51)).toBe(true);
        expect(isSafePosition(56)).toBe(true);
    });

    it('regular squares not safe', () => {
        [1, 2, 5, 10, 25, 50].forEach(pos => {
            expect(isSafePosition(pos)).toBe(false);
        });
    });
});

describe('generateDiceRoll', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns value in 1..6', () => {
        for (let i = 0; i < 1000; i++) {
            const roll = generateDiceRoll();
            expect(roll).toBeGreaterThanOrEqual(1);
            expect(roll).toBeLessThanOrEqual(6);
        }
    });

    it('weighted distribution: 1 and 4 rarer than 2,3,5,6', () => {
        const counts = new Array(7).fill(0);
        for (let i = 0; i < 60000; i++) {
            counts[generateDiceRoll()]++;
        }
        // 1 and 4 have weight 1, others weight 2. Expect ~10000 vs ~20000.
        expect(counts[1]).toBeLessThan(counts[2]);
        expect(counts[1]).toBeLessThan(counts[3]);
        expect(counts[4]).toBeLessThan(counts[5]);
        expect(counts[4]).toBeLessThan(counts[6]);
    });
});

describe('getTokenNewPosition', () => {
    it('home token moves to start (0) on any roll', () => {
        expect(getTokenNewPosition(-1, 6)).toBe(0);
        expect(getTokenNewPosition(-1, 1)).toBe(0);
    });

    it('on-board token adds dice roll', () => {
        expect(getTokenNewPosition(0, 3)).toBe(3);
        expect(getTokenNewPosition(50, 6)).toBe(56);
    });
});

describe('findCapturedOpponents', () => {
    const emptyBoard = [
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
        [-1, -1, -1, -1],
    ];

    it('returns empty per-player arrays when no opponents share square', () => {
        const result = findCapturedOpponents(0, 5, emptyBoard);
        expect(result).toEqual([[], [], [], []]);
    });

    it('captures single opponent on same mark index', () => {
        // P0 at position 5 → mark 5 (not safe).
        // P1 at position 44 → mark (44+13)%52 = 5. Same square.
        const positions = [
            [5, -1, -1, -1],
            [44, -1, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
        ];
        const result = findCapturedOpponents(0, 5, positions);
        expect(result[1]).toEqual([0]);
    });

    it('does not capture self', () => {
        // Own tokens on same square not in result.
        const positions = [
            [5, 5, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
        ];
        const result = findCapturedOpponents(0, 5, positions);
        expect(result[0]).toEqual([]);
    });

    it('safe square: returns empty result', () => {
        const positions = [
            [8, -1, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
        ];
        const result = findCapturedOpponents(0, 8, positions);
        expect(result).toEqual([]);
    });

    it('two opponent tokens stacked form block, not captured', () => {
        // P1 has 2 tokens at position 44 → mark 5. P0 lands on mark 5 via position 5.
        const positions = [
            [-1, -1, -1, -1],
            [44, 44, -1, -1],
            [-1, -1, -1, -1],
            [-1, -1, -1, -1],
        ];
        const result = findCapturedOpponents(0, 5, positions);
        expect(result[1]).toEqual([]);
    });
});

describe('isTripComplete', () => {
    it('true at 56', () => {
        expect(isTripComplete(56)).toBe(true);
    });

    it('false elsewhere', () => {
        expect(isTripComplete(55)).toBe(false);
        expect(isTripComplete(0)).toBe(false);
        expect(isTripComplete(-1)).toBe(false);
    });
});

describe('getPlayerTypes', () => {
    it('4 humans returns all PLAYER + identity colorMap', () => {
        const result = getPlayerTypes('q,4,0');
        expect(result.playerTypes).toEqual(['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER']);
        expect(result.colorMap).toEqual([0, 1, 2, 3]);
    });

    it('1 human + 1 bot: human at preferred position 2', () => {
        const result = getPlayerTypes('q,1,1,0');
        expect(result.playerTypes[2]).toBe('PLAYER');
        expect(result.colorMap[2]).toBe(0);
        expect(result.playerTypes.filter(t => t === 'BOT')).toHaveLength(1);
    });

    it('1 human + 3 bots: fills remaining positions with BOT', () => {
        const result = getPlayerTypes('q,1,3,1');
        expect(result.playerTypes[2]).toBe('PLAYER');
        expect(result.colorMap[2]).toBe(1);
        const botCount = result.playerTypes.filter(t => t === 'BOT').length;
        expect(botCount).toBe(3);
    });

    it('2 humans: positions 2 and 0', () => {
        const result = getPlayerTypes('q,2,0,0,1');
        expect(result.playerTypes[2]).toBe('PLAYER');
        expect(result.playerTypes[0]).toBe('PLAYER');
        expect(result.colorMap[2]).toBe(0);
        expect(result.colorMap[0]).toBe(1);
    });

    // Regression: a bot used to grab a leftover colour by board order instead
    // of its locked seat colour, so a bot in seat 2 (gold) would render red
    // when red was free. quickStartId now carries bot colours after the human
    // colours; the bot must keep its seat colour.
    it('bot keeps its seat colour instead of grabbing a leftover (human seat 1, bot seat 2)', () => {
        // 1 human colour=1 (seat 1, green), 1 bot colour=2 (seat 2, gold).
        const result = getPlayerTypes('qs,1,1,1,2');
        const botPos = result.playerTypes.indexOf('BOT');
        expect(botPos).toBeGreaterThanOrEqual(0);
        expect(result.colorMap[botPos]).toBe(2); // gold, NOT red(0)
        expect(result.colorMap[botPos]).not.toBe(0);
    });

    // Regression: an empty seat between two bots used to shift the leftover
    // colour list so the second bot took the empty seat's colour.
    it('two bots keep their seat colours with an empty seat interleaved', () => {
        // human seat 0 (red=0); bots seat 1 (green=1) and seat 3 (blue=3);
        // seat 2 (gold) left empty.
        const result = getPlayerTypes('qs,1,2,0,1,3');
        // bots fill the first free board positions (0, then 1) in seat order.
        expect(result.colorMap[0]).toBe(1); // first bot → green
        expect(result.colorMap[1]).toBe(3); // second bot → blue (not gold)
        expect(result.colorMap[2]).toBe(0); // human at preferred pos 2 → red
        // colourMap is a complete permutation of 0..3.
        expect([...result.colorMap].sort()).toEqual([0, 1, 2, 3]);
    });

    it('all bots keep their seat colours', () => {
        const result = getPlayerTypes('qs,0,4,0,1,2,3');
        expect(result.playerTypes).toEqual(['BOT', 'BOT', 'BOT', 'BOT']);
        expect(result.colorMap).toEqual([0, 1, 2, 3]);
    });

    // Backward-compat: saved games created before bot-colour encoding have no
    // bot colours in their quickStartId; getPlayerTypes must still produce a
    // valid, complete colour map (historical leftover behaviour).
    it('old quickStartId without bot colours still yields a complete colour map', () => {
        const result = getPlayerTypes('q,1,3,1');
        expect(result.playerTypes.filter(t => t === 'BOT')).toHaveLength(3);
        expect(result.colorMap[2]).toBe(1); // human keeps its colour
        expect([...result.colorMap].sort()).toEqual([0, 1, 2, 3]);
    });
});

describe('getUniqueTokenPositions', () => {
    it('returns set of distinct positions for given token indexes', () => {
        const positions = [[5, 5, 10, -1], [], [], []];
        const result = getUniqueTokenPositions(0, [0, 1, 2], positions);
        expect(result).toEqual(new Set([5, 10]));
    });

    it('empty movable list returns empty set', () => {
        const positions = [[5, 10, 15, 20], [], [], []];
        const result = getUniqueTokenPositions(0, [], positions);
        expect(result.size).toBe(0);
    });
});
