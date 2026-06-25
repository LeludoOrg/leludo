import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../version.js';

/**
 * package.json "version" must stay in lockstep with VERSION in version.js.
 *
 * version.js is the single source of truth the about dialog, analytics,
 * and the Android sync all read. package.json carries its own "version" field;
 * if the two drift, the npm package version lies about what's shipping. They
 * were synced to 0.20.0 — this test fails CI the moment one is bumped without
 * the other.
 */
describe('package.json version stays in sync with version.js', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

    it('package.json version === VERSION', () => {
        expect(pkg.version).toBe(VERSION);
    });
});
