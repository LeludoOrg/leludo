// Regression coverage for the end-of-game share routing.
//
// Original symptom: the Share button worked in a mobile browser but did nothing
// inside the Android APK. The recap shared only via the Web Share API
// (navigator.share) with an <a download> fallback — both are absent / no-ops in
// Capacitor's Android WebView, so the button silently dead-ended. The fix routes
// native builds through the Capacitor Share plugin (writing the PNG to the cache
// dir via Filesystem first). These tests pin that routing so it can't regress
// back to the browser-only path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({ native: false }));
vi.mock('../../../scripts/platform/platform.js', () => ({ isCapacitorNative: () => h.native }));

import { shareGameEnd } from '../../../scripts/render/share-image.js';

const HIGHLIGHTS = [{ playerIndex: 0, title: 'KO king', body: 'most captures', stat: '3' }];

// A 2d-context stand-in: every drawing call is a no-op, gradients answer the
// addColorStop calls buildShareImage makes. happy-dom has no real canvas.
function fakeCtx() {
    return new Proxy({}, {
        get(_t, prop) {
            if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
                return () => ({ addColorStop() {} });
            }
            return () => {};
        },
    });
}

function setNavigatorShare(value) {
    Object.defineProperty(globalThis.navigator, 'share', { value, configurable: true, writable: true });
}
function setNavigatorCanShare(value) {
    Object.defineProperty(globalThis.navigator, 'canShare', { value, configurable: true, writable: true });
}

let shareMock, writeFileMock;

beforeEach(() => {
    h.native = false;

    // Make buildShareImage resolve to a real Blob without a real canvas/Image.
    vi.stubGlobal('Image', class {
        set src(_v) { Promise.resolve().then(() => this.onload && this.onload()); }
    });
    globalThis.URL.createObjectURL = () => 'blob:fake';
    globalThis.URL.revokeObjectURL = () => {};
    HTMLCanvasElement.prototype.getContext = () => fakeCtx();
    HTMLCanvasElement.prototype.toBlob = function toBlob(cb) { cb(new Blob(['png'], { type: 'image/png' })); };

    shareMock = vi.fn(() => Promise.resolve());
    writeFileMock = vi.fn(() => Promise.resolve({ uri: 'file:///cache/leludo-result.png' }));
    window.Capacitor = {
        isNativePlatform: () => h.native,
        Plugins: { Share: { share: shareMock }, Filesystem: { writeFile: writeFileMock } },
    };

    setNavigatorShare(vi.fn(() => Promise.resolve()));
    setNavigatorCanShare(vi.fn(() => true));
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete window.Capacitor;
});

describe('shareGameEnd native routing', () => {
    it('inside the APK, shares the PNG file via the Capacitor Share plugin, not navigator.share', async () => {
        h.native = true;

        await shareGameEnd(0, 'Red wins!', HIGHLIGHTS);

        // PNG written to the cache dir, then handed to the OS sheet as a file URI.
        expect(writeFileMock).toHaveBeenCalledTimes(1);
        expect(writeFileMock.mock.calls[0][0]).toMatchObject({ directory: 'CACHE', path: 'leludo-result.png' });
        expect(shareMock).toHaveBeenCalledTimes(1);
        expect(shareMock.mock.calls[0][0]).toMatchObject({ files: ['file:///cache/leludo-result.png'] });
        // The dead-in-WebView browser path must never run on native.
        expect(navigator.share).not.toHaveBeenCalled();
    });

    it('on native, a user-cancelled share is a clean exit (no fallback to text or download)', async () => {
        h.native = true;
        shareMock.mockRejectedValueOnce(new Error('Share canceled'));

        await expect(shareGameEnd(0, 'Red wins!', HIGHLIGHTS)).resolves.toBeUndefined();

        expect(shareMock).toHaveBeenCalledTimes(1); // not retried as text-only
        expect(navigator.share).not.toHaveBeenCalled();
    });

    it('on native with the plugin un-synced, falls through to the web share path', async () => {
        h.native = true;
        window.Capacitor.Plugins.Share = undefined; // plugin missing on this build

        await shareGameEnd(0, 'Red wins!', HIGHLIGHTS);

        expect(navigator.share).toHaveBeenCalledTimes(1); // web path still attempted
    });

    it('on the web, uses the Web Share API and never touches the Capacitor plugin', async () => {
        h.native = false;

        await shareGameEnd(0, 'Red wins!', HIGHLIGHTS);

        expect(navigator.share).toHaveBeenCalledTimes(1);
        expect(shareMock).not.toHaveBeenCalled();
        expect(writeFileMock).not.toHaveBeenCalled();
    });
});
