/**
 * Tiny shared flag for online (multiplayer) mode. Kept dependency-free so both
 * the command handler and the bot listener can import it without cycles.
 *
 * In online mode the local game engine is used purely as a deterministic
 * renderer: the server decides each dice value and token choice, the client
 * replays them through the normal command/event pipeline, and local authority
 * (dice RNG, bot autoplay, turn decisions) is suppressed or rerouted.
 */

let _active = false;
let _net = null;   // NetClient
let _seat = -1;    // this client's server seat index
let _offset = 0;   // server seat -> local board index = (seat + offset) % 4

// The local player always sits at board position 2 (bottom-right) in their own
// colour; everyone else fills the remaining corners, rotated to keep turn order.
export const SELF_LOCAL = 2;

export function setOnline(net, seat) {
    _active = true;
    _net = net;
    _seat = seat;
    _offset = (SELF_LOCAL - seat + 4) % 4;
}

export function clearOnline() {
    _active = false;
    _net = null;
    _seat = -1;
    _offset = 0;
}

/** Server seat index -> local board position (the renderer's player index). */
export function toLocal(serverIndex) {
    return (serverIndex + _offset) % 4;
}

/** Local board position -> server seat index. */
export function toServer(localIndex) {
    return (localIndex - _offset + 4) % 4;
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
