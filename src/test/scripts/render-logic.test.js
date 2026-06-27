import { describe, it, expect, beforeEach } from 'vitest';
import {
    getContainerPath,
    pinTokenForCapture,
    updateCellStacking,
    updateCornerWidgets,
    initRailDeps,
    setPlayerNames,
    setLastRoll,
    resetLastRolls,
} from '../../scripts/render/render-logic.js';

describe('getContainerPath — forward movement', () => {
    it('builds per-step mark IDs from current+1 to new (inclusive)', () => {
        // P0 mark index === token position (13*0 = 0). Move from 3 to 7
        // should produce 4 hops: m4, m5, m6, m7.
        expect(getContainerPath(0, 0, 3, 7)).toEqual(['m4', 'm5', 'm6', 'm7']);
    });

    it('returns single home container id for new === -1 when from home', () => {
        expect(getContainerPath(0, 0, -1, -1)).toEqual(['h-0-0']);
    });

    it('returns single id for new === 0 (start-cell short-circuit)', () => {
        // Position 0 short-circuits to a single hop onto the player's
        // start cell (mark index 13*playerIndex). For P2 that's m26.
        expect(getContainerPath(2, 1, -1, 0)).toEqual(['m26']);
    });

    it('handles home-stretch destinations (p<player>s<index>)', () => {
        // Position 53 → home stretch index 3 for P1.
        const path = getContainerPath(1, 0, 50, 53);
        expect(path).toEqual(['p1s1', 'p1s2', 'p1s3']);
    });
});

describe('getContainerPath — capture destination', () => {
    // Captures no longer animate via getContainerPath — animateCaptureToHome
    // handles the blast + teleport directly. getContainerPath still collapses
    // any destination of -1 to a single home-cell id (the [-1, 0] short-circuit).
    it('returns just the home cell id regardless of capture origin', () => {
        expect(getContainerPath(0, 0, 5, -1)).toEqual(['h-0-0']);
        expect(getContainerPath(1, 2, 3, -1)).toEqual(['h-1-2']);
        expect(getContainerPath(0, 0, 50, -1)).toEqual(['h-0-0']);
    });
});

describe('pinTokenForCapture', () => {
    function buildCell() {
        const cell = document.createElement('div');
        const token = document.createElement('wc-token');
        cell.appendChild(token);
        // happy-dom doesn't run layout, so stub the rects the function reads.
        cell.getBoundingClientRect = () => ({ top: 100, left: 200, width: 40, height: 40 });
        token.getBoundingClientRect = () => ({ top: 120, left: 220, width: 24, height: 24 });
        return { cell, token };
    }

    it('takes the captured token out of flow so the landing mover is not shoved', () => {
        // Regression: captured token used to keep only dataset.moving='true' while
        // staying an in-flow child. The capturing token then landed in the same
        // cell as a second in-flow token and got pushed into a second slot ("sits
        // in the cell below") until the captured token finally animated home.
        // Pinning it position:absolute removes it from flow immediately.
        const { cell, token } = buildCell();
        pinTokenForCapture(token);
        expect(token.style.position).toBe('absolute');
        expect(token.dataset.moving).toBe('true');
        expect(cell.style.position).toBe('relative');
    });

    it('pins the token at its current visual spot (cell-relative)', () => {
        const { cell, token } = buildCell();
        pinTokenForCapture(token);
        expect(token.style.top).toBe('20px');   // 120 - 100
        expect(token.style.left).toBe('20px');  // 220 - 200
        expect(token.style.width).toBe('24px');
        expect(token.style.height).toBe('24px');
    });
});

describe('updateCellStacking — pinned (moving) tokens', () => {
    it('leaves a moving token pinned out of flow while restacking the rest', () => {
        // Regression: updateCellStacking used to clear EVERY child's styles,
        // including a captured token pinned position:absolute mid-animation.
        // That dropped it back into flow and shoved/hid the just-landed
        // capturing token until the captured token finally reached home
        // ("capturer disappears until captured pawn gets home").
        const cell = document.createElement('div');
        cell.id = 'm7';

        const captured = document.createElement('wc-token'); // mid-animation, pinned
        captured.dataset.moving = 'true';
        captured.style.cssText = 'position:absolute;top:20px;left:20px;width:24px;height:24px;';

        const lander = document.createElement('wc-token'); // just settled, in flow
        lander.style.cssText = 'position:absolute;top:4%;left:4%;'; // leftover stack styles

        cell.appendChild(captured);
        cell.appendChild(lander);

        updateCellStacking(cell);

        // Pinned token untouched — still out of flow.
        expect(captured.style.position).toBe('absolute');
        expect(captured.style.top).toBe('20px');
        // Sole settled token cleared back to flow (n<=1 → no stack styles).
        expect(lander.style.position).toBe('');
    });
});

describe('updateCellStacking — peek-fan / totem layout', () => {
    function mkToken(player, tok) {
        const t = document.createElement('wc-token');
        t.id = `p-${player}-${tok}`;
        t.appendChild(document.createElement('svg')); // inner glyph the fan tilts
        return t;
    }
    function mkCell(tokens) {
        const cell = document.createElement('div');
        cell.id = 'm20'; // non-finish track cell
        tokens.forEach(t => cell.appendChild(t));
        return cell;
    }

    it('peek-fan: ≤4 pawns each get absolute position + a rotated svg', () => {
        // Up to 4 pawns fan out individually like a hand of cards.
        const toks = [mkToken(0, 0), mkToken(1, 0), mkToken(2, 0)];
        const cell = mkCell(toks);
        updateCellStacking(cell);
        toks.forEach((t, i) => {
            expect(t.style.position).toBe('absolute');
            expect(t.style.zIndex).toBe(String(10 + i));
        });
        // n=3 offsets are -1, 0, 1 → the outer pawns tilt (--pawn-tilt set);
        // the centre is upright (no tilt). The tilt is a custom prop so it
        // composes with the bounce keyframe instead of being overwritten.
        expect(toks[0].firstElementChild.style.getPropertyValue('--pawn-tilt')).toContain('deg');
        expect(toks[2].firstElementChild.style.getPropertyValue('--pawn-tilt')).toContain('deg');
        expect(toks[1].firstElementChild.style.getPropertyValue('--pawn-tilt')).toBe('');
    });

    it('totem fan: >4 pawns collapse same-color into vertical stacks', () => {
        // 4×P0 + 2×P1 = 6 on one cell → 2 color leaves, all pawns visible,
        // no count badge, each totem stacked vertically (rising `bottom`).
        const p0 = [mkToken(0, 0), mkToken(0, 1), mkToken(0, 2), mkToken(0, 3)];
        const p1 = [mkToken(1, 0), mkToken(1, 1)];
        const cell = mkCell([...p0, ...p1]);
        updateCellStacking(cell);

        const all = [...p0, ...p1];
        expect(all.every(t => t.style.display !== 'none')).toBe(true);
        expect(cell.querySelector('.stack-badge')).toBeNull();

        // two distinct horizontal slots == two color totems
        const slots = new Set(all.map(t => t.style.left));
        expect(slots.size).toBe(2);

        // within the P0 totem, pawns stack upward (strictly increasing bottom)
        const bottoms = p0.map(t => parseFloat(t.style.bottom));
        for (let i = 1; i < bottoms.length; i++) {
            expect(bottoms[i]).toBeGreaterThan(bottoms[i - 1]);
        }
    });

    it('lone survivor of a broken stack clears its rotate and stack styles', () => {
        // When a stack drops back to one pawn it must stand upright at full cell.
        const a = mkToken(0, 0), b = mkToken(1, 0);
        const cell = mkCell([a, b]);
        updateCellStacking(cell);
        expect(a.style.position).toBe('absolute'); // stacked

        cell.removeChild(b);
        updateCellStacking(cell);
        expect(a.style.position).toBe('');                                   // back in flow
        expect(a.firstElementChild.style.getPropertyValue('--pawn-tilt')).toBe(''); // upright
    });
});

describe('updateCornerWidgets — idle corner shows last roll', () => {
    // Regression: a forfeited turn (third six) or a roll with no movable pawn
    // advances so fast the player never sees what they rolled. Each player's
    // idle corner now shows their last roll as a faded static die so the value
    // stays visible after the turn moves on.
    beforeEach(() => {
        document.body.innerHTML = '';
        ['b0', 'b1', 'b2', 'b3'].forEach(id => {
            const el = document.createElement('div');
            el.id = id;
            document.body.appendChild(el);
        });
        // Two human seats; player 0 active, player 1 idle.
        const playerTypes = ['HUMAN', 'HUMAN', undefined, undefined];
        initRailDeps(playerTypes, () => 0, () => 0);
        setPlayerNames(['P1', 'P2', '', '']);
        resetLastRolls();
    });

    it('renders a faded die face with pip count matching the idle player roll', () => {
        setLastRoll(1, 5); // idle player rolled a 5 last turn
        updateCornerWidgets();

        const idleCorner = document.querySelector('#b1 .corner-dice');
        expect(idleCorner).not.toBeNull();
        expect(idleCorner.classList.contains('corner-dice--rolled')).toBe(true);
        // Muted player-colored ring so you can tell whose roll it is.
        expect(idleCorner.classList.contains('player-border-1')).toBe(true);
        // Reuses the exact live-dice markup (.die / .dice-face / .dice-dot)
        // so the faded copy inherits identical light/dark styling.
        const face = idleCorner.querySelector('.die .dice-face');
        expect(face).not.toBeNull();
        expect(face.querySelectorAll('.dice-dot').length).toBe(5);
    });

    it('falls back to the blank colored chip before the idle player has rolled', () => {
        updateCornerWidgets();
        const idleCorner = document.querySelector('#b1 .corner-dice');
        expect(idleCorner.classList.contains('corner-dice--idle')).toBe(true);
        expect(idleCorner.classList.contains('corner-dice--rolled')).toBe(false);
        expect(idleCorner.querySelector('.die')).toBeNull();
    });

    it('resetLastRolls clears stored rolls so a new game starts blank', () => {
        setLastRoll(1, 6);
        resetLastRolls();
        updateCornerWidgets();
        const idleCorner = document.querySelector('#b1 .corner-dice');
        expect(idleCorner.classList.contains('corner-dice--idle')).toBe(true);
    });
});
