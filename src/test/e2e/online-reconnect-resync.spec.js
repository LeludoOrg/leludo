import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

/**
 * Regression: an online client that MISSED server frames (a dropped socket, a
 * backgrounded radio) must re-sync on reconnect — board, turn counter AND the
 * held-turn state — it must not stay frozen behind the server and the other
 * player. Before the snapshot-authoritative ingest, the moves made while a
 * client was away were gone forever: its board froze while the server (and the
 * focused player) marched on ("2 pawns home on one screen, 1 on the other",
 * turn counters drifting apart).
 *
 * Disconnect semantics: the game keeps flowing only until the rotation reaches
 * the dropped player's turn, then HOLDS (turns are never skipped) — everyone
 * else sees the "waiting for X" banner. So while B is away the server still
 * advances at least the turns between the drop and B's seat; B misses those
 * frames. On reconnect the hold lifts, the catch-up snapshot restores B, and
 * both clients must agree again.
 *
 * Board parity uses a PERSPECTIVE-INVARIANT signal: the total number of pawns
 * parked in a yard (every `#h-*` slot, summed across all four players). Each
 * client renders the board rotated to sit itself bottom-right, so per-cell ids
 * differ between clients — but the yard TOTAL is the same board fact on every
 * screen.
 */

// Pawns sitting in a yard slot, summed across all players — invariant across the
// two clients' rotated perspectives.
const yardPawns = (page) => page.locator('[id^="h-"] wc-token').count();

// The displayed "Turn N" — server-authoritative, so it must match on every client.
const readTurn = async (page) => {
    const t = (await page.locator('#turn-counter').textContent().catch(() => '')) || '';
    return parseInt(t.replace(/\D/g, ''), 10) || 0;
};

// Fire this client's own roll/move intents (ignored by the server when it isn't
// this client's turn) to keep the table advancing; bot seats auto-advance too.
const nudge = async (page) => {
    await page.locator('wc-dice').click({ force: true }).catch(() => {});
    const tok = page.locator('wc-token .animate-bounce').first();
    if (await tok.count()) await tok.click({ force: true }).catch(() => {});
};

// Deterministically drop/restore the page's WebSocket. Playwright's
// context.setOffline doesn't close an already-open socket in this Chromium, so we
// wrap WebSocket: while "blocked", new sockets fake-close immediately (the
// net-client keeps retrying), and the live socket is force-closed — exactly a
// transient network drop. Installed before any page script runs.
async function installSocketControl(page) {
    await page.addInitScript(() => {
        const Real = window.WebSocket;
        window.__sockets = [];
        window.__wsBlocked = false;
        const Wrapped = function (...args) {
            if (window.__wsBlocked) {
                const fake = {
                    readyState: 3, send() {}, close() {},
                    addEventListener(type, cb) { if (type === 'close') setTimeout(() => cb({ code: 1006 }), 10); },
                    removeEventListener() {},
                };
                return fake;
            }
            const ws = new Real(...args);
            window.__sockets.push(ws);
            return ws;
        };
        Wrapped.OPEN = Real.OPEN; Wrapped.CONNECTING = Real.CONNECTING;
        Wrapped.CLOSING = Real.CLOSING; Wrapped.CLOSED = Real.CLOSED;
        Wrapped.prototype = Real.prototype;
        window.WebSocket = Wrapped;
    });
}
const dropSocket = (page) => page.evaluate(() => {
    window.__wsBlocked = true;
    (window.__sockets || []).forEach((w) => { try { w.close(); } catch {} });
});
const allowSocket = (page) => page.evaluate(() => { window.__wsBlocked = false; });

test('a client that missed moves while offline re-syncs its board on reconnect', async ({ browser }) => {
    test.setTimeout(120_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); // active driver
    const pageB = await ctxB.newPage(); // drops its socket, then reconnects
    await installSocketControl(pageB);

    const bErrors = [];
    pageB.on('pageerror', (e) => bErrors.push(String(e)));
    pageB.on('console', (m) => { if (m.type() === 'error') bErrors.push(m.text()); });

    // Host (A) creates a room; guest (B) joins; A fills the rest with bots so the
    // table keeps moving on its own while B is away.
    await openOnline(pageA, 'Anchor');
    await pageA.getByTestId('online-create').click();
    const code = (await pageA.getByTestId('online-room-code').textContent())?.trim();

    await openOnline(pageB, 'Drifter');
    await pageB.getByTestId('online-code-input').fill(code);
    await pageB.getByTestId('online-join').click();
    await expect(pageA.locator('.seat-list')).toContainText('Drifter');

    for (let i = 0; i < 4; i++) {
        const bot = pageA.getByTestId(`online-seat-${i}-bot`);
        if (await bot.count() && await bot.isVisible().catch(() => false)) await bot.click().catch(() => {});
    }
    await pageA.getByTestId('online-start').click();
    await expect(pageA.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    await expect(pageB.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
    await expect(pageB.locator('wc-board .board-grid')).toBeVisible();

    // Both boards start with all 16 pawns in their yards.
    await expect.poll(() => yardPawns(pageA)).toBe(16);
    await expect.poll(() => yardPawns(pageB)).toBe(16);

    // Drive the table until at least one pawn has launched, so there's a real
    // board to fall behind (both clients agree here — lockstep before the drop).
    await expect.poll(async () => { await nudge(pageA); await nudge(pageB); return yardPawns(pageA); },
        { timeout: 25_000, intervals: [300, 300, 300] }).toBeLessThan(16);
    await expect.poll(() => yardPawns(pageB)).toBe(await yardPawns(pageA));

    // Drop B's socket while the player right AFTER B's seat is mid-turn, so the
    // rotation has the most turns left to play (seat 3 → A → bot) before it
    // reaches B's seat and HOLDS — those are the frames B misses. B is server
    // seat 2 in a 4-seat ring, and a 4-player layout maps seats to board
    // positions 1:1 on B's screen, so polling for currentPlayerIndex 3 is
    // polling for server seat 3. Keep the window short so B reconnects well
    // inside the 30s grace and never forfeits.
    await expect.poll(async () => {
        await nudge(pageA); await nudge(pageB); // keep the table moving meanwhile
        return pageB.evaluate(async () =>
            (await import('/scripts/index.js')).state.currentPlayerIndex);
    }, { timeout: 30_000, intervals: [200, 200, 200] }).toBe(3);
    await dropSocket(pageB);
    await pageB.waitForTimeout(1500); // let any in-flight delta drain, then B is frozen
    const frozenTurnB = await readTurn(pageB);

    // The table advances the remaining turns, then HOLDS on B's seat: A sees the
    // "waiting for Drifter" banner — proof the turn was blocked, not skipped.
    await expect.poll(async () => { await nudge(pageA); return readTurn(pageA); },
        { timeout: 25_000, intervals: [300, 300, 300] }).toBeGreaterThan(frozenTurnB);
    await expect(pageA.getByTestId('net-waiting-banner')).toBeVisible({ timeout: 20_000 });
    await expect(pageA.getByTestId('net-waiting-banner')).toContainText('Drifter');

    // Confirm the desync is real: B's turn counter has fallen behind A's (the
    // live "218 vs 214" symptom — B missed the frames since the drop).
    expect(await readTurn(pageB)).toBeLessThan(await readTurn(pageA));

    // B comes back. The net client auto-reconnects; the server lifts the hold
    // and replies with the catch-up snapshot B must restore from — board, turn
    // count, phase and movable tokens (it may be B's own held turn).
    //
    // Reconnect here depends on the DO completing the WS closing handshake: when
    // B's socket closed gracefully the server MUST reciprocate, or the browser
    // socket hangs in CLOSING, its `close` event never fires, and net-client never
    // starts its reconnect loop. The Node `ws` dev server auto-reciprocated and hid
    // this; workerd does not, so room-do._onClose closes the server socket back
    // (regression for that — this test froze on "Waiting for Drifter…" without it).
    await allowSocket(pageB);

    // The hold lifts on every screen.
    await expect(pageA.getByTestId('net-waiting-banner')).toBeHidden({ timeout: 20_000 });
    await expect(pageB.getByTestId('net-waiting-banner')).toBeHidden();

    // Core assertion: both clients converge on the same LIVE board — same yard
    // total and the same server-authoritative "Turn N", advancing past the held
    // turn (so the game actually resumed, not just unfroze). Both clients keep
    // nudging since the resumed turn may be either human's.
    await expect.poll(async () => {
        await nudge(pageA);
        await nudge(pageB);
        const [ya, yb] = await Promise.all([yardPawns(pageA), yardPawns(pageB)]);
        const [ta, tb] = await Promise.all([readTurn(pageA), readTurn(pageB)]);
        return ya === yb && ta === tb && ta > frozenTurnB;
    }, { timeout: 60_000, intervals: [500, 500, 500] }).toBe(true);

    expect(bErrors, `reconnecting client console errors:\n${bErrors.join('\n')}`).toHaveLength(0);

    await ctxA.close();
    await ctxB.close();
});
