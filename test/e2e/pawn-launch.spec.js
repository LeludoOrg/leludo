import { test, expect } from '@playwright/test';

/**
 * Regression for pawn-launch overlay.
 *
 * Bug: when a pawn left the yard via the launch animation,
 * playYardLaunch hid the whole source seat (`h-<player>-<token>`, the
 * `.home-slot-dot`) for the duration of the overlay. The seat — the
 * spot the pawn launched from — blinked out for ~1.2s and only
 * reappeared (as an empty ring) when the promise resolved.
 *
 * Fix: hide ONLY the live token during the overlay and leave the seat
 * dot visible. The empty ring is exactly how the seat should look once
 * the pawn has launched, so it reads as "vacated" throughout the leap
 * instead of disappearing and snapping back.
 *
 * The assertion below would have failed against the pre-fix code:
 * during the animation `h-0-0`'s inline visibility was `hidden`.
 *
 * Second bug, second assertion: the landing "GO!" chip had
 * `background: currentColor` AND `color: #1a1410` on the same rule,
 * so `currentColor` on the chip resolved to its OWN dark color, not
 * the player color flowing down from `.plnch-label`. The chip
 * rendered as a dark "rounded square" at the entry cell. Fix uses a
 * custom property `--plnch-chip-bg` set on the parent so the player
 * color reaches the chip background.
 */

test.describe('Pawn launch overlay', () => {
    test('keeps yard seat ring visible while the launch overlay plays', async ({ page }) => {
        // Start a normal game; positions default to all-in-yard.
        await page.goto('/?player=0');
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await expect(page.locator('wc-board:not(.hidden)')).toBeVisible();
        await page.locator('#h-0-0').waitFor();

        // Fire the same code path normal play uses for yard → entry. We
        // dispatch GOD_TELEPORT so the test stays deterministic (no
        // dependency on rolling a 6). The launch branch in godTeleport
        // routes through playYardLaunch, identical to updateTokenContainer.
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

    test('landing GO! chip uses player color for the pill, not the dark text color', async ({ page }) => {
        // Drive a real playPawnLaunch so the module's CSS gets injected
        // and the chip is constructed by playLandingFX. We sample the
        // chip ~85% through the run — past the landing phase, before
        // the overlay DOM is cleaned up. Pre-fix the chip rendered as a
        // dark pill (bg #1a1410) because `background: currentColor`
        // resolved against the chip's own `color: #1a1410`.
        await page.goto('/');
        const colors = await page.evaluate(async () => {
            const mod = await import('/scripts/pawn-launch.js');
            const root = document.createElement('div');
            root.style.cssText = 'position: fixed; inset: 0;';
            document.body.appendChild(root);
            const PLAYER = '#cf4a3a';
            const DURATION = 1000;
            const p = mod.playPawnLaunch({
                container: root,
                yard: { x: 100, y: 100 },
                entry: { x: 200, y: 200 },
                color: PLAYER,
                pawnSize: 48,
                duration: DURATION,
            });
            // Sample at 85% — chip is already mounted and animating.
            await new Promise(r => setTimeout(r, Math.round(DURATION * 0.85)));
            const chip = root.querySelector('.plnch-label-chip');
            const cs = chip ? getComputedStyle(chip) : null;
            const out = chip ? { bg: cs.backgroundColor, color: cs.color } : { bg: null, color: null };
            await p;
            root.remove();
            return out;
        });

        // Player color = #cf4a3a → rgb(207, 74, 58).
        expect(colors.bg).toBe('rgb(207, 74, 58)');
        // Text stays dark for readability.
        expect(colors.color).toBe('rgb(26, 20, 16)');
    });

    test('launch pawn uses the real wc-token shape, square and at cell size', async ({ page }) => {
        // Bug: the launch overlay drew a DIFFERENT pawn than the game.
        // It used a chess-pawn path in a 60x80 viewBox at 0.75 aspect and
        // 1.4x cell size, so the leaping pawn neither matched the on-board
        // token's shape nor its size/position at the yard/entry endpoints.
        // Fix: the overlay reuses wc-token's body path in a square 100x100
        // viewBox, sized to one cell. These assertions pin both.
        await page.goto('/');
        const pawn = await page.evaluate(async () => {
            const mod = await import('/scripts/pawn-launch.js');
            const root = document.createElement('div');
            root.style.cssText = 'position: fixed; inset: 0;';
            document.body.appendChild(root);
            const CELL = 40;
            const p = mod.playPawnLaunch({
                container: root,
                yard: { x: 100, y: 100 },
                entry: { x: 200, y: 200 },
                color: '#cf4a3a',
                pawnSize: CELL,
                duration: 800,
                label: '',
            });
            await new Promise(r => setTimeout(r, 60));
            const svg = root.querySelector('.plnch-pawn-svg');
            const out = {
                viewBox: svg.getAttribute('viewBox'),
                width: svg.getAttribute('width'),
                height: svg.getAttribute('height'),
                // The token body path lives in components/wc-token.js; the
                // overlay must render the same outline.
                hasTokenBody: !!svg.querySelector(
                    'path[d="M32 85 Q30 70 36 55 Q40 45 42 38 L58 38 Q60 45 64 55 Q70 70 68 85 Z"]'
                ),
            };
            await p;
            root.remove();
            return out;
        });

        expect(pawn.viewBox).toBe('0 0 100 100');
        // Square — matches the wc-token SVG aspect (a token fills one cell).
        expect(pawn.width).toBe(pawn.height);
        // Sized to the passed cell size, not scaled up.
        expect(pawn.width).toBe('40');
        expect(pawn.hasTokenBody).toBe(true);
    });
});
