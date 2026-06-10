import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

/**
 * Regression: a backgrounded online client must stay in sync with the server.
 *
 * Online play replays every server broadcast (roll / move) through a SERIAL
 * promise queue that awaits the board animations — the dice spin and the token
 * glide. Those two animations drove themselves with requestAnimationFrame, which
 * the browser PAUSES while a tab is hidden/occluded (other timer-based overlays
 * survive, rAF does not). So a backgrounded client wedged on the first roll or
 * move it had to replay while hidden: its queue never drained, its board froze a
 * few turns behind the server, and its dice stopped responding — while the
 * server (and the focused player) marched on. That is the "opponent's pawn at the
 * wrong spot, bouncing, turn never passes, dice not clickable" bug.
 *
 * The fix makes the replay animations resolve immediately when document.hidden,
 * so the queue keeps draining and the hidden client tracks the server's turns.
 * Here we put a real client into the genuine hidden state (document.hidden = true
 * AND requestAnimationFrame paused, exactly like a backgrounded tab) and require
 * its turn counter to keep climbing in lockstep — proof the queue never wedges.
 */

const readTurn = async (page) => {
    const t = (await page.locator('#turn-counter').textContent().catch(() => '')) || '';
    return parseInt(t.replace(/\D/g, ''), 10) || 0;
};

test('a hidden/backgrounded client keeps replaying server turns (no wedge)', async ({ browser }) => {
    test.setTimeout(90_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); // host, then backgrounded
    const pageB = await ctxB.newPage(); // active driver

    const aErrors = [];
    pageA.on('pageerror', (e) => aErrors.push(String(e)));
    pageA.on('console', (m) => { if (m.type() === 'error') aErrors.push(m.text()); });

    // Host (A) creates a room; guest (B) joins; A fills the rest with bots.
    await openOnline(pageA, 'Ahidden');
    await pageA.getByTestId('online-create').click();
    const code = (await pageA.getByTestId('online-room-code').textContent())?.trim();

    await openOnline(pageB, 'Bactive');
    await pageB.getByTestId('online-code-input').fill(code);
    await pageB.getByTestId('online-join').click();
    await expect(pageA.locator('.seat-list')).toContainText('Bactive');

    for (let i = 0; i < 4; i++) {
        const bot = pageA.getByTestId(`online-seat-${i}-bot`);
        if (await bot.count() && await bot.isVisible().catch(() => false)) await bot.click().catch(() => {});
    }
    await pageA.getByTestId('online-start').click();
    await expect(pageA.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    await expect(pageB.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    await expect(pageA.locator('wc-board .board-grid')).toBeVisible();

    // Put A into the genuine hidden state: document.hidden === true AND rAF paused
    // (never fires) — exactly what the browser does to a backgrounded tab. Before
    // the fix, A's replay queue wedges on the first animated broadcast and its turn
    // counter freezes near 0.
    await pageA.evaluate(() => {
        Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
        window.requestAnimationFrame = () => 0;
        document.dispatchEvent(new Event('visibilitychange'));
    });

    // Drive the table from B (+ server-side bots); also fire A's own roll/move
    // intents (clicks send intents regardless of focus, so A's turns resolve too).
    // A's board is updated only by replaying server broadcasts — the path under test.
    await expect.poll(async () => {
        for (const p of [pageB, pageA]) {
            await p.locator('wc-dice').click({ force: true }).catch(() => {});
            const tok = p.locator('wc-token .animate-bounce').first();
            if (await tok.count()) await tok.click({ force: true }).catch(() => {});
        }
        return readTurn(pageA);
    }, { timeout: 60_000, intervals: [350, 350, 350] }).toBeGreaterThan(8);

    expect(aErrors, `hidden client console errors:\n${aErrors.join('\n')}`).toHaveLength(0);

    await ctxA.close();
    await ctxB.close();
});
