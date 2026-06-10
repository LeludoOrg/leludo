#!/usr/bin/env node
// Extract the Highlights bullets for the current VERSION from changelog.html
// and write them to dev-assets/distribution/whatsnew/whatsnew-en-US for the Play Store
// upload step. The r0adkll/upload-google-play action strips the `whatsnew-`
// prefix and treats the remainder as the locale code — no file extension.
// Play Store caps each "What's new" locale at 500 chars.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion } from './read-version.mjs';

export const MAX_LEN = 500;

export function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

export function decodeEntities(s) {
  return s
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rdquo;/g, '”')
    .replace(/&ldquo;/g, '“')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

export function extractBullets(changelogHtml, version) {
  const articles = [...changelogHtml.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1]);
  const target = articles.find((body) => new RegExp(`>v${version.replace(/\./g, '\\.')}<`).test(body));
  if (!target) throw new Error(`No changelog article found for v${version}`);

  const highlightsBlock = target.match(/Highlights[\s\S]*?<ul[^>]*>([\s\S]*?)<\/ul>/);
  if (!highlightsBlock) throw new Error(`No Highlights <ul> in v${version} article`);

  const bullets = [...highlightsBlock[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)]
    .map((m) => decodeEntities(stripTags(m[1])).trim())
    .filter(Boolean);

  if (bullets.length === 0) throw new Error(`No <li> bullets in v${version} Highlights`);
  return bullets;
}

/**
 * Build the exact text that gets written to whatsnew-en-US. The
 * returned string is what Play Store will read — no trailing newline,
 * no truncation. r0adkll/upload-google-play measures the raw file
 * contents, so any trailing whitespace counts against the cap.
 *
 * If the joined bullets exceed `max` chars this throws an explicit
 * error with the actual length and overflow amount. Mid-sentence
 * ellipsis truncation produces ugly release notes ("…and clear it with
 * the &times; — the same controls you already kno…"), so we'd rather
 * fail the release pipeline and force the author to shorten the
 * changelog entry than ship a half-finished sentence to the Play
 * Store.
 */
export function buildWhatsnewText(bullets, max = MAX_LEN) {
  const text = bullets.map((b) => `• ${b}`).join('\n');
  if (text.length > max) {
    throw new Error(
      `whatsnew is ${text.length} chars (max ${max}, over by ${text.length - max}). ` +
      `Shorten the changelog Highlights bullets for the current VERSION — ` +
      `the Play Store rejects en-US release notes longer than ${max} characters.`,
    );
  }
  return text;
}

// CLI entrypoint — skip when imported as a module.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('extract-whatsnew.mjs')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');

  const version = await readVersion(root);

  const changelog = await readFile(resolve(root, 'src/changelog.html'), 'utf8');
  const bullets = extractBullets(changelog, version);
  const text = buildWhatsnewText(bullets);

  const outDir = resolve(root, 'dev-assets/distribution/whatsnew');
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, 'whatsnew-en-US');
  await writeFile(outPath, text);

  console.log(`whatsnew v${version} (${text.length} chars) → ${outPath}`);
}
