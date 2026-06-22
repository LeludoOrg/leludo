import { test, expect } from '@playwright/test';
import { openOnline, goHomeOnline } from './helpers.js';

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
    test('home shows both paths', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByTestId('home-mode-device')).toBeVisible();
        await expect(page.getByTestId('home-mode-online')).toBeVisible();
    });

    test('offline path opens the local "who is playing" setup', async ({ page }) => {
        await page.goto('/');
        // Device is the default mode; New game opens local setup directly.
        await page.getByTestId('home-new-game').click();
        await expect(page.locator('.seat-list')).toBeVisible();
        await expect(page.locator('.seat-row')).toHaveCount(4);
    });

    // The home is a single CTA whose destination is set by the mode toggle.
    // Device is the default; flipping to Online re-points the one New game button
    // at the online flow and swaps the subtext. Guards the "mode toggle, one
    // button" redesign — a regression where New game ignored the toggle would
    // strand online players on the offline setup.
    test('the mode toggle re-points the single New game button', async ({ page }) => {
        await page.goto('/');
        // Default: device mode, offline-flavoured subtext.
        await expect(page.getByTestId('home-mode-device')).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('home-cta-sub')).toContainText(/this device/i);

        // Flip to Online: selection + subtext follow, New game enters the online flow.
        await page.getByTestId('home-mode-online').click();
        await expect(page.getByTestId('home-mode-online')).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('home-cta-sub')).toContainText(/friends|room|online/i);
        await page.getByTestId('home-new-game').click();
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.locator('.seat-list')).toHaveCount(0); // NOT the offline setup
    });

    // Initial release ships private rooms only — the "Find a public match" entry
    // is hidden behind PUBLIC_MATCH_ENABLED in wc-quick-start.js. The entry screen
    // is join-first: a code field + "Join room" as the hero, then a quieter
    // "Create a room" card. Name + colour are picked later, in the lobby — NOT
    // here. It must NOT show the public entry.
    test('online path offers the private-room join / create entry only', async ({ page }) => {
        await page.goto('/');
        await goHomeOnline(page);
        await expect(page.getByTestId('online-public')).toHaveCount(0);      // public hidden for launch
        await expect(page.getByTestId('online-join')).toBeVisible();          // join by code (primary)
        await expect(page.getByTestId('online-code-input')).toBeVisible();
        await expect(page.getByTestId('online-create')).toBeVisible();        // create-a-room card

        // Identity moved to the lobby: no name field or colour picker on entry.
        // Guards against reintroducing them here.
        await expect(page.getByTestId('online-name')).toHaveCount(0);
        await expect(page.getByTestId('online-color-picker')).toHaveCount(0);
        await expect(page.getByTestId('online-setup-seat-0')).toHaveCount(0);
    });

    // Join is the hero up top; "host your own" sits below — the code field above
    // the "or host your own" divider, the Create card below it. Guards the
    // requested join-first structure.
    test('the entry screen puts join above the create card', async ({ page }) => {
        await page.goto('/');
        await goHomeOnline(page);

        const join = await page.getByTestId('online-code-input').boundingBox();
        const divider = await page.locator('.online-host-divider').boundingBox();
        const create = await page.getByTestId('online-create').boundingBox();
        expect(join.y).toBeLessThan(divider.y);    // join hero above the separator
        expect(divider.y).toBeLessThan(create.y);  // separator above the Create card
    });

    // Your own seat carries an editable name inline (like the offline setup); your
    // row is the one tagged "(you)". The host lands on seat 0.
    test('your seat shows your name inline and is tagged (you)', async ({ page }) => {
        await openOnline(page, 'Hue');
        await page.getByTestId('online-create').click();
        await expect(page.getByTestId('online-room-code')).toBeVisible();

        await expect(page.getByTestId('online-seat-0')).toContainText('(you)');
        // The name is an editable input on your own row (not static text).
        await expect(page.getByTestId('online-seat-0').getByTestId('online-name')).toHaveValue('Hue');
    });

    // Editing your name mirrors the offline setup's focus UI: your seat's underline
    // tints to your colour, the pencil hides, and every OTHER seat is muted. All of
    // it resets on blur.
    test('editing your name tints your seat and mutes the others', async ({ page }) => {
        await openOnline(page, 'Hue');
        await page.getByTestId('online-create').click();
        await expect(page.getByTestId('online-room-code')).toBeVisible();

        const other = page.getByTestId('online-seat-1');
        const wrap = page.getByTestId('online-seat-0').locator('.seat-name-wrap');
        const pencil = wrap.locator('.seat-name-pencil');
        const restColor = await wrap.evaluate(el => getComputedStyle(el).borderBottomColor);
        await expect(other).toHaveCSS('opacity', '1');      // un-muted to start
        await expect(pencil).toBeVisible();

        await page.getByTestId('online-name').focus();
        await expect(other).toHaveCSS('opacity', '0.35');   // other seats muted
        await expect(page.getByTestId('online-seat-0')).toHaveCSS('opacity', '1'); // your row stays
        await expect(pencil).toBeHidden();                  // pencil hides while editing
        // Underline tints to your colour (≠ the resting border colour).
        const focusColor = await wrap.evaluate(el => getComputedStyle(el).borderBottomColor);
        expect(focusColor).not.toBe(restColor);

        await page.getByTestId('online-name').blur();
        await expect(other).toHaveCSS('opacity', '1');      // mute clears
        await expect(pencil).toBeVisible();
    });

    test('back from the online menu returns home', async ({ page }) => {
        await page.goto('/');
        await goHomeOnline(page);
        await expect(page.getByTestId('online-create')).toBeVisible();
        await page.goBack();
        await expect(page.getByTestId('home-new-game')).toBeVisible();
    });

    // Play online and the game room are two separate components/screens:
    // <wc-play-online> (name + join/create) and <wc-game-room> (code + seats +
    // Start). Creating a room navigates from the first to the second; back
    // returns to setup (not all the way home). Guards the split + its wiring.
    test('creating a room navigates from play-online to the game-room screen', async ({ page }) => {
        await openOnline(page, 'Hosty');

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
    // No name is required on the entry screen anymore — you can create a room with
    // no saved name and pick it in the lobby. Guards that create is never blocked.
    test('creating a room no longer requires a name up front', async ({ page }) => {
        await page.goto('/');
        await goHomeOnline(page);
        await page.getByTestId('online-create').click();
        // A room is created and the name field lives in the lobby now.
        await expect(page.getByTestId('online-room-code')).toBeVisible();
        await expect(page.getByTestId('online-name')).toBeVisible();
    });

    // The remembered name carries into the lobby; renaming there persists for the
    // next room. Guards the name carry-through + lobby persistence.
    test('remembers the name and lets you change it in the lobby', async ({ page }) => {
        await openOnline(page, 'Zelda');
        await page.getByTestId('online-create').click();
        await expect(page.getByTestId('online-name')).toHaveValue('Zelda'); // carried in

        // Rename on your seat, then create a fresh room — the new name persists.
        await page.getByTestId('online-name').fill('Link');
        await page.getByTestId('online-name').blur();
        // Server echoes the rename back onto your seat row's input.
        await expect(page.getByTestId('online-name')).toHaveValue('Link');
        await expect(page.getByTestId('online-seat-0')).toContainText('(you)');

        await page.goBack(); // back to the entry screen
        await page.getByTestId('online-create').click();
        await expect(page.getByTestId('online-name')).toHaveValue('Link');
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

    // The host takes seat 0; a joiner is auto-seated diagonally opposite (seat 2).
    // Each sees their own seat tagged "(you)" with an editable name inline.
    test('a joiner is auto-seated diagonally opposite the host', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        await openOnline(host, 'Hosty');
        await host.getByTestId('online-create').click();
        const code = (await host.getByTestId('online-room-code').textContent())?.trim();
        await expect(host.getByTestId('online-seat-0')).toContainText('(you)');

        // Guest joins → auto-seated diagonally at seat 2 (not adjacent to the host).
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();
        await expect(guest.getByTestId('online-seat-2')).toContainText('(you)');
        await expect(guest.getByTestId('online-seat-2').getByTestId('online-name')).toHaveValue('Guesty');
        // Host sees the guest on seat 2 (as static text, not its own input).
        await expect(host.getByTestId('online-seat-2')).toContainText('Guesty');

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

    // Regression: a typo'd / stale code used to silently spin up a brand-new empty
    // room, dropping the player alone into a ghost lobby that no friend was in.
    // The join is now validated against the server BEFORE navigating, so a code
    // nobody created never mounts the room screen at all — the player stays on the
    // setup screen with an error and their typed code intact (no flash-and-bounce).
    test('joining a room code that was never created is rejected', async ({ page }) => {
        await openOnline(page, 'Lost');
        // A well-formed code (right length + alphabet) that no host ever created.
        await page.getByTestId('online-code-input').fill('ZZZZ');
        await page.getByTestId('online-join').click();
        // We never leave the setup screen: no room screen is mounted, the typed
        // code is preserved, and an error explains why.
        await expect(page.getByTestId('online-status')).toContainText(/no room/i);
        await expect(page.locator('wc-game-room')).toHaveCount(0);
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.getByTestId('online-code-input')).toHaveValue('ZZZZ');
        await expect(page.getByTestId('online-create')).toBeVisible();
    });

    // Regression: online is human-vs-human — a lone host must NOT be able to start
    // a solo-vs-bots match. The Start button is disabled until a second human is
    // seated, and only enables once the guest joins.
    test('host cannot start until a second human joins', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        await openOnline(host, 'Hosty');
        await host.getByTestId('online-create').click();
        const code = (await host.getByTestId('online-room-code').textContent())?.trim();

        // Solo host: even after dropping a bot into a seat, Start stays disabled —
        // a bot doesn't count toward the two-human minimum.
        await host.getByTestId('online-seat-1-bot').click();
        await expect(host.getByTestId('online-seat-1')).toContainText('Bot');
        await expect(host.getByTestId('online-start')).toBeVisible();   // visible…
        await expect(host.getByTestId('online-start')).toBeDisabled();  // …but greyed out

        // A second human joins → Start enables.
        await openOnline(guest, 'Guesty');
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();
        await expect(host.getByTestId('online-seat-2')).toContainText('Guesty');
        await expect(host.getByTestId('online-start')).toBeEnabled();

        await ctxHost.close();
        await ctxGuest.close();
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
        // diagonally opposite the host (seat 2). The join is validated against the
        // server before navigating, so the room screen appears once we're seated —
        // allow a server-round-trip's headroom (matches the other online specs).
        await expect(guest.locator('wc-game-room')).toHaveCount(1, { timeout: 15_000 });
        await expect(guest.locator('wc-play-online')).toHaveCount(0);
        await expect(guest.getByTestId('online-room-code')).toHaveText(code);
        await expect(host.getByTestId('online-seat-2')).toContainText('Linky');

        await ctxHost.close();
        await ctxGuest.close();
    });

    // A brand-new visitor (no remembered name) opening an invite link lands on
    // the entry screen with the code pre-filled, one tap from joining — name +
    // colour are picked in the lobby afterwards, so it doesn't block on a name.
    test('a shared invite link with no saved name prefills the code ready to join', async ({ page }) => {
        await page.goto('/?join=ABCD'); // ABCD is a valid room-code-alphabet code
        await expect(page.locator('wc-play-online')).toHaveCount(1);
        await expect(page.getByTestId('online-code-input')).toHaveValue('ABCD');
        await expect(page.getByTestId('online-status')).toContainText(/join/i);
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
