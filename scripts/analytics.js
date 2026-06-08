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

import { VERSION } from '../version.js';
import { isCapacitorNative } from './platform.js';

export const GA_MEASUREMENT_ID = 'G-SY4NN1BV58';

// Known third-party hosts the HTML5 build can be embedded on. Add new
// portals here as we publish to them — keeping the source dimension a
// closed set keeps GA reports clean. Patterns match the *embed* host,
// not the parent storefront (e.g. itch.io serves embeds from CDN hosts
// like html-classic.itch.zone and v6p9d9t4.ssl.hwcdn.net).
const ITCH_HOST_PATTERNS = [/\.itch\.zone$/i, /\.hwcdn\.net$/i, /\.itch\.io$/i];
const CRAZYGAMES_HOST_PATTERNS = [/\.crazygames\.com$/i];
const POKI_HOST_PATTERNS = [/\.poki\.com$/i, /\.poki-gdn\.com$/i];
const GAMEJOLT_HOST_PATTERNS = [/\.gamejolt\.com$/i, /\.gamejolt\.net$/i, /\.gamejolt\.io$/i];
const NEWGROUNDS_HOST_PATTERNS = [/\.newgrounds\.com$/i, /\.ngfiles\.com$/i];
const Y8_HOST_PATTERNS = [/\.y8\.com$/i];
const KONGREGATE_HOST_PATTERNS = [/\.kongregate\.com$/i, /\.konggames\.com$/i];
const LELUDO_HOST_PATTERNS = [/^leludo\.org$/i, /^www\.leludo\.org$/i];

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
    } else if (matchHost(host, ITCH_HOST_PATTERNS)) {
        source = 'itch';
    } else if (matchHost(host, CRAZYGAMES_HOST_PATTERNS)) {
        source = 'crazygames';
    } else if (matchHost(host, POKI_HOST_PATTERNS)) {
        source = 'poki';
    } else if (matchHost(host, GAMEJOLT_HOST_PATTERNS)) {
        source = 'gamejolt';
    } else if (matchHost(host, NEWGROUNDS_HOST_PATTERNS)) {
        source = 'newgrounds';
    } else if (matchHost(host, Y8_HOST_PATTERNS)) {
        source = 'y8';
    } else if (matchHost(host, KONGREGATE_HOST_PATTERNS)) {
        source = 'kongregate';
    } else if (matchHost(host, LELUDO_HOST_PATTERNS)) {
        source = mode === 'standalone' ? 'pwa' : 'leludo_org';
    } else if (isLocalhost(host)) {
        source = isNative ? 'play_store' : 'dev';
    } else if (iframe) {
        source = 'embed_other';
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
        app_version: VERSION,
        ..._platformInfo,
        transport_type: 'beacon',
    });
}

export function trackScreen(name) {
    if (!_enabled) return;
    gtag('event', 'page_view', {
        page_title: name,
        page_path: `/${name}`,
        page_location: `${location.origin}/${name}`,
        app_version: VERSION,
        ...(_platformInfo || {}),
    });
}

export function trackEvent(name, params) {
    if (!_enabled) return;
    gtag('event', name, {
        app_version: VERSION,
        ...(_platformInfo || {}),
        ...(params || {}),
    });
}
