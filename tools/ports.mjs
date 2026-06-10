// Single source of truth for the dev/test server ports.
//
// - DEV_STATIC: the five-server static site for `npm run dev`.
// - E2E_STATIC: the headless static server Playwright boots for e2e.
// - MP_SERVER:  the multiplayer ws backend (server/local-server.mjs). Both the
//   dev session and the Playwright suite run it with DEV_TEST_HOOKS=1 so the
//   deterministic seed / grace override / __busy__ room hooks are honoured.
//
// Keeping these here means tools/dev.mjs and playwright.config.js can't drift
// apart on which port talks to what.

export const PORTS = {
  DEV_STATIC: 8888,
  E2E_STATIC: 8889,
  MP_SERVER: 8890,
};
