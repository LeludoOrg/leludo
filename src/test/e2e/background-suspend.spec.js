import { test, expect } from '@playwright/test';
import { openOnline, startGame } from './helpers.js';

/**
 * Background-suspend: leaving the app mid-game must not keep it running
 * unattended. When the page goes hidden (home button, app switch, screen lock,
 * tab change) while a board is live:
 *
 *   - OFFLINE → the game PAUSES (pause menu shows, turn loop frozen), so a bot
 *     turn can't play out while the player is away.
 *   - ONLINE → the leave/exit confirmation opens (a live server game can't be
 *     frozen), dropping our socket exactly like tapping the exit door.
 *
 * Backgrounding from a non-game screen does nothing. See
 * scripts/platform/background-suspend.js.
 *
 * This supersedes the old online-hidden-tab spec: a backgrounded online client
 * no longer silently keeps replaying server turns — it opens the exit screen.
 */

// Force document.hidden true and fire visibilitychange — the web background
// signal (Capacitor's App 'pause' is the native equivalent, unreachable here).
async function background(page) {
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
}

test.describe('Background suspend', () => {
    test('offline game pauses when the app is backgrounded', async ({ page }) => {
        await startGame(page);

        // Not paused while in the foreground.
        expect(await page.evaluate(async () =>
            (await import('/scripts/index.js')).isGameLogicPaused())).toBe(false);

        await background(page);

        // Backgrounding freezes the turn loop and surfaces the pause menu —
        // identical to tapping the pause button.
        await expect.poll(() => page.evaluate(async () =>
            (await import('/scripts/index.js')).isGameLogicPaused())).toBe(true);
        await expect(page.locator('#pause-menu')).toBeVisible();
    });

    test('backgrounding from the home screen does nothing', async ({ page }) => {
        await page.goto('/');
        await background(page);
        // No game is running, so no pause menu pops up.
        await expect(page.locator('#pause-menu')).toBeHidden();
        expect(await page.evaluate(async () =>
            (await import('/scripts/index.js')).isGameLogicPaused())).toBe(false);
    });

    test('online game opens the leave screen when backgrounded', async ({ browser }) => {
        test.setTimeout(60_000);
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage(); // host — gets backgrounded
        const pageB = await ctxB.newPage(); // opponent — needed to start the match

        const OPTS = '?grace=6000';
        await openOnline(pageA, 'Alice', OPTS);
        await pageA.getByTestId('online-create').click();
        const code = (await pageA.getByTestId('online-room-code').textContent())?.trim();
        expect(code).toBeTruthy();

        await openOnline(pageB, 'Bob', OPTS);
        await pageB.getByTestId('online-code-input').fill(code);
        await pageB.getByTestId('online-join').click();
        await expect(pageA.getByTestId('online-seat-2')).toContainText('Bob');
        await pageA.getByTestId('online-start').click();

        await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
        await expect(pageB.locator('wc-board .board-grid')).toBeVisible();

        // Background Alice's app: instead of pausing (impossible online), the
        // leave/exit confirmation opens, and Bob sees Alice disconnect.
        await background(pageA);
        await expect(pageA.getByTestId('online-exit-menu')).toBeVisible();
        // Countdown now starts at 60 seconds (was 30) — tolerate one tick of drift.
        await expect(pageA.getByTestId('online-exit-countdown')).toHaveText(/^(60|59)$/);
        await expect(pageB.locator('#b0')).toHaveClass(/net-dimmed/, { timeout: 10_000 });

        await ctxA.close();
        await ctxB.close();
    });
});
