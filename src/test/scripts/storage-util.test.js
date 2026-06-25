import { describe, it, expect, beforeEach } from 'vitest';
import { readBool, writeBool } from '../../scripts/platform/storage-util.js';

// readBool / writeBool centralise the `=== 'true'` read + stringify-on-write
// the sound-mute, god-mode, and assist toggles each re-typed. The fallback
// behaviour (missing key → caller default) is what readAssistPref relied on.
describe('storage-util bool prefs', () => {
    beforeEach(() => localStorage.clear());

    it('reads a stored "true" as true and anything else as false', () => {
        localStorage.setItem('k', 'true');
        expect(readBool('k')).toBe(true);
        localStorage.setItem('k', 'false');
        expect(readBool('k')).toBe(false);
        localStorage.setItem('k', 'garbage');
        expect(readBool('k')).toBe(false);
    });

    it('returns the fallback for a missing key', () => {
        expect(readBool('absent')).toBe(false);       // default fallback
        expect(readBool('absent', true)).toBe(true);  // explicit fallback (assist defaults)
    });

    it('round-trips through writeBool as the strings "true"/"false"', () => {
        writeBool('k', true);
        expect(localStorage.getItem('k')).toBe('true');
        expect(readBool('k')).toBe(true);
        writeBool('k', false);
        expect(localStorage.getItem('k')).toBe('false');
        expect(readBool('k')).toBe(false);
    });
});
