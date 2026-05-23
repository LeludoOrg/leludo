import { describe, it, expect } from 'vitest';
import { selectHighlights } from '../../scripts/end-highlights.js';

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
