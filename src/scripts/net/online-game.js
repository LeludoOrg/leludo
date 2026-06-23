/**
 * Online game driver — bridges server broadcasts to the local board renderer.
 *
 * THE MODEL: the server is authoritative for everything; the client is a
 * projector. Every broadcast frame carries the room's full snapshot (positions,
 * phase, whose turn, dice, legal moves, captures, ranks) plus the delta that
 * produced it (the dice value rolled, the token moved, the pawns captured).
 * For each frame the driver:
 *
 *   1. plays the delta as a cosmetic animation (dice spin, pawn glide, capture
 *      flight) driven ONLY by the frame payload — nothing is re-derived from
 *      the local board, and no local guard (pause, phase, movability) may drop
 *      it; the server already validated the action, and
 *   2. applies the snapshot unconditionally (NET_SYNC_STATE) — the last word.
 *
 * So even if an animation step goes sideways, every frame converges the client
 * onto the server's exact state; drift can never outlive the frame it started
 * in. Frames are processed through a serial promise queue so animations play
 * in order; `seq` (stamped by the server) drops duplicate/stale frames, and a
 * backlog (hidden tab, reconnect catch-up) replays state-only — just the
 * newest frame animates.
 *
 * Local authority (RNG, bot autoplay, turn decisions, the human's own taps) is
 * suppressed or rerouted to the server (see command-handler + bot-listener +
 * online-state).
 */
import { dispatch, subscribe, EVENTS } from '../state/game-store.js';
import { COMMANDS } from '../state/command-handler.js';
import { setOnline, clearOnline, onlineNet, toLocal, onlineSeat } from './online-state.js';
import { setDimmedPlayers, clearPresence, showWaitingFor, hideWaitingBanner } from './net-overlay.js';
import { MSG, REASON } from './net-protocol.js';

// How many newer animatable deltas (dice spins + pawn glides) may already be
// queued and STILL let an older delta play its animation. The serial queue plays
// every frame in order; the question is only whether a delta animates (dice spin
// / cell-by-cell glide) or snaps (instant) to catch up. We tolerate a backlog so
// transient bunching (a bot rolling-and-moving in one beat, a plays-again chain,
// a brief network stall) plays out smoothly, and only fast-forward once the board
// is genuinely stale — more than this many deltas behind the freshest one (a
// hidden tab, a reconnect, a long burst). Bounded by design: snapping the excess
// keeps live-lag at ~this many deltas, so it can't compound into an ever-growing
// replay backlog.
const MAX_DELTA_BACKLOG = 10;

let _started = false;
let _chain = Promise.resolve();
// Highest seq applied — frames at or below it are duplicates/stale and dropped.
let _appliedSeq = 0;
// Running count of animatable delta frames (rolls + moves) RECEIVED. A delta
// animates while the number of deltas received after it (_deltasReceived − its
// ordinal) is within MAX_DELTA_BACKLOG; past that it snaps. Rolls and moves share
// one counter so a roll spin and the move that follows it both play, and a real
// burst still fast-forwards.
let _deltasReceived = 0;
// The newest state-bearing frame, kept so a REJECTED intent can re-apply the
// authoritative snapshot immediately instead of waiting for the next broadcast.
let _lastState = null;

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

// A native WebView freezes its JS (and lets its socket die) while backgrounded,
// so we can't keep the connection warm from inside — the moment we're back is
// our first chance to act. On every foreground signal, poke the live socket to
// redial NOW instead of waiting out the dead-socket detection + backoff, which
// otherwise burns the server's reconnect grace (and on a long freeze forfeits
// the seat). reconnectNow() no-ops on a healthy socket, so firing this on any
// resume is safe. Installed once; harmless when no online game is running.
function onForeground() {
    if (!_started) return;
    try { onlineNet()?.reconnectNow?.(); } catch { /* best effort */ }
}

let _foregroundWired = false;
function wireForegroundReconnect() {
    if (_foregroundWired) return;
    _foregroundWired = true;
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) onForeground(); });
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('online', onForeground); // network came back
        window.addEventListener('focus', onForeground);
        // Capacitor native lifecycle: the reliable Android/iOS foreground signal
        // (visibilitychange is flaky in a WebView). Mirrors nav-history's plugin
        // access; absent on web, where the listeners above cover it.
        const App = window.Capacitor?.Plugins?.App;
        App?.addListener?.('resume', onForeground);
        App?.addListener?.('appStateChange', (s) => { if (s?.isActive) onForeground(); });
    }
}

/** Hand off from the lobby: mount the board from the first started snapshot. */
export function startOnlineGame({ net, seat, state, seq }) {
    wireForegroundReconnect();
    const layout = buildSeatLayout(net, seat, state);
    _started = true;
    _chain = Promise.resolve();
    _appliedSeq = seq || 0;
    _deltasReceived = 0;
    _lastState = state;

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
 * Show/hide the "waiting for X to reconnect" banner from a snapshot. The
 * server holds the game whenever the turn is on a disconnected human
 * (state.waiting) — turns are never skipped — so every player should see who
 * the game is blocked on and the countdown to that seat's forfeit.
 */
function updatePresence(state) {
    updateDimming(state);
    const held = state.waiting
        ? (state.disconnects || []).find(d => d.index === state.currentPlayerIndex)
        : null;
    if (held && held.index !== onlineSeat()) {
        showWaitingFor(held.name, held.remainingMs);
    } else {
        hideWaitingBanner();
    }
}

/**
 * Map a server seat-indexed 4-slot array onto this client's local board
 * indexes. Per-token position VALUES are player-relative (0 = that seat's own
 * home-start), so only the player slot moves — exactly like buildSeatLayout.
 */
function seatsToLocal(arr, mapValue = (v) => v) {
    const local = new Array(4).fill(undefined);
    if (!Array.isArray(arr)) return local;
    for (let s = 0; s < 4; s++) local[toLocal(s)] = mapValue(arr[s]);
    return local;
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

/** Build the NET_SYNC_STATE command for a server snapshot, mapped to local. */
function syncCommand(state) {
    return {
        type: COMMANDS.NET_SYNC_STATE,
        positions: seatsToLocal(state.positions, p => (p ? p.slice() : undefined)),
        playerTypes: seatsToLocal(state.playerTypes, t => t ?? undefined),
        currentPlayerIndex: toLocal(state.currentPlayerIndex),
        turnCount: state.turn,
        dice: state.dice,
        phase: state.phase,
        legalMoves: state.legalMoves, // token indexes are per-player: no remap
        captures: seatsToLocal(state.captures, c => c ?? 0),
        ranks: seatsToLocal(state.ranks, r => r ?? 0),
    };
}

/** A roll happened iff the broadcast carries a freshly-resolved dice value. */
function isRollReason(reason) {
    return reason === REASON.ROLLED || reason === REASON.NO_MOVE || reason === REASON.THREE_SIXES;
}

/**
 * A frame carries a visual delta the player should SEE play out: a pawn glide
 * (MOVED) or a dice spin (a roll-reason STATE). Turn/again/reconnect snapshots,
 * drops and ends have no motion of their own — they must not advance the
 * "newest animatable frame" marker, or the move they trail gets skipped.
 */
function isDeltaFrame(msg) {
    return msg.t === MSG.MOVED || (msg.t === MSG.STATE && isRollReason(msg.reason));
}

/**
 * One frame, start to finish: cosmetic delta first, authoritative snapshot
 * last. `animate` is false only when the board is genuinely stale — more than
 * MAX_DELTA_BACKLOG deltas behind the freshest one (a hidden tab, a reconnect, a
 * long burst) — in which case state applies and visuals snap to catch up. A
 * transient backlog still plays out; see MAX_DELTA_BACKLOG / _deltasReceived.
 */
async function applyFrame(msg, deltaOrdinal) {
    // A delta (dice spin or pawn glide) plays while it's within MAX_DELTA_BACKLOG
    // of the freshest delta received; a deeper backlog snaps to catch up. Frames
    // with no ordinal — no seq (untracked) or a non-delta turn snapshot (no
    // animation of its own) — always "animate" (the flag is unused for them).
    const animate = deltaOrdinal === 0
        ? true
        : (_deltasReceived - deltaOrdinal) <= MAX_DELTA_BACKLOG;
    const state = msg.state;

    if (msg.t === MSG.STATE) {
        updatePresence(state);
        if (isRollReason(msg.reason)) {
            await dispatch({ type: COMMANDS.NET_APPLY_ROLL, value: state.dice, animate });
        }
    } else if (msg.t === MSG.MOVED) {
        await dispatch({
            type: COMMANDS.NET_APPLY_MOVE,
            playerIndex: toLocal(msg.p),
            tokenIndex: msg.token,
            fromPosition: msg.from,
            toPosition: msg.to,
            captures: (msg.caps || []).map(c => ({
                playerIndex: toLocal(c.playerIndex),
                tokenIndex: c.tokenIndex,
            })),
            animate,
        });
    } else if (msg.t === MSG.DROPPED) {
        if (state) updatePresence(state);
        await dispatch({ type: COMMANDS.NET_DROP_PLAYER, playerIndex: toLocal(msg.seat) });
    } else if (msg.t === MSG.ENDED) {
        clearPresence();
    }

    // The snapshot is the last word on EVERY frame — positions, phase, turn,
    // dice, movable tokens. Whatever the delta animation replayed (or skipped:
    // a pause, a guard, an animation error), the client lands on server truth.
    if (state) await dispatch(syncCommand(state));

    if (msg.t === MSG.ENDED) {
        // The end frame may be the client's ONLY notice of the finish (the final
        // `moved` can be lost to a socket blip). The snapshot above already
        // snapped the board; this mounts the end screen with the server's ranks.
        const { local, winnerIndex } = ranksToLocal(msg.ranks);
        await dispatch({ type: COMMANDS.NET_END, playerRanks: local, winnerIndex });
    }
}

/** Feed a server broadcast into the renderer. */
export function handleOnlineMessage(msg) {
    if (!_started) return;
    switch (msg.t) {
        case MSG.STATE:
            if (!msg.state?.started) return;
            // falls through
        case MSG.MOVED:
        case MSG.DROPPED:
        case MSG.ENDED: {
            // Drop duplicates/stale frames (zombie socket racing a reconnect),
            // then stamp each animatable delta (roll or move) with its arrival
            // ordinal so applyFrame can tell, at animate-time, how many newer
            // deltas have since piled up behind it.
            let deltaOrdinal = 0;
            if (msg.seq != null) {
                if (msg.seq <= _appliedSeq) return;
                _appliedSeq = msg.seq;
                if (isDeltaFrame(msg)) deltaOrdinal = ++_deltasReceived;
            }
            if (msg.state) _lastState = msg.state;
            enqueue(() => applyFrame(msg, deltaOrdinal));
            break;
        }
        case MSG.REJECTED: {
            // The server refused one of OUR intents — the local view that made
            // the intent look legal is off. Re-apply the newest snapshot so the
            // phase/turn/affordances self-heal now, not a turn later.
            if (_lastState) {
                const snap = _lastState;
                enqueue(() => dispatch(syncCommand(snap)));
            }
            break;
        }
        default:
            break;
    }
}

export function isOnlineGameStarted() {
    return _started;
}

function stopOnlineGame() {
    if (!_started) return;
    _started = false;
    _lastState = null;
    clearPresence();
    try { onlineNet()?.close(); } catch { /* ignore */ }
    clearOnline();
}

// Exiting to home (and restart) emit GAME_RESTARTED — tear down the online
// session then so the socket closes and local mode is restored.
subscribe((event) => {
    if (event.type === EVENTS.GAME_RESTARTED) stopOnlineGame();
});
