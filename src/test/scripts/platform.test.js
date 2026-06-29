import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    isCapacitorNative,
    isAndroidDevice,
    shouldShowStoreNudge,
    requestAppReview,
    openPlayStore,
    PLAY_STORE_WEB_URL,
    PLAY_STORE_MARKET_URL,
} from '../../scripts/platform/platform.js';
import { STORAGE_KEYS } from '../../scripts/platform/storage-keys.js';

const originalCapacitor = window.Capacitor;
const realUA = navigator.userAgent;

function setUA(ua) {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

afterEach(() => {
    if (originalCapacitor === undefined) delete window.Capacitor;
    else window.Capacitor = originalCapacitor;
    setUA(realUA);
    localStorage.removeItem(STORAGE_KEYS.REVIEW_PROMPT_AT);
    vi.restoreAllMocks();
});

describe('isCapacitorNative', () => {
    it('false in a plain browser', () => {
        delete window.Capacitor;
        expect(isCapacitorNative()).toBe(false);
    });
    it('true inside the native shell', () => {
        window.Capacitor = { isNativePlatform: () => true };
        expect(isCapacitorNative()).toBe(true);
    });
});

describe('isAndroidDevice', () => {
    it('true for an Android user-agent', () => {
        setUA('Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36');
        expect(isAndroidDevice()).toBe(true);
    });
    it('false for a desktop user-agent', () => {
        setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
        expect(isAndroidDevice()).toBe(false);
    });
});

describe('shouldShowStoreNudge', () => {
    // The recap install-nudge card is Android *web* only (drive installs).
    // The installed APK gets the passive native review sheet instead, so it
    // shows no card. Desktop / iOS must never see it.
    it('true on an Android browser', () => {
        delete window.Capacitor;
        setUA('Mozilla/5.0 (Linux; Android 13; Pixel 7)');
        expect(shouldShowStoreNudge()).toBe(true);
    });
    it('false inside the native APK (it gets the review sheet instead)', () => {
        window.Capacitor = { isNativePlatform: () => true };
        setUA('Mozilla/5.0 (Linux; Android 13; Pixel 7)');
        expect(shouldShowStoreNudge()).toBe(false);
    });
    it('false on desktop / iOS browsers', () => {
        delete window.Capacitor;
        setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
        expect(shouldShowStoreNudge()).toBe(false);
    });
});

describe('requestAppReview', () => {
    // The native In-App Review sheet must fire only inside the APK, only once
    // per cooldown window, and never throw out to the caller (recap render).
    function mockReview() {
        const requestReview = vi.fn().mockResolvedValue(undefined);
        window.Capacitor = { isNativePlatform: () => true, Plugins: { AppReview: { requestReview } } };
        return requestReview;
    }

    it('no-ops in a plain browser (no native plugin)', async () => {
        delete window.Capacitor;
        await requestAppReview(); // must not throw
    });

    it('requests the review sheet and stamps the cooldown inside the APK', async () => {
        const requestReview = mockReview();
        await requestAppReview();
        expect(requestReview).toHaveBeenCalledTimes(1);
        expect(Number(localStorage.getItem(STORAGE_KEYS.REVIEW_PROMPT_AT))).toBeGreaterThan(0);
    });

    it('skips while still inside the cooldown window', async () => {
        const requestReview = mockReview();
        localStorage.setItem(STORAGE_KEYS.REVIEW_PROMPT_AT, String(Date.now()));
        await requestAppReview();
        expect(requestReview).not.toHaveBeenCalled();
    });

    it('swallows a plugin rejection (never throws to the recap)', async () => {
        const requestReview = vi.fn().mockRejectedValue(new Error('quota'));
        window.Capacitor = { isNativePlatform: () => true, Plugins: { AppReview: { requestReview } } };
        await requestAppReview(); // must resolve, not reject
        expect(requestReview).toHaveBeenCalledTimes(1);
    });
});

describe('openPlayStore', () => {
    it('opens the https listing in a browser', () => {
        delete window.Capacitor;
        const spy = vi.spyOn(window, 'open').mockReturnValue({});
        openPlayStore();
        expect(spy).toHaveBeenCalledWith(PLAY_STORE_WEB_URL, '_blank', 'noopener');
    });
    it('opens the market:// deep link inside the APK', () => {
        window.Capacitor = { isNativePlatform: () => true };
        const spy = vi.spyOn(window, 'open').mockReturnValue({});
        openPlayStore();
        expect(spy).toHaveBeenCalledWith(PLAY_STORE_MARKET_URL, '_blank', 'noopener');
    });
});
