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
 *
 * Second bug, second assertion: the landing "GO!" chip had
 * `background: currentColor` AND `color: #1a1410` on the same rule,
 * so `currentColor` on the chip resolved to its OWN dark color, not
 * the player color flowing down from `.plnch-label`. The chip
 * rendered as a dark "rounded square" at the entry cell. Fix uses a
 * custom property `--plnch-chip-bg` set on the parent so the player
 * color reaches the chip background.
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

    test('landing GO! chip uses player color for the pill, not the dark text color', async ({ page }) => {
        // Drive a real playPawnLaunch so the module's CSS gets injected
        // and the chip is constructed by playLandingFX. We sample the
        // chip ~85% through the run — past the landing phase, before
        // the overlay DOM is cleaned up. Pre-fix the chip rendered as a
        // dark pill (bg #1a1410) because `background: currentColor`
        // resolved against the chip's own `color: #1a1410`.
        await page.goto('/');
        const colors = await page.evaluate(async () => {
            const mod = await import('/scripts/pawn-launch.js');
            const root = document.createElement('div');
            root.style.cssText = 'position: fixed; inset: 0;';
            document.body.appendChild(root);
            const PLAYER = '#cf4a3a';
            const DURATION = 1000;
            const p = mod.playPawnLaunch({
                container: root,
                yard: { x: 100, y: 100 },
                entry: { x: 200, y: 200 },
                color: PLAYER,
                pawnSize: 48,
                duration: DURATION,
            });
            // Sample at 85% — chip is already mounted and animating.
            await new Promise(r => setTimeout(r, Math.round(DURATION * 0.85)));
            const chip = root.querySelector('.plnch-label-chip');
            const cs = chip ? getComputedStyle(chip) : null;
            const out = chip ? { bg: cs.backgroundColor, color: cs.color } : { bg: null, color: null };
            await p;
            root.remove();
            return out;
        });

        // Player color = #cf4a3a → rgb(207, 74, 58).
        expect(colors.bg).toBe('rgb(207, 74, 58)');
        // Text stays dark for readability.
        expect(colors.color).toBe('rgb(26, 20, 16)');
    });
});
