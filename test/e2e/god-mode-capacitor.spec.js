import { test, expect } from '@playwright/test';

// Regression: Capacitor's Android WebView serves the app from
// https://localhost, which used to slip past the location.hostname-only
// gate in scripts/god-mode.js and let the Debug section appear inside
// the settings overlay in the shipped APK. The gate now also checks
// window.Capacitor.isNativePlatform(); this test injects the same
// runtime shim the Capacitor native shell provides and asserts the
// Debug toggle stays hidden.

test.describe('God mode gate (Capacitor)', () => {

    test('Debug section hidden when window.Capacitor.isNativePlatform() === true', async ({ page }) => {
        await page.addInitScript(() => {
            window.Capacitor = { isNativePlatform: () => true };
        });
        await page.goto('/');
        await page.locator('wc-settings #settings-icon').first().click();
        await expect(page.locator('#settings-overlay')).not.toHaveClass(/hidden/);

        // The Debug section was rendered as a settings group whose label is
        // exactly "Debug (localhost only)". With the Capacitor stub in place
        // it must not appear at all.
        await expect(page.getByText('Debug (localhost only)')).toHaveCount(0);
        await expect(page.locator('#s-god-mode')).toHaveCount(0);
    });

    test('Debug section visible on plain localhost (sanity check)', async ({ page }) => {
        await page.goto('/');
        await page.locator('wc-settings #settings-icon').first().click();
        await expect(page.locator('#settings-overlay')).not.toHaveClass(/hidden/);

        await expect(page.getByText('Debug (localhost only)')).toBeVisible();
        await expect(page.locator('#s-god-mode')).toHaveCount(1);
    });
});
