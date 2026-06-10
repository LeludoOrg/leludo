/**
 * Tiny shared flag for online (multiplayer) mode. Kept light so both the command
 * handler and the bot listener can import it without cycles.
 *
 * In online mode the local game engine is used purely as a deterministic
 * renderer: the server decides each dice value and token choice, the client
 * replays them through the normal command/event pipeline, and local authority
 * (dice RNG, bot autoplay, turn decisions) is suppressed or rerouted.
 */
import { HUMAN_PREFERRED_POSITIONS } from '../core/game-logic.js';

let _active = false;
let _net = null;        // NetClient
let _seat = -1;         // this client's server seat index
let _activeSeats = [];  // occupied server seats, ascending (the turn order)

// Seat → board-position mapping. Board corners (renderer player indexes):
// 0=top-left, 1=top-right, 2=bottom-right, 3=bottom-left. The local player
// always renders bottom-right (2) in their own colour.
//
// THE MODEL: every client agrees on ONE board ARRANGEMENT — a fixed map from
// server seat to canonical corner — then rotates it so its own chair sits
// bottom-right. Rendering each client as a PURE ROTATION of one shared
// arrangement is the whole ball game: a pawn — and every quad colour, player or
// empty — then lands in the same place relative to the board on every screen,
// just rotated.   toLocal(s) = (arrangement[s] - arrangement[self] + 2) % 4.
//
//   • 3-4 players: the arrangement is the IDENTITY. Server seats already form a
//     ring in turn order (0→1→2→3), so the per-client rotation is a clockwise
//     walk from self (BR→BL→TL→TR), matching the track's play order — home-start
//     squares 0,13,26,39 (= 13·boardPos) advance clockwise.
//
//   • 1-2 players: the matchmaker can seat a 2-player match on ADJACENT server
//     chairs (e.g. 0 and 1); a pure rotation would render them side-by-side. We
//     want the classic diagonal head-to-head, so the arrangement RE-SEATS the
//     ≤2 occupied chairs onto ONE diagonal (corners 0 & 2) and the empty chairs
//     onto the OTHER (corners 1 & 3). It's still a single shared arrangement
//     rotated per client, so BOTH players see the opponent top-left AND the two
//     empty quads agree on which corner each sits on.
//
//     (The bug this fixes: empty quads used to be coloured in board order on
//     each screen — not via the shared arrangement — so the two leftover colours
//     swapped corners between the two perspectives. A pawn correctly placed by
//     the rotation then sat next to, e.g., the red quad on one screen and the
//     yellow quad on the other.)
//
// The arrangement is NOT a single modulo rotation across all counts (≤2 players
// re-seat onto a diagonal), so the server — not the client — stays authoritative
// for whose turn it is; the online driver re-syncs currentPlayerIndex from each
// broadcast.
export const SELF_LOCAL = HUMAN_PREFERRED_POSITIONS[0]; // 2 (bottom-right)

// Server seat -> canonical board corner, the arrangement every client shares.
// Identity for the 3-4 player ring; a diagonal re-seat for ≤2 players.
let _arrangement = [0, 1, 2, 3];

function computeArrangement(activeSeats) {
    // 3-4 players: the server ring is already the arrangement.
    if (activeSeats.length > 2) return [0, 1, 2, 3];
    // ≤2 players: occupied chairs take one diagonal (corners 0,2), empties the
    // other (corners 1,3) — so the two humans render diagonally and the two
    // empty quads land on corners every client agrees on.
    const active = activeSeats.slice().sort((a, b) => a - b);
    const empty = [0, 1, 2, 3].filter((s) => !active.includes(s));
    const diagonalOrder = [0, 2, 1, 3];
    const arr = new Array(4);
    [...active, ...empty].forEach((seat, i) => { arr[seat] = diagonalOrder[i]; });
    return arr;
}

export function setOnline(net, seat, activeSeats) {
    _active = true;
    _net = net;
    _seat = seat;
    _activeSeats = (activeSeats && activeSeats.length)
        ? activeSeats.slice().sort((a, b) => a - b)
        : [0, 1, 2, 3];
    _arrangement = computeArrangement(_activeSeats);
}

export function clearOnline() {
    _active = false;
    _net = null;
    _seat = -1;
    _activeSeats = [];
    _arrangement = [0, 1, 2, 3];
}

/** Server seat index -> local board position (the renderer's player index). */
export function toLocal(serverIndex) {
    return ((_arrangement[serverIndex] - _arrangement[_seat] + 2) % 4 + 4) % 4;
}

/** Local board position -> server seat index (exact inverse of toLocal). */
export function toServer(localIndex) {
    const corner = ((localIndex - 2 + _arrangement[_seat]) % 4 + 4) % 4;
    return _arrangement.indexOf(corner);
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
