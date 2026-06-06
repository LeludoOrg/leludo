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

async function openOnline(page, name, query = '') {
    await page.goto(`/${query}`);
    await page.getByTestId('home-play-online').click();
    await page.getByTestId('online-name').fill(name);
}

test.describe('Online gameplay', () => {
    test('host + bot game mounts the real board and the turn progresses', async ({ page }) => {
        await openOnline(page, 'Hosty');
        await page.getByTestId('online-create').click();
        // Add a bot to seat 1 and start. Seats 2 & 3 stay open and fill with bots
        // on start, so every online room is a full four-handed table.
        await page.getByTestId('online-seat-1-bot').click();
        await expect(page.getByTestId('online-seat-1')).toContainText('Bot');
        await page.getByTestId('online-start').click();

        // The lobby hands off to the real board.
        await expect(page.locator('wc-board .board-grid')).toBeVisible();
        await expect(page.locator('wc-token')).toHaveCount(16); // 4 players × 4 tokens
        await expect(page.locator('#main-menu')).toBeHidden();

        // Perspective mirrors offline play (HUMAN_PREFERRED_POSITIONS): this
        // client (server seat 0) renders at board position 2 (bottom-right). All
        // four corners are filled.
        await expect(page.locator('#p-2-0')).toBeVisible(); // me, bottom-right
        await expect(page.locator('#p-0-0')).toBeVisible();
        await expect(page.locator('#p-1-0')).toBeVisible();
        await expect(page.locator('#p-3-0')).toBeVisible();
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

        // Room is four seats by default — fill the three open seats with bots.
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

    // Regression: when a human leaves mid-game their seat wasn't being handled —
    // the game stalled. Now the leaver is just DIMMED (no blocking overlay) and
    // the game plays on; once the (test-shortened) grace window elapses they
    // forfeit and, with one human left, the game ends.
    test('a leaver is dimmed while the game continues, then forfeits and ends', async ({ browser }) => {
        const grace = '?grace=6000'; // 6s reconnect window — long enough to observe the dim
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        // Host creates the room; grab the shared code.
        await openOnline(pageA, 'Alice', grace);
        await pageA.getByTestId('online-create').click();
        const code = (await pageA.getByTestId('online-room-code').textContent())?.trim();
        expect(code).toBeTruthy();

        // Guest joins by code; host waits until the guest is seated, then starts.
        await openOnline(pageB, 'Bob', grace);
        await pageB.getByTestId('online-code-input').fill(code);
        await pageB.getByTestId('online-join').click();
        // Two humans seat diagonally opposite: host at seat 0, Bob at seat 2.
        await expect(pageA.getByTestId('online-seat-2')).toContainText('Bob');
        await pageA.getByTestId('online-start').click();

        // Both boards mount. Alice + Bob are humans; seats 2 & 3 fill with bots,
        // so it's a full four-handed table (4 players × 4 tokens).
        await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
        await expect(pageB.locator('wc-board .board-grid')).toBeVisible();
        await expect(pageA.locator('wc-token')).toHaveCount(16);

        // The guest abandons the game.
        await ctxB.close();

        // No blocking overlay — the leaver is dimmed, the board stays live, and
        // there's no self-reconnect banner (this client didn't drop). In a 4-seat
        // ring from Alice's view (self seat 0 → board 2), Bob (seat 2) maps to
        // board position 0 = (2 + (2 - 0)) % 4.
        await expect(pageA.locator('#b0')).toHaveClass(/net-dimmed/);
        await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
        await expect(pageA.getByTestId('net-reconnect-banner')).toBeHidden();

        // Grace elapses → forfeit → only one human left (bots don't count) → the
        // game ends. The recap screen mounts (.ge-screen is the full-bleed overlay).
        await expect(pageA.locator('wc-game-end .ge-screen')).toBeVisible({ timeout: 12_000 });

        // Regression: online has no local lineup to replay (server-driven), so
        // the recap CTA must offer a NEW game — not the offline "Play again"
        // local restart, which is a no-op online and left the player stranded on
        // the recap. The button reads "New game" and routes to the online
        // create/join screen so a fresh room can be spun up.
        const newGame = pageA.locator('#ge-play-again');
        await expect(newGame).toHaveText('New game');
        await newGame.click();
        await expect(pageA.locator('wc-play-online')).toHaveCount(1);   // online create/join screen
        await expect(pageA.getByTestId('online-create')).toBeVisible(); // can create a new room
        await expect(pageA.locator('wc-game-end .ge-screen')).toHaveCount(0); // recap dismissed

        await ctxA.close();
    });
});
