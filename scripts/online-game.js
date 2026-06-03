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
import { setOnline, clearOnline, onlineNet } from './online-state.js';

let _started = false;
let _chain = Promise.resolve();

function enqueue(makeStep) {
    _chain = _chain.then(makeStep).catch(e => console.error('[online] step failed', e));
    return _chain;
}

/** Hand off from the lobby: mount the board from the first started snapshot. */
export function startOnlineGame({ net, seat, state }) {
    setOnline(net, seat);
    _started = true;
    _chain = Promise.resolve();
    enqueue(() => dispatch({
        type: COMMANDS.NET_START_GAME,
        playerTypes: state.playerTypes,
        playerNames: state.playerNames,
        positions: state.positions,
        currentPlayerIndex: state.currentPlayerIndex,
    }));
}

/** Feed a server broadcast into the renderer. */
export function handleOnlineMessage(msg) {
    if (!_started) return;
    if (msg.t === 'state') {
        // A roll happened iff the broadcast carries a fresh dice result.
        if (msg.reason === 'rolled' || msg.reason === 'no-move' || msg.reason === 'three-sixes') {
            const value = msg.state.dice;
            enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_ROLL, value }));
        }
    } else if (msg.t === 'moved') {
        enqueue(() => dispatch({ type: COMMANDS.NET_APPLY_MOVE, playerIndex: msg.p, tokenIndex: msg.token }));
    }
    // 'ended' needs no action: the local move that finished the game already
    // mounted the end screen via the normal handleAfterTokenMove path.
}

export function isOnlineGameStarted() {
    return _started;
}

function stopOnlineGame() {
    if (!_started) return;
    _started = false;
    try { onlineNet()?.close(); } catch { /* ignore */ }
    clearOnline();
}

// Exiting to home (and restart) emit GAME_RESTARTED — tear down the online
// session then so the socket closes and local mode is restored.
subscribe((event) => {
    if (event.type === EVENTS.GAME_RESTARTED) stopOnlineGame();
});
