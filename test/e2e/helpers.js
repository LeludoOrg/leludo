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
 * Open the online menu and enter a display name (required to play online).
 *
 * Superset of the three near-identical copies that used to live in
 * online-screens / online-hidden-tab / online-gameplay: honours an optional
 * query string on the initial navigation (used by the grace-window override in
 * online-gameplay).
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name - display name to type into the online name field.
 * @param {string} [query] - optional query string (leading '?').
 */
export async function openOnline(page, name, query = '') {
    await page.goto(`/${query}`);
    await page.getByTestId('home-play-online').click();
    await page.getByTestId('online-name').fill(name);
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
