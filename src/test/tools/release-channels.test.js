import { describe, it, expect } from 'vitest';
import {
    computeVersionCode,
    isValidChannel,
    CHANNELS,
    CHANNEL_NAMES,
    BAND_WIDTH,
} from '../../../tools/release-channels.mjs';

const PLAY_CEILING = 2_100_000_000; // Google Play's hard versionCode max
const MAX_BASE = 99 * 10000 + 99 * 100 + 99; // 99.99.99 → 999_999

/**
 * Channel-banded Android versionCode. The rule everything hangs on: Play serves
 * a user who qualifies for multiple tracks the build with the HIGHEST
 * versionCode. So production must be the LOWEST band, and each more-internal
 * test track must sit ABOVE the less-internal ones — otherwise, once a prod
 * release ships, a test build with a lower code becomes invisible to testers.
 */
describe('computeVersionCode', () => {
    it('production is the plain semver base (lowest band)', () => {
        expect(computeVersionCode('0.28.7', 'prod')).toBe(2807);
        expect(computeVersionCode('1.2.3', 'prod')).toBe(10203);
    });

    it('defaults to prod when no channel is given', () => {
        expect(computeVersionCode('0.28.7')).toBe(2807);
    });

    it('each channel adds its band * 1e8 on top of the base', () => {
        expect(computeVersionCode('0.28.7', 'open')).toBe(100_002_807);
        expect(computeVersionCode('0.28.7', 'closed')).toBe(200_002_807);
        expect(computeVersionCode('0.28.7', 'beta')).toBe(300_002_807); // internal track
    });

    it('orders production < open < closed < internal at the same version', () => {
        const v = '0.28.7';
        const codes = ['prod', 'open', 'closed', 'beta'].map((c) => computeVersionCode(v, c));
        expect(codes).toEqual([...codes].sort((a, b) => a - b));
        expect(new Set(codes).size).toBe(codes.length); // all distinct
    });

    it('every test channel outranks EVERY production code, forever', () => {
        // The smallest test-channel code (lowest test band at 0.0.0) must still
        // beat the largest possible prod code (99.99.99) so a tester is never
        // pulled to prod.
        const smallestTestBand = Math.min(
            ...CHANNEL_NAMES.filter((c) => c !== 'prod').map((c) => CHANNELS[c].band),
        );
        expect(smallestTestBand * BAND_WIDTH).toBeGreaterThan(MAX_BASE);
    });

    it('a build base never bleeds into the next band', () => {
        // base maxes at 999_999 (< BAND_WIDTH), so adjacent bands never overlap.
        expect(MAX_BASE).toBeLessThan(BAND_WIDTH);
    });

    it('stays under Play\'s 2.1e9 ceiling for every defined channel — and band 20', () => {
        for (const c of CHANNEL_NAMES) {
            expect(computeVersionCode('99.99.99', c)).toBeLessThan(PLAY_CEILING);
        }
        // The 1e8 spacing leaves room up to band 20 (the documented max).
        expect(20 * BAND_WIDTH + MAX_BASE).toBeLessThan(PLAY_CEILING);
    });

    it('throws on an unknown channel', () => {
        expect(() => computeVersionCode('0.28.7', 'nope')).toThrow(/unknown release channel/);
    });

    it('throws on a non-semver version', () => {
        expect(() => computeVersionCode('beta', 'prod')).toThrow(/semver/);
    });
});

describe('CHANNELS registry', () => {
    it('maps the current channels to the right Play tracks', () => {
        expect(CHANNELS.prod.track).toBe('production');
        expect(CHANNELS.beta.track).toBe('internal');
    });

    it('production sits at band 0 (lowest) and bands are unique', () => {
        expect(CHANNELS.prod.band).toBe(0);
        const bands = CHANNEL_NAMES.map((c) => CHANNELS[c].band);
        expect(new Set(bands).size).toBe(bands.length);
        expect(Math.min(...bands)).toBe(0);
    });

    it('isValidChannel accepts known channels and rejects others', () => {
        expect(isValidChannel('prod')).toBe(true);
        expect(isValidChannel('beta')).toBe(true);
        expect(isValidChannel('open')).toBe(true);
        expect(isValidChannel('nope')).toBe(false);
        expect(isValidChannel(undefined)).toBe(false);
    });
});
