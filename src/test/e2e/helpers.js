import { expect } from '@playwright/test';

/**
 * Shared Playwright e2e helpers.
 *
 * Most specs replay one of two boot sequences verbatim — the offline
 * pass-and-play start and the online-menu open. Centralising them here keeps
 * the selectors/wait points in one place so a UI rename is a one-line fix
 * instead of a hunt across a dozen specs.
 */

/**
 * Drive the offline boot: home → "new game" → setup → "start" → board mounted.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} [query] - optional query string (leading '?'), e.g. a
 *   ?positions=…&player=N scenario override. Passed straight through to goto.
 */
export async function startGame(page, query = '') {
    await page.goto(`/${query}`);
    await page.locator('.new-game-btn').click();
    await expect(page.locator('.start-btn')).toBeVisible();
    await page.locator('.start-btn').click();
    await page.locator('wc-board:not(.hidden)').waitFor();
}

/**
 * Open the online entry screen as a player called `name`.
 *
 * The display name is picked in the room lobby now, not on the entry screen, so
 * we seed it as the remembered username before navigating: the connect carries
 * it and the lobby pre-fills it. This keeps the many specs that just need "this
 * player is called X" terse (and matches a returning player on a real device).
 * Honours an optional query string on the initial navigation (used by the
 * grace-window override in online-gameplay).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name - remembered display name for this player.
 * @param {string} [query] - optional query string (leading '?').
 */
export async function openOnline(page, name, query = '') {
    await page.addInitScript((n) => {
        try { localStorage.setItem('leludo-username', n); } catch { /* storage blocked */ }
    }, name);
    await page.goto(`/${query}`);
    await page.getByTestId('home-play-online').click();
}

/**
 * Build a `?positions=…` query string from a sparse list of token positions.
 *
 * Indexing follows the documented test override (CLAUDE.md "Test Overrides"):
 * slot index = playerIndex * 4 + tokenIndex, 16 slots total. Missing / blank
 * entries are emitted as empty fields, which handleGameStart reads as -1
 * (home). Accepts a sparse array or an index→value object.
 *
 * @param {Array<number|undefined>|Object<number, number>} list
 * @returns {string} e.g. "?positions=50,,,,,,,,,,,,,,," (leading '?').
 */
export function positions(list) {
    const slots = new Array(16).fill('');
    const entries = Array.isArray(list) ? list.entries() : Object.entries(list);
    for (const [i, v] of entries) {
        const idx = Number(i);
        if (idx < 0 || idx > 15) throw new Error(`positions slot ${idx} out of range 0..15`);
        if (v !== undefined && v !== null && v !== '') slots[idx] = String(v);
    }
    return `?positions=${slots.join(',')}`;
}
