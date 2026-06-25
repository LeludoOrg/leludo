import { describe, it, expect } from 'vitest';
import { computeVersionCode } from '../../../tools/sync-android-version.mjs';

/**
 * Channel-banded Android versionCode. The beta build ships to the Play internal
 * track and the prod build to production; Play rejects duplicate version codes
 * and serves a dual-eligible tester the HIGHEST code across their tracks, so the
 * beta code must stay ABOVE prod forever or beta testing dies after the first
 * prod ship. Guards the band math + the 2.1e9 Play ceiling.
 */
describe('computeVersionCode', () => {
    it('prod uses the plain semver base (major*10000 + minor*100 + patch)', () => {
        expect(computeVersionCode('0.28.7', 'prod')).toBe(2807);
        expect(computeVersionCode('1.2.3', 'prod')).toBe(10203);
    });

    it('defaults to prod when no channel is given', () => {
        expect(computeVersionCode('0.28.7')).toBe(2807);
    });

    it('beta adds the 1e9 band so it sits above EVERY prod code', () => {
        expect(computeVersionCode('0.28.7', 'beta')).toBe(1_000_002_807);
        // Even the largest realistic prod base (99.99.99 → 999_999) is below the
        // smallest beta code, so a tester is never pulled off the beta channel.
        expect(computeVersionCode('0.0.0', 'beta'))
            .toBeGreaterThan(computeVersionCode('99.99.99', 'prod'));
    });

    it('stays under Play\'s 2,100,000,000 versionCode ceiling at the max version', () => {
        expect(computeVersionCode('99.99.99', 'beta')).toBeLessThan(2_100_000_000);
    });

    it('throws on a non-semver string', () => {
        expect(() => computeVersionCode('beta')).toThrow(/semver/);
    });
});
