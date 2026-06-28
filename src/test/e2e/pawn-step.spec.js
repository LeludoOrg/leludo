import { test, expect } from '@playwright/test';
import { startGame, positions } from './helpers.js';

/**
 * Regression for the pawn-step (hop-and-skip) movement overlay.
 *
 * Feature (0.29.0): in-turn cell-to-cell advancement no longer does a flat
 * CSS-transition slide. updateTokenContainer hides the live token and plays an
 * energetic hopping copy via playPawnStep (a sibling of the launch / capture /
 * arrival overlays), then commits the cell and reveals the token. This guards:
 *   1. The hop overlay (.pstep-root) actually mounts mid-move — i.e. movement
 *      routes through the overlay, not the old inline transform glide.
 *   2. The overlay paints the REAL shared pawn glyph (0 0 100 116 viewBox), so
 *      the hopping pawn matches the on-board token instead of a placeholder.
 *   3. The token still settles on the correct destination cell, flag cleared.
 */

test.describe('Pawn step (hop) movement overlay', () => {
    test('a forward move plays the hop overlay with the real pawn, then settles', async ({ page }) => {
        // P0 token0 mid-track at position 5; teleport routes through the same
        // updateTokenContainer path normal play uses (deterministic — no roll).
        await startGame(page, positions({ 0: 5 }));
        await page.locator('#p-0-0').waitFor();

        const target = await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            const targetCellId = mod.getTokenContainerId(0, 0, 12);
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 12, // 7 cells forward, all on the main track
            });
            return targetCellId;
        });

        // Mid-flight: the hop overlay is mounted on the board and the live token
        // is hidden while its hopping copy plays. The old slide never created a
        // .pstep-root, so catching it proves the hop overlay drove the move.
        await expect.poll(async () =>
            page.evaluate(() => {
                const root = document.querySelector('.board-wrap .pstep-root');
                if (!root) return null;
                const svg = root.querySelector('.pstep-pawn-svg');
                return {
                    tokenHidden: document.getElementById('p-0-0').style.visibility === 'hidden',
                    viewBox: svg && svg.getAttribute('viewBox'),
                };
            })
        ).toEqual({ tokenHidden: true, viewBox: '0 0 100 116' });

        // Settles on the correct cell, overlay gone, moving flag cleared, token
        // revealed.
        await expect.poll(async () =>
            page.evaluate(() => {
                const t = document.getElementById('p-0-0');
                return {
                    cell: t.parentElement.id,
                    moving: t.dataset.moving,
                    overlay: !!document.querySelector('.pstep-root'),
                    hidden: t.style.visibility === 'hidden',
                };
            }),
            { timeout: 6000 }
        ).toEqual({ cell: target, moving: undefined, overlay: false, hidden: false });
    });
});
