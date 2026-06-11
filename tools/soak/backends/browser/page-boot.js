/**
 * In-browser soak client boot — runs in a REAL Chromium tab (real WebSocket, real
 * requestAnimationFrame, real microtask loop) against the fixture board served by
 * the soak static server. This is the high-fidelity repro path: it exercises the
 * visible-tab animation code that the happy-dom worker (which runs hidden) skips.
 *
 * It mirrors SoakClient: connect → handle lobby/seated → on first started
 * snapshot startOnlineGame → feed every frame to the REAL handleOnlineMessage →
 * sample the reconciled client belief after the chain drains → ship frames +
 * observations to Node via the exposed window.__soakEmit binding. Node runs the
 * comparator (DesyncTracker) and drives roll/move through window.__soak* hooks.
 *
 * Served at /__soak/boot.mjs; imports the real app modules from the web root.
 */
import { NetClient } from '/scripts/net/net-client.js';
import { startOnlineGame, handleOnlineMessage } from '/scripts/net/online-game.js';
import { toServer } from '/scripts/net/online-state.js';
import { state } from '/scripts/state/game-state.js';
import { getTurnCount } from '/scripts/render/render-logic.js';

const q = new URLSearchParams(location.search);
const emit = (o) => { try { window.__soakEmit(o); } catch { /* binding not ready */ } };
const FLUSH_TICKS = Number(q.get('flushTicks') || 6);

// Present as a backgrounded tab so render-logic's animation paths fast-forward
// (resolve immediately) — this both gives an accurate post-frame sample AND is
// the exact backgrounded/throttled code path the reported desync occurs on, now
// exercised by a REAL browser engine (catching anything happy-dom would mask).
try {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
} catch { /* locked in some builds — non-fatal */ }

let seat = -1;
let started = false;
let seq = 0;
let queue = [];
let pumping = false;
let latestServer = null;
let lastReason = null;

const client = new NetClient({
    url: q.get('server'),
    room: q.get('room'),
    session: q.get('session'),
    name: q.get('name') || 'B',
    params: { size: q.get('size') || '2', seed: q.get('seed') || '1' },
    onMessage,
});

// Hooks Node drives.
window.__soakStart = () => { try { client.start(); } catch {} };
window.__soakRoll = () => { try { client.roll(); } catch {} };
window.__soakMove = (t) => { try { client.move(t); } catch {} };
window.__soakReady = true;
client.connect();

function onMessage(msg) {
    if (msg.t === 'seated') { seat = msg.playerIndex; emit({ type: 'seated', seat, isHost: !!msg.isHost }); return; }
    if (msg.t === 'busy') { emit({ type: 'busy', reason: msg.reason }); return; }
    if (msg.t === 'rejected' || msg.t === 'error') { emit({ type: 'rejected', error: msg.error }); return; }
    if (!started) {
        if (msg.t === 'state' && msg.state) {
            if (msg.state.started) {
                started = true;
                startOnlineGame({ net: client, seat, state: msg.state });
                emit({ type: 'started', seat });
            } else { emit({ type: 'lobby', seat, hostSeat: msg.state.hostSeat }); return; }
        } else { return; }
    }
    queue.push(msg);
    pump();
}

async function pump() {
    if (pumping) return;
    pumping = true;
    try {
        while (queue.length) await processFrame(queue.shift());
    } finally { pumping = false; }
}

async function processFrame(msg) {
    seq++;
    latestServer = msg.state || latestServer;
    lastReason = msg.reason || (msg.t === 'moved' ? 'moved' : null);
    const s = msg.state;
    const cur = s?.currentPlayerIndex;
    emit({
        type: 'frame', seq, seat, t: msg.t, reason: lastReason,
        turn: s?.turn, cur, dice: s?.dice, phase: s?.phase, legalMoves: s?.legalMoves,
        curPos: (cur != null && s?.positions?.[cur]) ? s.positions[cur].slice() : null,
    });
    try { handleOnlineMessage(msg); } catch (e) { emit({ type: 'pipeline-error', message: String(e && e.message || e) }); }
    for (let i = 0; i < FLUSH_TICKS; i++) await new Promise((r) => setTimeout(r, 0));
    sample(msg.t === 'ended' || s?.phase === 'ENDED');
}

function sample(ended) {
    if (!latestServer) return;
    const localToSeat = [toServer(0), toServer(1), toServer(2), toServer(3)];
    emit({
        type: 'observation', seq, ended, reason: lastReason,
        server: latestServer,
        client: {
            seat, localToSeat,
            currentPlayerIndexLocal: state.currentPlayerIndex,
            turnCountDisplayed: getTurnCount(),
            turnCountState: state.turnCount,
            dice: state.currentDiceRoll,
            phase: state.phase,
            positionsLocal: state.playerTokenPositions.map((p) => (p ? p.slice() : null)),
        },
    });
    if (ended) emit({ type: 'ended', seq });
}
