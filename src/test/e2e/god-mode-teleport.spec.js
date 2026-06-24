import { test, expect } from '@playwright/test';
import { startGame, positions } from './helpers.js';

/**
 * Regression for god-mode teleport navigation.
 *
 * Bug: god-mode teleport snapped the pawn straight into the target cell
 * with a bare `targetCell.appendChild(token)` — no cell-by-cell glide,
 * unlike a normal turn (which walks the path via updateTokenContainer
 * with the per-step transform + step sound). God-mode is meant to mirror
 * normal play for any visible behaviour (see CLAUDE.md "God Mode" parity
 * rule), so a forward teleport must animate along the path like a real move.
 *
 * Fix: forward teleports route through updateTokenContainer (the same
 * function selectToken uses), so they glide cell-by-cell. Backward /
 * same-cell teleports have no normal-game analog and getContainerPath
 * builds no reverse path, so they still snap in place — but must land on
 * the right cell (no desync).
 */

test.describe('God mode teleport navigation', () => {
    test('forward teleport glides cell-by-cell like a normal move', async ({ page }) => {
        // P0 token0 starts mid-track at position 5.
        await startGame(page, positions({ 0: 5 }));
        await page.locator('#p-0-0').waitFor();

        const target = await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            // Cell the pawn should END on — computed from the module so the
            // test doesn't hard-code the player-0 mark-index mapping.
            const targetCellId = mod.getTokenContainerId(0, 0, 15);
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 15, // 10 cells forward, still on the main track
            });
            return targetCellId;
        });

        // Mid-flight the mover is in the cell-by-cell glide: updateTokenContainer
        // tags the element `data-moving="true"` and drives it with a transform.
        // The old instant-appendChild path never set this — so catching it proves
        // the glide ran rather than a snap.
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('p-0-0').dataset.moving === 'true')
        ).toBe(true);

        // It settles on the correct destination cell with the moving flag cleared.
        await expect.poll(async () =>
            page.evaluate(() => {
                const t = document.getElementById('p-0-0');
                return { cell: t.parentElement.id, moving: t.dataset.moving };
            }),
            { timeout: 6000 }
        ).toEqual({ cell: target, moving: undefined });
    });

    test('backward teleport snaps to the target cell without desync', async ({ page }) => {
        // P0 token0 starts further along at position 15.
        await startGame(page, positions({ 0: 15 }));
        await page.locator('#p-0-0').waitFor();

        const target = await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            const targetCellId = mod.getTokenContainerId(0, 0, 5);
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 5, // backward — no forward path, so it snaps
            });
            return targetCellId;
        });

        // Regression guard: a backward move used to be the only path with no
        // getContainerPath, so routing it through updateTokenContainer would
        // resolve without moving the token (DOM stuck at pos 15 while state
        // says pos 5). It must land on the pos-5 cell.
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('p-0-0').parentElement.id)
        ).toBe(target);
    });
});
