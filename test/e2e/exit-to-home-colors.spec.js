import { test, expect } from '@playwright/test';

/**
 * Regression for "setup screen shows previous game's rotated palette
 * after exit-to-home".
 *
 * Bug: applyColorMap() mutates --player-N CSS variables on :root.
 * During a game with mixed humans/bots the map is a permutation
 * (e.g. one human → human sits at position 2, so --player-0 maps to
 * base-color-1 = green). exitToHome() never reset those vars, so the
 * next render of the setup screen showed seat 0 as green instead of
 * the default red. The player would then pick "red" only to launch
 * into another game with the same rotated palette.
 *
 * Fix: exitToHome() now applies the identity color map [0,1,2,3]
 * before showing the home screen, restoring the default palette.
 */

test.describe('Exit to home color reset', () => {
    test('resets --player-N vars to defaults so setup shows default palette', async ({ page }) => {
        await page.goto('/');

        const baseColor0 = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--base-color-0').trim()
        );

        // Start a 1-human + 3-bot game. HUMAN_PREFERRED_POSITIONS[0] = 2,
        // so the human lands at position 2 and the color map becomes
        // [1,2,0,3] — i.e. --player-0 = base-color-1 (green), not red.
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.START_GAME,
                quickStartId: 'qs,1,3,0',
                namesByPlayerIndex: ['P', 'B1', 'B2', 'B3'],
            });
        });

        const duringGame = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--player-0').trim()
        );
        expect(duringGame).not.toBe(baseColor0);

        // Exit to home — the path the user took before reporting the
        // bug.
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({ type: mod.COMMANDS.EXIT_TO_HOME });
        });

        const afterExit = await page.evaluate(() =>
            getComputedStyle(document.documentElement).getPropertyValue('--player-0').trim()
        );
        // The bug would have left --player-0 set to base-color-1.
        // The fix restores it to base-color-0.
        expect(afterExit).toBe(baseColor0);
    });
});
