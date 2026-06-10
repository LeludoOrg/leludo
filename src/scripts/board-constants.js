/**
 * Single source of truth for Ludo board geometry.
 *
 * These numbers encode the path a pawn walks. They are referenced by the pure
 * rule modules (game-logic, turn-rules, game-reducer), the bot AI, the renderer,
 * god-mode's cell↔position mapping, and the server engine. A drifted copy of any
 * of them is a rules bug — see CLAUDE.md "Duplication is a bug". Import these
 * constants instead of re-typing the literals.
 *
 * Position encoding for a single token:
 *   YARD (-1)                  not yet launched (sitting in its home yard)
 *   0 .. LAST_TRACK_SQUARE     on the shared main ring
 *   HOME_STRETCH_START .. FINISH  on this player's private home stretch
 *   FINISH (56)                reached home — finished
 */

export const YARD = -1;                // pawn not yet launched (in its home yard)
export const ENTRY_SQUARE = 0;         // first main-track square a launched pawn lands on
export const TRACK_LEN = 52;           // squares in the shared main ring
export const PLAYER_OFFSET = 13;       // per-player rotation of the ring (52 / 4 seats)
export const LAST_TRACK_SQUARE = 50;   // last shared-ring square before the home stretch
export const HOME_STRETCH_START = 51;  // first private home-stretch square
export const FINISH = 56;              // home-stretch end: the pawn has finished

/**
 * Absolute ring index ("mark index") a token occupies, shared by all seats so
 * capture detection can compare tokens from different players. Defined only for
 * tokens on the main ring (0..LAST_TRACK_SQUARE); callers must filter out yard
 * and home-stretch positions first.
 *
 * @param {number} playerIndex
 * @param {number} tokenPosition  expected to be in 0..LAST_TRACK_SQUARE
 * @returns {number}
 */
export function rawMarkIndex(playerIndex, tokenPosition) {
    return (tokenPosition + (PLAYER_OFFSET * playerIndex)) % TRACK_LEN;
}
