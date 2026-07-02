/**
 * Pure highlight generator for the end-of-game screen. Walks per-game
 * stats produced by the reducer and returns 3-4 cards describing the
 * most notable moments. Always includes at least one card featuring
 * the winner.
 *
 * No DOM, no globals — tested directly.
 */

/**
 * @typedef {Object} EndStats
 * @property {number[]} playerCaptures
 * @property {number[]} sentHomeCount
 * @property {number[]} distanceTraveled
 * @property {number} turnCount
 */

/**
 * @typedef {Object} HighlightCard
 * @property {number} playerIndex     0-3, used to color the card
 * @property {string} type            one of: 'ko' | 'bolt' | 'send'
 * @property {string} title
 * @property {string} body
 * @property {string} stat
 */

function nameOf(seats, i) {
    const seat = seats && seats[i];
    if (seat && seat.name && String(seat.name).trim()) return String(seat.name).trim();
    if (seat && seat.type === 'PLAYER') return 'You';
    return 'Bot';
}

/**
 * Shared "best player over 4 seats" scan behind most pickers. Returns the
 * winning index or -1 when nothing clears the bar. Options:
 *   - min        only values >= min count; if nothing clears it, returns -1.
 *                Doubles as the sentinel filter (e.g. min:0 drops the -1
 *                "never happened" markers in the min-direction pickers).
 *   - skipIndex  seat to ignore (e.g. exclude the already-credited player).
 *   - tieToWinner  on an exact tie, prefer this seat (knockout king credits
 *                the game winner when capture counts are level).
 *   - direction  'max' (default) or 'min' (earliest-turn pickers).
 *
 * Threshold-at-scan vs the old threshold-at-end is equivalent: a sub-min
 * value can never out-rank a qualifying one, so filtering it out early
 * picks the same seat the per-picker loops did.
 */
function argmaxPlayer(values, { min = -Infinity, skipIndex = -1, tieToWinner = -1, direction = 'max' } = {}) {
    let bestVal = direction === 'min' ? Infinity : -Infinity;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        if (i === skipIndex) continue;
        const v = values[i];
        if (v < min) continue;
        const better = direction === 'min' ? v < bestVal : v > bestVal;
        const tie = v === bestVal && i === tieToWinner;
        if (pi === -1 || better || tie) { bestVal = v; pi = i; }
    }
    return pi;
}

function makeCard({ playerIndex, type, title, body, stat }) {
    return { playerIndex, type, title, body, stat };
}

function pickKnockoutKing(stats, seats, winnerIndex) {
    const captures = stats.playerCaptures.map((c) => c || 0);
    const pi = argmaxPlayer(captures, { min: 2, tieToWinner: winnerIndex });
    if (pi === -1) return null;
    return makeCard({
        playerIndex: pi,
        type: 'ko',
        title: 'Knockout king',
        body: `${nameOf(seats, pi)} sent rivals home`,
        stat: `${captures[pi]}×`,
    });
}

function pickRoughDay(stats, seats) {
    const sent = stats.sentHomeCount.map((c) => c || 0);
    const pi = argmaxPlayer(sent, { min: 3 });
    if (pi === -1) return null;
    return makeCard({
        playerIndex: pi,
        type: 'send',
        title: 'Rough day',
        body: `${nameOf(seats, pi)} was sent home`,
        stat: `${sent[pi]}×`,
    });
}

function pickDistanceLeader(stats, seats) {
    const dist = stats.distanceTraveled.map((d) => d || 0);
    // min:1 reproduces the old "only credit a player who actually moved".
    const pi = argmaxPlayer(dist, { min: 1 });
    if (pi === -1) return null;
    return makeCard({
        playerIndex: pi,
        type: 'bolt',
        title: 'Distance run',
        body: `${nameOf(seats, pi)} clocked the most steps`,
        stat: `${dist[pi]}`,
    });
}

/**
 * Pick up to 3 highlight cards from the per-game stats. Each card is an actual
 * achievement that fired — no winner-guarantee or filler cards, since the
 * podium already crowns the placements. Returns 0-3 cards.
 *
 * @param {Object} args
 * @param {EndStats} args.stats
 * @param {Array<{name:string,type:string}|null>} args.seats   length 4
 * @param {number} args.winnerIndex   only used to break capture-count ties
 * @returns {HighlightCard[]} 0-3 cards
 */
/**
 * Online wrapper around selectHighlights. The reducer keys every stat by LOCAL
 * board index, which each client rotates so it sits bottom-right — so the same
 * physical player has a different index on every screen. selectHighlights breaks
 * ties by index, so left as-is each client would pick a different physical
 * player for tied awards (e.g. two players sent home the same number of times). Re-key the
 * stats into a stable, perspective-independent order (server seat) via the
 * supplied bijection, select there, then map each card's playerIndex back to the
 * local index for colouring. Same physical picks on every client.
 *
 * @param {Object} args
 * @param {EndStats} args.stats                   local-board-indexed stats
 * @param {Array} args.seats                      local-board-indexed seats (len 4)
 * @param {number} args.winnerIndex               local board index of the winner
 * @param {number[]} args.localOfSeat             localOfSeat[serverSeat] = local index (bijection)
 * @param {number[]} args.seatOfLocal             seatOfLocal[localIndex] = server seat (inverse)
 * @returns {HighlightCard[]}
 */
export function selectHighlightsBySeat({ stats, seats, winnerIndex, localOfSeat, seatOfLocal }) {
    const reorder = (arr) => localOfSeat.map((local) => arr[local]);
    const seatStats = {
        playerCaptures: reorder(stats.playerCaptures),
        sentHomeCount: reorder(stats.sentHomeCount),
        distanceTraveled: reorder(stats.distanceTraveled),
        turnCount: stats.turnCount,
    };
    const seatSeats = localOfSeat.map((local) => seats[local]);
    const cards = selectHighlights({
        stats: seatStats,
        seats: seatSeats,
        winnerIndex: seatOfLocal[winnerIndex],
    });
    return cards.map((c) => ({ ...c, playerIndex: localOfSeat[c.playerIndex] }));
}

export function selectHighlights({ stats, seats, winnerIndex }) {
    const candidates = [
        pickKnockoutKing(stats, seats, winnerIndex),
        pickRoughDay(stats, seats),
        pickDistanceLeader(stats, seats),
    ].filter(Boolean);

    return candidates.slice(0, 3);
}
