/**
 * Pure turn / rank / serialization rules. No DOM, no timers, no globals.
 * Tested directly. Consumed by game-events.js.
 */

import { YARD, FINISH } from "./board-constants.js";
import { clonePositions } from "./board-util.js";

/**
 * @param {number[]} tokenPositions  4 positions for one player
 * @returns {boolean}
 */
export function isPlayerFinished(tokenPositions) {
    return tokenPositions.every(tp => tp === FINISH);
}

/**
 * @param {number[]} tokenPositions
 * @returns {boolean}
 */
export function allTokensInHome(tokenPositions) {
    return tokenPositions.every(p => p === YARD);
}

/**
 * @param {number[]} tokenPositions
 * @returns {number}  number of tokens that have finished the trip
 */
export function getFinishedCount(tokenPositions) {
    if (!tokenPositions) return 0;
    return tokenPositions.filter(p => p === FINISH).length;
}

/**
 * Initial player chosen at game start. Prefers position 2 if any human present
 * (so the human always starts), else first defined player slot.
 * @param {('PLAYER'|'BOT'|undefined)[]} playerTypes
 * @returns {number}  index in 0..3
 */
export function selectStartingPlayer(playerTypes) {
    return playerTypes.includes('PLAYER')
        ? 2
        : playerTypes.findIndex(t => t !== undefined);
}

/**
 * Does the moving player get to roll again? A 6, a capture, or completing a
 * token's trip grants another turn — UNLESS that same move finished the
 * player's last token (nothing left to move), in which case the turn must
 * advance. Shared by the live game (command-handler) and the headless driver
 * (game-driver) so the two turn state machines can't diverge.
 * @param {number} diceRoll
 * @param {number} captureCount
 * @param {boolean} tripComplete
 * @param {boolean} playerFinished  did this move finish the player's last token?
 * @returns {boolean}
 */
export function grantsAnotherTurn(diceRoll, captureCount, tripComplete, playerFinished) {
    return (diceRoll === 6 || captureCount > 0 || tripComplete) && !playerFinished;
}

/**
 * Round-robin to next active (defined, not-finished) player.
 * @param {number} currentIndex
 * @param {('PLAYER'|'BOT'|undefined)[]} playerTypes
 * @param {number[][]} playerTokenPositions
 * @returns {number}  -1 if no active player remains
 */
export function getNextPlayerIndex(currentIndex, playerTypes, playerTokenPositions) {
    for (let k = 1; k <= 4; k++) {
        const j = (currentIndex + k) % 4;
        if (playerTypes[j] === undefined) continue;
        if (!playerTokenPositions[j]) continue;
        if (isPlayerFinished(playerTokenPositions[j])) continue;
        return j;
    }
    return -1;
}

/**
 * Should the current game end? True when only one active player remains, OR
 * when every human has finished and bots are still playing (humans-vs-bots
 * mode auto-ends to skip dragged-out bot endgame).
 * @param {('PLAYER'|'BOT'|undefined)[]} playerTypes
 * @param {number[][]} playerTokenPositions
 * @returns {boolean}
 */
export function shouldEndGame(playerTypes, playerTokenPositions) {
    let numberOfRemainingPlayers = 0;
    let remainingHumans = 0;
    let hasAnyHuman = false;
    playerTypes.forEach((playerType, playerIndex) => {
        if (!playerType) return;
        if (playerType === 'PLAYER') hasAnyHuman = true;
        if (!playerTokenPositions[playerIndex] || !isPlayerFinished(playerTokenPositions[playerIndex])) {
            numberOfRemainingPlayers++;
            if (playerType === 'PLAYER') remainingHumans++;
        }
    });
    const allHumansDoneVsBots = hasAnyHuman && remainingHumans === 0 && numberOfRemainingPlayers > 0;
    return numberOfRemainingPlayers <= 1 || allHumansDoneVsBots;
}

/**
 * Players not yet ranked, ordered by finished-count desc, then track-sum desc.
 * Used when the game ends early to assign final ranks to remaining players.
 * @param {('PLAYER'|'BOT'|undefined)[]} playerTypes
 * @param {number[][]} playerTokenPositions
 * @param {number[]} playerRanks  current ranks (0 = not yet ranked)
 * @returns {number[]}  player indexes in rank-assignment order
 */
export function computeLeftoverRankOrder(playerTypes, playerTokenPositions, playerRanks) {
    const leftover = [];
    playerTypes.forEach((playerType, playerIndex) => {
        if (playerType && playerRanks[playerIndex] === 0) leftover.push(playerIndex);
    });
    leftover.sort((a, b) => {
        const fa = getFinishedCount(playerTokenPositions[a]);
        const fb = getFinishedCount(playerTokenPositions[b]);
        if (fb !== fa) return fb - fa;
        const sa = playerTokenPositions[a].reduce((s, p) => s + (p < 0 ? 0 : p), 0);
        const sb = playerTokenPositions[b].reduce((s, p) => s + (p < 0 ? 0 : p), 0);
        return sb - sa;
    });
    return leftover;
}

/**
 * Build save payload. Pure — caller persists to localStorage.
 */
export function serializeGameState({
    quickStartId,
    playerNames,
    playerTypes,
    botPersonalities,
    playerTokenPositions,
    currentPlayerIndex,
    currentDiceRoll,
    consecutiveSixesCount,
    playerCaptures,
    playerRanks,
    playerTimes,
    lastRank,
    gameStartedAt,
    turnCount,
}) {
    return {
        quickStartId,
        playerNamesArr: playerNames.slice(),
        playerTypesArr: playerTypes.slice(),
        botPersonalitiesArr: botPersonalities.slice(),
        positions: clonePositions(playerTokenPositions, null),
        currentPlayerIndex,
        currentDiceRoll,
        consecutiveSixesCount,
        capturesArr: playerCaptures.slice(),
        ranksArr: playerRanks.slice(),
        timesArr: playerTimes.slice(),
        lastRank,
        gameStartedAt,
        turnCount: Number.isFinite(turnCount) ? turnCount : 0,
    };
}

/**
 * Parse a JSON save string. Returns null on any error / missing data.
 * @param {string|null|undefined} raw
 */
export function deserializeGameState(raw) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (!Array.isArray(parsed.positions)) return null;
        return parsed;
    } catch {
        return null;
    }
}
