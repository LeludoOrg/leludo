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


    it('TOKEN_MOVED accumulates distance traveled', () => {
        const state = initialGameState();
        state.playerTokenPositions[0] = [-1, -1, -1, -1];
        state.turnCount = 12;
        // Leave home
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: -1, toPosition: 0 });
        // Walk forward
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 0, toPosition: 5 });
        // Enter home stretch
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 50, toPosition: 52 });
        // Finish
        reducer(state, { type: EVENTS.TOKEN_MOVED, playerIndex: 0, tokenIndex: 0, fromPosition: 55, toPosition: 56 });
        expect(state.distanceTraveled[0]).toBeGreaterThan(0);
    });

    it('TURN_ADVANCED increments turnCount', () => {
        const state = initialGameState();
        state.playerTypes[0] = 'PLAYER';
        state.playerTokenPositions[0] = [-1, -1, -1, 5];
        state.turnCount = 19;
        reducer(state, { type: EVENTS.TURN_ADVANCED, nextPlayerIndex: 0 });
        expect(state.turnCount).toBe(20);
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

    it('NET_STATE_SYNCED applies the full server snapshot: board, turn, phase, movable', () => {
        // Online: the server snapshot is the last word after every frame. A
        // drifted board (the live bug: a captured pawn that went home on the
        // server still showed on the track on a lagging client), a drifted
        // current player, a drifted turn count and a stale phase must all snap
        // to the server's values in one event — phase included, because a
        // client that reconnected mid-AWAIT_MOVE used to come back stuck
        // AWAITING_ROLL and deadlock the whole room.
        const state = initialGameState();
        state.playerTypes = ['PLAYER', 'PLAYER', undefined, undefined];
        state.playerTokenPositions = [
            [5, -1, -1, -1],   // matches server
            [10, 3, -1, -1],   // token0 NOT yet sent home (drifted)
            undefined,
            undefined,
        ];
        state.currentPlayerIndex = 1;        // local round-robin drifted
        state.turnCount = 7;                 // undercounted a missed turn
        state.consecutiveSixesCount = 1;
        state.phase = PHASES.AWAITING_ROLL;  // server actually awaits a MOVE
        reducer(state, {
            type: EVENTS.NET_STATE_SYNCED,
            positions: [
                [5, -1, -1, -1],
                [-1, 3, -1, -1], // server truth: token0 was captured → home
                undefined,
                undefined,
            ],
            playerTypes: ['PLAYER', 'PLAYER', undefined, undefined],
            currentPlayerIndex: 0,
            turnCount: 9,
            dice: 4,
            phase: 'AWAIT_MOVE',
            legalMoves: [0, 2],
            captures: [2, 0, 0, 0],
        });
        expect(state.playerTokenPositions[1]).toEqual([-1, 3, -1, -1]); // snapped home
        expect(state.playerTokenPositions[0]).toEqual([5, -1, -1, -1]); // untouched
        expect(state.playerTokenPositions[2]).toBeUndefined();           // empty seat left alone
        expect(state.currentPlayerIndex).toBe(0);
        expect(state.turnCount).toBe(9);
        expect(state.currentDiceRoll).toBe(4);
        expect(state.consecutiveSixesCount).toBe(0);
        expect(state.phase).toBe(PHASES.AWAITING_SELECTION);
        expect(state.movableTokenIndexes).toEqual([0, 2]);
        expect(state.playerCaptures[0]).toBe(2);
    });

    it('NET_STATE_SYNCED deactivates a seat the server says is gone (missed DROPPED)', () => {
        // A player forfeited while THIS client was offline: the DROPPED frame
        // never arrived, so the seat is still active locally — ghost pawns. The
        // snapshot lists the seat as inactive; the sync must clear it.
        const state = initialGameState();
        state.playerTypes = ['PLAYER', 'PLAYER', undefined, undefined];
        state.playerTokenPositions = [[5, -1, -1, -1], [10, 3, -1, -1], undefined, undefined];
        reducer(state, {
            type: EVENTS.NET_STATE_SYNCED,
            positions: [[5, -1, -1, -1], undefined, undefined, undefined],
            playerTypes: ['PLAYER', undefined, undefined, undefined],
            currentPlayerIndex: 0,
            phase: 'AWAIT_ROLL',
        });
        expect(state.playerTypes[1]).toBeUndefined();
        expect(state.playerTokenPositions[1]).toBeUndefined();
        expect(state.playerTokenPositions[0]).toEqual([5, -1, -1, -1]);
        expect(state.phase).toBe(PHASES.AWAITING_ROLL);
        expect(state.movableTokenIndexes).toEqual([]);
    });

    it('NET_STATE_SYNCED leaves phase alone when the server says ENDED', () => {
        // The ENDED frame drives NET_GAME_ENDED, which owns the end transition
        // (mounting the recap exactly once). The snapshot sync must not race it.
        const state = initialGameState();
        state.playerTypes = ['PLAYER', 'PLAYER', undefined, undefined];
        state.playerTokenPositions = [[56, 56, 56, 56], [10, 3, -1, -1], undefined, undefined];
        state.phase = PHASES.AWAITING_SELECTION;
        reducer(state, {
            type: EVENTS.NET_STATE_SYNCED,
            positions: [[56, 56, 56, 56], [10, 3, -1, -1], undefined, undefined],
            playerTypes: ['PLAYER', 'PLAYER', undefined, undefined],
            currentPlayerIndex: 0,
            phase: 'ENDED',
            ranks: [1, 2, 0, 0],
        });
        expect(state.phase).toBe(PHASES.AWAITING_SELECTION); // untouched
        expect(state.playerRanks[0]).toBe(1);
        expect(state.winnerIndex).toBe(0);
        expect(state.lastRank).toBe(2);
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
