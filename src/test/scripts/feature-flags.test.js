import { describe, it, expect, beforeEach } from 'vitest';
import {
    isOnlineHostAllowed,
    isOnlineAvailable,
    isOnlineEnabled,
    setOnlineEnabled,
} from '../../scripts/platform/feature-flags.js';
import { STORAGE_KEYS } from '../../scripts/platform/storage-keys.js';

// Online multiplayer ships to main behind this flag: visible on dev + the
// isolated beta site, hidden on the production website and the APK, so unfinished
// work never reaches real users. These guard that contract.
describe('online feature flag', () => {
    describe('isOnlineHostAllowed (pure host policy)', () => {
        it('blocks the production website', () => {
            expect(isOnlineHostAllowed('leludo.org')).toBe(false);
            expect(isOnlineHostAllowed('www.leludo.org')).toBe(false);
        });

        it('allows dev, beta, and preview hosts', () => {
            for (const h of ['localhost', '127.0.0.1', 'beta.leludo.org', 'leludo-mp.workers.dev']) {
                expect(isOnlineHostAllowed(h)).toBe(true);
            }
        });
    });

    describe('availability + toggle (happy-dom host is localhost)', () => {
        beforeEach(() => {
            localStorage.removeItem(STORAGE_KEYS.ONLINE_FLAG);
            setOnlineEnabled(true);
        });

        it('is available off-production and on by default', () => {
            expect(isOnlineAvailable()).toBe(true);
            localStorage.removeItem(STORAGE_KEYS.ONLINE_FLAG);
            // No persisted value → default ON wherever available.
            expect(isOnlineEnabled()).toBe(true);
        });

        it('persists the toggle through localStorage', () => {
            setOnlineEnabled(false);
            expect(isOnlineEnabled()).toBe(false);
            expect(localStorage.getItem(STORAGE_KEYS.ONLINE_FLAG)).toBe('false');

            setOnlineEnabled(true);
            expect(isOnlineEnabled()).toBe(true);
            expect(localStorage.getItem(STORAGE_KEYS.ONLINE_FLAG)).toBe('true');
        });
    });
});
