import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Two projects so the Durable Object wiring is exercised in the SAME runtime it
// deploys to, without dragging the rest of the suite into it:
//   - `unit`    : the pure logic + DOM suite, fast, under happy-dom.
//   - `workers` : *.workers.test.js run inside real workerd via miniflare, with
//                 the actual wrangler.toml bindings (ROOM/ADMISSION/MATCH DOs),
//                 so acceptWebSocket / getWebSockets / setWebSocketAutoResponse /
//                 alarms behave exactly as in production.
export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'unit',
                    environment: 'happy-dom',
                    include: ['src/test/**/*.test.js'],
                    exclude: ['src/test/**/*.workers.test.js'],
                    globals: false,
                },
            },
            {
                plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.toml' } })],
                test: {
                    name: 'workers',
                    include: ['src/test/**/*.workers.test.js'],
                },
            },
        ],
        coverage: {
            provider: 'v8',
            reportsDirectory: '.local/coverage',
            reporter: ['text', 'html'],
            include: ['src/scripts/**/*.js', 'src/components/**/*.js'],
            exclude: ['**/index.js'],
        },
    },
});
