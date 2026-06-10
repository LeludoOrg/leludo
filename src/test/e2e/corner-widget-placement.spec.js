import { test, expect } from '@playwright/test';

/**
 * Regression for "player name + dice land in the wrong corner with
 * fewer than 4 players".
 *
 * Bug: .board-corner-row used `justify-content: space-between` and hid
 * empty corner divs (`> div:empty { display: none }`). In a 2-player
 * diagonal game (seats 0 + 2) each corner row holds a single occupied
 * div, so space-between collapsed it to flex-start. The bottom row's
 * lone widget is seat 2 (should hug the RIGHT under its quadrant) but
 * rendered at the bottom-LEFT instead.
 *
 * Fix: each corner anchor now owns half the row (flex: 1) and hugs its
 * own side (b0/b3 flex-start, b1/b2 flex-end), so a widget stays under
 * its quadrant regardless of how many seats are filled.
 */

test.describe('Corner widget placement with <4 players', () => {
    test('bottom-right seat keeps its widget on the right side', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('wc-quick-start')).toBeVisible();

        // 1 human (seat 2, bottom-right) + 1 bot (seat 0, top-left).
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.START_GAME,
                quickStartId: 'qs,1,1,0',
                namesByPlayerIndex: ['Me', 'Bot', '', ''],
            });
        });

        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();

        // The two diagonal seats are occupied; the other two corners are empty.
        await expect(page.locator('#b0 .corner-widget')).toHaveCount(1);
        await expect(page.locator('#b2 .corner-widget')).toHaveCount(1);
        await expect(page.locator('#b1 .corner-widget')).toHaveCount(0);
        await expect(page.locator('#b3 .corner-widget')).toHaveCount(0);

        const placement = await page.evaluate(() => {
            const center = (el) => {
                const r = el.getBoundingClientRect();
                return r.left + r.width / 2;
            };
            const topRow = document.getElementById('corner-row-top').getBoundingClientRect();
            const bottomRow = document.getElementById('corner-row-bottom').getBoundingClientRect();
            return {
                topMid: topRow.left + topRow.width / 2,
                bottomMid: bottomRow.left + bottomRow.width / 2,
                b0Center: center(document.querySelector('#b0 .corner-widget')),
                b2Center: center(document.querySelector('#b2 .corner-widget')),
            };
        });

        // Top-left seat (b0) hugs the LEFT half of its row.
        expect(placement.b0Center).toBeLessThan(placement.topMid);
        // Bottom-right seat (b2) hugs the RIGHT half — the original bug
        // dragged it left of the midpoint.
        expect(placement.b2Center).toBeGreaterThan(placement.bottomMid);
    });
});
