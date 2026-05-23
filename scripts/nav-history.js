/**
 * Central history-stack manager. Owns pushState/popstate so that browser
 * back (web) and hardware back (Android via @capacitor/app) close one
 * overlay/screen at a time instead of leaving the app.
 *
 * Screens are explicit strings: 'home', 'setup', 'game', 'pause',
 * 'settings', 'game-end'. Each screen registers a close handler via
 * `registerScreenHandler` — when back fires, we look up the closer for
 * the screen we're leaving and invoke it.
 *
 * The one exception: back from 'game' opens the pause menu rather than
 * exiting. We re-push the game entry and trigger the registered
 * `__game_back__` action.
 */

const _handlers = new Map();
let _currentScreen = 'home';
let _initialized = false;

export function getCurrentScreen() {
    return _currentScreen;
}

export function registerScreenHandler(screen, fn) {
    _handlers.set(screen, fn);
}

export function initNavHistory() {
    if (_initialized) return;
    _initialized = true;
    try {
        history.replaceState({ screen: 'home' }, '');
    } catch {}
    _currentScreen = 'home';
    window.addEventListener('popstate', handlePopState);
    installAndroidBackHandler();
}

export function goTo(screen) {
    if (_currentScreen === screen) return;
    try {
        history.pushState({ screen }, '');
    } catch {}
    _currentScreen = screen;
}

export function replaceTo(screen) {
    try {
        history.replaceState({ screen }, '');
    } catch {}
    _currentScreen = screen;
}

export function back() {
    history.back();
}

function handlePopState(event) {
    const previous = _currentScreen;
    const target = event.state?.screen ?? 'home';
    _currentScreen = target;

    if (previous === 'game') {
        try {
            history.pushState({ screen: 'game' }, '');
        } catch {}
        _currentScreen = 'game';
        const onGameBack = _handlers.get('__game_back__');
        if (onGameBack) onGameBack();
        return;
    }

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
