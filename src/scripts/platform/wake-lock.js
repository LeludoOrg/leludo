// Screen Wake Lock — keeps the device awake during an active game. The lock is
// dropped automatically when the page is hidden, so we re-acquire on tab
// re-focus. Self-contained (no game state); extracted from render-logic.js.

let _wakeLock = null;
let _wakeWanted = false;
let _wakeListenerAttached = false;

async function _acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    if (_wakeLock || document.visibilityState !== "visible") return;
    try {
        _wakeLock = await navigator.wakeLock.request("screen");
        _wakeLock.addEventListener("release", () => { _wakeLock = null; });
    } catch (e) {
        // permission denied / battery saver — silently ignore
    }
}

export function requestWakeLock() {
    _wakeWanted = true;
    if (!_wakeListenerAttached) {
        document.addEventListener("visibilitychange", () => {
            if (_wakeWanted && document.visibilityState === "visible") _acquireWakeLock();
        });
        _wakeListenerAttached = true;
    }
    _acquireWakeLock();
}

export function releaseWakeLock() {
    _wakeWanted = false;
    if (_wakeLock) {
        _wakeLock.release().catch(() => {});
        _wakeLock = null;
    }
}
