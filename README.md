# Ludo

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

Browser Ludo game. Vanilla JS + Web Components + hand-written CSS. No bundler, no Tailwind. Ships to web ([leludo.org](https://leludo.org)) and Android via Capacitor.

Play offline. Four AI personalities (`balanced`, `aggressive`, `defensive`, `rusher`). No ads, no tracking, no accounts.

## Setup

```bash
npm install
```

## Develop

```bash
npm run dev      # five-server on :8888 (no build step)
npm test         # vitest watch mode
npm run test:e2e # Playwright smoke suite
```

Open <http://localhost:8888> for the game.

When running on `localhost` (or `127.0.0.1`) a **Debug → God mode**
toggle appears in the settings overlay. Enable it to teleport any
pawn to any cell by clicking a pawn and then a target cell — captures
still fire normally. The toggle and code path are gated off in
production builds.

## Android (Capacitor)

```bash
npm run android:prepare   # version sync + build www/ + cap sync
npm run android:open      # open in Android Studio
npm run android:run       # run on connected device or emulator
```

## Project layout & architecture

See [CLAUDE.md](CLAUDE.md) for the full repo map, pause model, cache-busting flow, and Android pipeline.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the house rules.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

Copyright © 2024 Vishal Gidwani.

You can fork it, modify it, ship it. Derivative works (including web deployments and mobile builds) must remain under GPL-3.0 and ship source. No proprietary closed-source forks.

## Credits

See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for fonts, libraries, and third-party assets.
