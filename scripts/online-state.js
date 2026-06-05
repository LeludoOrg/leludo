/**
 * Tiny shared flag for online (multiplayer) mode. Kept light so both the command
 * handler and the bot listener can import it without cycles.
 *
 * In online mode the local game engine is used purely as a deterministic
 * renderer: the server decides each dice value and token choice, the client
 * replays them through the normal command/event pipeline, and local authority
 * (dice RNG, bot autoplay, turn decisions) is suppressed or rerouted.
 */
import { HUMAN_PREFERRED_POSITIONS } from './game-logic.js';

let _active = false;
let _net = null;        // NetClient
let _seat = -1;         // this client's server seat index
let _activeSeats = [];  // occupied server seats, ascending (the turn order)

// Seat → board-position mapping. Board corners (renderer player indexes):
// 0=top-left, 1=top-right, 2=bottom-right, 3=bottom-left. The local player
// always renders bottom-right (2) in their own colour.
//
// THE MODEL: four fixed chairs in a ring, visited in turn order
// (server seat 0 → 1 → 2 → 3 → 0). Each client rotates the whole ring so its own
// chair sits bottom-right. So a chair's board position is decided by its raw
// cyclic distance from self over ALL FOUR chairs — not by ranking the occupied
// chairs only. That distinction is the whole ball game:
//
//   • Rank over OCCUPIED chairs and you collapse the gaps — the empty chairs get
//     dumped wherever's left over, so which players flank an empty seat differs
//     from screen to screen (the 3-player bug: blue/empty's neighbours drifted).
//   • Rank over ALL FOUR chairs and every chair — player or empty — lands in its
//     true rotational slot, so all clients render the identical ring (including
//     where the empty chair sits relative to its neighbours), just rotated.
//
// The clockwise walk matches the board's play order: home-start squares
// 0,13,26,39 (= 13·boardPos) advance clockwise around the track, so chair at
// cyclic distance r from self sits r corners clockwise from bottom-right:
//   distance 0 → BR(2), 1 → BL(3), 2 → TL(0), 3 → TR(1)   i.e. (2 + r) % 4.
//
// 1-2 PLAYERS are the one exception. The matchmaker can seat a 2-player match on
// ADJACENT server chairs (e.g. 0 and 1); a pure rotation would then render them
// side-by-side. We want the classic diagonal head-to-head, so for ≤2 players we
// rank over the occupied chairs and spread them: self → BR(2), opponent → TL(0).
// (With only two perspectives both see the opponent top-left, so it stays
// consistent.) Empty chairs aren't ranked here — buildSeatLayout only maps the
// occupied chairs and fillColorMap paints the leftover quads.
//
// The mapping is NOT a single modulo rotation across all counts (≤2 players
// spread for the diagonal look), so the server — not the client — stays
// authoritative for whose turn it is; the online driver re-syncs
// currentPlayerIndex from each broadcast.
export const SELF_LOCAL = HUMAN_PREFERRED_POSITIONS[0]; // 2 (bottom-right)

export function setOnline(net, seat, activeSeats) {
    _active = true;
    _net = net;
    _seat = seat;
    _activeSeats = (activeSeats && activeSeats.length)
        ? activeSeats.slice().sort((a, b) => a - b)
        : [0, 1, 2, 3];
}

export function clearOnline() {
    _active = false;
    _net = null;
    _seat = -1;
    _activeSeats = [];
}

/** Rank of a server seat among the OCCUPIED chairs, counted from self (0 = me).
 *  Used only for the ≤2-player diagonal spread. */
function rankFromSelf(serverIndex) {
    const n = _activeSeats.length;
    const selfPos = _activeSeats.indexOf(_seat);
    const idx = _activeSeats.indexOf(serverIndex);
    // Fallback for seats not in the active set (shouldn't happen in play).
    if (selfPos < 0 || idx < 0) return (serverIndex - _seat + 4) % 4;
    return (idx - selfPos + n) % n;
}

/** True when the match is a ≤2-player head-to-head (diagonal spread, not a ring). */
function isHeadToHead() {
    return _activeSeats.length <= 2;
}

/** Server seat index -> local board position (the renderer's player index). */
export function toLocal(serverIndex) {
    // ≤2 players: spread the two occupied chairs diagonally (self BR, opponent TL).
    if (isHeadToHead()) return rankFromSelf(serverIndex) === 0 ? 2 : 0;
    // 3-4 players: rotate the full four-chair ring so self sits bottom-right and
    // every chair (player or empty) keeps its true cyclic slot.
    const distance = (serverIndex - _seat + 4) % 4;
    return (2 + distance) % 4;
}

/** Local board position -> server seat index. */
export function toServer(localIndex) {
    if (isHeadToHead()) {
        const rank = localIndex === SELF_LOCAL ? 0 : 1;
        const n = _activeSeats.length;
        const selfPos = _activeSeats.indexOf(_seat);
        if (selfPos < 0) return (_seat + rank) % 4;
        return _activeSeats[(selfPos + rank) % n];
    }
    // Inverse of the ring rotation: board pos 2 = self, then clockwise.
    const distance = (localIndex - 2 + 4) % 4;
    return (_seat + distance) % 4;
}

/** This client's local board position (always bottom-right). */
export function onlineLocalSelf() {
    return SELF_LOCAL;
}

export function isOnlineActive() {
    return _active;
}

export function onlineNet() {
    return _net;
}

export function onlineSeat() {
    return _seat;
}
