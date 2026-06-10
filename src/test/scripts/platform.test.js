import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    isCapacitorNative,
    isAndroidDevice,
    shouldShowStoreNudge,
    openPlayStore,
    PLAY_STORE_WEB_URL,
    PLAY_STORE_MARKET_URL,
} from '../../scripts/platform.js';

const originalCapacitor = window.Capacitor;
const realUA = navigator.userAgent;

function setUA(ua) {
    Object.defineProperty(navigator, 'userAgent', { value: ua, configurable: true });
}

afterEach(() => {
    if (originalCapacitor === undefined) delete window.Capacitor;
    else window.Capacitor = originalCapacitor;
    setUA(realUA);
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
    // The recap store nudge is Android-only: Android browser (drive installs)
    // or the installed APK (drive ratings). Desktop / iOS must never see it.
    it('true on an Android browser', () => {
        delete window.Capacitor;
        setUA('Mozilla/5.0 (Linux; Android 13; Pixel 7)');
        expect(shouldShowStoreNudge()).toBe(true);
    });
    it('true inside the native APK regardless of UA', () => {
        window.Capacitor = { isNativePlatform: () => true };
        setUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
        expect(shouldShowStoreNudge()).toBe(true);
    });
    it('false on desktop / iOS browsers', () => {
        delete window.Capacitor;
        setUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)');
        expect(shouldShowStoreNudge()).toBe(false);
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
