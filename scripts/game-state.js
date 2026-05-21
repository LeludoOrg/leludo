/**
 * Single source of truth for the game's runtime state. Replaces the
 * module-level globals that used to live in game-events.js. Phase A of
 * the event-sourced refactor — the object is still mutated imperatively
 * by game-events.js; later phases route writes through a reducer.
 *
 * Live array fields (playerTypes, playerRanks, playerTimes, playerCaptures,
 * playerNames, botPersonalities, playerTokenPositions) are stable
 * references — game-events.js re-exports them as named exports that
 * external consumers (wc-game-end, wc-quick-start) already hold. Never
 * replace these array references; mutate them in place.
 */

export const PHASES = Object.freeze({
    AWAITING_ROLL: 'AWAITING_ROLL',
    ROLLING: 'ROLLING',
    AWAITING_SELECTION: 'AWAITING_SELECTION',
    ANIMATING: 'ANIMATING',
    TURN_TRANSITION: 'TURN_TRANSITION',
    GAME_ENDED: 'GAME_ENDED',
    PAUSED: 'PAUSED',
});

export function initialGameState() {
    return {
        quickStartId: null,
        playerNames: new Array(4).fill(''),
        playerTypes: new Array(4),
        botPersonalities: new Array(4).fill(null),
        playerTokenPositions: new Array(4),

        currentPlayerIndex: 2,
        currentDiceRoll: 1,
        consecutiveSixesCount: 0,

        playerRanks: new Array(4).fill(0),
        playerTimes: new Array(4).fill(0),
        playerCaptures: new Array(4).fill(0),
        lastRank: 0,

        gameStartedAt: 0,
        turnCount: 0,
        winnerIndex: -1,

        assistFlags: {
            autoRollDice: false,
            autoMoveSingleOption: false,
            autoMoveOutOfHome: true,
        },

        phase: PHASES.AWAITING_ROLL,
        phaseBeforePause: null,
        movableTokenIndexes: [],
    };
}

export const state = initialGameState();

/**
 * Live array references kept stable across the game's lifetime. External
 * consumers (wc-game-end, wc-quick-start) hold these directly and see
 * mutations through the same reference. The reducer mutates the arrays
 * in place rather than reassigning them, so these stay valid forever.
 */
export const playerTypes = state.playerTypes;
export const playerRanks = state.playerRanks;
export const playerTimes = state.playerTimes;
export const playerCaptures = state.playerCaptures;
export const playerNames = state.playerNames;
export const botPersonalities = state.botPersonalities;

/**
 * Reset element-wise so live array references stay valid for any external
 * consumer that imported them via game-events.js.
 */
export function resetGameState() {
    const fresh = initialGameState();
    state.quickStartId = fresh.quickStartId;

    for (let i = 0; i < 4; i++) {
        state.playerNames[i] = fresh.playerNames[i];
        state.playerTypes[i] = fresh.playerTypes[i];
        state.botPersonalities[i] = fresh.botPersonalities[i];
        state.playerTokenPositions[i] = fresh.playerTokenPositions[i];
        state.playerRanks[i] = fresh.playerRanks[i];
        state.playerTimes[i] = fresh.playerTimes[i];
        state.playerCaptures[i] = fresh.playerCaptures[i];
    }

    state.currentPlayerIndex = fresh.currentPlayerIndex;
    state.currentDiceRoll = fresh.currentDiceRoll;
    state.consecutiveSixesCount = fresh.consecutiveSixesCount;
    state.lastRank = fresh.lastRank;
    state.gameStartedAt = fresh.gameStartedAt;
    state.turnCount = fresh.turnCount;
    state.winnerIndex = fresh.winnerIndex;
    state.assistFlags = fresh.assistFlags;
    state.phase = fresh.phase;
    state.phaseBeforePause = fresh.phaseBeforePause;
    state.movableTokenIndexes = fresh.movableTokenIndexes;
}
