/**
 * Canonical screen names for the history-stack navigator (nav-history.js).
 *
 * `goTo` / `replaceTo` / `registerScreenHandler` all key off these strings, and
 * they double as the analytics screen labels. A typo silently no-ops a
 * navigation (e.g. `goTo('setttings')`), so import these constants instead of
 * re-typing the literal.
 */
export const SCREENS = Object.freeze({
    HOME: 'home',
    SETUP: 'setup',
    GAME: 'game',
    PAUSE: 'pause',
    SETTINGS: 'settings',
    GAME_END: 'game-end',
    ONLINE: 'online',
    ONLINE_SEARCH: 'online-search',
    ONLINE_LOBBY: 'online-lobby',
});

/**
 * Sentinel handler key: back-navigation from the live GAME screen opens the
 * pause menu instead of leaving the game. Registered/looked up under this key
 * rather than a real screen name.
 */
export const GAME_BACK_ACTION = '__game_back__';
