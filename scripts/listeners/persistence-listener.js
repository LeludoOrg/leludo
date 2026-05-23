/**
 * Persistence listener — saves game progress to localStorage on every
 * state-changing event, clears the save on game end. Replaces the inline
 * saveGameState() call that lived in the old game-events.js
 * handleAfterTokenMove flow.
 */

import { state } from '../game-state.js';
import { EVENTS, subscribe } from '../game-store.js';
import { serializeGameState, getTurnCount } from '../index.js';

const SAVE_AFTER = new Set([
    EVENTS.GAME_STARTED,
    EVENTS.GAME_RESUMED,
    EVENTS.DICE_ROLLED,
    EVENTS.THREE_SIXES_LOST,
    EVENTS.MOVABLE_TOKENS_DETERMINED,
    EVENTS.TOKEN_MOVED,
    EVENTS.TOKEN_CAPTURED,
    EVENTS.TURN_ADVANCED,
    EVENTS.TURN_REPEATS,
    EVENTS.PLAYER_FINISHED,
    EVENTS.GOD_TELEPORTED,
]);

function save() {
    if (!state.quickStartId) return;
    try {
        const serialized = serializeGameState({
            quickStartId: state.quickStartId,
            playerNames: state.playerNames,
            playerTypes: state.playerTypes,
            botPersonalities: state.botPersonalities,
            playerTokenPositions: state.playerTokenPositions,
            currentPlayerIndex: state.currentPlayerIndex,
            currentDiceRoll: state.currentDiceRoll,
            consecutiveSixesCount: state.consecutiveSixesCount,
            playerCaptures: state.playerCaptures,
            playerRanks: state.playerRanks,
            playerTimes: state.playerTimes,
            lastRank: state.lastRank,
            gameStartedAt: state.gameStartedAt,
            turnCount: getTurnCount(),
        });
        localStorage.setItem('ludo-save', JSON.stringify(serialized));
    } catch (e) {
        console.warn('persistence-listener: save failed', e);
    }
}

function clear() {
    try { localStorage.removeItem('ludo-save'); }
    catch (e) { console.warn('persistence-listener: clear failed', e); }
}

export function installPersistenceListener() {
    subscribe((event) => {
        if (event.type === EVENTS.GAME_ENDED || event.type === EVENTS.GAME_RESTARTED) {
            clear();
            return;
        }
        if (SAVE_AFTER.has(event.type)) save();
    });
}
