# Update-nudge test strategy

Covers the in-app update nudge added in v0.29.8:
[`src/scripts/platform/app-update.js`](../src/scripts/platform/app-update.js),
wired at boot from [`src/scripts/index.js`](../src/scripts/index.js).

Two platforms, two mechanisms:

- **Android** — Play In-App Update API (flexible flow) via
  `@capawesome/capacitor-app-update`, reached through
  `window.Capacitor.Plugins.AppUpdate`.
- **Web** — re-fetch `index.html`, diff the content-hashed `app.<hash>.js`
  filename against the one this page loaded; mismatch → `.update-toast`
  "Refresh" bar.

Both fire on **app open and every foreground/resume**, gated by a 4 h check
throttle (`UPDATE_CHECK_AT`); the native consent sheet is gated by a 24 h
throttle (`UPDATE_PROMPT_AT`).

---

## 1. Unit tests (automated, CI) — `npm run test:run`

Lives in [`src/test/scripts/app-update.test.js`](../src/test/scripts/app-update.test.js).
Runs in `happy-dom`; the native plugin is mocked
(`window.Capacitor.Plugins.AppUpdate`), `document.scripts` + `fetch` are
stubbed for the web path. This is the regression backstop — every behaviour
below must keep a green assertion.

| # | Case | Expectation |
|---|------|-------------|
| A1 | Android: update available + `flexibleUpdateAllowed` | `startFlexibleUpdate()` called once; `onFlexibleUpdateStateChange` listener wired |
| A2 | Android: no update available | no `startFlexibleUpdate` |
| A3 | Android: only immediate (`flexibleUpdateAllowed: false`) | skipped — never blocks launch |
| A4 | Android: consent shown < 24 h ago (`UPDATE_PROMPT_AT`) | no re-prompt |
| A5 | Android: download already in progress + `DOWNLOADED` | `completeFlexibleUpdate()` called, no re-consent |
| A6 | Android: state listener reaches `DOWNLOADED` | restart prompt (`completeFlexibleUpdate`) fires |
| A7 | Android: `getAppUpdateInfo` rejects | swallowed — `initAppUpdate()` resolves, boot intact |
| A8 | Android: plugin absent in native shell | no-op |
| W1 | Web: deployed hash ≠ loaded hash | `.update-toast` injected |
| W2 | Web: deployed hash == loaded hash | no toast |
| W3 | Web: no hashed bundle (dev) | `index.html` never fetched, no toast |
| T1 | Check ran < 4 h ago (`UPDATE_CHECK_AT`) | `getAppUpdateInfo` not called |
| T2 | Foreground after throttle lapses | re-checks (second `getAppUpdateInfo`) |

**Gaps unit tests cannot cover** (drive the manual passes below):
- Real Play download/install lifecycle and the consent UI.
- Real content-hash flip across an actual deploy.
- WebView lifecycle events (`resume`, `appStateChange`) on a device.

---

## 2. Web manual pass (testable locally / on beta)

The web path needs a **real hashed build**, so use `npm run build:www`
output or a deployed site — not `npm run dev` (no hash → no-op by design).

### 2a. Local
1. `node tools/build-www.mjs` → serve `www/` (e.g. `npx serve www` or
   `node tools/serve-static.mjs`). Note the `app.<hash>.js` in the page.
2. Open the site, leave the tab open.
3. Change any source file → `node tools/build-www.mjs` again (new hash).
4. Re-serve the new `www/`, then **foreground the old tab** (click away and
   back, or switch tabs and return).
5. **Expect:** "A new version is available" toast appears. Tap **Refresh** →
   page reloads on the new hash; toast does not reappear.

### 2b. Beta (real deploy)
1. Open `beta.leludo.org`, leave the tab open.
2. Push a trivial change to `main` (auto-deploys `leludo-beta`).
3. Foreground the tab after the deploy completes.
4. **Expect:** Refresh toast. Reload lands on the new build.

### Web edge cases to eyeball
- **Throttle:** background/foreground rapidly — only one `index.html` fetch
  per 4 h (check `UPDATE_CHECK_AT` in DevTools → Application → Local Storage).
- **Offline:** kill network, foreground → no toast, no error (fetch fails
  silently). Restore network, foreground after throttle → toast.
- **Dismiss-by-reload:** toast stays until the user refreshes; it must not
  re-spam on every foreground within the session.
- **Theming:** confirm toast legibility in light + dark.
- **Overlap:** toast sits at z-70 above overlays; confirm it doesn't trap the
  primary CTA on the smallest supported viewport.

---

## 3. Android manual pass (Play-only — cannot be faked)

> **Hard constraint:** Play In-App Update returns an update **only** for a
> build Play itself installed, signed with the release key. A debug APK,
> `npm run android:run`, emulator sideload, or `adb install` reports **no
> update** — the flow is unobservable that way. This is a Google restriction,
> not a project bug.

### Setup — get two builds onto the Play **internal** track
1. Cut build **N** (e.g. 0.29.7), dispatch `release-beta.yml` (builds the
   `MP_CHANNEL=beta` AAB → Play internal track).
2. Enrol the test device in the internal track; install build **N** **from
   the Play Store** (not sideloaded).
3. Bump VERSION to **N+1** (0.29.8), dispatch `release-beta.yml` again so a
   higher `versionCode` sits on the internal track. Wait for Play to process
   it (can take 10–30 min).

### Test — flexible flow
1. Open the app on build **N** (Play now has **N+1** available).
2. **Expect:** Play's flexible-update consent sheet appears. Tap **Update**.
3. Keep playing — download proceeds in the background, no interruption.
4. When the download finishes, **expect** Play's "restart to install" prompt.
   Tap restart → app relaunches on **N+1** (check About dialog / footer
   version).
5. **Ignore-path variant:** at step 4, don't tap restart; background the app
   and relaunch later → the downloaded update installs on the next restart.

### Resume-trigger check
1. On build **N** (before **N+1** is live), open the app — no update.
2. Publish **N+1**, wait for processing.
3. **Without cold-starting**, background the app and foreground it again.
4. **Expect:** the consent sheet appears on resume (proves the resume path,
   not just boot).

### Android edge cases
- **Consent throttle:** dismiss the sheet; reopen within 24 h → no re-prompt
  (clear `UPDATE_PROMPT_AT` to force it).
- **Mid-game:** trigger a resume mid-game → flexible sheet is non-blocking;
  the game must not break or force a restart unprompted.
- **Immediate-only release:** set the release's update priority high enough
  that Play disallows flexible → confirm we **skip** (no blocking fullscreen
  on launch) rather than hang.
- **No-Play install:** sideload the same versionName → confirm graceful
  no-op (no crash, no error toast).

---

## 4. Regression / CI gate

- `npm run test:run` must stay green (table in §1).
- New behaviour ⇒ new assertion in `app-update.test.js` (project bug-fix
  discipline — see `CLAUDE.md`).
- No E2E (Playwright) coverage: the web path needs a real hashed build the
  static E2E server doesn't produce, and the Android path is Play-gated. If
  we later want automated web coverage, add a Playwright case that serves a
  pre-built `www/`, swaps in a second build with a different hash, and
  asserts the toast on refocus.

---

## Quick reference — what's testable where

| Layer | Android in-app update | Web refresh toast |
|-------|----------------------|-------------------|
| Unit (CI) | ✅ mocked plugin | ✅ stubbed fetch/scripts |
| Local manual | ❌ Play-gated | ✅ built `www/` |
| Beta deploy | ✅ internal track | ✅ `beta.leludo.org` |
| Prod | ✅ production track | ✅ `leludo.org` |
