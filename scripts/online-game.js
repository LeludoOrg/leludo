/**
 * Online game driver — bridges server broadcasts to the local board renderer.
 *
 * The local game engine is deterministic given (positions, dice, tokenIndex),
 * so online play reuses it wholesale: we inject only the server's authoritative
 * dice value (NET_APPLY_ROLL) and token choice (NET_APPLY_MOVE) and let the
 * normal command/event pipeline animate the move, resolve captures, advance the
 * turn, rank players and mount the end screen — exactly as in a local game.
 * Local authority (RNG, bot autoplay, the human's own taps) is suppressed or
 * rerouted to the server (see command-handler + bot-listener + online-state).
 *
 * Messages are processed through a promise queue so each roll's animation
 * finishes before the following move renders, even when the server sends a
 * roll + forced move back-to-back.
 */
import { dispatch, subscribe, EVENTS } from './game-store.js';
import { COMMANDS } from './command-handler.js';
import { setOnline, clearOnline, onlineNet, toLocal, onlineSeat } from './online-state.js';
import { fillColorMap } from './game-logic.js';
import { setDimmedPlayers, clearPresence } from './net-overlay.js';

let _started = false;
let _chain = Promise.resolve();

function enqueue(makeStep) {
    _chain = _chain.then(makeStep).catch(e => console.error('[online] step failed', e));
    return _chain;
}

/**
 * Map a server snapshot onto local board positions for this client.
 *
 * Rank seats among the occupied ones (the turn order) so a 2-player match on
 * adjacent server seats still seats the opponent diagonally for BOTH players —
 * not just the host (see online-state.toLocal). The colour map is completed into
 * a permutation (fillColorMap) so empty quads never repeat an active player's
 * colour. Pure apart from setOnline; exported for tests.
 */
export function buildSeatLayout(net, seat, state) {
    const activeSeats = [];
    for (let s = 0; s < 4; s++) if (state.playerTypes[s] != null) activeSeats.push(s);
    setOnline(net, seat, activeSeats);

    // Rotate server seats to board positions so this client sits bottom-right
    // (board pos 2) in its own colour; a seat's index doubles as its base-colour
    // index, and leftover colours fill the empty quads.
    const playerTypes = new Array(4).fill(undefined);
    const playerNames = new Array(4).fill('');
    const positions = new Array(4).fill(undefined);
    const colorMap = new Array(4).fill(-1);
    for (const s of activeSeats) {
        const pos = toLocal(s);
        playerTypes[pos] = state.playerTypes[s];
        playerNames[pos] = state.playerNames[s];
        positions[pos] = state.positions[s];
        colorMap[pos] = s;
    }

    return { playerTypes, playerNames, positions, colorMap: fillColorMap(colorMap) };
}

/** Hand off from the lobby: mount the board from the first started snapshot. */
export function startOnlineGame({ net, seat, state }) {
    const layout = buildSeatLayout(net, seat, state);
    _started = true;
    _chain = Promise.resolve();

    enqueue(() => dispatch({
        type: COMMANDS.NET_START_GAME,
        ...layout,
        currentPlayerIndex: toLocal(state.currentPlayerIndex),
    }));
}

// Server end reasons that are NOT driven by a local finishing move — the end
// screen must be mounted explicitly (handleAfterTokenMove never ran).
const DISCONNECT_END_REASONS = new Set(['opponent-left', 'abandoned', 'no-active-players']);

/** Dim the opponents who are mid-reconnect (un-dims the rest) from a snapshot. */
function updateDimming(state) {
    const dim = (state.disconnects || [])
        .filter(d => d.index !== onlineSeat())
        .map(d => toLocal(d.index));
    setDimmedPlayers(dim);
}

/** Map the server's seat-indexed ranks onto local board positions. */
function ranksToLocal(ranks) {
    const local = [0, 0, 0, 0];
    let winnerIndex = -1;
    for (let seat = 0; seat < 4; seat++) {
        const r = ranks?.[seat] || 0;
        const li = toLocal(seat);
        local[li] = r;
        if (r === 1) winnerIndex = li;
    }
    return { local, winnerIndex };
}

/** Feed a server broadcast into the renderer. */
export function handleOnlineMessage(msg) {
    if (!_started) return;
    if (msg.t === 'state') {
        if (!msg.state.started) return;
        // Dim opponents who are mid-reconnect (the game plays on without them).
        updateDimming(msg.state);
        // The server is authoritative for whose turn it is. The seat→board
        // mapping is diagonal-first (not a pure rotation), so the local engine's
        // own round-robin can drift from the server's — re-sync currentPlayerIndex
        // from every broadcast before replaying anything.
        enqueue(() => dispatch({
            type: COMMANDS.NET_SYNC_TURN,
            playerIndex: toLocal(msg.state.currentPlayerIndex),
        }));
        // A roll happened iff the broadcast carries a fresh dice result.
        if (msg.reason === 'rolled' || msg.reason === 'no-move' || msg.reason === 'three-sixes') {
            const value = msg.state.dice;
            enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_ROLL, value }));
        }
    } else if (msg.t === 'moved') {
        enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_MOVE, playerIndex: toLocal(msg.p), tokenIndex: msg.token }));
    } else if (msg.t === 'dropped') {
        // A player's reconnect window elapsed: pull their pawns off the board.
        if (msg.state) updateDimming(msg.state);
        enqueue(() => dispatch({ type: COMMANDS.NET_DROP_PLAYER, playerIndex: toLocal(msg.seat) }));
    } else if (msg.t === 'ended') {
        // A finish-driven end already mounted the end screen via the normal move
        // path; only disconnect-driven ends need it mounted here.
        if (DISCONNECT_END_REASONS.has(msg.reason)) {
            clearPresence();
            const { local, winnerIndex } = ranksToLocal(msg.ranks);
            enqueue(() => dispatch({ type: COMMANDS.NET_END, playerRanks: local, winnerIndex }));
        }
    }
}

export function isOnlineGameStarted() {
    return _started;
}

function stopOnlineGame() {
    if (!_started) return;
    _started = false;
    clearPresence();
    try { onlineNet()?.close(); } catch { /* ignore */ }
    clearOnline();
}

// Exiting to home (and restart) emit GAME_RESTARTED — tear down the online
// session then so the socket closes and local mode is restored.
subscribe((event) => {
    if (event.type === EVENTS.GAME_RESTARTED) stopOnlineGame();
});
