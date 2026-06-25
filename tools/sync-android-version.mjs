#!/usr/bin/env node
// Mirror the VERSION constant from version.js into
// android/app/build.gradle (versionName + versionCode).
//
// versionName is the human string users see (Play listing + in-app About);
// it is the VERSION verbatim and is IDENTICAL across channels.
//
// versionCode is the hidden integer Play uses for upload-uniqueness + update
// ordering. It is BANDED by release channel via the registry in
// tools/release-channels.mjs (production lowest, more-internal test tracks
// higher — see that file for the full rationale). The channel is the SAME
// MP_CHANNEL env that selects the backend in tools/build-www.mjs, so one flag
// drives both the bundle and the version code.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion } from './read-version.mjs';
import { computeVersionCode, isValidChannel, CHANNEL_NAMES } from './release-channels.mjs';

// CLI entrypoint — skip when imported (e.g. by a test).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('sync-android-version.mjs')) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');

  const version = await readVersion(root);
  const channel = process.env.MP_CHANNEL || 'prod';
  if (!isValidChannel(channel)) {
    throw new Error(`sync-android-version: MP_CHANNEL must be one of ${CHANNEL_NAMES.join(', ')}, got '${channel}'`);
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
