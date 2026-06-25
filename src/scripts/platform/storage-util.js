/**
 * localStorage helpers for the app's boolean preferences. The key strings live
 * in storage-keys.js; this owns the read/write *coercion* — the `=== 'true'`
 * read and the stringify-on-write that the sound-mute flag, the god-mode
 * toggle, and the assist toggles each re-typed — so it lives in one place.
 *
 * Browser-only: every caller runs in the page. The Node / Worker server has no
 * localStorage and never imports this.
 */

/** Read a boolean pref: stored 'true' → true, any other value → false, and a
 *  missing key → `fallback`. */
export function readBool(key, fallback = false) {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
}

/** Persist a boolean pref as the string 'true' / 'false'. */
export function writeBool(key, value) {
    localStorage.setItem(key, String(!!value));
}
