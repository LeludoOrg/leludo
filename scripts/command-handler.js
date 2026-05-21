/**
 * Command handler — the orchestrator that replaces the imperative
 * handlers in the old scripts/game-events.js. Receives commands from
 * UI / bots / the network transport (later), emits events through the
 * reducer, and runs the inline animation side effects.
 *
 * Phase D of the event-sourced refactor: persistence, audio, and bot
 * scheduling now live in scripts/listeners/*-listener.js. Animation,
 * dice/token visual state, and game-end DOM mount remain inline here
 * pending a later split.
 */

import {
    activateDice,
    activateToken,
    animateDiceRoll,
    clearTokenElementCache,
    findCapturedOpponents,
    generateDiceRoll,
    applyColorMap, getPlayerTypes,
    getTokenContainerId,
    getTokenElement,
    getTokenElementId,
    getTokenNewPosition,
    inactiveDice,
    inactiveTokens,
    isTokenMovable,
    isTripComplete,
    moveDice,
    playClickSound,
    releaseWakeLock,
    resumeGame,
    showGame,
    showPauseMenu,
    updateCellStacking,
    updateDiceFace,
    updateTokenContainer,
    updateTurnCounter,
    resetTurnCount,
    setTurnCount,
    initRailDeps,
    setPlayerNames,
} from "./index.js";
import { randomPersonality } from "./bot-ai.js";
import {
    isPlayerFinished as isPlayerFinishedPure,
    getFinishedCount as getFinishedCountPure,
    selectStartingPlayer,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
    deserializeGameState,
} from "./turn-rules.js";
import { state, PHASES } from "./game-state.js";
import { EVENTS } from "./game-reducer.js";
import {
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
} from "./scheduler.js";

export {
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
    _scheduleTurnForTest,
} from "./scheduler.js";

export const COMMANDS = Object.freeze({
    START_GAME: 'START_GAME',
    RESUME_SAVED_GAME: 'RESUME_SAVED_GAME',
    ROLL_DICE: 'ROLL_DICE',
    SELECT_TOKEN: 'SELECT_TOKEN',
    PAUSE: 'PAUSE',
    RESUME: 'RESUME',
    RESTART_GAME: 'RESTART_GAME',
    SET_ASSIST_FLAG: 'SET_ASSIST_FLAG',
});

// --- phase machine guards ---

function canRoll() {
    return state.phase === PHASES.AWAITING_ROLL;
}

function canSelectToken(tokenIndex) {
    return state.phase === PHASES.AWAITING_SELECTION
        && state.movableTokenIndexes.includes(tokenIndex);
}

// --- helpers ---

function isPlayerFinished(playerIndex) {
    return isPlayerFinishedPure(state.playerTokenPositions[playerIndex]);
}

// --- command implementations ---

function startGame(quickStartId, namesByPlayerIndex, emit) {
    // Allowed from any phase — starting a new game resets the machine.
    resetTurnCount();
    initRailDeps(state.playerTypes, getCurrentPlayerIndex, getFinishedCount, getIsLocalMultiplayer);

    const playerTypesResult = getPlayerTypes(quickStartId);

    const playerTypes = new Array(4);
    const botPersonalities = new Array(4).fill(null);
    const playerTokenPositions = new Array(4);
    playerTypesResult.playerTypes.forEach((pt, i) => {
        playerTypes[i] = pt;
        botPersonalities[i] = pt === "BOT" ? randomPersonality() : null;
        playerTokenPositions[i] = pt ? new Array(4).fill(-1) : undefined;
    });
    applyColorMap(playerTypesResult.colorMap);

    const playerNames = new Array(4).fill('');
    for (let i = 0; i < 4; i++) {
        playerNames[i] = (namesByPlayerIndex && namesByPlayerIndex[i]) || '';
    }

    const startingPlayerIndex = selectStartingPlayer(playerTypes);

    const params = new URLSearchParams(window.location.search);
    const initPositions = params.get("positions")?.split(",");
    if (initPositions) {
        for (let pi = 0; pi < 4; pi++) {
            if (!playerTokenPositions[pi]) continue;
            for (let ti = 0; ti < 4; ti++) {
                const v = initPositions[(pi * 4) + ti];
                if (v !== undefined && v !== '') playerTokenPositions[pi][ti] = +v;
            }
        }
    }
    const playerOverride = params.get("player");
    const currentPlayerIndex = playerOverride != null ? +playerOverride : startingPlayerIndex;

    emit({
        type: EVENTS.GAME_STARTED,
        quickStartId,
        gameStartedAt: new Date().getTime(),
        playerTypes,
        botPersonalities,
        playerNames,
        playerTokenPositions,
        currentPlayerIndex,
    });

    setPlayerNames(state.playerNames);

    showGame();

    const containersToRestack = new Set();
    state.playerTypes.forEach((playerType, playerIndex) => {
        if (!playerType) return;
        state.playerTokenPositions[playerIndex].forEach((pos, tokenIndex) => {
            const token = document.createElement("wc-token");
            token.setAttribute("id", getTokenElementId(playerIndex, tokenIndex));
            const containerId = getTokenContainerId(playerIndex, tokenIndex, pos);
            const targetContainer = document.getElementById(containerId);
            if (targetContainer) {
                targetContainer.appendChild(token);
                containersToRestack.add(targetContainer);
            }
        });
    });
    containersToRestack.forEach(cell => updateCellStacking(cell));

    moveDice(state.currentPlayerIndex);
}

function resumeSavedGame(emit) {
    const saved = deserializeGameState(localStorage.getItem('ludo-save'));
    if (!saved) return;

    const playerTypes = saved.playerTypesArr.slice();
    const botPersonalities = saved.botPersonalitiesArr
        ? saved.botPersonalitiesArr.map(p => p || null)
        : playerTypes.map(t => t === "BOT" ? randomPersonality() : null);
    const playerNames = (saved.playerNamesArr || []).map(n => n || '');
    while (playerNames.length < 4) playerNames.push('');

    initRailDeps(state.playerTypes, getCurrentPlayerIndex, getFinishedCount, getIsLocalMultiplayer);

    const playerTypesResult = getPlayerTypes(saved.quickStartId);
    applyColorMap(playerTypesResult.colorMap);

    emit({
        type: EVENTS.GAME_RESUMED,
        quickStartId: saved.quickStartId,
        gameStartedAt: saved.gameStartedAt,
        lastRank: saved.lastRank,
        consecutiveSixesCount: saved.consecutiveSixesCount,
        currentDiceRoll: saved.currentDiceRoll,
        turnCount: saved.turnCount,
        currentPlayerIndex: saved.currentPlayerIndex,
        playerTypes,
        botPersonalities,
        playerNames,
        playerTokenPositions: saved.positions,
        playerRanks: saved.ranksArr,
        playerTimes: saved.timesArr,
        playerCaptures: saved.capturesArr,
    });

    setTurnCount(state.turnCount);
    setPlayerNames(state.playerNames);

    showGame();

    const containersToRestack = new Set();
    state.playerTypes.forEach((playerType, playerIndex) => {
        if (!playerType || !state.playerTokenPositions[playerIndex]) return;
        state.playerTokenPositions[playerIndex].forEach((pos, tokenIndex) => {
            const token = document.createElement("wc-token");
            token.setAttribute("id", getTokenElementId(playerIndex, tokenIndex));
            const containerId = getTokenContainerId(playerIndex, tokenIndex, pos);
            const container = document.getElementById(containerId);
            if (container) {
                container.appendChild(token);
                containersToRestack.add(container);
            }
        });
    });
    containersToRestack.forEach(cell => updateCellStacking(cell));

    if (shouldEndGame(state.playerTypes, state.playerTokenPositions)) {
        document.getElementById("game-container").appendChild(document.createElement("wc-game-end"));
        document.getElementById("game").classList.add("hidden");
        releaseWakeLock();
        return;
    }

    if (isPlayerFinishedPure(state.playerTokenPositions[state.currentPlayerIndex])) {
        advanceToNextPlayer(emit);
    }

    moveDice(state.currentPlayerIndex);
}

function rollDice(emit) {
    if (isGameLogicPaused()) return;
    if (!canRoll()) return;
    emit({ type: EVENTS.DICE_ROLL_STARTED });
    return animateDiceRoll(state.currentDiceRoll)
        .then(() => {
            const lastDiceRoll = state.currentDiceRoll;
            const newRoll = generateDiceRoll();
            emit({ type: EVENTS.DICE_ROLLED, value: newRoll });
            updateDiceFace(lastDiceRoll, state.currentDiceRoll);
            handleAfterDiceRoll(emit);
        });
}

function handleAfterDiceRoll(emit) {
    if (state.consecutiveSixesCount === 3) {
        emit({ type: EVENTS.THREE_SIXES_LOST });
        advanceToNextPlayer(emit);
        return;
    }

    const movableTokenIndexes = [];
    state.playerTokenPositions[state.currentPlayerIndex].forEach((tokenPosition, tokenIndex) => {
        if (isTokenMovable(tokenPosition, state.currentDiceRoll)) {
            activateToken(state.currentPlayerIndex, tokenIndex);
            movableTokenIndexes.push(tokenIndex);
        }
    });

    if (movableTokenIndexes.length === 0) {
        advanceToNextPlayer(emit);
        return;
    }

    inactiveDice();
    emit({
        type: EVENTS.MOVABLE_TOKENS_DETERMINED,
        playerIndex: state.currentPlayerIndex,
        tokenIndexes: movableTokenIndexes,
    });
}

async function selectToken(playerIndex, tokenIndex, emit) {
    if (isGameLogicPaused()) return;
    if (!canSelectToken(tokenIndex)) return;
    try {
        inactiveTokens();

        const tokenOldPosition = state.playerTokenPositions[state.currentPlayerIndex][tokenIndex];
        const tokenNewPosition = getTokenNewPosition(tokenOldPosition, state.currentDiceRoll);

        emit({
            type: EVENTS.TOKEN_MOVED,
            playerIndex: state.currentPlayerIndex,
            tokenIndex,
            fromPosition: tokenOldPosition,
            toPosition: tokenNewPosition,
        });

        const tripComplete = isTripComplete(tokenNewPosition);

        const otherPlayerTokensOnThatMarkIndex = findCapturedOpponents(playerIndex, tokenNewPosition, state.playerTokenPositions);
        for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
            for (const ti of pt) {
                const t = getTokenElement(pi, ti);
                if (t) t.dataset.moving = 'true';
            }
        }

        await updateTokenContainer(playerIndex, tokenIndex, tokenOldPosition, tokenNewPosition);

        let captureCount = 0;
        for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
            for (const ti of pt) {
                const capturedToken = getTokenElement(pi, ti);
                const capturedSvg = capturedToken?.children[0];
                if (capturedSvg) {
                    capturedSvg.classList.add("token-captured");
                    await new Promise(r => setTimeout(r, 320));
                    capturedSvg.classList.remove("token-captured");
                }
                const capturedFromPos = state.playerTokenPositions[pi][ti];
                emit({
                    type: EVENTS.TOKEN_CAPTURED,
                    byPlayerIndex: state.currentPlayerIndex,
                    capturedPlayerIndex: pi,
                    capturedTokenIndex: ti,
                });
                await updateTokenContainer(pi, ti, capturedFromPos, -1);
                captureCount++;
            }
        }

        handleAfterTokenMove(tripComplete, captureCount, emit);
    } finally {
        releaseInputLock();
    }
}

function handleAfterTokenMove(tripComplete, captureCount, emit) {
    let isGameDone = false;
    if (tripComplete && isPlayerFinished(state.currentPlayerIndex)) {
        const finishTime = new Date().getTime() - state.gameStartedAt;
        emit({
            type: EVENTS.PLAYER_FINISHED,
            playerIndex: state.currentPlayerIndex,
            rank: state.lastRank + 1,
            time: finishTime,
        });

        if (shouldEndGame(state.playerTypes, state.playerTokenPositions)) {
            const now = new Date().getTime();
            const leftover = computeLeftoverRankOrder(state.playerTypes, state.playerTokenPositions, state.playerRanks);
            for (const pi of leftover) {
                emit({
                    type: EVENTS.LEFTOVER_RANKED,
                    playerIndex: pi,
                    rank: state.lastRank + 1,
                    time: now - state.gameStartedAt,
                });
            }
            emit({ type: EVENTS.GAME_ENDED, winnerIndex: state.winnerIndex });

            document.getElementById("game-container").appendChild(document.createElement("wc-game-end"));
            document.getElementById("game").classList.add("hidden");
            releaseWakeLock();
            isGameDone = true;
        }
    }

    if (isGameDone) return;

    activateDice();
    if (!tripComplete && captureCount === 0 && state.currentDiceRoll !== 6) {
        advanceToNextPlayer(emit);
    } else {
        emit({ type: EVENTS.TURN_REPEATS, playerIndex: state.currentPlayerIndex });
    }
}

function advanceToNextPlayer(emit) {
    const next = getNextPlayerIndex(state.currentPlayerIndex, state.playerTypes, state.playerTokenPositions);
    if (next !== -1) {
        emit({ type: EVENTS.TURN_ADVANCED, nextPlayerIndex: next });
    }
    updateTurnCounter();
    moveDice(state.currentPlayerIndex);
}

function restartGame(emit) {
    const quickStartId = state.quickStartId;
    if (!quickStartId) return;
    const namesByPlayerIndex = Array.from(state.playerNames);

    const gameEnd = document.querySelector('wc-game-end');
    if (gameEnd) gameEnd.remove();

    document.querySelectorAll('wc-token').forEach(t => t.remove());
    clearTokenElementCache();

    document.getElementById('game').classList.remove('hidden');

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#EFE9DC');
    document.body.style.background = '';

    startGame(quickStartId, namesByPlayerIndex, emit);
}

function handleGamePause(emit) {
    if (isGameLogicPaused()) return;
    pauseGameLogic();
    emit({ type: EVENTS.GAME_PAUSED });
    showPauseMenu();

    const overlay = document.getElementById("pause-menu");
    const resumeBtn = document.getElementById("pm-resume");
    const exitBtns = Array.from(document.querySelectorAll(".restart-game"));

    const cleanup = () => {
        resumeBtn.removeEventListener("click", onResume);
        document.removeEventListener("keydown", onKey);
        overlay.removeEventListener("click", onBackdrop);
        exitBtns.forEach(el => el.removeEventListener("click", onExit));
    };
    const onResume = () => {
        playClickSound();
        cleanup();
        resumeGame();
        resumeGameLogic();
        emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
    };
    const onKey = (e) => { if (e.key === "Escape") onResume(); };
    const onBackdrop = (e) => { if (e.target === overlay) onResume(); };
    const onExit = () => {
        playClickSound();
        cleanup();
        releaseWakeLock();
        window.location.href = window.location.origin;
    };

    resumeBtn.addEventListener("click", onResume);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onBackdrop);
    exitBtns.forEach(el => el.addEventListener("click", onExit));
}

// --- public selectors ---

export function getCurrentPlayerIndex() { return state.currentPlayerIndex; }
export function getIsLocalMultiplayer() {
    let humans = 0, defined = 0;
    for (let i = 0; i < 4; i++) {
        if (state.playerTypes[i]) defined++;
        if (state.playerTypes[i] === 'PLAYER') humans++;
    }
    return defined >= 2 && humans === defined;
}
export function getFinishedCount(playerIndex) {
    return getFinishedCountPure(state.playerTokenPositions[playerIndex]);
}

export function clearSavedGame() {
    try { localStorage.removeItem('ludo-save'); }
    catch (e) { console.warn('clearSavedGame failed', e); }
}

export function getSavedGame() {
    return deserializeGameState(localStorage.getItem('ludo-save'));
}

// --- the command handler entry point ---

export function commandHandler(currentState, command, services, emit) {
    switch (command.type) {
        case COMMANDS.START_GAME:
            return startGame(command.quickStartId, command.namesByPlayerIndex, emit);
        case COMMANDS.RESUME_SAVED_GAME:
            return resumeSavedGame(emit);
        case COMMANDS.ROLL_DICE:
            return rollDice(emit);
        case COMMANDS.SELECT_TOKEN:
            return selectToken(command.playerIndex, command.tokenIndex, emit);
        case COMMANDS.PAUSE:
            return handleGamePause(emit);
        case COMMANDS.RESUME:
            resumeGameLogic();
            emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
            return;
        case COMMANDS.RESTART_GAME:
            return restartGame(emit);
        case COMMANDS.SET_ASSIST_FLAG:
            return emit({ type: EVENTS.ASSIST_FLAG_CHANGED, flag: command.flag, value: command.value });
        default:
            console.warn('Unknown command:', command.type);
            return;
    }
}
