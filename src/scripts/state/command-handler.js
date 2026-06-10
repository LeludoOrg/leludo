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
    rollDiceWithPity,
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
    playFinishArrival,
    playYardLaunch,
    updateDiceFace,
    updateTokenContainer,
    updateTurnCounter,
    resetTurnCount,
    setTurnCount,
    initRailDeps,
    setPlayerNames,
    setLastRoll,
    resetLastRolls,
} from "../index.js";
import { randomPersonality } from "../core/bot-ai.js";
import {
    isPlayerFinished as isPlayerFinishedPure,
    getFinishedCount as getFinishedCountPure,
    selectStartingPlayer,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
    deserializeGameState,
    grantsAnotherTurn,
} from "../core/turn-rules.js";
import { state, PHASES } from "./game-state.js";
import { EVENTS } from "./game-reducer.js";
import {
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
} from "../platform/scheduler.js";
import { goTo, replaceTo, back as navBack, registerScreenHandler } from "../platform/nav-history.js";
import { dispatch } from "./game-store.js";
import { isOnlineActive, onlineNet, onlineLocalSelf } from "../net/online-state.js";
import { STORAGE_KEYS } from "../platform/storage-keys.js";
import { SCREENS, GAME_BACK_ACTION } from "../platform/screens.js";

export {
    pauseGameLogic,
    resumeGameLogic,
    isGameLogicPaused,
    _scheduleTurnForTest,
} from "../platform/scheduler.js";

export const COMMANDS = Object.freeze({
    START_GAME: 'START_GAME',
    RESUME_SAVED_GAME: 'RESUME_SAVED_GAME',
    ROLL_DICE: 'ROLL_DICE',
    SELECT_TOKEN: 'SELECT_TOKEN',
    PAUSE: 'PAUSE',
    RESUME: 'RESUME',
    RESTART_GAME: 'RESTART_GAME',
    ONLINE_NEW_GAME: 'ONLINE_NEW_GAME',
    EXIT_TO_HOME: 'EXIT_TO_HOME',
    SET_ASSIST_FLAG: 'SET_ASSIST_FLAG',
    GOD_TELEPORT: 'GOD_TELEPORT',
    // Online (multiplayer) — server-driven render commands. NET_START_GAME
    // mounts the board from a server snapshot; NET_APPLY_ROLL/MOVE replay the
    // server's authoritative dice value + token choice through the normal path.
    NET_START_GAME: 'NET_START_GAME',
    NET_SYNC_TURN: 'NET_SYNC_TURN',
    NET_APPLY_ROLL: 'NET_APPLY_ROLL',
    NET_APPLY_MOVE: 'NET_APPLY_MOVE',
    // A peer's reconnect window expired: clear their forfeited pawns. NET_END
    // mounts the end screen when the game ends on a disconnect (no local move
    // triggered it).
    NET_DROP_PLAYER: 'NET_DROP_PLAYER',
    NET_RECONCILE: 'NET_RECONCILE',
    NET_END: 'NET_END',
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

// Mount every seated player's tokens into their current cells, then restack the
// touched cells. Shared by the offline start, the online start, and resume —
// the `playerTokenPositions` guard is a no-op for startGame (always populated)
// and required for the net/resume paths.
function mountTokensFromState() {
    const containersToRestack = new Set();
    state.playerTypes.forEach((playerType, playerIndex) => {
        if (!playerType || !state.playerTokenPositions[playerIndex]) return;
        state.playerTokenPositions[playerIndex].forEach((pos, tokenIndex) => {
            const token = document.createElement("wc-token");
            token.setAttribute("id", getTokenElementId(playerIndex, tokenIndex));
            const container = document.getElementById(getTokenContainerId(playerIndex, tokenIndex, pos));
            if (container) {
                container.appendChild(token);
                containersToRestack.add(container);
            }
        });
    });
    containersToRestack.forEach(cell => updateCellStacking(cell));
}

// Mount the end-of-game recap and hide the board. Shared by netEnd, resume, and
// the normal finish path.
function mountGameEnd() {
    document.getElementById("game-container").appendChild(document.createElement("wc-game-end"));
    document.getElementById("game").classList.add("hidden");
    releaseWakeLock();
    goTo(SCREENS.GAME_END);
}

// Defensive DOM reset for a fresh game. startGame can be reached from
// many paths (cold start, Android warm-resume, restart, exit-to-home →
// new-game) and at least one of them was leaving stale wc-token elements
// and a misplaced wc-dice behind — see issue where a "brand new game"
// rendered an extra yellow pawn on the track and an empty active-corner
// dice slot. Cleaning here makes startGame idempotent regardless of the
// caller's prior state.
// Tear down per-game DOM: the end-screen overlay and every on-board
// token, plus the element-id cache that pointed at them.
function removeGameTokens() {
    const gameEnd = document.querySelector('wc-game-end');
    if (gameEnd) gameEnd.remove();

    document.querySelectorAll('wc-token').forEach(t => t.remove());
    clearTokenElementCache();
}

// Restore the light-theme chrome (status-bar tint + page background)
// that the in-game play screen overrides.
function resetThemeChrome() {
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#EFE9DC');
    document.body.style.background = '';
}

function resetGameDom() {
    removeGameTokens();

    resetLastRolls();

    const turnEl = document.getElementById('turn-counter');
    if (turnEl) turnEl.textContent = 'Turn 0';

    const dice = document.getElementById('wc-dice');
    const diceHome = document.getElementById('dice-home');
    if (dice && diceHome && dice.parentElement !== diceHome) {
        diceHome.appendChild(dice);
    }
}

// --- command implementations ---

function startGame(quickStartId, namesByPlayerIndex, emit) {
    // Allowed from any phase — starting a new game resets the machine.
    resetGameDom();
    resetTurnCount();
    initRailDeps(state.playerTypes, getCurrentPlayerIndex, getFinishedCount);

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

    mountTokensFromState();

    moveDice(state.currentPlayerIndex);
}

// Online: mount the board from a server snapshot. Mirrors startGame, but the
// player config + positions come from the server, seats map 1:1 to colours
// (seat 0 = red…), and no local turn machinery is kicked off — the online
// driver replays the server's rolls/moves through NET_APPLY_ROLL/MOVE.
function netStartGame(payload, emit) {
    resetGameDom();
    resetTurnCount();
    initRailDeps(state.playerTypes, getCurrentPlayerIndex, getFinishedCount);
    applyColorMap(payload.colorMap || [0, 1, 2, 3]);

    const playerTypes = payload.playerTypes.map(t => t || undefined);
    const botPersonalities = payload.botPersonalities
        ? payload.botPersonalities.slice()
        : playerTypes.map(t => (t === 'BOT' ? 'balanced' : null));
    const playerNames = new Array(4).fill('');
    for (let i = 0; i < 4; i++) playerNames[i] = (payload.playerNames && payload.playerNames[i]) || '';
    const playerTokenPositions = payload.positions.map(p => (p ? p.slice() : undefined));

    emit({
        type: EVENTS.GAME_STARTED,
        quickStartId: null,
        gameStartedAt: new Date().getTime(),
        playerTypes,
        botPersonalities,
        playerNames,
        playerTokenPositions,
        currentPlayerIndex: payload.currentPlayerIndex,
    });

    setPlayerNames(state.playerNames);
    showGame();

    mountTokensFromState();

    moveDice(state.currentPlayerIndex);
}

// Online: realign the local renderer's current player to the server's. No-op
// when already in sync (the common case in 2- and 3-player games, where the
// diagonal mapping happens to preserve turn order). Repositions the dice/corner
// widgets onto the corrected seat.
function netSyncTurn(playerIndex, turnCount, emit) {
    // The server owns the turn number. Apply it on EVERY frame — unconditionally,
    // before the player-change early-return — so the "Turn N" label is identical
    // on every client even when this client's own replay missed a turn pass (and
    // even in the 2-3 player case where the diagonal mapping makes the player
    // index a no-op but the count still advanced).
    if (turnCount != null) setTurnCount(turnCount);
    if (playerIndex == null || playerIndex === state.currentPlayerIndex) return;
    emit({ type: EVENTS.NET_TURN_SYNCED, playerIndex });
    moveDice(state.currentPlayerIndex);
}

// Online: a player ran out of reconnect time and forfeited. Pull their pawns
// off the board and deactivate the seat so the renderer ignores them (the
// server has already removed them; whose-turn-it-is keeps coming from sync).
function netDropPlayer(playerIndex, emit) {
    if (playerIndex == null || !state.playerTypes[playerIndex]) return;
    const restack = new Set();
    for (let ti = 0; ti < 4; ti++) {
        const token = document.getElementById(getTokenElementId(playerIndex, ti));
        if (!token) continue;
        const cell = token.parentElement;
        token.remove();
        if (cell) restack.add(cell);
    }
    restack.forEach(cell => updateCellStacking(cell));
    emit({ type: EVENTS.NET_PLAYER_DROPPED, playerIndex });
}

// Online: reconcile the rendered board to the server's authoritative positions.
// The online renderer replays the server's roll/move deltas through the local
// engine; a dropped, rejected, or missed delta (a backgrounded tab throttling
// rAF, a 1s socket blip dropping `moved` frames, a swallowed animation error)
// would otherwise leave this client's board permanently diverged from the
// server's — captures especially, since they're re-derived locally rather than
// taken from the server's authoritative `caps`. Every server frame carries the
// full positions, so after each delta we snap any drifted token back onto the
// truth. No-op in the common case (the replay already matches), so it never
// fights the in-flight move animation it runs after; on real drift it re-mounts
// every token from the corrected state.
//
// `positions` is the server snapshot already mapped to LOCAL board indices by the
// online driver. Activation changes (a seat that forfeited / finished while we
// were away) flow through NET_DROP_PLAYER / NET_END, so a seat that's active on
// only one side is left for those paths — here we only correct token positions of
// seats both sides still consider in play.
function netReconcile(positions, emit) {
    if (!Array.isArray(positions)) return;
    if (state.phase === PHASES.GAME_ENDED) return;

    let drifted = false;
    for (let pi = 0; pi < 4 && !drifted; pi++) {
        const target = positions[pi];
        const local = state.playerTokenPositions[pi];
        if (!target || !local) continue; // activation mismatch — not our job
        for (let ti = 0; ti < 4; ti++) {
            if (target[ti] !== local[ti]) { drifted = true; break; }
        }
    }
    if (!drifted) return;

    emit({ type: EVENTS.NET_RECONCILED, positions });
    // Re-render from the corrected state: drop every on-board token and re-mount
    // from state.playerTokenPositions (now the server's truth).
    removeGameTokens();
    mountTokensFromState();
}

// Online: the server ended the game without a finishing move (an opponent left
// or the room was abandoned). Apply the server's final ranks and mount the end
// screen — mirrors the tail of handleAfterTokenMove.
function netEnd(ranks, winnerIndex, emit) {
    if (state.phase === PHASES.GAME_ENDED) return;
    emit({ type: EVENTS.NET_GAME_ENDED, playerRanks: ranks, winnerIndex });
    mountGameEnd();
}

function resumeSavedGame(emit) {
    const saved = deserializeGameState(localStorage.getItem(STORAGE_KEYS.SAVE));
    if (!saved) return;

    const playerTypes = saved.playerTypesArr.slice();
    const botPersonalities = saved.botPersonalitiesArr
        ? saved.botPersonalitiesArr.map(p => p || null)
        : playerTypes.map(t => t === "BOT" ? randomPersonality() : null);
    const playerNames = (saved.playerNamesArr || []).map(n => n || '');
    while (playerNames.length < 4) playerNames.push('');

    initRailDeps(state.playerTypes, getCurrentPlayerIndex, getFinishedCount);

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

    mountTokensFromState();

    if (shouldEndGame(state.playerTypes, state.playerTokenPositions)) {
        mountGameEnd();
        return;
    }

    if (isPlayerFinishedPure(state.playerTokenPositions[state.currentPlayerIndex])) {
        advanceToNextPlayer(emit);
    }

    moveDice(state.currentPlayerIndex);
}

// `forcedValue` is the server's authoritative dice for online play (passed by
// NET_APPLY_ROLL); offline it's null and the value is rolled locally.
function rollDice(emit, forcedValue = null) {
    if (isGameLogicPaused()) return;
    if (!canRoll()) return;
    emit({ type: EVENTS.DICE_ROLL_STARTED });
    return animateDiceRoll(state.currentDiceRoll)
        .then(() => {
            const lastDiceRoll = state.currentDiceRoll;
            const pi = state.currentPlayerIndex;
            const hasTokenAtHome = state.playerTokenPositions[pi].includes(-1);
            const newRoll = forcedValue != null
                ? forcedValue
                : rollDiceWithPity(state.noMoveStreak[pi], hasTokenAtHome);
            emit({ type: EVENTS.DICE_ROLLED, value: newRoll });
            updateDiceFace(lastDiceRoll, state.currentDiceRoll);
            setLastRoll(state.currentPlayerIndex, state.currentDiceRoll);
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
        emit({ type: EVENTS.PLAYER_STUCK });
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

    const prevPos = tokenNewPosition > 0 ? tokenNewPosition - 1 : tokenNewPosition;
    const attack = {
        attackerPlayerIndex: state.currentPlayerIndex,
        attackerTokenIndex: tokenIndex,
        prevCellId: getTokenContainerId(state.currentPlayerIndex, tokenIndex, prevPos),
    };

    let captureCount = 0;
    for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
        for (const ti of pt) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: state.currentPlayerIndex,
                capturedPlayerIndex: pi,
                capturedTokenIndex: ti,
            });
            await animateCaptureToHome(pi, ti, attack);
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

            mountGameEnd();
            isGameDone = true;
        }
    }

    if (isGameDone) return;

    activateDice();
    const grantsRepeat = grantsAnotherTurn(
        state.currentDiceRoll, captureCount, tripComplete,
        isPlayerFinished(state.currentPlayerIndex),
    );
    if (grantsRepeat) {
        emit({ type: EVENTS.TURN_REPEATS, playerIndex: state.currentPlayerIndex });
    } else {
        advanceToNextPlayer(emit);
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

    removeGameTokens();

    document.getElementById('game').classList.remove('hidden');

    resetThemeChrome();

    replaceTo(SCREENS.GAME);
    startGame(quickStartId, namesByPlayerIndex, emit);
}

function exitToHome(emit) {
    pauseGameLogic();

    removeGameTokens();

    // Reset --player-N CSS vars so the setup screen renders with the
    // default palette (seat 0 = red, etc.). applyColorMap during play
    // rotates these vars; without this reset the next setup screen
    // would show the previous game's rotated colors and the player
    // would pick "red" only to see green on the next launch.
    applyColorMap([0, 1, 2, 3]);

    resetThemeChrome();

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

    replaceTo(SCREENS.HOME);
    resumeGameLogic();
}

// Online "new game": there's no local lineup to replay (quickStartId is null
// online, so RESTART_GAME is a no-op), and a rematch needs a brand-new server
// room. Tear the game down to home — which closes the socket via GAME_RESTARTED
// — then push the online create/join screen, mirroring the home "Play online"
// path so Back from there returns home rather than the game-end recap.
function onlineNewGame(emit) {
    exitToHome(emit);
    const quickStart = document.querySelector('wc-quick-start');
    if (quickStart && typeof quickStart.showOnlineScreen === 'function') {
        quickStart.showOnlineScreen();
        goTo(SCREENS.ONLINE);
    }
}

async function godTeleport(playerIndex, tokenIndex, toPosition, emit) {
    const token = getTokenElement(playerIndex, tokenIndex);
    if (!token) return;
    const sourceCell = token.parentElement;
    const targetCellId = getTokenContainerId(playerIndex, tokenIndex, toPosition);
    const targetCell = document.getElementById(targetCellId);
    if (!targetCell) return;

    // Yard → entry transition fires the launch overlay, same as a normal
    // 6-roll release. playYardLaunch handles hide/reparent/restack itself,
    // so short-circuit before the generic teleport path runs. Entry cell is
    // a safe square so no captures are possible here.
    const yardCellId = getTokenContainerId(playerIndex, tokenIndex, -1);
    if (toPosition === 0 && sourceCell && sourceCell.id === yardCellId) {
        emit({ type: EVENTS.GOD_TELEPORTED, playerIndex, tokenIndex, toPosition });
        await playYardLaunch(playerIndex, tokenIndex, targetCellId);
        return;
    }

    // Capture detection runs BEFORE we move so findCapturedOpponents still
    // sees the doomed opponents at their pre-capture positions. Skips safe
    // squares and same-color pairs already.
    const capturedByPlayer = findCapturedOpponents(playerIndex, toPosition, state.playerTokenPositions);
    for (const [pi, tis] of capturedByPlayer.entries()) {
        for (const ti of tis) {
            const t = getTokenElement(pi, ti);
            if (t) pinTokenForCapture(t);
        }
    }

    // Snapshot the pre-teleport rect so the home-arrival overlay can slide
    // from where the pawn actually was, not from its new finish-slot home.
    const preTeleportRect = toPosition === 56 ? token.getBoundingClientRect() : null;

    // Drop inline stacking styles so the moved token settles cleanly into
    // its new cell's flow before updateCellStacking re-applies them.
    token.style.cssText = '';
    delete token.dataset.moving;
    targetCell.appendChild(token);

    emit({ type: EVENTS.GOD_TELEPORTED, playerIndex, tokenIndex, toPosition });

    if (sourceCell && sourceCell !== targetCell) updateCellStacking(sourceCell);
    updateCellStacking(targetCell);

    if (preTeleportRect) {
        await playFinishArrival(playerIndex, tokenIndex, preTeleportRect);
    }

    for (const [pi, tis] of capturedByPlayer.entries()) {
        for (const ti of tis) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: playerIndex,
                capturedPlayerIndex: pi,
                capturedTokenIndex: ti,
            });
            await animateCaptureToHome(pi, ti);
        }
    }
}

let _pauseCloseHandler = null;

function handleGamePause(emit) {
    if (isGameLogicPaused()) return;
    pauseGameLogic();
    emit({ type: EVENTS.GAME_PAUSED });
    showPauseMenu();
    goTo(SCREENS.PAUSE);

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

registerScreenHandler(SCREENS.PAUSE, () => {
    if (_pauseCloseHandler) _pauseCloseHandler();
});

registerScreenHandler(SCREENS.GAME_END, () => {
    dispatch({ type: COMMANDS.EXIT_TO_HOME });
});

registerScreenHandler(GAME_BACK_ACTION, () => {
    dispatch({ type: COMMANDS.PAUSE });
});

// --- public selectors ---

export function getCurrentPlayerIndex() { return state.currentPlayerIndex; }
export function getFinishedCount(playerIndex) {
    return getFinishedCountPure(state.playerTokenPositions[playerIndex]);
}

export function clearSavedGame() {
    try { localStorage.removeItem(STORAGE_KEYS.SAVE); }
    catch (e) { console.warn('clearSavedGame failed', e); }
}

export function getSavedGame() {
    return deserializeGameState(localStorage.getItem(STORAGE_KEYS.SAVE));
}

// --- the command handler entry point ---

export function commandHandler(currentState, command, services, emit) {
    // In online mode a human's dice/token taps are intents: send them to the
    // server and render nothing locally until the server's broadcast arrives.
    if (isOnlineActive()) {
        if (command.type === COMMANDS.ROLL_DICE) {
            if (state.phase === PHASES.AWAITING_ROLL && state.currentPlayerIndex === onlineLocalSelf()) {
                onlineNet()?.roll();
            }
            return;
        }
        if (command.type === COMMANDS.SELECT_TOKEN) {
            if (state.phase === PHASES.AWAITING_SELECTION
                && state.currentPlayerIndex === onlineLocalSelf()
                && state.movableTokenIndexes.includes(command.tokenIndex)) {
                onlineNet()?.move(command.tokenIndex);
            }
            return;
        }
    }

    switch (command.type) {
        case COMMANDS.START_GAME:
            return startGame(command.quickStartId, command.namesByPlayerIndex, emit);
        case COMMANDS.RESUME_SAVED_GAME:
            return resumeSavedGame(emit);
        case COMMANDS.NET_START_GAME:
            return netStartGame(command, emit);
        case COMMANDS.NET_SYNC_TURN:
            return netSyncTurn(command.playerIndex, command.turnCount, emit);
        case COMMANDS.NET_APPLY_ROLL:
            return rollDice(emit, command.value);
        case COMMANDS.NET_APPLY_MOVE:
            return selectToken(command.playerIndex, command.tokenIndex, emit);
        case COMMANDS.NET_DROP_PLAYER:
            return netDropPlayer(command.playerIndex, emit);
        case COMMANDS.NET_RECONCILE:
            return netReconcile(command.positions, emit);
        case COMMANDS.NET_END:
            return netEnd(command.playerRanks, command.winnerIndex, emit);
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
        case COMMANDS.ONLINE_NEW_GAME:
            return onlineNewGame(emit);
        case COMMANDS.EXIT_TO_HOME:
            return exitToHome(emit);
        case COMMANDS.SET_ASSIST_FLAG:
            return emit({ type: EVENTS.ASSIST_FLAG_CHANGED, flag: command.flag, value: command.value });
        case COMMANDS.GOD_TELEPORT:
            return godTeleport(command.playerIndex, command.tokenIndex, command.toPosition, emit);
        default:
            console.warn('Unknown command:', command.type);
            return;
    }
}
