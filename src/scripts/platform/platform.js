/**
 * Platform detection + Play Store helpers.
 *
 * Single source of truth for "are we inside the Capacitor APK?" — the
 * APK serves the app from https://localhost, so a hostname check alone
 * lies. `window.Capacitor.isNativePlatform()` is injected by the
 * Capacitor runtime only inside the native shell, never in a browser.
 * analytics.js and god-mode.js import isCapacitorNative from here so the
 * three call sites can't drift.
 */

const ANDROID_APP_ID = 'com.leludo.ludo';

// Web listing — works in any browser. market:// opens the Play Store app
// directly when we're already on an Android device.
export const PLAY_STORE_WEB_URL = `https://play.google.com/store/apps/details?id=${ANDROID_APP_ID}`;
export const PLAY_STORE_MARKET_URL = `market://details?id=${ANDROID_APP_ID}`;

export function isCapacitorNative() {
    try {
        return !!window.Capacitor?.isNativePlatform?.();
    } catch {
        return false;
    }
}

export function isAndroidDevice() {
    try {
        return /android/i.test(navigator.userAgent || '');
    } catch {
        return false;
    }
}

/**
 * The Play Store nudge is Android-only: an Android-device web browser
 * (drive installs) OR the installed APK (drive ratings). Desktop / iOS
 * users have no Play Store target, so they never see it.
 */
export function shouldShowStoreNudge() {
    return isCapacitorNative() || isAndroidDevice();
}

/**
 * Open the Play Store listing. Inside the APK prefer the market:// deep
 * link (opens the native Play Store straight to the listing); fall back
 * to the https listing if that scheme isn't handled.
 */
export function openPlayStore() {
    const url = isCapacitorNative() ? PLAY_STORE_MARKET_URL : PLAY_STORE_WEB_URL;
    try {
        const win = window.open(url, '_blank', 'noopener');
        if (!win && isCapacitorNative()) window.location.href = PLAY_STORE_WEB_URL;
    } catch {
        window.location.href = PLAY_STORE_WEB_URL;
    }
}
