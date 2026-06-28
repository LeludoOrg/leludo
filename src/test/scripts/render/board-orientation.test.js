import { describe, it, expect, beforeEach } from 'vitest';
import {
    setBoardQuarterTurns,
    getBoardQuarterTurns,
    boardRotationDeg,
    boardLocalPoint,
    boardUnrotateVec,
    quarterTurnsToFacePlayer,
} from '../../../scripts/render/board-orientation.js';

// The overlay coordinate helpers (boardLocalPoint / boardUnrotateVec) are the
// load-bearing part of board rotation: every pawn hop / capture / launch
// measures cells in VIEWPORT space, and these map back into the board's LOCAL
// (un-rotated) frame so a flipped board still lands moves on the right cell. A
// sign error here flings pawns to the wrong square only when rotated — invisible
// in the default 0-turn case — so pin the exact geometry with a forward oracle.

const S = 100;
const rect = { left: 30, top: 70, width: S, height: S };

// Forward CSS `rotate(q*90deg)` of a board-LOCAL point about the square's
// centre — the transform boardLocalPoint must invert. Integer cos/sin keep the
// right-angle cases exact.
function forwardPoint(lx, ly, q) {
    const t = (q * Math.PI) / 2;
    const cos = Math.round(Math.cos(t));
    const sin = Math.round(Math.sin(t));
    const cx = rect.left + S / 2;
    const cy = rect.top + S / 2;
    const rx = lx - S / 2;
    const ry = ly - S / 2;
    return { x: cx + (cos * rx - sin * ry), y: cy + (sin * rx + cos * ry) };
}

function forwardVec(vx, vy, q) {
    const t = (q * Math.PI) / 2;
    const cos = Math.round(Math.cos(t));
    const sin = Math.round(Math.sin(t));
    return { x: cos * vx - sin * vy, y: sin * vx + cos * vy };
}

describe('board-orientation — quarter-turn state', () => {
    beforeEach(() => setBoardQuarterTurns(0));

    it('normalises into 0..3 and reports the matching CSS degrees', () => {
        expect(setBoardQuarterTurns(2)).toBe(2);
        expect(boardRotationDeg()).toBe(180);
        expect(setBoardQuarterTurns(-1)).toBe(3); // wraps
        expect(setBoardQuarterTurns(5)).toBe(1);  // wraps
        expect(getBoardQuarterTurns()).toBe(1);
        expect(boardRotationDeg()).toBe(90);
    });
});

describe('board-orientation — boardLocalPoint inverts the board rotation', () => {
    const samples = [
        [0, 0], [S, 0], [0, S], [S, S], [S / 2, S / 2], [12, 88], [73, 4],
    ];

    for (const q of [0, 1, 2, 3]) {
        it(`recovers local coords at ${q} quarter-turn(s)`, () => {
            setBoardQuarterTurns(q);
            for (const [lx, ly] of samples) {
                const vp = forwardPoint(lx, ly, q);
                const back = boardLocalPoint(vp.x, vp.y, rect);
                expect(back.x).toBeCloseTo(lx, 6);
                expect(back.y).toBeCloseTo(ly, 6);
            }
        });
    }

    it('is a plain origin-subtract at 0 turns (no behaviour change unrotated)', () => {
        setBoardQuarterTurns(0);
        const p = boardLocalPoint(rect.left + 40, rect.top + 25, rect);
        expect(p).toEqual({ x: 40, y: 25 });
    });
});

describe('board-orientation — boardUnrotateVec inverts a rotated delta', () => {
    const vecs = [[10, 0], [0, 10], [-7, 3], [4, -9]];
    for (const q of [0, 1, 2, 3]) {
        it(`recovers the local vector at ${q} quarter-turn(s)`, () => {
            setBoardQuarterTurns(q);
            for (const [vx, vy] of vecs) {
                const rotated = forwardVec(vx, vy, q);
                const back = boardUnrotateVec(rotated.x, rotated.y);
                expect(back.x).toBeCloseTo(vx, 6);
                expect(back.y).toBeCloseTo(vy, 6);
            }
        });
    }
});

describe('board-orientation — quarterTurnsToFacePlayer (180° face-to-face policy)', () => {
    it('flips a top-half home (TL/TR) to the bottom, leaves a bottom home put', () => {
        expect(quarterTurnsToFacePlayer(0)).toBe(2); // TL → 180°
        expect(quarterTurnsToFacePlayer(1)).toBe(2); // TR → 180°
        expect(quarterTurnsToFacePlayer(2)).toBe(0); // BR already near
        expect(quarterTurnsToFacePlayer(3)).toBe(0); // BL already near
    });
});
