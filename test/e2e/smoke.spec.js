import { test, expect } from '@playwright/test';

test.describe('Home screen', () => {
    test('renders title and New game button', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });

        await page.goto('/');

        const title = page.locator('wc-quick-start h1.home-title').first();
        await expect(title).toContainText('le');
        await expect(title).toContainText('ludo');

        const newGameBtn = page.locator('.new-game-btn');
        await expect(newGameBtn).toBeVisible();
        await expect(newGameBtn).toContainText('New game');

        expect(errors, `Console / page errors: ${errors.join('\n')}`).toHaveLength(0);
    });

    test('clicking New game opens setup screen', async ({ page }) => {
        await page.goto('/');
        await page.locator('.new-game-btn').click();
        await expect(page.locator('.start-btn')).toBeVisible();
        await expect(page.locator('.start-btn')).toContainText(/start|play/i);
    });
});

test.describe('Static pages', () => {
    test('privacy page loads', async ({ page }) => {
        await page.goto('/privacy.html');
        await expect(page).toHaveTitle(/privacy/i);
        await expect(page.locator('h1, h2').first()).toBeVisible();
    });

    test('changelog page loads', async ({ page }) => {
        await page.goto('/changelog.html');
        await expect(page).toHaveTitle(/changelog|changes|release/i);
        await expect(page.locator('article').first()).toBeVisible();
    });
});

test.describe('PWA manifest', () => {
    test('manifest.json is valid JSON with required fields', async ({ request }) => {
        const res = await request.get('/manifest.json');
        expect(res.ok()).toBe(true);
        const manifest = await res.json();
        expect(manifest.name).toBeTruthy();
        expect(manifest.start_url).toBeTruthy();
        expect(Array.isArray(manifest.icons)).toBe(true);
        expect(manifest.icons.length).toBeGreaterThan(0);
    });
});

test.describe('Game start (URL overrides)', () => {
    test('positions+player override puts a player one move from winning', async ({ page }) => {
        // 4 humans, P0's first token at 55 (one away from finishing), P0 starts.
        // Smoke-tests handleGameStart override path without scripted gameplay.
        const positions = '55,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1';
        await page.goto(`/?positions=${positions}&player=0`);
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        // Board should be visible (not hidden).
        await expect(page.locator('wc-board')).not.toHaveClass(/hidden/);
    });

    test('overridden tokens land in target container immediately (no init animation race)', async ({ page }) => {
        // Regression: handleGameStart used to fire-and-forget an animated
        // updateTokenContainer for each ?positions= override, leaving tokens
        // in their home cell while subsequent state mutations ran.
        // After fix, init-position tokens are appended directly to their
        // target container with no animation in flight.
        const positions = '50,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1';
        await page.goto(`/?positions=${positions}&player=0`);
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        const token = page.locator('#p-0-0');
        await expect(token).toBeVisible();
        const parentId = await token.evaluate(el => el.parentElement?.id);
        // Pos 50 → main-track mark cell, not the home pocket h-0-0.
        expect(parentId).not.toBe('h-0-0');
        expect(parentId).toMatch(/^(m\d+|p\ds\d)$/);
    });

    // Regression: selectToken used to wrap its body in try/finally calling
    // releaseInputLock(), but that helper was removed during the
    // event-sourced refactor. Bot autoplay reliably triggered
    // "ReferenceError: releaseInputLock is not defined" every time a bot
    // selected a token. Phase machine gates input now — no helper needed.
    test('bot autoplay runs without ReferenceError in selectToken', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', msg => {
            if (msg.type() === 'error') errors.push(msg.text());
        });

        // Bot 1 starts with a token already on track so the first roll has
        // movable tokens → bot autoplay flows through selectToken.
        const positions = '-1,-1,-1,-1,20,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1,-1';
        await page.goto(`/?positions=${positions}&player=1`);
        await page.locator('.new-game-btn').click();
        await page.locator('.start-btn').click();
        await expect(page.locator('wc-board')).not.toHaveClass(/hidden/);

        await page.waitForTimeout(3500);

        const lockErrors = errors.filter(e => e.includes('releaseInputLock'));
        expect(lockErrors, `releaseInputLock errors: ${lockErrors.join('\n')}`).toHaveLength(0);
    });
});
