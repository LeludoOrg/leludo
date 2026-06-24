/**
 * Background-suspend: when the app leaves the foreground mid-game (phone home
 * button, app switch, screen lock, tab hidden), the player isn't watching — so
 * the game must not keep running unattended.
 *
 *   - OFFLINE game → PAUSE. Same as tapping the pause button: freezes the turn
 *     loop and shows the pause menu, so coming back never drops the player into
 *     a bot turn that already played out while they were away.
 *   - ONLINE game → ONLINE_EXIT. A live server match can't be frozen (everyone
 *     else plays on), so we open the leave/exit confirmation, which drops our
 *     socket (suspend) and starts the reconnect-grace countdown — the same flow
 *     as tapping the exit door. "Stay" reels us back in on return.
 *
 * Only fires while a board is actually on screen (currentScreen() === GAME):
 * backgrounding from the home/setup/lobby screens does nothing, and once we've
 * paused or opened the exit menu the screen is no longer GAME, so a second
 * background signal (visibilitychange AND Capacitor both fire on Android) is a
 * harmless no-op.
 */

import { dispatch } from '../state/game-store.js';
import { COMMANDS } from '../state/command-handler.js';
import { currentScreen } from './nav-history.js';
import { SCREENS } from './screens.js';
import { isOnlineActive } from '../net/online-state.js';
import { isGameLogicPaused } from './scheduler.js';

function onBackground() {
    // Only a live board cares — not the menus, lobby, pause/exit overlays, or
    // the end screen (all of which have left SCREENS.GAME already).
    if (currentScreen() !== SCREENS.GAME) return;

    if (isOnlineActive()) {
        // Open the leave/exit confirmation (drops our socket, starts the grace
        // countdown). handleOnlineExit goTo(PAUSE)s, so re-entry won't re-fire.
        dispatch({ type: COMMANDS.ONLINE_EXIT });
    } else if (!isGameLogicPaused()) {
        // Freeze the offline turn loop and show the pause menu.
        dispatch({ type: COMMANDS.PAUSE });
    }
}

let _wired = false;
export function initBackgroundSuspend() {
    if (_wired) return;
    _wired = true;

    if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) onBackground();
        });
    }
    if (typeof window !== 'undefined') {
        // Capacitor native lifecycle: the reliable Android/iOS background signal
        // (visibilitychange is flaky in a WebView). Mirrors the foreground
        // reconnect wiring in online-game.js; absent on web, where
        // visibilitychange covers it.
        const App = window.Capacitor?.Plugins?.App;
        App?.addListener?.('pause', onBackground);
        App?.addListener?.('appStateChange', (s) => { if (s && !s.isActive) onBackground(); });
    }
}
