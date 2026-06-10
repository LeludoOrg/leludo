import { test, expect } from '@playwright/test';

// Regression: pausing the game while a dice-roll / token-move animation was
// in flight could permanently freeze the game on resume.
//
// Root cause: the reducer used to swap state.phase to 'PAUSED' on GAME_PAUSED
// (stashing the pre-pause phase) and restore that snapshot on
// GAME_RESUMED_FROM_PAUSE. Animations are NOT pause-aware — an animation that
// completes DURING the pause emits its follow-up event
// (MOVABLE_TOKENS_DETERMINED / TURN_ADVANCED / TURN_REPEATS) which legitimately
// advances phase. Restoring the stale snapshot on resume rewound phase back to
// ROLLING/ANIMATING, a state the bot listener's resumeAutoplay cannot act on —
// so the bot never took its next action and the game was stuck (or only
// unblockable by the human clicking for the bot).
//
// Fix: pause/resume never touch state.phase. Pause is enforced solely by the
// scheduler's _paused flag + the isGameLogicPaused() guards; phase always
// reflects the true game state so resumeAutoplay re-derives the right action.
//
// This test drives a real all-bot game (auto-plays end to end), then pauses
// at the most dangerous moment — while an animation is in flight — and waits
// long enough for that animation to complete during the pause. After resume
// the game MUST keep advancing. Several cycles run to exercise the race at
// roll time and at move time.

async function startAllBotGame(page) {
    await page.goto('/');
    await page.locator('.new-game-btn').click();
    await expect(page.locator('.start-btn')).toBeVisible();
    // Seat 0 defaults to Human — flip it to Bot so the whole game auto-plays.
    await page.locator('.seat-row:first-child [data-half="BOT"]').click();
    await page.locator('.start-btn').click();
    await expect(page.locator('wc-board')).not.toHaveClass(/hidden/);
}

test.describe('Pause / resume during animation', () => {
    test('all-bot game keeps progressing after pausing mid-animation', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

        await startAllBotGame(page);

        // Confirm it really is auto-playing before we start interfering.
        await expect.poll(
            () => page.evaluate(async () => (await import('/scripts/index.js')).state.turnCount),
            { timeout: 10000 },
        ).toBeGreaterThan(0);

        for (let cycle = 0; cycle < 6; cycle++) {
            // Wait until an animation is actually in flight (ROLLING or
            // ANIMATING) — that's the only moment the old bug could trigger.
            await expect.poll(
                () => page.evaluate(async () => {
                    const m = await import('/scripts/index.js');
                    if (m.isGameLogicPaused()) return null;
                    return m.state.phase;
                }),
                { timeout: 10000, intervals: [15, 15, 15] },
            ).toMatch(/ROLLING|ANIMATING/);

            const turnBefore = await page.evaluate(async () =>
                (await import('/scripts/index.js')).state.turnCount);

            // Pause now (mirrors the pause button → COMMANDS.PAUSE path).
            await page.evaluate(async () => {
                const m = await import('/scripts/index.js');
                m.dispatch({ type: m.COMMANDS.PAUSE });
            });

            // Hold the pause long enough that the in-flight animation finishes
            // DURING the pause and emits its (dropped) follow-up event — the
            // precise condition that used to corrupt phase on resume.
            await page.waitForTimeout(1200);

            // Resume (mirrors closing the pause overlay → RESUME path; both
            // surfaces emit GAME_RESUMED_FROM_PAUSE through the same reducer).
            await page.evaluate(async () => {
                const m = await import('/scripts/index.js');
                m.dispatch({ type: m.COMMANDS.RESUME });
            });

            // The decisive assertion: the bot must take its next turn. Under
            // the bug, turnCount froze here forever. Generous timeout so a
            // legitimately slow animation never flakes this.
            await expect.poll(
                () => page.evaluate(async () =>
                    (await import('/scripts/index.js')).state.turnCount),
                { timeout: 15000 },
            ).toBeGreaterThan(turnBefore);
        }

        expect(errors, `Console / page errors:\n${errors.join('\n')}`).toEqual([]);
    });
});
