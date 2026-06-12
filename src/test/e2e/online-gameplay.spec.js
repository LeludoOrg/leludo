import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

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

    // Regression: opening settings (or any pause surface) during an online game
    // used to freeze the REPLAY, not the game — the server kept playing while
    // the isGameLogicPaused() guards silently dropped every NET_APPLY_ROLL /
    // NET_APPLY_MOVE frame. The player closed settings onto a stale board that
    // stayed visibly wrong for a turn or more. Server frames are authoritative
    // and must keep applying while paused; pause only blocks LOCAL input.
    test('server frames keep applying while the game is paused (settings open)', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));

        await openOnline(page, 'Pauser');
        await page.getByTestId('online-create').click();
        // All-bot opponents so the server generates turns continuously without
        // any input from this client.
        for (const i of [1, 2, 3]) await page.getByTestId(`online-seat-${i}-bot`).click();
        await page.getByTestId('online-start').click();
        await expect(page.locator('wc-board .board-grid')).toBeVisible();

        // Wait for the game to flow past the host's first turn so the bots own
        // the table (the host idling doesn't stall a bot-only rotation — their
        // turns advance regardless of our input… except on our own turn).
        const turnCount = () => page.evaluate(async () =>
            (await import('/scripts/index.js')).state.turnCount);
        const dice = page.locator('wc-dice');
        await expect.poll(async () => {
            await dice.click({ force: true }).catch(() => {});
            const token = page.locator('wc-token .animate-bounce').first();
            if (await token.count()) await token.click({ force: true }).catch(() => {});
            return await turnCount();
        }, { timeout: 20_000, intervals: [400, 400, 400] }).toBeGreaterThan(0);

        // Pause exactly like the settings overlay does (wc-settings.openSettings
        // → pauseGameLogic). If it lands on our own turn the bots are still
        // queued behind us only until the server's pending frame drains, so move
        // past our turn first by polling until it's NOT our seat's turn.
        await expect.poll(() => page.evaluate(async () => {
            const m = await import('/scripts/index.js');
            return m.state.currentPlayerIndex;
        }), { timeout: 20_000 }).not.toBe(2); // self always renders at board pos 2
        await page.evaluate(async () => {
            const m = await import('/scripts/index.js');
            m.pauseGameLogic();
        });

        // THE assertion: while paused, server broadcasts must keep applying —
        // the turn counter advances. Under the old replay-through-guards
        // pipeline this froze (frames silently dropped) and only the positions
        // snapped later, leaving the visible board wrong for a turn or more.
        const before = await turnCount();
        await expect.poll(turnCount, { timeout: 20_000 }).toBeGreaterThan(before + 1);

        // Unpause (settings closed): the game continues without a hiccup.
        await page.evaluate(async () => {
            const m = await import('/scripts/index.js');
            m.dispatch({ type: m.COMMANDS.RESUME });
        });
        const afterResume = await turnCount();
        await expect.poll(async () => {
            await dice.click({ force: true }).catch(() => {});
            const token = page.locator('wc-token .animate-bounce').first();
            if (await token.count()) await token.click({ force: true }).catch(() => {});
            return await turnCount();
        }, { timeout: 20_000, intervals: [400, 400, 400] }).toBeGreaterThan(afterResume);

        expect(errors, `Page errors:\n${errors.join('\n')}`).toEqual([]);
    });

    // Disconnect semantics: a leaver is DIMMED and the game flows only until the
    // rotation reaches their seat, then HOLDS — their turn is never skipped, and
    // everyone sees the "waiting for X" banner with the forfeit countdown. Once
    // the (test-shortened) grace window elapses they forfeit and, with one human
    // left, the game ends.
    test('a leaver dims, the game holds on their turn, then forfeits and ends', async ({ browser }) => {
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

        // Drive Alice's turns until the rotation lands on Bob — board position 0
        // from Alice's view (self seat 0 → board 2, Bob seat 2 → board 0) — then
        // have Bob vanish ON his turn, the moment the new hold semantics bite.
        const aliceDice = pageA.locator('wc-dice');
        await expect.poll(async () => {
            await aliceDice.click({ force: true }).catch(() => {});
            const token = pageA.locator('wc-token .animate-bounce').first();
            if (await token.count()) await token.click({ force: true }).catch(() => {});
            return pageA.evaluate(async () =>
                (await import('/scripts/index.js')).state.currentPlayerIndex);
        }, { timeout: 20_000, intervals: [300, 300, 300] }).toBe(0);

        // The guest abandons the game mid-turn.
        await ctxB.close();

        // The leaver is dimmed, the board stays live, and there's no
        // self-reconnect banner (this client didn't drop). In a 4-seat ring from
        // Alice's view (self seat 0 → board 2), Bob (seat 2) maps to board
        // position 0 = (2 + (2 - 0)) % 4.
        await expect(pageA.locator('#b0')).toHaveClass(/net-dimmed/);
        await expect(pageA.locator('wc-board .board-grid')).toBeVisible();
        await expect(pageA.getByTestId('net-reconnect-banner')).toBeHidden();

        // Once the rotation reaches Bob's seat the game HOLDS (no skip): the
        // waiting banner names him until the grace window forfeits the seat.
        await expect(pageA.getByTestId('net-waiting-banner')).toBeVisible({ timeout: 10_000 });
        await expect(pageA.getByTestId('net-waiting-banner')).toContainText('Bob');

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
