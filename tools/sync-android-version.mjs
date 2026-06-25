#!/usr/bin/env node
// Mirror the VERSION constant from version.js into
// android/app/build.gradle (versionName + versionCode).
//
// versionName is the human string users see (Play listing + in-app About);
// it is the VERSION verbatim and is IDENTICAL across channels.
//
// versionCode is the hidden integer Play uses for upload-uniqueness + update
// ordering. It is BANDED by release channel:
//   - prod  → base                     (e.g. 0.28.7 → 2807)
//   - beta  → 1_000_000_000 + base     (e.g. 0.28.7 → 1_000_002_807)
// where base = major*10000 + minor*100 + patch.
//
// Why band: the beta-channel build ships to the Play INTERNAL track and the
// prod build ships to PRODUCTION. Play rejects two uploads sharing a versionCode,
// and serves a dual-eligible user (every internal tester is also a production
// user) the HIGHEST versionCode across their tracks. So the beta code must sit
// ABOVE prod forever — otherwise, once any prod release ships, every later beta
// (lower code) becomes invisible to testers and beta testing silently dies.
// The 1e9 band keeps beta above prod (prod base maxes at 999_999 for 99.99.99)
// with ~1.1e9 of headroom below Play's 2_100_000_000 cap. The channel is the
// SAME MP_CHANNEL env that selects the backend in tools/build-www.mjs, so one
// flag drives both the bundle and the version code.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion } from './read-version.mjs';

const BETA_BAND = 1_000_000_000;

/** Channel-banded Android versionCode for a semver string. */
export function computeVersionCode(version, channel = 'prod') {
  const semver = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!semver) throw new Error('VERSION not semver: ' + version);
  const [, maj, min, pat] = semver.map(Number);
  const base = maj * 10000 + min * 100 + pat;
  return channel === 'beta' ? BETA_BAND + base : base;
}

// CLI entrypoint — skip when imported (e.g. by the version-code test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync-android-version.mjs')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');

  const version = await readVersion(root);
  const channel = process.env.MP_CHANNEL || 'prod';
  if (channel !== 'prod' && channel !== 'beta') {
    throw new Error(`sync-android-version: MP_CHANNEL must be 'prod' or 'beta', got '${channel}'`);
  }
  const versionCode = computeVersionCode(version, channel);

  const gradlePath = resolve(root, 'android/app/build.gradle');
  let gradle = await readFile(gradlePath, 'utf8');
  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
  await writeFile(gradlePath, gradle);

  console.log(`android version → ${version} (code ${versionCode}, channel ${channel})`);
}
