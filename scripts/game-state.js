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

        // Consecutive turns each player moved no pawn at all (the stuck-in-yard
        // drought). Feeds the pity-six rule; reset the moment a player can move.
        noMoveStreak: new Array(4).fill(0),

        playerRanks: new Array(4).fill(0),
        playerTimes: new Array(4).fill(0),
        playerCaptures: new Array(4).fill(0),
        lastRank: 0,

        // Per-game stats feeding the end-of-game highlight reel
        // (wc-game-end). All reset on GAME_STARTED/RESTARTED.
        sentHomeCount: new Array(4).fill(0),
        firstHomeStretchTurn: new Array(4).fill(-1),
        firstFinishTurn: new Array(4).fill(-1),
        distanceTraveled: new Array(4).fill(0),
        pawnsAtBaseAtTurn20: new Array(4).fill(-1),
        bestDiceStreak: new Array(4).fill(null),
        currentDiceStreak: null,

        gameStartedAt: 0,
        turnCount: 0,
        winnerIndex: -1,

        assistFlags: {
            autoRollDice: false,
            autoMoveSingleOption: false,
            autoMoveOutOfHome: true,
        },

        phase: PHASES.AWAITING_ROLL,
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
export const sentHomeCount = state.sentHomeCount;
export const firstHomeStretchTurn = state.firstHomeStretchTurn;
export const firstFinishTurn = state.firstFinishTurn;
export const distanceTraveled = state.distanceTraveled;
export const pawnsAtBaseAtTurn20 = state.pawnsAtBaseAtTurn20;
export const bestDiceStreak = state.bestDiceStreak;

