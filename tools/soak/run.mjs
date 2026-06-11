#!/usr/bin/env node
/**
 * Soak harness CLI.
 *
 *   node tools/soak/run.mjs [--env=local] [--games=10] [--runs=100] ...
 *
 * Runs many concurrent private multiplayer matches and asserts every client's
 * believed state lines up with the server's at every step. Exits non-zero on any
 * confirmed desync (CI-friendly). See README.md for the full config reference.
 *
 * Common flags (CLI > env > --config JSON > defaults):
 *   --env local|beta|prod          target server (beta/prod need --i-understand-prod)
 *   --games N                      concurrent matches (alias of --concurrentGames)
 *   --runs N                       total games (alias of --totalRuns); or --durationMs
 *   --players N                    human-driven seats per game (2..4)
 *   --seatMix humans|humans+bots|1human+bots
 *   --seed N                       master seed
 *   --strictness strict|positions-only|eventual
 *   --faults.dropProb 0.1 --faults.throttle.batchMs 250 --faults.reconnect.atTurn 20 --faults.reconnect.count 2
 *   --faultsAll                    apply faults to every human seat
 *   --backend worker|browser
 */
import { loadConfig } from './config.mjs';
import { createReporter } from './reporter.mjs';
import { runSoak } from './orchestrator.mjs';

// Flag aliases so the common cases read naturally.
const ALIASES = { '--games': '--concurrentGames', '--runs': '--totalRuns', '--players': '--playersPerGame' };
const argv = process.argv.slice(2).map((a) => {
    for (const [from, to] of Object.entries(ALIASES)) {
        if (a === from) return to;
        if (a.startsWith(from + '=')) return to + a.slice(from.length);
    }
    return a;
});

let config;
let warnings = [];
try {
    ({ config, warnings } = loadConfig({ argv }));
} catch (e) {
    console.error('config error:', e.message);
    process.exit(2);
}

for (const w of warnings) console.warn('⚠ ', w);

const runStamp = stamp();
config.runStamp = runStamp;

const reporter = createReporter({
    outDir: config.outDir,
    runStamp,
    logFrames: config.logFrames,
    quiet: config.quiet,
});

let summary;
try {
    if (config.backend === 'browser') {
        const { runBrowserSoak } = await import('./backends/browser/browser-runner.mjs');
        summary = await runBrowserSoak(config, reporter);
    } else {
        summary = await runSoak(config, reporter);
    }
} catch (e) {
    console.error('soak run failed:', e && e.stack || e);
    process.exit(1);
}

process.exit(summary && summary.pass ? 0 : 1);

/** Filesystem-safe run stamp: YYYYMMDD-HHMMSS. */
function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
