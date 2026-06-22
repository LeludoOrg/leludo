import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './tools/ports.mjs';

const PORT = PORTS.E2E_STATIC;
const BASE_URL = `http://localhost:${PORT}`;
const MP_PORT = PORTS.MP_SERVER; // multiplayer ws server (server/local-server.mjs)

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
            // Server-authoritative multiplayer runtime for the e2e suite.
            // DEV_TEST_HOOKS enables the deterministic seed + __busy__ room used
            // by src/test/e2e/multiplayer.spec.js.
            //
            // The whole suite runs against ONE long-lived server, so the prod
            // free-tier admission caps (15 concurrent / 45 games-per-day) would
            // accumulate across tests (× CI retries) and start rejecting room
            // creates with BUSY_DAILY partway through — flaking any later create/
            // join. Lift the caps far above any suite size for the test server;
            // the BUSY overlay itself is exercised deterministically via the
            // DEV_TEST_HOOKS `__busy__` / forceBusy path, not the real counter.
            command: `DEV_TEST_HOOKS=1 MAX_CONCURRENT_GAMES=100000 MAX_GAMES_PER_DAY=1000000 node src/server/local-server.mjs ${MP_PORT}`,
            url: `http://localhost:${MP_PORT}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
        },
    ],
});
