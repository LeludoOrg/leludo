import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

/**
 * Online "leave the match" flow. A live server game can't be paused, so the
 * in-game menu button is an EXIT, not a pause: it opens a confirmation with a
 * countdown and, crucially, drops the player's socket so the OTHERS see them as
 * disconnected while they decide.
 *
 *   - Tapping exit dims the leaver on the opponent's board (a real disconnect).
 *   - "Stay in game" reels them back in — the dim clears (a reconnect).
 *   - "Leave game" forfeits the seat IMMEDIATELY (an explicit LEAVE), not after
 *     the reconnect grace; with one human left the game ends right away.
 *
 * `?grace=60000` makes the server's reconnect window LONG on purpose: if "Leave"
 * regressed to forfeiting via grace, the final game-end assertion would time out
 * waiting a full minute. The immediate-forfeit path ends it in a beat instead.
 * `?exitCountdown=60` keeps the dialog's auto-leave timer from racing our clicks.
 */
const OPTS = '?grace=60000&exitCountdown=60';

test('exit replaces pause online: confirm dims the leaver, Stay reconnects, Leave forfeits', async ({ browser }) => {
    test.setTimeout(60_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage(); // host — does the leaving
    const pageB = await ctxB.newPage(); // opponent — observes the disconnect

    // Host creates the room; guest joins by code; host starts.
    await openOnline(pageA, 'Alice', OPTS);
    await pageA.getByTestId('online-create').click();
    const code = (await pageA.getByTestId('online-room-code').textContent())?.trim();
    expect(code).toBeTruthy();

    await openOnline(pageB, 'Bob', OPTS);
    await pageB.getByTestId('online-code-input').fill(code);
    await pageB.getByTestId('online-join').click();
    // Two humans seat diagonally opposite: Alice seat 0, Bob seat 2.
    await expect(pageA.getByTestId('online-seat-2')).toContainText('Bob');
    await pageA.getByTestId('online-start').click();

    await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
    await expect(pageB.locator('wc-board .board-grid')).toBeVisible();

    // The in-game menu button is the exit (leave), not pause, when online.
    const menuBtn = pageA.locator('#g-pause-btn');
    await expect(menuBtn).toHaveAttribute('aria-label', 'Leave game');

    // --- Tap exit: the confirmation opens with a countdown, and Bob sees Alice
    // go disconnected (Alice seat 0 → board position 0 on Bob's rotated screen). ---
    await menuBtn.click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeVisible();
    await expect(pageA.getByTestId('online-exit-countdown')).toBeVisible();
    await expect(pageB.locator('#b0')).toHaveClass(/net-dimmed/, { timeout: 10_000 });

    // --- Stay: Alice reconnects, the confirmation closes, Bob's dim clears. ---
    await pageA.getByTestId('online-exit-stay').click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeHidden();
    await expect(pageB.locator('#b0')).not.toHaveClass(/net-dimmed/, { timeout: 10_000 });
    // Still in the live game on both screens.
    await expect(pageA.locator('wc-board .board-grid')).toBeVisible();

    // --- Exit again, then Leave for good: Alice lands back on home, and Bob's
    // game ends IMMEDIATELY — the explicit leave forfeits the seat at once. ---
    await menuBtn.click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeVisible();
    await pageA.getByTestId('online-exit-leave').click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeHidden();
    await expect(pageA.getByTestId('home-new-game')).toBeVisible(); // back on the home screen

    // Alice's seat forfeits on the spot → one human left → game ends. The short
    // timeout (vs the 60s grace set above) is the regression guard: a grace-only
    // forfeit could not make this assertion in time.
    await expect(pageB.locator('wc-game-end .ge-screen')).toBeVisible({ timeout: 10_000 });

    await ctxA.close();
    await ctxB.close();
});
