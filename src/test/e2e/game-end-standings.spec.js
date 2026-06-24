import { test, expect } from '@playwright/test';

/**
 * Final-standings podium on the end-of-game recap (wc-game-end).
 *
 * Guards the v0.28.0 feature: the recap shows a podium — top 3 on stepped
 * blocks (2nd | 1st | 3rd) and 4th as the "wooden spoon" row beneath — and in
 * ONLINE games this client's own spot is flagged "You". Mirrors
 * store-nudge.spec.js: dispatch START_GAME then mount the recap directly, so we
 * don't have to drive a whole game to completion.
 */

// Start a 4-player game, then force final ranks and mount the recap. `online`
// flips multiplayer mode on (this client always sits at local board index 2).
async function mountRecap(page, { ranks, online }) {
    await page.goto('/');
    await page.evaluate(async ({ ranks, online }) => {
        const mod = await import('/scripts/index.js');
        mod.dispatch({
            type: mod.COMMANDS.START_GAME,
            quickStartId: 'qs,1,3,0',
            namesByPlayerIndex: ['Aarav', 'Bianca', 'Vishal', 'Chen'],
        });
        // Stamp final ranks (1 = winner) the way the reducer would at game end.
        for (let i = 0; i < 4; i++) mod.playerRanks[i] = ranks[i];

        const os = await import('/scripts/net/online-state.js');
        if (online) os.setOnline({}, 2, [0, 1, 2, 3]); // local self = board index 2
        else os.clearOnline();

        document.querySelectorAll('wc-game-end').forEach((e) => e.remove());
        document.body.appendChild(document.createElement('wc-game-end'));
    }, { ranks, online });
}

test('podium shows top 3 steps plus a 4th wooden-spoon row', async ({ page }) => {
    await mountRecap(page, { ranks: [1, 2, 3, 4], online: false });
    const cols = page.locator('wc-game-end .ge-pod');
    await expect(cols).toHaveCount(3);
    // Visual order is [2nd, 1st, 3rd] — winner centre-stage.
    await expect(cols.nth(0)).toHaveClass(/ge-pod-2/);
    await expect(cols.nth(1)).toHaveClass(/ge-pod-1/);
    await expect(cols.nth(2)).toHaveClass(/ge-pod-3/);
    await expect(cols.nth(1).locator('.ge-pod-name')).toHaveText('Aarav'); // rank 1
    await expect(cols.nth(1).locator('.ge-pod-place')).toHaveText('1st');

    const loser = page.locator('wc-game-end .ge-loser');
    await expect(loser).toHaveCount(1);
    await expect(loser.locator('.ge-loser-name')).toContainText('Chen'); // rank 4
    await expect(loser.locator('.ge-loser-place')).toHaveText('4th');
});

test('three-player game shows three steps and no wooden spoon', async ({ page }) => {
    // Only seats 0-2 are filled (rank 0 / unseated 4th drops out).
    await page.goto('/');
    await page.evaluate(async () => {
        const mod = await import('/scripts/index.js');
        mod.dispatch({
            type: mod.COMMANDS.START_GAME,
            quickStartId: 'qs,1,2,0',
            namesByPlayerIndex: ['Aarav', 'Bianca', 'Vishal'],
        });
        for (let i = 0; i < 4; i++) mod.playerRanks[i] = [1, 2, 3, 0][i];
        const os = await import('/scripts/net/online-state.js');
        os.clearOnline();
        document.querySelectorAll('wc-game-end').forEach((e) => e.remove());
        document.body.appendChild(document.createElement('wc-game-end'));
    });
    await expect(page.locator('wc-game-end .ge-pod')).toHaveCount(3);
    await expect(page.locator('wc-game-end .ge-loser')).toHaveCount(0);
});

test('offline: no spot is flagged as "You"', async ({ page }) => {
    await mountRecap(page, { ranks: [1, 2, 3, 4], online: false });
    await expect(page.locator('wc-game-end .ge-pod-self')).toHaveCount(0);
    await expect(page.locator('wc-game-end .ge-loser-self')).toHaveCount(0);
    await expect(page.locator('wc-game-end .ge-pod-you, wc-game-end .ge-loser-you')).toHaveCount(0);
});

test('online: this client\'s own podium step is highlighted', async ({ page }) => {
    // Self sits at local index 2 (Vishal) and placed 2nd here.
    await mountRecap(page, { ranks: [1, 3, 2, 4], online: true });
    const self = page.locator('wc-game-end .ge-pod-self');
    await expect(self).toHaveCount(1);
    await expect(self).toHaveClass(/ge-pod-2/); // 2nd place step
    await expect(self.locator('.ge-pod-name')).toHaveText('Vishal');
    await expect(self.locator('.ge-pod-you')).toBeVisible();
});
