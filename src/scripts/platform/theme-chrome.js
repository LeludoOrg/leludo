/**
 * Browser-chrome theming: keep <meta name="theme-color"> (the web browser's
 * UI tint) in sync with the active theme's background. The Android system
 * bars are handled separately by native-bars.js (applyNativeBarTheme) — this
 * module owns only the meta tag, so the two never double-drive each other.
 */
import { themeBackgroundHex } from './native-bars.js';

/** Write the meta theme-color from the resolved --color-bg. Call after any
 *  theme flip or when leaving a surface that overrode the meta. Safe when the
 *  meta or DOM is absent (headless tests). */
export function applyThemeColorMeta() {
    try {
        const meta = document.querySelector('meta[name="theme-color"]');
        if (!meta) return;
        const hex = themeBackgroundHex();
        if (hex) meta.setAttribute('content', hex);
    } catch { /* theming is cosmetic — never throw */ }
}
