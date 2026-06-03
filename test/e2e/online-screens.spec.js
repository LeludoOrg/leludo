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

    test('online path offers both public and private options', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-public')).toBeEnabled(); // public match
        await expect(page.getByTestId('online-create')).toBeVisible();  // private: create
        await expect(page.getByTestId('online-join')).toBeVisible();    // private: join by code
        await expect(page.getByTestId('online-players')).toBeVisible();
    });

    test('back from the online menu returns home', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
        await expect(page.getByTestId('online-create')).toBeVisible();
        await page.goBack();
        await expect(page.getByTestId('home-play-offline')).toBeVisible();
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

test.describe('Online — public matchmaking', () => {
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

        // The queue pairs them into one room (same server-assigned code) and the
        // public game auto-starts once seats are filled — no host action needed.
        await expect(a.getByTestId('online-started')).toHaveText('true');
        await expect(b.getByTestId('online-started')).toHaveText('true');

        const codeA = (await a.getByTestId('online-room-code').textContent())?.trim();
        const codeB = (await b.getByTestId('online-room-code').textContent())?.trim();
        expect(codeA).toMatch(/^[A-Z0-9]{4}$/);
        expect(codeA).toBe(codeB);

        await ctxA.close();
        await ctxB.close();
    });
});
