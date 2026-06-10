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
 * @property {Array<{value:number,length:number,atTurn:number}|null>} bestDiceStreak
 * @property {number[]} firstFinishTurn        first turn each player landed a pawn on cell 56
 * @property {number[]} firstHomeStretchTurn   first turn each player entered cell 51+
 * @property {number[]} distanceTraveled
 * @property {number[]} pawnsAtBaseAtTurn20    -1 = never sampled (game ended <20 turns)
 * @property {number} turnCount
 */

/**
 * @typedef {Object} HighlightCard
 * @property {number} playerIndex     0-3, used to color the card
 * @property {string} type            one of: 'ko' | 'dice' | 'bolt' | 'send' | 'home' | 'crown'
 * @property {string} title
 * @property {string} body
 * @property {string} stat
 */

const COUNT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
function countWord(n) {
    return n >= 0 && n < COUNT_WORDS.length ? COUNT_WORDS[n] : String(n);
}

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

// Hot dice keeps a bespoke scan: it ranks by streak LENGTH but the card
// needs the whole streak object (value + atTurn), not just a number.
function pickHotDice(stats, seats) {
    let best = null;
    let bestPi = -1;
    for (let i = 0; i < 4; i++) {
        const s = stats.bestDiceStreak[i];
        if (!s || s.length < 3) continue;
        if (!best || s.length > best.length) {
            best = s; bestPi = i;
        }
    }
    if (!best) return null;
    const word = countWord(best.length);
    const repeated = String(best.value).repeat(Math.min(best.length, 4));
    return makeCard({
        playerIndex: bestPi,
        type: 'dice',
        title: 'Hot dice',
        body: `${nameOf(seats, bestPi)} rolled ${word} ${best.value}s in a row on turn ${best.atTurn}`,
        stat: repeated,
    });
}

function pickFirstHome(stats, seats) {
    // min:0 drops the -1 "never finished" sentinels; direction:'min' takes
    // the earliest finish turn.
    const pi = argmaxPlayer(stats.firstFinishTurn, { min: 0, direction: 'min' });
    if (pi === -1) return null;
    return makeCard({
        playerIndex: pi,
        type: 'home',
        title: 'First home',
        body: `${nameOf(seats, pi)} got the first pawn home`,
        stat: `T-${stats.firstFinishTurn[pi]}`,
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

function pickLongRoad(stats, seats, skipPi) {
    // min:15 doubles as the late-entry bar and the -1 sentinel filter.
    const pi = argmaxPlayer(stats.firstHomeStretchTurn, { min: 15, skipIndex: skipPi });
    if (pi === -1) return null;
    const turn = stats.firstHomeStretchTurn[pi];
    return makeCard({
        playerIndex: pi,
        type: 'bolt',
        title: 'Long road',
        body: `${nameOf(seats, pi)} crossed the finish at turn ${turn}`,
        stat: `T-${turn}`,
    });
}

function pickSlowStart(stats, seats) {
    const pi = argmaxPlayer(stats.pawnsAtBaseAtTurn20, { min: 3 });
    if (pi === -1) return null;
    return makeCard({
        playerIndex: pi,
        type: 'bolt',
        title: 'Slow start',
        body: `${nameOf(seats, pi)} took a while to leave home`,
        stat: 'T-20',
    });
}

function pickChampion(stats, seats, winnerIndex) {
    return makeCard({
        playerIndex: winnerIndex,
        type: 'crown',
        title: 'Champion',
        body: `${nameOf(seats, winnerIndex)} crossed the finish first`,
        stat: '1st',
    });
}

function pickDistanceLeader(stats, seats, skipPi) {
    const dist = stats.distanceTraveled.map((d) => d || 0);
    // min:1 reproduces the old "only credit a player who actually moved".
    const pi = argmaxPlayer(dist, { min: 1, skipIndex: skipPi });
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
 * Pick 3-4 highlight cards from the per-game stats. Always includes at
 * least one card featuring the winner.
 *
 * @param {Object} args
 * @param {EndStats} args.stats
 * @param {Array<{name:string,type:string}|null>} args.seats   length 4
 * @param {number} args.winnerIndex
 * @returns {HighlightCard[]} 3-4 cards
 */
/**
 * Online wrapper around selectHighlights. The reducer keys every stat by LOCAL
 * board index, which each client rotates so it sits bottom-right — so the same
 * physical player has a different index on every screen. selectHighlights breaks
 * ties by index, so left as-is each client would pick a different physical
 * player for tied awards (e.g. two players who both rolled three 6s). Re-key the
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
        bestDiceStreak: reorder(stats.bestDiceStreak),
        firstFinishTurn: reorder(stats.firstFinishTurn),
        firstHomeStretchTurn: reorder(stats.firstHomeStretchTurn),
        distanceTraveled: reorder(stats.distanceTraveled),
        pawnsAtBaseAtTurn20: reorder(stats.pawnsAtBaseAtTurn20),
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
    const candidates = [];
    const ko = pickKnockoutKing(stats, seats, winnerIndex);
    if (ko) candidates.push(ko);
    const hd = pickHotDice(stats, seats);
    if (hd) candidates.push(hd);
    const rd = pickRoughDay(stats, seats);
    if (rd) candidates.push(rd);
    const fh = pickFirstHome(stats, seats);
    if (fh) candidates.push(fh);
    const lr = pickLongRoad(stats, seats, fh ? fh.playerIndex : -1);
    if (lr) candidates.push(lr);
    const ss = pickSlowStart(stats, seats);
    if (ss) candidates.push(ss);

    let cards = candidates.slice(0, 4);

    const hasWinner = cards.some(c => c.playerIndex === winnerIndex);
    if (!hasWinner) {
        const champ = pickChampion(stats, seats, winnerIndex);
        if (cards.length < 4) cards.unshift(champ);
        else { cards.pop(); cards.unshift(champ); }
    }

    if (cards.length < 3) {
        const skip = new Set(cards.map(c => c.playerIndex));
        const dl = pickDistanceLeader(stats, seats, -1);
        if (dl && !skip.has(dl.playerIndex)) cards.push(dl);
    }
    if (cards.length < 3) {
        cards.push(pickChampion(stats, seats, winnerIndex));
    }
    while (cards.length < 3) {
        cards.push({
            playerIndex: winnerIndex,
            type: 'crown',
            title: 'Match wrap',
            body: `${nameOf(seats, winnerIndex)} closed it out`,
            stat: `T-${stats.turnCount || 0}`,
        });
    }

    return cards.slice(0, 4);
}
