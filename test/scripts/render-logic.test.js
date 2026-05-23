import { describe, it, expect } from 'vitest';
import { getContainerPath, pinTokenForCapture, updateCellStacking } from '../../scripts/render-logic.js';

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
