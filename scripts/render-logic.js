import {getMarkIndex} from "./index.js";
import {playStepSound, playDiceSound, playLaunchSound, playFinishSound} from "./audio.js";
import {replaceTo} from "./nav-history.js";
import {playKOCapture} from "./ko-capture.js";
import {playHomeArrival} from "./home-arrival.js";
import {playPawnLaunch} from "./pawn-launch.js";

/**
 *
 * @param {number} playerIndex
 * @param {number} tokenIndex
 * @param {number} tokenPosition
 * @return {string}
 */
export function getTokenContainerId(playerIndex, tokenIndex, tokenPosition) {
    if (tokenPosition === -1) {
        return `h-${playerIndex}-${tokenIndex}`
    }

    if (tokenPosition > 50) {
        const safeIndex = tokenPosition % 50;
        return `p${playerIndex}s${safeIndex}`
    }

    const markIndex = getMarkIndex(playerIndex, tokenPosition)
    return `m${markIndex}`
}

/**
 *
 * @param {number} playerIndex
 * @param {number} tokenIndex
 * @returns {string}
 */
export function getTokenElementId(playerIndex, tokenIndex) {
    return `p-${playerIndex}-${tokenIndex}`;
}

const _tokenElementCache = new Map();

export function getTokenElement(playerIndex, tokenIndex) {
    const key = playerIndex * 4 + tokenIndex;
    const cached = _tokenElementCache.get(key);
    if (cached && cached.isConnected) return cached;
    const el = document.getElementById(getTokenElementId(playerIndex, tokenIndex));
    if (el) _tokenElementCache.set(key, el);
    return el;
}

export function clearTokenElementCache() {
    _tokenElementCache.clear();
    _bouncingTokens.clear();
}

/**
 *
 * @param {number} lastDiceRoll
 * @param {number} diceRoll
 */
export function updateDiceFace(lastDiceRoll, diceRoll) {
    document.getElementById(`d${lastDiceRoll}`).classList.add("hidden")
    document.getElementById(`d${diceRoll}`).classList.remove("hidden")
}

/**
 * @param {number} currentDiceRoll
 * @returns {Promise<void>}
 */
export function animateDiceRoll(currentDiceRoll) {
    playDiceSound();

    const diceContainer = document.getElementById("dice");
    diceContainer.classList.add("dice-rolling");
    diceContainer.addEventListener("animationend", () => {
        diceContainer.classList.remove("dice-rolling");
    }, { once: true });

    return new Promise(resolve => {
        let diceRoll = currentDiceRoll
        let counter = 0;
        const delays = [40, 40, 40, 50, 60, 80, 100, 140];
        let lastTime = 0;

        function tick(timestamp) {
            if (!lastTime) lastTime = timestamp;

            if (timestamp - lastTime < delays[counter]) {
                requestAnimationFrame(tick);
                return;
            }
            lastTime = timestamp;

            const lastDiceRoll = diceRoll;

            if (counter === 8) {
                updateDiceFace(lastDiceRoll, currentDiceRoll);
                resolve();
                return;
            }

            diceRoll = (diceRoll % 6) + 1;
            updateDiceFace(lastDiceRoll, diceRoll);
            counter++;
            requestAnimationFrame(tick);
        }

        requestAnimationFrame(tick);
    });
}

export function getContainerPath(playerIndex, tokenIndex, currentPosition, newPosition) {
    if ([-1, 0].includes(newPosition)) {
        return [getTokenContainerId(playerIndex, tokenIndex, newPosition)];
    }
    const path = [];
    for (let pos = currentPosition + 1; pos <= newPosition; pos++) {
        path.push(getTokenContainerId(playerIndex, tokenIndex, pos));
    }
    return path;
}

// Pin a soon-to-be-captured token absolutely at its current visual spot so it
// leaves the cell's flow. Without this, the captured token lingers as a flow
// child while the capturing token lands in the same cell — two flow tokens lay
// out side by side, shoving the lander into a second slot until the captured
// token finally animates home (the "lander sits in the cell below for a split
// second" flicker).
export function pinTokenForCapture(element) {
    const cell = element.parentElement;
    if (!cell) return;
    const cellRect = cell.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    cell.style.position = 'relative';
    element.style.position = 'absolute';
    element.style.top = `${rect.top - cellRect.top}px`;
    element.style.left = `${rect.left - cellRect.left}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
    element.dataset.moving = 'true';
}

function clearStackStyles(t) {
    t.style.removeProperty('position');
    t.style.removeProperty('width');
    t.style.removeProperty('height');
    t.style.removeProperty('top');
    t.style.removeProperty('left');
    t.style.removeProperty('right');
    t.style.removeProperty('bottom');
    t.style.removeProperty('z-index');
    t.style.removeProperty('display');
    t.style.removeProperty('margin-left');
}

function applyFinishStacking(cell, tokens) {
    const n = tokens.length;
    if (n === 0) return;
    const playerIdx = parseInt(cell.id[1], 10);
    const edge = 4;

    function place(t, alongPct, depthPct, sizePct) {
        let top, left;
        switch (playerIdx) {
            case 0: left = depthPct; top = alongPct; break;
            case 1: left = alongPct; top = depthPct; break;
            case 2: left = 100 - depthPct - sizePct; top = alongPct; break;
            case 3: left = alongPct; top = 100 - depthPct - sizePct; break;
        }
        t.style.cssText = `position:absolute;top:${top}%;left:${left}%;width:${sizePct}%;height:${sizePct}%;`;
    }

    if (n <= 3) {
        const sizeMap = [22, 22, 22, 17];
        const gapMap = [0, 0, 4, 3];
        const s = sizeMap[n];
        const g = gapMap[n];
        const totalLen = n * s + (n - 1) * g;
        const startAlong = (100 - totalLen) / 2;
        tokens.forEach((t, i) => place(t, startAlong + i * (s + g), edge, s));
        return;
    }

    const s = 17;
    const g = 3;
    const lineLen = 3 * s + 2 * g;
    const startAlong = (100 - lineLen) / 2;
    for (let i = 0; i < 3; i++) {
        place(tokens[i], startAlong + i * (s + g), edge, s);
    }
    place(tokens[3], (100 - s) / 2, edge + s + g, s);
}

export function updateCellStacking(cell) {
    if (!cell) return;
    const allTokens = Array.from(cell.querySelectorAll(':scope > wc-token'));
    // Only relayout settled tokens. A token mid-animation (moving='true') is
    // pinned position:absolute and out of flow — clearing its styles here would
    // drop it back into flow and shove/hide the settled tokens. Leave it alone.
    const tokens = allTokens.filter(t => t.dataset.moving !== 'true');
    tokens.forEach(clearStackStyles);
    const n = tokens.length;

    const badge = cell.querySelector('.stack-badge');
    if (badge) badge.remove();

    if (/^p\ds6$/.test(cell.id)) {
        applyFinishStacking(cell, tokens);
        return;
    }

    if (n <= 1) return;

    cell.style.position = 'relative';

    if (n === 2) {
        tokens[0].style.cssText += ';position:absolute;top:4%;left:4%;width:64%;height:64%;z-index:1;';
        tokens[1].style.cssText += ';position:absolute;bottom:4%;right:4%;width:64%;height:64%;z-index:2;';
    } else if (n === 3) {
        tokens[0].style.cssText += ';position:absolute;top:2%;left:50%;width:52%;height:52%;z-index:3;margin-left:-26%;';
        tokens[1].style.cssText += ';position:absolute;bottom:4%;left:0%;width:52%;height:52%;z-index:2;';
        tokens[2].style.cssText += ';position:absolute;bottom:4%;right:0%;width:52%;height:52%;z-index:2;';
    } else if (n === 4) {
        tokens[0].style.cssText += ';position:absolute;top:4%;left:4%;width:46%;height:46%;z-index:1;';
        tokens[1].style.cssText += ';position:absolute;top:4%;right:4%;width:46%;height:46%;z-index:1;';
        tokens[2].style.cssText += ';position:absolute;bottom:4%;left:4%;width:46%;height:46%;z-index:1;';
        tokens[3].style.cssText += ';position:absolute;bottom:4%;right:4%;width:46%;height:46%;z-index:1;';
    } else {
        tokens.forEach((t, i) => {
            if (i > 0) t.style.display = 'none';
        });
        tokens[0].style.cssText += ';position:absolute;inset:8%;width:84%;height:84%;z-index:1;';
        const badgeEl = document.createElement('div');
        badgeEl.className = 'stack-badge';
        badgeEl.textContent = `×${n}`;
        // All visuals (position, colors, sizing) live in wc-board.css .stack-badge.
        cell.appendChild(badgeEl);
    }
}

/**
 *
 * @param {number} playerIndex
 * @param {number} tokenIndex
 * @param {number} currentTokenPosition
 * @param {number} newTokenPosition
 * @returns {Promise<void>}
 */
function waitForTransitionEnd(el, onSettle, fallbackMs = 400) {
    let settled = false;
    const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallbackTimer);
        onSettle();
    };
    el.addEventListener('transitionend', settle, { once: true });
    const fallbackTimer = setTimeout(settle, fallbackMs);
}

function rectCenter(rect, origin) {
    return {
        x: rect.left + rect.width / 2 - origin.left,
        y: rect.top + rect.height / 2 - origin.top,
    };
}

function deriveAttackFrom(prevCell, capCell) {
    if (!prevCell || !capCell) return 'left';
    const a = prevCell.getBoundingClientRect();
    const b = capCell.getBoundingClientRect();
    const dx = (b.left + b.width / 2) - (a.left + a.width / 2);
    const dy = (b.top + b.height / 2) - (a.top + a.height / 2);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'left' : 'right';
    return dy >= 0 ? 'top' : 'bottom';
}

function readTokenColor(playerIndex, tokenIndex, fallback) {
    const el = getTokenElement(playerIndex, tokenIndex);
    if (!el) return fallback;
    // `.player-fg-N` lives on the inner SVG (sets `color: hsl(var(--player-N))`),
    // not on the wc-token wrapper — the wrapper just inherits page foreground.
    const styled = el.querySelector(`[class*="player-fg-${playerIndex}"]`) || el;
    const c = getComputedStyle(styled).color;
    return c && c !== 'rgba(0, 0, 0, 0)' ? c : fallback;
}

// Capture: KO Punch overlay on the board (POW! + defender pawn arcing into
// home base) plays in place of the live victim, then the real token DOM is
// moved into the home cell and bounces in. The lander is restacked the
// moment the victim leaves sourceCell so it returns to full size.
export function animateCaptureToHome(playerIndex, tokenIndex, attack) {
    const element = getTokenElement(playerIndex, tokenIndex);
    if (!element) return Promise.resolve();
    const sourceCell = element.parentElement;
    const homeCell = document.getElementById(getTokenContainerId(playerIndex, tokenIndex, -1));
    if (!homeCell) return Promise.resolve();

    const container = sourceCell ? sourceCell.closest('.board-wrap') : null;
    if (!container) return Promise.resolve();

    const attackerPlayerIndex = attack && attack.attackerPlayerIndex;
    const attackerTokenIndex = attack && attack.attackerTokenIndex;
    const prevCell = attack && attack.prevCellId ? document.getElementById(attack.prevCellId) : null;

    const containerRect = container.getBoundingClientRect();
    // Start from the victim's actual on-board box (handles pin/stack sizing).
    const startRect = element.getBoundingClientRect();
    const startSize = startRect.width;
    const capturePx = rectCenter(startRect, containerRect);
    const attackFrom = deriveAttackFrom(prevCell, sourceCell);
    const attackerColor = attackerPlayerIndex != null
        ? readTokenColor(attackerPlayerIndex, attackerTokenIndex || 0, '#cf4a3a')
        : '#cf4a3a';
    const defenderColor = readTokenColor(playerIndex, tokenIndex, '#2f9456');

    // Settle the real token into its home seat NOW (hidden), then measure its
    // exact resting box. The overlay lands the flying pawn on that box and the
    // live token is simply revealed in place afterwards — no post-animation
    // readjust. Moving the victim out of sourceCell before restacking also
    // sizes the capturing lander back to a sole occupant.
    const prevVisibility = element.style.visibility;
    element.style.visibility = 'hidden';
    clearStackStyles(element);
    delete element.dataset.moving;
    homeCell.appendChild(element);
    if (sourceCell && sourceCell !== homeCell) updateCellStacking(sourceCell);
    updateCellStacking(homeCell);

    const homeRect = element.getBoundingClientRect();
    const homeBasePx = rectCenter(homeRect, containerRect);
    const endScale = startSize ? homeRect.width / startSize : 1;

    return playKOCapture({
        container,
        capture: capturePx,
        homeBase: homeBasePx,
        attackerColor,
        defenderColor,
        attackFrom,
        // Fly at the victim's on-board size, then scale to the real token's
        // exact home-seat footprint so the overlay's final frame matches the
        // settled token — the flight IS the arrival, so no extra scale-in.
        pawnSize: startSize,
        endScale,
        duration: 900,
        shakeBoard: true,
    }).then(() => {
        element.style.visibility = prevVisibility;
    });
}

// Home-arrival overlay: source = pawn's pre-move viewport rect, home = final
// stacked-slot center after the token has been parented into the finish cell.
// Live token is hidden during the overlay's ~1.4s flourish, then revealed.
export function playFinishArrival(playerIndex, tokenIndex, sourceRect) {
    const element = getTokenElement(playerIndex, tokenIndex);
    if (!element) return Promise.resolve();
    const boardWrap = element.closest('.board-wrap');
    if (!boardWrap) return Promise.resolve();

    const finalRect = element.getBoundingClientRect();
    const containerRect = boardWrap.getBoundingClientRect();
    const cellSize = containerRect.width / 15;
    const src = sourceRect || finalRect;
    const sourceCenter = {
        x: src.left + src.width / 2 - containerRect.left,
        y: src.top + src.height / 2 - containerRect.top,
    };
    const homeCenter = {
        x: finalRect.left + finalRect.width / 2 - containerRect.left,
        y: finalRect.top + finalRect.height / 2 - containerRect.top,
    };
    const color = readTokenColor(playerIndex, tokenIndex, '#d97644');
    const finishCell = element.parentElement;
    const settledCount = finishCell
        ? finishCell.querySelectorAll(':scope > wc-token').length
        : 1;
    const isLastPawn = settledCount >= 4;

    element.style.visibility = 'hidden';
    playFinishSound();
    return playHomeArrival({
        container: boardWrap,
        home: homeCenter,
        source: sourceCenter,
        color,
        // Match the real token at both ends: start at the pre-move size
        // (~one cell), then shrink to the finish slot's settled size. The
        // finish cell stacks tokens far smaller than a cell, so endScale
        // carries the pawn down to the live token's final footprint.
        pawnSize: src.width,
        endScale: finalRect.width / src.width,
        // Confetti/ring/label spread is independent of the (tiny) finish-slot
        // pawn so the burst flies out across the board, not a small cluster.
        burstSize: cellSize * 2.5,
        duration: 1400,
        flashBoard: isLastPawn,
    }).then(() => {
        element.style.visibility = '';
    });
}

// Yard-launch overlay: live token hidden, parabolic-leap copy plays from yard
// parking slot to entry cell, then real token is parented into the entry cell
// and revealed. Source rect = token's current yard-slot rect.
export function playYardLaunch(playerIndex, tokenIndex, entryCellId) {
    const element = getTokenElement(playerIndex, tokenIndex);
    if (!element) return Promise.resolve();
    const finalContainer = document.getElementById(entryCellId);
    if (!finalContainer) return Promise.resolve();
    const boardWrap = element.closest('.board-wrap');
    if (!boardWrap) return Promise.resolve();

    const sourceCell = element.parentElement;
    const containerRect = boardWrap.getBoundingClientRect();
    const yardRect = element.getBoundingClientRect();
    const entryRect = finalContainer.getBoundingClientRect();
    const cellSize = containerRect.width / 15;

    const yardCenter = {
        x: yardRect.left + yardRect.width / 2 - containerRect.left,
        y: yardRect.top + yardRect.height / 2 - containerRect.top,
    };
    const entryCenter = {
        x: entryRect.left + entryRect.width / 2 - containerRect.left,
        y: entryRect.top + entryRect.height / 2 - containerRect.top,
    };
    const color = readTokenColor(playerIndex, tokenIndex, '#d97644');

    element.dataset.moving = 'true';
    element.style.visibility = 'hidden';
    // Keep the yard parking slot (.home-slot-dot) visible during the
    // overlay. Hiding only the live token reveals the empty seat ring,
    // which is exactly how the seat should look once the pawn has
    // launched — so it reads as "vacated" throughout the leap instead of
    // blinking out and reappearing when the promise resolves.

    playLaunchSound();
    return playPawnLaunch({
        container: boardWrap,
        yard: yardCenter,
        entry: entryCenter,
        color,
        // Match the real on-board token: a wc-token fills one cell (square),
        // so the launch pawn is cellSize too — same shape, size and centered
        // position as the live token at both the yard and entry endpoints.
        pawnSize: cellSize,
        duration: 1200,
        // No 'GO!' chip — the leap + shockwave + dust already read as
        // "this pawn just launched" and the chip stole focus from the
        // pawn settling on its entry cell.
        label: '',
    }).then(() => {
        clearStackStyles(element);
        delete element.dataset.moving;
        finalContainer.appendChild(element);
        if (sourceCell && sourceCell !== finalContainer) {
            updateCellStacking(sourceCell);
        }
        updateCellStacking(finalContainer);
        element.style.visibility = '';
    });
}

export function updateTokenContainer(playerIndex, tokenIndex, currentTokenPosition, newTokenPosition) {

    const path = getContainerPath(playerIndex, tokenIndex, currentTokenPosition, newTokenPosition);
    const element = getTokenElement(playerIndex, tokenIndex);

    if (currentTokenPosition === -1 && newTokenPosition === 0) {
        return playYardLaunch(playerIndex, tokenIndex, path[path.length - 1]);
    }

    return new Promise((resolve) => {
        if (path.length === 0) { resolve(); return; }

        const finalContainer = document.getElementById(path[path.length - 1]);
        const sourceCell = element.parentElement;

        element.dataset.moving = 'true';
        // Snapshot visual position before clearStackStyles snaps the element
        // back to its flow position. Stacked tokens (n>=2) sit at absolute
        // offsets; without this the element teleports to (0,0) of its cell
        // before the first translate fires — the "disappear then reappear
        // offset" symptom on captures.
        const visualRect = element.getBoundingClientRect();
        clearStackStyles(element);
        updateCellStacking(sourceCell);
        element.style.willChange = 'transform';
        element.style.position = 'relative';
        element.style.zIndex = '50';

        const originRect = element.getBoundingClientRect();
        const compDx = visualRect.left - originRect.left;
        const compDy = visualRect.top - originRect.top;
        if (Math.abs(compDx) > 0.5 || Math.abs(compDy) > 0.5) {
            element.style.transition = 'none';
            element.style.transform = `translate(${compDx}px, ${compDy}px)`;
            void element.offsetWidth;
            element.style.transition = '';
        }

        const fallbackMs = 400;

        let stepIndex = 0;

        function step() {
            if (stepIndex >= path.length) {
                element.style.willChange = '';
                element.style.position = '';
                element.style.zIndex = '';
                element.style.transition = '';
                element.style.removeProperty('transform');
                finalContainer.appendChild(element);
                delete element.dataset.moving;
                updateCellStacking(finalContainer);
                resolve();
                return;
            }

            playStepSound();
            const isFinalStep = stepIndex === path.length - 1;
            const targetId = path[stepIndex];
            const isFinishCell = /^p\ds6$/.test(targetId);

            if (isFinalStep && isFinishCell) {
                const targetContainer = document.getElementById(targetId);
                const preRect = element.getBoundingClientRect();

                element.style.transition = 'none';
                element.style.transform = '';
                element.style.position = '';
                element.style.zIndex = '';
                element.style.willChange = '';
                targetContainer.appendChild(element);
                delete element.dataset.moving;
                updateCellStacking(targetContainer);

                playFinishArrival(playerIndex, tokenIndex, preRect).then(resolve);
                return;
            }

            const targetContainer = document.getElementById(targetId);
            const targetRect = targetContainer.getBoundingClientRect();
            const offsetX = targetRect.left - originRect.left;
            const offsetY = targetRect.top - originRect.top;

            element.style.transform = `translate(${offsetX}px, ${offsetY}px)`;

            waitForTransitionEnd(element, () => {
                stepIndex++;
                requestAnimationFrame(step);
            }, fallbackMs);
        }

        requestAnimationFrame(step);
    });
}

/**
 *
 * @param {number} currentPlayerIndex
 * @param {number} tokenIndex
 */
const _bouncingTokens = new Set();

export function activateToken(currentPlayerIndex, tokenIndex) {
    const tokenElement = getTokenElement(currentPlayerIndex, tokenIndex);
    const inner = tokenElement.children[0];
    inner.classList.add("animate-bounce");
    inner.style.zIndex = "20";
    _bouncingTokens.add(inner);
}

export function inactiveTokens() {
    _bouncingTokens.forEach(element => {
        element.classList.remove("animate-bounce");
        element.style.removeProperty("z-index");
    });
    _bouncingTokens.clear();
}

export function activateDice() {
    document.getElementById("wc-dice").dataset.active = "true"
}

export function inactiveDice() {
    document.getElementById("wc-dice").dataset.active = "false"
}

let _wakeLock = null;
let _wakeWanted = false;
let _wakeListenerAttached = false;

async function _acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (_wakeLock || document.visibilityState !== "visible") return;
    try {
        _wakeLock = await navigator.wakeLock.request("screen");
        _wakeLock.addEventListener("release", () => { _wakeLock = null; });
    } catch (e) {
        // permission denied / battery saver — silently ignore
    }
}

export function requestWakeLock() {
    _wakeWanted = true;
    if (!_wakeListenerAttached) {
        document.addEventListener("visibilitychange", () => {
            if (_wakeWanted && document.visibilityState === "visible") _acquireWakeLock();
        });
        _wakeListenerAttached = true;
    }
    _acquireWakeLock();
}

export function releaseWakeLock() {
    _wakeWanted = false;
    if (_wakeLock) {
        _wakeLock.release().catch(() => {});
        _wakeLock = null;
    }
}

export function showGame() {
    document.getElementById("main-menu").classList.add("hidden")
    document.getElementById("game").classList.remove("hidden")
    replaceTo('game')
    requestWakeLock()
}

const PAWN_SVG_MINI = (playerIndex) => `
    <svg viewBox="0 0 32 32" class="player-fg-${playerIndex}" style="width:100%;height:100%;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.22));">
        <ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,0.18)"/>
        <path d="M16 4c3.2 0 5.5 2.4 5.5 5.2 0 1.8-1 3.2-2.4 4 1.7.7 2.9 1.8 3.6 3.4l1.1 2.6c.4 1 .1 2-.7 2.4-.2.1-.4.1-.6.1H9.5c-.9 0-1.6-.7-1.6-1.6 0-.3.1-.6.2-.9l1.1-2.6c.7-1.6 1.9-2.7 3.6-3.4-1.4-.8-2.4-2.2-2.4-4C10.4 6.4 12.8 4 16 4z" fill="currentColor"/>
        <rect x="7.5" y="22" width="17" height="3.5" rx="1.4" fill="currentColor"/>
    </svg>`;

const botGlyph = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>`;

const humanGlyph = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

const playerTypeGlyph = (type, size) => type === 'BOT' ? botGlyph(size) : humanGlyph(size);
const playerTypeLabel = (type) => type === 'BOT' ? 'Bot' : 'Human';

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}

function renderPauseScoreboard() {
    const board = document.getElementById("pm-scoreboard")
    if (!board) return
    if (!_playerTypes) { board.innerHTML = ''; return }
    const currentIdx = _getCurrentPlayerIndex ? _getCurrentPlayerIndex() : -1
    const rows = []
    _playerTypes.forEach((type, idx) => {
        if (!type) return
        const finished = _getFinishedCount ? _getFinishedCount(idx) : 0
        const name = (_playerNames[idx] && String(_playerNames[idx]).trim()) || `P${idx + 1}`
        const isActive = idx === currentIdx
        const dotCls = isActive ? `player-bg-${idx}` : 'pm-finish-dot--idle'
        const tag = isActive ? `<span class="pm-upnext">Up next</span>` : ''
        const typeBadge = `
            <span class="pm-type">
                ${playerTypeGlyph(type, 12)}
                ${playerTypeLabel(type)}
            </span>`
        rows.push(`
            <div class="pm-row">
                <div class="pm-pawn">${PAWN_SVG_MINI(idx)}</div>
                <div class="pm-body">
                    <div class="pm-name-row">
                        <span class="pm-name">${escapeHtml(name)}</span>
                        ${tag}
                    </div>
                    ${typeBadge}
                </div>
                <div class="pm-finish">
                    <span class="pm-finish-count">${finished}<span class="pm-finish-count-total">/4</span></span>
                    <span class="pm-finish-dot ${dotCls}"></span>
                </div>
            </div>`)
    })
    board.innerHTML = rows.join('')
}

export function showPauseMenu() {
    const overlay = document.getElementById("pause-menu")
    const turnEl = overlay.querySelector("#pm-turn-count")
    if (turnEl) turnEl.textContent = `Turn ${turnCount}`
    renderPauseScoreboard()
    overlay.classList.remove("hidden")
    releaseWakeLock()
}

export function resumeGame() {
    const overlay = document.getElementById("pause-menu")
    overlay.classList.add("hidden")
    requestWakeLock()
}

/**
 *
 * @param {number} currentPlayerIndex
 */
export function applyColorMap(colorMap) {
    const root = document.documentElement
    colorMap.forEach((originalColor, position) => {
        root.style.setProperty(`--player-${position}`, `var(--base-color-${originalColor})`)
        root.style.setProperty(`--player-${position}-light`, `var(--base-color-${originalColor}-light)`)
        root.style.setProperty(`--player-${position}-path`, `var(--base-color-${originalColor}-light)`)
    })
}

let turnCount = 0;

let _playerTypes = null;
let _playerNames = ['', '', '', ''];
let _getCurrentPlayerIndex = null;
let _getFinishedCount = null;

export function initRailDeps(pt, getCpi, getFC) {
    _playerTypes = pt;
    _getCurrentPlayerIndex = getCpi;
    _getFinishedCount = getFC;
}

export function setPlayerNames(names) {
    _playerNames = Array.isArray(names) ? names.slice(0, 4) : ['', '', '', ''];
}

// idx → { anchor, layout }  TD = pill-then-dice, DT = dice-then-pill
const CORNER_CFG = [
    { anchor: 'b0', layout: 'DT' }, // top-left   (dice on left toward home)
    { anchor: 'b1', layout: 'TD' }, // top-right  (dice on right toward home)
    { anchor: 'b2', layout: 'TD' }, // bottom-right
    { anchor: 'b3', layout: 'DT' }, // bottom-left
];

function pillMarkup(idx, finished, active) {
    const type = _playerTypes ? _playerTypes[idx] : null;
    const glyph = `<span class="corner-pill-glyph">${playerTypeGlyph(type, 14)}</span>`;
    const cls = active ? `corner-pill corner-pill--active player-bg-${idx}` : `corner-pill`;
    const name = (_playerNames[idx] && String(_playerNames[idx]).trim()) || `P${idx + 1}`;
    const safe = escapeHtml(name);
    return `
        <div class="${cls}">
            ${glyph}
            <div class="corner-pill-name">${safe}</div>
        </div>`;
}

export function updateCornerWidgets() {
    if (!_playerTypes) return;
    const pi = _getCurrentPlayerIndex();

    // Detach wc-dice before wiping any corner contents so we can reparent it.
    const dice = document.getElementById('wc-dice');
    if (dice && dice.parentElement) dice.parentElement.removeChild(dice);

    CORNER_CFG.forEach(({ anchor, layout }, idx) => {
        const el = document.getElementById(anchor);
        if (!el) return;
        el.innerHTML = '';
        if (!_playerTypes[idx]) return;

        const isActive = idx === pi;
        const finished = _getFinishedCount(idx);

        const wrap = document.createElement('div');
        wrap.className = 'corner-widget';

        const pill = document.createElement('div');
        pill.innerHTML = pillMarkup(idx, finished, isActive);
        const pillEl = pill.firstElementChild;

        const diceBtn = document.createElement('div');
        if (isActive) {
            diceBtn.className = `corner-dice corner-dice--active player-bg-${idx} active-dice-pulse`;
            diceBtn.style.setProperty('--pulse-color', `hsl(var(--player-${idx}) / 0.55)`);
            if (dice) {
                dice.style.cssText = 'width:100%;height:100%;';
                dice.className = '';
                diceBtn.appendChild(dice);
            }
        } else {
            diceBtn.className = `corner-dice corner-dice--idle player-bg-${idx}`;
        }

        if (layout === 'TD') {
            wrap.appendChild(pillEl);
            wrap.appendChild(diceBtn);
        } else {
            wrap.appendChild(diceBtn);
            wrap.appendChild(pillEl);
        }
        el.appendChild(wrap);
    });
}

export function updateTurnCounter() {
    turnCount++;
    const el = document.getElementById('turn-counter');
    if (el) el.textContent = `Turn ${turnCount}`;
}

export function resetTurnCount() {
    turnCount = 0;
}

export function getTurnCount() {
    return turnCount;
}

export function setTurnCount(n) {
    turnCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function moveDice() {
    updateCornerWidgets();
}