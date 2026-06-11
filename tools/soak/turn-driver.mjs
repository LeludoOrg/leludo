/**
 * Move selection for the human seats the harness drives.
 *
 * Deliberately NOT bot-ai / game-driver: those reason over a LOCAL board in local
 * token indices and are offline-only, so wiring them into the server's seat-
 * relative `legalMoves` would invite a translation bug in the harness itself. The
 * server already hands us the exact legal token indexes for the current seat; a
 * seeded pick from that set is correct by construction and reproducible.
 *
 * makeRng (game-driver) is reused purely as a seedable PRNG — not its game loop.
 */

/**
 * @param {number[]} legalMoves  server-supplied legal token indexes for the seat
 * @param {() => number} rng     seeded PRNG in [0,1)
 * @param {'random'|'first'} [policy]
 * @returns {number|null}
 */
export function pickMove(legalMoves, rng, policy = 'random') {
    if (!Array.isArray(legalMoves) || legalMoves.length === 0) return null;
    if (policy === 'first') return legalMoves[0];
    return legalMoves[Math.floor(rng() * legalMoves.length)];
}
