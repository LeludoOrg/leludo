import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { playPawnStep } from '../../scripts/render/pawn-step.js';

// happy-dom doesn't implement Element.animate. Stub it so the landing bounce's
// keyframe call becomes a harmless no-op in tests.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
    Element.prototype.animate = function () {
        return { cancel() {}, finish() {}, onfinish: null };
    };
}

const PATH = [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 50, y: 10 }];

describe('playPawnStep', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        const old = document.getElementById('pstep-styles');
        if (old) old.remove();
    });

    it('throws when container or a 2+ point path is missing', () => {
        expect(() => playPawnStep({})).toThrow();
        expect(() => playPawnStep({ container: document.body })).toThrow();
        // a single point is not enough to hop a gap
        expect(() => playPawnStep({ container: document.body, path: [{ x: 0, y: 0 }] })).toThrow();
    });

    it('injects stylesheet once and appends overlay root to container', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        playPawnStep({ container, path: PATH, stepDur: 20 });
        expect(document.getElementById('pstep-styles')).toBeTruthy();
        expect(container.querySelector('.pstep-root')).toBeTruthy();

        playPawnStep({ container, path: PATH, stepDur: 20 });
        expect(document.querySelectorAll('#pstep-styles')).toHaveLength(1);
    });

    it('hopping pawn uses the real shared wc-token shape', () => {
        // Regression: the design reference shipped a placeholder glyph. The
        // overlay must reuse pawn-shape.js (0 0 100 116 viewBox, shared body
        // path) so the hopping pawn matches the on-board token. pawnSize is the
        // WIDTH; height = width * 1.16 (taller pawn).
        const container = document.createElement('div');
        document.body.appendChild(container);

        playPawnStep({ container, path: PATH, pawnSize: 40, stepDur: 20 });

        const svg = container.querySelector('.pstep-pawn-svg');
        expect(svg.getAttribute('viewBox')).toBe('0 0 100 116');
        expect(svg.getAttribute('width')).toBe('40');
        expect(svg.getAttribute('height')).toBe(String(40 * 1.16));
        expect(
            svg.querySelector('path[d="M30 100 Q22 84 33 60 Q40 49 41 41 L59 41 Q60 49 67 60 Q78 84 70 100 Z"]')
        ).toBeTruthy();
    });

    it('anchors the wrap by its feet (bottom-center on path[0]) so the end frame matches a settled token', () => {
        // Regression: the overlay used to anchor a SQUARE box on the cell center
        // with transform-origin 86%, so the hop ended ~0.16·cell LOWER than a
        // floor-anchored on-board token settles → a visible "settle a touch
        // higher" pop on reveal. The wrap is now width × width·1.16, positioned
        // with its bottom edge (the contact line) on the feet point.
        const container = document.createElement('div');
        document.body.appendChild(container);
        const SIZE = 40, H = 40 * 1.16;
        const p0 = { x: 100, y: 200 };

        playPawnStep({ container, path: [p0, { x: 130, y: 200 }], pawnSize: SIZE, stepDur: 20 });

        const wrap = container.querySelector('.pstep-pawn-wrap');
        expect(wrap.style.width).toBe(`${SIZE}px`);
        expect(wrap.style.height).toBe(`${H}px`);
        expect(wrap.style.left).toBe(`${p0.x - SIZE / 2}px`); // centered horizontally
        expect(wrap.style.top).toBe(`${p0.y - H}px`);          // bottom edge sits on the feet point
    });

    it('renders a contact shadow that tracks the pawn', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        playPawnStep({ container, path: PATH, stepDur: 20 });
        expect(container.querySelector('.pstep-shadow')).toBeTruthy();
    });

    it('fires onStep once per cell gap, then cleans up and resolves', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const steps = [];

        await playPawnStep({
            container,
            path: PATH,            // 3 points → 2 gaps
            stepDur: 20,
            onStep: (i) => steps.push(i),
        });

        expect(steps).toEqual([0, 1]);
        expect(container.querySelector('.pstep-root')).toBeNull();
    });

    it('fires onComplete after cleanup', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        let called = false;
        await playPawnStep({ container, path: PATH, stepDur: 20, onComplete: () => { called = true; } });
        expect(called).toBe(true);
    });

    it('fires onArrive exactly once, on contact, before cleanup', async () => {
        // Regression: a capturing move used to start its KO only after the
        // attacker's full landing (settle bounce + handoff) had played out — a
        // visible dead beat. onArrive fires the instant the pawn touches its
        // final cell (before the bounce/cleanup), so the caller can launch the
        // capture on contact and overlap the settle.
        const container = document.createElement('div');
        document.body.appendChild(container);
        let arriveCount = 0;
        let rootMountedAtArrive = false;
        await playPawnStep({
            container,
            path: PATH,
            stepDur: 20,
            onArrive: () => {
                arriveCount++;
                rootMountedAtArrive = !!container.querySelector('.pstep-root');
            },
        });
        expect(arriveCount).toBe(1);
        expect(rootMountedAtArrive).toBe(true); // fired while the overlay still lived
    });

    it('accepts finalHopBig (taller last hop) without breaking the hop loop', async () => {
        // The finish leap reuses this hop with only a taller final segment. A bad
        // last-step branch could skip onStep/onArrive or wedge cleanup — guard it.
        const container = document.createElement('div');
        document.body.appendChild(container);
        const steps = [];
        let arrived = 0;
        await playPawnStep({
            container,
            path: PATH,            // 3 points → 2 gaps; the 2nd is the "final" hop
            stepDur: 20,
            finalHopBig: 1.6,      // much taller than the default 0.64 big-hop
            onStep: (i) => steps.push(i),
            onArrive: () => { arrived++; },
        });
        expect(steps).toEqual([0, 1]);
        expect(arrived).toBe(1);
        expect(container.querySelector('.pstep-root')).toBeNull();
    });

    it('reduced motion still fires onArrive on the snap', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const orig = window.matchMedia;
        window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
        try {
            let arrived = 0;
            await playPawnStep({
                container,
                path: PATH,
                stepDur: 1000,
                onArrive: () => { arrived++; },
            });
            expect(arrived).toBe(1);
        } finally {
            window.matchMedia = orig;
        }
    });

    it('reduced motion snaps to the destination instead of hopping', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        const orig = window.matchMedia;
        window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
        try {
            const steps = [];
            await playPawnStep({ container, path: PATH, stepDur: 1000, onStep: (i) => steps.push(i) });
            // every gap still reported (state/sound parity), overlay removed fast
            expect(steps).toEqual([0, 1]);
            expect(container.querySelector('.pstep-root')).toBeNull();
        } finally {
            window.matchMedia = orig;
        }
    });
});
