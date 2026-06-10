import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the offline shell.
 *
 * sw.js precaches the app shell so the game works offline + survives a release
 * (the cache key is VERSION). When a new component or script lands but nobody
 * adds it to PRECACHE, returning users keep a stale cached version of it — or
 * it's simply missing offline. Likewise every component stylesheet must be
 * <link>ed from index.html or the component renders unstyled.
 *
 * This test walks the source tree and fails — naming the exact files — if any
 * shippable module is missing from PRECACHE, or any component CSS is missing
 * from index.html's stylesheet links. It reads sw.js + index.html as TEXT and
 * never modifies them.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** All *.js / *.css under a dir tree, returned as repo-root-relative POSIX paths. */
function walk(dir, exts) {
    const out = [];
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            out.push(...walk(rel, exts));
        } else if (exts.some((e) => entry.name.endsWith(e))) {
            out.push(rel);
        }
    }
    return out;
}

// Barrels are re-export shims that aren't precached individually (and aren't
// loaded as standalone shell entries); *.test.js never ships.
const EXCLUDE = new Set(['components/index.js', 'scripts/index.js']);
const isTest = (p) => p.endsWith('.test.js');

const swText = readFileSync(resolve(root, 'sw.js'), 'utf8');
const indexHtml = readFileSync(resolve(root, 'index.html'), 'utf8');

/** The string entries of the PRECACHE array literal in sw.js. */
function precacheEntries() {
    const block = swText.match(/const\s+PRECACHE\s*=\s*\[([\s\S]*?)\]/);
    expect(block, 'PRECACHE = [...] array not found in sw.js').toBeTruthy();
    return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const PRECACHE = new Set(precacheEntries());

describe('PRECACHE covers every shippable component + script', () => {
    const componentFiles = walk('components', ['.js', '.css'])
        .filter((p) => !EXCLUDE.has(p) && !isTest(p));
    const scriptFiles = walk('scripts', ['.js'])
        .filter((p) => !EXCLUDE.has(p) && !isTest(p));
    const shippable = [...componentFiles, ...scriptFiles];

    it('found a non-trivial set of source files to check', () => {
        // Sanity: if the walk silently returns nothing, the test would pass
        // vacuously. Pin a floor so a broken glob can't hide drift.
        expect(componentFiles.length).toBeGreaterThan(5);
        expect(scriptFiles.length).toBeGreaterThan(20);
    });

    it('lists every components/*.{js,css} and scripts/**/*.js in sw.js PRECACHE', () => {
        const missing = shippable.filter((p) => !PRECACHE.has(p));
        expect(
            missing,
            `These files exist on disk but are missing from PRECACHE in sw.js:\n` +
                `${missing.map((m) => `  - ${m}`).join('\n')}\n` +
                `Add each to the PRECACHE array so it's cached offline + invalidated on release.`,
        ).toEqual([]);
    });
});

describe('index.html links every component stylesheet', () => {
    const componentCss = walk('components', ['.css']).filter((p) => !isTest(p));

    it('found component CSS files to check', () => {
        expect(componentCss.length).toBeGreaterThan(5);
    });

    it('has a <link rel="stylesheet"> for every components/*.css', () => {
        const linked = new Set(
            [...indexHtml.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/g)].map((m) => m[1]),
        );
        const missing = componentCss.filter((p) => !linked.has(p));
        expect(
            missing,
            `These component stylesheets exist on disk but are not <link>ed from index.html:\n` +
                `${missing.map((m) => `  - ${m}`).join('\n')}\n` +
                `Add a <link rel="stylesheet" href="..."> for each or the component renders unstyled.`,
        ).toEqual([]);
    });
});
