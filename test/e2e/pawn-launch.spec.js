import { test, expect } from '@playwright/test';

/**
 * Regression for pawn-launch overlay.
 *
 * Bug: when a pawn left the yard via the launch animation, the
 * `home-slot-dot` element (dark fill + colored ring) was revealed
 * underneath the hidden live token, painting a visible dark "rounded
 * square" inside the player's yard while the overlay was mid-flight.
 *
 * Fix: playYardLaunch hides the source `h-<player>-<token>` slot for
 * the duration of the overlay, then restores its inline visibility
 * once the promise resolves. After resolve the slot is empty (token
 * has moved to the entry cell) so it shows the dot again, which is
 * the correct steady-state behaviour.
 *
 * The assertion below would have failed against the pre-fix code:
 * during the animation `h-0-0`'s computed visibility would have been
 * `visible` even though the live token was hidden.
 */

test.describe('Pawn launch overlay', () => {
    test('hides yard slot dot while the launch overlay plays', async ({ page }) => {
        // Start a normal game; positions default to all-in-yard.
        await page.goto('/?player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();
        await page.locator('#h-0-0').waitFor();

        // Fire the same code path normal play uses for yard → entry. We
        // dispatch GOD_TELEPORT so the test stays deterministic (no
        // dependency on rolling a 6). The launch branch in godTeleport
        // routes through playYardLaunch, identical to updateTokenContainer.
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 0,
            });
        });

        // During the overlay the slot must be hidden — otherwise the
        // dot-ring shows underneath the hidden token (the bug).
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('h-0-0').style.visibility)
        ).toBe('hidden');

        // After the overlay resolves the inline visibility is restored
        // (token has moved to its entry cell; the now-empty slot can
        // legitimately show its dot again).
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('h-0-0').style.visibility),
            { timeout: 5000 }
        ).toBe('');

        // And the token actually landed where it was supposed to.
        const parentId = await page.evaluate(
            () => document.getElementById('p-0-0').parentElement.id
        );
        expect(parentId).toBe('m0');
    });
});
