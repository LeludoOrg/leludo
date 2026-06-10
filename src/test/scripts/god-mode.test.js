import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isGodModeAvailable } from '../../scripts/state/god-mode.js';

describe('isGodModeAvailable', () => {
    let originalHostname;
    let originalCapacitor;

    beforeEach(() => {
        originalHostname = window.location.hostname;
        originalCapacitor = window.Capacitor;
    });

    afterEach(() => {
        if (originalHostname !== window.location.hostname) {
            window.history.replaceState(null, '', `http://${originalHostname}/`);
        }
        if (originalCapacitor === undefined) {
            delete window.Capacitor;
        } else {
            window.Capacitor = originalCapacitor;
        }
    });

    it('returns true on localhost in a plain browser', () => {
        expect(isGodModeAvailable()).toBe(true);
    });

    // Capacitor's Android WebView reports location.hostname === 'localhost',
    // so the prior pure-hostname gate let god-mode appear inside the shipped
    // APK. The native-platform check must short-circuit before the hostname
    // branch — otherwise users see a Debug toggle in production.
    it('returns false when running inside the Capacitor native shell', () => {
        window.Capacitor = { isNativePlatform: () => true };
        expect(isGodModeAvailable()).toBe(false);
    });

    it('returns true when window.Capacitor exists but isNativePlatform is falsy', () => {
        // Some Capacitor versions inject a partial shim in browser context;
        // god-mode should only hide when the native-platform check is true.
        window.Capacitor = { isNativePlatform: () => false };
        expect(isGodModeAvailable()).toBe(true);
    });
});
