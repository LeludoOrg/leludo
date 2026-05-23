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

function pickKnockoutKing(stats, seats, winnerIndex) {
    let max = 0;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        const c = stats.playerCaptures[i] || 0;
        if (c > max || (c === max && i === winnerIndex)) {
            if (c >= max) { max = c; pi = i; }
        }
    }
    if (max < 2 || pi === -1) return null;
    return {
        playerIndex: pi,
        type: 'ko',
        title: 'Knockout king',
        body: `${nameOf(seats, pi)} sent rivals home`,
        stat: `${max}×`,
    };
}

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
    return {
        playerIndex: bestPi,
        type: 'dice',
        title: 'Hot dice',
        body: `${nameOf(seats, bestPi)} rolled ${word} ${best.value}s in a row on turn ${best.atTurn}`,
        stat: repeated,
    };
}

function pickFirstHome(stats, seats) {
    let best = -1;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        const t = stats.firstFinishTurn[i];
        if (t < 0) continue;
        if (pi === -1 || t < best) { best = t; pi = i; }
    }
    if (pi === -1) return null;
    return {
        playerIndex: pi,
        type: 'home',
        title: 'First home',
        body: `${nameOf(seats, pi)} got the first pawn home`,
        stat: `T-${best}`,
    };
}

function pickRoughDay(stats, seats) {
    let max = 0;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        const c = stats.sentHomeCount[i] || 0;
        if (c > max) { max = c; pi = i; }
    }
    if (max < 3 || pi === -1) return null;
    return {
        playerIndex: pi,
        type: 'send',
        title: 'Rough day',
        body: `${nameOf(seats, pi)} was sent home`,
        stat: `${max}×`,
    };
}

function pickLongRoad(stats, seats, skipPi) {
    let max = -1;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        if (i === skipPi) continue;
        const t = stats.firstHomeStretchTurn[i];
        if (t < 0) continue;
        if (t > max) { max = t; pi = i; }
    }
    if (pi === -1 || max < 15) return null;
    return {
        playerIndex: pi,
        type: 'bolt',
        title: 'Long road',
        body: `${nameOf(seats, pi)} crossed the finish at turn ${max}`,
        stat: `T-${max}`,
    };
}

function pickSlowStart(stats, seats) {
    let max = 0;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        const n = stats.pawnsAtBaseAtTurn20[i];
        if (n >= 3 && n > max) { max = n; pi = i; }
    }
    if (pi === -1) return null;
    return {
        playerIndex: pi,
        type: 'bolt',
        title: 'Slow start',
        body: `${nameOf(seats, pi)} took a while to leave home`,
        stat: 'T-20',
    };
}

function pickChampion(stats, seats, winnerIndex) {
    return {
        playerIndex: winnerIndex,
        type: 'crown',
        title: 'Champion',
        body: `${nameOf(seats, winnerIndex)} crossed the finish first`,
        stat: '1st',
    };
}

function pickDistanceLeader(stats, seats, skipPi) {
    let max = 0;
    let pi = -1;
    for (let i = 0; i < 4; i++) {
        if (i === skipPi) continue;
        const d = stats.distanceTraveled[i] || 0;
        if (d > max) { max = d; pi = i; }
    }
    if (pi === -1) return null;
    return {
        playerIndex: pi,
        type: 'bolt',
        title: 'Distance run',
        body: `${nameOf(seats, pi)} clocked the most steps`,
        stat: `${max}`,
    };
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
