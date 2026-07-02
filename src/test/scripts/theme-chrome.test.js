import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { applyThemeColorMeta } from '../../scripts/platform/theme-chrome.js';
import * as nativeBars from '../../scripts/platform/native-bars.js';

describe('applyThemeColorMeta', () => {
    let metaEl;

    beforeEach(() => {
        // Set up a theme-color meta tag for the test
        metaEl = document.createElement('meta');
        metaEl.setAttribute('name', 'theme-color');
        metaEl.setAttribute('content', '#EFE9DC');
        document.head.appendChild(metaEl);
    });

    afterEach(() => {
        // Clean up
        if (metaEl && metaEl.parentElement) {
            metaEl.remove();
        }
        document.documentElement.classList.remove('dark', 'light', 'system');
        document.documentElement.style.removeProperty('--color-bg');
        vi.restoreAllMocks();
    });

    it('updates meta theme-color when meta tag exists and hex is resolvable', () => {
        // Mock themeBackgroundHex to return a known hex value.
        // happy-dom does not fully resolve CSS custom properties from stylesheets,
        // so we mock the native-bars function at the module boundary.
        vi.spyOn(nativeBars, 'themeBackgroundHex').mockReturnValue('#1a1410');

        applyThemeColorMeta();

        expect(metaEl.getAttribute('content')).toBe('#1a1410');
    });

    it('does not throw when meta tag is absent', () => {
        metaEl.remove();
        vi.spyOn(nativeBars, 'themeBackgroundHex').mockReturnValue('#1a1410');

        // Must not throw
        expect(() => applyThemeColorMeta()).not.toThrow();
    });

    it('does not throw when themeBackgroundHex returns null', () => {
        vi.spyOn(nativeBars, 'themeBackgroundHex').mockReturnValue(null);

        // Must not throw
        expect(() => applyThemeColorMeta()).not.toThrow();
        // Meta should remain unchanged
        expect(metaEl.getAttribute('content')).toBe('#EFE9DC');
    });

    it('does not throw if getComputedStyle or DOM access fails', () => {
        vi.spyOn(nativeBars, 'themeBackgroundHex').mockImplementation(() => {
            throw new Error('Unexpected error');
        });

        // Must not throw (caught by the try-catch)
        expect(() => applyThemeColorMeta()).not.toThrow();
    });
});
