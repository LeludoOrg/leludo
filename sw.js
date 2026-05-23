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
  'styles/base.css',
  'components/index.js',
  'components/utils.js',
  'components/wc-board.js',
  'components/wc-board.css',
  'components/wc-bot-icon.js',
  'components/wc-dice.js',
  'components/wc-dice.css',
  'components/wc-game-end.js',
  'components/wc-game-end.css',
  'components/wc-header.js',
  'components/wc-header.css',
  'components/wc-icons.css',
  'components/wc-pause-menu.css',
  'components/wc-quick-start.js',
  'components/wc-quick-start.css',
  'components/wc-settings.js',
  'components/wc-settings.css',
  'components/wc-token.js',
  'components/wc-token.css',
  'components/wc-user-icon.js',
  'scripts/index.js',
  'scripts/audio.js',
  'scripts/nav-history.js',
  'scripts/bot-ai.js',
  'scripts/bot-names.js',
  'scripts/command-handler.js',
  'scripts/game-driver.js',
  'scripts/game-logic.js',
  'scripts/game-reducer.js',
  'scripts/game-state.js',
  'scripts/game-store.js',
  'scripts/god-mode.js',
  'scripts/render-logic.js',
  'scripts/scheduler.js',
  'scripts/turn-rules.js',
  'scripts/listeners/audio-listener.js',
  'scripts/listeners/bot-listener.js',
  'scripts/listeners/persistence-listener.js',
  'scripts/transport/in-process-channel.js',
  'scripts/transport/mock-network-channel.js',
  'assets/icons/favicon.svg',
  'assets/sounds/capture.m4a',
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
