/**
 * Update nudge — pushes players onto the latest build sooner than the
 * platform would on its own.
 *
 * Fires on app open AND on every foreground/resume. Resume is the key
 * trigger: Android rarely cold-boots (the WebView survives backgrounding),
 * and a long-lived web tab never reloads — so "returns after a few days,
 * when a new build is most likely waiting" is a resume, not a boot.
 *
 * Two platforms, two mechanisms:
 *
 *  - **Android (Play-installed builds):** Play In-App Update API via the
 *    `@capawesome/capacitor-app-update` plugin. A *flexible* update — Play
 *    downloads the new APK in the background while the player keeps playing,
 *    then surfaces its own "restart to install" prompt. Resume is also the
 *    moment a download started earlier has most likely finished, so we
 *    re-arm the completion prompt every foreground.
 *
 *  - **Web:** the production build content-hashes the JS bundle
 *    (`app.<hash>.js`). We capture the hash this page loaded, then on
 *    resume re-fetch index.html and compare — a new deploy means a new
 *    hash, which surfaces a small "refresh" toast. No version file to keep
 *    in sync (would duplicate VERSION); dev has no hash so the check is a
 *    no-op there.
 *
 * The native plugin is reached through `window.Capacitor.Plugins.AppUpdate`
 * (it auto-registers there, same as nav-history's `Plugins.App`) rather than
 * a bare `@capawesome/...` import — the bundler-free dev server can't resolve
 * a node_modules specifier. The npm package stays a dependency so `cap sync`
 * wires the Android native module + Play Core gradle dep.
 *
 * Every path is wrapped: an update nudge must never break boot or a resume.
 */
import { isCapacitorNative } from './platform.js';
import { STORAGE_KEYS } from './storage-keys.js';

// The plugin's enums as raw values: we reach it via the Capacitor.Plugins
// global, so its exported TS enums aren't importable here.
const UPDATE_AVAILABLE = 2;     // AppUpdateAvailability.UPDATE_AVAILABLE
const UPDATE_IN_PROGRESS = 3;   // AppUpdateAvailability.UPDATE_IN_PROGRESS
const DOWNLOADED = 11;          // FlexibleUpdateInstallStatus.DOWNLOADED

// Foreground flips are frequent — rate-limit the actual check (Play query /
// index.html fetch) so resume doesn't hammer it.
const RECHECK_MS = 4 * 60 * 60 * 1000;
// Don't re-pop the native consent sheet on every check once dismissed.
const REPROMPT_MS = 24 * 60 * 60 * 1000;

// The hashed app bundle this page booted with. null in dev (raw modules, no
// hash) and on any page without one — the web check then no-ops.
const CURRENT_APP_BUNDLE = currentAppBundle();
function currentAppBundle() {
    try {
        for (const s of document.scripts) {
            const m = (s.src || '').match(/app\.[0-9a-f]+\.js/);
            if (m) return m[0];
        }
    } catch { /* no document / scripts */ }
    return null;
}

function plugin() {
    try { return window.Capacitor?.Plugins?.AppUpdate || null; } catch { return null; }
}

function stamp(key) {
    try { localStorage.setItem(key, String(Date.now())); } catch { /* ignore */ }
}

function within(key, ms) {
    try {
        const last = Number(localStorage.getItem(key) || 0);
        return last > 0 && Date.now() - last < ms;
    } catch { return false; }
}

// ---- Android: Play In-App Update -------------------------------------------

// Once Play has the new APK on disk, surface its restart-to-install prompt.
async function completeWhenDownloaded(AppUpdate) {
    await AppUpdate.addListener('onFlexibleUpdateStateChange', (state) => {
        if (state?.installStatus === DOWNLOADED) {
            AppUpdate.completeFlexibleUpdate().catch(() => {});
        }
    });
}

async function nativeCheck() {
    const AppUpdate = plugin();
    if (!AppUpdate) return;
    try {
        const info = await AppUpdate.getAppUpdateInfo();

        // A download already running (often finished while backgrounded):
        // re-arm the completion prompt, complete it if ready, never re-consent.
        if (info?.updateAvailability === UPDATE_IN_PROGRESS) {
            await completeWhenDownloaded(AppUpdate);
            if (info.installStatus === DOWNLOADED) {
                await AppUpdate.completeFlexibleUpdate().catch(() => {});
            }
            return;
        }

        if (info?.updateAvailability !== UPDATE_AVAILABLE) return;
        // High-priority releases may forbid flexible; skip rather than yank a
        // player into a blocking fullscreen update on launch.
        if (!info.flexibleUpdateAllowed) return;
        if (within(STORAGE_KEYS.UPDATE_PROMPT_AT, REPROMPT_MS)) return;

        stamp(STORAGE_KEYS.UPDATE_PROMPT_AT);
        await completeWhenDownloaded(AppUpdate);
        await AppUpdate.startFlexibleUpdate();   // Play's consent sheet, then background download
    } catch {
        // non-Play install / Play API offline — nudge simply doesn't fire
    }
}

// ---- Web: hashed-bundle drift ----------------------------------------------

let _toastShown = false;
function showRefreshToast() {
    if (_toastShown) return;
    try {
        if (document.getElementById('update-toast')) return;
        const bar = document.createElement('div');
        bar.id = 'update-toast';
        bar.className = 'update-toast';
        bar.setAttribute('role', 'status');

        const label = document.createElement('span');
        label.className = 'update-toast-label';
        label.textContent = 'A new version is available';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'update-toast-btn';
        btn.textContent = 'Refresh';
        btn.addEventListener('click', () => { try { location.reload(); } catch { /* ignore */ } });

        bar.append(label, btn);
        document.body.appendChild(bar);
        _toastShown = true;
    } catch { /* no document.body */ }
}

async function webCheck() {
    if (!CURRENT_APP_BUNDLE) return;   // dev / no hashed bundle to compare
    try {
        const res = await fetch('index.html', { cache: 'no-store' });
        if (!res.ok) return;
        const html = await res.text();
        const m = html.match(/app\.[0-9a-f]+\.js/);
        if (m && m[0] !== CURRENT_APP_BUNDLE) showRefreshToast();
    } catch { /* offline / fetch blocked — try again next resume */ }
}

// ---- Orchestration ----------------------------------------------------------

async function runCheck() {
    if (within(STORAGE_KEYS.UPDATE_CHECK_AT, RECHECK_MS)) return;
    stamp(STORAGE_KEYS.UPDATE_CHECK_AT);
    if (isCapacitorNative()) await nativeCheck();
    else await webCheck();
}

let _foregroundWired = false;
function wireForeground() {
    if (_foregroundWired) return;
    _foregroundWired = true;
    const onForeground = () => { runCheck(); };
    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) onForeground(); });
    }
    if (typeof window !== 'undefined') {
        window.addEventListener('focus', onForeground);
        // Capacitor native foreground signal — visibilitychange is flaky in a
        // WebView. Mirrors online-game.js's reconnect wiring; absent on web.
        const App = window.Capacitor?.Plugins?.App;
        App?.addListener?.('resume', onForeground);
        App?.addListener?.('appStateChange', (s) => { if (s?.isActive) onForeground(); });
    }
}

/**
 * Wire the foreground re-check and run one check now. Safe to call once at
 * boot; the RECHECK_MS throttle suppresses the resume that fires right after
 * a cold start.
 */
export async function initAppUpdate() {
    wireForeground();
    await runCheck();
}
