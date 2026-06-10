#!/usr/bin/env node
// Wipe the online-multiplayer e2e recordings so each run keeps ONLY the latest
// videos on disk. Invoked by the `test:e2e:online` npm script before Playwright
// runs. Safe to run standalone: it just removes .local/recordings/online/ if present.
import { rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RECORDINGS_DIR = join(ROOT, '.local', 'recordings', 'online');

async function main() {
    await rm(RECORDINGS_DIR, { recursive: true, force: true });
    await mkdir(RECORDINGS_DIR, { recursive: true });
    console.log(`Cleared recordings → ${RECORDINGS_DIR}`);
}

// Only run when invoked directly (not when imported by the spec for the path).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
