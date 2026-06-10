#!/usr/bin/env node
// Dev: serve the repo root via five-server on port 8888 (no build step —
// browsers load CSS + ES modules directly) AND run the multiplayer ws server
// on 8890 so online play works out of the box. Without the second process,
// "Find a public match" / private rooms have no backend and hang forever on
// "Finding players…". In production the same online traffic hits a Cloudflare
// Worker; locally it's server/local-server.mjs.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const procs = [];
function run(label, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  p.on('error', (err) => {
    console.error(`[dev] failed to start ${label}:`, err.message);
    shutdown();
  });
  procs.push(p);
  return p;
}

// Static site (port 8888) + multiplayer ws server (port 8890).
// The mp-server runs with DEV_TEST_HOOKS so the LOCAL dev backend honours the
// same deterministic hooks (seed / grace override / __busy__ room) the Playwright
// e2e suite relies on. Playwright reuses an already-running dev server locally
// (reuseExistingServer), so without this the reused server silently ignores
// ?grace=/seed=/__busy__ and those e2e specs fail only on dev machines, never CI.
run('static-server', 'npx', ['five-server', `--port=${PORTS.DEV_STATIC}`, '--open=/']);
run('mp-server', 'node', [resolve(root, 'server/local-server.mjs'), String(PORTS.MP_SERVER)], { DEV_TEST_HOOKS: '1' });

let down = false;
const shutdown = () => {
  if (down) return;
  down = true;
  for (const p of procs) { if (!p.killed) p.kill('SIGTERM'); }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// If either process exits, tear the whole dev session down so a half-dead
// state (static up, multiplayer down) can't masquerade as working.
for (const p of procs) p.on('exit', () => shutdown());
