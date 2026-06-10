#!/usr/bin/env node
// Populate www/ with files Capacitor should ship to the APK.
// Skips tests, tools, source design assets, etc.

import { rm, mkdir, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src');
const www = resolve(root, 'www');

const SHIPPED = [
  'index.html',
  'changelog.html',
  'privacy.html',
  'changelog.css',
  'manifest.json',
  'sw.js',
  'version.js',
  'theme-boot.js',
  'styles',
  'components',
  'scripts',
  'assets',
  // GitHub Pages chrome — copied so the same www/ tree can be used
  // both for Capacitor (which ignores these) and for Pages deploys
  // (which need the custom domain CNAME + .nojekyll to opt out of
  // Jekyll processing).
  'CNAME',
  '.nojekyll',
];

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

for (const item of SHIPPED) {
  await cp(resolve(src, item), resolve(www, item), { recursive: true });
}

console.log(`Built www/ (${SHIPPED.length} entries)`);
