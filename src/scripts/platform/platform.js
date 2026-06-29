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

import { STORAGE_KEYS } from './storage-keys.js';

const ANDROID_APP_ID = 'com.leludo.ludo';

// Minimum gap between native review-sheet requests. Google's In-App Review
// API quota-caps how often the sheet actually appears (usually a silent
// no-op), so calling it on literally every game end is wasteful — this keeps
// us to one polite ask per window. Tune freely; Play still has the final say.
const REVIEW_COOLDOWN_MS = 1000 * 60 * 60 * 24 * 3; // 3 days

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
 * The recap store-nudge card is for Android *web* only — an Android-device
 * browser, where it drives installs. The installed APK no longer shows the
 * card: it gets the passive native review sheet instead (see
 * requestAppReview), so a tap-to-rate button would be redundant. Desktop /
 * iOS have no Play Store target and never see it.
 */
export function shouldShowStoreNudge() {
    return isAndroidDevice() && !isCapacitorNative();
}

/**
 * Passively request an in-app review (installed Android APK only). Google's
 * In-App Review API floats a native rating sheet over the app — no exit, no
 * custom pre-prompt. It silently no-ops when Play's quota is spent, so there
 * is no "was it shown?" signal and nothing to fall back to. Fire-and-forget;
 * web / desktop / iOS are skipped. A local cooldown keeps us from pinging the
 * API on every single game end.
 */
export async function requestAppReview() {
    if (!isCapacitorNative()) return;
    try {
        const last = Number(localStorage.getItem(STORAGE_KEYS.REVIEW_PROMPT_AT) || 0);
        if (last > 0 && Date.now() - last < REVIEW_COOLDOWN_MS) return;
    } catch { /* storage blocked — fall through and just ask */ }
    const review = window.Capacitor?.Plugins?.AppReview;
    if (!review?.requestReview) return;
    try { localStorage.setItem(STORAGE_KEYS.REVIEW_PROMPT_AT, String(Date.now())); } catch { /* ignore */ }
    try { await review.requestReview(); } catch { /* quota / unavailable — silent by design */ }
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
