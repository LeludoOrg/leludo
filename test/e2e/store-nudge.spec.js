import { test, expect } from '@playwright/test';

/**
 * Regression for the end-of-game Play Store nudge.
 *
 * The recap (wc-game-end) gained an Android-only "Get the app / Rate us"
 * row that routes to the Play Store. It must:
 *   - appear on an Android browser, worded to drive installs;
 *   - NOT appear on desktop / iOS, which have no Play Store target.
 *
 * The nudge is gated purely on platform (shouldShowStoreNudge), so these
 * mount the recap component directly after a game start.
 */

async function mountRecap(page) {
    await page.goto('/');
    await page.evaluate(async () => {
        const mod = await import('/scripts/index.js');
        mod.dispatch({
            type: mod.COMMANDS.START_GAME,
            quickStartId: 'qs,1,3,0',
            namesByPlayerIndex: ['You', 'B1', 'B2', 'B3'],
        });
        const el = document.createElement('wc-game-end');
        document.body.appendChild(el);
    });
}

test.describe('Game-end Play Store nudge — Android', () => {
    test.use({ userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile' });

    test('shows the install nudge on an Android browser', async ({ page }) => {
        await mountRecap(page);
        const store = page.locator('wc-game-end #ge-store');
        await expect(store).toBeVisible();
        // Browser (not native) → install wording, web flag.
        await expect(store).toHaveAttribute('data-native', '0');
        await expect(store.locator('.ge-store-action')).toHaveText('Get the app');
    });
});

test.describe('Game-end Play Store nudge — desktop', () => {
    // Default Playwright Chromium UA is desktop → no Play Store target.
    test('hides the nudge on desktop', async ({ page }) => {
        await mountRecap(page);
        await expect(page.locator('wc-game-end #ge-store')).toHaveCount(0);
    });
});
