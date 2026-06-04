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
let _net = null;   // NetClient
let _seat = -1;    // this client's server seat index

// Seat → board-position mapping mirrors offline play (HUMAN_PREFERRED_POSITIONS,
// shared with game-logic so the two never drift): the local player always sits
// at board position 2 (bottom-right) in their own colour, the next player
// top-left (0), then 1 and 3 — exactly the diagonal-first layout offline uses.
// Seats are ranked cyclically from the local player, so the k-th player after
// self (in server turn order) gets HUMAN_PREFERRED_POSITIONS[k]. This is NOT a
// pure rotation, so the server (not the client) is authoritative for whose turn
// it is — the online driver re-syncs currentPlayerIndex from each broadcast.
export const SELF_LOCAL = HUMAN_PREFERRED_POSITIONS[0]; // 2 (bottom-right)

export function setOnline(net, seat) {
    _active = true;
    _net = net;
    _seat = seat;
}

export function clearOnline() {
    _active = false;
    _net = null;
    _seat = -1;
}

/** Server seat index -> local board position (the renderer's player index). */
export function toLocal(serverIndex) {
    const rank = (serverIndex - _seat + 4) % 4;
    return HUMAN_PREFERRED_POSITIONS[rank];
}

/** Local board position -> server seat index. */
export function toServer(localIndex) {
    const rank = HUMAN_PREFERRED_POSITIONS.indexOf(localIndex);
    return (_seat + rank) % 4;
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
