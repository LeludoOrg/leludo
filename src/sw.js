import { VERSION } from './version.js';

const CACHE = `leludo-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'changelog.html',
  'privacy.html',
  'changelog.css',
  'manifest.json',
  'version.js',
  'theme-boot.js',
  'styles/base.css',
  'components/index.js',
  'components/utils.js',
  'components/wc-icons.js',
  'components/seat-list.css',
  'components/wc-board.js',
  'components/wc-board.css',
  'components/wc-dice.js',
  'components/wc-dice.css',
  'components/wc-game-end.js',
  'components/wc-game-end.css',
  'components/wc-game-room.js',
  'components/wc-game-room.css',
  'components/wc-pause-menu.css',
  'components/wc-play-online.js',
  'components/wc-play-online.css',
  'components/wc-quick-start.js',
  'components/wc-quick-start.css',
  'components/wc-settings.js',
  'components/wc-settings.css',
  'components/wc-token.js',
  'components/wc-token.css',
  'scripts/index.js',
  'scripts/platform/analytics.js',
  'scripts/render/audio.js',
  'scripts/platform/background-suspend.js',
  'scripts/platform/nav-history.js',
  'scripts/net/net-client.js',
  'scripts/net/native-socket.js',
  'scripts/net/net-protocol.js',
  'scripts/net/ws-safe.js',
  'scripts/net/online-state.js',
  'scripts/net/online-game.js',
  'scripts/net/net-overlay.js',
  'scripts/core/board-constants.js',
  'scripts/core/board-util.js',
  'scripts/core/bot-ai.js',
  'scripts/core/bot-names.js',
  'scripts/state/command-handler.js',
  'scripts/render/end-highlights.js',
  'scripts/core/game-driver.js',
  'scripts/core/game-logic.js',
  'scripts/state/game-reducer.js',
  'scripts/state/game-state.js',
  'scripts/state/game-store.js',
  'scripts/state/god-mode.js',
  'scripts/render/ko-capture.js',
  'scripts/render/home-arrival.js',
  'scripts/render/overlay-base.js',
  'scripts/render/pawn-launch.js',
  'scripts/render/pawn-mini.js',
  'scripts/render/pawn-shape.js',
  'scripts/platform/platform.js',
  'scripts/render/render-logic.js',
  'scripts/core/rng-util.js',
  'scripts/core/room-code.js',
  'scripts/platform/scheduler.js',
  'scripts/platform/screens.js',
  'scripts/render/share-image.js',
  'scripts/core/seat-allocation.js',
  'scripts/platform/storage-keys.js',
  'scripts/platform/storage-util.js',
  'scripts/core/turn-rules.js',
  'scripts/platform/wake-lock.js',
  'scripts/listeners/analytics-listener.js',
  'scripts/listeners/audio-listener.js',
  'scripts/listeners/bot-listener.js',
  'scripts/listeners/persistence-listener.js',
  'scripts/net/transport/event-hub.js',
  'scripts/net/transport/in-process-channel.js',
  'scripts/net/transport/mock-network-channel.js',
  'assets/icons/favicon.svg',
  'assets/sounds/capture.m4a',
  'assets/fonts/instrument-serif-latin-400-normal.woff2',
  'assets/fonts/instrument-serif-latin-400-italic.woff2',
  'assets/fonts/dm-sans-latin-variable.woff2',
  'assets/fonts/jetbrains-mono-latin-variable.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (!res || res.status !== 200 || res.type !== 'basic') return res;
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      });
    })
  );
});
