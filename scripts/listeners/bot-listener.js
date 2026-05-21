/**
 * Bot scheduler / autoplay listener. Owns the pause-aware setTimeout
 * queue from scripts/scheduler.js. Reacts to game events: when it's a
 * bot's turn (or the autoRollDice assist is on), dispatches the next
 * command after the appropriate delay. When movable tokens are
 * determined for a bot, picks the best move via bot-ai and dispatches
 * SELECT_TOKEN.
 *
 * Replaces the inline scheduleTurn calls in the old game-events.js
 * handleAfterDiceRoll / handleAfterTokenMove / handleDiceMoved.
 */

import { EVENTS, subscribe, dispatch } from '../game-store.js';
import { COMMANDS } from '../command-handler.js';
import { state } from '../game-state.js';
import { scheduleTurn, isGameLogicPaused } from '../scheduler.js';
import { pickBestMove, PERSONALITIES } from '../bot-ai.js';
import { allTokensInHome, getUniqueTokenPositions } from '../index.js';

const DICE_ROLL_DELAY = 600;
const BOT_TOKEN_SELECT_DELAY = 400;
const ASSIST_TOKEN_SELECT_DELAY = 300;

function isCurrentPlayerBot() {
    return state.playerTypes[state.currentPlayerIndex] === 'BOT';
}

function isAutoplay() {
    return state.assistFlags.autoRollDice || isCurrentPlayerBot();
}

function maybeAutoRoll() {
    if (isGameLogicPaused()) return;
    if (!isAutoplay()) return;
    scheduleTurn(() => dispatch({ type: COMMANDS.ROLL_DICE }), DICE_ROLL_DELAY);
}

function pickBotToken(movableTokenIndexes) {
    const unique = getUniqueTokenPositions(
        state.currentPlayerIndex,
        movableTokenIndexes,
        state.playerTokenPositions,
    );
    if (unique.size === 1) return movableTokenIndexes[0];
    const weights = PERSONALITIES[state.botPersonalities[state.currentPlayerIndex]]
        || PERSONALITIES.balanced;
    const bestIndex = pickBestMove(
        state.currentPlayerIndex,
        state.currentDiceRoll,
        state.playerTokenPositions,
        weights,
        1,
    );
    return bestIndex >= 0 ? bestIndex : movableTokenIndexes[0];
}

function maybeAutoSelect(movableTokenIndexes) {
    if (isGameLogicPaused()) return;
    if (isCurrentPlayerBot()) {
        scheduleTurn(() => {
            const tokenIndex = pickBotToken(movableTokenIndexes);
            dispatch({
                type: COMMANDS.SELECT_TOKEN,
                playerIndex: state.currentPlayerIndex,
                tokenIndex,
            });
        }, BOT_TOKEN_SELECT_DELAY);
        return;
    }
    // Human with assist flags on.
    const unique = getUniqueTokenPositions(
        state.currentPlayerIndex,
        movableTokenIndexes,
        state.playerTokenPositions,
    );
    const singleOption = unique.size === 1;
    const onlyHomeOut = allTokensInHome(state.playerTokenPositions[state.currentPlayerIndex])
        && state.currentDiceRoll === 6;
    if ((state.assistFlags.autoMoveSingleOption && singleOption)
        || (state.assistFlags.autoMoveOutOfHome && onlyHomeOut)) {
        scheduleTurn(() => dispatch({
            type: COMMANDS.SELECT_TOKEN,
            playerIndex: state.currentPlayerIndex,
            tokenIndex: movableTokenIndexes[0],
        }), ASSIST_TOKEN_SELECT_DELAY);
    }
}

export function installBotListener() {
    subscribe((event) => {
        switch (event.type) {
            case EVENTS.GAME_STARTED:
            case EVENTS.GAME_RESUMED:
            case EVENTS.TURN_ADVANCED:
            case EVENTS.TURN_REPEATS:
                maybeAutoRoll();
                break;
            case EVENTS.MOVABLE_TOKENS_DETERMINED:
                maybeAutoSelect(event.tokenIndexes);
                break;
        }
    });
}
