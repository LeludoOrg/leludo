import { test, expect } from '@playwright/test';

/**
 * Regression for "empty seat only fills when you hit the Human/Bot pill".
 *
 * Bug: on the "Who's playing?" setup screen, an empty seat row only had
 * click handlers on its two inline buttons (Human / Bot). Tapping the
 * large body of the row ("Empty seat / Tap a side to fill") did nothing,
 * so most of the row was dead space.
 *
 * Fix: the whole .seat-row-empty is now clickable and fills the seat as
 * a Human; the Human/Bot pills still pick their explicit type (and
 * stopPropagation so they don't double-fire the row handler).
 */

test.describe('Empty seat fill', () => {
    test('clicking the empty-row body fills the seat as a Human', async ({ page }) => {
        await page.goto('/');
        await page.locator('.new-game-btn').click();

        // Reduce to 2 active seats so we have empty rows to click.
        while ((await page.locator('.remove-seat').count()) > 2) {
            await page.locator('.remove-seat').last().click();
        }
        await expect(page.locator('.seat-row')).toHaveCount(2);
        await expect(page.locator('.seat-row-empty')).toHaveCount(2);

        // Click the body of the first empty row — NOT the Human/Bot pills.
        await page.locator('.seat-row-empty').first().locator('.seat-empty-title').click();

        // Seat is now filled: one fewer empty, one more filled row.
        await expect(page.locator('.seat-row')).toHaveCount(3);
        await expect(page.locator('.seat-row-empty')).toHaveCount(1);

        // The newly filled seat (3rd row) defaults to Human, not Bot.
        const newRow = page.locator('.seat-row').nth(2);
        await expect(newRow.locator('[data-half="PLAYER"]')).not.toHaveClass(/seat-half--inactive/);
        await expect(newRow.locator('[data-half="BOT"]')).toHaveClass(/seat-half--inactive/);
    });

    test('clicking the Bot pill on an empty row still fills it as a Bot', async ({ page }) => {
        await page.goto('/');
        await page.locator('.new-game-btn').click();

        while ((await page.locator('.remove-seat').count()) > 2) {
            await page.locator('.remove-seat').last().click();
        }
        await expect(page.locator('.seat-row-empty')).toHaveCount(2);

        // The explicit Bot pill must still win over the row's Human default.
        await page.locator('.seat-row-empty').first().locator('[data-add="BOT"]').click();

        await expect(page.locator('.seat-row')).toHaveCount(3);
        const newRow = page.locator('.seat-row').nth(2);
        await expect(newRow.locator('[data-half="BOT"]')).not.toHaveClass(/seat-half--inactive/);
        await expect(newRow.locator('[data-half="PLAYER"]')).toHaveClass(/seat-half--inactive/);
    });
});
