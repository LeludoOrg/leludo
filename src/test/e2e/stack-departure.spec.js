import { test, expect } from '@playwright/test';
import { startGame, positions } from './helpers.js';

/**
 * Regression for stacked-pawn departure.
 *
 * Bug: when two pawns shared a cell and one moved out, updateTokenContainer
 * left the mover in the cell's flow (position:relative) at full size while it
 * glided. updateCellStacking's `n <= 1` branch left the lone survivor in flow
 * too — so the cell held two full-size flow <wc-token> blocks and the survivor
 * was shoved one cell DOWN for the duration of the glide. (It self-corrected
 * once the mover was finally reparented out, so the displacement is only
 * visible mid-glide — hence the test samples while the mover is still moving.)
 *
 * Fix: the mover is pinned position:absolute (out of flow) for the whole glide,
 * so the survivor reflows as the sole occupant. updateCellStacking also FLIP-
 * animates the survivors into their new layout, which keeps them inside the
 * cell box throughout. Larger stacks (3, 4) were already absolutely positioned,
 * so this also guards that the new animated path doesn't misplace them.
 */

test.describe('Stacked-pawn departure', () => {
    for (const stackSize of [2, 3, 4]) {
        test(`survivors stay inside the cell while a pawn leaves a ${stackSize}-stack`, async ({ page }) => {
            // Put `stackSize` of P0's pawns on the same mid-track square (pos 5).
            const list = {};
            for (let i = 0; i < stackSize; i++) list[i] = 5;
            await startGame(page, positions(list));
            await page.locator('#p-0-0').waitFor();

            // Teleport pawn 0 far forward (pos 25) so the glide is long enough
            // to sample mid-flight before it lands and the cell self-corrects.
            const sourceCellId = await page.evaluate(async () => {
                const mod = await import('/scripts/index.js');
                const cellId = mod.getTokenContainerId(0, 0, 5);
                mod.dispatch({
                    type: mod.COMMANDS.GOD_TELEPORT,
                    playerIndex: 0,
                    tokenIndex: 0,
                    toPosition: 25,
                });
                return cellId;
            });

            // Wait until the mover is actually gliding (lifted out of the cell).
            await page.waitForFunction(
                () => document.getElementById('p-0-0').dataset.moving === 'true'
            );

            // Mid-glide: the mover is still travelling AND every survivor's centre
            // sits inside the source cell. Pre-fix the survivor centre dropped a
            // full cell below the source square, so `inside` was false here.
            const survivorIds = [];
            for (let i = 1; i < stackSize; i++) survivorIds.push(`p-0-${i}`);

            const sample = await page.evaluate(({ cellId, ids }) => {
                const cell = document.getElementById(cellId).getBoundingClientRect();
                const moving = document.getElementById('p-0-0').dataset.moving === 'true';
                const inside = ids.map((id) => {
                    const r = document.getElementById(id).getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    return cx >= cell.left - 1 && cx <= cell.right + 1
                        && cy >= cell.top - 1 && cy <= cell.bottom + 1;
                });
                return { moving, inside };
            }, { cellId: sourceCellId, ids: survivorIds });

            expect(sample.moving).toBe(true);
            expect(sample.inside).toEqual(survivorIds.map(() => true));

            // And once the mover lands, the survivors are still inside the cell.
            await expect.poll(async () =>
                page.evaluate(() => document.getElementById('p-0-0').dataset.moving),
                { timeout: 6000 }
            ).toBe(undefined);

            const settled = await page.evaluate(({ cellId, ids }) => {
                const cell = document.getElementById(cellId).getBoundingClientRect();
                return ids.map((id) => {
                    const r = document.getElementById(id).getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    return cx >= cell.left - 1 && cx <= cell.right + 1
                        && cy >= cell.top - 1 && cy <= cell.bottom + 1;
                });
            }, { cellId: sourceCellId, ids: survivorIds });

            expect(settled).toEqual(survivorIds.map(() => true));
        });
    }
});
