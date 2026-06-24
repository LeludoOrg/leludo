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
    getContainerPath,
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
    // Online counterpart of PAUSE: a live match can't be paused (the server plays
    // on), so the in-game menu button instead asks to LEAVE — a confirmation with
    // a countdown that drops our socket so the others see a disconnect while we
    // decide. See handleOnlineExit.
    ONLINE_EXIT: 'ONLINE_EXIT',
    EXIT_TO_HOME: 'EXIT_TO_HOME',
    SET_ASSIST_FLAG: 'SET_ASSIST_FLAG',
    GOD_TELEPORT: 'GOD_TELEPORT',
    // Online (multiplayer) — server-driven render commands. NET_START_GAME
    // mounts the board from a server snapshot. NET_APPLY_ROLL / NET_APPLY_MOVE
    // play the frame's cosmetic delta (dice spin, pawn glide, capture flight)
    // using ONLY the server's payload; NET_SYNC_STATE then applies the frame's
    // full authoritative snapshot — board, phase, turn, dice, movable tokens —
    // unconditionally. No guard (pause, phase, movability) may drop a server
    // frame: the server already validated it, and a dropped frame is exactly
    // how clients used to drift apart for a turn or more.
    NET_START_GAME: 'NET_START_GAME',
    NET_APPLY_ROLL: 'NET_APPLY_ROLL',
    NET_APPLY_MOVE: 'NET_APPLY_MOVE',
    NET_SYNC_STATE: 'NET_SYNC_STATE',
    // A peer's reconnect window expired: clear their forfeited pawns. NET_END
    // mounts the end screen when the server declares the game over (finish or
    // disconnect — the client makes no end-of-game decisions of its own).
    NET_DROP_PLAYER: 'NET_DROP_PLAYER',
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

// Online: replay the server's dice roll as a visual. The value is the server's
// — never rolled locally — and NOTHING may drop the frame: not the pause flag
// (settings open while the server plays on), not a stale local phase. The
// trailing NET_SYNC_STATE makes the dice/turn state authoritative either way;
// this just spins the die so the player sees the roll happen.
async function netApplyRoll(value, animate, emit) {
    inactiveTokens();
    const lastFace = state.currentDiceRoll;
    emit({ type: EVENTS.DICE_ROLL_STARTED });
    if (animate) await animateDiceRoll(lastFace);
    emit({ type: EVENTS.DICE_ROLLED, value });
    updateDiceFace(lastFace, state.currentDiceRoll);
    setLastRoll(state.currentPlayerIndex, state.currentDiceRoll);
}

// Online: replay the server's move — player, token, path AND captures all come
// from the frame payload (msg.p/token/from/to/caps), never re-derived from the
// local board (re-deriving captures was a desync source: a drifted board sent
// the wrong pawns home until the next snapshot corrected it, a visible glitch).
// With animate=false (catch-up replay of a backlog) only state is updated and
// capture events stay silent; the trailing snapshot sync snaps the DOM once.
async function netApplyMove({ playerIndex, tokenIndex, fromPosition, toPosition, captures = [], animate }, emit) {
    inactiveTokens();
    inactiveDice();
    emit({
        type: EVENTS.TOKEN_MOVED,
        playerIndex,
        tokenIndex,
        fromPosition,
        toPosition,
    });

    const el = getTokenElement(playerIndex, tokenIndex);
    if (animate && el) {
        for (const c of captures) {
            const t = getTokenElement(c.playerIndex, c.tokenIndex);
            if (t) pinTokenForCapture(t);
        }
        await updateTokenContainer(playerIndex, tokenIndex, fromPosition, toPosition);
        const prevPos = toPosition > 0 ? toPosition - 1 : toPosition;
        const attack = {
            attackerPlayerIndex: playerIndex,
            attackerTokenIndex: tokenIndex,
            prevCellId: getTokenContainerId(playerIndex, tokenIndex, prevPos),
        };
        for (const c of captures) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: playerIndex,
                capturedPlayerIndex: c.playerIndex,
                capturedTokenIndex: c.tokenIndex,
            });
            await animateCaptureToHome(c.playerIndex, c.tokenIndex, attack);
        }
    } else {
        for (const c of captures) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: playerIndex,
                capturedPlayerIndex: c.playerIndex,
                capturedTokenIndex: c.tokenIndex,
                silent: true, // catch-up: no capture sound burst
            });
        }
    }

    // The move finished this player's last pawn: record rank + finish time so
    // the end screen shows them (the rank is overwritten by the authoritative
    // snapshot that follows; the locally-measured time is all we have).
    if (isTripComplete(toPosition) && isPlayerFinished(playerIndex)) {
        emit({
            type: EVENTS.PLAYER_FINISHED,
            playerIndex,
            rank: state.lastRank + 1,
            time: new Date().getTime() - state.gameStartedAt,
        });
    }
}

// True when every active player's token elements sit in the cells the state
// says they should — i.e. the rendered board matches the (just-synced)
// authoritative positions. Inactive seats must have NO token elements left.
function tokenDomMatchesState() {
    for (let pi = 0; pi < 4; pi++) {
        const row = state.playerTokenPositions[pi];
        const active = !!state.playerTypes[pi] && !!row;
        for (let ti = 0; ti < 4; ti++) {
            const el = document.getElementById(getTokenElementId(pi, ti));
            if (!active) {
                if (el) return false; // ghost pawn of a forfeited seat
                continue;
            }
            if (!el || !el.parentElement) return false;
            if (el.parentElement.id !== getTokenContainerId(pi, ti, row[ti])) return false;
        }
    }
    return true;
}

// Online: apply the server's full authoritative snapshot — the last word after
// every frame. State first (reducer), then repaint everything derived from it:
// turn label, dice face/corner, board DOM (re-mounted only when drifted), and
// the roll/move affordances. Runs even while paused; the pause overlay only
// blocks local input, never the server's game.
function netSyncState(cmd, emit) {
    if (state.phase === PHASES.GAME_ENDED) return;

    const prevFace = state.currentDiceRoll;
    emit({
        type: EVENTS.NET_STATE_SYNCED,
        positions: cmd.positions,
        playerTypes: cmd.playerTypes,
        currentPlayerIndex: cmd.currentPlayerIndex,
        turnCount: cmd.turnCount,
        dice: cmd.dice,
        phase: cmd.phase,
        legalMoves: cmd.legalMoves,
        captures: cmd.captures,
        ranks: cmd.ranks,
    });

    setTurnCount(state.turnCount);
    if (cmd.dice > 0 && cmd.dice !== prevFace) updateDiceFace(prevFace, cmd.dice);
    moveDice(state.currentPlayerIndex);

    // Snap any drifted token (or ghost pawn) back onto the truth. No-op in the
    // common case, so it never fights the move animation it runs after.
    if (!tokenDomMatchesState()) {
        removeGameTokens();
        mountTokensFromState();
    }

    // Re-derive the input affordances from the authoritative phase. This is
    // what un-sticks a client that reconnected mid-AWAIT_MOVE (it used to come
    // back stuck AWAITING_ROLL: its roll intents were rejected, the server
    // waited for a move it could never send, and the whole room hung). A
    // DROPPED frame can point currentPlayerIndex at the just-stripped seat for
    // one frame — nothing to activate then; the follow-up frame re-arms.
    inactiveTokens();
    if (!state.playerTypes[state.currentPlayerIndex]) return;
    if (state.phase === PHASES.AWAITING_SELECTION) {
        inactiveDice();
        for (const ti of state.movableTokenIndexes) {
            if (getTokenElement(state.currentPlayerIndex, ti)) {
                activateToken(state.currentPlayerIndex, ti);
            }
        }
    } else if (state.phase === PHASES.AWAITING_ROLL) {
        activateDice();
    }
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

// Online: the server declared the game over. Apply the final ranks and mount
// the end screen — mirrors the tail of handleAfterTokenMove.
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

function rollDice(emit) {
    if (isGameLogicPaused()) return;
    if (!canRoll()) return;
    emit({ type: EVENTS.DICE_ROLL_STARTED });
    return animateDiceRoll(state.currentDiceRoll)
        .then(() => {
            const lastDiceRoll = state.currentDiceRoll;
            const pi = state.currentPlayerIndex;
            const hasTokenAtHome = state.playerTokenPositions[pi].includes(-1);
            const newRoll = rollDiceWithPity(state.noMoveStreak[pi], hasTokenAtHome, Math.random, state.consecutiveSixesCount);
            emit({ type: EVENTS.DICE_ROLLED, value: newRoll });
            updateDiceFace(lastDiceRoll, state.currentDiceRoll);
            setLastRoll(state.currentPlayerIndex, state.currentDiceRoll);
            handleAfterDiceRoll(emit);
        });
}

function handleAfterDiceRoll(emit) {
    // rollDiceWithPity caps the streak at two (the would-be third six becomes a
    // 1..5 roll), so this bust is an unreachable backstop kept as a guard.
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
    const fromPosition = state.playerTokenPositions[playerIndex][tokenIndex];
    const targetCell = document.getElementById(getTokenContainerId(playerIndex, tokenIndex, toPosition));
    if (!targetCell) return;

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

    // Forward teleports walk the player's path cell-by-cell, identical to a
    // normal turn: updateTokenContainer plays the yard launch, the per-step
    // glide + step sound, and the finish-cell arrival overlay for us. Backward
    // / same-cell teleports have no normal-game analog (getContainerPath builds
    // no reverse path, so the glide would be a no-op), so they snap in place.
    if (getContainerPath(playerIndex, tokenIndex, fromPosition, toPosition).length > 0) {
        await updateTokenContainer(playerIndex, tokenIndex, fromPosition, toPosition);
        emit({ type: EVENTS.GOD_TELEPORTED, playerIndex, tokenIndex, toPosition });
    } else {
        // Drop inline stacking styles so the moved token settles cleanly into
        // its new cell's flow before updateCellStacking re-applies them.
        token.style.cssText = '';
        delete token.dataset.moving;
        targetCell.appendChild(token);
        emit({ type: EVENTS.GOD_TELEPORTED, playerIndex, tokenIndex, toPosition });
        if (sourceCell && sourceCell !== targetCell) updateCellStacking(sourceCell);
        updateCellStacking(targetCell);
    }

    // Mirror selectToken: drive the KO arc from the attacker's penultimate
    // cell so the punch comes from the direction it actually moved.
    const prevPos = toPosition > 0 ? toPosition - 1 : toPosition;
    const attack = {
        attackerPlayerIndex: playerIndex,
        attackerTokenIndex: tokenIndex,
        prevCellId: getTokenContainerId(playerIndex, tokenIndex, prevPos),
    };
    for (const [pi, tis] of capturedByPlayer.entries()) {
        for (const ti of tis) {
            emit({
                type: EVENTS.TOKEN_CAPTURED,
                byPlayerIndex: playerIndex,
                capturedPlayerIndex: pi,
                capturedTokenIndex: ti,
            });
            await animateCaptureToHome(pi, ti, attack);
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

// How long the exit confirmation stays open before it leaves on its own. Long
// enough to reconsider, matched to the server's reconnect grace (60s in prod —
// see RECONNECT_GRACE_MS in server/cf/room-do.js) so "Stay" can reel us back in
// for the whole window. An `?exitCountdown=` query param (seconds) shortens it
// for e2e.
const EXIT_COUNTDOWN_MS = (() => {
    try {
        const s = Number(new URLSearchParams(location.search).get('exitCountdown'));
        if (Number.isFinite(s) && s > 0) return Math.round(s * 1000);
    } catch { /* non-browser */ }
    return 60_000;
})();

/**
 * Online "leave the match" flow — the in-game menu button when online. A live
 * server game can't be paused, so instead of the pause menu we confirm the
 * leave with a countdown. Opening it DROPS our socket (suspend), so to everyone
 * else we're a disconnected player: the game holds on our turn and dims our
 * pawns, exactly as a network drop would. "Stay" reopens the socket (the server
 * reconnects us, cancelling the forfeit); "Leave" — or the countdown expiring —
 * exits to home with the socket still down, so the seat forfeits through the
 * SAME reconnect-grace path, releasing the room once everyone has gone.
 */
function handleOnlineExit(emit) {
    // Safety net: never reachable offline (the board only dispatches this online),
    // but if it is, fall back to the normal pause.
    if (!isOnlineActive()) return handleGamePause(emit);

    const overlay = document.getElementById("online-exit-menu");
    const net = onlineNet();
    // Headless / missing markup: nothing to confirm against, just leave.
    if (!overlay) { try { net?.suspend(); } catch { /* ignore */ } return exitToHome(emit); }

    // Behave like a disconnection to the others for as long as we're deciding.
    try { net?.suspend(); } catch { /* ignore */ }

    const stayBtn = document.getElementById("oe-stay");
    const leaveBtn = document.getElementById("oe-leave");
    const countdownEl = document.getElementById("oe-countdown");
    overlay.classList.remove("hidden");
    goTo(SCREENS.PAUSE);

    const endAt = Date.now() + EXIT_COUNTDOWN_MS;
    const renderCountdown = () => {
        const secs = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
        if (countdownEl) countdownEl.textContent = String(secs);
    };
    renderCountdown();

    let interval = setInterval(renderCountdown, 250);
    let timer = setTimeout(() => leave(), EXIT_COUNTDOWN_MS);

    const cleanup = () => {
        if (interval) { clearInterval(interval); interval = null; }
        if (timer) { clearTimeout(timer); timer = null; }
        stayBtn?.removeEventListener("click", onStayClick);
        leaveBtn?.removeEventListener("click", onLeaveClick);
        overlay.removeEventListener("click", onBackdrop);
        document.removeEventListener("keydown", onKey);
        overlay.classList.add("hidden");
    };
    // Stay: reel the socket back in (server treats it as a reconnect) and resume.
    const stay = () => {
        cleanup();
        _pauseCloseHandler = null;
        try { net?.resume(); } catch { /* ignore */ }
    };
    // Leave for good: socket stays down, so the seat forfeits via grace server-side.
    const leave = () => {
        cleanup();
        _pauseCloseHandler = null;
        exitToHome(emit);
    };

    const onStayClick = () => { playClickSound(); navBack(); };
    const onLeaveClick = () => { playClickSound(); leave(); };
    const onBackdrop = (e) => { if (e.target === overlay) { playClickSound(); navBack(); } };
    const onKey = (e) => { if (e.key === "Escape") { playClickSound(); navBack(); } };

    // Back / Escape / backdrop all mean "Stay" (the safe choice); leaving is the
    // explicit button or the timeout.
    _pauseCloseHandler = stay;
    stayBtn?.addEventListener("click", onStayClick);
    leaveBtn?.addEventListener("click", onLeaveClick);
    overlay.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
}

registerScreenHandler(SCREENS.PAUSE, () => {
    if (_pauseCloseHandler) _pauseCloseHandler();
});

registerScreenHandler(SCREENS.GAME_END, () => {
    dispatch({ type: COMMANDS.EXIT_TO_HOME });
});

registerScreenHandler(GAME_BACK_ACTION, () => {
    // Online has no pause — back from a live match opens the leave confirmation.
    dispatch({ type: isOnlineActive() ? COMMANDS.ONLINE_EXIT : COMMANDS.PAUSE });
});

// --- public selectors ---

export function getCurrentPlayerIndex() { return state.currentPlayerIndex; }
export function getFinishedCount(playerIndex) {
    return getFinishedCountPure(state.playerTokenPositions[playerIndex]);
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
        case COMMANDS.NET_APPLY_ROLL:
            return netApplyRoll(command.value, command.animate !== false, emit);
        case COMMANDS.NET_APPLY_MOVE:
            return netApplyMove(command, emit);
        case COMMANDS.NET_SYNC_STATE:
            return netSyncState(command, emit);
        case COMMANDS.NET_DROP_PLAYER:
            return netDropPlayer(command.playerIndex, emit);
        case COMMANDS.NET_END:
            return netEnd(command.playerRanks, command.winnerIndex, emit);
        case COMMANDS.ROLL_DICE:
            return rollDice(emit);
        case COMMANDS.SELECT_TOKEN:
            return selectToken(command.playerIndex, command.tokenIndex, emit);
        case COMMANDS.PAUSE:
            return handleGamePause(emit);
        case COMMANDS.ONLINE_EXIT:
            return handleOnlineExit(emit);
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
