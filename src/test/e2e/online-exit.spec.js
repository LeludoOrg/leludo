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
 *   - "Leave game" exits home with the socket down, so the seat forfeits through
 *     the same grace window a drop uses; with one human left the game ends.
 *
 * `?grace=6000` shortens the server forfeit window; `?exitCountdown=60` makes the
 * confirmation's auto-leave timer long enough that it never races our clicks.
 */
const OPTS = '?grace=6000&exitCountdown=60';

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
    // game ends once the grace window forfeits the abandoned seat. ---
    await menuBtn.click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeVisible();
    await pageA.getByTestId('online-exit-leave').click();
    await expect(pageA.getByTestId('online-exit-menu')).toBeHidden();
    await expect(pageA.getByTestId('home-new-game')).toBeVisible(); // back on the home screen

    // Alice's socket stays down → her seat forfeits → one human left → game ends.
    await expect(pageB.locator('wc-game-end .ge-screen')).toBeVisible({ timeout: 15_000 });

    await ctxA.close();
    await ctxB.close();
});
