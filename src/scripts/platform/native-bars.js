/**
 * Native system-bar theming (Android edge-to-edge).
 *
 * Under edge-to-edge the WebView draws behind the status bar and navigation
 * bar; the @capawesome edge-to-edge plugin paints those bar *areas* a solid
 * color so content scrolling under them stays legible. The plugin's config
 * color is a single static value (`#EFE9DC`, the Paper background) — so in the
 * Dusk/dark theme the bars stayed light and read as mismatched edges around a
 * dark app. This module repaints the bars to the *active theme's* background
 * at runtime, and flips the bar icon contrast to match.
 *
 * Both plugins are reached through the `window.Capacitor.Plugins` globals
 * (same as app-update / nav-history) rather than bare `@capawesome` / core
 * imports — the bundler-free dev server can't resolve those specifiers, and
 * the packages are only present in the native shell anyway. Web is a no-op.
 *
 * Every path is wrapped: bar theming must never break boot or a theme switch.
 */
import { isCapacitorNative } from './platform.js';

function edgeToEdge() {
    try { return window.Capacitor?.Plugins?.EdgeToEdge || null; } catch { return null; }
}

function systemBars() {
    try { return window.Capacitor?.Plugins?.SystemBars || null; } catch { return null; }
}

// Our own MainActivity plugin (see SystemChromePlugin.java) — paints the
// window background so the left/right cutout strips the edge-to-edge plugin
// leaves unpainted (the landscape notch area) match the theme instead of black.
function systemChrome() {
    try { return window.Capacitor?.Plugins?.SystemChrome || null; } catch { return null; }
}

// Resolve --color-bg (a raw `hsl(...)` token) to the `#rrggbb` the plugins
// want by letting the browser compute it: a hidden probe inherits the var as
// a color, which getComputedStyle reports back as `rgb(r, g, b)`.
// Shared with theme-chrome.js for browser chrome (meta tag) theming.
export function themeBackgroundHex() {
    const host = document.body || document.documentElement;
    if (!host) return null;
    const probe = document.createElement('span');
    probe.style.cssText = 'color:var(--color-bg);position:absolute;width:0;height:0;opacity:0;pointer-events:none';
    host.appendChild(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    const m = rgb.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return null;
    const hex = n => Number(n).toString(16).padStart(2, '0');
    return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
}

/**
 * Repaint the Android status + navigation bars to match the active theme.
 * No-op off the native shell. Safe to call repeatedly (boot, theme switch,
 * OS dark-mode flip).
 */
export async function applyNativeBarTheme() {
    if (!isCapacitorNative()) return;
    const e2e = edgeToEdge();
    if (!e2e) return;

    const color = themeBackgroundHex();
    if (!color) return;

    // Dark theme → dark bars need light icons (SystemBars style DARK); light
    // theme → light bars need dark icons (style LIGHT). Mirrors the plugin's
    // own README example (Dark style paired with a dark color, and vice versa).
    const isDark = document.documentElement.classList.contains('dark');
    try {
        const bars = systemBars();
        if (bars?.setStyle) await bars.setStyle({ style: isDark ? 'DARK' : 'LIGHT' });
        if (e2e.setStatusBarColor) await e2e.setStatusBarColor({ color });
        if (e2e.setNavigationBarColor) await e2e.setNavigationBarColor({ color });
        // Older plugin builds only expose the combined setter.
        else if (e2e.setBackgroundColor) await e2e.setBackgroundColor({ color });
        // The edge-to-edge plugin paints only the top/bottom inset strips, so
        // the left/right cutout strip in landscape stays the (black) window
        // background — paint that too so the notch area matches the theme.
        const chrome = systemChrome();
        if (chrome?.setBackgroundColor) await chrome.setBackgroundColor({ color });
    } catch { /* bar theming is cosmetic — never throw into boot/theme paths */ }
}

/**
 * Wire up bar theming: paint once on boot, and re-paint when the OS color
 * scheme flips (covers the 'system' theme following Android dark mode while
 * the app is open). Per-user theme picks repaint via wc-settings' updateTheme.
 */
export function initNativeBars() {
    if (!isCapacitorNative()) return;
    applyNativeBarTheme();
    try {
        window.matchMedia?.('(prefers-color-scheme: dark)')
            .addEventListener?.('change', () => applyNativeBarTheme());
    } catch { /* matchMedia unavailable — boot paint still applied */ }
}
