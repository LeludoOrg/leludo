import { test, expect } from '@playwright/test';
import { openOnline } from './helpers.js';

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

test.describe('Home — offline / online split', () => {
    // TEMP(beta-merge): online entry is hidden until multiplayer ships. The
    // online flow below is still driven via dispatchEvent('click') on the
    // hidden button. Revert with the wc-quick-start change.
    test('home shows both paths', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('home-play-offline')).toBeVisible();
        await expect(page.getByTestId('home-play-online')).toBeHidden();
    });

    test('offline path opens the local "who is playing" setup', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-offline').click();
        await expect(page.locator('.seat-list')).toBeVisible();
        await expect(page.locator('.seat-row')).toHaveCount(4);
    });

    // Initial release ships private rooms only — the "Find a public match" entry
    // is hidden behind PUBLIC_MATCH_ENABLED in wc-quick-start.js. The online menu
    // is an identity + an entry point: your name centered as the hero, then the
    // actions (join by code + Create) at the bottom. The Open/Bot seats live
    // later in room mode, NOT here. It must NOT show the public entry.
    test('online path offers the private-room seat setup only', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');
        await expect(page.getByTestId('online-public')).toHaveCount(0);      // public hidden for launch
        await expect(page.getByTestId('online-create')).toBeVisible();        // create room (offered first)
        await expect(page.getByTestId('online-join')).toBeVisible();          // join by code
        await expect(page.getByTestId('online-setup-seat-0')).toBeVisible();  // your seat (name)
        await expect(page.getByTestId('online-name')).toBeVisible();
        await expect(page.getByTestId('online-create')).toBeVisible();        // create room

        // No other seats / Open-Bot toggles on the setup screen — they belong to
        // room mode now. Guards against reintroducing the seat picker here.
        await expect(page.getByTestId('online-setup-seat-1')).toHaveCount(0);
        await expect(page.getByTestId('online-setup-seat-1-bot')).toHaveCount(0);
    });

    // Layout mirrors home: the name is the centered hero up top, and the actions
    // sit at the bottom — Create room, then a separator, then join-by-code.
    // Guards the requested structure (name centered above; create + join with a
    // divider between, bottom-aligned).
    test('the setup screen centers the name above the create / join actions', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');

        const name = await page.getByTestId('online-name').boundingBox();
        const create = await page.getByTestId('online-create').boundingBox();
        const divider = await page.locator('.online-new-room-divider').boundingBox();
        const join = await page.getByTestId('online-code-input').boundingBox();
        expect(name.y).toBeLessThan(create.y);     // name (hero) above the actions
        expect(create.y).toBeLessThan(divider.y);  // Create room above the separator
        expect(divider.y).toBeLessThan(join.y);    // separator above join
    });

    // The colour picker requests a seat: the seat index doubles as the colour,
    // so choosing colour 2 seats you at seat 2 in the room you create. Guards the
    // pick → preferred-seat handoff end to end (client param → server seating).
    test('the picked colour becomes your seat in the created room', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');
        await page.getByTestId('online-name').fill('Hue');

        await page.getByTestId('online-color-2').click();
        await expect(page.getByTestId('online-color-2')).toHaveClass(/is-selected/);

        await page.getByTestId('online-create').click();

        await expect(page.getByTestId('online-room-code')).toBeVisible();
        // Seat 2 = the chosen colour; you (the host) hold it.
        await expect(page.getByTestId('online-seat-2')).toContainText('Hue');
        await expect(page.getByTestId('online-seat-2')).toContainText('(you)');
    });

    test('back from the online menu returns home', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');
        await expect(page.getByTestId('online-create')).toBeVisible();
        await page.goBack();
        await expect(page.getByTestId('home-play-offline')).toBeVisible();
    });

    // Play online and the game room are two separate components/screens:
    // <wc-play-online> (name + join/create) and <wc-game-room> (code + seats +
    // Start). Creating a room navigates from the first to the second; back
    // returns to setup (not all the way home). Guards the split + its wiring.
    test('creating a room navigates from play-online to the game-room screen', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');
        await page.getByTestId('online-name').fill('Hosty');

        // Setup screen: the play-online component, with join + no room code yet.
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.locator('wc-game-room')).toHaveCount(0);
        await expect(page.getByTestId('online-join')).toBeVisible();
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);

        await page.getByTestId('online-create').click();

        // Room screen: the game-room component replaces play-online. Code in,
        // join + create gone (different screen), Start/Leave in.
        await expect(page.locator('wc-game-room')).toHaveCount(1);
        await expect(page.locator('wc-play-online')).toHaveCount(0);
        await expect(page.getByTestId('online-room-code')).toBeVisible();
        await expect(page.getByTestId('online-create')).toHaveCount(0);
        await expect(page.getByTestId('online-join')).toHaveCount(0);
        await expect(page.getByTestId('online-leave')).toBeVisible();
        await expect(page.getByTestId('online-start')).toBeVisible(); // host sees Start

        // Back from the room returns to the play-online setup screen.
        await page.goBack();
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.locator('wc-game-room')).toHaveCount(0);
        await expect(page.getByTestId('online-create')).toBeVisible();
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);
    });
});

test.describe('Online — username', () => {
    test('requires a name before going online', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').dispatchEvent('click');
        await expect(page.getByTestId('online-name')).toHaveValue(''); // fresh device
        await page.getByTestId('online-create').click();
        // Blocked: no room is created, a prompt is shown.
        await expect(page.getByTestId('online-status')).toContainText(/name/i);
        await expect(page.getByTestId('online-room-code')).toHaveCount(0);
    });

    test('remembers the name for next time', async ({ page }) => {
        await openOnline(page, 'Zelda');
        await page.goBack(); // back home
        await page.getByTestId('home-play-online').dispatchEvent('click');
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
        // Two humans sit diagonally opposite: host at seat 0, guest at seat 2.
        await expect(guest.getByTestId('online-is-host')).toHaveText('false');
        await expect(guest.getByTestId('online-start')).toBeHidden();
        await expect(host.getByTestId('online-seat-2')).toContainText('Ready');
        await expect(host.getByTestId('online-seat-2')).toContainText('Guesty'); // remembered name shows

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

    // The colour is the HOST's: only the room creator's pick is honoured. A
    // joiner's pick is ignored — the server seats them in the next open seat,
    // not their chosen colour. (Host takes colour 2; guest picks the free
    // colour 1 but still lands in seat 0, the next open one.)
    test('only the host picks a colour — a joiner is seated automatically', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        // Host picks colour 2 and creates → host holds seat 2.
        await openOnline(host, 'Hosty');
        await host.getByTestId('online-color-2').click();
        await host.getByTestId('online-create').click();
        const code = (await host.getByTestId('online-room-code').textContent())?.trim();
        await expect(host.getByTestId('online-seat-2')).toContainText('(you)');

        // Guest picks colour 1 (free) but JOINS → the pick is ignored; the guest
        // is seated at the next open seat (0), NOT colour 1.
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-color-1').click();
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();
        await expect(guest.getByTestId('online-seat-0')).toContainText('(you)');
        await expect(guest.getByTestId('online-seat-1')).not.toContainText('(you)');

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

        // Guest joins → seated diagonally opposite at seat 2; host sees its Kick.
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();
        // Kicking a joined human is a distinct, *labelled* control — not the bare
        // × used to empty a bot/open chair. Regression: a refactor once collapsed
        // it to a tooltip-only × that read as "remove slot", so the host had no
        // visible "kick this person" affordance. Assert the label is present.
        await expect(host.getByTestId('online-seat-2-kick')).toBeVisible();
        await expect(host.getByTestId('online-seat-2-kick')).toHaveText(/kick/i);

        // Host kicks the guest → guest is bounced back to the online menu.
        await host.getByTestId('online-seat-2-kick').click();
        await expect(guest.getByTestId('online-create')).toBeVisible();
        await expect(guest.getByTestId('online-status')).toContainText(/removed/i);

        // Seat 2 reopens; host taps Bot to drop a bot in, and seat 2 reads "Bot".
        await expect(host.getByTestId('online-seat-2-bot')).toBeVisible();
        await host.getByTestId('online-seat-2-bot').click();
        await expect(host.getByTestId('online-seat-2')).toContainText('Bot');

        await ctxHost.close();
        await ctxGuest.close();
    });

    // Offline-parity seat controls: the host configures each chair as Empty,
    // Human, or Bot — tap × to empty an open chair, then a side to refill it.
    // Guards the new online lobby matching the offline "who's playing?" setup.
    test('host can empty a seat and refill it (Human / Bot / Empty like offline)', async ({ page }) => {
        await openOnline(page, 'Hosty');
        await page.getByTestId('online-create').click();
        await expect(page.getByTestId('online-room-code')).toBeVisible();

        // A fresh room is four open Human chairs; the host holds one. Seat 1 is an
        // open chair the host can reconfigure (× to empty, then Human / Bot to fill).
        await expect(page.getByTestId('online-seat-1')).toContainText('Open seat');

        await page.getByTestId('online-seat-1-empty').click();          // × → empty
        await expect(page.getByTestId('online-seat-1')).toContainText('Empty seat');

        await page.getByTestId('online-seat-1-human').click();          // fill → Human (open)
        await expect(page.getByTestId('online-seat-1')).toContainText('Open seat');

        await page.getByTestId('online-seat-1-bot').click();            // flip → Bot
        await expect(page.getByTestId('online-seat-1')).toContainText('Bot');
    });
});

test.describe('Online — invite links', () => {
    // The game room's Share button fires the OS share sheet with a join message
    // and a deep link back to this room. Headless Chromium has no share sheet, so
    // stub navigator.share and assert what we hand it (link carries ?join=CODE).
    test('Share invite opens the OS share sheet with a join link', async ({ page }) => {
        await page.addInitScript(() => {
            window.__shared = null;
            navigator.share = (data) => { window.__shared = data; return Promise.resolve(); };
        });

        await openOnline(page, 'Hosty');
        await page.getByTestId('online-create').click();
        const code = (await page.getByTestId('online-room-code').textContent())?.trim();

        await expect(page.getByTestId('online-share')).toBeVisible();
        await page.getByTestId('online-share').click();

        const shared = await page.evaluate(() => window.__shared);
        expect(shared).toBeTruthy();
        expect(shared.url).toContain(`?join=${code}`); // deep link back to this room
        expect(shared.text).toContain(code);            // message names the code too
    });

    // Opening a shared "?join=CODE" link with a remembered name joins straight
    // into that room's lobby — no menu, no typing the code by hand.
    test('a shared invite link drops a known player straight into the room lobby', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        await openOnline(host, 'Hosty');
        await host.getByTestId('online-create').click();
        const code = (await host.getByTestId('online-room-code').textContent())?.trim();

        // Give the guest a remembered name, then open the invite link.
        await openOnline(guest, 'Linky');
        await guest.goto(`/?join=${code}`);

        // Lands in the game room (not the setup screen), seated in the host's room
        // diagonally opposite the host (seat 2).
        await expect(guest.locator('wc-game-room')).toHaveCount(1);
        await expect(guest.locator('wc-play-online')).toHaveCount(0);
        await expect(guest.getByTestId('online-room-code')).toHaveText(code);
        await expect(host.getByTestId('online-seat-2')).toContainText('Linky');

        await ctxHost.close();
        await ctxGuest.close();
    });

    // A brand-new visitor (no remembered name) opening an invite link lands on
    // the setup screen with the code pre-filled, prompting for a name — one tap
    // away from joining, without losing the link.
    test('a shared invite link with no saved name prefills the code and asks for a name', async ({ page }) => {
        await page.goto('/?join=ABCD'); // ABCD is a valid room-code-alphabet code
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.getByTestId('online-code-input')).toHaveValue('ABCD');
        await expect(page.getByTestId('online-status')).toContainText(/name/i);
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
