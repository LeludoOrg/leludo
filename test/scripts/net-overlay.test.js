import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { showPeerReconnect, showSelfReconnect, showSelfGaveUp, hideOverlay } from '../../scripts/net-overlay.js';

/**
 * The connection-issues overlay: peer countdown ticks down each second, self
 * mode shows a spinner with no timer, and an empty peer list hides it. Guards
 * the disconnect UX so a frozen game always tells players what's happening.
 */
const OVERLAY_HTML = `
<div id="net-disconnect-overlay" class="frame-overlay hidden" data-testid="net-disconnect-overlay">
  <div class="net-dc-spinner"></div>
  <h2 data-testid="net-dc-title"></h2>
  <p data-testid="net-dc-msg"></p>
  <div data-testid="net-dc-timer"></div>
</div>`;

const o = () => document.getElementById('net-disconnect-overlay');
const text = (id) => o().querySelector(`[data-testid="${id}"]`).textContent;
const hidden = () => o().classList.contains('hidden');

describe('net-overlay', () => {
    beforeEach(() => {
        document.body.innerHTML = OVERLAY_HTML;
        vi.useFakeTimers();
    });
    afterEach(() => {
        hideOverlay();
        vi.useRealTimers();
        document.body.innerHTML = '';
    });

    it('shows one reconnecting peer with a live countdown', () => {
        showPeerReconnect([{ index: 1, name: 'Alice', remainingMs: 30_000 }]);
        expect(hidden()).toBe(false);
        expect(text('net-dc-title')).toBe('Connection issues');
        expect(text('net-dc-msg')).toContain('Alice');
        expect(text('net-dc-timer')).toBe('30s');

        vi.advanceTimersByTime(1000);
        expect(text('net-dc-timer')).toBe('29s'); // ticks down

        vi.advanceTimersByTime(60_000);
        expect(text('net-dc-timer')).toBe('0s'); // floors at zero, never negative
    });

    it('shows the soonest deadline and both names for multiple peers', () => {
        showPeerReconnect([
            { index: 1, name: 'Alice', remainingMs: 25_000 },
            { index: 3, name: 'Bob', remainingMs: 12_000 },
        ]);
        expect(text('net-dc-title')).toBe('Players reconnecting');
        expect(text('net-dc-msg')).toContain('Alice');
        expect(text('net-dc-msg')).toContain('Bob');
        expect(text('net-dc-timer')).toBe('12s'); // the more urgent of the two
    });

    it('hides when the peer list is empty (everyone resolved)', () => {
        showPeerReconnect([{ index: 1, name: 'Alice', remainingMs: 30_000 }]);
        showPeerReconnect([]);
        expect(hidden()).toBe(true);
    });

    it('self mode spins without a server countdown', () => {
        showSelfReconnect();
        expect(hidden()).toBe(false);
        expect(o().dataset.mode).toBe('self');
        expect(text('net-dc-title')).toBe('Connection lost');
        expect(text('net-dc-timer')).toBe('');

        showSelfGaveUp();
        expect(text('net-dc-title')).toBe('Disconnected');
    });
});
