import { describe, it, expect } from 'vitest';
import { positions } from './helpers.js';

/**
 * Unit coverage for the pure positions() query builder shared by the e2e
 * specs. (startGame / openOnline drive a live Playwright page, so they're
 * exercised by the e2e suite, not here.)
 *
 * Indexing follows CLAUDE.md "Test Overrides": slot = playerIndex*4 + tokenIndex,
 * 16 slots, empty field = home (-1).
 */
describe('positions()', () => {
    it('emits 16 comma-separated slots (15 commas) with a leading ?positions=', () => {
        const q = positions([]);
        expect(q.startsWith('?positions=')).toBe(true);
        const body = q.slice('?positions='.length);
        expect(body.split(',')).toHaveLength(16);
        // All-empty list → every slot blank (home).
        expect(body).toBe(',,,,,,,,,,,,,,,');
    });

    it('places a sparse array value at its slot index, blanks the rest', () => {
        // P0's first token one step from finishing, all others home.
        expect(positions([50])).toBe('?positions=50,,,,,,,,,,,,,,,');
    });

    it('accepts an index→value object using playerIndex*4+tokenIndex slots', () => {
        // P0 token0 at 20, P1 token0 at 7 (4*1+0 = slot 4) — the capture scenario.
        expect(positions({ 0: 20, 4: 7 })).toBe('?positions=20,,,,7,,,,,,,,,,,');
    });

    it('fills the four bottom-row token slots for one player', () => {
        expect(positions({ 0: 39, 1: 39, 2: 39, 3: 39 }))
            .toBe('?positions=39,39,39,39,,,,,,,,,,,,');
    });

    it('stringifies numeric values (including 0 and -1)', () => {
        expect(positions({ 0: 0, 15: -1 })).toBe('?positions=0,,,,,,,,,,,,,,,-1');
    });

    it('treats undefined / null / empty entries as home (blank)', () => {
        expect(positions({ 0: undefined, 1: null, 2: '', 3: 5 }))
            .toBe('?positions=,,,5,,,,,,,,,,,,');
    });

    it('throws on an out-of-range slot index', () => {
        expect(() => positions({ 16: 3 })).toThrow(/out of range/);
        expect(() => positions({ '-1': 3 })).toThrow(/out of range/);
    });
});
