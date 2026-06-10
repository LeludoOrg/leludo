import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

/**
 * Regression: an online client that MISSED server moves (a dropped socket, a
 * backgrounded radio, a throttled animation step) must re-sync its board on the
 * next server frame — it must not stay frozen a few turns behind the server and
 * the other player.
 *
 * The online renderer replays the server's roll/move deltas through the local
 * engine and RE-DERIVES captures locally; it used to ignore the full authoritative
 * `positions` the server stamps on every frame — including the catch-up snapshot
 * sent on reconnect. So the moment a client missed even one `moved` frame, the
 * moves made while it was away were gone forever: its board froze while the server
 * (and the focused player) marched on. The live symptom was a captured pawn that
 * had gone home on one screen still sitting on the track on the other ("2 pawns
 * home on one screen, 1 on the other"), and the turn counters drifting apart.
 *
 * The fix folds the server snapshot back in after every delta (NET_RECONCILE).
 *
 * We assert it with a PERSPECTIVE-INVARIANT signal: the total number of pawns
 * parked in a yard (every `#h-*` slot, summed across all four players). Each
 * client renders the board rotated to sit itself bottom-right, so per-cell ids
 * differ between clients — but the yard TOTAL is the same board fact on every
 * screen. While B is offline and the table keeps launching/capturing pawns, that
 * total changes on the server but freezes on B; after B reconnects it must snap
 * back to match A. Before the fix it stays diverged.
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

    // B's socket drops; the server skips its turn and keeps the table running
    // (A + the bots). Keep the window short so B reconnects well inside the 30s
    // grace and never forfeits its seat.
    await dropSocket(pageB);
    await pageB.waitForTimeout(1500); // let any in-flight delta drain, then B is frozen
    const frozenB = await yardPawns(pageB);

    // Advance the server board a clear margin while B is away.
    await expect.poll(async () => { await nudge(pageA); return yardPawns(pageA); },
        { timeout: 25_000, intervals: [300, 300, 300] }).toBeLessThanOrEqual(frozenB - 2);

    // Confirm the desync is real: B is now stuck BEHIND the server (more pawns
    // still in yards than A, because it missed the launches/captures) AND its
    // turn counter has fallen behind A's (the live "218 vs 214" symptom).
    const [awayA, awayB] = await Promise.all([yardPawns(pageA), yardPawns(pageB)]);
    expect(awayB).toBeGreaterThan(awayA);
    expect(await readTurn(pageB)).toBeLessThan(await readTurn(pageA));

    // B comes back. The net client auto-reconnects; the server replies with the
    // catch-up snapshot and B must reconcile onto the server's board.
    await allowSocket(pageB);

    // Core assertion: B's yard total converges to A's. Both clients track the same
    // server board, so they agree in the quiescent gaps between moves; keep A
    // advancing so we're reconciling a LIVE game, not a frozen one. Before the fix
    // B stays stuck behind and never matches.
    await expect.poll(async () => {
        await nudge(pageA);
        const [a, b] = await Promise.all([yardPawns(pageA), yardPawns(pageB)]);
        return b === a && b < frozenB; // converged onto the board B had missed
    }, { timeout: 60_000, intervals: [500, 500, 500] }).toBe(true);

    // The turn counter is server-authoritative too: both clients must agree on
    // "Turn N" in the quiescent gap after a turn passes (no per-client tally drift).
    await expect.poll(async () => {
        await nudge(pageA);
        const [a, b] = await Promise.all([readTurn(pageA), readTurn(pageB)]);
        return a > 0 && a === b;
    }, { timeout: 30_000, intervals: [500, 500, 500] }).toBe(true);

    expect(bErrors, `reconnecting client console errors:\n${bErrors.join('\n')}`).toHaveLength(0);

    await ctxA.close();
    await ctxB.close();
});
