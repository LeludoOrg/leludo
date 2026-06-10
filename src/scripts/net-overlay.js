/**
 * Online disconnect presence. When a player's connection drops the game keeps
 * going (the server skips their turn), so instead of a blocking overlay we just
 * DIM that player on the board until they reconnect or forfeit. If THIS client
 * is the one who dropped, a small non-blocking banner says we're reconnecting.
 *
 * Pure DOM, no imports, resilient when the elements are absent (headless tests).
 * Driven by online-game (peer dimming) and the net-client reconnect callbacks
 * wired in wc-quick-start (self banner).
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

/** Clear every disconnect cue (game teardown / end). */
export function clearPresence() {
    setDimmedPlayers([]);
    hideSelfBanner();
}
