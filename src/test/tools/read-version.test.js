import { describe, it, expect } from 'vitest';
import { readVersion } from '../../../tools/read-version.mjs';
import { VERSION } from '../../version.js';

/**
 * readVersion() is the one shared parse of version.js used by the Android
 * version sync and the Play Store whatsnew extractor. Guard that it returns the
 * same value the rest of the app imports, and that a malformed source fails
 * loudly rather than yielding undefined.
 */
describe('readVersion', () => {
    it('returns the VERSION exported by version.js (repo root default)', async () => {
        expect(await readVersion()).toBe(VERSION);
    });

    it('throws when the VERSION constant is missing', async () => {
        // Point it at a dir with no parseable version.js (vitest cwd / tmp).
        await expect(readVersion('/nonexistent-dir-for-leludo-test')).rejects.toThrow();
    });
});
