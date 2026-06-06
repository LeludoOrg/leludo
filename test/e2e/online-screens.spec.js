import { test, expect } from '@playwright/test';

/**
 * Home now offers two clear, separate paths — offline (pass-and-play on this
 * device) and online (server-backed multiplayer). These guard that split, the
 * online lobby flow (host-managed private rooms + public matchmaking), and the
 * remembered username.
 *
 * The online lobby talks to the real Node ws server that Playwright starts
 * (server/local-server.mjs on 8890), so "both clients meet in one room" is an
 * end-to-end check, not a mock.
 */

/** Open the online menu and enter a display name (required to play online). */
async function openOnline(page, name) {
    await page.goto('/');
    await page.getByTestId('home-play-online').click();
    await page.getByTestId('online-name').fill(name);
}

test.describe('Home — offline / online split', () => {
    test('home shows both paths', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('home-play-offline')).toBeVisible();
        await expect(page.getByTestId('home-play-online')).toBeVisible();
    });

    test('offline path opens the local "who is playing" setup', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-offline').click();
        await expect(page.locator('.seat-list')).toBeVisible();
        await expect(page.locator('.seat-row')).toHaveCount(4);
    });

    // Initial release ships private rooms only — the "Find a public match" entry
    // is hidden behind PUBLIC_MATCH_ENABLED in wc-quick-start.js. The online menu
    // is the offline-style seat setup: your seat (name) + a fixed four seats +
    // create, plus join-by-code. It must NOT show the public entry.
    test('online path offers the private-room seat setup only', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-public')).toHaveCount(0);      // public hidden for launch
        await expect(page.getByTestId('online-setup-seat-0')).toBeVisible();  // your seat (name)
        await expect(page.getByTestId('online-name')).toBeVisible();
        await expect(page.getByTestId('online-create')).toBeVisible();        // create room
        await expect(page.getByTestId('online-join')).toBeVisible();          // join by code
    });

    test('back from the online menu returns home', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-create')).toBeVisible();
        await page.goBack();
        await expect(page.getByTestId('home-play-offline')).toBeVisible();
    });

    // The room always shows four fixed seats (you + three) — no add row, no
    // remove cross. Each of the three other seats just toggles Open / Bot.
    test('the room shows four fixed seats with an Open/Bot toggle and no add/remove', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();

        // All four seats present; default all Open.
        for (const i of [0, 1, 2, 3]) {
            await expect(page.getByTestId(`online-setup-seat-${i}`)).toBeVisible();
        }
        await expect(page.getByTestId('online-setup-seat-1-open')).toHaveClass(/seat-half/);
        await expect(page.getByTestId('online-setup-seat-1-open')).not.toHaveClass(/seat-half--inactive/);

        // No add row and no per-seat remove cross.
        await expect(page.getByTestId('online-setup-add')).toHaveCount(0);
        await expect(page.getByTestId('online-setup-seat-3-remove')).toHaveCount(0);

        // Toggle seat 2 to Bot.
        await page.getByTestId('online-setup-seat-2-bot').click();
        await expect(page.getByTestId('online-setup-seat-2-bot')).not.toHaveClass(/seat-half--inactive/);
        await expect(page.getByTestId('online-setup-seat-2-open')).toHaveClass(/seat-half--inactive/);
    });

    // A seat toggled to Bot on the setup screen turns into a bot the moment the
    // room is created — guards the _pendingBotSeats → setSeat(i,'BOT') handoff.
    test('a seat set to Bot on the setup screen is a bot in the created room', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await page.getByTestId('online-name').fill('Hosty');
        await page.getByTestId('online-setup-seat-1-bot').click(); // seat 1 → Bot
        await page.getByTestId('online-create').click();

        await expect(page.getByTestId('online-room-code')).toBeVisible();
        await expect(page.getByTestId('online-seat-1')).toContainText('Bot');
        await expect(page.getByTestId('online-started')).toHaveText('false'); // host still presses Start
    });

    // The lobby is no longer a separate "Game room" screen. Creating a room flips
    // the SAME "Play online" screen into room mode in place: the room-code banner
    // appears, the join-by-code row goes away, and "Create room" is replaced by
    // Start + Leave. Guards against reintroducing a standalone lobby screen.
    test('creating a room flips the play-online screen into room mode in place', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await page.getByTestId('online-name').fill('Hosty');

        // Setup mode: join-by-code present, no room code yet, Create shown.
        await expect(page.getByTestId('online-join')).toBeVisible();
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);

        await page.getByTestId('online-create').click();

        // Room mode on the same screen: code in, join + create out, Start/Leave in.
        await expect(page.getByTestId('online-room-code')).toBeVisible();
        await expect(page.getByTestId('online-create')).toBeHidden();
        await expect(page.getByTestId('online-join')).toBeHidden();
        await expect(page.getByTestId('online-leave')).toBeVisible();
        await expect(page.getByTestId('online-start')).toBeVisible(); // host sees Start

        // Back from the room returns to setup mode (not all the way home).
        await page.goBack();
        await expect(page.getByTestId('online-create')).toBeVisible();
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);
    });
});

test.describe('Online — username', () => {
    test('requires a name before going online', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-name')).toHaveValue(''); // fresh device
        await page.getByTestId('online-create').click();
        // Blocked: no room is created, a prompt is shown.
        await expect(page.getByTestId('online-status')).toContainText(/name/i);
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);
    });

    test('remembers the name for next time', async ({ page }) => {
        await openOnline(page, 'Zelda');
        await page.goBack(); // back home
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-name')).toHaveValue('Zelda');
    });
});

test.describe('Online lobby — create + join', () => {
    test('two devices meet in one room via a shared code and the room starts', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        // Host creates a private 2-player room.
        await openOnline(host, 'Hosty');
        await host.getByTestId('online-create').click();

        const code = (await host.getByTestId('online-room-code').textContent())?.trim();
        expect(code).toMatch(/^[A-Z0-9]{4}$/);
        await expect(host.getByTestId('online-started')).toHaveText('false'); // waiting for the guest

        // Only the host sees the Start control.
        await expect(host.getByTestId('online-is-host')).toHaveText('true');
        await expect(host.getByTestId('online-start')).toBeVisible();

        // Guest joins by the shared code.
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();

        // The guest is seated but is NOT the host and waits for the host to start.
        await expect(guest.getByTestId('online-is-host')).toHaveText('false');
        await expect(guest.getByTestId('online-start')).toBeHidden();
        await expect(host.getByTestId('online-seat-1')).toContainText('Ready');
        await expect(host.getByTestId('online-seat-1')).toContainText('Guesty'); // remembered name shows

        // Host starts the game; both transition together.
        await host.getByTestId('online-start').click();
        await expect(host.getByTestId('online-started')).toHaveText('true');
        await expect(guest.getByTestId('online-started')).toHaveText('true');

        // Each device renders itself at board position 2 (bottom-right), its own
        // perspective — both see #p-2-* tokens as theirs.
        await expect(host.locator('#p-2-0')).toBeVisible();
        await expect(guest.locator('#p-2-0')).toBeVisible();

        await ctxHost.close();
        await ctxGuest.close();
    });

    test('host can add a bot and kick a player', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        await openOnline(host, 'Hosty');
        await host.getByTestId('online-create').click();
        const code = (await host.getByTestId('online-room-code').textContent())?.trim();

        // Guest joins, host sees the Kick control on seat 1.
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();
        await expect(host.getByTestId('online-seat-1-kick')).toBeVisible();

        // Host kicks the guest → guest is bounced back to the online menu.
        await host.getByTestId('online-seat-1-kick').click();
        await expect(guest.getByTestId('online-create')).toBeVisible();
        await expect(guest.getByTestId('online-status')).toContainText(/removed/i);

        // Seat 1 reopens; host fills it with a bot and seat 1 reads "Bot".
        await expect(host.getByTestId('online-seat-1-bot')).toBeVisible();
        await host.getByTestId('online-seat-1-bot').click();
        await expect(host.getByTestId('online-seat-1')).toContainText('Bot');

        await ctxHost.close();
        await ctxGuest.close();
    });
});

// Public matchmaking is hidden for the initial release (PUBLIC_MATCH_ENABLED =
// false in components/wc-quick-start.js). The queue/auto-start backend stays
// wired and unit-tested (test/scripts/net-client + online-game); these UI flows
// are unreachable until the entry button returns, so the suite is skipped.
// NOTE: the old room-size segmented control (online-players-*) was replaced by
// the seat-setup add/remove rows — re-enabling public also needs a size source
// (e.g. reuse the seat count) and these tests updated. Un-skip with the flag.
test.describe.skip('Online — public matchmaking', () => {
    test('cancelling a public search returns to the online menu', async ({ page }) => {
        await openOnline(page, 'Solo');
        await page.getByTestId('online-public').click();
        await expect(page.getByTestId('online-search-cancel')).toBeVisible();
        await page.getByTestId('online-search-cancel').click();
        await expect(page.getByTestId('online-create')).toBeVisible();
    });

    test('two public seekers are matched into one server-run game', async ({ browser }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const a = await ctxA.newPage();
        const b = await ctxB.newPage();

        // Both pick "Find a public match" at the default size (2).
        await openOnline(a, 'Ann');
        await a.getByTestId('online-public').click();
        await expect(a.getByTestId('online-search-status')).toBeVisible();

        await openOnline(b, 'Bo');
        await b.getByTestId('online-public').click();

        // Match found → a brief "Match found!" announcement covers the
        // auto-starting board for a beat (instead of snapping straight to play)
        // and names the opponent. (Fails before the #match-starting overlay.)
        await expect(a.locator('#match-starting')).toBeVisible();
        await expect(a.getByText('Match found!')).toBeVisible();
        await expect(a.getByTestId('match-starting-status')).toHaveText(/Bo/);

        // The queue pairs them into one room (same server-assigned code) and the
        // public game auto-starts once seats are filled — no host action needed.
        await expect(a.getByTestId('online-started')).toHaveText('true');
        await expect(b.getByTestId('online-started')).toHaveText('true');

        const codeA = (await a.getByTestId('online-room-code').textContent())?.trim();
        const codeB = (await b.getByTestId('online-room-code').textContent())?.trim();
        expect(codeA).toMatch(/^[A-Z0-9]{4}$/);
        expect(codeA).toBe(codeB);

        // After the window the announcement clears and the real board is revealed.
        await expect(a.locator('#match-starting')).toBeHidden({ timeout: 10_000 });
        await expect(a.locator('wc-board .board-grid')).toBeVisible();

        await ctxA.close();
        await ctxB.close();
    });

    // Regression: "stuck on 3 player joining" — three seekers who pick a 3-player
    // public match must all be matched into one started game (not left spinning
    // on "Finding players…"). Guards both the size-3 queue threshold and the
    // size picker that selects it.
    test('three public seekers fill a 3-player match', async ({ browser }) => {
        const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext()));
        const [a, b, c] = await Promise.all(ctxs.map(ctx => ctx.newPage()));

        for (const [page, name] of [[a, 'Ann'], [b, 'Bo'], [c, 'Cy']]) {
            await openOnline(page, name);
            await page.getByTestId('online-players-3').click(); // pick a 3-player match
            await page.getByTestId('online-public').click();
        }

        // The third seeker completes the queue → all three land in one room and
        // the public game auto-starts.
        for (const page of [a, b, c]) {
            await expect(page.getByTestId('online-started')).toHaveText('true', { timeout: 15_000 });
        }
        const codes = await Promise.all([a, b, c].map(p => p.getByTestId('online-room-code').textContent()));
        expect(new Set(codes.map(s => s?.trim())).size).toBe(1); // one shared room

        await Promise.all(ctxs.map(ctx => ctx.close()));
    });
});
