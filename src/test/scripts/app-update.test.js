import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// initAppUpdate captures the loaded bundle hash + wires listeners at import,
// so each test does its DOM/fetch setup THEN imports a fresh copy.
async function freshInit() {
    vi.resetModules();
    const mod = await import('../../scripts/platform/app-update.js');
    return mod.initAppUpdate;
}

const originalCapacitor = window.Capacitor;

// updateAvailability / installStatus codes mirrored from the plugin enums.
const UPDATE_AVAILABLE = 2;
const UPDATE_IN_PROGRESS = 3;
const UPDATE_NOT_AVAILABLE = 1;
const DOWNLOADED = 11;

const CHECK_KEY = 'leludo-update-check-at';
const PROMPT_KEY = 'leludo-update-prompt-at';

function mockNative(info, overrides = {}) {
    const AppUpdate = {
        getAppUpdateInfo: vi.fn().mockResolvedValue(info),
        startFlexibleUpdate: vi.fn().mockResolvedValue({ code: 0 }),
        completeFlexibleUpdate: vi.fn().mockResolvedValue(undefined),
        addListener: vi.fn().mockResolvedValue({ remove() {} }),
        ...overrides,
    };
    window.Capacitor = { isNativePlatform: () => true, Plugins: { AppUpdate } };
    return AppUpdate;
}

// Make the module capture `name` as the loaded bundle (the prod case). Stubs
// document.scripts rather than appending a real <script src>, which happy-dom
// would try to fetch. Absent stub = dev, where the web check no-ops.
function setLoadedBundle(name) {
    vi.spyOn(document, 'scripts', 'get').mockReturnValue([{ src: `/${name}` }]);
}

function mockIndexHtml(bundleName) {
    const fn = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(`<script src="/${bundleName}"></script>`) });
    vi.stubGlobal('fetch', fn);
    return fn;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    localStorage.clear();
    delete window.Capacitor; // default: a plain web browser
});

afterEach(() => {
    if (originalCapacitor === undefined) delete window.Capacitor;
    else window.Capacitor = originalCapacitor;
    localStorage.clear();
    document.getElementById('update-toast')?.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('initAppUpdate — Android (Play In-App Update)', () => {
    it('starts a flexible update when one is available', async () => {
        const AppUpdate = mockNative({ updateAvailability: UPDATE_AVAILABLE, flexibleUpdateAllowed: true });
        await (await freshInit())();
        expect(AppUpdate.startFlexibleUpdate).toHaveBeenCalledTimes(1);
        // Listener wired so the restart prompt fires once Play finishes downloading.
        expect(AppUpdate.addListener).toHaveBeenCalledWith('onFlexibleUpdateStateChange', expect.any(Function));
    });

    it('does nothing when no update is available', async () => {
        const AppUpdate = mockNative({ updateAvailability: UPDATE_NOT_AVAILABLE });
        await (await freshInit())();
        expect(AppUpdate.startFlexibleUpdate).not.toHaveBeenCalled();
    });

    it('skips when only an immediate (blocking) update is allowed', async () => {
        // High-priority releases may forbid flexible; never yank a player into
        // a fullscreen update on launch.
        const AppUpdate = mockNative({ updateAvailability: UPDATE_AVAILABLE, flexibleUpdateAllowed: false, immediateUpdateAllowed: true });
        await (await freshInit())();
        expect(AppUpdate.startFlexibleUpdate).not.toHaveBeenCalled();
    });

    it('does not re-pop the consent sheet within the 24h window', async () => {
        localStorage.setItem(PROMPT_KEY, String(Date.now()));
        const AppUpdate = mockNative({ updateAvailability: UPDATE_AVAILABLE, flexibleUpdateAllowed: true });
        await (await freshInit())();
        expect(AppUpdate.startFlexibleUpdate).not.toHaveBeenCalled();
    });

    it('completes a download already in progress without re-consenting', async () => {
        // Resume after the download finished in the background.
        const AppUpdate = mockNative({ updateAvailability: UPDATE_IN_PROGRESS, installStatus: DOWNLOADED });
        await (await freshInit())();
        expect(AppUpdate.startFlexibleUpdate).not.toHaveBeenCalled();
        expect(AppUpdate.completeFlexibleUpdate).toHaveBeenCalled();
    });

    it('fires the restart prompt when the download finishes', async () => {
        let stateCb;
        const AppUpdate = mockNative(
            { updateAvailability: UPDATE_AVAILABLE, flexibleUpdateAllowed: true },
            { addListener: vi.fn().mockImplementation((_e, cb) => { stateCb = cb; return Promise.resolve({ remove() {} }); }) },
        );
        await (await freshInit())();
        expect(AppUpdate.completeFlexibleUpdate).not.toHaveBeenCalled();
        stateCb({ installStatus: DOWNLOADED });
        expect(AppUpdate.completeFlexibleUpdate).toHaveBeenCalledTimes(1);
    });

    it('swallows plugin errors so boot is never broken', async () => {
        mockNative({}, { getAppUpdateInfo: vi.fn().mockRejectedValue(new Error('Play offline')) });
        await expect((await freshInit())()).resolves.toBeUndefined();
    });

    it('no-op when the plugin is absent in the native shell', async () => {
        window.Capacitor = { isNativePlatform: () => true, Plugins: {} };
        await expect((await freshInit())()).resolves.toBeUndefined();
    });
});

describe('initAppUpdate — web (hashed-bundle drift)', () => {
    it('shows a refresh toast when the deployed bundle hash changed', async () => {
        setLoadedBundle('app.aaaa1111.js');
        mockIndexHtml('app.bbbb2222.js'); // new deploy
        await (await freshInit())();
        await tick();
        expect(document.getElementById('update-toast')).not.toBeNull();
    });

    it('no toast when the deployed bundle is unchanged', async () => {
        setLoadedBundle('app.aaaa1111.js');
        mockIndexHtml('app.aaaa1111.js'); // same build
        await (await freshInit())();
        await tick();
        expect(document.getElementById('update-toast')).toBeNull();
    });

    it('no-op in dev where there is no hashed bundle to compare', async () => {
        // No setLoadedBundle → module captures null → index.html is never fetched.
        const fetchFn = mockIndexHtml('app.bbbb2222.js');
        await (await freshInit())();
        await tick();
        expect(fetchFn).not.toHaveBeenCalled();
        expect(document.getElementById('update-toast')).toBeNull();
    });
});

describe('initAppUpdate — check throttle + resume', () => {
    it('skips the check when one ran within the RECHECK window', async () => {
        localStorage.setItem(CHECK_KEY, String(Date.now()));
        const AppUpdate = mockNative({ updateAvailability: UPDATE_AVAILABLE, flexibleUpdateAllowed: true });
        await (await freshInit())();
        expect(AppUpdate.getAppUpdateInfo).not.toHaveBeenCalled();
    });

    it('re-checks on foreground once the throttle has lapsed', async () => {
        // Capture the foreground handler instead of dispatching, so accumulated
        // cross-test listeners can't interfere.
        const handlers = {};
        vi.spyOn(window, 'addEventListener').mockImplementation((t, h) => { handlers[t] = h; });
        vi.spyOn(document, 'addEventListener').mockImplementation((t, h) => { handlers[t] = h; });

        const AppUpdate = mockNative({ updateAvailability: UPDATE_NOT_AVAILABLE });
        await (await freshInit())();
        expect(AppUpdate.getAppUpdateInfo).toHaveBeenCalledTimes(1);

        // Within the window: a resume must NOT re-query Play.
        handlers.focus();
        await tick();
        expect(AppUpdate.getAppUpdateInfo).toHaveBeenCalledTimes(1);

        // Throttle lapsed: the next resume re-checks.
        localStorage.removeItem(CHECK_KEY);
        handlers.focus();
        await tick();
        expect(AppUpdate.getAppUpdateInfo).toHaveBeenCalledTimes(2);
    });
});
