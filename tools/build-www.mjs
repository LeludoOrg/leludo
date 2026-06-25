#!/usr/bin/env node
// Populate www/ with the files Capacitor ships to the APK + Cloudflare Pages
// serves at leludo.org. Skips tests, tools, source design assets, etc.
//
// www/ is a PRODUCTION-ONLY optimization pass. Dev serves src/ as raw ES
// modules + individual <link> stylesheets (localhost is fast, zero build).
// The deployed build instead ships content-hashed bundles:
//   - app.<hash>.js      — the whole index.html ES-module graph, bundled +
//                          minified (one request)
//   - analytics.<hash>.js — the tiny analytics module graph the changelog /
//                          privacy pages load on their own (no app bundle)
//   - game.<hash>.css    — every non-critical stylesheet, concatenated and
//                          loaded non-render-blocking
//   - inline <style> in index.html — the critical CSS the landing needs, so
//                          first paint costs zero stylesheet round trips
// The hash in each filename IS the cache-busting mechanism: a content change
// yields a new name, so browsers fetch it immediately while unchanged bundles
// stay cached. index.html + the two aux pages are rewritten here to point at
// the hashed artifacts. The per-component source trees are NOT shipped — only
// the bundles run in prod.

import { build as esbuild, transform as esbuildTransform } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidChannel, CHANNEL_NAMES } from './release-channels.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src');
const www = resolve(root, 'www');

// Release channel for this build (registry: tools/release-channels.mjs).
// Stamped into the app bundle so the native APK dials the matching multiplayer
// backend (BUILD_CHANNEL in scripts/net/net-client.js): a test-channel build →
// the isolated beta Worker, the prod build → the prod Worker. 'prod' is the
// default; the test CI paths / `npm run build:www:beta` set MP_CHANNEL. Pairs
// with the versionCode band in tools/sync-android-version.mjs.
const MP_CHANNEL = process.env.MP_CHANNEL || 'prod';
if (!isValidChannel(MP_CHANNEL)) {
  throw new Error(`build-www: MP_CHANNEL must be one of ${CHANNEL_NAMES.join(', ')}, got '${MP_CHANNEL}'`);
}

// The ES-module entry points pulled in by index.html, in load order. Bundled
// into a single app.<hash>.js so the cold load is one request + one parse
// instead of ~50 module fetches discovered level by level.
const MODULE_ENTRIES = ['components/index.js', 'scripts/index.js'];

// The changelog + privacy pages don't load the app bundle — they only fire
// analytics. Bundled standalone so those pages can drop the raw scripts/ tree.
const ANALYTICS_ENTRY = 'scripts/platform/analytics.js';

// Stylesheets inlined into <head> for instant first paint. The landing screen
// (wc-quick-start) needs only the design tokens/layout in base.css plus its
// own component CSS; everything else is in-game and can load lazily. Paths are
// web-root-relative and must match the hrefs in index.html.
const CRITICAL_CSS = ['styles/base.css', 'components/wc-quick-start.css'];

// Files/dirs copied verbatim into www/. The source module trees (components/,
// scripts/) are deliberately absent — everything runnable is bundled above, so
// shipping the raw sources would only bloat the APK with dead, unminified code.
// styles/ stays because base.css is linked directly by the changelog/privacy
// pages (those aren't bundled).
const SHIPPED = [
  'index.html',
  'changelog.html',
  'privacy.html',
  'changelog.css',
  'manifest.json',
  'version.js',
  'theme-boot.js',
  'styles',
  'assets',
];

const hash8 = (data) => createHash('sha256').update(data).digest('hex').slice(0, 8);

// Bundle + minify an ES-module graph into a content-hashed file in www/.
// Returns the hashed filename so callers can rewrite the HTML references.
async function bundleEsm({ stdin, entryPoints, define }, prefix) {
  const result = await esbuild({
    ...(stdin ? { stdin } : { entryPoints }),
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020'],
    write: false,
    legalComments: 'none',
    ...(define ? { define } : {}),
  });
  const code = result.outputFiles[0].contents;
  const name = `${prefix}.${hash8(code)}.js`;
  await writeFile(resolve(www, name), code);
  return name;
}

// app.<hash>.js — the whole index.html graph. A tiny synthetic entry imports
// both barrels in their original load order so custom-element registration and
// startup side effects fire as before.
function bundleApp() {
  const contents = MODULE_ENTRIES.map((e) => `import './${e}';`).join('\n');
  return bundleEsm(
    {
      stdin: { contents, resolveDir: src, loader: 'js', sourcefile: 'app-entry.js' },
      // Replace the __MP_CHANNEL__ token in net-client.js with the build channel.
      define: { __MP_CHANNEL__: JSON.stringify(MP_CHANNEL) },
    },
    'app',
  );
}

// analytics.<hash>.js — the standalone bundle the changelog/privacy pages load.
function bundleAnalytics() {
  return bundleEsm({ entryPoints: [resolve(src, ANALYTICS_ENTRY)] }, 'analytics');
}

// Inlined/concatenated CSS lives at the document root (/), so the font
// url()s that were written relative to /styles/ (../assets/…) must be
// rewritten relative to / (assets/…).
function rebaseUrls(css) {
  return css.replace(/url\((["']?)\.\.\/assets\//g, 'url($1assets/');
}

async function readCssJoined(paths) {
  const parts = await Promise.all(paths.map((p) => readFile(resolve(src, p), 'utf8')));
  return parts.join('\n');
}

async function minifyCss(css) {
  const out = await esbuildTransform(rebaseUrls(css), { loader: 'css', minify: true });
  return out.code.trim();
}

// Rewrite www/index.html: inline critical CSS, fold the rest into a hashed
// non-blocking game.<hash>.css, and collapse the two module scripts into the
// hashed app bundle.
async function transformIndexHtml(appFile) {
  const indexPath = resolve(www, 'index.html');
  let html = await readFile(indexPath, 'utf8');

  // Discover every app-shell stylesheet <link>, in document order, then split
  // into critical (inlined) and the rest (game.css). Generic so a newly added
  // component stylesheet is folded in automatically.
  const linked = [...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"\/>/g)].map((m) => m[1]);
  const critical = linked.filter((p) => CRITICAL_CSS.includes(p));
  const game = linked.filter((p) => !CRITICAL_CSS.includes(p));

  const criticalCss = await minifyCss(await readCssJoined(critical));
  const gameCss = await minifyCss(await readCssJoined(game));
  const gameFile = `game.${hash8(gameCss)}.css`;
  await writeFile(resolve(www, gameFile), gameCss);

  // 1) Collapse the two module entry scripts into the single hashed bundle.
  const scriptRe =
    /[ \t]*<script type="module" src="components\/index\.js"><\/script>\n[ \t]*<script type="module" src="scripts\/index\.js"><\/script>\n/;
  if (!scriptRe.test(html)) {
    throw new Error('build-www: module entry <script> tags not found in index.html');
  }
  html = html.replace(scriptRe, `    <script type="module" src="${appFile}"></script>\n`);

  // 2) Drop every app-shell stylesheet <link> — now inlined or in game.css.
  html = html.replace(
    /[ \t]*<link rel="stylesheet" href="(?:styles\/base\.css|components\/[^"]+\.css)"\/>\n/g,
    '',
  );

  // 3) Replace the build marker with inline critical CSS + non-blocking
  //    game.css (the print→all swap fetches it without blocking first paint;
  //    <noscript> covers JS-disabled clients).
  const headBlock =
    `    <!-- critical CSS inlined + game.css split by tools/build-www.mjs -->\n` +
    `    <style>${criticalCss}</style>\n` +
    `    <link rel="stylesheet" href="${gameFile}" media="print" onload="this.media='all'"/>\n` +
    `    <noscript><link rel="stylesheet" href="${gameFile}"/></noscript>`;
  const marker = /[ \t]*<!-- BUILD:HEAD[\s\S]*?-->/;
  if (!marker.test(html)) {
    throw new Error('build-www: BUILD:HEAD marker not found in index.html');
  }
  html = html.replace(marker, headBlock);

  await writeFile(indexPath, html);
  return { game };
}

// Point the changelog + privacy inline module imports at the hashed analytics
// bundle so those pages run without the raw scripts/ tree.
async function transformAuxHtml(analyticsFile) {
  const importRe = /from '\.\/scripts\/platform\/analytics\.js'/;
  for (const page of ['changelog.html', 'privacy.html']) {
    const p = resolve(www, page);
    let html = await readFile(p, 'utf8');
    if (!importRe.test(html)) {
      throw new Error(`build-www: analytics import not found in ${page}`);
    }
    html = html.replace(importRe, `from './${analyticsFile}'`);
    await writeFile(p, html);
  }
}

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

for (const item of SHIPPED) {
  await cp(resolve(src, item), resolve(www, item), { recursive: true });
}

const appFile = await bundleApp();
const analyticsFile = await bundleAnalytics();
const { game } = await transformIndexHtml(appFile);
await transformAuxHtml(analyticsFile);

console.log(
  `Built www/ [channel=${MP_CHANNEL}] (${SHIPPED.length} entries) → ${appFile} + ${analyticsFile}, ` +
    `critical CSS inlined + game bundle (${game.length} sheets)`,
);
