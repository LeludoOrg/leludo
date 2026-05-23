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
    pinTokenForCapture,
    animateCaptureToHome,
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
import { goTo, replaceTo, back as navBack, registerScreenHandler } from "./nav-history.js";
import { dispatch } from "./game-store.js";

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
    EXIT_TO_HOME: 'EXIT_TO_HOME',
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
        goTo('game-end');
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
            if (t) pinTokenForCapture(t);
        }
    }

    await updateTokenContainer(playerIndex, tokenIndex, tokenOldPosition, tokenNewPosition);

    let captureCount = 0;
    for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
        for (const ti of pt) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: state.currentPlayerIndex,
                capturedPlayerIndex: pi,
                capturedTokenIndex: ti,
            });
            await animateCaptureToHome(pi, ti);
            captureCount++;
        }
    }

    handleAfterTokenMove(tripComplete, captureCount, emit);
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
            goTo('game-end');
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

    replaceTo('game');
    startGame(quickStartId, namesByPlayerIndex, emit);
}

function exitToHome(emit) {
    pauseGameLogic();

    const gameEnd = document.querySelector('wc-game-end');
    if (gameEnd) gameEnd.remove();

    document.querySelectorAll('wc-token').forEach(t => t.remove());
    clearTokenElementCache();

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#EFE9DC');
    document.body.style.background = '';

    document.getElementById('game').classList.add('hidden');
    const pauseMenu = document.getElementById('pause-menu');
    if (pauseMenu) pauseMenu.classList.add('hidden');
    const settingsOverlay = document.getElementById('settings-overlay');
    if (settingsOverlay) settingsOverlay.classList.add('hidden');

    releaseWakeLock();

    emit({ type: EVENTS.GAME_RESTARTED });

    document.getElementById('main-menu').classList.remove('hidden');
    const quickStart = document.querySelector('wc-quick-start');
    if (quickStart && typeof quickStart.showHomeScreen === 'function') {
        quickStart.showHomeScreen();
    }

    replaceTo('home');
    resumeGameLogic();
}

let _pauseCloseHandler = null;

function handleGamePause(emit) {
    if (isGameLogicPaused()) return;
    pauseGameLogic();
    emit({ type: EVENTS.GAME_PAUSED });
    showPauseMenu();
    goTo('pause');

    const overlay = document.getElementById("pause-menu");
    const resumeBtn = document.getElementById("pm-resume");
    const exitBtns = Array.from(document.querySelectorAll(".restart-game"));

    const cleanup = () => {
        resumeBtn.removeEventListener("click", onResumeClick);
        document.removeEventListener("keydown", onKey);
        overlay.removeEventListener("click", onBackdrop);
        exitBtns.forEach(el => el.removeEventListener("click", onExitClick));
    };
    const closeAndResume = () => {
        cleanup();
        _pauseCloseHandler = null;
        resumeGame();
        resumeGameLogic();
        emit({ type: EVENTS.GAME_RESUMED_FROM_PAUSE });
    };
    const onResumeClick = () => { playClickSound(); navBack(); };
    const onKey = (e) => { if (e.key === "Escape") { playClickSound(); navBack(); } };
    const onBackdrop = (e) => { if (e.target === overlay) { playClickSound(); navBack(); } };
    const onExitClick = () => {
        playClickSound();
        cleanup();
        _pauseCloseHandler = null;
        exitToHome(emit);
    };

    _pauseCloseHandler = closeAndResume;

    resumeBtn.addEventListener("click", onResumeClick);
    document.addEventListener("keydown", onKey);
    overlay.addEventListener("click", onBackdrop);
    exitBtns.forEach(el => el.addEventListener("click", onExitClick));
}

registerScreenHandler('pause', () => {
    if (_pauseCloseHandler) _pauseCloseHandler();
});

registerScreenHandler('game-end', () => {
    dispatch({ type: COMMANDS.EXIT_TO_HOME });
});

registerScreenHandler('__game_back__', () => {
    dispatch({ type: COMMANDS.PAUSE });
});

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
        case COMMANDS.EXIT_TO_HOME:
            return exitToHome(emit);
        case COMMANDS.SET_ASSIST_FLAG:
            return emit({ type: EVENTS.ASSIST_FLAG_CHANGED, flag: command.flag, value: command.value });
        default:
            console.warn('Unknown command:', command.type);
            return;
    }
}
