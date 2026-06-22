import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

/**
 * End-to-end online gameplay against the real wc-board. Online needs two real
 * players (a lone host can't start a solo-vs-bots match — that's offline play),
 * so a host creates a private room, a guest joins by code, the host starts, and
 * the remaining seats fill with bots. The lobby hands off to the actual board,
 * which is driven entirely by server broadcasts: each human's dice/token taps
 * become intents, the server decides every roll/move, and the local engine
 * replays them to animate the board.
 *
 * This guards the "stuck on Game starting…" regression — once started, the
 * board must mount and the turn must actually progress.
 */

// Boot a started 2-human private room (host + guest) and return both pages and
// their contexts. The two humans seat diagonally (host seat 0 → board pos 2,
// guest seat 2 → board pos 0); the other two seats bot-fill on start, so it's a
// full four-handed table. `query` forwards a leading-'?' override (e.g. grace).
async function startTwoHumanGame(browser, { hostName = 'Hosty', guestName = 'Guesty', query = '' } = {}) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const host = await ctxA.newPage();
    const guest = await ctxB.newPage();

    await openOnline(host, hostName, query);
    await host.getByTestId('online-create').click();
    const code = (await host.getByTestId('online-room-code').textContent())?.trim();
    expect(code).toBeTruthy();

    await openOnline(guest, guestName, query);
    await guest.getByTestId('online-code-input').fill(code);
    await guest.getByTestId('online-join').click();
    // The host can only start once the second human is actually seated.
    await expect(host.getByTestId('online-seat-2')).toContainText(guestName);

    await host.getByTestId('online-start').click();
    await expect(host.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    await expect(guest.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
    return { ctxA, ctxB, host, guest, code };
}

// Click a page's dice, then any activated token. Both are no-ops (force-clicked)
// unless it's that client's turn and the server has handed it a legal move.
async function drive(page) {
    await page.locator('wc-dice').click({ force: true }).catch(() => {});
    const token = page.locator('wc-token .animate-bounce').first();
    if (await token.count()) await token.click({ force: true }).catch(() => {});
}

test.describe('Online gameplay', () => {
    test('a host + guest game mounts the real board and the turn progresses', async ({ browser }) => {
        const { ctxA, ctxB, host, guest } = await startTwoHumanGame(browser, { hostName: 'Hosty' });

        // The lobby hands off to the real board.
        await expect(host.locator('wc-board .board-grid')).toBeVisible();
        await expect(host.locator('wc-token')).toHaveCount(16); // 4 players × 4 tokens
        await expect(host.locator('#main-menu')).toBeHidden();

        // Perspective mirrors offline play (HUMAN_PREFERRED_POSITIONS): this
        // client (server seat 0) renders at board position 2 (bottom-right). All
        // four corners are filled (2 humans + 2 bots).
        await expect(host.locator('#p-2-0')).toBeVisible(); // me, bottom-right
        await expect(host.locator('#p-0-0')).toBeVisible();
        await expect(host.locator('#p-1-0')).toBeVisible();
        await expect(host.locator('#p-3-0')).toBeVisible();
        // …in my own colour: board position 2 uses seat 0's base colour.
        const sameColour = await host.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            return cs.getPropertyValue('--player-2').trim() === cs.getPropertyValue('--base-color-0').trim();
        });
        expect(sameColour).toBe(true);

        // Drive play on both humans; bots are server-driven. Poll until the turn
        // counter advances past 0 — proof the full roll → render → advance loop
        // works online (not stuck on "starting").
        await expect.poll(async () => {
            await drive(host);
            await drive(guest);
            return (await host.locator('#turn-counter').textContent())?.trim() || 'Turn 0';
        }, { timeout: 20_000, intervals: [400, 400, 400] }).not.toBe('Turn 0');

        await ctxA.close();
        await ctxB.close();
    });

    // Smoke: a four-handed game (2 humans + 2 bots) mounts with all four corners
    // filled, the host still sits bottom-right, and the turn keeps flowing past
    // several hand-offs (no stall). The deeper correctness guard — that each
    // server seat's move lands on the right board position under the diagonal
    // layout — lives in the pure unit tests (test/scripts/online-state.test.js +
    // game-reducer), which fail deterministically without the seat→board mapping
    // + NET_TURN_SYNCED.
    test('4-player game mounts all corners and the turn keeps flowing', async ({ browser }) => {
        const { ctxA, ctxB, host, guest } = await startTwoHumanGame(browser, { hostName: 'Quad', guestName: 'Quad2' });

        await expect(host.locator('wc-board .board-grid')).toBeVisible();
        await expect(host.locator('wc-token')).toHaveCount(16); // 4 players × 4

        // All four corners are filled; this client still sits bottom-right (2).
        await expect(host.locator('#p-2-0')).toBeVisible(); // me
        await expect(host.locator('#p-0-0')).toBeVisible();
        await expect(host.locator('#p-1-0')).toBeVisible();
        await expect(host.locator('#p-3-0')).toBeVisible();

        // The turn must cycle well past the first hand-off — proof the server-side
        // turn sync keeps the diverging local round-robins aligned, not stuck.
        // Both humans must play or the rotation would hold on whoever idles.
        await expect.poll(async () => {
            await drive(host);
            await drive(guest);
            const txt = (await host.locator('#turn-counter').textContent())?.trim() || 'Turn 0';
            return parseInt(txt.replace(/\D/g, ''), 10) || 0;
        }, { timeout: 30_000, intervals: [400, 400, 400] }).toBeGreaterThan(4);

        await ctxA.close();
        await ctxB.close();
    });

    // Regression: opening settings (or any pause surface) during an online game
    // used to freeze the REPLAY, not the game — the server kept playing while
    // the isGameLogicPaused() guards silently dropped every NET_APPLY_ROLL /
    // NET_APPLY_MOVE frame. The player closed settings onto a stale board that
    // stayed visibly wrong for a turn or more. Server frames are authoritative
    // and must keep applying while paused; pause only blocks LOCAL input.
    test('server frames keep applying while the game is paused (settings open)', async ({ browser }) => {
        const errors = [];
        const { ctxA, ctxB, host, guest } = await startTwoHumanGame(browser, { hostName: 'Pauser', guestName: 'Mate' });
        host.on('pageerror', e => errors.push(String(e)));
        await expect(host.locator('wc-board .board-grid')).toBeVisible();

        const turnCount = () => host.evaluate(async () =>
            (await import('/scripts/index.js')).state.turnCount);
        const hostTurn = () => host.evaluate(async () =>
            (await import('/scripts/index.js')).state.currentPlayerIndex);

        // Get the game flowing, driving both humans.
        await expect.poll(async () => {
            await drive(host);
            await drive(guest);
            return await turnCount();
        }, { timeout: 20_000, intervals: [400, 400, 400] }).toBeGreaterThan(0);

        // Pause exactly like the settings overlay does (wc-settings.openSettings →
        // pauseGameLogic). Pause the host the moment its OWN turn ends (self always
        // renders at board pos 2): that opens a full non-host stretch (bot, guest,
        // bot) ahead before the rotation circles back and HOLDS on the paused host,
        // so the server keeps producing turns the paused client must apply.
        await expect.poll(async () => { await drive(host); await drive(guest); return await hostTurn(); },
            { timeout: 20_000, intervals: [300, 300, 300] }).toBe(2);     // it's our turn
        await drive(host);                                                 // resolve it
        // Drive the guest here too so the rotation doesn't stall on it before we pause.
        await expect.poll(async () => { await drive(guest); return await hostTurn(); },
            { timeout: 20_000, intervals: [300, 300, 300] }).not.toBe(2);  // …now it's not
        await host.evaluate(async () => (await import('/scripts/index.js')).pauseGameLogic());

        // THE assertion: while the host is paused, the guest + bots keep the server
        // advancing, and those broadcasts must keep applying on the paused client —
        // the turn counter climbs. Under the old replay-through-guards pipeline it
        // froze (frames silently dropped), leaving the board visibly wrong. Drive
        // the guest so the rotation doesn't stall on the second human.
        const before = await turnCount();
        await expect.poll(async () => { await drive(guest); return await turnCount(); },
            { timeout: 20_000, intervals: [300, 300, 300] }).toBeGreaterThan(before + 1);

        // Unpause (settings closed): the game continues without a hiccup.
        await host.evaluate(async () => {
            const m = await import('/scripts/index.js');
            m.dispatch({ type: m.COMMANDS.RESUME });
        });
        const afterResume = await turnCount();
        await expect.poll(async () => {
            await drive(host);
            await drive(guest);
            return await turnCount();
        }, { timeout: 20_000, intervals: [400, 400, 400] }).toBeGreaterThan(afterResume);

        expect(errors, `Page errors:\n${errors.join('\n')}`).toEqual([]);
        await ctxA.close();
        await ctxB.close();
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
