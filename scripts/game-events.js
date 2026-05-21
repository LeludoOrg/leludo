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
    getTokenNewPosition, getUniqueTokenPositions,
    inactiveDice,
    inactiveTokens,
    isTokenMovable,
    isTripComplete,
    moveDice,
    playCaptureSound,
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
    getTurnCount,
    setTurnCount,
    initRailDeps,
    setPlayerNames,
} from "./index.js";
import { pickBestMove, PERSONALITIES, randomPersonality } from "./bot-ai.js";
import {
    isPlayerFinished as isPlayerFinishedPure,
    allTokensInHome as allTokensInHomePure,
    getFinishedCount as getFinishedCountPure,
    selectStartingPlayer,
    getNextPlayerIndex,
    shouldEndGame,
    computeLeftoverRankOrder,
    serializeGameState,
    deserializeGameState,
} from "./turn-rules.js";

/**
 * @typedef {'PLAYER'|'BOT'} PlayerType
 */

let currentPlayerIndex = 2;
let currentDiceRoll = 1;
let consecutiveSixesCount = 0
let inputLockDepth = 0;
let inputLockOverlay = null;

function ensureInputLockOverlay() {
    if (inputLockOverlay) return inputLockOverlay;
    inputLockOverlay = document.createElement('div');
    inputLockOverlay.id = 'input-lock-overlay';
    inputLockOverlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:transparent;pointer-events:auto;display:none;';
    document.body.appendChild(inputLockOverlay);
    return inputLockOverlay;
}

export function isInputLocked() {
    return inputLockDepth > 0;
}

export function acquireInputLock() {
    inputLockDepth++;
    if (inputLockDepth === 1) {
        ensureInputLockOverlay().style.display = 'block';
    }
}

export function releaseInputLock() {
    if (inputLockDepth === 0) return;
    inputLockDepth--;
    if (inputLockDepth === 0 && inputLockOverlay) {
        inputLockOverlay.style.display = 'none';
    }
}

export function resetInputLock() {
    inputLockDepth = 0;
    if (inputLockOverlay) inputLockOverlay.style.display = 'none';
}

let _paused = false;
let _pendingResume = null;
const _pendingTimers = new Set();

function scheduleTurn(fn, delay) {
    if (_paused) { _pendingResume = fn; return; }
    const id = setTimeout(() => {
        _pendingTimers.delete(id);
        if (_paused) { _pendingResume = fn; return; }
        fn();
    }, delay);
    _pendingTimers.add(id);
}

export function isGameLogicPaused() { return _paused; }

export function pauseGameLogic() {
    _paused = true;
    _pendingTimers.forEach(clearTimeout);
    _pendingTimers.clear();
}

export function resumeGameLogic() {
    _paused = false;
    const fn = _pendingResume;
    _pendingResume = null;
    if (fn) fn();
}

const assistFlags = {
    autoRollDice: false,
    autoMoveSingleOption: false,
    autoMoveOutOfHome: true,
}
let gameStartedAt = new Date().getTime()
let lastRank = 0

/**
 *
 * @type {PlayerType[]}
 */
export const playerTypes = new Array(4)
/**
 *
 * @type {number[]}
 */
export const playerRanks = new Array(4).fill(0)
/**
 *
 * @type {number[]}
 */
export const playerTimes = new Array(4).fill(0)
/**
 *
 * @type {number[]}
 */
export const playerCaptures = new Array(4).fill(0)
/**
 *
 * @type {string[]}
 */
export const playerNames = new Array(4).fill('')
/**
 *
 * @type {string[]}
 */
export const botPersonalities = new Array(4).fill(null)
/**
 *
 * @type {number[][]}
 */
const playerTokenPositions = new Array(4);


export function getCurrentPlayerIndex() { return currentPlayerIndex }
export function getIsLocalMultiplayer() {
    let humans = 0, defined = 0;
    for (let i = 0; i < 4; i++) {
        if (playerTypes[i]) defined++;
        if (playerTypes[i] === 'PLAYER') humans++;
    }
    return defined >= 2 && humans === defined;
}
export function getFinishedCount(playerIndex) {
    return getFinishedCountPure(playerTokenPositions[playerIndex]);
}

/**
 *
 * @returns {boolean}
 */
function isCurrentPlayerBot() {
    return playerTypes[currentPlayerIndex] === "BOT"
}

/**
 *
 * @returns {boolean}
 */
function isAutoplay() {
    return assistFlags.autoRollDice || isCurrentPlayerBot()
}

function allTokensInHome(playerIndex) {
    return allTokensInHomePure(playerTokenPositions[playerIndex])
}

/**
 *
 * @param {string} quickStartId
 */
function initPlayers(quickStartId) {
    const result = getPlayerTypes(quickStartId)
    result.playerTypes.forEach((playerType, playerIndex) => {
        playerTypes[playerIndex] = playerType
        playerTokenPositions[playerIndex] = new Array(4).fill(-1)
        botPersonalities[playerIndex] = playerType === "BOT" ? randomPersonality() : null
    })
    applyColorMap(result.colorMap)
}

/**
 * @param {number} playerIndex
 * @returns {boolean}
 */
function isPlayerFinished(playerIndex) {
    return isPlayerFinishedPure(playerTokenPositions[playerIndex])
}

function updateCurrentPlayer() {
    consecutiveSixesCount = 0
    const next = getNextPlayerIndex(currentPlayerIndex, playerTypes, playerTokenPositions)
    if (next !== -1) currentPlayerIndex = next
    updateTurnCounter()
    handlePlayerUpdated()
}


/**
 *
 * @param {string} quickStartId
 */
export function handleGameStart(quickStartId, namesByPlayerIndex) {
    if (isInputLocked()) return;
    resetInputLock();
    _quickStartId = quickStartId;
    gameStartedAt = new Date().getTime()
    resetTurnCount()
    initRailDeps(playerTypes, getCurrentPlayerIndex, getFinishedCount, getIsLocalMultiplayer)

    initPlayers(quickStartId)

    for (let i = 0; i < 4; i++) {
        playerNames[i] = (namesByPlayerIndex && namesByPlayerIndex[i]) || ''
    }
    setPlayerNames(playerNames)

    currentPlayerIndex = selectStartingPlayer(playerTypes)

    showGame();

    const params = new URLSearchParams(window.location.search)
    const initPositions = params.get("positions")?.split(",")

    const containersToRestack = new Set();
    playerTypes.forEach((playerType, playerIndex) => {
        if (playerType) {
            playerTokenPositions[playerIndex].forEach((tokenPosition, tokenIndex) => {
                const token = document.createElement("wc-token")
                token.setAttribute("id", getTokenElementId(playerIndex, tokenIndex))

                const initOverride = initPositions && initPositions[(playerIndex * 4) + tokenIndex]
                const initialPosition = initOverride !== undefined && initOverride !== '' ? +initOverride : -1
                playerTokenPositions[playerIndex][tokenIndex] = initialPosition

                const containerId = getTokenContainerId(playerIndex, tokenIndex, initialPosition)
                const targetContainer = document.getElementById(containerId)
                if (targetContainer) {
                    targetContainer.appendChild(token)
                    containersToRestack.add(targetContainer)
                }
            })
        }
    })
    containersToRestack.forEach(cell => updateCellStacking(cell));

    const player = params.get("player");
    if (player) {
        currentPlayerIndex = +player
    }

    moveDice(currentPlayerIndex)
    handleDiceMoved()
}


export function handleGamePause() {
    if (_paused) return;
    pauseGameLogic();
    showPauseMenu();

    const overlay = document.getElementById("pause-menu")
    const resumeBtn = document.getElementById("pm-resume")
    const exitBtns = Array.from(document.querySelectorAll(".restart-game"))

    const cleanup = () => {
        resumeBtn.removeEventListener("click", onResume)
        document.removeEventListener("keydown", onKey)
        overlay.removeEventListener("click", onBackdrop)
        exitBtns.forEach(el => el.removeEventListener("click", onExit))
    }
    const onResume = () => {
        playClickSound()
        cleanup()
        resumeGame()
        resumeGameLogic()
    }
    const onKey = (e) => {
        if (e.key === "Escape") onResume()
    }
    const onBackdrop = (e) => {
        if (e.target === overlay) onResume()
    }
    const onExit = async () => {
        playClickSound()
        cleanup()
        releaseWakeLock()
        window.location.href = window.location.origin
    }

    resumeBtn.addEventListener("click", onResume)
    document.addEventListener("keydown", onKey)
    overlay.addEventListener("click", onBackdrop)
    exitBtns.forEach(el => el.addEventListener("click", onExit))
}


export function handlePlayerUpdated() {
    moveDice(currentPlayerIndex)
    handleDiceMoved()
}


export function handleDiceRoll() {
    if (_paused) return;
    if (isInputLocked()) return;
    acquireInputLock();
    animateDiceRoll(currentDiceRoll)
        .then(() => {
            const lastDiceRoll = currentDiceRoll
            currentDiceRoll = generateDiceRoll();

            updateDiceFace(lastDiceRoll, currentDiceRoll);

            if (currentDiceRoll === 6) {
                consecutiveSixesCount++
            }

            handleAfterDiceRoll()
        })
        .finally(() => {
            releaseInputLock();
        });
}

function handleAfterDiceRoll() {
    if (consecutiveSixesCount === 3) {
        updateCurrentPlayer();
    } else {
        const movableTokenIndexes = [];

        playerTokenPositions[currentPlayerIndex].forEach((tokenPosition, tokenIndex) => {
            if (isTokenMovable(tokenPosition, currentDiceRoll)) {
                activateToken(currentPlayerIndex, tokenIndex);
                movableTokenIndexes.push(tokenIndex);
            }
        })


        if (movableTokenIndexes.length > 0) {
            inactiveDice();

            if (isCurrentPlayerBot()) {
                scheduleTurn(() => {
                    const uniqueTokenIndexPositions = getUniqueTokenPositions(currentPlayerIndex, movableTokenIndexes, playerTokenPositions);
                    if (uniqueTokenIndexPositions.size === 1) {
                        handleOnTokenMove(currentPlayerIndex, movableTokenIndexes[0]);
                    } else {
                        const weights = PERSONALITIES[botPersonalities[currentPlayerIndex]] || PERSONALITIES.balanced;
                        const bestMoveTokenIndex = pickBestMove(currentPlayerIndex, currentDiceRoll, playerTokenPositions, weights, 1);
                        handleOnTokenMove(currentPlayerIndex, bestMoveTokenIndex >= 0 ? bestMoveTokenIndex : movableTokenIndexes[0]);
                    }
                }, 400);
            } else {
                const uniqueTokenIndexPositions = getUniqueTokenPositions(currentPlayerIndex, movableTokenIndexes, playerTokenPositions);
                const singleOption = uniqueTokenIndexPositions.size === 1;
                const onlyHomeOut = allTokensInHome(currentPlayerIndex) && currentDiceRoll === 6;
                if ((assistFlags.autoMoveSingleOption && singleOption) ||
                    (assistFlags.autoMoveOutOfHome && onlyHomeOut)) {
                    scheduleTurn(() => handleOnTokenMove(currentPlayerIndex, movableTokenIndexes[0]), 300);
                }
            }
        } else {
            updateCurrentPlayer();
        }
    }
}


/**
 *
 * @param {number} playerIndex
 * @param {number} tokenIndex
 */
export async function handleOnTokenMove(playerIndex, tokenIndex) {
    if (_paused) return;
    if (isInputLocked()) return;
    acquireInputLock();
    try {
        inactiveTokens();

        const tokenOldPosition = playerTokenPositions[currentPlayerIndex][tokenIndex]
        const tokenNewPosition = getTokenNewPosition(playerTokenPositions[currentPlayerIndex][tokenIndex], currentDiceRoll)
        playerTokenPositions[currentPlayerIndex][tokenIndex] = tokenNewPosition

        const tripComplete = isTripComplete(tokenNewPosition)

        const otherPlayerTokensOnThatMarkIndex = findCapturedOpponents(playerIndex, tokenNewPosition, playerTokenPositions);
        for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
            for (const ti of pt) {
                const t = getTokenElement(pi, ti);
                if (t) t.dataset.moving = 'true';
            }
        }

        await updateTokenContainer(playerIndex, tokenIndex, tokenOldPosition, tokenNewPosition)

        let captureCount = 0
        for (const [pi, pt] of otherPlayerTokensOnThatMarkIndex.entries()) {
            for (const ti of pt) {
                playCaptureSound()
                const capturedToken = getTokenElement(pi, ti);
                const capturedSvg = capturedToken?.children[0];
                if (capturedSvg) {
                    capturedSvg.classList.add("token-captured");
                    await new Promise(r => setTimeout(r, 500));
                    capturedSvg.classList.remove("token-captured");
                }
                await updateTokenContainer(pi, ti, playerTokenPositions[pi][ti], -1)
                playerTokenPositions[pi][ti] = -1
                captureCount++
            }
        }

        if (captureCount > 0) {
            playerCaptures[currentPlayerIndex] += captureCount
        }

        handleAfterTokenMove(tripComplete, captureCount)
    } finally {
        releaseInputLock();
    }
}


/**
 *
 * @param {boolean} tripComplete
 * @param {number} captureCount
 */
function handleAfterTokenMove(tripComplete, captureCount) {
    let isGameDone = false;
    if (tripComplete && isPlayerFinished(currentPlayerIndex)) {
        playerRanks[currentPlayerIndex] = ++lastRank
        playerTimes[currentPlayerIndex] = new Date().getTime() - gameStartedAt

        if (shouldEndGame(playerTypes, playerTokenPositions)) {
            const now = new Date().getTime()
            computeLeftoverRankOrder(playerTypes, playerTokenPositions, playerRanks)
                .forEach(playerIndex => {
                    playerRanks[playerIndex] = ++lastRank
                    playerTimes[playerIndex] = now - gameStartedAt
                })

            document.getElementById("game-container").appendChild(document.createElement("wc-game-end"))
            document.getElementById("game").classList.add("hidden")
            releaseWakeLock()
            isGameDone = true;
        }
    }

    if (!isGameDone) {
        saveGameState();
        activateDice();

        const diceElement = document.getElementById("wc-dice");
        if (!tripComplete && captureCount === 0 && currentDiceRoll !== 6) {
            updateCurrentPlayer();
        } else {
            if (isAutoplay()) {
                scheduleTurn(() => diceElement.click(), 600)
            }
        }
    } else {
        clearSavedGame();
    }
}


function handleDiceMoved() {
    if (isAutoplay()) {
        scheduleTurn(() => handleDiceRoll(), 600)
    }
}


/**
 * @param {'autoRollDice'|'autoMoveSingleOption'|'autoMoveOutOfHome'} flag
 * @param {boolean} value
 */
export function setAssistFlag(flag, value) {
    if (flag in assistFlags) assistFlags[flag] = value
}

let _quickStartId = null;

function saveGameState() {
    if (!_quickStartId) return;
    const state = serializeGameState({
        quickStartId: _quickStartId,
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
        turnCount: getTurnCount(),
    });
    localStorage.setItem('ludo-save', JSON.stringify(state));
}

export function clearSavedGame() {
    localStorage.removeItem('ludo-save');
}

export function restartGame() {
    if (isInputLocked()) return;
    resetInputLock();

    const quickStartId = _quickStartId;
    if (!quickStartId) return;
    const namesByPlayerIndex = Array.from(playerNames);

    const gameEnd = document.querySelector('wc-game-end');
    if (gameEnd) gameEnd.remove();

    document.querySelectorAll('wc-token').forEach(t => t.remove());
    clearTokenElementCache();

    for (let i = 0; i < 4; i++) {
        playerRanks[i] = 0;
        playerTimes[i] = 0;
        playerCaptures[i] = 0;
        playerNames[i] = '';
    }
    lastRank = 0;
    consecutiveSixesCount = 0;
    currentDiceRoll = 1;

    document.getElementById('game').classList.remove('hidden');

    const themeMeta = document.querySelector('meta[name="theme-color"]');
    if (themeMeta) themeMeta.setAttribute('content', '#EFE9DC');
    document.body.style.background = '';

    handleGameStart(quickStartId, namesByPlayerIndex);
}

export function getSavedGame() {
    return deserializeGameState(localStorage.getItem('ludo-save'));
}

export function handleGameResume() {
    if (isInputLocked()) return;
    resetInputLock();
    const saved = getSavedGame();
    if (!saved) return;

    _quickStartId = saved.quickStartId;
    gameStartedAt = saved.gameStartedAt;
    lastRank = saved.lastRank;
    consecutiveSixesCount = saved.consecutiveSixesCount;
    currentDiceRoll = saved.currentDiceRoll;
    setTurnCount(saved.turnCount || 0);
    initRailDeps(playerTypes, getCurrentPlayerIndex, getFinishedCount, getIsLocalMultiplayer);

    initPlayers(saved.quickStartId);

    saved.playerTypesArr.forEach((t, i) => playerTypes[i] = t);
    if (saved.botPersonalitiesArr) {
        saved.botPersonalitiesArr.forEach((p, i) => botPersonalities[i] = p || null);
    } else {
        playerTypes.forEach((t, i) => botPersonalities[i] = t === "BOT" ? randomPersonality() : null);
    }
    (saved.playerNamesArr || []).forEach((n, i) => playerNames[i] = n || '');
    setPlayerNames(playerNames);
    saved.capturesArr.forEach((c, i) => playerCaptures[i] = c);
    saved.ranksArr.forEach((r, i) => playerRanks[i] = r);
    saved.timesArr.forEach((t, i) => playerTimes[i] = t);

    currentPlayerIndex = saved.currentPlayerIndex;

    showGame();

    const containersToRestack = new Set();
    playerTypes.forEach((playerType, playerIndex) => {
        if (playerType && saved.positions[playerIndex]) {
            saved.positions[playerIndex].forEach((pos, tokenIndex) => {
                playerTokenPositions[playerIndex][tokenIndex] = pos;
                const token = document.createElement("wc-token");
                token.setAttribute("id", getTokenElementId(playerIndex, tokenIndex));
                const containerId = getTokenContainerId(playerIndex, tokenIndex, pos);
                const container = document.getElementById(containerId);
                if (container) {
                    container.appendChild(token);
                    containersToRestack.add(container);
                }
            });
        }
    });
    containersToRestack.forEach(cell => updateCellStacking(cell));

    if (shouldEndGame(playerTypes, playerTokenPositions)) {
        document.getElementById("game-container").appendChild(document.createElement("wc-game-end"));
        document.getElementById("game").classList.add("hidden");
        releaseWakeLock();
        clearSavedGame();
        return;
    }

    if (isPlayerFinishedPure(playerTokenPositions[currentPlayerIndex])) {
        updateCurrentPlayer();
    }

    moveDice(currentPlayerIndex);
    handleDiceMoved();
}