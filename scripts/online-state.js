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
let _seat = -1;    // this client's player index

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

export function isOnlineActive() {
    return _active;
}

export function onlineNet() {
    return _net;
}

export function onlineSeat() {
    return _seat;
}
