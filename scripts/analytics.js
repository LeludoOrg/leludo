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
 */

import { VERSION } from '../version.js';
import { isCapacitorNative } from './platform.js';

export const GA_MEASUREMENT_ID = 'G-SY4NN1BV58';

let _enabled = false;
let _initialized = false;

function isLocalhost() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1';
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

    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`;
    document.head.appendChild(s);

    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA_MEASUREMENT_ID, {
        send_page_view: false,
        app_version: VERSION,
        platform: isCapacitorNative() ? 'android' : 'web',
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
    });
}

export function trackEvent(name, params) {
    if (!_enabled) return;
    gtag('event', name, { app_version: VERSION, ...(params || {}) });
}
