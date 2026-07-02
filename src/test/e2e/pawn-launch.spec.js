import { test, expect } from '@playwright/test';
import { startGame as bootGame } from './helpers.js';

/**
 * Launch start-FX regression tests.
 *
 * Originally: the dead playPawnLaunch overlay function tested the full leap
 * (anticipation/crouch/leap/land keyframes, ghost trail, landing "GO!" chip).
 * That entire path is now replaced by the LIVE implementation:
 * updateTokenContainer's yard→entry branch calls playYardLaunch, which triggers
 * playLaunchStartFX (halo + sparks burst) + playPawnStep (the shared hop).
 *
 * The assertions below guard the LIVE path:
 * 1. The launch burst (halo + sparks) renders during yard→entry movement.
 * 2. The token lands in the entry cell with visibility restored.
 * 3. The yard seat remains visible (not hidden by the overlay).
 */

test.describe('Pawn launch start-FX', () => {
    test('keeps yard seat ring visible while the launch overlay plays', async ({ page }) => {
        // Start a normal game; positions default to all-in-yard.
        await bootGame(page, '?player=0');
        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();
        await page.locator('#h-0-0').waitFor();

        // Fire the same code path normal play uses for yard → entry. We
        // dispatch GOD_TELEPORT so the test stays deterministic (no
        // dependency on rolling a 6). godTeleport routes the move through
        // updateTokenContainer, whose yard → entry branch calls playYardLaunch.
        await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 0,
            });
        });

        // Mid-flight: the live token is hidden (overlay is playing) but
        // the seat ring must STAY visible. Pre-fix the seat was force-
        // hidden here, blinking the launch spot out of the yard.
        await expect.poll(async () =>
            page.evaluate(() => {
                const token = document.getElementById('p-0-0');
                const seat = document.getElementById('h-0-0');
                return {
                    tokenHidden: token.style.visibility === 'hidden',
                    seatHidden: seat.style.visibility === 'hidden',
                };
            })
        ).toEqual({ tokenHidden: true, seatHidden: false });

        // Once the overlay resolves the token is reparented out of its
        // yard seat onto the track (a `m<idx>` cell). We don't pin the
        // exact cell — play continues after the launch, so the pawn may
        // step further — only that it left the yard.
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('p-0-0').parentElement.id),
            { timeout: 5000 }
        ).toMatch(/^m\d+$/);

        // The vacated seat is still present (never force-hidden) — this
        // is the actual regression: the launch spot must not blink out.
        const seatVisibility = await page.evaluate(
            () => document.getElementById('h-0-0').style.visibility
        );
        expect(seatVisibility).not.toBe('hidden');
    });

    test('renders launch burst (halo + sparks) during yard-to-entry movement', async ({ page }) => {
        // Guard the LIVE launch-start-FX burst that plays during yard→entry
        // pawn movement. The burst is a halo glow + upward sparks fan that
        // render via playLaunchStartFX in render-logic.js, called by playYardLaunch.
        // This test verifies the FX root and its child elements mount and
        // animate during the move.
        await bootGame(page, '?player=0');
        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();
        await page.locator('#h-0-0').waitFor();

        // Trigger yard→entry via GOD_TELEPORT (same as test 1) and check
        // that the FX overlay root exists with halo + sparks during the move.
        const fxState = await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            mod.dispatch({
                type: mod.COMMANDS.GOD_TELEPORT,
                playerIndex: 0,
                tokenIndex: 0,
                toPosition: 0,
            });
            // Poll briefly to catch the FX while it's active.
            return new Promise((resolve) => {
                const start = Date.now();
                const check = () => {
                    const root = document.querySelector('.plnch-root');
                    const halo = document.querySelector('.plnch-halo');
                    const sparks = Array.from(document.querySelectorAll('.plnch-spark'));
                    const found = {
                        rootExists: !!root,
                        haloExists: !!halo,
                        sparkCount: sparks.length,
                    };
                    if (found.rootExists && found.sparkCount > 0 && Date.now() - start < 500) {
                        // FX is active now; resolve immediately.
                        resolve(found);
                    } else if (Date.now() - start < 500) {
                        // Not yet; retry.
                        requestAnimationFrame(check);
                    } else {
                        // Timeout; resolve with what we have (should have caught it by now).
                        resolve(found);
                    }
                };
                check();
            });
        });

        // Verify the FX rendered: root, halo, and at least one spark.
        expect(fxState.rootExists).toBe(true);
        expect(fxState.haloExists).toBe(true);
        expect(fxState.sparkCount).toBeGreaterThan(0);

        // After the move completes, the token should be in the entry cell
        // with visibility restored (the FX overlay is cleaned up).
        await expect.poll(async () =>
            page.evaluate(() => document.getElementById('p-0-0').parentElement.id),
            { timeout: 5000 }
        ).toMatch(/^m\d+$/);

        const finalToken = await page.evaluate(() => {
            const token = document.getElementById('p-0-0');
            return {
                parentId: token.parentElement.id,
                visibility: token.style.visibility || 'inherited',
            };
        });
        // Token should be in a track cell (m<idx>) and visibility restored
        // (not 'hidden'; either explicitly '', or inherited from parent).
        expect(finalToken.parentId).toMatch(/^m\d+$/);
        expect(finalToken.visibility).not.toBe('hidden');
    });
});
