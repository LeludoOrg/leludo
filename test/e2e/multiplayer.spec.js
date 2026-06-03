import { test, expect } from '@playwright/test';

/**
 * Server-authoritative multiplayer — end-to-end across two browser contexts.
 *
 * Drives the dev harness (multiplayer.html) for two isolated clients joining one
 * room against the Node ws server (server/local-server.mjs, started by Playwright
 * with DEV_TEST_HOOKS). Guards three properties that define "the server is the
 * single source of truth":
 *   1. Both clients always render the SAME server board (no client-side state).
 *   2. A roll from the player whose turn it is NOT is rejected, state unchanged.
 *   3. A client that the AdmissionDO refuses gets the friendly busy overlay.
 *
 * Dice are seeded (seed=7) so runs are deterministic and repeatable.
 */

async function snap(page) {
    const [positions, phase, current, dice, legal] = await Promise.all([
        page.getByTestId('mp-positions').textContent(),
        page.getByTestId('mp-phase').textContent(),
        page.getByTestId('mp-current-player').textContent(),
        page.getByTestId('mp-dice').textContent(),
        page.getByTestId('mp-legal').textContent(),
    ]);
    return { positions, phase, current: Number(current), dice, legal: JSON.parse(legal || '[]') };
}

const sig = (s) => `${s.positions}|${s.phase}|${s.current}|${s.dice}`;

test.describe('Multiplayer — server authority', () => {
    test('two clients in one room stay in lockstep, reject out-of-turn, end consistently', async ({ browser }) => {
        const room = `R-${Math.random().toString(36).slice(2, 8)}`;
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const pageA = await ctxA.newPage();
        const pageB = await ctxB.newPage();

        await pageA.goto(`/multiplayer.html?room=${room}&session=sa&name=Alice&humans=2&seed=7`);
        await pageB.goto(`/multiplayer.html?room=${room}&session=sb&name=Bob&humans=2&seed=7`);

        // Both seated; the host (first to join) starts the game manually.
        await expect(pageA.getByTestId('mp-seat')).not.toHaveText('—');
        await expect(pageB.getByTestId('mp-seat')).not.toHaveText('—');
        const host = (await pageA.getByTestId('mp-is-host').textContent()) === 'true' ? pageA : pageB;
        await host.getByTestId('mp-start').click();
        await expect(pageA.getByTestId('mp-started')).toHaveText('true');
        await expect(pageB.getByTestId('mp-started')).toHaveText('true');

        const seatA = Number(await pageA.getByTestId('mp-seat').textContent());
        const seatB = Number(await pageB.getByTestId('mp-seat').textContent());
        expect(new Set([seatA, seatB])).toEqual(new Set([0, 1]));

        // --- (2) Authority: opening turn is AWAIT_ROLL for the first seat. The
        // OTHER client tries to roll and is rejected; the board does not move.
        const opening = await snap(pageA);
        expect(opening.phase).toBe('AWAIT_ROLL');
        const nonCurrent = opening.current === seatA ? pageB : pageA;
        const boardBefore = opening.positions;
        await nonCurrent.getByTestId('mp-roll').click();
        await expect(nonCurrent.getByTestId('mp-rejected')).toHaveText('NOT_YOUR_TURN');
        expect((await snap(pageA)).positions).toBe(boardBefore);

        // --- (1) Play several plies; after each action both clients must render
        // an identical server board.
        for (let i = 0; i < 16; i++) {
            const s = await snap(pageA);
            if (s.phase === 'ENDED') break;

            const actor = s.current === seatA ? pageA : pageB;
            const before = sig(s);
            if (s.phase === 'AWAIT_ROLL') {
                await actor.getByTestId('mp-roll').click();
            } else if (s.phase === 'AWAIT_MOVE') {
                await actor.getByTestId(`mp-move-${s.legal[0]}`).click();
            } else {
                break;
            }

            // Wait for the server broadcast to land on the acting client...
            await expect.poll(async () => sig(await snap(pageA)), { timeout: 5000 }).not.toBe(before);
            // ...then assert BOTH clients converged to the same board.
            await expect.poll(async () => (await snap(pageB)).positions, { timeout: 5000 })
                .toBe((await snap(pageA)).positions);
        }

        await ctxA.close();
        await ctxB.close();
    });

    test('a client refused by the admission gate sees the busy overlay', async ({ page }) => {
        // __busy__ is a DEV_TEST_HOOKS-only room the server always refuses, so the
        // overlay path is exercised deterministically and parallel-safe.
        await page.goto('/multiplayer.html?room=__busy__&session=sc&name=Carol');
        await expect(page.getByTestId('mp-busy')).toBeVisible();
        await expect(page.getByTestId('mp-busy-reason')).toHaveText('BUSY_CONCURRENT');
    });
});
