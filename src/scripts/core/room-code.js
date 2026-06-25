/**
 * Shared room-code helper — one source of truth for the private-room code
 * alphabet + minting, used by both the browser client (wc-quick-start, when a
 * host creates a room) and the server (the matchmaker, when a public match
 * mints a room). Kept here so the two never drift apart.
 *
 * The alphabet omits visually ambiguous characters (0/O, 1/I/L) so a code is
 * easy to read aloud and type.
 */

import { pick } from './rng-util.js';

export const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 4;

/**
 * Mint a random room code. Pass `isTaken` to reject collisions (the server
 * checks its live room map); the browser omits it (codes are claimed server-side).
 * @param {(code:string)=>boolean} [isTaken]
 * @returns {string}
 */
export function mintRoomCode(isTaken) {
    let code;
    do {
        code = '';
        for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
            code += pick(ROOM_CODE_CHARS);
        }
    } while (isTaken && isTaken(code));
    return code;
}
