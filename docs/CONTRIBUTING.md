# Contributing

Thanks for your interest. This is a small hobby project — keep changes focused and the bar is "does it make the game better".

## Before you start

1. **Open an issue first** for anything non-trivial (feature, behaviour change, refactor). A short description of the problem and your proposed approach is enough.
2. **Link the issue from your PR** — `Fixes #N` or `Refs #N` in the description.

Tiny fixes (typo, broken link, one-line bug) can skip the issue.

## Local setup

```bash
npm install
npm run dev      # five-server on :8888 (no build step)
npm test         # vitest watch mode
npm run test:e2e # Playwright smoke suite
```

See [README.md](README.md) for the short version, [CLAUDE.md](CLAUDE.md) for the full repo map and architecture notes.

## House rules

- **Vanilla JS + Web Components + hand-written CSS; no bundler in dev.** Don't introduce a framework. Dev serves raw ES modules + individual stylesheets; the production bundle is assembled by [tools/build-www.mjs](../tools/build-www.mjs). New components ship as `components/wc-foo.js` + `components/wc-foo.css`; export the JS from `components/index.js` and link the CSS from `index.html` — build-www folds both into the hashed bundles automatically.
- **User-visible change?** Bump `VERSION` in [version.js](version.js) and add an entry to [changelog.html](changelog.html) (semver: patch = fix/polish, minor = feature, major = breaking).
- **Pure logic stays pure.** `scripts/game-logic.*.js` must remain side-effect-free so the test suite can import it directly.
- **Pause respect.** Any bot or autoplay `setTimeout` in the turn flow must go through `scheduleTurn` — see the Pause Model section of CLAUDE.md.

## Submitting

- Describe what changed and why. Screenshots / short clips for UI work help a lot.
- Test the golden path *and* an edge case in the browser before opening the PR.
- Keep PRs small. Multiple narrow PRs land faster than one sprawling one.

## Reviews

I (Vishal) review when I can. Expect comments — please respond or push updates. If a PR sits stale for a long time, ping the issue.
