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
    it('always returns 3-4 cards', () => {
        const cards = selectHighlights({
            stats: emptyStats(),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.length).toBeGreaterThanOrEqual(3);
        expect(cards.length).toBeLessThanOrEqual(4);
    });

    it('always includes at least one card about the winner', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                playerCaptures: [0, 5, 0, 0],
                sentHomeCount: [0, 0, 0, 4],
                firstFinishTurn: [-1, 12, -1, -1],
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.some(c => c.playerIndex === 0)).toBe(true);
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

    it('Hot dice triggers at >=3-long streak', () => {
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
        const hd = cards.find(c => c.title === 'Hot dice');
        expect(hd).toBeTruthy();
        expect(hd.playerIndex).toBe(1);
        expect(hd.stat).toBe('666');
        expect(hd.body).toMatch(/three 6s/);
        expect(hd.body).toMatch(/turn 14/);
    });

    it('Hot dice does NOT trigger at 2-long streak', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                bestDiceStreak: [
                    { value: 5, length: 2, atTurn: 4 },
                    null,
                    null,
                    null,
                ],
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        expect(cards.find(c => c.title === 'Hot dice')).toBeFalsy();
    });

    it('First home picks the earliest finish-turn', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                firstFinishTurn: [25, 9, 14, -1],
            }),
            seats: seats4(),
            winnerIndex: 1,
        });
        const fh = cards.find(c => c.title === 'First home');
        expect(fh).toBeTruthy();
        expect(fh.playerIndex).toBe(1);
        expect(fh.stat).toBe('T-9');
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

    it('Long road triggers at late home-stretch entry (turn >= 15)', () => {
        const cards = selectHighlights({
            stats: emptyStats({
                firstHomeStretchTurn: [10, 11, 28, 12],
                firstFinishTurn: [10, 11, -1, 12],
            }),
            seats: seats4(),
            winnerIndex: 0,
        });
        const lr = cards.find(c => c.title === 'Long road');
        expect(lr).toBeTruthy();
        expect(lr.playerIndex).toBe(2);
        expect(lr.stat).toBe('T-28');
    });

    it('Slow start triggers at >=3 base pawns at turn 20', () => {
        const cards = selectHighlights({
            stats: emptyStats({ pawnsAtBaseAtTurn20: [3, 1, 0, 0] }),
            seats: seats4(),
            winnerIndex: 0,
        });
        const ss = cards.find(c => c.title === 'Slow start');
        expect(ss).toBeTruthy();
        expect(ss.playerIndex).toBe(0);
        expect(ss.stat).toBe('T-20');
    });

    it('falls back to a Champion card when no natural triggers fire', () => {
        const cards = selectHighlights({
            stats: emptyStats(),
            seats: seats4(),
            winnerIndex: 2,
        });
        const champ = cards.find(c => c.title === 'Champion');
        expect(champ).toBeTruthy();
        expect(champ.playerIndex).toBe(2);
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
// DIFFERENT physical players for tied awards — the screenshot showed "Hot dice"
// crediting T3 (turn 44) on one screen but T1 (turn 87) on another, for the same
// game. selectHighlightsBySeat re-keys into stable server-seat order so every
// client selects the same physical player. Cards carry a LOCAL playerIndex for
// colouring, but the BODY text (physical name + turn) must match across clients.
describe('selectHighlightsBySeat — identical recap on every client', () => {
    // Physical game, indexed by SERVER SEAT: two players tied on a three-six
    // streak at different turns. Plain index tie-breaking is perspective-
    // dependent; the stable wrapper must resolve it the same way everywhere.
    const seatNames = ['P0', 'P1', 'P2', 'P3'];
    const seatStreak = [null,
        { value: 6, length: 3, atTurn: 87 },
        null,
        { value: 6, length: 3, atTurn: 44 }];
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
            bestDiceStreak: place(seatStreak),
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

    const hotDiceBody = (cards) => cards.find((c) => c.title === 'Hot dice')?.body;

    it('credits the same physical player on clients with different seatings', () => {
        // Two clients, two different local↔seat rotations of the same game.
        const clientA = clientRecap([0, 1, 2, 3]);       // identity
        const clientB = clientRecap([2, 3, 0, 1]);       // rotated (different self)
        const bodyA = hotDiceBody(clientA);
        const bodyB = hotDiceBody(clientB);
        expect(bodyA).toBeTruthy();
        expect(bodyB).toBe(bodyA); // identical text → same physical player + turn
        expect(bodyA).toContain('P1');     // lowest server seat wins the tie
        expect(bodyA).toContain('turn 87');
    });

    it('the card colour index is mapped back to each client\'s LOCAL index', () => {
        // P1 sits at local 1 for the identity client, local 3 for the rotated one.
        const a = clientRecap([0, 1, 2, 3]).find((c) => c.title === 'Hot dice');
        const b = clientRecap([2, 3, 0, 1]).find((c) => c.title === 'Hot dice');
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
                stats: emptyStats({ bestDiceStreak: place(seatStreak), turnCount: 90 }),
                seats: place(seatNames.map((name) => ({ name, type: 'PLAYER' }))),
                winnerIndex: localOfSeat[winnerSeat],
            };
        };
        const a = hotDiceBody(selectHighlights(localStats([0, 1, 2, 3])));
        const b = hotDiceBody(selectHighlights(localStats([2, 3, 0, 1])));
        expect(a).not.toBe(b); // diverges without the seat-space wrapper
    });
});
