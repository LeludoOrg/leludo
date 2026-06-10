import { test, expect } from '@playwright/test';

/**
 * Regression for "seat colour follows fill order, not seat position".
 *
 * Bug: on the "Who's playing?" setup screen, filling an empty seat
 * assigned it the first FREE colour ([0,1,2,3].find(unused)). So if you
 * emptied every seat and refilled the third row first, it became red
 * (player-0) instead of gold (player-2). Colours drifted with fill order.
 *
 * Fix: a seat's colour is locked to its row index (0 = red, 1 = green,
 * 2 = gold, 3 = blue). Empty rows preview that colour with a ghost pawn,
 * and the per-seat colour picker was removed entirely.
 */

test.describe('Seat colour locked to row position', () => {
    test('empty rows preview their fixed colour', async ({ page }) => {
        await page.goto('/');
        await page.locator('.new-game-btn').click();

        // Empty every seat.
        while ((await page.locator('.remove-seat').count()) > 0) {
            await page.locator('.remove-seat').first().click();
        }
        await expect(page.locator('.seat-row-empty')).toHaveCount(4);

        // Each empty row's ghost pawn carries its row-index colour class.
        for (let i = 0; i < 4; i++) {
            const ghost = page.locator('.seat-row-empty').nth(i).locator('.seat-pawn-ghost svg');
            await expect(ghost).toHaveClass(new RegExp(`player-fg-${i}`));
        }
    });

    test('filling a seat takes its row colour regardless of fill order', async ({ page }) => {
        await page.goto('/');
        await page.locator('.new-game-btn').click();

        while ((await page.locator('.remove-seat').count()) > 0) {
            await page.locator('.remove-seat').first().click();
        }
        await expect(page.locator('.seat-row-empty')).toHaveCount(4);

        // Fill the THIRD row first — it must become gold (player-2), the bug
        // gave it red (player-0) because it was the first fill.
        await page.locator('.seat-row-empty').nth(2).locator('[data-add="PLAYER"]').click();

        const filled = page.locator('.seat-row');
        await expect(filled).toHaveCount(1);
        await expect(filled.locator('.seat-pawn svg')).toHaveClass(/player-fg-2/);
        // No colour picker survives — the swatch is a static div, not a button.
        await expect(page.locator('.color-cycle')).toHaveCount(0);
    });
});
