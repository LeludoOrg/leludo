/**
 * Online disconnect presence. When a player's connection drops they are DIMMED
 * on the board, and once the rotation reaches their turn the game HOLDS (the
 * server never skips a turn) — a banner tells everyone who the game is waiting
 * for and how long until the seat forfeits. If THIS client is the one who
 * dropped, a small non-blocking banner says we're reconnecting.
 *
 * Pure DOM, no imports, resilient when the elements are absent (headless tests).
 * Driven by online-game (peer dimming + waiting banner) and the net-client
 * reconnect callbacks wired in wc-quick-start (self banner).
 */

// The board elements that make up player `i`'s presence: their corner widget
// anchor (#bN — persists across corner rebuilds, so dimming it survives turn
// changes), their home quad, and their pawns.
function playerEls(i) {
    return document.querySelectorAll(`#b${i}, .home-quad.player-bg-${i}, [id^="p-${i}-"]`);
}

/** Dim exactly the players in `localIndexes`; un-dim everyone else. Idempotent. */
export function setDimmedPlayers(localIndexes) {
    const set = new Set(localIndexes || []);
    for (let i = 0; i < 4; i++) {
        const on = set.has(i);
        playerEls(i).forEach(el => el.classList.toggle('net-dimmed', on));
    }
}

// ---- self reconnect banner (small, non-blocking) ------------------------------

function banner() { return document.getElementById('net-reconnect-banner'); }

function setBanner(text, show) {
    const el = banner();
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('hidden', !show);
}

/** This client lost its own connection; net-client is retrying. */
export function showSelfReconnect() { setBanner('Connection lost — reconnecting…', true); }

/** Reconnect attempts exhausted — the seat will be forfeited server-side. */
export function showSelfGaveUp() { setBanner('Disconnected — couldn’t reconnect.', true); }

export function hideSelfBanner() { setBanner('', false); }

// ---- peer waiting banner (the game is held on a disconnected player) --------

function waitingBanner() { return document.getElementById('net-waiting-banner'); }

let _waitingTimer = null;
let _waitingDeadline = 0;
let _waitingName = '';

function renderWaiting() {
    const el = waitingBanner();
    if (!el) return;
    const secs = Math.max(0, Math.ceil((_waitingDeadline - Date.now()) / 1000));
    el.textContent = `Waiting for ${_waitingName} to reconnect… ${secs}s`;
}

/**
 * The server held the game on `name`'s turn. Shows a countdown to the forfeit
 * deadline, ticking locally off `remainingMs` (the server doesn't re-broadcast
 * during a hold, so the tick is client-side; every later frame re-syncs it).
 */
export function showWaitingFor(name, remainingMs) {
    const el = waitingBanner();
    if (!el) return;
    _waitingName = name || 'player';
    _waitingDeadline = Date.now() + Math.max(0, remainingMs || 0);
    renderWaiting();
    el.classList.remove('hidden');
    if (_waitingTimer == null) _waitingTimer = setInterval(renderWaiting, 1000);
}

export function hideWaitingBanner() {
    const el = waitingBanner();
    if (el) el.classList.add('hidden');
    if (_waitingTimer != null) { clearInterval(_waitingTimer); _waitingTimer = null; }
}

/** Clear every disconnect cue (game teardown / end). */
export function clearPresence() {
    setDimmedPlayers([]);
    hideSelfBanner();
    hideWaitingBanner();
}
