#!/usr/bin/env node
// Populate www/ with files Capacitor should ship to the APK.
// Skips tests, tools, source design assets, etc.

import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src');
const www = resolve(root, 'www');

// The ES-module entry points pulled in by index.html. Everything reachable
// from these (via static imports) is what the browser would otherwise discover
// one waterfall level at a time on a cold load.
const MODULE_ENTRIES = ['components/index.js', 'scripts/index.js'];

// Walk the static-import graph from the entries (BFS so heavily-shared modules
// surface early) and return every reachable file as a web-root-relative path.
function moduleGraph(entries) {
  const queue = entries.map((e) => resolve(src, e));
  const order = [];
  const seen = new Set();
  const importRe = /(?:import|export)[^;]*?\sfrom\s*["']([^"']+)["']/g;
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    order.push(relative(src, file));
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(importRe)) {
      const spec = m[1];
      if (!spec.startsWith('.')) continue; // bare/remote specifiers: not preloadable
      let dep = resolve(dirname(file), spec);
      if (!existsSync(dep) && existsSync(dep + '.js')) dep += '.js';
      queue.push(dep);
    }
  }
  return order;
}

// Replace the BUILD:MODULEPRELOAD marker in the built index.html with one
// <link rel="modulepreload"> per reachable module, so the deployed build fetches
// the whole graph in parallel instead of level by level.
async function injectModulePreloads() {
  const indexPath = resolve(www, 'index.html');
  const html = await readFile(indexPath, 'utf8');
  const mods = moduleGraph(MODULE_ENTRIES);
  const links = mods
    .map((p) => `    <link rel="modulepreload" href="${p}"/>`)
    .join('\n');
  const block = `    <!-- modulepreload graph injected by tools/build-www.mjs (${mods.length} modules) -->\n${links}`;
  const marker = /[ \t]*<!-- BUILD:MODULEPRELOAD[\s\S]*?-->/;
  if (!marker.test(html)) {
    throw new Error('build-www: BUILD:MODULEPRELOAD marker not found in index.html');
  }
  await writeFile(indexPath, html.replace(marker, block));
  return mods.length;
}

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

const preloaded = await injectModulePreloads();

console.log(`Built www/ (${SHIPPED.length} entries, ${preloaded} modulepreload links)`);
