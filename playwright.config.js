import { defineConfig, devices } from '@playwright/test';
import { PORTS } from './tools/ports.mjs';

const PORT = PORTS.E2E_STATIC;
const BASE_URL = `http://localhost:${PORT}`;
const MP_PORT = PORTS.MP_SERVER; // multiplayer ws server (server/local-server.mjs)

export default defineConfig({
    testDir: './test/e2e',
    testMatch: '**/*.spec.js',
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
            // by test/e2e/multiplayer.spec.js.
            command: `DEV_TEST_HOOKS=1 node server/local-server.mjs ${MP_PORT}`,
            url: `http://localhost:${MP_PORT}/health`,
            reuseExistingServer: !process.env.CI,
            timeout: 60_000,
        },
    ],
});
