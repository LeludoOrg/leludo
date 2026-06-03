import { test, expect } from '@playwright/test';

/**
 * End-to-end online gameplay against the real wc-board. A host creates a
 * private room, drops a bot into the second seat, and starts. The lobby hands
 * off to the actual board, which is driven entirely by server broadcasts: the
 * human's dice/token taps become intents, the server decides every roll/move,
 * and the local engine replays them to animate the board.
 *
 * This guards the "stuck on Game starting…" regression — once started, the
 * board must mount and the turn must actually progress.
 */

async function openOnline(page, name) {
    await page.goto('/');
    await page.getByTestId('home-play-online').click();
    await page.getByTestId('online-name').fill(name);
}

test.describe('Online gameplay', () => {
    test('host + bot game mounts the real board and the turn progresses', async ({ page }) => {
        await openOnline(page, 'Hosty');
        await page.getByTestId('online-create').click();
        // Add a bot to seat 1 and start.
        await page.getByTestId('online-seat-1-bot').click();
        await expect(page.getByTestId('online-seat-1')).toContainText('Bot');
        await page.getByTestId('online-start').click();

        // The lobby hands off to the real board.
        await expect(page.locator('wc-board .board-grid')).toBeVisible();
        await expect(page.locator('wc-token')).toHaveCount(8); // 2 players × 4 tokens
        await expect(page.locator('#main-menu')).toBeHidden();

        // Drive play: on the human's turn, roll and move; the bot is server-driven.
        // Poll until the turn counter advances past 0 — proof the full
        // roll → render → advance loop works online (not stuck on "starting").
        const dice = page.locator('wc-dice');
        await expect.poll(async () => {
            // Click the dice (a no-op via the intercept unless it's our turn),
            // then any activated token (likewise gated server-side).
            await dice.click({ force: true }).catch(() => {});
            const token = page.locator('wc-token .animate-bounce').first();
            if (await token.count()) await token.click({ force: true }).catch(() => {});
            return (await page.locator('#turn-counter').textContent())?.trim() || 'Turn 0';
        }, { timeout: 20_000, intervals: [400, 400, 400] }).not.toBe('Turn 0');
    });
});
