# Play Store "What's new"

`whatsnew-en-US` is the **single source** for the Play Store "What's new"
text. Both `release.yml` (production track) and `release-beta.yml`
(internal track) point `whatsNewDirectory` straight at this directory, so
prod and the internal/beta build always ship the SAME notes — a tester
never sees a generic "internal testing build" string anymore.

**Edit this file as part of every release that changes the app.** It is
NOT auto-derived from `changelog.html` (the web changelog runs long and
detailed; the store cap is tight), and it is NOT a workflow-dispatch input
anymore (GitHub's single-line dispatch field silently stripped newlines).
A committed file keeps real line breaks and is reviewable in the PR.

Rules:
- One bullet per line, each prefixed `• `.
- Real newlines between bullets (they render as line breaks on Play).
- No trailing newline.
- ≤500 chars (Play's en-US cap). `src/test/tools/store-notes.test.js`
  fails the `test` job — which gates both Play upload jobs — if it's over,
  so an over-long file can never reach the store.

The action strips the `whatsnew-` prefix and treats the rest as the
locale, so the filename MUST stay `whatsnew-en-US` (no extension). Add
`whatsnew-<locale>` siblings here to localize.
