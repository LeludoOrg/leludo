import { describe, it, expect } from 'vitest';
import { selectHighlights, selectHighlightsBySeat } from '../../scripts/render/end-highlights.js';

const seats4 = (names = ['You', 'Bot 1', 'Bot 2', 'Bot 3']) => [
    { name: names[0], type: 'PLAYER' },
    { name: names[1], type: 'BOT' },
    { name: names[2], type: 'BOT' },
    { name: names[3], type: 'BOT' },
];

function emptyStats(overrides = {}) {
    return {
        playerCaptures: [0, 0, 0, 0],
        sentHomeCount: [0, 0, 0, 0],
        bestDiceStreak: [null, null, null, null],
        firstFinishTurn: [-1, -1, -1, -1],
        firstHomeStretchTurn: [-1, -1, -1, -1],
        distanceTraveled: [0, 0, 0, 0],
        pawnsAtBaseAtTurn20: [-1, -1, -1, -1],
        turnCount: 30,
        ...overrides,
    };
}

describe('selectHighlights', () => {
    it('returns at most 3 cards when every achievement fires', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                playerCaptures: [4, 0, 0, 0], // Knockout king
                sentHomeCount: [0, 0, 0, 4],  // Rough day
                distanceTraveled: [10, 90, 30, 5], // Distance run
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.length).toBe(3);
    });

    // No winner-guarantee or filler cards anymore — the podium owns placements,
    // so an uneventful game simply yields no highlight cards.
    it('returns no cards when nothing notable happened', () => {
        const cards = selectHighlights({
            stats: emptyStats(),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards).toEqual([]);
    });

    it('Knockout king triggers at >=2 captures', () => {
        const cards = selectHighlights({
            stats: emptyStats({ playerCaptures: [4, 0, 0, 0] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        const ko = cards.find(c => c.title === 'Knockout king');
        expect(ko).toBeTruthy();
        expect(ko.playerIndex).toBe(0);
        expect(ko.stat).toBe('4×');
        expect(ko.body).toMatch(/You/);
    });

    // Tie-break guard: when two players share the top capture count, the
    // game winner is credited (knockout king's tieToWinner rule). Refactor
    // moved this into argmaxPlayer({ tieToWinner }) — keep the behaviour pinned.
    it('Knockout king credits the WINNER when capture counts tie', () => {
        const cards = selectHighlights({
            stats: emptyStats({ playerCaptures: [3, 0, 3, 0] }),
            seats: seats4(),
            winnerIndex: 2,
        });
        const ko = cards.find(c => c.title === 'Knockout king');
        expect(ko).toBeTruthy();
        expect(ko.playerIndex).toBe(2); // winner wins the tie, not the lower index
        expect(ko.stat).toBe('3×');
    });

    it('Knockout king keeps the strict leader even if the winner ties lower', () => {
        const cards = selectHighlights({
            stats: emptyStats({ playerCaptures: [4, 0, 2, 0] }),
            seats: seats4(),
            winnerIndex: 2,
        });
        const ko = cards.find(c => c.title === 'Knockout king');
        expect(ko.playerIndex).toBe(0); // strict max beats the winner's lower count
        expect(ko.stat).toBe('4×');
    });

    it('Knockout king does NOT trigger at 1 capture', () => {
        const cards = selectHighlights({
            stats: emptyStats({ playerCaptures: [1, 0, 0, 0] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.find(c => c.title === 'Knockout king')).toBeFalsy();
    });

    // The "Hot dice" highlight (stat rendered as repeated dice faces, e.g.
    // "666") was removed: with the fair-die change a third six is never dealt
    // and non-six faces never grant a re-roll, so a >=3-long same-face streak
    // is unreachable and the card was dead. Guard that it never reappears.
    it('never emits a Hot dice card, even with a long streak in the stats', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                bestDiceStreak: [
                    null,
                    { value: 6, length: 3, atTurn: 14 },
                    null,
                    null,
                ],
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.find(c => c.title === 'Hot dice')).toBeFalsy();
        expect(cards.every(c => c.type !== 'dice')).toBe(true);
    });

    // "First home" was removed from the recap; finishing first is now conveyed
    // by the podium standings, not a duplicate highlight card.
    it('never emits a First home card', () => {
        const cards = selectHighlights({
            stats: emptyStats({ firstFinishTurn: [25, 9, 14, -1] }),
            seats: seats4(),
            winnerIndex: 1,
        });
        expect(cards.find(c => c.title === 'First home')).toBeFalsy();
        expect(cards.every(c => c.type !== 'home')).toBe(true);
    });

    it('Rough day triggers at >=3 sent-home', () => {
        const cards = selectHighlights({
            stats: emptyStats({ sentHomeCount: [0, 0, 0, 4] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        const rd = cards.find(c => c.title === 'Rough day');
        expect(rd).toBeTruthy();
        expect(rd.playerIndex).toBe(3);
        expect(rd.stat).toBe('4×');
    });

    it('Rough day does NOT trigger at 2 sent-home', () => {
        const cards = selectHighlights({
            stats: emptyStats({ sentHomeCount: [0, 0, 0, 2] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.find(c => c.title === 'Rough day')).toBeFalsy();
    });

    it('Distance run credits the player who clocked the most steps', () => {
        const cards = selectHighlights({
            stats: emptyStats({ distanceTraveled: [40, 120, 30, 0] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        const dl = cards.find(c => c.title === 'Distance run');
        expect(dl).toBeTruthy();
        expect(dl.playerIndex).toBe(1);
        expect(dl.stat).toBe('120');
    });

    // Long road, Slow start, Champion and the Match-wrap filler were all removed:
    // the podium now conveys placement/finish, so the recap keeps only the three
    // achievement cards (Knockout king, Rough day, Distance run).
    it('never emits the removed highlight cards, even when their stats are present', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                firstHomeStretchTurn: [10, 11, 28, 12], // would have been Long road
                pawnsAtBaseAtTurn20: [3, 1, 0, 0],      // would have been Slow start
            }),
            seats: seats4(),
            winnerIndex: 2,
        });
        const removed = ['Long road', 'Slow start', 'Champion', 'Match wrap'];
        for (const title of removed) {
            expect(cards.find(c => c.title === title)).toBeFalsy();
        }
        expect(cards.every(c => c.type !== 'crown')).toBe(true);
        const allowed = new Set(['Knockout king', 'Rough day', 'Distance run']);
        expect(cards.every(c => allowed.has(c.title))).toBe(true);
    });

    it('uses bot name in the eyebrow string when winner is a bot', () => {
        const cards = selectHighlights({
            stats: emptyStats({ playerCaptures: [0, 0, 0, 3] }),
            seats: seats4(['You', 'Karen', 'Loot Gob', 'Sketchy']),
            winnerIndex: 3,
        });
        const ko = cards.find(c => c.title === 'Knockout king');
        expect(ko.body).toContain('Sketchy');
    });

    it('every card has playerIndex 0..3, a stat, and a non-empty body', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                playerCaptures: [3, 1, 0, 0],
                sentHomeCount: [0, 0, 4, 0],
                bestDiceStreak: [null, { value: 4, length: 3, atTurn: 8 }, null, null],
                firstFinishTurn: [22, -1, -1, -1],
                firstHomeStretchTurn: [22, 18, 16, 26],
                pawnsAtBaseAtTurn20: [-1, -1, -1, -1],
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        for (const c of cards) {
            expect(c.playerIndex).toBeGreaterThanOrEqual(0);
            expect(c.playerIndex).toBeLessThanOrEqual(3);
            expect(c.stat.length).toBeGreaterThan(0);
            expect(c.body.length).toBeGreaterThan(0);
            expect(c.title.length).toBeGreaterThan(0);
            expect(typeof c.type).toBe('string');
        }
    });
});

// Regression: the recap is computed locally on each client from stats keyed by
// LOCAL board index, which is rotated per-perspective (every client sits
// bottom-right). selectHighlights breaks ties by index, so two clients picked
// DIFFERENT physical players for tied awards — e.g. two players sent home the
// same number of times credited different people on each screen for the same
// game. selectHighlightsBySeat re-keys into stable server-seat order so every
// client selects the same physical player. Cards carry a LOCAL playerIndex for
// colouring, but the BODY text (physical name) must match across clients.
describe('selectHighlightsBySeat — identical recap on every client', () => {
    // Physical game, indexed by SERVER SEAT: two players tied on sent-home
    // count. Plain index tie-breaking is perspective-dependent; the stable
    // wrapper must resolve it the same way everywhere (lowest server seat).
    const seatNames = ['P0', 'P1', 'P2', 'P3'];
    const seatSentHome = [0, 4, 0, 4]; // seats 1 & 3 tie
    const winnerSeat = 0;

    const invert = (localOfSeat) => {
        const seatOfLocal = new Array(4).fill(-1);
        localOfSeat.forEach((local, seat) => { seatOfLocal[local] = seat; });
        return seatOfLocal;
    };

    // Render the SAME physical game from a client whose local board indexes are
    // `localOfSeat` (localOfSeat[serverSeat] = local index). Stats/seats get
    // placed at this client's local slots, exactly like the live reducer.
    const clientRecap = (localOfSeat) => {
        const seatOfLocal = invert(localOfSeat);
        const place = (bySeat) => {
            const out = new Array(4);
            for (let seat = 0; seat < 4; seat++) out[localOfSeat[seat]] = bySeat[seat];
            return out;
        };
        const stats = emptyStats({
            sentHomeCount: place(seatSentHome),
            turnCount: 90,
        });
        const seats = place(seatNames.map((name) => ({ name, type: 'PLAYER' })));
        return selectHighlightsBySeat({
            stats,
            seats,
            winnerIndex: localOfSeat[winnerSeat],
            localOfSeat,
            seatOfLocal,
        });
    };

    const roughDayBody = (cards) => cards.find((c) => c.title === 'Rough day')?.body;

    it('credits the same physical player on clients with different seatings', () => {
        // Two clients, two different local↔seat rotations of the same game.
        const clientA = clientRecap([0, 1, 2, 3]);       // identity
        const clientB = clientRecap([2, 3, 0, 1]);       // rotated (different self)
        const bodyA = roughDayBody(clientA);
        const bodyB = roughDayBody(clientB);
        expect(bodyA).toBeTruthy();
        expect(bodyB).toBe(bodyA); // identical text → same physical player
        expect(bodyA).toContain('P1');     // lowest server seat wins the tie
    });

    it('the card colour index is mapped back to each client\'s LOCAL index', () => {
        // P1 sits at local 1 for the identity client, local 3 for the rotated one.
        const a = clientRecap([0, 1, 2, 3]).find((c) => c.title === 'Rough day');
        const b = clientRecap([2, 3, 0, 1]).find((c) => c.title === 'Rough day');
        expect(a.playerIndex).toBe(1); // localOfSeat[1] for identity
        expect(b.playerIndex).toBe(3); // localOfSeat[1] for the rotation
    });

    it('plain selectHighlights would DIVERGE on the same two clients (the bug)', () => {
        // Proof the wrapper is load-bearing: feeding each client's local stats
        // straight to selectHighlights picks different physical players.
        const localStats = (localOfSeat) => {
            const place = (bySeat) => {
                const out = new Array(4);
                for (let s = 0; s < 4; s++) out[localOfSeat[s]] = bySeat[s];
                return out;
            };
            return {
                stats: emptyStats({ sentHomeCount: place(seatSentHome), turnCount: 90 }),
                seats: place(seatNames.map((name) => ({ name, type: 'PLAYER' }))),
                winnerIndex: localOfSeat[winnerSeat],
            };
        };
        const a = roughDayBody(selectHighlights(localStats([0, 1, 2, 3])));
        const b = roughDayBody(selectHighlights(localStats([2, 3, 0, 1])));
        expect(a).not.toBe(b); // diverges without the seat-space wrapper
    });
});
