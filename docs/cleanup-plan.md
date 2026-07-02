# Cleanup Plan — vibe-code audit (Phase 1 output)

Audit of `src/scripts/`, `src/components/`, `src/server/`, `src/styles/`,
`src/index.html`, graded against CLAUDE.md's stated conventions (DRY /
"duplication is a bug", pure-logic vs side-effect module boundaries, design
tokens, bug-fix-needs-a-regression-test). Every file in those trees was read.

**Explicitly NOT flagged (load-bearing per CLAUDE.md / in-code docs):** the
channel-banded versionCode scheme, the pause/scheduleTurn model, god-mode
parity wiring, the sw.js teardown snippet in index.html (already marked
"delete once traffic cycles" — leaving on its stated timeline), the unreachable
three-sixes backstops (documented guards in game-driver / command-handler /
room-engine), the resident-not-hibernated DO model, MatchmakingDO staying
deployed while the client ships private-rooms-only, `multiplayer.html` itself
(live e2e harness), and wc-game-end.css's own `--ge-*` token block (a
deliberate standalone recap palette).

Rules for Phase 2 executors: one item = one mergeable unit. Do NOT bump
VERSION or touch changelog.html per item — that's item 18, once, at the end.
Run `npm run test:run` after every item; also `npm run test:e2e` where the
item says so.

---

## 1. Fix stale/misplaced comments in render-logic.js + base.css

- **Files:** `src/scripts/render/render-logic.js`, `src/styles/base.css`
- **Problem (stale comments):**
  - `render-logic.js:424-426` — a JSDoc block for
    `(playerIndex, tokenIndex, currentTokenPosition, newTokenPosition)` sits
    directly above `waitForTransitionEnd(el, onSettle, fallbackMs)` — wrong
    function (it describes `updateTokenContainer`, 230 lines below).
  - `render-logic.js:814-818` — a JSDoc for `(currentPlayerIndex, tokenIndex)`
    sits above `const _bouncingTokens = new Set()`.
  - `render-logic.js:924-927` — `applyColorMap`'s JSDoc says
    `@param {number} currentPlayerIndex`; the parameter is `colorMap`.
  - `base.css:668` — `z-index: 70; /* above .frame-overlay (60) */` —
    `.frame-overlay` is z-index 50 (`base.css:286`).
- **Fix:** delete/correct the JSDoc blocks; fix the z-index comment.
- **Risk:** low (comment-only).
- **Test:** none needed (no behavior).

## 2. Fix stale "local Node ws server" comments in server modules

- **Files:** `src/server/cf/worker.js`, `src/server/admission.js`,
  `src/server/matchmaker.js`, `src/server/cf/match-do.js`,
  `src/multiplayer.html`
- **Problem:** the Node `ws` dev server was deleted in v0.28.6 (dev + e2e now
  run the real Worker under `wrangler dev` — `transport-shell.js` says so
  correctly). But: `worker.js:4-8` still says "the SAME runtime-agnostic
  modules the local Node ws server uses" and references "local-server's
  /stats" and "the local-server TEST_HOOKS path"; `admission.js:5-8` lists
  "the local Node ws server (dev + Playwright e2e)" as a runtime;
  `matchmaker.js:10-12` claims identity "across the Node ws server, a
  Cloudflare DO, and unit tests"; `match-do.js:15-16` says "The local Node
  server cheats this by re-binding the same socket". Also
  `multiplayer.html`'s header says "The real wc-board integration is a later
  phase" — it shipped long ago; the page is now purely the e2e harness.
- **Fix:** reword the comments to reflect the wrangler-dev-only reality; keep
  all code unchanged.
- **Risk:** low (comment-only).
- **Test:** none needed.

## 3. Update CLAUDE.md's stale module map

- **Files:** `CLAUDE.md`
- **Problem:** the Architecture / Pause / God-mode / Test-overrides sections
  predate the `scripts/` re-org:
  - `scripts/` now has `core/ state/ render/ net/ platform/ listeners/`
    subtrees; CLAUDE.md lists flat `game-events, game-logic, render-logic,
    bot-ai, bot-names` and links `scripts/game-logic.js`,
    `scripts/command-handler.js`, `scripts/god-mode.js` (all moved).
  - `game-events.js` no longer exists (replaced by
    `state/command-handler.js` + `listeners/*`); "handleDiceRoll and
    handleOnTokenMove also early-return when paused" names functions that are
    now `rollDice` / `selectToken`; "handleGameStart in
    scripts/game-events.*.js" is now `startGame` in
    `state/command-handler.js`.
  - God-mode section says finish-cell arrival plays `playFinishArrival` — no
    such function exists (it's `playFinishSound` inside
    `updateTokenContainer`'s finish path, which godTeleport reuses).
- **Fix:** rewrite those sections to the current layout/function names. No
  code changes.
- **Risk:** low (docs-only).
- **Test:** none needed.

## 4. render-logic: import PAWN_ASPECT instead of redefining PAWN_H

- **Files:** `src/scripts/render/render-logic.js`,
  `src/scripts/render/pawn-shape.js`
- **Problem:** `render-logic.js:220` — `const PAWN_H = 1.16; // pawn height /
  width (see pawn-shape.js)` re-types the literal that `pawn-shape.js`
  already exports as `PAWN_ASPECT = 1.16`. Exactly the drift CLAUDE.md's DRY
  section forbids (the comment even points at the source it should import).
- **Fix:** delete `PAWN_H`, import `PAWN_ASPECT` and use it in the five
  call sites.
- **Risk:** low (pure constant swap).
- **Test:** none new (pure dedup; stacking covered by e2e board specs).

## 5. render-logic: drop dead corner-widget parameters

- **Files:** `src/scripts/render/render-logic.js`,
  `src/scripts/state/command-handler.js`
- **Problem (dead code):**
  - `pillMarkup(idx, finished, active)` (`render-logic.js:1003`) never uses
    `finished`; `updateCornerWidgets` computes
    `const finished = _getFinishedCount(idx)` (line 1033) only to pass it in.
  - `moveDice()` (`render-logic.js:1112`) takes no parameters but every call
    site passes `state.currentPlayerIndex` (command-handler lines 263, 300,
    432, 536, 695); it's also a single-line alias for `updateCornerWidgets`.
- **Fix:** remove the `finished` param + dead computation; either delete the
  `moveDice` alias (call `updateCornerWidgets()` directly) or keep the name
  and drop the phantom arguments — pick one, apply everywhere.
- **Risk:** low.
- **Test:** none new (no behavior change; corner-widget e2e exists).

## 6. Share one NAME_MAX constant for online display names

- **Files:** `src/server/room-engine.js` (`NAME_MAX = 12`),
  `src/components/wc-game-room.js` (`maxlength="12"` at :291),
  `src/components/wc-quick-start.js` (`_myName().slice(0, 12)` at :658),
  `src/scripts/net/net-protocol.js` (new export)
- **Problem:** the 12-char online-name cap is three independent literals; the
  server comment even says it "mirrors the client's maxlength" — the classic
  two-copies-drift setup.
- **Fix:** export `export const NAME_MAX = 12;` from `net-protocol.js` (the
  shared client/server wire module) and import it in all three places.
- **Risk:** low.
- **Test:** none new (pure dedup; room-engine name-clamp tests exist).

## 7. Dedupe the dice pip-layout tables

- **Files:** `src/scripts/render/render-logic.js` (`DIE_PIPS`, :967),
  `src/components/wc-icons.js` (`PIP_LAYOUTS` inside `DICE_SVG`, :9),
  `src/components/wc-dice.js` (hand-written per-face pip markup)
- **Problem:** three independent encodings of which pips a die face shows.
  `DIE_PIPS`'s own comment says "mirrors wc-dice" — a mirror is a drift bug
  waiting to happen per CLAUDE.md.
- **Fix:** one canonical pip table (suggest exporting from `wc-icons.js` or a
  tiny `scripts/core/dice-faces.js`), consumed by `staticDieMarkup`
  (render-logic), `DICE_SVG` (wc-icons), and used to *generate* the six
  `.dice-face` divs in `wc-dice.js` instead of hand-written HTML. Keep the
  `d1..d6` ids and grid-row/column output identical (updateDiceFace and
  wc-dice.css depend on them).
- **Risk:** low-med (markup generation must byte-match the current classes/ids).
- **Test:** none new required (pure dedup); run `npm run test:e2e` since it
  touches rendering.

## 8. Retire the unused public-matchmaking feature flag honestly

- **Files:** `src/components/wc-quick-start.js`
- **Problem (dead/deprecated):** `PUBLIC_MATCH_ENABLED` (:24) is declared and
  never read — the "Find a public match" entry UI was deleted outright, so
  flipping the flag does nothing, yet its comment (and one in
  `test/e2e/online-screens.spec.js`) claims it gates the feature.
  `_enterMatchmaking` / `showOnlineSearch` are unreachable from any UI (kept
  deliberately: the MatchmakingDO backend stays deployed per
  `match-do.js`'s header; the QUEUED/MATCHED message handling is the client
  half of that plan).
- **Fix:** delete the dead const; replace with an accurate comment on
  `_enterMatchmaking` ("dormant — no UI entry point; re-wire a button here
  to relaunch public matchmaking, see server/cf/match-do.js"). Fix the stale
  flag references in the e2e spec comments. Do NOT delete the dormant
  methods (documented parity with the deployed backend).
- **Risk:** low.
- **Test:** none new.

## 9. Move the test-only transport seam out of the app tree

- **Files:** `src/scripts/net/transport/in-process-channel.js`,
  `src/scripts/net/transport/mock-network-channel.js`,
  `src/scripts/net/transport/event-hub.js`,
  `src/test/integration/transport.test.js`
- **Problem (dead code / premature abstraction):** nothing in the app imports
  any of these — the only consumer is `transport.test.js`.
  `in-process-channel.js`'s header claims it is "the seam used by solo +
  local pass-and-play", which is false (the store is dispatched directly).
  `mock-network-channel.js` is explicitly a test double.
- **Fix:** delete `in-process-channel.js` (and its stale claim); move
  `mock-network-channel.js` + `event-hub.js` under `src/test/` (they're test
  scaffolding), updating `transport.test.js` imports. If the mock-network
  serialization check is still valued, the test keeps running unchanged from
  its new home.
- **Risk:** low-med (test-tree churn only; no shipped code affected).
- **Test:** existing `transport.test.js` keeps passing (or is trimmed with
  the deleted channel).

## 10. Delete dead spreadSeatPlan + unused RoomEngine seatPlan option

- **Files:** `src/scripts/core/seat-allocation.js`,
  `src/server/room-engine.js`, `src/test/scripts/seat-allocation.test.js`
- **Problem (dead code):** `spreadSeatPlan` has no callers outside its own
  test (it was for the deleted Node-server matchmaking path; the CF
  matchmaker mints a room and lets seats fill via `_pickSeat`). Likewise
  `RoomEngine`'s `opts.seatPlan` (:96, :144) is never passed by any caller
  (room-do passes `size` only).
- **Fix:** delete `spreadSeatPlan` + its test block; drop the `seatPlan`
  option and its constructor branch. Keep `ringDistance`/`spreadPick` (live:
  lobby seat spreading). If item 8's dormant-matchmaking stance argues for
  keeping it, keep it — but then fix its comment to say it's dormant;
  default recommendation is delete (it's reconstructible from git).
- **Risk:** low-med.
- **Test:** trim the deleted cases from `seat-allocation.test.js`; run suite.

## 11. room-engine: stop re-implementing shared game rules

- **Files:** `src/server/room-engine.js`, `src/scripts/core/game-driver.js`,
  `src/scripts/core/board-util.js`, `src/scripts/core/turn-rules.js`
- **Problem (duplication — the highest-value DRY item):**
  1. `room-engine.js:70-89` `applyMove` is a verbatim copy of
     `game-driver.js:56-82` `applyMove` (its comment even says "Mirrors
     game-driver.applyMove").
  2. `room-engine.js:65-67` `cloneBoard` re-implements
     `clonePositions(positions, null)` from `board-util.js` — the exact
     helper board-util's header says was "copy-pasted in five places" and
     centralised.
  3. `room-engine.js:982-983` computes `playsAgain` inline —
     `(dice === 6 || captureCount > 0 || tripComplete) && !isPlayerFinished`
     — duplicating `grantsAnotherTurn` from `turn-rules.js`, whose doc
     comment exists precisely "so the two turn state machines can't
     diverge".
- **Fix:** export `applyMove` from `game-driver.js` (or a new
  `core/board-moves.js` if the driver import feels off) and import it in
  room-engine; delete `cloneBoard` in favor of `clonePositions`; import and
  use `grantsAnotherTurn`.
- **Risk:** med (authoritative server turn machine) — but all three
  replacements are semantically identical and covered by the online e2e
  suites.
- **Test:** pure dedup, no new test required; run `npm run test:run` +
  `npm run test:e2e` (online specs exercise the server engine via wrangler).

## 12. bot-ai: derive legality/captures from game-logic instead of copies

- **Files:** `src/scripts/core/bot-ai.js`, `src/scripts/core/game-logic.js`
- **Problem (duplication):** `legalMoves` (:109-121) re-implements
  `isTokenMovable` + the unique-position dedup (`getUniqueTokenPositions`
  exists); `applyMove` (:87-107) re-implements `getTokenNewPosition` +
  capture detection (incl. the two-token pair-safety rule, phrased as
  `hits.length === 1` instead of game-logic's `length === 2 → clear`). The
  search runs at depth ≤ 1 over ≤ 4 moves × 6 faces, so there is no perf
  excuse ("no standalone-no-deps excuse" per CLAUDE.md).
- **Fix:** rewrite `legalMoves` on top of `isTokenMovable` (+ seen-position
  dedup), and `applyMove` on top of `getTokenNewPosition` +
  `findCapturedOpponents`. `SAFE_SQUARES`-as-Set and `threatCount` stay (the
  threat model is genuinely bot-specific).
- **Risk:** med (bot behavior must not change; the two capture phrasings are
  equivalent but this must be verified, not assumed).
- **Test:** extend `bot-ai.test.js` with a case pinning capture-on-pair
  squares (bot must NOT count a 2-stack as capturable) so the rewrite is
  provably behavior-preserving.

## 13. wc-quick-start: stop duplicating the seat-placement algorithm

- **Files:** `src/components/wc-quick-start.js` (`_startGame`, :954-989),
  `src/scripts/core/game-logic.js` (`getPlayerTypes`)
- **Problem (duplication):** `_startGame` builds `namesByPlayerIndex` with
  its own copy of the placement algorithm (HUMAN_PREFERRED_POSITIONS for
  humans, first-free-position scan for bots, special 4-human case) that must
  stay in lockstep with `getPlayerTypes`' decoding of the same
  `quickStartId` — if either drifts, names attach to the wrong seats.
- **Fix:** extract one pure helper in `game-logic.js` (e.g.
  `planSeats(humans, bots)` returning per-board-position assignments) used
  by both `getPlayerTypes` (decode path) and `_startGame` (encode path), or
  have `_startGame` call `getPlayerTypes(quickStartId)` and place names off
  its output.
- **Risk:** med (game-start wiring, offline names).
- **Test:** extend `game-logic.test.js` / `wc-quick-start.test.js` with a
  mixed 2-human+1-bot lineup asserting name↔type↔color alignment
  (regression per CLAUDE.md discipline, since a drift here is a real
  reported-class bug).

## 14. Single source of truth for the turn counter

- **Files:** `src/scripts/render/render-logic.js` (module-local `turnCount`,
  :937, 1085-1110), `src/scripts/state/command-handler.js`,
  `src/scripts/listeners/persistence-listener.js`
- **Problem (duplicated state / latent bug):** two independent turn
  counters: the reducer's `state.turnCount` (bumped on TURN_ADVANCED) and
  render-logic's module-local `turnCount` (bumped by `updateTurnCounter()` in
  `advanceToNextPlayer`). They can drift: `advanceToNextPlayer` calls
  `updateTurnCounter()` even when `getNextPlayerIndex` returns -1 and no
  TURN_ADVANCED is emitted — and the *persisted save* uses the render copy
  (`persistence-listener.js:44` `getTurnCount()`), so a drifted display
  counter gets written into `ludo-save` and resurrected as authoritative on
  resume.
- **Fix:** make `state.turnCount` the only counter. Render-logic keeps only
  the paint (`renderTurnCount(state.turnCount)` or a listener on
  TURN_ADVANCED/GAME_STARTED/GAME_RESUMED/NET_STATE_SYNCED); delete
  `updateTurnCounter`/`resetTurnCount`/`setTurnCount`/`getTurnCount`
  mutations of the local var; persistence saves `state.turnCount`.
- **Risk:** med (touches save format producer, online turn label, pause
  scoreboard label).
- **Test:** required (behavior fix). Vitest: dispatch a game where a move
  ends with no next player → assert saved `turnCount` equals
  `state.turnCount`; and resume-path asserts the label renders the saved
  value. Confirm the test FAILS against the dual-counter code first.

## 15. Theme-color meta: kill the dead #header branch, fix dark-theme drift

- **Files:** `src/components/wc-settings.js` (`updateTheme`, :173-195),
  `src/scripts/state/command-handler.js` (`resetThemeChrome`, :184-188),
  `src/components/wc-game-end.js` (:372-379), `src/scripts/platform/native-bars.js`
- **Problem (dead code + latent bug):**
  - `updateTheme` reads `rootElement.querySelector("#header")` — no element
    with id `header` exists anywhere in the app, so the theme-color meta is
    NEVER updated on theme switch; the hardcoded `#EFE9DC` from index.html
    persists (light status-bar tint over the dark theme on web).
  - `resetThemeChrome` hardcodes `#EFE9DC` ("restore the light-theme
    chrome") — exiting a game in dark theme sets a light meta.
  - `wc-game-end.js` stores `this._prevThemeColor` and never restores it
    (dead write); it hardcodes `#1a1410`/`#ede4d3`.
  - Four hardcoded hexes total for what is conceptually `--color-bg`.
- **Fix:** one helper (e.g. `platform/theme-chrome.js`) that resolves the
  active theme background (reuse native-bars' `themeBackgroundHex` probe,
  exported) and writes the meta; call it from `updateTheme`,
  `resetThemeChrome`, game-end mount/unmount. Delete the `#header` branch
  and `_prevThemeColor`.
- **Risk:** med (visual chrome across web + Android WebView; native bars
  must keep working — `applyNativeBarTheme` already handles the native side,
  don't double-drive it).
- **Test:** required (bug fix). Vitest (happy-dom): switch theme dark→light
  → meta content tracks the resolved `--color-bg`; exit-to-home in dark →
  meta does not revert to the light hex. Confirm failing-first.

## 16. command-handler: extract the shared capture-animation block

- **Files:** `src/scripts/state/command-handler.js` (`selectToken`
  :587-644, `netApplyMove` :324-386, `godTeleport` :761-825)
- **Problem (duplication in the core gameplay path):** the
  pin-victims → build `attack` (penultimate-cell `prevCellId`) → `fireCaptures`
  closure (emit TOKEN_CAPTURED + `animateCaptureToHome` into `captureAnims`)
  → `updateTokenContainer(..., { onArrive: fireCaptures })` →
  `Promise.all(captureAnims)` choreography is copy-pasted three times with
  small input differences (captures from `findCapturedOpponents` vs the
  server frame; god-mode's extra GOD_TELEPORTED emit). CLAUDE.md's god-mode
  parity rule makes this triplication actively dangerous: a new
  transition-bound effect must be added in three places today.
- **Fix:** one helper, e.g.
  `runCaptureMove({ playerIndex, tokenIndex, from, to, victims, beforeCaptures, emit })`
  that owns pinning, the attack vector, onArrive firing and awaiting the
  capture anims; the three callers pass their victim list (and god-mode its
  GOD_TELEPORTED emit as `beforeCaptures`). Behavior must be identical,
  including firing order (emit before animate, onArrive before settle).
- **Risk:** med-high care, low semantic delta (pure extraction). Gameplay +
  god-mode parity + online replay all funnel through it.
- **Test:** no new test strictly required (pure dedup), but run the full
  suite + `npm run test:e2e` (capture/KO/god-mode specs exist and cover all
  three paths).

## 17. Delete the dead playPawnLaunch overlay (and retarget its e2e spec)

- **Files:** `src/scripts/render/pawn-launch.js`,
  `src/test/e2e/pawn-launch.spec.js`
- **Problem (dead code guarded by a test for dead UI):** the app's launch
  path (`render-logic.playYardLaunch`) uses only `playLaunchStartFX` +
  `playPawnStep` — the full `playPawnLaunch` leap (trail ghosts, `arcAngle`,
  crouch/leap/land keyframes, `playLandingFX` with the 'GO!' chip,
  CHIP_DELAY/CHIP_VISIBLE consts) is called by nothing but its own e2e spec.
  Players never see the 'GO!' chip the spec so carefully asserts is
  readable.
- **Fix:** delete `playPawnLaunch`, `arcAngle`, `playLandingFX`, the trail
  block, the chip constants, and the now-unused CSS rules
  (`.plnch-trail-*`, `.plnch-label*`) from the injected stylesheet. Keep
  `playLaunchStartFX` + `spawnStartFX` (live). Rewrite
  `pawn-launch.spec.js` to assert the LIVE launch path instead (its first
  test already drives `updateTokenContainer`'s yard→entry branch; drop/port
  the chip-readability tests).
- **Risk:** med (e2e rewrite; visual FX file).
- **Test:** the reworked e2e spec IS the deliverable; run
  `npm run test:e2e`.

## 18. Decide: remove (or wire up) the four unused highlight-reel stats

- **Files:** `src/scripts/state/game-reducer.js`,
  `src/scripts/state/game-state.js`, `src/components/wc-game-end.js`,
  `src/scripts/render/end-highlights.js`, tests
- **Problem (dead plumbing):** the reducer meticulously tracks
  `bestDiceStreak` (whole DICE_ROLLED streak machinery),
  `firstHomeStretchTurn`, `firstFinishTurn`, and `pawnsAtBaseAtTurn20`
  (turn-20 sampling in TURN_ADVANCED); game-state exports them;
  `wc-game-end.buildStats` and `selectHighlightsBySeat` ship them across —
  and `selectHighlights` reads none of them. Only `playerCaptures`,
  `sentHomeCount`, `distanceTraveled` feed cards. The `EndStats` typedef and
  the unused `'crown'` card type document pickers that no longer exist.
- **Fix (recommended):** delete the four stats end to end (state fields,
  reducer updates, exports, buildStats/reorder entries, typedef lines,
  related reducer tests). Alternative if new pickers are actually planned:
  add the pickers instead — but don't keep write-only state.
- **Risk:** med (reducer + state surface + tests; no player-visible change).
- **Test:** update `game-reducer.test.js` / `end-highlights.test.js` for the
  removed fields; suite must pass.

## 19. Converge the four mini-pawn SVG wrappers

- **Files:** `src/scripts/render/pawn-mini.js` (new builder),
  `src/components/wc-icons.js` (`PAWN_SVG`),
  `src/scripts/render/render-logic.js` (`PAWN_SVG_MINI`),
  `src/components/wc-game-end.js` (`pawnSvg`),
  `src/scripts/render/share-image.js` (`pawnSvgString`);
  also `wc-game-end.js`'s local `ICON_BACK` (duplicates `wc-icons.ICON_BACK`
  modulo size).
- **Problem (duplication with subtle drift):** four hand-rolled `<svg
  viewBox="0 0 32 32">` wrappers around `MINI_PAWN_BODY` differ only in:
  base-shadow ellipse (present ×3, absent in game-end), highlight path
  (absent in render-logic's), drop-shadow filter (three different values),
  fill source (class vs explicit color), sizing (100% vs px). pawn-mini's
  header calls this legitimate, but CLAUDE.md's DRY rule says: make the
  differences explicit parameters of one shared helper, don't keep four
  copies.
- **Fix:** add `miniPawnSVG({ fillClass|fillColor, size, shadowEllipse,
  highlight, dropShadow })` to `pawn-mini.js`; replace the four wrappers;
  update pawn-mini's header. Swap wc-game-end's local `ICON_BACK` for the
  wc-icons import (accepting the shared 17px size or parameterizing it).
- **Risk:** med (four visual surfaces: home chip, pause scoreboard, recap,
  share PNG).
- **Test:** none new (visual); run `npm run test:e2e`
  (game-end-standings / board-styles specs) and eyeball the recap + share
  image.

## 20. Final item: VERSION bump + changelog entry for the cleanup batch

- **Files:** `src/version.js`, `package.json`, `src/changelog.html`
- **Problem:** per CLAUDE.md, every change landing on main bumps VERSION and
  adds a changelog entry; per this plan, items 1-19 don't do it
  individually.
- **Fix:** after the last accepted item merges: one patch bump (internal
  cleanup ⇒ `0.X.Y+1`), both files in lockstep (version-sync test enforces),
  plus a changelog `<article>` stating plainly: "Internal code cleanup:
  deduplicated game-rule helpers, removed dead code, doc fixes. No gameplay
  or UI changes." — except items 14/15 which ARE behavior fixes; name them
  ("fixed the turn counter drifting in saved games; theme-colored browser
  chrome now follows dark mode").
- **Risk:** low.
- **Test:** version-sync test; changelog length sanity-check snippet from
  CLAUDE.md.

---

## Deliberately not made items (audit notes)

- `game-driver.js:208-214` copies `result.next` back into `positions` with a
  nested per-cell loop — mildly over-wrought (a per-row splice would do) but
  harmless and reference-preserving; not worth churn.
- `wc-dice.css` / board shadows use raw rgba/hex for skeuomorphic dice and
  shadow tints — plausibly-intentional material styling, not token drift.
- `wc-token.css`'s `#ff00ff` god-mode pulse — debug-only surface, fine.
- Fallback colors `'#cf4a3a'`/`'#2f9456'`/`'#d97644'` in overlay modules —
  only used when computed styles are unavailable (headless); harmless.
- `escapeHtml` living in render-logic — odd placement, but single-sourced
  and re-exported via the barrel; moving it is churn without payoff.
- `wc-game-end.css`'s `--ge-cta-bg/--ge-cta-fg` repeat base.css's
  `--cta-bg/--cta-fg` hex pairs — the recap palette is documented as
  standalone; left alone.
