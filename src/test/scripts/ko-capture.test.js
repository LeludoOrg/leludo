import { describe, it, expect, beforeEach } from 'vitest';
import { playKOCapture } from '../../scripts/render/ko-capture.js';

// happy-dom doesn't implement Element.animate. Stub it so the overlay's
// keyframe calls become harmless no-ops in tests.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
    Element.prototype.animate = function () {
        return { cancel() {}, finish() {}, onfinish: null };
    };
}

describe('playKOCapture', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        const old = document.getElementById('kocap-styles');
        if (old) old.remove();
    });

    it('throws when container or capture missing', () => {
        expect(() => playKOCapture({})).toThrow();
        expect(() => playKOCapture({ container: document.body })).toThrow();
    });

    it('flying pawn uses the real wc-token shape, square', () => {
        // Regression: the knockout overlay used to draw a chess-pawn shape
        // in a 60x80 viewBox at 0.75 aspect — a different pawn than the game
        // token. It must reuse wc-token's body path in a square 100x100
        // viewBox so the captured pawn matches the on-board token.
        const container = document.createElement('div');
        document.body.appendChild(container);

        playKOCapture({
            container,
            capture: { x: 100, y: 100 },
            homeBase: { x: 20, y: 20 },
            attackerColor: '#cf4a3a',
            defenderColor: '#2f9456',
            pawnSize: 40,
            duration: 60,
            shakeBoard: false,
        });

        const svg = container.querySelector('.kocap-pawn-svg');
        expect(svg.getAttribute('viewBox')).toBe('0 0 100 100');
        expect(svg.getAttribute('width')).toBe(svg.getAttribute('height'));
        expect(
            svg.querySelector('path[d="M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z"]')
        ).toBeTruthy();
    });

    it('captured pawn never fades out during its flight home', () => {
        // Regression: the flight keyframes faded the pawn to opacity 0 over
        // the last 15% of the arc, so it vanished mid-air and only "appeared"
        // at home when the real token was revealed — a jarring gap. The pawn
        // must stay solid for the whole throw.
        const calls = [];
        const orig = Element.prototype.animate;
        Element.prototype.animate = function (keyframes, opts) {
            calls.push({ el: this, keyframes });
            return orig.call(this, keyframes, opts);
        };
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            playKOCapture({
                container,
                capture: { x: 100, y: 100 },
                homeBase: { x: 20, y: 20 },
                pawnSize: 40,
                duration: 60,
                shakeBoard: false,
            });
            const pawnCall = calls.find(
                c => c.el.classList && c.el.classList.contains('kocap-pawn-wrap')
            );
            expect(pawnCall).toBeTruthy();
            const faded = pawnCall.keyframes.some(
                k => typeof k.opacity === 'number' && k.opacity < 1
            );
            expect(faded).toBe(false);
        } finally {
            Element.prototype.animate = orig;
        }
    });

    it('scales the flying pawn to the home-seat size by its final frame', () => {
        // The overlay must land at the real token's exact resting footprint
        // (endScale) so revealing the live token causes no readjust pop.
        const calls = [];
        const orig = Element.prototype.animate;
        Element.prototype.animate = function (keyframes, opts) {
            calls.push({ el: this, keyframes });
            return orig.call(this, keyframes, opts);
        };
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            playKOCapture({
                container,
                capture: { x: 100, y: 100 },
                homeBase: { x: 20, y: 20 },
                pawnSize: 40,
                endScale: 0.5,
                duration: 60,
                shakeBoard: false,
            });
            const pawnCall = calls.find(
                c => c.el.classList && c.el.classList.contains('kocap-pawn-wrap')
            );
            expect(pawnCall).toBeTruthy();
            const last = pawnCall.keyframes[pawnCall.keyframes.length - 1];
            expect(last.transform).toContain('scale(0.500)');
        } finally {
            Element.prototype.animate = orig;
        }
    });

    it('removes overlay root and resolves after duration', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        await playKOCapture({
            container,
            capture: { x: 100, y: 100 },
            homeBase: { x: 20, y: 20 },
            pawnSize: 40,
            duration: 60,
            shakeBoard: false,
        });

        expect(container.querySelector('.kocap-root')).toBeNull();
    });
});
