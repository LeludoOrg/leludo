/**
 * Single registry of every localStorage key the app uses.
 *
 * A drifting key string silently loses a saved game or a preference, so import
 * from here instead of re-typing the literal. Modules keep a readable local
 * alias (e.g. `SAVE_KEY`) sourced from this object so the string itself lives in
 * exactly one place.
 *
 * Exception: theme-boot.js hardcodes 'theme' because it loads as a classic
 * (non-module) <script> before any ES module — it cannot import this file. Keep
 * STORAGE_KEYS.THEME and that literal in sync.
 *
 * The per-toggle 'assist-*' keys are owned by the ASSIST_TOGGLES table in
 * wc-settings.js (already a single source) and are not duplicated here.
 */
export const STORAGE_KEYS = Object.freeze({
    SAVE: 'ludo-save',                 // serialized in-progress game
    THEME: 'theme',                    // 'system' | 'light' | 'dark'
    SOUND_MUTED: 'sound-muted',        // 'true' when muted
    GOD_MODE: 'debug-god-mode',        // localhost-only debug toggle
    BOT_NAME_POOL: 'bot-name-pool',    // active bot-name pool key
    SEAT_NAMES: 'seat-names',          // per-seat remembered display names
    MP_SERVER: 'leludo-mp-server',     // operator override for the ws server URL
    MP_SESSION: 'leludo-mp-session',   // stable per-device reconnect session id
    USERNAME: 'leludo-username',       // remembered online display name
    ONLINE_COLOR: 'leludo-online-color', // preferred online seat colour (0..3)
    UPDATE_PROMPT_AT: 'leludo-update-prompt-at', // last in-app update consent prompt (epoch ms)
    UPDATE_CHECK_AT: 'leludo-update-check-at',   // last update check ran (epoch ms) — rate-limits foreground re-checks
});
