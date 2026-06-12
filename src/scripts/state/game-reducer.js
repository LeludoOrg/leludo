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
import { YARD, HOME_STRETCH_START, FINISH } from '../core/board-constants.js';

export const EVENTS = Object.freeze({
    GAME_STARTED: 'GAME_STARTED',
    GAME_RESUMED: 'GAME_RESUMED',
    GAME_RESTARTED: 'GAME_RESTARTED',
    DICE_ROLLED: 'DICE_ROLLED',
    THREE_SIXES_LOST: 'THREE_SIXES_LOST',
    PLAYER_STUCK: 'PLAYER_STUCK',
    MOVABLE_TOKENS_DETERMINED: 'MOVABLE_TOKENS_DETERMINED',
    TOKEN_MOVED: 'TOKEN_MOVED',
    TOKEN_CAPTURED: 'TOKEN_CAPTURED',
    PLAYER_FINISHED: 'PLAYER_FINISHED',
    LEFTOVER_RANKED: 'LEFTOVER_RANKED',
    GAME_ENDED: 'GAME_ENDED',
    TURN_ADVANCED: 'TURN_ADVANCED',
    TURN_REPEATS: 'TURN_REPEATS',
    ASSIST_FLAG_CHANGED: 'ASSIST_FLAG_CHANGED',
    GAME_PAUSED: 'GAME_PAUSED',
    GAME_RESUMED_FROM_PAUSE: 'GAME_RESUMED_FROM_PAUSE',
    DICE_ROLL_STARTED: 'DICE_ROLL_STARTED',
    GOD_TELEPORTED: 'GOD_TELEPORTED',
    NET_STATE_SYNCED: 'NET_STATE_SYNCED',
    NET_PLAYER_DROPPED: 'NET_PLAYER_DROPPED',
    NET_GAME_ENDED: 'NET_GAME_ENDED',
});

// Reset seat `i`'s per-game highlight-reel stats to their "nothing happened
// yet" defaults. Identical across a fresh start, a resume, and a full clear, so
// it lives in one place (the -1s are "turn not reached yet" sentinels, not
// board positions). Shared by resetArraysInPlace + GAME_STARTED + GAME_RESUMED.
function resetPlayerStats(state, i) {
    state.sentHomeCount[i] = 0;
    state.firstHomeStretchTurn[i] = -1;
    state.firstFinishTurn[i] = -1;
    state.distanceTraveled[i] = 0;
    state.pawnsAtBaseAtTurn20[i] = -1;
    state.bestDiceStreak[i] = null;
    state.noMoveStreak[i] = 0;
}

function resetArraysInPlace(state) {
    for (let i = 0; i < 4; i++) {
        state.playerNames[i] = '';
        state.playerTypes[i] = undefined;
        state.botPersonalities[i] = null;
        state.playerTokenPositions[i] = undefined;
        state.playerRanks[i] = 0;
        state.playerTimes[i] = 0;
        state.playerCaptures[i] = 0;
        resetPlayerStats(state, i);
    }
    state.currentDiceStreak = null;
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
                resetPlayerStats(state, i);
                state.playerTokenPositions[i] = event.playerTokenPositions[i]
                    ? event.playerTokenPositions[i].slice()
                    : undefined;
            }
            state.currentDiceStreak = null;
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
                resetPlayerStats(state, i);
                state.playerTokenPositions[i] = event.playerTokenPositions[i]
                    ? event.playerTokenPositions[i].slice()
                    : undefined;
            }
            state.currentDiceStreak = null;
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

            const pi = state.currentPlayerIndex;
            const prev = state.currentDiceStreak;
            if (prev && prev.playerIndex === pi && prev.value === event.value) {
                prev.length++;
            } else {
                state.currentDiceStreak = {
                    playerIndex: pi,
                    value: event.value,
                    length: 1,
                    atTurn: state.turnCount,
                };
            }
            const cur = state.currentDiceStreak;
            const best = state.bestDiceStreak[pi];
            if (!best || cur.length > best.length) {
                state.bestDiceStreak[pi] = {
                    value: cur.value,
                    length: cur.length,
                    atTurn: cur.atTurn,
                };
            }
            return state;
        }

        case EVENTS.THREE_SIXES_LOST: {
            state.consecutiveSixesCount = 0;
            return state;
        }

        case EVENTS.PLAYER_STUCK: {
            // No movable pawn this turn — extend the drought so the pity-six
            // rule can eventually rescue a player frozen in the yard.
            const pi = state.currentPlayerIndex;
            state.noMoveStreak[pi] = (state.noMoveStreak[pi] || 0) + 1;
            return state;
        }

        case EVENTS.TOKEN_MOVED: {
            state.playerTokenPositions[event.playerIndex][event.tokenIndex] = event.toPosition;
            state.phase = PHASES.ANIMATING;

            const pi = event.playerIndex;
            if (event.fromPosition >= 0 && event.toPosition >= 0) {
                state.distanceTraveled[pi] += event.toPosition - event.fromPosition;
            } else if (event.fromPosition === YARD && event.toPosition >= 0) {
                state.distanceTraveled[pi] += 1;
            }
            if (event.fromPosition < HOME_STRETCH_START && event.toPosition >= HOME_STRETCH_START && event.toPosition <= FINISH) {
                if (state.firstHomeStretchTurn[pi] === -1) {
                    state.firstHomeStretchTurn[pi] = state.turnCount;
                }
            }
            if (event.toPosition === FINISH && state.firstFinishTurn[pi] === -1) {
                state.firstFinishTurn[pi] = state.turnCount;
            }
            return state;
        }

        case EVENTS.TOKEN_CAPTURED: {
            state.playerTokenPositions[event.capturedPlayerIndex][event.capturedTokenIndex] = YARD;
            state.playerCaptures[event.byPlayerIndex]++;
            state.sentHomeCount[event.capturedPlayerIndex]++;
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
            state.turnCount++;
            state.currentDiceStreak = null;
            if (state.turnCount === 20) {
                for (let i = 0; i < 4; i++) {
                    if (state.pawnsAtBaseAtTurn20[i] !== -1) continue;
                    if (!state.playerTypes[i] || !state.playerTokenPositions[i]) continue;
                    state.pawnsAtBaseAtTurn20[i] =
                        state.playerTokenPositions[i].filter(p => p === YARD).length;
                }
            }
            return state;
        }

        case EVENTS.TURN_REPEATS: {
            state.phase = PHASES.AWAITING_ROLL;
            state.movableTokenIndexes = [];
            return state;
        }

        // Online only: fold the server's authoritative snapshot into local state.
        // Applied UNCONDITIONALLY after every server frame — the server is the
        // source of truth for the board, whose turn it is, the phase, the dice,
        // which tokens are movable, captures and ranks. The local replay of the
        // frame's delta (dice spin, pawn glide) is purely cosmetic; whatever it
        // computed, this snapshot is the last word, so one dropped or drifted
        // delta can never leave the client diverged past the frame that follows.
        //
        // All fields arrive pre-mapped to LOCAL board indexes (online-game maps
        // server seats through toLocal before dispatching).
        case EVENTS.NET_STATE_SYNCED: {
            for (let i = 0; i < 4; i++) {
                const active = event.playerTypes ? event.playerTypes[i] != null : state.playerTypes[i] != null;
                if (!active) {
                    // Seat inactive on the server (forfeited / never seated): make
                    // sure it's inactive here too, even if the DROPPED frame that
                    // announced it was missed while this client was offline.
                    state.playerTypes[i] = undefined;
                    state.playerTokenPositions[i] = undefined;
                    state.botPersonalities[i] = null;
                    continue;
                }
                if (event.playerTypes) state.playerTypes[i] = event.playerTypes[i];
                if (event.positions && event.positions[i]) {
                    state.playerTokenPositions[i] = event.positions[i].slice();
                }
                if (event.captures) state.playerCaptures[i] = event.captures[i] ?? 0;
                if (event.ranks) state.playerRanks[i] = event.ranks[i] ?? 0;
            }
            if (event.ranks) {
                state.lastRank = Math.max(0, ...state.playerRanks);
                const winner = state.playerRanks.findIndex(r => r === 1);
                if (winner !== -1) state.winnerIndex = winner;
            }
            if (event.currentPlayerIndex != null) state.currentPlayerIndex = event.currentPlayerIndex;
            if (event.turnCount != null) state.turnCount = event.turnCount;
            if (event.dice > 0) state.currentDiceRoll = event.dice;
            // The server owns three-sixes detection; the local counter must never
            // trigger a local turn decision online.
            state.consecutiveSixesCount = 0;
            // Server phase → local phase. 'ENDED' is deliberately NOT mapped here:
            // the ENDED frame drives NET_GAME_ENDED, which owns that transition.
            if (event.phase === 'AWAIT_ROLL') {
                state.phase = PHASES.AWAITING_ROLL;
                state.movableTokenIndexes = [];
            } else if (event.phase === 'AWAIT_MOVE') {
                state.phase = PHASES.AWAITING_SELECTION;
                state.movableTokenIndexes = (event.legalMoves || []).slice();
            }
            return state;
        }

        // Online only: a player forfeited (reconnect window elapsed). Deactivate
        // their seat so the renderer + any local turn logic skip them; the
        // server stays authoritative for whose turn it is.
        case EVENTS.NET_PLAYER_DROPPED: {
            const i = event.playerIndex;
            state.playerTypes[i] = undefined;
            state.playerTokenPositions[i] = undefined;
            state.botPersonalities[i] = null;
            state.playerRanks[i] = 0;
            return state;
        }

        // Online only: the game ended on a disconnect (no finishing move). Apply
        // the server's final ranks + winner and flip to the end phase.
        case EVENTS.NET_GAME_ENDED: {
            if (Array.isArray(event.playerRanks)) {
                for (let i = 0; i < 4; i++) state.playerRanks[i] = event.playerRanks[i] ?? 0;
                state.lastRank = Math.max(0, ...state.playerRanks);
            }
            if (event.winnerIndex != null && event.winnerIndex >= 0) state.winnerIndex = event.winnerIndex;
            state.phase = PHASES.GAME_ENDED;
            return state;
        }

        case EVENTS.MOVABLE_TOKENS_DETERMINED: {
            state.movableTokenIndexes = event.tokenIndexes.slice();
            state.phase = PHASES.AWAITING_SELECTION;
            // The player can move this turn — the drought is over.
            state.noMoveStreak[state.currentPlayerIndex] = 0;
            return state;
        }

        // Pause/resume MUST NOT touch state.phase. Pausing is enforced
        // entirely by the scheduler's _paused flag + the isGameLogicPaused()
        // guards in rollDice/selectToken. phase always reflects the TRUE game
        // state so that resumeAutoplay (in bot-listener) can re-derive the
        // pending action from it on resume.
        //
        // The old code stashed phase and swapped it to 'PAUSED', then restored
        // it on resume. That clobbered legitimate phase advances made by
        // in-flight animations that complete DURING the pause (their .then
        // chains emit MOVABLE_TOKENS_DETERMINED / TURN_ADVANCED, which advance
        // phase past the stale snapshot). Restoring the snapshot rewound phase
        // to ROLLING/ANIMATING, which resumeAutoplay can't act on — the bot
        // froze and the game got stuck. These events are now reducer no-ops.
        case EVENTS.GAME_PAUSED:
        case EVENTS.GAME_RESUMED_FROM_PAUSE:
            return state;

        case EVENTS.ASSIST_FLAG_CHANGED: {
            state.assistFlags[event.flag] = event.value;
            return state;
        }

        case EVENTS.GOD_TELEPORTED: {
            const row = state.playerTokenPositions[event.playerIndex];
            if (row) row[event.tokenIndex] = event.toPosition;
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
