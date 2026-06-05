/**
 * Connection-issues overlay for online play. Two modes share one element
 * (#net-disconnect-overlay):
 *   - peer: one or more opponents are mid-reconnect. Show a live countdown of
 *     the soonest forfeit deadline (the server sends remaining ms per peer).
 *   - self: this client lost its own socket. Show a "reconnecting…" notice while
 *     net-client retries (no server countdown — there's no link to hear it on).
 *
 * Peer state is driven by online-game from server broadcasts; self state by the
 * net-client reconnect callbacks wired in wc-quick-start. Pure DOM, no imports,
 * resilient when the element is absent (headless tests).
 */
let _tick = null;
let _peers = [];

function overlay() { return document.getElementById('net-disconnect-overlay'); }

function setText(testid, text) {
    const el = overlay()?.querySelector(`[data-testid="${testid}"]`);
    if (el) el.textContent = text;
}

function stopTick() { if (_tick) { clearInterval(_tick); _tick = null; } }

function renderPeers() {
    const o = overlay();
    if (!o) return;
    o.classList.remove('hidden');
    o.dataset.mode = 'peer';
    const names = _peers.map(p => p.name).join(', ');
    const soonest = Math.min(..._peers.map(p => p.remainingMs));
    const secs = Math.max(0, Math.ceil(soonest / 1000));
    setText('net-dc-title', _peers.length > 1 ? 'Players reconnecting' : 'Connection issues');
    setText('net-dc-msg', _peers.length > 1
        ? `Waiting for ${names} to reconnect…`
        : `${names || 'A player'} lost connection. Waiting for them to reconnect…`);
    setText('net-dc-timer', `${secs}s`);
}

/** Show/refresh the opponent-reconnecting overlay. Empty list hides it. */
export function showPeerReconnect(list) {
    _peers = (list || [])
        .filter(p => p && p.remainingMs > 0)
        .map(p => ({ name: p.name || 'A player', remainingMs: Math.max(0, p.remainingMs) }));
    if (_peers.length === 0) { hideOverlay(); return; }
    renderPeers();
    stopTick();
    _tick = setInterval(() => {
        _peers = _peers.map(p => ({ ...p, remainingMs: Math.max(0, p.remainingMs - 1000) }));
        renderPeers();
    }, 1000);
}

/** This client lost its own connection; net-client is retrying. */
export function showSelfReconnect() {
    const o = overlay();
    if (!o) return;
    stopTick();
    _peers = [];
    o.classList.remove('hidden');
    o.dataset.mode = 'self';
    setText('net-dc-title', 'Connection lost');
    setText('net-dc-msg', 'Trying to reconnect you to the game…');
    setText('net-dc-timer', '');
}

/** Reconnect attempts exhausted — the seat will be forfeited server-side. */
export function showSelfGaveUp() {
    const o = overlay();
    if (!o) return;
    stopTick();
    _peers = [];
    o.classList.remove('hidden');
    o.dataset.mode = 'self';
    setText('net-dc-title', 'Disconnected');
    setText('net-dc-msg', "Couldn't reconnect to the game.");
    setText('net-dc-timer', '');
}

export function hideOverlay() {
    stopTick();
    _peers = [];
    overlay()?.classList.add('hidden');
}
