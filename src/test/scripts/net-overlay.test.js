import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setDimmedPlayers, showSelfReconnect, showSelfGaveUp, hideSelfBanner, clearPresence } from '../../scripts/net/net-overlay.js';

/**
 * Disconnect presence: a dropped opponent is DIMMED on the board (corner widget,
 * home quad, pawns) while the game plays on — no blocking overlay. A small
 * banner appears only when this client itself is reconnecting.
 */
const BOARD_HTML = `
  <div id="b0"></div><div id="b1"></div><div id="b2"></div><div id="b3"></div>
  <div class="home-quad home-quad--tl player-bg-0"></div>
  <div class="home-quad home-quad--tr player-bg-1"></div>
  <span id="p-1-0"></span><span id="p-1-1"></span>
  <span id="p-0-0"></span>
  <div id="net-reconnect-banner" class="net-reconnect-banner hidden"></div>`;

const dimmed = (sel) => document.querySelector(sel).classList.contains('net-dimmed');
const banner = () => document.getElementById('net-reconnect-banner');

describe('net-overlay — disconnect presence', () => {
    beforeEach(() => { document.body.innerHTML = BOARD_HTML; });
    afterEach(() => { document.body.innerHTML = ''; });

    it('dims exactly the named players (corner, home quad, pawns)', () => {
        setDimmedPlayers([1]);
        expect(dimmed('#b1')).toBe(true);
        expect(dimmed('.player-bg-1')).toBe(true);
        expect(dimmed('#p-1-0')).toBe(true);
        expect(dimmed('#p-1-1')).toBe(true);
        // Player 0 stays fully visible — the game continues for them.
        expect(dimmed('#b0')).toBe(false);
        expect(dimmed('.player-bg-0')).toBe(false);
        expect(dimmed('#p-0-0')).toBe(false);
    });

    it('un-dims a player who is no longer in the disconnected set', () => {
        setDimmedPlayers([1]);
        setDimmedPlayers([]); // reconnected / forfeited
        expect(dimmed('#b1')).toBe(false);
        expect(dimmed('#p-1-0')).toBe(false);
    });

    it('shows a non-blocking banner only when this client reconnects', () => {
        showSelfReconnect();
        expect(banner().classList.contains('hidden')).toBe(false);
        expect(banner().textContent.toLowerCase()).toContain('reconnect');

        hideSelfBanner();
        expect(banner().classList.contains('hidden')).toBe(true);

        showSelfGaveUp();
        expect(banner().textContent.toLowerCase()).toContain('disconnected');
    });

    it('clearPresence wipes all cues', () => {
        setDimmedPlayers([1]);
        showSelfReconnect();
        clearPresence();
        expect(dimmed('#b1')).toBe(false);
        expect(banner().classList.contains('hidden')).toBe(true);
    });
});
