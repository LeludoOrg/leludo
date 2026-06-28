import {getMarkIndex} from "../core/game-logic.js";
import {YARD, ENTRY_SQUARE, LAST_TRACK_SQUARE} from "../core/board-constants.js";
import { SCREENS } from "../platform/screens.js";
import { MINI_PAWN_BODY } from "./pawn-mini.js";
import {playStepSound, playDiceSound, playLaunchSound, playFinishSound} from "./audio.js";
import {replaceTo} from "../platform/nav-history.js";
import {playKOCapture} from "./ko-capture.js";
import {playHomeArrival} from "./home-arrival.js";
import {playLaunchStartFX} from "./pawn-launch.js";
import {playPawnStep} from "./pawn-step.js";
import {requestWakeLock, releaseWakeLock} from "../platform/wake-lock.js";
import {
    setBoardQuarterTurns,
    boardRotationDeg,
    boardLocalPoint,
    boardUnrotateVec,
    quarterTurnsToFacePlayer,
} from "./board-orientation.js";
import {isOnlineActive} from "../net/online-state.js";
import {readBool} from "../platform/storage-util.js";
import {STORAGE_KEYS} from "../platform/storage-keys.js";

// Re-exported so the scripts barrel and existing importers keep one entry point
// even though the wake-lock implementation now lives in its own module.
export {requestWakeLock, releaseWakeLock};

// The board is a 15×15 grid, so a cell is 1/15 of the board's width.
const BOARD_CELLS = 15;

/** rAF is paused while the tab is hidden; several animation paths fast-forward
 *  instead of waiting on it. Guards the non-browser (test) case too. */
function isTabHidden() {
    return typeof document !== 'undefined' && document.hidden;
}

// Finish-cell DOM id, e.g. "p0s6" — the home-stretch goal square per player.
const FINISH_CELL_ID_RE = /^p\ds6$/;

/**
 *
 * @param {number} playerIndex
 * @param {number} tokenIndex
 * @param {number} tokenPosition
 * @return {string}
 */
export function getTokenContainerId(playerIndex, tokenIndex, tokenPosition) {
    if (tokenPosition === YARD) {
        return `h-${playerIndex}-${tokenIndex}`
    }

    if (tokenPosition > LAST_TRACK_SQUARE) {
        const safeIndex = tokenPosition - LAST_TRACK_SQUARE;
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

// requestAnimationFrame is PAUSED while the tab/window is hidden. Online play
// (scripts/online-game.js) replays server broadcasts through a serial promise
// queue that awaits these animation promises, so a pure-rAF loop would never
// resolve on a backgrounded client — the queue wedges on the first roll/move it
// must replay while hidden and the client desyncs from the server permanently.
// nextFrame drives the loop with rAF when visible (timestamp + cadence intact)
// and falls back to a timer when rAF is stalled, so the loop always advances.
function nextFrame(cb) {
    let fired = false;
    const run = (t) => { if (fired) return; fired = true; cb(t == null ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : t); };
    requestAnimationFrame(run);
    // Longer than any real frame, so visible playback always uses rAF; short
    // enough that a hidden client (rAF paused, timers merely throttled) keeps
    // draining its replay queue instead of stalling forever.
    setTimeout(() => run(), 250);
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
            // Hidden tab: nothing to animate and rAF is paused — snap to the
            // final face and let the replay queue move on (see nextFrame).
            if (isTabHidden()) {
                updateDiceFace(diceRoll, currentDiceRoll);
                resolve();
                return;
            }
            if (!lastTime) lastTime = timestamp;

            if (timestamp - lastTime < delays[counter]) {
                nextFrame(tick);
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
            nextFrame(tick);
        }

        // Snap straight to the result when the tab is already hidden — no rAF
        // will fire to run the spin, so don't wait on it.
        if (isTabHidden()) {
            updateDiceFace(currentDiceRoll, currentDiceRoll);
            resolve();
            return;
        }
        nextFrame(tick);
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
    // Freeze the token at its current visual spot in the cell's LOCAL frame.
    // Map its viewport centre back through any board rotation, then offset by
    // half its (rotation-invariant) size to get the local top-left. Identity at
    // 0 turns → `rect.left/top - cellRect.left/top` as before.
    const c = boardLocalPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, cellRect);
    element.style.top = `${c.y - rect.height / 2}px`;
    element.style.left = `${c.x - rect.width / 2}px`;
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
    // The peek-fan tilts each pawn via --pawn-tilt on the inner svg — drop it so
    // a pawn that leaves a stack (back to a lone, full-cell token) stands
    // upright. (Driven via a custom prop so the rotate composes with the
    // token-bounce keyframe instead of being clobbered by it.)
    const svg = t.firstElementChild;
    if (svg) svg.style.removeProperty('--pawn-tilt');
}

// Whole-arrangement contact anchor: bottom-center of the cell, raised by 16% so
// the pawns sit just above the cell's bottom edge. Expressed in % of the
// (square) cell so the layout is resize-safe with no pixel recompute.
const STACK_ANCHOR_BOTTOM = 16;
// Bloom: when a pawn lands on a cell that becomes a 2+ stack, the group spreads
// from its just-landed overlap into the fan with this springy, deliberate
// transition (slight overshoot) instead of wc-token's quick 150ms snap.
const STACK_BLOOM_TRANSITION = 'transform 320ms cubic-bezier(.34,1.28,.5,1)';
const PAWN_H = 1.16; // pawn height / width (see pawn-shape.js)
// Cap a vertical totem's body (bottom pawn base → top pawn head) to 1.25 cells,
// in % of cell — a 4-tall stack stays readable without eating extra rows.
const MAX_TOTEM_HEIGHT_PCT = 125;

// Position one stacked pawn. All metrics are % of the cell. `wPct` is the pawn
// width; height follows the pawn aspect. The horizontal fan tilt rides the
// inner svg's own transform so the wrapper transform stays free for the FLIP /
// hop animations that translate the whole token between cells.
function placeStackPawn(t, leftPct, bottomPct, wPct, rotateDeg, z) {
    t.style.cssText += `position:absolute;left:${leftPct}%;bottom:${bottomPct}%;` +
        `width:${wPct}%;height:${wPct * PAWN_H}%;z-index:${z};`;
    const svg = t.firstElementChild;
    if (!svg) return;
    if (rotateDeg) svg.style.setProperty('--pawn-tilt', `${rotateDeg}deg`);
    else svg.style.removeProperty('--pawn-tilt');
}

// A lone pawn on a path cell. The pawn svg is taller than the (square) cell
// (PAWN_H 1.16), so left in normal flow it top-aligns and its base overflows
// BELOW the cell — where the next-row cell, painted later, crops it. Anchor it
// to the cell floor at full width so the excess height overflows UPWARD instead
// (over the earlier-painted cell above), matching how stacked pawns sit. Pinned
// out of flow so it can't stretch its grid track either.
function placeLonePawn(t) {
    t.style.cssText += 'position:absolute;left:0;bottom:0;width:100%;height:auto;';
}

// Case A — total ≤ 4: fan every pawn individually like a hand of cards.
function peekFan(tokens) {
    const N = tokens.length;
    const factor = N >= 4 ? 0.74 : N >= 3 ? 0.82 : 0.9; // N === 2 here (N === 1 stays in flow)
    const wPct = 96 * factor;
    const stepPct = wPct * 0.33;  // horizontal spacing — < pawn width, so pawns overlap a touch
    tokens.forEach((t, i) => {
        const off = i - (N - 1) / 2;
        const leftPct = 50 + off * stepPct - wPct / 2;
        const bottomPct = STACK_ANCHOR_BOTTOM + Math.abs(off) * wPct * 0.05;
        placeStackPawn(t, leftPct, bottomPct, wPct, off * 7, 10 + i);
    });
}

// Case B — total > 4: collapse each color into one vertical totem, then fan the
// totems. At most 4 colors, so the fan never shows more than 4 leaves.
function totemFan(tokens) {
    const groups = new Map(); // playerIndex -> tokens[], first-encounter order
    for (const t of tokens) {
        const player = +t.id.split('-')[1];
        if (!groups.has(player)) groups.set(player, []);
        groups.get(player).push(t);
    }
    const leaves = [...groups.values()];
    const K = leaves.length;
    const wPct = K >= 3 ? 80 : 90;
    const stepPct = wPct * 0.40;  // horizontal spacing between totems — a touch tighter (slight overlap)
    const pawnHPct = wPct * PAWN_H;       // a single pawn is ~1 cell tall
    leaves.forEach((stack, gi) => {
        const off = gi - (K - 1) / 2;
        const leftPct = 50 + off * stepPct - wPct / 2;
        // Vertical overlap: the compact natural step (0.26), but compressed so a
        // full 4-tall totem never rises past MAX_TOTEM_HEIGHT_PCT (1.5 cells) —
        // pawnH + (n-1)·vStep ≤ cap. Short totems keep the looser natural step.
        const n = stack.length;
        const vStepPct = n > 1
            ? Math.min(pawnHPct * 0.26, (MAX_TOTEM_HEIGHT_PCT - pawnHPct) / (n - 1))
            : 0;
        stack.forEach((t, j) => {
            // Higher pawn in a totem renders in front; later totems sit above
            // earlier ones — leave room (×8) so totems never z-interleave.
            placeStackPawn(t, leftPct, STACK_ANCHOR_BOTTOM + j * vStepPct, wPct, off * 5, 10 + gi * 8 + j);
        });
    });
}

// Finish-cell stacking. A finish cell holds ≤4 of ONE player's pawns, so it's
// always a peek-fan (no totem). The cell is the full ~3×3-cell center zone; the
// pawns sit as a compact HORIZONTAL fan, tightly overlapping, centered in that
// player's wedge. Width-driven (height:auto) so the taller pawn isn't
// letterboxed. Per-player wedge centers (% of the zone) keep each fan on its
// colored triangle: P0 left, P1 top, P2 right, P3 bottom.
const FINISH_PAWN_W = 22;      // pawn width, % of the finish zone (compact)
const FINISH_STEP = 0.28;      // horizontal step as a fraction of pawn width (tight overlap)
// Wedge centers (% of zone), pushed toward each player's outer edge — the fat
// part of the triangle — so the compact fan sits inside its wedge and never
// crosses the centre into another player's home.
const FINISH_CENTERS = { 0: [22, 50], 1: [50, 22], 2: [78, 50], 3: [50, 78] };
function applyFinishStacking(cell, tokens) {
    const n = tokens.length;
    if (n === 0) return;
    const playerIdx = parseInt(cell.id[1], 10);
    const wPct = FINISH_PAWN_W;
    const hPct = wPct * PAWN_H;
    const [cx, cy] = FINISH_CENTERS[playerIdx] || [50, 50];
    const step = wPct * FINISH_STEP;

    tokens.forEach((t, i) => {
        const off = i - (n - 1) / 2;
        const left = cx + off * step - wPct / 2;
        const top = cy - hPct / 2;
        t.style.cssText += `position:absolute;top:${top}%;left:${left}%;width:${wPct}%;height:auto;z-index:${10 + i};`;
        const svg = t.firstElementChild;
        if (svg) {
            if (off) svg.style.setProperty('--pawn-tilt', `${off * 5}deg`);
            else svg.style.removeProperty('--pawn-tilt');
        }
    });
}

// Play a FLIP transition (First-Last-Invert-Play) on each token from its
// snapshot box (`first`) to the slot it now occupies. By default it rides
// wc-token's own 150ms transform transition; pass `transition` to override with
// a custom CSS transition (e.g. a longer, springier "bloom" when a pawn joins a
// stack). It only ever sets transform/transform-origin, so it animates position
// AND size (translate + scale) without touching layout — that's how stackmates
// smoothly resize+reposition when one of them arrives or leaves.
function flipTokens(tokens, first, transition = '') {
    const moved = [];
    for (const t of tokens) {
        const f = first.get(t);
        if (!f) continue;
        const last = t.getBoundingClientRect();
        if (!last.width || !last.height) continue; // hidden (display:none) — nothing to play
        const dx = f.left - last.left;
        const dy = f.top - last.top;
        const sx = f.width / last.width;
        const sy = f.height / last.height;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
        // The token lives inside the rotated .board-rotor, so the translate plays
        // in board-local space — un-rotate the viewport delta or the rotor spins
        // it a second time and the glide heads the wrong way. Identity at 0 turns.
        const v = boardUnrotateVec(dx, dy);
        t.style.transformOrigin = 'top left';
        t.style.transition = 'none';
        t.style.transform = `translate(${v.x}px, ${v.y}px) scale(${sx}, ${sy})`;
        moved.push(t);
    }
    if (!moved.length) return;
    void moved[0].offsetWidth; // commit the inverted (old-slot) state in one reflow
    for (const t of moved) {
        t.style.transition = transition;  // '' restores wc-token's own transition
        t.style.transform = '';           // play back to the real slot
        waitForTransitionEnd(t, () => {
            t.style.removeProperty('transition');
            t.style.removeProperty('transform');
            t.style.removeProperty('transform-origin');
        }, transition ? 600 : 250);
    }
}

export function updateCellStacking(cell, opts = {}) {
    if (!cell) return;
    const { animate = false, firstRects = null, flipTransition = '' } = opts;
    const allTokens = Array.from(cell.querySelectorAll(':scope > wc-token'));
    // Only relayout settled tokens. A token mid-animation (moving='true') is
    // pinned position:absolute and out of flow — clearing its styles here would
    // drop it back into flow and shove/hide the settled tokens. Leave it alone.
    const tokens = allTokens.filter(t => t.dataset.moving !== 'true');

    // FLIP step 1 (First): snapshot each token's on-screen box BEFORE we touch
    // styles. An explicit firstRects entry wins — used for the just-arrived
    // mover, whose pre-relayout box is its travel box, not the flow box this
    // would otherwise measure after it was reparented into the cell.
    const first = animate ? new Map() : null;
    if (animate) {
        for (const t of tokens) {
            first.set(t, (firstRects && firstRects.get(t)) || t.getBoundingClientRect());
        }
    }

    tokens.forEach(clearStackStyles);
    const n = tokens.length;

    // Legacy >4 count badge (pre peek-fan). Remove any lingering one — the
    // totem fan now shows every pawn, so the badge is gone.
    const badge = cell.querySelector('.stack-badge');
    if (badge) badge.remove();

    if (FINISH_CELL_ID_RE.test(cell.id)) {
        applyFinishStacking(cell, tokens);
    } else if (n >= 2) {
        cell.style.position = 'relative';
        if (n <= 4) {
            peekFan(tokens);      // fan each pawn individually
        } else {
            totemFan(tokens);     // collapse same color into vertical totems, fan those
        }
    } else if (n === 1 && cell.classList.contains('path-cell')) {
        // Lone pawn on a track / home-stretch cell: floor-anchor it so its
        // taller-than-cell body overflows upward, not down into the cropping
        // next cell. (Yard dots / finish cells aren't .path-cell, so their
        // own placement rules are untouched.)
        cell.style.position = 'relative';
        placeLonePawn(tokens[0]);
    }

    // FLIP steps 2-4 (Last/Invert/Play): animate every token from its snapshot
    // box into the slot it now holds.
    if (animate) flipTokens(tokens, first, flipTransition);
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

// A cell/token's centre in board-LOCAL coordinates (origin = the .board-wrap
// rect). boardLocalPoint maps the measured viewport point back through any
// active board rotation so overlays land on the right cell when the board is
// flipped to face the opposite player; at 0 quarter-turns it's a plain subtract.
function rectCenter(rect, origin) {
    return boardLocalPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, origin);
}

// A cell/token's foot (bottom-centre) in board-local coordinates — where a
// floor-anchored pawn's base sits. Same rotation-aware mapping as rectCenter.
function rectFoot(rect, origin) {
    return boardLocalPoint(rect.left + rect.width / 2, rect.bottom, origin);
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

    // Hidden tab: the victim is already settled into its home seat above — skip
    // the KO overlay so the online replay queue doesn't stall on its timers.
    if (isTabHidden()) {
        element.style.visibility = prevVisibility;
        return Promise.resolve();
    }

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

    // Hidden tab: the token is already parented into the finish cell — skip the
    // cosmetic arrival overlay so the online replay queue doesn't stall on it.
    if (isTabHidden()) return Promise.resolve();

    const finalRect = element.getBoundingClientRect();
    const containerRect = boardWrap.getBoundingClientRect();
    const cellSize = containerRect.width / BOARD_CELLS;
    const src = sourceRect || finalRect;
    const sourceCenter = rectCenter(src, containerRect);
    const homeCenter = rectCenter(finalRect, containerRect);
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
export function playYardLaunch(playerIndex, tokenIndex, entryCellId, opts = {}) {
    const onArrive = opts.onArrive || function () {};
    const element = getTokenElement(playerIndex, tokenIndex);
    if (!element) { onArrive(); return Promise.resolve(); }
    const finalContainer = document.getElementById(entryCellId);
    if (!finalContainer) { onArrive(); return Promise.resolve(); }
    const boardWrap = element.closest('.board-wrap');
    if (!boardWrap) { onArrive(); return Promise.resolve(); }

    const sourceCell = element.parentElement;

    // Hidden tab: rAF/overlay timers are paused or throttled, which would stall
    // the online replay queue. Land the pawn in its entry cell immediately and
    // skip the leap flourish (the client catches up visually when shown again).
    if (isTabHidden()) {
        clearStackStyles(element);
        delete element.dataset.moving;
        finalContainer.appendChild(element);
        if (sourceCell && sourceCell !== finalContainer) updateCellStacking(sourceCell);
        updateCellStacking(finalContainer);
        element.style.visibility = '';
        onArrive();
        return Promise.resolve();
    }

    const containerRect = boardWrap.getBoundingClientRect();
    const yardRect = element.getBoundingClientRect();
    const entryRect = finalContainer.getBoundingClientRect();
    const cellSize = containerRect.width / BOARD_CELLS;

    const yardCenter = rectCenter(yardRect, containerRect);
    // Feet points (bottom-center) — what playPawnStep hops between, so the
    // pawn's base tracks the floor like the normal cell-to-cell mover.
    const yardFeet = rectFoot(yardRect, containerRect);
    const entryFeet = rectFoot(entryRect, containerRect);
    const color = readTokenColor(playerIndex, tokenIndex, '#d97644');

    element.dataset.moving = 'true';
    element.style.visibility = 'hidden';
    // Keep the yard parking slot (.home-slot-dot) visible during the
    // overlay. Hiding only the live token reveals the empty seat ring,
    // which is exactly how the seat should look once the pawn has
    // launched — so it reads as "vacated" throughout the hop instead of
    // blinking out and reappearing when the promise resolves.

    playLaunchSound();
    // Keep the launch's signature start flourish — sparkle + radial glow at the
    // yard — but drop the parabolic leap (and the landing burst). The pawn
    // travels with the SAME hop the normal cell-to-cell mover uses
    // (playPawnStep), so launching reads as one big version of an ordinary step.
    playLaunchStartFX({ container: boardWrap, at: yardCenter, color, pawnSize: cellSize });

    const HOP_DUR = 480;
    // One hop across a multi-cell gap: a raw hopBig fraction of that long gap
    // would arc absurdly tall, so cap the apex to ~1.15 cells.
    const gap = Math.hypot(entryFeet.x - yardFeet.x, entryFeet.y - yardFeet.y) || 1;
    const hopBig = Math.max(0.16, Math.min(0.5, (cellSize * 1.15) / gap));

    return playPawnStep({
        container: boardWrap,
        path: [yardFeet, entryFeet],
        color,
        // A wc-token fills one cell (square), so the hop pawn is cellSize too —
        // same glyph and footprint as the live token at both endpoints.
        pawnSize: cellSize,
        stepDur: HOP_DUR,
        hopBig,
        // Fire any coincident capture the instant the pawn lands on the entry
        // square, overlapping the settle bounce instead of waiting it out.
        onArrive,
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

export function updateTokenContainer(playerIndex, tokenIndex, currentTokenPosition, newTokenPosition, opts = {}) {
    // onArrive fires the instant the mover touches its destination cell — before
    // the settle bounce — so a caller (command-handler) can launch a coincident
    // capture on contact rather than after the bounce tail. Defaults to a no-op.
    const onArrive = opts.onArrive || function () {};

    const path = getContainerPath(playerIndex, tokenIndex, currentTokenPosition, newTokenPosition);
    const element = getTokenElement(playerIndex, tokenIndex);

    if (currentTokenPosition === YARD && newTokenPosition === ENTRY_SQUARE) {
        return playYardLaunch(playerIndex, tokenIndex, path[path.length - 1], { onArrive });
    }

    return new Promise((resolve) => {
        if (path.length === 0) { onArrive(); resolve(); return; }

        const finalContainer = document.getElementById(path[path.length - 1]);
        const sourceCell = element.parentElement;
        const boardWrap = element.closest('.board-wrap');

        // Hidden tab (or no board mounted): rAF is paused, so the hop overlay
        // would never run and the online replay queue (which awaits this promise)
        // would wedge — the client desyncs from the server. Land the token in its
        // final cell immediately; it catches up visually when shown again.
        if (isTabHidden() || !boardWrap) {
            clearStackStyles(element);
            delete element.dataset.moving;
            finalContainer.appendChild(element);
            if (sourceCell && sourceCell !== finalContainer) updateCellStacking(sourceCell);
            updateCellStacking(finalContainer);
            onArrive();
            resolve();
            return;
        }

        const containerRect = boardWrap.getBoundingClientRect();
        const cellSize = containerRect.width / BOARD_CELLS;
        const color = readTokenColor(playerIndex, tokenIndex, '#d97644');

        // Feet point (container-relative bottom-center) of a cell id — where a
        // floor-anchored lone pawn's base sits. The hop pawn lands its feet here,
        // so its end box equals the settled token's box (no post-reveal pop).
        const feetOf = (id) => rectFoot(document.getElementById(id).getBoundingClientRect(), containerRect);

        // Where the mover sits right now (its stacked slot, if any) — the hop's
        // first feet point, so the leap starts exactly where the live pawn was.
        const startRect = element.getBoundingClientRect();
        const startCenter = rectFoot(startRect, containerRect);

        // Viewport box a floor-anchored lone pawn occupies in `cellRect`: full
        // cell width, taller body (PAWN_ASPECT) overflowing UPWARD with its base
        // on the cell's bottom edge — i.e. the hop's exact final frame. The
        // destination FLIP starts from this so a lone landing is a no-op (no
        // settle glide) and a stack-join eases in from the right spot.
        const lonePawnBox = (cellRect) => {
            const h = cellRect.width * PAWN_H;
            return {
                left: cellRect.left,
                top: cellRect.bottom - h,
                width: cellRect.width,
                height: h,
                right: cellRect.right,
                bottom: cellRect.bottom,
            };
        };

        // Hide the live token and reflow the survivors of its source stack into
        // their new (n-1) layout — the overlay paints its own hopping copy.
        // dataset.moving keeps updateCellStacking from dragging it back into flow.
        element.dataset.moving = 'true';
        element.style.visibility = 'hidden';
        if (sourceCell) updateCellStacking(sourceCell, { animate: true });

        const lastId = path[path.length - 1];
        const lastIsFinish = FINISH_CELL_ID_RE.test(lastId);
        // The finish-cell arrival has its own flourish (playFinishArrival); the
        // hop covers every track / home-stretch cell up to (not including) it.
        const hopIds = lastIsFinish ? path.slice(0, -1) : path;

        // Reparent the live token into the finish cell and hand off to the home
        // arrival overlay, starting from the last hopped cell's box.
        const landFinish = (preRect) => {
            element.style.transition = 'none';
            element.style.removeProperty('transform');
            element.style.removeProperty('transform-origin');
            element.style.willChange = '';
            clearStackStyles(element);
            delete element.dataset.moving;
            finalContainer.appendChild(element);
            updateCellStacking(finalContainer);
            element.style.removeProperty('transition');
            playFinishArrival(playerIndex, tokenIndex, preRect).then(resolve);
        };

        // A bare hop into the finish cell (no track cells between): skip straight
        // to the arrival flourish, sourced from the mover's current box.
        if (lastIsFinish && hopIds.length === 0) {
            onArrive();
            landFinish(startRect);
            return;
        }

        // Finish landing: hop across the track cells up to (not including) the
        // finish, land lone on the last one, then hand off to the arrival
        // flourish. (Finish cells never host an opposing capture.)
        if (lastIsFinish) {
            const hopPath = [startCenter, ...hopIds.map(feetOf)];
            playPawnStep({
                container: boardWrap,
                path: hopPath,
                color,
                pawnSize: cellSize,
                onStep: () => playStepSound(),
                onArrive,
            }).then(() => {
                const cellId = hopIds[hopIds.length - 1];
                landFinish(lonePawnBox(document.getElementById(cellId).getBoundingClientRect()));
            });
            return;
        }

        // Track landing — the mover hops in and lands stacked on top of any
        // current occupant (full cell size), then the whole group BLOOMS apart
        // from that overlap into the final fan with a springy, deliberate spread
        // (STACK_BLOOM_TRANSITION) instead of snapping into place instantly. A
        // lone landing has nothing to fan, so the bloom is a no-op.
        const landTrack = () => {
            element.style.transition = 'none';
            element.style.removeProperty('transform');
            element.style.removeProperty('transform-origin');
            element.style.willChange = '';
            clearStackStyles(element);
            delete element.dataset.moving;
            element.style.visibility = '';
            finalContainer.appendChild(element);
            // The mover's pre-bloom box is the full-cell seat the hop overlay
            // ended on (centred, on top of the stack), so the bloom starts
            // exactly where the live token appears — no reveal pop.
            const firstRect = lonePawnBox(document.getElementById(lastId).getBoundingClientRect());
            updateCellStacking(finalContainer, {
                animate: true,
                firstRects: new Map([[element, firstRect]]),
                flipTransition: STACK_BLOOM_TRANSITION,
            });
            element.style.removeProperty('transition');
            resolve();
        };

        const hopPath = [startCenter, ...hopIds.map(feetOf)];

        playPawnStep({
            container: boardWrap,
            path: hopPath,
            color,
            // A wc-token fills one cell (square) wide, so the hop pawn is cellSize
            // too — same glyph and footprint as the live token at every cell.
            pawnSize: cellSize,
            // Per-cell footstep, fired as each gap begins (matches the old glide).
            onStep: () => playStepSound(),
            onArrive,
        }).then(landTrack);
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
    const dice = document.getElementById("wc-dice");
    if (dice) dice.dataset.active = "true";
}

export function inactiveDice() {
    const dice = document.getElementById("wc-dice");
    if (dice) dice.dataset.active = "false";
}

export function showGame() {
    document.getElementById("main-menu").classList.add("hidden")
    document.getElementById("game").classList.remove("hidden")
    replaceTo(SCREENS.GAME)
    requestWakeLock()
}

const PAWN_SVG_MINI = (playerIndex) => `
    <svg viewBox="0 0 32 32" class="player-fg-${playerIndex}" style="width:100%;height:100%;filter:drop-shadow(0 1px 1px rgba(0,0,0,0.22));">
        <ellipse cx="16" cy="28" rx="8" ry="1.5" fill="rgba(0,0,0,0.18)"/>
        <path d="${MINI_PAWN_BODY}" fill="currentColor"/>
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
        const name = playerDisplayName(idx)
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

// Trimmed display name for a seat, falling back to "P1".."P4" when the
// stored name is blank/missing. Shared by the pause scoreboard and the
// corner pills so the fallback stays identical.
function playerDisplayName(idx) {
    return (_playerNames[idx] && String(_playerNames[idx]).trim()) || `P${idx + 1}`;
}

let _getCurrentPlayerIndex = null;
let _getFinishedCount = null;

// Last dice value each player rolled, shown faded in their idle corner so a
// player can still see what their roll was after the turn moves on quickly —
// e.g. a third-six forfeit or a roll with no movable pawn. null = not rolled
// yet this game.
let _lastRollByPlayer = [null, null, null, null];

export function setLastRoll(playerIndex, value) {
    if (playerIndex >= 0 && playerIndex < 4) _lastRollByPlayer[playerIndex] = value;
}

export function resetLastRolls() {
    _lastRollByPlayer = [null, null, null, null];
}

// Pip layout per face value (grid row/column, 3x3 grid) — mirrors wc-dice.
const DIE_PIPS = {
    1: [[2, 2]],
    2: [[1, 1], [3, 3]],
    3: [[1, 1], [2, 2], [3, 3]],
    4: [[1, 1], [1, 3], [3, 1], [3, 3]],
    5: [[1, 1], [1, 3], [2, 2], [3, 1], [3, 3]],
    6: [[1, 1], [1, 3], [2, 1], [2, 3], [3, 1], [3, 3]],
};

// Reuses the exact live-dice classes (.die / .dice-face / .dice-dot) so the
// faded copy inherits identical light/dark styling — only one face, no id.
function staticDieMarkup(value) {
    const pips = (DIE_PIPS[value] || [])
        .map(([r, c]) => `<div class="dice-dot" style="grid-row:${r};grid-column:${c};"></div>`)
        .join('');
    return `<div class="die"><div class="dice-face">${pips}</div></div>`;
}

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
    const name = playerDisplayName(idx);
    const safe = escapeHtml(name);
    return `
        <div class="${cls}">
            ${glyph}
            <div class="corner-pill-name">${safe}</div>
        </div>`;
}

// Renderer player index === home corner offline (0 TL, 1 TR, 2 BR, 3 BL — see
// the home-quad markup in wc-board.js). Online remaps seats itself, so this only
// reasons about the local board.
function humanCorners() {
    const out = [];
    if (!_playerTypes) return out;
    for (let i = 0; i < 4; i++) if (_playerTypes[i] === 'PLAYER') out.push(i);
    return out;
}

// Face-to-face rotation is for the pass-and-play case the player feedback asked
// about: two people sharing one phone. It only engages offline, with the toggle
// on, when EXACTLY two humans sit on OPPOSITE halves (one top, one bottom) — the
// only seating a 180° flip genuinely faces each player in turn.
function faceToFaceRotationActive() {
    if (isOnlineActive()) return false;
    if (!readBool(STORAGE_KEYS.ROTATE_TO_PLAYER, true)) return false;
    const h = humanCorners();
    if (h.length !== 2) return false;
    const topHumans = h.filter((c) => c === 0 || c === 1).length;
    return topHumans === 1; // one top + one bottom = opposite halves
}

// Spin the .board-rotor so `pi`'s home faces the near edge, then store the
// matching quarter-turn so the overlay coordinate helpers stay in sync. A no-op
// (0 turns) for every mode that isn't offline face-to-play.
function updateBoardOrientation(pi) {
    const q = faceToFaceRotationActive() ? quarterTurnsToFacePlayer(pi) : 0;
    setBoardQuarterTurns(q);
    const rotor = document.querySelector('.board-rotor');
    if (rotor) rotor.style.setProperty('--board-rot', `${boardRotationDeg()}deg`);
}

// Re-apply orientation for the current player out of band — used when the
// settings toggle flips mid-game so the board responds without waiting a turn.
export function refreshBoardOrientation() {
    if (_getCurrentPlayerIndex) updateBoardOrientation(_getCurrentPlayerIndex());
}

export function updateCornerWidgets() {
    if (!_playerTypes) return;
    const pi = _getCurrentPlayerIndex();
    updateBoardOrientation(pi);

    // Detach wc-dice before wiping any corner contents so we can reparent it.
    const dice = document.getElementById('wc-dice');
    if (dice && dice.parentElement) dice.parentElement.removeChild(dice);

    let diceMounted = false;

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
                diceMounted = true;
            }
        } else {
            const lastRoll = _lastRollByPlayer[idx];
            if (lastRoll) {
                diceBtn.className = `corner-dice corner-dice--rolled player-border-${idx}`;
                diceBtn.innerHTML = staticDieMarkup(lastRoll);
            } else {
                diceBtn.className = `corner-dice corner-dice--idle player-bg-${idx}`;
            }
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

    // The dice landed in no corner (the current seat just forfeited — an online
    // DROPPED frame can point currentPlayerIndex at the stripped seat for one
    // frame). Park it back in its offscreen home: detaching it permanently
    // would make every later getElementById('wc-dice') null and crash the
    // frame pipeline that follows.
    if (dice && !diceMounted) {
        const home = document.getElementById('dice-home');
        if (home) home.appendChild(dice);
    }
}

// Single place the "Turn N" label is written — every counter mutation paints
// through here so the DOM never drifts from the variable.
function renderTurnCount() {
    const el = document.getElementById('turn-counter');
    if (el) el.textContent = `Turn ${turnCount}`;
}

export function updateTurnCounter() {
    turnCount++;
    renderTurnCount();
}

export function resetTurnCount() {
    turnCount = 0;
    renderTurnCount();
}

export function getTurnCount() {
    return turnCount;
}

// Force the counter to an exact value and repaint. Used by resume (restore the
// saved turn) and online play (the server is authoritative for the turn number,
// so every client shows the same one).
export function setTurnCount(n) {
    turnCount = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    renderTurnCount();
}

export function moveDice() {
    updateCornerWidgets();
}