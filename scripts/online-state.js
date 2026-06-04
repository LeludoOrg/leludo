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

// Seat → board-position mapping mirrors offline play (HUMAN_PREFERRED_POSITIONS,
// shared with game-logic so the two never drift): the local player always sits
// at board position 2 (bottom-right) in their own colour, the next player
// top-left (0), then 1 and 3 — exactly the diagonal-first layout offline uses.
//
// Crucially, seats are ranked among the *occupied* seats (cyclically from self),
// NOT by raw seat number. A 2-player match can land on adjacent server seats
// (e.g. 0 and 1); raw modulo-4 ranking would put seat 1's view of seat 0 at
// rank 3 → board position 3 (bottom-left), breaking the diagonal for that
// player. Ranking over the active turn order makes the opponent rank 1 →
// top-left for BOTH players, matching offline (which assigns the first N
// preferred positions to N players). This is NOT a pure rotation, so the server
// (not the client) stays authoritative for whose turn it is — the online driver
// re-syncs currentPlayerIndex from each broadcast.
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

/** Rank of a server seat in the active turn order, counted from self (0 = me). */
function rankFromSelf(serverIndex) {
    const n = _activeSeats.length;
    const selfPos = _activeSeats.indexOf(_seat);
    const idx = _activeSeats.indexOf(serverIndex);
    // Fallback for seats not in the active set (shouldn't happen in play).
    if (selfPos < 0 || idx < 0) return (serverIndex - _seat + 4) % 4;
    return (idx - selfPos + n) % n;
}

/** Server seat index -> local board position (the renderer's player index). */
export function toLocal(serverIndex) {
    return HUMAN_PREFERRED_POSITIONS[rankFromSelf(serverIndex)];
}

/** Local board position -> server seat index. */
export function toServer(localIndex) {
    const rank = HUMAN_PREFERRED_POSITIONS.indexOf(localIndex);
    const n = _activeSeats.length;
    const selfPos = _activeSeats.indexOf(_seat);
    if (selfPos < 0) return (_seat + rank) % 4;
    return _activeSeats[(selfPos + rank) % n];
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
