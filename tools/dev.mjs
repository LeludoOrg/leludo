#!/usr/bin/env node
// Dev: serve the web root (src/) via five-server on port 8888 (no build step —
// browsers load CSS + ES modules directly) AND run the multiplayer backend on
// 8890 so online play works out of the box. Without the second process, "Find a
// public match" / private rooms have no backend and hang forever on "Finding
// players…".
//
// The backend is the REAL Cloudflare Worker (src/server/cf/) under `wrangler dev`
// — local workerd/miniflare running the same Durable Objects, storage, alarms and
// output gate as production. Dev therefore matches the deployed runtime exactly:
// editing server code makes wrangler restart workerd, which EVICTS the DOs (an
// in-memory wipe + socket teardown — the same thing a code deploy does), so a
// reconnect must resume the live game via the DO's persist/restore (room-do.js,
// v0.28.5). That dev/prod parity is the point — a Node `ws` shell (the retired
// src/server/local-server.mjs) couldn't reproduce DO eviction, which is how the
// "deploy kills the game" bug shipped undetected.
//
// DEV_TEST_HOOKS=1 (passed as a wrangler --var, never in the deployed wrangler.toml)
// turns on the deterministic seed / grace override / __busy__ room the e2e suite
// relies on; the caps are lifted far above any dev session so admission never
// rejects locally. DO storage persists to the default .wrangler/state, so a game
// survives a wrangler reload (the parity demo above).

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const procs = [];
function run(label, cmd, args, env, cwd = root) {
  const p = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  p.on('error', (err) => {
    console.error(`[dev] failed to start ${label}:`, err.message);
    shutdown();
  });
  procs.push(p);
  return p;
}

// Static site (five-server, port 8888) + multiplayer backend (wrangler dev, port
// 8890). The static server runs with cwd=src/ (the web root); wrangler runs at the
// repo root where wrangler.toml lives. Playwright reuses an already-running dev
// server locally (reuseExistingServer), so the dev backend and the e2e backend
// must honour the same hooks — both pass DEV_TEST_HOOKS / lifted caps via --var,
// keeping them out of the deployed config.
run('static-server', 'npx', ['five-server', `--port=${PORTS.DEV_STATIC}`, '--open=/'], undefined, resolve(root, 'src'));
run('mp-server', 'npx', [
  '--yes', 'wrangler', 'dev',
  '--port', String(PORTS.MP_SERVER),
  '--var', 'DEV_TEST_HOOKS:1',
  '--var', 'MAX_GAMES_PER_DAY:1000000',
  '--var', 'MAX_CONCURRENT_GAMES:100000',
]);

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
