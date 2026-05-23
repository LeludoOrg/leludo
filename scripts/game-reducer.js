/**
 * Pure reducer for the event-sourced Ludo store. Phase B of the refactor.
 *
 * `reducer(state, event) → newState` — every mutation that previously
 * happened inside game-events.js now corresponds to one event type here.
 * The reducer is the only place state gets updated; in Phase B it runs
 * as a shadow channel alongside the imperative handlers, and the test
 * suite asserts the two paths produce identical state.
 *
 * Mutates the passed-in state object element-wise so the live array
 * references (playerTypes, playerRanks, etc.) re-exported by
 * game-events.js stay valid. This is not idiomatic Redux but matches
 * the constraint that external consumers hold the array references
 * directly. Phase C will move to fully immutable updates if needed.
 */

import { initialGameState, PHASES } from './game-state.js';

export const EVENTS = Object.freeze({
    GAME_STARTED: 'GAME_STARTED',
    GAME_RESUMED: 'GAME_RESUMED',
    GAME_RESTARTED: 'GAME_RESTARTED',
    DICE_ROLLED: 'DICE_ROLLED',
    THREE_SIXES_LOST: 'THREE_SIXES_LOST',
    MOVABLE_TOKENS_DETERMINED: 'MOVABLE_TOKENS_DETERMINED',
    TOKEN_MOVED: 'TOKEN_MOVED',
    TOKEN_CAPTURED: 'TOKEN_CAPTURED',
    PLAYER_FINISHED: 'PLAYER_FINISHED',
    LEFTOVER_RANKED: 'LEFTOVER_RANKED',
    GAME_ENDED: 'GAME_ENDED',
    TURN_ADVANCED: 'TURN_ADVANCED',
    TURN_REPEATS: 'TURN_REPEATS',
    ASSIST_FLAG_CHANGED: 'ASSIST_FLAG_CHANGED',
    TURN_COUNT_SET: 'TURN_COUNT_SET',
    NAMES_SET: 'NAMES_SET',
    GAME_PAUSED: 'GAME_PAUSED',
    GAME_RESUMED_FROM_PAUSE: 'GAME_RESUMED_FROM_PAUSE',
    DICE_ROLL_STARTED: 'DICE_ROLL_STARTED',
    GOD_TELEPORTED: 'GOD_TELEPORTED',
});

function resetArraysInPlace(state) {
    for (let i = 0; i < 4; i++) {
        state.playerNames[i] = '';
        state.playerTypes[i] = undefined;
        state.botPersonalities[i] = null;
        state.playerTokenPositions[i] = undefined;
        state.playerRanks[i] = 0;
        state.playerTimes[i] = 0;
        state.playerCaptures[i] = 0;
    }
}

export function reducer(state, event) {
    switch (event.type) {
        case EVENTS.GAME_STARTED: {
            state.quickStartId = event.quickStartId;
            state.gameStartedAt = event.gameStartedAt;
            state.lastRank = 0;
            state.consecutiveSixesCount = 0;
            state.currentDiceRoll = 1;
            state.turnCount = 0;
            state.winnerIndex = -1;
            state.phase = PHASES.AWAITING_ROLL;
            for (let i = 0; i < 4; i++) {
                state.playerTypes[i] = event.playerTypes[i];
                state.botPersonalities[i] = event.botPersonalities[i] ?? null;
                state.playerNames[i] = event.playerNames[i] || '';
                state.playerRanks[i] = 0;
                state.playerTimes[i] = 0;
                state.playerCaptures[i] = 0;
                state.playerTokenPositions[i] = event.playerTokenPositions[i]
                    ? event.playerTokenPositions[i].slice()
                    : undefined;
            }
            state.currentPlayerIndex = event.currentPlayerIndex;
            return state;
        }

        case EVENTS.GAME_RESUMED: {
            state.quickStartId = event.quickStartId;
            state.gameStartedAt = event.gameStartedAt;
            state.lastRank = event.lastRank;
            state.consecutiveSixesCount = event.consecutiveSixesCount;
            state.currentDiceRoll = event.currentDiceRoll;
            state.turnCount = event.turnCount || 0;
            state.currentPlayerIndex = event.currentPlayerIndex;
            state.winnerIndex = -1;
            state.phase = PHASES.AWAITING_ROLL;
            for (let i = 0; i < 4; i++) {
                state.playerTypes[i] = event.playerTypes[i];
                state.botPersonalities[i] = event.botPersonalities[i] ?? null;
                state.playerNames[i] = event.playerNames[i] || '';
                state.playerRanks[i] = event.playerRanks[i] ?? 0;
                state.playerTimes[i] = event.playerTimes[i] ?? 0;
                state.playerCaptures[i] = event.playerCaptures[i] ?? 0;
                state.playerTokenPositions[i] = event.playerTokenPositions[i]
                    ? event.playerTokenPositions[i].slice()
                    : undefined;
            }
            return state;
        }

        case EVENTS.GAME_RESTARTED: {
            resetArraysInPlace(state);
            state.quickStartId = null;
            state.lastRank = 0;
            state.consecutiveSixesCount = 0;
            state.currentDiceRoll = 1;
            state.turnCount = 0;
            state.winnerIndex = -1;
            state.phase = PHASES.AWAITING_ROLL;
            return state;
        }

        case EVENTS.DICE_ROLL_STARTED: {
            state.phase = PHASES.ROLLING;
            return state;
        }

        case EVENTS.DICE_ROLLED: {
            state.currentDiceRoll = event.value;
            if (event.value === 6) state.consecutiveSixesCount++;
            else state.consecutiveSixesCount = 0;
            return state;
        }

        case EVENTS.THREE_SIXES_LOST: {
            state.consecutiveSixesCount = 0;
            return state;
        }

        case EVENTS.TOKEN_MOVED: {
            state.playerTokenPositions[event.playerIndex][event.tokenIndex] = event.toPosition;
            state.phase = PHASES.ANIMATING;
            return state;
        }

        case EVENTS.TOKEN_CAPTURED: {
            state.playerTokenPositions[event.capturedPlayerIndex][event.capturedTokenIndex] = -1;
            state.playerCaptures[event.byPlayerIndex]++;
            return state;
        }

        case EVENTS.PLAYER_FINISHED: {
            state.playerRanks[event.playerIndex] = event.rank;
            state.playerTimes[event.playerIndex] = event.time;
            state.lastRank = event.rank;
            if (state.winnerIndex === -1) state.winnerIndex = event.playerIndex;
            return state;
        }

        case EVENTS.LEFTOVER_RANKED: {
            state.playerRanks[event.playerIndex] = event.rank;
            state.playerTimes[event.playerIndex] = event.time;
            state.lastRank = event.rank;
            return state;
        }

        case EVENTS.GAME_ENDED: {
            if (event.winnerIndex !== undefined && state.winnerIndex === -1) {
                state.winnerIndex = event.winnerIndex;
            }
            state.phase = PHASES.GAME_ENDED;
            return state;
        }

        case EVENTS.TURN_ADVANCED: {
            state.currentPlayerIndex = event.nextPlayerIndex;
            state.consecutiveSixesCount = 0;
            state.phase = PHASES.AWAITING_ROLL;
            state.movableTokenIndexes = [];
            return state;
        }

        case EVENTS.TURN_REPEATS: {
            state.phase = PHASES.AWAITING_ROLL;
            state.movableTokenIndexes = [];
            return state;
        }

        case EVENTS.MOVABLE_TOKENS_DETERMINED: {
            state.movableTokenIndexes = event.tokenIndexes.slice();
            state.phase = PHASES.AWAITING_SELECTION;
            return state;
        }

        case EVENTS.GAME_PAUSED: {
            state.phaseBeforePause = state.phase;
            state.phase = 'PAUSED';
            return state;
        }

        case EVENTS.GAME_RESUMED_FROM_PAUSE: {
            if (state.phaseBeforePause) {
                state.phase = state.phaseBeforePause;
                state.phaseBeforePause = null;
            }
            return state;
        }

        case EVENTS.ASSIST_FLAG_CHANGED: {
            state.assistFlags[event.flag] = event.value;
            return state;
        }

        case EVENTS.TURN_COUNT_SET: {
            state.turnCount = event.value;
            return state;
        }

        case EVENTS.GOD_TELEPORTED: {
            const row = state.playerTokenPositions[event.playerIndex];
            if (row) row[event.tokenIndex] = event.toPosition;
            return state;
        }

        case EVENTS.NAMES_SET: {
            for (let i = 0; i < 4; i++) {
                state.playerNames[i] = event.playerNames[i] || '';
            }
            return state;
        }

        default:
            return state;
    }
}

/**
 * Fold an event list onto a fresh initial state. Convenience for tests
 * and for the eventual replay/network-resync code path.
 */
export function applyEvents(events, startState) {
    const s = startState || initialGameState();
    for (const e of events) reducer(s, e);
    return s;
}
