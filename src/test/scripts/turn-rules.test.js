import { describe, it, expect } from 'vitest';
import {
    isPlayerFinished,
    allTokensInHome,
    getFinishedCount,
    selectStartingPlayer,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
    serializeGameState,
    deserializeGameState,
} from '../../scripts/turn-rules.js';

const HOME = [-1, -1, -1, -1];
const DONE = [56, 56, 56, 56];

describe('isPlayerFinished', () => {
    it('all 56 → true', () => {
        expect(isPlayerFinished(DONE)).toBe(true);
    });
    it('any not 56 → false', () => {
        expect(isPlayerFinished([56, 56, 56, 55])).toBe(false);
        expect(isPlayerFinished(HOME)).toBe(false);
    });
});

describe('allTokensInHome', () => {
    it('all -1 → true', () => {
        expect(allTokensInHome(HOME)).toBe(true);
    });
    it('any on board → false', () => {
        expect(allTokensInHome([-1, -1, 0, -1])).toBe(false);
    });
});

describe('getFinishedCount', () => {
    it('counts 56s', () => {
        expect(getFinishedCount([56, 56, 0, -1])).toBe(2);
        expect(getFinishedCount(HOME)).toBe(0);
        expect(getFinishedCount(DONE)).toBe(4);
    });
    it('handles null', () => {
        expect(getFinishedCount(null)).toBe(0);
        expect(getFinishedCount(undefined)).toBe(0);
    });
});

describe('selectStartingPlayer', () => {
    it('returns 2 if any human present', () => {
        expect(selectStartingPlayer(['BOT', 'BOT', 'PLAYER', 'BOT'])).toBe(2);
        expect(selectStartingPlayer(['PLAYER', undefined, undefined, undefined])).toBe(2);
    });

    it('returns first defined slot when no humans', () => {
        expect(selectStartingPlayer([undefined, 'BOT', 'BOT', 'BOT'])).toBe(1);
        expect(selectStartingPlayer(['BOT', 'BOT', 'BOT', 'BOT'])).toBe(0);
    });
});

describe('getNextPlayerIndex', () => {
    const types4 = ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'];
    const positions4 = [HOME, HOME, HOME, HOME];

    it('wraps modulo 4', () => {
        expect(getNextPlayerIndex(0, types4, positions4)).toBe(1);
        expect(getNextPlayerIndex(3, types4, positions4)).toBe(0);
    });

    it('skips undefined slots', () => {
        const types = ['PLAYER', undefined, 'BOT', undefined];
        const positions = [HOME, null, HOME, null];
        expect(getNextPlayerIndex(0, types, positions)).toBe(2);
        expect(getNextPlayerIndex(2, types, positions)).toBe(0);
    });

    it('skips finished players', () => {
        const types = types4;
        const positions = [HOME, DONE, HOME, HOME];
        expect(getNextPlayerIndex(0, types, positions)).toBe(2);
    });

    it('returns -1 when no active player remains', () => {
        const positions = [DONE, DONE, DONE, DONE];
        expect(getNextPlayerIndex(0, types4, positions)).toBe(-1);
    });
});

describe('shouldEndGame', () => {
    it('false when 2+ players still active', () => {
        const types = ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'];
        const positions = [DONE, HOME, HOME, HOME];
        expect(shouldEndGame(types, positions)).toBe(false);
    });

    it('true when only 1 player active', () => {
        const types = ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'];
        const positions = [DONE, DONE, DONE, HOME];
        expect(shouldEndGame(types, positions)).toBe(true);
    });

    it('true when all humans done but bots still playing', () => {
        const types = ['PLAYER', 'BOT', 'BOT', undefined];
        const positions = [DONE, HOME, HOME, null];
        expect(shouldEndGame(types, positions)).toBe(true);
    });

    it('false in bot-only game while 2+ bots active', () => {
        const types = ['BOT', 'BOT', 'BOT', 'BOT'];
        const positions = [HOME, HOME, DONE, DONE];
        expect(shouldEndGame(types, positions)).toBe(false);
    });
});

describe('computeLeftoverRankOrder', () => {
    it('orders by finished-count desc, then track-sum desc', () => {
        const types = ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'];
        const positions = [
            [56, 56, -1, -1],  // 2 finished, sum 112
            [56, 10, 10, -1],  // 1 finished, sum 76
            [56, 20, 20, -1],  // 1 finished, sum 96
            [-1, -1, -1, -1],  // 0 finished
        ];
        const ranks = [0, 0, 0, 0];
        const order = computeLeftoverRankOrder(types, positions, ranks);
        expect(order).toEqual([0, 2, 1, 3]);
    });

    it('skips players who already have a rank', () => {
        const types = ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'];
        const positions = [DONE, HOME, HOME, HOME];
        const ranks = [1, 0, 0, 0];
        const order = computeLeftoverRankOrder(types, positions, ranks);
        expect(order).not.toContain(0);
        expect(order).toHaveLength(3);
    });

    it('skips undefined player slots', () => {
        const types = ['PLAYER', undefined, 'BOT', undefined];
        const positions = [HOME, null, HOME, null];
        const ranks = [0, 0, 0, 0];
        expect(computeLeftoverRankOrder(types, positions, ranks)).toEqual([0, 2]);
    });
});

describe('serializeGameState / deserializeGameState', () => {
    const state = {
        quickStartId: 'q,4,0',
        playerNames: ['A', 'B', 'C', 'D'],
        playerTypes: ['PLAYER', 'PLAYER', 'PLAYER', 'PLAYER'],
        botPersonalities: [null, null, null, null],
        playerTokenPositions: [HOME, [5, 0, -1, -1], DONE, HOME],
        currentPlayerIndex: 1,
        currentDiceRoll: 3,
        consecutiveSixesCount: 0,
        playerCaptures: [0, 1, 2, 0],
        playerRanks: [0, 0, 1, 0],
        playerTimes: [0, 0, 1234, 0],
        lastRank: 1,
        gameStartedAt: 1000,
    };

    it('round-trips through JSON', () => {
        const serialized = serializeGameState(state);
        const json = JSON.stringify(serialized);
        const parsed = deserializeGameState(json);
        expect(parsed.quickStartId).toBe('q,4,0');
        expect(parsed.positions[1]).toEqual([5, 0, -1, -1]);
        expect(parsed.currentPlayerIndex).toBe(1);
        expect(parsed.lastRank).toBe(1);
    });

    it('serialize returns a fresh object (no array aliasing)', () => {
        const serialized = serializeGameState(state);
        state.playerNames[0] = 'mutated';
        expect(serialized.playerNamesArr[0]).toBe('A');
    });

    it('deserialize returns null for invalid input', () => {
        expect(deserializeGameState(null)).toBeNull();
        expect(deserializeGameState('')).toBeNull();
        expect(deserializeGameState('not json')).toBeNull();
        expect(deserializeGameState('{"foo":1}')).toBeNull();
        expect(deserializeGameState('null')).toBeNull();
    });
});
