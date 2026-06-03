import { test, expect } from '@playwright/test';

/**
 * Home now offers two clear, separate paths — offline (pass-and-play on this
 * device) and online (server-backed multiplayer). These guard that split plus
 * the online lobby flow (create a private room, share the code, a second device
 * joins by code and the room fills).
 *
 * The online lobby talks to the real Node ws server that Playwright starts
 * (server/local-server.mjs on 8890), so "both clients meet in one room" is an
 * end-to-end check, not a mock.
 */

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

test.describe('Online lobby — create + join', () => {
    test('two devices meet in one room via a shared code and the room starts', async ({ browser }) => {
        const ctxHost = await browser.newContext();
        const ctxGuest = await browser.newContext();
        const host = await ctxHost.newPage();
        const guest = await ctxGuest.newPage();

        // Host creates a private 2-player room.
        await host.goto('/');
        await host.getByTestId('home-play-online').click();
        await host.getByTestId('online-create').click();

        const code = (await host.getByTestId('online-room-code').textContent())?.trim();
        expect(code).toMatch(/^[A-Z0-9]{4}$/);
        await expect(host.getByTestId('online-started')).toHaveText('false'); // waiting for the guest

        // Guest joins by the shared code.
        await guest.goto('/');
        await guest.getByTestId('home-play-online').click();
        await guest.getByTestId('online-code-input').fill(code);
        await guest.getByTestId('online-join').click();

        // Both devices now see the same full room and the game starting.
        await expect(host.getByTestId('online-started')).toHaveText('true');
        await expect(guest.getByTestId('online-started')).toHaveText('true');
        // The host now sees the guest seated and ready (both seats filled).
        await expect(host.getByTestId('online-seat-1')).toContainText('Ready');
        await expect(guest.getByTestId('online-room-code')).toHaveText(code);

        await ctxHost.close();
        await ctxGuest.close();
    });
});

test.describe('Online — public matchmaking', () => {
    test('cancelling a public search returns to the online menu', async ({ page }) => {
        await page.goto('/');
        await page.getByTestId('home-play-online').click();
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
        await a.goto('/');
        await a.getByTestId('home-play-online').click();
        await a.getByTestId('online-public').click();
        await expect(a.getByTestId('online-search-status')).toBeVisible();

        await b.goto('/');
        await b.getByTestId('home-play-online').click();
        await b.getByTestId('online-public').click();

        // The queue pairs them into one room and the game starts for both.
        await expect(a.getByTestId('online-started')).toHaveText('true');
        await expect(b.getByTestId('online-started')).toHaveText('true');

        const codeA = (await a.getByTestId('online-room-code').textContent())?.trim();
        const codeB = (await b.getByTestId('online-room-code').textContent())?.trim();
        expect(codeA).toMatch(/^[A-Z0-9]{4}$/);
        expect(codeA).toBe(codeB); // same server-assigned room

        await ctxA.close();
        await ctxB.close();
    });
});
