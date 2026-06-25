import { describe, it, expect } from 'vitest';
import {
    computeVersionCode,
    isValidChannel,
    CHANNELS,
    CHANNEL_NAMES,
    BAND_WIDTH,
} from '../../../tools/release-channels.mjs';

const PLAY_CEILING = 2_100_000_000; // Google Play's hard versionCode max
// Field caps: major 0..9, minor 0..999, patch 0..999. Max version 9.999.999.
const MAX_BASE = 9 * 1_000_000 + 999 * 1_000 + 999; // 9.999.999 → 9_999_999

/**
 * Channel-banded Android versionCode. The rule everything hangs on: Play serves
 * a user who qualifies for multiple tracks the build with the HIGHEST
 * versionCode. So production must be the LOWEST band, and each more-internal
 * test track must sit ABOVE the less-internal ones — otherwise, once a prod
 * release ships, a test build with a lower code becomes invisible to testers.
 */
describe('computeVersionCode', () => {
    it('production is the plain semver base (lowest band)', () => {
        // base = major*1e6 + minor*1e3 + patch
        expect(computeVersionCode('0.28.7', 'prod')).toBe(28_007);
        expect(computeVersionCode('1.2.3', 'prod')).toBe(1_002_003);
    });

    it('defaults to prod when no channel is given', () => {
        expect(computeVersionCode('0.28.7')).toBe(28_007);
    });

    it('each channel adds its band * BAND_WIDTH on top of the base', () => {
        expect(computeVersionCode('0.28.7', 'open')).toBe(100_028_007);   // band 10
        expect(computeVersionCode('0.28.7', 'closed')).toBe(200_028_007); // band 20
        expect(computeVersionCode('0.28.7', 'beta')).toBe(300_028_007);   // band 30, internal track
    });

    it('orders production < open < closed < internal at the same version', () => {
        const v = '0.28.7';
        const codes = ['prod', 'open', 'closed', 'beta'].map((c) => computeVersionCode(v, c));
        expect(codes).toEqual([...codes].sort((a, b) => a - b));
        expect(new Set(codes).size).toBe(codes.length); // all distinct
    });

    it('every test channel outranks EVERY production code, forever', () => {
        // The smallest test-channel code (lowest test band at 0.0.0) must still
        // beat the largest possible prod code (9.999.999) so a tester is never
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

    it('stays under Play\'s 2.1e9 ceiling for every defined channel — and band 209', () => {
        for (const c of CHANNEL_NAMES) {
            expect(computeVersionCode('9.999.999', c)).toBeLessThan(PLAY_CEILING);
        }
        // 1e7 spacing leaves room up to band 209 (the documented max).
        expect(209 * BAND_WIDTH + MAX_BASE).toBeLessThan(PLAY_CEILING);
        expect(210 * BAND_WIDTH).not.toBeLessThan(PLAY_CEILING); // band 210 hits the ceiling
    });

    it('throws on an unknown channel', () => {
        expect(() => computeVersionCode('0.28.7', 'nope')).toThrow(/unknown release channel/);
    });

    it('throws on a non-semver version', () => {
        expect(() => computeVersionCode('beta', 'prod')).toThrow(/semver/);
    });

    it('throws when a field overflows its cap (major 0..9, minor/patch 0..999)', () => {
        // A carry would break version ordering or bleed into the next band.
        expect(() => computeVersionCode('10.0.0', 'prod')).toThrow(/overflows/);
        expect(() => computeVersionCode('0.1000.0', 'prod')).toThrow(/overflows/);
        expect(() => computeVersionCode('0.0.1000', 'prod')).toThrow(/overflows/);
        // The boundary values are still valid.
        expect(computeVersionCode('9.999.999', 'prod')).toBe(MAX_BASE);
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

    it('leaves gaps between channel bands so a track can be inserted later', () => {
        const sorted = CHANNEL_NAMES.map((c) => CHANNELS[c].band).sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i++) {
            // > 1 means at least one free integer slot between neighbours.
            expect(sorted[i] - sorted[i - 1]).toBeGreaterThan(1);
        }
    });

    it('isValidChannel accepts known channels and rejects others', () => {
        expect(isValidChannel('prod')).toBe(true);
        expect(isValidChannel('beta')).toBe(true);
        expect(isValidChannel('open')).toBe(true);
        expect(isValidChannel('nope')).toBe(false);
        expect(isValidChannel(undefined)).toBe(false);
    });
});
