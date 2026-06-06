/**
 * Seat-allocation helpers shared by the online lobby (RoomEngine) and the public
 * matchmaker. Mirrors the offline rule that humans claim seats spread apart
 * (HUMAN_PREFERRED_POSITIONS = [2, 0, 1, 3]): a 2-player game seats the two
 * humans diagonally opposite, leaving the other diagonal for the bots, so an
 * online "you vs a friend" game looks the same as offline regardless of how many
 * bot seats sit in between.
 *
 * Pure (no DOM, no state) so both the Node server and unit tests can import it.
 */

/** Shortest distance between two seats around an n-seat ring (adjacent = 1,
 *  diagonally opposite = 2 on a 4-seat board). */
export function ringDistance(a, b, n = 4) {
    const d = (((a - b) % n) + n) % n;
    return Math.min(d, n - d);
}

/**
 * Pick the candidate seat that sits as far as possible from every already-taken
 * seat (maximise the minimum ring distance), breaking ties toward the lowest
 * index. Returns -1 when there are no candidates.
 * @param {number[]} taken       seats already occupied by humans
 * @param {number[]} candidates  open seats to choose from
 */
export function spreadPick(taken, candidates, n = 4) {
    if (!candidates.length) return -1;
    const sorted = [...candidates].sort((a, b) => a - b);
    if (!taken.length) return sorted[0]; // first human: lowest open seat
    let best = -1, bestDist = -1;
    for (const c of sorted) {
        let minDist = n;
        for (const t of taken) minDist = Math.min(minDist, ringDistance(c, t, n));
        if (minDist > bestDist) { bestDist = minDist; best = c; }
    }
    return best;
}

/**
 * Build a 4-seat plan for a public match: `humans` PLAYER seats spread around the
 * ring, the remaining active seats BOT (when bot-filling) else PLAYER, and any
 * seats beyond `size` closed (null). Keeps matched humans diagonally opposite the
 * same way the lobby's spread picker does for private rooms.
 */
export function spreadSeatPlan(size, humans, withBots, n = 4) {
    const active = [];
    for (let i = 0; i < n && active.length < size; i++) active.push(i);
    const humanSeats = [];
    for (let k = 0; k < humans && humanSeats.length < active.length; k++) {
        const pick = spreadPick(humanSeats, active.filter(s => !humanSeats.includes(s)), n);
        if (pick >= 0) humanSeats.push(pick);
    }
    const plan = new Array(n).fill(null);
    for (const s of active) plan[s] = humanSeats.includes(s) ? 'PLAYER' : (withBots ? 'BOT' : 'PLAYER');
    return plan;
}
