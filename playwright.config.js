import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './tools/ports.mjs';

const PORT = PORTS.E2E_STATIC;
const BASE_URL = `http://localhost:${PORT}`;
const MP_PORT = PORTS.MP_SERVER; // multiplayer backend (wrangler dev — the real CF Worker)

// Throwaway Durable Object storage for the e2e backend. `wrangler dev` persists DO
// state (room snapshots + admission counters) to disk; if that leaked across runs a
// stale snapshot under a reused room code would `_restore` a previous run's game and
// flake the suite. We point --persist-to here and wipe it at boot, so every run gets
// virgin DO storage. Lives under .local/ (gitignored).
const MP_STATE_DIR = '.local/wrangler-e2e-state';

export default defineConfig({
    testDir: './src/test/e2e',
    testMatch: '**/*.spec.js',
    outputDir: './.local/test-results',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
        baseURL: BASE_URL,
        trace: 'on-first-retry',
    },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ],
    webServer: [
        {
            command: `node tools/serve-static.mjs ${PORT}`,
            url: BASE_URL,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
        },
        {
            // Server-authoritative multiplayer runtime for the e2e suite — the REAL
            // Cloudflare Worker (src/server/cf/) under `wrangler dev` (local
            // workerd/miniflare), so the e2e backend matches production's Durable
            // Object semantics exactly (storage, alarms, output gate, eviction). The
            // retired Node `ws` server couldn't reproduce those.
            //
            // --var DEV_TEST_HOOKS:1 turns on the deterministic seed / ?grace
            // override / __busy__ room the specs need (gated off in deployed prod;
            // see src/server/cf/worker.js + room-do.js). The whole suite runs against
            // ONE long-lived backend, so the prod free-tier admission caps (15
            // concurrent / 45 games-per-day) would accumulate across tests (× CI
            // retries) and start rejecting creates with BUSY_DAILY partway through —
            // flaking any later create/join. Lift the caps far above any suite size;
            // the BUSY overlay itself is exercised deterministically via the
            // __busy__ / forceBusy path, not the real counter. Wipe the DO state dir
            // first so a prior run's room snapshots can't resurrect mid-suite.
            command: `rm -rf ${MP_STATE_DIR} && npx --yes wrangler dev --port ${MP_PORT} --persist-to ${MP_STATE_DIR} --var DEV_TEST_HOOKS:1 --var MAX_GAMES_PER_DAY:1000000 --var MAX_CONCURRENT_GAMES:100000`,
            url: `http://localhost:${MP_PORT}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
        },
    ],
});
