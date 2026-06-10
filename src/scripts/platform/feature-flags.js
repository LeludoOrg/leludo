/**
 * Feature flags for work that ships to main but isn't ready for the public
 * website yet. Mirrors the god-mode gate (scripts/state/god-mode.js): a hard
 * availability check decides whether the feature can exist on this surface at
 * all, and a persisted toggle decides whether it's currently on.
 *
 * Online multiplayer is the first flag. It's developed on `main` and exercised
 * on localhost + the isolated beta site (beta.leludo.org), but must stay hidden
 * on the production website (leludo.org) and in the shipped APK so unfinished
 * multiplayer never reaches real users. That lets us keep merging multiplayer
 * work to main without gating every push on it being "done".
 */

import { isCapacitorNative } from "./platform.js";
import { STORAGE_KEYS } from "./storage-keys.js";

// The production website. Online stays hidden here regardless of the toggle.
const PROD_HOSTS = new Set(['leludo.org', 'www.leludo.org']);

const ONLINE_KEY = STORAGE_KEYS.ONLINE_FLAG;

/**
 * Pure host policy (exported for tests): online may appear on any host that
 * isn't the production website — localhost, 127.0.0.1, beta.leludo.org,
 * *.workers.dev previews, etc.
 */
export function isOnlineHostAllowed(hostname) {
    return !PROD_HOSTS.has(hostname);
}

/**
 * Can "Play online" exist on this surface at all? Hard gate, same shape as
 * isGodModeAvailable(): never on the production website, never in the shipped
 * APK (Capacitor serves from https://localhost, so the hostname alone lies).
 */
export function isOnlineAvailable() {
    if (typeof window === 'undefined') return false;
    if (isCapacitorNative()) return false;
    return isOnlineHostAllowed(location.hostname);
}

// Default ON wherever available, so beta testers and devs see online without
// opting in. The settings toggle persists an explicit 'false' to hide it.
let _enabled = true;
if (isOnlineAvailable()) {
    _enabled = localStorage.getItem(ONLINE_KEY) !== 'false';
}

/** Is online currently shown? Available AND not toggled off. */
export function isOnlineEnabled() {
    return _enabled && isOnlineAvailable();
}

/** Persist the toggle. No-op where online isn't available (prod / APK). */
export function setOnlineEnabled(value) {
    if (!isOnlineAvailable()) return;
    _enabled = !!value;
    localStorage.setItem(ONLINE_KEY, String(_enabled));
}
