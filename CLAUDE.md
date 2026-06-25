# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Ludo

Browser Ludo game. Vanilla JS + Web Components + hand-written CSS. No Tailwind, and no bundler in dev — ES modules and stylesheets load directly via `<script type="module">` / `<link rel="stylesheet">`; the production build bundles them (see Cache Busting). **All app code lives under `src/`.** `src/` is also the **web root** — the dev server serves `src/` (NOT the repo root), so the browser-loaded files (HTML, `styles/`, `components/`, `scripts/`, `assets/`, …) sit directly in `src/`. The backend (`src/server/`) and tests (`src/test/`) live there too — not web-linked, but co-located so their relative imports into `src/scripts/` (e.g. `server/cf/room-do.js` → `../../scripts/net-protocol.js`) resolve. `tools/` stays at the repo root (build infra that resolves repo-root paths). Production (`leludo.org`) is served by Cloudflare Pages, built from `src/`'s shipped files flattened into `www/` by `tools/build-www.mjs`.

## Repo Layout

```
/
├── src/                 ← ALL APP CODE + THE WEB ROOT (dev server serves this; shipped files flattened to www/ for prod)
│   ├── index.html, changelog.html, privacy.html, multiplayer.html
│   ├── manifest.json, version.js, theme-boot.js
│   ├── changelog.css        shared chrome for changelog.html + privacy.html
│   ├── styles/base.css      design tokens + reset + layout primitives + player color helpers
│   ├── components/          Web Components (wc-*.js) + per-component CSS (wc-*.css)
│   ├── scripts/             game logic (game-events, game-logic, render-logic, bot-ai, bot-names)
│   ├── assets/              shipped fonts, icons, sounds
│   ├── server/             multiplayer backend (CF Worker + local dev ws server) — NOT web-served
│   └── test/               vitest + Playwright suites — NOT web-served
├── tools/               build helpers (all Node .mjs) — stays at repo root
├── docs/                internal docs (CONTRIBUTING, ATTRIBUTIONS, plans)
├── dev-assets/          dev/build-only sources — design/ (icon PNGs/SVGs),
│                        screenshots/ (store shots), distribution/ (gen'd whatsnew).
│                        NOT served, NOT shipped — referenced only by tools/*.mjs.
├── .local/             (gitignored) local-only generated junk: coverage,
│                        test-results, e2e recordings, signed release artifacts.
├── www/                 (gitignored) Capacitor shipping dir, built by tools/build-www.mjs
└── android/             Capacitor Android project
```

Paths in the sections below that name `index.html`, `styles/`,
`components/`, `scripts/`, `assets/`, `server/`, `test/`, `version.js`,
`theme-boot.js`, `manifest.json`, `changelog.css`, or the HTML pages are all
**relative to `src/`** (e.g. `components/wc-board.js` →
`src/components/wc-board.js`, `server/cf/worker.js` → `src/server/cf/worker.js`).
`tools/` paths stay at the repo root.

## Dev Commands

- `npm install` (one-time).
- `npm run dev` — five-server on port 8888. No build step; CSS and JS load directly. **If a dev server is already running on port 8888, reuse it — do not spawn another one** (the existing `.claude/launch.json` `ludo-dev` config is the same five-server invocation; `preview_start` returns the existing serverId when one is already up).
- `npm test` — vitest watch mode. Unit + integration suite in `test/**/*.test.js`, mirrors source tree (e.g. [test/scripts/game-logic.test.js](test/scripts/game-logic.test.js) tests [scripts/game-logic.js](scripts/game-logic.js)). Runs in `happy-dom`. Integration tests under [test/integration/](test/integration/) drive full games via the pure [scripts/game-driver.js](scripts/game-driver.js).
- `npm run test:run` — single-shot vitest run (CI mode, exits when done).
- `npm run test:coverage` — coverage report (v8 provider) into `.local/coverage/`.
- `npm run test:e2e` — Playwright smoke tests in [test/e2e/](test/e2e/). Spawns a static server via [tools/serve-static.mjs](tools/serve-static.mjs) on port 8889. Use `npm run test:e2e:ui` for the inspector.
- `npm run build:www` — assemble the production `www/` bundle (content-hashed JS/CSS); see Cache Busting below.

## Don't repeat yourself — dedupe aggressively

**Duplication is a bug.** If the same literal, helper, regex, magic
number, or block of markup appears in 2+ places, extract it to one
named export and import it everywhere. A copy-pasted constant that
drifts is a defect waiting to happen — the launching pawn rendering a
different shape than the captured pawn, two safe-square lists going out
of sync, etc.

Rules:
- **No "standalone, no deps" excuse.** A module comment saying a file is
  self-contained does NOT justify copy-pasting shared code into it.
  Prefer one source of truth over an isolated copy — convert the
  comment, add the import. (See [scripts/pawn-shape.js](scripts/pawn-shape.js),
  shared by the three overlay modules.)
- When two "duplicates" have subtly different semantics (e.g. a guard
  one has and the other lacks, or a different drop-shadow), make the
  difference an explicit parameter of the shared helper — don't keep two
  copies, and don't silently collapse them either.
- Shared pure constants/helpers go in the module they most belong to (or
  a small dedicated `*-shape.js` / `*-constants.js`); import via the
  relative path. The production bundler picks them up automatically once
  something in the module graph imports them.

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
- `release.yml` — **the production release** (manual `workflow_dispatch`,
  one input: `release_notes`). One run ships everything for a version:
  prod MP Worker (`leludo-mp`) + Cloudflare Pages `leludo` (leludo.org) +
  Android AAB → Play **production** track + HTML5 build → itch.io + the
  `vX.Y.Z` tag and GH release (web zip + apk + aab). The Android build
  runs at `MP_CHANNEL=prod` (default): `versionCode = base`, prod backend
  baked in. Play "What's new" comes from the `release_notes` input (not
  the changelog — see Versioning), capped at 500 chars by a build step.
- `release-beta.yml` — **the beta channel** (`workflow_dispatch` +
  every push to `main`). Always: beta MP Worker (`leludo-mp-beta`) +
  Cloudflare Pages `leludo-beta` (beta.leludo.org). On a **manual
  dispatch only** it ALSO builds a beta-channel AAB (`MP_CHANNEL=beta`:
  banded `versionCode`, beta backend baked in) and uploads it to the Play
  **internal** track. A routine push keeps beta.leludo.org fresh but
  never touches Play. Does NOT tag or cut a GH release.

**Per-track Android, no Play Console promote.** Each channel is a SEPARATE
artifact — different backend (prod vs the isolated beta Worker, baked at
build time via `MP_CHANNEL`; see `BUILD_CHANNEL` in
[scripts/net/net-client.js](src/scripts/net/net-client.js) +
[tools/build-www.mjs](tools/build-www.mjs)) and a different `versionCode`
band. The channel registry is [tools/release-channels.mjs](tools/release-channels.mjs):
`prod` (band 0, production track) is lowest, and test channels sit above it
ordered by how internal they are — `open` (10), `closed` (20), `beta`/internal
(30). Bands jump by 10 (not 0,1,2,3) on purpose: that leaves 9 free slots
between any two so a new track can be inserted at its correct position later
WITHOUT renumbering. `versionCode = band * 1e7 + base`, giving indices 0..209
under Play's 2.1e9 cap. Play serves a multi-track user the HIGHEST code, so this
keeps every test build above prod (a tester is never pulled onto the public
build) and keeps the most-internal track on top. `versionName` is identical
across channels — players only ever see `0.X.Y`. Adding a channel = a registry
entry (a free band slotted at its internalness-ordered position) + a CI job;
never renumber an existing band.

`release.yml` creates the tag idempotently and uses
`softprops/action-gh-release@v2`. Typical flow: bump `VERSION` + add a
changelog entry → push to `main` (auto-deploys beta.leludo.org) →
dispatch `release-beta.yml` to push the internal AAB → test on the
internal track (it dials the beta backend) → dispatch `release.yml`
with the `release_notes` to ship production everywhere.

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

Two module trees under `src/`, each with an `index.*.js` barrel that re-exports its tree:

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
2. Export the JS from `components/index.js` and link the CSS from `index.html`.
3. That's it — `tools/build-www.mjs` folds the JS into `app.<hash>.js` and the CSS into the inlined critical set or `game.<hash>.css`. Nothing extra for the APK; the same `www/` bundle ships there.

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

## Web Deployment (Cloudflare Pages)

`leludo.org` is served by the Cloudflare Pages project `leludo`, NOT
from a git branch. It is rebuilt and deployed by the `publish-pages`
job in [.github/workflows/release.yml](.github/workflows/release.yml),
which runs as part of the production release (`workflow_dispatch`):

1. `npm ci`
2. `node tools/build-www.mjs` → assembles `www/` (the HTML pages +
   inlined critical CSS + the content-hashed `app.<hash>.js` /
   `analytics.<hash>.js` / `game.<hash>.css` bundles + `styles/base.css`
   for the changelog/privacy pages + assets).
3. `cloudflare/wrangler-action@v3` runs `wrangler pages deploy www
   --project-name=leludo --branch=main` → a production deploy serving
   the `leludo.org` custom domain.

`beta.leludo.org` is the sibling Pages project `leludo-beta`, deployed
the same way by `release-beta.yml` on every push to `main`.

`release.yml` ships web + Android (Play production) + itch + the GH
release in one dispatch; the beta web channel (and the Play internal
build, on dispatch) ride `release-beta.yml`. See CI above.

The public domain therefore only ever sees runtime artifacts —
internal docs (`CLAUDE.md`, `docs/`), tooling (`tools/`,
`test/`, `vitest.config.js`, `playwright.config.js`), the Android
project (`android/`), the dev-only sources (`dev-assets/`), and the
`package*.json` files stay invisible to clients of `leludo.org`. They
remain visible on the GitHub repo page; that's intentional.

When adding a new shipping file (e.g. another font or sound), add it
to `SHIPPED` in [tools/build-www.mjs](tools/build-www.mjs). The deploy
workflow ships whatever `build-www.mjs` emits — nothing else.

## Cache Busting

Production assets are **content-hashed** by [tools/build-www.mjs](tools/build-www.mjs). The JS ships as `app.<hash>.js`, the changelog/privacy analytics graph as `analytics.<hash>.js`, and the non-critical CSS as `game.<hash>.css`. `index.html` (and the two aux pages) reference the hashed names, so any content change yields a new filename browsers fetch immediately — while unchanged bundles stay cached indefinitely. The HTML pages themselves aren't hashed (their names are public URLs); they ride Cloudflare's normal ETag / short-max-age revalidation, so a new deploy's fresh hashed references take effect on the next navigation. No service worker, no manual cache key.

Dev (`npm run dev`) serves raw `src/` modules with no hashing and no bundle — the optimization is production-only.

> **History:** a module service worker (`sw.js`) owned cache invalidation through v0.28.3. It was removed in v0.28.4 — the prod build already emits a single hashed bundle, so the SW only duplicated what content hashing does (and added an offline shell the Android app doesn't use and the web didn't need). `index.html` carries a one-time teardown snippet that unregisters any lingering SW and drops its `leludo-*` caches on returning visitors; delete it once traffic has cycled past the SW era.

## Versioning

Single source of truth: `VERSION` constant in [version.js](version.js). Consumed by `wc-quick-start` (landing footer), `wc-settings` (about dialog), `scripts/platform/analytics.js` (telemetry `app_version`), and the Android version sync. The components barrel re-exports it.

**Bump on every change that lands on `main`** — user-visible polish, gameplay tweaks, AND internal refactors / cleanups / dependency bumps. It drives the about-dialog/footer string, analytics `app_version`, the Android `versionName`/`versionCode`, and keeps the changelog honest. (Asset cache busting no longer depends on it — that rides on content-hashed filenames; see Cache Busting.) Semver-ish:
- Patch (`0.X.Y+1`) — bug fix, polish, copy tweak, internal cleanup, refactor, dead-code removal
- Minor (`0.X+1.0`) — new feature, AI/UX change, gameplay logic
- Major (`X+1.0.0`) — breaking save format, full rewrite

Edit `version.js`, and keep `package.json`'s `version` in lockstep — the version-sync test enforces equality. No other steps for web. For Android, `npm run android:prepare` mirrors it into `build.gradle` via [tools/sync-android-version.mjs](tools/sync-android-version.mjs).

**`versionCode` is channel-banded** (`MP_CHANNEL` env): `band * 1e7 + base` where `base = major*1e6+minor*1e3+patch` (field caps major 0..9, minor 0..999, patch 0..999 — `computeVersionCode` throws on overflow) and the band comes from the [tools/release-channels.mjs](tools/release-channels.mjs) registry (`prod` 0, `open` 10, `closed` 20, `beta`/internal 30 — spaced by 10 to leave insertion room). `versionName` is the VERSION verbatim and identical across channels — that is all players see. Production is lowest and every test channel sits above it (Play serves a multi-track user the highest code, so testers never get pulled onto prod). See CI / `computeVersionCode`. Don't renumber existing bands or exceed band 209 (Play's 2.1e9 ceiling).

## Changelog

Public release notes live at [changelog.html](changelog.html). Newest entry on top.

**Every VERSION bump must add a changelog entry.** Copy the most recent `<article>` block, change the version + date, fill in the new content. Keep the layout shell (icon row, `.frame`, `.surface-card` sections) consistent with `privacy.html`.

Minimum sections per entry:
- **Highlights** — short bullet list of changes. For user-visible diffs, describe what the player will see. For pure internal work (refactors, dead-code removal, dep bumps), say so plainly — e.g. "Internal code cleanup: …. No gameplay or UI changes." Don't invent user-facing narrative.
- For Play Store releases only (versions actually shipped to a listing): also include **Play Store description — short** (≤80 chars) and **Play Store description — full** sections so the published copy stays in sync with the app.

**Play "What's new" no longer comes from the changelog.** The
`release_notes` input on `release.yml` (production) / `release-beta.yml`
(internal) is the store text; a workflow step writes it to
`dev-assets/distribution/whatsnew/whatsnew-en-US` and **fails the release
if it exceeds 500 chars** (Play's en-US cap). So author release notes
fresh in the dispatch form — they don't have to mirror the changelog.

The changelog itself isn't length-capped by the pipeline anymore, but
keep Highlights concise. [tools/extract-whatsnew.mjs](tools/extract-whatsnew.mjs)
still derives ≤500-char notes from the current entry (no longer auto-wired
into a release — handy if you want to paste the changelog bullets into the
`release_notes` field). Sanity-check the changelog length while drafting:

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('changelog.html','utf8');const a=html.match(/<article[^>]*>([\s\S]*?)<\/article>/)[1];const ul=a.match(/Highlights[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/)[1];const b=[...ul.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(m=>m[1].replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim());console.log(b.map(x=>'• '+x).join('\n').length,'chars')"
```

## Android (Capacitor)

Capacitor's `webDir` is `www/`, which is **built** from `src/` by `tools/build-www.mjs` (the three HTMLs + `changelog.css` + `manifest.json` + `version.js` + `theme-boot.js` + the content-hashed `app` / `analytics` / `game` bundles + inlined critical CSS + the `styles/` and `assets/` trees). The raw `components/` and `scripts/` source trees are **not** copied — only the bundles ship, so the APK carries no dead unminified source. `www/` is gitignored.

Scripts in `package.json`:

- `npm run android:prepare` — version sync → build:www → `cap sync android` (prod channel: prod backend, `versionCode = base`).
- `npm run android:prepare:beta` / `npm run android:run:beta` — same, with `MP_CHANNEL=beta` (beta backend baked in, banded internal-track `versionCode`). Use for an on-device internal/beta build; CI does this in `release-beta.yml`.
- `npm run android:open` / `npm run android:run` — prepare + open/run in Android Studio.

Anything that works in the browser ships to Android as long as `npm run android:prepare` runs first.
