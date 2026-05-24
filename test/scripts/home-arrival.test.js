import { describe, it, expect, beforeEach } from 'vitest';
import { playHomeArrival } from '../../scripts/home-arrival.js';

// happy-dom doesn't implement Element.animate. Stub it so the overlay's
// keyframe calls become harmless no-ops in tests.
if (typeof Element !== 'undefined' && !Element.prototype.animate) {
    Element.prototype.animate = function () {
        return { cancel() {}, finish() {}, onfinish: null };
    };
}

describe('playHomeArrival', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        const old = document.getElementById('hmarr-styles');
        if (old) old.remove();
    });

    it('throws when container or home missing', () => {
        expect(() => playHomeArrival({})).toThrow();
        expect(() => playHomeArrival({ container: document.body })).toThrow();
        expect(() => playHomeArrival({ home: { x: 0, y: 0 } })).toThrow();
    });

    it('injects stylesheet once and appends overlay root to container', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        playHomeArrival({
            container,
            home: { x: 100, y: 100 },
            duration: 60,
        });

        expect(document.getElementById('hmarr-styles')).toBeTruthy();
        expect(container.querySelector('.hmarr-root')).toBeTruthy();

        playHomeArrival({
            container,
            home: { x: 50, y: 50 },
            duration: 60,
        });
        expect(document.querySelectorAll('#hmarr-styles')).toHaveLength(1);
    });

    it('removes overlay root and resolves promise after duration', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        await playHomeArrival({
            container,
            home: { x: 100, y: 100 },
            source: { x: 50, y: 50 },
            color: '#cf4a3a',
            pawnSize: 40,
            duration: 80,
            flashBoard: true,
        });

        expect(container.querySelector('.hmarr-root')).toBeNull();
    });

    it('fires onComplete callback after cleanup', async () => {
        const container = document.createElement('div');
        document.body.appendChild(container);
        let called = false;

        await playHomeArrival({
            container,
            home: { x: 10, y: 10 },
            duration: 50,
            onComplete: () => { called = true; },
        });

        expect(called).toBe(true);
    });

    it('renders confetti + label + ring atoms inside overlay', () => {
        const container = document.createElement('div');
        document.body.appendChild(container);

        playHomeArrival({
            container,
            home: { x: 100, y: 100 },
            source: { x: 60, y: 80 },
            duration: 200,
        });

        const root = container.querySelector('.hmarr-root');
        expect(root.querySelector('.hmarr-pawn-wrap')).toBeTruthy();
        // burst (ring + confetti + label) is scheduled after travelMs (~80ms).
        return new Promise(resolve => setTimeout(() => {
            expect(root.querySelector('.hmarr-ring')).toBeTruthy();
            expect(root.querySelector('.hmarr-confetti')).toBeTruthy();
            expect(root.querySelector('.hmarr-label')).toBeTruthy();
            resolve();
        }, 100));
    });
});
