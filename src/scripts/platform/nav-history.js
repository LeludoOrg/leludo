/**
 * Central history-stack manager. Owns pushState/popstate so that browser
 * back (web) and hardware back (Android via @capacitor/app) close one
 * overlay/screen at a time instead of leaving the app.
 *
 * Screen names are the SCREENS constants (screens.js): home, setup, game,
 * pause, settings, game-end, online, online-search, online-lobby. Each screen
 * registers a close handler via `registerScreenHandler` — when back fires, we
 * look up the closer for the screen we're leaving and invoke it.
 *
 * The one exception: back from GAME opens the pause menu rather than exiting.
 * We re-push the game entry and trigger the registered GAME_BACK_ACTION handler.
 */

import { trackScreen } from './analytics.js';
import { SCREENS, GAME_BACK_ACTION } from './screens.js';

const _handlers = new Map();
let _currentScreen = SCREENS.HOME;
let _initialized = false;

export function registerScreenHandler(screen, fn) {
    _handlers.set(screen, fn);
}

export function initNavHistory() {
    if (_initialized) return;
    _initialized = true;
    try {
        history.replaceState({ screen: SCREENS.HOME }, '');
    } catch {}
    _currentScreen = SCREENS.HOME;
    window.addEventListener('popstate', handlePopState);
    installAndroidBackHandler();
    trackScreen(_currentScreen);
}

export function goTo(screen) {
    if (_currentScreen === screen) return;
    try {
        history.pushState({ screen }, '');
    } catch {}
    _currentScreen = screen;
    trackScreen(screen);
}

export function replaceTo(screen) {
    const changed = _currentScreen !== screen;
    try {
        history.replaceState({ screen }, '');
    } catch {}
    _currentScreen = screen;
    if (changed) trackScreen(screen);
}

export function back() {
    history.back();
}

function handlePopState(event) {
    const previous = _currentScreen;
    const target = event.state?.screen ?? SCREENS.HOME;
    _currentScreen = target;

    if (previous === SCREENS.GAME) {
        try {
            history.pushState({ screen: SCREENS.GAME }, '');
        } catch {}
        _currentScreen = SCREENS.GAME;
        trackScreen(SCREENS.PAUSE);
        const onGameBack = _handlers.get(GAME_BACK_ACTION);
        if (onGameBack) onGameBack();
        return;
    }

    trackScreen(target);
    const closer = _handlers.get(previous);
    if (closer) closer(target);
}

function installAndroidBackHandler() {
    const cap = window.Capacitor;
    if (!cap?.isNativePlatform?.()) return;
    const App = cap.Plugins?.App;
    if (!App?.addListener) {
        console.warn('Capacitor App plugin missing — install @capacitor/app and re-sync');
        return;
    }
    App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
            window.history.back();
        } else {
            App.exitApp();
        }
    });
}
