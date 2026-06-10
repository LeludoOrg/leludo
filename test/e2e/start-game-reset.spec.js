import { test, expect } from '@playwright/test';
import { startGame as bootGame } from './helpers.js';

/**
 * Regression for "brand new game starts in a broken state".
 *
 * Bug: startGame() trusted that whoever brought the user back to the
 * setup screen had already cleaned the board. On Android we hit a path
 * (warm WebView resume + tap "Start a new game") where the previous
 * game's wc-token elements and a re-parented wc-dice were still live in
 * the DOM. The new game then layered fresh tokens on top, leaving an
 * extra pawn on the track for one color and an empty active-corner
 * dice slot. Turn counter also kept the stale "Turn 208" text because
 * resetTurnCount only zeroed the JS module var, not the DOM.
 *
 * Fix: startGame() now runs a defensive DOM reset (remove wc-token,
 * clear token cache, restore wc-dice into dice-home, reset
 * #turn-counter text) before laying down the new game.
 */

test.describe('Start game DOM reset', () => {
    test('startGame clears stale tokens, re-homes the dice, resets turn counter', async ({ page }) => {
        await bootGame(page);
        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();
        await page.locator('#h-0-0').waitFor();

        // Reproduce the broken pre-state: a stale wc-token sitting on
        // the track, the dice yanked out of dice-home into <body>, and
        // a leftover turn-counter text from a "previous" long game.
        await page.evaluate(() => {
            const stray = document.createElement('wc-token');
            stray.id = 'p-1-99';
            document.getElementById('m11').appendChild(stray);

            const dice = document.getElementById('wc-dice');
            document.body.appendChild(dice);

            document.getElementById('turn-counter').textContent = 'Turn 208';
        });

        // Sanity-check the stale state actually took.
        expect(await page.locator('#p-1-99').count()).toBe(1);

        // Now start a brand new game without going through restartGame
        // or exitToHome — the path that used to skip cleanup.
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.START_GAME,
                quickStartId: 'qs,1,3,0',
                namesByPlayerIndex: ['Me', 'B1', 'B2', 'B3'],
            });
        });

        // 16 tokens total, exactly 4 per color, all in their yards.
        await expect(page.locator('wc-token')).toHaveCount(16);
        expect(await page.locator('#p-1-99').count()).toBe(0);
        for (let pi = 0; pi < 4; pi++) {
            const yard = page.locator(`.home-quad--${['tl', 'tr', 'br', 'bl'][pi]} wc-token`);
            await expect(yard).toHaveCount(4);
        }

        // Dice is back in an active corner-dice container, not orphaned
        // on <body>.
        const diceParentClass = await page.evaluate(() => {
            const d = document.getElementById('wc-dice');
            return d?.parentElement?.className || '';
        });
        expect(diceParentClass).toContain('corner-dice--active');

        // Turn counter reset to its fresh-game text.
        await expect(page.locator('#turn-counter')).toHaveText('Turn 0');
    });
});
