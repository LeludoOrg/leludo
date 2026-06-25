/**
 * Synchronous theme bootstrap — single source of truth, shared by index.html,
 * privacy.html and changelog.html. Loaded as a classic (non-module, non-defer)
 * <script> in <head> so the resolved theme class lands on <html> before first
 * paint, preventing a light-before-dark flash on reload.
 *
 * Shipped to www/ by build-www.mjs and loaded by all three HTML pages.
 */
(function () {
    var stored = localStorage.getItem('theme') || 'system';
    var resolved = stored === 'system'
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : stored;
    document.documentElement.classList.add(resolved);
})();
