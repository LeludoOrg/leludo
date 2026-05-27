# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Ludo

Browser Ludo game. Vanilla JS + Web Components + hand-written CSS. No bundler, no Tailwind — ES modules and stylesheets load directly via `<script type="module">` / `<link rel="stylesheet">`. GitHub Pages serves the repo root as site root.

## Repo Layout

```
/
├── index.html, changelog.html, privacy.html, manifest.json, CNAME
├── styles/base.css      design tokens + reset + layout primitives + player color helpers
├── changelog.css        shared chrome for changelog.html + privacy.html
├── components/          Web Components (wc-*.js) + per-component CSS (wc-*.css)
├── scripts/             game logic (game-events, game-logic, render-logic, bot-ai, bot-names)
├── assets/              shipped fonts, icons, sounds
├── test/                vitest + Playwright suites
├── design/              source PNGs/SVGs for app icons
├── tools/               build helpers (all Node .mjs)
├── play-store/          generated store listing assets
├── www/                 (gitignored) Capacitor shipping dir, built by tools/build-www.mjs
└── android/             Capacitor Android project
```

## Dev Commands

- `npm install` (one-time).
- `npm run dev` — five-server on port 8888. No build step; CSS and JS load directly. **If a dev server is already running on port 8888, reuse it — do not spawn another one** (the existing `.claude/launch.json` `ludo-dev` config is the same five-server invocation; `preview_start` returns the existing serverId when one is already up).
- `npm test` — vitest watch mode. Unit + integration suite in `test/**/*.test.js`, mirrors source tree (e.g. [test/scripts/game-logic.test.js](test/scripts/game-logic.test.js) tests [scripts/game-logic.js](scripts/game-logic.js)). Runs in `happy-dom`. Integration tests under [test/integration/](test/integration/) drive full games via the pure [scripts/game-driver.js](scripts/game-driver.js).
- `npm run test:run` — single-shot vitest run (CI mode, exits when done).
- `npm run test:coverage` — coverage report (v8 provider) into `coverage/`.
- `npm run test:e2e` — Playwright smoke tests in [test/e2e/](test/e2e/). Spawns a static server via [tools/serve-static.mjs](tools/serve-static.mjs) on port 8889. Use `npm run test:e2e:ui` for the inspector.
- `npm run cache-bust` — see Cache Busting below.

## Bug-fix discipline

**Every bug fix lands with a regression test.** If a CSS / layout /
behavioural bug got through review once, the only way to keep it from
returning is a failing assertion in CI. Add or extend a Playwright
case in [test/e2e/](test/e2e/) (or a vitest case under
[test/](test/) if the bug lives in pure logic) that:

1. Reproduces the broken state — confirm the test FAILS before your fix.
2. Asserts the corrected behaviour — confirm the test PASSES after.
3. Carries a short comment explaining the original symptom so a
   future reader knows what the assertion is guarding.

`test/e2e/board-styles.spec.js` is the canonical example: each block
of assertions maps 1:1 to a concrete board-rendering bug fixed during
the Tailwind → hand-written CSS refactor. Follow that pattern for new
fixes — don't ship "just the fix" expecting the next reviewer to
catch the regression by eye.

## CI

GitHub Actions workflows live in [.github/workflows/](.github/workflows/):

- `ci.yml` — runs on PRs to `main` and pushes to other branches.
  Three jobs: vitest, Playwright E2E, and a `www/` build smoke test.
- `release-web.yml` — web release pipeline (test + build + gh-pages
  publish + tag + GH release with web zip). Manual trigger only
  (`workflow_dispatch`). Owns the `gh-pages` push (see Web Deployment
  below).
- `release-android.yml` — Android release pipeline (test + build APK
  + AAB + Play Store publish + tag + GH release with apk/aab).
  Manual trigger only (`workflow_dispatch`).

Both release workflows create the `vX.Y.Z` tag idempotently (skip if
it exists) and use `softprops/action-gh-release@v2`, which creates the
release on first run and appends artifacts on subsequent runs — so
running web then android lands a single GH release per version with
web zip + apk + aab attached. Typical flow: bump `VERSION`, run web,
validate `leludo.org`, then run android.

### Playwright runner

The E2E job runs inside the official
`mcr.microsoft.com/playwright:v<version>-noble` container so the
Chromium browser and its OS shared libs are pre-baked — no
`playwright install` step on every run.

**The container image tag MUST match the `@playwright/test` version
pinned in `package-lock.json`.** When bumping `@playwright/test`,
also bump the `image:` tag in `ci.yml`. Mismatch makes the test
runner refuse to launch with a loud, obvious error.

## Architecture

Two top-level module trees at the repo root, each with an `index.*.js` barrel that re-exports its tree:

- **`components/`** — Web Components (`wc-board`, `wc-token`, `wc-dice`, `wc-quick-start`, `wc-settings`, `wc-game-end`, etc.) + shared `utils`. Each custom element registers itself on import via `customElements.define`. The components barrel re-exports all.
- **`scripts/`** — Game state machine and rendering.
  - `game-logic` — pure functions: dice, mark index, capture detection, safe squares.
  - `turn-rules` — pure: player rotation, end-game detection, leftover ranking, save/load serialization.
  - `bot-ai` — expectiminimax with personality-weighted scoring (`balanced`/`aggressive`/`defensive`/`rusher`).
  - `game-driver` — pure programmatic game loop that composes `game-logic` + `bot-ai` + `turn-rules` with a seedable RNG. Used by integration tests; no DOM.
  - `render-logic` — DOM/audio side effects.
  - `game-events` — turn orchestration, input lock, assist flags, bot scheduling. Thin glue between the pure modules and the DOM.
  - `bot-names` — name lists.

Entry points wired in [index.html](index.html): components index + scripts index. `wc-board` consumes the scripts barrel for game flow; `render-logic` imports `getMarkIndex` from `game-logic` via the scripts barrel.

Pure logic lives in `scripts/game-logic.js`, `scripts/turn-rules.js`, `scripts/bot-ai.js`, `scripts/game-driver.js` — keep these side-effect-free so tests can import them directly.

## Pause Model

`game-events` owns a `_paused` flag plus a `scheduleTurn(fn, delay)` helper. **Any bot or autoplay `setTimeout` in the turn flow must go through `scheduleTurn`** — that lets `pauseGameLogic()` clear in-flight timers and defer the next callback into `_pendingResume`, which `resumeGameLogic()` fires on resume. `handleDiceRoll` and `handleOnTokenMove` also early-return when paused.

Two surfaces pause the game today:
- The in-game pause button → `handleGamePause` (shows the pause overlay in `index.html`).
- Opening the settings overlay during a game → `wc-settings.openSettings` calls `pauseGameLogic` and remembers `_pausedBySettings` so closing settings resumes it.

If you add a new modal that overlays the game, decide whether it should pause; if yes, use the same pattern (call `pauseGameLogic` on open, `resumeGameLogic` on close).

## Styling

Hand-authored CSS, organized as one global stylesheet + one file per component:

- `styles/base.css` — design tokens (`:root` / `.dark`), CSS reset, fonts, layout primitives (`.page`, `.frame`, `.top-bar`, `.icon-btn`, `.cta-primary`, `.cta-secondary`, `.surface-card`, `.section-label`, `.display-title`, `.frame-overlay`), keyframes, and player color helpers (`.player-bg-N`, `.player-fg-N`, `.player-bg-path-N`, `.player-bg-soft-N`, `.player-border-N`, `.player-fill-N`).
- `components/wc-*.css` — one file per Web Component, selectors scoped via the component tag (e.g. `wc-board .home-quad { … }`). Loose semantic class names, no BEM.
- `changelog.css` — shared chrome for `changelog.html` + `privacy.html`.

`index.html` links the global stylesheet plus every component stylesheet directly (no bundler). When adding a new component:

1. Create `components/wc-foo.js` + `components/wc-foo.css`.
2. Link the CSS from `index.html`.
3. Add both files to the `PRECACHE` array in [sw.js](sw.js).
4. If the component ships to the APK, add nothing extra — `tools/build-www.mjs` copies the whole `components/` tree.

### Design tokens

Colors are CSS variables. Two flavors:

- **Semantic colors** (`--color-bg`, `--color-fg`, `--color-surface`, `--color-surface-hover`, `--color-border`, `--color-safe`, `--color-board-cell`, `--color-board-border`) — direct `hsl(...)` values, overridden on `.dark`.
- **Player colors** (`--player-N`, `--player-N-light`, `--player-N-path`, `--base-color-N`, `--base-color-N-light`) — raw HSL triplets so they can be remapped at runtime by `applyColorMap` in `scripts/render-logic.js`. Don't rename these unless you also update render-logic.

Spacing scale: `--space-{1..12}` (4px base). Radii: `--radius-{sm,md,lg,xl,2xl,pill}`. Fonts: `--font-display` (Instrument Serif), `--font-sans` (DM Sans), `--font-mono` (JetBrains Mono).

### Layout shell

Home, setup, settings, pause, changelog, privacy all share the same outer frame:

- Outermost wrapper uses `.page` (flex centered, padded).
- Inner column uses `.frame` (max-width 384px, sized to fill viewport on phones, fixed-height card on `>640px`).
- Top row uses `.top-bar` with a `.icon-btn` (or `.icon-btn-spacer`) on each side and a centered `.top-bar-title` label.
- Middle content sits inside `.frame-body`.
- Primary action uses `.cta-primary` in `.frame-footer`. Secondary use `.cta-secondary`.

The game board (`wc-board`) uses `.board-frame` (same outer min-height) plus `.board-spacer` divs above corner-row-top *and* below corner-row-bottom to vertically center the play area while keeping the top icon row aligned with the other screens.

Overlays (`#pause-menu`, `#settings-overlay`, `wc-game-end`'s root) use `.frame-overlay` — fixed inset, hidden by default, shown by removing the `.hidden` class.

## God Mode (localhost-only debug)

A settings toggle under **Debug (localhost only)** lets a developer
teleport any pawn to any cell — first click selects a pawn (magenta
pulse), next click on a valid cell moves it there. Bypasses dice,
turn order, and movability rules but **does honour capture rules**:
opponents on the destination square get sent home (safe-square and
two-token-pair safety apply, same as normal play).

**Parity rule — god-mode mirrors normal play for any visible
behaviour.** If a feature (animation, sound, side effect, state
update) fires when a transition happens via the normal turn flow, it
must also fire when god-mode produces the same transition. Examples
already wired in `godTeleport` ([scripts/command-handler.js](scripts/command-handler.js)):
yard → entry plays `playYardLaunch`, finish-cell arrival plays
`playFinishArrival`, captures animate via `animateCaptureToHome`. When
you add a new transition-bound effect, hook it into both
`updateTokenContainer` / the normal turn path AND `godTeleport` —
otherwise god-mode silently skips it and the debug surface drifts
from real gameplay.

Gated by `isGodModeAvailable()` in [scripts/god-mode.js](scripts/god-mode.js),
which checks `location.hostname === 'localhost' || '127.0.0.1'`. The
toggle row in [wc-settings.js](components/wc-settings.js) and the
god-mode branch in [wc-board.js](components/wc-board.js) both
short-circuit off that check, so production users never see the
control and can't trigger the code path even by setting the
localStorage flag.

Persisted state goes through the normal store: dispatches
`COMMANDS.GOD_TELEPORT` → command handler does the DOM move + capture
animations → emits `EVENTS.GOD_TELEPORTED` (and `TOKEN_CAPTURED` per
victim) → reducer updates `playerTokenPositions` → persistence
listener saves to `ludo-save` just like a real move.

## Test Overrides (URL Params)

`handleGameStart` in `scripts/game-events.*.js` reads two query params for scenario testing — bypasses normal home-start:

- `?positions=p0t0,p0t1,p0t2,p0t3,p1t0,...,p3t3` — comma-separated token positions, indexed as `playerIndex * 4 + tokenIndex`. Values: `-1` (home), `0..50` (track), `51..56` (home stretch, `56` = finished). Missing/blank entries stay at `-1`.
- `?player=N` — force `currentPlayerIndex` (0..3) for first turn.

Example: `http://localhost:8888/?positions=50,,,,,,,,,,,,,,,&player=0` puts P0's first token one step from finish and gives P0 the opening turn. Preserve this behavior when refactoring game start.

## Web Deployment (GitHub Pages)

`leludo.org` is served from the `gh-pages` branch, NOT from the repo
root. The branch is rebuilt and force-pushed by the `publish-pages`
job in [.github/workflows/release-web.yml](.github/workflows/release-web.yml),
which runs as part of the web release pipeline (`workflow_dispatch`):

1. `npm ci`
2. `node tools/build-www.mjs` → assembles `www/` (HTML + CSS + JS +
   service worker + assets + `CNAME` + `.nojekyll`).
3. `peaceiris/actions-gh-pages@v4` publishes `./www` to `gh-pages`.

Web release is decoupled from Android — running `release-web.yml`
publishes `leludo.org` and creates/updates the GH release with the
web zip, without touching the Play Store. Android ships separately
via `release-android.yml`. A web-only fix still requires a version
bump + a Release (Web) run.

The public domain therefore only ever sees runtime artifacts —
internal docs (`CLAUDE.md`, `CONTRIBUTING.md`), tooling (`tools/`,
`test/`, `vitest.config.js`, `playwright.config.js`), the Android
project (`android/`), the design source (`design/`), and the
`package*.json` files stay invisible to clients of `leludo.org`. They
remain visible on the GitHub repo page; that's intentional.

**One-time repo setup**: Settings → Pages → Source = `gh-pages` branch
(root). After the first workflow run lands, set this and the custom
domain (`leludo.org`) will pick up the deployed branch.

When adding a new shipping file (e.g. another CSS file, font, sound),
add it to `SHIPPED` in [tools/build-www.mjs](tools/build-www.mjs) AND
to `PRECACHE` in [sw.js](sw.js). The deploy workflow copies whatever
`build-www.mjs` emits — nothing else.

## Cache Busting

A module service worker at [sw.js](sw.js) owns cache invalidation. JS filenames are canonical (`name.js`) — no content hashes.

How it works:
- SW imports `VERSION` from [version.js](version.js); cache name = `leludo-${VERSION}`.
- On install, it precaches the shell (HTML + CSS + every `components/*.js` and `scripts/*.js` + critical assets).
- On activate, old caches not matching the current name are deleted; `clients.claim()` takes over open tabs.
- Fetch strategy: network-first for HTML navigations (fresh shell on release), cache-first for everything else.
- Registered as a module SW (`type: 'module'`), so browsers diff `sw.js` AND its static imports — bumping `version.js` triggers an update.
- Registration is gated off on `localhost` / `127.0.0.1` to keep `npm run dev` simple.

**Release ritual: bump `VERSION` in [version.js](version.js). That's it.** Browsers detect the SW dependency change on next navigation, install the new SW, purge the old cache, and serve fresh assets.

If you add a new top-level file that must be cached offline, also add it to the `PRECACHE` array in [sw.js](sw.js).

## Versioning

Single source of truth: `VERSION` constant in [version.js](version.js). Consumed by `wc-quick-start` (landing footer), `wc-settings` (about dialog), and `sw.js` (cache name). The components barrel re-exports it.

**Bump on every change that lands on `main`** — user-visible polish, gameplay tweaks, AND internal refactors / cleanups / dependency bumps. The service worker uses `VERSION` as its cache key, so any shipped JS/CSS/HTML diff needs a bump or returning users keep stale cached assets. Semver-ish:
- Patch (`0.X.Y+1`) — bug fix, polish, copy tweak, internal cleanup, refactor, dead-code removal
- Minor (`0.X+1.0`) — new feature, AI/UX change, gameplay logic
- Major (`X+1.0.0`) — breaking save format, full rewrite

Edit `version.js`. No other steps for web. For Android, `npm run android:prepare` mirrors it into `build.gradle` via [tools/sync-android-version.mjs](tools/sync-android-version.mjs).

## Changelog

Public release notes live at [changelog.html](changelog.html). Newest entry on top.

**Every VERSION bump must add a changelog entry.** Copy the most recent `<article>` block, change the version + date, fill in the new content. Keep the layout shell (icon row, `.frame`, `.surface-card` sections) consistent with `privacy.html`.

Minimum sections per entry:
- **Highlights** — short bullet list of changes. For user-visible diffs, describe what the player will see. For pure internal work (refactors, dead-code removal, dep bumps), say so plainly — e.g. "Internal code cleanup: …. No gameplay or UI changes." Don't invent user-facing narrative.
- For Play Store releases only (versions actually shipped to a listing): also include **Play Store description — short** (≤80 chars) and **Play Store description — full** sections so the published copy stays in sync with the app.

## Android (Capacitor)

Capacitor's `webDir` is `www/`, which is **built** from the root by `tools/build-www.mjs` (copies the three HTMLs + `changelog.css` + `manifest.json` + `sw.js` + `version.js` + the `styles/`, `components/`, `scripts/`, and `assets/` trees). `www/` is gitignored.

Scripts in `package.json`:

- `npm run android:prepare` — version sync → build:www → `cap sync android`.
- `npm run android:open` / `npm run android:run` — prepare + open/run in Android Studio.

Anything that works in the browser ships to Android as long as `npm run android:prepare` runs first.
