import { describe, it, expect } from 'vitest';
import { reducer, applyEvents, EVENTS } from '../../scripts/state/game-reducer.js';
import { initialGameState, PHASES } from '../../scripts/state/game-state.js';
import { runGame, makeRng } from '../../scripts/core/game-driver.js';

describe('reducer', () => {
    it('GAME_STARTED initializes player slots and dice', () => {
        const state = initialGameState();
        reducer(state, {
            type: EVENTS.GAME_STARTED,
            quickStartId: 'P1B3',
            gameStartedAt: 123,
            playerTypes: ['PLAYER', 'BOT', 'BOT', 'BOT'],
            botPersonalities: [null, 'aggressive', 'balanced', 'rusher'],
            playerNames: ['Alice', '', '', ''],
            playerTokenPositions: [[-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1], [-1, -1, -1, -1]],
            currentPlayerIndex: 0,
        });
        expect(state.quickStartId).toBe('P1B3');
        expect(state.gameStartedAt).toBe(123);
        expect(state.playerTypes).toEqual(['PLAYER', 'BOT', 'BOT', 'BOT']);
        expect(state.botPersonalities).toEqual([null, 'aggressive', 'balanced', 'rusher']);
        expect(state.playerNames[0]).toBe('Alice');
        expect(state.currentPlayerIndex).toBe(0);
        expect(state.currentDiceRoll).toBe(1);
        expect(state.consecutiveSixesCount).toBe(0);
        expect(state.lastRank).toBe(0);
    });

    it('DICE_ROLLED non-six resets consecutive sixes', () => {
        const state = initialGameState();
        state.consecutiveSixesCount = 2;
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 4 });
        expect(state.currentDiceRoll).toBe(4);
        expect(state.consecutiveSixesCount).toBe(0);
    });

    it('DICE_ROLLED six increments consecutive sixes', () => {
        const state = initialGameState();
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 6 });
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 6 });
        expect(state.consecutiveSixesCount).toBe(2);
    });

    it('THREE_SIXES_LOST zeros the counter', () => {
        const state = initialGameState();
        state.consecutiveSixesCount = 3;
        reducer(state, { type: EVENTS.THREE_SIXES_LOST });
        expect(state.consecutiveSixesCount).toBe(0);
    });

    it('TOKEN_MOVED updates position', () => {
        const state = initialGameState();
        state.playerTokenPositions[0] = [-1, -1, -1, -1];
        reducer(state, {
            type: EVENTS.TOKEN_MOVED,
            playerIndex: 0,
            tokenIndex: 1,
            fromPosition: -1,
            toPosition: 0,
        });
        expect(state.playerTokenPositions[0][1]).toBe(0);
    });

    it('TOKEN_CAPTURED sends opponent home and bumps captures', () => {
        const state = initialGameState();
        state.playerTokenPositions[0] = [10, -1, -1, -1];
        state.playerTokenPositions[1] = [10, -1, -1, -1];
        state.playerCaptures[0] = 0;
        reducer(state, {
            type: EVENTS.TOKEN_CAPTURED,
            byPlayerIndex: 0,
            capturedPlayerIndex: 1,
            capturedTokenIndex: 0,
        });
        expect(state.playerTokenPositions[1][0]).toBe(-1);
        expect(state.playerCaptures[0]).toBe(1);
        expect(state.sentHomeCount[1]).toBe(1);
    });

    it('DICE_ROLLED tracks per-player best streak of any face', () => {
        const state = initialGameState();
        state.playerTypes[0] = 'PLAYER';
        state.currentPlayerIndex = 0;
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 4 });
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 4 });
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 4 });
        expect(state.bestDiceStreak[0]).toEqual({ value: 4, length: 3, atTurn: 0 });
        // Different value breaks the streak; previous best persists.
        reducer(state, { type: EVENTS.DICE_ROLLED, value: 2 });
        expect(state.bestDiceStreak[0].length).toBe(3);
    });

    it('TOKEN_MOVED accumulates distance and records first-home-stretch + first-finish turn', () => {
        const state = initialGameState();
        state.playerTokenPositions[0] = [-1, -1, -1, -1];
        state.turnCount = 12;
        // Leave home
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: -1, toPosition: 0 });
        // Walk forward
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 0, toPosition: 5 });
        // Enter home stretch
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 50, toPosition: 52 });
        expect(state.firstHomeStretchTurn[0]).toBe(12);
        // Finish
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 55, toPosition: 56 });
        expect(state.firstFinishTurn[0]).toBe(12);
        expect(state.distanceTraveled[0]).toBeGreaterThan(0);
    });

    it('TURN_ADVANCED increments turnCount and samples pawn-at-base at turn 20', () => {
        const state = initialGameState();
        state.playerTypes[0] = 'PLAYER';
        state.playerTokenPositions[0] = [-1, -1, -1, 5];
        state.turnCount = 19;
        reducer(state, { type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 });
        expect(state.turnCount).toBe(20);
        expect(state.pawnsAtBaseAtTurn20[0]).toBe(3);
    });

    it('PLAYER_FINISHED sets rank, time, lastRank, and first winner', () => {
        const state = initialGameState();
        reducer(state, { type: EVENTS.PLAYER_FINISHED, playerIndex: 2, rank: 1, time: 42 });
        expect(state.playerRanks[2]).toBe(1);
        expect(state.playerTimes[2]).toBe(42);
        expect(state.lastRank).toBe(1);
        expect(state.winnerIndex).toBe(2);
    });

    it('TURN_ADVANCED updates currentPlayerIndex and resets sixes', () => {
        const state = initialGameState();
        state.consecutiveSixesCount = 2;
        reducer(state, { type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 3 });
        expect(state.currentPlayerIndex).toBe(3);
        expect(state.consecutiveSixesCount).toBe(0);
    });

    it('NET_TURN_SYNCED forces currentPlayerIndex without bumping turnCount', () => {
        // Online: the diagonal seat→board layout is not a pure rotation, so the
        // local round-robin can drift from the server's seat order. NET_TURN_SYNCED
        // realigns the current player to the server's authority and re-arms the
        // roll phase — but must NOT bump turnCount (the local advance already did).
        const state = initialGameState();
        state.currentPlayerIndex = 3;        // local engine drifted here
        state.turnCount = 7;
        state.consecutiveSixesCount = 1;
        state.phase = PHASES.AWAITING_SELECTION;
        state.movableTokenIndexes = [0, 2];
        reducer(state, { type: EVENTS.NET_TURN_SYNCED, playerIndex: 0 }); // server says seat→pos 0
        expect(state.currentPlayerIndex).toBe(0);
        expect(state.turnCount).toBe(7);     // unchanged
        expect(state.consecutiveSixesCount).toBe(0);
        expect(state.phase).toBe(PHASES.AWAITING_ROLL);
        expect(state.movableTokenIndexes).toEqual([]);
    });

    it('ASSIST_FLAG_CHANGED toggles flag', () => {
        const state = initialGameState();
        reducer(state, { type: EVENTS.ASSIST_FLAG_CHANGED, flag: 'autoMoveSingleOption', value: true });
        expect(state.assistFlags.autoMoveSingleOption).toBe(true);
    });

    it('unknown event leaves state untouched', () => {
        const state = initialGameState();
        const before = JSON.stringify(state);
        reducer(state, { type: 'TOTAL_MADE_UP_EVENT' });
        expect(JSON.stringify(state)).toBe(before);
    });
});

describe('shadow equivalence: reducer fold matches imperative driver', () => {
    const seeds = [1, 2, 3, 7, 13, 42, 99];
    const BOT4 = ['BOT', 'BOT', 'BOT', 'BOT'];

    it.each(seeds)('seed %i: positions, ranks, captures, lastRank match', (seed) => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
        const folded = applyEvents(result.events, initialGameState());

        // Token positions should match exactly.
        expect(folded.playerTokenPositions).toEqual(result.positions);
        // Ranks, captures, lastRank are the load-bearing aggregates.
        expect(folded.playerRanks).toEqual(result.ranks);
        expect(folded.playerCaptures).toEqual(result.captures);
        expect(folded.lastRank).toBe(result.lastRank);
    });

    it.each(seeds)('seed %i: winner derived from event stream matches', (seed) => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(seed), maxTurns: 20000 });
        const folded = applyEvents(result.events, initialGameState());
        expect(folded.winnerIndex).toBe(result.winner);
    });

    it('GAME_ENDED appears exactly once when game terminates', () => {
        const result = runGame({ playerTypes: BOT4, rng: makeRng(1), maxTurns: 20000 });
        const enders = result.events.filter(e => e.type === EVENTS.GAME_ENDED);
        expect(enders.length).toBe(1);
    });
});
