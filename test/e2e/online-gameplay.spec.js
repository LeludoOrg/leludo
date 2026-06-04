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

        // Perspective mirrors offline play (HUMAN_PREFERRED_POSITIONS): this
        // client (server seat 0) renders at board position 2 (bottom-right), the
        // second player (seat 1) diagonally opposite at position 0 (top-left).
        // The other corners stay empty in a 2-player game.
        await expect(page.locator('#p-2-0')).toBeVisible(); // me, bottom-right
        await expect(page.locator('#p-0-0')).toBeVisible(); // bot, top-left
        await expect(page.locator('#p-1-0')).toHaveCount(0);
        await expect(page.locator('#p-3-0')).toHaveCount(0);
        // …in my own colour: board position 2 uses seat 0's base colour.
        const sameColour = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            return cs.getPropertyValue('--player-2').trim() === cs.getPropertyValue('--base-color-0').trim();
        });
        expect(sameColour).toBe(true);

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

    // Smoke: a 4-player game (1 human + 3 bots) mounts with all four corners
    // filled, the human still sits bottom-right, and the turn keeps flowing
    // (no stall). The deeper correctness guard — that each server seat's move
    // lands on the right board position under the diagonal layout — lives in the
    // pure unit tests (test/scripts/online-state.test.js + game-reducer), which
    // fail deterministically without the seat→board mapping + NET_TURN_SYNCED.
    test('4-player game mounts all corners and the turn keeps flowing', async ({ page }) => {
        await openOnline(page, 'Quad');
        await page.getByTestId('online-create').click();

        // Grow the room to 4 and fill the three open seats with bots.
        await page.getByTestId('online-lobby-size-4').click();
        for (const i of [1, 2, 3]) {
            await page.getByTestId(`online-seat-${i}-bot`).click();
            await expect(page.getByTestId(`online-seat-${i}`)).toContainText('Bot');
        }
        await page.getByTestId('online-start').click();

        await expect(page.locator('wc-board .board-grid')).toBeVisible();
        await expect(page.locator('wc-token')).toHaveCount(16); // 4 players × 4

        // All four corners are filled; this client still sits bottom-right (2).
        await expect(page.locator('#p-2-0')).toBeVisible(); // me
        await expect(page.locator('#p-0-0')).toBeVisible();
        await expect(page.locator('#p-1-0')).toBeVisible();
        await expect(page.locator('#p-3-0')).toBeVisible();

        // The turn must cycle well past the first handoff — proof the server-side
        // turn sync keeps the diverging local round-robin aligned, not stuck.
        const dice = page.locator('wc-dice');
        await expect.poll(async () => {
            await dice.click({ force: true }).catch(() => {});
            const token = page.locator('wc-token .animate-bounce').first();
            if (await token.count()) await token.click({ force: true }).catch(() => {});
            const txt = (await page.locator('#turn-counter').textContent())?.trim() || 'Turn 0';
            return parseInt(txt.replace(/\D/g, ''), 10) || 0;
        }, { timeout: 30_000, intervals: [400, 400, 400] }).toBeGreaterThan(4);
    });
});
