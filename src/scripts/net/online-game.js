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
import { dispatch, subscribe, EVENTS } from '../state/game-store.js';
import { COMMANDS } from '../state/command-handler.js';
import { setOnline, clearOnline, onlineNet, toLocal, onlineSeat } from './online-state.js';
import { setDimmedPlayers, clearPresence } from './net-overlay.js';
import { MSG, REASON } from './net-protocol.js';

let _started = false;
let _chain = Promise.resolve();

function enqueue(makeStep) {
    _chain = _chain.then(makeStep).catch(e => console.error('[online] step failed', e));
    return _chain;
}

/**
 * Map a server snapshot onto local board positions for this client.
 *
 * toLocal rotates the shared seat arrangement so this client sits bottom-right
 * (board pos 2) in its own colour, and a 2-player match on adjacent server seats
 * still seats the opponent diagonally for BOTH players (see online-state). Map
 * ALL FOUR chairs — player or empty — through it: toLocal is a bijection, so the
 * colour map comes out a full permutation that's identical across clients up to
 * the per-client rotation (no empty quad ever repeats an active colour, and the
 * empty quads agree on their corners). Pure apart from setOnline; exported for tests.
 */
export function buildSeatLayout(net, seat, state) {
    const activeSeats = [];
    for (let s = 0; s < 4; s++) if (state.playerTypes[s] != null) activeSeats.push(s);
    setOnline(net, seat, activeSeats);

    const playerTypes = new Array(4).fill(undefined);
    const playerNames = new Array(4).fill('');
    const positions = new Array(4).fill(undefined);
    const colorMap = new Array(4).fill(-1);
    for (let s = 0; s < 4; s++) {
        const pos = toLocal(s);
        colorMap[pos] = s; // a seat's index doubles as its base-colour index
        if (state.playerTypes[s] == null) continue;
        playerTypes[pos] = state.playerTypes[s];
        playerNames[pos] = state.playerNames[s];
        positions[pos] = state.positions[s];
    }

    return { playerTypes, playerNames, positions, colorMap };
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

/** Dim the opponents who are mid-reconnect (un-dims the rest) from a snapshot. */
function updateDimming(state) {
    const dim = (state.disconnects || [])
        .filter(d => d.index !== onlineSeat())
        .map(d => toLocal(d.index));
    setDimmedPlayers(dim);
}

/**
 * Map the server's seat-indexed board onto this client's local board indexes.
 * The per-token position VALUES are player-relative (0 = that seat's own
 * home-start), so they're identical across the remap — only the player slot
 * moves, exactly like buildSeatLayout. Returns a 4-slot array (undefined for
 * empty seats) suitable for NET_RECONCILE.
 */
function positionsToLocal(positions) {
    const local = new Array(4).fill(undefined);
    if (!Array.isArray(positions)) return local;
    for (let s = 0; s < 4; s++) {
        if (positions[s]) local[toLocal(s)] = positions[s].slice();
    }
    return local;
}

/**
 * Fold the server's authoritative board snapshot back into the local render.
 * Enqueued AFTER the frame's delta so it runs once the move animation settles;
 * a no-op unless the replay drifted (see netReconcile in command-handler).
 */
function reconcile(state) {
    enqueue(() => dispatch({ type: COMMANDS.NET_RECONCILE, positions: positionsToLocal(state.positions) }));
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
    if (msg.t === MSG.STATE) {
        if (!msg.state.started) return;
        // Dim opponents who are mid-reconnect (the game plays on without them).
        updateDimming(msg.state);
        // The server is authoritative for whose turn it is AND for the turn
        // number. The seat→board mapping is diagonal-first (not a pure rotation),
        // so the local engine's own round-robin can drift from the server's —
        // re-sync currentPlayerIndex (and the "Turn N" count, which a client's own
        // replay would otherwise undercount on a missed turn) from every broadcast.
        enqueue(() => dispatch({
            type: COMMANDS.NET_SYNC_TURN,
            playerIndex: toLocal(msg.state.currentPlayerIndex),
            turnCount: msg.state.turn,
        }));
        // A roll happened iff the broadcast carries a fresh dice result.
        if (msg.reason === REASON.ROLLED || msg.reason === REASON.NO_MOVE || msg.reason === REASON.THREE_SIXES) {
            const value = msg.state.dice;
            enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_ROLL, value }));
        }
        // Snap to the authoritative board. Critical on reason=RECONNECT, whose
        // snapshot is the ONLY catch-up for the `moved` frames missed while the
        // socket was down — but harmless (and self-healing) on every frame.
        reconcile(msg.state);
    } else if (msg.t === MSG.MOVED) {
        enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_MOVE, playerIndex: toLocal(msg.p), tokenIndex: msg.token }));
        // The move's captures are re-derived locally from this client's board, so
        // any prior drift makes the wrong pawns go home (or none). Reconcile to the
        // server's post-move positions — which already reflect its authoritative
        // captures — so the result converges even when the replay diverged.
        reconcile(msg.state);
    } else if (msg.t === MSG.DROPPED) {
        // A player's reconnect window elapsed: pull their pawns off the board.
        if (msg.state) updateDimming(msg.state);
        enqueue(() => dispatch({ type: COMMANDS.NET_DROP_PLAYER, playerIndex: toLocal(msg.seat) }));
    } else if (msg.t === MSG.ENDED) {
        // The game is over. A disconnect end has no finishing move; a finish end
        // does — but the client may have MISSED that final `moved` frame (a 1s
        // socket blip, a swallowed animation error, an rAF wedge at that instant),
        // leaving it one step short and stuck in AWAITING_* with the wrong board.
        // The ENDED frame is the last word and carries the authoritative positions
        // + ranks for EVERY reason, so reconcile to that board AND drive the end
        // screen unconditionally. Both NET_RECONCILE and NET_END no-op once the
        // client already reached GAME_ENDED, so a client that DID replay the finish
        // is left untouched (no double mount); only a desynced client is corrected.
        clearPresence();
        if (msg.state) reconcile(msg.state);
        const { local, winnerIndex } = ranksToLocal(msg.ranks);
        enqueue(() => dispatch({ type: COMMANDS.NET_END, playerRanks: local, winnerIndex }));
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
