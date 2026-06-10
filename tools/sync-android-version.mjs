#!/usr/bin/env node
// Mirror the VERSION constant from version.js into
// android/app/build.gradle (versionName + versionCode).
// versionCode is derived from semver: major*10000 + minor*100 + patch.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVersion } from './read-version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const version = await readVersion(root);

const semver = version.match(/^(\d+)\.(\d+)\.(\d+)/);
if (!semver) throw new Error('VERSION not semver: ' + version);
const [, maj, min, pat] = semver.map(Number);
const versionCode = Number(maj) * 10000 + Number(min) * 100 + Number(pat);

const gradlePath = resolve(root, 'android/app/build.gradle');
let gradle = await readFile(gradlePath, 'utf8');
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
await writeFile(gradlePath, gradle);

console.log(`android version → ${version} (code ${versionCode})`);
