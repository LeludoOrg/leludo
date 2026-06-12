#!/usr/bin/env node
// Populate www/ with files Capacitor should ship to the APK + GitHub Pages.
// Skips tests, tools, source design assets, etc.
//
// www/ is also a PRODUCTION-ONLY optimization pass. Dev serves src/ as raw
// ES modules + individual <link> stylesheets (localhost is fast, zero build).
// The deployed build instead ships:
//   - app.js   — the whole ES-module graph bundled + minified (one request)
//   - game.css — every non-critical stylesheet concatenated, loaded
//                non-render-blocking
//   - inline <style> in index.html — the critical CSS the landing needs,
//                so first paint costs zero stylesheet round trips
// index.html and sw.js are rewritten here to point at those artifacts. The
// per-module source files are still copied into www/ (other tooling + the CI
// smoke test expect them) but are no longer referenced or precached.

import { build as esbuild, transform as esbuildTransform } from 'esbuild';
import { rm, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'src');
const www = resolve(root, 'www');

// The ES-module entry points pulled in by index.html, in load order. Bundled
// into a single app.js so the cold load is one request + one parse instead of
// ~50 module fetches discovered level by level.
const MODULE_ENTRIES = ['components/index.js', 'scripts/index.js'];

// Stylesheets inlined into <head> for instant first paint. The landing screen
// (wc-quick-start) needs only the design tokens/layout in base.css plus its
// own component CSS; everything else is in-game and can load lazily. Paths are
// web-root-relative and must match the hrefs in index.html.
const CRITICAL_CSS = ['styles/base.css', 'components/wc-quick-start.css'];

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

// Bundle + minify the whole static-import graph into www/app.js. A tiny
// synthetic entry imports both barrels in their original load order so
// custom-element registration and startup side effects fire as before.
async function bundleJs() {
  const contents = MODULE_ENTRIES.map((e) => `import './${e}';`).join('\n');
  await esbuild({
    stdin: { contents, resolveDir: src, loader: 'js', sourcefile: 'app-entry.js' },
    bundle: true,
    minify: true,
    format: 'esm',
    target: ['es2020'],
    outfile: resolve(www, 'app.js'),
    legalComments: 'none',
  });
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

// Rewrite www/index.html: inline critical CSS, fold the rest into a
// non-blocking game.css, and collapse the two module scripts into app.js.
async function transformIndexHtml() {
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
  await writeFile(resolve(www, 'game.css'), gameCss);

  // 1) Collapse the two module entry scripts into the single bundle.
  const scriptRe =
    /[ \t]*<script type="module" src="components\/index\.js"><\/script>\n[ \t]*<script type="module" src="scripts\/index\.js"><\/script>\n/;
  if (!scriptRe.test(html)) {
    throw new Error('build-www: module entry <script> tags not found in index.html');
  }
  html = html.replace(scriptRe, '    <script type="module" src="app.js"></script>\n');

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
    `    <link rel="stylesheet" href="game.css" media="print" onload="this.media='all'"/>\n` +
    `    <noscript><link rel="stylesheet" href="game.css"/></noscript>`;
  const marker = /[ \t]*<!-- BUILD:HEAD[\s\S]*?-->/;
  if (!marker.test(html)) {
    throw new Error('build-www: BUILD:HEAD marker not found in index.html');
  }
  html = html.replace(marker, headBlock);

  await writeFile(indexPath, html);
  return { critical, game };
}

// Rewrite the shipped sw.js PRECACHE: drop the per-module JS/CSS entries (now
// bundled) and precache app.js + game.css instead. Everything else (HTML,
// base.css for the changelog/privacy pages, version.js, fonts, sounds) stays.
async function transformSw() {
  const swPath = resolve(www, 'sw.js');
  let sw = await readFile(swPath, 'utf8');
  const block = sw.match(/const PRECACHE = \[([\s\S]*?)\];/);
  if (!block) throw new Error('build-www: PRECACHE array not found in sw.js');

  const entries = [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const kept = entries.filter(
    (e) => !/^components\/.+\.(js|css)$/.test(e) && !/^scripts\/.+\.js$/.test(e),
  );
  // Insert the bundles right after the './' navigation root.
  const at = kept[0] === './' ? 1 : 0;
  kept.splice(at, 0, 'app.js', 'game.css');

  const arr = `const PRECACHE = [\n${kept.map((e) => `  '${e}',`).join('\n')}\n];`;
  sw = sw.replace(/const PRECACHE = \[[\s\S]*?\];/, arr);
  await writeFile(swPath, sw);
  return kept.length;
}

await rm(www, { recursive: true, force: true });
await mkdir(www, { recursive: true });

for (const item of SHIPPED) {
  await cp(resolve(src, item), resolve(www, item), { recursive: true });
}

await bundleJs();
const { game } = await transformIndexHtml();
const precacheCount = await transformSw();

console.log(
  `Built www/ (${SHIPPED.length} entries) → app.js bundle, ` +
    `critical CSS inlined + game.css (${game.length} sheets), ` +
    `${precacheCount} precache entries`,
);
