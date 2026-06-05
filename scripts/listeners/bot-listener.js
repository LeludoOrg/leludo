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
import { state, PHASES } from '../game-state.js';
import { scheduleTurn, isGameLogicPaused } from '../scheduler.js';
import { pickBestMove, PERSONALITIES } from '../bot-ai.js';
import { allTokensInHome, getUniqueTokenPositions } from '../index.js';
import { isOnlineActive, onlineLocalSelf } from '../online-state.js';

const DICE_ROLL_DELAY = 600;
const BOT_TOKEN_SELECT_DELAY = 400;
const ASSIST_TOKEN_SELECT_DELAY = 300;

function isCurrentPlayerBot() {
    return state.playerTypes[state.currentPlayerIndex] === 'BOT';
}

function isAutoplay() {
    return state.assistFlags.autoRollDice || isCurrentPlayerBot();
}

// Online the server rolls/moves for bots and remote players, so assists only
// ever apply to THIS client's own turn (board position = onlineLocalSelf()).
function isMyOnlineTurn() {
    return state.currentPlayerIndex === onlineLocalSelf();
}

function maybeAutoRoll() {
    if (isGameLogicPaused()) return;
    if (isOnlineActive()) {
        // Auto-roll on our own turn: dispatching ROLL_DICE sends a roll intent
        // (the command-handler gates it to self + AWAITING_ROLL), same as tapping
        // the dice. Other seats' rolls come from server broadcasts, never here.
        if (state.assistFlags.autoRollDice && isMyOnlineTurn()) {
            scheduleTurn(() => dispatch({ type: COMMANDS.ROLL_DICE }), DICE_ROLL_DELAY);
        }
        return;
    }
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

// Human assist auto-move: fire SELECT_TOKEN when the flags say so. Online this
// becomes a move intent (command-handler gates it to self + a movable token).
function maybeAssistSelect(movableTokenIndexes) {
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

function maybeAutoSelect(movableTokenIndexes) {
    if (isGameLogicPaused()) return;
    if (isOnlineActive()) {
        // Only our own turn — bots'/remotes' moves arrive via server broadcasts.
        if (isMyOnlineTurn()) maybeAssistSelect(movableTokenIndexes);
        return;
    }
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
    maybeAssistSelect(movableTokenIndexes);
}

// Re-derive the pending bot/assist action from the current phase. Dice and
// token-move animations are NOT pause-aware (they don't go through
// scheduleTurn), so when a player pauses or opens settings mid-animation the
// animation completes during the pause and emits its follow-up event
// (MOVABLE_TOKENS_DETERMINED / TURN_ADVANCED) while _paused is true —
// maybeAutoRoll/maybeAutoSelect early-return and silently drop it. The
// scheduler's _pendingResume only recovers in-flight scheduleTurn timers, not
// these dropped events, so resume would otherwise leave the bot frozen (game
// stuck, or only unblockable by clicking the bot's dice/pawn).
//
// On resume the reducer has already advanced phase to the correct AWAITING_*
// state, so we just re-trigger the matching action. ROLLING/ANIMATING mean an
// animation is still running and will emit normally once unpaused, so we leave
// those alone. If _pendingResume already re-fired the same continuation, that
// dispatch synchronously moves phase off AWAITING_* before this runs, so the
// guard below makes the re-derivation a no-op — no double roll/select.
function resumeAutoplay() {
    if (isGameLogicPaused()) return;
    if (state.phase === PHASES.AWAITING_ROLL) {
        maybeAutoRoll();
    } else if (state.phase === PHASES.AWAITING_SELECTION) {
        maybeAutoSelect(state.movableTokenIndexes);
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
            case EVENTS.GAME_RESUMED_FROM_PAUSE:
                resumeAutoplay();
                break;
        }
    });
}
