/**
 * Seat-allocation helpers used by RoomEngine (and unit tests).
 * ringDistance and spreadPick implement the offline rule that humans claim seats
 * spread apart (HUMAN_PREFERRED_POSITIONS = [2, 0, 1, 3]): a 2-player game seats
 * the two humans diagonally opposite so an online "you vs a friend" game looks the
 * same as offline regardless of how many bot seats sit in between.
 *
 * Pure (no DOM, no state) so both the server and tests can import it.
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

