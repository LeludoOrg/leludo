import { test, expect } from '@playwright/test';

/**
 * Regression for face-to-face board rotation (0.30.0).
 *
 * Player feedback: two people sharing one phone read the board upside-down. A
 * local game with exactly two humans on opposite halves now spins the
 * .board-rotor (corner plates + board) 180° each turn so it always faces whoever
 * is rolling. This guards, end-to-end in a real game:
 *   1. The rotor wraps the corner rows + board and carries the rotation var.
 *   2. A top-half opener (P0) flips the board 180°; a bottom-half opener (P2)
 *      leaves it at 0°. Human openers don't auto-advance (auto-roll defaults
 *      off), so the opening orientation is deterministic.
 *   3. A solo game (one human vs bots) never rotates — no regression for the
 *      single-player / default board.
 */

// Boot a local game, optionally turning extra seats human, with `player` opening.
async function boot(page, { humanSeats = [], player } = {}) {
    const query = player != null ? `/?player=${player}` : '/';
    await page.goto(query);
    await page.locator('.new-game-btn').click();
    await expect(page.locator('.start-btn')).toBeVisible();
    for (const idx of humanSeats) {
        await page.locator(`.seat-row[data-seat-idx="${idx}"] [data-half="PLAYER"]`).click();
    }
    await page.locator('.start-btn').click();
    await page.locator('wc-board:not(.hidden)').waitFor();
}

function rotorDeg(page) {
    return page.evaluate(() => {
        const rotor = document.querySelector('wc-board .board-rotor');
        return rotor ? rotor.style.getPropertyValue('--board-rot') : 'NO_ROTOR';
    });
}

test.describe('Face-to-face board rotation', () => {
    test('the rotor wraps the corner rows and the board', async ({ page }) => {
        await boot(page, { humanSeats: [2], player: 2 });
        const wraps = await page.evaluate(() => {
            const rotor = document.querySelector('wc-board .board-rotor');
            return {
                hasTop: !!rotor.querySelector('#corner-row-top'),
                hasBoard: !!rotor.querySelector('.board-wrap'),
                hasBottom: !!rotor.querySelector('#corner-row-bottom'),
            };
        });
        expect(wraps).toEqual({ hasTop: true, hasBoard: true, hasBottom: true });
    });

    test('a top-half opener (P0) flips the board 180°', async ({ page }) => {
        // Humans on seats 0 (top-left) and 2 (bottom-right); P0 opens.
        await boot(page, { humanSeats: [2], player: 0 });
        await expect.poll(() => rotorDeg(page)).toBe('180deg');
    });

    test('a bottom-half opener (P2) leaves the board at 0°', async ({ page }) => {
        await boot(page, { humanSeats: [2], player: 2 });
        await expect.poll(() => rotorDeg(page)).toBe('0deg');
    });

    test('a solo game (one human vs bots) never rotates', async ({ page }) => {
        await boot(page, { player: 0 });
        // P0 is the only human; the board must stay un-rotated regardless of turn.
        await expect.poll(() => rotorDeg(page)).toBe('0deg');
    });

    test('a pawn move lands on the correct cell while the board is flipped 180°', async ({ page }) => {
        // The real risk: overlay/FLIP math measures cells in viewport space, so a
        // rotated board must still settle the mover on its true destination. P0
        // (top-half) flips the board 180°; teleport its token 7 cells forward and
        // confirm it parents into the right cell, not a mirror-image wrong one.
        await page.goto('/?player=0&positions=5,,,,,,,,,,,,,,,');
        await page.locator('.new-game-btn').click();
        await expect(page.locator('.start-btn')).toBeVisible();
        await page.locator('.seat-row[data-seat-idx="2"] [data-half="PLAYER"]').click();
        await page.locator('.start-btn').click();
        await page.locator('wc-board:not(.hidden)').waitFor();
        await expect.poll(() => rotorDeg(page)).toBe('180deg');

        const target = await page.evaluate(async () => {
            const mod = await import('/scripts/index.js');
            const id = mod.getTokenContainerId(0, 0, 12);
            mod.dispatch({ type: mod.COMMANDS.GOD_TELEPORT, playerIndex: 0, tokenIndex: 0, toPosition: 12 });
            return id;
        });

        await expect.poll(() =>
            page.evaluate(() => {
                const t = document.getElementById('p-0-0');
                return { cell: t.parentElement.id, moving: t.dataset.moving, hidden: t.style.visibility === 'hidden' };
            }), { timeout: 6000 }
        ).toEqual({ cell: target, moving: undefined, hidden: false });
    });
});
