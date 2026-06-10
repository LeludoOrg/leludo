/**
 * Google Analytics 4 wrapper.
 *
 * Loads gtag dynamically and exposes a tiny screen/event API the rest of
 * the codebase calls. Single chokepoint so we can mock in tests, swap
 * the underlying provider, or kill it with one flag.
 *
 * Gate: skip when running on localhost (dev) UNLESS we're inside a
 * Capacitor webview — the APK serves the app from https://localhost so
 * we DO want analytics there. `window.Capacitor.isNativePlatform()` is
 * the official detector.
 *
 * Every event carries a small `detectPlatform()` payload so reports can
 * slice traffic by where the build is actually running (Play Store APK,
 * leludo.org, installed PWA, itch.io embed, other portals, unknown
 * iframe, etc.) without having to filter on the iframe-host URL after
 * the fact.
 */

import { VERSION } from '../../version.js';
import { isCapacitorNative } from './platform.js';

export const GA_MEASUREMENT_ID = 'G-SY4NN1BV58';

// Known third-party hosts the HTML5 build can be embedded on. Add new
// portals here as we publish to them — keeping the source dimension a
// closed set keeps GA reports clean. Patterns match the *embed* host,
// not the parent storefront (e.g. itch.io serves embeds from CDN hosts
// like html-classic.itch.zone and v6p9d9t4.ssl.hwcdn.net).
// Host → source lookup table. Ordered: first matching `patterns` entry
// wins, so keep it specific-first if patterns ever overlap. `source` is
// either a literal string or a fn(mode) for hosts whose source depends on
// the display mode (leludo.org → leludo_org vs installed pwa).
const HOST_SOURCES = [
    { patterns: [/\.itch\.zone$/i, /\.hwcdn\.net$/i, /\.itch\.io$/i], source: 'itch' },
    { patterns: [/\.crazygames\.com$/i], source: 'crazygames' },
    { patterns: [/\.poki\.com$/i, /\.poki-gdn\.com$/i], source: 'poki' },
    { patterns: [/\.gamejolt\.com$/i, /\.gamejolt\.net$/i, /\.gamejolt\.io$/i], source: 'gamejolt' },
    { patterns: [/\.newgrounds\.com$/i, /\.ngfiles\.com$/i], source: 'newgrounds' },
    { patterns: [/\.y8\.com$/i], source: 'y8' },
    { patterns: [/\.kongregate\.com$/i, /\.konggames\.com$/i], source: 'kongregate' },
    { patterns: [/^leludo\.org$/i, /^www\.leludo\.org$/i], source: (mode) => (mode === 'standalone' ? 'pwa' : 'leludo_org') },
];

let _enabled = false;
let _initialized = false;
let _platformInfo = null;

function isLocalhost(host) {
    const h = host ?? (typeof location !== 'undefined' ? location.hostname : '');
    return h === 'localhost' || h === '127.0.0.1' || h === '';
}

function matchHost(host, patterns) {
    return patterns.some((re) => re.test(host));
}

/**
 * Shared payload every GA call spreads in: app version + the resolved
 * platform info. Kept in one place so config/trackScreen/trackEvent stay
 * in sync.
 */
function baseParams() {
    return { app_version: VERSION, ...(_platformInfo || {}) };
}

function detectDisplayMode() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'browser';
    try {
        if (window.matchMedia('(display-mode: standalone)').matches) return 'standalone';
        if (window.matchMedia('(display-mode: fullscreen)').matches) return 'fullscreen';
        if (window.matchMedia('(display-mode: minimal-ui)').matches) return 'minimal-ui';
    } catch {
        // matchMedia can throw in some webviews — fall through to browser.
    }
    return 'browser';
}

function detectIframe() {
    if (typeof window === 'undefined') return false;
    try {
        return window.self !== window.top;
    } catch {
        // Cross-origin access to window.top throws — that itself means
        // we're inside an iframe owned by a different origin.
        return true;
    }
}

/**
 * Resolve where the build is currently running. Accepts injectable
 * signals for tests; production callers pass nothing and the helper
 * reads the real environment.
 */
export function detectPlatform({ hostname, native, inIframe, displayMode } = {}) {
    if (typeof window === 'undefined' && hostname === undefined && native === undefined) {
        return { platform: 'web', source: 'unknown', display_mode: 'browser', embedded: 'no' };
    }
    const host = hostname ?? (typeof location !== 'undefined' ? location.hostname || '' : '');
    const isNative = native ?? isCapacitorNative();
    const iframe = inIframe ?? detectIframe();
    const mode = displayMode ?? detectDisplayMode();

    let platform = 'web';
    let source = 'web_other';

    if (isNative) {
        platform = 'android';
        source = 'play_store';
    } else {
        const hit = HOST_SOURCES.find((entry) => matchHost(host, entry.patterns));
        if (hit) {
            source = typeof hit.source === 'function' ? hit.source(mode) : hit.source;
        } else if (isLocalhost(host)) {
            // Native already handled above, so a non-native localhost is a dev session.
            source = 'dev';
        } else if (iframe) {
            source = 'embed_other';
        }
    }

    return {
        platform,
        source,
        display_mode: mode,
        embedded: iframe ? 'yes' : 'no',
    };
}

export function isAnalyticsEnabled() {
    if (typeof window === 'undefined') return false;
    if (!GA_MEASUREMENT_ID || GA_MEASUREMENT_ID.includes('XXXX')) return false;
    if (isLocalhost() && !isCapacitorNative()) return false;
    return true;
}

function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
}

export function initAnalytics() {
    if (_initialized) return;
    _initialized = true;

    if (!isAnalyticsEnabled()) return;
    _enabled = true;
    _platformInfo = detectPlatform();

    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(s);

    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, {
        send_page_view: false,
        ...baseParams(),
        transport_type: 'beacon',
    });
}

export function trackScreen(name) {
    if (!_enabled) return;
    gtag('event', 'page_view', {
        page_title: name,
        page_path: `/${name}`,
        page_location: `${location.origin}/${name}`,
        ...baseParams(),
    });
}

export function trackEvent(name, params) {
    if (!_enabled) return;
    gtag('event', name, {
        ...baseParams(),
        ...(params || {}),
    });
}
