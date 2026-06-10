import { describe, it, expect, afterEach, vi } from 'vitest';
import { detectPlatform } from '../../scripts/platform/analytics.js';

const originalMatchMedia = window.matchMedia;

afterEach(() => {
    if (originalMatchMedia === undefined) delete window.matchMedia;
    else window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
});

function mockDisplayMode(mode) {
    window.matchMedia = (query) => ({
        matches: query.includes(`display-mode: ${mode}`),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
    });
}

describe('detectPlatform — Capacitor native', () => {
    // The APK serves the app from https://localhost, so a hostname-only
    // check would mislabel it as a dev session. Capacitor wins regardless
    // of host.
    it('tags Play Store APK as android/play_store no matter the host', () => {
        expect(detectPlatform({ hostname: 'localhost', native: true })).toMatchObject({
            platform: 'android',
            source: 'play_store',
        });
        expect(detectPlatform({ hostname: 'leludo.org', native: true })).toMatchObject({
            platform: 'android',
            source: 'play_store',
        });
    });
});

describe('detectPlatform — third-party embed hosts', () => {
    // itch.io serves HTML5 builds from CDN hosts that change over time,
    // so we match on a pattern (.itch.zone / .hwcdn.net) rather than the
    // current domain — keeps the source dimension stable across itch's
    // infra moves.
    it('tags itch CDN hosts as web/itch', () => {
        const hosts = [
            'html-classic.itch.zone',
            'v6p9d9t4.ssl.hwcdn.net',
            'giddu.itch.io',
        ];
        for (const hostname of hosts) {
            expect(detectPlatform({ hostname, native: false })).toMatchObject({
                platform: 'web',
                source: 'itch',
            });
        }
    });
    it('tags CrazyGames, Poki, GameJolt, Newgrounds, Y8, Kongregate', () => {
        const cases = [
            ['www.crazygames.com', 'crazygames'],
            ['games.poki.com', 'poki'],
            ['m.gamejolt.com', 'gamejolt'],
            ['www.newgrounds.com', 'newgrounds'],
            ['www.y8.com', 'y8'],
            ['www.kongregate.com', 'kongregate'],
        ];
        for (const [hostname, expected] of cases) {
            expect(detectPlatform({ hostname, native: false })).toMatchObject({
                platform: 'web',
                source: expected,
            });
        }
    });
});

describe('detectPlatform — leludo.org', () => {
    it('tags plain leludo.org as web/leludo_org', () => {
        expect(detectPlatform({
            hostname: 'leludo.org',
            native: false,
            inIframe: false,
            displayMode: 'browser',
        })).toMatchObject({ platform: 'web', source: 'leludo_org' });
    });
    // PWA install bumps display-mode to standalone — distinct dimension
    // so we can tell installed users apart from one-shot browser visits.
    it('tags installed PWA as web/pwa when display-mode is standalone', () => {
        expect(detectPlatform({
            hostname: 'leludo.org',
            native: false,
            inIframe: false,
            displayMode: 'standalone',
        })).toMatchObject({ platform: 'web', source: 'pwa', display_mode: 'standalone' });
    });
    it('tags www.leludo.org the same as leludo.org', () => {
        expect(detectPlatform({
            hostname: 'www.leludo.org',
            native: false,
        })).toMatchObject({ source: 'leludo_org' });
    });
});

describe('detectPlatform — unknown hosts', () => {
    // Unknown iframe = something embedded us we haven't catalogued yet.
    // Tag it as embed_other so we can see total embedded traffic without
    // a per-host filter; top-level unknown traffic stays as web_other.
    it('tags an unknown iframe host as web/embed_other', () => {
        expect(detectPlatform({
            hostname: 'some.unknown-portal.io',
            native: false,
            inIframe: true,
        })).toMatchObject({ platform: 'web', source: 'embed_other', embedded: 'yes' });
    });
    it('tags an unknown top-level host as web/web_other', () => {
        expect(detectPlatform({
            hostname: 'some.unknown-host.io',
            native: false,
            inIframe: false,
        })).toMatchObject({ platform: 'web', source: 'web_other', embedded: 'no' });
    });
    it('tags localhost (no Capacitor) as web/dev', () => {
        expect(detectPlatform({
            hostname: 'localhost',
            native: false,
        })).toMatchObject({ platform: 'web', source: 'dev' });
    });
});

describe('detectPlatform — shape', () => {
    // Every event ships the same four-field shape so GA's custom
    // dimensions can rely on them being present.
    it('always returns platform / source / display_mode / embedded', () => {
        const result = detectPlatform({
            hostname: 'leludo.org',
            native: false,
            inIframe: false,
            displayMode: 'browser',
        });
        expect(Object.keys(result).sort()).toEqual([
            'display_mode',
            'embedded',
            'platform',
            'source',
        ]);
    });
});

describe('detectPlatform — display_mode detection without injection', () => {
    // Real-environment path: detectPlatform reads window.matchMedia for
    // display-mode when not given displayMode explicitly. Verify the
    // fallback works so production calls don't silently default to
    // 'browser'.
    it('picks standalone when matchMedia reports it', () => {
        mockDisplayMode('standalone');
        const result = detectPlatform({
            hostname: 'leludo.org',
            native: false,
            inIframe: false,
        });
        expect(result.display_mode).toBe('standalone');
        expect(result.source).toBe('pwa');
    });
    it('falls back to browser when matchMedia reports nothing', () => {
        mockDisplayMode('none');
        const result = detectPlatform({
            hostname: 'leludo.org',
            native: false,
            inIframe: false,
        });
        expect(result.display_mode).toBe('browser');
        expect(result.source).toBe('leludo_org');
    });
});
